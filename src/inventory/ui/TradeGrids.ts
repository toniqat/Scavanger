import type { EmbeddedView, GameContext, ItemInstance } from '@/shared';
import type { InventorySystem, GridId } from '../InventorySystem';
import { GridView, buildTileContent } from './GridView';
import { CELL, GAP } from './labels';

/** Which of the player's grids a trade screen may show, top to bottom. */
export type TradeGridId = Extract<GridId, 'bag' | 'stash'>;

export interface TradeGridsOptions {
  /** Grids to render, in order. Default: 가방 then 함선 창고. */
  grids?: readonly TradeGridId[];
  /**
   * A tile was handed **out** of the grids: dropped on an element matching `dropSelector` (`target`), or
   * double-clicked (`target` null). The caller decides what that means — the corp screen stages the item in its
   * 판매 tray. The item is *not* removed here; the caller owns that (`InventoryRef.takeItem`).
   */
  onTake?(item: ItemInstance, gridId: TradeGridId, target: HTMLElement | null): void;
  /** CSS selector of the legal drop targets outside the grids (the trade trays). */
  dropSelector?: string;
  /** Tiles to mark `.is-staged` (already sitting in the caller's tray). */
  isStaged?(uid: string): boolean;
  /** Extra class on the root, so the caller can size the blocks from its own stylesheet. */
  className?: string;
  /**
   * Grid cell edge in px (default `CELL` = the Tab window's 54). The 기업 거래 desk passes a smaller edge so its
   * 가방 / 함선 창고 grids match the 5-column 구매 / 판매 tray beside them.
   */
  cell?: number;
}

interface Block {
  id: TradeGridId;
  view: GridView;
  countEl: HTMLElement;
}

/**
 * **Embedded 가방 / 함선 창고 grids** (Phase 9 UI pass) — real inventory grids, rendered by the same `GridView` the
 * Tab window uses, for another folder's screen. The 기업 거래 screen puts them down its right-hand column so the
 * player sees (and drags from) their actual stash instead of a flat list.
 *
 * Scope on purpose: this is a **read + drag-out** view, not the full inventory window. There is no rearranging, no
 * rotation, no socketing and no drop-to-world — a tile can only be dragged onto one of the caller's `dropSelector`
 * targets (or double-clicked), which calls `onTake`. Everything the trade then does to the item goes through the
 * public `InventoryRef` API in the caller.
 *
 * Tiles are stamped `data-item-tip` + `data-def-id`, which is the hook `ui/hud/ItemTip` delegates on — so hovering
 * one raises the same item card the cost chips do, without this view owning a tooltip.
 *
 * It touches nothing outside `host`: no blocker, no pointer-lock call, no window key listener (the corp overlay /
 * the Tab window owns all three). `dispose()` removes exactly what it added.
 */
export class TradeGrids implements EmbeddedView {
  private readonly root: HTMLElement;
  private readonly blocks: Block[] = [];
  /** Grid cell edge / pitch in px (`TradeGridsOptions.cell`; the 기업 거래 desk shrinks them). */
  private readonly cell: number = CELL;
  private readonly step: number = CELL + GAP;
  private readonly unsubs: Array<() => void> = [];
  private drag: { uid: string; gridId: TradeGridId; ghost: HTMLElement; el: HTMLElement } | null = null;
  /** Drop target currently under the cursor, marked `.is-over` so the tray lights up. */
  private over: HTMLElement | null = null;
  private disposed = false;

  constructor(
    private readonly inv: InventorySystem,
    private readonly ctx: GameContext,
    host: HTMLElement,
    private readonly opts: TradeGridsOptions = {},
  ) {
    this.root = document.createElement('div');
    this.root.className = `trade-grids${opts.className ? ` ${opts.className}` : ''}`;
    host.appendChild(this.root);

    const cell = Math.max(16, Math.round(opts.cell ?? CELL));
    this.cell = cell;
    this.step = cell + GAP;
    if (cell !== CELL) this.root.style.setProperty('--inv-cell', `${cell}px`);
    const ids = opts.grids ?? (['bag', 'stash'] as const);
    for (const id of ids) {
      const block = document.createElement('div');
      block.className = `tg-block tg-${id}`;
      const head = document.createElement('div');
      head.className = 'tg-head';
      const label = document.createElement('span');
      label.className = 'tg-label';
      label.textContent = id === 'bag' ? '내 가방' : '함선 창고';
      const countEl = document.createElement('span');
      countEl.className = 'tg-count';
      head.append(label, countEl);
      const scroll = document.createElement('div');
      scroll.className = 'tg-scroll';
      const view = new GridView(id, (defId) => this.inv.getDef(defId), (item) => this.inv.getStats(item), {
        onPointerDown: (uid, gridId, e) => this.startDrag(uid, gridId as TradeGridId, e),
        onEnter: () => { /* the trade screen has no tooltip of its own */ },
        onMove: () => { /* no-op */ },
        onLeave: () => { /* no-op */ },
        onContext: () => { /* no context menu in a trade */ },
        onDblClick: (uid, gridId) => this.take(uid, gridId as TradeGridId, null),
      }, cell);
      scroll.appendChild(view.el);
      block.append(head, scroll);
      this.root.appendChild(block);
      this.blocks.push({ id, view, countEl });
    }

    const b = this.ctx.bus;
    const repaint = (): void => this.refresh();
    this.unsubs.push(
      b.on('inventory:changed', repaint), b.on('inventory:stashChanged', repaint),
      b.on('inventory:bagChanged', repaint), b.on('loadout:changed', repaint),
    );
    this.refresh();
  }

