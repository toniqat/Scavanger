/**
 * src/world/rails/model.ts — 선로 · 전차 파트가 공유하는 **어휘**. 상태는 없다.
 *
 * 선로의 진짜 상태는 **선로 위 진행거리 `s` 하나**다 (`TramDef.s`). 경로는 시드 결정적이라 어느
 * 클라이언트에서 계산해도 같은 점열이 나오고, 그래서 멀티에서 흐르는 것은 `s` · 방향 · 상태뿐이다.
 */
import * as THREE from 'three';

/** 레일 상면이 지형 위로 뜨는 높이(m). 교각이 이 높이를 맞춘다. */
export const RAIL_DECK_Y = 1.7;
/** 침목 간격(m). 순환 선로 한 바퀴가 1 km 가까이 되므로 너무 촘촘하면 병합할 지오메트리가 수천 개가 된다. */
export const TIE_STEP = 3.2;
/** 교각 간격(m). */
export const PIER_STEP = 13;
/** 두 레일 사이 간격의 절반(m). */
export const GAUGE_HALF = 0.9;
/** 전차가 플랫폼에 "닿았다" 고 보는 거리(m, 선로 위 거리 기준). */
export const DOCK_WINDOW = 4;
/** 호스트가 전차 상태를 방송하는 주기(초). 경로가 결정적이라 이 정도로 충분하다. */
export const TRAM_NET_INTERVAL = 0.25;
/** 클라이언트가 받은 `s` 와 이만큼(m) 넘게 벌어지면 보간하지 않고 그냥 맞춘다. */
export const TRAM_SNAP_M = 8;
/**
 * 플랫폼 데크 중심이 선로 중심선에서 옆으로 물러나는 거리(m).
 * `data/structures.csv` 의 `rail_platform.halfD`(4.5) + `tram.halfW`(1.9) 에 **0.05 만** 더한 값이다 —
 * 데크 안쪽 모서리를 전차 옆구리에 거의 붙여야 정차했을 때 **틈 없이 걸어서 탄다**. 여기를 넓히면
 * 그 틈으로 떨어진다 (발판 질의는 점 하나만 본다).
 */
export const PLATFORM_OFFSET = 6.45;

/** 시드 결정적인 선로 중심선. `loop` 이면 마지막 → 첫 점이 이어지는 닫힌 고리다. */
export interface RailPath {
  pts: THREE.Vector3[];
  /** 구간 누적 길이 (`cum[0] = 0`, 길이 = 구간 수 + 1). */
  cum: number[];
  total: number;
  loop: boolean;
}

/** 점열에서 누적 길이를 만든다. */
export function makePath(pts: THREE.Vector3[], loop: boolean): RailPath {
  const segs = loop ? pts.length : pts.length - 1;
  const cum = [0];
  let total = 0;
  for (let i = 0; i < segs; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    total += Math.hypot(b.x - a.x, b.z - a.z);
    cum.push(total);
  }
  return { pts, cum, total, loop };
}

/** `s` 를 경로 범위로 접는다 (`loop` 은 감고, `line` 은 끝에서 멈춘다). */
export function wrapS(path: RailPath, s: number): number {
  if (!path.loop) return Math.max(0, Math.min(path.total, s));
  const t = s % path.total;
  return t < 0 ? t + path.total : t;
}

/** 진행거리 `s` 의 위치와 접선. `outTan` 은 정규화된 XZ 방향(수평)이다. */
export function sampleAt(path: RailPath, s: number, outPos: THREE.Vector3, outTan: THREE.Vector3): void {
  const q = wrapS(path, s);
  let lo = 0, hi = path.cum.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (path.cum[mid] <= q) lo = mid; else hi = mid;
  }
  const a = path.pts[lo], b = path.pts[(lo + 1) % path.pts.length];
  const segLen = Math.max(1e-4, path.cum[lo + 1] - path.cum[lo]);
  const t = Math.max(0, Math.min(1, (q - path.cum[lo]) / segLen));
  outPos.set(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
  const dx = b.x - a.x, dz = b.z - a.z;
  const l = Math.hypot(dx, dz) || 1;
  outTan.set(dx / l, 0, dz / l);
}

/** `(x, z)` 에 가장 가까운 경로 위 진행거리 (플랫폼을 선로에 붙일 때). */
export function nearestS(path: RailPath, x: number, z: number): number {
  const segs = path.loop ? path.pts.length : path.pts.length - 1;
  let bestS = 0, bestD = Infinity;
  for (let i = 0; i < segs; i++) {
    const a = path.pts[i], b = path.pts[(i + 1) % path.pts.length];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 1e-6 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len2)) : 0;
    const px = a.x + dx * t, pz = a.z + dz * t;
    const d = (px - x) * (px - x) + (pz - z) * (pz - z);
    if (d < bestD) { bestD = d; bestS = path.cum[i] + Math.sqrt(len2) * t; }
  }
  return bestS;
}

/** `loop` 은 감긴 최단 차이, `line` 은 그냥 차이. */
export function deltaS(path: RailPath, from: number, to: number): number {
  let d = to - from;
  if (!path.loop) return d;
  const h = path.total / 2;
  while (d > h) d -= path.total;
  while (d < -h) d += path.total;
  return d;
}
