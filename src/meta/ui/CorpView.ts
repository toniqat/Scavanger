import type {
  ContractInfo, CorpId, EmbeddedView, GameContext, ItemDef, ItemInstance, QuestInfo, QuestState, ShopItem,
} from '@/shared';
import {
  CONTRACT_GOAL_LABEL_KO, CORP_DEFS, CORP_IDS, REP_TABLE, SHOP_UNLOCK_REP_LEVEL,
  buildItemChip, formatCredits, renderItemCost,
} from '@/shared';
import type { MetaSystem, PurchaseFailure } from '../MetaSystem';
import { el, fmtNum, setText, toggleClass } from './dom';

/* ────────────────────────────────────────────────────────────────────────────
 * CorpView — the **body** of the 기업 네트워크 screen.
 *
 * Two shells share these renderers:
 *   • `ui/CorpMenu.ts` — the standalone `.menu.corp-menu` overlay (ship computer `hub_computer`): blocker `'corp'`,
 *     pointer-lock etiquette, capture-phase Escape, 닫기 button.
 *   • `MetaSystem.createCorpView(host)` — the **embedded** variant for the inventory Tab screen's 기업 tab:
 *     no blocker, no pointer-lock call, no window Escape listener (the inventory window owns all three).
 *
 * Phase 9 UI pass — rebuilt around a Tarkov-style trading desk:
 *   • the `기업 네트워크` title is gone: the **corp list** occupies the top-left slot with the credits readout on the
 *     right of the same row, and a compact **기업 패널** (name + 신뢰도 only) sits under it;
 *   • 상점 and 판매 merged into one **거래** page: the corp's stock on the left, a two-tray **거래칸** in the middle
 *     (구매 / 판매) with the net credit delta and one big **거래 성사** button under it, and the player's **real
 *     가방 + 함선 창고 grids** down the right (`InventoryRef.createTradeGrids`), stretched over the full column
 *     height. All three areas are **item grids** of `buildItemChip` cells, so hovering any of them raises the shared
 *     `ui/hud/ItemTip` card. Nothing buys or sells on click: items are staged into a tray (click, or drag a stock
 *     cell / an inventory tile onto it) and the whole basket settles at once;
 *   • **계약** is the corp's contract list with the currently accepted one pinned on the right;
 *   • **퀘스트** is the quest list, the selected quest's delivery table in the middle and the same inventory grids
 *     on the right.
 *
 * Page bodies are built **once** and swapped, not rebuilt per refresh — the embedded grids own bus subscriptions and
 * a pointer drag, so recreating them on every `inventory:changed` would drop a drag mid-flight.
 * ──────────────────────────────────────────────────────────────────────────── */

export type CorpPage = 'trade' | 'contracts' | 'quests';

const PAGES: readonly { id: CorpPage; label: string }[] = [
  { id: 'trade', label: '거래' }, { id: 'contracts', label: '계약' }, { id: 'quests', label: '퀘스트' },
];

const QUEST_BADGE: Readonly<Record<QuestState, string>> = { locked: '잠김', available: '가능', accepted: '진행', complete: '완료' };

/** One staged purchase (a shop line, `qty` copies) / one staged sale (a whole stack by uid). */
interface BuyLine { defId: string; qty: number }
interface SellLine { uid: string; qty: number }

export interface CorpViewOptions {
  /** Embedded (inventory tab) instead of the standalone overlay: no 닫기 button, no subtitle line. */
  embedded?: boolean;
  /** Extra element that also receives the `--cc` accent (the overlay's `.frame`, for its corner brackets). */
  accentTarget?: HTMLElement | null;
  /** Footer 닫기 handler. Omitted → no 닫기 button (embedded). */
  onClose?: (() => void) | null;
  /** Bus-driven refreshes only run while this returns true. Default: the host is still in the document. */
  isVisible?: () => boolean;
}

export class CorpView {
  private readonly nodes: HTMLElement[] = [];
  private readonly creditsEl: HTMLElement;
  private readonly corpTabs = new Map<CorpId, HTMLButtonElement>();
  private readonly corpLv = new Map<CorpId, HTMLElement>();
  private readonly panel: { name: HTMLElement; lv: HTMLElement; bar: HTMLElement; text: HTMLElement };
  private readonly subTabs = new Map<CorpPage, HTMLButtonElement>();
  private readonly page: HTMLElement;
  private readonly msg: HTMLElement;
  private readonly btnStageValuables: HTMLButtonElement;
  private unsubs: Array<() => void> = [];
  private corp: CorpId = 'helix';
  private current: CorpPage = 'trade';
  private msgTimer = 0;
  private disposed = false;

