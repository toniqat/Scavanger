import type { DerivedStats, GymStat, MealBuff, MealDef, MealEffect, PerkId, PlayerProfile, SkillId, StatId, WeaponClass } from '@/shared';
import {
  MEAL_BUFFS,
  GYM_STATS, GYM_TRAINED_MAX,
  DETECT_BASE_RADIUS, DETECT_ENEMY_BASE_RADIUS, DETECT_ENEMY_PER_PERCEPTION, DETECT_PER_PERCEPTION,
  PERK_IDS, PLAYER_MAX_STAMINA, SKILL_LEVEL_MAX, STAT_BASE, STAT_MAX, STAT_MIN, WEIGHT_BASE_CAPACITY, WEIGHT_PER_STRENGTH,
  XP_BASE, XP_EXPONENT,
  GRAVITY, GRENADE_THROW_LIFT, GRENADE_THROW_SPEED, PLAYER_HEIGHT, THROW_RANGE_MUL_MAX, THROW_RANGE_MUL_MIN,
  mealQualityBonus,
  /* 2026-09-13 cooking / research skills */
  COOK_SKILL_SCORE_AT_MAX, RESEARCH_REFUND_CHANCE_AT_MAX, RESEARCH_REFUND_FRAC_MAX, RESEARCH_REFUND_FRAC_MIN, RESEARCH_TIME_AT_MAX,
} from '@/shared';
import { WEAPON_CLASS_SKILL } from './defs';

/* ────────────────────────────────────────────────────────────────────────────
 * The single place every gameplay number derived from stats / skills is computed.
 * Other folders read `ctx.progression.derived` — they never re-implement a formula.
 *
 * Convention: a stat's effect is measured from STAT_BASE (5), so a fresh character
 * sits at the neutral value (multiplier 1 / the raw constant) and every point spent
 * is a visible gain. Skills scale linearly over 0..SKILL_LEVEL_MAX.
 * ──────────────────────────────────────────────────────────────────────────── */

/* per stat point above STAT_BASE */
const MELEE_PER_STR = 0.05;         // ×1.75 at strength 20
const JUMP_PER_STR = 0.02;
/**
 * Throw range (2026-09-09): no longer "per point over STAT_BASE" — linear from THROW_RANGE_MUL_MIN at STAT_MIN
 * strength (1 → 1.0, the value a strength-5 character used to have) to THROW_RANGE_MUL_MAX at STAT_MAX
 * (20 → 1.74 = old max 1.45 × 1.2).
 */
function throwRangeMulOf(strength: number): number {
  const span = Math.max(1, STAT_MAX - STAT_MIN);
  const t = Math.min(1, Math.max(0, (strength - STAT_MIN) / span));
  return THROW_RANGE_MUL_MIN + (THROW_RANGE_MUL_MAX - THROW_RANGE_MUL_MIN) * t;
}

/** Overhand throw range on flat ground (m): release at ~eye height, speed × √mul (range ∝ speed²), lift, GRAVITY. */
export function throwRangeMetres(throwRangeMul: number): number {
  const vx = GRENADE_THROW_SPEED * Math.sqrt(Math.max(0.25, throwRangeMul));
  const vy = GRENADE_THROW_LIFT;
  const h = PLAYER_HEIGHT * 0.86;    // release point ≈ eye height (player/model EYE_STAND 1.55 of 1.8)
  const t = (vy + Math.sqrt(vy * vy + 2 * GRAVITY * h)) / GRAVITY;
  return vx * t;
}
const STAMINA_PER_END = 5;          // flat max stamina
const STAMINA_REGEN_PER_END = 0.04;
/** Skill-gain multiplier per point of intelligence (exported 2026-09-13 — the character sheet tooltip reads it straight as `모든 숙련 성장 +N%/pt`). */
export const SKILL_GAIN_PER_INT = 0.06;    // ×1.9 at intelligence 20
/**
 * How strongly a skill's own stats speed up its training (per point above STAT_BASE, base stats only). Moved here from
 * `ProgressionSystem` on 2026-09-13 so the sheet tooltip (`관련 숙련 · 성장 +N%/pt`) reads the same number `statFactor` uses.
 */
export const SKILL_STAT_FACTOR = 0.04;
const USE_SPEED_PER_DEX = 0.035;
const INTERACT_SPEED_PER_DEX = 0.035;

