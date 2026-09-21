/**
 * src/inventory/parts/DropResolver.ts — **the drag-and-drop judgement**.
 *
 * It answers only the two questions the UI asks — *what happens if it lands here* (`preview*`, the tile highlight
 * colour) and *actually place it* (`drop` / `quickMove` / `activate` / `rotateItem` / `attachFrom`). Swap · merge ·
 * equipment slot · quick slot · socket · partial quantity (Shift/Ctrl drag) are all this file's rules, and no DOM.
 */
import type {
  ItemDef, ItemInstance, LoadoutSlot, SocketSlot,
} from '@/shared';
import { QUICK_SLOTS, isQuickSlotActive } from '@/shared';
/* appended (2026-09-12): item recovery contracts — the stack key · merging / splitting the mark */
import { copyRaidFoundMark, mergeRaidFoundMark } from '@/shared';
import { copyMealQuality } from './MealQuality';
import { ITEM_DEF_MAP, isWeaponItemDef } from '@/items';
import { Grid, OOB, canStackTogether, type Placement, type PriorityPlacement } from '../Grid';
import { setSocket } from '../Sockets';
import { isQuickIndex, isQuickUsable, lockedQuickItems } from '../QuickSlots';
/* appended (2026-09-10): the wheel swap rule — `previewDrop` and `setQuickSlot` read the same plan */
import { canQuickSwap } from '../QuickSwap';
/* appended (2026-09-14): consumables auto-seated on a quick slot (game-wide) — one set of 「picked it up」 rules */
import { autoQuickIndexFor, takeIntoQuick } from './AutoQuick';
import { QUICK_DIR_GLYPH, SLOT_LABEL } from '../ui/labels';
import {
  LOADOUT_SLOTS, slotAccepts, type DropPreview, type DropTarget, type GridId, type ItemLocation, type OpResult, type SlotId,
} from '../model';
import type { InventorySystem } from '../InventorySystem';

/** Slot a double-click / `장착` sends a weapon to: first empty primary slot, else 주무기 I (swap). Armor / bags → their slot. */
export function equipTargetFor(sys: InventorySystem, def: ItemDef): LoadoutSlot | null {
  if (def.category === 'bag') return 'bag';
  if (def.category === 'armor') return 'armor';
  if (def.category === 'pouch') return 'pouch';   // A-15: a fixed single slot (`POUCH_SLOTS`)
  /* 2026-09-19: **`secondary` is not a slot** — `LOADOUT_SLOTS` never builds one and `slotAccepts` refuses it, so
     naming it here only produced a `장착` entry that always failed and a bag double-click that answered `fail`
     instead of falling back to `quickMoveImpl`. `null` = 「no equipment slot」, which is what it is. The category
     itself is kept (saves · crew cards read it) — README `Equipment slots`. No item def carries it today. */
  if (def.category === 'secondary') return null;
  if (def.category !== 'primary') return null;
  if (!sys.loadout.primary) return 'primary';
  if (!sys.loadout.primary2) return 'primary2';
  return 'primary';
}

/** Split size a Shift (half) / Ctrl (one) drag would carry, or null when the item cannot be split. */
export function partialQtyFor(sys: InventorySystem, item: ItemInstance, mode: 'half' | 'one'): number | null {
  const def = ITEM_DEF_MAP.get(item.defId);
  if (!def || def.stackMax <= 1 || item.qty < 2) return null;
  return mode === 'one' ? 1 : Math.max(1, Math.floor(item.qty / 2));
}

/** Non-mutating classification of a partial-stack drag (`qty` units of `uid`) onto `target`. */
export function previewPartial(sys: InventorySystem, uid: string, from: ItemLocation, qty: number, target: DropTarget): DropPreview {
  // 2026-09-12: a split stack onto a wheel slot — free slot = a new stack, same item = a merge (`previewQuickPartial`)
  if (target.kind === 'quick') return sys.previewQuickPartial(target.index, uid, from, qty);
  const v = sys.validatePartial(uid, from, qty, target);
  if (!v) return 'bad';
  const { item, def, grid, blockers } = v;
  if (blockers.length === 0) return 'ok';
  if (blockers.length !== 1 || blockers[0] === OOB) return 'bad';
  if (blockers[0] === uid) return 'noop';
  const other = grid.get(blockers[0]);
  return other && canStackTogether(other.item, item) && other.item.qty < def.stackMax ? 'merge' : 'bad';
}

/**
 * Execute a partial-stack drag: onto a free cell → new stack of `qty` there; onto a same-def stack → merge
 * (capped by `stackMax`); onto the source or anything else → nothing.
 */
export function dropPartial(sys: InventorySystem, uid: string, from: ItemLocation, qty: number, target: DropTarget): OpResult {
  const takes = sys.isContainerLoc(from) && !(target.kind === 'grid' && target.grid === 'container');
  if (takes) return sys.guardedTake(uid, from, Math.floor(qty), () => sys.dropPartialImpl(uid, from, qty, target));
  return sys.dropPartialImpl(uid, from, qty, target);
}

export function dropPartialImpl(sys: InventorySystem, uid: string, from: ItemLocation, qty: number, target: DropTarget): OpResult {
  if (target.kind === 'quick') return sys.dropQuickPartial(target.index, uid, from, qty);
  const v = sys.validatePartial(uid, from, qty, target);
  if (!v || target.kind !== 'grid' || from.kind !== 'grid') return 'fail';
  const { item, def, grid, blockers } = v;
  const to: ItemLocation = { kind: 'grid', grid: target.grid };
  const srcGrid = sys.getGrid(from.grid);
  if (!srcGrid) return 'fail';

  if (blockers.length === 0) {
    /* 2026-09-19: **the cells are asked for before the instance is minted.** `validatePartial` already measured this
       exact footprint with a probe that ignores nothing, so the answer here is always yes — but the same probe is run
       again so that a refusal can never happen *after* `loot.createItem`, which would throw away a fresh instance and
       burn its uid. Every other path in this file keeps the same discipline (`snapshot` / `restore`, or check first). */
    const probe: ItemInstance = { uid: '__split__', defId: item.defId, qty, rotated: target.rotated };
    if (!grid.canPlace(probe, target.x, target.y, target.rotated, probe.uid)) return 'fail';
    const created = sys.loot.createItem(item.defId, qty);
    copyRaidFoundMark(created, item);   // 2026-09-12: a split keeps the raid-found mark
    copyMealQuality(created, item);     // 2026-09-13: …and the meal quality
    if (!grid.place(created, target.x, target.y, target.rotated)) return 'fail';   // unreachable — the probe above said yes
    item.qty -= qty;
    srcGrid.version++;
    if (sys.locKind(from) !== sys.locKind(to)) sys.emitTransfer(created, def, from, to);
    sys.ctx.bus.emit('inventory:itemSplit', { source: item, created });
    sys.afterChange();
    return 'ok';
  }
  if (blockers.length !== 1 || blockers[0] === OOB) return 'fail';
  if (blockers[0] === uid) return 'noop';
  const other = grid.get(blockers[0]);
  if (!other || !canStackTogether(other.item, item) || other.item.searched === false) return 'fail';
  const moved = Math.min(def.stackMax - other.item.qty, qty);
  if (moved <= 0) return 'fail';
  other.item.qty += moved;
  item.qty -= moved;
  mergeRaidFoundMark(other.item, item);
  grid.version++;
  srcGrid.version++;
  if (sys.locKind(from) !== sys.locKind(to)) sys.emitTransfer({ ...item, qty: moved }, def, from, to);
  sys.afterChange();
  return 'ok';
}

