import type { WeaponClass, WeaponDef, WeaponGrade } from '@/shared';
import { AMMO_FOR_CLASS, WEAPON_GRADE_DAMAGE_STEP, WEAPON_GRADE_DURABILITY_STEP, WEAPON_GRADE_ROMAN } from '@/shared';

const deg = (d: number): number => (d * Math.PI) / 180;

/** Korean label per weapon archetype (HUD / tooltips). */
export const WEAPON_CLASS_LABEL_KO: Readonly<Record<WeaponClass, string>> = {
  AR: '돌격소총', SMG: '기관단총', SR: '저격소총', DMR: '지정사수소총', SG: '산탄총', PISTOL: '권총',
};

/** Short class tag for compact UI (weapon panel, tooltips). */
export const WEAPON_CLASS_SHORT: Readonly<Record<WeaponClass, string>> = {
  SMG: 'SMG', AR: 'AR', SG: 'SG', SR: 'SR', DMR: 'DMR', PISTOL: 'HG',
};

/** Base max durability (shots) per class at grade I; +WEAPON_GRADE_DURABILITY_STEP per grade above. */
export const WEAPON_BASE_DURABILITY: Readonly<Record<WeaponClass, number>> = {
  AR: 500, SMG: 550, SG: 200, DMR: 250, SR: 120, PISTOL: 350,
};

/** Class of a weapon def; undefined → secondary slot is a pistol, everything else an AR. */
export function weaponClassOf(def: WeaponDef): WeaponClass {
  return def.weaponClass ?? (def.slot === 'secondary' ? 'PISTOL' : 'AR');
}

/** Family (base weapon id) of a def: `ar23` for `ar23_g3`; a def without `family` is its own family. */
export function weaponFamilyOf(def: WeaponDef): string {
  return def.family ?? def.id;
}

/** Grade I..V of a def (undefined → 1). */
export function gradeOf(def: WeaponDef): WeaponGrade {
  return def.grade ?? 1;
}

/** Weapon def id for a family at a grade (`ar23`, `ar23_g2` …). */
export function weaponIdForGrade(family: string, grade: WeaponGrade): string {
  return grade <= 1 ? family : `${family}_g${grade}`;
}

/* ── family baselines (grade I) ───────────────────────────────────────────── */
/** Grade-I ballistics. `ammoType` is derived from the class via AMMO_FOR_CLASS. */
type FamilyDef = Omit<WeaponDef, 'ammoType' | 'grade' | 'maxDurability' | 'family' | 'weaponClass'> & { weaponClass: WeaponClass };

/**
 * Weapon families. Each family is expanded into grades I..V by `buildGrades`
 * (ids `<family>` and `<family>_g2..5`). `projectileSpeed` undefined → hitscan.
 *
 * Damage falloff: ×1 up to `falloffStart`, linear down to `falloffMin` at `falloffEnd`
 * (distance from muzzle to hit point). Hip spreads are deliberately loose — stance/ADS
 * multipliers in WeaponSystem tighten them (stand-hip 1.0 … prone-ADS 0.22).
 */
