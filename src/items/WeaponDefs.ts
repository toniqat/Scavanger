import type { UniqueWeaponKind, WeaponClass, WeaponDef, WeaponGrade } from '@/shared';
import {
  AMMO_FOR_CLASS, MELEE_STOCK_MUL_DEFAULT, WEAPON_GRADE_DAMAGE_STEP, WEAPON_GRADE_DURABILITY_STEP, WEAPON_GRADE_ROMAN,
  UNIQUE_WEAPON_IDS, UNIQUE_WEAPON_LABEL_KO,
  FLAME_RANGE, FLAME_CONE_DEG, FLAME_DPS, FLAME_ALT_CONE_DEG, FLAME_ALT_DPS, FLAME_FUEL_PER_SEC,
  SHOCK_RANGE, SHOCK_CONE_DEG, SHOCK_DPS, SHOCK_CELL_PER_SEC, SHOCK_CHARGE_TIME, SHOCK_CHARGE_DAMAGE, SHOCK_CHARGE_RANGE,
  SHURIKEN_DAMAGE, SHURIKEN_SPEED, SHURIKEN_FIRE_RATE, SHURIKEN_TRIPLE_SPREAD_DEG,
  BOW_DAMAGE, BOW_RANGE, BOW_FIRE_RATE, BOW_PROJECTILE_SPEED,
  BAZOOKA_DAMAGE, BAZOOKA_SPEED, BAZOOKA_ALT_DAMAGE, BAZOOKA_FIRE_RATE,
  MINIGUN_SPINUP_TIME, MINIGUN_DAMAGE, MINIGUN_FIRE_RATE, MINIGUN_SPREAD_DEG,
} from '@/shared';

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

/** Family (base weapon id) of a def: `ar` for `ar_g3`; a def without `family` is its own family. */
export function weaponFamilyOf(def: WeaponDef): string {
  return def.family ?? def.id;
}

/** Grade I..V of a def (undefined → 1). */
export function gradeOf(def: WeaponDef): WeaponGrade {
  return def.grade ?? 1;
}

/** Weapon def id for a family at a grade (`ar`, `ar_g2` …). */
export function weaponIdForGrade(family: string, grade: WeaponGrade): string {
  return grade <= 1 ? family : `${family}_g${grade}`;
}

/* ── family baselines (grade I) ───────────────────────────────────────────── */
/** Grade-I ballistics. `ammoType` is derived from the class via AMMO_FOR_CLASS. */
type FamilyDef = Omit<WeaponDef, 'ammoType' | 'grade' | 'maxDurability' | 'family' | 'weaponClass'> & { weaponClass: WeaponClass };

/**
 * Stock melee multiplier (개머리판). Every weapon deals the same base `MELEE_DAMAGE`; only primaries
 * with a real stock swing harder. Pistols have none → `MELEE_STOCK_MUL_DEFAULT`.
 */
export function meleeMulOf(def: WeaponDef): number {
  return def.meleeMul ?? MELEE_STOCK_MUL_DEFAULT;
}

/**
 * Weapon families (2026-09-07: exactly one per class, named after the class itself — `돌격소총 III`).
 * Each family is expanded into grades I..V by `buildGrades` (ids `<family>` and `<family>_g2..5`).
 * `projectileSpeed` undefined → hitscan.
 *
 * Damage falloff: ×1 up to `falloffStart`, linear down to `falloffMin` at `falloffEnd`
 * (distance from muzzle to hit point). Hip spreads are deliberately loose — stance/ADS
 * multipliers in WeaponSystem tighten them (stand-hip 1.0 … prone-ADS 0.22).
 */
