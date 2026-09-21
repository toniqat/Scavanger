import type { EnemyType, ItemCategory, ItemDef, Rarity, WeaponGrade } from '@/shared';
/* appended (2026-09-13): humanoid faction loot — spawn site bonuses · planet seed pools */
import type { EnemySpawnSite, PlanetId } from '@/shared';
import { UNIQUE_WEAPON_IDS, csvGroups, csvRows } from '@/shared';
/* 2026-09-21: a survey camera is never loot (`isLootableDef`) */
import { surveyCameraOf } from '@/shared';
/* appended (2026-09-21): planet-bound keys — one key kind covers its per-planet variants */
import { PLANET_IDS } from '@/shared';

/*
 * The source of every loot number is `data/loot_*.csv` — the tier roll rules (`loot_tiers.csv`), category
 * weights, guaranteed picks, per-item multipliers and corpse drops (`loot_corpses.csv` · `loot_corpse_rolls.csv`).
 * This file holds no table of its own, only the code that moves those rows into typed tables.
 */
import { WEAPON_FAMILIES, WEAPON_GRADES } from './WeaponDefs';
import { ITEM_DEF_MAP, UNIQUE_AMMO_TYPES, ammoItemIdFor, itemIdForWeapon } from './ItemDefs';
/* appended (2026-09-13): library media · video games — planet-bound drops */
import { LIBRARY_SERIES_MAP, numberMap } from '@/shared';
import { GAME_ITEM_PLANETS, ITEM_CATEGORIES, ITEM_DEFS, libraryShelfOf } from './ItemDefs';
import { IMPLANT_BROKEN_DEFS, IMPLANT_WORKING_DEFS } from './ImplantDefs';
/* appended (2026-09-11): the armor grade of a named guaranteed drop → armor_n */
import { ARMOR_DEFS } from './ArmorDefs';
/* appended (2026-09-17): per-unit tier roll for corpse samples (`loot_corpse_samples.csv`) */
import type { SampleFamily } from '@/shared';
import { RARITY_ORDER, SAMPLE_FAMILIES } from '@/shared';
import { SAMPLE_ITEM_DEFS } from './ItemDefs';

/* ── group tokens ────────────────────────────────────────────────────────────
 * `target` in `loot_item_weights.csv` is either one item id or a group starting with `@`.
 * A group is there to write a rule like "every unique is 0 at this tier" as a single row. */
const record = (ids: readonly string[], mul: number): Record<string, number> => Object.fromEntries(ids.map((id) => [id, mul]));

/** `@token` → the list of item ids that token points at. */
const WEIGHT_GROUPS: Readonly<Record<string, () => readonly string[]>> = {
  /** `wpn_u_*` (a unique is its own family). */
  '@unique_weapons': () => UNIQUE_WEAPON_IDS.map(itemIdForWeapon),
  /** `ammo_fuel` … `ammo_belt`. */
  '@unique_ammo': () => UNIQUE_AMMO_TYPES.map(ammoItemIdFor),
  /** The six graded weapon families (`ar` … `hg`, every grade). */
  '@graded_families': () => WEAPON_FAMILIES,
  /** Every working implant — never found in a crate, so this is usually 0. */
  '@working_implants': () => IMPLANT_WORKING_DEFS.map((d) => d.id),
};
/** `@broken_implants.<rarity>` — the broken implants of that rarity. */
const BROKEN_IMPLANT_PREFIX = '@broken_implants.';

function expandWeightTarget(target: string): readonly string[] {
  /* 2026-09-21: one key kind (`key_basement`) covers its five planet variants — see *planet-bound keys* below.
     Without this the csv's tier 1 · 2 · 5 「0」 pins would leave four of the five variants at the default 1. */
  if (!target.startsWith('@')) return PLANET_KEY_VARIANTS.get(target) ?? [target];
  const group = WEIGHT_GROUPS[target];
  if (group) return group();
  if (target.startsWith(BROKEN_IMPLANT_PREFIX)) {
    const rarity = target.slice(BROKEN_IMPLANT_PREFIX.length);
    return IMPLANT_BROKEN_DEFS.filter((d) => d.rarity === rarity).map((d) => d.id);
  }
  return [];
}

/* ── retired items (2026-09-13, the cooking material tiers) ──────────────────
 * `ItemDef.retired` — the samples · strains · culture products · special dishes the tier rework replaced (which
 * rows they are is the `retired` column of the item csv files, never a count copied here). The defs stay, but
 * they **never enter a crate or supply draw**: whether the csv (`loot_item_weights.csv`) keeps their rows or
 * drops them, and whoever adds their category to another tier, this is where it is stopped.
 * Two layers — the tier table's `itemWeightMul` is overwritten with 0 (so a tool reading the table sees the same
 * answer), and `Loot.pickDef` drops them from the candidates (including the `relaxRarity` path a guaranteed pick
 * falls into, a uniform draw, when every weight is 0). References between tables (recipes · corpse tables ·
 * planets · analysis results) are caught by `npm run data:check`. */
export const RETIRED_ITEM_IDS: ReadonlySet<string> = new Set([...ITEM_DEF_MAP.values()].filter((d) => d.retired).map((d) => d.id));

/**
 * Can this item be a candidate in a crate or supply draw (i.e. it is not retired).
 * 2026-09-21: nor a **survey camera** (`shared/survey.ts`) — it comes only from the survey NPC's parcel and the
 * survey corp's shelf (user's decision: the camera is an unlock, not loot). Keeping it out of every pool also keeps
 * the `gadget` candidate lists — and so every seeded crate / corpse roll — exactly what they were before it existed.
 */
export function isLootableDef(d: ItemDef): boolean {
  return !d.retired && !surveyCameraOf(d.id);
}

/* ── planet-bound drops (2026-09-13, library series · video games) ───────────
 * Books · discs · records come only from **the series' planets** (`data/library_series.csv`); consoles and game
 * discs only from the planets in `game_*.csv`.
 * The crate roll (`Loot.pickDef`) filters candidates by the raid planet, and a category with no candidate at all
 * on that planet is dropped from the category draw (`planetCategoryAvailable` — records · game discs · consoles
 * on 아켈론 II). The chosen item's weight is multiplied by the volume weight (`LIBRARY_VOLUME_DROP_WEIGHT` in
 * `tables.csv`). A rogue corpse's book roll draws from `libraryBookPool(planet)` by volume weight.
 * **With planet null** (the training range · the old planet-less path · `rollCrate`) every item that has at
 * least one planet is a candidate. */

const LIBRARY_VOLUME_DROP_WEIGHT = numberMap<string>('tables.csv', 'LIBRARY_VOLUME_DROP_WEIGHT');

