import type { GameContext } from '@/shared';
import { el } from '../dom';
import { MenuBase } from './MenuBase';

/** Escape menu: resume / abort mission. Driven by `game:paused`. */
export class PauseMenu extends MenuBase {
  constructor(parent: HTMLElement) {
    super(parent, 'pause');
    const head = el('div', { parent: this.frame });
    el('div', { cls: 'title', text: '일시 정지', parent: head });
    el('div', { cls: 'subtitle', text: '임무 진행이 정지되었습니다', parent: head });
    const actions = el('div', { cls: 'actions', parent: this.frame });
    this.button(actions, '계속', () => this.ctx.bus.emit('game:paused', { paused: false }), 'primary');
    this.button(actions, '임무 포기', () => this.ctx.bus.emit('game:abort', {}), 'danger');
    el('div', { cls: 'hint', text: 'Esc — 계속', parent: this.frame });
  }

  override bind(ctx: GameContext): void {
    super.bind(ctx);
    this.unsubs.push(
      ctx.bus.on('game:paused', ({ paused }) => { if (paused) this.show(); else this.hide(); }),
      ctx.bus.on('game:phaseChanged', () => this.hide()),
    );
  }
}
