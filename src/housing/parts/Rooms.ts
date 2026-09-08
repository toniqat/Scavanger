/**
 * src/housing/parts/Rooms.ts — **방 용도와 시설 레벨**.
 *
 * 빈 방에 용도를 주는 것이 **시설 증축**(재료 소모, 발전기 Lv.1 게이트, 함선당 하나)이고,
 * 그 뒤로는 레벨을 올린다. 제거하면 가구는 가구 창고로, 업그레이드 재료는 함선 창고로 전액 돌아온다.
 * 규칙 자체는 `Rules.ts` 가 갖고, 여기서는 그 규칙에 따라 재료를 소모하고 상태를 쓴다.
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

export function canAfford(sys: HousingSystem, cost: readonly CraftIngredient[]): boolean {
  return missingIngredients(cost, sys.countDef).length === 0;
  }

/** All-or-nothing: verified with `countDef` first, then consumed def by def. */
export function consume(sys: HousingSystem, cost: readonly CraftIngredient[]): boolean {
  const inv = sys.ctx.inventory;
  if (!inv || typeof inv.consumeDefAll !== 'function') return false;
  if (!sys.canAfford(cost)) return false;
  for (const c of cost) if (!inv.consumeDefAll(c.defId, c.qty)) return false;
  return true;
  }

export function emitStashSizeIfChanged(sys: HousingSystem): void {
  const size = sys.getStashSize();
  if (size.cols === sys.lastStash.cols && size.rows === sys.lastStash.rows) return;
  sys.lastStash = size;
  sys.ctx.bus.emit('housing:stashSizeChanged', { ...size });
  }

/* ── rooms ─────────────────────────────────────────────────────────────── */
export function getRoom(sys: HousingSystem, index: number): RoomState { return sys.state.rooms[index] ?? freshRoom(); }

/**
 * 한국어 reason `setRoomPurpose` would refuse (null = allowed). Used by the room menu for button hints. `empty`
 * recovers every piece, so it is also refused while a 책장 in the room cannot hand its books to the stash.
 */
export function purposeBlock(sys: HousingSystem, index: number, purpose: RoomPurpose): string | null {
  // Phase 9 UI pass: 시설 증축 costs materials and sits behind the 발전기 gate, so the block reason covers those too.
  return purposeBuildBlockReason(sys.state, index, purpose, sys.countDef, sys.nameOf)
    ?? (purpose === 'empty' ? sys.emptyRoomBlock(index) : null);
  }

/** Materials a 시설 증축 to `purpose` would consume (empty for 빈 방). The pickers render these as cost chips. */
export function purposeCost(sys: HousingSystem, purpose: RoomPurpose): readonly CraftIngredient[] { return purposeBuildCost(purpose); }

/** Why the room cannot be emptied right now (a 책장 whose books have no stash room), null when it can. */
export function emptyRoomBlock(sys: HousingSystem, index: number): string | null {
  for (const f of sys.state.furniture) {
    if (f.room !== index || !isBookshelfDefId(f.defId)) continue;
    const reason = sys.booksBlock(f.uid);
    if (reason) return reason;
  }
  return null;
  }

/**
 * Give room `index` a purpose. Since the Phase 9 UI pass a 시설 증축 **consumes** `purposeBuildCost(purpose)` from
 * bag + stash (all-or-nothing) and needs 발전기 Lv.1; 빈 방 is free and is the path `removeRoomFacility` takes
 * after it has already worked out the refund.
 */
export function setRoomPurpose(sys: HousingSystem, index: number, purpose: RoomPurpose): boolean {
  if (!isRoomIndex(sys.state, index) || !isRoomPurpose(purpose)) return false;
  const room = sys.state.rooms[index];
  if (room.purpose === purpose) return true;
  if (sys.purposeBlock(index, purpose)) return false;
  if (purpose !== 'empty') {
    const cost = purposeBuildCost(purpose);
    if (cost.length && !sys.consume(cost)) return false;
  }
  if (purpose === 'empty') {
    // top layers first so a stack never has to be taken apart from underneath
    const inRoom = sys.state.furniture.filter((p) => p.room === index).sort((a, b) => layerOf(b) - layerOf(a));
    for (const f of inRoom) sys.recover(f.uid);
  }
  // a greenhouse that goes away takes its labs with it
  if (room.purpose === 'greenhouse' && !sys.state.rooms.some((r, i) => i !== index && r.purpose === 'greenhouse')) {
    for (let i = 0; i < sys.state.rooms.length; i++) if (sys.state.rooms[i].purpose === 'lab') sys.setRoomPurpose(i, 'empty');
  }
  room.purpose = purpose;
  room.level = purpose === 'empty' ? 0 : 1;
  sys.ctx.bus.emit('housing:roomPurposeChanged', { room: index, purpose });
  sys.changed('purpose');
  if (sys.housingMode && sys.housingRoom === index) sys.selectFurniture(null);
  return true;
  }

export function findRoom(sys: HousingSystem, purpose: RoomPurpose): number { return sys.state.rooms.findIndex((r) => r.purpose === purpose); }

/* ── facilities ────────────────────────────────────────────────────────── */
export function getFacilities(sys: HousingSystem): FacilityInfo[] { return FACILITY_IDS.map((id) => sys.getFacility(id)); }

export function getFacility(sys: HousingSystem, id: FacilityId): FacilityInfo {
  const level = facilityLevel(sys.state, id);
  return {
    id, name: facilityName(id), level, maxLevel: facilityMaxLevel(id),
    nextCost: nextFacilityCost(id, level),
    blocked: facilityBlockReason(sys.state, id, sys.countDef, sys.nameOf),
  };
  }

