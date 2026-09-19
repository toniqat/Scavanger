/**
 * src/housing/parts/CookGames.ts — **the cooking minigame judgement** (2026-09-13, `docs/DECISIONS.md` 「2026-09-13 — 요리 미니게임」). Pure classes, no DOM, no ctx.
 *
 * Modelled exactly on `parts/GymGames.ts`: the screen (`ui/cook/*`) only draws this object, and the smoke test drives
 * it alone, with no screen, to check the judgement (`HousingSystem.cookDebug.makeGame`). It **holds its own time** —
 * `update(dt)` pushes `time` and `press` · `release` · `clickPiece` judge at the **current `time`**. So the screen
 * calls `update` up to that moment right before it hands the input over.
 *
 * Every number is a `COOK_*` from `shared/cooking` (`data/constants.csv`) — not one judgement number lives here.
 *   • One judgement = perfect `COOK_SCORE_PERFECT` · good `COOK_SCORE_GOOD` · miss 0.
 *   • **2026-09-14 (user's decision): what you see is the judgement.** `cookJudgeBands` splits one window into two bands — `perfect` is the csv
 *     window (`COOK_*_WINDOW_S`) as it is and **the size of the marker drawn on screen is that band** (`ui/cook/CookViews` builds its width from it),
 *     and `good` reaches `GOOD_OF_PERFECT` × beyond it. It inverts the old rule (perfect = a third of the window), so everything is far more forgiving.
 *   • **2026-09-14: it never stalls.** Stir-frying · stirring · pouring, which never ended with no input at all, got a `maxTime` pin
 *     (the same place as mincing's `COOK_MINCE_MAX_S`). Not a judgement number but **stall prevention that ends on the score so far**.
 *   • `chop`    chopping    — a marker on every beat after the lead-in, `COOK_CHOP_CUTS` of them. A stray click outside the window is
 *                             **the next marker's miss** (after the previous window closed) — the gym's `BeatGame.strayMiss` rule. Score = the judgement average.
 *   • `mince`   mincing     — LMB = the left-right gauge · RMB = the up-down gauge, +FILL; **on the same button as the previous click** the other gauge −DRAIN.
 *                             Both at 1 ends it (score linear in the time taken), `COOK_MINCE_MAX_S` force-ends it (0 points).
 *   • `grill`   grilling    — piece i cooks from `i × STAGGER` on, over `cookGrillSeconds` (and keeps rising). Clicking a piece = a flip /
 *                             (a failed flip + removal, if it is already late) / a flipped piece comes off. At `BURN_AT` it burns and comes off (the rest miss).
 *                             Score = the average of the pieces × 2 judgements.
 *   • `stirfry` stir-frying — a click is judged against the nearest beat, **once per beat only**. Each judgement fills the bar, bar ≥ 1 ends it. Judgement average.
 *   • `stir`    stirring    — held, temperature ↓ · doneness ↑; released, temperature ↑ (the boiling surge). Score linear in the time spent in the green band.
 *   • `pour`    pouring     — the flow runs linearly 0 ↔ 1 over `RAMP_S`. Once something has been poured, standing at flow 0 for `SETTLE_S` ends it,
 *                             and an overflowing beaker (target × `BEAKER_MUL`) ends it at once. Score linear in the error against the target amount.
 *
 * Presentation events (`drain()`): `judge` (one judgement) · `beat` (the hub hand motion · sound — goes out as `housing:cookBeat`) · `sound` (a piece hitting the grill).
 */
