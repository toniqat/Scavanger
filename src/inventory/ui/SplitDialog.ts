import type { ItemDef, ItemInstance } from '@/shared';
import { TEXT } from './labels';

/**
 * Inline "수량 지정" modal: number input + slider over 1..qty-1, 확인/취소, Enter/Escape.
 * `onConfirm(qty)` runs once with a validated quantity; the owner performs the split.
 */
export class SplitDialog {
  readonly el: HTMLElement;
  private _open = false;
  private input!: HTMLInputElement;
  private range!: HTMLInputElement;
  private title!: HTMLElement;
  private keepEl!: HTMLElement;
  private takeEl!: HTMLElement;
  private max = 1;
  private onConfirm: ((qty: number) => void) | null = null;

  /** @param onToggle 2026-09-09: open / close report for the window's 키 가이드 (the dialog has no bus of its own). */
  constructor(host: HTMLElement, private readonly onToggle: (open: boolean) => void = () => {}) {
    this.el = document.createElement('div');
    this.el.className = 'inv-dialog-backdrop';
    this.el.hidden = true;
    this.el.addEventListener('pointerdown', (e) => { if (e.target === this.el) this.close(); });
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());

    const box = document.createElement('div');
    box.className = 'inv-dialog';
    box.addEventListener('pointerdown', (e) => e.stopPropagation());

    const eyebrow = document.createElement('div');
    eyebrow.className = 'inv-eyebrow';
    eyebrow.textContent = 'SPLIT STACK';
    this.title = document.createElement('h3');
    this.title.className = 'inv-dialog-title';

    const row = document.createElement('div');
    row.className = 'inv-dialog-row';
    this.input = document.createElement('input');
    this.input.type = 'number';
    this.input.className = 'inv-dialog-input';
    this.input.min = '1';
    this.input.step = '1';
    this.input.inputMode = 'numeric';
    this.range = document.createElement('input');
    this.range.type = 'range';
    this.range.className = 'inv-dialog-range';
    this.range.min = '1';
    this.range.step = '1';
    row.append(this.range, this.input);

    const summary = document.createElement('div');
    summary.className = 'inv-dialog-summary';
    this.takeEl = document.createElement('span');
    this.keepEl = document.createElement('span');
    summary.append(this.takeEl, this.keepEl);

    const actions = document.createElement('div');
    actions.className = 'inv-dialog-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'inv-btn';
    cancel.textContent = TEXT.split.cancel;
    cancel.addEventListener('click', () => this.close());
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'inv-btn is-primary';
    confirm.textContent = TEXT.split.confirm;
    confirm.addEventListener('click', () => this.confirm());
    actions.append(cancel, confirm);

    box.append(eyebrow, this.title, row, summary, actions);
    this.el.appendChild(box);
    host.appendChild(this.el);

    this.input.addEventListener('input', () => this.sync(this.input.valueAsNumber, 'input'));
    this.range.addEventListener('input', () => this.sync(this.range.valueAsNumber, 'range'));
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); this.confirm(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); }
    });
  }

  get isOpen(): boolean { return this._open; }

  open(item: ItemInstance, def: ItemDef, onConfirm: (qty: number) => void): void {
    if (def.stackMax <= 1 || item.qty < 2) return;
    this.max = item.qty - 1;
    this.onConfirm = onConfirm;
    this.title.textContent = `${def.name} · ${TEXT.split.title}`;
    this.input.max = String(this.max);
    this.range.max = String(this.max);
    this.sync(Math.max(1, Math.floor(item.qty / 2)), 'range');
    this.el.hidden = false;
    this._open = true;
    this.onToggle(true);
    requestAnimationFrame(() => { this.input.focus(); this.input.select(); });
  }

  /** Returns true when the dialog was actually open. */
  close(): boolean {
    if (!this._open) return false;
    this._open = false;
    this.onConfirm = null;
    this.el.hidden = true;
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.onToggle(false);
    return true;
  }

  dispose(): void {
    this.close();
    this.el.remove();
  }

  private current(): number {
    const v = Math.floor(this.input.valueAsNumber);
    if (!Number.isFinite(v)) return 1;
    return Math.min(this.max, Math.max(1, v));
  }

  private sync(v: number, source: 'input' | 'range'): void {
    const n = Number.isFinite(v) ? Math.min(this.max, Math.max(1, Math.floor(v))) : 1;
    if (source !== 'input' || this.input.value !== '') this.input.value = String(n);
    this.range.value = String(n);
    this.takeEl.textContent = `${TEXT.split.take} ${n}`;
    this.keepEl.textContent = `${TEXT.split.keep} ${this.max + 1 - n}`;
  }

  private confirm(): void {
    const cb = this.onConfirm;
    const qty = this.current();
    this.close();
    cb?.(qty);
  }
}
