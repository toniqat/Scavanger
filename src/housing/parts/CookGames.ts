/**
 * src/housing/parts/CookGames.ts — **요리 미니게임 판정** (2026-09-13, `docs/plans/cooking-minigames.md` §4). DOM · ctx 없는 순수 클래스.
 *
 * `parts/GymGames.ts` 를 그대로 본떴다: 화면(`ui/cook/*`)은 이 객체를 그리기만 하고, 스모크는 화면 없이 이것만 몰아
 * 판정을 검사한다 (`HousingSystem.cookDebug.makeGame`). 시간은 **스스로 들고 있다** — `update(dt)` 가 `time` 을 밀고
 * `press` · `release` · `clickPiece` 는 **지금 `time`** 에서 판정한다. 그래서 화면은 입력을 넘기기 직전에 그 순간까지
 * `update` 를 먼저 부른다.
 *
 * 수치는 전부 `shared/cooking` 의 `COOK_*` (`data/constants.csv`) — 여기에는 판정에 쓰는 숫자가 하나도 없다.
 *   • 판정 한 번 = 완벽 `COOK_SCORE_PERFECT` · 좋음 `COOK_SCORE_GOOD` · 실패 0. 박자 오차 ≤ 창/3 완벽, ≤ 창 좋음.
 *   • `chop`    썰기   — 예비 박 뒤 박자마다 표식 `COOK_CHOP_CUTS` 개. 창 밖 헛클릭은 **다음 표식의 실패**(직전 창이 닫힌 뒤) —
 *                        헬스장 `BeatGame.strayMiss` 와 같은 규칙. 점수 = 판정 평균.
 *   • `mince`   다지기 — 좌클릭 = 좌우 게이지 · 우클릭 = 상하 게이지 +FILL, **직전 클릭과 같은 버튼이면** 반대 게이지 −DRAIN.
 *                        둘 다 1 이면 끝(걸린 시간으로 선형 점수), `COOK_MINCE_MAX_S` 에 강제 끝(0 점).
 *   • `grill`   굽기   — 조각 i 는 `i × STAGGER` 뒤부터 `cookGrillSeconds` 에 걸쳐 익는다(계속 오른다). 조각 클릭 = 뒤집기 /
 *                        (이미 늦었으면 뒤집기 실패 + 꺼내기) / 뒤집은 조각은 꺼내기. `BURN_AT` 에서 타서 내려간다(남은 판정 실패).
 *                        점수 = 조각 × 2 판정의 평균.
 *   • `stirfry` 볶기   — 클릭은 가장 가까운 박자에 판정하고 **한 박자에 한 번만**. 판정마다 바가 찬다, 바 ≥ 1 이면 끝. 판정 평균.
 *   • `stir`    젓기   — 누르는 동안 온도 ↓ · 완성 ↑, 떼면 온도 ↑(끓어오름 파동). 초록 구간에 머문 시간 비율로 선형 점수.
 *   • `pour`    붓기   — 흐름이 `RAMP_S` 에 걸쳐 0 ↔ 1 로 선형으로 간다. 한 번 부은 뒤 흐름 0 으로 `SETTLE_S` 가만히 있으면 끝,
 *                        비커(목표 × `BEAKER_MUL`)가 넘치면 곧장 끝. 목표량 오차 비율로 선형 점수.
 *
 * 연출 이벤트(`drain()`): `judge`(판정 하나) · `beat`(hub 손 동작 · 소리 — `housing:cookBeat` 로 나간다) · `sound`(굽기 조각이 불에 닿음).
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
  cookGrillSeconds,
} from '@/shared';

/** 마우스 버튼 — 화면이 `pointerdown.button` 0 / 2 를 이것으로 옮긴다. */
export type CookButton = 'left' | 'right';

export type CookGameEvent =
  | { type: 'judge'; quality: CookJudge; index: number }
  | { type: 'beat'; action: CookBeatAction; quality: CookJudge | null }
  | { type: 'sound'; id: 'cook_sizzle' };

