import type {
  ContractInfo, CorpId, EmbeddedView, GameContext, ItemDef, ItemFavoriteApi, ItemInstance,
  ShopItem, TradeGridsView, TradeGridsViewOptions,
} from '@/shared';
import {
  CONTRACT_GOAL_LABEL_KO, CORP_ACCESS_REP_LEVEL, CORP_DEFS, CORP_IDS, ITEM_FAVORITE_MENU_ATTR, REP_TABLE, SHOP_UNLOCK_REP_LEVEL, UI_HOLD_CONFIRM_S,
  appendCurrencyRewards, buildItemChip, createHoldButtonCap, formatCreditAmount, formatCredits, renderItemCost, repCurrencyId,
} from '@/shared';
import type { ImplantRepairInfo, ImplantRepairResult, MetaSystem, PurchaseFailure } from '../MetaSystem';
/* 2026-09-16: how many units one shelf slot gives (ammo = a full stack) — `Rules.shopQtyOf` is the one rule */
import { shopQtyOf } from '../Rules';
import { chevrons, el, fmtNum, setText, toggleClass } from './dom';
import { HoldAsk } from './HoldAsk';
import { TileGrid, type TileSpec } from './TileGrid';

/* ────────────────────────────────────────────────────────────────────────────
 * CorpView — the **body** of the `기업 네트워크` screen.
 *
 * **2026-09-07**: there is only one shell left — `MetaSystem.createCorpView(host)`, the inventory Tab screen's
 * 기업 tab. The ship computer's `E` calls `ctx.inventory.openScreen('corp')`, so there is exactly one
 * `기업 네트워크` screen in the game and the window owns the blocker, the cursor and Escape.
 *
 * Screen shape (**2026-09-13, user's decision — independent cards standing in one row**):
 *
 *   `.corp-rail`  the corp rail card — screen far left, the host grid's first cell (the whole height). It is a tree:
 *                 a branch (`.corp-branch`) opens **right under** the selected corp's button — 신뢰도 Lv · the XP
 *                 gauge, and under those the 거래 / 계약 / 임플란트 tabs.
 *   `.corp-shell` → `.corp-page` → the page root (`.cv` / `.ci` / `.cc`) — **the cards stand in one row**:
 *     • 거래     [판매 물품] [the 거래 테이블 (구매 · 판매 trays · credit change · 1 s hold)] [창고 · 가방]
 *     • 임플란트 [broken implants + the repair card] [창고 · 가방]
 *   **2026-09-14: the quest tab was deleted** — corp quests are gone. Quests come from NPCs through the messenger
 *   (`ctx.meta.npc`, docs/DECISIONS.md 「2026-09-14 — 메신저 · NPC 퀘스트 · 단체방」).
 *     • 계약     only the corp list moved out; the rest (계약 목록 | 진행 중인 계약) stays one card.
 *   **2026-09-15 3rd pass (user's decision — 창고 + 가방 are one panel)**: the two are **one card** (`.cv-inv`), and
 *   inside it `TradeGrids` draws 창고 on the left and my 가방 on the right, **each pane with its own sort · own
 *   filter · own vertical scroll** — `InventoryRef.createTradeGrids(card, { grids: ['stash','bag'],
 *   layout: 'split' })` is called **once** (the old layout called it once per card, so there were two cards).
 *   ⚠ So `fitLayout` measures this card's grid columns as a **sum** (`gridColsIn(card, step, 'sum')`) — the two
 *   grids stand side by side, so the card's width grows with both.
 *
 * **Cell size = 40 px, shrinking by itself down to 32 px when the window is narrow (2026-09-13).** `fitLayout`
 * **measures** the current page's cards — it measures the fixed share, the part that is not proportional to the grid
 * column count (card padding · border · scrollbar room · gaps · a fluid card's minimum width), and clamps
 * `floor((available width − fixed share) / cell count) − gap` to [32, 40]. Only when even 32 px does not fit are the
 * 함선 창고 · 가방 cards hidden (`.is-inv-hidden`) and the rest re-computed. The host's `ResizeObserver` (debounced)
 * and a page switch re-fit it — there is no window listener. CSS reads `--cv-cell` / `--cv-step`, and the numbers
 * live in CSS alone (never copied here).
 *
 * **Every cell of the trade desk is an inventory tile (2026-09-12).** 기업 판매 물품, the 구매 / 판매 trays and the
 * 임플란트 desk hand `TileGrid` an `.inv-tile` built by `InventoryRef.buildItemTile`, and it packs them over
 * `.inv-cells` by footprint — the **same shape** as the 가방 / 창고 beside them, and `data-item-tip` raises the shared
 * hover card. The class prefix is `.cv-`.
 *
 * **`거래 성사` is a 1 s hold (2026-09-12)** (`UI_HOLD_CONFIRM_S`, the same gauge as 제작 · 분해). Click and Enter
 * never confirm. The three right-pointing chevrons at the 구매 tray's top right say "this comes to my side", the
 * three left-pointing ones at the 판매 tray's top left say "this goes to the corp", and the single line between them
 * is the credit change after the trade (+ green ▲ right / − red ▼ left).
 *
 * Pages:
 *   • **거래**: items are staged into a tray (click, or drag a stock tile / an inventory tile onto it) and the basket
 *     settles at once;
 *   • **계약**: the corp's contract list and **진행 중인 계약** drawn in **that contract's corp colour** (2026-09-12);
 *   • **임플란트** (세레스 바이오 only): broken implant tiles + the repair card, the inventory cards (read-only there).
 *
 * **Tab locking (2026-09-08)**: a page the current 신뢰도 cannot use looks locked (`.is-locked`) but stays clickable
 * so the click can say why, and the view opens on the first open page instead (`resolvePage` — 2026-09-14: with the
 * quest tab gone it searches 계약 → 임플란트).
 *
 * Page bodies are built **once** and swapped, not rebuilt per refresh — the embedded grids own bus subscriptions and
 * a pointer drag, so recreating them on every `inventory:changed` would drop a drag mid-flight.
 * ──────────────────────────────────────────────────────────────────────────── */

export type CorpPage = 'trade' | 'contracts' | 'implants';

const PAGES: readonly { id: CorpPage; label: string; corp?: CorpId }[] = [
  { id: 'trade', label: '거래' }, { id: 'contracts', label: '계약' },
  { id: 'implants', label: '임플란트', corp: 'ceres' },   // Phase 12: the 임플란트 수리 desk, 세레스 바이오 only
];

/** Pages the corp actually has (the 임플란트 desk exists at 세레스 바이오 alone). */
const pagesFor = (corp: CorpId): CorpPage[] => PAGES.filter((p) => !p.corp || p.corp === corp).map((p) => p.id);

/**
 * Cell edge of every item grid on this screen, in px (2026-09-13, user's decision): **40**, shrunk to fit the
 * window down to **32** (`fitLayout`). The gap is the Tab 인벤토리's own (`inventory/ui/labels.GAP`). CSS reads the
 * live value from `--cv-cell` / `--cv-step` on the host (`applyCellVars`).
 */
const CV_CELL_MAX = 40;
const CV_CELL_MIN = 32;
const CV_GAP = 2;
/** Columns of a 구매 / 판매 tray — an item is at most five cells wide. */
const TRAY_COLS = 5;
/**
 * 2026-09-16 (user's decision): **the 기업 판매 물품 shelf is a fixed 10 cells wide**. As a fluid card (`.is-fluid`)
 * eating every leftover pixel, the wider the window the wider the shelf alone grew and its tiles scattered thinly —
 * pinning the cell count makes the shelf's width independent of the window size, and in a narrow window `fitLayout`
 * shrinks the cell edge (40 → 32 px) to fit instead. CSS's `.cv-col.shop` minimum width uses the same 10.
 */
const SHOP_COLS = 10;
/**
 * 2026-09-16 (user's decision): a tile on the corp trade screen writes **the value that moves on this screen** in
 * the hover card's bottom bar instead of 「가치」 — 구매가 on the 매대 · 구매칸, 판매가 on the 판매칸. It is an opt-in
 * attribute the shared card (`ui/hud/ItemTip`) reads with `closest`, so here it is only stamped through `dataset`
 * (no cross-folder import). A tile with no such value (가방 · 창고) keeps 「가치」.
 */
const TIP_PRICE_ATTR = 'data-tip-price';
const TIP_PRICE_LABEL_ATTR = 'data-tip-price-label';
/** Below this fraction of the hold a release reads as a click — say how the button works instead of failing silently. */
const HOLD_TAP_HINT = 0.35;
/** A window resize re-fits the cell size once it has settled for this long. */
const FIT_DEBOUNCE_MS = 120;

/** One staged purchase (a shop line, `qty` copies) / one staged sale (a whole stack by uid). */
interface BuyLine { defId: string; qty: number }
interface SellLine { uid: string; qty: number }

/**
  * The **one** 창고 + 가방 card and the embedded view inside it.
  * 2026-09-15 3rd pass (user's decision): there is one card — inside it `TradeGrids` draws 창고 on the left and my
  * 가방 on the right. The old `id: 'stash' | 'bag'` came from when a card held one grid each, and is gone.
  */