export function validatePartial(sys: InventorySystem, uid: string, from: ItemLocation, qty: number, target: DropTarget): { item: ItemInstance; def: ItemDef; grid: Grid; blockers: string[] } | null {
  if (from.kind !== 'grid' || target.kind !== 'grid') return null;
  if (sys.isItemLocked(uid, from) || sys.refusesIntoContainer(from, target)) return null;
  if (sys.ctx.isMultiplayer && from.grid === 'container' && target.grid === 'container') return null; // no local splits of shared contents
  const item = sys.findItem(uid, from);
  const def = item && ITEM_DEF_MAP.get(item.defId);
  if (!item || !def || def.stackMax <= 1) return null;
  if (target.grid === 'pouch' && !sys.pouchAccepts(def)) return null;   // A-15
  const n = Math.floor(qty);
  if (!Number.isFinite(n) || n < 1 || n >= item.qty) return null;
  const grid = sys.getGrid(target.grid);
  if (!grid) return null;
  const probe: ItemInstance = { uid: '__split__', defId: item.defId, qty: n, rotated: target.rotated };
  return { item, def, grid, blockers: grid.blockersAt(probe, target.x, target.y, target.rotated, probe.uid) };
}

/** Non-mutating classification used for the drag highlight. */
export function previewDrop(sys: InventorySystem, uid: string, from: ItemLocation, target: DropTarget): DropPreview {
  const item = sys.findItem(uid, from);
  const def = item && ITEM_DEF_MAP.get(item.defId);
  if (!item || !def) return 'bad';
  if (sys.isItemLocked(uid, from) || sys.refusesIntoContainer(from, target)) return 'bad';

  if (target.kind === 'weapon') return sys.previewAttach(uid, from, target.uid, target.loc);

  if (target.kind === 'quick') {
    // 2026-09-09: the wheel is its own container — a grid stack **moves** in, and a stack already on the wheel
    // may be re-ordered between slots (that one never touches the bag).
    // 2026-09-10: the source grid is **any** grid, not just the bag — a crate (container) or the ship stash goes
    // straight onto the wheel. A container source is a take like any other, so `drop` sends it through `guardedTake`.
    if ((from.kind !== 'grid' && from.kind !== 'quick') || !isQuickUsable(def)) return 'bad';
    if (!isQuickIndex(target.index) || !isQuickSlotActive(target.index, sys.getQuickSlotCount())) return 'bad';
    const occupant = sys.quickSlots[target.index];
    if (occupant?.uid === uid) return 'noop';
    // 2026-09-12 (user's decision): a slot with the same item **merges**, not swaps (the overflow stays on the cursor)
    // 2026-09-12 (item recovery contract): a raid-found stack and a brought one are not "the same item" — swap instead
    if (occupant && canStackTogether(occupant, item) && def.stackMax > 1 && occupant.qty < def.stackMax && item.searched !== false) return 'merge';
    /*
     * 2026-09-10 — **a 1:1 swap does not require room in the bag.** This used to read `sys.bag.canAbsorb(occupant)`
     * alone, and that check runs while the incoming stack is **still in the grid**, so it never counted the cell the
     * stack is about to vacate. So a full bag turned a `bag → wheel` swap red at the preview stage (= `dropImpl`
     * failing outright), and `crate → wheel` was refused because `setQuickSlot` looked for the displaced stack in the
     * bag alone. Both now read the same `QuickSwap` rule — the vacated cell → the bag → the source grid.
     */
    if (occupant && from.kind !== 'quick') {
      const src = sys.getGrid(from.grid);
      const p = src?.get(uid);
      const cell = p ? { x: p.x, y: p.y, rotated: item.rotated } : null;
      if (!canQuickSwap(sys.quickSwapPlan(occupant, src ?? null, from.grid, cell, uid))) return 'bad';
    }
    return occupant ? 'swap' : 'ok';
  }

  if (target.kind === 'slot') {
    if (!slotAccepts(def, target.slot)) return 'bad';
    const current = sys.loadout[target.slot];
    if (from.kind === 'slot') {
      if (from.slot === target.slot) return 'noop';
      if (target.slot === 'bag' || from.slot === 'bag' || target.slot === 'pouch' || from.slot === 'pouch') return 'bad';
      return current ? 'swap' : 'ok';
    }
    if (!current) return 'ok';
    if (target.slot === 'bag') return 'swap'; // the displaced bag is placed first in the resized grid
    // A-15: a pouch swap is judged all-or-nothing by `changePouch` too (the contents have to fit the bag)
    if (target.slot === 'pouch') return 'swap';
    return sys.canPlaceDisplaced(current, from, uid) ? 'swap' : 'bad';
  }

  const grid = sys.getGrid(target.grid);
  if (!grid) return 'bad';
  // A-15: the pouch grid refuses anything outside `PouchDef.accepts` (with no pouch there is no grid at all)
  if (target.grid === 'pouch' && !sys.pouchAccepts(def)) return 'bad';
  if (from.kind === 'grid' && from.grid === target.grid) {
    const p = grid.get(uid);
    if (p && p.x === target.x && p.y === target.y && item.rotated === target.rotated) return 'noop';
  }
  const blockers = grid.blockersAt(item, target.x, target.y, target.rotated, uid);
  if (from.kind === 'slot' && from.slot === 'bag' && target.grid !== 'bag') return 'bad';
  // A-15: an equipped pouch comes off into the bag or stash only (never a crate — as `dropImpl`'s pouch branch judges)
  if (from.kind === 'slot' && from.slot === 'pouch' && (target.grid === 'pouch' || target.grid === 'container')) return 'bad';
  if (blockers.length === 0) return 'ok';
  if (blockers.length !== 1 || blockers[0] === OOB) return 'bad';
  const other = grid.get(blockers[0]);
  if (!other) return 'bad';
  if (target.grid === 'container' && other.item.searched === false) return 'bad'; // never touch an unsearched item
  if (canStackTogether(other.item, item) && def.stackMax > 1 && other.item.qty < def.stackMax) return 'merge';
  // A-15: a swap is also a move of the displaced stack **into the pouch** — if the pouch refuses it, the swap is off
  if (from.kind === 'grid' && from.grid === 'pouch' && !sys.pouchAccepts(ITEM_DEF_MAP.get(other.item.defId))) return 'bad';
  if (from.kind === 'slot') {
    const od = ITEM_DEF_MAP.get(other.item.defId);
    return od && slotAccepts(od, from.slot) ? 'swap' : 'bad';
  }
  // a stack on the wheel has no grid cells to trade — drop it on an empty cell (or merge) instead
  if (from.kind !== 'grid') return 'bad';
  // multiplayer: a swap would put my item into the container (not shared) — refused
  if (sys.ctx.isMultiplayer && (from.grid === 'container') !== (target.grid === 'container')) return 'bad';
  return sys.canSwap(item, from.grid, other.item, grid) ? 'swap' : 'bad';
}

