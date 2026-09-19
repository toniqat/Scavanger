/**
 * src/housing/ui/cook/CookViews.ts — the **stages** (`.cook-stage`) of the six cooking minigames. It only draws the judge object (`parts/CookGames`).
 *
 * The DOM is built once, at construction, and every tick `paint()` rewrites only CSS variables (`--x` · `--f` · `--p` · `--t` · `--lvl` · `--flow`) and classes.
 * No external assets — the ingredients are the shared item chips (`buildItemChip`), and the board · knife · grill · pan · pot · beaker are CSS shapes.
 * 2026-09-14 (user's decision 「what you see is the judgement」): the drawn sizes are **derived from the judgement values** — the chopping lane's
 * perfect · good bands and marker width from `ChopGame.bands`, stir-frying's guide ring from `StirfryGame.bands`, and the grilling ring's arcs from
 * `COOK_GRILL_*_PERFECT` · `_GOOD`. Fixing the csv makes the drawing follow by itself, so 「what is drawn differs from the judgement」 cannot happen.
 *
 *   • chopping    = the ingredient on the board + the knife (it comes down on every cut) + the cut slices + beat markers flowing in from the right to the judgement line.
 *   • mincing     = a left · right vertical gauge (left-right LMB · up-down RMB) + the minced bits on the board (one per click) + the time taken.
 *   • grilling    = 2–3 pieces on the grill — a progress ring (0 … `BURN_AT`, ticks at 50 % · 100 %) · a flipped mark · darker as it cooks, black once burnt. The pieces are the click targets.
 *   • stir-frying = the pan (the ingredient chips toss) + a ring shrinking on every beat + the percentage bar.
 *   • stirring    = the pot (the ladle turns while held · bubbles with the temperature) + a vertical thermometer (the green band) + the doneness bar.
 *   • pouring     = the measuring beaker in the centre (target line · liquid height · liquid colour) + the tilting jug at the top right + the stream (thickness = flow).
 */
import type { CookJudge, CookBeatAction, ItemDef } from '@/shared';
import {
  COOK_GRILL_BURN_AT, COOK_GRILL_DONE_GOOD, COOK_GRILL_DONE_PERFECT, COOK_GRILL_FLIP_GOOD, COOK_GRILL_FLIP_PERFECT,
  COOK_LEAD_BEATS, COOK_LIQUID_COLOR, COOK_LIQUID_LABEL_KO, COOK_MINCE_PERFECT_S, COOK_MINCE_ZERO_S,
  COOK_STIR_BAND_HIGH, COOK_STIR_BAND_LOW, buildItemChip, createKeycap,
} from '@/shared';
import { ChopGame, GrillGame, MinceGame, PourGame, StirGame, StirfryGame } from '../../parts/CookGames';
import type { AnyCookGame, CookButton } from '../../parts/CookGames';
import { el, setText, toggleClass } from '../dom';

export interface CookView {
  readonly root: HTMLElement;
  paint(): void;
  judged(quality: CookJudge, index: number): void;
  beat(action: CookBeatAction, quality: CookJudge | null): void;
  input(button: CookButton, down: boolean): void;
  dispose(): void;
}

type DefOf = (defId: string) => ItemDef | undefined;

const QUALITY_CLASSES = ['is-perfect', 'is-good', 'is-miss'];
/** The cap on how many bits are piled up on the mincing board (drawing only, nothing to do with the judgement). */
const MINCE_BITS_MAX = 28;
/** The size of the ingredient chips drawn in the stir-fry pan · on the board (px, layout values). */
const PAN_CHIP = 34;
const BOARD_CHIP = 52;
const GRILL_CHIP = 40;

/** Restarts a one-shot CSS animation from the beginning. */
export function replayCookClass(e: HTMLElement, cls: string): void {
  e.classList.remove(cls);
  void e.offsetWidth;
  e.classList.add(cls);
}

function setQuality(e: HTMLElement, q: CookJudge | null): void {
  const want = q ? `is-${q}` : '';
  for (const c of QUALITY_CLASSES) toggleClass(e, c, c === want);
}

