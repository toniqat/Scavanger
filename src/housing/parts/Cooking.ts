/**
 * src/housing/parts/Cooking.ts — **the cook bench · the cook session** (2026-09-13, `docs/DECISIONS.md` 「2026-09-13 — 요리 미니게임」).
 *
 * Modelled exactly on the structure of `parts/Gym.ts`:
 *   ① E on the cook bench → hub calls `openCookStation(uid)` — the cook bench screen (`ui/cook/CookStation`, recipe list · materials · steps · auto appliance · stash/bag).
 *   ② 「조리 시작」 → `startCook(uid, recipeId)` — `cookBlock` (the order in the contract's comment) → the session (`sys.cookState`) → opens the minigame overlay
 *      (`ui/cook/CookScreen`), then closes the cook bench screen and emits `housing:cookSession {active:true}` — hub raises the pose at the bench · the fixed
 *      camera (2026-09-14, user's decision: **the minigame runs even when the pose is refused** — only the presentation is missing).
 *   ③ Per step 「직접 하기 / 자동」 → the judgement (`parts/CookGames`) → the step score. When the last step ends, `completeCookRun` —
 *      the cook score (the average) → quality → `ctx.inventory.consumeCookInputs(recipeId, the bench level)` → **a plate on the dining table** (`parts/Dining.setPlate`) → `housing:cookResult`.
 *      **Materials are taken only here** — closing mid-way (Esc · Tab · a phase change · a pose reset) consumes nothing and leaves the old plate alone.
 *      2026-09-16 (the plate model, user's decision): a meal is not an item — a finished meal becomes the one plate on the personal ship's dining table and replaces the old plate.
 *      With no dining-table furniture placed the cook bench cannot be used (`DINING_TABLE_MISSING_REASON`). The replace warning is the screen's job (`ui/cook/PlateAsk`).
 *   ④ When the overlay closes, `endCook` — `housing:cookSession {active:false, completed}` (`completed` = at least one meal came out of this session).
 *
 * Not one quality · bonus rule lives here — they belong to `shared/cooking`'s functions (`cookScoreOf` · `mealQualityForScore`) and to inventory · progression.
 * inventory's new methods (`cookBlock` · `consumeCookInputs`) are optional in the contract, so they are called by **duck typing** — with none the result says
 * 「it could not be finished」 (it never silently pretends to have succeeded, the same contract as `parts/Gym`'s `applyGymSession`).
 */
import type {
  CookAutoInfo, CookGame, CookResult, CookSessionInfo, CookStepDef, CraftRecipe, FurnitureDef, HousingRef, LibraryCookTarget, PlacedFurniture,
} from '@/shared';
import {
  COOK_SKILL_XP, COOK_STEPS, LIBRARY_COOK_TARGETS, LIBRARY_SERIES_MAP, cookAutoScore, cookGamesOfAppliance, cookScoreOf, cookStepsOf,
  mealQualityForScore,
} from '@/shared';
import { DINING_TABLE_MISSING_REASON } from '@/shared';     // 2026-09-16 (the plate model): with no dining table the cook bench cannot be used
import { hasDiningTable, setPlate } from './Dining';
import type { HousingSystem } from '../HousingSystem';
import type { CookScreenKind } from '../ui/cook/CookScreen';
import { createCookGame } from './CookGames';
import type { AnyCookGame } from './CookGames';

/** The cook overlay's `ctx.uiBlockers` token — separate from the panels' `'housing'`, so the cook bench screen does not clear it as it closes. */
export const COOK_BLOCKER = 'housing.cook';

/** The skill-name fallback table — only when progression is missing (`cookSkillLabel`). The source is `skills.csv`'s `name`. */
const SKILL_LABEL_KO: Readonly<Record<CraftRecipe['skill'], string>> = { crafting: '제작', medicine: '의학', gardening: '원예' };

