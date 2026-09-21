/**
 * src/world/nav/parts/Flow.ts — **flow fields**: one search for every body chasing the same goal (TODO A-18 phase 2).
 *
 * `NavRef.flowTo(key, goal, can)` names a moving goal; the field behind it is a Dijkstra run **outward from the
 * goal** over `NAV_FLOW_RADIUS_M`, storing for every node it reached the next node toward the goal, the special link
 * that hop is (or -1 = walk) and the distance left. Links are symmetric, so expanding from the goal and writing
 * `next[m] = n` when `m` is relaxed from `n` is the way *to* the goal; a special link is stored as the row of the
 * **opposite** direction (`SpecialLink.rev`), the one the body will perform.
 *
 * - **Time-sliced**: `update` spends at most `NAV_FLOW_BUDGET_MS` a frame, on **one build at a time** — so there is one
 *   heap and one closed set for all fields, separate from the A*'s (a `findPath` between two slices touches nothing
 *   of this; the neighbour scratch is only ever used inside one expansion).
 * - **Double-buffered**: the build writes into a spare buffer and swaps it in when it finishes; the field's previous
 *   buffer becomes the next spare. Memory is therefore `fields + 1` buffers, not `2 × fields`.
 * - **Windowed storage**: a buffer holds a square of outdoor cells around the goal (`SIDE²`) plus a block for the nodes
 *   of every region whose circle meets the disc — never a map-sized array (the outdoor grid is 640 × 640).
 * - **Gates**: entering a gate from outside it costs `load × NAV_GATE_LOAD_COST_M` more, which is what spreads a
 *   queue to another door or a window on the next build.
 * - Rebuild: goal moved `NAV_FLOW_REBUILD_M`, `revision` changed, or gate loads changed — never within
 *   `NAV_FLOW_MIN_REBUILD_S` of the last finish; the field built longest ago goes first.
 *
 * `sample` is per body per frame, so it never calls `snap`: it takes the region column · outdoor cell under the body
 * and, when that node has no entry (a body pressed against a wall stands on a cell that is not walkable), the nearest
 * neighbouring one that has. Nearest by **cell centre**, not by field distance — the cell across a thin wall may be
 * closer to the goal, but it is never closer to the body.
 */
import * as THREE from 'three';
import {
  NAV_CAN, NAV_CELL_M, NAV_FLOW_ARRIVE_M, NAV_FLOW_IDLE_S, NAV_FLOW_LOOKAHEAD_M, NAV_FLOW_MAX_FIELDS, NAV_FLOW_MIN_REBUILD_S,
  NAV_FLOW_RADIUS_M, NAV_FLOW_REBUILD_M, NAV_GATE_LOAD_COST_M, NAV_GATE_LOOK_M, NAV_LINK_START_M, NAV_SNAP_M, NAV_STRUCT_CELL_M,
  type NavFlow, type NavFlowStep,
} from '@/shared';
import type { NavGraph } from '../NavGraph';
import { F_OWNED, F_WALK, LINK_KINDS, type Region } from '../model';
import { nbCost, nbId, nbSpecial, neighbours, nodePos, regionOfHint, snap, walkLine, inRegion } from './Graph';

/** Outdoor cells from the goal's cell to the window's edge, the window's side and its cell count. */
const HALF = Math.ceil(NAV_FLOW_RADIUS_M / NAV_CELL_M);
const SIDE = 2 * HALF + 1;
const WIN = SIDE * SIDE;
/** Heap pops between two looks at the clock. */
const CLOCK_EVERY = 48;
/** `sample` walks at most this many hops down the field (the gate look-ahead in region cells, with slack). */
const MAX_HOPS = 40;
/** The body's node is looked for within this height (m) of its feet — one storey is ~3 m. */
const LOCATE_DY = 1.8;
/** A special link is performed only from its own floor: the body's feet within this (m) of the start node. */
const LINK_START_DY = 1.0;
/** A goal that changed floor by this much (m) counts as moved even right above its old spot. */
const REBUILD_DY = 1.2;

