/**
 * src/inventory/QuickSwap.ts — the pure rule deciding **where a stack displaced by a 1:1 quick-slot swap goes**.
 *
 * 2026-09-10. `setQuickSlot` is a *move*, so the stack already on the wheel (= the occupant) needs a spot first
 * (the `InventorySystem.returnQuickToBag` contract — a wheel item is never silently discarded or dropped on the
 * ground). That spot used to be looked for **in the bag alone**, so **a full bag refused the swap itself**.
 * But a 1:1 swap needs no room in the bag — the incoming stack leaves the grid, **so its cell frees up**.
 *
 * The order (after the incoming stack has left the grid). It splits on **whether the source is the bag**:
 *
 *   bag → wheel : ① **the very cell** the incoming stack vacated (same rotation → the other) → ② anywhere in the bag.
 *   crate · stash → wheel : ① **the bag** → ② the cell it vacated (= that container's free spot) → ③ the source grid.
 *
 * With nowhere to put it, null — the caller refuses **changing nothing**.
 *
 * Reading the bag **first** when it comes from a container is deliberate: my consumable must not be left on a crate
 * floor while the bag has room (until then a crate → wheel swap always went to the bag, and that behaviour **when
 * there is room** is not changed by one line — what this file fixes is the side refused outright **when there is
 * none**). The vacated cell coming first from the bag is purely a matter of shape — a swapped stack sitting back in
 * place reads better (functionally `bag.autoPlace` finds that cell anyway).
 *
 * Nothing of mine can go into a multiplayer **shared crate** (host authority, `refusesIntoContainer`), so ①③ are
 * skipped there with `allowSource: false`.
 *
 * A pure module — it knows no events, no DOM and no `InventorySystem` (`__selftest__` drives it with two grids).
 */
import type { ItemInstance } from '@/shared';
import type { Grid } from './Grid';

/** The cell the incoming stack occupied in the source grid. */
export interface QuickSwapCell { x: number; y: number; rotated: boolean }

/** Where the displaced stack actually went. */
export type QuickSwapWhere = 'cell' | 'bag' | 'source';

export interface QuickSwapPlan {
  /** The stack pushed off the wheel that needs a spot. */
  occupant: ItemInstance;
  /** The bag grid (always a candidate). */
  bag: Grid;
  /** The grid the incoming stack was in (it may be the bag). null = a wheel ↔ wheel re-order, so there is no grid. */
  source: Grid | null;
  /** The cell the incoming stack vacated. Ignored when `source` is null. */
  cell: QuickSwapCell | null;
  /** The incoming stack's uid — what the preview reads as "this one is about to leave". */
  incomingUid: string;
  /** false = never into the source grid (a multiplayer shared crate). */
  allowSource: boolean;
}

/**
 * Reads whether the swap holds **changing nothing** (the drag highlight · `previewDrop`).
 *
 * It is called while the incoming stack is **still in the grid** — so ① passes that uid as `ignore` and reads the cell
 * as "about to free up". ②③ use `canAbsorb` and miss that cell (slightly conservative), which is fine because ① already
 * stands for it. True here while `applyQuickSwap` fails must never happen (the other way round is safe).
 */
export function canQuickSwap(plan: QuickSwapPlan): boolean {
  const { occupant, bag, source, cell, incomingUid, allowSource } = plan;
  const ignore = [occupant.uid, incomingUid];
  const intoCell = (): boolean => !!source && !!cell && allowSource
    && (source.canPlace(occupant, cell.x, cell.y, occupant.rotated, ignore)
      || source.canPlace(occupant, cell.x, cell.y, !occupant.rotated, ignore));
  const fromBag = source === bag;
  if (fromBag && intoCell()) return true;
  if (bag.canAbsorb(occupant)) return true;
  if (!fromBag && intoCell()) return true;
  if (source && allowSource && !fromBag && source.canAbsorb(occupant)) return true;
  return false;
}

/**
 * Actually places the displaced stack. Called **after the incoming stack has already left the grid**.
 * With nowhere to put it, `null`, and not one grid is touched (`autoPlace` is all-or-nothing).
 */
export function applyQuickSwap(plan: QuickSwapPlan): QuickSwapWhere | null {
  const { occupant, bag, source, cell, allowSource } = plan;
  const intoCell = (): boolean => !!source && !!cell && allowSource
    && (source.place(occupant, cell.x, cell.y, occupant.rotated)
      || source.place(occupant, cell.x, cell.y, !occupant.rotated));
  const fromBag = source === bag;
  if (fromBag && intoCell()) return 'cell';
  if (bag.autoPlace(occupant)) return 'bag';
  if (!fromBag && intoCell()) return 'cell';
  if (source && allowSource && !fromBag && source.autoPlace(occupant)) return 'source';
  return null;
}
