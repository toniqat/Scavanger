import type { GameContext } from '@/shared';
import { el, setText, setVisible } from '../dom';

const REFRESH = 0.25;

/**
 * Multiplayer death banner: shown on `player:died` while `ctx.isMultiplayer` ('전사 — 분대원이 임무를 계속합니다'
 * + live '남은 분대원 n'). Never blocks input (no `uiBlockers` token, pointer-events none). Hidden when the
 * phase leaves gameplay, on respawn, abort or a new mission. Lives in the HUD layer, which stays up for a dead
 * local player in multiplayer (`HudSystem` adds `.spectating` to the HUD root).
 */
export class SpectateOverlay {
  readonly root: HTMLElement;
  private count: HTMLElement;
  private shown = false;
  private acc = 0;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'spectate hidden', parent });
    const inner = el('div', { cls: 'inner', parent: this.root });
    el('div', { cls: 'ui-label', text: '관전 중', parent: inner });
    el('div', { cls: 'main', text: '전사 — 분대원이 임무를 계속합니다', parent: inner });
    this.count = el('div', { cls: 'count', text: '', parent: inner });
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('player:died', () => { if (ctx.isMultiplayer) this.set(true, ctx); }),
      b.on('player:spawned', () => this.set(false, ctx)),
      b.on('game:phaseChanged', () => { if (!ctx.isGameplayPhase()) this.set(false, ctx); }),
      b.on('game:abort', () => this.set(false, ctx)),
      b.on('game:newMission', () => this.set(false, ctx)),
    );
  }

  update(dt: number, ctx: GameContext): void {
    if (!this.shown) return;
    this.acc += dt;
    if (this.acc < REFRESH) return;
    this.acc = 0;
    this.refreshCount(ctx);
  }

  private set(on: boolean, ctx: GameContext): void {
    if (on === this.shown) return;
    this.shown = on;
    setVisible(this.root, on);
    if (on) { this.acc = 0; this.refreshCount(ctx); }
  }

  private refreshCount(ctx: GameContext): void {
    let n = 0;
    for (const r of ctx.net?.getRemotePlayers() ?? []) if (r.connected && !r.isDead) n++;
    setText(this.count, n > 0 ? `남은 분대원 ${n}` : '분대 전원 전사 — 임무 종료 대기 중');
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
