import type { AmmoType, ArmorDef, AttachmentDef, AttachmentEffects, BagDef, BoostKind, ItemCategory, ItemDef, MealDef, MediumDef, PouchDef, PrepDef, Rarity, SampleDef, SeedDef, SkillId, SoilDef, SoilTag, StrainDef, WeaponClass, WeaponDef, WeaponGrade } from '@/shared';
import {
  AMMO_STACK_ROUNDS, CATEGORY_COLOR, CATEGORY_ICON, CATEGORY_LABEL_KO, ENV_KINDS, MEAL_BUFFS,
  QUICK_SLOTS, QUICK_USABLE_CATEGORIES, RARITY_COLORS, RARITY_ORDER, SKILL_IDS, SOIL_TAGS, csvRows, keyTable, numberMap, rarityForGrade,
} from '@/shared';

/*
 * 아이템 수치의 원본은 `data/` 의 csv 다 — `items.csv`(수류탄 · 회복 · 귀중품 · 재료 · 약초 · 가젯),
 * `ammo.csv` · `attachments.csv` · `bags.csv` · `seeds.csv` · `books.csv` · `samples.csv` · `meals.csv`,
 * 무기는 `weapons.csv` / `weapons_unique.csv`, 방탄복은 `armor.csv`.
 * 이 파일에는 표가 없고 그 줄들을 `ItemDef` 로 옮기는 코드만 있다.
 *
 * `T` 는 `data/tuning.csv` (기능 폴더 안에서만 쓰는 스칼라) 조회기다.
 */
const T = /* data/tuning.csv */ keyTable('tuning.csv');
import type { WeaponItemMeta } from './WeaponDefs';
import { UNIQUE_WEAPON_ITEM_META, WEAPON_DEFS, WEAPON_FAMILY_ITEM_META, gradeOf, isUniqueWeapon, weaponFamilyOf } from './WeaponDefs';
import { ARMOR_DEFS, ARMOR_ICON, armorItemSize } from './ArmorDefs';
import { IMPLANT_ITEM_DEFS } from './ImplantDefs';

/* ── palette / labels ─────────────────────────────────────────────────────── */
/* Phase 7 (2026-09-06): the rarity / category labels, colours, icons and order live in `src/shared/labels.ts` now so
 * meta/ and ui/ can use them without importing items/. Re-exported here so every existing `@/items` import keeps working. */
export {
  RARITY_COLORS, RARITY_ORDER, rarityRank, rarityForGrade, gradeForRarity,
  RARITY_LABEL_KO, CATEGORY_LABEL_KO, CATEGORY_COLOR, CATEGORY_ICON,
} from '@/shared';

/**
 * 모든 `ItemCategory` (계약에 적힌 순서). 손으로 적은 목록이 아니라 `CATEGORY_LABEL_KO` 의 키다 —
 * 그 표는 `Record<ItemCategory, string>` 이라 카테고리가 늘면 컴파일러가 표를 먼저 막고, 이 배열은 저절로 따라온다.
 * 쓰는 곳은 csv 의 카테고리 목록 칸 검증(`pouchAccepts` 의 `enumList`)이다.
 */
export const ITEM_CATEGORIES = Object.keys(CATEGORY_LABEL_KO) as readonly ItemCategory[];

export const AMMO_LABEL_KO: Readonly<Record<AmmoType, string>> = {
  light: '경량탄', medium: '준중량탄', heavy: '중량탄', shell: '산탄',
  /* legacy calibres (no def uses them) */
  rifle: '소총탄', pistol: '권총탄', shotgun: '산탄', energy: '에너지 셀',
  /* unique-weapon calibres (2026-09-06) */
  fuel: '연료통', cell: '전지', shuriken: '표창', arrow: '화살', rocket: '로켓', belt: '탄띠',
};

/** v2 calibres in display order: the four graded-weapon calibres, then the six unique-weapon calibres. */
export const AMMO_TYPES_V2: readonly AmmoType[] = ['light', 'medium', 'heavy', 'shell', 'fuel', 'cell', 'shuriken', 'arrow', 'rocket', 'belt'];
/** Calibres only a unique weapon fires (never rolled with the graded-weapon ammo). */
export const UNIQUE_AMMO_TYPES: readonly AmmoType[] = ['fuel', 'cell', 'shuriken', 'arrow', 'rocket', 'belt'];

/** Ammo item id for a calibre (`medium` → `ammo_medium`). */
export function ammoItemIdFor(ammoType: AmmoType): string {
  return `ammo_${ammoType}`;
}

/* ── weight ───────────────────────────────────────────────────────────────── */
/** kg for an ItemDef that does not declare `weight` (matches the shared contract comment). */
export const DEFAULT_ITEM_WEIGHT = T.num('DEFAULT_ITEM_WEIGHT');

/**
 * 가방 한 칸이 늘려 주는 소지 한계 (kg). 2026-09-12: `inventory/InventorySystem.getWeight` 안에 `* 0.5` 로
 * 박혀 있던 값 — 가방 툴팁의 「소지 한계 +N kg」 줄과 실제 한계가 **같은 수치를 읽어야** 하므로 표로 뺐다.
 * 식은 `inventory/Gear.bagCapacityBonus` 하나가 갖는다.
 */
export const BAG_CAPACITY_PER_CELL = T.num('BAG_CAPACITY_PER_CELL');

/** Weight in kg of `qty` units of `def`. */
export function itemWeight(def: ItemDef, qty = 1): number {
  return (def.weight ?? DEFAULT_ITEM_WEIGHT) * Math.max(0, qty);
}

/* ── builder ──────────────────────────────────────────────────────────────── */
type DefInput = Omit<ItemDef, 'color' | 'stackMax'> & { stackMax?: number };
const def = (d: DefInput): ItemDef => ({ ...d, stackMax: d.stackMax ?? 1, color: RARITY_COLORS[d.rarity] });

