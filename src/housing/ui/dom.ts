import type { CraftIngredient } from '@/shared';
import type { CountFn, NameFn } from '../Rules';

/** Minimal DOM helpers for the housing panels (other folders' helpers are internal to them). */
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

export function clear(e: HTMLElement): void {
  while (e.firstChild) e.removeChild(e.firstChild);
}

/** Keep game keys (WASD / Esc / Tab) from reaching Input while typing; Escape blurs the field and calls `onEscape`. */
export function isolateInput(input: HTMLInputElement, onEscape?: () => void): void {
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.code === 'Escape') { e.preventDefault(); input.blur(); onEscape?.(); }
  });
  input.addEventListener('keyup', (e) => e.stopPropagation());
}

/**
 * Cost line: one `.mat` span per ingredient, `.short` (red) when the player owns fewer than needed.
 * `have n / need m` is shown as `이름 have/need`.
 */
export function renderCost(parent: HTMLElement, cost: readonly CraftIngredient[], count: CountFn, nameOf: NameFn): boolean {
  clear(parent);
  let ok = true;
  if (!cost.length) { el('span', { cls: 'mat free', text: '무료', parent }); return true; }
  for (const c of cost) {
    const have = count(c.defId);
    const short = have < c.qty;
    if (short) ok = false;
    el('span', { cls: `mat${short ? ' short' : ''}`, text: `${nameOf(c.defId)} ${Math.min(have, c.qty)}/${c.qty}`, parent });
  }
  return ok;
}

export function levelText(level: number, max: number): string {
  return `Lv.${level} / ${max}`;
}
