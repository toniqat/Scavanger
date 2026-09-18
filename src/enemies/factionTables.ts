/**
 * src/enemies/factionTables.ts — 행성별 인간형 팩션의 **스폰 수치** (2026-09-13).
 *
 * 거점 점거(`SiteGroups.ts`) · 레이더 강하(`RogueDrop.ts`) · 네임드 확률(`named/Director.ts`)이 읽는 csv 를 한곳에서
 * 옮긴다. 이 파일은 three.js · fx 같은 무거운 것을 import 하지 않는다 — `npm run data:check` 가 로더 목록
 * (`scripts/data-owners.mjs`)으로 이 모듈을 직접 읽어 `constants.csv` 의 키를 "읽힌 것"으로 표시하기 때문이다.
 *
 * 표(`data/tables.csv`)의 `SITE_*` · `*_BY_THREAT` 는 index 0 = 행성 threat 1 … 2 = threat 3,
 * `RAIDER_DROP_WAVE*` 는 index 0 = 분대 1명 … 3 = 4명이다.
 *
 * 2026-09-14: **벌레 난이도** 표(`BUG_HP_MUL_BY_THREAT` · `BIG_BUG_WEIGHT_MUL_BY_THREAT` · `MID_BUG_WEIGHT_MUL_BY_THREAT` ·
 * `PATROL_BEHEMOTH_BY_THREAT` · `ARTILLERY_CAP_BONUS_BY_THREAT` · `BEHEMOTH_CAP_BONUS_BY_THREAT`)도 여기서 옮긴다 — 같은 threat 색인이고
 * 이 파일이 이미 data:check 로더 목록에 있다. 한 칸으로 묶는 것은 `bugThreatTuning(threat)`.
 */
import { keyTable, numberList } from '@/shared';

const K = /* data/constants.csv */ keyTable('constants.csv');

/* ── 거점 점거 (SiteGroups) ── */
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
/** 2026-09-13 후속 결정: 선로 플랫폼 · 폐허 전초 그룹의 인원 (연구소 · 전진기지는 `SITE_GROUP_SIZE_*`). */
export const SITE_OUTLYING_GROUP_SIZE_MIN: readonly number[] = numberList('tables.csv', 'SITE_OUTLYING_GROUP_SIZE_MIN');
export const SITE_OUTLYING_GROUP_SIZE_MAX: readonly number[] = numberList('tables.csv', 'SITE_OUTLYING_GROUP_SIZE_MAX');
export const SITE_BOSS_CHANCE: readonly number[] = numberList('tables.csv', 'SITE_BOSS_CHANCE');
/** 한 레이드의 거점 로그 분대장 최대 수. */
export const SITE_BOSS_MAX_PER_RAID = K.num('SITE_BOSS_MAX_PER_RAID');
/** 한 그룹 안 인간형끼리의 최소 간격(m). */
export const SITE_GROUP_MIN_GAP_M = K.num('SITE_GROUP_MIN_GAP_M');
/** 실내 / 실외 그룹 리시 = 거점 반경 + 이 값(m). */
export const SITE_GROUP_LEASH_INDOOR_M = K.num('SITE_GROUP_LEASH_INDOOR_M');
export const SITE_GROUP_LEASH_OUTDOOR_M = K.num('SITE_GROUP_LEASH_OUTDOOR_M');

/* ── 레이더 강하 (RogueDrop) ── */
export const RAIDER_DROP_CHANCE_BY_THREAT: readonly number[] = numberList('tables.csv', 'RAIDER_DROP_CHANCE_BY_THREAT');
export const RAIDER_DROP_WAVE1_MIN: readonly number[] = numberList('tables.csv', 'RAIDER_DROP_WAVE1_MIN');
export const RAIDER_DROP_WAVE1_MAX: readonly number[] = numberList('tables.csv', 'RAIDER_DROP_WAVE1_MAX');
export const RAIDER_DROP_WAVE2_MIN: readonly number[] = numberList('tables.csv', 'RAIDER_DROP_WAVE2_MIN');
export const RAIDER_DROP_WAVE2_MAX: readonly number[] = numberList('tables.csv', 'RAIDER_DROP_WAVE2_MAX');
/** 두 번째 파도가 첫 예고 뒤 몇 초에 따로 예고되는가. */
export const RAIDER_DROP_WAVE_GAP_S = K.num('RAIDER_DROP_WAVE_GAP_S');
/** 한 파도의 최대 인원. */
export const RAIDER_DROP_WAVE_MAX = K.num('RAIDER_DROP_WAVE_MAX');

/* ── 네임드 (named/Director) ── */
export const NAMED_ROGUE_CHANCE_BY_THREAT: readonly number[] = numberList('tables.csv', 'NAMED_ROGUE_CHANCE_BY_THREAT');

