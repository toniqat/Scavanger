import type { GameContext } from '@/shared';
import { GRENADE_COOK_MAX } from '@/shared';
import { el, setText, toggleClass } from '../dom';

const SIZE = 120;
const RADIUS = 48;
const SPAN_DEG = 120;
const WARM = 0.6;
const HOT = 0.85;

/** Arc path centred on the reticle, bulging to the right (3 o'clock), `span` degrees, drawn top → bottom. */
function arcPath(): string {
  const c = SIZE / 2;
  const pt = (a: number): string => {
    const t = (a * Math.PI) / 180;
    return `${(c + RADIUS * Math.cos(t)).toFixed(2)} ${(c + RADIUS * Math.sin(t)).toFixed(2)}`;
  };
  return `M${pt(-SPAN_DEG / 2)} A${RADIUS} ${RADIUS} 0 0 1 ${pt(SPAN_DEG / 2)}`;
}

/**
 * Grenade cook gauge (`.cook`): a 120° SVG arc right of the reticle (radius 48 px) shown while
 * `grenade:holdChanged.holding`. While `cooking` the arc fills with `cooked / GRENADE_COOK_MAX` (`.warm` amber > 60 %,
 * `.hot` red + pulse > 85 %). Label under the arc: `R 핀 제거` before the pin is pulled, `n.n s` (fuse left on release)
 * while cooking; `언더핸드` tag when `underhand`. Hidden when `holding` is false. `pointer-events:none`.
 */
export class CookGauge {
  readonly root: HTMLElement;
  private fill: SVGPathElement;
  private label: HTMLElement;
  private tag: HTMLElement;
  private lastT = -1;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'cook', parent });
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);
    const d = arcPath();
    const track = document.createElementNS(svgNS, 'path');
    track.setAttribute('class', 'track'); track.setAttribute('d', d);
    this.fill = document.createElementNS(svgNS, 'path');
    this.fill.setAttribute('class', 'fill'); this.fill.setAttribute('d', d);
    this.fill.setAttribute('pathLength', '1');
    this.fill.style.strokeDasharray = '0 1';
    svg.appendChild(track); svg.appendChild(this.fill);
    this.root.appendChild(svg);
    const text = el('div', { cls: 'text', parent: this.root });
    this.label = el('div', { cls: 'lbl ui-mono', text: 'R 핀 제거', parent: text });
    this.tag = el('div', { cls: 'tag', text: '언더핸드', parent: text });
  }

  bind(ctx: GameContext): void {
    this.unsubs.push(
      ctx.bus.on('grenade:holdChanged', ({ holding, cooking, cooked, fuse, underhand }) => {
        toggleClass(this.root, 'show', holding);
        if (!holding) { this.setFill(0); return; }
        toggleClass(this.root, 'cooking', cooking);
        toggleClass(this.tag, 'show', underhand);
        const t = cooking ? Math.min(1, Math.max(0, cooked / GRENADE_COOK_MAX)) : 0;
        this.setFill(t);
        toggleClass(this.root, 'warm', cooking && t > WARM && t <= HOT);
        toggleClass(this.root, 'hot', cooking && t > HOT);
        setText(this.label, cooking ? `${Math.max(0, fuse).toFixed(1)} s` : 'R 핀 제거');
      }),
      ctx.bus.on('player:died', () => this.hide()),
      ctx.bus.on('player:downed', () => this.hide()),
      ctx.bus.on('game:newMission', () => this.hide()),
      ctx.bus.on('game:abort', () => this.hide()),
    );
  }

  private hide(): void {
    this.root.classList.remove('show', 'cooking', 'warm', 'hot');
    this.setFill(0);
  }

  private setFill(t: number): void {
    if (Math.abs(t - this.lastT) < 0.004) return;
    this.lastT = t;
    this.fill.style.strokeDasharray = `${t.toFixed(3)} 1`;
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
