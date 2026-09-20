import type { GameContext, ImplantDef, ImplantId } from '@/shared';
import { Keys, createKeycap, onKeybindsChanged, paintKeycap } from '@/shared';
import { el, restartAnim, setText, toggleClass } from '../dom';
import '../styles/implant.css';

/** How the thumbnail draws the implant's state. */
export type ImplantHudKind = 'cooldown' | 'charges' | 'gauge';

/**
 * Tactical implant thumbnail — **bottom centre of the screen, under the stamina bar** (`.imp-hud`, 2026-09-10).
 *
 * It replaces the vertical gauge left of the crosshair from 2026-09-06 (`.implant-gauge`). The user decided the cooldown
 * · charge count must not be read around the aim point, so **every number · gauge came down here** and only the grapple
 * mark stays on the crosshair (`hud/Reticle`). **The name is never written** — a wide thumbnail and the use key
 * (`Keys.IMPLANT`) under it, nothing else.
 *
 * There are three presentations, and which implant belongs to which is decided from **the values `ctx.implants` gives**
 * (`maxCharges` · `barrierMaxHp` · `energyMax` — no number is written in code):
 *
 *   - **Cooldown kind** (grapple · recon): while the cooldown runs the thumbnail is dimmed and `--fill` rises from the
 *     bottom brightening it. The seconds left in the middle.
 *   - **Charge kind** (dash): the charge count bottom right. At 0 it is the cooldown kind's dim + brighten (seconds in
 *     the middle); from 1 up there is no dim and **the accent colour rises from the bottom** showing the next charge;
 *     at max it reads plainly.
 *   - **Gauge kind** (barrier durability · overcharge energy): a horizontal gauge at the bottom centre inside the
 *     thumbnail. While a collapsed barrier is locked out (`barrierLockout`) it is drawn like the cooldown kind — dim +
 *     brighten + seconds left — because the durability refills 0 → full over the lockout, so the gauge is the progress.
 *
 * **Ready presentation (2026-09-12, user's decision).** At the **moment** it becomes ready, one strong flash
 * (`.rdy-major` — the border `.imp-ring` spreading out of the thumbnail + the inner glare `.ib-flash`); **while it stays
 * ready**, an outline glow (`.is-ready` — while not dimmed = while usable). The widget never guesses the moment: it
 * trusts **`implant:ready`** alone (implants emits it only in gameplay phases — mission start · reset · equip · the ship
 * are full from the start and are not a moment). An intermediate charge of the charge kind (`full` false) is a weak
 * flash (`.rdy-minor`). A grapple cooldown refund (`implant:cooldownRefunded`) floats a green `−N초` right of the
 * thumbnail (`.imp-refund`) and flares the filled part (`.rf-flash`). Why the flash elements are separate: `.pulse` ·
 * `.hit` already use `.imp-thumb`'s `animation` and their classes linger, so stacking on the same element would block
 * each other's playback.
 *
 * Values are read from `ctx.implants` every frame; events (`implant:*`) are used only for late registration and the
 * presentation (flash · hit). It hides with nothing equipped or while downed (the downed screen belongs to the
 * bleed-out / give-up ring, 2026-09-08).
 */
export class ImplantWidget {
  readonly root: HTMLElement;
  private thumb: HTMLElement;
  private reveal: HTMLElement;
  private cdEl: HTMLElement;
  private chEl: HTMLElement;
  private gauge: HTMLElement;
  private gaugeFill: HTMLElement;
  private faceBase: HTMLElement;
  private faceLit: HTMLElement;
  private keyEl: HTMLElement;
  private ringEl: HTMLElement;
  private refundEl: HTMLElement;

