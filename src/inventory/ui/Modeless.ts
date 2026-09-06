import { TEXT } from './labels';

/**
 * Phase 8 — **모달리스 팝업** shell shared by the 전술 임플란트 picker, the 필드 제작 panel and the 아이템 분해 dialog.
 *
 * A modeless popup is a child of the inventory window, floating above `.inv-layout` while the grid stays visible
 * *and interactive* behind it. It therefore:
 *   - adds **no** `ctx.uiBlockers` token and never touches the pointer lock (the window owns both), and
 *   - is dismissed by the window's existing Escape chain (`InventoryUI.closeOverlays()`) or by a pointerdown
 *     outside the panel (and outside its anchor, so a click on the opener toggles instead of double-firing).
 *
 * The shell owns nothing but the frame: a header (eyebrow / title / 닫기) and a `body` the caller fills. All panel
 * content — including `CraftPanel`'s own header — may also be supplied whole through `adopt()`.
 */
export class Modeless {
  readonly el: HTMLElement;
  /** Content host; empty by default. */
  readonly body: HTMLElement;
  private titleEl: HTMLElement | null = null;
  private eyebrowEl: HTMLElement | null = null;
  private _open = false;
  /** Element that opens this popup — a pointerdown on it must not count as "outside". */
  private anchor: HTMLElement | null = null;
  private onOutside = (e: PointerEvent): void => {
    if (!this._open) return;
    const t = e.target as Node | null;
    if (!t) return;
    if (this.el.contains(t)) return;
    if (this.anchor?.contains(t)) return;
    this.close();
    this.onClose?.();
  };

  /**
   * @param variant extra class on the frame (`implant` / `craft` / `disassemble`) for per-popup sizing.
   * @param onClose called after the popup closed itself (outside click / 닫기 button); not called by `close()`
   *   from the owner, which already knows.
   */
  constructor(variant: string, private readonly onClose?: () => void) {
    this.el = document.createElement('div');
    this.el.className = `inv-modeless inv-modeless-${variant}`;
    this.el.hidden = true;
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    // a press inside the popup must not reach the window's drag / outside-click paths
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.body = document.createElement('div');
    this.body.className = 'inv-modeless-body';
    this.el.appendChild(this.body);
  }

  /** Add the standard header above the body (skip it for a panel that brings its own, e.g. `CraftPanel`). */
  withHeader(eyebrow: string, title: string): this {
    const head = document.createElement('header');
    head.className = 'inv-modeless-head';
    const titles = document.createElement('div');
    titles.className = 'inv-head-titles';
    this.eyebrowEl = document.createElement('div');
    this.eyebrowEl.className = 'inv-eyebrow';
    this.eyebrowEl.textContent = eyebrow;
    this.titleEl = document.createElement('h2');
    this.titleEl.className = 'inv-title';
    this.titleEl.textContent = title;
    titles.append(this.eyebrowEl, this.titleEl);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'inv-btn inv-modeless-close';
    close.textContent = TEXT.modelessClose;
    close.addEventListener('click', () => { this.close(); this.onClose?.(); });
    head.append(titles, close);
    this.el.insertBefore(head, this.body);
    return this;
  }

  /** Replace the body with a ready-made panel element (`CraftPanel.el`). */
  adopt(panel: HTMLElement): this {
    this.body.replaceChildren(panel);
    return this;
  }

  setTitle(title: string): void { if (this.titleEl) this.titleEl.textContent = title; }

  get isOpen(): boolean { return this._open; }

  /**
   * Show the popup, anchored next to `anchor` when one is given (clamped into the viewport) and centred on the
   * window otherwise. `host` is the inventory root — the outside-click listener is installed on `document` so a
   * press anywhere (including the backdrop) dismisses it.
   */
  open(anchor: HTMLElement | null = null): void {
    if (this._open) return;
    this.anchor = anchor;
    this.el.hidden = false;
    this._open = true;
    this.el.classList.add('is-open');
    this.place();
    // the enter animation scales the frame, so the first rect can be short — re-anchor once it settled
    requestAnimationFrame(() => this.place());
    // capture phase: dismiss before the window's own pointer handlers run
    document.addEventListener('pointerdown', this.onOutside, true);
  }

  /** Re-anchor after the content changed size. */
  place(): void {
    if (!this._open) return;
    const a = this.anchor;
    if (!a) { this.el.style.removeProperty('left'); this.el.style.removeProperty('top'); this.el.classList.add('is-centred'); return; }
    this.el.classList.remove('is-centred');
    const ar = a.getBoundingClientRect();
    const r = this.el.getBoundingClientRect();
    const margin = 10;
    // prefer the left side of the anchor (the equipment column sits at the right edge of the window)
    let left = ar.left - r.width - margin;
    if (left < margin) left = Math.min(ar.right + margin, window.innerWidth - r.width - margin);
    let top = ar.top;
    top = Math.min(top, window.innerHeight - r.height - margin);
    this.el.style.left = `${Math.round(Math.max(margin, left))}px`;
    this.el.style.top = `${Math.round(Math.max(margin, top))}px`;
  }

  /** Returns true when the popup was actually open (so Escape can be consumed by it). */
  close(): boolean {
    if (!this._open) return false;
    this._open = false;
    this.anchor = null;
    this.el.hidden = true;
    this.el.classList.remove('is-open');
    document.removeEventListener('pointerdown', this.onOutside, true);
    return true;
  }

  dispose(): void {
    this.close();
    this.el.remove();
  }
}
