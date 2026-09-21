import type { GameContext } from '@/shared';
import { RAID_LOAD_MIN_BLACK_S } from '@/shared';
import { el, setText, toggleClass } from '../dom';
import '../styles/loading.css';

/** How long it takes to disappear (s) — a cinematic length, so it lives here and not in csv (README rule: UI timing constants live in the component). */
const FADE_OUT_S = 0.25;
/** How long it takes to appear (s). */
const FADE_IN_S = 0.18;
/** Spin speed of the turning arc (deg/s). */
const SPIN_DEG_PER_S = 220;

/**
 * **The raid-entry loading gauge** (2026-09-15, docs/DECISIONS.md 「2026-09-15 — 안드로이드 분대원 · 레이드 진입 로딩」).
 *
 * User's decision: when the launch countdown ends the screen fades to black (`raid:loadBegin` → hub raises `ui:screenFade`),
 * and **a radial gauge turns at the bottom right over that black**. In multiplayer the gauge's fill is the summed progress
 * of the whole (human) squad — `raid:loadProgress.squad` is drawn as-is (the game side's `game/LoadGate` computes it). Once everyone is
 * done `raid:loadReleased` arrives, the gauge disappears quickly and the drop sequence fades in.
 *
 * **dt is 0.** While the gate runs the engine is stopped by `ctx.shaders.holdFor`, so every system receives `dt: 0`.
 * This widget's clock is therefore neither the simulation dt nor a CSS transition/animation but **`performance.now()`** — the fill ·
 * the spin · appearing/disappearing, all of it. (Driving it from CSS would also run into the reduced-motion rule cutting it to 0.01 ms.)
 * Under `prefers-reduced-motion` only the turning arc is hidden; the fill is left alone (`styles/loading.css`).
 *
 * Minimum show time `RAID_LOAD_MIN_BLACK_S` — however fast the load is, it stays up that long (csv comment: 「깜빡이며 사라지지
 * 않게」). `game:abort` · `hub:entered` clear it unconditionally (so no path leaves only the gauge on a black screen).
 */
export class LoadingGauge {
  readonly root: HTMLElement;
  private ring: HTMLElement;
  private spin: HTMLElement;
  private waitEl: HTMLElement;
  private pctEl: HTMLElement;
  private unsubs: Array<() => void> = [];

