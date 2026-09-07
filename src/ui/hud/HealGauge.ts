import type { GameContext } from '@/shared';
import { HEAL_HOLD_S } from '@/shared';
import { el, setText, toggleClass } from '../dom';

const SIZE = 120;
const RADIUS = 48;
const NEAR = 0.75;   // ring turns green past this point ("almost injected")

/**
 * 회복약 hold gauge (`.heal`, Phase 10). The 회복약 (the item formerly labelled 스팀 — the `stim` def id is unchanged)
 * is no longer a tap: LMB has to be **held for `HEAL_HOLD_S`** while it is in hand, and this ring at the crosshair is
 * that hold. Modelled on `hud/CookGauge` (same 48 px radius, same `.show` fade, same reticle anchor) but drawn as a
 * **full circle** like `hud/ChargeGauge` / `hud/ReloadGauge`, because a 360° single SVG arc degenerates — the ring is a
 * `circle` with `stroke-dasharray` on its circumference, rotated −90° so it fills from 12 o'clock.
 *
 * Driven entirely by `heal:holdChanged {holding, t}` (weapons owns the timing, `t` = 0..1 progress; `t < 0` /
 * `holding: false` is a cancel). Taking damage does **not** cancel the hold (`HEAL_HOLD_CANCEL_ON_DAMAGE` is false), so
 * the gauge only closes on release, on the injection itself, and on death / downed / mission reset.
 */
export class HealGauge {
  readonly root: HTMLElement;
  private fill: SVGCircleElement;
  private label: HTMLElement;
  private circumference: number;
  private lastT = -1;
  private lastLabel = '';
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'heal', parent });
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
    const text = el('div', { cls: 'text', parent: this.root });
    this.label = el('div', { cls: 'lbl ui-mono', text: '회복약', parent: text });
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('heal:holdChanged', ({ holding, t }) => {
        if (!holding || t < 0) { this.hide(); return; }
        const c = Math.min(1, Math.max(0, t));
        toggleClass(this.root, 'show', true);
        toggleClass(this.root, 'near', c > NEAR && c < 1);
        toggleClass(this.root, 'ready', c >= 1);
        this.setFill(c);
        const secs = `${Math.max(0, (1 - c) * HEAL_HOLD_S).toFixed(1)} s`;
        if (secs !== this.lastLabel) { this.lastLabel = secs; setText(this.label, `회복약 ${secs}`); }
      }),
      b.on('player:died', () => this.hide()),
      b.on('player:downed', () => this.hide()),
      b.on('game:newMission', () => this.hide()),
      b.on('game:abort', () => this.hide()),
    );
  }

  /** Whether the hold ring is showing (debug / smoke). */
  get isShowing(): boolean { return this.root.classList.contains('show'); }

  private hide(): void {
    this.root.classList.remove('show', 'near', 'ready');
    this.setFill(0);
    this.lastLabel = '';
  }

  private setFill(t: number): void {
    if (Math.abs(t - this.lastT) < 0.004) return;
    this.lastT = t;
    this.fill.style.strokeDasharray = `${(t * this.circumference).toFixed(2)} ${this.circumference.toFixed(2)}`;
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
