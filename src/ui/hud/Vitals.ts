import type { GameContext } from '@/shared';
import { PLAYER_MAX_HP, PLAYER_MAX_STAMINA, PLAYER_DOWN_HP } from '@/shared';
import { el, setText, toggleClass, damp } from '../dom';

const SEGMENTS = 10;
const STAMINA_PULSE = 0.9; // seconds the bar stays amber after depletion

/**
 * Segmented health bar with damage ghost trail, HP number, stamina bar, stim/grenade pills.
 * **Downed mode** (`.vitals.downed`, `player:downed` → `player:revived` / `player:spawned` / `player:died`): the bar
 * shows `downHp / PLAYER_DOWN_HP` in red (`player:downHpChanged`, also polled from `ctx.player.downHp`), the label reads
 * `전투불능 — 아군의 구조 대기 중` with `Space 길게: 포기` under it, and `player:reviveProgress` shows
 * `부활 중 <byName> … n%` + a progress bar (hidden on `t = -1`). **Phase 9:** the Space give-up hold shows a red
 * `포기` bar (`.giveup`, `player:giveUpProgress {t}`, `t < 0` hides; also hidden whenever the downed state ends).
 */
export class Vitals {
  readonly root: HTMLElement;
  private fills: HTMLElement[] = [];
  private ghosts: HTMLElement[] = [];
  private hpNum: HTMLElement;
  private hpMax: HTMLElement;
  private labelEl: HTMLElement;
  private downSub: HTMLElement;
  private reviveEl: HTMLElement;
  private reviveTxt: HTMLElement;
  private reviveFill: HTMLElement;
  private giveUpEl: HTMLElement;
  private giveUpFill: HTMLElement;
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
  private downed = false;
  private downHp = PLAYER_DOWN_HP;
  private lastReviveT = -1;
  private lastGiveUpT = -1;
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
    this.labelEl = el('div', { cls: 'ui-label', text: '생명력', parent: this.root });
    this.downSub = el('div', { cls: 'down-sub', text: 'Space 길게: 포기', parent: this.root });
    this.reviveEl = el('div', { cls: 'revive', parent: this.root });
    this.reviveTxt = el('div', { cls: 'txt', text: '', parent: this.reviveEl });
    const reviveBar = el('div', { cls: 'bar', parent: this.reviveEl });
    this.reviveFill = el('div', { cls: 'fill', parent: reviveBar });
    this.giveUpEl = el('div', { cls: 'giveup', parent: this.root });
    el('div', { cls: 'txt', text: '포기', parent: this.giveUpEl });
    const giveUpBar = el('div', { cls: 'bar', parent: this.giveUpEl });
    this.giveUpFill = el('div', { cls: 'fill', parent: giveUpBar });

    // Stamina: bottom-centre bar (its own HUD element, not part of the vitals block); hidden while full.
    this.stamRoot = el('div', { cls: 'stamina full', parent });
    const stamBar = el('div', { cls: 'stam-bar', parent: this.stamRoot });
    this.stamFill = el('div', { cls: 'fill', parent: stamBar });
    el('div', { cls: 'ui-label', text: '스태미나', parent: this.stamRoot });