function setVar(e: HTMLElement, name: string, value: string, cache: Map<HTMLElement, Map<string, string>>): void {
  let m = cache.get(e);
  if (!m) { m = new Map(); cache.set(e, m); }
  if (m.get(name) === value) return;
  m.set(name, value);
  e.style.setProperty(name, value);
}

function chip(parent: HTMLElement, def: ItemDef | undefined, size: number, cls: string): HTMLElement {
  const wrap = el('div', { cls, parent });
  wrap.appendChild(buildItemChip(def, { size }));
  return wrap;
}

const pct = (v: number): number => Math.round(Math.max(0, Math.min(1, v)) * 100);

abstract class BaseView implements CookView {
  readonly root: HTMLElement;
  protected readonly vars = new Map<HTMLElement, Map<string, string>>();
  constructor(parent: HTMLElement, kind: string) {
    this.root = el('div', { cls: `cook-stage cook-${kind}`, parent });
  }
  protected setVar(e: HTMLElement, name: string, value: string): void { setVar(e, name, value, this.vars); }
  abstract paint(): void;
  judged(_q: CookJudge, _i: number): void { /* per game */ }
  beat(_a: CookBeatAction, _q: CookJudge | null): void { /* per game */ }
  input(_b: CookButton, _down: boolean): void { /* per game */ }
  dispose(): void { this.root.remove(); }
}

/* ── Chopping ────────────────────────────────────────────────────────────── */
class ChopView extends BaseView {
  private readonly board: HTMLElement;
  private readonly knife: HTMLElement;
  private readonly slices: HTMLElement;
  private readonly lane: HTMLElement;
  private readonly notes: Array<{ el: HTMLElement; q: CookJudge | null; off: boolean }> = [];
  private readonly look: number;

  constructor(private readonly g: ChopGame, parent: HTMLElement, defOf: DefOf) {
    super(parent, 'chop');
    this.board = el('div', { cls: 'cook-board', parent: this.root });
    chip(this.board, defOf(g.step.items[0] ?? ''), BOARD_CHIP, 'cook-food');
    this.slices = el('div', { cls: 'cook-slices', parent: this.board });
    this.knife = el('i', { cls: 'cook-knife', parent: this.board });
    const track = el('div', { cls: 'cook-track', parent: this.root });
    this.lane = el('div', { cls: 'cook-lane', parent: track });
    this.look = g.beatS * (COOK_LEAD_BEATS + 1);
    // 2026-09-14 (user's decision 「what you see is the judgement」): the band · marker widths come from the judgement values (`g.bands`) — a marker covering the perfect band is perfect
    const half = (g.bands.perfect / this.look).toFixed(4);
    this.lane.style.setProperty('--half', half);
    this.lane.style.setProperty('--good-half', (g.bands.good / this.look).toFixed(4));
    el('i', { cls: 'cook-window is-good', parent: this.lane });
    el('i', { cls: 'cook-window is-perfect', parent: this.lane });
    el('i', { cls: 'cook-judge', parent: this.lane });
    for (let i = 0; i < g.notes.length; i++) {
      const e = el('div', { cls: 'cook-note', parent: this.lane });
      e.style.setProperty('--span', half);
      this.notes.push({ el: e, q: null, off: false });
    }
    this.paint();
  }

  paint(): void {
    const t = this.g.time;
    const next = this.g.upcoming;
    this.g.notes.forEach((n, i) => {
      const ne = this.notes[i];
      const x = (n.t - t) / this.look;
      const off = x < -0.12 || x > 1.02;
      if (off !== ne.off) { ne.off = off; toggleClass(ne.el, 'is-off', off); }
      if (off) return;
      this.setVar(ne.el, '--x', x.toFixed(4));
      if (ne.q !== n.q) { ne.q = n.q; setQuality(ne.el, n.q); }
      toggleClass(ne.el, 'is-next', n === next);
    });
  }

  beat(action: CookBeatAction, q: CookJudge | null): void {
    if (action !== 'cut') return;
    replayCookClass(this.knife, 'is-cut');
    if (q && q !== 'miss') el('i', { cls: `cook-slice is-${q}`, parent: this.slices });
    replayCookClass(this.lane, `hit-${q ?? 'miss'}`);
  }
}

