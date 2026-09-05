import type { GameContext, Interactable } from '@/shared';
import type { TerminalDef } from './interiors/types';

/**
 * Ship terminal: an instant `Interactable` (`함선 터미널`) that opens the hub menu, plus the console screen text
 * (status lines rendered into the interior's CanvasTexture screen).
 */
export class Terminal {
  readonly interactable: Interactable;

  constructor(private readonly ctx: GameContext, private readonly def: TerminalDef, onUse: () => void, canUse: () => boolean) {
    this.interactable = {
      id: 'hub_terminal',
      position: def.position.clone(),
      radius: 2.4,
      getPrompt: () => (canUse() ? '함선 터미널' : null),
      canInteract: () => canUse(),
      interact: () => onUse(),
    };
    ctx.interactables.register(this.interactable);
  }

  /** Console screen lines (first line = title in `accent`). */
  setScreen(lines: string[], accent: string): void {
    this.def.screen.set(lines, accent, 'rgba(4,12,18,1)', '#a9d7e8');
  }

  dispose(): void {
    this.ctx.interactables.unregister(this.interactable.id);
  }
}
