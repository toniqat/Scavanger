/**
 * src/world/nav/NavGraph.ts — **the raid's walkable graph** (`WorldRef.nav`, TODO A-18, 2026-09-21).
 *
 * `WorldSystem` hands it the finished world (`start`) at the end of a planet raid's generation and ticks it every
 * frame (`update`). The shape is in `model.ts`; the work is split the usual way:
 *  - `parts/Bake`      — measures every cell once, spread over frames (`NAV_BAKE_BUDGET_MS`), then links regions to
 *                        the outdoor grid and ladders to their floors;
 *  - `parts/Graph`     — node positions, neighbours on the fly, snapping a point to a node, the straight-line walk test;
 *  - `parts/Search`    — A* with a node budget, path reconstruction and smoothing;
 *  - `parts/Remeasure` — the cells under a collider that appeared · vanished · moved, measured again a few times a second;
 *  - `parts/Links`     — the special links a body performs (ladder · wall climb · window) and their table (`specials`);
 *  - `parts/Gates`     — the narrow passages (`gates`), tagged per region node;
 *  - `parts/Flow`      — flow fields: one time-sliced Dijkstra per shared goal, sampled by every body that chases it.
 *
 * **It asks the world exactly what a mover asks** — `getSurfaceY` for the floor and `resolveCollision` for "would a
 * body standing here be pushed" — so the graph cannot disagree with how bodies really move. A cell is walkable for a
 * body of `PLAYER_RADIUS` (`NAV_BODY_R`); a smaller body fits wherever a person does.
 *
 * Every client bakes it (the same seed gives the same graph), so a host migration finds it ready; only the authority
 * ever queries it, and nothing about it is on the wire.
 */
import * as THREE from 'three';
import {
  MAP_SIZE, NAV_BAKE_BUDGET_MS, NAV_CELL_M, NAV_FLOW_BUDGET_MS, NAV_REMEASURE_BUDGET_MS, NAV_REMEASURE_HZ,
  type LadderDef, type NavFlow, type NavFlowStep, type NavGate, type NavPath, type NavPathStatus, type NavRef, type NavWaypoint,
} from '@/shared';
import type { NavLink, NavWorld, Region, SpecialLink } from './model';
import * as Bake from './parts/Bake';
import * as Graph from './parts/Graph';
import * as Search from './parts/Search';
import * as Remeasure from './parts/Remeasure';
import * as Flow from './parts/Flow';
import type { LinkCounts } from './parts/Links';

export class NavGraph implements NavRef {
  ready = false;
  revision = 0;

  /* ── outdoor grid ── */
  /** Cells on a side. */
  readonly W = Math.ceil(MAP_SIZE / NAV_CELL_M);
  readonly cell = NAV_CELL_M;
  /** World X / Z of the grid's min corner. */
  readonly origin = -(Math.ceil(MAP_SIZE / NAV_CELL_M) * NAV_CELL_M) / 2;
  /** Per cell: surface height · flags (`F_*`). */
  readonly oh: Float32Array;
  readonly of: Uint8Array;
  /** Number of outdoor nodes (`W * W`) — region node ids start here. */
  readonly outdoorCount: number;

  /* ── regions · links ── */
  regions: Region[] = [];
  /** Every node, outdoor + regions. */
  total = 0;
  /** Explicit links (region ↔ outdoor seams and the special links), by node id. */
  readonly links = new Map<number, NavLink[]>();
  ladders: readonly LadderDef[] = [];
  /** One row per direction of every special link (`parts/Links`) — `NavLink.special` · the flow fields index it. */
  readonly specials: SpecialLink[] = [];
  readonly linkCounts: LinkCounts = { ladder: 0, climb: 0, window: 0 };
  /** Per `NavWorld.windows` index: 1 = the pane is whole (a dearer link — `Graph.neighbours`). Kept by `noteWindowBroken`. */
  windowWholeFlag = new Uint8Array(0);
  readonly windowIndex = new Map<string, number>();

