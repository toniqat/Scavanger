import type { GameContext } from '@/shared';
import { PLAYER_MAX_HP, PLAYER_MAX_STAMINA } from '@/shared';
import { el, setText, toggleClass, damp } from '../dom';

const SEGMENTS = 10;
const STAMINA_PULSE = 0.9; // seconds the bar stays amber after depletion

/** Segmented health bar with damage ghost trail, HP number, stamina bar, stim/grenade pills. */
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
  private stamRoot: HTMLElement;
  private stamFill: HTMLElement;

  private hp = PLAYER_MAX_HP;
  private maxHp = PLAYER_MAX_HP;
  private shown = PLAYER_MAX_HP;     // smoothly follows hp
  private ghost = PLAYER_MAX_HP;     // slowly follows down
  private ghostDelay = 0;
  private lastShownKey = '';
  private staminaShown = 1;          // 0..1, damped
  private lastStaminaKey = '';
  private depletedTimer = 0;
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

    // Stamina: thin bar aligned under the HP bar (same width), dims while full.
    this.stamRoot = el('div', { cls: 'stamina full', parent: this.root });
    const stamBar = el('div', { cls: 'stam-bar', parent: this.stamRoot });
    this.stamFill = el('div', { cls: 'fill', parent: stamBar });
    el('div', { cls: 'ui-label', text: '스태미나', parent: this.stamRoot });

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
      ctx.bus.on('player:staminaDepleted', () => {
        this.depletedTimer = STAMINA_PULSE;
        // restart the pulse animation even if it is still running
        this.stamRoot.classList.remove('depleted');
        void this.stamRoot.offsetWidth;
        this.stamRoot.classList.add('depleted');
      }),
    );
  }

  update(dt: number, ctx: GameContext): void {
    if (ctx.player) { this.hp = ctx.player.hp; this.maxHp = ctx.player.maxHp; }
    this.updateStamina(dt, ctx);
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

  private updateStamina(dt: number, ctx: GameContext): void {
    const p = ctx.player;
    // Fields are appended to PlayerRef; fall back gracefully if the player has not published them yet.
    const max = (p?.maxStamina ?? PLAYER_MAX_STAMINA) || PLAYER_MAX_STAMINA;
    const cur = p?.stamina ?? max;
    const target = Math.min(1, Math.max(0, cur / max));
    this.staminaShown = Math.abs(target - this.staminaShown) < 0.002 ? target : damp(this.staminaShown, target, 16, dt);
    if (this.depletedTimer > 0) {
      this.depletedTimer -= dt;
      if (this.depletedTimer <= 0) this.stamRoot.classList.remove('depleted');
    }
    const full = this.staminaShown >= 0.995 && this.depletedTimer <= 0;
    const low = this.staminaShown < 0.25;
    const key = `${this.staminaShown.toFixed(3)}|${full ? 1 : 0}|${low ? 1 : 0}`;
    if (key === this.lastStaminaKey) return;
    this.lastStaminaKey = key;
    this.stamFill.style.transform = `scaleX(${this.staminaShown.toFixed(3)})`;
    toggleClass(this.stamRoot, 'full', full);
    toggleClass(this.stamRoot, 'low', low);
  }

  private setCount(pill: HTMLElement, val: HTMLElement, n: number): void {
    setText(val, String(n));
    toggleClass(pill, 'zero', n <= 0);
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
