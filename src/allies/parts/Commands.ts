/**
 * src/allies/parts/Commands.ts — **orders**. There is no new input at all (user's decision): it listens to pings
 * (`ping:placedV3`) · the comms wheel (`comms:sent`) · inventory requests (`inventory:itemRequested`, `allyq item`
 * when remote).
 *
 * Two branches.
 *  - An **order** (move `attack` · `주의` `caution` · `앞장` `lead`): **only the squad leader's** is obeyed, and the
 *    whole squad moves together.
 *  - A **request** (heal · shield · ammo · item · crate · extraction · contract): anyone may send one and only the
 *    **first one that arrived** is taken. For `ALLY_REQUEST_COOLDOWN_S` after that every other request is ignored
 *    (shared by the squad). The nearest unit that can do it takes it, and if nobody can, the nearest one says a line.
 */
import * as THREE from 'three';
import {
  ALLY_LEAD_AHEAD_M, ALLY_LEAD_DURATION_S, ALLY_MOVE_ARRIVE_M, ALLY_MOVE_HOLD_S, ALLY_REQUEST_COOLDOWN_S,
  ALLY_RUN_SPEED, ALLY_SPREAD_M, ALLY_WALK_SPEED, ALLY_WATCH_S, isAndroidId,
} from '@/shared';
import type { CommsId, EnemyRef, ItemRequestKind, PeerId, PingKind } from '@/shared';
import { shieldChargeOf, boostItemOf, AMMO_LABEL_KO } from '@/items';
import type { AllySystem } from '../AllySystem';
import type { Ally } from './Body';
import type { Proposal } from './Fsm';
import { CHAT_KO, PRIO, _v1, _v2, dist2D, forwardOf } from '../model';
import type { AllyRequestKind } from '../model';
import * as Nav from './Nav';
import * as Ping from './Ping';
import * as Bag from './Bag';
import * as Harness from './Harness';

/** Never goes closer than this to a `주의` ping spot (m) — 「해당 위치로 가려고 하지 않음」. */
const WATCH_KEEP_OUT_M = 6;
/**
 * The window that matches a person's extraction ping to a pad (m) — not a distance limit but the match window for
 * 「does that ping point at this pad」 (a layout constant).
 */
const PING_PAD_MATCH_M = 20;

/* ═══════════════════════════ Input ═══════════════════════════ */

export function onPing(
  sys: AllySystem,
  e: { position: THREE.Vector3; kind: PingKind; owner: PeerId | null; label?: string; enemyId?: number },
): void {
  if (isAndroidId(e.owner)) return;                 // a ping it placed itself (or a fellow android) is not an order
  const by = e.owner ?? (sys.ctx.net?.localId ?? 'local');
  const fromLeader = by === sys.leaderId;
  switch (e.kind) {
    case 'attack':
      if (fromLeader) {
        sys.orderKind = 'moveTo';
        sys.orderPos.copy(e.position);
        sys.orderUntil = Infinity;
        // Sets the mark **this order is not finished yet** on every unit — it reaches 0 only after the unit
        // arrived and held there. (Without it the first `moveTo` frame reads at once as 「the hold is over」 and the
        // body alternates between following ↔ moving — see `proposal`.)
        for (const a of sys.bodies) a.moveHoldT = ALLY_MOVE_HOLD_S;
        cancelExtractEscort(sys);                   // a new move order wins (the extraction escort is released)
      }
      break;
    case 'caution':
      if (fromLeader) { sys.watchPos.copy(e.position); sys.watchUntil = sys.ctx.time + ALLY_WATCH_S; }
      break;
    case 'enemy':
      // 2026-09-16 user's decision 「PC 가 적 핑을 찍으면」 — obeyed from **any human** (not leader-only).
      if (typeof e.enemyId === 'number') onEnemyPing(sys, e.enemyId, e.position);
      break;
    case 'extraction':
      // 2026-09-16 user's decision — the way out a person marked is remembered. When that person says
      // 「탈출하고 싶다」 the squad goes there.
      if (sys.raidActive && sys.simulating) {
        sys.humanExtractPos.copy(e.position);
        sys.humanExtractBy = by;
        sys.humanExtractAt = sys.ctx.time;
        sys.hasHumanExtractPing = true;
      }
      break;
    case 'crate':
      request(sys, 'crate', by, e.position, { targetId: e.label ?? null });
      break;
    case 'item':
      request(sys, 'item', by, e.position, {});
      break;
    default:
      break;
  }
}

