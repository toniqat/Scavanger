/**
 * src/world/hull.ts — **convex prism** collider math (2026-09-11, `Obstacle.hull`).
 *
 * Why it exists: until 2026-09-10 a rock · spire · crystal was one circle (`Props.footprintOf` — the **average** of the
 * distances per compass direction). One circle over a long rock lets the body sink into the mesh along the long side
 * and blocks it in front of the visible rock along the short side. So the **convex outline of the mesh above ground**
 * is the collider. Movement · standing read one outline (`hull.points`), bullets · sight read per-height bands
 * (`hull.bands`) — so a bullet does not stop in mid-air beside a spire that narrows upwards.
 *
 * Conventions:
 *  - Vertices are world coordinates `[x0, z0, x1, z1, …]` and **counter-clockwise** (+X → +Z seen from above, signed
 *    area > 0). The outward normal of edge a→b is then `(dz, -dx)`.
 *  - Called **only when `o.hull` is set**. The cylinder · box paths are left inside `WorldSystem` as they were.
 *  - No per-frame allocation — the normal is solved on the spot (cheap, at most `HULL_MAX_VERTS` vertices).
 */
import type * as THREE from 'three';
import type { ObstacleHull } from '@/shared';

/** The most vertices one outline may hold. Past it, the vertex that loses the least area is dropped first. */
export const HULL_MAX_VERTS = 14;

/* ── Building ───────────────────────────────────────────────────────────────────────────────────────── */

let _idx = new Int32Array(256);
const _stack: number[] = [];

/**
 * 2026-09-11 (C-40): sorts the indices in (x, z) lexicographic order — the old `Array.prototype.sort(comparator)` was
 * a chunk of world generation on its own (up to 5 outlines per prop). The result is the same because monotone chain
 * reads **coordinates** only and points sharing one drop out at once on a zero cross product: any sort with the right
 * (x, z) order gives a hull that is not one bit different. Insertion sort on short runs, quicksort around the middle
 * value on long ones (an explicit stack instead of recursion).
 */
const _qs = new Int32Array(128);
function sortIdx(pts: Float32Array, idx: Int32Array, n: number): void {
  const less = (a: number, b: number): boolean => {
    const ax = pts[a * 2], bx = pts[b * 2];
    return ax < bx || (ax === bx && pts[a * 2 + 1] < pts[b * 2 + 1]);
  };
  let sp = 0;
  _qs[sp++] = 0; _qs[sp++] = n - 1;
  while (sp > 0) {
    const hi = _qs[--sp], lo = _qs[--sp];
    if (hi - lo < 16) {
      for (let i = lo + 1; i <= hi; i++) {
        const v = idx[i];
        let j = i - 1;
        while (j >= lo && less(v, idx[j])) { idx[j + 1] = idx[j]; j--; }
        idx[j + 1] = v;
      }
      continue;
    }
    const pivot = idx[(lo + hi) >> 1];
    let i = lo, j = hi;
    while (i <= j) {
      while (less(idx[i], pivot)) i++;
      while (less(pivot, idx[j])) j--;
      if (i <= j) { const t = idx[i]; idx[i] = idx[j]; idx[j] = t; i++; j--; }
    }
    // Push the larger side first to keep the stack depth at log n
    if (j - lo > hi - i) { if (lo < j) { _qs[sp++] = lo; _qs[sp++] = j; } if (i < hi) { _qs[sp++] = i; _qs[sp++] = hi; } }
    else { if (i < hi) { _qs[sp++] = i; _qs[sp++] = hi; } if (lo < j) { _qs[sp++] = lo; _qs[sp++] = j; } }
  }
}

/**
 * Builds a 2D convex hull from the xz pairs in `pts[0 .. n*2)` (monotone chain). A counter-clockwise `Float32Array`;
 * null with fewer than 3 points or zero area. Past `maxVerts` corners are shaved off (the collider moves that much
 * inside the mesh — it is never inflated outwards).
 */