    const pills = el('div', { cls: 'pills', parent: this.root });
    this.stimPill = el('div', { cls: 'pill', parent: pills });
    el('i', { cls: 'ico stim', parent: this.stimPill });
    this.stimVal = el('span', { cls: 'val', text: '0', parent: this.stimPill });
    el('span', { cls: 'key', text: 'H 스팀 · T 빠른 사용', parent: this.stimPill });
    this.grenPill = el('div', { cls: 'pill', parent: pills });
    el('i', { cls: 'ico gren', parent: this.grenPill });
    this.grenVal = el('span', { cls: 'val', text: '0', parent: this.grenPill });
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
      ctx.bus.on('player:spawned', () => {
        this.setDowned(false);
        this.hp = this.shown = this.ghost = ctx.player?.hp ?? PLAYER_MAX_HP;
      }),
      ctx.bus.on('stim:countChanged', ({ count }) => this.setCount(this.stimPill, this.stimVal, count)),
      ctx.bus.on('grenade:countChanged', ({ count }) => this.setCount(this.grenPill, this.grenVal, count)),
      ctx.bus.on('player:staminaDepleted', () => {
        this.depletedTimer = STAMINA_PULSE;
        // restart the pulse animation even if it is still running
        this.stamRoot.classList.remove('depleted');
        void this.stamRoot.offsetWidth;
        this.stamRoot.classList.add('depleted');
      }),
      // ── downed / revive ──
      ctx.bus.on('player:downed', () => {
        this.downHp = ctx.player?.downHp ?? PLAYER_DOWN_HP;
        this.setDowned(true);
      }),
      ctx.bus.on('player:downHpChanged', ({ downHp }) => { this.downHp = downHp; }),
      ctx.bus.on('player:reviveProgress', ({ t, byName }) => this.setRevive(t, byName)),
      ctx.bus.on('player:giveUpProgress', ({ t }) => this.setGiveUp(t)),
      ctx.bus.on('player:revived', ({ hp }) => {
        this.setDowned(false);
        this.hp = this.shown = this.ghost = hp;
      }),
      ctx.bus.on('player:died', () => this.setDowned(false)),
      ctx.bus.on('game:newMission', () => this.setDowned(false)),
      ctx.bus.on('game:abort', () => this.setDowned(false)),
    );
  }

  update(dt: number, ctx: GameContext): void {
    if (ctx.player) {
      this.hp = ctx.player.hp; this.maxHp = ctx.player.maxHp;
      // Poll the live pool while the player really is downed; otherwise trust `player:downHpChanged`.
      if (this.downed && ctx.player.isDowned && typeof ctx.player.downHp === 'number') this.downHp = ctx.player.downHp;
    }
    this.updateStamina(dt, ctx);
    const target = this.downed ? this.downHp : this.hp;
    const max = this.downed ? PLAYER_DOWN_HP : this.maxHp;
    this.shown = damp(this.shown, target, 14, dt);
    if (this.ghostDelay > 0) this.ghostDelay -= dt;
    else this.ghost = this.ghost > this.shown ? damp(this.ghost, this.shown, 4, dt) : this.shown;
    if (this.ghost < this.shown) this.ghost = this.shown;

    const key = `${this.shown.toFixed(1)}|${this.ghost.toFixed(1)}|${max}|${this.downed ? 1 : 0}`;
    if (key === this.lastShownKey) return;
    this.lastShownKey = key;

    const per = max / SEGMENTS;
    for (let i = 0; i < SEGMENTS; i++) {
      const f = Math.min(1, Math.max(0, (this.shown - i * per) / per));
      const g = Math.min(1, Math.max(0, (this.ghost - i * per) / per));
      this.fills[i].style.transform = `scaleX(${f.toFixed(3)})`;
      this.ghosts[i].style.transform = `scaleX(${g.toFixed(3)})`;
    }
    const hpInt = Math.ceil(target);
    setText(this.hpNum, String(hpInt));
    setText(this.hpMax, `/ ${max}`);
    const low = this.downed || target / max < 0.4;
    toggleClass(this.hpNum, 'low', low);
    toggleClass(this.root, 'low', low);
  }

  private setDowned(on: boolean): void {
    if (this.downed === on) { if (!on) { this.setRevive(-1, null); this.setGiveUp(-1); } return; }
    this.downed = on;
    toggleClass(this.root, 'downed', on);
    setText(this.labelEl, on ? '전투불능 — 아군의 구조 대기 중' : '생명력');
    if (on) {
      // Snap the bar to the down pool so it does not drain from 0 up to 100.
      this.shown = this.ghost = this.downHp;
      this.ghostDelay = 0;
    }
    this.setRevive(-1, null);
    this.setGiveUp(-1);
  }

  /** Space give-up hold (Phase 9): `t` 0..1 fills the red bar, `t < 0` (released / cancelled) hides it. */
  private setGiveUp(t: number): void {
    const on = t >= 0 && this.downed;
    toggleClass(this.giveUpEl, 'show', on);
    if (!on) {
      if (this.lastGiveUpT !== -1) { this.lastGiveUpT = -1; this.giveUpFill.style.transform = 'scaleX(0)'; }
      return;
    }
    if (Math.abs(t - this.lastGiveUpT) > 0.004) {
      this.lastGiveUpT = t;
      this.giveUpFill.style.transform = `scaleX(${Math.min(1, t).toFixed(3)})`;
    }
  }

  private setRevive(t: number, byName: string | null): void {
    const on = t >= 0 && this.downed;
    toggleClass(this.reviveEl, 'show', on);
    if (!on) { this.lastReviveT = -1; return; }
    const pct = Math.round(Math.min(1, t) * 100);
    setText(this.reviveTxt, `부활 중 ${byName ?? '아군'} … ${pct}%`);
    if (Math.abs(t - this.lastReviveT) > 0.004) {
      this.lastReviveT = t;
      this.reviveFill.style.transform = `scaleX(${Math.min(1, t).toFixed(3)})`;
    }
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
    const full = (this.staminaShown >= 0.995 && this.depletedTimer <= 0) || this.downed;
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

  /** Whether the give-up bar is up (debug). */
  get isGiveUpShowing(): boolean { return this.giveUpEl.classList.contains('show'); }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); this.stamRoot.remove(); }
}
