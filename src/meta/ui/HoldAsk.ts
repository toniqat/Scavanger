import type { GameContext } from '@/shared';
import { UI_HOLD_CONFIRM_S } from '@/shared';
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
/** Below this fraction of the hold a release reads as a click — say how the button works. */
const TAP_HINT = 0.35;

/**
 * 기업 화면의 **한 번 더 확인** 팝업 (2026-09-12, E2 — 즐겨찾기 아이템 판매).
 *
 * `ui/menus/askPopup` 의 경고 팝업과 같은 규약이지만 폴더끼리 import 하지 않으므로 meta 가 따로 갖는다:
 *  - 확인은 **`UI_HOLD_CONFIRM_S` 홀드**다 (게이지는 rAF, 확정은 타이머 — 프레임이 멈춘 탭에서도 멎지 않는다).
 *    클릭 · Enter 로는 확정되지 않고, 일찍 떼면 안내가 뜬다.
 *  - **Escape = 취소** — `ctx.escape` 맨 위에 올라가 Tab 창보다 먼저 닫힌다. Enter 는 삼킨다. 최초 포커스는 `취소`.
 *  - 뒤판 빈 곳을 누르면 취소다 (취소는 언제나 안전하다).
 *
 * `ctx.uiRoot` 바로 아래에 붙는다 — Tab 창 안의 호스트에 붙이면 창의 transform 이 `position: fixed` 를 가둔다.
 * blocker 토큰 · 커서 소유는 없다 (그건 이 팝업을 띄운 Tab 창이 쥐고 있다). 클래스 접두사는 이 폴더의 `.cv-`.
 */
export class HoldAsk {
  readonly root: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly hintEl: HTMLElement;
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
    this.hintEl = el('div', { cls: 'cv-ask-hint', parent: card });
    const foot = el('div', { cls: 'cv-ask-foot', parent: card });
    this.cancelBtn = el('button', { cls: 'ui-btn cv-ask-cancel', text: '취소', parent: foot }) as HTMLButtonElement;
    this.okBtn = el('button', { cls: 'ui-btn danger cv-ask-ok', parent: foot }) as HTMLButtonElement;
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
    setText(this.hintEl, `${spec.ok} 버튼을 ${UI_HOLD_CONFIRM_S}초 동안 누르고 있어야 실행됩니다.`);
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

  private release(): void {
    const h = this.hold;
    if (!h) return;
    const f = (performance.now() - h.t0) / Math.max(1, UI_HOLD_CONFIRM_S * 1000);
    this.cancelHold();
    if (f < TAP_HINT) this.hintEl.classList.add('is-flash');
  }

  private cancelHold(): void {
    const h = this.hold;
    this.hold = null;
    if (h) { cancelAnimationFrame(h.raf); clearTimeout(h.timer); }
    this.fill.style.transform = 'scaleX(0)';
    this.okBtn.classList.remove('is-holding');
    this.hintEl.classList.remove('is-flash');
  }

  dispose(): void {
    this.close();
    this.root.remove();
  }
}
