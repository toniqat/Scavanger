import * as THREE from 'three';
import { COMPUTE_CLUSTER_MAX_CORES } from '@/shared';
import { GeoBatch, HUB_MATS as M } from './GeoBatch';
import type { Builder } from './Furniture';

/* ────────────────────────────────────────────────────────────────────────────
 * 채굴 시설 가구 (2026-09-13, 암호화폐 채굴 — docs/plans/power-crypto.md, 에이전트 ④).
 *
 *   • `compute_cluster` — 연산 클러스터: 폭 2칸 × 깊이 1칸 × 1.9 m 의 날씬한 서버 랙. **넓은 두 면(로컬 ±Z)이 모두 접근 면**
 *     (`access = sides`)이라 코어 칸 3 × 3 이 앞뒤 양면에 똑같이 달린다. 꽂힌 코어 수(`BuildExtra.cores`)만큼 칸이 켜지고
 *     (위 줄 왼쪽부터), 채굴 중이면(`BuildExtra.clusterMining`) 칸마다 상태등이 초록, 멈췄으면 호박색이다. 옆면은 냉각 핀 · 케이블,
 *     윗면은 팬 둘.
 *   • `mining_computer` — 메인 컴퓨터: 3 × 2칸 책상 위 모니터 셋(가운데 = 봉 차트, 왼쪽 = 선 차트, 오른쪽 = 시세 목록 — 전부 발광 막대),
 *     키보드 · 마우스 · 책상 밑 본체(발광 띠).
 *
 * `Furniture.ts` 의 `BUILDERS` 에 그대로 펼쳐 넣는다 (`FurnitureKitchen` 과 같은 `Builder` 모양 · 가운데 · 바닥 y 0 · 앞 −Z · `GeoBatch`).
 * **광원은 하나도 만들지 않는다** — 코어 · 상태등 · 화면은 emissive 재질뿐이다 (CLAUDE.md 「씬의 광원 개수를 플레이 중에 바꾸지 않는다」).
 * 재질은 모듈 상수라 코어 수가 바뀌어 다시 지어도 새로 만들지 않고 버리지 않는다 (지오메트리는 `GeoBatch.build` 가 병합 뒤 원본을 버리고,
 * 병합 메시는 `FurnitureLayer.removePiece` 가 버린다). 스모크가 찾을 수 있게 켜진 코어 재질에 이름을 붙였다 (`mining-core-lit`).
 * ──────────────────────────────────────────────────────────────────────────── */

function std(color: number, roughness: number, metalness: number, emissive = 0, emissiveIntensity = 0, name = ''): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color, roughness, metalness, emissive, emissiveIntensity });
  if (name) m.name = name;
  return m;
}

/** 켜진 코어의 발광 막대 (시안). */
export const MINING_CORE_LIT = std(0xa8e6ff, 0.3, 0.1, 0x3ab8ff, 2.2, 'mining-core-lit');
/** 채굴 중인 코어의 상태등 (초록). */
const CORE_OK = std(0xb4ffc8, 0.4, 0.1, 0x3aff7a, 2.0, 'mining-core-ok');
/** 비어 있는 칸의 꺼진 막대. */
const CORE_OFF = std(0x12171d, 0.6, 0.3, 0, 0, 'mining-core-off');
/** 코어 모듈 몸체. */
const CORE_BODY = std(0x3a4452, 0.42, 0.6);
/** 케이블 (파랑 · 주황). */
const CABLE_BLUE = std(0x1f4a78, 0.7, 0.1);
const CABLE_ORANGE = std(0x9a5a22, 0.7, 0.1);
/** 모니터 화면 바탕 (어둡게 발광 — 위에 얹는 차트 막대가 떠 보이게). */
const SCREEN_BG = std(0x061019, 0.3, 0.2, 0x08222e, 0.9);
const CHART_UP = std(0x8ff5b0, 0.4, 0.1, 0x2fe07a, 1.9);
const CHART_DOWN = std(0xff9a8a, 0.4, 0.1, 0xff3a2a, 1.9);
const CHART_LINE = std(0xa8e6ff, 0.4, 0.1, 0x49c6ff, 2.0);
const SCREEN_TEXT = std(0xb8c6d4, 0.5, 0.1, 0x5a7890, 1.1);
const KEYCAP = std(0x3a3f46, 0.75, 0.2);

const MAX_CORES = Math.max(1, Math.floor(COMPUTE_CLUSTER_MAX_CORES));
const ALONG_X = Math.PI / 2;

