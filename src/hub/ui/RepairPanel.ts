import type { DurabilityInfo, EquipSlot, GameContext, ItemDef, ItemInstance } from '@/shared';
import { el, setText, toggleClass } from './dom';

const SLOT_LABEL: Record<EquipSlot, string> = {
  primary: '주무기 I', primary2: '주무기 II', secondary: '보조무기', armor: '방탄복', bag: '가방',
};
const EQUIP_SLOTS: EquipSlot[] = ['primary', 'primary2', 'secondary', 'armor', 'bag'];
const RARITY_VAR: Record<string, string> = {
  common: '--r-common', uncommon: '--r-uncommon', rare: '--r-rare', epic: '--r-epic', legendary: '--r-legendary',
};
/** Rebuilding rows on every durability tick would fight the DOM; refresh at most this often. */
const REFRESH_MIN_MS = 120;

interface Entry {
  item: ItemInstance;
  def: ItemDef | undefined;
  dur: DurabilityInfo;
  where: string;
}

export interface RepairPanelHost {
  showMsg(text: string, kind?: 'info' | 'success' | 'warning' | 'danger'): void;
}

/**
 * 장비 수리 page of the ship terminal: every worn gear item (equipped or in the bag) with a durability
 * bar and a 수리 button → `ctx.inventory.repair(uid)` (ship only). Rows are rebuilt on refresh; the list
 * is short (4 slots + a handful of spares) so this stays cheap and is only live while the page is open.
 */
export class RepairPanel {
  readonly root: HTMLElement;
  private list: HTMLElement;
  private note: HTMLElement;
  private empty: HTMLElement;
  private btnAll: HTMLButtonElement;
  private unsubs: Array<() => void> = [];
  private visible = false;
  private lastRefresh = 0;

  constructor(private readonly ctx: GameContext, private readonly host: RepairPanelHost) {
    const root = this.root = el('div', { cls: 'hub-page' });
    const sec = el('div', { cls: 'hub-section', parent: root });
    el('div', { cls: 'ui-label', text: '장비 정비', parent: sec });
    this.note = el('div', { cls: 'hint', parent: sec });
    this.list = el('div', { cls: 'rep-list', parent: sec });
    this.empty = el('div', { cls: 'rep-empty', text: '손상된 장비가 없습니다.', parent: sec });
    this.btnAll = el('button', { cls: 'ui-btn wide', text: '전체 수리', parent: sec });
    this.btnAll.addEventListener('click', (e) => { e.stopPropagation(); this.repairAll(); });
    el('div', { cls: 'hint', text: '내구도가 0이 되면 무기는 연사 속도가 떨어지고 방탄복은 방어력을 잃습니다. 수리는 함선에서만 가능합니다.', parent: sec });

    const b = ctx.bus;
    const dirty = (): void => { if (this.visible) this.refresh(); };
    this.unsubs.push(
      b.on('repair:completed', dirty),
      b.on('durability:changed', dirty),
      b.on('durability:broken', dirty),
      b.on('equip:changed', dirty),
      b.on('loadout:changed', dirty),
    );
  }

  setVisible(v: boolean): void {
    this.visible = v;
    if (v) this.refresh(true);
  }

  /* ── data ────────────────────────────────────────────────────────────────── */
  private collect(): Entry[] {
    const inv = this.ctx.inventory;
    const out: Entry[] = [];
    if (!inv || typeof inv.getDurability !== 'function') return out;
    const seen = new Set<string>();
    const push = (item: ItemInstance | null | undefined, where: string): void => {
      if (!item || seen.has(item.uid)) return;
      seen.add(item.uid);
      let dur: DurabilityInfo | null = null;
      try { dur = inv.getDurability(item.uid); } catch { dur = null; }
      if (!dur || dur.max <= 0 || dur.durability >= dur.max) return;
      out.push({ item, def: inv.getDef(item.defId), dur, where });
    };

    const loadout = typeof inv.getLoadout === 'function' ? inv.getLoadout() : null;
    for (const slot of EQUIP_SLOTS) {
      const equipped = typeof inv.getEquipped === 'function' ? inv.getEquipped(slot) : (loadout?.[slot] ?? null);
      push(equipped, SLOT_LABEL[slot]);
    }
    if (typeof inv.getAllItems === 'function') for (const it of inv.getAllItems()) push(it, '가방');
    out.sort((a, b) => a.dur.durability / a.dur.max - b.dur.durability / b.dur.max);
    return out;
  }

