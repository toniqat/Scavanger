/**
 * src/world/surface.ts — **발밑 재질** (2026-09-11, C-22 `WorldRef.getSurfaceMaterial`).
 *
 * 발소리 하나를 고르는 질의라 **싸야 한다** — 발걸음마다 불린다. 해시 질의는 `WorldSystem.getStandingObstacle`
 * 한 번뿐이고, 여기 있는 것은 그 결과를 재질로 옮기는 표와 **지형 색 규칙의 근사**다(할당 없음).
 *
 * 지형은 `Terrain.computeColors` 가 칠하는 순서를 거꾸로 읽는다: 둥지 점액 → 크레이터 그을림 → 경계 절벽 →
 * 경사 암반 → 고지대 → 저지대 → 바닥 변주(`ground2`) → 바닥. 색 규칙의 경계는 `smoothstep` 의 한가운데(0.5)로
 * 자른다. 잡음 `n1` 은 색 패스와 같은 식(`noise.fbm(x·0.045+3, z·0.045−8, 2)`)이라 눈에 보이는 얼룩과 발소리가
 * 같은 자리에서 바뀐다. 바이옴마다 띠 → 재질 표는 `BAND_MATERIALS` 하나다.
 *
 * THREE 를 값으로 쓰지 않는다 (타입만).
 */
import type { Obstacle, SurfaceMaterial } from '@/shared';
import type { Biome } from './biomes';
import type { WorldLayout } from './layout';
import type { Noise } from './noise';
import type { OutpostSite } from './Outposts';
import type { Terrain } from './Terrain';

/** 바이옴의 지형 띠 → 재질. 목록에 없는 바이옴은 전부 `dirt` (옛 발소리). */
interface BandMaterials { low: SurfaceMaterial; ground: SurfaceMaterial; ground2: SurfaceMaterial; high: SurfaceMaterial }

const BAND_MATERIALS: Readonly<Record<string, BandMaterials>> = {
  // 호박빛 사막: 모래 평원 · 붉은 흙 얼룩 · 옅은 사구 꼭대기
  amber: { low: 'sand', ground: 'sand', ground2: 'dirt', high: 'sand' },
  // 동토 툰드라: 눈 · 드러난 흙 얼룩 · 얼어붙은 저지대
  tundra: { low: 'snow', ground: 'snow', ground2: 'dirt', high: 'snow' },
  // 이끼 습지: 이끼 바닥 · 진흙 얼룩 · 검은 늪 저지대
  mossy: { low: 'mud', ground: 'moss', ground2: 'mud', high: 'moss' },
  // 잿빛 화산지대: 전부 재
  ashen: { low: 'ash', ground: 'ash', ground2: 'ash', high: 'ash' },
  // 적색 외계 평원: 살덩이 같은 지면
  crimson: { low: 'organic', ground: 'organic', ground2: 'organic', high: 'organic' },
};

/**
 * 장애물 `kind`(`SpatialHash.ObstacleEntry.kind`) → 재질. 없는 kind 는 `dirt`.
 * 구조물 바닥 · 벽(`slab` · `building`)은 콘크리트지만 **불시착 함선**이면 금속이다 — 그 판정은 `obstacleMaterial`.
 */
const KIND_MATERIALS: Readonly<Record<string, SurfaceMaterial>> = {
  rock: 'rock', crystal: 'crystal', debris: 'metal', tree: 'organic', nest: 'organic', grove: 'organic',
  crate: 'metal', wall: 'concrete', pole: 'metal', slab: 'concrete', building: 'concrete', container: 'metal',
  glass: 'concrete', door: 'metal', console: 'metal', hatch: 'metal', rail: 'metal', pier: 'concrete',
  platform: 'metal', sign: 'metal', tram: 'metal', dynamic: 'metal', target: 'metal',
};

