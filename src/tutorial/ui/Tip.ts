import { TIP_FADE_S, TIP_GAP_PX, TIP_HOLD_S, TIP_LABEL_KO } from '../model';

/* ────────────────────────────────────────────────────────────────────────────
 * src/tutorial/ui/Tip.ts — **the TIP toast** (2026-09-15, user's decision).
 *
 * One small panel that shows **right under** the right-side control guide (`ui/Controls`, `.tut-controls`): a `TIP`
 * label at the head, one line below. The one place it is used today is the crawl · crouch-aim stretch's
 * 「앉거나 포복해서 조준 시, 명중률이 높아집니다.」 (exactly once — `TutorialSystem.maybeCrouchTip` decides when).
 *
 * **Appearing · staying · going is driven by `update(dt)` through an inline opacity.** This development PC reports
 * `prefers-reduced-motion` and `ui/styles/base.css` clips every CSS transition to 0.01 ms, so a fade that carries
 * meaning made in CSS turns on and off within one frame (the same reason as `HudSystem.stepScreenFade`).
 *
 * The place: the control guide stands vertically centred in its `top`/`bottom` band (`tutorial.css`), so its bottom
 * moves with the window size · the row count. So while the tip is up its rect is read every frame and the tip is put
 * below it — it is up for a few seconds, so one `getBoundingClientRect` is the whole cost. With the guide folded (the
 * inventory screen) it hides along, but time keeps running.
 * ──────────────────────────────────────────────────────────────────────────── */

export class TutorialTip {
  readonly root: HTMLElement;
  private readonly body: HTMLElement;
  /** How long it has been up (s). -1 = off. */
  private t = -1;

  constructor(parent: HTMLElement) {
    const root = this.root = document.createElement('div');
    root.className = 'tut-tip';
    root.hidden = true;
    root.style.opacity = '0';
    const head = document.createElement('div');
    head.className = 'tut-tip-head';
    head.textContent = TIP_LABEL_KO;
    this.body = document.createElement('div');
    this.body.className = 'tut-tip-body';
    root.append(head, this.body);
    parent.appendChild(root);
  }

  /** Is it up (appearing · going included). */
  get active(): boolean { return this.t >= 0; }
  /** Smoke / debug: the opacity painted right now. */
  get opacity(): number { return Number(this.root.style.opacity) || 0; }

  /** Puts one line up — the timer counts from the start again. */
  show(text: string): void {
    this.body.textContent = text;
    this.t = 0;
  }

  /** Turns it off at once (the track ended · a mission reset). */
  clear(): void {
    this.t = -1;
    this.root.hidden = true;
    this.root.style.opacity = '0';
  }

  /**
   * Every frame. `anchor` = the control guide's root — visible, the tip hangs under it; hidden, it hides along.
   * Time runs even while the guide is folded (a TIP from minutes ago must not come up when it is opened again).
   */
  update(dt: number, anchor: HTMLElement | null): void {
    if (this.t < 0) return;
    this.t += Math.max(0, dt);
    const total = TIP_FADE_S * 2 + TIP_HOLD_S;
    if (this.t >= total) { this.clear(); return; }
    const r = anchor && !anchor.hidden ? anchor.getBoundingClientRect() : null;
    if (!r || r.height <= 0) { this.root.hidden = true; return; }
    const a = this.t < TIP_FADE_S ? this.t / TIP_FADE_S
      : this.t > total - TIP_FADE_S ? (total - this.t) / TIP_FADE_S : 1;
    this.root.hidden = false;
    this.root.style.top = `${Math.round(r.bottom + TIP_GAP_PX)}px`;
    this.root.style.right = `${Math.round(window.innerWidth - r.right)}px`;
    this.root.style.width = `${Math.round(r.width)}px`;
    this.root.style.opacity = Math.max(0, Math.min(1, a)).toFixed(3);
  }

  dispose(): void { this.root.remove(); }
}
