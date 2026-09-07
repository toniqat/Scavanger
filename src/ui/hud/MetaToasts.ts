import type { GameContext } from '@/shared';
import { CORP_DEFS, formatCredits } from '@/shared';
import { el, fmtInt, setText } from '../dom';
import { CONTRACT_OUTCOME_TEXT, contractOutcome } from '../menus/RewardsBlock';

const CREDITS_FLUSH = 1.0;    // seconds of credit changes coalesced into one chip
const CREDITS_TTL = 2.0;
const REP_TTL = 4.2;
const CONTRACT_TTL = 5.0;
const MAX_TOASTS = 4;

/**
 * Top-centre meta toasts (Phase 5), stacked in the same column as `ProgressToasts` (constructed with its root):
 *   `meta:creditsChanged`  → coalesced `크레딧 +n C` / `크레딧 −n C` chip (`CREDITS_FLUSH` s, signed net, 0 = no chip;
 *                             Phase 10: the amount goes through the shared `formatCredits`, the word stays the label)
 *   `meta:repChanged`      → `<기업> 신뢰도 Lv.n` toast on `levelUp` only
 *   `meta:contractSettled` → large `계약 성공` / `계약 미완 · 계속` / `계약 실패 · 진척 유지 안 됨` toast keyed on
 *                             `settlement.outcome` (Phase 7; never on `ctx.stats.extracted`, wording shared with `RewardsBlock`)
 * Quest / purchase / sale lines live in `Notifications`. The meta folder never toasts itself.
 * Updated every frame regardless of the social layer's visibility so a settlement chip raised behind the result screen
 * expires like any other (the result screen already shows the same numbers).
 */
export class MetaToasts {
  private live: Array<{ el: HTMLElement; ttl: number }> = [];
  private creditsPending = 0;
  private creditsTimer = 0;
  private unsubs: Array<() => void> = [];

  constructor(private readonly root: HTMLElement) {}

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('meta:creditsChanged', ({ delta }) => {
        if (!Number.isFinite(delta) || delta === 0) return;
        this.creditsPending += delta;
        if (this.creditsTimer <= 0) this.creditsTimer = CREDITS_FLUSH;
      }),
      b.on('meta:repChanged', ({ corp, level, levelUp }) => {
        if (!levelUp) return;
        const t = this.push('rep', REP_TTL);
        el('span', { cls: 'k', text: '신뢰도 상승', parent: t });
        el('span', { cls: 'v', text: `${CORP_DEFS[corp]?.name ?? corp} 신뢰도 Lv.${level}`, parent: t });
      }),
      b.on('meta:contractSettled', (s) => {
        const outcome = contractOutcome(s);
        const kind = outcome === 'success' ? 'success' : outcome === 'incomplete' ? 'keep' : 'fail';
        const t = this.push(`contract ${kind}`, CONTRACT_TTL);
        el('span', { cls: 'k', text: CONTRACT_OUTCOME_TEXT[outcome], parent: t });
        el('span', { cls: 'v', text: s.name, parent: t });
        const sub = outcome === 'success'
          ? `신뢰도 +${fmtInt(s.rep)} · 크레딧 ${formatCredits(s.credits, { sign: true })}`
          : `${fmtInt(s.progress)} / ${fmtInt(s.target)}`;
        el('span', { cls: 's', text: sub, parent: t });
      }),
      b.on('game:abort', () => this.clear()),
      b.on('game:newMission', () => this.clear()),
    );
  }

  private push(kind: string, ttl: number): HTMLElement {
    const t = el('div', { cls: `ptoast meta ${kind}`, parent: this.root });
    this.live.push({ el: t, ttl });
    requestAnimationFrame(() => t.classList.add('in'));
    while (this.live.length > MAX_TOASTS) {
      const old = this.live.shift();
      if (old) old.el.remove();
    }
    return t;
  }

  update(dt: number): void {
    if (this.creditsTimer > 0) {
      this.creditsTimer -= dt;
      if (this.creditsTimer <= 0) {
        const n = Math.round(this.creditsPending);
        this.creditsPending = 0;
        if (n !== 0) {
          const t = this.push(n > 0 ? 'credits' : 'credits minus', CREDITS_TTL);
          setText(t, `크레딧 ${formatCredits(n, { sign: true })}`);
        }
      }
    }
    for (let i = this.live.length - 1; i >= 0; i--) {
      const item = this.live[i];
      item.ttl -= dt;
      if (item.ttl > 0) continue;
      this.live.splice(i, 1);
      item.el.classList.remove('in');
      item.el.classList.add('out');
      const node = item.el;
      window.setTimeout(() => node.remove(), 320);
    }
  }

  /** Live meta toasts (debug). */
  get liveCount(): number { return this.live.length; }

  private clear(): void {
    for (const t of this.live) t.el.remove();
    this.live.length = 0;
    this.creditsPending = 0; this.creditsTimer = 0;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.clear();
  }
}