/* ── The enemy ping: agrees and intercepts (2026-09-16) ──────── */

/**
 * Accepts an enemy ping a person placed. `parts/Combat` reads the designation and `tickEnemyPing` releases it:
 * **it died · nobody saw it for `ALLY_WATCH_S` · a newer ping arrived** — any one of the three (the squad is never
 * bound to it forever).
 */
function onEnemyPing(sys: AllySystem, enemyId: number, at: THREE.Vector3): void {
  if (!sys.raidActive || !sys.simulating) return;   // only the authority judges (a replica would say the line twice)
  /* 2026-09-18 (bug eggs): a ping that names an egg is not agreed to. Engagement is only for things that
     **fight back** — an egg neither moves nor shoots, so 「shoot that one」 does not hold, and it makes the squad
     pour ammo out in front of a nest. A player who wants the cells shoots the egg themselves. (`ui/hud/Pings`
     already puts no ping on an egg, so this is insurance against an old ping · a tampered id.) */
  if (isEggId(sys, enemyId)) return;
  sys.preferredEnemyId = enemyId;
  sys.preferredEnemyPos.copy(at);
  sys.preferredEnemyUntil = sys.ctx.time + ALLY_WATCH_S;
  const who = nearestBody(sys, at);
  if (who) Ping.say(sys, who, CHAT_KO.agreeEnemy);   // `Ping.say` blocks a repeat of the same sentence
}

/** Releases the designation. */
function clearEnemyPing(sys: AllySystem): void {
  sys.preferredEnemyId = null;
  sys.preferredEnemyUntil = -Infinity;
}

/** Checks the designated enemy once per frame (`AllySystem.update` — scanning per unit keeps building arrays). */
export function tickEnemyPing(sys: AllySystem): void {
  if (sys.preferredEnemyId === null) return;
  const now = sys.ctx.time;
  let found: EnemyRef | null = null;
  for (const e of sys.ctx.enemies?.getEnemies() ?? []) {
    if (e.id === sys.preferredEnemyId) { found = e; break; }
  }
  // 2026-09-18: it died · it is gone · it is an egg (an egg is never designated in the first place, but this is
  // the only place a designation survives, so it is looked at here too)
  if (!found || found.isDead || found.isEgg) { clearEnemyPing(sys); return; }
  sys.preferredEnemyPos.copy(found.position);
  // Only a unit that **actually has it in its line of sight** pushes the window (`parts/Combat.proposal`) —
  // hanging around with it left behind a wall releases it.
  if (now >= sys.preferredEnemyUntil) clearEnemyPing(sys);
}

/** Is that id a bug egg (`EnemyRef.isEgg` — an unknown id is not). */
function isEggId(sys: AllySystem, enemyId: number): boolean {
  for (const e of sys.ctx.enemies?.getEnemies() ?? []) if (e.id === enemyId) return e.isEgg === true;
  return false;
}

/** The unit nearest `at` that can move in the raid right now (only one unit says a line). */
function nearestBody(sys: AllySystem, at: THREE.Vector3): Ally | null {
  let best: Ally | null = null;
  let bestD = Infinity;
  for (const a of sys.bodies) {
    if (a.mode !== 'raid' || a.dead || a.downed || a.hidden) continue;
    const d = dist2D(a.position, at);
    if (d < bestD) { best = a; bestD = d; }
  }
  return best;
}

