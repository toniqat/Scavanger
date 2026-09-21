import type { GameContext } from '@/shared';
import { el } from './dom';

/* ────────────────────────────────────────────────────────────────────────────
 * The training arena entry confirm (2026-09-15, user's decision).
 *
 * The `시뮬레이션 훈련장` button at the bottom right of the terminal's planet tab raises this card instead of entering
 * straight away. Entering is **reversible**, so it is a tap confirm, not a 1 s hold (the other side of 「irreversible
 * confirms need a 1 s hold」). Escape · Tab · E cancel, and the initial focus is `취소`, so Enter cancels too.
 *
 * Screen contract: its own blocker / escape token `hub:trainConfirm` (**a different token** from the terminal's `hub` —
 * closing it never costs the terminal behind it its cursor), key guide owner `hub.trainConfirm` (the guide appends the
 * close entry itself). CSS prefix `.htc-` (`hub/intel.css`). Owner: hub/ui. Opened from — `.hub-train`, which since
 * 2026-09-15 sits on its own right-aligned row **above** the footer separator (`.hub-train-row`, planet tab only), not
 * in `HubMenu`'s footer.
 * ──────────────────────────────────────────────────────────────────────────── */

const TOKEN = 'hub:trainConfirm';
const GUIDE_OWNER = 'hub.trainConfirm';

export class TrainingConfirm {
  readonly root: HTMLElement;
  private readonly btnCancel: HTMLButtonElement;
  private _open = false;
  private onConfirm: (() => void) | null = null;

  constructor(private readonly ctx: GameContext, private readonly onClosed: () => void) {
    const root = this.root = el('div', { cls: 'menu hub-menu htc-confirm interactive', parent: ctx.uiRoot });
    root.hidden = true;
    const f = el('div', { cls: 'frame', parent: root });
    const head = el('div', { cls: 'hub-head', parent: f });
    const hl = el('div', { cls: 'hl', parent: head });
    el('div', { cls: 'title', text: '시뮬레이션 훈련장', parent: hl });
    el('div', { cls: 'htc-body', text: '시뮬레이션 훈련장에 입장하시겠습니까?', parent: f });
    const foot = el('div', { cls: 'hub-foot', parent: f });
    const right = el('div', { cls: 'right', parent: foot });
    this.btnCancel = this.button(right, '취소', () => this.close(), 'htc-cancel');
    this.button(right, '입장', () => this.confirm(), 'primary htc-ok');
    root.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  get isOpen(): boolean { return this._open; }

  open(onConfirm: () => void): void {
    this.onConfirm = onConfirm;
    if (this._open) return;
    this._open = true;
    this.root.hidden = false;
    this.ctx.uiBlockers.add(TOKEN);
    this.ctx.escape.push(TOKEN, () => this.close());
    this.ctx.input.setCursorMode(true, TOKEN);
    this.ctx.bus.emit('ui:keyGuide', { owner: GUIDE_OWNER, keys: [] });
    this.btnCancel.focus();
  }

  close(): void {
    if (!this._open) return;
    this._open = false;
    this.onConfirm = null;
    this.root.hidden = true;
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.ctx.uiBlockers.delete(TOKEN);
    this.ctx.escape.remove(TOKEN);
    this.ctx.input.setCursorMode(false, TOKEN);
    this.ctx.bus.emit('ui:keyGuide', { owner: GUIDE_OWNER, keys: null });
    this.onClosed();
  }

  /** `입장` — close the card first (releasing the token), then call the entry. `startTraining` toasts any refusal. */
  private confirm(): void {
    const run = this.onConfirm;
    this.close();
    run?.();
  }

  private button(parent: HTMLElement, label: string, onClick: () => void, extraCls = ''): HTMLButtonElement {
    const b = el('button', { cls: `ui-btn ${extraCls}`, text: label, parent });
    b.type = 'button';
    b.addEventListener('click', (e) => { e.stopPropagation(); this.ctx.bus.emit('audio:play', { id: 'ui_click' }); onClick(); });
    return b;
  }

  dispose(): void {
    this.close();
    this.root.remove();
  }
}
