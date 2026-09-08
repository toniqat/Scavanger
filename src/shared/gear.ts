import type { LoadoutSlot, Rarity, WeaponClass } from './types';
import type { WorkbenchKind } from './housing';

/* ────────────────────────────────────────────────────────────────────────────
 * Gear contract: body armor, backpacks, weight, durability, quick-use slots.
 * Owner: items/ (definitions) + inventory/ (equip slots, weight, quick bar, crafting),
 * consumed by player/ (damage reduction, movement), weapons/ (durability), ui/ (HUD).
 * ──────────────────────────────────────────────────────────────────────────── */

/** Equipment slots. Alias of `LoadoutSlot` (primary / primary2 / secondary / bag / armor). */
export type EquipSlot = LoadoutSlot;

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

/* Backpacks: see `BagDef` in types.ts (weapon package). */

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

/* Quick-use slots: see `InventoryRef.getQuickSlots` (Phase 2 wheel). */

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
  /* appended (ship housing, 2026-09-06) */
  /**
   * 'ship' recipes that need a specific 작업실 bench (총기 / 장비 / 가젯 / 의학) at `benchLevel` or higher
   * (`ctx.housing.getBenchLevel(bench)`). undefined = any ship workbench (legacy `hub_workbench`) — field recipes ignore it.
   */
  bench?: WorkbenchKind;
  benchLevel?: number;
  /* appended (2026-09-08): 폐금속 공급 — 다중 산출물 */
  /**
   * Extra products beyond `outputDefId` / `outputQty`, produced in the same craft. Used by the 분해 recipes that
   * break one salvage item into several materials (기계 부품 → 폐금속 + 전력 케이블). The main output stays the
   * headline one (toasts / `craft:completed` report it); every entry here is added on top and needs bag space too.
   */
  extraOutputs?: CraftIngredient[];
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