/** 가구 로컬 (lx, lz) 를 (cx, cz) 에 서서 ry 만큼 돈 자리로 — three 의 Y 회전과 같은 식. */
function rotXZ(cx: number, cz: number, ry: number, lx: number, lz: number): [number, number] {
  const c = Math.cos(ry), s = Math.sin(ry);
  return [cx + lx * c + lz * s, cz - lx * s + lz * c];
}

/* ── 연산 클러스터 ───────────────────────────────────────────────────────── */

/** 한 넓은 면(`s` = −1 앞 · +1 뒤)의 코어 칸 3 × 3 · 머리 띠 · 통풍 격자. */
function clusterFace(b: GeoBatch, w: number, d: number, s: -1 | 1, accent: THREE.Material, cores: number, mining: boolean): void {
  const zFace = s * (d / 2);
  const cols = 3, rows = Math.ceil(MAX_CORES / cols);
  const x0 = -(w / 2 - 0.08), bayW = (w - 0.16) / cols;
  const yTop = 1.62, yBot = 0.24, bayH = (yTop - yBot) / rows;
  for (let i = 0; i < MAX_CORES; i++) {
    const r = Math.floor(i / cols), c = i % cols;
    const cx = x0 + (c + 0.5) * bayW;
    const cy = yTop - (r + 0.5) * bayH;
    const lit = i < cores;
    b.box(bayW - 0.02, bayH - 0.025, 0.02, cx, cy, zFace - s * 0.05, M.hullDark);                              // 칸 테두리 (움푹)
    b.box(bayW - 0.07, bayH - 0.08, 0.03, cx, cy, zFace - s * 0.035, lit ? CORE_BODY : M.gunmetal);            // 코어 모듈 / 빈 덮개
    b.box(bayW - 0.12, 0.035, 0.01, cx - 0.015, cy + bayH * 0.3, zFace - s * 0.016, lit ? MINING_CORE_LIT : CORE_OFF);   // 발광 막대
    b.box(0.026, 0.026, 0.01, cx + bayW * 0.34, cy + bayH * 0.3, zFace - s * 0.016, lit ? (mining ? CORE_OK : M.stripAmber) : CORE_OFF);   // 상태등
    for (let k = 0; k < 3; k++) b.box(bayW - 0.12, 0.012, 0.008, cx, cy - 0.03 - k * 0.045, zFace - s * 0.017, lit ? M.hullDark : M.floorGrate);   // 통풍 줄
  }
  b.box(w - 0.14, 0.05, 0.012, 0, 1.73, zFace - s * 0.02, accent);                                              // 머리 띠 (가구 색)
  b.box(0.22, 0.028, 0.014, w / 2 - 0.2, 1.8, zFace - s * 0.02, mining ? CORE_OK : cores > 0 ? M.stripAmber : M.stripRed);   // 랙 상태등
  b.box(w - 0.2, 0.09, 0.012, 0, 0.14, zFace - s * 0.02, M.floorGrate);                                        // 아래 통풍 격자
}

function computeCluster(b: GeoBatch, w: number, d: number, h: number, accent: THREE.Material, cores: number, mining: boolean): void {
  b.boxB(w, 0.08, d, 0, 0, 0, M.hullDark);                                                                       // 받침
  b.boxB(w - 0.1, h - 0.2, d - 0.12, 0, 0.08, 0, M.hullDark);                                                    // 속 몸체
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.boxB(0.05, h - 0.14, 0.05, sx * (w / 2 - 0.025), 0.08, sz * (d / 2 - 0.025), M.gunmetal);   // 기둥
  b.box(w, 0.06, d, 0, h - 0.09, 0, M.gunmetal);                                                                 // 윗판
  for (const sx of [-1, 1]) {
    const x = sx * (w / 2 - 0.012);
    b.box(0.02, h - 0.3, d - 0.1, x, h / 2, 0, M.hullLight);                                                     // 옆판
    for (let k = 0; k < 11; k++) b.box(0.03, 0.018, d - 0.16, sx * (w / 2 + 0.004), 0.3 + k * 0.12, 0, M.gunmetal);   // 냉각 핀
    // 케이블 묶음 (옆면 뒤쪽 · 앞쪽) + 윗판으로 넘어가는 고리
    b.cyl(0.016, 0.016, h - 0.4, 6, sx * (w / 2 + 0.03), h / 2 - 0.05, -0.14, CABLE_BLUE);
    b.cyl(0.014, 0.014, h - 0.5, 6, sx * (w / 2 + 0.03), h / 2 - 0.1, 0.14, CABLE_ORANGE);
    b.box(0.03, 0.02, 0.3, sx * (w / 2 + 0.03), h - 0.2, 0, M.trimDark);
  }
  clusterFace(b, w, d, -1, accent, cores, mining);
  clusterFace(b, w, d, 1, accent, cores, mining);
  // 윗면 팬 둘 (틀 · 날개 · 가운데 발광 허브)
  for (const sx of [-1, 1]) {
    const fx = sx * w * 0.24, fy = h - 0.05;
    b.cyl(0.17, 0.17, 0.035, 22, fx, fy, 0, M.gunmetal);
    for (const a of [0.4, 0.4 + Math.PI / 2, 0.4 + Math.PI / 4, 0.4 + (3 * Math.PI) / 4]) b.box(0.28, 0.008, 0.045, fx, fy + 0.022, 0, M.hullLight, a);
    b.cyl(0.045, 0.045, 0.04, 12, fx, fy + 0.025, 0, M.stripCyan);
  }
}