/* ── weapons (one ItemDef per WeaponDef grade) ─────────────────────────────── */
/* 무기의 격자 크기 · 아이콘 · 가격 · 무게 · 설명은 무기 수치와 같은 줄에 있다 —
 * `data/weapons.csv` / `data/weapons_unique.csv`. items/ 는 그 표를 ItemDef 로 옮기기만 한다. */
const FALLBACK_META: WeaponItemMeta = { width: 3, height: 2, icon: '⌐', value: 300, weight: 3.5, description: '무기.' };

/** Value multiplier per grade above I. */
export const WEAPON_GRADE_VALUE_STEP = T.num('WEAPON_GRADE_VALUE_STEP');


function weaponItemDef(w: WeaponDef): ItemDef {
  if (isUniqueWeapon(w)) {
    const meta = UNIQUE_WEAPON_ITEM_META.get(w.id) ?? FALLBACK_META;
    return def({
      id: itemIdForWeapon(w.id), name: w.name, category: w.slot, rarity: 'legendary',
      width: meta.width, height: meta.height, value: meta.value,
      icon: meta.icon, weaponId: w.id, description: meta.description, weight: meta.weight,
    });
  }
  const meta = WEAPON_FAMILY_ITEM_META.get(weaponFamilyOf(w)) ?? FALLBACK_META;
  const grade = gradeOf(w);
  return def({
    id: itemIdForWeapon(w.id), name: w.name, category: w.slot, rarity: rarityForGrade(grade),
    width: meta.width, height: meta.height, value: Math.round(meta.value * (1 + WEAPON_GRADE_VALUE_STEP * (grade - 1))),
    icon: meta.icon, weaponId: w.id, description: meta.description, weight: meta.weight,
  });
}

export const WEAPON_ITEM_DEFS: readonly ItemDef[] = WEAPON_DEFS.map(weaponItemDef);

/* ── ammo v2 (qty = rounds) ───────────────────────────────────────────────── */
/** `data/ammo.csv` 의 줄 (탄종 하나 = 한 줄). */
const AMMO_ROWS = csvRows('ammo.csv');

/** kg per round (tactical kit weight budget). */
export const AMMO_ROUND_WEIGHT: Readonly<Partial<Record<AmmoType, number>>> =
  Object.fromEntries(AMMO_ROWS.map((r) => [r.str('type'), r.num('roundWeight', { min: 0 })]));

export const AMMO_ITEM_DEFS: readonly ItemDef[] = AMMO_ROWS.map((r) => {
  const type = r.str('type') as AmmoType;
  return def({
    id: ammoItemIdFor(type), name: r.str('name'), category: 'ammo', rarity: r.str('rarity') as Rarity,
    width: 1, height: 1, stackMax: AMMO_STACK_ROUNDS[type], value: r.int('value', { min: 0 }),
    icon: r.str('icon'), ammoType: type, description: r.str('description'),
    weight: r.num('roundWeight', { min: 0 }),
  });
});

/* ── attachments — data/attachments.csv ───────────────────────────────────── */
const ATTACHMENT_WEIGHT = 0.3;

export const ATTACHMENT_ITEM_DEFS: readonly ItemDef[] = csvRows('attachments.csv').map((r) => {
  const effects: AttachmentEffects = {};
  const mul = (key: 'recoilV' | 'recoilH' | 'spread' | 'hipSpread' | 'adsTime' | 'magSize' | 'adsZoom'): void => {
    const v = r.optNum(key, { min: 0 });
    if (v !== undefined) effects[key] = v;
  };
  mul('recoilV'); mul('recoilH'); mul('spread'); mul('hipSpread'); mul('adsTime'); mul('magSize'); mul('adsZoom');
  if (r.has('scope')) effects.scope = r.bool('scope');
  if (r.has('laser')) effects.laser = r.bool('laser');
  const classes = r.list('classes') as WeaponClass[];
  const ammoTypes = r.list('ammoTypes') as AmmoType[];
  const attachment: AttachmentDef = {
    socket: r.enum('socket', ['muzzle', 'grip', 'mag', 'stock', 'sight'] as const),
    effects,
    ...(classes.length ? { classes } : {}),
    ...(ammoTypes.length ? { ammoTypes } : {}),
  };
  return def({
    id: r.str('id'), name: r.str('name'), category: 'attachment', rarity: r.str('rarity') as Rarity,
    width: 1, height: 1, value: r.int('value', { min: 0 }), icon: r.str('icon'),
    description: r.str('description'), attachment, weight: ATTACHMENT_WEIGHT,
  });
});

/* ── bags — data/bags.csv ─────────────────────────────────────────────────── */
/* 2026-09-11 (C-5): `quickSlots` is capped at `QUICK_SLOTS` (the wheel has 8 directions) — a 9 used to load fine and
 * be clamped silently by `InventorySystem.getQuickSlotCount`, so the tooltip promised a slot that did not exist.
 * 2026-09-11 (C-36): `durabilityMax` — bags wear by `BAG_DURABILITY_PER_RAID` per raid (inventory/) and are repaired
 * like armor (`Salvage.REPAIRABLE`). At 0 a bag still works; only the repair gets expensive. */
export const BAG_ITEM_DEFS: readonly ItemDef[] = csvRows('bags.csv').map((r) => {
  const bag: BagDef = {
    cols: r.int('cols', { min: 1 }), rows: r.int('rows', { min: 1 }), quickSlots: r.int('quickSlots', { min: 0, max: QUICK_SLOTS }),
    ...(r.has('tactical') && r.bool('tactical') ? { tactical: true } : {}),
  };
  return def({
    id: r.str('id'), name: r.str('name'), category: 'bag', rarity: r.str('rarity') as Rarity,
    width: 2, height: 2, value: r.int('value', { min: 0 }), icon: bag.tactical ? '⛶' : '▣',
    description: r.str('description'), bag,
    durabilityMax: r.int('durabilityMax', { min: 1 }),
    weight: T.num('BAG_WEIGHT_BASE') + bag.cols * bag.rows * T.num('BAG_WEIGHT_PER_CELL'),
  });
});

