import type { GameContext, MissionStats } from '@/shared';
import { formatCredits } from '@/shared';
import { el, fmtTime, fmtInt, setText } from '../dom';
import { MenuBase } from './MenuBase';
import { RewardsBlock } from './RewardsBlock';

/**
 * Extraction summary: loot value counts up, kills / crates / time. `함선으로 귀환` (primary) → `hub:enter {ship}`
 * (shared while in a lobby); `다시 배치` (same seed) only in single-player.
 * Phase 5: a `RewardsBlock` (XP count-up, level, XP bar, contract line) between the stats and the actions, shown only
 * when `stats.rewards` is present.
 */
export class MissionComplete extends MenuBase {
  private vals: Record<string, HTMLElement> = {};
  private seed = 0;
  private lootTarget = 0;
  private lootShown = 0;
  private countTimer = 0;
  private counting = false;
  private lastLootText = '';
  private redeployBtn: HTMLButtonElement;
  private rewards: RewardsBlock;

  constructor(parent: HTMLElement) {
    super(parent, 'complete');
    const head = el('div', { cls: 'banner', parent: this.frame });
    el('span', { cls: 'ui-label', text: '임무 보고', parent: head });
    el('div', { cls: 'title success', text: '탈출 성공', parent: head });
    el('div', { cls: 'subtitle', text: '스캐빈저 회수 완료 — 전리품 확보', parent: head });

    const stats = el('div', { cls: 'stats', parent: this.frame });
    const loot = el('div', { cls: 'stat wide', parent: stats });
    el('span', { cls: 'ui-label', text: '전리품 가치', parent: loot });
    this.vals.loot = el('span', { cls: 'v accent', text: formatCredits(0), parent: loot });
    for (const [k, label] of [['kills', '처치'], ['time', '임무 시간'], ['crates', '개봉한 상자'], ['damage', '받은 피해']] as const) {
      const s = el('div', { cls: 'stat', parent: stats });
      el('span', { cls: 'ui-label', text: label, parent: s });
      this.vals[k] = el('span', { cls: 'v', text: '0', parent: s });
    }

    this.rewards = new RewardsBlock(this.frame);

    const actions = el('div', { cls: 'actions', parent: this.frame });
    this.button(actions, '함선으로 귀환', () => this.ctx.bus.emit('hub:enter', { ship: this.ctx.net?.lobby ? 'shared' : 'personal' }), 'primary');
    this.redeployBtn = this.button(actions, '다시 배치 (같은 시드)', () => this.ctx.bus.emit('game:newMission', { seed: this.seed }));
  }

  override bind(ctx: GameContext): void {
    super.bind(ctx);
    this.rewards.bind(ctx);
    this.unsubs.push(
      ctx.bus.on('game:complete', ({ stats }) => { this.fill(stats); this.show(); }),
      ctx.bus.on('game:phaseChanged', ({ phase }) => { if (phase !== 'complete') this.hide(); }),
    );
  }

  private fill(s: MissionStats): void {
    this.seed = s.seed;
    this.redeployBtn.hidden = !!this.ctx.net?.lobby;
    setText(this.vals.kills, String(s.kills));
    setText(this.vals.time, fmtTime(s.timeSeconds));
    setText(this.vals.crates, String(s.cratesOpened));
    setText(this.vals.damage, fmtInt(s.damageTaken));
    this.lootTarget = s.lootValue;
    this.lootShown = 0;
    this.countTimer = 0;
    this.counting = true;
    setText(this.vals.loot, formatCredits(0));
    this.rewards.fill(s.rewards, 'complete');
  }

  protected override onHide(): void { this.rewards.stop(); }

  /** The XP settlement block (debug). */
  get rewardsBlock(): RewardsBlock { return this.rewards; }

  update(dt: number): void {
    if (!this.visible) return;
    this.rewards.update(dt);
    if (!this.counting) return;
    this.countTimer += dt;
    const dur = 1.6;
    const t = Math.min(1, (this.countTimer - 0.4) / dur);
    if (t < 0) return;
    const eased = 1 - Math.pow(1 - t, 3);
    this.lootShown = this.lootTarget * eased;
    const txt = formatCredits(this.lootShown);
    if (txt !== this.lastLootText) { this.lastLootText = txt; setText(this.vals.loot, txt); }
    if (t >= 1) {
      this.counting = false;
      this.ctx.bus.emit('audio:play', { id: 'ui_equip' });
    }
  }
}