/* ── Mincing ─────────────────────────────────────────────────────────────── */
class MinceView extends BaseView {
  private readonly gh: HTMLElement;
  private readonly gv: HTMLElement;
  private readonly bits: HTMLElement;
  private readonly clock: HTMLElement;
  private readonly knife: HTMLElement;
  private bitCount = 0;

  constructor(private readonly g: MinceGame, parent: HTMLElement, defOf: DefOf) {
    super(parent, 'mince');
    this.gh = this.gauge('좌우', 'Mouse0');
    const board = el('div', { cls: 'cook-board', parent: this.root });
    chip(board, defOf(g.step.items[0] ?? ''), BOARD_CHIP, 'cook-food');
    this.bits = el('div', { cls: 'cook-bits', parent: board });
    this.knife = el('i', { cls: 'cook-knife cook-cleaver', parent: board });
    this.clock = el('div', { cls: 'cook-clock', parent: board });
    this.gv = this.gauge('상하', 'Mouse2');
    this.paint();
  }

  /** `code` = the mouse button that fills that gauge (2026-09-15: the shared keycap's mouse glyph — formerly the text `LMB` · `RMB`). */
  private gauge(label: string, code: string): HTMLElement {
    const box = el('div', { cls: 'cook-gauge', parent: this.root });
    const bar = el('div', { cls: 'cook-gauge-bar', parent: box });
    el('i', { cls: 'cook-gauge-fill', parent: bar });
    const cap = el('div', { cls: 'cook-gauge-cap', parent: box });
    createKeycap(code, { cls: 'cook-gauge-key', parent: cap });
    el('span', { text: label, parent: cap });
    return box;
  }

  paint(): void {
    this.setVar(this.gh, '--f', this.g.h.toFixed(3));
    this.setVar(this.gv, '--f', this.g.v.toFixed(3));
    toggleClass(this.gh, 'is-full', this.g.h >= 1);
    toggleClass(this.gv, 'is-full', this.g.v >= 1);
    const t = this.g.doneAt ?? this.g.time;
    setText(this.clock, `${t.toFixed(1)} 초`);
    toggleClass(this.clock, 'is-slow', t > COOK_MINCE_PERFECT_S);
    toggleClass(this.clock, 'is-late', t >= COOK_MINCE_ZERO_S);
  }

  beat(action: CookBeatAction): void {
    if (action !== 'mince_h' && action !== 'mince_v') return;
    replayCookClass(this.knife, action === 'mince_h' ? 'is-chop-h' : 'is-chop-v');
    replayCookClass(action === 'mince_h' ? this.gh : this.gv, 'is-hit');
    if (this.bitCount >= MINCE_BITS_MAX) return;
    // a bit's spot is a deterministic position derived from its number (drawing only — no randomness needed)
    const k = this.bitCount++;
    const b = el('i', { cls: 'cook-bit', parent: this.bits });
    b.style.setProperty('--bx', `${(((k * 37) % 80) + 10).toFixed(0)}%`);
    b.style.setProperty('--by', `${(((k * 53) % 70) + 15).toFixed(0)}%`);
    b.style.setProperty('--br', `${(k * 47) % 180}deg`);
  }

  input(button: CookButton, down: boolean): void {
    toggleClass(button === 'left' ? this.gh : this.gv, 'is-down', down);
  }
}

/* ── Grilling ────────────────────────────────────────────────────────────── */
/**
 * A judgement arc on the progress ring (2026-09-14) — progress `at` (0.5 flip · 1 remove) ± `half`, mapped onto angles where one full turn = `burn`.
 * Its width is exactly `COOK_GRILL_*_PERFECT` · `_GOOD`, so what the eye sees is the judgement.
 */
function arc(ring: HTMLElement, cls: string, at: number, half: number, burn: number): void {
  const a0 = Math.max(0, (at - half) / burn), a1 = Math.min(1, (at + half) / burn);
  const e = el('i', { cls: `cook-arc ${cls}`, parent: ring });
  e.style.setProperty('--a0', `${a0.toFixed(4)}turn`);
  e.style.setProperty('--a1', `${a1.toFixed(4)}turn`);
}