export interface CookState {
  info: CookSessionInfo;
  /** The cook bench level at the start — passed to `consumeCookInputs`. */
  benchLevel: number;
  /** This run's step scores (in order, empty until then). 2026-09-13: the cooking skill · library bonus **added and clamped to 1** — quality is decided from this. */
  stepScores: number[];
  /** 2026-09-13 (H3): the step score before the bonus is added (exactly what the minigame · auto appliance produced — the screen's `72 → 84`). */
  stepRaw: number[];
  /** 2026-09-13 (H3): the bonus added per step (cooking skill · library). */
  stepBonus: CookStepBonus[];
  /** Whether each step of this run was handled automatically. */
  stepAuto: boolean[];
  /** This run is finished (`completeCookRun` was called). */
  finished: boolean;
  /** At least one meal came out of this session — the session-end event's `completed`. */
  anyCompleted: boolean;
  /** This run's result, null until then. */
  result: CookResult | null;
}

/* ── Queries ──────────────────────────────────────────────────────────────── */
/** The furniture at `uid` when it is a placed cook bench (`workbench_cook`). */
export function cookBenchAt(sys: HousingSystem, uid: string): { item: PlacedFurniture; def: FurnitureDef } | null {
  const item = sys.getPlacedByUid(uid);
  if (!item) return null;
  const def = sys.getFurnitureDef(item.defId);
  return def && def.interaction === 'workbench_cook' ? { item, def } : null;
}

/**
 * **Every** cook bench recipe — those of the source table (`ctx.loot.getAllRecipes()`) that are cook bench (`bench cook`) recipes whose product has cook steps (`cookStepsOf`).
 * Not one lock is filtered out — the cook bench level (`benchLevel`) · skill (`cookRecipeSkillBlock`) · the recipe book (`cookRecipeBookBlock`) are
 * told apart by the screen with dimming + a badge, and starting is blocked by `cookBlock`.
 * 2026-09-16 (user's decision, 2nd pass): the skill badge was deleted that same morning and then **restored** — as long as the `skillRequired` column stays, it has to be
 * switchable later by raising a csv number alone. With every value 0 today the badge never appears once (the data has it turned off).
 * Why this list reads the source table is unchanged (B-15): reading `inventory.getRecipes` made **a meal short on skill vanish from the rail entirely**,
 * so there was no telling what to raise to open it. That path stays only as the fallback for when inventory is missing (it filters by skill then).
 */
export function cookRecipes(sys: HousingSystem): CraftRecipe[] {
  const inv = sys.ctx.inventory;
  const loot = sys.ctx.loot;
  let all: readonly CraftRecipe[] = [];
  if (loot && typeof loot.getAllRecipes === 'function') all = loot.getAllRecipes();
  else if (inv && typeof inv.getRecipes === 'function') all = inv.getRecipes('ship', 'cook', 99);
  return all.filter((r) => r.bench === 'cook' && cookStepsOf(r.outputDefId).length > 0);
}

/** A recipe's skill name — the progression table (`skills.csv`'s `name`) is the source, the fallback table → the id only when it is missing. */
export function cookSkillLabel(sys: HousingSystem, skill: CraftRecipe['skill']): string {
  const prog = sys.ctx.progression;
  const def = prog && typeof prog.getSkillDef === 'function' ? prog.getSkillDef(skill) : null;
  return def && def.id === skill && def.name ? def.name : (SKILL_LABEL_KO[skill] ?? skill);
}

/**
 * `{ label, need, have }` when the meal is locked for want of skill (the material for the `제작 20` badge), else null (2026-09-15 B-15 → restored 2026-09-16).
 * Display only — starting is still blocked by `cookBlock` (inventory's real reason). `need === 0` is always null, so
 * with `recipes.csv` all zeroes today nothing is locked.
 */
export function cookRecipeSkillBlock(sys: HousingSystem, recipe: CraftRecipe): { label: string; need: number; have: number } | null {
  const need = recipe.skillRequired;
  if (!(need > 0)) return null;
  const have = sys.ctx.progression?.getSkill?.(recipe.skill) ?? 0;
  return have >= need ? null : { label: cookSkillLabel(sys, recipe.skill), need, have };
}

