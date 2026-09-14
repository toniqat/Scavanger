import type { MapPreviewLayout, MapPreviewSpot } from '@/shared';
import { MAP_SIZE } from '@/shared';

/* ────────────────────────────────────────────────────────────────────────────
 * 정보상 — 행성 지도 미리보기 (2026-09-14, docs/plans/intel-broker.md §4.2).
 *
 * 사용자 결정: **실제 레이아웃을 격자로 흐릿하게.** 같은 시드로 돈 레이아웃(메시 없음)을 받아
 * 「어느 격자 칸에 무엇이 있나」만 뭉개서 그린다 — 정확한 좌표는 절대 읽히지 않는다. 그래서
 *
 *   ① 모든 것을 `cells × cells` 칸으로 **스냅**하고 (칸 = MAP_SIZE / cells ≈ 60 m 단위),
 *   ② 칸을 단색 블록으로 칠한 뒤 `ctx.filter = blur(…)` 로 뭉개고,
 *   ③ 그 위에 아주 옅은 또렷한 사각형만 하나 얹어 「여기에 뭔가 있다」 정도만 남긴다.
 *
 * **이 파일은 순수 그리기다.** `ctx` 도 `@/world` 도 import 하지 않는다 — 폴더끼리 import 하지 않는다는 규약
 * 때문에 레이아웃은 계약 타입 **`shared/types.MapPreviewLayout`**(= `ctx.world.previewLayout(...)` 의 결과)만
 * 받는다. 그 함수는 실제 생성과 **같은 코드**를 지나므로 미리보기가 진짜 맵과 어긋날 수 없다.
 *
 * Owner: hub/ui. 쓰는 곳 — `hub/ui/IntelMenu.ts` (고르는 화면의 좌측 · 확정 화면의 우측, **같은 함수**).
 * ──────────────────────────────────────────────────────────────────────────── */

/** 지도에 뭉개서 표시하는 종류. 범례도 이 순서다. */
export type IntelMapKind = 'spawn' | 'extraction' | 'structure' | 'nest' | 'rail' | 'rover';

export const INTEL_MAP_KINDS: readonly IntelMapKind[] = ['spawn', 'extraction', 'structure', 'nest', 'rail', 'rover'];

const KIND_COLOR: Record<IntelMapKind, string> = {
  spawn: '#7fe3a0',
  extraction: '#5fd7ff',
  structure: '#ffb347',
  nest: '#ff6a55',
  rail: '#9aa8ff',
  rover: '#d8a06a',
};

const KIND_LABEL: Record<IntelMapKind, string> = {
  spawn: '강하 지점',
  extraction: '탈출 지점',
  structure: '구조물 · 전초',
  nest: '벌레 둥지',
  rail: '선로 · 플랫폼',
  rover: '흙길 · 정류장',
};

export interface IntelMapLegendEntry { kind: IntelMapKind; label: string; color: string }

/** 범례 한 줄의 원본 — 색은 지도와 **같은 표**를 읽는다 (두 벌이 되면 색이 어긋난다). */
export const INTEL_MAP_LEGEND: readonly IntelMapLegendEntry[] =
  INTEL_MAP_KINDS.map((kind) => ({ kind, label: KIND_LABEL[kind], color: KIND_COLOR[kind] }));

/* ── 레이아웃 ──────────────────────────────────────────────────────────────── */

/** 이 화면이 그리는 레이아웃 = 계약 타입 그대로 (`ctx.world.previewLayout`). */
export type IntelMapLayout = MapPreviewLayout;

/* ── 그리기 ────────────────────────────────────────────────────────────────── */

export interface DrawIntelMapOptions {
  /** 월드 한 변(m). 기본 `MAP_SIZE`. */
  mapSize?: number;
  /** 격자 칸 수 (한 변). 클수록 좌표가 또렷해진다 — 기본 18 (≈ 60 m 칸). */
  cells?: number;
  /** 레이아웃이 없을 때 한가운데 적는 글 (기본 `지도 미리보기 없음`). */
  emptyText?: string;
  /** 장치 픽셀 비율 상한 (기본 2). */
  maxDpr?: number;
}

