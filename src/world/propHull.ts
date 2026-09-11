/**
 * src/world/propHull.ts — 소품 인스턴스 하나의 **볼록 콜라이더**를 그려진 메시에서 잰다 (2026-09-11).
 *
 * `Props.footprintOf`(2026-09-10) 의 후계다. 그때는 땅 위로 보이는 윤곽의 **방위별 거리 평균**으로 원 하나를
 * 만들었고, 그 원은 길쭉한 바위의 긴 쪽으로는 메시에 파고들고 짧은 쪽으로는 보이는 바위보다 앞에서 막았다.
 * 이제 같은 점들(땅 위 정점 + 삼각형 변이 지형을 뚫고 나오는 점)로 **볼록 껍질**을 만든다 (`hull.ts`).
 *
 * 두 가지 윤곽을 만든다:
 *  - **이동 · 발판 윤곽** (`hull.points`): 지면에서 `MOVE_CAP_M` 까지 — 몸이 실제로 닿는 높이만. 머리 위로 뻗은
 *    크리스탈 조각이 땅바닥에 보이지 않는 벽을 세우지 않게 한다.
 *  - **총알 층** (`hull.bands`): 보이는 높이를 `BAND_M` 안팎의 층으로 나눠 층마다 윤곽 — 위로 좁아지는 첨탑 옆
 *    허공에서 총알이 멈추지 않는다. 낮은 소품은 층이 하나라 `bands` 를 두지 않는다 (이동 윤곽을 그대로 쓴다).
 *
 * 전부 묻혀 땅 위에 아무것도 없으면 null — 콜라이더를 만들지 않는다 (보이지 않는 것은 막지 않는다).
 */
import type * as THREE from 'three';
import { PLAYER_HEIGHT, type ObstacleHull, type ObstacleHullBand } from '@/shared';
import type { BuildCtx } from './build';
import { convexHull2D } from './hull';

/** 지형보다 이만큼은 올라와야 "보인다" 로 센다 (m) — 지면과 z-fighting 하는 얇은 테두리를 벽으로 세지 않는다. */
const FOOT_EPS = 0.05;
/** 이동 윤곽이 보는 높이 상한 (지면 기준, m) — 선 몸의 머리 조금 위까지. */
const MOVE_CAP_M = PLAYER_HEIGHT + 0.4;
/** 총알 층 하나의 대략 높이(m). */
const BAND_M = 1.4;
/** 총알 층 최대 개수. */
const BAND_MAX = 4;

export interface PropCollider {
  /** 이동 윤곽의 XZ 중심 — `Obstacle.position` 의 XZ 로 쓴다 (외접원이 작아지게). */
  x: number;
  z: number;
  hull: ObstacleHull;
  /** 그려진 윗면의 월드 높이. */
  top: number;
}

/* 스크래치 — 월드 생성은 단일 스레드다. */
let _w = new Float32Array(0);       // world xyz
let _terr = new Float32Array(0);    // terrain height under each vertex
let _pts = new Float32Array(0);     // xz pairs
let _cross = new Float32Array(0);   // terrain crossings xyz

function ensure(n: number, tris: number): void {
  if (_w.length < n * 3) { _w = new Float32Array(n * 3); _terr = new Float32Array(n); }
  const cap = (n + tris * 3 * 3) * 2;
  if (_pts.length < cap) _pts = new Float32Array(cap);
  if (_cross.length < tris * 3 * 3) _cross = new Float32Array(tris * 3 * 3);
}

/**
 * 인스턴스 행렬 `m` 으로 놓인 `geo` 의 볼록 콜라이더. 좌표는 전부 월드다.
 */