export function convexHull2D(pts: Float32Array, n: number, maxVerts = HULL_MAX_VERTS): Float32Array | null {
  if (n < 3) return null;
  if (_idx.length < n) _idx = new Int32Array(Math.max(n, _idx.length * 2));
  for (let i = 0; i < n; i++) _idx[i] = i;
  sortIdx(pts, _idx, n);
  const cross = (o: number, a: number, b: number): number =>
    (pts[a * 2] - pts[o * 2]) * (pts[b * 2 + 1] - pts[o * 2 + 1]) - (pts[a * 2 + 1] - pts[o * 2 + 1]) * (pts[b * 2] - pts[o * 2]);
  _stack.length = 0;
  for (let k = 0; k < n; k++) {
    const i = _idx[k];
    while (_stack.length >= 2 && cross(_stack[_stack.length - 2], _stack[_stack.length - 1], i) <= 1e-9) _stack.pop();
    _stack.push(i);
  }
  const lowerLen = _stack.length + 1;
  for (let k = n - 2; k >= 0; k--) {
    const i = _idx[k];
    while (_stack.length >= lowerLen && cross(_stack[_stack.length - 2], _stack[_stack.length - 1], i) <= 1e-9) _stack.pop();
    _stack.push(i);
  }
  _stack.pop();                                   // last point = first point
  if (_stack.length < 3) return null;
  const xs: number[] = [], zs: number[] = [];
  for (const i of _stack) { xs.push(pts[i * 2]); zs.push(pts[i * 2 + 1]); }
  // Too many vertices — drop them starting with the one that loses the least area
  while (xs.length > Math.max(3, maxVerts)) {
    let bestI = 0, bestA = Infinity;
    const m = xs.length;
    for (let i = 0; i < m; i++) {
      const p = (i + m - 1) % m, q = (i + 1) % m;
      const a = Math.abs((xs[i] - xs[p]) * (zs[q] - zs[p]) - (zs[i] - zs[p]) * (xs[q] - xs[p]));
      if (a < bestA) { bestA = a; bestI = i; }
    }
    xs.splice(bestI, 1); zs.splice(bestI, 1);
  }
  const out = new Float32Array(xs.length * 2);
  let area = 0;
  for (let i = 0; i < xs.length; i++) {
    out[i * 2] = xs[i]; out[i * 2 + 1] = zs[i];
    const j = (i + 1) % xs.length;
    area += xs[i] * zs[j] - xs[j] * zs[i];
  }
  if (area <= 1e-6) return null;                  // monotone chain gives counter-clockwise — 0 means degenerate
  return out;
}

/** The longest distance from `(cx, cz)` to an outline (or band) vertex — the circle `Obstacle.radius` holds. */
export function hullRadiusFrom(hull: ObstacleHull, cx: number, cz: number): number {
  let r = 0;
  const scan = (p: Float32Array): void => {
    for (let i = 0; i < p.length; i += 2) {
      const d = Math.hypot(p[i] - cx, p[i + 1] - cz);
      if (d > r) r = d;
    }
  };
  scan(hull.points);
  if (hull.bands) for (const b of hull.bands) scan(b.points);
  return r;
}

/** An outline's area and centroid (for `obstacleCoverage`). */
export function hullAreaCentroid(p: Float32Array, out: { area: number; x: number; z: number }): void {
  let a2 = 0, cx = 0, cz = 0;
  const m = p.length / 2;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    const xi = p[i * 2], zi = p[i * 2 + 1], xj = p[j * 2], zj = p[j * 2 + 1];
    const c = xi * zj - xj * zi;
    a2 += c; cx += (xi + xj) * c; cz += (zi + zj) * c;
  }
  if (Math.abs(a2) < 1e-9) { out.area = 0; out.x = p[0]; out.z = p[1]; return; }
  out.area = a2 / 2;
  out.x = cx / (3 * a2);
  out.z = cz / (3 * a2);
}

/* ── Queries ────────────────────────────────────────────────────────────────────────────────────────── */

/** Is `(x, z)` inside the outline (with `margin` to spare)? */
export function hullContainsXZ(p: Float32Array, x: number, z: number, margin = 0): boolean {
  const m = p.length / 2;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    const ax = p[i * 2], az = p[i * 2 + 1];
    const dx = p[j * 2] - ax, dz = p[j * 2 + 1] - az;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1e-9) continue;
    if (((x - ax) * dz - (z - az) * dx) / len > margin) return false;
  }
  return true;
}

