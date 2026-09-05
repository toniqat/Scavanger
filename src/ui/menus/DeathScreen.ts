import type { GameContext, MissionStats } from '@/shared';
import { Keys, PLAYER_RESPAWN_DELAY } from '@/shared';
import { el, fmtTime, fmtInt, setText, toggleClass } from '../dom';
import { MenuBase } from './MenuBase';

/**
 * "전사" screen with mission stats, shown on `game:phaseChanged {phase:'dead'}` (solo; also on the legacy `game:over`).
 * Primary button `부활 (n초)` is disabled until `game:respawnAvailable.seconds === 0`, then `부활` → emits the
 * `game:respawn` command and hides (Space works too while enabled). `함선으로 귀환` → `hub:enter {ship}`.
 * Hidden whenever the phase leaves `dead`.
 */
export class DeathScreen extends MenuBase {
  private vals: Record<string, HTMLElement> = {};
  private respawnBtn: HTMLButtonElement;
  private seconds = PLAYER_RESPAWN_DELAY;
  private onKey = (e: KeyboardEvent): void => {
    if (!this.visible || e.code !== Keys.RESPAWN || e.repeat) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.respawn();
  };

  constructor(parent: HTMLElement) {
    super(parent, 'death');
    const head = el('div', { parent: this.frame });
    el('div', { cls: 'title danger', text: '전사', parent: head });
    el('div', { cls: 'subtitle', text: '스캐빈저 신호 소실 — 재강하 대기 중', parent: head });

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
    this.respawnBtn = this.button(actions, '부활', () => this.respawn(), 'primary respawn');
    this.button(actions, '함선으로 귀환', () => this.ctx.bus.emit('hub:enter', { ship: this.ctx.net?.lobby ? 'shared' : 'personal' }));
    this.applyRespawn();
  }

  override bind(ctx: GameContext): void {
    super.bind(ctx);
    this.unsubs.push(
      ctx.bus.on('player:died', () => { this.seconds = PLAYER_RESPAWN_DELAY; this.applyRespawn(); }),
      ctx.bus.on('game:respawnAvailable', ({ seconds }) => { this.seconds = seconds; this.applyRespawn(); }),
      ctx.bus.on('game:over', ({ stats }) => { this.fill(stats); this.show(); }),
      ctx.bus.on('game:phaseChanged', ({ phase }) => {
        if (phase === 'dead') { this.fill(ctx.stats); this.show(); } else this.hide();
      }),
    );
    window.addEventListener('keydown', this.onKey, true);
  }

  protected override onShow(): void { this.applyRespawn(); }

  private respawn(): void {
    if (this.seconds > 0 || !this.visible) return;
    this.ctx.bus.emit('game:respawn', {});
    this.hide();
  }

  private applyRespawn(): void {
    const s = Math.max(0, Math.ceil(this.seconds));
    setText(this.respawnBtn, s > 0 ? `부활 (${s}초)` : '부활');
    this.respawnBtn.disabled = s > 0;
    toggleClass(this.respawnBtn, 'waiting', s > 0);
  }

  private fill(s: MissionStats): void {
    setText(this.vals.kills, String(s.kills));
    setText(this.vals.time, fmtTime(s.timeSeconds));
    setText(this.vals.crates, String(s.cratesOpened));
    setText(this.vals.damage, fmtInt(s.damageTaken));
    setText(this.vals.loot, fmtInt(this.ctx.inventory?.getTotalValue() ?? s.lootValue));
  }

  override dispose(): void {
    window.removeEventListener('keydown', this.onKey, true);
    super.dispose();
  }
}
