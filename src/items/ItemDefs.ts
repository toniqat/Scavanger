import type { AmmoType, ArmorDef, AttachmentDef, AttachmentEffects, BagDef, BoostKind, ItemCategory, ItemDef, MealDef, MediumDef, PouchDef, PrepDef, Rarity, SampleDef, SeedDef, SkillId, SoilDef, SoilTag, StrainDef, WeaponClass, WeaponDef, WeaponGrade } from '@/shared';
/* appended (2026-09-13, cooking material tiers): sample families · sockets · meal stat rows */
import type { GrowSocketDef, MealBuff, MealEffect } from '@/shared';
/* appended (2026-09-15, gadget rework): grenade kinds */
import type { GrenadeKind } from '@/shared';
import {
  AMMO_STACK_ROUNDS, CATEGORY_COLOR, CATEGORY_ICON, CATEGORY_LABEL_KO, ENV_KINDS, MEAL_BUFFS,
  QUICK_SLOTS, QUICK_USABLE_CATEGORIES, RARITY_COLORS, RARITY_ORDER, SKILL_IDS, SOIL_TAGS, csvRows, keyTable, numberMap, rarityForGrade } from '@/shared';
import { GROW_SOCKET_EFFECTS, GROW_SOCKET_TARGETS, SAMPLE_FAMILIES } from '@/shared';
/* appended (2026-09-16, 18 samples): family glyphs — a sample tile's glyph is the family, its colour the rarity */
import type { SampleFamily } from '@/shared';
import { SAMPLE_FAMILY_ICON } from '@/shared';
/* appended (2026-09-13, library series · video games — docs/DECISIONS.md 「2026-09-13 — 서재 시리즈 · 비디오게임」) */
import type { BookDef, GameStat, GymGameTuning, GymMinigame, LibraryMedium, PlanetId } from '@/shared';
import { GAME_STATS, GYM_MINIGAME_LABEL_KO, LIBRARY_SERIES_DEFS, PLANET_IDS, resolveItemAlias, stringMap } from '@/shared';

/*
 * The item numbers come from the csv files in `data/` — `items.csv` (grenades · healing · valuables · materials ·
 * herbs · gadgets), `ammo.csv` · `attachments.csv` · `bags.csv` · `seeds.csv` · `samples.csv` · `sockets.csv` ·
 * `meals.csv`, library media from `library_series.csv` (2026-09-13 — in place of the old books · discs ·
 * records.csv), video games from `game_consoles.csv` · `game_discs.csv`, weapons from `weapons.csv` /
 * `weapons_unique.csv`, armor from `armor.csv`.
 * This file holds no table — only the code that moves those rows into `ItemDef`.
 *
 * `T` is the lookup for `data/tuning.csv` (scalars used only inside one feature folder).
 */
const T = /* data/tuning.csv */ keyTable('tuning.csv');
import type { WeaponItemMeta } from './WeaponDefs';
import { UNIQUE_WEAPON_ITEM_META, WEAPON_CLASSES, WEAPON_DEFS, WEAPON_FAMILY_ITEM_META, gradeOf, isUniqueWeapon, weaponFamilyOf } from './WeaponDefs';
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
 * Every `ItemCategory` (in the order the contract lists them). Not a hand-written list but the keys of
 * `CATEGORY_LABEL_KO` — that table is a `Record<ItemCategory, string>`, so a new category stops at the compiler
 * on the table first and this array follows by itself.
 * It is used to validate a csv category-list cell (`enumList` on `pouchAccepts`).
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
 * The carry limit (kg) one bag cell adds. 2026-09-12: the value was baked into
 * `inventory/InventorySystem.getWeight` as `* 0.5` — the bag tooltip's 「소지 한계 +N kg」 row and the real limit
 * **must read the same number**, so it was pulled out into the table.
 * The formula is owned by `inventory/Gear.bagCapacityBonus` alone.
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
/* A weapon's grid size · icon · price · weight · description sit on the same row as its numbers —
 * `data/weapons.csv` / `data/weapons_unique.csv`. items/ only moves that table into `ItemDef`. */
const FALLBACK_META: WeaponItemMeta = { width: 3, height: 2, icon: '⌐', value: 300, weight: 3.5, description: '무기.' };

/** Value multiplier per grade above I. */
export const WEAPON_GRADE_VALUE_STEP = T.num('WEAPON_GRADE_VALUE_STEP');