/**
 * One recipe — reads the source table (the same source as the `cookRecipes` list): a caller asking for a locked meal also has to get
 * inventory `cookBlock`'s real reason (`조리대 Lv.2 이 필요합니다`) rather than 「요리 레시피가 아닙니다」.
 */
export function cookRecipeOf(sys: HousingSystem, recipeId: string): CraftRecipe | null {
  const loot = sys.ctx.loot;
  const all = loot && typeof loot.getAllRecipes === 'function' ? loot.getAllRecipes() : cookRecipes(sys);
  const r = all.find((x) => x.id === recipeId);
  return r && r.bench === 'cook' && cookStepsOf(r.outputDefId).length > 0 ? r : null;
}

export function cookSession(sys: HousingSystem): CookSessionInfo | null {
  return sys.cookState ? sys.cookState.info : null;
}

/* ── 2026-09-13 (H3): the cooking skill · library bonus · recipe books (docs/DECISIONS.md 「2026-09-13 — 서재 시리즈 · 비디오게임」) ───────
 * Step score = min(1, the minigame · auto appliance score + `derived.cookScoreBonus` + library `cookScore[game]`) — **manual and auto alike** (user's decision ·
 * lead's decision). Only chopping · mincing · grilling · stir-frying (`LIBRARY_COOK_TARGETS`) take the library bonus. A recipe book (`CraftRecipe.unlockSeries`) is
 * locked while `HousingRef.isRecipeUnlocked` is false — until the library agent supplies that method, a recipe that needs a book stays locked. */

/** The bonus added to one step (0 … 1, before clamping). */
export interface CookStepBonus {
  /** The cooking skill (`derived.cookScoreBonus`). */
  skill: number;
  /** The library (`getLibraryEffects().cookScore[game]`). */
  library: number;
  /** `skill + library`. */
  total: number;
}

const finiteNonNeg = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** The bonus that would be added to this cook step (`game`) right now. */
export function cookStepBonus(sys: HousingSystem, game: CookGame): CookStepBonus {
  const skill = finiteNonNeg(sys.ctx.progression?.derived?.cookScoreBonus);
  let library = 0;
  if ((LIBRARY_COOK_TARGETS as readonly string[]).includes(game)) {
    const ref: HousingRef | null = sys.ctx.housing ?? null;
    const lib = ref && typeof ref.getLibraryEffects === 'function' ? ref.getLibraryEffects() : null;
    library = finiteNonNeg(lib?.cookScore?.[game as LibraryCookTarget]);
  }
  return { skill, library, total: skill + library };
}

/** Adds the bonus to the step score and clamps it to 0 … 1. */
export function applyCookStepBonus(raw: number, bonus: CookStepBonus): number {
  const s = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
  return Math.max(0, Math.min(1, s + bonus.total));
}

/**
 * The Korean reason when the meal is locked because its recipe book is not shelved (`『시리즈 이름』 을(를) 서재에 꽂아야 합니다`), else null.
 * A recipe that needs no book (no `unlockSeries`) is always null.
 */
export function cookRecipeBookBlock(sys: HousingSystem, recipe: CraftRecipe): string | null {
  const series = recipe.unlockSeries;
  if (!series) return null;
  const ref: HousingRef | null = sys.ctx.housing ?? null;
  const unlocked = ref && typeof ref.isRecipeUnlocked === 'function' ? ref.isRecipeUnlocked(recipe.id) !== false : false;
  if (unlocked) return null;
  return `『${LIBRARY_SERIES_MAP.get(series)?.name ?? '레시피 책'}』 을(를) 서재에 꽂아야 합니다`;
}

/** The highest-level auto cooking appliance placed on the ship that stands in for that game (the room is not asked — they go only in the kitchen). */
export function getCookAuto(sys: HousingSystem, game: CookGame): CookAutoInfo | null {
  let best: CookAutoInfo | null = null;
  for (const f of sys.state.furniture) {
    const def = sys.getFurnitureDef(f.defId);
    if (!def || !cookGamesOfAppliance(def.interaction).includes(game)) continue;
    if (!best || f.level > best.level) {
      best = { interaction: def.interaction, uid: f.uid, defId: f.defId, level: f.level, score: cookAutoScore(f.level) };
    }
  }
  return best;
}

