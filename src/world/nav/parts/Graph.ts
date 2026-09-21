/**
 * src/world/nav/parts/Graph.ts — **reading the graph**: where a node is, who its neighbours are, which node a point
 * stands on, and whether a straight line is walkable. No state of its own (the scratch below is per call).
 *
 * Link rules (the one place they are written):
 *  - two **terrain** surfaces link when the slope between them is at most `NAV_MAX_SLOPE_DEG` (a hill is walked);
 *  - anything else (a floor plate, a ramp, a deck, a crate top) links when the height difference is at most
 *    `PROP_STEP_UP_MAX` — the same step `getSurfaceY` lets a body take, so a stair flight (a ramp) links cell by cell
 *    and a wall top never links to the floor beside it;
 *  - a link that involves a **ramp** top (`F_RAMP`) keeps to `RAMP_STEP_M`. Along a flight the cells differ by far
 *    less; the rule is for the ramp's **side**: a body there is measured against the ramp top at its own edge, which on
 *    a slope is higher than at the cell centre, so a side step the centres call 0.87 m is a 0.9 m+ wall to a body coming
 *    in at an angle (seed 2026: the path climbed onto a flight from the side and the walker stuck there);
 *  - a **diagonal** needs both orthogonal cells walkable too, or a path would cut a wall's corner the body cannot.
 */
import { NAV_CAN, NAV_MAX_SLOPE_DEG, NAV_STRUCT_CELL_M, PROP_STEP_UP_MAX } from '@/shared';
import type { NavGraph } from '../NavGraph';
import { F_OWNED, F_RAMP, F_TERRAIN, F_WALK, L_WALK, type Region, regionToWorld, worldToRegion } from '../model';

const TAN_MAX = Math.tan((NAV_MAX_SLOPE_DEG * Math.PI) / 180);
/** Slack on the slope rule — the terrain samples are bilinear, a cell exactly on the limit must still link. */
const SLOPE_SLACK = 0.05;
/**
 * The step (m) a link to or from a ramp top may take — above one cell's rise along a flight (`STAIR_SLOPE` ×
 * `NAV_STRUCT_CELL_M` = 0.35, diagonally 0.49), well under `PROP_STEP_UP_MAX` so a body stepping onto the side at an
 * angle still clears the higher edge it touches first.
 */
const RAMP_STEP_M = 0.5;
/** A snapped node may sit at most this far above · below the asked point (m) — one storey is ~3 m. */
const SNAP_DY = 1.8;
/** Height mismatch weight in the snap score — a node one floor away loses to one a few metres aside. */
const SNAP_DY_W = 4;

const _p = { x: 0, z: 0 };
const _q = { x: 0, z: 0 };

/** Do two surfaces link across a horizontal distance `dist`? (header rules) */
export function linkOk(h1: number, f1: number, h2: number, f2: number, dist: number): boolean {
  const dh = Math.abs(h1 - h2);
  if ((f1 & f2 & F_TERRAIN) !== 0) return dh <= dist * TAN_MAX + SLOPE_SLACK;
  if (((f1 | f2) & F_RAMP) !== 0) return dh <= RAMP_STEP_M;
  return dh <= PROP_STEP_UP_MAX;
}

/** The region holding node `id` (`id >= outdoorCount`), by binary search over the bases. */
export function regionOf(g: NavGraph, id: number): Region {
  const rs = g.regions;
  let lo = 0, hi = rs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (rs[mid].base <= id) lo = mid; else hi = mid - 1;
  }
  return rs[lo];
}

/** Height · flags of any node. */
export function nodeH(g: NavGraph, id: number): number {
  if (id < g.outdoorCount) return g.oh[id];
  const r = regionOf(g, id);
  return r.h[id - r.base];
}
export function nodeF(g: NavGraph, id: number): number {
  if (id < g.outdoorCount) return g.of[id];
  const r = regionOf(g, id);
  return r.f[id - r.base];
}

/** World position of a node (y = its surface). */
export function nodePos(g: NavGraph, id: number, out: { x: number; y: number; z: number }): void {
  if (id < g.outdoorCount) {
    const i = id % g.W, j = (id - i) / g.W;
    out.x = g.origin + (i + 0.5) * g.cell;
    out.z = g.origin + (j + 0.5) * g.cell;
    out.y = g.oh[id];
    return;
  }
  const r = regionOf(g, id);
  const k = id - r.base;
  const c = r.col[k];
  const a = c % r.nu, b = (c - a) / r.nu;
  regionToWorld(r, r.u0 + (a + 0.5) * NAV_STRUCT_CELL_M, r.v0 + (b + 0.5) * NAV_STRUCT_CELL_M, _p);
  out.x = _p.x; out.z = _p.z; out.y = r.h[k];
}

