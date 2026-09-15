import type { GameContext } from '@/shared';
import { el, setText } from './dom';

/**
 * 분대 도킹 카운트다운 (2026-09-15, 분대 · 도킹 매칭) — 분대장이 공용 함선에 도킹한 뒤 분대원 화면 **오른쪽**에 뜨는 작은
 * 판: 한 줄 안내 + 큰 숫자. 규칙(언제 뜨고 · 세고 · 취소되나)은 `parts/SquadDock` 이 갖고 이 파일은 그리기만 한다.
 * 연출이지 화면이 아니다 — blocker 도 `ctx.escape` 항목도 아니고 포인터를 먹지 않는다 (`pointer-events: none`).
 * CSS 접두사 `hsd-` (`hub.css` 의 끝 블록).
 */
export class SquadDockCountdown {
  private readonly root: HTMLElement;
  private readonly num: HTMLElement;
  private shownSeconds = -1;

  constructor(ctx: GameContext) {
    this.root = el('div', { cls: 'hub-squad-dock', parent: ctx.uiRoot });
    this.root.hidden = true;
    el('div', { cls: 'hsd-kicker', text: '분대 도킹', parent: this.root });
    el('div', { cls: 'hsd-label', text: '분대장이 공용 함선으로 이동합니다', parent: this.root });
    this.num = el('div', { cls: 'hsd-num', parent: this.root });
    el('div', { cls: 'hsd-sub', text: '열린 화면이 모두 닫히고 도킹합니다', parent: this.root });
  }

  /** Show (or update) the big number. Writes the DOM only when the second changes. */
  show(seconds: number): void {
    const s = Math.max(0, Math.round(seconds));
    if (this.root.hidden) this.root.hidden = false;
    if (s === this.shownSeconds) return;
    this.shownSeconds = s;
    setText(this.num, String(s));
    // restart the pulse on every new digit (the animation name is shared with the launch countdown)
    this.num.classList.remove('tick');
    void this.num.offsetWidth;
    this.num.classList.add('tick');
  }

  hide(): void {
    if (this.root.hidden) return;
    this.root.hidden = true;
    this.shownSeconds = -1;
  }

  /** Debug / smoke: the digit on screen, or −1 while hidden. */
  get seconds(): number { return this.root.hidden ? -1 : this.shownSeconds; }

  dispose(): void { this.root.remove(); }
}
