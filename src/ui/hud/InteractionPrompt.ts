import type { GameContext } from '@/shared';
import { Keys, keyLabel } from '@/shared';
import { el, setText, setVisible } from '../dom';

/**
 * Center-bottom "E — do thing" prompt.
 *
 * 2026-09-08: the hold progress bar under it is gone — every hold in the game fills the crosshair ring
 * (`hud/HoldGauge`) instead, so the prompt is a caption again.
 */
export class InteractionPrompt {
  readonly root: HTMLElement;
  private txt: HTMLElement;
  private keyEl: HTMLElement;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'prompt hidden', parent });
    const row = el('div', { cls: 'row ui-panel', parent: this.root });
    this.keyEl = el('span', { cls: 'keycap', text: keyLabel(Keys.INTERACT), parent: row });
    this.txt = el('span', { cls: 'txt', text: '', parent: row });
  }

  bind(ctx: GameContext): void {
    this.unsubs.push(
      ctx.bus.on('interact:promptChanged', ({ text }) => {
        if (!text) { setVisible(this.root, false); return; }
        setText(this.txt, text);
        setVisible(this.root, true);
      }),
      ctx.bus.on('input:bindingsChanged', () => setText(this.keyEl, keyLabel(Keys.INTERACT))),
      ctx.bus.on('game:abort', () => setVisible(this.root, false)),
      ctx.bus.on('game:newMission', () => setVisible(this.root, false)),
    );
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
