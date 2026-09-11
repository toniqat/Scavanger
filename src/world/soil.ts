/**
 * src/world/soil.ts — **행성별 토양** (온실 개편, 2026-09-11).
 *
 * 온실의 재배 스테이션은 흙을 먼저 붓고 그 위에 씨앗을 심는다 (`shared/housing` 의 `GrowSlot.soilDefId`).
 * 그 흙은 **오직 레이드의 채집**으로만 얻고, 어떤 속성이 나오는지는 행성마다 다르다 — 그래서 "부엽토가 필요하면
 * 베르단트 III 로 간다" 가 성립한다. 그 표가 `data/planets.csv` 의 두 열이다:
 *
 *  - `soils`     — `"토양아이템id:가중치"` 를 `|` 로 이어 쓴 목록 (`herbs` 와 **같은 형식**).
 *  - `soilNodes` — 미션당 토양 더미(`GatherNodeKind === 'soil'`) 개수. 0 이거나 `soils` 가 비면 그 행성엔 없다.
 *
 * ⚠ 이 두 열의 정식 주인은 `shared/planetDefs.ts` 의 `PlanetEcosystem` 이다. 그 배치가 `src/shared` 를
 * 건드리지 않기로 돼 있어서 world/ 가 직접 읽는다 — `structures/model.ts` 가 `RAIL_CLEARANCE_M` 을 읽는 것과
 * 같은 임시 조치이고, 나중에 `eco.soils` / `eco.soilNodes` 두 줄로 옮기면 이 파일은 그것을 읽기만 하면 된다.
 * (그때까지 `scripts/data-owners.mjs` 의 `DATA_OWNERS` 에 이 모듈을 넣어 두면 `data:check` 가 열 오타도 잡는다.)
 *
 * THREE 를 쓰지 않는다 — 수치를 타입으로 옮기기만 하는 자리다.
 */
import { csvRows } from '@/shared';

/** 한 행성이 주는 토양. */
export interface PlanetSoil {
  /** 토양 아이템 def id → 상대 가중치 (양수만). 비어 있으면 이 행성에는 토양 더미가 없다. */
  weights: Readonly<Record<string, number>>;
  /** 미션당 토양 더미 개수. */
  nodes: number;
}

const EMPTY: PlanetSoil = { weights: {}, nodes: 0 };

const BY_PLANET = new Map<string, PlanetSoil>();
for (const r of csvRows('planets.csv')) {
  const id = r.raw('id');
  if (!id) continue;
  const weights: Record<string, number> = {};
  for (const c of r.costList('soils')) {
    if (c.qty > 0) weights[c.defId] = (weights[c.defId] ?? 0) + c.qty;
  }
  const nodes = Math.max(0, Math.round(r.num('soilNodes', { min: 0, fallback: 0 })));
  BY_PLANET.set(id, Object.keys(weights).length > 0 && nodes > 0 ? { weights, nodes } : EMPTY);
}

/**
 * 이 행성이 주는 토양. 행성을 고르지 않았거나(훈련장 · 옛 피어) 모르는 id 면 null — **토양 더미를 놓지 않는다**
 * (약초처럼 "행성이 없으면 예전 배치" 로 되돌릴 옛 동작 자체가 없다).
 */
export function planetSoil(planetId: string | null | undefined): PlanetSoil | null {
  if (!planetId) return null;
  const hit = BY_PLANET.get(planetId);
  return hit && hit.nodes > 0 ? hit : null;
}
