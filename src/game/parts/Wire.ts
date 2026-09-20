/**
 * src/game/parts/Wire.ts — the **`flow` messages**, plus host transfer and the party going away.
 */
import type { FlowMessage, PeerId } from '@/shared';
import { ALL_DEAD_CHECK_INTERVAL, DISCONNECT_ABORT_DELAY } from '../model';
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
      // the host decided the squad is wiped → a raid failure for everyone
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
  /*
   * C-59 (2026-09-11): `kicked` splits two ways — the server console's `kick` (an operator kick) and the same
   * character in another window (`duplicate`). `net` sets `ctx.net.link.refused` **before** `net:lobbyLeft`, so
   * that is what tells them apart. `server_full` arrives as `'disconnected'`.
   */
  const refused = ctx.net?.link.state === 'refused' ? ctx.net.link.refused : undefined;
  const text = reason === 'hostLeft' ? '호스트가 나갔습니다 — 함선으로 복귀'
    : reason === 'kicked'
      ? (refused === 'duplicate' ? '다른 창에서 같은 캐릭터로 접속했습니다 — 함선으로 복귀' : '서버에서 추방되었습니다 — 함선으로 복귀')
      : refused === 'server_full' ? '서버 접속 인원이 가득 찼습니다 — 함선으로 복귀' : '연결이 끊어졌습니다 — 함선으로 복귀';
  ctx.bus.emit('ui:notify', { text, kind: 'danger', duration: DISCONNECT_ABORT_DELAY });
  sys.disconnectAbortTimer = DISCONNECT_ABORT_DELAY;
  }
