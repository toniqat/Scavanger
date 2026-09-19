import type { UniqueWeaponKind, WeaponClass, WeaponDef, WeaponGrade } from '@/shared';
import {
  AMMO_FOR_CLASS, MELEE_STOCK_MUL_DEFAULT, WEAPON_GRADE_DAMAGE_STEP, WEAPON_GRADE_DURABILITY_STEP, WEAPON_GRADE_ROMAN,
  UNIQUE_WEAPON_IDS, UNIQUE_WEAPON_LABEL_KO, csvRows,
} from '@/shared';
import { SOCKET_SLOTS, numberList } from '@/shared';   // 2026-09-14 (gun balance): family sockets · grade handling

/*
 * The weapon numbers come from `data/weapons.csv` (the six families at grade I) and `data/weapons_unique.csv`
 * (the six mythic uniques). This file holds no table — only the code that moves those two csv files into
 * `WeaponDef`, and the grade-step arithmetic.
 */

const deg = (d: number): number => (d * Math.PI) / 180;

/** Drops the `undefined` keys an empty cell leaves, so the def is shaped exactly like one without them. */
function compact<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

/** Korean label per weapon archetype (HUD / tooltips). */
export const WEAPON_CLASS_LABEL_KO: Readonly<Record<WeaponClass, string>> = {
  AR: '돌격소총', SMG: '기관단총', SR: '저격소총', DMR: '지정사수소총', SG: '산탄총', PISTOL: '권총',
};

/** Short class tag for compact UI (weapon panel, tooltips). */
export const WEAPON_CLASS_SHORT: Readonly<Record<WeaponClass, string>> = {
  SMG: 'SMG', AR: 'AR', SG: 'SG', SR: 'SR', DMR: 'DMR', PISTOL: 'HG',
};

/** Every archetype, in `WEAPON_CLASS_LABEL_KO` order — the values `data/weapons.csv`'s `class` column takes. */
export const WEAPON_CLASSES: readonly WeaponClass[] = ['AR', 'SMG', 'SR', 'DMR', 'SG', 'PISTOL'];

/** The family rows of `data/weapons.csv` (grade I). */
const WEAPON_ROWS = csvRows('weapons.csv');

/** Base max durability (shots) per class at grade I; +WEAPON_GRADE_DURABILITY_STEP per grade above. */
export const WEAPON_BASE_DURABILITY: Readonly<Record<WeaponClass, number>> = (() => {
  const out = {} as Record<WeaponClass, number>;
  for (const r of WEAPON_ROWS) out[r.enum('class', WEAPON_CLASSES)] = r.int('baseDurability', { min: 1 });
  return out;
})();

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
 * Stock melee multiplier (the buttstock). Every weapon deals the same base `MELEE_DAMAGE`; only primaries
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
const FAMILY_DEFS: readonly FamilyDef[] = WEAPON_ROWS.map((r) => {
  const weaponClass = r.enum('class', WEAPON_CLASSES);
  return compact({
    id: r.str('id'), name: WEAPON_CLASS_LABEL_KO[weaponClass], weaponClass,
    slot: r.enum('slot', ['primary', 'secondary'] as const),
    damage: r.num('damage', { min: 0 }),
    pellets: r.optNum('pellets', { min: 1 }),
    fireRate: r.num('fireRate', { min: 0 }),
    magSize: r.int('magSize', { min: 1 }),
    reserveMags: r.int('reserveMags', { min: 0 }),
    reloadTime: r.num('reloadTime', { min: 0 }),
    spread: deg(r.num('spreadDeg', { min: 0 })),
    adsSpread: deg(r.num('adsSpreadDeg', { min: 0 })),
    range: r.num('range', { min: 0 }),
    automatic: r.bool('automatic'),
    recoil: deg(r.num('recoilDeg', { min: 0 })),
    tracerColor: r.num('tracerColor'),
    falloffStart: r.optNum('falloffStart'),
    falloffEnd: r.optNum('falloffEnd'),
    falloffMin: r.optNum('falloffMin', { min: 0, max: 1 }),
    adsZoom: r.optNum('adsZoom', { min: 1 }),
    scope: r.has('scope') ? r.bool('scope') : undefined,
    meleeMul: r.optNum('meleeMul', { min: 0 }),
    // 2026-09-14 (gun balance): accepted sockets (empty = all) · muzzle velocity · bullet drop — weapons/ reads them
    sockets: r.has('sockets') ? r.enumList('sockets', SOCKET_SLOTS) : undefined,
    projectileSpeed: r.optNum('projectileSpeed', { min: 0 }),
    bulletGravity: r.optNum('bulletGravity', { min: 0 }),
  });
});

