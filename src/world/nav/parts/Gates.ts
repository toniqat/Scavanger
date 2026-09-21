/**
 * src/world/nav/parts/Gates.ts — **the raid's chokepoints** (`NavRef.gates`, TODO A-18 phase 2).
 *
 * The last step of the bake. A **gate** is a connected patch of walkable region nodes that are *narrow*: counting the
 * linked walkable nodes both ways along the region's own U axis, or along V, gives a span of `NAV_GATE_MAX_SPAN_M` or
 * less. A doorway (2.6 m less the body = 1.7 m), a stair flight and a basement corridor come out; a room and the roof
 * do not. Patches under `NAV_GATE_MIN_CELLS` are dropped — two cells between a crate and a wall are no gate.
 *
 * What keeps everything else out of it:
 *  - a run that reaches the **region grid's edge** is open (the floor goes on outdoors), so the 2–3 m band between a
 *    wall and the margin's edge is never narrow across;
 *  - only nodes **inside the footprint** (the region less its `NAV_STRUCT_MARGIN_M` margin, plus `FOOTPRINT_PAD_M` for the
 *    outer half of a doorway) are members: the gap between a rock and a wall outside is not something to queue at.
 *    (`F_TERRAIN` cannot tell inside from outside — a ground floor's plate top *is* the flattened terrain height);
 *  - a patch must be a **passage**: it needs wider floor linked to it on two sides (two exits seen from its middle
 *    more than `EXIT_SPREAD_COS` apart). The top of a crate, a parapet, a dead-end nook between two shelves have walkable
 *    narrow cells but lead nowhere, and a queue in front of them would be a queue in front of nothing;
 *  - outdoor nodes are never looked at, and neither is a region that is not a structure (`RegionSpec.gates` — a rail
 *    platform is an open deck).
 *
 * Gates are fixed at bake time: a locked door that opens later adds walkable cells to its doorway, and those carry no
 * gate (the enemies simply walk through) — see the README's known limits.
 */
import * as THREE from 'three';
import { NAV_GATE_MAX_SPAN_M, NAV_GATE_MIN_CELLS, NAV_STRUCT_CELL_M, NAV_STRUCT_MARGIN_M } from '@/shared';
import type { NavGraph } from '../NavGraph';
import { F_WALK, type Region, regionToWorld } from '../model';
import { bestInColumn } from './Graph';

/** Nodes measured between two yields of the bake. */
const YIELD_EVERY = 1500;
/** A run that left the grid: wider than any gate. */
const OPEN = 1 << 20;
/** How far (m) past the walls' centre lines a member may lie — the outer half of a doorway (wall half + the body). */
const FOOTPRINT_PAD_M = 1;
/** Two exits count as two sides when the angle between them, seen from the patch's middle, has a cosine under this (> 60°). */
const EXIT_SPREAD_COS = 0.5;
/** Member of a patch that turned out too small (reset to -1 at the end of its region). */
const REJECTED = -2;

const DA = [1, -1, 0, 0, 1, 1, -1, -1];
const DB = [0, 0, 1, -1, 1, -1, 1, -1];
const _w = { x: 0, z: 0 };

/** Linked walkable nodes from node `k` in direction `(da, db)`, at most `cap` (`OPEN` when the grid ends first). */
function run(r: Region, k: number, da: number, db: number, cap: number): number {
  const c = r.col[k];
  let a = c % r.nu, b = (c - a) / r.nu;
  let h = r.h[k], f = r.f[k];
  let n = 0;
  while (n < cap) {
    a += da; b += db;
    if (a < 0 || b < 0 || a >= r.nu || b >= r.nv) return OPEN;
    const m = bestInColumn(r, b * r.nu + a, h, f, NAV_STRUCT_CELL_M);
    if (m < 0) break;
    h = r.h[m]; f = r.f[m];
    n++;
  }
  return n;
}

/** Is the walkable span through node `k` along `±(da, db)` at most `maxCells` cells? */
function across(r: Region, k: number, da: number, db: number, maxCells: number): boolean {
  const p = run(r, k, da, db, maxCells);
  if (p >= maxCells) return false;
  return 1 + p + run(r, k, -da, -db, maxCells - p) <= maxCells;
}