/**
 * Free footprint **closest to (x, y)** for `uid` (living at `from`) inside `gridId`, preferring `rotated`.
 * Null when the item does not fit anywhere.
 *
 * The drag UI uses this for an **equipment slot → grid** drag only: aiming a 4×2 weapon at a grid that has a
 * single small item under the cursor used to refuse the drop outright (red highlight, snap back to the slot and
 * shake), even with half the bag empty. The highlight now retargets to the spot the item really lands on.
 */
export function nearestFreeSpot(sys: InventorySystem, uid: string, from: ItemLocation, gridId: GridId, x: number, y: number, rotated: boolean): { x: number; y: number; rotated: boolean } | null {
  const item = sys.findItem(uid, from);
  const def = item && ITEM_DEF_MAP.get(item.defId);
  const grid = sys.getGrid(gridId);
  if (!item || !def || !grid) return null;
  if (gridId === 'pouch' && !sys.pouchAccepts(def)) return null;   // A-15
  const orientations = def.width !== def.height ? [rotated, !rotated] : [rotated];
  let best: { x: number; y: number; rotated: boolean } | null = null;
  let bestD = Infinity;
  for (const rot of orientations) {
    const { w, h } = grid.footprintOf(item, rot);
    for (let gy = 0; gy + h <= grid.rows; gy++) {
      for (let gx = 0; gx + w <= grid.cols; gx++) {
        if (!grid.canPlace(item, gx, gy, rot, uid)) continue;
        // slight bias to the requested orientation so a fitting rotation is not preferred over an equal-distance one
        const d = (gx - x) * (gx - x) + (gy - y) * (gy - y) + (rot === rotated ? 0 : 0.5);
        if (d < bestD) { bestD = d; best = { x: gx, y: gy, rotated: rot }; }
      }
    }
  }
  return best;
}

/** Execute a drag-and-drop. Container → player moves go through `guardedTake` (Phase 7). */
export function drop(sys: InventorySystem, uid: string, from: ItemLocation, target: DropTarget): OpResult {
  if (sys.refusesIntoContainer(from, target)) return 'fail';
  // 2026-09-10: a **wheel** target is a take too (crate → quick slot). Before that the wheel could only be fed from the
  // bag, so it was excluded here; leaving it excluded now would move a shared container stack without telling the host.
  const takes = sys.isContainerLoc(from) && !(target.kind === 'grid' && target.grid === 'container');
  if (takes) return sys.guardedTake(uid, from, null, () => sys.dropImpl(uid, from, target));
  if (sys.isItemLocked(uid, from)) return 'fail';
  return sys.dropImpl(uid, from, target);
}

