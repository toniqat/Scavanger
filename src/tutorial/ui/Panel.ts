import { TUTORIAL_STEP_DELAY_S, renderKeyText } from '@/shared';
import { OPTIONAL_PREFIX_KO, type TutorialObjective } from '../model';

/* ────────────────────────────────────────────────────────────────────────────
 * src/tutorial/ui/Panel.ts — **튜토리얼 목표 패널** (좌측 상단).
 *
 * 레이드의 계약 패널(`ui/hud/ContractPanel`)과 같은 자리 · 같은 결이지만 그 코드를 쓰지 않는다 — 계약 패널은
 * 게임플레이 레이어에 속해 함선에서는 숨겨지고, 이 패널은 반대로 **함선과 튜토리얼 레이드에서만** 뜬다.
 *
 * **2026-09-14 2차 (사용자 결정) — 퀘스트 패널처럼 생겼다.**
 *
 *   [◇] 조작 안내              ← 트랙 이름 (강조색) + 퀘스트 글리프
 *    ☐  갈라진 땅까지 걸어간다   ← 목표 줄 (체크박스 + 설명)
 *    ☐  (선택) 수류탄으로 …
 *   ▓▓▓▓▓░░░░░░                ← 트랙 전체 진행도
 *
 * 바뀐 것 셋:
 *   ① **`조작 안내 n / m` 글자 라벨이 없다** — 그 자리를 아래의 진행 바가 대신한다 (진행도는 예전 그대로
 *      `index / count`, 즉 **트랙 안에서의 단계 수**다).
 *   ② **제목 + 부제 두 줄이 목표 줄 목록으로** 바뀌었다. 한 단계가 목표를 여럿 가질 수 있고 그 중 일부는
 *      선택이다 (`StepDef.objectives`, 없으면 부제 한 줄이 유일한 필수 목표).
 *   ③ **건너뛰기 버튼이 없다** — 건너뛰기는 ESC 메뉴로 옮겼다 (`TutorialRef.skipTrack`). 시작 카드의
 *      `건너뛰기` 는 그대로다. `setLifted` / `is-lifted` 는 상태 표시로 남는다 (스모크가 본다).
 *
 * **2026-09-14 3차 — 순차 공개.** 아직 안 열린 목표 줄은 **넘어오지도 않는다**: 고르는 것은 순수 함수
 * `model.visibleObjectives(list, done)` 이고 `TutorialSystem` 이 그것을 통과시킨 목록만 `show()` 에 넘긴다.
 * 그래서 이 파일은 「받은 줄을 그린다」 하나만 알면 되고, 줄이 하나 열리면 `sameIds` 가 달라져 다시 짓는다 —
 * 그 타이밍은 아래 `markDone` 의 반 박자가 잡아 준다 (체크 · 취소선이 그려진 **뒤에** 새 줄이 나타난다).
 *
 * **달성 애니메이션이 보이게 반 박자 잡는다.** 단계가 넘어가면 시스템이 먼저 `markDone()` 으로 그 단계의 필수
 * 목표에 체크 · 취소선을 그리고, 그 직후 도착하는 다음 단계의 `show()` 는 `TUTORIAL_STEP_DELAY_S`(csv, 0.5초)
 * 동안 **패널 안에서** 미뤄진다 — 스포트라이트 · 바닥 안내선이 이미 쓰고 있는 그 창이다. 단계 기계의 타이밍은
 * 한 글자도 안 바뀐다 (여기서 미루는 것은 **그리기**뿐이다).
 *
 * **2026-09-09 — 패널은 언제나 화면들 위에 있다.** z-index 는 `is-lifted` 와 무관하게 79 로 고정이다
 * (`tutorial.css`). 예전에는 24 였다가 포커싱 중에만 79 로 올라가서, 대상을 못 찾은 순간마다 인벤토리 창
 * (`.inv-root`, z 50, 배경 블러)이 패널을 **통째로 덮어** 목표가 사라졌다.
 *
 * **2026-09-15 (사용자 결정) — 목표 줄 안의 키캡 · 선택 목표는 회색이 아니다.**
 *   ① 목표 문구가 **키캡 토큰**(`{QUICK:hold}` …)을 담는다 — `shared/keycap.renderKeyText` 가 글자 층(`.tut-obj-txt`)과
 *      취소선 층(`.tut-obj-strike`) **둘 다**에 같은 키캡을 끼워 넣는다. 두 층의 배치가 글자 하나까지 같아야 취소선이
 *      제 줄에 그어지기 때문이다. 리바인드하면 `relabel()` 이 두 층을 다시 그린다.
 *   ② **회색은 달성한 줄만**이다 — 선택 목표도 달성 전에는 필수와 같은 색이다 (`(선택)` 접두사는 그대로).
 * ──────────────────────────────────────────────────────────────────────────── */

