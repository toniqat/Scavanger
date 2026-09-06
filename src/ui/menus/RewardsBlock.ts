import type { GameContext, MissionRewards } from '@/shared';
import { el, fmtInt, setText } from '../dom';

const COUNT_DELAY = 0.35;   // seconds before the XP count-up starts (after the frame's entry animation)
const COUNT_DUR = 1.1;      // seconds of count-up

/**
 * XP settlement block shared by the two result screens (Phase 5): `획득 XP +n` counting up, `Lv. a → b` (level-up
 * highlight + `audio:play level_up` when the count reaches it), an XP bar `xp / xpToNext` filling from the pre-mission
 * fraction, and the contract line — `계약 · <name> 성공 · 신뢰도 +rep · 크레딧 +credits`, in progress
 * `계약 · <name> p / t · 계속`, or on death `계약 · <name> p / t · 진척 유지 안 됨`. `fill(undefined)` hides the block
 * (older emitters / no progression). The owning menu calls `update(dt)` while visible.
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

  /** `mode` picks the wording of an unfinished contract: `complete` = 계속, `dead` = 진척 유지 안 됨. */
  fill(rewards: MissionRewards | undefined, mode: 'complete' | 'dead'): void {
    this.rewards = rewards ?? null;
    this.root.hidden = !rewards;
    this.counting = false;
    if (!rewards) return;
    const need = Math.max(1, rewards.xpToNext);
    this.levelUp = rewards.levelAfter > rewards.levelBefore;
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
      let text: string;
      if (c.success) {
        text = `계약 · ${c.name} 성공 · 신뢰도 +${fmtInt(c.rep)} · 크레딧 +${fmtInt(c.credits)}`;
        this.contractEl.classList.add('success');
      } else if (mode === 'dead') {
        text = `계약 · ${c.name} ${fmtInt(c.progress)} / ${fmtInt(c.target)} · 진척 유지 안 됨`;
        this.contractEl.classList.add('lost');
      } else {
        text = `계약 · ${c.name} ${fmtInt(c.progress)} / ${fmtInt(c.target)} · 계속`;
        this.contractEl.classList.add('keep');
      }
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
    if (this.levelUp) fill = eased < 0.6 ? (eased / 0.6) : this.fillTo * ((eased - 0.6) / 0.4);
    else fill = this.fillFrom + (this.fillTo - this.fillFrom) * eased;
    this.fillEl.style.transform = `scaleX(${fill.toFixed(4)})`;
    if (t >= 1) {
      this.counting = false;
      if (this.levelUp) {
        this.root.classList.add('up');
        this.upEl.hidden = false;
        this.ctx?.bus.emit('audio:play', { id: 'level_up', volume: 0.8 });
      }
    }
  }

  /** Whether the XP count-up is still running (debug). */
  get isCounting(): boolean { return this.counting; }
  /** Whether the block shows a level-up highlight (debug). */
  get isLevelUp(): boolean { return this.root.classList.contains('up'); }

  /** Stop the animation without touching the DOM (menu hidden). */
  stop(): void { this.counting = false; }

  dispose(): void { this.root.remove(); }
}

