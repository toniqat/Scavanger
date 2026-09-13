/**
 * src/shared/cooking.ts — **요리 미니게임 · 요리 품질** 계약 (2026-09-13, `docs/plans/cooking-minigames.md`, 사용자 결정).
 *
 * 조리대(`workbench_cook`)는 더 이상 인벤토리 제작 창을 열지 않는다 — housing 의 **조리대 화면**이 열린다. 요리 하나를 고르고
 * 「조리 시작」을 누르면 그 요리의 미니게임 1–3개(`data/cook_steps.csv`)를 순서대로 한다. 단계마다 점수(0 … 1)가 나오고
 * **요리 점수 = 단계 점수의 평균**, 그 점수가 **요리 품질**(별 0 … 5, `MEAL_QUALITY_*`)이 되어 만들어진 요리 아이템에 붙는다
 * (`ItemInstance.quality`). 먹으면 능력치 수치가 `× (1 + MEAL_QUALITY_BONUS[품질])` 로 오른다 (최대 +25 %).
 * 점수가 낮아도 요리는 **늘 나온다** (품질 0 = 원래 수치 100 %). 한 번에 한 개. 중간에 닫으면 아무것도 소모되지 않는다.
 *
 * 미니게임 6종 (판정 수치는 전부 `data/constants.csv` 의 `COOK_*`):
 *   • `chop`    썰기   — 박자 표식에 맞춰 좌클릭 `COOK_CHOP_CUTS` 번 (리듬 박자 채점, 헛클릭 = 다음 표식 실패).
 *   • `mince`   다지기 — 좌클릭 = 좌우 게이지, 우클릭 = 상하 게이지. 같은 버튼을 연달아 누르면 반대 게이지가 줄어든다. 둘 다 차면 끝, 걸린 시간으로 채점.
 *   • `grill`   굽기   — 조각 2–3개가 동시에 오르고 재료마다 익는 속도가 다르다(`data/cook_grill.csv`). 조각 클릭 = 뒤집기(50 % 부근),
 *                        한 번 더 = 꺼내기(100 % 부근). 늦으면 탄다. 판정 = 조각마다 뒤집기 · 꺼내기의 평균.
 *   • `stirfry` 볶기   — 박자에 맞춰 좌클릭하면 퍼센트 바가 찬다. 판정이 매우 널널하고 틀려도 조금은 찬다. 판정들의 평균.
 *   • `stir`    젓기   — 좌클릭을 누르고 있으면 저어져 완성 게이지가 차고 온도가 내려간다, 떼면 온도가 오른다(끓어오름 파동).
 *                        온도가 초록 구간에 머문 시간 비율로 채점.
 *   • `pour`    붓기   — 좌클릭을 누르면 `COOK_POUR_RAMP_S` 에 걸쳐 흐름이 0 → 100 %, 떼면 같은 시간에 걸쳐 0 %. 목표량(ml)과의 오차로 채점.
 *
 * **자동 조리 가구 4종**(주방): 푸드 프로세서(썰기 · 다지기) · 자동 그릴(굽기 · 볶기) · 자동 교반기(젓기) · 계량 디스펜서(붓기).
 * 함선에 배치돼 있으면 그 단계 시작에서 「직접 하기 / 자동」을 고를 수 있고, 자동이면 그 가구 레벨의 점수
 * (`COOK_AUTO_SCORE_BY_LEVEL` — Lv.1 0 % · Lv.2 60 % · Lv.3 100 %)로 친다 (사용자 결정).
 *
 * 스택: 품질이 다르면 같은 요리라도 합쳐지지 않는다. 판매가는 품질과 무관하다 (서버 크레딧 검증이 def 가치만 안다, E-4).
 */
import { csvRows, keyTable, numberList } from './data/tables';
import type { FurnitureInteraction } from './housing';

const K = /* data/constants.csv */ keyTable('constants.csv');

/* ── 미니게임 ────────────────────────────────────────────────────────────── */
export type CookGame = 'chop' | 'mince' | 'grill' | 'stirfry' | 'stir' | 'pour';
export const COOK_GAMES: readonly CookGame[] = ['chop', 'mince', 'grill', 'stirfry', 'stir', 'pour'];
export const COOK_GAME_LABEL_KO: Readonly<Record<CookGame, string>> = {
  chop: '썰기', mince: '다지기', grill: '굽기', stirfry: '볶기', stir: '젓기', pour: '붓기',
};
/** 툴팁 · 조리대 화면의 단계 칩 글리프 (외부 에셋 금지 — 유니코드 한 글자). */
export const COOK_GAME_ICON: Readonly<Record<CookGame, string>> = {
  chop: '⫽', mince: '✣', grill: '▦', stirfry: '◠', stir: '◎', pour: '⩡',
};

