import type { ItemDef } from './types';
import { CATEGORY_ICON, RARITY_COLORS } from './labels';

/* ────────────────────────────────────────────────────────────────────────────
 * 재료 요구 칩 (Phase 8, 2026-09-06). One shared renderer for "this costs N of that" everywhere a cost is shown:
 * 가구 제작 / 시설 업그레이드 / 필드 · 작업대 제작 / 수리 / 퀘스트 납품 / 재배 씨앗.
 *
 * Before Phase 8 every folder printed its own `"폐금속 3/8"` text run. This module is the single place that turns a
 * cost line into the **thumbnail + 보유/필요 count** the design asks for, so housing/, inventory/, meta/ and ui/ all
 * render an identical chip without importing each other. It is deliberately the only DOM in `src/shared` (like
 * `labels.ts` is the only palette): it takes plain data, touches no context, and registers no listeners.
 *
 * Markup (styled by `.item-chip*` in `src/ui/styles/base.css`):
 *
 *   button|div.item-chip[.is-short][.is-free]      ← `--rc` = rarity colour, `--ic` = category colour
 *     div.item-chip-thumb  > span.item-chip-icon   ← ItemDef.icon glyph, tinted with ItemDef.color
 *     div.item-chip-count  > span.have + '/' + span.need
 *     div.item-chip-name                            (only when `withName`)
 *
 * `is-short` (보유 < 필요) dims the whole chip and turns the 보유 number red — the "부족하면 딤드" rule.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface ItemChipOptions {
  /** Units the player owns. Omit for a plain "×N" chip with no have/need split. */
  have?: number;
  /** Units required. Omit (with `have`) to render a pure inventory count. */
  need?: number;
  /** Show the item name under the thumbnail (catalogue cards); off for inline cost rows. */
  withName?: boolean;
  /** Thumbnail edge in px. Default 34 (inline cost row); furniture cards use 28. */
  size?: number;
  /** Render as a `<button>` instead of a `<div>` (clickable seed / material pickers). */
  button?: boolean;
  /** Tooltip; defaults to the item name plus its description. */
  title?: string;
}

/** Fallback used when a def id no longer resolves (a removed item still referenced by a save). */
const UNKNOWN: Pick<ItemDef, 'name' | 'icon' | 'color' | 'category' | 'rarity'> = {
  name: '알 수 없는 아이템', icon: '?', color: '#7b828c', category: 'material', rarity: 'common',
};

/**
 * Build one cost / inventory chip. `def` may be undefined — the chip then shows a neutral placeholder rather than
 * throwing, so a stale recipe never breaks a whole panel.
 */
export function buildItemChip(def: ItemDef | undefined, opts: ItemChipOptions = {}): HTMLElement {
  const d = def ?? UNKNOWN;
  const size = opts.size ?? 34;
  const el = document.createElement(opts.button ? 'button' : 'div');
  el.className = 'item-chip';
  if (opts.button) (el as HTMLButtonElement).type = 'button';
  el.style.setProperty('--chip-size', `${size}px`);
  el.style.setProperty('--rc', RARITY_COLORS[d.rarity] ?? RARITY_COLORS.common);
  el.style.setProperty('--ic', d.color);
  el.title = opts.title ?? (def ? `${def.name}\n${def.description}` : d.name);

  const thumb = document.createElement('div');
  thumb.className = 'item-chip-thumb';
  const icon = document.createElement('span');
  icon.className = 'item-chip-icon';
  icon.textContent = d.icon || CATEGORY_ICON[d.category] || '?';
  thumb.appendChild(icon);

  const need = opts.need;
  const have = opts.have;
  if (need !== undefined || have !== undefined) {
    const count = document.createElement('div');
    count.className = 'item-chip-count';
    if (need !== undefined && have !== undefined) {
      const h = document.createElement('span');
      h.className = 'item-chip-have';
      h.textContent = String(Math.max(0, Math.floor(have)));
      const sep = document.createElement('span');
      sep.className = 'item-chip-sep';
      sep.textContent = '/';
      const n = document.createElement('span');
      n.className = 'item-chip-need';
      n.textContent = String(Math.max(0, Math.floor(need)));
      count.append(h, sep, n);
      if (have < need) el.classList.add('is-short');
    } else {
      const only = document.createElement('span');
      only.className = 'item-chip-have';
      only.textContent = `×${Math.max(0, Math.floor(need ?? have ?? 0))}`;
      count.appendChild(only);
    }
    thumb.appendChild(count);
  }
  el.appendChild(thumb);

  if (opts.withName) {
    const name = document.createElement('div');
    name.className = 'item-chip-name';
    name.textContent = d.name;
    el.appendChild(name);
  }
  return el;
}

/** One ingredient as the cost renderers take it. */
export interface ItemChipCost {
  defId: string;
  qty: number;
}

/**
 * Replace `host`'s children with one chip per ingredient. `lookup` resolves a def id (usually
 * `ctx.loot.getItemDef`), `owned` reports how many the player has (bag + stash). An empty cost renders 무료.
 * Returns true when every ingredient is covered, so callers can gate their button in the same pass.
 */
export function renderItemCost(
  host: HTMLElement,
  cost: readonly ItemChipCost[] | null | undefined,
  lookup: (defId: string) => ItemDef | undefined,
  owned: (defId: string) => number,
  opts: Omit<ItemChipOptions, 'have' | 'need'> = {},
): boolean {
  host.replaceChildren();
  host.classList.add('item-chips');
  if (!cost || cost.length === 0) {
    const free = document.createElement('span');
    free.className = 'item-chip-free';
    free.textContent = '무료';
    host.appendChild(free);
    return true;
  }
  let ok = true;
  for (const c of cost) {
    const have = owned(c.defId);
    if (have < c.qty) ok = false;
    host.appendChild(buildItemChip(lookup(c.defId), { ...opts, have, need: c.qty }));
  }
  return ok;
}
