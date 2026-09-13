/**
 * src/housing/parts/Cooking.ts — **조리대 · 조리 세션** (2026-09-13, `docs/plans/cooking-minigames.md` §5 흐름 · §6-1).
 *
 * `parts/Gym.ts` 의 구조를 그대로 본떴다:
 *   ① 조리대 E → hub 가 `openCookStation(uid)` — 조리대 화면(`ui/cook/CookStation`, 요리 목록 · 재료 · 단계 · 자동 가구 · 창고/가방).
 *   ② 「조리 시작」 → `startCook(uid, recipeId)` — `cookBlock`(계약 주석의 순서) → 세션(`sys.cookState`) → 미니게임 오버레이
 *      (`ui/cook/CookScreen`)를 연 뒤 조리대 화면을 닫고 `housing:cookSession {active:true}` — hub 가 조리대 앞 자세 · 고정 카메라를
 *      건다 (자세가 거절되면 hub 가 같은 호출 스택에서 `cancelCook` 을 부른다).
 *   ③ 단계마다 「직접 하기 / 자동」 → 판정(`parts/CookGames`) → 단계 점수. 마지막 단계가 끝나면 `completeCookRun` —
 *      요리 점수(평균) → 품질 → `ctx.inventory.completeCook(recipeId, 조리대 레벨, 품질)` → `housing:cookResult`.
 *      **재료는 여기서만 빠진다** — 중간에 닫으면(Esc · Tab · 페이즈 변경 · 자세 리셋) 아무것도 소모되지 않는다.
 *   ④ 오버레이가 닫히면 `endCook` — `housing:cookSession {active:false, completed}` (`completed` = 이 세션에서 요리가 하나라도 나왔다).
 *
 * 품질 · 보너스 규칙은 하나도 여기 없다 — `shared/cooking` 의 함수(`cookScoreOf` · `mealQualityForScore`)와 inventory · progression 의 몫이다.
 * inventory 의 새 메서드(`cookBlock` · `completeCook`)는 계약에서 선택이라 **덕 타이핑**으로 부른다 — 없으면 결과가 「완성하지 못했다」고
 * 말한다 (조용히 성공한 척하지 않는다, `parts/Gym` 의 `applyGymSession` 과 같은 규약).
 */
import type {
  CookAutoInfo, CookGame, CookResult, CookSessionInfo, CookStepDef, CraftRecipe, FurnitureDef, PlacedFurniture,
} from '@/shared';
import {
  COOK_STEPS, cookAutoScore, cookGamesOfAppliance, cookScoreOf, cookStepsOf, mealQualityForScore,
} from '@/shared';
import type { HousingSystem } from '../HousingSystem';
import type { CookScreenKind } from '../ui/cook/CookScreen';
import { createCookGame } from './CookGames';
import type { AnyCookGame } from './CookGames';

/** 조리 오버레이의 `ctx.uiBlockers` 토큰 — 패널들의 `'housing'` 과 따로라, 조리대 화면이 닫히며 지워 가지 않는다. */
export const COOK_BLOCKER = 'housing.cook';

/** 제작 숙련 이름 (inventory 가 아직 `cookBlock` 을 주지 않을 때의 대체 사유 문구). */
const SKILL_LABEL_KO: Readonly<Record<CraftRecipe['skill'], string>> = { crafting: '제작', medicine: '의학', gardening: '원예' };

export interface CookState {
  info: CookSessionInfo;
  /** 시작할 때의 조리대 레벨 — `completeCook` 에 넘긴다. */
  benchLevel: number;
  /** 이번 판의 단계 점수 (순서대로, 아직이면 비어 있다). */
  stepScores: number[];
  /** 이번 판에서 단계마다 자동으로 처리했나. */
  stepAuto: boolean[];
  /** 이번 판을 마무리했다 (`completeCookRun` 을 불렀다). */
  finished: boolean;
  /** 이 세션에서 요리가 하나라도 나왔다 — 세션 끝 이벤트의 `completed`. */
  anyCompleted: boolean;
  /** 이번 판의 결과, 아직이면 null. */
  result: CookResult | null;
}

/* ── 조회 ─────────────────────────────────────────────────────────────────── */
/** `uid` 가 배치된 조리대(`workbench_cook`)면 그 가구. */
export function cookBenchAt(sys: HousingSystem, uid: string): { item: PlacedFurniture; def: FurnitureDef } | null {
  const item = sys.getPlacedByUid(uid);
  if (!item) return null;
  const def = sys.getFurnitureDef(item.defId);
  return def && def.interaction === 'workbench_cook' ? { item, def } : null;
}