/**
 * The walkable node of region column `c` that best continues from height `h` (smallest height difference that still
 * links), or -1. Returned as a **local** index into the region's node arrays.
 */
export function bestInColumn(r: Region, c: number, h: number, f: number, dist: number): number {
  let best = -1, bestD = Infinity;
  for (let k = r.colStart[c], e = r.colStart[c + 1]; k < e; k++) {
    if ((r.f[k] & F_WALK) === 0) continue;
    const d = Math.abs(r.h[k] - h);
    if (d >= bestD || !linkOk(h, f, r.h[k], r.f[k], dist)) continue;
    best = k; bestD = d;
  }
  return best;
}

const DI = [1, -1, 0, 0, 1, 1, -1, -1];
const DJ = [0, 0, 1, -1, 1, -1, 1, -1];

/** Neighbour scratch filled by `neighbours` (ids, step costs, link kinds, ladder index or -1). */
export const nbId = new Int32Array(64);
export const nbCost = new Float32Array(64);
export const nbKind = new Uint8Array(64);
export const nbLadder = new Int32Array(64);

/** Fills the neighbour scratch for node `id` and a body that can do `can`. Returns the count. */
export function neighbours(g: NavGraph, id: number, can: number): number {
  let n = 0;
  if (id < g.outdoorCount) {
    const W = g.W, of = g.of, oh = g.oh;
    const i = id % W, j = (id - i) / W;
    const h = oh[id], f = of[id];
    for (let d = 0; d < 8; d++) {
      const ii = i + DI[d], jj = j + DJ[d];
      if (ii < 0 || jj < 0 || ii >= W || jj >= W) continue;
      const m = jj * W + ii;
      const fm = of[m];
      if ((fm & F_WALK) === 0 || (fm & F_OWNED) !== 0) continue;
      const diag = d >= 4;
      const dist = diag ? g.cell * Math.SQRT2 : g.cell;
      if (!linkOk(h, f, oh[m], fm, dist)) continue;
      if (diag) {
        const a = j * W + ii, b = jj * W + i;
        if ((of[a] & F_WALK) === 0 || (of[a] & F_OWNED) !== 0 || !linkOk(h, f, oh[a], of[a], g.cell)) continue;
        if ((of[b] & F_WALK) === 0 || (of[b] & F_OWNED) !== 0 || !linkOk(h, f, oh[b], of[b], g.cell)) continue;
      }
      nbId[n] = m; nbCost[n] = dist; nbKind[n] = L_WALK; nbLadder[n] = -1; n++;
    }
  } else {
    if ((can & NAV_CAN.INDOOR) === 0) return 0;
    const r = regionOf(g, id);
    const k = id - r.base;
    const c = r.col[k];
    const a = c % r.nu, b = (c - a) / r.nu;
    const h = r.h[k], f = r.f[k];
    const cs = NAV_STRUCT_CELL_M;
    for (let d = 0; d < 8; d++) {
      const aa = a + DI[d], bb = b + DJ[d];
      if (aa < 0 || bb < 0 || aa >= r.nu || bb >= r.nv) continue;
      const diag = d >= 4;
      const dist = diag ? cs * Math.SQRT2 : cs;
      const m = bestInColumn(r, bb * r.nu + aa, h, f, dist);
      if (m < 0) continue;
      if (diag) {
        if (bestInColumn(r, b * r.nu + aa, h, f, cs) < 0) continue;
        if (bestInColumn(r, bb * r.nu + a, h, f, cs) < 0) continue;
      }
      nbId[n] = r.base + m; nbCost[n] = dist; nbKind[n] = L_WALK; nbLadder[n] = -1; n++;
    }
  }
  const extra = g.links.get(id);
  if (extra) {
    for (let e = 0; e < extra.length && n < nbId.length; e++) {
      const l = extra[e];
      if (l.can !== 0 && (can & l.can) === 0) continue;
      if (l.to >= g.outdoorCount && (can & NAV_CAN.INDOOR) === 0) continue;
      if ((nodeF(g, l.to) & F_WALK) === 0) continue;
      nbId[n] = l.to; nbCost[n] = l.cost; nbKind[n] = l.kind; nbLadder[n] = l.ladder; n++;
    }
  }
  return n;
}

