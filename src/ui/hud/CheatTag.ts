import type { GameContext } from '@/shared';
import { el, toggleClass } from '../dom';

/**
 * Corner tag `MOVE CHEAT` (`.cheat-tag`, top-right) shown while the console's `/movecheat` is on (`cheat:moveCheat`).
 * Lives in the social layer so it is visible in the ship as well as on the planet. Nothing else touches it — a cheat
 * stays on across missions until the console turns it off.
 */
export class CheatTag {
  readonly root: HTMLElement;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'cheat-tag ui-mono', text: 'MOVE CHEAT', parent });
  }

  bind(ctx: GameContext): void {
    this.unsubs.push(ctx.bus.on('cheat:moveCheat', ({ enabled }) => toggleClass(this.root, 'show', enabled)));
  }

  /** Whether the tag is showing (debug). */
  get isOn(): boolean { return this.root.classList.contains('show'); }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
