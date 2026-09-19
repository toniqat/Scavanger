/**
 * src/housing/parts/Deliver.ts — **which grid a harvest goes into** (2026-09-12).
 *
 * The single path by which the grow station · analyzer · culture tank hand one product to the player. The three used
 * to call `tryAddItemAnywhere` (bag → ship stash) each on their own, but the screens have to be able to pick
 * 「double-click = the ship stash first」 · 「dropped on the bag grid = the bag only」, so it was gathered here
 * (`HarvestDestination`, the contract).
 *
 * A named grid (`'bag'` · `'stash'`) **never overflows into the other** — a full drop target is a refusal.
 */
import type { HarvestDestination, ItemInstance } from '@/shared';
import type { HousingSystem } from '../HousingSystem';

/**
 * **The cell the cursor is over** (2026-09-16, user's report 「dragging something mounted out has to put it in the grid
 * cell the cursor is over」).
 *
 * Whichever screen it was dragged out of, `tryAddItem*` used to pick the **first free cell** — where it was dropped and
 * where it landed differed. Now the drag-and-drop path (`ui/ProductDrag`) notes 「it was dropped at these coordinates」
 * here once, and only the **one handover** that happens in between goes to that cell. The signatures are not changed
 * because the handover happens deep inside the rule functions (`takeShelfItem` · `removeClusterCores` · `harvestAt` …
 * — all of them meet in the one `deliverItem`).
 * ⚠ It lives only for one synchronous call: `withDropCell` always clears it in `finally`.
 */
interface DropCell {
  view: { placeExternalAt(item: ItemInstance, x: number, y: number): 'bag' | 'stash' | 'blocked' | null };
  x: number;
  y: number;
}
let dropCell: DropCell | null = null;

/** Run `fn` with "the player dropped it here" set (null = the plain rule). Always cleared, even when `fn` throws. */
export function withDropCell<T>(cell: DropCell | null, fn: () => T): T {
  const prev = dropCell;
  dropCell = cell;
  try { return fn(); } finally { dropCell = prev; }
}

/**
 * Whether the handover just now was blocked by **the dropped-on cell** (2026-09-16). `noRoomReason`, which picks the
 * reason text, asks right afterwards and clears it — a one-cell memory so an empty bag is never told 「가방에 자리가 없습니다」.
 */
let blockedCell = false;

/** Put `item` where `dest` says. Returns the grid it landed in, or null when there was no room. */
export function deliverItem(sys: HousingSystem, item: ItemInstance, dest: HarvestDestination = 'bag-first'): 'bag' | 'stash' | null {
  const inv = sys.ctx.inventory;
  if (!inv) return null;
  const cell = dropCell;
  if (cell) {
    dropCell = null;                 // used **once only** (a rule that hands over several times falls back to the plain rule from the second on)
    const at = cell.view.placeExternalAt(item, cell.x, cell.y);
    // dropped on a cell, that cell is the answer — a blocked cell is refused, **not pushed into another cell** (where it was dropped is the result).
    if (at) { blockedCell = at === 'blocked'; return at === 'blocked' ? null : at; }
    // null = dropped outside the grid (a header row · a margin) → on to the plain rule below
  }
  const bag = (): 'bag' | null => (typeof inv.tryAddItem === 'function' && inv.tryAddItem(item) ? 'bag' : null);
  const stash = (): 'stash' | null => (typeof inv.tryAddToStash === 'function' && inv.tryAddToStash(item) ? 'stash' : null);
  switch (dest) {
    case 'bag': return bag();
    case 'stash': return stash();
    case 'stash-first': return stash() ?? bag();
    default:
      return typeof inv.tryAddItemAnywhere === 'function' ? inv.tryAddItemAnywhere(item) : bag();
  }
}

/** The Korean 「no room」 reason — it names the grid that was picked. */
export function noRoomReason(dest: HarvestDestination = 'bag-first'): string {
  if (blockedCell) { blockedCell = false; return '그 칸에는 놓을 수 없습니다'; }
  if (dest === 'bag') return '가방에 자리가 없습니다';
  if (dest === 'stash') return '함선 창고에 자리가 없습니다';
  return '가방과 창고에 자리가 없습니다';
}