class GrillView extends BaseView {
  private readonly pieces: Array<{ el: HTMLElement; label: HTMLElement; pct: HTMLElement; flipQ: CookJudge | null; doneQ: CookJudge | null }> = [];

  constructor(private readonly g: GrillGame, parent: HTMLElement, defOf: DefOf) {
    super(parent, 'grill');
    const plate = el('div', { cls: 'cook-grillplate', parent: this.root });
    g.pieces.forEach((p, i) => {
      const e = el('div', { cls: 'cook-piece is-waiting', attrs: { 'data-i': String(i) }, parent: plate });
      const ring = el('div', { cls: 'cook-ring', parent: e });
      // ticks at 50 % · 100 % — one turn of the ring is 0 … BURN_AT
      const burn = Math.max(1, COOK_GRILL_BURN_AT);
      // 2026-09-14 (user's decision 「what you see is the judgement」): arcs **exactly as wide as the judgement** are laid beside the ticks (good below · perfect above)
      arc(ring, 'is-good', 0.5, COOK_GRILL_FLIP_GOOD, burn);
      arc(ring, 'is-perfect', 0.5, COOK_GRILL_FLIP_PERFECT, burn);
      arc(ring, 'is-good', 1, COOK_GRILL_DONE_GOOD, burn);
      arc(ring, 'is-perfect', 1, COOK_GRILL_DONE_PERFECT, burn);
      el('i', { cls: 'cook-tick is-flip', parent: ring }).style.setProperty('--a', `${(0.5 / burn).toFixed(4)}turn`);
      el('i', { cls: 'cook-tick is-done', parent: ring }).style.setProperty('--a', `${(1 / burn).toFixed(4)}turn`);
      chip(ring, defOf(p.defId), GRILL_CHIP, 'cook-piece-food');
      el('i', { cls: 'cook-flipmark', text: '⟲', parent: e });
      const pctEl = el('div', { cls: 'cook-piece-pct', parent: e });
      const label = el('div', { cls: 'cook-piece-label', parent: e });
      this.pieces.push({ el: e, label, pct: pctEl, flipQ: null, doneQ: null });
    });
    this.paint();
  }

  paint(): void {
    const burn = Math.max(1, COOK_GRILL_BURN_AT);
    this.g.pieces.forEach((p, i) => {
      const v = this.pieces[i];
      const prog = this.g.progressOf(i);
      toggleClass(v.el, 'is-waiting', this.g.time < p.start && !p.removed);
      toggleClass(v.el, 'is-flipped', p.flipped);
      toggleClass(v.el, 'is-removed', p.removed);
      toggleClass(v.el, 'is-burned', p.burned);
      toggleClass(v.el, 'is-hot', !p.removed && prog >= 1 + (burn - 1) * 0.5);
      if (!p.removed) {
        this.setVar(v.el, '--p', Math.min(1, prog / burn).toFixed(4));
        this.setVar(v.el, '--cook', Math.min(1, prog).toFixed(3));
      }
      if (v.flipQ !== p.flipQ || v.doneQ !== p.doneQ) {
        v.flipQ = p.flipQ;
        v.doneQ = p.doneQ;
        const parts: string[] = [];
        if (p.flipQ) parts.push(`뒤집기 ${JUDGE_KO[p.flipQ]}`);
        if (p.doneQ) parts.push(p.burned ? '탔습니다' : `꺼내기 ${JUDGE_KO[p.doneQ]}`);
        setText(v.label, parts.join(' · '));
        setQuality(v.label, p.doneQ ?? p.flipQ);
      }
      if (!p.removed) setText(v.pct, `${Math.round(prog * 100)} %`);
    });
  }

  beat(action: CookBeatAction, _q: CookJudge | null): void {
    if (action === 'flip' || action === 'remove' || action === 'burn') replayCookClass(this.root, `hit-${action}`);
  }
}

const JUDGE_KO: Readonly<Record<CookJudge, string>> = { perfect: '완벽', good: '좋음', miss: '실패' };

/* ── Stir-frying ─────────────────────────────────────────────────────────── */
class StirfryView extends BaseView {
  private readonly pan: HTMLElement;
  private readonly ring: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly barText: HTMLElement;

