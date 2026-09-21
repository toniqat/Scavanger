/**
 * src/housing/parts/Gym.ts — **the gym training session** (A-3a, 2026-09-12).
 *
 * E at a piece of gym equipment (bench rack · Smith machine · treadmill · cycle) → hub calls `startGymSession(uid)`. What happens here:
 *   ① `gymBlock` — not gym equipment · not in the ship (a raid included) · someone else's ship · already in a session · another screen is open.
 *   ② It raises the session state (`sys.gymState`), opens the minigame screen (`ui/gym/GymScreen`), then `housing:gymSession {active:true}` —
 *      hub sees that and puts up the weight plates · the pose · the fixed camera (if the pose is refused, hub calls `cancelGymSession`).
 *   ③ Once the game ends, `completeGymSession` — the score is handed to `ctx.progression.applyGymSession`, then `housing:gymResult`.
 *      If progression does not have that method yet, the result screen says 「반영하지 못했다」 (it never quietly pretends to have succeeded).
 *   ④ Once the screen closes, `endGymSession` — `housing:gymSession {active:false, completed}`. `completed` means **the game was played to the
 *      end** (so the score was handed over) and is false on a cancel (Esc · Tab · a phase change). A cancel has no reward and no debuff.
 *
 * Not one rule (training XP · debuffs) lives here — that is progression's job. housing holds only the judgement (`parts/GymGames`) and the flow.
 */
import type {
  FurnitureDef, FurniturePoseKind, GymEquipmentDef, GymMinigame, GymSessionInfo, GymSessionResult, HousingRef, LibraryGymTarget, PlacedFurniture,
} from '@/shared';
import { LIBRARY_GYM_TARGETS, gymEquipmentOf } from '@/shared';   // LIBRARY_GYM_TARGETS: the library gym bonus (H3, 2026-09-13)
import type { HousingSystem } from '../HousingSystem';
import { createGymGame } from './GymGames';
import type { GymGame } from './GymGames';

/** The gym screen's `ctx.uiBlockers` token — separate from the panels' `'housing'`, so a closing panel never clears it. */
export const GYM_BLOCKER = 'housing.gym';

export interface GymState {
  info: GymSessionInfo;
  /** The pose this equipment uses — used to tell whether a `player:furniturePoseEnded` is this session's pose. */
  pose: FurniturePoseKind;
  /** The game was played to the end (the score was handed to progression). */
  finished: boolean;
  /** The result of `applyGymSession` — null with no progression, or when it refused. */
  result: GymSessionResult | null;
  /** The finishing score (0 … 1). */
  score: number;
}

export function gymEquipmentAt(sys: HousingSystem, uid: string): { item: PlacedFurniture; def: FurnitureDef; eq: GymEquipmentDef } | null {
  const item = sys.getPlacedByUid(uid);
  if (!item) return null;
  const def = sys.getFurnitureDef(item.defId);
  if (!def) return null;
  const eq = gymEquipmentOf(def.interaction);
  return eq ? { item, def, eq } : null;
}

export function gymSession(sys: HousingSystem): GymSessionInfo | null {
  return sys.gymState ? sys.gymState.info : null;
}

/** The Korean reason `startGymSession(uid)` would refuse with right now, null = it can start. */
export function gymBlock(sys: HousingSystem, uid: string): string | null {
  const ctx = sys.ctx;
  if (!gymEquipmentAt(sys, uid)) return '운동 기구가 아닙니다';
  if (ctx.isRaidActive() || !ctx.isHubPhase()) return '함선에서만 운동할 수 있습니다';
  if (ctx.hub && (ctx.hub.ship !== 'personal' || ctx.hub.visitReadOnly)) return '내 함선에서만 운동할 수 있습니다';
  if (sys.gymState) return '이미 운동 중입니다';
  if (sys.housingMode || sys.shipManageMode || sys.isMenuOpen || ctx.uiBlockers.size > 0) return '다른 화면을 먼저 닫으세요';
  return null;
}

export function startGymSession(sys: HousingSystem, uid: string): string | null {
  const reason = gymBlock(sys, uid);
  if (reason) return reason;
  const hit = gymEquipmentAt(sys, uid);
  if (!hit || !sys.gymScreen) return '운동을 시작할 수 없습니다';
  const info: GymSessionInfo = { uid, defId: hit.item.defId, stat: hit.eq.stat, minigame: hit.eq.minigame };
  sys.gymState = { info, pose: hit.eq.pose, finished: false, result: null, score: 0 };
  sys.gymScreen.open(info, hit.def.name);
  sys.ctx.bus.emit('housing:gymSession', { uid, active: true, stat: info.stat, minigame: info.minigame, completed: false });
  // if hub cannot raise the pose, `cancelGymSession` arrives inside the same call stack — and then it did not start
  return sys.gymState ? null : '운동을 시작할 수 없습니다';
}

