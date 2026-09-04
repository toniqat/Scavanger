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
}

export const LOOT_TABLES: readonly TierTable[] = [
  {
    tier: 1, label: '보급 상자', count: [2, 3],
    rarityWeights: { common: 80, uncommon: 18, rare: 2, epic: 0, legendary: 0 },
    categoryWeights: { ammo: 30, stim: 18, grenade: 16, material: 20, valuable: 16 },
    weaponChance: 0, maxStackQty: 3, guaranteed: [],
  },
  {
    tier: 2, label: '군수 상자', count: [3, 4],
    rarityWeights: { common: 45, uncommon: 38, rare: 15, epic: 2, legendary: 0 },
    categoryWeights: { ammo: 20, stim: 14, grenade: 12, material: 16, valuable: 38 },
    weaponChance: 0.35, maxStackQty: 4,
    guaranteed: [{ categories: ['valuable'], minRarity: 'uncommon' }],
  },
  {
    tier: 3, label: '귀중품 금고', count: [4, 5],
    rarityWeights: { common: 15, uncommon: 30, rare: 40, epic: 14, legendary: 1 },
    categoryWeights: { ammo: 12, stim: 12, grenade: 8, material: 14, valuable: 54 },
    weaponChance: 0.55, maxStackQty: 5,
    guaranteed: [{ categories: ['valuable'], minRarity: 'rare' }],
  },
  {
    tier: 4, label: '희귀 캐시', count: [5, 6],
    rarityWeights: { common: 5, uncommon: 15, rare: 40, epic: 30, legendary: 10 },
    categoryWeights: { ammo: 10, stim: 12, grenade: 8, material: 10, valuable: 60 },
    weaponChance: 1, maxStackQty: 6,
    guaranteed: [
      { categories: ['valuable'], minRarity: 'epic' },
      { categories: ['primary', 'secondary'], minRarity: 'common' },
    ],
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
