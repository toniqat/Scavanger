/**
 * src/housing/parts/Garden.ts — **온실 재배** (Phase 8).
 *
 * 쌓을 수 있는 재배층에 씨앗을 심으면 `ctx.net.serverNow()` 기준 **실제 시간** 1–6 시간 뒤에 여문다
 * (레이드 중에도 자란다). 시계는 서버가 검증하지 않으므로 오프라인 프로필은 로컬 시계를 믿는다.
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

/* ── 온실 재배 (Phase 8) ───────────────────────────────────────────────── */
export function plots(sys: HousingSystem): GrowPlot[] {
  if (!Array.isArray(sys.state.plots)) sys.state.plots = [];
  return sys.state.plots;
  }

/** The 재배층 behind `uid`, or null when it is not a rack (or gone). */
export function rackOf(sys: HousingSystem, uid: string): PlacedFurniture | null {
  const item = sys.getPlacedByUid(uid);
  return item && isGrowRackDefId(item.defId) ? item : null;
  }

export function plotAt(sys: HousingSystem, uid: string, slot: number): GrowPlot | null {
  return sys.plots().find((p) => p.uid === uid && p.slot === slot) ?? null;
  }

/** Drop every plot of a rack that is being recovered (its crops go with it). */
export function dropPlotsOf(sys: HousingSystem, uid: string): void {
  const plots = sys.plots();
  for (let i = plots.length - 1; i >= 0; i--) if (plots[i].uid === uid) plots.splice(i, 1);
  }

/** Ready plots of a rack (for the `housing:growChanged` payload and the hub's rack visuals). */
export function readyCount(sys: HousingSystem, uid: string): number {
  const now = sys.nowMs();
  return sys.plots().filter((p) => p.uid === uid && now >= p.readyAt).length;
  }

export function growChanged(sys: HousingSystem, uid: string, reason: string): void {
  sys.changed(reason);
  sys.ctx.bus.emit('housing:growChanged', { uid, ready: sys.readyCount(uid) });
  }

/** Seed def with its `seed` data, or null when `defId` is not a seed. */
export function seedDef(sys: HousingSystem, defId: string): ItemDef | null {
  const def = sys.defOf(defId);
  return def && def.seed ? def : null;
  }

/** 원예 skill 0..SKILL_LEVEL_MAX. */
export function gardening(sys: HousingSystem): number {
  const p = sys.ctx.progression;
  if (!p || typeof p.getSkill !== 'function') return 0;
  const v = p.getSkill('gardening');
  return Number.isFinite(v) ? Math.max(0, Math.min(SKILL_LEVEL_MAX, v)) : 0;
  }

export function getPlots(sys: HousingSystem, uid: string): GrowPlotInfo[] {
  if (!sys.rackOf(uid)) return [];
  const now = sys.nowMs();
  const out: GrowPlotInfo[] = [];
  for (let slot = 0; slot < GROW_PLOTS_PER_RACK; slot++) {
    const plot = sys.plotAt(uid, slot);
    if (!plot) {
      out.push({ slot, seedDefId: null, progress: -1, remainingS: 0, ready: false, yieldDefId: null, yieldQty: 0 });
      continue;
    }
    const total = Math.max(1, plot.readyAt - plot.plantedAt);
    const seed = sys.seedDef(plot.seedDefId)?.seed ?? null;
    out.push({
      slot,
      seedDefId: plot.seedDefId,
      progress: Math.max(0, Math.min(1, (now - plot.plantedAt) / total)),
      remainingS: Math.max(0, Math.ceil((plot.readyAt - now) / 1000)),
      ready: now >= plot.readyAt,
      yieldDefId: seed?.yieldDefId ?? null,
      yieldQty: seed ? sys.yieldQty(seed.yieldQty) : 0,
    });
  }
  return out;
  }

/** Harvest size after the 원예 `gatherYieldMul` (at least one unit). */
export function yieldQty(sys: HousingSystem, base: number): number {
  const mul = sys.ctx.progression?.derived?.gatherYieldMul ?? 1;
  return Math.max(1, Math.round(base * (Number.isFinite(mul) && mul > 0 ? mul : 1)));
  }

