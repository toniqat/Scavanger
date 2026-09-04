import * as THREE from 'three';
import { Random } from '@/shared';
import type { LootRef } from '@/shared';
import { Grid, type DefLookup } from './Grid';

export const CONTAINER_COLS = 6;
export const CONTAINER_ROWS = 4;

/** A loot crate's rolled contents laid out on its own grid. */
export class Container {
  readonly grid: Grid;
  readonly position = new THREE.Vector3();
  /** `crate:looted` emitted once when the grid first becomes empty. */
  lootedEmitted = false;

  constructor(readonly id: string, readonly tier: number, position: THREE.Vector3, getDef: DefLookup) {
    this.grid = new Grid(CONTAINER_COLS, CONTAINER_ROWS, getDef);
    this.position.copy(position);
  }
}

/**
 * Cache of containers by id. First open rolls contents with a deterministic RNG
 * (`missionSeed ^ hash(containerId)`) and auto-places them largest-first.
 */
export class ContainerStore {
  private containers = new Map<string, Container>();

  constructor(private readonly getDef: DefLookup) {}

  get(id: string): Container | undefined { return this.containers.get(id); }

  getOrCreate(id: string, tier: number, position: THREE.Vector3, loot: LootRef, missionSeed: number): Container {
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
    this.containers.set(id, c);
    return c;
  }

  clear(): void { this.containers.clear(); }
}
