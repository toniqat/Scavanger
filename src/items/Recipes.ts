import type { CraftIngredient, CraftRecipe } from '@/shared';
import { CRAFT_DEFAULT_TIME, csvRows } from '@/shared';

/**
 * **제작** 레시피 (`data/recipes.csv`). 분해는 여기 없다 — `Salvage.ts` 가 `data/salvage.csv` 와
 * 이 표의 **제작 재료**에서 만든다 (2026-09-10 제작 대개편).
 *
 * 흐름:
 *  1. **탄약 제작** — 화약 + 폐금속/합금 → 원하는 탄종 (분해로 얻은 화약이 재료다).
 *  2. **야전 병기 · 의약** — 연막 / 소이 수류탄, 붕대 · 약초 붕대 (`station: 'field'`).
 *  3. **정제 작업대** (`bench: 'refine'`, 2026-09-10) — 하위 재료 → **상위 재료** 7종.
 *     상위 재료는 여기서만 나오고, 등급 IV~V 장비는 전부 상위 재료를 요구한다.
 *  4. **총기 / 장비 / 가젯 / 의학 작업대** — 무기 25종 · 부착물 14종 · 방탄복 5벌 · 가방 8종 ·
 *     가젯 12종 · 실드 충전기 3종. `benchLevel` 이 등급 문턱이다 (Lv.1 하급 · Lv.2 중급 · Lv.3 상급).
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
  /* 2026-09-10: 'refine' (정제 작업대) 추가 — `WorkbenchKind` 는 이미 그 값을 받는다. */
  ...(r.has('bench') ? { bench: r.enum('bench', ['gun', 'gear', 'gadget', 'medical', 'refine'] as const) } : {}),
  ...(r.has('benchLevel') ? { benchLevel: r.int('benchLevel', { min: 1 }) } : {}),
  ...(r.has('extraOutputs') ? { extraOutputs: r.costList('extraOutputs') } : {}),
});

/** 제작 목록에 뜨는 레시피 전부 (`data/recipes.csv` 의 순서 그대로). */
export const CRAFT_RECIPES: readonly CraftRecipe[] = RECIPE_ROWS.map(recipeOf);

/**
 * **아이템 하나를 새로 만들 때 드는 재료.** 수리비 · 분해 산출이 전부 이 표에서 나오므로
 * (`Salvage.ts`), 한 아이템의 "값어치" 를 정하는 자리는 `data/recipes.csv` 한 곳뿐이다.
 *
 * `outputQty > 1` 인 레시피(탄약 · 배치 제작)는 **넣지 않는다** — 한 개를 만드는 데 드는 재료가
 * 정수로 떨어지지 않아 기준이 되지 못한다. 같은 아이템을 만드는 레시피가 여럿이면 **첫 줄**이 기준이다.
 */
export const CRAFT_COST_BY_OUTPUT: ReadonlyMap<string, readonly CraftIngredient[]> = (() => {
  const out = new Map<string, readonly CraftIngredient[]>();
  for (const r of CRAFT_RECIPES) {
    if (r.outputQty !== 1 || out.has(r.outputDefId)) continue;
    out.set(r.outputDefId, r.inputs);
  }
  return out;
})();

/** 이 아이템의 제작 재료 (없으면 빈 배열). 반환 배열은 공유되므로 고치지 않는다. */
export function craftCostOf(defId: string): readonly CraftIngredient[] {
  return CRAFT_COST_BY_OUTPUT.get(defId) ?? [];
}
