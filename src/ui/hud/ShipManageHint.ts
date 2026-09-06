import type { GameContext } from '@/shared';
import { Keys, keyLabel } from '@/shared';
import { el, setText, toggleClass } from '../dom';

/**
 * 함선 관리 key hint (`.ship-hint`, bottom-right of the **social** layer — the layer that stays visible in the ship).
 * Persistent while the player stands in the ship (`ctx.isHubPhase()`) with no UI blocker up, reading `함선 관리` plus the
 * live `Keys.MAP` label in a `.keycap` (M by default; refreshed on `input:bindingsChanged`, never cached).
 *
 * It hides itself while 함선 관리 is already open (`ctx.housing.shipManageMode`) — the room list / furniture bar of
 * `hud/ShipManage` occupies that corner then and the hint would only repeat what is on screen.
 * Takes no blocker token and never intercepts pointer events.
 */
export class ShipManageHint {
  readonly root: HTMLElement;
  private keyEl: HTMLElement;
  private shown = false;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'ship-hint', parent });
    el('span', { cls: 't', text: '함선 관리', parent: this.root });
    this.keyEl = el('span', { cls: 'keycap', text: keyLabel(Keys.MAP), parent: this.root });
  }

  bind(ctx: GameContext): void {
    this.unsubs.push(ctx.bus.on('input:bindingsChanged', () => this.refreshKey()));
  }

  /** Whether the hint is showing (debug). */
  get isShowing(): boolean { return this.shown; }

  update(ctx: GameContext): void {
    const on = ctx.isHubPhase() && ctx.uiBlockers.size === 0 && !(ctx.housing?.shipManageMode ?? false);
    if (on === this.shown) return;
    this.shown = on;
    toggleClass(this.root, 'show', on);
  }

  private refreshKey(): void {
    setText(this.keyEl, keyLabel(Keys.MAP));
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