/** Is the world point inside region `r`'s grid? Writes its local UV into `out` either way. */
export function inRegion(r: Region, x: number, z: number, out: { x: number; z: number }): boolean {
  worldToRegion(r, x, z, out);
  return out.x >= r.u0 && out.z >= r.v0 && out.x < r.u0 + r.nu * NAV_STRUCT_CELL_M && out.z < r.v0 + r.nv * NAV_STRUCT_CELL_M;
}

/** Candidate buffers for `snap` (best few, sorted by score). */
const SNAP_KEEP = 6;
const snapIds = new Int32Array(SNAP_KEEP);
const snapScore = new Float64Array(SNAP_KEEP);
let snapN = 0;
const snapTry = new Int32Array(SNAP_KEEP);

function offer(id: number, score: number): void {
  if (snapN === SNAP_KEEP && score >= snapScore[SNAP_KEEP - 1]) return;
  let i = snapN < SNAP_KEEP ? snapN++ : SNAP_KEEP - 1;
  while (i > 0 && snapScore[i - 1] > score) { snapScore[i] = snapScore[i - 1]; snapIds[i] = snapIds[i - 1]; i--; }
  snapScore[i] = score; snapIds[i] = id;
}

const _pos = { x: 0, y: 0, z: 0 };

/**
 * The walkable node a point stands on — the best-scoring node within `maxR` (XZ distance plus the height mismatch)
 * from which a straight walk back to the point is clear, so a body pressed against a thin wall is not snapped to
 * the room on the other side. -1 with none.
 */
export function snap(g: NavGraph, x: number, y: number, z: number, maxR: number, can: number): number {
  const n = gather(g, x, y, z, maxR, can);
  // Copied out first: `walkLine` may call `gather` itself (a start on a blocked cell) and refill `snapIds`.
  for (let s = 0; s < n; s++) snapTry[s] = snapIds[s];
  for (let s = 0; s < n; s++) {
    const id = snapTry[s];
    nodePos(g, id, _pos);
    if (walkLine(g, _pos.x, _pos.y, _pos.z, x, z)) return id;
  }
  // Nothing with a clear line back (a point inside a crate, a goal on a counter): the nearest one still beats nothing.
  return n > 0 ? snapTry[0] : -1;
}

/** Fills the snap candidates (best `SNAP_KEEP`, sorted) within `maxR` and returns how many there are. */
function gather(g: NavGraph, x: number, y: number, z: number, maxR: number, can: number): number {
  snapN = 0;
  // outdoor cells
  const W = g.W, cell = g.cell;
  const i0 = Math.max(0, Math.floor((x - maxR - g.origin) / cell)), i1 = Math.min(W - 1, Math.floor((x + maxR - g.origin) / cell));
  const j0 = Math.max(0, Math.floor((z - maxR - g.origin) / cell)), j1 = Math.min(W - 1, Math.floor((z + maxR - g.origin) / cell));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const id = j * W + i;
      const f = g.of[id];
      if ((f & F_WALK) === 0 || (f & F_OWNED) !== 0) continue;
      const dy = g.oh[id] - y;
      if (dy > SNAP_DY || dy < -SNAP_DY) continue;
      const dx = g.origin + (i + 0.5) * cell - x, dz = g.origin + (j + 0.5) * cell - z;
      const d2 = dx * dx + dz * dz;
      if (d2 > maxR * maxR) continue;
      offer(id, d2 + (dy * SNAP_DY_W) * (dy * SNAP_DY_W));
    }
  }
  // region columns
  if ((can & NAV_CAN.INDOOR) !== 0) {
    const cs = NAV_STRUCT_CELL_M;
    for (const r of g.regions) {
      worldToRegion(r, x, z, _q);
      const a0 = Math.max(0, Math.floor((_q.x - maxR - r.u0) / cs)), a1 = Math.min(r.nu - 1, Math.floor((_q.x + maxR - r.u0) / cs));
      const b0 = Math.max(0, Math.floor((_q.z - maxR - r.v0) / cs)), b1 = Math.min(r.nv - 1, Math.floor((_q.z + maxR - r.v0) / cs));
      if (a0 > a1 || b0 > b1) continue;
      for (let b = b0; b <= b1; b++) {
        for (let a = a0; a <= a1; a++) {
          const du = r.u0 + (a + 0.5) * cs - _q.x, dv = r.v0 + (b + 0.5) * cs - _q.z;
          const d2 = du * du + dv * dv;
          if (d2 > maxR * maxR) continue;
          const c = b * r.nu + a;
          for (let k = r.colStart[c], e = r.colStart[c + 1]; k < e; k++) {
            if ((r.f[k] & F_WALK) === 0) continue;
            const dy = r.h[k] - y;
            if (dy > SNAP_DY || dy < -SNAP_DY) continue;
            offer(r.base + k, d2 + (dy * SNAP_DY_W) * (dy * SNAP_DY_W));
          }
        }
      }
    }
  }
  return snapN;
}

