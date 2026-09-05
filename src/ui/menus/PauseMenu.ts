import type { GameContext } from '@/shared';
import { el, setText } from '../dom';
import { MenuBase } from './MenuBase';

/**
 * Escape menu: resume / abort mission. Driven by `game:paused`.
 * Multiplayer: the simulation keeps running (`freeze:false`), so the subtitle says so and the abort button
 * reads '로비로' (abort returns everyone in this client to the lobby screen).
 */
export class PauseMenu extends MenuBase {
  private subtitle: HTMLElement;
  private mpNote: HTMLElement;
  private abortBtn: HTMLButtonElement;

  constructor(parent: HTMLElement) {
    super(parent, 'pause');
    const head = el('div', { parent: this.frame });
    el('div', { cls: 'title', text: '일시 정지', parent: head });
    this.subtitle = el('div', { cls: 'subtitle', text: '임무 진행이 정지되었습니다', parent: head });
    this.mpNote = el('div', { cls: 'mp-note', text: '멀티플레이: 일시 정지 중에도 임무는 계속 진행됩니다', parent: this.frame });
    this.mpNote.hidden = true;
    const actions = el('div', { cls: 'actions', parent: this.frame });
    this.button(actions, '계속', () => this.ctx.bus.emit('game:paused', { paused: false }), 'primary');
    this.abortBtn = this.button(actions, '임무 포기', () => this.ctx.bus.emit('game:abort', {}), 'danger');
    el('div', { cls: 'hint', text: 'Esc — 계속', parent: this.frame });
  }

  override bind(ctx: GameContext): void {
    super.bind(ctx);
    this.unsubs.push(
      ctx.bus.on('game:paused', ({ paused, freeze }) => {
        if (!paused) { this.hide(); return; }
        const mp = ctx.isMultiplayer || freeze === false;
        this.mpNote.hidden = !mp;
        setText(this.subtitle, mp ? '분대 임무 — 시뮬레이션은 계속됩니다' : '임무 진행이 정지되었습니다');
        setText(this.abortBtn, ctx.net?.lobby ? '로비로' : '임무 포기');
        this.show();
      }),
      ctx.bus.on('game:phaseChanged', () => this.hide()),
    );
  }
}
