import * as THREE from 'three';
import { Random } from '@/shared';
import type { ItemDef, LootRef } from '@/shared';
import { Grid, type DefLookup } from './Grid';
import { searchTimeFor } from './Gear';

export const CONTAINER_COLS = 6;
export const CONTAINER_ROWS = 4;

/**
 * A loot crate's rolled contents laid out on its own grid.
 *
 * **Search (감정)**: contents are not readable the moment the crate opens — each item counts down a
 * per-rarity timer (`searchTimeFor`) and only then reveals. Hidden items cannot be dragged, taken or
 * inspected. The 감정 skill (`derived.searchSpeedMul`) shortens every timer.
 */
export class Container {
  readonly grid: Grid;
  readonly position = new THREE.Vector3();
  /** `crate:looted` emitted once when the grid first becomes empty. */
  lootedEmitted = false;
  /** uid → seconds of search left. Absent = already revealed. */
  private hidden = new Map<string, number>();

  constructor(readonly id: string, readonly tier: number, position: THREE.Vector3, getDef: DefLookup) {
    this.grid = new Grid(CONTAINER_COLS, CONTAINER_ROWS, getDef);
    this.position.copy(position);
  }

  /* ── search ────────────────────────────────────────────────────────────── */

  /** Start the reveal countdown for every item currently in the grid. */
  beginSearch(getDef: DefLookup, searchSpeedMul: number): void {
    this.hidden.clear();
    for (const p of this.grid.items()) {
      const def = getDef(p.item.defId);
      if (!def) continue;
      this.hidden.set(p.item.uid, searchTimeFor(def, searchSpeedMul));
    }
  }

  isHidden(uid: string): boolean { return this.hidden.has(uid); }
  get hiddenCount(): number { return this.hidden.size; }

  /** Seconds left on one item's search (0 when revealed). */
  searchRemaining(uid: string): number { return this.hidden.get(uid) ?? 0; }

  /** Advance every timer; returns the uids revealed by this tick. */
  tickSearch(dt: number): string[] {
    if (this.hidden.size === 0) return [];
    const done: string[] = [];
    for (const [uid, left] of this.hidden) {
      const next = left - dt;
      if (next <= 0) { this.hidden.delete(uid); done.push(uid); }
      else this.hidden.set(uid, next);
    }
    return done;
  }

  revealAll(): void { this.hidden.clear(); }
}

/**
 * Cache of containers by id. First open rolls contents with a deterministic RNG
 * (`missionSeed ^ hash(containerId)`) and auto-places them largest-first.
 */
export class ContainerStore {
  private containers = new Map<string, Container>();

  constructor(private readonly getDef: DefLookup) {}

  get(id: string): Container | undefined { return this.containers.get(id); }

  getOrCreate(
    id: string, tier: number, position: THREE.Vector3, loot: LootRef, missionSeed: number,
    searchSpeedMul = 1,
  ): Container {
    let c = this.containers.get(id);
    if (c) {
      c.position.copy(position);
      return c;
    }
    c = new Container(id, tier, position, this.getDef);
    const rng = new Random(((missionSeed >>> 0) ^ Random.hash(id)) >>> 0);
    const items = loot.rollCrate(tier, rng);
    for (const item of items) {
      if (!c.grid.autoPlace(item)) {
        console.warn(`[Inventory] container ${id}: dropped '${item.defId}' (no room)`);
      }
    }
    c.beginSearch(this.getDef, searchSpeedMul);
    this.containers.set(id, c);
    return c;
  }

  clear(): void { this.containers.clear(); }
}

/** Re-exported for the UI so it does not need to import `Gear` for one type. */
export type ContainerDefLookup = (defId: string) => ItemDef | undefined;
