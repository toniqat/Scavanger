/**
 * src/world/rails/model.ts — 선로 · 전차 파트가 공유하는 **어휘**. 상태는 없다.
 *
 * 선로의 진짜 상태는 **선로 위 진행거리 `s` 하나**다 (`TramDef.s`). 경로는 시드 결정적이라 어느
 * 클라이언트에서 계산해도 같은 점열이 나오고, 그래서 멀티에서 흐르는 것은 `s` · 방향 · 상태뿐이다.
 */
import * as THREE from 'three';

/**
 * 레일 상면이 지형 위로 뜨는 높이(m). 교각이 이 높이를 맞춘다.
 *
 * 2026-09-10: **1.7 → 0.75** (사용자 결정 — "선로가 땅보다 약간 위에 떠 있게"). 이 높이는
 * `PROP_STEP_UP_MAX`(0.9) 안이라 **땅에서 그냥 올라설 수 있다** — 그것이 "선로 위로 다닐 수 있도록" 의
 * 조건이다. 더 높이면(예전 1.7) 발판 콜라이더가 맵을 가로지르는 담이 된다: 올라설 수도 없고
 * (`getSurfaceY` 의 오르막 제한), 밑으로 지나갈 수도 없다 (`obb.BOX_HEADROOM` 2.1 보다 낮다).
 */
export const RAIL_DECK_Y = 0.75;
/** 침목 간격(m). 2026-09-10: 3.2 → 1.8 (침목 사이가 훤히 비어 "빠질 것 같다" 로 보였다). */
export const TIE_STEP = 1.8;
/** 교각 간격(m). 2026-09-10: 13 → 9 — 낮아진 선로에서도 기둥이 중간중간 보이도록. */
export const PIER_STEP = 9;
/** 두 레일 사이 간격의 절반(m). */
export const GAUGE_HALF = 0.9;
/**
 * 2026-09-10 — **걸어 다니는 선로 발판**의 콜라이더 치수. 예전에는 교각만 콜라이더라 선로가 그림일
 * 뿐이었고 침목 사이로 그대로 빠졌다. 침목보다 성긴 간격으로 얇은 상자를 이어 붙인다: 반지름 250 m
 * 곡선에서 5 m 현의 처짐이 1.3 cm 라 곡선을 충분히 따라가고, 해시 항목도 침목마다 거는 것의 1/3 이다.
 */
export const RAIL_DECK_STEP = 5;
/** 발판 상자의 두께(m). 윗면이 레일 상면과 같은 높이가 되게 밑으로 판다. */
export const RAIL_DECK_T = 0.3;
/** 발판 반폭(m) — 침목 폭과 같다. */
export const RAIL_DECK_HALF_W = GAUGE_HALF + 0.25;
/** 들어 올린 선로가 이웃 점과 벌어질 수 있는 최대 경사 (구간 길이 대비). */
export const RAIL_MAX_GRADE = 0.14;
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
