import type { CharBuff, GameContext, Rarity } from '@/shared';
import { ARMOR_SHIELD_PER_SEGMENT, PLAYER_MAX_HP, PLAYER_MAX_STAMINA, PLAYER_DOWN_HP } from '@/shared';
import { damp, el, rarityColor, restartAnim, setText, toggleClass } from '../dom';
import '../styles/raidHud.css';
import { BuffStrip } from './BuffStrip';

const STAMINA_PULSE = 0.9; // seconds the bar stays amber after depletion
/** How long the damage ghost stands still at the spot it was cut to (seconds) — shared by hp and shield. */
const GHOST_HOLD = 0.55;
/** Fallback name when neither the lobby nor the profile has one yet. */
const FALLBACK_NAME = '스캐빈저';

/** How much one gauge cell stands for (shared by hp and shield, `data/constants.csv`). */
const PER_SEG = Math.max(1, ARMOR_SHIELD_PER_SEGMENT);
/** Cells for a pool of `max` (hp 100 → 5 cells, a tier III armor's shield 60 → 3 cells). */
const cellsFor = (max: number): number => Math.max(0, Math.round(max / PER_SEG));

interface Bar {
  root: HTMLElement;
  fills: HTMLElement[];
  ghosts: HTMLElement[];
  cells: number;
}

/**
 * The bottom-left survival block. Rebuilt on 2026-09-10 (the raid HUD rework, user's decision):
 *
 *   name                    ← `.vt-name`, top left of the shield gauge
 *   ▮▮▯▯▯  shield         ← `.sh-bar`, one cell = `ARMOR_SHIELD_PER_SEGMENT` (20), cell colour = the armor's rarity colour
 *   ▮▮▮▮▮  hp             ← `.hp-bar`, the same scale, so five cells (100 / 20)
 *
 * **There is no hp number and no `생명력` label.** The two gauges share width · alignment · cell scale, so the shield reads as one row
 * laid over the hp (only the cell count differs — a lower armor tier leaves a few cells on the left). Shield data is `ctx.player.shield /
 * maxShield / shieldRarity` and also arrives on `player:shieldChanged` (both are read — as with hp, polling is the source, the event is immediacy).
 * **With no armor (`maxShield` 0) the whole shield row folds away** (`hidden`) — only the name and hp are left.
 * **2026-09-14 (user's decision):** on both gauges a **pale red ghost** (`.ghost`) stays at the spot that was hit for `GHOST_HOLD`, then follows
 * (it used to be hp only, in a pale white that could not be told apart from the white `.fill`). The colour lives in one place, `ui/styles/base.css` —
 * downed (`.vitals.downed .seg .ghost`) is a deeper red.
 * The name is `ctx.net.playerName` (= the character name, put there by `progression` on `progress:loaded`) → with none
 * `ctx.progression.profile.name` → with none still `스캐빈저`. It appears in single player too, with no relay.
 *
 * **Downed mode** (`.vitals.downed`, `player:downed` → `player:revived` / `player:spawned` / `player:died`): the health
 * bar shows `downHp / PLAYER_DOWN_HP` in red (`player:downHpChanged`, also polled from `ctx.player.downHp`), the label
 * reads `전투불능 — 아군의 구조 대기 중` with `Space 길게: 포기` under it, and `player:reviveProgress` shows
 * `부활 중 <byName> … n%` + a progress bar (hidden on `t = -1`). The shield row folds away meanwhile. **Phase 9:** the Space
 * give-up hold shows a red `포기` caption (`.giveup`, `player:giveUpProgress {t}`); 2026-09-08 the progress itself is
 * drawn by `hud/HoldGauge` at the crosshair — this is only the label.
 *
 * **2026-09-12 (character buffs, user's decision):** this block shows **in the ship too** — so `HudSystem` mounts the root in the **social layer**
 * (`new Vitals(gameplayRoot, null)` → `socialRoot.appendChild(vitals.root)`, the same move as `HoldGauge` on 2026-09-09), and only the stamina bar
 * stays in the gameplay layer as **raid-only**. In the ship (`hub` · `docking`) hp and shield are drawn **always full** (the same rule as the squad
 * list's `hub ? 1`). **Directly under** the hp bar stands my buff thumbnail strip (`hud/BuffStrip`) — `ctx.player.buffs` is polled every frame by
 * reference comparison and also arrives on `player:buffsChanged`. `setDebugBuffs(list)` is the smoke override (null = back to the real source).
 */