export function dropImpl(sys: InventorySystem, uid: string, from: ItemLocation, target: DropTarget): OpResult {
  const item = sys.findItem(uid, from);
  const def = item && ITEM_DEF_MAP.get(item.defId);
  if (!item || !def) return 'fail';
  if (target.kind === 'weapon') return sys.attachFromImpl(uid, from, target.uid, target.loc);
  if (target.kind === 'quick') {
    const pv = sys.previewDrop(uid, from, target);
    if (pv === 'bad') return 'fail';
    if (pv === 'noop') return 'noop';
    if (pv === 'merge') return sys.mergeIntoQuickSlot(target.index, uid, from) ? 'ok' : 'fail';
    return sys.setQuickSlot(target.index, uid) ? 'ok' : 'fail';
  }
  if (target.kind === 'slot') return sys.dropOnSlot(item, def, from, target.slot);

  const grid = sys.getGrid(target.grid);
  if (!grid) return 'fail';
  const to: ItemLocation = { kind: 'grid', grid: target.grid };
  // A-15: only what the pouch grid accepts (the same judgement as the preview)
  if (target.grid === 'pouch' && !sys.pouchAccepts(def)) return 'fail';

  if (from.kind === 'grid' && from.grid === target.grid) {
    const p = grid.get(uid);
    if (p && p.x === target.x && p.y === target.y && item.rotated === target.rotated) return 'noop';
  }

  const blockers = grid.blockersAt(item, target.x, target.y, target.rotated, uid);
  if (blockers.includes(OOB)) return 'fail';

  /*
   * 2026-09-11 (A-15) — dragging an equipped pouch into a grid. It is intercepted here for **the same reason** as
   * the bag: a plain `detach` would leave the pouch grid's contents with nowhere to go. `changePouch` moves the
   * contents into the bag, and refuses the move itself when even one of them does not fit.
   */
  if (from.kind === 'slot' && from.slot === 'pouch') {
    if (target.grid === 'container' || target.grid === 'pouch') return 'fail';
    if (blockers.length === 0) return sys.changePouch(null, null, 'grid', { x: target.x, y: target.y }, target.grid);
    if (blockers.length !== 1) return 'fail';
    const other = grid.get(blockers[0]);
    const od = other && ITEM_DEF_MAP.get(other.item.defId);
    if (!other || !od || od.category !== 'pouch') return 'fail';
    return sys.changePouch(other.item, to, 'grid', { x: other.x, y: other.y }, target.grid);
  }

  // the equipped bag dragged into the grid: unequip (grid shrinks, bag lands at the target cell if it still exists)
  if (from.kind === 'slot' && from.slot === 'bag') {
    if (target.grid !== 'bag') return 'fail';
    if (blockers.length === 0) return sys.changeBag(null, null, 'grid', { x: target.x, y: target.y });
    if (blockers.length !== 1) return 'fail';
    const other = grid.get(blockers[0]);
    const od = other && ITEM_DEF_MAP.get(other.item.defId);
    if (!other || !od || od.category !== 'bag') return 'fail';
    return sys.changeBag(other.item, to, 'grid', { x: other.x, y: other.y });
  }

  if (blockers.length === 0) {
    if (from.kind === 'grid' && from.grid === target.grid) {
      if (!grid.moveTo(uid, target.x, target.y, target.rotated)) return 'fail';
      sys.afterChange();
      return 'ok';
    }
    sys.detach(item, from);
    grid.place(item, target.x, target.y, target.rotated);
    sys.afterMove(item, from, to);
    return 'ok';
  }

  if (blockers.length !== 1) return 'fail';
  const other = grid.get(blockers[0]);
  if (!other) return 'fail';
  if (target.grid === 'container' && other.item.searched === false) return 'fail';

  // stack merge
  if (canStackTogether(other.item, item) && def.stackMax > 1 && other.item.qty < def.stackMax) {
    const moved = grid.mergeInto(item, other.item.uid);
    if (moved <= 0) return 'fail';
    if (item.qty <= 0) {
      // 2026-09-09: nothing to relink any more — `detach` empties the wheel slot when the stack came from there
      sys.detach(item, from);
      sys.afterMove(item, from, to, moved);
    } else {
      // partial merge: item stays where it was (qty reduced)
      if (from.kind === 'grid') { const g = sys.getGrid(from.grid); if (g) g.version++; }
      if (sys.locKind(from) !== sys.locKind(to)) sys.emitTransfer({ ...item, qty: moved }, def, from, to);
      sys.afterChange();
    }
    return 'ok';
  }

  // swap with the single blocking item
  if (from.kind === 'slot') {
    const od = ITEM_DEF_MAP.get(other.item.defId);
    if (!od || !slotAccepts(od, from.slot)) return 'fail';
    grid.remove(other.item.uid);
    sys.loadout[from.slot] = other.item;
    grid.place(item, target.x, target.y, target.rotated);
    sys.emitTransfer(other.item, od, to, from);
    sys.emitTransfer(item, def, from, to);
    sys.emitLoadout();
    sys.afterChange();
    return 'ok';
  }
  if (from.kind !== 'grid') return 'fail';   // wheel stack: no cells to trade (see `previewDrop`)
  // A-15: a swap where the displaced stack goes into the pouch — refused if the pouch does not take it (as the preview)
  if (from.grid === 'pouch' && !sys.pouchAccepts(ITEM_DEF_MAP.get(other.item.defId))) return 'fail';
  const srcGrid = sys.getGrid(from.grid);
  if (!srcGrid) return 'fail';
  if (sys.ctx.isMultiplayer && (from.grid === 'container') !== (target.grid === 'container')) return 'fail';
  if (!sys.performSwap(item, srcGrid, other.item, grid, target.x, target.y, target.rotated)) return 'fail';
  if (from.grid !== target.grid) {
    const od = ITEM_DEF_MAP.get(other.item.defId);
    if (from.grid === 'container') item.searched = true;
    sys.emitTransfer(item, def, from, to);
    if (od) sys.emitTransfer(other.item, od, to, from);
  }
  sys.afterChange();
  return 'ok';
}

/**
 * Where a quick move from `from` goes right now (null = nowhere — the move would fail). `quickMoveImpl` uses exactly this,
 * and the right-click menu (2026-09-12, E1) names the 「빠른 이동」 entry after it. Whether the item still **fits** there
 * is not checked (that stays the move's own refusal + `inventory:full`).
 */
export function quickMoveDest(sys: InventorySystem, from: ItemLocation): GridId | null {
  let dest: GridId;
  if (from.kind === 'slot') dest = 'bag';
  // 2026-09-09: right-click = back into the bag. 2026-09-10: with a crate open it goes straight into that crate.
  else if (from.kind === 'quick') dest = sys.activeContainer ? 'container' : 'bag';
  // 2026-09-11 (A-15): a right-click in the pouch goes to the bag (the same as a quick slot)
  else if (from.grid === 'container' || from.grid === 'stash' || from.grid === 'pouch') dest = 'bag';
  else if (sys.activeContainer) dest = 'container';
  else if (sys.hubMode) dest = 'stash';
  else return null;
  if (dest === 'container' && sys.ctx.isMultiplayer) return null; // Phase 7: nothing goes into a shared container
  return dest;
}

/** Right-click quick action: container ↔ bag auto-place; slot → bag (the bag slot shrinks the grid first). */
export function quickMove(sys: InventorySystem, uid: string, from: ItemLocation): OpResult {
  if (sys.isContainerLoc(from)) return sys.guardedTake(uid, from, null, () => sys.quickMoveImpl(uid, from));
  return sys.quickMoveImpl(uid, from);
}

export function quickMoveImpl(sys: InventorySystem, uid: string, from: ItemLocation): OpResult {
  const item = sys.findItem(uid, from);
  const def = item && ITEM_DEF_MAP.get(item.defId);
  if (!item || !def) return 'fail';
  if (from.kind === 'slot' && from.slot === 'bag') return sys.changeBag(null, null, 'grid');
  // A-15: a right-click on the equipped pouch also goes through `changePouch` (the contents move to the bag first)
  if (from.kind === 'slot' && from.slot === 'pouch') return sys.changePouch(null, null, 'grid');
  const dest = quickMoveDest(sys, from);
  if (!dest) return 'fail';
  const grid = sys.getGrid(dest);
  if (!grid) return 'fail';
  if (!grid.canAbsorb(item)) {
    if (dest === 'bag') sys.ctx.bus.emit('inventory:full', { item, name: def.name });
    return 'fail';
  }
  sys.detach(item, from);
  grid.autoPlace(item);
  sys.afterMove(item, from, { kind: 'grid', grid: dest });
  return 'ok';
}

/**
 * Double-click. **2026-09-14 2nd pass (user's decision) — 「a free spot means straight there」 is now every grid's rule.**
 * Pressed in a crate · corpse · ship stash · bag · pouch alike it reads the one `tryAutoPlace` set (`empty equipment
 * slot → empty implant slot → empty quick slot`) first, and falls to the old path (bag → `inventory:full`) only with none.
 */
export function activate(sys: InventorySystem, uid: string, from: ItemLocation): OpResult {
  if (sys.isContainerLoc(from)) return sys.guardedTake(uid, from, null, () => sys.activateImpl(uid, from));
  return sys.activateImpl(uid, from);
}