/** Family ids in definition order (`ar`, `smg`, `sg`, `dmr`, `sr`, `hg`). */
export const WEAPON_FAMILIES: readonly string[] = FAMILY_DEFS.map((f) => f.id);

export const WEAPON_GRADES: readonly WeaponGrade[] = [1, 2, 3, 4, 5];

/* ── 2026-09-14 gun balance: per-family handling numbers · grade handling multipliers ─── */
/** Per-family numbers that are not `WeaponDef` fields (`data/weapons.csv`) — `WeaponStats.baseWeaponStats` reads them. */
export interface WeaponFamilyTuning {
  /** ADS time (s) at handling ×1 (grade V); the grade multiplier is applied on top. */
  readonly adsTime: number;
  /** Sustained-fire bloom added per shot (bloom is clamped 0..1). */
  readonly bloomPerShot: number;
  /** Spread × (1 + bloom × this). */
  readonly bloomSpread: number;
  /** Fire rate + this fraction per grade above I (SMG · SG; 0 = flat). */
  readonly fireRateGradeStep: number;
  /** Bloom recovered per second. */
  readonly bloomDecay: number;
}

/** Family id (`smg`) → its tuning row. */
export const WEAPON_FAMILY_TUNING: ReadonlyMap<string, WeaponFamilyTuning> = new Map(WEAPON_ROWS.map((r) => [r.str('id'), {
  adsTime: r.num('adsTime', { min: 0 }),
  bloomPerShot: r.num('bloomPerShot', { min: 0, max: 1 }),
  bloomSpread: r.num('bloomSpread', { min: 0 }),
  fireRateGradeStep: r.num('fireRateGradeStep', { min: 0 }),
  bloomDecay: r.num('bloomDecay', { min: 0 }),
}]));

/** Tuning row of a graded def's family (undefined for uniques / unknown families). */
export function weaponFamilyTuning(def: WeaponDef): WeaponFamilyTuning | undefined {
  return isUniqueWeapon(def) ? undefined : WEAPON_FAMILY_TUNING.get(weaponFamilyOf(def));
}

/**
 * Handling multiplier per grade (`data/tables.csv` `WEAPON_GRADE_HANDLING_MUL`, index 0 = grade I … 4 = V; user decision
 * ×1.6 · 1.45 · 1.3 · 1.15 · 1.0). `buildGrade` bakes it into spread / ADS spread / recoil; `baseWeaponStats` applies it
 * to ADS time and `swayMul`. Sockets multiply on top.
 */
export const WEAPON_GRADE_HANDLING_MUL: readonly number[] = numberList('tables.csv', 'WEAPON_GRADE_HANDLING_MUL');

/** Handling multiplier of a def (1 for uniques — they are never graded). */
export function weaponHandlingMul(def: WeaponDef): number {
  if (isUniqueWeapon(def)) return 1;
  return WEAPON_GRADE_HANDLING_MUL[gradeOf(def) - 1] ?? 1;
}

