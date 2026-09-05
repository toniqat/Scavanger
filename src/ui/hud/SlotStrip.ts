import type { GameContext, ItemInstance, WeaponSlot } from '@/shared';
import { el, setText, toggleClass } from '../dom';

/** Slot order = key order: 1 주무기 I, 2 주무기 II, 3 보조무기. */
export const WEAPON_SLOTS: readonly WeaponSlot[] = ['primary', 'primary2', 'secondary'];
export const WEAPON_SLOT_KEY: Readonly<Record<WeaponSlot, string>> = { primary: '1', primary2: '2', secondary: '3' };
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
  private cells: Record<WeaponSlot, { root: HTMLElement; name: HTMLElement }>;
  private quickCell: { root: HTMLElement; name: HTMLElement };
  private quickUid = '';
  private quickActive = false;
  private active: WeaponSlot = 'primary';
  private ctx: GameContext | null = null;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'wslots', parent });
    const make = (slot: WeaponSlot | 'quick', key: string) => {
      const root = el('div', { cls: `wslot empty ${slot}`, parent: this.root });
      el('span', { cls: 'k', text: key, parent: root });
      const name = el('span', { cls: 'n', text: '—', parent: root });
      return { root, name };
    };
    this.cells = { primary: make('primary', WEAPON_SLOT_KEY.primary), primary2: make('primary2', WEAPON_SLOT_KEY.primary2), secondary: make('secondary', WEAPON_SLOT_KEY.secondary) };
    this.quickCell = make('quick', 'F');
    this.setActive('primary');
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    const b = ctx.bus;
    this.unsubs.push(
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
    for (const s of WEAPON_SLOTS) toggleClass(this.cells[s].root, 'active', s === slot && !this.quickActive);
  }

  /** Highlight the `F` cell (consumable in hand) instead of the weapon cell, or hand the highlight back. */
  private setQuickActive(on: boolean): void {
    this.quickActive = on;
    toggleClass(this.quickCell.root, 'active', on);
    for (const s of WEAPON_SLOTS) toggleClass(this.cells[s].root, 'active', s === this.active && !on);
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
