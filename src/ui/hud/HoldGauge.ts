import type { GameContext } from '@/shared';
import { el, setText, toggleClass } from '../dom';

const SIZE = 120;
const RADIUS = 48;

/**
 * 홀드 진행 링 at the **crosshair** (`.hold`, 2026-09-08).
 *
 * Every hold in the game now reports its progress in one place, the way 재장전 (`hud/ReloadGauge`) and 회복약
 * (`hud/HealGauge`) already do — the eye is on the reticle during a hold, not on a 3 px bar at the bottom of the
 * screen or in the corner of the vitals block. Both of those bars are gone: `hud/InteractionPrompt` keeps only its
 * "E — 상자 열기" line and `hud/Vitals` keeps only the 포기 caption.
 *
 * Two sources, 포기 wins when both are live (you can only give up while downed, where nothing is interactable):
 *   - `interact:promptChanged {holdProgress}` — 상자 / 시체 / 부활 / 채집 / 스위치, i.e. any `Interactable.holdTime`.
 *   - `player:giveUpProgress {t}` — Space held while 전투불능; drawn in the danger colour with a `포기` label,
 *     because it is the one hold that kills you.
 *
 * Same shape as the other two rings: one full-circle SVG driven by `stroke-dasharray`, `svg` rotated −90° so the
 * fill starts at 12 o'clock. Progress arrives per frame from the emitters, so there is no local countdown to tick.
 */
export class HoldGauge {
  readonly root: HTMLElement;
  private fill: SVGCircleElement;
  private label: HTMLElement;
  private circumference: number;
  private interact = 0;
  private giveUp = -1;
  private lastT = -1;
  private shownGiveUp = false;
  private ctx: GameContext | null = null;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'hold', parent });
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);
    const mk = (cls: string): SVGCircleElement => {
      const c = document.createElementNS(svgNS, 'circle');
      c.setAttribute('class', cls);
      c.setAttribute('cx', String(SIZE / 2)); c.setAttribute('cy', String(SIZE / 2)); c.setAttribute('r', String(RADIUS));
      svg.appendChild(c);
      return c;
    };
    mk('track');
    this.fill = mk('fill');
    this.circumference = 2 * Math.PI * RADIUS;
    this.fill.style.strokeDasharray = `0 ${this.circumference.toFixed(2)}`;
    this.root.appendChild(svg);
    this.label = el('div', { cls: 'lbl ui-mono', text: '', parent: this.root });
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    const b = ctx.bus;
    this.unsubs.push(
      b.on('interact:promptChanged', ({ text, holdProgress }) => {
        this.interact = text ? Math.max(0, Math.min(1, holdProgress)) : 0;
        this.apply();
      }),
      b.on('player:giveUpProgress', ({ t }) => { this.giveUp = t; this.apply(); }),
      b.on('player:revived', () => this.reset()),
      b.on('player:died', () => this.reset()),
      b.on('player:respawn', () => this.reset()),
      b.on('game:newMission', () => this.reset()),
      b.on('game:abort', () => this.reset()),
    );
  }

  private reset(): void {
    this.interact = 0;
    this.giveUp = -1;
    this.apply();
  }

  private apply(): void {
    // 포기 outranks an interaction hold: it is the only one with a lethal outcome, and the two never overlap anyway.
    // the 포기 hold only exists while 전투불능 — a stale progress event outside it must not light the ring
    const giving = this.giveUp >= 0 && this.ctx?.player?.isDowned === true;
    const t = giving ? this.giveUp : this.interact;
    const show = t > 0.001;
    toggleClass(this.root, 'show', show);
    if (giving !== this.shownGiveUp) {
      this.shownGiveUp = giving;
      toggleClass(this.root, 'is-giveup', giving);
      setText(this.label, giving ? '포기' : '');
    }
    this.setFill(show ? t : 0);
  }

  /** Whether the ring is showing (debug / smoke). */
  get isShowing(): boolean { return this.root.classList.contains('show'); }
  /** Fill fraction 0..1 while showing, else −1 (debug / smoke). */
  get progress(): number { return this.isShowing ? this.lastT : -1; }
  /** True while the ring is drawing the 포기 hold rather than an interaction (debug / smoke). */
  get isGiveUp(): boolean { return this.root.classList.contains('is-giveup'); }

  private setFill(t: number): void {
    if (Math.abs(t - this.lastT) < 0.003) return;
    this.lastT = t;
    this.fill.style.strokeDasharray = `${(t * this.circumference).toFixed(2)} ${this.circumference.toFixed(2)}`;
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
