/**
 * src/shared/meals.ts — **요리 정의 표** (2026-09-16, 접시 모델 — 사용자 결정: 요리는 더 이상 인벤토리 아이템이 아니다).
 *
 * 조리대에서 만든 요리는 아이템이 되지 않고 **식탁 위의 접시**가 된다 (`ShipState.plate`, `shared/housing.ts` 의 접시 절).
 * 그래도 요리마다 이름 · 등급 · 아이콘 · 티어 · 능력치 줄은 필요하다 — 식탁 · 조리대 화면 · 버프 썸네일 · 호버 카드 · 진행(`derive.applyMealBuff`)이
 * 모두 읽는다. 그 표가 여기다 (`data/meals.csv`). 예전에는 items/ 가 이 표를 `ItemDef` 로 옮겨 `ITEM_DEFS` 에 넣었고 모두가
 * `ctx.loot.getItemDef(id).meal` 로 읽었다 — 이제 `getMealDef(id)` 로 읽는다 (`ctx.loot` 은 요리를 모른다).
 *
 * 모양을 `ItemDef` 로 둔 이유: 칩(`buildItemChip`) · 호버 카드 · 버프 썸네일이 이미 `ItemDef` 의 `name · icon · color · rarity ·
 * description · meal` 을 읽는다. 표시용 정의일 뿐이고 **어떤 격자에도 들어가지 않는다** (`width` · `height` · `stackMax` · `value` ·
 * `weight` 는 모양을 채우는 고정값이다 — 판매가 · 무게가 없다).
 *
 * 한 요리는 **버프 하나**를 올리고 그 버프에 **능력치가 여러 줄** 붙는다 — 티어 n 요리 = n 줄 (`MealDef.effects`, csv 의 `effects` 칸 =
 * `버프:수치` 를 `|` 로). `retired` 요리(옛 특선 4종)는 줄 수 검사에서 빠진다 — 옛 프로필의 대기 식사 id 가 풀리도록 표에는 남는다.
 */
import { csvRows } from './data/tables';
import { RARITY_COLORS, RARITY_ORDER } from './labels';
import type { ItemDef, MealBuff, MealDef, MealEffect } from './types';
import { MEAL_BUFFS } from './types';

/** 요리 정의 — `meal` 이 반드시 있는 `ItemDef` 모양 (표시용, 아이템이 아니다). */
export type MealItemDef = ItemDef & { meal: MealDef };

export const MEAL_DEFS: readonly MealItemDef[] = csvRows('meals.csv').map((r) => {
  const retired = r.has('retired') && r.bool('retired');
  const tier = r.int('tier', { min: 1, max: 4 }) as MealDef['tier'];
  const effects: MealEffect[] = [];
  /* `costList` 가 `버프:수치` 를 가른다 (수치는 음수 · `=식` 허용 — `durabilityLossMul` 은 −0.2 다). 버프 이름은 여기서 검사한다. */
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
  // 색은 등급색 그대로다 — 요리는 등급이 곧 티어라 칩의 색이 「몇 티어 요리인가」를 말한다 (옛 items/ 의 `def()` 기본값과 같다).
  const def: MealItemDef = {
    id: r.str('id'), name: r.str('name'), category: 'meal', rarity,
    width: 1, height: 1, stackMax: 1, value: 0, weight: 0,
    icon: r.str('icon'), description: r.str('description'), color: RARITY_COLORS[rarity], meal,
    ...(retired ? { retired: true } : {}),
  };
  return def;
});

export const MEAL_DEF_MAP: ReadonlyMap<string, MealItemDef> = new Map(MEAL_DEFS.map((d) => [d.id, d]));

/** 요리 id 의 정의, 요리가 아니면 undefined. */
export function getMealDef(id: string | null | undefined): MealItemDef | undefined {
  return typeof id === 'string' && id ? MEAL_DEF_MAP.get(id) : undefined;
}

/** 요리 id 인가 (은퇴한 요리 포함). */
export function isMealDefId(id: unknown): id is string {
  return typeof id === 'string' && MEAL_DEF_MAP.has(id);
}
