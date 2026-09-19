import type { GameContext, ItemDef, ItemInstance, TradeGridsView } from '@/shared';
import { Keys } from '@/shared';
import type { InventorySystem, GridId } from '../InventorySystem';
import { BAG_FRAME_ROWS, filterPredicate, type FilterGroupId } from '../model';
import { GridView, buildTileContent, setNeededAmmoFrom, type HighlightState } from './GridView';
import { buildFilterSelect, buildSortButton, type FilterControl } from './GridTools';
import { CELL, GAP, TEXT, capacityLabel, tileSizeAt } from './labels';
import { ContextMenu, type MenuEntry } from './ContextMenu';
/* 2026-09-14: the pinned tooltip · dragging a socket out of the pinned card */
/* 2026-09-16: moves inside a grid / between grids — `parts/DropResolver` judges and this file only asks */
import type { DetachTarget, DropTarget, ItemLocation } from '../model';
import { Tooltip } from './Tooltip';
import { TipPin, inventoryTooltipLookups, type DetachAim, type SocketDrag } from './TipPin';
import { CLICK_SUPPRESS_MS, DRAG_THRESHOLD } from './model';

/** Which of the player's grids a trade screen may show, top to bottom. */
export type TradeGridId = Extract<GridId, 'bag' | 'stash'>;

/**
 * 2026-09-13 → **2026-09-15 2nd pass (user's decision): the two values no longer differ.**
 *
 * On every screen the stash + bag are now **two panes in one panel** (stash left · bag right, exactly the 2026-09-12
 * decision) and **each pane has its own scroll · its own sort button · its own filter** — that is, the old `'split'` is
 * the only layout. `'wrap'` is a name kept so the contract is not shaken (`TradeGridsViewOptions.layout` is a
 * `src/shared` contract), and today both draw the same thing.
 *
 * ⚠ The old `'wrap'`'s 「blocks side by side in one scroll, wrapping when narrow」 is not brought back — a 24-row stash and
 * a 12-row bag frame sharing one scroll leave whichever is below off-screen, and it cannot be scrolled mid-drag (2026-09-12 warning).
 */
export type TradeGridsLayout = 'wrap' | 'split';
/**
 * 2026-09-13 → 2026-09-15 2nd pass: the filter is not a chip row but **a dropdown right of the sort button** (`ui/GridTools`).
 * `'block'` (default) = its own dropdown in each pane's header, `'shared'` = one row above the panel filters every pane,
 * `'none'` = none inside the view (the caller can mount a row anywhere with `mountFilterChips(host)`).
 */
export type TradeGridsChips = 'shared' | 'block' | 'none';

