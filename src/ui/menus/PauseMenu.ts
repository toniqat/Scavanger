import type { GameContext } from '@/shared';
import { el, setText } from '../dom';
import { MenuBase } from './MenuBase';

/**
 * Escape menu: resume / return to the ship. Driven by `game:paused`.
 * `함선으로 귀환` emits `hub:enter {ship}` (shared ship while in a lobby, else personal); the hub aborts the mission.
 * Multiplayer: the simulation keeps running (`freeze:false`), so the subtitle says so.
 */
export class PauseMenu extends MenuBase {
  private subtitle: HTMLElement;
  private mpNote: HTMLElement;

  constructor(parent: HTMLElement) {
    super(parent, 'pause');
    const head = el('div', { parent: this.frame });
    el('div', { cls: 'title', text: '일시 정지', parent: head });
    this.subtitle = el('div', { cls: 'subtitle', text: '임무 진행이 정지되었습니다', parent: head });
    this.mpNote = el('div', { cls: 'mp-note', text: '멀티플레이: 일시 정지 중에도 임무는 계속 진행됩니다', parent: this.frame });
    this.mpNote.hidden = true;
    const actions = el('div', { cls: 'actions', parent: this.frame });
    this.button(actions, '계속', () => this.ctx.bus.emit('game:paused', { paused: false }), 'primary');
    this.button(actions, '함선으로 귀환', () => this.ctx.bus.emit('hub:enter', { ship: this.ctx.net?.lobby ? 'shared' : 'personal' }), 'danger');
    el('div', { cls: 'hint', text: 'Esc — 계속 · 귀환 시 임무를 포기합니다', parent: this.frame });
  }

  override bind(ctx: GameContext): void {
    super.bind(ctx);
    this.unsubs.push(
      ctx.bus.on('game:paused', ({ paused, freeze }) => {
        if (!paused) { this.hide(); return; }
        const mp = ctx.isMultiplayer || freeze === false;
        this.mpNote.hidden = !mp;
        setText(this.subtitle, mp ? '분대 임무 — 시뮬레이션은 계속됩니다' : '임무 진행이 정지되었습니다');
        this.show();
      }),
      ctx.bus.on('game:phaseChanged', () => this.hide()),
    );
  }
}
