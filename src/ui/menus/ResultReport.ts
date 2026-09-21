import '../styles/results.css';
import type { GameContext, MissionDeathCause, MissionStats } from '@/shared';
import { formatCredits } from '@/shared';
import { el, fmtInt, setText, toggleClass } from '../dom';

/**
 * The result windows' shared body (2026-09-15, the result window rework — user's decision). `menus/MissionComplete` ·
 * `menus/DeathScreen` use it together.
 *
 * - `buildResultHeader` — the title row: the title on the left (`탈출 성공` / `전사` / `레이드 실패`), one **mission time** on the right.
 * - `buildPlanetLine` — the planet row: a grey `행성` label on the left (the size of the dropped subtitle), a slightly larger white name on the right. No middle dot.
 * - `ResultReport` — one `.stats.rs-stats` block:
 *   - The loot row: label left · value right (`1,234 C`, counting up). Extraction = `전리품 가치` (`stats.lootValue`, amber),
 *     death = `잃은 전리품 가치` (`stats.peakLootValue` — the highest value carried in that raid, red).
 *   - The death cause row (death mode only, and only with `stats.death`): a square thumbnail on the left — for an enemy
 *     the `ctx.enemies.renderPortrait` face (drawn on the next frame so the screen comes up first · a fallback icon when
 *     it cannot be drawn), otherwise the cause icon (SVG, procedural) — the small name at the top right, the big number
 *     below it = the damage taken from that cause (for an enemy, **that one body**). With an unknown cause the row hides.
 * The kill · crates opened · damage taken cells are gone. Styles live in `styles/results.css` (prefix `.rs-`).
 *
 * **2026-09-21 (paged result screen, user's decision):** this is page ① of `results/ResultBody`. An extraction shows two
 * rows — `이번 레이드 획득` (`stats.raidFoundValue`, what was found in this raid and is carried out) above the `전리품 가치`
 * total (`stats.lootValue`); the found row hides when a producer does not send the field. The count-up starts on
 * `enter()` (the page being shown), `finish()` snaps it to the end (the player pressed `다음` early).
 */

export type ResultMode = 'extract' | 'death';

export interface ResultHeader {
  row: HTMLElement;
  title: HTMLElement;
  time: HTMLElement;
}

/** The title row — title left, mission time right. `.title` is the row's first `.title` (that is how the smokes find it). */
export function buildResultHeader(parent: HTMLElement, titleText: string, titleCls: string): ResultHeader {
  const row = el('div', { cls: 'rs-titlerow', parent });
  const title = el('div', { cls: `title ${titleCls}`, text: titleText, parent: row });
  const box = el('div', { cls: 'rs-time', parent: row });
  el('span', { cls: 'ui-label', text: '임무 시간', parent: box });
  const time = el('span', { cls: 'rs-time-v', text: '00:00', parent: box });
  return { row, title, time };
}

export interface PlanetLine {
  row: HTMLElement;
  value: HTMLElement;
}

/**
 * The planet row (2026-09-15, user's decision) — both result windows use the same look. Two pieces spread by a gap
 * instead of a middle dot: a grey `행성` label (`.rs-planet-k`, the dropped subtitle's 12px) + a slightly larger white
 * name (`.rs-planet-v`). `.planet-line` stays, as the contract says (the smokes find the row by that name). The name is
 * filled by `planetLabel`, which returns `PLANET_NONE_LABEL` (`목표 미지정`) even with no planet, so the row **cannot be
 * empty** — there is no hiding branch.
 */
export function buildPlanetLine(parent: HTMLElement): PlanetLine {
  const row = el('div', { cls: 'planet-line rs-planet', parent });
  el('span', { cls: 'rs-planet-k', text: '행성', parent: row });
  const value = el('span', { cls: 'rs-planet-v', text: '', parent: row });
  return { row, value };
}

const LOOT_DELAY = 0.4;   // before the count-up starts (after the frame's entry animation)
const LOOT_DUR = 1.6;     // length of the count-up
/** The thumbnail's CSS size (px) — the same value as `results.css` `.rs-cause-thumb`. It is drawn at × devicePixelRatio (2 at most). */
const THUMB_CSS_PX = 72;