function weaponItemDef(w: WeaponDef): ItemDef {
  if (isUniqueWeapon(w)) {
    const meta = UNIQUE_WEAPON_ITEM_META.get(w.id) ?? FALLBACK_META;
    return def({
      /* 2026-09-16 (user's decision): the six uniques are **mythic**. They have no grade, so they skip
         `rarityForGrade` and the rarity is written here directly (`WeaponGrade` is still I..V — see the comment
         on `shared/labels.rarityForGrade`). Tooltips · sorting · the tile border · the grade letter all read the
         `RARITY_*` tables, so changing this one line carries them along. ⚠ A crate roll knows five rarities only
         (`RARITY_ORDER_LOOT`), so the moment they became mythic they **left the candidates of the crate weapon
         pick** — uniques now come from crafting (a mythic mineral) · a boss corpse · a named drop. */
      id: itemIdForWeapon(w.id), name: w.name, category: w.slot, rarity: 'mythic',
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
/** A row of `data/ammo.csv` (one calibre = one row). */
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
/* 2026-09-15: the weight is the `weight` column of `attachments.csv` — a constant `ATTACHMENT_WEIGHT = 0.3`
 * used to decide it here, so the column lived in the header and nobody read it (a breach of "no numbers in code"). */

export const ATTACHMENT_ITEM_DEFS: readonly ItemDef[] = csvRows('attachments.csv').map((r) => {
  const effects: AttachmentEffects = {};
  const mul = (key: 'recoilV' | 'recoilH' | 'spread' | 'hipSpread' | 'adsTime' | 'magSize' | 'adsZoom' | 'sway' | 'falloffRange' | 'falloffLoss' | 'bulletDrop'): void => {
    const v = r.optNum(key, { min: 0 });
    if (v !== undefined) effects[key] = v;
  };
  mul('recoilV'); mul('recoilH'); mul('spread'); mul('hipSpread'); mul('adsTime'); mul('magSize'); mul('adsZoom');
  // 2026-09-14 (gun balance): aim sway · falloff range / loss · bullet drop multipliers
  mul('sway'); mul('falloffRange'); mul('falloffLoss'); mul('bulletDrop');
  if (r.has('scope')) effects.scope = r.bool('scope');
  if (r.has('laser')) effects.laser = r.bool('laser');
  const classes: WeaponClass[] = r.enumList('classes', WEAPON_CLASSES);
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
    description: r.str('description'), attachment, weight: r.num('weight', { min: 0 }),
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

/* ── seeds (Phase 8) — data/seeds.csv ──────────────────────────────────────────
 * Planted in a greenhouse grow station; `SeedDef.growHours` is **real** wall-clock time and keeps running while
 * the game is closed (housing/ owns the plots). Loot (tier 1–3 containers, bug corpses) + the corporation shop
 * only — never craftable.
 *
 * 2026-09-11 (greenhouse rework): every row carries a **`soilTag`** — a crop grows `SOIL_MATCH_SPEEDUP` faster
 * when it matches the tag of the soil poured into that slot and `SOIL_MISMATCH_PENALTY` slower when it does not
 * (`housing/` judges it). It is a required column, so `r.enum` gets no fallback — a row that omits it is caught
 * by `npm run data:check`. */
/** Seeds share the category glyph and a leaf-green tint so a seed reads as one at a glance in the grid. */
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
      /* 2026-09-15: the weight is the new `weight` column of `seeds.csv` (`SEED_WEIGHT` in the old
         `tuning.csv` is retired). */
      seed, weight: r.num('weight', { min: 0 }),
    }),
    color: SEED_COLOR,
  };
});

/* ── unidentified samples (A-12, 2026-09-11 · cooking material tiers 2026-09-13) — data/samples.csv ───
 * The material the lab's **analyzer** analyses. `SampleDef.analyzeHours` is the **real time** at analysis level 1
 * (the same wall-clock convention as a seed's `growHours`); cutting it by the level multiplier is `housing/Rules`.
 * Neither crafted nor sold — bug corpses · sample gather nodes · tier 3+ containers · the bonus mineral of a scrap
 * pile, and nothing else (rogues have no interest in samples).
 *
 * 2026-09-13 (user's decision: the three sample kinds merged): `family` (cell | mineral | dna) is required — the
 * analyzer rolls the result table of the **family** (`ANALYSIS_RESULTS` in `shared/housing`), not of the sample.
 * `rewardDefId` · `rewardQty` are the fallback output for when that table is empty.
 * The old 11 keep their defs as `retired` (put into the analyzer they resolve through their own family).
 * **The first-analysis bonus (`first*`) is gone** — the loader no longer attaches it, and a filled cell is
 * reported rather than silently ignored. */
/*
 * 2026-09-16 (user's decision, a sample = family × rarity): **the tile background is the rarity colour and the
 * glyph is the family**. Before this every sample wore the one category colour (`CATEGORY_COLOR.sample`) and the
 * one category glyph, so 「미확인 유전자 I」 and 「미확인 광물 VI」 looked identical in the grid — and a sample's
 * rarity **is the floor of what analysing it yields**, a value that has to be readable at a glance
 * (`data/samples.csv`'s header).
 *
 * `ItemDef` has one colour, `color`, and it decides the tile's `--rc` outright (border · background gradient ·
 * glyph — `inventory/ui/GridView.buildTileContent`). So **background = the rarity colour** was chosen (= leaving
 * `def()`'s default alone) and the family's identity is carried by the **glyph shape** (`SAMPLE_FAMILY_ICON`).
 * The family colour (`SAMPLE_FAMILY_COLOR`) is still used by the analysis screens · the catalogue · tooltips —
 * painting two colours on one tile would need a glyph-only colour on `ItemDef` and `inventory` reading it, so
 * those two folders get fixed together when that happens.
 */
const SAMPLE_ICON: Readonly<Record<SampleFamily, string>> = SAMPLE_FAMILY_ICON;

export const SAMPLE_ITEM_DEFS: readonly ItemDef[] = csvRows('samples.csv').map((r) => {
  if (r.has('firstDefId') || r.has('firstQty')) r.report('firstDefId', '첫 해석 보너스(first*)는 2026-09-13 부터 없다 — 칸을 비운다');
  const sample: SampleDef = {
    analyzeHours: r.num('analyzeHours', { min: 0 }),
    rewardDefId: r.str('rewardDefId'),
    rewardQty: r.int('rewardQty', { min: 1 }),
    family: r.enum('family', SAMPLE_FAMILIES),
  };
  const retired = r.has('retired') && r.bool('retired');
  /* The colour is not overwritten — `def()` puts `RARITY_COLORS[rarity]` in (see the comment above). */
  return def({
    id: r.str('id'), name: r.str('name'), category: 'sample', rarity: r.enum('rarity', RARITY_ORDER),
    width: 1, height: 1, stackMax: T.num('SAMPLE_STACK_MAX'),
    value: r.int('value', { min: 0 }), icon: SAMPLE_ICON[sample.family], description: r.str('description'),
    sample, weight: T.num('SAMPLE_WEIGHT'),
    ...(retired ? { retired: true } : {}),
  });
});

/* ── sockets (cooking material tiers, 2026-09-13) — data/sockets.csv ───────────
 * A **permanent upgrade** fitted into the soil poured into a grow slot (`target: 'soil'`) or the medium poured
 * into a culture slot (`'medium'`). It comes only from the analyzer analysing unidentified DNA
 * (`data/analysis_results.csv`) — there is no craft, shop or loot row for one. Fitting and the effect maths are
 * `housing/` (`parts/Sockets`); items only moves the table.
 *
 * 1×1 · stack `SOCKET_STACK_MAX` · weight `SOCKET_WEIGHT` (tuning). The icon is the category glyph but **the
 * colour is the rarity colour** — I · II · III of the same factor must read apart by colour in the grid (the same
 * reason as the meals). `amount` is a ratio for speed · wear and the chance of +1 for yield, so all three
 * run 0 … 1. */
const SOCKET_ICON = CATEGORY_ICON.socket;

export const SOCKET_ITEM_DEFS: readonly ItemDef[] = csvRows('sockets.csv').map((r) => {
  const growSocket: GrowSocketDef = {
    target: r.enum('target', GROW_SOCKET_TARGETS),
    effect: r.enum('effect', GROW_SOCKET_EFFECTS),
    amount: r.num('amount', { min: 0, max: 1 }),
  };
  if (growSocket.amount <= 0) r.report('amount', '수치가 0 인 소켓은 아무 효과가 없다');
  return def({
    id: r.str('id'), name: r.str('name'), category: 'socket', rarity: r.enum('rarity', RARITY_ORDER),
    width: 1, height: 1, stackMax: T.num('SOCKET_STACK_MAX'),
    value: r.int('value', { min: 0 }), icon: SOCKET_ICON, description: r.str('description'),
    growSocket, weight: T.num('SOCKET_WEIGHT'),
  });
});

/* ── meals — 2026-09-16 (the plate model, user's decision): **not items.** ─────
 * A meal cooked at the cook bench becomes the dining table's plate (`ShipState.plate`). The one place that reads
 * `data/meals.csv` is `shared/meals.ts` (`MEAL_DEFS` · `getMealDef`), and `ITEM_DEFS` holds no meal —
 * `ctx.loot.getItemDef('meal_*')` is undefined. A meal item in an old save resolves to an unknown def (the game
 * is in development — no migration, no refund, user's decision). */

/* ── library media: books · videos · records (2026-09-13, docs/DECISIONS.md 「2026-09-13 — 서재 시리즈 · 비디오게임」) ───
 * The items are built from a **series** (`data/library_series.csv`; the effect · planet loader is
 * `LIBRARY_SERIES_DEFS` in `shared/library`) — one series row = as many items as it has volumes. The old
 * one-book-per-skill ids (`book_<skill>` · `disc_<skill>` · `record_<skill>`) are gone, and `data/item_aliases.csv`
 * moves those ids in saves and on the wire to volume 1 of the new series (`resolveItemAlias`).
 *
 *  - id     = `book_<series>_<volume>` · `disc_<series>_<volume>` · `record_<series>` (the id shape a housing save
 *             expects, `^(book|disc|record|game)_…`).
 *  - name   = the series name + the volume's roman numeral (a one-shot gets no numeral).
 *  - `ItemDef.book` / `disc` / `record` = `{ skill, series, volume }` — `skill` is only the **lead skill** (sorting ·
 *    the catalogue grouping); the effects are decided by the series' effect rows alone. When the csv's `skill` cell
 *    is empty it is the skill of the first skillGain row.
 *  - rarity: a book has no rarity, so every one is `LIBRARY_ITEM_RARITY.book` from `tables.csv`; a video · record
 *    takes the series' `rarity` cell.
 *  - value:  book `BOOK_VALUE_BY_VOLUME[volume]` · video `DISC_VALUE_BY_RARITY × (1 + DISC_VALUE_VOLUME_STEP ×
 *            (volume − 1))` · record `RECORD_VALUE_BY_RARITY`.
 *  - cells · weight are those of the old media (book 1×2 · video 2×2 · record 3×3, `BOOK_WEIGHT` · `DISC_WEIGHT` ·
 *    `RECORD_WEIGHT`), and none of them stack.
 * They drop only on the series' own planet, by volume weight (`LootTables.isLootableOnPlanet` ·
 * `libraryVolumeWeight`). No craft, no shop, no quick slot.
 * Table-to-table checks — series ↔ item 1:1 · a book series per skill · recipe targets · planet threat — are
 * `scripts/data-check.mjs`. */
type LibraryItemRow = ReturnType<typeof csvRows>[number];
const LIBRARY_ITEM_ROWS: ReadonlyMap<string, LibraryItemRow> = new Map(csvRows('library_series.csv').map((r) => [r.raw('id'), r] as const));
const BOOK_VALUE_BY_VOLUME = numberMap<string>('tables.csv', 'BOOK_VALUE_BY_VOLUME');
const DISC_VALUE_BY_RARITY = numberMap<Rarity>('tables.csv', 'DISC_VALUE_BY_RARITY');
const RECORD_VALUE_BY_RARITY = numberMap<Rarity>('tables.csv', 'RECORD_VALUE_BY_RARITY');
const DISC_VALUE_VOLUME_STEP = T.num('DISC_VALUE_VOLUME_STEP');
const LIBRARY_ITEM_RARITY = stringMap<'book'>('tables.csv', 'LIBRARY_ITEM_RARITY');

/** A book's rarity — books have none, so every one is this value (`LIBRARY_ITEM_RARITY.book` in `tables.csv`;
 * a wrong value is caught by data:check and falls back to uncommon here). */
export const LIBRARY_BOOK_RARITY: Rarity = (RARITY_ORDER as readonly string[]).includes(LIBRARY_ITEM_RARITY.book)
  ? LIBRARY_ITEM_RARITY.book as Rarity : 'uncommon';

interface LibraryMediumSpec {
  width: number;
  height: number;
  weight: number;
  value: (rarity: Rarity, volume: number) => number;
}

const LIBRARY_MEDIUM_SPEC: Readonly<Record<LibraryMedium, LibraryMediumSpec>> = {
  book: { width: 1, height: 2, weight: T.num('BOOK_WEIGHT'), value: (_rarity, volume) => BOOK_VALUE_BY_VOLUME[String(volume)] ?? 0 },
  disc: {
    width: 2, height: 2, weight: T.num('DISC_WEIGHT'),
    value: (rarity, volume) => Math.round((DISC_VALUE_BY_RARITY[rarity] ?? 0) * (1 + DISC_VALUE_VOLUME_STEP * (volume - 1))),
  },
  record: { width: 3, height: 3, weight: T.num('RECORD_WEIGHT'), value: (rarity) => RECORD_VALUE_BY_RARITY[rarity] ?? 0 },
};

const VOLUME_ROMAN: readonly string[] = ['', 'I', 'II', 'III', 'IV', 'V'];

/** The item id of one volume of a series (`book_carry_manual_2` · `disc_rifle_range_1` · `record_porters_song`). */
export function libraryItemIdFor(medium: LibraryMedium, seriesId: string, volume: number): string {
  return medium === 'record' ? `record_${seriesId}` : `${medium}_${seriesId}_${volume}`;
}

/** The item name of one volume — the series name + a roman numeral (a one-shot keeps the name alone). */
export function libraryItemName(seriesName: string, volumes: number, volume: number): string {
  return volumes > 1 ? `${seriesName} ${VOLUME_ROMAN[volume] ?? String(volume)}` : seriesName;
}

function libraryItemDefs(medium: LibraryMedium): ItemDef[] {
  const spec = LIBRARY_MEDIUM_SPEC[medium];
  const out: ItemDef[] = [];
  for (const s of LIBRARY_SERIES_DEFS) {
    if (s.medium !== medium) continue;
    const row = LIBRARY_ITEM_ROWS.get(s.id);
    let rarity: Rarity = LIBRARY_BOOK_RARITY;
    if (medium === 'book') {
      if (row?.has('rarity')) row.report('rarity', '책은 등급이 없다 — 칸을 비운다 (tables.csv 의 LIBRARY_ITEM_RARITY.book)');
    } else if (row) {
      rarity = row.enum('rarity', RARITY_ORDER);
    }
    const firstSkill = s.effects.find((e) => e.kind === 'skillGain')?.target as SkillId | undefined;
    const skill = row?.optEnum('skill', SKILL_IDS) ?? firstSkill;
    if (!skill) row?.report('skill', 'skillGain 효과가 없는 시리즈는 대표 숙련(skill)을 적는다');
    for (let volume = 1; volume <= s.volumes; volume++) {
      const shelf: BookDef = { skill: skill ?? SKILL_IDS[0], series: s.id, volume };
      out.push({
        ...def({
          id: libraryItemIdFor(medium, s.id, volume), name: libraryItemName(s.name, s.volumes, volume), category: medium, rarity,
          width: spec.width, height: spec.height, stackMax: 1, value: spec.value(rarity, volume),
          icon: CATEGORY_ICON[medium], description: s.description, weight: spec.weight,
          ...(medium === 'book' ? { book: shelf } : medium === 'disc' ? { disc: shelf } : { record: shelf }),
        }),
        color: CATEGORY_COLOR[medium],
      });
    }
  }
  return out;
}

/** Every book — series order × volume order. */
export const BOOK_ITEM_DEFS: readonly ItemDef[] = libraryItemDefs('book');
/** Every video (disc) — series order × volume order. */
export const DISC_ITEM_DEFS: readonly ItemDef[] = libraryItemDefs('disc');
/** Every record (one series = one disc). */
export const RECORD_ITEM_DEFS: readonly ItemDef[] = libraryItemDefs('record');
/** Every library-effect media item (books · videos · records). */
export const LIBRARY_ITEM_DEFS: readonly ItemDef[] = [...BOOK_ITEM_DEFS, ...DISC_ITEM_DEFS, ...RECORD_ITEM_DEFS];

/** The `{ skill, series, volume }` of a library media item (undefined when it is not a book · video · record). */
export function libraryShelfOf(d: ItemDef | undefined): BookDef | undefined {
  return d ? (d.book ?? d.disc ?? d.record) : undefined;
}

/** Series id → its items in volume order (index = volume − 1). */
export const LIBRARY_ITEMS_BY_SERIES: ReadonlyMap<string, readonly ItemDef[]> = (() => {
  const out = new Map<string, ItemDef[]>();
  for (const d of LIBRARY_ITEM_DEFS) {
    const shelf = libraryShelfOf(d);
    if (!shelf?.series) continue;
    const list = out.get(shelf.series);
    if (list) list.push(d); else out.set(shelf.series, [d]);
  }
  return out;
})();

/** The series' item for `volume` (undefined when there is none). */
export function libraryItemDefOf(seriesId: string, volume: number): ItemDef | undefined {
  return LIBRARY_ITEMS_BY_SERIES.get(seriesId)?.find((d) => libraryShelfOf(d)?.volume === volume);
}

/* ── video games: consoles · game discs (2026-09-13) — data/game_consoles.csv · data/game_discs.csv ───
 * A console (`category: 'console'`, `ItemDef.gameConsole {console}`) is mounted on the library TV, and a game disc
 * (`category: 'game_disc'`, `ItemDef.gameDisc {console, stat, minigame, tuning, color}`) is slotted into the game
 * disc stand to be played on that TV (housing/). Consoles come from the `3D 프린터` (recipes.csv) plus a rare drop;
 * game discs drop only. Both appear on threat 2+ planets only — `ItemDef` has no cell for a planet list, so it is
 * handed out through `GAME_ITEM_PLANETS` (the drop filter is `LootTables.lootPlanetsOf`) and data:check does the
 * threat check. The colour is the category colour (as for library media — the rarity border tells rarities apart).
 * `gameDisc.color` is the game screen's theme colour. */
/** The pattern tokens of a beat minigame (`GymGameTuning.pattern`) — press has no pattern. */
export const GAME_PATTERN_TOKENS: Readonly<Record<GymMinigame, readonly string[]>> = { press: [], breath: ['t', 'h', 'r'], cycle: ['L', 'R', 'r'] };
const GAME_MINIGAMES = Object.keys(GYM_MINIGAME_LABEL_KO) as GymMinigame[];
const GAME_PLANETS = new Map<string, readonly PlanetId[]>();

function gamePlanetsCell(r: LibraryItemRow, id: string): void {
  const planets: PlanetId[] = [];
  for (const p of r.list('planets')) {
    if ((PLANET_IDS as readonly string[]).includes(p)) planets.push(p as PlanetId);
    else r.report('planets', `행성 '${p}' 를 모른다 (${PLANET_IDS.join(' · ')})`);
  }
  if (planets.length === 0) r.report('planets', '등장 행성이 하나 이상 있어야 한다');
  GAME_PLANETS.set(id, planets);
}

export const GAME_CONSOLE_ITEM_DEFS: readonly ItemDef[] = csvRows('game_consoles.csv').map((r) => {
  const id = r.str('id');
  if (!/^console_[a-z0-9_]{1,40}$/.test(id)) r.report('id', `게임기 id '${id}' 는 console_<소문자 이름> 이어야 한다`);
  gamePlanetsCell(r, id);
  return {
    ...def({
      id, name: r.str('name'), category: 'console', rarity: r.enum('rarity', RARITY_ORDER),
      width: r.int('width', { min: 1 }), height: r.int('height', { min: 1 }), stackMax: 1,
      value: r.int('value', { min: 0 }), weight: r.num('weight', { min: 0 }),
      icon: CATEGORY_ICON.console, description: r.str('description'), gameConsole: { console: r.str('console') },
    }),
    color: CATEGORY_COLOR.console,
  };
});

const GAME_CONSOLE_KINDS: ReadonlySet<string> = new Set(GAME_CONSOLE_ITEM_DEFS.map((d) => d.gameConsole!.console));

export const GAME_DISC_ITEM_DEFS: readonly ItemDef[] = csvRows('game_discs.csv').map((r) => {
  const id = r.str('id');
  if (!/^game_[a-z0-9_]{1,40}$/.test(id)) r.report('id', `게임 디스크 id '${id}' 는 game_<소문자 이름> 이어야 한다 (서재 보관함 세이브의 id 모양)`);
  gamePlanetsCell(r, id);
  const consoleKind = r.str('console');
  if (!GAME_CONSOLE_KINDS.has(consoleKind)) r.report('console', `게임기 규격 '${consoleKind}' 가 game_consoles.csv 에 없다`);
  const minigame = r.enum('minigame', GAME_MINIGAMES);
  const tuning: GymGameTuning = {};
  for (const key of ['speedMul', 'windowMul', 'countMul'] as const) {
    const v = r.optNum(key, { min: 0 });
    if (v === undefined) continue;
    if (v <= 0) { r.report(key, '0 보다 커야 한다 (비우면 헬스와 같다)'); continue; }
    tuning[key] = v;
  }
  const pattern = r.optStr('pattern');
  if (pattern) {
    const allowed = GAME_PATTERN_TOKENS[minigame];
    if (allowed.length === 0) r.report('pattern', `${minigame} 는 박자 패턴이 없다 — 칸을 비운다`);
    else {
      const bad = pattern.split('-').filter((t) => !allowed.includes(t));
      if (bad.length) r.report('pattern', `'${bad.join(', ')}' 는 ${minigame} 패턴 토큰(${allowed.join(' · ')})이 아니다 — 토큰을 - 로 잇는다`);
      else tuning.pattern = pattern;
    }
  }
  const color = r.str('color');
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) r.report('color', `'${color}' 는 #rrggbb 색이 아니다`);
  const stat: GameStat = r.enum('stat', GAME_STATS);
  return {
    ...def({
      id, name: r.str('name'), category: 'game_disc', rarity: r.enum('rarity', RARITY_ORDER),
      width: r.int('width', { min: 1 }), height: r.int('height', { min: 1 }), stackMax: 1,
      value: r.int('value', { min: 0 }), weight: r.num('weight', { min: 0 }),
      icon: CATEGORY_ICON.game_disc, description: r.str('description'),
      gameDisc: { console: consoleKind, stat, minigame, tuning, color },
    }),
    color: CATEGORY_COLOR.game_disc,
  };
});

