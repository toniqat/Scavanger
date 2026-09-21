/**
 * src/allies/parts/Nav.ts — **walking**. Steering + obstacle avoidance, the same shape the enemy AI runs
 * (`enemies/ai/Steering`, **implemented again**: another folder's internals are never imported — CLAUDE.md §4.1),
 * and since 2026-09-21 (TODO A-18) **a way round a wall**: when the straight line to the destination is not walkable
 * on the raid's nav graph (`WorldRef.nav`), `route` plans a path and the steering aims at its next waypoint instead.
 * The steering itself is unchanged — the path only moves the point it aims at — and whenever the graph has no answer
 * (not baked yet, inside a ship, nothing found) it aims at the destination exactly as before. A ladder on the path is
 * climbed (`tickClimb`): atomic, `Fsm.update` hands it the whole frame until the body is off the ladder again.
 *
 * It keeps the world contract (CLAUDE.md §4.4):
 *  - the floor is `WorldRef.getSurfaceY(x, z, feetY)`, called **before `resolveCollision`** (reversed, it
 *    cannot step onto a low ledge).
 *  - inside a ship it uses `InteriorCollider.getFloorAt` · `resolveCollision`.
 *  - when it is stuck it sidesteps (`sideT`) and plans again (`navReplan`).
 *
 * Three things fold into the steering: obstacle avoidance (`avoidObstacles`) · the separation between squad
 * bodies (`separate`) · the detour around a `주의` ping (`avoid`). All three are only **a component added to
 * the wanted direction**, so they never block the movement. A destination that approaches a person is spread
 * apart with `spreadToward`.
 */
import * as THREE from 'three';
import {
  ALLY_LOCAL_PEER, ALLY_NAV_GOAL_MOVE_M, ALLY_NAV_REPLAN_S, ALLY_NAV_WAYPOINT_M, ALLY_SEPARATION_M, ALLY_SPREAD_M,
  ALLY_TURN_RATE, ALLY_WALK_SPEED, LADDER_CLIMB_SPEED, NAV_CAN, NAV_CAN_PERSON, PLAYER_RADIUS,
  type LadderDef, type NavRef,
} from '@/shared';
import type { AllySystem } from '../AllySystem';
import type { Ally } from './Body';
import { turnToward, yawToward } from '../model';

/**
 * Nav's own scratch — the caller passes its destination in `model`'s shared scratch, so using that one here
 * would overwrite it.
 */
const _n1 = new THREE.Vector3();
const _n2 = new THREE.Vector3();
const _n3 = new THREE.Vector3();

/** How often nearby obstacles are fetched again (s) — `getObstaclesNear` every frame keeps making arrays. */
const OBS_REFRESH_S = 0.35;
/**
 * The **forward query window** (m) the avoidance fetches obstacles inside. Not a balance number and not the
 * avoidance distance either — `avoidObstacles` reacts out to `o.radius + PLAYER_RADIUS + 0.4 + 2.5`, which for a
 * wide prop is further than this; the window only has to hold everything worth looking at between two refreshes
 * (`OBS_REFRESH_S` at `ALLY_RUN_SPEED`).
 */
const OBS_QUERY_M = 6;
/** The stuck window (s): covering under a quarter of the asked travel within it counts as stuck, and it sidesteps. */
const STUCK_S = 0.8;
/** How long a sidestep lasts (s). */
const SIDE_S = 1.2;
/**
 * A destination this far (m) above · below counts toward the distance `step` returns — a crate on floor 2 is not
 * reached by standing under it on floor 1. Under one storey (~3 m), over a stair step and a crate lid.
 */
const FLOOR_DY = 2;

/** Turns the body toward `target`. */
export function face(a: Ally, target: THREE.Vector3, dt: number): void {
  a.yaw = turnToward(a.yaw, yawToward(a.position, target), ALLY_TURN_RATE, dt);
}

/**
 * Walks one frame toward `target` — round a wall when the nav graph says the straight line is blocked (`route`).
 * Returns the distance left (XZ, plus the part of a floor difference beyond `FLOOR_DY` — `left`).
 * With `avoid` it never comes inside `avoidR` of that point (a `주의` ping).
 */
