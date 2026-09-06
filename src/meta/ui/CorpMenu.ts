import type { ContractInfo, CorpId, GameContext, ItemInstance, QuestInfo, QuestState, ShopItem } from '@/shared';
import { CATEGORY_LABEL_KO, CONTRACT_GOAL_LABEL_KO, CORP_DEFS, CORP_IDS, RARITY_LABEL_KO, REP_TABLE, SHOP_UNLOCK_REP_LEVEL } from '@/shared';
import type { MetaSystem, PurchaseFailure } from '../MetaSystem';
import { el, fmtNum, setText, toggleClass } from './dom';

export type CorpPage = 'shop' | 'sell' | 'contracts' | 'quests';
const PAGES: readonly { id: CorpPage; label: string }[] = [
  { id: 'shop', label: '상점' }, { id: 'sell', label: '판매' }, { id: 'contracts', label: '계약' }, { id: 'quests', label: '퀘스트' },
];
const BLOCKER = 'corp';

const QUEST_BADGE: Readonly<Record<QuestState, string>> = { locked: '잠김', available: '가능', accepted: '진행', complete: '완료' };

/**
 * 기업 네트워크 screen (`.menu.corp-menu`, ship computer): header with the credit readout, four corp tabs (accent =
 * `CorpDef.color`, name + Lv.n), a banner with the slogan and the reputation bar, then the 상점 / 판매 / 계약 / 퀘스트
 * sub-pages. Same etiquette as the hub / housing panels: the `'corp'` blocker is added **before** the pointer lock
 * exits, Esc closes through a capture-phase window listener, the lock is re-requested one microtask after closing
 * when nothing else blocks and the phase is still `hub`. Emits `ui:corpToggled`; results show inline (`.form-msg`),
 * toasts are the ui folder's (driven by the `meta:*` events the system emits). Purchases complete asynchronously with
 * a server profile: `buy()` only says whether the request went out, the row refreshes on `meta:purchase` and a refusal
 * arrives through `MetaSystem.onPurchaseFailed`.
 */
export class CorpMenu {
  readonly root: HTMLElement;
  private readonly frame: HTMLElement;
  private readonly creditsEl: HTMLElement;
  private readonly corpTabs = new Map<CorpId, HTMLButtonElement>();
  private readonly corpLv = new Map<CorpId, HTMLElement>();
  private readonly banner: { name: HTMLElement; tag: HTMLElement; desc: HTMLElement; bar: HTMLElement; text: HTMLElement; lv: HTMLElement };
  private readonly subTabs = new Map<CorpPage, HTMLButtonElement>();
  private readonly page: HTMLElement;
  private readonly msg: HTMLElement;
  private readonly btnSellAll: HTMLButtonElement;
  private unsubs: Array<() => void> = [];
  private _open = false;
  private corp: CorpId = 'helix';
  private current: CorpPage = 'shop';
  private msgTimer = 0;
  private onKeyCapture = (e: KeyboardEvent): void => {
    if (!this._open || e.code !== 'Escape') return;
    e.stopImmediatePropagation();
    e.preventDefault();
    this.close();
  };

  constructor(private readonly ctx: GameContext, private readonly meta: MetaSystem) {
    const root = this.root = el('div', { cls: 'menu corp-menu interactive', parent: ctx.uiRoot });
    root.hidden = true;
    el('div', { cls: 'scan', parent: root });
    const f = this.frame = el('div', { cls: 'frame', parent: root });

    const head = el('div', { cls: 'hub-head', parent: f });
    const hl = el('div', { cls: 'hl', parent: head });
    el('div', { cls: 'title', text: '기업 네트워크', parent: hl });
    el('div', { cls: 'subtitle', text: '함선 컴퓨터 · 상점 / 판매 / 계약 / 퀘스트', parent: hl });
    const cr = el('div', { cls: 'corp-credits', parent: head });
    el('span', { cls: 'k', text: '크레딧', parent: cr });
    this.creditsEl = el('span', { cls: 'v', text: '0', parent: cr });

    const tabs = el('div', { cls: 'corp-tabs', parent: f });
    for (const id of CORP_IDS) {
      const def = CORP_DEFS[id];
      const b = el('button', { cls: 'corp-tab', parent: tabs, attrs: { 'data-corp': id } });
      b.style.setProperty('--cc', def.color);
      el('span', { cls: 'name', text: def.name, parent: b });
      this.corpLv.set(id, el('span', { cls: 'lv', text: 'Lv.0', parent: b }));
      b.addEventListener('click', (e) => { e.stopPropagation(); this.setCorp(id); });
      this.corpTabs.set(id, b);
    }

    const banner = el('div', { cls: 'corp-banner', parent: f });
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

    const sub = el('div', { cls: 'corp-subtabs', parent: f });
    for (const p of PAGES) {
      const b = el('button', { cls: 'scr-tab', text: p.label, parent: sub, attrs: { 'data-page': p.id } });
      b.addEventListener('click', (e) => { e.stopPropagation(); this.setPage(p.id); });
      this.subTabs.set(p.id, b);
    }

    this.page = el('div', { cls: 'corp-page', parent: f });
    this.msg = el('div', { cls: 'form-msg', parent: f });
    this.msg.hidden = true;

    const foot = el('div', { cls: 'hub-foot', parent: f });
    this.button(foot, '닫기', () => this.close());
    const right = el('div', { cls: 'right', parent: foot });
    this.btnSellAll = this.button(right, '귀중품 전부 판매', () => this.sellAll(), 'primary');

    root.addEventListener('mousedown', (e) => e.stopPropagation());   // keep clicks off the canvas' click-to-lock fallback

    const b = ctx.bus;
    const refresh = (): void => this.refreshIfOpen();
    this.unsubs.push(
      b.on('meta:creditsChanged', refresh), b.on('meta:repChanged', refresh), b.on('meta:contractAccepted', refresh),
      b.on('meta:contractAbandoned', refresh), b.on('meta:contractSettled', refresh), b.on('meta:questChanged', refresh),
      b.on('meta:purchase', ({ defId, price }) => {
        if (this._open) this.showMsg(`${this.defName(defId)} 구매 · −${fmtNum(price)} 크레딧`, 'success');
        refresh();
      }),
      b.on('meta:sale', refresh), b.on('meta:loaded', refresh),
      b.on('inventory:changed', refresh), b.on('inventory:stashChanged', refresh), b.on('loadout:changed', refresh),
    );
    meta.onPurchaseFailed = (f: PurchaseFailure): void => {
      if (!this._open) return;
      this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
      this.showMsg(`${this.defName(f.defId)} 구매 실패 · ${f.reason}`, 'danger');
      this.refresh();
    };
  }

