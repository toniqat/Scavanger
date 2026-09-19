import type { CraftIngredient, CraftRecipe } from '@/shared';
import { CRAFT_DEFAULT_TIME, WORKBENCH_KINDS, csvRows } from '@/shared';
/* appended (2026-09-13, library series): the cook recipes a recipe book opens → `CraftRecipe.unlockSeries` */
import { LIBRARY_SERIES_DEFS } from '@/shared';

/**
 * Recipe id → the id of the **recipe book series** that opens it. The source is one `recipe:<recipe id>` effect
 * in `data/library_series.csv` (no separate csv column). When several series point at the same recipe the first
 * one wins — data:check checks that the target is a cook-bench recipe.
 */
const RECIPE_UNLOCK_SERIES: ReadonlyMap<string, string> = (() => {
  const out = new Map<string, string>();
  for (const s of LIBRARY_SERIES_DEFS) {
    for (const e of s.effects) if (e.kind === 'recipe' && !out.has(e.target)) out.set(e.target, s.id);
  }
  return out;
})();

/**
 * **Craft** recipes (`data/recipes.csv`). Salvage is not here — `Salvage.ts` builds it from `data/salvage.csv`
 * and the **craft inputs** of this table (2026-09-10, the big craft rework).
 *
 * The flow:
 *  1. **Ammo crafting** — 화약 + 폐금속/합금 → the ammo type wanted (the input is the 화약 salvage yields).
 *  2. **Field ordnance · medicine** — smoke / incendiary grenades, 붕대 · 약초 붕대 (`station: 'field'`).
 *  3. **가공 작업대** (`bench: 'refine'`, 2026-09-10) — lower materials → the **upper-tier materials** (the
 *     `refine_*` rows of the csv). Upper-tier materials come from here only, and every grade IV~V piece of gear
 *     requires them.
 *  4. **총기 / 장비 / 가젯 / 의학 작업대** — weapons · attachments · armor · bags · gadgets · shield chargers;
 *     which window a row shows in is its `bench` column. `benchLevel` is the grade threshold
 *     (Lv.1 low · Lv.2 mid · Lv.3 high).
 *
 * `station: 'field'` recipes also work on the ship; `'ship'` recipes without `bench` work at any ship workbench.
 */
const RECIPE_ROWS = csvRows('recipes.csv');

const recipeOf = (r: (typeof RECIPE_ROWS)[number]): CraftRecipe => ({
  id: r.str('id'),
  name: r.str('name'),
  station: r.enum('station', ['field', 'ship'] as const),
  inputs: r.costList('inputs'),
  outputDefId: r.str('outputDefId'),
  outputQty: r.int('outputQty', { min: 1 }),
  duration: r.num('duration', { min: 0, fallback: CRAFT_DEFAULT_TIME }),
  skill: r.enum('skill', ['crafting', 'medicine', 'gardening'] as const),
  skillRequired: r.int('skillRequired', { min: 0 }),
  description: r.str('description'),
  /* 2026-09-10: 'refine' (가공 작업대 — renamed 2026-09-12, the kind id stays `refine`) added —
     `WorkbenchKind` already accepts that value.
     2026-09-11: 'extract' (추출기) · 'mixer' (조합대) — the two lab benches.
     2026-09-11 (A-3c · A-15): 'cook' (조리대) · 'print' (3D 프린터). This spot was **copying `WorkbenchKind`
     out**, so every added workbench had to be fixed here too — now it uses `WORKBENCH_KINDS` as it is
     (the contract is the source). */
  ...(r.has('bench') ? { bench: r.enum('bench', WORKBENCH_KINDS) } : {}),
  ...(r.has('benchLevel') ? { benchLevel: r.int('benchLevel', { min: 1 }) } : {}),
  ...(r.has('extraOutputs') ? { extraOutputs: r.costList('extraOutputs') } : {}),
  /* 2026-09-13: a recipe open only while its recipe book is shelved (housing's `isRecipeUnlocked` reads it) */
  ...(RECIPE_UNLOCK_SERIES.has(r.raw('id')) ? { unlockSeries: RECIPE_UNLOCK_SERIES.get(r.raw('id'))! } : {}),
});

/** Every recipe that shows in the craft list (in `data/recipes.csv` order). */
export const CRAFT_RECIPES: readonly CraftRecipe[] = RECIPE_ROWS.map(recipeOf);

/**
 * **The materials one new item costs to make.** Repair bills and salvage yields all come out of this table
 * (`Salvage.ts`), so the one place that decides an item's "worth" is `data/recipes.csv`.
 *
 * Recipes with `outputQty > 1` (ammo · batch crafts) are **left out** — the materials for a single unit do not
 * come out whole, so they cannot be a baseline. With several recipes making the same item, the **first row** is
 * the baseline.
 */
export const CRAFT_COST_BY_OUTPUT: ReadonlyMap<string, readonly CraftIngredient[]> = (() => {
  const out = new Map<string, readonly CraftIngredient[]>();
  for (const r of CRAFT_RECIPES) {
    if (r.outputQty !== 1 || out.has(r.outputDefId)) continue;
    out.set(r.outputDefId, r.inputs);
  }
  return out;
})();

/** This item's craft inputs (empty array when there are none). The returned array is shared — do not modify it. */
export function craftCostOf(defId: string): readonly CraftIngredient[] {
  return CRAFT_COST_BY_OUTPUT.get(defId) ?? [];
}
