import type { StepDef } from '../model';

/* ────────────────────────────────────────────────────────────────────────────
 * src/tutorial/ui/Panel.ts — **튜토리얼 목표 패널** (좌측 상단).
 *
 * 레이드의 계약 패널(`ui/hud/ContractPanel`)과 같은 자리 · 같은 결이지만 그 코드를 쓰지 않는다 — 계약 패널은
 * 게임플레이 레이어에 속해 함선에서는 숨겨지고, 이 패널은 반대로 **함선에서만** 뜬다.
 *
 * 구성: `튜토리얼 n / m` 라벨 · 제목 · 부제 · 진행 바 · 그 아래 **건너뛰기** 버튼. 버튼만 클릭을 받으므로
 * 패널 자체는 `pointer-events: none` 이고 버튼에만 `.interactive` 를 준다 (커서 모드가 아닐 때도 눌리도록
 * `ui-root` 의 규약을 따른다).
 *
 * **2026-09-08 — 스포트라이트가 이 패널을 덮지 않는다.** 포커싱이 켜지면 `setLifted(true)` 로 패널에 `is-lifted` 를
 * 단다. 그래야 지금 무엇을 해야 하는지가 계속 읽히고, 무엇보다 **건너뛰기 버튼을 언제든 누를 수 있다** —
 * 포커싱이 어딘가에 잘못 걸려도 튜토리얼에서 빠져나갈 수 있다.
 *
 * **2026-09-09 — 패널은 언제나 화면들 위에 있다.** z-index 는 이제 `is-lifted` 와 무관하게 79 로 고정이다
 * (`tutorial.css`). 예전에는 24 였다가 포커싱 중에만 79 로 올라갔는데, 포커싱 대상을 못 찾은 순간(제작 행이 아직
 * 없다 등 — 제작 단계에서 작업대를 열기 전)마다 인벤토리 창(`.inv-root`, z 50, 배경 블러)이 패널을 **통째로 덮어** 목표가 사라졌다. `is-lifted` 와
 * `setLifted` 는 호환을 위해 남아 있고(스모크가 본다) 상태 표시일 뿐 z-index 를 바꾸지 않는다.
 * ──────────────────────────────────────────────────────────────────────────── */

export class TutorialPanel {
  readonly root: HTMLElement;
  private readonly label: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly skipBtn: HTMLButtonElement;
  private _visible = false;
  private _lifted = false;

  constructor(parent: HTMLElement, onSkip: () => void) {
    const root = this.root = document.createElement('div');
    root.className = 'tut-panel';
    root.hidden = true;

    const head = document.createElement('div');
    head.className = 'tut-head';
    this.label = document.createElement('span');
    this.label.className = 'ui-label';
    this.label.textContent = '튜토리얼';
    head.appendChild(this.label);

    this.titleEl = document.createElement('div');
    this.titleEl.className = 'tut-title';
    this.hintEl = document.createElement('div');
    this.hintEl.className = 'tut-hint';

    const bar = document.createElement('div');
    bar.className = 'tut-bar';
    this.fill = document.createElement('i');
    bar.appendChild(this.fill);

    this.skipBtn = document.createElement('button');
    this.skipBtn.type = 'button';
    this.skipBtn.className = 'ui-btn tut-skip interactive';
    this.skipBtn.textContent = '튜토리얼 건너뛰기';
    this.skipBtn.addEventListener('click', (e) => { e.stopPropagation(); onSkip(); });

    root.append(head, this.titleEl, this.hintEl, bar, this.skipBtn);
    parent.appendChild(root);
  }

  get visible(): boolean { return this._visible; }
  /**
   * 스포트라이트가 떠 있다 — `is-lifted` 를 단다. 2026-09-09 부터 **상태 표시일 뿐** z-index 는 늘 79 다
   * (패널이 화면 아래로 깔리는 일이 없도록). 호출부 · 스모크 호환을 위해 남겨 둔다.
   */
  setLifted(on: boolean): void {
    if (on === this._lifted) return;
    this._lifted = on;
    this.root.classList.toggle('is-lifted', on);
  }

  show(def: StepDef, index: number, count: number): void {
    this.label.textContent = `튜토리얼 ${index} / ${count}`;
    if (this.titleEl.textContent !== def.title) this.titleEl.textContent = def.title;
    if (this.hintEl.textContent !== def.hint) this.hintEl.textContent = def.hint;
    const frac = count > 0 ? Math.max(0, Math.min(1, index / count)) : 0;
    this.fill.style.transform = `scaleX(${frac.toFixed(3)})`;
    if (!this._visible) { this._visible = true; this.root.hidden = false; }
  }

  hide(): void {
    this.setLifted(false);
    if (!this._visible) return;
    this._visible = false;
    this.root.hidden = true;
  }

  dispose(): void { this.root.remove(); }
}
