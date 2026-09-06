import type { ContractInfo, CorpId, GameContext, ItemDef, ItemInstance, QuestInfo, QuestState, ShopItem } from '@/shared';
import {
  CATEGORY_LABEL_KO, CONTRACT_GOAL_LABEL_KO, CORP_DEFS, CORP_IDS, RARITY_LABEL_KO, REP_TABLE, SHOP_UNLOCK_REP_LEVEL,
  buildItemChip, renderItemCost,
} from '@/shared';
import type { MetaSystem, PurchaseFailure } from '../MetaSystem';
import { el, fmtNum, setText, toggleClass } from './dom';

/* ────────────────────────────────────────────────────────────────────────────
 * CorpView — the **body** of the 기업 네트워크 screen (Phase 8, 2026-09-06).
 *
 * Everything between the header and the footer lives here so the two shells share one set of renderers:
 *   • `ui/CorpMenu.ts` — the standalone `.menu.corp-menu` overlay (ship computer `hub_computer`): blocker `'corp'`,
 *     pointer-lock etiquette, capture-phase Escape, 닫기 button.
 *   • `MetaSystem.createCorpView(host)` — the **embedded** variant for the inventory Tab screen's 기업 tab:
 *     no blocker, no pointer-lock call, no window Escape listener (the inventory window owns all three).
 *
 * The view appends its elements straight into the host (the frame for the overlay, the `.inv-screen` host for the
 * embedded one) and marks that host `.corp-view`, so one stylesheet (`meta.css`) covers both. `dispose()` removes
 * exactly the elements and listeners it added — never the host itself.
 *
 * Layout stability (요구사항 2): `.corp-page` has a **fixed** height, the message line sits in a reserved slot and the
 * footer keeps its height while 귀중품 전부 판매 is hidden, so switching 상점 / 판매 / 계약 / 퀘스트 never resizes the frame.
 * ──────────────────────────────────────────────────────────────────────────── */

export type CorpPage = 'shop' | 'sell' | 'contracts' | 'quests';

const PAGES: readonly { id: CorpPage; label: string }[] = [
  { id: 'shop', label: '상점' }, { id: 'sell', label: '판매' }, { id: 'contracts', label: '계약' }, { id: 'quests', label: '퀘스트' },
];

