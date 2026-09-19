/**
 * src/allies/parts/Roam.ts — the **free search** (2026-09-16 user's decision 「하네스 안에서는 분대장 뒤만 졸졸 따라오지 말고
 * 자유롭게 탐색한다」). **Outside** the harness `Fsm.follow` runs back; **inside** it this is the state — the two
 * share one rank (`PRIO.follow` ≡ `PRIO.roam`), so `Fsm.decide` proposes **exactly one of the two** every frame.
 * Combat · orders · rescue · looting all rank above it and simply win.
 *
 * How it wanders is a **mix of the two** (user's decision):
 *  ① a **point of interest** — a structure · ruin site inside the harness, or one large cover object when there
 *     is none, and it circles inside `ALLY_ROAM_POI_RADIUS_M` of it.
 *  ② **it gives that point up when another squadmate · android already stands** within `ALLY_ROAM_POI_TAKEN_M`
 *     of it and switches to a random patrol inside the harness (three of them piled into one building does not
 *     read as 「free search」).
 * The point of interest is re-picked only every `POI_PICK_S` — a world query is not cheap (the same shape as the
 * crate-candidate scan period of `parts/Loot`; the period itself is counted down by `Fsm`).
 *
 * There is no wire: `roam` is one more state of the existing `ally` snapshot, and every judgement runs on the
 * authority only.
 */
import * as THREE from 'three';
import {
  ALLY_FOLLOW_NEAR_M, ALLY_MOVE_ARRIVE_M, ALLY_ROAM_MIN_STEP_M, ALLY_ROAM_PAUSE_MAX_S, ALLY_ROAM_PAUSE_MIN_S,
  ALLY_ROAM_POI_RADIUS_M, ALLY_ROAM_POI_TAKEN_M, ALLY_WALK_SPEED, PLAYER_RADIUS,
} from '@/shared';
import type { AllySystem } from '../AllySystem';
import type { Ally } from './Body';
import { dist2D, forwardOf, yawToward } from '../model';
import * as Nav from './Nav';

/** The period for re-picking the point of interest (s) — a layout constant (as in `Loot`'s crate scan). */
const POI_PICK_S = 6;
/**
 * The smallest obstacle that counts as a point of interest (m) — not a balance number but the definition of
 * 「what is read as a terrain feature」.
 */
const POI_MIN_RADIUS_M = 1;
const POI_MIN_HEIGHT_M = 1.2;
/** It draws this many patrol-spot candidates; if they all fail it gives up for this frame and draws again next. */
const PICK_TRIES = 6;
/** When `resolveCollision` pushes further than this, the spot is inside a prop — no place to walk to (m). */
const BLOCKED_SLACK_M = 0.35;
/**
 * How far the point of interest has to have moved (m) before the path to it is dropped and re-picked — its own
 * threshold, because `refreshPoi` asks a different question from `walkable` (「is this the same point」, not
 * 「is this spot inside a prop」). Small, so a reservoir sample that landed on a neighbouring structure counts as a
 * change while the same one re-drawn does not.
 */
const POI_MOVED_M = 0.35;
/**
 * While it looks around, the look point sits this far in front of the body (m — `yawToward` reads XZ only, so
 * the distance itself changes no direction).
 */
const LOOK_DIST_M = 10;
/** How far the head turns in one go (rad), and the error inside which the turn counts as done (rad). */
const LOOK_TURN_MIN_RAD = 0.6;
const LOOK_TURN_MAX_RAD = 2.2;
const LOOK_DONE_RAD = 0.15;

/** Roam's own scratch — the caller may be using `model`'s shared scratch. */
const _r1 = new THREE.Vector3();
const _r2 = new THREE.Vector3();
const _r3 = new THREE.Vector3();
const _r4 = new THREE.Vector3();

export function onEnter(sys: AllySystem, a: Ally): void {
  a.hasRoamDest = false;
  a.roamPauseT = 0;
  a.roamPoiT = 0;                 // scans once the moment it enters
  a.lookAt = null;
  void sys;
}

export function onExit(sys: AllySystem, a: Ally): void {
  a.hasRoamDest = false;
  a.roamPauseT = 0;
  a.lookAt = null;
  void sys;
}

