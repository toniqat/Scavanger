import type { CharBuff, CharBuffStripOptions, CharBuffStripView, GameContext, ItemDef } from '@/shared';
import {
  CHAR_BUFF_COLOR, CHAR_BUFF_GLYPH, ENV_COLOR, ENV_ICON,
  charBuffRemainingRatio, charBuffRemainingS, charBuffTitle,
} from '@/shared';
import { el, setText, toggleClass } from '../dom';
import { cookStepsText, mealEffectLines } from './mealText';
/* 2026-09-13 (the cooking minigame): the meal quality star badge */
import { getMealDef, normalizeMealQuality } from '@/shared';
/* 2026-09-13 (video games): the mode line of the gaming buff */
import { GYM_MINIGAME_LABEL_KO } from '@/shared';
/* 2026-09-17 (the character tab's buff thumbnails): progression's character sheet borrows this strip — the factory is registered in shared */
import { provideCharBuffStrip } from '@/shared';
import '../styles/buffs.css';

/** How often the time text · gauge is rewritten (UI timing, not balance). It only runs while a thumbnail with a timer shows. */
const TICK_MS = 1000;

/** One thumbnail as the smoke / debug getters read it back. */
export interface BuffCellState {
  key: string;
  kind: CharBuff['kind'];
  glyph: string;
  color: string;
  /** `state === 'pending'` → drawn dimmed. */
  dim: boolean;
  /** red frame. */
  debuff: boolean;
  /** 0…1 remaining ratio of the time gauge, null when the buff has no timer. */
  ratio: number | null;
  /** `23h` / `42m` / `35s`, empty without a timer. */
  time: string;
  title: string;
  /** appended (2026-09-13, meal quality): the star count of a `meal`'s quality (the badge), 0 when there is none. */
  quality: number;
}

interface Cell {
  root: HTMLElement;
  base: HTMLElement;
  lit: HTMLElement;
  reveal: HTMLElement;
  timeEl: HTMLElement;
  buff: CharBuff;
  glyph: string;
  color: string;
  ratio: number | null;
  /** `--r` as last written (rounded). */
  rs: string;
  time: string;
  /** `charBuffTitle` as-is (read by `state` · the smoke test). For a meal, the DOM `title` gets the stat lines appended to this. */
  title: string;
}

/**
 * **The character buff thumbnail strip (2026-09-12, user's decision — `docs/DECISIONS.md` 「2026-09-12 — 캐릭터 버프」).** It lays one character's
 * `CharBuff[]` out as small square thumbnails. Under the PC hp bar (`hud/Vitals`) and the squadmate rows of the bottom-left squad list
 * (`hud/Squad`) use **the same component** — only the size differs, through `mini`. The list is collected by player (mine) · net (a squadmate's),
 * and this file draws the list it is handed **as-is** (the owner already sorted it by `CHAR_BUFF_ORDER`).
 *
 *   - glyph · colour: `meal` · `prep` · `adrenaline` · `stimulant` = the item def's `icon` · `color` (`ctx.loot.getItemDef`), `env_exposed` = `ENV_ICON` · `ENV_COLOR`,
 *     with none found, `CHAR_BUFF_GLYPH` · `CHAR_BUFF_COLOR`.
 *   - `pending` (loaded in the ship for the next raid) = dimmed (`.is-pending`), a debuff = a red border (`.is-debuff`).
 *   - with a timer (`startedAt` · `endsAt`), a **time gauge** — the same two-face technique as the implant thumbnail (`styles/implant.css`):
 *     a bright copy is revealed from the bottom over the dim base face, only as far as `charBuffRemainingRatio`, so as the remaining time falls the
 *     light **drains from the top down**. The remaining time sits very small at the bottom right (`23h` · `42m` · `35s`).
 *   - `title` = `charBuffTitle` (meal · preparation names from the item def). 2026-09-13 (cooking material tiers): for a **meal**, every stat line is
 *     appended one per line under the DOM `title` (`hud/mealText.mealEffectLines` — a higher meal has 2–4). `state[].title` stays `charBuffTitle` as-is.
 *   - 2026-09-13 (the cooking minigame): **meal quality** — with a `quality` on the `meal`, a small gold star badge at the top left (`data-q` = `★3`; mini shows one star —
 *     the `::after` in `styles/buffs.css`), and the stat lines in the DOM `title` are **the numbers with the bonus folded in** (the star after the name is added by `charBuffTitle`).
 *     **`cooking`** (a cook in progress) keeps the contract's `CHAR_BUFF_GLYPH` · `CHAR_BUFF_COLOR` (using the glyph of the meal being made would be confused with the meal buff),
 *     and its `title` appends that meal's step line `① 썰기 → ② 젓기` (`cookStepsText`) under `조리 중 · <요리>`.
 *
 * `set(list)` compares **by reference** (`PlayerRef.buffs` · `RemotePlayerRef.buffs` are a new array only on change) — the same array does
 * nothing. Thumbnail DOM is reused by `key`, and only vanished keys are taken off. `update()` may be called every frame (or at the squad list's
 * 10 Hz) and rewrites the gauge · text once a second only while a timed thumbnail exists. The clock is `ctx.net.serverNow() ?? Date.now()` —
 * the same clock as the player that stamped the list's times.
 */
