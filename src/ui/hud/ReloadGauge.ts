import type { GameContext } from '@/shared';
import { el, setText, toggleClass } from '../dom';

const SIZE = 120;
const RADIUS = 48;

/** Ring caption per state (2026-09-08: 무기 교체 joined 재장전 on the same crosshair ring). */
const LABEL: Readonly<Record<'reload' | 'swap', string>> = { reload: '재장전', swap: '무기 교체' };

/**
 * Reload ring at the **crosshair** (`.reload`, Phase 10). It replaces the tiny `.arc` SVG that used to sit next to the
 * bottom-right weapon panel — a reload is a moment you watch the centre of the screen for, not the corner.
 *
 * Same shape as `hud/ChargeGauge`: one full-circle SVG progress ring of radius 48 px centred on the reticle, `svg`
 * rotated −90° so the fill starts at 12 o'clock, driven by `stroke-dasharray` on the circumference.
 *
 * `weapon:reloadStarted {duration}` shows it and starts a local countdown (there is no per-frame progress event);
 * `weapon:reloadFinished` hides it, and so does the Phase 10 **`weapon:reloadCancelled`** — without that event a
 * melee swing / weapon swap that aborts the reload would leave the ring filling to 100 % and then sitting there.
 * `weapon:equipped` (the old panel's behaviour), death, downed and a mission reset hide it too.
 *
 * 2026-09-08 — **무기 교체도 같은 링**. The swap used to be a 160 px hairline under the bottom-right weapon box, which
 * nobody looks at mid-fight; `weapon:swapStarted {duration}` now drives this ring with the `무기 교체` label. The two
 * states cannot overlap (a swap cancels a running reload), so one ring serves both — `mode` only decides which
 * events may hide it: `weapon:equipped` fires **halfway through** a swap (that is when the new gun is attached), so
 * it must hide a reload ring and never the swap ring that is still counting down.
 */
export class ReloadGauge {
  readonly root: HTMLElement;
  private fill: SVGCircleElement;
  private label: HTMLElement;
  private circumference: number;
  private mode: 'reload' | 'swap' = 'reload';
  private total = 0;
  private left = 0;
  private lastT = -1;
  private lastLabel = '';
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'reload', parent });
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);
    const mk = (cls: string): SVGCircleElement => {
      const c = document.createElementNS(svgNS, 'circle');
      c.setAttribute('class', cls);
      c.setAttribute('cx', String(SIZE / 2)); c.setAttribute('cy', String(SIZE / 2)); c.setAttribute('r', String(RADIUS));
      svg.appendChild(c);
      return c;
    };
    mk('track');
    this.fill = mk('fill');
    this.circumference = 2 * Math.PI * RADIUS;
    this.fill.style.strokeDasharray = `0 ${this.circumference.toFixed(2)}`;
    this.root.appendChild(svg);
    this.label = el('div', { cls: 'lbl ui-mono', text: '재장전', parent: this.root });
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('weapon:reloadStarted', ({ duration }) => this.start(duration, 'reload')),
      b.on('weapon:reloadFinished', () => this.hide()),
      // Phase 10: a cancel (melee, swap, death) used to be silent — the ring would keep filling without it.
      b.on('weapon:reloadCancelled', () => this.hide()),
      // 2026-09-08: 무기 교체 shares the ring; the swap owns it until the timer runs out.
      b.on('weapon:swapStarted', ({ duration }) => this.start(duration, 'swap')),
      // `weapon:equipped` lands mid-swap (the new gun is attached at 50 %) — it may only clear a reload.
      b.on('weapon:equipped', () => { if (this.mode === 'reload') this.hide(); }),
      b.on('player:died', () => this.hide()),
      b.on('player:downed', () => this.hide()),
      b.on('game:newMission', () => this.hide()),
      b.on('game:abort', () => this.hide()),
    );
  }

  /** Count the ring down; called every frame from `HudSystem` while the gameplay HUD is up. */
  update(dt: number): void {
    if (this.left <= 0) return;
    this.left -= dt;
    if (this.left <= 0) { this.hide(); return; }
    const t = 1 - this.left / this.total;
    this.setFill(t);
    const secs = `${Math.max(0, this.left).toFixed(1)} s`;
    if (secs !== this.lastLabel) { this.lastLabel = secs; setText(this.label, `${LABEL[this.mode]} ${secs}`); }
  }

  private start(duration: number, mode: 'reload' | 'swap'): void {
    this.mode = mode;
    this.total = Math.max(0.05, duration);
    this.left = this.total;
    this.lastLabel = '';
    toggleClass(this.root, 'show', true);
    toggleClass(this.root, 'swap', mode === 'swap');
    this.setFill(0);
    setText(this.label, `${LABEL[mode]} ${this.total.toFixed(1)} s`);
  }

  private hide(): void {
    if (this.left <= 0 && !this.root.classList.contains('show')) return;
    this.left = 0;
    this.root.classList.remove('show');
    this.setFill(0);
    this.lastLabel = '';
  }

  /** Which state the ring is counting down (debug / smoke). */
  get gaugeMode(): 'reload' | 'swap' { return this.mode; }
  /** Whether the ring is showing (debug / smoke). */
  get isShowing(): boolean { return this.root.classList.contains('show'); }
  /** Fill fraction 0..1 while showing, else −1 (debug / smoke). */
  get progress(): number { return this.left > 0 ? Math.min(1, Math.max(0, 1 - this.left / this.total)) : -1; }

  private setFill(t: number): void {
    if (Math.abs(t - this.lastT) < 0.003) return;
    this.lastT = t;
    this.fill.style.strokeDasharray = `${(t * this.circumference).toFixed(2)} ${this.circumference.toFixed(2)}`;
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
