import type { ArmorDef } from '@/shared';
import { csvRows } from '@/shared';

/**
 * Body armor (방탄복) — 수치의 원본은 `data/armor.csv` 다. Numbered I..V follow `ARMOR_DR_BY_TIER` exactly
 * (csv 가 `=ARMOR_DR_BY_TIER.3` 으로 그 표를 가리킨다); the three uniques trade
 * damage reduction for a perk. `player/` reads `damageReduction` on every hit and wears the plate
 * down through `ctx.inventory.damageDurability`; a broken plate gives 0 DR.
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

/** Grid footprint of the carried (unequipped) plate. Heavy plates are bulky, the ultralight vest folds up. */
export function armorItemSize(def: ArmorDef): { width: number; height: number } {
  if (def.perk === 'ultralight') return { width: 2, height: 2 };
  if (def.perk === 'optical') return { width: 2, height: 2 };
  if (def.tier > 0 && def.tier <= 2) return { width: 2, height: 2 };
  return { width: 2, height: 3 };
}

/** Icon glyph per armor id (procedural text glyph, no asset files) — `data/armor.csv` 의 `icon` 칸. */
export const ARMOR_ICON: Readonly<Record<string, string>> =
  Object.fromEntries(csvRows('armor.csv').map((r) => [r.str('id'), r.str('icon')]));
