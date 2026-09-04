import type { GameContext } from '@/shared';
import { el, setText, setVisible, toggleClass } from '../dom';

/** Center-bottom "E — do thing" prompt with hold progress bar. */
export class InteractionPrompt {
  readonly root: HTMLElement;
  private txt: HTMLElement;
  private bar: HTMLElement;
  private fill: HTMLElement;
  private lastProgress = -1;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'prompt hidden', parent });
    const row = el('div', { cls: 'row ui-panel', parent: this.root });
    el('span', { cls: 'keycap', text: 'E', parent: row });
    this.txt = el('span', { cls: 'txt', text: '', parent: row });
    this.bar = el('div', { cls: 'bar', parent: this.root });
    this.fill = el('i', { parent: this.bar });
  }

  bind(ctx: GameContext): void {
    this.unsubs.push(
      ctx.bus.on('interact:promptChanged', ({ text, holdProgress }) => {
        if (!text) { setVisible(this.root, false); this.setProgress(0); return; }
        setText(this.txt, text);
        setVisible(this.root, true);
        this.setProgress(holdProgress);
      }),
      ctx.bus.on('game:abort', () => setVisible(this.root, false)),
      ctx.bus.on('game:newMission', () => setVisible(this.root, false)),
    );
  }

  private setProgress(p: number): void {
    const v = Math.max(0, Math.min(1, p));
    toggleClass(this.bar, 'show', v > 0.001);
    if (Math.abs(v - this.lastProgress) < 0.004) return;
    this.lastProgress = v;
    this.fill.style.transform = `scaleX(${v.toFixed(3)})`;
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