/* ── 씨앗 (Phase 8) — data/seeds.csv ──────────────────────────────────────────
 * Planted in a 온실 재배 스테이션; `SeedDef.growHours` is **real** wall-clock time and keeps running while
 * the game is closed (housing/ owns the plots). Loot (tier 1–3 containers, 벌레 시체) + 기업 상점 only — never craftable.
 *
 * 2026-09-11 (온실 개편): 한 줄마다 **`soilTag`** 가 붙었다 — 그 칸에 부어 둔 토양의 태그와 같으면
 * `SOIL_MATCH_SPEEDUP` 만큼 빨리, 다르면 `SOIL_MISMATCH_PENALTY` 만큼 늦게 자란다 (판정은 `housing/`).
 * 필수 열이라 `r.enum` 의 fallback 을 주지 않는다 — 빠뜨린 줄은 `npm run data:check` 가 잡는다. */
/** Seeds share the category glyph and a leaf-green tint so a 씨앗 reads as one at a glance in the grid. */
const SEED_ICON = CATEGORY_ICON.seed;
const SEED_COLOR = CATEGORY_COLOR.seed;

export const SEED_ITEM_DEFS: readonly ItemDef[] = csvRows('seeds.csv').map((r) => {
  const seed: SeedDef = {
    growHours: r.num('growHours', { min: 0 }),
    yieldDefId: r.str('yieldDefId'),
    yieldQty: r.int('yieldQty', { min: 1 }),
    soilTag: r.enum('soilTag', SOIL_TAGS),
  };
  return {
    ...def({
      id: r.str('id'), name: r.str('name'), category: 'seed', rarity: r.str('rarity') as Rarity,
      width: 1, height: 1, stackMax: T.num('SEED_STACK_MAX'),
      value: r.int('value', { min: 0 }), icon: SEED_ICON, description: r.str('description'),
      seed, weight: T.num('SEED_WEIGHT'),
    }),
    color: SEED_COLOR,
  };
});

/* ── 미확인 표본 (A-12, 2026-09-11) — data/samples.csv ────────────────────────
 * 연구실 **분석기**가 해석하는 재료. `SampleDef.analyzeHours` 는 도감이 텅 빈 상태에서의 **실제 시간**이고
 * (씨앗의 `growHours` 와 같은 wall-clock 규약), 도감 진척 · 기지식으로 깎는 계산은 `housing/Rules` 가 한다.
 * 제작도 상점도 없다 — 벌레 시체 · 표본 채집지 · 티어 3+ 컨테이너 셋뿐이다 (로그는 표본에 관심이 없다).
 *
 * `first*` 는 **처음** 해석했을 때만 얹어 주는 보너스라 선택 열이다 (`optStr` / `optNum` 규약 — 칸이 비어
 * 있으면 필드 자체가 안 붙는다). `analyzeHours` · `rewardDefId` · `rewardQty` 는 필수다. */
/** 표본은 카테고리 글리프 · 색을 공유한다 — 격자에서 「아직 해석 안 한 것」이 한눈에 읽힌다. */
const SAMPLE_ICON = CATEGORY_ICON.sample;
const SAMPLE_COLOR = CATEGORY_COLOR.sample;

export const SAMPLE_ITEM_DEFS: readonly ItemDef[] = csvRows('samples.csv').map((r) => {
  const firstDefId = r.optStr('firstDefId');
  const sample: SampleDef = {
    analyzeHours: r.num('analyzeHours', { min: 0 }),
    rewardDefId: r.str('rewardDefId'),
    rewardQty: r.int('rewardQty', { min: 1 }),
    ...(firstDefId ? { firstDefId, firstQty: r.int('firstQty', { min: 1 }) } : {}),
  };
  return {
    ...def({
      id: r.str('id'), name: r.str('name'), category: 'sample', rarity: r.str('rarity') as Rarity,
      width: 1, height: 1, stackMax: T.num('SAMPLE_STACK_MAX'),
      value: r.int('value', { min: 0 }), icon: SAMPLE_ICON, description: r.str('description'),
      sample, weight: T.num('SAMPLE_WEIGHT'),
    }),
    color: SAMPLE_COLOR,
  };
});

/* ── 요리 (A-3c, 2026-09-11) — data/meals.csv ─────────────────────────────────
 * 주방 **조리대**(`WorkbenchKind 'cook'`)가 만들고 **식탁**에서 먹는다. 먹으면 다음 레이드 1회분으로 실리고
 * (`PlayerProfile.meal` → `mealActive`), 수명 규칙은 준비물과 완전히 같다 — 사망해도 그 레이드는 유지된다.
 *
 * 한 요리는 **버프 하나**만 올린다 (사용자 결정). `MealDef.buff` 는 `DerivedStats` 에 이미 있는 필드 이름이라
 * 소비자가 한 줄도 안 바뀐다 — 접어 넣는 곳은 `progression/recomputeDerived` 하나다. `amount` 는
 * `isMealBuffMultiplier` 인 버프면 배수에 가산되고(0.2 = +20 %), 나머지는 단위 그대로다 (`durabilityLossMul` 만 음수).
 *
 * 씨앗 · 표본과 달리 **색은 등급색 그대로**다 (`def()` 기본값): 요리는 일반 → 서사가 곧 tier 1 → 2 이라
 * 격자에서 「특선인가」가 색으로 읽혀야 한다. 아이콘은 csv 의 `icon` 칸이고 격자 크기는 1×1 고정이다. */