/* ── 메인 컴퓨터 ─────────────────────────────────────────────────────────── */

type ScreenKind = 'candle' | 'line' | 'list';

/** 모니터 하나 — 받침 · 목 · 베젤 · 화면 + 화면 위 발광 차트 막대. (cx, cy, cz) = 베젤 가운데, ry = 방향 (앞 = −Z). */
function monitor(b: GeoBatch, T: number, cx: number, cy: number, cz: number, ry: number, kind: ScreenKind, accent: THREE.Material): void {
  const SW = 0.5, SH = 0.3;
  const at = (lx: number, lz: number): [number, number] => rotXZ(cx, cz, ry, lx, lz);
  const [nx, nz] = at(0, 0.06);
  b.boxB(0.05, cy - T - 0.1, 0.04, nx, T + 0.02, nz, M.gunmetal, ry);                                           // 목
  b.box(0.22, 0.016, 0.15, nx, T + 0.028, nz, M.gunmetal, ry);                                                  // 받침
  b.box(SW + 0.04, SH + 0.04, 0.03, cx, cy, cz, M.hullDark, ry);                                                // 베젤
  const [sx, sz] = at(0, -0.016);
  b.box(SW, SH, 0.004, sx, cy, sz, SCREEN_BG, ry);                                                             // 화면
  const [hx, hz] = at(0, -0.02);
  b.box(SW - 0.04, 0.018, 0.002, hx, cy + SH / 2 - 0.03, hz, accent, ry);                                       // 화면 머리 띠
  const zf = -0.021;
  if (kind === 'candle') {
    const n = 12, span = SW - 0.08;
    let prev = 0;
    for (let i = 0; i < n; i++) {
      const lx = -span / 2 + (i + 0.5) * (span / n);
      const mid = Math.sin(i * 0.9) * 0.04 + i * 0.006 - 0.03;
      const up = mid >= prev;
      const bh = 0.025 + Math.abs(Math.sin(i * 1.7)) * 0.04;
      const [px, pz] = at(lx, zf);
      b.box(0.004, bh + 0.035, 0.002, px, cy - 0.01 + mid, pz, up ? CHART_UP : CHART_DOWN, ry);                  // 꼬리
      b.box(0.022, bh, 0.002, px, cy - 0.01 + mid, pz, up ? CHART_UP : CHART_DOWN, ry);                          // 몸통
      prev = mid;
    }
  } else if (kind === 'line') {
    const n = 11, span = SW - 0.08;
    const pt = (i: number): [number, number] => [-span / 2 + (i / (n - 1)) * span, Math.sin(i * 0.8) * 0.045 + Math.cos(i * 0.37) * 0.025 + i * 0.005 - 0.04];
    for (let i = 0; i < n - 1; i++) {
      const [x1, y1] = pt(i), [x2, y2] = pt(i + 1);
      const len = Math.hypot(x2 - x1, y2 - y1);
      const [px, pz] = at((x1 + x2) / 2, zf);
      b.box(len + 0.004, 0.008, 0.002, px, cy - 0.02 + (y1 + y2) / 2, pz, CHART_LINE, ry, 0, Math.atan2(y2 - y1, x2 - x1));
    }
    const [gx, gz] = at(0, zf + 0.001);
    b.box(SW - 0.08, 0.003, 0.001, gx, cy - 0.1, gz, SCREEN_TEXT, ry);                                          // 바닥선
  } else {
    for (let r = 0; r < 6; r++) {
      const ly = cy + SH / 2 - 0.075 - r * 0.036;
      const up = Math.sin(r * 2.3) > 0;
      const [ax, az] = at(-SW / 2 + 0.05, zf);
      b.box(0.018, 0.018, 0.002, ax, ly, az, r % 3 === 0 ? M.stripAmber : M.stripCyan, ry);                     // 코인 글리프
      const [tx, tz] = at(-0.06, zf);
      b.box(0.2, 0.009, 0.002, tx, ly, tz, SCREEN_TEXT, ry);                                                    // 이름
      const [vx, vz] = at(SW / 2 - 0.08, zf);
      b.box(0.08, 0.011, 0.002, vx, ly, vz, up ? CHART_UP : CHART_DOWN, ry);                                     // 변동률
    }
  }
}

