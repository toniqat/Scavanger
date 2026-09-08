import type { EnemyType, ItemCategory, Rarity, WeaponGrade } from '@/shared';
import { UNIQUE_WEAPON_IDS } from '@/shared';
import { WEAPON_FAMILIES } from './WeaponDefs';
import { UNIQUE_AMMO_TYPES, ammoItemIdFor, itemIdForWeapon } from './ItemDefs';
import { IMPLANT_BROKEN_DEFS, IMPLANT_WORKING_DEFS } from './ImplantDefs';

/* ── Phase 6 helpers: weight records for the six uniques / their ammo / graded families ── */
const record = (ids: readonly string[], mul: number): Record<string, number> => Object.fromEntries(ids.map((id) => [id, mul]));
/*
 * Phase 12 (2026-09-08): 임플란트 in containers. Only **broken** ones ever drop (working implants are 세레스 바이오's), so
 * every working def is zeroed wherever the category has weight; broken legendaries (the perk implants) are tier 4 / boss
 * only. `byRarity` scales the broken ones on top of the tier's `rarityWeights` so a higher grade stays the rarer find.
 */
const workingImplants = (): Record<string, number> => record(IMPLANT_WORKING_DEFS.map((d) => d.id), 0);
const brokenImplants = (byRarity: Partial<Record<Rarity, number>>): Record<string, number> =>
  Object.fromEntries(IMPLANT_BROKEN_DEFS.map((d) => [d.id, byRarity[d.rarity] ?? 1]));
/** `wpn_u_*` → mul (exact item ids; a unique is its own family). */
const uniqueWeapons = (mul: number): Record<string, number> => record(UNIQUE_WEAPON_IDS.map(itemIdForWeapon), mul);
/** `ammo_fuel` … `ammo_belt` → mul. */
const uniqueAmmo = (mul: number): Record<string, number> => record(UNIQUE_AMMO_TYPES.map(ammoItemIdFor), mul);
/** Every graded family (`ar` … `hg`, all grades) → mul. */
const gradedFamilies = (mul: number): Record<string, number> => record(WEAPON_FAMILIES, mul);

/**
 * Per-tier crate tables. Rolling picks a category by `categoryWeights`, then an
 * ItemDef of that category weighted by `rarityWeights[def.rarity]` (0 = never).
 * `guaranteed` entries are always added first and count toward `count`.
 * Weapon grades map 1:1 to rarity, so `rarityWeights` also shape the grade distribution.
 */
