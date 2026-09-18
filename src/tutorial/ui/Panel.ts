import type { TutorialGaugeInfo } from '@/shared';
import { TUTORIAL_STEP_DELAY_S, renderKeyText, tutorialCountLabel } from '@/shared';
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
 *
 * **2026-09-15 2차 (사용자 결정) — 세는 목표의 `(n/m)`.** 목표 수는 문구가 아니라 `TutorialObjective.count` 다
 * (`벌레 처치` + `count: 2` → `벌레 처치 (0/2)`). 진행이 바뀌면 `setCounts` 가 **그 숫자 노드만** 갈아 끼운다 —
 * 줄을 다시 지으면 체크가 좌→우로 그려지는 애니메이션과 취소선의 `clip-path` 전이가 매번 처음부터 다시 돈다.
 * 달성해서 그어질 때 숫자는 `(2/2)` 로 남는다 (단계가 넘어가도 줄 자체는 반 박자 동안 그대로 서 있다).
 *
 * **2026-09-18 (사용자 결정) — 진행 바가 목표를 재는 단계.** 출격 안내의 마지막 레이드에서 「몇 번째 단계인가」는 아무 말도
 * 하지 않는다 (단계가 둘뿐이다). 그 단계만 바가 **전리품 가치**를 재고(`PanelView.gauge`), 바 위에 숫자 한 줄(`.tut-bar-n`)이
 * 붙는다 — 채움은 1 에서 자르지만 **글자는 실제 값**이다 (`1,400 C / 1,000 C`). 다른 모든 단계 · 트랙은 예전 그대로다.
 * ──────────────────────────────────────────────────────────────────────────── */

/** 한 번의 `show()` 가 그리는 것 전부. */
export interface PanelView {
  /** 트랙 이름 (`조작 안내` · `함선 안내` · `증축 안내`). */
  track: string;
  objectives: readonly TutorialObjective[];
  /** 달성한 목표 id. */
  done: ReadonlySet<string>;
  /** 세는 목표(`TutorialObjective.count`)의 지금 진행 수 — 목표 id → 수. 없는 id 는 0 으로 본다. */
  counts: Readonly<Record<string, number>>;
  /** 트랙 안에서의 1-based 순번 · 단계 수 (진행 바). */
  index: number;
  count: number;
  /**
   * 진행 바가 **단계 수가 아니라 목표 자체**를 잴 때 (2026-09-18, 사용자 결정 — 출격 안내의 레이드는 「몇 번째 단계인가」가
   * 아니라 「얼마나 챙겼는가」가 진행이다). 채움은 1 에서 자르고, 바 위의 숫자 라벨은 **넘긴 값 그대로** 적는다
   * (`label` — 이미 다 적혀 온다, `model.creditGaugeLabel`). null · 생략 = 예전 그대로 `index / count`.
   */
  gauge?: TutorialGaugeInfo | null;
}

interface Row {
  el: HTMLElement;
  /** 글자 층 · 취소선 층과 그 둘에 그린 문구 (토큰 그대로 — 리바인드 때 다시 푼다). */
  txt: HTMLElement;
  strike: HTMLElement;
  text: string;
  /** 목표 수 (`TutorialObjective.count`) — 없으면 null. 있으면 두 층 끝에 ` (at/total)` 노드가 하나씩 붙는다. */
  total: number | null;
  /** 지금 그려져 있는 진행 수. */
  at: number;
  /** 진행 수의 단위 (2026-09-17, `TutorialObjective.countUnit`) — 있으면 ` (420 / 1,000 C)` 모양. */
  unit?: string;
}

/** 퀘스트 글리프 — 외부 에셋 금지라 인라인 SVG 다 (마름모 + 가운데 점). */
const QUEST_ICON = '<svg class="tut-quest-ico" viewBox="0 0 16 16" aria-hidden="true">'
  + '<path class="tut-quest-d" d="M8 1.1 14.9 8 8 14.9 1.1 8Z"/>'
  + '<path class="tut-quest-b" d="M8 4.7v4.1"/><circle class="tut-quest-p" cx="8" cy="11.2" r="0.95"/></svg>';

