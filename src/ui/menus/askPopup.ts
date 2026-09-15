import type { GameContext } from '@/shared';
import { UI_HOLD_CONFIRM_S, createHoldButtonCap } from '@/shared';
import { el, setText, toggleClass } from '../dom';

/** 팝업 하나가 묻는 것: 제목 · 본문(줄바꿈 허용) · 확인 버튼 라벨 · 확인했을 때 할 일. */
export interface AskSpec {
  title: string;
  /** `\n` 을 그대로 살린다 (`white-space: pre-line`) — 생성 요약처럼 여러 줄을 그릴 수 있게. 빈 문자열이면 본문 줄을 그리지 않는다. */
  body: string;
  /** 확인 버튼 라벨. */
  ok: string;
  /** 붉은 제목 + 붉은 확인 버튼 (되돌릴 수 없는 동작). 늘 홀드로만 실행된다. */
  danger?: boolean;
  /**
   * appended (2026-09-14): 붉지 않은 확인도 `UI_HOLD_CONFIRM_S` 동안 **누르고 있어야** 실행한다 — 채움 바가 악센트
   * 색이다. 첫 사용자는 캐릭터 생성의 `만들기` (사용자 결정 — 「1초 꾹 눌러서 시작」).
   */
  hold?: boolean;
  /**
   * appended (2026-09-14): 본문 아래에 그대로 붙일 노드 — 글로 쓸 수 없는 요약(능력치 게이지 · 얼굴 썸네일)을 위한 자리.
   * 팝업이 닫힐 때 떼어 낸다 (다음 `open` 이 남은 노드를 보지 않는다).
   */
  content?: HTMLElement;
  /** appended (2026-09-14): 이번 한 번 카드에 붙일 modifier 클래스 (폭 등). 닫을 때 뗀다. */
  cardCls?: string;
  /** appended (2026-09-15): 취소 버튼 라벨 (생략 = `취소`). 타이틀의 레이드 포기 팝업은 `닫기` 다. */
  cancel?: string;
  run(): void;
}

/** 홀드로만 실행되는 확인인가 — 붉은 확인은 언제나, 붉지 않은 것은 `hold` 를 준 것만. */
function needsHold(spec: AskSpec | null): boolean {
  return !!spec && (!!spec.danger || !!spec.hold);
}

/**
 * 타이틀 흐름의 **경고 팝업** (2026-09-09).
 *
 * `menus/PauseMenu` 의 `.pause-ask` 와 같은 물건이고 **같은 2026-09-09 규약**을 따른다:
 *  - **Escape = 취소**, **Enter 는 삼키고 아무것도 하지 않는다** (Enter 는 채팅 키이자 브라우저가 포커스된
 *    버튼을 누르는 키다 — 실수 한 번에 캐릭터가 지워져서는 안 된다). 최초 포커스도 **취소** 쪽이다.
 *  - `danger: true` 인 팝업(되돌릴 수 없는 것 = 캐릭터 삭제)의 확인 버튼은 **`UI_HOLD_CONFIRM_S` 만큼 누르고
 *    있어야** 실행된다 — 제작 / 분해 / 파티 떠나기와 같은 어휘의 채움 바(`.tm-ask-fill`)가 버튼을 쓸고 간다.
 *    도중에 놓거나 버튼을 벗어나면 취소하고 0 으로 되돌아간다. 되돌릴 수 있는 것(주사위 덮어쓰기)은
 *    그냥 한 번의 클릭이다.
 *  - **2026-09-14**: `hold: true` 면 붉지 않은 확인도 같은 홀드를 탄다 (채움만 악센트 색). 캐릭터 `만들기` 가 그렇다 —
 *    되돌릴 수는 있지만(삭제) 새로고침으로 곧장 게임에 들어가는, 무게 있는 한 걸음이다.
 *  - **2026-09-15 2차 (사용자 결정)**: 「〈라벨〉 버튼을 1초 동안 누르고 있어야 실행됩니다」 안내 줄(`.tm-ask-hint`)은
 *    없어졌다. 「어떻게 누르는가」는 글이 아니라 **확인 버튼 안 라벨 왼쪽의 좌클릭 홀드 키캡**
 *    (`shared/keycap.createHoldButtonCap`)이 말한다 — 홀드로만 실행되는 확인에만 붙는다. 이 팝업의 그 줄은
 *    오로지 홀드 문구만 나르고 있었으므로 요소째 사라졌다 (남길 정보가 없다).
 *
 * PauseMenu 에서 떼어내 공유하지 않고 따로 둔 이유는 그쪽이 `MenuBase` · 일시정지 이벤트에 묶여 있어서다.
 * 이 클래스는 아무 DOM 노드 아래에나 붙고 blocker 토큰도 커서 소유권도 갖지 않는다 — 그건 자기를 띄운
 * 화면(타이틀 = `MenuBase`)이 이미 쥐고 있다. 메뉴에는 프레임 훅이 없으므로 홀드는 rAF 로 돈다.
 */
