/**
 * src/world/BurrowGround.ts — **땅굴벌레가 파고 나올 수 있는 맨땅인가** (`WorldRef.burrowGroundOk`, 2026-09-15).
 *
 * 이 파일이 답하는 질문: *`(x, z)` 둘레 `radius` m 가 평평한 맨땅이라 땅굴벌레가 솟을 수 있는가.*
 * 호스트의 등장 자리 검사(`enemies/sandworm/Director.validSpot`)와 진동 장치 설치 미리보기(`gadgets/parts/Preview`)가
 * **같은 판정**을 써야 하므로 여기 한 곳에만 있다 (docs/DECISIONS.md 「2026-09-15 — 땅굴벌레」).
 *
 * ## 규칙 (전부 통과해야 true)
 * 1. 원 전체가 맵 안이다 (중심 + 두 고리의 표본).
 * 2. 지형: 중심 + 반지름 r · r/2 두 고리의 `BURROW_GROUND_RING_SAMPLES` 표본에서 높이 최고 − 최저 ≤ `BURROW_GROUND_MAX_RISE_M`,
 *    어느 표본의 경사도 ≤ `BURROW_GROUND_MAX_SLOPE` (`Terrain.getSlopeAt`).
 * 3. 회랑: 탈출 패드(`padClearance`) · 선로(`railClearance`) · 흙길 + 정류장(`roverClearance`) 이 원과 겹치지 않는다.
 * 4. 구조물: 어느 `StructureDef` 의 `radius` 원과도 겹치지 않는다.
 * 5. 공간 해시: 원과 겹치는 콜라이더가 하나도 없다 — 바위 · 나무 · 둥지 둔덕 · 버섯 줄기 · 전차 · 상자 · 착륙한 탈출 함선 외피 ·
 *    떨어뜨린 엄폐물까지 전부 (상자 · 사각 콜라이더는 외접원으로 본다 — 넉넉하게 거른다).
 * 6. 둥지 구멍에서 `BURROW_GROUND_NEST_CLEAR_M` 안이 아니다 (작은 둔덕은 구멍에서 멀리 선다).
 * 7. 채집 노드 · 상자와 겹치지 않는다 (상자는 해시에도 있다 — 둘 다 본다).
 * 8. 환경 재해: 독성 포자 군락(`HazardRef.getSources()` 의 자리, 군락 반경 `GROVE_RADIUS`)과 겹치지 않고, 중심 · 고리 표본 어느 것도
 *    지금 피해 구역 안(`HazardRef.isInside`)이 아니다.
 * 훈련장 · 튜토리얼은 부르지 않는다 (`WorldSystem` 이 행성 모드가 아니면 false 를 낸다).
 *
 * 할당 없음: 표본 좌표는 계산만 하고, 해시 질의는 재사용 배열에 받는다.
 */
import type * as THREE from 'three';
import {
  BURROW_GROUND_MAX_RISE_M, BURROW_GROUND_MAX_SLOPE, BURROW_GROUND_NEST_CLEAR_M, BURROW_GROUND_RING_SAMPLES,
  type CrateDef, type GatherNodeDef, type HazardRef, type StructureDef,
} from '@/shared';
import { padClearance, railClearance, roverClearance, type WorldLayout } from './layout';
import { GROVE_RADIUS } from './hazard/model';
import type { ObstacleEntry } from './SpatialHash';

/** `WorldSystem` 이 채워 주는 읽기 창 — 함수는 그 시스템의 질의를 그대로 감싼다. */
export interface BurrowGroundQuery {
  heightAt(x: number, z: number): number;
  slopeAt(x: number, z: number): number;
  insideBounds(x: number, z: number): boolean;
  hashQuery(x: number, z: number, radius: number, out: ObstacleEntry[]): ObstacleEntry[];
  readonly layout: WorldLayout;
  readonly structures: readonly StructureDef[];
  readonly nestHoles: readonly THREE.Vector3[];
  readonly gather: readonly GatherNodeDef[];
  readonly crates: readonly CrateDef[];
  readonly hazard: HazardRef | null;
}