  /* ── gates (`parts/Gates`) ── */
  readonly gates: NavGate[] = [];
  /** Bodies waiting outside each gate (`setGateLoad`), and a stamp bumped whenever one changes (a field rebuild trigger). */
  gateLoad = new Int32Array(0);
  gateLoadStamp = 0;

  /* ── flow fields (`parts/Flow`) ── */
  readonly flow = new Flow.FlowState();

  world: NavWorld | null = null;
  /** The bake in progress (null when done or not started). */
  job: Generator<void, void, void> | null = null;

  /* ── re-measure queue (`parts/Remeasure`) ── */
  /** 1 = queued, per outdoor cell. */
  readonly dirtyCell: Uint8Array;
  readonly dirtyCells: number[] = [];
  /** Queued region columns as `regionIndex * 2^20 + column` (a region never has 2^20 columns). */
  readonly dirtyCols: number[] = [];
  dirtyColSet = new Set<number>();
  remeasureT = 0;

  /* ── search scratch (`parts/Search`), sized once the bake knows `total` ── */
  g = new Float32Array(0);
  parent = new Int32Array(0);
  pkind = new Uint8Array(0);
  /** Per node: the `specials` row of the link the search came in by, -1 for a walk. */
  pspecial = new Int32Array(0);
  seen = new Uint32Array(0);
  closed = new Uint32Array(0);
  gen = 0;
  heapId = new Int32Array(4096);
  heapF = new Float32Array(4096);
  heapN = 0;
  /** Node ids of the last reconstructed path, start first. */
  readonly trail: number[] = [];

  constructor() {
    this.outdoorCount = this.W * this.W;
    this.oh = new Float32Array(this.outdoorCount);
    this.of = new Uint8Array(this.outdoorCount);
    this.dirtyCell = new Uint8Array(this.outdoorCount);
  }

  /** Starts baking a freshly generated world. The previous one (if any) is dropped. */
  start(world: NavWorld): void { Bake.start(this, world); }

  /** Drops everything (world cleared · a non-raid mode). `WorldRef.nav` stays null until the next `start`. */
  clear(): void { Bake.clear(this); }

  /** Per frame: bake within budget; once baked, re-measure changed cells at `NAV_REMEASURE_HZ` and build flow fields. */
  update(dt: number): void {
    if (this.job) { Bake.step(this, NAV_BAKE_BUDGET_MS); return; }
    if (!this.ready) return;
    this.remeasureT -= dt;
    if (this.remeasureT <= 0) {
      this.remeasureT = 1 / Math.max(0.1, NAV_REMEASURE_HZ);
      Remeasure.run(this, NAV_REMEASURE_BUDGET_MS);
    }
    Flow.update(this, dt, NAV_FLOW_BUDGET_MS);
  }

  /** `SpatialHash.onChange`: a collider appeared · vanished · moved over this circle. */
  readonly onHashChange = (x: number, z: number, r: number): void => { Remeasure.mark(this, x, z, r); };

  /* ── NavRef ── */

  createPath(): NavPath {
    return { status: 'pending', points: [], count: 0 };
  }

  findPath(from: THREE.Vector3, to: THREE.Vector3, can: number, out: NavPath): NavPathStatus {
    return Search.findPath(this, from, to, can, out);
  }

  walkable(from: THREE.Vector3, to: THREE.Vector3): boolean {
    if (!this.ready) return true;
    return Graph.walkLine(this, from.x, from.y, from.z, to.x, to.z, to.y);
  }

  /* ── NavRef, phase 2: flow fields · gates · windows ── */

  flowTo(key: string, goal: THREE.Vector3, can: number): NavFlow | null { return Flow.flowTo(this, key, goal, can); }

  createFlowStep(): NavFlowStep {
    return {
      aim: new THREE.Vector3(), kind: 'walk', from: new THREE.Vector3(), via: new THREE.Vector3(), to: new THREE.Vector3(),
      ladderId: null, windowId: null, gate: -1, gateDist: 0, dist: 0,
    };
  }