export class BuffStrip implements CharBuffStripView {
  readonly root: HTMLElement;
  private cells = new Map<string, Cell>();
  private list: readonly CharBuff[] | null = null;
  private timed = false;
  private nextTickAt = 0;
  /**
   * 2026-09-17 (user's decision 「캐릭터 탭 이름 옆 썸네일, 호버하면 툴팁」): the thumbnails take the mouse (`.is-interactive`) and each cell
   * stamps the shared text-card attributes (`data-tip-name` the name · `-sub` buff/debuff · remaining time · `-desc` stats · step line · `-color`) — `hud/ItemTip` draws it.
   * A native `title` does not appear over the in-game cursor, so it is not attached in this mode. The HUD's strip is false (`pointer-events: none`).
   */
  private readonly interactive: boolean;

  constructor(parent: HTMLElement, opts: CharBuffStripOptions = {}) {
    this.root = el('div', { cls: opts.mini ? 'bfs is-mini' : 'bfs', parent });
    this.interactive = !!opts.interactive;
    if (this.interactive) this.root.classList.add('is-interactive');
  }

  /** Install a new list (same reference = no-op). `null` / empty clears the strip. */
  set(list: readonly CharBuff[] | null | undefined, ctx: GameContext | null): void {
    const next = list && list.length > 0 ? list : null;
    if (next === this.list) return;
    this.list = next;
    const seen = new Set<string>();
    let timed = false;
    if (next) {
      let i = 0;
      for (const b of next) {
        if (!b || typeof b.key !== 'string' || seen.has(b.key)) continue;
        seen.add(b.key);
        const cell = this.cells.get(b.key) ?? this.makeCell(b.key);
        this.paintCell(cell, b, ctx);
        // keep DOM order = list order without re-appending cells that are already in place
        if (this.root.children[i] !== cell.root) this.root.insertBefore(cell.root, this.root.children[i] ?? null);
        i++;
        if (typeof b.endsAt === 'number' && typeof b.startedAt === 'number') timed = true;
      }
    }
    for (const [key, cell] of this.cells) {
      if (seen.has(key)) continue;
      cell.root.remove();
      this.cells.delete(key);
    }
    this.timed = timed;
    this.nextTickAt = 0;
    toggleClass(this.root, 'has-items', seen.size > 0);
    if (timed) this.tick(ctx);
  }

  /** Per frame (or per squad refresh): re-writes the time gauges once a second while a timed buff is shown. */
  update(ctx: GameContext | null): void {
    if (!this.timed) return;
    const t = performance.now();
    if (t < this.nextTickAt) return;
    this.tick(ctx);
  }

