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
  benchKindOf, isCockpitOnlyFurniture, isUtilityFurniture, slotKey,
} from '@/shared';
import { COCKPIT_ONLY_RECOVER_REASON } from '@/shared';
import type { FacilityRequirement } from '@/shared';
import {
  autoPlaceSpot,
  bookGainMulFor, bookWeightOf, canPlaceAt, craftCostMulFor, facilityBlockReason, facilityLevel, facilityMaxLevel, facilityName,
  MISSING_MATERIALS_REASON, facilityPurposeOf, furnitureUpgradeRequirementsFor, isPlaceRoom, purposeBuildBlockReason, purposeBuildCost, roomRefundCost,
  furnitureAllowedIn, furnitureUpgradeReason, isRoomIndex, isRoomPurpose, layerOf, missingIngredients, nextFacilityCost, nextFreeLayer,
  nextFurnitureCost, presetCountFor, recoverBlockReason, skillGainMulFor, stackLimitOf, stackMembers,
  stashSizeFor,
} from '../Rules';
import type { FurniturePlacement } from '../Rules';
import { ShipStore, freshRoom, isAnalyzerDefId, isBookshelfDefId, isGrowRackDefId, isGrowStationDefId, loadState, maxUidIndex, sanitize, writeState } from '../ShipState';
import { rescaleGrowsForUpgrade } from './Garden';
import { BookshelfMenu } from '../ui/BookshelfMenu';
import { createShipView } from '../ui/ShipView';
import { formatRemaining } from '../ui/dom';
import type { HousingPanel } from '../ui/Panel';
import { ACTIVE_FURNITURE_DEFS, BOOKS_BLOCK_REASON, FACILITY_IDS, PRESET_NAME_MAX } from '../model';
import type { HousingSystem } from '../HousingSystem';
import { SHELF_BLOCK_REASON } from '../model';   // A-3e (2026-09-12): 서재 매체 보관함의 회수 거절
import { clusterRecoverBlock } from './Mining';   // 2026-09-13: 암호화폐 채굴 — 코어가 꽂힌 클러스터의 회수 거절
import { returnTvConsoleForRecover, tvConsoleRecoverBlock } from './VideoGame';   // 2026-09-13 (비디오게임, H2): TV 의 게임기는 함선 창고로

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
 * 시설 관리를 **마지막으로 보던 방** (2026-09-15, 사용자 결정 — 「닫았다 다시 켜면 그 방이 포커싱돼 있어야 한다」).
 * 슬롯별 localStorage 한 줄이라 새로고침 · 캐릭터 전환도 견딘다 (`ShipState` 버전을 올리지 않는다 — 함선의 내용이
 * 아니라 **화면이 마지막으로 보던 자리**이고, 못 읽거나 이상하면 예전 기본값으로 조용히 돌아가면 그만이다).
 * 우측 탭(가구 제작 / 가구 창고)은 화면의 것이라 `ui/hud/ShipManage` 가 자기 키로 따로 기억한다.
 */
const MANAGE_ROOM_KEY = 'scav.housing.manageRoom';

function readManageRoom(): number | null {
  try {
    const raw = window.localStorage?.getItem(slotKey(MANAGE_ROOM_KEY));
    const n = raw === null || raw === undefined ? NaN : Number(raw);
    return Number.isInteger(n) ? n : null;
  } catch { return null; }
}

function writeManageRoom(room: number): void {
  try { window.localStorage?.setItem(slotKey(MANAGE_ROOM_KEY), String(room)); } catch { /* private mode · blocked site data */ }
}

/**
 * Enter the ship-management screen: the housing-mode camera / cursor without the "player stands in the room" gate,
 * plus the room list + furniture bar ui/ draws off `housing:shipManageChanged`.
 *
 * 방 고르는 순서 (2026-09-15, 사용자 결정): **부르는 쪽이 준 방** → 마지막으로 보던 방 → 서 있는 방 →
 * 용도가 있는 첫 방 → 방 1. 기억한 방이 사라졌거나(용도 제거 · 세이브 교체) 읽히지 않으면 그대로 옛 순서다.
 *
 * ⚠ **준 방이 기억한 방을 이긴다** (2026-09-15 4차 수정): 기억은 「아무 말 없이 열었을 때의 기본값」이지
 * 명령을 덮는 것이 아니다 — 조종석을 열어 달라는 `openShipManage(COCKPIT_ROOM_INDEX)`(프리셋 · 콘솔 · 상호작용)가
 * 지난번에 보던 방으로 끌려가면 안 된다. 그래서 「서 있는 방」은 인자로 넘기지 않고 **여기 폴백 사슬**에 둔다
 * (`hub/HubSystem.openShipManage` 는 인자 없이 부른다) — 그래야 기억이 산다.
 */
