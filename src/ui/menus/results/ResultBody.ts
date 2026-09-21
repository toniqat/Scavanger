import type { GameContext, MissionStats } from '@/shared';
import { createKeycap } from '@/shared';
import { el, setText, toggleClass } from '../../dom';
import { RewardsBlock } from '../RewardsBlock';
import { ResultReport } from '../ResultReport';
import { ContractsPage } from './ContractsPage';
import { SquadPage } from './SquadPage';

export type ResultPageId = 'loot' | 'xp' | 'contracts' | 'squad';

const PAGE_LABEL: Record<ResultPageId, string> = { loot: '전리품', xp: '경험치', contracts: '분대 계약', squad: '분대원' };
const PAGE_FADE_S = 0.25;   // a page's entry fade (stepped in `update` — reduced motion clips CSS transitions)
/** The fixed advance key — not a `Keys` action (nothing in a result screen is rebindable), like the inventory's fixed gestures. */
const NEXT_KEY = 'Space';

interface Page {
  root: HTMLElement;
  enter(): void;
  finish(): void;
  update(dt: number): void;
  stop(): void;
}

/**
 * The paged body both result screens share (2026-09-21, user's decisions) — `MissionComplete` (extraction, and the
 * death look of someone down at extraction) and `DeathScreen` (solo death / squad wipe) put the same body under their
 * own header, so the two read as one screen.
 *
 * ① 전리품 (`ResultReport` — `.stats`) → ② 경험치 (`RewardsBlock` — `.rewards`) → ③ 분대 계약 (`ContractsPage`) →
 * ④ 분대원 (`SquadPage`, squad raids only). A page with no data is skipped (no `rewards` → ① only). A step strip on top
 * names the pages; `다음` (with a `Space` keycap) or `Space` moves on — an animation still running is snapped to its end
 * first, never lost. The last page swaps the `다음` row for `.actions` holding `함선으로 귀환`.
 *
 * DOM order stays `.stats` → `.rewards` → `.actions` (older smokes assert it). `.actions` holds exactly one `.ui-btn`
 * (`함선으로 귀환`); the `다음` button lives in `.rs-nav`. Hidden pages use `hidden`, not `style.display`.
 */
export class ResultBody {
  readonly report: ResultReport;
  readonly rewards: RewardsBlock;
  readonly contracts: ContractsPage;
  readonly squad: SquadPage;
  private steps: HTMLElement;
  private stepEls = new Map<ResultPageId, HTMLElement>();
  private pages: Record<ResultPageId, Page>;
  private nav: HTMLElement;
  private nextBtn: HTMLButtonElement;
  private actions: HTMLElement;
  private ctx: GameContext | null = null;
  private order: ResultPageId[] = ['loot'];
  private idx = 0;
  private fadeT = 0;
  private active = false;
  private readonly onKey = (e: KeyboardEvent): void => this.handleKey(e);

  constructor(frame: HTMLElement, onReturn: () => void) {
    frame.classList.add('rs-frame');
    this.steps = el('div', { cls: 'rs-steps', parent: frame });
    (Object.keys(PAGE_LABEL) as ResultPageId[]).forEach((id) => {
      const s = el('div', { cls: 'rs-step', parent: this.steps });
      el('span', { cls: 'rs-step-n', text: '', parent: s });
      el('span', { cls: 'rs-step-t', text: PAGE_LABEL[id], parent: s });
      this.stepEls.set(id, s);
    });
    const host = el('div', { cls: 'rs-pages', parent: frame });
    this.report = new ResultReport(host);
    this.rewards = new RewardsBlock(host);
    this.contracts = new ContractsPage(host);
    this.squad = new SquadPage(host);
    this.pages = { loot: this.report, xp: this.rewards, contracts: this.contracts, squad: this.squad };

    this.nav = el('div', { cls: 'rs-nav', parent: frame });
    this.nextBtn = el('button', { cls: 'ui-btn primary rs-next', parent: this.nav });
    createKeycap(NEXT_KEY, { cls: 'kc-btn', parent: this.nextBtn });
    el('span', { cls: 'rs-next-t', text: '다음', parent: this.nextBtn });
    this.nextBtn.addEventListener('click', (e) => { e.stopPropagation(); this.next(); });

    this.actions = el('div', { cls: 'actions', parent: frame });
    const back = el('button', { cls: 'ui-btn primary', text: '함선으로 귀환', parent: this.actions });
    back.addEventListener('click', (e) => {
      e.stopPropagation();
      this.ctx?.bus.emit('audio:play', { id: 'ui_click' });
      onReturn();
    });
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    this.report.bind(ctx);
    this.rewards.bind(ctx);
    this.squad.bind(ctx);
  }

