import type { GameContext, WeightState } from '@/shared';
import { WEIGHT_STATE_LABEL_KO, WEIGHT_LIGHT_RATIO, WEIGHT_HEAVY_RATIO } from '@/shared';
import { el, setText, toggleClass, damp } from '../dom';

const POLL_INTERVAL = 0.25;

/**
 * Carry-weight readout above the weapon panel: `12.4 / 30.0 kg` + a bar with the 70 % / 90 % thresholds
 * marked and the 무게 상태 label. Turns amber at 무거움 and red (pulsing) at 과적.
 * Hidden until `ctx.inventory.getWeight()` exists (or `inventory:weightChanged` fires).
 */
export class WeightBar {
  readonly root: HTMLElement;
  private fill: HTMLElement;
  private valEl: HTMLElement;
  private stateEl: HTMLElement;

  private weight = 0;
  private capacity = 0;
  private ratio = 0;
  private state: WeightState = 'normal';
  private shownRatio = 0;
  private lastKey = '';
  private poll = 0;
  private hasData = false;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'weightbar', parent });
    this.root.hidden = true;
    const row = el('div', { cls: 'row', parent: this.root });
    el('span', { cls: 'ui-label', text: '무게', parent: row });
    this.valEl = el('span', { cls: 'val ui-mono', text: '0.0 / 0.0 kg', parent: row });
    const bar = el('div', { cls: 'bar', parent: this.root });
    this.fill = el('i', { cls: 'fill', parent: bar });
    const light = el('i', { cls: 'tick', parent: bar });
    light.style.left = `${(WEIGHT_LIGHT_RATIO * 100).toFixed(0)}%`;
    const heavy = el('i', { cls: 'tick heavy', parent: bar });
    heavy.style.left = `${(WEIGHT_HEAVY_RATIO * 100).toFixed(0)}%`;
    this.stateEl = el('div', { cls: 'state', text: WEIGHT_STATE_LABEL_KO.normal ?? '보통', parent: this.root });
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('inventory:weightChanged', ({ weight, capacity, ratio, state }) => {
        this.apply(weight, capacity, ratio, state);
      }),
      b.on('inventory:overloaded', () => {
        this.root.classList.remove('alert');
        void this.root.offsetWidth;
        this.root.classList.add('alert');
      }),
      b.on('game:newMission', () => { this.poll = 0; }),
    );
  }

  private apply(weight: number, capacity: number, ratio: number, state: WeightState): void {
    this.weight = weight; this.capacity = capacity; this.ratio = ratio; this.state = state;
    this.hasData = true;
    if (this.root.hidden) { this.root.hidden = false; this.shownRatio = ratio; }
  }

  update(dt: number, ctx: GameContext): void {
    this.poll -= dt;
    if (this.poll <= 0) {
      this.poll = POLL_INTERVAL;
      const w = ctx.inventory?.getWeight?.();
      if (w) this.apply(w.weight, w.capacity, w.ratio, w.state);
    }
    if (!this.hasData) return;
    this.shownRatio = damp(this.shownRatio, Math.min(1.35, this.ratio), 12, dt);
    const key = `${this.shownRatio.toFixed(3)}|${this.weight.toFixed(1)}|${this.capacity.toFixed(1)}|${this.state}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.fill.style.transform = `scaleX(${Math.min(1, this.shownRatio).toFixed(3)})`;
    setText(this.valEl, `${this.weight.toFixed(1)} / ${this.capacity.toFixed(1)} kg`);
    setText(this.stateEl, WEIGHT_STATE_LABEL_KO[this.state] ?? this.state);
    toggleClass(this.root, 'light', this.state === 'light');
    toggleClass(this.root, 'heavy', this.state === 'heavy');
    toggleClass(this.root, 'over', this.state === 'over');
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.root.remove();
  }
}
