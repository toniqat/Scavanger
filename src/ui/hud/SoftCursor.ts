import type { GameContext } from '@/shared';
import { SOFT_CURSOR_SIZE } from '@/shared';
import { el } from '../dom';

/** class put on `<body>` while the sprite is drawn, so the real OS cursor never shows next to it. */
const BODY_CLASS = 'soft-cursor-on';

/**
 * Software cursor sprite (`.soft-cursor`, Phase 10).
 *
 * `shared/cursor.ts` owns the *behaviour*: while a UI surface is in cursor mode the pointer lock is kept, the virtual
 * position is driven by the raw `movementX/Y` deltas and the DOM pointer/mouse events are synthesised there. This
 * component is only the **picture** — a procedural SVG arrow that follows `ctx.input.cursorX / cursorY`.
 *
 * Like `hud/ItemTip` it is a **direct child of `ctx.uiRoot`** rather than a `.hud.*` layer, so it draws over the
 * inventory window, the 함선 관리 screen, the tactical map and every menu; it is `pointer-events: none` (it must never
 * be the element under itself) and carries the top `z-index`. `body.soft-cursor-on` hides the native cursor for as
 * long as the sprite is up — without the pointer lock (Chrome always drops it on Escape, and the headless smokes stub
 * `requestPointerLock` away) `SoftCursor.mirror` tracks the real cursor instead of synthesising, and hiding the native
 * arrow is what keeps that from reading as two cursors.
 *
 * Position is written on the `translate:` channel (never `transform`, and never `left/top`) so a move costs no layout.
 *
 * 2026-09-07: the sprite follows `SoftCursor.onMove` — the input event itself — rather than waiting for the next
 * `HudSystem.update`. A game frame plus the composer's render sat between the mouse and the drawn arrow, which is
 * what made the in-game cursor feel a step behind the Windows one. `update()` is kept as a per-frame safety net.
 */
export class SoftCursor {
  readonly root: HTMLElement;
  private active = false;
  private lastX = NaN;
  private lastY = NaN;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'soft-cursor', parent });
    this.root.hidden = true;
    this.root.style.width = `${SOFT_CURSOR_SIZE}px`;
    this.root.style.height = `${SOFT_CURSOR_SIZE}px`;
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    // Classic arrow, hotspot at (0,0) = the element's top-left corner. Outline first, then the light fill.
    const arrow = 'M2 1.6 L2 19.4 L7.1 14.7 L10.1 21.6 L13.4 20.1 L10.4 13.4 L17.3 12.7 Z';
    const outline = document.createElementNS(svgNS, 'path');
    outline.setAttribute('class', 'edge');
    outline.setAttribute('d', arrow);
    const body = document.createElementNS(svgNS, 'path');
    body.setAttribute('class', 'body');
    body.setAttribute('d', arrow);
    svg.appendChild(outline); svg.appendChild(body);
    this.root.appendChild(svg);
  }

  bind(ctx: GameContext): void {
    this.unsubs.push(
      ctx.bus.on('input:cursorModeChanged', ({ active }) => this.setActive(active)),
    );
    // Draw on the input event, not on the game frame (see the class comment).
    ctx.input.cursor.onMove((x, y) => this.draw(x, y));
    this.unsubs.push(() => ctx.input.cursor.onMove(null));
    // Seed from the live state (a surface may already be in cursor mode when the HUD rebinds).
    this.setActive(ctx.input.isCursorMode);
  }

  /** Per-frame safety net (a position set outside `SoftCursor`, or a listener lost on a HUD rebuild). */
  update(ctx: GameContext): void {
    if (!this.active) return;
    this.draw(ctx.input.cursorX, ctx.input.cursorY);
  }

  private draw(cx: number, cy: number): void {
    if (!this.active) return;
    const x = Math.round(cx), y = Math.round(cy);
    if (x === this.lastX && y === this.lastY) return;
    this.lastX = x; this.lastY = y;
    this.root.style.translate = `${x}px ${y}px`;
  }

  /** Whether the sprite is drawn (debug / smoke). */
  get isShowing(): boolean { return this.active; }

  private setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    this.root.hidden = !on;
    this.lastX = NaN; this.lastY = NaN;
    document.body.classList.toggle(BODY_CLASS, on);
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    document.body.classList.remove(BODY_CLASS);
    this.root.remove();
  }
}
