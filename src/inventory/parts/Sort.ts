/**
 * src/inventory/parts/Sort.ts — **auto-sorting the bag · stash** (2026-09-12, user's decision).
 *
 * The order: category (`SORT_CATEGORY_ORDER`) → rarity (highest first) → size (largest first) → name → quantity.
 * Stacks of the same item are merged up to `stackMax` while sorting. Packing runs **row by row from the top**
 * (`Grid.findFreeSlot`'s row-first search) and tries the landscape orientation first.
 *
 * **An item is never lost.** When the category order does not all fit (a large item late, fragmenting the grid) it
 * packs once more by size; failing that `snapshot()` restores **the pre-sort state exactly** (merged qty too) and 'fail'.
 */
import type { ItemDef, ItemInstance } from '@/shared';
import { normalizeMealQuality, rarityRank } from '@/shared';
import { ITEM_DEF_MAP } from '@/items';
import { stackKeyOf, type Grid } from '../Grid';
import { SORT_CATEGORY_ORDER, type OpResult } from '../model';
import type { InventorySystem } from '../InventorySystem';

const area = (def: ItemDef | undefined): number => (def ? def.width * def.height : 0);

function categoryRank(def: ItemDef | undefined): number {
  const i = def ? SORT_CATEGORY_ORDER.indexOf(def.category) : -1;
  return i < 0 ? SORT_CATEGORY_ORDER.length : i;
}

/**
 * The sort order itself (exported for the smoke tests' expectations).
 * 2026-09-12 (E1, user's decision): given `isFavorite`, **favourited defs come first**, and inside them the normal order.
 */
export function compareForSort(a: ItemInstance, b: ItemInstance, isFavorite?: (defId: string) => boolean): number {
  const da = ITEM_DEF_MAP.get(a.defId), db = ITEM_DEF_MAP.get(b.defId);
  const fa = isFavorite?.(a.defId) ? 0 : 1, fb = isFavorite?.(b.defId) ? 0 : 1;
  return (fa - fb)
    || (categoryRank(da) - categoryRank(db))
    || ((db ? rarityRank(db.rarity) : -1) - (da ? rarityRank(da.rarity) : -1))
    || (area(db) - area(da))
    || (da?.name ?? a.defId).localeCompare(db?.name ?? b.defId, 'ko')
    // 2026-09-13 (meal quality): among equal meals more stars come first (different qualities never merge, so they stand apart)
    || (normalizeMealQuality(b.quality) - normalizeMealQuality(a.quality))
    || (b.qty - a.qty)
    || a.uid.localeCompare(b.uid);
}

/**
 * Fold same-def stacks into as few stacks as `stackMax` allows (largest first). `keep` uids are left untouched — the
 * 기업 거래 desk has them staged in a tray by uid. Returns the stacks that still hold something.
 */
function mergeStacks(items: readonly ItemInstance[], keep?: (uid: string) => boolean): ItemInstance[] {
  // 2026-09-12 (item recovery contract): groups are def + stack key — a raid-found stack never folds into a brought one
  const groups = new Map<string, { max: number; list: ItemInstance[] }>();
  for (const it of items) {
    const def = ITEM_DEF_MAP.get(it.defId);
    if (!def || def.stackMax <= 1 || keep?.(it.uid)) continue;
    const key = `${it.defId}|${stackKeyOf(it)}`;
    const g = groups.get(key);
    if (g) g.list.push(it); else groups.set(key, { max: def.stackMax, list: [it] });
  }
  for (const { max, list: g } of groups.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => b.qty - a.qty);
    let left = g.reduce((s, it) => s + it.qty, 0);
    let moved = false;
    for (const it of g) { const q = Math.min(max, left); if (q !== it.qty) moved = true; it.qty = q; left -= q; }
    // units moved between stacks with different marks → none of them keeps a mark (the grid snapshot restores it on 'fail')
    if (moved && g.some((it) => it.raidFound !== g[0].raidFound)) for (const it of g) delete it.raidFound;
  }
  return items.filter((it) => it.qty > 0);
}

/** Place `order` into the (cleared) grid row-first; false as soon as one item does not fit. */
function pack(grid: Grid, order: readonly ItemInstance[]): boolean {
  for (const item of order) {
    const slot = grid.findFreeSlot(item, false);
    if (!slot || !grid.place(item, slot.x, slot.y, slot.rotated)) return false;
  }
  return true;
}

const layoutKey = (entries: readonly { uid: string; x: number; y: number; rotated: boolean; qty: number }[]): string =>
  entries.map((e) => `${e.uid}@${e.x},${e.y},${e.rotated ? 1 : 0}:${e.qty}`).sort().join(';');

/**
 * Sort the 가방 or the 함선 창고. The stash only in the ship (it is not reachable anywhere else). 'noop' when the grid was
 * already in order, 'fail' when the items could not be repacked (nothing changed then).
 */
export function sortGrid(sys: InventorySystem, gridId: 'bag' | 'stash', keep?: (uid: string) => boolean): OpResult {
  if (gridId === 'stash' && !sys.ctx.isHubPhase()) return 'fail';
  const grid = sys.getGrid(gridId);
  if (!grid) return 'fail';
  const items = grid.items().map((p) => p.item);
  if (items.length === 0) return 'noop';
  const snap = grid.snapshot();
  const before = layoutKey(snap.placements.map((p) => ({ uid: p.item.uid, x: p.x, y: p.y, rotated: p.rotated, qty: p.qty })));

  const merged = mergeStacks(items, keep);
  const fav = (defId: string): boolean => sys.isFavorite(defId);   // 2026-09-12 (E1): favourites first
  grid.clear();
  if (!pack(grid, [...merged].sort((a, b) => compareForSort(a, b, fav)))) {
    grid.clear();
    const bySize = [...merged].sort((a, b) => (area(ITEM_DEF_MAP.get(b.defId)) - area(ITEM_DEF_MAP.get(a.defId))) || compareForSort(a, b, fav));
    if (!pack(grid, bySize)) { grid.restore(snap); return 'fail'; }
  }

  const after = layoutKey(grid.items().map((p) => ({ uid: p.item.uid, x: p.x, y: p.y, rotated: p.item.rotated, qty: p.item.qty })));
  if (after === before) return 'noop';
  sys.afterChange();
  return 'ok';
}