export interface TradeGridsOptions {
  /** Grids to render, in order. Default (2026-09-12, user's decision): **`함선 창고` left, `내 가방` right**. */
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
   * Grid cell edge in px (default `CELL` = the Tab window's edge). The 기업 거래 desk passes a smaller edge so its
   * 가방 / 함선 창고 grids match the 5-column 구매 / 판매 tray beside them. Change it later with `setCell`.
   */
  cell?: number;
  /**
   * 2026-09-12: the name of the right-click menu's first entry — what this screen's double-click (`onTake`) does.
   * Default `빠른 이동`. With no `onTake` the entry itself is absent (the menu holds only the favourite toggle).
   */
  takeLabel?: string;
  /**
   * 2026-09-13: see `TradeGridsLayout`. **Never read** since the 2026-09-15 2nd pass — both values draw the same
   * panel (the root is always `trade-grids is-split`). The option stays because `TradeGridsViewOptions` is a
   * `src/shared` contract (add-only) and `meta/ui/CorpView` · `housing/ui/StationShell` still pass `'split'`.
   */
  layout?: TradeGridsLayout;
  /** 2026-09-13: see `TradeGridsChips`. Default `'block'` (one dropdown per pane), whatever `layout` says. */
  chips?: TradeGridsChips;
}

interface Block {
  id: TradeGridId;
  el: HTMLElement;
  view: GridView;
  countEl: HTMLElement;
  /** The box around the grid — **always the scroller** (2026-09-15 2nd pass; `housing.css`'s `.hs-inv` agrees). */
  wrap: HTMLElement;
  /** This block's own filter dropdown (`chips: 'block'`), else null. */
  chips: FilterControl | null;
  filter: FilterGroupId;
}

/**
 * 2026-09-16 (user's decision 「창고 · 가방 아이템을 여기서도 옮길 수 있어야 한다 — 회전 · 머지 · 칸 옮기기 전부」):
 * one drag in flight. It used to be 「drag out to the caller's tray」 only, so it held just `uid` · the ghost · the half size.
 */
interface DragInfo {
  uid: string;
  gridId: TradeGridId;
  /** The source `DropResolver` asks for (`{kind:'grid', grid: gridId}`) — carried along instead of rebuilt every time. */
  from: ItemLocation;
  def: ItemDef;
  /** The orientation flipped by R (the item itself is untouched until it lands — it travels only in `DropTarget.rotated`). */
  rotated: boolean;
  ghost: HTMLElement;
  /** Half the ghost's size, known at pick-up (never measured while moving — that forced a layout per event). */
  halfW: number;
  halfH: number;
  /**
   * 2026-09-16: the state where the **remainder of a merge stays on the cursor** (the same rule as the Tab window's `DragState.held`).
   * The remainder never left the source stack — that stack's quantity merely dropped — and the next left-click places it.
   */
  held: boolean;
  /** A `held` drag: the next press has arrived, so its **release** is the drop. */
  armed: boolean;
}

/** Smallest cell edge a caller can ask for (tiles stop being legible well before this). */
const MIN_CELL = 16;
/** A block narrower than this stacks its header tools (`정렬` · the filter) instead of putting them on one line. */
const NARROW_BLOCK_PX = 260;

const clampCell = (px: number | undefined): number => Math.max(MIN_CELL, Math.round(px ?? CELL));

/**
 * **Embedded 가방 / 함선 창고 grids** (Phase 9 UI pass) — real inventory grids, rendered by the same `GridView` the
 * Tab window uses, for another folder's screen (기업 거래 · 재배 스테이션 · 분석기 · 배양조 · 식탁).
 *
 * **2026-09-16 (user's decision) — items can be moved here too.** This view used to be 「read + drag out」 only and judged no
 * drop at all (`pointerup` looked only at the caller's `dropSelector`; releasing over a grid did nothing). Now **another cell
 * of the same grid · stash ↔ bag · `R` rotation mid-drag · merging onto a matching stack** work exactly as in the Tab
 * inventory — judging and executing are all `parts/DropResolver` (`InventorySystem.previewDrop` / `drop`), and this file only
 * finds the cell under the cursor, asks, and paints the highlight. So the Tab window's rules follow: a merge remainder stays
 * on the cursor (`DragInfo.held`), no path silently displaces equipped gear, and **a move that would drop items is refused**,
 * as for pouches · quick slots. What is not here is still not here — no equipment slots · quick slots · container grid in this
 * view, so they are no drop targets, and there is no world drop (`X`) (releasing outside a grid returns the item to its place).
 *
 * The caller's tray is unchanged: releasing over an element matching `dropSelector` (or double-clicking) calls `onTake` —
 * **the tray comes before the grids**, so the corp trade's 판매 tray behaves exactly as before.
 *
 * **2026-09-12 (user's decision)** —
 *   - **The stash stands left and the bag right**, side by side (`.tg-scroll` is two columns). The earlier layout stacked them
 *     in one scroll, where the long bag frame pushed the stash below it; when the width is short, `flex-wrap` drops the bag to
 *     the next row by itself. The bag is 5 cells wide, the stash 10 — exactly the Tab inventory. The frame height
 *     (`BAG_FRAME_ROWS`) is left only here: from 2026-09-18 the Tab draws the equipped bag's own size, but beside a 24-row
 *     stash a frameless bag reads as a stump. ⚠ Stacked vertically the two grids **join into one scroll**: 24-row stash =
 *     1381 px · 12-row bag frame = 709 px against a scroll window of barely 600 px, so **whichever goes on top leaves the
 *     other off-screen**, and it cannot be scrolled mid-drag, which blocks that direction of dragging entirely. So a screen
 *     without room for two columns gives each block its own scroll — since 2026-09-13 `layout: 'split'` does that in this view.
 *   - In the header, a **`정렬`** button (`InventorySystem.sortGrid` — the one action of this view that changes the inventory;
 *     uids the caller staged are passed as `isStaged` and left out of merging) and **filter chips** (a filtered tile only dims).
 *   - A drag **coalesces pointermove into one rAF** and moves the ghost by `transform`. Several bus events in one frame
 *     repaint once, and `GridView` rebuilds only the tiles that changed.
 *
 * **2026-09-15 2nd pass (user's decision) — stash + bag are one panel.** On every screen one `.trade-grids` is the card, and
 * inside it **left pane = `함선 창고` · right pane = `내 가방`** stand side by side. Each pane has **its own vertical scroll ·
 * its own sort button · its own filter dropdown** (they work independently), and the stash-side label was dropped. `layout`
 * no longer forks anything (see the `TradeGridsLayout` comment). ⚠ The old warning still holds — the two grids are **never
 * joined vertically in one scroll**; `.tg-gridwrap` is each one's scroller and `scrollbar-gutter: stable` keeps the last column.
 *
 * **2026-09-13 (the 기업 screen's card split)** — `layout: 'split'` · `chips: 'block' | 'none'` · `mountFilterChips(host)` ·
 * `setCell(px)` (changes a live view's cell edge: each block's `GridView` is rebuilt at the new cell, keeping the filter and the
 * scrolled-to row). Below the default cell (54) the root takes `.tg-compact` and tile glyph · qty badge · socket pips shrink with it.
 *
 * Tiles are stamped `data-item-tip` + `data-def-id`, the hook `ui/hud/ItemTip` delegates on. Each grid block carries
 * `data-tg-grid="bag" | "stash"` so a caller can tell which grid a drop of its own landed on.
 *
 * It touches nothing outside `host` (apart from the drag ghost on `document.body` while a drag lasts, the context menu on
 * `ctx.uiRoot` and a chip row the caller mounted elsewhere): no blocker, no pointer-lock call, no window key listener.
 * `dispose()` removes exactly what it added.
 */
export class TradeGrids implements TradeGridsView {
  private readonly root: HTMLElement;
  private readonly scroll: HTMLElement;
  private readonly blocks: Block[] = [];
  /** Grid cell edge in px (`TradeGridsOptions.cell`, `setCell`). */
  private cellPx: number = CELL;
  private readonly unsubs: Array<() => void> = [];
  private readonly chipsMode: TradeGridsChips;
  /** The one filter row that drives every block (`chips: 'shared'`, or created by `mountFilterChips`). */
  private sharedChips: FilterControl | null = null;
  private sharedTools: HTMLElement | null = null;
  private sharedFilter: FilterGroupId = 'all';
  private drag: DragInfo | null = null;
  /** Drop target currently under the cursor, marked `.is-over` so the tray lights up. */
  private over: HTMLElement | null = null;
  private moveX = 0;
  private moveY = 0;
  private moveRaf = 0;
  private refreshRaf = 0;
  private disposed = false;
  /**
   * 2026-09-16: **the very click** that puts down a held remainder (left-click) or lets it go (right-click) must not carry on
   * into the `dblclick` / `contextmenu` of the tile beneath — the same window as the Tab window's `suppressClicksUntil` (`CLICK_SUPPRESS_MS`).
   */
  private suppressUntil = 0;
  /**
   * 2026-09-12 (user's decision 「모든 아이템 우클릭 = 메뉴」): `빠른 이동` (= double-click) · favourite. Mounted on `ctx.uiRoot` —
   * `.inv-menu` is `position: fixed`, so inside a screen carrying a transform it would sit in the wrong place.
   */
  private readonly menu: ContextMenu;
  /**
   * 2026-09-14 (user's decision): the pinned tooltip — holding a tile still for one second stands the **inventory tooltip** (the instance card
   * with weapon gauges · socket row) where it was pressed (`ui/TipPin`). The floating hover card is still `ui/hud/ItemTip` (a pinned tile opts out
   * via `data-tip-pinned`); the pinned card and its socket hover card live on `ctx.uiRoot` — `position: fixed` needs to be outside the transform.
   */
  private readonly pin: TipPin;
  private readonly hoverTip: Tooltip;
  /** A LMB press that has not moved past `DRAG_THRESHOLD` yet — the ghost lifts only past it (a hold may pin instead). */
  private press: { uid: string; gridId: TradeGridId; el: HTMLElement; x: number; y: number } | null = null;

