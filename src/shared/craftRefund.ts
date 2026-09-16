/**
 * src/shared/craftRefund.ts — **제작 재료 환급** (2026-09-16, 사용자 결정).
 *
 * > 「아이템 제작에 관련 숙련도는 전혀 관여하지 않도록 변경 (요리, 연구 등 모든 제작관련).
 * >  숙련도가 관여하는 것은 제작 시 재료 아이템을 일부 돌려받을 확률, 돌려받는 양 등에만 관여.」
 *
 * 그래서 숙련은 이제 **무엇을 만들 수 있는가**(옛 `skillRequired` 게이트)도, **얼마나 빨리 만드는가**(옛
 * `craftSpeedMul`)도 정하지 않는다. 남은 역할은 이 파일 하나다 — 소모한 재료가 얼마나 돌아오는가.
 *
 * **굴림 단위 = 재료 한 개** (사용자 결정). 확률은 숙련 0 에서 0, `SKILL_LEVEL_MAX` 에서
 * `CRAFT_REFUND_CHANCE_AT_MAX`(`data/tuning.csv`)까지 **선형**이고, 개당 따로 굴리므로 큰 레시피일수록 체감이
 * 크고 결과가 자연스럽게 퍼진다 (레시피 단위로 한 번 굴리면 「돌아왔다 / 아니다」의 두 갈래뿐이라, 폐금속 35 개짜리
 * 저격소총과 화약 1 개짜리 탄약이 같은 느낌이 된다).
 *
 * ⚠ **내구도 장비(무기 · 방탄복 · 가방 · 내구 가젯)는 환급 대상이 아니다** — 판정은 `items/Salvage.isCraftRefundable`.
 * 그 아이템들의 수리비 · 분해 산출이 바로 이 「제작 재료」에서 나오므로(`data/README.md` 「Gear value lives in
 * recipes.csv」), 제작만 싸지면 「제작 → 분해」 가 이득이 될 수 있다. 검산은 `items/Salvage.checkSalvageEconomy()`
 * 가 **최대 숙련 기준**으로 돌린다 (`npm run data:check`).
 *
 * 여기는 순수 계산만 한다 — 지급(가방 → 창고 → 바닥)과 토스트는 부른 쪽(`inventory/parts/Crafting`)의 몫이다.
 */
import { SKILL_LEVEL_MAX } from './constants';
import { keyTable } from './data/tables';
import type { CraftIngredient } from './gear';

const T = /* data/tuning.csv */ keyTable('tuning.csv');

/** 숙련 `SKILL_LEVEL_MAX` 에서 **재료 한 개**가 돌아올 확률. 숙련 0 에서 이 값까지 선형이다. */
export const CRAFT_REFUND_CHANCE_AT_MAX = T.num('CRAFT_REFUND_CHANCE_AT_MAX');

/** 이 숙련 수준에서 재료 한 개가 돌아올 확률 (0 … `CRAFT_REFUND_CHANCE_AT_MAX`). */
export function craftRefundChance(skillLevel: number): number {
  const lv = Number.isFinite(skillLevel) ? Math.max(0, Math.min(SKILL_LEVEL_MAX, skillLevel)) : 0;
  return CRAFT_REFUND_CHANCE_AT_MAX * (lv / Math.max(1, SKILL_LEVEL_MAX));
}

/**
 * 「제작 한 번에 재료가 이만큼 덜 든다」의 **기댓값 배수** (0 … 1). 경제 검산(`checkSalvageEconomy`)이 최대 숙련
 * 기준으로 쓰는 값이다 — 무한 이득은 한 번의 운이 아니라 **반복했을 때의 기댓값**으로 판정해야 한다.
 */
export function craftCostFactor(skillLevel: number): number {
  return Math.max(0, 1 - craftRefundChance(skillLevel));
}

/**
 * 소모한 재료를 **개당** 굴려 돌려줄 목록. `costs` 는 1회분 실제 소비량(작업실 할인이 걸린 뒤), `runs` 는 제작 횟수다.
 * 돌아온 것이 없으면 빈 배열. `rng` 는 스모크 · 테스트용 (생략 = `Math.random`).
 */
export function rollCraftRefund(
  costs: readonly CraftIngredient[], runs: number, skillLevel: number, rng: () => number = Math.random,
): CraftIngredient[] {
  const chance = craftRefundChance(skillLevel);
  const n = Number.isFinite(runs) ? Math.max(1, Math.floor(runs)) : 1;
  if (!(chance > 0)) return [];
  const back = new Map<string, number>();
  for (const c of costs) {
    const units = Math.max(0, Math.floor(c.qty)) * n;
    let hit = 0;
    for (let i = 0; i < units; i++) if (rng() < chance) hit++;
    if (hit > 0) back.set(c.defId, (back.get(c.defId) ?? 0) + hit);
  }
  return [...back].map(([defId, qty]) => ({ defId, qty }));
}