export function openShipManage(sys: HousingSystem, room?: number): boolean {
  if (sys.shipManageBlock()) return false;
  // 2026-09-12: 조종석(`COCKPIT_ROOM_INDEX`)도 편집 대상이다 — 방 번호가 아니라 「가구를 놓을 수 있는 자리」로 본다
  const remembered = readManageRoom();
  const target = isPlaceRoom(sys.state, room ?? -1)
    ? (room as number)
    : remembered !== null && isPlaceRoom(sys.state, remembered)
      ? remembered
      : sys.ctx.hub?.currentRoom ?? sys.state.rooms.findIndex((r) => r.purpose !== 'empty');
  const index = isPlaceRoom(sys.state, target) ? target : 0;
  sys.enterMode(index);
  sys.shipManageMode = true;
  writeManageRoom(index);
  sys.ctx.bus.emit('housing:shipManageChanged', { active: true, room: index });
  return true;
  }

export function setManageRoom(sys: HousingSystem, room: number): boolean {
  if (!sys.shipManageMode || !isPlaceRoom(sys.state, room)) return false;
  if (sys.housingRoom === room) return true;
  writeManageRoom(room);   // 2026-09-15: 마지막으로 보던 방 (다음에 시설 관리를 열면 여기로 온다)
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
/**
 * Def by id — **은퇴 가구도 돌려준다**. 옛 세이브가 들고 있던 가구의 값(`furnitureRefundCost`)을 알려면 필요하고,
 * 목록에 실릴지 말지는 `getAllFurnitureDefs` · `getFurnitureFor` 가 따로 정한다 (온실 개편, 2026-09-11).
 */
export function getFurnitureDef(sys: HousingSystem, id: string): FurnitureDef | undefined { return FURNITURE_DEF_MAP.get(id); }

/** 카탈로그 — `retired` 가구는 빠진다. */
export function getAllFurnitureDefs(sys: HousingSystem): readonly FurnitureDef[] { return ACTIVE_FURNITURE_DEFS; }

export function getFurnitureFor(sys: HousingSystem, purpose: RoomPurpose): readonly FurnitureDef[] { return ACTIVE_FURNITURE_DEFS.filter((d) => furnitureAllowedIn(d, purpose)); }

export function getPlaced(sys: HousingSystem, room?: number): readonly PlacedFurniture[] { return room === undefined ? sys.state.furniture : sys.state.furniture.filter((f) => f.room === room); }

export function getPlacedByUid(sys: HousingSystem, uid: string): PlacedFurniture | null { return sys.state.furniture.find((f) => f.uid === uid) ?? null; }

export function getStored(sys: HousingSystem): readonly StoredFurniture[] { return sys.state.furnitureStorage; }

export function canPlace(sys: HousingSystem, room: number, defId: string, x: number, y: number, yaw: 0 | 1 | 2 | 3, ignoreUid?: string): boolean {
  const def = FURNITURE_DEF_MAP.get(defId);
  return !!def && canPlaceAt(sys.state, room, def, x, y, yaw, ignoreUid);
  }

/**
 * 자동 배치가 고를 자리 (2026-09-10). 규칙 · 근거는 `Rules.autoPlaceSpot` 의 주석에 전부 있다 — 화면 좌측
 * 상단부터 가로줄을 먼저 채우고, 가구는 화면 아래(월드 +X, yaw 1)를 향한다. `null` = 이 방에 자리가 없다.
 * 손으로 놓는 경로(하우징 모드의 고스트 · `move`)는 이 함수를 거치지 않으므로 사용자가 돌린 회전은 그대로다.
 */
export function findFreeSpot(sys: HousingSystem, room: number, defId: string): FurniturePlacement | null {
  const def = FURNITURE_DEF_MAP.get(defId);
  if (!def) return null;
  return autoPlaceSpot(sys.state, room, def);
  }

export function place(sys: HousingSystem, room: number, defId: string, x: number, y: number, yaw: 0 | 1 | 2 | 3): PlacedFurniture | null {
  if (sys.ctx.tutorial?.blockReason('furniture', defId)) return null;   // 2026-09-08: 튜토리얼 순서 강제
  const entry = sys.storageEntry(defId);
  const def = FURNITURE_DEF_MAP.get(defId);
  if (!def || def.retired || !entry || !sys.canPlace(room, defId, x, y, yaw)) return null;   // 은퇴 가구는 다시 놓지 않는다
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
  // 2026-09-13 (사용자 결정): 조종석 전용 시설(시술대 · 컴퓨터)은 가구 창고로 돌아가지 않는다 — 조종석 안에서 옮기기만 한다
  if (isCockpitOnlyFurniture(FURNITURE_DEF_MAP.get(item.defId))) return COCKPIT_ONLY_RECOVER_REASON;
  // A-3e (2026-09-12): 디스크 전시대 · 레코드랙도 책장처럼 — 담긴 것이 창고에 안 들어가면 `…를 먼저 빼세요`
  // 2026-09-13 (암호화폐 채굴): 코어가 꽂힌 연산 클러스터는 `코어를 먼저 빼세요`
  // 2026-09-13 (비디오게임): 게임기가 장착된 TV 는 그 게임기가 함선 창고에 들어가야 회수된다
  return recoverBlockReason(sys.state, item) ?? sys.booksBlock(uid) ?? sys.shelfBlock(uid) ?? clusterRecoverBlock(sys, uid) ?? tvConsoleRecoverBlock(sys, uid);
  }

export function recover(sys: HousingSystem, uid: string): boolean {
  const i = sys.state.furniture.findIndex((f) => f.uid === uid);
  if (i < 0) return false;
  const item = sys.state.furniture[i];
  // 2026-09-13: 조종석 전용 시설은 회수할 수 없다 (시설 관리는 `recoverBlock` 을 먼저 보고 자기 토스트를 띄운다 — 여기는 그 밖의 호출자용)
  if (isCockpitOnlyFurniture(FURNITURE_DEF_MAP.get(item.defId))) { sys.notify(COCKPIT_ONLY_RECOVER_REASON, 'warning'); return false; }
  if (recoverBlockReason(sys.state, item)) return false;
  // 2026-09-13: 코어가 꽂힌 연산 클러스터는 회수하지 않는다 (코어는 가구 창고로 사라지면 안 된다) — 빈 칸은 `parts/Mining` 이 회수 이벤트에서 지운다
  const clusterBlock = clusterRecoverBlock(sys, uid);
  if (clusterBlock) { sys.notify(clusterBlock, 'warning'); return false; }
  // a 책장 hands its books to the stash first; when they do not all fit nothing moves
  const hadBooks = sys.booksOf(uid).length;
  if (hadBooks > 0 && !sys.stashBooksOf(uid)) { sys.notify(BOOKS_BLOCK_REASON, 'warning'); return false; }
  // A-3e: a 디스크 전시대 · 레코드랙 does the same with its media (all or nothing)
  const shelfMedium = sys.getShelfMedium(uid);
  const hadMedia = shelfMedium && shelfMedium !== 'book' ? sys.shelfItemsOf(uid).length : 0;
  if (hadMedia > 0 && !sys.stashShelfItemsOf(uid)) { sys.notify(SHELF_BLOCK_REASON[shelfMedium!], 'warning'); return false; }
  // 2026-09-13 (비디오게임, H2): TV 에 장착된 게임기는 함선 창고로 — 자리가 없으면 아무것도 바꾸지 않고 회수를 거절한다 (보관함과 같은 규약)
  const consoleRefusal = returnTvConsoleForRecover(sys, uid);
  if (consoleRefusal) { sys.notify(consoleRefusal, 'warning'); return false; }
  sys.dropToggled(uid);                       // 회수한 TV · 레코드 플레이어의 켜짐은 남기지 않는다
  sys.state.furniture.splice(i, 1);
  sys.addToStorage(item.defId, item.level);
  sys.dropGrowsOf(uid);                       // 재배 스테이션을 회수하면 토양 · 작물도 함께 사라진다
  sys.dropAnalysesOf(uid);                    // 분석기를 회수하면 해석 중이던 표본도 함께 사라진다 (같은 규약)
  sys.dropCulturesOf(uid);                    // 배양조를 회수하면 배지 · 배양 중이던 세포주도 함께 사라진다
  sys.ctx.bus.emit('housing:furnitureRecovered', { uid, defId: item.defId, room: item.room });
  sys.changed('recover');
  if (hadBooks > 0) {
    sys.ctx.bus.emit('housing:booksChanged', { uid, count: 0 });
    sys.ctx.bus.emit('housing:shelfChanged', { uid, medium: 'book', count: 0 });
  }
  if (hadMedia > 0 && shelfMedium) sys.ctx.bus.emit('housing:shelfChanged', { uid, medium: shelfMedium, count: 0 });
  return true;
  }

export function canCraftFurniture(sys: HousingSystem, defId: string): { ok: boolean; missing: CraftIngredient[] } {
  const def = FURNITURE_DEF_MAP.get(defId);
  if (!def || !def.craft || def.retired) return { ok: false, missing: [] };   // 은퇴 가구는 제작 목록에 없다
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
  // 2026-09-13: 재배 스테이션의 강화는 성장 속도다 — 자라던 작물의 남은 시간을 그 자리에서 줄인다 (Garden 이 규칙을 갖는다)
  if (isGrowStationDefId(item.defId)) rescaleGrowsForUpgrade(sys, uid, item.level - 1, item.level);
  sys.ctx.bus.emit('housing:furnitureUpgraded', { item });
  sys.changed('furnitureUpgrade');
  // 강화는 분석기의 해석 칸을 하나 더 여는 것이기도 하다 — 계약의 `housing:analysisChanged` 가 「강화」를 포함한다
  // (`sys.changed` 는 위에서 이미 났으므로 여기서는 버스에만 올린다)
  if (isAnalyzerDefId(item.defId)) sys.ctx.bus.emit('housing:analysisChanged', { uid, ready: sys.readyAnalyses(uid) });
  return true;
  }

/* ── B-13: 배치된 가구 강화 · 제작 잠금 (2026-09-11) ─────────────────────────
 * `upgradeFurniture` 는 Phase 8 부터 있었지만 부르는 곳이 없어 작업대 Lv.2–3 이 플레이로 닿지 않았다. 시설 관리의
 * 클릭 인스펙터가 이 둘(비용 · 사유)을 읽어 카드를 그린다. ────────────────── */

/** 이 조각의 **다음 레벨** 비용. 최대 레벨이거나 배치된 조각이 아니면 null (`Rules.nextFurnitureCost` 위임). */
export function furnitureUpgradeCost(sys: HousingSystem, uid: string): CraftIngredient[] | null {
  const item = sys.getPlacedByUid(uid);
  if (!item) return null;
  const def = FURNITURE_DEF_MAP.get(item.defId);
  return def ? nextFurnitureCost(def, item.level) : null;
  }

/** 배치됐거나 가구 창고에 있는 그 가구를 하나라도 갖고 있는가 (B-13 의 「이미 보유 중」 판정). */
function ownsFurniture(sys: HousingSystem, defId: string): boolean {
  return sys.state.furniture.some((f) => f.defId === defId)
    || sys.state.furnitureStorage.some((s) => s.defId === defId && s.qty > 0);
  }

/**
 * 지금 이 가구를 **제작**할 수 없는 한국어 사유, null = 만들 수 있다 (B-13, 사용자 결정 2026-09-11).
 * 재료 부족과 별개로, **이미 가지고 있는 실용 가구**(`isUtilityFurniture` — E 로 뭔가를 하는 가구, 배치 + 가구
 * 창고 합산)는 여기서 잠긴다: 벤치 레벨은 가장 높은 하나만 세므로 두 번째를 만들 이유가 없다. 장식 가구
 * (`interaction: 'none'`)는 얼마든지 만든다. 순서는 다른 block 함수와 같다 — 구조 → 튜토리얼 → 보유 → 재료.
 *
 * **규칙 자체(`canCraftFurniture` / `craftFurniture`)는 바뀌지 않았다** — 이것은 화면이 카드를 딤드로 그리고
 * 목록 맨 아래로 내리기 위한 질의다 (CLAUDE.md §4 「같은 실용 가구를 둘 만들 이유가 없다」).
 */
export function furnitureCraftBlock(sys: HousingSystem, defId: string): string | null {
  const def = FURNITURE_DEF_MAP.get(defId);
  if (!def) return '알 수 없는 가구입니다';
  if (def.retired) return '더 이상 만들 수 없는 가구입니다';
  const tutorial = sys.ctx.tutorial?.blockReason('furniture', defId);
  if (tutorial) return tutorial;
  // 2026-09-13: `multi` 가구(연산 클러스터)는 실용 가구여도 여러 대 만든다 — 메인 컴퓨터는 여전히 함선당 하나
  if (isUtilityFurniture(def) && !def.multi && ownsFurniture(sys, defId)) return '이미 보유 중입니다';
  // 2026-09-12: 공용 시설 가구(시술대 · 컴퓨터)는 `craft` 가 비어 있다 — 늘 가지고 있으므로 보통은 위 줄이 먼저 답한다
  if (!def.craft) return '제작할 수 없는 가구입니다';
  const missing = missingIngredients(def.craft, sys.countDef);
  if (missing.length) return MISSING_MATERIALS_REASON;
  return null;
  }

/**
 * 2026-09-12: 놓인 가구 `uid` 의 **다음 강화**를 막는 시설 레벨 요구 (채워지지 않은 것만 — 지금은 발전기 하나).
 * 규칙은 `Rules.furnitureUpgradeRequirementsFor` 하나다 — `furnitureUpgradeReason` 의 발전기 게이트와 같은 식이다.
 */
export function furnitureUpgradeRequirements(sys: HousingSystem, uid: string): FacilityRequirement[] {
  const item = sys.getPlacedByUid(uid);
  return item ? furnitureUpgradeRequirementsFor(sys.state, item) : [];
  }