  setGateLoad(gate: number, waiting: number): void {
    if (gate < 0 || gate >= this.gateLoad.length) return;
    const n = Math.max(0, Math.floor(waiting) || 0);
    if (this.gateLoad[gate] === n) return;
    this.gateLoad[gate] = n;
    this.gateLoadStamp++;
  }

  windowWhole(windowId: string): boolean { return this.world?.windowWhole(windowId) ?? false; }

  breakWindow(windowId: string): void { this.world?.breakWindow(windowId); }

  /**
   * `Structures` reports every pane that broke — a bullet, a throwable, a bug, the wire, a late joiner's sync. The
   * window's link gets cheaper at once (`Graph.neighbours` reads the flag) and `revision` tells the fields to rebuild.
   */
  noteWindowBroken(windowId: string): void {
    const i = this.windowIndex.get(windowId);
    if (i !== undefined) this.windowWholeFlag[i] = 0;
    this.revision++;
  }

  /** Debug / smokes: counts, the last bake's timings and the flow fields' build cost. */
  debugInfo(): {
    ready: boolean; total: number; regions: number; links: number; revision: number; bakeMs: number; linksMs: number; gatesMs: number;
    gates: number; special: LinkCounts;
    flow: { live: number; building: boolean; builds: number; lastMs: number; avgMs: number; maxMs: number; lastNodes: number; lastFrames: number; lastBytes: number };
  } {
    let links = 0;
    for (const l of this.links.values()) links += l.length;
    const f = this.flow;
    return {
      ready: this.ready, total: this.total, regions: this.regions.length, links, revision: this.revision, bakeMs: this.bakeMs,
      linksMs: this.linksMs, gatesMs: this.gatesMs,
      gates: this.gates.length, special: { ...this.linkCounts },
      flow: {
        live: f.fields.filter((x) => x.live).length, building: f.building !== null, builds: f.builds,
        lastMs: f.lastMs, avgMs: f.builds > 0 ? f.sumMs / f.builds : 0, maxMs: f.maxMs,
        lastNodes: f.lastNodes, lastFrames: f.lastFrames, lastBytes: f.lastBytes,
      },
    };
  }

  /** Debug / smokes: the gate a point stands in (-1 with none) — the region column under it at the nearest height. */
  debugGateAt(x: number, y: number, z: number): number { return Graph.gateAt(this, x, y, z); }

  /** Debug / smokes: is there a walkable node under this point (within a storey of `y`)? */
  debugWalkableAt(x: number, y: number, z: number): boolean { return Graph.walkableAt(this, x, y, z); }

  /** Debug / smokes: every special link as plain data (`kind`, both ends, `via`, the pane). One row per direction. */
  debugSpecials(): { kind: string; from: number[]; to: number[]; via: number[]; windowId: string | null; ladderId: string | null }[] {
    const p = { x: 0, y: 0, z: 0 };
    return this.specials.map((s) => {
      Graph.nodePos(this, s.from, p); const from = [p.x, p.y, p.z];
      Graph.nodePos(this, s.to, p); const to = [p.x, p.y, p.z];
      return {
        kind: ['walk', 'ladder', 'climb', 'window'][s.kind], from, to, via: [s.viaX, s.viaY, s.viaZ],
        windowId: s.window >= 0 ? this.world?.windows[s.window]?.id ?? null : null,
        ladderId: s.ladder >= 0 ? this.ladders[s.ladder]?.id ?? null : null,
      };
    });
  }

  /** Wall-clock ms the bake took (sum of its slices), and the special links' · the gates' share of it. */
  bakeMs = 0;
  linksMs = 0;
  gatesMs = 0;
}

/** Grows a path buffer's waypoint pool to `n` (allocation only when a longer path than ever before comes in). */
export function ensurePoints(out: NavPath, n: number): void {
  while (out.points.length < n) {
    const w: NavWaypoint = { position: new THREE.Vector3(), kind: 'walk', ladderId: null, via: new THREE.Vector3(), windowId: null };
    out.points.push(w);
  }
}