export function onComms(sys: AllySystem, e: { id: CommsId; by: string | null; position: THREE.Vector3 | null; text: string }): void {
  const by = e.by ?? (sys.ctx.net?.localId ?? 'local');
  if (isAndroidId(by)) return;
  const at = e.position ?? sys.leaderPos;
  switch (e.id) {
    case 'need_heal':
      request(sys, 'heal', by, at, {});
      break;
    case 'extract':
      onExtractComms(sys, by, at);
      break;
    case 'contract':
      request(sys, 'contract', by, at, { text: e.text });
      break;
    case 'lead':
      if (by === sys.leaderId) onLead(sys);
      break;
    default:
      break;
  }
}

/** The local player's inventory request (middle-click · the menu). */
export function onItemRequest(
  sys: AllySystem,
  e: { kind: ItemRequestKind; defId: string | null; ammoType: string | null; position: THREE.Vector3 },
): void {
  const by = sys.ctx.net?.localId ?? 'local';
  request(sys, e.kind, by, e.position, { defId: e.defId, ammoType: e.ammoType });
}

/** A remote squadmate's inventory request (`allyq item` — it only arrives on the host). */
export function onRemoteItemRequest(
  sys: AllySystem, from: PeerId,
  e: { kind: ItemRequestKind; defId?: string; ammoType?: string; p: [number, number, number] },
): void {
  _v1.set(e.p[0], e.p[1], e.p[2]);
  request(sys, e.kind, from, _v1, { defId: e.defId ?? null, ammoType: e.ammoType ?? null });
}

export function onContainerViewed(sys: AllySystem, containerId: string): void {
  sys.viewedContainers.add(containerId);
  for (const a of sys.bodies) if (a.lootContainerId === containerId) a.lootContainerId = null;
}

/**
 * 「탈출하고 싶다」 — the order of the branches **is** the rule.
 *  ① With the confirm window (`ALLY_EXTRACT_CONFIRM_S`) open it **presses the call button** (`parts/Extract`). A ping
 *     the android placed itself and an agreement to a PC's extraction ping through ② below use the same window.
 *  ② With an extraction ping a person left, **the whole squad agrees and goes to that spot** (2026-09-16 user's
 *     decision).
 *  ③ With neither, the old `탈출` request — the nearest unit looks for a pad inside the harness and pings it.
 */
function onExtractComms(sys: AllySystem, by: PeerId, at: THREE.Vector3): void {
  for (const a of sys.bodies) {
    if (a.extractRequester === by && a.extractPadId && sys.ctx.time - a.extractPingAt <= sys.extractConfirmWindow) {
      a.taskKind = 'extract';
      a.taskBy = by;
      a.confirmExtract = true;
      return;
    }
  }
  if (agreeToHumanExtract(sys, by)) return;
  request(sys, 'extract', by, at, {});
}

/**
 * Agrees to an extraction ping a PC placed — the whole squad moves 「PC 하네스 범위 내에서 해당 탈출구를 향해」
 * (`parts/Extract.seek` reads `hasExtractPing` and walks there clamped to the harness). True when it agreed.
 * The pad at that spot is hung on the bodies as well, so when the same person says it once more inside the confirm
 * window, ① above presses the console.
 */
function agreeToHumanExtract(sys: AllySystem, by: PeerId): boolean {
  if (!sys.hasHumanExtractPing || !sys.raidActive || !sys.simulating) return false;
  const padId = padNearPing(sys);
  let any = false;
  for (const a of sys.bodies) {
    if (a.mode !== 'raid' || a.dead || a.hidden) continue;
    a.extractPingPos.copy(sys.humanExtractPos);
    a.hasExtractPing = true;
    a.taskKind = 'extract';
    a.taskBy = by;
    a.taskAt.copy(sys.humanExtractPos);
    a.extractRequester = by;
    a.extractPingAt = sys.ctx.time;
    if (padId) a.extractPadId = padId;
    a.confirmExtract = false;
    a.oneShot = false;
    any = true;
  }
  if (!any) return false;
  const who = nearestBody(sys, sys.humanExtractPos);
  if (who) Ping.say(sys, who, CHAT_KO.agreeExtract);
  return true;
}

