/**
 * src/allies/parts/Fsm.ts — the **state machine**. It keeps the two axes of the user's decision.
 *
 *  ① Exactly **one proposal** per frame (the highest-priority condition of them all — `PRIO`).
 *  ② A state change waits a **random delay** of `ALLY_REACT_MIN_S … ALLY_REACT_MAX_S` before acting — the heavier the
 *     action the longer (`ALLY_STATE_WEIGHT`). 「실제 PC 의 반응속도를 반영」. A more urgent proposal pushes out the
 *     one that was waiting. The four states of `model.isInstantState` (downed · dead · dormant · aboard) are applied
 *     instantly, with no delay.
 *
 * The floor rank is not one state but **one of two** (2026-09-16 user's decision): outside the harness `follow` (it
 * goes back), inside it `roam` (the free search — `parts/Roam`). They share one rank (`PRIO.follow` ≡ `PRIO.roam`),
 * so `decide` proposes only one.
 */
import {
  ALLY_FLAGS, ALLY_FOLLOW_NEAR_M, ALLY_RUN_SPEED, ALLY_WALK_SPEED,
} from '@/shared';
import type { AllyStateId } from '@/shared';
import type { AllySystem } from '../AllySystem';
import type { Ally } from './Body';
import { PRIO, _v1, dist2D, isInstantState, reactionDelay } from '../model';
import * as Nav from './Nav';
import * as Roam from './Roam';
import * as Combat from './Combat';
import * as Commands from './Commands';
import * as Loot from './Loot';
import * as Support from './Support';
import * as Extract from './Extract';
import * as Contract from './Contract';
import * as Rescue from './Rescue';
import * as Bag from './Bag';

export interface Proposal { state: AllyStateId; prio: number }

/** Period (s) for re-weighing — a layout constant, not a csv number (`bagDirty` re-weighs at once on a change). */
const WEIGHT_RECHECK_S = 0.5;

/** Changes the state right now (no reaction delay — downed · dead · debug). */
export function enter(sys: AllySystem, a: Ally, state: AllyStateId, prio: number): void {
  if (a.state === state) { a.statePrio = prio; return; }
  onExit(sys, a, a.state);
  a.state = state;
  a.statePrio = prio;
  a.stateT = 0;
  a.oneShot = false;
  a.pendingState = null;
  a.pendingT = 0;
  onEnter(sys, a, state);
}

/** Proposes a transition — it is applied after the delay. */
export function propose(sys: AllySystem, a: Ally, state: AllyStateId, prio: number): void {
  if (a.state === state) {
    a.statePrio = prio;
    if (a.pendingState) { a.pendingState = null; a.pendingT = 0; }
    return;
  }
  if (isInstantState(state)) { enter(sys, a, state, prio); return; }
  if (a.pendingState === state) { a.pendingPrio = Math.max(a.pendingPrio, prio); return; }
  if (a.pendingState && prio <= a.pendingPrio) return;
  a.pendingState = state;
  a.pendingPrio = prio;
  a.pendingT = reactionDelay(state, a.rand.next());
}

function tickPending(sys: AllySystem, a: Ally, dt: number): void {
  if (!a.pendingState) return;
  a.pendingT -= dt;
  if (a.pendingT > 0) return;
  const next = a.pendingState;
  const prio = a.pendingPrio;
  a.pendingState = null;
  enter(sys, a, next, prio);
}

function onEnter(sys: AllySystem, a: Ally, state: AllyStateId): void {
  if (state === 'combat') Combat.onEnter(sys, a);
  if (state === 'loot' || state === 'pickup') Loot.onEnter(sys, a);
  if (state === 'roam') Roam.onEnter(sys, a);
}
function onExit(sys: AllySystem, a: Ally, state: AllyStateId): void {
  if (state === 'combat') Combat.onExit(sys, a);
  if (state === 'loot' || state === 'pickup') Loot.onExit(sys, a);
  if (state === 'roam') Roam.onExit(sys, a);
}

/* ═══════════════════════════ Frame ═══════════════════════════ */

export function update(sys: AllySystem, dt: number): void {
  for (const a of sys.bodies) {
    if (a.mode !== 'raid') continue;
    a.stateT += dt;
    if (a.dead) { a.flags = ALLY_FLAGS.HIDDEN; continue; }
    if (a.hidden) continue;            // Inside the drop pod · inside a ship that lifted off
    if (a.downed) { Nav.halt(a); continue; }
    // Weighing builds an array, so it is redone once a period only (at once when the load changed).
    a.weightT -= dt;
    a.lootScanT -= dt;
    a.roamPoiT -= dt;                  // Point-of-interest re-pick period (`parts/Roam`) — a world query is not cheap
    if (a.weightT <= 0 || a.bagDirty) { a.weightT = WEIGHT_RECHECK_S; a.weightState = Bag.weightOf(sys, a).state; }
    const best = decide(sys, a);
    if (best) propose(sys, a, best.state, best.prio);
    tickPending(sys, a, dt);
    act(sys, a, dt);
  }
}

