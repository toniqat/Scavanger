import type { GameContext, ImplantDef, ImplantId } from '@/shared';
import { Keys, keyLabel } from '@/shared';
import { el, setText, toggleClass } from '../dom';

/**
 * 전술 임플란트 thumbnail (`.implant-chip`, gameplay layer, Phase 9 UI pass) — a single tinted tile with the implant
 * glyph, its 한국어 name and the `Keys.IMPLANT` keycap, sitting on the right **above the 빠른 사용 strip** (which in
 * turn sits above the weapon slot strip). It answers "what is on Q right now"; the live cooldown / charges / barrier
 * numbers stay on `ImplantWidget`, the vertical gauge left of the crosshair.
 *
 * `.is-cooling` while the implant is on cooldown or out of charges (`implant:cooldownChanged`), `.is-wielded` while a
 * wielded implant (대전차포) is in the hands, and a one-shot `.flash` on `implant:activated`. Hidden when nothing is
 * equipped or `ctx.implants` is missing.
 */
export class ImplantChip {
  readonly root: HTMLElement;
  private ico: HTMLElement;
  private nameEl: HTMLElement;
  private keyEl: HTMLElement;
  private ctx: GameContext | null = null;
  private equipped: ImplantId | null = null;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'implant-chip', parent });
    this.root.hidden = true;
    const thumb = el('div', { cls: 'ic-thumb', parent: this.root });
    this.ico = el('span', { cls: 'ic-glyph', text: '◈', parent: thumb });
    const body = el('div', { cls: 'ic-body', parent: this.root });
    this.nameEl = el('span', { cls: 'ic-name', text: '', parent: body });
    this.keyEl = el('kbd', { cls: 'ic-key', text: keyLabel(Keys.IMPLANT), parent: body });
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    const b = ctx.bus;
    this.unsubs.push(
      b.on('implant:equipped', ({ id }) => this.setEquipped(id)),
      b.on('implant:cooldownChanged', ({ remaining, charges }) => {
        toggleClass(this.root, 'is-cooling', remaining > 0 || charges === 0);
      }),
      b.on('implant:wieldChanged', ({ wielded }) => toggleClass(this.root, 'is-wielded', wielded)),
      b.on('implant:activated', () => {
        // restart the CSS pulse (removing + reflow + re-adding is the only reliable way)
        this.root.classList.remove('flash');
        void this.root.offsetWidth;
        this.root.classList.add('flash');
      }),
      b.on('input:bindingsChanged', () => setText(this.keyEl, keyLabel(Keys.IMPLANT))),
      b.on('world:ready', () => this.pull()),
      b.on('game:newMission', () => { this.root.classList.remove('flash', 'is-wielded'); this.pull(); }),
    );
    this.pull();
  }

  /** Read the equipped implant straight off `ctx.implants` (the event only fires on a change in the ship). */
  private pull(): void {
    const imp = this.ctx?.implants;
    this.setEquipped(imp?.equipped ?? null);
  }

  private setEquipped(id: ImplantId | null): void {
    if (id === this.equipped) return;
    this.equipped = id;
    const def: ImplantDef | null = id ? this.ctx?.implants?.getDef(id) ?? null : null;
    if (!def) {
      this.root.hidden = true;
      this.root.classList.remove('is-cooling', 'is-wielded', 'flash');
      return;
    }
    this.root.hidden = false;
    this.root.style.setProperty('--ic', def.color);
    setText(this.ico, def.icon ?? '◈');
    setText(this.nameEl, def.name);
    setText(this.keyEl, keyLabel(Keys.IMPLANT));
  }

  /** Whether the chip is showing (debug). */
  get isShowing(): boolean { return !this.root.hidden; }
  /** Implant id currently drawn, null when hidden (debug). */
  get shownId(): ImplantId | null { return this.root.hidden ? null : this.equipped; }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
