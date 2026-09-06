import type { CraftIngredient, ItemDef } from '@/shared';
import { renderItemCost } from '@/shared';

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

/** Labelled section block (`.hs-section` + a rule) shared by the panels and the embedded 함선 view. */
export function section(parent: HTMLElement, label: string): HTMLElement {
  const s = el('div', { cls: 'hs-section', parent });
  el('div', { cls: 'ui-label', text: label, parent: s });
  return s;
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

/** What the cost renderer needs from the system: an item def per id and how many the player owns (bag + stash). */
export interface CostSource {
  defOf(defId: string): ItemDef | undefined;
  countDef(defId: string): number;
}

/** Thumbnail size (px) of an inline cost chip; furniture / catalogue cards use the smaller one. */
export const CHIP_SIZE = 32;
export const CHIP_SIZE_SMALL = 28;

/**
 * Cost line as **item chips** (Phase 8): thumbnail + 보유/필요 in the bottom-right corner, dimmed with a red 보유
 * number when the player is short. `renderItemCost` from `@/shared` is the single implementation — housing/ only
 * supplies the def lookup and the owned counts. Returns true when every ingredient is covered.
 */
export function renderCost(parent: HTMLElement, cost: readonly CraftIngredient[] | null | undefined, src: CostSource, size = CHIP_SIZE): boolean {
  return renderItemCost(parent, cost, src.defOf, src.countDef, { size });
}

export function levelText(level: number, max: number): string {
  return `Lv.${level} / ${max}`;
}

/** Compact 한국어 countdown for a growing plot: `2시간 5분`, `12분 30초`, `45초`. */
export function formatRemaining(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return m > 0 ? `${h}시간 ${m}분` : `${h}시간`;
  if (m > 0) return `${m}분 ${sec}초`;
  return `${sec}초`;
}
