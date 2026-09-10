import type { GameContext, Rarity } from '@/shared';
import { ARMOR_SHIELD_PER_SEGMENT, PLAYER_MAX_HP, PLAYER_MAX_STAMINA, PLAYER_DOWN_HP } from '@/shared';
import { el, setText, toggleClass, damp, rarityColor } from '../dom';
import '../styles/raidHud.css';

const STAMINA_PULSE = 0.9; // seconds the bar stays amber after depletion
/** Fallback name when neither the lobby nor the profile has one yet. */
const FALLBACK_NAME = '스캐빈저';

/** 게이지 한 칸이 나타내는 양 (체력 · 실드 공용, `data/constants.csv`). */
const PER_SEG = Math.max(1, ARMOR_SHIELD_PER_SEGMENT);
/** Cells for a pool of `max` (체력 100 → 5칸, 방탄복 III 실드 60 → 3칸). */
const cellsFor = (max: number): number => Math.max(0, Math.round(max / PER_SEG));

interface Bar {
  root: HTMLElement;
  fills: HTMLElement[];
  ghosts: HTMLElement[];
  cells: number;
}

/**
 * 좌측 하단 생존 정보. 2026-09-10 (레이드 HUD 개편, 사용자 결정)으로 다시 짜였다:
 *
 *   이름                    ← `.vt-name`, 실드 게이지 좌측 상단
 *   ▮▮▯▯▯  실드            ← `.sh-bar`, 한 칸 = `ARMOR_SHIELD_PER_SEGMENT`(20), 칸 색 = 방탄복 등급색
 *   ▮▮▮▮▮  체력            ← `.hp-bar`, 같은 눈금이라 5등분 (100 / 20)
 *
 * **체력 수치와 `생명력` 라벨은 없다.** 두 게이지는 폭 · 정렬 · 칸 눈금이 같아서 실드가 체력 위에 얹힌 한 줄로 읽힌다
 * (칸 수만 다르다 — 방탄복 등급이 낮으면 왼쪽 몇 칸만 있다). 실드 데이터는 `ctx.player.shield / maxShield /
 * shieldRarity` 이고 `player:shieldChanged` 로도 들어온다 (둘 다 본다 — 체력이 그렇듯 폴링이 원본이고 이벤트는 즉시성).
 * **방탄복이 없으면(`maxShield` 0) 실드 줄은 통째로 접힌다** (`hidden`) — 이름과 체력만 남는다.
 * 이름은 `ctx.net.playerName`(= 캐릭터 이름, `progression` 이 `progress:loaded` 에 넣어 준다) → 없으면
 * `ctx.progression.profile.name` → 그래도 없으면 `스캐빈저`. 싱글 플레이에서도 릴레이 없이 나온다.
 *
 * **Downed mode** (`.vitals.downed`, `player:downed` → `player:revived` / `player:spawned` / `player:died`): the health
 * bar shows `downHp / PLAYER_DOWN_HP` in red (`player:downHpChanged`, also polled from `ctx.player.downHp`), the label
 * reads `전투불능 — 아군의 구조 대기 중` with `Space 길게: 포기` under it, and `player:reviveProgress` shows
 * `부활 중 <byName> … n%` + a progress bar (hidden on `t = -1`). 실드 줄은 그동안 접힌다. **Phase 9:** the Space
 * give-up hold shows a red `포기` caption (`.giveup`, `player:giveUpProgress {t}`); 2026-09-08 the progress itself is
 * drawn by `hud/HoldGauge` at the crosshair — this is only the label.
 */
