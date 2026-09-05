import type { GameContext, ItemInstance, LoadoutSlot } from '@/shared';
import { WEAPON_DEFAULT_DURABILITY } from '@/shared';
import { el, setText, toggleClass } from './dom';

/** What the menu needs from HubSystem. */
export interface WorkbenchMenuHost {
  /** Called after the menu closed itself (Esc / 닫기) so the hub re-locks the pointer. */
  onClosed(): void;
}

const SLOT_LABEL: Record<Exclude<LoadoutSlot, 'bag'>, string> = { primary: '주무기 I', primary2: '주무기 II', secondary: '보조무기' };
const SCRAP_ID = 'mat_scrap';
const ALLOY_ID = 'mat_alloy';
const MAT_NAME_FALLBACK: Record<string, string> = { [SCRAP_ID]: '폐금속', [ALLOY_ID]: '합금 판' };

interface RepairCost { defId: string; qty: number }

interface WeaponRow {
  uid: string;
  inst: ItemInstance;
  slotLabel: string;
}

/**
 * Ship workbench menu (`.menu.hub-menu.workbench`): one row per owned weapon (loadout slots first, then the bag)
 * with a durability bar, the repair cost from `ctx.loot.getRepairCost`, a `수리` button → `ctx.inventory.repairWeapon`,
 * and `모두 수리`. Same pointer-lock etiquette + `'hub'` blocker token as `HubMenu`; emits `hub:workbenchToggled`.
 * Everything is null-guarded against `ctx.inventory` / `ctx.loot` (built by other folders).
 */
export class WorkbenchMenu {
  readonly root: HTMLElement;
  private frame: HTMLElement;
  private unsubs: Array<() => void> = [];
  private _open = false;

  private mats: HTMLElement;
  private list: HTMLElement;
  private empty: HTMLElement;
  private btnAll: HTMLButtonElement;
  private hint: HTMLElement;
  private hintTimer = 0;

  constructor(private readonly ctx: GameContext, private readonly host: WorkbenchMenuHost) {
    const root = this.root = el('div', { cls: 'menu hub-menu workbench interactive', parent: ctx.uiRoot });
    root.hidden = true;
    el('div', { cls: 'scan', parent: root });
    const f = this.frame = el('div', { cls: 'frame', parent: root });

    const head = el('div', { cls: 'hub-head', parent: f });
    const hl = el('div', { cls: 'hl', parent: head });
    el('div', { cls: 'title', text: '정비 벤치', parent: hl });
    el('div', { cls: 'subtitle', text: '무기 내구도 수리', parent: hl });
    this.mats = el('div', { cls: 'wb-mats', text: '', parent: head });

    const sec = el('div', { cls: 'hub-section', parent: f });
    el('div', { cls: 'ui-label', text: '보유 무기', parent: sec });
    this.list = el('div', { cls: 'wb-list', parent: sec });
    this.empty = el('div', { cls: 'wb-empty', text: '정비할 무기가 없습니다', parent: sec });
    this.empty.hidden = true;
    this.hint = el('div', { cls: 'form-msg', parent: f });
    this.hint.hidden = true;

    const foot = el('div', { cls: 'hub-foot', parent: f });
    this.button(foot, '닫기', () => this.close());
    this.btnAll = this.button(foot, '모두 수리', () => this.repairAll(), 'primary');

    root.addEventListener('mousedown', (e) => e.stopPropagation());   // keep clicks off the canvas' click-to-lock fallback

    const b = ctx.bus;
    this.unsubs.push(
      b.on('inventory:itemUpdated', () => this.render()),
      b.on('inventory:changed', () => this.render()),
      b.on('loadout:changed', () => this.render()),
    );
  }

  get isOpen(): boolean { return this._open; }

  /* ── open / close ─────────────────────────────────────────────────────── */
  open(): void {
    if (this._open) return;
    this._open = true;
    this.ctx.uiBlockers.add('hub');            // before the lock exits (GameFlow / hub pointer-lock etiquette)
    this.ctx.input.exitPointerLock();
    this.root.hidden = false;
    this.frame.style.animation = 'none';
    void this.frame.offsetWidth;
    this.frame.style.animation = '';
    this.hint.hidden = true;
    this.render();
    this.ctx.bus.emit('hub:workbenchToggled', { open: true });
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
  }

