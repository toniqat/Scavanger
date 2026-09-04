import type { GameContext } from '@/shared';
import { PLAYER_MAX_HP } from '@/shared';
import { el, setText, toggleClass, damp } from '../dom';

const SEGMENTS = 10;

/** Segmented health bar with damage ghost trail, HP number, stim/grenade pills. */
export class Vitals {
  readonly root: HTMLElement;
  private fills: HTMLElement[] = [];
  private ghosts: HTMLElement[] = [];
  private hpNum: HTMLElement;
  private hpMax: HTMLElement;
  private stimPill: HTMLElement;
  private stimVal: HTMLElement;
  private grenPill: HTMLElement;
  private grenVal: HTMLElement;

  private hp = PLAYER_MAX_HP;
  private maxHp = PLAYER_MAX_HP;
  private shown = PLAYER_MAX_HP;     // smoothly follows hp
  private ghost = PLAYER_MAX_HP;     // slowly follows down
  private ghostDelay = 0;
  private lastShownKey = '';
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'vitals', parent });
    const row = el('div', { cls: 'row', parent: this.root });
    this.hpNum = el('div', { cls: 'hp-num ui-mono', text: '100', parent: row });
    this.hpMax = el('div', { cls: 'hp-max ui-mono', text: '/ 100', parent: row });
    const bar = el('div', { cls: 'hp-bar', parent: row });
    for (let i = 0; i < SEGMENTS; i++) {
      const seg = el('div', { cls: 'seg', parent: bar });
      this.ghosts.push(el('div', { cls: 'ghost', parent: seg }));
      this.fills.push(el('div', { cls: 'fill', parent: seg }));
    }
    el('div', { cls: 'ui-label', text: '생명력', parent: this.root });

    const pills = el('div', { cls: 'pills', parent: this.root });
    this.stimPill = el('div', { cls: 'pill', parent: pills });
    el('i', { cls: 'ico stim', parent: this.stimPill });
    this.stimVal = el('span', { cls: 'val', text: '0', parent: this.stimPill });
    el('span', { cls: 'key', text: 'F 회복', parent: this.stimPill });
    this.grenPill = el('div', { cls: 'pill', parent: pills });
    el('i', { cls: 'ico gren', parent: this.grenPill });
    this.grenVal = el('span', { cls: 'val', text: '0', parent: this.grenPill });
    el('span', { cls: 'key', text: 'G 수류탄', parent: this.grenPill });
    this.setCount(this.stimPill, this.stimVal, 0);
    this.setCount(this.grenPill, this.grenVal, 0);
  }

  bind(ctx: GameContext): void {
    this.unsubs.push(
      ctx.bus.on('player:healthChanged', ({ hp, maxHp, delta }) => {
        this.hp = hp; this.maxHp = maxHp;
        if (delta < 0) this.ghostDelay = 0.55;
        else this.ghost = Math.max(this.ghost, hp);
      }),
      ctx.bus.on('player:spawned', () => { this.hp = this.shown = this.ghost = ctx.player?.hp ?? PLAYER_MAX_HP; }),
      ctx.bus.on('stim:countChanged', ({ count }) => this.setCount(this.stimPill, this.stimVal, count)),
      ctx.bus.on('grenade:countChanged', ({ count }) => this.setCount(this.grenPill, this.grenVal, count)),
    );
  }

  update(dt: number, ctx: GameContext): void {
    if (ctx.player) { this.hp = ctx.player.hp; this.maxHp = ctx.player.maxHp; }
    this.shown = damp(this.shown, this.hp, 14, dt);
    if (this.ghostDelay > 0) this.ghostDelay -= dt;
    else this.ghost = this.ghost > this.shown ? damp(this.ghost, this.shown, 4, dt) : this.shown;
    if (this.ghost < this.shown) this.ghost = this.shown;

    const key = `${this.shown.toFixed(1)}|${this.ghost.toFixed(1)}|${this.maxHp}`;
    if (key === this.lastShownKey) return;
    this.lastShownKey = key;

    const per = this.maxHp / SEGMENTS;
    for (let i = 0; i < SEGMENTS; i++) {
      const f = Math.min(1, Math.max(0, (this.shown - i * per) / per));
      const g = Math.min(1, Math.max(0, (this.ghost - i * per) / per));
      this.fills[i].style.transform = `scaleX(${f.toFixed(3)})`;
      this.ghosts[i].style.transform = `scaleX(${g.toFixed(3)})`;
    }
    const hpInt = Math.ceil(this.hp);
    setText(this.hpNum, String(hpInt));
    setText(this.hpMax, `/ ${this.maxHp}`);
    const low = this.hp / this.maxHp < 0.4;
    toggleClass(this.hpNum, 'low', low);
    toggleClass(this.root, 'low', low);
  }

  private setCount(pill: HTMLElement, val: HTMLElement, n: number): void {
    setText(val, String(n));
    toggleClass(pill, 'zero', n <= 0);
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