const DEFAULT_CELLS = 18;

/** 칸 번호 → `cy * cells + cx`. 칸 밖은 -1. */
function cellOf(x: number, z: number, half: number, cell: number, cells: number): number {
  const cx = Math.floor((x + half) / cell);
  const cz = Math.floor((z + half) / cell);
  if (cx < 0 || cz < 0 || cx >= cells || cz >= cells) return -1;
  return cz * cells + cx;
}

/** `RailPlan` 중심선 위의 한 점 — `world/layout` 의 식과 **같다** (미리보기가 거짓말하지 않게). */
function railPointAt(loop: boolean, extent: number, angle: number, t: number): { x: number; z: number } {
  return loop
    ? { x: Math.cos(angle + t * Math.PI * 2) * extent, z: Math.sin(angle + t * Math.PI * 2) * extent }
    : { x: Math.cos(angle) * (t * 2 - 1) * extent, z: Math.sin(angle) * (t * 2 - 1) * extent };
}

/**
 * 레이아웃 → 종류별 「칠할 칸」 집합. 그리기와 분리해 둬서 스모크가 숫자로 검사할 수 있다.
 * **모양이 깨진 값을 받아도 던지지 않는다** — 지도가 안 그려지는 것과 화면이 열리지 않는 것은 다른 일이다.
 */
export function intelMapCells(layout: IntelMapLayout | null, mapSize = MAP_SIZE, cells = DEFAULT_CELLS): Map<IntelMapKind, Set<number>> {
  const out = new Map<IntelMapKind, Set<number>>();
  for (const k of INTEL_MAP_KINDS) out.set(k, new Set<number>());
  if (!layout) return out;
  const half = mapSize / 2;
  const cell = mapSize / cells;

  const mark = (k: IntelMapKind, x: number, z: number): void => {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    const i = cellOf(x, z, half, cell, cells);
    if (i >= 0) out.get(k)!.add(i);
  };
  /** 반지름이 있는 자리는 걸치는 칸을 전부 — 「큰 것은 크게 보인다」 정도만 남긴다. */
  const markSpot = (k: IntelMapKind, p: MapPreviewSpot | null | undefined): void => {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return;
    const r = Math.max(0, Number(p.r) || 0);
    // 한 칸보다 작은 것은 **한 칸**이다 — 작은 자리마다 이웃 칸까지 번지면 지도가 그냥 얼룩이 된다
    if (r < cell * 0.6) { mark(k, p.x, p.z); return; }
    const steps = Math.min(3, Math.ceil(r / cell) + 1);
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      for (let s = 0; s <= steps; s++) mark(k, p.x + Math.cos(ang) * r * (s / steps), p.z + Math.sin(ang) * r * (s / steps));
    }
  };
  const each = (k: IntelMapKind, list: readonly MapPreviewSpot[] | null | undefined): void => {
    if (!Array.isArray(list)) return;
    for (const p of list) markSpot(k, p);
  };

  markSpot('spawn', layout.spawn);
  each('extraction', layout.extraction);
  each('nest', layout.nests);
  each('structure', layout.structures);
  each('structure', layout.pois);            // 폐허 전초도 「구조물」 한 색으로 (흐릿한 지도에 색이 많으면 읽히지 않는다)
  const rail = layout.rail;
  if (rail) {
    const loop = rail.kind === 'loop';
    const steps = 256;
    for (let i = 0; i <= steps; i++) { const p = railPointAt(loop, rail.extent, rail.angle, i / steps); mark('rail', p.x, p.z); }
    each('rail', rail.platforms);
  }
  const rover = layout.rover;
  const route = Array.isArray(rover?.route) ? rover.route : null;
  if (route && route.length > 1) {
    for (let i = 0; i < route.length; i++) {
      const a = route[i], b = route[(i + 1) % route.length];
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      const n = Math.max(1, Math.ceil(d / (cell * 0.5)));
      for (let s = 0; s <= n; s++) mark('rover', a.x + (b.x - a.x) * (s / n), a.z + (b.z - a.z) * (s / n));
    }
  }
  each('rover', rover?.stations);
  return out;
}