  close(relock = true): void {
    if (!this._open) return;
    this._open = false;
    this.root.hidden = true;
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.ctx.uiBlockers.delete('hub');
    this.ctx.bus.emit('hub:workbenchToggled', { open: false });
    if (relock) this.host.onClosed();
  }

  /* ── data ─────────────────────────────────────────────────────────────── */
  private isWeapon(inst: ItemInstance | null | undefined): inst is ItemInstance {
    if (!inst) return false;
    const def = this.ctx.inventory?.getDef(inst.defId) ?? this.ctx.loot?.getItemDef(inst.defId);
    return !!def?.weaponId;
  }

  private collectRows(): WeaponRow[] {
    const inv = this.ctx.inventory;
    if (!inv) return [];
    const rows: WeaponRow[] = [];
    const seen = new Set<string>();
    const lo = inv.getLoadout();
    const slots: Array<Exclude<LoadoutSlot, 'bag'>> = ['primary', 'primary2', 'secondary'];
    for (const s of slots) {
      const inst = lo[s];
      if (this.isWeapon(inst) && !seen.has(inst.uid)) { seen.add(inst.uid); rows.push({ uid: inst.uid, inst, slotLabel: SLOT_LABEL[s] }); }
    }
    for (const inst of inv.getAllItems()) {
      if (this.isWeapon(inst) && !seen.has(inst.uid)) { seen.add(inst.uid); rows.push({ uid: inst.uid, inst, slotLabel: '가방' }); }
    }
    return rows;
  }

  private itemName(inst: ItemInstance): string {
    const def = this.ctx.inventory?.getDef(inst.defId) ?? this.ctx.loot?.getItemDef(inst.defId);
    return def?.name ?? inst.defId;
  }

  private maxDurability(inst: ItemInstance): number {
    const loot = this.ctx.loot;
    const stats = loot && typeof loot.getEffectiveStats === 'function' ? loot.getEffectiveStats(inst) : null;
    if (stats?.maxDurability) return stats.maxDurability;
    const def = this.ctx.inventory?.getDef(inst.defId) ?? loot?.getItemDef(inst.defId);
    const w = def?.weaponId ? loot?.getWeaponDef(def.weaponId) : undefined;
    return w?.maxDurability ?? WEAPON_DEFAULT_DURABILITY;
  }

  private repairCost(inst: ItemInstance): RepairCost[] {
    const loot = this.ctx.loot;
    if (!loot || typeof loot.getRepairCost !== 'function') return [];
    try { return loot.getRepairCost(inst) ?? []; } catch { return []; }
  }

  private countOf(defId: string): number {
    return this.ctx.inventory?.countWhere((d) => d.id === defId) ?? 0;
  }

  private matName(defId: string): string {
    const def = this.ctx.inventory?.getDef(defId) ?? this.ctx.loot?.getItemDef(defId);
    return def?.name ?? MAT_NAME_FALLBACK[defId] ?? defId;
  }

  private affordable(cost: RepairCost[]): boolean {
    for (const c of cost) if (this.countOf(c.defId) < c.qty) return false;
    return true;
  }

  private costText(cost: RepairCost[]): string {
    if (cost.length === 0) return '정비 완료';
    return cost.map((c) => `${this.matName(c.defId)} ×${c.qty}`).join(' · ');
  }

  /* ── actions ──────────────────────────────────────────────────────────── */
  private tryRepair(uid: string): boolean {
    const inv = this.ctx.inventory;
    if (!inv || typeof inv.repairWeapon !== 'function') return false;
    try { return !!inv.repairWeapon(uid); } catch { return false; }
  }

