import type { ItemInstance, Rarity, WeaponClass } from './types';

/* ────────────────────────────────────────────────────────────────────────────
 * Gear contract: body armor, backpacks, weight, durability, quick-use slots.
 * Owner: items/ (definitions) + inventory/ (equip slots, weight, quick bar, crafting),
 * consumed by player/ (damage reduction, movement), weapons/ (durability), ui/ (HUD).
 * ──────────────────────────────────────────────────────────────────────────── */

/** Equipment slots on the character sheet. `primary`/`secondary` already existed as Loadout fields. */
export type EquipSlot = 'primary' | 'secondary' | 'armor' | 'backpack';

/* ── Armor ─────────────────────────────────────────────────────────────────── */
/** Unique armor behaviours. 'none' = plain numbered armor (I..V). */
export type ArmorPerk = 'none' | 'regen' | 'ultralight' | 'optical';

export interface ArmorDef {
  id: string;
  name: string;
  description: string;
  rarity: Rarity;
  /** 1..5 for numbered armor (방탄복 I..V), 0 for uniques. */
  tier: number;
  /** Incoming damage multiplier reduction, 0..0.9 (0.25 = takes 25 % less damage). */
  damageReduction: number;
  /** kg. Counts against the weight budget while equipped. */
  weight: number;
  durabilityMax: number;
  perk: ArmorPerk;
  /** Perk tuning: regen → hp per second; ultralight → bonus fraction; optical → unused. */
  perkValue?: number;
  /** CSS colour for the icon/plate tint. */
  color: string;
}

/* ── Backpacks ─────────────────────────────────────────────────────────────── */
/** Unique backpack behaviours. 'none' = plain numbered backpack (가방 I..V). */
export type BackpackPerk = 'none' | 'tactical' | 'special' | 'jump';

export interface BackpackDef {
  id: string;
  name: string;
  description: string;
  rarity: Rarity;
  /** 1..5 for numbered backpacks, 0 for uniques. */
  tier: number;
  /** Bag grid size granted by this backpack (replaces the base grid). */
  cols: number;
  rows: number;
  /** Quick-use slots (4 normally, 8 on the tactical backpack). */
  quickSlots: number;
  /** kg added to the carry capacity. */
  capacityBonus: number;
  /** Own weight (kg). */
  weight: number;
  durabilityMax: number;
  perk: BackpackPerk;
  color: string;
}

/* ── Weight ────────────────────────────────────────────────────────────────── */
/**
 * 'normal' <70 %, 'light' 조금 무거움 ≥70 %, 'heavy' 무거움 ≥90 % (roll disabled),
 * 'over' 과적 ≥100 % (cannot move, no stamina regen).
 */
export type WeightState = 'normal' | 'light' | 'heavy' | 'over';

export interface WeightInfo {
  /** Total kg carried (bag + equipped gear). */
  weight: number;
  /** kg the character can carry (base + strength + backpack). */
  capacity: number;
  /** weight / capacity. */
  ratio: number;
  state: WeightState;
  /** Movement speed multiplier implied by `state` (1 = unaffected, 0 = 과적). */
  moveMul: number;
  /** Stamina regen multiplier implied by `state` (the 운반 skill softens the 'light' penalty). */
  staminaRegenMul: number;
}

/* ── Quick-use bar ─────────────────────────────────────────────────────────── */
export interface QuickSlot {
  index: number;
  item: ItemInstance | null;
}

/* ── Field crafting ────────────────────────────────────────────────────────── */
export type CraftStation = 'field' | 'ship';

export interface CraftIngredient {
  defId: string;
  qty: number;
}

export interface CraftRecipe {
  id: string;
  name: string;
  /** Where it may be crafted. 'field' recipes also work on the ship. */
  station: CraftStation;
  inputs: CraftIngredient[];
  outputDefId: string;
  outputQty: number;
  /** Seconds of hold-to-craft interaction before 재주 / 제작 modifiers. */
  duration: number;
  /** Skill that gains XP and, above `skillRequired`, unlocks it. */
  skill: 'crafting' | 'medicine' | 'gardening';
  skillRequired: number;
  description: string;
}

/* ── Durability ────────────────────────────────────────────────────────────── */
export interface DurabilityInfo {
  uid: string;
  durability: number;
  max: number;
  /** true once durability hit 0 — weapons jam (fire rate halved), armor gives no DR. */
  broken: boolean;
}

/** Weapon durability loss per shot before the 장비 관리 skill multiplier. */
export interface WeaponWear {
  weaponClass: WeaponClass;
  perShot: number;
}
