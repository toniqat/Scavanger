import type { GameContext } from '@/shared';
import { el, setText, toggleClass } from '../dom';

/**
 * Short screen-space feedback for the tactical kit: melee swings/hits, rolls, dashes, barrier impacts,
 * the 인내 (grit) save, burning and cloak states. Pure CSS animations on a handful of pooled elements in
 * the overlay layer — never allocates, never intercepts pointer events.
 */
export class ActionFeedback {
  readonly root: HTMLElement;
  private swipe: HTMLElement;
  private roll: HTMLElement;
  private dash: HTMLElement;
  private shield: HTMLElement;
  private flash: HTMLElement;
  private banner: HTMLElement;
  private burn: HTMLElement;
  private cloak: HTMLElement;

  private bannerTimer = 0;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'action-fx', parent });
    this.burn = el('div', { cls: 'fx-burn', parent: this.root });
    this.cloak = el('div', { cls: 'fx-cloak', parent: this.root });
    this.shield = el('div', { cls: 'fx-shield', parent: this.root });
    this.dash = el('div', { cls: 'fx-dash', parent: this.root });
    this.roll = el('div', { cls: 'fx-roll', parent: this.root });
    this.swipe = el('div', { cls: 'fx-swipe', parent: this.root });
    el('i', { parent: this.swipe });
    this.flash = el('div', { cls: 'fx-flash', parent: this.root });
    this.banner = el('div', { cls: 'fx-banner', parent: this.root });
    this.banner.hidden = true;
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('melee:swing', () => this.play(this.swipe, 'go')),
      b.on('melee:hit', ({ killed }) => {
        this.play(this.swipe, 'hit');
        if (killed) this.play(this.flash, 'go');
      }),
      b.on('player:rolled', () => this.play(this.roll, 'go')),
      b.on('implant:dashed', () => this.play(this.dash, 'go')),
      b.on('implant:barrierHit', () => this.play(this.shield, 'go')),
      b.on('player:gritSaved', () => {
        this.play(this.flash, 'grit');
        this.showBanner('인내 — 버텨냈다', 1.6);
      }),
      b.on('player:burning', ({ active }) => toggleClass(this.burn, 'on', active)),
      b.on('player:cloakChanged', ({ cloaked }) => toggleClass(this.cloak, 'on', cloaked)),
      b.on('player:revived', ({ by }) => this.showBanner(by ? `${by}이(가) 부활시켰습니다` : '부활', 2)),
      b.on('game:abort', () => this.reset()),
      b.on('game:newMission', () => this.reset()),
      b.on('player:died', () => this.reset()),
    );
  }

  /** Restart a CSS animation class (remove → reflow → add). */
  private play(node: HTMLElement, cls: string): void {
    node.classList.remove('go', 'hit', 'grit');
    void node.offsetWidth;
    node.classList.add(cls);
  }

  private showBanner(text: string, ttl: number): void {
    setText(this.banner, text);
    this.banner.hidden = false;
    this.banner.classList.remove('in');
    void this.banner.offsetWidth;
    this.banner.classList.add('in');
    this.bannerTimer = ttl;
  }

  private reset(): void {
    for (const n of [this.swipe, this.roll, this.dash, this.shield, this.flash]) n.classList.remove('go', 'hit', 'grit');
    toggleClass(this.burn, 'on', false);
    toggleClass(this.cloak, 'on', false);
    this.banner.hidden = true;
    this.banner.classList.remove('in');
    this.bannerTimer = 0;
  }

  update(dt: number, ctx: GameContext): void {
    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) {
        this.banner.classList.remove('in');
        this.banner.hidden = true;
      }
    }
    // Keep the persistent states in sync even if an event was missed (rejoin, respawn).
    const p = ctx.player;
    if (p) {
      toggleClass(this.burn, 'on', p.isBurning === true && !p.isDead);
      toggleClass(this.cloak, 'on', p.isCloaked === true && !p.isDead);
    }
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.root.remove();
  }
}
