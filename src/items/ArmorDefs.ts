import type { ArmorDef } from '@/shared';
import { csvRows } from '@/shared';

/**
 * Body armor (`방탄복`) — the numbers come from `data/armor.csv`.
 *
 * **2026-09-10 — armor gives a shield (extra health), not damage reduction.** The numbered armors I..V take
 * their `shield` straight from `data/tables.csv` through the csv's `=ARMOR_SHIELD_BY_TIER.3` (20/40/60/80/100),
 * and the three uniques write the converted old damage reduction directly,
 * `round(damageReduction / ARMOR_DR_BY_TIER.5 × 100)` (`재생` 90 · `초경량` 33 · `광학미채` 27).
 * `damageReduction` is only the column that conversion was based on, so **nobody reads it** (see the comment in
 * `shared/gear.ts` — it was not deleted because the contract is add-only).
 *
 * `player/` holds a pool of `shield` and takes damage out of that pool **before** health, wearing the plate down
 * by what the shield absorbed through `ctx.inventory.damageDurability`. Durability 0 = broken = shield max 0
 * (a charger cannot refill it either).
 *
 * Weight is deliberately *not* proportional to the grid footprint — the heaviest plates cost more
 * of the carry budget than their cells suggest, and the ultralight vest is almost free.
 */
export const ARMOR_DEFS: readonly ArmorDef[] = csvRows('armor.csv').map((r) => ({
  id: r.str('id'),
  name: r.str('name'),
  tier: r.int('tier', { min: 0 }),
  rarity: r.str('rarity') as ArmorDef['rarity'],
  description: r.str('description'),
  damageReduction: r.num('damageReduction', { min: 0, max: 1 }),
  shield: r.num('shield', { min: 0 }),
  weight: r.num('weight', { min: 0 }),
  durabilityMax: r.int('durabilityMax', { min: 1 }),
  perk: r.enum('perk', ['none', 'regen', 'ultralight', 'optical'] as const),
  ...(r.has('perkValue') ? { perkValue: r.num('perkValue') } : {}),
  color: r.str('color'),
}));

export const ARMOR_DEF_MAP: ReadonlyMap<string, ArmorDef> = new Map(ARMOR_DEFS.map((a) => [a.id, a]));

export function getArmorDef(armorId: string): ArmorDef | undefined {
  return ARMOR_DEF_MAP.get(armorId);
}

/**
 * Grid footprint of the carried (unequipped) plate.
 *
 * **2026-09-12 — every armor is 2×2** (user's decision). Before, only `초경량` · `광학미채` · I–II were 2×2
 * while III–V and `재생` were 2×3, so carrying one late-game vest cost a whole row of the bag. The burden of a
 * higher tier weighing more is already carried by `weight` (`data/armor.csv`), so there is no reason to charge
 * for it a second time in cells.
 *
 * **The function is not deleted** now that the value is a constant — `ItemDefs.armorItem()` fills `width`/`height`
 * from it in the one place, and splitting the size by grade · perk again would be fixed here alone.
 */
export function armorItemSize(_def: ArmorDef): { width: number; height: number } {
  return { width: 2, height: 2 };
}

/** Icon glyph per armor id (procedural text glyph, no asset files) — the `icon` column of `data/armor.csv`. */
export const ARMOR_ICON: Readonly<Record<string, string>> =
  Object.fromEntries(csvRows('armor.csv').map((r) => [r.str('id'), r.str('icon')]));
