/**
 * src/world/preview.ts — **레이아웃만** 계산하는 순수 경로 (정보상 지도 미리보기, 2026-09-14).
 *
 * 정보상 화면은 「살 지역」을 실제 레이아웃으로 흐릿하게 보여 준다 (사용자 결정). 그러려면 메시도 지형도 없이
 * `generateLayout` 만 돌려야 하는데, **그 앞단**(재해 종류 · 바이옴 · 탈출 패드 수)이 `WorldSystem.generate` 안에
 * 흩어져 있었다. 여기 `planLayoutFor` 하나로 모으고 `generate` 도 그것을 부른다 — 미리보기와 진짜 맵이
 * 두 벌의 코드로 갈라지면 화면이 조용히 거짓말을 한다 (CLAUDE.md 「열지 않고 미리 보는 것은 여는 것과 같은
 * 함수여야 한다」).
 *
 * ⚠ 스트림 규약: 루트 rng 는 이 단계에서 **한 칸도 전진하지 않는다** — 재해 종류는 `'hazard'` fork 의 첫 draw 이고
 * 레이아웃 · 패드 수도 각자 fork 다 (`Random.fork` 는 부모를 건드리지 않는다). 그래서 `generate` 는 자기 루트 rng 를
 * 그대로 들고 다음 단계(지형 · 소품)로 간다.
 *
 * THREE 를 쓰지 않는다.
 */
import { MAP_SIZE, Random, getPlanet, isPlanetId, planetThreat, type HazardKind, type IntelEffects, type MapPreviewLayout, type MapPreviewSpot, type PlanetId } from '@/shared';
import { type Biome, biomeById, pickBiome } from './biomes';
import { drawHazardKind } from './hazard/parts/Plan';
import { extractionPadCount, generateLayout, type Pad, type WorldLayout } from './layout';

/** `generate` 의 레이아웃 단계 결과 — 미리보기는 이것만 쓰고, 진짜 생성은 여기서 이어 간다. */
export interface LayoutPlan {
  seed: number;
  planet: PlanetId | null;
  biome: Biome;
  hazardKind: HazardKind | null;
  layout: WorldLayout;
}

/**
 * 이 시드 · 행성 · 산 정보로 매크로 레이아웃을 계획한다. **순수** — 씬도 지형도 만들지 않는다.
 * `root` 를 주면 그 rng 를 쓴다 (fork 만 하므로 전진하지 않는다); 없으면 시드로 새로 만든다.
 */
export function planLayoutFor(seed: number, planet: PlanetId | null, intel: IntelEffects | null = null, root?: Random): LayoutPlan {
  const s = seed >>> 0;
  const id = isPlanetId(planet) ? planet : null;
  const def = getPlanet(id);
  const rng = root ?? new Random(s);
  // 행성이 있으면 팔레트는 데이터로 정해진다; 없으면 시드 추첨 (core 의 하늘 추첨과 짝이 맞는 기존 동작)
  const biome = biomeById(def?.biome) ?? pickBiome(s);
  const hazardKind = drawHazardKind(rng, def?.hazards ?? [], biome.id);
  const sporeLayout = hazardKind === 'spores';
  const extractionCount = extractionPadCount(rng.fork('extractionPads'), planetThreat(id), sporeLayout)
    + Math.max(0, Math.round(intel?.extractionBonus ?? 0));   // 정보상 「탈출 지점」 — 굴림 결과에 더한다
  const layout = generateLayout(rng.fork('layout'), { extractionCount, sporeLayout, intel });
  return { seed: s, planet: id, biome, hazardKind, layout };
}

const spot = (p: { x: number; z: number; radius?: number }, r = 0): MapPreviewSpot => ({ x: p.x, z: p.z, r: p.radius ?? r });
const spots = (list: readonly Pad[]): MapPreviewSpot[] => list.map((p) => spot(p));

/** `WorldRef.previewLayout` 의 몸통 — 계획을 화면이 읽을 수 있는 평면 데이터로 옮긴다 (`world/` 타입은 새지 않는다). */
export function previewLayoutFor(seed: number, planet: PlanetId | null, intel: IntelEffects | null = null): MapPreviewLayout {
  const plan = planLayoutFor(seed, planet, intel);
  const l = plan.layout;
  return {
    seed: plan.seed,
    planet: plan.planet,
    mapSize: MAP_SIZE,
    spawn: spot(l.spawn),
    extraction: spots(l.extraction),
    nests: spots(l.nests),
    pois: spots(l.pois),
    craters: l.craters.map((c) => ({ x: c.x, z: c.z, r: c.radius })),
    structures: l.structures.map((st) => ({
      x: st.pad.x, z: st.pad.z, r: st.pad.radius,
      kind: st.kind, basement: st.pit !== null, floors: st.floors,
    })),
    rail: l.rail ? { kind: l.rail.kind, extent: l.rail.extent, angle: l.rail.angle, platforms: spots(l.rail.platforms) } : null,
    rover: l.rover
      ? {
        stations: l.rover.stations.map((st) => ({ x: st.x, z: st.z, r: l.rover!.padRadius })),
        route: l.rover.points.map((p) => ({ x: p.x, z: p.z })),
      }
      : null,
    hazard: plan.hazardKind,
  };
}