/* ── Gates ────────────────────────────────────────────────────────────────── */
function blockCore(sys: HousingSystem, uid: string, recipeId: string, ignoreActive: boolean): string | null {
  const ctx = sys.ctx;
  const bench = cookBenchAt(sys, uid);
  if (!bench) return '조리대가 아닙니다';
  if (ctx.isRaidActive() || !ctx.isHubPhase()) return '함선에서만 요리할 수 있습니다';
  if (ctx.hub && (ctx.hub.ship !== 'personal' || ctx.hub.visitReadOnly)) return '내 함선에서만 요리할 수 있습니다';
  if (!hasDiningTable(sys)) return DINING_TABLE_MISSING_REASON;   // 2026-09-16: a dining table for the finished meal to land on has to exist
  if (!ignoreActive && sys.cookState) return '이미 조리 중입니다';
  const recipe = cookRecipeOf(sys, recipeId);
  if (!recipe) return '요리 레시피가 아닙니다';
  if (!cookStepsOf(recipe.outputDefId).length) return '조리 단계가 없는 요리입니다';
  const book = cookRecipeBookBlock(sys, recipe);             // 2026-09-13 (H3): the recipe book has to be shelved
  if (book) return book;
  const inv = ctx.inventory;
  if (inv && typeof inv.cookBlock === 'function') return inv.cookBlock(recipeId, bench.item.level);
  return fallbackBlock(sys, recipe, bench.item.level);
}

/** When inventory does not supply `cookBlock` yet — looks only at level · skill · materials (the cook fails at the end anyway with no `consumeCookInputs`). */
function fallbackBlock(sys: HousingSystem, recipe: CraftRecipe, benchLevel: number): string | null {
  const need = recipe.benchLevel ?? 1;
  if (benchLevel < need) return `조리대 Lv.${need} 이 필요합니다`;
  const skill = cookRecipeSkillBlock(sys, recipe);
  if (skill) return `${skill.label} 숙련 ${skill.need} 이 필요합니다`;
  if (!sys.canAfford(recipe.inputs)) return '재료가 부족합니다';
  return null;
}

/** The Korean reason `recipeId` cannot be started at cook bench `uid` right now (the order of the contract `HousingRef.cookBlock`), null = it can be started. */
export function cookBlock(sys: HousingSystem, uid: string, recipeId: string): string | null {
  return blockCore(sys, uid, recipeId, false);
}

/** The result screen's 「다시 만들기」 reason — the current session is not counted. With no session, a reason. */
export function restartBlock(sys: HousingSystem): string | null {
  const st = sys.cookState;
  if (!st) return '조리 중이 아닙니다';
  return blockCore(sys, st.info.uid, st.info.recipeId, true);
}

/* ── The session ──────────────────────────────────────────────────────────── */
export function startCook(sys: HousingSystem, uid: string, recipeId: string): string | null {
  const reason = cookBlock(sys, uid, recipeId);
  if (reason) return reason;
  const bench = cookBenchAt(sys, uid);
  const recipe = cookRecipeOf(sys, recipeId);
  const screen = sys.cookScreen;
  if (!bench || !recipe || !screen) return '조리를 시작할 수 없습니다';
  const info: CookSessionInfo = { uid, recipeId, mealDefId: recipe.outputDefId, steps: cookStepsOf(recipe.outputDefId) };
  sys.cookState = {
    info, benchLevel: bench.item.level, stepScores: [], stepRaw: [], stepBonus: [], stepAuto: [], finished: false, anyCompleted: false, result: null,
  };
  // the overlay grabs the cursor · blocker first and only then the cook bench screen closes — so pointer lock does not come back and drop in between
  // 2026-09-17: a meal is not an item — `nameOf` returns the meal id as it stands, so the header row's name is read from the meal table
  screen.open(info, sys.mealDef(recipe.outputDefId)?.name ?? sys.nameOf(recipe.outputDefId));
  sys.exitHousingMode();
  sys.closeMenus(false);
  sys.ctx.bus.emit('audio:play', { id: 'cook_start' });
  sys.ctx.bus.emit('housing:cookSession', { uid, recipeId, mealDefId: info.mealDefId, active: true, completed: false });
  // 2026-09-14 (user's decision): **the minigame runs even when hub cannot raise the pose** — `cancelCook` comes only from a real accident such as the
  // cook bench piece vanishing outright. Even so, a session gone within the same call stack means it did not start.
  if (!sys.cookState) return '조리를 시작할 수 없습니다';
  screen.beginSteps();
  return null;
}