/** 판정 한 번의 품질 (박자 게임 · 굽기의 뒤집기/꺼내기). */
export type CookJudge = 'perfect' | 'good' | 'miss';
export const COOK_JUDGE_LABEL_KO: Readonly<Record<CookJudge, string>> = { perfect: '완벽', good: '좋음', miss: '실패' };

/**
 * 연출용 입력 하나 (`housing:cookBeat`) — hub 가 몸 · 도구 동작을, audio 가 소리를 맞춘다.
 * `cut` 썰기 · `mince_h` / `mince_v` 다지기 좌우 / 상하 · `flip` / `remove` / `burn` 굽기 · `toss` 볶기 · `stir` 젓기(누르는 동안 주기적으로) ·
 * `pour_start` / `pour_stop` 붓기.
 */
export type CookBeatAction = 'cut' | 'mince_h' | 'mince_v' | 'flip' | 'remove' | 'burn' | 'toss' | 'stir' | 'pour_start' | 'pour_stop';

/** 붓기의 액체. */
export type CookLiquid = 'water' | 'oil' | 'milk' | 'egg';
export const COOK_LIQUIDS: readonly CookLiquid[] = ['water', 'oil', 'milk', 'egg'];
export const COOK_LIQUID_LABEL_KO: Readonly<Record<CookLiquid, string>> = { water: '물', oil: '기름', milk: '우유', egg: '달걀물' };
export const COOK_LIQUID_COLOR: Readonly<Record<CookLiquid, string>> = { water: '#8fd0ff', oil: '#ffd36b', milk: '#f4f1e8', egg: '#ffd98a' };

/** 한 요리가 가질 수 있는 단계 수의 상한 (간단한 음식 1 · 일반 2 · 상위 티어 3). */
export const COOK_STEPS_MAX = 3;
/** 굽기 한 판에 오르는 조각 수의 상한. */
export const COOK_GRILL_PIECES_MAX = 3;

/** 요리 하나의 단계 하나 (`data/cook_steps.csv` 한 줄). */
export interface CookStepDef {
  /** 이 단계가 속한 요리의 item def id (`ItemDef.meal`). 조리대 레시피는 산출물이 이 id 인 `bench cook` 레시피다. */
  meal: string;
  /** 1 … `COOK_STEPS_MAX`, 요리 안에서 빠짐없이 이어진다. */
  order: number;
  game: CookGame;
  /**
   * 도마 · 그릴 · 팬에 오르는 재료 item def id — 썰기 · 다지기 = 1개, 굽기 = 조각 2 … `COOK_GRILL_PIECES_MAX`개(같은 id 반복 가능 —
   * 조각마다 `cookGrillSeconds` 가 익는 시간), 볶기 = 1 … 3개(그림), 젓기 · 붓기 = 빈 목록.
   */
  items: readonly string[];
  /** 붓기: 액체. 다른 게임은 null. */
  liquid: CookLiquid | null;
  /** 붓기: 목표량(ml). 다른 게임은 null. */
  targetMl: number | null;
}

export const COOK_STEPS: readonly CookStepDef[] = csvRows('cook_steps.csv').map((r) => {
  const game = r.enum('game', COOK_GAMES);
  const items = r.list('items');
  const liquid = r.optEnum('liquid', COOK_LIQUIDS) ?? null;
  const targetMl = r.optNum('targetMl', { min: 1 }) ?? null;
  if (game === 'pour') {
    if (!liquid) r.report('liquid', '붓기에는 액체가 필요하다');
    if (targetMl === null) r.report('targetMl', '붓기에는 목표량(ml)이 필요하다');
  } else if (liquid || targetMl !== null) r.report('liquid', `${game} 에는 liquid · targetMl 을 적지 않는다`);
  if ((game === 'chop' || game === 'mince') && items.length !== 1) r.report('items', `${game} 은 재료 하나다`);
  if (game === 'grill' && (items.length < 2 || items.length > COOK_GRILL_PIECES_MAX)) r.report('items', `굽기 조각은 2 … ${COOK_GRILL_PIECES_MAX}개다`);
  if (game === 'stirfry' && (items.length < 1 || items.length > 3)) r.report('items', '볶기 재료는 1 … 3개다');
  if ((game === 'stir' || game === 'pour') && items.length > 0) r.report('items', `${game} 에는 재료를 적지 않는다`);
  return { meal: r.str('meal'), order: r.int('order', { min: 1, max: COOK_STEPS_MAX }), game, items, liquid, targetMl };
});