/** The single most urgent proposal under the current conditions. */
function decide(sys: AllySystem, a: Ally): Proposal | null {
  let best: Proposal | null = null;
  const take = (p: Proposal | null): void => { if (p && (!best || p.prio > best.prio)) best = p; };

  // Outside the harness it goes back to the squad leader (`follow`), inside it searches freely (`roam`) —
  // 2026-09-16 user's decision. The two share one rank, so **only one of them** is proposed (with both in, the one
  // added first always wins and the other becomes dead code).
  const inHarness = sys.leaderKnown && dist2D(a.position, sys.leaderPos) <= sys.harness;
  take(inHarness ? { state: 'roam', prio: PRIO.roam } : { state: 'follow', prio: PRIO.follow });
  take(Loot.autoProposal(sys, a));
  take(Commands.proposal(sys, a));
  take(Contract.proposal(sys, a));
  take(junkProposal(sys, a));
  take(Extract.proposal(sys, a));
  take(Support.proposal(sys, a));
  take(Combat.proposal(sys, a));
  take(Rescue.proposal(sys, a));
  return best;
}

/** Drops junk to get out of the heavy weight state (user's decision). */
function junkProposal(sys: AllySystem, a: Ally): Proposal | null {
  void sys;
  return a.weightState === 'heavy' || a.weightState === 'over' ? { state: 'dropJunk', prio: PRIO.junk } : null;
}

/* ═══════════════════════════ Acting ═══════════════════════════ */

function act(sys: AllySystem, a: Ally, dt: number): void {
  a.flags = 0;
  switch (a.state) {
    case 'follow':
    case 'idle':
      follow(sys, a, dt);
      break;
    case 'roam':
      Roam.act(sys, a, dt);
      break;
    case 'moveTo':
    case 'lead':
    case 'watch':
      Commands.act(sys, a, dt);
      break;
    case 'combat':
      Combat.act(sys, a, dt);
      break;
    case 'loot':
    case 'pickup':
      Loot.act(sys, a, dt);
      break;
    case 'deliver':
      Support.act(sys, a, dt);
      break;
    case 'dropJunk':
      dropJunk(sys, a, dt);
      break;
    case 'seekExtract':
    case 'callExtract':
    case 'board':
      Extract.act(sys, a, dt);
      break;
    case 'contract':
      Contract.act(sys, a, dt);
      break;
    case 'rescue':
    case 'carry':
      Rescue.act(sys, a, dt);
      break;
    default:
      Nav.halt(a);
      break;
  }
  a.pose = a.state === 'combat' && a.hasCover && !a.poppedOut ? 'crouch' : 'stand';
  if (a.carrying) a.pose = 'carry';
  if (a.running) a.flags |= ALLY_FLAGS.SPRINT;
}

/**
 * Once it leaves the harness it runs to follow — but never closer than `ALLY_FOLLOW_NEAR_M`, and the destination is
 * spread to the side per unit by `Nav.spreadToward` (2026-09-16 user's decision 「PC 를 향해 갈 때 산개」).
 * **Inside** the harness is `roam`'s job now (`decide`) — the only branches standing here are "the squad leader is
 * unknown" and `idle`.
 */
export function follow(sys: AllySystem, a: Ally, dt: number): void {
  if (!sys.leaderKnown) { Nav.halt(a); a.running = false; return; }
  const d = Math.hypot(a.position.x - sys.leaderPos.x, a.position.z - sys.leaderPos.z);
  if (d <= sys.harness && d >= ALLY_FOLLOW_NEAR_M) {
    Nav.halt(a);
    a.running = false;
    Nav.face(a, sys.leaderPos, dt);
    return;
  }
  if (d < ALLY_FOLLOW_NEAR_M) {
    // Too close — it steps back one pace away from the squad leader.
    _v1.set(
      a.position.x + (a.position.x - sys.leaderPos.x),
      a.position.y,
      a.position.z + (a.position.z - sys.leaderPos.z),
    );
    a.running = false;
    Nav.step(sys, a, _v1, ALLY_WALK_SPEED, dt);
    return;
  }
  a.running = true;
  // Toward a spot spread to the side, not the leader's feet — three units never come in overlapping in one line.
  Nav.spreadToward(a, sys.leaderPos, _v1);
  Nav.step(sys, a, _v1, ALLY_RUN_SPEED, dt);
}

function dropJunk(sys: AllySystem, a: Ally, dt: number): void {
  Nav.halt(a);
  void dt;
  if (!Bag.dropWorst(sys, a)) {
    // With no junk to drop there is no reason to stay here, weight state or not.
    enter(sys, a, 'follow', PRIO.follow);
  }
}
