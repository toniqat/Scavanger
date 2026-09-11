/**
 * src/gadgets/parts/Wire.ts — **`gad` / `gadq` / `buff` 네트워크 경로**.
 *
 * 호스트가 배치물 목록의 진실이고, 늦게 합류한 클라이언트와 호스트 이관 뒤에는 전체를 다시 보낸다.
 */
import * as THREE from 'three';
import {
  GADGET_DEFUSE_TIME, GADGET_INCENDIARY_DPS, GADGET_JUMPPAD_FORWARD, GADGET_JUMPPAD_IMPULSE,
  GADGET_CLOAK_SHARE_RADIUS, GADGET_LURE_RADIUS, GADGET_MINE_ARM_TIME, GADGET_MINE_DAMAGE, GADGET_TURRET_DPS, JUMP_PAD_RETRIGGER_S, Keys, PLAYER_RADIUS,
  type BuffMessage, type DeployableKind, type DeployableRef, type EnemyRef, type FlowMessage, type GadgetDef,
  type GadgetId, type GadgetMessage, type GadgetRequest, type GameContext, type GameSystem, type GadgetsRef,
  type Interactable, type ItemInstance, type DeployableWire, type PeerId, type PlayerWeaponHost, type Vec3Tuple,
} from '@/shared';
import { GADGET_DEFS, gadgetDef, gadgetForKind, isRecoverable } from '../GadgetDefs';
import { Deployable, BARRICADE_HALF, DOME_UNFOLD_TIME, JUMPPAD_TRIGGER_RADIUS, MINE_TRIGGER_RADIUS } from '../Deployable';
import { GadgetVisualPool } from '../GadgetVisuals';
import { ThrownGadgetManager } from '../ThrownGadget';
import { EMPTY_ENEMIES, MAX_DEPLOYABLES, PLACE_CLEARANCE, PLACE_DISTANCE, PLAYER_HALF_H, RECOVER_RADIUS, TURRET_AIM_CONE, TURRET_RETARGET, TURRET_ROF, TURRET_TURN_RATE, USE_COOLDOWN, type Victim, ZONE_TICK, _a, _b, _c, _d, _e, _fwd, _g0, _g1, _g2, _r0, _r1, _r2, _r3, _r4, angleDelta, toTuple } from '../model';
import type { GadgetSystem } from '../GadgetSystem';
import * as Remote from './Remote';
import * as Preview from './Preview';
import * as Mount from './Mount';

/* ═══════════════════════════ networking ═══════════════════════════ */
export function ensureNetHooks(sys: GadgetSystem): void {
  const net = sys.ctx.net;
  if (!net || sys.netHooked) return;
  sys.netHooked = true;
  sys.unsubs.push(
    net.onMessage('gad', (m, from) => sys.onGadgetMessage(m, from)),
    net.onMessage('gadq', (m, from) => sys.onGadgetRequest(m, from)),
    net.onMessage('buff', (m, from) => sys.onBuff(m, from)),
    net.onMessage('flow', (m, from) => sys.onFlow(m, from)),
  );
  }

export function broadcast(sys: GadgetSystem, msg: GadgetMessage, to: 'all' | 'others' | PeerId): void {
  const ctx = sys.ctx;
  if (!ctx.isMultiplayer || !ctx.net) return;
  ctx.net.send(msg, to);
  }

export function wireOf(sys: GadgetSystem, d: Deployable): DeployableWire {
  const w: DeployableWire = {
    id: d.id,
    kind: d.kind,
    owner: String(d.owner),
    p: toTuple(d.position),
    yaw: Math.round(d.yaw * 1000) / 1000,
    hp: Math.round(d.hp),
    maxHp: d.maxHp,
    armed: d.armed,
    ttl: d.expires > 0 ? Math.max(0, Math.round((d.expires - sys.ctx.time) * 100) / 100) : 0,
  };
  // 2026-09-11 (parts/Mount): 드론 위면 그 드론 id — 생략 = 바닥
  if (d.mount) w.mount = d.mount;
  return w;
  }

export function spawnFromWire(sys: GadgetSystem, w: DeployableWire): void {
  const def = gadgetForKind(w.kind);
  if (!def) return;
  _a.set(w.p[0], w.p[1], w.p[2]);
  sys.spawnDeployable(w.id, def, w.owner, _a, w.yaw, w);
  }

