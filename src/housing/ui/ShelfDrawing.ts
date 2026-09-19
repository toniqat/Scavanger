import type { ItemDef, ShelfMedium } from '@/shared';
import { SHELF_SLOTS, SHELF_TIERS, SHELF_TIER_COLS, itemGridBox, shelfSlotsPerTier } from '@/shared';
import { shelfHolderMediumOfItem } from '../Rules';
import { buildFootprintCells, cellToFit } from './ItemTile';
import { clear, el, setText, toggleClass } from './dom';

/**
 * **The drawn shelf** (2026-09-13) — the furniture drawing on the left card of the library holder screen. The bookshelf · disc stand · record rack ·
 * game disc stand share one skeleton and the medium changes the shape only (all drawn in CSS — no image file, `.lib-*` in `housing.css`).
 *
 * **2026-09-16 (user's decision — a cell is an item grid cell)**: the **dedicated drawing** once painted into a cell (book spine · disc case ·
 * record sleeve · game case = `.lib-deco` · `.lib-face` · `.lib-glyph` · `.lib-label`) is gone, and a filled cell now holds
 * **exactly the item tile seen in the bag** (`ui/ItemTile.buildStationItemTile`). No quantity number is drawn.
 * The furniture (frame · tier plate · divider · plinth) is unchanged — what changed is only 「what stands **inside** a cell」.
 * The tile is made by the `buildTile` handed to `paintShelfSlot` — this file still knows nothing of `ctx`.
 *
 * **2026-09-14 (several rows per tier, user's decision)**: the tier count `SHELF_TIERS` · a row's cell count `SHELF_TIER_COLS` · a tier's cell count
 * `shelfSlotsPerTier` all live in the contract (`shared/housing`) and this file just draws them — one tier (`.lib-tier`, a shelf plate thick at
 * the bottom) holds as many `.lib-row` as it needs, and one row is a `SHELF_TIER_COLS`-column grid. The column count reaches CSS as
 * `--lib-cols` on `.lib-case`.
 * ⚠ A tier is **display** only — what is saved is the one `slot` index, numbered from 0 without a break.
 *
 * **2026-09-15 (the divider · the cell number removed, user's decision)**:
 * - A cell's **number (`.lib-num`) is gone.** The drawing says where a thing goes, and the number is only a saved value anyway.
 * - A **divider stands in the middle** of a row. No new child is made: `.is-div` goes on the cell right of the middle and CSS raises a plate
 *   on that cell's left — `.lib-row`'s children are still **cells only**, so whatever counts columns (the smoke test · the CSS grid) is not shaken.
 *   The divider sits at `floor(cols / 2)`, and with a single column there is none.
 *
 * 2026-09-13 (library series): a filled cell carries a **volume badge** (`.lib-vol`, `II` — hidden for a one-shot), and once every volume of that series
 * is collected it is `.is-full` (a green outline).
 *
 * Cell numbers run **top → bottom, left → right**, the same order as the 3D model (`bookshelf` in `hub/interiors/Furniture`).
 * An empty cell is a dashed box, like an empty inventory cell. `.lib-slot[data-slot]` is the drop target (TradeGrids adds `.is-over`),
 * and the item card (`ui/hud/ItemTip`) comes from the tile carrying `data-item-tip`.
 * This file has no state and no listener — painting is `paintShelfSlot`, the rules are `parts/Library`.
 */

/**
 * How many cells one row draws. Since 2026-09-14 it differs per medium — the source of the value is the contract's `SHELF_TIER_COLS`.
 * @deprecated kept for whatever read the old fixed 2 (no caller).
 */
export const SHELF_COLS = 2;

/**
 * **One cell's box** (px) — the room one cell takes in the furniture drawing (since 2026-09-16 JS is the source and CSS receives it
 * through `--lib-item-w` / `--lib-item-h`: the item tile's cell size has to be derived from the same value, so it cannot live in two places).
 * The values are the ones CSS used up to 2026-09-15, and a medium's item footprint (book 1×2 · disc 2×2 · record 3×3 ·
 * game 1×2) fits whole inside this box — a layout constant.
 */
