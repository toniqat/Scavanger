/**
 * src/weapons/AimSway.ts — **무기 계열별 조준 흔들림 크기** (2026-09-12, `data/aim_sway.csv`).
 *
 * weapons 는 손에 든 무기의 계열에서 진폭 · 빈도를 골라 `PlayerWeaponHost.setAimSway` 로 넘기기만 한다 (`parts/Firing.applyAimZoom`).
 * 흔들림 자체(8자 · 정조준 정도 · 자세 · 이동 · `aimSwayMul`)는 player 의 `CameraRig` 가 돌린다 — 사격 판정은 크로스헤어 선
 * (`parts/AimLine`)이라 카메라가 흔들린 만큼 탄도 같이 움직인다.
 */
import { csvRows, type EffectiveWeaponStats, type WeaponClass } from '@/shared';

export interface AimSwayProfile {
  /** 좌우 최대 각도(도). */
  readonly amplitudeDeg: number;
  /** 좌우 왕복 빈도(Hz). */
  readonly frequencyHz: number;
}

const CLASSES: readonly WeaponClass[] = ['AR', 'SMG', 'SG', 'DMR', 'SR', 'PISTOL'];
const NONE: AimSwayProfile = { amplitudeDeg: 0, frequencyHz: 0 };

const TABLE: ReadonlyMap<WeaponClass, AimSwayProfile> = (() => {
  const m = new Map<WeaponClass, AimSwayProfile>();
  for (const r of csvRows('aim_sway.csv')) {
    const cls = r.enum('class', CLASSES);
    if (m.has(cls)) { r.report('class', `'${cls}' 가 중복이다`); continue; }
    m.set(cls, { amplitudeDeg: r.num('amplitudeDeg', { min: 0, max: 5 }), frequencyHz: r.num('frequencyHz', { min: 0, max: 5 }) });
  }
  return m;
})();

/** 계열 하나의 흔들림 (표에 없는 계열 = 흔들림 없음). */
export function aimSwayOfClass(cls: WeaponClass | undefined): AimSwayProfile {
  return (cls && TABLE.get(cls)) || NONE;
}

/** `applyAimZoom` 이 받는 실효 스탯에서 (null = 조준할 무기가 손에 없다 → 흔들림 없음). */
export function aimSwayFor(stats: EffectiveWeaponStats | null): AimSwayProfile {
  return stats ? aimSwayOfClass(stats.weaponClass) : NONE;
}
