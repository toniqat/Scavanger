import type { GameContext } from './GameContext';
import { UI_HOLD_CONFIRM_S } from './constants';

/* ────────────────────────────────────────────────────────────────────────────
 * 공용 경고 · 홀드 확인 팝업 (2026-09-13). Owner: shared/ — 계약이므로 추가만 한다.
 *
 * 같은 물건이 `ui/menus/askPopup` · `meta/ui/HoldAsk` · `inventory/ui/DisassemblePanel` 에 **각자** 있다 — 폴더끼리 import 하지
 * 않는다는 규칙 때문이다. 이 모듈은 그 넷째 사본이 되지 않으려고 shared 에 둔 **재사용 가능한** 판이다 (그 셋은 이번에 옮기지
 * 않았다). `itemChip.ts` 처럼 DOM 을 만들지만 `ctx` 를 받아 blocker · 커서 · Escape 스택을 스스로 쥔다.
 *
 * 규약 (프로젝트의 2026-09-09 확인 규칙 그대로):
 *  - `hold: true` 인 버튼은 **`UI_HOLD_CONFIRM_S` 동안 누르고 있어야** 실행된다 — 게이지는 rAF, 확정은 타이머(프레임이 멈춘
 *    탭에서도 멎지 않는다). 도중에 떼거나 버튼을 벗어나면 0 으로 돌아간다. 클릭 · Enter 로는 실행되지 않는다.
 *  - **Escape = 취소** — `ctx.escape` 맨 위에 올라가 뒤의 창보다 먼저 닫힌다. 취소는 `cancel: true` 인 버튼의 `run`
 *    (없으면 `spec.onCancel`)이다. **Enter 는 삼킨다**. 최초 포커스는 취소 버튼이다 (Space 는 안전한 쪽을 누른다).
 *  - `ctx.uiBlockers` 에 자기 토큰을 넣고 `input.setCursorMode(true, 토큰)` 한다 — 뒤의 창이 먼저 닫혀도 커서가 남는다.
 *  - `ctx.uiRoot` 바로 아래에 붙는다 (창 안에 두면 창의 transform 이 `position: fixed` 를 가둔다). 뒤판 클릭은 아무것도 안 한다.
 *
 * 스타일은 이 모듈이 처음 열릴 때 `<style>` 하나로 넣는다 (`.sh-ask*` — shared 의 접두사). 색은 `ui/styles/base.css` 의 토큰.
 * ──────────────────────────────────────────────────────────────────────────── */

export type HoldAskKind = 'danger' | 'primary' | 'default';

export interface HoldAskButton {
  label: string;
  /** 버튼 색. `danger` = 붉은 테두리 · 붉은 게이지, `primary` = 강조색. 기본 `default`. */
  kind?: HoldAskKind;
  /** true = `UI_HOLD_CONFIRM_S` 홀드로만 실행 (게이지가 버튼을 쓸고 간다). */
  hold?: boolean;
  /** true = 취소 버튼 — Escape 가 이것을 누르고, 최초 포커스도 여기다. 하나만 둔다. */
  cancel?: boolean;
  /** 눌렀을 때 할 일. 팝업은 **먼저 닫히고** 그다음에 부른다. */
  run?: () => void;
}

export interface HoldAskSpec {
  title: string;
  /** `\n` 을 살린다 (`white-space: pre-line`). */
  body: string;
  /** 왼쪽 → 오른쪽 순서. 보통 취소가 왼쪽이다. */
  buttons: readonly HoldAskButton[];
  /** 붉은 제목 · 테두리 (되돌릴 수 없는 동작). */
  danger?: boolean;
  /** Escape 로 닫혔는데 `cancel` 버튼이 없을 때 부른다. */
  onCancel?: () => void;
  /** 스모크 · CSS 가 팝업을 구분하는 표식 (`data-ask`). */
  id?: string;
}

export interface HoldAskHandle {
  readonly root: HTMLElement;
  readonly isOpen: boolean;
  /** 0..1 while a hold button is held (debug / smoke). */
  readonly holdProgress: number;
  /** Escape 와 같다 — 취소 버튼의 `run` (없으면 `onCancel`) 을 부르고 닫는다. */
  cancel(): void;
  /** 아무것도 부르지 않고 닫는다 (띄운 화면이 사라질 때 — 강제 종료). */
  close(): void;
}

const STYLE_ID = 'sh-ask-style';
/** Below this fraction of the hold a release reads as a click — flash the hint so the button explains itself. */
const TAP_HINT = 0.35;

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
.sh-ask-hint { font-size: 11px; color: var(--c-text-faint); transition: color var(--t-fast) var(--ease); }
.sh-ask-hint[hidden] { display: none; }
.sh-ask-hint.is-flash { color: var(--c-accent); }
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
  const holdBtn = spec.buttons.find((b) => b.hold);
  const hint = mk('div', 'sh-ask-hint', card, holdBtn ? `${holdBtn.label} 버튼을 ${UI_HOLD_CONFIRM_S}초 동안 누르고 있어야 실행됩니다.` : '');
  hint.hidden = !holdBtn;
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

  const release = (): void => {
    const h = hold;
    if (!h) return;
    const f = (performance.now() - h.t0) / holdMs;
    cancelHold();
    if (f < TAP_HINT) {
      hint.classList.remove('is-flash');
      void hint.offsetWidth;
      hint.classList.add('is-flash');
    }
  };

  let focusBtn: HTMLButtonElement | null = null;
  for (const b of spec.buttons) {
    const kind = b.kind ?? 'default';
    const btn = mk('button', `ui-btn sh-ask-btn${kind === 'default' ? '' : ` ${kind}`}`, foot);
    btn.type = 'button';
    if (b.cancel) btn.dataset.cancel = '';
    if (b.hold) btn.dataset.hold = '';
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