const hashOut: ObstacleEntry[] = [];
const TWO_PI = Math.PI * 2;

/** 표본 하나의 지형 검사 — 맵 밖 · 재해 구역 · 경사 초과면 false. 높이는 `acc` 에 누적한다. */
function sampleOk(q: BurrowGroundQuery, x: number, z: number, acc: { min: number; max: number }): boolean {
  if (!q.insideBounds(x, z)) return false;
  if (q.hazard && q.hazard.active && q.hazard.isInside(x, z)) return false;
  if (q.slopeAt(x, z) > BURROW_GROUND_MAX_SLOPE) return false;
  const h = q.heightAt(x, z);
  if (h < acc.min) acc.min = h;
  if (h > acc.max) acc.max = h;
  return true;
}

const acc = { min: 0, max: 0 };

export function burrowGroundOk(q: BurrowGroundQuery, x: number, z: number, radius: number): boolean {
  const r = Math.max(0, radius);
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(r)) return false;

  // 1 · 2 · 8(구역): 지형 표본
  acc.min = Infinity; acc.max = -Infinity;
  if (!sampleOk(q, x, z, acc)) return false;
  const n = Math.max(3, Math.round(BURROW_GROUND_RING_SAMPLES));
  for (let ring = 0; ring < 2; ring++) {
    const rr = ring === 0 ? r : r * 0.5;
    if (rr <= 0) continue;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TWO_PI + ring * (Math.PI / n);
      if (!sampleOk(q, x + Math.cos(a) * rr, z + Math.sin(a) * rr, acc)) return false;
    }
  }
  if (acc.max - acc.min > BURROW_GROUND_MAX_RISE_M) return false;

  // 3: 회랑
  const layout = q.layout;
  if (padClearance(layout, x, z, r) < 0) return false;
  if (railClearance(layout, x, z) < r) return false;
  if (roverClearance(layout, x, z) < r) return false;

  // 4: 구조물 발자국
  const structures = q.structures;
  for (let i = 0; i < structures.length; i++) {
    const s = structures[i];
    const dx = s.position.x - x, dz = s.position.z - z;
    const reach = s.radius + r;
    if (dx * dx + dz * dz < reach * reach) return false;
  }

  // 5: 해시 콜라이더 (바위 · 나무 · 둔덕 · 줄기 · 전차 · 상자 · 함선 외피 · 엄폐물)
  hashOut.length = 0;
  const hits = q.hashQuery(x, z, r, hashOut);
  for (let i = 0; i < hits.length; i++) {
    const o = hits[i];
    const dx = o.position.x - x, dz = o.position.z - z;
    const reach = o.radius + r;
    if (dx * dx + dz * dz < reach * reach) { hashOut.length = 0; return false; }
  }
  hashOut.length = 0;

  // 6: 둥지 구멍
  const holes = q.nestHoles;
  const nestReach = BURROW_GROUND_NEST_CLEAR_M + r;
  for (let i = 0; i < holes.length; i++) {
    const dx = holes[i].x - x, dz = holes[i].z - z;
    if (dx * dx + dz * dz < nestReach * nestReach) return false;
  }

  // 7: 채집 노드 · 상자
  const gather = q.gather;
  for (let i = 0; i < gather.length; i++) {
    const dx = gather[i].position.x - x, dz = gather[i].position.z - z;
    const reach = r + 1;
    if (dx * dx + dz * dz < reach * reach) return false;
  }
  const crates = q.crates;
  for (let i = 0; i < crates.length; i++) {
    const dx = crates[i].position.x - x, dz = crates[i].position.z - z;
    const reach = r + 1;
    if (dx * dx + dz * dz < reach * reach) return false;
  }

  // 8: 독성 포자 군락 (거대 버섯 — 줄기는 해시에 있지만 군락 전체를 비운다)
  const hz = q.hazard;
  if (hz) {
    const sources = hz.getSources();
    const reach = GROVE_RADIUS + r;
    for (let i = 0; i < sources.length; i++) {
      const dx = sources[i].position.x - x, dz = sources[i].position.z - z;
      if (dx * dx + dz * dz < reach * reach) return false;
    }
  }
  return true;
}