  /* ── actions ─────────────────────────────────────────────────────────────── */
  private repair(uid: string, name: string): void {
    const ctx = this.ctx;
    ctx.bus.emit('audio:play', { id: 'ui_click' });
    if (ctx.isRaidActive()) { this.host.showMsg('임무 중에는 수리할 수 없습니다', 'warning'); return; }
    const inv = ctx.inventory;
    if (!inv || typeof inv.repair !== 'function') { this.host.showMsg('정비 모듈을 사용할 수 없습니다', 'danger'); return; }
    if (!inv.repair(uid)) { this.host.showMsg(`${name} 수리에 실패했습니다`, 'warning'); return; }
    this.host.showMsg(`${name} 수리 완료`, 'success');
    this.refresh(true);
  }

  private repairAll(): void {
    const ctx = this.ctx;
    ctx.bus.emit('audio:play', { id: 'ui_click' });
    if (ctx.isRaidActive()) { this.host.showMsg('임무 중에는 수리할 수 없습니다', 'warning'); return; }
    const inv = ctx.inventory;
    if (!inv || typeof inv.repair !== 'function') { this.host.showMsg('정비 모듈을 사용할 수 없습니다', 'danger'); return; }
    let n = 0;
    for (const e of this.collect()) if (inv.repair(e.item.uid)) n++;
    this.host.showMsg(n > 0 ? `장비 ${n}점을 수리했습니다` : '수리할 장비가 없습니다', n > 0 ? 'success' : 'info');
    this.refresh(true);
  }

  /* ── render ──────────────────────────────────────────────────────────────── */
  refresh(force = false): void {
    const now = performance.now();
    if (!force && now - this.lastRefresh < REFRESH_MIN_MS) return;
    this.lastRefresh = now;

    const ctx = this.ctx;
    const inv = ctx.inventory;
    const usable = !!inv && typeof inv.repair === 'function';
    const raid = ctx.isRaidActive();
    setText(this.note, !usable
      ? '정비 모듈이 아직 활성화되지 않았습니다.'
      : raid ? '임무 중에는 수리할 수 없습니다.' : '내구도가 닳은 장비를 함선 정비대에서 완전 수리합니다.');
    toggleClass(this.note, 'warn', !usable || raid);

    const entries = usable ? this.collect() : [];
    this.list.textContent = '';
    for (const e of entries) {
      const name = e.def?.name ?? e.item.defId;
      const row = el('div', { cls: `rep-row${e.dur.broken ? ' broken' : ''}`, parent: this.list });
      if (e.def) row.style.setProperty('--rc', `var(${RARITY_VAR[e.def.rarity] ?? '--r-common'})`);
      const info = el('div', { cls: 'info', parent: row });
      const head = el('div', { cls: 'head', parent: info });
      el('div', { cls: 'name', text: name, parent: head });
      el('div', { cls: 'where', text: e.where, parent: head });
      if (e.dur.broken) el('div', { cls: 'broken-tag', text: '파손', parent: head });
      const bar = el('div', { cls: 'bar', parent: info });
      const fill = el('i', { parent: bar });
      fill.style.transform = `scaleX(${Math.max(0, Math.min(1, e.dur.durability / e.dur.max))})`;
      el('div', { cls: 'num ui-mono', text: `${Math.round(e.dur.durability)} / ${Math.round(e.dur.max)}`, parent: info });
      const btn = el('button', { cls: 'ui-btn', text: '수리', parent: row });
      btn.disabled = raid;
      btn.addEventListener('click', (ev) => { ev.stopPropagation(); this.repair(e.item.uid, name); });
    }
    this.empty.hidden = entries.length > 0 || !usable;
    this.list.hidden = entries.length === 0;
    this.btnAll.disabled = !usable || raid || entries.length === 0;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.root.remove();
  }
}
