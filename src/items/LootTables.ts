import type { ItemCategory, Rarity } from '@/shared';

/**
 * Per-tier crate tables. Rolling picks a category by `categoryWeights`, then an
 * ItemDef of that category weighted by `rarityWeights[def.rarity]` (0 = never).
 * `guaranteed` entries are always added first and count toward `count`.
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
  /** Cap on stackable qty per roll (further limited by def.stackMax). */
  maxStackQty: number;
  guaranteed: readonly GuaranteedRoll[];
  /** Optional per-item multiplier on the rarity weight (item def id → factor; 0 = never at this tier). */
  itemWeightMul?: Readonly<Record<string, number>>;
}

export const LOOT_TABLES: readonly TierTable[] = [
  {
    tier: 1, label: '보급 상자', count: [2, 3],
    rarityWeights: { common: 80, uncommon: 18, rare: 2, epic: 0, legendary: 0 },
    categoryWeights: { ammo: 26, stim: 15, grenade: 12, material: 18, valuable: 13, gadget: 6, herb: 8, armor: 1, backpack: 1 },
    weaponChance: 0, maxStackQty: 3, guaranteed: [],
    itemWeightMul: { gad_turret: 0, gad_dome_shield: 0 },   // heavy deployables never in a supply crate
  },
  {
    tier: 2, label: '군수 상자', count: [3, 4],
    rarityWeights: { common: 45, uncommon: 38, rare: 15, epic: 2, legendary: 0 },
    categoryWeights: { ammo: 17, stim: 11, grenade: 9, material: 13, valuable: 30, gadget: 9, herb: 5, armor: 4, backpack: 2 },
    weaponChance: 0.35, maxStackQty: 4,
    guaranteed: [{ categories: ['valuable'], minRarity: 'uncommon' }],
    // SMGs are field-common; snipers rarely in supply crates; legendary gear is tier 3+ only
    itemWeightMul: {
      wpn_smg37: 1.3, wpn_sr9: 0.35,
      armor_regen: 0, armor_ultralight: 0, armor_optical: 0,
      bp_tactical: 0, bp_special: 0, bp_jump: 0, bp_5: 0.3,
    },
  },
  {
    tier: 3, label: '귀중품 금고', count: [4, 5],
    rarityWeights: { common: 15, uncommon: 30, rare: 40, epic: 14, legendary: 1 },
    categoryWeights: { ammo: 10, stim: 10, grenade: 6, material: 11, valuable: 42, gadget: 11, herb: 3, armor: 4, backpack: 3 },
    weaponChance: 0.55, maxStackQty: 5,
    guaranteed: [{ categories: ['valuable'], minRarity: 'rare' }],
    itemWeightMul: { wpn_sr9: 1.2, bp_tactical: 0.4, bp_special: 0.4, bp_jump: 0.4 },
  },
  {
    tier: 4, label: '희귀 캐시', count: [5, 6],
    rarityWeights: { common: 5, uncommon: 15, rare: 40, epic: 30, legendary: 10 },
    categoryWeights: { ammo: 8, stim: 9, grenade: 6, material: 8, valuable: 43, gadget: 12, herb: 2, armor: 7, backpack: 5 },
    weaponChance: 1, maxStackQty: 6,
    guaranteed: [
      { categories: ['valuable'], minRarity: 'epic' },
      { categories: ['primary', 'secondary'], minRarity: 'common' },
      { categories: ['armor', 'backpack', 'gadget'], minRarity: 'rare' },
    ],
    itemWeightMul: { wpn_sr9: 1.5, wpn_smg37: 0.7 },
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
