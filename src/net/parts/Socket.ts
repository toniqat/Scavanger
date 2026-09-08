/**
 * src/net/parts/Socket.ts — **연결 · 세션 토큰 · 자동 재접속**.
 *
 * 소켓이 끊기면 백오프로 다시 붙고, 같은 토큰이면 서버가 슬롯을 5분(레이드 중이면 레이드가 끝날 때까지)
 * 지켜 준다 → `net:reconnecting` → `net:resumed {seamless}`. 릴레이 주소 결정도 여기다.
 */
import * as THREE from 'three';
import type {
  ChatKind, GameContext, GameSystem, GameMessage, GameMessageOf, GameMessageType, GhostWire, LobbyPlayer, LobbyState,
  NetRef, NetStatus, PeerId, PingKind, RelayTarget, RemotePlayerRef, ServerToClient, Vec3Tuple,
} from '@/shared';
import type { ClientToServer, MissionMode, ProfileRef, RaidSessionBlob } from '@/shared';
import type { PlanetId, SocialRef } from '@/shared';
import { isPlanetId } from '@/shared';
import {
  NET_INVITE_PARAM, NET_MISSION_RESUME_TIMEOUT_MS, NET_NAME_PARAM, NET_PLAYER_SNAPSHOT_HZ, NET_RECONNECT_BACKOFF_MS,
  NET_TOKEN_LENGTH, NET_TOKEN_PARAM, NET_TOKEN_STORAGE_KEY, NET_WS_PATH, PlayerFlags, RAID_BLOB_MAX_BYTES,
  isValidLobbyCode, normalizeLobbyCode, sanitizePlayerName,
} from '@/shared';
import { NetClient } from '../NetClient';
import { ProfileSync } from '../ProfileSync';
import { SocialSync } from '../SocialSync';
import { RemotePlayer } from '../RemotePlayer';
import { Snapshotter } from '../Snapshotter';
import type { CrewCardWire, ImplantId } from '@/shared';
import { IMPLANT_IDS } from '@/shared';
import { CHAT_KINDS, type Handler, IMPLANT_ID_SET, MAX_LOBBYLESS_ATTEMPTS, NAME_STORAGE_KEY, PEER_LINGER, PING_KINDS, SNAPSHOT_INTERVAL, TOKEN_ALPHABET, TOKEN_RE, defIdOrNull, isGhostWire, isNum, isVec3, loadOrCreateSessionToken, sameCard, sanitizeCrewCard, vec } from '../model';
import type { NetSystem } from '../NetSystem';

/* ── Phase 8 ── */
/**
 * Relay wall clock in epoch ms: the offset captured at the last `welcome` / `pong` plus the elapsed local time.
 * `performance.now()` is monotonic, so moving the system clock cannot advance a crop timer. Phase 9: the last
 * offset is **kept through a disconnect** (profile stamps written offline stay on the server's clock); only a
 * session that never saw a welcome falls back to `Date.now()` (single-player keeps working on the local clock).
 */
export function serverNow(sys: NetSystem): number {
  const c = sys.client;
  if (c.connected && c.hasServerTime) sys.serverOffset = c.serverTimeOffset;
  if (sys.serverOffset === null) return Date.now();
  const t = performance.now() + sys.serverOffset;
  return Number.isFinite(t) ? t : Date.now();
  }

/* ── connection ─────────────────────────────────────────────────────── */
export function connect(sys: NetSystem, url?: string): Promise<void> {
  if (sys.client.connected) return Promise.resolve();
  sys.intentionalClose = false;
  sys.duplicateKicked = false;
  // An explicit connect while the backoff timer is pending: attempt right now instead.
  if (sys.reconnectTimer !== null) { clearTimeout(sys.reconnectTimer); sys.reconnectTimer = null; }
  const p = sys.client.connect(sys.withSession(url ?? sys.defaultUrl()));
  // Keep the reconnect loop alive if this manual attempt fails (attemptReconnect's own catch may already have rescheduled).
  if (sys._reconnecting) p.catch(() => { if (sys._reconnecting && sys.reconnectTimer === null) sys.scheduleReconnect(); });
  return p;
  }

export async function ensureConnected(sys: NetSystem): Promise<boolean> {
  if (sys.client.connected) return true;
  try { await sys.connect(); return true; } catch { return false; }
  }

export function disconnect(sys: NetSystem): void {
  sys.stopReconnect();
  sys.intentionalClose = true;
  sys.profileSync.flush();
  if (sys._lobby || sys._inSession) sys.dropLobby('left');
  sys.lastLocalId = null;
  sys.client.close();
  }

export function defaultUrl(sys: NetSystem): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const fromEnv = env?.VITE_WS_URL;
  if (fromEnv) return fromEnv;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}${NET_WS_PATH}`;
  }

/** Append `?t=<token>&n=<name>` (NET_TOKEN_PARAM / NET_NAME_PARAM) to a relay URL. */
export function withSession(sys: NetSystem, url: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}${NET_TOKEN_PARAM}=${encodeURIComponent(sys._sessionToken)}&${NET_NAME_PARAM}=${encodeURIComponent(sys._playerName)}`;
  }

/* ── reconnect ──────────────────────────────────────────────────────── */
/** Socket went offline/error. `wasConnected` = an established (welcomed) connection dropped, not a failed attempt. */
export function onSocketDown(sys: NetSystem, wasConnected: boolean): void {
  if (sys.intentionalClose) return;
  if (sys.duplicateKicked) {
    // Another tab took over this session: hand the lobby over to it and stay offline.
    sys.stopReconnect();
    if (sys._lobby || sys._inSession) sys.dropLobby('kicked');
    return;
  }
  if (sys._reconnecting) return;           // a retry failed; attemptReconnect() schedules the next one
  if (!wasConnected) return;                // an initial connect() failed → the caller decides (offline hub)
  sys.beginReconnect();
  }

