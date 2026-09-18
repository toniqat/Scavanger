import type { GameContext } from '@/shared';
import { el, toggleClass } from '../dom';

const SIZE = 56;
const RADIUS = 22;

/**
 * The cursor hold ring (`.cursor-hold`, 2026-09-12, user's decision) — a radial gauge that fills around the cursor **while LMB is held**
 * on a placed piece of furniture in ship management. When it is full, hub/'s `HousingMode` picks that furniture up to move it.
 *
 * It is the one consumer of `housing:moveHold {progress}` (owner: hub). `progress` 0 … 1 arrives every frame while held, and
 * `null` means it ended (released · the cursor left the furniture · it reached 1 and went into the move state). The position is not
 * on the event: `ctx.input.uiX / uiY` (client coordinates — exactly what ship management's raycast uses) is read on each arrival.
 *
 * It is the same grain as the crosshair hold ring (`hud/HoldGauge`) — one full-circle SVG filled with `stroke-dasharray`, with the `svg` turned −90°
 * so it starts at 12 o'clock. Only the size is small, to match the cursor. It lives in the same `.hud.housing` layer as the ship
 * management screen (that layer is always mounted in the ship). It comes down on a game start · abort.
 */
export class CursorHoldGauge {
  readonly root: HTMLElement;
  private fill: SVGCircleElement;
  private circumference: number;
  private lastT = -1;
  private shown = false;
  private ctx: GameContext | null = null;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'cursor-hold', parent });
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
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    const b = ctx.bus;
    this.unsubs.push(
      b.on('housing:moveHold', ({ progress }) => this.set(progress)),
      // 2026-09-14: the shared cursor hold (right now, inventory tooltip pinning) — the carried position when there is one, otherwise `uiX/uiY`
      b.on('ui:cursorHold', ({ progress, x, y }) => this.set(progress, x, y)),
      b.on('housing:shipManageChanged', ({ active }) => { if (!active) this.set(null); }),
      b.on('game:newMission', () => this.set(null)),
      b.on('game:abort', () => this.set(null)),
    );
  }

  /** Whether the ring is up (debug / smoke). */
  get isShowing(): boolean { return this.shown; }
  /** Fill fraction 0..1 while showing, else −1 (debug / smoke). */
  get progress(): number { return this.shown ? this.lastT : -1; }

  private set(progress: number | null, x?: number, y?: number): void {
    const show = progress !== null;
    if (show !== this.shown) { this.shown = show; toggleClass(this.root, 'show', show); }
    if (!show) { this.setFill(0); return; }
    const input = this.ctx?.input;
    if (Number.isFinite(x) && Number.isFinite(y)) this.root.style.transform = `translate(${(x as number).toFixed(1)}px, ${(y as number).toFixed(1)}px)`;
    else if (input) this.root.style.transform = `translate(${input.uiX.toFixed(1)}px, ${input.uiY.toFixed(1)}px)`;
    this.setFill(Math.max(0, Math.min(1, progress)));
  }

  private setFill(t: number): void {
    if (Math.abs(t - this.lastT) < 0.003) return;
    this.lastT = t;
    this.fill.style.strokeDasharray = `${(t * this.circumference).toFixed(2)} ${this.circumference.toFixed(2)}`;
  }

  dispose(): void { for (const u of this.unsubs) u(); this.unsubs = []; this.root.remove(); }
}