import type { CookBeatAction, CookGame, CookJudge, CookStepDef } from '@/shared';
import {
  COOK_CHOP_BEAT_S, COOK_CHOP_CUTS, COOK_CHOP_WINDOW_S,
  COOK_GRILL_BURN_AT, COOK_GRILL_DONE_GOOD, COOK_GRILL_DONE_PERFECT, COOK_GRILL_EARLY_REMOVE, COOK_GRILL_FLIP_GOOD,
  COOK_GRILL_FLIP_PERFECT, COOK_GRILL_STAGGER_S,
  COOK_LEAD_BEATS,
  COOK_MINCE_DRAIN, COOK_MINCE_FILL, COOK_MINCE_MAX_S, COOK_MINCE_PERFECT_S, COOK_MINCE_ZERO_S,
  COOK_POUR_BEAKER_MUL, COOK_POUR_PERFECT_ERR, COOK_POUR_RAMP_S, COOK_POUR_RATE_ML_S, COOK_POUR_SETTLE_S, COOK_POUR_ZERO_ERR,
  COOK_SCORE_GOOD, COOK_SCORE_PERFECT,
  COOK_STIR_BAND_HIGH, COOK_STIR_BAND_LOW, COOK_STIR_HEAT_FALL, COOK_STIR_HEAT_RISE, COOK_STIR_PERFECT_RATIO, COOK_STIR_SURGE,
  COOK_STIR_SURGE_S, COOK_STIR_TIME_S, COOK_STIR_ZERO_RATIO,
  COOK_STIRFRY_BEAT_S, COOK_STIRFRY_FILL_GOOD, COOK_STIRFRY_FILL_MISS, COOK_STIRFRY_FILL_PERFECT, COOK_STIRFRY_WINDOW_S,
  COOK_GOOD_OF_PERFECT, COOK_STEP_TIMEOUT_MUL,
  cookGrillSeconds,
} from '@/shared';

/** The mouse button — the screen maps `pointerdown.button` 0 / 2 onto this. */
export type CookButton = 'left' | 'right';

export type CookGameEvent =
  | { type: 'judge'; quality: CookJudge; index: number }
  | { type: 'beat'; action: CookBeatAction; quality: CookJudge | null }
  | { type: 'sound'; id: 'cook_sizzle' };

/**
 * Stirring: the interval (seconds) at which the `stir` presentation event is re-emitted while the button is held. **A presentation beat with
 * nothing to do with the judgement** — the hub's ladle stops 0.45 s after the last `stir` (there is no 「released」 event), so this has to be
 * comfortably shorter. The sound (`cook_stir`) is thinned out separately by the screen (an implementation value, not a balance number).
 */
export const COOK_STIR_BEAT_INTERVAL_S = 0.25;
/** The cap on one integration step (seconds) — sub-stepped so the stir temperature never depends on the tick interval (tens of ms at worst) (an implementation value). */
const SUBSTEP_S = 1 / 240;
/**
 * The cap on a beat game's judgement band = beat × this (an implementation value — the same rule as `parts/GymGames.WINDOW_MAX_OF_BEAT`):
 * a band past half a beat overlaps the neighbouring marker's band and breaks the stray-click rule.
 */
const WINDOW_MAX_OF_BEAT = 0.5;
/**
 * The good band = this multiple of the perfect band (an implementation value). **The perfect band is the marker drawn on screen** and good is
 * the rest outside it — at 1 good disappears, and at `WINDOW_MAX_OF_BEAT` a stray click is no longer caught as a miss.
 */
const GOOD_OF_PERFECT = COOK_GOOD_OF_PERFECT;
/**
 * The multiplier for the pin that ends a step whose input has stopped (an implementation value) — it has to be a length
 * nobody who plays the step through ever reaches. Not a judgement number: on reaching it the step ends **on the score so far**.
 */
const STALL_TIMEOUT_MUL = COOK_STEP_TIMEOUT_MUL;

export function cookJudgeScore(q: CookJudge): number {
  return q === 'perfect' ? COOK_SCORE_PERFECT : q === 'good' ? COOK_SCORE_GOOD : 0;
}

/** The average of the judgements (denominator = `total`). Clamped to 0 … 1. */
export function cookJudgeAverage(judgements: readonly CookJudge[], total: number): number {
  if (total <= 0) return 0;
  let sum = 0;
  for (const q of judgements) sum += cookJudgeScore(q);
  return clamp01(sum / total);
}

/** One set of judgement bands (seconds) — `perfect` is **the radius of the marker drawn on screen**, `good` reaches beyond it. */
export interface CookJudgeBands {
  perfect: number;
  good: number;
}

/**
 * csv window (`COOK_*_WINDOW_S`) → judgement bands. `perfect` is the window itself (clamped clear of the neighbouring marker), `good` is `GOOD_OF_PERFECT` ×.
 * The screen builds the marker size from `perfect` — that is what makes 「the marker covering the judgement line is perfect」 visible.
 */
