import type {
  ArmorDef, BackpackDef, DerivedStats, DurabilityInfo, ItemDef, ItemInstance, Rarity, WeightInfo, WeightState,
} from '@/shared';
import {
  STAT_BASE, WEIGHT_BASE_CAPACITY, WEIGHT_HEAVY_MOVE_MUL, WEIGHT_HEAVY_RATIO, WEIGHT_HEAVY_STAMINA_MUL,
  WEIGHT_LIGHT_RATIO, WEIGHT_LIGHT_STAMINA_MUL, WEIGHT_OVER_RATIO, WEIGHT_PER_STRENGTH,
} from '@/shared';
import { BASE_QUICK_SLOTS, itemWeight, rarityRank } from '@/items';

/* ── weight ───────────────────────────────────────────────────────────────── */

/** Carry capacity when `ctx.progression` is not published yet (a level-1 character). */
export const DEFAULT_CARRY_CAPACITY = WEIGHT_BASE_CAPACITY + WEIGHT_PER_STRENGTH * STAT_BASE;

export function weightStateFor(ratio: number): WeightState {
  if (ratio >= WEIGHT_OVER_RATIO) return 'over';
  if (ratio >= WEIGHT_HEAVY_RATIO) return 'heavy';
  if (ratio >= WEIGHT_LIGHT_RATIO) return 'light';
  return 'normal';
}

/**
 * Build the `WeightInfo` contract value. `carryRelief` (운반 skill, 0..1) cancels part of the
 * 조금 무거움 stamina penalty; 무거움 and 과적 are never softened.
 */
export function makeWeightInfo(weight: number, capacity: number, carryRelief: number): WeightInfo {
  const cap = Math.max(1, capacity);
  const ratio = weight / cap;
  const state = weightStateFor(ratio);
  let moveMul = 1;
  let staminaRegenMul = 1;
  if (state === 'light') {
    const relief = Math.max(0, Math.min(1, carryRelief));
    staminaRegenMul = WEIGHT_LIGHT_STAMINA_MUL + (1 - WEIGHT_LIGHT_STAMINA_MUL) * relief;
  } else if (state === 'heavy') {
    moveMul = WEIGHT_HEAVY_MOVE_MUL;
    staminaRegenMul = WEIGHT_HEAVY_STAMINA_MUL;
  } else if (state === 'over') {
    moveMul = 0;
    staminaRegenMul = 0;
  }
  return { weight, capacity: cap, ratio, state, moveMul, staminaRegenMul };
}

/** Sum of `weight × qty` over a list of instances. */
export function sumWeight(items: readonly ItemInstance[], getDef: (id: string) => ItemDef | undefined): number {
  let w = 0;
  for (const it of items) {
    const def = getDef(it.defId);
    if (def) w += itemWeight(def, it.qty);
  }
  return w;
}

/* ── gear lookups ─────────────────────────────────────────────────────────── */

export interface GearLookup {
  getDef(defId: string): ItemDef | undefined;
  getArmorDef(id: string): ArmorDef | undefined;
  getBackpackDef(id: string): BackpackDef | undefined;
}

export function armorOf(item: ItemInstance | null, look: GearLookup): ArmorDef | null {
  if (!item) return null;
  const def = look.getDef(item.defId);
  return def?.armorId ? look.getArmorDef(def.armorId) ?? null : null;
}

export function backpackOf(item: ItemInstance | null, look: GearLookup): BackpackDef | null {
  if (!item) return null;
  const def = look.getDef(item.defId);
  return def?.backpackId ? look.getBackpackDef(def.backpackId) ?? null : null;
}

/** Quick-use slot count granted by the equipped backpack. */
export function quickSlotCount(bp: BackpackDef | null): number {
  return bp ? Math.max(0, bp.quickSlots) : BASE_QUICK_SLOTS;
}

/* ── durability ───────────────────────────────────────────────────────────── */

/** `DurabilityInfo` for an instance, or null when the item does not wear out. */
export function durabilityInfo(item: ItemInstance, def: ItemDef): DurabilityInfo | null {
  const max = def.durabilityMax;
  if (max === undefined || max <= 0) return null;
  const cur = Math.max(0, Math.min(max, item.durability ?? max));
  return { uid: item.uid, durability: cur, max, broken: cur <= 0 };
}

/** 0..1 wear bar fraction, or null when the item has no durability. */
export function durabilityRatio(item: ItemInstance, def: ItemDef): number | null {
  const info = durabilityInfo(item, def);
  return info ? info.durability / info.max : null;
}

/* ── crate search (감정) ──────────────────────────────────────────────────── */

/** Seconds an item of each rarity stays hidden while the crate is being searched, before 감정. */
export const SEARCH_TIME_BY_RARITY: Readonly<Record<Rarity, number>> = {
  common: 0.35, uncommon: 0.7, rare: 1.3, epic: 2.0, legendary: 3.0,
};

/** Reveal delay for one item; `searchSpeedMul` comes from `derived.searchSpeedMul` (1 when unknown). */
export function searchTimeFor(def: ItemDef, searchSpeedMul: number): number {
  const mul = searchSpeedMul > 0 ? searchSpeedMul : 1;
  // A big find takes longer to dig out: +0.12 s per extra rarity step is already in the table,
  // and multi-cell items add a little on top so a rifle never pops instantly.
  const bulk = 1 + Math.max(0, def.width * def.height - 1) * 0.05;
  return (SEARCH_TIME_BY_RARITY[def.rarity] ?? 0.5) * bulk / mul;
}

export const rarityOrderOf = rarityRank;

/* ── derived-stat defaults (ctx.progression may not exist yet) ────────────── */

export interface GearMultipliers {
  carryCapacity: number;
  carryRelief: number;
  searchSpeedMul: number;
  craftSpeedMul: number;
  useSpeedMul: number;
  healPowerMul: number;
}

export function gearMultipliers(derived: DerivedStats | null | undefined): GearMultipliers {
  return {
    carryCapacity: derived?.carryCapacity ?? DEFAULT_CARRY_CAPACITY,
    carryRelief: derived?.carryReliefFactor ?? 0,
    searchSpeedMul: derived?.searchSpeedMul ?? 1,
    craftSpeedMul: derived?.craftSpeedMul ?? 1,
    useSpeedMul: derived?.useSpeedMul ?? 1,
    healPowerMul: derived?.healPowerMul ?? 1,
  };
}