  /** Rendered thumbnails in DOM order (debug / smoke). */
  get state(): BuffCellState[] {
    const out: BuffCellState[] = [];
    for (const node of Array.from(this.root.children)) {
      const key = (node as HTMLElement).dataset.key;
      const c = key !== undefined ? this.cells.get(key) : undefined;
      if (!c) continue;
      out.push({
        key: c.buff.key, kind: c.buff.kind, glyph: c.glyph, color: c.color,
        dim: c.root.classList.contains('is-pending'), debuff: c.root.classList.contains('is-debuff'),
        ratio: c.ratio, time: c.time, title: c.title,
        quality: c.buff.kind === 'meal' ? normalizeMealQuality(c.buff.quality) : 0,
      });
    }
    return out;
  }

  get count(): number { return this.cells.size; }

  dispose(): void { this.cells.clear(); this.root.remove(); }

  private makeCell(key: string): Cell {
    const root = el('div', { cls: 'bfs-cell' });
    root.dataset.key = key;
    const base = el('span', { cls: 'bfs-face', parent: root });
    const reveal = el('span', { cls: 'bfs-reveal', parent: root });
    const lit = el('span', { cls: 'bfs-face lit', parent: reveal });
    const timeEl = el('span', { cls: 'bfs-t ui-mono', text: '', parent: root });
    const cell: Cell = { root, base, lit, reveal, timeEl, buff: { kind: 'rest', key, debuff: false, state: 'active' }, glyph: '', color: '', ratio: null, rs: '', time: '', title: '' };
    this.cells.set(key, cell);
    return cell;
  }

  private paintCell(cell: Cell, b: CharBuff, ctx: GameContext | null): void {
    cell.buff = b;
    // 2026-09-12: combat consumables (adrenaline · stimulant) use their item's glyph · colour too
    const itemKind = b.kind === 'meal' || b.kind === 'prep' || b.kind === 'adrenaline' || b.kind === 'stimulant';
    const def = itemKind && b.defId ? defOf(ctx, b.defId) : undefined;
    let glyph: string = CHAR_BUFF_GLYPH[b.kind] ?? '•';
    let color: string = CHAR_BUFF_COLOR[b.kind] ?? 'var(--c-text-dim)';
    if (def) { glyph = def.icon || glyph; color = def.color || color; }
    else if (b.kind === 'env_exposed' && b.env) { glyph = ENV_ICON[b.env] ?? glyph; color = ENV_COLOR[b.env] ?? color; }
    if (glyph !== cell.glyph) { cell.glyph = glyph; setText(cell.base, glyph); setText(cell.lit, glyph); }
    if (color !== cell.color) { cell.color = color; cell.root.style.setProperty('--bc', color); }
    toggleClass(cell.root, 'is-pending', b.state === 'pending');
    toggleClass(cell.root, 'is-debuff', !!b.debuff);
    const hasTimer = typeof b.endsAt === 'number' && typeof b.startedAt === 'number';
    toggleClass(cell.root, 'is-timed', hasTimer);
    let title = '';
    try { title = charBuffTitle(b, (id) => defOf(ctx, id)); } catch { title = b.key; }
    cell.title = title;
    // 2026-09-13: one meal buff carries several stat lines — they are appended one per line so hovering shows them all (with a meal quality, the bonus is folded in)
    const quality = b.kind === 'meal' ? normalizeMealQuality(b.quality) : 0;
    let lines: string[] = [];
    if (b.kind === 'meal' && def?.meal) lines = mealEffectLines(def.meal, quality);
    else if (b.kind === 'cooking' && b.defId) { const steps = cookStepsText(b.defId); if (steps) lines = [steps]; }
    else if (b.kind === 'gaming' && (b.stat || b.minigame)) {
      // 2026-09-13 (video games): which stat the game trains — `지능 단련 · 호흡 달리기`
      let statName = '';
      if (b.stat) { try { statName = ctx?.progression?.getStatDef(b.stat)?.name ?? ''; } catch { statName = ''; } }
      const parts = [statName ? `${statName} 단련` : '', b.minigame ? GYM_MINIGAME_LABEL_KO[b.minigame] : ''].filter(Boolean);
      if (parts.length) lines = [parts.join(' · ')];
    }
    if (this.interactive) {
      const d = cell.root.dataset;
      if (d.tipName !== title) d.tipName = title;
      const desc = lines.join(' · ');
      if ((d.tipDesc ?? '') !== desc) { if (desc) d.tipDesc = desc; else delete d.tipDesc; }
      if (d.tipColor !== color) d.tipColor = color;
      if (!hasTimer) this.writeTipSub(cell, '');
    } else {
      const domTitle = lines.length > 0 ? `${title}\n${lines.join('\n')}` : title;
      if (cell.root.title !== domTitle) cell.root.title = domTitle;
    }
    // 2026-09-13 (meal quality): the top-left star badge — the text comes from CSS `::after { content: attr(data-q) }`
    const q = quality > 0 ? `★${quality}` : '';
    if ((cell.root.dataset.q ?? '') !== q) { if (q) cell.root.dataset.q = q; else delete cell.root.dataset.q; }
    cell.root.dataset.kind = b.kind;
    if (!hasTimer) this.writeGauge(cell, null, '');
  }