export interface GuaranteedRoll {
  /** Categories allowed for this guaranteed pick. */
  categories: readonly ItemCategory[];
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
  categoryWeights: Readonly<Partial<Record<ItemCategory, number>>>;
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

export const LOOT_TABLES: readonly TierTable[] = [
  {
    tier: 1, label: '보급 상자', count: [2, 3],
    rarityWeights: { common: 80, uncommon: 18, rare: 2, epic: 0, legendary: 0 },
    categoryWeights: { ammo: 30, stim: 18, grenade: 16, material: 20, valuable: 16, attachment: 6, gadget: 6, herb: 8, armor: 1, seed: 4 },
    weaponChance: 0, maxStackQty: 3, ammoFraction: [0.25, 0.5], guaranteed: [],
    // heavy deployables never in a supply crate; unique ammo / housing materials start at tier 2+
    // Phase 8: 씨앗 are a modest category here (weight 4 of ~125) and the rarity weights keep tier 1 to 혈근초 씨앗 almost always
    itemWeightMul: {
      gad_turret: 0, gad_dome_shield: 0, ...uniqueAmmo(0), mat_cable: 0, mat_circuit: 0,
      /* 2026-09-07: 붕대 재료는 저티어에서 흔하게, 주사기 / 소독약은 나오지 않는다 (제작으로만) */
      mat_cloth: 2.5, mat_can: 1.5, mat_syringe: 0, mat_antiseptic: 0,
    },
  },
  {
    tier: 2, label: '군수 상자', count: [3, 4],
    rarityWeights: { common: 45, uncommon: 38, rare: 15, epic: 2, legendary: 0 },
    categoryWeights: { ammo: 20, stim: 14, grenade: 12, material: 16, valuable: 38, attachment: 10, bag: 3, gadget: 9, herb: 5, armor: 4, seed: 4, book: 3, implant: 2 },
    weaponChance: 0.35, maxStackQty: 4, ammoFraction: [0.35, 0.7],
    guaranteed: [{ categories: ['valuable'], minRarity: 'uncommon' }],
    // SMGs are field-common; snipers rarely in supply crates; legendary gear is tier 3+ only; 전력 케이블 / 회로 기판 from here (circuit scarce)
    itemWeightMul: {
      wpn_smg: 1.3, wpn_sr: 0.35,
      armor_regen: 0, armor_ultralight: 0, armor_optical: 0,
      ...uniqueAmmo(0), mat_cable: 1.2, mat_circuit: 0.3,
      mat_cloth: 2, mat_can: 1.5, mat_syringe: 0.8, mat_antiseptic: 0,
      /* Phase 12: 망가진 임플란트 only — mostly I / II here, no legendaries */
      ...workingImplants(), ...brokenImplants({ common: 1, uncommon: 0.7, rare: 0.4, epic: 0.2, legendary: 0 }),
    },
  },
  {
    tier: 3, label: '귀중품 금고', count: [4, 5],
    rarityWeights: { common: 15, uncommon: 30, rare: 40, epic: 14, legendary: 1 },
    categoryWeights: { ammo: 12, stim: 12, grenade: 8, material: 14, valuable: 54, attachment: 12, bag: 6, gadget: 11, herb: 3, armor: 4, seed: 3, book: 3, implant: 3 },
    weaponChance: 0.55, maxStackQty: 5, ammoFraction: [0.5, 0.85],
    guaranteed: [{ categories: ['valuable'], minRarity: 'rare' }],
    // uniques are tier 4+ / 5 / boss only (legendary weight 1 here would otherwise leak them)
    itemWeightMul: {
      wpn_sr: 1.2, ...uniqueWeapons(0), ...uniqueAmmo(0), mat_circuit: 0.6,
      mat_cloth: 1.2, mat_can: 1, mat_syringe: 1, mat_antiseptic: 0,
      /* Phase 12: 망가진 임플란트 up to IV, still no legendaries */
      ...workingImplants(), ...brokenImplants({ common: 1, uncommon: 1, rare: 0.7, epic: 0.4, legendary: 0 }),
    },
  },
  {
    tier: 4, label: '희귀 캐시', count: [5, 6],
    rarityWeights: { common: 5, uncommon: 15, rare: 40, epic: 30, legendary: 10 },
    categoryWeights: { ammo: 10, stim: 12, grenade: 8, material: 10, valuable: 60, attachment: 12, bag: 8, gadget: 12, herb: 2, armor: 7, book: 2, implant: 4 },
    weaponChance: 1, maxStackQty: 6, ammoFraction: [0.6, 1],
    guaranteed: [
      { categories: ['valuable'], minRarity: 'epic' },
      { categories: ['primary', 'secondary'], minRarity: 'common' },
      { categories: ['armor', 'bag', 'gadget'], minRarity: 'rare' },
    ],
    // Uniques: 6 × (10 × 0.25) = 15 of the ~97 legendary weapon weight (≈ 15 % of legendary weapon rolls, ≈ 2 % of all
    // tier-4 weapons). Their ammo: rare (40) × 0.025 = 1 each vs 4 × 5 for the standard calibres (≈ 23 % of ammo picks);
    // a rolled unique always brings one stack of its calibre on top (`rollCrate`).
    // Phase 12: the only container tier where a broken **legendary** (perk) implant can turn up
    itemWeightMul: { wpn_sr: 1.5, wpn_smg: 0.7, ...uniqueWeapons(0.25), ...uniqueAmmo(0.025), ...workingImplants(), ...brokenImplants({ legendary: 0.5 }) },
  },
  /*
   * Phase 3: ship-call supply drop (`SUPPLY_CRATE_TIER`) — consumables only, no valuables.
   * Phase 6: 3 % of drops carry a unique (the only weapons allowed here — every graded family is zeroed),
   * a little unique ammo, and 회로 기판 as the only material.
   */
  {
    tier: 5, label: '보급 투하 상자', count: [4, 6],
    rarityWeights: { common: 60, uncommon: 35, rare: 5, epic: 0, legendary: 1 },
    categoryWeights: { ammo: 45, stim: 30, grenade: 25, material: 4 },
    weaponChance: 0.03, maxStackQty: 6, ammoFraction: [0.6, 1],
    guaranteed: [{ categories: ['stim'], minRarity: 'common' }, { categories: ['ammo'], minRarity: 'common' }],
    itemWeightMul: {
      ...gradedFamilies(0), ...uniqueWeapons(1), ...uniqueAmmo(0.3),
      mat_scrap: 0, mat_bio_sample: 0, mat_alloy: 0, mat_power_cell: 0, mat_gunpowder: 0, mat_cable: 0, mat_circuit: 1,
      mat_cloth: 0, mat_can: 0, mat_syringe: 0, mat_antiseptic: 0,
    },
  },
];

export const LOOT_TABLE_MAP: ReadonlyMap<number, TierTable> = new Map(LOOT_TABLES.map((t) => [t.tier, t]));

export function getTierTable(tier: number): TierTable {
  const clamped = Math.max(1, Math.min(LOOT_TABLES.length, Math.round(tier)));
  return LOOT_TABLE_MAP.get(clamped) ?? LOOT_TABLES[0];
}

export function getTierLabel(tier: number): string {
  return getTierTable(tier).label;
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

/** Phase 6: chance of one extra legendary unique (`UNIQUE_WEAPON_IDS`, uniform) plus a stack of its calibre. */
export interface CorpseUnique {
  chance: number;
  /** Durability as a fraction of the def's max, drawn from [min, max]. */
  durability: readonly [number, number];
}

/** Phase 9: chance of one 서적 (uniform over `BOOK_ITEM_DEFS`) on a rogue corpse — the reading kind of raider. */
export interface CorpseBook {
  chance: number;
}

/**
 * Phase 12: chance of one **망가진 임플란트** (`IMPLANT_BROKEN_DEFS`, picked by `weights[rarity]`; 0 / missing = never) on a
 * rogue corpse — raiders wear implants and a kill shot fries them. Rolled last in `rollCorpse` so earlier draws never move.
 */
export interface CorpseImplant {
  chance: number;
  weights: Readonly<Partial<Record<Rarity, number>>>;
}

export interface CorpseTable {
  type: EnemyType;
  drops: readonly CorpseDrop[];
  /** Phase 9: 서적 roll (rogues only; bugs never carry books). */
  book?: CorpseBook;
  /** Phase 12: 망가진 임플란트 roll (rogues only; legendaries from the boss). */
  implant?: CorpseImplant;
  /** Rounds of the weapon's calibre as a fraction of `AMMO_STACK_ROUNDS`, one stack (rogues only). */
  ammoFraction?: readonly [number, number];
  weapon?: CorpseWeapon;
  unique?: CorpseUnique;
}

/**
 * Phase 8: bugs graze on the local flora, so an undigested 씨앗 turns up in a bug corpse now and then
 * (≈ 6.5 % of bug corpses carry one). Rogues never do — 씨앗 are otherwise loot (tier 1–3) or 기업 상점 only.
 * Phase 9: 서적 go the other way — rogue 3 % / boss 20 % (`CorpseTable.book`), never on a bug; tiers 2–4 carry `book: 3 / 3 / 2`.
 */
const BUG_SEEDS: readonly CorpseDrop[] = [
  { defId: 'seed_bloodroot', qty: [1, 1], chance: 0.04 },
  { defId: 'seed_ashleaf', qty: [1, 1], chance: 0.02 },
  { defId: 'seed_glowcap', qty: [1, 1], chance: 0.006 },
];

const BUG_BASE: readonly CorpseDrop[] = [
  { defId: 'mat_bio_sample', qty: [1, 3], chance: 1 },
  { defId: 'terminid_gland', qty: [1, 1], chance: 0.25 },
  ...BUG_SEEDS,
];
const ROGUE_AMMO: readonly [number, number] = [0.3, 0.6];

export const CORPSE_TABLES: readonly CorpseTable[] = [
  { type: 'scavenger', drops: BUG_BASE },
  { type: 'hunter', drops: BUG_BASE },
  { type: 'warrior', drops: BUG_BASE },
  { type: 'spewer', drops: [{ defId: 'mat_bio_sample', qty: [1, 3], chance: 1 }, { defId: 'terminid_gland', qty: [1, 1], chance: 0.6 }, ...BUG_SEEDS] },
  { type: 'charger', drops: [...BUG_BASE, { defId: 'mat_alloy', qty: [1, 2], chance: 0.4 }] },
  { type: 'toxic', drops: [{ defId: 'mat_bio_sample', qty: [1, 2], chance: 1 }, { defId: 'terminid_gland', qty: [1, 1], chance: 0.35 }, ...BUG_SEEDS] },
  { type: 'artillery', drops: [{ defId: 'mat_bio_sample', qty: [2, 3], chance: 1 }, { defId: 'mat_power_cell', qty: [1, 1], chance: 0.5 }, ...BUG_SEEDS] },
  {
    type: 'behemoth',
    drops: [
      { defId: 'mat_alloy', qty: [2, 4], chance: 1 },
      { defId: 'terminid_gland', qty: [1, 2], chance: 1 },
      { defId: 'alien_artifact', qty: [1, 1], chance: 0.3 },
      ...BUG_SEEDS,
    ],
  },
  {
    type: 'rogue', ammoFraction: ROGUE_AMMO,
    drops: [{ defId: 'heal_bandage', qty: [1, 1], chance: 0.3 }, { defId: 'grenade_frag', qty: [1, 1], chance: 0.2 }],
    weapon: { durability: [0.05, 0.15] },
    book: { chance: 0.03 },
    implant: { chance: 0.06, weights: { common: 55, uncommon: 30, rare: 12, epic: 3 } },
  },
  {
    type: 'rogue_boss', ammoFraction: ROGUE_AMMO,
    drops: [{ defId: 'heal_bandage', qty: [1, 2], chance: 1 }],
    weapon: { durability: [0.4, 0.7], grades: [3, 4], attachment: { maxRarity: 'epic' } },
    unique: { chance: 0.2, durability: [0.5, 0.8] },
    book: { chance: 0.2 },
    implant: { chance: 0.45, weights: { common: 10, uncommon: 25, rare: 30, epic: 25, legendary: 10 } },
  },
];

export const CORPSE_TABLE_MAP: ReadonlyMap<EnemyType, CorpseTable> = new Map(CORPSE_TABLES.map((t) => [t.type, t]));

/** Weapon a rogue carries when the caller passes no `rogueWeaponId`. */
export const DEFAULT_ROGUE_WEAPON_ID = 'ar';