/* ── grade builder ────────────────────────────────────────────────────────── */
function buildGrade(base: FamilyDef, grade: WeaponGrade): WeaponDef {
  const step = grade - 1;
  const baseDurability = WEAPON_BASE_DURABILITY[base.weaponClass];
  // 2026-09-14: grade handling (spread · ADS spread · recoil) and the per-family fire-rate step (SMG · SG)
  const handling = WEAPON_GRADE_HANDLING_MUL[step] ?? 1;
  const rateStep = WEAPON_FAMILY_TUNING.get(base.id)?.fireRateGradeStep ?? 0;
  return {
    ...base,
    id: weaponIdForGrade(base.id, grade),
    name: `${base.name} ${WEAPON_GRADE_ROMAN[step]}`,
    ammoType: AMMO_FOR_CLASS[base.weaponClass],
    fireRate: Math.round(base.fireRate * (1 + rateStep * step) * 100) / 100,
    spread: base.spread * handling,
    adsSpread: base.adsSpread * handling,
    recoil: base.recoil * handling,
    damage: Math.round(base.damage * (1 + WEAPON_GRADE_DAMAGE_STEP * step)),
    maxDurability: Math.round(baseDurability * (1 + WEAPON_GRADE_DURABILITY_STEP * step)),
    grade,
    family: base.id,
  };
}

/* ── unique weapons (Phase 6, 2026-09-06) — data/weapons_unique.csv ───────── */
export type UniqueWeaponId = (typeof UNIQUE_WEAPON_IDS)[number];

/** The rows of `data/weapons_unique.csv`. */
const UNIQUE_ROWS = csvRows('weapons_unique.csv');

/**
 * 2026-09-15 (user's decision): a unique's name is **the nickname alone** (`인페르노` — it was
 * `「인페르노」 화염방사기`). The kind label (`UNIQUE_WEAPON_LABEL_KO`) is out of the name and the UI shows it
 * separately.
 */
const uniqueName = (nick: string): string => nick;

/** The keys of `UNIQUE_WEAPON_LABEL_KO` = the unique behaviour kinds. The csv's `kind` column takes them. */
const UNIQUE_KINDS = Object.keys(UNIQUE_WEAPON_LABEL_KO) as UniqueWeaponKind[];

/**
 * The six uniques — **mythic** rarity since 2026-09-16 (the item rarity is written in `weaponItemDef`,
 * `ItemDefs.ts`; `weapons_unique.csv` has no `rarity` column). `grade: 5` here is bookkeeping, not a rarity:
 * it is the grade-V slot the grade-keyed tables and the repair fallback (`Salvage.ts`) need. No `family`
 * (they are their own family, `buildGrades` never touches them), a dedicated `ammoType` (never
 * `AMMO_FOR_CLASS`), `altFire` (RMB = alternative fire, no ADS) on every one (2026-09-14: the bow too — RMB
 * cancels its draw). A csv cell
 * like `=FLAME_DPS` points straight at the constant in `data/constants.csv` — the behaviour code
 * (`src/weapons/unique/*`) reads the same constant, so the number never splits in two.
 * `weaponClass` is csv bookkeeping only — 2026-09-15 (user's decision): uniques get no
 * shooting-skill bonus / XP (weapons/ · progression/ check `def.unique`) and their kills are not class kills.
 *
 * Continuous weapons (flame / shock arc): `damage` is damage **per second**, `fireRate` is a tick hint
 * (weapons applies `damage × dt`), and `ammoPerSec` replaces per-shot ammo. `spread` is the LMB cone
 * half-angle, `adsSpread` the RMB jet half-angle for the flamethrower.
 */
