import type { ItemDef, QuickSlot } from '@/shared';
import { QUICK_SLOT_KEYS } from '@/shared';
import { TEXT } from './labels';

export interface QuickBarHandlers {
  /** Cell rect probing for drag targeting. */
  onClear(index: number): void;
  onUse(index: number): void;
}

const KEY_LABEL = (i: number): string => (QUICK_SLOT_KEYS[i] ?? '').replace('Digit', '');

/**
 * Quick-use strip under the bag grid. Slots hold a *reference* to a bag item (the item never leaves the
 * grid), so this view only paints icon + qty + key hint. Items are assigned by dragging onto a cell;
 * right-click clears, left-click fires the slot.
 */
export class QuickBarView {
  readonly el: HTMLElement;
  private strip: HTMLElement;
  private cells: HTMLElement[] = [];
  private count = 0;

  constructor(private readonly handlers: QuickBarHandlers) {
    this.el = document.createElement('div');
    this.el.className = 'inv-quickbar';
    const label = document.createElement('div');
    label.className = 'inv-eyebrow inv-quickbar-label';
    label.textContent = TEXT.quickBar;
    const strip = document.createElement('div');
    strip.className = 'inv-quick-cells';
    this.strip = strip;
    this.el.append(label, strip);
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Rebuild the cells when the slot count changes (backpack swap), then repaint contents. */
  render(slots: readonly QuickSlot[], getDef: (id: string) => ItemDef | undefined): void {
    if (slots.length !== this.count) {
      this.count = slots.length;
      this.strip.innerHTML = '';
      this.cells = [];
      for (let i = 0; i < slots.length; i++) {
        const cell = document.createElement('div');
        cell.className = 'inv-quick-cell';
        cell.dataset.index = String(i);
        const key = document.createElement('kbd');
        key.className = 'inv-quick-key';
        key.textContent = KEY_LABEL(i);
        const body = document.createElement('div');
        body.className = 'inv-quick-body';
        cell.append(key, body);
        cell.addEventListener('pointerdown', (e) => {
          if (e.button === 2) { e.preventDefault(); this.handlers.onClear(i); }
          else if (e.button === 0) { e.preventDefault(); this.handlers.onUse(i); }
        });
        this.strip.appendChild(cell);
        this.cells.push(cell);
      }
      this.el.hidden = slots.length === 0;
    }
    for (let i = 0; i < slots.length; i++) {
      const cell = this.cells[i];
      const body = cell.querySelector<HTMLElement>('.inv-quick-body');
      if (!body) continue;
      const item = slots[i].item;
      const def = item ? getDef(item.defId) : undefined;
      cell.classList.toggle('is-filled', !!def);
      if (item && def) {
        cell.style.setProperty('--rc', def.color);
        body.innerHTML = '';
        const icon = document.createElement('span');
        icon.className = 'inv-quick-icon';
        icon.textContent = def.icon;
        body.appendChild(icon);
        if (def.stackMax > 1) {
          const qty = document.createElement('span');
          qty.className = 'inv-quick-qty';
          qty.textContent = String(item.qty);
          body.appendChild(qty);
        }
        cell.title = def.name;
      } else {
        cell.style.removeProperty('--rc');
        body.innerHTML = '';
        cell.title = TEXT.quickHint;
      }
    }
  }

  /** Index of the cell under a client-space point, or null. */
  indexAt(x: number, y: number): number | null {
    for (let i = 0; i < this.cells.length; i++) {
      const r = this.cells[i].getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return i;
    }
    return null;
  }

  setTarget(index: number | null, bad: boolean): void {
    for (let i = 0; i < this.cells.length; i++) {
      this.cells[i].classList.toggle('is-target-ok', i === index && !bad);
      this.cells[i].classList.toggle('is-target-bad', i === index && bad);
    }
  }

  clearTargets(): void { this.setTarget(null, false); }

  dispose(): void { this.el.remove(); }
}
