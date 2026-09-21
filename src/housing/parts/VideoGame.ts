/**
 * src/housing/parts/VideoGame.ts — **video games** (2026-09-13, H2).
 *
 * A console is attached to the TV (`ShipState.tvConsoles`), and of the discs shelved on a game disc stand (`game_stand`, library medium `game`) the ones
 * the console matches are played. With a seat facing the TV in front of it the player sits there, else plays **standing** (2026-09-17 user's decision — a seat is no condition).
 * It has **the same shape** as a gym session (`parts/Gym`):
 *   ① `gameBlock` — not a TV · not the ship (a raid included) · someone else's ship · already in a session · another screen · the disc · the console.
 *      The TV screen (`ui/tv/TvMenu`) being open is not a reason — `startGameSession` closes it and starts.
 *   ② Stands the session state (`sys.gameState`) up and opens the gym screen (`ui/gym/GymScreen`'s game mode — title = the disc name · accent = the disc colour ·
 *      the judgement = `createGymGame(minigame, tuning)`), then `housing:gameSession {active:true}` — with a seat, hub sits the player down and holds a fixed
 *      camera on the TV (when the seated pose is refused hub calls `cancelGameSession` **inside the same call stack**). With `seatUid` null there is no pose:
 *      only the TV game screen comes up, where the player stands and with the usual camera.
 *   ③ Playing it through calls `completeGameSession` — `ctx.progression.applyGymSession(disc.stat, score)` → `housing:gameResult`.
 *      The XP formula · the 24 h debuff are the gym's (user's decision 「헬스와 동일」) — progression owns the rules. Playing during the debuff works too (XP 0).
 *   ④ When the screen closes, `endGameSession` — `housing:gameSession {active:false, completed}`. Cancelling gives no reward and no debuff.
 * Starting turns on a TV that was off (`toggleFurniture`). Which seat is taken is decided by `Rules.tvSeatFor` alone.
 *
 * Attaching a console is a **reversible** act, so there is no 1 s hold. It is taken bag → stash (`consumeDefAll`), and a swap · detach gives it back bag → stash.
 * Recovering the TV returns the console to the **ship stash** — with no room the recovery itself is refused (`parts/Furniture.recover`, the library holder's contract).
 */
import type {
  BookSlotInfo, GameSessionInfo, GymMinigame, GymSessionResult, ItemDef, PlacedFurniture, PlayableGameInfo, TvConsoleSlot,
} from '@/shared';
import type { GymGameTuning } from '@/shared';
import { FURNITURE_DEF_MAP, GAME_MINIGAME_LABEL_KO as SHARED_GAME_MINIGAME_LABEL_KO, GAME_STATS, gameMinigameLabel as sharedGameMinigameLabel } from '@/shared';
import type { HousingSystem } from '../HousingSystem';
import { tvSeatFor } from '../Rules';
import type { TvSeatResult } from '../Rules';
import { createGymGame } from './GymGames';
import type { GymGame } from './GymGames';

/** The game screen's `ctx.uiBlockers` · ESC · key guide token — separate from the gym's (`housing.gym`), so hub · player can tell the two apart. */
export const GAME_BLOCKER = 'housing.game';
/**
 * The blocker the TV screen (`HousingPanel`) raises — the shared housing-panel token `'housing'`. `gameBlock` counts this token as 「another
 * screen」 except while the TV screen is open (another housing panel is caught separately by `sys.isMenuOpen`).
 */
export const TV_MENU_BLOCKER = 'housing';

/**
 * The game-kind names (user's decision 「벤치프레스형 · 호흡형 · 사이클형」). 2026-09-19 (B-32): the table moved to
 * `@/shared` because ui's item tooltip prints the same name and may not read this folder — kept re-exported so
 * this folder's public API and its call sites do not move. The gym equipment list (`GYM_MINIGAME_LABEL_KO`) is
 * still a separate name.
 */
export const GAME_MINIGAME_LABEL_KO = SHARED_GAME_MINIGAME_LABEL_KO;