/** One finished (or in-progress) build. */
class FlowBuf {
  /** Min cell of the outdoor window (may lie outside the map — slots only ever come from real nodes). */
  i0 = 0; j0 = 0;
  /** Per slot: the next node toward the goal (-1 at the goal), that hop's `specials` row (-1 = walk), metres left. */
  next = new Int32Array(0);
  link = new Int32Array(0);
  dist = new Float32Array(0);
  /** Per region: where its node block starts after the window, -1 = not in this field. */
  regOff = new Int32Array(0);
  /** Slots in use (`WIN` + the region blocks). */
  count = 0;
  /** Nodes the build reached. */
  nodes = 0;
  goalX = 0; goalY = 0; goalZ = 0;
  revision = -1;
  loadStamp = -1;
}

export class FlowField implements NavFlow {
  key = '';
  can = 0;
  live = false;
  readonly goal = new THREE.Vector3();
  lastAsk = 0;
  front: FlowBuf | null = null;
  /** `FlowState.clock` when the last build finished. */
  builtAt = -Infinity;

  constructor(private readonly graph: NavGraph) {}

  get ready(): boolean { return this.front !== null; }

  sample(from: THREE.Vector3, out: NavFlowStep): boolean { return sample(this.graph, this, from, out); }
}

export class FlowState {
  readonly fields: FlowField[] = [];
  readonly spare: FlowBuf[] = [];
  clock = 0;
  /* the one build in progress */
  building: FlowField | null = null;
  buf: FlowBuf | null = null;
  heapId = new Int32Array(4096);
  heapSlot = new Int32Array(4096);
  heapF = new Float32Array(4096);
  heapN = 0;
  closed = new Uint8Array(0);
  buildMs = 0;
  buildFrames = 0;
  /* stats (`NavGraph.debugInfo`) */
  builds = 0;
  lastMs = 0;
  maxMs = 0;
  sumMs = 0;
  lastNodes = 0;
  lastFrames = 0;
  lastBytes = 0;
}

/** Drops every field (the graph was cleared — the buffers index regions that are gone). */
export function reset(g: NavGraph): void {
  const s = g.flow;
  for (const f of s.fields) { f.live = false; f.front = null; f.builtAt = -Infinity; }
  s.spare.length = 0;
  s.building = null;
  s.buf = null;
  s.heapN = 0;
  // The hint names a Region of the dropped graph; a new graph numbers its region nodes from the same base, so a
  // stale hint would pass `regionOfHint`'s range test and index the wrong region's arrays.
  lastRegion = null;
}

export function flowTo(g: NavGraph, key: string, goal: THREE.Vector3, can: number): FlowField | null {
  if (!g.ready) return null;
  const s = g.flow;
  let free: FlowField | null = null;
  for (let i = 0; i < s.fields.length; i++) {
    const f = s.fields[i];
    if (!f.live) { free ??= f; continue; }
    if (f.can === can && f.key === key) { f.goal.copy(goal); f.lastAsk = s.clock; return f; }
  }
  if (!free) {
    if (s.fields.length < NAV_FLOW_MAX_FIELDS) { free = new FlowField(g); s.fields.push(free); }
    else {
      // All in use: one nobody asked for lately goes first (the per-frame sweep would drop it anyway).
      for (const f of s.fields) if (s.clock - f.lastAsk > NAV_FLOW_IDLE_S) { drop(g, f); free = f; break; }
      if (!free) return null;
    }
  }
  free.live = true;
  free.key = key;
  free.can = can;
  free.goal.copy(goal);
  free.lastAsk = s.clock;
  free.front = null;
  free.builtAt = -Infinity;
  return free;
}

function drop(g: NavGraph, f: FlowField): void {
  const s = g.flow;
  if (s.building === f) {
    if (s.buf) s.spare.push(s.buf);
    s.building = null; s.buf = null; s.heapN = 0;
  }
  if (f.front) s.spare.push(f.front);
  f.front = null;
  f.live = false;
  // One spare is all a build needs; the rest is memory a dropped field should give back.
  if (s.spare.length > 1) s.spare.length = 1;
}

