import type { EmbeddedView, GameContext, ItemDef, ItemInstance, TradeGridsView } from '@/shared';
import { Keys } from '@/shared';
import type { InventorySystem, GridId } from '../InventorySystem';
import { BAG_FRAME_ROWS, filterPredicate, type FilterGroupId } from '../model';
import { GridView, buildTileContent, setNeededAmmoFrom, type HighlightState } from './GridView';
import { buildFilterSelect, buildSortButton, type FilterControl } from './GridTools';
import { CELL, GAP, TEXT, capacityLabel, tileSizeAt } from './labels';
import { ContextMenu, type MenuEntry } from './ContextMenu';
/* 2026-09-14: 툴팁 고정 · 고정 카드에서 소켓 끌어내기 */
/* 2026-09-16: 격자 안 / 격자 사이 옮기기 — 판정은 `parts/DropResolver` 가 하고 여기는 물어보기만 한다 */
import type { DetachTarget, DropTarget, ItemLocation } from '../model';
import { Tooltip } from './Tooltip';
import { TipPin, inventoryTooltipLookups, type DetachAim, type SocketDrag } from './TipPin';
import { CLICK_SUPPRESS_MS, DRAG_THRESHOLD } from './model';

/** Which of the player's grids a trade screen may show, top to bottom. */
export type TradeGridId = Extract<GridId, 'bag' | 'stash'>;

/**
 * 2026-09-13 → **2026-09-15 2차 (사용자 결정): 두 값의 차이가 없어졌다.**
 *
 * 창고 + 가방은 이제 어느 화면에서든 **한 패널 안의 두 칸**이고 (창고 왼쪽 · 가방 오른쪽, 2026-09-12 결정 그대로),
 * **칸마다 자기 스크롤 · 자기 정렬 버튼 · 자기 필터**를 갖는다 — 즉 옛 `'split'` 이 유일한 배치다.
 * `'wrap'` 은 계약을 흔들지 않으려고 남겨 둔 이름이고 (`TradeGridsViewOptions.layout` 은 `src/shared` 계약이다)
 * 지금은 둘 다 같은 것을 그린다.
 *
 * ⚠ 옛 `'wrap'` 의 「한 스크롤 안에 블록이 나란히, 좁으면 줄바꿈」 은 되살리지 않는다 — 창고 24행 · 가방 틀 12행이
 * 한 스크롤을 나눠 쓰면 어느 쪽을 위에 올려도 다른 쪽이 화면 밖이고, 끄는 중에는 스크롤할 수 없다 (2026-09-12 경고).
 */
export type TradeGridsLayout = 'wrap' | 'split';
/**
 * 2026-09-13 → 2026-09-15 2차: 필터는 칩 줄이 아니라 **정렬 버튼 오른쪽의 드롭다운**이다 (`ui/GridTools`).
 * `'block'`(기본) = 칸마다 자기 머리에 자기 드롭다운, `'shared'` = 패널 위 한 줄이 모든 칸을 함께 거른다,
 * `'none'` = 뷰 안에는 없다 (부른 쪽이 `mountFilterChips(host)` 로 아무 데나 한 줄 올릴 수 있다).
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
  /** The box around the grid — **always the scroller** (2026-09-15 2차; `housing.css`'s `.hs-inv` agrees). */
  wrap: HTMLElement;
  /** This block's own filter dropdown (`chips: 'block'`), else null. */
  chips: FilterControl | null;
  filter: FilterGroupId;
}

/**
 * 2026-09-16 (사용자 결정 「창고 · 가방 아이템을 여기서도 옮길 수 있어야 한다 — 회전 · 머지 · 칸 옮기기 전부」):
 * 끌고 있는 것 한 벌. 예전에는 「호출자의 트레이로 끌어내기」밖에 없어서 `uid` · 고스트 · 반쪽 크기뿐이었다.
 */
