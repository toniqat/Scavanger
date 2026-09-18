import type { GameContext } from './GameContext';
import { UI_HOLD_CONFIRM_S } from './constants';
import { createHoldButtonCap } from './keycap';

/* ────────────────────────────────────────────────────────────────────────────
 * The shared warning · hold-confirm popup (2026-09-13). Owner: shared/ — a contract, so it is add-only.
 *
 * The same thing exists **separately** in `ui/menus/askPopup` · `meta/ui/HoldAsk` · `inventory/ui/DisassemblePanel` — because
 * of the rule that folders do not import each other. This module is the **reusable** edition put in shared so as not to become
 * a fourth copy (those three were not moved this time). Like `itemChip.ts` it builds DOM, but it takes `ctx` and holds the
 * blocker · the cursor · the Escape stack itself.
 *
 * The convention (exactly the project's 2026-09-09 confirm rule):
 *  - A button with `hold: true` runs only after **being held for `UI_HOLD_CONFIRM_S`** — the gauge is rAF, the confirm is a
 *    timer (which does not stall in a tab whose frames stopped). Releasing part-way or leaving the button returns it to 0.
 *    A click · Enter never runs it.
 *    **2026-09-15 2nd pass (user's decision)**: the hint line that stated that rule (`.sh-ask-hint` — the line that flashed
 *    with `is-flash` on an early release) is gone. Instead a left-click hold keycap (`keycap.createHoldButtonCap`) stands
 *    **inside the hold button, left of the label** — 「how do I press it」 is told by the picture. That line carried nothing
 *    but the hold sentence, so it went away element and all.
 *  - **Escape = cancel** — it goes on top of `ctx.escape` and closes before the window behind it. Cancel is the `run` of the
 *    button with `cancel: true` (or `spec.onCancel` when there is none). **Enter is swallowed**. The initial focus is the
 *    cancel button (Space presses the safe side).
 *  - It puts its own token in `ctx.uiBlockers` and calls `input.setCursorMode(true, the token)` — the cursor stays even if the
 *    window behind closes first.
 *  - It attaches directly under `ctx.uiRoot` (inside a window, the window's transform traps `position: fixed`). A click on the
 *    backdrop does nothing.
 *
 * The style is injected as one `<style>` the first time this module opens (`.sh-ask*` — shared's prefix). Colours are the
 * tokens in `ui/styles/base.css`.
 * ──────────────────────────────────────────────────────────────────────────── */

export type HoldAskKind = 'danger' | 'primary' | 'default';

export interface HoldAskButton {
  label: string;
  /** The button colour. `danger` = a red border · a red gauge, `primary` = the accent colour. Defaults to `default`. */
  kind?: HoldAskKind;
  /** true = runs only on a `UI_HOLD_CONFIRM_S` hold (the gauge sweeps across the button). */
  hold?: boolean;
  /** true = the cancel button — Escape presses this one, and the initial focus is here too. Keep exactly one. */
  cancel?: boolean;
  /** What to do when pressed. The popup **closes first** and this is called after. */
  run?: () => void;
}

export interface HoldAskSpec {
  title: string;
  /** `\n` is kept (`white-space: pre-line`). */
  body: string;
  /** Left → right order. Cancel is usually on the left. */
  buttons: readonly HoldAskButton[];
  /** A red title · border (an irreversible action). */
  danger?: boolean;
  /** Called when it was closed with Escape and there is no `cancel` button. */
  onCancel?: () => void;
  /** The mark a smoke · CSS tells the popup apart by (`data-ask`). */
  id?: string;
}

export interface HoldAskHandle {
  readonly root: HTMLElement;
  readonly isOpen: boolean;
  /** 0..1 while a hold button is held (debug / smoke). */
  readonly holdProgress: number;
  /** The same as Escape — calls the cancel button's `run` (or `onCancel` when there is none) and closes. */
  cancel(): void;
  /** Closes without calling anything (when the screen that opened it goes away — a forced exit). */
  close(): void;
}

const STYLE_ID = 'sh-ask-style';

const CSS = `
.sh-ask { position: fixed; inset: 0; z-index: 206; display: flex; align-items: center; justify-content: center; background: rgba(3, 4, 6, 0.55); }
.sh-ask[hidden] { display: none; }
.sh-ask-card { width: min(440px, calc(100vw - 32px)); display: flex; flex-direction: column; gap: 10px; padding: 18px 20px 16px;
  background: linear-gradient(180deg, rgba(18, 21, 27, 0.98), rgba(10, 12, 17, 0.98));
  border: 1px solid var(--c-border-strong, rgba(255, 255, 255, 0.3)); box-shadow: 0 24px 56px rgba(0, 0, 0, 0.65); }
.sh-ask.is-danger .sh-ask-card { border-color: color-mix(in srgb, var(--c-danger) 55%, transparent); }
.sh-ask-title { font-size: 14px; font-weight: 700; letter-spacing: 0.06em; color: var(--c-text); }
.sh-ask.is-danger .sh-ask-title { color: var(--c-danger); }
.sh-ask-body { font-size: 12px; line-height: 1.6; color: var(--c-text-dim); white-space: pre-line; }
.sh-ask-foot { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
.sh-ask-foot .ui-btn { min-width: 104px; height: 34px; padding: 0 16px; font-size: 11px; letter-spacing: 0.12em; overflow: hidden; }
.sh-ask-btn.danger { border-color: color-mix(in srgb, var(--c-danger) 60%, transparent); color: var(--c-danger); }
.sh-ask-label { position: relative; }
.sh-ask-fill { position: absolute; inset: 0; transform: scaleX(0); transform-origin: left; pointer-events: none;
  background: color-mix(in srgb, var(--c-accent) 38%, transparent); }
.sh-ask-btn.danger .sh-ask-fill { background: color-mix(in srgb, var(--c-danger) 45%, transparent); }
`;