  /* ── page bodies (built once) ── */
  private tradeEl: HTMLElement | null = null;
  private shopListEl!: HTMLElement;
  private buySlotsEl!: HTMLElement;
  private sellSlotsEl!: HTMLElement;
  private buyTotalEl!: HTMLElement;
  private sellTotalEl!: HTMLElement;
  private netEl!: HTMLElement;
  private confirmBtn!: HTMLButtonElement;
  private tradeGrids: EmbeddedView | null = null;

  private contractsEl: HTMLElement | null = null;
  private contractListEl!: HTMLElement;
  private contractActiveEl!: HTMLElement;

  private questsEl: HTMLElement | null = null;
  private questListEl!: HTMLElement;
  private questDetailEl!: HTMLElement;
  private questGrids: EmbeddedView | null = null;
  private selectedQuest: string | null = null;

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

    // Phase 9 UI pass (2026-09-07): the `기업 네트워크` title and its `거래 / 계약 / 퀘스트` subtitle are gone — the
    // **corp list** sits in that top-left slot instead, with the credits readout on the right of the same row.
    const head = add(el('div', { cls: 'hub-head corp-head', parent: host }));
    const tabs = el('div', { cls: 'corp-tabs', parent: head });
    const cr = el('div', { cls: 'corp-credits', parent: head });
    el('span', { cls: 'k', text: '크레딧', parent: cr });
    this.creditsEl = el('span', { cls: 'v', text: '0', parent: cr });

    /* 기업 패널: name + 신뢰도 of the selected corp, under the corp list */
    const top = add(el('div', { cls: 'corp-top', parent: host }));
    const panel = el('div', { cls: 'corp-panel', parent: top });
    const pl = el('div', { cls: 'pl', parent: panel });
    const name = el('div', { cls: 'name', parent: pl });
    const lv = el('div', { cls: 'lv', text: 'Lv.0', parent: pl });
    const pr = el('div', { cls: 'pr', parent: panel });
    el('span', { cls: 'k', text: '신뢰도', parent: pr });
    const bar = el('div', { cls: 'rep-bar', parent: pr });
    const fill = el('i', { parent: bar });
    const text = el('div', { cls: 'rep-text', parent: pr });
    this.panel = { name, lv, bar: fill, text };

    for (const id of CORP_IDS) {
      const def = CORP_DEFS[id];
      const b = el('button', { cls: 'corp-tab', parent: tabs, attrs: { 'data-corp': id } });
      b.style.setProperty('--cc', def.color);
      el('span', { cls: 'name', text: def.name, parent: b });
      this.corpLv.set(id, el('span', { cls: 'lv', text: 'Lv.0', parent: b }));
      b.addEventListener('click', (e) => { e.stopPropagation(); this.setCorp(id); });
      this.corpTabs.set(id, b);
    }

    const sub = add(el('div', { cls: 'corp-subtabs', parent: host }));
    for (const p of PAGES) {
      const b = el('button', { cls: 'scr-tab', text: p.label, parent: sub, attrs: { 'data-page': p.id } });
      b.addEventListener('click', (e) => { e.stopPropagation(); this.setPage(p.id); });
      this.subTabs.set(p.id, b);
    }

    this.page = add(el('div', { cls: 'corp-page', parent: host }));
    // the message keeps a reserved slot so showing / hiding it never moves the frame
    const msgSlot = add(el('div', { cls: 'corp-msg-slot', parent: host }));
    this.msg = el('div', { cls: 'form-msg', parent: msgSlot });
    this.msg.hidden = true;

