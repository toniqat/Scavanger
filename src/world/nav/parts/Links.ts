/**
 * src/world/nav/parts/Links.ts — **the special links**: what a body *performs* instead of walking (TODO A-18).
 *
 * Step ⑤ of the bake, after the seams. Three kinds, one table (`NavGraph.specials`, two rows per link — one each way):
 *  - **ladder** (`NAV_CAN.LADDER`) — the floor at a ladder's foot ↔ the floor at its exit (phase 1);
 *  - **climb** (`NAV_CAN.CLIMB`, 2026-09-21 user's decision 「small bugs climb the outer wall onto the roof」) — every
 *    `NAV_CLIMB_SPACING_M` along the four outer walls of a roofed building: the ground just outside the wall ↔ the roof
 *    just inside the parapet. From the roof the hatch's ladder goes down to the top floor, so a climb is a way *in*;
 *  - **window** (`NAV_CAN.WINDOW`) — the floor just inside a window ↔ the **ground** just outside it (an upper-floor
 *    window is reached by climbing the wall to its sill). A whole pane is not a wall here, only a dearer link: the
 *    body breaks it first (`NavRef.breakWindow`), and `Graph.neighbours` adds `NAV_WINDOW_WHOLE_COST_M` while it stands.
 *
 * **Both ends snap to walkable nodes** (phase-1 lesson: the cells right beside a wall are rarely `F_WALK`, the probe
 * body is pushed there). An end with no walkable node in its snap window drops the link — so a climb spot in front
 * of a rock, or a window behind a shelf, simply is not built. The snap also checks the **side of the wall** the node
 * is on, because a 0.42 m wall is thinner than the snap radius.
 *
 * Only region nodes are candidates: every end lies within a step or two of a wall, and the region's margin
 * (`NAV_STRUCT_MARGIN_M`) owns those cells (`F_OWNED` outdoors).
 */
import {
  NAV_CAN, NAV_CLIMB_COST_MUL, NAV_CLIMB_SPACING_M, NAV_LADDER_COST_MUL, NAV_STRUCT_CELL_M, NAV_WINDOW_COST_M,
} from '@/shared';
import type { NavGraph } from '../NavGraph';
import { F_WALK, L_CLIMB, L_LADDER, L_WINDOW, type NavBuilding, type NavLink, type NavWorld } from '../model';
import { inRegion, nodePos } from './Graph';

/** A ladder end is the walkable node within this XZ distance (m) of the ladder's foot · exit ... */
const LADDER_SNAP_R = 1.2;
/** ... and within this height (m) of it. */
const LADDER_SNAP_DY = 0.6;
/** How far (m) from the wall's centre line the two ends of a climb · window link are looked for ... */
const END_OUT_M = 1.1;
const END_IN_M = 1.1;
/** ... within this XZ radius (m) ... */
const END_SNAP_R = 0.9;
/** ... and at least this far (m) beyond the wall's face, so the node is on the asked side of it. */
const END_SIDE_M = 0.3;
/** A floor end (the roof, a window's room) is within this height (m) of its level. */
const FLOOR_DY = 0.4;
/** The ground end may lie this far (m) below · above the building's ground level (a plate on a slope). */
const GROUND_DOWN_M = 3;
const GROUND_UP_M = 0.8;
/** Height mismatch weight in the ground end's score — the node nearest the ground level wins among equals. */
const GROUND_DY_W = 0.5;
/** A climb spot keeps this far (m) clear of a window's edge. */
const CLIMB_WINDOW_CLEAR_M = 0.5;
/** No climb spot within this (m) of a wall's end (the corner is two walls). */
const CLIMB_CORNER_M = 1.2;
/** A climb's `via` stands this far (m) off the wall face and this high (m) over the parapet. */
const CLIMB_STANDOFF_M = 0.3;
const CLIMB_TOP_CLEAR_M = 0.25;
/** A window's `via` is this far (m) over the sill. */
const WINDOW_VIA_LIFT_M = 0.1;

const _l = { x: 0, z: 0 };
const _a = { x: 0, y: 0, z: 0 };
const _b = { x: 0, y: 0, z: 0 };

/** Counts per kind of the last build (`NavGraph.debugInfo`). */
export interface LinkCounts { ladder: number; climb: number; window: number }

export function build(g: NavGraph, w: NavWorld): void {
  g.specials.length = 0;
  g.windowIndex.clear();
  g.windowWholeFlag = new Uint8Array(w.windows.length);
  w.windows.forEach((win, i) => {
    g.windowIndex.set(win.id, i);
    g.windowWholeFlag[i] = w.windowWhole(win.id) ? 1 : 0;
  });
  g.linkCounts.ladder = ladderLinks(g, w);
  g.linkCounts.climb = climbLinks(g, w);
  g.linkCounts.window = windowLinks(g, w);
}

