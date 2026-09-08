import type { GameContext, HubShipKind } from '@/shared';

/**
 * Hub cutscene / ship-kind bookkeeping shared by the ship-only corner widgets (`hud/ShipManageHint`, `hud/Community`),
 * Phase 12: both must disappear while a **docking** or **warp** cutscene plays (the camera is outside the ship, the
 * buttons would float over the flight) and the 시설 관리 hint only exists on the **personal** ship.
 *
 * `active` is true from `hub:docking {stage:'start'}` / `hub:travel {stage:'start'}` until the matching `end`, and
 * also whenever the phase is `'docking'` or `ctx.hub.travelling` reports a flight — the events cover the first frame
 * before the phase flips, the phase / flag cover a cutscene that started before this widget was bound. `hub:left`
 * and `game:newMission` reset the flag so an aborted cutscene never leaves the buttons hidden.
 */
export class CutsceneWatch {
  private ctx!: GameContext;
  private flag = false;
  private shipKind: HubShipKind | null = null;
  private unsubs: Array<() => void> = [];

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    const b = ctx.bus;
    this.unsubs.push(
      b.on('hub:docking', ({ stage }) => { this.flag = stage === 'start'; }),
      b.on('hub:travel', ({ stage }) => { this.flag = stage === 'start'; }),
      b.on('hub:entered', ({ ship }) => { this.shipKind = ship; this.flag = false; }),
      b.on('hub:left', () => { this.flag = false; this.shipKind = null; }),
      b.on('game:newMission', () => { this.flag = false; }),
    );
  }

  /** A docking / warp cutscene is running. */
  get active(): boolean {
    const ctx = this.ctx;
    if (!ctx) return this.flag;
    return this.flag || ctx.phase === 'docking' || (ctx.hub?.travelling ?? false);
  }

  /** Which ship the player is on (`ctx.hub.ship`, falling back to the last `hub:entered`). */
  get ship(): HubShipKind | null { return this.ctx?.hub?.ship ?? this.shipKind; }

  dispose(): void { for (const u of this.unsubs) u(); }
}