export function activateImpl(sys: InventorySystem, uid: string, from: ItemLocation): OpResult {
  const item = sys.findItem(uid, from);
  const def = item && ITEM_DEF_MAP.get(item.defId);
  if (!item || !def) return 'fail';
  // An unsearched crate stack can go nowhere (the UI blocks it already — `InventoryUI.locked` — but this is the last
  // door. From the 2026-09-14 2nd pass ① the equipment slots come before the bag, so this line precedes `dropOnSlot`).
  if (sys.isItemLocked(uid, from)) return 'fail';
  // An equipment-slot tile: it is already in place (the 'noop' the old `equipTargetFor` slot branch gave).
  if (from.kind === 'slot') return 'noop';
  // A wheel tile: a quick move as before (the crate when one is open, else the bag — `quickMoveDest`).
  if (from.kind !== 'grid') return sys.quickMoveImpl(uid, from);
  /*
   * **2026-09-14 2nd pass (user's decision)** — 「double-clicking an item equips it (or seats it on the wheel) when a
   * slot is free」. The three branches that differed per grid (stash, crate, bag) became **one set**.
   *
   * 2026-09-10's **「what is found in a crate always goes to the bag first」 (user's decision) was not overturned.**
   * What it protects is *the gun · armor in hand silently changing while picking up*, and `tryAutoPlace` fills only
   * **empty** slots — displacing equipped gear is still only a drag or the menu's 「장착」 (`ui/parts/ContextMenu` →
   * `equip`). The 2026-09-12 stash exception and 2026-09-14's 「crate consumable → free wheel slot」 (`AutoQuick`) fold in.
   *
   * Two branches are left, for different reasons:
   *   • **how it is announced** — the stash toasts as before (`notifySentTo`), the rest flash that slot (`flashPlaced`).
   *   • **the bag does not read ③ (an empty wheel slot)** — a bag tile's double-click already has its own wheel
   *     gesture (`ui/InventoryUI.tileHandlers` intercepts with `registerQuick` while no crate is open), and with a
   *     crate open a bag double-click means **into the crate** (the menu's 「빠른 이동 (상자)」 carries a `더블클릭`
   *     hint). Reading the wheel first here would make that hint a lie.
   */
  const fromBag = from.grid === 'bag';
  const placed = tryAutoPlace(sys, item, def, from, from.grid === 'stash' ? notifySentTo : flashPlaced, !fromBag);
  if (placed) return placed;
  /*
   * No free spot → **the old path unchanged**.
   *
   * ⚠ The bag **still** goes through `equipTargetFor` (= it swaps even when full). The user's request was to **add**
   * 「equip it when a slot is not equipped」, not to remove the bag's swap — take it out and double-clicking a gun in
   * the bag in the common mid-raid state of two full primary slots becomes `fail` + a refusal sound, and an existing
   * gesture disappears. So only the order changed: **a free slot means straight there** (new rule), else the swap.
   */
  if (fromBag) {
    const slot = sys.equipTargetFor(def);
    if (slot) return sys.dropOnSlot(item, def, from, slot);
    return sys.quickMoveImpl(uid, from);
  }
  if (sys.bag.canAbsorb(item)) return sys.quickMoveImpl(uid, from);
  /*
   * 2026-09-10's fallback (`activateFallback`) is all that is left — the sweep of `empty equipment slot → implant
   * slot → empty quick slot` ran **already** above and nothing changed since (`bag.canAbsorb` is pure), so it went.
   */
  sys.ctx.bus.emit('inventory:full', { item, name: def.name });
  return 'fail';
}

/**
 * 2026-09-14 (user's decision) — **two ways of saying where it went.**
 *
 *  • `notifySentTo` — a stash double-click that **deliberately** sent it to an equipment slot · implant slot · quick
 *    slot. It is an intended move, so the one `ui:notify` line (`{name} → {where}`) appears as before.
 *  • `flashPlaced` — sent from a crate · corpse · bag · pouch. The slot it really landed in flashes in place
 *    (`InventoryUI.flashSlot` / `flashQuick` / `flashImplant`) instead of raising the `가방이 가득 찼습니다 — …` toast
 *    this case used to raise. A toast sits in a screen corner and was easy to miss while the eye was on the crate.
 *    ⚠ Only **this** case lost the toast: `inventory:full` (and with it that line — `ui/hud/Notifications`) is still
 *    emitted where nothing at all could take the item — `quickMoveImpl`'s bag branch and `activateImpl`'s last line.
 *
 * **2026-09-14 2nd pass — a crate · corpse going straight into a free slot is `flashPlaced` too** (the same reasoning
 * extended): the eye is on the crate grid then, and the equipment slots · wheel are right beside it in the same
 * window. Only the stash keeps the toast — 「stash → equipment」 is launch prep's **intended instruction** (1st stands).
 *
 * So `tryAutoPlace` takes a **「placed」 callback** rather than a phrase — it hands over the spot (`slot` · `quick` ·
 * `implant`) together with the label, so the caller picks between a toast and flashing the slot.
 */
type PlacedAt = { kind: 'slot'; slot: LoadoutSlot } | { kind: 'quick'; index: number } | { kind: 'implant' };
type OnPlaced = (sys: InventorySystem, def: ItemDef, where: string, at: PlacedAt) => void;

const notifySentTo: OnPlaced = (sys, def, where) => {
  sys.ctx.bus.emit('ui:notify', { text: `${def.name} → ${where}`, kind: 'info', duration: 2.2 });
};

const flashPlaced: OnPlaced = (sys, _def, _where, at) => {
  const ui = sys.ui;
  if (!ui) return;
  if (at.kind === 'slot') ui.flashSlot(at.slot);
  else if (at.kind === 'quick') ui.flashQuick(at.index);
  else ui.flashImplant();
};

/**
 * Sweeps the **empty slots it belongs in**, in order, and sends it there. Null when nowhere took it (nothing moved).
 *
 *   ① an **empty** equipment slot (주무기 I · II · 가방 · 방탄복 · 주머니). Equipped gear is never silently displaced.
 *   ② an empty implant slot for an implant item (`ctx.progression.equipImplant`; ship only, and as that function
 *      reads the bag · stash alone it is in practice a press in the **ship stash**. In a raid crate it fails silently).
 *   ③ an **empty** wheel slot for a consumable the wheel takes (`quick` false skips it — the bag branch, `activateImpl`).
 *
 * All three place **only into empty slots**. That is how 2026-09-10's 「what is in hand never changes silently while
 * picking up」 stays alive in every grid — equipped gear is displaced only by a drag or the menu's 「장착」.
 *
 * On success it says **where it went** — the caller chooses how (`onPlaced`: a toast for the stash, a flash for the rest).
 *
 * 2026-09-12: ①②③ lifted straight out of `activateFallback` (2026-09-10). From the 2026-09-14 2nd pass **every grid's
 * double-click reads this one first** (`activateImpl`).
 */