export function cookJudgeBands(window: number, beat: number): CookJudgeBands {
  const cap = Math.max(0, beat) * WINDOW_MAX_OF_BEAT;
  const good = Math.min(Math.max(0, window) * GOOD_OF_PERFECT, cap);
  return { perfect: good / GOOD_OF_PERFECT, good };
}

/** Error → judgement (inside the perfect band = perfect, inside the good band = good), null outside. */
export function cookGrade(err: number, bands: CookJudgeBands): CookJudge | null {
  const e = Math.abs(err);
  if (e <= bands.perfect + 1e-9) return 'perfect';
  if (e <= bands.good + 1e-9) return 'good';
  return null;
}

function clamp01(v: number): number { return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0; }

/** v ≤ best → 1, v ≥ worst → 0, linear between (best < worst). */
function linearDown(v: number, best: number, worst: number): number {
  if (v <= best) return 1;
  if (v >= worst) return 0;
  return clamp01(1 - (v - best) / (worst - best));
}

/** v ≥ best → 1, v ≤ worst → 0, linear between (worst < best). */
function linearUp(v: number, best: number, worst: number): number {
  if (v >= best) return 1;
  if (v <= worst) return 0;
  return clamp01((v - worst) / (best - worst));
}

export abstract class CookGameBase {
  abstract readonly game: CookGame;
  /** In judgement order (mincing · stirring · pouring have no judgements, so it stays empty). */
  readonly judgements: CookJudge[] = [];
  /** Time elapsed since the game started (seconds). */
  time = 0;
  protected finished = false;
  private events: CookGameEvent[] = [];

  constructor(readonly step: CookStepDef) {}

  get done(): boolean { return this.finished; }
  /** The step score 0 … 1 (before it ends, the provisional value so far). */
  abstract get score(): number;
  /**
   * The step progress 0 … 1 — the one progress bar at the bottom of the screen reads only this (2026-09-14, user's decision 「a bar only, no label」).
   * It means 「1 once it runs to the end」, and is not a score.
   */
  abstract get completion(): number;
  /**
   * It ends at this time (seconds) even with no input at all — **not a judgement but a stall-prevention pin**. Infinity for a game that always ends on its own.
   */
  get maxTime(): number { return Infinity; }

  counts(): Record<CookJudge, number> {
    const c = { perfect: 0, good: 0, miss: 0 };
    for (const q of this.judgements) c[q]++;
    return c;
  }

  /** Takes the queued events and empties them (the screen calls it every tick · every input). */
  drain(): CookGameEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  update(dt: number): void {
    if (this.finished) return;
    const d = Number.isFinite(dt) && dt > 0 ? dt : 0;
    this.time += d;
    this.step_(d);
    if (!this.finished && this.time >= this.maxTime) { this.onTimeout(); this.finish(); }
  }

  press(button: CookButton): void { if (!this.finished) this.onPress(button); }
  release(button: CookButton): void { if (!this.finished) this.onRelease(button); }
  /** A click on a grilling piece — nothing happens in the other games. */
  clickPiece(index: number): void { if (!this.finished) this.onPiece(index); }

  protected judge(quality: CookJudge): void {
    this.judgements.push(quality);
    this.events.push({ type: 'judge', quality, index: this.judgements.length - 1 });
  }
  protected beat(action: CookBeatAction, quality: CookJudge | null = null): void { this.events.push({ type: 'beat', action, quality }); }
  protected sound(id: 'cook_sizzle'): void { this.events.push({ type: 'sound', id }); }
  protected finish(): void { this.finished = true; }

  /** `maxTime` was reached — what each game finishes off right before the end (by default, the score so far as it is). */
  protected onTimeout(): void { /* per game */ }

  /** `step` is a contract field name, so the judgement tick is `step_`. */
  protected abstract step_(dt: number): void;
  protected onPress(_button: CookButton): void { /* per game */ }
  protected onRelease(_button: CookButton): void { /* games that only tap */ }
  protected onPiece(_index: number): void { /* grilling only */ }
}

/* ── Chopping ────────────────────────────────────────────────────────────── */
export interface CookNote {
  /** The time the marker reaches the judgement line (seconds). */
  t: number;
  /** This marker's judgement, null until then. */
  q: CookJudge | null;
}