/**
 * Pushes a circle of `radius` out of the outline (`position` is fixed in place). false when they do not overlap.
 * A centre inside leaves by the **shallowest edge** (as in `obb.boxPushOut` — brushing a corner must not bounce it).
 */
export function hullPushOut(p: Float32Array, position: THREE.Vector3, radius: number): boolean {
  const m = p.length / 2;
  const px = position.x, pz = position.z;
  let sMax = -Infinity, nxMax = 0, nzMax = 0;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    const ax = p[i * 2], az = p[i * 2 + 1];
    const dx = p[j * 2] - ax, dz = p[j * 2 + 1] - az;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1e-9) continue;
    const nx = dz / len, nz = -dx / len;
    const s = (px - ax) * nx + (pz - az) * nz;
    if (s > sMax) { sMax = s; nxMax = nx; nzMax = nz; }
  }
  if (sMax >= radius) return false;               // Farther than radius outside an edge half-plane — cannot overlap
  if (sMax <= 0) {
    position.x += nxMax * (radius - sMax);
    position.z += nzMax * (radius - sMax);
    return true;
  }
  // Outside but close: find the exact nearest point on the outline (near a vertex it is farther than the half-plane)
  let best = Infinity, cx = px, cz = pz;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    const ax = p[i * 2], az = p[i * 2 + 1];
    const dx = p[j * 2] - ax, dz = p[j * 2 + 1] - az;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
    const qx = ax + dx * t, qz = az + dz * t;
    const d2 = (px - qx) * (px - qx) + (pz - qz) * (pz - qz);
    if (d2 < best) { best = d2; cx = qx; cz = qz; }
  }
  if (best >= radius * radius) return false;
  const d = Math.sqrt(best);
  if (d < 1e-6) { position.x += nxMax * radius; position.z += nzMax * radius; return true; }
  const push = radius - d;
  position.x += ((px - cx) / d) * push;
  position.z += ((pz - cz) / d) * push;
  return true;
}

/** The normal `rayHull` fills in (the caller reads it at once — never store it). */
export const hullHitNormal = { x: 0, y: 1, z: 0 };

/**
 * Ray vs one band of a convex prism (`[y0, y1]`). `t` on a hit, −1 otherwise. As with the cylinder · box, **an origin
 * already inside counts as a miss**. Cyrus–Beck: clip by every edge half-plane, keeping the largest entering `t` and
 * the smallest leaving `t`.
 */
export function rayHull(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  p: Float32Array, y0: number, y1: number, maxT: number,
): number {
  if (y1 <= y0) return -1;
  let tE = -Infinity, tL = Infinity;
  let enx = 0, eny = 0, enz = 0;
  const m = p.length / 2;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    const ax = p[i * 2], az = p[i * 2 + 1];
    const ex = p[j * 2] - ax, ez = p[j * 2 + 1] - az;
    const len = Math.sqrt(ex * ex + ez * ez);
    if (len < 1e-9) continue;
    const nx = ez / len, nz = -ex / len;
    const num = (ax - ox) * nx + (az - oz) * nz;
    const den = dx * nx + dz * nz;
    if (Math.abs(den) < 1e-9) { if (num < 0) return -1; continue; }
    const t = num / den;
    if (den < 0) { if (t > tE) { tE = t; enx = nx; eny = 0; enz = nz; } }
    else if (t < tL) tL = t;
    if (tE > tL) return -1;
  }
  if (Math.abs(dy) < 1e-9) {
    if (oy < y0 || oy > y1) return -1;
  } else {
    let t0 = (y0 - oy) / dy, t1 = (y1 - oy) / dy;
    let ny = -1;
    if (t0 > t1) { const t = t0; t0 = t1; t1 = t; ny = 1; }
    if (t0 > tE) { tE = t0; enx = 0; eny = ny; enz = 0; }
    if (t1 < tL) tL = t1;
  }
  if (tE > tL || tE < 0 || tE > maxT) return -1;
  hullHitNormal.x = enx; hullHitNormal.y = eny; hullHitNormal.z = enz;
  return tE;
}
