/**
 * src/shared/cooking.ts — the **cooking minigames · meal quality** contract (2026-09-13, `docs/DECISIONS.md` 「2026-09-13 — 요리 미니게임」, user's decision).
 *
 * The cook bench (`workbench_cook`) no longer opens the inventory craft window — housing's **cook bench screen** opens instead. Pick one meal and
 * press 「조리 시작」 and its 1–3 minigames (`data/cook_steps.csv`) run in order. Each step gives a score (0 … 1),
 * **the cook score = the average of the step scores**, and that score becomes the **meal quality** (0 … 5 stars, `MEAL_QUALITY_*`) stamped on the meal item that is made
 * (`ItemInstance.quality`). Eating it raises the stat amounts by `× (1 + MEAL_QUALITY_BONUS[품질])` (at most +25 %).
 * A low score **still always yields the meal** (quality 0 = 100 % of the base amounts). One at a time. Closing it midway consumes nothing.
 *
 * The 6 minigames (every judgement value is a `COOK_*` in `data/constants.csv`):
 *   • `chop`    썰기   — left-click on the beat markers `COOK_CHOP_CUTS` times (scored on the rhythm beat, a stray click = the next marker is missed).
 *   • `mince`   다지기 — left-click = the horizontal gauge, right-click = the vertical gauge. Pressing the same button twice in a row drains the other gauge. Both full ends it, scored by the time taken.
 *   • `grill`   굽기   — 2–3 pieces go on at once and each ingredient cooks at its own speed (`data/cook_grill.csv`). Clicking a piece = flip it (around 50 %),
 *                        clicking again = take it off (around 100 %). Too late and it burns. The judgement = the average of each piece's flip · removal.
 *   • `stirfry` 볶기   — left-clicking on the beat fills a percentage bar. The judgement is very loose and even a miss fills a little. The average of the judgements.
 *   • `stir`    젓기   — holding left-click stirs: the completion gauge fills and the temperature falls, releasing raises it (a boil-over surge).
 *                        Scored by the fraction of time the temperature stayed in the green band.
 *   • `pour`    붓기   — holding left-click ramps the flow 0 → 100 % over `COOK_POUR_RAMP_S`, releasing ramps it to 0 % over the same time. Scored by the error against the target amount (ml).
 *
 * **The 4 auto-cook appliances** (kitchen): the food processor (썰기 · 다지기) · the auto grill (굽기 · 볶기) · the auto stirrer (젓기) · the measuring dispenser (붓기).
 * With one placed on the ship, that step's start offers 「직접 하기 / 자동」, and auto scores it at that piece's level
 * (`COOK_AUTO_SCORE_BY_LEVEL` — Lv.1 0 % · Lv.2 60 % · Lv.3 100 %) (user's decision).
 *
 * Stacking: meals of different quality never merge, even when they are the same meal. The sell price does not depend on quality (the relay's credit check only knows the def's value, E-4).
 */
import { csvRows, keyTable, numberList } from './data/tables';
import type { FurnitureInteraction } from './housing';

const K = /* data/constants.csv */ keyTable('constants.csv');

/* ── Minigames ───────────────────────────────────────────────────────────── */
export type CookGame = 'chop' | 'mince' | 'grill' | 'stirfry' | 'stir' | 'pour';
export const COOK_GAMES: readonly CookGame[] = ['chop', 'mince', 'grill', 'stirfry', 'stir', 'pour'];
export const COOK_GAME_LABEL_KO: Readonly<Record<CookGame, string>> = {
  chop: '썰기', mince: '다지기', grill: '굽기', stirfry: '볶기', stir: '젓기', pour: '붓기',
};
/** Step chip glyphs for the tooltip · the cook bench screen (no external assets — one Unicode character). */
export const COOK_GAME_ICON: Readonly<Record<CookGame, string>> = {
  chop: '⫽', mince: '✣', grill: '▦', stirfry: '◠', stir: '◎', pour: '⩡',
};

/** The quality of one judgement (beat games · a 굽기 flip/removal). */
export type CookJudge = 'perfect' | 'good' | 'miss';
export const COOK_JUDGE_LABEL_KO: Readonly<Record<CookJudge, string>> = { perfect: '완벽', good: '좋음', miss: '실패' };

/**
 * One input for the presentation (`housing:cookBeat`) — hub matches the body · tool motion, audio the sound.
 * `cut` 썰기 · `mince_h` / `mince_v` 다지기 horizontal / vertical · `flip` / `remove` / `burn` 굽기 · `toss` 볶기 · `stir` 젓기 (periodically while held) ·
 * `pour_start` / `pour_stop` 붓기.
 */
