/**
 * src/housing/ui/gym/GymViews.ts — the **stages** (`.gym-stage`) of the three gym minigames. It only draws the judge object (`parts/GymGames`).
 *
 * Every tick `paint()` rewrites a few style properties (`left` · `--x` · `--f`) and classes — the DOM is built once, at construction.
 *   • Bench press: a thick horizontal bar + the good zone (centre) + the perfect zone + a round cursor sweeping it + the rep pips.
 *   • Breathing run · cycling: markers that flow in from the right and reach the judgement line (breathing = one lane, 「하」 a pill
 *     with a length · cycling = two lanes, left foot / right foot, with a keycap at the head of each lane).
 * Key names are read from `Keys` at use time (`relabel` — `input:bindingsChanged`).
 *
 * 2026-09-13 (video games, H2): the bench-press zone widths are read from the judge object's `zone` · `perfect` (the values with the disc
 * tuning `windowMul` applied) — with no tuning they are `GYM_PRESS_ZONE` · `GYM_PRESS_PERFECT` as they are. The breathing marker text can be
 * changed with `GymViewOptions.labels` (game = 톡 · 꾹).
 *
 * 2026-09-14 (user's decision 「what you see is the judgement」): the beat lanes too **build their drawing from the judgement values**, like the
 * bench press — the perfect band (`bands.perfect`) · the good band (`bands.good`) are laid over the judgement line, and a tap marker's width is
 * made **equal** to the perfect band (a pill). So 「the moment the marker covers the band it is perfect」 is visible, and fixing the csv window
 * makes the drawing follow by itself. The 「하」 marker keeps its hold length as its width, unchanged.
 */
import { Keys, keyLabel, paintKeycap } from '@/shared';
import { BreathGame, CycleGame, GYM_LEAD_BEATS, PressGame } from '../../parts/GymGames';
import type { BeatNote, GymAction, GymGame, GymQuality } from '../../parts/GymGames';
import { el, setText, toggleClass } from '../dom';

export interface GymView {
  readonly root: HTMLElement;
  paint(): void;
  judged(quality: GymQuality, index: number): void;
  input(action: GymAction, down: boolean): void;
  relabel(): void;
  dispose(): void;
}

const QUALITY_CLASSES = ['is-perfect', 'is-good', 'is-miss'];

/** Restarts a one-shot CSS animation from the beginning. */
export function replayClass(e: HTMLElement, cls: string): void {
  e.classList.remove(cls);
  void e.offsetWidth;
  e.classList.add(cls);
}

function setQuality(e: HTMLElement, q: GymQuality | null): void {
  const want = q ? `is-${q}` : '';
  for (const c of QUALITY_CLASSES) toggleClass(e, c, c === want);
}

/* ── Bench press ─────────────────────────────────────────────────────────── */
class PressView implements GymView {
  readonly root: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly cursor: HTMLElement;
  private readonly pips: HTMLElement[] = [];
  private lastLeft = '';

  constructor(private readonly game: PressGame, parent: HTMLElement) {
    this.root = el('div', { cls: 'gym-stage gym-press', parent });
    this.bar = el('div', { cls: 'gym-press-bar', parent: this.root });
    el('i', { cls: 'gym-press-zone', parent: this.bar }).style.width = `${(game.zone * 200).toFixed(2)}%`;
    el('i', { cls: 'gym-press-perfect', parent: this.bar }).style.width = `${(game.perfect * 200).toFixed(2)}%`;
    el('i', { cls: 'gym-press-mid', parent: this.bar });
    this.cursor = el('i', { cls: 'gym-press-cursor', parent: this.bar });
    const row = el('div', { cls: 'gym-pips', parent: this.root });
    for (let i = 0; i < game.total; i++) this.pips.push(el('i', { cls: 'gym-pip', parent: row }));
    this.paint();
  }

  paint(): void {
    const g = this.game;
    const left = `${(g.pos * 100).toFixed(2)}%`;
    if (left !== this.lastLeft) { this.cursor.style.left = left; this.lastLeft = left; }
    toggleClass(this.cursor, 'in-zone', Math.abs(g.pos - 0.5) <= g.zone);
    const now = g.judgements.length;
    this.pips.forEach((p, i) => toggleClass(p, 'is-now', i === now && !g.done));
  }

  judged(q: GymQuality, index: number): void {
    const p = this.pips[index];
    if (p) setQuality(p, q);
    for (const c of ['hit-perfect', 'hit-good', 'hit-miss']) this.bar.classList.remove(c);
    replayClass(this.bar, `hit-${q}`);
  }

  input(action: GymAction, down: boolean): void {
    if (action === 'jump') toggleClass(this.cursor, 'is-down', down);
  }

  relabel(): void { /* no keycap — the header row · the key guide name the key */ }
  dispose(): void { this.root.remove(); }
}

/* ── Beat games (breathing · cycling) ────────────────────────────────────── */
interface LaneEls { lane: HTMLElement; key: HTMLElement; action: GymAction }
interface NoteEls { note: BeatNote; el: HTMLElement; label: HTMLElement; q: GymQuality | null; off: boolean }

class BeatView implements GymView {
  readonly root: HTMLElement;
  private readonly lanes: LaneEls[] = [];
  private readonly notes: NoteEls[] = [];
  /** How many seconds from the judgement line to the right edge — the lead-in beats + 1, so the first marker shows near the right edge right at the start. */
  private readonly look: number;
  private readonly holdLen: number;