  private ctx!: GameContext;
  private equipped: ImplantId | null = null;
  private def: ImplantDef | null = null;
  private remaining = 0;
  private total = 0;
  private charges = 1;
  private maxCharges = 1;
  private wielded = false;
  private holding = false;
  private barrierHp = 0;
  private barrierMax = 0;
  private barrierLockout = 0;
  private energy = 0;
  private energyMax = 0;
  private kind: ImplantHudKind = 'cooldown';
  private fill = 0;
  private dimmed = false;
  private ready = false;
  private lastFlash: 'major' | 'minor' | null = null;
  private flashCount = 0;
  private lastKey = '';
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'imp-hud', parent });
    this.root.hidden = true;
    this.thumb = el('div', { cls: 'imp-thumb', parent: this.root });
    // two copies of the same face: the dim base and the bright one the reveal clips from the bottom up
    this.faceBase = el('div', { cls: 'ib-face', text: '◈', parent: this.thumb });
    this.reveal = el('div', { cls: 'ib-reveal', parent: this.thumb });
    this.faceLit = el('div', { cls: 'ib-face lit', text: '◈', parent: this.reveal });
    // 2026-09-12: the ready flash inside the thumb (clipped by it) — under the numbers so they stay readable
    el('div', { cls: 'ib-flash', parent: this.thumb });
    this.cdEl = el('div', { cls: 'ib-cd ui-mono', text: '', parent: this.thumb });
    this.chEl = el('div', { cls: 'ib-ch ui-mono', text: '', parent: this.thumb });
    this.gauge = el('div', { cls: 'ib-gauge', parent: this.thumb });
    this.gauge.hidden = true;
    this.gaugeFill = el('i', { parent: this.gauge });
    this.keyEl = createKeycap(Keys.IMPLANT, { tag: 'kbd', cls: 'imp-key', parent: this.root });   // 2026-09-15: the shared keycap
    // 2026-09-12: the ring that bursts out of the thumb on a ready moment, and the green `−N초` of a refund —
    // both absolutely placed over / beside the thumb, outside its clip
    this.ringEl = el('div', { cls: 'imp-ring', parent: this.root });
    this.refundEl = el('div', { cls: 'imp-refund ui-mono', text: '', parent: this.root });
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    const b = ctx.bus;
    const syncKey = (): void => paintKeycap(this.keyEl, Keys.IMPLANT);
    this.unsubs.push(
      b.on('implant:equipped', ({ id }) => this.setEquipped(id)),
      b.on('implant:cooldownChanged', ({ id, remaining, total, charges, maxCharges }) => {
        if (this.equipped === null) this.setEquipped(id);
        this.remaining = remaining; this.total = total;
        this.charges = charges; this.maxCharges = maxCharges;
      }),
      b.on('implant:wieldChanged', ({ wielded }) => { this.wielded = wielded; toggleClass(this.root, 'wielded', wielded); }),
      b.on('implant:activated', () => this.flash('pulse')),
      b.on('implant:barrierChanged', ({ hp, maxHp }) => { this.barrierHp = hp; this.barrierMax = maxHp; }),
      b.on('implant:barrierHit', () => this.flash('hit')),
      b.on('implant:energyChanged', ({ energy, max }) => { this.energy = energy; this.energyMax = max; }),
      // 2026-09-12: the ready moment · the grapple refund
      b.on('implant:ready', ({ full }) => this.flashReady(full)),
      b.on('implant:cooldownRefunded', ({ seconds }) => this.showRefund(seconds)),
      b.on('game:newMission', () => this.resetTransient()),
      b.on('game:abort', () => this.resetTransient()),
      b.on('hub:entered', () => this.resetTransient()),
      b.on('input:bindingsChanged', syncKey),
      onKeybindsChanged(syncKey),
    );
  }

  private flash(cls: 'pulse' | 'hit'): void {
    restartAnim(this.root, cls);
  }

  /** 2026-09-12: the ready moment — `major` for the last / only charge (and 안정제), `minor` for an intermediate one. */
  private flashReady(major: boolean): void {
    this.root.classList.remove(major ? 'rdy-minor' : 'rdy-major');
    restartAnim(this.root, major ? 'rdy-major' : 'rdy-minor');
    this.lastFlash = major ? 'major' : 'minor';
    this.flashCount++;
  }

  /** 2026-09-12: a grapple refund — green `−N초` floats up beside the thumb, the filled part flares. */
  private showRefund(seconds: number): void {
    if (!(seconds > 0)) return;
    setText(this.refundEl, `−${this.secs(seconds)}초`);
    restartAnim(this.root, 'rf-flash');
  }

  private resetTransient(): void {
    this.wielded = false; this.holding = false;
    toggleClass(this.root, 'wielded', false);
    toggleClass(this.root, 'holding', false);
    this.root.classList.remove('rdy-major', 'rdy-minor', 'rf-flash');
    setText(this.refundEl, '');
    this.lastFlash = null;
    this.barrierHp = 0; this.barrierMax = 0; this.barrierLockout = 0;
    this.lastKey = '';
  }

  private setEquipped(id: ImplantId | null): void {
    this.equipped = id;
    this.def = id ? (this.ctx.implants?.getDef(id) ?? null) : null;
    this.lastKey = '';
    if (!id) { this.root.hidden = true; return; }
    const icon = this.def?.icon ?? '◈';
    setText(this.faceBase, icon);
    setText(this.faceLit, icon);
    this.root.style.setProperty('--ic', this.def?.color ?? 'var(--c-info)');
    this.root.dataset.implant = id;
    this.root.hidden = false;
  }

  /**
   * Which of the three presentations this implant uses. Decided from the live ref (a charge implant has
   * `maxCharges > 1`, a gauge implant publishes a pool) so a data-only change to `data/implants.csv` follows.
   */
  private kindOf(): ImplantHudKind {
    if (this.equipped === 'barrier' || this.equipped === 'overcharge') return 'gauge';
    const n = this.maxCharges > 0 ? this.maxCharges : (this.def?.charges ?? 1);
    return n > 1 ? 'charges' : 'cooldown';
  }

  update(_dt: number, ctx: GameContext): void {
    // 2026-09-14 (gradual tutorial HUD reveal): there is no tactical implant for the whole tutorial raid — nothing is equipped.
    toggleClass(this.root, 'hud-tut-hidden', ctx.tutorial?.hides('hud', 'implant') ?? false);
    const imp = ctx.implants;
    // Late registration: pick the equipped implant up as soon as the system exists.
    if (imp && imp.equipped !== this.equipped) this.setEquipped(imp.equipped);
    if (this.equipped === null) { if (!this.root.hidden) this.root.hidden = true; return; }
    // 2026-09-08: nothing while downed — the implant is unusable there and that screen belongs to the
    //   bleed-out / give-up ring. (The widget moved to the bottom centre in 2026-09-10; the rule did not change.)
    if (ctx.player?.isDowned) { if (!this.root.hidden) this.root.hidden = true; return; }
    if (this.root.hidden) this.root.hidden = false;
    if (!this.def && imp) this.def = imp.getDef(this.equipped) ?? null;

    if (imp) {
      this.remaining = imp.cooldownRemaining;
      this.total = imp.cooldownTotal;
      this.charges = imp.charges;
      this.maxCharges = imp.maxCharges;
      this.barrierHp = imp.barrierHp;
      this.barrierMax = imp.barrierMaxHp;
      this.barrierLockout = imp.barrierLockout;
      this.energy = imp.energy;
      this.energyMax = imp.energyMax;
      if (imp.wielded !== this.wielded) { this.wielded = imp.wielded; toggleClass(this.root, 'wielded', this.wielded); }
      if (imp.holding !== this.holding) { this.holding = imp.holding; toggleClass(this.root, 'holding', this.holding); }
    }

    // hidden with the reticle while any UI blocker is up
    const blocked = ctx.uiBlockers.size > 0;
    if (this.root.classList.contains('blocked') !== blocked) toggleClass(this.root, 'blocked', blocked);

    this.kind = this.kindOf();
    if (this.kind === 'charges') this.renderCharges();
    else if (this.kind === 'gauge') this.renderGauge();
    else this.renderCooldown();
  }

  /** Seconds text: one decimal under 10 s, whole seconds above (the old gauge's rule). */
  private secs(t: number): string { return t.toFixed(t < 10 ? 1 : 0); }

  /**
   * Write the whole thumbnail in one go; a rounded key keeps the DOM untouched between real changes.
   * `ready` (2026-09-12) = usable right now → the held outline glow (`.is-ready`).
   */
  private paint(fill: number, dim: boolean, accent: boolean, cd: string, ch: string, gauge: number, low: boolean, ready: boolean): void {
    const f = Math.min(1, Math.max(0, fill));
    const key = `${f.toFixed(3)}|${dim ? 1 : 0}|${accent ? 1 : 0}|${cd}|${ch}|${gauge < 0 ? -1 : gauge.toFixed(3)}|${low ? 1 : 0}|${ready ? 1 : 0}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.fill = f; this.dimmed = dim; this.ready = ready;
    this.root.style.setProperty('--fill', f.toFixed(3));
    toggleClass(this.root, 'dim', dim);
    toggleClass(this.root, 'accent', accent);
    toggleClass(this.root, 'low', low);
    toggleClass(this.root, 'empty', ch === '0');
    toggleClass(this.root, 'is-ready', ready);
    setText(this.cdEl, cd);
    setText(this.chEl, ch);
    if (gauge < 0) {
      if (!this.gauge.hidden) this.gauge.hidden = true;
    } else {
      if (this.gauge.hidden) this.gauge.hidden = false;
      this.gaugeFill.style.transform = `scaleX(${Math.min(1, Math.max(0, gauge)).toFixed(3)})`;
    }
  }

  /** Grapple / recon: dim + brighten from the bottom while the cooldown runs, seconds in the middle. */
  private renderCooldown(): void {
    const ready = this.charges > 0 && this.remaining <= 0.001;
    const f = ready ? 1 : this.total > 0 ? 1 - Math.min(1, this.remaining / this.total) : 1;
    this.paint(ready ? 0 : f, !ready, false, ready ? '' : this.secs(this.remaining), '', -1, false, ready);
  }

  /** Dash: charge count bottom-right; 0 = the cooldown look, 1…max−1 = accent rising, max = plain. Ready = a charge in hand. */
  private renderCharges(): void {
    const n = Math.max(1, this.maxCharges);
    const refill = this.total > 0 && this.remaining > 0 ? 1 - Math.min(1, this.remaining / this.total) : 0;
    const ch = `${Math.max(0, this.charges)}`;
    if (this.charges <= 0) { this.paint(refill, true, false, this.secs(this.remaining), ch, -1, false, false); return; }
    if (this.charges >= n) { this.paint(0, false, false, '', ch, -1, false, true); return; }
    this.paint(refill, false, true, '', ch, -1, false, true);
  }

  /** Barrier durability / overcharge energy: a gauge at the bottom centre of the thumbnail. Ready = not locked / not empty. */
  private renderGauge(): void {
    if (this.equipped === 'barrier') {
      const max = this.barrierMax > 0 ? this.barrierMax : 1;
      const r = Math.min(1, Math.max(0, this.barrierHp / max));
      const locked = this.barrierLockout > 0.001;
      // During the collapse lockout the durability refills 0 → full over the lockout time = the cooldown progress itself.
      this.paint(locked ? r : 0, locked, false, locked ? this.secs(this.barrierLockout) : '', '', r, !locked && r < 0.25, !locked);
      return;
    }
    const max = this.energyMax > 0 ? this.energyMax : 1;
    const r = Math.min(1, Math.max(0, this.energy / max));
    const empty = r < 0.02;
    this.paint(empty ? r : 0, empty, false, '', '', r, r < 0.15 && !this.holding, !empty);
  }

  /** Implant drawn right now, null while hidden (debug / smoke). */
  get shownId(): ImplantId | null { return this.root.hidden ? null : this.equipped; }
  /** Which presentation the thumbnail is using (debug / smoke). */
  get displayKind(): ImplantHudKind { return this.kind; }
  /** 0…1 bottom-up brightening / accent fill (debug / smoke). */
  get fillAmount(): number { return this.fill; }
  /** Whether the thumbnail is dimmed (cooldown / no charge / barrier lockout) (debug / smoke). */
  get isDimmed(): boolean { return this.dimmed; }
  /** 2026-09-12: whether the held ready glow is on (debug / smoke). */
  get isReadyGlow(): boolean { return this.ready; }
  /** 2026-09-12: the last ready flash played and how many so far (debug / smoke). */
  get lastReadyFlash(): 'major' | 'minor' | null { return this.lastFlash; }
  get readyFlashCount(): number { return this.flashCount; }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.root.remove();
  }
}