const FAMILY_DEFS: readonly FamilyDef[] = [
  {
    id: 'ar', name: WEAPON_CLASS_LABEL_KO.AR, slot: 'primary', weaponClass: 'AR',
    damage: 60, fireRate: 10, magSize: 45, reserveMags: 6, reloadTime: 2.4,
    spread: deg(1.4), adsSpread: deg(0.3), range: 220, automatic: true,
    recoil: deg(0.35), tracerColor: 0xffd27a,
    falloffStart: 60, falloffEnd: 220, falloffMin: 0.6, meleeMul: 1.35,
  },
  {
    id: 'smg', name: WEAPON_CLASS_LABEL_KO.SMG, slot: 'primary', weaponClass: 'SMG',
    damage: 32, fireRate: 14, magSize: 40, reserveMags: 5, reloadTime: 1.9,
    spread: deg(1.9), adsSpread: deg(0.55), range: 120, automatic: true,
    recoil: deg(0.24), tracerColor: 0xffe3a0,
    falloffStart: 15, falloffEnd: 45, falloffMin: 0.4, meleeMul: 1.15,
  },
  {
    id: 'sg', name: WEAPON_CLASS_LABEL_KO.SG, slot: 'primary', weaponClass: 'SG',
    damage: 22, pellets: 8, fireRate: 1.3, magSize: 8, reserveMags: 4, reloadTime: 3.0,
    spread: deg(5.0), adsSpread: deg(3.5), range: 42, automatic: false,
    recoil: deg(1.4), tracerColor: 0xffb070,
    falloffStart: 8, falloffEnd: 30, falloffMin: 0.25, meleeMul: 1.5,
  },
  {
    id: 'dmr', name: WEAPON_CLASS_LABEL_KO.DMR, slot: 'primary', weaponClass: 'DMR',
    damage: 120, fireRate: 3, magSize: 15, reserveMags: 5, reloadTime: 2.6,
    spread: deg(1.2), adsSpread: deg(0.08), range: 420, automatic: false,
    recoil: deg(0.9), tracerColor: 0xa8e6ff,
    falloffStart: 120, falloffEnd: 400, falloffMin: 0.75, adsZoom: 1.6, meleeMul: 1.4,
  },
  {
    id: 'sr', name: WEAPON_CLASS_LABEL_KO.SR, slot: 'primary', weaponClass: 'SR',
    damage: 330, fireRate: 0.9, magSize: 5, reserveMags: 4, reloadTime: 3.4,
    spread: deg(4.0), adsSpread: deg(0.03), range: 700, automatic: false,
    recoil: deg(2.2), tracerColor: 0xd8f4ff,
    falloffStart: 300, falloffEnd: 700, falloffMin: 0.85, adsZoom: 4, scope: true, meleeMul: 1.6,
  },
  {
    id: 'hg', name: WEAPON_CLASS_LABEL_KO.PISTOL, slot: 'secondary', weaponClass: 'PISTOL',
    damage: 45, fireRate: 6, magSize: 15, reserveMags: 5, reloadTime: 1.6,
    spread: deg(1.3), adsSpread: deg(0.4), range: 120, automatic: false,
    recoil: deg(0.6), tracerColor: 0xffe3a0,
    falloffStart: 20, falloffEnd: 70, falloffMin: 0.5,
  },
];

/** Family ids in definition order (`ar`, `smg`, `sg`, `dmr`, `sr`, `hg`). */
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

/* ── unique weapons (Phase 6, 2026-09-06) ─────────────────────────────────── */
export type UniqueWeaponId = (typeof UNIQUE_WEAPON_IDS)[number];

/**
 * Generous max durability per unique (shots / seconds of spray for the continuous ones).
 * Uniques are never graded, so this is the final number (`WeaponStats` never scales it).
 */
export const UNIQUE_WEAPON_DURABILITY: Readonly<Record<UniqueWeaponId, number>> = {
  u_flame: 1500, u_shock: 1200, u_shuriken: 900, u_bow: 700, u_bazooka: 320, u_minigun: 3000,
};

/** Fixed magazine per unique (tank / cell pack / holder / quiver / tube / half belt). No constant exists for these. */
export const UNIQUE_WEAPON_MAG: Readonly<Record<UniqueWeaponId, number>> = {
  u_flame: 120, u_shock: 48, u_shuriken: 10, u_bow: 12, u_bazooka: 1, u_minigun: 150,
};