function tryAutoPlace(
  sys: InventorySystem, item: ItemInstance, def: ItemDef, from: ItemLocation, onPlaced: OnPlaced, quick = true,
): OpResult | null {
  const slot = emptyEquipTargetFor(sys, def);
  if (slot) {
    const r = sys.dropOnSlot(item, def, from, slot);
    if (r === 'ok') { onPlaced(sys, def, SLOT_LABEL[slot], { kind: 'slot', slot }); return r; }
  }

  if (def.implant && !def.implant.broken) {
    const prog = sys.ctx.progression;
    if (prog && typeof prog.equipImplant === 'function' && prog.equipImplant(item.uid)) {
      onPlaced(sys, def, '임플란트 칸', { kind: 'implant' });
      return 'ok';
    }
  }

  /*
   * 2026-09-14 2nd pass — ③ was unified on `parts/AutoQuick.autoQuickIndexFor` (before, only `firstFreeQuickSlot`).
   * It is `takeIntoQuick`'s two lines spelled out, differing only in that **the label needs the slot number**. So
   * 「a def already on the wheel eats no new slot」 (one slot = one def) and the unsearched refusal bind every source alike.
   */
  if (quick) {
    const index = autoQuickIndexFor(sys, item, def);
    if (index >= 0 && sys.setQuickSlot(index, item.uid)) {
      onPlaced(sys, def, `퀵슬롯 ${QUICK_DIR_GLYPH[index] ?? String(index + 1)}`, { kind: 'quick', index });
      return 'ok';
    }
  }

  return null;
}

/**
 * **Would a double-click send this item to a free spot right now** — asks `tryAutoPlace`'s order **changing nothing**.
 * It was added in the 2026-09-14 2nd pass so the right-click menu can attach the `더블클릭` hint to its 「빠른 이동」
 * row accurately (`ui/parts/ContextMenu`): with a free spot a double-click does **not** quick-move, so the hint lies.
 *
 * Only the implant is an approximation — `equipImplant` is a function only a real attempt answers, so room is read
 * from `implantSlots − implantSlotsUsed` alone (the ship gate lives in `equipImplant`). Enough for one hint line.
 */
export function wouldAutoPlace(sys: InventorySystem, item: ItemInstance, def: ItemDef, quick = true): boolean {
  if (emptyEquipTargetFor(sys, def)) return true;
  const imp = def.implant;
  if (imp && !imp.broken) {
    const prog = sys.ctx.progression;
    if (prog && sys.hubMode && prog.implantSlots - prog.implantSlotsUsed >= (imp.slots ?? 1)) return true;
  }
  return quick && autoQuickIndexFor(sys, item, def) >= 0;
}

/** The currently **empty** equipment slot that accepts this item. Unlike `equipTargetFor` it displaces nothing. */
function emptyEquipTargetFor(sys: InventorySystem, def: ItemDef): LoadoutSlot | null {
  for (const slot of LOADOUT_SLOTS) {
    if (!slotAccepts(def, slot)) continue;
    if (!sys.loadout[slot]) return slot;
  }
  return null;
}

export function rotateItem(sys: InventorySystem, uid: string, gridId: GridId): OpResult {
  const grid = sys.getGrid(gridId);
  const p = grid?.get(uid);
  if (!grid || !p) return 'fail';
  if (gridId === 'container' && p.item.searched === false) return 'fail';
  const def = ITEM_DEF_MAP.get(p.item.defId);
  if (!def || def.width === def.height) return 'noop';
  if (!grid.rotate(uid)) return 'fail';
  sys.ctx.bus.emit('inventory:itemRotated', { item: p.item });
  sys.afterChange();
  return 'ok';
}

/**
 * "모두 가져가기": move every **searched** container item into the bag that fits (largest first). Returns the moved
 * count — on a multiplayer client the number of takes requested (each lands on its `cont taken`).
 */
export function takeAll(sys: InventorySystem): number {
  const c = sys.activeContainer;
  if (!c) return 0;
  const from: ItemLocation = { kind: 'grid', grid: 'container' };
  const items = c.grid.items().map((p) => p.item).filter((it) => it.searched !== false).sort((a, b) => sys.area(b) - sys.area(a));
  let moved = 0;
  let fullReported = false;
  for (const item of items) {
    const def = ITEM_DEF_MAP.get(item.defId);
    if (!def) continue;
    // 2026-09-14: with a full bag a consumable an **empty wheel slot** would take still passes (`takeOne` moves it there)
    if (!sys.bag.canAbsorb(item) && autoQuickIndexFor(sys, item, def) < 0) {
      if (!fullReported) { fullReported = true; sys.ctx.bus.emit('inventory:full', { item, name: def.name }); }
      continue;
    }
    const r = sys.guardedTake(item.uid, from, null, () => sys.takeOne(item.uid));
    if (r === 'ok' || r === 'pending') moved++;
  }
  return moved;
}

/** One container item into the bag (auto-place, `inventory:itemAdded`). */
export function takeOne(sys: InventorySystem, uid: string): OpResult {
  const c = sys.activeContainer;
  const p = c?.grid.get(uid);
  const def = p && ITEM_DEF_MAP.get(p.item.defId);
  if (!c || !p || !def) return 'fail';
  /*
   * 2026-09-14 (user's decision — consumables auto-seated on a quick slot, **game-wide**): 「모두 가져가기」 is a pickup
   * where nobody chooses a destination. A wheel-usable consumable with a **free slot** goes there before the bag.
   */
  if (takeIntoQuick(sys, p.item, def)) return 'ok';
  if (!sys.bag.canAbsorb(p.item)) { sys.ctx.bus.emit('inventory:full', { item: p.item, name: def.name }); return 'fail'; }
  c.grid.remove(uid);
  p.item.searched = true;
  sys.bag.autoPlace(p.item);
  sys.ctx.bus.emit('inventory:itemAdded', { item: p.item, name: def.name, rarity: def.rarity });
  sys.afterChange();
  return 'ok';
}

/**
 * **2026-09-12 (user's decision) — attachments go into a gun sitting in the stash too.**
 *
 * The attach path's gate was `locKind(loc) === 'player'`, but **the ship stash is `'container'`** (`locKind` means
 * "is moving it a transfer", and putting something in the stash is). So a gun left in the stash could not take a
 * single scope — it had to be pulled into the bag and put back. Rather than change what `locKind` means, the stash is
 * allowed explicitly **on the attach path only** — crates · corpses (`'container'`) are someone else's, still refused.
 */
export function canSocketAt(sys: InventorySystem, loc: ItemLocation): boolean {
  if (sys.locKind(loc) === 'player') return true;
  return loc.kind === 'grid' && loc.grid === 'stash';
}