export function step(
  sys: AllySystem, a: Ally, target: THREE.Vector3, speed: number, dt: number,
  avoid?: THREE.Vector3 | null, avoidR = 0,
): number {
  const ctx = sys.ctx;
  const pos = a.position;
  if (dt <= 0) return left(a, target);
  // The point the steering aims at: the next waypoint of a path round a wall, or the destination itself.
  const aim = route(sys, a, target, dt);
  if (a.climb) { halt(a); return left(a, target); }   // the path reached a ladder — `tickClimb` owns the next frames
  const dx = aim.x - pos.x, dz = aim.z - pos.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-4) { a.velocity.set(0, 0, 0); a.moveBlend = 0; return left(a, target); }

  // the wanted direction
  _n1.set(dx / dist, 0, dz / dist);

  // the `주의` ping: it swings wide around that spot
  if (avoid && avoidR > 0) {
    const ax = pos.x - avoid.x, az = pos.z - avoid.z;
    const ad = Math.hypot(ax, az);
    if (ad < avoidR && ad > 1e-4) {
      const push = (avoidR - ad) / avoidR;
      _n1.x += (ax / ad) * push * 2;
      _n1.z += (az / ad) * push * 2;
    }
  }

  // The graph's answer already accounts for every collider (`Ally.navSteer`); only without one does the old circle
  // avoidance steer.
  if (!a.navSteer) avoidObstacles(sys, a, _n1, dt);
  separate(sys, a, _n1, target);

  if (a.sideT > 0) {
    a.sideT -= dt;
    // The sidestep: right/left of the heading (forward = (x, z), whose perpendicular is (z, −x)). Both
    // components have to be read together — overwriting x first and computing z from it squashes the
    // direction instead of rotating it.
    const fx = _n1.x, fz = _n1.z;
    _n1.x = fx + fz * a.sideSign;
    _n1.z = fz - fx * a.sideSign;
  }
  if (_n1.lengthSq() < 1e-8) _n1.set(dx / dist, 0, dz / dist);
  _n1.y = 0;
  _n1.normalize();

  const s = Math.min(speed, dist / dt);
  const nx = pos.x + _n1.x * s * dt;
  const nz = pos.z + _n1.z * s * dt;

  // surface → collision order (reversed, it cannot get over a low ledge)
  const interior = ctx.player?.interior ?? null;
  if (interior) {
    _n2.set(nx, interior.getFloorAt(nx, nz), nz);
    interior.resolveCollision(_n2, PLAYER_RADIUS);
    _n2.y = interior.getFloorAt(_n2.x, _n2.z);
  } else if (ctx.world) {
    _n2.set(nx, ctx.world.getSurfaceY(nx, nz, pos.y), nz);
    ctx.world.resolveCollision(_n2, PLAYER_RADIUS);
    _n2.y = ctx.world.getSurfaceY(_n2.x, _n2.z, pos.y);
  } else {
    _n2.set(nx, pos.y, nz);
  }

  a.velocity.set((_n2.x - pos.x) / dt, 0, (_n2.z - pos.z) / dt);
  pos.copy(_n2);

  // Stuck detection — judged on the **net** displacement over a `STUCK_S` window, never per frame. Pressed into a
  // wall, avoidance and `resolveCollision` flip the step back and forth every frame: each frame moves a full step,
  // so a per-frame test read it as walking and the sidestep never fired (TODO E-14 — the body shook 2.3 m from a
  // pinged item for the rest of the raid). A body that slides along a wall still gets far from the anchor and is
  // not stuck; one that arrives asks for less travel (`s` shrinks) and is not stuck either.
  a.stuckT += dt;
  a.stuckWant += s * dt;
  if (a.stuckT >= STUCK_S) {
    const net = Math.hypot(pos.x - a.stuckFrom.x, pos.z - a.stuckFrom.z);
    if (net < a.stuckWant * 0.25 && a.sideT <= 0) {
      a.sideT = SIDE_S;
      a.sideSign = a.rand.next() < 0.5 ? -1 : 1;
      a.navReplan = true;
    }
    a.stuckFrom.copy(pos);
    a.stuckT = 0;
    a.stuckWant = 0;
  }

  face(a, aim, dt);
  const v = a.velocity.length();
  a.moveBlend = Math.min(1, v / Math.max(0.1, speed));
  a.stridePhase = (a.stridePhase + v * dt) % 1;
  return left(a, target);
}

