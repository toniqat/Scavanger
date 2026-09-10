import type { GameContext, ItemInstance } from '@/shared';
import { Keys, QUICK_SLOTS, QUICK_SLOT_DIRS, buildItemChip, isQuickSlotActive, keyLabel } from '@/shared';
import { el, setText, toggleClass } from '../dom';
import '../styles/raidHud.css';

/** Thumbnail edge in px (2026-09-10: 60 → 90 (1.5배) → 54 (그 0.6배, 2차 조정)). */
const THUMB = 54;

interface Cell {
  root: HTMLElement;
  body: HTMLElement;
  /** Keycap over the thumbnail — the live 빠른 사용 binding, not the wheel index (2026-09-10). */
  keyEl: HTMLElement;
  key: string;
}

/**
 * 빠른 사용 thumbnail (`.qstrip`, gameplay layer) — sits on the right **above the weapon slot strip**.
 *
 * 2026-09-07: it used to draw one tile per **unlocked** wheel slot, which grew to a ~300 px row on an 8-slot bag.
 * It now shows a **single** cell — the wheel slot the player last selected (`quick:equipped`, else `quick:used`,
 * else the first filled slot). The cell is lit (`.is-hand`) while that item is actually in the hands; the whole
 * widget hides when the wheel is empty.
 *
 * 2026-09-10 (레이드 HUD 개편, 사용자 결정): 칸 번호 대신 **빠른 사용 키**를 단다 (`.qs-key.keycap`).
 * 키 문자열은 하드코딩하지 않는다 — `keyLabel(Keys.QUICK)` 을 쓰고 `input:bindingsChanged` 에 다시
 * 읽는다 (리바인딩 규약). 썸네일은 1.5배(60 → 90 px)로 키웠다가 **그 0.6배(54 px)** 로 되돌렸다 —
 * `THUMB` 와 `styles/raidHud.css` 의 `.qs-body` 를 **같이** 고친다 (칩 크기와 칸 크기가 따로 논다).
 *
 * Data: `inventory:quickSlotsChanged` (seeded from `ctx.inventory.getQuickSlots()`), counts from `quick:used` /
 * `inventory:itemUpdated`, unlock count from `ctx.inventory.getBagSize().quickSlots` (`inventory:bagChanged`).
 */
export class QuickStrip {
  readonly root: HTMLElement;
  private cells: Cell[] = [];
  private slots: (ItemInstance | null)[] = new Array(QUICK_SLOTS).fill(null);
  private active = 0;
  private handUid = '';
  /** Wheel index the player last selected / used; the only one drawn. */
  private selected: number | null = null;
  private ctx: GameContext | null = null;
  private dirty = true;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'qstrip is-single', parent });
    this.root.hidden = true;
    for (let i = 0; i < QUICK_SLOTS; i++) {
      const root = el('div', { cls: 'qs-cell empty', parent: this.root, attrs: { 'data-dir': QUICK_SLOT_DIRS[i] } });
      root.hidden = true;
      const keyEl = el('span', { cls: 'qs-key keycap', text: keyLabel(Keys.QUICK), parent: root });
      const body = el('div', { cls: 'qs-body', parent: root });
      this.cells.push({ root, body, keyEl, key: '' });
    }
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    const b = ctx.bus;
    const touch = (): void => { this.dirty = true; };
    this.unsubs.push(
      b.on('input:bindingsChanged', () => { for (const c of this.cells) setText(c.keyEl, keyLabel(Keys.QUICK)); }),
      b.on('inventory:quickSlotsChanged', ({ slots }) => { this.slots = [...slots]; this.dirty = true; }),
      b.on('inventory:bagChanged', touch),
      b.on('inventory:itemUpdated', touch),
      b.on('inventory:changed', touch),
      b.on('loadout:changed', touch),
      b.on('quick:used', ({ index }) => { this.selected = index; this.dirty = true; }),
      b.on('quick:equipped', ({ index, item }) => {
        this.handUid = item?.uid ?? '';
        // an unequip (`item: null`) keeps the selection so the widget does not blink out when the gun comes back
        if (index !== null) this.selected = index;
        this.dirty = true;
      }),
      b.on('world:ready', () => { this.pull(); this.dirty = true; }),
      b.on('game:newMission', () => { this.handUid = ''; this.selected = null; this.dirty = true; }),
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

    const shownIndex = this.pickIndex(inv);
    let visible = false;
    for (let i = 0; i < QUICK_SLOTS; i++) {
      const cell = this.cells[i];
      const on = i === shownIndex;
      if (cell.root.hidden === on) cell.root.hidden = !on;
      if (!on) { cell.key = ''; continue; }
      const uid = this.slots[i]?.uid ?? '';
      const inst = uid ? inv.findItem(uid) ?? this.slots[i] : null;
      if (!inst) { cell.root.hidden = true; cell.key = ''; continue; }
      visible = true;
      const key = `${inst.defId}|${inst.qty}|${this.handUid === inst.uid ? 1 : 0}`;
      if (key === cell.key) continue;
      cell.key = key;
      cell.body.replaceChildren();
      const def = inv.getDef(inst.defId) ?? this.ctx?.loot?.getItemDef(inst.defId);
      cell.body.appendChild(buildItemChip(def, { size: THUMB, need: inst.qty > 1 ? inst.qty : undefined }));
      toggleClass(cell.root, 'empty', false);
      toggleClass(cell.root, 'is-hand', inst.uid === this.handUid);
    }
    if (this.root.hidden === visible) this.root.hidden = !visible;
  }

  /**
   * Wheel index to draw: the last selected slot while it is unlocked and filled, else the first unlocked slot that
   * holds something (so a fresh mission shows the starter grenade before anything has been picked).
   */
  private pickIndex(inv: NonNullable<GameContext['inventory']>): number | null {
    const filled = (i: number): boolean => {
      if (!isQuickSlotActive(i, this.active)) return false;
      const uid = this.slots[i]?.uid ?? '';
      return !!uid && !!(inv.findItem(uid) ?? this.slots[i]);
    };
    if (this.selected !== null && filled(this.selected)) return this.selected;
    for (let i = 0; i < QUICK_SLOTS; i++) if (filled(i)) return i;
    return null;
  }

  /** Tiles currently rendered with an item (debug). */
  get filledCount(): number { return this.cells.filter((c) => !c.root.hidden && !c.root.classList.contains('empty')).length; }
  /** Whether the strip is showing (debug). */
  get isShowing(): boolean { return !this.root.hidden; }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