export const UNIQUE_WEAPON_DEFS: readonly WeaponDef[] = UNIQUE_ROWS.map((r) => compact({
  id: r.str('id'),
  name: uniqueName(r.str('nickname')),
  slot: r.enum('slot', ['primary', 'secondary'] as const),
  weaponClass: r.enum('class', WEAPON_CLASSES),
  unique: r.enum('kind', UNIQUE_KINDS),
  altFire: r.bool('altFire'),
  ammoType: r.str('ammoType') as WeaponDef['ammoType'],
  grade: 5 as WeaponGrade,
  maxDurability: r.int('maxDurability', { min: 1 }),
  damage: r.num('damage', { min: 0 }),
  altDamage: r.optNum('altDamage', { min: 0 }),
  ammoPerSec: r.optNum('ammoPerSec', { min: 0 }),
  chargeTime: r.optNum('chargeTime', { min: 0 }),
  fireRate: r.num('fireRate', { min: 0 }),
  magSize: r.int('magSize', { min: 1 }),
  reserveMags: r.int('reserveMags', { min: 0 }),
  reloadTime: r.num('reloadTime', { min: 0 }),
  spread: deg(r.num('spreadDeg', { min: 0 })),
  adsSpread: deg(r.num('adsSpreadDeg', { min: 0 })),
  range: r.num('range', { min: 0 }),
  automatic: r.bool('automatic'),
  projectileSpeed: r.optNum('projectileSpeed', { min: 0 }),
  bulletGravity: r.optNum('bulletGravity', { min: 0 }),
  recoil: deg(r.num('recoilDeg', { min: 0 })),
  tracerColor: r.num('tracerColor'),
  falloffStart: r.optNum('falloffStart'),
  falloffEnd: r.optNum('falloffEnd'),
  falloffMin: r.optNum('falloffMin', { min: 0, max: 1 }),
  adsZoom: r.optNum('adsZoom', { min: 1 }),
  meleeMul: r.optNum('meleeMul', { min: 0 }),
}));

/**
 * Generous max durability per unique (shots / seconds of spray for the continuous ones).
 * Uniques are never graded, so this is the final number (`WeaponStats` never scales it).
 */
export const UNIQUE_WEAPON_DURABILITY: Readonly<Record<string, number>> =
  Object.fromEntries(UNIQUE_WEAPON_DEFS.map((d) => [d.id, d.maxDurability ?? 0]));

/** Fixed magazine per unique (tank / cell pack / holder / quiver / tube / half belt). */
export const UNIQUE_WEAPON_MAG: Readonly<Record<string, number>> =
  Object.fromEntries(UNIQUE_WEAPON_DEFS.map((d) => [d.id, d.magSize]));

/* When the csv's unique list does not match the `UNIQUE_WEAPON_IDS` contract, it is caught right here. */
for (const id of UNIQUE_WEAPON_IDS) {
  if (!UNIQUE_WEAPON_DEFS.some((d) => d.id === id)) {
    UNIQUE_ROWS[0]?.report('id', `data/weapons_unique.csv 에 '${id}' 줄이 없다`);
  }
}

/**
 * The item-side presentation (grid size · icon · price · weight · description). It sits on the same csv row as
 * the weapon numbers, so `items/ItemDefs.ts` reads this table to build the `ItemDef`.
 */
export interface WeaponItemMeta {
  width: number; height: number; icon: string; value: number; weight: number; description: string;
}
const metaOf = (rows: readonly ReturnType<typeof csvRows>[number][]): Map<string, WeaponItemMeta> =>
  new Map(rows.map((r) => [r.str('id'), {
    width: r.int('width', { min: 1 }), height: r.int('height', { min: 1 }),
    icon: r.str('icon'), value: r.int('value', { min: 0 }),
    weight: r.num('weight', { min: 0 }), description: r.str('description'),
  }]));

/** Family id (`ar`) → the item presentation. `value` is the grade-I price. */
export const WEAPON_FAMILY_ITEM_META: ReadonlyMap<string, WeaponItemMeta> = metaOf(WEAPON_ROWS);
/** Unique id (`u_flame`) → the item presentation. */
export const UNIQUE_WEAPON_ITEM_META: ReadonlyMap<string, WeaponItemMeta> = metaOf(UNIQUE_ROWS);

export const UNIQUE_WEAPON_DEF_MAP: ReadonlyMap<string, WeaponDef> = new Map(UNIQUE_WEAPON_DEFS.map((w) => [w.id, w]));

/** True for the six mythic uniques (`WeaponDef.unique` set). Never graded, never socketed. */
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
