import type { SkillDef, SkillId, StatDef, StatId, WeaponClass } from '@/shared';
import { SKILL_IDS, STAT_IDS, csvRows, keyTable, numberMap, stringMap } from '@/shared';

/* 수치의 원본: `data/stats.csv` · `data/skills.csv`, 행동당 경험치는 `data/tuning.csv`,
 * 무기→숙련 대응과 등급별 감정 경험치는 `data/tables.csv` 다. */
const T = /* data/tuning.csv */ keyTable('tuning.csv');

/* ────────────────────────────────────────────────────────────────────────────
 * Static definitions for the 5 stats and 14 skills (Korean names + descriptions)
 * and the raw skill-XP amounts every trained action is worth.
 * Owner: progression/. Nothing else defines these.
 * ──────────────────────────────────────────────────────────────────────────── */

export const STAT_DEFS: readonly StatDef[] = csvRows('stats.csv').map((r) => ({
  id: r.str('id') as StatId,
  name: r.str('name'),
  description: r.str('description'),
}));

export const SKILL_DEFS: readonly SkillDef[] = csvRows('skills.csv').map((r) => ({
  id: r.str('id') as SkillId,
  name: r.str('name'),
  description: r.str('description'),
  stats: r.list('stats') as StatId[],
  ...(r.has('weaponClass') ? { weaponClass: r.str('weaponClass') as WeaponClass } : {}),
}));

export const STAT_DEF_MAP: ReadonlyMap<StatId, StatDef> = new Map(STAT_DEFS.map((d) => [d.id, d]));
export const SKILL_DEF_MAP: ReadonlyMap<SkillId, SkillDef> = new Map(SKILL_DEFS.map((d) => [d.id, d]));

/** Every weapon class maps onto one shooting skill (PISTOL trains 기관단총). */
export const WEAPON_CLASS_SKILL: Readonly<Record<WeaponClass, SkillId>> =
  stringMap<WeaponClass>('tables.csv', 'WEAPON_CLASS_SKILL') as Record<WeaponClass, SkillId>;

/* ── raw skill-XP per trained action (before 지능 / stat scaling) ──────────── */
/**
 * Per *shot* that lands on an enemy (a shotgun emits one `weapon:hit` per pellet — ProgressionSystem
 * credits only the first). Order: 저격 > 산탄 > 지정사수 > 돌격 > 기관단총 — a sniper lands far fewer
 * shots per magazine, so a single hit is worth much more.
 */
export const GUN_HIT_XP: Readonly<Record<WeaponClass, number>> = numberMap<WeaponClass>('tables.csv', 'GUN_HIT_XP');

/** 인내: surviving a lethal hit is rare, so it is worth a lot. */
export const GRIT_SAVE_XP = T.num('GRIT_SAVE_XP');
/** 원예: per harvested node (scaled by the yield). */
export const GATHER_XP = T.num('GATHER_XP');
/** 제작 / 의학: per completed craft. */
export const CRAFT_XP = T.num('CRAFT_XP');
/** 장비 관리: per repaired item. */
export const REPAIR_XP = T.num('REPAIR_XP');
/** 전술 임플란트: per activation. */
export const IMPLANT_XP = T.num('IMPLANT_XP');
/** 암호학: per extraction console hack (once per mission at most). */
export const CRYPTO_XP = T.num('CRYPTO_XP');
/** 감정: opening a crate, plus a rarity-scaled bonus per item pulled out of it. */
export const CRATE_OPEN_XP = T.num('CRATE_OPEN_XP');
export const APPRAISE_XP_BY_RARITY: Readonly<Record<string, number>> = numberMap('tables.csv', 'APPRAISE_XP_BY_RARITY');
/** 운반: per metre travelled while at 「조금 무거움」 or worse. */
export const CARRY_XP_PER_METER = T.num('CARRY_XP_PER_METER');

/** Convenience: the ids in display order (mirrors the shared contract). */
export const ORDERED_STAT_IDS: readonly StatId[] = STAT_IDS;
export const ORDERED_SKILL_IDS: readonly SkillId[] = SKILL_IDS;
