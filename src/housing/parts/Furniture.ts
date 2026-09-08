/**
 * src/housing/parts/Furniture.ts — **가구 배치 · 제작 · 회수**와 시설 관리 모드.
 *
 * 가구는 **아이템이 아니다** — 가구 창고에만 존재하고 거기서 제작된다. 배치 규칙(방 용도에 맞는가,
 * 겹치지 않는가, 쌓을 수 있는가)과 시설 관리 모드의 커서 상태가 여기 있다.
 */
import type {
  BookSlotInfo, CraftIngredient, EmbeddedView, FacilityId, FacilityInfo, FurnitureDef, GameContext, GameSystem, GrowPlot, GrowPlotInfo,
  HousingRef, ItemDef, LoadoutPreset, PlacedBook, PlacedFurniture, ProfileRef, RoomPurpose, RoomState, ShipState, SkillId,
  StoredFurniture, WorkbenchKind,
} from '@/shared';
import {
  BOOKS_PER_SHELF, FURNITURE_DEFS, FURNITURE_DEF_MAP, GROW_PLOTS_PER_RACK, GROW_SKILL_SPEEDUP, IMPLANT_IDS, SKILL_IDS, SKILL_LEVEL_MAX,
  benchKindOf,
} from '@/shared';
import {
  bookGainMulFor, bookWeightOf, canPlaceAt, craftCostMulFor, facilityBlockReason, facilityLevel, facilityMaxLevel, facilityName,
  facilityPurposeOf, purposeBuildBlockReason, purposeBuildCost, roomRefundCost,
  furnitureAllowedIn, furnitureUpgradeReason, isRoomIndex, isRoomPurpose, layerOf, missingIngredients, nextFacilityCost, nextFreeLayer,
  nextFurnitureCost, presetCountFor, recoverBlockReason, skillGainMulFor, stackLimitOf, stackMembers,
  stashSizeFor,
} from '../Rules';
import { ShipStore, freshRoom, isBookshelfDefId, isGrowRackDefId, loadState, maxUidIndex, sanitize, writeState } from '../ShipState';
import { PresetMenu } from '../ui/PresetMenu';
import { GrowMenu } from '../ui/GrowMenu';
import { BookshelfMenu } from '../ui/BookshelfMenu';
import { createShipView } from '../ui/ShipView';
import { formatRemaining } from '../ui/dom';
import type { HousingPanel } from '../ui/Panel';
import { BOOKS_BLOCK_REASON, FACILITY_IDS, PRESET_NAME_MAX } from '../model';
import type { HousingSystem } from '../HousingSystem';

export function storageEntry(sys: HousingSystem, defId: string): StoredFurniture | null {
  let best: StoredFurniture | null = null;
  for (const s of sys.state.furnitureStorage) if (s.defId === defId && s.qty > 0 && (!best || s.level > best.level)) best = s;
  return best;
  }

export function addToStorage(sys: HousingSystem, defId: string, level: number, qty = 1): void {
  const e = sys.state.furnitureStorage.find((s) => s.defId === defId && s.level === level);
  if (e) e.qty += qty; else sys.state.furnitureStorage.push({ defId, level, qty });
  }

export function takeFromStorage(sys: HousingSystem, entry: StoredFurniture): void {
  entry.qty -= 1;
  if (entry.qty <= 0) sys.state.furnitureStorage.splice(sys.state.furnitureStorage.indexOf(entry), 1);
  }

/* ── housing mode ──────────────────────────────────────────────────────── */
/** Why housing mode cannot start for `room`; null = fine. */
export function housingModeBlock(sys: HousingSystem, room: number): string | null {
  const ctx = sys.ctx;
  if (!isRoomIndex(sys.state, room)) return '없는 방입니다';
  if (ctx.phase !== 'hub') return '함선에서만 꾸밀 수 있습니다';
  if (ctx.hub?.ship !== 'personal') return '개인 함선에서만 꾸밀 수 있습니다';
  // hub's `currentRoom` is null in the corridor / cockpit: the player has to stand inside the room being decorated
  if (ctx.hub.currentRoom !== room) return `방 ${room + 1} 안에서만 꾸밀 수 있습니다`;
  return null;
  }

/** Why 함선 관리 cannot start at all (no room gate — that is what separates it from `enterHousingMode`). */
export function shipManageBlock(sys: HousingSystem): string | null {
  const ctx = sys.ctx;
  if (ctx.phase !== 'hub') return '함선에서만 꾸밀 수 있습니다';
  if (ctx.hub?.ship !== 'personal') return '개인 함선에서만 꾸밀 수 있습니다';
  return null;
  }

export function enterHousingMode(sys: HousingSystem, room: number): boolean {
  if (sys.housingModeBlock(room)) return false;
  return sys.enterMode(room);
  }

/** Shared body of `enterHousingMode` / `openShipManage` — the gates differ, the state change does not. */
export function enterMode(sys: HousingSystem, room: number): boolean {
  sys.closeMenus();
  if (sys.housingMode && sys.housingRoom === room) return true;
  sys.housingMode = true;
  sys.housingRoom = room;
  sys.selectedFurniture = null;
  sys.selectedYaw = 0;
  sys.ctx.bus.emit('housing:modeChanged', { active: true, room });
  sys.ctx.bus.emit('housing:selectionChanged', { defId: null, yaw: 0 });
  return true;
  }

