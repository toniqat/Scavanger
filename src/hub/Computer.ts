import type { GameContext, Interactable } from '@/shared';
import type { StationDef } from './interiors/stations';

/**
 * Ship computer (Phase 5): an instant `Interactable` (`hub_computer`, radius 2.2, prompt `기업 네트워크`) in front of
 * the computer desk that opens the corporation screen (`ctx.meta.openCorpMenu()` — the hub supplies `onUse`).
 * Same registration / disposal pattern as `Terminal` and `Workbench`.
 */
export class Computer {
  readonly interactable: Interactable;

  constructor(private readonly ctx: GameContext, readonly def: StationDef, onUse: () => void, canUse: () => boolean) {
    this.interactable = {
      id: 'hub_computer',
      position: def.position.clone(),
      radius: 2.2,
      getPrompt: () => (canUse() ? '기업 네트워크' : null),
      canInteract: () => canUse(),
      interact: () => onUse(),
    };
    ctx.interactables.register(this.interactable);
  }

  dispose(): void {
    this.ctx.interactables.unregister(this.interactable.id);
  }
}