/** Per frame: drop idle fields, then build within `budgetMs`. */
export function update(g: NavGraph, dt: number, budgetMs: number): void {
  const s = g.flow;
  s.clock += dt;
  for (const f of s.fields) if (f.live && s.clock - f.lastAsk > NAV_FLOW_IDLE_S) drop(g, f);
  const t0 = performance.now();
  if (!s.building) {
    const f = pick(g);
    if (!f) return;
    begin(g, f);
  }
  s.buildFrames++;
  step(g, t0, budgetMs);
  s.buildMs += performance.now() - t0;
  if (s.heapN === 0) finish(g);
}

/** The field that needs a build and was built longest ago (never built first). */
function pick(g: NavGraph): FlowField | null {
  const s = g.flow;
  let best: FlowField | null = null;
  for (const f of s.fields) {
    if (!f.live) continue;
    const b = f.front;
    if (b) {
      if (s.clock - f.builtAt < NAV_FLOW_MIN_REBUILD_S) continue;
      const dx = f.goal.x - b.goalX, dz = f.goal.z - b.goalZ;
      const moved = dx * dx + dz * dz >= NAV_FLOW_REBUILD_M * NAV_FLOW_REBUILD_M || Math.abs(f.goal.y - b.goalY) >= REBUILD_DY;
      if (!moved && b.revision === g.revision && b.loadStamp === g.gateLoadStamp) continue;
    }
    if (!best || f.builtAt < best.builtAt) best = f;
  }
  return best;
}

function begin(g: NavGraph, f: FlowField): void {
  const s = g.flow;
  const b = s.spare.pop() ?? new FlowBuf();
  b.goalX = f.goal.x; b.goalY = f.goal.y; b.goalZ = f.goal.z;
  b.revision = g.revision;
  b.loadStamp = g.gateLoadStamp;
  b.i0 = Math.floor((f.goal.x - g.origin) / g.cell) - HALF;
  b.j0 = Math.floor((f.goal.z - g.origin) / g.cell) - HALF;
  if (b.regOff.length !== g.regions.length) b.regOff = new Int32Array(g.regions.length);
  let acc = 0;
  for (const r of g.regions) {
    const reach = NAV_FLOW_RADIUS_M + Math.hypot(r.spec.halfU, r.spec.halfV);
    const dx = r.spec.cx - f.goal.x, dz = r.spec.cz - f.goal.z;
    if ((f.can & NAV_CAN.INDOOR) !== 0 && dx * dx + dz * dz <= reach * reach) { b.regOff[r.index] = acc; acc += r.h.length; }
    else b.regOff[r.index] = -1;
  }
  b.count = WIN + acc;
  if (b.dist.length < b.count) {
    b.next = new Int32Array(b.count);
    b.link = new Int32Array(b.count);
    b.dist = new Float32Array(b.count);
  }
  b.dist.fill(Infinity, 0, b.count);
  if (s.closed.length < b.count) s.closed = new Uint8Array(b.count);
  s.closed.fill(0, 0, b.count);
  b.nodes = 0;
  s.building = f;
  s.buf = b;
  s.heapN = 0;
  s.buildMs = 0;
  s.buildFrames = 0;
  const t = snap(g, f.goal.x, f.goal.y, f.goal.z, NAV_SNAP_M, f.can);
  if (t < 0) return;                       // no node under the goal: an empty field, every sample answers false
  const st = slotOf(g, b, t, null);
  if (st < 0) return;
  b.dist[st] = 0; b.next[st] = -1; b.link[st] = -1;
  push(s, t, st, 0);
}

function finish(g: NavGraph): void {
  const s = g.flow;
  const f = s.building, b = s.buf;
  s.building = null; s.buf = null;
  if (!f || !b) return;
  if (f.front) s.spare.push(f.front);
  if (s.spare.length > 1) s.spare.length = 1;
  f.front = b;
  f.builtAt = s.clock;
  s.builds++;
  s.lastMs = s.buildMs;
  s.sumMs += s.buildMs;
  if (s.buildMs > s.maxMs) s.maxMs = s.buildMs;
  s.lastNodes = b.nodes;
  s.lastFrames = s.buildFrames;
  s.lastBytes = b.next.byteLength + b.link.byteLength + b.dist.byteLength;
}

