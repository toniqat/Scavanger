import type { WeaponClass, WeaponDef, WeaponSlot, EffectiveWeaponStats, UniqueWeaponKind, WeaponKind } from '@/shared';
import { SOCKET_SLOTS, WEAPON_ADS_TIME, WEAPON_DEFAULT_DURABILITY, WEAPON_SWAP_TIME_PRIMARY, WEAPON_SWAP_TIME_SECONDARY } from '@/shared';
import { shotSoundId, weaponKindOf } from '@/shared';
import { weaponClassOf, damageFalloff } from '@/items';

export { weaponClassOf, damageFalloff };

/**
 * The weapon slots in key order (1 / 2). 2026-09-10: with the secondary (3) gone there are only two —
 * `WeaponSlot` keeps `'secondary'` because it is a contract, but this list does not, so nothing fills that slot.
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
    sockets: def.sockets ?? SOCKET_SLOTS,
    swayMul: 1,
    falloffStart: def.falloffStart ?? def.range,
    falloffEnd: def.falloffEnd ?? def.range,
    falloffMin: def.falloffMin ?? 1,
    projectileSpeed: def.projectileSpeed ?? 0,
    bulletGravity: def.bulletGravity ?? 0,
    bloomPerShot: 0.14,
    bloomSpread: 1.6,
    bloomDecay: 2.6,
  };
}

/*
 * Visual / audio family of a weapon (drives the `WeaponModel` silhouette and the shot sound). The kind table and the
 * shot-sound ids it maps to now live **once**, in `shared/shotSounds.ts` (2026-09-20, `docs/TODO.md` B-63): player/
 * plays the very same sounds for android squadmates and must not import this folder (CLAUDE.md §4.1), so the copy it
 * kept drifted — it knew no unique and fired the rifle sample for every legendary. Both folders are call sites now;
 * a new shot sound is added there, not here. `kindOf` stays as this folder's name for `weaponKindOf`.
 */
export type { WeaponKind };
export { shotSoundId };

/** Kind by class → graded ids (`ar_g3`) pick the same procedural model as their family; uniques pick theirs. */
export function kindOf(def: WeaponDef): WeaponKind {
  return weaponKindOf(def);
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

/**
 * Is this a class whose ADS tightens the spread? 2026-09-17 (user's decision): the shotgun (SG) is not — ADS is
 * camera zoom only and the spread stays the hip value (`parts/Firing.fire`). A shotgun-class unique would follow
 * the same rule (decided by class).
 */
export function adsTightensSpread(cls: WeaponClass): boolean {
  return cls !== 'SG';
}
