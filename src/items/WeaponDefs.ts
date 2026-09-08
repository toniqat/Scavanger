import type { UniqueWeaponKind, WeaponClass, WeaponDef, WeaponGrade } from '@/shared';
import {
  AMMO_FOR_CLASS, MELEE_STOCK_MUL_DEFAULT, WEAPON_GRADE_DAMAGE_STEP, WEAPON_GRADE_DURABILITY_STEP, WEAPON_GRADE_ROMAN,
  UNIQUE_WEAPON_IDS, UNIQUE_WEAPON_LABEL_KO, csvRows,
} from '@/shared';

/*
 * 무기 수치의 원본은 `data/weapons.csv` (6계열 등급 I) 과 `data/weapons_unique.csv` (전설 유니크 6종) 이다.
 * 이 파일에는 표가 없고, 그 두 csv 를 WeaponDef 로 옮기는 코드와 등급 계단 계산만 있다.
 */

const deg = (d: number): number => (d * Math.PI) / 180;

/** 빈 칸에서 온 `undefined` 키를 지운다 — 선택 필드가 없는 def 와 똑같은 모양이 되도록. */
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

/** Every archetype, in `WEAPON_CLASS_LABEL_KO` order — the values `data/weapons.csv` 의 `class` 칸이 받는다. */
export const WEAPON_CLASSES: readonly WeaponClass[] = ['AR', 'SMG', 'SR', 'DMR', 'SG', 'PISTOL'];

/** `data/weapons.csv` 의 계열 줄 (등급 I). */
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
  });
});

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

/* ── unique weapons (Phase 6, 2026-09-06) — data/weapons_unique.csv ───────── */
export type UniqueWeaponId = (typeof UNIQUE_WEAPON_IDS)[number];

/** `data/weapons_unique.csv` 의 줄들. */
const UNIQUE_ROWS = csvRows('weapons_unique.csv');

/** 「이름」 + kind label (`「인페르노」 화염방사기`). */
const uniqueName = (nick: string, kind: UniqueWeaponKind): string => `「${nick}」 ${UNIQUE_WEAPON_LABEL_KO[kind]}`;

/** `UNIQUE_WEAPON_LABEL_KO` 의 키 = 유니크 동작 종류. csv 의 `kind` 칸이 받는다. */
const UNIQUE_KINDS = Object.keys(UNIQUE_WEAPON_LABEL_KO) as UniqueWeaponKind[];

/**
 * The six legendary uniques. `grade: 5` (legendary rarity / repair cost), no `family` (they are their own
 * family, `buildGrades` never touches them), a dedicated `ammoType` (never `AMMO_FOR_CLASS`), `altFire`
 * (RMB = alternative fire, no ADS) on every one except the bow. csv 의 `=FLAME_DPS` 같은 칸은
 * `data/constants.csv` 의 상수를 그대로 가리킨다 — 동작 코드(`src/weapons/unique/*`)도 같은 상수를 보므로
 * 수치가 두 군데로 갈라지지 않는다. `weaponClass` only picks the shooting skill.
 *
 * Continuous weapons (flame / shock arc): `damage` is damage **per second**, `fireRate` is a tick hint
 * (weapons applies `damage × dt`), and `ammoPerSec` replaces per-shot ammo. `spread` is the LMB cone
 * half-angle, `adsSpread` the RMB jet half-angle for the flamethrower.
 */
export const UNIQUE_WEAPON_DEFS: readonly WeaponDef[] = UNIQUE_ROWS.map((r) => compact({
  id: r.str('id'),
  name: uniqueName(r.str('nickname'), r.enum('kind', UNIQUE_KINDS)),
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

/* csv 의 유니크 목록이 `UNIQUE_WEAPON_IDS` 계약과 어긋나면 그 자리에서 잡는다. */
for (const id of UNIQUE_WEAPON_IDS) {
  if (!UNIQUE_WEAPON_DEFS.some((d) => d.id === id)) {
    UNIQUE_ROWS[0]?.report('id', `data/weapons_unique.csv 에 '${id}' 줄이 없다`);
  }
}

/**
 * 아이템 쪽 표현 (격자 크기 · 아이콘 · 가격 · 무게 · 설명). 무기 수치와 같은 줄에 있으므로
 * `items/ItemDefs.ts` 가 이 표를 읽어 `ItemDef` 를 만든다.
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

/** 계열 id (`ar`) → 아이템 표현. `value` 는 등급 I 가격이다. */
export const WEAPON_FAMILY_ITEM_META: ReadonlyMap<string, WeaponItemMeta> = metaOf(WEAPON_ROWS);
/** 유니크 id (`u_flame`) → 아이템 표현. */
export const UNIQUE_WEAPON_ITEM_META: ReadonlyMap<string, WeaponItemMeta> = metaOf(UNIQUE_ROWS);

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
