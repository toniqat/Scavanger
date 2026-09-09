import type { WeaponClass, WeaponDef, WeaponSlot, EffectiveWeaponStats, UniqueWeaponKind } from '@/shared';
import { WEAPON_ADS_TIME, WEAPON_DEFAULT_DURABILITY, WEAPON_SWAP_TIME_PRIMARY, WEAPON_SWAP_TIME_SECONDARY } from '@/shared';
import { weaponClassOf, damageFalloff } from '@/items';

export { weaponClassOf, damageFalloff };

/**
 * The weapon slots in key order (1 / 2). 2026-09-10: 보조무기(3번)가 없어져 둘뿐이다 — `WeaponSlot` 의
 * `'secondary'` 는 계약이라 남아 있지만 이 목록에는 없고, 따라서 아무도 그 칸을 채우지 않는다.
 */
export const WEAPON_SLOTS: readonly WeaponSlot[] = ['primary', 'primary2'];

/** Built-in fallbacks used when `ctx.loot` is unavailable or a weaponId cannot be resolved (v2 calibres). */
export const DEFAULT_RIFLE: WeaponDef = {
  id: 'ar_fallback', name: '돌격소총', slot: 'primary', ammoType: 'medium', weaponClass: 'AR',
  damage: 60, fireRate: 10, magSize: 45, reserveMags: 6, reloadTime: 2.4,
  spread: 0.024, adsSpread: 0.006, range: 220, automatic: true, recoil: 0.011, tracerColor: 0xffd070,
  falloffStart: 60, falloffEnd: 220, falloffMin: 0.6,
};

export const DEFAULT_PISTOL: WeaponDef = {
  id: 'hg_fallback', name: '권총', slot: 'secondary', ammoType: 'light', weaponClass: 'PISTOL',
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

/**
 * Visual / audio family of a weapon (drives WeaponModel silhouette and shot sound). The six unique kinds
 * (`WeaponDef.unique`) each have their own silhouette.
 */
export type WeaponKind = 'rifle' | 'pistol' | 'shotgun' | 'energy' | 'smg' | 'sniper' | UniqueWeaponKind;

/** Kind by class → graded ids (`ar_g3`) pick the same procedural model as their family; uniques pick theirs. */
export function kindOf(def: WeaponDef): WeaponKind {
  if (def.unique) return def.unique;
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
    // uniques reuse existing SFX ids (no dedicated samples yet — see README)
    case 'flamethrower': return 'shot_energy';
    case 'shockgun': return 'shot_energy';
    case 'shuriken': return 'melee_swing';
    case 'bow': return 'melee_swing';
    case 'bazooka': return 'shot_shotgun';
    case 'minigun': return 'shot_rifle';
    default: return 'shot_rifle';
  }
}

/** True when `kind` is one of the six unique silhouettes. */
export function isUniqueKind(kind: WeaponKind): kind is UniqueWeaponKind {
  return kind === 'flamethrower' || kind === 'shockgun' || kind === 'shuriken' || kind === 'bow' || kind === 'bazooka' || kind === 'minigun';
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