/**
 * 조리대 레시피 전부 — `ctx.inventory.getRecipes('ship', 'cook', 99)`(조리대를 이름으로 물을 때만 조리대 레시피가 나온다 — 일반 제작
 * 목록 · `canCraft` · `craft` 에서는 빠졌다) 중 산출물에 조리 단계(`cookStepsOf`)가 있는 것. 잠김(조리대 레벨)은 화면이 `benchLevel` 로 가른다.
 * ⚠ 그 경로는 **숙련이 모자란 레시피를 걸러 낸다** — 숙련 잠김 요리는 목록에 없다 (설계안 §6-1 그대로). inventory 가 없을 때만 원본 표로 간다.
 */
export function cookRecipes(sys: HousingSystem): CraftRecipe[] {
  const inv = sys.ctx.inventory;
  const loot = sys.ctx.loot;
  let all: readonly CraftRecipe[] = [];
  if (inv && typeof inv.getRecipes === 'function') all = inv.getRecipes('ship', 'cook', 99);
  else if (loot && typeof loot.getAllRecipes === 'function') all = loot.getAllRecipes();
  return all.filter((r) => r.bench === 'cook' && cookStepsOf(r.outputDefId).length > 0);
}

/**
 * 레시피 하나 — 목록(`cookRecipes`)과 달리 **숙련으로 거르지 않는다**: 숙련이 모자란 요리를 부른 곳도 「요리 레시피가 아닙니다」 가 아니라
 * inventory `cookBlock` 의 진짜 사유(`제작 숙련 n 이 필요합니다`)를 받아야 한다.
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

/** 그 게임을 대신하는 자동 조리 가구 중 함선에 배치된 가장 높은 레벨의 것 (방은 묻지 않는다 — 주방에만 놓인다). */
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

/* ── 게이트 ───────────────────────────────────────────────────────────────── */
function blockCore(sys: HousingSystem, uid: string, recipeId: string, ignoreActive: boolean): string | null {
  const ctx = sys.ctx;
  const bench = cookBenchAt(sys, uid);
  if (!bench) return '조리대가 아닙니다';
  if (ctx.isRaidActive() || !ctx.isHubPhase()) return '함선에서만 요리할 수 있습니다';
  if (ctx.hub && (ctx.hub.ship !== 'personal' || ctx.hub.visitReadOnly)) return '내 함선에서만 요리할 수 있습니다';
  if (!ignoreActive && sys.cookState) return '이미 조리 중입니다';
  const recipe = cookRecipeOf(sys, recipeId);
  if (!recipe) return '요리 레시피가 아닙니다';
  if (!cookStepsOf(recipe.outputDefId).length) return '조리 단계가 없는 요리입니다';
  const inv = ctx.inventory;
  if (inv && typeof inv.cookBlock === 'function') return inv.cookBlock(recipeId, bench.item.level);
  return fallbackBlock(sys, recipe, bench.item.level);
}

/** inventory 가 `cookBlock` 을 아직 주지 않을 때 — 레벨 · 숙련 · 재료만 본다 (자리는 `completeCook` 이 없으면 어차피 끝에서 실패한다). */
function fallbackBlock(sys: HousingSystem, recipe: CraftRecipe, benchLevel: number): string | null {
  const need = recipe.benchLevel ?? 1;
  if (benchLevel < need) return `조리대 Lv.${need} 이 필요합니다`;
  const skill = sys.ctx.progression?.getSkill?.(recipe.skill) ?? 0;
  if (skill < recipe.skillRequired) return `${SKILL_LABEL_KO[recipe.skill] ?? recipe.skill} 숙련 ${recipe.skillRequired} 이 필요합니다`;
  if (!sys.canAfford(recipe.inputs)) return '재료가 부족합니다';
  return null;
}

/** 지금 조리대 `uid` 에서 `recipeId` 를 시작할 수 없는 한국어 사유 (계약 `HousingRef.cookBlock` 의 순서), null = 시작할 수 있다. */
export function cookBlock(sys: HousingSystem, uid: string, recipeId: string): string | null {
  return blockCore(sys, uid, recipeId, false);
}

/** 결과 화면의 「다시 만들기」 사유 — 지금 세션은 세지 않는다. 세션이 없으면 사유. */
export function restartBlock(sys: HousingSystem): string | null {
  const st = sys.cookState;
  if (!st) return '조리 중이 아닙니다';
  return blockCore(sys, st.info.uid, st.info.recipeId, true);
}