/**
 * Bumps the `version` of the grid holding the weapon whose socket changed — that is what redraws its tile (`GridView`
 * is version-gated). 2026-09-12: this used to read the bag only, so a stashed gun's socket pips never refreshed.
 */
function bumpWeaponGrid(sys: InventorySystem, weapon: ItemInstance): void {
  if (sys.bag.has(weapon.uid)) { sys.bag.version++; return; }
  const stash = sys.getGrid('stash');
  if (stash?.has(weapon.uid)) stash.version++;
}

/**
 * Where an attachment pulled out of a socket goes: bag → (in the ship) stash → the ground. The stash was inserted on
 * 2026-09-12 — a full bag must not throw a stashed gun's attachment onto the floor inside the ship.
 */
function stowDetached(sys: InventorySystem, att: ItemInstance): void {
  if (sys.bag.autoPlace(att)) return;
  if (sys.hubMode && sys.tryAddToStash(att)) return;
  sys.throwToWorld(att, true);
}

/** Can attachment `uid` (at `from`) be socketed into weapon `weaponUid` (at `loc`)? */
export function previewAttach(sys: InventorySystem, uid: string, from: ItemLocation, weaponUid: string, loc: ItemLocation): DropPreview {
  if (sys.isItemLocked(uid, from)) return 'bad';
  const att = sys.findItem(uid, from);
  const attDef = att && ITEM_DEF_MAP.get(att.defId);
  const weapon = sys.findItem(weaponUid, loc);
  if (!att || !attDef?.attachment || !weapon || from.kind !== 'grid') return 'bad';
  if (!canSocketAt(sys, loc) || !isWeaponItemDef(ITEM_DEF_MAP.get(weapon.defId))) return 'bad';
  if (!sys.loot.canAttach(weapon, att)) return 'bad';
  return weapon.sockets?.[attDef.attachment.socket] ? 'swap' : 'ok';
}

/**
 * Socket attachment `uid` into weapon `weaponUid`. The previous attachment in that socket returns to the bag
 * (or drops to the ground when nothing fits). Emits `inventory:socketChanged`, `inventory:itemUpdated`.
 */
export function attachFrom(sys: InventorySystem, uid: string, from: ItemLocation, weaponUid: string, loc: ItemLocation): OpResult {
  if (sys.isContainerLoc(from)) return sys.guardedTake(uid, from, 1, () => sys.attachFromImpl(uid, from, weaponUid, loc));
  return sys.attachFromImpl(uid, from, weaponUid, loc);
}

export function attachFromImpl(sys: InventorySystem, uid: string, from: ItemLocation, weaponUid: string, loc: ItemLocation): OpResult {
  if (sys.previewAttach(uid, from, weaponUid, loc) === 'bad' || from.kind !== 'grid') return 'fail';
  const att = sys.findItem(uid, from)!;
  const attDef = ITEM_DEF_MAP.get(att.defId)!;
  const weapon = sys.findItem(weaponUid, loc)!;
  const socket: SocketSlot = attDef.attachment!.socket;
  const grid = sys.getGrid(from.grid);
  if (!grid) return 'fail';
  grid.remove(att.uid);
  if (from.grid === 'container') att.searched = true;
  const prev = setSocket(weapon, socket, att);
  if (from.grid === 'container') sys.ctx.bus.emit('inventory:itemAdded', { item: att, name: attDef.name, rarity: attDef.rarity });
  if (prev) stowDetached(sys, prev);
  bumpWeaponGrid(sys, weapon);
  sys.ctx.bus.emit('inventory:socketChanged', { weapon, socket, attachment: att });
  sys.afterSocketChange(weapon);
  sys.afterChange();
  return 'ok';
}

/** After a socket change: a smaller magazine spills its excess rounds into the bag; weapons re-read the instance. */
export function afterSocketChange(sys: InventorySystem, weapon: ItemInstance): void {
  const stats = sys.loot.getEffectiveStats(weapon);
  if (stats && weapon.ammoInMag !== undefined && weapon.ammoInMag > stats.magSize) {
    const excess = weapon.ammoInMag - stats.magSize;
    weapon.ammoInMag = stats.magSize;
    sys.returnRounds(stats.ammoType, excess);
  }
  sys.ctx.bus.emit('inventory:itemUpdated', { item: weapon });
}

/**
 * Equip `next` (null = unequip) as the bag. The grid is resized to the new bag; the displaced bag is placed
 * first (at `hint`, else the new bag's former cells, else the first free slot), everything else is relocated
 * around it and whatever no longer fits is dropped into the world (`inventory:bagChanged.dropped`).
 * Refused (nothing changes) only when the displaced bag itself cannot fit the new grid at all.
 * `from` null with a `next` = a detached instance (catalog drag) that lives in no grid yet.
 */
export function changeBag(sys: InventorySystem, next: ItemInstance | null, from: ItemLocation | null, oldTo: 'grid' | 'world', hint?: { x: number; y: number }): OpResult {
  const old = sys.loadout.bag;
  if (!next && !old) return 'noop';
  if (next && old && next.uid === old.uid) return 'noop';
  const nextDef = next ? ITEM_DEF_MAP.get(next.defId) : undefined;
  if (next && !nextDef?.bag) return 'fail';

  const snap = sys.bag.snapshot();
  const srcGrid = from?.kind === 'grid' ? sys.getGrid(from.grid) : null;
  let srcPos: Placement | undefined;
  if (next && from) {
    if (from.kind !== 'grid' || !srcGrid) return 'fail';
    srcPos = srcGrid.get(next.uid);
    if (!srcPos) return 'fail';
    srcGrid.remove(next.uid);
  }
  const size = sys.bagSizeOf(next);
  const priority: PriorityPlacement[] = [];
  if (old && oldTo === 'grid') {
    const h = hint ?? (from?.kind === 'grid' && from.grid === 'bag' && srcPos ? { x: srcPos.x, y: srcPos.y } : undefined);
    priority.push({ item: old, x: h?.x, y: h?.y });
  }
  const overflow = sys.bag.resize(size.cols, size.rows, priority);
  if (old && oldTo === 'grid' && overflow.includes(old)) {
    sys.bag.restore(snap);
    if (next && srcGrid && srcPos) srcGrid.place(next, srcPos.x, srcPos.y, next.rotated);
    return 'fail';
  }
  sys.loadout.bag = next;
  // 2026-09-09: a smaller bag unlocks fewer wheel slots — the stacks past its count come back to the grid
  // (and follow `overflow` to the ground when even that is full). A locked slot never keeps an item.
  const stranded = lockedQuickItems(sys.quickSlots, Math.max(0, Math.min(QUICK_SLOTS, Math.floor(size.quickSlots))));
  for (const { index, item } of stranded) {
    sys.quickSlots[index] = null;
    if (!sys.bag.autoPlace(item)) overflow.push(item);
  }
  if (next && nextDef && from) sys.emitTransfer(next, nextDef, from, { kind: 'slot', slot: 'bag' });
  for (const it of overflow) sys.throwToWorld(it, true);
  if (old && oldTo === 'world') sys.throwToWorld(old, true);
  if (overflow.length > 0) {
    sys.ctx.bus.emit('ui:notify', { text: `가방 공간 부족: 아이템 ${overflow.length}개를 바닥에 떨어뜨렸습니다`, kind: 'warning' });
  }
  sys.ctx.bus.emit('inventory:bagChanged', { ...size, dropped: overflow });
  sys.emitLoadout();
  sys.afterChange();
  return 'ok';
}

