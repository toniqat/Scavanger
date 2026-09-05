/** Minimal DOM helpers for the hub UI (the ui/ folder's helpers are internal to that folder). */
export interface ElOptions { cls?: string; text?: string; parent?: HTMLElement; attrs?: Record<string, string> }

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, o: ElOptions = {}): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (o.cls) e.className = o.cls;
  if (o.text !== undefined) e.textContent = o.text;
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

/** Blank → null (random), digits → uint32, anything else → FNV-1a hash. */
export function parseSeed(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s) >>> 0;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

export function randomSeed(): number {
  return (Math.random() * 0xffffffff) >>> 0;
}

/** Keep game keys (WASD / Esc / Tab) from reaching Input while typing; Escape blurs the field and calls `onEscape`. */
export function isolateInput(input: HTMLInputElement, onEscape?: () => void): void {
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.code === 'Escape') { e.preventDefault(); input.blur(); onEscape?.(); }
  });
  input.addEventListener('keyup', (e) => e.stopPropagation());
}