/* ── Cause icons (24×24 line drawings, currentColor) ───────────────────────────────────── */
const ICON_PATHS: Readonly<Record<string, string>> = {
  // An enemy (when the face could not be drawn) — a helmeted head
  enemy: '<path d="M5 12a7 7 0 0 1 14 0v3.5l-2 1.2V20h-3v-2h-4v2H7v-3.3l-2-1.2z"/><path d="M8.5 11.5h2.5M13 11.5h2.5"/>',
  // A fall — a down arrow and the ground
  fall: '<path d="M12 3v11"/><path d="M7.5 10l4.5 4.5 4.5-4.5"/><path d="M3.5 20.5h17"/><path d="M6 20.5l1.5-2.5M18 20.5l-1.5-2.5"/>',
  // A storm — cloud and lightning
  storm: '<path d="M7 16.5a4.2 4.2 0 0 1-.4-8.4A5.6 5.6 0 0 1 17.3 8a3.8 3.8 0 0 1 .4 7.6"/><path d="M12.8 12.5l-2.6 4h3.2l-2.2 4"/>',
  // Toxic spores — scattered grains
  spores: '<circle cx="12" cy="12.5" r="2.4"/><circle cx="6" cy="8" r="1.5"/><circle cx="17.5" cy="6.5" r="1.7"/><circle cx="6.5" cy="17.5" r="1.7"/><circle cx="17.5" cy="17" r="1.3"/><circle cx="12" cy="4.5" r="1"/>',
  // The planet environment — a planet and heat
  env: '<circle cx="12" cy="14.5" r="5.5"/><path d="M6.5 14.5c3 1.4 8 1.4 11 0"/><path d="M8 2.5c1 1-1 2 0 3.2M12 2c1 1-1 2 0 3.2M16 2.5c1 1-1 2 0 3.2"/>',
  // An explosion — a star-shaped burst
  explosion: '<path d="M12 2.5l1.8 5.3 5-2.6-2.6 5 5.3 1.8-5.3 1.8 2.6 5-5-2.6-1.8 5.3-1.8-5.3-5 2.6 2.6-5-5.3-1.8 5.3-1.8-2.6-5 5 2.6z"/>',
  // Your own explosive — a grenade
  self: '<circle cx="11" cy="14.5" r="6"/><path d="M9 8.8V6h4v2.8"/><path d="M13 6l3.5-2"/><path d="M18 7.5l2.2-.6M18.2 10.2l2 .6"/>',
  // An ally's explosive — a person and a burst
  ally: '<circle cx="8" cy="8" r="3"/><path d="M2.8 20.5a5.2 5.2 0 0 1 10.4 0"/><path d="M17.5 4.5l.9 2.6 2.5-1.2-1.2 2.5 2.6.9-2.6.9 1.2 2.5-2.5-1.2-.9 2.6-.9-2.6-2.5 1.2 1.2-2.5-2.6-.9 2.6-.9-1.2-2.5 2.5 1.2z"/>',
  // Anything else — a question mark
  other: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .8-1 1.5v.8"/><path d="M12 16.9v.3"/>',
};

function iconKeyOf(d: MissionDeathCause): string {
  if (d.kind === 'hazard') return d.hazard === 'spores' ? 'spores' : 'storm';
  return ICON_PATHS[d.kind] ? d.kind : 'other';
}

