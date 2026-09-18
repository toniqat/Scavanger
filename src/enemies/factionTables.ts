/**
 * src/enemies/factionTables.ts — the **spawn numbers** of the humanoid factions, per planet (2026-09-13).
 *
 * One place that carries across the csv read by site occupation (`SiteGroups.ts`) · raider drops (`RogueDrop.ts`) · the named
 * roll (`named/Director.ts`). This file imports nothing heavy such as three.js or fx — `npm run data:check` reads this module
 * directly through its loader list (`scripts/data-owners.mjs`) to mark the `constants.csv` keys as "read".
 *
 * In the tables (`data/tables.csv`) `SITE_*` · `*_BY_THREAT` use index 0 = planet threat 1 … 2 = threat 3,
 * and `RAIDER_DROP_WAVE*` index 0 = a squad of 1 … 3 = 4.
 *
 * 2026-09-14: the **bug difficulty** tables (`BUG_HP_MUL_BY_THREAT` · `BIG_BUG_WEIGHT_MUL_BY_THREAT` · `MID_BUG_WEIGHT_MUL_BY_THREAT` ·
 * `PATROL_BEHEMOTH_BY_THREAT` · `ARTILLERY_CAP_BONUS_BY_THREAT` · `BEHEMOTH_CAP_BONUS_BY_THREAT`) are carried here too — the same threat index, and
 * this file is already on the data:check loader list. `bugThreatTuning(threat)` bundles one row of them.
 */
import { keyTable, numberList } from '@/shared';

const K = /* data/constants.csv */ keyTable('constants.csv');

/* ── site occupation (SiteGroups) ── */
export const SITE_OCCUPY_CHANCE_STRUCTURE: readonly number[] = numberList('tables.csv', 'SITE_OCCUPY_CHANCE_STRUCTURE');
export const SITE_OCCUPY_CHANCE_PLATFORM: readonly number[] = numberList('tables.csv', 'SITE_OCCUPY_CHANCE_PLATFORM');
export const SITE_OCCUPY_CHANCE_RUIN: readonly number[] = numberList('tables.csv', 'SITE_OCCUPY_CHANCE_RUIN');
export const SITE_RAIDER_SHARE_STRUCTURE: readonly number[] = numberList('tables.csv', 'SITE_RAIDER_SHARE_STRUCTURE');
export const SITE_RAIDER_SHARE_OUTLYING: readonly number[] = numberList('tables.csv', 'SITE_RAIDER_SHARE_OUTLYING');
export const SITE_INDOOR_GROUPS: readonly number[] = numberList('tables.csv', 'SITE_INDOOR_GROUPS');
export const SITE_OUTDOOR_GROUPS_MIN: readonly number[] = numberList('tables.csv', 'SITE_OUTDOOR_GROUPS_MIN');
export const SITE_OUTDOOR_GROUPS_MAX: readonly number[] = numberList('tables.csv', 'SITE_OUTDOOR_GROUPS_MAX');
export const SITE_GROUP_SIZE_MIN: readonly number[] = numberList('tables.csv', 'SITE_GROUP_SIZE_MIN');
export const SITE_GROUP_SIZE_MAX: readonly number[] = numberList('tables.csv', 'SITE_GROUP_SIZE_MAX');
/** A 2026-09-13 follow-up decision: the size of rail platform and ruin outpost groups (labs and outposts use `SITE_GROUP_SIZE_*`). */
export const SITE_OUTLYING_GROUP_SIZE_MIN: readonly number[] = numberList('tables.csv', 'SITE_OUTLYING_GROUP_SIZE_MIN');
export const SITE_OUTLYING_GROUP_SIZE_MAX: readonly number[] = numberList('tables.csv', 'SITE_OUTLYING_GROUP_SIZE_MAX');
export const SITE_BOSS_CHANCE: readonly number[] = numberList('tables.csv', 'SITE_BOSS_CHANCE');
/** The most rogue site squad leaders one raid may hold. */
export const SITE_BOSS_MAX_PER_RAID = K.num('SITE_BOSS_MAX_PER_RAID');
/** The minimum gap (m) between humanoids inside one group. */
export const SITE_GROUP_MIN_GAP_M = K.num('SITE_GROUP_MIN_GAP_M');
/** The indoor / outdoor group leash = the site radius + this value (m). */
export const SITE_GROUP_LEASH_INDOOR_M = K.num('SITE_GROUP_LEASH_INDOOR_M');
export const SITE_GROUP_LEASH_OUTDOOR_M = K.num('SITE_GROUP_LEASH_OUTDOOR_M');

/* ── raider drops (RogueDrop) ── */
export const RAIDER_DROP_CHANCE_BY_THREAT: readonly number[] = numberList('tables.csv', 'RAIDER_DROP_CHANCE_BY_THREAT');
export const RAIDER_DROP_WAVE1_MIN: readonly number[] = numberList('tables.csv', 'RAIDER_DROP_WAVE1_MIN');
export const RAIDER_DROP_WAVE1_MAX: readonly number[] = numberList('tables.csv', 'RAIDER_DROP_WAVE1_MAX');
export const RAIDER_DROP_WAVE2_MIN: readonly number[] = numberList('tables.csv', 'RAIDER_DROP_WAVE2_MIN');
export const RAIDER_DROP_WAVE2_MAX: readonly number[] = numberList('tables.csv', 'RAIDER_DROP_WAVE2_MAX');
/** How many seconds after the first announcement the second wave is announced on its own. */
export const RAIDER_DROP_WAVE_GAP_S = K.num('RAIDER_DROP_WAVE_GAP_S');
/** The most bodies in one wave. */
export const RAIDER_DROP_WAVE_MAX = K.num('RAIDER_DROP_WAVE_MAX');