/** Console · game disc id → the planets whose crates drop it (the `planets` column of `game_*.csv`). */
export const GAME_ITEM_PLANETS: ReadonlyMap<string, readonly PlanetId[]> = GAME_PLANETS;

/* ── armor generated from the ArmorDef table (tactical kit) ───────────────── */
const armorItem = (a: ArmorDef): ItemDef => {
  const { width, height } = armorItemSize(a);
  return def({
    id: a.id, name: a.name, description: a.description, category: 'armor', rarity: a.rarity,
    width, height,
    /* 2026-09-10: the price comes from the shield, not from damage reduction (`ARMOR_VALUE_SHIELD_MUL` 12.6 =
       the old 4200 × 0.3 ÷ 100, so the value is unchanged). */
    value: Math.round(T.num('ARMOR_VALUE_BASE') + a.shield * T.num('ARMOR_VALUE_SHIELD_MUL') + a.durabilityMax * T.num('ARMOR_VALUE_DUR_MUL')),
    icon: ARMOR_ICON[a.id] ?? '⛊', armorId: a.id, weight: a.weight, durabilityMax: a.durabilityMax,
  });
};

/* ── generic items (grenades · healing · valuables · materials · herbs · gadgets) — data/items.csv ─── */
/**
 * One `items.csv` row → one `ItemDef`. They are kept split by category, so `ITEM_DEFS` is assembled in exactly
 * the order it always was (that order is the UI list order).
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
  /* 2026-09-11 (greenhouse rework): only a `category: 'soil'` row fills `soilTag` · `soilUses` — the same
   * optional column convention as `heal*` · `gadgetId` (an empty cell means the field is never attached). `uses`
   * is how many harvests one pour of soil survives, and its rarity curve is `SOIL_USES_BY_RARITY`
   * (data/tables.csv) — the csv value is the number actually used. */
  /* 2026-09-13 (cooking material tiers): soil requires a **max durability** (`soilDurability`) — poured soil wears
   * down with every harvest and still works at 0, but the bonus shrinks with the durability ratio (`housing/`).
   * `uses` is left only to move an old save's remaining count over to durability. */
  const soil: SoilDef | undefined = r.has('soilTag')
    ? { tag: r.enum('soilTag', SOIL_TAGS) as SoilTag, uses: r.int('soilUses', { min: 1 }), durability: r.int('soilDurability', { min: 1 }) }
    : undefined;
  if (!soil && r.has('soilDurability')) r.report('soilDurability', '토양(soilTag)이 아닌 줄에 토양 내구도가 있다');
  /* 2026-09-11 (A-13): only a `category: 'prep'` row fills `prepEnv` · `prepShort` — the same optional column
   * convention as `soil`. `env` is the planet environment this preparation blocks **completely**, and `short` is
   * the short name printed on the HUD badge (「방독」 · 「내열」).
   * It is read by `progression` (one raid's worth), `player` (the damage exemption) and `ui` (badge · tooltip);
   * items only moves the table. */
  const prepEnv = r.optEnum('prepEnv', ENV_KINDS);
  const prep: PrepDef | undefined = prepEnv ? { env: prepEnv, short: r.str('prepShort') } : undefined;
  /* 2026-09-11 (A-15, the printer): only a `category: 'pouch'` row fills `pouchCols` · `pouchRows` ·
   * `pouchAccepts`. `accepts` is an `ItemCategory` list joined by `|`, so `enumList` **reports an unknown name by
   * itself** (`npm run data:check` picks that report up) — and to avoid writing the category names into items/ a
   * second time, the allowed list is taken from the keys of `CATEGORY_LABEL_KO` (a Record keyed by
   * `ItemCategory`, so it is never short of one). */
  const pouch: PouchDef | undefined = r.has('pouchCols')
    ? { cols: r.int('pouchCols', { min: 1 }), rows: r.int('pouchRows', { min: 1 }), accepts: r.enumList('pouchAccepts', ITEM_CATEGORIES) }
    : undefined;
  /* A pouch that accepts no category is an empty grid nothing fits into — a typo is not let through silently. */
  if (pouch && pouch.accepts.length === 0) r.report('pouchAccepts', '주머니가 받아 주는 카테고리가 하나도 없다');
  /* 2026-09-11 (A-14, the culture tank): strains (`strainOut`·`strainQty`·`strainHours`) · nutrient media
   * (`mediumUses`·`mediumSpeed`). Both are optional columns on a `category: 'material'` row, and what reads their
   * output · time is the culture tank in `housing/`.
   * Whether the item `outputDefId` names exists is not checked here — the same convention as
   * `SampleDef.rewardDefId` (`ITEM_DEF_MAP` does not exist yet; the name check belongs to `npm run data:check`). */
  /* 2026-09-13 (cooking material tiers, T3): with a **culture scaffold** in the culture slot a strain produces the
   * output of the three `strainScaffold*` cells instead (species meat). The three are filled together or left
   * empty together — a half-filled row is reported, not silently dropped. Whether the output id is a real item
   * belongs to `data:check`. */
  const strainOut = r.optStr('strainOut');
  const SCAFFOLD_COLS = ['strainScaffoldOut', 'strainScaffoldQty', 'strainScaffoldHours'] as const;
  const scaffoldCols = SCAFFOLD_COLS.filter((c) => r.has(c)).length;
  if (scaffoldCols > 0 && scaffoldCols < SCAFFOLD_COLS.length) {
    r.report('strainScaffoldOut', '스캐폴드 산출 3칸(strainScaffoldOut · strainScaffoldQty · strainScaffoldHours)은 함께 채우거나 함께 비운다');
  }
  if (!strainOut && scaffoldCols > 0) r.report('strainScaffoldOut', '세포주(strainOut)가 아닌 줄에 스캐폴드 산출이 있다');
  const strain: StrainDef | undefined = strainOut
    ? {
      outputDefId: strainOut, outputQty: r.int('strainQty', { min: 1 }), cultureHours: r.num('strainHours', { min: 0 }),
      ...(scaffoldCols === SCAFFOLD_COLS.length ? {
        scaffoldOutputDefId: r.str('strainScaffoldOut'),
        scaffoldOutputQty: r.int('strainScaffoldQty', { min: 1 }),
        scaffoldHours: r.num('strainScaffoldHours', { min: 0 }),
      } : {}),
    }
    : undefined;
  /* 2026-09-13: a medium follows the same durability rule as soil (user's decision) — `mediumDurability` is
   * required and `uses` is left only for migrating an old save. */
  const medium: MediumDef | undefined = r.has('mediumUses')
    ? { uses: r.int('mediumUses', { min: 1 }), speedMul: r.num('mediumSpeed', { min: 0 }), durability: r.int('mediumDurability', { min: 1 }) }
    : undefined;
  if (!medium && r.has('mediumDurability')) r.report('mediumDurability', '영양 배지(mediumUses)가 아닌 줄에 배지 내구도가 있다');
  /* 2026-09-13: the culture scaffold · retirement. A retired strain must empty its strain cells so the culture
   * tank will not take it — a leftover is reported. */
  const scaffold = r.has('scaffold') && r.bool('scaffold');
  const retired = r.has('retired') && r.bool('retired');
  if (retired && strain) r.report('strainOut', '은퇴한 세포주는 strain* 칸을 비운다 (배양조가 받지 않게)');
  /* 2026-09-15 (B-16 · user's bug report 「소이 수류탄에 불 지대가 안 만들어진다」): `grenadeFire` = this grenade
   * makes a small blast plus a fire zone where it landed instead of a high-explosive burst (weapons `Grenade` →
   * `ctx.gadgets.igniteGrenadeFire`). On a row that is not a grenade nobody reads it, so it is reported. */
  /* 2026-09-15 (gadget rework, user's decision): `'grenade'` was dropped from `ItemCategory`, so a grenade is
   * `category: 'gadget'` too — the one value that tells a grenade apart is the `grenade` column
   * (`ItemDef.grenade`), and `grenadeFire` survives meaning exactly `grenade === 'fire'`. */
  const grenadeKind = r.has('grenade') ? (r.str('grenade') as GrenadeKind) : undefined;
  if (grenadeKind && grenadeKind !== 'frag' && grenadeKind !== 'fire') r.report('grenade', "수류탄 종류는 frag · fire 둘뿐이다");
  const grenadeFire = grenadeKind ? grenadeKind === 'fire' : (r.has('grenadeFire') && r.bool('grenadeFire'));
  if (grenadeFire && !grenadeKind) r.report('grenadeFire', '수류탄(grenade 열)이 아닌 줄에 grenadeFire 가 있다');
  /* The hold time before a gadget is used or placed — `weapons/model.useTimeOf` reads it in the same frame as
   * a healing item. */
  const gadgetUseTime = r.has('gadgetUseTime') ? r.num('gadgetUseTime', { min: 0 }) : undefined;
  if (gadgetUseTime !== undefined && !r.has('gadgetId') && !grenadeKind) r.report('gadgetUseTime', '가젯 · 수류탄이 아닌 줄에 gadgetUseTime 이 있다');
  return def({
    id: r.str('id'), name: r.str('name'), category: r.str('category') as ItemCategory,
    rarity: r.str('rarity') as Rarity,
    width: r.int('width', { min: 1 }), height: r.int('height', { min: 1 }),
    stackMax: r.int('stackMax', { min: 1 }), value: r.int('value', { min: 0 }),
    weight: r.num('weight', { min: 0 }), icon: r.str('icon'),
    description: r.str('description'),
    ...(r.has('quickUsable') ? { quickUsable: r.bool('quickUsable') } : {}),
    ...(r.has('gadgetId') ? { gadgetId: r.str('gadgetId') as ItemDef['gadgetId'] } : {}),
    ...(grenadeKind ? { grenade: grenadeKind } : {}),
    ...(gadgetUseTime !== undefined ? { gadgetUseTime } : {}),
    ...(r.has('durabilityMax') ? { durabilityMax: r.num('durabilityMax', { min: 0 }) } : {}),
    ...(r.has('healAmount') ? { healAmount: r.num('healAmount', { min: 0 }) } : {}),
    ...(heal ? { heal } : {}),
    ...(soil ? { soil } : {}),
    ...(prep ? { prep } : {}),
    ...(pouch ? { pouch } : {}),
    ...(strain ? { strain } : {}),
    ...(medium ? { medium } : {}),
    ...(scaffold ? { scaffold: true } : {}),
    ...(retired ? { retired: true } : {}),
    ...(grenadeFire ? { grenadeFire: true } : {}),
  });
});

