import type { WeaponClass, WeaponDef, WeaponSlot, EffectiveWeaponStats } from '@/shared';
import { WEAPON_ADS_TIME, WEAPON_DEFAULT_DURABILITY, WEAPON_SWAP_TIME_PRIMARY, WEAPON_SWAP_TIME_SECONDARY } from '@/shared';
import { weaponClassOf, damageFalloff } from '@/items';

export { weaponClassOf, damageFalloff };

/** The three weapon slots in key order (1 / 2 / 3). */
export const WEAPON_SLOTS: readonly WeaponSlot[] = ['primary', 'primary2', 'secondary'];

/** Built-in fallbacks used when `ctx.loot` is unavailable or a weaponId cannot be resolved (v2 calibres). */
export const DEFAULT_RIFLE: WeaponDef = {
  id: 'ar23_liberator', name: 'AR-23 리버레이터', slot: 'primary', ammoType: 'medium', weaponClass: 'AR',
  damage: 60, fireRate: 10, magSize: 45, reserveMags: 6, reloadTime: 2.4,
  spread: 0.024, adsSpread: 0.006, range: 220, automatic: true, recoil: 0.011, tracerColor: 0xffd070,
  falloffStart: 60, falloffEnd: 220, falloffMin: 0.6,
};

export const DEFAULT_PISTOL: WeaponDef = {
  id: 'p2_peacemaker', name: 'P-2 피스메이커', slot: 'secondary', ammoType: 'light', weaponClass: 'PISTOL',
  damage: 45, fireRate: 6, magSize: 15, reserveMags: 6, reloadTime: 1.6,
  spread: 0.022, adsSpread: 0.007, range: 140, automatic: false, recoil: 0.02, tracerColor: 0xffe2a8,
  falloffStart: 20, falloffEnd: 70, falloffMin: 0.5,
};

/** Fallback def per weapon slot: both primaries get the rifle, the secondary the pistol. */
export function defaultFor(slot: WeaponSlot): WeaponDef {
  return slot === 'secondary' ? DEFAULT_PISTOL : DEFAULT_RIFLE;
}

/**
 * Effective stats derived from a bare def — used when `ctx.loot.getEffectiveStats` is unavailable or returns null
 * (built-in fallback weapons, dev mode). Mirrors items' `baseWeaponStats`: recoilH = 0.7 × the vertical kick
 * (the old horizontal constant), secondaries aim in twice as fast.
 */
export function statsFromDef(def: WeaponDef): EffectiveWeaponStats {
  const cls = weaponClassOf(def);
  const secondary = def.slot === 'secondary' || cls === 'PISTOL';
  return {
    weaponId: def.id,
    weaponClass: cls,
    ammoType: def.ammoType,
    grade: def.grade ?? 1,
    damage: def.damage,
    magSize: def.magSize,
    spread: def.spread,
    adsSpread: def.adsSpread,
    recoilV: def.recoil,
    recoilH: def.recoil * 0.7,
    adsTime: secondary ? WEAPON_ADS_TIME * 0.5 : WEAPON_ADS_TIME,
    swapTime: secondary ? WEAPON_SWAP_TIME_SECONDARY : WEAPON_SWAP_TIME_PRIMARY,
    adsZoom: def.adsZoom ?? 1,
    scope: !!def.scope,
    laser: false,
    maxDurability: def.maxDurability ?? WEAPON_DEFAULT_DURABILITY,
    reloadTime: def.reloadTime,
    fireRate: def.fireRate,
  };
}

/** Visual / audio family of a weapon (drives WeaponModel silhouette and shot sound). */
export type WeaponKind = 'rifle' | 'pistol' | 'shotgun' | 'energy' | 'smg' | 'sniper';

/** Kind by class → graded ids (`ar23_g3`) pick the same procedural model as their family. */
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
