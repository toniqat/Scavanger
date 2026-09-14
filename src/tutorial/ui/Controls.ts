import type { KeyBindings } from '@/shared';
import { Keys, keyLabel } from '@/shared';
import { CONTROL_SECTIONS, CONTROLS_TITLE_KO, hintPairs, type ControlHint, type ControlSection } from '../model';

/* ────────────────────────────────────────────────────────────────────────────
 * src/tutorial/ui/Controls.ts — **우측 조작 가이드** (2026-09-14, `docs/DECISIONS.md` 「2026-09-14 — 튜토리얼 개편」).
 *
 * 우하단 키 가이드(`ui/hud/KeyGuide`, `.key-guide`)와는 주인도 자리도 다르다 — 그쪽은 "지금 열린 **화면**의 키"라
 * 화면이 열리고 닫힐 때마다 갈리고, 이쪽은 "지금 **구간**에서 쓰는 조작"이다.
 *
 * **2026-09-14 3차 (사용자 결정) — 누적이 아니라 교체.** 예전에는 배운 줄이 쌓이기만 해서 레이드 끝에는
 * 여덟 줄이 우측을 채웠고 정작 지금 배우는 키가 그 안에 파묻혔다. 이제 `set(hints)` 하나가 「이 단계에 보일 줄」
 * 전부를 받아 **없는 줄은 지우고 · 새 줄은 넣고 · 남는 줄은 문구만 고친다**. 줄 요소를 다시 만들지 않으므로
 * 단계가 바뀌어도 살아남은 줄이 깜빡이지 않고, 자세에 따라 바뀌는 라벨(`앉기` ↔ `일어서기`)도 같은 길로 간다.
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

  /**
   * **이 단계에 보일 줄 전부**로 갈아 끼운다 (2026-09-14 3차). 살아남는 줄은 요소를 그대로 두고 문구만 고치므로
   * 단계가 바뀌어도 깜빡이지 않고, 없어진 줄은 그 자리에서 사라진다. 빈 구간 상자는 함께 치운다 —
   * 구분선이 `.tut-ctl-sec + .tut-ctl-sec` 한 줄이라 빈 상자가 남으면 맨 위에 선이 그어진다.
   */
  set(hints: readonly ControlHint[]): void {
    const want = new Set(hints.map((h) => h.id));
    for (const [id, row] of [...this.rows]) {
      if (want.has(id)) continue;
      row.el.remove();
      this.rows.delete(id);
    }
    for (const h of hints) {
      const have = this.rows.get(h.id);
      if (have) this.render(have, h);
      else this.add(h);
    }
    this.order(hints);
    this.prune();
    this.apply();
  }

  /** 한 줄 추가 — 이미 있으면 아무 일도 없다. */
  add(hint: ControlHint): void {
    if (this.rows.has(hint.id)) return;
    const el = document.createElement('div');
    el.className = 'tut-ctl is-new';
    el.dataset.hint = hint.id;
    const row: Row = { el, caps: [], hint };
    this.render(row, hint);
    this.sectionEl(sectionOf(hint)).appendChild(el);
    this.rows.set(hint.id, row);
    // 새 줄 강조는 한 번만 — 애니메이션이 끝나면 평범한 줄이 된다 (기록이지 알림이 아니다)
    window.setTimeout(() => el.classList.remove('is-new'), 1400);
    // ⚠ 여기서 `show(true)` 를 부르지 않는다 (2026-09-14 2차) — 인벤토리 화면이 열려 있는 동안에는 접혀 있어야
    //   하는데, 그 사이에 줄이 하나 늘면 패널이 스스로 다시 떠 버린다. 보이고 말고는 `show()` 의 뜻만 따른다.
    this.apply();
  }

  /** 줄의 내용(키캡 · 문구)을 다시 짓는다 — 요소 자체는 그대로라 애니메이션 · 자리가 유지된다. */
  private render(row: Row, hint: ControlHint): void {
    row.hint = hint;
    row.caps = [];
    const frag = document.createDocumentFragment();
    hintPairs(hint).forEach((pair, i) => {
      if (i > 0) frag.appendChild(Object.assign(document.createElement('span'), { className: 'tut-ctl-sep' }));
      const keys = document.createElement('span');
      keys.className = 'tut-ctl-keys';
      for (const action of pair.keys) {
        const cap = document.createElement('span');
        cap.className = pair.hold ? 'keycap kc-hold' : 'keycap';
        keys.appendChild(cap);
        row.caps.push({ el: cap, action });
      }
      const label = document.createElement('span');
      label.className = 'tut-ctl-label';
      label.textContent = pair.label;
      frag.append(keys, label);
    });
    row.el.replaceChildren(frag);
    this.relabelRow(row);
  }

  /** 구간 안의 줄 순서를 표와 맞춘다 (이미 맞으면 DOM 을 건드리지 않는다 — 옮기면 애니메이션이 다시 돈다). */
  private order(hints: readonly ControlHint[]): void {
    for (const [section, box] of this.sections) {
      const want = hints.filter((h) => sectionOf(h) === section)
        .map((h) => this.rows.get(h.id)?.el).filter((el): el is HTMLElement => !!el);
      const have = [...box.children];
      if (have.length === want.length && want.every((el, i) => have[i] === el)) continue;
      box.replaceChildren(...want);
    }
  }

  /** 줄이 하나도 안 남은 구간 상자를 치운다. */
  private prune(): void {
    for (const [section, box] of [...this.sections]) {
      if (box.childElementCount > 0) continue;
      box.remove();
      this.sections.delete(section);
    }
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
    this.set(hints);
    for (const h of hints) this.rows.get(h.id)?.el.classList.remove('is-new');
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
