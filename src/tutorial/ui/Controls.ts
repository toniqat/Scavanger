import { Keys, keyLabel } from '@/shared';
import { CONTROLS_TITLE_KO, type ControlHint } from '../model';

/* ────────────────────────────────────────────────────────────────────────────
 * src/tutorial/ui/Controls.ts — **우측 조작 가이드** (2026-09-14, `docs/plans/tutorial-raid.md` C).
 *
 * 배운 조작이 한 줄씩 쌓이고 **사라지지 않는다**. 우하단 키 가이드(`ui/hud/KeyGuide`, `.key-guide`)와는 주인도
 * 자리도 다르다 — 그쪽은 "지금 열린 화면의 키"라 매번 갈리고, 이쪽은 누적이라 화면 **우측 세로 가운데**에 선다
 * (`tutorial.css` — 위의 메신저 버튼 · 아래의 무기 패널 어느 쪽과도 겹치지 않는다).
 *
 * 키 라벨은 **그릴 때 `Keys` 에서 읽는다** (`docs/CONTROLS.md`: 키를 모듈 상수로 캐시하지 않는다).
 * 리바인드하면 `TutorialSystem` 이 `input:bindingsChanged` 에 `relabel()` 을 부른다.
 *
 * ⚠ 키캡 modifier 는 `.keycap.kc-hold` 를 그대로 쓴다 — HUD 위젯과 같은 이름의 클래스를 새로 만들지 않는다
 * (2026-09-10 `kc-hold` 사고: `.hold` 가 크로스헤어 홀드 링과 겹쳐 키캡이 통째로 사라졌다).
 * ──────────────────────────────────────────────────────────────────────────── */

interface Row {
  el: HTMLElement;
  caps: HTMLElement[];
  hint: ControlHint;
}

export class TutorialControls {
  readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private readonly rows = new Map<string, Row>();
  private _visible = false;

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
    const keys = document.createElement('span');
    keys.className = 'tut-ctl-keys';
    const caps: HTMLElement[] = [];
    for (const _ of hint.keys) {
      const cap = document.createElement('span');
      cap.className = hint.hold ? 'keycap kc-hold' : 'keycap';
      keys.appendChild(cap);
      caps.push(cap);
    }
    const label = document.createElement('span');
    label.className = 'tut-ctl-label';
    label.textContent = hint.label;
    el.append(keys, label);
    this.list.appendChild(el);
    const row: Row = { el, caps, hint };
    this.rows.set(hint.id, row);
    this.relabelRow(row);
    // 새 줄 강조는 한 번만 — 애니메이션이 끝나면 평범한 줄이 된다 (기록이지 알림이 아니다)
    window.setTimeout(() => el.classList.remove('is-new'), 1400);
    this.show(true);
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
    row.hint.keys.forEach((action, i) => {
      const cap = row.caps[i];
      const text = keyLabel(Keys[action]);
      if (cap.textContent !== text) cap.textContent = text;
    });
  }

  /** 보이기 / 숨기기. 줄이 하나도 없으면 언제나 숨는다. */
  show(on: boolean): void {
    const want = on && this.rows.size > 0;
    if (want === this._visible) return;
    this._visible = want;
    this.root.hidden = !want;
  }

  /** 트랙이 끝났다 — 다음에 다시 켜질 때 처음부터 쌓는다. */
  clear(): void {
    this.rows.clear();
    this.list.replaceChildren();
    this.show(false);
  }

  dispose(): void { this.root.remove(); }
}