  get isOpen(): boolean { return this._open; }
  get currentCorp(): CorpId { return this.corp; }
  get currentPage(): CorpPage { return this.current; }

  /* ── open / close ─────────────────────────────────────────────────────── */
  open(corp?: CorpId): void {
    if (corp && CORP_DEFS[corp]) this.corp = corp;
    if (this._open) { this.refresh(); return; }
    this._open = true;
    this.ctx.uiBlockers.add(BLOCKER);          // before the lock exits
    this.ctx.input.exitPointerLock();
    this.root.hidden = false;
    this.frame.style.animation = 'none';
    void this.frame.offsetWidth;
    this.frame.style.animation = '';
    this.msg.hidden = true;
    window.addEventListener('keydown', this.onKeyCapture, true);
    this.refresh();
    this.ctx.bus.emit('ui:corpToggled', { open: true, corp: this.corp });
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
  }

  close(relock = true): void {
    if (!this._open) return;
    this._open = false;
    window.removeEventListener('keydown', this.onKeyCapture, true);
    this.root.hidden = true;
    this.msg.hidden = true;
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.ctx.uiBlockers.delete(BLOCKER);
    this.ctx.bus.emit('ui:corpToggled', { open: false, corp: this.corp });
    if (relock) {
      queueMicrotask(() => {
        const ctx = this.ctx;
        if (ctx.phase !== 'hub' || ctx.uiBlockers.size > 0) return;
        ctx.input.requestPointerLock();
      });
    }
  }

  setCorp(corp: CorpId): void {
    if (this.corp === corp) return;
    this.corp = corp;
    this.msg.hidden = true;
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.refresh();
  }

  setPage(page: CorpPage): void {
    if (this.current === page) return;
    this.current = page;
    this.msg.hidden = true;
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.refresh();
  }

  /* ── state → DOM ──────────────────────────────────────────────────────── */
  private refreshIfOpen(): void { if (this._open) this.refresh(); }

  refresh(): void {
    if (!this._open) return;
    const meta = this.meta;
    setText(this.creditsEl, fmtNum(meta.credits));
    for (const id of CORP_IDS) {
      const r = meta.getRep(id);
      setText(this.corpLv.get(id)!, `Lv.${r.level}`);
      toggleClass(this.corpTabs.get(id)!, 'is-on', id === this.corp);
    }
    const def = CORP_DEFS[this.corp];
    const rep = meta.getRep(this.corp);
    this.frame.style.setProperty('--cc', def.color);
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

  private itemDef(defId: string) { return this.ctx.loot?.getItemDef(defId) ?? this.ctx.inventory?.getDef(defId); }
  private defName(defId: string): string { return this.itemDef(defId)?.name ?? defId; }

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
    const icon = el('div', { cls: 'icon', text: d.icon, parent: r });
    icon.style.color = d.color;
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
      const icon = el('div', { cls: 'icon', text: d.icon, parent: r });
      icon.style.color = d.color;
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
    const dl = el('div', { cls: 'deliver', parent: mid });
    for (const line of q.deliver) {
      const li = el('span', { cls: 'dl', text: `${this.defName(line.defId)} ${line.have} / ${line.qty}`, parent: dl });
      toggleClass(li, 'short', line.have < line.qty);
    }
    const rw = d.rewards;
    const parts = [`신뢰도 +${rw.rep}`, `XP +${rw.xp}`];
    if (rw.credits) parts.push(`크레딧 +${fmtNum(rw.credits)}`);
    for (const it of rw.items ?? []) parts.push(`${this.defName(it.defId)} ×${it.qty}`);
    el('div', { cls: 'reward', text: parts.join(' · '), parent: r });
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
        this.showMsg(ok ? `${d.name} 완료 · ${parts.join(' · ')}` : `납품 실패 · ${after?.blocked ?? ''}`, ok ? 'success' : 'danger');
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
    if (!this._open) return;
    this.msg.textContent = text;
    this.msg.className = `form-msg ${kind}`;
    this.msg.hidden = false;
    this.msgTimer = performance.now() + 4000;
  }

  update(): void {
    if (this.msgTimer > 0 && !this.msg.hidden && performance.now() > this.msgTimer) { this.msg.hidden = true; this.msgTimer = 0; }
  }

  private button(parent: HTMLElement, label: string, onClick: () => void, extraCls = ''): HTMLButtonElement {
    const b = el('button', { cls: `ui-btn ${extraCls}`.trim(), text: label, parent });
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  }

  dispose(): void {
    this.close(false);
    if (this.meta.onPurchaseFailed) this.meta.onPurchaseFailed = null;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.root.remove();
  }
}
