/**
 * src/world/obb.ts — **box (OBB) collider** math (2026-09-09).
 *
 * Why it exists: building walls · a tram body cannot be faked with cylinders. Ten cylinders for one wall (the old
 * `Outposts`) make a saw edge thicker than the drawn plate, and one cylinder around it blocks the whole room. So
 * `Obstacle.box` (the contract, 2026-09-09) is solved differently in exactly three places — **push-out · ray · top-face
 * judgement**. `SpatialHash` bucketing and broad queries still use `radius` (`boxRadius()`, the circumscribed circle),
 * so a box never leaks out of its bucket.
 *
 * ⚠ The functions here are called **only when `o.box` is set**. The cylinder prop path is left inside `WorldSystem`
 * exactly as it was and is not one line different from before 2026-09-09.
 */
import type * as THREE from 'three';
import { BOX_HEADROOM as SHARED_BOX_HEADROOM, type Obstacle } from '@/shared';

/**
 * A box collider **may float** (basement ceiling slab · tram deck · platform deck). A plate floating more than this (m)
 * over the head is not pushed out — the judgement that keeps a body in a basement from being shoved into a wall by the
 * ceiling. Cylinders have no such judgement (they all rise from the ground, so it would never fire, and turning it on
 * would change existing behaviour).
 */
export const BOX_HEADROOM = SHARED_BOX_HEADROOM;   // 2026-09-11: the value is in `data/constants.csv` — the same one as player's ceiling clamp

/** The circumscribed circle radius around a box — the value `Obstacle.radius` has to hold. */
export function boxRadius(halfX: number, halfZ: number): number {
  return Math.hypot(halfX, halfZ);
}

/** World XZ → box-local XZ (rotated back by `yaw`). The result is written into `outLocal`. */
function toLocal(o: Obstacle, x: number, z: number, outLocal: { x: number; z: number }): void {
  const b = o.box!;
  const dx = x - o.position.x, dz = z - o.position.z;
  const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
  outLocal.x = dx * c + dz * s;
  outLocal.z = -dx * s + dz * c;
}

/* Scratch so the hot path allocates nothing per frame (world generation / queries are single-threaded). */
const L = { x: 0, z: 0 };

/**
 * Is `(x, z)` inside the box cross-section (with `margin` to spare)? `getSurfaceY` · `getStandingObstacle` have to
 * read this instead of the circumscribed circle, or a body stands on thin air just past a wall corner.
 */
export function boxContainsXZ(o: Obstacle, x: number, z: number, margin = 0): boolean {
  const b = o.box!;
  toLocal(o, x, z, L);
  return Math.abs(L.x) <= b.halfX + margin && Math.abs(L.z) <= b.halfZ + margin;
}

/**
 * Pushes a circle of `radius` out of the box (`position` is fixed in place). false when they do not overlap.
 * A centre **inside** the box leaves by the shallowest face — brushing past a door frame must not bounce it sideways.
 */
export function boxPushOut(o: Obstacle, position: THREE.Vector3, radius: number): boolean {
  const b = o.box!;
  toLocal(o, position.x, position.z, L);
  const lx = L.x, lz = L.z;
  const qx = lx < -b.halfX ? -b.halfX : lx > b.halfX ? b.halfX : lx;
  const qz = lz < -b.halfZ ? -b.halfZ : lz > b.halfZ ? b.halfZ : lz;
  let ux = lx - qx, uz = lz - qz;
  const d2 = ux * ux + uz * uz;
  if (d2 > radius * radius) return false;
  if (d2 > 1e-8) {
    const d = Math.sqrt(d2);
    const push = radius - d;
    ux = (ux / d) * push;
    uz = (uz / d) * push;
  } else {
    // Centre inside the box — out through the nearest face
    const penX = b.halfX - Math.abs(lx);
    const penZ = b.halfZ - Math.abs(lz);
    if (penX <= penZ) { ux = (lx >= 0 ? 1 : -1) * (penX + radius); uz = 0; }
    else { ux = 0; uz = (lz >= 0 ? 1 : -1) * (penZ + radius); }
  }
  const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
  position.x += ux * c - uz * s;
  position.z += ux * s + uz * c;
  return true;
}

/** The normal `rayBox` fills in (the caller reads and uses it at once — never store it). */
export const boxHitNormal = { x: 0, y: 1, z: 0 };

/**
 * Ray vs box (y is the `[position.y, position.y + height]` slab). `t` on a hit, −1 otherwise.
 * The normal goes into `boxHitNormal`. Same convention as the cylinder: **an origin already inside counts as a miss**
 * (so a muzzle buried in a wall does not hit its own wall).
 */
