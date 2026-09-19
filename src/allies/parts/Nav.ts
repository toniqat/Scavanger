/**
 * src/allies/parts/Nav.ts — **walking**. This game has no pathfinding — it is the same steering + obstacle
 * avoidance the enemy AI runs (the same shape as `enemies/ai/Steering`, **implemented again**: another
 * folder's internals are never imported — CLAUDE.md §4.1).
 *
 * It keeps the world contract (CLAUDE.md §4.4):
 *  - the floor is `WorldRef.getSurfaceY(x, z, feetY)`, called **before `resolveCollision`** (reversed, it
 *    cannot step onto a low ledge).
 *  - inside a ship it uses `InteriorCollider.getFloorAt` · `resolveCollision`.
 *  - when it is stuck it sidesteps (`sideT`) — with no pathfinding that is the only way out.
 *
 * Three things fold into the steering: obstacle avoidance (`avoidObstacles`) · the separation between squad
 * bodies (`separate`) · the detour around a `주의` ping (`avoid`). All three are only **a component added to
 * the wanted direction**, so they never block the movement. A destination that approaches a person is spread
 * apart with `spreadToward`.
 */
import * as THREE from 'three';
import { ALLY_LOCAL_PEER, ALLY_SEPARATION_M, ALLY_SPREAD_M, ALLY_TURN_RATE, PLAYER_RADIUS } from '@/shared';
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
/** Staying in the same spot this long (s) counts as stuck, and it sidesteps. */
const STUCK_S = 0.8;
/** How long a sidestep lasts (s). */
const SIDE_S = 1.2;

/** Turns the body toward `target`. */
export function face(a: Ally, target: THREE.Vector3, dt: number): void {
  a.yaw = turnToward(a.yaw, yawToward(a.position, target), ALLY_TURN_RATE, dt);
}

/**
 * Walks one frame toward `target`. Returns the XZ distance left.
 * With `avoid` it never comes inside `avoidR` of that point (a `주의` ping).
 */
export function step(
  sys: AllySystem, a: Ally, target: THREE.Vector3, speed: number, dt: number,
  avoid?: THREE.Vector3 | null, avoidR = 0,
): number {
  const ctx = sys.ctx;
  const pos = a.position;
  const dx = target.x - pos.x, dz = target.z - pos.z;
  const dist = Math.hypot(dx, dz);
  if (dt <= 0) return dist;
  if (dist < 1e-4) { a.velocity.set(0, 0, 0); a.moveBlend = 0; return dist; }

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

  avoidObstacles(sys, a, _n1, dt);
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

  const moved = Math.hypot(_n2.x - pos.x, _n2.z - pos.z);
  a.velocity.set((_n2.x - pos.x) / dt, 0, (_n2.z - pos.z) / dt);
  pos.copy(_n2);

  // stuck detection
  if (moved < s * dt * 0.25) {
    a.stuckT += dt;
    if (a.stuckT > STUCK_S && a.sideT <= 0) {
      a.sideT = SIDE_S;
      a.sideSign = a.rand.next() < 0.5 ? -1 : 1;
      a.stuckT = 0;
    }
  } else a.stuckT = 0;

  face(a, target, dt);
  const v = a.velocity.length();
  a.moveBlend = Math.min(1, v / Math.max(0.1, speed));
  a.stridePhase = (a.stridePhase + v * dt) % 1;
  return Math.hypot(target.x - pos.x, target.z - pos.z);
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
 * three places that carry it grep as one (here · `data/constants.csv` `ALLY_SEPARATION_M` · `docs/DECISIONS.md`):
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
