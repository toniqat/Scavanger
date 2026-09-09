import type { GameContext } from '@/shared';
import { el, setText, setVisible, toggleClass } from '../dom';

const REFRESH = 0.25;

/**
 * Multiplayer death banner: shown on `player:died` while `ctx.isMultiplayer` ('전사 — 분대원이 임무를 계속합니다'
 * + live '남은 분대원 n'). Never blocks input (no `uiBlockers` token, pointer-events none). Hidden when the
 * phase leaves gameplay, on respawn (`player:spawned`), abort or a new mission. Lives in the HUD layer, which stays up
 * for a dead local player in multiplayer (`HudSystem` adds `.spectating` to the HUD root).
 *
 * **2026-09-09 — 자동 부활이 사라졌다.** `부활 (n초)` 줄도 Space 도 없다. 그 자리에는
 * `분대원의 구조선을 기다립니다` 와 분대 공용 **남은 구조선 횟수**(`ctx.stratagems.rescueLeft`)가 뜬다.
 * 횟수가 0 이면 `.none` 이 붙어 붉게 읽힌다. 솔로 레이드는 죽는 즉시 레이드 실패라 이 화면이 뜨지 않는다.
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
      // 구조선 횟수가 바뀌면 (누가 불렀다) 즉시 반영한다 — 0.25 s 주기를 기다리지 않는다
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

  /** 분대 공용 구조선 잔여 횟수 (`stratagems` 가 없으면 0 으로 읽힌다). */
  private applyRescue(ctx: GameContext): void {
    const left = ctx.stratagems?.rescueLeft ?? 0;
    setText(this.rescue, left > 0 ? `남은 구조선 ${left}` : '남은 구조선 없음');
    toggleClass(this.rescue, 'none', left <= 0);
  }

  private refreshCount(ctx: GameContext): void {
    let n = 0;
    for (const r of ctx.net?.getRemotePlayers() ?? []) if (r.connected && !r.isDead) n++;
    setText(this.count, n > 0 ? `남은 분대원 ${n}` : '분대 전원 전사');
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
