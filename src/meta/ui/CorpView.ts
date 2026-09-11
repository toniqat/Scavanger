import type {
  ContractInfo, CorpId, CurrencyReward, EmbeddedView, GameContext, ItemDef, ItemInstance, QuestInfo, QuestState,
  ShopItem, TradeGridsViewOptions,
} from '@/shared';
import {
  CONTRACT_GOAL_LABEL_KO, CORP_DEFS, CORP_IDS, REP_TABLE, SHOP_UNLOCK_REP_LEVEL, UI_HOLD_CONFIRM_S,
  appendCurrencyRewards, buildItemChip, formatCreditAmount, formatCredits, renderItemCost, repCurrencyId,
} from '@/shared';
import type { ImplantRepairInfo, ImplantRepairResult, MetaSystem, PurchaseFailure } from '../MetaSystem';
import { chevrons, el, fmtNum, setText, toggleClass } from './dom';
import { TileGrid, type TileSpec } from './TileGrid';

/* ────────────────────────────────────────────────────────────────────────────
 * CorpView — the **body** of the 기업 네트워크 screen.
 *
 * **2026-09-07**: there is only one shell left — `MetaSystem.createCorpView(host)`, the inventory Tab screen's
 * 기업 tab. The ship computer's `E` calls `ctx.inventory.openScreen('corp')`, so there is exactly one 기업 네트워크
 * screen in the game and the window owns the blocker, the cursor and Escape.
 *
 * Screen shape (**2026-09-12**) — **기업 목록은 트리이고, 메인 패널과 분리된 카드다**:
 *
 *   좌 `.corp-rail`  기업 목록. `.corp-shell` **밖**의 독립 패널이고(호스트의 직접 자식) 자기 배경 · 테두리를 가지며
 *                    화면 **세로 중앙 · 메인 패널 왼쪽**에 고정된다 (2026-09-12 2차, `.menu.pause` 와 같은 결).
 *                    선택한 기업 버튼 **바로 아래**에 가지(`.corp-branch`)가 열린다 — 신뢰도 Lv · 경험치 게이지,
 *                    그 아래 거래 / 계약 / 퀘스트 / 임플란트 탭. 가지는 한 번에 하나. 제목 줄도 크레딧도 없다.
 *   우 `.corp-shell` → `.corp-page`  그 페이지의 열들: 목록 → 거래칸 / 납품 (가운데) → **가방 + 함선 창고**
 *                    (또는 진행 중인 계약). 세 페이지 모두 우측 가방 / 창고 블록의 폭은 `--cv-inv-w` 하나다.
 *
 * **거래칸의 모든 칸은 인벤토리 타일이다 (2026-09-12).** 기업 판매 물품 · 구매 / 판매 트레이 · 임플란트 데스크가
 * `InventoryRef.buildItemTile` 로 만든 `.inv-tile` 을 `TileGrid` 가 `.inv-cells` 위에 발자국대로 채운다 — 가방 /
 * 창고와 **같은 모양**이고 `data-item-tip` 으로 공용 호버 카드가 뜬다. 예전 `.ct-*` 클래스는 housing.css 의 배양조
 * `.ct-cell`(54×76, 아래가 둥근 관)과 이름이 겹쳐 판매 물품이 관 모양이 됐고, 칩의 `pointer-events: none` 때문에
 * 호버 카드도 뜨지 않았다 — 이 폴더의 접두사는 이제 `.cv-` 다.
 *
 * **거래 성사는 1초 홀드다 (2026-09-12)** (`UI_HOLD_CONFIRM_S`, 제작 · 분해와 같은 게이지). 클릭 · Enter 로는
 * 확정되지 않는다. 구매 트레이 우측 상단의 오른쪽 셰브런 셋은 "이 물건이 내 쪽으로 온다", 판매 트레이 좌측 상단의
 * 왼쪽 셰브런 셋은 "기업 쪽으로 간다" 이고, 가운데 한 줄이 거래 후 크레딧 변화(+ 초록 ▲ 오른쪽 / − 빨강 ▼ 왼쪽)다.
 *
 * Pages:
 *   • **거래**: stock on the left, the two trays in the middle, the player's **real 가방 + 함선 창고 grids** on the right
 *     (`InventoryRef.createTradeGrids`). Items are staged into a tray (click, or drag a stock tile / an inventory tile
 *     onto it) and the basket settles at once;
 *   • **계약**: the corp's contract list and **진행 중인 계약** in the right-hand column, drawn in **that contract's
 *     corp colour** (2026-09-12) — not the selected corp's;
 *   • **퀘스트**: the quest list (이름 + 상태 배지, **완료는 딤드 + 맨 아래**, 우측 상단 `완료된 항목 보기` 체크박스로
 *     숨길 수 있다 — 기본 켜짐, 화면이 열려 있는 동안만 기억한다), the 납품 table with the selected quest's **보상이
 *     그 아래 붙어** 있고 (2026-09-12 2차 — 예전에는 목록 열 아래였다), the inventory grids;
 *   • **임플란트** (세레스 바이오 only): 좌에 망가진 임플란트 타일 + 수리 카드가 한 열로 쌓이고, 우는 거래 · 퀘스트와
 *     같은 **가방 + 함선 창고** 격자다 (2026-09-12 2차, 사용자 결정).
 *
 * **탭 잠금 (2026-09-08)**: a page the current 신뢰도 cannot use looks locked (`.is-locked`) but stays clickable so
 * the click can say why, and the view opens on **퀘스트** instead (`resolvePage`).
 *
 * Page bodies are built **once** and swapped, not rebuilt per refresh — the embedded grids own bus subscriptions and
 * a pointer drag, so recreating them on every `inventory:changed` would drop a drag mid-flight.
 * ──────────────────────────────────────────────────────────────────────────── */

