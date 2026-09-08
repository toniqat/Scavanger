/**
 * src/housing/parts/Presets.ts — **로드아웃 프리셋** (사격장의 관물대).
 *
 * 저장은 `inventory.captureLoadout`, 적용은 `applyLoadout` 을 그대로 부른다 —
 * 여기서 하는 일은 사격장 레벨이 정한 개수만큼 슬롯을 관리하는 것뿐이다.
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

/* ── loadout presets (사격장) ──────────────────────────────────────────── */
export function getPresetCount(sys: HousingSystem): number { return presetCountFor(facilityLevel(sys.state, 'range')); }

export function getPresets(sys: HousingSystem): readonly (LoadoutPreset | null)[] {
  const n = sys.getPresetCount();
  return Array.from({ length: n }, (_, i) => sys.state.presets[i] ?? null);
  }

export function savePreset(sys: HousingSystem, index: number, preset: LoadoutPreset): boolean {
  if (!Number.isInteger(index) || index < 0 || index >= sys.getPresetCount() || !preset) return false;
  const implant = preset.implant && (IMPLANT_IDS as readonly string[]).includes(preset.implant) ? preset.implant : null;
  const copy: LoadoutPreset = {
    name: (preset.name || `프리셋 ${index + 1}`).slice(0, PRESET_NAME_MAX),
    primary: preset.primary ?? null, primary2: preset.primary2 ?? null, secondary: preset.secondary ?? null,
    bag: preset.bag ?? null, armor: preset.armor ?? null, implant,
    // appended (2026-09-08): 임플란트 아이템. Omitted entirely when the caller had none to say, so an old preset
    // re-saved by an old path never silently gains an empty list (which would mean "unequip everything").
    ...(preset.implantItems ? { implantItems: preset.implantItems.filter((d) => typeof d === 'string' && !!d).slice(0, 16) } : {}),
  };
  while (sys.state.presets.length <= index) sys.state.presets.push(null);
  sys.state.presets[index] = copy;
  sys.changed('preset');
  return true;
  }

export function deletePreset(sys: HousingSystem, index: number): boolean {
  if (!sys.state.presets[index]) return false;
  sys.state.presets[index] = null;
  while (sys.state.presets.length && sys.state.presets[sys.state.presets.length - 1] === null) sys.state.presets.pop();
  sys.changed('preset');
  return true;
  }

export function applyPreset(sys: HousingSystem, index: number): { equipped: number; missing: string[] } | null {
  const preset = index >= 0 && index < sys.getPresetCount() ? sys.state.presets[index] : null;
  if (!preset || sys.ctx.phase !== 'hub') return null;
  const inv = sys.ctx.inventory;
  if (!inv || typeof inv.applyLoadout !== 'function') return null;
  const result = inv.applyLoadout(preset);
  sys.ctx.bus.emit('housing:presetApplied', { index, equipped: result.equipped, missing: result.missing });
  return result;
  }

/** Current equipment as a preset (`ctx.inventory.captureLoadout`), null while inventory has no capture yet. */
export function captureLoadout(sys: HousingSystem): LoadoutPreset | null {
  const inv = sys.ctx.inventory;
  if (!inv || typeof inv.captureLoadout !== 'function') return null;
  return inv.captureLoadout();
  }

/* ── UI ────────────────────────────────────────────────────────────────── */
export function panels(sys: HousingSystem): HousingPanel[] {
  const out: HousingPanel[] = [];
  if (sys.presetMenu) out.push(sys.presetMenu);
  if (sys.growMenu) out.push(sys.growMenu);
  if (sys.bookshelfMenu) out.push(sys.bookshelfMenu);
  return out;
  }

/**
 * Phase 8 UI pass: the standalone 방 메뉴 and 함선 시설 메뉴 are gone — rooms and facilities are managed from the
 * Tab 함선 tab (`createShipView`) and from 시설 관리. Both entries stay in the contract and redirect there, so an
 * old caller opens the manage screen on that room instead of nothing at all.
 */
export function openRoomMenu(sys: HousingSystem, room: number): void {
  sys.openShipManage(isRoomIndex(sys.state, room) ? room : undefined);
  }

export function openFacilityMenu(sys: HousingSystem): void {
  sys.openShipManage();
  }

export function openPresetMenu(sys: HousingSystem): void {
  if (!sys.presetMenu) return;
  sys.exitHousingMode();
  sys.closeMenus(false);
  if (sys.getPresetCount() === 0) sys.notify('사격장 방이 있어야 프리셋을 쓸 수 있습니다', 'warning');
  sys.presetMenu.open();
  }

/** Close every panel; `relock` false when another panel opens right away. */
export function closeMenus(sys: HousingSystem, relock = true): void {
  for (const p of sys.panels()) if (p.isOpen) p.close(relock);
  }
