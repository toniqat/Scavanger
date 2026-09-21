import type { MapPreviewLayout, MapPreviewSpot } from '@/shared';
import { MAP_SIZE } from '@/shared';

/* ────────────────────────────────────────────────────────────────────────────
 * The intel broker — the planet map preview (2026-09-14).
 *
 * User's decision: **the real layout, blurred onto a grid.** It takes the layout run from the same seed (no mesh)
 * and draws only 「which grid cell holds what」, smeared — an exact coordinate is never readable. So it
 *
 *   ① **snaps** everything to `cells × cells` cells (a cell is `MAP_SIZE / cells` metres across — see `DEFAULT_CELLS`),
 *   ② fills the cells as flat blocks and smears them with `ctx.filter = blur(…)`,
 *   ③ lays one very faint sharp rectangle on top, leaving no more than 「there is something here」.
 *
 * **This file is pure drawing.** It imports neither `ctx` nor `@/world` — folders never import one another, so the
 * layout arrives only as the contract type **`shared/types.MapPreviewLayout`** (= the result of
 * `ctx.world.previewLayout(...)`). That function goes through the **same code** as real generation, so the preview
 * cannot differ from the real map.
 *
 * Owner: hub/ui. Used by — `hub/ui/IntelMenu.ts` (left of the pick screen · right of the confirmed screen, **the
 * same function**).
 * ──────────────────────────────────────────────────────────────────────────── */

/** The kinds shown smeared on the map. The legend follows this order too. */
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

/** The source of one legend row — the colour reads the **same table** as the map (two copies and they drift). */
export const INTEL_MAP_LEGEND: readonly IntelMapLegendEntry[] =
  INTEL_MAP_KINDS.map((kind) => ({ kind, label: KIND_LABEL[kind], color: KIND_COLOR[kind] }));

/* ── layout ────────────────────────────────────────────────────────────────── */

/** The layout this screen draws = the contract type as it is (`ctx.world.previewLayout`). */
export type IntelMapLayout = MapPreviewLayout;

/* ── drawing ───────────────────────────────────────────────────────────────── */

export interface DrawIntelMapOptions {
  /** One side of the world (m). Default `MAP_SIZE`. */
  mapSize?: number;
  /** Number of grid cells (per side). The more there are the sharper a coordinate reads — default `DEFAULT_CELLS`, i.e. cells of `MAP_SIZE / DEFAULT_CELLS` m. */
  cells?: number;
  /** The text printed in the centre when there is no layout (default `지도 미리보기 없음`). */
  emptyText?: string;
  /** Device pixel ratio cap (default 2). */
  maxDpr?: number;
}

const DEFAULT_CELLS = 18;

/** Cell index → `cy * cells + cx`. Outside the grid it is -1. */
function cellOf(x: number, z: number, half: number, cell: number, cells: number): number {
  const cx = Math.floor((x + half) / cell);
  const cz = Math.floor((z + half) / cell);
  if (cx < 0 || cz < 0 || cx >= cells || cz >= cells) return -1;
  return cz * cells + cx;
}

/** A point on the `RailPlan` centre line — **the same** formula as `world/layout`'s (so the preview does not lie). */
function railPointAt(loop: boolean, extent: number, angle: number, t: number): { x: number; z: number } {
  return loop
    ? { x: Math.cos(angle + t * Math.PI * 2) * extent, z: Math.sin(angle + t * Math.PI * 2) * extent }
    : { x: Math.cos(angle) * (t * 2 - 1) * extent, z: Math.sin(angle) * (t * 2 - 1) * extent };
}

/**
 * Layout → the set of 「cells to fill」 per kind. Kept apart from the drawing so a smoke test can check it as
 * numbers. **It never throws on a malformed value** — a map that does not draw and a screen that will not open are
 * two different things.
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
  /** A spot with a radius marks every cell it touches — no more than 「a big thing looks big」. */
  const markSpot = (k: IntelMapKind, p: MapPreviewSpot | null | undefined): void => {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return;
    const r = Math.max(0, Number(p.r) || 0);
    // anything smaller than a cell is **one cell** — bleeding into a neighbour for every small spot turns the map into mottling
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
  each('structure', layout.pois);            // abandoned outposts share the one 「structure」 colour (too many colours on a blurred map read as nothing)
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
 * Draws the map onto one canvas. **A pure function** — it reads nothing but `layout`, so the pick screen and the
 * confirmed screen get the same picture (CLAUDE.md 「previewing contents must equal opening」).
 */
export function drawIntelMap(canvas: HTMLCanvasElement, layout: IntelMapLayout | null, opts: DrawIntelMapOptions = {}): void {
  const cells = Math.max(6, Math.round(opts.cells ?? DEFAULT_CELLS));
  // the map's side length comes first from what the preview carried (`MAP_SIZE` is the default when it has none)
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

  // the map is square — fit it to the shorter side and centre it (the map is square, so distorting the aspect lies)
  const side = Math.min(cssW, cssH);
  const ox = (cssW - side) / 2;
  const oy = (cssH - side) / 2;
  const px = side / cells;

  // floor
  g.fillStyle = 'rgba(6, 10, 15, 0.82)';
  g.fillRect(ox, oy, side, side);

  const marks = intelMapCells(layout, mapSize, cells);

  // ① the smeared blocks — one cell bleeds by the blur radius and its edges disappear
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

  // ② the sharp cell marks — very faint (they tell no more than 「it is in this cell」)
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

  // ③ grid lines
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

  // ④ border + corner marks
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

/* ── canvas + one legend row (the small view the screen uses) ──────────────── */

export interface IntelMapView {
  /** `.his-map` — attached to and detached from a parent to move between the pick screen ↔ the confirmed screen. */
  readonly root: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  /** Changes where it is attached (two panels share the one canvas). */
  mount(host: HTMLElement): void;
  /** Swaps the layout in and redraws. */
  setLayout(layout: IntelMapLayout | null): void;
  /** Redraws when the size changed (a window resize · a panel move). */
  redraw(): void;
  dispose(): void;
}

/**
 * The map canvas + one legend row. The legend is DOM, but its colours come from `INTEL_MAP_LEGEND` (= the same
 * table as the map). With a `ResizeObserver` it redraws itself whenever the panel's size changes.
 */
export function createIntelMapView(): IntelMapView {
  const root = document.createElement('div');
  root.className = 'his-map';
  const stage = document.createElement('div');
  stage.className = 'his-map-stage';
  root.appendChild(stage);
  const canvas = document.createElement('canvas');
  canvas.className = 'his-map-canvas';
  stage.appendChild(canvas);
  const legend = document.createElement('div');
  legend.className = 'his-map-legend';
  root.appendChild(legend);
  for (const e of INTEL_MAP_LEGEND) {
    const item = document.createElement('span');
    item.className = 'his-map-leg';
    const chip = document.createElement('i');
    chip.style.background = e.color;
    item.appendChild(chip);
    const txt = document.createElement('span');
    txt.textContent = e.label;
    item.appendChild(txt);
    legend.appendChild(item);
  }

  let layout: IntelMapLayout | null = null;
  // a map that cannot be drawn and **a screen that will not open** are two things — a failed draw stops here
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
