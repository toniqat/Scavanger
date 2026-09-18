import type { ItemDef } from './types';
import { CATEGORY_ICON, RARITY_COLORS } from './labels';

/* ────────────────────────────────────────────────────────────────────────────
 * The material cost chip (Phase 8, 2026-09-06). One shared renderer for "this costs N of that" everywhere a cost is shown:
 * furniture crafting / facility upgrades / field · workbench crafting / repairs / quest deliveries / growing seeds.
 *
 * Before Phase 8 every folder printed its own `"폐금속 3/8"` text run. This module is the single place that turns a
 * cost line into the **thumbnail + have/need count** the design asks for, so housing/, inventory/, meta/ and ui/ all
 * render an identical chip without importing each other. It is deliberately the only DOM in `src/shared` (like
 * `labels.ts` is the only palette): it takes plain data, touches no context, and registers no listeners.
 *
 * Markup (styled by `.item-chip*` in `src/ui/styles/base.css`):
 *
 *   button|div.item-chip[.is-short][.is-free]      ← `--rc` = rarity colour, `--ic` = category colour
 *                                                  ← `data-def-id` = the item def (ui/hud/ItemTip hovers off it)
 *     div.item-chip-thumb  > span.item-chip-icon   ← ItemDef.icon glyph, tinted with ItemDef.color
 *     div.item-chip-count  > span.have + '/' + span.need
 *     div.item-chip-name                            (only when `withName`)
 *
 * `is-short` (have < need) dims the whole chip and turns the have number red — the "dim when short" rule.
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
  // `data-def-id` is the hook the shared hover card (`ui/hud/ItemTip`) delegates on, so every chip everywhere gets
  // the same inventory-style item tooltip. A native `title` would race that card, so it is only written when a
  // caller explicitly asks for one (a chip whose def is unknown keeps the placeholder name as its title).
  if (def) el.dataset.defId = def.id;
  // 2026-09-12 (E2): the favorite mark — the source is registered by ui/ (`setItemChipFavoriteSource`), see the block at the end
  if (def && isItemChipFavorite(def.id)) el.classList.add(ITEM_CHIP_FAVORITE_CLASS);
  if (opts.title !== undefined) el.title = opts.title;
  else if (!def) el.title = d.name;

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

/* ══ appended: 2026-09-12 — the facility level requirement chip ═════════════════════════════════════════════════
 * A **facility level requirement** like 「발전기 Lv.2 가 필요하다」 is drawn on the same line next to the item chips (user's
 * decision). So that it is not mistaken for an item it has a **wide thumbnail + a double border**, and its numbers are
 * `the current level/the required level`, not a required count.
 *
 *   div.facility-chip[.is-short]                   ← `--fc` = the facility colour, `--chip-size` = the thumbnail height (the same value as the item chips)
 *     div.facility-chip-thumb                      ← twice as wide as it is high (CSS) · `border-style: double`
 *       span.facility-chip-icon                    ← the facility glyph (`FACILITY_GLYPH`)
 *       span.facility-chip-name                    ← the facility name (`FACILITY_LABEL_KO`)
 *       div.facility-chip-count > span.facility-chip-have + '/' + span.facility-chip-need
 *
 * The style is `.facility-chip*` in `src/ui/styles/base.css` (right below the item chip). This function does not import
 * the facility table — the caller hands over the name · the glyph · the colour (so `itemChip.ts` does not lean on `housing.ts`).
 */
export interface FacilityChipOptions {
  /** The thumbnail height in px — matched to the `size` of the item chips on the same line. Default 34. */
  size?: number;
  /** The native tooltip. Omitted, it is `이름 Lv.need 필요 (현재 Lv.have)`. */
  title?: string;
}

export function buildFacilityChip(
  name: string, glyph: string, color: string, have: number, need: number, opts: FacilityChipOptions = {},
): HTMLElement {
  const root = document.createElement('div');
  root.className = 'facility-chip';
  root.style.setProperty('--chip-size', `${opts.size ?? 34}px`);
  root.style.setProperty('--fc', color);
  const h = Math.max(0, Math.floor(have)), n = Math.max(0, Math.floor(need));
  if (h < n) root.classList.add('is-short');
  root.title = opts.title ?? `${name} Lv.${n} 필요 (현재 Lv.${h})`;

  const thumb = document.createElement('div');
  thumb.className = 'facility-chip-thumb';
  const icon = document.createElement('span');
  icon.className = 'facility-chip-icon';
  icon.textContent = glyph;
  const label = document.createElement('span');
  label.className = 'facility-chip-name';
  label.textContent = name;
  const count = document.createElement('div');
  count.className = 'facility-chip-count';
  const hs = document.createElement('span');
  hs.className = 'facility-chip-have';
  hs.textContent = String(h);
  const sep = document.createElement('span');
  sep.className = 'facility-chip-sep';
  sep.textContent = '/';
  const ns = document.createElement('span');
  ns.className = 'facility-chip-need';
  ns.textContent = String(n);
  count.append(hs, sep, ns);
  thumb.append(icon, label, count);
  root.appendChild(thumb);
  return root;
}

