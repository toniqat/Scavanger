/**
 * src/enemies/factionTables.ts — 행성별 인간형 팩션의 **스폰 수치** (2026-09-13).
 *
 * 거점 점거(`SiteGroups.ts`) · 레이더 강하(`RogueDrop.ts`) · 네임드 확률(`named/Director.ts`)이 읽는 csv 를 한곳에서
 * 옮긴다. 이 파일은 three.js · fx 같은 무거운 것을 import 하지 않는다 — `npm run data:check` 가 로더 목록
 * (`scripts/data-owners.mjs`)으로 이 모듈을 직접 읽어 `constants.csv` 의 키를 "읽힌 것"으로 표시하기 때문이다.
 *
 * 표(`data/tables.csv`)의 `SITE_*` · `*_BY_THREAT` 는 index 0 = 행성 threat 1 … 2 = threat 3,
 * `RAIDER_DROP_WAVE*` 는 index 0 = 분대 1명 … 3 = 4명이다.
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
