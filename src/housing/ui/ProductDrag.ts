import type { HarvestDestination, ItemDef } from '@/shared';
import { buildItemGridChip, itemGridBox } from '@/shared';
import { withDropCell } from '../parts/Deliver';
import { stationGridCell } from './StationShell';
import type { StationGridsView } from './StationShell';
import { el } from './dom';

/** A finished product sitting in a station cell (a grown crop · an analysis product · a culture product). */
export interface Product {
  /** The panel's own id of the cell (`tier:slot` · `slot`). */
  key: string;
  defId: string;
  qty: number;
}

export interface ProductDragOptions {
  /** The finished product under `target`, or null (not ready / not a cell). */
  productAt(target: Element): Product | null;
  /** Collect the cell — dropped on a grid (`'bag'` / `'stash'`) or double-clicked (`'stash-first'`). */
  collect(key: string, dest: HarvestDestination): void;
  defOf(defId: string): ItemDef | undefined;
  /**
   * 2026-09-16 (user's report 「what is dragged out has to go to **the cell the cursor is over**」) — this screen's
   * stash · bag grids (the view from `mountStationGrids`). Given, the release coordinates go to that cell
   * (`parts/Deliver.withDropCell`); not given, it is the first free cell as before. The grids are built late when the
   * screen opens, so this is taken as **a function, not a value**.
   */
  grids?(): StationGridsView | null;
  /** A drag really started (the panel hides its hover card). */
  onDragStart?(): void;
  /**
   * 2026-09-16 — the grid cell edge (px) the ghost uses. The default is `stationGridCell()`, the same as the station
   * screen's grids, so what is dragged and where it lands (the stash · bag grids) match within one screen. Only a
   * screen using a different cell passes this.
   */
  cellPx?(): number;
}

const THRESHOLD_PX = 5;

/**
 * **A finished thing moves like an item** (2026-09-12) — the place where the harvest button · harvest-all were removed.
 *
 * - **Double-click** → the ship stash first, the bag when it is full (`'stash-first'`, user's decision — this is inside the ship).
 * - **Drag and drop on the bag / ship stash grid** → into that grid only (`closest('[data-tg-grid]')` — the attribute
 *   `inventory/ui/TradeGrids` stamps on the block). Dropped anywhere else, nothing happens.
 *
 * Performance contract (drag lag on the grow screen): `pointermove` only records the coordinates; the ghost `transform`
 * and the grid highlight (`elementFromPoint`) happen **once per rAF**. The drop judgement is re-measured from the
 * `pointerup` coordinates — so the result is the same headless, where rAF has stopped.
 */
export class ProductDrag {
  private press: { p: Product; x0: number; y0: number; x: number; y: number } | null = null;
  private ghost: HTMLElement | null = null;
  /** Half the ghost box's width · height (px) — the cursor is always at its centre. The footprint is not square, so the two are measured apart. */
  private halfW = 0;
  private halfH = 0;
  private over: HTMLElement | null = null;
  private raf = 0;

  private readonly onDown = (e: PointerEvent): void => {
    if (e.button !== 0 || !(e.target instanceof Element)) return;
    const p = this.o.productAt(e.target);
    if (!p) return;
    this.end();
    this.press = { p, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY };
    window.addEventListener('pointermove', this.onMove, true);
    window.addEventListener('pointerup', this.onUp, true);
  };

  private readonly onMove = (e: PointerEvent): void => {
    const s = this.press;
    if (!s) return;
    s.x = e.clientX; s.y = e.clientY;
    if (!this.ghost) {
      if (Math.hypot(s.x - s.x0, s.y - s.y0) < THRESHOLD_PX) return;
      this.startGhost(s.p);
    }
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  };

  private readonly frame = (): void => {
    this.raf = 0;
    const s = this.press;
    if (!s || !this.ghost) return;
    this.placeGhost(s.x, s.y);
    this.aim(s.p, s.x, s.y);
  };