/** 「이름」 + kind label (`「인페르노」 화염방사기`). */
const uniqueName = (nick: string, kind: UniqueWeaponKind): string => `「${nick}」 ${UNIQUE_WEAPON_LABEL_KO[kind]}`;

/**
 * The six legendary uniques. `grade: 5` (legendary rarity / repair cost), no `family` (they are their own
 * family, `buildGrades` never touches them), a dedicated `ammoType` (never `AMMO_FOR_CLASS`), `altFire`
 * (RMB = alternative fire, no ADS) on every one except the bow. Numbers are the `FLAME_* / SHOCK_* /
 * SHURIKEN_* / BOW_* / BAZOOKA_* / MINIGUN_*` constants; `weaponClass` only picks the shooting skill
 * (flamethrower / minigun → AR, shockgun / bow → DMR, shuriken → SMG, bazooka → SR). Behaviour lives in
 * `src/weapons/unique/*`; these defs only carry data.
 *
 * Continuous weapons (flame / shock arc): `damage` is damage **per second**, `fireRate` is a tick hint
 * (weapons applies `damage × dt`), and `ammoPerSec` replaces per-shot ammo. `spread` is the LMB cone
 * half-angle, `adsSpread` the RMB jet half-angle for the flamethrower.
 */
export const UNIQUE_WEAPON_DEFS: readonly WeaponDef[] = [
  {
    id: 'u_flame', name: uniqueName('인페르노', 'flamethrower'), slot: 'primary', weaponClass: 'AR', unique: 'flamethrower', altFire: true,
    ammoType: 'fuel', grade: 5, maxDurability: UNIQUE_WEAPON_DURABILITY.u_flame,
    damage: FLAME_DPS, altDamage: FLAME_ALT_DPS, ammoPerSec: FLAME_FUEL_PER_SEC,
    fireRate: 10, magSize: UNIQUE_WEAPON_MAG.u_flame, reserveMags: 2, reloadTime: 3.2,
    spread: deg(FLAME_CONE_DEG / 2), adsSpread: deg(FLAME_ALT_CONE_DEG / 2), range: FLAME_RANGE, automatic: true,
    recoil: deg(0.05), tracerColor: 0xff7a2a, meleeMul: 1.3,
  },
  {
    id: 'u_shock', name: uniqueName('테슬라 코일', 'shockgun'), slot: 'primary', weaponClass: 'DMR', unique: 'shockgun', altFire: true,
    ammoType: 'cell', grade: 5, maxDurability: UNIQUE_WEAPON_DURABILITY.u_shock,
    damage: SHOCK_DPS, altDamage: SHOCK_CHARGE_DAMAGE, chargeTime: SHOCK_CHARGE_TIME, ammoPerSec: SHOCK_CELL_PER_SEC,
    fireRate: 1 / SHOCK_CHARGE_TIME, magSize: UNIQUE_WEAPON_MAG.u_shock, reserveMags: 2, reloadTime: 2.8,
    spread: deg(SHOCK_CONE_DEG / 2), adsSpread: deg(0.1), range: SHOCK_RANGE, automatic: true,
    recoil: deg(0.4), tracerColor: 0x9fe8ff,
    falloffStart: SHOCK_RANGE, falloffEnd: SHOCK_CHARGE_RANGE, falloffMin: 0.7, meleeMul: 1.2,
  },
  {
    id: 'u_shuriken', name: uniqueName('카게', 'shuriken'), slot: 'primary', weaponClass: 'SMG', unique: 'shuriken', altFire: true,
    ammoType: 'shuriken', grade: 5, maxDurability: UNIQUE_WEAPON_DURABILITY.u_shuriken,
    damage: SHURIKEN_DAMAGE, fireRate: SHURIKEN_FIRE_RATE, magSize: UNIQUE_WEAPON_MAG.u_shuriken, reserveMags: 3, reloadTime: 1.6,
    spread: deg(0.6), adsSpread: deg(SHURIKEN_TRIPLE_SPREAD_DEG), range: 70, automatic: false,
    projectileSpeed: SHURIKEN_SPEED, recoil: deg(0.15), tracerColor: 0xd8dde6,
    falloffStart: 30, falloffEnd: 70, falloffMin: 0.6, meleeMul: 1.8,
  },
  {
    // the only unique with ADS (no RMB alt fire): DMR cadence, shorter reach than a legendary SR
    id: 'u_bow', name: uniqueName('롱혼', 'bow'), slot: 'primary', weaponClass: 'DMR', unique: 'bow', altFire: false,
    ammoType: 'arrow', grade: 5, maxDurability: UNIQUE_WEAPON_DURABILITY.u_bow,
    damage: BOW_DAMAGE, fireRate: BOW_FIRE_RATE, magSize: UNIQUE_WEAPON_MAG.u_bow, reserveMags: 2, reloadTime: 2.2,
    spread: deg(1.0), adsSpread: deg(0.08), range: BOW_RANGE, automatic: false,
    projectileSpeed: BOW_PROJECTILE_SPEED, recoil: deg(0.5), tracerColor: 0xc9a86a, adsZoom: 1.6,
    falloffStart: 80, falloffEnd: BOW_RANGE, falloffMin: 0.75, meleeMul: 1.1,
  },
  {
    id: 'u_bazooka', name: uniqueName('해머헤드', 'bazooka'), slot: 'primary', weaponClass: 'SR', unique: 'bazooka', altFire: true,
    ammoType: 'rocket', grade: 5, maxDurability: UNIQUE_WEAPON_DURABILITY.u_bazooka,
    damage: BAZOOKA_DAMAGE, altDamage: BAZOOKA_ALT_DAMAGE,
    fireRate: BAZOOKA_FIRE_RATE, magSize: UNIQUE_WEAPON_MAG.u_bazooka, reserveMags: 3, reloadTime: 3.0,
    spread: deg(1.2), adsSpread: deg(0.5), range: 160, automatic: false,
    projectileSpeed: BAZOOKA_SPEED, recoil: deg(2.5), tracerColor: 0xffc060, meleeMul: 1.5,
  },
  {
    id: 'u_minigun', name: uniqueName('사이클론', 'minigun'), slot: 'primary', weaponClass: 'AR', unique: 'minigun', altFire: true,
    ammoType: 'belt', grade: 5, maxDurability: UNIQUE_WEAPON_DURABILITY.u_minigun,
    damage: MINIGUN_DAMAGE, chargeTime: MINIGUN_SPINUP_TIME,
    fireRate: MINIGUN_FIRE_RATE, magSize: UNIQUE_WEAPON_MAG.u_minigun, reserveMags: 1, reloadTime: 5.0,
    spread: deg(MINIGUN_SPREAD_DEG), adsSpread: deg(MINIGUN_SPREAD_DEG), range: 180, automatic: true,
    recoil: deg(0.2), tracerColor: 0xffd27a,
    falloffStart: 60, falloffEnd: 180, falloffMin: 0.55, meleeMul: 1.6,
  },
];

export const UNIQUE_WEAPON_DEF_MAP: ReadonlyMap<string, WeaponDef> = new Map(UNIQUE_WEAPON_DEFS.map((w) => [w.id, w]));

/** True for the six legendary uniques (`WeaponDef.unique` set). Never graded, never socketed. */
export function isUniqueWeapon(def: WeaponDef | undefined): def is WeaponDef & { unique: UniqueWeaponKind } {
  return !!def?.unique;
}

/** True when `id` is one of `UNIQUE_WEAPON_IDS`. */
export function isUniqueWeaponId(id: string): id is UniqueWeaponId {
  return (UNIQUE_WEAPON_IDS as readonly string[]).includes(id);
}

/**
 * Every weapon def: 6 families × 5 grades, ordered family-major (`ar`, `ar_g2`, … `hg_g5`),
 * followed by the six uniques (`u_flame` … `u_minigun`; not expanded by `buildGrade`).
 */
export const WEAPON_DEFS: readonly WeaponDef[] = [
  ...FAMILY_DEFS.flatMap((f) => WEAPON_GRADES.map((g) => buildGrade(f, g))),
  ...UNIQUE_WEAPON_DEFS,
];

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
