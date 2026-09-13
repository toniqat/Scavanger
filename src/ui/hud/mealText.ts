import type { MealBuff, MealDef, MealEffect } from '@/shared';
import { MEAL_BUFF_LABEL_KO, MEAL_BUFF_UNIT, MEAL_TIER_LABEL_KO } from '@/shared';
/* 2026-09-13 (요리 미니게임 — docs/plans/cooking-minigames.md §6-5): 요리 품질 · 조리 단계 */
import { COOK_GAME_LABEL_KO, cookStepsOf, mealQualityBonus, mealQualityStars, normalizeMealQuality } from '@/shared';

/**
 * 요리 버프를 사람이 읽는 한 조각으로 (A-3c, 2026-09-11). `hud/stratagemGlyphs` 와 같은 성격의 폴더 공용
 * 표현 헬퍼다 — 식사 배지(`hud/MealBadge`)와 아이템 툴팁(`hud/ItemTip`)이 같은 문장을 써야 해서 뽑았다
 * (CLAUDE.md 의 「같은 것을 두 곳이 쓰면 하나로 뽑는다」를 폴더 안에서 적용한 것). 2026-09-12 에 식사 배지는
 * 버프 썸네일 줄(`hud/BuffStrip`)로 대체되어 지금 소비자는 툴팁 · 버프 썸네일 title 이지만, 요리 값 포맷의 원본은 계속 여기다.
 *
 * 단위를 정하는 표는 **`shared/labels` 의 `MEAL_BUFF_UNIT` 하나**다: `'%'` 인 줄만 `amount` 를 100 배하고
 * (배수 가산이라 0.15 = +15 %), `'kg'` · `'m'` 은 단위 그대로, `''` 는 숫자만 찍는다. 여기서 새 단위를
 * 판단하지 않는다 — 새 버프가 생기면 그 표에 줄이 생기고 이 파일은 한 줄도 안 바뀐다.
 *
 * `durabilityLossMul` 만 `amount` 가 **음수**다 (장비 손상이 줄어드는 것이 이득이다). 부호를 그대로 찍으면
 * 「장비 손상 −20 %」가 되어 이득으로 읽힌다 — 그래서 절댓값을 취하거나 부호를 뒤집지 않는다.
 *
 * **2026-09-13 (요리 재료 티어)**: 요리 하나가 능력치 줄을 여러 개 갖는다 (`MealDef.effects`, T1 1 · T2 2 · T3 3 · T4 4).
 * 요리를 보여 주는 곳은 `mealEffects(meal)` 로 줄 목록을 받는다 — `effects` 가 없는 옛 def 는 `[{buff, amount}]` 한 줄로 읽는다
 * (`progression/derive.mealEffectsOf` 와 같은 규칙; 폴더끼리 import 하지 않으므로 여기 한 벌 더 있다).
 */
export function mealBuffAmountText(buff: MealBuff, amount: number): string {
  const unit = MEAL_BUFF_UNIT[buff] ?? '';
  const raw = unit === '%' ? amount * 100 : amount;
  const n = Math.round(raw * 10) / 10;
  const mag = Math.abs(n);
  const num = Number.isInteger(mag) ? String(mag) : mag.toFixed(1);
  return `${n < 0 ? '−' : '+'}${num}${unit ? ` ${unit}` : ''}`;
}

/** `운반 무게 +6 kg` — 라벨까지 붙인 한 줄 (배지가 쓴다; 툴팁은 라벨을 행 이름으로 쓰므로 위 함수만 쓴다). */
export function mealBuffText(buff: MealBuff, amount: number): string {
  return `${MEAL_BUFF_LABEL_KO[buff] ?? buff} ${mealBuffAmountText(buff, amount)}`;
}

/**
 * 2026-09-13: 요리의 능력치 줄 전부 — `effects` 가 있으면 그것, 없으면 옛 `buff` · `amount` 한 줄, 요리가 아니면 빈 목록.
 *
 * 2026-09-13 (요리 품질): `quality`(별 0 … 5, 생략 = 0)를 주면 줄마다 `amount × (1 + mealQualityBonus(quality))` 로 곱한 **새 목록**을
 * 돌려준다 — `progression/derive.applyMealBuff` 가 먹었을 때 더하는 값과 같은 식이다 (가산 + 0 하한은 derive 의 몫이고 여기서는
 * 보여 줄 수치만 만든다). 품질 0 이면 원래 배열을 그대로 돌려준다.
 */
export function mealEffects(meal: MealDef | null | undefined, quality = 0): readonly MealEffect[] {
  if (!meal) return [];
  const list = (meal as Partial<MealDef>).effects;
  const base: readonly MealEffect[] = Array.isArray(list) && list.length > 0 ? list : meal.buff ? [{ buff: meal.buff, amount: meal.amount }] : [];
  const mul = 1 + mealQualityBonus(quality);
  if (mul === 1) return base;
  return base.map((e) => ({ buff: e.buff, amount: e.amount * mul }));
}

/** 2026-09-13: `['최대 스태미나 +20', '운반 무게 +5 kg']` — 요리 한 개의 능력치 줄을 라벨까지 붙여서. `quality` = 요리 품질 (보너스 반영). */
export function mealEffectLines(meal: MealDef | null | undefined, quality = 0): string[] {
  return mealEffects(meal, quality).map((e) => mealBuffText(e.buff, e.amount));
}

/** 2026-09-13: 능력치 줄 전부를 한 문자열로 (기본 ` · `). 줄이 없으면 빈 문자열. `quality` = 요리 품질 (보너스 반영). */
export function mealEffectsText(meal: MealDef | null | undefined, sep = ' · ', quality = 0): string {
  return mealEffectLines(meal, quality).join(sep);
}

/** 2026-09-13 (요리 품질): `★★★☆☆ +15 %` — 별 + 수치 보너스. 품질 0 이면 빈 문자열 (품질 줄 자체를 그리지 않는다). */
export function mealQualityText(quality: unknown): string {
  const q = normalizeMealQuality(quality);
  if (q <= 0) return '';
  const pct = Math.round(mealQualityBonus(q) * 100);
  return `${mealQualityStars(q)} +${pct} %`;
}

/** 단계 번호 글자 (`COOK_STEPS_MAX` 3 을 넘어도 5 까지는 원문자, 그 밖은 숫자). */
const STEP_MARK = ['①', '②', '③', '④', '⑤'];

/**
 * 2026-09-13 (요리 미니게임): `① 썰기 → ② 젓기` — 그 요리를 조리대에서 만들 때 하는 미니게임 순서 (`cookStepsOf`, `data/cook_steps.csv`).
 * 조리대 요리가 아니면 빈 문자열.
 */
export function cookStepsText(mealDefId: string | null | undefined): string {
  if (!mealDefId) return '';
  const steps = cookStepsOf(mealDefId);
  return steps.map((s, i) => `${STEP_MARK[i] ?? `${i + 1}.`} ${COOK_GAME_LABEL_KO[s.game] ?? s.game}`).join(' → ');
}

/** 2026-09-13: 요리 티어 이름 (`MEAL_TIER_LABEL_KO` — 채소 · 페이스트 · 고기 · 유제품 요리). 모르는 티어면 빈 문자열. */
export function mealTierLabel(meal: MealDef | null | undefined): string {
  return meal ? (MEAL_TIER_LABEL_KO[meal.tier] ?? '') : '';
}
