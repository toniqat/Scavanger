import type { GameContext } from '@/shared';
import { el, setText, toggleClass } from './dom';

/**
 * Bottom-centre hub status line: `탑승 대기 중 (n/m)`, the launch countdown digits, rejoin hint, docking text.
 * Pure display, `pointer-events: none`, never takes a blocker token.
 */
export class HubStatus {
  private root: HTMLElement;
  private main: HTMLElement;
  private sub: HTMLElement;
  private bar: HTMLElement;
  private barFill: HTMLElement;

  constructor(ctx: GameContext) {
    this.root = el('div', { cls: 'hub-status', parent: ctx.uiRoot });
    this.root.hidden = true;
    this.main = el('div', { cls: 'main', parent: this.root });
    this.bar = el('div', { cls: 'bar', parent: this.root });
    this.barFill = el('i', { parent: this.bar });
    this.sub = el('div', { cls: 'sub', parent: this.root });
  }

  /** `main` null hides the whole line. `count` renders the big countdown digits. `progress` 0..1 fills the bar (null hides it). */
  set(main: string | null, sub: string | null = null, opts: { count?: boolean; progress?: number | null; keycap?: string } = {}): void {
    if (main === null) { this.root.hidden = true; return; }
    this.root.hidden = false;
    setText(this.main, main);
    toggleClass(this.main, 'count', !!opts.count);
    if (sub === null) { this.sub.hidden = true; }
    else {
      this.sub.hidden = false;
      const key = opts.keycap ? `<span class="keycap">${opts.keycap}</span> ` : '';
      const html = key + sub.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string));
      if (this.sub.innerHTML !== html) this.sub.innerHTML = html;
    }
    const p = opts.progress ?? null;
    this.bar.hidden = p === null;
    if (p !== null) this.barFill.style.transform = `scaleX(${Math.max(0, Math.min(1, p)).toFixed(3)})`;
  }

  hide(): void { this.root.hidden = true; }

  dispose(): void { this.root.remove(); }
}
