/**
 * src/enemies/ai/NavMove.ts — **which point an enemy steers at** (TODO A-18 phase 2, 2026-09-21, user's decision 「안드로이드뿐
 * 아니라 적에게도」). `ai/EnemyAI.integrate` seeks `e.moveTarget`; `navSteer` is the one call in front of that `seek` that may
 * put a point of the raid's nav graph (`WorldRef.nav`, contract `shared/nav.ts`) there instead — through the door, up the
 * stairs — or stop the body at a full chokepoint (`ai/Gates`) or start a special link (`ai/Traverse`).
 *
 * **The graph never takes the old behaviour away.** Code 0 (「steer exactly as before」, circle avoidance on) is the answer
 * whenever: the type has no mask (`EnemyStats.navCan === 0` — warrior and larger, the csv `nav` column), there is no graph
 * (`nav` is null in the tutorial · training range · ship) or it is not baked, the body is charging / airborne / leaping / being
 * spat / digging out / fleeing / riding a tram / a tutorial enemy, its target is the rover or a drone in the air, the straight
 * line to the goal is walkable, the field or the search has no answer, or the body got stuck following the graph
 * (`ENEMY_NAV_OFF_S`).
 *
 * Every `ENEMY_NAV_CHECK_S` (staggered by id at spawn; at once when the goal jumped `GOAL_JUMP_M`) a moving body asks
 * `nav.walkable(position, goal)`. Not walkable →
 *  - **flow mode** when the goal is a *chase goal*: the body has a live **person** target (a player or an android proxy —
 *    `CombatTarget.navKey`) and `moveTarget` lies within `CHASE_GOAL_M` of it (the scavenger's weave and the hunter's flank
 *    offset are chase goals). Each tick `nav.flowTo(key, target, navCan)` → `sample` → steer at `step.aim`. Sixty bugs share one
 *    field per target + mask, and one `NavFlowStep` scratch per host is enough. Gates apply here.
 *  - **path mode** for a *private goal* (the nest, an investigated shot, a wander point, cover / pop-out, a lure, an **enemy**
 *    target): `findPath` into the body's own `NavPath`, planned again every `ENEMY_NAV_REPLAN_S`, when the goal jumped or the
 *    graph's `revision` moved, and **never more than `ENEMY_NAV_PLANS_PER_FRAME` searches a frame for the whole pool** — a body
 *    that got no slot keeps the path it has, or the old steering. Waypoints are followed the way `allies/parts/Nav.route` does.
 *
 * While a graph point steers, `integrate` skips `avoidObstacles` (walls read as huge circles and would push the body off the
 * path — the lesson of phase 1) and keeps `separate`. Following the graph without getting anywhere (net displacement under a
 * quarter of the asked travel over `ENEMY_NAV_STUCK_S`; not while attacking or queueing at a gate) switches pathfinding off for
 * `ENEMY_NAV_OFF_S`. The attack logic is untouched — it keys off `distToTarget`, and the field stops answering within
 * `NAV_FLOW_ARRIVE_M`, so the last approach and the melee are the old steering's.
 *
 * Authority only, nothing on the wire; a host change starts every body from mode 0.
 */
import * as THREE from 'three';
import {
  ENEMY_NAV_CHECK_S, ENEMY_NAV_OFF_S, ENEMY_NAV_PLANS_PER_FRAME, ENEMY_NAV_REPLAN_S, ENEMY_NAV_STUCK_S, NAV_GATE_HOLD_M, NAV_LINK_START_M,
  type NavFlowStep, type NavPath, type NavRef, type WorldRef,
} from '@/shared';
import type { Enemy, EnemyHost } from '../Enemy';
import type { CombatTarget } from '../Targets';
import { GATE_SWEEP_S, gateMiss, gatePass, releaseGate, resizeGates, sweepGates } from './Gates';
import { atLinkStart, beginTraverse, canTraverse, linkBusy } from './Traverse';

/** `navSteer`'s answers. */
export const NAV_OLD = 0;        // steer as before
export const NAV_AIM = 1;        // steer at `out` — no circle avoidance, no arrive slow-down
export const NAV_HOLD = 2;       // stand and face `out` (refused at a full gate)
export const NAV_TRAVERSE = 3;   // a special link just started — `ai/Traverse` owns the next ticks

