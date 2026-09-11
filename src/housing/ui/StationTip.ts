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
 * **가구 화면 호버 카드** (2026-09-12) — 흙구멍 · 배양관처럼 아이템이 아닌 칸의 툴팁. `ui/hud/ItemTip` 은 아이템
 * · 재화 카드만 그리고 다른 폴더라 import 할 수 없으므로, 같은 `.item-tip` 겉모습을 빌려 여기서 그린다.
 *
 * 성능 규약 (재배 화면 드래그 렉): `pointermove` 에서는 **좌표만 적고** rAF 에 한 번 `transform` 을 쓴다.
 * 크기는 내용을 바꿀 때(`show` · `update`)만 잰다 — 움직일 때마다 `offsetWidth` 를 읽지 않는다.
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
    const head = el('div', { cls: 'it-head', parent: this.el });
    this.nameEl = el('div', { cls: 'it-name', text: '', parent: head });
    this.subEl = el('div', { cls: 'it-sub', text: '', parent: head });
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
