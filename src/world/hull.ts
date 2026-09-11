/**
 * src/world/hull.ts — **볼록 다각형 기둥** 콜라이더 수학 (2026-09-11, `Obstacle.hull`).
 *
 * 왜 있나: 2026-09-10 까지 바위 · 첨탑 · 크리스탈은 원 하나였다 (`Props.footprintOf` — 방위별 거리의 **평균**
 * 반지름). 길쭉한 바위를 원 하나로 덮으면 긴 쪽으로는 몸이 메시에 파고들고 짧은 쪽으로는 보이는 바위보다 앞에서
 * 막힌다. 그래서 **땅 위로 보이는 메시의 볼록 윤곽**을 그대로 콜라이더로 쓴다. 이동 · 발판은 한 장의 윤곽
 * (`hull.points`)을, 총알 · 시야는 높이별 층(`hull.bands`)을 본다 — 위로 좁아지는 첨탑 옆 허공에서 총알이 멈추지 않게.
 *
 * 규약:
 *  - 꼭짓점은 `[x0, z0, x1, z1, …]` 월드 좌표이고 **반시계**다 (위에서 내려다본 +X → +Z 회전, 부호 있는 넓이 > 0).
 *    그러면 변 a→b 의 바깥 법선은 `(dz, -dx)` 다.
 *  - **`o.hull` 이 있을 때만** 불린다. 원기둥 · 상자의 경로는 `WorldSystem` 안에 그대로 남아 있다.
 *  - 프레임당 할당이 없다 — 법선은 그 자리에서 푼다 (꼭짓점이 `HULL_MAX_VERTS` 이하라 싸다).
 */
import type * as THREE from 'three';
import type { ObstacleHull } from '@/shared';

/** 윤곽 하나가 가질 수 있는 최대 꼭짓점 수. 넘으면 넓이를 가장 적게 잃는 꼭짓점부터 뺀다. */
export const HULL_MAX_VERTS = 14;

/* ── 만들기 ─────────────────────────────────────────────────────────────────────────────────────────── */

let _idx = new Int32Array(256);
const _stack: number[] = [];

/**
 * 2026-09-11 (C-40): 인덱스를 (x, z) 사전순으로 정렬한다 — 예전의 `Array.prototype.sort(비교 함수)` 가 월드 생성의
 * 한 덩어리였다(소품마다 윤곽 최대 5번). 결과가 같은 이유: monotone chain 의 출력은 **좌표**만 쓰고, 좌표가 같은
 * 점끼리의 순서는 외적 0 으로 곧바로 빠지므로 어느 정렬이든 (x, z) 순서만 맞으면 껍질이 한 비트도 다르지 않다.
 * 작은 구간은 삽입 정렬, 큰 구간은 가운데 값 기준 퀵정렬 (재귀 대신 명시적 스택).
 */
const _qs = new Int32Array(128);
function sortIdx(pts: Float32Array, idx: Int32Array, n: number): void {
  const less = (a: number, b: number): boolean => {
    const ax = pts[a * 2], bx = pts[b * 2];
    return ax < bx || (ax === bx && pts[a * 2 + 1] < pts[b * 2 + 1]);
  };
  let sp = 0;
  _qs[sp++] = 0; _qs[sp++] = n - 1;
  while (sp > 0) {
    const hi = _qs[--sp], lo = _qs[--sp];
    if (hi - lo < 16) {
      for (let i = lo + 1; i <= hi; i++) {
        const v = idx[i];
        let j = i - 1;
        while (j >= lo && less(v, idx[j])) { idx[j + 1] = idx[j]; j--; }
        idx[j + 1] = v;
      }
      continue;
    }
    const pivot = idx[(lo + hi) >> 1];
    let i = lo, j = hi;
    while (i <= j) {
      while (less(idx[i], pivot)) i++;
      while (less(pivot, idx[j])) j--;
      if (i <= j) { const t = idx[i]; idx[i] = idx[j]; idx[j] = t; i++; j--; }
    }
    // 큰 쪽을 먼저 쌓아 스택 깊이를 log n 으로 묶는다
    if (j - lo > hi - i) { if (lo < j) { _qs[sp++] = lo; _qs[sp++] = j; } if (i < hi) { _qs[sp++] = i; _qs[sp++] = hi; } }
    else { if (i < hi) { _qs[sp++] = i; _qs[sp++] = hi; } if (lo < j) { _qs[sp++] = lo; _qs[sp++] = j; } }
  }
}