export function upgrade(sys: HousingSystem, id: FacilityId): boolean {
  if (!FACILITY_IDS.includes(id)) return false;
  const info = sys.getFacility(id);
  if (info.blocked || !info.nextCost) return false;
  if (!sys.consume(info.nextCost)) return false;
  const level = info.level + 1;
  if (id === 'generator') sys.state.generatorLevel = level;
  else if (id === 'storage') sys.state.storageLevel = level;
  else {
    const room = sys.state.rooms.find((r) => r.purpose === id);
    if (!room) return false;
    room.level = level;
  }
  sys.ctx.bus.emit('housing:facilityUpgraded', { id, level });
  sys.changed(`facility:${id}`);
  if (id === 'storage') sys.emitStashSizeIfChanged();
  return true;
  }

/**
 * Materials the player would get back by removing the facility in room `index` — the sum of every upgrade it was
 * raised with — the 시설 증축 price of level 1 plus every upgrade (`Rules.roomRefundCost`). Empty for a 빈 방.
 */
export function facilityRefund(sys: HousingSystem, index: number): CraftIngredient[] {
  const room = sys.state.rooms[index];
  if (!room || room.purpose === 'empty') return [];
  // the 시설 증축 price of level 1 plus every upgrade above it
  return roomRefundCost(room.purpose, Math.max(1, room.level));
  }

/**
 * 시설 제거 (Phase 9 UI pass): give the room back. Every placed piece goes to furniture storage (that is
 * `setRoomPurpose(index, 'empty')`) and every material spent on the facility's upgrades is refunded into the
 * **함선 창고**. All-or-nothing: when the stash cannot take the refund nothing is touched and the 한국어 reason is
 * returned (null = removed).
 */
export function removeRoomFacility(sys: HousingSystem, index: number): string | null {
  const room = sys.state.rooms[index];
  if (!room) return '알 수 없는 방입니다';
  if (room.purpose === 'empty') return '이미 빈 방입니다';
  const block = sys.purposeBlock(index, 'empty');
  if (block) return block;
  const refund = sys.facilityRefund(index);
  const noRoom = sys.stashSpaceBlock(refund);
  if (noRoom) return noRoom;
  if (!sys.setRoomPurpose(index, 'empty')) return '용도를 해제할 수 없습니다';
  const left = sys.refundToStash(refund);
  if (left > 0) sys.notify('함선 창고가 가득 차 일부 재료를 돌려주지 못했습니다', 'warning');
  return null;
  }

/** 한국어 reason the stash cannot take `cost` (free-cell estimate, deliberately conservative); null when it can. */
export function stashSpaceBlock(sys: HousingSystem, cost: readonly CraftIngredient[]): string | null {
  if (!cost.length) return null;
  const inv = sys.ctx.inventory;
  if (!inv || typeof inv.tryAddToStash !== 'function' || !sys.ctx.loot || typeof sys.ctx.loot.createItem !== 'function') {
    return '함선 창고를 사용할 수 없습니다';
  }
  const free = sys.freeStashCells();
  if (free < 0) return null;                                   // unknown → let the refund try for real
  let need = 0;
  for (const c of cost) {
    const def = sys.defOf(c.defId);
    const stack = Math.max(1, def?.stackMax ?? 1);
    need += Math.ceil(c.qty / stack) * (def ? def.width * def.height : 1);
  }
  return free >= need ? null : '함선 창고에 공간이 없습니다';
  }

/** Drop `cost` into the stash, splitting at `stackMax`. Returns how many units could **not** be placed. */
export function refundToStash(sys: HousingSystem, cost: readonly CraftIngredient[]): number {
  const inv = sys.ctx.inventory, loot = sys.ctx.loot;
  if (!cost.length) return 0;
  if (!inv || typeof inv.tryAddToStash !== 'function' || !loot || typeof loot.createItem !== 'function') {
    return cost.reduce((n, c) => n + c.qty, 0);
  }
  let lost = 0;
  for (const c of cost) {
    const def = sys.defOf(c.defId);
    const stack = Math.max(1, def?.stackMax ?? 1);
    let left = c.qty;
    while (left > 0) {
      const qty = Math.min(stack, left);
      const item = loot.createItem(c.defId, qty);
      if (!item || !inv.tryAddToStash(item)) { lost += left; break; }
      left -= qty;
    }
  }
  return lost;
  }

export function getBenchLevel(sys: HousingSystem, kind: WorkbenchKind): number {
  let best = 0;
  for (const f of sys.state.furniture) {
    const def = FURNITURE_DEF_MAP.get(f.defId);
    if (def && benchKindOf(def.interaction) === kind) best = Math.max(best, f.level);
  }
  return best;
  }

export function getCraftCostMul(sys: HousingSystem): number { return craftCostMulFor(facilityLevel(sys.state, 'workshop')); }

/** 사격장 (`gun_*` × `1 + 0.1 × level`) × 서재 (`getBookBonus`, every shelved book of that skill). */
export function getSkillGainMul(sys: HousingSystem, skill: SkillId): number { return skillGainMulFor(skill, facilityLevel(sys.state, 'range')) * sys.getBookBonus(skill); }

export function getStashSize(sys: HousingSystem): { cols: number; rows: number } { return stashSizeFor(sys.state.storageLevel); }
