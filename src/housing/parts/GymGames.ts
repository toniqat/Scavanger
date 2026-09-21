/**
 * src/housing/parts/GymGames.ts — **the gym minigame judgement** (A-3a, 2026-09-12). Pure classes, no DOM, no ctx.
 *
 * The screen (`ui/gym/*`) only draws this object; the smoke test drives it alone, with no screen, and checks the
 * judgement (`HousingSystem.gymDebug.makeGame`). It **holds its own time** — `update(dt)` pushes `time`, and `press` ·
 * `release` judge at the **current `time`**. So the screen calls `update` up to `performance.now()` right before it
 * hands a key over (so the judgement is never late by a tick interval).
 *
 * The judgement rules are the design §4 as written, and every number is a `GYM_*` (`data/constants.csv`):
 *   • Score = the **average** of perfect `GYM_SCORE_PERFECT` · good `GYM_SCORE_GOOD` · miss 0, one per judgement (0 … 1).
 *   • `press` bench press — the cursor sweeps the bar (0 … 1), judged by its distance from the centre (0.5). Faster each rep.
 *   • `breath` breathing run — 「후」 · 「후」 (tap) · 「하」 (hold). 「하」 needs **both** errors, start and release, inside the window.
 *   • `cycle` cycling — left foot (A) · right foot (D) alternating on the beat. The wrong foot · a missed marker is a miss.
 *
 * Two rules the beat games (breathing · cycling) share, filling a blank the design left:
 *   • **What you see is the judgement** (2026-09-14, user's decision): `judgeBands` splits the csv window into two bands — `perfect` is
 *     that window as it is and **the size of the marker · judgement band drawn on screen is that very value** (`ui/gym/GymViews`), while
 *     `good` reaches `GOOD_OF_PERFECT` × beyond it. It inverts the old rule (perfect = a third of the window), so the whole thing is far
 *     more forgiving. The bench press drew `GYM_PRESS_ZONE` · `GYM_PRESS_PERFECT` as they are from the start, so not one line changed.
 *   • **The lead-in beat** `GYM_LEAD_BEATS` beats — how long the first marker takes to reach the judgement line. Input in between is ignored.
 *   • **A stray press is the next marker's miss** — a press earlier than that marker's window but after the previous one closed
 *     (past `t − (beat − window)`) counts the marker as a miss. Otherwise mashing Space to collect every window would be the best strategy.
 *
 * 2026-09-13 (video games, H2): it takes **per-disc tuning** `GymGameTuning`
 * (`createGymGame(kind, tuning?)`). Exactly as the contract means it —
 *   • `speedMul`  bench-press cursor speed × · beat-game beat interval ÷ (the length 「하」 is held is divided too)
 *   • `windowMul` bench-press good · perfect zone × · beat-game judgement window × (the 「하」 release window too)
 *   • `countMul`  judgement count × (rounded, minimum 1)
 *   • `pattern`   the beat-game marker pattern — breathing `t` · `h` · `r`, cycling `L` · `R` · `r`, joined by `-`, repeated to the count.
 *                 `r` = one beat's rest. Tokens that do not fit this game are dropped; with no marker token at all, the gym default pattern.
 * **With no tuning (or all 1 · an empty pattern) it is not one beat different from the gym** — × 1 and ÷ 1 are the same value in floating point,
 * and the default pattern does the same additions in the same order as the old build loop (`smoke-gym`'s expected values survive).
 */
import type { GymGameTuning, GymMinigame } from '@/shared';
import {
  GYM_BREATH_BEAT_S, GYM_BREATH_CYCLES, GYM_BREATH_HOLD_S, GYM_BREATH_HOLD_TOL_S, GYM_BREATH_WINDOW_S,
  GYM_CYCLE_BEAT_S, GYM_CYCLE_STROKES, GYM_CYCLE_WINDOW_S,
  GYM_PRESS_PERFECT, GYM_PRESS_REPS, GYM_PRESS_SPEED, GYM_PRESS_SPEED_STEP, GYM_PRESS_ZONE,
  GYM_LEAD_BEATS, GYM_SCORE_GOOD, GYM_SCORE_PERFECT, GYM_GOOD_OF_PERFECT,
} from '@/shared';