const STEPS_BY_MEAL = new Map<string, CookStepDef[]>();
for (const s of COOK_STEPS) {
  const list = STEPS_BY_MEAL.get(s.meal);
  if (list) list.push(s); else STEPS_BY_MEAL.set(s.meal, [s]);
}
for (const list of STEPS_BY_MEAL.values()) list.sort((a, b) => a.order - b.order);

/** 요리 def id 의 단계 전부 (순서대로). 조리대 요리가 아니면 빈 배열. */
export function cookStepsOf(mealDefId: string): readonly CookStepDef[] {
  return STEPS_BY_MEAL.get(mealDefId) ?? [];
}

/** 굽기 조각이 0 → 100 % 익는 시간(초) — `data/cook_grill.csv`, 없으면 `COOK_GRILL_DEFAULT_S`. */
const GRILL_SECONDS = new Map<string, number>();
for (const r of csvRows('cook_grill.csv')) GRILL_SECONDS.set(r.str('defId'), r.num('seconds', { min: 0.5 }));

/* ── 판정 수치 (data/constants.csv) ─────────────────────────────────────── */
/** 판정 한 번의 점수 — 완벽 · 좋음 (실패 = 0). */
export const COOK_SCORE_PERFECT = K.num('COOK_SCORE_PERFECT');
export const COOK_SCORE_GOOD = K.num('COOK_SCORE_GOOD');
/** 박자 게임(썰기 · 볶기)의 예비 박자 수 — 첫 표식이 판정선까지 오는 동안의 입력은 무시한다. */
export const COOK_LEAD_BEATS = K.num('COOK_LEAD_BEATS');
/** 썰기: 칼질 수 · 박자 간격(초) · 판정 창(±초, 1/3 안 = 완벽). */
export const COOK_CHOP_CUTS = K.num('COOK_CHOP_CUTS');
export const COOK_CHOP_BEAT_S = K.num('COOK_CHOP_BEAT_S');
export const COOK_CHOP_WINDOW_S = K.num('COOK_CHOP_WINDOW_S');
/** 다지기: 클릭 한 번에 차는 양 · 같은 버튼 연타 때 반대 게이지가 주는 양 · 완벽 시간 · 0점 시간 · 강제 종료 시간(초). */
export const COOK_MINCE_FILL = K.num('COOK_MINCE_FILL');
export const COOK_MINCE_DRAIN = K.num('COOK_MINCE_DRAIN');
export const COOK_MINCE_PERFECT_S = K.num('COOK_MINCE_PERFECT_S');
export const COOK_MINCE_ZERO_S = K.num('COOK_MINCE_ZERO_S');
export const COOK_MINCE_MAX_S = K.num('COOK_MINCE_MAX_S');
/** 굽기: 조각 시간 기본값 · 조각마다 늦게 오르는 간격(초) · 뒤집기/꺼내기 판정 폭(진행도 비율) · 이르게 꺼내면 실패인 진행도 · 저절로 타서 내려가는 진행도. */
export const COOK_GRILL_DEFAULT_S = K.num('COOK_GRILL_DEFAULT_S');
export const COOK_GRILL_STAGGER_S = K.num('COOK_GRILL_STAGGER_S');
export const COOK_GRILL_FLIP_PERFECT = K.num('COOK_GRILL_FLIP_PERFECT');
export const COOK_GRILL_FLIP_GOOD = K.num('COOK_GRILL_FLIP_GOOD');
export const COOK_GRILL_DONE_PERFECT = K.num('COOK_GRILL_DONE_PERFECT');
export const COOK_GRILL_DONE_GOOD = K.num('COOK_GRILL_DONE_GOOD');
export const COOK_GRILL_EARLY_REMOVE = K.num('COOK_GRILL_EARLY_REMOVE');
export const COOK_GRILL_BURN_AT = K.num('COOK_GRILL_BURN_AT');
/** 볶기: 박자 간격 · 판정 창(±초) · 판정별로 차는 양. */
export const COOK_STIRFRY_BEAT_S = K.num('COOK_STIRFRY_BEAT_S');
export const COOK_STIRFRY_WINDOW_S = K.num('COOK_STIRFRY_WINDOW_S');
export const COOK_STIRFRY_FILL_PERFECT = K.num('COOK_STIRFRY_FILL_PERFECT');
export const COOK_STIRFRY_FILL_GOOD = K.num('COOK_STIRFRY_FILL_GOOD');
export const COOK_STIRFRY_FILL_MISS = K.num('COOK_STIRFRY_FILL_MISS');
/** 젓기: 눌러서 채워야 하는 시간 · 온도 상승/하강(/초) · 끓어오름 파동 세기 · 주기(초) · 초록 구간 · 완벽/0점 비율. */
export const COOK_STIR_TIME_S = K.num('COOK_STIR_TIME_S');
export const COOK_STIR_HEAT_RISE = K.num('COOK_STIR_HEAT_RISE');
export const COOK_STIR_HEAT_FALL = K.num('COOK_STIR_HEAT_FALL');
export const COOK_STIR_SURGE = K.num('COOK_STIR_SURGE');
export const COOK_STIR_SURGE_S = K.num('COOK_STIR_SURGE_S');
export const COOK_STIR_BAND_LOW = K.num('COOK_STIR_BAND_LOW');
export const COOK_STIR_BAND_HIGH = K.num('COOK_STIR_BAND_HIGH');
export const COOK_STIR_PERFECT_RATIO = K.num('COOK_STIR_PERFECT_RATIO');
export const COOK_STIR_ZERO_RATIO = K.num('COOK_STIR_ZERO_RATIO');
/** 붓기: 흐름 램프(초) · 100 % 흐름의 속도(ml/초) · 떼고 이만큼 가만히 있으면 판정(초) · 완벽/0점 오차 비율 · 비커 용량 = 목표 × 이 값. */
export const COOK_POUR_RAMP_S = K.num('COOK_POUR_RAMP_S');
export const COOK_POUR_RATE_ML_S = K.num('COOK_POUR_RATE_ML_S');
export const COOK_POUR_SETTLE_S = K.num('COOK_POUR_SETTLE_S');
export const COOK_POUR_PERFECT_ERR = K.num('COOK_POUR_PERFECT_ERR');
export const COOK_POUR_ZERO_ERR = K.num('COOK_POUR_ZERO_ERR');
export const COOK_POUR_BEAKER_MUL = K.num('COOK_POUR_BEAKER_MUL');

