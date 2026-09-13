/**
 * src/housing/parts/GymGames.ts — **운동 미니게임 판정** (A-3a, 2026-09-12). DOM · ctx 없는 순수 클래스.
 *
 * 화면(`ui/gym/*`)은 이 객체를 그리기만 하고, 스모크는 화면 없이 이것만 몰아 판정을 검사한다
 * (`HousingSystem.gymDebug.makeGame`). 시간은 **스스로 들고 있다** — `update(dt)` 가 `time` 을 밀고, `press` ·
 * `release` 는 **지금 `time`** 에서 판정한다. 그래서 화면은 키를 넘기기 직전에 `performance.now()` 까지 `update` 를
 * 먼저 부른다 (틱 간격만큼 판정이 늦어지지 않게).
 *
 * 판정 규칙은 설계안 §4 그대로이고 수치는 전부 `GYM_*` (`data/constants.csv`):
 *   • 점수 = 판정마다 완벽 `GYM_SCORE_PERFECT` · 성공 `GYM_SCORE_GOOD` · 실패 0 의 **평균** (0 … 1).
 *   • `press` 벤치프레스 — 커서가 바(0 … 1) 위를 왕복하고, 누른 순간 가운데(0.5)와의 거리로 판정. 회차마다 빨라진다.
 *   • `breath` 호흡 달리기 — 후 · 후 (탭) · 하 (꾹). 하 는 시작 오차와 떼는 오차가 **둘 다** 창 안이어야 한다.
 *   • `cycle` 사이클링 — 박자마다 왼발(A) · 오른발(D) 번갈아. 틀린 발 · 놓침은 실패.
 *
 * 박자 게임(호흡 · 사이클)의 두 가지 공통 규칙 (설계안에 없던 빈칸을 여기서 정했다):
 *   • **예비 박자** `GYM_LEAD_BEATS` 박 — 첫 표식이 판정선까지 걸어올 시간. 그 사이의 입력은 무시한다.
 *   • **헛누름은 다음 표식의 실패**다 — 다음 표식 창보다 이르지만 직전 창이 닫힌 뒤(`t − (박자 − 창)` 이후)에 누르면
 *     그 표식을 실패로 친다. 그렇지 않으면 Space 를 연타해 모든 창을 줍는 것이 최선의 전략이 된다.
 *
 * 2026-09-13 (비디오게임, H2 — docs/plans/library-series-games.md §3): **디스크별 튜닝** `GymGameTuning` 을 받는다
 * (`createGymGame(kind, tuning?)`). 계약의 뜻 그대로 —
 *   • `speedMul`  벤치프레스 커서 속도 × · 박자형 박자 간격 ÷ (「하」 를 쥐는 길이도 같이 ÷)
 *   • `windowMul` 벤치프레스 성공 · 완벽 구역 × · 박자형 판정 창 × (「하」 떼기 창도 같이 ×)
 *   • `countMul`  판정 횟수 × (반올림, 최소 1)
 *   • `pattern`   박자형 표식 패턴 — 호흡형 `t` · `h` · `r`, 사이클형 `L` · `R` · `r` 를 `-` 로 잇고 판정 횟수만큼 반복.
 *                 `r` = 한 박 쉼. 이 게임에 맞지 않는 토큰은 버리고, 표식 토큰이 하나도 없으면 헬스 기본 패턴.
 * **튜닝이 없으면(또는 전부 1 · 빈 패턴이면) 헬스와 비트 하나 다르지 않다** — 곱하는 1 · 나누는 1 은 부동소수에서도 같은 값이고,
 * 기본 패턴은 옛 생성 루프와 같은 순서로 같은 덧셈을 한다 (`smoke-gym` 의 기대값이 그대로 산다).
 */
import type { GymGameTuning, GymMinigame } from '@/shared';
import {
  GYM_BREATH_BEAT_S, GYM_BREATH_CYCLES, GYM_BREATH_HOLD_S, GYM_BREATH_HOLD_TOL_S, GYM_BREATH_WINDOW_S,
  GYM_CYCLE_BEAT_S, GYM_CYCLE_STROKES, GYM_CYCLE_WINDOW_S,
  GYM_PRESS_PERFECT, GYM_PRESS_REPS, GYM_PRESS_SPEED, GYM_PRESS_SPEED_STEP, GYM_PRESS_ZONE,
  GYM_LEAD_BEATS, GYM_SCORE_GOOD, GYM_SCORE_PERFECT,
} from '@/shared';

