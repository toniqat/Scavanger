import type { GameContext } from '@/shared';
import { Keys, keyLabel } from '@/shared';
import { el, setText, toggleClass } from '../dom';
import type { CutsceneWatch } from './CutsceneWatch';

/**
 * 시설 관리 key hint (`.ship-hint`, bottom-right of the **social** layer — the layer that stays visible in the ship).
 * Persistent while the player stands in the ship (`ctx.isHubPhase()`) with no UI blocker up, reading `시설 관리` plus
 * the live `Keys.MAP` label in a `.keycap` (M by default; refreshed on `input:bindingsChanged`, never cached).
 * (Phase 8 UI pass renamed it from 함선 관리 — the Tab 함선 tab is the 함선 관리 screen, this key opens 시설 관리.)
 *
 * It hides itself while 시설 관리 is already open (`ctx.housing.shipManageMode`) — the room list / furniture bar of
 * `hud/ShipManage` occupies that corner then and the hint would only repeat what is on screen.
 * **Phase 12:** it also stays hidden on the **shared ship** (there is no 시설 관리 there — the rooms are the personal
 * ship's) and for the length of a docking / warp **cutscene** (`CutsceneWatch`: `hub:docking` / `hub:travel` start →
 * end, phase `'docking'`, `ctx.hub.travelling`). Takes no blocker token and never intercepts pointer events.
 */
export class ShipManageHint {
  readonly root: HTMLElement;
  private keyEl: HTMLElement;
  private shown = false;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement, private cutscene: CutsceneWatch | null = null) {
    this.root = el('div', { cls: 'ship-hint', parent });
    el('span', { cls: 't', text: '시설 관리', parent: this.root });
    this.keyEl = el('span', { cls: 'keycap', text: keyLabel(Keys.MAP), parent: this.root });
  }

  bind(ctx: GameContext): void {
    this.unsubs.push(ctx.bus.on('input:bindingsChanged', () => this.refreshKey()));
  }

  /** Whether the hint is showing (debug). */
  get isShowing(): boolean { return this.shown; }

  update(ctx: GameContext): void {
    const personal = (this.cutscene?.ship ?? ctx.hub?.ship ?? 'personal') === 'personal';
    const cutscene = this.cutscene?.active ?? (ctx.phase === 'docking' || (ctx.hub?.travelling ?? false));
    const on = ctx.isHubPhase() && ctx.uiBlockers.size === 0 && !(ctx.housing?.shipManageMode ?? false)
      && personal && !cutscene;
    if (on === this.shown) return;
    this.shown = on;
    toggleClass(this.root, 'show', on);
  }

  private refreshKey(): void {
    setText(this.keyEl, keyLabel(Keys.MAP));
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
