/**
 * src/housing/parts/Gym.ts — **헬스장 운동 세션** (A-3a, 2026-09-12).
 *
 * 운동 기구(벤치 랙 · 스미스 머신 · 트레드밀 · 사이클)에서 E → hub 가 `startGymSession(uid)` 을 부른다. 여기서 하는 일:
 *   ① `gymBlock` — 운동 기구가 아니다 · 함선이 아니다(레이드 포함) · 남의 함선 · 이미 세션 중 · 다른 화면이 열려 있다.
 *   ② 세션 상태(`sys.gymState`)를 세우고 미니게임 화면(`ui/gym/GymScreen`)을 연 뒤 `housing:gymSession {active:true}` —
 *      hub 가 그것을 보고 원반 · 자세 · 고정 카메라를 건다 (자세가 거절되면 hub 가 `cancelGymSession` 을 부른다).
 *   ③ 게임이 끝나면 `completeGymSession` — 점수를 `ctx.progression.applyGymSession` 에 넘기고 `housing:gymResult`.
 *      progression 이 그 메서드를 아직 갖고 있지 않으면 결과 화면이 「반영하지 못했다」고 말한다 (조용히 성공한 척하지 않는다).
 *   ④ 화면이 닫히면 `endGymSession` — `housing:gymSession {active:false, completed}`. `completed` 는 **게임을 끝까지 했다**
 *      (그래서 점수가 넘어갔다) 는 뜻이고 취소(Esc · Tab · 페이즈 변경)면 false 다. 취소는 보상도 디버프도 없다.
 *
 * 규칙(단련 경험치 · 디버프)은 하나도 여기 없다 — progression 의 몫이다. housing 은 판정(`parts/GymGames`)과 흐름만 갖는다.
 */
import type {
  FurnitureDef, FurniturePoseKind, GymEquipmentDef, GymMinigame, GymSessionInfo, GymSessionResult, PlacedFurniture,
} from '@/shared';
import { gymEquipmentOf } from '@/shared';
import type { HousingSystem } from '../HousingSystem';
import { createGymGame } from './GymGames';
import type { GymGame } from './GymGames';

/** 운동 화면의 `ctx.uiBlockers` 토큰 — 패널들의 `'housing'` 과 따로라, 다른 패널이 닫히며 지워 가지 않는다. */
export const GYM_BLOCKER = 'housing.gym';

export interface GymState {
  info: GymSessionInfo;
  /** 이 기구가 쓰는 자세 — `player:furniturePoseEnded` 가 이 세션의 자세인지 가리는 데 쓴다. */
  pose: FurniturePoseKind;
  /** 게임을 끝까지 했다 (점수를 progression 에 넘겼다). */
  finished: boolean;
  /** `applyGymSession` 의 결과 — progression 이 없거나 거절했으면 null. */
  result: GymSessionResult | null;
  /** 끝낸 점수 (0 … 1). */
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

/** 지금 `startGymSession(uid)` 가 거절할 한국어 사유, null = 시작할 수 있다. */
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
  // hub 가 자세를 걸지 못하면 같은 호출 스택 안에서 `cancelGymSession` 이 온다 — 그때는 시작하지 못한 것이다
  return sys.gymState ? null : '운동을 시작할 수 없습니다';
}

/** 진행 중인 세션을 끝낸다 — 결과 화면이 아니었다면 보상 · 디버프 없음. 없으면 no-op. */
export function cancelGymSession(sys: HousingSystem): void {
  if (!sys.gymState) return;
  if (sys.gymScreen?.isOpen) sys.gymScreen.close();     // 화면이 `endGymSession` 을 부른다
  else endGymSession(sys);
}

/**
 * 게임을 끝까지 했다 — 점수를 progression 에 넘기고 `housing:gymResult` 를 낸다. 한 세션에 한 번만 반영된다.
 * progression 에 `applyGymSession` 이 없거나 null(레이드 등)이면 결과는 null 이다.
 */
export function completeGymSession(sys: HousingSystem, score: number): GymSessionResult | null {
  const st = sys.gymState;
  if (!st) return null;
  if (st.finished) return st.result;
  st.finished = true;
  st.score = Math.max(0, Math.min(1, Number.isFinite(score) ? score : 0));
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

/** 화면이 닫혔다 — 세션을 비우고 `housing:gymSession {active:false}`. */
export function endGymSession(sys: HousingSystem): void {
  const st = sys.gymState;
  if (!st) return;
  sys.gymState = null;
  const { uid, stat, minigame } = st.info;
  sys.ctx.bus.emit('housing:gymSession', { uid, active: false, stat, minigame, completed: st.finished });
}

/** 세션을 끊는 바깥 사건들 — 다른 패널이 닫히는 경로(`closeMenus`)와 같은 자리. `init` 에서 한 번. */
export function bindGym(sys: HousingSystem): Array<() => void> {
  const b = sys.ctx.bus;
  const stop = (): void => cancelGymSession(sys);
  return [
    b.on('game:newMission', stop),
    b.on('game:abort', stop),
    b.on('hub:left', stop),
    b.on('game:phaseChanged', ({ phase }) => { if (phase !== 'hub') stop(); }),
    // 자세가 스스로 풀렸다(스폰 · 리셋) — 운동 자세가 아닌데 운동 화면만 남기지 않는다. `caller` 는 hub 가 우리 끝을 받아 푼 것이다.
    b.on('player:furniturePoseEnded', ({ kind, reason }) => {
      if (sys.gymState && reason !== 'caller' && kind === sys.gymState.pose) stop();
    }),
  ];
}

/* ── 스모크 훅 ────────────────────────────────────────────────────────────── */
export interface GymDebug {
  readonly screen: 'intro' | 'game' | 'result' | null;
  /** 지금 화면이 몰고 있는 판정 객체 (게임 화면이 아니면 null). */
  readonly game: GymGame | null;
  /** 마지막으로 끝낸 세션의 결과 (화면을 닫은 뒤에도 남는다). */
  readonly result: GymSessionResult | null;
  /** 시작 안내 → 게임 (Space 와 같다). */
  start(): boolean;
  /** 게임을 건너뛰고 `score` 로 끝낸다 → 결과 화면. */
  finish(score: number): GymSessionResult | null;
  /** 화면과 무관한 새 판정 객체 — 판정 규칙만 따로 검사한다. */
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