/** threat 표 한 칸 (범위 밖 색인은 끝 칸 · 비유한 값은 0). */
export function byThreat(table: readonly number[], threat: number): number {
  if (table.length === 0) return 0;
  const v = table[Math.max(0, Math.min(table.length - 1, Math.round(threat) - 1))];
  return Number.isFinite(v) ? v : 0;
}

/* ── 2026-09-14: 벌레 난이도 (행성 threat) — `Pool.acquire` 의 체력 배수 · `Spawner.threatEcosystem` 의 구성 배수 ── */
export const BUG_HP_MUL_BY_THREAT: readonly number[] = numberList('tables.csv', 'BUG_HP_MUL_BY_THREAT');
export const BIG_BUG_WEIGHT_MUL_BY_THREAT: readonly number[] = numberList('tables.csv', 'BIG_BUG_WEIGHT_MUL_BY_THREAT');
export const MID_BUG_WEIGHT_MUL_BY_THREAT: readonly number[] = numberList('tables.csv', 'MID_BUG_WEIGHT_MUL_BY_THREAT');
export const PATROL_BEHEMOTH_BY_THREAT: readonly number[] = numberList('tables.csv', 'PATROL_BEHEMOTH_BY_THREAT');
export const ARTILLERY_CAP_BONUS_BY_THREAT: readonly number[] = numberList('tables.csv', 'ARTILLERY_CAP_BONUS_BY_THREAT');
export const BEHEMOTH_CAP_BONUS_BY_THREAT: readonly number[] = numberList('tables.csv', 'BEHEMOTH_CAP_BONUS_BY_THREAT');

/** 한 레이드의 벌레 난이도 (행성 threat 한 칸을 읽어 둔 것 — `EnemySystem` 이 `world:ready` 에서 만든다). */
export interface BugThreatTuning {
  /** 행성 threat 1..3 (행성 없음 · 훈련장 = 1). */
  readonly threat: 1 | 2 | 3;
  /** 팩션 bug 최대 체력 배수 (땅굴벌레 제외). */
  readonly hpMul: number;
  /** charger · behemoth · artillery 가중치 · 순찰 대형 슬롯 확률 · 포병 굴착 확률 배수. */
  readonly bigMul: number;
  /** warrior · spewer 가중치 배수. */
  readonly midMul: number;
  /** 순찰의 대형 슬롯이 베헤모스를 뽑을 수 있다. */
  readonly patrolBehemoth: boolean;
  readonly artilleryCapBonus: number;
  readonly behemothCapBonus: number;
}

/** 표 한 칸 → 난이도 (배수는 0 이상, 상한 보너스는 0 이상 정수). threat 1 칸이 전부 1 / 0 이면 예전과 비트 동일. */
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

/* ── 2026-09-18: 벌레 둥지 (사용자 결정 「둥지 반경 60 m 리시 · 초기 수 절반 · 재스폰 50/35/15 %」) ──
 * 읽는 곳: `ai/NestLeash.ts` (리시) · `NestDirector.ts` (초기 수비대 배수 · 보충 굴림 · 방아쇠) · `Spawner.initialPopulate`.
 * 값 하나짜리 표는 `NEST_COUNT_MIN` 과 같은 요령으로 key 0 만 쓴다. */
const one = (table: string, fallback: number): number => {
  const v = numberList('tables.csv', table)[0];
  return Number.isFinite(v) ? v : fallback;
};
/** 둥지에서 난 벌레가 표적을 쫓을 수 있는 최대 거리(m). 둥지에서 나지 않은 벌레는 받지 않는다. */
export const NEST_LEASH_M = one('NEST_LEASH_M', 60);
/** 돌아가기를 끝내는 거리 = `NEST_LEASH_M` × 이 값 (경계 떨림을 막는 이력). */
export const NEST_LEASH_RETURN_FRAC = one('NEST_LEASH_RETURN_FRAC', 0.5);
/** 레이드 시작 때 까는 순찰 **무리 수** 배수 (`Spawner.initialPopulate`). 0.5 = 절반. */
export const NEST_INITIAL_GARRISON_MUL = one('NEST_INITIAL_GARRISON_MUL', 0.5);
/** 그 둥지의 살아 있는 **움직이는** 벌레가 처음 깔린 수 × 이 값 이하면 보충이 터진다 (알은 세지 않는다). */
export const NEST_REFILL_TRIGGER_FRAC = one('NEST_REFILL_TRIGGER_FRAC', 1 / 3);
/** 호스트가 둥지별 생존 수를 다시 세는 간격(s). */
export const NEST_REFILL_CHECK_S = one('NEST_REFILL_CHECK_S', 2);
/** 보충 **횟수**의 확률 — index k = k+1 회 (사용자 결정 1회 50 % · 2회 35 % · 3회 15 %). */
export const NEST_REFILL_COUNT_CHANCE: readonly number[] = numberList('tables.csv', 'NEST_REFILL_COUNT_CHANCE');