    const foot = add(el('div', { cls: 'hub-foot', parent: host }));
    if (opts.onClose) this.button(foot, '닫기', () => opts.onClose?.());
    else el('span', { cls: 'foot-spacer', parent: foot });
    const right = el('div', { cls: 'right', parent: foot });
    this.btnStageValuables = this.button(right, '귀중품 전부 담기', () => this.stageValuables(), 'primary');

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
    );
  }

  get currentCorp(): CorpId { return this.corp; }
  get currentPage(): CorpPage { return this.current; }
  /** Staged basket (debug / smoke). */
  get staged(): { buy: readonly BuyLine[]; sell: readonly SellLine[] } { return { buy: this.buyLines, sell: this.sellLines }; }
  private get visible(): boolean {
    if (this.disposed) return false;
    return this.opts.isVisible ? this.opts.isVisible() : this.host.isConnected;
  }

  setCorp(corp: CorpId): void {
    if (this.corp === corp || !CORP_DEFS[corp]) return;
    this.corp = corp;
    this.clearBasket();              // a basket belongs to the corp it was assembled at
    this.selectedQuest = null;
    this.hideMsg();
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.refresh();
  }

  /** Used by the overlay when it is (re-)opened on a specific corp, without the click SFX / repaint. */
  setCorpSilent(corp: CorpId): void {
    if (CORP_DEFS[corp]) this.corp = corp;
  }

  setPage(page: CorpPage): void {
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
    setText(this.creditsEl, formatCredits(meta.credits));
    for (const id of CORP_IDS) {
      const r = meta.getRep(id);
      setText(this.corpLv.get(id)!, `Lv.${r.level}`);
      toggleClass(this.corpTabs.get(id)!, 'is-on', id === this.corp);
    }
    const def = CORP_DEFS[this.corp];
    const rep = meta.getRep(this.corp);
    this.host.style.setProperty('--cc', def.color);
    this.opts.accentTarget?.style.setProperty('--cc', def.color);
    setText(this.panel.name, def.name);
    setText(this.panel.lv, `Lv.${rep.level}`);
    const prev = REP_TABLE[rep.level] ?? 0;            // cumulative rep where the current level started
    const span = rep.next === null ? 1 : Math.max(1, rep.next - prev);
    const frac = rep.next === null ? 1 : Math.max(0, Math.min(1, (rep.rep - prev) / span));
    this.panel.bar.style.transform = `scaleX(${frac.toFixed(3)})`;
    setText(this.panel.text, rep.next === null ? `${fmtNum(rep.rep)} · 최고 등급` : `${fmtNum(rep.rep)} / ${fmtNum(rep.next)}`);

    for (const p of PAGES) toggleClass(this.subTabs.get(p.id)!, 'is-on', p.id === this.current);
    this.btnStageValuables.hidden = this.current !== 'trade';

    this.page.dataset.page = this.current;
    this.pruneBasket();
    const body = this.current === 'trade' ? this.buildTrade()
      : this.current === 'contracts' ? this.buildContracts()
        : this.buildQuests();
    if (this.page.firstElementChild !== body) this.page.replaceChildren(body);
    if (this.current === 'trade') this.renderTrade();
    else if (this.current === 'contracts') this.renderContracts();
    else this.renderQuests();
  }

  private itemDef(defId: string): ItemDef | undefined { return this.ctx.loot?.getItemDef(defId) ?? this.ctx.inventory?.getDef(defId); }
  private defName(defId: string): string { return this.itemDef(defId)?.name ?? defId; }
  private empty(parent: HTMLElement, text: string): void {
    el('div', { cls: 'corp-empty', text, parent });
  }

  /* ══ 거래 (상점 + 판매) ═══════════════════════════════════════════════════ */

  private buildTrade(): HTMLElement {
    if (this.tradeEl) return this.tradeEl;
    const root = el('div', { cls: 'ct' });

    const shop = el('div', { cls: 'ct-col shop', parent: root });
    el('div', { cls: 'ct-title', text: '기업 판매 물품', parent: shop });
    this.shopListEl = el('div', { cls: 'ct-shop-list ct-grid', parent: shop });

    const deal = el('div', { cls: 'ct-col deal', parent: root });
    const trays = el('div', { cls: 'ct-trays', parent: deal });
    const mkTray = (kind: 'buy' | 'sell', label: string): { slots: HTMLElement; total: HTMLElement } => {
      const tray = el('div', { cls: `ct-tray ${kind}`, parent: trays });
      const head = el('div', { cls: 'ct-tray-head', parent: tray });
      el('span', { cls: 'k', text: label, parent: head });
      const total = el('span', { cls: 'v', text: '0', parent: head });
      const slots = el('div', { cls: 'ct-slots ct-grid', parent: tray });
      return { slots, total };
    };
    const buy = mkTray('buy', '구매');
    const sell = mkTray('sell', '판매');
    this.buySlotsEl = buy.slots; this.buyTotalEl = buy.total;
    this.sellSlotsEl = sell.slots; this.sellTotalEl = sell.total;

    const totals = el('div', { cls: 'ct-total', parent: deal });
    el('span', { cls: 'k', text: '거래 후 크레딧', parent: totals });
    this.netEl = el('span', { cls: 'v', text: '0', parent: totals });
    this.confirmBtn = el('button', { cls: 'ui-btn primary ct-confirm', text: '거래 성사', parent: deal }) as HTMLButtonElement;
    this.confirmBtn.addEventListener('click', (e) => { e.stopPropagation(); this.confirmTrade(); });

    const inv = el('div', { cls: 'ct-col inv', parent: root });
    this.tradeGrids = this.makeGrids(inv, '.ct-tray.sell');

    this.tradeEl = root;
    this.nodes.push(root);
    return root;
  }

  /** Embedded 가방 + 함선 창고 grids; a tile dropped on `dropSelector` (or double-clicked) is staged for sale. */
  private makeGrids(host: HTMLElement, dropSelector: string): EmbeddedView | null {
    const inv = this.ctx.inventory;
    if (!inv || typeof inv.createTradeGrids !== 'function') {
      this.empty(host, '인벤토리를 사용할 수 없습니다');
      return null;
    }
    return inv.createTradeGrids(host, {
      dropSelector,
      isStaged: (uid) => this.sellLines.some((s) => s.uid === uid),
      onTake: (item) => this.stageSell(item),
    });
  }

  private renderTrade(): void {
    /* 좌: 기업 판매 물품 */
    this.shopListEl.replaceChildren();
    const rep = this.meta.getRep(this.corp);
    if (rep.level < SHOP_UNLOCK_REP_LEVEL) this.empty(this.shopListEl, `신뢰도 Lv.${SHOP_UNLOCK_REP_LEVEL} 부터 거래할 수 있습니다`);
    else {
      const lines = this.meta.getShop(this.corp);
      if (lines.length === 0) this.empty(this.shopListEl, '판매 중인 품목이 없습니다');
      else for (const line of lines) this.shopCell(line);
    }

    /* 중앙: 거래칸 */
    const cost = this.buyCost(), revenue = this.sellRevenue();
    this.buySlotsEl.replaceChildren();
    if (this.buyLines.length === 0) el('div', { cls: 'ct-slot-hint', text: '왼쪽 목록에서 담으세요', parent: this.buySlotsEl });
    for (const line of this.buyLines) {
      const chip = el('button', { cls: 'ct-chip ct-cell', parent: this.buySlotsEl });
      chip.appendChild(buildItemChip(this.itemDef(line.defId), { size: 48, need: line.qty }));
      el('div', { cls: 'ct-cell-name', text: this.defName(line.defId), parent: chip });
      chip.addEventListener('click', (e) => { e.stopPropagation(); this.unstageBuy(line.defId); });
    }
    this.sellSlotsEl.replaceChildren();
    if (this.sellLines.length === 0) el('div', { cls: 'ct-slot-hint', text: '오른쪽 가방 / 창고에서 끌어 놓으세요', parent: this.sellSlotsEl });
    for (const line of this.sellLines) {
      const inst = this.ctx.inventory?.findItemAnywhere?.(line.uid) ?? null;
      const def = inst ? this.itemDef(inst.defId) : undefined;
      const chip = el('button', { cls: 'ct-chip ct-cell', parent: this.sellSlotsEl });
      chip.appendChild(buildItemChip(def, { size: 48, need: line.qty }));
      el('div', { cls: 'ct-cell-name', text: def?.name ?? '—', parent: chip });
      el('div', { cls: 'ct-cell-price', text: formatCredits(this.meta.sellPriceOf(line.uid, line.qty) ?? 0), parent: chip });
      chip.addEventListener('click', (e) => { e.stopPropagation(); this.unstageSell(line.uid); });
    }
    setText(this.buyTotalEl, `−${formatCredits(cost)}`);
    setText(this.sellTotalEl, `+${formatCredits(revenue)}`);
    const net = revenue - cost;
    setText(this.netEl, `${net > 0 ? '+' : net < 0 ? '−' : ''}${formatCredits(Math.abs(net))}`);
    toggleClass(this.netEl, 'plus', net > 0);
    toggleClass(this.netEl, 'minus', net < 0);
    const blocked = this.tradeBlock(cost, revenue);
    this.confirmBtn.disabled = !!blocked;
    this.confirmBtn.title = blocked ?? '';
    this.btnStageValuables.disabled = this.meta.getSellable().length === 0;

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
   * One stock **cell** in the 기업 판매 물품 grid (Phase 9 UI pass — it used to be a wide row). The cell leads with a
   * `buildItemChip` thumbnail, so the shared `ui/hud/ItemTip` hover card describes it, and carries the name, the
   * price and a `×n` badge while the line is staged. Click or drag onto the 구매 tray to stage it.
   */
  private shopCell(line: ShopItem): void {
    const d = line.def;
    const cell = el('div', { cls: `ct-cell shop rarity-${d.rarity}`, parent: this.shopListEl, attrs: { 'data-def': d.id } });
    const owned = this.meta.countAll(d.id);
    cell.appendChild(buildItemChip(d, { size: 48, ...(owned > 0 ? { have: owned } : {}) }));
    el('div', { cls: 'ct-cell-name', text: d.name, parent: cell }).style.color = d.color;
    el('div', { cls: 'ct-cell-price', text: formatCredits(line.price), parent: cell });
    const staged = this.buyLines.find((b) => b.defId === d.id);
    if (staged) el('div', { cls: 'ct-staged', text: `×${staged.qty}`, parent: cell });
    toggleClass(cell, 'blocked', line.blocked !== null);
    // no `title` attribute: it would race the hover card, which already carries 등급 · 분류 · 설명
    if (line.blocked === null) {
      cell.classList.add('is-draggable');
      cell.addEventListener('click', (e) => { e.stopPropagation(); this.stageBuy(d.id); });
      this.makeDraggable(cell, d, '.ct-tray.buy', () => this.stageBuy(d.id));
    } else {
      el('div', { cls: 'ct-cell-block', text: line.blocked, parent: cell });
    }
  }

  /**
   * Pointer-drag for a corp stock row: a floating copy of the item chip follows the cursor and dropping it on
   * `dropSelector` stages the line. Click does the same — the drag only exists so the desk feels like the grids.
   */
  private makeDraggable(row: HTMLElement, def: ItemDef, dropSelector: string, onDrop: () => void): void {
    row.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      let ghost: HTMLElement | null = null;
      let moved = false;
      const move = (ev: PointerEvent): void => {
        if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 5) return;
        moved = true;
        if (!ghost) {
          ghost = document.createElement('div');
          ghost.className = 'ct-drag-ghost';
          ghost.appendChild(buildItemChip(def, { size: 40 }));
          document.body.appendChild(ghost);
        }
        ghost.style.left = `${ev.clientX - 22}px`;
        ghost.style.top = `${ev.clientY - 22}px`;
        const hit = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest(dropSelector);
        ghost.classList.toggle('is-ok', !!hit);
      };
      const up = (ev: PointerEvent): void => {
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', up, true);
        ghost?.remove();
        if (!moved) return;                        // a plain click is handled by the row's own listener
        const hit = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest(dropSelector);
        if (hit) onDrop();
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
    const price = this.meta.sellPriceOf(item.uid);
    if (price === null || price <= 0) {
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
    el('div', { cls: 'ct-title', text: '계약 목록', parent: list });
    this.contractListEl = el('div', { cls: 'cc-list', parent: list });
    const active = el('div', { cls: 'cc-col active', parent: root });
    el('div', { cls: 'ct-title', text: '진행 중인 계약', parent: active });
    this.contractActiveEl = el('div', { cls: 'cc-active', parent: active });
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
    if (!active) this.empty(this.contractActiveEl, '수락한 계약이 없습니다');
    else this.contractRow(this.contractActiveEl, active, true);
  }

  private contractRow(parent: HTMLElement, c: ContractInfo, detail = false): void {
    const d = c.def;
    const r = el('div', { cls: `corp-row contract${detail ? ' is-detail' : ''}`, parent, attrs: { 'data-id': d.id } });
    toggleClass(r, 'active', c.active);
    toggleClass(r, 'blocked', !c.active && c.blocked !== null);
    const mid = el('div', { cls: 'mid', parent: r });
    const nl = el('div', { cls: 'name-line', parent: mid });
    el('div', { cls: 'name', text: d.name, parent: nl });
    if (c.active) el('div', { cls: 'tag', text: '진행 중', parent: nl });
    el('div', { cls: 'tag dim', text: `신뢰도 Lv.${d.minRepLevel}`, parent: nl });
    el('div', { cls: 'sub', text: d.desc, parent: mid });
    const frac = Math.max(0, Math.min(1, d.target > 0 ? c.progress / d.target : 0));
    const bar = el('div', { cls: 'goal-bar', parent: mid });
    const fill = el('i', { parent: bar });
    fill.style.transform = `scaleX(${frac.toFixed(3)})`;
    toggleClass(bar, 'done', c.active && c.progress >= d.target);
    el('div', { cls: 'goal-text', text: `${CONTRACT_GOAL_LABEL_KO[d.goal]} ${fmtNum(Math.floor(c.progress))} / ${fmtNum(d.target)}`, parent: mid });
    el('div', { cls: 'reward', text: `신뢰도 +${d.repReward} · XP +${d.xpReward} · 크레딧 +${formatCredits(d.creditsReward)}`, parent: r });
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
    el('div', { cls: 'ct-title', text: '퀘스트 목록', parent: list });
    this.questListEl = el('div', { cls: 'cq-list', parent: list });
    const detail = el('div', { cls: 'cq-col detail', parent: root });
    el('div', { cls: 'ct-title', text: '납품', parent: detail });
    this.questDetailEl = el('div', { cls: 'cq-deliver', parent: detail });
    const inv = el('div', { cls: 'cq-col inv', parent: root });
    this.questGrids = this.makeGrids(inv, '.cq-deliver');
    this.questsEl = root;
    this.nodes.push(root);
    return root;
  }

  private renderQuests(): void {
    const list = this.meta.getQuests(this.corp);
    this.questListEl.replaceChildren();
    if (list.length === 0) this.empty(this.questListEl, '이 기업의 퀘스트가 없습니다');
    // default selection: the accepted quest, else the first available, else the first row
    if (!list.some((q) => q.def.id === this.selectedQuest)) {
      this.selectedQuest = (list.find((q) => q.state === 'accepted') ?? list.find((q) => q.state === 'available') ?? list[0])?.def.id ?? null;
    }
    for (const q of list) this.questRow(q);

    this.questDetailEl.replaceChildren();
    const sel = list.find((q) => q.def.id === this.selectedQuest) ?? null;
    if (!sel) this.empty(this.questDetailEl, '퀘스트를 선택하세요');
    else this.questDetail(sel);
    this.questGrids?.refresh();
  }

  private questRow(q: QuestInfo): void {
    const d = q.def;
    const r = el('div', { cls: `corp-row quest st-${q.state}`, parent: this.questListEl, attrs: { 'data-id': d.id } });
    toggleClass(r, 'is-sel', d.id === this.selectedQuest);
    el('div', { cls: 'badge', text: QUEST_BADGE[q.state], parent: r });
    const mid = el('div', { cls: 'mid', parent: r });
    el('div', { cls: 'name', text: d.name, parent: mid });
    el('div', { cls: 'sub', text: d.desc, parent: mid });
    r.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.selectedQuest === d.id) return;
      this.selectedQuest = d.id;
      this.ctx.bus.emit('audio:play', { id: 'ui_click' });
      this.refresh();
    });
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

    const rw = d.rewards;
    const rewardCell = el('div', { cls: 'reward', parent: host });
    const parts = [`신뢰도 +${rw.rep}`, `XP +${rw.xp}`];
    if (rw.credits) parts.push(`크레딧 +${formatCredits(rw.credits)}`);
    el('div', { cls: 'rw-line', text: parts.join(' · '), parent: rewardCell });
    const items = rw.items ?? [];
    if (items.length > 0) {
      const chips = el('div', { cls: 'rw-items item-chips', parent: rewardCell });
      for (const it of items) chips.appendChild(buildItemChip(this.itemDef(it.defId), { size: 30, need: it.qty }));
    }

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
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.tradeGrids?.dispose(); this.tradeGrids = null;
    this.questGrids?.dispose(); this.questGrids = null;
    for (const n of this.nodes) n.remove();
    this.nodes.length = 0;
    this.host.classList.remove('corp-view', 'is-embedded');
    this.host.style.removeProperty('--cc');
  }
}
