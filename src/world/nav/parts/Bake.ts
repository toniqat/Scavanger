/**
 * src/world/nav/parts/Bake.ts — **measuring the world once** (TODO A-18).
 *
 * A generator that `NavGraph.update` advances for `NAV_BAKE_BUDGET_MS` a frame, so a raid never hitches on it:
 *  ① regions — one per structure · rail platform, and the outdoor cells inside them marked `F_OWNED`;
 *  ② the "near a collider" mask — a cell no collider comes near is open terrain and needs no probe at all;
 *  ③ outdoor rows — a probed cell asks `getSurfaceY` for its floor and `resolveCollision` whether a body there is pushed;
 *  ④ region columns — every box / ramp / hull top over a column is a candidate floor; a candidate is a node when it
 *     really is the surface at that height (`getSurfaceY` finds nothing steppable just above it), and walkable when a
 *     body standing on it is not pushed (walls, a ceiling too low, the space under a stair flight);
 *  ⑤ links — each region's edge band to the outdoor cells beside it, and every ladder's foot to its exit.
 * The node counts are only known after ④, so the search arrays are sized last.
 */
import * as THREE from 'three';
import {
  NAV_CAN, NAV_LADDER_COST_MUL, NAV_STRUCT_CELL_M, PLAYER_RADIUS,
} from '@/shared';
import type { NavGraph } from '../NavGraph';
import {
  F_OWNED, F_RAMP, F_TERRAIN, F_WALK, L_LADDER, L_WALK, type NavLink, type NavWorld, type Region, type RegionSpec,
  regionToWorld, worldToRegion,
} from '../model';
import { boxContainsXZ, rampTopAt } from '../../obb';
import { hullContainsXZ } from '../../hull';
import type { ObstacleEntry } from '../../SpatialHash';
import { inRegion, linkOk } from './Graph';

/** The body the graph is measured for — a person. A smaller body fits wherever this one does. */
export const NAV_BODY_R = PLAYER_RADIUS;
/** A probe pushed further than this (m) means the body does not fit there. */
const PUSH_EPS = 0.02;
/** A surface this close (m) to the terrain height is the terrain (the slope rule applies to it). */
const TERRAIN_EPS = 0.02;
/** Candidate floors closer than this (m) are one floor. */
const DEDUPE_EPS = 0.05;
/** `getSurfaceY` must return the candidate within this (m) for it to be the surface there. */
const SURFACE_EPS = 0.06;
/**
 * How far inside a region's edge the outdoor cells stop being the outdoor grid's (m). The region grid reaches the
 * full margin, so the two overlap by this band and the seam links find partners on both sides.
 */
const OWN_INSET = 1;
/** Region columns this close (m) to the region's edge look for outdoor partners. */
const STITCH_BAND = OWN_INSET + 1;
/** Farthest seam link (m). */
const STITCH_R = 1.1;
/** A ladder end is the walkable node within this XZ distance (m) of the ladder's foot · exit ... */
const LADDER_SNAP_R = 1.2;
/** ... and within this height (m) of it. */
const LADDER_SNAP_DY = 0.6;

const _probe = new THREE.Vector3();
const _w = { x: 0, z: 0 };
const _l = { x: 0, z: 0 };

export function clear(g: NavGraph): void {
  g.ready = false;
  g.job = null;
  g.world = null;
  g.regions = [];
  g.links.clear();
  g.ladders = [];
  g.total = 0;
  g.oh.fill(0);
  g.of.fill(0);
  g.dirtyCell.fill(0);
  g.dirtyCells.length = 0;
  g.dirtyCols.length = 0;
  g.dirtyColSet.clear();
  g.trail.length = 0;
  g.revision++;
}

export function start(g: NavGraph, world: NavWorld): void {
  clear(g);
  g.world = world;
  g.ladders = world.ladders;
  g.bakeMs = 0;
  g.job = bake(g, world);
}

/** Advances the bake for up to `budgetMs`. */
export function step(g: NavGraph, budgetMs: number): void {
  const t0 = performance.now();
  while (g.job) {
    if (g.job.next().done) { g.job = null; break; }
    if (performance.now() - t0 >= budgetMs) break;
  }
  g.bakeMs += performance.now() - t0;
}

/** Would a body standing at `(x, h, z)` be pushed? (`resolveCollision` — the movers' own test.) */
export function fits(w: NavWorld, x: number, h: number, z: number): boolean {
  _probe.set(x, h, z);
  w.resolve(_probe, NAV_BODY_R);
  const dx = _probe.x - x, dz = _probe.z - z;
  return dx * dx + dz * dz <= PUSH_EPS * PUSH_EPS;
}

