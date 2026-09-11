/**
 * src/game/parts/Wire.ts — **`flow` 메시지**와 호스트 이관 · 로비 이탈의 흐름 처리.
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
import { ResumeGate, installDesktopRelockHook, syncDesktopCursor } from '../ResumeGate';
import { clearSoloRaid, loadSoloRaid, saveSoloRaid, soloRaidStatus, type SoloRaidSave } from '../SoloRaid';
import { ALL_DEAD_CHECK_INTERVAL, DEATH_TO_SCREEN, DISCONNECT_ABORT_DELAY, LIFTOFF_TO_COMPLETE, MISSION_FAILS_WHEN_ALL_DEAD, THREAT_MAX, THREAT_MIN, THREAT_RAMP_SECONDS, XP_DEATH_MUL, XP_EXTRACT_BONUS, XP_PER_KILL, XP_PER_LOOT_VALUE, XP_PER_MINUTE, XP_TIME_CAP } from '../model';
import type { GameFlowSystem } from '../GameFlowSystem';

/* ── Multiplayer helpers ─────────────────────────────────────────────── */
/** Subscribe to host `flow` messages once `ctx.net` exists (NetSystem publishes it before this system inits, but stay lazy). */
export function ensureNetHooks(sys: GameFlowSystem): void {
  const net = sys.ctx.net;
  if (!net || sys.netUnsub) return;
  sys.netUnsub = net.onMessage('flow', (msg, from) => sys.onFlowMessage(msg, from));
  }

/** Clients only: mirror the host's mission-level decisions. */
export function onFlowMessage(sys: GameFlowSystem, msg: FlowMessage, from: PeerId): void {
  const ctx = sys.ctx;
  const net = ctx.net;
  if (!net || !ctx.isMultiplayer || net.isHost) return;
  const hostId = net.lobby?.hostId;
  if (hostId && from !== hostId) return;
  switch (msg.ev) {
    case 'over':
      // the host decided the squad is wiped → 레이드 실패 for everyone
      if (sys.inLiveMission()) sys.gameOver();
      break;
    case 'complete':
      if (sys.inLiveMission()) sys.complete();
      break;
    case 'abort':
      // host aborted the mission → the whole squad regroups in the shared ship (onAbort schedules hub:enter)
      if (sys.inMission()) ctx.bus.emit('game:abort', {});
      break;
    case 'phase':
    case 'rejoined':
    case 'takeover':
      // `takeover` is translated into `net:hostChanged {isLocalHost:false}` by NetSystem; phases are derived locally.
      break;
  }
  }

/** Phase 7: authority moved (host migration). The new host takes the wipe check over; the old one just mirrors. */
export function onHostChanged(sys: GameFlowSystem, isLocalHost: boolean): void {
  if (!sys.inLiveMission()) return;
  if (!isLocalHost) { sys.allDeadCheckTimer = -1; return; }
  sys.wasMultiplayerHost = true;
  if (sys.isLocalOut() || (sys.ctx.player?.isDowned ?? false)) sys.allDeadCheckTimer = ALL_DEAD_CHECK_INTERVAL;
  sys.checkAllDead();
  }

/**
 * The party is gone (server gave up on us / host left / kicked) mid-mission → abort after a short toast and
 * return to the personal ship. A plain socket drop is `net:reconnecting` (handled above) and never aborts.
 */
export function onLobbyLeft(sys: GameFlowSystem, reason: 'left' | 'disconnected' | 'kicked' | 'hostLeft' | 'moved'): void {
  const ctx = sys.ctx;
  /* we chose to leave (abort / menu) — nothing to do. `moved` (2026-09-11, B-6) is a server move between ships, never mid-mission. */
  if (reason === 'left' || reason === 'moved') return;
  if (!sys.inLiveMission()) return;
  if (sys.disconnectAbortTimer >= 0) return;
  const text = reason === 'hostLeft' ? '호스트가 나갔습니다 — 함선으로 복귀' : reason === 'kicked' ? '분대에서 분리되었습니다' : '연결이 끊어졌습니다 — 함선으로 복귀';
  ctx.bus.emit('ui:notify', { text, kind: 'danger', duration: DISCONNECT_ABORT_DELAY });
  sys.disconnectAbortTimer = DISCONNECT_ABORT_DELAY;
  }
