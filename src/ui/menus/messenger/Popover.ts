import type { GameContext } from '@/shared';
import { el, setText } from '../../dom';

const ESCAPE_TOKEN = 'messenger:pop';

/**
 * The messenger's one small popover (2026-09-14) — create a room · invite a friend · rename. It floats absolutely inside the panel frame
 * (`.cp-frame`), one at a time. Escape closes only this one through `messenger:pop` on `ctx.escape` (above the panel), and so does a press on empty space in the frame.
 */
export class Popover {
  readonly root: HTMLElement;
  private title: HTMLElement;
  private body: HTMLElement;
  private ctx: GameContext | null = null;
  private _open = false;
  private readonly onDown = (e: MouseEvent): void => {
    if (!this._open) return;
    if (e.target instanceof Node && this.root.contains(e.target)) return;
    this.close();
  };

  constructor(private readonly frame: HTMLElement) {
    this.root = el('div', { cls: 'ms-pop', parent: frame });
    this.root.hidden = true;
    const head = el('div', { cls: 'ms-pop-head', parent: this.root });
    this.title = el('span', { cls: 'ms-pop-title', text: '', parent: head });
    const x = el('button', { cls: 'ms-pop-x', text: '×', parent: head });
    x.title = '닫기';
    x.addEventListener('click', (e) => { e.stopPropagation(); this.close(); });
    this.body = el('div', { cls: 'ms-pop-body', parent: this.root });
    this.root.addEventListener('mousedown', (e) => e.stopPropagation());
    this.root.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    frame.addEventListener('mousedown', this.onDown);
  }

  bind(ctx: GameContext): void { this.ctx = ctx; }

  get isOpen(): boolean { return this._open; }
  /** The kind of the popover open right now (`data-kind`, debug · smoke). */
  get kind(): string | null { return this._open ? this.root.dataset.kind ?? null : null; }

  /** `kind` is the smoke · CSS marker. `build` fills the body. */
  open(kind: string, title: string, build: (body: HTMLElement) => void): void {
    this.close();
    this.root.dataset.kind = kind;
    setText(this.title, title);
    this.body.replaceChildren();
    build(this.body);
    this.root.hidden = false;
    this._open = true;
    this.ctx?.escape.push(ESCAPE_TOKEN, () => this.close());
  }

  close(): void {
    if (!this._open) return;
    this._open = false;
    this.root.hidden = true;
    this.body.replaceChildren();
    this.ctx?.escape.remove(ESCAPE_TOKEN);
  }

  dispose(): void {
    this.close();
    this.frame.removeEventListener('mousedown', this.onDown);
    this.root.remove();
  }
}