export class ChopGame extends CookGameBase {
  readonly game = 'chop' as const;
  readonly beatS = COOK_CHOP_BEAT_S;
  /** The judgement bands — `perfect` is exactly the on-screen marker's radius (2026-09-14). */
  readonly bands: CookJudgeBands;
  /** The outer band (= out to good). The window the miss · stray-click rules use. */
  readonly window: number;
  readonly notes: CookNote[] = [];
  private next = 0;

  constructor(step: CookStepDef) {
    super(step);
    this.bands = cookJudgeBands(COOK_CHOP_WINDOW_S, this.beatS);
    this.window = this.bands.good;
    const cuts = Math.max(1, Math.round(COOK_CHOP_CUTS));
    for (let k = 0; k < cuts; k++) this.notes.push({ t: (COOK_LEAD_BEATS + k) * this.beatS, q: null });
  }

  get total(): number { return this.notes.length; }
  get upcoming(): CookNote | null { return this.notes[this.next] ?? null; }
  get score(): number { return cookJudgeAverage(this.judgements, this.total); }
  get completion(): number { return this.total > 0 ? clamp01(this.judgements.length / this.total) : 0; }

  private resolve(n: CookNote, q: CookJudge): void {
    if (n.q !== null) return;
    n.q = q;
    this.next++;
    this.judge(q);
    if (this.judgements.length >= this.total) this.finish();
  }

  /** Is a stray click earlier than the next marker that marker's miss (after the previous window closed) — otherwise ignored (the lead-in beats included). */
  private strayMiss(n: CookNote): boolean {
    const err = this.time - n.t;
    return err < -this.window && err >= -(this.beatS - this.window);
  }

  protected step_(): void {
    for (let n = this.upcoming; n && this.time > n.t + this.window + 1e-9 && !this.finished; n = this.upcoming) this.resolve(n, 'miss');
  }

  protected onPress(button: CookButton): void {
    if (button !== 'left') return;
    this.step_();
    const n = this.upcoming;
    if (!n || this.finished) return;
    const q = cookGrade(this.time - n.t, this.bands);
    if (q) { this.beat('cut', q); this.resolve(n, q); }
    else if (this.strayMiss(n)) { this.beat('cut', 'miss'); this.resolve(n, 'miss'); }
  }
}

/* ── Mincing ─────────────────────────────────────────────────────────────── */
export class MinceGame extends CookGameBase {
  readonly game = 'mince' as const;
  /** The left-right gauge (left click) 0 … 1. */
  h = 0;
  /** The up-down gauge (right click) 0 … 1. */
  v = 0;
  /** The previous click's button. */
  last: CookButton | null = null;
  /** The time both gauges filled, null on a forced end. */
  doneAt: number | null = null;
  /** Force-ended at `COOK_MINCE_MAX_S`. */
  timedOut = false;

  get score(): number {
    if (this.timedOut) return 0;
    return linearDown(this.doneAt ?? this.time, COOK_MINCE_PERFECT_S, COOK_MINCE_ZERO_S);
  }

  get completion(): number { return clamp01((this.h + this.v) / 2); }
  get maxTime(): number { return COOK_MINCE_MAX_S; }

  protected step_(): void { /* the forced end is done by `maxTime` · `onTimeout` */ }

  protected onTimeout(): void { this.timedOut = true; }

  protected onPress(button: CookButton): void {
    if (this.finished) return;
    if (button === 'left') {
      this.h = Math.min(1, this.h + COOK_MINCE_FILL);
      if (this.last === 'left') this.v = Math.max(0, this.v - COOK_MINCE_DRAIN);
    } else {
      this.v = Math.min(1, this.v + COOK_MINCE_FILL);
      if (this.last === 'right') this.h = Math.max(0, this.h - COOK_MINCE_DRAIN);
    }
    this.last = button;
    this.beat(button === 'left' ? 'mince_h' : 'mince_v');
    if (this.h >= 1 - 1e-9 && this.v >= 1 - 1e-9) { this.doneAt = this.time; this.finish(); }
  }
}

/* ── Grilling ────────────────────────────────────────────────────────────── */
export interface GrillPiece {
  defId: string;
  /** The time it hits the heat (seconds). */
  start: number;
  /** The time it takes to cook 0 → 100 % (seconds). */
  seconds: number;
  flipped: boolean;
  removed: boolean;
  burned: boolean;
  flipQ: CookJudge | null;
  doneQ: CookJudge | null;
  /** `cook_sizzle` has been emitted. */
  sizzled: boolean;
}