  constructor(
    private readonly inv: InventorySystem,
    private readonly ctx: GameContext,
    host: HTMLElement,
    private readonly opts: TradeGridsOptions = {},
  ) {
    // 2026-09-15 2nd pass: there is only one layout (`is-split` is a name kept — outside stylesheets hang off it)
    this.chipsMode = opts.chips ?? 'block';
    this.root = document.createElement('div');
    this.root.className = `trade-grids is-split${opts.className ? ` ${opts.className}` : ''}`;
    host.appendChild(this.root);
    this.menu = new ContextMenu(ctx.uiRoot);
    this.menu.el.classList.add('tg-menu');
    const lookups = inventoryTooltipLookups(inv, ctx);
    this.hoverTip = new Tooltip(lookups);
    this.hoverTip.el.classList.add('tg-tip');
    ctx.uiRoot.appendChild(this.hoverTip.el);
    this.pin = new TipPin(ctx, lookups, {
      owner: 'tradeGrids',
      mount: (el) => { el.classList.add('tg-tip'); ctx.uiRoot.insertBefore(el, this.hoverTip.el); },
      hoverTip: this.hoverTip,
      buildGhost: (item, def) => this.buildSocketGhost(item, def),
      ghostParent: document.body,
      locate: (uid) => inv.locate(uid),
      canDetach: (uid) => inv.canDetachSockets(uid),
      aimDetach: (px, py, d) => this.aimDetach(px, py, d),
      clearDetachAim: () => this.clearDetachAim(),
      detach: (d, target) => inv.detachSocket(d.weaponUid, d.socket, target),
    });

    this.cellPx = clampCell(opts.cell);
    this.applyCellVars();

    if (this.chipsMode === 'shared') this.root.appendChild(this.ensureSharedTools());
    this.scroll = document.createElement('div');
    this.scroll.className = 'tg-scroll';
    this.root.appendChild(this.scroll);

    // 2026-09-12 (user's decision): stash left · bag right. A caller that passes `grids` itself wins that order.
    const ids = opts.grids ?? (['stash', 'bag'] as const);
    for (const id of ids) this.blocks.push(this.buildBlock(id));

    const b = this.ctx.bus;
    const repaint = (): void => this.scheduleRefresh();
    this.unsubs.push(
      b.on('inventory:changed', repaint), b.on('inventory:stashChanged', repaint),
      b.on('inventory:bagChanged', repaint), b.on('loadout:changed', repaint),
      // 2026-09-12 (E1): the favourite ribbon · the 「즐겨찾기」 filter — `GridView.refresh` repaints on the favourite revision
      b.on('inventory:favoritesChanged', repaint),
      // 2026-09-13 (library series): the "not yet shelved" ribbon — `parts/ShelfWanted` clears the cache first (subscribed at system init)
      b.on('housing:libraryChanged', repaint),
      b.on('ui:tipPinned', repaint),   // 2026-09-14: the pinned tile's `data-tip-pinned` flag
    );
    this.refresh();
  }

  /**
   * One block: header (label · cell readout · `정렬` · the filter dropdown) and the grid inside its scrolling wrap.
   * 2026-09-16: that readout is `사용칸 / 전체칸` and sits **left of the sort button** (`refresh`, `labels.capacityLabel`).
   *
   * **2026-09-15 2nd pass (user's decision)** — two things changed:
   *  - **The stash-side label (`함선 창고`) was dropped.** With stash · bag standing as two panes of one panel, the picture
   *    says that the big left grid is the stash. The bag label stays (it marks the right pane as **mine**).
   *  - **The filter is a dropdown right of the sort button** — the chip row that stood under the header (`.tg-tools`) is gone.
   */
  private buildBlock(id: TradeGridId): Block {
    const el = document.createElement('div');
    el.className = `tg-block tg-${id}`;
    el.dataset.tgGrid = id;   // 2026-09-12: another screen splits a drop position into bag / stash (`closest('[data-tg-grid]')`)
    const head = document.createElement('div');
    head.className = 'tg-head';
    const label = document.createElement('span');
    label.className = 'tg-label';
    label.textContent = id === 'bag' ? '내 가방' : '';
    label.hidden = id !== 'bag';
    const countEl = document.createElement('span');
    countEl.className = 'tg-count';
    head.append(label, countEl, buildSortButton(() => this.sort(id)));
    el.appendChild(head);
    const block: Block = { id, el, view: null as unknown as GridView, countEl, wrap: document.createElement('div'), chips: null, filter: 'all' };
    if (this.chipsMode === 'block') {
      block.chips = buildFilterSelect((f) => this.setBlockFilter(block, f));
      head.appendChild(block.chips.el);
    }
    // 2026-09-12: a grid is a box that **pins its own width in px** (`GridView.syncDims`), so putting the vertical scroll on
    // the grid itself lets the scrollbar take space inside that width and clip the last column — this box, whose width comes
    // from its content, takes it instead (as the `Tab` inventory's `.inv-bag-scroll` does).
    block.wrap.className = 'tg-gridwrap';
    el.appendChild(block.wrap);
    this.mountView(block);
    this.scroll.appendChild(el);
    return block;
  }