/* ── 세션 ─────────────────────────────────────────────────────────────────── */
export function startCook(sys: HousingSystem, uid: string, recipeId: string): string | null {
  const reason = cookBlock(sys, uid, recipeId);
  if (reason) return reason;
  const bench = cookBenchAt(sys, uid);
  const recipe = cookRecipeOf(sys, recipeId);
  const screen = sys.cookScreen;
  if (!bench || !recipe || !screen) return '조리를 시작할 수 없습니다';
  const info: CookSessionInfo = { uid, recipeId, mealDefId: recipe.outputDefId, steps: cookStepsOf(recipe.outputDefId) };
  sys.cookState = { info, benchLevel: bench.item.level, stepScores: [], stepAuto: [], finished: false, anyCompleted: false, result: null };
  // 오버레이가 먼저 커서 · 블로커를 잡고 나서 조리대 화면을 닫는다 — 그 사이에 포인터 락이 되돌아갔다 풀리지 않게
  screen.open(info, sys.nameOf(recipe.outputDefId));
  sys.exitHousingMode();
  sys.closeMenus(false);
  sys.ctx.bus.emit('audio:play', { id: 'cook_start' });
  sys.ctx.bus.emit('housing:cookSession', { uid, recipeId, mealDefId: info.mealDefId, active: true, completed: false });
  // hub 가 자세를 걸지 못하면 같은 호출 스택 안에서 `cancelCook` 이 온다 — 그때는 시작하지 못한 것이다
  if (!sys.cookState) return '조리를 시작할 수 없습니다';
  screen.beginSteps();
  return null;
}

/** 결과 화면의 「다시 만들기」 — 같은 세션(자세 · 카메라 유지)에서 같은 요리를 처음 단계부터. 한국어 사유 / null. */
export function restartCook(sys: HousingSystem): string | null {
  const st = sys.cookState;
  const reason = restartBlock(sys);
  if (reason || !st) return reason ?? '조리 중이 아닙니다';
  st.benchLevel = cookBenchAt(sys, st.info.uid)?.item.level ?? st.benchLevel;
  st.stepScores = [];
  st.stepAuto = [];
  st.finished = false;
  st.result = null;
  sys.ctx.bus.emit('audio:play', { id: 'cook_start' });
  return null;
}

/** 진행 중인 조리를 소모 없이 끝낸다 (결과 화면이었다면 이미 나온 요리는 그대로다). 없으면 no-op. */
export function cancelCook(sys: HousingSystem): void {
  if (!sys.cookState) return;
  if (sys.cookScreen?.isOpen) sys.cookScreen.close();     // 화면이 `endCook` 을 부른다
  else endCook(sys);
}

/** 화면이 단계 하나를 끝냈다 — 이번 판의 점수표에 적는다. */
export function recordCookStep(sys: HousingSystem, index: number, score: number, auto: boolean): void {
  const st = sys.cookState;
  if (!st || st.finished || index < 0 || index >= st.info.steps.length) return;
  st.stepScores[index] = Math.max(0, Math.min(1, Number.isFinite(score) ? score : 0));
  st.stepAuto[index] = auto;
}

/**
 * 이번 판을 마무리한다 — 요리 점수 · 품질을 내고 inventory 에 재료 소모 + 요리 1개를 맡긴다. 한 판에 한 번만.
 * inventory 에 `completeCook` 이 없거나 거절하면 결과의 `reason` 에 한국어 사유가 실린다 (아무것도 빠지지 않는다).
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
  let itemUid: string | null = null;
  let landed: 'bag' | 'stash' | null = null;
  let reason: string | null = null;
  const inv = sys.ctx.inventory;
  if (inv && typeof inv.completeCook === 'function') {
    try {
      const out = inv.completeCook(recipeId, st.benchLevel, quality);
      if (out && out.item) { itemUid = out.item.uid; landed = out.landed; }
      else reason = out?.reason || '요리를 완성하지 못했습니다';
    } catch (e) {
      console.error('[housing] inventory.completeCook threw', e);
      reason = '요리를 완성하지 못했습니다';
    }
  } else {
    console.warn('[housing] inventory.completeCook is not available — 요리를 만들지 못했다');
    reason = '요리를 완성할 수 없습니다 — 인벤토리가 아직 조리를 지원하지 않습니다';
  }
  const result: CookResult = { recipeId, mealDefId, stepScores, stepAuto, score, quality, itemUid, landed: reason ? null : landed, reason };
  st.result = result;
  if (!reason) st.anyCompleted = true;
  sys.ctx.bus.emit('audio:play', { id: reason ? 'ui_deny' : 'cook_finish' });
  sys.ctx.bus.emit('housing:cookResult', { uid, result });
  return result;
}

/** 화면이 닫혔다 — 세션을 비우고 `housing:cookSession {active:false}`. */
export function endCook(sys: HousingSystem): void {
  const st = sys.cookState;
  if (!st) return;
  sys.cookState = null;
  const { uid, recipeId, mealDefId } = st.info;
  sys.ctx.bus.emit('housing:cookSession', { uid, recipeId, mealDefId, active: false, completed: st.anyCompleted });
}