/* ── named rogues (named/Director) ── */
export const NAMED_ROGUE_CHANCE_BY_THREAT: readonly number[] = numberList('tables.csv', 'NAMED_ROGUE_CHANCE_BY_THREAT');

/** One cell of a threat table (an index out of range clamps to the end cell · a non-finite value is 0). */
export function byThreat(table: readonly number[], threat: number): number {
  if (table.length === 0) return 0;
  const v = table[Math.max(0, Math.min(table.length - 1, Math.round(threat) - 1))];
  return Number.isFinite(v) ? v : 0;
}

/* ── 2026-09-14: bug difficulty (planet threat) — the hp multiplier in `Pool.acquire` · the composition multipliers in `Spawner.threatEcosystem` ── */
export const BUG_HP_MUL_BY_THREAT: readonly number[] = numberList('tables.csv', 'BUG_HP_MUL_BY_THREAT');
export const BIG_BUG_WEIGHT_MUL_BY_THREAT: readonly number[] = numberList('tables.csv', 'BIG_BUG_WEIGHT_MUL_BY_THREAT');
export const MID_BUG_WEIGHT_MUL_BY_THREAT: readonly number[] = numberList('tables.csv', 'MID_BUG_WEIGHT_MUL_BY_THREAT');
export const PATROL_BEHEMOTH_BY_THREAT: readonly number[] = numberList('tables.csv', 'PATROL_BEHEMOTH_BY_THREAT');
export const ARTILLERY_CAP_BONUS_BY_THREAT: readonly number[] = numberList('tables.csv', 'ARTILLERY_CAP_BONUS_BY_THREAT');
export const BEHEMOTH_CAP_BONUS_BY_THREAT: readonly number[] = numberList('tables.csv', 'BEHEMOTH_CAP_BONUS_BY_THREAT');

/** One raid's bug difficulty (one planet-threat row, read once — `EnemySystem` builds it at `world:ready`). */
export interface BugThreatTuning {
  /** Planet threat 1..3 (no planet · the training range = 1). */
  readonly threat: 1 | 2 | 3;
  /** The max hp multiplier of the bug faction (the sandworm excepted). */
  readonly hpMul: number;
  /** The multiplier on the charger · behemoth · artillery weights, on a patrol's big slot chance and on the artillery dig-in chance. */
  readonly bigMul: number;
  /** The multiplier on the warrior · spewer weights. */
  readonly midMul: number;
  /** A patrol's big slot may draw a behemoth. */
  readonly patrolBehemoth: boolean;
  readonly artilleryCapBonus: number;
  readonly behemothCapBonus: number;
}

/** One table row → the difficulty (multipliers ≥ 0, cap bonuses integers ≥ 0). With the threat-1 row all 1 / 0 it is bit-identical to before. */
export function bugThreatTuning(threat: number): BugThreatTuning {
  const t = (Math.max(1, Math.min(3, Math.round(Number.isFinite(threat) ? threat : 1)))) as 1 | 2 | 3;
  const mul = (table: readonly number[]): number => Math.max(0, table.length ? byThreat(table, t) : 1);
  const bonus = (table: readonly number[]): number => Math.max(0, Math.round(byThreat(table, t)));
  return {
    threat: t,
    hpMul: mul(BUG_HP_MUL_BY_THREAT),
    bigMul: mul(BIG_BUG_WEIGHT_MUL_BY_THREAT),
    midMul: mul(MID_BUG_WEIGHT_MUL_BY_THREAT),
    patrolBehemoth: byThreat(PATROL_BEHEMOTH_BY_THREAT, t) > 0,
    artilleryCapBonus: bonus(ARTILLERY_CAP_BONUS_BY_THREAT),
    behemothCapBonus: bonus(BEHEMOTH_CAP_BONUS_BY_THREAT),
  };
}

/* ── 2026-09-18: bug nests (user's decision 「둥지 반경 60 m 리시 · 초기 수 절반 · 재스폰 50/35/15 %」) ──
 * Read by: `ai/NestLeash.ts` (the leash) · `NestDirector.ts` (the initial garrison multiplier · the refill roll · the trigger) · `Spawner.initialPopulate`.
 * A single-value table uses key 0 only, the same trick as `NEST_COUNT_MIN`. */
const one = (table: string, fallback: number): number => {
  const v = numberList('tables.csv', table)[0];
  return Number.isFinite(v) ? v : fallback;
};
/** The farthest (m) a bug born at a nest may chase a target. A bug born anywhere else is untouched by it. */
export const NEST_LEASH_M = one('NEST_LEASH_M', 60);
/** The distance at which walking home ends = `NEST_LEASH_M` × this value (hysteresis against chatter at the boundary). */
export const NEST_LEASH_RETURN_FRAC = one('NEST_LEASH_RETURN_FRAC', 0.5);
/** The multiplier on the **number of patrol groups** laid down when the raid starts (`Spawner.initialPopulate`). 0.5 = half. */
export const NEST_INITIAL_GARRISON_MUL = one('NEST_INITIAL_GARRISON_MUL', 0.5);
/** A refill fires when that nest's living **mobile** bugs fall to the starting count × this value or below (eggs do not count). */
export const NEST_REFILL_TRIGGER_FRAC = one('NEST_REFILL_TRIGGER_FRAC', 1 / 3);
/** How often (s) the host recounts each nest's survivors. */
export const NEST_REFILL_CHECK_S = one('NEST_REFILL_CHECK_S', 2);
/** The chance of each refill **count** — index k = k+1 refills (user's decision: 1 → 50 % · 2 → 35 % · 3 → 15 %). */
export const NEST_REFILL_COUNT_CHANCE: readonly number[] = numberList('tables.csv', 'NEST_REFILL_COUNT_CHANCE');