  /** (Re)build the block's `GridView` at the current cell edge. */
  private mountView(block: Block): void {
    const view = new GridView(block.id, (defId) => this.inv.getDef(defId), (item) => this.inv.getStats(item), {
      onPointerDown: (uid, gridId, e) => this.startDrag(uid, gridId as TradeGridId, e),
      onEnter: () => { /* the hover card is `ui/hud/ItemTip` (data-item-tip) */ },
      onMove: () => { /* no-op */ },
      onLeave: () => { /* no-op */ },
      onContext: (uid, gridId, e) => this.openMenu(uid, gridId as TradeGridId, e),
      onDblClick: (uid, gridId) => { if (!this.clicksSuppressed()) this.take(uid, gridId as TradeGridId, null); },
    }, this.cellPx);
    if (block.id === 'bag') view.setFrameRows(BAG_FRAME_ROWS);
    view.setFilter(this.predicate(block.filter));
    block.wrap.appendChild(view.el);
    view.setClip(block.wrap);
    block.view = view;
  }

  private applyCellVars(): void {
    this.root.style.setProperty('--inv-cell', `${this.cellPx}px`);
    this.root.style.setProperty('--tg-step', `${this.cellPx + GAP}px`);
    this.root.classList.toggle('tg-compact', this.cellPx < CELL);
  }

  /** Several bus events in one frame (a drop fires three or four) repaint once. */
  private scheduleRefresh(): void {
    if (this.disposed || this.refreshRaf) return;
    this.refreshRaf = requestAnimationFrame(() => { this.refreshRaf = 0; this.refresh(); });
  }

  refresh(): void {
    if (this.disposed) return;
    const staged = this.opts.isStaged;
    const step = this.cellPx + GAP;
    // 2026-09-12: the needed-ammo ribbon — it uses the **same table** as the Tab window, so it is swapped here too (true only on a change)
    const ammoChanged = setNeededAmmoFrom(this.inv.getLoadout(), (item) => this.inv.getStats(item));
    for (const bl of this.blocks) {
      const grid = this.inv.getGrid(bl.id);
      if (bl.view.current !== grid) bl.view.setGrid(grid);
      else bl.view.refresh(ammoChanged);   // version-gated; only changed tiles are rebuilt
      // 2026-09-16 (user's decision): the header's `N점` (the number of defs) was dropped — the **same** `사용칸 / 전체칸` as
      // the Tab window's stash header (`labels.capacityLabel`). The bag frame's padding rows (`BAG_FRAME_ROWS`) are not cells, so they do not count.
      bl.countEl.textContent = grid ? capacityLabel(grid.usedCells(), grid.cols * grid.rows) : '';
      const w = grid ? grid.cols * step - GAP : 0;
      bl.el.classList.toggle('is-narrow', w > 0 && w < NARROW_BLOCK_PX);
      // staging can change without the grid changing (the caller calls `refresh()` after staging) — flags only
      bl.view.forEachTile((uid, tile) => {
        if (staged) tile.classList.toggle('is-staged', staged(uid));
        if (tile.dataset.itemTip === undefined) tile.dataset.itemTip = '';
        const defId = grid?.get(uid)?.item.defId;
        if (defId && tile.dataset.defId !== defId) tile.dataset.defId = defId;
        // 2026-09-14: the tile whose tooltip is pinned opts out of the `ItemTip` hover card (the pinned card is its card)
        const pinnedHere = uid === this.pin.pinnedUid;
        if (pinnedHere !== (tile.dataset.tipPinned !== undefined)) {
          if (pinnedHere) tile.dataset.tipPinned = '';
          else delete tile.dataset.tipPinned;
        }
      });
    }
    this.pin.validate();
  }

  /* ── 2026-09-13: cell size · the chip row ──────────────────────────────── */

  /** Current grid cell edge in px. */
  get cell(): number { return this.cellPx; }

  /**
   * Change the cell edge of a live view (the 기업 screen shrinks its grids to fit the window). Each block's `GridView` is
   * rebuilt at the new edge — its cell size is fixed at construction — keeping the block's filter and the **row** the
   * block was scrolled to. A drag in flight is cancelled and an open menu closes. Same edge = no-op.
   */
  setCell(px: number): void {
    if (this.disposed) return;
    const cell = clampCell(px);
    if (cell === this.cellPx) return;
    const oldStep = this.cellPx + GAP;
    this.endDrag();
    this.menu.close();
    const rows = this.blocks.map((bl) => bl.wrap.scrollTop / oldStep);
    this.cellPx = cell;
    this.applyCellVars();
    for (const bl of this.blocks) {
      bl.view.dispose();
      this.mountView(bl);
    }
    this.refresh();
    const step = cell + GAP;
    this.blocks.forEach((bl, i) => { if (rows[i] > 0) bl.wrap.scrollTop = Math.round(rows[i] * step); });
  }

