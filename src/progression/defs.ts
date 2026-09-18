import type { DerivedStats, SkillDef, SkillId, StatDef, StatId, WeaponClass } from '@/shared';
import { SKILL_IDS, STAT_IDS, csvRows, keyTable, numberMap, stringMap } from '@/shared';

/* Source of the numbers: `data/stats.csv` · `data/skills.csv`; XP per action is `data/tuning.csv`; the weapon →
 * skill mapping and appraisal XP per rarity are `data/tables.csv`. */
const T = /* data/tuning.csv */ keyTable('tuning.csv');

/* ────────────────────────────────────────────────────────────────────────────
 * Static definitions for the 5 stats and 17 skills (Korean names + descriptions)
 * and the raw skill-XP amounts every trained action is worth.
 * Owner: progression/. Nothing else defines these.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Row keys of the character sheet's 「파생 능력치」 (derived stats) panel (2026-09-13) — in display order. The `derived`
 * column of `stats.csv` / `skills.csv` may only pick from these (the loader checks it, so `npm run data:check` catches
 * a typo). The names are `DerivedStats` field names, and the `throwRangeMul` row shows `throwRangeM` rather than the
 * multiplier (`ui/SheetBody.derivedText`).
 * The shooting skills' per-weapon-class recoil / reload have no row in the panel (user's decision — the tooltip shows
 * the numbers on their own).
 */
export const DERIVED_PANEL_KEYS = [
  'carryCapacity', 'maxStamina', 'detectRadius', 'enemyDetectRadius', 'meleeDamageMul', 'throwRangeMul',
  'skillGainMul', 'useSpeedMul', 'interactSpeedMul', 'gritChance', 'searchSpeedMul', 'healPowerMul',
  /* 2026-09-16 (user's decision): `craftSpeedMul` is left out — the crafting skill does not change speed, so it is a dead row that always reads ×1.0 (`derive.ts`). */
  'shipCallSpeedMul', 'implantCooldownMul', 'durabilityLossMul', 'gatherYieldMul', 'carryReliefFactor',
  /* 2026-09-13 cooking / research skills (docs/DECISIONS.md 「2026-09-13 — 서재 시리즈 · 비디오게임」) */
  'cookScoreBonus', 'researchTimeMul', 'researchRefundChance', 'researchRefundFrac',
  /* 2026-09-16 (user's decision): planet ore veins / the mining skill */
  'miningRarityBonus',
] as const satisfies readonly (keyof DerivedStats)[];
export type DerivedPanelKey = (typeof DERIVED_PANEL_KEYS)[number];

const statDerived = new Map<StatId, readonly DerivedPanelKey[]>();
const skillDerived = new Map<SkillId, readonly DerivedPanelKey[]>();

export const STAT_DEFS: readonly StatDef[] = csvRows('stats.csv').map((r) => {
  const id = r.str('id') as StatId;
  const derived = r.enumList('derived', DERIVED_PANEL_KEYS);
  // every stat changes something in the panel — an empty cell is an omission (skills are not checked: the shooting ones are legitimately empty)
  if (!r.raw('derived')) r.report('derived', '값이 비었다 — 이 능력치가 바꾸는 파생 능력치 줄 키를 적는다');
  statDerived.set(id, derived);
  return { id, name: r.str('name'), description: r.str('description') };
});

export const SKILL_DEFS: readonly SkillDef[] = csvRows('skills.csv').map((r) => {
  const id = r.str('id') as SkillId;
  skillDerived.set(id, r.enumList('derived', DERIVED_PANEL_KEYS));
  return {
    id,
    name: r.str('name'),
    description: r.str('description'),
    stats: r.list('stats') as StatId[],
    ...(r.has('weaponClass') ? { weaponClass: r.str('weaponClass') as WeaponClass } : {}),
  };
});

export const STAT_DEF_MAP: ReadonlyMap<StatId, StatDef> = new Map(STAT_DEFS.map((d) => [d.id, d]));
export const SKILL_DEF_MAP: ReadonlyMap<SkillId, SkillDef> = new Map(SKILL_DEFS.map((d) => [d.id, d]));

/** Stat / skill → the derived-stat panel rows it changes (the `derived` column). Unknown id = empty list. */
export function derivedKeysOfStat(id: StatId): readonly DerivedPanelKey[] { return statDerived.get(id) ?? []; }
export function derivedKeysOfSkill(id: SkillId): readonly DerivedPanelKey[] { return skillDerived.get(id) ?? []; }

/** Every weapon class maps onto one shooting skill (PISTOL trains `기관단총`, the SMG skill). */
export const WEAPON_CLASS_SKILL: Readonly<Record<WeaponClass, SkillId>> =
  stringMap<WeaponClass>('tables.csv', 'WEAPON_CLASS_SKILL') as Record<WeaponClass, SkillId>;

/* ── raw skill-XP per trained action (before `지능` (intelligence) / stat scaling) ──────────── */
/**
 * Per *shot* that lands on an enemy (a shotgun emits one `weapon:hit` per pellet — ProgressionSystem
 * credits only the first). Order: `저격` > `산탄` > `지정사수` > `돌격` > `기관단총` — a sniper lands far fewer
 * shots per magazine, so a single hit is worth much more.
 */
export const GUN_HIT_XP: Readonly<Record<WeaponClass, number>> = numberMap<WeaponClass>('tables.csv', 'GUN_HIT_XP');

/** `인내` (grit): surviving a lethal hit is rare, so it is worth a lot. */
export const GRIT_SAVE_XP = T.num('GRIT_SAVE_XP');
/** `원예` (gardening): per harvested node (scaled by the yield). */
export const GATHER_XP = T.num('GATHER_XP');
/** `제작` (crafting) / `의학` (medicine): per completed craft. */
export const CRAFT_XP = T.num('CRAFT_XP');
/** `장비 관리` (gear maintenance): per repaired item. */
export const REPAIR_XP = T.num('REPAIR_XP');
/** `전술 임플란트` (tactical implants): per activation. */
export const IMPLANT_XP = T.num('IMPLANT_XP');
/** `암호학` (cryptography): per extraction console hack (once per mission at most). */
export const CRYPTO_XP = T.num('CRYPTO_XP');
/** `감정` (appraisal): opening a crate, plus a rarity-scaled bonus per item pulled out of it. */
export const CRATE_OPEN_XP = T.num('CRATE_OPEN_XP');
export const APPRAISE_XP_BY_RARITY: Readonly<Record<string, number>> = numberMap('tables.csv', 'APPRAISE_XP_BY_RARITY');
/** `운반` (hauling): per metre travelled while at 「조금 무거움」 or worse. */
export const CARRY_XP_PER_METER = T.num('CARRY_XP_PER_METER');

/** Convenience: the ids in display order (mirrors the shared contract). */
export const ORDERED_STAT_IDS: readonly StatId[] = STAT_IDS;
export const ORDERED_SKILL_IDS: readonly SkillId[] = SKILL_IDS;