export type GymQuality = 'perfect' | 'good' | 'miss';
/** Logical input — the screen reads `Keys.JUMP` · `Keys.LEFT` · `Keys.RIGHT` at use time and maps them onto this. */
export type GymAction = 'jump' | 'left' | 'right';
export type GymGameEvent =
  | { type: 'judge'; quality: GymQuality; index: number; total: number }
  | { type: 'sound'; id: 'gym_breath' | 'gym_pedal' };

/**
 * The beat games' lead-in beat count — the first marker's trip from the right edge to the judgement line (the length itself is set by the beat
 * `GYM_*_BEAT_S`). The value's source is `data/constants.csv` (2026-09-12 lead: 「no numbers in code」). Re-exported because the screen takes this path.
 */
export { GYM_LEAD_BEATS };

export const GYM_QUALITY_LABEL_KO: Readonly<Record<GymQuality, string>> = { perfect: '완벽', good: '좋음', miss: '실패' };

export function qualityScore(q: GymQuality): number {
  return q === 'perfect' ? GYM_SCORE_PERFECT : q === 'good' ? GYM_SCORE_GOOD : 0;
}

/** The average of the judgements (denominator = the session's judgement count). Clamped to 0 … 1. */
export function scoreOf(judgements: readonly GymQuality[], total: number): number {
  if (total <= 0) return 0;
  let sum = 0;
  for (const q of judgements) sum += qualityScore(q);
  return Math.max(0, Math.min(1, sum / total));
}

/**
 * One set of judgement bands (seconds) — `perfect` is **the radius of the marker drawn on screen**, `good` reaches
 * beyond it (2026-09-14, user's decision 「what you see is the judgement」).
 */
export interface JudgeBands {
  perfect: number;
  good: number;
}

/**
 * csv window (`GYM_*_WINDOW_S`) → judgement bands. `perfect` is the window itself (clamped into `WINDOW_MAX_OF_BEAT`, so it never overlaps
 * the neighbouring marker) and `good` reaches `GOOD_OF_PERFECT` × beyond it. The screen (`ui/gym/GymViews`) builds the marker · band size
 * from `perfect`. It inverts the old rule (perfect = a third of the window), so everything is far more forgiving.
 */
export function judgeBands(window: number, beat: number): JudgeBands {
  const cap = Math.max(0, beat) * WINDOW_MAX_OF_BEAT;
  const good = Math.min(Math.max(0, window) * GOOD_OF_PERFECT, cap);
  return { perfect: good / GOOD_OF_PERFECT, good };
}

/** Beat error → judgement (inside the perfect band = perfect, inside the good band = good), null outside. */
function grade(err: number, bands: JudgeBands): GymQuality | null {
  const e = Math.abs(err);
  if (e <= bands.perfect + 1e-9) return 'perfect';
  if (e <= bands.good + 1e-9) return 'good';
  return null;
}

/* ── Tuning (2026-09-13) ─────────────────────────────────────────────────── */

/** Beat-game judgement window cap = beat × this (an implementation value) — a window past half a beat overlaps the next marker's and breaks the stray-press rule. */
const WINDOW_MAX_OF_BEAT = 0.5;
/**
 * The good band = this multiple of the perfect band (an implementation value, 2026-09-14). **The perfect band is the marker drawn on screen**
 * and good is the rest outside it — at 1 good disappears; at `WINDOW_MAX_OF_BEAT` a stray press is no longer caught as a miss.
 */
const GOOD_OF_PERFECT = GYM_GOOD_OF_PERFECT;

/** One tuning multiplier — a finite positive number only, otherwise 1 (= the gym default). */
export function tuningMul(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 1;
}

/** Judgement count = `max(1, round(base × countMul))`. */
export function tunedCount(base: number, countMul: number | undefined): number {
  return Math.max(1, Math.round(base * tuningMul(countMul)));
}

/** Pattern tokens — breathing `t` (tap) · `h` (hold) · cycling `L` · `R` · shared `r` (one beat's rest). */
export type GymPatternToken = 't' | 'h' | 'L' | 'R' | 'r';
const BREATH_TOKENS: readonly GymPatternToken[] = ['t', 'h', 'r'];
const CYCLE_TOKENS: readonly GymPatternToken[] = ['L', 'R', 'r'];

