/**
 * src/world/nav/NavGraph.ts — **the raid's walkable graph** (`WorldRef.nav`, TODO A-18, 2026-09-21).
 *
 * `WorldSystem` hands it the finished world (`start`) at the end of a planet raid's generation and ticks it every
 * frame (`update`). The shape is in `model.ts`; the work is split the usual way:
 *  - `parts/Bake`      — measures every cell once, spread over frames (`NAV_BAKE_BUDGET_MS`), then links regions to
 *                        the outdoor grid and ladders to their floors;
 *  - `parts/Graph`     — node positions, neighbours on the fly, snapping a point to a node, the straight-line walk test;
 *  - `parts/Search`    — A* with a node budget, path reconstruction and smoothing;
 *  - `parts/Remeasure` — the cells under a collider that appeared · vanished · moved, measured again a few times a second.
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
  MAP_SIZE, NAV_BAKE_BUDGET_MS, NAV_CELL_M, NAV_REMEASURE_BUDGET_MS, NAV_REMEASURE_HZ,
  type LadderDef, type NavFlow, type NavFlowStep, type NavGate, type NavPath, type NavPathStatus, type NavRef, type NavWaypoint,
} from '@/shared';
import type { NavLink, NavWorld, Region } from './model';
import * as Bake from './parts/Bake';
import * as Graph from './parts/Graph';
import * as Search from './parts/Search';
import * as Remeasure from './parts/Remeasure';

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
  /** Explicit links (ladders, region ↔ outdoor seams), by node id. */
  readonly links = new Map<number, NavLink[]>();
  ladders: readonly LadderDef[] = [];

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
  pladder = new Int32Array(0);
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

  /** Per frame: bake within budget, then re-measure changed cells at `NAV_REMEASURE_HZ`. */
  update(dt: number): void {
    if (this.job) { Bake.step(this, NAV_BAKE_BUDGET_MS); return; }
    if (!this.ready) return;
    this.remeasureT -= dt;
    if (this.remeasureT > 0) return;
    this.remeasureT = 1 / Math.max(0.1, NAV_REMEASURE_HZ);
    Remeasure.run(this, NAV_REMEASURE_BUDGET_MS);
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

  /* ── NavRef, phase 2 (contract stubs — `parts/Flow` · `parts/Gates` · the window feed replace them) ── */

  readonly gates: NavGate[] = [];

  flowTo(_key: string, _goal: THREE.Vector3, _can: number): NavFlow | null { return null; }

  createFlowStep(): NavFlowStep {
    return {
      aim: new THREE.Vector3(), kind: 'walk', from: new THREE.Vector3(), via: new THREE.Vector3(), to: new THREE.Vector3(),
      ladderId: null, windowId: null, gate: -1, gateDist: 0, dist: 0,
    };
  }

  setGateLoad(_gate: number, _waiting: number): void { /* stub */ }

  windowWhole(_windowId: string): boolean { return false; }

  breakWindow(_windowId: string): void { /* stub */ }

  /** Debug / smokes: counts and the last bake's timings. */
  debugInfo(): { ready: boolean; total: number; regions: number; links: number; revision: number; bakeMs: number } {
    let links = 0;
    for (const l of this.links.values()) links += l.length;
    return { ready: this.ready, total: this.total, regions: this.regions.length, links, revision: this.revision, bakeMs: this.bakeMs };
  }

  /** Wall-clock ms the bake took (sum of its slices). */
  bakeMs = 0;
}

/** Grows a path buffer's waypoint pool to `n` (allocation only when a longer path than ever before comes in). */
export function ensurePoints(out: NavPath, n: number): void {
  while (out.points.length < n) {
    const w: NavWaypoint = { position: new THREE.Vector3(), kind: 'walk', ladderId: null, via: new THREE.Vector3(), windowId: null };
    out.points.push(w);
  }
}
