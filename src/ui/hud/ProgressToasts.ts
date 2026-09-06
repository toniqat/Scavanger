import type { GameContext, SkillId } from '@/shared';
import { el, setText, fmtInt } from '../dom';

const SKILL_TOAST_TTL = 2.6;   // seconds a skill-up toast stays
const MAX_TOASTS = 4;
const XP_FLUSH = 1.2;          // seconds of XP gains coalesced into one chip

/**
 * Level-up / skill-up feedback (top-center, above the compass area but below the countdown).
 * Lives in the social HUD layer so it also shows in the ship after a mission is scored.
 *
 * `progress:skillUp` → a compact toast per skill (name resolved via `ctx.progression.getSkillDef`).
 * `progress:levelUp` is deliberately NOT toasted (Phase 7): the result screen's `RewardsBlock` plays the level-up
 * moment (badge + light burst + the single `level_up` chime) when its count-up crosses the boundary.
 * `progress:xpGained` → coalesced `+n XP` chip (at most one per `XP_FLUSH` seconds).
 */
export class ProgressToasts {
  readonly root: HTMLElement;
  private live: Array<{ el: HTMLElement; ttl: number }> = [];
  private xpPending = 0;
  private xpTimer = 0;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'progress-toasts', parent });
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('progress:skillUp', ({ id, level }) => {
        const name = this.skillName(ctx, id);
        const t = this.push('skill', SKILL_TOAST_TTL);
        el('span', { cls: 'k', text: '스킬 상승', parent: t });
        el('span', { cls: 'v', text: `${name} ${level}`, parent: t });
      }),
      b.on('progress:xpGained', ({ amount }) => {
        if (amount <= 0) return;
        this.xpPending += amount;
        if (this.xpTimer <= 0) this.xpTimer = XP_FLUSH;
      }),
      b.on('game:abort', () => this.clear()),
      b.on('game:newMission', () => this.clear()),
    );
  }

  private skillName(ctx: GameContext, id: SkillId): string {
    const def = ctx.progression?.getSkillDef?.(id);
    return def?.name ?? id;
  }

  private push(kind: 'skill' | 'xp', ttl: number): HTMLElement {
    const t = el('div', { cls: `ptoast ${kind}`, parent: this.root });
    this.live.push({ el: t, ttl });
    requestAnimationFrame(() => t.classList.add('in'));
    while (this.live.length > MAX_TOASTS) {
      const old = this.live.shift();
      if (old) old.el.remove();
    }
    return t;
  }

  update(dt: number): void {
    if (this.xpTimer > 0) {
      this.xpTimer -= dt;
      if (this.xpTimer <= 0 && this.xpPending > 0) {
        const t = this.push('xp', 1.6);
        setText(t, `+${fmtInt(this.xpPending)} XP`);
        this.xpPending = 0;
      }
    }
    for (let i = this.live.length - 1; i >= 0; i--) {
      const item = this.live[i];
      item.ttl -= dt;
      if (item.ttl > 0) continue;
      this.live.splice(i, 1);
      item.el.classList.remove('in');
      item.el.classList.add('out');
      const node = item.el;
      window.setTimeout(() => node.remove(), 320);
    }
  }

  private clear(): void {
    for (const t of this.live) t.el.remove();
    this.live.length = 0;
    this.xpPending = 0; this.xpTimer = 0;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.clear();
    this.root.remove();
  }
}
