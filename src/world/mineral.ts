/**
 * src/world/mineral.ts — **행성 광맥**의 수치 (2026-09-16 사용자 결정 「행성마다 광맥이 서고, 캐면 난이도별 미확인 광물이 나온다」).
 *
 * `world/soil.ts` · `flora.ts` · `specimen.ts` 와 같은 자리다: csv 한두 열을 타입으로 옮기기만 하고 THREE 를 쓰지 않는다.
 * 읽는 열은 둘이다.
 *
 *  - `data/planets.csv` 의 `mineralNodes` — 이 행성에 서는 광맥 수 (0 이면 없다).
 *  - `data/loot_tiers.csv` 의 `tier = 그 행성의 threat` 줄 — 광맥이 내놓는 미확인 광물의 **등급 가중치**.
 *
 * ⚠ 등급표를 `@/items` 의 `getTierTable(...).rarityWeights` 로 읽지 **않는다**. 그쪽은 `RARITY_ORDER_LOOT`
 * (일반 … 전설) 다섯 등급으로 잘라 두었고, 그 자름은 "상자 · 시체 굴림은 신화를 뽑지 않는다" 는 규칙 자체다.
 * 광맥은 신화를 뽑아도 되는 **유일한** 경로라(미확인 광물 VI = 유니크 무기의 출처) `mythic` 열을 여기서 직접 읽는다.
 * 그래서 새 표를 만들지 않고도 사용자 결정 「총기 드롭률과 같은 확률 테이블」이 그대로 성립한다 — 난이도 1 줄은
 * 서사 · 전설 · 신화 가중치가 0 이라 저절로 희귀에서 멈춘다 (코드에 난이도 예외가 한 줄도 없다).
 */
import { RARITY_ORDER, csvRows, type Rarity } from '@/shared';

/* ── data/planets.csv: mineralNodes ─────────────────────────────────────── */

const NODES_BY_PLANET = new Map<string, number>();
for (const r of csvRows('planets.csv')) {
  const id = r.raw('id');
  if (!id) continue;
  NODES_BY_PLANET.set(id, Math.max(0, Math.round(r.num('mineralNodes', { min: 0, fallback: 0 }))));
}

/**
 * 이 행성에 서는 광맥 수. 행성을 고르지 않았거나 모르는 id 면 0 — **광맥을 놓지 않는다**
 * (`planetSoil` · `planetSeeds` · `planetSamples` 와 같은 규약).
 */
export function planetMineralNodes(planetId: string | null | undefined): number {
  if (!planetId) return 0;
  return NODES_BY_PLANET.get(planetId) ?? 0;
}

/* ── data/loot_tiers.csv: 등급 가중치 (mythic 포함) ──────────────────────── */

/** `RARITY_ORDER` 와 같은 순서(일반 … 신화)의 가중치. 음수는 없고, 0 = 이 난이도에서 절대 안 나온다. */
export type RarityWeights = readonly number[];

const WEIGHTS_BY_TIER = new Map<number, RarityWeights>();
for (const r of csvRows('loot_tiers.csv')) {
  const tier = r.int('tier', { min: 1 });
  WEIGHTS_BY_TIER.set(tier, RARITY_ORDER.map((q) => Math.max(0, r.num(q, { min: 0, fallback: 0 }))));
}

/** 가중치가 전부 0 인 표를 만나도 굴림이 죽지 않게 두는 최후의 답 (일반 1). */
const FALLBACK: RarityWeights = RARITY_ORDER.map((_, i) => (i === 0 ? 1 : 0));

/**
 * 광맥 굴림이 쓰는 등급 가중치 — **`tier = 행성 threat` 줄**이다 (사용자 결정: 총기 드롭과 같은 표).
 * 모르는 난이도면 가장 낮은 줄로 떨어진다.
 */
export function mineralRarityWeights(threat: number): RarityWeights {
  const t = Math.max(1, Math.round(threat));
  return WEIGHTS_BY_TIER.get(t) ?? WEIGHTS_BY_TIER.get(1) ?? FALLBACK;
}

/**
 * 채광 숙련(`DerivedStats.miningRarityBonus`, 0 … 1)이 가중치를 어떻게 다시 그리는가 — **곱이다**.
 *
 * 그 난이도가 허용하는 **가장 낮은 등급**(가중치가 0 이 아닌 첫 등급)을 기준으로, 그보다 한 칸 위면 `1 + bonus`,
 * 두 칸 위면 `1 + 2·bonus` … 를 곱한다. 곱이라는 것이 계약(`shared/progression.ts`)의 "난이도가 막아 둔 상한은
 * 넘지 못한다" 를 **증명한다**: 가중치가 0 인 등급은 어떤 배수를 곱해도 0 이라, 채광이 아무리 높아도 뽑히는
 * 총합에 단 한 조각도 기여하지 못한다. 더하기(바닥값)로 만들면 그 보장이 깨지므로 절대 더하지 않는다.
 * 칸 수로 배수를 키우는 것은 "더 **높은** 등급이 더 많이 오른다" 는 숙련 설명 그대로다.
 */
function bonusMulAt(index: number, lowest: number, bonus: number): number {
  return 1 + bonus * Math.max(0, index - lowest);
}

/**
 * 한 번의 광맥 굴림. `roll` 은 [0, 1) 의 난수, `bonus` 는 `derived.miningRarityBonus`.
 * 할당이 없다 (두 번 훑는다) — 채집은 핫 패스가 아니지만 같은 규약을 지킨다.
 */
export function rollMineralRarity(weights: RarityWeights, bonus: number, roll: number): Rarity {
  let lowest = -1;
  for (let i = 0; i < weights.length; i++) if (weights[i] > 0) { lowest = i; break; }
  if (lowest < 0) return RARITY_ORDER[0];     // 이 난이도는 아무 등급도 허용하지 않는다 — 가장 낮은 등급으로
  const b = bonus > 0 ? bonus : 0;
  let total = 0;
  for (let i = lowest; i < weights.length; i++) total += weights[i] * bonusMulAt(i, lowest, b);
  if (!(total > 0)) return RARITY_ORDER[lowest];
  let r = (roll >= 0 && roll < 1 ? roll : 0) * total;
  for (let i = lowest; i < weights.length; i++) {
    const w = weights[i] * bonusMulAt(i, lowest, b);
    if (r < w) return RARITY_ORDER[i];
    r -= w;
  }
  return RARITY_ORDER[lowest];
}
