import * as THREE from 'three';
import { Random } from '@/shared';
import type { ItemInstance, LootRef } from '@/shared';
import { Grid, type DefLookup } from './Grid';

export const CONTAINER_COLS = 6;
export const CONTAINER_ROWS = 4;

/** Default loot-window title for caller-supplied containers (`openContainerItems`) without a `title`. */
export const CONTAINER_DEFAULT_TITLE = '컨테이너';

/**
 * A container's contents laid out on its own grid: a loot crate (`tier` ≥ 1, contents rolled
 * from the tier table) or a caller-supplied container such as a corpse (`tier` 0, `title` set).
 */
export class Container {
  readonly grid: Grid;
  readonly position = new THREE.Vector3();
  /** `crate:looted` emitted once when the grid first becomes empty. */
  lootedEmitted = false;

  constructor(readonly id: string, readonly tier: number, position: THREE.Vector3, getDef: DefLookup,
    /** Loot-window title; undefined → the tier label. */
    public title?: string) {
    this.grid = new Grid(CONTAINER_COLS, CONTAINER_ROWS, getDef);
    this.position.copy(position);
  }

  /** Auto-place `items` largest-first (callers pre-sort); overflow is dropped with a warning. */
  fill(items: readonly ItemInstance[]): void {
    for (const item of items) {
      if (!this.grid.autoPlace(item)) {
        console.warn(`[Inventory] container ${this.id}: dropped '${item.defId}' (no room)`);
      }
    }
  }
}

/**
 * Cache of containers by id. First open of a crate rolls contents with a deterministic RNG
 * (`missionSeed ^ hash(containerId)`); first open of a caller-supplied container places the
 * given items. Both auto-place largest-first; later opens show what is left.
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
    c.fill(loot.rollCrate(tier, rng));
    this.containers.set(id, c);
    return c;
  }

  /**
   * Container with caller-supplied contents (corpses). `items` are only used on the first open
   * for this id; a known id ignores them and shows its remaining contents. `title` updates the cached one.
   */
  getOrCreateWithItems(id: string, items: readonly ItemInstance[], position: THREE.Vector3, title?: string): Container {
    let c = this.containers.get(id);
    if (c) {
      c.position.copy(position);
      if (title) c.title = title;
      return c;
    }
    c = new Container(id, 0, position, this.getDef, title ?? CONTAINER_DEFAULT_TITLE);
    c.fill(items);
    this.containers.set(id, c);
    return c;
  }

  clear(): void { this.containers.clear(); }
}