export const MEAL_ITEM_DEFS: readonly ItemDef[] = csvRows('meals.csv').map((r) => {
  const meal: MealDef = {
    buff: r.enum('buff', MEAL_BUFFS),
    /* 음수를 허용한다 — `durabilityLossMul` 은 "손상이 줄어든다" 라 −0.2 다. */
    amount: r.num('amount'),
    tier: r.int('tier', { min: 1, max: 2 }) as MealDef['tier'],
  };
  return def({
    id: r.str('id'), name: r.str('name'), category: 'meal', rarity: r.str('rarity') as Rarity,
    width: 1, height: 1, stackMax: r.int('stackMax', { min: 1 }),
    value: r.int('value', { min: 0 }), weight: r.num('weight', { min: 0 }),
    icon: r.str('icon'), description: r.str('description'), meal,
  });
});

/* ── 서적 (Phase 9) — data/books.csv ──────────────────────────────────────────
 * One book per skill (`book_<skill>`), shelved in a 서재 책장 (`furn_bookshelf`, housing/ owns the shelves and the
 * bonus: `1 + BOOK_XP_PER_BOOK × Σ BOOK_RARITY_MUL[rarity]`, capped at `BOOK_GAIN_MAX`). Loot (tier 2–4 containers,
 * 로그 시체) + 세레스 corp shop (신뢰도 2) only — never craftable, never quick-usable. 1×2, no stacking. */
const BOOK_ICON = CATEGORY_ICON.book;
const BOOK_COLOR = CATEGORY_COLOR.book;
/** Sale value by rarity (the corp shop prices off `value`) — `data/tables.csv`. */
const BOOK_VALUE_BY_RARITY = numberMap<Rarity>('tables.csv', 'BOOK_VALUE_BY_RARITY');

/** Item id of the book that teaches `skill` (`gun_AR` → `book_gun_AR`). */
export function bookItemIdFor(skill: SkillId): string {
  return `book_${skill}`;
}

/** The 14 books, in `data/books.csv` order (one per skill). */
export const BOOK_ITEM_DEFS: readonly ItemDef[] = csvRows('books.csv').map((r) => {
  const skill = r.str('skill') as SkillId;
  const rarity = r.str('rarity') as Rarity;
  return {
    ...def({
      id: bookItemIdFor(skill), name: r.str('name'), category: 'book', rarity,
      width: 1, height: 2, stackMax: 1, value: BOOK_VALUE_BY_RARITY[rarity],
      icon: BOOK_ICON, description: r.str('description'), book: { skill }, weight: T.num('BOOK_WEIGHT'),
    }),
    color: BOOK_COLOR,
  };
});
/** Book def for a skill (undefined only if a skill was added without a book — every `SKILL_IDS` entry has one). */
export const BOOK_DEF_BY_SKILL: ReadonlyMap<SkillId, ItemDef> = new Map(BOOK_ITEM_DEFS.map((d) => [d.book!.skill, d]));
for (const s of SKILL_IDS) if (!BOOK_DEF_BY_SKILL.has(s)) console.warn(`[items] skill '${s}' has no book`);

/* ── 서재 매체: 디스크 · 레코드 (A-3e, 2026-09-12) — data/discs.csv · data/records.csv ──────────
 * 책과 **똑같은 역할**의 아이템 2종 — 숙련 하나에 한 장씩(`disc_<skill>` · `record_<skill>`), 등급은 **같은 숙련의 책과 같다**
 * (그 등급이 `BOOK_RARITY_MUL` 가중치다). 디스크는 서재 디스크 전시대(`furn_disc_stand`), 레코드는 레코드랙(`furn_record_rack`)에
 * 꽂고, 매체별 몫 · 상한 · 보조 가구 배율은 `housing/` 이 계산한다 (`SHELF_*` 표). items 는 표만 옮긴다.
 * 루팅(디스크 티어 2–4 · 레코드 티어 3–5) + 세레스 상점(신뢰도 3 · 4)뿐 — 제작 불가, 퀵슬롯 불가, 로그 시체 서적 굴림에 안 섞인다.
 *
 * 책 로더와 달리 `skill` · `rarity` 를 열거값으로 읽고, **책과 등급이 다르면 · 같은 숙련이 두 줄이면** `data:check` 가 잡는다. */
interface ShelfMediumSpec {
  file: string;
  category: 'disc' | 'record';
  idOf: (skill: SkillId) => string;
  width: number;
  height: number;
  valueTable: string;
  weightKey: string;
}

function shelfMediumDefs(spec: ShelfMediumSpec): ItemDef[] {
  const value = numberMap<Rarity>('tables.csv', spec.valueTable);
  const weight = T.num(spec.weightKey);
  const seen = new Set<SkillId>();
  const out: ItemDef[] = [];
  for (const r of csvRows(spec.file)) {
    const skill = r.enum('skill', SKILL_IDS);
    const rarity = r.enum('rarity', RARITY_ORDER);
    if (seen.has(skill)) { r.report('skill', `'${skill}' 가 두 번 나온다 — 숙련 하나에 한 장이다`); continue; }
    seen.add(skill);
    const bookRarity = BOOK_DEF_BY_SKILL.get(skill)?.rarity;
    if (bookRarity && bookRarity !== rarity) r.report('rarity', `'${skill}' 는 책(books.csv)이 ${bookRarity} 다 — 같은 숙련의 책과 등급이 같아야 한다`);
    out.push({
      ...def({
        id: spec.idOf(skill), name: r.str('name'), category: spec.category, rarity,
        width: spec.width, height: spec.height, stackMax: 1, value: value[rarity],
        icon: CATEGORY_ICON[spec.category], description: r.str('description'),
        ...(spec.category === 'disc' ? { disc: { skill } } : { record: { skill } }), weight,
      }),
      color: CATEGORY_COLOR[spec.category],
    });
  }
  return out;
}

