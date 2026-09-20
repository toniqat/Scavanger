/**
 * src/game/model.ts — the mission-flow folder's shared vocabulary.
 *
 * Holds only the constants · types (and the stateless helper classes) split out of `GameFlowSystem`. It
 * references no class, so a `parts/*` module can use it without importing `GameFlowSystem.ts` back (no import
 * cycle). `GameFlowSystem.ts` re-exports it with `export *`, so every existing import path still works.
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
/* appended (Phase 11): the target planet */
/* appended (2026-09-07, cursor rework): the Alt cursor's blocker token */
/* appended (Phase 12): the browser resume gate + the desktop-shell cursor */
/* appended (2026-09-07): the solo raid's local session save — the single-player counterpart of the raid store */

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
 * 2026-09-16: no numbers here any more. Raid XP = Σ per-kill `raidXp` (`data/enemies.csv`, summed into
 * `ctx.stats.killXp` by enemies/) × (extracted ? 1 : `XP_DEATH_MUL` from `data/constants.csv`) × library multiplier —
 * `parts/Death.awardMissionXp`. The old per-kill flat value, loot-value, extraction and survival-time terms are gone.
 */

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
 *   - After an abort that ends a *lobby* mission (host `flow abort`, `로비로`, `임무 포기`) we emit
 *     `hub:enter shared` one
 *     microtask later so the squad regroups in the shared ship. Solo aborts keep the legacy title-menu behaviour.
 *   - Reconnection: `net:reconnecting` never aborts (toast only); `net:resumed {seamless:false}` aborts → shared ship;
 *     `net:lobbyLeft` (party gone) aborts after 2 s → personal ship.
 *
 * Phase 7 (known follow-ups):
 *   - Squad wipe = raid failure (`game:raidFailed` + `game:over`, auto return to the ship after RAID_FAILED_AUTO_RETURN_S).
 *   - Raid session blob (`ctx.net.saveRaid`) every RAID_SAVE_INTERVAL_S / on loot; rejoin restores it + the host's ghost.
 *   - `시뮬레이션 훈련장` (`ctx.missionMode === 'training'`): no XP / settlement / threat, death = instant respawn,
 *     `training:exitRequested` → abort + inventory snapshot restored + back to the ship.
 *   - Host takeover (`net:hostChanged {isLocalHost:true}`): the new host runs the wipe check and sends `flow`.
 */