const SHELF_SLOT_BOX: Readonly<Record<ShelfMedium, { width: number; height: number }>> = {
  book: { width: 44, height: 86 },
  disc: { width: 58, height: 58 },
  record: { width: 70, height: 70 },
  game: { width: 46, height: 64 },
};

/** That medium's one-cell box (px) — the caller measures the tile cell size that fits it (`ui/ItemTile.cellToFit`). */
export function shelfSlotBox(medium: ShelfMedium): { width: number; height: number } {
  return SHELF_SLOT_BOX[medium] ?? SHELF_SLOT_BOX.book;
}

/**
 * **The footprint of the items that medium takes** (in cells) — 2026-09-17 (user's decision 「a cell's shape follows the size of the item it takes」).
 * The **largest width · height** among the item defs that belong to the medium (`shelfHolderMediumOfItem`): whatever is shelved fits whole in a cell.
 * The size written in the data is the source, so no 1×2 · 2×2 is written into the code. null with no def (boot order) — drawn as one cell box.
 */
export function shelfFootprint(defs: readonly ItemDef[] | null | undefined, medium: ShelfMedium): { w: number; h: number } | null {
  let w = 0, h = 0;
  for (const d of defs ?? []) {
    if (d.retired || shelfHolderMediumOfItem(d) !== medium) continue;
    w = Math.max(w, Math.floor(d.width ?? 1));
    h = Math.max(h, Math.floor(d.height ?? 1));
  }
  return w > 0 && h > 0 ? { w, h } : null;
}

export interface ShelfSlotView {
  readonly slot: number;
  /** `.lib-slot[data-slot]` — the drop target; `.is-filled` while something is shelved, `.is-full` while its series is complete. */
  readonly root: HTMLElement;
  /** `.lib-item` — the cell box: the item tile while filled, a dashed outline while empty. */
  readonly item: HTMLElement;
  /** `.lib-vol` — the volume badge (`II`), hidden for a one-shot or an empty slot. */
  readonly vol: HTMLElement;
}

export interface ShelfDrawing {
  readonly root: HTMLElement;
  readonly medium: ShelfMedium;
  readonly slots: readonly ShelfSlotView[];
  /** 2026-09-17: the cell's footprint (in cells) — an empty cell is drawn as this many grid cells. */
  readonly footprint: { w: number; h: number };
  /** 2026-09-17: the grid cell's edge (px) — a shelved tile is built at this cell size too (an empty and a filled cell are the same box). */
  readonly cell: number;
}

/** What one slot shows. `defId` null = empty (the other fields are ignored except `line`). */
export interface ShelfSlotPaint {
  defId: string | null;
  /** The slot's info line (shown under the shelf while the slot is hovered). 2026-09-14: **an empty cell is the empty string** — hovering one says nothing. */
  line: string;
  /** 2026-09-13: roman volume number (`II`) — empty / omitted hides the badge. */
  volume?: string;
  /** 2026-09-13: the series is complete (every volume shelved in a running holder). */
  full?: boolean;
}

/**
 * (Re)draw the case for `medium` into `host` (emptied first).
 * 2026-09-17: given a `footprint` (in cells, `shelfFootprint`) the cell box is **that footprint's grid box** — measured at the cell size
 * (`cellToFit`) that fits whole inside the medium's room (`SHELF_SLOT_BOX`). Without one, a single 1×1 cell fills the room.
 */
