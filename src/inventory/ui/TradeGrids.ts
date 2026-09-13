import type { EmbeddedView, GameContext, ItemInstance, TradeGridsView } from '@/shared';
import type { InventorySystem, GridId } from '../InventorySystem';
import { BAG_FRAME_ROWS, filterPredicate, type FilterGroupId } from '../model';
import { GridView, buildTileContent, setNeededAmmoFrom } from './GridView';
import { buildFilterChips, buildSortButton, type FilterChips } from './GridTools';
import { CELL, GAP, TEXT, tileSizeAt } from './labels';
import { ContextMenu, type MenuEntry } from './ContextMenu';

/** Which of the player's grids a trade screen may show, top to bottom. */
export type TradeGridId = Extract<GridId, 'bag' | 'stash'>;

/**
 * 2026-09-13: how the blocks share the view.
 *   - `'wrap'` (default — the layout every caller had before): one `.tg-scroll` box that scrolls, blocks side by side,
 *     `flex-wrap` drops a block to the next line when the column is too narrow. The caller's stylesheet may still give
 *     each block its own scroll (`housing.css` `.hs-inv`).
 *   - `'split'`: **every block scrolls itself** — `.tg-scroll` becomes a frameless, non-scrolling `nowrap` row, each
 *     block stretches to the view's height and its `.tg-gridwrap` is the scroller (`scrollbar-gutter: stable`). A block
 *     is exactly as wide as its grid (+ scrollbar room): the header and the chip row never widen it. Meant for a view with
 *     **one** grid mounted into a caller-owned card (기업 화면: 함선 창고 card + 가방 card), but works with two.
 */
export type TradeGridsLayout = 'wrap' | 'split';
/**
 * 2026-09-13: where the filter chips go. `'shared'` = one row above every block (drives all of them; the `'wrap'`
 * default), `'block'` = each block's own row under its header with its own filter (the `'split'` default), `'none'` =
 * no chips inside the view — the caller may still place one shared row anywhere with `mountFilterChips(host)`.
 */
export type TradeGridsChips = 'shared' | 'block' | 'none';

export interface TradeGridsOptions {
  /** Grids to render, in order. Default (2026-09-12, 사용자 결정): **함선 창고가 왼쪽, 내 가방이 오른쪽**. */
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
   * 가방 / 함선 창고 grids match the 5-column 구매 / 판매 tray beside them. Change it later with `setCell`.
   */
  cell?: number;
  /**
   * 2026-09-12: 우클릭 메뉴의 첫 항목 이름 — 이 화면의 더블클릭(`onTake`)이 하는 일. 기본 `빠른 이동`.
   * `onTake` 가 없으면 그 항목 자체가 없다 (메뉴에는 즐겨찾기만).
   */
  takeLabel?: string;
  /** 2026-09-13: see `TradeGridsLayout`. Default `'wrap'`. */
  layout?: TradeGridsLayout;
  /** 2026-09-13: see `TradeGridsChips`. Default `'shared'` for `'wrap'`, `'block'` for `'split'`. */
  chips?: TradeGridsChips;
}

interface Block {
  id: TradeGridId;
  el: HTMLElement;
  view: GridView;
  countEl: HTMLElement;
  /** The box around the grid — the scroller in `'split'` (and in `housing.css`'s `.hs-inv`). */
  wrap: HTMLElement;
  /** This block's own chip row (`chips: 'block'`), else null. */
  chips: FilterChips | null;
  filter: FilterGroupId;
}

interface DragInfo {
  uid: string;
  gridId: TradeGridId;
  ghost: HTMLElement;
  el: HTMLElement;
  /** Half the ghost's size, known at pick-up (never measured while moving — that forced a layout per event). */
  halfW: number;
  halfH: number;
}

/** Smallest cell edge a caller can ask for (tiles stop being legible well before this). */
const MIN_CELL = 16;
/** A block whose grid is narrower than this lays its own chip row out as two rows of five (the 가방 at a 40 px cell). */
const NARROW_BLOCK_PX = 260;

const clampCell = (px: number | undefined): number => Math.max(MIN_CELL, Math.round(px ?? CELL));

