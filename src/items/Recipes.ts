import type { ArmorDef, CraftRecipe, WeaponDef } from '@/shared';
import { CRAFT_DEFAULT_TIME, csvRows, keyTable, numberMap } from '@/shared';

/* 레시피의 원본은 `data/recipes.csv` 다. 무기 · 방탄복 분해 레시피만 def 표에서 자동 생성하며,
 * 그 산출량 공식의 수치는 `data/tuning.csv` (WEAPON_SALVAGE_* · ARMOR_SALVAGE_*) 와
 * `data/tables.csv` 의 SALVAGE_CLASS_MUL 에 있다. */
const T = /* data/tuning.csv */ keyTable('tuning.csv');
/* appended (2026-09-08): 폐금속 공급 — 무기 / 방탄복 분해 레시피를 def 표에서 생성한다 */
import { ARMOR_DEFS } from './ArmorDefs';
import { WEAPON_DEFS, isUniqueWeapon, weaponClassOf } from './WeaponDefs';
import { itemIdForWeapon } from './ItemDefs';

/**
 * Crafting recipes (`ctx.loot.getAllRecipes()`); `inventory/` filters by station, bench and the
 * player's skill level. Chains:
 *
 *  1. **탄약 분해** — an ammo pack breaks down into 화약 (`mat_gunpowder`).
 *  1-b. **고물 분해** (2026-09-08) — 기계 부품 · 주워온 무기 · 방탄복이 폐금속으로 돌아온다 (`SALVAGE_RECIPES`).
 *  2. **탄약 제작** — 화약 + 폐금속/합금 makes the ammo pack you actually need.
 *  3. **야전 병기** — smoke / incendiary grenades.
 *  4. **의약** — 천조각 / 캔 / 주사기 + 혈근초 become 붕대 · 소독약 · 회복주사 · 회복 스프레이; the 의학 skill gates the good ones.
 *  5. **원예** — ship hydroponics.
 *  6. **작업실 (Phase 6)** — `station: 'ship'` + `bench` (`gun` / `gear` / `gadget` / `medical`) at `benchLevel`
 *     or higher (`ctx.housing.getBenchLevel`): bulk ammo, attachments, unique-weapon ammo, armor / bags,
 *     grenade batches, medicine.
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
  ...(r.has('bench') ? { bench: r.enum('bench', ['gun', 'gear', 'gadget', 'medical'] as const) } : {}),
  ...(r.has('benchLevel') ? { benchLevel: r.int('benchLevel', { min: 1 }) } : {}),
  ...(r.has('extraOutputs') ? { extraOutputs: r.costList('extraOutputs') } : {}),
});

/** 제작 목록에 뜨는 레시피 (`group` 이 `craft`). */
export const CRAFT_RECIPES: readonly CraftRecipe[] = RECIPE_ROWS.filter((r) => r.raw('group') !== 'salvage').map(recipeOf);

/** 손으로 적은 분해 레시피 (`group` 이 `salvage`) — 무기 · 방탄복 분해는 아래에서 생성된다. */
const HAND_SALVAGE_RECIPES: readonly CraftRecipe[] = RECIPE_ROWS.filter((r) => r.raw('group') === 'salvage').map(recipeOf);

/* ══ 7. 고물 분해 (2026-09-08) ═════════════════════════════════════════════
 * 폐금속은 상자의 `material` 롤에서만 나와서 화약보다 5배쯤 먼저 떨어졌다. 그 병목을 푸는 세 갈래 중 하나가
 * **분해**다: 로그가 떨구는 「기계 부품」과, 가방을 차지하기만 하는 주워온 무기 · 방탄복을 폐금속으로 되돌린다.
 * 전부 `station: 'field'` — 레이드 현장에서 쓸모없는 총을 그 자리에서 탄약 재료로 바꾸는 선택이 핵심이다.
 *
 * `break_*` id 규약을 지키므로 제작 목록에는 뜨지 않고 (`isDisassembleRecipe`) 아이템 우클릭 → `분해` 로만 열린다.
 * 유니크 무기와 전설 방탄복은 되돌릴 수 없는 유일품이라 **제외** — 실수로 갈아버릴 수 없다.
 */

