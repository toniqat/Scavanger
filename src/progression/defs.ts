import type { SkillDef, SkillId, StatDef, StatId, WeaponClass } from '@/shared';
import { SKILL_IDS, STAT_IDS } from '@/shared';

/* ────────────────────────────────────────────────────────────────────────────
 * Static definitions for the 5 stats and 14 skills (Korean names + descriptions)
 * and the raw skill-XP amounts every trained action is worth.
 * Owner: progression/. Nothing else defines these.
 * ──────────────────────────────────────────────────────────────────────────── */

export const STAT_DEFS: readonly StatDef[] = [
  {
    id: 'strength',
    name: '근력',
    description: '적재량, 근접 피해, 도약력, 투척 거리를 올린다.',
  },
  {
    id: 'endurance',
    name: '지구력',
    description: '최대 스태미나와 스태미나 회복 속도를 올린다.',
  },
  {
    id: 'perception',
    name: '인지력',
    description: '주변 상호작용물과 화면 밖 적을 감지하는 거리를 넓힌다.',
  },
  {
    id: 'intelligence',
    name: '지능',
    description: '모든 숙련도의 상승 속도를 올린다.',
  },
  {
    id: 'dexterity',
    name: '재주',
    description: '소모품 사용 속도와 상호작용(홀드) 속도를 올린다.',
  },
];

export const SKILL_DEFS: readonly SkillDef[] = [
  {
    id: 'carry',
    name: '운반',
    description: '무거운 짐을 지고 이동하면 오른다. 「조금 무거움」 상태의 스태미나 손해를 줄인다.',
    stats: ['strength'],
  },
  {
    id: 'appraisal',
    name: '감정',
    description: '상자를 뒤지면 오른다. 아이템 서치 속도가 빨라진다.',
    stats: ['perception'],
  },
  {
    id: 'grit',
    name: '인내',
    description: '치명상을 버텨내면 오른다. 치명타를 체력 1로 버틸 확률이 늘어난다.',
    stats: ['endurance'],
  },
  {
    id: 'gardening',
    name: '원예',
    description: '약초를 채집하면 오른다. 채집 수확량이 늘어난다.',
    stats: ['dexterity', 'intelligence'],
  },
  {
    id: 'crafting',
    name: '제작',
    description: '현장 제작을 완료하면 오른다. 제작 속도가 빨라진다.',
    stats: ['dexterity', 'intelligence'],
  },
  {
    id: 'medicine',
    name: '의학',
    description: '치료 물자를 조제하면 오른다. 회복 아이템의 효과가 커진다.',
    stats: ['intelligence'],
  },
  {
    id: 'cryptography',
    name: '암호학',
    description: '탈출 콘솔을 해킹하면 오른다. 탈출선 호출이 빨라진다.',
    stats: ['intelligence'],
  },
  {
    id: 'implant',
    name: '전술 임플란트',
    description: '임플란트를 사용하면 오른다. 재사용 대기시간이 줄어든다.',
    stats: ['intelligence'],
  },
  {
    id: 'gun_AR',
    name: '사격 · 돌격소총',
    description: '돌격소총 명중으로 오른다. 반동이 줄고 재장전이 빨라진다.',
    stats: ['perception'],
    weaponClass: 'AR',
  },
  {
    id: 'gun_SMG',
    name: '사격 · 기관단총',
    description: '기관단총·권총 명중으로 오른다. 반동이 줄고 재장전이 빨라진다.',
    stats: ['perception'],
    weaponClass: 'SMG',
  },
  {
    id: 'gun_SR',
    name: '사격 · 저격소총',
    description: '저격소총 명중으로 오른다. 반동이 줄고 재장전이 빨라진다.',
    stats: ['perception'],
    weaponClass: 'SR',
  },
  {
    id: 'gun_DMR',
    name: '사격 · 지정사수소총',
    description: '지정사수소총 명중으로 오른다. 반동이 줄고 재장전이 빨라진다.',
    stats: ['perception'],
    weaponClass: 'DMR',
  },
  {
    id: 'gun_SG',
    name: '사격 · 산탄총',
    description: '산탄총 명중으로 오른다. 반동이 줄고 재장전이 빨라진다.',
    stats: ['perception'],
    weaponClass: 'SG',
  },
  {
    id: 'equipment',
    name: '장비 관리',
    description: '장비를 수리하면 오른다. 장비 내구도 소모가 줄어든다.',
    stats: ['dexterity'],
  },
];

export const STAT_DEF_MAP: ReadonlyMap<StatId, StatDef> = new Map(STAT_DEFS.map((d) => [d.id, d]));
export const SKILL_DEF_MAP: ReadonlyMap<SkillId, SkillDef> = new Map(SKILL_DEFS.map((d) => [d.id, d]));

/** Every weapon class maps onto one shooting skill (PISTOL trains 기관단총). */
export const WEAPON_CLASS_SKILL: Readonly<Record<WeaponClass, SkillId>> = {
  AR: 'gun_AR',
  SMG: 'gun_SMG',
  SR: 'gun_SR',
  DMR: 'gun_DMR',
  SG: 'gun_SG',
  PISTOL: 'gun_SMG',
};

/* ── raw skill-XP per trained action (before 지능 / stat scaling) ──────────── */
/**
 * Per *shot* that lands on an enemy (a shotgun emits one `weapon:hit` per pellet — ProgressionSystem
 * credits only the first). Order: 저격 > 산탄 > 지정사수 > 돌격 > 기관단총 — a sniper lands far fewer
 * shots per magazine, so a single hit is worth much more.
 */
export const GUN_HIT_XP: Readonly<Record<WeaponClass, number>> = {
  SR: 0.12,
  SG: 0.07,
  DMR: 0.05,
  AR: 0.03,
  SMG: 0.018,
  PISTOL: 0.02,
};

/** 인내: surviving a lethal hit is rare, so it is worth a lot. */
export const GRIT_SAVE_XP = 1.2;
/** 원예: per harvested node (scaled by the yield). */
export const GATHER_XP = 0.35;
/** 제작 / 의학: per completed craft. */
export const CRAFT_XP = 0.5;
/** 장비 관리: per repaired item. */
export const REPAIR_XP = 0.6;
/** 전술 임플란트: per activation. */
export const IMPLANT_XP = 0.22;
/** 암호학: per extraction console hack (once per mission at most). */
export const CRYPTO_XP = 3;
/** 감정: opening a crate, plus a rarity-scaled bonus per item pulled out of it. */
export const CRATE_OPEN_XP = 0.4;
export const APPRAISE_XP_BY_RARITY: Readonly<Record<string, number>> = {
  common: 0.04,
  uncommon: 0.07,
  rare: 0.11,
  epic: 0.16,
  legendary: 0.24,
};
/** 운반: per metre travelled while at 「조금 무거움」 or worse. */
export const CARRY_XP_PER_METER = 0.01;

/** Convenience: the ids in display order (mirrors the shared contract). */
export const ORDERED_STAT_IDS: readonly StatId[] = STAT_IDS;
export const ORDERED_SKILL_IDS: readonly SkillId[] = SKILL_IDS;