/**
 * A pattern like `t-t-h-r` into a token list — tokens outside `allowed` are dropped. With no marker token (anything
 * but `r`) at all, an empty array (= the default pattern).
 */
export function parseGymPattern(pattern: string | undefined, allowed: readonly GymPatternToken[]): GymPatternToken[] {
  if (typeof pattern !== 'string' || !pattern.trim()) return [];
  const out: GymPatternToken[] = [];
  for (const raw of pattern.split('-')) {
    const tok = raw.trim() as GymPatternToken;
    if ((allowed as readonly string[]).includes(tok)) out.push(tok);
  }
  return out.some((t) => t !== 'r') ? out : [];
}

export abstract class GymGame {
  abstract readonly minigame: GymMinigame;
  /** This session's judgement count. */
  abstract readonly total: number;
  /** In judgement order. */
  readonly judgements: GymQuality[] = [];
  /** Time elapsed since the game started (seconds). */
  time = 0;
  private events: GymGameEvent[] = [];

  get done(): boolean { return this.judgements.length >= this.total; }
  get score(): number { return scoreOf(this.judgements, this.total); }
  /** Progress 0 … 1 — the progress bar in the screen's header row reads only this (2026-09-14, user's decision 「a bar only, no label」). */
  get completion(): number { return this.total > 0 ? Math.max(0, Math.min(1, this.judgements.length / this.total)) : 0; }
  counts(): Record<GymQuality, number> {
    const c = { perfect: 0, good: 0, miss: 0 };
    for (const q of this.judgements) c[q]++;
    return c;
  }

  /** Takes the queued events and empties them (the screen calls it every tick · every key). */
  drain(): GymGameEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  update(dt: number): void {
    if (this.done) return;
    const d = Number.isFinite(dt) && dt > 0 ? dt : 0;
    this.time += d;
    this.step(d);
  }

  press(action: GymAction): void { if (!this.done) this.onPress(action); }
  release(action: GymAction): void { if (!this.done) this.onRelease(action); }

  protected judge(quality: GymQuality): void {
    if (this.done) return;
    this.judgements.push(quality);
    this.events.push({ type: 'judge', quality, index: this.judgements.length - 1, total: this.total });
  }
  protected sound(id: 'gym_breath' | 'gym_pedal'): void { this.events.push({ type: 'sound', id }); }

  protected abstract step(dt: number): void;
  protected abstract onPress(action: GymAction): void;
  protected onRelease(_action: GymAction): void { /* games that only tap */ }
}

/* ── Bench press ─────────────────────────────────────────────────────────── */
export class PressGame extends GymGame {
  readonly minigame = 'press' as const;
  readonly total: number;
  /** The good zone's half-width (as a fraction of the bar) — `GYM_PRESS_ZONE × windowMul`, at most 0.5. The screen draws the zone from it. */
  readonly zone: number;
  /** The perfect zone's half-width — `GYM_PRESS_PERFECT × windowMul`, at most the good zone. */
  readonly perfect: number;
  /** The cursor speed multiplier (`speedMul`). */
  readonly speedMul: number;
  /** Cursor position 0 … 1 (as a fraction of the bar, centre 0.5). It starts at the left end and moves right. */
  pos = 0;
  dir: 1 | -1 = 1;

  constructor(tuning?: GymGameTuning) {
    super();
    const w = tuningMul(tuning?.windowMul);
    this.speedMul = tuningMul(tuning?.speedMul);
    this.zone = Math.min(0.5, GYM_PRESS_ZONE * w);
    this.perfect = Math.min(this.zone, GYM_PRESS_PERFECT * w);
    this.total = tunedCount(Math.round(GYM_PRESS_REPS), tuning?.countMul);
  }

  /** The current rep's cursor speed (bar widths per second). */
  get speed(): number { return (GYM_PRESS_SPEED + this.judgements.length * GYM_PRESS_SPEED_STEP) * this.speedMul; }

