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
  STRAT_COOLDOWN_SLACK_S, STRAT_MAX_CALL_RANGE, STRATAGEM_HOST_ONLY, type NetRef, type StratagemRequest,
  type StratagemDenyReason,
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
        /*
         * 2026-09-11 (E-4): a ship call is only real when **the host** says so — a non-host's `strat call` is dropped
         * (theirs goes through `stratq call` first). `by` names the caller; our own echoed call is the effect owner.
         * Kind whitelist here too (never a 구조선 — that one only exists through `rescue grant`).
         */
        if (!fromHost(net, from)) return;
        if (typeof msg.callId !== 'string' || sys.byId.has(msg.callId) || !isCallKind(msg.kind) || !isTuple(msg.p)) return;
        const p = new THREE.Vector3(msg.p[0], msg.p[1], msg.p[2]);
        const w = sys.world();
        if (w) p.y = w.getHeightAt(p.x, p.z);
        const by = typeof msg.by === 'string' && msg.by ? msg.by : from;
        const eta = THREE.MathUtils.clamp(Number(msg.eta) || 0, 0, defOf(msg.kind).delay);
        sys.createCall(msg.kind, p, eta, (Number(msg.seed) >>> 0), by === net.localId, msg.callId, by);
      } else if (msg.ev === 'structHp') {
        const s = sys.byId.get(msg.callId)?.structures[msg.index];
        if (s && !s.destroyed && msg.hp < s.hp) sys.setStructureHp(s, msg.hp);
      } else if (msg.ev === 'sync') {
        if (!fromHost(net, from)) return;
        if (Array.isArray(msg.calls)) sys.applySync(msg.calls);
      } else if (msg.ev === 'deny') {
        // 2026-09-11 (E-8 c): 호스트가 내 호출을 거절했다 — 낙관적으로 돌던 공유 쿨타임을 되돌린다
        onCallDenied(sys, msg.callId, msg.reason, from);
      }
    }),
    // Phase 9: the host is the late-join sync authority (calls stay client-simulated)
    net.onMessage('stratq', (msg, from) => {
      if (msg.ev === 'sync' && net.isHost) sys.sendSync(from);
      // 2026-09-11 (E-4): a squad-mate confirmed a ship call — validate and re-broadcast
      else if (msg.ev === 'call') onCallRequest(sys, msg, from);
    }),
    net.onMessage('flow', (msg, from) => {
      if (msg.ev === 'rejoined' && net.isHost) sys.sendSync(from);
    }),
    /* 2026-09-09: 구조선 — 요청 · 승인 · 거절 · 잔여 횟수 (권한은 전부 호스트) */
    net.onMessage('rescue', (msg, from) => Rescue.onRescueMessage(sys, msg, from)),
  );
  }

/* ─────────────────────────── E-4: 호스트 경유 호출 (2026-09-11) ─────────────────────────── */

/**
 * The message came from the lobby host. Without a lobby (single-player harness, smoke-stratagems' synthetic `HOST`)
 * there is nobody to compare with and it passes — in a real session the lobby always exists.
 */
export function fromHost(net: NetRef, from: PeerId): boolean {
  const hostId = net.lobby?.hostId;
  return !hostId || from === hostId;
}

/** A kind a `strat call` may carry: a known def, never the 구조선 (that one only exists through `rescue grant`). */
export function isCallKind(kind: unknown): kind is StratagemId {
  return typeof kind === 'string' && kind !== 'rescue_drop' && STRATAGEM_DEFS.some((d) => d.id === kind);
}

function isTuple(p: unknown): p is Vec3Tuple {
  return Array.isArray(p) && p.length === 3 && p.every((v) => typeof v === 'number' && Number.isFinite(v));
}

/** Wall clock (s) the host measures caller cooldowns with — `ctx.time` stalls during a shader hold, a caller's does not run faster. */
export function wallSeconds(): number { return performance.now() / 1000; }

/**
 * Host-side shared checks of a squad-mate's ship call (`stratq call` and `rescue req`): an in-raid, connected lobby
 * member other than me, alive by its snapshot, aiming inside the map within `STRAT_MAX_CALL_RANGE` of that snapshot,
 * whose shared cooldown (`callerReadyAt`, minus `STRAT_COOLDOWN_SLACK_S`) has run out. Returns the refusal reason or null.
 */
