/**
 * src/inventory/parts/DropResolver.ts — **드래그 앤 드롭 판정**.
 *
 * UI 가 묻는 두 가지 질문에만 답한다 — *여기 놓으면 어떻게 되나* (`preview*`, 타일 하이라이트 색)와
 * *실제로 놓아라* (`drop` / `quickMove` / `activate` / `rotateItem` / `attachFrom`). 스왑 · 병합 · 장비칸 ·
 * 퀵슬롯 · 소켓 · 부분 수량(Shift/Ctrl 드래그)이 전부 이 파일의 규칙이고, DOM 은 하나도 없다.
 */
import * as THREE from 'three';
import type {
  ContainerMessage, ContainerRequest, CraftIngredient, CraftRecipe, CraftStation, DurabilityInfo, GameContext, ItemCategory, ItemDef,
  ItemInstance, Loadout, LoadoutSlot, PeerId as NetPeerId, ProfileRecord, SocketSlot, WeaponSlot, WeightInfo, LoadoutPreset, WorkbenchKind, EmbeddedView,
} from '@/shared';
import { BAG_DEFAULT_COLS, BAG_DEFAULT_QUICK_SLOTS, BAG_DEFAULT_ROWS, Keys, QUICK_SLOTS, SEARCH_MAX_DISTANCE, SOCKET_SLOTS, isQuickSlotActive } from '@/shared';
import { AMMO_LABEL_KO, ITEM_DEF_MAP, STARTER_LOADOUT, STARTER_STASH, ammoItemIdFor, getRecipe, isWeaponItemDef, itemWeight } from '@/items';
import { durabilityInfo, gearMultipliers, makeWeightInfo, searchTimeFor, sumWeight } from '../Gear';
import { Grid, OOB, type Placement, type PriorityPlacement } from '../Grid';
import { Container, ContainerStore } from '../Container';
import { attachedItems, clearSocket, findSocketed, setSocket } from '../Sockets';
import { firstFreeQuickSlot, isQuickIndex, isQuickUsable, lockedQuickItems } from '../QuickSlots';
/* appended (2026-09-10): 휠 교체 규칙 — `previewDrop` 과 `setQuickSlot` 이 같은 계획을 본다 */
import { canQuickSwap } from '../QuickSwap';
import { QUICK_DIR_GLYPH, SLOT_LABEL } from '../ui/labels';
import { setStarterGrantState, starterGrantState } from '../Stash';
import { LOADOUT_SAVE_VERSION, isEmptyLoadoutSave, loadLoadoutSave, sanitizeLoadoutSave, type LoadoutSave } from '../Loadout';
import { reviveItem, savedCell, serializeExtras, serializePlacement, type SavedPlacement } from '../Serialize';
import {
  AUTO_CLOSE_DISTANCE, BLOCKER_TOKEN, CRAFT_MIN_SPEED, DROP_EYE_LOWER, DROP_FORWARD_OFFSET, DROP_FORWARD_SPEED, DROP_UP_SPEED,
  LOADOUT_SLOTS, MOD_CTRL, MOD_SHIFT, SEARCH_EMIT_INTERVAL, SPRAY_REFILL_COST, TAKE_REQUEST_TIMEOUT, WEAPON_SLOT_IDS,
  isArmorDef, isAttachmentDef, isBagDef, isDisassembleRecipe, isWeaponDef, sameProfileDoc, slotAccepts,
  type ActiveBench, type BagSize, type BenchRecipeRow, type BenchRepairRow, type DropPreview, type DropTarget,
  type GridId, type ItemLocation, type OpResult, type PendingTake, type RaidInventoryState, type SlotId,
} from '../model';
import type { InventorySystem } from '../InventorySystem';

