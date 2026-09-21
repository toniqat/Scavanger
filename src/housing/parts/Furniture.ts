/**
 * src/housing/parts/Furniture.ts — **furniture placement · craft · recovery** and ship-management mode.
 *
 * Furniture is **not an item** — it exists only in furniture storage and is crafted there. The placement rules
 * (does it fit the room purpose, does it overlap, can it stack) and ship-management mode's cursor state live here.
 */
import type {
  CraftIngredient, FurnitureDef, PlacedFurniture, RoomPurpose, StoredFurniture,
} from '@/shared';
import {
  FURNITURE_DEF_MAP, isCockpitOnlyFurniture, isUtilityFurniture, slotKey,
} from '@/shared';
import { COCKPIT_ONLY_RECOVER_REASON } from '@/shared';
import type { FacilityRequirement } from '@/shared';
import {
  autoPlaceSpot,
  canPlaceAt, MISSING_MATERIALS_REASON, furnitureUpgradeRequirementsFor, isPlaceRoom, furnitureAllowedIn, furnitureUpgradeReason, isRoomIndex, missingIngredients, nextFreeLayer,
  nextFurnitureCost, recoverBlockReason, stackLimitOf, stackMembers,
} from '../Rules';
import type { FurniturePlacement } from '../Rules';
import { isAnalyzerDefId, isGrowStationDefId } from '../ShipState';
import { rescaleGrowsForUpgrade } from './Garden';
import type {  } from '../ui/Panel';
import { ACTIVE_FURNITURE_DEFS, BOOKS_BLOCK_REASON } from '../model';
import type { HousingSystem } from '../HousingSystem';
import { SHELF_BLOCK_REASON } from '../model';   // A-3e (2026-09-12): the library media holders' recovery refusal
import { clusterRecoverBlock } from './Mining';   // 2026-09-13: crypto mining — a cluster with a processor in it refuses recovery
import { returnTvConsoleForRecover, tvConsoleRecoverBlock } from './VideoGame';   // 2026-09-13 (video games, H2): the TV's console goes to the ship stash

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
  // 2026-09-16: ship management does not open while the ship-track tutorial (the stat-investment guide) runs — tutorial judges it
  const tut = ctx.tutorial?.blockReason('shipManage') ?? null;
  if (tut) return tut;
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

/* ── ship management (Phase 8, M in the ship) ─────────────────────────── */

/**
 * The **room ship management last showed** (2026-09-15, user's decision — 「reopening it focuses that room」).
 * One per-slot localStorage line, so a reload · a character switch survive it (the `ShipState` version is not raised
 * — this is not the ship's contents but **where the screen last looked**, and silently reverting to the old default
 * is enough). The right-hand tabs (furniture craft / storage) are the screen's — `ui/hud/ShipManage` has its own key.
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
 * Room pick order (2026-09-15, user's decision): **the caller's room** → the last shown room → the room stood in →
 * the first with a purpose → room 1. A remembered room gone (purpose removed · save swapped) or unreadable = old order.
 *
 * ⚠ **the passed room beats the remembered one** (2026-09-15, 4th pass): the memory is 「the default when it is opened
 * with nothing said」, not an override of an order — `openShipManage(COCKPIT_ROOM_INDEX)` asking for the cockpit (preset ·
 * console · interaction) must not be dragged to the room last seen. So 「the room stood in」 is not an argument but
 * sits in **the fallback chain here** (`hub/HubSystem.openShipManage` passes none) — that is what keeps the memory alive.
 */
