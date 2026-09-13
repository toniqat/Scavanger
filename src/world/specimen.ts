/**
 * src/world/specimen.ts — **행성별 미확인 표본 채집지** (연구실 배치 A-12, 2026-09-11).
 *
 * 분석기가 해석할 표본은 세 군데서 나온다 — 벌레 시체(`data/loot_corpses.csv`) · 구조물 · 지하실 컨테이너
 * (`data/loot_category_weights.csv`), 그리고 **이 파일이 놓는 채집지**다. 어떤 표본이 나오는지는 행성마다
 * 다르다 (게놈 · 결정은 위험한 행성에만). 그 표가 `data/planets.csv` 의 두 열이다:
 *
 *  - `samples`     — `"표본아이템id:가중치"` 를 `|` 로 이어 쓴 목록 (`herbs` · `soils` · `seeds` 와 같은 형식).
 *  - `sampleNodes` — 미션당 표본 채집지(`GatherNodeKind === 'sample'`) 개수. 0 이거나 비면 그 행성엔 없다.
 *
 * ⚠ 두 열의 정식 주인은 `shared/planetDefs.ts` 의 `PlanetEcosystem` 이다 — `world/soil.ts` 가 `soils` /
 * `soilNodes` 를 직접 읽는 것과 **같은 임시 조치**이고, `eco.samples` / `eco.sampleNodes` 두 줄로 옮기면
 * 이 파일은 그것을 읽기만 하면 된다. 홀드 시간 · 반경은 계약(`shared/constants.ts`)에 있고 여기서 재수출만 한다.
 *
 * THREE 를 쓰지 않는다 — 수치를 타입으로 옮기기만 하는 자리다.
 *
 * 2026-09-13 (요리 재료 티어 — 표본 3종 통합): 새 표 값은 `spec_cell` · `spec_mineral` 위주다. 이 파일은 csv 를 **그대로** 옮기고
 * (아이템 def 를 모르는 자리다), 은퇴한 옛 표본(`ItemDef.retired`)을 거르는 안전핀은 def 를 아는 `Gather.resolveNodeWeights` 가
 * 건다 — 표에 옛 id 가 남아 있어도 채집지가 서지 않는다. 미확인 광물은 여기 말고 고철 더미 부가 결과(`gather_mineral`)로도 나온다.
 */
import { csvRows } from '@/shared';
/* 홀드 시간 · 반경의 정식 자리는 계약(`shared/constants.ts`)이다 — 여기서는 이름만 다시 내보낸다. */
export { SAMPLE_INTERACT_TIME, SAMPLE_NODE_RADIUS } from '@/shared';

/** 한 행성이 주는 미확인 표본. */
export interface PlanetSamples {
  /** 표본 아이템 def id → 상대 가중치 (양수만). 비어 있으면 이 행성에는 표본 채집지가 없다. */
  weights: Readonly<Record<string, number>>;
  /** 미션당 표본 채집지 개수. */
  nodes: number;
}

const EMPTY: PlanetSamples = { weights: {}, nodes: 0 };

const BY_PLANET = new Map<string, PlanetSamples>();
for (const r of csvRows('planets.csv')) {
  const id = r.raw('id');
  if (!id) continue;
  const weights: Record<string, number> = {};
  for (const c of r.costList('samples')) {
    if (c.qty > 0) weights[c.defId] = (weights[c.defId] ?? 0) + c.qty;
  }
  const nodes = Math.max(0, Math.round(r.num('sampleNodes', { min: 0, fallback: 0 })));
  BY_PLANET.set(id, Object.keys(weights).length > 0 && nodes > 0 ? { weights, nodes } : EMPTY);
}

/**
 * 이 행성이 주는 미확인 표본. 행성을 고르지 않았거나 모르는 id 면 null — **채집지를 놓지 않는다**
 * (`planetSoil` · `planetSeeds` 와 같은 규약).
 */
export function planetSamples(planetId: string | null | undefined): PlanetSamples | null {
  if (!planetId) return null;
  const hit = BY_PLANET.get(planetId);
  return hit && hit.nodes > 0 ? hit : null;
}
