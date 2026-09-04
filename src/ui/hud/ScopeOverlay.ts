import type { GameContext } from '@/shared';
import { el, setText, toggleClass } from '../dom';

/**
 * Full-screen sniper scope: near-black mask with a circular clear area, mil-dot crosshair,
 * lens vignette and a zoom label. Shown while aiming with a weapon that reports `scope: true`
 * on `weapon:scopeChanged`. Pure DOM/CSS, never intercepts pointer events.
 */
export class ScopeOverlay {
  readonly root: HTMLElement;
  private zoomLabel: HTMLElement;
  private scope = false;
  private zoom = 1;
  private aiming = false;
  private shown = false;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'scope', parent });
    el('div', { cls: 'mask', parent: this.root });
    el('div', { cls: 'lens', parent: this.root });
    const cross = el('div', { cls: 'cross', parent: this.root });
    // 4 arms with mil-dot ticks
    for (const dir of ['up', 'down', 'left', 'right']) {
      const arm = el('div', { cls: `arm ${dir}`, parent: cross });
      for (let i = 1; i <= 5; i++) {
        const t = el('i', { cls: i % 2 === 0 ? 'mil major' : 'mil', parent: arm });
        t.style.setProperty('--i', String(i));
      }
    }
    el('div', { cls: 'center', parent: cross });
    const info = el('div', { cls: 'info', parent: this.root });
    this.zoomLabel = el('div', { cls: 'zoom ui-mono', text: '4×', parent: info });
    el('div', { cls: 'ui-label', text: '조준경', parent: info });
  }

  /** True while the overlay is (or is fading) in. */
  get visible(): boolean { return this.shown; }

  bind(ctx: GameContext): void {
    this.unsubs.push(
      ctx.bus.on('weapon:scopeChanged', ({ zoom, scope }) => {
        this.scope = scope; this.zoom = zoom;
        const z = Math.round(zoom * 10) / 10;
        setText(this.zoomLabel, `${Number.isInteger(z) ? z.toFixed(0) : z.toFixed(1)}×`);
      }),
      ctx.bus.on('player:aimChanged', ({ aiming }) => { this.aiming = aiming; }),
      ctx.bus.on('game:abort', () => { this.aiming = false; this.scope = false; }),
    );
  }

  update(ctx: GameContext): void {
    const want = this.scope && this.aiming && ctx.isGameplayActive() && !(ctx.player?.isDead ?? false);
    if (want !== this.shown) {
      this.shown = want;
      toggleClass(this.root, 'show', want);
    }
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
