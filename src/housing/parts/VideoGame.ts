/**
 * src/housing/parts/VideoGame.ts — **비디오게임** (2026-09-13, H2 — docs/plans/library-series-games.md §0 · §3).
 *
 * TV 에 게임기를 장착하고(`ShipState.tvConsoles`), 게임 디스크 전시대(`game_stand`, 서재 매체 `game`)에 꽂힌 디스크 중 게임기가 맞는 것을
 * TV 앞 좌석에 앉아 플레이한다. 운동 세션(`parts/Gym`)과 **같은 모양**이다:
 *   ① `gameBlock` — TV 아님 · 함선 아님(레이드 포함) · 남의 함선 · 이미 세션 중 · 다른 화면 · 디스크 · 게임기 · 좌석.
 *      TV 화면(`ui/tv/TvMenu`)이 열려 있는 것은 사유가 아니다 — `startGameSession` 이 그것을 닫고 시작한다.
 *   ② 세션 상태(`sys.gameState`)를 세우고 운동 화면(`ui/gym/GymScreen` 의 게임 모드 — 제목 = 디스크 이름 · 강조색 = 디스크 색 ·
 *      판정 = `createGymGame(minigame, tuning)`)을 연 뒤 `housing:gameSession {active:true}` — hub 가 좌석에 앉히고 TV 를 보는 고정 카메라를 건다.
 *      자세가 거절되면 hub 가 **같은 호출 스택 안에서** `cancelGameSession` 을 부른다.
 *   ③ 끝까지 하면 `completeGameSession` — `ctx.progression.applyGymSession(disc.stat, 점수)` → `housing:gameResult`.
 *      경험치 식 · 24 h 디버프는 헬스와 같다(사용자 결정 「헬스와 동일」) — 규칙은 progression 이 갖는다. 디버프 중에도 플레이는 된다(경험치 0).
 *   ④ 화면이 닫히면 `endGameSession` — `housing:gameSession {active:false, completed}`. 취소는 보상 · 디버프 없음.
 * 시작하면 꺼져 있던 TV 는 켠다(`toggleFurniture`). 좌석 규칙은 `Rules.tvSeatFor` 하나다.
 *
 * 게임기 장착은 **되돌릴 수 있는** 일이라 1초 홀드가 없다. 가방 → 창고 순서로 꺼내고(`consumeDefAll`), 교체 · 빼기는 가방 → 창고로 돌려준다.
 * TV 를 회수하면 게임기는 **함선 창고**로 돌아간다 — 자리가 없으면 회수 자체를 거절한다 (`parts/Furniture.recover`, 서재 보관함과 같은 규약).
 */
import type {
  BookSlotInfo, GameSessionInfo, GymMinigame, GymSessionResult, ItemDef, PlacedFurniture, PlayableGameInfo, TvConsoleSlot,
} from '@/shared';
import type { GymGameTuning } from '@/shared';
import { FURNITURE_DEF_MAP, GAME_STATS, GYM_MINIGAME_LABEL_KO } from '@/shared';
import type { HousingSystem } from '../HousingSystem';
import { tvSeatFor } from '../Rules';
import type { TvSeatResult } from '../Rules';
import { createGymGame } from './GymGames';
import type { GymGame } from './GymGames';

/** 게임 화면의 `ctx.uiBlockers` · ESC · 키 가이드 토큰 — 운동(`housing.gym`)과 따로라 hub · player 가 둘을 가를 수 있다. */
export const GAME_BLOCKER = 'housing.game';
/**
 * TV 화면(`HousingPanel`)이 올리는 블로커 — 하우징 패널 공용 토큰 `'housing'` 이다. `gameBlock` 은 TV 화면이 열려 있을 때만 이 토큰을
 * 「다른 화면」으로 치지 않는다 (다른 하우징 패널은 `sys.isMenuOpen` 이 따로 잡는다).
 */
export const TV_MENU_BLOCKER = 'housing';

/** 게임 방식 이름 (사용자 결정 「벤치프레스형 · 호흡형 · 사이클형」). */
export const GAME_MINIGAME_LABEL_KO: Readonly<Record<GymMinigame, string>> = { press: '벤치프레스형', breath: '호흡형', cycle: '사이클형' };