/**
 * The refusal when a TV cannot be recovered · its console cannot be pulled because the ship stash has no room for the
 * console (`SHELF_BLOCK_REASON`'s shape — the pre-check and the real move must say the same sentence).
 */
export const TV_CONSOLE_BLOCK_REASON = '게임기를 돌려줄 함선 창고 자리가 없습니다 — 게임기를 먼저 빼세요';

export interface GameState {
  info: GameSessionInfo;
  /** The disc name (result · toast). */
  discName: string;
  /** The game was played through (the score was handed to progression). */
  finished: boolean;
  /** The result of `applyGymSession` — null when progression is missing or refused. */
  result: GymSessionResult | null;
  /** The score it finished on (0 … 1). */
  score: number;
}

/* ── Queries ──────────────────────────────────────────────────────────────── */

/** The placed TV (`interaction 'tv'`), else null. */
export function tvOf(sys: HousingSystem, uid: string): PlacedFurniture | null {
  const item = sys.getPlacedByUid(uid);
  return item && FURNITURE_DEF_MAP.get(item.defId)?.interaction === 'tv' ? item : null;
}

/** `ShipState.tvConsoles` (an empty array is attached when missing — sanitizing is `ShipState.sanitize`'s job). */
export function tvConsoleSlots(sys: HousingSystem): TvConsoleSlot[] {
  if (!Array.isArray(sys.state.tvConsoles)) sys.state.tvConsoles = [];
  return sys.state.tvConsoles;
}

/** The console item def (`ItemDef.gameConsole`), else null. */
export function consoleDefOf(sys: HousingSystem, defId: string | null | undefined): ItemDef | null {
  if (!defId) return null;
  const def = sys.defOf(defId);
  return def?.gameConsole ? def : null;
}

/** The game disc item def (`ItemDef.gameDisc`, its stat intelligence · perception), else null. */
export function gameDiscDefOf(sys: HousingSystem, defId: string | null | undefined): ItemDef | null {
  if (!defId) return null;
  const def = sys.defOf(defId);
  return def?.gameDisc && GAME_STATS.includes(def.gameDisc.stat) ? def : null;
}

/** The name of a console kind (`GameConsoleDef.console`) — that kind's console item name, else the kind string. */
export function consoleKindName(sys: HousingSystem, kind: string): string {
  const loot = sys.ctx.loot;
  if (loot && typeof loot.getAllItemDefs === 'function') {
    for (const d of loot.getAllItemDefs()) if (d.gameConsole?.console === kind) return d.name;
  }
  return kind;
}

export function getTvConsole(sys: HousingSystem, tvUid: string): string | null {
  return tvConsoleSlots(sys).find((s) => s.uid === tvUid)?.defId ?? null;
}

