import type { GameContext, MissionStats } from '@/shared';
import { planetLabel } from '@/shared';
import { el, fmtTime, setText, toggleClass } from '../dom';
import { MenuBase } from './MenuBase';
import { RewardsBlock } from './RewardsBlock';
import { ResultReport, buildResultHeader, type ResultHeader } from './ResultReport';

const SUB_EXTRACT = '스캐빈저 회수 완료 — 전리품 확보';
const SUB_DEAD = '스캐빈저 신호 소실 — 장비는 유해에 남았습니다';

/**
 * Extraction summary, shown on `game:complete`. `함선으로 귀환` (primary) → `hub:enter {ship}` (shared while in a lobby).
 * Phase 5: a `RewardsBlock` (XP count-up, level, XP bar, contract line) between the stats and the actions, shown only
 * when `stats.rewards` is present. Phase 11: the banner carries the 목표 행성 name (`planetLabel(ctx.missionPlanet)`).
 *
 * **2026-09-15 (결과 창 개편, 사용자 결정):** `다시 배치 (같은 시드)` 버튼과 그 기능이 없어졌다. 제목 줄 오른쪽에 임무 시간
 * 하나, 그 아래 `전리품 가치` 한 줄(카운트업)만 남았다 — 처치 · 개봉한 상자 · 받은 피해 칸은 없다 (`ResultReport`).
 * 분대가 탈출할 때 **쓰러져 있던 사람**(`stats.extracted === false`)도 이 화면을 보는데, 그 사람에게는 사망 결과 창과
 * 같은 모습을 보여 준다 — 제목 `전사`, `잃은 전리품 가치`(`peakLootValue`, 빨강), 사망 원인 줄.
 */
export class MissionComplete extends MenuBase {
  private head: ResultHeader;
  private subtitleEl: HTMLElement;
  private planetEl: HTMLElement;
  private report: ResultReport;
  private rewards: RewardsBlock;

  constructor(parent: HTMLElement) {
    super(parent, 'complete');
    const head = el('div', { cls: 'banner', parent: this.frame });
    el('span', { cls: 'ui-label', text: '임무 보고', parent: head });
    this.head = buildResultHeader(head, '탈출 성공', 'success');
    this.subtitleEl = el('div', { cls: 'subtitle', text: SUB_EXTRACT, parent: head });
    this.planetEl = el('div', { cls: 'planet-line', parent: head });

    this.report = new ResultReport(this.frame);
    this.rewards = new RewardsBlock(this.frame);

    const actions = el('div', { cls: 'actions', parent: this.frame });
    this.button(actions, '함선으로 귀환', () => this.ctx.bus.emit('hub:enter', { ship: this.ctx.net?.lobby ? 'shared' : 'personal' }), 'primary');
  }

  override bind(ctx: GameContext): void {
    super.bind(ctx);
    this.rewards.bind(ctx);
    this.report.bind(ctx);
    this.unsubs.push(
      ctx.bus.on('game:complete', ({ stats }) => { this.fill(stats); this.show(); }),
      ctx.bus.on('game:phaseChanged', ({ phase }) => { if (phase !== 'complete') this.hide(); }),
    );
  }

  private fill(s: MissionStats): void {
    const dead = !s.extracted;
    toggleClass(this.root, 'rs-dead', dead);
    toggleClass(this.head.title, 'success', !dead);
    toggleClass(this.head.title, 'danger', dead);
    setText(this.head.title, dead ? '전사' : '탈출 성공');
    setText(this.subtitleEl, dead ? SUB_DEAD : SUB_EXTRACT);
    setText(this.planetEl, `행성 · ${planetLabel(this.ctx.missionPlanet)}`);
    setText(this.head.time, fmtTime(s.timeSeconds));
    this.report.fill(s, dead ? 'death' : 'extract');
    this.rewards.fill(s.rewards, dead ? 'dead' : 'complete');
  }

  protected override onHide(): void { this.rewards.stop(); this.report.stop(); }

  /** The XP settlement block (debug). */
  get rewardsBlock(): RewardsBlock { return this.rewards; }
  /** The loot / death-cause rows (debug). */
  get resultReport(): ResultReport { return this.report; }

  update(dt: number): void {
    if (!this.visible) return;
    this.rewards.update(dt);
    this.report.update(dt);
  }
}
