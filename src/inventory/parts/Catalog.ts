/**
 * src/inventory/parts/Catalog.ts — **무한 상자** (개발자 카탈로그, Phase 6).
 *
 * `/items` 콘솔 명령이 여는 치트 창이다. 다른 그리드와 달리 원본이 줄지 않고 드래그마다 **새 인스턴스**를 만든다
 * (`dropFromCatalog` / `takeFromCatalog`). 훈련장의 무기 거치대도 카테고리를 지정해 이 창을 연다.
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

/**
 * `/items` cheat: open the catalog panel (every item def, infinite stock) inside the inventory window — the ship
 * screen in the hub, the bag window on a mission. Opens the window itself when it is closed (blocker `'inventory'`).
 */
export function openCatalog(sys: InventorySystem, opts?: { category?: ItemCategory }): void {
  const ctx = sys.ctx;
  const category = opts?.category;
  if (sys.catalogOpen) { if (category) sys.ui?.catalog.setTabForCategory(category); return; }
  if (!ctx.isGameplayPhase() && !ctx.isHubPhase()) {
    ctx.bus.emit('ui:notify', { text: '무한 상자는 함선이나 임무 중에만 열 수 있습니다', kind: 'warning', duration: 2 });
    return;
  }
  sys.catalogOpen = true;
  if (!sys._open) {
    sys.activeContainer = null;
    sys.hubMode = ctx.isHubPhase();
    sys.setOpen(true);
    sys.ui?.show(null, sys.hubMode);
    ctx.bus.emit('inventory:opened', { containerId: null });
  }
  sys.ui?.setCatalog(true);
  // Phase 9: `category` preselects the tab holding it (훈련장 무기 거치대 → 'primary'); unknown / unbuilt → 전체 stays
  if (category) sys.ui?.catalog.setTabForCategory(category);
  ctx.bus.emit('ui:catalogToggled', { open: true });
  }

/** Close the catalog panel; the rest of the window stays open. */
export function closeCatalog(sys: InventorySystem): void {
  if (!sys.catalogOpen) return;
  sys.catalogOpen = false;
  sys.ui?.setCatalog(false);
  sys.ctx.bus.emit('ui:catalogToggled', { open: false });
  }

/** Units a catalog drag / double-click creates: a full stack for stackables, one otherwise. */
export function catalogQty(sys: InventorySystem, def: ItemDef): number { return def.stackMax > 1 ? def.stackMax : 1; }

/** Drag preview for a detached (catalog) instance over `target`: grids (free cell / merge) and equipment slots. */
export function previewCatalog(sys: InventorySystem, item: ItemInstance, target: DropTarget): DropPreview {
  const def = ITEM_DEF_MAP.get(item.defId);
  if (!def) return 'bad';
  if (target.kind === 'quick' || target.kind === 'weapon') return 'bad';
  if (target.kind === 'slot') {
    if (!slotAccepts(def, target.slot)) return 'bad';
    const current = sys.loadout[target.slot];
    if (!current) return 'ok';
    if (target.slot === 'bag') return 'swap'; // the displaced bag is placed first in the resized grid
    return sys.canStow(current) ? 'swap' : 'bad';
  }
  const grid = sys.getGrid(target.grid);
  if (!grid) return 'bad';
  const blockers = grid.blockersAt(item, target.x, target.y, target.rotated, item.uid);
  if (blockers.length === 0) return 'ok';
  if (blockers.length !== 1 || blockers[0] === OOB) return 'bad';
  const other = grid.get(blockers[0]);
  return other && other.item.defId === item.defId && def.stackMax > 1 && other.item.qty < def.stackMax ? 'merge' : 'bad';
  }

/**
 * Release a catalog drag: the fresh instance lands in the grid cell (or merges into the stack there) / the slot
 * (displaced gear → bag, else stash in the ship). The catalog tile is untouched. 'fail' → the UI shakes the tile.
 */
export function dropFromCatalog(sys: InventorySystem, item: ItemInstance, target: DropTarget): OpResult {
  const def = ITEM_DEF_MAP.get(item.defId);
  if (!def || sys.previewCatalog(item, target) === 'bad') return 'fail';
  if (target.kind === 'slot') {
    const slot = target.slot;
    if (slot === 'bag') {
      if (sys.changeBag(item, null, 'grid') !== 'ok') return 'fail';
      sys.ctx.bus.emit('inventory:itemAdded', { item, name: def.name, rarity: def.rarity });
      return 'ok';
    }
    const current = sys.loadout[slot];
    if (current) {
      const dest = sys.stow(current);
      if (!dest) return 'fail';
      const cd = ITEM_DEF_MAP.get(current.defId);
      if (cd) sys.emitTransfer(current, cd, { kind: 'slot', slot }, { kind: 'grid', grid: dest });
    }
    sys.loadout[slot] = item;
    sys.ctx.bus.emit('inventory:itemAdded', { item, name: def.name, rarity: def.rarity });
    sys.emitLoadout();
    sys.afterChange();
    return 'ok';
  }
  if (target.kind !== 'grid') return 'fail';
  const grid = sys.getGrid(target.grid);
  if (!grid) return 'fail';
  const blockers = grid.blockersAt(item, target.x, target.y, target.rotated, item.uid);
  if (blockers.length === 0) {
    if (!grid.place(item, target.x, target.y, target.rotated)) return 'fail';
  } else {
    const other = grid.get(blockers[0]);
    if (!other || grid.mergeInto(item, other.item.uid) <= 0) return 'fail';
  }
  if (target.grid === 'bag') sys.ctx.bus.emit('inventory:itemAdded', { item, name: def.name, rarity: def.rarity });
  sys.afterChange();
  return 'ok';
  }

/** Catalog double-click: a fresh instance straight into the bag (merge into stacks first). */
export function takeFromCatalog(sys: InventorySystem, defId: string): OpResult {
  const def = ITEM_DEF_MAP.get(defId);
  if (!def || !sys.catalogOpen) return 'fail';
  const item = sys.loot.createItem(defId, sys.catalogQty(def));
  if (!sys.bag.autoPlace(item)) {
    sys.ctx.bus.emit('inventory:full', { item, name: def.name });
    return 'fail';
  }
  sys.ctx.bus.emit('inventory:itemAdded', { item, name: def.name, rarity: def.rarity });
  sys.afterChange();
  return 'ok';
  }

/** Where displaced gear can go: the bag, else the ship stash (hub only). */
export function canStow(sys: InventorySystem, item: ItemInstance): boolean {
  return sys.bag.canAbsorb(item) || (sys.ctx.isHubPhase() && sys.stash.grid.canAbsorb(item));
  }

/** Put a detached item into the bag, else the stash (ship). Returns where it went, null when nothing fits. */
export function stow(sys: InventorySystem, item: ItemInstance): GridId | null {
  if (sys.bag.autoPlace(item)) return 'bag';
  if (sys.ctx.isHubPhase() && sys.stash.grid.autoPlace(item)) return 'stash';
  return null;
  }
