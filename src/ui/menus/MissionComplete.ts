import type { GameContext, MissionStats } from '@/shared';
import { missionPlanetLabel } from '@/shared';
import { el, fmtTime, setText, toggleClass } from '../dom';
import { MenuBase } from './MenuBase';
import { RewardsBlock } from './RewardsBlock';
import { ResultReport, buildPlanetLine, buildResultHeader, type PlanetLine, type ResultHeader } from './ResultReport';

const SUB_DEAD = '스캐빈저 신호 소실 — 장비는 유해에 남았습니다';

/**
 * Extraction summary, shown on `game:complete`. `함선으로 귀환` (primary) → `ui:shipReturn` (fade → loading → `hub:enter` → fade in, `ShipReturn`).
 * Phase 5: a `RewardsBlock` (XP count-up, level, XP bar, contract line) between the stats and the actions, shown only
 * when `stats.rewards` is present. Phase 11: the banner carries the 목표 행성 name (`planetLabel(ctx.missionPlanet)`).
 *
 * **2026-09-15 (result window rework, user's decision):** the `다시 배치 (같은 시드)` button and what it did are gone.
 * One mission time at the right of the title row, and under it a single `전리품 가치` row (counting up) — no kill ·
 * crates opened · damage taken cells (`ResultReport`). Someone who was **down** when the squad extracted
 * (`stats.extracted === false`) sees this screen too, and is shown the death result window's look — the title `전사`,
 * `잃은 전리품 가치` (`peakLootValue`, red) and the death cause row.
 *
 * **2026-09-15 (the header, user's decision):** the extraction-success subtitle `스캐빈저 회수 완료 — 전리품 확보` is
 * gone — but the **death look's subtitle** (`SUB_DEAD`) uses that element, so it is not removed, only `hidden` on an
 * extraction (`hidden`, not `style.display` — the root contract). The planet row is `buildPlanetLine`'s two pieces (a
 * grey `행성` + a white name), looking the same as in `DeathScreen`.
 */
export class MissionComplete extends MenuBase {
  private head: ResultHeader;
  private subtitleEl: HTMLElement;
  private planet: PlanetLine;
  private report: ResultReport;
  private rewards: RewardsBlock;

  constructor(parent: HTMLElement) {
    super(parent, 'complete');
    const head = el('div', { cls: 'banner', parent: this.frame });
    el('span', { cls: 'ui-label', text: '임무 보고', parent: head });
    this.head = buildResultHeader(head, '탈출 성공', 'success');
    // The subtitle belongs to the death look (`SUB_DEAD`) alone — on an extraction success it has no text and is `hidden`.
    this.subtitleEl = el('div', { cls: 'subtitle', text: '', parent: head });
    this.subtitleEl.hidden = true;
    this.planet = buildPlanetLine(head);

    this.report = new ResultReport(this.frame);
    this.rewards = new RewardsBlock(this.frame);

    const actions = el('div', { cls: 'actions', parent: this.frame });
    this.button(actions, '함선으로 귀환', () => this.ctx.bus.emit('ui:shipReturn', {}), 'primary');   // 2026-09-16: black → loading → fade in (`ShipReturn`)
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
    setText(this.subtitleEl, dead ? SUB_DEAD : '');
    this.subtitleEl.hidden = !dead;
    setText(this.planet.value, missionPlanetLabel(this.ctx.missionMode, this.ctx.missionPlanet));   // 2026-09-16: the tutorial = `표류 행성`
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
