import type { GameContext, StratagemId } from '@/shared';
import { Keys, RESCUE_DROPS_PER_RAID, STRATAGEM_ORDER, createKeycap, onKeybindsChanged, paintKeycap } from '@/shared';
import { el, setText, toggleClass } from '../dom';
import { STRATAGEM_COLOR, STRATAGEM_GLYPH } from './stratagemGlyphs';
import '../styles/shipCall.css';

/**
 * Ship-call thumbnail (`.scall`) — **directly left of the tactical implant**, bottom centre of the screen.
 *
 * 2026-09-10 (2nd pass, user's decision): the text panel in the bottom-right weapon column (`.strat-panel` — the `G`
 * keycap + the call's name + one description line + the control hint + a horizontal cooldown bar) was taken away whole
 * and replaced by **one square thumbnail**. All text is gone — only the thumbnail and the `G` keycap under it, and once
 * armed the thumbnail border · keycap brighten to that call's colour (`STRATAGEM_COLOR`). For a control hint, hold `G`
 * to open the wheel (the wheel's centre draws the description).
 *
 * **The cooldown is drawn exactly like the implant's** (the same rule as `hud/ImplantWidget.renderCooldown`): while it
 * runs the thumbnail is dimmed, `--fill` rises from the bottom brightening it, and the seconds left show in the middle
 * (one decimal under 10 s — `secs`). Ship calls **share one cooldown across all four kinds**
 * (`StratagemSystem._cooldown`), so the single thumbnail is the whole state. The cooldown length is `cooldown` in
 * `data/stratagems.csv` (2026-09-10: it differs per call), and the value of the call used last locks all four.
 *
 * **Which glyph it draws.** The armed call while one is armed, otherwise **the call armed last** — because a `G` tap
 * arms exactly that one again (`stratagems/parts/Targeting`: `sys.arm(sys.lastArmed)`). The initial value is
 * `STRATAGEM_ORDER[0]`, the same as the system's, and it updates on every non-null id of `stratagem:armed` — rather
 * than cutting a new `lastArmed` into `StratagemsRef`, the same value is built from events that already flow.
 *
 * Only with the rescue ship in hand does the **squad-wide count left** (`rescue:countChanged`) appear bottom right.
 * With no `ctx.stratagems` and no event yet it hides whole (`.off`).
 *
 * **Ready presentation (2026-09-12, user's decision)** — the same rule as the implant thumbnail. At the **moment** the
 * cooldown ends, one strong flash (`.rdy-major` — the outward-spreading border `.sc-ring` + the inner glare
 * `.sb-flash`); **while it stays ready**, an outline glow (`.is-ready`). The moment trusts `stratagem:ready` alone
 * (stratagems emits it only in gameplay phases — a cooldown that ended in the ship is not a moment). The moment a
 * denial refund brings it to 0 (`refunded`) is a weak flash (`.rdy-minor`) — being able to call again is true, so it is
 * shown, but it does not flare next to the denial toast (audio/ plays no sound for it).
 * Why the flash elements are separate: the armed `.pulse` already uses `.sc-thumb`'s `animation` and its class lingers.
 */
export class StratagemPanel {
  readonly root: HTMLElement;
  private thumb: HTMLElement;
  private faceBase: HTMLElement;
  private reveal: HTMLElement;
  private faceLit: HTMLElement;
  private cdEl: HTMLElement;
  private chEl: HTMLElement;
  private keyEl: HTMLElement;