/* full-skill (level 100) effect sizes */
const CARRY_RELIEF_AT_MAX = 1;      // fully cancels the 「조금 무거움」 (slightly heavy) stamina penalty
const SEARCH_SPEED_AT_MAX = 1;      // ×2 search speed
const GRIT_CHANCE_AT_MAX = 0.35;
const HEAL_POWER_AT_MAX = 0.6;
const SHIP_CALL_AT_MAX = 0.5;       // ×1.5 → countdown ends ~33 % sooner
const IMPLANT_CD_AT_MAX = 0.35;     // −35 % cooldown
const RECOIL_AT_MAX = 0.4;          // −40 % recoil
const RELOAD_AT_MAX = 0.45;         // ×1.45 reload speed
const DURABILITY_AT_MAX = 0.5;      // −50 % wear
const GATHER_YIELD_AT_MAX = 1;      // ×2 herbs
/** Bonus added to the higher-rarity weights of an ore-vein roll at mining 100 (2026-09-16 user's decision — planet ore veins). */
const MINING_RARITY_AT_MAX = 1;

/** `특수 가방` (special backpack, legendary) perk: implant cooldowns halved, stacked multiplicatively on the skill. */
export const SPECIAL_BACKPACK_CD_MUL = 0.5;

/**
 * Phase 12 (2026-09-08): what the equipped implant items contribute — flat stat bonuses (added to the base stats before
 * any formula runs) and the legendary perks. `ProgressionSystem` sums these from `profile.implants` × `ItemDef.implant`;
 * derive.ts never looks the items up itself.
 */
export interface ImplantContribution {
  bonus: Partial<Record<StatId, number>>;
  perks: Record<PerkId, boolean>;
}

/** Every perk off — the neutral `DerivedStats.perks`. */
export function emptyPerks(): Record<PerkId, boolean> {
  const out = {} as Record<PerkId, boolean>;
  for (const id of PERK_IDS) out[id] = false;
  return out;
}

const NO_IMPLANTS: ImplantContribution = { bonus: {}, perks: emptyPerks() };

/** Fraction of a skill's range that has been trained (0..1). */
function frac(profile: PlayerProfile, id: SkillId): number {
  const lv = profile.skills[id] ?? 0;
  return Math.min(1, Math.max(0, lv / SKILL_LEVEL_MAX));
}

/**
 * A-3a (2026-09-12): the gym training bonus of `id` — an integer 0 … `GYM_TRAINED_MAX`, 0 for a stat that is not a `GYM_STATS`
 * entry or a missing / junk value. The one reader of `profile.trained` (derive + `ProgressionSystem.getTrainedBonus`).
 */
export function trainedBonusOf(profile: PlayerProfile, id: StatId): number {
  if (!(GYM_STATS as readonly string[]).includes(id)) return 0;
  const v = profile.trained?.[id as GymStat];
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(GYM_TRAINED_MAX, Math.round(v)));
}

/**
 * Effective stat: base + equipped implant bonus + gym training bonus (the base alone is `ProgressionRef.getStat`).
 * Neither bonus is clamped to `STAT_MAX` (contract: 「the same intent as implants」).
 */
function stat(profile: PlayerProfile, id: StatId, imp: ImplantContribution): number {
  const bonus = imp.bonus[id];
  return (profile.stats[id] ?? STAT_BASE) + (typeof bonus === 'number' && Number.isFinite(bonus) ? bonus : 0)
    + trainedBonusOf(profile, id);
}

/** Points above the starting value (implant and gym training bonuses included); drives every stat-derived multiplier. */
function over(profile: PlayerProfile, id: StatId, imp: ImplantContribution): number {
  return stat(profile, id, imp) - STAT_BASE;
}

/** XP required to go from `level` to `level + 1`. */
export function xpForLevel(level: number): number {
  return Math.max(1, Math.round(XP_BASE * Math.pow(Math.max(1, level), XP_EXPONENT)));
}

/**
 * Recompute every derived number.
 * @param specialBackpack true when the equipped backpack has the `특수 가방` perk (implant cooldown −50 %).
 * @param implants Phase 12: stat bonuses + perks of the equipped implant items (omit = none).
 */
