import type { EnemyType, ItemCategory, Rarity, WeaponGrade } from '@/shared';

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
   * of the family (`wpn_sr9` or `sr9`) applies to every grade of that family.
   */
  itemWeightMul?: Readonly<Record<string, number>>;
}

export const LOOT_TABLES: readonly TierTable[] = [
  {
    tier: 1, label: '보급 상자', count: [2, 3],
    rarityWeights: { common: 80, uncommon: 18, rare: 2, epic: 0, legendary: 0 },
    categoryWeights: { ammo: 30, stim: 18, grenade: 16, material: 20, valuable: 16, attachment: 6, gadget: 6, herb: 8, armor: 1 },
    weaponChance: 0, maxStackQty: 3, ammoFraction: [0.25, 0.5], guaranteed: [],
    itemWeightMul: { gad_turret: 0, gad_dome_shield: 0 },   // heavy deployables never in a supply crate
  },
  {
    tier: 2, label: '군수 상자', count: [3, 4],
    rarityWeights: { common: 45, uncommon: 38, rare: 15, epic: 2, legendary: 0 },
    categoryWeights: { ammo: 20, stim: 14, grenade: 12, material: 16, valuable: 38, attachment: 10, bag: 3, gadget: 9, herb: 5, armor: 4 },
    weaponChance: 0.35, maxStackQty: 4, ammoFraction: [0.35, 0.7],
    guaranteed: [{ categories: ['valuable'], minRarity: 'uncommon' }],
    // SMGs are field-common; snipers rarely in supply crates; legendary gear is tier 3+ only
    itemWeightMul: {
      wpn_smg37: 1.3, wpn_sr9: 0.35,
      armor_regen: 0, armor_ultralight: 0, armor_optical: 0,

    },
  },
  {
    tier: 3, label: '귀중품 금고', count: [4, 5],
    rarityWeights: { common: 15, uncommon: 30, rare: 40, epic: 14, legendary: 1 },
    categoryWeights: { ammo: 12, stim: 12, grenade: 8, material: 14, valuable: 54, attachment: 12, bag: 6, gadget: 11, herb: 3, armor: 4 },
    weaponChance: 0.55, maxStackQty: 5, ammoFraction: [0.5, 0.85],
    guaranteed: [{ categories: ['valuable'], minRarity: 'rare' }],
    itemWeightMul: { wpn_sr9: 1.2 },
  },
  {
    tier: 4, label: '희귀 캐시', count: [5, 6],
    rarityWeights: { common: 5, uncommon: 15, rare: 40, epic: 30, legendary: 10 },
    categoryWeights: { ammo: 10, stim: 12, grenade: 8, material: 10, valuable: 60, attachment: 12, bag: 8, gadget: 12, herb: 2, armor: 7 },
    weaponChance: 1, maxStackQty: 6, ammoFraction: [0.6, 1],
    guaranteed: [
      { categories: ['valuable'], minRarity: 'epic' },
      { categories: ['primary', 'secondary'], minRarity: 'common' },
      { categories: ['armor', 'bag', 'gadget'], minRarity: 'rare' },
    ],
    itemWeightMul: { wpn_sr9: 1.5, wpn_smg37: 0.7 },
  },
  /* Phase 3: ship-call supply drop (`SUPPLY_CRATE_TIER`) — consumables only, no weapons / valuables. */
  {
    tier: 5, label: '보급 투하 상자', count: [4, 6],
    rarityWeights: { common: 60, uncommon: 35, rare: 5, epic: 0, legendary: 0 },
    categoryWeights: { ammo: 45, stim: 30, grenade: 25 },
    weaponChance: 0, maxStackQty: 6, ammoFraction: [0.6, 1],
    guaranteed: [{ categories: ['stim'], minRarity: 'common' }, { categories: ['ammo'], minRarity: 'common' }],
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

export interface CorpseTable {
  type: EnemyType;
  drops: readonly CorpseDrop[];
  /** Rounds of the weapon's calibre as a fraction of `AMMO_STACK_ROUNDS`, one stack (rogues only). */
  ammoFraction?: readonly [number, number];
  weapon?: CorpseWeapon;
}

const BUG_BASE: readonly CorpseDrop[] = [
  { defId: 'mat_bio_sample', qty: [1, 3], chance: 1 },
  { defId: 'terminid_gland', qty: [1, 1], chance: 0.25 },
];
const ROGUE_AMMO: readonly [number, number] = [0.3, 0.6];

export const CORPSE_TABLES: readonly CorpseTable[] = [
  { type: 'scavenger', drops: BUG_BASE },
  { type: 'hunter', drops: BUG_BASE },
  { type: 'warrior', drops: BUG_BASE },
  { type: 'spewer', drops: [{ defId: 'mat_bio_sample', qty: [1, 3], chance: 1 }, { defId: 'terminid_gland', qty: [1, 1], chance: 0.6 }] },
  { type: 'charger', drops: [...BUG_BASE, { defId: 'mat_alloy', qty: [1, 2], chance: 0.4 }] },
  { type: 'toxic', drops: [{ defId: 'mat_bio_sample', qty: [1, 2], chance: 1 }, { defId: 'terminid_gland', qty: [1, 1], chance: 0.35 }] },
  { type: 'artillery', drops: [{ defId: 'mat_bio_sample', qty: [2, 3], chance: 1 }, { defId: 'mat_power_cell', qty: [1, 1], chance: 0.5 }] },
  {
    type: 'behemoth',
    drops: [
      { defId: 'mat_alloy', qty: [2, 4], chance: 1 },
      { defId: 'terminid_gland', qty: [1, 2], chance: 1 },
      { defId: 'alien_artifact', qty: [1, 1], chance: 0.3 },
    ],
  },
  {
    type: 'rogue', ammoFraction: ROGUE_AMMO,
    drops: [{ defId: 'stim', qty: [1, 1], chance: 0.3 }, { defId: 'grenade_frag', qty: [1, 1], chance: 0.2 }],
    weapon: { durability: [0.05, 0.15] },
  },
  {
    type: 'rogue_boss', ammoFraction: ROGUE_AMMO,
    drops: [{ defId: 'stim', qty: [1, 2], chance: 1 }],
    weapon: { durability: [0.4, 0.7], grades: [3, 4], attachment: { maxRarity: 'epic' } },
  },
];

export const CORPSE_TABLE_MAP: ReadonlyMap<EnemyType, CorpseTable> = new Map(CORPSE_TABLES.map((t) => [t.type, t]));

/** Weapon a rogue carries when the caller passes no `rogueWeaponId`. */
export const DEFAULT_ROGUE_WEAPON_ID = 'ar23';