/** A `moveTarget` within this of the person target is 「chasing it」 (m) — past the hunter's 7 m flank offset. Algorithm constant. */
const CHASE_GOAL_M = 8;
/** A goal that moved this far since the last check is checked again at once (m). Algorithm constant. */
const GOAL_JUMP_M = 4;
/** A drone floating higher than this is not walked to (m). Algorithm constant. */
const DRONE_AIR_M = 0.6;
/** A path waypoint is passed within the body radius plus this (m). Algorithm constant. */
const WAYPOINT_PAD_M = 0.4;
/** …unless it is on another floor: a waypoint this far above · below is not passed by standing under it (m; `allies/parts/Nav.FLOOR_DY`). */
const FLOOR_DY = 2;

const _goal = new THREE.Vector3();

/**
 * What the pathfinding shares between bodies, one per `EnemySystem` (`EnemyHost.nav`): the graph it was built for, the
 * flow-step scratch, this frame's A* budget, and the gate counters `ai/Gates` works on.
 */
export class EnemyNavState {
  /** The baked graph of this raid, or null (no graph · not ready) — `navSteer` answers `NAV_OLD` without it. */
  graph: NavRef | null = null;
  /** The one step buffer every flow sample of this host writes into (`NavRef.createFlowStep` — made again when the graph object changes). */
  step: NavFlowStep | null = null;
  /** Private searches still allowed this frame (`ENEMY_NAV_PLANS_PER_FRAME`). */
  plansLeft = 0;
  /** Diagnostics: private searches run over the last full second. */
  plansLastSecond = 0;
  private planCount = 0;
  private planClock = 0;
  /** Per gate (index = `NavGate.id`): token holders · bodies refused · the queue length last reported to the graph. */
  readonly holders: number[] = [];
  readonly waiting: number[] = [];
  readonly reported: number[] = [];
  private sweepT = 0;

  /** Top of the authority's AI pass: the frame's search budget, the graph identity, the periodic gate sweep. */
  beginFrame(nav: NavRef | null, dt: number, active: readonly Enemy[]): void {
    const graph = nav && nav.ready ? nav : null;
    if (graph !== this.graph) {
      this.graph = graph;
      this.step = graph ? graph.createFlowStep() : null;
      resizeGates(this, 0);
      for (let i = 0; i < active.length; i++) { const e = active[i]; if (e.navMode !== 0 || e.navTrav !== 0 || e.navGate >= 0) e.clearNav(); }
    }
    this.plansLeft = Math.max(0, Math.round(ENEMY_NAV_PLANS_PER_FRAME));
    this.planClock += dt;
    if (this.planClock >= 1) { this.planClock = 0; this.plansLastSecond = this.planCount; this.planCount = 0; }
    if (!graph) return;
    resizeGates(this, graph.gates.length);
    this.sweepT -= dt;
    if (this.sweepT <= 0) {
      const elapsed = GATE_SWEEP_S - this.sweepT;
      this.sweepT = GATE_SWEEP_S;
      sweepGates(this, graph, active, elapsed);
    }
  }

  /** One private search is about to run. False = this frame's budget is spent. */
  takePlan(): boolean {
    if (this.plansLeft <= 0) return false;
    this.plansLeft--;
    this.planCount++;
    return true;
  }

  /** Raid over / pools reset: forget the graph (the next `beginFrame` builds everything again). */
  clear(): void {
    this.graph = null;
    this.step = null;
    resizeGates(this, 0);
    this.sweepT = 0;
  }
}

/** Back to the old steering: the mode, the path and the gate token go; the check timer and `navOffT` stay. */
function leave(e: Enemy, st: EnemyNavState): void {
  releaseGate(st, e);
  e.navMode = 0;
  e.navHas = false;
  e.navStuckT = 0; e.navStuckWant = 0;
}

/** Is `moveTarget` a point around a live person target? That target, else null. */
function chaseTarget(e: Enemy): CombatTarget | null {
  const t = e.target;
  if (!t || t.navKey === '' || !t.present || t.isDeadOrDowned) return null;
  const dx = e.moveTarget.x - t.position.x, dz = e.moveTarget.z - t.position.z;
  return dx * dx + dz * dz <= CHASE_GOAL_M * CHASE_GOAL_M ? t : null;
}

/**
 * The goal with a height the graph can use. A chase goal is the target itself. A private goal is `moveTarget`, but half of the
 * AI writes that as `set(x, 0, z)` (wander points, sidesteps, back-off steps): a y of exactly 0 is read as 「unknown」 and
 * becomes the surface there at the body's own height — those points are all meant on the floor the body stands on.
 */
function goalOf(e: Enemy, world: WorldRef, chase: CombatTarget | null, out: THREE.Vector3): THREE.Vector3 {
  if (chase) return out.copy(chase.position);
  const m = e.moveTarget;
  return out.set(m.x, m.y === 0 ? world.getSurfaceY(m.x, m.z, e.position.y) : m.y, m.z);
}