  /** Whether the gauge is alive (true while disappearing too). */
  private active = false;
  /** Whether it is disappearing — after `raid:loadReleased`. */
  private fading = false;
  /** 2026-09-16: whether the ship-return fade raised this gauge (`beginLocal`) — meanwhile raid load events · abort · arrival do not clear it. */
  private local = false;
  /** Real-time reference points (ms): the moment it appeared · the moment it began to disappear. */
  private shownAt = 0;
  private fadeAt = 0;
  /** The progress last received. */
  private squad = 0;
  private waiting = 0;
  /** The values last written (DOM writes are saved). */
  private lastP = -1;
  private lastSpin = -1;
  private lastOpacity = -1;
  private lastWait = -1;

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'ldg', parent });
    this.root.hidden = true;
    this.ring = el('div', { cls: 'ldg-ring', parent: this.root });
    this.spin = el('div', { cls: 'ldg-spin', parent: this.ring });
    const body = el('div', { cls: 'ldg-body', parent: this.root });
    el('div', { cls: 'ldg-label', text: '로딩 중', parent: body });
    this.pctEl = el('div', { cls: 'ldg-pct ui-mono', text: '0 %', parent: body });
    this.waitEl = el('div', { cls: 'ldg-wait', text: '', parent: body });
    this.waitEl.hidden = true;
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('raid:loadBegin', () => this.show()),
      // The first `raid:loadProgress` alone brings it up — the gauge also shows on a path that missed `raid:loadBegin` (rejoin · solo).
      b.on('raid:loadProgress', ({ squad, waiting }) => {
        if (!this.active) this.show();
        this.squad = Math.min(1, Math.max(0, Number.isFinite(squad) ? squad : 0));
        this.waiting = Math.max(0, Math.round(Number.isFinite(waiting) ? waiting : 0));
      }),
      b.on('raid:loadReleased', () => { if (!this.local) this.release(); }),
      // 2026-09-16: a gauge raised by the ship-return fade (`menus/ShipReturn`) is not cleared by the abort · arrival that its own `hub:enter` emits —
      // the side that raised it releases it itself with `endLocal` (otherwise the gauge disappears before the shaders compile).
      b.on('game:abort', () => { if (!this.local) this.hide(); }),
      b.on('hub:entered', () => { if (!this.local) this.hide(); }),
    );
  }

  /**
   * 2026-09-16 (the ship-return fade, owner `menus/ShipReturn`): shows the gauge without going through the bus, because emitting `raid:loadBegin`
   * would make game/LoadGate read it as a raid load. Progress is `setLocalProgress`, the end is `endLocal`.
   */
  beginLocal(): void {
    this.local = true;
    this.squad = 0;
    this.waiting = 0;
    this.show();
  }

  setLocalProgress(p: number): void {
    if (!this.local) return;
    this.squad = Math.min(1, Math.max(0, Number.isFinite(p) ? p : 0));
  }

  /** `now` = clear it at once (an abort), otherwise it fills and disappears like the usual `release`. */
  endLocal(now = false): void {
    if (!this.local) return;
    this.local = false;
    if (now) this.hide(); else this.release();
  }

  /** Whether the gauge shows (debug / smoke — true while disappearing too). */
  get isShowing(): boolean { return this.active; }
  /** Fill 0…1 · the number of people waited on · the opacity painted right now (debug / smoke). */
  get fill(): number { return this.squad; }
  get waitingCount(): number { return this.waiting; }
  get opacity(): number { return this.lastOpacity < 0 ? 0 : this.lastOpacity; }
  /** The turning arc's angle (deg) — the smoke hook that checks it still moves at dt 0. */
  get spinDeg(): number { return this.lastSpin < 0 ? 0 : this.lastSpin; }

  private show(): void {
    if (this.active && !this.fading) return;
    this.active = true;
    this.fading = false;
    this.shownAt = performance.now();
    this.root.hidden = false;
    this.lastP = -1; this.lastSpin = -1; this.lastOpacity = -1; this.lastWait = -1;
  }

  /**
   * Released — it fills the minimum show time, then disappears quickly. A gauge still up while the fade-in (`RAID_LOAD_FADE_IN_S`)
   * runs would sit over a brightening screen, so the disappearing is shorter than the fade-in (`FADE_OUT_S`).
   */
  private release(): void {
    if (!this.active || this.fading) return;
    this.fading = true;
    const minEnd = this.shownAt + RAID_LOAD_MIN_BLACK_S * 1000;
    this.fadeAt = Math.max(performance.now(), minEnd);
    // The fill is shown as finished — even when a timeout released it, a gauge that disappears part-filled reads as 「stuck」.
    this.squad = 1;
    this.waiting = 0;
  }

  private hide(): void {
    if (!this.active) return;
    this.active = false;
    this.fading = false;
    this.root.hidden = true;
    this.lastOpacity = 0;
    this.root.style.opacity = '0';
  }

  /**
   * `dt` is **deliberately not taken** — it is 0 while the load gate holds. Every time comes from `performance.now()`.
   */
  update(): void {
    if (!this.active) return;
    const now = performance.now();

    // disappearing / appearing
    let alpha: number;
    if (this.fading) {
      const t = (now - this.fadeAt) / (FADE_OUT_S * 1000);
      if (t >= 1) { this.hide(); return; }
      alpha = t <= 0 ? 1 : 1 - t;
    } else {
      alpha = Math.min(1, (now - this.shownAt) / (FADE_IN_S * 1000));
    }
    if (Math.abs(alpha - this.lastOpacity) > 0.01) {
      this.lastOpacity = alpha;
      this.root.style.opacity = alpha.toFixed(2);
    }

    const p = Math.min(1, Math.max(0, this.squad));
    if (Math.abs(p - this.lastP) > 0.004) {
      this.lastP = p;
      this.ring.style.setProperty('--p', p.toFixed(3));
      setText(this.pctEl, `${Math.round(p * 100)} %`);
    }

    const deg = Math.round(((now - this.shownAt) / 1000 * SPIN_DEG_PER_S) % 360);
    if (deg !== this.lastSpin) {
      this.lastSpin = deg;
      this.spin.style.transform = `rotate(${deg}deg)`;
    }

    if (this.waiting !== this.lastWait) {
      this.lastWait = this.waiting;
      this.waitEl.hidden = this.waiting <= 0;
      if (this.waiting > 0) setText(this.waitEl, `${this.waiting}명 대기 중`);
      toggleClass(this.root, 'waiting', this.waiting > 0);
    }
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
