import type { GameContext } from '@/shared';
import { UI_HOLD_CONFIRM_S, createHoldButtonCap } from '@/shared';
import { el, setText } from './dom';

/** What the popup asks: title · body (`\n` kept) · the confirm label · what confirming does. */
export interface HoldAskSpec {
  title: string;
  body: string;
  ok: string;
  run(): void;
}

/** `ctx.escape` token — the popup sits over the Tab window, so Escape closes it first. */
const ESCAPE_KEY = 'meta:holdAsk';

/**
 * The corp screen's **confirm-once-more** popup (2026-09-12, E2 — selling a favorite item).
 *
 * Same contract as `ui/menus/askPopup`'s warning popup, but folders do not import one another, so meta keeps its own:
 *  - Confirming is a **`UI_HOLD_CONFIRM_S` hold** (the gauge rides rAF, the confirm a timer — so it never stalls in a
 *    tab whose frames have stopped). Click and Enter never confirm. **2026-09-15 2nd pass (user's decision)**: the
 *    hint row 「〈라벨〉 버튼을 1초 동안 …」 (`.cv-ask-hint` — the row that flashed on an early release) is gone, and
 *    instead a left-click hold keycap (`shared/keycap.createHoldButtonCap`) stands **inside the confirm button, left
 *    of the label**. `meta.css`'s `.cv-ask-hint` rule went with it — a comment stands in its place saying why.
 *  - **Escape = cancel** — it goes on top of `ctx.escape` and closes before the Tab window. Enter is swallowed. The
 *    initial focus is `취소`.
 *  - Pressing an empty spot on the backdrop cancels (cancelling is always safe).
 *
 * It hangs directly under `ctx.uiRoot` — attached to a host inside the Tab window, the window's transform would trap
 * `position: fixed`. It owns no blocker token and no cursor (the Tab window that raised this popup holds those). The
 * class prefix is this folder's `.cv-`.
 */
export class HoldAsk {
  readonly root: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly okBtn: HTMLButtonElement;
  private readonly okLabel: HTMLElement;
  private readonly cancelBtn: HTMLButtonElement;
  private readonly fill: HTMLElement;
  private pending: HoldAskSpec | null = null;
  private hold: { t0: number; raf: number; timer: number } | null = null;

  private readonly onKey = (e: KeyboardEvent): void => {
    if (!this.pending) return;
    if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space') { e.preventDefault(); e.stopImmediatePropagation(); }
  };
  private readonly onUp = (): void => this.release();

  constructor(private readonly ctx: GameContext, parent: HTMLElement) {
    this.root = el('div', { cls: 'cv-ask', parent });
    this.root.hidden = true;
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    this.root.addEventListener('pointerdown', (e) => { if (e.target === this.root) this.close(); });
    const card = el('div', { cls: 'cv-ask-card', parent: this.root, attrs: { role: 'alertdialog' } });
    card.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.titleEl = el('div', { cls: 'cv-ask-title', parent: card });
    this.bodyEl = el('div', { cls: 'cv-ask-body', parent: card });
    const foot = el('div', { cls: 'cv-ask-foot', parent: card });
    this.cancelBtn = el('button', { cls: 'ui-btn cv-ask-cancel', text: '취소', parent: foot }) as HTMLButtonElement;
    this.okBtn = el('button', { cls: 'ui-btn danger cv-ask-ok', parent: foot }) as HTMLButtonElement;
    // 2026-09-15 2nd pass: the left-click hold keycap left of the label — it comes before the fill bar, so flex
    // order stands it furthest left.
    createHoldButtonCap(this.okBtn);
    this.fill = el('i', { cls: 'cv-ask-fill', parent: this.okBtn });
    this.okLabel = el('span', { cls: 'cv-ask-label', parent: this.okBtn });
    this.cancelBtn.addEventListener('click', (e) => { e.stopPropagation(); this.close(); });
    this.okBtn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); });
    this.okBtn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.pending || this.hold) return;
      e.stopPropagation(); e.preventDefault();
      this.startHold();
    });
    this.okBtn.addEventListener('pointerleave', () => this.release());
  }

  get isOpen(): boolean { return this.pending !== null; }
  /** 0..1 while the confirm button is held (debug / smoke). */
  get holdProgress(): number {
    return this.hold ? Math.min(1, (performance.now() - this.hold.t0) / Math.max(1, UI_HOLD_CONFIRM_S * 1000)) : 0;
  }

  open(spec: HoldAskSpec): void {
    this.cancelHold();
    this.pending = spec;
    setText(this.titleEl, spec.title);
    setText(this.bodyEl, spec.body);
    setText(this.okLabel, spec.ok);
    this.root.hidden = false;
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('pointerup', this.onUp);
    this.ctx.escape.push(ESCAPE_KEY, () => this.close());
    this.cancelBtn.focus({ preventScroll: true });
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
  }

  close(): void {
    if (!this.pending) return;
    this.cancelHold();
    this.pending = null;
    this.root.hidden = true;
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('pointerup', this.onUp);
    this.ctx.escape.remove(ESCAPE_KEY);
    (document.activeElement as HTMLElement | null)?.blur?.();
  }

  private startHold(): void {
    const holdMs = Math.max(1, UI_HOLD_CONFIRM_S * 1000);
    const t0 = performance.now();
    const tick = (): void => {
      if (!this.hold || this.hold.t0 !== t0) return;
      const f = Math.min(1, (performance.now() - t0) / holdMs);
      this.fill.style.transform = `scaleX(${f.toFixed(3)})`;
      if (f < 1) this.hold.raf = requestAnimationFrame(tick);
    };
    const timer = window.setTimeout(() => {
      if (!this.hold || this.hold.t0 !== t0) return;
      const spec = this.pending;
      this.close();
      if (spec) { this.ctx.bus.emit('audio:play', { id: 'ui_click' }); spec.run(); }
    }, holdMs);
    this.hold = { t0, raf: requestAnimationFrame(tick), timer };
    this.okBtn.classList.add('is-holding');
  }

  /**
   * Released early = nothing happens (with no hint row since 2026-09-15 2nd pass, returning the gauge to 0 is all
   * there is to do).
   */
  private release(): void {
    if (this.hold) this.cancelHold();
  }

  private cancelHold(): void {
    const h = this.hold;
    this.hold = null;
    if (h) { cancelAnimationFrame(h.raf); clearTimeout(h.timer); }
    this.fill.style.transform = 'scaleX(0)';
    this.okBtn.classList.remove('is-holding');
  }

  dispose(): void {
    this.close();
    this.root.remove();
  }
}