/** Picks one category out of `items.csv` (in the order the file lists them). */
const itemGroup = (category: ItemCategory): ItemDef[] => GENERIC_ITEM_DEFS.filter((d) => d.category === category);

/* 2026-09-11 (A-14 · A-15): the culture tank · printer materials (media · strains · culture products · filament)
 * are written **after** the preparations (`prep`) in `items.csv` and have to sit there in the list too — one block
 * reading "field → lab → printer". So the material group is split **at that boundary**, exactly as `items.csv`'s
 * own header comment says the file order is the display order; and since no item id is written into code, adding
 * a csv row is enough to put it in place. */
const PREP_ROW_AT = GENERIC_ITEM_DEFS.map((d) => d.category).lastIndexOf('prep');
/** The rows of that category before the `prep` rows (all of them when there is no preparation row at all). */
const itemGroupBeforePrep = (category: ItemCategory): ItemDef[] =>
  GENERIC_ITEM_DEFS.filter((d, i) => d.category === category && (PREP_ROW_AT < 0 || i < PREP_ROW_AT));
/** The rows of that category after the `prep` rows. */
const itemGroupAfterPrep = (category: ItemCategory): ItemDef[] =>
  GENERIC_ITEM_DEFS.filter((d, i) => d.category === category && PREP_ROW_AT >= 0 && i > PREP_ROW_AT);

