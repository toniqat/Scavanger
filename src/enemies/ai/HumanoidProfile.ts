import type { EnemyFaction } from '@/shared';
import type { Enemy } from '../Enemy';
import { HUMANOID_ANDROID, HUMANOID_RAIDER, HUMANOID_ROGUE, type HumanoidProfile } from '../EnemyTypes';

/* ────────────────────────────────────────────────────────────────────────────
 * 2026-09-13: 행성별 인간형 팩션 AI 프로필 — 안드로이드 · 로그 · 레이더.
 *
 * 세 팩션은 같은 로그 상태 기계(`ai/RogueAI`)를 타고, **사격 · 수류탄 · 엄폐 리듬**만 이 표에서 다르게 읽는다.
 * 수치의 원본은 `data/enemy_abilities.csv` 의 `HUMANOID_*` 블록이다 (여기에는 숫자가 없다).
 *
 * - 조준 오차는 **거리 곡선**이다: `aimNearDist` 안은 `aimNear`, `aimFarDist` 밖은 `aimFar`, 사이는 smoothstep.
 *   로그는 가까우면 위협적이고 멀면 거의 못 맞히며(0.055 → 0.15 rad), 레이더는 멀리서도 곡선이 거의 평평하다.
 *   서서 `ROGUE_AI.settleTime` 동안 쏘면 `settleMul` 배까지 줄어든다 (옛 `ROGUE_AIM_ERROR → _SETTLED` 의 자리).
 * - 네임드(`ai/named/*`)는 이 곡선을 쓰지 않는다 — 그들은 `fireGun` 에 자기 오차 · 피해를 직접 넘긴다.
 * - 벌레 팩션이 여기로 올 일은 없지만(인간형만 부른다) 안전하게 로그 표를 준다.
 * ──────────────────────────────────────────────────────────────────────────── */

export type { HumanoidProfile } from '../EnemyTypes';
export const ANDROID_PROFILE = HUMANOID_ANDROID;
export const ROGUE_PROFILE = HUMANOID_ROGUE;
export const RAIDER_PROFILE = HUMANOID_RAIDER;

const BY_FACTION: Readonly<Record<EnemyFaction, HumanoidProfile>> = {
  bug: HUMANOID_ROGUE,
  rogue: HUMANOID_ROGUE,
  android: HUMANOID_ANDROID,
  raider: HUMANOID_RAIDER,
};

/** `e` 의 팩션 프로필. */
export function humanoidProfile(e: Enemy): HumanoidProfile {
  return BY_FACTION[e.faction] ?? HUMANOID_ROGUE;
}

/** 팩션 이름으로 프로필 (스모크 · 디버그). */
export function profileOfFaction(f: EnemyFaction): HumanoidProfile {
  return BY_FACTION[f] ?? HUMANOID_ROGUE;
}

/**
 * 거리 `dist`(m) 에서의 조준 오차(rad). `settle01` = 0 이면 막 나와서 쏘는 첫 발, 1 이면 `settleTime` 을 다 서 있었다.
 * `parts/Attacks.fireGun` 이 이 값을 삼각 분포의 반폭으로 쓴다 (좌우 × 1, 위아래 × 0.7).
 */
export function humanoidAimError(p: HumanoidProfile, dist: number, settle01: number): number {
  const span = p.aimFarDist - p.aimNearDist;
  let k = span > 1e-3 ? (dist - p.aimNearDist) / span : dist >= p.aimFarDist ? 1 : 0;
  k = k < 0 ? 0 : k > 1 ? 1 : k;
  k = k * k * (3 - 2 * k);
  const base = p.aimNear + (p.aimFar - p.aimNear) * k;
  const s = settle01 < 0 ? 0 : settle01 > 1 ? 1 : settle01;
  return base * (1 + (p.settleMul - 1) * s);
}

/** 점사 한 번의 탄 수 (`burstMin … burstMax`, 정수). */
export function rollBurst(p: HumanoidProfile): number {
  const lo = Math.max(1, Math.round(p.burstMin));
  const hi = Math.max(lo, Math.round(p.burstMax));
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/** 점사 사이 쉼 (±30 %). */
export function rollBurstPause(p: HumanoidProfile): number {
  return p.burstPause * (0.7 + Math.random() * 0.6);
}

/**
 * 스폰 때 쥐여 주는 수류탄 (`parts/Pool.spawnRogue`, 권위만). `none` = 네임드 · 스캔 드론처럼 던지는 AI 가 없는 종류.
 * 남은 수는 `Enemy.grenadeCount` 에 있고 던질 때마다 줄며(`parts/Attacks.throwGrenade`), 죽으면 시체에 그대로 들어간다.
 */
export function rollGrenadeLoadout(e: Enemy, none: boolean): void {
  e.grenadeKind = 'frag';
  e.grenadeCount = 0;
  if (none || !e.isHumanoid) return;
  const p = humanoidProfile(e);
  const lo = Math.max(0, Math.round(p.grenadeMin));
  const hi = Math.max(lo, Math.round(p.grenadeMax));
  if (hi <= 0) return;
  e.grenadeCount = lo + Math.floor(Math.random() * (hi - lo + 1));
  e.grenadeKind = Math.random() < p.incendiaryChance ? 'incendiary' : 'frag';
}
