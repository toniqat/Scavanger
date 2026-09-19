import type { CryptoCandle, CryptoChartRange } from '@/shared';
import { CRYPTO_CANDLE_MS } from '@/shared';
import { el, setText } from '../dom';
import { fmtChange, fmtPrice } from './common';

/* ────────────────────────────────────────────────────────────────────────────
 * **The exchange chart** (2026-09-13, the main computer · the `거래소` tab) — drawn directly with canvas 2D (no external library · no asset).
 *
 *  - Two shapes, candle / line (`setMode`). Right = the price axis (about 5 ticks · the last price as a dashed line + a tag), bottom = the time axis.
 *  - Hover = the crosshair + an OHLC card (`.mn-chart-tip`, DOM). Drawn straight from the pointer event — 180 candles at most,
 *    so it is cheap, and the result is the same headless, where rAF has stopped.
 *  - The size follows the wrapping box (`.mn-chart`) (`ResizeObserver`, devicePixelRatio applied).
 *  - The candle data is passed in by the caller — laying the server history + the current quote onto the last candle is `withLivePrice` (it never edits the array it was given).
 *  - With a message (`setMessage`) the text is centred instead of the chart (「서버에 연결되어야 합니다」 · 「시세 이력을 불러오는 중…」).
 * ──────────────────────────────────────────────────────────────────────────── */

export type ChartMode = 'candle' | 'line';

const PAD_L = 10;
const PAD_R = 66;
const PAD_T = 12;
const PAD_B = 24;
const UP = '#4fd17e';
const DOWN = '#ff4d4d';
const GRID = 'rgba(255, 255, 255, 0.06)';
const AXIS = 'rgba(232, 230, 225, 0.55)';
const CROSS = 'rgba(232, 230, 225, 0.45)';

/**
 * Lays the current quote onto the last candle of the server history: inside the last candle's span it edits c · h · l, past it a new candle is appended.
 * Returns a new array (net's array is left alone).
 */
export function withLivePrice(hist: readonly CryptoCandle[], range: CryptoChartRange, price: number | null, at: number): CryptoCandle[] {
  const out = hist.map((c) => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c }));
  if (price === null || !(price > 0) || !(at > 0) || !out.length) return out;
  const span = CRYPTO_CANDLE_MS[range];
  const last = out[out.length - 1];
  if (at < last.t) return out;
  if (at < last.t + span) {
    last.c = price;
    last.h = Math.max(last.h, price);
    last.l = Math.min(last.l, price);
  } else {
    const t = Math.floor(at / span) * span;
    out.push({ t, o: last.c, h: Math.max(last.c, price), l: Math.min(last.c, price), c: price });
  }
  return out;
}

/** A 1 · 2 · 2.5 · 5 × 10ⁿ tick step. */
function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