/** Item id of the 디스크 that teaches `skill` (`gun_AR` → `disc_gun_AR`). */
export function discItemIdFor(skill: SkillId): string {
  return `disc_${skill}`;
}

/** Item id of the 레코드 that teaches `skill` (`gun_AR` → `record_gun_AR`). */
export function recordItemIdFor(skill: SkillId): string {
  return `record_${skill}`;
}

/** The 14 디스크 (2×2), in `data/discs.csv` order (one per skill). */
export const DISC_ITEM_DEFS: readonly ItemDef[] = shelfMediumDefs({
  file: 'discs.csv', category: 'disc', idOf: discItemIdFor, width: 2, height: 2,
  valueTable: 'DISC_VALUE_BY_RARITY', weightKey: 'DISC_WEIGHT',
});

/** The 14 레코드 (3×3), in `data/records.csv` order (one per skill). */
export const RECORD_ITEM_DEFS: readonly ItemDef[] = shelfMediumDefs({
  file: 'records.csv', category: 'record', idOf: recordItemIdFor, width: 3, height: 3,
  valueTable: 'RECORD_VALUE_BY_RARITY', weightKey: 'RECORD_WEIGHT',
});

export const DISC_DEF_BY_SKILL: ReadonlyMap<SkillId, ItemDef> = new Map(DISC_ITEM_DEFS.map((d) => [d.disc!.skill, d]));
export const RECORD_DEF_BY_SKILL: ReadonlyMap<SkillId, ItemDef> = new Map(RECORD_ITEM_DEFS.map((d) => [d.record!.skill, d]));
for (const s of SKILL_IDS) {
  if (!DISC_DEF_BY_SKILL.has(s)) console.warn(`[items] skill '${s}' has no disc`);
  if (!RECORD_DEF_BY_SKILL.has(s)) console.warn(`[items] skill '${s}' has no record`);
}

/* ── armor generated from the ArmorDef table (tactical kit) ───────────────── */
const armorItem = (a: ArmorDef): ItemDef => {
  const { width, height } = armorItemSize(a);
  return def({
    id: a.id, name: a.name, description: a.description, category: 'armor', rarity: a.rarity,
    width, height,
    /* 2026-09-10: 가격은 뎀감률이 아니라 실드에서 나온다 (`ARMOR_VALUE_SHIELD_MUL` 12.6 = 옛 4200 × 0.3 ÷ 100 이라 값은 그대로). */
    value: Math.round(T.num('ARMOR_VALUE_BASE') + a.shield * T.num('ARMOR_VALUE_SHIELD_MUL') + a.durabilityMax * T.num('ARMOR_VALUE_DUR_MUL')),
    icon: ARMOR_ICON[a.id] ?? '⛊', armorId: a.id, weight: a.weight, durabilityMax: a.durabilityMax,
  });
};

/* ── 일반 아이템 (수류탄 · 회복 · 귀중품 · 재료 · 약초 · 가젯) — data/items.csv ── */
/**
 * `items.csv` 한 줄 → `ItemDef`. 카테고리별로 나눠 담아 두므로 `ITEM_DEFS` 는
 * 예전과 똑같은 순서로 조립된다 (UI 목록 순서가 이 순서다).
 */