/** Slot a double-click / `장착` sends a weapon to: first empty primary slot, else 주무기 I (swap). Armor / bags → their slot. */
export function equipTargetFor(sys: InventorySystem, def: ItemDef): LoadoutSlot | null {
  if (def.category === 'bag') return 'bag';
  if (def.category === 'armor') return 'armor';
  if (def.category === 'pouch') return 'pouch';   // A-15: 고정 1칸 (`POUCH_SLOTS`)
  if (def.category === 'secondary') return 'secondary';
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
  // 2026-09-12: 나눈 스택을 휠 칸에 — 빈 칸이면 새 스택, 같은 아이템이면 합치기 (`previewQuickPartial`)
  if (target.kind === 'quick') return sys.previewQuickPartial(target.index, uid, from, qty);
  const v = sys.validatePartial(uid, from, qty, target);
  if (!v) return 'bad';
  const { item, def, grid, blockers } = v;
  if (blockers.length === 0) return 'ok';
  if (blockers.length !== 1 || blockers[0] === OOB) return 'bad';
  if (blockers[0] === uid) return 'noop';
  const other = grid.get(blockers[0]);
  return other && other.item.defId === item.defId && other.item.qty < def.stackMax ? 'merge' : 'bad';
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
    const created = sys.loot.createItem(item.defId, qty);
    if (!grid.place(created, target.x, target.y, target.rotated)) return 'fail';
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
  if (!other || other.item.defId !== item.defId || other.item.searched === false) return 'fail';
  const moved = Math.min(def.stackMax - other.item.qty, qty);
  if (moved <= 0) return 'fail';
  other.item.qty += moved;
  item.qty -= moved;
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
    // 2026-09-10: the source grid is **any** grid, not just the bag — 상자(컨테이너) · 함선 창고에서 곧장 휠에 올린다.
    // A container source is a take like any other, so `drop` sends it through `guardedTake` (see there).
    if ((from.kind !== 'grid' && from.kind !== 'quick') || !isQuickUsable(def)) return 'bad';
    if (!isQuickIndex(target.index) || !isQuickSlotActive(target.index, sys.getQuickSlotCount())) return 'bad';
    const occupant = sys.quickSlots[target.index];
    if (occupant?.uid === uid) return 'noop';
    // 2026-09-12 (사용자 결정): 같은 아이템이 든 칸이면 교체가 아니라 **합치기** (넘친 만큼은 커서에 남는다)
    if (occupant && occupant.defId === item.defId && def.stackMax > 1 && occupant.qty < def.stackMax && item.searched !== false) return 'merge';
    /*
     * 2026-09-10 — **1:1 교체는 가방 여유를 요구하지 않는다.** 예전에는 여기서 `sys.bag.canAbsorb(occupant)` 만
     * 봤는데, 그 검사는 들어오는 스택이 **아직 격자에 있는 상태**에서 돌아 그것이 곧 비울 칸을 세지 않았다.
     * 그래서 가방이 꽉 차면 `가방 → 휠` 교체가 미리보기 단계에서 빨간불(= `dropImpl` 이 곧장 'fail')이 됐고,
     * `상자 → 휠` 은 `setQuickSlot` 이 밀려난 스택을 가방에서만 찾다가 거절했다. 이제 양쪽이 `QuickSwap` 의
     * 같은 규칙을 본다 — 비운 그 칸 → 가방 → 출발 격자.
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
    // A-15: 주머니 교체도 `changePouch` 가 전부-아니면-전무로 판정한다 (내용물이 가방에 들어가야 한다)
    if (target.slot === 'pouch') return 'swap';
    return sys.canPlaceDisplaced(current, from, uid) ? 'swap' : 'bad';
  }

  const grid = sys.getGrid(target.grid);
  if (!grid) return 'bad';
  // A-15: 주머니 격자는 `PouchDef.accepts` 밖의 것을 아예 받지 않는다 (주머니가 없으면 격자 자체가 없다)
  if (target.grid === 'pouch' && !sys.pouchAccepts(def)) return 'bad';
  if (from.kind === 'grid' && from.grid === target.grid) {
    const p = grid.get(uid);
    if (p && p.x === target.x && p.y === target.y && item.rotated === target.rotated) return 'noop';
  }
  const blockers = grid.blockersAt(item, target.x, target.y, target.rotated, uid);
  if (from.kind === 'slot' && from.slot === 'bag' && target.grid !== 'bag') return 'bad';
  // A-15: 장착한 주머니는 가방 · 창고로만 벗는다 (상자에는 넣지 않는다 — `dropImpl` 의 pouch 가지와 같은 판정)
  if (from.kind === 'slot' && from.slot === 'pouch' && (target.grid === 'pouch' || target.grid === 'container')) return 'bad';
  if (blockers.length === 0) return 'ok';
  if (blockers.length !== 1 || blockers[0] === OOB) return 'bad';
  const other = grid.get(blockers[0]);
  if (!other) return 'bad';
  if (target.grid === 'container' && other.item.searched === false) return 'bad'; // never touch an unsearched item
  if (other.item.defId === item.defId && def.stackMax > 1 && other.item.qty < def.stackMax) return 'merge';
  // A-15: 교체는 밀려난 쪽이 **주머니로 들어가는** 이동이기도 하다 — 주머니가 안 받으면 교체 자체가 안 된다
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
  // 2026-09-10: a **wheel** target is a take too (상자 → 퀵슬롯). Before that the wheel could only be fed from the
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
  // A-15: 주머니 격자가 받는 것만 (미리보기와 같은 판정)
  if (target.grid === 'pouch' && !sys.pouchAccepts(def)) return 'fail';

  if (from.kind === 'grid' && from.grid === target.grid) {
    const p = grid.get(uid);
    if (p && p.x === target.x && p.y === target.y && item.rotated === target.rotated) return 'noop';
  }

  const blockers = grid.blockersAt(item, target.x, target.y, target.rotated, uid);
  if (blockers.includes(OOB)) return 'fail';

  /*
   * 2026-09-11 (A-15) — 장착한 주머니를 격자로 끌어다 놓기. 가방과 **같은 이유로** 여기서 가로챈다:
   * 그냥 `detach` 하면 주머니 격자의 내용물이 갈 데 없이 남는다. `changePouch` 가 내용물을 가방으로 옮기고,
   * 하나라도 못 들어가면 이동 자체를 거절한다.
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
  if (other.item.defId === item.defId && def.stackMax > 1 && other.item.qty < def.stackMax) {
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
  // A-15: 밀려난 쪽이 주머니로 들어가는 교체 — 주머니가 안 받으면 거절 (미리보기와 같은 판정)
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
  // A-15: 장착한 주머니의 우클릭도 `changePouch` 를 지난다 (내용물이 먼저 가방으로 간다)
  if (from.kind === 'slot' && from.slot === 'pouch') return sys.changePouch(null, null, 'grid');
  let dest: GridId;
  if (from.kind === 'slot') dest = 'bag';
  // 2026-09-09: 우클릭 = 가방으로 되돌리기. 2026-09-10: 상자를 열어 둔 채라면 그 상자로 곧장 간다 (가방과 같은 규칙).
  else if (from.kind === 'quick') dest = sys.activeContainer ? 'container' : 'bag';
  // 2026-09-11 (A-15): 주머니에서 우클릭하면 가방으로 (퀵슬롯과 같다)
  else if (from.grid === 'container' || from.grid === 'stash' || from.grid === 'pouch') dest = 'bag';
  else if (sys.activeContainer) dest = 'container';
  else if (sys.hubMode) dest = 'stash';
  else return 'fail';
  if (dest === 'container' && sys.ctx.isMultiplayer) return 'fail'; // Phase 7: nothing goes into a shared container
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
 * Double-click. **가방 · 장비 칸에서**: weapons / bags equip (`equipTargetFor`), anything else quick-moves.
 * **상자 · 시체에서** (2026-09-10): 언제나 가방이 먼저이고, 가방이 꽉 찼을 때만 `activateFallback` 이
 * `빈 장비 칸 → 임플란트 칸 → 빈 퀵슬롯` 을 본다.
 * **함선 창고에서** (2026-09-12): 자리가 비어 있으면 **곧장 그 자리로** — 아래 `activateImpl` 주석.
 */
export function activate(sys: InventorySystem, uid: string, from: ItemLocation): OpResult {
  if (sys.isContainerLoc(from)) return sys.guardedTake(uid, from, null, () => sys.activateImpl(uid, from));
  return sys.activateImpl(uid, from);
  }

export function activateImpl(sys: InventorySystem, uid: string, from: ItemLocation): OpResult {
  const item = sys.findItem(uid, from);
  const def = item && ITEM_DEF_MAP.get(item.defId);
  if (!item || !def) return 'fail';
  /*
   * 2026-09-10 (사용자 결정) — **상자에서 찾은 것은 무조건 가방이 먼저다.** 예전에는 장착 아이템(무기 · 방탄복 ·
   * 가방)을 상자에서 더블클릭하면 `equipTargetFor` 를 타고 곧장 장비 칸으로 들어갔다. 주우면서 지금 든 총이
   * 조용히 바뀌는 것이라 레이드 중에는 사고였다.
   *
   * **2026-09-12 (사용자 결정) — 함선 창고는 예외다.** 그 결정이 지키려던 것은 *레이드 중에 손에 든 것이 조용히
   * 바뀌지 않는다* 였고, 출격 전 창고 앞에서 장비를 고르는 동안에는 그 위험이 없다. 그래서 **창고 더블클릭은
   * 그 종류의 자리가 비어 있으면 곧장 그리로** 간다 (장비칸 · 임플란트 칸 · 빈 퀵슬롯, `tryAutoPlace`).
   * 이미 차 있으면 예전 그대로 가방으로 회수하고, 가방마저 꽉 찼으면 `activateFallback` 이 마지막으로 훑는다.
   * 상자 · 시체는 2026-09-10 그대로 — 언제나 가방이 먼저다.
   */
  if (from.kind === 'grid' && from.grid === 'stash') {
    const placed = tryAutoPlace(sys, item, def, from, SENT_TO);
    if (placed) return placed;
    if (sys.bag.canAbsorb(item)) return sys.quickMoveImpl(uid, from);
    return activateFallback(sys, item, def, from);
  }
  if (from.kind === 'grid' && from.grid !== 'bag') {
    if (sys.bag.canAbsorb(item)) return sys.quickMoveImpl(uid, from);
    return activateFallback(sys, item, def, from);
  }
  const slot = sys.equipTargetFor(def);
  if (slot) {
    if (from.kind === 'slot') return 'noop';
    return sys.dropOnSlot(item, def, from, slot);
  }
  return sys.quickMoveImpl(uid, from);
  }

/** 2026-09-10 — `장착 → 퀵슬롯` 순으로 자리를 찾을 때 쓰는 안내 (어디로 갔는지 사용자가 알아야 한다). */
const WENT_TO = (name: string, where: string): string => `가방이 가득 찼습니다 — ${name} → ${where}`;
/** 2026-09-12 — 창고 더블클릭이 **일부러** 장비칸으로 보낸 경우. 사고가 아니므로 「가방이 가득」 이 아니다. */
const SENT_TO = (name: string, where: string): string => `${name} → ${where}`;

/**
 * **비어 있는 제자리**를 순서대로 훑어 거기로 보낸다. 아무 데도 못 갔으면 null (아이템은 한 칸도 안 움직인다).
 *
 *   ① **빈** 장비 칸 (주무기 I · II · 가방 · 방탄복 · 주머니). 이미 장착한 것을 조용히 밀어내지 않는다 — 빈 칸일 때만.
 *   ② 임플란트 아이템이면 빈 임플란트 장착칸 (`ctx.progression.equipImplant`; 함선에서만이고 그 함수가
 *      가방 · 창고만 보므로 사실상 **함선 창고**에서 누른 경우다. 레이드 상자에서는 조용히 실패한다).
 *   ③ 퀵슬롯에 올릴 수 있는 소모품이면 **빈** 휠 칸.
 *
 * 성공하면 `ui:notify` 로 **어디로 갔는지** 말한다 — 문구는 부르는 쪽이 정한다 (창고 더블클릭은 의도한
 * 이동이고, 가방이 꽉 차서 밀려난 것은 사고다).
 *
 * 2026-09-12: `activateFallback`(2026-09-10) 의 ①②③ 을 그대로 떼어낸 것이다. 창고 더블클릭(`activateImpl`)이
 * **같은 순서를 먼저** 쓰기 위해서이고, 규칙은 한 벌뿐이다.
 */
function tryAutoPlace(
  sys: InventorySystem, item: ItemInstance, def: ItemDef, from: ItemLocation,
  message: (name: string, where: string) => string,
): OpResult | null {
  const notify = (where: string): void => {
    sys.ctx.bus.emit('ui:notify', { text: message(def.name, where), kind: 'info', duration: 2.2 });
  };

  const slot = emptyEquipTargetFor(sys, def);
  if (slot) {
    const r = sys.dropOnSlot(item, def, from, slot);
    if (r === 'ok') { notify(SLOT_LABEL[slot]); return r; }
  }

  if (def.implant && !def.implant.broken) {
    const prog = sys.ctx.progression;
    if (prog && typeof prog.equipImplant === 'function' && prog.equipImplant(item.uid)) {
      notify('임플란트 칸');
      return 'ok';
    }
  }

  if (isQuickUsable(def)) {
    const index = firstFreeQuickSlot(sys.quickSlots, sys.getQuickSlotCount());
    if (index >= 0 && sys.setQuickSlot(index, item.uid)) {
      notify(`퀵슬롯 ${QUICK_DIR_GLYPH[index] ?? String(index + 1)}`);
      return 'ok';
    }
  }

  return null;
  }

/**
 * 2026-09-10 — 컨테이너 더블클릭이 **가방에 못 들어갔을 때만** 도는 폴백: `빈 장비 칸 → 임플란트 칸 →
 * 빈 퀵슬롯`(`tryAutoPlace`), 셋 다 아니면 `inventory:full` (예전과 똑같은 거부음 + 토스트).
 */
function activateFallback(sys: InventorySystem, item: ItemInstance, def: ItemDef, from: ItemLocation): OpResult {
  const placed = tryAutoPlace(sys, item, def, from, WENT_TO);
  if (placed) return placed;
  sys.ctx.bus.emit('inventory:full', { item, name: def.name });
  return 'fail';
  }

/** 지금 **비어 있는** 장비 칸 중 이 아이템을 받는 곳. 장착된 것을 밀어내지 않으므로 `equipTargetFor` 와 다르다. */
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
    if (!sys.bag.canAbsorb(item)) {
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
  if (!sys.bag.canAbsorb(p.item)) { sys.ctx.bus.emit('inventory:full', { item: p.item, name: def.name }); return 'fail'; }
  c.grid.remove(uid);
  p.item.searched = true;
  sys.bag.autoPlace(p.item);
  sys.ctx.bus.emit('inventory:itemAdded', { item: p.item, name: def.name, rarity: def.rarity });
  sys.afterChange();
  return 'ok';
  }

/**
 * **2026-09-12 (사용자 결정) — 창고 안 총기에도 부착물을 끼울 수 있다.**
 *
 * 부착 경로의 게이트는 `locKind(loc) === 'player'` 였는데 **함선 창고는 `'container'`** 다 (`locKind` 의 뜻은
 * "옮기면 전달인가"이고, 창고에 넣는 것은 전달이 맞다). 그래서 창고에 둔 총에는 조준경 하나 못 끼우고
 * 가방으로 꺼냈다가 다시 넣어야 했다. `locKind` 의 의미를 바꾸는 대신 **부착 경로에서만** 창고를 명시적으로
 * 허용한다 — 상자 · 시체(`'container'` 격자)는 남의 물건이라 계속 거부한다.
 */
export function canSocketAt(sys: InventorySystem, loc: ItemLocation): boolean {
  if (sys.locKind(loc) === 'player') return true;
  return loc.kind === 'grid' && loc.grid === 'stash';
  }

/**
 * 소켓이 바뀐 무기가 든 격자의 `version` 을 올린다 — 그래야 그 타일이 다시 그려진다 (`GridView` 는 버전 게이트).
 * 2026-09-12: 예전에는 가방만 봤으므로 창고 총의 소켓 핍이 갱신되지 않았다.
 */
function bumpWeaponGrid(sys: InventorySystem, weapon: ItemInstance): void {
  if (sys.bag.has(weapon.uid)) { sys.bag.version++; return; }
  const stash = sys.getGrid('stash');
  if (stash?.has(weapon.uid)) stash.version++;
  }

/**
 * 소켓에서 빠진 부착물이 갈 자리: 가방 → (함선이면) 창고 → 바닥. 2026-09-12 에 창고가 끼었다 — 창고 총의
 * 부착물을 바꿨는데 가방이 꽉 찼다고 함선 안에서 바닥에 던질 수는 없다.
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
  // A-15: 주머니 칸도 격자를 갈아 끼우는 이동이다 — `changePouch` 하나가 내용물까지 책임진다.
  // 벗겨진 주머니는 새 주머니가 오던 격자로 (상자에서 왔으면 가방으로 — 공유 상자에 내 물건을 넣지 않는다).
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
