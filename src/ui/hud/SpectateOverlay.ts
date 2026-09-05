import type { GameContext } from '@/shared';
import { Keys, PLAYER_RESPAWN_DELAY } from '@/shared';
import { el, setText, setVisible, toggleClass } from '../dom';

const REFRESH = 0.25;

/**
 * Multiplayer death banner: shown on `player:died` while `ctx.isMultiplayer` ('전사 — 분대원이 임무를 계속합니다'
 * + live '남은 분대원 n'). Never blocks input (no `uiBlockers` token, pointer-events none). Hidden when the
 * phase leaves gameplay, on respawn (`player:spawned`), abort or a new mission. Lives in the HUD layer, which stays up
 * for a dead local player in multiplayer (`HudSystem` adds `.spectating` to the HUD root).
 * **Respawn** (Phase 2): `game:respawnAvailable {seconds}` drives a `.respawn` line — `부활 가능까지 n초`, then
 * `Space: 부활` (`.ready`) at 0; while shown and ready, `update` polls `ctx.input.wasPressed(Keys.RESPAWN)` and emits
 * the `game:respawn` command.
 */
export class SpectateOverlay {
  readonly root: HTMLElement;
  private count: HTMLElement;
  private respawn: HTMLElement;
  private shown = false;
  private acc = 0;
  private seconds = PLAYER_RESPAWN_DELAY;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'spectate hidden', parent });
    const inner = el('div', { cls: 'inner', parent: this.root });
    el('div', { cls: 'ui-label', text: '관전 중', parent: inner });
    el('div', { cls: 'main', text: '전사 — 분대원이 임무를 계속합니다', parent: inner });
    this.count = el('div', { cls: 'count', text: '', parent: inner });
    this.respawn = el('div', { cls: 'respawn', text: '', parent: inner });
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('player:died', () => {
        this.seconds = PLAYER_RESPAWN_DELAY;
        this.applyRespawn();
        if (ctx.isMultiplayer) this.set(true, ctx);
      }),
      b.on('game:respawnAvailable', ({ seconds }) => { this.seconds = seconds; this.applyRespawn(); }),
      b.on('player:spawned', () => this.set(false, ctx)),
      b.on('game:phaseChanged', () => { if (!ctx.isGameplayPhase()) this.set(false, ctx); }),
      b.on('game:abort', () => this.set(false, ctx)),
      b.on('game:newMission', () => this.set(false, ctx)),
    );
  }

  update(dt: number, ctx: GameContext): void {
    if (!this.shown) return;
    if (this.seconds <= 0 && ctx.uiBlockers.size === 0 && ctx.input.wasPressed(Keys.RESPAWN)) {
      ctx.bus.emit('game:respawn', {});
    }
    this.acc += dt;
    if (this.acc < REFRESH) return;
    this.acc = 0;
    this.refreshCount(ctx);
  }

  private set(on: boolean, ctx: GameContext): void {
    if (on === this.shown) return;
    this.shown = on;
    setVisible(this.root, on);
    if (on) { this.acc = 0; this.refreshCount(ctx); this.applyRespawn(); }
  }

  private applyRespawn(): void {
    const s = Math.max(0, Math.ceil(this.seconds));
    setText(this.respawn, s > 0 ? `부활 가능까지 ${s}초` : 'Space: 부활');
    toggleClass(this.respawn, 'ready', s <= 0);
  }

  private refreshCount(ctx: GameContext): void {
    let n = 0;
    for (const r of ctx.net?.getRemotePlayers() ?? []) if (r.connected && !r.isDead) n++;
    setText(this.count, n > 0 ? `남은 분대원 ${n}` : '분대 전원 전사 — 부활 대기 중');
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
