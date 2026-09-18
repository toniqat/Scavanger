/**
 * src/shared/meals.ts — **the meal definition table** (2026-09-16, the plate model — user's decision: a meal is no longer an inventory item).
 *
 * A meal cooked at the cook bench does not become an item but **a plate on the dining table** (`ShipState.plate`, the plate section of `shared/housing.ts`).
 * Every meal still needs a name · rarity · icon · tier · stat lines — the dining table · the cook bench screen · the buff thumbnail · the hover card · progression (`derive.applyMealBuff`)
 * all read them. That table is here (`data/meals.csv`). items/ used to move this table into `ItemDef` and put it in `ITEM_DEFS`, and everyone
 * read it as `ctx.loot.getItemDef(id).meal` — now it is read as `getMealDef(id)` (`ctx.loot` knows nothing about meals).
 *
 * Why the shape is still `ItemDef`: the chip (`buildItemChip`) · the hover card · the buff thumbnail already read `ItemDef`'s `name · icon · color · rarity ·
 * description · meal`. It is a display def only and **never goes into any grid** (`width` · `height` · `stackMax` · `value` ·
 * `weight` are fixed values that fill the shape out — there is no sell price and no weight).
 *
 * One meal raises **one buff** and that buff carries **several stat lines** — a tier n meal = n lines (`MealDef.effects`, the csv's `effects` cell =
 * `버프:수치` joined by `|`). A `retired` meal (the 4 old specials) is left out of the line-count check — it stays in the table so an old profile's pending meal id still resolves.
 */
import { csvRows } from './data/tables';
import { RARITY_COLORS, RARITY_ORDER } from './labels';
import type { ItemDef, MealBuff, MealDef, MealEffect } from './types';
import { MEAL_BUFFS } from './types';

/** A meal def — an `ItemDef` shape that always has `meal` (display only, not an item). */
export type MealItemDef = ItemDef & { meal: MealDef };

export const MEAL_DEFS: readonly MealItemDef[] = csvRows('meals.csv').map((r) => {
  const retired = r.has('retired') && r.bool('retired');
  const tier = r.int('tier', { min: 1, max: 4 }) as MealDef['tier'];
  const effects: MealEffect[] = [];
  /* `costList` splits `버프:수치` (the number may be negative and an `=` expression is allowed — `durabilityLossMul` is −0.2). The buff name is checked here. */
  for (const c of r.costList('effects')) {
    if (!(MEAL_BUFFS as readonly string[]).includes(c.defId)) {
      r.report('effects', `'${c.defId}' 는 ${MEAL_BUFFS.join(' | ')} 중 하나여야 한다`);
      continue;
    }
    if (effects.some((e) => e.buff === c.defId)) { r.report('effects', `'${c.defId}' 가 두 번 나온다 — 한 요리에 같은 능력치는 한 줄이다`); continue; }
    if (c.qty === 0) r.report('effects', `'${c.defId}' 의 수치가 0 이다`);
    effects.push({ buff: c.defId as MealBuff, amount: c.qty });
  }
  if (effects.length === 0) r.report('effects', '능력치가 하나도 없다 — "버프:수치" 를 | 로 잇는다');
  else if (!retired && effects.length !== tier) r.report('effects', `티어 ${tier} 요리는 능력치가 ${tier} 줄이어야 한다 (지금 ${effects.length} 줄)`);
  const first: MealEffect = effects[0] ?? { buff: MEAL_BUFFS[0], amount: 0 };
  const meal: MealDef = { buff: first.buff, amount: first.amount, tier, effects };
  const rarity = r.enum('rarity', RARITY_ORDER);
  // The colour is simply the rarity colour — a meal's rarity is its tier, so the chip's colour says 「what tier this meal is」 (the same as the old items/ `def()` default).
  const def: MealItemDef = {
    id: r.str('id'), name: r.str('name'), category: 'meal', rarity,
    width: 1, height: 1, stackMax: 1, value: 0, weight: 0,
    icon: r.str('icon'), description: r.str('description'), color: RARITY_COLORS[rarity], meal,
    ...(retired ? { retired: true } : {}),
  };
  return def;
});

export const MEAL_DEF_MAP: ReadonlyMap<string, MealItemDef> = new Map(MEAL_DEFS.map((d) => [d.id, d]));

/** The def of a meal id, undefined when it is not a meal. */
export function getMealDef(id: string | null | undefined): MealItemDef | undefined {
  return typeof id === 'string' && id ? MEAL_DEF_MAP.get(id) : undefined;
}

/** Is this a meal id (retired meals included). */
export function isMealDefId(id: unknown): id is string {
  return typeof id === 'string' && MEAL_DEF_MAP.has(id);
}
