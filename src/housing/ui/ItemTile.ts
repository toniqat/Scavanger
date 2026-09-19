import type { GameContext } from '@/shared';
import { ITEM_GRID_GAP, buildItemGridChip, itemGridBox } from '@/shared';

/**
 * **The item cell of a furniture screen** (2026-09-16, user's decision 「turn the compute cluster's · the display
 * stand's cells into item grids」).
 *
 * What is slotted in is **exactly the tile seen in the bag**: the drawing is the inventory's one
 * `InventoryRef.buildItemTile` (§4.1 「the same markup is not kept in two folders」) and only the size is decided here.
 * This is where a dedicated drawing (core chip · book spine · disc case) used to be drawn by hand — when the same item
 * looks different from the bag, what is slotted in has to be learned twice.
 *
 * **The quantity number is not drawn** (user's decision): these cells are 「one per cell」, so the bottom-right badge is
 * always `1` or meaningless. The inventory tile's badge element (`.inv-tile-qty`) is **only hidden** — it is not removed
 * because, if the name ever changes, the worst case is 「the number shows again」, not an exception.
 *
 * With no inventory yet (housing is registered **before** inventory) the shared chip (`buildItemGridChip`) stands in.
 */

/** The minimum cell edge (px) — below this the glyph is unreadable (a layout constant). */
const MIN_TILE_CELL = 14;

/**
 * The cell edge (px) at which a **`w × h` cell footprint** fits whole inside a `boxW × boxH` px box.
 * The gap between cells (`ITEM_GRID_GAP`) is counted in too — this is the inverse of `itemGridBox`.
 */
export function cellToFit(boxW: number, boxH: number, w: number, h: number, gap: number = ITEM_GRID_GAP): number {
  const cw = Math.max(1, Math.floor(w)), ch = Math.max(1, Math.floor(h));
  const byW = (boxW - gap * (cw - 1)) / cw;
  const byH = (boxH - gap * (ch - 1)) / ch;
  return Math.max(MIN_TILE_CELL, Math.floor(Math.min(byW, byH)));
}

export interface StationTileOptions {
  /** The grid cell edge (px). */
  cell: number;
  /** When present, a durability bar under the tile (the same rule as the inventory tile). */
  durability?: number;
}

/** The box that item's footprint takes (px) — a cell box at this size fits the tile exactly. */
export function stationTileBox(ctx: GameContext, defId: string, cell: number): { width: number; height: number } {
  const def = ctx.loot?.getItemDef(defId);
  return itemGridBox(def?.width ?? 1, def?.height ?? 1, cell);
}

/** That item's footprint (in cells, no rotation). An unknown item is 1×1. */
export function itemFootprint(ctx: GameContext, defId: string): { w: number; h: number } {
  const def = ctx.loot?.getItemDef(defId);
  return { w: Math.max(1, Math.floor(def?.width ?? 1)), h: Math.max(1, Math.floor(def?.height ?? 1)) };
}

/**
 * **An empty slot = as many grid cells as that item's footprint** (2026-09-17, user's decision 「a processor is 2×1, so
 * draw the empty slot as two inventory grid cells too — the cell shape follows the size of the item it accepts」). When
 * a furniture screen's mount slot (compute cluster · library holder) is empty, `w × h` `.hs-fcell`s (the same grain as
 * an inventory empty cell) stand at cell spacing `ITEM_GRID_GAP` instead of one dashed box — the box size is
 * `itemGridBox(w, h, cell)`, exactly the slotted tile's. The pointer passes through (the drop target is the outer cell).
 * ⚠ The grow station's · the culture tank's cells do not use this (the square cells of those screens are unchanged).
 */
export function buildFootprintCells(w: number, h: number, cell: number): HTMLElement {
  const cw = Math.max(1, Math.floor(w)), ch = Math.max(1, Math.floor(h));
  const px = Math.max(MIN_TILE_CELL, Math.round(cell));
  const box = document.createElement('div');
  box.className = 'hs-fcells';
  box.style.gridTemplateColumns = `repeat(${cw}, ${px}px)`;
  box.style.gridTemplateRows = `repeat(${ch}, ${px}px)`;
  box.style.gap = `${ITEM_GRID_GAP}px`;
  for (let i = 0; i < cw * ch; i++) {
    const c = document.createElement('i');
    c.className = 'hs-fcell';
    box.appendChild(c);
  }
  return box;
}

/**
 * **One inventory tile** to sit in one cell. The quantity badge is hidden, and the hover card (`data-item-tip`) comes
 * attached by the inventory tile itself. The returned element carries `.hs-tile`, so the glyph · name size follow the
 * cell size (`housing.css`).
 */
export function buildStationItemTile(ctx: GameContext, defId: string, opts: StationTileOptions): HTMLElement {
  const inv = ctx.inventory;
  const cell = Math.max(MIN_TILE_CELL, Math.round(opts.cell));
  const tile = inv && typeof inv.buildItemTile === 'function'
    ? inv.buildItemTile(defId, 1, opts.durability === undefined ? { cell } : { cell, durability: opts.durability })
    : buildItemGridChip(ctx.loot?.getItemDef(defId), { cell });
  tile.classList.add('hs-tile');
  tile.style.setProperty('--inv-cell', `${cell}px`);
  const qty = tile.querySelector<HTMLElement>('.inv-tile-qty');
  if (qty) qty.hidden = true;
  return tile;
}
