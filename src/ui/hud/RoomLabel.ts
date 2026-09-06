import type { GameContext } from '@/shared';
import { ROOM_PURPOSE_LABEL_KO } from '@/shared';
import { el, setText, toggleClass } from '../dom';

/** How long the label stays fully visible after entering a room (s, simulation time) before the CSS fade. */
const HOLD_TIME = 1.5;

/**
 * Room entry label (`.room-label`, top-centre of the social layer so it shows in the ship): `hub:roomEntered
 * {room, purpose}` → `방 n · 용도` (1-based room number, `ROOM_PURPOSE_LABEL_KO`), `.show` for 1.5 s of `ctx.time` then the
 * CSS opacity transition fades it out; `room: null` (back in the corridor / cockpit) hides it at once.
 */
export class RoomLabel {
  readonly root: HTMLElement;
  private numEl: HTMLElement;
  private purposeEl: HTMLElement;
  private hideAt = -1;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'room-label', parent });
    this.numEl = el('span', { cls: 'num', text: '', parent: this.root });
    el('span', { cls: 'sep', text: '·', parent: this.root });
    this.purposeEl = el('span', { cls: 'purpose', text: '', parent: this.root });
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('hub:roomEntered', ({ room, purpose }) => {
        if (room === null) { this.hide(); return; }
        setText(this.numEl, `방 ${room + 1}`);
        setText(this.purposeEl, purpose ? (ROOM_PURPOSE_LABEL_KO[purpose] ?? purpose) : ROOM_PURPOSE_LABEL_KO.empty);
        this.hideAt = ctx.time + HOLD_TIME;
        // Re-trigger the slide-in when the label is already up.
        this.root.classList.remove('show');
        void this.root.offsetWidth;
        this.root.classList.add('show');
      }),
      b.on('game:newMission', () => this.hide()),
      b.on('game:abort', () => this.hide()),
    );
  }

  update(ctx: GameContext): void {
    if (this.hideAt >= 0 && ctx.time >= this.hideAt) this.hide();
  }

  /** Whether the label is showing (debug). */
  get isShowing(): boolean { return this.hideAt >= 0; }

  private hide(): void {
    this.hideAt = -1;
    toggleClass(this.root, 'show', false);
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
