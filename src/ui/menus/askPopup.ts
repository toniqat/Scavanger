import type { GameContext } from '@/shared';
import { UI_HOLD_CONFIRM_S, createHoldButtonCap } from '@/shared';
import { el, setText, toggleClass } from '../dom';

/** What one popup asks: title · body (line breaks allowed) · the confirm button's label · what to do on confirm. */
export interface AskSpec {
  title: string;
  /** Keeps `\n` alive (`white-space: pre-line`) — several lines can be drawn, as the creation summary does. Empty = no body line. */
  body: string;
  /** The confirm button's label. */
  ok: string;
  /** Red title + red confirm button (an action that cannot be undone). It always runs by hold only. */
  danger?: boolean;
  /**
   * appended (2026-09-14): a confirm that is not red also runs only when **held** for `UI_HOLD_CONFIRM_S` — its fill
   * bar is the accent colour. The first user is `만들기` in character creation (user's decision — 「1초 꾹 눌러서 시작」).
   */
  hold?: boolean;
  /**
   * appended (2026-09-14): a node attached under the body as it is — the place for a summary prose cannot carry (stat
   * gauges · the face thumbnail). It is detached when the popup closes (the next `open` never sees a left-over node).
   */
  content?: HTMLElement;
  /** appended (2026-09-14): a modifier class put on the card this one time (width and so on). Removed on close. */
  cardCls?: string;
  /** appended (2026-09-15): the cancel button's label (omitted = `취소`). The title's abandon-raid popup uses `닫기`. */
  cancel?: string;
  run(): void;
}

/** Is this a confirm that runs by hold only — a red confirm always, a non-red one only when `hold` was given. */
function needsHold(spec: AskSpec | null): boolean {
  return !!spec && (!!spec.danger || !!spec.hold);
}

/**
 * The **warning popup** of the title flow (2026-09-09).
 *
 * The same thing as `.pause-ask` in `menus/PauseMenu`, and it follows the **same 2026-09-09 contract**:
 *  - **Escape = cancel**, **Enter is swallowed and does nothing** (Enter is the chat key and the key a browser uses
 *    to press the focused button — one mistake must never delete a character). The initial focus is on **취소** too.
 *  - The confirm button of a `danger: true` popup (what cannot be undone = deleting a character) runs **only while
 *    held for `UI_HOLD_CONFIRM_S`** — a fill bar (`.tm-ask-fill`) of the same vocabulary as 제작 / 분해 / 파티 떠나기
 *    sweeps across the button. Releasing early or leaving the button cancels and returns to 0. What can be undone
 *    (overwriting with the dice) is just one click.
 *  - **2026-09-14**: with `hold: true` a confirm that is not red takes the same hold (only the fill is the accent
 *    colour). The character `만들기` is one — it can be undone (by deleting), but it steps straight into the game
 *    through a reload, so it is a weighty step.
 *  - **2026-09-15 2nd pass (user's decision)**: the notice line 「〈라벨〉 버튼을 1초 동안 누르고 있어야 실행됩니다」
 *    (`.tm-ask-hint`) is gone. 「how it is pressed」 is said not by prose but by the **left-click hold keycap
 *    inside the confirm button, left of the label** (`shared/keycap.createHoldButtonCap`) — attached only to a confirm that runs
 *    by hold. That line in this popup carried nothing but the hold wording, so the element went with it (no
 *    information was left to keep).
 *
 * It was kept apart rather than pulled out of PauseMenu and shared because that one is tied to `MenuBase` · the pause
 * events. This class attaches under any DOM node and holds no blocker token and no cursor ownership — the screen that
 * raised it (the title = `MenuBase`) already holds those. A menu has no frame hook, so the hold runs on rAF.
 */
export class AskPopup {
  readonly root: HTMLElement;
  private readonly card: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  /** 2026-09-14: the place `AskSpec.content` goes. */
  private readonly contentHost: HTMLElement;
  private readonly okBtn: HTMLButtonElement;
  private readonly cancelBtn: HTMLButtonElement;
  private readonly fill: HTMLElement;
  /**
   * 2026-09-15 2nd pass: the left-click keycap of a hold confirm. It stands **left** of the label inside the button
   * and is detached on a confirm that is not a hold. `setText` swaps `textContent` out, so every `open()` puts it
   * back together with the fill bar.
   */
  private readonly okCap: HTMLElement;
  private pending: AskSpec | null = null;
  /** The `AskSpec.cardCls` on the card right now (removed on close). */
  private cardCls = '';
  private ctx: GameContext | null = null;
  /** Hold progress 0..1, the rAF handle, the last frame's time. */
  private hold = 0;
  private raf = 0;
  private lastT = 0;