/** The id of the pad nearest the extraction ping a person placed (null when that ping names no pad). */
function padNearPing(sys: AllySystem): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const p of sys.ctx.extraction?.getPads?.() ?? []) {
    const d = dist2D(p.position, sys.humanExtractPos);
    if (d < bestD) { best = p.id; bestD = d; }
  }
  return bestD <= PING_PAD_MATCH_M ? best : null;
}

/**
 * Releases the extraction **escort only** (a new move order wins). The ping a person left
 * (`sys.humanExtractPos`) itself is kept — the memory is cleared only when the raid ends
 * (`AllySystem.clearPingOrders`), and another 「탈출하고 싶다」 is agreed to again.
 */
function cancelExtractEscort(sys: AllySystem): void {
  for (const a of sys.bodies) {
    if (!a.hasExtractPing) continue;
    a.hasExtractPing = false;
    if (a.taskKind === 'extract' && !a.confirmExtract) finishTask(sys, a);
  }
}

/**
 * 「앞장서라」 (2026-09-16 user's decision 「일반 범위의 2배로 각자 일대를 수색, 일정 시간 뒤 자동 해제」).
 *  - The harness widens by `ALLY_LEAD_HARNESS_MUL` (`parts/Harness.update` reads `sys.leadUntil` — following · the
 *    free search · cover · extraction all look at the same radius).
 *  - Every unit goes ahead into **its own zone** (`leadSpot` — spread `ALLY_SPREAD_M` apart so they do not stack on
 *    one point). On arrival the order ends and `roam` (the free search) sweeps the area inside the widened harness.
 *  - It releases itself once `ALLY_LEAD_DURATION_S` passes. Another order that arrived before that (`가자` · `주의` ·
 *    another line) wins.
 */
function onLead(sys: AllySystem): void {
  if (!sys.raidActive) return;      // an order that widens the harness — meaningless outside a raid
  forwardOf(leaderYaw(sys), _v1);
  sys.orderKind = 'lead';
  sys.orderPos.copy(sys.leaderPos).addScaledVector(_v1, ALLY_LEAD_AHEAD_M);
  sys.orderUntil = sys.ctx.time + ALLY_LEAD_DURATION_S;
  sys.leadUntil = sys.ctx.time + ALLY_LEAD_DURATION_S;
  cancelExtractEscort(sys);
}

/* ═══════════════════════════ Requests ═══════════════════════════ */

function request(
  sys: AllySystem, kind: AllyRequestKind, by: PeerId, at: THREE.Vector3,
  opts: { defId?: string | null; ammoType?: string | null; targetId?: string | null; text?: string },
): void {
  if (!sys.raidActive || !sys.simulating) return;
  if (sys.ctx.time < sys.requestBlockedUntil) return;     // first one wins — requests arriving meanwhile are dropped
  sys.request = {
    kind, by, at: at.clone(), defId: opts.defId ?? null, ammoType: opts.ammoType ?? null,
    targetId: opts.targetId ?? null, time: sys.ctx.time, claimedBy: null,
  };
  sys.requestText = opts.text ?? '';
  sys.requestBlockedUntil = sys.ctx.time + ALLY_REQUEST_COOLDOWN_S;
}

/**
 * Hangs a request nobody has taken yet on the **nearest unit that can do it**. If nobody can, one line is said and
 * the request is dropped.
 */
export function tickRequest(sys: AllySystem): void {
  const req = sys.request;
  if (!req || req.claimedBy) return;
  let best: Ally | null = null;
  let bestD = Infinity;
  let nearest: Ally | null = null;
  let nearestD = Infinity;
  for (const a of sys.bodies) {
    if (a.mode !== 'raid' || a.dead || a.downed || a.hidden) continue;
    const d = dist2D(a.position, req.at);
    if (d < nearestD) { nearest = a; nearestD = d; }
    if (!canFulfil(sys, a, req.kind, req.defId, req.ammoType)) continue;
    if (d < bestD) { best = a; bestD = d; }
  }
  if (best) {
    req.claimedBy = best.id;
    best.taskKind = req.kind;
    best.taskBy = req.by;
    best.taskAt.copy(req.at);
    best.taskDefId = req.defId;
    best.taskAmmoType = req.ammoType;
    best.taskTargetId = req.targetId;
    best.deliverUid = null;
    best.deliverPinged = false;
    best.deliverWaitT = 0;
    return;
  }
  if (nearest) Ping.say(sys, nearest, missingLine(req.kind, req.ammoType));
  sys.request = null;
}