  constructor(private readonly game: BreathGame | CycleGame, parent: HTMLElement, private readonly labels: GymNoteLabels = GYM_NOTE_LABELS) {
    const breath = game instanceof BreathGame;
    this.root = el('div', { cls: `gym-stage gym-beat ${breath ? 'gym-breath' : 'gym-cycle'}`, parent });
    this.look = game.beat * (GYM_LEAD_BEATS + 1);
    this.holdLen = breath ? (game as BreathGame).holdS / this.look : 0;
    const track = el('div', { cls: 'gym-lanes', parent: this.root });
    const laneDefs: Array<{ id: string; action: GymAction }> = breath
      ? [{ id: 'breath', action: 'jump' }]
      : [{ id: 'left', action: 'left' }, { id: 'right', action: 'right' }];
    // 2026-09-14: the **perfect band** is drawn over the judgement line — its width comes from the judge object's `bands.perfect`, so 「the marker covering the band is perfect」 is visible
    const half = (game.bands.perfect / this.look).toFixed(4);
    const goodHalf = (game.bands.good / this.look).toFixed(4);
    for (const d of laneDefs) {
      const row = el('div', { cls: 'gym-lane-row', parent: track });
      const key = el('span', { cls: 'keycap gym-lane-key', parent: row });
      const lane = el('div', { cls: 'gym-lane', parent: row });
      lane.dataset.lane = d.id;
      lane.style.setProperty('--half', half);
      lane.style.setProperty('--good-half', goodHalf);
      el('i', { cls: 'gym-window is-good', parent: lane });
      el('i', { cls: 'gym-window is-perfect', parent: lane });
      el('i', { cls: 'gym-judge', parent: lane });
      this.lanes.push({ lane, key, action: d.action });
    }
    for (const n of game.notes) {
      const host = breath ? this.lanes[0].lane : this.lanes[n.lane === 'right' ? 1 : 0].lane;
      const e = el('div', { cls: `gym-note${n.hold ? ' is-hold' : ''}`, parent: host });
      // a tap marker is **the same width as** the perfect band (a pill). 「하」 is left alone — its width is the length it is held.
      if (!n.hold) e.style.setProperty('--span', half);
      if (n.hold) { e.style.setProperty('--len', this.holdLen.toFixed(4)); el('i', { cls: 'gym-note-fill', parent: e }); }
      const label = el('span', { cls: 'gym-note-label', parent: e });
      this.notes.push({ note: n, el: e, label, q: null, off: false });
    }
    this.relabel();
    this.paint();
  }

  paint(): void {
    const g = this.game;
    const t = g.time;
    const next = g.upcoming;
    for (const ne of this.notes) {
      const n = ne.note;
      const x = (n.t - t) / this.look;
      const off = x + (n.hold ? this.holdLen : 0) < -0.12 || x > 1.02;
      if (off !== ne.off) { ne.off = off; toggleClass(ne.el, 'is-off', off); }
      if (off) continue;
      ne.el.style.setProperty('--x', x.toFixed(4));
      if (ne.q !== n.q) { ne.q = n.q; setQuality(ne.el, n.q); }
      toggleClass(ne.el, 'is-next', n === next);
      if (n.hold) {
        const holding = n.q === null && n.start !== null;
        toggleClass(ne.el, 'is-holding', holding);
        const f = holding ? Math.max(0, Math.min(1, (t - n.t) / (g as BreathGame).holdS)) : n.q && n.q !== 'miss' ? 1 : 0;
        ne.el.style.setProperty('--f', f.toFixed(3));
      }
    }
  }

  judged(q: GymQuality): void {
    for (const l of this.lanes) {
      for (const c of ['hit-perfect', 'hit-good', 'hit-miss']) l.lane.classList.remove(c);
      replayClass(l.lane, `hit-${q}`);
    }
  }

  input(action: GymAction, down: boolean): void {
    for (const l of this.lanes) if (l.action === action) toggleClass(l.key, 'is-down', down);
  }

  relabel(): void {
    const codeOf = (a: GymAction): string => (a === 'jump' ? Keys.JUMP : a === 'left' ? Keys.LEFT : Keys.RIGHT);
    const keyOf = (a: GymAction): string => keyLabel(codeOf(a));
    // 2026-09-15: the keycap at the head of a lane is the shared `paintKeycap` (a glyph once rebound to the mouse). The text inside a marker stays text, not a keycap.
    for (const l of this.lanes) paintKeycap(l.key, codeOf(l.action));
    for (const ne of this.notes) {
      const n = ne.note;
      setText(ne.label, n.lane ? keyOf(n.lane) : n.hold ? this.labels.hold : this.labels.tap);
    }
  }

  dispose(): void { this.root.remove(); }
}

/** The breathing marker text (2026-09-13) — gym = 후 · 하, video game = 톡 · 꾹. */
export interface GymNoteLabels { tap: string; hold: string }
export const GYM_NOTE_LABELS: GymNoteLabels = { tap: '후', hold: '하' };

export interface GymViewOptions {
  /** The breathing marker text — omitted = the gym (`GYM_NOTE_LABELS`). */
  labels?: GymNoteLabels;
}

export function createGymView(game: GymGame, parent: HTMLElement, opts: GymViewOptions = {}): GymView {
  if (game instanceof PressGame) return new PressView(game, parent);
  if (game instanceof BreathGame || game instanceof CycleGame) return new BeatView(game, parent, opts.labels ?? GYM_NOTE_LABELS);
  throw new Error(`[housing] unknown gym game ${game.minigame}`);
}