/**
 * The point to steer at this tick (`ai/EnemyAI.integrate`, after `steerToVehicleSide`, before `seek`). Writes it into `out`
 * for `NAV_AIM` / `NAV_HOLD`. `speed` is what the state machine asked for — 0 or no `moveTarget` keeps the mode and answers
 * `NAV_OLD` (a body that stops to bite does not lose its place).
 */
export function navSteer(e: Enemy, dt: number, world: WorldRef, host: EnemyHost, speed: number, out: THREE.Vector3): number {
  const st = host.nav;
  const nav = st.graph;
  e.navWaitGate = -1;
  if (e.navOffT > 0) e.navOffT -= dt;
  if (!nav || e.navOffT > 0 || e.state === 'flee' || e.leaping || e.carrier !== null || e.homeLeash > 0 || e.spatT > 0 || e.emergeT > 0) {
    if (e.navMode !== 0 || e.navGate >= 0) leave(e, st);
    return NAV_OLD;
  }
  const t = e.target;
  if (t && t.present && (t.vehicle !== null || (t.drone !== null && t.droneAltitude > DRONE_AIR_M))) {
    if (e.navMode !== 0 || e.navGate >= 0) leave(e, st);
    return NAV_OLD;
  }
  if (!e.hasMoveTarget || speed <= 0) { e.navStuckT = 0; e.navStuckWant = 0; return NAV_OLD; }
  // An idle stroll is not worth a search: a wander point is an arbitrary spot a few metres off, the old steering gets
  // round a rock to it, and a quiet raid has 10–20 strollers at any moment — measured at 6–11 private searches a second
  // for nothing. `wander` with a purpose (walking home on the nest leash, toward a lure, an investigation) still paths.
  if (e.state === 'wander' && !e.nestReturning && !e.hasLure && !e.investigating) {
    if (e.navMode !== 0 || e.navGate >= 0) leave(e, st);
    return NAV_OLD;
  }

  const chase = chaseTarget(e);
  const want = chase ? 1 : 2;
  const gx = (chase ? chase.position.x : e.moveTarget.x) - e.navGoal.x, gz = (chase ? chase.position.z : e.moveTarget.z) - e.navGoal.z;
  const jumped = gx * gx + gz * gz > GOAL_JUMP_M * GOAL_JUMP_M;
  e.navCheckT -= dt;
  if (e.navCheckT <= 0 || jumped || (e.navMode !== 0 && e.navMode !== want)) {
    e.navCheckT = ENEMY_NAV_CHECK_S;
    goalOf(e, world, chase, _goal);
    e.navGoal.copy(_goal);
    if (nav.walkable(e.position, _goal)) { if (e.navMode !== 0 || e.navGate >= 0) leave(e, st); }
    else if (e.navMode !== want) {
      leave(e, st);
      e.navMode = want;
      e.navPlanT = 0;
      e.navStuckFrom.copy(e.position);
    } else if (jumped) e.navPlanT = 0;
  }
  if (e.navMode === 0) return NAV_OLD;

  let code = NAV_OLD;
  let queueing = false;
  if (e.navMode === 1) {
    const step = st.step;
    const flow = chase && step ? nav.flowTo(chase.navKey, chase.position, e.stats.navCan) : null;
    if (!flow || !step || !flow.sample(e.position, step)) gateMiss(st, e, dt);
    else if (step.kind !== 'walk') {
      // not this mask's link (a graph change mid-step), or the sample snapped to a link start on another floor: the old steering
      if (!canTraverse(e, step.kind) || !atLinkStart(e, step.from)) gateMiss(st, e, dt);
      else if (linkBusy(e, host.active, step.from)) { out.copy(step.to); queueing = true; code = NAV_HOLD; }   // one at a time into the link's mouth
      else if (beginTraverse(e, world, step.kind, step.from, step.via, step.to, step.ladderId, step.windowId)) {
        releaseGate(st, e);
        return NAV_TRAVERSE;
      }
    } else if (gatePass(st, e, step.gate, step.gateDist, dt)) { out.copy(step.aim); code = NAV_AIM; }
    else {
      // refused: walk up to the queue, then stand facing the gate
      queueing = true;
      if (step.gateDist <= NAV_GATE_HOLD_M) { out.copy(nav.gates[step.gate].position); code = NAV_HOLD; }
      else { out.copy(step.aim); code = NAV_AIM; }
    }
  } else {
    code = followPath(e, dt, world, nav, st, host.active, chase, jumped, out);
    if (code === NAV_TRAVERSE) return code;
  }

  if (code !== NAV_AIM || queueing || e.state === 'attack') { e.navStuckT = 0; e.navStuckWant = 0; e.navStuckFrom.copy(e.position); return code; }
  // Stuck: judged on the net displacement over a window, never per frame (`allies/parts/Nav.step` — TODO E-14).
  e.navStuckT += dt;
  e.navStuckWant += speed * dt;
  if (e.navStuckT >= ENEMY_NAV_STUCK_S) {
    const net = Math.hypot(e.position.x - e.navStuckFrom.x, e.position.z - e.navStuckFrom.z);
    const stuck = net < e.navStuckWant * 0.25;
    e.navStuckFrom.copy(e.position); e.navStuckT = 0; e.navStuckWant = 0;
    if (stuck) { leave(e, st); e.navOffT = ENEMY_NAV_OFF_S; return NAV_OLD; }
  }
  return code;
}