/** The region `slotOf` last resolved (the gate lookup right after it reads the same one). */
let lastRegion: Region | null = null;

/** Where node `id` lives in buffer `b`, -1 when the field does not cover it. */
function slotOf(g: NavGraph, b: FlowBuf, id: number, hint: Region | null): number {
  if (id < g.outdoorCount) {
    lastRegion = null;
    const i = id % g.W;
    const di = i - b.i0, dj = (id - i) / g.W - b.j0;
    if (di < 0 || dj < 0 || di >= SIDE || dj >= SIDE) return -1;
    return dj * SIDE + di;
  }
  const r = regionOfHint(g, id, hint);
  lastRegion = r;
  const off = b.regOff[r.index];
  return off < 0 ? -1 : WIN + off + (id - r.base);
}

function push(s: FlowState, id: number, slot: number, f: number): void {
  if (s.heapN >= s.heapId.length) {
    const n = s.heapId.length * 2;
    const ids = new Int32Array(n); ids.set(s.heapId); s.heapId = ids;
    const sl = new Int32Array(n); sl.set(s.heapSlot); s.heapSlot = sl;
    const fs = new Float32Array(n); fs.set(s.heapF); s.heapF = fs;
  }
  const H = s.heapId, S = s.heapSlot, F = s.heapF;
  let i = s.heapN++;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (F[p] <= f) break;
    H[i] = H[p]; S[i] = S[p]; F[i] = F[p]; i = p;
  }
  H[i] = id; S[i] = slot; F[i] = f;
}

/** Removes the top; its id · slot are left in `popId` · `popSlot`. */
let popId = 0, popSlot = 0;
function pop(s: FlowState): void {
  const H = s.heapId, S = s.heapSlot, F = s.heapF;
  popId = H[0]; popSlot = S[0];
  const n = --s.heapN;
  if (n <= 0) return;
  const id = H[n], sl = S[n], f = F[n];
  let i = 0;
  for (;;) {
    const l = 2 * i + 1;
    if (l >= n) break;
    const r = l + 1;
    const c = r < n && F[r] < F[l] ? r : l;
    if (F[c] >= f) break;
    H[i] = H[c]; S[i] = S[c]; F[i] = F[c]; i = c;
  }
  H[i] = id; S[i] = sl; F[i] = f;
}

/** Dijkstra outward from the goal until the heap is empty or the frame's budget is spent. */
function step(g: NavGraph, t0: number, budgetMs: number): void {
  const s = g.flow;
  const f = s.building, b = s.buf;
  if (!f || !b) return;
  const can = f.can;
  const closed = s.closed, dist = b.dist, next = b.next, link = b.link;
  const W = g.W, cell = g.cell, origin = g.origin;
  const R2 = NAV_FLOW_RADIUS_M * NAV_FLOW_RADIUS_M;
  const load = g.gateLoad;
  let pops = 0;
  while (s.heapN > 0) {
    pop(s);
    const n = popId, sn = popSlot;
    if (closed[sn] === 1) continue;
    closed[sn] = 1;
    b.nodes++;
    const rn = n >= g.outdoorCount ? regionOfHint(g, n, lastRegion) : null;
    const gateN = rn ? rn.gate[n - rn.base] : -1;
    const toll = gateN >= 0 && load[gateN] > 0 ? load[gateN] * NAV_GATE_LOAD_COST_M : 0;
    const gn = dist[sn];
    const cnt = neighbours(g, n, can);
    for (let e = 0; e < cnt; e++) {
      const m = nbId[e];
      if (m < g.outdoorCount) {
        const i = m % W;
        const dx = origin + (i + 0.5) * cell - b.goalX, dz = origin + ((m - i) / W + 0.5) * cell - b.goalZ;
        if (dx * dx + dz * dz > R2) continue;
      }
      const sm = slotOf(g, b, m, rn);
      if (sm < 0 || closed[sm] === 1) continue;
      let c = nbCost[e];
      // The body travels m → n: it pays the toll when `n` is in a loaded gate and `m` is not in that gate.
      if (toll > 0 && (lastRegion === null || lastRegion.gate[m - lastRegion.base] !== gateN)) c += toll;
      const nd = gn + c;
      if (nd >= dist[sm]) continue;
      dist[sm] = nd;
      next[sm] = n;
      link[sm] = nbSpecial[e] >= 0 ? g.specials[nbSpecial[e]].rev : -1;
      push(s, m, sm, nd);
    }
    if (++pops % CLOCK_EVERY === 0 && performance.now() - t0 >= budgetMs) return;
  }
}

