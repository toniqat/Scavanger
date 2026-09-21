import type { ContractSettlement, GameContext, MissionRewards, RaidXpCard } from '@/shared';
/* 2026-09-16 (user's decision 「큰 수 축약」): XP uses the same notation as credits · values (`shared/numberFormat`) —
   it is a value that grows to any number of digits, so `1.20m` reads at a glance where `1,204,800` does not. A number
   **whose exact value is its meaning**, like contract progress `p / t`, stays on `fmtInt`. */
import { NET_SLOT_COLORS_CSS, formatCompactNumber, formatCompactSigned, xpToNextLevel } from '@/shared';
import { el, setText, toggleClass } from '../dom';
import { xpKindSvg } from './results/icons';

const COUNT_DELAY = 0.35;   // seconds before the first card starts counting (after the page's entry fade)
const CARD_COUNT_S = 0.7;   // seconds one card counts up
const CARD_GAP_S = 0.12;    // pause between two cards
const BURST_MS = 900;       // light-burst element lifetime
/** Trust-card face thumbnail, CSS px (`results.css` `.rs-card-face`); drawn at × devicePixelRatio (2 at most). */
const FACE_CSS_PX = 28;

type Outcome = NonNullable<ContractSettlement['outcome']>;

/** Contract wording shared by the result screens and `MetaToasts` (Phase 7: keyed on `settlement.outcome` only). */
export const CONTRACT_OUTCOME_TEXT: Record<Outcome, string> = {
  success: '계약 성공',
  incomplete: '계약 미완 · 계속',
  failed: '계약 실패 · 진척 유지 안 됨',
};
/** CSS class per outcome (`.success` / `.keep` / `.lost` on the result line, `.success` / `.keep` / `.fail` on toasts). */
export const CONTRACT_OUTCOME_CLASS: Record<Outcome, string> = { success: 'success', incomplete: 'keep', failed: 'lost' };

/**
 * `outcome` of a settlement, tolerating producers from before Phase 7 (`success` → success, otherwise `fallback`).
 * Never derives anything from `ctx.stats.extracted`.
 */
export function contractOutcome(c: Pick<ContractSettlement, 'success' | 'outcome'>, fallback: Outcome = 'incomplete'): Outcome {
  return c.outcome ?? (c.success ? 'success' : fallback);
}

interface CardView {
  data: RaidXpCard;
  root: HTMLElement;
  xpEl: HTMLElement;
  /** Accumulated XP when this card starts / ends counting (in the bar's units, scaled so the last card ends on `xpEarned`). */
  from: number;
  to: number;
  lastText: string;
}

/**
 * Page ② of the result screen — XP (2026-09-21, the paged result screen, user's decisions).
 *
 * Top: `획득 경험치 +n` (the running total), the `사망 ×m` tag when `rewards.deathMul < 1` (the number is read, not
 * written here), `Lv. n`, the XP bar and `xp / cap XP`. Below: **one horizontal row of cards** (`.rs-cards`, scrolls
 * sideways when it overflows), one per `rewards.cards` entry — icon, title, detail, the card's XP at its bottom-right.
 * The cards count up **one after another** and the bar above fills with each, crossing as many levels as the raid paid
 * for: the path is walked backwards from the final `xp / xpToNext` with `shared/xpToNextLevel`. A producer that sends
 * no cards gets one card built from `xpEarned`. Trust cards (`kind: 'trust'`) carry the squadmate's face.
 *
 * **Level-up moment** (Phase 7): the block owns the whole level-up presentation. Each time the count crosses a level
 * boundary it shows the `레벨 업` badge, spawns a `.up-burst` light burst and emits `audio:play {id:'level_up'}` — the
 * only place that chime is played (audio/ dropped its `progress:levelUp` hook and `ProgressToasts` does not toast
 * level-ups). The contract line moved to page ③ (`results/ContractsPage`).
 *
 * Counting starts on `enter()`; the owning screen calls `update(dt)` while visible; `finish()` snaps to the end. The
 * live card is scrolled into view from a `requestAnimationFrame` callback — outside `Engine.frame`, so no layout read
 * happens inside the frame (§4.2).
 */