  constructor(private readonly g: StirfryGame, parent: HTMLElement, defOf: DefOf) {
    super(parent, 'stirfry');
    const stove = el('div', { cls: 'cook-stove', parent: this.root });
    // 2026-09-14 (user's decision 「what you see is the judgement」): perfect once the ring comes inside this guide ring — its radius comes from the judgement band
    const guide = el('i', { cls: 'cook-beatguide', parent: stove });
    guide.style.setProperty('--s', (1 + g.bands.perfect / Math.max(1e-6, g.beatS)).toFixed(3));
    const guideGood = el('i', { cls: 'cook-beatguide is-good', parent: stove });
    guideGood.style.setProperty('--s', (1 + g.bands.good / Math.max(1e-6, g.beatS)).toFixed(3));
    this.ring = el('i', { cls: 'cook-beatring', parent: stove });
    this.pan = el('div', { cls: 'cook-pan', parent: stove });
    const foods = el('div', { cls: 'cook-pan-foods', parent: this.pan });
    for (const id of g.step.items) chip(foods, defOf(id), PAN_CHIP, 'cook-pan-food');
    el('i', { cls: 'cook-pan-handle', parent: stove });
    const side = el('div', { cls: 'cook-side', parent: this.root });
    el('div', { cls: 'cook-side-label', text: '볶음 정도', parent: side });
    this.bar = el('div', { cls: 'cook-hbar', parent: side });
    el('i', { cls: 'cook-hbar-fill', parent: this.bar });
    this.barText = el('div', { cls: 'cook-side-num', parent: side });
    this.paint();
  }

  paint(): void {
    const beats = this.g.time / Math.max(1e-6, this.g.beatS);
    const frac = beats - Math.floor(beats);
    const lead = beats < COOK_LEAD_BEATS - 0.5;
    // the closer the beat, the further the ring shrinks toward the pan's rim (1) — 1 at the beat, 2 just after it
    this.setVar(this.ring, '--s', (1 + (1 - frac)).toFixed(3));
    toggleClass(this.ring, 'is-lead', lead);
    toggleClass(this.ring, 'is-used', this.g.usedBeats.has(this.g.nearestBeat()));
    this.setVar(this.bar, '--f', this.g.bar.toFixed(3));
    setText(this.barText, `${pct(this.g.bar)} %`);
  }

  beat(action: CookBeatAction, q: CookJudge | null): void {
    if (action !== 'toss') return;
    replayCookClass(this.pan, 'is-toss');
    replayCookClass(this.bar, `hit-${q ?? 'miss'}`);
  }
}

/* ── Stirring ────────────────────────────────────────────────────────────── */
class StirView extends BaseView {
  private readonly pot: HTMLElement;
  private readonly thermo: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly ratioText: HTMLElement;

  constructor(private readonly g: StirGame, parent: HTMLElement) {
    super(parent, 'stir');
    this.pot = el('div', { cls: 'cook-pot', parent: this.root });
    const soup = el('div', { cls: 'cook-soup', parent: this.pot });
    for (let i = 0; i < 6; i++) el('i', { cls: 'cook-bubble', parent: soup }).style.setProperty('--i', String(i));
    el('i', { cls: 'cook-ladle', parent: this.pot });
    this.thermo = el('div', { cls: 'cook-thermo', parent: this.root });
    const tube = el('div', { cls: 'cook-thermo-tube', parent: this.thermo });
    const band = el('i', { cls: 'cook-band', parent: tube });
    band.style.setProperty('--lo', COOK_STIR_BAND_LOW.toFixed(3));
    band.style.setProperty('--hi', COOK_STIR_BAND_HIGH.toFixed(3));
    el('i', { cls: 'cook-mercury', parent: tube });
    el('div', { cls: 'cook-thermo-label', text: '온도', parent: this.thermo });
    const side = el('div', { cls: 'cook-side', parent: this.root });
    el('div', { cls: 'cook-side-label', text: '완성', parent: side });
    this.bar = el('div', { cls: 'cook-hbar', parent: side });
    el('i', { cls: 'cook-hbar-fill', parent: this.bar });
    this.ratioText = el('div', { cls: 'cook-side-num', parent: side });
    this.paint();
  }