  protected step(dt: number): void {
    const v = this.speed;
    if (!(v > 0)) return;
    let d = (v * dt) % 2;                         // one round trip = 2 bar widths
    while (d > 0) {
      const room = this.dir > 0 ? 1 - this.pos : this.pos;
      if (d <= room) { this.pos += this.dir * d; d = 0; }
      else { this.pos = this.dir > 0 ? 1 : 0; d -= room; this.dir = this.dir > 0 ? -1 : 1; }
    }
  }

  protected onPress(action: GymAction): void {
    if (action !== 'jump') return;
    const off = Math.abs(this.pos - 0.5);
    this.judge(off <= this.perfect ? 'perfect' : off <= this.zone ? 'good' : 'miss');
  }
}

/* ── Beat games — shared ─────────────────────────────────────────────────── */
export interface BeatNote {
  /** The time the marker reaches the judgement line (seconds). */
  t: number;
  /** Cycling: the foot to press. Breathing: always null. */
  lane: 'left' | 'right' | null;
  /** Breathing's 「하」 (held down, released `GYM_BREATH_HOLD_S` later). */
  hold: boolean;
  /** This marker's judgement, null until then. */
  q: GymQuality | null;
  /** 「하」: the judgement at the moment the press started (not null while it is held). */
  start: GymQuality | null;
}

abstract class BeatGame extends GymGame {
  abstract readonly notes: readonly BeatNote[];
  abstract readonly beat: number;
  /** The judgement bands — `perfect` is exactly the on-screen marker's radius (2026-09-14). */
  abstract readonly bands: JudgeBands;
  /** The outer band (= out to good). The window the miss · stray-press rules use. */
  abstract readonly window: number;
  /** The first unjudged marker. */
  protected next = 0;

  get total(): number { return this.notes.length; }
  /** The marker waiting for its judgement (screen · smoke test), null once it is over. */
  get upcoming(): BeatNote | null { return this.notes[this.next] ?? null; }

  protected resolve(n: BeatNote, q: GymQuality): void {
    if (n.q !== null) return;
    n.q = q;
    this.next++;
    this.judge(q);
  }

  /** Is a stray press earlier than the next marker that marker's miss (after the previous window closed) — otherwise ignored. */
  protected strayMiss(n: BeatNote): boolean {
    const err = this.time - n.t;
    return err < -this.window && err >= -(this.beat - this.window);
  }
}

/* ── Breathing run (후 · 후 · 하) ────────────────────────────────────────── */
export class BreathGame extends BeatGame {
  readonly minigame = 'breath' as const;
  readonly beat: number;
  readonly bands: JudgeBands;
  readonly window: number;
  readonly holdS: number;
  /** The judgement bands for releasing 「하」 (`perfect` · `good`) — the drawing at the marker's end is `perfect`. */
  readonly holdBands: JudgeBands;
  readonly holdTol: number;
  readonly notes: BeatNote[] = [];

  constructor(tuning?: GymGameTuning) {
    super();
    const speed = tuningMul(tuning?.speedMul), win = tuningMul(tuning?.windowMul);
    this.beat = GYM_BREATH_BEAT_S / speed;
    this.holdS = GYM_BREATH_HOLD_S / speed;
    this.bands = judgeBands(GYM_BREATH_WINDOW_S * win, this.beat);
    this.window = this.bands.good;
    this.holdBands = judgeBands(GYM_BREATH_HOLD_TOL_S * win, this.holdS);
    this.holdTol = this.holdBands.good;
    const B = this.beat;
    const cycles = Math.max(1, Math.round(GYM_BREATH_CYCLES));
    const total = tunedCount(cycles * 3, tuning?.countMul);
    const custom = parseGymPattern(tuning?.pattern, BREATH_TOKENS);
    const seq: readonly GymPatternToken[] = custom.length ? custom : ['t', 't', 'h'];   // the gym default: 후 · 후 · 하
    let t = GYM_LEAD_BEATS * B;
    for (let i = 0, made = 0; made < total; i++) {
      const tok = seq[i % seq.length];
      if (tok === 'r') { t += B; continue; }            // one beat's rest
      const hold = tok === 'h';
      this.notes.push({ t, lane: null, hold, q: null, start: null });
      made++;
      if (hold) t += this.holdS + B;                    // after 「하」 is fully released, one beat's rest, then the next marker
      else t += B;
    }
  }

