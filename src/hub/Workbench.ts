import type { GameContext, Interactable } from '@/shared';
import type { WorkbenchDef } from './interiors/types';

/**
 * Ship workbench: an instant `Interactable` (`hub_workbench`, prompt `정비 벤치`) in front of the bench prop that
 * opens the `WorkbenchMenu` (weapon repair). Same registration pattern as `Terminal`.
 */
export class Workbench {
  readonly interactable: Interactable;

  constructor(private readonly ctx: GameContext, readonly def: WorkbenchDef, onUse: () => void, canUse: () => boolean) {
    this.interactable = {
      id: 'hub_workbench',
      position: def.position.clone(),
      radius: 2.2,
      getPrompt: () => (canUse() ? '정비 벤치' : null),
      canInteract: () => canUse(),
      interact: () => onUse(),
    };
    ctx.interactables.register(this.interactable);
  }

  dispose(): void {
    this.ctx.interactables.unregister(this.interactable.id);
  }
}
