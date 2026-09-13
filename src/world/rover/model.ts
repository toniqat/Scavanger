/**
 * src/world/rover/model.ts — 탐사 차량(rover) 파트가 공유하는 **어휘**. 상태는 없다 (2026-09-13).
 *
 * 규칙의 원본은 `shared/types.ts` 의 탐사 차량 절이다. 차량의 진짜 상태는 **고리 경로 위 진행거리 `s` 하나**이고
 * (`RoverVehicleDef.s`), 경로는 시드 결정적이라 멀티에서 흐르는 것은 `s` · 방향 · 상태 · 체력 · 탑승자뿐이다 — 전차와 같은 철학.
 * 경로 수학은 선로의 것(`rails/model`)을 **닫힌 고리**로만 쓴다.
 *
 * 파일 소유: `RoverPlan` · `RoverRoad.ts` = 경로 계획 · 흙길 · 정류장 (R1), `Rover.ts` = 차량 · 포탑 · 동기화 (R2).
 * 이 파일의 함수 서명은 두 쪽이 같이 쓰므로 바꾸지 않는다 (추가는 괜찮다).
 */
import type * as THREE from 'three';
import { ROVER_FARE_MAX, ROVER_FARE_MIN, ROVER_FARE_PER_M } from '@/shared';
import { deltaS, makePath, nearestS, sampleAt, wrapS, type RailPath } from '../rails/model';

/** 고리 경로 (`RailPath` 의 `loop: true` 판). */
export type RoverPath = RailPath;

/**
 * 레이아웃 단계(`generateLayout`)가 정하는 2D 계획 — 지형 높이는 아직 없다. R1 이 채우고 `RoverRoad` 가 3D 경로로 세운다.
 * R1 은 필드를 **추가**해도 된다.
 */
export interface RoverPlan {
  /** 흙길 중심선의 XZ 점열 (닫힌 고리, 경로 순서). */
  points: { x: number; z: number }[];
  /** 정류장 (경로 순서). `x`/`z` = 차량이 서는 중심선 위 점, `poleX`/`poleZ` = 표지 기둥. */
  stations: { x: number; z: number; poleX: number; poleZ: number }[];
  /* ── R1 추가 (2026-09-13) ── */
  /** 정류장 부지(평탄화 패드) 반지름(m) — `layout.pads` 의 `station` 패드와 같다. */
  padRadius: number;
  /** 회랑 거리 질의(`RoadPlan.roverRouteDistance`)용 버킷 격자. */
  index: RoverRoadIndex;
}

/**
 * 흙길 구간을 맵 격자 칸에 나눠 담은 것 (R1). 칸마다 **그 칸에서 `reach` 안에 들 수 있는** 구간 번호만 있어,
 * `isSpotFree` 가 수만 번 물어도 구간 백여 개를 다 훑지 않는다. 거리가 `reach` 이상이면 질의는 `reach` 를 돌려준다.
 */
export interface RoverRoadIndex {
  cell: number;
  cols: number;
  /** 격자 원점 = `-half` (맵 반변). */
  half: number;
  reach: number;
  /** `cz * cols + cx` → 구간 시작점 번호 목록 (구간 i = points[i] → points[(i+1) % n]). */
  cells: number[][];
}

/** 점열로 고리 경로를 만든다 (y = 노면 높이). */
export function makeRoverPath(pts: THREE.Vector3[]): RoverPath {
  return makePath(pts, true);
}

/** `s` 를 [0, total) 로 감는다. */
export function wrapRouteS(path: RoverPath, s: number): number {
  return wrapS(path, s);
}

/** 진행거리 `s` 의 위치(y = 노면)와 수평 단위 접선 (+s 방향). */
export function sampleRoute(path: RoverPath, s: number, outPos: THREE.Vector3, outTan: THREE.Vector3): void {
  sampleAt(path, s, outPos, outTan);
}

/** `(x, z)` 에 가장 가까운 경로 위 진행거리. */
export function nearestRouteS(path: RoverPath, x: number, z: number): number {
  return nearestS(path, x, z);
}

/** `from` → `to` 를 **+s 방향으로만** 갈 때의 거리 [0, total). 빈 차 순환이 쓴다. */
export function forwardDistance(path: RoverPath, from: number, to: number): number {
  const d = (to - from) % path.total;
  return d < 0 ? d + path.total : d;
}

/** 결제 이동: 고리의 짧은 쪽 방향과 거리. 같으면 +1. */
export function shortestTrip(path: RoverPath, from: number, to: number): { dir: 1 | -1; distance: number } {
  const f = forwardDistance(path, from, to);
  const b = path.total - f;
  return f <= b ? { dir: 1, distance: f } : { dir: -1, distance: b };
}

/* ── R2 추가 (2026-09-13) ── */

/** 고리 위 `from` → `to` 의 감긴 최단 차이 (부호 = 방향). 클라이언트 보정이 쓴다. */
export function routeDelta(path: RoverPath, from: number, to: number): number {
  return deltaS(path, from, to);
}

/** `a` 에서 `b` 로 도는 최단 각 (−π … π]. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

/** 각을 (−π … π] 로 접는다. */
export function wrapAngle(a: number): number {
  return angleDelta(0, a);
}

/**
 * 요금(크레딧, 전원분) — **식의 유일한 원본** (`RoverRef.fareTo` 가 이것을 부른다). 10 단위로 반올림한
 * `ROVER_FARE_MIN + 거리 × ROVER_FARE_PER_M` 을 [MIN, MAX] 로 자른다. 서버는 범위만 본다 (`shared/credits` 의 `rover:`).
 */
export function roverFareFor(distance: number): number {
  const raw = ROVER_FARE_MIN + Math.max(0, distance) * ROVER_FARE_PER_M;
  return Math.max(ROVER_FARE_MIN, Math.min(ROVER_FARE_MAX, Math.round(raw / 10) * 10));
}
