import type { GameContext } from '@/shared';
import { FALL_VIGNETTE_FULL_DAMAGE, FALL_VIGNETTE_S } from '@/shared';
import { el } from '../dom';
import '../styles/fall.css';

/** Opacity under which the plate is hidden outright (no composited full-screen layer left behind). */
const OFF = 0.002;
/** Skip style writes smaller than this (the fade still lands on exactly 0 through `OFF`). */
const WRITE_EPS = 0.004;

/**
 * The red fall vignette (`.fall-vignette`, a direct child of `#ui-root`, 2026-09-15, TODO B-14).
 *
 * `player:fell {damage}` — a fact that arrives **only when the local player fell and really lost hp** — turns it on at strength
 * `min(1, damage / FALL_VIGNETTE_FULL_DAMAGE)`, and it fades over `FALL_VIGNETTE_S` (curve `k²` — a flash that drains fast).
 * A new fall is ignored while a stronger one is still up, and a stronger one restarts at its own strength (the maximum). A squadmate's fall (`player:remoteFell`)
 * is sound only and is not listened to here. The landing shake belongs to player's `camera:shake`, the sound to audio.
 *
 * The fading is `update(dt)`, not a CSS transition — it follows simulation time and must look the same on a PC where `prefers-reduced-motion`
 * cuts transitions to 0. It turns off at once on `game:abort` · `game:newMission` · `hub:entered`.
 */
export class FallVignette {
  readonly root: HTMLElement;
  private peak = 0;
  private left = 0;
  private shown = 0;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'fall-vignette', parent });
    this.root.hidden = true;
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('player:fell', ({ damage }) => this.hit(damage)),
      b.on('game:abort', () => this.reset()),
      b.on('game:newMission', () => this.reset()),
      b.on('hub:entered', () => this.reset()),
    );
  }

  private hit(damage: number): void {
    if (!(damage > 0)) return;
    const full = FALL_VIGNETTE_FULL_DAMAGE > 0 ? FALL_VIGNETTE_FULL_DAMAGE : 1;
    const strength = Math.min(1, damage / full);
    if (strength <= this.shown) return;          // already stronger — the maximum wins
    this.peak = strength;
    this.left = Math.max(0.001, FALL_VIGNETTE_S);
    this.write(strength, true);
  }

  update(dt: number): void {
    if (this.left <= 0) return;
    this.left -= Math.max(0, dt);
    const S = Math.max(0.001, FALL_VIGNETTE_S);
    const k = this.left > 0 ? this.left / S : 0;
    this.write(this.peak * k * k, false);
  }

  private write(o: number, force: boolean): void {
    if (o <= OFF) {
      this.left = 0;
      this.peak = 0;
      if (this.shown !== 0 || !this.root.hidden) {
        this.shown = 0;
        this.root.style.opacity = '0';
        this.root.hidden = true;
      }
      return;
    }
    if (!force && Math.abs(o - this.shown) < WRITE_EPS) return;
    this.shown = o;
    if (this.root.hidden) this.root.hidden = false;
    this.root.style.opacity = o.toFixed(3);
  }

  private reset(): void { this.write(0, true); }

  /** Current plate opacity, 0 = off (debug / smoke). */
  get opacity(): number { return this.shown; }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.root.remove();
  }
}