export function callRefusal(sys: StratagemSystem, from: PeerId, p: unknown): StratagemDenyReason | null {
  const ctx = sys.ctx;
  const net = ctx.net;
  if (!net || !net.isHost || !ctx.isMultiplayer) return 'not_host';
  if (from === net.localId) return 'self';
  if (!ctx.isGameplayPhase()) return 'phase';
  const member = net.lobby?.players.find((m) => m.id === from);
  if (!member || member.connected === false) return 'member';
  if (!isTuple(p)) return 'point';
  const w = sys.world();
  if (!w || !w.isInsideBounds(p[0], p[2])) return 'bounds';
  const ref = net.getRemotePlayer(from);
  if (!ref || ref.isDead) return 'caller';
  if (Math.hypot(p[0] - ref.position.x, p[2] - ref.position.z) > STRAT_MAX_CALL_RANGE) return 'range';
  const readyAt = sys.callerReadyAt.get(from) ?? 0;
  if (wallSeconds() < readyAt - STRAT_COOLDOWN_SLACK_S) return 'cooldown';
  return null;
}

/**
 * `stratq call` on the host. Kind must be on the wheel (`STRATAGEM_ORDER`, not the 구조선), not host-only, the callId
 * must be the caller's own (`<from>-…`) and unused. The host rewrites `eta` from the csv `delay`, starts the caller's
 * cooldown, creates the call as remote (`local = false` — enemy damage stays on the caller's client) and broadcasts
 * `strat call {…, by}` to everyone else, the caller included. A refusal is silent.
 */
export function onCallRequest(sys: StratagemSystem, msg: Extract<StratagemRequest, { ev: 'call' }>, from: PeerId): void {
  const net = sys.ctx.net;
  if (!net || !net.isHost) return;
  /*
   * 2026-09-11 (E-8 c): 거절은 더 이상 조용하지 않다 — 호출자는 요청을 보내기 **전에** 공유 쿨타임을 이미 돌렸으므로
   * (`Targeting.confirm`) 되돌리라는 말을 들어야 한다. `sendDeny` 가 `strat deny` 를 그 사람에게만 보낸다.
   */
  const refuse = (why: StratagemDenyReason, callId?: string): void => {
    sys.lastCallRefusal = why;
    sys.lastDenySent = null;
    if (callId !== undefined) sendCallDeny(sys, from, callId, why);
  };
  /*
   * `callId` 의 모양 · 소유 검사만은 **답장하지 않는다** (판단 근거): `deny` 는 `callId` 로 주소를 삼고 받는 쪽은
   * 자기 id 로 시작하는 것만 받아들이므로(`onCallDenied`), `from` 의 것이 아닌 id 를 돌려줘도 어차피 아무도
   * 받아들일 수 없다 — 위조한 쪽에 그 문자열을 그대로 되울려 주는 것 말고는 얻는 것이 없다. 같은 이유로
   * 문자열이 아니거나 64자를 넘는 id 도 답장 대상이 아니다. **중복 id 는 다르다** — 그 id 는 확실히 `from` 의
   * 것이고 재전송 · id 충돌은 정상 클라이언트에서도 날 수 있으므로 답장한다.
   */
  if (typeof msg.callId !== 'string' || msg.callId.length > 64 || !msg.callId.startsWith(`${from}-`)) { refuse('callId'); return; }
  if (sys.byId.has(msg.callId)) { refuse('callId', msg.callId); return; }
  const kind = msg.kind;
  if (!isCallKind(kind) || !STRATAGEM_ORDER.includes(kind)) { refuse('kind', msg.callId); return; }
  if (STRATAGEM_HOST_ONLY.includes(kind)) { refuse('host_only', msg.callId); return; }
  const why = callRefusal(sys, from, msg.p);
  if (why) { refuse(why, msg.callId); return; }
  const def = defOf(kind);
  sys.callerReadyAt.set(from, wallSeconds() + def.cooldown);
  const w = sys.world()!;
  const pos = new THREE.Vector3(msg.p[0], 0, msg.p[2]);
  pos.y = w.getHeightAt(pos.x, pos.z);
  const seed = Number(msg.seed) >>> 0;
  sys.lastCallRefusal = null;
  sys.lastDenySent = null;
  sys.createCall(kind, pos, def.delay, seed, false, msg.callId, from);
  net.send({ t: 'strat', ev: 'call', callId: msg.callId, kind, p: toTuple(pos), eta: def.delay, seed, by: from }, 'others');
}