/* ── the loot category axis (2026-09-15, follow-up to the gadget rework) ─────
 * When `'grenade'` was dropped from `ItemCategory` the same day (a grenade is `category: 'gadget'` too), the
 * `grenade` row of `loot_category_weights.csv` became a **phantom row that matches no item**. The category draw
 * kept picking that row at its old weights (tier 1 16 · 2 12 · 3 8 · 4 8 · **5 25**), and once `pickDef`
 * returned null for zero candidates, `rollCrateOn` **stopped filling the crate altogether** (`else break`).
 * So ~13 % of supply crates and **~23 % of supply drop crates** came out cut down to one or two items
 * (`smoke-search` caught it on seed 21).
 *
 * 「merge the weight into `gadget`」 was **not** used as the fix — putting the 2 grenades and the 12 gadgets
 * into one pool changes their relative frequency wholesale (at tier 1: grenades −39 % · gadgets ×2.05), and
 * undoing that would take more than 20 rows of magic multipliers, one set per tier. Instead **the category axis
 * of the loot draw was split from `ItemCategory`**: the `grenade` the tables speak of is 「an item that has
 * `ItemDef.grenade`」 and `gadget` is every other gadget. So **a crate on the same seed gives the same result
 * as the 2026-09-14 baseline** (item pool · weights · rng consumption all unchanged).
 *
 * Category names are now **validated** by the loader (`LOOT_CATEGORIES`) — what kept this bug quiet was the
 * unvalidated `as ItemCategory` cast. And `rollCrateOn` now skips a category with no candidate instead of
 * stopping.
 */
export type LootCategory = ItemCategory | 'grenade';

/** Every name `loot_category_weights.csv` · `loot_guaranteed.csv` may use (the loader checks them). */
export const LOOT_CATEGORIES: readonly LootCategory[] = [...ITEM_CATEGORIES, 'grenade'];

/** Which category this item counts as in the loot tables — only a grenade has an axis of its own. */
export function lootCategoryOf(d: ItemDef): LootCategory {
  return d.grenade ? 'grenade' : d.category;
}

/* ── planet-bound keys (2026-09-21, user's decision) ─────────────────────────
 * The two skeleton keys became **ten**: one per key kind × planet (`key_basement_amber` …
 * `keycard_lab_crimson`, `data/items.csv`). A locked door takes only the raid planet's key
 * (`world/Structures.ts` builds the id as `<structures.csv key>_<planet>`), but **finding one is planet-
 * independent** — the point of the feature is to send a player to the planet the key names, so any planet may
 * drop any planet's key.
 *
 * The tables therefore keep **one entry per kind**, not ten, and this block is what turns that entry into the
 * ten ids:
 *  - `loot_item_weights.csv` writes `key_basement` / `keycard_lab` once and `expandWeightTarget` spreads the
 *    multiplier over all five variants — so the tier 3 · 4 「1」 and the tier 1 · 2 · 5 「0」 safety pins keep
 *    covering every key, and the crate's `key` category pool is the ten ids at equal weight (= a uniform planet).
 *  - `loot_corpses.csv` keeps **one row** per kind (so its chance and its rng draw are untouched) whose `defId`
 *    resolves here to the first planet's variant; `Loot.rollCorpseWithMax` re-rolls the planet uniformly on a
 *    forked rng when the row hits.
 * The kinds are read from the item table itself (`category: 'key'` + an id ending in a planet id), so adding a
 * planet or a key kind is a csv-only change. */
const PLANET_KEY_VARIANTS: ReadonlyMap<string, readonly string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const d of ITEM_DEFS) {
    if (d.category !== 'key') continue;
    const planet = PLANET_IDS.find((p) => d.id.endsWith(`_${p}`));
    if (!planet) continue;
    const base = d.id.slice(0, d.id.length - planet.length - 1);
    const list = map.get(base) ?? [];
    list.push(d.id);
    map.set(base, list);
  }
  return map;
})();

/** The ten planet keys, by their id — the set `Loot` re-rolls the planet of. */
const PLANET_KEY_BASE_OF: ReadonlyMap<string, string> = new Map(
  [...PLANET_KEY_VARIANTS].flatMap(([base, ids]) => ids.map((id) => [id, base] as const)),
);

/**
 * A loot table cell that names a key **kind** (`key_basement`) resolved to a real item id — the first planet's
 * variant. A cell that already names a variant, or anything that is not a key, comes back unchanged, so
 * `data:check`'s item cross-reference sees a def either way.
 */
export function resolvePlanetKeyRef(defId: string): string {
  return PLANET_KEY_VARIANTS.get(defId)?.[0] ?? defId;
}

/** The other planets' variants of this key (itself included), or null when `defId` is not a planet key. */
export function planetKeyVariantsOf(defId: string): readonly string[] | null {
  const base = PLANET_KEY_BASE_OF.get(defId);
  return base ? PLANET_KEY_VARIANTS.get(base) ?? null : null;
}

/** The categories filtered by planet — every other category is planet-independent. */
export const PLANET_BOUND_CATEGORIES: readonly ItemCategory[] = ['book', 'disc', 'record', 'game_disc', 'console'];

/**
 * The planets this item drops on. null when the item is not planet-bound; `[]` when it is bound but the list is
 * empty (it drops nowhere).
 */
export function lootPlanetsOf(d: ItemDef): readonly PlanetId[] | null {
  const shelf = libraryShelfOf(d);
  if (shelf) return (shelf.series ? LIBRARY_SERIES_MAP.get(shelf.series)?.planets : undefined) ?? [];
  if (d.gameDisc || d.gameConsole) return GAME_ITEM_PLANETS.get(d.id) ?? [];
  return null;
}

/** Is this item a candidate in this raid planet's crates and corpses? With `planet` null, any planet will do. */
export function isLootableOnPlanet(d: ItemDef, planet: PlanetId | null | undefined): boolean {
  const planets = lootPlanetsOf(d);
  if (planets === null) return true;
  if (planets.length === 0) return false;
  return planet == null || planets.includes(planet);
}

/**
 * The volume weight of a library media item (`LIBRARY_VOLUME_DROP_WEIGHT[volume]`; a volume the table does not
 * hold is 0). 1 for anything that is not library media.
 */
export function libraryVolumeWeight(d: ItemDef): number {
  const volume = libraryShelfOf(d)?.volume;
  if (!volume) return 1;
  return LIBRARY_VOLUME_DROP_WEIGHT[String(volume)] ?? 0;
}

const CATEGORY_ON_PLANET = new Map<string, boolean>();

/**
 * Does this category have any candidate at all on that planet (always true when it is not a planet-bound
 * category)? The answer is cached per (category, planet).
 */
export function planetCategoryAvailable(category: LootCategory, planet: PlanetId | null | undefined): boolean {
  if (category === 'grenade' || !PLANET_BOUND_CATEGORIES.includes(category)) return true;
  const key = `${category}@${planet ?? '*'}`;
  let hit = CATEGORY_ON_PLANET.get(key);
  if (hit === undefined) {
    hit = ITEM_DEFS.some((d) => d.category === category && isLootableDef(d) && isLootableOnPlanet(d, planet) && libraryVolumeWeight(d) > 0);
    CATEGORY_ON_PLANET.set(key, hit);
  }
  return hit;
}

