import type { GameContext } from '@/shared';
import { el, toggleClass } from '../dom';
import type { CutsceneWatch } from './CutsceneWatch';

/**
 * 함선 내 점 크로스헤어 (`.hub-dot`, 2026-09-09) — the **social** layer's centre dot for the ship phases.
 *
 * The gameplay `Reticle` lives in `.hud.gameplay`, which `HudSystem.applyVisibility` hides in the hub, so walking
 * the ship had no centre mark at all: nothing to line up a pod / terminal / bay with, and the 홀드 링 (`hud/HoldGauge`)
 * that fills while boarding the 발사 포드 had no dot to sit around. This is that dot — a single 3 px point, no ticks
 * (nothing is fired in the ship).
 *
 * Self-gated like the other ship-only widgets (`hud/ShipManageHint`, `hud/Community`): shown while
 * `ctx.phase === 'hub'` (not `'docking'`), with **no UI blocker** up (터미널 · 인벤토리 · 시설 관리 mode · 채팅 · ESC
 * 메뉴 all hold one, and the 재개 게이트 too) and outside a docking / warp cutscene (`CutsceneWatch`). Never
 * intercepts pointer events, no per-frame DOM write (one boolean compare).
 */
export class HubDot {
  readonly root: HTMLElement;
  private shown = false;

  constructor(parent: HTMLElement, private cutscene: CutsceneWatch | null = null) {
    this.root = el('div', { cls: 'hub-dot', parent });
  }

  /** Whether the dot is showing (debug / smoke). */
  get isShowing(): boolean { return this.shown; }

  update(ctx: GameContext): void {
    const cutscene = this.cutscene?.active ?? (ctx.phase === 'docking' || (ctx.hub?.travelling ?? false));
    const on = ctx.phase === 'hub' && ctx.uiBlockers.size === 0 && !cutscene;
    if (on === this.shown) return;
    this.shown = on;
    toggleClass(this.root, 'show', on);
  }

  dispose(): void { this.root.remove(); }
}
