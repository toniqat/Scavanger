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
 * ──────────────────────────────────────────────────────────────────────────── */

export class TutorialPanel {
  readonly root: HTMLElement;
  private readonly label: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly skipBtn: HTMLButtonElement;
  private _visible = false;

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

  show(def: StepDef, index: number, count: number): void {
    this.label.textContent = `튜토리얼 ${index} / ${count}`;
    if (this.titleEl.textContent !== def.title) this.titleEl.textContent = def.title;
    if (this.hintEl.textContent !== def.hint) this.hintEl.textContent = def.hint;
    const frac = count > 0 ? Math.max(0, Math.min(1, index / count)) : 0;
    this.fill.style.transform = `scaleX(${frac.toFixed(3)})`;
    if (!this._visible) { this._visible = true; this.root.hidden = false; }
  }

  hide(): void {
    if (!this._visible) return;
    this._visible = false;
    this.root.hidden = true;
  }

  dispose(): void { this.root.remove(); }
}