/** 한 번의 `show()` 가 그리는 것 전부. */
export interface PanelView {
  /** 트랙 이름 (`조작 안내` · `함선 안내` · `증축 안내`). */
  track: string;
  objectives: readonly TutorialObjective[];
  /** 달성한 목표 id. */
  done: ReadonlySet<string>;
  /** 트랙 안에서의 1-based 순번 · 단계 수 (진행 바). */
  index: number;
  count: number;
}

interface Row {
  el: HTMLElement;
  /** 글자 층 · 취소선 층과 그 둘에 그린 문구 (토큰 그대로 — 리바인드 때 다시 푼다). */
  txt: HTMLElement;
  strike: HTMLElement;
  text: string;
}

/** 퀘스트 글리프 — 외부 에셋 금지라 인라인 SVG 다 (마름모 + 가운데 점). */
const QUEST_ICON = '<svg class="tut-quest-ico" viewBox="0 0 16 16" aria-hidden="true">'
  + '<path class="tut-quest-d" d="M8 1.1 14.9 8 8 14.9 1.1 8Z"/>'
  + '<path class="tut-quest-b" d="M8 4.7v4.1"/><circle class="tut-quest-p" cx="8" cy="11.2" r="0.95"/></svg>';

/** 체크박스 — 테두리 + 좌→우로 그려지는 체크 (`stroke-dashoffset`, `tutorial.css`). */
const CHECK_SVG = '<svg class="tut-obj-box" viewBox="0 0 16 16" aria-hidden="true">'
  + '<rect class="tut-obj-frame" x="1.6" y="1.6" width="12.8" height="12.8"/>'
  + '<path class="tut-obj-tick" d="M4 8.3 6.9 11.2 12.2 5.1"/></svg>';

export class TutorialPanel {
  readonly root: HTMLElement;
  private readonly trackEl: HTMLElement;
  private readonly list: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly rows = new Map<string, Row>();
  /** 지금 그려져 있는 목표 줄의 `id + 문구` (순서 그대로) — 같으면 다시 짓지 않는다 (애니메이션이 끊기지 않게). */
  private ids: string[] = [];
  private _visible = false;
  private _lifted = false;
  /** 달성 애니메이션을 보여 주는 동안 새 목표 줄을 미뤄 둔다. */
  private holdTimer = 0;
  private pending: PanelView | null = null;