/** Measures one outdoor cell (bake and re-measure share it). Returns true when its answer changed. */
export function probeOutdoor(g: NavGraph, w: NavWorld, id: number, near: boolean): boolean {
  const W = g.W;
  const i = id % W, j = (id - i) / W;
  const x = g.origin + (i + 0.5) * g.cell, z = g.origin + (j + 0.5) * g.cell;
  const oldH = g.oh[id], oldF = g.of[id];
  const owned = oldF & F_OWNED;
  const tH = w.heightAt(x, z);
  let h = tH, f = 0;
  if (Math.abs(x) > w.limit || Math.abs(z) > w.limit) f = 0;
  else if (!near) f = F_WALK | F_TERRAIN;
  else {
    h = w.surfaceY(x, z, tH);
    f = (fits(w, x, h, z) ? F_WALK : 0) | (Math.abs(h - tH) < TERRAIN_EPS ? F_TERRAIN : 0);
  }
  g.oh[id] = h;
  g.of[id] = f | owned;
  return g.oh[id] !== oldH || g.of[id] !== oldF;
}

/** Re-checks whether region node `k`'s floor still fits a body. Returns true when it changed. */
export function probeRegionNode(w: NavWorld, r: Region, k: number): boolean {
  const c = r.col[k];
  const a = c % r.nu, b = (c - a) / r.nu;
  regionToWorld(r, r.u0 + (a + 0.5) * NAV_STRUCT_CELL_M, r.v0 + (b + 0.5) * NAV_STRUCT_CELL_M, _w);
  const old = r.f[k];
  const walk = fits(w, _w.x, r.h[k], _w.z) ? F_WALK : 0;
  r.f[k] = (old & ~F_WALK) | walk;
  return r.f[k] !== old;
}

function makeRegion(spec: RegionSpec): Region {
  const cs = NAV_STRUCT_CELL_M;
  return {
    spec, cos: Math.cos(spec.yaw), sin: Math.sin(spec.yaw),
    u0: -spec.halfU, v0: -spec.halfV,
    nu: Math.max(1, Math.ceil((2 * spec.halfU) / cs)), nv: Math.max(1, Math.ceil((2 * spec.halfV) / cs)),
    base: 0,
    colStart: new Int32Array(0), h: new Float32Array(0), f: new Uint8Array(0), col: new Int32Array(0),
  };
}

function* bake(g: NavGraph, w: NavWorld): Generator<void, void, void> {
  const W = g.W;

  /* ① regions + owned outdoor cells */
  for (const spec of w.regions) {
    const r = makeRegion(spec);
    g.regions.push(r);
    const R = Math.hypot(spec.halfU, spec.halfV);
    const i0 = Math.max(0, Math.floor((spec.cx - R - g.origin) / g.cell)), i1 = Math.min(W - 1, Math.floor((spec.cx + R - g.origin) / g.cell));
    const j0 = Math.max(0, Math.floor((spec.cz - R - g.origin) / g.cell)), j1 = Math.min(W - 1, Math.floor((spec.cz + R - g.origin) / g.cell));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        worldToRegion(r, g.origin + (i + 0.5) * g.cell, g.origin + (j + 0.5) * g.cell, _l);
        if (Math.abs(_l.x) <= spec.halfU - OWN_INSET && Math.abs(_l.z) <= spec.halfV - OWN_INSET) g.of[j * W + i] |= F_OWNED;
      }
    }
  }
  yield;

  /* ② near-a-collider mask — the collider's circle grown by the body and a cell */
  const near = new Uint8Array(W * W);
  for (const o of w.hash.getAll()) {
    const rr = o.radius + NAV_BODY_R + g.cell;
    const i0 = Math.max(0, Math.floor((o.position.x - rr - g.origin) / g.cell)), i1 = Math.min(W - 1, Math.floor((o.position.x + rr - g.origin) / g.cell));
    const j0 = Math.max(0, Math.floor((o.position.z - rr - g.origin) / g.cell)), j1 = Math.min(W - 1, Math.floor((o.position.z + rr - g.origin) / g.cell));
    for (let j = j0; j <= j1; j++) near.fill(1, j * W + i0, j * W + i1 + 1);
  }
  yield;

  /* ③ outdoor rows */
  for (let j = 0; j < W; j++) {
    for (let i = 0; i < W; i++) {
      const id = j * W + i;
      if ((g.of[id] & F_OWNED) !== 0) continue;
      probeOutdoor(g, w, id, near[id] === 1);
    }
    yield;
  }

  /* ④ region columns */
  let base = g.outdoorCount;
  for (const r of g.regions) {
    yield* bakeRegion(w, r);
    r.base = base;
    base += r.h.length;
  }
  g.total = base;
  yield;

  /* ⑤ links */
  for (const r of g.regions) { stitch(g, r); yield; }
  ladderLinks(g, w);

  g.g = new Float32Array(g.total);
  g.parent = new Int32Array(g.total);
  g.pkind = new Uint8Array(g.total);
  g.pladder = new Int32Array(g.total);
  g.seen = new Uint32Array(g.total);
  g.closed = new Uint32Array(g.total);
  g.gen = 0;
  g.ready = true;
  g.revision++;
}

