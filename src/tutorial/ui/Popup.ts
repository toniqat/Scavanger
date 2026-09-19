import type { GameContext } from '@/shared';
import { TUTORIAL_BLOCKER } from '../model';

/* ────────────────────────────────────────────────────────────────────────────
 * src/tutorial/ui/Popup.ts — the intro card and the skip-confirm card.
 *
 * The two cards use the same shell (`.tut-popup`) and differ only in their buttons.
 *   • **the intro card** — pressing confirm goes to the first step. A `건너뛰기` button sits next to it (a requirement).
 *   • **the skip-confirm card** — modeless: the screen behind stays alive, and cancelling returns to where the
 *     player was.
 *
 * Cursor manners are the same as the ship panels' — it adds `TUTORIAL_BLOCKER` and turns the soft cursor on while
 * **keeping pointer lock**.
 *
 * **2026-09-17 (B-17) — hidden during a cutscene**: the 「모든 UI 닫기」 just before docking
 * (`hub/parts/SquadDock.cancelEverything`) cannot close this card — it is not on the escape stack and closing it is
 * itself what advances the step. So it **hides** instead (`setHidden`, the `suspended` comment below) — gone for the
 * length of the cutscene and back unchanged when it ends.
 *
 * **2026-09-09 — the hold button** (`PopupButton.hold`, seconds). An irreversible button like skip is not clicked but
 * **held down**: on `pointerdown` the gauge (`.tut-hold-fill`) starts filling from the left; letting go or leaving
 * the button before it is full cancels, filling it up calls `onClick`. It is the same grammar as the craft button's
 * 1 s hold, so it behaves the way the hand already knows. `click` is ignored on a hold button (no ending it by a
 * short press).
 * ──────────────────────────────────────────────────────────────────────────── */

export interface PopupButton {
  label: string;
  kind?: 'primary' | 'danger' | '';
  onClick: () => void;
  /** `onClick` is called only after a press this long (seconds); with none it is an ordinary click. */
  hold?: number;
}

export class TutorialPopup {
  private readonly root: HTMLElement;
  private readonly card: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly actsEl: HTMLElement;
  private _open = false;
  /**
   * A cutscene took the screen (`shared/cutsceneHide`, 2026-09-17 user's decision — B-17). It **hides without
   * closing** — closing this card is the same as advancing the step (`onClosed`), so one docking would let the
   * guidance run away.
   * While hidden it drops the blocker · cursor as well as the DOM (else a cursor sits over the cutscene and `hub`'s
   * relock is blocked), and a pressed hold gauge is cancelled (no unseen button keeps filling). It returns unchanged.
   */
  private suspended = false;
  /** A hold in progress (one button only). rAF draws the gauge; a release or a close has `cancel` wipe it. */
  private hold: { cancel: () => void } | null = null;

  constructor(private readonly ctx: GameContext, private readonly onClosed: () => void) {
    const root = this.root = document.createElement('div');
    root.className = 'tut-popup interactive';
    root.hidden = true;
    this.card = document.createElement('div');
    this.card.className = 'tut-popup-card';
    this.titleEl = document.createElement('div');
    this.titleEl.className = 'title';
    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'body';
    this.actsEl = document.createElement('div');
    this.actsEl.className = 'acts';
    this.card.append(this.titleEl, this.bodyEl, this.actsEl);
    root.appendChild(this.card);
    root.addEventListener('mousedown', (e) => e.stopPropagation());
    ctx.uiRoot.appendChild(root);
  }

  get isOpen(): boolean { return this._open; }