  private tick(ctx: GameContext | null): void {
    this.nextTickAt = performance.now() + TICK_MS;
    const now = nowMs(ctx);
    for (const cell of this.cells.values()) {
      const b = cell.buff;
      const ratio = charBuffRemainingRatio(b, now);
      if (ratio === null) continue;
      this.writeGauge(cell, ratio, formatRemaining(charBuffRemainingS(b, now) ?? 0));
    }
  }

  private writeGauge(cell: Cell, ratio: number | null, time: string): void {
    const r = ratio === null ? null : Math.min(1, Math.max(0, ratio));
    cell.ratio = r;
    const rs = (r ?? 1).toFixed(3);
    if (cell.rs !== rs) { cell.rs = rs; cell.root.style.setProperty('--r', rs); }
    if (cell.time !== time) { cell.time = time; setText(cell.timeEl, time); }
    if (this.interactive && ratio !== null) this.writeTipSub(cell, time);
  }

  /** The text card's second line: `디버프` / `버프` (· `남은 23h`). For a loaded one the name already says `· 다음 레이드`. */
  private writeTipSub(cell: Cell, time: string): void {
    const sub = `${cell.buff.debuff ? '디버프' : '버프'}${time ? ` · 남은 ${time}` : ''}`;
    if (cell.root.dataset.tipSub !== sub) cell.root.dataset.tipSub = sub;
  }
}

function defOf(ctx: GameContext | null, defId: string): ItemDef | undefined {
  if (!ctx) return undefined;
  // 2026-09-16 (the plate model): a meal is not an item — a meal id `ctx.loot` does not know is looked up in the meal table (`shared/meals`)
  try { return ctx.loot?.getItemDef(defId) ?? ctx.inventory?.getDef(defId) ?? getMealDef(defId); } catch { return undefined; }
}

/** The clock the buff list was stamped with (`player` / `progression` use the same one). */
function nowMs(ctx: GameContext | null): number {
  try {
    const n = ctx?.net?.serverNow?.();
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) return n;
  } catch { /* offline */ }
  return Date.now();
}

/** `23h` · `42m` · `35s` — whole hours / minutes (floor), seconds rounded up so the last second reads `1s`. */
export function formatRemaining(sec: number): string {
  const s = Math.max(0, sec);
  if (s >= 3600) return `${Math.floor(s / 3600)}h`;
  if (s >= 60) return `${Math.floor(s / 60)}m`;
  return `${Math.ceil(s)}s`;
}

/* 2026-09-17: the character sheet (progression) gets the same strip through `createCharBuffStrip` — registered in shared, with no cross-folder import */
provideCharBuffStrip((parent, opts) => new BuffStrip(parent, opts));