function injectStyle(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

let seq = 0;

/**
 * Open one warning popup. Each call builds its own DOM and removes it on close, so two can stack (the newer one is on top of
 * the Escape stack). Returns a handle the opener keeps to close it on a forced exit.
 */
export function openHoldAsk(ctx: GameContext, spec: HoldAskSpec): HoldAskHandle {
  injectStyle();
  const token = `holdAsk:${++seq}`;
  const holdMs = Math.max(1, UI_HOLD_CONFIRM_S * 1000);
  let open = true;
  let hold: { t0: number; raf: number; timer: number; btn: HTMLButtonElement; fill: HTMLElement } | null = null;

  const mk = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement, text?: string): HTMLElementTagNameMap[K] => {
    const e = document.createElement(tag);
    e.className = cls;
    if (text !== undefined) e.textContent = text;
    parent.appendChild(e);
    return e;
  };

  const root = mk('div', 'sh-ask interactive', ctx.uiRoot);
  if (spec.danger) root.classList.add('is-danger');
  if (spec.id) root.dataset.ask = spec.id;
  root.addEventListener('contextmenu', (e) => e.preventDefault());
  root.addEventListener('mousedown', (e) => e.stopPropagation());
  root.addEventListener('click', (e) => e.stopPropagation());
  const card = mk('div', 'sh-ask-card', root);
  card.setAttribute('role', 'alertdialog');
  mk('div', 'sh-ask-title', card, spec.title);
  mk('div', 'sh-ask-body', card, spec.body);
  const foot = mk('div', 'sh-ask-foot', card);

  const cancelHold = (): void => {
    const h = hold;
    hold = null;
    if (!h) return;
    cancelAnimationFrame(h.raf);
    clearTimeout(h.timer);
    h.fill.style.transform = 'scaleX(0)';
    h.btn.classList.remove('is-holding');
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); e.stopImmediatePropagation(); }
  };
  const onUp = (): void => release();

  const close = (): void => {
    if (!open) return;
    open = false;
    cancelHold();
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    ctx.escape.remove(token);
    ctx.uiBlockers.delete(token);
    ctx.input.setCursorMode(false, token);
    if (root.contains(document.activeElement)) (document.activeElement as HTMLElement | null)?.blur?.();
    root.remove();
  };

  const fire = (b: HoldAskButton | undefined, fallback?: () => void): void => {
    close();
    ctx.bus.emit('audio:play', { id: 'ui_click' });
    if (b?.run) b.run(); else fallback?.();
  };

  const cancelBtnSpec = spec.buttons.find((b) => b.cancel);
  const cancel = (): void => { if (open) fire(cancelBtnSpec, spec.onCancel); };

  /** Released early = nothing happens. Since the 2026-09-15 2nd pass there is no hint line, so returning the gauge to 0 is all of it. */
  const release = (): void => { if (hold) cancelHold(); };

  let focusBtn: HTMLButtonElement | null = null;
  for (const b of spec.buttons) {
    const kind = b.kind ?? 'default';
    const btn = mk('button', `ui-btn sh-ask-btn${kind === 'default' ? '' : ` ${kind}`}`, foot);
    btn.type = 'button';
    if (b.cancel) btn.dataset.cancel = '';
    if (b.hold) btn.dataset.hold = '';
    // 2026-09-15 2nd pass: a hold button carries the left-click hold keycap left of its label (the fill bar is absolute, so it is out of the line).
    if (b.hold) createHoldButtonCap(btn);
    const fill = b.hold ? mk('i', 'sh-ask-fill', btn) : null;
    mk('span', 'sh-ask-label', btn, b.label);
    if (b.cancel) focusBtn = btn;
    if (!b.hold) {
      btn.addEventListener('click', (e) => { e.stopPropagation(); fire(b); });
      continue;
    }
    // hold: a click / Enter does nothing; the timer is the only way in
    btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); });
    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !open || hold) return;
      e.stopPropagation();
      e.preventDefault();
      const t0 = performance.now();
      const tick = (): void => {
        if (!hold || hold.t0 !== t0) return;
        const f = Math.min(1, (performance.now() - t0) / holdMs);
        fill!.style.transform = `scaleX(${f.toFixed(3)})`;
        if (f < 1) hold.raf = requestAnimationFrame(tick);
      };
      const timer = window.setTimeout(() => { if (hold && hold.t0 === t0) fire(b); }, holdMs);
      hold = { t0, raf: requestAnimationFrame(tick), timer, btn, fill: fill! };
      btn.classList.add('is-holding');
    });
    btn.addEventListener('pointerleave', () => release());
  }

  window.addEventListener('keydown', onKey, true);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  ctx.uiBlockers.add(token);
  ctx.escape.push(token, () => { cancel(); });
  ctx.input.setCursorMode(true, token);
  (focusBtn ?? foot.querySelector('button'))?.focus({ preventScroll: true });
  ctx.bus.emit('audio:play', { id: 'ui_click' });

  return {
    root,
    get isOpen() { return open; },
    get holdProgress() { return hold ? Math.min(1, (performance.now() - hold.t0) / holdMs) : 0; },
    cancel,
    close,
  };
}
