import { clear, el, setText, toggleClass } from './dom';

export interface TipRow {
  k: string;
  v: string;
  tone?: 'good' | 'bad';
}

export interface TipSpec {
  name: string;
  sub?: string;
  /** Frame / name colour (`--rc`) — e.g. the soil's tag colour. */
  color?: string;
  rows: readonly TipRow[];
  /** Hint lines at the bottom (`\n` keeps line breaks). */
  foot?: string;
}

const OFFSET = 16;
const MARGIN = 8;

/**
 * **The furniture-screen hover card** (2026-09-12) — the tooltip of a cell that is not an item, like the pot · the
 * culture tube. `ui/hud/ItemTip` draws only item · currency cards and lives in another folder, so it cannot be
 * imported; the same `.item-tip` look is borrowed and drawn here.
 *
 * Performance contract (drag lag on the grow screen): `pointermove` **only records the coordinates** and one
 * `transform` is written per rAF. The size is measured only when the content changes (`show` · `update`) —
 * `offsetWidth` is not read on every move.
 */
export class StationTip {
  readonly el: HTMLElement;
  private readonly nameEl: HTMLElement;
  private readonly subEl: HTMLElement;
  private readonly rowsEl: HTMLElement;
  private readonly footEl: HTMLElement;
  private shown = false;
  private w = 0;
  private h = 0;
  private x = 0;
  private y = 0;
  private raf = 0;

  constructor(parent: HTMLElement) {
    this.el = el('div', { cls: 'item-tip hs-tip', parent });
    this.el.hidden = true;
    const head = el('div', { cls: 'itip-head', parent: this.el });
    this.nameEl = el('div', { cls: 'itip-name', text: '', parent: head });
    this.subEl = el('div', { cls: 'itip-sub', text: '', parent: head });
    this.rowsEl = el('div', { cls: 'hs-tip-rows', parent: this.el });
    this.footEl = el('div', { cls: 'hs-tip-foot', text: '', parent: this.el });
  }

  get isShown(): boolean { return this.shown; }

  show(spec: TipSpec, x: number, y: number): void {
    this.render(spec);
    this.el.hidden = false;
    this.shown = true;
    this.x = x; this.y = y;
    this.measure();
    this.place();
  }

  /** Re-render the content of a shown card (the 1-second tick). */
  update(spec: TipSpec): void {
    if (!this.shown) return;
    this.render(spec);
    this.measure();
    this.place();
  }

  move(x: number, y: number): void {
    this.x = x; this.y = y;
    if (!this.shown || this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.place(); });
  }

  hide(): void {
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
    if (!this.shown) return;
    this.shown = false;
    this.el.hidden = true;
  }

  private render(spec: TipSpec): void {
    setText(this.nameEl, spec.name);
    setText(this.subEl, spec.sub ?? '');
    this.subEl.hidden = !spec.sub;
    if (spec.color) this.el.style.setProperty('--rc', spec.color);
    else this.el.style.removeProperty('--rc');
    clear(this.rowsEl);
    for (const r of spec.rows) {
      el('span', { cls: 'k', text: r.k, parent: this.rowsEl });
      const v = el('span', { cls: 'v', text: r.v, parent: this.rowsEl });
      toggleClass(v, 'good', r.tone === 'good');
      toggleClass(v, 'bad', r.tone === 'bad');
    }
    this.rowsEl.hidden = spec.rows.length === 0;
    setText(this.footEl, spec.foot ?? '');
    this.footEl.hidden = !spec.foot;
  }

  private measure(): void {
    this.w = this.el.offsetWidth;
    this.h = this.el.offsetHeight;
  }

  private place(): void {
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = this.x + OFFSET;
    if (left + this.w > vw - MARGIN) left = this.x - OFFSET - this.w;
    let top = this.y + OFFSET;
    if (top + this.h > vh - MARGIN) top = vh - MARGIN - this.h;
    this.el.style.transform = `translate(${Math.round(Math.max(MARGIN, left))}px, ${Math.round(Math.max(MARGIN, top))}px)`;
  }
}