  /** Is 「하」 being held right now. */
  get holding(): boolean { const n = this.upcoming; return !!n && n.hold && n.start !== null; }

  protected step(): void {
    for (let n = this.upcoming; n; n = this.upcoming) {
      if (n.hold && n.start !== null) {
        if (this.time > n.t + this.holdS + this.holdTol) { this.resolve(n, 'miss'); continue; }   // held too long
      } else if (this.time > n.t + this.window) { this.resolve(n, 'miss'); continue; }            // missed it
      break;
    }
  }

  protected onPress(action: GymAction): void {
    if (action !== 'jump') return;
    this.step();
    const n = this.upcoming;
    if (!n || (n.hold && n.start !== null)) return;
    const q = grade(this.time - n.t, this.bands);
    if (q) {
      this.sound('gym_breath');
      if (n.hold) n.start = q;
      else this.resolve(n, q);
    } else if (this.strayMiss(n)) this.resolve(n, 'miss');
  }

  protected onRelease(action: GymAction): void {
    if (action !== 'jump') return;
    this.step();
    const n = this.upcoming;
    if (!n || !n.hold || n.start === null) return;
    const err = Math.abs(this.time - (n.t + this.holdS));
    if (err > this.holdTol) { this.resolve(n, 'miss'); return; }                                // released too early
    this.resolve(n, n.start === 'perfect' && err <= this.holdBands.perfect ? 'perfect' : 'good');
  }
}

/* ── Cycling (A · D alternating) ─────────────────────────────────────────── */
export class CycleGame extends BeatGame {
  readonly minigame = 'cycle' as const;
  readonly beat: number;
  readonly bands: JudgeBands;
  readonly window: number;
  readonly notes: BeatNote[] = [];

  constructor(tuning?: GymGameTuning) {
    super();
    this.beat = GYM_CYCLE_BEAT_S / tuningMul(tuning?.speedMul);
    this.bands = judgeBands(GYM_CYCLE_WINDOW_S * tuningMul(tuning?.windowMul), this.beat);
    this.window = this.bands.good;
    const strokes = tunedCount(Math.max(1, Math.round(GYM_CYCLE_STROKES)), tuning?.countMul);
    const custom = parseGymPattern(tuning?.pattern, CYCLE_TOKENS);
    if (!custom.length) {
      // the gym default: left foot · right foot alternating, no rests
      for (let k = 0; k < strokes; k++) {
        this.notes.push({ t: (GYM_LEAD_BEATS + k) * this.beat, lane: k % 2 === 0 ? 'left' : 'right', hold: false, q: null, start: null });
      }
      return;
    }
    // pattern: one token = one beat (a rest `r` takes a beat too)
    for (let s = 0, made = 0; made < strokes; s++) {
      const tok = custom[s % custom.length];
      if (tok === 'r') continue;
      this.notes.push({ t: (GYM_LEAD_BEATS + s) * this.beat, lane: tok === 'L' ? 'left' : 'right', hold: false, q: null, start: null });
      made++;
    }
  }

  protected step(): void {
    for (let n = this.upcoming; n && this.time > n.t + this.window; n = this.upcoming) this.resolve(n, 'miss');
  }

  protected onPress(action: GymAction): void {
    if (action === 'jump') return;
    this.step();
    const n = this.upcoming;
    if (!n) return;
    const q = grade(this.time - n.t, this.bands);
    if (q) {
      if (action === n.lane) { this.sound('gym_pedal'); this.resolve(n, q); }
      else this.resolve(n, 'miss');                                                                  // the wrong foot
    } else if (this.strayMiss(n)) this.resolve(n, 'miss');
  }
}

/** One judge object. `tuning` omitted = the gym default (2026-09-13: a video-game disc passes tuning in). */
export function createGymGame(kind: GymMinigame, tuning?: GymGameTuning): GymGame {
  return kind === 'press' ? new PressGame(tuning) : kind === 'breath' ? new BreathGame(tuning) : new CycleGame(tuning);
}

export function isBeatGame(g: GymGame): g is BreathGame | CycleGame {
  return g instanceof BreathGame || g instanceof CycleGame;
}