export interface GameState {
  info: GameSessionInfo;
  /** 디스크 이름 (결과 · 토스트). */
  discName: string;
  /** 게임을 끝까지 했다 (점수를 progression 에 넘겼다). */
  finished: boolean;
  /** `applyGymSession` 의 결과 — progression 이 없거나 거절했으면 null. */
  result: GymSessionResult | null;
  /** 끝낸 점수 (0 … 1). */
  score: number;
}

/* ── 조회 ─────────────────────────────────────────────────────────────────── */

/** 배치된 TV (`interaction 'tv'`), 아니면 null. */
export function tvOf(sys: HousingSystem, uid: string): PlacedFurniture | null {
  const item = sys.getPlacedByUid(uid);
  return item && FURNITURE_DEF_MAP.get(item.defId)?.interaction === 'tv' ? item : null;
}

/** `ShipState.tvConsoles` (없으면 빈 배열을 달아 준다 — 정리는 `ShipState.sanitize` 의 몫). */
export function tvConsoleSlots(sys: HousingSystem): TvConsoleSlot[] {
  if (!Array.isArray(sys.state.tvConsoles)) sys.state.tvConsoles = [];
  return sys.state.tvConsoles;
}

/** 게임기 아이템 def (`ItemDef.gameConsole`), 아니면 null. */
export function consoleDefOf(sys: HousingSystem, defId: string | null | undefined): ItemDef | null {
  if (!defId) return null;
  const def = sys.defOf(defId);
  return def?.gameConsole ? def : null;
}

/** 게임 디스크 아이템 def (`ItemDef.gameDisc`, 능력치가 지능 · 인지력), 아니면 null. */
export function gameDiscDefOf(sys: HousingSystem, defId: string | null | undefined): ItemDef | null {
  if (!defId) return null;
  const def = sys.defOf(defId);
  return def?.gameDisc && GAME_STATS.includes(def.gameDisc.stat) ? def : null;
}

/** 게임기 종류(`GameConsoleDef.console`)의 이름 — 그 종류의 게임기 아이템 이름, 없으면 종류 문자열. */
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

/** 가진 게임기 (가방 + 창고), 이름 순. */
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

/** 함선 게이트 — 레이드 · 함선 밖 · 남의 함선이면 한국어 사유 (`what` = 「게임을 할 수 있습니다」 같은 뒷말). */
function shipGate(sys: HousingSystem, what: string): string | null {
  const ctx = sys.ctx;
  if (ctx.isRaidActive() || !ctx.isHubPhase()) return `함선에서만 ${what}`;
  if (ctx.hub && (ctx.hub.ship !== 'personal' || ctx.hub.visitReadOnly)) return `내 함선에서만 ${what}`;
  return null;
}

/* ── 게임기 장착 ──────────────────────────────────────────────────────────── */

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
  // 새 것을 먼저 꺼낸다 (그 자리가 비어 옛 것이 들어갈 수도 있다) → 옛 것이 가방 · 창고에 안 들어가면 새 것을 되돌린다
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

/** TV 회수를 막는 사유 — 장착된 게임기가 함선 창고에 들어갈 자리가 없으면 (칸 수 추정, `recoverBlock` 용). */
export function tvConsoleRecoverBlock(sys: HousingSystem, uid: string): string | null {
  if (!tvOf(sys, uid)) return null;
  const defId = getTvConsole(sys, uid);
  if (!defId) return null;
  return sys.stashSpaceBlock([{ defId, qty: 1 }]) ? '게임기를 돌려줄 함선 창고 자리가 없습니다 — 게임기를 먼저 빼세요' : null;
}

/**
 * TV 를 회수하기 직전 — 장착된 게임기를 **함선 창고**로 돌려주고 칸을 지운다 (`housing:tvConsoleChanged {defId:null}`). 저장은 회수가 한다.
 * 창고에 안 들어가면 아무것도 바꾸지 않고 한국어 사유 (회수를 거절한다). TV 가 아니거나 게임기가 없으면 null.
 */