export class Vitals {
  readonly root: HTMLElement;
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

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'vitals', parent });
    this.nameEl = el('div', { cls: 'vt-name', text: '', parent: this.root });
    this.shBar = this.makeBar('sh-bar', 'sh-seg', 0);
    this.hpBar = this.makeBar('hp-bar', 'seg', cellsFor(PLAYER_MAX_HP));
    this.shBar.root.hidden = true;

    // 2026-09-10: `.hp-num` / `.hp-max` 숫자와 `생명력` 라벨은 사라졌다. 라벨 요소는 전투불능 문구 전용으로 남는다
    // (`styles/raidHud.css` 가 평상시에는 `display:none`).
    this.labelEl = el('div', { cls: 'ui-label', text: '', parent: this.root });
    this.downSub = el('div', { cls: 'down-sub', text: 'Space 길게: 포기', parent: this.root });
    this.reviveEl = el('div', { cls: 'revive', parent: this.root });
    this.reviveTxt = el('div', { cls: 'txt', text: '', parent: this.reviveEl });
    const reviveBar = el('div', { cls: 'bar', parent: this.reviveEl });
    this.reviveFill = el('div', { cls: 'fill', parent: reviveBar });
    this.giveUpEl = el('div', { cls: 'giveup', parent: this.root });
    el('div', { cls: 'txt', text: '포기', parent: this.giveUpEl });

    // Stamina: bottom-centre bar (its own HUD element, not part of the vitals block); hidden while full.
    this.stamRoot = el('div', { cls: 'stamina full', parent });
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
    // 실드는 방탄복 등급마다 칸 수가 달라도 **체력과 같은 눈금**이어야 하므로, 칸 폭의 기준은 최소 5칸이다.
    bar.root.style.setProperty('--sh-cells', String(Math.max(cellsFor(PLAYER_MAX_HP), cells)));
  }

  bind(ctx: GameContext): void {
    this.unsubs.push(
      ctx.bus.on('player:healthChanged', ({ hp, maxHp, delta }) => {
        this.hp = hp; this.maxHp = maxHp;
        if (delta < 0) this.ghostDelay = 0.55;
        else this.ghost = Math.max(this.ghost, hp);
      }),
      // 실드 (2026-09-10): player/ 가 소유하고 이 이벤트로 알린다. `update` 의 폴링과 같은 값이지만 즉시 반영된다.
      ctx.bus.on('player:shieldChanged', ({ shield, maxShield, rarity }) => {
        this.shield = shield; this.maxShield = maxShield; this.shieldRarity = rarity;
      }),
      ctx.bus.on('player:spawned', () => {
        this.setDowned(false);
        this.hp = this.shown = this.ghost = ctx.player?.hp ?? PLAYER_MAX_HP;
        this.shieldShown = this.shield = ctx.player?.shield ?? 0;
      }),
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
    this.updateName(ctx);
  }

  update(dt: number, ctx: GameContext): void {
    if (ctx.player) {
      this.hp = ctx.player.hp; this.maxHp = ctx.player.maxHp;
      // 실드 계약은 player/ 소유다 — 아직 게시하지 않은 빌드에서도 죽지 않도록 `?? 0` 로 읽는다.
      this.shield = ctx.player.shield ?? 0;
      this.maxShield = ctx.player.maxShield ?? 0;
      this.shieldRarity = ctx.player.shieldRarity ?? null;
      // Poll the live pool while the player really is downed; otherwise trust `player:downHpChanged`.
      if (this.downed && ctx.player.isDowned && typeof ctx.player.downHp === 'number') this.downHp = ctx.player.downHp;
    }
    this.updateName(ctx);
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

  /** 실드 칸: 방탄복이 없거나 전투불능이면 줄 자체가 접힌다. */
  private updateShield(dt: number): void {
    const on = !this.downed && this.maxShield > 0;
    const target = on ? Math.min(this.shield, this.maxShield) : 0;
    this.shieldShown = Math.abs(target - this.shieldShown) < 0.05 ? target : damp(this.shieldShown, target, 16, dt);
    const cells = on ? cellsFor(this.maxShield) : 0;
    const key = `${on ? 1 : 0}|${cells}|${this.shieldShown.toFixed(1)}|${this.shieldRarity ?? '-'}`;
    if (key === this.lastShieldKey) return;
    this.lastShieldKey = key;
    if (this.shBar.root.hidden === on) this.shBar.root.hidden = !on;
    if (!on) return;
    this.setCells(this.shBar, 'sh-seg', cells);
    const rc = rarityColor(this.shieldRarity ?? 'common');
    if (this.shBar.root.style.getPropertyValue('--shc') !== rc) this.shBar.root.style.setProperty('--shc', rc);
    const per = this.maxShield / Math.max(1, cells);
    for (let i = 0; i < cells; i++) {
      const f = Math.min(1, Math.max(0, (this.shieldShown - i * per) / per));
      this.shBar.fills[i].style.transform = `scaleX(${f.toFixed(3)})`;
    }
  }

  /** 이름: 로비 이름 = 캐릭터 이름. 릴레이가 없는 싱글 플레이에서는 프로필에서 직접 읽는다. */
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
  /** 실드 칸 수 (0 = 방탄복 없음, debug). */
  get shieldSegments(): number { return this.shBar.root.hidden ? 0 : this.shBar.cells; }
  /** 표시 중인 플레이어 이름 (debug). */
  get displayName(): string { return this.lastName; }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); this.stamRoot.remove(); }
}