/** Path mode: plan when due (and a slot is left), then hand out the next waypoint — or start the special link it stands for. */
function followPath(
  e: Enemy, dt: number, world: WorldRef, nav: NavRef, st: EnemyNavState, active: readonly Enemy[],
  chase: CombatTarget | null, jumped: boolean, out: THREE.Vector3,
): number {
  e.navPlanT -= dt;
  if ((e.navPlanT <= 0 || jumped || e.navRev !== nav.revision) && st.takePlan()) {
    let path: NavPath | null = e.navPath;
    if (!path || e.navPathOf !== nav) { path = e.navPath = nav.createPath(); e.navPathOf = nav; }
    goalOf(e, world, chase, _goal);
    const status = nav.findPath(e.position, _goal, e.stats.navCan, path);
    // `none` (proven unreachable) and `pending` leave the old steering in charge until the next plan
    e.navHas = (status === 'ok' || status === 'partial') && path.count > 0;
    e.navIdx = 0;
    e.navPlanT = ENEMY_NAV_REPLAN_S * (0.75 + ((e.id & 7) / 8) * 0.5);   // spread the pool's replans over the period
    e.navRev = nav.revision;
  }
  const path = e.navPath;
  if (!e.navHas || !path) return NAV_OLD;
  const p = e.position;
  const reach = e.stats.radius + WAYPOINT_PAD_M;
  while (e.navIdx < path.count) {
    const w = path.points[e.navIdx];
    if (w.kind !== 'walk') {
      if (!canTraverse(e, w.kind)) { e.navHas = false; return NAV_OLD; }
      // The link starts at the previous waypoint (or right here when it is the path's first point).
      const from = e.navIdx > 0 ? path.points[e.navIdx - 1].position : p;
      const fx = from.x - p.x, fz = from.z - p.z;
      if (fx * fx + fz * fz > NAV_LINK_START_M * NAV_LINK_START_M) { out.copy(from); return NAV_AIM; }
      if (linkBusy(e, active, from)) { out.copy(w.position); return NAV_HOLD; }
      e.navIdx++;
      if (beginTraverse(e, world, w.kind, from, w.via, w.position, w.ladderId, w.windowId)) return NAV_TRAVERSE;
      e.navHas = false;
      return NAV_OLD;
    }
    const dx = w.position.x - p.x, dz = w.position.z - p.z;
    if (dx * dx + dz * dz > reach * reach || Math.abs(w.position.y - p.y) > FLOOR_DY) { out.copy(w.position); return NAV_AIM; }
    e.navIdx++;
  }
  // Past the last waypoint (the snapped goal): the last stretch is straight, as before.
  e.navHas = false;
  return NAV_OLD;
}

const MODE_NAME = ['none', 'flow', 'path'] as const;
const TRAV_NAME = ['none', 'ladder', 'climb', 'window'] as const;

/** `EnemySystem.debugNavOf` — one body's pathfinding state, for the smokes. */
export function describeNav(e: Enemy): {
  mode: 'none' | 'flow' | 'path'; traverse: 'none' | 'ladder' | 'climb' | 'window'; phase: number; aloft: boolean; climbDir: number;
  gate: number; waitGate: number; offT: number; pathStatus: string | null; pathCount: number; pathIdx: number; navCan: number;
} {
  return {
    mode: MODE_NAME[e.navMode], traverse: TRAV_NAME[e.navTrav], phase: e.navTravPhase, aloft: e.navAloft, climbDir: e.navClimbDir,
    gate: e.navGate, waitGate: e.navWaitGate, offT: Math.max(0, e.navOffT),
    pathStatus: e.navHas && e.navPath ? e.navPath.status : null, pathCount: e.navHas && e.navPath ? e.navPath.count : 0, pathIdx: e.navIdx,
    navCan: e.stats.navCan,
  };
}
