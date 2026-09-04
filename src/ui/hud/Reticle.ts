import type { GameContext } from '@/shared';
import { el, damp } from '../dom';

/** Minimal 4-tick crosshair that blooms on fire, tightens when aiming, flashes hitmarkers. */
export class Reticle {
  readonly root: HTMLElement;
  private ticks: HTMLElement[] = [];
  private hitmarker: HTMLElement;
  private gap = 10;
  private targetGap = 10;
  private bloom = 0;
  private aiming = false;
  private hitTimer = 0;
  private lastGap = -1;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'reticle', parent });
    el('div', { cls: 'dot', parent: this.root });
    // top, bottom (vertical), left, right (horizontal)
    for (let i = 0; i < 4; i++) {
      this.ticks.push(el('div', { cls: `tick ${i < 2 ? 'v' : 'h'}`, parent: this.root }));
    }
    this.hitmarker = el('div', { cls: 'hitmarker', parent: this.root });
    for (let i = 0; i < 4; i++) el('span', { parent: this.hitmarker });
    this.apply(10);
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('weapon:fired', () => { this.bloom = Math.min(this.bloom + 6, 22); }),
      b.on('player:aimChanged', ({ aiming }) => { this.aiming = aiming; }),
      b.on('ui:hitmarker', ({ kill }) => {
        this.hitmarker.classList.remove('show', 'kill');
        // force restart of transition
        void this.hitmarker.offsetWidth;
        this.hitmarker.classList.add('show');
        if (kill) this.hitmarker.classList.add('kill');
        this.hitTimer = kill ? 0.22 : 0.12;
      }),
    );
  }

  update(dt: number, ctx: GameContext): void {
    const sprinting = ctx.player?.isSprinting ?? false;
    const base = this.aiming ? 5 : sprinting ? 16 : 10;
    this.bloom = damp(this.bloom, 0, 9, dt);
    this.targetGap = base + this.bloom;
    this.gap = damp(this.gap, this.targetGap, 18, dt);
    this.apply(this.gap);

    if (this.hitTimer > 0) {
      this.hitTimer -= dt;
      if (this.hitTimer <= 0) this.hitmarker.classList.remove('show');
    }
    const opacity = ctx.uiBlockers.size > 0 ? '0' : '1';
    if (this.root.style.opacity !== opacity) this.root.style.opacity = opacity;
  }

  private apply(gap: number): void {
    if (Math.abs(gap - this.lastGap) < 0.05) return;
    this.lastGap = gap;
    const g = gap.toFixed(2);
    this.ticks[0].style.transform = `translate(0, ${-gap - 8}px)`;
    this.ticks[1].style.transform = `translate(0, ${g}px)`;
    this.ticks[2].style.transform = `translate(${-gap - 8}px, 0)`;
    this.ticks[3].style.transform = `translate(${g}px, 0)`;
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
