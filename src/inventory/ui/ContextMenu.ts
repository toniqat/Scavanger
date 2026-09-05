export interface MenuEntry {
  label: string;
  /** Right-aligned shortcut hint (e.g. `X`). */
  hint?: string;
  /** Red styling for destructive actions. */
  danger?: boolean;
  /** Visual separator above this entry. */
  separator?: boolean;
  run(): void;
}

/**
 * Small right-click menu anchored at the cursor. Closes on selection, on any pointerdown outside it,
 * on Escape (via `close()` from the owner) and when the inventory hides.
 */
export class ContextMenu {
  readonly el: HTMLElement;
  private _open = false;
  private onOutside = (e: PointerEvent): void => {
    if (this._open && !this.el.contains(e.target as Node)) this.close();
  };

  constructor(private readonly host: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'inv-menu';
    this.el.hidden = true;
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    host.appendChild(this.el);
  }

  get isOpen(): boolean { return this._open; }

  open(x: number, y: number, entries: readonly MenuEntry[]): void {
    if (entries.length === 0) return;
    this.el.innerHTML = '';
    for (const entry of entries) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'inv-menu-item';
      if (entry.danger) b.classList.add('is-danger');
      if (entry.separator) b.classList.add('has-sep');
      const label = document.createElement('span');
      label.textContent = entry.label;
      b.appendChild(label);
      if (entry.hint) {
        const k = document.createElement('kbd');
        k.textContent = entry.hint;
        b.appendChild(k);
      }
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      b.addEventListener('click', (e) => { e.stopPropagation(); this.close(); entry.run(); });
      this.el.appendChild(b);
    }
    this.el.hidden = false;
    this._open = true;
    // Keep the menu inside the viewport.
    const r = this.el.getBoundingClientRect();
    const px = Math.min(x + 2, window.innerWidth - r.width - 8);
    const py = Math.min(y + 2, window.innerHeight - r.height - 8);
    this.el.style.transform = `translate(${Math.max(4, Math.round(px))}px, ${Math.max(4, Math.round(py))}px)`;
    this.host.addEventListener('pointerdown', this.onOutside, true);
  }

  /** Returns true when a menu was actually open. */
  close(): boolean {
    if (!this._open) return false;
    this._open = false;
    this.el.hidden = true;
    this.el.innerHTML = '';
    this.host.removeEventListener('pointerdown', this.onOutside, true);
    return true;
  }

  dispose(): void {
    this.close();
    this.el.remove();
  }
}