/** The result screen's 「다시 만들기」 — the same meal from the first step in the same session (the pose · camera are kept). A Korean reason / null. */
export function restartCook(sys: HousingSystem): string | null {
  const st = sys.cookState;
  const reason = restartBlock(sys);
  if (reason || !st) return reason ?? '조리 중이 아닙니다';
  st.benchLevel = cookBenchAt(sys, st.info.uid)?.item.level ?? st.benchLevel;
  st.stepScores = [];
  st.stepRaw = [];
  st.stepBonus = [];
  st.stepAuto = [];
  st.finished = false;
  st.result = null;
  sys.ctx.bus.emit('audio:play', { id: 'cook_start' });
  return null;
}

/** Ends the cook in progress with nothing consumed (on the result screen a meal already produced is left alone). A no-op with none. */
export function cancelCook(sys: HousingSystem): void {
  if (!sys.cookState) return;
  if (sys.cookScreen?.isOpen) sys.cookScreen.close();     // the screen calls `endCook`
  else endCook(sys);
}

/**
 * The screen finished one step — writes it into this run's score table. 2026-09-13 (H3): `score` is the **raw score** the minigame · auto appliance produced, and here
 * the cooking skill · library bonus is added, clamped to 1, written and returned (manual and auto alike). When it cannot be written (no session · a finished run), the clamped raw score.
 */
export function recordCookStep(sys: HousingSystem, index: number, score: number, auto: boolean): number {
  const raw = Math.max(0, Math.min(1, Number.isFinite(score) ? score : 0));
  const st = sys.cookState;
  if (!st || st.finished || index < 0 || index >= st.info.steps.length) return raw;
  const bonus = cookStepBonus(sys, st.info.steps[index].game);
  const final = applyCookStepBonus(raw, bonus);
  st.stepRaw[index] = raw;
  st.stepBonus[index] = bonus;
  st.stepScores[index] = final;
  st.stepAuto[index] = auto;
  return final;
}

/**
 * Finishes this run — works out the cook score · quality, leaves the material consumption to inventory and then puts **a plate on the dining table**. Once per run only.
 * When inventory has no `consumeCookInputs` or refuses (or the dining table is gone), the result's `reason` carries a Korean reason —
 * nothing is taken then and the old plate is left alone.
 */
