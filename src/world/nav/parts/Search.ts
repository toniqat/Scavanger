/**
 * src/world/nav/parts/Search.ts — **A\*** over the nav graph (TODO A-18).
 *
 * - Both ends are snapped to walkable nodes (`Graph.snap`, `NAV_SNAP_M`).
 * - The search keeps its per-node state in the graph's typed arrays, stamped with a generation number instead of
 *   being cleared, and expands at most `NAV_SEARCH_MAX_NODES` nodes. Out of budget it answers `partial` with the path
 *   to the node that came closest to the goal — a locked room or another island costs exactly that budget, and the
 *   mover still gets as near as the map allows. A search that runs out of **nodes** (a closed island around the
 *   start) proves the goal unreachable and answers `none`.
 * - The heuristic is the octile XZ distance, weighted a little (`H_WEIGHT`) — the path is smoothed afterwards anyway,
 *   and the weight is what keeps a long open-ground search from flooding.
 * - Smoothing (`smooth`): consecutive walk points collapse while the straight line between them stays walkable.
 *   A special link (a ladder) is never skipped over.
 */
import { NAV_SEARCH_MAX_NODES, NAV_SNAP_M, type NavPath, type NavPathStatus } from '@/shared';
import { ensurePoints, type NavGraph } from '../NavGraph';
import { LINK_KINDS, L_WALK } from '../model';
import { nbCost, nbId, nbKind, nbLadder, neighbours, nodePos, snap, walkLine } from './Graph';

/** Heuristic weight (> 1 trades a slightly longer raw path for far fewer expansions; smoothing takes the kinks out). */
const H_WEIGHT = 1.2;
/** Smoothing looks this many points ahead for a straight shortcut. */
const SMOOTH_LOOKAHEAD = 16;

const _a = { x: 0, y: 0, z: 0 };
const _b = { x: 0, y: 0, z: 0 };
let goalX = 0, goalZ = 0;

function heur(g: NavGraph, id: number): number {
  nodePos(g, id, _a);
  const dx = Math.abs(_a.x - goalX), dz = Math.abs(_a.z - goalZ);
  return (dx > dz ? dx + (Math.SQRT2 - 1) * dz : dz + (Math.SQRT2 - 1) * dx) * H_WEIGHT;
}

function push(g: NavGraph, id: number, f: number): void {
  if (g.heapN >= g.heapId.length) {
    const ids = new Int32Array(g.heapId.length * 2); ids.set(g.heapId); g.heapId = ids;
    const fs = new Float32Array(g.heapF.length * 2); fs.set(g.heapF); g.heapF = fs;
  }
  const H = g.heapId, F = g.heapF;
  let i = g.heapN++;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (F[p] <= f) break;
    H[i] = H[p]; F[i] = F[p]; i = p;
  }
  H[i] = id; F[i] = f;
}

function pop(g: NavGraph): number {
  const H = g.heapId, F = g.heapF;
  const top = H[0];
  const n = --g.heapN;
  if (n > 0) {
    const id = H[n], f = F[n];
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= n) break;
      const r = l + 1;
      const c = r < n && F[r] < F[l] ? r : l;
      if (F[c] >= f) break;
      H[i] = H[c]; F[i] = F[c]; i = c;
    }
    H[i] = id; F[i] = f;
  }
  return top;
}

export function findPath(
  g: NavGraph, from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, can: number, out: NavPath,
): NavPathStatus {
  out.count = 0;
  if (!g.ready) { out.status = 'pending'; return out.status; }
  const s = snap(g, from.x, from.y, from.z, NAV_SNAP_M, can);
  const t = snap(g, to.x, to.y, to.z, NAV_SNAP_M, can);
  if (s < 0 || t < 0) { out.status = 'none'; return out.status; }
  if (s === t) { writePath(g, out, [s], 'ok'); return out.status; }

  nodePos(g, t, _b);
  goalX = _b.x; goalZ = _b.z;
  const gen = ++g.gen;
  g.heapN = 0;
  g.g[s] = 0; g.seen[s] = gen; g.parent[s] = -1; g.pkind[s] = L_WALK; g.pladder[s] = -1;
  let best = s, bestH = heur(g, s);
  push(g, s, bestH);
  let expanded = 0;
  let reached = false, exhausted = true;
  while (g.heapN > 0) {
    const n = pop(g);
    if (g.closed[n] === gen) continue;
    g.closed[n] = gen;
    if (n === t) { reached = true; exhausted = false; break; }
    if (++expanded > NAV_SEARCH_MAX_NODES) { exhausted = false; break; }
    const hn = heur(g, n);
    if (hn < bestH) { bestH = hn; best = n; }
    const cnt = neighbours(g, n, can);
    const gn = g.g[n];
    for (let e = 0; e < cnt; e++) {
      const m = nbId[e];
      if (g.closed[m] === gen) continue;
      const ng = gn + nbCost[e];
      if (g.seen[m] === gen && ng >= g.g[m]) continue;
      g.seen[m] = gen; g.g[m] = ng; g.parent[m] = n; g.pkind[m] = nbKind[e]; g.pladder[m] = nbLadder[e];
      push(g, m, ng + heur(g, m));
    }
  }
  if (!reached && exhausted) { out.status = 'none'; return out.status; }
  const end = reached ? t : best;
  if (end === s) { out.status = reached ? 'ok' : 'none'; return out.status; }
  const trail = g.trail;
  trail.length = 0;
  for (let n = end; n !== -1; n = g.parent[n]) trail.push(n);
  trail.reverse();
  writePath(g, out, trail, reached ? 'ok' : 'partial');
  return out.status;
}

/** Turns a node trail (start first) into smoothed waypoints (the start itself left out). */
function writePath(g: NavGraph, out: NavPath, trail: readonly number[], status: NavPathStatus): void {
  out.status = status;
  const n = trail.length;
  ensurePoints(out, n);
  let count = 0;
  let anchor = 0;
  while (anchor < n - 1) {
    // The furthest point reachable in a straight walk, never past a special link.
    let limit = anchor + 1;
    while (limit < n - 1 && limit - anchor < SMOOTH_LOOKAHEAD && g.pkind[trail[limit + 1]] === L_WALK) limit++;
    let next = limit;
    if (g.pkind[trail[anchor + 1]] === L_WALK) {
      nodePos(g, trail[anchor], _a);
      const ax = _a.x, ay = _a.y, az = _a.z;
      while (next > anchor + 1) {
        nodePos(g, trail[next], _b);
        if (walkLine(g, ax, ay, az, _b.x, _b.z)) break;
        next--;
      }
    } else next = anchor + 1;
    const id = trail[next];
    const w = out.points[count++];
    nodePos(g, id, _b);
    w.position.set(_b.x, _b.y, _b.z);
    w.kind = LINK_KINDS[g.pkind[id]];
    const li = g.pladder[id];
    w.ladderId = w.kind === 'ladder' && li >= 0 ? g.ladders[li]?.id ?? null : null;
    anchor = next;
  }
  if (n === 1) {
    const w = out.points[count++];
    nodePos(g, trail[0], _b);
    w.position.set(_b.x, _b.y, _b.z);
    w.kind = 'walk';
    w.ladderId = null;
  }
  out.count = count;
}