export function act(sys: AllySystem, a: Ally, dt: number): void {
  a.running = false;              // the search **walks** (running is only for getting back to the harness)
  if (!sys.leaderKnown) { Nav.halt(a); return; }
  refreshPoi(sys, a);
  // When the leader moves the whole harness slides with them — a destination left outside is dropped and re-picked.
  if (a.hasRoamDest && dist2D(a.roamDest, sys.leaderPos) > sys.harness) a.hasRoamDest = false;

  if (a.roamPauseT > 0) {
    a.roamPauseT -= dt;
    Nav.halt(a);
    lookAround(a, dt);
    return;
  }
  if (!a.hasRoamDest && !pickDest(sys, a)) {
    // No place to go (blocked on every side · the harness shrank right in) — rather than search the world
    // again every frame, it rests a beat and looks again.
    a.roamPauseT = ALLY_ROAM_PAUSE_MIN_S;
    Nav.halt(a);
    lookAround(a, dt);
    return;
  }

  a.lookAt = null;
  const left = Nav.step(sys, a, a.roamDest, ALLY_WALK_SPEED, dt);
  if (left > ALLY_MOVE_ARRIVE_M) return;
  // Arrived — each unit rests for its own random time (so three do not stand and leave on the same beat).
  a.hasRoamDest = false;
  a.roamPauseT = a.rand.range(ALLY_ROAM_PAUSE_MIN_S, ALLY_ROAM_PAUSE_MAX_S);
}

/* ── The point of interest ───────────────────────────────────────────────── */

function refreshPoi(sys: AllySystem, a: Ally): void {
  if (a.roamPoiT > 0) return;                    // the period is counted down by `parts/Fsm`
  a.roamPoiT = POI_PICK_S;
  const had = a.hasRoamPoi;
  _r4.copy(a.roamPoi);
  a.hasRoamPoi = pickPoi(sys, a);
  // It drops the path it was on only when the point of interest really changed (the same point keeps it circling).
  if (a.hasRoamPoi !== had || (a.hasRoamPoi && dist2D(_r4, a.roamPoi) > POI_MOVED_M)) a.hasRoamDest = false;
}

/** Picks an unclaimed terrain feature inside the harness into `a.roamPoi`. false with none (= random patrol). */
function pickPoi(sys: AllySystem, a: Ally): boolean {
  const world = sys.ctx.world;
  if (!world) return false;
  let seen = 0;
  // ① Structures · ruin sites — the first thing that is 「somewhere worth going」 for an android (world already
  //    holds both arrays, so they are free).
  for (const s of world.getStructures()) seen = consider(sys, a, s.position, seen);
  const ruins = world.getRuinSites?.();
  if (ruins) for (const r of ruins) seen = consider(sys, a, r.position, seen);
  if (seen > 0) return true;
  // ② With no structure, a large cover object — it looks behind a rock · wall. (`pickCoverSpot` is a formula
  //    that needs a **threat** to run, so it is no use here.)
  for (const o of world.getObstaclesNear(sys.leaderPos.x, sys.leaderPos.z, sys.harness)) {
    if (o.radius < POI_MIN_RADIUS_M || o.height < POI_MIN_HEIGHT_M) continue;
    seen = consider(sys, a, o.position, seen);
  }
  return seen > 0;
}

/**
 * Looks at one candidate spot — inside the harness and not taken, it goes into `a.roamPoi` as a **reservoir
 * sample** (the way to draw one evenly without building an array). Returns how many candidates have been seen.
 */
function consider(sys: AllySystem, a: Ally, p: THREE.Vector3, seen: number): number {
  if (dist2D(p, sys.leaderPos) > sys.harness) return seen;
  if (taken(sys, a, p)) return seen;
  const n = seen + 1;
  if (a.rand.next() < 1 / n) a.roamPoi.copy(p);
  return n;
}

/**
 * Is another squadmate · android within `ALLY_ROAM_POI_TAKEN_M` of that point, or has another unit already
 * marked that point.
 */
function taken(sys: AllySystem, a: Ally, p: THREE.Vector3): boolean {
  for (const o of sys.bodies) {
    if (o === a || o.dead || o.hidden || o.mode !== 'raid') continue;
    if (dist2D(o.position, p) < ALLY_ROAM_POI_TAKEN_M) return true;
    if (o.hasRoamPoi && dist2D(o.roamPoi, p) < ALLY_ROAM_POI_TAKEN_M) return true;
  }
  const ctx = sys.ctx;
  const me = ctx.player;
  if (me && !me.isDead && dist2D(me.position, p) < ALLY_ROAM_POI_TAKEN_M) return true;
  const net = ctx.net;
  if (net) {
    for (const rp of net.getRemotePlayers()) {
      if (rp.isDead) continue;
      if (dist2D(rp.position, p) < ALLY_ROAM_POI_TAKEN_M) return true;
    }
  }
  return false;
}