export function completeCookRun(sys: HousingSystem): CookResult | null {
  const st = sys.cookState;
  if (!st) return null;
  if (st.finished) return st.result;
  st.finished = true;
  const { uid, recipeId, mealDefId, steps } = st.info;
  const stepScores = steps.map((_, i) => st.stepScores[i] ?? 0);
  const stepAuto = steps.map((_, i) => st.stepAuto[i] === true);
  const score = cookScoreOf(stepScores);
  const quality = mealQualityForScore(score);
  let reason: string | null = null;
  let replaced: CookResult['replaced'] = null;
  const inv = sys.ctx.inventory;
  if (!hasDiningTable(sys)) {
    reason = DINING_TABLE_MISSING_REASON;                    // with no dining table the meal has nowhere to land — no material is spent
  } else if (inv && typeof inv.consumeCookInputs === 'function') {
    try {
      reason = inv.consumeCookInputs(recipeId, st.benchLevel);
    } catch (e) {
      console.error('[housing] inventory.consumeCookInputs threw', e);
      reason = '요리를 완성하지 못했습니다';
    }
  } else {
    console.warn('[housing] inventory.consumeCookInputs is not available — 요리를 만들지 못했다');
    reason = '요리를 완성할 수 없습니다 — 인벤토리가 아직 조리를 지원하지 않습니다';
  }
  if (!reason) {
    const before = setPlate(sys, mealDefId, quality, 'cooked');   // only after the materials are gone — the old plate is replaced here
    replaced = before ? { mealDefId: before.mealDefId, quality: before.quality } : null;
  }
  const result: CookResult = { recipeId, mealDefId, stepScores, stepAuto, score, quality, itemUid: null, landed: reason ? null : 'table', reason, replaced };
  st.result = result;
  if (!reason) {
    st.anyCompleted = true;
    // 2026-09-13 (H3): cooking skill XP — only a run that actually produced a meal, proportional to the score (a quarter at least)
    const prog = sys.ctx.progression;
    const xp = COOK_SKILL_XP * Math.max(0.25, score);   // lead 2026-09-13: skill XP runs on a fractional scale (CRAFT_XP 0.5), so it is not rounded
    if (prog && typeof prog.addSkillXp === 'function' && xp > 0) {
      try { prog.addSkillXp('cooking', xp); } catch (e) { console.error('[housing] progression.addSkillXp(cooking) threw', e); }
    }
  }
  sys.ctx.bus.emit('audio:play', { id: reason ? 'ui_deny' : 'cook_finish' });
  sys.ctx.bus.emit('housing:cookResult', { uid, result });
  return result;
}

/** The screen closed — clears the session and emits `housing:cookSession {active:false}`. */
export function endCook(sys: HousingSystem): void {
  const st = sys.cookState;
  if (!st) return;
  sys.cookState = null;
  const { uid, recipeId, mealDefId } = st.info;
  sys.ctx.bus.emit('housing:cookSession', { uid, recipeId, mealDefId, active: false, completed: st.anyCompleted });
}

/** Opens the cook bench screen. Not a cook bench, or a raid · someone else's ship · already cooking: a toast only. */
export function openCookStation(sys: HousingSystem, uid: string): void {
  const ctx = sys.ctx;
  if (!sys.cookStation) return;
  let reason: string | null = null;
  if (!cookBenchAt(sys, uid)) reason = '조리대가 아닙니다';
  else if (ctx.isRaidActive() || !ctx.isHubPhase()) reason = '함선에서만 요리할 수 있습니다';
  else if (ctx.hub && (ctx.hub.ship !== 'personal' || ctx.hub.visitReadOnly)) reason = '내 함선에서만 요리할 수 있습니다';
  // 2026-09-16 (the plate model, user's decision): with no dining-table furniture the cook bench cannot be used — the path an auto appliance opens passes here too
  else if (!hasDiningTable(sys)) reason = `${DINING_TABLE_MISSING_REASON} — 주방에 식탁을 놓아야 요리할 수 있습니다`;
  else if (sys.cookState) reason = '이미 조리 중입니다';
  if (reason) { sys.notify(reason, 'warning'); sys.ctx.bus.emit('audio:play', { id: 'ui_deny' }); return; }
  sys.exitHousingMode();
  sys.closeMenus(false);
  sys.cookStation.openStation(uid);
}

/** The outside events that cut the session — the same place as `parts/Gym.bindGym`. Once, in `init`. */
export function bindCooking(sys: HousingSystem): Array<() => void> {
  const b = sys.ctx.bus;
  const stop = (): void => cancelCook(sys);
  return [
    b.on('game:newMission', stop),
    b.on('game:abort', stop),
    b.on('hub:left', stop),
    b.on('game:phaseChanged', ({ phase }) => { if (phase !== 'hub') stop(); }),
    // the pose released itself (spawn · reset) — the overlay is not left standing while the pose is no longer the cook pose. `caller` is hub releasing it after taking our end.
    b.on('player:furniturePoseEnded', ({ kind, reason }) => {
      if (sys.cookState && reason !== 'caller' && kind === 'cook') stop();
    }),
  ];
}

