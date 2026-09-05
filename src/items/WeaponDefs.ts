import type { WeaponClass, WeaponDef } from '@/shared';
import { MELEE_STOCK_MUL_DEFAULT } from '@/shared';

const deg = (d: number): number => (d * Math.PI) / 180;

/** Korean label per weapon archetype (HUD / tooltips). */
export const WEAPON_CLASS_LABEL_KO: Readonly<Record<WeaponClass, string>> = {
  AR: '돌격소총', SMG: '기관단총', SR: '저격소총', DMR: '지정사수소총', SG: '산탄총', PISTOL: '권총',
};

/** Class of a weapon def; undefined → secondary slot is a pistol, everything else an AR. */
export function weaponClassOf(def: WeaponDef): WeaponClass {
  return def.weaponClass ?? (def.slot === 'secondary' ? 'PISTOL' : 'AR');
}

/**
 * Stock melee multiplier (개머리판). Every weapon deals the same base `MELEE_DAMAGE`; only primaries
 * with a real stock swing harder. Pistols have none → `MELEE_STOCK_MUL_DEFAULT`.
 */
export function meleeMulOf(def: WeaponDef): number {
  return def.meleeMul ?? MELEE_STOCK_MUL_DEFAULT;
}

/**
 * Weapon ballistics. Each entry is referenced from an ItemDef via `weaponId`
 * (item id = `wpn_<weaponId>`). `projectileSpeed` undefined → hitscan.
 *
 * Damage falloff: ×1 up to `falloffStart`, linear down to `falloffMin` at `falloffEnd`
 * (distance from muzzle to hit point). Hip spreads are deliberately loose — stance/ADS
 * multipliers in WeaponSystem tighten them (stand-hip 1.0 … prone-ADS 0.22).
 */
export const WEAPON_DEFS: readonly WeaponDef[] = [
  {
    id: 'ar23', name: 'AR-23 리버레이터', slot: 'primary', ammoType: 'rifle', weaponClass: 'AR',
    damage: 60, fireRate: 10, magSize: 45, reserveMags: 6, reloadTime: 2.4,
    spread: deg(1.4), adsSpread: deg(0.3), range: 220, automatic: true,
    recoil: deg(0.35), tracerColor: 0xffd27a,
    falloffStart: 60, falloffEnd: 220, falloffMin: 0.6, meleeMul: 1.35,
  },
  {
    id: 'smg37', name: 'SMG-37 디펜더', slot: 'primary', ammoType: 'pistol', weaponClass: 'SMG',
    damage: 32, fireRate: 14, magSize: 40, reserveMags: 5, reloadTime: 1.9,
    spread: deg(1.9), adsSpread: deg(0.55), range: 120, automatic: true,
    recoil: deg(0.24), tracerColor: 0xffe3a0,
    falloffStart: 15, falloffEnd: 45, falloffMin: 0.4, meleeMul: 1.15,
  },
  {
    id: 'sg8', name: 'SG-8 퍼니셔', slot: 'primary', ammoType: 'shotgun', weaponClass: 'SG',
    damage: 22, pellets: 8, fireRate: 1.3, magSize: 8, reserveMags: 4, reloadTime: 3.0,
    spread: deg(5.0), adsSpread: deg(3.5), range: 42, automatic: false,
    recoil: deg(1.4), tracerColor: 0xffb070,
    falloffStart: 8, falloffEnd: 30, falloffMin: 0.25, meleeMul: 1.5,
  },
  {
    id: 'r63', name: 'R-63 딜리전스', slot: 'primary', ammoType: 'rifle', weaponClass: 'DMR',
    damage: 120, fireRate: 3, magSize: 15, reserveMags: 5, reloadTime: 2.6,
    spread: deg(1.2), adsSpread: deg(0.08), range: 420, automatic: false,
    recoil: deg(0.9), tracerColor: 0xa8e6ff,
    falloffStart: 120, falloffEnd: 400, falloffMin: 0.75, adsZoom: 1.6, meleeMul: 1.4,
  },
  {
    id: 'sr9', name: 'SR-9 이래디케이터', slot: 'primary', ammoType: 'rifle', weaponClass: 'SR',
    damage: 330, fireRate: 0.9, magSize: 5, reserveMags: 4, reloadTime: 3.4,
    spread: deg(4.0), adsSpread: deg(0.03), range: 700, automatic: false,
    recoil: deg(2.2), tracerColor: 0xd8f4ff,
    falloffStart: 300, falloffEnd: 700, falloffMin: 0.85, adsZoom: 4, scope: true, meleeMul: 1.6,
  },
  {
    id: 'las16', name: 'LAS-16 사이드', slot: 'primary', ammoType: 'energy', weaponClass: 'AR',
    damage: 28, fireRate: 16, magSize: 60, reserveMags: 4, reloadTime: 3.2,
    spread: deg(1.6), adsSpread: deg(0.4), range: 160, automatic: true,
    projectileSpeed: 180, recoil: deg(0.12), tracerColor: 0x4af0ff,
    falloffStart: 60, falloffEnd: 160, falloffMin: 0.6, meleeMul: 1.2,
  },
  {
    id: 'p2', name: 'P-2 피스메이커', slot: 'secondary', ammoType: 'pistol', weaponClass: 'PISTOL',
    damage: 45, fireRate: 6, magSize: 15, reserveMags: 5, reloadTime: 1.6,
    spread: deg(1.3), adsSpread: deg(0.4), range: 120, automatic: false,
    recoil: deg(0.6), tracerColor: 0xffe3a0,
    falloffStart: 20, falloffEnd: 70, falloffMin: 0.5,
  },
  {
    id: 'p19', name: 'P-19 리디머', slot: 'secondary', ammoType: 'pistol', weaponClass: 'PISTOL',
    damage: 30, fireRate: 18, magSize: 31, reserveMags: 5, reloadTime: 1.9,
    spread: deg(2.6), adsSpread: deg(1.1), range: 90, automatic: true,
    recoil: deg(0.3), tracerColor: 0xffe3a0,
    falloffStart: 15, falloffEnd: 45, falloffMin: 0.4,   // machine pistol: SMG-like falloff
  },
];

export const WEAPON_DEF_MAP: ReadonlyMap<string, WeaponDef> = new Map(WEAPON_DEFS.map((w) => [w.id, w]));

export function getWeaponDef(weaponId: string): WeaponDef | undefined {
  return WEAPON_DEF_MAP.get(weaponId);
}

/** Damage multiplier at `distance` meters for `def` (1 when the def has no falloff). */
export function damageFalloff(def: WeaponDef, distance: number): number {
  const start = def.falloffStart, end = def.falloffEnd;
  if (start === undefined || end === undefined || end <= start) return 1;
  const min = def.falloffMin ?? 0.5;
  if (distance <= start) return 1;
  if (distance >= end) return min;
  return 1 - ((distance - start) / (end - start)) * (1 - min);
}