export class GrillGame extends CookGameBase {
  readonly game = 'grill' as const;
  readonly pieces: GrillPiece[];

  constructor(step: CookStepDef) {
    super(step);
    const items = step.items.length ? step.items : ['?'];
    this.pieces = items.map((defId, i) => ({
      defId, start: i * COOK_GRILL_STAGGER_S, seconds: cookGrillSeconds(defId),
      flipped: false, removed: false, burned: false, flipQ: null, doneQ: null, sizzled: false,
    }));
  }

  get total(): number { return this.pieces.length * 2; }
  get score(): number { return cookJudgeAverage(this.judgements, this.total); }
  get completion(): number { return this.total > 0 ? clamp01(this.judgements.length / this.total) : 0; }

  /** A piece's progress (0 before it hits the heat, and it keeps rising). */
  progressOf(i: number): number {
    const p = this.pieces[i];
    if (!p) return 0;
    return Math.max(0, (this.time - p.start) / Math.max(1e-6, p.seconds));
  }

  /** Is the piece on the heat (it has landed and has not come off yet). */
  onGrill(i: number): boolean {
    const p = this.pieces[i];
    return !!p && !p.removed && this.time >= p.start;
  }

  protected step_(): void {
    this.pieces.forEach((p, i) => {
      if (p.removed) return;
      if (!p.sizzled && this.time >= p.start) { p.sizzled = true; this.sound('cook_sizzle'); }
      if (this.progressOf(i) >= COOK_GRILL_BURN_AT) {
        p.burned = true;
        p.removed = true;
        if (p.flipQ === null) { p.flipQ = 'miss'; this.judge('miss'); }
        p.doneQ = 'miss';
        this.judge('miss');
        this.beat('burn', 'miss');
      }
    });
    this.checkDone();
  }

  protected onPiece(i: number): void {
    this.step_();
    const p = this.pieces[i];
    if (!p || this.finished || !this.onGrill(i)) return;
    const prog = this.progressOf(i);
    if (!p.flipped) {
      if (prog < COOK_GRILL_EARLY_REMOVE) {
        const off = Math.abs(prog - 0.5);
        const q: CookJudge = off <= COOK_GRILL_FLIP_PERFECT + 1e-9 ? 'perfect' : off <= COOK_GRILL_FLIP_GOOD + 1e-9 ? 'good' : 'miss';
        p.flipped = true;
        p.flipQ = q;
        this.judge(q);
        this.beat('flip', q);
        return;
      }
      // late — counted as a failed flip and taken off at once
      p.flipQ = 'miss';
      this.judge('miss');
    }
    const off = Math.abs(prog - 1);
    const q: CookJudge = off <= COOK_GRILL_DONE_PERFECT + 1e-9 ? 'perfect' : off <= COOK_GRILL_DONE_GOOD + 1e-9 ? 'good' : 'miss';
    p.removed = true;
    p.doneQ = q;
    this.judge(q);
    this.beat('remove', q);
    this.checkDone();
  }

  private checkDone(): void {
    if (!this.finished && this.pieces.every((p) => p.removed)) this.finish();
  }
}

/* ── Stir-frying ─────────────────────────────────────────────────────────── */
export class StirfryGame extends CookGameBase {
  readonly game = 'stirfry' as const;
  readonly beatS = COOK_STIRFRY_BEAT_S;
  /** The judgement bands — `perfect` is exactly the radius of the on-screen guide ring (2026-09-14). */
  readonly bands: CookJudgeBands = cookJudgeBands(COOK_STIRFRY_WINDOW_S, COOK_STIRFRY_BEAT_S);
  /** The outer band (= out to good). */
  readonly window = this.bands.good;
  /** The percentage bar 0 … 1. */
  bar = 0;
  /** The beat numbers already judged (0 = the first beat after the lead-in). */
  readonly usedBeats = new Set<number>();

  get score(): number { return cookJudgeAverage(this.judgements, this.judgements.length); }
  get completion(): number { return clamp01(this.bar); }

  /**
   * Stall prevention (2026-09-14): with not one beat clicked the bar never fills, so once **the number of beats the worst
   * player needs to fill the bar** (`1 / COOK_STIRFRY_FILL_MISS`) has passed it ends on the score so far. Anyone clicking on the beat ends long before that.
   */
  get maxTime(): number {
    return (COOK_LEAD_BEATS + Math.ceil(1 / Math.max(1e-6, COOK_STIRFRY_FILL_MISS))) * this.beatS;
  }