const QUEST_BADGE: Readonly<Record<QuestState, string>> = { locked: '잠김', available: '가능', accepted: '진행', complete: '완료' };

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
  private readonly banner: { name: HTMLElement; tag: HTMLElement; desc: HTMLElement; bar: HTMLElement; text: HTMLElement; lv: HTMLElement };
  private readonly subTabs = new Map<CorpPage, HTMLButtonElement>();
  private readonly page: HTMLElement;
  private readonly msg: HTMLElement;
  private readonly btnSellAll: HTMLButtonElement;
  private unsubs: Array<() => void> = [];
  private corp: CorpId = 'helix';
  private current: CorpPage = 'shop';
  private msgTimer = 0;
  private disposed = false;

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

    const head = add(el('div', { cls: 'hub-head', parent: host }));
    const hl = el('div', { cls: 'hl', parent: head });
    el('div', { cls: 'title', text: '기업 네트워크', parent: hl });
    el('div', { cls: 'subtitle', text: opts.embedded ? '상점 / 판매 / 계약 / 퀘스트' : '함선 컴퓨터 · 상점 / 판매 / 계약 / 퀘스트', parent: hl });
    const cr = el('div', { cls: 'corp-credits', parent: head });
    el('span', { cls: 'k', text: '크레딧', parent: cr });
    this.creditsEl = el('span', { cls: 'v', text: '0', parent: cr });

    const tabs = add(el('div', { cls: 'corp-tabs', parent: host }));
    for (const id of CORP_IDS) {
      const def = CORP_DEFS[id];
      const b = el('button', { cls: 'corp-tab', parent: tabs, attrs: { 'data-corp': id } });
      b.style.setProperty('--cc', def.color);
      el('span', { cls: 'name', text: def.name, parent: b });
      this.corpLv.set(id, el('span', { cls: 'lv', text: 'Lv.0', parent: b }));
      b.addEventListener('click', (e) => { e.stopPropagation(); this.setCorp(id); });
      this.corpTabs.set(id, b);
    }

    const banner = add(el('div', { cls: 'corp-banner', parent: host }));
    const bl = el('div', { cls: 'bl', parent: banner });
    const name = el('div', { cls: 'name', parent: bl });
    const tag = el('div', { cls: 'tag', parent: bl });
    const desc = el('div', { cls: 'desc', parent: bl });
    const br = el('div', { cls: 'br', parent: banner });
    const repHead = el('div', { cls: 'rep-head', parent: br });
    el('span', { cls: 'k', text: '신뢰도', parent: repHead });
    const lv = el('span', { cls: 'lv', text: 'Lv.0', parent: repHead });
    const bar = el('div', { cls: 'rep-bar', parent: br });
    const fill = el('i', { parent: bar });
    const text = el('div', { cls: 'rep-text', parent: br });
    this.banner = { name, tag, desc, bar: fill, text, lv };

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
    this.btnSellAll = this.button(right, '귀중품 전부 판매', () => this.sellAll(), 'primary');

    const b = ctx.bus;
    const refresh = (): void => this.refreshIfVisible();
    this.unsubs.push(
      b.on('meta:creditsChanged', refresh), b.on('meta:repChanged', refresh), b.on('meta:contractAccepted', refresh),
      b.on('meta:contractAbandoned', refresh), b.on('meta:contractSettled', refresh), b.on('meta:questChanged', refresh),
      b.on('meta:purchase', ({ defId, price }) => {
        if (this.visible) this.showMsg(`${this.defName(defId)} 구매 · −${fmtNum(price)} 크레딧`, 'success');
        refresh();
      }),
      b.on('meta:sale', refresh), b.on('meta:loaded', refresh),
      b.on('inventory:changed', refresh), b.on('inventory:stashChanged', refresh), b.on('loadout:changed', refresh),
      meta.onPurchaseFailure((f: PurchaseFailure) => {
        if (!this.visible) return;
        this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
        this.showMsg(`${this.defName(f.defId)} 구매 실패 · ${f.reason}`, 'danger');
        this.refresh();
      }),
    );
  }

  get currentCorp(): CorpId { return this.corp; }
  get currentPage(): CorpPage { return this.current; }
  private get visible(): boolean {
    if (this.disposed) return false;
    return this.opts.isVisible ? this.opts.isVisible() : this.host.isConnected;
  }

  setCorp(corp: CorpId): void {
    if (this.corp === corp || !CORP_DEFS[corp]) return;
    this.corp = corp;
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
    setText(this.creditsEl, fmtNum(meta.credits));
    for (const id of CORP_IDS) {
      const r = meta.getRep(id);
      setText(this.corpLv.get(id)!, `Lv.${r.level}`);
      toggleClass(this.corpTabs.get(id)!, 'is-on', id === this.corp);
    }
    const def = CORP_DEFS[this.corp];
    const rep = meta.getRep(this.corp);
    this.host.style.setProperty('--cc', def.color);
    this.opts.accentTarget?.style.setProperty('--cc', def.color);
    setText(this.banner.name, def.name);
    setText(this.banner.tag, def.tagline);
    setText(this.banner.desc, def.description);
    setText(this.banner.lv, `Lv.${rep.level}`);
    const prev = REP_TABLE[rep.level] ?? 0;            // cumulative rep where the current level started
    const span = rep.next === null ? 1 : Math.max(1, rep.next - prev);
    const frac = rep.next === null ? 1 : Math.max(0, Math.min(1, (rep.rep - prev) / span));
    this.banner.bar.style.transform = `scaleX(${frac.toFixed(3)})`;
    setText(this.banner.text, rep.next === null ? `${fmtNum(rep.rep)} · 최고 등급` : `${fmtNum(rep.rep)} / ${fmtNum(rep.next)}`);

    for (const p of PAGES) toggleClass(this.subTabs.get(p.id)!, 'is-on', p.id === this.current);
    this.btnSellAll.hidden = this.current !== 'sell';

    this.page.replaceChildren();
    this.page.dataset.page = this.current;
    switch (this.current) {
      case 'shop': this.renderShop(); break;
      case 'sell': this.renderSell(); break;
      case 'contracts': this.renderContracts(); break;
      case 'quests': this.renderQuests(); break;
    }
  }

  private empty(text: string): void {
    el('div', { cls: 'corp-empty', text, parent: this.page });
  }

  private itemDef(defId: string): ItemDef | undefined { return this.ctx.loot?.getItemDef(defId) ?? this.ctx.inventory?.getDef(defId); }
  private defName(defId: string): string { return this.itemDef(defId)?.name ?? defId; }
  /** Thumbnail cell for a row (`buildItemChip` — the only material / item thumbnail renderer since Phase 8). */
  private thumb(parent: HTMLElement, def: ItemDef, chip: { have?: number; need?: number } = {}): void {
    const cell = el('div', { cls: 'thumb', parent });
    cell.appendChild(buildItemChip(def, { size: 34, ...chip }));
  }

  private renderShop(): void {
    const rep = this.meta.getRep(this.corp);
    if (rep.level < SHOP_UNLOCK_REP_LEVEL) { this.empty(`신뢰도 Lv.${SHOP_UNLOCK_REP_LEVEL} 부터 거래할 수 있습니다`); return; }
    const lines = this.meta.getShop(this.corp);
    if (lines.length === 0) { this.empty('판매 중인 품목이 없습니다'); return; }
    for (const line of lines) this.shopRow(line);
  }

  private shopRow(line: ShopItem): void {
    const d = line.def;
    const r = el('div', { cls: `corp-row shop rarity-${d.rarity}`, parent: this.page, attrs: { 'data-def': d.id } });
    const owned = this.meta.countAll(d.id);
    this.thumb(r, d, owned > 0 ? { have: owned } : {});
    const mid = el('div', { cls: 'mid', parent: r });
    const nm = el('div', { cls: 'name', text: d.name, parent: mid });
    nm.style.color = d.color;
    el('div', { cls: 'sub', text: `${RARITY_LABEL_KO[d.rarity]} · ${CATEGORY_LABEL_KO[d.category] ?? d.category}${d.description ? ` · ${d.description}` : ''}`, parent: mid });
    el('div', { cls: 'price', text: `${fmtNum(line.price)} cr`, parent: r });
    const btn = this.button(r, '구매', () => this.buy(d.id));
    btn.disabled = line.blocked !== null;
    btn.title = line.blocked ?? '';
    toggleClass(r, 'blocked', line.blocked !== null);
  }

  private buy(defId: string): void {
    const ok = this.meta.buy(this.corp, defId);
    this.ctx.bus.emit('audio:play', { id: ok ? 'ui_equip' : 'ui_deny' });
    // success is announced by `meta:purchase` (synchronous offline, after the server answer otherwise)
    if (ok) { if (this.meta.hasPendingTx) this.showMsg(`${this.defName(defId)} 구매 처리 중…`, 'info'); }
    else this.showMsg(`구매 불가 · ${this.meta.lastPurchaseFailure?.reason ?? '알 수 없음'}`, 'danger');
    this.refresh();
  }

  private renderSell(): void {
    const items = this.meta.getSellable();
    if (items.length === 0) { this.empty('판매할 수 있는 아이템이 없습니다 (가방 · 창고)'); return; }
    const inv = this.ctx.inventory;
    const canSell = !!inv && typeof inv.takeItem === 'function';
    let anyValuable = false;
    for (const inst of items) {
      const d = this.itemDef(inst.defId);
      if (!d) continue;
      const price = this.meta.sellPriceOf(inst.uid) ?? 0;
      const inBag = !!inv?.findItem(inst.uid);
      if (d.category === 'valuable') anyValuable = true;
      const r = el('div', { cls: `corp-row sell rarity-${d.rarity}`, parent: this.page, attrs: { 'data-uid': inst.uid } });
      this.thumb(r, d, { have: inst.qty });
      const mid = el('div', { cls: 'mid', parent: r });
      const nm = el('div', { cls: 'name', text: d.name, parent: mid });
      nm.style.color = d.color;
      el('div', { cls: 'sub', text: `${inBag ? '가방' : '창고'} · 수량 ${inst.qty} · ${RARITY_LABEL_KO[d.rarity]} ${CATEGORY_LABEL_KO[d.category] ?? d.category}`, parent: mid });
      el('div', { cls: 'price', text: `+${fmtNum(price)} cr`, parent: r });
      const btn = this.button(r, inst.qty > 1 ? '전량 판매' : '판매', () => this.sell(inst));
      btn.disabled = !canSell || price <= 0;
      btn.title = canSell ? '' : '판매 기능이 준비되지 않았습니다';
    }
    this.btnSellAll.disabled = !canSell || !anyValuable;
  }

  private sell(inst: ItemInstance): void {
    const name = this.defName(inst.defId);
    const price = this.meta.sellPriceOf(inst.uid) ?? 0;
    const ok = this.meta.sell(inst.uid);
    this.ctx.bus.emit('audio:play', { id: ok ? 'ui_equip' : 'ui_deny' });
    this.showMsg(ok ? `${name} 판매 · +${fmtNum(price)} 크레딧` : `${name} 판매 실패`, ok ? 'success' : 'danger');
    this.refresh();
  }

  /** 귀중품 only — weapons, ammo and materials stay. */
  private sellAll(): void {
    let sold = 0, credits = 0;
    for (const inst of [...this.meta.getSellable()]) {
      const d = this.itemDef(inst.defId);
      if (!d || d.category !== 'valuable') continue;
      const price = this.meta.sellPriceOf(inst.uid) ?? 0;
      if (this.meta.sell(inst.uid)) { sold++; credits += price; }
    }
    this.ctx.bus.emit('audio:play', { id: sold > 0 ? 'ui_equip' : 'ui_deny' });
    this.showMsg(sold > 0 ? `귀중품 ${sold}종 판매 · +${fmtNum(credits)} 크레딧` : '판매할 귀중품이 없습니다', sold > 0 ? 'success' : 'warning');
    this.refresh();
  }

  private renderContracts(): void {
    const list = this.meta.getContracts(this.corp);
    if (list.length === 0) { this.empty('이 기업의 계약이 없습니다'); return; }
    for (const c of list) this.contractRow(c);
  }

  private contractRow(c: ContractInfo): void {
    const d = c.def;
    const r = el('div', { cls: 'corp-row contract', parent: this.page, attrs: { 'data-id': d.id } });
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
    el('div', { cls: 'reward', text: `신뢰도 +${d.repReward} · XP +${d.xpReward} · 크레딧 +${fmtNum(d.creditsReward)}`, parent: r });
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

  private renderQuests(): void {
    const list = this.meta.getQuests(this.corp);
    if (list.length === 0) { this.empty('이 기업의 퀘스트가 없습니다'); return; }
    for (const q of list) this.questRow(q);
  }

  private questRow(q: QuestInfo): void {
    const d = q.def;
    const r = el('div', { cls: `corp-row quest st-${q.state}`, parent: this.page, attrs: { 'data-id': d.id } });
    el('div', { cls: 'badge', text: QUEST_BADGE[q.state], parent: r });
    const mid = el('div', { cls: 'mid', parent: r });
    el('div', { cls: 'name', text: d.name, parent: mid });
    el('div', { cls: 'sub', text: d.desc, parent: mid });
    // 납품 requirements as 보유/필요 chips (`renderItemCost`) — short lines dim and turn the 보유 number red
    const dl = el('div', { cls: 'deliver', parent: mid });
    const have = new Map(q.deliver.map((line) => [line.defId, line.have]));
    renderItemCost(
      dl,
      q.deliver.map((line) => ({ defId: line.defId, qty: line.qty })),
      (id) => this.itemDef(id),
      (id) => have.get(id) ?? this.meta.countAll(id),
      { size: 30 },
    );
    const rw = d.rewards;
    const rewardCell = el('div', { cls: 'reward', parent: r });
    const parts = [`신뢰도 +${rw.rep}`, `XP +${rw.xp}`];
    if (rw.credits) parts.push(`크레딧 +${fmtNum(rw.credits)}`);
    el('div', { cls: 'rw-line', text: parts.join(' · '), parent: rewardCell });
    const items = rw.items ?? [];
    if (items.length > 0) {
      const chips = el('div', { cls: 'rw-items item-chips', parent: rewardCell });
      for (const it of items) chips.appendChild(buildItemChip(this.itemDef(it.defId), { size: 30, need: it.qty }));
    }
    const summary = [...parts, ...items.map((it) => `${this.defName(it.defId)} ×${it.qty}`)];
    if (q.state === 'available') {
      this.button(r, '수락', () => {
        const ok = this.meta.acceptQuest(d.id);
        this.ctx.bus.emit('audio:play', { id: ok ? 'ui_equip' : 'ui_deny' });
        this.showMsg(ok ? `${d.name} 수락` : '수락할 수 없습니다', ok ? 'success' : 'danger');
        this.refresh();
      });
    } else if (q.state === 'accepted') {
      const btn = this.button(r, '납품', () => {
        const ok = this.meta.completeQuest(d.id);
        this.ctx.bus.emit('audio:play', { id: ok ? 'ui_equip' : 'ui_deny' });
        const after = this.meta.getQuests(this.corp).find((x) => x.def.id === d.id);
        this.showMsg(ok ? `${d.name} 완료 · ${summary.join(' · ')}` : `납품 실패 · ${after?.blocked ?? ''}`, ok ? 'success' : 'danger');
        this.refresh();
      }, 'primary');
      btn.disabled = q.blocked !== null;
      btn.title = q.blocked ?? '';
    } else {
      const b = this.button(r, q.state === 'complete' ? '완료' : '잠김', () => {});
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
    for (const n of this.nodes) n.remove();
    this.nodes.length = 0;
    this.host.classList.remove('corp-view', 'is-embedded');
    this.host.style.removeProperty('--cc');
  }
}