export type CookBeatAction = 'cut' | 'mince_h' | 'mince_v' | 'flip' | 'remove' | 'burn' | 'toss' | 'stir' | 'pour_start' | 'pour_stop';

/** The liquid for 붓기. */
export type CookLiquid = 'water' | 'oil' | 'milk' | 'egg';
export const COOK_LIQUIDS: readonly CookLiquid[] = ['water', 'oil', 'milk', 'egg'];
export const COOK_LIQUID_LABEL_KO: Readonly<Record<CookLiquid, string>> = { water: '물', oil: '기름', milk: '우유', egg: '달걀물' };
export const COOK_LIQUID_COLOR: Readonly<Record<CookLiquid, string>> = { water: '#8fd0ff', oil: '#ffd36b', milk: '#f4f1e8', egg: '#ffd98a' };

/** Cap on how many steps one meal may have (simple food 1 · normal 2 · higher tiers 3). */
export const COOK_STEPS_MAX = 3;
/** Cap on how many pieces go on one 굽기 round. */
export const COOK_GRILL_PIECES_MAX = 3;

/** One step of one meal (one row of `data/cook_steps.csv`). */
export interface CookStepDef {
  /** Item def id of the meal this step belongs to (`ItemDef.meal`). A cook bench recipe is the `bench cook` recipe whose output is this id. */
  meal: string;
  /** 1 … `COOK_STEPS_MAX`, contiguous with no gaps inside one meal. */
  order: number;
  game: CookGame;
  /**
   * Item def ids of the ingredients that go on the board · grill · pan — 썰기 · 다지기 = 1, 굽기 = 2 … `COOK_GRILL_PIECES_MAX` pieces (the same id may repeat —
   * `cookGrillSeconds` is each piece's cooking time), 볶기 = 1 … 3 (drawn), 젓기 · 붓기 = an empty list.
   */
  items: readonly string[];
  /** 붓기: the liquid. null for every other game. */
  liquid: CookLiquid | null;
  /** 붓기: the target amount (ml). null for every other game. */
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

/** Every step of a meal def id (in order). Empty array when it is not a cook bench meal. */
export function cookStepsOf(mealDefId: string): readonly CookStepDef[] {
  return STEPS_BY_MEAL.get(mealDefId) ?? [];
}

/** Seconds a 굽기 piece takes to cook 0 → 100 % — `data/cook_grill.csv`, `COOK_GRILL_DEFAULT_S` when absent. */
const GRILL_SECONDS = new Map<string, number>();
for (const r of csvRows('cook_grill.csv')) GRILL_SECONDS.set(r.str('defId'), r.num('seconds', { min: 0.5 }));

/* ── Judgement values (data/constants.csv) ──────────────────────────────── */
/** Score of one judgement — perfect · good (a miss = 0). */
export const COOK_SCORE_PERFECT = K.num('COOK_SCORE_PERFECT');
export const COOK_SCORE_GOOD = K.num('COOK_SCORE_GOOD');
/** Lead-in beats of the beat games (썰기 · 볶기) — input is ignored while the first marker travels to the judgement line. */
export const COOK_LEAD_BEATS = K.num('COOK_LEAD_BEATS');
/** 썰기: number of cuts · beat interval (s) · judgement window (±s, within 1/3 = perfect). */
export const COOK_CHOP_CUTS = K.num('COOK_CHOP_CUTS');
export const COOK_CHOP_BEAT_S = K.num('COOK_CHOP_BEAT_S');
export const COOK_CHOP_WINDOW_S = K.num('COOK_CHOP_WINDOW_S');
/** 다지기: fill per click · how much the other gauge drains on repeated presses of the same button · perfect time · zero-score time · forced end time (s). */
export const COOK_MINCE_FILL = K.num('COOK_MINCE_FILL');
export const COOK_MINCE_DRAIN = K.num('COOK_MINCE_DRAIN');
export const COOK_MINCE_PERFECT_S = K.num('COOK_MINCE_PERFECT_S');
export const COOK_MINCE_ZERO_S = K.num('COOK_MINCE_ZERO_S');
export const COOK_MINCE_MAX_S = K.num('COOK_MINCE_MAX_S');
/** 굽기: default piece time · stagger between pieces going on (s) · flip/removal judgement width (progress fraction) · the progress below which taking it off is a miss · the progress at which it burns by itself. */
export const COOK_GRILL_DEFAULT_S = K.num('COOK_GRILL_DEFAULT_S');
export const COOK_GRILL_STAGGER_S = K.num('COOK_GRILL_STAGGER_S');
export const COOK_GRILL_FLIP_PERFECT = K.num('COOK_GRILL_FLIP_PERFECT');
export const COOK_GRILL_FLIP_GOOD = K.num('COOK_GRILL_FLIP_GOOD');
export const COOK_GRILL_DONE_PERFECT = K.num('COOK_GRILL_DONE_PERFECT');
export const COOK_GRILL_DONE_GOOD = K.num('COOK_GRILL_DONE_GOOD');
export const COOK_GRILL_EARLY_REMOVE = K.num('COOK_GRILL_EARLY_REMOVE');
export const COOK_GRILL_BURN_AT = K.num('COOK_GRILL_BURN_AT');
/** 볶기: beat interval · judgement window (±s) · fill per judgement. */
export const COOK_STIRFRY_BEAT_S = K.num('COOK_STIRFRY_BEAT_S');
export const COOK_STIRFRY_WINDOW_S = K.num('COOK_STIRFRY_WINDOW_S');
export const COOK_STIRFRY_FILL_PERFECT = K.num('COOK_STIRFRY_FILL_PERFECT');
export const COOK_STIRFRY_FILL_GOOD = K.num('COOK_STIRFRY_FILL_GOOD');
export const COOK_STIRFRY_FILL_MISS = K.num('COOK_STIRFRY_FILL_MISS');
/** 젓기: the hold time needed to fill · temperature rise/fall (/s) · boil-over surge strength · period (s) · the green band · perfect/zero-score ratios. */
export const COOK_STIR_TIME_S = K.num('COOK_STIR_TIME_S');
export const COOK_STIR_HEAT_RISE = K.num('COOK_STIR_HEAT_RISE');
export const COOK_STIR_HEAT_FALL = K.num('COOK_STIR_HEAT_FALL');
export const COOK_STIR_SURGE = K.num('COOK_STIR_SURGE');
export const COOK_STIR_SURGE_S = K.num('COOK_STIR_SURGE_S');
export const COOK_STIR_BAND_LOW = K.num('COOK_STIR_BAND_LOW');
export const COOK_STIR_BAND_HIGH = K.num('COOK_STIR_BAND_HIGH');
export const COOK_STIR_PERFECT_RATIO = K.num('COOK_STIR_PERFECT_RATIO');
export const COOK_STIR_ZERO_RATIO = K.num('COOK_STIR_ZERO_RATIO');
/** 붓기: flow ramp (s) · speed at 100 % flow (ml/s) · judged after standing still this long once released (s) · perfect/zero-score error ratios · beaker capacity = target × this value. */
export const COOK_POUR_RAMP_S = K.num('COOK_POUR_RAMP_S');
export const COOK_POUR_RATE_ML_S = K.num('COOK_POUR_RATE_ML_S');
export const COOK_POUR_SETTLE_S = K.num('COOK_POUR_SETTLE_S');
export const COOK_POUR_PERFECT_ERR = K.num('COOK_POUR_PERFECT_ERR');
export const COOK_POUR_ZERO_ERR = K.num('COOK_POUR_ZERO_ERR');
/** appended (2026-09-14): half-width of the 「좋음」 band = the perfect band × this value (clamped to half a beat). */
export const COOK_GOOD_OF_PERFECT = K.num('COOK_GOOD_OF_PERFECT');
/** appended (2026-09-14): the safety pin that keeps a step from stalling when no input arrives — the time it takes done properly × this value. */
export const COOK_STEP_TIMEOUT_MUL = K.num('COOK_STEP_TIMEOUT_MUL');
export const COOK_POUR_BEAKER_MUL = K.num('COOK_POUR_BEAKER_MUL');

export function cookGrillSeconds(defId: string): number {
  const v = GRILL_SECONDS.get(defId);
  return v !== undefined && Number.isFinite(v) && v > 0 ? v : COOK_GRILL_DEFAULT_S;
}

/* ── Auto-cook appliances ───────────────────────────────────────────────── */
/** Auto-cook appliance interaction → the games that piece can stand in for. */
export const COOK_APPLIANCE_GAMES: Readonly<Partial<Record<FurnitureInteraction, readonly CookGame[]>>> = {
  cook_processor: ['chop', 'mince'],
  cook_grill: ['grill', 'stirfry'],
  cook_stirrer: ['stir'],
  cook_dispenser: ['pour'],
};
/** The games it stands in for when it is an auto-cook appliance, else an empty array. */
export function cookGamesOfAppliance(interaction: FurnitureInteraction): readonly CookGame[] {
  return COOK_APPLIANCE_GAMES[interaction] ?? [];
}
/** Interaction of the piece that stands in for that game. */
export function cookApplianceOf(game: CookGame): FurnitureInteraction | null {
  for (const [k, games] of Object.entries(COOK_APPLIANCE_GAMES)) if (games?.includes(game)) return k as FurnitureInteraction;
  return null;
}
/** Auto-handling score — index = furniture level (0 = no furniture). `data/tables.csv`. */
export const COOK_AUTO_SCORE_BY_LEVEL: readonly number[] = numberList('tables.csv', 'COOK_AUTO_SCORE_BY_LEVEL');
export function cookAutoScore(level: number): number {
  const n = COOK_AUTO_SCORE_BY_LEVEL.length;
  if (n === 0) return 0;
  const lv = Math.max(0, Math.min(n - 1, Math.floor(Number.isFinite(level) ? level : 0)));
  const v = COOK_AUTO_SCORE_BY_LEVEL[lv];
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

/** One auto appliance currently on the ship (`HousingRef.getCookAuto`). */
export interface CookAutoInfo {
  interaction: FurnitureInteraction;
  /** The **highest-level** one among the placed pieces. */
  uid: string;
  defId: string;
  level: number;
  /** `cookAutoScore(level)`. */
  score: number;
}

/* ── Meal quality ───────────────────────────────────────────────────────── */
/** Minimum cook score a quality (star count, the index) needs — `data/tables.csv`. */
export const MEAL_QUALITY_SCORE_MIN: readonly number[] = numberList('tables.csv', 'MEAL_QUALITY_SCORE_MIN');
/** Stat-amount bonus per quality (× (1 + value)) — `data/tables.csv`. */
export const MEAL_QUALITY_BONUS: readonly number[] = numberList('tables.csv', 'MEAL_QUALITY_BONUS');
/** The highest quality (5 stars). */
export const MEAL_QUALITY_MAX: number = Math.max(0, Math.min(MEAL_QUALITY_SCORE_MIN.length, MEAL_QUALITY_BONUS.length) - 1);

/** A value from a save or the wire to an integer 0 … `MEAL_QUALITY_MAX` (outside that · not a number = 0). */
export function normalizeMealQuality(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(MEAL_QUALITY_MAX, Math.floor(v)));
}
/** Cook score (0 … 1) → quality. The highest quality the score passes. */
export function mealQualityForScore(score: number): number {
  const s = Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0;
  let q = 0;
  for (let i = 0; i <= MEAL_QUALITY_MAX; i++) if (s + 1e-9 >= (MEAL_QUALITY_SCORE_MIN[i] ?? Infinity)) q = i;
  return q;
}
/** A quality's amount bonus (0 … 0.25). */
export function mealQualityBonus(quality: number): number {
  const v = MEAL_QUALITY_BONUS[normalizeMealQuality(quality)];
  return Number.isFinite(v) ? Math.max(0, v) : 0;
}
/** `★★★☆☆` — filled stars = the quality, empty stars = the rest. */
export function mealQualityStars(quality: number): string {
  const q = normalizeMealQuality(quality);
  return '★'.repeat(q) + '☆'.repeat(Math.max(0, MEAL_QUALITY_MAX - q));
}
/** Step scores → the cook score (the average, 0 … 1). 0 for an empty list. */
export function cookScoreOf(stepScores: readonly number[]): number {
  if (stepScores.length === 0) return 0;
  let sum = 0;
  for (const s of stepScores) sum += Number.isFinite(s) ? Math.max(0, Math.min(1, s)) : 0;
  return sum / stepScores.length;
}

/* ── Session ────────────────────────────────────────────────────────────── */
/** A cook in progress (`HousingRef.cookSession`). */
export interface CookSessionInfo {
  /** Uid of the cook bench furniture. */
  uid: string;
  recipeId: string;
  mealDefId: string;
  steps: readonly CookStepDef[];
}

/** One finished cook (`housing:cookResult`). */
export interface CookResult {
  recipeId: string;
  mealDefId: string;
  /** Scores in step order (the appliance's auto score for an automated step). */
  stepScores: readonly number[];
  /** Whether each step was handled automatically. */
  stepAuto: readonly boolean[];
  /** `cookScoreOf(stepScores)`. */
  score: number;
  /** `mealQualityForScore(score)`. */
  quality: number;
  /** Uid of the meal instance that was made, null on failure. 2026-09-16 (the plate model): a meal is not an item, so it is **always null**. */
  itemUid: string | null;
  /**
   * Where it went. null on failure. 2026-09-16 (the plate model, user's decision): a meal becomes a plate on the dining table, so on success it is **always `'table'`**
   * (`'bag'` · `'stash'` are the old item-meal values — kept because this is a contract).
   */
  landed: 'bag' | 'stash' | 'table' | null;
  /** Failure reason (the ingredients are gone · there is no dining table), null on success. */
  reason: string | null;
  /** appended (2026-09-16): the old plate this cook cleared from the table (eaten or not), null · omitted when there was none. */
  replaced?: { mealDefId: string; quality: number } | null;
}