/** 조리대 화면을 연다. 조리대가 아니거나 레이드 · 남의 함선 · 조리 중이면 토스트만. */
export function openCookStation(sys: HousingSystem, uid: string): void {
  const ctx = sys.ctx;
  if (!sys.cookStation) return;
  let reason: string | null = null;
  if (!cookBenchAt(sys, uid)) reason = '조리대가 아닙니다';
  else if (ctx.isRaidActive() || !ctx.isHubPhase()) reason = '함선에서만 요리할 수 있습니다';
  else if (ctx.hub && (ctx.hub.ship !== 'personal' || ctx.hub.visitReadOnly)) reason = '내 함선에서만 요리할 수 있습니다';
  else if (sys.cookState) reason = '이미 조리 중입니다';
  if (reason) { sys.notify(reason, 'warning'); return; }
  sys.exitHousingMode();
  sys.closeMenus(false);
  sys.cookStation.openStation(uid);
}

/** 세션을 끊는 바깥 사건들 — `parts/Gym.bindGym` 과 같은 자리. `init` 에서 한 번. */
export function bindCooking(sys: HousingSystem): Array<() => void> {
  const b = sys.ctx.bus;
  const stop = (): void => cancelCook(sys);
  return [
    b.on('game:newMission', stop),
    b.on('game:abort', stop),
    b.on('hub:left', stop),
    b.on('game:phaseChanged', ({ phase }) => { if (phase !== 'hub') stop(); }),
    // 자세가 스스로 풀렸다(스폰 · 리셋) — 조리 자세가 아닌데 오버레이만 남기지 않는다. `caller` 는 hub 가 우리 끝을 받아 푼 것이다.
    b.on('player:furniturePoseEnded', ({ kind, reason }) => {
      if (sys.cookState && reason !== 'caller' && kind === 'cook') stop();
    }),
  ];
}

/* ── 스모크 훅 ────────────────────────────────────────────────────────────── */
export interface CookDebug {
  /** 오버레이 화면 (`choose` 선택 카드 · `game` 미니게임 · `auto` 자동 연출 · `step` 단계 점수 · `result` 결과), 닫혀 있으면 null. */
  readonly screen: CookScreenKind | null;
  /** 지금 몰고 있는 판정 객체 (`game` · `step` 화면), 아니면 null. */
  readonly game: AnyCookGame | null;
  /** 지금 단계 번호 (0 부터), 닫혀 있으면 −1. */
  readonly stepIndex: number;
  /** 마지막으로 끝낸 판의 결과 (화면을 닫은 뒤에도 남는다). */
  readonly result: CookResult | null;
  /** 조리대 화면: 열렸나 · 조리대 uid · 고른 레시피 · 「조리 시작」 막힘 사유. */
  readonly station: { open: boolean; uid: string; recipeId: string | null; startBlock: string | null };
  /** 선택 카드 → 직접 하기 (`choose('manual')` 과 같다). */
  start(): boolean;
  choose(mode: 'manual' | 'auto'): boolean;
  /** 지금 단계를 `score` 로 끝내고 **곧장** 다음 단계(또는 결과)로 넘어간다 — 단계 점수 글자를 기다리지 않는다. */
  finishStep(score: number): boolean;
  /** 결과 화면의 「다시 만들기」. */
  restart(): string | null;
  /** 화면과 무관한 새 판정 객체 — 판정 규칙만 따로 검사한다. 게임 이름이면 표에서 그 게임의 첫 단계(없으면 기본값)를 쓴다. */
  makeGame(step: CookStepDef | CookGame): AnyCookGame;
  /** 조리대 레시피 요약. */
  recipes(): { id: string; mealDefId: string; benchLevel: number; steps: CookGame[] }[];
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
    restart: () => (sys.cookScreen ? sys.cookScreen.restart() : '조리 중이 아닙니다'),   // null(성공)을 `??` 로 덮지 않는다
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
  };
}