/** The distance `step` reports: XZ, plus how far the destination is off this floor beyond `FLOOR_DY`. */
function left(a: Ally, target: THREE.Vector3): number {
  const dy = Math.abs(target.y - a.position.y);
  const xz = Math.hypot(target.x - a.position.x, target.z - a.position.z);
  return dy > FLOOR_DY ? xz + dy - FLOOR_DY : xz;
}

/**
 * The distance still to walk to `target` — along the path being followed when there is one, so a body that walks
 * away from a crate to reach the building's door is making progress, not stalling (`Loot.stalled`).
 */
export function routeLeft(a: Ally, target: THREE.Vector3): number {
  const path = a.navPath;
  if (!a.navHas || !path) return left(a, target);
  let d = 0, px = a.position.x, py = a.position.y, pz = a.position.z;
  for (let i = a.navIdx; i < path.count; i++) {
    const w = path.points[i].position;
    d += Math.hypot(w.x - px, w.z - pz) + Math.abs(w.y - py);
    px = w.x; py = w.y; pz = w.z;
  }
  return d + Math.hypot(target.x - px, target.z - pz);
}

/* ── the way round (TODO A-18) ───────────────────────────────────────────── */

/**
 * The point to steer at this frame. Plans when the destination wandered off (`ALLY_NAV_GOAL_MOVE_M`), when the replan
 * period ran out (`ALLY_NAV_REPLAN_S`) or when the body got stuck; a destination the straight line reaches keeps no
 * path at all. A waypoint is passed within `ALLY_NAV_WAYPOINT_M`; a ladder waypoint starts the climb.
 */
function route(sys: AllySystem, a: Ally, target: THREE.Vector3, dt: number): THREE.Vector3 {
  const ctx = sys.ctx;
  const nav = ctx.world?.nav ?? null;
  if (!nav || !nav.ready || ctx.player?.interior) { a.navHas = false; a.navSteer = false; return target; }
  a.navT -= dt;
  const gx = target.x - a.navGoal.x, gy = target.y - a.navGoal.y, gz = target.z - a.navGoal.z;
  if (a.navT <= 0 || a.navReplan || gx * gx + gy * gy + gz * gz > ALLY_NAV_GOAL_MOVE_M * ALLY_NAV_GOAL_MOVE_M) plan(a, nav, target);
  const path = a.navPath;
  if (!a.navHas || !path) return target;
  while (a.navIdx < path.count) {
    const w = path.points[a.navIdx];
    if (w.kind === 'ladder') {
      const L = w.ladderId ? ctx.world?.getLadders().find((l) => l.id === w.ladderId) ?? null : null;
      if (!L) { a.navHas = false; return target; }
      a.navIdx++;
      beginClimb(a, L, w.position.y > a.position.y);
      return w.position;
    }
    const dx = w.position.x - a.position.x, dz = w.position.z - a.position.z;
    if (dx * dx + dz * dz > ALLY_NAV_WAYPOINT_M * ALLY_NAV_WAYPOINT_M || Math.abs(w.position.y - a.position.y) > FLOOR_DY) return w.position;
    a.navIdx++;
  }
  // Past the last waypoint (the snapped goal — maybe the floor in front of a crate): the last stretch is straight.
  a.navHas = false;
  return target;
}

function plan(a: Ally, nav: NavRef, target: THREE.Vector3): void {
  a.navT = ALLY_NAV_REPLAN_S;
  a.navReplan = false;
  a.navGoal.copy(target);
  if (nav.walkable(a.position, target)) { a.navHas = false; a.navSteer = true; return; }
  const path = a.navPath ?? (a.navPath = nav.createPath());
  // Carrying a person it takes no ladder — the body on its shoulder does not go up rung by rung.
  const st = nav.findPath(a.position, target, a.carrying ? NAV_CAN.INDOOR : NAV_CAN_PERSON, path);
  // `none` (proven unreachable) and `pending` leave the old straight steering in charge.
  a.navHas = (st === 'ok' || st === 'partial') && path.count > 0;
  a.navSteer = a.navHas;
  a.navIdx = 0;
}

/* ── ladders ─────────────────────────────────────────────────────────────── */

function beginClimb(a: Ally, L: LadderDef, up: boolean): void {
  a.climb = L;
  a.climbUp = up;
  a.climbPhase = 0;
  halt(a);
}

