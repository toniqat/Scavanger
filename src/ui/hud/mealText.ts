import type { MealBuff, MealDef, MealEffect } from '@/shared';
import { MEAL_BUFF_LABEL_KO, MEAL_BUFF_UNIT, MEAL_TIER_LABEL_KO } from '@/shared';
/* 2026-09-13 (cooking minigame — docs/DECISIONS.md 「2026-09-13 — 요리 미니게임」): meal quality · cook steps */
import { COOK_GAME_LABEL_KO, cookStepsOf, mealQualityBonus, mealQualityStars, normalizeMealQuality } from '@/shared';

/**
 * A cooking buff as one human-readable piece (A-3c, 2026-09-11). A folder-wide presentation helper of the same kind as
 * `hud/stratagemGlyphs` — pulled out because the meal badge and the item tooltip (`hud/ItemTip`) had to print
 * the same sentence (CLAUDE.md's 「what two places use is pulled into one」 applied inside the folder). On
 * 2026-09-12 that badge became the buff thumbnail strip (`hud/BuffStrip`) and the `hud/MealBadge` file went
 * away with it, so the consumers today are the tooltip · the buff thumbnail title, but the source of the meal
 * value format is still here.
 *
 * The table that decides the unit is **`MEAL_BUFF_UNIT` in `shared/labels`, that one alone**: only a `'%'` row scales
 * `amount` by 100 (a multiplier addend, so 0.15 = +15 %), `'kg'` · `'m'` keep the unit as it is, `''` prints the number
 * alone. No new unit is judged here — a new buff gets a row in that table and this file does not change by one line.
 *
 * Only `durabilityLossMul` has a **negative** `amount` (less gear damage is the gain). Printing the sign as it is gives
 * 「장비 손상 −20 %」, which reads as the gain — so the absolute value is not taken and the sign is not flipped.
 *
 * **2026-09-13 (cooking ingredient tiers)**: one meal holds several stat rows (`MealDef.effects`, T1 1 · T2 2 · T3 3 · T4 4).
 * Whatever shows a meal takes the row list from `mealEffects(meal)` — an old def with no `effects` reads as the one row
 * `[{buff, amount}]` (the same rule as `progression/derive.mealEffectsOf`; folders never import each other, so there is
 * a second copy here).
 */
export function mealBuffAmountText(buff: MealBuff, amount: number): string {
  const unit = MEAL_BUFF_UNIT[buff] ?? '';
  const raw = unit === '%' ? amount * 100 : amount;
  const n = Math.round(raw * 10) / 10;
  const mag = Math.abs(n);
  const num = Number.isInteger(mag) ? String(mag) : mag.toFixed(1);
  return `${n < 0 ? '−' : '+'}${num}${unit ? ` ${unit}` : ''}`;
}

/** `운반 무게 +6 kg` — one row with the label attached (the buff thumbnail title uses it; the tooltip makes the label its row name, so it uses only the function above). */
export function mealBuffText(buff: MealBuff, amount: number): string {
  return `${MEAL_BUFF_LABEL_KO[buff] ?? buff} ${mealBuffAmountText(buff, amount)}`;
}

/**
 * 2026-09-13: every stat row of a meal — `effects` when it has them, else the old single `buff` · `amount` row, and an empty list when it is not a meal.
 *
 * 2026-09-13 (meal quality): given `quality` (stars 0 … 5, omitted = 0) it returns a **new list** whose every row is multiplied by
 * `amount × (1 + mealQualityBonus(quality))` — the same formula `progression/derive.applyMealBuff` adds when the meal is eaten (the
 * addition and the 0 floor are derive's part; here only the numbers to show are made). Quality 0 returns the original array as it is.
 */
export function mealEffects(meal: MealDef | null | undefined, quality = 0): readonly MealEffect[] {
  if (!meal) return [];
  const list = (meal as Partial<MealDef>).effects;
  const base: readonly MealEffect[] = Array.isArray(list) && list.length > 0 ? list : meal.buff ? [{ buff: meal.buff, amount: meal.amount }] : [];
  const mul = 1 + mealQualityBonus(quality);
  if (mul === 1) return base;
  return base.map((e) => ({ buff: e.buff, amount: e.amount * mul }));
}

/** 2026-09-13: `['최대 스태미나 +20', '운반 무게 +5 kg']` — one meal's stat rows with their labels attached. `quality` = meal quality (bonus folded in). */
export function mealEffectLines(meal: MealDef | null | undefined, quality = 0): string[] {
  return mealEffects(meal, quality).map((e) => mealBuffText(e.buff, e.amount));
}

/** 2026-09-13: every stat row as one string (default ` · `). An empty string when there is no row. `quality` = meal quality (bonus folded in). */
export function mealEffectsText(meal: MealDef | null | undefined, sep = ' · ', quality = 0): string {
  return mealEffectLines(meal, quality).join(sep);
}

/** 2026-09-13 (meal quality): `★★★☆☆ +15 %` — stars + the numeric bonus. An empty string at quality 0 (the quality row itself is not drawn). */
export function mealQualityText(quality: unknown): string {
  const q = normalizeMealQuality(quality);
  if (q <= 0) return '';
  const pct = Math.round(mealQualityBonus(q) * 100);
  return `${mealQualityStars(q)} +${pct} %`;
}

/** Step number glyph — circled digits for more steps than `COOK_STEPS_MAX` allows today, plain numbers past the table. */
const STEP_MARK = ['①', '②', '③', '④', '⑤'];

/**
 * 2026-09-13 (cooking minigame): `① 썰기 → ② 젓기` — the order of the minigames played when that meal is made at the cook
 * bench (`cookStepsOf`, `data/cook_steps.csv`). An empty string when it is not a cook-bench meal.
 */
export function cookStepsText(mealDefId: string | null | undefined): string {
  if (!mealDefId) return '';
  const steps = cookStepsOf(mealDefId);
  return steps.map((s, i) => `${STEP_MARK[i] ?? `${i + 1}.`} ${COOK_GAME_LABEL_KO[s.game] ?? s.game}`).join(' → ');
}

/** 2026-09-13: the meal tier name (`MEAL_TIER_LABEL_KO` — 채소 · 페이스트 · 고기 · 유제품 요리). An empty string for an unknown tier. */
export function mealTierLabel(meal: MealDef | null | undefined): string {
  return meal ? (MEAL_TIER_LABEL_KO[meal.tier] ?? '') : '';
}