const FAMILY_DEFS: readonly FamilyDef[] = [
  {
    id: 'ar23', name: 'AR-23 리버레이터', slot: 'primary', weaponClass: 'AR',
    damage: 60, fireRate: 10, magSize: 45, reserveMags: 6, reloadTime: 2.4,
    spread: deg(1.4), adsSpread: deg(0.3), range: 220, automatic: true,
    recoil: deg(0.35), tracerColor: 0xffd27a,
    falloffStart: 60, falloffEnd: 220, falloffMin: 0.6,
  },
  {
    id: 'smg37', name: 'SMG-37 디펜더', slot: 'primary', weaponClass: 'SMG',
    damage: 32, fireRate: 14, magSize: 40, reserveMags: 5, reloadTime: 1.9,
    spread: deg(1.9), adsSpread: deg(0.55), range: 120, automatic: true,
    recoil: deg(0.24), tracerColor: 0xffe3a0,
    falloffStart: 15, falloffEnd: 45, falloffMin: 0.4,
  },
  {
    id: 'sg8', name: 'SG-8 퍼니셔', slot: 'primary', weaponClass: 'SG',
    damage: 22, pellets: 8, fireRate: 1.3, magSize: 8, reserveMags: 4, reloadTime: 3.0,
    spread: deg(5.0), adsSpread: deg(3.5), range: 42, automatic: false,
    recoil: deg(1.4), tracerColor: 0xffb070,
    falloffStart: 8, falloffEnd: 30, falloffMin: 0.25,
  },
  {
    id: 'r63', name: 'R-63 딜리전스', slot: 'primary', weaponClass: 'DMR',
    damage: 120, fireRate: 3, magSize: 15, reserveMags: 5, reloadTime: 2.6,
    spread: deg(1.2), adsSpread: deg(0.08), range: 420, automatic: false,
    recoil: deg(0.9), tracerColor: 0xa8e6ff,
    falloffStart: 120, falloffEnd: 400, falloffMin: 0.75, adsZoom: 1.6,
  },
  {
    id: 'sr9', name: 'SR-9 이래디케이터', slot: 'primary', weaponClass: 'SR',
    damage: 330, fireRate: 0.9, magSize: 5, reserveMags: 4, reloadTime: 3.4,
    spread: deg(4.0), adsSpread: deg(0.03), range: 700, automatic: false,
    recoil: deg(2.2), tracerColor: 0xd8f4ff,
    falloffStart: 300, falloffEnd: 700, falloffMin: 0.85, adsZoom: 4, scope: true,
  },
  {
    // energy-styled AR: projectile "bolts", medium calibre in the v2 ammo model
    id: 'las16', name: 'LAS-16 사이드', slot: 'primary', weaponClass: 'AR',
    damage: 28, fireRate: 16, magSize: 60, reserveMags: 4, reloadTime: 3.2,
    spread: deg(1.6), adsSpread: deg(0.4), range: 160, automatic: true,
    projectileSpeed: 180, recoil: deg(0.12), tracerColor: 0x4af0ff,
    falloffStart: 60, falloffEnd: 160, falloffMin: 0.6,
  },
  {
    id: 'p2', name: 'P-2 피스메이커', slot: 'secondary', weaponClass: 'PISTOL',
    damage: 45, fireRate: 6, magSize: 15, reserveMags: 5, reloadTime: 1.6,
    spread: deg(1.3), adsSpread: deg(0.4), range: 120, automatic: false,
    recoil: deg(0.6), tracerColor: 0xffe3a0,
    falloffStart: 20, falloffEnd: 70, falloffMin: 0.5,
  },
  {
    id: 'p19', name: 'P-19 리디머', slot: 'secondary', weaponClass: 'PISTOL',
    damage: 30, fireRate: 18, magSize: 31, reserveMags: 5, reloadTime: 1.9,
    spread: deg(2.6), adsSpread: deg(1.1), range: 90, automatic: true,
    recoil: deg(0.3), tracerColor: 0xffe3a0,
    falloffStart: 15, falloffEnd: 45, falloffMin: 0.4,   // machine pistol: SMG-like falloff
  },
];

/** Family ids in definition order (`ar23`, `smg37`, `sg8`, `r63`, `sr9`, `las16`, `p2`, `p19`). */
export const WEAPON_FAMILIES: readonly string[] = FAMILY_DEFS.map((f) => f.id);

export const WEAPON_GRADES: readonly WeaponGrade[] = [1, 2, 3, 4, 5];

/* ── grade builder ────────────────────────────────────────────────────────── */
function buildGrade(base: FamilyDef, grade: WeaponGrade): WeaponDef {
  const step = grade - 1;
  const baseDurability = WEAPON_BASE_DURABILITY[base.weaponClass];
  return {
    ...base,
    id: weaponIdForGrade(base.id, grade),
    name: `${base.name} ${WEAPON_GRADE_ROMAN[step]}`,
    ammoType: AMMO_FOR_CLASS[base.weaponClass],
    damage: Math.round(base.damage * (1 + WEAPON_GRADE_DAMAGE_STEP * step)),
    maxDurability: Math.round(baseDurability * (1 + WEAPON_GRADE_DURABILITY_STEP * step)),
    grade,
    family: base.id,
  };
}

/** Every weapon def: 8 families × 5 grades, ordered family-major (`ar23`, `ar23_g2`, … `p19_g5`). */
export const WEAPON_DEFS: readonly WeaponDef[] = FAMILY_DEFS.flatMap((f) => WEAPON_GRADES.map((g) => buildGrade(f, g)));

export const WEAPON_DEF_MAP: ReadonlyMap<string, WeaponDef> = new Map(WEAPON_DEFS.map((w) => [w.id, w]));

export function getWeaponDef(weaponId: string): WeaponDef | undefined {
  return WEAPON_DEF_MAP.get(weaponId);
}

/** All grades of a family, grade I first (empty for an unknown family). */
export function weaponGradesOf(family: string): WeaponDef[] {
  return WEAPON_DEFS.filter((w) => weaponFamilyOf(w) === family);
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