function addLink(g: NavGraph, from: number, l: NavLink): void {
  let arr = g.links.get(from);
  if (!arr) { arr = []; g.links.set(from, arr); }
  arr.push(l);
}

/** One link each way between `a` and `b`, with its two rows in the specials table. */
function addPair(
  g: NavGraph, a: number, b: number, kind: number, can: number, cost: number,
  viaX: number, viaY: number, viaZ: number, ladder: number, window: number,
): void {
  const i = g.specials.length;
  g.specials.push({ from: a, to: b, kind, rev: i + 1, viaX, viaY, viaZ, ladder, window });
  g.specials.push({ from: b, to: a, kind, rev: i, viaX, viaY, viaZ, ladder, window });
  addLink(g, a, { to: b, cost, kind, can, special: i });
  addLink(g, b, { to: a, cost, kind, can, special: i + 1 });
}

/**
 * The walkable region node nearest `(x, z)` within `maxR` whose height is in `[yLo, yHi]` and that lies at least
 * `minSide` along `(sx, sz)` from `(px, pz)` — the side-of-the-wall test (`sx = sz = 0` switches it off). `yRef` ·
 * `dyW` add the height mismatch to the score. -1 with none.
 */
function nodeNear(
  g: NavGraph, x: number, z: number, maxR: number, yLo: number, yHi: number, yRef: number, dyW: number,
  px: number, pz: number, sx: number, sz: number, minSide: number,
): number {
  const cs = NAV_STRUCT_CELL_M;
  let best = -1, bestS = Infinity;
  for (const r of g.regions) {
    if (!inRegion(r, x, z, _l)) continue;
    const lu = _l.x, lv = _l.z;
    const a0 = Math.max(0, Math.floor((lu - maxR - r.u0) / cs)), a1 = Math.min(r.nu - 1, Math.floor((lu + maxR - r.u0) / cs));
    const b0 = Math.max(0, Math.floor((lv - maxR - r.v0) / cs)), b1 = Math.min(r.nv - 1, Math.floor((lv + maxR - r.v0) / cs));
    for (let b = b0; b <= b1; b++) {
      for (let a = a0; a <= a1; a++) {
        const u = r.u0 + (a + 0.5) * cs, v = r.v0 + (b + 0.5) * cs;
        const d2 = (u - lu) * (u - lu) + (v - lv) * (v - lv);
        if (d2 > maxR * maxR) continue;
        if (sx !== 0 || sz !== 0) {
          const wx = r.spec.cx + u * r.cos - v * r.sin, wz = r.spec.cz + u * r.sin + v * r.cos;
          if ((wx - px) * sx + (wz - pz) * sz < minSide) continue;
        }
        const c = b * r.nu + a;
        for (let k = r.colStart[c], e = r.colStart[c + 1]; k < e; k++) {
          if ((r.f[k] & F_WALK) === 0 || r.h[k] < yLo || r.h[k] > yHi) continue;
          const dy = (r.h[k] - yRef) * dyW;
          const s = d2 + dy * dy;
          if (s >= bestS) continue;
          best = r.base + k; bestS = s;
        }
      }
    }
  }
  return best;
}

/** One link per ladder, between the floor at its foot and the floor at its exit. */
function ladderLinks(g: NavGraph, w: NavWorld): number {
  let n = 0;
  w.ladders.forEach((L, li) => {
    const bottom = nodeNear(g, L.base.x, L.base.z, LADDER_SNAP_R, L.base.y - LADDER_SNAP_DY, L.base.y + LADDER_SNAP_DY, 0, 0, 0, 0, 0, 0, 0);
    const top = nodeNear(g, L.exit.x, L.exit.z, LADDER_SNAP_R, L.topY - LADDER_SNAP_DY, L.topY + LADDER_SNAP_DY, 0, 0, 0, 0, 0, 0, 0);
    if (bottom < 0 || top < 0) return;
    const cost = Math.abs(L.topY - L.base.y) * NAV_LADDER_COST_MUL + Math.hypot(L.exit.x - L.base.x, L.exit.z - L.base.z);
    // A ladder has no `via` (the contract leaves it unused); the exit is the least surprising value to leave there.
    addPair(g, bottom, top, L_LADDER, NAV_CAN.LADDER, cost, L.exit.x, L.topY, L.exit.z, li, -1);
    n++;
  });
  return n;
}

/** The ground end of a link on wall point `(wx, wz)` with outward normal `(nx, nz)`. */
function groundEnd(g: NavGraph, B: { groundY: number; wallHalfT: number }, wx: number, wz: number, nx: number, nz: number): number {
  return nodeNear(
    g, wx + nx * END_OUT_M, wz + nz * END_OUT_M, END_SNAP_R, B.groundY - GROUND_DOWN_M, B.groundY + GROUND_UP_M, B.groundY, GROUND_DY_W,
    wx, wz, nx, nz, B.wallHalfT + END_SIDE_M,
  );
}