/**
 * One frame on a ladder (`Fsm.update` calls it instead of the state's act while `a.climb` is set). Going up: over the
 * foot → up to `topY` → across to `exit`. Going down: across to over the hatch (the foot's XZ at roof height) → down to
 * the floor. The horizontal moves are the body's own reach over a rung and ignore colliders — the same snap a
 * person's grab makes (`player/parts/Climb`).
 */
export function tickClimb(sys: AllySystem, a: Ally, dt: number): void {
  const L = a.climb;
  if (!L) return;
  const p = a.position;
  a.moveBlend = 0;
  a.yaw = yawToward(p, _n3.set(p.x - L.normal.x, p.y, p.z - L.normal.z));
  if (a.climbPhase === 0) {
    if (moveXZ(p, L.base.x, L.base.z, ALLY_WALK_SPEED * dt)) a.climbPhase = 1;
    a.velocity.set(0, 0, 0);
    return;
  }
  if (a.climbPhase === 1) {
    const ty = a.climbUp ? L.topY : L.base.y;
    const stepY = LADDER_CLIMB_SPEED * dt;
    const dy = ty - p.y;
    if (Math.abs(dy) <= stepY) { p.y = ty; a.climbPhase = 2; a.velocity.set(0, 0, 0); return; }
    p.y += Math.sign(dy) * stepY;
    a.velocity.set(0, Math.sign(dy) * LADDER_CLIMB_SPEED, 0);
    return;
  }
  if (a.climbUp && !moveXZ(p, L.exit.x, L.exit.z, ALLY_WALK_SPEED * dt)) return;
  endClimb(sys, a);
}

/** Off the ladder where it is (downed · death · a teleport): it falls to whatever floor is below. */
export function dropClimb(sys: AllySystem, a: Ally): void {
  if (!a.climb) return;
  endClimb(sys, a);
  a.navHas = false;
}

function endClimb(sys: AllySystem, a: Ally): void {
  a.climb = null;
  a.climbPhase = 0;
  a.velocity.set(0, 0, 0);
  snapToGround(sys, a);
  a.stuckFrom.copy(a.position);
  a.stuckT = 0;
  a.stuckWant = 0;
}

/** Moves `p` toward `(x, z)` by at most `step`; true once there. */
function moveXZ(p: THREE.Vector3, x: number, z: number, step: number): boolean {
  const dx = x - p.x, dz = z - p.z;
  const d = Math.hypot(dx, dz);
  if (d <= step) { p.x = x; p.z = z; return true; }
  p.x += (dx / d) * step;
  p.z += (dz / d) * step;
  return false;
}

/** In place — velocity · the movement blend to 0 (called every frame it stands still). */
export function halt(a: Ally): void {
  a.velocity.set(0, 0, 0);
  a.moveBlend = 0;
}

/** Sticks it back onto the ground (after a drop-pod landing · a teleport). */
export function snapToGround(sys: AllySystem, a: Ally): void {
  const ctx = sys.ctx;
  const interior = ctx.player?.interior ?? null;
  if (interior) a.position.y = interior.getFloorAt(a.position.x, a.position.z);
  else if (ctx.world) a.position.y = ctx.world.getSurfaceY(a.position.x, a.position.z, a.position.y + 1);
}

function avoidObstacles(sys: AllySystem, a: Ally, dir: THREE.Vector3, dt: number): void {
  const world = sys.ctx.world;
  if (!world) return;
  a.obsT -= dt;
  if (a.obsT <= 0) {
    a.obsT = OBS_REFRESH_S;
    a.nearObs = world.getObstaclesNear(a.position.x, a.position.z, OBS_QUERY_M);
  }
  const pos = a.position;
  for (const o of a.nearObs) {
    _n3.set(o.position.x - pos.x, 0, o.position.z - pos.z);
    const d = _n3.length();
    const clearance = o.radius + PLAYER_RADIUS + 0.4;
    if (d < 1e-4 || d > clearance + 2.5) continue;
    const ahead = (_n3.x * dir.x + _n3.z * dir.z) / d;
    if (ahead < 0.2) continue;
    const side = dir.z * _n3.x - dir.x * _n3.z;
    if (Math.abs(side) > clearance) continue;
    const strength = (1 - d / (clearance + 2.5)) * ahead;
    const sgn = side >= 0 ? -1 : 1;
    const fx = dir.x, fz = dir.z;
    dir.x = fx + fz * sgn * strength;
    dir.z = fz - fx * sgn * strength;
  }
}