/** The consoles owned (bag + stash), by name. */
export function getOwnedConsoles(sys: HousingSystem): { defId: string; qty: number }[] {
  const loot = sys.ctx.loot;
  if (!loot || typeof loot.getAllItemDefs !== 'function') return [];
  const out: { defId: string; qty: number; name: string }[] = [];
  for (const def of loot.getAllItemDefs()) {
    if (!def.gameConsole || def.retired) continue;
    const qty = sys.countDef(def.id);
    if (qty > 0) out.push({ defId: def.id, qty, name: def.name });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  return out.map(({ defId, qty }) => ({ defId, qty }));
}

/** The ship gate — a Korean reason during a raid · outside the ship · on someone else's ship (`what` = the tail, like 「게임을 할 수 있습니다」). */
function shipGate(sys: HousingSystem, what: string): string | null {
  const ctx = sys.ctx;
  if (ctx.isRaidActive() || !ctx.isHubPhase()) return `함선에서만 ${what}`;
  if (ctx.hub && (ctx.hub.ship !== 'personal' || ctx.hub.visitReadOnly)) return `내 함선에서만 ${what}`;
  return null;
}

/* ── Attaching a console ──────────────────────────────────────────────────── */

export function attachTvConsole(sys: HousingSystem, tvUid: string, defId: string): string | null {
  if (!tvOf(sys, tvUid)) return 'TV 가 아닙니다';
  const gate = shipGate(sys, '게임기를 장착할 수 있습니다');
  if (gate) return gate;
  if (sys.gameState?.info.tvUid === tvUid) return '게임 중에는 게임기를 바꿀 수 없습니다';
  const def = consoleDefOf(sys, defId);
  if (!def) return '게임기가 아닙니다';
  const old = getTvConsole(sys, tvUid);
  if (old === defId) return `이미 ${def.name}이(가) 장착되어 있습니다`;
  if (sys.countDef(defId) < 1) return `${def.name}이(가) 없습니다`;
  const inv = sys.ctx.inventory, loot = sys.ctx.loot;
  if (!inv || typeof inv.consumeDefAll !== 'function') return '게임기를 꺼낼 수 없습니다';
  if (old && (!loot || typeof loot.createItem !== 'function' || typeof inv.tryAddItemAnywhere !== 'function')) return '장착된 게임기를 돌려줄 수 없습니다';
  // The new one is taken out first (the place it leaves may be where the old one goes) → when the old one fits in neither bag nor stash the new one is put back
  if (!inv.consumeDefAll(defId, 1)) return '게임기를 꺼낼 수 없습니다';
  if (old) {
    if (!inv.tryAddItemAnywhere(loot!.createItem(old, 1))) {
      if (!inv.tryAddItemAnywhere(loot!.createItem(defId, 1))) console.warn(`[housing] attachTvConsole: ${defId} 를 되돌리지 못했다`);
      return '가방과 창고에 자리가 없습니다 — 장착된 게임기를 돌려줄 수 없습니다';
    }
  }
  const slots = tvConsoleSlots(sys);
  const hit = slots.find((s) => s.uid === tvUid);
  if (hit) hit.defId = defId; else slots.push({ uid: tvUid, defId });
  sys.ctx.bus.emit('housing:tvConsoleChanged', { uid: tvUid, defId });
  sys.changed('tvConsole');
  return null;
}

export function detachTvConsole(sys: HousingSystem, tvUid: string): string | null {
  if (!tvOf(sys, tvUid)) return 'TV 가 아닙니다';
  const gate = shipGate(sys, '게임기를 뺄 수 있습니다');
  if (gate) return gate;
  if (sys.gameState?.info.tvUid === tvUid) return '게임 중에는 게임기를 뺄 수 없습니다';
  const old = getTvConsole(sys, tvUid);
  if (!old) return '장착된 게임기가 없습니다';
  const inv = sys.ctx.inventory, loot = sys.ctx.loot;
  if (!inv || typeof inv.tryAddItemAnywhere !== 'function' || !loot || typeof loot.createItem !== 'function') return '게임기를 돌려줄 수 없습니다';
  if (!inv.tryAddItemAnywhere(loot.createItem(old, 1))) return '가방과 창고에 자리가 없습니다';
  const slots = tvConsoleSlots(sys);
  slots.splice(slots.findIndex((s) => s.uid === tvUid), 1);
  sys.ctx.bus.emit('housing:tvConsoleChanged', { uid: tvUid, defId: null });
  sys.changed('tvConsole');
  return null;
}

/** The reason that blocks recovering a TV — the attached console has no room in the ship stash (a free-cell estimate, for `recoverBlock`). */
export function tvConsoleRecoverBlock(sys: HousingSystem, uid: string): string | null {
  if (!tvOf(sys, uid)) return null;
  const defId = getTvConsole(sys, uid);
  if (!defId) return null;
  return sys.stashSpaceBlock([{ defId, qty: 1 }]) ? TV_CONSOLE_BLOCK_REASON : null;
}

/**
 * Just before a TV is recovered — the attached console is returned to the **ship stash** and its slot dropped (`housing:tvConsoleChanged {defId:null}`). Recovery saves.
 * When the stash cannot take it, nothing changes and a Korean reason comes back (the recovery is refused). null when it is not a TV, or holds no console.
 */
export function returnTvConsoleForRecover(sys: HousingSystem, uid: string): string | null {
  if (!tvOf(sys, uid)) return null;
  const defId = getTvConsole(sys, uid);
  if (!defId) return null;
  const inv = sys.ctx.inventory, loot = sys.ctx.loot;
  if (!inv || typeof inv.tryAddToStash !== 'function' || !loot || typeof loot.createItem !== 'function') return '게임기를 돌려줄 수 없습니다';
  if (!inv.tryAddToStash(loot.createItem(defId, 1))) return TV_CONSOLE_BLOCK_REASON;
  const slots = tvConsoleSlots(sys);
  slots.splice(slots.findIndex((s) => s.uid === uid), 1);
  sys.ctx.bus.emit('housing:tvConsoleChanged', { uid, defId: null });
  return null;
}

/* ── The seat · the game list ─────────────────────────────────────────────── */

export function getTvSeat(sys: HousingSystem, tvUid: string): string | null {
  return tvSeatFor(sys.state, tvUid).seatUid;
}

export function tvSeatBlock(sys: HousingSystem, tvUid: string): string | null {
  return tvSeatFor(sys.state, tvUid).reason;
}

/** The placed game disc stands (library medium `game`) — an empty array while H1's holder API is not there yet. */
function gameStands(sys: HousingSystem): PlacedFurniture[] {
  if (typeof sys.getShelfMedium !== 'function') return [];
  return sys.state.furniture.filter((f) => {
    try { return sys.getShelfMedium(f.uid) === 'game'; } catch { return false; }
  });
}

/**
 * The games this TV can pick — the discs shelved on every game disc stand on the ship (one row when the same disc sits on several, a working stand first).
 * `block` = no console · the console does not match · the stand is stopped. **The debuff and the seat are not reasons** (the debuff = play for XP 0, no seat = play standing — 2026-09-17).
 */
export function getPlayableGames(sys: HousingSystem, tvUid: string): PlayableGameInfo[] {
  const consoleId = tvOf(sys, tvUid) ? getTvConsole(sys, tvUid) : null;
  const consoleKind = consoleDefOf(sys, consoleId)?.gameConsole?.console ?? null;
  const seen = new Map<string, PlayableGameInfo>();
  for (const stand of gameStands(sys)) {
    const standBlock = sys.furnitureOperationalBlock(stand.uid);
    let slots: BookSlotInfo[] = [];
    try { slots = sys.getShelfSlots(stand.uid); } catch { slots = []; }
    for (const s of slots) {
      const def = gameDiscDefOf(sys, s.defId);
      if (!def?.gameDisc) continue;
      let block: string | null = null;
      if (!consoleId) block = '게임기를 먼저 장착하세요';
      else if (consoleKind !== def.gameDisc.console) block = `${consoleKindName(sys, def.gameDisc.console)} 전용 게임입니다`;
      else if (standBlock) block = `게임 디스크 전시대 — ${standBlock}`;
      const prev = seen.get(def.id);
      if (!prev || (prev.block && !block)) seen.set(def.id, { defId: def.id, standUid: stand.uid, block });
    }
  }
  return [...seen.values()];
}

/* ── The session ──────────────────────────────────────────────────────────── */

export function gameSession(sys: HousingSystem): GameSessionInfo | null {
  return sys.gameState ? sys.gameState.info : null;
}

/** Is a screen (blocker) other than the TV screen open. */
function otherScreenOpen(sys: HousingSystem): boolean {
  const ctx = sys.ctx;
  // Lead 2026-09-13: the TV screen joined `panels()` — instead of `isMenuOpen` only the panels other than the TV screen are read
  if (sys.housingMode || sys.shipManageMode || sys.panels().some((p) => p.isOpen && p !== sys.tvMenu)) return true;
  const tvOpen = !!sys.tvMenu?.isOpen;
  for (const b of ctx.uiBlockers) if (!(tvOpen && b === TV_MENU_BLOCKER)) return true;
  return false;
}

/** The Korean reason `startGameSession(tvUid, discDefId)` would refuse with right now, null = it can start. */
export function gameBlock(sys: HousingSystem, tvUid: string, discDefId: string): string | null {
  if (!tvOf(sys, tvUid)) return 'TV 가 아닙니다';
  const gate = shipGate(sys, '게임을 할 수 있습니다');
  if (gate) return gate;
  if (sys.gameState) return '이미 게임 중입니다';
  if (sys.gymState) return '운동 중에는 게임을 할 수 없습니다';
  if (sys.cookState) return '조리 중에는 게임을 할 수 없습니다';
  if (otherScreenOpen(sys)) return '다른 화면을 먼저 닫으세요';
  if (!gameDiscDefOf(sys, discDefId)) return '게임 디스크가 아닙니다';
  const entry = getPlayableGames(sys, tvUid).find((g) => g.defId === discDefId);
  if (!entry) return '게임 디스크 전시대에 꽂혀 있지 않습니다';
  // 2026-09-17 (user's decision): the seat is not a reason — with none the session runs standing (`seatUid` null in `startGameSession`)
  return entry.block;
}

export function startGameSession(sys: HousingSystem, tvUid: string, discDefId: string): string | null {
  const reason = gameBlock(sys, tvUid, discDefId);
  if (reason) return reason;
  const def = gameDiscDefOf(sys, discDefId);
  // With a valid seat the player sits there (hub `GameStaging`), else null — no pose, only the TV game screen with the player standing
  const seatUid = tvSeatFor(sys.state, tvUid).seatUid;
  if (!def?.gameDisc || !sys.gymScreen) return '게임을 시작할 수 없습니다';
  const disc = def.gameDisc;
  if (sys.tvMenu?.isOpen) sys.tvMenu.close(false);             // close the TV screen and move on to the game screen
  if (!sys.isFurnitureOn(tvUid)) sys.toggleFurniture(tvUid);   // turn on a TV that was off
  const info: GameSessionInfo = { tvUid, seatUid, discDefId, stat: disc.stat, minigame: disc.minigame };
  sys.gameState = { info, discName: def.name, finished: false, result: null, score: 0 };
  sys.gymScreen.openGame(info, { title: def.name, color: disc.color, tuning: disc.tuning, consoleName: consoleKindName(sys, disc.console) });
  sys.ctx.bus.emit('housing:gameSession', { ...info, active: true, completed: false });
  // When hub cannot hold the seated pose, `cancelGameSession` arrives inside the same call stack — then it never started
  return sys.gameState ? null : '게임을 시작할 수 없습니다';
}

/** Ends a running session — no reward and no debuff unless it was on the result screen. A no-op with none. */
export function cancelGameSession(sys: HousingSystem): void {
  if (!sys.gameState) return;
  if (sys.gymScreen?.isOpen && sys.gymScreen.mode === 'game') sys.gymScreen.close();   // the screen calls `endGameSession`
  else endGameSession(sys);
}

/** The game was played through — the score goes to progression and `housing:gameResult` fires. Applied once per session only. */
export function completeGameSession(sys: HousingSystem, score: number): GymSessionResult | null {
  const st = sys.gameState;
  if (!st) return null;
  if (st.finished) return st.result;
  st.finished = true;
  st.score = Math.max(0, Math.min(1, Number.isFinite(score) ? score : 0));
  const prog = sys.ctx.progression;
  if (prog && typeof prog.applyGymSession === 'function') {
    try { st.result = prog.applyGymSession(st.info.stat, st.score); } catch (e) { console.error('[housing] applyGymSession threw (game)', e); st.result = null; }
  } else {
    console.warn('[housing] progression.applyGymSession is not available — 게임 결과를 반영하지 못했다');
  }
  sys.ctx.bus.emit('audio:play', { id: 'gym_finish' });
  if (st.result) sys.ctx.bus.emit('housing:gameResult', { tvUid: st.info.tvUid, discDefId: st.info.discDefId, result: st.result });
  return st.result;
}

/** The screen closed — the session is cleared and `housing:gameSession {active:false}`. */
export function endGameSession(sys: HousingSystem): void {
  const st = sys.gameState;
  if (!st) return;
  sys.gameState = null;
  sys.ctx.bus.emit('housing:gameSession', { ...st.info, active: false, completed: st.finished });
}

/* ── The TV screen ────────────────────────────────────────────────────────── */

/** Opens the TV screen (hub's E on the TV). It ends in a toast when it is not my ship, or a session is running. */
export function openTvMenu(sys: HousingSystem, tvUid: string): void {
  if (!tvOf(sys, tvUid)) { sys.notify('TV 가 아닙니다', 'warning'); return; }
  const gate = shipGate(sys, 'TV 를 쓸 수 있습니다');
  if (gate) { sys.notify(gate, 'warning'); return; }
  if (sys.gameState || sys.gymState) return;
  sys.closeMenus(false);
  sys.tvMenu?.openTv(tvUid);
}

/** The outside events that cut a session · the TV screen (once from `init`). The TV screen is outside `parts/Presets.panels()`, so it closes here. */
export function bindVideoGame(sys: HousingSystem): Array<() => void> {
  const b = sys.ctx.bus;
  const stop = (): void => { cancelGameSession(sys); sys.tvMenu?.close(false); };
  return [
    b.on('game:newMission', stop),
    b.on('game:abort', stop),
    b.on('hub:left', stop),
    b.on('game:phaseChanged', ({ phase }) => { if (phase !== 'hub') stop(); }),
    // The pose released itself (spawn · reset · standing up with E) — the game screen is never left behind without the seated pose. `caller` = hub released it on our own end
    b.on('player:furniturePoseEnded', ({ kind, reason }) => {
      // 2026-09-17: a standing session (`seatUid` null) holds no pose — another sitting pose being released has nothing to do with it
      if (sys.gameState?.info.seatUid && reason !== 'caller' && kind === 'sit') cancelGameSession(sys);
    }),
    b.on('housing:furnitureRecovered', ({ uid }) => {
      const s = sys.gameState?.info;
      if (s && (uid === s.tvUid || uid === s.seatUid)) cancelGameSession(sys);
      if (sys.tvMenu?.isOpen && sys.tvMenu.uid === uid) sys.tvMenu.close(false);
    }),
    b.on('housing:modeChanged', ({ active }) => { if (active) sys.tvMenu?.close(false); }),
  ];
}

/* ── Smoke hooks ──────────────────────────────────────────────────────────── */
export interface VideoGameDebug {
  /** Which of the gym screen's three screens is up in game mode (null when it is not a game session). */
  readonly screen: 'intro' | 'game' | 'result' | null;
  readonly game: GymGame | null;
  /** The result of the last finished game session (it survives closing the screen). */
  readonly result: GymSessionResult | null;
  start(): boolean;
  finish(score: number): GymSessionResult | null;
  /** A fresh judgement object unrelated to the screen — for checking the tuning. */
  makeGame(kind: GymMinigame, tuning?: GymGameTuning): GymGame;
  /** The seat rule (`Rules.tvSeatFor`) as it is. */
  seatFor(tvUid: string): TvSeatResult;
}

export function videoGameDebug(sys: HousingSystem): VideoGameDebug {
  const inGame = (): boolean => sys.gymScreen?.mode === 'game';
  return {
    get screen() { return inGame() ? sys.gymScreen?.screen ?? null : null; },
    get game() { return inGame() && sys.gymScreen?.screen === 'game' ? sys.gymScreen.game : null; },
    get result() { return sys.gameState?.result ?? sys.gymScreen?.lastGameResult ?? null; },
    start: () => (inGame() ? sys.gymScreen?.start() ?? false : false),
    finish: (score: number) => (inGame() ? sys.gymScreen?.finishWith(score) ?? null : null),
    makeGame: (kind: GymMinigame, tuning?: GymGameTuning) => createGymGame(kind, tuning),
    seatFor: (tvUid: string) => tvSeatFor(sys.state, tvUid),
  };
}

/** A game disc's minigame name — the one spelling every screen prints (TV screen · library catalogue · the item tooltip). Lives in `@/shared` since 2026-09-19 (B-32). */
export function gameMinigameLabel(kind: GymMinigame): string {
  return sharedGameMinigameLabel(kind);
}
