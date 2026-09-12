import type { MealBuff } from '@/shared';
import { MEAL_BUFF_LABEL_KO, MEAL_BUFF_UNIT } from '@/shared';

/**
 * 요리 버프를 사람이 읽는 한 조각으로 (A-3c, 2026-09-11). `hud/stratagemGlyphs` 와 같은 성격의 폴더 공용
 * 표현 헬퍼다 — 식사 배지(`hud/MealBadge`)와 아이템 툴팁(`hud/ItemTip`)이 같은 문장을 써야 해서 뽑았다
 * (CLAUDE.md 의 「같은 것을 두 곳이 쓰면 하나로 뽑는다」를 폴더 안에서 적용한 것). 2026-09-12 에 식사 배지는
 * 버프 썸네일 줄(`hud/BuffStrip`)로 대체되어 지금 소비자는 툴팁 하나지만, 요리 값 포맷의 원본은 계속 여기다.
 *
 * 단위를 정하는 표는 **`shared/labels` 의 `MEAL_BUFF_UNIT` 하나**다: `'%'` 인 줄만 `amount` 를 100 배하고
 * (배수 가산이라 0.15 = +15 %), `'kg'` · `'m'` 은 단위 그대로, `''` 는 숫자만 찍는다. 여기서 새 단위를
 * 판단하지 않는다 — 새 버프가 생기면 그 표에 줄이 생기고 이 파일은 한 줄도 안 바뀐다.
 *
 * `durabilityLossMul` 만 `amount` 가 **음수**다 (장비 손상이 줄어드는 것이 이득이다). 부호를 그대로 찍으면
 * 「장비 손상 −20 %」가 되어 이득으로 읽힌다 — 그래서 절댓값을 취하거나 부호를 뒤집지 않는다.
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