/**
 * Squad bodies step aside so they **do not overlap**. The 2026-09-16 user's decision, kept on **one line** so the
 * three places that carry it grep as one (here · `data/constants.csv` `ALLY_SEPARATION_M` · `src/allies/README.md` Decisions):
 * 「2 m 이내에 겹치지 않도록 피해서 가기, 부득이 겹칠 경우 갈 수 있음」.
 * It is **the same shape of soft push** as `avoidObstacles` — it only adds to the
 * wanted direction and neither stops nor blocks: a hard block leaves two bodies tangled in a doorway forever.
 *
 * Left out of the push: itself · a dead or hidden body · **the person it is carrying** · **whoever stands on
 * the destination it is walking to**. The last one is the point — it walks right up to a downed PC it is
 * getting up, a person it hands an item to, a person in front of a crate, with no push at all.
 */
function separate(sys: AllySystem, a: Ally, dir: THREE.Vector3, target: THREE.Vector3): void {
  const ctx = sys.ctx;
  for (const o of sys.bodies) {
    if (o === a || o.dead || o.hidden || o.mode !== 'raid') continue;
    pushApart(a.position, dir, target, o.position);
  }
  const me = ctx.player;
  const net = ctx.net;
  const localId = net?.localId ?? ALLY_LOCAL_PEER;
  if (me && !me.isDead && a.carrying !== localId) pushApart(a.position, dir, target, me.position);
  if (!net) return;
  for (const rp of net.getRemotePlayers()) {
    // The coordinates of a body being carried mean nothing (the contract's `RemotePlayerRef.isCarried`).
    if (rp.isDead || rp.isCarried || a.carrying === rp.id) continue;
    pushApart(a.position, dir, target, rp.position);
  }
}

/**
 * Adds to `dir` the component that moves away from one other body (stronger the closer it is, at most 1 — it
 * cannot flip the wanted direction).
 */
function pushApart(pos: THREE.Vector3, dir: THREE.Vector3, target: THREE.Vector3, other: THREE.Vector3): void {
  // Whoever stands on the destination is the one it means to reach. Pushed away, it never gets there.
  if (Math.hypot(target.x - other.x, target.z - other.z) < ALLY_SEPARATION_M) return;
  const dx = pos.x - other.x, dz = pos.z - other.z;
  const d = Math.hypot(dx, dz);
  if (d >= ALLY_SEPARATION_M || d < 1e-4) return;
  const w = (ALLY_SEPARATION_M - d) / ALLY_SEPARATION_M;
  dir.x += (dx / d) * w;
  dir.z += (dz / d) * w;
}

/**
 * The **spread destination** for approaching a person — aimed straight at the person's spot, three units come
 * in one line (2026-09-16 user's decision 「PC 를 향해 갈 때 산개」). The contract: along the perpendicular of
 * the heading `(dz, −dx)`, bay 0 = one lane left · bay 1 = one lane right · bay 2 = two lanes left …
 * alternating at `ALLY_SPREAD_M` steps (the bay is the cockpit bay, so it does not change for the whole raid).
 * It never steps further aside than the distance left — that stops a wide swing right in front of the person.
 */
export function spreadToward(a: Ally, person: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const dx = person.x - a.position.x, dz = person.z - a.position.z;
  const d = Math.hypot(dx, dz);
  if (d < 1e-4) return out.copy(person);
  const k = a.bay;
  const lane = (Math.floor(k / 2) + 1) * (k % 2 === 0 ? -1 : 1);
  const off = Math.min(Math.abs(lane) * ALLY_SPREAD_M, d) * Math.sign(lane);
  return out.set(person.x + (dz / d) * off, person.y, person.z - (dx / d) * off);
}

/** A point inside the harness — writes into `out` the spot closest to `want` within `radius` of `center`. */
export function clampToHarness(center: THREE.Vector3, radius: number, want: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const dx = want.x - center.x, dz = want.z - center.z;
  const d = Math.hypot(dx, dz);
  if (d <= radius || d < 1e-4) return out.copy(want);
  return out.set(center.x + (dx / d) * radius, want.y, center.z + (dz / d) * radius);
}