/** The floor end (level `y`) just inside the same wall point. */
function floorEnd(g: NavGraph, wallHalfT: number, y: number, wx: number, wz: number, nx: number, nz: number): number {
  return nodeNear(
    g, wx - nx * END_IN_M, wz - nz * END_IN_M, END_SNAP_R, y - FLOOR_DY, y + FLOOR_DY, y, 1,
    wx, wz, -nx, -nz, wallHalfT + END_SIDE_M,
  );
}

function climbLinks(g: NavGraph, w: NavWorld): number {
  let n = 0;
  for (const B of w.buildings) n += climbBuilding(g, w, B);
  return n;
}

function climbBuilding(g: NavGraph, w: NavWorld, B: NavBuilding): number {
  const c = Math.cos(B.yaw), s = Math.sin(B.yaw);
  let n = 0;
  // The four walls in building-local coordinates: a fixed coordinate, the half length along the other, the outward normal.
  for (let side = 0; side < 4; side++) {
    const alongZ = side >= 2;
    const sign = side % 2 === 0 ? -1 : 1;
    const fixed = sign * (alongZ ? B.halfW : B.halfD);
    const len = (alongZ ? B.halfD : B.halfW) - CLIMB_CORNER_M;
    if (len <= 0) continue;
    const lnx = alongZ ? sign : 0, lnz = alongZ ? 0 : sign;
    const nx = lnx * c - lnz * s, nz = lnx * s + lnz * c;
    const count = Math.floor((2 * len) / Math.max(0.5, NAV_CLIMB_SPACING_M)) + 1;
    const first = -((count - 1) * NAV_CLIMB_SPACING_M) / 2;
    for (let i = 0; i < count; i++) {
      const t = first + i * NAV_CLIMB_SPACING_M;
      const lx = alongZ ? fixed : t, lz = alongZ ? t : fixed;
      const wx = B.cx + lx * c - lz * s, wz = B.cz + lx * s + lz * c;
      if (blockedSpot(w, B, wx, wz)) continue;
      const from = groundEnd(g, B, wx, wz, nx, nz);
      const to = floorEnd(g, B.wallHalfT, B.roofY, wx, wz, nx, nz);
      if (from < 0 || to < 0) continue;
      nodePos(g, from, _a);
      nodePos(g, to, _b);
      // `via`: the ground end's spot pulled onto the wall's outer face (a standoff off it), over the parapet's top. Both
      // rows share it: a descent goes roof → up over the parapet to `via` → down, since the parapet stands above the roof.
      const off = (_a.x - wx) * nx + (_a.z - wz) * nz - (B.wallHalfT + CLIMB_STANDOFF_M);
      const vx = _a.x - nx * off, vz = _a.z - nz * off;
      const cost = Math.hypot(_b.x - _a.x, _b.z - _a.z) + Math.max(0, B.roofY - _a.y) * NAV_CLIMB_COST_MUL;
      addPair(g, from, to, L_CLIMB, NAV_CAN.CLIMB, cost, vx, B.wallTopY + CLIMB_TOP_CLEAR_M, vz, -1, -1);
      n++;
    }
  }
  return n;
}

/** Is a climb spot under · over a window, or in front of the door · the breach? */
function blockedSpot(w: NavWorld, B: NavBuilding, x: number, z: number): boolean {
  for (const a of B.avoid) {
    if ((a.x - x) * (a.x - x) + (a.z - z) * (a.z - z) < a.r * a.r) return true;
  }
  for (const win of w.windows) {
    if (win.building !== B.key) continue;
    const r = win.halfW + CLIMB_WINDOW_CLEAR_M;
    if ((win.x - x) * (win.x - x) + (win.z - z) * (win.z - z) < r * r) return true;
  }
  return false;
}

function windowLinks(g: NavGraph, w: NavWorld): number {
  let n = 0;
  const halfT = new Map<string, number>();
  for (const B of w.buildings) halfT.set(B.key, B.wallHalfT);
  w.windows.forEach((win, wi) => {
    const wallHalfT = halfT.get(win.building);
    if (wallHalfT === undefined) return;
    // `(nx, nz)` points into the building, the helpers take the outward normal.
    const ox = -win.nx, oz = -win.nz;
    const outside = groundEnd(g, { groundY: win.groundY, wallHalfT }, win.x, win.z, ox, oz);
    const inside = floorEnd(g, wallHalfT, win.floorY, win.x, win.z, ox, oz);
    if (outside < 0 || inside < 0) return;
    nodePos(g, outside, _a);
    nodePos(g, inside, _b);
    const cost = NAV_WINDOW_COST_M + Math.hypot(_b.x - _a.x, _b.z - _a.z) + Math.max(0, win.floorY - _a.y) * NAV_CLIMB_COST_MUL;
    addPair(g, outside, inside, L_WINDOW, NAV_CAN.WINDOW, cost, win.x, win.sillY + WINDOW_VIA_LIFT_M, win.z, -1, wi);
    n++;
  });
  return n;
}