/* ══ appended: 2026-09-12 (E2) — the favorite mark · right-click menu opt-in ══════════════════════════════════════
 * An item favorite is **per kind (def id)** and the original is inventory (`InventoryRef.isFavorite` · `toggleFavorite` ·
 * `inventory:favoritesChanged`, E1). A chip does not know `ctx`, so there is one **module-level provider** — ui/'s
 * `hud/ItemFavoriteMenu` registers it at boot with `setItemChipFavoriteSource`, and `buildItemChip` asks it while
 * building a chip and adds `.is-favorite` (the style is the blue diagonal band in `ui/styles/base.css`). Chips already
 * drawn are fixed by the same menu, which takes `inventory:favoritesChanged` and changes only the class in the DOM —
 * no chip has to be built again.
 *
 * The right-click menu 「즐겨찾기 켜기 / 끄기」 is attached automatically to every `.item-chip[data-def-id]`. An element that
 * is not a chip (an inventory tile in a corporation shop and the like) opts in by putting **`ITEM_FAVORITE_MENU_ATTR`**
 * next to its `data-def-id` — the same convention by which `data-item-tip` opts into the hover card. If an inner element
 * calls `stopPropagation` in its own `contextmenu`, that element's menu wins.
 */

/** Class `buildItemChip` puts on a chip whose def is a favorite. */
export const ITEM_CHIP_FAVORITE_CLASS = 'is-favorite';
/** Attribute (value ignored) that opts a non-chip `[data-def-id]` element into the favorite right-click menu. */
export const ITEM_FAVORITE_MENU_ATTR = 'data-fav-menu';

/**
 * The favorite half of `InventoryRef` as a reader that may predate it sees it (every member optional). Folders that must
 * work before / without inventory's implementation cast `ctx.inventory` to this.
 */
export interface ItemFavoriteApi {
  isFavorite?(defId: string): boolean;
  toggleFavorite?(defId: string, on?: boolean): boolean;
  readonly favoriteDefIds?: readonly string[];
}

let favoriteSource: ((defId: string) => boolean) | null = null;

/** Register (or clear with null) who answers "is this def a favorite?" for every chip built from now on. */
export function setItemChipFavoriteSource(fn: ((defId: string) => boolean) | null): void {
  favoriteSource = fn;
}

/** The registered source's answer; false without a source or when it throws. */
export function isItemChipFavorite(defId: string): boolean {
  if (!favoriteSource) return false;
  try { return favoriteSource(defId) === true; } catch { return false; }
}

/* ══ appended: 2026-09-16 — a chip the size of the grid footprint ═══════════════════════════════════════════════
 * This exists to draw 「the same size as when it is dragged from the bag」 as a chip. The inventory grid draws an item as
 * `ItemDef.width × height` **cells** and the drag ghost comes up at exactly that box size
 * (`inventory/ui/labels.tileSizeAt`). The product drag of the furniture screen (`housing/ui/ProductDrag`) had until now
 * raised a single square chip, which read as 「the size is not kept while dragging」.
 *
 * The formula is one line and two folders use it together, so it lives here (§4.1 「the same formula in two folders moves
 * to shared」). `GAP` in `inventory/ui/labels.ts` is the same value — that one is the original that draws the grid, and
 * this one is for chips that must measure the same size **outside** that grid. Change one and change the other with it.
 * ────────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** px — between one grid cell and the next (the same value as `GAP` in `inventory/ui/labels.ts`). */
export const ITEM_GRID_GAP = 2;

/** px — the box a `w × h` cell footprint takes up (one cell's edge `cell`, the gap between cells `gap`). */
export function itemGridBox(w: number, h: number, cell: number, gap: number = ITEM_GRID_GAP): { width: number; height: number } {
  const cw = Math.max(1, Math.floor(w)), ch = Math.max(1, Math.floor(h));
  return { width: cw * (cell + gap) - gap, height: ch * (cell + gap) - gap };
}

export interface ItemGridChipOptions extends ItemChipOptions {
  /** One grid cell's edge (px) — the caller gives the value its own grid uses (`housing/ui/StationShell.stationGridCell`). */
  cell: number;
  gap?: number;
}

/**
 * A chip as big as **the item's footprint** rather than one grid cell. The look (border · glyph · count badge) is
 * `buildItemChip`'s as it is and only the thumbnail stretches to the `w × h` box — it is overridden inline without
 * touching CSS (including `.item-chip`'s `min/max-width`), so the chip markup contract stays. `itemGridBox` measures it.
 */
export function buildItemGridChip(def: ItemDef | undefined, opts: ItemGridChipOptions): HTMLElement {
  const { cell, gap, ...chip } = opts;
  const el = buildItemChip(def, { ...chip, size: cell });
  const box = itemGridBox(def?.width ?? 1, def?.height ?? 1, cell, gap);
  el.style.width = `${box.width}px`;
  el.style.minWidth = `${box.width}px`;
  el.style.maxWidth = `${box.width}px`;
  const thumb = el.querySelector<HTMLElement>('.item-chip-thumb');
  if (thumb) { thumb.style.width = `${box.width}px`; thumb.style.height = `${box.height}px`; }
  return el;
}