function timeLabel(t: number, range: CryptoChartRange): string {
  const d = new Date(t);
  if (range === '1h' || range === '1d') return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (range === '1w') return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}시`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function fullTime(t: number): string {
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export class CryptoChart {
  readonly root: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D | null;
  private readonly tip: HTMLElement;
  private readonly msgEl: HTMLElement;
  private candles: readonly CryptoCandle[] = [];
  private range: CryptoChartRange = '1d';
  private mode: ChartMode = 'candle';
  private color = '#8fe8ff';
  private message: string | null = null;
  private hoverX = -1;
  private hoverY = -1;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private readonly ro: ResizeObserver | null = null;
  private font = '11px monospace';
  /** Smoke / perf counters. `hoverIndex` = the candle under the crosshair (−1 = none). */
  readonly debug = { draws: 0, candles: 0, hoverIndex: -1, width: 0, height: 0 };

  private readonly onMove = (e: PointerEvent): void => {
    const r = this.canvas.getBoundingClientRect();
    this.hoverX = e.clientX - r.left;
    this.hoverY = e.clientY - r.top;
    this.draw();
  };

  private readonly onLeave = (): void => {
    this.hoverX = this.hoverY = -1;
    this.draw();
  };

  private readonly onWinResize = (): void => this.resize();

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'mn-chart', parent });
    this.canvas = el('canvas', { cls: 'mn-chart-canvas', parent: this.root });
    this.g = this.canvas.getContext('2d');
    this.tip = el('div', { cls: 'mn-chart-tip', parent: this.root });
    this.tip.hidden = true;
    this.msgEl = el('div', { cls: 'mn-chart-msg', parent: this.root });
    this.msgEl.hidden = true;
    this.canvas.addEventListener('pointermove', this.onMove);
    this.canvas.addEventListener('pointerdown', this.onMove);
    this.canvas.addEventListener('pointerleave', this.onLeave);
    if (typeof ResizeObserver === 'function') {
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(this.root);
    } else {
      window.addEventListener('resize', this.onWinResize);
    }
  }

  setData(candles: readonly CryptoCandle[], range: CryptoChartRange, color: string): void {
    this.candles = candles;
    this.range = range;
    this.color = color || '#8fe8ff';
    this.draw();
  }

  setMode(mode: ChartMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.draw();
  }

  get currentMode(): ChartMode { return this.mode; }

  /** The text to show instead of the chart (null = the chart is drawn). */
  setMessage(text: string | null): void {
    if (this.message === text) return;
    this.message = text;
    this.msgEl.hidden = text === null;
    setText(this.msgEl, text ?? '');
    toggle(this.root, 'is-msg', text !== null);
    this.draw();
  }

  /** Fits the canvas to the wrapping box's size (nothing happens while it is not visible). */
  resize(): void {
    const r = this.root.getBoundingClientRect();
    const w = Math.round(r.width), h = Math.round(r.height);
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    if (w <= 0 || h <= 0) return;
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w; this.h = h; this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    const mono = getComputedStyle(this.root).getPropertyValue('--ui-mono').trim();
    this.font = `11px ${mono || 'monospace'}`;
    this.draw();
  }

  draw(): void {
    const g = this.g;
    if (!g) return;
    if (this.w <= 0 || this.h <= 0) this.resize();
    const W = this.w, H = this.h;
    if (W <= 0 || H <= 0) return;
    this.debug.draws++;
    this.debug.width = W; this.debug.height = H;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const list = this.candles;
    this.debug.candles = list.length;
    if (this.message !== null || !list.length) {
      this.debug.hoverIndex = -1;
      this.tip.hidden = true;
      return;
    }
    const plotW = Math.max(10, W - PAD_L - PAD_R);
    const plotH = Math.max(10, H - PAD_T - PAD_B);
    let lo = Infinity, hi = -Infinity;
    for (const c of list) { if (c.l < lo) lo = c.l; if (c.h > hi) hi = c.h; }
    if (!(hi > lo)) { hi = lo * 1.01 + 1; lo = lo * 0.99; }
    const padV = (hi - lo) * 0.08;
    lo -= padV; hi += padV;
    const yOf = (p: number): number => PAD_T + (1 - (p - lo) / (hi - lo)) * plotH;
    const step = plotW / list.length;
    const xOf = (i: number): number => PAD_L + (i + 0.5) * step;

    g.font = this.font;
    g.textBaseline = 'middle';
    // price ticks + the horizontal grid
    const tick = niceStep((hi - lo) / 4);
    g.strokeStyle = GRID;
    g.lineWidth = 1;
    g.fillStyle = AXIS;
    g.textAlign = 'left';
    for (let p = Math.ceil(lo / tick) * tick; p <= hi; p += tick) {
      const y = Math.round(yOf(p)) + 0.5;
      g.beginPath(); g.moveTo(PAD_L, y); g.lineTo(PAD_L + plotW, y); g.stroke();
      g.fillText(fmtPrice(p), PAD_L + plotW + 8, y);
    }
    // time ticks + the vertical grid
    const labels = Math.max(2, Math.min(6, Math.floor(plotW / 110)));
    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (let k = 0; k < labels; k++) {
      const i = Math.round(((k + 0.5) / labels) * (list.length - 1));
      const x = Math.round(xOf(i)) + 0.5;
      g.beginPath(); g.moveTo(x, PAD_T); g.lineTo(x, PAD_T + plotH); g.stroke();
      g.fillText(timeLabel(list[i].t, this.range), x, PAD_T + plotH + 6);
    }

    if (this.mode === 'line') {
      const grad = g.createLinearGradient(0, PAD_T, 0, PAD_T + plotH);
      grad.addColorStop(0, withAlpha(this.color, 0.28));
      grad.addColorStop(1, withAlpha(this.color, 0));
      g.beginPath();
      list.forEach((c, i) => { const x = xOf(i), y = yOf(c.c); if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); });
      g.strokeStyle = this.color;
      g.lineWidth = 1.6;
      g.stroke();
      g.lineTo(xOf(list.length - 1), PAD_T + plotH);
      g.lineTo(xOf(0), PAD_T + plotH);
      g.closePath();
      g.fillStyle = grad;
      g.fill();
    } else {
      const body = Math.max(1, Math.min(14, step * 0.64));
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        const up = c.c >= c.o;
        const x = xOf(i);
        g.strokeStyle = g.fillStyle = up ? UP : DOWN;
        g.lineWidth = 1;
        g.beginPath(); g.moveTo(Math.round(x) + 0.5, yOf(c.h)); g.lineTo(Math.round(x) + 0.5, yOf(c.l)); g.stroke();
        const yo = yOf(c.o), yc = yOf(c.c);
        g.fillRect(x - body / 2, Math.min(yo, yc), body, Math.max(1, Math.abs(yc - yo)));
      }
    }

    // the last price — a dashed line + a tag on the right
    const last = list[list.length - 1];
    const lastUp = last.c >= (list.length > 1 ? list[list.length - 2].c : last.o);
    const ly = Math.round(yOf(last.c)) + 0.5;
    g.setLineDash([4, 4]);
    g.strokeStyle = withAlpha(lastUp ? UP : DOWN, 0.7);
    g.beginPath(); g.moveTo(PAD_L, ly); g.lineTo(PAD_L + plotW, ly); g.stroke();
    g.setLineDash([]);
    this.axisTag(g, PAD_L + plotW + 2, ly, fmtPrice(last.c), lastUp ? UP : DOWN, '#05070a');

    // hover — the crosshair + axis tags + the OHLC card
    const hx = this.hoverX, hy = this.hoverY;
    const inside = hx >= PAD_L && hx <= PAD_L + plotW && hy >= PAD_T && hy <= PAD_T + plotH;
    if (!inside) {
      this.debug.hoverIndex = -1;
      this.tip.hidden = true;
      return;
    }
    const idx = Math.max(0, Math.min(list.length - 1, Math.floor((hx - PAD_L) / step)));
    this.debug.hoverIndex = idx;
    const c = list[idx];
    const cx = Math.round(xOf(idx)) + 0.5;
    g.strokeStyle = CROSS;
    g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(cx, PAD_T); g.lineTo(cx, PAD_T + plotH); g.stroke();
    g.beginPath(); g.moveTo(PAD_L, Math.round(hy) + 0.5); g.lineTo(PAD_L + plotW, Math.round(hy) + 0.5); g.stroke();
    g.setLineDash([]);
    const hoverPrice = lo + (1 - (hy - PAD_T) / plotH) * (hi - lo);
    this.axisTag(g, PAD_L + plotW + 2, Math.round(hy) + 0.5, fmtPrice(hoverPrice), 'rgba(232, 230, 225, 0.9)', '#05070a');

    const prev = idx > 0 ? list[idx - 1].c : c.o;
    this.paintTip(c, prev);
    const tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
    let left = hx + 14;
    if (left + tw > W - 4) left = hx - 14 - tw;
    const top = Math.max(4, Math.min(H - th - 4, hy - th / 2));
    this.tip.style.transform = `translate(${Math.round(Math.max(4, left))}px, ${Math.round(top)}px)`;
  }

  private axisTag(g: CanvasRenderingContext2D, x: number, y: number, text: string, bg: string, fg: string): void {
    g.font = this.font;
    const tw = g.measureText(text).width + 10;
    g.fillStyle = bg;
    g.fillRect(x, y - 8, tw, 16);
    g.fillStyle = fg;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillText(text, x + 5, y);
  }

  private paintTip(c: CryptoCandle, prevClose: number): void {
    const change = prevClose > 0 ? (c.c - prevClose) / prevClose : null;
    const key = `${c.t}:${c.o}:${c.h}:${c.l}:${c.c}`;
    if (this.tip.dataset.k !== key) {
      this.tip.dataset.k = key;
      this.tip.textContent = '';
      el('div', { cls: 'mn-chart-tip-t', text: fullTime(c.t), parent: this.tip });
      const rows = el('div', { cls: 'mn-chart-tip-rows', parent: this.tip });
      for (const [k, v] of [['시가', c.o], ['고가', c.h], ['저가', c.l], ['종가', c.c]] as const) {
        el('span', { cls: 'k', text: k, parent: rows });
        el('span', { cls: 'v', text: fmtPrice(v), parent: rows });
      }
      el('span', { cls: 'k', text: '변동', parent: rows });
      const v = el('span', { cls: `v ${change === null ? '' : change >= 0 ? 'up' : 'down'}`.trim(), text: fmtChange(change), parent: rows });
      void v;
    }
    this.tip.hidden = false;
  }

  dispose(): void {
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerdown', this.onMove);
    this.canvas.removeEventListener('pointerleave', this.onLeave);
    this.ro?.disconnect();
    window.removeEventListener('resize', this.onWinResize);
    this.root.remove();
  }
}

function toggle(e: HTMLElement, cls: string, on: boolean): void {
  if (e.classList.contains(cls) !== on) e.classList.toggle(cls, on);
}

/** `#rrggbb` → `rgba(r, g, b, a)` (any other colour string is left alone). */
function withAlpha(css: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(css.trim());
  if (!m) return css;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