/** Can `current` (being displaced from a weapon slot) be placed where the dragged item came from, or anywhere sensible? */
export function canPlaceDisplaced(sys: InventorySystem, current: ItemInstance, from: ItemLocation, draggedUid: string): boolean {
  if (from.kind !== 'grid') return false;
  const srcGrid = sys.getGrid(from.grid);
  const src = srcGrid?.get(draggedUid);
  if (!srcGrid || !src) return false;
  const ignore = [draggedUid, current.uid];
  // multiplayer: the displaced gear may not land in a shared container — only the bag can take it
  if (sys.ctx.isMultiplayer && from.grid === 'container') return sys.bag.findFreeSlot(current) !== null;
  if (srcGrid.canPlace(current, src.x, src.y, current.rotated, ignore)) return true;
  if (srcGrid.canPlace(current, src.x, src.y, !current.rotated, ignore)) return true;
  if (srcGrid.findFreeSlot(current, current.rotated, ignore)) return true;
  return from.grid === 'container' && sys.bag.findFreeSlot(current) !== null;
}

export function dropOnSlot(sys: InventorySystem, item: ItemInstance, def: ItemDef, from: ItemLocation, slot: SlotId): OpResult {
  if (!slotAccepts(def, slot)) return 'fail';
  if (from.kind === 'slot') {
    if (from.slot === slot) return 'noop';
    if (slot === 'bag' || from.slot === 'bag' || slot === 'armor' || from.slot === 'armor'
      || slot === 'pouch' || from.slot === 'pouch') return 'fail';
    // 주무기 I ↔ 주무기 II (both slots accept the same category, so the swap is always valid)
    const cur = sys.loadout[slot];
    if (cur && !slotAccepts(ITEM_DEF_MAP.get(cur.defId)!, from.slot)) return 'fail';
    sys.loadout[slot] = item;
    sys.loadout[from.slot] = cur ?? null;
    sys.emitLoadout();
    sys.afterChange();
    return 'ok';
  }
  if (slot === 'bag') return sys.changeBag(item, from, 'grid');
  // A-15: the pouch slot is a move that swaps a grid too — `changePouch` alone is responsible for the contents.
  // The removed pouch goes to the grid the new one came from (from a crate → the bag: nothing of mine into a shared crate).
  if (slot === 'pouch') {
    const back: GridId = from.kind === 'grid' && from.grid === 'stash' ? 'stash' : 'bag';
    return sys.changePouch(item, from, 'grid', undefined, back);
  }
  if (from.kind !== 'grid') return 'fail';   // the wheel only ever holds quick-usable stacks, never equipment
  const srcGrid = sys.getGrid(from.grid);
  const src = srcGrid?.get(item.uid);
  if (!srcGrid || !src) return 'fail';
  const current = sys.loadout[slot];
  const sx = src.x, sy = src.y, srot = item.rotated;
  srcGrid.remove(item.uid);
  if (from.grid === 'container') item.searched = true;
  if (current) {
    const intoShared = sys.ctx.isMultiplayer && from.grid === 'container';
    const placed = intoShared
      ? sys.bag.autoPlace(current)
      : srcGrid.place(current, sx, sy, current.rotated) ||
        srcGrid.place(current, sx, sy, !current.rotated) ||
        srcGrid.autoPlace(current) ||
        (from.grid === 'container' && sys.bag.autoPlace(current));
    if (!placed) { srcGrid.place(item, sx, sy, srot); return 'fail'; }
    if (from.grid === 'container' && srcGrid.has(current.uid)) {
      const cd = ITEM_DEF_MAP.get(current.defId);
      if (cd) sys.emitTransfer(current, cd, { kind: 'slot', slot }, from);
    }
  }
  sys.loadout[slot] = item;
  sys.emitTransfer(item, def, from, { kind: 'slot', slot });
  sys.emitLoadout();
  sys.afterChange();
  return 'ok';
}

export function canSwap(sys: InventorySystem, item: ItemInstance, fromGrid: GridId, other: ItemInstance, targetGrid: Grid): boolean {
  const srcGrid = sys.getGrid(fromGrid);
  const src = srcGrid?.get(item.uid);
  if (!srcGrid || !src) return false;
  const ignore = [item.uid, other.uid];
  if (srcGrid.canPlace(other, src.x, src.y, other.rotated, ignore)) return true;
  if (srcGrid.canPlace(other, src.x, src.y, !other.rotated, ignore)) return true;
  // same-grid: anything free after both are lifted; cross-grid: any free slot in source grid
  const probe = srcGrid === targetGrid ? ignore : [item.uid];
  return srcGrid.findFreeSlot(other, other.rotated, probe) !== null;
}

export function performSwap(sys: InventorySystem, item: ItemInstance, srcGrid: Grid, other: ItemInstance, dstGrid: Grid, x: number, y: number, rotated: boolean): boolean {
  const src = srcGrid.get(item.uid);
  const dst = dstGrid.get(other.uid);
  if (!src || !dst) return false;
  const sx = src.x, sy = src.y, srot = item.rotated;
  const ox = dst.x, oy = dst.y, orot = other.rotated;
  srcGrid.remove(item.uid);
  dstGrid.remove(other.uid);
  if (!dstGrid.place(item, x, y, rotated)) {
    srcGrid.place(item, sx, sy, srot); dstGrid.place(other, ox, oy, orot); return false;
  }
  const placed =
    srcGrid.place(other, sx, sy, orot) ||
    srcGrid.place(other, sx, sy, !orot) ||
    srcGrid.autoPlace(other);
  if (!placed) {
    dstGrid.remove(item.uid);
    srcGrid.place(item, sx, sy, srot);
    dstGrid.place(other, ox, oy, orot);
    return false;
  }
  return true;
}
