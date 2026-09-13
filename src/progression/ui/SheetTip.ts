/**
 * 캐릭터 시트의 **능력치 · 숙련도 툴팁** (2026-09-13). 아이템이 아니라서 `ui/hud/ItemTip` 이 그리지 못하고 폴더끼리
 * import 하지 않으므로 여기서 그린다 (`housing/ui/StationTip` 과 같은 방식). 겉모습은 `.item-tip` 카드와 같지만 **자기 클래스(`.pg-tip*`,
 * `ui/character.css`)** 를 쓴다 — `.item-tip` 을 달면 HUD 아이템 카드를 찾는 쿼리가 먼저 붙은 이 카드를 집는다.
 * 네이티브 `title` 은 쓰지 않는다 — 인게임 커서 위에서는 뜨지 않거나 늦게 뜬다.
 *
 * 성능: `pointermove` 에서는 좌표만 적고 rAF 에 한 번 `transform` 을 쓴다. 크기는 내용을 바꿀 때만 잰다.
 */

export interface SheetTipRow { k: string; v: string; tone?: 'good' }
export interface SheetTipSection { title: string; rows: readonly SheetTipRow[] }
export interface SheetTipSpec {
  name: string;
  sub?: string;
  desc?: string;
  /** Accent lines under the description (지능: `모든 숙련 성장 +6%/pt`). */
  notes?: readonly string[];
  sections: readonly SheetTipSection[];
}

const OFFSET = 16;
const MARGIN = 8;

function mk<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent.appendChild(e);
  return e;
}

export class SheetTip {
  readonly el: HTMLElement;
  private readonly nameEl: HTMLElement;
  private readonly subEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private shown = false;
  private w = 0;
  private h = 0;
  private x = 0;
  private y = 0;
  private raf = 0;

  constructor(parent: HTMLElement) {
    // Own `.pg-tip` classes, NOT `.item-tip`: this card sits under `#ui-root` before the HUD's item card, and every
    // `.item-tip` query (ui/hud/ItemTip smokes) would pick this one up first.
    this.el = mk('div', 'pg-tip', parent);
    this.el.hidden = true;
    const head = mk('div', 'pg-tip-head', this.el);
    this.nameEl = mk('div', 'pg-tip-name', head);
    this.subEl = mk('div', 'pg-tip-sub', head);
    this.bodyEl = mk('div', 'pg-tip-body', this.el);
  }

  get isShown(): boolean { return this.shown; }

  show(spec: SheetTipSpec, x: number, y: number): void {
    this.render(spec);
    this.el.hidden = false;
    this.shown = true;
    this.x = x; this.y = y;
    this.w = this.el.offsetWidth;
    this.h = this.el.offsetHeight;
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

  dispose(): void {
    this.hide();
    this.el.remove();
  }

  private render(spec: SheetTipSpec): void {
    this.nameEl.textContent = spec.name;
    this.subEl.textContent = spec.sub ?? '';
    this.subEl.hidden = !spec.sub;
    const b = this.bodyEl;
    b.replaceChildren();
    if (spec.desc) mk('p', 'pg-tip-desc', b, spec.desc);
    for (const n of spec.notes ?? []) mk('div', 'pg-tip-note', b, n);
    for (const s of spec.sections) {
      if (s.rows.length === 0) continue;
      const sec = mk('div', 'pg-tip-sec', b);
      mk('div', 'pg-tip-h', sec, s.title);
      const rows = mk('div', 'pg-tip-rows', sec);
      for (const r of s.rows) {
        mk('span', 'k', rows, r.k);
        const v = mk('span', 'v', rows, r.v);
        if (r.tone === 'good') v.classList.add('good');
      }
    }
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