  open(title: string, lines: readonly string[], buttons: readonly PopupButton[]): void {
    this.titleEl.textContent = title;
    this.bodyEl.replaceChildren();
    for (const l of lines) {
      const p = document.createElement('p');
      p.textContent = l;
      this.bodyEl.appendChild(p);
    }
    this.actsEl.replaceChildren();
    this.cancelHold();
    for (const b of buttons) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `ui-btn ${b.kind ?? ''}`.trim();
      if (b.hold && b.hold > 0) this.makeHold(el, b);
      else {
        el.textContent = b.label;
        el.addEventListener('click', (e) => { e.stopPropagation(); b.onClick(); });
      }
      this.actsEl.appendChild(el);
    }
    if (this._open) return;
    this._open = true;
    // Opened during a cutscene it only turns the state on, raising nothing — `setHidden(false)` raises it at the end
    if (this.suspended) return;
    this.show();
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
  }

  /**
   * Raises the card (the blocker first, then the cursor — ship UI manners). Opening and coming back from a cutscene
   * share it.
   */
  private show(): void {
    this.ctx.uiBlockers.add(TUTORIAL_BLOCKER);
    this.ctx.input.setCursorMode(true, TUTORIAL_BLOCKER);
    this.root.hidden = false;
    this.card.style.animation = 'none';
    void this.card.offsetWidth;
    this.card.style.animation = '';
  }

  /**
   * Takes it off the screen — the hold gauge · DOM · focus · blocker · cursor. `_open` is left alone (closing and
   * hiding share this).
   */
  private hide(): void {
    this.cancelHold();
    this.root.hidden = true;
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.ctx.uiBlockers.delete(TUTORIAL_BLOCKER);
    this.ctx.input.setCursorMode(false, TUTORIAL_BLOCKER);
  }

  /**
   * A cutscene started · ended (`TutorialSystem` subscribes to `shared/cutsceneHide`). Idempotent, and with no card
   * open it only remembers the state — a card opened during the cutscene comes up with it at the end. Returning makes
   * no sound (the card was already open).
   */
  setHidden(hidden: boolean): void {
    if (hidden === this.suspended) return;
    this.suspended = hidden;
    if (!this._open) return;
    if (hidden) this.hide(); else this.show();
  }

  /** A hold button: label + gauge, filling only while it is held down. */
  private makeHold(el: HTMLButtonElement, b: PopupButton): void {
    const holdMs = (b.hold ?? 0) * 1000;
    el.classList.add('tut-hold');
    const fill = document.createElement('i');
    fill.className = 'tut-hold-fill';
    const label = document.createElement('span');
    label.textContent = b.label;
    el.append(fill, label);
    el.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); });   // a click does not do it
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || this.hold) return;
      e.stopPropagation(); e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch { /* synthetic events have no capture */ }
      const t0 = performance.now();
      let raf = 0;
      const cancel = (): void => {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        fill.style.width = '0';
        el.classList.remove('is-holding');
        this.hold = null;
      };
      const tick = (): void => {
        const f = Math.min(1, (performance.now() - t0) / holdMs);
        fill.style.width = `${(f * 100).toFixed(1)}%`;
        if (f >= 1) { cancel(); this.ctx.bus.emit('audio:play', { id: 'ui_click' }); b.onClick(); return; }
        raf = requestAnimationFrame(tick);
      };
      this.hold = { cancel };
      el.classList.add('is-holding');
      raf = requestAnimationFrame(tick);
    });
    const release = (): void => { if (this.hold) this.hold.cancel(); };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('pointerleave', release);
    el.addEventListener('lostpointercapture', release);
  }

  private cancelHold(): void { this.hold?.cancel(); }

  /** Smoke / debug: the hold gauge is filling. */
  get isHolding(): boolean { return this.hold !== null; }

  close(): void {
    if (!this._open) return;
    this._open = false;
    this.hide();      // if it was hidden the blocker · cursor are already dropped (both idempotent)
    this.onClosed();
  }

  dispose(): void {
    this.cancelHold();
    if (this._open) {
      this.ctx.uiBlockers.delete(TUTORIAL_BLOCKER);
      this.ctx.input.setCursorMode(false, TUTORIAL_BLOCKER);
    }
    this._open = false;
    this.suspended = false;
    this.root.remove();
  }
}
