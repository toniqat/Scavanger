import type { GameContext } from '@/shared';
import { HEAL_HOLD_S } from '@/shared';
import { el, setText, toggleClass } from '../dom';

const SIZE = 120;
const RADIUS = 48;
const NEAR = 0.75;   // ring turns green past this point ("almost injected")

/**
 * 회복 소모품 hold gauge (`.heal`, Phase 10; generalised 2026-09-07). A 회복 소모품 is never a tap: LMB has to be held
 * for the item's own use time (`ItemDef.heal.useTime` — 붕대 5 s, 회복주사 2 s, 제세동기 1 s), and this ring at the
 * crosshair is that hold. A 회복 스프레이 channels instead, and the ring shows its remaining gauge. Modelled on `hud/CookGauge` (same 48 px radius, same `.show` fade, same reticle anchor) but drawn as a
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
      b.on('heal:holdChanged', ({ holding, t, dur, spray }) => {
        if (!holding || t < 0) { this.hide(); return; }
        const c = Math.min(1, Math.max(0, t));
        toggleClass(this.root, 'show', true);
        toggleClass(this.root, 'near', !spray && c > NEAR && c < 1);
        toggleClass(this.root, 'ready', !spray && c >= 1);
        this.setFill(c);
        // 2026-09-07: the ring counts down the item's own use time (`dur`); a 스프레이 shows its remaining gauge %.
        const label = spray ? `스프레이 ${Math.round(c * 100)} %` : `회복 ${Math.max(0, (1 - c) * (dur ?? HEAL_HOLD_S)).toFixed(1)} s`;
        if (label !== this.lastLabel) { this.lastLabel = label; setText(this.label, label); }
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
