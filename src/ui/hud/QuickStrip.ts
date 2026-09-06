import type { GameContext, ItemInstance } from '@/shared';
import { QUICK_SLOTS, QUICK_SLOT_DIRS, buildItemChip, isQuickSlotActive } from '@/shared';
import { el, toggleClass } from '../dom';

/** Arrow glyph per wheel direction (`QUICK_SLOT_DIRS` order), so a tile reads as its wheel sector at a glance. */
const DIR_GLYPH: readonly string[] = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];

interface Cell {
  root: HTMLElement;
  body: HTMLElement;
  dir: HTMLElement;
  key: string;
}

/**
 * 빠른 사용 thumbnail strip (`.qstrip`, gameplay layer, Phase 9 UI pass) — the row of item thumbnails that sits on the
 * right **above the weapon slot strip**, so the wheel's contents are readable without holding `Keys.QUICK`.
 *
 * One tile per **unlocked** wheel slot (`isQuickSlotActive` against the equipped bag's `quickSlots`), in wheel order,
 * each showing the direction arrow plus the shared item chip (`buildItemChip` — the same thumbnail every cost row and
 * catalogue card draws, so it also picks up the `ui/hud/ItemTip` hover card). An empty slot is a dim placeholder so
 * the tiles never move under the player's eye; the item currently in hand is lit (`.is-hand`, from `quick:equipped`).
 *
 * Data: `inventory:quickSlotsChanged` (seeded from `ctx.inventory.getQuickSlots()`), counts from `quick:used` /
 * `inventory:itemUpdated`, unlock count from `ctx.inventory.getBagSize().quickSlots` (`inventory:bagChanged`).
 * The whole strip hides while no slot is unlocked and while the player has nothing in any of them.
 */
export class QuickStrip {
  readonly root: HTMLElement;
  private cells: Cell[] = [];
  private slots: (ItemInstance | null)[] = new Array(QUICK_SLOTS).fill(null);
  private active = 0;
  private handUid = '';
  private ctx: GameContext | null = null;
  private dirty = true;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'qstrip', parent });
    this.root.hidden = true;
    for (let i = 0; i < QUICK_SLOTS; i++) {
      const root = el('div', { cls: 'qs-cell empty', parent: this.root, attrs: { 'data-dir': QUICK_SLOT_DIRS[i] } });
      root.hidden = true;
      const dir = el('span', { cls: 'qs-dir', text: DIR_GLYPH[i] ?? '·', parent: root });
      const body = el('div', { cls: 'qs-body', parent: root });
      this.cells.push({ root, body, dir, key: '' });
    }
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    const b = ctx.bus;
    const touch = (): void => { this.dirty = true; };
    this.unsubs.push(
      b.on('inventory:quickSlotsChanged', ({ slots }) => { this.slots = [...slots]; this.dirty = true; }),
      b.on('inventory:bagChanged', touch),
      b.on('inventory:itemUpdated', touch),
      b.on('inventory:changed', touch),
      b.on('loadout:changed', touch),
      b.on('quick:used', touch),
      b.on('quick:equipped', ({ item }) => { this.handUid = item?.uid ?? ''; this.dirty = true; }),
      b.on('world:ready', () => { this.pull(); this.dirty = true; }),
      b.on('game:newMission', () => { this.handUid = ''; this.dirty = true; }),
    );
    this.pull();
  }

  /** Seed / re-read the wheel straight from inventory (the events only carry deltas). */
  private pull(): void {
    const inv = this.ctx?.inventory;
    if (!inv) return;
    try { this.slots = [...inv.getQuickSlots()]; } catch { /* inventory not ready */ }
  }

  /** Repaints only when something actually changed; the DOM writes are per-cell keyed. */
  update(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const inv = this.ctx?.inventory;
    if (!inv) return;
    this.pull();
    try { this.active = inv.getBagSize().quickSlots; } catch { this.active = 0; }

    let shown = 0, filled = 0;
    for (let i = 0; i < QUICK_SLOTS; i++) {
      const cell = this.cells[i];
      const on = isQuickSlotActive(i, this.active);
      if (cell.root.hidden === on) cell.root.hidden = !on;
      if (!on) { cell.key = ''; continue; }
      shown++;
      const uid = this.slots[i]?.uid ?? '';
      const inst = uid ? inv.findItem(uid) ?? this.slots[i] : null;
      if (inst) filled++;
      const key = inst ? `${inst.defId}|${inst.qty}|${this.handUid === inst.uid ? 1 : 0}` : '-';
      if (key === cell.key) continue;
      cell.key = key;
      cell.body.replaceChildren();
      if (inst) {
        const def = inv.getDef(inst.defId) ?? this.ctx?.loot?.getItemDef(inst.defId);
        cell.body.appendChild(buildItemChip(def, { size: 30, need: inst.qty > 1 ? inst.qty : undefined }));
      }
      toggleClass(cell.root, 'empty', !inst);
      toggleClass(cell.root, 'is-hand', !!inst && inst.uid === this.handUid);
    }
    const visible = shown > 0 && filled > 0;
    if (this.root.hidden === visible) this.root.hidden = !visible;
  }

  /** Tiles currently rendered with an item (debug). */
  get filledCount(): number { return this.cells.filter((c) => !c.root.hidden && !c.root.classList.contains('empty')).length; }
  /** Whether the strip is showing (debug). */
  get isShowing(): boolean { return !this.root.hidden; }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
