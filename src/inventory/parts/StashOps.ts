/**
 * src/inventory/parts/StashOps.ts — **함선 창고를 함께 보는 연산**.
 *
 * 가방 하나만 보는 연산(`countDef` 등)은 클래스에 남아 있고, 여기 있는 것은 전부 **가방 + 창고**를 하나의
 * 보관 공간으로 취급한다: 재료 집계 · 소모, 로드아웃 프리셋 저장/적용, 창고로 이동, 어디든 넣기, 공간 확인.
 * 창고는 함선에서만 존재하므로 레이드 중에는 이 함수들이 가방만 본다.
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
import {
  assignQuickSlot, autoAssignQuickSlots, createQuickSlots, firstFreeQuickSlot, isQuickIndex, isQuickUsable, pruneQuickSlots,
  quickSlotOf, quickSlotsSignature, relinkQuickSlot, type QuickSlotUids,
} from '../QuickSlots';
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

export function getStashSize(sys: InventorySystem): { cols: number; rows: number } { return { cols: sys.stash.cols, rows: sys.stash.rows }; }

/** Grow / shrink the stash grid (shrink refused while an item would fall outside). Persists; emits `inventory:stashChanged`. */
export function setStashSize(sys: InventorySystem, cols: number, rows: number): boolean {
  if (!sys.stash.resize(cols, rows)) return false;
  sys.afterChange(); // stash version changed → markDirty + inventory:stashChanged + UI re-render
  return true;
  }

export function countDefAll(sys: InventorySystem, defId: string): number { return sys.countDef(defId) + sys.stashCountDef(defId); }

export function stashCountDef(sys: InventorySystem, defId: string): number {
  let n = 0;
  for (const p of sys.stash.grid.items()) if (p.item.defId === defId) n += p.item.qty;
  return n;
  }