  /** The time beat k reaches the judgement line. */
  beatTime(k: number): number { return (COOK_LEAD_BEATS + k) * this.beatS; }
  /** The beat number nearest the current time (negative during the lead-in beats). */
  nearestBeat(t = this.time): number { return Math.round(t / Math.max(1e-6, this.beatS)) - COOK_LEAD_BEATS; }

  protected step_(): void { /* a missed beat is not judged — the bar simply does not fill */ }

  protected onPress(button: CookButton): void {
    if (button !== 'left') return;
    const k = this.nearestBeat();
    if (k < 0 || this.usedBeats.has(k)) return;          // a lead-in beat · a beat already judged
    this.usedBeats.add(k);
    const q = cookGrade(this.time - this.beatTime(k), this.bands) ?? 'miss';
    this.bar = Math.min(1, this.bar + (q === 'perfect' ? COOK_STIRFRY_FILL_PERFECT : q === 'good' ? COOK_STIRFRY_FILL_GOOD : COOK_STIRFRY_FILL_MISS));
    this.judge(q);
    this.beat('toss', q);
    if (this.bar >= 1 - 1e-9) this.finish();
  }
}

/* ── Stirring ────────────────────────────────────────────────────────────── */
export class StirGame extends CookGameBase {
  readonly game = 'stir' as const;
  /** Temperature 0 … 1. */
  temp = (COOK_STIR_BAND_LOW + COOK_STIR_BAND_HIGH) / 2;
  /** Doneness 0 … 1. */
  progress = 0;
  holding = false;
  /** Time spent inside the green band · total time (seconds). */
  bandTime = 0;
  elapsed = 0;
  private beatClock = 0;

  get ratio(): number { return this.elapsed > 0 ? clamp01(this.bandTime / this.elapsed) : 1; }
  get inBand(): boolean { return this.temp >= COOK_STIR_BAND_LOW && this.temp <= COOK_STIR_BAND_HIGH; }
  get score(): number { return linearUp(this.ratio, COOK_STIR_PERFECT_RATIO, COOK_STIR_ZERO_RATIO); }
  get completion(): number { return clamp01(this.progress); }
  /** Stall prevention (2026-09-14) — with no stirring at all, doneness never rises. Anyone who keeps stirring ends at `COOK_STIR_TIME_S`. */
  get maxTime(): number { return Math.max(1e-6, COOK_STIR_TIME_S) * STALL_TIMEOUT_MUL; }
  /** The current boil surge multiplier (1 + SURGE × sin) — the strength of the bubbles on screen. */
  get surge(): number { return 1 + COOK_STIR_SURGE * Math.sin((2 * Math.PI * this.time) / Math.max(1e-6, COOK_STIR_SURGE_S)); }

  protected step_(dt: number): void {
    // `time` has already been pushed by dt — the wave's phase is measured per sub-step, at that sub-step's time
    let left = dt;
    let t = this.time - dt;
    while (left > 1e-12 && !this.finished) {
      const h = Math.min(SUBSTEP_S, left);
      if (this.holding) {
        this.temp -= COOK_STIR_HEAT_FALL * h;
        const need = Math.max(1e-6, COOK_STIR_TIME_S);
        this.progress += h / need;
        this.beatClock += h;
        if (this.beatClock >= COOK_STIR_BEAT_INTERVAL_S) { this.beatClock -= COOK_STIR_BEAT_INTERVAL_S; this.beat('stir'); }
      } else {
        const surge = 1 + COOK_STIR_SURGE * Math.sin((2 * Math.PI * (t + h / 2)) / Math.max(1e-6, COOK_STIR_SURGE_S));
        this.temp += COOK_STIR_HEAT_RISE * surge * h;
      }
      this.temp = clamp01(this.temp);
      if (this.temp >= COOK_STIR_BAND_LOW && this.temp <= COOK_STIR_BAND_HIGH) this.bandTime += h;
      this.elapsed += h;
      t += h;
      left -= h;
      if (this.progress >= 1 - 1e-9) { this.progress = 1; this.finish(); }
    }
  }

