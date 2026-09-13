/* ────────────────────────────────────────────────────────────────────────────
 * TileGrid — a **packed item grid** for the 기업 화면 (2026-09-12).
 *
 * The 기업 판매 물품, the 구매 / 판매 trays and the 임플란트 desk used to be CSS grids of `.ct-cell` boxes with an
 * `item-chip` inside. Two things went wrong with that: housing.css also owns a `.ct-cell` (the 배양조 tube, 54×76
 * with a rounded bottom) so every cell turned into that tube, and the chip had `pointer-events: none` with no
 * `data-def-id` on the cell, so no hover card ever rose. The user's rule is simple — *these must look exactly like
 * the 가방 / 창고 beside them* — so they now **are** inventory tiles: `InventoryRef.buildItemTile` builds the same
 * `.inv-tile` the Tab window draws (footprint `w × h`, rarity wash, qty, durability, `data-item-tip`), laid over the
 * same `.inv-cells` background, placed first-fit row by row like a container grid.
 *
 * The grid only positions what it is handed; the caller builds the tiles and hangs its own listeners on them.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface TileSpec {
  tile: HTMLElement;
  /** Footprint in cells (clamped to the column count). */
  w: number;
  h: number;
}

export interface TileGridOptions {
  /** Cell edge / gap in px — the Tab window's (`inventory/ui/labels`), so the tiles match the 가방. */
  cell: number;
  gap: number;
  /** Fixed column count; omit to fit as many columns as the scroll box is wide (never fewer than `minCols`). */
  cols?: number;
  minCols?: number;
  /** Extra classes on the scroll box. */
  className?: string;
}

/** First-fit, row-major placement of `sizes` on a grid `cols` wide. Rows grow as needed. */
export function packFootprints(sizes: readonly { w: number; h: number }[], cols: number): { pos: { x: number; y: number }[]; rows: number } {
  const occ: boolean[][] = [];
  const taken = (x: number, y: number): boolean => !!occ[y]?.[x];
  const pos: { x: number; y: number }[] = [];
  let rows = 0;
  for (const s of sizes) {
    const w = Math.max(1, Math.min(cols, Math.floor(s.w)));
    const h = Math.max(1, Math.floor(s.h));
    let placed = false;
    for (let y = 0; !placed; y++) {
      for (let x = 0; x + w <= cols && !placed; x++) {
        let free = true;
        for (let yy = y; yy < y + h && free; yy++) for (let xx = x; xx < x + w; xx++) if (taken(xx, yy)) { free = false; break; }
        if (!free) continue;
        for (let yy = y; yy < y + h; yy++) { const row = (occ[yy] ??= []); for (let xx = x; xx < x + w; xx++) row[xx] = true; }
        pos.push({ x, y });
        rows = Math.max(rows, y + h);
        placed = true;
      }
    }
  }
  return { pos, rows };
}

export class TileGrid {
  /** The scroll box — put it wherever the grid belongs. */
  readonly el: HTMLElement;
  private readonly gridEl: HTMLElement;
  private readonly cellsEl: HTMLElement;
  private readonly tilesEl: HTMLElement;
  private readonly emptyEl: HTMLElement;
  private cell: number;
  private step: number;
  private specs: readonly TileSpec[] = [];
  private cols = 0;
  private rows = 0;
  private observer: ResizeObserver | null = null;

  constructor(parent: HTMLElement, private readonly opts: TileGridOptions) {
    this.cell = opts.cell;
    this.step = opts.cell + opts.gap;
    this.el = document.createElement('div');
    this.el.className = `cv-scroll${opts.className ? ` ${opts.className}` : ''}`;
    this.gridEl = document.createElement('div');
    this.gridEl.className = 'inv-grid cv-grid';
    this.cellsEl = document.createElement('div');
    this.cellsEl.className = 'inv-cells';
    this.tilesEl = document.createElement('div');
    this.tilesEl.className = 'inv-tiles';
    this.emptyEl = document.createElement('div');
    this.emptyEl.className = 'corp-empty cv-empty';
    this.emptyEl.hidden = true;
    this.gridEl.append(this.cellsEl, this.tilesEl);
    this.el.append(this.gridEl, this.emptyEl);
    parent.appendChild(this.el);
    if (typeof ResizeObserver !== 'undefined') {
      // the column count (auto) and the filler rows both follow the box — re-lay when either would change. Deferred a
      // frame: resizing the grid inside the observer's own callback is how a "ResizeObserver loop" error starts.
      let pending = 0;
      this.observer = new ResizeObserver(() => {
        if (pending) return;
        pending = requestAnimationFrame(() => { pending = 0; this.layout(); });
      });
      this.observer.observe(this.el);
    }
  }

  /** Replace the tiles (placed in order) and show `emptyText` over the grid when there are none. */
  render(specs: readonly TileSpec[], emptyText: string | null = null): void {
    this.specs = specs;
    this.tilesEl.replaceChildren(...specs.map((s) => s.tile));
    this.emptyEl.hidden = !emptyText;
    if (emptyText) this.emptyEl.textContent = emptyText;
    this.cols = 0;          // force a full lay-out
    this.layout();
  }

  private fitCols(): number {
    if (this.opts.cols) return this.opts.cols;
    const w = this.el.clientWidth;
    const fit = w > 0 ? Math.floor((w + this.opts.gap) / this.step) : 10;
    return Math.max(this.opts.minCols ?? 1, fit);
  }

  private layout(): void {
    const cols = this.fitCols();
    const { pos, rows: used } = packFootprints(this.specs.map((s) => ({ w: s.w, h: s.h })), cols);
    const h = this.el.clientHeight;
    const fill = h > 0 ? Math.floor((h + this.opts.gap) / this.step) : 0;
    const rows = Math.max(1, used, fill);
    if (cols !== this.cols || rows !== this.rows) {
      this.cols = cols;
      this.rows = rows;
      this.gridEl.style.setProperty('--cols', String(cols));
      this.gridEl.style.setProperty('--rows', String(rows));
      this.gridEl.style.width = `${cols * this.step - this.opts.gap}px`;
      this.gridEl.style.height = `${rows * this.step - this.opts.gap}px`;
      const want = cols * rows;
      while (this.cellsEl.childElementCount < want) {
        const c = document.createElement('div');
        c.className = 'inv-cell';
        this.cellsEl.appendChild(c);
      }
      while (this.cellsEl.childElementCount > want) this.cellsEl.lastElementChild!.remove();
    }
    this.specs.forEach((s, i) => {
      const p = pos[i];
      s.tile.style.transform = `translate(${p.x * this.step}px, ${p.y * this.step}px)`;
    });
  }

  /**
   * 2026-09-13: change the cell edge (the 기업 화면 fits its grids to the window). Re-lays the cells and moves the current
   * tiles; the tiles' own size is baked in by `buildItemTile`, so the caller re-renders them right after.
   */
  setCell(cell: number): void {
    if (cell === this.cell) return;
    this.cell = cell;
    this.step = cell + this.opts.gap;
    this.cols = 0;          // force the cell layer + box size to be rebuilt at the new pitch
    this.rows = 0;
    this.layout();
  }

  dispose(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.el.remove();
  }
}
