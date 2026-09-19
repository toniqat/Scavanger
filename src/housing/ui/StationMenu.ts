import type { PanelOverlay } from './Panel';
import { clear, el } from './dom';

export interface StationMenuItem {
  label: string;
  /** Red — something irreversible (the crop is thrown away). */
  danger?: boolean;
  run(): void;
}

/**
 * **The right-click menu** (2026-09-12) — the pot's · the culture tube's 「흙 비우기」 · 「배지 비우기」. It took the
 * place of the buttons under the cell.
 *
 * Exactly the innermost-popup contract: Escape is swallowed and closes it in its own capture handler (so `Input` never
 * even records it), and a press outside or a wheel turn closes it. E · Tab are closed first by the panel through
 * `PanelOverlay`.
 */
export class StationMenu implements PanelOverlay {
  readonly el: HTMLElement;
  private open = false;

  private readonly onDown = (e: PointerEvent): void => {
    if (!this.el.contains(e.target as Node | null)) this.close();
  };

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.code !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.close();
  };

  private readonly onWheel = (): void => this.close();

  constructor(parent: HTMLElement) {
    this.el = el('div', { cls: 'hs-ctx', parent });
    this.el.hidden = true;
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get isOpen(): boolean { return this.open; }

  show(x: number, y: number, items: readonly StationMenuItem[]): void {
    if (this.open) this.close();
    if (!items.length) return;
    clear(this.el);
    for (const it of items) {
      const b = el('button', { cls: `hs-ctx-item${it.danger ? ' danger' : ''}`, text: it.label, parent: this.el });
      b.type = 'button';
      b.addEventListener('click', (e) => { e.stopPropagation(); this.close(); it.run(); });
    }
    this.el.hidden = false;
    this.open = true;
    const w = this.el.offsetWidth, h = this.el.offsetHeight;          // once per open — not a hot path
    const left = Math.max(8, Math.min(x, window.innerWidth - w - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - h - 8));
    this.el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    window.addEventListener('pointerdown', this.onDown, true);
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('wheel', this.onWheel, true);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.el.hidden = true;
    window.removeEventListener('pointerdown', this.onDown, true);
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('wheel', this.onWheel, true);
  }
}