/** Host → clients. */
export function onGadgetMessage(sys: GadgetSystem, m: GadgetMessage, from: PeerId): void {
  const ctx = sys.ctx;
  const net = ctx.net;
  if (!net || !ctx.isMultiplayer || ctx.isAuthority) return;
  const hostId = net.lobby?.hostId;
  if (hostId && from !== hostId) return;
  switch (m.ev) {
    case 'spawn': {
      // 2026-09-11 (parts/Mount): 이미 있는 id 의 spawn = 호스트가 드론에서 떨어진 탑재물을 재방송한 것 → 상태만 덮어쓴다
      const existing = sys.byId.get(m.d.id);
      if (existing && !existing.removing) Mount.applyWire(sys, existing, m.d);
      else sys.spawnFromWire(m.d);
      break;
    }
    case 'update': {
      const d = sys.byId.get(m.id);
      if (!d) return;
      if (d.hp !== m.hp) ctx.bus.emit('gadget:damaged', { id: d.id, hp: m.hp, maxHp: d.maxHp });
      d.hp = m.hp;
      d.armed = m.armed;
      break;
    }
    case 'remove': {
      const d = sys.byId.get(m.id);
      if (!d) { sys.pendingRecover.delete(m.id); return; }
      if (m.reason === 'destroyed') {
        // 2026-09-11: a remote mine that was shot to pieces arrives with hp 0 (the host sends `update hp 0` first) and
        // fizzles; one with hp left was detonated and gets the full blast
        if (d.kind === 'mine' || (d.kind === 'remoteMine' && d.hp > 0)) sys.blastFx(d.position, d.radius);
        else sys.blastFx(d.position, Math.min(d.radius, 3), 0.4);
      }
      // our own recover request came through → take the item now
      if (m.reason === 'recovered' && sys.pendingRecover.has(m.id)) sys.grantRecovered(d);
      sys.removeLocal(d, m.reason);
      break;
    }
    case 'fire': {
      const d = sys.byId.get(m.id);
      if (!d) return;
      _a.set(m.target[0], m.target[1], m.target[2]);
      _b.copy(d.position); _b.y += 0.75;
      _c.subVectors(_a, _b);
      d.headYaw = Math.atan2(-_c.x, -_c.z);
      sys.visuals.flash(d.visual);
      ctx.bus.emit('audio:play', { id: 'turret_fire', position: d.position, volume: 0.5 });
      break;
    }
    case 'sync':
      sys.clear();
      for (const w of m.items) sys.spawnFromWire(w);
      break;
  }
  }

/** Clients → host. */
export function onGadgetRequest(sys: GadgetSystem, m: GadgetRequest, from: PeerId): void {
  const ctx = sys.ctx;
  if (!ctx.isMultiplayer || !ctx.isAuthority) return;
  switch (m.ev) {
    case 'place': {
      const def = gadgetDef(m.gadget);
      if (!def || !def.deployable) return;
      _a.set(m.p[0], m.p[1], m.p[2]);
      // 2026-09-11 (parts/Preview): 설치형은 표면 / 드론 기준으로 가볍게 다시 본다 (아이템은 이미 클라에서 소모됐다)
      let mount: string | null = null;
      if (def.use === 'place') {
        const r = Preview.resolveRemotePlace(sys, def, _a, m.mount ?? null);
        if (r === false) return;
        mount = r;
      }
      sys.spawnDeployable(`${from}-g${++sys.seq}`, def, from, _a, m.yaw, null, mount);
      break;
    }
    case 'damage': {
      const d = sys.byId.get(m.id);
      if (!d) return;
      sys.onDeployableDamage(d, Math.max(0, Math.min(m.dmg, d.maxHp)), undefined);
      break;
    }
    case 'recover': {
      const d = sys.byId.get(m.id);
      if (!d) return;
      const def = gadgetForKind(d.kind);
      if (!def || def.recoverTime <= 0) return;
      sys.remove(d, 'recovered');   // the requester grants itself the item on the echo
      break;
    }
    case 'sync':
      sys.broadcast({ t: 'gad', ev: 'sync', items: sys.deployables.map((d) => sys.wireOf(d)) }, from);
      break;
    // 2026-09-11: 보낸 사람 소유의 무장된 원격 지뢰만 터진다 (parts/Remote)
    case 'detonate':
      Remote.onDetonateRequest(sys, from);
      break;
  }
  }

/**
 * `buff` receiver. Gadgets own 'revive' (제세동기) and 'cloak' (은폐 장막); 'heal' / 'boost' belong to
 * implants/, so they are ignored here to avoid applying the same buff twice.
 */
export function onBuff(sys: GadgetSystem, m: BuffMessage, from: PeerId): void {
  if (m.kind === 'cloak') {
    const self = sys.ctx.player;
    if (!self || self.isDead || typeof self.setCloak !== 'function') return;
    self.setCloak(m.duration, 'gadget');
    const def = gadgetDef('cloakVeil');
    sys.visuals.pulse(self.position, def?.color ?? '#9fd8ff', 0.6, def?.radius ?? 6, 0.8);
    sys.ctx.bus.emit('audio:play', { id: 'gadget_cloak', position: self.position, volume: 0.8 });
    sys.ctx.bus.emit('ui:notify', { text: `${m.by} 의 은폐 장막`, kind: 'success', duration: 1.8 });
    void from;
    return;
  }
  if (m.kind !== 'revive') return;
  const p = sys.ctx.player;
  if (!p || !p.isDowned || typeof p.revive !== 'function') return;
  p.revive();
  p.applyStim(p.maxHp);   // defibrillator: back to full hp (Phase 2 revive leaves PLAYER_REVIVE_HP)
  sys.visuals.pulse(p.position, gadgetDef('defib')?.color ?? '#ff5f8f', 0.4, 3.2, 0.6);
  sys.ctx.bus.emit('audio:play', { id: 'gadget_defib', position: p.position, volume: 0.9 });
  sys.ctx.bus.emit('ui:notify', { text: `${m.by} 이(가) 일으켜 세웠다`, kind: 'success', duration: 2.5 });
  void from;
  }

export function onFlow(sys: GadgetSystem, m: FlowMessage, from: PeerId): void {
  if (m.ev === 'rejoined' && sys.ctx.isAuthority && sys.ctx.isMultiplayer) {
    sys.broadcast({ t: 'gad', ev: 'sync', items: sys.deployables.map((d) => sys.wireOf(d)) }, from);
  }
  }
