import type { GameContext, ItemInstance, WeaponSlot } from '@/shared';
import { Keys, keyLabel } from '@/shared';
import { el, setText, toggleClass } from '../dom';

/**
 * Slot order = key order: 1 주무기 I, 2 주무기 II.
 * 2026-09-10: 보조무기(3번) 칸이 없어졌다 — `WeaponSlot` 에는 남아 있지만 이 목록에 없으므로 칸도 그려지지 않는다.
 */
export const WEAPON_SLOTS: readonly WeaponSlot[] = ['primary', 'primary2'];
/** Live key labels of the weapon slots (rebindable — read at use time). */
export function weaponSlotKey(slot: WeaponSlot): string {
  return keyLabel(slot === 'primary' ? Keys.PRIMARY : slot === 'primary2' ? Keys.PRIMARY2 : Keys.SECONDARY);
}
export const WEAPON_SLOT_LABEL_KO: Readonly<Record<WeaponSlot, string>> = { primary: '주무기 I', primary2: '주무기 II', secondary: '보조' };

/**
 * Short display name for a weapon item: model code (`AR-23`) plus the grade numeral when the name ends with one
 * (`AR-23 리버레이터 III` → `AR-23 III`). Falls back to the full name.
 */
export function weaponShortName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length <= 1) return name;
  const last = parts[parts.length - 1];
  return /^[IVX]+$/.test(last) ? `${parts[0]} ${last}` : parts[0];
}

/**
 * Four-cell strip (`.wslots`) listing the weapon slots with their short names (`—` when empty) plus an `F` cell
 * (`.wslot.quick`) for the quick-use item in hand (last `quick:equipped` item, `—` when none / used up); the active cell
 * is highlighted (`weapon:equipped.slot`, or the `F` cell while a consumable is in hand), a slot whose weapon has 0
 * durability gets `.broken`. Names are refreshed on `loadout:changed` / `weapon:equipped` / `inventory:itemUpdated`.
 */
export class SlotStrip {
  readonly root: HTMLElement;
  /** Partial: only the slots in `WEAPON_SLOTS` get a cell (보조무기는 없다, 2026-09-10). */
  private cells: Partial<Record<WeaponSlot, { root: HTMLElement; name: HTMLElement; k: HTMLElement }>>;
  private quickCell: { root: HTMLElement; name: HTMLElement; k: HTMLElement };
  private quickUid = '';
  private quickActive = false;
  private active: WeaponSlot = 'primary';
  private ctx: GameContext | null = null;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'wslots', parent });
    const make = (slot: WeaponSlot | 'quick', key: string) => {
      const root = el('div', { cls: `wslot empty ${slot}`, parent: this.root });
      const k = el('span', { cls: 'k', text: key, parent: root });
      const name = el('span', { cls: 'n', text: '—', parent: root });
      return { root, name, k };
    };
    this.cells = {};
    for (const slot of WEAPON_SLOTS) this.cells[slot] = make(slot, weaponSlotKey(slot));
    this.quickCell = make('quick', keyLabel(Keys.QUICK));
    this.setActive('primary');
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    const b = ctx.bus;
    this.unsubs.push(
      b.on('input:bindingsChanged', () => {
        for (const slot of WEAPON_SLOTS) { const c = this.cells[slot]; if (c) setText(c.k, weaponSlotKey(slot)); }
        setText(this.quickCell.k, keyLabel(Keys.QUICK));
      }),
      b.on('loadout:changed', (lo) => {
        for (const slot of WEAPON_SLOTS) this.setCell(slot, lo[slot]);
      }),
      b.on('weapon:equipped', ({ slot }) => {
        this.setQuickActive(false);
        this.setActive(slot);
        this.refreshFromInventory();
      }),
      b.on('quick:equipped', ({ item }) => {
        if (item) { this.quickUid = item.uid; this.setQuickCell(item); }
        this.setQuickActive(!!item);
      }),
      b.on('quick:used', ({ item, remaining }) => {
        if (item.uid !== this.quickUid) return;
        if (remaining <= 0) { this.quickUid = ''; this.setQuickCell(null); }
        else this.setQuickCell(item);
      }),
      b.on('inventory:quickSlotsChanged', ({ slots }) => {
        if (this.quickUid && !slots.some((s) => s?.uid === this.quickUid)) { this.quickUid = ''; this.setQuickCell(null); }
      }),
      b.on('inventory:itemUpdated', () => this.refreshFromInventory()),
      b.on('weapon:durabilityChanged', () => this.refreshFromInventory()),
      b.on('weapon:broken', () => this.refreshFromInventory()),
      b.on('game:newMission', () => this.refreshFromInventory()),
    );
    this.refreshFromInventory();
  }

  get activeSlot(): WeaponSlot { return this.active; }

  private refreshFromInventory(): void {
    const lo = this.ctx?.inventory?.getLoadout();
    if (!lo) return;
    for (const slot of WEAPON_SLOTS) this.setCell(slot, lo[slot]);
  }

  private setActive(slot: WeaponSlot): void {
    this.active = slot;
    for (const s of WEAPON_SLOTS) { const c = this.cells[s]; if (c) toggleClass(c.root, 'active', s === slot && !this.quickActive); }
  }

  /** Highlight the `F` cell (consumable in hand) instead of the weapon cell, or hand the highlight back. */
  private setQuickActive(on: boolean): void {
    this.quickActive = on;
    toggleClass(this.quickCell.root, 'active', on);
    for (const s of WEAPON_SLOTS) { const c = this.cells[s]; if (c) toggleClass(c.root, 'active', s === this.active && !on); }
  }

  private setQuickCell(inst: ItemInstance | null): void {
    const cell = this.quickCell;
    if (!inst) {
      setText(cell.name, '—');
      cell.root.classList.add('empty');
      cell.root.removeAttribute('title');
      return;
    }
    const def = this.ctx?.inventory?.getDef(inst.defId) ?? this.ctx?.loot?.getItemDef(inst.defId);
    const name = def?.name ?? inst.defId;
    setText(cell.name, inst.qty > 1 ? `${name} ×${inst.qty}` : name);
    if (cell.root.getAttribute('title') !== name) cell.root.setAttribute('title', name);
    cell.root.classList.remove('empty');
  }

  private setCell(slot: WeaponSlot, inst: ItemInstance | null): void {
    const cell = this.cells[slot];
    if (!cell) return;   // 보조무기처럼 칸이 없는 슬롯
    if (!inst) {
      setText(cell.name, '—');
      cell.root.classList.add('empty');
      cell.root.classList.remove('broken');
      cell.root.removeAttribute('title');
      return;
    }
    const def = this.ctx?.loot?.getItemDef(inst.defId);
    const full = def?.name ?? inst.defId;
    setText(cell.name, weaponShortName(full));
    if (cell.root.getAttribute('title') !== full) cell.root.setAttribute('title', full);
    cell.root.classList.remove('empty');
    toggleClass(cell.root, 'broken', inst.durability !== undefined && inst.durability <= 0);
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
