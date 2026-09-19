import type { EmbeddedView, GameContext, ItemInstance, TradeGridsView } from '@/shared';
import { el, setText, toggleClass } from './dom';

/**
 * **The common furniture-screen shell** (2026-09-12 · card layout 2026-09-13) — the grow station · analyzer · culture
 * tank · dining table (and the library) use the same skeleton.
 *
 * 2026-09-13 (user's decision 「like the workbench craft screen」): the one outer frame that held everything is gone and
 * **three separate cards stand in one row** — the grain of the workbench craft window's `[제작] [함선 창고] [가방]`. No shared outer border.
 *
 * ```
 * ┌ title  Lv. 1  +15% ──── [업그레이드] ┐  ┌ stash · bag ──────────────────────────┐
 * │ ┌ rail ┐ ┌ left pane (furniture) ──┐ │  │ stash grid (scroll) │ my bag (scroll) │
 * │ │ list │ │                         │ │  │ sort · filter       │ sort · filter   │
 * │ └──────┘ └─────────────────────────┘ │  │                     │                 │
 * └──────────────────────────────────────┘  └───────────────────────────────────────┘
 *   message line · hint ······················································· [닫기]
 * ```
 *
 * - **The station card** (`.hs-card-station`) carries the title + `Lv. n` + the meta text (`meta`, e.g. the grow
 *   station's growth speed), and the 「업그레이드」 button sits at the top right of **that card**, not of the screen.
 *   The rail (station list · analyzer tabs) is inside the card too.
 * - **2026-09-15, 3rd pass (user's decision — the stash + the bag are one panel)**: there is **one** grid card
 *   (`.hs-card-inv`), and inside it `TradeGrids` draws the stash on the left · my bag on the right, **each pane with
 *   its own scroll · its own sort · its own filter** (`mountStationGrids` calls `createTradeGrids` exactly **once**).
 *   The old layout called it **twice**, once per card, so there were two cards — that split went away when the
 *   inventory became one panel in the 2026-09-15 2nd pass. The card head (`.hs-card-head`) went with it: the grid
 *   blocks name themselves (the stash by its drawing, the bag by its `내 가방` label).
 * - The grid cell edge is picked from the viewport (`stationGridCell` — 54 when wide, else 46): two cards still fit in
 *   one row at 1440. When the window crosses that boundary a live view gets `setCell`. Narrower than that, CSS stacks
 *   the station card on top and the grid card below.
 *
 * On screens that do not use the rail (culture tank · dining table) `rail` is `hidden`, so the flex gap beside it goes too.
 * With `inventory: false` no grid card is built (`invCard` = null, `invHost` is an empty spot).
 *
 * 2026-09-13 (the same day, user's decision 「remove the power allocation system」): the disable button · the stopped
 * banner left of 업그레이드 (the `power` option · `paintStationPower` · `.hpw-`) are gone — furniture never stops.
 */
export interface StationShell {
  /** Header row of the **station card** (title + Lv + meta left, 업그레이드 right). */
  readonly head: HTMLElement;
  readonly title: HTMLElement;
  /** `Lv. n` right of the title (hidden on screens without levels). */
  readonly level: HTMLElement;
  /** Top-right 업그레이드 button of the station card, null when the furniture has no levels (식탁). */
  readonly upBtn: HTMLButtonElement | null;
  /** Body of the station card: `rail` + `left`. */
  readonly body: HTMLElement;
  /** Leftmost vertical rail inside the station card (스테이션 목록 · 탭). Starts `hidden`; a panel that uses it unhides it. */
  readonly rail: HTMLElement;
  readonly left: HTMLElement;
  /** Wrapper of the 함선 창고 + 가방 cards (`.hs-pane-right.hs-inv-cards`). */
  readonly right: HTMLElement;
  /** Host handed to `mountStationGrids` — same element as `right`; it finds the two card hosts inside. */
  readonly invHost: HTMLElement;
  /* appended 2026-09-13 (카드 배치) */
  /** The row of cards (`.hs-cards`) — station card, then `right`. */
  readonly cards: HTMLElement;
  /** The station card (`.hs-card.hs-card-station`). */
  readonly stationCard: HTMLElement;
  /** Small text after `Lv. n` (`.hs-meta`, hidden while empty) — e.g. `성장 속도 +15%`. Set it with `paintStationMeta`. */
  readonly meta: HTMLElement;
  /**
   * appended 2026-09-15, 3rd pass: the **one** 창고 + 가방 card (`.hs-card-inv`), null with `inventory: false`.
   * `TradeGrids` draws both grids inside it.
   */
  readonly invCard: HTMLElement | null;
  /** @deprecated 2026-09-15, 3rd pass — there is one card now. The same element as `invCard` (only the name is kept). */
  readonly stashCard: HTMLElement | null;
  /** @deprecated 2026-09-15, 3rd pass — the same element as `invCard`. */
  readonly bagCard: HTMLElement | null;
  /* appended 2026-09-14 (the library screen rework) */
  /**
   * The left pane's **horizontal tab row at the top** (`.hs-tabs`), built only with `tabs: true` — an option, so the old
   * screens (analyzer · grow · cook bench · mining) do not change by a line. Tabs go here when the rail (`rail`) is a list.
   */
  readonly tabsRow: HTMLElement | null;
}

