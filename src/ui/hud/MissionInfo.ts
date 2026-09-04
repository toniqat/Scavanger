import type { GameContext } from '@/shared';
import { el, setText, fmtTime } from '../dom';

/** Top-right: kill counter + mission timer. */
export class MissionInfo {
  readonly root: HTMLElement;
  private killsEl: HTMLElement;
  private timeEl: HTMLElement;
  private lastKills = -1;
  private lastTime = '';

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'mission-info', parent });
    const t = el('div', { cls: 'stat', parent: this.root });
    el('span', { cls: 'ui-label', text: '임무 시간', parent: t });
    this.timeEl = el('span', { cls: 'val', text: '00:00', parent: t });
    const k = el('div', { cls: 'stat', parent: this.root });
    el('span', { cls: 'ui-label', text: '처치', parent: k });
    this.killsEl = el('span', { cls: 'val', text: '0', parent: k });
  }

  update(ctx: GameContext): void {
    const kills = ctx.stats.kills;
    if (kills !== this.lastKills) { this.lastKills = kills; setText(this.killsEl, String(kills)); }
    const t = fmtTime(ctx.missionTime);
    if (t !== this.lastTime) { this.lastTime = t; setText(this.timeEl, t); }
  }

  dispose(): void { this.root.remove(); }
}