export class RewardsBlock {
  readonly root: HTMLElement;
  private gainEl: HTMLElement;
  private mulEl: HTMLElement;
  private lvEl: HTMLElement;
  private upEl: HTMLElement;
  private fillEl: HTMLElement;
  private numEl: HTMLElement;
  private cardsEl: HTMLElement;
  private ctx: GameContext | null = null;

  private rewards: MissionRewards | null = null;
  private cards: CardView[] = [];
  private total = 0;
  private xpBefore = 0;
  private timer = 0;
  private counting = false;
  private lastGain = '';
  private lastNum = '';
  private shownLevel = 0;
  private liveIdx = -1;
  private crossed = false;
  private burst: HTMLElement | null = null;
  private burstTimer: number | null = null;
  private job = 0;

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'rewards rs-xp', parent });
    this.root.hidden = true;
    const row = el('div', { cls: 'xp-row', parent: this.root });
    // 2026-09-15 (result window rework): `획득 XP` → `획득 경험치` — so the death result window states plainly what was gained
    el('span', { cls: 'ui-label', text: '획득 경험치', parent: row });
    this.gainEl = el('span', { cls: 'xp-gain', text: '+0', parent: row });
    this.mulEl = el('span', { cls: 'rs-xp-mul', text: '', parent: row });
    this.mulEl.hidden = true;
    this.lvEl = el('span', { cls: 'lv', text: '', parent: row });
    this.upEl = el('span', { cls: 'up-badge', text: '레벨 업', parent: row });
    this.upEl.hidden = true;
    const bar = el('div', { cls: 'xp-bar', parent: this.root });
    this.fillEl = el('div', { cls: 'fill', parent: bar });
    this.numEl = el('div', { cls: 'xp-num', text: '', parent: this.root });
    this.cardsEl = el('div', { cls: 'rs-cards', parent: this.root });
  }

  bind(ctx: GameContext): void { this.ctx = ctx; }

  /** Set the data (nothing animates until `enter()`). `fill(undefined)` hides the block (older emitters / no progression). */
  fill(rewards: MissionRewards | undefined): void {
    this.rewards = rewards ?? null;
    this.root.hidden = !rewards;
    this.counting = false;
    this.removeBurst();
    this.cardsEl.replaceChildren();
    this.cards = [];
    this.liveIdx = -1;
    const job = ++this.job;
    if (!rewards) return;

    this.total = Math.max(0, rewards.xpEarned);
    this.xpBefore = this.startXp(rewards);
    this.crossed = false;
    this.root.classList.remove('up');
    this.upEl.hidden = true;

    const mul = rewards.deathMul;
    const dead = typeof mul === 'number' && Number.isFinite(mul) && mul < 1;
    this.mulEl.hidden = !dead;
    if (dead) setText(this.mulEl, `사망 ×${+mul.toFixed(2)}`);

    // Cards — the producer's, or one built from the total. The bar runs on the cards' running sum, scaled so the last
    // card lands exactly on `xpEarned` even if the producer's rounding left a few points over or under.
    const list: RaidXpCard[] = rewards.cards && rewards.cards.length > 0
      ? rewards.cards
      : [{ kind: 'kill', id: 'total', title: '획득 경험치', xp: this.total }];
    const sum = list.reduce((a, c) => a + Math.max(0, c.xp), 0);
    const scale = sum > 0 ? this.total / sum : 0;
    let acc = 0;
    let slot = 1;
    for (const c of list) {
      const from = acc;
      acc += Math.max(0, c.xp) * scale;
      const root = el('div', { cls: `rs-card is-wait k-${c.kind}`, parent: this.cardsEl });
      root.dataset.id = c.id;
      const head = el('div', { cls: 'rs-card-head', parent: root });
      const icon = el('div', { cls: 'rs-card-icon', html: xpKindSvg(c.kind), parent: head });
      if (c.kind === 'trust' && c.peer) {
        const accent = c.peer.accent ?? NET_SLOT_COLORS_CSS[slot++ % NET_SLOT_COLORS_CSS.length];
        root.style.setProperty('--sc', accent);
        this.faceLater(job, icon, accent);
      }
      el('div', { cls: 'rs-card-title', text: c.title, parent: root });
      if (c.detail) el('div', { cls: 'rs-card-detail', text: c.detail, parent: root });
      const xpEl = el('div', { cls: 'rs-card-xp', text: '+0', parent: root });
      this.cards.push({ data: c, root, xpEl, from, to: acc, lastText: '+0' });
    }

    this.lastGain = '+0';
    setText(this.gainEl, '+0');
    this.timer = 0;
    this.lastNum = '';
    this.shownLevel = rewards.levelBefore;
    this.paintBar(0);
  }

  /** The page is shown — start counting. */
  enter(): void {
    if (!this.rewards) return;
    this.timer = 0;
    this.counting = true;
  }

  /** Snap to the end (the player moved on early): every card done, the bar at its final spot, one level-up moment at most. */
  finish(): void {
    if (!this.counting || !this.rewards) return;
    this.timer = this.endTime();
    this.update(0);
  }

  /** Count-up + bar fill; call every frame while the owning menu is visible. */
  update(dt: number): void {
    if (!this.counting || !this.rewards) return;
    this.timer += dt;
    const t = this.timer - COUNT_DELAY;
    if (t < 0) return;
    const step = CARD_COUNT_S + CARD_GAP_S;
    let gained = 0;
    let live = -1;
    for (let i = 0; i < this.cards.length; i++) {
      const c = this.cards[i];
      const k = Math.min(1, Math.max(0, (t - i * step) / CARD_COUNT_S));
      const eased = 1 - Math.pow(1 - k, 3);
      const v = c.from + (c.to - c.from) * eased;
      if (k > 0) gained = v;
      if (k > 0 && k < 1 && live < 0) live = i;
      const txt = formatCompactSigned(Math.max(0, c.data.xp) * eased, true);
      if (txt !== c.lastText) { c.lastText = txt; setText(c.xpEl, txt); }
      toggleClass(c.root, 'is-wait', k <= 0);
      toggleClass(c.root, 'is-live', k > 0 && k < 1);
      toggleClass(c.root, 'is-done', k >= 1);
    }
    if (live >= 0 && live !== this.liveIdx) { this.liveIdx = live; this.revealLater(this.cards[live].root); }
    const gain = formatCompactSigned(gained, true);
    if (gain !== this.lastGain) { this.lastGain = gain; setText(this.gainEl, gain); }
    this.paintBar(gained);
    if (this.timer >= this.endTime()) {
      this.counting = false;
      setText(this.gainEl, formatCompactSigned(this.total, true));
      this.paintBar(this.total);
    }
  }

  private endTime(): number {
    return COUNT_DELAY + Math.max(0, this.cards.length - 1) * (CARD_COUNT_S + CARD_GAP_S) + CARD_COUNT_S;
  }

  /** XP cap of `level` on the path: the final level's cap is the producer's own `xpToNext`. */
  private capOf(level: number): number {
    const r = this.rewards;
    if (r && level >= r.levelAfter) return Math.max(1, r.xpToNext);
    return xpToNextLevel(level);
  }

  /** XP into `levelBefore` before the raid — walked back from the final `xp` through every level crossed. */
  private startXp(r: MissionRewards): number {
    const earned = Math.max(0, r.xpEarned);
    if (r.levelAfter <= r.levelBefore) return Math.max(0, r.xp - earned);
    let rest = earned - r.xp;
    for (let L = r.levelBefore + 1; L < r.levelAfter; L++) rest -= xpToNextLevel(L);
    const cap = xpToNextLevel(r.levelBefore);
    return Math.min(cap - 1, Math.max(0, cap - rest));
  }

  /** Bar, level and `xp / cap` for `gained` XP into the count; fires the level-up moment on each crossing. */
  private paintBar(gained: number): void {
    const r = this.rewards;
    if (!r) return;
    let level = r.levelBefore;
    let into = this.xpBefore + gained;
    while (level < r.levelAfter && into >= this.capOf(level)) { into -= this.capOf(level); level++; }
    const cap = this.capOf(level);
    const frac = Math.min(1, Math.max(0, into / cap));
    this.fillEl.style.transform = `scaleX(${frac.toFixed(4)})`;
    if (level > this.shownLevel) {
      this.shownLevel = level;
      this.cross();
    }
    setText(this.lvEl, level > r.levelBefore ? `Lv. ${r.levelBefore} → ${level}` : `Lv. ${level}`);
    // An `x / y` pair only compares when **both** sides use the same notation (abbreviate one side only and it reads `1.2k / 240000`).
    const num = `${formatCompactNumber(Math.floor(into))} / ${formatCompactNumber(cap)} XP`;
    if (num !== this.lastNum) { this.lastNum = num; setText(this.numEl, num); }
  }

  /** A level-boundary moment: badge, light burst, the `level_up` chime (once per level crossed). */
  private cross(): void {
    this.crossed = true;
    this.root.classList.add('up');
    // Replay the badge's entry animation on every crossing without a layout read: `display: none` → shown restarts a
    // CSS animation, so hide it now and show it again from the next rAF callback (outside `Engine.frame`).
    this.upEl.hidden = true;
    const job = this.job;
    const show = (): void => { if (job === this.job && this.rewards) this.upEl.hidden = false; };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(show); else show();
    this.removeBurst();
    this.burst = el('div', { cls: 'up-burst', parent: this.root });
    this.burstTimer = window.setTimeout(() => this.removeBurst(), BURST_MS);
    this.ctx?.bus.emit('audio:play', { id: 'level_up', volume: 0.8 });
  }

  private removeBurst(): void {
    if (this.burstTimer !== null) { window.clearTimeout(this.burstTimer); this.burstTimer = null; }
    if (this.burst) { this.burst.remove(); this.burst = null; }
  }

  /** Scroll the live card into the row's view — from a rAF callback, never inside `Engine.frame`. */
  private revealLater(card: HTMLElement): void {
    const job = this.job;
    const go = (): void => {
      if (job !== this.job || !card.isConnected) return;
      card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(go); else go();
  }

  /** A trust card's squadmate face (cached PNG from `PlayerRef.snapshotFace`), drawn on the next frame; the icon stays without GL. */
  private faceLater(job: number, host: HTMLElement, accent: string): void {
    const draw = (): void => {
      if (job !== this.job) return;
      const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
      const size = Math.round(FACE_CSS_PX * Math.min(2, Math.max(1, dpr)));
      let url: string | null = null;
      try { url = this.ctx?.player?.snapshotFace?.({ accent, size }) ?? null; } catch { url = null; }
      if (!url || job !== this.job) return;
      const img = document.createElement('img');
      img.className = 'rs-card-face';
      img.alt = '';
      img.draggable = false;
      img.src = url;
      host.replaceChildren(img);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(draw); else draw();
  }

  /** Whether the XP count-up is still running (debug). */
  get isCounting(): boolean { return this.counting; }
  /** Whether the block shows a level-up highlight (debug). */
  get isLevelUp(): boolean { return this.root.classList.contains('up'); }
  /** Whether a level boundary was crossed in this count (debug). */
  get hasCrossed(): boolean { return this.crossed; }
  /** Whether the light burst element is currently attached (debug). */
  get isBursting(): boolean { return this.burst !== null; }
  /** Card ids in order + their current text (debug). */
  get cardViews(): Array<{ id: string; kind: string; xp: string; state: 'wait' | 'live' | 'done' }> {
    return this.cards.map((c) => ({
      id: c.data.id, kind: c.data.kind, xp: c.lastText,
      state: c.root.classList.contains('is-done') ? 'done' : c.root.classList.contains('is-live') ? 'live' : 'wait',
    }));
  }
  /** The `사망 ×m` tag text, '' when hidden (debug). */
  get deathTag(): string { return this.mulEl.hidden ? '' : (this.mulEl.textContent ?? ''); }

  /** Stop the animation without touching the DOM (menu hidden). */
  stop(): void { this.counting = false; }

  dispose(): void { this.removeBurst(); this.root.remove(); }
}