/* ── shield chargers (2026-09-10) ──────────────────────────────────────────────
 * The three consumables that refill the **shield** (extra health) the armor gives. They are `category: 'stim'`
 * alongside the healing items, so quick slots · the loot category · the hand pose all follow for free. The only
 * difference is where the left-click hold ends up — **`PlayerRef.chargeShield`**, not `PlayerRef.applyHeal`.
 *
 * Why no new cell was opened on `ItemDef`: `src/shared` is a contract, not changed without coordination. Instead
 * one table lives here and `weapons/` and `inventory/` ask it through `shieldChargeOf(defId)` (both folders
 * already import `@/items` — see `WeaponDefaults.ts` · `inventory/Gear.ts`).
 */
export interface ShieldChargeDef {
  /** How long left-click must be held (s) — the same meaning as a healing item's `heal.useTime`. */
  useTime: number;
  /** How much shield it refills. `Infinity` = a full refill (when the csv's `shieldHp` is negative). */
  amount: number;
}

/** A row of `items.csv` with `shieldUseTime` / `shieldHp` filled = a shield charger. */
export const SHIELD_CHARGE_MAP: ReadonlyMap<string, ShieldChargeDef> = new Map(
  csvRows('items.csv')
    .filter((r) => r.has('shieldUseTime'))
    .map((r) => {
      const hp = r.num('shieldHp');
      return [r.str('id'), { useTime: r.num('shieldUseTime', { min: 0 }), amount: hp < 0 ? Infinity : hp }] as const;
    }),
);