/* ── Smoke hooks ──────────────────────────────────────────────────────────── */
export interface CookDebug {
  /** The overlay screen (`choose` the choice card · `game` the minigame · `auto` the auto presentation · `step` the step score · `result` the result), null when closed. */
  readonly screen: CookScreenKind | null;
  /** The judgement object being driven right now (the `game` · `step` screens), else null. */
  readonly game: AnyCookGame | null;
  /** The current step number (from 0), −1 when closed. */
  readonly stepIndex: number;
  /** The result of the last finished run (it survives the screen closing). */
  readonly result: CookResult | null;
  /** The cook bench screen: is it open · the bench uid · the chosen recipe · the 「조리 시작」 block reason. */
  readonly station: { open: boolean; uid: string; recipeId: string | null; startBlock: string | null };
  /** The choice card → manual (the same as `choose('manual')`). */
  start(): boolean;
  choose(mode: 'manual' | 'auto'): boolean;
  /** Ends the current step with `score` and moves **straight** on to the next step (or the result) — it does not wait for the step-score text. */
  finishStep(score: number): boolean;
  /** The result screen's 「다시 만들기」. */
  restart(): string | null;
  /** A new judgement object independent of the screen — the judgement rules alone are checked separately. Given a game name, the table's first step for that game (a default with none) is used. */
  makeGame(step: CookStepDef | CookGame): AnyCookGame;
  /** A summary of the cook bench recipes. */
  recipes(): { id: string; mealDefId: string; benchLevel: number; steps: CookGame[] }[];
  /** 2026-09-13 (H3): the cooking skill · library bonus that would be added to that step right now. */
  bonus(game: CookGame): CookStepBonus;
  /** 2026-09-13 (H3): the raw scores of the run in progress (before the bonus), [] with no session. */
  readonly stepRaw: readonly number[];
  /** 2026-09-16 (the plate model): whether the 「식탁의 요리를 바꿉니다」 warning is up (`ui/cook/PlateAsk`). */
  readonly replaceAsk: boolean;
  /** 2026-09-16: confirms the open replace warning without the hold (the cook start · restart follows). false when there was none. */
  confirmReplace(): boolean;
}

export function cookDebug(sys: HousingSystem): CookDebug {
  return {
    get screen() { return sys.cookScreen?.screen ?? null; },
    get game() { return sys.cookScreen?.game ?? null; },
    get stepIndex() { return sys.cookScreen?.isOpen ? sys.cookScreen.stepIndex : -1; },
    get result() { return sys.cookState?.result ?? sys.cookScreen?.lastResult ?? null; },
    get station() {
      const p = sys.cookStation;
      return { open: !!p?.isOpen, uid: p?.benchUid ?? '', recipeId: p?.selectedRecipeId ?? null, startBlock: p?.startBlock ?? null };
    },
    start: () => sys.cookScreen?.choose('manual') ?? false,
    choose: (mode) => sys.cookScreen?.choose(mode) ?? false,
    finishStep: (score: number) => sys.cookScreen?.finishStepWith(score) ?? false,
    restart: () => (sys.cookScreen ? sys.cookScreen.restart() : '조리 중이 아닙니다'),   // does not cover null (success) with `??`
    makeGame: (step) => {
      if (typeof step !== 'string') return createCookGame(step);
      const row = COOK_STEPS.find((s) => s.game === step);
      return createCookGame(row ?? {
        meal: 'debug', order: 1, game: step, items: step === 'grill' ? ['food_beef', 'food_chicken'] : [],
        liquid: step === 'pour' ? 'water' : null, targetMl: step === 'pour' ? 200 : null,
      });
    },
    recipes: () => cookRecipes(sys).map((r) => ({
      id: r.id, mealDefId: r.outputDefId, benchLevel: r.benchLevel ?? 1, steps: cookStepsOf(r.outputDefId).map((s) => s.game),
    })),
    bonus: (game: CookGame) => cookStepBonus(sys, game),
    get stepRaw() { return sys.cookState ? [...sys.cookState.stepRaw] : []; },
    get replaceAsk() { return !!sys.plateAsk?.handle.isOpen; },
    confirmReplace: () => {
      const a = sys.plateAsk;
      if (!a || !a.handle.isOpen) return false;
      a.confirm();
      return true;
    },
  };
}
