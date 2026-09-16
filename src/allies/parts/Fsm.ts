/**
 * src/allies/parts/Fsm.ts — **상태 기계**. 사용자 결정의 두 축을 지킨다.
 *
 *  ① 매 프레임 **하나의 제안**만 고른다 (조건들 중 우선순위가 가장 높은 것 — `PRIO`).
 *  ② 상태가 바뀌면 행동까지 `ALLY_REACT_MIN_S … ALLY_REACT_MAX_S` 의 **무작위 지연**을 둔다 — 무거운 행동일수록 길다
 *     (`ALLY_STATE_WEIGHT`). 「실제 PC 의 반응속도를 반영」. 더 급한 제안은 기다리던 제안을 밀어낸다.
 *     쓰러짐 · 사망은 지연 없이 즉시 적용된다.
 *
 * 바닥 서열은 하나가 아니라 **둘 중 하나**다 (2026-09-16 사용자 결정): 하네스 밖이면 `follow`(돌아간다),
 * 안이면 `roam`(자유 탐색 — `parts/Roam`). 같은 서열(`PRIO.follow` ≡ `PRIO.roam`)이라 `decide` 가 하나만 제안한다.
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

/** 무게를 다시 재는 주기 (s) — 배치값이다 (짐이 바뀌면 `bagDirty` 로 곧바로 다시 잰다). */
const WEIGHT_RECHECK_S = 0.5;

/** 상태를 지금 곧바로 바꾼다 (반응 지연 없음 — 쓰러짐 · 사망 · 디버그). */
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

/** 전이를 제안한다 — 지연 뒤에 적용된다. */
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

/* ═══════════════════════════ 프레임 ═══════════════════════════ */

export function update(sys: AllySystem, dt: number): void {
  for (const a of sys.bodies) {
    if (a.mode !== 'raid') continue;
    a.stateT += dt;
    if (a.dead) { a.flags = ALLY_FLAGS.HIDDEN; continue; }
    if (a.hidden) continue;            // 강하 포드 안 · 이륙한 함선 안
    if (a.downed) { Nav.halt(a); continue; }
    // 무게는 배열을 만들어 재므로 주기마다만 (짐이 바뀌면 곧바로) 다시 잰다.
    a.weightT -= dt;
    a.lootScanT -= dt;
    a.roamPoiT -= dt;                  // 관심 지점 다시 고르기 주기 (`parts/Roam`) — 월드 질의는 싸지 않다
    if (a.weightT <= 0 || a.bagDirty) { a.weightT = WEIGHT_RECHECK_S; a.weightState = Bag.weightOf(sys, a).state; }
    const best = decide(sys, a);
    if (best) propose(sys, a, best.state, best.prio);
    tickPending(sys, a, dt);
    act(sys, a, dt);
  }
}

/** 지금 조건에서 가장 급한 제안 하나. */
function decide(sys: AllySystem, a: Ally): Proposal | null {
  let best: Proposal | null = null;
  const take = (p: Proposal | null): void => { if (p && (!best || p.prio > best.prio)) best = p; };

  // 하네스 밖이면 분대장에게 돌아가고(`follow`), 안이면 자유롭게 탐색한다(`roam`) — 2026-09-16 사용자 결정.
  // 둘은 같은 서열이라 **둘 중 하나만** 제안한다 (둘 다 넣으면 먼저 넣은 쪽이 늘 이겨 한쪽이 죽은 코드가 된다).
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

/** 무거움 상태를 벗어나려 짐을 버린다 (사용자 결정). */
function junkProposal(sys: AllySystem, a: Ally): Proposal | null {
  void sys;
  return a.weightState === 'heavy' || a.weightState === 'over' ? { state: 'dropJunk', prio: PRIO.junk } : null;
}

/* ═══════════════════════════ 행동 ═══════════════════════════ */

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
 * 하네스를 벗어나면 뛰어서 따라간다 — 다만 `ALLY_FOLLOW_NEAR_M` 보다 가까이 붙지 않고, 목적지는
 * `Nav.spreadToward` 로 기마다 옆으로 벌린다 (2026-09-16 사용자 결정 「PC 를 향해 갈 때 산개」).
 * 하네스 **안**은 이제 `roam` 이 맡는다 (`decide`) — 여기 서 있는 가지는 분대장을 모를 때와 `idle` 뿐이다.
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
    // 너무 붙었다 — 분대장 반대쪽으로 한 걸음 물러난다.
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
  // 분대장 발밑이 아니라 옆으로 벌린 자리로 — 세 기가 한 줄로 겹쳐 오지 않는다.
  Nav.spreadToward(a, sys.leaderPos, _v1);
  Nav.step(sys, a, _v1, ALLY_RUN_SPEED, dt);
}

function dropJunk(sys: AllySystem, a: Ally, dt: number): void {
  Nav.halt(a);
  void dt;
  if (!Bag.dropWorst(sys, a)) {
    // 버릴 것이 없으면 짐 상태가 아니어도 여기 머물 이유가 없다.
    enter(sys, a, 'follow', PRIO.follow);
  }
}