/** 둥지 점액이 발소리를 바꾸는 반경(m) — 색 패스의 점액 세기가 0.5 를 넘는 거리(`1 − smoothstep(6, 30, d)` ≈ 15 m). */
const NEST_GOO_M = 15;
/** 크레이터 그을림: 반경 × 이 비율 안 (색 패스의 그을림이 가장 짙은 안쪽). */
const CRATER_SCORCH_FRAC = 0.5;
/** 경사 암반: `1 − normal.y` 가 이보다 크면 (`smoothstep(0.18, 0.42)` 의 한가운데). */
const ROCK_SLOPE = 0.3;
/** 경계 절벽 (플레이 영역 밖): 체비셰프 거리 − HALF 가 이보다 크면. */
const CLIFF_EDGE_M = 18;

/** 장애물 하나의 재질. `wreckAt` 은 (x, z) 가 불시착 함선 안인지 답한다 — 구조물 바닥일 때만 묻는다. */
export function obstacleMaterial(o: Obstacle, x: number, z: number, wreckAt: (x: number, z: number) => boolean): SurfaceMaterial {
  const kind = (o as Obstacle & { kind?: string }).kind ?? '';
  if ((kind === 'slab' || kind === 'building') && wreckAt(x, z)) return 'metal';
  return KIND_MATERIALS[kind] ?? 'dirt';
}

/** (x, z) 가 폐허 전초의 콘크리트 바닥판 위인가 (콜라이더가 없는 판이라 지형 질의로는 모른다). */
export function onOutpostSlab(sites: readonly OutpostSite[], x: number, z: number): boolean {
  for (let i = 0; i < sites.length; i++) {
    const s = sites[i];
    const dx = x - s.position.x, dz = z - s.position.z;
    if (dx * dx + dz * dz > s.radius * s.radius) continue;
    const c = Math.cos(s.yaw), sn = Math.sin(s.yaw);
    if (Math.abs(dx * c + dz * sn) <= s.slabHalfX && Math.abs(-dx * sn + dz * c) <= s.slabHalfZ) return true;
  }
  return false;
}

/**
 * 지형 띠의 재질 — `Terrain.computeColors` 의 규칙을 뒤에서부터 읽는다 (나중에 칠한 것이 이긴다).
 * `half` = 플레이 영역 반변(`Terrain.HALF`).
 */
export function terrainMaterial(
  biome: Biome | null, terrain: Terrain, noise: Noise | null, layout: WorldLayout | null, half: number,
  x: number, z: number,
): SurfaceMaterial {
  if (!biome) return 'dirt';
  const bands = BAND_MATERIALS[biome.id];
  if (!bands) return 'dirt';

  if (layout) {
    const nests = layout.nests;
    for (let k = 0; k < nests.length; k++) {
      const dx = x - nests[k].x, dz = z - nests[k].z;
      if (dx * dx + dz * dz < NEST_GOO_M * NEST_GOO_M) return 'organic';
    }
    const craters = layout.craters;
    for (let k = 0; k < craters.length; k++) {
      const c = craters[k];
      const dx = x - c.x, dz = z - c.z, r = c.radius * CRATER_SCORCH_FRAC;
      if (dx * dx + dz * dz < r * r) return 'ash';
    }
  }
  if (Math.max(Math.abs(x), Math.abs(z)) - half > CLIFF_EDGE_M) return 'rock';
  const slope = terrain.getSlopeAt(x, z);
  if (slope > ROCK_SLOPE) return 'rock';

  const h = terrain.getHeightAt(x, z);
  const n1 = noise ? noise.fbm(x * 0.045 + 3, z * 0.045 - 8, 2) : 0;
  // highT = smoothstep(high − 4 + 3·n1, high + 3 + 3·n1, h) × (가파르면 0) — 한가운데는 high − 0.5 + 3·n1
  if (h > biome.highLevel - 0.5 + n1 * 3) return bands.high;
  // lowT = 1 − smoothstep(low − 1.5 + 1.5·n1, low + 2.5 + 1.5·n1, h) — 한가운데는 low + 0.5 + 1.5·n1
  if (h < biome.lowLevel + 0.5 + n1 * 1.5) return bands.low;
  // gv = smoothstep(−0.25, 0.35, n1) — 한가운데는 n1 = 0.05
  return n1 > 0.05 ? bands.ground2 : bands.ground;
}
