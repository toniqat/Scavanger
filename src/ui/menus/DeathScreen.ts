import type { GameContext, MissionStats } from '@/shared';
import { RAID_FAILED_AUTO_RETURN_S, formatCredits, planetLabel } from '@/shared';
import { el, fmtTime, fmtInt, setText, toggleClass } from '../dom';
import { MenuBase } from './MenuBase';
import { RewardsBlock } from './RewardsBlock';

/**
 * "전사" screen with mission stats, shown on `game:phaseChanged {phase:'dead'}` (solo; also on the legacy `game:over`).
 * `함선으로 귀환` → `hub:enter {ship}`. Hidden whenever the phase leaves `dead`. Phase 5: a `RewardsBlock` under the
 * stats (death wording for an unfinished contract: `진척 유지 안 됨`), shown only when `stats.rewards` is present;
 * `update(dt)` drives its count-up.
 *
 * **레이드 실패** (Phase 7): `game:raidFailed` (squad wipe / solo death, emitted right before `game:over`) switches
 * the screen into failure mode — title `레이드 실패`, `함선으로 귀환` plus a `n초 후 자동 귀환` line counting down
 * from `RAID_FAILED_AUTO_RETURN_S` (display only: game/ performs the return).
 * The mode resets on `game:newMission` / `game:abort`.
 *
 * **2026-09-09 — 자동 부활이 사라졌다.** `부활 (n초)` 버튼도 Space 도 없다. 이 화면은 phase `dead` 에서만 뜨는데
 * 그 페이즈는 이제 레이드가 정말 끝났을 때(솔로 사망 · 분대 전멸)만 온다 — 분대에서 혼자 죽으면 페이즈는 그대로고
 * `ui/hud/SpectateOverlay` 가 구조선 대기를 보여 준다.
 */
export class DeathScreen extends MenuBase {
  private vals: Record<string, HTMLElement> = {};
  private titleEl: HTMLElement;
  private subtitleEl: HTMLElement;
  private planetEl!: HTMLElement;
  private autoEl: HTMLElement;
  private rewards: RewardsBlock;
  private failed = false;
  private autoLeft = 0;
  private lastAuto = -1;

  constructor(parent: HTMLElement) {
    super(parent, 'death');
    const head = el('div', { parent: this.frame });
    this.titleEl = el('div', { cls: 'title danger', text: '전사', parent: head });
    this.subtitleEl = el('div', { cls: 'subtitle', text: '스캐빈저 신호 소실 — 장비는 유해에 남았습니다', parent: head });
    // Phase 11: which planet this went wrong on (`PLANET_NONE_LABEL` when the raid carried no planet).
    this.planetEl = el('div', { cls: 'planet-line', parent: head });

    const stats = el('div', { cls: 'stats', parent: this.frame });
    for (const [k, label] of [['kills', '처치'], ['time', '생존 시간'], ['crates', '개봉한 상자'], ['damage', '받은 피해']] as const) {
      const s = el('div', { cls: 'stat', parent: stats });
      el('span', { cls: 'ui-label', text: label, parent: s });
      this.vals[k] = el('span', { cls: 'v', text: '0', parent: s });
    }
    const lost = el('div', { cls: 'stat wide', parent: stats });
    el('span', { cls: 'ui-label', text: '소실된 전리품 가치', parent: lost });
    this.vals.loot = el('span', { cls: 'v', text: formatCredits(0), parent: lost });
    this.vals.loot.style.color = 'var(--c-danger)';
    this.rewards = new RewardsBlock(this.frame);

    const actions = el('div', { cls: 'actions', parent: this.frame });
    this.button(actions, '함선으로 귀환', () => this.ctx.bus.emit('hub:enter', { ship: this.ctx.net?.lobby ? 'shared' : 'personal' }), 'primary');
    this.autoEl = el('div', { cls: 'auto-return', text: '', parent: this.frame });
    this.autoEl.hidden = true;
  }

  override bind(ctx: GameContext): void {
    super.bind(ctx);
    this.rewards.bind(ctx);
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
  protected override onHide(): void { this.rewards.stop(); }

  update(dt: number): void {
    if (!this.visible) return;
    this.rewards.update(dt);
    if (this.failed && this.autoLeft > 0) {
      this.autoLeft = Math.max(0, this.autoLeft - dt);
      this.applyAuto();
    }
  }

  /** The XP settlement block (debug). */
  get rewardsBlock(): RewardsBlock { return this.rewards; }
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
    setText(this.titleEl, f ? '레이드 실패' : '전사');
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
    setText(this.planetEl, `행성 · ${planetLabel(this.ctx.missionPlanet)}`);
    setText(this.vals.kills, String(s.kills));
    setText(this.vals.time, fmtTime(s.timeSeconds));
    setText(this.vals.crates, String(s.cratesOpened));
    setText(this.vals.damage, fmtInt(s.damageTaken));
    setText(this.vals.loot, formatCredits(this.ctx.inventory?.getTotalValue() ?? s.lootValue));
    this.rewards.fill(s.rewards, 'dead');
  }

  override dispose(): void {
    super.dispose();
  }
}