const GENERIC_ITEM_DEFS: readonly ItemDef[] = csvRows('items.csv').map((r) => {
  const heal = r.has('healUseTime') ? {
    useTime: r.num('healUseTime', { min: 0 }),
    amount: r.num('healHp', { min: 0 }),
    overTime: r.num('healOverTime', { min: 0 }),
    ...(r.has('sprayTick') ? {
      spray: {
        tick: r.num('sprayTick', { min: 0 }),
        gaugePerTick: r.num('sprayGauge', { min: 0 }),
        healPerTick: r.num('sprayHeal', { min: 0 }),
        radius: r.num('sprayRadius', { min: 0 }),
      },
    } : {}),
  } : undefined;
  /* 2026-09-11 (온실 개편): `category: 'soil'` 줄만 `soilTag` · `soilUses` 를 채운다 — `heal*` · `gadgetId` 와 같은
   * 선택 열 규약이다 (칸이 비어 있으면 필드 자체가 안 붙는다). `uses` 는 한 번 부은 토양이 견디는 수확 횟수이고
   * 그 등급 곡선은 `SOIL_USES_BY_RARITY`(data/tables.csv) 다 — csv 의 값이 실제로 쓰이는 숫자다. */
  const soil: SoilDef | undefined = r.has('soilTag')
    ? { tag: r.enum('soilTag', SOIL_TAGS) as SoilTag, uses: r.int('soilUses', { min: 1 }) }
    : undefined;
  /* 2026-09-11 (A-13): `category: 'prep'` 줄만 `prepEnv` · `prepShort` 를 채운다 — `soil` 과 같은 선택 열 규약이다.
   * `env` 는 이 준비물이 **완전히** 막아 주는 행성 환경이고, `short` 는 HUD 배지에 찍는 짧은 이름(「방독」 · 「내열」)이다.
   * 쓰는 곳은 `progression`(다음 레이드 1회분) · `player`(피해 면제) · `ui`(배지 · 툴팁) 이고 items 는 표만 옮긴다. */
  const prepEnv = r.optEnum('prepEnv', ENV_KINDS);
  const prep: PrepDef | undefined = prepEnv ? { env: prepEnv, short: r.str('prepShort') } : undefined;
  /* 2026-09-11 (A-15 프린터): `category: 'pouch'` 줄만 `pouchCols` · `pouchRows` · `pouchAccepts` 를 채운다.
   * `accepts` 는 `|` 로 이은 `ItemCategory` 목록이라 `enumList` 가 **모르는 이름을 스스로 신고한다**
   * (`npm run data:check` 가 그 신고를 집는다) — 카테고리 이름을 items/ 에 또 적지 않으려고
   * 허용 목록은 `CATEGORY_LABEL_KO` 의 키에서 뽑는다 (`ItemCategory` 를 키로 하는 Record 라 늘 빠짐없다). */
  const pouch: PouchDef | undefined = r.has('pouchCols')
    ? { cols: r.int('pouchCols', { min: 1 }), rows: r.int('pouchRows', { min: 1 }), accepts: r.enumList('pouchAccepts', ITEM_CATEGORIES) }
    : undefined;
  /* 받는 카테고리가 하나도 없는 주머니는 아무것도 못 넣는 빈 격자다 — 오타를 조용히 넘기지 않는다. */
  if (pouch && pouch.accepts.length === 0) r.report('pouchAccepts', '주머니가 받아 주는 카테고리가 하나도 없다');
  /* 2026-09-11 (A-14 배양조): 세포주(`strainOut`·`strainQty`·`strainHours`) · 영양 배지(`mediumUses`·`mediumSpeed`).
   * 둘 다 `category: 'material'` 줄에 붙는 선택 열이고, 그 산출물 · 시간을 쓰는 곳은 `housing/` 의 배양조다.
   * `outputDefId` 가 가리키는 아이템이 있는지는 여기서 보지 않는다 — `SampleDef.rewardDefId` 와 같은 규약이다
   * (`ITEM_DEF_MAP` 이 아직 없다; 이름 검사는 `npm run data:check` 의 몫). */
  const strainOut = r.optStr('strainOut');
  const strain: StrainDef | undefined = strainOut
    ? { outputDefId: strainOut, outputQty: r.int('strainQty', { min: 1 }), cultureHours: r.num('strainHours', { min: 0 }) }
    : undefined;
  const medium: MediumDef | undefined = r.has('mediumUses')
    ? { uses: r.int('mediumUses', { min: 1 }), speedMul: r.num('mediumSpeed', { min: 0 }) }
    : undefined;
  return def({
    id: r.str('id'), name: r.str('name'), category: r.str('category') as ItemCategory,
    rarity: r.str('rarity') as Rarity,
    width: r.int('width', { min: 1 }), height: r.int('height', { min: 1 }),
    stackMax: r.int('stackMax', { min: 1 }), value: r.int('value', { min: 0 }),
    weight: r.num('weight', { min: 0 }), icon: r.str('icon'),
    description: r.str('description'),
    ...(r.has('quickUsable') ? { quickUsable: r.bool('quickUsable') } : {}),
    ...(r.has('gadgetId') ? { gadgetId: r.str('gadgetId') as ItemDef['gadgetId'] } : {}),
    ...(r.has('durabilityMax') ? { durabilityMax: r.num('durabilityMax', { min: 0 }) } : {}),
    ...(r.has('healAmount') ? { healAmount: r.num('healAmount', { min: 0 }) } : {}),
    ...(heal ? { heal } : {}),
    ...(soil ? { soil } : {}),
    ...(prep ? { prep } : {}),
    ...(pouch ? { pouch } : {}),
    ...(strain ? { strain } : {}),
    ...(medium ? { medium } : {}),
  });
});

/** `items.csv` 안에서 한 카테고리만 뽑는다 (파일에 적힌 순서 그대로). */
const itemGroup = (category: ItemCategory): ItemDef[] => GENERIC_ITEM_DEFS.filter((d) => d.category === category);

/* 2026-09-11 (A-14 · A-15): 배양조 · 프린터 재료(배지 · 세포주 · 배양 산물 · 필라멘트)는 `items.csv` 에서
 * 준비물(`prep`) **뒤에** 적혀 있고, 목록에서도 거기 붙어야 한다 (「밭 → 연구실 → 프린터」 한 덩어리).
 * 그래서 재료 그룹을 **그 경계에서** 가른다 — 파일 순서가 곧 표시 순서라는 `items.csv` 머리 주석 그대로이고,
 * 아이템 id 를 코드에 적지 않으므로 csv 에 줄을 더하기만 하면 제자리에 붙는다. */
const PREP_ROW_AT = GENERIC_ITEM_DEFS.map((d) => d.category).lastIndexOf('prep');
/** `prep` 줄보다 앞에 있는 그 카테고리의 줄 (준비물이 한 줄도 없으면 전부). */
const itemGroupBeforePrep = (category: ItemCategory): ItemDef[] =>
  GENERIC_ITEM_DEFS.filter((d, i) => d.category === category && (PREP_ROW_AT < 0 || i < PREP_ROW_AT));
/** `prep` 줄보다 뒤에 있는 그 카테고리의 줄. */
const itemGroupAfterPrep = (category: ItemCategory): ItemDef[] =>
  GENERIC_ITEM_DEFS.filter((d, i) => d.category === category && PREP_ROW_AT >= 0 && i > PREP_ROW_AT);

/* ── 실드 충전기 (2026-09-10) ─────────────────────────────────────────────────
 * 방탄복이 주는 **실드**(추가 체력)를 채우는 소모품 3종. 회복 소모품과 나란히 `category: 'stim'` 이라
 * 퀵슬롯 · 루팅 카테고리 · 손에 든 모습이 전부 공짜로 따라온다. 다른 점은 좌클릭 홀드가 끝났을 때
 * `PlayerRef.applyHeal` 이 아니라 **`PlayerRef.chargeShield`** 로 간다는 것뿐이다.
 *
 * `ItemDef` 에 칸을 새로 열지 않은 이유: `src/shared` 는 조율 없이 고치지 않는 계약이다. 대신
 * 여기 표 하나를 두고 `weapons/` 와 `inventory/` 가 `shieldChargeOf(defId)` 로 묻는다
 * (두 폴더 모두 이미 `@/items` 를 import 한다 — `WeaponDefaults.ts` · `inventory/Gear.ts` 참고).
 */