/** Do the exits (`u, v` pairs) lie on two sides of `(cu, cv)`? */
function twoSided(exits: readonly number[], cu: number, cv: number): boolean {
  for (let i = 0; i + 1 < exits.length; i += 2) {
    const ax = exits[i] - cu, az = exits[i + 1] - cv;
    const al = Math.hypot(ax, az);
    if (al < 1e-6) continue;
    for (let j = i + 2; j + 1 < exits.length; j += 2) {
      const bx = exits[j] - cu, bz = exits[j + 1] - cv;
      const bl = Math.hypot(bx, bz);
      if (bl < 1e-6) continue;
      if ((ax * bx + az * bz) / (al * bl) < EXIT_SPREAD_COS) return true;
    }
  }
  return false;
}

export function* build(g: NavGraph): Generator<void, void, void> {
  const cs = NAV_STRUCT_CELL_M;
  /** The widest span, in cells, that still is a gate. */
  const maxCells = Math.max(1, Math.floor(NAV_GATE_MAX_SPAN_M / cs + 1e-6));
  g.gates.length = 0;
  const stack: number[] = [];
  const patch: number[] = [];
  /** Exits of the patch being judged, as local `u, v` pairs. */
  const exits: number[] = [];
  let work = 0;
  for (const r of g.regions) {
    const n = r.h.length;
    const gate = new Int32Array(n).fill(-1);
    r.gate = gate;
    if (!r.spec.gates) continue;
    const narrow = new Uint8Array(n);
    const inU = r.spec.halfU - NAV_STRUCT_MARGIN_M + FOOTPRINT_PAD_M, inV = r.spec.halfV - NAV_STRUCT_MARGIN_M + FOOTPRINT_PAD_M;
    for (let k = 0; k < n; k++) {
      if ((r.f[k] & F_WALK) === 0) continue;
      const c = r.col[k];
      const a = c % r.nu, b = (c - a) / r.nu;
      if (Math.abs(r.u0 + (a + 0.5) * cs) > inU || Math.abs(r.v0 + (b + 0.5) * cs) > inV) continue;
      if (across(r, k, 1, 0, maxCells) || across(r, k, 0, 1, maxCells)) narrow[k] = 1;
      if (++work % YIELD_EVERY === 0) yield;
    }
    // Connected patches of narrow nodes (8-way, linked the way a body walks them).
    for (let k0 = 0; k0 < n; k0++) {
      if (narrow[k0] === 0 || gate[k0] !== -1) continue;
      const id = g.gates.length;
      stack.length = 0; patch.length = 0; exits.length = 0;
      stack.push(k0); gate[k0] = id;
      while (stack.length > 0) {
        const k = stack.pop()!;
        patch.push(k);
        const c = r.col[k];
        const a = c % r.nu, b = (c - a) / r.nu;
        for (let d = 0; d < 8; d++) {
          const aa = a + DA[d], bb = b + DB[d];
          if (aa < 0 || bb < 0 || aa >= r.nu || bb >= r.nv) continue;
          const m = bestInColumn(r, bb * r.nu + aa, r.h[k], r.f[k], d >= 4 ? cs * Math.SQRT2 : cs);
          if (m < 0) continue;
          if (narrow[m] === 0) { exits.push(r.u0 + (aa + 0.5) * cs, r.v0 + (bb + 0.5) * cs); continue; }
          if (gate[m] !== -1) continue;
          gate[m] = id;
          stack.push(m);
        }
      }
      let su = 0, sv = 0, sh = 0;
      for (const k of patch) {
        const c = r.col[k];
        const a = c % r.nu, b = (c - a) / r.nu;
        su += r.u0 + (a + 0.5) * cs; sv += r.v0 + (b + 0.5) * cs; sh += r.h[k];
      }
      if (patch.length < NAV_GATE_MIN_CELLS || !twoSided(exits, su / patch.length, sv / patch.length)) {
        for (const k of patch) gate[k] = REJECTED;
        continue;
      }
      regionToWorld(r, su / patch.length, sv / patch.length, _w);
      g.gates.push({ id, position: new THREE.Vector3(_w.x, sh / patch.length, _w.z) });
      if ((work += patch.length) % YIELD_EVERY < patch.length) yield;
    }
    for (let k = 0; k < n; k++) if (gate[k] === REJECTED) gate[k] = -1;
    yield;
  }
  g.gateLoad = new Int32Array(g.gates.length);
  g.gateLoadStamp++;
}
