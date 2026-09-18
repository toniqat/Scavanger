import type { GameContext, MissionStats } from '@/shared';
import { RAID_FAILED_AUTO_RETURN_S, missionPlanetLabel } from '@/shared';
import { el, fmtTime, setText, toggleClass } from '../dom';
import { MenuBase } from './MenuBase';
import { RewardsBlock } from './RewardsBlock';
import { ResultReport, buildPlanetLine, buildResultHeader, type PlanetLine, type ResultHeader } from './ResultReport';

/**
 * "전사" screen with mission stats, shown on `game:phaseChanged {phase:'dead'}` (solo; also on the legacy `game:over`).
 * `함선으로 귀환` → `ui:shipReturn` (2026-09-16, `ShipReturn`). Hidden whenever the phase leaves `dead`. Phase 5: a `RewardsBlock` under the
 * stats (death wording for an unfinished contract: `진척 유지 안 됨`), shown only when `stats.rewards` is present;
 * `update(dt)` drives its count-up.
 *
 * **레이드 실패** (Phase 7): `game:raidFailed` (squad wipe / solo death, emitted right before `game:over`) switches
 * the screen into failure mode — title `레이드 실패`, `함선으로 귀환` plus a `n초 후 자동 귀환` line counting down
 * from `RAID_FAILED_AUTO_RETURN_S` (display only: game/ performs the return).
 * The mode resets on `game:newMission` / `game:abort`.
 *
 * **2026-09-09 — the auto-revive is gone.** There is no `부활 (n초)` button and no Space. This screen only shows in
 * phase `dead`, and that phase now only comes when the raid has really ended (a solo death · a squad wipe) — dying
 * alone in a squad leaves the phase as it is and `ui/hud/SpectateOverlay` shows the wait for a rescue drop.
 *
 * **2026-09-15 (result window rework, user's decision):** one mission time at the right of the title row, under it
 * `잃은 전리품 가치` (`stats.peakLootValue` — the highest value carried in that raid, red) → the death cause row
 * (`stats.death` — the killing blow's face / a cause icon · its name · the damage taken from it) → the XP gained. There
 * are no kill · survival time · crates opened · damage taken cells. The body is `ResultReport`, shared with `MissionComplete`.
 *
 * **2026-09-15 (the header, user's decision):** the planet row is `buildPlanetLine`'s two pieces — a grey `행성` label +
 * a slightly larger white name, no middle dot. The subtitle carries this screen's meaning (`신호 소실` · `분대 전멸`),
 * so it **stays** (only the extraction-success subtitle was dropped).
 */
export class DeathScreen extends MenuBase {
  private head: ResultHeader;
  private subtitleEl: HTMLElement;
  private planet: PlanetLine;
  private autoEl: HTMLElement;
  private report: ResultReport;
  private rewards: RewardsBlock;
  private failed = false;
  private autoLeft = 0;
  private lastAuto = -1;

  constructor(parent: HTMLElement) {
    super(parent, 'death');
    const head = el('div', { parent: this.frame });
    this.head = buildResultHeader(head, '전사', 'danger');
    this.subtitleEl = el('div', { cls: 'subtitle', text: '스캐빈저 신호 소실 — 장비는 유해에 남았습니다', parent: head });
    // Phase 11: which planet this went wrong on (`PLANET_NONE_LABEL` when the raid carried no planet).
    // 2026-09-15: two pieces (a grey `행성` + a white name), looking the same as in `MissionComplete`.
    this.planet = buildPlanetLine(head);

    this.report = new ResultReport(this.frame);
    this.rewards = new RewardsBlock(this.frame);

    const actions = el('div', { cls: 'actions', parent: this.frame });
    this.button(actions, '함선으로 귀환', () => this.ctx.bus.emit('ui:shipReturn', {}), 'primary');   // 2026-09-16: black → loading → fade in (`ShipReturn`)
    this.autoEl = el('div', { cls: 'auto-return', text: '', parent: this.frame });
    this.autoEl.hidden = true;
  }

  override bind(ctx: GameContext): void {
    super.bind(ctx);
    this.rewards.bind(ctx);
    this.report.bind(ctx);
    this.unsubs.push(
      ctx.bus.on('game:raidFailed', () => this.setFailed(true)),
      ctx.bus.on('game:over', ({ stats }) => { this.fill(stats); this.show(); }),
      ctx.bus.on('game:phaseChanged', ({ phase }) => {
        if (phase === 'dead') { this.fill(ctx.stats); this.show(); } else this.hide();
      }),
      ctx.bus.on('game:newMission', () => this.setFailed(false)),
      ctx.bus.on('game:abort', () => this.setFailed(false)),
    );
  }

  protected override onShow(): void { this.applyMode(); }
  protected override onHide(): void { this.rewards.stop(); this.report.stop(); }

  update(dt: number): void {
    if (!this.visible) return;
    this.rewards.update(dt);
    this.report.update(dt);
    if (this.failed && this.autoLeft > 0) {
      this.autoLeft = Math.max(0, this.autoLeft - dt);
      this.applyAuto();
    }
  }

  /** The XP settlement block (debug). */
  get rewardsBlock(): RewardsBlock { return this.rewards; }
  /** The lost-loot / death-cause rows (debug). */
  get resultReport(): ResultReport { return this.report; }
  /** Whether the screen is in 레이드 실패 mode (debug). */
  get isRaidFailed(): boolean { return this.failed; }

  private setFailed(on: boolean): void {
    if (on) { this.autoLeft = RAID_FAILED_AUTO_RETURN_S; this.lastAuto = -1; }
    if (on === this.failed) { if (on) this.applyMode(); return; }
    this.failed = on;
    this.applyMode();
  }

  private applyMode(): void {
    const f = this.failed;
    toggleClass(this.root, 'raid-failed', f);
    setText(this.head.title, f ? '레이드 실패' : '전사');
    setText(this.subtitleEl, f ? '분대 전멸 — 스캐빈저 신호 완전 소실' : '스캐빈저 신호 소실 — 장비는 유해에 남았습니다');
    this.autoEl.hidden = !f;
    if (f) this.applyAuto();
  }

  private applyAuto(): void {
    const s = Math.max(0, Math.ceil(this.autoLeft));
    if (s === this.lastAuto) return;
    this.lastAuto = s;
    setText(this.autoEl, s > 0 ? `${s}초 후 자동 귀환` : '함선으로 귀환 중…');
  }

  private fill(s: MissionStats): void {
    setText(this.planet.value, missionPlanetLabel(this.ctx.missionMode, this.ctx.missionPlanet));   // 2026-09-16: the tutorial = `표류 행성`
    setText(this.head.time, fmtTime(s.timeSeconds));
    this.report.fill(s, 'death');
    this.rewards.fill(s.rewards, 'dead');
  }

  override dispose(): void {
    super.dispose();
  }
}