export function returnTvConsoleForRecover(sys: HousingSystem, uid: string): string | null {
  if (!tvOf(sys, uid)) return null;
  const defId = getTvConsole(sys, uid);
  if (!defId) return null;
  const inv = sys.ctx.inventory, loot = sys.ctx.loot;
  if (!inv || typeof inv.tryAddToStash !== 'function' || !loot || typeof loot.createItem !== 'function') return '게임기를 돌려줄 수 없습니다';
  if (!inv.tryAddToStash(loot.createItem(defId, 1))) return '게임기를 돌려줄 함선 창고 자리가 없습니다 — 게임기를 먼저 빼세요';
  const slots = tvConsoleSlots(sys);
  slots.splice(slots.findIndex((s) => s.uid === uid), 1);
  sys.ctx.bus.emit('housing:tvConsoleChanged', { uid, defId: null });
  return null;
}

/* ── 좌석 · 게임 목록 ─────────────────────────────────────────────────────── */

export function getTvSeat(sys: HousingSystem, tvUid: string): string | null {
  return tvSeatFor(sys.state, tvUid).seatUid;
}

export function tvSeatBlock(sys: HousingSystem, tvUid: string): string | null {
  return tvSeatFor(sys.state, tvUid).reason;
}

/** 배치된 게임 디스크 전시대 (서재 매체 `game`) — H1 의 보관함 API 가 아직 없으면 빈 배열. */
function gameStands(sys: HousingSystem): PlacedFurniture[] {
  if (typeof sys.getShelfMedium !== 'function') return [];
  return sys.state.furniture.filter((f) => {
    try { return sys.getShelfMedium(f.uid) === 'game'; } catch { return false; }
  });
}

/**
 * 이 TV 로 고를 수 있는 게임 — 함선의 모든 게임 디스크 전시대에 꽂힌 디스크 (같은 디스크가 여러 대에 꽂혀 있으면 한 줄, 작동하는 전시대 우선).
 * `block` = 게임기 없음 · 게임기 불일치 · 전시대가 멈춤. **디버프 · 좌석은 사유가 아니다** (디버프 = 경험치 0 으로 플레이, 좌석 = TV 단위의 `tvSeatBlock`).
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

/* ── 세션 ─────────────────────────────────────────────────────────────────── */

export function gameSession(sys: HousingSystem): GameSessionInfo | null {
  return sys.gameState ? sys.gameState.info : null;
}

/** TV 화면 말고 다른 화면(블로커)이 열려 있는가. */
function otherScreenOpen(sys: HousingSystem): boolean {
  const ctx = sys.ctx;
  // 리드 2026-09-13: TV 화면이 `panels()` 에 들어갔다 — `isMenuOpen` 대신 TV 화면을 뺀 패널만 본다
  if (sys.housingMode || sys.shipManageMode || sys.panels().some((p) => p.isOpen && p !== sys.tvMenu)) return true;
  const tvOpen = !!sys.tvMenu?.isOpen;
  for (const b of ctx.uiBlockers) if (!(tvOpen && b === TV_MENU_BLOCKER)) return true;
  return false;
}

/** 지금 `startGameSession(tvUid, discDefId)` 가 거절할 한국어 사유, null = 시작할 수 있다. */
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
  if (entry.block) return entry.block;
  return tvSeatFor(sys.state, tvUid).reason;
}

export function startGameSession(sys: HousingSystem, tvUid: string, discDefId: string): string | null {
  const reason = gameBlock(sys, tvUid, discDefId);
  if (reason) return reason;
  const def = gameDiscDefOf(sys, discDefId);
  const seatUid = tvSeatFor(sys.state, tvUid).seatUid;
  if (!def?.gameDisc || !seatUid || !sys.gymScreen) return '게임을 시작할 수 없습니다';
  const disc = def.gameDisc;
  if (sys.tvMenu?.isOpen) sys.tvMenu.close(false);             // TV 화면을 닫고 게임 화면으로
  if (!sys.isFurnitureOn(tvUid)) sys.toggleFurniture(tvUid);   // 꺼져 있던 TV 를 켠다
  const info: GameSessionInfo = { tvUid, seatUid, discDefId, stat: disc.stat, minigame: disc.minigame };
  sys.gameState = { info, discName: def.name, finished: false, result: null, score: 0 };
  sys.gymScreen.openGame(info, { title: def.name, color: disc.color, tuning: disc.tuning, consoleName: consoleKindName(sys, disc.console) });
  sys.ctx.bus.emit('housing:gameSession', { ...info, active: true, completed: false });
  // hub 가 좌석 자세를 걸지 못하면 같은 호출 스택 안에서 `cancelGameSession` 이 온다 — 그때는 시작하지 못한 것이다
  return sys.gameState ? null : '게임을 시작할 수 없습니다';
}