  protected onPress(button: CookButton): void {
    if (button !== 'left' || this.holding) return;
    this.holding = true;
    this.beatClock = 0;
    this.beat('stir');
  }

  protected onRelease(button: CookButton): void {
    if (button === 'left') this.holding = false;
  }
}

/* ── Pouring ─────────────────────────────────────────────────────────────── */
export class PourGame extends CookGameBase {
  readonly game = 'pour' as const;
  /** The target amount (ml). */
  readonly target: number;
  /** The beaker's capacity (ml) = target × `COOK_POUR_BEAKER_MUL`. */
  readonly capacity: number;
  /** Flow 0 … 1. */
  flow = 0;
  /** The amount in the beaker (ml). */
  amount = 0;
  holding = false;
  /** Something has been poured at least once. */
  poured = false;
  /** The time spent still since the flow reached 0 (seconds). */
  idle = 0;
  /** It ended by overflowing. */
  overflowed = false;

  constructor(step: CookStepDef) {
    super(step);
    this.target = Math.max(1, step.targetMl ?? 1);
    this.capacity = this.target * Math.max(1, COOK_POUR_BEAKER_MUL);
  }

  /** The error against the target amount, as a fraction. */
  get error(): number { return Math.abs(this.amount - this.target) / this.target; }
  get score(): number { return this.overflowed ? 0 : linearDown(this.error, COOK_POUR_PERFECT_ERR, COOK_POUR_ZERO_ERR); }
  get completion(): number { return clamp01(this.amount / Math.max(1e-6, this.target)); }
  /**
   * Stall prevention (2026-09-14) — with nothing ever poured, `poured` never goes up and it never ends. It grants a few
   * times the time a full pour takes (at 100 % flow), so even someone pouring in small doses never reaches it.
   */
  get maxTime(): number {
    return (COOK_POUR_RAMP_S * 2 + this.capacity / Math.max(1e-6, COOK_POUR_RATE_ML_S) + COOK_POUR_SETTLE_S) * STALL_TIMEOUT_MUL;
  }

  protected step_(dt: number): void {
    let left = dt;
    const want = this.holding ? 1 : 0;
    const ramp = COOK_POUR_RAMP_S > 0 ? 1 / COOK_POUR_RAMP_S : Infinity;
    // the flow is linear up to its target (0 or 1) — the amount poured over that stretch is integrated exactly, as a trapezoid
    if (this.flow !== want) {
      const reach = Math.abs(want - this.flow) / ramp;
      const h = Math.min(left, reach);
      const f1 = h >= reach ? want : this.flow + Math.sign(want - this.flow) * ramp * h;
      this.amount += COOK_POUR_RATE_ML_S * h * (this.flow + f1) / 2;
      this.flow = f1;
      left -= h;
      if (this.flow === 0 && !this.holding) this.idle = 0;
    }
    if (left > 0) {
      if (this.flow > 0) this.amount += COOK_POUR_RATE_ML_S * this.flow * left;
      else if (!this.holding) this.idle += left;
    }
    if (this.amount > 0) this.poured = true;
    if (this.amount >= this.capacity - 1e-9) {
      this.amount = this.capacity;
      this.overflowed = true;
      this.flow = 0;
      if (this.holding) this.beat('pour_stop');
      this.holding = false;
      this.finish();
      return;
    }
    if (this.poured && this.flow === 0 && !this.holding && this.idle >= COOK_POUR_SETTLE_S - 1e-9) this.finish();
  }

  protected onPress(button: CookButton): void {
    if (button !== 'left' || this.holding) return;
    this.holding = true;
    this.idle = 0;
    this.beat('pour_start');
  }

  protected onRelease(button: CookButton): void {
    if (button !== 'left' || !this.holding) return;
    this.holding = false;
    this.beat('pour_stop');
  }
}

export type AnyCookGame = ChopGame | MinceGame | GrillGame | StirfryGame | StirGame | PourGame;

/** One step's judge object. */
export function createCookGame(step: CookStepDef): AnyCookGame {
  switch (step.game) {
    case 'chop': return new ChopGame(step);
    case 'mince': return new MinceGame(step);
    case 'grill': return new GrillGame(step);
    case 'stirfry': return new StirfryGame(step);
    case 'stir': return new StirGame(step);
    default: return new PourGame(step);
  }
}