/** The numbers when this item is a shield charger, undefined otherwise. */
export function shieldChargeOf(defId: string | undefined): ShieldChargeDef | undefined {
  return defId ? SHIELD_CHARGE_MAP.get(defId) : undefined;
}

/* ── the three combat consumables (2026-09-12 — 아드레날린 주사 · 각성제 · 안정제) ──────────
 * The same side-table convention as the shield chargers: `category: 'stim'` brings quick slots · the loot
 * category · the hand pose · the left-click hold for free, and the only difference is **where the hold ends up** —
 * `adrenaline` · `stimulant` go to `PlayerRef.applyBoost`, `implant_refill` to `ImplantsRef.refillAll`. They can
 * be used at full health (they do not take the healing item's "refuse when full" path).
 * The effect numbers are `BOOST_*` in `data/constants.csv`; only **the effect kind and the hold time** live here.
 */
export type BoostEffect = BoostKind | 'implant_refill';
export const BOOST_EFFECTS: readonly BoostEffect[] = ['adrenaline', 'stimulant', 'implant_refill'];

export interface BoostItemDef {
  effect: BoostEffect;
  /** How long left-click must be held (s) — the same meaning as a healing item's `heal.useTime`. */
  useTime: number;
}

/** A row of `items.csv` with `boostEffect` / `boostUseTime` filled = a combat consumable. */
export const BOOST_ITEM_MAP: ReadonlyMap<string, BoostItemDef> = new Map(
  csvRows('items.csv')
    .filter((r) => r.has('boostEffect'))
    .map((r) => [r.str('id'), {
      effect: r.enum('boostEffect', BOOST_EFFECTS) as BoostEffect,
      useTime: r.num('boostUseTime', { min: 0 }),
    }] as const),
);