const BOOK_POOLS = new Map<string, readonly ItemDef[]>();

/**
 * Candidates for a rogue corpse's book roll — the book series items of that planet (retired ones and volume
 * weight 0 excluded). The draw itself weights them by `libraryVolumeWeight`.
 */
export function libraryBookPool(planet: PlanetId | null | undefined): readonly ItemDef[] {
  const key = planet ?? '*';
  let pool = BOOK_POOLS.get(key);
  if (!pool) {
    pool = ITEM_DEFS.filter((d) => d.category === 'book' && isLootableDef(d) && isLootableOnPlanet(d, planet) && libraryVolumeWeight(d) > 0);
    BOOK_POOLS.set(key, pool);
  }
  return pool;
}

/**
 * Per-tier crate tables. Rolling picks a category by `categoryWeights`, then an
 * ItemDef of that category weighted by `rarityWeights[def.rarity]` (0 = never).
 * `guaranteed` entries are always added first and count toward `count`.
 * Weapon grades map 1:1 to rarity, so `rarityWeights` also shape the grade distribution.
 */
export interface GuaranteedRoll {
  /** Categories allowed for this guaranteed pick (2026-09-15: the loot category axis — `grenade` included). */
  categories: readonly LootCategory[];
  /** Minimum rarity (inclusive). */
  minRarity: Rarity;
}

export interface TierTable {
  tier: number;
  /** Korean container title shown in the loot window. */
  label: string;
  /** Total item count [min, max] (inclusive), guaranteed picks included. */
  count: readonly [number, number];
  rarityWeights: Readonly<Record<Rarity, number>>;
  categoryWeights: Readonly<Partial<Record<LootCategory, number>>>;
  /** Chance that one of the random picks is replaced by a weapon (primary or secondary). */
  weaponChance: number;
  /** Cap on stackable qty per roll for non-ammo stackables (further limited by def.stackMax). */
  maxStackQty: number;
  /** Ammo rolls: rounds = stackMax × a fraction drawn from [min, max]. */
  ammoFraction: readonly [number, number];
  guaranteed: readonly GuaranteedRoll[];
  /**
   * Optional weight multiplier (0 = never at this tier). Keys are item def ids; for weapons a key
   * of the family (`wpn_sr` or `sr`) applies to every grade of that family.
   */
  itemWeightMul?: Readonly<Record<string, number>>;
}

/**
 * Loot rolls run on a **five-step** rarity ladder — still so after `Rarity` grew to six steps (mythic) on
 * 2026-09-16. Mythic comes only from its own paths (the 6 unique weapons · the 3 perk armors · mythic samples
 * and minerals); crate and corpse rolls never draw it. A `mythic` column written into a loot csv is cut by this
 * line and ignored — opening mythic to drops starts here.
 */
export const RARITY_ORDER_LOOT: readonly Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
const RARITY_ORDER_5 = RARITY_ORDER_LOOT;

/** Per-tier category weights / guaranteed picks / item multipliers, gathered by tier number. */
const CATEGORY_WEIGHTS_BY_TIER = csvGroups('loot_category_weights.csv', 'tier');
const GUARANTEED_BY_TIER = csvGroups('loot_guaranteed.csv', 'tier');
const ITEM_WEIGHTS_BY_TIER = csvGroups('loot_item_weights.csv', 'tier');

export const LOOT_TABLES: readonly TierTable[] = csvRows('loot_tiers.csv').map((r) => {
  const tier = r.int('tier', { min: 1 });
  const key = String(tier);

  const categoryWeights: Partial<Record<LootCategory, number>> = {};
  for (const c of CATEGORY_WEIGHTS_BY_TIER.get(key) ?? []) {
    /* 2026-09-15: an unknown name is never swallowed by an `as` cast — one phantom category row cut crates
       short (*the loot category axis* above). */
    categoryWeights[c.enum('category', LOOT_CATEGORIES)] = c.num('weight', { min: 0 });
  }

  const itemWeightMul: Record<string, number> = {};
  for (const w of ITEM_WEIGHTS_BY_TIER.get(key) ?? []) {
    const target = w.str('target');
    const mul = w.num('mul', { min: 0 });
    const ids = expandWeightTarget(target);
    if (!ids.length) w.report('target', `'${target}' 이 가리키는 아이템이 없다`);
    Object.assign(itemWeightMul, record(ids, mul));
  }
  /* 2026-09-13 pin: a retired item has **multiplier 0 at every tier**, whatever rows the csv holds. */
  for (const id of RETIRED_ITEM_IDS) itemWeightMul[id] = 0;

  return {
    tier,
    label: r.str('label'),
    count: [r.int('countMin', { min: 0 }), r.int('countMax', { min: 0 })] as const,
    rarityWeights: Object.fromEntries(RARITY_ORDER_5.map((q) => [q, r.num(q, { min: 0 })])) as Record<Rarity, number>,
    categoryWeights,
    weaponChance: r.num('weaponChance', { min: 0, max: 1 }),
    maxStackQty: r.int('maxStackQty', { min: 1 }),
    ammoFraction: [r.num('ammoFracMin', { min: 0 }), r.num('ammoFracMax', { min: 0 })] as const,
    guaranteed: (GUARANTEED_BY_TIER.get(key) ?? []).map((g) => ({
      categories: g.enumList('categories', LOOT_CATEGORIES),
      minRarity: g.str('minRarity') as Rarity,
    })),
    itemWeightMul,
  };
});

export const LOOT_TABLE_MAP: ReadonlyMap<number, TierTable> = new Map(LOOT_TABLES.map((t) => [t.tier, t]));

export function getTierTable(tier: number): TierTable {
  const clamped = Math.max(1, Math.min(LOOT_TABLES.length, Math.round(tier)));
  return LOOT_TABLE_MAP.get(clamped) ?? LOOT_TABLES[0];
}

export function getTierLabel(tier: number): string {
  return getTierTable(tier).label;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2026-09-09: the **weapon grade** curve per planet progression (`data/planet_loot.csv`)
 *
 * A crate tier's `rarityWeights` still decides the rarity of every other category (attachments · armor ·
 * implants …); **only weapon grades** are re-decided by this table — keeping III and above nearly absent on the
 * early planets would otherwise mean touching the tier table, and that squeezes everything that is not a gun.
 * ──────────────────────────────────────────────────────────────────────────── */