/* ── sample ─────────────────────────────────────────────────────────────────────────────────────────────────── */

const _q = { x: 0, z: 0 };
const _p = { x: 0, y: 0, z: 0 };
const hopX = new Float32Array(MAX_HOPS + 1);
const hopY = new Float32Array(MAX_HOPS + 1);
const hopZ = new Float32Array(MAX_HOPS + 1);
let locId = -1, locSlot = -1;

/** The entry of region column `(a, b)` nearest height `y` (within `LOCATE_DY`). Leaves it in `locId` · `locSlot`. */
function columnEntry(bf: FlowBuf, r: Region, a: number, b: number, y: number): boolean {
  if (a < 0 || b < 0 || a >= r.nu || b >= r.nv) return false;
  const off = WIN + bf.regOff[r.index];
  const c = b * r.nu + a;
  let best = -1, bestD = LOCATE_DY;
  for (let k = r.colStart[c], e = r.colStart[c + 1]; k < e; k++) {
    if ((r.f[k] & F_WALK) === 0 || bf.dist[off + k] === Infinity) continue;
    const d = Math.abs(r.h[k] - y);
    if (d > bestD) continue;
    best = k; bestD = d;
  }
  if (best < 0) return false;
  locId = r.base + best; locSlot = off + best;
  return true;
}

/** The entry of outdoor cell `(i, j)`. */
function cellEntry(g: NavGraph, bf: FlowBuf, i: number, j: number, y: number): boolean {
  if (i < 0 || j < 0 || i >= g.W || j >= g.W) return false;
  const di = i - bf.i0, dj = j - bf.j0;
  if (di < 0 || dj < 0 || di >= SIDE || dj >= SIDE) return false;
  const id = j * g.W + i, slot = dj * SIDE + di;
  const f = g.of[id];
  if ((f & F_WALK) === 0 || (f & F_OWNED) !== 0 || bf.dist[slot] === Infinity || Math.abs(g.oh[id] - y) > LOCATE_DY) return false;
  locId = id; locSlot = slot;
  return true;
}

/**
 * The field entry the body at `(x, y, z)` stands on: its own region column · outdoor cell, else the nearest
 * neighbouring one with an entry (ring 1, then for the finer region grid ring 2). Result in `locId` · `locSlot`.
 */
function locate(g: NavGraph, bf: FlowBuf, x: number, y: number, z: number): boolean {
  const cs = NAV_STRUCT_CELL_M;
  for (const r of g.regions) {
    if (bf.regOff[r.index] < 0 || !inRegion(r, x, z, _q)) continue;
    const a = Math.floor((_q.x - r.u0) / cs), b = Math.floor((_q.z - r.v0) / cs);
    if (columnEntry(bf, r, a, b, y)) return true;
    for (let ring = 1; ring <= 2; ring++) {
      let bestD = Infinity, bestId = -1, bestSlot = -1;
      for (let db = -ring; db <= ring; db++) {
        for (let da = -ring; da <= ring; da++) {
          if (Math.max(Math.abs(da), Math.abs(db)) !== ring) continue;
          const du = r.u0 + (a + da + 0.5) * cs - _q.x, dv = r.v0 + (b + db + 0.5) * cs - _q.z;
          const d = du * du + dv * dv;
          if (d >= bestD || !columnEntry(bf, r, a + da, b + db, y)) continue;
          bestD = d; bestId = locId; bestSlot = locSlot;
        }
      }
      if (bestId >= 0) { locId = bestId; locSlot = bestSlot; return true; }
    }
  }
  const i = Math.floor((x - g.origin) / g.cell), j = Math.floor((z - g.origin) / g.cell);
  if (cellEntry(g, bf, i, j, y)) return true;
  let bestD = Infinity, bestId = -1, bestSlot = -1;
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      if (di === 0 && dj === 0) continue;
      const dx = g.origin + (i + di + 0.5) * g.cell - x, dz = g.origin + (j + dj + 0.5) * g.cell - z;
      const d = dx * dx + dz * dz;
      if (d >= bestD || !cellEntry(g, bf, i + di, j + dj, y)) continue;
      bestD = d; bestId = locId; bestSlot = locSlot;
    }
  }
  if (bestId < 0) return false;
  locId = bestId; locSlot = bestSlot;
  return true;
}

