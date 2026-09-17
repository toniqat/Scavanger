import type { GameContext } from '@/shared';
import { TUTORIAL_BLOCKER } from '../model';

/* ────────────────────────────────────────────────────────────────────────────
 * src/tutorial/ui/Popup.ts — 시작 안내 카드와 건너뛰기 확인 카드.
 *
 * 두 카드는 같은 셸(`.tut-popup`)을 쓰고 버튼만 다르다.
 *   • **시작 안내** — 확인을 누르면 첫 단계로. `건너뛰기` 버튼도 함께 있다(요구사항).
 *   • **건너뛰기 확인** — 모달리스다: 뒤의 화면은 그대로 살아 있고, 취소하면 하던 자리로 돌아간다.
 *
 * 커서 예절은 함선 패널들과 같다 — `TUTORIAL_BLOCKER` 를 넣고 소프트 커서를 켜되 **포인터 락은 유지**한다.
 *
 * **2026-09-17 (B-17) — 컷씬 중 숨김**: 도킹 직전의 「모든 UI 닫기」(`hub/parts/SquadDock.cancelEverything`)는 이 카드를
 * 못 닫는다 — escape 스택에 없고, 닫는 것 자체가 단계를 진행시킨다. 그래서 닫는 대신 **숨는다**(`setHidden`, 위쪽
 * `suspended` 주석) — 연출 동안 사라졌다가 끝나면 그대로 돌아온다.
 *
 * **2026-09-09 — 홀드 버튼** (`PopupButton.hold`, 초). 건너뛰기처럼 되돌릴 수 없는 버튼은 클릭이 아니라 **누르고
 * 있어야** 한다: `pointerdown` 에 게이지(`.tut-hold-fill`)가 왼쪽에서 채워지기 시작하고, 다 차기 전에 손을 떼거나
 * 버튼 밖으로 나가면 취소, 다 차면 `onClick`. 제작 버튼의 1초 홀드와 같은 문법이라 손에 익은 대로 동작한다.
 * `click` 은 홀드 버튼에서는 무시한다 (짧게 눌러 실수로 끝내는 일이 없다).
 * ──────────────────────────────────────────────────────────────────────────── */

export interface PopupButton {
  label: string;
  kind?: 'primary' | 'danger' | '';
  onClick: () => void;
  /** 이 시간(초)만큼 눌러야 `onClick` 이 불린다 (없으면 보통 클릭). */
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
   * 컷씬이 화면을 가져갔다 (`shared/cutsceneHide`, 2026-09-17 사용자 결정 — B-17). **닫지 않고 숨는다** — 이 카드를
   * 닫는 것은 곧 단계를 진행시키는 것이라(`onClosed`) 도킹 한 번에 안내가 흘러가 버린다. 숨는 동안 DOM 뿐 아니라
   * 블로커 · 커서도 내려놓는다 (그러지 않으면 컷씬 위에 커서가 뜨고 `hub` 의 재락이 막힌다), 그리고 누르고 있던
   * 홀드 게이지는 취소한다 (안 보이는 버튼이 계속 차는 일은 없다). 연출이 끝나면 그대로 다시 뜬다.
   */
  private suspended = false;
  /** 진행 중인 홀드 (버튼 하나만). rAF 가 게이지를 그리고, 놓거나 카드가 닫히면 `cancel` 이 지운다. */
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
    // 컷씬 중에 열렸으면 상태만 켜 두고 화면에는 올리지 않는다 — 연출이 끝나는 순간 `setHidden(false)` 가 올린다
    if (this.suspended) return;
    this.show();
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
  }

  /** 카드를 화면에 올린다 (블로커 먼저, 그 다음 커서 — 함선 UI 예절). 여는 것과 컷씬에서 돌아오는 것이 함께 쓴다. */
  private show(): void {
    this.ctx.uiBlockers.add(TUTORIAL_BLOCKER);
    this.ctx.input.setCursorMode(true, TUTORIAL_BLOCKER);
    this.root.hidden = false;
    this.card.style.animation = 'none';
    void this.card.offsetWidth;
    this.card.style.animation = '';
  }

  /** 화면에서 내린다 — 홀드 게이지 · DOM · 포커스 · 블로커 · 커서. `_open` 은 건드리지 않는다 (닫기와 숨김이 함께 쓴다). */
  private hide(): void {
    this.cancelHold();
    this.root.hidden = true;
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.ctx.uiBlockers.delete(TUTORIAL_BLOCKER);
    this.ctx.input.setCursorMode(false, TUTORIAL_BLOCKER);
  }

  /**
   * 컷씬이 시작 · 끝났다 (`shared/cutsceneHide` 를 `TutorialSystem` 이 구독한다). 멱등이고, 카드가 열려 있지 않으면
   * 상태만 기억한다 — 연출 중에 열린 카드도 끝날 때 같이 뜬다. 다시 뜰 때 소리는 내지 않는다 (이미 열렸던 카드다).
   */
  setHidden(hidden: boolean): void {
    if (hidden === this.suspended) return;
    this.suspended = hidden;
    if (!this._open) return;
    if (hidden) this.hide(); else this.show();
  }

  /** 홀드 버튼: 라벨 + 게이지, 누르고 있는 동안만 채워진다. */
  private makeHold(el: HTMLButtonElement, b: PopupButton): void {
    const holdMs = (b.hold ?? 0) * 1000;
    el.classList.add('tut-hold');
    const fill = document.createElement('i');
    fill.className = 'tut-hold-fill';
    const label = document.createElement('span');
    label.textContent = b.label;
    el.append(fill, label);
    el.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); });   // 클릭으로는 안 된다
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

  /** 스모크 / 디버그: 홀드 게이지가 차고 있다. */
  get isHolding(): boolean { return this.hold !== null; }

  close(): void {
    if (!this._open) return;
    this._open = false;
    this.hide();      // 숨어 있었다면 블로커 · 커서는 이미 내려놓았다 (둘 다 멱등)
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