/** 폐금속 배수: 덩치 큰 총일수록 더 나온다 (`weaponClassOf`) — `data/tables.csv`. */
const SALVAGE_CLASS_MUL: Readonly<Record<string, number>> = numberMap('tables.csv', 'SALVAGE_CLASS_MUL');

/** 무기 1정 → 폐금속: 등급 I 기준 2에 등급마다 +1, 총기 종류 배수. 권총 I 1 … 저격소총 V 8. */
function weaponScrapYield(def: WeaponDef): number {
  const mul = SALVAGE_CLASS_MUL[weaponClassOf(def)] ?? 1;
  return Math.max(1, Math.round((T.num('WEAPON_SALVAGE_BASE') + ((def.grade ?? 1) - 1) * T.num('WEAPON_SALVAGE_PER_GRADE')) * mul));
}

/** 방탄복 1벌 → 폐금속: 티어 1 에 3, 티어마다 +2 (I 3 … V 11). */
function armorScrapYield(def: ArmorDef): number {
  return T.num('ARMOR_SALVAGE_BASE') + Math.max(0, def.tier - 1) * T.num('ARMOR_SALVAGE_PER_TIER');
}

const WEAPON_SALVAGE_RECIPES: readonly CraftRecipe[] = WEAPON_DEFS
  .filter((w) => !isUniqueWeapon(w))
  .map((w) => {
    const itemId = itemIdForWeapon(w.id);
    const qty = weaponScrapYield(w);
    return {
      id: `break_${itemId}`, name: `${w.name} 분해`, station: 'field',
      inputs: [{ defId: itemId, qty: 1 }], outputDefId: 'mat_scrap', outputQty: qty,
      duration: T.num('WEAPON_SALVAGE_DURATION'), skill: 'crafting', skillRequired: 0,
      description: `${w.name} 1정을 뜯어 폐금속 ${qty}을 얻는다. 부착물은 먼저 가방으로 돌아온다.`,
    } satisfies CraftRecipe;
  });

const ARMOR_SALVAGE_RECIPES: readonly CraftRecipe[] = ARMOR_DEFS
  .filter((a) => a.tier > 0)
  .map((a) => {
    const qty = armorScrapYield(a);
    return {
      id: `break_${a.id}`, name: `${a.name} 분해`, station: 'field',
      inputs: [{ defId: a.id, qty: 1 }], outputDefId: 'mat_scrap', outputQty: qty,
      duration: T.num('ARMOR_SALVAGE_DURATION'), skill: 'crafting', skillRequired: 0,
      description: `${a.name} 1벌을 뜯어 폐금속 ${qty}을 얻는다.`,
    } satisfies CraftRecipe;
  });


/** 7절 전체 (`CRAFT_RECIPES` 뒤에 이어 붙는다). */
export const SALVAGE_RECIPES: readonly CraftRecipe[] = [
  ...HAND_SALVAGE_RECIPES, ...WEAPON_SALVAGE_RECIPES, ...ARMOR_SALVAGE_RECIPES,
];

/** 손으로 적은 레시피 + 생성된 분해 레시피. `ctx.loot.getAllRecipes()` 가 내주는 목록. */
export const ALL_CRAFT_RECIPES: readonly CraftRecipe[] = [...CRAFT_RECIPES, ...SALVAGE_RECIPES];

export const CRAFT_RECIPE_MAP: ReadonlyMap<string, CraftRecipe> = new Map(ALL_CRAFT_RECIPES.map((r) => [r.id, r]));

export function getRecipe(id: string): CraftRecipe | undefined {
  return CRAFT_RECIPE_MAP.get(id);
}