/** Measures one region: candidate floors per column from the colliders over it, then one node per real floor. */
function* bakeRegion(w: NavWorld, r: Region): Generator<void, void, void> {
  const cs = NAV_STRUCT_CELL_M;
  const spec = r.spec;
  const cols = r.nu * r.nv;
  const tops: number[][] = new Array(cols);
  for (let c = 0; c < cols; c++) tops[c] = [];
  /** The ramp tops among them — a floor that is one of these gets `F_RAMP`. */
  const rampTops: (number[] | undefined)[] = new Array(cols);

  // Every standable top over the region, rasterised per collider (a column only meets the colliders above it).
  // Cylinders are left out: a pole or a tree trunk is nothing a body stands on.
  const obs = w.hash.query(spec.cx, spec.cz, Math.hypot(spec.halfU, spec.halfV) + 1, []);
  for (const o of obs) {
    if (!o.box && !o.hull) continue;
    if (!footprintAabb(r, o)) continue;
    const a0 = Math.max(0, Math.floor((_aabb[0] - r.u0) / cs)), a1 = Math.min(r.nu - 1, Math.floor((_aabb[1] - r.u0) / cs));
    const b0 = Math.max(0, Math.floor((_aabb[2] - r.v0) / cs)), b1 = Math.min(r.nv - 1, Math.floor((_aabb[3] - r.v0) / cs));
    for (let b = b0; b <= b1; b++) {
      for (let a = a0; a <= a1; a++) {
        regionToWorld(r, r.u0 + (a + 0.5) * cs, r.v0 + (b + 0.5) * cs, _w);
        let top: number;
        if (o.box) {
          if (!boxContainsXZ(o, _w.x, _w.z)) continue;
          top = o.ramp ? rampTopAt(o, _w.x, _w.z) : o.position.y + o.height;
        } else {
          if (!hullContainsXZ(o.hull!.points, _w.x, _w.z)) continue;
          top = o.position.y + o.height;
        }
        tops[b * r.nu + a].push(top);
        if (o.ramp) (rampTops[b * r.nu + a] ??= []).push(top);
      }
    }
  }
  yield;

  const hs: number[] = [], fs: number[] = [], cl: number[] = [];
  const colStart = new Int32Array(cols + 1);
  for (let b = 0; b < r.nv; b++) {
    for (let a = 0; a < r.nu; a++) {
      const c = b * r.nu + a;
      colStart[c] = hs.length;
      regionToWorld(r, r.u0 + (a + 0.5) * cs, r.v0 + (b + 0.5) * cs, _w);
      const x = _w.x, z = _w.z;
      if (Math.abs(x) > w.limit || Math.abs(z) > w.limit) continue;
      const tH = w.heightAt(x, z);
      const cand = tops[c];
      cand.push(tH);
      cand.sort((p, q) => p - q);
      let last = -Infinity;
      for (const h of cand) {
        if (h - last < DEDUPE_EPS) continue;
        last = h;
        // Something steppable just above (a floor plate over the terrain, the upper end of a slab) is the floor, not this.
        if (Math.abs(w.surfaceY(x, z, h + 0.02) - h) > SURFACE_EPS) continue;
        hs.push(h);
        const ramp = rampTops[c]?.some((t) => Math.abs(t - h) < DEDUPE_EPS) ? F_RAMP : 0;
        fs.push((fits(w, x, h, z) ? F_WALK : 0) | (Math.abs(h - tH) < TERRAIN_EPS ? F_TERRAIN : 0) | ramp);
        cl.push(c);
      }
    }
    yield;
  }
  colStart[cols] = hs.length;
  r.colStart = colStart;
  r.h = Float32Array.from(hs);
  r.f = Uint8Array.from(fs);
  r.col = Int32Array.from(cl);
}

/** `[uMin, uMax, vMin, vMax]` of a box / hull footprint in region-local coordinates (false when it misses the region). */
const _aabb = [0, 0, 0, 0];
function footprintAabb(r: Region, o: ObstacleEntry): boolean {
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  const take = (x: number, z: number): void => {
    worldToRegion(r, x, z, _l);
    if (_l.x < uMin) uMin = _l.x; if (_l.x > uMax) uMax = _l.x;
    if (_l.z < vMin) vMin = _l.z; if (_l.z > vMax) vMax = _l.z;
  };
  if (o.box) {
    const c = Math.cos(o.box.yaw), s = Math.sin(o.box.yaw);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const lx = sx * o.box.halfX, lz = sz * o.box.halfZ;
        take(o.position.x + lx * c - lz * s, o.position.z + lx * s + lz * c);
      }
    }
  } else if (o.hull) {
    const p = o.hull.points;
    for (let i = 0; i + 1 < p.length; i += 2) take(p[i], p[i + 1]);
  } else return false;
  _aabb[0] = uMin; _aabb[1] = uMax; _aabb[2] = vMin; _aabb[3] = vMax;
  return uMax >= r.u0 && vMax >= r.v0 && uMin <= r.u0 + r.nu * NAV_STRUCT_CELL_M && vMin <= r.v0 + r.nv * NAV_STRUCT_CELL_M;
}

