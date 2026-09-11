/**
 * src/world/flora.ts — **행성별 야생 씨앗 군락** (연구실 배치 A-11, 2026-09-11).
 *
 * 온실에 심을 씨앗은 상점에서 파는 몇 가지 말고는 **레이드에서 주워 오는 것**이고, 어떤 품종이 자라는지는
 * 행성마다 다르다 — 그래서 "재를 먹는 곡물이 필요하면 피로스 VII 로 간다" 가 성립한다 (고급 품종은 여기 없고
 * 분석기 해석으로만 나온다). 그 표가 `data/planets.csv` 의 두 열이다:
 *
 *  - `seeds`     — `"씨앗아이템id:가중치"` 를 `|` 로 이어 쓴 목록 (`herbs` · `soils` 와 **같은 형식**).
 *  - `seedNodes` — 미션당 씨앗 군락(`GatherNodeKind === 'seed'`) 개수. 0 이거나 `seeds` 가 비면 그 행성엔 없다.
 *
 * ⚠ 이 두 열의 정식 주인은 `shared/planetDefs.ts` 의 `PlanetEcosystem` 이다 — `world/soil.ts` 가 `soils` /
 * `soilNodes` 를 직접 읽는 것과 **같은 임시 조치**다 (이 배치도 `src/shared` 를 건드리지 않기로 돼 있다).
 * 나중에 `eco.seeds` / `eco.seedNodes` 두 줄로 옮기면 이 파일은 그것을 읽기만 하면 된다.
 * 홀드 시간 · 반경은 계약(`shared/constants.ts`)에 있고 여기서 재수출만 한다 — 값의 주인은 `data/constants.csv` 다.
 *
 *
 * THREE 를 쓰지 않는다 — 수치를 타입으로 옮기기만 하는 자리다.
 */
import { csvRows } from '@/shared';
/* 홀드 시간 · 반경의 정식 자리는 계약(`shared/constants.ts`)이다 — 여기서는 이름만 다시 내보낸다. */
export { SEED_INTERACT_TIME, SEED_NODE_RADIUS } from '@/shared';

/** 한 행성이 주는 야생 씨앗. */
export interface PlanetSeeds {
  /** 씨앗 아이템 def id → 상대 가중치 (양수만). 비어 있으면 이 행성에는 씨앗 군락이 없다. */
  weights: Readonly<Record<string, number>>;
  /** 미션당 씨앗 군락 개수. */
  nodes: number;
}

const EMPTY: PlanetSeeds = { weights: {}, nodes: 0 };

const BY_PLANET = new Map<string, PlanetSeeds>();
for (const r of csvRows('planets.csv')) {
  const id = r.raw('id');
  if (!id) continue;
  const weights: Record<string, number> = {};
  for (const c of r.costList('seeds')) {
    if (c.qty > 0) weights[c.defId] = (weights[c.defId] ?? 0) + c.qty;
  }
  const nodes = Math.max(0, Math.round(r.num('seedNodes', { min: 0, fallback: 0 })));
  BY_PLANET.set(id, Object.keys(weights).length > 0 && nodes > 0 ? { weights, nodes } : EMPTY);
}

/**
 * 이 행성이 주는 야생 씨앗. 행성을 고르지 않았거나(훈련장 · 옛 피어) 모르는 id 면 null — **군락을 놓지 않는다**
 * (`planetSoil` 과 같은 규약: 행성이 없으면 되돌릴 "예전 배치" 자체가 없다).
 */
export function planetSeeds(planetId: string | null | undefined): PlanetSeeds | null {
  if (!planetId) return null;
  const hit = BY_PLANET.get(planetId);
  return hit && hit.nodes > 0 ? hit : null;
}