/**
 * **Embedded 가방 / 함선 창고 grids** (Phase 9 UI pass) — real inventory grids, rendered by the same `GridView` the
 * Tab window uses, for another folder's screen (기업 거래 · 재배 스테이션 · 분석기 · 배양조 · 식탁).
 *
 * Scope on purpose: a **read + drag-out** view, not the full inventory window. There is no rearranging, no rotation,
 * no socketing and no drop-to-world — a tile can only be dragged onto one of the caller's `dropSelector` targets (or
 * double-clicked), which calls `onTake`. Everything the trade then does to the item goes through the public
 * `InventoryRef` API in the caller.
 *
 * **2026-09-12 (사용자 결정)** —
 *   - **창고가 왼쪽, 가방이 오른쪽**으로 나란히 선다 (`.tg-scroll` 이 가로 2열). 한 스크롤 안에 위아래로 쌓던 앞
 *     배치는 긴 가방 틀 때문에 창고를 아래로 밀어냈다. 폭이 모자라면 `flex-wrap` 이 가방을 스스로 아랫줄로
 *     내린다. 가방은 가로 5칸 · 틀 높이는 가장 긴 가방(`BAG_FRAME_ROWS`), 창고는 가로 10칸 — Tab 인벤토리와 똑같다.
 *     ⚠ 세로가 되면 두 격자가 **한 스크롤에 이어 붙는다**: 창고 24행 = 1381 px · 가방 틀 12행 = 709 px 인데
 *     스크롤 창은 600 px 남짓이라 **어느 쪽을 위에 올려도 다른 쪽이 화면 밖**이고, 끄는 중에는 스크롤할 수 없어
 *     그 방향의 드래그가 통째로 막힌다. 그래서 두 열이 못 들어가는 화면은 블록마다 자기 스크롤을 준다 —
 *     2026-09-13 부터는 `layout: 'split'` 이 그것을 이 뷰 안에서 한다.
 *   - 머리에 **정렬** 버튼(`InventorySystem.sortGrid` — 이 뷰가 인벤토리를 바꾸는 유일한 동작이다. 호출자가 트레이에 올린
 *     uid 는 `isStaged` 로 넘겨 합치기에서 뺀다)과 **필터 칩**(걸러진 타일은 어두워질 뿐 자리를 지킨다).
 *   - 드래그는 pointermove 를 **rAF 한 번으로 합치고** 고스트를 `transform` 으로 옮긴다. 버스 이벤트 여러 개가 한 프레임에
 *     오면 갱신도 한 번이고, `GridView` 가 바뀐 타일만 다시 그린다.
 *
 * **2026-09-13 (기업 화면 카드 분리)** — `layout: 'split'` · `chips: 'block' | 'none'` · `mountFilterChips(host)` ·
 * `setCell(px)` (살아 있는 뷰의 칸 크기를 바꾼다: 블록의 `GridView` 를 새 칸으로 다시 짓고 필터 · 스크롤 줄 위치는 지킨다).
 * 칸이 기본(54)보다 작으면 루트에 `.tg-compact` 가 붙어 타일 글리프 · 수량 배지 · 소켓 핍이 칸 크기를 따라 줄어든다.
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
  /** The one chip row that drives every block (`chips: 'shared'`, or created by `mountFilterChips`). */
  private sharedChips: FilterChips | null = null;
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
   * 2026-09-12 (사용자 결정 「모든 아이템 우클릭 = 메뉴」): 빠른 이동(= 더블클릭) · 즐겨찾기. `ctx.uiRoot` 에 붙인다 —
   * `.inv-menu` 는 `position: fixed` 라 transform 이 걸린 화면 안에 두면 자리가 어긋난다.
   */
  private readonly menu: ContextMenu;

  constructor(
    private readonly inv: InventorySystem,
    private readonly ctx: GameContext,
    host: HTMLElement,
    private readonly opts: TradeGridsOptions = {},
  ) {
    const split = opts.layout === 'split';
    this.chipsMode = opts.chips ?? (split ? 'block' : 'shared');
    this.root = document.createElement('div');
    this.root.className = `trade-grids${split ? ' is-split' : ''}${opts.className ? ` ${opts.className}` : ''}`;
    host.appendChild(this.root);
    this.menu = new ContextMenu(ctx.uiRoot);
    this.menu.el.classList.add('tg-menu');

    this.cellPx = clampCell(opts.cell);
    this.applyCellVars();

    if (this.chipsMode === 'shared') this.root.appendChild(this.ensureSharedTools());
    this.scroll = document.createElement('div');
    this.scroll.className = 'tg-scroll';
    this.root.appendChild(this.scroll);

    // 2026-09-12 (사용자 결정): 창고 왼쪽 · 가방 오른쪽. 호출자가 `grids` 를 직접 주면 그 순서가 이긴다.
    const ids = opts.grids ?? (['stash', 'bag'] as const);
    for (const id of ids) this.blocks.push(this.buildBlock(id));

    const b = this.ctx.bus;
    const repaint = (): void => this.scheduleRefresh();
    this.unsubs.push(
      b.on('inventory:changed', repaint), b.on('inventory:stashChanged', repaint),
      b.on('inventory:bagChanged', repaint), b.on('loadout:changed', repaint),
      // 2026-09-12 (E1): 즐겨찾기 띠 · 「즐겨찾기」 필터 — `GridView.refresh` 가 즐겨찾기 리비전을 보고 다시 칠한다
      b.on('inventory:favoritesChanged', repaint),
    );
    this.refresh();
  }

  /** One block: header (label · count · 정렬), optional chip row, the grid inside its wrap. */
  private buildBlock(id: TradeGridId): Block {
    const el = document.createElement('div');
    el.className = `tg-block tg-${id}`;
    el.dataset.tgGrid = id;   // 2026-09-12: 다른 화면이 드롭 위치를 가방 / 창고로 가른다 (`closest('[data-tg-grid]')`)
    const head = document.createElement('div');
    head.className = 'tg-head';
    const label = document.createElement('span');
    label.className = 'tg-label';
    label.textContent = id === 'bag' ? '내 가방' : '함선 창고';
    const countEl = document.createElement('span');
    countEl.className = 'tg-count';
    head.append(label, countEl, buildSortButton(() => this.sort(id)));
    el.appendChild(head);
    const block: Block = { id, el, view: null as unknown as GridView, countEl, wrap: document.createElement('div'), chips: null, filter: 'all' };
    if (this.chipsMode === 'block') {
      const tools = document.createElement('div');
      tools.className = 'tg-tools';
      block.chips = buildFilterChips((f) => this.setBlockFilter(block, f));
      tools.appendChild(block.chips.el);
      // a narrow block (`.is-narrow`) lays its chips out in two even rows — half the chip count per row, rounded up
      tools.style.setProperty('--tg-chip-cols', String(Math.ceil(block.chips.el.childElementCount / 2)));
      el.appendChild(tools);
    }
    // 2026-09-12: 격자는 **자기 폭을 px 로 못박은** 상자다(`GridView.syncDims`). 그래서 세로 스크롤을 격자 자신에게
    // 걸면 스크롤바가 그 폭 안에서 자리를 빼앗아 마지막 열이 잘린다 — 폭이 내용에서 나오는 이 상자가 대신 맡는다
    // (`Tab` 인벤토리의 `.inv-bag-scroll` 과 같은 방식). `'wrap'` 기본값에서는 아무것도 하지 않는다.
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
      onDblClick: (uid, gridId) => this.take(uid, gridId as TradeGridId, null),
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
    // 2026-09-12: 내게 필요한 탄약의 사선 띠 — Tab 창과 **같은 표**를 쓰므로 여기서도 갈아 끼운다 (바뀔 때만 true)
    const ammoChanged = setNeededAmmoFrom(this.inv.getLoadout(), (item) => this.inv.getStats(item));
    for (const bl of this.blocks) {
      const grid = this.inv.getGrid(bl.id);
      if (bl.view.current !== grid) bl.view.setGrid(grid);
      else bl.view.refresh(ammoChanged);   // version-gated; only changed tiles are rebuilt
      bl.countEl.textContent = grid ? `${grid.count}점` : '';
      const w = grid ? grid.cols * step - GAP : 0;
      bl.el.classList.toggle('is-narrow', w > 0 && w < NARROW_BLOCK_PX);
      // staging can change without the grid changing (the caller calls `refresh()` after staging) — flags only
      bl.view.forEachTile((uid, tile) => {
        if (staged) tile.classList.toggle('is-staged', staged(uid));
        if (tile.dataset.itemTip === undefined) tile.dataset.itemTip = '';
        const defId = grid?.get(uid)?.item.defId;
        if (defId && tile.dataset.defId !== defId) tile.dataset.defId = defId;
      });
    }
  }

  /* ── 2026-09-13: 칸 크기 · 칩 줄 ───────────────────────────────────────── */

  /** Current grid cell edge in px. */
  get cell(): number { return this.cellPx; }

  /**
   * Change the cell edge of a live view (the 기업 화면 shrinks its grids to fit the window). Each block's `GridView` is
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
    this.sharedChips = buildFilterChips((id) => this.setFilter(id));
    this.sharedChips.set(this.sharedFilter);
    tools.appendChild(this.sharedChips.el);
    this.sharedTools = tools;
    return tools;
  }

  /* ── 2026-09-12: 정렬 · 필터 ───────────────────────────────────────────── */

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
    this.endDrag();
    const fp = grid.footprintOf(p.item);
    const size = tileSizeAt(fp.w, fp.h, this.cellPx);
    const ghost = document.createElement('div');
    buildTileContent(ghost, p.item, def, fp.w, fp.h, this.inv.getStats(p.item), this.cellPx);
    ghost.classList.add('tg-ghost');
    // the ghost lives on <body>, outside this root — carry the cell edge the tile content scales with
    ghost.style.setProperty('--inv-cell', `${this.cellPx}px`);
    if (this.cellPx < CELL) ghost.classList.add('tg-compact');
    const halfW = size.width / 2, halfH = size.height / 2;
    ghost.style.transform = `translate3d(${e.clientX - halfW}px, ${e.clientY - halfH}px, 0)`;
    document.body.appendChild(ghost);
    el.classList.add('is-dragging');
    this.drag = { uid, gridId, ghost, el, halfW, halfH };
    window.addEventListener('pointermove', this.onMove, true);
    window.addEventListener('pointerup', this.onUp, true);
    window.addEventListener('pointercancel', this.onCancel, true);
  }

  private onMove = (e: PointerEvent): void => {
    if (!this.drag) return;
    this.moveX = e.clientX;
    this.moveY = e.clientY;
    if (!this.moveRaf) this.moveRaf = requestAnimationFrame(this.moveFrame);
  };

  /** One ghost write + one hit test per frame, however many pointermove events arrived. */
  private moveFrame = (): void => {
    this.moveRaf = 0;
    const d = this.drag;
    if (!d) return;
    d.ghost.style.transform = `translate3d(${this.moveX - d.halfW}px, ${this.moveY - d.halfH}px, 0)`;
    const target = this.dropTargetAt(this.moveX, this.moveY);
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

  private onCancel = (): void => { this.endDrag(); };

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
    if (this.moveRaf) { cancelAnimationFrame(this.moveRaf); this.moveRaf = 0; }
    this.setOver(null);
    window.removeEventListener('pointermove', this.onMove, true);
    window.removeEventListener('pointerup', this.onUp, true);
    window.removeEventListener('pointercancel', this.onCancel, true);
    if (!d) return;
    d.ghost.remove();
    d.el.classList.remove('is-dragging');
  }

  private take(uid: string, gridId: TradeGridId, target: HTMLElement | null): void {
    const p = this.inv.getGrid(gridId)?.get(uid);
    if (!p) return;
    this.opts.onTake?.(p.item, gridId, target);
  }

  /** 2026-09-12: 우클릭 메뉴 — 이 화면의 더블클릭 동작(`takeLabel`) · 즐겨찾기 켜기 / 끄기 (Tab 창의 `favoriteEntry` 와 같은 문구). */
  private openMenu(uid: string, gridId: TradeGridId, e: MouseEvent): void {
    if (this.drag || this.disposed) return;
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
    if (this.refreshRaf) { cancelAnimationFrame(this.refreshRaf); this.refreshRaf = 0; }
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    for (const bl of this.blocks) bl.view.dispose();
    this.sharedTools?.remove();
    this.root.remove();
  }
}
