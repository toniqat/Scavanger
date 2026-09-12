import type { EmbeddedView, GameContext, ItemInstance } from '@/shared';
import type { InventorySystem, GridId } from '../InventorySystem';
import { BAG_FRAME_ROWS, filterPredicate, type FilterGroupId } from '../model';
import { GridView, buildTileContent, setNeededAmmoFrom } from './GridView';
import { buildFilterChips, buildSortButton, type FilterChips } from './GridTools';
import { CELL, GAP, TEXT, tileSizeAt } from './labels';
import { ContextMenu, type MenuEntry } from './ContextMenu';

/** Which of the player's grids a trade screen may show, top to bottom. */
export type TradeGridId = Extract<GridId, 'bag' | 'stash'>;

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
   * 가방 / 함선 창고 grids match the 5-column 구매 / 판매 tray beside them.
   */
  cell?: number;
  /**
   * 2026-09-12: 우클릭 메뉴의 첫 항목 이름 — 이 화면의 더블클릭(`onTake`)이 하는 일. 기본 `빠른 이동`.
   * `onTake` 가 없으면 그 항목 자체가 없다 (메뉴에는 즐겨찾기만).
   */
  takeLabel?: string;
}

interface Block {
  id: TradeGridId;
  view: GridView;
  countEl: HTMLElement;
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
 *     내린다 — 이 뷰가 끼어드는 화면(기업 거래 · 재배 스테이션 · 분석기 · 배양조 · 식탁)의 열 폭은 제각각이라
 *     뷰포트 미디어 쿼리로 추측하지 않는다. 스크롤은 예전처럼 `.tg-scroll` 하나가 맡는다. 가방은 가로 5칸 ·
 *     틀 높이는 가장 긴 가방(`BAG_FRAME_ROWS`), 창고는 가로 10칸 — Tab 인벤토리와 똑같다.
 *     ⚠ 세로가 되면 두 격자가 **한 스크롤에 이어 붙는다**: 창고 24행 = 1381 px · 가방 틀 12행 = 709 px 인데
 *     스크롤 창은 600 px 남짓이라 **어느 쪽을 위에 올려도 다른 쪽이 화면 밖**이고, 끄는 중에는 스크롤할 수 없어
 *     그 방향의 드래그가 통째로 막힌다. 그래서 **두 열이 못 들어가는 화면이 스스로 해결한다**: 가구 화면은
 *     `housing.css` 의 `.hs-inv` 에서 **블록마다 자기 스크롤**을 주고(`.inv-grid` 가 `overflow-y: auto`) 좁을 때
 *     세로로 반씩 쌓는다. 기업 거래 화면은 이 기본값(한 스크롤 · 줄바꿈) 그대로다.
 *   - 머리에 **정렬** 버튼(`InventorySystem.sortGrid` — 이 뷰가 인벤토리를 바꾸는 유일한 동작이다. 호출자가 트레이에 올린
 *     uid 는 `isStaged` 로 넘겨 합치기에서 뺀다)과 **필터 칩**(걸러진 타일은 어두워질 뿐 자리를 지킨다).
 *   - 드래그는 pointermove 를 **rAF 한 번으로 합치고** 고스트를 `transform` 으로 옮긴다 (예전: 이벤트마다 `offsetWidth` 읽기 +
 *     `left/top` 쓰기 + `elementFromPoint` → 재배 스테이션에서 프레임이 무너졌다). 버스 이벤트 여러 개가 한 프레임에 오면
 *     갱신도 한 번이고, `GridView` 가 바뀐 타일만 다시 그린다.
 *
 * Tiles are stamped `data-item-tip` + `data-def-id`, the hook `ui/hud/ItemTip` delegates on. Each grid block carries
 * `data-tg-grid="bag" | "stash"` so a caller can tell which grid a drop of its own landed on.
 *
 * It touches nothing outside `host` (apart from the drag ghost on `document.body` while a drag lasts): no blocker, no
 * pointer-lock call, no window key listener. `dispose()` removes exactly what it added.
 */
export class TradeGrids implements EmbeddedView {
  private readonly root: HTMLElement;
  private readonly scroll: HTMLElement;
  private readonly blocks: Block[] = [];
  /** Grid cell edge / pitch in px (`TradeGridsOptions.cell`; the 기업 거래 desk shrinks them). */
  private readonly cell: number = CELL;
  private readonly unsubs: Array<() => void> = [];
  private readonly chips: FilterChips;
  private filter: FilterGroupId = 'all';
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
    this.root = document.createElement('div');
    this.root.className = `trade-grids${opts.className ? ` ${opts.className}` : ''}`;
    host.appendChild(this.root);
    this.menu = new ContextMenu(ctx.uiRoot);
    this.menu.el.classList.add('tg-menu');

    const cell = Math.max(16, Math.round(opts.cell ?? CELL));
    this.cell = cell;
    if (cell !== CELL) this.root.style.setProperty('--inv-cell', `${cell}px`);
    this.root.style.setProperty('--tg-step', `${cell + GAP}px`);