  /**
   * Put a chip row that filters **every** block of this view into `host` (appended; created on first call, moved on a
   * later one) and return it. Meant for `chips: 'none'` — a caller that wants the row in its own header. Removed with
   * the view.
   */
  mountFilterChips(host: HTMLElement): HTMLElement {
    const tools = this.ensureSharedTools();
    host.appendChild(tools);
    return tools;
  }

  private ensureSharedTools(): HTMLElement {
    if (this.sharedTools) return this.sharedTools;
    const tools = document.createElement('div');
    tools.className = 'tg-tools';
    this.sharedChips = buildFilterSelect((id) => this.setFilter(id));
    this.sharedChips.set(this.sharedFilter);
    tools.appendChild(this.sharedChips.el);
    this.sharedTools = tools;
    return tools;
  }

  /* ── 2026-09-12: sort · filter ─────────────────────────────────────────── */

  private sort(id: TradeGridId): void {
    this.endDrag();
    const r = this.inv.sortGrid(id, this.opts.isStaged);
    if (r === 'ok') this.inv.sfx('ui_drop');
    else if (r === 'fail') {
      this.inv.sfx('ui_error');
      this.ctx.bus.emit('ui:notify', { text: '정렬할 자리가 부족합니다 — 격자를 조금 비워 주세요', kind: 'warning', duration: 2.2 });
    }
    this.refresh();
  }

  private predicate(id: FilterGroupId): ReturnType<typeof filterPredicate> {
    return filterPredicate(id, (defId) => this.inv.isFavorite(defId));
  }

  /** The shared row's pick — applies to every block (and lights each block's own row, if it has one). */
  private setFilter(id: FilterGroupId): void {
    this.sharedFilter = id;
    this.sharedChips?.set(id);
    for (const bl of this.blocks) this.setBlockFilter(bl, id);
  }

  private setBlockFilter(bl: Block, id: FilterGroupId): void {
    bl.filter = id;
    bl.chips?.set(id);
    bl.view.setFilter(this.predicate(id));
  }

  /** The chip currently lit (smoke tests): the shared row's, else the first block's. */
  get filterGroup(): FilterGroupId { return this.sharedChips ? this.sharedFilter : this.blocks[0]?.filter ?? 'all'; }

  /* ── drag: moves inside a grid / between grids · dragging out to the caller's tray ─ */
  /**
   * 2026-09-14: a press no longer lifts the ghost at once. The tile is only **pressed** until the pointer moves past
   * `DRAG_THRESHOLD` — then the ghost lifts exactly as before (`liftGhost`). Holding still for `UI_HOLD_CONFIRM_S` pins the
   * item's tooltip instead (`TipPin.beginHold`, whose fire drops the press). A release without moving is a plain click.
   */
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
    this.endDrag();
    this.press = { uid, gridId, el, x: e.clientX, y: e.clientY };
    this.moveX = e.clientX;
    this.moveY = e.clientY;
    window.addEventListener('pointermove', this.onMove, true);
    window.addEventListener('pointerup', this.onUp, true);
    window.addEventListener('pointercancel', this.onCancel, true);
    this.pin.beginHold(uid, e.clientX, e.clientY, () => this.endDrag());
  }

  /** The press moved past the threshold: lift the ghost (the pick-up a press did at once before 2026-09-14). */
  private liftGhost(): boolean {
    const pr = this.press;
    this.press = null;
    const grid = pr ? this.inv.getGrid(pr.gridId) : null;
    const p = pr ? grid?.get(pr.uid) : undefined;
    const def = p ? this.inv.getDef(p.item.defId) : undefined;
    if (!pr || !grid || !p || !def) { this.endDrag(); return false; }
    this.drag = {
      uid: pr.uid, gridId: pr.gridId, from: { kind: 'grid', grid: pr.gridId }, def,
      rotated: p.item.rotated, ghost: this.makeGhost(), halfW: 0, halfH: 0, held: false, armed: false,
    };
    this.rebuildGhost(this.drag);
    this.blockOf(pr.gridId)?.view.setDragging(pr.uid);
    window.addEventListener('keydown', this.onKey, true);   // 2026-09-16: R rotate — only while dragging (no key is listened to otherwise)
    this.inv.sfx('ui_pickup');
    return true;
  }

  /** The empty `<body>` ghost box (content is written by `rebuildGhost`, which a rotation runs again). */
  private makeGhost(): HTMLElement {
    const ghost = document.createElement('div');
    ghost.classList.add('tg-ghost');
    // the ghost lives on <body>, outside this root — carry the cell edge the tile content scales with
    ghost.style.setProperty('--inv-cell', `${this.cellPx}px`);
    if (this.cellPx < CELL) ghost.classList.add('tg-compact');
    document.body.appendChild(ghost);
    return ghost;
  }

  /** Footprint the ghost occupies right now (`R` swaps width and height without touching the item). */
  private footprint(d: DragInfo): { w: number; h: number } {
    return d.rotated ? { w: d.def.height, h: d.def.width } : { w: d.def.width, h: d.def.height };
  }

  /** Redraw the ghost at the current rotation and re-centre it on the cursor (the footprint changed). */
  private rebuildGhost(d: DragInfo): void {
    const item = this.inv.findItem(d.uid, d.from);
    if (!item) return;
    const { w, h } = this.footprint(d);
    buildTileContent(d.ghost, { ...item, rotated: d.rotated }, d.def, w, h, this.inv.getStats(item), this.cellPx);
    d.ghost.classList.add('tg-ghost');
    if (this.cellPx < CELL) d.ghost.classList.add('tg-compact');
    const size = tileSizeAt(w, h, this.cellPx);
    d.halfW = size.width / 2;
    d.halfH = size.height / 2;
    d.ghost.style.transform = `translate3d(${this.moveX - d.halfW}px, ${this.moveY - d.halfH}px, 0)`;
  }