export function exitHousingMode(sys: HousingSystem): void {
  const wasManage = sys.shipManageMode;
  sys.shipManageMode = false;
  if (sys.housingMode) {
    sys.housingMode = false;
    sys.housingRoom = null;
    sys.selectedFurniture = null;
    sys.selectedYaw = 0;
    sys.ctx.bus.emit('housing:modeChanged', { active: false, room: null });
  }
  if (wasManage) sys.ctx.bus.emit('housing:shipManageChanged', { active: false, room: null });
  }

/* ── 함선 관리 (Phase 8, M in the ship) ────────────────────────────────── */
/**
 * Enter the ship-management screen: the housing-mode camera / cursor without the "player stands in the room" gate,
 * plus the room list + furniture bar ui/ draws off `housing:shipManageChanged`. Default room: the one the player is
 * standing in, else the first room with a purpose, else room 1.
 */
export function openShipManage(sys: HousingSystem, room?: number): boolean {
  if (sys.shipManageBlock()) return false;
  const target = isRoomIndex(sys.state, room ?? -1)
    ? (room as number)
    : sys.ctx.hub?.currentRoom ?? sys.state.rooms.findIndex((r) => r.purpose !== 'empty');
  const index = isRoomIndex(sys.state, target) ? target : 0;
  sys.enterMode(index);
  sys.shipManageMode = true;
  sys.ctx.bus.emit('housing:shipManageChanged', { active: true, room: index });
  return true;
  }

export function setManageRoom(sys: HousingSystem, room: number): boolean {
  if (!sys.shipManageMode || !isRoomIndex(sys.state, room)) return false;
  if (sys.housingRoom === room) return true;
  sys.housingRoom = room;
  sys.selectedFurniture = null;
  sys.selectedYaw = 0;
  sys.ctx.bus.emit('housing:modeChanged', { active: true, room });
  sys.ctx.bus.emit('housing:selectionChanged', { defId: null, yaw: 0 });
  sys.ctx.bus.emit('housing:shipManageChanged', { active: true, room });
  return true;
  }

export function closeShipManage(sys: HousingSystem): void {
  if (!sys.shipManageMode) return;
  sys.exitHousingMode();
  }

/** `null` clears the selection; a def that is not in furniture storage is ignored (selection unchanged). */
export function selectFurniture(sys: HousingSystem, defId: string | null): void {
  if (defId !== null && (!FURNITURE_DEF_MAP.has(defId) || !sys.storageEntry(defId))) return;
  if (defId === sys.selectedFurniture) return;
  sys.selectedFurniture = defId;
  sys.ctx.bus.emit('housing:selectionChanged', { defId, yaw: sys.selectedYaw });
  }

export function rotateSelection(sys: HousingSystem): void {
  sys.selectedYaw = ((sys.selectedYaw + 1) % 4) as 0 | 1 | 2 | 3;
  sys.ctx.bus.emit('housing:selectionChanged', { defId: sys.selectedFurniture, yaw: sys.selectedYaw });
  }

/* ── furniture ─────────────────────────────────────────────────────────── */
export function getFurnitureDef(sys: HousingSystem, id: string): FurnitureDef | undefined { return FURNITURE_DEF_MAP.get(id); }

export function getAllFurnitureDefs(sys: HousingSystem): readonly FurnitureDef[] { return FURNITURE_DEFS; }

export function getFurnitureFor(sys: HousingSystem, purpose: RoomPurpose): readonly FurnitureDef[] { return FURNITURE_DEFS.filter((d) => furnitureAllowedIn(d, purpose)); }

export function getPlaced(sys: HousingSystem, room?: number): readonly PlacedFurniture[] { return room === undefined ? sys.state.furniture : sys.state.furniture.filter((f) => f.room === room); }

export function getPlacedByUid(sys: HousingSystem, uid: string): PlacedFurniture | null { return sys.state.furniture.find((f) => f.uid === uid) ?? null; }

export function getStored(sys: HousingSystem): readonly StoredFurniture[] { return sys.state.furnitureStorage; }

export function canPlace(sys: HousingSystem, room: number, defId: string, x: number, y: number, yaw: 0 | 1 | 2 | 3, ignoreUid?: string): boolean {
  const def = FURNITURE_DEF_MAP.get(defId);
  return !!def && canPlaceAt(sys.state, room, def, x, y, yaw, ignoreUid);
  }