export function openShipManage(sys: HousingSystem, room?: number): boolean {
  if (sys.shipManageBlock()) return false;
  // 2026-09-12: the cockpit (`COCKPIT_ROOM_INDEX`) is edited too — read as 「a place furniture can go」, not a room number
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
  writeManageRoom(room);   // 2026-09-15: the room last shown (the next ship-management open comes here)
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
 * Def by id — **retired furniture is returned too**: an old save's furniture needs its worth (`furnitureRefundCost`),
 * and `getAllFurnitureDefs` · `getFurnitureFor` decide separately whether it is listed (greenhouse rework, 2026-09-11).
 */
export function getFurnitureDef(sys: HousingSystem, id: string): FurnitureDef | undefined { return FURNITURE_DEF_MAP.get(id); }

/** The catalogue — `retired` furniture is left out. */
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
 * The spot auto placement picks (2026-09-10). Rules · reasoning are all in `Rules.autoPlaceSpot`'s comment — rows fill
 * first from the screen's top-left and furniture faces screen-down (world +X, yaw 1). `null` = no spot in this room.
 * Hand placement (the housing-mode ghost · `move`) skips this function, so a rotation the player turned is left alone.
 */
export function findFreeSpot(sys: HousingSystem, room: number, defId: string): FurniturePlacement | null {
  const def = FURNITURE_DEF_MAP.get(defId);
  if (!def) return null;
  return autoPlaceSpot(sys.state, room, def);
}

export function place(sys: HousingSystem, room: number, defId: string, x: number, y: number, yaw: 0 | 1 | 2 | 3): PlacedFurniture | null {
  if (sys.ctx.tutorial?.blockReason('furniture', defId)) return null;   // 2026-09-08: the tutorial order gate
  const entry = sys.storageEntry(defId);
  const def = FURNITURE_DEF_MAP.get(defId);
  if (!def || def.retired || !entry || !sys.canPlace(room, defId, x, y, yaw)) return null;   // retired furniture is never placed again
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
 * Korean reason `recover(uid)` would refuse (null = go ahead). A stack blocks (the top layer leaves first), and a
 * 책장 blocks while its books cannot go to the stash (`책을 먼저 빼세요`, a cell-count estimate — `recover` itself
 * does the real placement and rolls back).
 */
export function recoverBlock(sys: HousingSystem, uid: string): string | null {
  const item = sys.getPlacedByUid(uid);
  if (!item) return '설치되지 않은 가구입니다';
  // 2026-09-13 (user's decision): cockpit-only facilities (implant bay · corp computer) never go back to furniture storage — they only move inside the cockpit
  if (isCockpitOnlyFurniture(FURNITURE_DEF_MAP.get(item.defId))) return COCKPIT_ONLY_RECOVER_REASON;
  // A-3e (2026-09-12): the disc stand · record rack behave like the 책장 — what they hold not fitting the stash gives `…를 먼저 빼세요`
  // 2026-09-13 (crypto mining): a compute cluster with a processor in it gives `프로세서를 먼저 빼세요`
  // 2026-09-13 (video games): a TV with a console mounted is recovered only once that console fits the ship stash
  return recoverBlockReason(sys.state, item) ?? sys.booksBlock(uid) ?? sys.shelfBlock(uid) ?? clusterRecoverBlock(sys, uid) ?? tvConsoleRecoverBlock(sys, uid);
}

export function recover(sys: HousingSystem, uid: string): boolean {
  const i = sys.state.furniture.findIndex((f) => f.uid === uid);
  if (i < 0) return false;
  const item = sys.state.furniture[i];
  // 2026-09-13: cockpit-only facilities cannot be recovered (ship management reads `recoverBlock` first and raises its own toast — this is for every other caller)
  if (isCockpitOnlyFurniture(FURNITURE_DEF_MAP.get(item.defId))) { sys.notify(COCKPIT_ONLY_RECOVER_REASON, 'warning'); return false; }
  if (recoverBlockReason(sys.state, item)) return false;
  // 2026-09-13: a compute cluster with a processor in it is not recovered (a processor carrying durability must not vanish into furniture storage) — `parts/Mining` clears the empty cells on the recover event
  const clusterBlock = clusterRecoverBlock(sys, uid);
  if (clusterBlock) { sys.notify(clusterBlock, 'warning'); return false; }
  // a 책장 hands its books to the stash first; when they do not all fit nothing moves
  const hadBooks = sys.booksOf(uid).length;
  if (hadBooks > 0 && !sys.stashBooksOf(uid)) { sys.notify(BOOKS_BLOCK_REASON, 'warning'); return false; }
  // A-3e: a 디스크 전시대 · 레코드랙 does the same with its media (all or nothing)
  const shelfMedium = sys.getShelfMedium(uid);
  const hadMedia = shelfMedium && shelfMedium !== 'book' ? sys.shelfItemsOf(uid).length : 0;
  if (hadMedia > 0 && !sys.stashShelfItemsOf(uid)) { sys.notify(SHELF_BLOCK_REASON[shelfMedium!], 'warning'); return false; }
  // 2026-09-13 (video games, H2): a console mounted on the TV goes to the ship stash — with no room it changes nothing and refuses the recovery (the same contract as the holders)
  const consoleRefusal = returnTvConsoleForRecover(sys, uid);
  if (consoleRefusal) { sys.notify(consoleRefusal, 'warning'); return false; }
  sys.dropToggled(uid);                       // a recovered TV · record player does not keep its on state
  sys.state.furniture.splice(i, 1);
  sys.addToStorage(item.defId, item.level);
  sys.dropGrowsOf(uid);                       // recovering a grow station loses its soil · crops with it
  sys.dropAnalysesOf(uid);                    // recovering an analyzer loses the sample under analysis with it (the same contract)
  sys.dropCulturesOf(uid);                    // recovering a culture tank loses its medium · the strain being cultured with it
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
  if (!def || !def.craft || def.retired) return { ok: false, missing: [] };   // retired furniture is not in the craft list
  // 2026-09-08: during the tutorial only the furniture that step allows (the reason comes from `furnitureBlock`)
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

/** Korean reason a placed piece cannot be upgraded (null = can). */
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
  // 2026-09-13: a grow station's upgrade is growth speed — it shortens the remaining time of growing crops on the spot (Garden owns the rule)
  if (isGrowStationDefId(item.defId)) rescaleGrowsForUpgrade(sys, uid, item.level - 1, item.level);
  sys.ctx.bus.emit('housing:furnitureUpgraded', { item });
  sys.changed('furnitureUpgrade');
  // an upgrade also opens one more analysis slot on the analyzer — the contract's `housing:analysisChanged` covers 「upgrade」
  // (`sys.changed` already fired above, so only the bus is raised here)
  if (isAnalyzerDefId(item.defId)) sys.ctx.bus.emit('housing:analysisChanged', { uid, ready: sys.readyAnalyses(uid) });
  return true;
}

/* ── B-13: placed-furniture upgrade · craft lock (2026-09-11) ────────────────
 * `upgradeFurniture` has existed since Phase 8 but nothing called it, so workbench Lv.2–3 never came within reach in
 * play. Ship management's click inspector reads these two (cost · reason) and draws the card. ────────────── */

/** This piece's **next level** cost. null at max level or when it is not a placed piece (delegates to `Rules.nextFurnitureCost`). */
export function furnitureUpgradeCost(sys: HousingSystem, uid: string): CraftIngredient[] | null {
  const item = sys.getPlacedByUid(uid);
  if (!item) return null;
  const def = FURNITURE_DEF_MAP.get(item.defId);
  return def ? nextFurnitureCost(def, item.level) : null;
}

/** Whether at least one of that furniture is owned, placed or in furniture storage (B-13's 「이미 보유 중」 judgement). */
function ownsFurniture(sys: HousingSystem, defId: string): boolean {
  return sys.state.furniture.some((f) => f.defId === defId)
    || sys.state.furnitureStorage.some((s) => s.defId === defId && s.qty > 0);
}

/**
 * The Korean reason this furniture cannot be **crafted** now, null = it can be (B-13, user's decision 2026-09-11).
 * Apart from missing materials, **a utility piece already owned** (`isUtilityFurniture` — furniture E does something
 * with, placed + furniture storage summed) is locked here: bench level counts only the highest one, so a second has no
 * reason to exist. Decor furniture (`interaction: 'none'`) has no limit. The order matches every other block function
 * — structure → tutorial → owned → materials.
 *
 * **The rule itself (`canCraftFurniture` / `craftFurniture`) has not changed** — it is a query so the screen can draw
 * the card dimmed and sink it down the list (CLAUDE.md §4 「there is no reason to build two of the same utility piece」).
 */
export function furnitureCraftBlock(sys: HousingSystem, defId: string): string | null {
  const def = FURNITURE_DEF_MAP.get(defId);
  if (!def) return '알 수 없는 가구입니다';
  if (def.retired) return '더 이상 만들 수 없는 가구입니다';
  const tutorial = sys.ctx.tutorial?.blockReason('furniture', defId);
  if (tutorial) return tutorial;
  // 2026-09-13: a `multi` piece (the compute cluster) is built many times even as a utility piece — the main computer is still one per ship
  if (isUtilityFurniture(def) && !def.multi && ownsFurniture(sys, defId)) return '이미 보유 중입니다';
  // 2026-09-12: shared-facility furniture (implant bay · corp computer) has an empty `craft` — it is always owned, so the line above usually answers first
  if (!def.craft) return '제작할 수 없는 가구입니다';
  const missing = missingIngredients(def.craft, sys.countDef);
  if (missing.length) return MISSING_MATERIALS_REASON;
  return null;
}

/**
 * 2026-09-12: facility level requirements blocking the **next upgrade** of placed furniture `uid` (unmet ones only —
 * today just the generator). One rule, `Rules.furnitureUpgradeRequirementsFor` — the same formula as the generator
 * gate in `furnitureUpgradeReason`.
 */
export function furnitureUpgradeRequirements(sys: HousingSystem, uid: string): FacilityRequirement[] {
  const item = sys.getPlacedByUid(uid);
  return item ? furnitureUpgradeRequirementsFor(sys.state, item) : [];
}
