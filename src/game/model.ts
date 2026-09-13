/**
 * src/game/model.ts — 게임 흐름 폴더의 공용 어휘.
 *
 * `GameFlowSystem` 에서 떼어낸 상수 · 타입(그리고 상태 없는 보조 클래스)만 있다. 클래스를 참조하지 않으므로
 * `parts/*` 모듈이 `GameFlowSystem.ts` 를 되돌아 import 하지 않고 쓸 수 있다(순환 import 방지).
 * `GameFlowSystem.ts` 가 `export *` 로 재수출하므로 기존 import 경로는 전부 유지된다.
 */
import * as THREE from 'three';
import type {
  GameContext, GameSystem, GamePhase, FlowMessage, PeerId, MissionMode, RaidSessionBlob, PlayerRestoreState, RemotePlayerRef,
} from '@/shared';
import type { PlanetId } from '@/shared';
import {
  GameContext as Ctx, Keys, PlayerFlags, PLAYER_RESPAWN_DELAY, RAID_FAILED_AUTO_RETURN_S, RAID_SAVE_INTERVAL_S,
  NET_GHOST_RESTORE_TIMEOUT_S,
} from '@/shared';
import { FREE_CURSOR_BLOCKER } from '@/shared';
import { RESUME_GATE_BLOCKER } from '@/shared';
import { EXTRACTION_LIFTOFF_TO_COMPLETE_S } from '@/shared';
import { ResumeGate, installDesktopRelockHook, syncDesktopCursor } from './ResumeGate';
import { clearSoloRaid, loadSoloRaid, saveSoloRaid, soloRaidStatus, type SoloRaidSave } from './SoloRaid';
/* appended (Phase 11): 목표 행성 */
/* appended (2026-09-07, 커서 rework): Alt 커서 blocker token */
/* appended (Phase 12): 브라우저 재개 게이트 + 데스크톱 셸 커서 */
/* appended (2026-09-07): 솔로 레이드 로컬 세션 저장 — the single-player counterpart of the relay's raid store */

/**
 * Seconds after `extraction:liftoff` (for someone who left aboard, or everyone when the squad is done) until the result
 * screen. 2026-09-13: 6.5 → the csv value (10) — the departure cinematic plays inside it (`EXTRACTION_LIFTOFF_TO_COMPLETE_S`).
 */
export const LIFTOFF_TO_COMPLETE = EXTRACTION_LIFTOFF_TO_COMPLETE_S;
export const DEATH_TO_SCREEN = 2.5;       // seconds after player:died (single-player only)
/**
 * Phase 7: a squad wipe (or a solo death) fails the raid again. Individual respawns (PLAYER_RESPAWN_DELAY) stay
 * available in a squad until nobody is left alive / downed / alive-as-a-ghost.
 */
export const MISSION_FAILS_WHEN_ALL_DEAD = true;
export const THREAT_MIN = 0.3;
export const THREAT_MAX = 0.7;
export const THREAT_RAMP_SECONDS = 8 * 60;
/** Multiplayer host: how often the "is everyone dead?" check re-runs while the local player is dead. */
export const ALL_DEAD_CHECK_INTERVAL = 0.5;
/** Multiplayer: seconds between the connection-lost toast and the automatic abort to the menu. */
export const DISCONNECT_ABORT_DELAY = 2;

/* ── mission-end character XP (progression) ─────────────────────────────────
 * Kept here (not in progression/) because GameFlow owns the mission result. Progression only
 * banks the number through `ctx.progression.addXp`.
 */
export const XP_PER_KILL = 12;
/** Loot is only banked when the player actually got out with it. */
export const XP_PER_LOOT_VALUE = 0.08;
/** Flat bonus for a successful extraction. */
export const XP_EXTRACT_BONUS = 300;
/** Per minute survived, capped at XP_TIME_CAP. */
export const XP_PER_MINUTE = 20;
export const XP_TIME_CAP = 300;
/** A wiped squad still learns something: kills count at this fraction. */
export const XP_DEATH_MUL = 0.4;

/**
 * Mission phase state machine + stats + pause + difficulty ramp.
 * menu → deploying → playing → extracting → shipLanded → liftoff → complete | dead
 *
 * Multiplayer (all gated on `ctx.isMultiplayer`; single-player behaviour is unchanged):
 *   - Pause only shows the menu (`game:paused {freeze:false}`) — the world keeps running.
 *   - A dead player does not change phase; the host ends the raid (`flow over`) once *everyone* is out.
 *   - `flow` messages from the host mirror over / complete / abort on the clients.
 *   - `stats.extracted` = boarded && alive at completion (left-behind / dead players get `false`).
 *
 * Ship hub (phases 'hub' / 'docking' are owned by hub/HubSystem and are NOT gameplay):
 *   - Phase 8: Escape in 'hub' with no blocker opens the **pause menu** (`game:paused {freeze:false}`) — the ship keeps
 *     animating and no mission side effect (abort / stats / timers) is produced. 'docking' (the cutscene) never pauses.
 *   - `hub:enter` while a mission / result phase is active → HubSystem emits `game:abort` first (we go to 'menu'),
 *     then it builds the ship and sets 'hub'. A mission may start from 'hub' (`game:newMission` from the launch pod,
 *     `ctx.net.startGame` or `ctx.net.rejoinMission`).
 *   - After an abort that ends a *lobby* mission (host `flow abort`, 로비로, 임무 포기) we emit `hub:enter shared` one
 *     microtask later so the squad regroups in the shared ship. Solo aborts keep the legacy title-menu behaviour.
 *   - Reconnection: `net:reconnecting` never aborts (toast only); `net:resumed {seamless:false}` aborts → shared ship;
 *     `net:lobbyLeft` (party gone) aborts after 2 s → personal ship.
 *
 * Phase 7 (known follow-ups):
 *   - Squad wipe = raid failure (`game:raidFailed` + `game:over`, auto return to the ship after RAID_FAILED_AUTO_RETURN_S).
 *   - Raid session blob (`ctx.net.saveRaid`) every RAID_SAVE_INTERVAL_S / on loot; rejoin restores it + the host's ghost.
 *   - 시뮬레이션 훈련장 (`ctx.missionMode === 'training'`): no XP / settlement / threat, death = instant respawn,
 *     `training:exitRequested` → abort + inventory snapshot restored + back to the ship.
 *   - Host takeover (`net:hostChanged {isLocalHost:true}`): the new host runs the wipe check and sends `flow`.
 */