export function place(sys: HousingSystem, room: number, defId: string, x: number, y: number, yaw: 0 | 1 | 2 | 3): PlacedFurniture | null {
  if (sys.ctx.tutorial?.blockReason('furniture', defId)) return null;   // 2026-09-08: 튜토리얼 순서 강제
  const entry = sys.storageEntry(defId);
  const def = FURNITURE_DEF_MAP.get(defId);
  if (!def || !entry || !sys.canPlace(room, defId, x, y, yaw)) return null;
  sys.takeFromStorage(entry);
  const item: PlacedFurniture = { uid: `f-${++sys.nextUid}`, defId, room, x, y, yaw, level: entry.level };
  const limit = stackLimitOf(def);
  if (limit > 1) item.layer = Math.max(0, nextFreeLayer(stackMembers(sys.state, room, def, x, y, yaw), limit));
  sys.state.furniture.push(item);
  sys.ctx.bus.emit('housing:furniturePlaced', { item });
  sys.changed('place');
  if (sys.selectedFurniture === defId && !sys.storageEntry(defId)) sys.selectFurniture(null);
  return item;
  }

export function move(sys: HousingSystem, uid: string, x: number, y: number, yaw: 0 | 1 | 2 | 3): boolean {
  const item = sys.getPlacedByUid(uid);
  if (!item || !sys.canPlace(item.room, item.defId, x, y, yaw, uid)) return false;
  if (item.x === x && item.y === y && item.yaw === yaw) return true;
  // a stacked piece may only leave its stack from the top, and lands on the lowest free layer of the target stack
  const def = FURNITURE_DEF_MAP.get(item.defId)!;
  const limit = stackLimitOf(def);
  if (limit > 1) {
    if (recoverBlockReason(sys.state, item)) return false;
    const layer = nextFreeLayer(stackMembers(sys.state, item.room, def, x, y, yaw, uid), limit);
    if (layer < 0) return false;
    item.layer = layer;
  }
  item.x = x; item.y = y; item.yaw = yaw;
  sys.ctx.bus.emit('housing:furnitureMoved', { item });
  sys.changed('move');
  return true;
  }

/**
 * 한국어 reason `recover(uid)` would refuse (null = go ahead). A stack blocks (the top layer leaves first), and a
 * 책장 blocks while its books cannot go to the stash (`책을 먼저 빼세요`, a cell-count estimate — `recover` itself
 * does the real placement and rolls back).
 */
export function recoverBlock(sys: HousingSystem, uid: string): string | null {
  const item = sys.getPlacedByUid(uid);
  if (!item) return '설치되지 않은 가구입니다';
  return recoverBlockReason(sys.state, item) ?? sys.booksBlock(uid);
  }

export function recover(sys: HousingSystem, uid: string): boolean {
  const i = sys.state.furniture.findIndex((f) => f.uid === uid);
  if (i < 0) return false;
  const item = sys.state.furniture[i];
  if (recoverBlockReason(sys.state, item)) return false;
  // a 책장 hands its books to the stash first; when they do not all fit nothing moves
  const hadBooks = sys.booksOf(uid).length;
  if (hadBooks > 0 && !sys.stashBooksOf(uid)) { sys.notify(BOOKS_BLOCK_REASON, 'warning'); return false; }
  sys.state.furniture.splice(i, 1);
  sys.addToStorage(item.defId, item.level);
  sys.dropPlotsOf(uid);
  sys.ctx.bus.emit('housing:furnitureRecovered', { uid, defId: item.defId, room: item.room });
  sys.changed('recover');
  if (hadBooks > 0) sys.ctx.bus.emit('housing:booksChanged', { uid, count: 0 });
  return true;
  }

export function canCraftFurniture(sys: HousingSystem, defId: string): { ok: boolean; missing: CraftIngredient[] } {
  const def = FURNITURE_DEF_MAP.get(defId);
  if (!def || !def.craft) return { ok: false, missing: [] };
  // 2026-09-08: 튜토리얼 중에는 그 단계가 허락한 가구만 (사유는 `furnitureBlock` 이 돌려준다)
  if (sys.ctx.tutorial?.blockReason('furniture', defId)) return { ok: false, missing: [] };
  const missing = missingIngredients(def.craft, sys.countDef);
  return { ok: missing.length === 0, missing };
  }

export function craftFurniture(sys: HousingSystem, defId: string): boolean {
  const def = FURNITURE_DEF_MAP.get(defId);
  if (!def || !def.craft || !sys.canCraftFurniture(defId).ok) return false;
  if (!sys.consume(def.craft)) return false;
  sys.addToStorage(defId, 1);
  sys.changed('craft');
  return true;
  }

/** 한국어 reason a placed piece cannot be upgraded (null = can). */
export function furnitureUpgradeBlock(sys: HousingSystem, uid: string): string | null {
  const item = sys.getPlacedByUid(uid);
  return item ? furnitureUpgradeReason(sys.state, item, sys.countDef, sys.nameOf) : '설치되지 않은 가구입니다';
  }

export function upgradeFurniture(sys: HousingSystem, uid: string): boolean {
  const item = sys.getPlacedByUid(uid);
  if (!item || furnitureUpgradeReason(sys.state, item, sys.countDef, sys.nameOf)) return false;
  const def = FURNITURE_DEF_MAP.get(item.defId)!;
  const cost = nextFurnitureCost(def, item.level);
  if (!cost || !sys.consume(cost)) return false;
  item.level += 1;
  sys.ctx.bus.emit('housing:furnitureUpgraded', { item });
  sys.changed('furnitureUpgrade');
  return true;
  }
