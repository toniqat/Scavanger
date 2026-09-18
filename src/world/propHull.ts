/**
 * src/world/propHull.ts — measures one prop instance's **convex collider** from the drawn mesh (2026-09-11).
 *
 * Successor to `Props.footprintOf` (2026-09-10), which built one circle from the **average distance per compass
 * direction** of the outline above ground; that circle sank into the mesh along a long rock's long side and blocked in
 * front of the visible rock along its short side. The same points (vertices above ground + where a triangle edge breaks
 * through the terrain) now build a **convex hull** (`hull.ts`).
 *
 * Two outlines are built:
 *  - **The movement · standing outline** (`hull.points`): from the ground up to `MOVE_CAP_M` — only the height a body
 *    actually touches. A crystal shard reaching over the head must not raise an invisible wall on the ground.
 *  - **Bullet bands** (`hull.bands`): the visible height split into bands of roughly `BAND_M`, one outline each — a
 *    bullet does not stop in mid-air beside a spire that narrows upwards. A low prop is one band and gets no `bands`
 *    (the movement outline is used as it is).
 *
 * Buried with nothing above ground → null, no collider is built (what is not visible does not block).
 */
import type * as THREE from 'three';
import { PLAYER_HEIGHT, type ObstacleHull, type ObstacleHullBand } from '@/shared';
import type { BuildCtx } from './build';
import { convexHull2D } from './hull';

/** A vertex counts as "visible" only this far (m) over the terrain — a thin rim z-fighting the ground is no wall. */
const FOOT_EPS = 0.05;
/** The height cap the movement outline reads (m above ground) — a little over a standing body's head. */
const MOVE_CAP_M = PLAYER_HEIGHT + 0.4;
/** Roughly one bullet band's height (m). */
const BAND_M = 1.4;
/** The most bullet bands. */
const BAND_MAX = 4;

export interface PropCollider {
  /** The movement outline's XZ centre — used as `Obstacle.position`'s XZ (it keeps the circle small). */
  x: number;
  z: number;
  hull: ObstacleHull;
  /** World height of the drawn top face. */
  top: number;
}

/* Scratch — world generation is single-threaded. */
let _w = new Float32Array(0);       // world xyz
let _terr = new Float32Array(0);    // terrain height under each vertex
let _pts = new Float32Array(0);     // xz pairs
let _cross = new Float32Array(0);   // terrain crossings xyz

function ensure(n: number, tris: number): void {
  if (_w.length < n * 3) { _w = new Float32Array(n * 3); _terr = new Float32Array(n); }
  const cap = (n + tris * 3 * 3) * 2;
  if (_pts.length < cap) _pts = new Float32Array(cap);
  if (_cross.length < tris * 3 * 3) _cross = new Float32Array(tris * 3 * 3);
}

/**
 * The convex collider of `geo` placed by the instance matrix `m`. Every coordinate is world space.
 */