/** Bag first, then the stash; all-or-nothing. */
export function consumeDefAll(sys: InventorySystem, defId: string, qty: number): boolean {
  const want = Math.max(0, Math.floor(qty));
  if (want === 0) return true;
  if (sys.countDefAll(defId) < want) return false;
  let left = want;
  const fromBag = Math.min(left, sys.countDef(defId));
  if (fromBag > 0) left -= sys.consumeWhere((d) => d.id === defId, fromBag);
  if (left > 0) {
    const stash = sys.stash.grid;
    const matches = stash.items().filter((p) => p.item.defId === defId).sort((a, b) => a.item.qty - b.item.qty);
    for (const p of matches) {
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

export function captureLoadout(sys: InventorySystem): LoadoutPreset {
  const l = sys.loadout;
  return {
    name: '프리셋', primary: l.primary?.defId ?? null, primary2: l.primary2?.defId ?? null, secondary: l.secondary?.defId ?? null,
    bag: l.bag?.defId ?? null, armor: l.armor?.defId ?? null,
    implant: sys.ctx.progression?.profile.implant ?? sys.ctx.implants?.equipped ?? null,
  };
  }

/**
 * Equip a preset from the bag (first) and the stash: a slot whose def is found gets the first matching instance
 * (displaced gear → bag, else stash), a def that is nowhere empties the slot and lands in `missing`; `null`
 * entries leave the slot as it is. The implant goes through `ctx.implants.setEquipped` (the Tab screen's path).
 * Ship only — on a mission nothing changes and the result is empty.
 */
export function applyLoadout(sys: InventorySystem, preset: LoadoutPreset): { equipped: number; missing: string[] } {
  if (!sys.ctx.isHubPhase()) return { equipped: 0, missing: [] };
  let equipped = 0;
  const missing: string[] = [];
  for (const slot of LOADOUT_SLOTS) {
    const want = preset[slot];
    if (want === null || want === undefined) continue;
    const cur = sys.loadout[slot];
    if (cur?.defId === want) { equipped++; continue; }
    const found = sys.findStoredByDef(want);
    if (!found) {
      missing.push(want);
      if (cur) sys.unequipToStorage(slot);
      continue;
    }
    if (sys.equipFromStorage(found.item, found.grid, slot)) equipped++;
    else missing.push(want);
  }
  if (preset.implant !== null && preset.implant !== undefined) {
    const imp = sys.ctx.implants;
    if (imp?.equipped === preset.implant) equipped++;
    else if (imp && typeof imp.setEquipped === 'function' && imp.setEquipped(preset.implant)) equipped++;
    else missing.push(preset.implant);
  }
  sys.emitLoadout();
  sys.afterChange();
  return { equipped, missing };
  }

/** First instance of `defId` in the bag, then the stash. */
export function findStoredByDef(sys: InventorySystem, defId: string): { item: ItemInstance; grid: GridId } | null {
  for (const gridId of ['bag', 'stash'] as const) {
    const p = sys.getGrid(gridId)?.items().find((q) => q.item.defId === defId);
    if (p) return { item: p.item, grid: gridId };
  }
  return null;
  }

/** Unequip `slot` into the bag, else the stash (ship). The bag slot shrinks the grid first. */
export function unequipToStorage(sys: InventorySystem, slot: LoadoutSlot): boolean {
  const cur = sys.loadout[slot];
  if (!cur) return true;
  if (slot === 'bag') {
    // the old bag lands in the shrunk grid (priority), else the ship stash through `throwToWorld`
    if (sys.changeBag(null, null, 'grid') === 'ok') return true;
    return sys.changeBag(null, null, 'world') === 'ok';
  }
  sys.loadout[slot] = null;
  const dest = sys.stow(cur);
  if (!dest) { sys.loadout[slot] = cur; return false; }
  const def = ITEM_DEF_MAP.get(cur.defId);
  if (def) sys.emitTransfer(cur, def, { kind: 'slot', slot }, { kind: 'grid', grid: dest });
  return true;
  }

/** Move a bag / stash item into `slot`; the displaced item goes to the bag, else the stash, else the vacated cells. */
export function equipFromStorage(sys: InventorySystem, item: ItemInstance, gridId: GridId, slot: LoadoutSlot): boolean {
  const def = ITEM_DEF_MAP.get(item.defId);
  const grid = sys.getGrid(gridId);
  if (!def || !grid || !slotAccepts(def, slot)) return false;
  const from: ItemLocation = { kind: 'grid', grid: gridId };
  if (slot === 'bag') {
    let r = sys.changeBag(item, from, 'grid');
    if (r === 'fail' && sys.loadout.bag) {
      // the displaced bag does not fit the new grid: park it in the stash first, then retry
      if (sys.moveToStash(sys.loadout.bag.uid, { kind: 'slot', slot: 'bag' }) !== 'ok') return false;
      const again = sys.locate(item.uid);
      if (!again || again.from.kind !== 'grid') return false;
      r = sys.changeBag(item, again.from, 'grid');
    }
    return r === 'ok';
  }
  const cur = sys.loadout[slot];
  const src = grid.get(item.uid);
  if (!src) return false;
  const sx = src.x, sy = src.y, srot = item.rotated;
  grid.remove(item.uid);
  if (cur) {
    sys.loadout[slot] = null;
    let dest: GridId | null = sys.stow(cur);
    if (!dest && grid.autoPlace(cur)) dest = gridId;
    if (!dest) { sys.loadout[slot] = cur; grid.place(item, sx, sy, srot); return false; }
    const cd = ITEM_DEF_MAP.get(cur.defId);
    if (cd) sys.emitTransfer(cur, cd, { kind: 'slot', slot }, { kind: 'grid', grid: dest });
  }
  sys.loadout[slot] = item;
  sys.emitTransfer(item, def, from, { kind: 'slot', slot });
  return true;
  }

/** Context menu `창고로 이동` on an equipped item (hub only): unequip straight into the stash. The bag slot shrinks the grid first. */
export function moveToStash(sys: InventorySystem, uid: string, from: ItemLocation): OpResult {
  if (!sys.hubMode) return 'fail';
  const item = sys.findItem(uid, from);
  const def = item && ITEM_DEF_MAP.get(item.defId);
  if (!item || !def) return 'fail';
  if (from.kind === 'grid' && from.grid === 'stash') return 'noop';
  if (from.kind === 'slot' && from.slot === 'bag') {
    // bag → grid first (its contents must survive the shrink), then the bag itself → stash
    const r = sys.changeBag(null, null, 'grid');
    if (r !== 'ok') return r;
    const found = sys.locate(uid);
    if (!found || found.from.kind !== 'grid') return 'ok';
    from = found.from;
  }
  const stash = sys.stash.grid;
  if (!stash.canAbsorb(item)) { sys.ctx.bus.emit('ui:notify', { text: '창고에 공간이 없습니다', kind: 'warning' }); return 'fail'; }
  sys.detach(item, from);
  stash.autoPlace(item);
  sys.afterMove(item, from, { kind: 'grid', grid: 'stash' });
  return 'ok';
  }

/** Bag → slots → sockets of owned weapons → stash (incl. sockets of stashed weapons). */
export function findItemAnywhere(sys: InventorySystem, uid: string): ItemInstance | null {
  const owned = sys.findItem(uid);
  if (owned) return owned;
  const stashed = sys.stash.grid.get(uid)?.item;
  if (stashed) return stashed;
  const stashWeapons = sys.stash.items().filter((it) => isWeaponItemDef(ITEM_DEF_MAP.get(it.defId)));
  return findSocketed(stashWeapons, uid)?.item ?? null;
  }

/** Auto-place a fresh instance in the stash (merging into stacks first). Persists + `inventory:stashChanged`. */
export function tryAddToStash(sys: InventorySystem, item: ItemInstance): boolean {
  if (!ITEM_DEF_MAP.has(item.defId)) return false;
  if (!sys.stash.grid.autoPlace(item)) return false;
  sys.afterChange();
  return true;
  }

/** Bag first (`inventory:itemAdded`), then the stash. No `inventory:full` — the caller (corp shop) reports. */
export function tryAddItemAnywhere(sys: InventorySystem, item: ItemInstance): 'bag' | 'stash' | null {
  const def = ITEM_DEF_MAP.get(item.defId);
  if (!def) return null;
  if (sys.bag.autoPlace(item)) {
    sys.ctx.bus.emit('inventory:itemAdded', { item, name: def.name, rarity: def.rarity });
    sys.afterChange();
    return 'bag';
  }
  if (sys.stash.grid.autoPlace(item)) { sys.afterChange(); return 'stash'; }
  return null;
  }

/** Would `qty` units of `defId` fit now? Bag first, then (hub phase) the stash. Non-mutating. */
export function canFit(sys: InventorySystem, defId: string, qty = 1): 'bag' | 'stash' | null {
  const def = ITEM_DEF_MAP.get(defId);
  const n = Math.floor(qty);
  if (!def || !Number.isFinite(n) || n < 1) return null;
  if (sys.gridFits(sys.bag, def, n)) return 'bag';
  if (sys.ctx.isHubPhase() && sys.gridFits(sys.stash.grid, def, n)) return 'stash';
  return null;
  }

/** Trial placement of `qty` units (merge into stacks, then new stacks chunked by `stackMax`), rolled back afterwards. */
export function gridFits(sys: InventorySystem, grid: Grid, def: ItemDef, qty: number): boolean {
  const snap = grid.snapshot();
  const version = grid.version;
  let left = qty;
  let ok = true;
  while (left > 0) {
    const chunk = Math.min(def.stackMax, left);
    left -= chunk;
    const probe = sys.loot.createItem(def.id, chunk);
    if (grid.mergeIntoStacks(probe) <= 0) continue;
    if (!grid.autoPlace(probe)) { ok = false; break; }
  }
  grid.restore(snap);
  grid.version = version;
  return ok;
  }