/** One planet's weapon grade curve. `rank` is the difficulty index 1..5 that `planetTier()` gives. */
export interface PlanetGradeCurve {
  rank: number;
  /** A name kept for people to read (the csv `name` column). Code never compares against it. */
  name: string;
  /** Only grades with a positive weight — this array is every grade that planet can yield. */
  grades: readonly WeaponGrade[];
  /** Grade → weight (a grade at 0 is not in `grades`). */
  weightOf: Readonly<Partial<Record<WeaponGrade, number>>>;
  /** The planet's **maximum grade** = the last of `grades`. A corpse weapon only takes this as a cap. */
  maxGrade: WeaponGrade;
  /**
   * The multiplier on the appearance chance of a mythic **unique weapon** (0 = no uniques on that planet).
   * A unique has no grade, so it never rides the `grades` curve and has to be gated on its own — a planet that
   * seals grade V cannot coherently hand out something above it. It applies both to the crate pick weight and
   * to the boss corpse's unique roll.
   */
  uniqueMul: number;
  /**
   * 2026-09-10: the multiplier on the rarity weights of **everything that is not a gun** (armor · bags ·
   * attachments · implants · consumables · materials · valuables …) — `rareMul` · `epicMul` · `legMul` in
   * `data/planet_loot.csv`. common · uncommon are always 1: those two are **the side that takes the shaved
   * share back**, so they are never multiplied (see `planetRarityWeights`).
   *
   * Weapon grades do not ride this multiplier — the grade the `grades` curve drew overwrites it
   * (`Loot.regrade`). The two axes are split on purpose.
   */
  rarityMul: Readonly<Record<Rarity, number>>;
  /** Are all three multipliers 1 = this planet leaves rarity alone. The bypass condition in `planetRarityWeights`. */
  rarityMulIdentity: boolean;
  /**
   * 2026-09-16: the **epic+ gate** — `epicPlusMul` in `data/planet_loot.csv` (0..1, a blank cell = 1).
   * Unlike `rarityMul`, which shaves *weights*, this one applies to the **result**: an epic or legendary that is
   * drawn is kept with this probability, otherwise it drops to the highest rarity below epic (`Loot.pickDef` ·
   * `regrade` · the corpse rolls). It does not cancel out in a guaranteed or fallback pick either. At 1 it never
   * spends a single extra rng draw. The lab's locked-room containers (`CrateLootOpts.lockedRoom`) ignore it.
   */
  epicPlusMul: number;
}

/**
 * The rarities a multiplier applies to and the csv column each value sits in. Nothing outside these three is
 * multiplied. Adding a column means extending this list and `planet_loot.csv`'s header together.
 */
const RARITY_MUL_COLUMNS: readonly (readonly [Rarity, string])[] = [
  ['rare', 'rareMul'],
  ['epic', 'epicMul'],
  ['legendary', 'legMul'],
];

/**
 * The rarities that take the shaved total back **in their original ratio**. These two are why applying the
 * multipliers never changes the weight sum — common · uncommon grow by exactly what rare+ lost, so it never
 * turns into "crates give out fewer things".
 */
const RARITY_REFUND: readonly Rarity[] = ['common', 'uncommon'];

export const PLANET_GRADE_CURVES: readonly PlanetGradeCurve[] = csvRows('planet_loot.csv').map((r) => {
  const weightOf: Partial<Record<WeaponGrade, number>> = {};
  for (const g of WEAPON_GRADES) {
    const w = r.num(`g${g}`, { min: 0 });
    if (w > 0) weightOf[g] = w;
  }
  const grades = WEAPON_GRADES.filter((g) => (weightOf[g] ?? 0) > 0);
  if (grades.length === 0) r.report('g1', '등급 가중치가 전부 0 이다 — 이 행성에서는 무기가 아예 안 나온다');
  /* A blank cell or a missing column is 1 (= left alone) — better than a column that cannot be found
     quietly squeezing a whole planet. */
  const rarityMul = Object.fromEntries(RARITY_ORDER_5.map((q) => [q, 1])) as Record<Rarity, number>;
  for (const [rarity, column] of RARITY_MUL_COLUMNS) rarityMul[rarity] = r.num(column, { min: 0, fallback: 1 });
  return {
    rank: r.int('rank', { min: 1 }),
    name: r.str('name'),
    grades,
    weightOf,
    maxGrade: (grades[grades.length - 1] ?? 1) as WeaponGrade,
    uniqueMul: r.num('uniqueMul', { min: 0 }),
    rarityMul,
    rarityMulIdentity: RARITY_MUL_COLUMNS.every(([rarity]) => rarityMul[rarity] === 1),
    /* 2026-09-16: a blank cell or a missing column is 1 (= no gate) — the same reason as rarityMul above. */
    epicPlusMul: r.num('epicPlusMul', { min: 0, max: 1, fallback: 1 }),
  };
});

const PLANET_GRADE_CURVE_MAP: ReadonlyMap<number, PlanetGradeCurve> = new Map(PLANET_GRADE_CURVES.map((c) => [c.rank, c]));

/**
 * The curve for a difficulty index (`planetTier()`, 1..5). `null` for an index the table does not hold — then,
 * as before, the crate tier's rarity weights decide the weapon grade (the training range with no planet chosen ·
 * an old save).
 */
export function getPlanetGradeCurve(rank: number): PlanetGradeCurve | null {
  return PLANET_GRADE_CURVE_MAP.get(Math.round(rank)) ?? null;
}

/** Per `base` object: rank → the adjusted weights. Held so that no new object is made for every roll. */
const RARITY_WEIGHT_CACHE = new WeakMap<object, Map<number, Readonly<Partial<Record<Rarity, number>>>>>();

/**
 * 2026-09-10: applies the planet's `rareMul` · `epicMul` · `legMul` to one set of rarity weights and returns it.
 *
 * 1. rare · epic · legendary are each multiplied.
 * 2. The **shaved total** (`shaved`) is then shared out to common · uncommon **in the ratio they already had**.
 *
 * So the weight **sum stays the same** — common · uncommon grow by exactly what rare+ gave up. The number of
 * things a crate yields (`count`) has nothing to do with this table anyway, but a wobbling sum would make other
 * multipliers such as `itemWeightMul` bite differently per planet, and the tables would stop being readable.
 *
 * **With all three multipliers at 1, `base` is returned as it is (the same object)** — not even a float
 * multiplication happens, so rank 2~5 results are bit-identical to the time before this feature. The path where
 * `curve` is null (the training range · an old save) is the same.
 *
 * ⚠ When the table has **no place to give it back to (no common · uncommon at all)** the redistribution is
 *   skipped — the sum shrinks, but with all three multipliers equal they cancel out and the ratio is unchanged
 *   (the same story as a roll whose candidates are already rare+ only, such as a guaranteed pick). A table with
 *   nothing to shave passes straight through, since `shaved` is 0.
 */