/**
 * `pts[0 .. n*2)` 의 xz 쌍으로 2D 볼록 껍질을 만든다 (monotone chain). 반시계 `Float32Array`, 점이 3개 미만이거나
 * 넓이가 0 이면 null. `maxVerts` 를 넘으면 모서리를 깎아 줄인다 (깎인 만큼 콜라이더가 메시 안쪽으로 조금 들어간다 —
 * 밖으로 부풀리지 않는다).
 */
export function convexHull2D(pts: Float32Array, n: number, maxVerts = HULL_MAX_VERTS): Float32Array | null {
  if (n < 3) return null;
  if (_idx.length < n) _idx = new Int32Array(Math.max(n, _idx.length * 2));
  for (let i = 0; i < n; i++) _idx[i] = i;
  sortIdx(pts, _idx, n);
  const cross = (o: number, a: number, b: number): number =>
    (pts[a * 2] - pts[o * 2]) * (pts[b * 2 + 1] - pts[o * 2 + 1]) - (pts[a * 2 + 1] - pts[o * 2 + 1]) * (pts[b * 2] - pts[o * 2]);
  _stack.length = 0;
  for (let k = 0; k < n; k++) {
    const i = _idx[k];
    while (_stack.length >= 2 && cross(_stack[_stack.length - 2], _stack[_stack.length - 1], i) <= 1e-9) _stack.pop();
    _stack.push(i);
  }
  const lowerLen = _stack.length + 1;
  for (let k = n - 2; k >= 0; k--) {
    const i = _idx[k];
    while (_stack.length >= lowerLen && cross(_stack[_stack.length - 2], _stack[_stack.length - 1], i) <= 1e-9) _stack.pop();
    _stack.push(i);
  }
  _stack.pop();                                   // 마지막 점 = 첫 점
  if (_stack.length < 3) return null;
  const xs: number[] = [], zs: number[] = [];
  for (const i of _stack) { xs.push(pts[i * 2]); zs.push(pts[i * 2 + 1]); }
  // 꼭짓점이 너무 많으면 넓이를 가장 적게 잃는 꼭짓점부터 뺀다
  while (xs.length > Math.max(3, maxVerts)) {
    let bestI = 0, bestA = Infinity;
    const m = xs.length;
    for (let i = 0; i < m; i++) {
      const p = (i + m - 1) % m, q = (i + 1) % m;
      const a = Math.abs((xs[i] - xs[p]) * (zs[q] - zs[p]) - (zs[i] - zs[p]) * (xs[q] - xs[p]));
      if (a < bestA) { bestA = a; bestI = i; }
    }
    xs.splice(bestI, 1); zs.splice(bestI, 1);
  }
  const out = new Float32Array(xs.length * 2);
  let area = 0;
  for (let i = 0; i < xs.length; i++) {
    out[i * 2] = xs[i]; out[i * 2 + 1] = zs[i];
    const j = (i + 1) % xs.length;
    area += xs[i] * zs[j] - xs[j] * zs[i];
  }
  if (area <= 1e-6) return null;                  // monotone chain 은 반시계를 준다 — 0 이면 퇴화
  return out;
}

/** `(cx, cz)` 에서 윤곽(과 층) 꼭짓점까지의 최대 거리 — `Obstacle.radius` 에 넣는 외접원. */
export function hullRadiusFrom(hull: ObstacleHull, cx: number, cz: number): number {
  let r = 0;
  const scan = (p: Float32Array): void => {
    for (let i = 0; i < p.length; i += 2) {
      const d = Math.hypot(p[i] - cx, p[i + 1] - cz);
      if (d > r) r = d;
    }
  };
  scan(hull.points);
  if (hull.bands) for (const b of hull.bands) scan(b.points);
  return r;
}

/** 윤곽의 넓이와 무게중심 (`obstacleCoverage` 용). */
export function hullAreaCentroid(p: Float32Array, out: { area: number; x: number; z: number }): void {
  let a2 = 0, cx = 0, cz = 0;
  const m = p.length / 2;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    const xi = p[i * 2], zi = p[i * 2 + 1], xj = p[j * 2], zj = p[j * 2 + 1];
    const c = xi * zj - xj * zi;
    a2 += c; cx += (xi + xj) * c; cz += (zi + zj) * c;
  }
  if (Math.abs(a2) < 1e-9) { out.area = 0; out.x = p[0]; out.z = p[1]; return; }
  out.area = a2 / 2;
  out.x = cx / (3 * a2);
  out.z = cz / (3 * a2);
}

/* ── 질의 ───────────────────────────────────────────────────────────────────────────────────────────── */

/** `(x, z)` 가 윤곽 안인가 (`margin` 만큼 넉넉히). */
export function hullContainsXZ(p: Float32Array, x: number, z: number, margin = 0): boolean {
  const m = p.length / 2;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    const ax = p[i * 2], az = p[i * 2 + 1];
    const dx = p[j * 2] - ax, dz = p[j * 2 + 1] - az;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1e-9) continue;
    if (((x - ax) * dz - (z - az) * dx) / len > margin) return false;
  }
  return true;
}