export interface StationShellOptions {
  title: string;
  /** false = no level badge and no 업그레이드 button (식탁). */
  upgrade: boolean;
  onUpgrade?(): void;
  /** The panel's own `button()` (click sound + stopPropagation). */
  button(parent: HTMLElement, label: string, onClick: () => void, cls: string): HTMLButtonElement;
  /** appended 2026-09-13: false = no 함선 창고 / 가방 cards. Default true. */
  inventory?: boolean;
  /** appended 2026-09-14: true = a horizontal tab row at the top of the left pane (`shell.tabsRow`). Default false. */
  tabs?: boolean;
}

/**
 * 2026-09-15, 3rd pass: there is **one** grid card (`.hs-card-inv` > `.hs-inv`). It has no header row — the stash · bag
 * names are said by the `TradeGrids` blocks themselves. `data-hs-grid="inv"` is the handle `mountStationGrids` finds the host by.
 */
function buildInvCard(parent: HTMLElement): HTMLElement {
  const card = el('section', { cls: 'hs-card hs-card-inv', attrs: { 'data-hs-grid': 'inv' }, parent });
  el('div', { cls: 'hs-inv', parent: card });
  return card;
}

/**
 * Build the card layout into the panel's `.frame`. The frame itself becomes a transparent column (`.hs-station .frame`
 * in `housing.css`): cards row, then whatever the panel appends (message line, footer).
 */
export function buildStationShell(frame: HTMLElement, o: StationShellOptions): StationShell {
  const cards = el('div', { cls: 'hs-cards', parent: frame });
  const stationCard = el('section', { cls: 'hs-card hs-card-station', parent: cards });
  const head = el('div', { cls: 'hs-head hs-station-head', parent: stationCard });
  const hl = el('div', { cls: 'hl', parent: head });
  const title = el('div', { cls: 'title', text: o.title, parent: hl });
  const level = el('div', { cls: 'hs-lv', text: '', parent: hl });
  level.hidden = !o.upgrade;
  const meta = el('div', { cls: 'hs-meta', text: '', parent: hl });
  meta.hidden = true;
  const upBtn = o.upgrade ? o.button(head, '업그레이드', () => o.onUpgrade?.(), 'primary hs-up-open') : null;
  const body = el('div', { cls: 'hs-station-body', parent: stationCard });
  const rail = el('div', { cls: 'hs-rail', parent: body });
  rail.hidden = true;                       // `display: none` → the flex gap next to it disappears too
  const left = el('div', { cls: 'hs-pane hs-pane-left', parent: body });
  const tabsRow = o.tabs ? el('div', { cls: 'hs-tabs', parent: left }) : null;
  const right = el('div', { cls: 'hs-pane-right hs-inv-cards', parent: cards });
  const withInv = o.inventory !== false;
  right.hidden = !withInv;
  // 2026-09-12 (user's decision): **the ship stash on the left, the bag on the right** — since the 2026-09-15 3rd pass
  // that order is kept by `TradeGrids`'s `grids: ['stash','bag']` (there is one card)
  const invCard = withInv ? buildInvCard(right) : null;
  return {
    head, title, level, upBtn, body, rail, left, right, invHost: right, cards, stationCard, meta,
    invCard, stashCard: invCard, bagCard: invCard, tabsRow,
  };
}

/** `Lv. n` + the 업그레이드 button state (`MAX` and disabled at the last level; disabled when the furniture is gone). */
export function paintStationLevel(shell: StationShell, level: number | null, maxLevel: number): void {
  setText(shell.level, level === null ? '' : `Lv. ${level}`);
  const btn = shell.upBtn;
  if (!btn) return;
  const atMax = level !== null && level >= maxLevel;
  btn.disabled = level === null || atMax;
  setText(btn, atMax ? 'MAX' : '업그레이드');
  toggleClass(btn, 'is-max', atMax);
}

/** appended 2026-09-13: the small text after `Lv. n` (empty string hides it). */
export function paintStationMeta(shell: StationShell, text: string): void {
  setText(shell.meta, text);
  shell.meta.hidden = !text;
}

/**
 * Grid cell edge for the station cards (px). Since the 2026-09-15 3rd pass **two** cards stand in one row — the station
 * card and the one inventory card (stash + bag) — and at the wide cell that inventory card alone is too wide for a
 * 1440 px viewport, so below `STATION_WIDE_VIEWPORT` the grids drop to the narrow cell (the 기업 거래 desk shrinks its
 * grids the same way, `TradeGridsViewOptions.cell`). Layout constants, not balance numbers.
 */
const STATION_WIDE_VIEWPORT = 1760;
export function stationGridCell(viewportWidth = window.innerWidth): number {
  return viewportWidth >= STATION_WIDE_VIEWPORT ? 54 : 46;
}