/**
 * Does this body hold something that fills that request right now. A search kind (crate · extraction · contract) is
 * always taken.
 */
function canFulfil(sys: AllySystem, a: Ally, kind: AllyRequestKind, defId: string | null, ammoType: string | null): boolean {
  switch (kind) {
    case 'heal':
      // 「회복 아이템」 = a pure healing drug — not a shield charger, not a boost.
      return !!Bag.findInBag(sys, a, (d) => d.category === 'stim' && !shieldChargeOf(d.id) && !boostItemOf(d.id));
    case 'shield':
      return !!Bag.findInBag(sys, a, (d) => !!shieldChargeOf(d.id));
    case 'ammo':
      return !!Bag.findInBag(sys, a, (d) => d.category === 'ammo' && (!ammoType || d.ammoType === ammoType));
    case 'item':
      return !!defId && !!Bag.findInBag(sys, a, (d) => d.id === defId);
    default:
      return true;
  }
}

function missingLine(kind: AllyRequestKind, ammoType: string | null): string {
  switch (kind) {
    case 'heal': return CHAT_KO.noHeal;
    case 'shield': return CHAT_KO.noShield;
    case 'ammo': return CHAT_KO.noAmmo(ammoType ? ((AMMO_LABEL_KO as Record<string, string>)[ammoType] ?? ammoType) : '');
    case 'extract': return CHAT_KO.noExtract;
    case 'contract': return CHAT_KO.noContract;
    default: return CHAT_KO.noItem;
  }
}

/**
 * Ends the request (handed over · could not). The extraction-ping escort ends here with it — once a new task is
 * taken there is no reason to keep following it.
 */
export function finishTask(sys: AllySystem, a: Ally): void {
  if (sys.request?.claimedBy === a.id) sys.request = null;
  a.hasExtractPing = false;
  a.taskKind = null;
  a.taskBy = null;
  a.taskDefId = null;
  a.taskAmmoType = null;
  a.taskTargetId = null;
  a.deliverUid = null;
  a.deliverPinged = false;
  a.deliverWaitT = 0;
}

/* ═══════════════════════════ Order states ═══════════════════════════ */

/**
 * The proposal of the order states. **`moveHoldT` is the mark meaning 「this order is not finished yet」** — it is
 * raised to `ALLY_MOVE_HOLD_S` when the order arrives and reaches 0 only after the unit arrived and held that long.
 *
 * It used to be raised only **after** arrival: the first `moveTo` frame read at once as 「the hold is over」, so the
 * proposal was null → `Fsm.decide` dropped the body to following → the order was proposed again the next frame → an
 * oscillation back and forth between the ping and the squad leader (fixed 2026-09-16).
 */
export function proposal(sys: AllySystem, a: Ally): Proposal | null {
  const now = sys.ctx.time;
  if (now < sys.watchUntil) return { state: 'watch', prio: PRIO.order };
  if (sys.orderKind && now < sys.orderUntil) {
    if (sys.orderKind === 'moveTo' && a.moveHoldT <= 0) return null;   // arrived and held out the wait → the harness
    return { state: sys.orderKind, prio: PRIO.order };
  }
  return null;
}

/**
 * The **own zone** of 「앞장서라」 — writes into `out` the spot `ALLY_LEAD_AHEAD_M` ahead of the squad leader,
 * moved `ALLY_SPREAD_M` sideways per unit (so three units do not stand on one point). Clamped into the widened
 * harness.
 */
