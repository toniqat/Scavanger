/**
 * src/stratagems/parts/Wire.ts — **`strat` / `stratq` 네트워크 경로**.
 *
 * 늦게 합류한 클라이언트는 진행 중인 호출 목록을 받아 재구성한다(`applySync`). 이미 떨어졌어야 할
 * 호출은 조용히 **빨리감기**해서(`fastForward`) 장애물과 보급 상자가 바로 존재하게 한다.
 * 쿨다운은 공유하지 않는다 — 개인 값이다.
 */
import * as THREE from 'three';
import {
  Keys, MouseButtons, Random,
  STRATAGEM_DEFS, STRATAGEM_ORDER, STRATAGEM_WHEEL_HOLD, STRATAGEM_CHARGE_TIME,
  TOPVIEW_HEIGHT, TOPVIEW_RANGE, TOPVIEW_CURSOR_SPEED, GROUND_TARGET_RANGE,
  LASER_DURATION, LASER_RADIUS, LASER_DPS, AIRSTRIKE_RADIUS, AIRSTRIKE_DAMAGE,
  SUPPLY_FALL_TIME, SUPPLY_IMPACT_RADIUS, SUPPLY_IMPACT_DAMAGE, SUPPLY_CRATE_TIER,
  STRUCTURE_COUNT, STRUCTURE_HP, STRUCTURE_SCATTER, STRUCTURE_IMPACT_RADIUS, STRUCTURE_IMPACT_DAMAGE, STRUCTURE_FALL_TIME,
  type GameContext, type GameSystem, type StratagemsRef, type StratagemId, type StratagemCall, type StratagemStage, type StratagemDef,
  type PlayerRef, type PlayerWeaponHost, type Interactable, type Obstacle, type DestructibleRef, type WorldRef, type Vec3Tuple, type PeerId,
  type StratagemCallWire,
} from '@/shared';
import {
  SharedGeo, TargetRing, CallMarker, Burst, dustBurst, sparkBurst, LaserBeam, Fireball, SupplyCrateMesh, BarricadeMesh, makeRubble, KIND_COLOR,
} from '../Visuals';
import { AIRSTRIKE_FX_TIME, Call, GRENADE_STRUCTURE_DAMAGE, type Host, LASER_TICK, SHAKE_RANGE, STRUCTURE_DROP_HEIGHT, STRUCTURE_MIN_GAP, STRUCTURE_STAGGER, SUPPLY_DROP_HEIGHT, Structure, TARGET_EMIT_EPS, WHEEL_DRAG_PX, _a, _b, _dir, defOf, toTuple } from '../model';
import * as Rescue from './Rescue';
import type { StratagemSystem } from '../StratagemSystem';

/* ─────────────────────────── net ─────────────────────────── */
export function ensureNetHooks(sys: StratagemSystem): void {
  if (sys.netHooked) return;
  const net = sys.ctx.net;
  if (!net) return;
  sys.netHooked = true;
  sys.unsubs.push(
    net.onMessage('strat', (msg, from) => {
      if (msg.ev === 'call') {
        if (sys.byId.has(msg.callId)) return;
        const p = new THREE.Vector3(msg.p[0], msg.p[1], msg.p[2]);
        const w = sys.world();
        if (w) p.y = w.getHeightAt(p.x, p.z);
        sys.createCall(msg.kind, p, msg.eta, msg.seed, false, msg.callId, from);
      } else if (msg.ev === 'structHp') {
        const s = sys.byId.get(msg.callId)?.structures[msg.index];
        if (s && !s.destroyed && msg.hp < s.hp) sys.setStructureHp(s, msg.hp);
      } else if (msg.ev === 'sync') {
        sys.applySync(msg.calls);
      }
    }),
    // Phase 9: the host is the late-join sync authority (calls stay client-simulated)
    net.onMessage('stratq', (msg, from) => {
      if (msg.ev === 'sync' && net.isHost) sys.sendSync(from);
    }),
    net.onMessage('flow', (msg, from) => {
      if (msg.ev === 'rejoined' && net.isHost) sys.sendSync(from);
    }),
    /* 2026-09-09: 구조선 — 요청 · 승인 · 거절 · 잔여 횟수 (권한은 전부 호스트) */
    net.onMessage('rescue', (msg, from) => Rescue.onRescueMessage(sys, msg, from)),
  );
  }

