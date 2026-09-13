/**
 * src/inventory/parts/MealQuality.ts — **요리 품질이 붙은 스택** (2026-09-13, 요리 미니게임 · 사용자 결정).
 *
 * 규칙(단계 · 별 · 보너스)은 `shared/cooking.ts` 에 있고, 이 파일은 인벤토리가 품질을 **어떻게 들고 다니는지**만 갖는다:
 *  - 스택 열쇠에 품질이 들어간다 — 그 한 줄은 `Grid.stackKeyOf` 에 있다 (모든 합치기 경로가 거기를 본다).
 *  - 나누기 · 복사는 `copyMealQuality` 로 품질을 옮긴다 (`copyRaidFoundMark` 옆에서 부른다). 회수 계약 표식과 달리
 *    **레이드가 끝나도 지우지 않는다** — 품질은 요리의 일부다.
 *  - 식탁 · 조리대가 쓰는 질의 3종: `countDefQualityAll` · `consumeDefQualityAll` · `getMealStacks` (가방 + 창고).
 * 조리 1회의 게이트 · 소모 · 산출(`cookBlock` · `completeCook`)은 함선 작업대 제작과 한 몸이라 `parts/Crafting.ts` 에 있다.
 */
import type { ItemDef, ItemInstance } from '@/shared';
import { normalizeMealQuality } from '@/shared';
import { ITEM_DEF_MAP } from '@/items';
import type { InventorySystem } from '../InventorySystem';

/** 인스턴스의 품질 (0 … `MEAL_QUALITY_MAX`, 필드 없음 = 0). */
export function mealQualityOf(item: Pick<ItemInstance, 'quality'> | null | undefined): number {
  return item ? normalizeMealQuality(item.quality) : 0;
}

/** 나눈 · 복사한 스택(`created`)이 원래 스택(`from`)의 품질을 물려받는다 (0 이면 필드를 지운다). */
export function copyMealQuality(created: ItemInstance, from: Pick<ItemInstance, 'quality'>): void {
  const q = mealQualityOf(from);
  if (q > 0) created.quality = q;
  else delete created.quality;
}

/** `defId` 이면서 품질이 정확히 `quality` 인가 (`quality` 0 = 필드 없음 포함). */
function matches(item: ItemInstance, defId: string, quality: number): boolean {
  return item.defId === defId && mealQualityOf(item) === quality;
}

/** 가방(+ 주머니 · 휠) + 창고의 `defId` 중 품질이 정확히 `quality` 인 수량. */
export function countDefQualityAll(sys: InventorySystem, defId: string, quality: number): number {
  const q = normalizeMealQuality(quality);
  let n = sys.countWhere((d, inst) => d.id === defId && mealQualityOf(inst) === q);
  for (const p of sys.stash.grid.items()) if (matches(p.item, defId, q)) n += p.item.qty;
  return n;
}

/**
 * 품질이 정확히 `quality` 인 `defId` 를 가방 먼저(작은 스택부터 · 주머니 · 휠은 `consumeWhere` 순서) → 창고에서 `qty` 개 뺀다.
 * 전부 또는 전무 — 모자라면 아무것도 빼지 않고 false (`consumeDefAll` 과 같은 모양).
 */
export function consumeDefQualityAll(sys: InventorySystem, defId: string, quality: number, qty: number): boolean {
  const want = Math.max(0, Math.floor(qty));
  if (want === 0) return true;
  const q = normalizeMealQuality(quality);
  if (countDefQualityAll(sys, defId, q) < want) return false;
  let left = want;
  const pred = (d: ItemDef, inst: ItemInstance): boolean => d.id === defId && mealQualityOf(inst) === q;
  const carried = sys.countWhere(pred);
  if (carried > 0) left -= sys.consumeWhere(pred, Math.min(left, carried));
  if (left > 0) {
    const stash = sys.stash.grid;
    const stacks = stash.items().filter((p) => matches(p.item, defId, q)).sort((a, b) => a.item.qty - b.item.qty);
    for (const p of stacks) {
      if (left <= 0) break;
      const take = Math.min(left, p.item.qty);
      p.item.qty -= take; left -= take;
      if (p.item.qty <= 0) stash.remove(p.item.uid);
      else stash.version++;
    }
    sys.afterChange();
  }
  return left === 0;
}

/** 가진 요리(`ItemDef.meal`)를 (def, 품질)별로 합친 목록 — 가방(+ 주머니 · 휠) + 창고. 티어 → 이름 → 품질 높은 순. */
export function getMealStacks(sys: InventorySystem): { defId: string; quality: number; qty: number }[] {
  const acc = new Map<string, { defId: string; quality: number; qty: number }>();
  const add = (item: ItemInstance | null | undefined): void => {
    if (!item || item.qty <= 0 || !ITEM_DEF_MAP.get(item.defId)?.meal) return;
    const quality = mealQualityOf(item);
    const key = `${item.defId}|${quality}`;
    const cur = acc.get(key);
    if (cur) cur.qty += item.qty; else acc.set(key, { defId: item.defId, quality, qty: item.qty });
  };
  for (const p of sys.bag.items()) add(p.item);
  for (const p of sys.pouch.items()) add(p.item);
  for (const it of sys.quickSlots) add(it);
  for (const p of sys.stash.grid.items()) add(p.item);
  const tierOf = (id: string): number => ITEM_DEF_MAP.get(id)?.meal?.tier ?? 0;
  const nameOf = (id: string): string => ITEM_DEF_MAP.get(id)?.name ?? id;
  return [...acc.values()].sort((a, b) =>
    (tierOf(a.defId) - tierOf(b.defId))
    || nameOf(a.defId).localeCompare(nameOf(b.defId), 'ko')
    || a.defId.localeCompare(b.defId)
    || (b.quality - a.quality));
}