export function computeDerived(profile: PlayerProfile, specialBackpack: boolean, implants: ImplantContribution = NO_IMPLANTS): DerivedStats {
  const imp = implants;
  const str = stat(profile, 'strength', imp);
  const perc = stat(profile, 'perception', imp);

  const recoilMul = {} as Record<WeaponClass, number>;
  const reloadSpeedMul = {} as Record<WeaponClass, number>;
  for (const cls of Object.keys(WEAPON_CLASS_SKILL) as WeaponClass[]) {
    const f = frac(profile, WEAPON_CLASS_SKILL[cls]);
    recoilMul[cls] = 1 - RECOIL_AT_MAX * f;
    reloadSpeedMul[cls] = 1 + RELOAD_AT_MAX * f;
  }

  const implantMul = (1 - IMPLANT_CD_AT_MAX * frac(profile, 'implant')) * (specialBackpack ? SPECIAL_BACKPACK_CD_MUL : 1);

  return {
    /* strength */
    carryCapacity: WEIGHT_BASE_CAPACITY + WEIGHT_PER_STRENGTH * str,
    meleeDamageMul: 1 + MELEE_PER_STR * over(profile, 'strength', imp),
    jumpHeightMul: 1 + JUMP_PER_STR * over(profile, 'strength', imp),
    throwRangeMul: throwRangeMulOf(str),
    throwRangeM: throwRangeMetres(throwRangeMulOf(str)),
    /* endurance */
    maxStamina: PLAYER_MAX_STAMINA + STAMINA_PER_END * over(profile, 'endurance', imp),
    staminaRegenMul: 1 + STAMINA_REGEN_PER_END * over(profile, 'endurance', imp),
    /* perception */
    detectRadius: DETECT_BASE_RADIUS + DETECT_PER_PERCEPTION * perc,
    enemyDetectRadius: DETECT_ENEMY_BASE_RADIUS + DETECT_ENEMY_PER_PERCEPTION * perc,
    /* intelligence */
    skillGainMul: 1 + SKILL_GAIN_PER_INT * over(profile, 'intelligence', imp),
    /* dexterity */
    useSpeedMul: 1 + USE_SPEED_PER_DEX * over(profile, 'dexterity', imp),
    interactSpeedMul: 1 + INTERACT_SPEED_PER_DEX * over(profile, 'dexterity', imp),
    /* skills */
    carryReliefFactor: CARRY_RELIEF_AT_MAX * frac(profile, 'carry'),
    searchSpeedMul: 1 + SEARCH_SPEED_AT_MAX * frac(profile, 'appraisal'),
    gritChance: GRIT_CHANCE_AT_MAX * frac(profile, 'grit'),
    healPowerMul: 1 + HEAL_POWER_AT_MAX * frac(profile, 'medicine'),
    shipCallSpeedMul: 1 + SHIP_CALL_AT_MAX * frac(profile, 'cryptography'),
    implantCooldownMul: implantMul,
    recoilMul,
    reloadSpeedMul,
    durabilityLossMul: 1 - DURABILITY_AT_MAX * frac(profile, 'equipment'),
    gatherYieldMul: 1 + GATHER_YIELD_AT_MAX * frac(profile, 'gardening'),
    /**
     * **2026-09-16 (user's decision) — the crafting skill does not change crafting speed.** 「All the skill is
     * involved in is the chance of getting some material items back when crafting, and how much comes back」. So this
     * value is **pinned at 1**. The field itself is not deleted because the contract
     * (`shared/progression.DerivedStats`) is add-only — `inventory/Gear.gearMultipliers` and
     * `Crafting.craftDuration` may keep reading it and do nothing, since the factor is 1. The character sheet's
     * `제작 속도` row would always read ×1.0, so it was taken out of `DERIVED_PANEL_KEYS`. What the skill actually
     * does is `shared/craftRefund.ts`.
     * (A meal or library buff *can* raise this field — `MealBuff` is a `DerivedStats` field name. No such row exists
     * in `data/meals.csv` or `library_series.csv` today.)
     */
    craftSpeedMul: 1,
    /* 2026-09-13: cooking / research skills */
    cookScoreBonus: COOK_SKILL_SCORE_AT_MAX * frac(profile, 'cooking'),
    researchTimeMul: 1 - RESEARCH_TIME_AT_MAX * frac(profile, 'research'),
    researchRefundChance: RESEARCH_REFUND_CHANCE_AT_MAX * frac(profile, 'research'),
    researchRefundFrac: RESEARCH_REFUND_FRAC_MIN + (RESEARCH_REFUND_FRAC_MAX - RESEARCH_REFUND_FRAC_MIN) * frac(profile, 'research'),
    /* 2026-09-16: mining — raises only the rarity of the unidentified ore a vein rolls (read by world/'s vein gathering). */
    miningRarityBonus: MINING_RARITY_AT_MAX * frac(profile, 'mining'),
    /* Phase 12: legendary perks of the equipped implant items (every PerkId present) */
    perks: { ...emptyPerks(), ...imp.perks },
  };
}

/* ══ Meal buffs (A-3c, 2026-09-11) ══════════════════════════════════════════════════════════════════════
 * `MealDef.buff` is **literally a `DerivedStats` field name** (contract `shared/types.MealBuff`). So cooking is not a
 * new concept but a value added once to derived stats that were already computed, and player · weapons · world ·
 * inventory change by not one line — they are reading `derived` already.
 *
 * Whether the field is a multiplier (`*Mul` · `gritChance`) or a raw unit (`carryCapacity` · `maxStamina` ·
 * `detectRadius`), the operation is a single **addition** (`isMealBuffMultiplier` is for **display** only — whether to
 * print 「+15 %」 or 「+6 kg」; that table is `shared/labels.MEAL_BUFF_UNIT`). Only `durabilityLossMul` has a negative
 * `amount`, which is why **0 is the floor**: no multiplier may ever go negative (a −20 % wear would refill durability).
 * ══════════════════════════════════════════════════════════════════════════════════════════════════════ */