  /**
   * 2026-09-17 (user's report 「the **cell under the cursor** should be highlighted, as when dragging from an equipment
   * slot to the bag — right now the whole stash · bag cell area lights up」): when the grid view offers a cell preview,
   * only the **footprint highlight** (`previewExternalAt`, the same `.inv-hl` as a tile drag) is used and the grid is
   * not highlighted whole. It is the same cell lookup as the drop (`withDropCell` → `placeExternalAt`). Only an older
   * inventory without the preview · a screen that did not pass `grids` paints the whole grid block as before.
   */
  private aim(p: Product, x: number, y: number): void {
    const view = this.o.grids?.() ?? null;
    if (view?.canPreview) {
      this.setOver(null);
      view.previewExternalAt(p.defId, p.qty, x, y);
      return;
    }
    this.setOver(this.gridAt(x, y));
  }

  private readonly onUp = (e: PointerEvent): void => {
    const s = this.press;
    const dragged = !!this.ghost;
    const target = dragged ? this.gridAt(e.clientX, e.clientY) : null;
    this.end();
    if (!s || !target) return;
    const dest: HarvestDestination = target.dataset.tgGrid === 'bag' ? 'bag' : 'stash';
    /* 2026-09-16: the **cell** it was dropped on is the result — the coordinates are noted once in `Deliver`, then the
       rule function is called. Only that one handover goes to that cell (a blocked cell refuses); outside the grid the old rule stands. */
    const view = this.o.grids?.() ?? null;
    if (!view) { this.o.collect(s.p.key, dest); return; }
    withDropCell({ view, x: e.clientX, y: e.clientY }, () => this.o.collect(s.p.key, dest));
  };

  private readonly onDbl = (e: MouseEvent): void => {
    if (!(e.target instanceof Element)) return;
    const p = this.o.productAt(e.target);
    if (p) this.o.collect(p.key, 'stash-first');
  };

  constructor(private readonly host: HTMLElement, private readonly o: ProductDragOptions) {
    host.addEventListener('pointerdown', this.onDown);
    host.addEventListener('dblclick', this.onDbl);
  }

  get dragging(): boolean { return !!this.ghost; }

  /**
   * 2026-09-16 (bug: dragging from the grow station · a holder did not keep the grid size) — the ghost has the
   * **same footprint** as a drag from the bag: the item's `width × height` cells measured at the grid cell size
   * (`cellPx`) into a box (`itemGridBox`). It used to be one square chip unrelated to the footprint. The size formula
   * is the inventory grid's (`tileSizeAt`), held once in `shared/itemChip`.
   */
  private startGhost(p: Product): void {
    const def = this.o.defOf(p.defId);
    const cell = this.o.cellPx?.() ?? stationGridCell();
    const box = itemGridBox(def?.width ?? 1, def?.height ?? 1, cell);
    this.halfW = box.width / 2;
    this.halfH = box.height / 2;
    const g = el('div', { cls: 'hs-ghost' });
    g.appendChild(buildItemGridChip(def, { cell, have: p.qty }));
    document.body.appendChild(g);
    this.ghost = g;
    this.placeGhost(this.press?.x ?? 0, this.press?.y ?? 0);
    this.o.onDragStart?.();
  }

  private placeGhost(x: number, y: number): void {
    if (this.ghost) this.ghost.style.transform = `translate(${Math.round(x - this.halfW)}px, ${Math.round(y - this.halfH)}px)`;
  }

  private gridAt(x: number, y: number): HTMLElement | null {
    const under = document.elementFromPoint(x, y);
    return under?.closest<HTMLElement>('[data-tg-grid]') ?? null;
  }

  private setOver(t: HTMLElement | null): void {
    if (this.over === t) return;
    this.over?.classList.remove('hs-drop-over');
    this.over = t;
    t?.classList.add('hs-drop-over');
  }

  /** Cancel whatever is in flight (the panel calls this on close). */
  end(): void {
    window.removeEventListener('pointermove', this.onMove, true);
    window.removeEventListener('pointerup', this.onUp, true);
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
    if (this.ghost) this.o.grids?.()?.clearExternalPreview();
    this.ghost?.remove();
    this.ghost = null;
    this.setOver(null);
    this.press = null;
  }

  dispose(): void {
    this.end();
    this.host.removeEventListener('pointerdown', this.onDown);
    this.host.removeEventListener('dblclick', this.onDbl);
  }
}
