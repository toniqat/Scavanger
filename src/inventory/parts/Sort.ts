/**
 * src/inventory/parts/Sort.ts — **가방 · 창고 자동 정렬** (2026-09-12, 사용자 결정).
 *
 * 순서: 카테고리(`SORT_CATEGORY_ORDER`) → 등급(높은 것 먼저) → 크기(큰 것 먼저) → 이름 → 수량.
 * 같은 아이템의 스택은 정렬하면서 `stackMax` 까지 합친다. 채우기는 **위에서부터 줄 단위**(`Grid.findFreeSlot` 의
 * 행 우선 탐색)이고, 가로로 누운 모양을 먼저 시도한다.
 *
 * **아이템을 절대 잃지 않는다.** 카테고리 순서로 다 안 들어가면(큰 것이 뒤에 오며 조각이 난 경우) 크기 순으로 한 번
 * 더 채워 보고, 그것도 안 되면 `snapshot()` 으로 **정렬 전 그대로** 되돌린 뒤 'fail' 이다 (합친 수량까지 복원된다).
 */
import type { ItemDef, ItemInstance } from '@/shared';
import { rarityRank } from '@/shared';
import { ITEM_DEF_MAP } from '@/items';
import type { Grid } from '../Grid';
import { SORT_CATEGORY_ORDER, type OpResult } from '../model';
import type { InventorySystem } from '../InventorySystem';

const area = (def: ItemDef | undefined): number => (def ? def.width * def.height : 0);

function categoryRank(def: ItemDef | undefined): number {
  const i = def ? SORT_CATEGORY_ORDER.indexOf(def.category) : -1;
  return i < 0 ? SORT_CATEGORY_ORDER.length : i;
}

/** The sort order itself (exported for the smoke tests' expectations). */
export function compareForSort(a: ItemInstance, b: ItemInstance): number {
  const da = ITEM_DEF_MAP.get(a.defId), db = ITEM_DEF_MAP.get(b.defId);
  return (categoryRank(da) - categoryRank(db))
    || ((db ? rarityRank(db.rarity) : -1) - (da ? rarityRank(da.rarity) : -1))
    || (area(db) - area(da))
    || (da?.name ?? a.defId).localeCompare(db?.name ?? b.defId, 'ko')
    || (b.qty - a.qty)
    || a.uid.localeCompare(b.uid);
}

/**
 * Fold same-def stacks into as few stacks as `stackMax` allows (largest first). `keep` uids are left untouched — the
 * 기업 거래 desk has them staged in a tray by uid. Returns the stacks that still hold something.
 */
function mergeStacks(items: readonly ItemInstance[], keep?: (uid: string) => boolean): ItemInstance[] {
  const groups = new Map<string, ItemInstance[]>();
  for (const it of items) {
    const def = ITEM_DEF_MAP.get(it.defId);
    if (!def || def.stackMax <= 1 || keep?.(it.uid)) continue;
    const g = groups.get(it.defId);
    if (g) g.push(it); else groups.set(it.defId, [it]);
  }
  for (const [defId, g] of groups) {
    if (g.length < 2) continue;
    const max = ITEM_DEF_MAP.get(defId)!.stackMax;
    g.sort((a, b) => b.qty - a.qty);
    let left = g.reduce((s, it) => s + it.qty, 0);
    for (const it of g) { const q = Math.min(max, left); it.qty = q; left -= q; }
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
  grid.clear();
  if (!pack(grid, [...merged].sort(compareForSort))) {
    grid.clear();
    const bySize = [...merged].sort((a, b) => (area(ITEM_DEF_MAP.get(b.defId)) - area(ITEM_DEF_MAP.get(a.defId))) || compareForSort(a, b));
    if (!pack(grid, bySize)) { grid.restore(snap); return 'fail'; }
  }

  const after = layoutKey(grid.items().map((p) => ({ uid: p.item.uid, x: p.x, y: p.y, rotated: p.item.rotated, qty: p.item.qty })));
  if (after === before) return 'noop';
  sys.afterChange();
  return 'ok';
}