/**
 * The 함선 창고 / 가방 grids are built **lazily**: housing/ is registered before inventory/, so `ctx.inventory` does not
 * exist yet when a panel is constructed. Null when the inventory cannot render them.
 *
 * **2026-09-15, 3rd pass (user's decision — the stash + the bag are one panel)**: `createTradeGrids` is called exactly
 * **once** (`grids: ['stash','bag']`). Inside that one panel the inventory draws the stash left · my bag right, each
 * pane with its own scroll · its own sort · its own filter. The old layout (twice, once per card) split into two cards
 * — that split is gone. The grid cell is `stationGridCell()`; crossing the boundary applies `setCell` **without
 * rebuilding the view** (filters · scroll kept).
 */
export function mountStationGrids(
  ctx: GameContext,
  host: HTMLElement,
  dropSelector: string,
  onTake: (item: ItemInstance, target: HTMLElement | null) => void,
): StationGridsView | null {
  const inv = ctx.inventory;
  if (!inv || typeof inv.createTradeGrids !== 'function') return null;
  // The grid card inside `shell.invHost` (= `right`). A screen that passed a host with no card draws straight into that host.
  const gridHost = host.querySelector<HTMLElement>('.hs-card-inv .hs-inv') ?? host;
  return new StationGrids(ctx, gridHost, dropSelector, onTake);
}

/**
 * One `TradeGrids`(창고 + 가방) behind one `EmbeddedView`, plus the viewport-driven cell size.
 * `layout: 'split'` · `chips: 'block'` have been the inventory's **only** layout since the 2026-09-15 2nd pass, so the
 * values were left in place — keeping the names says 「what this screen expects」.
 */
/**
 * 2026-09-16 (user's report 「what is dragged out has to go to the cell the cursor is over」): the furniture screens ask
 * this view one more thing — **the cell under the cursor**. The answer is the inventory's `TradeGridsView.placeExternalAt`
 * and this passes it straight through (only the side that draws the grid can judge it: cell size · scroll position ·
 * the boundary between the two grids).
 */
export interface StationGridsView extends EmbeddedView {
  /** Puts an item from outside the grid into the cell under `x, y` — `'blocked'` = that cell cannot take it, null = outside the grid. */
  placeExternalAt(item: ItemInstance, x: number, y: number): 'bag' | 'stash' | 'blocked' | null;
  /**
   * 2026-09-17: while dragging, the footprint highlight of the **cell** under the cursor
   * (`TradeGridsView.previewExternalAt`). null = outside the grid or an older inventory — the caller highlights nothing.
   */
  previewExternalAt(defId: string, qty: number, x: number, y: number): 'ok' | 'merge' | 'bad' | null;
  /** false = this inventory has no cell preview (the caller falls back to the old 「highlight the whole grid」). */
  readonly canPreview: boolean;
  clearExternalPreview(): void;
}

class StationGrids implements StationGridsView {
  private view: EmbeddedView | null = null;
  private cell = 0;
  private disposed = false;
  private readonly onResize = (): void => {
    const next = stationGridCell();
    if (this.disposed || next === this.cell || !this.view) return;
    this.cell = next;
    const live = this.view as Partial<TradeGridsView>;
    if (typeof live.setCell === 'function') live.setCell(next);
    else this.mount();                      // an older inventory without `setCell` — rebuild at the new edge
  };

  constructor(
    private readonly ctx: GameContext,
    private readonly host: HTMLElement,
    private readonly dropSelector: string,
    private readonly onTake: (item: ItemInstance, target: HTMLElement | null) => void,
  ) {
    this.mount();
    window.addEventListener('resize', this.onResize);
  }

  private mount(): void {
    const inv = this.ctx.inventory;
    this.view?.dispose();
    this.view = null;
    if (!inv || typeof inv.createTradeGrids !== 'function') return;
    this.cell = stationGridCell();
    this.view = inv.createTradeGrids(this.host, {
      grids: ['stash', 'bag'],
      layout: 'split',
      chips: 'block',
      dropSelector: this.dropSelector,
      onTake: (item, _g, target) => this.onTake(item, target),
      cell: this.cell,
      className: 'hs-tg',
    });
  }

  refresh(): void { this.view?.refresh(); }

  /** null with no inventory (boot order) or an older view — the caller then places by its own rule (bag-first · stash-first). */
  placeExternalAt(item: ItemInstance, x: number, y: number): 'bag' | 'stash' | 'blocked' | null {
    const live = this.view as Partial<TradeGridsView> | null;
    return live && typeof live.placeExternalAt === 'function' ? live.placeExternalAt(item, x, y) : null;
  }

  get canPreview(): boolean {
    return typeof (this.view as Partial<TradeGridsView> | null)?.previewExternalAt === 'function';
  }

  previewExternalAt(defId: string, qty: number, x: number, y: number): 'ok' | 'merge' | 'bad' | null {
    const live = this.view as Partial<TradeGridsView> | null;
    return live && typeof live.previewExternalAt === 'function' ? live.previewExternalAt(defId, qty, x, y) : null;
  }

  clearExternalPreview(): void {
    (this.view as Partial<TradeGridsView> | null)?.clearExternalPreview?.();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('resize', this.onResize);
    this.view?.dispose();
    this.view = null;
  }
}