  paint(): void {
    this.setVar(this.thermo, '--t', this.g.temp.toFixed(4));
    toggleClass(this.thermo, 'in-band', this.g.inBand);
    toggleClass(this.thermo, 'is-hot', this.g.temp > COOK_STIR_BAND_HIGH);
    toggleClass(this.thermo, 'is-cold', this.g.temp < COOK_STIR_BAND_LOW);
    toggleClass(this.pot, 'is-stirring', this.g.holding);
    this.setVar(this.pot, '--boil', Math.max(0, Math.min(1, (this.g.temp - COOK_STIR_BAND_LOW) / Math.max(1e-6, 1 - COOK_STIR_BAND_LOW))).toFixed(3));
    this.setVar(this.bar, '--f', this.g.progress.toFixed(3));
    setText(this.ratioText, `구간 유지 ${pct(this.g.ratio)} %`);
  }

  input(button: CookButton, down: boolean): void {
    if (button === 'left') toggleClass(this.pot, 'is-down', down);
  }
}

/* ── Pouring ─────────────────────────────────────────────────────────────── */
class PourView extends BaseView {
  private readonly beaker: HTMLElement;
  private readonly jug: HTMLElement;
  private readonly stream: HTMLElement;
  private readonly amountText: HTMLElement;

  constructor(private readonly g: PourGame, parent: HTMLElement) {
    super(parent, 'pour');
    const liquid = g.step.liquid ?? 'water';
    this.root.style.setProperty('--lc', COOK_LIQUID_COLOR[liquid] ?? COOK_LIQUID_COLOR.water);
    const scene = el('div', { cls: 'cook-pourscene', parent: this.root });
    this.jug = el('div', { cls: 'cook-jug', parent: scene });
    el('i', { cls: 'cook-jug-liquid', parent: this.jug });
    this.stream = el('i', { cls: 'cook-stream', parent: scene });
    this.beaker = el('div', { cls: 'cook-beaker', parent: scene });
    const glass = el('div', { cls: 'cook-beaker-glass', parent: this.beaker });
    el('i', { cls: 'cook-beaker-liquid', parent: glass });
    const target = el('i', { cls: 'cook-target', parent: glass });
    target.style.setProperty('--tg', (g.target / g.capacity).toFixed(4));
    for (let i = 1; i < 8; i++) el('i', { cls: 'cook-grad', parent: glass }).style.setProperty('--gy', (i / 8).toFixed(3));
    const side = el('div', { cls: 'cook-side', parent: this.root });
    el('div', { cls: 'cook-side-label', text: `${COOK_LIQUID_LABEL_KO[liquid] ?? liquid} 목표 ${Math.round(g.target)} ml`, parent: side });
    this.amountText = el('div', { cls: 'cook-side-num cook-amount', parent: side });
    this.paint();
  }

  paint(): void {
    this.setVar(this.beaker, '--lvl', Math.min(1, this.g.amount / this.g.capacity).toFixed(4));
    this.setVar(this.root, '--flow', this.g.flow.toFixed(3));
    toggleClass(this.stream, 'is-on', this.g.flow > 0.001);
    toggleClass(this.beaker, 'is-over', this.g.overflowed);
    const e = this.g.amount / this.g.target - 1;
    toggleClass(this.amountText, 'is-over', e > 0);
    setText(this.amountText, `${Math.round(this.g.amount)} / ${Math.round(this.g.target)} ml`);
  }

  input(button: CookButton, down: boolean): void {
    if (button === 'left') toggleClass(this.jug, 'is-down', down);
  }
}

export function createCookView(game: AnyCookGame, parent: HTMLElement, defOf: DefOf): CookView {
  if (game instanceof ChopGame) return new ChopView(game, parent, defOf);
  if (game instanceof MinceGame) return new MinceView(game, parent, defOf);
  if (game instanceof GrillGame) return new GrillView(game, parent, defOf);
  if (game instanceof StirfryGame) return new StirfryView(game, parent, defOf);
  if (game instanceof StirGame) return new StirView(game, parent);
  return new PourView(game, parent);
}