/* ── The patrol spot ─────────────────────────────────────────────────────── */

/**
 * Picks the next spot to walk to into `a.roamDest`. false when there is no spot worth taking.
 *
 * `ALLY_ROAM_MIN_STEP_M` is **a condition it tries first**, not an absolute one: standing in the middle of the
 * point of interest, no point inside the radius (`ALLY_ROAM_POI_RADIUS_M`) is that far away, so every candidate
 * fails and the body freezes there forever. So the **farthest** walkable candidate is kept aside and used as
 * the second best.
 */
function pickDest(sys: AllySystem, a: Ally): boolean {
  const center = a.hasRoamPoi ? a.roamPoi : sys.leaderPos;
  const radius = a.hasRoamPoi ? ALLY_ROAM_POI_RADIUS_M : sys.harness;
  let bestD = -1;
  for (let i = 0; i < PICK_TRIES; i++) {
    const ang = a.rand.next() * Math.PI * 2;
    const r = Math.sqrt(a.rand.next()) * radius;          // the √ is what spreads them evenly inside the circle
    _r1.set(center.x + Math.cos(ang) * r, center.y, center.z + Math.sin(ang) * r);
    Nav.clampToHarness(sys.leaderPos, sys.harness, _r1, _r2);
    if (dist2D(_r2, sys.leaderPos) < ALLY_FOLLOW_NEAR_M) continue;     // it never sticks to the squad leader
    if (!walkable(sys, a, _r2)) continue;
    const d = dist2D(_r2, a.position);
    if (d > bestD) { bestD = d; a.roamDest.copy(_r2); }
    if (d >= ALLY_ROAM_MIN_STEP_M) { a.hasRoamDest = true; return true; }   // not circling in place — this one it is
  }
  if (bestD <= ALLY_MOVE_ARRIVE_M) return false;          // not one spot far enough away to walk to
  a.hasRoamDest = true;
  return true;
}

/** Can it walk to this spot and stand — if so, `p` is rewritten to where it really stands (the ground height). */
function walkable(sys: AllySystem, a: Ally, p: THREE.Vector3): boolean {
  const world = sys.ctx.world;
  if (!world || !world.isInsideBounds(p.x, p.z)) return false;
  // Surface → collision order (CLAUDE.md §4.4 · the same as `Nav.step` — reversed, the top of a low ledge
  // reads as 「a blocked spot」 forever).
  p.y = world.getSurfaceY(p.x, p.z, a.position.y);
  _r3.copy(p);
  world.resolveCollision(_r3, PLAYER_RADIUS);
  if (dist2D(_r3, p) > BLOCKED_SLACK_M) return false;                  // inside a prop
  p.copy(_r3);
  p.y = world.getSurfaceY(p.x, p.z, a.position.y);
  return true;
}

/* ── Looking around ──────────────────────────────────────────────────────── */

/**
 * While it rests after arriving it **looks around** — turning its head slowly toward a plausible direction
 * reads far more like a person than freezing on the spot (user's decision). Once the turn is done it picks
 * the next direction.
 */
function lookAround(a: Ally, dt: number): void {
  if (!a.lookAt || turnDone(a)) pickLook(a);
  Nav.face(a, a.lookVec, dt);
}

function turnDone(a: Ally): boolean {
  const diff = yawToward(a.position, a.lookVec) - a.yaw;
  return Math.abs(Math.atan2(Math.sin(diff), Math.cos(diff))) < LOOK_DONE_RAD;
}

function pickLook(a: Ally): void {
  const turn = a.rand.range(LOOK_TURN_MIN_RAD, LOOK_TURN_MAX_RAD) * (a.rand.next() < 0.5 ? -1 : 1);
  forwardOf(a.yaw + turn, _r1);
  a.lookVec.set(a.position.x + _r1.x * LOOK_DIST_M, a.position.y, a.position.z + _r1.z * LOOK_DIST_M);
  a.lookAt = a.lookVec;
}