export function propHullOf(ctx: BuildCtx, geo: THREE.BufferGeometry, m: THREE.Matrix4): PropCollider | null {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const n = pos.count;
  const index = geo.getIndex();
  const tris = index ? index.count / 3 : n / 3;
  ensure(n, tris);
  const e = m.elements;
  /* 2026-09-11 (C-40): reads the arrays directly instead of `getX/getY/getZ` · `index.getX` — prop geometries are all
   * un-normalised `BufferAttribute`s (stride 3, offset 0), so not a bit differs. Most of generation time was here. */
  const pa = pos.array as ArrayLike<number>;
  const ia = index ? (index.array as ArrayLike<number>) : null;
  let top = -Infinity, lifted = 0;
  for (let i = 0; i < n; i++) {
    const lx = pa[i * 3], ly = pa[i * 3 + 1], lz = pa[i * 3 + 2];
    const wx = e[0] * lx + e[4] * ly + e[8] * lz + e[12];
    const wy = e[1] * lx + e[5] * ly + e[9] * lz + e[13];
    const wz = e[2] * lx + e[6] * ly + e[10] * lz + e[14];
    _w[i * 3] = wx; _w[i * 3 + 1] = wy; _w[i * 3 + 2] = wz;
    _terr[i] = ctx.terrain.getHeightAt(wx, wz);
    if (wy - _terr[i] - FOOT_EPS > 0) { lifted++; if (wy > top) top = wy; }
  }
  if (lifted === 0) return null;

  const lift = (i: number): number => _w[i * 3 + 1] - _terr[i] - FOOT_EPS;
  const vi = (f: number, k: number): number => (ia ? ia[f * 3 + k] : f * 3 + k);

  // ① Terrain crossings (where an edge breaks through the ground) — the movement outline and every band share them
  let nc = 0;
  let yLow = Infinity;
  for (let f = 0; f < tris; f++) {
    for (let k = 0; k < 3; k++) {
      const a = vi(f, k), b = vi(f, (k + 1) % 3);
      const la = lift(a), lb = lift(b);
      if ((la > 0) === (lb > 0)) continue;
      const t = la / (la - lb);
      const x = _w[a * 3] + (_w[b * 3] - _w[a * 3]) * t;
      const y = _w[a * 3 + 1] + (_w[b * 3 + 1] - _w[a * 3 + 1]) * t;
      const z = _w[a * 3 + 2] + (_w[b * 3 + 2] - _w[a * 3 + 2]) * t;
      _cross[nc * 3] = x; _cross[nc * 3 + 1] = y; _cross[nc * 3 + 2] = z;
      nc++;
      if (y < yLow) yLow = y;
    }
  }
  for (let i = 0; i < n; i++) if (lift(i) > 0 && _w[i * 3 + 1] < yLow) yLow = _w[i * 3 + 1];

  // ② Movement outline: vertices up to `MOVE_CAP_M` over the ground + terrain crossings + edges cutting that plane
  let np = 0;
  const push = (x: number, z: number): void => { _pts[np * 2] = x; _pts[np * 2 + 1] = z; np++; };
  const above = (i: number): number => _w[i * 3 + 1] - _terr[i];
  for (let i = 0; i < n; i++) if (lift(i) > 0 && above(i) <= MOVE_CAP_M) push(_w[i * 3], _w[i * 3 + 2]);
  for (let c = 0; c < nc; c++) push(_cross[c * 3], _cross[c * 3 + 2]);
  for (let f = 0; f < tris; f++) {
    for (let k = 0; k < 3; k++) {
      const a = vi(f, k), b = vi(f, (k + 1) % 3);
      const ha = above(a) - MOVE_CAP_M, hb = above(b) - MOVE_CAP_M;
      if ((ha > 0) === (hb > 0)) continue;
      const t = ha / (ha - hb);
      if (lift(a) + (lift(b) - lift(a)) * t <= 0) continue;
      push(_w[a * 3] + (_w[b * 3] - _w[a * 3]) * t, _w[a * 3 + 2] + (_w[b * 3 + 2] - _w[a * 3 + 2]) * t);
    }
  }
  let points = convexHull2D(_pts, np);
  if (!points) {
    // A very thin prop — once more with every visible vertex
    np = 0;
    for (let i = 0; i < n; i++) if (lift(i) > 0) push(_w[i * 3], _w[i * 3 + 2]);
    for (let c = 0; c < nc; c++) push(_cross[c * 3], _cross[c * 3 + 2]);
    points = convexHull2D(_pts, np);
  }
  if (!points) return null;

  // ③ Bullet bands
  const span = top - yLow;
  const nb = span <= BAND_M * 1.15 ? 1 : Math.min(BAND_MAX, Math.ceil(span / BAND_M));
  let bands: ObstacleHullBand[] | undefined;
  if (nb > 1) {
    bands = [];
    let prev: Float32Array | null = null;
    for (let k = 0; k < nb; k++) {
      const lo = yLow + (span * k) / nb, hi = yLow + (span * (k + 1)) / nb;
      np = 0;
      for (let i = 0; i < n; i++) {
        const wy = _w[i * 3 + 1];
        if (lift(i) > 0 && wy >= lo && wy <= hi) push(_w[i * 3], _w[i * 3 + 2]);
      }
      for (let c = 0; c < nc; c++) {
        const y = _cross[c * 3 + 1];
        if (y >= lo && y <= hi) push(_cross[c * 3], _cross[c * 3 + 2]);
      }
      for (let f = 0; f < tris; f++) {
        for (let kk = 0; kk < 3; kk++) {
          const a = vi(f, kk), b = vi(f, (kk + 1) % 3);
          const ya = _w[a * 3 + 1], yb = _w[b * 3 + 1];
          // 2026-09-11 (C-40): `for (const plane of [lo, hi])` built an array per edge — the same two, unrolled
          for (let pl = 0; pl < 2; pl++) {
            const plane = pl === 0 ? lo : hi;
            const da = ya - plane, db = yb - plane;
            if ((da > 0) === (db > 0)) continue;
            const t = da / (da - db);
            if (lift(a) + (lift(b) - lift(a)) * t <= 0) continue;
            push(_w[a * 3] + (_w[b * 3] - _w[a * 3]) * t, _w[a * 3 + 2] + (_w[b * 3 + 2] - _w[a * 3 + 2]) * t);
          }
        }
      }
      const bp: Float32Array | null = convexHull2D(_pts, np) ?? prev;
      if (!bp) continue;
      prev = bp;
      // The bottom band reaches a little lower — on a slope the crossing heights jitter and would gap at the foot
      bands.push({ y0: k === 0 ? lo - 0.4 : lo, y1: hi, points: bp });
    }
    if (bands.length === 0) bands = undefined;
  }

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < points.length; i += 2) {
    if (points[i] < minX) minX = points[i]; if (points[i] > maxX) maxX = points[i];
    if (points[i + 1] < minZ) minZ = points[i + 1]; if (points[i + 1] > maxZ) maxZ = points[i + 1];
  }
  return { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2, hull: bands ? { points, bands } : { points }, top };
}