export function propHullOf(ctx: BuildCtx, geo: THREE.BufferGeometry, m: THREE.Matrix4): PropCollider | null {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const n = pos.count;
  const index = geo.getIndex();
  const tris = index ? index.count / 3 : n / 3;
  ensure(n, tris);
  const e = m.elements;
  /* 2026-09-11 (C-40): `getX/getY/getZ` · `index.getX` 대신 배열을 곧장 읽는다 — 소품 지오메트리는 전부 정규화 안 된
   * `BufferAttribute`(stride 3, offset 0)라 값이 한 비트도 다르지 않다. 생성 시간의 대부분이 이 함수였다. */
  const pa = pos.array as ArrayLike<number>;
  const ia = index ? (index.array as ArrayLike<number>) : null;
  let top = -Infinity, lifted = 0;
  for (let i = 0; i < n; i++) {
    const lx = pa[i * 3], ly = pa[i * 3 + 1], lz = pa[i * 3 + 2];
    const wx = e[0] * lx + e[4] * ly + e[8] * lz + e[12];
    const wy = e[1] * lx + e[5] * ly + e[9] * lz + e[13];
    const wz = e[2] * lx + e[6] * ly + e[10] * lz + e[14];
    _w[i * 3] = wx; _w[i * 3 + 1] = wy; _w[i * 3 + 2] = wz;
    _terr[i] = ctx.terrain.getHeightAt(wx, wz);
    if (wy - _terr[i] - FOOT_EPS > 0) { lifted++; if (wy > top) top = wy; }
  }
  if (lifted === 0) return null;

  const lift = (i: number): number => _w[i * 3 + 1] - _terr[i] - FOOT_EPS;
  const vi = (f: number, k: number): number => (ia ? ia[f * 3 + k] : f * 3 + k);

  // ① 지형 교차점 (변이 땅을 뚫고 나오는 자리) — 이동 윤곽과 모든 층이 같이 쓴다
  let nc = 0;
  let yLow = Infinity;
  for (let f = 0; f < tris; f++) {
    for (let k = 0; k < 3; k++) {
      const a = vi(f, k), b = vi(f, (k + 1) % 3);
      const la = lift(a), lb = lift(b);
      if ((la > 0) === (lb > 0)) continue;
      const t = la / (la - lb);
      const x = _w[a * 3] + (_w[b * 3] - _w[a * 3]) * t;
      const y = _w[a * 3 + 1] + (_w[b * 3 + 1] - _w[a * 3 + 1]) * t;
      const z = _w[a * 3 + 2] + (_w[b * 3 + 2] - _w[a * 3 + 2]) * t;
      _cross[nc * 3] = x; _cross[nc * 3 + 1] = y; _cross[nc * 3 + 2] = z;
      nc++;
      if (y < yLow) yLow = y;
    }
  }
  for (let i = 0; i < n; i++) if (lift(i) > 0 && _w[i * 3 + 1] < yLow) yLow = _w[i * 3 + 1];

  // ② 이동 윤곽: 지면 위 `MOVE_CAP_M` 까지의 정점 + 지형 교차점 + 그 높이 평면을 가르는 변의 교차점
  let np = 0;
  const push = (x: number, z: number): void => { _pts[np * 2] = x; _pts[np * 2 + 1] = z; np++; };
  const above = (i: number): number => _w[i * 3 + 1] - _terr[i];
  for (let i = 0; i < n; i++) if (lift(i) > 0 && above(i) <= MOVE_CAP_M) push(_w[i * 3], _w[i * 3 + 2]);
  for (let c = 0; c < nc; c++) push(_cross[c * 3], _cross[c * 3 + 2]);
  for (let f = 0; f < tris; f++) {
    for (let k = 0; k < 3; k++) {
      const a = vi(f, k), b = vi(f, (k + 1) % 3);
      const ha = above(a) - MOVE_CAP_M, hb = above(b) - MOVE_CAP_M;
      if ((ha > 0) === (hb > 0)) continue;
      const t = ha / (ha - hb);
      if (lift(a) + (lift(b) - lift(a)) * t <= 0) continue;
      push(_w[a * 3] + (_w[b * 3] - _w[a * 3]) * t, _w[a * 3 + 2] + (_w[b * 3 + 2] - _w[a * 3 + 2]) * t);
    }
  }
  let points = convexHull2D(_pts, np);
  if (!points) {
    // 아주 가는 소품 — 보이는 정점 전부로 한 번 더
    np = 0;
    for (let i = 0; i < n; i++) if (lift(i) > 0) push(_w[i * 3], _w[i * 3 + 2]);
    for (let c = 0; c < nc; c++) push(_cross[c * 3], _cross[c * 3 + 2]);
    points = convexHull2D(_pts, np);
  }
  if (!points) return null;

  // ③ 총알 층
  const span = top - yLow;
  const nb = span <= BAND_M * 1.15 ? 1 : Math.min(BAND_MAX, Math.ceil(span / BAND_M));
  let bands: ObstacleHullBand[] | undefined;
  if (nb > 1) {
    bands = [];
    let prev: Float32Array | null = null;
    for (let k = 0; k < nb; k++) {
      const lo = yLow + (span * k) / nb, hi = yLow + (span * (k + 1)) / nb;
      np = 0;
      for (let i = 0; i < n; i++) {
        const wy = _w[i * 3 + 1];
        if (lift(i) > 0 && wy >= lo && wy <= hi) push(_w[i * 3], _w[i * 3 + 2]);
      }
      for (let c = 0; c < nc; c++) {
        const y = _cross[c * 3 + 1];
        if (y >= lo && y <= hi) push(_cross[c * 3], _cross[c * 3 + 2]);
      }
      for (let f = 0; f < tris; f++) {
        for (let kk = 0; kk < 3; kk++) {
          const a = vi(f, kk), b = vi(f, (kk + 1) % 3);
          const ya = _w[a * 3 + 1], yb = _w[b * 3 + 1];
          // 2026-09-11 (C-40): `for (const plane of [lo, hi])` 가 변마다 배열을 만들었다 — 같은 두 번을 풀어 쓴다
          for (let pl = 0; pl < 2; pl++) {
            const plane = pl === 0 ? lo : hi;
            const da = ya - plane, db = yb - plane;
            if ((da > 0) === (db > 0)) continue;
            const t = da / (da - db);
            if (lift(a) + (lift(b) - lift(a)) * t <= 0) continue;
            push(_w[a * 3] + (_w[b * 3] - _w[a * 3]) * t, _w[a * 3 + 2] + (_w[b * 3 + 2] - _w[a * 3 + 2]) * t);
          }
        }
      }
      const bp: Float32Array | null = convexHull2D(_pts, np) ?? prev;
      if (!bp) continue;
      prev = bp;
      // 맨 아래 층은 조금 더 밑으로 내린다 — 경사지에서 교차점 높이가 들쭉날쭉해 밑단이 비지 않게
      bands.push({ y0: k === 0 ? lo - 0.4 : lo, y1: hi, points: bp });
    }
    if (bands.length === 0) bands = undefined;
  }

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < points.length; i += 2) {
    if (points[i] < minX) minX = points[i]; if (points[i] > maxX) maxX = points[i];
    if (points[i + 1] < minZ) minZ = points[i + 1]; if (points[i + 1] > maxZ) maxZ = points[i + 1];
  }
  return { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2, hull: bands ? { points, bands } : { points }, top };
}