/** 체크박스 — 테두리 + 좌→우로 그려지는 체크 (`stroke-dashoffset`, `tutorial.css`). */
const CHECK_SVG = '<svg class="tut-obj-box" viewBox="0 0 16 16" aria-hidden="true">'
  + '<rect class="tut-obj-frame" x="1.6" y="1.6" width="12.8" height="12.8"/>'
  + '<path class="tut-obj-tick" d="M4 8.3 6.9 11.2 12.2 5.1"/></svg>';

/**
 * 세는 목표의 꼬리표 (2026-09-15 2차, 사용자 결정 — `벌레 처치 (1/2)`). 본문보다 살짝 흐리다 (`.tut-obj-n`).
 * 진행 수는 문구가 아니라 **자기 노드**가 들고 있어(`setCounts`) 세는 동안 줄을 다시 짓지 않는다 —
 * 그래서 아래 `rowKey` 에도 `count` 가 없다.
 */
// 2026-09-18: 글자를 만드는 자리는 `shared/tutorial.tutorialCountLabel` 하나다 — 지도의 같은 줄이 같은 함수를 쓴다
//   (여기서 따로 적었더니 지도 쪽이 `1000 / 1000 C` 로 어긋났다). 괄호만 이 패널의 것이다.
const countText = (at: number, total: number, unit?: string): string => ` (${tutorialCountLabel(at, total, unit)})`;

export class TutorialPanel {
  readonly root: HTMLElement;
  private readonly trackEl: HTMLElement;
  private readonly list: HTMLElement;
  private readonly fill: HTMLElement;
  /** 진행 바 위의 숫자 라벨 (2026-09-18) — `gauge` 가 있을 때만 뜬다. */
  private readonly num: HTMLElement;
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

    /* 2026-09-18: 진행 바 바로 위의 숫자 라벨 — 바가 목표 자체를 잴 때만 뜬다 (`gauge`). 평소(단계 수)에는 숨는다. */
    this.num = document.createElement('div');
    this.num.className = 'tut-bar-n ui-mono';
    this.num.hidden = true;

    const bar = document.createElement('div');
    bar.className = 'tut-bar';
    this.fill = document.createElement('i');
    bar.appendChild(this.fill);