/** The effect · hold time when this item is a combat consumable, undefined otherwise. */
export function boostItemOf(defId: string | undefined): BoostItemDef | undefined {
  return defId ? BOOST_ITEM_MAP.get(defId) : undefined;
}

/* ── definitions ──────────────────────────────────────────────────────────── */
export const ITEM_DEFS: readonly ItemDef[] = [
  /* weapons — primary / secondary (do not occupy grid cells while equipped) */
  ...WEAPON_ITEM_DEFS,
  /* healing items (2026-09-15: the two grenades became `category: 'gadget'` and moved to the front of the
     gadget group below — the csv order itself is unchanged) */
  ...itemGroup('stim'),
  /* ammo v2 · attachments · bags */
  ...AMMO_ITEM_DEFS,
  ...ATTACHMENT_ITEM_DEFS,
  ...BAG_ITEM_DEFS,
  /* valuables — value and weight are deliberately uncorrelated */
  ...itemGroup('valuable'),
  /* materials · herbs (gathered from world plants) — the culture tank · printer materials are in the lab
     group below */
  ...itemGroupBeforePrep('material'),
  ...itemGroup('herb'),
  /* 2026-09-11 greenhouse rework: crops (the `재배층` harvest — sold · delivered to `세레스`) · soil (gather
     nodes only, poured into the `재배층`). Placed right after the herbs so "what came out of the field" reads as
     one block in the list. */
  ...itemGroup('crop'),
  ...itemGroup('soil'),
  /* 2026-09-16 (the plate model, user's decision): a meal is no longer an item — it is the dining table's
     plate. The table is `shared/meals.ts` (`getMealDef`). */
  /* 2026-09-11 the lab (A-12 · A-13): samples (the analyzer analyses them — `samples.csv`) · preparations
     (used in the ship and carried as one raid's worth). What the lab uses sits right after what came out of the
     field. */
  ...SAMPLE_ITEM_DEFS,
  /* 2026-09-13 cooking material tiers: sockets (the analyzer pulls them out of unidentified DNA — they fit
     into soil · a medium) sit right after the samples. */
  ...SOCKET_ITEM_DEFS,
  ...itemGroup('prep'),
  /* 2026-09-11 the culture tank · printer (A-14 · A-15): nutrient media · strains · culture products ·
     filament (all `material`) → the pouches that filament prints → the keys a pouch carries. The chain reads in
     order. */
  ...itemGroupAfterPrep('material'),
  ...itemGroup('pouch'),
  ...itemGroup('key'),
  /* seeds (Phase 8: planted in the greenhouse `재배층`) · books (Phase 9: shelved on the library bookshelf) */
  ...SEED_ITEM_DEFS,
  ...BOOK_ITEM_DEFS,
  /* 2026-09-12 (A-3e): library media — the same role as a book, so right after them (disc stand · record rack) */
  ...DISC_ITEM_DEFS,
  ...RECORD_ITEM_DEFS,
  /* 2026-09-13 (video games): consoles (mounted on the TV) · game discs (the game disc stand) — right after
     the library media */
  ...GAME_CONSOLE_ITEM_DEFS,
  ...GAME_DISC_ITEM_DEFS,
  /* implants (Phase 12: equipped on the `캐릭터` tab; only broken ones are loot, `세레스 바이오` repairs and
     sells them — `ImplantDefs.ts`) */
  ...IMPLANT_ITEM_DEFS,
  /* gadgets — the two grenades come first (behaviour lives in src/gadgets; here they are just consumables) */
  ...itemGroup('gadget'),
  /* armor generated from the ArmorDef table */
  ...ARMOR_DEFS.map(armorItem),
];