  private readonly onKey = (e: KeyboardEvent): void => {
    if (this.root.hidden) return;
    if (e.code === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); this.close(); }
    else if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); e.stopImmediatePropagation(); }
  };

  /** Listens on `window` so no hold is left behind wherever the pointer is released (the contract of every drag here). */
  private readonly onUp = (): void => this.stopHold();

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'tm-ask', parent });
    this.root.hidden = true;
    const card = el('div', { cls: 'tm-ask-card', parent: this.root });
    this.card = card;
    this.titleEl = el('div', { cls: 'tm-ask-title', text: '', parent: card });
    this.bodyEl = el('div', { cls: 'tm-ask-body', text: '', parent: card });
    this.contentHost = el('div', { cls: 'tm-ask-content', parent: card });
    this.contentHost.hidden = true;
    const foot = el('div', { cls: 'tm-ask-foot', parent: card });
    const no = el('button', { cls: 'ui-btn', text: '취소', parent: foot });
    this.okBtn = el('button', { cls: 'ui-btn', text: '확인', parent: foot });
    this.fill = el('i', { cls: 'tm-ask-fill', parent: this.okBtn });
    this.okCap = createHoldButtonCap();
    no.addEventListener('click', (e) => { e.stopPropagation(); this.close(); });
    this.okBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (needsHold(this.pending)) return;          // a hold confirm runs by hold only
      this.run();
    });
    this.okBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.startHold(); });
    this.okBtn.addEventListener('pointerleave', () => this.stopHold());
    // So the card behind the popup takes no click (a card on the select screen is one pressable surface).
    this.root.addEventListener('click', (e) => e.stopPropagation());
    this.root.addEventListener('mousedown', (e) => e.stopPropagation());
    this.cancelBtn = no;
  }

  bind(ctx: GameContext): void { this.ctx = ctx; }

  get isOpen(): boolean { return !this.root.hidden; }
  /** Hold progress 0..1 (debug / smoke). */
  get holdProgress(): number { return this.hold; }

  open(spec: AskSpec): void {
    this.pending = spec;
    setText(this.titleEl, spec.title);
    setText(this.bodyEl, spec.body);
    this.bodyEl.hidden = !spec.body;
    this.contentHost.replaceChildren(...(spec.content ? [spec.content] : []));
    this.contentHost.hidden = !spec.content;
    this.setCardCls(spec.cardCls ?? '');
    setText(this.cancelBtn, spec.cancel ?? '취소');
    const hold = needsHold(spec);
    setText(this.okBtn, spec.ok);
    // `setText` swaps `textContent` out, so the hold keycap (left of the label) and the fill bar go back in.
    if (hold) this.okBtn.prepend(this.okCap);
    this.okBtn.appendChild(this.fill);
    toggleClass(this.root, 'danger', !!spec.danger);
    toggleClass(this.okBtn, 'danger', !!spec.danger);
    toggleClass(this.okBtn, 'primary', !spec.danger);
    this.resetHold();
    this.root.hidden = false;
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('pointerup', this.onUp);
    // Space presses the safe side.
    this.cancelBtn.focus({ preventScroll: true });
    this.ctx?.bus.emit('audio:play', { id: 'ui_click' });
  }

  close(): void {
    if (this.root.hidden) return;
    this.stopHold();
    this.root.hidden = true;
    this.pending = null;
    this.contentHost.replaceChildren();
    this.contentHost.hidden = true;
    this.setCardCls('');
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('pointerup', this.onUp);
  }

  private setCardCls(cls: string): void {
    if (cls === this.cardCls) return;
    if (this.cardCls) this.card.classList.remove(this.cardCls);
    this.cardCls = cls;
    if (cls) this.card.classList.add(cls);
  }

  /* ── hold confirm ─────────────────────────────────────────────────────── */

  private startHold(): void {
    if (!needsHold(this.pending) || this.raf) return;
    this.lastT = performance.now();
    const step = (t: number): void => {
      const dt = Math.max(0, (t - this.lastT) / 1000);
      this.lastT = t;
      this.hold = Math.min(1, this.hold + dt / Math.max(0.05, UI_HOLD_CONFIRM_S));
      this.fill.style.width = `${(this.hold * 100).toFixed(1)}%`;
      if (this.hold >= 1) { this.raf = 0; this.run(); return; }
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  private stopHold(): void {
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
    this.resetHold();
  }

  private resetHold(): void {
    this.hold = 0;
    this.fill.style.width = '0%';
  }

  private run(): void {
    const spec = this.pending;
    this.close();
    if (!spec) return;
    this.ctx?.bus.emit('audio:play', { id: 'ui_click' });
    spec.run();
  }

  dispose(): void { this.close(); this.root.remove(); }
}