    const tools = document.createElement('div');
    tools.className = 'tg-tools';
    this.chips = buildFilterChips((id) => this.setFilter(id));
    tools.appendChild(this.chips.el);
    this.scroll = document.createElement('div');
    this.scroll.className = 'tg-scroll';
    this.root.append(tools, this.scroll);

    // 2026-09-12 (사용자 결정): 창고 왼쪽 · 가방 오른쪽. 호출자가 `grids` 를 직접 주면 그 순서가 이긴다.
    const ids = opts.grids ?? (['stash', 'bag'] as const);
    for (const id of ids) {
      const block = document.createElement('div');
      block.className = `tg-block tg-${id}`;
      block.dataset.tgGrid = id;   // 2026-09-12: 다른 화면이 드롭 위치를 가방 / 창고로 가른다 (`closest('[data-tg-grid]')`)
      const head = document.createElement('div');
      head.className = 'tg-head';
      const label = document.createElement('span');
      label.className = 'tg-label';
      label.textContent = id === 'bag' ? '내 가방' : '함선 창고';
      const countEl = document.createElement('span');
      countEl.className = 'tg-count';
      head.append(label, countEl, buildSortButton(() => this.sort(id)));
      const view = new GridView(id, (defId) => this.inv.getDef(defId), (item) => this.inv.getStats(item), {
        onPointerDown: (uid, gridId, e) => this.startDrag(uid, gridId as TradeGridId, e),
        onEnter: () => { /* the hover card is `ui/hud/ItemTip` (data-item-tip) */ },
        onMove: () => { /* no-op */ },
        onLeave: () => { /* no-op */ },
        onContext: (uid, gridId, e) => this.openMenu(uid, gridId as TradeGridId, e),
        onDblClick: (uid, gridId) => this.take(uid, gridId as TradeGridId, null),
      }, cell);
      if (id === 'bag') view.setFrameRows(BAG_FRAME_ROWS);
      // 2026-09-12: 격자는 **자기 폭을 px 로 못박은** 상자다(`GridView.syncDims`). 그래서 세로 스크롤을 격자 자신에게
      // 걸면 스크롤바가 그 폭 안에서 자리를 빼앗아 마지막 열이 잘린다 — 폭이 내용에서 나오는 이 상자가 대신 맡는다
      // (`Tab` 인벤토리의 `.inv-bag-scroll` 과 같은 방식). 기본값에서는 아무것도 하지 않고, 거는 곳은 가구 화면이다.
      const wrap = document.createElement('div');
      wrap.className = 'tg-gridwrap';
      wrap.appendChild(view.el);
      view.setClip(wrap);
      block.append(head, wrap);
      this.scroll.appendChild(block);
      this.blocks.push({ id, view, countEl });
    }

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

  /** Several bus events in one frame (a drop fires three or four) repaint once. */
  private scheduleRefresh(): void {
    if (this.disposed || this.refreshRaf) return;
    this.refreshRaf = requestAnimationFrame(() => { this.refreshRaf = 0; this.refresh(); });
  }

  refresh(): void {
    if (this.disposed) return;
    const staged = this.opts.isStaged;
    // 2026-09-12: 내게 필요한 탄약의 사선 띠 — Tab 창과 **같은 표**를 쓰므로 여기서도 갈아 끼운다 (바뀔 때만 true)
    const ammoChanged = setNeededAmmoFrom(this.inv.getLoadout(), (item) => this.inv.getStats(item));
    for (const bl of this.blocks) {
      const grid = this.inv.getGrid(bl.id);
      if (bl.view.current !== grid) bl.view.setGrid(grid);
      else bl.view.refresh(ammoChanged);   // version-gated; only changed tiles are rebuilt
      bl.countEl.textContent = grid ? `${grid.count}점` : '';
      // staging can change without the grid changing (the caller calls `refresh()` after staging) — flags only
      bl.view.forEachTile((uid, tile) => {
        if (staged) tile.classList.toggle('is-staged', staged(uid));
        if (tile.dataset.itemTip === undefined) tile.dataset.itemTip = '';
        const defId = grid?.get(uid)?.item.defId;
        if (defId && tile.dataset.defId !== defId) tile.dataset.defId = defId;
      });
    }
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

  private setFilter(id: FilterGroupId): void {
    this.filter = id;
    this.chips.set(id);
    const pred = filterPredicate(id, (defId) => this.inv.isFavorite(defId));
    for (const bl of this.blocks) bl.view.setFilter(pred);
  }

  /** The chip currently lit (smoke tests). */
  get filterGroup(): FilterGroupId { return this.filter; }

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
    const size = tileSizeAt(fp.w, fp.h, this.cell);
    const ghost = document.createElement('div');
    buildTileContent(ghost, p.item, def, fp.w, fp.h, this.inv.getStats(p.item), this.cell);
    ghost.classList.add('tg-ghost');
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
    this.root.remove();
  }
}