  private repairOne(uid: string): void {
    const ok = this.tryRepair(uid);
    this.ctx.bus.emit('audio:play', { id: ok ? 'ui_equip' : 'ui_deny' });
    this.showHint(ok ? '수리 완료' : '재료가 부족합니다', ok ? 'success' : 'danger');
    this.render();
  }

  /** Repair every weapon in row order while the materials last. */
  private repairAll(): void {
    let done = 0, skipped = 0;
    for (const row of this.collectRows()) {
      const cost = this.repairCost(row.inst);
      if (cost.length === 0) continue;
      if (!this.affordable(cost)) { skipped++; continue; }
      if (this.tryRepair(row.uid)) done++; else skipped++;
    }
    this.ctx.bus.emit('audio:play', { id: done > 0 ? 'ui_equip' : 'ui_deny' });
    this.showHint(done > 0 ? `${done}정 수리 완료${skipped > 0 ? ` · ${skipped}정 재료 부족` : ''}` : skipped > 0 ? '재료가 부족합니다' : '정비할 무기가 없습니다', done > 0 ? 'success' : 'warning');
    this.render();
  }

  /* ── state → DOM ──────────────────────────────────────────────────────── */
  render(): void {
    if (!this._open) return;
    const rows = this.collectRows();
    setText(this.mats, `${this.matName(SCRAP_ID)} ${this.countOf(SCRAP_ID)} · ${this.matName(ALLOY_ID)} ${this.countOf(ALLOY_ID)}`);

    this.list.replaceChildren();
    this.empty.hidden = rows.length > 0;
    let anyAffordable = false;
    for (const row of rows) {
      const inst = row.inst;
      const max = Math.max(1, this.maxDurability(inst));
      const cur = Math.max(0, Math.min(max, inst.durability ?? max));
      const frac = cur / max;
      const cost = this.repairCost(inst);
      const canPay = cost.length > 0 && this.affordable(cost);
      anyAffordable ||= canPay;

      const r = el('div', { cls: 'wb-row', parent: this.list });
      toggleClass(r, 'broken', cur <= 0);
      toggleClass(r, 'full', cost.length === 0);
      el('div', { cls: 'slot', text: row.slotLabel, parent: r });
      const mid = el('div', { cls: 'mid', parent: r });
      const nameLine = el('div', { cls: 'name-line', parent: mid });
      el('div', { cls: 'name', text: this.itemName(inst), parent: nameLine });
      if (cur <= 0) el('div', { cls: 'tag', text: '파손', parent: nameLine });
      const bar = el('div', { cls: 'dur', parent: mid });
      const fill = el('i', { parent: bar });
      fill.style.transform = `scaleX(${frac.toFixed(3)})`;
      bar.className = `dur ${frac > 0.5 ? 'ok' : frac > 0.2 ? 'warn' : 'low'}`;
      el('div', { cls: 'dur-text', text: `${Math.round(cur)} / ${Math.round(max)}`, parent: mid });
      const cost_ = el('div', { cls: 'cost', text: this.costText(cost), parent: r });
      toggleClass(cost_, 'short', cost.length > 0 && !canPay);
      const btn = this.button(r, '수리', () => this.repairOne(row.uid));
      btn.disabled = !canPay;
      btn.title = cost.length === 0 ? '내구도가 가득 찼습니다' : canPay ? '' : '재료 부족';
    }
    this.btnAll.disabled = !anyAffordable;
  }

  private showHint(text: string, kind: 'info' | 'success' | 'warning' | 'danger'): void {
    this.hint.className = `form-msg ${kind}`;
    setText(this.hint, text);
    this.hint.hidden = false;
    this.hintTimer = performance.now() + 3500;
  }

  update(): void {
    if (this.hintTimer > 0 && !this.hint.hidden && performance.now() > this.hintTimer) { this.hint.hidden = true; this.hintTimer = 0; }
  }

  private button(parent: HTMLElement, label: string, onClick: () => void, extraCls = ''): HTMLButtonElement {
    const b = el('button', { cls: `ui-btn ${extraCls}`, text: label, parent });
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    if (this._open) this.ctx.uiBlockers.delete('hub');
    this.root.remove();
  }
}
