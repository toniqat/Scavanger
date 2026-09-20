/**
 * src/weapons/AimSway.ts — **aim sway amplitude per weapon class** (2026-09-12, `data/aim_sway.csv`).
 *
 * weapons only picks the amplitude · frequency from the class of the weapon in hand and hands them to
 * `PlayerWeaponHost.setAimSway` (`parts/Firing.applyAimZoom`). The sway itself (the figure of eight · how far
 * into ADS · stance · movement · `aimSwayMul`) is run by player's `CameraRig` — a shot is judged on the crosshair
 * line (`parts/AimLine`), so the round moves exactly as much as the camera swayed.
 */
import { csvRows, type EffectiveWeaponStats, type WeaponClass } from '@/shared';

export interface AimSwayProfile {
  /** Maximum left-right angle (degrees). */
  readonly amplitudeDeg: number;
  /** Left-right round-trip frequency (Hz). */
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

/** The sway of one class (a class missing from the table = no sway). */
export function aimSwayOfClass(cls: WeaponClass | undefined): AimSwayProfile {
  return (cls && TABLE.get(cls)) || NONE;
}

/** From the effective stats `applyAimZoom` is given (null = nothing aimable in hand → no sway). */
export function aimSwayFor(stats: EffectiveWeaponStats | null): AimSwayProfile {
  return stats ? aimSwayOfClass(stats.weaponClass) : NONE;
}
