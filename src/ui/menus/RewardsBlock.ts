import type { ContractSettlement, GameContext, MissionRewards } from '@/shared';
import { formatCredits } from '@/shared';
import { el, fmtInt, setText } from '../dom';

const COUNT_DELAY = 0.35;   // seconds before the XP count-up starts (after the frame's entry animation)
const COUNT_DUR = 1.1;      // seconds of count-up
/** Eased count-up fraction at which a level-up run reaches the old level's cap (the bar is full → the moment). */
const LEVEL_CROSS = 0.6;
const BURST_MS = 900;       // light-burst element lifetime

type Outcome = NonNullable<ContractSettlement['outcome']>;

/** Contract wording shared by the result screens and `MetaToasts` (Phase 7: keyed on `settlement.outcome` only). */
export const CONTRACT_OUTCOME_TEXT: Record<Outcome, string> = {
  success: '계약 성공',
  incomplete: '계약 미완 · 계속',
  failed: '계약 실패 · 진척 유지 안 됨',
};
/** CSS class per outcome (`.success` / `.keep` / `.lost` on the result line, `.success` / `.keep` / `.fail` on toasts). */
export const CONTRACT_OUTCOME_CLASS: Record<Outcome, string> = { success: 'success', incomplete: 'keep', failed: 'lost' };

/**
 * `outcome` of a settlement, tolerating producers from before Phase 7 (`success` → success, otherwise `fallback`).
 * Never derives anything from `ctx.stats.extracted`.
 */
export function contractOutcome(c: Pick<ContractSettlement, 'success' | 'outcome'>, fallback: Outcome = 'incomplete'): Outcome {
  return c.outcome ?? (c.success ? 'success' : fallback);
}

/**
 * XP settlement block shared by the two result screens (Phase 5): `획득 XP +n` counting up, `Lv. a → b`, an XP bar
 * `xp / xpToNext` filling from the pre-mission fraction, and the contract line keyed on `settlement.outcome` —
 * `계약 성공 · <name> · 신뢰도 +rep · 크레딧 +credits C`, `계약 미완 · 계속 · <name> p / t`, or
 * `계약 실패 · 진척 유지 안 됨 · <name> p / t`. `fill(undefined)` hides the block (older emitters / no progression).
 *
 * **Level-up moment** (Phase 7): the block owns the whole level-up presentation. The instant the count-up crosses the
 * level boundary (the bar hits the old cap) it shows the `레벨 업` badge, spawns a `.up-burst` light burst and emits
 * `audio:play {id:'level_up'}` — the only place that chime is played (audio/ dropped its `progress:levelUp` hook and
 * `ProgressToasts` no longer toasts level-ups). The owning menu calls `update(dt)` while visible.
 */
export class RewardsBlock {
  readonly root: HTMLElement;
  private gainEl: HTMLElement;
  private lvEl: HTMLElement;
  private upEl: HTMLElement;
  private fillEl: HTMLElement;
  private numEl: HTMLElement;
  private contractEl: HTMLElement;
  private ctx: GameContext | null = null;

