import type { GameContext, ItemInstance } from '@/shared';
import { QUICK_SLOT_KEYS } from '@/shared';
import { el, setText, toggleClass } from '../dom';

const MAX_SLOTS = QUICK_SLOT_KEYS.length;   // 8 (tactical backpack); normal backpacks light up the first 4
const POLL_INTERVAL = 0.15;                 // seconds between inventory polls
const USE_FLASH = 0.45;                     // seconds a used slot stays dimmed

const keyLabel = (code: string): string => code.replace('Digit', '').replace('Key', '');

interface Slot {
  el: HTMLElement;
  ico: HTMLElement;
  qty: HTMLElement;
  name: HTMLElement;
  key: string;
  flash: number;
}

/**
 * Bottom-center quick-use bar. Slot count is whatever `ctx.inventory.getQuickSlots()` reports (4 normally,
 * 8 with the tactical backpack); the widget hides itself when the inventory has no quick slots yet.
 * Fed by `quickbar:changed` / `quickbar:used` and re-polled a few times a second so equipment swaps land.
 */
export class QuickBar {
  readonly root: HTMLElement;
  private slots: Slot[] = [];
  private shown = 0;
  private poll = 0;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'quickbar', parent });
    this.root.hidden = true;
    for (let i = 0; i < MAX_SLOTS; i++) {
      const s = el('div', { cls: 'qslot empty', parent: this.root });
      s.hidden = true;
      el('span', { cls: 'k', text: keyLabel(QUICK_SLOT_KEYS[i] ?? String(i)), parent: s });
      const ico = el('span', { cls: 'ico', text: '', parent: s });
      const qty = el('span', { cls: 'qty ui-mono', text: '', parent: s });
      const name = el('span', { cls: 'nm', text: '', parent: s });
      this.slots.push({ el: s, ico, qty, name, key: '', flash: 0 });
    }
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('quickbar:changed', ({ slots }) => this.render(ctx, slots)),
      b.on('quickbar:used', ({ index }) => {
        const s = this.slots[index];
        if (!s) return;
        s.flash = USE_FLASH;
        s.el.classList.remove('used');
        void s.el.offsetWidth;
        s.el.classList.add('used');
      }),
      b.on('game:newMission', () => { this.poll = 0; }),
      b.on('equip:changed', () => { this.poll = 0; }),
      b.on('loadout:changed', () => { this.poll = 0; }),
    );
  }

  update(dt: number, ctx: GameContext): void {
    this.poll -= dt;
    if (this.poll <= 0) {
      this.poll = POLL_INTERVAL;
      const qs = ctx.inventory?.getQuickSlots?.();
      if (qs) this.render(ctx, qs.map((s) => s.item));
      else if (!this.root.hidden) this.root.hidden = true;
    }
    for (const s of this.slots) {
      if (s.flash > 0) {
        s.flash -= dt;
        if (s.flash <= 0) s.el.classList.remove('used');
      }
    }
  }

  private render(ctx: GameContext, items: readonly (ItemInstance | null)[]): void {
    const n = Math.min(MAX_SLOTS, items.length);
    if (n <= 0) { if (!this.root.hidden) this.root.hidden = true; return; }
    if (this.root.hidden) this.root.hidden = false;
    if (n !== this.shown) {
      this.shown = n;
      for (let i = 0; i < MAX_SLOTS; i++) this.slots[i].el.hidden = i >= n;
      toggleClass(this.root, 'wide', n > 4);
    }
    for (let i = 0; i < n; i++) {
      const s = this.slots[i];
      const item = items[i] ?? null;
      const def = item ? (ctx.loot?.getItemDef(item.defId) ?? ctx.inventory?.getDef(item.defId) ?? null) : null;
      const key = item ? `${item.defId}|${item.qty}` : '';
      if (key === s.key) continue;
      s.key = key;
      toggleClass(s.el, 'empty', !item);
      setText(s.ico, def?.icon ?? (item ? '?' : ''));
      s.ico.style.color = def?.color ?? '';
      setText(s.qty, item && item.qty > 1 ? `${item.qty}` : '');
      setText(s.name, def?.name ?? '');
    }
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.root.remove();
  }
}