  private onMove = (e: PointerEvent): void => {
    if (!this.drag && !this.press) return;
    this.moveX = e.clientX;
    this.moveY = e.clientY;
    if (!this.drag) {
      const pr = this.press;
      if (!pr || Math.hypot(e.clientX - pr.x, e.clientY - pr.y) < DRAG_THRESHOLD) return;
      this.pin.cancelHold();
      if (!this.liftGhost()) return;
    }
    if (!this.moveRaf) this.moveRaf = requestAnimationFrame(this.moveFrame);
  };

  /** One ghost write + one hit test per frame, however many pointermove events arrived. */
  private moveFrame = (): void => {
    this.moveRaf = 0;
    const d = this.drag;
    if (!d) return;
    d.ghost.style.transform = `translate3d(${this.moveX - d.halfW}px, ${this.moveY - d.halfH}px, 0)`;
    this.hideHighlights();
    // the caller's tray comes **first** — the corp trade's 판매 tray does not overlap the grids, so keeping the order keeps it as before
    const tray = this.dropTargetAt(this.moveX, this.moveY);
    this.setOver(tray);
    if (tray) { d.ghost.classList.toggle('is-ok', true); return; }
    const hit = this.cellUnderGhost(d);
    if (!hit) { d.ghost.classList.toggle('is-ok', false); return; }
    const pv = this.inv.previewDrop(d.uid, d.from, this.targetOf(d, hit));
    const { w, h } = this.footprint(d);
    const state: HighlightState = pv === 'bad' ? 'bad' : pv === 'swap' ? 'swap' : pv === 'merge' ? 'merge' : 'ok';
    hit.bl.view.showHighlight(hit.x, hit.y, w, h, state);
    d.ghost.classList.toggle('is-ok', pv !== 'bad');
  };

  /**
   * Cell of one of **this view's** grids under the ghost, resolved **strictly first** — a grid that really contains
   * the pointer beats one that only sits within its half-cell tolerance, so the stash and the bag (side by side with a gap)
   * never steal each other's edge column. Same two-pass order as the Tab window (`ui/parts/Drag.resolveGridTarget`).
   */
  private cellUnderGhost(d: DragInfo): { bl: Block; x: number; y: number } | null {
    const { w, h } = this.footprint(d);
    return this.cellAt(this.moveX - d.halfW, this.moveY - d.halfH, w, h, this.moveX, this.moveY);
  }

  private targetOf(d: DragInfo, hit: { bl: Block; x: number; y: number }): DropTarget {
    return { kind: 'grid', grid: hit.bl.id, x: hit.x, y: hit.y, rotated: d.rotated };
  }