export function buildShelfDrawing(host: HTMLElement, medium: ShelfMedium, footprint?: { w: number; h: number } | null): ShelfDrawing {
  clear(host);
  const root = el('div', { cls: 'lib-case', attrs: { 'data-medium': medium }, parent: host });
  const count = SHELF_SLOTS[medium];
  const cols = Math.max(1, SHELF_TIER_COLS[medium]);
  const perTier = shelfSlotsPerTier(medium);
  const tiers = Math.max(1, SHELF_TIERS[medium]);
  const room = shelfSlotBox(medium);
  const fp = footprint ?? { w: 1, h: 1 };
  const cell = cellToFit(room.width, room.height, fp.w, fp.h);
  const box = itemGridBox(fp.w, fp.h, cell);
  root.style.setProperty('--lib-cols', String(cols));
  root.style.setProperty('--lib-item-w', `${box.width}px`);
  root.style.setProperty('--lib-item-h', `${box.height}px`);
  // 2026-09-15: the column the divider stands at (the plate rises on that cell's **left**). With a single column there is no divider.
  const divAt = cols >= 2 ? Math.floor(cols / 2) : -1;
  const slots: ShelfSlotView[] = [];
  for (let t = 0; t < tiers; t++) {
    const tier = el('div', { cls: 'lib-tier', parent: root });
    const rowsInTier = Math.max(1, Math.ceil(perTier / cols));
    for (let r = 0; r < rowsInTier; r++) {
      const row = el('div', { cls: 'lib-row', parent: tier });
      for (let c = 0; c < cols; c++) {
        const slot = t * perTier + r * cols + c;
        const div = c === divAt ? ' is-div' : '';
        // A void grid cell: past the cells the tier was given (the last tier is short) or past the total count — it keeps the room and is no drop target
        if (slot >= count || r * cols + c >= perTier) { el('div', { cls: `lib-slot is-void${div}`, parent: row }); continue; }
        const slotEl = el('div', { cls: `lib-slot${div}`, attrs: { 'data-slot': String(slot) }, parent: row });
        const item = el('div', { cls: 'lib-item', parent: slotEl });
        const vol = el('span', { cls: 'lib-vol', text: '', parent: slotEl });
        vol.hidden = true;
        slots.push({ slot, root: slotEl, item, vol });
      }
    }
  }
  el('div', { cls: 'lib-plinth', parent: root });
  return { root, medium, slots, footprint: fp, cell };
}

/**
 * Paint one slot — only what changed is written (a refresh per inventory event must stay cheap).
 * `buildTile` makes the inventory tile for a def id; it is only called when the slot's item **changed**
 * (`data-def-id` on the cell box is the memo), so a 1 Hz refresh never rebuilds a tile.
 */
export function paintShelfSlot(
  v: ShelfSlotView, p: ShelfSlotPaint, buildTile: (defId: string) => HTMLElement, empty?: { w: number; h: number; cell: number },
): void {
  const filled = p.defId !== null;
  toggleClass(v.root, 'is-filled', filled);
  toggleClass(v.root, 'is-full', filled && p.full === true);
  // 2026-09-17: an empty cell = as many grid cells as the footprint (only on a screen that passed `empty`). Once built it is never rebuilt.
  if (!filled && empty && v.item.dataset.defId === undefined && !v.item.firstChild) {
    v.item.appendChild(buildFootprintCells(empty.w, empty.h, empty.cell));
  }
  if (v.item.dataset.defId !== (p.defId ?? undefined)) {
    clear(v.item);
    if (filled) {
      // `data-item-tip` + `data-def-id` stay on the cell box as well (the tile brings its own, but 「a filled cell raises
      // the item card」 is this element's long-standing contract and the smoke test reads it here — `scripts/smoke-library.mjs`)
      v.item.dataset.itemTip = '';
      v.item.dataset.defId = p.defId!;
      v.item.appendChild(buildTile(p.defId!));
    } else {
      delete v.item.dataset.itemTip;
      delete v.item.dataset.defId;
      if (empty) v.item.appendChild(buildFootprintCells(empty.w, empty.h, empty.cell));
    }
  }
  const vol = filled ? p.volume ?? '' : '';
  setText(v.vol, vol);
  if (v.vol.hidden !== !vol) v.vol.hidden = !vol;
  if (v.root.dataset.line !== p.line) v.root.dataset.line = p.line;
}
