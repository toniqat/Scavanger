import type { GameContext } from '@/shared';
import { el, setText } from './dom';

/**
 * The squad docking countdown (2026-09-15, squad docking) — the small plate that appears on the **right** of a
 * squadmate's screen once the leader has docked into the shared ship: one line of text + a big number. The rules (when
 * it appears · counts · is cancelled) belong to `parts/SquadDock`; this file only draws. It is a presentation, not a
 * screen — no blocker, no `ctx.escape` entry, and it eats no pointer (`pointer-events: none`).
 * CSS prefix `hsd-` (the last block of `hub.css`).
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