/**
 * 젓기: 누르고 있는 동안 `stir` 연출 이벤트를 다시 내는 간격 (초). **판정과 무관한 연출 박자**다 — hub 의 국자는 마지막 `stir` 뒤
 * 0.45 초가 지나면 멈추므로(「뗐다」 이벤트가 없다) 그보다 넉넉히 짧아야 한다. 소리(`cook_stir`)는 화면이 따로 솎는다 (구현 값, 밸런스 수치가 아니다).
 */
export const COOK_STIR_BEAT_INTERVAL_S = 0.25;
/** 적분 한 걸음의 상한 (초) — 젓기 온도가 틱 간격(최대 수십 ms)에 따라 달라지지 않게 잘게 나눈다 (구현 값). */
const SUBSTEP_S = 1 / 240;

export function cookJudgeScore(q: CookJudge): number {
  return q === 'perfect' ? COOK_SCORE_PERFECT : q === 'good' ? COOK_SCORE_GOOD : 0;
}

/** 판정들의 평균 (분모 = `total`). 0 … 1 로 자른다. */
export function cookJudgeAverage(judgements: readonly CookJudge[], total: number): number {
  if (total <= 0) return 0;
  let sum = 0;
  for (const q of judgements) sum += cookJudgeScore(q);
  return clamp01(sum / total);
}

/** 오차 → 판정 (창의 1/3 안 = 완벽, 창 안 = 좋음), 창 밖이면 null. */
export function cookGrade(err: number, window: number): CookJudge | null {
  const e = Math.abs(err);
  if (e <= window / 3 + 1e-9) return 'perfect';
  if (e <= window + 1e-9) return 'good';
  return null;
}

function clamp01(v: number): number { return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0; }

/** v ≤ best → 1, v ≥ worst → 0, 사이 선형 (best < worst). */
function linearDown(v: number, best: number, worst: number): number {
  if (v <= best) return 1;
  if (v >= worst) return 0;
  return clamp01(1 - (v - best) / (worst - best));
}

/** v ≥ best → 1, v ≤ worst → 0, 사이 선형 (worst < best). */
function linearUp(v: number, best: number, worst: number): number {
  if (v >= best) return 1;
  if (v <= worst) return 0;
  return clamp01((v - worst) / (best - worst));
}

export abstract class CookGameBase {
  abstract readonly game: CookGame;
  /** 판정 순서대로 (다지기 · 젓기 · 붓기는 판정이 없어 비어 있다). */
  readonly judgements: CookJudge[] = [];
  /** 게임 시작부터 흐른 시간 (초). */
  time = 0;
  protected finished = false;
  private events: CookGameEvent[] = [];

  constructor(readonly step: CookStepDef) {}

  get done(): boolean { return this.finished; }
  /** 단계 점수 0 … 1 (끝나기 전에는 지금까지의 잠정값). */
  abstract get score(): number;

  counts(): Record<CookJudge, number> {
    const c = { perfect: 0, good: 0, miss: 0 };
    for (const q of this.judgements) c[q]++;
    return c;
  }

  /** 쌓인 이벤트를 꺼내고 비운다 (화면이 틱마다 · 입력마다 부른다). */
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
  }

  press(button: CookButton): void { if (!this.finished) this.onPress(button); }
  release(button: CookButton): void { if (!this.finished) this.onRelease(button); }
  /** 굽기 조각 클릭 — 다른 게임에서는 아무 일도 없다. */
  clickPiece(index: number): void { if (!this.finished) this.onPiece(index); }

  protected judge(quality: CookJudge): void {
    this.judgements.push(quality);
    this.events.push({ type: 'judge', quality, index: this.judgements.length - 1 });
  }
  protected beat(action: CookBeatAction, quality: CookJudge | null = null): void { this.events.push({ type: 'beat', action, quality }); }
  protected sound(id: 'cook_sizzle'): void { this.events.push({ type: 'sound', id }); }
  protected finish(): void { this.finished = true; }

  /** `step` 은 계약 필드 이름이라 판정 틱은 `step_` 이다. */
  protected abstract step_(dt: number): void;
  protected onPress(_button: CookButton): void { /* 게임마다 */ }
  protected onRelease(_button: CookButton): void { /* 탭만 쓰는 게임 */ }
  protected onPiece(_index: number): void { /* 굽기만 */ }
}