function leadSpot(sys: AllySystem, a: Ally, out: THREE.Vector3): THREE.Vector3 {
  out.copy(sys.orderPos);
  const dx = sys.orderPos.x - sys.leaderPos.x;
  const dz = sys.orderPos.z - sys.leaderPos.z;
  const d = Math.hypot(dx, dz);
  if (d > 1e-3) {
    const n = Math.max(1, sys.bodies.length);
    const k = (a.bay - (n - 1) / 2) * ALLY_SPREAD_M;
    out.x += (dz / d) * k;
    out.z += (-dx / d) * k;
  }
  return Nav.clampToHarness(sys.leaderPos, sys.harness, out, out);
}

export function act(sys: AllySystem, a: Ally, dt: number): void {
  if (a.state === 'watch') {
    // Looks at that spot but does not go to it (user's decision).
    a.lookVec.copy(sys.watchPos);
    a.lookAt = a.lookVec;
    Nav.face(a, sys.watchPos, dt);
    // Stays beside the squad leader — the harness is alive during a `주의` too.
    if (sys.leaderKnown && dist2D(a.position, sys.leaderPos) > sys.harness) {
      a.running = true;
      Nav.step(sys, a, sys.leaderPos, ALLY_RUN_SPEED, dt, sys.watchPos, WATCH_KEEP_OUT_M);
    } else Nav.halt(a);
    return;
  }
  const lead = a.state === 'lead';
  const dest = lead ? leadSpot(sys, a, _v2) : sys.orderPos;
  a.running = lead;
  const left = Nav.step(sys, a, dest, lead ? ALLY_RUN_SPEED : ALLY_WALK_SPEED, dt,
    sys.ctx.time < sys.watchUntil ? sys.watchPos : null, WATCH_KEEP_OUT_M);
  if (left > ALLY_MOVE_ARRIVE_M) return;
  Nav.halt(a);
  a.running = false;
  if (lead) {
    // Reached its own zone → the order ends here, and the free search sweeps the area inside the widened
    // harness (`sys.leadUntil`).
    sys.orderKind = null;
    sys.orderUntil = -Infinity;
    return;
  }
  // 「가자」 — `ALLY_MOVE_HOLD_S` is counted down from the arrival on. At 0 this order is finished **once**.
  a.moveHoldT -= dt;
  if (a.moveHoldT <= 0) { a.moveHoldT = 0; sys.orderKind = null; sys.orderUntil = -Infinity; }
}

function leaderYaw(sys: AllySystem): number {
  const ctx = sys.ctx;
  const localId = ctx.net?.localId ?? 'local';
  if (sys.leaderId === localId) return ctx.player?.yaw ?? 0;
  return ctx.net?.getRemotePlayer(sys.leaderId)?.yaw ?? 0;
}

/** The requester's position · speed · gaze (the hand-over condition test, `parts/Support`). Null when unknown. */
export function requesterOf(sys: AllySystem, peer: PeerId): { position: THREE.Vector3; speed: number; yaw: number } | null {
  const ctx = sys.ctx;
  const localId = ctx.net?.localId ?? 'local';
  if (peer === localId) {
    const p = ctx.player;
    return p ? { position: p.position, speed: Math.hypot(p.velocity.x, p.velocity.z), yaw: p.yaw } : null;
  }
  const rp = ctx.net?.getRemotePlayer(peer);
  return rp ? { position: rp.position, speed: Math.hypot(rp.velocity.x, rp.velocity.z), yaw: rp.yaw } : null;
}

/** The ammo type of the requester's equipped primary (the default for an ammo request). */
export function requesterAmmoType(sys: AllySystem, peer: PeerId): string | null {
  const ctx = sys.ctx;
  const localId = ctx.net?.localId ?? 'local';
  if (peer === localId) {
    const prim = ctx.inventory?.getLoadout().primary ?? null;
    return prim ? ctx.loot?.getEffectiveStats(prim)?.ammoType ?? null : null;
  }
  const card = ctx.net?.getCrewCard(peer);
  return card?.primary ? ctx.loot?.getEffectiveStats(card.primary)?.ammoType ?? null : null;
}

/** Re-reads the squad leader (delegated to `parts/Harness` — the console cheat uses it). */
export const leaderIdOf = Harness.leaderOf;