export type GymQuality = 'perfect' | 'good' | 'miss';
/** 논리 입력 — 화면이 `Keys.JUMP` · `Keys.LEFT` · `Keys.RIGHT` 를 사용 시점에 읽어 이것으로 옮긴다. */
export type GymAction = 'jump' | 'left' | 'right';
export type GymGameEvent =
  | { type: 'judge'; quality: GymQuality; index: number; total: number }
  | { type: 'sound'; id: 'gym_breath' | 'gym_pedal' };

/**
 * 박자 게임의 예비 박자 수 — 첫 표식이 오른쪽 끝에서 판정선까지 오는 동안 (길이 자체는 박자 `GYM_*_BEAT_S` 가 정한다).
 * 값의 원본은 `data/constants.csv` 다 (2026-09-12 리드: 「수치는 코드에 적지 않는다」). 화면이 이 경로로 가져가므로 다시 내보낸다.
 */
export { GYM_LEAD_BEATS };

export const GYM_QUALITY_LABEL_KO: Readonly<Record<GymQuality, string>> = { perfect: '완벽', good: '좋음', miss: '실패' };

export function qualityScore(q: GymQuality): number {
  return q === 'perfect' ? GYM_SCORE_PERFECT : q === 'good' ? GYM_SCORE_GOOD : 0;
}

/** 판정들의 평균 (분모 = 세션의 판정 수). 0 … 1 로 자른다. */
export function scoreOf(judgements: readonly GymQuality[], total: number): number {
  if (total <= 0) return 0;
  let sum = 0;
  for (const q of judgements) sum += qualityScore(q);
  return Math.max(0, Math.min(1, sum / total));
}

/** 박자 오차 → 판정 (창의 1/3 안 = 완벽, 창 안 = 성공), 창 밖이면 null. */
function grade(err: number, window: number): GymQuality | null {
  const e = Math.abs(err);
  if (e <= window / 3) return 'perfect';
  if (e <= window) return 'good';
  return null;
}

/* ── 튜닝 (2026-09-13) ───────────────────────────────────────────────────── */

/** 박자 게임 판정 창의 상한 = 박자 × 이 값 (구현 값) — 창이 박자의 절반을 넘으면 이웃 표식의 창과 겹쳐 헛누름 규칙이 깨진다. */
const WINDOW_MAX_OF_BEAT = 0.5;

/** 튜닝 배수 하나 — 유한한 양수만, 아니면 1 (= 헬스 기본). */
export function tuningMul(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 1;
}

/** 판정 횟수 = `max(1, round(기본 × countMul))`. */
export function tunedCount(base: number, countMul: number | undefined): number {
  return Math.max(1, Math.round(base * tuningMul(countMul)));
}

/** 패턴 토큰 — 호흡형 `t` (탭) · `h` (꾹) · 사이클형 `L` · `R` · 공통 `r` (한 박 쉼). */
export type GymPatternToken = 't' | 'h' | 'L' | 'R' | 'r';
const BREATH_TOKENS: readonly GymPatternToken[] = ['t', 'h', 'r'];
const CYCLE_TOKENS: readonly GymPatternToken[] = ['L', 'R', 'r'];

/**
 * `t-t-h-r` 같은 패턴을 토큰 목록으로 — `allowed` 밖의 토큰은 버린다. 표식 토큰(`r` 아닌 것)이 하나도 없으면 빈 배열 (= 기본 패턴).
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
  /** 이 세션의 판정 수. */
  abstract readonly total: number;
  /** 판정 순서대로. */
  readonly judgements: GymQuality[] = [];
  /** 게임 시작부터 흐른 시간 (초). */
  time = 0;
  private events: GymGameEvent[] = [];

  get done(): boolean { return this.judgements.length >= this.total; }
  get score(): number { return scoreOf(this.judgements, this.total); }
  counts(): Record<GymQuality, number> {
    const c = { perfect: 0, good: 0, miss: 0 };
    for (const q of this.judgements) c[q]++;
    return c;
  }

  /** 쌓인 이벤트를 꺼내고 비운다 (화면이 틱마다 · 키마다 부른다). */
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
  protected onRelease(_action: GymAction): void { /* 탭만 쓰는 게임 */ }
}