/* ── 썰기 ────────────────────────────────────────────────────────────────── */
export interface CookNote {
  /** 표식이 판정선에 닿는 시각 (초). */
  t: number;
  /** 이 표식의 판정, 아직이면 null. */
  q: CookJudge | null;
}

export class ChopGame extends CookGameBase {
  readonly game = 'chop' as const;
  readonly beatS = COOK_CHOP_BEAT_S;
  readonly window = COOK_CHOP_WINDOW_S;
  readonly notes: CookNote[] = [];
  private next = 0;

  constructor(step: CookStepDef) {
    super(step);
    const cuts = Math.max(1, Math.round(COOK_CHOP_CUTS));
    for (let k = 0; k < cuts; k++) this.notes.push({ t: (COOK_LEAD_BEATS + k) * this.beatS, q: null });
  }

  get total(): number { return this.notes.length; }
  get upcoming(): CookNote | null { return this.notes[this.next] ?? null; }
  get score(): number { return cookJudgeAverage(this.judgements, this.total); }

  private resolve(n: CookNote, q: CookJudge): void {
    if (n.q !== null) return;
    n.q = q;
    this.next++;
    this.judge(q);
    if (this.judgements.length >= this.total) this.finish();
  }

  /** 다음 표식보다 이른 헛클릭이 그 표식의 실패인가 (직전 창이 닫힌 뒤) — 아니면 무시 (예비 박자 포함). */
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
    const q = cookGrade(this.time - n.t, this.window);
    if (q) { this.beat('cut', q); this.resolve(n, q); }
    else if (this.strayMiss(n)) { this.beat('cut', 'miss'); this.resolve(n, 'miss'); }
  }
}

/* ── 다지기 ──────────────────────────────────────────────────────────────── */
export class MinceGame extends CookGameBase {
  readonly game = 'mince' as const;
  /** 좌우 게이지 (좌클릭) 0 … 1. */
  h = 0;
  /** 상하 게이지 (우클릭) 0 … 1. */
  v = 0;
  /** 직전 클릭 버튼. */
  last: CookButton | null = null;
  /** 두 게이지를 다 채운 시각, 강제 종료면 null. */
  doneAt: number | null = null;
  /** `COOK_MINCE_MAX_S` 에 강제로 끝났다. */
  timedOut = false;

  get score(): number {
    if (this.timedOut) return 0;
    return linearDown(this.doneAt ?? this.time, COOK_MINCE_PERFECT_S, COOK_MINCE_ZERO_S);
  }

  protected step_(): void {
    if (this.time >= COOK_MINCE_MAX_S) { this.timedOut = true; this.finish(); }
  }

