import type { GameContext } from '@/shared';
import { Keys, createKeycap, paintKeycap } from '@/shared';
import { el, setText, setVisible } from '../dom';

/**
 * Center-bottom "E — do thing" prompt.
 *
 * 2026-09-08: the hold progress bar under it is gone — every hold in the game fills the crosshair ring
 * (`hud/HoldGauge`) instead, so the prompt is a caption again.
 * 2026-09-09: a **hold** interactable (`interact:promptChanged.hold`, e.g. the 발사 포드 탑승 0.4 s) puts `.kc-hold` on
 * the keycap — the shared `.keycap.kc-hold::before` chevron (same one the 키 가이드 draws) says "꾹 누르기" before the
 * player taps and wonders why nothing happened.
 *
 * 2026-09-10: that modifier used to be plain `.hold`, which collided with the 홀드 링 (`hud/HoldGauge`) rule of the
 * same name — the keycap became a 120×120 투명 상자 and vanished while the row kept the `:has()` 여백. `kc-` prefix.
 *
 * 2026-09-15: the cap is painted by `shared/keycap.paintKeycap` (hold flag + a mouse glyph if `INTERACT` is ever rebound
 * to a mouse button). The chevron now sits inside the cap, so the row's old `:has(.kc-hold)` top padding is gone.
 */
export class InteractionPrompt {
  readonly root: HTMLElement;
  private txt: HTMLElement;
  private keyEl: HTMLElement;
  private hold = false;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'prompt hidden', parent });
    const row = el('div', { cls: 'row ui-panel', parent: this.root });
    this.keyEl = createKeycap(Keys.INTERACT, { parent: row });
    this.txt = el('span', { cls: 'txt', text: '', parent: row });
  }

  bind(ctx: GameContext): void {
    this.unsubs.push(
      ctx.bus.on('interact:promptChanged', ({ text, hold }) => {
        if (!text) { setVisible(this.root, false); return; }
        setText(this.txt, text);
        this.hold = hold === true;
        paintKeycap(this.keyEl, Keys.INTERACT, { hold: this.hold });
        setVisible(this.root, true);
      }),
      ctx.bus.on('input:bindingsChanged', () => paintKeycap(this.keyEl, Keys.INTERACT, { hold: this.hold })),
      ctx.bus.on('game:abort', () => setVisible(this.root, false)),
      ctx.bus.on('game:newMission', () => setVisible(this.root, false)),
    );
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