export function cookGrillSeconds(defId: string): number {
  const v = GRILL_SECONDS.get(defId);
  return v !== undefined && Number.isFinite(v) && v > 0 ? v : COOK_GRILL_DEFAULT_S;
}

/* ── 자동 조리 가구 ─────────────────────────────────────────────────────── */
/** 자동 조리 가구의 interaction → 그 가구가 대신할 수 있는 게임. */
export const COOK_APPLIANCE_GAMES: Readonly<Partial<Record<FurnitureInteraction, readonly CookGame[]>>> = {
  cook_processor: ['chop', 'mince'],
  cook_grill: ['grill', 'stirfry'],
  cook_stirrer: ['stir'],
  cook_dispenser: ['pour'],
};
/** 자동 조리 가구면 대신하는 게임, 아니면 빈 배열. */
export function cookGamesOfAppliance(interaction: FurnitureInteraction): readonly CookGame[] {
  return COOK_APPLIANCE_GAMES[interaction] ?? [];
}
/** 그 게임을 대신하는 가구의 interaction. */
export function cookApplianceOf(game: CookGame): FurnitureInteraction | null {
  for (const [k, games] of Object.entries(COOK_APPLIANCE_GAMES)) if (games?.includes(game)) return k as FurnitureInteraction;
  return null;
}
/** 자동 처리 점수 — index = 가구 레벨 (0 = 가구 없음). `data/tables.csv`. */
export const COOK_AUTO_SCORE_BY_LEVEL: readonly number[] = numberList('tables.csv', 'COOK_AUTO_SCORE_BY_LEVEL');
export function cookAutoScore(level: number): number {
  const n = COOK_AUTO_SCORE_BY_LEVEL.length;
  if (n === 0) return 0;
  const lv = Math.max(0, Math.min(n - 1, Math.floor(Number.isFinite(level) ? level : 0)));
  const v = COOK_AUTO_SCORE_BY_LEVEL[lv];
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

/** 지금 함선에 있는 자동 가구 하나 (`HousingRef.getCookAuto`). */
export interface CookAutoInfo {
  interaction: FurnitureInteraction;
  /** 배치된 가구 중 **가장 높은 레벨**의 것. */
  uid: string;
  defId: string;
  level: number;
  /** `cookAutoScore(level)`. */
  score: number;
}

/* ── 요리 품질 ──────────────────────────────────────────────────────────── */
/** 품질(별 수, index)에 필요한 최소 요리 점수 — `data/tables.csv`. */
export const MEAL_QUALITY_SCORE_MIN: readonly number[] = numberList('tables.csv', 'MEAL_QUALITY_SCORE_MIN');
/** 품질별 능력치 수치 보너스 (× (1 + 값)) — `data/tables.csv`. */
export const MEAL_QUALITY_BONUS: readonly number[] = numberList('tables.csv', 'MEAL_QUALITY_BONUS');
/** 가장 높은 품질 (별 5). */
export const MEAL_QUALITY_MAX: number = Math.max(0, Math.min(MEAL_QUALITY_SCORE_MIN.length, MEAL_QUALITY_BONUS.length) - 1);

/** 세이브 · 와이어에서 온 값을 0 … `MEAL_QUALITY_MAX` 정수로 (그 밖 · 숫자 아님 = 0). */
export function normalizeMealQuality(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(MEAL_QUALITY_MAX, Math.floor(v)));
}
/** 요리 점수(0 … 1) → 품질. 점수를 넘는 가장 높은 품질. */
export function mealQualityForScore(score: number): number {
  const s = Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0;
  let q = 0;
  for (let i = 0; i <= MEAL_QUALITY_MAX; i++) if (s + 1e-9 >= (MEAL_QUALITY_SCORE_MIN[i] ?? Infinity)) q = i;
  return q;
}
/** 품질의 수치 보너스 (0 … 0.25). */
export function mealQualityBonus(quality: number): number {
  const v = MEAL_QUALITY_BONUS[normalizeMealQuality(quality)];
  return Number.isFinite(v) ? Math.max(0, v) : 0;
}
/** `★★★☆☆` — 채운 별 = 품질, 빈 별 = 나머지. */
export function mealQualityStars(quality: number): string {
  const q = normalizeMealQuality(quality);
  return '★'.repeat(q) + '☆'.repeat(Math.max(0, MEAL_QUALITY_MAX - q));
}
/** 단계 점수들 → 요리 점수 (평균, 0 … 1). 빈 목록이면 0. */
export function cookScoreOf(stepScores: readonly number[]): number {
  if (stepScores.length === 0) return 0;
  let sum = 0;
  for (const s of stepScores) sum += Number.isFinite(s) ? Math.max(0, Math.min(1, s)) : 0;
  return sum / stepScores.length;
}

/* ── 세션 ───────────────────────────────────────────────────────────────── */
/** 진행 중인 조리 (`HousingRef.cookSession`). */
export interface CookSessionInfo {
  /** 조리대 가구 uid. */
  uid: string;
  recipeId: string;
  mealDefId: string;
  steps: readonly CookStepDef[];
}

/** 끝낸 조리 한 번 (`housing:cookResult`). */
export interface CookResult {
  recipeId: string;
  mealDefId: string;
  /** 단계 순서대로의 점수 (자동이면 그 가구의 자동 점수). */
  stepScores: readonly number[];
  /** 단계마다 자동으로 처리했는가. */
  stepAuto: readonly boolean[];
  /** `cookScoreOf(stepScores)`. */
  score: number;
  /** `mealQualityForScore(score)`. */
  quality: number;
  /** 만들어진 요리 인스턴스 uid, 실패면 null. */
  itemUid: string | null;
  /** 어디로 갔나 (창고 먼저). 실패면 null. */
  landed: 'bag' | 'stash' | null;
  /** 실패 사유 (재료가 사라졌다 · 자리가 없다), 성공이면 null. */
  reason: string | null;
}
