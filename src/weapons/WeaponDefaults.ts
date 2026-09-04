import type { WeaponClass, WeaponDef } from '@/shared';
import { weaponClassOf, damageFalloff } from '@/items';

export { weaponClassOf, damageFalloff };

/** Built-in fallbacks used when `ctx.loot` is unavailable or a weaponId cannot be resolved. */
export const DEFAULT_RIFLE: WeaponDef = {
  id: 'ar23_liberator', name: 'AR-23 리버레이터', slot: 'primary', ammoType: 'rifle', weaponClass: 'AR',
  damage: 60, fireRate: 10, magSize: 45, reserveMags: 6, reloadTime: 2.4,
  spread: 0.024, adsSpread: 0.006, range: 220, automatic: true, recoil: 0.011, tracerColor: 0xffd070,
  falloffStart: 60, falloffEnd: 220, falloffMin: 0.6,
};

export const DEFAULT_PISTOL: WeaponDef = {
  id: 'p2_peacemaker', name: 'P-2 피스메이커', slot: 'secondary', ammoType: 'pistol', weaponClass: 'PISTOL',
  damage: 45, fireRate: 6, magSize: 15, reserveMags: 6, reloadTime: 1.6,
  spread: 0.022, adsSpread: 0.007, range: 140, automatic: false, recoil: 0.02, tracerColor: 0xffe2a8,
  falloffStart: 20, falloffEnd: 70, falloffMin: 0.5,
};

export function defaultFor(slot: 'primary' | 'secondary'): WeaponDef {
  return slot === 'primary' ? DEFAULT_RIFLE : DEFAULT_PISTOL;
}

/** Visual / audio family of a weapon (drives WeaponModel silhouette and shot sound). */
export type WeaponKind = 'rifle' | 'pistol' | 'shotgun' | 'energy' | 'smg' | 'sniper';

export function kindOf(def: WeaponDef): WeaponKind {
  if (def.pellets && def.pellets > 1) return 'shotgun';
  if (def.ammoType === 'energy') return 'energy';
  switch (weaponClassOf(def)) {
    case 'SR': return 'sniper';
    case 'SMG': return 'smg';
    case 'PISTOL': return 'pistol';
    case 'SG': return 'shotgun';
    default: return 'rifle';   // AR / DMR
  }
}

export function shotSoundId(kind: WeaponKind): string {
  switch (kind) {
    case 'pistol': return 'shot_pistol';
    case 'shotgun': return 'shot_shotgun';
    case 'energy': return 'shot_energy';
    case 'smg': return 'shot_smg';
    case 'sniper': return 'shot_sniper';
    default: return 'shot_rifle';
  }
}

/** Base pitch of the shot sound per class (DMR fires the rifle sample lower / heavier). */
export function shotPitchFor(cls: WeaponClass): number {
  return cls === 'DMR' ? 0.78 : 1;
}

/**
 * Recoil / spread multiplier by stance and aim. Standing hip fire is the loosest.
 * Index: [stance][hip | ads].
 */
export const STANCE_ACCURACY: Readonly<Record<'stand' | 'crouch' | 'prone', readonly [number, number]>> = {
  stand: [1.0, 0.7],
  crouch: [0.55, 0.4],
  prone: [0.32, 0.22],
};
