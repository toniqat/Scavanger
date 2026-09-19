/**
 * src/inventory/parts/Peek.ts — **what would be seen if this container were opened right now** (2026-09-12, the drone scan).
 *
 * Looks into a container that was never opened **without opening it** (`InventoryRef.peekContainerItems` · `peekSuppliedItems`;
 * the caller is `gadgets/drones/parts/Scan`). There is one rule — **roll exactly as the opening path rolls and fill exactly as
 * it fills** — because a scan that said 「서사」 must not turn up nothing when opened:
 *  - The roll: the same `shared/lootRolls.crateLootRandom(missionSeed, id)` → `loot.rollCrateOn(tier, rng, planet)` as `ContainerStore.getOrCreate`.
 *  - The fill: `autoPlace` into a grid of the same order · the same size as `Container.fill` — down to what overflows and drops out, and to stack merging.
 *    A corpse (`cols` given) is a grid grown in rows by `fitCorpseGrid`, exactly as in `openContainerItemsSized`.
 *  - Somebody else's takes: a `pendingTaken` settled while this client had not opened it yet is removed in roll order (`idx`) (`applyPending`).
 * A container already rolled returns exactly what is in it now.
 *
 * It touches none of the cache · `openedIds` · the search state · the events. **Copy instances** are put into the copy grid,
 * so a `qty` reduced by merging never leaks into the caller's list.
 */
import { crateLootRandom, type ItemInstance } from '@/shared';
import { ITEM_DEF_MAP } from '@/items';
import { Grid } from '../Grid';
import { CONTAINER_COLS, CONTAINER_ROWS } from '../Container';
import { fitCorpseGrid } from './CorpseLoot';
import type { InventorySystem } from '../InventorySystem';

const getDef = (defId: string) => ITEM_DEF_MAP.get(defId);

/** What is in a container already rolled on this client right now, else null. */
function current(sys: InventorySystem, id: string): readonly ItemInstance[] | null {
  const c = sys.containers.get(id);
  return c ? c.grid.items().map((p) => p.item) : null;
}

/** `Container.fill` + `ContainerStore.applyPending` on a copy grid. */
function simulateFill(sys: InventorySystem, id: string, items: readonly ItemInstance[], cols: number, rows: number): ItemInstance[] {
  const grid = new Grid(Math.max(1, Math.floor(cols)), Math.max(1, Math.floor(rows)), getDef);
  const order: string[] = [];
  for (const it of items) {
    if (!it) continue;
    const copy: ItemInstance = { ...it };
    order.push(copy.uid);
    grid.autoPlace(copy);
  }
  for (let idx = 0; idx < order.length; idx++) {
    const n = sys.containers.pendingTakenOf(id, idx);
    if (n <= 0) continue;
    const p = grid.get(order[idx]);
    if (!p) continue;
    const removed = Math.min(n, p.item.qty);
    p.item.qty -= removed;
    if (p.item.qty <= 0) grid.remove(order[idx]);
  }
  return grid.items().map((p) => p.item);
}

/** Crates · supply crates · containers already rolled. An unknown id with no `tier` gives null. */
export function peekContainerItems(sys: InventorySystem, containerId: string, tier?: number): readonly ItemInstance[] | null {
  if (typeof containerId !== 'string' || !containerId) return null;
  const cur = current(sys, containerId);
  if (cur) return cur;
  if (typeof tier !== 'number' || !Number.isFinite(tier) || tier < 1) return null;
  const rng = crateLootRandom(sys.missionSeed, containerId);   // the same `shared/lootRolls` formula as `ContainerStore.getOrCreate`
  // 2026-09-16: the roll rules (the locked room) come from the same `WorldRef.crateLootOpts` as the opening path (`InventorySystem.openContainer`)
  const items = sys.loot.rollCrateOn(tier, rng, sys.ctx.missionPlanet, sys.ctx.world?.crateLootOpts?.(containerId));
  return simulateFill(sys, containerId, items, CONTAINER_COLS, CONTAINER_ROWS);
}

/** Containers whose contents the caller supplies (corpses · key-opened structure containers). */
export function peekSuppliedItems(sys: InventorySystem, containerId: string, items: readonly ItemInstance[],
  cols?: number, rows?: number): readonly ItemInstance[] {
  const cur = typeof containerId === 'string' && containerId ? current(sys, containerId) : null;
  if (cur) return cur;
  const list = Array.isArray(items) ? items : [];
  if (typeof cols !== 'number' || !Number.isFinite(cols)) return simulateFill(sys, containerId, list, CONTAINER_COLS, CONTAINER_ROWS);
  const size = fitCorpseGrid(list, cols, typeof rows === 'number' && Number.isFinite(rows) ? rows : cols);
  return simulateFill(sys, containerId, list, size.cols, size.rows);
}