function miningComputer(b: GeoBatch, w: number, d: number, h: number, accent: THREE.Material, level: number): void {
  const T = 0.74;
  const dd = Math.min(0.78, d - 0.1), dz = d / 2 - dd / 2 - 0.04;                                               // 책상은 뒤쪽으로 붙는다
  b.box(w, 0.05, dd, 0, T, dz, M.gunmetal);                                                                     // 상판
  b.box(w - 0.04, 0.012, dd - 0.04, 0, T + 0.03, dz, M.hullLight);
  b.box(w - 0.1, 0.022, 0.02, 0, T - 0.01, dz - dd / 2 + 0.005, accent);                                        // 앞 모서리 띠
  for (const sx of [-1, 1]) b.boxB(0.05, T - 0.025, dd - 0.06, sx * (w / 2 - 0.05), 0, dz, M.hullDark);          // 옆판 다리
  b.boxB(w - 0.14, 0.42, 0.03, 0, 0.26, dz + dd / 2 - 0.05, M.hullDark);                                         // 뒷판
  // 책상 밑 본체 (오른쪽): 통풍 격자 · 세로 발광 띠 · 전원 버튼
  const tx = w / 2 - 0.22, tz = dz - 0.04;
  b.boxB(0.22, 0.54, 0.5, tx, 0, tz, M.hullLight);
  b.box(0.15, 0.3, 0.008, tx + 0.02, 0.3, tz - 0.254, M.floorGrate);
  b.box(0.018, 0.42, 0.008, tx - 0.075, 0.28, tz - 0.254, M.stripCyan);
  b.cyl(0.018, 0.018, 0.01, 10, tx + 0.02, 0.49, tz - 0.254, level > 0 ? CORE_OK : CORE_OFF, ALONG_X);
  // 모니터 셋 — 가운데는 정면, 양옆은 가운데를 향해 안쪽으로 돈다 (앞 −Z 기준, 왼쪽 = −X 는 음의 yaw)
  const my = T + 0.42, mz = dz + dd / 2 - 0.2;
  monitor(b, T, 0, my, mz, 0, 'candle', accent);
  monitor(b, T, -0.55, my - 0.01, mz - 0.1, -0.42, 'line', accent);
  monitor(b, T, 0.55, my - 0.01, mz - 0.1, 0.42, 'list', accent);
  // 키보드 · 마우스 · 컵
  const kz = dz - dd / 2 + 0.2;
  b.box(0.46, 0.02, 0.16, 0, T + 0.045, kz, M.gunmetal);
  for (let r = 0; r < 4; r++) b.box(0.42, 0.01, 0.026, 0, T + 0.06, kz - 0.052 + r * 0.035, KEYCAP);
  b.box(0.1, 0.004, 0.02, 0.17, T + 0.066, kz - 0.052, M.stripCyan);                                            // 발광 키 줄
  b.box(0.055, 0.024, 0.085, 0.34, T + 0.045, kz, M.hullLight);                                                  // 마우스
  b.cyl(0.035, 0.03, 0.085, 12, -0.5, T + 0.07, kz + 0.02, M.trim);                                              // 컵
  // 본체 → 책상 뒤 케이블
  b.cyl(0.012, 0.012, 0.3, 6, tx - 0.02, 0.69, tz + 0.2, CABLE_BLUE);
}

export type MiningKind = 'compute_cluster' | 'mining_computer';

export const MINING_BUILDERS: Readonly<Record<MiningKind, Builder>> = {
  compute_cluster: (b, w, d, h, a, _lv, extra) => {
    const cores = Math.max(0, Math.min(MAX_CORES, Math.floor(extra?.cores ?? 0)));
    computeCluster(b, w, d, h, a, cores, !!extra?.clusterMining && cores > 0);
  },
  mining_computer: (b, w, d, h, a, lv) => miningComputer(b, w, d, h, a, lv),
};