function gateOf(g: NavGraph, id: number, hint: Region | null): number {
  if (id < g.outdoorCount) return -1;
  const r = regionOfHint(g, id, hint);
  lastRegion = r;
  return r.gate[id - r.base];
}

function sample(g: NavGraph, f: FlowField, from: THREE.Vector3, out: NavFlowStep): boolean {
  const bf = f.front;
  if (!bf || !f.live || !g.ready || bf.nodes === 0) return false;
  if (!locate(g, bf, from.x, from.y, from.z)) return false;
  const left = bf.dist[locSlot];
  if (left <= NAV_FLOW_ARRIVE_M) return false;
  out.dist = left;
  out.kind = 'walk';
  out.ladderId = null;
  out.windowId = null;

  // Walk the field: hop 0 is the body's own node. Stops at the goal, at a special link's start, or past the gate look.
  let id = locId, slot = locSlot;
  nodePos(g, id, _p);
  hopX[0] = _p.x; hopY[0] = _p.y; hopZ[0] = _p.z;
  let hops = 0, acc = 0, aim = -1, special = -1;
  let region: Region | null = null;
  out.gate = gateOf(g, id, null);
  region = lastRegion;
  out.gateDist = 0;
  while (hops < MAX_HOPS) {
    const nx = bf.next[slot];
    if (nx < 0) break;
    if (bf.link[slot] >= 0) { special = bf.link[slot]; break; }
    const ns = slotOf(g, bf, nx, region);
    if (ns < 0) break;
    region = lastRegion;
    nodePos(g, nx, _p);
    hops++;
    hopX[hops] = _p.x; hopY[hops] = _p.y; hopZ[hops] = _p.z;
    acc += Math.hypot(_p.x - hopX[hops - 1], _p.z - hopZ[hops - 1]);
    id = nx; slot = ns;
    if (aim < 0 && acc >= NAV_FLOW_LOOKAHEAD_M) aim = hops;
    if (out.gate < 0) {
      const gt = region ? region.gate[nx - region.base] : -1;
      if (gt >= 0) { out.gate = gt; out.gateDist = acc; }
    }
    if (acc >= NAV_GATE_LOOK_M || (aim >= 0 && out.gate >= 0)) break;
  }
  // Short of the look-ahead the way ended — at the goal or at a link's start; that node is the aim.
  if (aim < 0) aim = hops;

  if (special >= 0 && aim === hops) {
    const dx = hopX[hops] - from.x, dz = hopZ[hops] - from.z;
    if (dx * dx + dz * dz <= NAV_LINK_START_M * NAV_LINK_START_M && Math.abs(hopY[hops] - from.y) <= LINK_START_DY) {
      const sp = g.specials[special];
      out.kind = LINK_KINDS[sp.kind];
      out.from.set(hopX[hops], hopY[hops], hopZ[hops]);
      out.via.set(sp.viaX, sp.viaY, sp.viaZ);
      nodePos(g, sp.to, _p);
      out.to.set(_p.x, _p.y, _p.z);
      out.ladderId = sp.ladder >= 0 ? g.ladders[sp.ladder]?.id ?? null : null;
      out.windowId = sp.window >= 0 ? g.world?.windows[sp.window]?.id ?? null : null;
      out.aim.copy(out.from);
      return true;
    }
  }
  // The look-ahead cuts corners only where the straight line is walkable; otherwise it falls back hop by hop.
  while (aim > 1 && !walkLine(g, from.x, from.y, from.z, hopX[aim], hopZ[aim])) aim--;
  out.aim.set(hopX[aim], hopY[aim], hopZ[aim]);
  return true;
}