  constructor(parent: HTMLElement) {
    const root = this.root = document.createElement('div');
    root.className = 'tut-panel';
    root.hidden = true;

    const head = document.createElement('div');
    head.className = 'tut-head';
    head.innerHTML = QUEST_ICON;
    this.trackEl = document.createElement('span');
    this.trackEl.className = 'tut-track';
    head.appendChild(this.trackEl);

    this.list = document.createElement('div');
    this.list.className = 'tut-objs';

    const bar = document.createElement('div');
    bar.className = 'tut-bar';
    this.fill = document.createElement('i');
    bar.appendChild(this.fill);

    root.append(head, this.list, bar);
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

  /**
   * 목표를 달성 표시한다 (**지금 그려져 있는 줄만**). 하나라도 새로 체크됐으면 그 애니메이션이 보이도록
   * `TUTORIAL_STEP_DELAY_S` 동안 다음 `show()` 를 붙잡는다 — 단계가 넘어가는 순간의 체크 · 취소선이
   * 한 프레임 만에 지워지지 않게 하는 것이 이 반 박자의 전부다.
   */
  markDone(ids: readonly string[]): void {
    let any = false;
    for (const id of ids) {
      const row = this.rows.get(id);
      if (!row || row.el.classList.contains('is-done')) continue;
      row.el.classList.add('is-done');
      any = true;
    }
    if (!any) return;
    window.clearTimeout(this.holdTimer);
    this.holdTimer = window.setTimeout(() => {
      this.holdTimer = 0;
      const next = this.pending;
      this.pending = null;
      if (next) this.apply(next);
    }, TUTORIAL_STEP_DELAY_S * 1000);
  }

  show(view: PanelView): void {
    if (!this._visible) { this._visible = true; this.root.hidden = false; }
    // 진행 바 · 트랙 이름은 **미루지 않는다** — "한 칸 나아갔다"가 곧 보상이다. 미루는 것은 목표 줄뿐이다.
    if (this.trackEl.textContent !== view.track) this.trackEl.textContent = view.track;
    const frac = view.count > 0 ? Math.max(0, Math.min(1, view.index / view.count)) : 0;
    this.fill.style.transform = `scaleX(${frac.toFixed(3)})`;
    if (this.holdTimer !== 0 && !sameIds(this.ids, view.objectives)) { this.pending = view; return; }
    this.apply(view);
  }

  /** 실제로 목표 줄을 그린다 (미루기를 통과한 뒤). */
  private apply(view: PanelView): void {
    if (!sameIds(this.ids, view.objectives)) this.build(view.objectives);
    for (const o of view.objectives) {
      this.rows.get(o.id)?.el.classList.toggle('is-done', view.done.has(o.id));
    }
  }

  private build(objectives: readonly TutorialObjective[]): void {
    this.rows.clear();
    this.list.replaceChildren();
    this.ids = objectives.map(rowKey);
    for (const o of objectives) {
      const el = document.createElement('div');
      el.className = o.optional ? 'tut-obj is-optional' : 'tut-obj';
      el.dataset.obj = o.id;
      el.innerHTML = CHECK_SVG;
      const text = (o.optional ? OPTIONAL_PREFIX_KO : '') + o.text;
      const label = document.createElement('span');
      label.className = 'tut-obj-label';
      /*
       * 취소선은 **똑같은 글자를 한 겹 더 깔고**(`.tut-obj-strike`, `text-decoration: line-through`)
       * `clip-path` 로 좌→우로 벗겨 낸다. `::after` 의 가로 막대 하나로는 **두 줄로 접힌 목표**에서
       * 가운데 허공에 줄이 그어진다 — 여기 문장은 288 px 패널에서 자주 접힌다.
       * 2026-09-15: 두 층 모두 `renderKeyText` 로 그린다 — 키캡까지 같은 자리에 서야 두 층이 겹친다.
       */
      const txt = document.createElement('span');
      txt.className = 'tut-obj-txt';
      const strike = document.createElement('span');
      strike.className = 'tut-obj-strike';
      strike.setAttribute('aria-hidden', 'true');
      renderKeyText(txt, text);
      renderKeyText(strike, text);
      label.append(txt, strike);
      el.appendChild(label);
      this.list.appendChild(el);
      this.rows.set(o.id, { el, txt, strike, text });
    }
  }

  /** 리바인드 — 목표 줄 안의 키캡을 살아 있는 `Keys` 로 다시 그린다 (달성 표시 · 줄 요소는 그대로). */
  relabel(): void {
    for (const row of this.rows.values()) {
      renderKeyText(row.txt, row.text);
      renderKeyText(row.strike, row.text);
    }
  }

  hide(): void {
    this.setLifted(false);
    window.clearTimeout(this.holdTimer);
    this.holdTimer = 0;
    this.pending = null;
    if (!this._visible) return;
    this._visible = false;
    this.root.hidden = true;
  }

  dispose(): void {
    window.clearTimeout(this.holdTimer);
    this.root.remove();
  }
}

/** 줄 하나의 정체 — id 가 같아도 문구가 바뀌면 다시 짓는다. */
const rowKey = (o: TutorialObjective): string => `${o.id} ${o.text}`;

const sameIds = (ids: readonly string[], objectives: readonly TutorialObjective[]): boolean =>
  ids.length === objectives.length && objectives.every((o, i) => ids[i] === rowKey(o));
