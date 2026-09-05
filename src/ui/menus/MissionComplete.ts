import type { GameContext, MissionStats } from '@/shared';
import { el, fmtTime, fmtInt, setText } from '../dom';
import { MenuBase } from './MenuBase';
import { randomSeed } from './seed';

/** Extraction summary: loot value counts up, kills / crates / time, redeploy (solo) or back to the lobby (squad). */
export class MissionComplete extends MenuBase {
  private vals: Record<string, HTMLElement> = {};
  private seed = 0;
  private lootTarget = 0;
  private lootShown = 0;
  private countTimer = 0;
  private counting = false;
  private lastLootText = '';
  private soloBtns: HTMLButtonElement[] = [];
  private lobbyBtn: HTMLButtonElement;

  constructor(parent: HTMLElement) {
    super(parent, 'complete');
    const head = el('div', { cls: 'banner', parent: this.frame });
    el('span', { cls: 'ui-label', text: '임무 보고', parent: head });
    el('div', { cls: 'title success', text: '탈출 성공', parent: head });
    el('div', { cls: 'subtitle', text: '스캐빈저 회수 완료 — 전리품 확보', parent: head });

    const stats = el('div', { cls: 'stats', parent: this.frame });
    const loot = el('div', { cls: 'stat wide', parent: stats });
    el('span', { cls: 'ui-label', text: '전리품 가치', parent: loot });
    this.vals.loot = el('span', { cls: 'v accent', text: '0', parent: loot });
    for (const [k, label] of [['kills', '처치'], ['time', '임무 시간'], ['crates', '개봉한 상자'], ['damage', '받은 피해']] as const) {
      const s = el('div', { cls: 'stat', parent: stats });
      el('span', { cls: 'ui-label', text: label, parent: s });
      this.vals[k] = el('span', { cls: 'v', text: '0', parent: s });
    }

    const actions = el('div', { cls: 'actions', parent: this.frame });
    this.soloBtns.push(
      this.button(actions, '다시 배치', () => this.ctx.bus.emit('game:newMission', { seed: this.seed }), 'primary'),
      this.button(actions, '새 임무 (무작위 시드)', () => this.ctx.bus.emit('game:newMission', { seed: randomSeed() })),
    );
    this.lobbyBtn = this.button(actions, '로비로', () => this.ctx.bus.emit('game:abort', {}), 'primary');
    this.soloBtns.push(this.button(actions, '메뉴로', () => this.ctx.bus.emit('game:abort', {})));
  }

  override bind(ctx: GameContext): void {
    super.bind(ctx);
    this.unsubs.push(
      ctx.bus.on('game:complete', ({ stats }) => { this.fill(stats); this.show(); }),
      ctx.bus.on('game:phaseChanged', ({ phase }) => { if (phase !== 'complete') this.hide(); }),
    );
  }

  private fill(s: MissionStats): void {
    this.seed = s.seed;
    const inLobby = !!this.ctx.net?.lobby;
    for (const b of this.soloBtns) b.hidden = inLobby;
    this.lobbyBtn.hidden = !inLobby;
    setText(this.vals.kills, String(s.kills));
    setText(this.vals.time, fmtTime(s.timeSeconds));
    setText(this.vals.crates, String(s.cratesOpened));
    setText(this.vals.damage, fmtInt(s.damageTaken));
    this.lootTarget = s.lootValue;
    this.lootShown = 0;
    this.countTimer = 0;
    this.counting = true;
    setText(this.vals.loot, '0');
  }

  update(dt: number): void {
    if (!this.visible || !this.counting) return;
    this.countTimer += dt;
    const dur = 1.6;
    const t = Math.min(1, (this.countTimer - 0.4) / dur);
    if (t < 0) return;
    const eased = 1 - Math.pow(1 - t, 3);
    this.lootShown = this.lootTarget * eased;
    const txt = fmtInt(this.lootShown);
    if (txt !== this.lastLootText) { this.lastLootText = txt; setText(this.vals.loot, txt); }
    if (t >= 1) {
      this.counting = false;
      this.ctx.bus.emit('audio:play', { id: 'ui_equip' });
    }
  }
}