export type CorpPage = 'trade' | 'contracts' | 'quests' | 'implants';

const PAGES: readonly { id: CorpPage; label: string; corp?: CorpId }[] = [
  { id: 'trade', label: '거래' }, { id: 'contracts', label: '계약' }, { id: 'quests', label: '퀘스트' },
  { id: 'implants', label: '임플란트', corp: 'ceres' },   // Phase 12: the 임플란트 수리 desk, 세레스 바이오 only
];

/** Pages the corp actually has (the 임플란트 desk exists at 세레스 바이오 alone). */
const pagesFor = (corp: CorpId): CorpPage[] => PAGES.filter((p) => !p.corp || p.corp === corp).map((p) => p.id);

const QUEST_BADGE: Readonly<Record<QuestState, string>> = { locked: '잠김', available: '가능', accepted: '진행', complete: '완료' };

/**
 * Cell edge / gap of every item grid on this screen, in px — the Tab 인벤토리's own (`inventory/ui/labels.CELL / GAP`)
 * so the desk's tiles and the 가방 / 창고 beside them are the same size. Mirrors `--cv-cell` / `--cv-gap` in `meta.css`.
 */
const CV_CELL = 54;
const CV_GAP = 2;
/** Columns of a 구매 / 판매 tray — an item is at most five cells wide. */
const TRAY_COLS = 5;
/** Below this fraction of the hold a release reads as a click — say how the button works instead of failing silently. */
const HOLD_TAP_HINT = 0.35;