/** How far (m) the line test looks for a walkable start when the body's own cell is not one. */
const START_R = 1.2;
/** Sample spacing of the line test (m) — half the finer cell, so a sample lands in every region column it crosses. */
const LINE_STEP = NAV_STRUCT_CELL_M * 0.5;

/**
 * Walks the straight segment from `(x0, y0, z0)` to `(x1, z1)` over the graph, carrying the height along: every
 * sample must land on a walkable node that links from the previous one; given `y1`, the floor it ends on must also be
 * within `SNAP_DY` of it. A start that is on no node at all (in the
 * air, outside the map) answers **true** — the graph has no opinion there and the mover steers as it always did.
 */
export function walkLine(g: NavGraph, x0: number, y0: number, z0: number, x1: number, z1: number, y1?: number): boolean {
  const dx = x1 - x0, dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  let h = y0;
  let f = 0;
  if (sampleAt(g, x0, z0, h, 0, true) < 0) {
    // A body pressed against a wall stands on a cell whose centre is too close to it to count as walkable — carry
    // on from the nearest walkable node instead of giving no answer (which would let it steer into the wall).
    if (gather(g, x0, y0, z0, START_R, NAV_CAN.INDOOR) === 0) return true;
    nodePos(g, snapIds[0], _pos);
    sH = _pos.y; sF = nodeF(g, snapIds[0]);
  }
  h = sH; f = sF;
  const steps = Math.max(1, Math.ceil(len / LINE_STEP));
  const step = len / steps;
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    if (sampleAt(g, x0 + dx * t, z0 + dz * t, h, f, false, step) < 0) return false;
    h = sH; f = sF;
  }
  // The line ends on the floor it walked; a goal a storey above or below it is not reached by walking straight.
  return y1 === undefined || Math.abs(h - y1) <= SNAP_DY;
}

/** Height · flags of the node the last `sampleAt` picked. */
let sH = 0;
let sF = 0;

/**
 * The node under `(x, z)` that continues from height `h` — a region column first (its grid is the finer truth), the
 * outdoor cell otherwise. `loose` (the first sample) takes the nearest height within `SNAP_DY` instead of a step.
 * Returns 1 / -1 and leaves the node's height · flags in `sH` · `sF`.
 */
function sampleAt(g: NavGraph, x: number, z: number, h: number, f: number, loose: boolean, dist = LINE_STEP): number {
  const cs = NAV_STRUCT_CELL_M;
  for (const r of g.regions) {
    if (!inRegion(r, x, z, _q)) continue;
    const a = Math.floor((_q.x - r.u0) / cs), b = Math.floor((_q.z - r.v0) / cs);
    const c = b * r.nu + a;
    let best = -1, bestD = Infinity;
    for (let k = r.colStart[c], e = r.colStart[c + 1]; k < e; k++) {
      if ((r.f[k] & F_WALK) === 0) continue;
      const d = Math.abs(r.h[k] - h);
      if (d >= bestD) continue;
      if (loose ? d > SNAP_DY : !linkOk(h, f, r.h[k], r.f[k], dist)) continue;
      best = k; bestD = d;
    }
    if (best >= 0) { sH = r.h[best]; sF = r.f[best]; return 1; }
  }
  const i = Math.floor((x - g.origin) / g.cell), j = Math.floor((z - g.origin) / g.cell);
  if (i < 0 || j < 0 || i >= g.W || j >= g.W) return -1;
  const id = j * g.W + i;
  const fo = g.of[id];
  if ((fo & F_WALK) === 0) return -1;
  // An owned cell is a region's; a sample that found nothing walkable in that region's column is blocked there.
  if ((fo & F_OWNED) !== 0) return -1;
  const ho = g.oh[id];
  if (loose ? Math.abs(ho - h) > SNAP_DY : !linkOk(h, f, ho, fo, dist)) return -1;
  sH = ho; sF = fo;
  return 1;
}
