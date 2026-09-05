import type { GameContext } from '@/shared';
import { STRATAGEM_CHARGE_TIME } from '@/shared';
import { el, setText, toggleClass } from '../dom';

const SIZE = 120;
const RADIUS = 48;

/**
 * Ship-call charge ring (`.charge`): full-circle SVG progress ring (radius 48 px, CookGauge look) around the reticle while
 * `stratagem:chargeChanged.t ≥ 0` (LMB held on an orbital call), label `위치 지정까지 n.n s` (= `(1 − t) × STRATAGEM_CHARGE_TIME`).
 * Hidden on `t = −1`, when targeting starts, when the call is put away (`stratagem:armed null`) and on death / reset.
 */
export class ChargeGauge {
  readonly root: HTMLElement;
  private fill: SVGCircleElement;
  private label: HTMLElement;
  private circumference: number;
  private lastT = -1;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'charge', parent });
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
    this.label = el('div', { cls: 'lbl ui-mono', text: '', parent: this.root });
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('stratagem:chargeChanged', ({ t }) => {
        if (t < 0) { this.hide(); return; }
        const c = Math.min(1, Math.max(0, t));
        toggleClass(this.root, 'show', true);
        toggleClass(this.root, 'ready', c >= 1);
        this.setFill(c);
        setText(this.label, `위치 지정까지 ${Math.max(0, (1 - c) * STRATAGEM_CHARGE_TIME).toFixed(1)} s`);
      }),
      b.on('stratagem:targeting', ({ active }) => { if (active) this.hide(); }),
      b.on('stratagem:armed', ({ id }) => { if (!id) this.hide(); }),
      b.on('player:died', () => this.hide()),
      b.on('player:downed', () => this.hide()),
      b.on('game:newMission', () => this.hide()),
      b.on('game:abort', () => this.hide()),
    );
  }

  private hide(): void {
    this.root.classList.remove('show', 'ready');
    this.setFill(0);
  }

  private setFill(t: number): void {
    if (Math.abs(t - this.lastT) < 0.003) return;
    this.lastT = t;
    this.fill.style.strokeDasharray = `${(t * this.circumference).toFixed(2)} ${this.circumference.toFixed(2)}`;
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