export function beginReconnect(sys: NetSystem): void {
  sys._reconnecting = true;
  sys.reconnectAttempt = 0;
  sys.reconnectStartedAt = performance.now();
  sys.lobbySuspended = sys._lobby !== null;
  sys.wasInSessionAtDrop = sys._inSession;
  // Remotes stay (seamless resume keeps them; they go `stale` meanwhile and refresh with the next snapshots).
  sys.scheduleReconnect();
  }

export function scheduleReconnect(sys: NetSystem): void {
  if (!sys._reconnecting) return;
  const attempt = ++sys.reconnectAttempt;
  const elapsed = performance.now() - sys.reconnectStartedAt;
  if (sys.lobbySuspended && elapsed >= NET_MISSION_RESUME_TIMEOUT_MS) {
    // Waited long enough for the party: give the lobby up locally. If the server still has our slot when we do
    // get back, `welcome.lobby` re-enters it via `net:resumed` (fresh-load semantics).
    sys.lobbySuspended = false;
    sys.dropLobby('disconnected');
  }
  if (!sys.lobbySuspended && attempt > MAX_LOBBYLESS_ATTEMPTS) {
    sys.stopReconnect();
    return;
  }
  const delay = NET_RECONNECT_BACKOFF_MS[Math.min(attempt - 1, NET_RECONNECT_BACKOFF_MS.length - 1)];
  sys.ctx.bus.emit('net:reconnecting', { attempt, nextInMs: delay });
  sys.reconnectTimer = setTimeout(() => { sys.reconnectTimer = null; void sys.attemptReconnect(); }, delay);
  }

export async function attemptReconnect(sys: NetSystem): Promise<void> {
  if (!sys._reconnecting) return;
  try {
    await sys.client.connect(sys.withSession(sys.defaultUrl()));
    // Success path continues in handleServerMessage('welcome').
  } catch {
    if (sys._reconnecting) sys.scheduleReconnect();
  }
  }

export function stopReconnect(sys: NetSystem): void {
  if (sys.reconnectTimer !== null) { clearTimeout(sys.reconnectTimer); sys.reconnectTimer = null; }
  sys._reconnecting = false;
  sys.reconnectAttempt = 0;
  }

/** `welcome` arrived (first connect, reconnect or fresh page load). */
export function onWelcome(sys: NetSystem, msg: Extract<ServerToClient, { t: 'welcome' }>): void {
  const bus = sys.ctx.bus;
  const resumedAfterDrop = sys._reconnecting;
  sys.stopReconnect();
  sys.lastLocalId = msg.id;
  if (sys.client.hasServerTime) sys.serverOffset = sys.client.serverTimeOffset;
  const lobby = msg.lobby ?? null;

  // Seamless: we were inside the mission this lobby is still running → keep inSession + remotes, nothing rebuilt.
  const seamless = lobby !== null && resumedAfterDrop && sys.wasInSessionAtDrop && sys._inSession
    && lobby.started && sys.missionSeed !== null && lobby.seed === sys.missionSeed;

  // Profile first: persisting folders replace their local state from it before any lobby / mission event. During a
  // seamless resume the documents cannot have changed (only this client writes them) — refresh availability only.
  sys.profileSync.onWelcome(msg.profile, !seamless);
  // Phase 11: the social snapshot belongs to the connection, not the session — refresh it on every welcome, then
  // (re-)publish my level, which the relay forgets when nothing reported it yet.
  sys.socialSync.onWelcome(msg.social);
  sys.pushLevel();

  if (lobby) {
    if (!seamless) {
      sys._inSession = false;
      sys._tookOver = false;
      sys.clearRemotes();
      sys.snapshotter.reset();
      sys._raidBlob = msg.raid ?? null;
    } else {
      // Peers may have restarted their snapshot streams while we were away.
      for (const r of sys.remoteList) r.resetStream();
    }
    sys.lobbySuspended = false;
    sys.applyLobby(lobby);
    sys.lastSnapshotAt = -Infinity;
    // Phase 9: coming back into a running mission WITHOUT our session state (page reload, or a drop we gave up on)
    // means we left it — tell the server so the host parks our ghost and the authority never waits on us. A pod /
    // the terminal re-enters with `rejoinMission()` (which flips `inMission` back).
    if (lobby.started && !seamless && !sys._inSession) {
      const me = sys.getLobbyPlayer(msg.id);
      if (me && me.inMission) {
        me.inMission = false; // optimistic mirror; the broadcast confirms it
        sys.client.send({ t: 'lobby:mission', inMission: false });
      }
    }
    bus.emit('net:resumed', { lobby, inProgress: lobby.started && !sys._inSession, seamless });
    if (!seamless && sys._raidBlob) bus.emit('net:raidLoaded', { blob: sys._raidBlob });
    // Back inside the running mission: the host may hold our body as a ghost — ask for it back (`ghost restore`)
    // and let every system re-sync us. A host that kept its role through the blip has nothing to ask for.
    if (seamless && !sys.isHost) sys.send({ t: 'flow', ev: 'rejoined' }, 'all');
  } else if (sys._lobby || sys._inSession) {
    // We kept a suspended lobby but the server no longer knows us (grace expired / server restarted).
    sys.lobbySuspended = false;
    sys.dropLobby('disconnected');
  }
  sys.wasInSessionAtDrop = false;
  }