export class AskPopup {
  readonly root: HTMLElement;
  private readonly card: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  /** 2026-09-14: `AskSpec.content` 가 들어가는 자리. */
  private readonly contentHost: HTMLElement;
  private readonly okBtn: HTMLButtonElement;
  private readonly cancelBtn: HTMLButtonElement;
  private readonly fill: HTMLElement;
  /**
   * 2026-09-15 2차: 홀드 확인의 좌클릭 키캡. 버튼 안 라벨 **왼쪽**에 서고, 홀드가 아닌 확인에서는 떼어 둔다.
   * `setText` 가 `textContent` 를 갈아 끼우므로 `open()` 마다 채움 바와 함께 다시 넣는다.
   */
  private readonly okCap: HTMLElement;
  private pending: AskSpec | null = null;
  /** 지금 카드에 붙어 있는 `AskSpec.cardCls` (닫을 때 뗀다). */
  private cardCls = '';
  private ctx: GameContext | null = null;
  /** 홀드 진행 0..1, rAF 핸들, 마지막 프레임 시각. */
  private hold = 0;
  private raf = 0;
  private lastT = 0;

  private readonly onKey = (e: KeyboardEvent): void => {
    if (this.root.hidden) return;
    if (e.code === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); this.close(); }
    else if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); e.stopImmediatePropagation(); }
  };

  /** 포인터를 어디서 놓든 홀드가 남지 않게 `window` 에서 듣는다 (이 프로젝트의 드래그 코드와 같은 규약). */
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
      if (needsHold(this.pending)) return;          // 홀드 확인은 홀드로만 실행된다
      this.run();
    });
    this.okBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.startHold(); });
    this.okBtn.addEventListener('pointerleave', () => this.stopHold());
    // 팝업 뒤의 카드가 클릭을 받지 않게 (선택창의 카드는 통째로 눌리는 면이다).
    this.root.addEventListener('click', (e) => e.stopPropagation());
    this.root.addEventListener('mousedown', (e) => e.stopPropagation());
    this.cancelBtn = no;
  }

  bind(ctx: GameContext): void { this.ctx = ctx; }

  get isOpen(): boolean { return !this.root.hidden; }
  /** 홀드 진행도 0..1 (디버그 / 스모크). */
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
    // `setText` 는 `textContent` 를 갈아 끼우므로 홀드 키캡(라벨 왼쪽)과 채움 바를 다시 넣어 준다.
    if (hold) this.okBtn.prepend(this.okCap);
    this.okBtn.appendChild(this.fill);
    toggleClass(this.root, 'danger', !!spec.danger);
    toggleClass(this.okBtn, 'danger', !!spec.danger);
    toggleClass(this.okBtn, 'primary', !spec.danger);
    this.resetHold();
    this.root.hidden = false;
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('pointerup', this.onUp);
    // 스페이스는 안전한 쪽을 누른다.
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

  /* ── 홀드 확인 ────────────────────────────────────────────────────────── */

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