/** 진행 중인 세션을 끝낸다 — 결과 화면이 아니었다면 보상 · 디버프 없음. 없으면 no-op. */
export function cancelGameSession(sys: HousingSystem): void {
  if (!sys.gameState) return;
  if (sys.gymScreen?.isOpen && sys.gymScreen.mode === 'game') sys.gymScreen.close();   // 화면이 `endGameSession` 을 부른다
  else endGameSession(sys);
}

/** 게임을 끝까지 했다 — 점수를 progression 에 넘기고 `housing:gameResult`. 한 세션에 한 번만 반영된다. */
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

/** 화면이 닫혔다 — 세션을 비우고 `housing:gameSession {active:false}`. */
export function endGameSession(sys: HousingSystem): void {
  const st = sys.gameState;
  if (!st) return;
  sys.gameState = null;
  sys.ctx.bus.emit('housing:gameSession', { ...st.info, active: false, completed: st.finished });
}

/* ── TV 화면 ──────────────────────────────────────────────────────────────── */

/** TV 화면을 연다 (hub 의 TV E). 내 함선이 아니거나 세션 중이면 토스트로 끝난다. */
export function openTvMenu(sys: HousingSystem, tvUid: string): void {
  if (!tvOf(sys, tvUid)) { sys.notify('TV 가 아닙니다', 'warning'); return; }
  const gate = shipGate(sys, 'TV 를 쓸 수 있습니다');
  if (gate) { sys.notify(gate, 'warning'); return; }
  if (sys.gameState || sys.gymState) return;
  sys.closeMenus(false);
  sys.tvMenu?.openTv(tvUid);
}

/** 세션 · TV 화면을 끊는 바깥 사건들 (`init` 에서 한 번). TV 화면은 `parts/Presets.panels()` 밖이라 여기서 닫는다. */
export function bindVideoGame(sys: HousingSystem): Array<() => void> {
  const b = sys.ctx.bus;
  const stop = (): void => { cancelGameSession(sys); sys.tvMenu?.close(false); };
  return [
    b.on('game:newMission', stop),
    b.on('game:abort', stop),
    b.on('hub:left', stop),
    b.on('game:phaseChanged', ({ phase }) => { if (phase !== 'hub') stop(); }),
    // 자세가 스스로 풀렸다(스폰 · 리셋 · E 로 일어남) — 앉은 자세가 아닌데 게임 화면만 남기지 않는다. `caller` = hub 가 우리 끝을 받아 푼 것
    b.on('player:furniturePoseEnded', ({ kind, reason }) => {
      if (sys.gameState && reason !== 'caller' && kind === 'sit') cancelGameSession(sys);
    }),
    b.on('housing:furnitureRecovered', ({ uid }) => {
      const s = sys.gameState?.info;
      if (s && (uid === s.tvUid || uid === s.seatUid)) cancelGameSession(sys);
      if (sys.tvMenu?.isOpen && sys.tvMenu.uid === uid) sys.tvMenu.close(false);
    }),
    b.on('housing:modeChanged', ({ active }) => { if (active) sys.tvMenu?.close(false); }),
  ];
}

/* ── 스모크 훅 ────────────────────────────────────────────────────────────── */
export interface VideoGameDebug {
  /** 게임 모드인 운동 화면의 단계 (게임 세션이 아니면 null). */
  readonly screen: 'intro' | 'game' | 'result' | null;
  readonly game: GymGame | null;
  /** 마지막으로 끝낸 게임 세션의 결과 (화면을 닫은 뒤에도 남는다). */
  readonly result: GymSessionResult | null;
  start(): boolean;
  finish(score: number): GymSessionResult | null;
  /** 화면과 무관한 새 판정 객체 — 튜닝 검사. */
  makeGame(kind: GymMinigame, tuning?: GymGameTuning): GymGame;
  /** 좌석 규칙 (`Rules.tvSeatFor`) 그대로. */
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

/** 게임 방식 · 헬스 방식 이름을 함께 보여 줄 때 (TV 화면). */
export function gameMinigameLabel(kind: GymMinigame): string {
  return GAME_MINIGAME_LABEL_KO[kind] ?? GYM_MINIGAME_LABEL_KO[kind] ?? kind;
}