export function planetRarityWeights<T extends Readonly<Partial<Record<Rarity, number>>>>(
  base: T, curve: PlanetGradeCurve | null,
): T {
  if (!curve || curve.rarityMulIdentity) return base;
  let byRank = RARITY_WEIGHT_CACHE.get(base);
  if (!byRank) { byRank = new Map(); RARITY_WEIGHT_CACHE.set(base, byRank); }
  const hit = byRank.get(curve.rank);
  if (hit) return hit as T;

  const out: Partial<Record<Rarity, number>> = { ...base };
  let shaved = 0;
  for (const [rarity] of RARITY_MUL_COLUMNS) {
    const w = base[rarity];
    if (w === undefined) continue;
    const scaled = w * curve.rarityMul[rarity];
    shaved += w - scaled;
    out[rarity] = scaled;
  }
  let refundBase = 0;
  for (const rarity of RARITY_REFUND) refundBase += base[rarity] ?? 0;
  if (shaved !== 0 && refundBase > 0) {
    for (const rarity of RARITY_REFUND) {
      const w = base[rarity];
      if (w !== undefined) out[rarity] = w + shaved * (w / refundBase);
    }
  }
  byRank.set(curve.rank, out);
  return out as T;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Phase 4: corpse tables (`LootRef.rollCorpse`)
 * ──────────────────────────────────────────────────────────────────────────── */
/** One possible corpse drop: `chance` (1 = always) then `qty` drawn from [min, max] inclusive. */
export interface CorpseDrop {
  defId: string;
  qty: readonly [number, number];
  chance: number;
}

/** Rogue corpses carry the weapon the rogue fought with (item `wpn_<weaponId>`). */
export interface CorpseWeapon {
  /** Durability as a fraction of the def's max, drawn from [min, max]. `ammoInMag` is rng 0..magSize. */
  durability: readonly [number, number];
  /** When set, the weapon is re-graded to one of these grades of the same family (bosses). */
  grades?: readonly WeaponGrade[];
  /** When set, one random `att_*` attachment (rarity ≤ `maxRarity`, fitting the weapon when possible) is added. */
  attachment?: { maxRarity: Rarity };
}

/** Phase 6: chance of one extra mythic unique (`UNIQUE_WEAPON_IDS`, uniform) plus a stack of its calibre. */
export interface CorpseUnique {
  chance: number;
  /** Durability as a fraction of the def's max, drawn from [min, max]. */
  durability: readonly [number, number];
}

/**
 * Phase 9: chance of one book on a rogue corpse — the reading kind of raider.
 * 2026-09-13: picked from **the raid planet's book series** (`libraryBookPool`) weighted by `libraryVolumeWeight` (one draw, as before).
 */
export interface CorpseBook {
  chance: number;
}

/**
 * Phase 12: chance of one **broken implant** (`IMPLANT_BROKEN_DEFS`, picked by `weights[rarity]`; 0 / missing =
 * never) on a rogue corpse — raiders wear implants and a kill shot fries them. Rolled last in `rollCorpse` so
 * earlier draws never move.
 */
export interface CorpseImplant {
  chance: number;
  weights: Readonly<Partial<Record<Rarity, number>>>;
}

const CORPSE_ROLLS = new Map(csvRows('loot_corpse_rolls.csv').map((r) => [r.str('type'), r]));

export interface CorpseTable {
  type: EnemyType;
  drops: readonly CorpseDrop[];
  /** 2026-09-17: per-unit tier roll for unidentified samples (`loot_corpse_samples.csv`), on a corpse rng fork. */
  samples?: readonly CorpseSampleDrop[];
  /** Phase 9: book roll (rogues only; bugs never carry books). */
  book?: CorpseBook;
  /** Phase 12: broken implant roll (rogues only; legendaries from the boss). */
  implant?: CorpseImplant;
  /** Rounds of the weapon's calibre as a fraction of `AMMO_STACK_ROUNDS`, one stack (rogues only). */
  ammoFraction?: readonly [number, number];
  weapon?: CorpseWeapon;
  unique?: CorpseUnique;
}

/**
 * Corpse drops — `data/loot_corpses.csv` (items) + `data/loot_corpse_rolls.csv` (gun · book · implant · unique).
 * Phase 8: bugs graze on the local flora, so an undigested seed turns up in a bug corpse now and then.
 * Phase 9: books go the other way — rogues only (`CorpseTable.book`), never on a bug.
 */
const CORPSE_DROPS_BY_TYPE = csvGroups('loot_corpses.csv', 'type');

/**
 * 2026-09-17 (user's decision): the unidentified samples on a corpse — `data/loot_corpse_samples.csv`. One row =
 * chance → count → a weighted tier draw **per unit**.
 * `tiers` is expanded from a tier (1..6 = the rarity index) to the sample item of that family × tier (the weight
 * of `defIds[i]` is `weights[i]`, in ascending tier order).
 */
export interface CorpseSampleDrop {
  family: SampleFamily;
  qty: readonly [number, number];
  chance: number;
  /** Sample item ids in ascending tier order — only tiers with a positive weight that exist in samples.csv. */
  defIds: readonly string[];
  weights: readonly number[];
}

const CORPSE_SAMPLES_BY_TYPE: ReadonlyMap<string, readonly CorpseSampleDrop[]> = (() => {
  const map = new Map<string, CorpseSampleDrop[]>();
  for (const r of csvRows('loot_corpse_samples.csv')) {
    const family = r.enum('family', SAMPLE_FAMILIES);
    const qty = [r.int('qtyMin', { min: 1 }), r.int('qtyMax', { min: 1 })] as const;
    if (qty[0] > qty[1]) r.report('qtyMax', `qtyMin ${qty[0]} 이 qtyMax ${qty[1]} 보다 크다`);
    const byTier = new Map<number, number>();
    for (const c of r.costList('tiers')) {
      const tier = Number(c.defId);
      if (!Number.isInteger(tier) || tier < 1 || tier > RARITY_ORDER.length) { r.report('tiers', `'${c.defId}' 는 등급(1..${RARITY_ORDER.length})이 아니다`); continue; }
      if (c.qty < 0) { r.report('tiers', `등급 ${tier} 의 가중치 ${c.qty} 가 음수다`); continue; }
      if (c.qty > 0) byTier.set(tier, c.qty);
    }
    const defIds: string[] = [], weights: number[] = [];
    for (const tier of [...byTier.keys()].sort((a, b) => a - b)) {
      const def = SAMPLE_ITEM_DEFS.find((d) => d.sample?.family === family && !d.retired && d.rarity === RARITY_ORDER[tier - 1]);
      if (!def) { r.report('tiers', `${family} 계열의 등급 ${tier} 표본이 samples.csv 에 없다`); continue; }
      defIds.push(def.id);
      weights.push(byTier.get(tier)!);
    }
    if (!defIds.length) r.report('tiers', '뽑을 수 있는 등급이 없다');
    const type = r.str('type');
    const list = map.get(type) ?? [];
    list.push({ family, qty, chance: r.num('chance', { min: 0, max: 1 }), defIds, weights });
    map.set(type, list);
  }
  return map;
})();

/* 2026-09-13: the table's types = item drop rows ∪ separately rolled rows — an enemy that only carries a gun
   gets a corpse table too. First-seen order is kept, so no existing enemy's table or roll moves by a grain. */
export const CORPSE_TABLES: readonly CorpseTable[] = [...new Set([...CORPSE_DROPS_BY_TYPE.keys(), ...CORPSE_ROLLS.keys(), ...CORPSE_SAMPLES_BY_TYPE.keys()])]
  .filter((type) => !!type)
  .map((type) => {
    const drops: CorpseDrop[] = (CORPSE_DROPS_BY_TYPE.get(type) ?? []).map((d) => ({
      /* 2026-09-21: a key kind stays **one row** (its chance and its rng draw must not move) — the planet is
         re-rolled by `Loot.rollCorpseWithMax` when the row hits (*planet-bound keys*). */
      defId: resolvePlanetKeyRef(d.str('defId')),
      qty: [d.int('qtyMin', { min: 0 }), d.int('qtyMax', { min: 0 })] as const,
      chance: d.num('chance', { min: 0, max: 1 }),
    }));
    const roll = CORPSE_ROLLS.get(type);
    const samples = CORPSE_SAMPLES_BY_TYPE.get(type);
    return {
      type: type as EnemyType,
      drops,
      ...(samples ? { samples } : {}),
      ...(roll?.has('ammoFracMin') ? {
        ammoFraction: [roll.num('ammoFracMin', { min: 0 }), roll.num('ammoFracMax', { min: 0 })] as const,
      } : {}),
      ...(roll?.has('weaponDurMin') ? {
        weapon: {
          durability: [roll.num('weaponDurMin', { min: 0, max: 1 }), roll.num('weaponDurMax', { min: 0, max: 1 })] as const,
          ...(roll.has('weaponGrades') ? { grades: roll.list('weaponGrades').map(Number) as WeaponGrade[] } : {}),
          ...(roll.has('weaponAttachMaxRarity') ? { attachment: { maxRarity: roll.str('weaponAttachMaxRarity') as Rarity } } : {}),
        },
      } : {}),
      ...(roll?.has('uniqueChance') ? {
        unique: {
          chance: roll.num('uniqueChance', { min: 0, max: 1 }),
          durability: [roll.num('uniqueDurMin', { min: 0, max: 1 }), roll.num('uniqueDurMax', { min: 0, max: 1 })] as const,
        },
      } : {}),
      ...(roll?.has('bookChance') ? { book: { chance: roll.num('bookChance', { min: 0, max: 1 }) } } : {}),
      ...(roll?.has('implantChance') ? {
        implant: {
          chance: roll.num('implantChance', { min: 0, max: 1 }),
          weights: Object.fromEntries(roll.costList('implantWeights').map((c) => [c.defId, c.qty])) as Partial<Record<Rarity, number>>,
        },
      } : {}),
    };
  });

export const CORPSE_TABLE_MAP: ReadonlyMap<EnemyType, CorpseTable> = new Map(CORPSE_TABLES.map((t) => [t.type, t]));

/** Weapon a rogue carries when the caller passes no `rogueWeaponId`. */
export const DEFAULT_ROGUE_WEAPON_ID = 'ar';

/* ────────────────────────────────────────────────────────────────────────────
 * 2026-09-11: the **guaranteed drop** of a named rogue (`data/loot_named.csv`)
 *
 * 로든 = a sniper rifle III~V · 타길라 = armor III~V · 헤비 = the unique minigun. All three at 1–5 % durability
 * (`NAMED_LOOT_DURABILITY_MIN/MAX`, constants). It is rolled **last of all** in `rollCorpse`, apart from the
 * normal corpse table, so the rng vector of a non-named enemy does not move by a grain. No planet curve is
 * applied (the user's spec "최소 희귀부터").
 * ──────────────────────────────────────────────────────────────────────────── */

export type NamedDropKind = 'weapon' | 'armor' | 'item';

export interface NamedDrop {
  type: EnemyType;
  kind: NamedDropKind;
  /** weapon = a graded weapon family id (`sr`) · item = an item id (`wpn_u_minigun`) · armor = '' */
  target: string;
  chance: number;
  /** Grades with a positive weight (weapon · armor). An empty array for item. */
  grades: readonly WeaponGrade[];
  weightOf: Readonly<Partial<Record<WeaponGrade, number>>>;
  /** Loaded ammo = magazine × [min, max]. Without it, uniform over 0..magazine. */
  magFraction?: readonly [number, number];
  /** One stack of that weapon's ammo type × [min, max]. Without it, no ammo. */
  ammoFraction?: readonly [number, number];
}

export const NAMED_DROPS: readonly NamedDrop[] = csvRows('loot_named.csv').map((r) => {
  const kind = r.enum('kind', ['weapon', 'armor', 'item'] as const);
  const target = r.has('target') ? r.str('target') : '';
  const weightOf: Partial<Record<WeaponGrade, number>> = {};
  for (const c of r.costList('grades')) {
    const g = Number(c.defId);
    if (!(WEAPON_GRADES as readonly number[]).includes(g)) { r.report('grades', `'${c.defId}' 는 등급(1..5)이 아니다`); continue; }
    if (c.qty > 0) weightOf[g as WeaponGrade] = c.qty;
  }
  const grades = WEAPON_GRADES.filter((g) => (weightOf[g] ?? 0) > 0);

  if (kind === 'weapon') {
    if (!(WEAPON_FAMILIES as readonly string[]).includes(target)) r.report('target', `'${target}' 는 등급 무기 계열이 아니다`);
    if (!grades.length) r.report('grades', 'weapon 드롭에 등급 가중치가 없다');
  } else if (kind === 'armor') {
    if (!grades.length) r.report('grades', 'armor 드롭에 등급 가중치가 없다');
    for (const g of grades) if (!ARMOR_DEFS.some((a) => a.tier === g)) r.report('grades', `방탄복 등급 ${g} 이 armor.csv 에 없다`);
  } else if (!ITEM_DEF_MAP.has(target)) {
    r.report('target', `'${target}' 아이템이 없다`);
  }

  return {
    type: r.str('type') as EnemyType,
    kind,
    target,
    chance: r.num('chance', { min: 0, max: 1 }),
    grades,
    weightOf,
    ...(r.has('magFracMin') ? { magFraction: [r.num('magFracMin', { min: 0, max: 1 }), r.num('magFracMax', { min: 0, max: 1 })] as const } : {}),
    ...(r.has('ammoFracMin') ? { ammoFraction: [r.num('ammoFracMin', { min: 0, max: 1 }), r.num('ammoFracMax', { min: 0, max: 1 })] as const } : {}),
  };
});

export const NAMED_DROP_MAP: ReadonlyMap<EnemyType, NamedDrop> = new Map(NAMED_DROPS.map((d) => [d.type, d]));

/** The numbered armor item id for tier n (`armor_n`; unique tier 0 excluded). null when there is none. */
export function numberedArmorIdForTier(tier: number): string | null {
  return tier > 0 ? (ARMOR_DEFS.find((a) => a.tier === tier)?.id ?? null) : null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2026-09-13: humanoid faction (android · rogue · raider) corpses
 *   `data/loot_factions.csv`       gun grade distribution · armor · bag · heal (rarity rolls)
 *   `data/loot_faction_sites.csv`  spawn site bonuses (lab = seeds · unidentified samples, outpost = the gun
 *                                  grade distribution is replaced)
 *
 * An enemy with no row in either table (bugs · rogue_boss · named) never enters the new branch of
 * `Loot.rollCorpseWithMax`, so its rng vector does not move by a grain. Leftover grenades come straight from
 * `CorpseLootOpts.grenades`, not from a table (no roll).
 * ──────────────────────────────────────────────────────────────────────────── */

type LootRow = ReturnType<typeof csvRows>[number];

/** One set of grade weights ("grade:weight" | …). Only grades with a positive weight are in `grades`. */
export interface GradeWeights {
  grades: readonly WeaponGrade[];
  weightOf: Readonly<Partial<Record<WeaponGrade, number>>>;
}

function parseGradeWeights(r: LootRow, column: string): GradeWeights {
  const weightOf: Partial<Record<WeaponGrade, number>> = {};
  for (const c of r.costList(column)) {
    const g = Number(c.defId);
    if (!(WEAPON_GRADES as readonly number[]).includes(g)) { r.report(column, `'${c.defId}' 는 등급(1..5)이 아니다`); continue; }
    if (c.qty < 0) { r.report(column, `등급 ${g} 의 가중치 ${c.qty} 가 음수다`); continue; }
    if (c.qty > 0) weightOf[g as WeaponGrade] = c.qty;
  }
  const grades = WEAPON_GRADES.filter((g) => (weightOf[g] ?? 0) > 0);
  if (!grades.length) r.report(column, '등급 가중치가 없다');
  return { grades, weightOf };
}

/**
 * One rarity roll on a corpse (armor · bag · heal): `chance` → a rarity (`weights` — the planet's rarity
 * multipliers are applied at roll time through `planetRarityWeights`) → **uniform** among the candidates of
 * that rarity (`byRarity`).
 */
export interface CorpseRarityPick {
  chance: number;
  weights: Readonly<Partial<Record<Rarity, number>>>;
  /** Rarities with both a weight and a candidate (common → legendary — the order `rng.weighted` uses). */
  rarities: readonly Rarity[];
  /** Rarity → candidate item ids (csv order). Retired items are already out. */
  byRarity: ReadonlyMap<Rarity, readonly string[]>;
  /**
   * The candidate ids exactly as the csv writes them — for `data:check`'s retired-item reference check.
   * The roll itself looks only at `byRarity`.
   */
  poolIds: readonly string[];
}

function parseRarityPick(
  r: LootRow, prefix: 'armor' | 'bag' | 'heal', accepts: (d: ItemDef) => boolean, notLabel: string,
): CorpseRarityPick | undefined {
  const cChance = `${prefix}Chance`, cPool = `${prefix}Pool`, cRarity = `${prefix}Rarity`;
  if (!r.has(cChance)) {
    if (r.has(cPool) || r.has(cRarity)) r.report(cChance, `${cPool} · ${cRarity} 가 있는데 확률이 비었다`);
    return undefined;
  }
  const chance = r.num(cChance, { min: 0, max: 1 });
  const poolIds = r.list(cPool);
  if (!poolIds.length) r.report(cPool, '후보 아이템이 없다');
  const byRarity = new Map<Rarity, string[]>();
  for (const id of poolIds) {
    const d = ITEM_DEF_MAP.get(id);
    if (!d) { r.report(cPool, `'${id}' 아이템이 없다`); continue; }
    if (!accepts(d)) { r.report(cPool, `'${id}' 는 ${notLabel} 아니다`); continue; }
    if (d.retired) continue;   // pin — the reporting is done by data:check's reference check (poolIds)
    const list = byRarity.get(d.rarity);
    if (list) list.push(id); else byRarity.set(d.rarity, [id]);
  }
  const weights: Partial<Record<Rarity, number>> = {};
  for (const c of r.costList(cRarity)) {
    const rarity = c.defId as Rarity;
    if (!RARITY_ORDER_5.includes(rarity)) { r.report(cRarity, `'${c.defId}' 는 희귀도가 아니다`); continue; }
    if (c.qty < 0) { r.report(cRarity, `'${rarity}' 의 가중치 ${c.qty} 가 음수다`); continue; }
    if (c.qty === 0) continue;
    weights[rarity] = c.qty;
    if (!byRarity.has(rarity)) r.report(cRarity, `'${rarity}' 인 아이템이 ${cPool} 에 없다`);
  }
  const rarities = RARITY_ORDER_5.filter((q) => (weights[q] ?? 0) > 0 && byRarity.has(q));
  if (!rarities.length) r.report(cRarity, '뽑을 수 있는 희귀도가 없다');
  return { chance, weights, rarities, byRarity, poolIds };
}

/** The faction rolls of one faction enemy type (one row of `data/loot_factions.csv`). */
export interface FactionLoot {
  type: EnemyType;
  /** Grade distribution of the gun it carried. Without it, `loot_corpse_rolls.csv`'s rule stands. */
  weaponGrades?: GradeWeights;
  armor?: CorpseRarityPick;
  bag?: CorpseRarityPick;
  heal?: CorpseRarityPick;
  /** Armor · bag durability = the maximum × [min, max] (worn like the gun). [0, 0] when neither is present. */
  gearDurability: readonly [number, number];
}

export const FACTION_LOOT: readonly FactionLoot[] = csvRows('loot_factions.csv').map((r) => {
  const type = r.str('type') as EnemyType;
  const corpse = CORPSE_TABLE_MAP.get(type);
  if (!corpse) r.report('type', `'${type}' 의 시체 표가 없다 (loot_corpses.csv 또는 loot_corpse_rolls.csv 에 줄이 있어야 한다)`);
  let weaponGrades: GradeWeights | undefined;
  if (r.has('weaponGrades')) {
    weaponGrades = parseGradeWeights(r, 'weaponGrades');
    if (corpse && !corpse.weapon) r.report('weaponGrades', `'${type}' 는 들고 있던 총 굴림이 없다 (loot_corpse_rolls.csv 의 weaponDurMin/Max)`);
    if (corpse?.weapon?.grades?.length) r.report('weaponGrades', 'loot_corpse_rolls.csv 의 weaponGrades(균등 목록)와 같이 쓰지 않는다');
  }
  const armor = parseRarityPick(r, 'armor', (d) => d.category === 'armor', '방탄복이');
  const bag = parseRarityPick(r, 'bag', (d) => d.category === 'bag', '가방이');
  const heal = parseRarityPick(r, 'heal', (d) => d.category === 'stim', '회복 소모품(stim)이');
  const gearDurability: readonly [number, number] = armor || bag
    ? [r.num('gearDurMin', { min: 0, max: 1 }), r.num('gearDurMax', { min: 0, max: 1 })]
    : [0, 0];
  if (gearDurability[0] > gearDurability[1]) r.report('gearDurMax', `gearDurMin ${gearDurability[0]} 이 gearDurMax ${gearDurability[1]} 보다 크다`);
  return {
    type, gearDurability,
    ...(weaponGrades ? { weaponGrades } : {}), ...(armor ? { armor } : {}), ...(bag ? { bag } : {}), ...(heal ? { heal } : {}),
  };
});

export const FACTION_LOOT_MAP: ReadonlyMap<EnemyType, FactionLoot> = new Map(FACTION_LOOT.map((f) => [f.type, f]));
if (FACTION_LOOT_MAP.size !== FACTION_LOOT.length) {
  const seen = new Set<string>();
  for (const [i, r] of csvRows('loot_factions.csv').entries()) {
    if (seen.has(r.raw('type'))) r.report('type', `'${r.raw('type')}' 줄이 둘이다 (${i + 1}번째 줄은 무시된다)`);
    seen.add(r.raw('type'));
  }
}

/** The sites a site-bonus row understands — every `EnemySpawnSite`. */
const SPAWN_SITES: readonly EnemySpawnSite[] = ['lab', 'outpost', 'wreck', 'platform', 'ruin', 'drop'];

/** One item row of a site bonus. */
export interface FactionSiteItem {
  /** item = one `defId` · seed = one draw from the raid planet's wild seed pool (`planetSeedPool`). */
  kind: 'item' | 'seed';
  /** The item id for an item row ('' for seed). */
  defId: string;
  qty: readonly [number, number];
  chance: number;
}

/** The bonus for one enemy type × spawn site (every row of `data/loot_faction_sites.csv` with that type · site). */
export interface FactionSiteBonus {
  type: EnemyType;
  site: EnemySpawnSite;
  /** When present, it replaces the gun grade distribution of enemies spawned at that site **wholesale**. */
  weaponGrades?: GradeWeights;
  /** csv order = roll order. */
  items: readonly FactionSiteItem[];
}

const siteKey = (type: string, site: string): string => `${type}@${site}`;

const FACTION_SITE_MAP: ReadonlyMap<string, FactionSiteBonus> = (() => {
  const map = new Map<string, { type: EnemyType; site: EnemySpawnSite; weaponGrades?: GradeWeights; items: FactionSiteItem[] }>();
  for (const r of csvRows('loot_faction_sites.csv')) {
    const type = r.str('type') as EnemyType;
    const site = r.enum('site', SPAWN_SITES);
    const kind = r.enum('kind', ['grades', 'item', 'seed'] as const);
    const corpse = CORPSE_TABLE_MAP.get(type);
    if (!corpse) r.report('type', `'${type}' 의 시체 표가 없다`);
    const key = siteKey(type, site);
    let bonus = map.get(key);
    if (!bonus) { bonus = { type, site, items: [] }; map.set(key, bonus); }
    if (kind === 'grades') {
      if (bonus.weaponGrades) r.report('kind', `'${type}' @ ${site} 에 grades 줄이 둘이다`);
      bonus.weaponGrades = parseGradeWeights(r, 'grades');
      if (corpse && !corpse.weapon) r.report('grades', `'${type}' 는 들고 있던 총 굴림이 없다 (loot_corpse_rolls.csv 의 weaponDurMin/Max)`);
      continue;
    }
    let defId = '';
    if (kind === 'item') {
      defId = r.str('target');
      if (defId && !ITEM_DEF_MAP.has(defId)) r.report('target', `'${defId}' 아이템이 없다`);
    } else if (r.has('target')) {
      r.report('target', 'seed 줄은 target 을 비운다 (그 행성의 씨앗 표에서 고른다)');
    }
    const qty: readonly [number, number] = [r.int('qtyMin', { min: 1 }), r.int('qtyMax', { min: 1 })];
    if (qty[0] > qty[1]) r.report('qtyMax', `qtyMin ${qty[0]} 이 qtyMax ${qty[1]} 보다 크다`);
    bonus.items.push({ kind, defId, qty, chance: r.num('chance', { min: 0, max: 1 }) });
  }
  return map;
})();

export const FACTION_SITE_BONUSES: readonly FactionSiteBonus[] = [...FACTION_SITE_MAP.values()];

/** The bonus for that enemy type spawned at that site. undefined with no site or no row. */
export function getFactionSiteBonus(type: EnemyType, site: EnemySpawnSite | null | undefined): FactionSiteBonus | undefined {
  return site ? FACTION_SITE_MAP.get(siteKey(type, site)) : undefined;
}

/** An item id with a weight on it. */
export interface WeightedItemId {
  defId: string;
  weight: number;
}

/*
 * Planet id → that planet's **wild seed pool** (the `seeds` column of `data/planets.csv`, weights as written).
 * Unknown ids, things that are not seeds and retired items are dropped. The cell's syntax check belongs to that
 * column's owner (world), so this reads it quietly — the same error must not be reported twice.
 */
const PLANET_SEED_POOLS: ReadonlyMap<string, readonly WeightedItemId[]> = new Map(csvRows('planets.csv').map((row) => {
  const pool: WeightedItemId[] = [];
  for (const part of row.list('seeds')) {
    const at = part.lastIndexOf(':');
    const defId = (at > 0 ? part.slice(0, at) : part).trim();
    const weight = at > 0 ? Number(part.slice(at + 1)) : 1;
    const d = ITEM_DEF_MAP.get(defId);
    if (d?.seed && !d.retired && Number.isFinite(weight) && weight > 0) pool.push({ defId, weight });
  }
  return [row.raw('id'), pool] as const;
}));

/** The five planets' seed pools merged (weights of the same seed add up, in first-seen order). */
const ALL_PLANET_SEED_POOL: readonly WeightedItemId[] = (() => {
  const sum = new Map<string, number>();
  for (const pool of PLANET_SEED_POOLS.values()) for (const s of pool) sum.set(s.defId, (sum.get(s.defId) ?? 0) + s.weight);
  return [...sum].map(([defId, weight]) => ({ defId, weight }));
})();

/**
 * The seed pool a site bonus's `seed` row draws from — that planet's own, or the five planets merged when there
 * is no planet or that pool is empty.
 */
export function planetSeedPool(planet: PlanetId | null | undefined): readonly WeightedItemId[] {
  const own = planet == null ? undefined : PLANET_SEED_POOLS.get(planet);
  return own && own.length > 0 ? own : ALL_PLANET_SEED_POOL;
}
