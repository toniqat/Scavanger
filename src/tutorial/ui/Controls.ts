import type { KeyBindings } from '@/shared';
import { Keys, keyLabel } from '@/shared';
import { CONTROL_SECTIONS, CONTROLS_TITLE_KO, hintPairs, type ControlHint, type ControlSection } from '../model';

/* ────────────────────────────────────────────────────────────────────────────
 * src/tutorial/ui/Controls.ts — **우측 조작 가이드** (2026-09-14, `docs/plans/tutorial-raid.md` C).
 *
 * 배운 조작이 한 줄씩 쌓이고 **사라지지 않는다**. 우하단 키 가이드(`ui/hud/KeyGuide`, `.key-guide`)와는 주인도
 * 자리도 다르다 — 그쪽은 "지금 열린 화면의 키"라 매번 갈리고, 이쪽은 누적이다.
 *
 * **2026-09-14 2차 (사용자 결정) — 조작별 구간 · 한 줄에 쌍 둘 · 자리 재조정.**
 *   ① 줄이 **배운 순서가 아니라 구간 순서**로 쌓인다 (`CONTROL_SECTIONS`: 이동 / 화면 / 전투 / 장비).
 *      구간 상자는 **첫 줄이 들어올 때 생기고** 자기 자리에 끼워지므로, 비어 있는 구간은 DOM 에 아예 없다 —
 *      그래서 구분선을 `.tut-ctl-sec + .tut-ctl-sec` 한 줄로 그릴 수 있다 (`:empty` + 인접 선택자는 숨겨진
 *      상자를 그대로 세어 맨 위에 선을 남긴다). **해금은 여전히 줄마다 따로**다.
 *   ② 한 줄이 쌍을 여럿 가질 수 있다 (`ControlHint.more` — `LMB 사격 / RMB 정조준`).
 *   ③ 자리는 `tutorial.css` — 우하단 무기 패널 · 퀵슬롯 **위**로 뺐다.
 *
 * 키 라벨은 **그릴 때 `Keys` 에서 읽는다** (`docs/CONTROLS.md`: 키를 모듈 상수로 캐시하지 않는다).
 * 리바인드하면 `TutorialSystem` 이 `input:bindingsChanged` 에 `relabel()` 을 부른다.
 *
 * ⚠ 키캡 modifier 는 `.keycap.kc-hold` 를 그대로 쓴다 — HUD 위젯과 같은 이름의 클래스를 새로 만들지 않는다
 * (2026-09-10 `kc-hold` 사고: `.hold` 가 크로스헤어 홀드 링과 겹쳐 키캡이 통째로 사라졌다).
 * ──────────────────────────────────────────────────────────────────────────── */

interface Cap { el: HTMLElement; action: keyof KeyBindings }

interface Row {
  el: HTMLElement;
  caps: Cap[];
  hint: ControlHint;
}

const sectionOf = (h: ControlHint): ControlSection => h.section ?? 'gear';

export class TutorialControls {
  readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private readonly rows = new Map<string, Row>();
  /** 구간 상자 — **줄이 들어올 때만** 만든다 (빈 구간은 DOM 에 없다 → 구분선도 없다). */
  private readonly sections = new Map<ControlSection, HTMLElement>();
  private _visible = false;
  /** `show()` 가 말한 뜻 (실제 표시는 줄이 하나라도 있을 때만). */
  private want = false;

  constructor(parent: HTMLElement) {
    const root = this.root = document.createElement('div');
    root.className = 'tut-controls';
    root.hidden = true;

    const head = document.createElement('div');
    head.className = 'ui-label tut-ctl-head';
    head.textContent = CONTROLS_TITLE_KO;

    this.list = document.createElement('div');
    this.list.className = 'tut-ctl-list';

    root.append(head, this.list);
    parent.appendChild(root);
  }

  get visible(): boolean { return this._visible; }
  /** 지금 쌓여 있는 줄의 id (저장 · 스모크). */
  get ids(): string[] { return [...this.rows.keys()]; }

