import type { DerivedStats, SkillDef, SkillId, StatDef, StatId, WeaponClass } from '@/shared';
import { SKILL_IDS, STAT_IDS, csvRows, keyTable, numberMap, stringMap } from '@/shared';

/* 수치의 원본: `data/stats.csv` · `data/skills.csv`, 행동당 경험치는 `data/tuning.csv`,
 * 무기→숙련 대응과 등급별 감정 경험치는 `data/tables.csv` 다. */
const T = /* data/tuning.csv */ keyTable('tuning.csv');

/* ────────────────────────────────────────────────────────────────────────────
 * Static definitions for the 5 stats and 14 skills (Korean names + descriptions)
 * and the raw skill-XP amounts every trained action is worth.
 * Owner: progression/. Nothing else defines these.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 캐릭터 시트 「파생 능력치」 패널의 줄 키 (2026-09-13) — 표시 순서 그대로. `stats.csv` · `skills.csv` 의 `derived` 칸은
 * 이 중에서만 고를 수 있다 (로더가 검사하므로 `npm run data:check` 가 오타를 잡는다). 이름은 `DerivedStats` 의 필드
 * 이름이고, `throwRangeMul` 줄은 배율이 아니라 `throwRangeM` 를 보여 준다 (`ui/SheetBody.derivedText`).
 * 사격 숙련의 무기 종류별 반동 · 장전은 패널에 줄이 없다 (사용자 결정 — 툴팁이 숫자만 보여 준다).
 */
export const DERIVED_PANEL_KEYS = [
  'carryCapacity', 'maxStamina', 'detectRadius', 'enemyDetectRadius', 'meleeDamageMul', 'throwRangeMul',
  'skillGainMul', 'useSpeedMul', 'interactSpeedMul', 'gritChance', 'searchSpeedMul', 'healPowerMul',
  'shipCallSpeedMul', 'implantCooldownMul', 'durabilityLossMul', 'gatherYieldMul', 'craftSpeedMul', 'carryReliefFactor',
] as const satisfies readonly (keyof DerivedStats)[];
export type DerivedPanelKey = (typeof DERIVED_PANEL_KEYS)[number];

const statDerived = new Map<StatId, readonly DerivedPanelKey[]>();
const skillDerived = new Map<SkillId, readonly DerivedPanelKey[]>();

export const STAT_DEFS: readonly StatDef[] = csvRows('stats.csv').map((r) => {
  const id = r.str('id') as StatId;
  const derived = r.enumList('derived', DERIVED_PANEL_KEYS);
  // 능력치는 전부 패널의 무언가를 바꾼다 — 빈 칸은 빠뜨린 것이다 (숙련은 사격이 비어 있는 게 정상이라 검사하지 않는다)
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

/** 능력치 · 숙련 → 그것이 바꾸는 파생 능력치 패널 줄 (`derived` 칸). 모르는 id 는 빈 목록. */
export function derivedKeysOfStat(id: StatId): readonly DerivedPanelKey[] { return statDerived.get(id) ?? []; }
export function derivedKeysOfSkill(id: SkillId): readonly DerivedPanelKey[] { return skillDerived.get(id) ?? []; }

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
