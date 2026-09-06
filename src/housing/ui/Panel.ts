import type { GameContext } from '@/shared';
import { el, section } from './dom';

export type HousingPage = 'room' | 'facility' | 'presets' | 'grow';
const BLOCKER = 'housing';

/**
 * `ui:housingToggled` only knows the three Phase 6 pages; the Phase 8 재배 panel reports itself as `null` there and
 * carries its own `ui:growToggled` event instead (the contract is frozen — page ids may not be appended).
 */
type WirePage = 'room' | 'facility' | 'presets' | null;
const wirePage = (p: HousingPage): WirePage => (p === 'grow' ? null : p);

/**
 * Shared shell of the three housing panels (`.menu.housing-menu`): adds the `'housing'` blocker **before** exiting
 * pointer lock, closes on Esc through a capture-phase window listener (so Input never sees the key), emits
 * `ui:housingToggled`, and re-requests the lock one microtask after closing when no blocker is left and the phase is
 * still `hub` (hub pointer-lock etiquette).
 */
export abstract class HousingPanel {
  readonly root: HTMLElement;
  protected readonly frame: HTMLElement;
  protected readonly msg: HTMLElement;
  protected unsubs: Array<() => void> = [];
  private _open = false;
  private msgTimer = 0;
  private onKeyCapture = (e: KeyboardEvent): void => {
    if (!this._open || e.code !== 'Escape') return;
    e.stopImmediatePropagation();
    e.preventDefault();
    this.close();
  };

  protected constructor(protected readonly ctx: GameContext, readonly page: HousingPage, extraCls = '') {
    const root = this.root = el('div', { cls: `menu housing-menu interactive ${extraCls}`.trim(), parent: ctx.uiRoot });
    root.hidden = true;
    root.dataset.page = page;
    el('div', { cls: 'scan', parent: root });
    this.frame = el('div', { cls: 'frame', parent: root });
    this.msg = el('div', { cls: 'form-msg hs-msg' });   // subclasses mount it under their content (`mountMsg`)
    this.msg.hidden = true;
    // keep clicks inside from reaching the canvas' click-to-lock fallback
    root.addEventListener('mousedown', (e) => e.stopPropagation());
    this.unsubs.push(
      ctx.bus.on('housing:changed', () => this.refreshIfOpen()),
      ctx.bus.on('inventory:changed', () => this.refreshIfOpen()),
      ctx.bus.on('inventory:stashChanged', () => this.refreshIfOpen()),
    );
  }

  get isOpen(): boolean { return this._open; }

  /** Rebuild the panel from the current state (called on open and on every housing / inventory change). */
  abstract refresh(): void;

  protected refreshIfOpen(): void { if (this._open) this.refresh(); }

  protected openPanel(): void {
    if (this._open) { this.refresh(); return; }
    this._open = true;
    this.ctx.uiBlockers.add(BLOCKER);          // before the lock exits
    this.ctx.input.exitPointerLock();
    this.root.hidden = false;
    this.frame.style.animation = 'none';
    void this.frame.offsetWidth;
    this.frame.style.animation = '';
    window.addEventListener('keydown', this.onKeyCapture, true);
    this.refresh();
    this.ctx.bus.emit('ui:housingToggled', { open: true, page: wirePage(this.page) });
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
  }

  close(relock = true): void {
    if (!this._open) return;
    this._open = false;
    window.removeEventListener('keydown', this.onKeyCapture, true);
    this.root.hidden = true;
    this.msg.hidden = true;
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.ctx.uiBlockers.delete(BLOCKER);
    this.ctx.bus.emit('ui:housingToggled', { open: false, page: wirePage(this.page) });
    if (relock) this.relock();
  }

  private relock(): void {
    queueMicrotask(() => {
      const ctx = this.ctx;
      if (ctx.phase !== 'hub' || ctx.uiBlockers.size > 0) return;
      ctx.input.requestPointerLock();
    });
  }

  /** Append the message line to the frame (call after the content, before the footer). */
  protected mountMsg(): void { this.frame.appendChild(this.msg); }

  protected section(parent: HTMLElement, label: string): HTMLElement { return section(parent, label); }

  protected button(parent: HTMLElement, label: string, onClick: () => void, extraCls = ''): HTMLButtonElement {
    const b = el('button', { cls: `ui-btn ${extraCls}`.trim(), text: label, parent });
    b.addEventListener('click', (e) => { e.stopPropagation(); this.ctx.bus.emit('audio:play', { id: 'ui_click' }); onClick(); });
    return b;
  }

  showMsg(text: string, kind: 'info' | 'success' | 'warning' | 'danger' = 'info'): void {
    if (!this._open) return;
    this.msg.textContent = text;
    this.msg.className = `form-msg hs-msg ${kind}`;
    this.msg.hidden = false;
    clearTimeout(this.msgTimer);
    this.msgTimer = window.setTimeout(() => { this.msg.hidden = true; }, 4500);
  }

  dispose(): void {
    this.close(false);
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.root.remove();
  }
}