interface DragInfo {
  uid: string;
  gridId: TradeGridId;
  /** `DropResolver` 가 묻는 출발지 (`{kind:'grid', grid: gridId}`) — 매번 새로 만들지 않고 들고 다닌다. */
  from: ItemLocation;
  def: ItemDef;
  /** R 로 뒤집힌 방향 (아이템 자체는 놓일 때까지 그대로다 — `DropTarget.rotated` 로만 전해진다). */
  rotated: boolean;
  ghost: HTMLElement;
  /** Half the ghost's size, known at pick-up (never measured while moving — that forced a layout per event). */
  halfW: number;
  halfH: number;
  /**
   * 2026-09-16: 합치고 **남은 수량이 커서에 남은** 상태 (Tab 창의 `DragState.held` 와 같은 규칙). 남은 몫은
   * 출발 스택을 떠나지 않았고 — 그 스택의 수량이 줄었을 뿐이다 — 다음 좌클릭이 그것을 놓는다.
   */
  held: boolean;
  /** `held` 드래그: 다음 누름이 도착했으니 그 **놓음**이 드롭이다. */
  armed: boolean;
}

/** Smallest cell edge a caller can ask for (tiles stop being legible well before this). */
const MIN_CELL = 16;
/** A block narrower than this stacks its header tools (정렬 · 필터) instead of putting them on one line. */
const NARROW_BLOCK_PX = 260;

const clampCell = (px: number | undefined): number => Math.max(MIN_CELL, Math.round(px ?? CELL));