  protected onPress(button: CookButton): void {
    this.step_();
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

/* ── 굽기 ────────────────────────────────────────────────────────────────── */
export interface GrillPiece {
  defId: string;
  /** 불에 닿는 시각 (초). */
  start: number;
  /** 0 → 100 % 익는 시간 (초). */
  seconds: number;
  flipped: boolean;
  removed: boolean;
  burned: boolean;
  flipQ: CookJudge | null;
  doneQ: CookJudge | null;
  /** `cook_sizzle` 을 냈다. */
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

  /** 조각의 진행도 (불에 닿기 전 0, 계속 오른다). */
  progressOf(i: number): number {
    const p = this.pieces[i];
    if (!p) return 0;
    return Math.max(0, (this.time - p.start) / Math.max(1e-6, p.seconds));
  }

  /** 조각이 불 위에 있는가 (닿았고 아직 안 내려갔다). */
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
      // 늦었다 — 뒤집기 실패로 치고 곧장 꺼낸다
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

/* ── 볶기 ────────────────────────────────────────────────────────────────── */
export class StirfryGame extends CookGameBase {
  readonly game = 'stirfry' as const;
  readonly beatS = COOK_STIRFRY_BEAT_S;
  readonly window = COOK_STIRFRY_WINDOW_S;
  /** 퍼센트 바 0 … 1. */
  bar = 0;
  /** 판정한 박자 번호 (0 = 예비 박 뒤 첫 박자). */
  readonly usedBeats = new Set<number>();

  get score(): number { return cookJudgeAverage(this.judgements, this.judgements.length); }

  /** 박자 k 가 판정선에 닿는 시각. */
  beatTime(k: number): number { return (COOK_LEAD_BEATS + k) * this.beatS; }
  /** 지금 시각에 가장 가까운 박자 번호 (예비 박이면 음수). */
  nearestBeat(t = this.time): number { return Math.round(t / Math.max(1e-6, this.beatS)) - COOK_LEAD_BEATS; }

  protected step_(): void { /* 박자를 놓쳐도 판정이 없다 — 바가 안 찰 뿐 */ }

  protected onPress(button: CookButton): void {
    if (button !== 'left') return;
    const k = this.nearestBeat();
    if (k < 0 || this.usedBeats.has(k)) return;          // 예비 박 · 이미 판정한 박자
    this.usedBeats.add(k);
    const q = cookGrade(this.time - this.beatTime(k), this.window) ?? 'miss';
    this.bar = Math.min(1, this.bar + (q === 'perfect' ? COOK_STIRFRY_FILL_PERFECT : q === 'good' ? COOK_STIRFRY_FILL_GOOD : COOK_STIRFRY_FILL_MISS));
    this.judge(q);
    this.beat('toss', q);
    if (this.bar >= 1 - 1e-9) this.finish();
  }
}

/* ── 젓기 ────────────────────────────────────────────────────────────────── */
export class StirGame extends CookGameBase {
  readonly game = 'stir' as const;
  /** 온도 0 … 1. */
  temp = (COOK_STIR_BAND_LOW + COOK_STIR_BAND_HIGH) / 2;
  /** 완성 0 … 1. */
  progress = 0;
  holding = false;
  /** 초록 구간 안에 머문 시간 · 전체 시간 (초). */
  bandTime = 0;
  elapsed = 0;
  private beatClock = 0;

  get ratio(): number { return this.elapsed > 0 ? clamp01(this.bandTime / this.elapsed) : 1; }
  get inBand(): boolean { return this.temp >= COOK_STIR_BAND_LOW && this.temp <= COOK_STIR_BAND_HIGH; }
  get score(): number { return linearUp(this.ratio, COOK_STIR_PERFECT_RATIO, COOK_STIR_ZERO_RATIO); }
  /** 지금의 끓어오름 배수 (1 + SURGE × sin) — 화면의 거품 세기. */
  get surge(): number { return 1 + COOK_STIR_SURGE * Math.sin((2 * Math.PI * this.time) / Math.max(1e-6, COOK_STIR_SURGE_S)); }

  protected step_(dt: number): void {
    // `time` 은 이미 dt 만큼 밀렸다 — 파동의 위상은 걸음마다 그 걸음의 시각으로 잰다
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

/* ── 붓기 ────────────────────────────────────────────────────────────────── */
export class PourGame extends CookGameBase {
  readonly game = 'pour' as const;
  /** 목표량 (ml). */
  readonly target: number;
  /** 비커 용량 (ml) = 목표 × `COOK_POUR_BEAKER_MUL`. */
  readonly capacity: number;
  /** 흐름 0 … 1. */
  flow = 0;
  /** 비커에 든 양 (ml). */
  amount = 0;
  holding = false;
  /** 한 번이라도 부었다. */
  poured = false;
  /** 흐름이 0 이 된 뒤 가만히 있던 시간 (초). */
  idle = 0;
  /** 넘쳐서 끝났다. */
  overflowed = false;

  constructor(step: CookStepDef) {
    super(step);
    this.target = Math.max(1, step.targetMl ?? 1);
    this.capacity = this.target * Math.max(1, COOK_POUR_BEAKER_MUL);
  }

  /** 목표량과의 오차 비율. */
  get error(): number { return Math.abs(this.amount - this.target) / this.target; }
  get score(): number { return this.overflowed ? 0 : linearDown(this.error, COOK_POUR_PERFECT_ERR, COOK_POUR_ZERO_ERR); }

  protected step_(dt: number): void {
    let left = dt;
    const want = this.holding ? 1 : 0;
    const ramp = COOK_POUR_RAMP_S > 0 ? 1 / COOK_POUR_RAMP_S : Infinity;
    // 흐름은 목표(0 또는 1)까지 선형 — 그 구간의 부은 양은 사다리꼴로 정확히 적분한다
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

/** 단계 하나의 판정 객체. */
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