    root.append(head, this.list, this.num, bar);
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
    this.setGauge(view.gauge ?? null, view.index, view.count);
    if (this.holdTimer !== 0 && !sameIds(this.ids, view.objectives)) { this.pending = view; return; }
    this.apply(view);
  }

  /** 실제로 목표 줄을 그린다 (미루기를 통과한 뒤). */
  private apply(view: PanelView): void {
    if (!sameIds(this.ids, view.objectives)) this.build(view.objectives);
    for (const o of view.objectives) {
      this.rows.get(o.id)?.el.classList.toggle('is-done', view.done.has(o.id));
    }
    this.setCounts(view.counts);
  }

  /**
   * **진행 바**를 고친다 (2026-09-18, 사용자 결정).
   *   • `g` 가 있으면 바는 그 목표를 잰다 — 채움은 1 에서 자르고(넘겨도 바가 넘치지 않는다) 바 위의 숫자는 **실제 값**이다
   *     (`1,400 C / 1,000 C`). 목표를 넘긴 사람에게 `1,000 C / 1,000 C` 라고 적으면 더 챙긴 것이 사라진 것처럼 보인다.
   *   • `g` 가 null 이면 예전 그대로 **단계 수**다 — 숫자 라벨은 숨는다. `index` · `count` 를 안 주면 바는 그대로 둔다
   *     (전리품을 세는 폴링이 매번 단계 수를 다시 알려 줄 필요가 없다).
   */
  setGauge(g: TutorialGaugeInfo | null, index?: number, count?: number): void {
    if (g) {
      const frac = g.total > 0 ? Math.max(0, Math.min(1, g.at / g.total)) : 0;
      this.fill.style.transform = `scaleX(${frac.toFixed(3)})`;
      if (this.num.textContent !== g.label) this.num.textContent = g.label;
      if (this.num.hidden) this.num.hidden = false;
      return;
    }
    if (!this.num.hidden) { this.num.hidden = true; this.num.textContent = ''; }
    if (index === undefined || count === undefined) return;
    const frac = count > 0 ? Math.max(0, Math.min(1, index / count)) : 0;
    this.fill.style.transform = `scaleX(${frac.toFixed(3)})`;
  }

  /**
   * 세는 목표의 진행 수를 고친다 (2026-09-15 2차, 사용자 결정 — `벌레 처치 (1/2)`).
   *
   * **줄을 다시 짓지 않고 숫자 노드만 갈아 끼운다** — `build()` 로 돌아가면 체크가 좌→우로 그려지는 애니메이션과
   * 취소선의 `clip-path` 전이가 처음부터 다시 돈다 (달성한 줄이 매 처치마다 다시 그어진다). 두 층(글자 · 취소선)의
   * 글자가 하나까지 같아야 취소선이 제 줄에 그어지므로 **양쪽 노드를 함께** 고친다.
   */
  setCounts(counts: Readonly<Record<string, number>>): void {
    for (const [id, row] of this.rows) {
      if (row.total === null) continue;
      const n = Math.max(0, Math.min(row.total, Math.round(counts[id] ?? 0)));
      if (n === row.at) continue;
      row.at = n;
      const label = countText(n, row.total, row.unit);
      for (const host of [row.txt, row.strike]) {
        const el = host.querySelector('.tut-obj-n');
        if (el) el.textContent = label;
      }
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
       * 가운데 허공에 줄이 그어진다 — 여기 문장은 346 px 패널에서도 자주 접힌다.
       * 2026-09-15: 두 층 모두 `renderKeyText` 로 그린다 — 키캡까지 같은 자리에 서야 두 층이 겹친다.
       */
      const txt = document.createElement('span');
      txt.className = 'tut-obj-txt';
      const strike = document.createElement('span');
      strike.className = 'tut-obj-strike';
      strike.setAttribute('aria-hidden', 'true');
      label.append(txt, strike);
      el.appendChild(label);
      const row: Row = { el, txt, strike, text, total: o.count ?? null, at: 0, unit: o.countUnit };
      this.paint(row);
      this.list.appendChild(el);
      this.rows.set(o.id, row);
    }
  }

  /**
   * 한 줄의 두 층(글자 · 취소선)을 **같은 내용**으로 그린다 — 키캡도 `(n/m)` 도 같은 자리에 서야 취소선이
   * 제 줄에 그어진다 (`clip-path` 가 글자 층 위를 좌→우로 벗겨 낸다).
   */
  private paint(row: Row): void {
    for (const host of [row.txt, row.strike]) {
      renderKeyText(host, row.text);
      if (row.total === null) continue;
      const n = document.createElement('i');
      n.className = 'tut-obj-n';
      n.textContent = countText(row.at, row.total, row.unit);
      host.appendChild(n);
    }
  }

  /** 리바인드 — 목표 줄 안의 키캡을 살아 있는 `Keys` 로 다시 그린다 (달성 표시 · 줄 요소 · 진행 수는 그대로). */
  relabel(): void {
    for (const row of this.rows.values()) this.paint(row);
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
const rowKey = (o: TutorialObjective): string => `${o.id} ${o.text}`;

const sameIds = (ids: readonly string[], objectives: readonly TutorialObjective[]): boolean =>
  ids.length === objectives.length && objectives.every((o, i) => ids[i] === rowKey(o));