/**
 * **Embedded 가방 / 함선 창고 grids** (Phase 9 UI pass) — real inventory grids, rendered by the same `GridView` the
 * Tab window uses, for another folder's screen (기업 거래 · 재배 스테이션 · 분석기 · 배양조 · 식탁).
 *
 * **2026-09-16 (사용자 결정) — 여기서도 아이템을 옮길 수 있다.** 예전 이 뷰는 「읽기 + 끌어내기」 전용이라 드롭을
 * 아예 판정하지 않았다 (`pointerup` 이 호출자의 `dropSelector` 만 보고, 격자 위에서 놓으면 아무 일도 일어나지 않았다).
 * 이제 **같은 격자 안의 다른 칸 · 창고 ↔ 가방 · 드래그 중 `R` 회전 · 같은 스택 위에 합치기**가 Tab 인벤토리와
 * 똑같이 된다 — 판정과 실행은 전부 `parts/DropResolver`(`InventorySystem.previewDrop` / `drop`)이고, 이 파일은
 * 커서 밑의 칸을 찾아 물어보고 하이라이트를 칠할 뿐이다. 그래서 Tab 창의 규칙이 그대로 따라온다:
 * 합치고 남은 수량은 커서에 남고(`DragInfo.held`), 장착 장비를 조용히 밀어내는 길은 없으며, 주머니 · 퀵슬롯처럼
 * **아이템을 떨어뜨릴 이동은 거절**된다. 여기 없는 것은 여전히 없다 — 장비칸 · 퀵슬롯 · 상자 격자가 이 뷰에 없으므로
 * 그것들은 드롭 대상이 아니고, 바닥에 버리기(`X`)도 없다 (격자 밖에서 놓으면 제자리로 돌아간다).
 *
 * 호출자의 트레이는 그대로다: `dropSelector` 에 맞는 요소 위에서 놓으면 (또는 더블클릭하면) `onTake` 가 불린다 —
 * **트레이가 격자보다 먼저**라 기업 거래의 판매 트레이는 예전과 똑같이 동작한다.
 *
 * **2026-09-12 (사용자 결정)** —
 *   - **창고가 왼쪽, 가방이 오른쪽**으로 나란히 선다 (`.tg-scroll` 이 가로 2열). 한 스크롤 안에 위아래로 쌓던 앞
 *     배치는 긴 가방 틀 때문에 창고를 아래로 밀어냈다. 폭이 모자라면 `flex-wrap` 이 가방을 스스로 아랫줄로
 *     내린다. 가방은 가로 5칸, 창고는 가로 10칸 — Tab 인벤토리와 똑같다. 틀 높이(`BAG_FRAME_ROWS`)는 여기만 남았다:
 *     2026-09-18 부터 Tab 은 장착한 가방 크기 그대로 그리지만, 24행 창고와 나란히 서는 이 화면에서는 틀이 없으면 토막처럼 보인다.
 *     ⚠ 세로가 되면 두 격자가 **한 스크롤에 이어 붙는다**: 창고 24행 = 1381 px · 가방 틀 12행 = 709 px 인데
 *     스크롤 창은 600 px 남짓이라 **어느 쪽을 위에 올려도 다른 쪽이 화면 밖**이고, 끄는 중에는 스크롤할 수 없어
 *     그 방향의 드래그가 통째로 막힌다. 그래서 두 열이 못 들어가는 화면은 블록마다 자기 스크롤을 준다 —
 *     2026-09-13 부터는 `layout: 'split'` 이 그것을 이 뷰 안에서 한다.
 *   - 머리에 **정렬** 버튼(`InventorySystem.sortGrid` — 이 뷰가 인벤토리를 바꾸는 유일한 동작이다. 호출자가 트레이에 올린
 *     uid 는 `isStaged` 로 넘겨 합치기에서 뺀다)과 **필터 칩**(걸러진 타일은 어두워질 뿐 자리를 지킨다).
 *   - 드래그는 pointermove 를 **rAF 한 번으로 합치고** 고스트를 `transform` 으로 옮긴다. 버스 이벤트 여러 개가 한 프레임에
 *     오면 갱신도 한 번이고, `GridView` 가 바뀐 타일만 다시 그린다.
 *
 * **2026-09-15 2차 (사용자 결정) — 창고 + 가방은 한 패널이다.** 어느 화면에서든 `.trade-grids` 하나가 카드이고 그 안에
 * **왼쪽 칸 = 함선 창고 · 오른쪽 칸 = 내 가방**이 나란히 선다. 칸마다 **자기 세로 스크롤 · 자기 정렬 버튼 · 자기 필터
 * 드롭다운**이고(따로 작동한다), 창고 쪽 라벨은 없앴다. `layout` 은 더 이상 갈래를 만들지 않는다 (`TradeGridsLayout` 주석).
 * ⚠ 옛 경고는 그대로 유효하다 — 두 격자를 **한 스크롤에 세로로 이어 붙이지 않는다**; `.tg-gridwrap` 이 각자의 스크롤러이고
 * `scrollbar-gutter: stable` 로 마지막 열을 지킨다.
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
   * 2026-09-16: 커서에 남은 몫을 내려놓거나(좌클릭) 놓아 준(우클릭) **그 클릭**이 밑에 있는 타일의
   * `dblclick` / `contextmenu` 로 이어지면 안 된다 — Tab 창의 `suppressClicksUntil` 과 같은 창(`CLICK_SUPPRESS_MS`).
   */
  private suppressUntil = 0;
  /**
   * 2026-09-12 (사용자 결정 「모든 아이템 우클릭 = 메뉴」): 빠른 이동(= 더블클릭) · 즐겨찾기. `ctx.uiRoot` 에 붙인다 —
   * `.inv-menu` 는 `position: fixed` 라 transform 이 걸린 화면 안에 두면 자리가 어긋난다.
   */
  private readonly menu: ContextMenu;
  /**
   * 2026-09-14 (사용자 결정): 툴팁 고정 — 타일을 움직이지 않고 1초 누르면 **인벤토리 툴팁**(무기 게이지 · 소켓 줄이 있는 인스턴스 카드)이
   * 누른 자리에 선다 (`ui/TipPin`). 떠다니는 호버 카드는 여전히 `ui/hud/ItemTip` 이고(고정한 타일은 `data-tip-pinned` 로 빠진다),
   * 고정 카드와 그 소켓 썸네일의 호버 카드(`hoverTip`)는 `ctx.uiRoot` 에 산다 — 화면의 transform 밖이어야 `position: fixed` 가 맞는다.
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
    // 2026-09-15 2차: 배치는 하나뿐이다 (`is-split` 은 이름만 남는다 — 바깥 스타일시트가 그 이름으로 붙어 있다)
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
      // 2026-09-13 (서재 시리즈): 「아직 꽂지 않은」 띠 — 캐시는 `parts/ShelfWanted` 가 먼저(시스템 init 구독) 비운다
      b.on('housing:libraryChanged', repaint),
      b.on('ui:tipPinned', repaint),   // 2026-09-14: the pinned tile's `data-tip-pinned` flag
    );
    this.refresh();
  }

  /**
   * One block: header (label · 칸 readout · 정렬 · 필터 드롭다운) and the grid inside its scrolling wrap.
   * 2026-09-16: 그 readout 은 `사용칸 / 전체칸` 이고 **정렬 버튼 왼쪽**이다 (`refresh`, `labels.capacityLabel`).
   *
   * **2026-09-15 2차 (사용자 결정)** — 두 가지가 바뀌었다:
   *  - **창고 쪽 라벨(`함선 창고`)은 없앴다.** 창고 · 가방이 한 패널의 두 칸으로 나란히 서면서 왼쪽 큰 격자가
   *    창고라는 것은 그림이 말한다. 가방 라벨은 남는다 (오른쪽 칸이 **내** 것이라는 표시다).
   *  - **필터는 정렬 버튼 오른쪽의 드롭다운**이다 — 머리 아래 따로 서던 칩 줄(`.tg-tools`)이 사라졌다.
   */
  private buildBlock(id: TradeGridId): Block {
    const el = document.createElement('div');
    el.className = `tg-block tg-${id}`;
    el.dataset.tgGrid = id;   // 2026-09-12: 다른 화면이 드롭 위치를 가방 / 창고로 가른다 (`closest('[data-tg-grid]')`)
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
    // 2026-09-12: 내게 필요한 탄약의 사선 띠 — Tab 창과 **같은 표**를 쓰므로 여기서도 갈아 끼운다 (바뀔 때만 true)
    const ammoChanged = setNeededAmmoFrom(this.inv.getLoadout(), (item) => this.inv.getStats(item));
    for (const bl of this.blocks) {
      const grid = this.inv.getGrid(bl.id);
      if (bl.view.current !== grid) bl.view.setGrid(grid);
      else bl.view.refresh(ammoChanged);   // version-gated; only changed tiles are rebuilt
      // 2026-09-16 (사용자 결정): 머리의 `N점`(종류 수)은 없앴다 — Tab 창의 창고 머리와 **같은** `사용칸 / 전체칸`
      // (`labels.capacityLabel`). 가방 틀의 빈 줄(`BAG_FRAME_ROWS`)은 칸이 아니므로 전체칸에 들어가지 않는다.
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
    this.sharedChips = buildFilterSelect((id) => this.setFilter(id));
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

  /* ── drag: 격자 안 / 격자 사이 옮기기 · 호출자 트레이로 끌어내기 ──────────── */
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
    window.addEventListener('keydown', this.onKey, true);   // 2026-09-16: R 회전 — 끄는 동안만 (그 밖에는 키를 듣지 않는다)
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
    // 호출자의 트레이가 **먼저**다 — 기업 거래의 판매 트레이는 격자와 겹치지 않으므로 순서만 지키면 예전 그대로다
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
   * the pointer beats one that only sits within its half-cell tolerance, so 창고 and 가방 (side by side with a gap)
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
      // 합치고 남은 몫은 **다음** 누름의 놓음에서 내려놓는다 (`onHeldDown` 이 무장한다)
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
   * Release: the caller's tray first (`onTake` — the item is **not** moved here), else a cell of 창고 / 가방 through
   * `InventoryRef.drop`. Released over neither, the item simply stays where it was — this view has no 버리기 zone, so
   * nothing can be lost by missing.
   */
  private finishDrop(d: DragInfo): void {
    const tray = this.dropTargetAt(this.moveX, this.moveY);
    if (tray) { this.take(d.uid, d.gridId, tray); return; }
    const hit = this.cellUnderGhost(d);
    if (!hit) { if (d.held) this.inv.sfx('ui_drop'); return; }
    const target = this.targetOf(d, hit);
    // 2026-09-12 규칙 그대로: 합치기 판정과 출발 수량을 **놓기 전에** 읽는다 — 남은 몫은 움직이지 않은 만큼이다
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
   * 2026-09-16 (Tab 창의 `DragState.held` 와 같은 규칙): 대상 스택이 다 받지 못한 나머지는 **커서에 남는다**.
   * 그 수량은 출발 스택을 떠난 적이 없으므로(줄었을 뿐이다) 세이브 · 시체 벗기기 · 화면 닫기가 끼어들어도
   * 아이템은 제자리에 있다. 다음 좌클릭이 놓고, 우클릭 · Escape · 빈 곳 · `dispose` 가 놓아 준다.
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

  /* ── 2026-09-14: 고정 카드에서 소켓 끌어내기 — `TipPin` 에 이 뷰가 주는 대답 ─────────────────────────────── */

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

  /* ── 2026-09-16: 격자 **밖**에서 온 아이템을 커서가 놓인 칸에 (`TradeGridsView.placeExternalAt`) ─────────── */

  /**
   * 가구 화면이 자기 칸에서 **뽑아 낸** 것(선반의 책 · 클러스터의 코어 · 스테이션의 산물)을 커서 밑의 칸에 넣는다.
   * 칸 찾기는 타일 드래그와 **같은 두 벌 판정**(`cellUnderGhost`)이라 강조된 칸과 놓이는 칸이 어긋나지 않는다.
   *
   * 판정은 「밀어내지 않는다」 하나다: 빈 자리면 그 칸, 같은 스택이면 합치기, 그 밖에는 `'blocked'` 로 거절한다
   * (남의 아이템을 치우거나 다른 칸으로 슬쩍 보내지 않는다 — Tab 창의 드롭 규칙과 같은 정신이다). 격자 밖이면
   * `null` 이라 부른 쪽이 자기 규칙(가방 먼저 · 창고 먼저)으로 넣는다.
   */
  placeExternalAt(item: ItemInstance, x: number, y: number): 'bag' | 'stash' | 'blocked' | null {
    if (this.disposed) return null;
    const def = this.inv.getDef(item.defId);
    if (!def) return null;
    const w = item.rotated ? def.height : def.width;
    const h = item.rotated ? def.width : def.height;
    const size = tileSizeAt(w, h, this.cellPx);
    const hit = this.cellAt(x - size.width / 2, y - size.height / 2, w, h, x, y);
    if (!hit) return null;
    const grid = this.inv.getGrid(hit.bl.id);
    if (!grid) return null;
    const occupant = grid.at(hit.x, hit.y)?.item;
    if (occupant) {
      /* 같은 스택이면 합친다 (가방에서 끌 때와 같다). **전부 들어갈 때만** 손을 댄다 — 자리를 먼저 재고
         `mergeInto` 를 부르므로 「반쪽만 옮기고 거절」이 나올 수 없다 (합칠 수 없는 짝이면 0 을 돌려준다). */
      if (def.stackMax - occupant.qty < item.qty || grid.mergeInto(item, occupant.uid) <= 0) return 'blocked';
    } else if (!grid.place(item, hit.x, hit.y, item.rotated)) {
      return 'blocked';
    }
    this.inv.afterChange();
    this.inv.sfx('ui_drop');
    this.refresh();
    return hit.bl.id;
  }

  /**
   * 2026-09-17 (사용자 보고 「가구에서 끌어낸 것은 창고 · 가방 **전체**가 아니라 커서 밑 **칸**이 강조돼야 한다」):
   * `placeExternalAt` 이 할 판정의 **미리보기** — 같은 칸 찾기(`cellAt`)와 같은 「밀어내지 않는다」 규칙으로 발자국을
   * 칠한다 (`showHighlight`, 타일 드래그와 같은 `.inv-hl`). 아무것도 바꾸지 않는다. 합치기는 전부 들어갈 때만 `merge` 다.
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

  /** 2026-09-12: 우클릭 메뉴 — 이 화면의 더블클릭 동작(`takeLabel`) · 즐겨찾기 켜기 / 끄기 (Tab 창의 `favoriteEntry` 와 같은 문구). */
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
    // 2026-09-16: 필터 목록은 `document.body` 의 자식이라(`shared/dropdown`) 뷰를 지워도 저 혼자 화면에 남는다
    for (const bl of this.blocks) bl.chips?.dispose();
    this.sharedChips?.dispose();
    this.sharedTools?.remove();
    this.root.remove();
  }
}