export const ITEM_DEF_MAP: ReadonlyMap<string, ItemDef> = new Map(ITEM_DEFS.map((d) => [d.id, d]));

/** 2026-09-13: an old id (`data/item_aliases.csv`) is resolved to the new id before the lookup — the safety net
 * for an id the save-migrating folders missed. `ITEM_DEF_MAP` knows exact ids only. */
export function getItemDef(defId: string): ItemDef | undefined {
  return ITEM_DEF_MAP.get(defId) ?? ITEM_DEF_MAP.get(resolveItemAlias(defId));
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
 * Minimum kit (2026-09-07). No longer handed out at every `world:ready` — the player equips out of the ship
 * stash (`STARTER_STASH`, granted once on a fresh profile). `inventory` only falls back to this when the loadout
 * **and** the stash are empty, so a player who lost everything is never stuck with no way to raid.
 */
export const STARTER_LOADOUT = {
  // 2026-09-10: the secondary is gone, so the minimum kit is one primary too (it used to be a
  // `secondary: 'wpn_hg'` pistol).
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
 * The starter grant (2026-09-07): written into the ship stash **once**, on a profile that has never had a stash.
 * `qty` is units **per stack** (ammo: rounds, clamped to the def's `stackMax`) and `stacks` how many of them —
 * one set per stack, so `{ ammo_light, qty: 80, stacks: 10 }` is the ten sets of light ammo of the starter grant.
 */
export const STARTER_STASH: readonly { id: string; qty: number; stacks?: number }[] = [
  /* ten sets of each calibre (one set = one full cell) */
  { id: 'ammo_light', qty: AMMO_STACK_ROUNDS.light, stacks: 10 },
  { id: 'ammo_medium', qty: AMMO_STACK_ROUNDS.medium, stacks: 10 },
  { id: 'ammo_heavy', qty: AMMO_STACK_ROUNDS.heavy, stacks: 10 },
  { id: 'ammo_shell', qty: AMMO_STACK_ROUNDS.shell, stacks: 10 },
  /* one common-grade gun of each kind (the pistol is not granted on top of the equipped starter one) */
  { id: 'wpn_smg', qty: 1 },
  { id: 'wpn_sg', qty: 1 },
  { id: 'wpn_ar', qty: 1 },
  { id: 'wpn_dmr', qty: 1 },
  { id: 'wpn_sr', qty: 1 },
  /* spare bags · armor (what is equipped is STARTER_LOADOUT) */
  { id: 'bag_common', qty: 1, stacks: 3 },
  { id: 'armor_1', qty: 1, stacks: 3 },
  /* The whole first facility chain: building the workshop (`ROOM_PURPOSE_BUILD_COST.workshop` — `폐금속` 8 ·
     `케이블` 2) + crafting the `총기 작업대` (`furn_bench_gun.craft` — `폐금속` 8 · `합금` 2 · `케이블` 1) =
     `폐금속` 16 · `케이블` 3 · `합금` 2. 2026-09-08: spending up to generator Lv.1 (`폐금속` 4) left too little
     `폐금속`, so it was raised to 24 · 4 · 3. 2026-09-13: the generator starts at Lv.1, so 8 `폐금속` is left
     over (kept as is). */
  { id: 'mat_scrap', qty: 8, stacks: 3 },
  { id: 'mat_cable', qty: 4 },
  { id: 'mat_alloy', qty: 3 },
  /* consumables */
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