/* ─────────────────────────── E-8 (c): 거절 통보 · 쿨타임 환불 (2026-09-11) ─────────────────────────── */

/**
 * 사유별 한국어 문구. **계약이 아니다** — `Rescue.DENY_KO` 와 같이 이 폴더가 갖는다(`shared` 에는 코드만 있다).
 * 플레이어가 손쓸 수 있는 사유만 구체적으로 적고, 나머지(위조 · 프로토콜 문제 — `callId` · `kind` · `not_host` ·
 * `self` · `point`)는 공통 문구로 접는다. 정상 클라이언트에서는 그 다섯이 나올 일이 없다.
 */
const CALL_DENY_KO: Readonly<Partial<Record<StratagemDenyReason, string>>> = {
  host_only: '분대장만 쓸 수 있습니다',
  cooldown: '함선 호출 재충전 중입니다',
  range: '호출 지점이 너무 멉니다',
  bounds: '지도 밖에는 호출할 수 없습니다',
  phase: '지금은 함선을 호출할 수 없습니다',
  member: '분대원을 찾을 수 없습니다',
  caller: '호출할 수 없는 상태입니다',
};
const CALL_DENY_FALLBACK = '분대장이 호출을 거절했습니다';

/**
 * 구조선 요청(`rescue req`)에는 `callId` 가 없다 — 거절을 주소로 삼을 id 를 요청자 것으로 만든다.
 * `<요청자>-` 접두어라 받는 쪽의 소유 검사(`onCallDenied`)를 그대로 통과한다.
 */
export function rescueDenyId(to: PeerId): string { return `${to}-rescue`; }

/** 호스트 → 거절당한 한 사람. 보낸 사유를 `lastDenySent` 에 남긴다 (디버그 · 스모크). */
export function sendCallDeny(sys: StratagemSystem, to: PeerId, callId: string, reason: StratagemDenyReason): void {
  const net = sys.ctx.net;
  if (!net || !sys.ctx.isMultiplayer) return;
  sys.lastDenySent = reason;
  net.send({ t: 'strat', ev: 'deny', callId, reason }, to);
}

/**
 * `strat deny` 수신. 받아들이는 조건은 **둘 다** 여야 한다 — ① 로비 호스트가 보냈다(`fromHost`),
 * ② `callId` 가 내가 보낸 것이다(`<나>-…`, 호스트의 `onCallRequest` 가 쓰는 바로 그 소유 규약).
 * 그래서 남이 내 쿨타임을 되돌릴 수 없다. 통과하면 **전액 환불** + 거부음 + 사유 토스트.
 */
export function onCallDenied(sys: StratagemSystem, callId: unknown, reason: unknown, from: PeerId): void {
  const net = sys.ctx.net;
  if (!net || !fromHost(net, from)) return;
  const me = net.localId;
  if (!me || typeof callId !== 'string' || !callId.startsWith(`${me}-`)) return;
  const why = (typeof reason === 'string' ? reason : 'kind') as StratagemDenyReason;
  sys.lastCallDeny = why;
  sys.refundCooldown();
  showCallDeny(sys, why);
}

/** 거부음 + 사유 토스트 하나 (`Rescue.showDeny` 와 같은 꼴). */
export function showCallDeny(sys: StratagemSystem, reason: StratagemDenyReason): void {
  sys.audio('ui_deny', undefined, 0.6);
  sys.ctx.bus.emit('ui:notify', { text: CALL_DENY_KO[reason] ?? CALL_DENY_FALLBACK, kind: 'warning', duration: 2 });
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
