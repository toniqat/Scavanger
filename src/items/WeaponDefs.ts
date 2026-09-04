import type { WeaponDef } from '@/shared';

const deg = (d: number): number => (d * Math.PI) / 180;

/**
 * Weapon ballistics. Each entry is referenced from an ItemDef via `weaponId`
 * (item id = `wpn_<weaponId>`). `projectileSpeed` undefined → hitscan.
 */
export const WEAPON_DEFS: readonly WeaponDef[] = [
  {
    id: 'ar23', name: 'AR-23 리버레이터', slot: 'primary', ammoType: 'rifle',
    damage: 60, fireRate: 10, magSize: 45, reserveMags: 6, reloadTime: 2.4,
    spread: deg(0.9), adsSpread: deg(0.3), range: 220, automatic: true,
    recoil: deg(0.35), tracerColor: 0xffd27a,
  },
  {
    id: 'sg8', name: 'SG-8 퍼니셔', slot: 'primary', ammoType: 'shotgun',
    damage: 22, pellets: 8, fireRate: 1.3, magSize: 8, reserveMags: 4, reloadTime: 3.0,
    spread: deg(5.0), adsSpread: deg(3.5), range: 42, automatic: false,
    recoil: deg(1.4), tracerColor: 0xffb070,
  },
  {
    id: 'r63', name: 'R-63 딜리전스', slot: 'primary', ammoType: 'rifle',
    damage: 120, fireRate: 3, magSize: 15, reserveMags: 5, reloadTime: 2.6,
    spread: deg(0.6), adsSpread: deg(0.08), range: 420, automatic: false,
    recoil: deg(0.9), tracerColor: 0xa8e6ff,
  },
  {
    id: 'las16', name: 'LAS-16 사이드', slot: 'primary', ammoType: 'energy',
    damage: 28, fireRate: 16, magSize: 60, reserveMags: 4, reloadTime: 3.2,
    spread: deg(1.2), adsSpread: deg(0.4), range: 160, automatic: true,
    projectileSpeed: 180, recoil: deg(0.12), tracerColor: 0x4af0ff,
  },
  {
    id: 'p2', name: 'P-2 피스메이커', slot: 'secondary', ammoType: 'pistol',
    damage: 45, fireRate: 6, magSize: 15, reserveMags: 5, reloadTime: 1.6,
    spread: deg(1.0), adsSpread: deg(0.4), range: 120, automatic: false,
    recoil: deg(0.6), tracerColor: 0xffe3a0,
  },
  {
    id: 'p19', name: 'P-19 리디머', slot: 'secondary', ammoType: 'pistol',
    damage: 30, fireRate: 18, magSize: 31, reserveMags: 5, reloadTime: 1.9,
    spread: deg(2.4), adsSpread: deg(1.1), range: 90, automatic: true,
    recoil: deg(0.3), tracerColor: 0xffe3a0,
  },
];

export const WEAPON_DEF_MAP: ReadonlyMap<string, WeaponDef> = new Map(WEAPON_DEFS.map((w) => [w.id, w]));

export function getWeaponDef(weaponId: string): WeaponDef | undefined {
  return WEAPON_DEF_MAP.get(weaponId);
}
