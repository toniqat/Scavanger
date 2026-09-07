import type { DerivedStats, PlayerProfile, SkillId, StatId, WeaponClass } from '@/shared';
import {
  DETECT_BASE_RADIUS, DETECT_ENEMY_BASE_RADIUS, DETECT_ENEMY_PER_PERCEPTION, DETECT_PER_PERCEPTION,
  PLAYER_MAX_STAMINA, SKILL_LEVEL_MAX, STAT_BASE, WEIGHT_BASE_CAPACITY, WEIGHT_PER_STRENGTH,
  XP_BASE, XP_EXPONENT,
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
const MELEE_PER_STR = 0.05;         // ×1.75 at 근력 20
const JUMP_PER_STR = 0.02;
const THROW_PER_STR = 0.03;
const STAMINA_PER_END = 5;          // flat max stamina
const STAMINA_REGEN_PER_END = 0.04;
const SKILL_GAIN_PER_INT = 0.06;    // ×1.9 at 지능 20
const USE_SPEED_PER_DEX = 0.035;
const INTERACT_SPEED_PER_DEX = 0.035;

/* full-skill (level 100) effect sizes */
const CARRY_RELIEF_AT_MAX = 1;      // fully cancels the 조금 무거움 stamina penalty
const SEARCH_SPEED_AT_MAX = 1;      // ×2 search speed
const GRIT_CHANCE_AT_MAX = 0.35;
const HEAL_POWER_AT_MAX = 0.6;
const SHIP_CALL_AT_MAX = 0.5;       // ×1.5 → countdown ends ~33 % sooner
const IMPLANT_CD_AT_MAX = 0.35;     // −35 % cooldown
const RECOIL_AT_MAX = 0.4;          // −40 % recoil
const RELOAD_AT_MAX = 0.45;         // ×1.45 reload speed
const DURABILITY_AT_MAX = 0.5;      // −50 % wear
const GATHER_YIELD_AT_MAX = 1;      // ×2 herbs
const CRAFT_SPEED_AT_MAX = 1;       // ×2 craft speed

/** 특수 가방 (legendary) perk: implant cooldowns halved, stacked multiplicatively on the skill. */
export const SPECIAL_BACKPACK_CD_MUL = 0.5;

/** Fraction of a skill's range that has been trained (0..1). */
function frac(profile: PlayerProfile, id: SkillId): number {
  const lv = profile.skills[id] ?? 0;
  return Math.min(1, Math.max(0, lv / SKILL_LEVEL_MAX));
}

function stat(profile: PlayerProfile, id: StatId): number {
  return profile.stats[id] ?? STAT_BASE;
}

/** Points spent above the starting value; drives every stat-derived multiplier. */
function over(profile: PlayerProfile, id: StatId): number {
  return stat(profile, id) - STAT_BASE;
}

/** XP required to go from `level` to `level + 1`. */
export function xpForLevel(level: number): number {
  return Math.max(1, Math.round(XP_BASE * Math.pow(Math.max(1, level), XP_EXPONENT)));
}

/**
 * Recompute every derived number.
 * @param specialBackpack true when the equipped backpack has the 특수 가방 perk (implant cooldown −50 %).
 */
export function computeDerived(profile: PlayerProfile, specialBackpack: boolean): DerivedStats {
  const str = stat(profile, 'strength');
  const perc = stat(profile, 'perception');

  const recoilMul = {} as Record<WeaponClass, number>;
  const reloadSpeedMul = {} as Record<WeaponClass, number>;
  for (const cls of Object.keys(WEAPON_CLASS_SKILL) as WeaponClass[]) {
    const f = frac(profile, WEAPON_CLASS_SKILL[cls]);
    recoilMul[cls] = 1 - RECOIL_AT_MAX * f;
    reloadSpeedMul[cls] = 1 + RELOAD_AT_MAX * f;
  }

  const implantMul = (1 - IMPLANT_CD_AT_MAX * frac(profile, 'implant')) * (specialBackpack ? SPECIAL_BACKPACK_CD_MUL : 1);

  return {
    /* 근력 */
    carryCapacity: WEIGHT_BASE_CAPACITY + WEIGHT_PER_STRENGTH * str,
    meleeDamageMul: 1 + MELEE_PER_STR * over(profile, 'strength'),
    jumpHeightMul: 1 + JUMP_PER_STR * over(profile, 'strength'),
    throwRangeMul: 1 + THROW_PER_STR * over(profile, 'strength'),
    /* 지구력 */
    maxStamina: PLAYER_MAX_STAMINA + STAMINA_PER_END * over(profile, 'endurance'),
    staminaRegenMul: 1 + STAMINA_REGEN_PER_END * over(profile, 'endurance'),
    /* 인지력 */
    detectRadius: DETECT_BASE_RADIUS + DETECT_PER_PERCEPTION * perc,
    enemyDetectRadius: DETECT_ENEMY_BASE_RADIUS + DETECT_ENEMY_PER_PERCEPTION * perc,
    /* 지능 */
    skillGainMul: 1 + SKILL_GAIN_PER_INT * over(profile, 'intelligence'),
    /* 재주 */
    useSpeedMul: 1 + USE_SPEED_PER_DEX * over(profile, 'dexterity'),
    interactSpeedMul: 1 + INTERACT_SPEED_PER_DEX * over(profile, 'dexterity'),
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
    craftSpeedMul: 1 + CRAFT_SPEED_AT_MAX * frac(profile, 'crafting'),
    /* 2026-09-08 stub (lead) — the progression agent derives these from the equipped legendary implants */
    perks: { auto_revive: false, quick_heal: false, kill_stamina: false },
  };
}

/** Neutral values for a level-1 character — used as the fallback before the system inits. */
export const DEFAULT_DERIVED: DerivedStats = computeDerived(
  {
    version: 1, name: '', level: 1, xp: 0, statPoints: 0,
    stats: { strength: STAT_BASE, endurance: STAT_BASE, perception: STAT_BASE, intelligence: STAT_BASE, dexterity: STAT_BASE },
    skills: {
      carry: 0, appraisal: 0, grit: 0, gardening: 0, crafting: 0, medicine: 0, cryptography: 0,
      implant: 0, gun_AR: 0, gun_SMG: 0, gun_SR: 0, gun_DMR: 0, gun_SG: 0, equipment: 0,
    },
    skillProgress: {
      carry: 0, appraisal: 0, grit: 0, gardening: 0, crafting: 0, medicine: 0, cryptography: 0,
      implant: 0, gun_AR: 0, gun_SMG: 0, gun_SR: 0, gun_DMR: 0, gun_SG: 0, equipment: 0,
    },
    implant: null, raids: 0, extractions: 0,
  },
  false,
);