/** Ends the running session — no reward and no debuff unless it reached the result screen. A no-op when there is none. */
export function cancelGymSession(sys: HousingSystem): void {
  if (!sys.gymState) return;
  if (sys.gymScreen?.isOpen) sys.gymScreen.close();     // the screen calls `endGymSession`
  else endGymSession(sys);
}

/**
 * The game was played to the end — the score is handed to progression and `housing:gymResult` is emitted. It applies once per session only.
 * With no `applyGymSession` on progression, or a null one (in a raid and so on), the result is null.
 */
export function completeGymSession(sys: HousingSystem, score: number): GymSessionResult | null {
  const st = sys.gymState;
  if (!st) return null;
  if (st.finished) return st.result;
  st.finished = true;
  st.score = Math.max(0, Math.min(1, Number.isFinite(score) ? score : 0));
  /* ══ the library gym bonus (H3, 2026-09-13) ══
   * For the four kinds of gym equipment (`LIBRARY_GYM_TARGETS`), `getLibraryEffects().gymScore[the equipment's interaction]` is added to the
   * session score and clamped to 1. A game (TV) session is `parts/VideoGame.ts`'s job and is not an equipment interaction, so it gains nothing
   * from passing through here. */
  {
    const interaction = sys.getFurnitureDef(st.info.defId)?.interaction;
    if (interaction && (LIBRARY_GYM_TARGETS as readonly string[]).includes(interaction)) {
      const ref: HousingRef | null = sys.ctx.housing ?? null;
      const lib = ref && typeof ref.getLibraryEffects === 'function' ? ref.getLibraryEffects() : null;
      const add = lib?.gymScore?.[interaction as LibraryGymTarget];
      if (typeof add === 'number' && Number.isFinite(add) && add > 0) st.score = Math.min(1, st.score + add);
    }
  }
  /* ══ end the library gym bonus (H3) ══ */
  const prog = sys.ctx.progression;
  if (prog && typeof prog.applyGymSession === 'function') {
    try { st.result = prog.applyGymSession(st.info.stat, st.score); } catch (e) { console.error('[housing] applyGymSession threw', e); st.result = null; }
  } else {
    console.warn('[housing] progression.applyGymSession is not available — 운동 결과를 반영하지 못했다');
  }
  sys.ctx.bus.emit('audio:play', { id: 'gym_finish' });
  if (st.result) sys.ctx.bus.emit('housing:gymResult', { uid: st.info.uid, result: st.result });
  return st.result;
}

/** The screen closed — the session is cleared and `housing:gymSession {active:false}`. */
export function endGymSession(sys: HousingSystem): void {
  const st = sys.gymState;
  if (!st) return;
  sys.gymState = null;
  const { uid, stat, minigame } = st.info;
  sys.ctx.bus.emit('housing:gymSession', { uid, active: false, stat, minigame, completed: st.finished });
}

/** The outside events that cut the session — the same place as the path that closes other panels (`closeMenus`). Once, in `init`. */
export function bindGym(sys: HousingSystem): Array<() => void> {
  const b = sys.ctx.bus;
  const stop = (): void => cancelGymSession(sys);
  return [
    b.on('game:newMission', stop),
    b.on('game:abort', stop),
    b.on('hub:left', stop),
    b.on('game:phaseChanged', ({ phase }) => { if (phase !== 'hub') stop(); }),
    // the pose released itself (spawn · reset) — the gym screen is never left up without the gym pose. `caller` means hub released it on receiving our end.
    b.on('player:furniturePoseEnded', ({ kind, reason }) => {
      if (sys.gymState && reason !== 'caller' && kind === sys.gymState.pose) stop();
    }),
  ];
}

/* ── Smoke hooks ──────────────────────────────────────────────────────────── */
export interface GymDebug {
  readonly screen: 'intro' | 'game' | 'result' | null;
  /** The judge object the screen is driving right now (null unless it is the game screen). */
  readonly game: GymGame | null;
  /** The last finished session's result (it survives closing the screen). */
  readonly result: GymSessionResult | null;
  /** Intro → game (the same as Space). */
  start(): boolean;
  /** Skips the game and ends on `score` → the result screen. */
  finish(score: number): GymSessionResult | null;
  /** A new judge object with no screen attached — for checking the judgement rules on their own. */
  makeGame(kind: GymMinigame): GymGame;
}

export function gymDebug(sys: HousingSystem): GymDebug {
  return {
    get screen() { return sys.gymScreen?.screen ?? null; },
    get game() { return sys.gymScreen?.screen === 'game' ? sys.gymScreen.game : null; },
    get result() { return sys.gymState?.result ?? sys.gymScreen?.lastResult ?? null; },
    start: () => sys.gymScreen?.start() ?? false,
    finish: (score: number) => sys.gymScreen?.finishWith(score) ?? null,
    makeGame: (kind: GymMinigame) => createGymGame(kind),
  };
}
