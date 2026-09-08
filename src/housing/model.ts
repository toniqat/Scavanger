/**
 * src/housing/model.ts — 함선 꾸미기 폴더의 공용 어휘.
 *
 * `HousingSystem` 에서 떼어낸 상수 · 타입(그리고 상태 없는 보조 클래스)만 있다. 클래스를 참조하지 않으므로
 * `parts/*` 모듈이 `HousingSystem.ts` 를 되돌아 import 하지 않고 쓸 수 있다(순환 import 방지).
 * `HousingSystem.ts` 가 `export *` 로 재수출하므로 기존 import 경로는 전부 유지된다.
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
} from './Rules';
import { ShipStore, freshRoom, isBookshelfDefId, isGrowRackDefId, loadState, maxUidIndex, sanitize, writeState } from './ShipState';
import { PresetMenu } from './ui/PresetMenu';
import { GrowMenu } from './ui/GrowMenu';
import { BookshelfMenu } from './ui/BookshelfMenu';
import { createShipView } from './ui/ShipView';
import { formatRemaining } from './ui/dom';
import type { HousingPanel } from './ui/Panel';
import './housing.css';

export const FACILITY_IDS: readonly FacilityId[] = ['generator', 'storage', 'workshop', 'range'];
export const PRESET_NAME_MAX = 24;
/** 한국어 refusal when a 책장 cannot be recovered because its books have nowhere to go. */
export const BOOKS_BLOCK_REASON = '책을 먼저 빼세요';

/**
 * Ship housing (함선 꾸미기): owns the ShipState (rooms / facilities / furniture / presets), every rule and number
 * (see Rules.ts), persistence (ShipState.ts) and the three DOM panels (ui/). Publishes `ctx.housing`.
 * hub/ builds the geometry and the housing-mode camera / cursor on top of this API and its `housing:*` events.
 *
 * Materials come from `ctx.inventory.countDefAll / consumeDefAll` (bag + stash); both are guarded with `typeof`
 * because inventory/ is built in parallel — without them nothing can be bought.
 * Phase 7: the state is mirrored into the server profile document `ship` on every save; `net:profileLoaded` replaces
 * it with the server copy and re-emits `housing:loaded` so hub/ rebuilds the personal ship.
 * Phase 9: 서재 책장 — `ShipState.books` (one `PlacedBook` per filled shelf slot) + `bookDex`; the 서재 multiplier
 * (`getBookBonus`, Rules.bookGainMulFor) is folded into `getSkillGainMul`, so progression/ reads one number.
 */