  refresh(): void {
    if (this.disposed) return;
    for (const bl of this.blocks) {
      const grid = this.inv.getGrid(bl.id);
      if (bl.view.current !== grid) bl.view.setGrid(grid);
      else bl.view.refresh(true);
      bl.countEl.textContent = grid ? `${grid.count}점` : '';
      const staged = this.opts.isStaged;
      for (const tile of Array.from(bl.view.el.querySelectorAll<HTMLElement>('.inv-tile[data-uid]'))) {
        const uid = tile.dataset.uid ?? '';
        if (staged) tile.classList.toggle('is-staged', staged(uid));
        // opt the tile into the shared hover card (`ui/hud/ItemTip` reads `[data-item-tip][data-def-id]`) — this
        // view has no tooltip of its own, and a trade screen badly needs one
        const item = grid?.get(uid)?.item;
        if (item) { tile.dataset.itemTip = ''; tile.dataset.defId = item.defId; }
      }
    }
  }

  /* ── drag out ─────────────────────────────────────────────────────────── */
  private startDrag(uid: string, gridId: TradeGridId, e: PointerEvent): void {
    if (e.button !== 0) return;
    const grid = this.inv.getGrid(gridId);
    const p = grid?.get(uid);
    const def = p ? this.inv.getDef(p.item.defId) : undefined;
    if (!grid || !p || !def) return;
    e.preventDefault();
    e.stopPropagation();
    const el = (e.currentTarget as HTMLElement | null) ?? (e.target as HTMLElement).closest<HTMLElement>('.inv-tile');
    if (!el) return;
    const fp = grid.footprintOf(p.item);
    const ghost = document.createElement('div');
    ghost.className = 'tg-ghost';
    buildTileContent(ghost, p.item, def, fp.w, fp.h, this.inv.getStats(p.item), this.cell);
    ghost.classList.add('tg-ghost');
    ghost.style.left = `${e.clientX - (fp.w * this.step) / 2}px`;
    ghost.style.top = `${e.clientY - (fp.h * this.step) / 2}px`;
    document.body.appendChild(ghost);
    el.classList.add('is-dragging');
    this.drag = { uid, gridId, ghost, el };
    window.addEventListener('pointermove', this.onMove, true);
    window.addEventListener('pointerup', this.onUp, true);
  }

  private onMove = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d) return;
    const w = d.ghost.offsetWidth, h = d.ghost.offsetHeight;
    d.ghost.style.left = `${e.clientX - w / 2}px`;
    d.ghost.style.top = `${e.clientY - h / 2}px`;
    const target = this.dropTargetAt(e.clientX, e.clientY);
    d.ghost.classList.toggle('is-ok', !!target);
    this.setOver(target);
  };

  private onUp = (e: PointerEvent): void => {
    const d = this.drag;
    this.endDrag();
    if (!d) return;
    const target = this.dropTargetAt(e.clientX, e.clientY);
    if (target) this.take(d.uid, d.gridId, target);
  };

  private dropTargetAt(x: number, y: number): HTMLElement | null {
    const sel = this.opts.dropSelector;
    if (!sel) return null;
    const under = document.elementFromPoint(x, y) as HTMLElement | null;
    return under?.closest<HTMLElement>(sel) ?? null;
  }

  private setOver(target: HTMLElement | null): void {
    if (this.over === target) return;
    this.over?.classList.remove('is-over');
    this.over = target;
    this.over?.classList.add('is-over');
  }

  private endDrag(): void {
    const d = this.drag;
    this.drag = null;
    this.setOver(null);
    window.removeEventListener('pointermove', this.onMove, true);
    window.removeEventListener('pointerup', this.onUp, true);
    if (!d) return;
    d.ghost.remove();
    d.el.classList.remove('is-dragging');
  }

  private take(uid: string, gridId: TradeGridId, target: HTMLElement | null): void {
    const p = this.inv.getGrid(gridId)?.get(uid);
    if (!p) return;
    this.opts.onTake?.(p.item, gridId, target);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.endDrag();
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.root.remove();
  }
}
