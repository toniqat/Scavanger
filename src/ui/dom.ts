/** Tiny DOM helpers shared by HUD components and menus. */

export interface ElOptions {
  cls?: string;
  text?: string;
  html?: string;
  attrs?: Record<string, string>;
  parent?: HTMLElement;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, opts: ElOptions = {}): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (opts.cls) e.className = opts.cls;
  if (opts.text !== undefined) e.textContent = opts.text;
  if (opts.html !== undefined) e.innerHTML = opts.html;
  if (opts.attrs) for (const k in opts.attrs) e.setAttribute(k, opts.attrs[k]);
  if (opts.parent) opts.parent.appendChild(e);
  return e;
}

/** Sets textContent only when it actually changed (avoids layout thrash). */
export function setText(e: HTMLElement, text: string): void {
  if (e.textContent !== text) e.textContent = text;
}

export function toggleClass(e: HTMLElement, cls: string, on: boolean): void {
  if (e.classList.contains(cls) !== on) e.classList.toggle(cls, on);
}

export function setVisible(e: HTMLElement, visible: boolean, hiddenClass = 'hidden'): void {
  toggleClass(e, hiddenClass, !visible);
}

/** MM:SS */
export function fmtTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m.toString().padStart(2, '0')}:${r.toString().padStart(2, '0')}`;
}

/** 1234 → "1,234" */
export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('ko-KR');
}

export function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
export function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
/** Frame-rate independent exponential approach. */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

export function rarityColor(rarity: string): string {
  switch (rarity) {
    case 'uncommon': return 'var(--r-uncommon)';
    case 'rare': return 'var(--r-rare)';
    case 'epic': return 'var(--r-epic)';
    case 'legendary': return 'var(--r-legendary)';
    default: return 'var(--r-common)';
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
