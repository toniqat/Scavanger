import type { GameContext } from '@/shared';
import { isAndroidId } from '@/shared';
import { el, setText, setVisible, toggleClass } from '../dom';
/* 2026-09-15 (android squadmates): the remaining 「분대원」 counts humans only — androids get their own line */
import { allyBodies } from './allySource';

const REFRESH = 0.25;

/**
 * Multiplayer death banner: shown on `player:died` while `ctx.isMultiplayer` ('전사 — 분대원이 임무를 계속합니다'
 * + live '남은 분대원 n'). Never blocks input (no `uiBlockers` token, pointer-events none). Hidden when the
 * phase leaves gameplay, on respawn (`player:spawned`), abort or a new mission. Lives in the HUD layer, which stays up
 * for a dead local player in multiplayer (`HudSystem` adds `.spectating` to the HUD root).
 *
 * **2026-09-09 — auto-revive is gone.** There is no `부활 (n초)` row and no Space. In its place stand
 * `분대원의 구조선을 기다립니다` and the squad-shared **remaining rescue drop count** (`ctx.stratagems.rescueLeft`).
 * At a count of 0 it takes `.none` and reads red. A solo raid fails the moment you die, so this screen never appears there.
 */
export class SpectateOverlay {
  readonly root: HTMLElement;
  private count: HTMLElement;
  private rescue: HTMLElement;
  private shown = false;
  private acc = 0;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'spectate hidden', parent });
    const inner = el('div', { cls: 'inner', parent: this.root });
    el('div', { cls: 'ui-label', text: '관전 중', parent: inner });
    el('div', { cls: 'main', text: '전사 — 분대원의 구조선을 기다립니다', parent: inner });
    this.count = el('div', { cls: 'count', text: '', parent: inner });
    this.rescue = el('div', { cls: 'rescue', text: '', parent: inner });
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('player:died', () => { if (ctx.isMultiplayer) this.set(true, ctx); }),
      // A change in the rescue drop count (somebody called one) lands at once — it does not wait for the 0.25 s cycle
      b.on('rescue:countChanged', () => this.applyRescue(ctx)),
      b.on('rescue:called', () => this.applyRescue(ctx)),
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
    this.applyRescue(ctx);
  }

  private set(on: boolean, ctx: GameContext): void {
    if (on === this.shown) return;
    this.shown = on;
    setVisible(this.root, on);
    if (on) { this.acc = 0; this.refreshCount(ctx); this.applyRescue(ctx); }
  }

  /** The squad-shared remaining rescue drop count (reads 0 with no `stratagems`). */
  private applyRescue(ctx: GameContext): void {
    const left = ctx.stratagems?.rescueLeft ?? 0;
    setText(this.rescue, left > 0 ? `남은 구조선 ${left}` : '남은 구조선 없음');
    toggleClass(this.rescue, 'none', left <= 0);
  }

  /**
   * 2026-09-15 (android squadmates, user's decision 「사람이 전원 사망하면 레이드 실패」): 「남은 분대원」 counts **humans only**
   * — the raid ends even with androids still alive. Living androids are written separately after it
   * (only a human can pick someone up, but how many units are holding the enemies off must still be known).
   */
  private refreshCount(ctx: GameContext): void {
    let n = 0;
    for (const r of ctx.net?.getRemotePlayers() ?? []) if (r.connected && !r.isDead && !isAndroidId(r.id)) n++;
    let allies = 0;
    for (const b of allyBodies(ctx)) if (b.mode === 'raid' && !b.dead) allies++;
    const tail = allies > 0 ? ` <span>· 안드로이드 ${allies}</span>` : '';
    const main = n > 0 ? `남은 분대원 ${n}` : '분대 전원 전사';
    this.count.innerHTML = `${main}${tail}`;
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