/**
 * Edits `d` in place — `ProgressionSystem.recompute` lays it over the result of `computeDerived` (a fresh object each
 * time).
 *
 * 2026-09-13 (cook ingredient tiers, user's decision 「one buff, with more stat rows hanging off it」): folds in **all
 * of `meal.effects`**. An old def with no or empty `effects` (a build whose loader does not know the new column yet)
 * is read as `[{buff, amount}]` — same result as before. The per-row rule is unchanged: one addition + **0 as the
 * floor** (the same buff on two rows is added twice in turn).
 *
 * 2026-09-13 (cook quality): `quality` (0 … 5 stars) scales each row by
 * `amount × (1 + mealQualityBonus(quality))` **before** the rule above (addition + 0 floor) is applied — a negative row
 * (`durabilityLossMul`) is cut further and the floor is unchanged. Omitted = 0 = 100 % of the original number.
 *
 * ⚠ Never make a credit or sell-price multiplier a buff — the relay re-checks credits against a per-reason table
 * (`shared/credits.ts`), so a multiplier applied by the client becomes a `credits:tx` rejection. Reward-side buffs are
 * expressed in numbers the client is authoritative over.
 */
export function applyMealBuff(d: DerivedStats, meal: MealDef, quality = 0): void {
  const mul = 1 + mealQualityBonus(quality);
  for (const e of mealEffectsOf(meal)) {
    const amount = (typeof e?.amount === 'number' && Number.isFinite(e.amount) ? e.amount : 0) * mul;
    if (amount === 0) continue;
    const buff = e.buff;
    const cur = d[buff];
    if (typeof cur !== 'number') continue;             // a name outside the contract leaked in from csv
    d[buff] = Math.max(0, cur + amount);
  }
}

/* ══ Library derived effects (2026-09-13) ═════════════
 * A library series' `derived` effect rows are not new fields but **the same `MealBuff` keys as meal buffs** — housing
 * sums them into `LibraryEffectsSummary.derived`, and `ProgressionSystem.deriveFor` folds that in through this
 * function **after** the meal buff. The rule is exactly one `applyMealBuff` row: one addition + **0 as the floor**.
 * The loop runs over `MEAL_BUFFS` only, so any other name that leaked in from the docs (`perks` · `recoilMul` …) or a
 * non-numeric value is dropped silently. It applies immediately, so the csv numbers are very small.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════════════════ */
export function applyLibraryDerived(d: DerivedStats, lib: Readonly<Partial<Record<MealBuff, number>>> | null | undefined): void {
  if (!lib || typeof lib !== 'object') return;
  for (const buff of MEAL_BUFFS) {
    const v = lib[buff];
    if (typeof v !== 'number' || !Number.isFinite(v) || v === 0) continue;
    const cur = d[buff];
    if (typeof cur !== 'number') continue;
    d[buff] = Math.max(0, cur + v);
  }
}

/** All stat rows of a meal — `effects` when present, otherwise the single old `buff` · `amount` row (empty list when neither). */
export function mealEffectsOf(meal: MealDef | null | undefined): readonly MealEffect[] {
  if (!meal) return [];
  const list = (meal as Partial<MealDef>).effects;
  if (Array.isArray(list) && list.length > 0) return list;
  return meal.buff ? [{ buff: meal.buff, amount: meal.amount }] : [];
}

/** Neutral values for a level-1 character — used as the fallback before the system inits. */
export const DEFAULT_DERIVED: DerivedStats = computeDerived(
  {
    version: 1, name: '', level: 1, xp: 0, statPoints: 0,
    stats: { strength: STAT_BASE, endurance: STAT_BASE, perception: STAT_BASE, intelligence: STAT_BASE, dexterity: STAT_BASE },
    skills: {
      carry: 0, appraisal: 0, grit: 0, gardening: 0, crafting: 0, medicine: 0, cryptography: 0,
      implant: 0, gun_AR: 0, gun_SMG: 0, gun_SR: 0, gun_DMR: 0, gun_SG: 0, equipment: 0, cooking: 0, research: 0, mining: 0,
    },
    skillProgress: {
      carry: 0, appraisal: 0, grit: 0, gardening: 0, crafting: 0, medicine: 0, cryptography: 0,
      implant: 0, gun_AR: 0, gun_SMG: 0, gun_SR: 0, gun_DMR: 0, gun_SG: 0, equipment: 0, cooking: 0, research: 0, mining: 0,
    },
    implant: null, raids: 0, extractions: 0, implants: [],
  },
  false,
);
