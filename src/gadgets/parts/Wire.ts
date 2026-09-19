/**
 * src/gadgets/parts/Wire.ts — **the `gad` / `gadq` / `buff` network paths**.
 *
 * The host is the truth for the deployable list; a late joiner and a host transfer both get the whole set again.
 */
import * as THREE from 'three';
import {
  GADGET_DEFUSE_TIME, GADGET_INCENDIARY_DPS, GADGET_JUMPPAD_FORWARD, GADGET_JUMPPAD_IMPULSE,
  GADGET_CLOAK_SHARE_RADIUS, GADGET_LURE_RADIUS, GADGET_MINE_ARM_TIME, GADGET_MINE_DAMAGE, GADGET_TURRET_DPS, JUMP_PAD_RETRIGGER_S, Keys, PLAYER_RADIUS,
  buffSenderOf,
  type BuffMessage, type DeployableKind, type DeployableRef, type EnemyRef, type FlowMessage, type GadgetDef,
  type GadgetId, type GadgetMessage, type GadgetRequest, type GameContext, type GameSystem, type GadgetsRef,
  type Interactable, type ItemInstance, type DeployableWire, type PeerId, type PlayerWeaponHost, type Vec3Tuple,
} from '@/shared';
import { GADGET_DEFS, gadgetDef, gadgetForKind, isRecoverable } from '../GadgetDefs';
import { defForWire, deployableIdFor } from '../GadgetDefs';
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
  // 2026-09-11 (parts/Mount): the drone id when it rides one — omitted = on the ground
  if (d.mount) w.mount = d.mount;
  // 2026-09-15 (the thumper): seconds since it was placed — replicas match the hammer's beat from it
  // (no message per strike)
  if (d.kind === 'thumper') w.age = Math.round(d.age * 100) / 100;
  return w;
  }

export function spawnFromWire(sys: GadgetSystem, w: DeployableWire): void {
  // 2026-09-15: a deployable's definition is decided by `kind` alone (the fire merge — `GadgetDefs.defForWire`)
  const def = defForWire(w);
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
      // 2026-09-11 (parts/Mount): a spawn for an id that already exists = the host re-broadcasting a
      // deployable that fell off a drone → only the state is overwritten
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
      // 2026-09-11 (parts/Preview): a `place` gadget is re-checked lightly against the surface / the drone
      // (the item was already consumed on the client)
      let mount: string | null = null;
      if (def.use === 'place') {
        const r = Preview.resolveRemotePlace(sys, def, _a, m.mount ?? null);
        if (r === false) return;
        mount = r;
      }
      // 2026-09-15: the fire zone (`incendiary`) is an internal definition with no item, so it is accepted
      // here too (a client's `화염 수류탄` exploding).
      // 2026-09-15 2nd pass: a `wearsItemDurability` gadget stands with the request's `hp` (the durability
      // left) — `spawnDeployable` clamps it to the item's `durabilityMax`, so an inflated value never makes
      // it tougher than new. Omitted = new.
      sys.spawnDeployable(deployableIdFor(from, ++sys.seq, def.id), def, from, _a, m.yaw, null, mount, m.hp);
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
    // 2026-09-11: only the sender's own armed remote mines go off (parts/Remote)
    case 'detonate':
      Remote.onDetonateRequest(sys, from);
      break;
  }
  }

/**
 * `buff` receiver. Gadgets own 'revive' (the defib) and 'cloak' (the cloak veil); 'heal' / 'boost' belong to
 * implants/, so they are ignored here to avoid applying the same buff twice.
 */
export function onBuff(sys: GadgetSystem, m: BuffMessage, from: PeerId): void {
  if (!m || (m.kind !== 'cloak' && m.kind !== 'revive')) return;
  /* 2026-09-11 (E-4): the sender must be a connected member of the same lobby, its snapshot position must be
   * inside range, and a cloak's duration must not exceed the definition's (`shared/buffRules`). "Is the
   * target really downed" is still answered by the original check below — this guard runs before it. */
  const guard = (me: { position: THREE.Vector3 }): number | null => {
    const v = sys.buffGuard.check(m, buffSenderOf(sys.ctx.net, from, me.position), performance.now() / 1000);
    sys.lastBuffVerdict = v;
    return v.ok ? v.duration : null;
  };
  if (m.kind === 'cloak') {
    const self = sys.ctx.player;
    if (!self || self.isDead || typeof self.setCloak !== 'function') return;
    const duration = guard(self);
    if (duration === null) return;
    self.setCloak(duration, 'gadget');
    const def = gadgetDef('cloakVeil');
    sys.visuals.pulse(self.position, def?.color ?? '#9fd8ff', 0.6, def?.radius ?? 6, 0.8);
    sys.ctx.bus.emit('audio:play', { id: 'gadget_cloak', position: self.position, volume: 0.8 });
    sys.ctx.bus.emit('ui:notify', { text: `${m.by} 의 은폐 장막`, kind: 'success', duration: 1.8 });
    return;
  }
  const p = sys.ctx.player;
  if (!p || !p.isDowned || typeof p.revive !== 'function') return;
  if (guard(p) === null) return;
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
