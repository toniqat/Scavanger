import type { GameContext, MissionStats } from '@/shared';
import { el, fmtTime, fmtInt, setText } from '../dom';
import { MenuBase } from './MenuBase';

/** "전사" screen with mission stats, redeploy / menu buttons. */
export class DeathScreen extends MenuBase {
  private vals: Record<string, HTMLElement> = {};
  private seed = 0;
  private redeployBtn: HTMLButtonElement;
  private lobbyBtn: HTMLButtonElement;
  private menuBtn: HTMLButtonElement;

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
    this.redeployBtn = this.button(actions, '다시 배치', () => this.ctx.bus.emit('game:newMission', { seed: this.seed }), 'primary');
    this.lobbyBtn = this.button(actions, '로비로', () => this.ctx.bus.emit('game:abort', {}), 'primary');
    this.menuBtn = this.button(actions, '메뉴로', () => this.ctx.bus.emit('game:abort', {}));
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
    // Multiplayer: the seed is the host's call → only '로비로' (abort → phase 'menu' → LobbyMenu shows).
    const inLobby = !!this.ctx.net?.lobby;
    this.redeployBtn.hidden = inLobby;
    this.menuBtn.hidden = inLobby;
    this.lobbyBtn.hidden = !inLobby;
    setText(this.vals.kills, String(s.kills));
    setText(this.vals.time, fmtTime(s.timeSeconds));
    setText(this.vals.crates, String(s.cratesOpened));
    setText(this.vals.damage, fmtInt(s.damageTaken));
    setText(this.vals.loot, fmtInt(this.ctx.inventory?.getTotalValue() ?? s.lootValue));
  }
}
