import type { GameContext } from '@/shared';
import { Keys, MENU_BLOCKER } from '@/shared';
import { el, section } from './dom';

export type HousingPage = 'room' | 'facility' | 'presets' | 'grow' | 'bookshelf' | 'analyzer' | 'culture' | 'dining';
const BLOCKER = 'housing';

/**
 * `ui:housingToggled` only knows the three Phase 6 pages; every station panel added since (재배 · 책장 · 분석 ·
 * 배양 · 식탁) reports itself as `null` there (the contract's page union is frozen — page ids may not be appended).
 * 재배 · 책장 carry their own `ui:growToggled` / `ui:bookshelfToggled`; 분석 · 배양 · 식탁 have no such event in the
 * contract, so consumers watch `housing:analysisChanged` / `housing:cultureChanged` / `progress:mealChanged` instead.
 */
type WirePage = 'room' | 'facility' | 'presets' | null;
const WIRE_PAGES: readonly HousingPage[] = ['room', 'facility', 'presets'];
const wirePage = (p: HousingPage): WirePage => (WIRE_PAGES.includes(p) ? (p as WirePage) : null);

/** A popup living inside a panel (업그레이드 모달 · 우클릭 메뉴): E / Tab close the top one instead of the panel. */
export interface PanelOverlay {
  readonly isOpen: boolean;
  close(): void;
}

/**
 * Shared shell of the housing panels (`.menu.housing-menu`): adds the `'housing'` blocker and then turns on the
 * **in-game cursor** (`input.setCursorMode(true, 'housing')` — Phase 10: the pointer lock is *kept* and a virtual
 * cursor synthesises the DOM events, so `exitPointerLock()` and the microtask re-lock are both gone), closes on Esc
 * through a capture-phase window listener (so Input never sees the key) and emits `ui:housingToggled`.
 */
export abstract class HousingPanel {
  readonly root: HTMLElement;
  protected readonly frame: HTMLElement;
  protected readonly msg: HTMLElement;
  protected unsubs: Array<() => void> = [];
  /**
   * 2026-09-12: the station panels (재배 · 분석 · 배양 · 식탁) set this. One drop fires `housing:changed` +
   * `inventory:changed` + `inventory:stashChanged` in the same call stack, and each used to rebuild the whole panel —
   * with this on they collapse into **one** refresh on the next microtask. The Phase 6–9 menus keep the synchronous
   * refresh their smokes rely on.
   */
  protected coalesceRefresh = false;
  private refreshQueued = false;
  /** Popups inside this panel, bottom → top (`PanelOverlay`). */
  protected readonly overlays: PanelOverlay[] = [];
  /** Smoke / perf counters: refresh requests from the bus vs refreshes actually run. */
  readonly refreshStats = { requests: 0, runs: 0 };
  private _open = false;
  private msgTimer = 0;
  /**
   * 2026-09-08: these panels hang off a piece of furniture, so **E closes them** — the same key that opened them.
   * Escape is the 일시정지 메뉴 now and is not captured here at all (it stacks over the panel and returns to it).
   * The key is read live from `Keys`, never cached, and ignored while a menu owns the screen above us.
   * 2026-09-09: **Tab closes them too** (Tab closes every screen). Stopping the event here in the capture phase is
   * what keeps `Input` from ever recording the press, so the inventory cannot open on it. Unlike E, Tab is taken
   * even from a focused 프리셋 이름 field — nothing is typed with Tab, and `close()` blurs the field anyway.
   * 2026-09-12: an open overlay (업그레이드 모달 · 우클릭 메뉴) is closed first — the panel stays.
   */
  private onKeyCapture = (e: KeyboardEvent): void => {
    if (!this._open) return;
    const tab = e.code === Keys.INVENTORY;
    if (!tab && e.code !== Keys.INTERACT) return;
    if (this.ctx.uiBlockers.has(MENU_BLOCKER)) return;
    // This listener is capture-phase on `window`, so it runs *before* a focused field's own handler: without this
    // the E of a 프리셋 이름 would close the panel instead of being typed.
    const t = e.target;
    if (!tab && (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement)) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    for (let i = this.overlays.length - 1; i >= 0; i--) {
      if (this.overlays[i].isOpen) { this.overlays[i].close(); return; }
    }
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

  protected refreshIfOpen(): void {
    if (!this._open) return;
    if (this.coalesceRefresh) this.requestRefresh();
    else { this.refreshStats.runs++; this.refresh(); }
  }

  /** Queue one refresh for the end of the current task (many bus events in one call stack → one refresh). */
  protected requestRefresh(): void {
    this.refreshStats.requests++;
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    queueMicrotask(() => {
      this.refreshQueued = false;
      if (!this._open) return;
      this.refreshStats.runs++;
      this.refresh();
    });
  }

  protected openPanel(): void {
    if (this._open) { this.refresh(); return; }
    this._open = true;
    this.ctx.uiBlockers.add(BLOCKER);          // blocker first, then the in-game cursor (the lock is kept)
    this.ctx.escape.push(BLOCKER, () => this.close());
    this.ctx.input.setCursorMode(true, BLOCKER);
    this.root.hidden = false;
    this.frame.style.animation = 'none';
    void this.frame.offsetWidth;
    this.frame.style.animation = '';
    window.addEventListener('keydown', this.onKeyCapture, true);
    this.refresh();
    // 2026-09-09 키 가이드: the panels are buttons only, so their line is the guide's own `Tab 닫기` (owner per page)
    this.ctx.bus.emit('ui:keyGuide', { owner: `housing.${this.page}`, keys: [] });
    this.ctx.bus.emit('ui:housingToggled', { open: true, page: wirePage(this.page) });
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
  }

  /** `relock` is kept for the call signature only — Phase 10 never dropped the lock, so there is nothing to re-lock. */
  close(_relock = true): void {
    if (!this._open) return;
    this._open = false;
    for (const o of this.overlays) if (o.isOpen) o.close();
    window.removeEventListener('keydown', this.onKeyCapture, true);
    this.root.hidden = true;
    this.msg.hidden = true;
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.ctx.uiBlockers.delete(BLOCKER);
    this.ctx.escape.remove(BLOCKER);
    this.ctx.input.setCursorMode(false, BLOCKER);
    this.ctx.bus.emit('ui:keyGuide', { owner: `housing.${this.page}`, keys: null });
    this.ctx.bus.emit('ui:housingToggled', { open: false, page: wirePage(this.page) });
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

  /** 2026-09-12: a refused 수확 · 회수 (자리가 없다 …) — deny sound + a toast, not just the message line. */
  protected deny(reason: string): void {
    this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
    this.ctx.bus.emit('ui:notify', { text: reason, kind: 'warning' });
    this.showMsg(reason, 'warning');
  }

  dispose(): void {
    this.close(false);
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.root.remove();
  }
}