export class Vitals {
  readonly root: HTMLElement;
  /** 2026-09-12: my buff · debuff thumbnail strip (directly under the hp bar). */
  readonly buffs: BuffStrip;
  private nameEl: HTMLElement;
  private hpBar: Bar;
  private shBar: Bar;
  private labelEl: HTMLElement;
  private downSub: HTMLElement;
  private reviveEl: HTMLElement;
  private reviveTxt: HTMLElement;
  private reviveFill: HTMLElement;
  private giveUpEl: HTMLElement;
  private stamRoot: HTMLElement;
  private stamFill: HTMLElement;

  private hp = PLAYER_MAX_HP;
  private maxHp = PLAYER_MAX_HP;
  private shown = PLAYER_MAX_HP;     // smoothly follows hp
  private ghost = PLAYER_MAX_HP;     // slowly follows down
  private ghostDelay = 0;
  private lastShownKey = '';
  private shield = 0;
  private maxShield = 0;
  private shieldRarity: Rarity | null = null;
  private shieldShown = 0;           // damped, like `shown`
  /** 2026-09-14: the shield has the same ghost as hp — the cut spot stays pale red for a moment, then follows. */
  private shieldGhost = 0;
  private shieldGhostDelay = 0;
  private lastShieldTarget = 0;
  private lastShieldKey = '';
  private lastName = '';
  private staminaShown = 1;          // 0..1, damped
  private lastStaminaKey = '';
  private depletedTimer = 0;
  private downed = false;
  private downHp = PLAYER_DOWN_HP;
  private lastReviveT = -1;
  private lastGiveUpT = -1;
  private unsubs: Array<() => void> = [];
  /** Smoke override for the buff strip; `undefined` = read `ctx.player.buffs`. */
  private debugBuffs: readonly CharBuff[] | undefined = undefined;

  /**
   * @param staminaParent  layer for the raid-only stamina bar (the gameplay HUD).
   * @param vitalsParent   layer for the name / shield / hp block; `null` leaves the root detached for the caller to mount
   *                       (HudSystem puts it in the social layer so it shows in the ship). Defaults to `staminaParent`.
   */
  constructor(staminaParent: HTMLElement, vitalsParent: HTMLElement | null = staminaParent) {
    this.root = el('div', { cls: 'vitals', parent: vitalsParent ?? undefined });
    this.nameEl = el('div', { cls: 'vt-name', text: '', parent: this.root });
    this.shBar = this.makeBar('sh-bar', 'sh-seg', 0);
    this.hpBar = this.makeBar('hp-bar', 'seg', cellsFor(PLAYER_MAX_HP));
    this.shBar.root.hidden = true;
    // 2026-09-12: right under the hp bar (before the downed caption rows, which stay hidden outside the downed state).
    this.buffs = new BuffStrip(this.root);

    // 2026-09-10: the `.hp-num` / `.hp-max` numbers and the `생명력` label are gone. The label element stays, for the downed caption only
    // (`styles/raidHud.css` keeps it `display:none` the rest of the time).
    this.labelEl = el('div', { cls: 'ui-label', text: '', parent: this.root });
    this.downSub = el('div', { cls: 'down-sub', text: 'Space 길게: 포기', parent: this.root });
    this.reviveEl = el('div', { cls: 'revive', parent: this.root });
    this.reviveTxt = el('div', { cls: 'txt', text: '', parent: this.reviveEl });
    const reviveBar = el('div', { cls: 'bar', parent: this.reviveEl });
    this.reviveFill = el('div', { cls: 'fill', parent: reviveBar });
    this.giveUpEl = el('div', { cls: 'giveup', parent: this.root });
    el('div', { cls: 'txt', text: '포기', parent: this.giveUpEl });

    // Stamina: bottom-centre bar (its own HUD element, not part of the vitals block); hidden while full.
    this.stamRoot = el('div', { cls: 'stamina full', parent: staminaParent });
    const stamBar = el('div', { cls: 'stam-bar', parent: this.stamRoot });
    this.stamFill = el('div', { cls: 'fill', parent: stamBar });
    el('div', { cls: 'ui-label', text: '스태미나', parent: this.stamRoot });
  }