/**
 * 캔버스 한 장에 지도를 그린다. **순수 함수** — `layout` 말고는 아무것도 읽지 않으므로 고르는 화면과 확정
 * 화면이 같은 그림을 얻는다 (CLAUDE.md 「열지 않고 미리 보는 것은 여는 것과 같은 함수여야 한다」).
 */
export function drawIntelMap(canvas: HTMLCanvasElement, layout: IntelMapLayout | null, opts: DrawIntelMapOptions = {}): void {
  const cells = Math.max(6, Math.round(opts.cells ?? DEFAULT_CELLS));
  // 맵 한 변은 미리보기가 실어 보낸 값이 우선이다 (`MAP_SIZE` 는 그것이 없을 때의 기본값)
  const fromLayout = layout && Number.isFinite(layout.mapSize) && layout.mapSize > 0 ? layout.mapSize : null;
  const mapSize = opts.mapSize ?? fromLayout ?? MAP_SIZE;
  const dpr = Math.min(opts.maxDpr ?? 2, (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1);
  const cssW = Math.max(1, Math.round(canvas.clientWidth || canvas.width || 1));
  const cssH = Math.max(1, Math.round(canvas.clientHeight || canvas.height || 1));
  const w = Math.max(1, Math.round(cssW * dpr));
  const h = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const g = canvas.getContext('2d');
  if (!g) return;

  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, w, h);
  g.scale(dpr, dpr);

  // 지도는 정사각형 — 짧은 변에 맞추고 가운데 정렬한다 (맵이 정사각형이라 종횡비를 왜곡하면 거짓말이 된다)
  const side = Math.min(cssW, cssH);
  const ox = (cssW - side) / 2;
  const oy = (cssH - side) / 2;
  const px = side / cells;

  // 바닥
  g.fillStyle = 'rgba(6, 10, 15, 0.82)';
  g.fillRect(ox, oy, side, side);

  const marks = intelMapCells(layout, mapSize, cells);

  // ① 뭉갠 블록 — 칸 하나가 blur 반경만큼 번져 경계가 사라진다
  g.save();
  g.filter = `blur(${Math.max(3, px * 0.7).toFixed(1)}px)`;
  for (const kind of INTEL_MAP_KINDS) {
    const set = marks.get(kind)!;
    if (!set.size) continue;
    g.fillStyle = KIND_COLOR[kind];
    g.globalAlpha = kind === 'rail' || kind === 'rover' ? 0.3 : 0.42;
    for (const i of set) {
      const cx = i % cells, cz = (i / cells) | 0;
      g.fillRect(ox + cx * px, oy + cz * px, px, px);
    }
  }
  g.restore();

  // ② 또렷한 칸 표식 — 아주 옅게 (「이 칸에 있다」 이상은 알려 주지 않는다)
  for (const kind of INTEL_MAP_KINDS) {
    const set = marks.get(kind)!;
    if (!set.size) continue;
    g.fillStyle = KIND_COLOR[kind];
    g.globalAlpha = 0.11;
    const inset = px * 0.26;
    for (const i of set) {
      const cx = i % cells, cz = (i / cells) | 0;
      g.fillRect(ox + cx * px + inset, oy + cz * px + inset, px - inset * 2, px - inset * 2);
    }
  }
  g.globalAlpha = 1;

  // ③ 격자선
  g.strokeStyle = 'rgba(140, 200, 235, 0.12)';
  g.lineWidth = 1;
  g.beginPath();
  for (let i = 0; i <= cells; i++) {
    const p = Math.round(ox + i * px) + 0.5;
    g.moveTo(p, oy); g.lineTo(p, oy + side);
    const q = Math.round(oy + i * px) + 0.5;
    g.moveTo(ox, q); g.lineTo(ox + side, q);
  }
  g.stroke();

  // ④ 테두리 + 모서리 표식
  g.strokeStyle = 'rgba(95, 215, 255, 0.35)';
  g.lineWidth = 1;
  g.strokeRect(Math.round(ox) + 0.5, Math.round(oy) + 0.5, Math.round(side) - 1, Math.round(side) - 1);
  g.strokeStyle = 'rgba(95, 215, 255, 0.75)';
  g.lineWidth = 2;
  const tick = Math.max(10, side * 0.055);
  const corners: Array<[number, number, number, number]> = [[0, 0, 1, 1], [side, 0, -1, 1], [0, side, 1, -1], [side, side, -1, -1]];
  g.beginPath();
  for (const [cx, cy, sx, sy] of corners) {
    g.moveTo(ox + cx + sx * tick, oy + cy);
    g.lineTo(ox + cx, oy + cy);
    g.lineTo(ox + cx, oy + cy + sy * tick);
  }
  g.stroke();

  if (!layout) {
    g.fillStyle = 'rgba(180, 200, 215, 0.5)';
    g.font = `${Math.max(11, Math.round(side * 0.035))}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(opts.emptyText ?? '지도 미리보기 없음', ox + side / 2, oy + side / 2);
  }
}

/* ── 캔버스 + 범례 한 줄 (화면이 쓰는 작은 뷰) ─────────────────────────────── */

export interface IntelMapView {
  /** `.it-map` — 부모에 붙였다 떼면서 고르는 화면 ↔ 확정 화면을 오간다. */
  readonly root: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  /** 붙일 곳을 바꾼다 (같은 캔버스를 두 패널이 나눠 쓴다). */
  mount(host: HTMLElement): void;
  /** 레이아웃을 갈아 끼우고 다시 그린다. */
  setLayout(layout: IntelMapLayout | null): void;
  /** 크기가 바뀌었을 때 (창 리사이즈 · 패널 이동) 다시 그린다. */
  redraw(): void;
  dispose(): void;
}

/**
 * 지도 캔버스 + 범례 한 줄. 범례는 DOM 이지만 색은 `INTEL_MAP_LEGEND`(= 지도와 같은 표)에서 온다.
 * `ResizeObserver` 가 있으면 패널 크기가 바뀔 때 알아서 다시 그린다.
 */
export function createIntelMapView(): IntelMapView {
  const root = document.createElement('div');
  root.className = 'it-map';
  const stage = document.createElement('div');
  stage.className = 'it-map-stage';
  root.appendChild(stage);
  const canvas = document.createElement('canvas');
  canvas.className = 'it-map-canvas';
  stage.appendChild(canvas);
  const legend = document.createElement('div');
  legend.className = 'it-map-legend';
  root.appendChild(legend);
  for (const e of INTEL_MAP_LEGEND) {
    const item = document.createElement('span');
    item.className = 'it-map-leg';
    const chip = document.createElement('i');
    chip.style.background = e.color;
    item.appendChild(chip);
    const txt = document.createElement('span');
    txt.textContent = e.label;
    item.appendChild(txt);
    legend.appendChild(item);
  }

  let layout: IntelMapLayout | null = null;
  // 지도가 못 그려지는 것과 **화면이 안 열리는 것**은 다른 일이다 — 그리기 실패는 여기서 끝난다
  const redraw = (): void => {
    try { drawIntelMap(canvas, layout); }
    catch (e) { console.warn('[IntelMap] draw failed', e); try { drawIntelMap(canvas, null, { emptyText: '지도를 그릴 수 없습니다' }); } catch { /* give up */ } }
  };
  let ro: ResizeObserver | null = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => redraw());
    ro.observe(stage);
  }

  return {
    root, canvas,
    mount(host: HTMLElement): void { if (root.parentElement !== host) host.appendChild(root); redraw(); },
    setLayout(next: IntelMapLayout | null): void { layout = next; redraw(); },
    redraw,
    dispose(): void { ro?.disconnect(); ro = null; root.remove(); },
  };
}
