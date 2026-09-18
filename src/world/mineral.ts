/**
 * src/world/mineral.ts — **planet 광맥** numbers (2026-09-16 user's decision 「a vein stands per planet; mining it yields 미확인 광물 by difficulty」).
 *
 * The same place as `world/soil.ts` · `flora.ts` · `specimen.ts`: it only carries one or two csv columns over into types, and uses no THREE.
 * Two columns are read.
 *
 *  - `mineralNodes` in `data/planets.csv` — how many veins stand on this planet (0 = none).
 *  - the `tier = that planet's threat` row of `data/loot_tiers.csv` — the **rarity weights** of the 미확인 광물 a vein yields.
 *
 * ⚠ The rarity table is **not** read through `@/items`' `getTierTable(...).rarityWeights`. That one is cut to the five
 * rarities of `RARITY_ORDER_LOOT` (common … legendary), and that cut **is** the rule "crate · corpse rolls never draw mythic".
 * The vein is the **only** path allowed to draw mythic (미확인 광물 VI = where unique weapons come from), so the `mythic` column is read here.
 * So the user's decision 「the same probability table as weapon drops」 holds without a new table — the difficulty 1 row
 * has epic · legendary · mythic weights of 0, so it stops at rare by itself (not one difficulty exception in code).
 */
import { RARITY_ORDER, csvRows, type Rarity } from '@/shared';

/* ── data/planets.csv: mineralNodes ─────────────────────────────────────── */

const NODES_BY_PLANET = new Map<string, number>();
for (const r of csvRows('planets.csv')) {
  const id = r.raw('id');
  if (!id) continue;
  NODES_BY_PLANET.set(id, Math.max(0, Math.round(r.num('mineralNodes', { min: 0, fallback: 0 }))));
}

/**
 * How many veins stand on this planet. No planet chosen or an unknown id → 0 — **no vein is placed**
 * (the same convention as `planetSoil` · `planetSeeds` · `planetSamples`).
 */
export function planetMineralNodes(planetId: string | null | undefined): number {
  if (!planetId) return 0;
  return NODES_BY_PLANET.get(planetId) ?? 0;
}

/* ── data/loot_tiers.csv: rarity weights (mythic included) ──────────────── */

/** Weights in the same order as `RARITY_ORDER` (common … mythic). Never negative; 0 = never appears at this difficulty. */
export type RarityWeights = readonly number[];

const WEIGHTS_BY_TIER = new Map<number, RarityWeights>();
for (const r of csvRows('loot_tiers.csv')) {
  const tier = r.int('tier', { min: 1 });
  WEIGHTS_BY_TIER.set(tier, RARITY_ORDER.map((q) => Math.max(0, r.num(q, { min: 0, fallback: 0 }))));
}

/** The last answer, so a table whose weights are all 0 does not kill the roll (common 1). */
const FALLBACK: RarityWeights = RARITY_ORDER.map((_, i) => (i === 0 ? 1 : 0));

/**
 * The rarity weights a vein roll uses — **the `tier = planet threat` row** (user's decision: the same table as weapon drops).
 * An unknown difficulty falls back to the lowest row.
 */
export function mineralRarityWeights(threat: number): RarityWeights {
  const t = Math.max(1, Math.round(threat));
  return WEIGHTS_BY_TIER.get(t) ?? WEIGHTS_BY_TIER.get(1) ?? FALLBACK;
}

/**
 * How the 채광 skill (`DerivedStats.miningRarityBonus`, 0 … 1) redraws the weights — **as a multiplier**.
 *
 * Measured from the **lowest rarity** that difficulty allows (the first with a non-zero weight): one step above it is
 * multiplied by `1 + bonus`, two steps by `1 + 2·bonus` … Being a multiplier **proves** the contract's
 * (`shared/progression.ts`) "the cap the difficulty holds shut cannot be passed": a rarity weighted 0 stays 0 under any
 * multiplier, so however high 채광 goes it contributes not one piece to the drawn total. Addition (a floor value) would
 * break that guarantee, so it is never added. Growing the multiplier by step count is the skill text itself — "the **higher** rarities rise more".
 */
function bonusMulAt(index: number, lowest: number, bonus: number): number {
  return 1 + bonus * Math.max(0, index - lowest);
}

/**
 * One vein roll. `roll` is a random number in [0, 1), `bonus` is `derived.miningRarityBonus`.
 * Allocation-free (two passes) — gathering is not a hot path, but it keeps the same convention.
 */
export function rollMineralRarity(weights: RarityWeights, bonus: number, roll: number): Rarity {
  let lowest = -1;
  for (let i = 0; i < weights.length; i++) if (weights[i] > 0) { lowest = i; break; }
  if (lowest < 0) return RARITY_ORDER[0];     // this difficulty allows no rarity at all — fall back to the lowest
  const b = bonus > 0 ? bonus : 0;
  let total = 0;
  for (let i = lowest; i < weights.length; i++) total += weights[i] * bonusMulAt(i, lowest, b);
  if (!(total > 0)) return RARITY_ORDER[lowest];
  let r = (roll >= 0 && roll < 1 ? roll : 0) * total;
  for (let i = lowest; i < weights.length; i++) {
    const w = weights[i] * bonusMulAt(i, lowest, b);
    if (r < w) return RARITY_ORDER[i];
    r -= w;
  }
  return RARITY_ORDER[lowest];
}