export interface ShieldChargeDef {
  /** 좌클릭을 눌러야 하는 시간(초) — 회복 소모품의 `heal.useTime` 과 같은 뜻. */
  useTime: number;
  /** 채워 줄 실드량. `Infinity` = 완전 회복 (csv 의 `shieldHp` 가 음수일 때). */
  amount: number;
}

/** `items.csv` 의 `shieldUseTime` / `shieldHp` 칸이 채워진 줄 = 실드 충전기. */
export const SHIELD_CHARGE_MAP: ReadonlyMap<string, ShieldChargeDef> = new Map(
  csvRows('items.csv')
    .filter((r) => r.has('shieldUseTime'))
    .map((r) => {
      const hp = r.num('shieldHp');
      return [r.str('id'), { useTime: r.num('shieldUseTime', { min: 0 }), amount: hp < 0 ? Infinity : hp }] as const;
    }),
);

/** 이 아이템이 실드 충전기면 그 수치, 아니면 undefined. */
export function shieldChargeOf(defId: string | undefined): ShieldChargeDef | undefined {
  return defId ? SHIELD_CHARGE_MAP.get(defId) : undefined;
}

/* ── 전투 소모품 3종 (2026-09-12 — 아드레날린 주사 · 각성제 · 안정제) ───────────────
 * 실드 충전기와 같은 옆 표 규약이다: `category: 'stim'` 이라 퀵슬롯 · 루팅 카테고리 · 손에 든 모습 · 좌클릭 홀드가 공짜로
 * 따라오고, 다른 점은 홀드가 끝났을 때 **어디로 가는가**뿐이다 — `adrenaline` · `stimulant` 는 `PlayerRef.applyBoost`,
 * `implant_refill` 은 `ImplantsRef.refillAll`. 체력이 가득해도 쓸 수 있다 (회복약의 "가득이면 거절" 을 타지 않는다).
 * 효과 수치는 `data/constants.csv` 의 `BOOST_*` 이고 여기에는 **효과 종류와 홀드 시간**만 있다.
 */
export type BoostEffect = BoostKind | 'implant_refill';
export const BOOST_EFFECTS: readonly BoostEffect[] = ['adrenaline', 'stimulant', 'implant_refill'];

export interface BoostItemDef {
  effect: BoostEffect;
  /** 좌클릭을 눌러야 하는 시간(초) — 회복 소모품의 `heal.useTime` 과 같은 뜻. */
  useTime: number;
}

/** `items.csv` 의 `boostEffect` / `boostUseTime` 칸이 채워진 줄 = 전투 소모품. */
export const BOOST_ITEM_MAP: ReadonlyMap<string, BoostItemDef> = new Map(
  csvRows('items.csv')
    .filter((r) => r.has('boostEffect'))
    .map((r) => [r.str('id'), {
      effect: r.enum('boostEffect', BOOST_EFFECTS) as BoostEffect,
      useTime: r.num('boostUseTime', { min: 0 }),
    }] as const),
);

/** 이 아이템이 전투 소모품이면 그 효과 · 홀드 시간, 아니면 undefined. */
export function boostItemOf(defId: string | undefined): BoostItemDef | undefined {
  return defId ? BOOST_ITEM_MAP.get(defId) : undefined;
}

/* ── definitions ──────────────────────────────────────────────────────────── */
export const ITEM_DEFS: readonly ItemDef[] = [
  /* weapons — primary / secondary (do not occupy grid cells while equipped) */
  ...WEAPON_ITEM_DEFS,
  /* grenades · 회복 소모품 */
  ...itemGroup('grenade'),
  ...itemGroup('stim'),
  /* ammo v2 · attachments · bags */
  ...AMMO_ITEM_DEFS,
  ...ATTACHMENT_ITEM_DEFS,
  ...BAG_ITEM_DEFS,
  /* valuables — value and weight are deliberately uncorrelated */
  ...itemGroup('valuable'),
  /* materials · herbs (gathered from world plants) — 배양조 · 프린터 재료는 아래 연구실 묶음에 있다 */
  ...itemGroupBeforePrep('material'),
  ...itemGroup('herb'),
  /* 2026-09-11 온실 개편: 작물(재배층 수확물 — 판매 · 세레스 납품) · 토양(채집 노드 전용, 재배층에 붓는다).
     약초 바로 뒤에 두어 "밭에서 나온 것" 이 목록에서 한 덩어리로 읽힌다. */
  ...itemGroup('crop'),
  ...itemGroup('soil'),
  /* 2026-09-11 주방(A-3c): 요리는 작물의 네 번째 소비처다 — 재료(작물) 바로 뒤에 그 산물을 둔다. */
  ...MEAL_ITEM_DEFS,
  /* 2026-09-11 연구실(A-12 · A-13): 표본(분석기가 해석한다 — `samples.csv`) · 준비물(함선에서 써서 다음 레이드
     1회분으로 싣는다). 밭에서 나온 것 바로 뒤가 연구실에서 쓰는 것이다. */
  ...SAMPLE_ITEM_DEFS,
  ...itemGroup('prep'),
  /* 2026-09-11 배양조 · 프린터(A-14 · A-15): 영양 배지 · 세포주 · 배양 산물 · 필라멘트(전부 `material`) →
     그 필라멘트로 찍는 주머니 → 주머니가 나르는 열쇠. 사슬 순서 그대로 읽힌다. */
  ...itemGroupAfterPrep('material'),
  ...itemGroup('pouch'),
  ...itemGroup('key'),
  /* seeds (Phase 8: 온실 재배층에 심는다) · books (Phase 9: 서재 책장에 꽂는다) */
  ...SEED_ITEM_DEFS,
  ...BOOK_ITEM_DEFS,
  /* 2026-09-12 (A-3e): 서재 매체 — 책과 같은 역할이라 책 바로 뒤 (디스크 전시대 · 레코드랙) */
  ...DISC_ITEM_DEFS,
  ...RECORD_ITEM_DEFS,
  /* 임플란트 (Phase 12: 캐릭터 탭에 장착; 망가진 것만 루팅, 세레스 바이오가 수리 · 판매 — `ImplantDefs.ts`) */
  ...IMPLANT_ITEM_DEFS,
  /* gadgets (behaviour lives in src/gadgets; here they are just consumables) */
  ...itemGroup('gadget'),
  /* armor generated from the ArmorDef table */
  ...ARMOR_DEFS.map(armorItem),
];