function addLink(g: NavGraph, from: number, l: NavLink): void {
  let arr = g.links.get(from);
  if (!arr) { arr = []; g.links.set(from, arr); }
  arr.push(l);
}

/** The seam: every node in a region's edge band links to the outdoor cells right beside it that it can step to. */
function stitch(g: NavGraph, r: Region): void {
  const cs = NAV_STRUCT_CELL_M, W = g.W;
  const spec = r.spec;
  for (let k = 0; k < r.h.length; k++) {
    const c = r.col[k];
    const a = c % r.nu, b = (c - a) / r.nu;
    const u = r.u0 + (a + 0.5) * cs, v = r.v0 + (b + 0.5) * cs;
    if (Math.abs(u) < spec.halfU - STITCH_BAND && Math.abs(v) < spec.halfV - STITCH_BAND) continue;
    regionToWorld(r, u, v, _w);
    const ci = Math.floor((_w.x - g.origin) / g.cell), cj = Math.floor((_w.z - g.origin) / g.cell);
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= W || j >= W) continue;
        const m = j * W + i;
        if ((g.of[m] & F_OWNED) !== 0) continue;
        const dx = g.origin + (i + 0.5) * g.cell - _w.x, dz = g.origin + (j + 0.5) * g.cell - _w.z;
        const d = Math.hypot(dx, dz);
        if (d > STITCH_R || !linkOk(r.h[k], r.f[k], g.oh[m], g.of[m], Math.max(d, cs))) continue;
        const id = r.base + k;
        addLink(g, id, { to: m, cost: d, kind: L_WALK, can: 0, ladder: -1 });
        addLink(g, m, { to: id, cost: d, kind: L_WALK, can: 0, ladder: -1 });
      }
    }
  }
}

/** The region node nearest `(x, z)` at height `y` (walkable, within the ladder snap window), or -1. */
function regionNodeNear(g: NavGraph, x: number, y: number, z: number): number {
  const cs = NAV_STRUCT_CELL_M;
  let best = -1, bestD = Infinity;
  for (const r of g.regions) {
    if (!inRegion(r, x, z, _l)) continue;
    const a0 = Math.max(0, Math.floor((_l.x - LADDER_SNAP_R - r.u0) / cs)), a1 = Math.min(r.nu - 1, Math.floor((_l.x + LADDER_SNAP_R - r.u0) / cs));
    const b0 = Math.max(0, Math.floor((_l.z - LADDER_SNAP_R - r.v0) / cs)), b1 = Math.min(r.nv - 1, Math.floor((_l.z + LADDER_SNAP_R - r.v0) / cs));
    for (let b = b0; b <= b1; b++) {
      for (let a = a0; a <= a1; a++) {
        const du = r.u0 + (a + 0.5) * cs - _l.x, dv = r.v0 + (b + 0.5) * cs - _l.z;
        const d2 = du * du + dv * dv;
        if (d2 > LADDER_SNAP_R * LADDER_SNAP_R || d2 >= bestD) continue;
        const c = b * r.nu + a;
        for (let k = r.colStart[c], e = r.colStart[c + 1]; k < e; k++) {
          if ((r.f[k] & F_WALK) === 0 || Math.abs(r.h[k] - y) > LADDER_SNAP_DY) continue;
          best = r.base + k; bestD = d2;
        }
      }
    }
  }
  return best;
}

/** One link each way per ladder, between the floor at its foot and the floor at its exit. */
function ladderLinks(g: NavGraph, w: NavWorld): void {
  w.ladders.forEach((L, li) => {
    const bottom = regionNodeNear(g, L.base.x, L.base.y, L.base.z);
    const top = regionNodeNear(g, L.exit.x, L.topY, L.exit.z);
    if (bottom < 0 || top < 0) return;
    const cost = Math.abs(L.topY - L.base.y) * NAV_LADDER_COST_MUL + Math.hypot(L.exit.x - L.base.x, L.exit.z - L.base.z);
    addLink(g, bottom, { to: top, cost, kind: L_LADDER, can: NAV_CAN.LADDER, ladder: li });
    addLink(g, top, { to: bottom, cost, kind: L_LADDER, can: NAV_CAN.LADDER, ladder: li });
  });
}
