/** Minimal DOM helpers for the corp screen (other folders' helpers are internal to them). */
export interface ElOptions { cls?: string; text?: string; parent?: HTMLElement; attrs?: Record<string, string>; title?: string }

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, o: ElOptions = {}): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (o.cls) e.className = o.cls;
  if (o.text !== undefined) e.textContent = o.text;
  if (o.title) e.title = o.title;
  if (o.attrs) for (const k in o.attrs) e.setAttribute(k, o.attrs[k]);
  if (o.parent) o.parent.appendChild(e);
  return e;
}

export function setText(e: HTMLElement, text: string): void {
  if (e.textContent !== text) e.textContent = text;
}

export function toggleClass(e: HTMLElement, cls: string, on: boolean): void {
  if (e.classList.contains(cls) !== on) e.classList.toggle(cls, on);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Chevron glyph as inline SVG (2026-09-12) — `count` overlapping chevrons pointing `dir`. No asset: the trade desk's
 * flow arrows (구매 → 내 쪽 · 판매 → 기업 쪽) and the 거래 후 크레딧 up / down marks. Colour is `currentColor`; each
 * stroke carries `c0 … cN` so CSS can stagger a flow animation along the arrow.
 */
export function chevrons(dir: 'left' | 'right' | 'up' | 'down', count = 3, cls = ''): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = `cv-chev dir-${dir}${cls ? ` ${cls}` : ''}`;
  wrap.setAttribute('aria-hidden', 'true');
  const horizontal = dir === 'left' || dir === 'right';
  const pitch = 6;
  const long = 8 + (count - 1) * pitch;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', horizontal ? `0 0 ${long} 14` : `0 0 14 ${long}`);
  svg.setAttribute('width', String(horizontal ? long : 14));
  svg.setAttribute('height', String(horizontal ? 14 : long));
  for (let i = 0; i < count; i++) {
    const p = document.createElementNS(SVG_NS, 'polyline');
    // drawn pointing right / down; `dir-left` / `dir-up` mirror it in CSS so the stagger follows the arrow
    const o = 1.5 + i * pitch;
    p.setAttribute('points', horizontal ? `${o},2 ${o + 5},7 ${o},12` : `2,${o} 7,${o + 5} 12,${o}`);
    p.setAttribute('class', `c${i}`);
    svg.appendChild(p);
  }
  wrap.appendChild(svg);
  return wrap;
}

/** `12345` → `12,345`. ko-KR like every other number in the game (`shared/currency.groupDigits`, `ui/dom`). */
export function fmtNum(n: number): string {
  return Math.round(n).toLocaleString('ko-KR');
}