/* ── 벤치프레스 ──────────────────────────────────────────────────────────── */
export class PressGame extends GymGame {
  readonly minigame = 'press' as const;
  readonly total: number;
  /** 성공 구역 반폭 (바 폭 비율) — `GYM_PRESS_ZONE × windowMul`, 0.5 이하. 화면이 이 값으로 구역을 그린다. */
  readonly zone: number;
  /** 완벽 구역 반폭 — `GYM_PRESS_PERFECT × windowMul`, 성공 구역 이하. */
  readonly perfect: number;
  /** 커서 속도 배수 (`speedMul`). */
  readonly speedMul: number;
  /** 커서 위치 0 … 1 (바 폭 비율, 가운데 0.5). 왼쪽 끝에서 오른쪽으로 출발한다. */
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

  /** 지금 회차의 커서 속도 (바 폭/초). */
  get speed(): number { return (GYM_PRESS_SPEED + this.judgements.length * GYM_PRESS_SPEED_STEP) * this.speedMul; }

  protected step(dt: number): void {
    const v = this.speed;
    if (!(v > 0)) return;
    let d = (v * dt) % 2;                         // 왕복 한 번 = 바 폭 2
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

/* ── 박자 게임 공통 ──────────────────────────────────────────────────────── */
export interface BeatNote {
  /** 표식이 판정선에 닿는 시각 (초). */
  t: number;
  /** 사이클링: 밟을 발. 호흡: 늘 null. */
  lane: 'left' | 'right' | null;
  /** 호흡의 「하」 (꾹 누른 채 `GYM_BREATH_HOLD_S` 뒤에 뗀다). */
  hold: boolean;
  /** 이 표식의 판정, 아직이면 null. */
  q: GymQuality | null;
  /** 「하」: 누르기 시작한 순간의 판정 (누르고 있는 중이면 null 이 아니다). */
  start: GymQuality | null;
}

abstract class BeatGame extends GymGame {
  abstract readonly notes: readonly BeatNote[];
  abstract readonly beat: number;
  abstract readonly window: number;
  /** 첫 미판정 표식. */
  protected next = 0;

  get total(): number { return this.notes.length; }
  /** 판정을 기다리는 표식 (화면 · 스모크), 끝났으면 null. */
  get upcoming(): BeatNote | null { return this.notes[this.next] ?? null; }

  protected resolve(n: BeatNote, q: GymQuality): void {
    if (n.q !== null) return;
    n.q = q;
    this.next++;
    this.judge(q);
  }

  /** 다음 표식보다 이른 헛누름이 그 표식의 실패인가 (직전 창이 닫힌 뒤) — 아니면 무시. */
  protected strayMiss(n: BeatNote): boolean {
    const err = this.time - n.t;
    return err < -this.window && err >= -(this.beat - this.window);
  }
}

/* ── 호흡 달리기 (후 · 후 · 하) ──────────────────────────────────────────── */
export class BreathGame extends BeatGame {
  readonly minigame = 'breath' as const;
  readonly beat: number;
  readonly window: number;
  readonly holdS: number;
  readonly holdTol: number;
  readonly notes: BeatNote[] = [];

  constructor(tuning?: GymGameTuning) {
    super();
    const speed = tuningMul(tuning?.speedMul), win = tuningMul(tuning?.windowMul);
    this.beat = GYM_BREATH_BEAT_S / speed;
    this.holdS = GYM_BREATH_HOLD_S / speed;
    this.window = Math.min(GYM_BREATH_WINDOW_S * win, this.beat * WINDOW_MAX_OF_BEAT);
    this.holdTol = Math.min(GYM_BREATH_HOLD_TOL_S * win, this.holdS * WINDOW_MAX_OF_BEAT);
    const B = this.beat;
    const cycles = Math.max(1, Math.round(GYM_BREATH_CYCLES));
    const total = tunedCount(cycles * 3, tuning?.countMul);
    const custom = parseGymPattern(tuning?.pattern, BREATH_TOKENS);
    const seq: readonly GymPatternToken[] = custom.length ? custom : ['t', 't', 'h'];   // 헬스 기본: 후 · 후 · 하
    let t = GYM_LEAD_BEATS * B;
    for (let i = 0, made = 0; made < total; i++) {
      const tok = seq[i % seq.length];
      if (tok === 'r') { t += B; continue; }            // 한 박 쉼
      const hold = tok === 'h';
      this.notes.push({ t, lane: null, hold, q: null, start: null });
      made++;
      if (hold) t += this.holdS + B;                    // 「하」 를 다 뗀 뒤 한 박 쉬고 다음 표식
      else t += B;
    }
  }

  /** 「하」 를 누르고 있는 중인가. */
  get holding(): boolean { const n = this.upcoming; return !!n && n.hold && n.start !== null; }

  protected step(): void {
    for (let n = this.upcoming; n; n = this.upcoming) {
      if (n.hold && n.start !== null) {
        if (this.time > n.t + this.holdS + this.holdTol) { this.resolve(n, 'miss'); continue; }   // 너무 오래 쥐었다
      } else if (this.time > n.t + this.window) { this.resolve(n, 'miss'); continue; }            // 놓쳤다
      break;
    }
  }

  protected onPress(action: GymAction): void {
    if (action !== 'jump') return;
    this.step();
    const n = this.upcoming;
    if (!n || (n.hold && n.start !== null)) return;
    const q = grade(this.time - n.t, this.window);
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
    if (err > this.holdTol) { this.resolve(n, 'miss'); return; }                                // 너무 일찍 뗐다
    this.resolve(n, n.start === 'perfect' && err <= this.holdTol / 3 ? 'perfect' : 'good');
  }
}

/* ── 사이클링 (A · D 번갈아) ─────────────────────────────────────────────── */
export class CycleGame extends BeatGame {
  readonly minigame = 'cycle' as const;
  readonly beat: number;
  readonly window: number;
  readonly notes: BeatNote[] = [];

  constructor(tuning?: GymGameTuning) {
    super();
    this.beat = GYM_CYCLE_BEAT_S / tuningMul(tuning?.speedMul);
    this.window = Math.min(GYM_CYCLE_WINDOW_S * tuningMul(tuning?.windowMul), this.beat * WINDOW_MAX_OF_BEAT);
    const strokes = tunedCount(Math.max(1, Math.round(GYM_CYCLE_STROKES)), tuning?.countMul);
    const custom = parseGymPattern(tuning?.pattern, CYCLE_TOKENS);
    if (!custom.length) {
      // 헬스 기본: 왼발 · 오른발 번갈아, 쉼 없음
      for (let k = 0; k < strokes; k++) {
        this.notes.push({ t: (GYM_LEAD_BEATS + k) * this.beat, lane: k % 2 === 0 ? 'left' : 'right', hold: false, q: null, start: null });
      }
      return;
    }
    // 패턴: 토큰 하나 = 한 박 (쉼 `r` 도 한 박을 차지한다)
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
    const q = grade(this.time - n.t, this.window);
    if (q) {
      if (action === n.lane) { this.sound('gym_pedal'); this.resolve(n, q); }
      else this.resolve(n, 'miss');                                                                  // 틀린 발
    } else if (this.strayMiss(n)) this.resolve(n, 'miss');
  }
}

/** 판정 객체 하나. `tuning` 생략 = 헬스 기본 (2026-09-13: 비디오게임 디스크가 튜닝을 넘긴다). */
export function createGymGame(kind: GymMinigame, tuning?: GymGameTuning): GymGame {
  return kind === 'press' ? new PressGame(tuning) : kind === 'breath' ? new BreathGame(tuning) : new CycleGame(tuning);
}

export function isBeatGame(g: GymGame): g is BreathGame | CycleGame {
  return g instanceof BreathGame || g instanceof CycleGame;
}