interface InvCard {
  card: HTMLElement;
  view: EmbeddedView | null;
  /** Drop target selector of this page (undefined = read-only grids, the 임플란트 desk). */
  drop?: string;
}

/** `createTradeGrids` returns an `EmbeddedView` by contract; the real view can also change its cell edge. */
const isTradeGridsView = (v: EmbeddedView): v is TradeGridsView => typeof (v as Partial<TradeGridsView>).setCell === 'function';

/**
  * Item-grid width of a card, in cells.
  * - `'max'` (default): the 거래 테이블's two trays are **stacked**, so the card is as wide as the widest one.
  * - `'sum'` (2026-09-15 3rd pass): the 창고 + 가방 card holds its two grids **side by side** in one `.tg-scroll`,
  *   so the card grows with both — measuring only the widest would leave the other grid's width inside `chrome`,
  *   which `fitLayout` treats as a constant, and the fit would over-shoot every time the cell changed.
  */
function gridColsIn(card: HTMLElement, step: number, mode: 'max' | 'sum' = 'max'): number {
  let n = 0;
  for (const g of Array.from(card.querySelectorAll<HTMLElement>('.inv-grid'))) {
    const cols = Math.round((g.offsetWidth + CV_GAP) / step);
    n = mode === 'sum' ? n + cols : Math.max(n, cols);
  }
  return n;
}

export interface CorpViewOptions {
  /** Embedded (inventory tab) instead of the standalone overlay: no subtitle line. */
  embedded?: boolean;
}

export class CorpView {
  private readonly nodes: HTMLElement[] = [];
  private readonly corpTabs = new Map<CorpId, HTMLButtonElement>();
  private readonly corpLv = new Map<CorpId, HTMLElement>();
  /** The selected corp's branch — moved under its tab (`refresh`). Holds the 신뢰도 gauge and the page tabs. */
  private readonly branch: HTMLElement;
  private branchCorp: CorpId | null = null;
  private readonly rep: { lv: HTMLElement; bar: HTMLElement; text: HTMLElement };
  private readonly subTabs = new Map<CorpPage, HTMLButtonElement>();
  private readonly page: HTMLElement;
  private readonly msg: HTMLElement;
  /**
   * 2026-09-12 (E2): the confirm-once-more popup for selling a favorite item (1 s hold · Escape cancels).
   * Hangs off `ctx.uiRoot`.
   */
  private readonly ask: HoldAsk;
  /** 귀중품 전부 담기 — under the 판매 tray, so it is built with the 거래 page. */
  private btnStageValuables: HTMLButtonElement | null = null;
  private unsubs: Array<() => void> = [];
  private corp: CorpId = 'helix';
  private current: CorpPage = 'trade';
  private msgTimer = 0;
  private disposed = false;

  /* ── 2026-09-13: cell size fitting ── */
  /** Cell edge in px right now (`CV_CELL_MIN … CV_CELL_MAX`). */
  private cell = CV_CELL_MAX;
  /** 함선 창고 · 가방 cards hidden because even `CV_CELL_MIN` does not fit. */
  private invHidden = false;
  /** Width those two cards need beyond their grid columns (chrome + gaps) and their column count — measured while shown. */
  private invChrome: { px: number; cols: number } | null = null;
  private fitTimer = 0;
  /** Page the last fit was scheduled for — a page switch re-fits. */
  private fittedPage: CorpPage | null = null;
  private resizeObs: ResizeObserver | null = null;

  /* ── page bodies (built once) ── */
  private tradeEl: HTMLElement | null = null;
  private shopGrid!: TileGrid;
  private buyGrid!: TileGrid;
  private sellGrid!: TileGrid;
  private buyTotalEl!: HTMLElement;
  private sellTotalEl!: HTMLElement;
  private netEl!: HTMLElement;
  private netValEl!: HTMLElement;
  private confirmBtn!: HTMLButtonElement;
  private confirmFill!: HTMLElement;
  private tradeInv: InvCard[] = [];
  /** 거래 성사 hold in progress (`UI_HOLD_CONFIRM_S`). */
  private hold: { t0: number; raf: number; timer: number } | null = null;

  private contractsEl: HTMLElement | null = null;
  private contractListEl!: HTMLElement;
  private contractActiveCol!: HTMLElement;
  private contractActiveEl!: HTMLElement;

  /* Phase 12: 임플란트 수리 desk */
  private implantsEl: HTMLElement | null = null;
  private implantGrid!: TileGrid;
  private implantDetailEl!: HTMLElement;
  private implantInv: InvCard[] = [];
  private selectedImplant: string | null = null;

  /* ── staged basket ── */
  private buyLines: BuyLine[] = [];
  private sellLines: SellLine[] = [];
  /** Suppress the per-purchase toast while a whole basket settles. */
  private settling = false;
  /**
   * Purchases still expected to announce themselves after a settle. With server-owned credits `meta.buy` resolves
   * **asynchronously** (`credits:tx`), so its `meta:purchase` lands after `settling` is already false and its toast
   * would bury the basket summary. Each late arrival decrements this instead of toasting.
   */
  private quietPurchases = 0;

  constructor(
    private readonly ctx: GameContext,
    private readonly meta: MetaSystem,
    private readonly host: HTMLElement,
    private readonly opts: CorpViewOptions = {},
  ) {
    host.classList.add('corp-view');
    if (opts.embedded) host.classList.add('is-embedded');
    this.applyCellVars();
    const add = <K extends keyof HTMLElementTagNameMap>(e: HTMLElementTagNameMap[K]): HTMLElementTagNameMap[K] => {
      this.nodes.push(e as unknown as HTMLElement);
      return e;
    };

    /*
     * The corp rail is an **independent card** — a direct child of the host, outside `.corp-shell` (2026-09-12 2nd
     * pass). Since 2026-09-13 it stands in **one row** with the page's cards and uses the whole height. The left
     * column is still a **tree** — one branch travels among the corp buttons, right under the selected corp. There is
     * no `기업` title row (2026-09-12, user's decision).
     */
    const rail = add(el('div', { cls: 'corp-rail', parent: host }));
    const tabs = el('div', { cls: 'corp-tabs', parent: rail, attrs: { role: 'tree' } });
    for (const id of CORP_IDS) {
      const def = CORP_DEFS[id];
      const b = el('button', { cls: 'corp-tab', parent: tabs, attrs: { 'data-corp': id, role: 'treeitem', 'aria-expanded': 'false' } });
      b.style.setProperty('--cc', def.color);
      el('span', { cls: 'caret', parent: b });
      el('span', { cls: 'name', text: def.name, parent: b });
      this.corpLv.set(id, el('span', { cls: 'lv', text: 'Lv.0', parent: b }));
      b.addEventListener('click', (e) => { e.stopPropagation(); this.setCorp(id); });
      this.corpTabs.set(id, b);
    }

    this.branch = el('div', { cls: 'corp-branch', parent: tabs, attrs: { role: 'group' } });
    /* The 신뢰도 gauge — no `신뢰도` label: what the ticks right under the corp measure needs no explaining. */
    const repEl = el('div', { cls: 'corp-rep', parent: this.branch });
    const repRow = el('div', { cls: 'row', parent: repEl });
    const lv = el('span', { cls: 'lv', text: 'Lv.0', parent: repRow });
    const text = el('span', { cls: 'rep-text', parent: repRow });
    const bar = el('div', { cls: 'rep-bar', parent: repEl });
    const fill = el('i', { parent: bar });
    this.rep = { lv, bar: fill, text };

    const sub = el('div', { cls: 'corp-subtabs', parent: this.branch });
    for (const p of PAGES) {
      const b = el('button', { cls: 'scr-tab', text: p.label, parent: sub, attrs: { 'data-page': p.id } });
      b.addEventListener('click', (e) => { e.stopPropagation(); this.setPage(p.id); });
      this.subTabs.set(p.id, b);
    }

    const shell = add(el('div', { cls: 'corp-shell', parent: host }));
    this.page = el('div', { cls: 'corp-page', parent: shell });
    // the message keeps a reserved slot so showing / hiding it never moves the frame
    const msgSlot = add(el('div', { cls: 'corp-msg-slot', parent: host }));
    this.msg = el('div', { cls: 'form-msg', parent: msgSlot });
    this.msg.hidden = true;
    this.ask = new HoldAsk(ctx, ctx.uiRoot);

    // 2026-09-13: the window (and so the host) changed size → fit the cell size again once it settles
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObs = new ResizeObserver(() => this.scheduleFit(FIT_DEBOUNCE_MS));
      this.resizeObs.observe(host);
    }