  private onUp = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d) { this.endDrag(); return; }
    if (d.held) {
      // a merge remainder is put down on the release of the **next** press (`onHeldDown` arms it)
      if (e.type === 'pointercancel') { this.endDrag(); return; }
      if (!d.armed || e.button !== 0) return;
      d.armed = false;
    }
    this.moveX = e.clientX;
    this.moveY = e.clientY;
    this.endDrag();
    this.finishDrop(d);
  };

  /**
   * Release: the caller's tray first (`onTake` — the item is **not** moved here), else a cell of the stash / bag through
   * `InventoryRef.drop`. Released over neither, the item simply stays where it was — this view has no drop zone, so
   * nothing can be lost by missing.
   */
  private finishDrop(d: DragInfo): void {
    const tray = this.dropTargetAt(this.moveX, this.moveY);
    if (tray) { this.take(d.uid, d.gridId, tray); return; }
    const hit = this.cellUnderGhost(d);
    if (!hit) { if (d.held) this.inv.sfx('ui_drop'); return; }
    const target = this.targetOf(d, hit);
    // the 2026-09-12 rule unchanged: the merge judgement and the source quantity are read **before** the drop — the remainder is what did not move
    const pv = this.inv.previewDrop(d.uid, d.from, target);
    const r = this.inv.drop(d.uid, d.from, target);
    if (r === 'ok') this.inv.sfx('ui_drop');
    else if (r === 'fail') { this.inv.sfx('ui_error'); this.blockOf(d.gridId)?.view.shake(d.uid); }
    this.refresh();
    if (r !== 'ok' || pv !== 'merge') return;
    const src = this.inv.findItem(d.uid, d.from);
    if (src && src.qty > 0) this.holdRemainder(d);
  }

  /**
   * 2026-09-16 (the same rule as the Tab window's `DragState.held`): whatever the target stack could not take **stays on the
   * cursor**. That quantity never left the source stack (it only dropped), so the item is still in place even if a save · a
   * corpse strip · a window close cuts in. The next left-click places it; right-click · Escape · empty space · `dispose` let it go.
   */
  private holdRemainder(prev: DragInfo): void {
    const item = this.inv.findItem(prev.uid, prev.from);
    if (!item) return;
    const d: DragInfo = {
      uid: prev.uid, gridId: prev.gridId, from: prev.from, def: prev.def,
      rotated: item.rotated, ghost: this.makeGhost(), halfW: 0, halfH: 0, held: true, armed: false,
    };
    this.drag = d;
    this.rebuildGhost(d);
    window.addEventListener('pointermove', this.onMove, true);
    window.addEventListener('pointerup', this.onUp, true);
    window.addEventListener('pointercancel', this.onCancel, true);
    window.addEventListener('pointerdown', this.onHeldDown, true);
    window.addEventListener('keydown', this.onKey, true);
    this.moveFrame();
  }

  /** A press while a remainder is held: swallow it (no tile press underneath) and arm the release. RMB lets go. */
  private onHeldDown = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d?.held) return;
    e.preventDefault();
    e.stopPropagation();
    this.suppressUntil = performance.now() + CLICK_SUPPRESS_MS;
    if (e.button === 2) { this.endDrag(); this.inv.sfx('ui_drop'); return; }
    if (e.button !== 0) return;
    this.moveX = e.clientX;
    this.moveY = e.clientY;
    d.armed = true;
    this.moveFrame();
  };

  /**
   * `R` rotates the ghost while a drag is in flight (`Keys.ROTATE_ITEM`, read at use time), Escape lets a held
   * remainder go. The listener exists **only for the length of a drag** — this view still installs no standing window
   * key listener, so an embedded screen keeps every key it owns.
   */
  private onKey = (e: KeyboardEvent): void => {
    const d = this.drag;
    if (!d) return;
    if (e.code === Keys.ROTATE_ITEM) {
      if (d.def.width === d.def.height) return;
      e.preventDefault();
      e.stopPropagation();
      d.rotated = !d.rotated;
      this.rebuildGhost(d);
      this.inv.sfx('ui_rotate');
      this.moveFrame();
      return;
    }
    if (d.held && e.code === Keys.MENU) { e.preventDefault(); e.stopPropagation(); this.endDrag(); }
  };

  private onCancel = (): void => { this.endDrag(); };

  private blockOf(id: TradeGridId): Block | undefined { return this.blocks.find((bl) => bl.id === id); }

  private clicksSuppressed(): boolean { return performance.now() < this.suppressUntil; }

  private hideHighlights(): void { for (const bl of this.blocks) bl.view.hideHighlight(); }

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
    this.press = null;
    this.pin.cancelHold();
    if (this.moveRaf) { cancelAnimationFrame(this.moveRaf); this.moveRaf = 0; }
    this.setOver(null);
    window.removeEventListener('pointermove', this.onMove, true);
    window.removeEventListener('pointerup', this.onUp, true);
    window.removeEventListener('pointercancel', this.onCancel, true);
    window.removeEventListener('pointerdown', this.onHeldDown, true);
    window.removeEventListener('keydown', this.onKey, true);
    this.hideHighlights();
    for (const bl of this.blocks) bl.view.setDragging(null);
    if (!d) return;
    d.ghost.remove();
  }

  /* ── 2026-09-14: dragging a socket out of the pinned card — this view's answers to `TipPin` ──────────────── */

  /** The ghost of an attachment pulled out of a pinned weapon card — the same `.tg-ghost` a tile drag lifts. */
  private buildSocketGhost(item: ItemInstance, def: ItemDef): { el: HTMLElement; halfW: number; halfH: number } {
    const w = item.rotated ? def.height : def.width, h = item.rotated ? def.width : def.height;
    const ghost = document.createElement('div');
    buildTileContent(ghost, item, def, w, h, null, this.cellPx);
    ghost.classList.add('tg-ghost');
    ghost.style.setProperty('--inv-cell', `${this.cellPx}px`);
    if (this.cellPx < CELL) ghost.classList.add('tg-compact');
    const size = tileSizeAt(w, h, this.cellPx);
    return { el: ghost, halfW: size.width / 2, halfH: size.height / 2 };
  }

  /** A cell of this view's 가방 / 함선 창고 under the pointer (strict containment first, then the half-cell tolerance). */
  private aimDetach(px: number, py: number, d: SocketDrag): DetachAim | null {
    this.clearDetachAim();
    const rotated = d.item.rotated;
    const w = rotated ? d.def.height : d.def.width, h = rotated ? d.def.width : d.def.height;
    const size = tileSizeAt(w, h, this.cellPx);
    const hit = this.cellAt(px - size.width / 2, py - size.height / 2, w, h, px, py);
    if (!hit) return null;
    const target: DetachTarget = { kind: 'grid', grid: hit.bl.id, x: hit.x, y: hit.y, rotated };
    const ok = this.inv.previewDetach(d.weaponUid, d.socket, target) === 'ok';
    hit.bl.view.showHighlight(hit.x, hit.y, w, h, ok ? 'ok' : 'bad');
    return { target, ok };
  }

  private clearDetachAim(): void { this.hideHighlights(); }

  /* ── 2026-09-16: an item from **outside** the grids into the cell under the cursor (`TradeGridsView.placeExternalAt`) ─ */

  /**
   * Puts what a furniture screen **pulled out** of its own cell (a shelf's book · a cluster's core · a station's product) into the cell under
   * the cursor. Finding the cell is the **same two-pass judgement** as a tile drag (`cellUnderGhost`), so the highlight and the landing cell agree.
   *
   * The judgement is one rule, 「nothing is displaced」: a free spot takes it, a matching stack merges, anything else is refused
   * with `'blocked'` (no one else's item is moved aside or slipped into another cell — the same spirit as the Tab window's drop
   * rules). Outside the grids it is `null`, so the caller places it by its own rule (bag first · stash first).
   */
  placeExternalAt(item: ItemInstance, x: number, y: number): 'bag' | 'stash' | 'blocked' | null {
    if (this.disposed) return null;
    const def = this.inv.getDef(item.defId);
    if (!def) return null;
    /* 2026-09-19 (audit B-38): **the footprint is the def's own orientation**, never `item.rotated`. The promise above is
       that the preview and this run the same hit test, and the contract's preview (`TradeGridsView.previewExternalAt`,
       `src/shared`) carries no rotation to run it with — an external drag has no rotate gesture, so there is nothing to
       carry. Measuring a rotated instance here instead would highlight one cell and fill another. The instance is
       normalised to match, so what lands is exactly what was lit. */
    item.rotated = false;
    const size = tileSizeAt(def.width, def.height, this.cellPx);
    const hit = this.cellAt(x - size.width / 2, y - size.height / 2, def.width, def.height, x, y);
    if (!hit) return null;
    const grid = this.inv.getGrid(hit.bl.id);
    if (!grid) return null;
    const occupant = grid.at(hit.x, hit.y)?.item;
    if (occupant) {
      /* A matching stack merges (the same as dragging from the bag). It is touched **only when all of it fits** — the room is
         measured before `mergeInto` is called, so 「half moved and then refused」 cannot happen (an unmergeable pair returns 0).
         `mergeInto` also compares the stack keys (raid-found mark · meal quality), which the preview cannot see — it has a def
         id, not an instance — so a `merge` highlight over a differently marked stack still ends as `'blocked'` here. */
      if (def.stackMax - occupant.qty < item.qty || grid.mergeInto(item, occupant.uid) <= 0) return 'blocked';
    } else if (!grid.place(item, hit.x, hit.y, false)) {
      return 'blocked';
    }
    this.inv.afterChange();
    this.inv.sfx('ui_drop');
    this.refresh();
    return hit.bl.id;
  }

  /**
   * 2026-09-17 (user's report 「가구에서 끌어낸 것은 창고 · 가방 **전체**가 아니라 커서 밑 **칸**이 강조돼야 한다」):
   * a **preview** of the judgement `placeExternalAt` would make — the same cell search (`cellAt`), the same def-orientation
   * footprint and the same 「nothing is displaced」 rule paint it (`showHighlight`, the same `.inv-hl` as a tile drag).
   * Nothing changes; a merge is `merge` only when all of it fits. The one thing it cannot see is the **stack key** of a
   * marked stack (it is handed a def id, not an instance), so a `merge` here can still end as `'blocked'` there.
   */
  previewExternalAt(defId: string, qty: number, x: number, y: number): 'ok' | 'merge' | 'bad' | null {
    this.hideHighlights();
    if (this.disposed) return null;
    const def = this.inv.getDef(defId);
    if (!def) return null;
    const size = tileSizeAt(def.width, def.height, this.cellPx);
    const hit = this.cellAt(x - size.width / 2, y - size.height / 2, def.width, def.height, x, y);
    if (!hit) return null;
    const grid = this.inv.getGrid(hit.bl.id);
    if (!grid) return null;
    const occupant = grid.at(hit.x, hit.y)?.item;
    let state: 'ok' | 'merge' | 'bad';
    if (occupant) {
      state = occupant.defId === defId && def.stackMax > 1 && def.stackMax - occupant.qty >= qty ? 'merge' : 'bad';
    } else {
      const probe: ItemInstance = { uid: '', defId, qty, rotated: false };
      state = grid.canPlace(probe, hit.x, hit.y, false, '') ? 'ok' : 'bad';
    }
    hit.bl.view.showHighlight(hit.x, hit.y, def.width, def.height, state);
    return state;
  }

  clearExternalPreview(): void { if (!this.drag) this.hideHighlights(); }

  /** Cell of one of this view's grids under a ghost box — the two-pass order every drop path here shares. */
  private cellAt(left: number, top: number, w: number, h: number, px: number, py: number): { bl: Block; x: number; y: number } | null {
    for (const bl of this.blocks) {
      if (!bl.view.hitTest(px, py, 0)) continue;
      const c = bl.view.cellForGhost(left, top, w, h, px, py, 0);
      if (c) return { bl, x: c.x, y: c.y };
    }
    for (const bl of this.blocks) {
      const c = bl.view.cellForGhost(left, top, w, h, px, py);
      if (c) return { bl, x: c.x, y: c.y };
    }
    return null;
  }

  private take(uid: string, gridId: TradeGridId, target: HTMLElement | null): void {
    const p = this.inv.getGrid(gridId)?.get(uid);
    if (!p) return;
    this.opts.onTake?.(p.item, gridId, target);
  }

  /** 2026-09-12: the right-click menu — this screen's double-click action (`takeLabel`) · favourite on / off (the same wording as the Tab window's `favoriteEntry`). */
  private openMenu(uid: string, gridId: TradeGridId, e: MouseEvent): void {
    if (this.drag || this.disposed || this.clicksSuppressed()) return;
    const p = this.inv.getGrid(gridId)?.get(uid);
    if (!p) return;
    const defId = p.item.defId;
    const entries: MenuEntry[] = [];
    if (this.opts.onTake) {
      entries.push({ label: this.opts.takeLabel ?? '빠른 이동', hint: '더블클릭', run: () => this.take(uid, gridId, null) });
    }
    const on = this.inv.isFavorite(defId);
    entries.push({
      label: on ? TEXT.menu.favoriteOff : TEXT.menu.favoriteOn,
      separator: entries.length > 0,
      run: () => { this.inv.toggleFavorite(defId); this.ctx.bus.emit('audio:play', { id: 'ui_click' }); },
    });
    this.menu.open(e.clientX, e.clientY, entries);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.menu.dispose();
    this.endDrag();
    this.pin.dispose();          // 2026-09-14: the pinned card and its socket hover card go with the view
    this.hoverTip.dispose();
    if (this.refreshRaf) { cancelAnimationFrame(this.refreshRaf); this.refreshRaf = 0; }
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    for (const bl of this.blocks) bl.view.dispose();
    // 2026-09-16: the filter list is a child of `document.body` (`shared/dropdown`), so it would stay on screen alone after the view is removed
    for (const bl of this.blocks) bl.chips?.dispose();
    this.sharedChips?.dispose();
    this.sharedTools?.remove();
    this.root.remove();
  }
}