/**
 * 반지름 `radius` 원을 윤곽 밖으로 밀어낸다 (`position` 을 제자리에서 고친다). 겹치지 않으면 false.
 * 중심이 안이면 **가장 얕은 변**으로 빼낸다 (`obb.boxPushOut` 과 같은 규약 — 모서리를 스치며 옆으로 튕기지 않게).
 */
export function hullPushOut(p: Float32Array, position: THREE.Vector3, radius: number): boolean {
  const m = p.length / 2;
  const px = position.x, pz = position.z;
  let sMax = -Infinity, nxMax = 0, nzMax = 0;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    const ax = p[i * 2], az = p[i * 2 + 1];
    const dx = p[j * 2] - ax, dz = p[j * 2 + 1] - az;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1e-9) continue;
    const nx = dz / len, nz = -dx / len;
    const s = (px - ax) * nx + (pz - az) * nz;
    if (s > sMax) { sMax = s; nxMax = nx; nzMax = nz; }
  }
  if (sMax >= radius) return false;               // 가장 먼 변의 반평면 밖으로 반지름 이상 — 겹칠 수 없다
  if (sMax <= 0) {
    position.x += nxMax * (radius - sMax);
    position.z += nzMax * (radius - sMax);
    return true;
  }
  // 바깥이지만 가깝다: 윤곽에서 가장 가까운 점을 정확히 찾는다 (꼭짓점 근처는 반평면 거리보다 멀다)
  let best = Infinity, cx = px, cz = pz;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    const ax = p[i * 2], az = p[i * 2 + 1];
    const dx = p[j * 2] - ax, dz = p[j * 2 + 1] - az;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
    const qx = ax + dx * t, qz = az + dz * t;
    const d2 = (px - qx) * (px - qx) + (pz - qz) * (pz - qz);
    if (d2 < best) { best = d2; cx = qx; cz = qz; }
  }
  if (best >= radius * radius) return false;
  const d = Math.sqrt(best);
  if (d < 1e-6) { position.x += nxMax * radius; position.z += nzMax * radius; return true; }
  const push = radius - d;
  position.x += ((px - cx) / d) * push;
  position.z += ((pz - cz) / d) * push;
  return true;
}

/** `rayHull` 이 채우는 법선 (호출자가 바로 읽는다 — 보관 금지). */
export const hullHitNormal = { x: 0, y: 1, z: 0 };

/**
 * 레이 vs 볼록 기둥 한 층 (`[y0, y1]`). 맞으면 `t`, 아니면 −1. 원기둥 · 상자와 같은 규약으로 **원점이 이미 안이면
 * 맞지 않은 것**으로 친다. Cyrus–Beck: 변마다 반평면으로 잘라 들어가는 `t` 의 최댓값과 나가는 `t` 의 최솟값을 잡는다.
 */
export function rayHull(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  p: Float32Array, y0: number, y1: number, maxT: number,
): number {
  if (y1 <= y0) return -1;
  let tE = -Infinity, tL = Infinity;
  let enx = 0, eny = 0, enz = 0;
  const m = p.length / 2;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    const ax = p[i * 2], az = p[i * 2 + 1];
    const ex = p[j * 2] - ax, ez = p[j * 2 + 1] - az;
    const len = Math.sqrt(ex * ex + ez * ez);
    if (len < 1e-9) continue;
    const nx = ez / len, nz = -ex / len;
    const num = (ax - ox) * nx + (az - oz) * nz;
    const den = dx * nx + dz * nz;
    if (Math.abs(den) < 1e-9) { if (num < 0) return -1; continue; }
    const t = num / den;
    if (den < 0) { if (t > tE) { tE = t; enx = nx; eny = 0; enz = nz; } }
    else if (t < tL) tL = t;
    if (tE > tL) return -1;
  }
  if (Math.abs(dy) < 1e-9) {
    if (oy < y0 || oy > y1) return -1;
  } else {
    let t0 = (y0 - oy) / dy, t1 = (y1 - oy) / dy;
    let ny = -1;
    if (t0 > t1) { const t = t0; t0 = t1; t1 = t; ny = 1; }
    if (t0 > tE) { tE = t0; enx = 0; eny = ny; enz = 0; }
    if (t1 < tL) tL = t1;
  }
  if (tE > tL || tE < 0 || tE > maxT) return -1;
  hullHitNormal.x = enx; hullHitNormal.y = eny; hullHitNormal.z = enz;
  return tE;
}