  private rewards: MissionRewards | null = null;
  private timer = 0;
  private counting = false;
  private lastGain = '';
  private fillFrom = 0;
  private fillTo = 0;
  private levelUp = false;
  private crossed = false;
  private burst: HTMLElement | null = null;
  private burstTimer: number | null = null;

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'rewards', parent });
    this.root.hidden = true;
    const row = el('div', { cls: 'xp-row', parent: this.root });
    el('span', { cls: 'ui-label', text: '획득 XP', parent: row });
    this.gainEl = el('span', { cls: 'xp-gain', text: '+0', parent: row });
    this.lvEl = el('span', { cls: 'lv', text: '', parent: row });
    this.upEl = el('span', { cls: 'up-badge', text: '레벨 업', parent: row });
    this.upEl.hidden = true;
    const bar = el('div', { cls: 'xp-bar', parent: this.root });
    this.fillEl = el('div', { cls: 'fill', parent: bar });
    this.numEl = el('div', { cls: 'xp-num', text: '', parent: this.root });
    this.contractEl = el('div', { cls: 'contract-line', text: '', parent: this.root });
  }

  bind(ctx: GameContext): void { this.ctx = ctx; }

  /**
   * `mode` is only the fallback for settlements without `outcome` (pre-Phase 7 producers): `complete` = 미완 · 계속,
   * `dead` = 실패 · 진척 유지 안 됨. With `outcome` present the wording comes from it alone.
   */
  fill(rewards: MissionRewards | undefined, mode: 'complete' | 'dead'): void {
    this.rewards = rewards ?? null;
    this.root.hidden = !rewards;
    this.counting = false;
    this.removeBurst();
    if (!rewards) return;
    const need = Math.max(1, rewards.xpToNext);
    this.levelUp = rewards.levelAfter > rewards.levelBefore;
    this.crossed = false;
    this.fillTo = Math.min(1, Math.max(0, rewards.xp / need));
    // Bar starts where the level stood before the mission (0 after a level-up: a fresh level).
    this.fillFrom = this.levelUp ? 0 : Math.min(this.fillTo, Math.max(0, (rewards.xp - rewards.xpEarned) / need));
    this.fillEl.style.transform = `scaleX(${this.fillFrom.toFixed(4)})`;
    this.root.classList.remove('up');
    this.upEl.hidden = true;
    setText(this.lvEl, this.levelUp ? `Lv. ${rewards.levelBefore} → ${rewards.levelAfter}` : `Lv. ${rewards.levelAfter}`);
    setText(this.numEl, `${fmtInt(rewards.xp)} / ${fmtInt(rewards.xpToNext)} XP`);
    this.lastGain = '+0';
    setText(this.gainEl, '+0');
    this.timer = 0;
    this.counting = true;

    const c = rewards.contract;
    this.contractEl.hidden = !c;
    this.contractEl.classList.remove('success', 'keep', 'lost');
    if (c) {
      const outcome = contractOutcome(c, mode === 'dead' ? 'failed' : 'incomplete');
      const head = CONTRACT_OUTCOME_TEXT[outcome];
      const text = outcome === 'success'
        ? `${head} · ${c.name} · 신뢰도 +${fmtInt(c.rep)} · 크레딧 ${formatCredits(c.credits, { sign: true })}`
        : `${head} · ${c.name} ${fmtInt(c.progress)} / ${fmtInt(c.target)}`;
      this.contractEl.classList.add(CONTRACT_OUTCOME_CLASS[outcome]);
      setText(this.contractEl, text);
    }
  }

  /** Count-up + bar fill; call every frame while the owning menu is visible. */
  update(dt: number): void {
    if (!this.counting || !this.rewards) return;
    this.timer += dt;
    const t = Math.min(1, (this.timer - COUNT_DELAY) / COUNT_DUR);
    if (t < 0) return;
    const eased = 1 - Math.pow(1 - t, 3);
    const gain = `+${fmtInt(this.rewards.xpEarned * eased)}`;
    if (gain !== this.lastGain) { this.lastGain = gain; setText(this.gainEl, gain); }
    // With a level-up the bar runs to full first, then refills to the new fraction.
    let fill: number;
    if (this.levelUp) fill = eased < LEVEL_CROSS ? (eased / LEVEL_CROSS) : this.fillTo * ((eased - LEVEL_CROSS) / (1 - LEVEL_CROSS));
    else fill = this.fillFrom + (this.fillTo - this.fillFrom) * eased;
    this.fillEl.style.transform = `scaleX(${fill.toFixed(4)})`;
    if (this.levelUp && !this.crossed && eased >= LEVEL_CROSS) this.cross();
    if (t >= 1) {
      this.counting = false;
      if (this.levelUp && !this.crossed) this.cross();
    }
  }

  /** The level-boundary moment: badge, light burst, the single `level_up` chime. */
  private cross(): void {
    this.crossed = true;
    this.root.classList.add('up');
    this.upEl.hidden = false;
    // restart the badge's entry animation even if the element was shown before
    this.upEl.style.animation = 'none';
    void this.upEl.offsetWidth;
    this.upEl.style.animation = '';
    this.removeBurst();
    this.burst = el('div', { cls: 'up-burst', parent: this.root });
    this.burstTimer = window.setTimeout(() => this.removeBurst(), BURST_MS);
    this.ctx?.bus.emit('audio:play', { id: 'level_up', volume: 0.8 });
  }

  private removeBurst(): void {
    if (this.burstTimer !== null) { window.clearTimeout(this.burstTimer); this.burstTimer = null; }
    if (this.burst) { this.burst.remove(); this.burst = null; }
  }

  /** Whether the XP count-up is still running (debug). */
  get isCounting(): boolean { return this.counting; }
  /** Whether the block shows a level-up highlight (debug). */
  get isLevelUp(): boolean { return this.root.classList.contains('up'); }
  /** Whether the light burst element is currently attached (debug). */
  get isBursting(): boolean { return this.burst !== null; }

  /** Stop the animation without touching the DOM (menu hidden). */
  stop(): void { this.counting = false; }

  dispose(): void { this.removeBurst(); this.root.remove(); }
}
