import type { AmmoType, ArmorDef, AttachmentDef, AttachmentEffects, BagDef, ItemCategory, ItemDef, Rarity, SeedDef, SkillId, WeaponClass, WeaponDef, WeaponGrade } from '@/shared';
import {
  AMMO_STACK_ROUNDS, CATEGORY_COLOR, CATEGORY_ICON,
  QUICK_USABLE_CATEGORIES, RARITY_COLORS, SKILL_IDS, csvRows, keyTable, numberMap, rarityForGrade,
} from '@/shared';

/*
 * 아이템 수치의 원본은 `data/` 의 csv 다 — `items.csv`(수류탄 · 회복 · 귀중품 · 재료 · 약초 · 가젯),
 * `ammo.csv` · `attachments.csv` · `bags.csv` · `seeds.csv` · `books.csv`,
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
export const BAG_ITEM_DEFS: readonly ItemDef[] = csvRows('bags.csv').map((r) => {
  const bag: BagDef = {
    cols: r.int('cols', { min: 1 }), rows: r.int('rows', { min: 1 }), quickSlots: r.int('quickSlots', { min: 0 }),
    ...(r.has('tactical') && r.bool('tactical') ? { tactical: true } : {}),
  };
  return def({
    id: r.str('id'), name: r.str('name'), category: 'bag', rarity: r.str('rarity') as Rarity,
    width: 2, height: 2, value: r.int('value', { min: 0 }), icon: bag.tactical ? '⛶' : '▣',
    description: r.str('description'), bag,
    weight: T.num('BAG_WEIGHT_BASE') + bag.cols * bag.rows * T.num('BAG_WEIGHT_PER_CELL'),
  });
});

/* ── 씨앗 (Phase 8) — data/seeds.csv ──────────────────────────────────────────
 * Planted in a 온실 재배층 (`furn_grow_rack`); `SeedDef.growHours` is **real** wall-clock time and keeps running while
 * the game is closed (housing/ owns the plots). Loot (tier 1–3 containers, 벌레 시체) + 기업 상점 only — never craftable. */
/** Seeds share the category glyph and a leaf-green tint so a 씨앗 reads as one at a glance in the grid. */
const SEED_ICON = CATEGORY_ICON.seed;
const SEED_COLOR = CATEGORY_COLOR.seed;

export const SEED_ITEM_DEFS: readonly ItemDef[] = csvRows('seeds.csv').map((r) => {
  const seed: SeedDef = {
    growHours: r.num('growHours', { min: 0 }),
    yieldDefId: r.str('yieldDefId'),
    yieldQty: r.int('yieldQty', { min: 1 }),
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

/* ── armor generated from the ArmorDef table (tactical kit) ───────────────── */
const armorItem = (a: ArmorDef): ItemDef => {
  const { width, height } = armorItemSize(a);
  return def({
    id: a.id, name: a.name, description: a.description, category: 'armor', rarity: a.rarity,
    width, height,
    value: Math.round(T.num('ARMOR_VALUE_BASE') + a.damageReduction * T.num('ARMOR_VALUE_DR_MUL') + a.durabilityMax * T.num('ARMOR_VALUE_DUR_MUL')),
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
  });
});

/** `items.csv` 안에서 한 카테고리만 뽑는다 (파일에 적힌 순서 그대로). */
const itemGroup = (category: ItemCategory): ItemDef[] => GENERIC_ITEM_DEFS.filter((d) => d.category === category);

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
  /* materials · herbs (gathered from world plants) */
  ...itemGroup('material'),
  ...itemGroup('herb'),
  /* seeds (Phase 8: 온실 재배층에 심는다) · books (Phase 9: 서재 책장에 꽂는다) */
  ...SEED_ITEM_DEFS,
  ...BOOK_ITEM_DEFS,
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
  primary: null,
  primary2: null,
  secondary: 'wpn_hg',
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