    const b = ctx.bus;
    const refresh = (): void => this.refreshIfVisible();
    this.unsubs.push(
      b.on('meta:creditsChanged', refresh), b.on('meta:repChanged', refresh), b.on('meta:contractAccepted', refresh),
      b.on('meta:contractAbandoned', refresh), b.on('meta:contractSettled', refresh),
      b.on('meta:purchase', ({ defId, price }) => {
        if (this.quietPurchases > 0) this.quietPurchases--;
        else if (this.visible && !this.settling) this.showMsg(`${this.defName(defId)} 구매 · −${formatCredits(price)}`, 'success');
        refresh();
      }),
      b.on('meta:sale', refresh), b.on('meta:loaded', refresh),
      b.on('inventory:changed', refresh), b.on('inventory:stashChanged', refresh), b.on('loadout:changed', refresh),
      // 2026-09-12 (E2): the tiles carry the blue ribbon from `buildItemTile` — rebuild them when a favorite flips
      b.on('inventory:favoritesChanged', refresh),
      // 2026-09-13 (library series): `buildItemTile` puts the same ribbon on a 「아직 꽂지 않음」 book · video · record
      b.on('housing:libraryChanged', refresh),
      meta.onPurchaseFailure((f: PurchaseFailure) => {
        if (!this.visible || this.settling) return;
        this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
        this.showMsg(`${this.defName(f.defId)} 구매 실패 · ${f.reason}`, 'danger');
        this.refresh();
      }),
      meta.onImplantRepaired((r: ImplantRepairResult) => {
        if (!this.visible) return;
        this.ctx.bus.emit('audio:play', { id: r.ok ? 'ui_equip' : 'ui_deny' });
        this.showMsg(r.ok ? `${this.defName(r.brokenId)} → ${this.defName(r.targetId ?? r.brokenId)} 수리 완료 · −${formatCredits(r.fee)}`
          : `${this.defName(r.brokenId)} 수리 실패 · ${r.reason ?? ''}`, r.ok ? 'success' : 'danger');
        this.refresh();
      }),
    );
  }

  get currentCorp(): CorpId { return this.corp; }
  get currentPage(): CorpPage { return this.current; }
  /** Staged basket (debug / smoke). */
  get staged(): { buy: readonly BuyLine[]; sell: readonly SellLine[] } { return { buy: this.buyLines, sell: this.sellLines }; }
  /** 2026-09-13: fitted cell edge in px and whether the 함선 창고 · 가방 cards are hidden (debug / smoke). */
  get layoutFit(): { cell: number; invHidden: boolean } { return { cell: this.cell, invHidden: this.invHidden }; }
  private get visible(): boolean {
    return !this.disposed && this.host.isConnected;
  }

  setCorp(corp: CorpId): void {
    if (this.corp === corp || !CORP_DEFS[corp]) return;
    // 2026-09-17 (user's decision): a corp whose 신뢰도 is below `CORP_ACCESS_REP_LEVEL` cannot be selected — like
    // the sub-tab locking it still takes the click and says why
    const lock = this.corpLock(corp);
    if (lock) {
      this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
      this.ctx.bus.emit('ui:notify', { text: `${CORP_DEFS[corp].name} · ${lock}`, kind: 'warning', duration: 2.2 });
      this.showMsg(`${CORP_DEFS[corp].name} · ${lock}`, 'danger');
      return;
    }
    this.corp = corp;
    this.clearBasket();              // a basket belongs to the corp it was assembled at
    this.selectedImplant = null;
    // the 임플란트 desk is 세레스 only, and the new corp's 신뢰도 may lock 거래 / 계약 (2026-09-08)
    this.current = this.resolvePage(this.current);
    this.hideMsg();
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.refresh();
  }

  /** Used by the overlay when it is (re-)opened on a specific corp, without the click SFX / repaint. */
  setCorpSilent(corp: CorpId): void {
    if (CORP_DEFS[corp] && !this.corpLock(corp)) this.corp = corp;
  }

  /**
   * 2026-09-17 (user's decision): why `corp` cannot be selected (Korean), or null. A corp opens at
   * `CORP_ACCESS_REP_LEVEL` — the first level comes from that corp's first NPC quest (`data/npc_quests.csv`), and
   * every contract starts at Lv.1.
   */
  corpLock(corp: CorpId): string | null {
    return this.meta.getRep(corp).level < CORP_ACCESS_REP_LEVEL ? `신뢰도 Lv.${CORP_ACCESS_REP_LEVEL} 필요` : null;
  }

  /** `this.corp` when it is open, else the first open corp in rail order (unchanged when none is — the tab is hidden then). */
  private resolveCorp(): void {
    if (!this.corpLock(this.corp)) return;
    const open = CORP_IDS.find((id) => !this.corpLock(id));
    if (!open) return;
    this.corp = open;
    this.clearBasket();
    this.selectedImplant = null;
  }

  /**
   * Why `page` is locked at the current corp / 신뢰도 (Korean), or null when it is open. 거래 opens at
   * `SHOP_UNLOCK_REP_LEVEL`; 계약 opens as soon as **one** of the corp's contracts is within reach. The 임플란트 수리 desk is
   * never rep-gated.
   */
  pageLock(page: CorpPage): string | null {
    const level = this.meta.getRep(this.corp).level;
    if (page === 'trade') return level < SHOP_UNLOCK_REP_LEVEL ? `신뢰도 Lv.${SHOP_UNLOCK_REP_LEVEL} 부터 거래 가능` : null;
    if (page === 'contracts') {
      const list = this.meta.getContracts(this.corp);
      if (list.length === 0) return null;            // no contracts at all — the page says so itself
      let need = Number.POSITIVE_INFINITY;
      for (const c of list) need = Math.min(need, c.def.minRepLevel);
      return level < need ? `신뢰도 Lv.${need} 부터 계약 가능` : null;
    }
    return null;
  }

  /** `want` when this corp has it and it is unlocked, else the first page that is open (계약 when every page is locked). */
  private resolvePage(want: CorpPage): CorpPage {
    const pages = pagesFor(this.corp);
    if (pages.includes(want) && !this.pageLock(want)) return want;
    return pages.find((p) => !this.pageLock(p)) ?? 'contracts';
  }

  /**
   * 2026-09-08: a rep-locked sub-tab stays enabled and only *looks* locked (`.is-locked`) — clicking it says why, as a
   * **toast** (`ui:notify`) and in the panel's own reserved message slot.
   */
  setPage(page: CorpPage): void {
    if (!pagesFor(this.corp).includes(page)) return;
    const lock = this.pageLock(page);
    if (lock) {
      const label = PAGES.find((p) => p.id === page)?.label ?? '';
      this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
      this.ctx.bus.emit('ui:notify', { text: `${label} · ${lock}`, kind: 'warning', duration: 2.2 });
      this.showMsg(`${label} · ${lock}`, 'danger');
      return;
    }
    if (this.current === page) return;
    this.current = page;
    this.hideMsg();
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.refresh();
  }

  /* ── state → DOM ──────────────────────────────────────────────────────── */
  private refreshIfVisible(): void { if (this.visible) this.refresh(); }

  refresh(): void {
    if (this.disposed) return;
    const meta = this.meta;
    this.resolveCorp();              // 2026-09-17: a Lv.0 corp is never the selected one while an open corp exists
    for (const id of CORP_IDS) {
      const r = meta.getRep(id);
      const tab = this.corpTabs.get(id)!;
      setText(this.corpLv.get(id)!, `Lv.${r.level}`);
      // never `disabled`: the locked corp still takes the click that explains itself (same as the sub-tabs)
      const lock = this.corpLock(id);
      tab.title = lock ?? '';
      toggleClass(tab, 'is-locked', lock !== null);
      tab.setAttribute('aria-disabled', lock ? 'true' : 'false');
      toggleClass(tab, 'is-on', id === this.corp);
      tab.setAttribute('aria-expanded', id === this.corp ? 'true' : 'false');
    }
    const def = CORP_DEFS[this.corp];
    const rep = meta.getRep(this.corp);
    this.host.style.setProperty('--cc', def.color);
    // the branch hangs under the selected corp's button — one open at a time, re-played when it moves
    const tab = this.corpTabs.get(this.corp)!;
    if (tab.nextElementSibling !== this.branch) tab.after(this.branch);
    if (this.branchCorp !== this.corp) {
      this.branchCorp = this.corp;
      this.branch.classList.remove('is-opening');
      void this.branch.offsetWidth;          // restart the open animation
      this.branch.classList.add('is-opening');
    }
    this.branch.style.setProperty('--cc', def.color);
    setText(this.rep.lv, `Lv.${rep.level}`);
    const prev = REP_TABLE[rep.level] ?? 0;            // cumulative rep where the current level started
    const span = rep.next === null ? 1 : Math.max(1, rep.next - prev);
    const frac = rep.next === null ? 1 : Math.max(0, Math.min(1, (rep.rep - prev) / span));
    this.rep.bar.style.transform = `scaleX(${frac.toFixed(3)})`;
    setText(this.rep.text, rep.next === null ? `${fmtNum(rep.rep)} · 최고 등급` : `${fmtNum(rep.rep)} / ${fmtNum(rep.next)}`);

    const pages = pagesFor(this.corp);
    this.current = this.resolvePage(this.current);
    for (const p of PAGES) {
      const b = this.subTabs.get(p.id)!;
      b.hidden = !pages.includes(p.id);
      const lock = pages.includes(p.id) ? this.pageLock(p.id) : null;
      // never `disabled`: a locked tab must still take the click that explains itself (2026-09-08)
      b.disabled = false;
      b.title = lock ?? '';
      toggleClass(b, 'is-locked', lock !== null);
      toggleClass(b, 'is-on', p.id === this.current);
    }

    this.page.dataset.page = this.current;
    this.pruneBasket();
    const body = this.current === 'trade' ? this.buildTrade()
      : this.current === 'contracts' ? this.buildContracts()
        : this.buildImplants();
    if (this.page.firstElementChild !== body) this.page.replaceChildren(body);
    if (this.current !== 'trade') this.cancelHold();
    if (this.current === 'trade') this.renderTrade();
    else if (this.current === 'contracts') this.renderContracts();
    else this.renderImplants();
    // 2026-09-13: every page has its own cards — a page switch (and the first paint) fits the cell size to them
    if (this.fittedPage !== this.current) { this.fittedPage = this.current; this.scheduleFit(0); }
  }

  /* ── 2026-09-13: cell size fitting (40 → 32 px, and if that still misses, the 창고 · 가방 card hides) ── */

  private applyCellVars(): void {
    this.host.style.setProperty('--cv-cell', `${this.cell}px`);
    this.host.style.setProperty('--cv-step', `${this.cell + CV_GAP}px`);
    this.host.dataset.cvCell = String(this.cell);
  }

  private scheduleFit(delay: number): void {
    if (this.disposed) return;
    if (this.fitTimer) clearTimeout(this.fitTimer);
    this.fitTimer = window.setTimeout(() => { this.fitTimer = 0; this.fitLayout(); }, delay);
  }

  private pageRoot(): HTMLElement | null {
    return this.current === 'trade' ? this.tradeEl : this.current === 'implants' ? this.implantsEl : null;
  }

  /**
   * Fit the cell edge to the width the current page's card row has. Every card is measured: a content-sized card's
   * width minus its widest grid (`n × step − gap`), a fluid card's (`.is-fluid`, `data-cv-cols`) CSS `min-width` minus
   * the same, plus the gaps — the rest of the row is `columns × step`, so one measurement gives the answer. The 함선 창고 ·
   * 가방 cards' share is remembered while they are shown, so a wider window can bring them back. A change re-measures
   * (at most twice — the model is linear, the second pass only confirms). Public for the smoke scripts.
   */
  fitLayout(depth = 0): void {
    const root = this.pageRoot();
    if (this.disposed || !root || !root.isConnected) return;
    const avail = root.clientWidth;
    if (avail <= 0) return;           // not laid out (hidden host) — the observer fires again once it shows
    const gap = parseFloat(getComputedStyle(root).columnGap) || 0;
    const step = this.cell + CV_GAP;
    let px = 0, cols = 0, cards = 0, invPx = 0, invCols = 0;
    for (const card of Array.from(root.children) as HTMLElement[]) {
      const isInv = card.classList.contains('cv-inv');
      if (isInv && this.invHidden) continue;
      const fluid = card.classList.contains('is-fluid');
      const n = fluid ? Number(card.dataset.cvCols ?? 0) || 0 : gridColsIn(card, step, isInv ? 'sum' : 'max');
      const w = fluid ? parseFloat(getComputedStyle(card).minWidth) || 0 : card.getBoundingClientRect().width;
      const chrome = w - (n > 0 ? n * step - CV_GAP : 0);
      if (isInv) { invPx += chrome + gap; invCols += n; } else { px += chrome; cols += n; cards++; }
    }
    px += Math.max(0, cards - 1) * gap;
    if (!this.invHidden && invCols > 0) this.invChrome = { px: invPx, cols: invCols };
    const inv = this.invChrome;
    // largest cell that fits: (avail − fixed) / columns − gap, 1 px of slack for sub-pixel card widths
    const fit = (fixed: number, n: number): number => (n > 0 ? Math.floor((avail - fixed - 1) / n) - CV_GAP : CV_CELL_MAX);
    const clamp = (c: number): number => Math.max(CV_CELL_MIN, Math.min(CV_CELL_MAX, c));
    const withInv = inv ? fit(px + inv.px, cols + inv.cols) : fit(px, cols);
    let cell: number;
    let hide = false;
    if (withInv >= CV_CELL_MIN || !inv) cell = clamp(withInv);
    else { hide = true; cell = clamp(fit(px, cols)); }
    const changed = hide !== this.invHidden || cell !== this.cell;
    if (hide !== this.invHidden) this.setInvHidden(hide);
    if (cell !== this.cell) this.applyCell(cell);
    if (changed && depth < 2) this.fitLayout(depth + 1);
  }

  private setInvHidden(hide: boolean): void {
    this.invHidden = hide;
    for (const r of [this.tradeEl, this.implantsEl]) if (r) toggleClass(r, 'is-inv-hidden', hide);
  }

  /** New cell edge: CSS vars, every tile grid built so far, every inventory card, then a repaint (tiles bake their size). */
  private applyCell(cell: number): void {
    this.cell = cell;
    this.applyCellVars();
    if (this.tradeEl) { this.shopGrid.setCell(cell); this.buyGrid.setCell(cell); this.sellGrid.setCell(cell); }
    if (this.implantsEl) this.implantGrid.setCell(cell);
    for (const c of [...this.tradeInv, ...this.implantInv]) {
      if (!c.view) continue;
      if (isTradeGridsView(c.view)) c.view.setCell(cell);
      else { c.view.dispose(); c.view = this.createInv(c.card, c.drop); }   // an inventory without `setCell`: rebuild
    }
    this.refresh();
  }

  private itemDef(defId: string): ItemDef | undefined { return this.ctx.loot?.getItemDef(defId) ?? this.ctx.inventory?.getDef(defId); }
  private defName(defId: string): string { return this.itemDef(defId)?.name ?? defId; }
  private empty(parent: HTMLElement, text: string): void {
    el('div', { cls: 'corp-empty', text, parent });
  }

  /**
   * One inventory-look tile (`InventoryRef.buildItemTile`) with its footprint, for a `TileGrid`. `cls` are this
   * screen's markers (`shop` / `buy` / `sell` / `broken`); the tile itself already carries the hover-card hook.
   */
  private makeTile(defId: string, qty: number, cls: string, durability?: number): TileSpec {
    const def = this.itemDef(defId);
    const inv = this.ctx.inventory;
    let tile: HTMLElement;
    if (inv && typeof inv.buildItemTile === 'function') {
      tile = inv.buildItemTile(defId, qty, durability === undefined ? { cell: this.cell } : { cell: this.cell, durability });
    } else {
      tile = document.createElement('div');
      tile.className = 'inv-tile';
      tile.appendChild(buildItemChip(def, { size: 28 }));
    }
    tile.classList.add('cv-tile', ...cls.split(' ').filter(Boolean));
    // 2026-09-12 (E2): every desk tile (stock the player does not own included) takes the 즐겨찾기 right-click menu —
    // `ui/hud/ItemFavoriteMenu` delegates on this attribute next to `data-def-id`. The drag ghost does not.
    if (!cls.includes('cv-ghost')) tile.setAttribute(ITEM_FAVORITE_MENU_ATTR, '');
    return { tile, w: def?.width ?? 1, h: def?.height ?? 1 };
  }

  /**
   * 2026-09-16 (user's decision): this tile's hover card writes `label` (`구매가` · `판매가`) and `credits` instead
   * of 「가치」. 가치 is the same number wherever the item sits, so it is not the value to read on a trade screen —
   * the money that really moves here is a 구매가 with the 신뢰도 discount in it, or a 판매가 with `SELL_PRICE_MUL` in
   * it. The shared card reads it with `closest`, so stamping the tile is enough.
   */
  private tagTipPrice(tile: HTMLElement, label: string, credits: number): void {
    tile.setAttribute(TIP_PRICE_ATTR, String(Math.max(0, Math.round(credits))));
    tile.setAttribute(TIP_PRICE_LABEL_ATTR, label);
  }

  /* ══ 거래 — the shop and selling ══════════════════════════════════════ */

  private buildTrade(): HTMLElement {
    if (this.tradeEl) return this.tradeEl;
    const root = el('div', { cls: 'cv' });
    toggleClass(root, 'is-inv-hidden', this.invHidden);
    const grid = { cell: this.cell, gap: CV_GAP };

    /* 판매 물품 — 2026-09-16 (user's decision): **fixed** at `SHOP_COLS` cells wide. It is a content-sized card, not
       the old fluid card (`.is-fluid`), so `fitLayout` measures it like every other card (CSS `.cv-col.shop`'s
       minimum width is the same cell count). */
    const shop = el('div', { cls: 'cv-col shop cv-card', parent: root, attrs: { 'data-cv-cols': String(SHOP_COLS) } });
    el('div', { cls: 'cv-title', text: '기업 판매 물품', parent: shop });
    this.shopGrid = new TileGrid(shop, { ...grid, cols: SHOP_COLS, className: 'cv-shop' });

    // 거래 테이블 — the two trays are **stacked** (구매 over 판매) so each is a real five-column item grid
    const deal = el('div', { cls: 'cv-col deal cv-card', parent: root });
    const trays = el('div', { cls: 'cv-trays', parent: deal });
    const mkTray = (kind: 'buy' | 'sell', label: string): { tray: HTMLElement; grid: TileGrid; total: HTMLElement } => {
      const tray = el('div', { cls: `cv-tray ${kind}`, parent: trays });
      const head = el('div', { cls: 'cv-tray-head', parent: tray });
      /* The three chevrons = the side things flow to. 구매 points right from the top right (toward my 가방 · 창고),
         판매 left from the top left (toward the corp). */
      if (kind === 'sell') head.appendChild(chevrons('left', 3, 'flow'));
      el('span', { cls: 'k', text: label, parent: head });
      const total = el('span', { cls: 'v', text: '0', parent: head });
      if (kind === 'buy') head.appendChild(chevrons('right', 3, 'flow'));
      return { tray, grid: new TileGrid(tray, { ...grid, cols: TRAY_COLS, className: 'cv-slots' }), total };
    };
    const buy = mkTray('buy', '구매');
    const sell = mkTray('sell', '판매');
    this.buyGrid = buy.grid; this.buyTotalEl = buy.total;
    this.sellGrid = sell.grid; this.sellTotalEl = sell.total;
    this.btnStageValuables = this.button(sell.tray, '귀중품 전부 담기', () => this.stageValuables(), 'cv-stage');

    /* The credit change after the trade — one centred line, no label.
       2026-09-16 (user's decision): the chevrons on either side (▲ ▼) were dropped — the sign and the text colour
       (`.cv-total.plus` / `.minus`) already say the direction. The flow chevrons in the tray heads stay, because they
       say 「물건이 어느 쪽으로 가는가」. */
    this.netEl = el('div', { cls: 'cv-total', parent: deal });
    this.netValEl = el('span', { cls: 'v', text: '0', parent: this.netEl });

    this.confirmBtn = el('button', { cls: 'ui-btn primary cv-confirm', parent: deal }) as HTMLButtonElement;
    this.confirmFill = el('i', { cls: 'cv-confirm-fill', parent: this.confirmBtn });
    // 2026-09-15 2nd pass (user's decision): 「how do I press it」 is told by the left-click hold keycap left of
    // the label.
    createHoldButtonCap(this.confirmBtn);
    el('span', { cls: 'cv-confirm-label', text: '거래 성사', parent: this.confirmBtn });
    this.bindHold(this.confirmBtn);

    // 함선 창고 | 가방 — one card holding both grids, each grid with its own header + scroll (2026-09-15 3rd pass,
    // `makeInvCards` below)
    this.tradeInv = this.makeInvCards(root, 'cv-col', '.cv-tray.sell');

    this.tradeEl = root;
    this.nodes.push(root);
    return root;
  }

  /**
   * `거래 성사` is a **1 s hold** (2026-09-12, `UI_HOLD_CONFIRM_S`). Click and keyboard activation do nothing; a
   * short press that lets go early says how the button works. The gauge is `.cv-confirm-fill` (scaleX 0 → 1).
   */
  private bindHold(btn: HTMLButtonElement): void {
    btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); });
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); }
    });
    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || btn.disabled || this.hold) return;
      e.stopPropagation(); e.preventDefault();
      try { btn.setPointerCapture(e.pointerId); } catch { /* synthetic events have no capture */ }
      const holdMs = Math.max(1, UI_HOLD_CONFIRM_S * 1000);
      const t0 = performance.now();
      const tick = (): void => {
        if (!this.hold) return;
        const f = Math.min(1, (performance.now() - t0) / holdMs);
        this.confirmFill.style.transform = `scaleX(${f.toFixed(3)})`;
        if (f < 1) this.hold.raf = requestAnimationFrame(tick);
      };
      // the gauge rides rAF; the settle rides a timer, so a frame that never comes (hidden tab) cannot stall the trade
      const done = window.setTimeout(() => {
        if (!this.hold || this.hold.t0 !== t0) return;
        this.cancelHold();
        this.requestTrade();
      }, holdMs);
      this.hold = { t0, raf: requestAnimationFrame(tick), timer: done };
      btn.classList.add('is-holding');
    });
    const release = (): void => {
      const h = this.hold;
      if (!h) return;
      const f = (performance.now() - h.t0) / Math.max(1, UI_HOLD_CONFIRM_S * 1000);
      this.cancelHold();
      if (f < HOLD_TAP_HINT) this.showMsg('거래 성사 버튼을 1초간 꾹 누르세요', 'info');
    };
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('pointerleave', release);
    btn.addEventListener('lostpointercapture', release);
  }

  private cancelHold(): void {
    const h = this.hold;
    this.hold = null;
    if (h) { cancelAnimationFrame(h.raf); clearTimeout(h.timer); }
    if (this.tradeEl) {
      this.confirmFill.style.transform = 'scaleX(0)';
      this.confirmBtn.classList.remove('is-holding');
    }
  }

  /**
   * **One 창고 + 가방 card** (2026-09-13 two cards → **2026-09-15 3rd pass one card**, user's decision) — it sits at
   * the end of the 거래 · 임플란트 page row. Since 2026-09-15 2nd pass the inventory draws 창고 (left) and my 가방
   * (right) inside one panel, each pane with its own scroll · own sort · own filter, so `createTradeGrids` is called
   * **once** here.
   * `colCls` keeps each page's column class (`cv-col` / `ci-col` + `inv`) so older selectors still find it.
   * The returned array has length 1 — it stays an array so `applyCell` · `refreshInv` keep their shape.
   */
  private makeInvCards(root: HTMLElement, colCls: string, drop?: string): InvCard[] {
    // `stash bag` carries both **for the older selectors** — this one card now holds both, so it is not a lie, and
    // no CSS rule reads those two names (2026-09-15 3rd pass).
    const card = el('div', { cls: `${colCls} inv cv-card cv-inv stash bag`, parent: root, attrs: { 'data-cv-grid': 'inv' } });
    const view = this.createInv(card, drop);
    if (!view) this.empty(card, '인벤토리를 사용할 수 없습니다');
    return [{ card, view, drop }];
  }

  /**
   * The embedded 창고 + 가방 view (`createTradeGrids` — **once**, each pane with its own header row · sort · filter ·
   * scroll).
   * With a `drop` selector a tile dropped on it (or double-clicked) is staged for sale; **without one the grids are
   * read-only** — the 임플란트 desk has nothing to drop onto, and handing it `onTake` would make a double-click stage a
   * sale on a page that has no 판매칸 (2026-09-12 2nd pass).
   */
  private createInv(card: HTMLElement, drop?: string): EmbeddedView | null {
    const inv = this.ctx.inventory;
    if (!inv || typeof inv.createTradeGrids !== 'function') return null;
    // 2026-09-12 (user's decision): 창고 left · 가방 right — that order is this array
    const opts: TradeGridsViewOptions = { grids: ['stash', 'bag'], layout: 'split', chips: 'block', cell: this.cell, className: 'cv-tg' };
    if (drop) {
      opts.dropSelector = drop;
      opts.isStaged = (uid) => this.sellLines.some((s) => s.uid === uid);
      opts.onTake = (item) => this.stageSell(item);
    }
    return inv.createTradeGrids(card, opts);
  }

  private refreshInv(cards: readonly InvCard[]): void {
    for (const c of cards) c.view?.refresh();
  }

  private renderTrade(): void {
    /* Left: 기업 판매 물품 — the grid keeps its shape even when it is locked / empty, the reason centred over it */
    const rep = this.meta.getRep(this.corp);
    const shopSpecs: TileSpec[] = [];
    let shopEmpty: string | null = null;
    if (rep.level < SHOP_UNLOCK_REP_LEVEL) shopEmpty = `신뢰도 Lv.${SHOP_UNLOCK_REP_LEVEL} 부터 거래 가능`;
    else {
      const lines = this.meta.getShop(this.corp);
      if (lines.length === 0) shopEmpty = '판매 중인 품목이 없습니다';
      else for (const line of lines) shopSpecs.push(this.shopTile(line));
    }
    this.shopGrid.render(shopSpecs, shopEmpty);

    /* Middle: the 거래 테이블 */
    const cost = this.buyCost(), revenue = this.sellRevenue();
    /* 2026-09-16: a 구매칸 tile's hover card says 「구매가」 too — it writes what one purchase costs (the same
       number the 매대 shows). */
    const shopPrices = new Map(this.meta.getShop(this.corp).map((l) => [l.def.id, l.price] as const));
    const buySpecs: TileSpec[] = [];
    for (const line of this.buyLines) {
      const def = this.itemDef(line.defId);
      const spec = this.makeTile(line.defId, def ? shopQtyOf(def) : 1, 'buy');
      spec.tile.dataset.def = line.defId;
      const buyPrice = shopPrices.get(line.defId) ?? 0;
      /* 2026-09-16 (user's bug report 「구매칸에는 가격이 아예 안 뜬다」): the **same bottom-left badge** as a 매대 ·
         판매칸 tile — what one purchase costs (the number written on the 매대), in the opposite corner from the staged
         count (`.cv-count`, bottom right), so the two never collide. */
      el('div', { cls: 'cv-price', text: formatCreditAmount(buyPrice), parent: spec.tile });
      this.tagTipPrice(spec.tile, '구매가', buyPrice);
      el('div', { cls: 'cv-count', text: `×${line.qty}`, parent: spec.tile });
      spec.tile.addEventListener('click', (e) => { e.stopPropagation(); this.unstageBuy(line.defId); });
      buySpecs.push(spec);
    }
    this.buyGrid.render(buySpecs);
    const sellSpecs: TileSpec[] = [];
    for (const line of this.sellLines) {
      const inst = this.ctx.inventory?.findItemAnywhere?.(line.uid) ?? null;
      if (!inst) continue;
      const spec = this.makeTile(inst.defId, line.qty, 'sell', inst.durability);
      spec.tile.dataset.uid = line.uid;
      const sellPrice = this.meta.sellPriceOf(line.uid, line.qty) ?? 0;
      el('div', { cls: 'cv-price', text: formatCreditAmount(sellPrice), parent: spec.tile });
      this.tagTipPrice(spec.tile, '판매가', sellPrice);
      spec.tile.addEventListener('click', (e) => { e.stopPropagation(); this.unstageSell(line.uid); });
      sellSpecs.push(spec);
    }
    this.sellGrid.render(sellSpecs);
    setText(this.buyTotalEl, `−${formatCredits(cost)}`);
    setText(this.sellTotalEl, `+${formatCredits(revenue)}`);
    const net = revenue - cost;
    setText(this.netValEl, `${net > 0 ? '+' : net < 0 ? '−' : ''}${formatCredits(Math.abs(net))}`);
    toggleClass(this.netEl, 'plus', net > 0);
    toggleClass(this.netEl, 'minus', net < 0);
    const blocked = this.tradeBlock(cost, revenue);
    this.confirmBtn.disabled = !!blocked;
    this.confirmBtn.title = blocked ?? '';
    if (blocked) this.cancelHold();
    if (this.btnStageValuables) this.btnStageValuables.disabled = this.meta.getSellable().length === 0;

    this.refreshInv(this.tradeInv);
  }

  /** Korean reason the basket cannot settle right now; null = go ahead. */
  private tradeBlock(cost: number, revenue: number): string | null {
    if (this.buyLines.length === 0 && this.sellLines.length === 0) return '거래할 항목이 없습니다';
    if (this.meta.credits + revenue < cost) return '크레딧이 부족합니다';
    return null;
  }

  private buyCost(): number {
    const prices = new Map(this.meta.getShop(this.corp).map((l) => [l.def.id, l.price] as const));
    let sum = 0;
    for (const b of this.buyLines) sum += (prices.get(b.defId) ?? 0) * b.qty;
    return sum;
  }

  private sellRevenue(): number {
    let sum = 0;
    for (const s of this.sellLines) sum += this.meta.sellPriceOf(s.uid, s.qty) ?? 0;
    return sum;
  }

  /**
   * One stock **tile** in the 기업 판매 물품 grid: price badge bottom-left, a `×n` badge while the line is staged.
   * Click or drag onto the 구매 tray to stage it; a blocked line is dimmed and its click says why.
   *
   * 2026-09-16 (user's decision): the count a tile carries is **how many units one purchase gives**
   * (`Rules.shopQtyOf` — ammo is a full stack), and `line.price` is the price of that many. So the stack count is
   * stamped on it exactly as on a 가방 tile.
   */
  private shopTile(line: ShopItem): TileSpec {
    const d = line.def;
    const spec = this.makeTile(d.id, shopQtyOf(d), 'shop');
    const tile = spec.tile;
    tile.dataset.def = d.id;
    el('div', { cls: 'cv-price', text: formatCreditAmount(line.price), parent: tile });
    this.tagTipPrice(tile, '구매가', line.price);
    const staged = this.buyLines.find((b) => b.defId === d.id);
    if (staged) el('div', { cls: 'cv-staged', text: `×${staged.qty}`, parent: tile });
    toggleClass(tile, 'blocked', line.blocked !== null);
    // no `title` attribute: it would race the hover card, which already carries 등급 · 분류 · 설명
    tile.addEventListener('click', (e) => { e.stopPropagation(); this.stageBuy(d.id); });
    if (line.blocked === null) {
      tile.classList.add('is-draggable');
      this.makeDraggable(tile, d, '.cv-tray.buy', () => this.stageBuy(d.id));
    }
    return spec;
  }

  /**
   * Pointer-drag for a corp stock tile: a floating copy follows the cursor and dropping it on `dropSelector` stages
   * the line. Moves are coalesced to one per frame and the ghost moves by `transform` (no layout per event).
   */
  private makeDraggable(tileEl: HTMLElement, def: ItemDef, dropSelector: string, onDrop: () => void): void {
    tileEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      let ghost: HTMLElement | null = null;
      let moved = false;
      let raf = 0;
      let last: PointerEvent | null = null;
      let over: HTMLElement | null = null;
      const step = this.cell + CV_GAP;
      const gw = (def.width ?? 1) * step - CV_GAP;
      const gh = (def.height ?? 1) * step - CV_GAP;
      const setOver = (t: HTMLElement | null): void => {
        if (over === t) return;
        over?.classList.remove('is-over');
        over = t;
        over?.classList.add('is-over');
      };
      const frame = (): void => {
        raf = 0;
        const ev = last;
        if (!ev || !ghost) return;
        ghost.style.transform = `translate(${ev.clientX - gw / 2}px, ${ev.clientY - gh / 2}px)`;
        const hit = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>(dropSelector) ?? null;
        ghost.classList.toggle('is-ok', !!hit);
        setOver(hit);
      };
      const move = (ev: PointerEvent): void => {
        if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 5) return;
        moved = true;
        if (!ghost) {
          ghost = this.makeTile(def.id, shopQtyOf(def), 'cv-ghost').tile;
          // the ghost lives on <body>, outside the view — carry the cell edge its content scales with
          ghost.style.setProperty('--inv-cell', `${this.cell}px`);
          document.body.appendChild(ghost);
        }
        last = ev;
        if (!raf) raf = requestAnimationFrame(frame);
      };
      const up = (ev: PointerEvent): void => {
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', up, true);
        if (raf) cancelAnimationFrame(raf);
        ghost?.remove();
        setOver(null);
        if (!moved) return;                        // a plain click is handled by the tile's own listener
        const hit = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest(dropSelector);
        if (hit) onDrop();
        // a drag that ends over the tile it started on is followed by a click — swallow only that one, so it does not
        // stage the line a second time (the listener is gone by the next task, so a later real click still counts)
        const swallow = (c: Event): void => { c.stopImmediatePropagation(); };
        tileEl.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => tileEl.removeEventListener('click', swallow, { capture: true }), 0);
      };
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', up, true);
    });
  }

  private stageBuy(defId: string): void {
    const line = this.meta.getShop(this.corp).find((l) => l.def.id === defId);
    if (!line) return;
    if (line.blocked !== null) { this.ctx.bus.emit('audio:play', { id: 'ui_deny' }); this.showMsg(line.blocked, 'warning'); return; }
    const existing = this.buyLines.find((b) => b.defId === defId);
    if (existing) existing.qty += 1; else this.buyLines.push({ defId, qty: 1 });
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.refresh();
  }

  private unstageBuy(defId: string): void {
    const i = this.buyLines.findIndex((b) => b.defId === defId);
    if (i < 0) return;
    if (this.buyLines[i].qty > 1) this.buyLines[i].qty -= 1; else this.buyLines.splice(i, 1);
    this.ctx.bus.emit('audio:play', { id: 'ui_close' });
    this.refresh();
  }

  private stageSell(item: ItemInstance): void {
    if (this.sellLines.some((s) => s.uid === item.uid)) return;
    /*
     * 2026-09-11 (E-9, user's decision): **0 C stages too.** A single 가치-1 item is `floor(0.5) = 0` — blocking that
     * here would leave no way to clear the weight, and because selling the stack whole pays its real price the player
     * learns on their own that splitting it loses money. The only refusal is `null` (a thing with no value ·
     * equipped · in neither the 가방 nor the 창고). The price badge still stamps `0`.
     */
    const price = this.meta.sellPriceOf(item.uid);
    if (price === null) {
      this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
      this.showMsg(`${this.defName(item.defId)} 은(는) 팔 수 없습니다`, 'warning');
      return;
    }
    this.sellLines.push({ uid: item.uid, qty: item.qty });
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.refresh();
  }

  private unstageSell(uid: string): void {
    const i = this.sellLines.findIndex((s) => s.uid === uid);
    if (i < 0) return;
    this.sellLines.splice(i, 1);
    this.ctx.bus.emit('audio:play', { id: 'ui_close' });
    this.refresh();
  }

  /**
   * Stage every 귀중품 the player holds into the 판매 tray (the old 귀중품 전부 판매, now one click short of it).
   * 2026-09-12 (E2): **favorites are left out of the bulk staging** — only hand staging takes them (and `거래 성사`
   * then asks once more).
   */
  private stageValuables(): void {
    let added = 0;
    let skippedFav = 0;
    for (const inst of this.meta.getSellable()) {
      const d = this.itemDef(inst.defId);
      if (!d || d.category !== 'valuable') continue;
      if (this.sellLines.some((s) => s.uid === inst.uid)) continue;
      // Only the bulk staging skips 0 C (hand staging through `stageSell` has allowed it since E-9).
      if ((this.meta.sellPriceOf(inst.uid) ?? 0) <= 0) continue;
      if (this.isFavorite(inst.defId)) { skippedFav++; continue; }
      this.sellLines.push({ uid: inst.uid, qty: inst.qty });
      added++;
    }
    this.ctx.bus.emit('audio:play', { id: added > 0 ? 'ui_click' : 'ui_deny' });
    const favNote = skippedFav > 0 ? ` · 즐겨찾기 ${skippedFav}점 제외` : '';
    this.showMsg(added > 0 ? `귀중품 ${added}종을 판매칸에 담았습니다${favNote}` : `담을 귀중품이 없습니다${favNote}`, added > 0 ? 'info' : 'warning');
    this.refresh();
  }

  /* ── favorites (2026-09-12, E2) ────────────────────────────────────────────────────────────────────────── */

  /** Is `defId` a favorite (`InventoryRef.isFavorite`, E1)? False while inventory cannot answer. */
  private isFavorite(defId: string): boolean {
    const api = this.ctx.inventory as unknown as ItemFavoriteApi | null;
    try { return api?.isFavorite?.(defId) === true; } catch { return false; }
  }

  /** Names of the favorites staged for sale (one per def, staging order). */
  private favoriteSales(): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const s of this.sellLines) {
      const inst = this.ctx.inventory?.findItemAnywhere?.(s.uid) ?? null;
      if (!inst || seen.has(inst.defId) || !this.isFavorite(inst.defId)) continue;
      seen.add(inst.defId);
      out.push(this.defName(inst.defId));
    }
    return out;
  }

  /**
   * The `거래 성사` hold finished. A basket that sells a **favorite** item asks once more (1 s hold, Escape cancels —
   * `HoldAsk`); anything else settles right away. Cancelling keeps the basket as it was.
   */
  private requestTrade(): void {
    const favs = this.favoriteSales();
    if (favs.length === 0) { this.confirmTrade(); return; }
    this.ask.open({
      title: '즐겨찾기 아이템 판매',
      body: `판매칸에 즐겨찾기로 표시한 아이템이 있습니다.\n${favs.join(' · ')}`,
      ok: '그래도 판매',
      run: () => { if (!this.disposed) this.confirmTrade(); },
    });
  }

  /** The favorite-sale confirmation is up (debug / smoke). */
  get isFavoriteAskOpen(): boolean { return this.ask.isOpen; }

  /** Drop staged lines that no longer exist (item sold elsewhere, shop line gone, corp switched). */
  private pruneBasket(): void {
    const inv = this.ctx.inventory;
    if (inv && typeof inv.findItemAnywhere === 'function') {
      this.sellLines = this.sellLines.filter((s) => !!inv.findItemAnywhere(s.uid));
    }
    const ids = new Set(this.meta.getShop(this.corp).map((l) => l.def.id));
    this.buyLines = this.buyLines.filter((b) => ids.has(b.defId));
  }

  private clearBasket(): void {
    this.buyLines = [];
    this.sellLines = [];
  }

  /** Settle the whole basket: sales first (they free credits and space), then the purchases, in staging order. */
  private confirmTrade(): void {
    const cost = this.buyCost(), revenue = this.sellRevenue();
    const blocked = this.tradeBlock(cost, revenue);
    if (blocked) { this.ctx.bus.emit('audio:play', { id: 'ui_deny' }); this.showMsg(blocked, 'warning'); return; }
    const sells = [...this.sellLines], buys = [...this.buyLines];
    let sold = 0, earned = 0, bought = 0, spent = 0;
    const failures: string[] = [];
    this.settling = true;
    try {
      for (const s of sells) {
        const price = this.meta.sellPriceOf(s.uid, s.qty) ?? 0;
        if (this.meta.sell(s.uid, s.qty)) { sold++; earned += price; }
        else failures.push('판매 실패');
      }
      for (const b of buys) {
        const price = this.meta.getShop(this.corp).find((l) => l.def.id === b.defId)?.price ?? 0;
        for (let i = 0; i < b.qty; i++) {
          if (this.meta.buy(this.corp, b.defId)) { bought++; spent += price; }
          else { failures.push(`${this.defName(b.defId)} · ${this.meta.lastPurchaseFailure?.reason ?? '구매 실패'}`); break; }
        }
      }
    } finally {
      this.settling = false;
    }
    this.quietPurchases = bought;      // server-owned credits announce each purchase later; the summary below wins
    this.clearBasket();
    const net = earned - spent;
    const ok = failures.length === 0 && (sold > 0 || bought > 0);
    this.ctx.bus.emit('audio:play', { id: ok ? 'ui_equip' : 'ui_deny' });
    const parts: string[] = [];
    if (bought > 0) parts.push(`구매 ${bought}점`);
    if (sold > 0) parts.push(`판매 ${sold}점`);
    parts.push(`${net >= 0 ? '+' : '−'}${formatCredits(Math.abs(net))}`);
    this.showMsg(failures.length ? `${parts.join(' · ')} · 실패: ${failures[0]}` : `거래 성사 · ${parts.join(' · ')}`,
      failures.length ? 'warning' : 'success');
    this.refresh();
  }

  /* ══ 계약 ═════════════════════════════════════════════════════════════════ */

  private buildContracts(): HTMLElement {
    if (this.contractsEl) return this.contractsEl;
    // one card, as before — only the corp list moved out into its own card (2026-09-13)
    const root = el('div', { cls: 'cc' });
    const list = el('div', { cls: 'ctr-col list', parent: root });
    el('div', { cls: 'cv-title', text: '계약 목록', parent: list });
    this.contractListEl = el('div', { cls: 'ctr-list', parent: list });
    this.contractActiveCol = el('div', { cls: 'ctr-col active', parent: root });
    el('div', { cls: 'cv-title', text: '진행 중인 계약', parent: this.contractActiveCol });
    this.contractActiveEl = el('div', { cls: 'ctr-active', parent: this.contractActiveCol });
    this.contractsEl = root;
    this.nodes.push(root);
    return root;
  }

  private renderContracts(): void {
    this.contractListEl.replaceChildren();
    const list = this.meta.getContracts(this.corp);
    if (list.length === 0) this.empty(this.contractListEl, '이 기업의 계약이 없습니다');
    else for (const c of list) this.contractRow(this.contractListEl, c);

    this.contractActiveEl.replaceChildren();
    // the accepted contract may belong to any corp — find it across all of them
    let active: ContractInfo | null = null;
    for (const id of CORP_IDS) {
      const found = this.meta.getContracts(id).find((c) => c.active);
      if (found) { active = found; break; }
    }
    // 2026-09-12: the 진행 중인 계약 panel takes the colour of **the corp that contract was signed with** — not that
    // of the corp tab currently selected
    const activeColor = active ? CORP_DEFS[active.def.corp]?.color : undefined;
    if (activeColor) this.contractActiveCol.style.setProperty('--cc', activeColor);
    else this.contractActiveCol.style.removeProperty('--cc');
    toggleClass(this.contractActiveCol, 'has-contract', !!active);
    if (!active) this.empty(this.contractActiveEl, '수락한 계약이 없습니다');
    else this.contractRow(this.contractActiveEl, active, true);
  }

  private contractRow(parent: HTMLElement, c: ContractInfo, detail = false): void {
    const d = c.def;
    const r = el('div', { cls: `corp-row contract${detail ? ' is-detail' : ''}`, parent, attrs: { 'data-id': d.id, 'data-corp': d.corp } });
    // every row wears its own corp's colour (2026-09-12) — the 진행 중인 계약 may belong to another corp
    const color = CORP_DEFS[d.corp]?.color;
    if (color) r.style.setProperty('--cc', color);
    toggleClass(r, 'active', c.active);
    toggleClass(r, 'blocked', !c.active && c.blocked !== null);
    const mid = el('div', { cls: 'mid', parent: r });
    const nl = el('div', { cls: 'name-line', parent: mid });
    el('div', { cls: 'name', text: d.name, parent: nl });
    if (c.active) el('div', { cls: 'tag', text: '진행 중', parent: nl });
    if (detail) el('div', { cls: 'tag corp', text: CORP_DEFS[d.corp]?.name ?? d.corp, parent: nl });
    el('div', { cls: 'tag dim', text: `신뢰도 Lv.${d.minRepLevel}`, parent: nl });
    el('div', { cls: 'sub', text: d.desc, parent: mid });
    /*
     * 2026-09-12 (E2): recovering a specific item — one line with that item's chip (have / need) and its name. Have
     * is **how many are carried on the body right now** (bag grid · quick slots · pouch, the 창고 excluded — the same
     * thing settlement counts), and since the corp screen only opens in the ship the bar and the number use that
     * value too. The chip is a `buildItemChip`, so the shared hover card and the favorite right-click menu attach
     * by themselves.
     * 2026-09-12 (§5-2): `carriedCount` counts **only what was found in the raid in progress** — in the ship it is
     * always 0 (what was carried in does not count).
     */
    const itemDefId = d.goal === 'extract_with_items' ? d.itemDefId : undefined;
    const shown = itemDefId ? this.meta.carriedCount(itemDefId) : c.progress;
    if (itemDefId) {
      const line = el('div', { cls: 'ctr-item', parent: mid });
      const idef = this.itemDef(itemDefId);
      line.appendChild(buildItemChip(idef, { size: 30, have: shown, need: d.target }));
      el('span', { cls: 'nm', text: idef?.name ?? itemDefId, parent: line });
    }
    const frac = Math.max(0, Math.min(1, d.target > 0 ? shown / d.target : 0));
    const bar = el('div', { cls: 'goal-bar', parent: mid });
    const fill = el('i', { parent: bar });
    fill.style.transform = `scaleX(${frac.toFixed(3)})`;
    toggleClass(bar, 'done', c.active && shown >= d.target);
    el('div', { cls: 'goal-text', text: `${CONTRACT_GOAL_LABEL_KO[d.goal]} ${fmtNum(Math.floor(shown))} / ${fmtNum(d.target)}`, parent: mid });
    // Rewards are currency chips (2026-09-09). The 신뢰도 is **that contract's corp**'s.
    const reward = el('div', { cls: 'reward', parent: r });
    appendCurrencyRewards(reward, [
      { id: repCurrencyId(d.corp), amount: d.repReward },
      { id: 'xp', amount: d.xpReward },
      { id: 'credits', amount: d.creditsReward },
    ], { size: 32 });
    if (c.active) {
      this.button(r, '포기', () => {
        const ok = this.meta.abandonContract();
        this.ctx.bus.emit('audio:play', { id: ok ? 'ui_close' : 'ui_deny' });
        this.showMsg(ok ? `${d.name} 계약 포기 · 진척 초기화` : '포기할 계약이 없습니다', ok ? 'warning' : 'danger');
        this.refresh();
      }, 'danger');
    } else {
      const btn = this.button(r, '수락', () => {
        const ok = this.meta.acceptContract(d.id);
        this.ctx.bus.emit('audio:play', { id: ok ? 'ui_equip' : 'ui_deny' });
        this.showMsg(ok ? `${d.name} 계약 수락` : `수락 불가 · ${c.blocked ?? ''}`, ok ? 'success' : 'danger');
        this.refresh();
      });
      btn.disabled = c.blocked !== null;
      btn.title = c.blocked ?? '';
    }
  }

  /* ══ the 임플란트 수리 desk (Phase 12, 세레스 바이오) ═════════════════════════════════════════════════════════ */

  private buildImplants(): HTMLElement {
    if (this.implantsEl) return this.implantsEl;
    /*
     * 2026-09-12 (2nd pass, user's decision): one card stacks **the broken implant list + the repair card**, and to
     * its right stands **the very same 함선 창고 · 가방** card as 거래 has (2026-09-13 — the two are separate cards).
     * Collecting the repair candidates is `parts/ImplantDesk.getRepairableImplants()` unchanged — that function
     * already looks at both the 가방 and the 창고.
     */
    const root = el('div', { cls: 'ci' });
    toggleClass(root, 'is-inv-hidden', this.invHidden);
    const desk = el('div', { cls: 'ci-col desk cv-card is-fluid', parent: root });
    el('div', { cls: 'cv-title', text: '망가진 임플란트 (가방 + 함선 창고)', parent: desk });
    this.implantGrid = new TileGrid(desk, { cell: this.cell, gap: CV_GAP, minCols: TRAY_COLS, className: 'ci-list' });
    el('div', { cls: 'cv-title', text: '수리', parent: desk });
    this.implantDetailEl = el('div', { cls: 'ci-repair', parent: desk });
    this.implantInv = this.makeInvCards(root, 'ci-col');      // read-only: this page has no 판매칸 to drop onto
    this.implantsEl = root;
    this.nodes.push(root);
    return root;
  }

  private renderImplants(): void {
    const list = this.meta.getRepairableImplants();
    if (!list.some((r) => r.inst.uid === this.selectedImplant)) {
      this.selectedImplant = (list.find((r) => r.blocked === null) ?? list[0])?.inst.uid ?? null;
    }
    this.implantGrid.render(list.map((r) => this.implantTile(r)),
      list.length === 0 ? '망가진 임플란트가 없습니다 — 레이드에서 회수해 오세요' : null);

    this.implantDetailEl.replaceChildren();
    const sel = list.find((r) => r.inst.uid === this.selectedImplant) ?? null;
    if (!sel) this.empty(this.implantDetailEl, list.length === 0 ? '수리할 임플란트를 가져오세요' : '임플란트를 선택하세요');
    else this.implantDetail(sel);
    this.refreshInv(this.implantInv);
  }

  /** One broken implant as a tile of the desk's grid (click selects it). */
  private implantTile(r: ImplantRepairInfo): TileSpec {
    const spec = this.makeTile(r.broken.id, 1, 'broken');
    const tile = spec.tile;
    tile.dataset.uid = r.inst.uid;
    tile.dataset.def = r.broken.id;
    el('div', { cls: 'cv-price', text: formatCreditAmount(r.fee), parent: tile });
    toggleClass(tile, 'is-sel', r.inst.uid === this.selectedImplant);
    toggleClass(tile, 'blocked', r.blocked !== null);
    tile.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.selectedImplant === r.inst.uid) return;
      this.selectedImplant = r.inst.uid;
      this.ctx.bus.emit('audio:play', { id: 'ui_click' });
      this.refresh();
    });
    return spec;
  }

  /** The selected broken implant's repair: result chip · material chips · fee · `수리`. */
  private implantDetail(r: ImplantRepairInfo): void {
    const host = this.implantDetailEl;
    const head = el('div', { cls: 'ci-head', parent: host });
    const from = el('div', { cls: 'ci-item from', parent: head });
    from.appendChild(buildItemChip(r.broken, { size: 46, withName: true }));
    el('div', { cls: 'ci-arrow', text: '→', parent: head });
    const to = el('div', { cls: 'ci-item to', parent: head });
    if (r.target) to.appendChild(buildItemChip(r.target, { size: 46, withName: true }));
    else el('div', { cls: 'ci-unknown', text: '수리 결과를 알 수 없음', parent: to });
    if (r.target?.description) el('div', { cls: 'ci-desc', text: r.target.description, parent: host });

    el('div', { cls: 'ci-label', text: '필요 재료', parent: host });
    const cost = el('div', { cls: 'ci-cost', parent: host });
    renderItemCost(cost, r.cost.map((c) => ({ defId: c.defId, qty: c.qty })), (id) => this.itemDef(id), (id) => this.meta.countAll(id), { size: 34 });

    const fee = el('div', { cls: 'ci-fee', parent: host });
    el('span', { cls: 'k', text: '수리비', parent: fee });
    const feeV = el('span', { cls: 'v', text: formatCredits(r.fee), parent: fee });
    toggleClass(feeV, 'short', this.meta.credits < r.fee);

    const acts = el('div', { cls: 'ci-acts', parent: host });
    if (r.blocked) el('div', { cls: 'ci-block', text: r.blocked, parent: acts });
    const btn = this.button(acts, '수리', () => {
      const ok = this.meta.repairImplant(r.inst.uid);
      // offline the result already arrived through `onImplantRepaired`; the server path reports later
      if (!ok && !this.meta.isRepairPending(r.inst.uid)) this.refresh();
    }, 'primary ci-repair-btn');
    btn.disabled = r.blocked !== null;
    btn.title = r.blocked ?? '';
  }

  /* ── misc ─────────────────────────────────────────────────────────────── */
  showMsg(text: string, kind: 'info' | 'success' | 'warning' | 'danger' = 'info'): void {
    if (!this.visible) return;
    this.msg.textContent = text;
    this.msg.className = `form-msg ${kind}`;
    this.msg.hidden = false;
    this.msgTimer = performance.now() + 4000;
  }

  hideMsg(): void { this.msg.hidden = true; this.msgTimer = 0; }

  update(): void {
    if (this.msgTimer > 0 && !this.msg.hidden && performance.now() > this.msgTimer) { this.msg.hidden = true; this.msgTimer = 0; }
  }

  private button(parent: HTMLElement, label: string, onClick: () => void, extraCls = ''): HTMLButtonElement {
    const b = el('button', { cls: `ui-btn ${extraCls}`.trim(), text: label, parent });
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelHold();
    this.ask.dispose();
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    if (this.fitTimer) { clearTimeout(this.fitTimer); this.fitTimer = 0; }
    for (const u of this.unsubs) u();
    this.unsubs = [];
    for (const c of [...this.tradeInv, ...this.implantInv]) { c.view?.dispose(); c.view = null; }
    this.tradeInv = []; this.implantInv = [];
    if (this.tradeEl) { this.shopGrid.dispose(); this.buyGrid.dispose(); this.sellGrid.dispose(); }
    if (this.implantsEl) this.implantGrid.dispose();
    for (const n of this.nodes) n.remove();
    this.nodes.length = 0;
    this.host.classList.remove('corp-view', 'is-embedded');
    this.host.style.removeProperty('--cc');
    this.host.style.removeProperty('--cv-cell');
    this.host.style.removeProperty('--cv-step');
    delete this.host.dataset.cvCell;
  }
}