export const ITEM_DEF_MAP: ReadonlyMap<string, ItemDef> = new Map(ITEM_DEFS.map((d) => [d.id, d]));

export function getItemDef(defId: string): ItemDef | undefined {
  return ITEM_DEF_MAP.get(defId);
}

export function itemDefsByCategory(category: ItemCategory): ItemDef[] {
  return ITEM_DEFS.filter((d) => d.category === category);
}

/** Item id for a weapon def id (`ar` → `wpn_ar`, `ar_g3` → `wpn_ar_g3`). */
export function itemIdForWeapon(weaponId: string): string {
  return `wpn_${weaponId}`;
}

/** True when the def is an equippable weapon (primary or secondary with a `weaponId`). */
export function isWeaponItemDef(d: ItemDef | undefined): d is ItemDef & { weaponId: string } {
  return !!d && (d.category === 'primary' || d.category === 'secondary') && !!d.weaponId;
}

/** True when the item may be dropped into a quick-use slot. */
export function isQuickUsable(def: ItemDef): boolean {
  return def.quickUsable === true || QUICK_USABLE_CATEGORIES.includes(def.category);
}

/**
 * Minimum kit (2026-09-07). No longer handed out at every `world:ready` — the player equips out of the 함선 창고
 * (`STARTER_STASH`, granted once on a fresh profile). `inventory` only falls back to this when the loadout **and**
 * the stash are empty, so a player who lost everything is never stuck with no way to raid.
 */
export const STARTER_LOADOUT = {
  // 2026-09-10: 보조무기가 사라져 최소 지급품도 주무기 한 정이다 (예전에는 `secondary: 'wpn_hg'` 권총이었다).
  primary: 'wpn_smg',
  primary2: null,
  secondary: null,
  bag: 'bag_common',
  /* appended: tactical kit */
  armor: 'armor_1',
  items: [
    { id: 'ammo_light', qty: AMMO_STACK_ROUNDS.light },
    { id: 'heal_bandage', qty: 2 },
    { id: 'grenade_frag', qty: 3 },
  ],
} as const;

/**
 * 기본 지급품 (2026-09-07): written into the 함선 창고 **once**, on a profile that has never had a stash.
 * `qty` is units **per stack** (ammo: rounds, clamped to the def's `stackMax`) and `stacks` how many of them —
 * one 세트 per stack, so `{ ammo_light, qty: 80, stacks: 10 }` is the 경탄 10세트 of the 기본 지급품 list.
 */
export const STARTER_STASH: readonly { id: string; qty: number; stacks?: number }[] = [
  /* 탄약 10세트씩 (한 세트 = 한 칸 가득) */
  { id: 'ammo_light', qty: AMMO_STACK_ROUNDS.light, stacks: 10 },
  { id: 'ammo_medium', qty: AMMO_STACK_ROUNDS.medium, stacks: 10 },
  { id: 'ammo_heavy', qty: AMMO_STACK_ROUNDS.heavy, stacks: 10 },
  { id: 'ammo_shell', qty: AMMO_STACK_ROUNDS.shell, stacks: 10 },
  /* 일반 등급 총기 한 자루씩 (권총은 기본 장착분과 별개로 지급하지 않는다) */
  { id: 'wpn_smg', qty: 1 },
  { id: 'wpn_sg', qty: 1 },
  { id: 'wpn_ar', qty: 1 },
  { id: 'wpn_dmr', qty: 1 },
  { id: 'wpn_sr', qty: 1 },
  /* 여분 가방 · 방탄복 (장착분은 STARTER_LOADOUT) */
  { id: 'bag_common', qty: 1, stacks: 3 },
  { id: 'armor_1', qty: 1, stacks: 3 },
  /* 첫 시설 체인 전부: 발전기 Lv.1 (`GENERATOR_UPGRADE_COST[0]` 폐금속 4) + 작업실 증축
     (`ROOM_PURPOSE_BUILD_COST.workshop` 폐금속 8 · 케이블 2) + 총기 작업대 제작 (`furn_bench_gun.craft`
     폐금속 8 · 합금 2 · 케이블 1) = 폐금속 20 · 케이블 3 · 합금 2. 2026-09-08: 폐금속이 16 이라 마지막
     작업대를 만들 수 없었다 — 여유를 두고 24 · 4 · 3 으로 올린다. */
  { id: 'mat_scrap', qty: 8, stacks: 3 },
  { id: 'mat_cable', qty: 4 },
  { id: 'mat_alloy', qty: 3 },
  /* 소모품 */
  { id: 'gad_defib', qty: 2, stacks: 2 },
  { id: 'grenade_frag', qty: 3, stacks: 3 },
];

export type StarterLoadout = {
  primary: string | null;
  primary2: string | null;
  secondary: string | null;
  bag: string | null;
  armor: string | null;
  items: readonly { id: string; qty: number }[];
};