  /** Fill every page and open page ①. `dead` = the death look (lost loot, cause row, `실패` wording). */
  fill(s: MissionStats, dead: boolean): void {
    const r = s.rewards;
    this.report.fill(s, dead ? 'death' : 'extract');
    this.rewards.fill(r);
    this.contracts.fill(r, dead);
    this.squad.fill(r?.squad);
    this.order = ['loot'];
    if (r) this.order.push('xp', 'contracts');
    if (r && this.squad.hasRows) this.order.push('squad');
    (Object.keys(PAGE_LABEL) as ResultPageId[]).forEach((id) => {
      const step = this.stepEls.get(id)!;
      const at = this.order.indexOf(id);
      step.hidden = at < 0;
      if (at >= 0) setText(step.firstElementChild as HTMLElement, String(at + 1));
    });
    this.steps.hidden = this.order.length < 2;
    this.go(0);
  }

  /** Start listening for `Space` (the owning screen is shown). */
  attach(): void {
    if (this.active) return;
    this.active = true;
    window.addEventListener('keydown', this.onKey, true);
  }

  /** Stop animations and the key listener (the owning screen is hidden). */
  detach(): void {
    for (const id of this.order) this.pages[id].stop();
    if (!this.active) return;
    this.active = false;
    window.removeEventListener('keydown', this.onKey, true);
  }

  /** Move to the next page; false on the last one. The page being left snaps its animation to the end. */
  next(): boolean {
    if (this.idx >= this.order.length - 1) return false;
    this.ctx?.bus.emit('audio:play', { id: 'ui_click' });
    this.pages[this.order[this.idx]].finish();
    this.go(this.idx + 1);
    return true;
  }

  update(dt: number): void {
    const page = this.pages[this.order[this.idx]];
    if (this.fadeT < PAGE_FADE_S) {
      this.fadeT = Math.min(PAGE_FADE_S, this.fadeT + dt);
      page.root.style.opacity = (this.fadeT / PAGE_FADE_S).toFixed(3);
    }
    // Earlier pages may still be finishing (a like fired a tween, a burst is up) — only the shown page is stepped.
    page.update(dt);
  }

  private go(i: number): void {
    this.idx = i;
    const cur = this.order[i];
    for (const id of Object.keys(this.pages) as ResultPageId[]) {
      const shown = id === cur;
      // `rewards` is also hidden by its own `fill(undefined)` — never un-hide a page that has no data.
      this.pages[id].root.hidden = !shown || !this.order.includes(id);
      toggleClass(this.stepEls.get(id)!, 'is-on', shown);
      toggleClass(this.stepEls.get(id)!, 'is-past', this.order.indexOf(id) >= 0 && this.order.indexOf(id) < i);
    }
    const page = this.pages[cur];
    this.fadeT = 0;
    page.root.style.opacity = '0';
    page.enter();
    const last = i >= this.order.length - 1;
    this.nav.hidden = last;
    this.actions.hidden = !last;
  }

  private handleKey(e: KeyboardEvent): void {
    if (e.code !== NEXT_KEY || e.repeat) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.next();
  }

  /* ── debug ── */
  get pageId(): ResultPageId { return this.order[this.idx]; }
  get pageIndex(): number { return this.idx; }
  get pageOrder(): readonly ResultPageId[] { return this.order; }
  get onLastPage(): boolean { return this.idx >= this.order.length - 1; }

  dispose(): void { this.detach(); this.rewards.dispose(); }
}
