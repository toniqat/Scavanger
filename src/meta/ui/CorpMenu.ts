import type { CorpId, GameContext } from '@/shared';
import { CORP_DEFS } from '@/shared';
import type { MetaSystem } from '../MetaSystem';
import type { CorpPage } from './CorpView';
import { CorpView } from './CorpView';
import { el } from './dom';

export type { CorpPage } from './CorpView';

const BLOCKER = 'corp';

/**
 * 기업 네트워크 **standalone screen** (`.menu.corp-menu`, ship computer `hub_computer`).
 *
 * Since Phase 8 this class is only the shell: the header, corp tabs, banner, sub-tabs, page and footer are built by
 * `CorpView`, which the embedded 기업 tab of the inventory Tab screen (`MetaRef.createCorpView`) uses as well — one set
 * of renderers, two shells. What stays here is the overlay etiquette the embedded variant must **not** have: the
 * `'corp'` blocker, the **in-game cursor** (`input.setCursorMode(true, 'corp')` — Phase 10: the pointer lock is
 * *kept* and a virtual cursor drives the DOM, so `exitPointerLock()` and the microtask re-lock are both gone), a
 * capture-phase Escape listener and a 닫기 footer button. Emits `ui:corpToggled`.
 */
export class CorpMenu {
  readonly root: HTMLElement;
  private readonly frame: HTMLElement;
  private readonly view: CorpView;
  private _open = false;
  private onKeyCapture = (e: KeyboardEvent): void => {
    if (!this._open || e.code !== 'Escape') return;
    e.stopImmediatePropagation();
    e.preventDefault();
    this.close();
  };

  constructor(private readonly ctx: GameContext, meta: MetaSystem) {
    const root = this.root = el('div', { cls: 'menu corp-menu interactive', parent: ctx.uiRoot });
    root.hidden = true;
    el('div', { cls: 'scan', parent: root });
    const f = this.frame = el('div', { cls: 'frame', parent: root });

    this.view = new CorpView(ctx, meta, f, {
      accentTarget: f,
      onClose: () => this.close(),
      isVisible: () => this._open,
    });

    root.addEventListener('mousedown', (e) => e.stopPropagation());   // keep clicks off the canvas' click-to-lock fallback
  }

  get isOpen(): boolean { return this._open; }
  get currentCorp(): CorpId { return this.view.currentCorp; }
  get currentPage(): CorpPage { return this.view.currentPage; }

  /* ── open / close ─────────────────────────────────────────────────────── */
  open(corp?: CorpId): void {
    if (corp && CORP_DEFS[corp]) this.view.setCorpSilent(corp);
    if (this._open) { this.view.refresh(); return; }
    this._open = true;
    this.ctx.uiBlockers.add(BLOCKER);          // blocker first, then the in-game cursor (the lock is kept)
    this.ctx.input.setCursorMode(true, BLOCKER);
    this.root.hidden = false;
    this.frame.style.animation = 'none';
    void this.frame.offsetWidth;
    this.frame.style.animation = '';
    this.view.hideMsg();
    window.addEventListener('keydown', this.onKeyCapture, true);
    this.view.refresh();
    this.ctx.bus.emit('ui:corpToggled', { open: true, corp: this.view.currentCorp });
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
  }

  /** `relock` is kept for the call signature only — Phase 10 never dropped the lock, so there is nothing to re-lock. */
  close(_relock = true): void {
    if (!this._open) return;
    this._open = false;
    window.removeEventListener('keydown', this.onKeyCapture, true);
    this.root.hidden = true;
    this.view.hideMsg();
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.ctx.uiBlockers.delete(BLOCKER);
    this.ctx.input.setCursorMode(false, BLOCKER);
    this.ctx.bus.emit('ui:corpToggled', { open: false, corp: this.view.currentCorp });
  }

  setCorp(corp: CorpId): void { this.view.setCorp(corp); }
  setPage(page: CorpPage): void { this.view.setPage(page); }
  refresh(): void { if (this._open) this.view.refresh(); }
  showMsg(text: string, kind?: 'info' | 'success' | 'warning' | 'danger'): void { this.view.showMsg(text, kind); }

  update(): void { this.view.update(); }

  dispose(): void {
    this.close(false);
    this.view.dispose();
    this.root.remove();
  }
}
