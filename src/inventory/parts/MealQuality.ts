/**
 * src/inventory/parts/MealQuality.ts — **stacks carrying a meal quality** (2026-09-13, cooking minigames · user's decision).
 *
 * The rules (tier · stars · the bonus) live in `shared/cooking.ts`; this file holds only **how the inventory carries** a quality:
 *  - The quality goes into the stack key — that one line is in `Grid.stackKeyOf` (every merge path reads it).
 *  - Splits · copies move the quality with `copyMealQuality` (called next to `copyRaidFoundMark`). Unlike the recovery
 *    contract mark it is **not stripped when the raid ends** — the quality is part of the meal.
 *  - The three queries the dining table · cook bench use: `countDefQualityAll` · `consumeDefQualityAll` · `getMealStacks` (bag + stash).
 * One cook's gate · consumption · product (`cookBlock` · `completeCook`) are one body with ship workbench crafting, so they live in `parts/Crafting.ts`.
 */
import type { ItemDef, ItemInstance } from '@/shared';
import { normalizeMealQuality } from '@/shared';
import { ITEM_DEF_MAP } from '@/items';
import type { InventorySystem } from '../InventorySystem';

/** An instance's quality (0 … `MEAL_QUALITY_MAX`, no field = 0). */
export function mealQualityOf(item: Pick<ItemInstance, 'quality'> | null | undefined): number {
  return item ? normalizeMealQuality(item.quality) : 0;
}

/** The split · copied stack (`created`) inherits the quality of the original stack (`from`) (0 deletes the field). */
export function copyMealQuality(created: ItemInstance, from: Pick<ItemInstance, 'quality'>): void {
  const q = mealQualityOf(from);
  if (q > 0) created.quality = q;
  else delete created.quality;
}

/** Is it `defId` with a quality of exactly `quality` (`quality` 0 includes a missing field)? */
function matches(item: ItemInstance, defId: string, quality: number): boolean {
  return item.defId === defId && mealQualityOf(item) === quality;
}

/** How many `defId` in the bag (+ pouch · the wheel) + stash carry a quality of exactly `quality`. */
export function countDefQualityAll(sys: InventorySystem, defId: string, quality: number): number {
  const q = normalizeMealQuality(quality);
  let n = sys.countWhere((d, inst) => d.id === defId && mealQualityOf(inst) === q);
  for (const p of sys.stash.grid.items()) if (matches(p.item, defId, q)) n += p.item.qty;
  return n;
}

/**
 * Takes `qty` of `defId` at a quality of exactly `quality`, the bag first (smallest stack up · pouch · the wheel in
 * `consumeWhere` order) → the stash. All or nothing — short, it takes nothing and returns false (the shape of `consumeDefAll`).
 */
export function consumeDefQualityAll(sys: InventorySystem, defId: string, quality: number, qty: number): boolean {
  const want = Math.max(0, Math.floor(qty));
  if (want === 0) return true;
  const q = normalizeMealQuality(quality);
  if (countDefQualityAll(sys, defId, q) < want) return false;
  let left = want;
  const pred = (d: ItemDef, inst: ItemInstance): boolean => d.id === defId && mealQualityOf(inst) === q;
  const carried = sys.countWhere(pred);
  if (carried > 0) left -= sys.consumeWhere(pred, Math.min(left, carried));
  if (left > 0) {
    const stash = sys.stash.grid;
    const stacks = stash.items().filter((p) => matches(p.item, defId, q)).sort((a, b) => a.item.qty - b.item.qty);
    for (const p of stacks) {
      if (left <= 0) break;
      const take = Math.min(left, p.item.qty);
      p.item.qty -= take; left -= take;
      if (p.item.qty <= 0) stash.remove(p.item.uid);
      else stash.version++;
    }
    sys.afterChange();
  }
  return left === 0;
}

/** The meals held (`ItemDef.meal`) summed per (def, quality) — bag (+ pouch · the wheel) + stash. Sorted tier → name → highest quality. */
export function getMealStacks(sys: InventorySystem): { defId: string; quality: number; qty: number }[] {
  const acc = new Map<string, { defId: string; quality: number; qty: number }>();
  const add = (item: ItemInstance | null | undefined): void => {
    if (!item || item.qty <= 0 || !ITEM_DEF_MAP.get(item.defId)?.meal) return;
    const quality = mealQualityOf(item);
    const key = `${item.defId}|${quality}`;
    const cur = acc.get(key);
    if (cur) cur.qty += item.qty; else acc.set(key, { defId: item.defId, quality, qty: item.qty });
  };
  for (const p of sys.bag.items()) add(p.item);
  for (const p of sys.pouch.items()) add(p.item);
  for (const it of sys.quickSlots) add(it);
  for (const p of sys.stash.grid.items()) add(p.item);
  const tierOf = (id: string): number => ITEM_DEF_MAP.get(id)?.meal?.tier ?? 0;
  const nameOf = (id: string): string => ITEM_DEF_MAP.get(id)?.name ?? id;
  return [...acc.values()].sort((a, b) =>
    (tierOf(a.defId) - tierOf(b.defId))
    || nameOf(a.defId).localeCompare(nameOf(b.defId), 'ko')
    || a.defId.localeCompare(b.defId)
    || (b.quality - a.quality));
}