function iconSvg(key: string): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[key] ?? ICON_PATHS.other}</svg>`;
}

export class ResultReport {
  readonly root: HTMLElement;
  private foundRow: HTMLElement;
  private foundVal: HTMLElement;
  private lootRow: HTMLElement;
  private lootLabel: HTMLElement;
  private lootVal: HTMLElement;
  private causeRow: HTMLElement;
  private causeThumb: HTMLElement;
  private causeName: HTMLElement;
  private causeNum: HTMLElement;
  private ctx: GameContext | null = null;

  private mode: ResultMode = 'extract';
  private target = 0;
  private foundTarget = 0;
  private lastFound = '';
  private timer = 0;
  private counting = false;
  private lastText = '';
  /** The thumbnail request number — dropped if the result changes while the next frame's draw is pending. */
  private job = 0;

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'stats rs-stats', parent });

    this.foundRow = el('div', { cls: 'rs-loot rs-found', parent: this.root });
    el('span', { cls: 'ui-label rs-loot-label', text: '이번 레이드 획득', parent: this.foundRow });
    this.foundVal = el('span', { cls: 'rs-loot-v', text: formatCredits(0), parent: this.foundRow });
    this.foundRow.hidden = true;

    this.lootRow = el('div', { cls: 'rs-loot', parent: this.root });
    this.lootLabel = el('span', { cls: 'ui-label rs-loot-label', text: '전리품 가치', parent: this.lootRow });
    this.lootVal = el('span', { cls: 'rs-loot-v', text: formatCredits(0), parent: this.lootRow });

    this.causeRow = el('div', { cls: 'rs-cause', parent: this.root });
    this.causeRow.hidden = true;
    this.causeThumb = el('div', { cls: 'rs-cause-thumb', parent: this.causeRow });
    el('span', { cls: 'ui-label rs-cause-cap', text: '사망 원인', parent: this.causeRow });
    const text = el('div', { cls: 'rs-cause-text', parent: this.causeRow });
    this.causeName = el('div', { cls: 'rs-cause-name', parent: text });
    const dmg = el('div', { cls: 'rs-cause-dmg', parent: text });
    el('span', { cls: 'ui-label rs-cause-unit', text: '받은 피해', parent: dmg });
    this.causeNum = el('span', { cls: 'rs-cause-num', text: '0', parent: dmg });
  }

  bind(ctx: GameContext): void { this.ctx = ctx; }

  fill(s: MissionStats, mode: ResultMode): void {
    this.mode = mode;
    const dead = mode === 'death';
    toggleClass(this.lootRow, 'lost', dead);
    setText(this.lootLabel, dead ? '잃은 전리품 가치' : '전리품 가치');
    const raw = dead ? (s.peakLootValue ?? s.lootValue) : s.lootValue;
    this.target = Number.isFinite(raw) ? Math.max(0, raw) : 0;
    const found = s.raidFoundValue;
    const showFound = !dead && typeof found === 'number' && Number.isFinite(found);
    this.foundRow.hidden = !showFound;
    this.foundTarget = showFound ? Math.max(0, found) : 0;
    this.timer = 0;
    this.counting = false;
    this.lastText = formatCredits(0);
    this.lastFound = this.lastText;
    setText(this.lootVal, this.lastText);
    setText(this.foundVal, this.lastFound);
    this.fillCause(dead ? (s.death ?? null) : null);
  }

  private fillCause(d: MissionDeathCause | null): void {
    const job = ++this.job;
    this.causeRow.hidden = !d;
    if (!d) { this.causeThumb.replaceChildren(); return; }
    const enemy = d.kind === 'enemy';
    toggleClass(this.causeRow, 'is-enemy', enemy);
    this.causeRow.dataset.kind = d.kind;
    setText(this.causeName, d.label || '알 수 없는 원인');
    setText(this.causeNum, fmtInt(Math.max(0, d.damage)));
    this.causeThumb.innerHTML = iconSvg(iconKeyOf(d));
    if (!enemy || !d.enemyType) return;
    const type = d.enemyType;
    const label = d.label;
    const draw = (): void => {
      if (job !== this.job) return;
      const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
      const px = Math.round(THUMB_CSS_PX * Math.min(2, Math.max(1, dpr)));
      let url: string | null = null;
      try { url = this.ctx?.enemies?.renderPortrait?.(type, px) ?? null; } catch { url = null; }
      if (!url || job !== this.job) return;
      const img = document.createElement('img');
      img.alt = label;
      img.draggable = false;
      img.src = url;
      this.causeThumb.replaceChildren(img);
    };
    // Deferred by one frame — the first draw of a type can take tens of ms baking shaders, and the result window has to come up first.
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(draw);
    else draw();
  }

  /** The page is shown — start the count-up. */
  enter(): void { this.timer = 0; this.counting = true; }

  /** Snap the count-up to its end (the player moved on before it finished). */
  finish(): void {
    if (!this.counting) return;
    this.timer = LOOT_DELAY + LOOT_DUR;
    this.update(0);
  }

  update(dt: number): void {
    if (!this.counting) return;
    this.timer += dt;
    const t = Math.min(1, (this.timer - LOOT_DELAY) / LOOT_DUR);
    if (t < 0) return;
    const eased = 1 - Math.pow(1 - t, 3);
    const txt = formatCredits(this.target * eased);
    if (txt !== this.lastText) { this.lastText = txt; setText(this.lootVal, txt); }
    const ftxt = formatCredits(this.foundTarget * eased);
    if (ftxt !== this.lastFound) { this.lastFound = ftxt; setText(this.foundVal, ftxt); }
    if (t >= 1) {
      this.counting = false;
      if (this.mode === 'extract') this.ctx?.bus.emit('audio:play', { id: 'ui_equip' });
    }
  }

  stop(): void { this.counting = false; }

  /* ── debug ── */
  get lootText(): string { return this.lootVal.textContent ?? ''; }
  /** `이번 레이드 획득` value text, '' when that row is hidden. */
  get foundText(): string { return this.foundRow.hidden ? '' : (this.foundVal.textContent ?? ''); }
  get causeShown(): boolean { return !this.causeRow.hidden; }
  get isCounting(): boolean { return this.counting; }
}