/** Every live call as `StratagemCallWire` (`eta` relative to now, `st` = damaged structures only). */
export function syncWire(sys: StratagemSystem): StratagemCallWire[] {
  const now = sys.ctx.time;
  const out: StratagemCallWire[] = [];
  for (const c of sys.calls) {
    // 2026-09-09: 구조선은 4초짜리 일회성 호출이고, 늦게 받은 쪽이 다시 `rescue:landed` 를 내면 안 되므로 싣지 않는다.
    if (c.kind === 'rescue_drop') continue;
    if (c.kind === 'orbital_laser' || c.kind === 'airstrike') { if (c.stage === 'done') continue; }
    else if (c.kind === 'structure_drop' && c.structures.length > 0 && c.structures.every((s) => s.destroyed)) continue;
    const w: StratagemCallWire = { callId: c.id, kind: c.kind, p: toTuple(c.position), seed: c.seed, eta: Math.round((c.landsAt - now) * 100) / 100, caller: c.caller };
    if (c.looted) w.looted = true;
    if (c.structures.length) {
      const st: [number, number][] = [];
      for (const s of c.structures) if (s.destroyed || s.hp < STRUCTURE_HP) st.push([s.index, s.destroyed ? 0 : Math.max(0, Math.round(s.hp))]);
      if (st.length) w.st = st;
    }
    out.push(w);
  }
  return out;
  }

export function sendSync(sys: StratagemSystem, to: PeerId): void {
  const net = sys.ctx.net;
  if (!net || !sys.ctx.isMultiplayer) return;
  net.send({ t: 'strat', ev: 'sync', calls: sys.syncWire() }, to);
  // 2026-09-09: 분대 공용 구조선 잔여 횟수도 late-join 경로에 태운다 (`StratagemCallWire` 에는 자리가 없다).
  net.send({ t: 'rescue', ev: 'count', left: sys._rescueLeft }, to);
  }

/**
 * Late-join reception: unknown calls are created as remote (`local = false`); a call that already landed (`eta ≤ 0`)
 * is back-dated and fast-forwarded in this frame — silently (no impact damage / FX) — so its obstacles and supply
 * interactable exist at once; the synced structure hp is applied **inside the same silent window**, so a block that
 * was already rubble when we joined leaves rubble without its demolition shake / dust / bang. The state events
 * (`stratagem:landed`, `structure:damaged / destroyed`) are still emitted — only the felt FX are suppressed.
 * The cooldown is personal and not synced.
 */
export function applySync(sys: StratagemSystem, calls: StratagemCallWire[]): void {
  const w = sys.world();
  for (const wire of calls) {
    if (!wire || typeof wire.callId !== 'string' || sys.byId.has(wire.callId)) continue;
    if (!STRATAGEM_DEFS.some((d) => d.id === wire.kind)) continue;
    const p = new THREE.Vector3(wire.p[0], wire.p[1], wire.p[2]);
    if (w) p.y = w.getHeightAt(p.x, p.z);
    const eta = Number.isFinite(wire.eta) ? wire.eta : 0;
    const past = eta <= 0;
    const wasSilent = sys.silent;
    if (past) sys.silent = true;
    try {
      const call = sys.createCall(wire.kind, p, eta, wire.seed >>> 0, false, wire.callId, wire.caller ?? null);
      if (past) sys.fastForward(call);
      if (wire.st) {
        for (const [index, hp] of wire.st) {
          const s = call.structures[index];
          if (s && !s.destroyed && hp < s.hp) sys.setStructureHp(s, hp);
        }
      }
      if (wire.looted && call.kind === 'supply_drop' && !call.looted) {
        call.looted = true;
        call.crate?.setLooted();
        sys.ended(call);
      }
    } finally {
      sys.silent = wasSilent;
    }
  }
  }

/** Run one silent update step at `ctx.time` so a back-dated call reaches its landed state immediately. */
export function fastForward(sys: StratagemSystem, c: Call): void {
  const t = sys.ctx.time;
  c.audioStarted = true;
  const wasSilent = sys.silent;
  sys.silent = true;
  try {
    switch (c.kind) {
      case 'orbital_laser': sys.updateLaser(c, t, 0); break;
      case 'airstrike': sys.updateAirstrike(c, t); break;
      case 'supply_drop': sys.updateSupply(c, t); break;
      case 'structure_drop': sys.updateStructures(c, t); break;
    }
  } finally {
    sys.silent = wasSilent;
  }
  }
