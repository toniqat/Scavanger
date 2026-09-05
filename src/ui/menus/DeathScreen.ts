import type { GameContext, MissionStats } from '@/shared';
import { el, fmtTime, fmtInt, setText } from '../dom';
import { MenuBase } from './MenuBase';

/**
 * "전사" screen with mission stats. `함선으로 귀환` (primary) → `hub:enter {ship}` (shared while in a lobby);
 * `다시 배치` (same seed) only in single-player.
 */
export class DeathScreen extends MenuBase {
  private vals: Record<string, HTMLElement> = {};
  private seed = 0;
  private redeployBtn: HTMLButtonElement;

  constructor(parent: HTMLElement) {
    super(parent, 'death');
    const head = el('div', { parent: this.frame });
    el('div', { cls: 'title danger', text: '전사', parent: head });
    el('div', { cls: 'subtitle', text: '스캐빈저 신호 소실 — 회수 실패', parent: head });

    const stats = el('div', { cls: 'stats', parent: this.frame });
    for (const [k, label] of [['kills', '처치'], ['time', '생존 시간'], ['crates', '개봉한 상자'], ['damage', '받은 피해']] as const) {
      const s = el('div', { cls: 'stat', parent: stats });
      el('span', { cls: 'ui-label', text: label, parent: s });
      this.vals[k] = el('span', { cls: 'v', text: '0', parent: s });
    }
    const lost = el('div', { cls: 'stat wide', parent: stats });
    el('span', { cls: 'ui-label', text: '소실된 전리품 가치', parent: lost });
    this.vals.loot = el('span', { cls: 'v', text: '0', parent: lost });
    this.vals.loot.style.color = 'var(--c-danger)';

    const actions = el('div', { cls: 'actions', parent: this.frame });
    this.button(actions, '함선으로 귀환', () => this.ctx.bus.emit('hub:enter', { ship: this.ctx.net?.lobby ? 'shared' : 'personal' }), 'primary');
    this.redeployBtn = this.button(actions, '다시 배치 (같은 시드)', () => this.ctx.bus.emit('game:newMission', { seed: this.seed }));
  }

  override bind(ctx: GameContext): void {
    super.bind(ctx);
    this.unsubs.push(
      ctx.bus.on('game:over', ({ stats }) => { this.fill(stats); this.show(); }),
      ctx.bus.on('game:phaseChanged', ({ phase }) => { if (phase !== 'dead') this.hide(); }),
    );
  }

  private fill(s: MissionStats): void {
    this.seed = s.seed;
    // Multiplayer: the seed is the host's call at the ship terminal → return to the ship only.
    this.redeployBtn.hidden = !!this.ctx.net?.lobby;
    setText(this.vals.kills, String(s.kills));
    setText(this.vals.time, fmtTime(s.timeSeconds));
    setText(this.vals.crates, String(s.cratesOpened));
    setText(this.vals.damage, fmtInt(s.damageTaken));
    setText(this.vals.loot, fmtInt(this.ctx.inventory?.getTotalValue() ?? s.lootValue));
  }
}