  /** One segmented bar. Cells are pooled and only rebuilt when the cell count itself changes. */
  private makeBar(rootCls: string, segCls: string, cells: number): Bar {
    const bar: Bar = { root: el('div', { cls: rootCls, parent: this.root }), fills: [], ghosts: [], cells: 0 };
    this.setCells(bar, segCls, cells);
    return bar;
  }

  private setCells(bar: Bar, segCls: string, cells: number): void {
    if (bar.cells === cells) return;
    bar.cells = cells;
    bar.root.replaceChildren();
    bar.fills.length = 0;
    bar.ghosts.length = 0;
    for (let i = 0; i < cells; i++) {
      const seg = el('div', { cls: segCls, parent: bar.root });
      bar.ghosts.push(el('div', { cls: 'ghost', parent: seg }));
      bar.fills.push(el('div', { cls: 'fill', parent: seg }));
    }
    // The shield must keep **the same scale as hp** even though the cell count differs per armor tier, so the cell width is based on at least 5 cells.
    bar.root.style.setProperty('--sh-cells', String(Math.max(cellsFor(PLAYER_MAX_HP), cells)));
  }

  bind(ctx: GameContext): void {
    this.unsubs.push(
      // 2026-09-12: the list reference also gets polled in `update`; the event only makes the change land this frame.
      ctx.bus.on('player:buffsChanged', ({ buffs }) => { if (this.debugBuffs === undefined) this.buffs.set(buffs, ctx); }),
      ctx.bus.on('player:healthChanged', ({ hp, maxHp, delta }) => {
        this.hp = hp; this.maxHp = maxHp;
        if (delta < 0) this.ghostDelay = GHOST_HOLD;
        else this.ghost = Math.max(this.ghost, hp);
      }),
      // Shield (2026-09-10): player/ owns it and announces it with this event. The same value as the polling in `update`, but it lands at once.
      ctx.bus.on('player:shieldChanged', ({ shield, maxShield, rarity }) => {
        this.shield = shield; this.maxShield = maxShield; this.shieldRarity = rarity;
      }),
      ctx.bus.on('player:spawned', () => {
        this.setDowned(false);
        this.hp = this.shown = this.ghost = ctx.player?.hp ?? PLAYER_MAX_HP;
        this.shieldShown = this.shield = ctx.player?.shield ?? 0;
        this.shieldGhost = this.lastShieldTarget = this.shieldShown;
        this.shieldGhostDelay = 0;
      }),
      ctx.bus.on('player:staminaDepleted', () => {
        this.depletedTimer = STAMINA_PULSE;
        // restart the pulse animation even if it is still running (no `offsetWidth` reflow — this is inside a frame)
        restartAnim(this.stamRoot, 'depleted');
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
    this.updateName(ctx);
  }

  update(dt: number, ctx: GameContext): void {
    // 2026-09-14 (the tutorial's sequential HUD reveal): hp · shield are absent until gear is taken from a corpse, stamina
    //   until it is first spent. With the tutorial off this is always false, so the normal screen does not change by one glyph.
    toggleClass(this.root, 'hud-tut-hidden', ctx.tutorial?.hides('hud', 'vitals') ?? false);
    toggleClass(this.stamRoot, 'hud-tut-hidden', ctx.tutorial?.hides('hud', 'stamina') ?? false);
    // 2026-09-12: the block shows in the ship too, where the body is always full (the squad list's `hub ? 1` rule).
    const hub = ctx.phase === 'hub' || ctx.phase === 'docking';
    if (ctx.player) {
      this.maxHp = ctx.player.maxHp;
      this.hp = hub ? ctx.player.maxHp : ctx.player.hp;
      // The shield contract belongs to player/ — read with `?? 0` so a build that has not published it yet does not break.
      this.maxShield = ctx.player.maxShield ?? 0;
      this.shield = hub ? this.maxShield : (ctx.player.shield ?? 0);
      this.shieldRarity = ctx.player.shieldRarity ?? null;
      // Poll the live pool while the player really is downed; otherwise trust `player:downHpChanged`.
      if (this.downed && ctx.player.isDowned && typeof ctx.player.downHp === 'number') this.downHp = ctx.player.downHp;
    }
    this.updateName(ctx);
    // same array = no-op inside the strip (the owner swaps the array only when the list really changed)
    this.buffs.set(this.debugBuffs !== undefined ? this.debugBuffs : (ctx.player?.buffs ?? null), ctx);
    this.buffs.update(ctx);
    this.updateStamina(dt, ctx);
    this.updateShield(dt);
    const target = this.downed ? this.downHp : this.hp;
    const max = this.downed ? PLAYER_DOWN_HP : this.maxHp;
    this.shown = damp(this.shown, target, 14, dt);
    if (this.ghostDelay > 0) this.ghostDelay -= dt;
    else this.ghost = this.ghost > this.shown ? damp(this.ghost, this.shown, 4, dt) : this.shown;
    if (this.ghost < this.shown) this.ghost = this.shown;

    const key = `${this.shown.toFixed(1)}|${this.ghost.toFixed(1)}|${max}|${this.downed ? 1 : 0}`;
    if (key === this.lastShownKey) return;
    this.lastShownKey = key;

    this.setCells(this.hpBar, 'seg', cellsFor(max));
    const per = this.hpBar.cells > 0 ? max / this.hpBar.cells : max;
    for (let i = 0; i < this.hpBar.cells; i++) {
      const f = Math.min(1, Math.max(0, (this.shown - i * per) / per));
      const g = Math.min(1, Math.max(0, (this.ghost - i * per) / per));
      this.hpBar.fills[i].style.transform = `scaleX(${f.toFixed(3)})`;
      this.hpBar.ghosts[i].style.transform = `scaleX(${g.toFixed(3)})`;
    }
    toggleClass(this.root, 'low', this.downed || target / max < 0.4);
  }

  /**
   * Shield cells: with no armor, or while downed, the row itself folds away.
   *
   * **2026-09-14 (user's decision) — the shield has exactly the same ghost (`.ghost`) as hp.** `setCells` used to build a
   * `.ghost` div per cell that nobody ever moved, so how much armor had been cut was not visible at a glance. It works like hp —
   * it stops for `GHOST_HOLD` on the frame it dropped, then follows slowly. The colour lives in one place, `ui/styles/base.css` (pale red).
   * hp knows 「깎였다」 from `player:healthChanged.delta`, but `player:shieldChanged` carries no delta, so the judgement
   * **compares against the previous target** (the polling in `update` is the source, so watching only the event misses it).
   */
  private updateShield(dt: number): void {
    const on = !this.downed && this.maxShield > 0;
    const target = on ? Math.min(this.shield, this.maxShield) : 0;
    if (target < this.lastShieldTarget - 0.01) this.shieldGhostDelay = GHOST_HOLD;
    this.lastShieldTarget = target;
    this.shieldShown = Math.abs(target - this.shieldShown) < 0.05 ? target : damp(this.shieldShown, target, 16, dt);
    if (this.shieldGhostDelay > 0) this.shieldGhostDelay -= dt;
    else if (this.shieldGhost > this.shieldShown) {
      // The same damp as hp, but the last 0.05 snaps (the same contract as `shieldShown`). On the snapping frame `lastShieldKey`
      // is cleared so the DOM is **written once more for certain** — the key below is `toFixed(1)`, so 0.04 → 0 is the same text and
      // without clearing it the last transform freezes at `scaleX(0.002)` (0.1 px to the eye, but stopped at a value that is not the target).
      if (this.shieldGhost - this.shieldShown < 0.05) { this.shieldGhost = this.shieldShown; this.lastShieldKey = ''; }
      else this.shieldGhost = damp(this.shieldGhost, this.shieldShown, 4, dt);
    } else this.shieldGhost = this.shieldShown;
    if (this.shieldGhost < this.shieldShown) this.shieldGhost = this.shieldShown;
    if (this.shieldGhost > this.maxShield) this.shieldGhost = this.maxShield;   // a change of armor that shrinks the cells clips the ghost too
    const cells = on ? cellsFor(this.maxShield) : 0;
    const key = `${on ? 1 : 0}|${cells}|${this.shieldShown.toFixed(1)}|${this.shieldGhost.toFixed(1)}|${this.shieldRarity ?? '-'}`;
    if (key === this.lastShieldKey) return;
    this.lastShieldKey = key;
    if (this.shBar.root.hidden === on) this.shBar.root.hidden = !on;
    if (!on) { this.shieldGhost = 0; this.shieldGhostDelay = 0; return; }
    this.setCells(this.shBar, 'sh-seg', cells);
    const rc = rarityColor(this.shieldRarity ?? 'common');
    if (this.shBar.root.style.getPropertyValue('--shc') !== rc) this.shBar.root.style.setProperty('--shc', rc);
    const per = this.maxShield / Math.max(1, cells);
    for (let i = 0; i < cells; i++) {
      const f = Math.min(1, Math.max(0, (this.shieldShown - i * per) / per));
      const g = Math.min(1, Math.max(0, (this.shieldGhost - i * per) / per));
      this.shBar.fills[i].style.transform = `scaleX(${f.toFixed(3)})`;
      this.shBar.ghosts[i].style.transform = `scaleX(${g.toFixed(3)})`;
    }
  }

  /** Name: the lobby name = the character name. In single player with no relay it is read straight from the profile. */
  private updateName(ctx: GameContext): void {
    const name = ctx.net?.playerName || ctx.progression?.profile?.name || FALLBACK_NAME;
    if (name === this.lastName) return;
    this.lastName = name;
    setText(this.nameEl, name);
  }

  private setDowned(on: boolean): void {
    if (this.downed === on) { if (!on) { this.setRevive(-1, null); this.setGiveUp(-1); } return; }
    this.downed = on;
    toggleClass(this.root, 'downed', on);
    setText(this.labelEl, on ? '전투불능 — 아군의 구조 대기 중' : '');
    if (on) {
      // Snap the bar to the down pool so it does not drain from 0 up to 100.
      this.shown = this.ghost = this.downHp;
      this.ghostDelay = 0;
    }
    this.setRevive(-1, null);
    this.setGiveUp(-1);
  }

  /** Space give-up hold: `t ≥ 0` shows the 포기 caption, `t < 0` (released / cancelled) hides it. 2026-09-08: the
   *  fill moved to `hud/HoldGauge`, so this only tracks whether the hold is running. */
  private setGiveUp(t: number): void {
    const on = t >= 0 && this.downed;
    toggleClass(this.giveUpEl, 'show', on);
    this.lastGiveUpT = on ? t : -1;
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

  /** Whether the give-up bar is up (debug). */
  get isGiveUpShowing(): boolean { return this.giveUpEl.classList.contains('show'); }
  /** Shield cell count (0 = no armor, debug). */
  get shieldSegments(): number { return this.shBar.root.hidden ? 0 : this.shBar.cells; }
  /** The player name on display (debug). */
  get displayName(): string { return this.lastName; }
  /** Smoke hook: draw this list instead of `ctx.player.buffs` (`null` hands the strip back to the player). */
  setDebugBuffs(list: readonly CharBuff[] | null): void { this.debugBuffs = list ?? undefined; }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); this.stamRoot.remove(); }
}