  private armed: StratagemId | null = null;
  /** The call a `G` tap will arm — the same value as the system's `lastArmed`, rebuilt here from events. */
  private lastArmed: StratagemId = STRATAGEM_ORDER[0];
  private targeting = false;
  private remaining = 0;
  private total = 0;
  private seen = false;
  private fill = 0;
  private dimmed = false;
  private ready = false;
  private lastFlash: 'major' | 'minor' | null = null;
  private flashCount = 0;
  private lastKey = '';
  private unsubs: Array<() => void> = [];
  /** 2026-09-09: rescue drops left for the whole squad (`rescue:countChanged`; with none it counts as full). */
  private rescueLeft = RESCUE_DROPS_PER_RAID;

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'scall off', parent });
    this.thumb = el('div', { cls: 'sc-thumb', parent: this.root });
    // Two copies of the same face: the dimmed base and a bright one clipped into view from the bottom (the implant.css trick)
    this.faceBase = el('div', { cls: 'sb-face', text: '', parent: this.thumb });
    this.reveal = el('div', { cls: 'sb-reveal', parent: this.thumb });
    this.faceLit = el('div', { cls: 'sb-face lit', text: '', parent: this.reveal });
    // 2026-09-12: the ready glare (inside the thumbnail — under the numbers)
    el('div', { cls: 'sb-flash', parent: this.thumb });
    this.cdEl = el('div', { cls: 'sc-cd ui-mono', text: '', parent: this.thumb });
    this.chEl = el('div', { cls: 'sc-ch ui-mono', text: '', parent: this.thumb });
    this.keyEl = createKeycap(Keys.SHIP_CALL, { tag: 'kbd', cls: 'sc-key', parent: this.root });   // 2026-09-15: the shared keycap
    // 2026-09-12: the border that spreads out of the thumbnail on the ready moment (absolutely placed over it)
    el('div', { cls: 'sc-ring', parent: this.root });
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    const syncKey = (): void => paintKeycap(this.keyEl, Keys.SHIP_CALL);
    this.unsubs.push(
      b.on('input:bindingsChanged', syncKey),
      onKeybindsChanged(syncKey),
      b.on('stratagem:armed', ({ id }) => {
        this.armed = id;
        if (id) { this.lastArmed = id; this.flash(); }
        this.seen = true; this.render();
      }),
      b.on('stratagem:targeting', ({ active }) => { this.targeting = active; this.render(); }),
      b.on('stratagem:cooldown', ({ remaining, total }) => {
        this.seen = true;
        this.remaining = Math.max(0, remaining); this.total = Math.max(this.total, total, 0);
        if (remaining <= 0) this.total = total;
        this.render();
      }),
      // 2026-09-12: the ready moment — strongly for a normal end, weakly for a denial refund
      b.on('stratagem:ready', ({ refunded }) => this.flashReady(!refunded)),
      b.on('rescue:countChanged', ({ left }) => { this.rescueLeft = Math.max(0, left); this.seen = true; this.render(); }),
      b.on('game:newMission', () => this.resetTransient()),
      b.on('game:abort', () => this.resetTransient()),
      b.on('player:died', () => { this.armed = null; this.targeting = false; this.render(); }),
    );
  }

  private resetTransient(): void {
    this.armed = null; this.targeting = false;
    this.rescueLeft = RESCUE_DROPS_PER_RAID;
    this.root.classList.remove('rdy-major', 'rdy-minor');
    this.lastFlash = null;
    this.render();
  }

  /** Restart the one-shot arm animation (remove → reflow → add is the only reliable way). */
  private flash(): void {
    this.root.classList.remove('pulse');
    void this.root.offsetWidth;
    this.root.classList.add('pulse');
  }

  /** 2026-09-12: the ready moment — `major` when the cooldown ran out, `minor` when a refusal gave it back. */
  private flashReady(major: boolean): void {
    this.root.classList.remove('rdy-major', 'rdy-minor');
    void this.root.offsetWidth;
    this.root.classList.add(major ? 'rdy-major' : 'rdy-minor');
    this.lastFlash = major ? 'major' : 'minor';
    this.flashCount++;
  }

  update(ctx: GameContext): void {
    // 2026-09-14 (gradual tutorial HUD reveal): there are no ship calls for the whole tutorial raid — nothing to call.
    toggleClass(this.root, 'hud-tut-hidden', ctx.tutorial?.hides('hud', 'stratagem') ?? false);
    const s = ctx.stratagems;
    if (s) {
      if (!this.seen) { this.seen = true; this.render(); }
      // Smooth the fill between the 0.5 s cooldown events.
      const rem = Math.max(0, s.cooldown), tot = s.cooldownTotal > 0 ? s.cooldownTotal : this.total;
      if (Math.abs(rem - this.remaining) > 0.01 || tot !== this.total) {
        this.remaining = rem; this.total = tot;
        this.render();
      }
      if (s.rescueLeft !== this.rescueLeft) { this.rescueLeft = Math.max(0, s.rescueLeft); this.render(); }
    }
    // hidden with the other crosshair widgets while any UI blocker is up
    const blocked = ctx.uiBlockers.size > 0;
    if (this.root.classList.contains('blocked') !== blocked) toggleClass(this.root, 'blocked', blocked);
  }

  /** Seconds text: one decimal under 10 s, whole seconds above — the same rule as `hud/ImplantWidget`. */
  private secs(t: number): string { return t.toFixed(t < 10 ? 1 : 0); }

  private render(): void {
    const id = this.armed ?? this.lastArmed;
    const ready = this.remaining <= 0.001;
    const fill = ready ? 0 : this.total > 0 ? 1 - Math.min(1, this.remaining / this.total) : 1;
    const cd = ready ? '' : this.secs(this.remaining);
    // The count left only with the rescue ship in hand — holding another call must not show somebody else's number.
    const ch = this.armed === 'rescue_drop' ? `${this.rescueLeft}/${RESCUE_DROPS_PER_RAID}` : '';
    const key = `${this.seen ? 1 : 0}|${id}|${this.armed ? 1 : 0}|${this.targeting ? 1 : 0}|${fill.toFixed(3)}|${cd}|${ch}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.fill = fill; this.dimmed = !ready; this.ready = ready && this.seen;

    toggleClass(this.root, 'off', !this.seen);
    toggleClass(this.root, 'armed', this.armed !== null);
    toggleClass(this.root, 'targeting', this.targeting);
    toggleClass(this.root, 'dim', !ready);
    // 2026-09-12: the outline glow while it stays ready
    toggleClass(this.root, 'is-ready', this.ready);
    toggleClass(this.root, 'spent', ch !== '' && this.rescueLeft <= 0);
    this.root.style.setProperty('--sc', STRATAGEM_COLOR[id]);
    this.root.style.setProperty('--fill', fill.toFixed(3));
    this.root.dataset.call = id;
    const glyph = STRATAGEM_GLYPH[id];
    setText(this.faceBase, glyph);
    setText(this.faceLit, glyph);
    setText(this.cdEl, cd);
    setText(this.chEl, ch);
  }

  /** Whether a call is armed (debug). */
  get armedId(): StratagemId | null { return this.armed; }
  /** Call whose glyph the thumbnail is drawing right now (debug / smoke). */
  get shownId(): StratagemId { return this.armed ?? this.lastArmed; }
  /** 0…1 bottom-up cooldown fill (debug / smoke). */
  get fillAmount(): number { return this.fill; }
  /** Whether the thumbnail is dimmed = on cooldown (debug / smoke). */
  get isDimmed(): boolean { return this.dimmed; }
  /** 2026-09-12: whether the held ready glow is on (debug / smoke). */
  get isReadyGlow(): boolean { return this.ready; }
  /** 2026-09-12: the last ready flash played and how many so far (debug / smoke). */
  get lastReadyFlash(): 'major' | 'minor' | null { return this.lastFlash; }
  get readyFlashCount(): number { return this.flashCount; }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