  /** 한 줄 추가 — 이미 있으면 아무 일도 없다 (**지우는 길은 `clear()` 뿐이다**). */
  add(hint: ControlHint): void {
    if (this.rows.has(hint.id)) return;
    const el = document.createElement('div');
    el.className = 'tut-ctl is-new';
    el.dataset.hint = hint.id;
    const caps: Cap[] = [];
    hintPairs(hint).forEach((pair, i) => {
      if (i > 0) el.appendChild(Object.assign(document.createElement('span'), { className: 'tut-ctl-sep' }));
      const keys = document.createElement('span');
      keys.className = 'tut-ctl-keys';
      for (const action of pair.keys) {
        const cap = document.createElement('span');
        cap.className = pair.hold ? 'keycap kc-hold' : 'keycap';
        keys.appendChild(cap);
        caps.push({ el: cap, action });
      }
      const label = document.createElement('span');
      label.className = 'tut-ctl-label';
      label.textContent = pair.label;
      el.append(keys, label);
    });
    this.sectionEl(sectionOf(hint)).appendChild(el);
    const row: Row = { el, caps, hint };
    this.rows.set(hint.id, row);
    this.relabelRow(row);
    // 새 줄 강조는 한 번만 — 애니메이션이 끝나면 평범한 줄이 된다 (기록이지 알림이 아니다)
    window.setTimeout(() => el.classList.remove('is-new'), 1400);
    // ⚠ 여기서 `show(true)` 를 부르지 않는다 (2026-09-14 2차) — 인벤토리 화면이 열려 있는 동안에는 접혀 있어야
    //   하는데, 그 사이에 줄이 하나 늘면 패널이 스스로 다시 떠 버린다. 보이고 말고는 `show()` 의 뜻만 따른다.
    this.apply();
  }

  /** 그 구간의 상자 — 없으면 만들어 **구간 순서에 맞는 자리**에 끼운다. */
  private sectionEl(section: ControlSection): HTMLElement {
    const have = this.sections.get(section);
    if (have) return have;
    const el = document.createElement('div');
    el.className = 'tut-ctl-sec';
    el.dataset.sec = section;
    const at = CONTROL_SECTIONS.indexOf(section);
    let before: HTMLElement | null = null;
    for (const s of CONTROL_SECTIONS) {
      if (CONTROL_SECTIONS.indexOf(s) <= at) continue;
      const next = this.sections.get(s);
      if (next) { before = next; break; }
    }
    this.list.insertBefore(el, before);
    this.sections.set(section, el);
    return el;
  }

  /** 여러 줄을 한 번에 (저장에서 되살릴 때 — 강조 없이). */
  restore(hints: readonly ControlHint[]): void {
    for (const h of hints) {
      this.add(h);
      this.rows.get(h.id)?.el.classList.remove('is-new');
    }
  }

  /** 리바인드 — 키캡 글자를 살아 있는 `Keys` 에서 다시 읽는다. */
  relabel(): void { for (const row of this.rows.values()) this.relabelRow(row); }

  private relabelRow(row: Row): void {
    for (const cap of row.caps) {
      const text = keyLabel(Keys[cap.action]);
      if (cap.el.textContent !== text) cap.el.textContent = text;
    }
  }

  /** 보이기 / 숨기기. 줄이 하나도 없으면 언제나 숨는다. */
  show(on: boolean): void {
    this.want = on;
    this.apply();
  }

  private apply(): void {
    const want = this.want && this.rows.size > 0;
    if (want === this._visible) return;
    this._visible = want;
    this.root.hidden = !want;
  }

  /** 트랙이 끝났다 — 다음에 다시 켜질 때 처음부터 쌓는다. */
  clear(): void {
    this.rows.clear();
    this.sections.clear();
    this.list.replaceChildren();
    this.show(false);
  }

  dispose(): void { this.root.remove(); }
}
