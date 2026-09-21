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
  /**
   * **Not used in damage calculation since 2026-09-10.** Armor gives a shield (extra hp), not damage reduction
   * (`shield`). This value survives only as the **basis** from which a unique armor's shield was scaled — it was simply
   * not deleted, under the rule that the contract is add-only. 0..0.9.
   */
  damageReduction: number;
  /**
   * appended (2026-09-10): the **maximum shield** (extra hp). Numbered armor I..V takes `ARMOR_SHIELD_BY_TIER`
   * (20/40/60/80/100); a unique (tier 0) takes `damageReduction / ARMOR_DR_BY_TIER.5 × 100`, rounded.
   * The shield is chewed **before** hp, and it is refilled only with the '실드 충전기' consumable.
   */
  shield: number;
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
 * 'normal' <70 %, 'light' `조금 무거움` ≥70 %, 'heavy' `무거움` ≥90 % (roll disabled),
 * 'over' `과적` ≥100 % (cannot move, no stamina regen).
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
  /**
   * Skill that gains XP from this craft **and decides the material refund** (`shared/craftRefund.ts`) —
   * 2026-09-16 (user's decision): a skill no longer gates or speeds up crafting.
   */
  skill: 'crafting' | 'medicine' | 'gardening';
  /**
   * **Unused since 2026-09-16** — every `data/recipes.csv` row is `0` and no code reads it. The column, the loader
   * and this field stay so a future design can raise the gate again without a data migration.
   */
  skillRequired: number;
  description: string;
  /* appended (ship housing, 2026-09-06) */
  /**
   * 'ship' recipes that need a specific 작업실 bench (총기 / 장비 / 가젯 / 의학) at `benchLevel` or higher
   * (`ctx.housing.getBenchLevel(bench)`). undefined = any ship workbench (legacy `hub_workbench`) — field recipes ignore it.
   */
  bench?: WorkbenchKind;
  benchLevel?: number;
  /* appended (2026-09-08): the scrap-metal supply — multiple outputs */
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

/* ── appended (2026-09-13, library series — `src/housing/README.md` Decisions) ── */
export interface CraftRecipe {
  /**
   * The recipe book's series id — when it is present the recipe may be crafted **only while that book is on the library
   * shelf** (`HousingRef.isRecipeUnlocked`).
   * It is not a csv column: the items loader fills it from the `recipe:<this recipe's id>` effect in `data/library_series.csv` (the source is the one series table).
   */
  unlockSeries?: string;
}
