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

/**
 * Facility / room-purpose thumbnail (`.hs-thumb`, Phase 9 UI pass): a `--pc`-tinted frame carrying the shared glyph
 * from `ROOM_PURPOSE_GLYPH` / `FACILITY_GLYPH`. Every facility row in the game uses it, so the same room reads the
 * same in the 함선 tab, in the 시설 관리 room list and in its 용도 지정 picker. Procedural — no asset files.
 */
export function facilityThumb(parent: HTMLElement, glyph: string, color: string): HTMLElement {
  const t = el('div', { cls: 'hs-thumb', parent });
  t.style.setProperty('--pc', color);
  el('span', { cls: 'g', text: glyph, parent: t });
  return t;
}

export function levelText(level: number, max: number): string {
  return `Lv.${level} / ${max}`;
}

/**
 * 2026-09-12: the station screens' countdown is `HH:MM:SS` (hours are not capped at 24 and keep at least two digits).
 * Rounded **up** so `00:00:00` only ever shows once the timer is really done.
 */
export function clockParts(seconds: number): { hm: string; ss: string } {
  const s = Math.max(0, Math.ceil(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = (n: number): string => String(n).padStart(2, '0');
  return { hm: `${p(h)}:${p(m)}`, ss: `:${p(sec)}` };
}

/** `HH:MM:SS` as one string (tooltips). */
export function clockText(seconds: number): string {
  const { hm, ss } = clockParts(seconds);
  return `${hm}${ss}`;
}

/**
 * Countdown into `host` as `<span.hs-clock-hm>HH:MM</span><span.hs-clock-ss>:SS</span>` — the CSS draws `:SS` at
 * **half** the `HH:MM` size. The two spans are reused, so the 1-second tick only rewrites text nodes.
 */
export function renderClock(host: HTMLElement, seconds: number): void {
  let hm = host.firstElementChild as HTMLElement | null;
  if (host.childNodes.length !== 2 || !hm || !hm.classList.contains('hs-clock-hm')) {
    clear(host);
    hm = el('span', { cls: 'hs-clock-hm', parent: host });
    el('span', { cls: 'hs-clock-ss', parent: host });
  }
  const parts = clockParts(seconds);
  setText(hm, parts.hm);
  setText(host.lastElementChild as HTMLElement, parts.ss);
}

/** Plain text in a clock slot instead (`수확 가능` · `해석 완료` · empty). */
export function renderClockText(host: HTMLElement, text: string): void {
  if (host.firstElementChild || host.textContent !== text) host.textContent = text;
}

/** Compact 한국어 countdown for a growing plot: `2시간 5분`, `12분 30초`, `45초`. */
export function formatRemaining(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return m > 0 ? `${h}시간 ${m}분` : `${h}시간`;
  if (m > 0) return `${m}분 ${sec}초`;
  return `${sec}초`;
}