export function plantSeed(sys: HousingSystem, uid: string, slot: number, seedDefId: string): string | null {
  if (!sys.rackOf(uid)) return '재배층이 아닙니다';
  if (!Number.isInteger(slot) || slot < 0 || slot >= GROW_PLOTS_PER_RACK) return '없는 재배 칸입니다';
  if (sys.plotAt(uid, slot)) return '이미 씨앗이 심어져 있습니다';
  const def = sys.seedDef(seedDefId);
  if (!def || !def.seed) return '씨앗이 아닙니다';
  if (sys.countDef(seedDefId) < 1) return `${def.name}이(가) 없습니다`;
  const inv = sys.ctx.inventory;
  if (!inv || typeof inv.consumeDefAll !== 'function' || !inv.consumeDefAll(seedDefId, 1)) return '씨앗을 꺼낼 수 없습니다';
  const plantedAt = sys.nowMs();
  // the 원예 speed-up is baked in once: a later skill change never moves a running timer
  const speed = 1 - GROW_SKILL_SPEEDUP * (sys.gardening() / SKILL_LEVEL_MAX);
  const readyAt = plantedAt + Math.max(1000, Math.round(def.seed.growHours * 3600e3 * speed));
  sys.plots().push({ uid, slot, seedDefId, plantedAt, readyAt });
  sys.growChanged(uid, 'plant');
  return null;
  }

export function harvestPlot(sys: HousingSystem, uid: string, slot: number): string | null {
  if (!sys.rackOf(uid)) return '재배층이 아닙니다';
  const plot = sys.plotAt(uid, slot);
  if (!plot) return '심어진 씨앗이 없습니다';
  const now = sys.nowMs();
  if (now < plot.readyAt) return `아직 자라는 중입니다 (${formatRemaining(Math.ceil((plot.readyAt - now) / 1000))} 남음)`;
  const seed = sys.seedDef(plot.seedDefId)?.seed ?? null;
  const loot = sys.ctx.loot;
  if (!seed || !loot || typeof loot.createItem !== 'function') return '수확물을 만들 수 없습니다';
  const qty = sys.yieldQty(seed.yieldQty);
  const item = loot.createItem(seed.yieldDefId, qty);
  const inv = sys.ctx.inventory;
  const where = inv && typeof inv.tryAddItemAnywhere === 'function'
    ? inv.tryAddItemAnywhere(item)
    : inv && typeof inv.tryAddItem === 'function' && inv.tryAddItem(item) ? 'bag' : null;
  if (!where) return '가방과 창고에 자리가 없습니다';
  sys.plots().splice(sys.plots().indexOf(plot), 1);
  // the 원예 skill rises off `gather:collected`, exactly like a field herb node
  sys.ctx.bus.emit('gather:collected', { nodeId: `grow:${uid}:${slot}`, defId: seed.yieldDefId, qty });
  sys.growChanged(uid, 'harvest');
  return null;
  }

export function harvestAll(sys: HousingSystem, uid: string): number {
  let taken = 0;
  for (let slot = 0; slot < GROW_PLOTS_PER_RACK; slot++) {
    const plot = sys.plotAt(uid, slot);
    if (!plot || sys.nowMs() < plot.readyAt) continue;
    if (sys.harvestPlot(uid, slot) === null) taken++;
  }
  return taken;
  }

export function getOwnedSeeds(sys: HousingSystem): { defId: string; qty: number }[] {
  const loot = sys.ctx.loot;
  if (!loot || typeof loot.getAllItemDefs !== 'function') return [];
  const out: { defId: string; qty: number }[] = [];
  for (const def of loot.getAllItemDefs()) {
    if (!def.seed) continue;
    const qty = sys.countDef(def.id);
    if (qty > 0) out.push({ defId: def.id, qty });
  }
  out.sort((a, b) => (sys.seedDef(a.defId)?.seed?.growHours ?? 0) - (sys.seedDef(b.defId)?.seed?.growHours ?? 0));
  return out;
  }

export function openGrowMenu(sys: HousingSystem, uid: string): void {
  if (!sys.growMenu) return;
  if (!sys.rackOf(uid)) { sys.notify('재배층이 없습니다', 'warning'); return; }
  sys.exitHousingMode();
  sys.closeMenus(false);
  sys.growMenu.openRack(uid);
  }