/** One staged purchase (a shop line, `qty` copies) / one staged sale (a whole stack by uid). */
interface BuyLine { defId: string; qty: number }
interface SellLine { uid: string; qty: number }

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
  /** 귀중품 전부 담기 — under the 판매 tray, so it is built with the 거래 page. */
  private btnStageValuables: HTMLButtonElement | null = null;
  private unsubs: Array<() => void> = [];
  private corp: CorpId = 'helix';
  private current: CorpPage = 'trade';
  private msgTimer = 0;
  private disposed = false;

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
  private tradeGrids: EmbeddedView | null = null;
  /** 거래 성사 hold in progress (`UI_HOLD_CONFIRM_S`). */
  private hold: { t0: number; raf: number; timer: number } | null = null;

  private contractsEl: HTMLElement | null = null;
  private contractListEl!: HTMLElement;
  private contractActiveCol!: HTMLElement;
  private contractActiveEl!: HTMLElement;

  private questsEl: HTMLElement | null = null;
  private questListEl!: HTMLElement;
  /** 선택한 퀘스트의 보상 — **납품 패널 하단**의 한 줄 (재화 칩 + 아이템 칩), 2026-09-12 2차. */
  private questRewardEl!: HTMLElement;
  private questDetailEl!: HTMLElement;
  private questGrids: EmbeddedView | null = null;
  private selectedQuest: string | null = null;
  /** 퀘스트 목록에 완료 항목을 그릴까 (기본 켜짐). 화면이 열려 있는 동안만 산다 — 영속화하지 않는다. */
  private showDoneQuests = true;

  /* Phase 12: 임플란트 수리 desk */
  private implantsEl: HTMLElement | null = null;
  private implantGrid!: TileGrid;
  private implantDetailEl!: HTMLElement;
  private implantGrids: EmbeddedView | null = null;
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
    const add = <K extends keyof HTMLElementTagNameMap>(e: HTMLElementTagNameMap[K]): HTMLElementTagNameMap[K] => {
      this.nodes.push(e as unknown as HTMLElement);
      return e;
    };

    /*
     * 2026-09-12 (2차): 기업 목록은 **메인 패널과 분리된 독립 카드**다 — 호스트의 직접 자식이고 `.corp-shell` 밖이다.
     * 자리는 CSS 가 못 박는다: 화면 세로 중앙 · 메인 패널 왼쪽 (`.menu.pause` 와 같은 결 — 매번 다른 자리보다 늘 같은 자리).
     * 좌 열은 그대로 **트리**다 — 기업 버튼들 사이에, 선택한 기업 바로 아래로 가지 하나가 옮겨 다닌다.
     * `기업` 제목 줄은 없다 (2026-09-12, 사용자 결정 — 기업 이름 넷이 곧 그 설명이다).
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
    /* 신뢰도 게이지 — `신뢰도` 라벨은 붙이지 않는다: 기업 바로 아래의 눈금이 무엇을 재는지는 설명할 것이 없다. */
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

    const b = ctx.bus;
    const refresh = (): void => this.refreshIfVisible();
    this.unsubs.push(
      b.on('meta:creditsChanged', refresh), b.on('meta:repChanged', refresh), b.on('meta:contractAccepted', refresh),
      b.on('meta:contractAbandoned', refresh), b.on('meta:contractSettled', refresh), b.on('meta:questChanged', refresh),
      b.on('meta:purchase', ({ defId, price }) => {
        if (this.quietPurchases > 0) this.quietPurchases--;
        else if (this.visible && !this.settling) this.showMsg(`${this.defName(defId)} 구매 · −${formatCredits(price)}`, 'success');
        refresh();
      }),
      b.on('meta:sale', refresh), b.on('meta:loaded', refresh),
      b.on('inventory:changed', refresh), b.on('inventory:stashChanged', refresh), b.on('loadout:changed', refresh),
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
  private get visible(): boolean {
    return !this.disposed && this.host.isConnected;
  }

  setCorp(corp: CorpId): void {
    if (this.corp === corp || !CORP_DEFS[corp]) return;
    this.corp = corp;
    this.clearBasket();              // a basket belongs to the corp it was assembled at
    this.selectedQuest = null;
    this.selectedImplant = null;
    // the 임플란트 desk is 세레스 only, and the new corp's 신뢰도 may lock 거래 / 계약 (2026-09-08)
    this.current = this.resolvePage(this.current);
    this.hideMsg();
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.refresh();
  }

  /** Used by the overlay when it is (re-)opened on a specific corp, without the click SFX / repaint. */
  setCorpSilent(corp: CorpId): void {
    if (CORP_DEFS[corp]) this.corp = corp;
  }

  /**
   * Why `page` is locked at the current corp / 신뢰도 (Korean), or null when it is open. 거래 opens at
   * `SHOP_UNLOCK_REP_LEVEL`; 계약 opens as soon as **one** of the corp's contracts is within reach. 퀘스트 and the
   * 임플란트 수리 desk are never rep-gated — they are how a Lv.0 player earns the reputation in the first place.
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

  /** `want` when this corp has it and it is unlocked, else 퀘스트, else the first page that is open. */
  private resolvePage(want: CorpPage): CorpPage {
    const pages = pagesFor(this.corp);
    if (pages.includes(want) && !this.pageLock(want)) return want;
    if (pages.includes('quests') && !this.pageLock('quests')) return 'quests';
    return pages.find((p) => !this.pageLock(p)) ?? 'quests';
  }

  /**
   * 2026-09-08: a rep-locked sub-tab stays enabled and only *looks* locked (`.is-locked`) — clicking it says why, as a
   * **토스트** (`ui:notify`) and in the panel's own reserved message slot.
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
    for (const id of CORP_IDS) {
      const r = meta.getRep(id);
      const tab = this.corpTabs.get(id)!;
      setText(this.corpLv.get(id)!, `Lv.${r.level}`);
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
        : this.current === 'quests' ? this.buildQuests()
          : this.buildImplants();
    if (this.page.firstElementChild !== body) this.page.replaceChildren(body);
    if (this.current !== 'trade') this.cancelHold();
    if (this.current === 'trade') this.renderTrade();
    else if (this.current === 'contracts') this.renderContracts();
    else if (this.current === 'quests') this.renderQuests();
    else this.renderImplants();
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
      tile = inv.buildItemTile(defId, qty, durability === undefined ? { cell: CV_CELL } : { cell: CV_CELL, durability });
    } else {
      tile = document.createElement('div');
      tile.className = 'inv-tile';
      tile.appendChild(buildItemChip(def, { size: 34 }));
    }
    tile.classList.add('cv-tile', ...cls.split(' ').filter(Boolean));
    return { tile, w: def?.width ?? 1, h: def?.height ?? 1 };
  }

  /* ══ 거래 (상점 + 판매) ═══════════════════════════════════════════════════ */

  private buildTrade(): HTMLElement {
    if (this.tradeEl) return this.tradeEl;
    const root = el('div', { cls: 'cv' });
    const grid = { cell: CV_CELL, gap: CV_GAP };

    const shop = el('div', { cls: 'cv-col shop', parent: root });
    el('div', { cls: 'cv-title', text: '기업 판매 물품', parent: shop });
    this.shopGrid = new TileGrid(shop, { ...grid, minCols: TRAY_COLS, className: 'cv-shop' });

    // the two trays are **stacked** (구매 over 판매) so each is a real five-column item grid
    const deal = el('div', { cls: 'cv-col deal', parent: root });
    const trays = el('div', { cls: 'cv-trays', parent: deal });
    const mkTray = (kind: 'buy' | 'sell', label: string): { tray: HTMLElement; grid: TileGrid; total: HTMLElement } => {
      const tray = el('div', { cls: `cv-tray ${kind}`, parent: trays });
      const head = el('div', { cls: 'cv-tray-head', parent: tray });
      /* 셰브런 셋 = 물건이 흐르는 쪽. 구매는 우측 상단에서 오른쪽(내 가방 · 창고 쪽), 판매는 좌측 상단에서 왼쪽(기업 쪽). */
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

    /* 거래 후 크레딧 변화 — 라벨 없이 가운데 한 줄. + 는 오른쪽 초록 ▲, − 는 왼쪽 빨강 ▼. */
    this.netEl = el('div', { cls: 'cv-total', parent: deal });
    this.netEl.appendChild(chevrons('down', 1, 'net-down'));
    this.netValEl = el('span', { cls: 'v', text: '0', parent: this.netEl });
    this.netEl.appendChild(chevrons('up', 1, 'net-up'));

    this.confirmBtn = el('button', { cls: 'ui-btn primary cv-confirm', parent: deal }) as HTMLButtonElement;
    this.confirmFill = el('i', { cls: 'cv-confirm-fill', parent: this.confirmBtn });
    el('span', { cls: 'cv-confirm-label', text: '거래 성사', parent: this.confirmBtn });
    this.bindHold(this.confirmBtn);

    const inv = el('div', { cls: 'cv-col inv', parent: root });
    this.tradeGrids = this.makeGrids(inv, '.cv-tray.sell');

    this.tradeEl = root;
    this.nodes.push(root);
    return root;
  }

  /**
   * 거래 성사 = **1초 홀드** (2026-09-12, `UI_HOLD_CONFIRM_S`). Click and keyboard activation do nothing; a short press
   * that lets go early says how the button works. The gauge is `.cv-confirm-fill` (scaleX 0 → 1).
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
        this.confirmTrade();
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
   * Embedded 가방 + 함선 창고 grids — the **same block in the same place** on 거래 · 퀘스트 · 임플란트 (the column is
   * `--cv-inv-w` wide everywhere). With a `dropSelector` a tile dropped on it (or double-clicked) is staged for sale;
   * **without one the grids are read-only** — the 임플란트 desk has nothing to drop onto, and handing it `onTake`
   * would make a double-click stage a sale on a page that has no 거래칸 (2026-09-12 2차).
   */
  private makeGrids(host: HTMLElement, dropSelector?: string): EmbeddedView | null {
    const inv = this.ctx.inventory;
    if (!inv || typeof inv.createTradeGrids !== 'function') {
      this.empty(host, '인벤토리를 사용할 수 없습니다');
      return null;
    }
    const opts: TradeGridsViewOptions = { cell: CV_CELL };
    if (dropSelector) {
      opts.dropSelector = dropSelector;
      opts.isStaged = (uid) => this.sellLines.some((s) => s.uid === uid);
      opts.onTake = (item) => this.stageSell(item);
    }
    return inv.createTradeGrids(host, opts);
  }

  private renderTrade(): void {
    /* 좌: 기업 판매 물품 — the grid keeps its shape even when it is locked / empty, with the reason centred over it */
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

    /* 중앙: 거래칸 */
    const cost = this.buyCost(), revenue = this.sellRevenue();
    const buySpecs: TileSpec[] = [];
    for (const line of this.buyLines) {
      const spec = this.makeTile(line.defId, 1, 'buy');
      spec.tile.dataset.def = line.defId;
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
      el('div', { cls: 'cv-price', text: formatCreditAmount(this.meta.sellPriceOf(line.uid, line.qty) ?? 0), parent: spec.tile });
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

    this.tradeGrids?.refresh();
  }

  /** 한국어 reason the basket cannot settle right now; null = go ahead. */
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
   */
  private shopTile(line: ShopItem): TileSpec {
    const d = line.def;
    const spec = this.makeTile(d.id, 1, 'shop');
    const tile = spec.tile;
    tile.dataset.def = d.id;
    el('div', { cls: 'cv-price', text: formatCreditAmount(line.price), parent: tile });
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
      const gw = (def.width ?? 1) * (CV_CELL + CV_GAP) - CV_GAP;
      const gh = (def.height ?? 1) * (CV_CELL + CV_GAP) - CV_GAP;
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
          ghost = this.makeTile(def.id, 1, 'cv-ghost').tile;
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
     * 2026-09-11 (E-9, 사용자 결정): **0 C 도 담긴다.** 가치 1 아이템 한 개는 `floor(0.5) = 0` 이다 — 그것을 여기서
     * 막으면 무게를 비울 길이 없어지고, 묶어 팔면 제값이 나오므로 분할이 손해라는 것을 플레이어가 스스로 배운다.
     * 거절하는 것은 `null`(값이 없는 물건 · 장착 중 · 가방에도 창고에도 없음)뿐이다. 가격 칸은 그대로 `0` 을 찍는다.
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

  /** Stage every 귀중품 the player holds into the 판매 tray (the old 귀중품 전부 판매, now one click short of it). */
  private stageValuables(): void {
    let added = 0;
    for (const inst of this.meta.getSellable()) {
      const d = this.itemDef(inst.defId);
      if (!d || d.category !== 'valuable') continue;
      if (this.sellLines.some((s) => s.uid === inst.uid)) continue;
      // 일괄 담기만 0 C 를 건너뛴다 (손으로 담는 `stageSell` 은 E-9 이후 허용한다).
      if ((this.meta.sellPriceOf(inst.uid) ?? 0) <= 0) continue;
      this.sellLines.push({ uid: inst.uid, qty: inst.qty });
      added++;
    }
    this.ctx.bus.emit('audio:play', { id: added > 0 ? 'ui_click' : 'ui_deny' });
    this.showMsg(added > 0 ? `귀중품 ${added}종을 판매칸에 담았습니다` : '담을 귀중품이 없습니다', added > 0 ? 'info' : 'warning');
    this.refresh();
  }

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
    const root = el('div', { cls: 'cc' });
    const list = el('div', { cls: 'cc-col list', parent: root });
    el('div', { cls: 'cv-title', text: '계약 목록', parent: list });
    this.contractListEl = el('div', { cls: 'cc-list', parent: list });
    this.contractActiveCol = el('div', { cls: 'cc-col active', parent: root });
    el('div', { cls: 'cv-title', text: '진행 중인 계약', parent: this.contractActiveCol });
    this.contractActiveEl = el('div', { cls: 'cc-active', parent: this.contractActiveCol });
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
    // 2026-09-12: 진행 중인 계약 패널은 **그 계약을 맺은 기업**의 색이다 — 지금 고른 기업 탭의 색이 아니다
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
    const frac = Math.max(0, Math.min(1, d.target > 0 ? c.progress / d.target : 0));
    const bar = el('div', { cls: 'goal-bar', parent: mid });
    const fill = el('i', { parent: bar });
    fill.style.transform = `scaleX(${frac.toFixed(3)})`;
    toggleClass(bar, 'done', c.active && c.progress >= d.target);
    el('div', { cls: 'goal-text', text: `${CONTRACT_GOAL_LABEL_KO[d.goal]} ${fmtNum(Math.floor(c.progress))} / ${fmtNum(d.target)}`, parent: mid });
    // 보상은 재화 칩이다 (2026-09-09). 신뢰도는 **그 계약의 기업** 것이다.
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

  /* ══ 퀘스트 ═══════════════════════════════════════════════════════════════ */

  private buildQuests(): HTMLElement {
    if (this.questsEl) return this.questsEl;
    const root = el('div', { cls: 'cq' });
    const list = el('div', { cls: 'cq-col list', parent: root });
    /* 목록 머리: 제목 왼쪽, **완료된 항목 보기** 체크박스 오른쪽 (2026-09-12 2차, 기본 켜짐). */
    const head = el('div', { cls: 'cq-head', parent: list });
    el('div', { cls: 'cv-title', text: '퀘스트 목록', parent: head });
    const toggle = el('label', { cls: 'cv-check', parent: head });
    const box = el('input', { parent: toggle });
    box.type = 'checkbox';
    box.checked = this.showDoneQuests;
    el('span', { text: '완료된 항목 보기', parent: toggle });
    box.addEventListener('change', (e) => {
      e.stopPropagation();
      this.showDoneQuests = box.checked;
      this.ctx.bus.emit('audio:play', { id: 'ui_click' });
      this.refresh();
    });
    this.questListEl = el('div', { cls: 'cq-list', parent: list });
    const detail = el('div', { cls: 'cq-col detail', parent: root });
    el('div', { cls: 'cv-title', text: '납품', parent: detail });
    this.questDetailEl = el('div', { cls: 'cq-deliver', parent: detail });
    /* 선택한 퀘스트의 보상은 **그 퀘스트의 납품 내용 바로 아래**에 붙는다 (2026-09-12 2차 — 예전에는 목록 열 아래였다). */
    const rewards = el('div', { cls: 'cq-rewards', parent: detail });
    el('div', { cls: 'cv-title', text: '보상', parent: rewards });
    this.questRewardEl = el('div', { cls: 'cq-reward-line item-chips', parent: rewards });
    const inv = el('div', { cls: 'cq-col inv', parent: root });
    this.questGrids = this.makeGrids(inv, '.cq-deliver');
    this.questsEl = root;
    this.nodes.push(root);
    return root;
  }

  private renderQuests(): void {
    const all = this.meta.getQuests(this.corp);
    /*
     * 2026-09-12 (2차): **완료는 맨 아래**, 그 밖의 순서는 csv 그대로(안정 분할). 정렬을 여기서만 하는 이유는
     * `parts/Contracts.getQuests()` 의 반환 순서를 콘솔 · 스모크 등 다른 소비자도 보기 때문이다.
     * 체크박스를 끄면 완료 항목이 목록에서 빠지고, **기본 선택도 보이는 행 중에서만** 고른다.
     */
    const ordered = [...all.filter((q) => q.state !== 'complete'), ...all.filter((q) => q.state === 'complete')];
    const list = this.showDoneQuests ? ordered : ordered.filter((q) => q.state !== 'complete');
    this.questListEl.replaceChildren();
    if (list.length === 0) this.empty(this.questListEl, all.length === 0 ? '이 기업의 퀘스트가 없습니다' : '표시할 퀘스트가 없습니다');
    // default selection: the accepted quest, else the first available, else the first visible row
    if (!list.some((q) => q.def.id === this.selectedQuest)) {
      this.selectedQuest = (list.find((q) => q.state === 'accepted') ?? list.find((q) => q.state === 'available') ?? list[0])?.def.id ?? null;
    }
    for (const q of list) this.questRow(q);

    this.questDetailEl.replaceChildren();
    const sel = list.find((q) => q.def.id === this.selectedQuest) ?? null;
    if (!sel) this.empty(this.questDetailEl, '퀘스트를 선택하세요');
    else this.questDetail(sel);
    this.renderQuestRewards(sel);
    this.questGrids?.refresh();
  }

  /** One quest row: **이름 + 상태 배지뿐이다** (2026-09-09). 설명은 상세 패널에 있다. */
  private questRow(q: QuestInfo): void {
    const d = q.def;
    const r = el('div', { cls: `corp-row quest st-${q.state}`, parent: this.questListEl, attrs: { 'data-id': d.id } });
    toggleClass(r, 'is-sel', d.id === this.selectedQuest);
    el('div', { cls: 'badge', text: QUEST_BADGE[q.state], parent: r });
    const mid = el('div', { cls: 'mid', parent: r });
    el('div', { cls: 'name', text: d.name, parent: mid });
    r.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.selectedQuest === d.id) return;
      this.selectedQuest = d.id;
      this.ctx.bus.emit('audio:play', { id: 'ui_click' });
      this.refresh();
    });
  }

  /**
   * 선택한 퀘스트의 보상 한 줄 — **납품 패널 하단**에 붙는다 (2026-09-12 2차). 재화(신뢰도 · XP · 크레딧)는
   * `appendCurrencyRewards` 의 칩, 아이템은 `buildItemChip` 이고 **한 줄에 이어 붙는다**.
   */
  private renderQuestRewards(q: QuestInfo | null): void {
    const host = this.questRewardEl;
    host.replaceChildren();
    if (!q) { el('div', { cls: 'cq-reward-none', text: '퀘스트를 선택하세요', parent: host }); return; }
    const rw = q.def.rewards;
    const currency: CurrencyReward[] = [
      { id: repCurrencyId(q.def.corp), amount: rw.rep },
      { id: 'xp', amount: rw.xp },
      { id: 'credits', amount: rw.credits ?? 0 },
    ];
    appendCurrencyRewards(host, currency, { size: 32 });
    for (const it of rw.items ?? []) host.appendChild(buildItemChip(this.itemDef(it.defId), { size: 32, need: it.qty }));
    if (host.childElementCount === 0) el('div', { cls: 'cq-reward-none', text: '보상 없음', parent: host });
  }

  /** The selected quest's delivery table + its 수락 / 납품 button (the drop target of the inventory grids). */
  private questDetail(q: QuestInfo): void {
    const d = q.def;
    const host = this.questDetailEl;
    el('div', { cls: 'cq-name', text: d.name, parent: host });
    el('div', { cls: 'cq-desc', text: d.desc, parent: host });

    const table = el('div', { cls: 'cq-table', parent: host });
    for (const line of q.deliver) {
      const def = this.itemDef(line.defId);
      const row = el('div', { cls: 'cq-line', parent: table });
      toggleClass(row, 'short', line.have < line.qty);
      const cell = el('div', { cls: 'thumb', parent: row });
      cell.appendChild(buildItemChip(def, { size: 34, have: line.have, need: line.qty }));
      el('div', { cls: 'nm', text: def?.name ?? line.defId, parent: row });
      el('div', { cls: 'qty', text: `${fmtNum(line.have)} / ${fmtNum(line.qty)}`, parent: row });
    }
    if (q.deliver.length === 0) el('div', { cls: 'cq-none', text: '납품할 물품이 없습니다', parent: table });

    // 보상 칩은 여기가 아니라 이 패널 **바로 아래**의 고정 줄이다 (`renderQuestRewards`). 완료 토스트만 말로 적는다.
    const rw = d.rewards;
    const parts = [`신뢰도 +${rw.rep}`, `XP +${rw.xp}`];
    if (rw.credits) parts.push(`크레딧 +${formatCredits(rw.credits)}`);
    const items = rw.items ?? [];
    const summary = [...parts, ...items.map((it) => `${this.defName(it.defId)} ×${it.qty}`)];
    const acts = el('div', { cls: 'cq-acts', parent: host });
    if (q.state === 'available') {
      this.button(acts, '수락', () => {
        const ok = this.meta.acceptQuest(d.id);
        this.ctx.bus.emit('audio:play', { id: ok ? 'ui_equip' : 'ui_deny' });
        this.showMsg(ok ? `${d.name} 수락` : '수락할 수 없습니다', ok ? 'success' : 'danger');
        this.refresh();
      }, 'primary');
    } else if (q.state === 'accepted') {
      const btn = this.button(acts, '납품', () => {
        const ok = this.meta.completeQuest(d.id);
        this.ctx.bus.emit('audio:play', { id: ok ? 'ui_equip' : 'ui_deny' });
        const after = this.meta.getQuests(this.corp).find((x) => x.def.id === d.id);
        this.showMsg(ok ? `${d.name} 완료 · ${summary.join(' · ')}` : `납품 실패 · ${after?.blocked ?? ''}`, ok ? 'success' : 'danger');
        this.refresh();
      }, 'primary');
      btn.disabled = q.blocked !== null;
      btn.title = q.blocked ?? '';
    } else {
      const b = this.button(acts, q.state === 'complete' ? '완료' : '잠김', () => { /* nothing to do */ });
      b.disabled = true;
    }
  }

  /* ══ 임플란트 수리 (Phase 12, 세레스 바이오) ══════════════════════════════════════════════════════════════════ */

  private buildImplants(): HTMLElement {
    if (this.implantsEl) return this.implantsEl;
    /*
     * 2026-09-12 (2차, 사용자 결정): 왼쪽 한 열에 **망가진 임플란트 목록 + 수리 카드**가 쌓이고(퀘스트 탭의 목록 열과
     * 같은 자리), 오른쪽은 거래 · 퀘스트와 **똑같은 가방 + 함선 창고** 격자다. 예전에는 좌 목록 / 우 수리 카드 2열이라
     * 이 화면에만 가방 · 창고가 없었다. 수리 대상 수집은 `parts/ImplantDesk.getRepairableImplants()` 그대로 —
     * 그 함수가 이미 가방과 창고 양쪽을 본다.
     */
    const root = el('div', { cls: 'ci' });
    const desk = el('div', { cls: 'ci-col desk', parent: root });
    el('div', { cls: 'cv-title', text: '망가진 임플란트 (가방 + 함선 창고)', parent: desk });
    this.implantGrid = new TileGrid(desk, { cell: CV_CELL, gap: CV_GAP, minCols: TRAY_COLS, className: 'ci-list' });
    el('div', { cls: 'cv-title', text: '수리', parent: desk });
    this.implantDetailEl = el('div', { cls: 'ci-repair', parent: desk });
    const inv = el('div', { cls: 'ci-col inv', parent: root });
    this.implantGrids = this.makeGrids(inv);      // read-only: this page has no 거래칸 to drop onto
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
    this.implantGrids?.refresh();
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

  /** The selected broken implant's repair: result chip · material chips · fee · 수리. */
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
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.tradeGrids?.dispose(); this.tradeGrids = null;
    this.questGrids?.dispose(); this.questGrids = null;
    this.implantGrids?.dispose(); this.implantGrids = null;
    if (this.tradeEl) { this.shopGrid.dispose(); this.buyGrid.dispose(); this.sellGrid.dispose(); }
    if (this.implantsEl) this.implantGrid.dispose();
    for (const n of this.nodes) n.remove();
    this.nodes.length = 0;
    this.host.classList.remove('corp-view', 'is-embedded');
    this.host.style.removeProperty('--cc');
  }
}