export function rayBox(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  o: Obstacle, maxT: number,
): number {
  const b = o.box!;
  const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
  const rx = ox - o.position.x, rz = oz - o.position.z;
  const lox = rx * c + rz * s, loz = -rx * s + rz * c;
  const ldx = dx * c + dz * s, ldz = -dx * s + dz * c;
  const base = o.position.y, top = o.position.y + o.height;
  if (top <= base) return -1;

  let tmin = -Infinity, tmax = Infinity;
  let axis = 0, sign = 1;                       // 0 = X, 1 = Y, 2 = Z (local axes)

  // X slab
  if (Math.abs(ldx) < 1e-8) { if (lox < -b.halfX || lox > b.halfX) return -1; }
  else {
    let t0 = (-b.halfX - lox) / ldx, t1 = (b.halfX - lox) / ldx;
    let sg = -1;
    if (t0 > t1) { const t = t0; t0 = t1; t1 = t; sg = 1; }
    if (t0 > tmin) { tmin = t0; axis = 0; sign = sg; }
    if (t1 < tmax) tmax = t1;
  }
  // Z slab
  if (Math.abs(ldz) < 1e-8) { if (loz < -b.halfZ || loz > b.halfZ) return -1; }
  else {
    let t0 = (-b.halfZ - loz) / ldz, t1 = (b.halfZ - loz) / ldz;
    let sg = -1;
    if (t0 > t1) { const t = t0; t0 = t1; t1 = t; sg = 1; }
    if (t0 > tmin) { tmin = t0; axis = 2; sign = sg; }
    if (t1 < tmax) tmax = t1;
  }
  // Y slab (does not rotate)
  if (Math.abs(dy) < 1e-8) { if (oy < base || oy > top) return -1; }
  else {
    let t0 = (base - oy) / dy, t1 = (top - oy) / dy;
    let sg = -1;
    if (t0 > t1) { const t = t0; t0 = t1; t1 = t; sg = 1; }
    if (t0 > tmin) { tmin = t0; axis = 1; sign = sg; }
    if (t1 < tmax) tmax = t1;
  }

  if (tmin > tmax || tmin < 0 || tmin > maxT) return -1;
  if (axis === 1) { boxHitNormal.x = 0; boxHitNormal.y = sign; boxHitNormal.z = 0; }
  else {
    const nx = axis === 0 ? sign : 0, nz = axis === 2 ? sign : 0;
    boxHitNormal.x = nx * c - nz * s;
    boxHitNormal.y = 0;
    boxHitNormal.z = nx * s + nz * c;
  }
  return tmin;
}

/* ── Ramp floor plate (2026-09-11, `Obstacle.ramp`) ──────────────────────────────────────────────────────
 * A staircase's collider. **What is drawn is steps, what is walked on is a slope**, so a foot does not pop up at every
 * step (user's request "계단을 뚝뚝 끊기지 않고 스르륵"). The same OBB as a box (`o.box`), with only the top face
 * tilted along local +X: `position.y + height - rise` at `x = -halfX`, `position.y + height` at `x = +halfX`.
 * ⚠ Called only when `o.ramp` is set — the flat-box paths (`rayBox` · `boxPushOut`) did not change by one line. */

/** The slope height at `(x, z)`. Outside the box cross-section it is the nearest edge (clamped on local X). */
export function rampTopAt(o: Obstacle, x: number, z: number): number {
  const b = o.box!, r = o.ramp!;
  toLocal(o, x, z, L);
  const lx = L.x < -b.halfX ? -b.halfX : L.x > b.halfX ? b.halfX : L.x;
  const t = b.halfX > 1e-6 ? (lx + b.halfX) / (2 * b.halfX) : 1;
  return o.position.y + o.height - r.rise + r.rise * t;
}

/* Six local half-spaces: ±X · ±Z · bottom face · tilted top face. `n·p <= d` is inside. */
const RP_N = new Float32Array(18);
const RP_D = new Float32Array(6);

/**
 * Ray vs ramp floor plate (a wedge). `t` on a hit, −1 otherwise. The normal goes into `boxHitNormal` (where `rayBox`
 * puts it). An origin already inside gives −1 — the same convention as every other collider.
 */
export function rayRamp(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  o: Obstacle, maxT: number,
): number {
  const b = o.box!, r = o.ramp!;
  const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
  const rx = ox - o.position.x, rz = oz - o.position.z;
  const lox = rx * c + rz * s, loz = -rx * s + rz * c;
  const ldx = dx * c + dz * s, ldz = -dx * s + dz * c;
  const base = o.position.y;
  const k = b.halfX > 1e-6 ? r.rise / (2 * b.halfX) : 0;
  const cTop = base + o.height - r.rise / 2;
  RP_N[0] = 1; RP_N[1] = 0; RP_N[2] = 0;
  RP_N[3] = -1; RP_N[4] = 0; RP_N[5] = 0;
  RP_N[6] = 0; RP_N[7] = 0; RP_N[8] = 1;
  RP_N[9] = 0; RP_N[10] = 0; RP_N[11] = -1;
  RP_N[12] = 0; RP_N[13] = -1; RP_N[14] = 0;
  RP_N[15] = -k; RP_N[16] = 1; RP_N[17] = 0;
  RP_D[0] = b.halfX; RP_D[1] = b.halfX; RP_D[2] = b.halfZ; RP_D[3] = b.halfZ; RP_D[4] = -base; RP_D[5] = cTop;
  let tE = -Infinity, tL = Infinity, hit = -1;
  for (let i = 0; i < 6; i++) {
    const nx = RP_N[i * 3], ny = RP_N[i * 3 + 1], nz = RP_N[i * 3 + 2];
    const num = RP_D[i] - (nx * lox + ny * oy + nz * loz);
    const den = nx * ldx + ny * dy + nz * ldz;
    if (Math.abs(den) < 1e-9) { if (num < 0) return -1; continue; }
    const t = num / den;
    if (den < 0) { if (t > tE) { tE = t; hit = i; } }
    else if (t < tL) tL = t;
    if (tE > tL) return -1;
  }
  if (hit < 0 || tE < 0 || tE > maxT) return -1;
  const nx = RP_N[hit * 3], ny = RP_N[hit * 3 + 1], nz = RP_N[hit * 3 + 2];
  const len = Math.hypot(nx, ny, nz) || 1;
  boxHitNormal.x = (nx * c - nz * s) / len;
  boxHitNormal.y = ny / len;
  boxHitNormal.z = (nx * s + nz * c) / len;
  return tE;
}
