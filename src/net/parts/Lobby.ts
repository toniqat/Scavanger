/**
 * src/net/parts/Lobby.ts — **로비 · 세션 · 호스트 이관**.
 *
 * 방 만들기 / 참가 / 신호 찾기 / 준비 / 시작 / 나가기, 목표 행성 지정, 그리고 임무의 시작과 끝.
 * 임무가 끝나도 **로비는 유지된다** — 로비를 떠나는 것은 `leaveLobby()`(도킹 해제) 하나뿐이다.
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

/**
 * Host only, while not started: share the 목표 행성 with the ship. Mirrored optimistically (like `setLobbySeed`) so
 * the host's own terminal reacts without a round trip; the server's `lobby:state` confirms it for everyone else.
 * There is no travel message — each client starts the cutscene off its own copy of `lobby.planet`.
 */
export function setLobbyPlanet(sys: NetSystem, planet: PlanetId): void {
  if (!isPlanetId(planet)) return;
  const lobby = sys._lobby;
  if (!lobby || !sys.isHost || lobby.started) return;
  if (lobby.planet === planet) return;
  lobby.planet = planet;   // optimistic mirror; the broadcast confirms it
  // No event: hub/ drives its own terminal / cutscene from `setPlanet` and reacts to a *squadmate's* change through
  // the server's `net:lobbyUpdated`. Emitting here would make the host's own pick look like a remote one.
  sys.client.send({ t: 'lobby:planet', planet });
  }

/* ── lobby ops ──────────────────────────────────────────────────────── */
export function createLobby(sys: NetSystem): void { sys.pendingQuickMatch = false; sys.client.send({ t: 'lobby:create', name: sys._playerName }); }

export function joinLobby(sys: NetSystem, code: string): void {
  const norm = normalizeLobbyCode(code);
  if (!isValidLobbyCode(norm)) {
    sys.ctx.bus.emit('net:error', { code: 'invalid', message: '잘못된 로비 코드입니다. 6자리 코드를 입력하세요.' });
    return;
  }
  sys.pendingQuickMatch = false;
  sys.client.send({ t: 'lobby:join', code: norm, name: sys._playerName });
  }

export function leaveLobby(sys: NetSystem): void {
  sys.pendingQuickMatch = false;
  if (sys.client.connected) { sys.client.send({ t: 'lobby:leave' }); return; }
  // Offline with a suspended lobby: leaving is local (the server drops our slot when the grace expires).
  sys.stopReconnect();
  if (sys._lobby || sys._inSession) sys.dropLobby('left');
  }

export function setReady(sys: NetSystem, ready: boolean): void { sys.client.send({ t: 'lobby:ready', ready }); }

/**
 * Raid (default): host only, everyone ready. Training: any member; only the caller enters (`inMission`).
 * Phase 11: `planet` is the raid's 목표 행성 (the server refuses a raid without one — `no_planet`); a training
 * ignores it, and an unknown id is dropped here rather than sent. Falls back to `lobby.planet` when omitted.
 */
export function startGame(sys: NetSystem, seed: number, mode?: MissionMode, planet?: PlanetId): void {
  const s = Math.floor(seed) >>> 0;
  const training = mode === 'training';
  const p = training ? undefined : (isPlanetId(planet) ? planet : (sys._lobby?.planet ?? undefined));
  const msg: Extract<ClientToServer, { t: 'lobby:start' }> = { t: 'lobby:start', seed: s };
  if (mode) msg.mode = mode;
  if (p !== undefined) msg.planet = p;
  sys.client.send(msg);
  }

export function quickMatch(sys: NetSystem): void {
  if (!sys.client.connected) {
    sys.ctx.bus.emit('net:error', { code: 'server', message: '서버에 연결되어 있지 않습니다.' });
    return;
  }
  sys.pendingQuickMatch = true;
  sys.client.send({ t: 'lobby:quickmatch', name: sys._playerName });
  }

export function setPublic(sys: NetSystem, isPublic: boolean): void { sys.client.send({ t: 'lobby:setPublic', isPublic }); }

/* ══ 2026-09-09: 분대장(호스트) 지명 이관 ═══════════════════════════════════════════════════════════════════
 *
 * 서버가 받아 주는 경우는 둘뿐이다 — ① 지금 내가 호스트다, ② `claim` 이고 현재 호스트가 `lobby:hostDown` 으로
 * 사망 표시를 켜 두었다(시체 옆의 분대장 기기). 그 외에는 `lobby:error {code:'not_host'}` 가 돌아온다.
 * 여기서는 **로비가 없을 때만** no-op 이다 — 함선(로비는 있고 세션은 없다) 안에서도 넘길 수 있어야 한다.
 */
export function transferHost(sys: NetSystem, targetId: PeerId, claim?: boolean): void {
  if (!sys._lobby || !sys.client.connected) return;
  if (typeof targetId !== 'string' || targetId.length === 0) return;
  const msg: Extract<ClientToServer, { t: 'lobby:transferHost' }> = { t: 'lobby:transferHost', targetId };
  if (claim) msg.claim = true;
  sys.client.send(msg);
  }

/** 호스트 본인이 이 레이드에서 완전히 사망했다(또는 되살아났다)고 서버에 알린다 (분대장 기기의 전제 조건). */
export function reportHostDown(sys: NetSystem, down: boolean): void {
  if (!sys._lobby || !sys.client.connected) return;
  sys.client.send({ t: 'lobby:hostDown', down });
  }

export function setLobbySeed(sys: NetSystem, seed: number): void {
  const s = Math.floor(seed) >>> 0;
  if (sys._lobby) sys._lobby.seed = s; // optimistic mirror; the broadcast confirms it
  sys.client.send({ t: 'lobby:seed', seed: s });
  }

/**
 * Re-enter the running mission (raid after a resume, or join a running training from the terminal): tells the
 * server (`lobby:mission true`), starts the session with the lobby's mode and announces `flow rejoined` so the host
 * re-syncs us (extraction / pickups / containers / ghosts — our own body comes back with `ghost restore`).
 */
export function rejoinMission(sys: NetSystem): void {
  const lobby = sys._lobby;
  if (!lobby || !sys.missionInProgress || lobby.seed === null) return;
  const seed = lobby.seed;
  const mode: MissionMode = lobby.mode ?? 'raid';
  sys.client.send({ t: 'lobby:mission', inMission: true });
  const me = sys.localId ? sys.getLobbyPlayer(sys.localId) : undefined;
  if (me) me.inMission = true; // optimistic; the broadcast confirms it
  // Phase 11: a rejoin takes the 목표 행성 from the lobby (the mission is already running on it).
  const planet = mode === 'training' ? null : (isPlanetId(lobby.planet) ? lobby.planet : null);
  sys.beginSession(seed, lobby, mode, true, planet);
  sys.send({ t: 'flow', ev: 'rejoined' }, 'all');
  }

/** Leave the running mission but stay in the lobby (training exit, raid abort by a client). */
export function leaveMission(sys: NetSystem): void {
  const lobby = sys._lobby;
  const wasIn = sys._inSession;
  sys._inSession = false;
  sys.missionSeed = null;
  sys._tookOver = false;
  sys._raidBlob = null;
  sys.clearRemotes();
  sys.snapshotter.reset();
  sys.lastSnapshotAt = -Infinity;
  if (!lobby) return;
  const me = sys.localId ? sys.getLobbyPlayer(sys.localId) : undefined;
  if (me) me.inMission = false;
  if (sys.client.connected) sys.client.send({ t: 'lobby:mission', inMission: false });
  if (wasIn || me) sys.ctx.bus.emit('net:lobbyUpdated', { lobby });
  }

/** Upload my mid-raid state (game/ calls it periodically and on loot). Only inside a raid session. */
export function saveRaid(sys: NetSystem, blob: RaidSessionBlob): void {
  if (!sys._inSession || sys.sessionMode !== 'raid' || !sys._lobby || !sys.client.connected) return;
  if (blob.seed !== sys.missionSeed) return;
  let text: string;
  try { text = JSON.stringify(blob); } catch { return; }
  if (text.length * 3 > RAID_BLOB_MAX_BYTES && new TextEncoder().encode(text).byteLength > RAID_BLOB_MAX_BYTES) {
    if (!sys.raidTooLargeWarned) { sys.raidTooLargeWarned = true; console.warn(`[net] raid blob exceeds ${RAID_BLOB_MAX_BYTES} bytes; not uploaded`); }
    return;
  }
  sys.client.send({ t: 'raid:save', blob });
  }

export function getInviteUrl(sys: NetSystem): string | null {
  if (!sys._lobby) return null;
  return `${location.origin}${location.pathname}?${NET_INVITE_PARAM}=${sys._lobby.code}`;
  }

export function getLobbyPlayer(sys: NetSystem, id: PeerId): LobbyPlayer | undefined {
  const lobby = sys._lobby;
  if (!lobby) return undefined;
  for (let i = 0; i < lobby.players.length; i++) if (lobby.players[i].id === id) return lobby.players[i];
  return undefined;
  }

/**
 * Enter the mission of `lobby` with `seed` (server `game:start`, or `rejoinMission()`).
 * Phase 11: `planet` is the raid's 목표 행성 (null for a training / an older relay with nothing picked).
 */
export function beginSession(sys: NetSystem, seed: number, lobby: LobbyState, mode: MissionMode, rejoin: boolean, planet: PlanetId | null): void {
  const bus = sys.ctx.bus;
  sys.applyLobby(lobby);
  sys._inSession = true;
  sys.sessionMode = mode;
  sys.missionSeed = seed;
  sys._tookOver = false;
  sys.snapshotter.reset();
  sys.lastSnapshotAt = -Infinity;
  sys.clearRemotes(); // hub avatars are re-created from the first mission snapshots
  // Contract: whoever emits `game:newMission` sets `ctx.missionMode` **and** `ctx.missionPlanet` first — world/ and
  // core/ read them inside their synchronous handlers (the world generates during the emit).
  sys.ctx.missionMode = mode;
  sys.ctx.missionPlanet = mode === 'training' ? null : planet;
  const p = sys.ctx.missionPlanet;
  bus.emit('net:gameStarting', p !== null ? { seed, lobby, rejoin, mode, planet: p } : { seed, lobby, rejoin, mode });
  bus.emit('game:newMission', p !== null ? { seed, mode, planet: p } : { seed, mode });
  }

export function applyLobby(sys: NetSystem, next: LobbyState): void {
  const prev = sys._lobby;
  sys._lobby = next;
  const bus = sys.ctx.bus;
  if (prev && prev.code === next.code) {
    const me = sys.localId;
    for (const p of next.players) {
      if (p.id === me) continue;
      const was = prev.players.find((q) => q.id === p.id);
      if (!was) bus.emit('net:peerJoined', { id: p.id, name: p.name, slot: p.slot });
      else if (!was.connected && p.connected) sys.remotes.get(p.id)?.resetStream(); // came back → fresh seq
    }
    for (const q of prev.players) {
      if (q.id === me) continue;
      if (!next.players.some((p) => p.id === q.id)) {
        bus.emit('net:peerLeft', { id: q.id, name: q.name });
        const r = sys.remotes.get(q.id);
        if (r && r.connected) { r.connected = false; r.removeAt = sys.ctx.time + PEER_LINGER; }
      }
    }
    if (prev.hostId !== next.hostId) sys.onHostChanged(prev.hostId, next.hostId);
  } else {
    sys.membership.clear();
    sys.prevHostId = null;
  }
  sys.syncRemoteIdentities();
  bus.emit('net:lobbyUpdated', { lobby: next });
  }

/**
 * `lobby.hostId` changed while the lobby runs a mission. Inside the session this is a migration: promote / demote
 * systems, announce a takeover. Phase 9: the event goes out even when we are NOT in the session (hub member of a
 * running lobby — every system is a no-op outside a live mission), but `tookOver` / `flow takeover` stay session-only.
 */
export function onHostChanged(sys: NetSystem, prev: PeerId, next: PeerId): void {
  sys.prevHostId = prev;
  if (!sys._lobby || !sys._lobby.started) return;
  const isLocalHost = next === sys.localId;
  if (isLocalHost && sys._inSession) sys._tookOver = true;
  sys.ctx.bus.emit('net:hostChanged', { hostId: next, prev, isLocalHost });
  // After every local system promoted itself: tell the others so they re-request their syncs from us.
  if (isLocalHost && sys._inSession) sys.send({ t: 'flow', ev: 'takeover' }, 'others');
  }

export function playerInMission(sys: NetSystem, p: LobbyPlayer, lobby: LobbyState): boolean {
  return p.inMission ?? (lobby.started && p.connected);
  }

/** `moved` + `to` (2026-09-11, B-6): the server moved me straight into lobby `to`; its `lobby:state` follows at once. */
export function dropLobby(sys: NetSystem, reason: 'left' | 'disconnected' | 'kicked' | 'hostLeft' | 'moved', to?: string): void {
  const had = sys._lobby !== null;
  sys._lobby = null;
  sys._inSession = false;
  sys.missionSeed = null;
  sys.lobbySuspended = false;
  sys.pendingQuickMatch = false;
  sys._tookOver = false;
  sys._raidBlob = null;
  sys.prevHostId = null;
  sys.membership.clear();
  sys.crewCards.clear();   // Phase 10: cards belong to the party we just left (hub/ re-sends ours on `hub:entered`)
  sys.shipVisits.clear();  // 2026-09-08: so do the ship layouts behind the 격납고 bays
  sys.charBuffRelay.clear(); // 2026-09-12: and the squad's buff lists (the next lobby's members answer `bfr` with `cbufq sync`)
  sys.carryActive = false;
  sys.clearRemotes();
  if (had) sys.ctx.bus.emit('net:lobbyLeft', reason === 'moved' && to ? { reason, to } : { reason });
  }

/** Deferred session end: runs after every synchronous handler of the triggering bus event has finished. */
export function scheduleEndSession(sys: NetSystem): void {
  if (!sys._inSession || sys.endSessionPending) return;
  sys.endSessionPending = true;
  queueMicrotask(() => {
    sys.endSessionPending = false;
    sys.endSession();
  });
  }

/**
 * Mission ended for us (complete / over / abort). Leaves the lobby intact — we return to the shared ship. Raid: the
 * host reopens the lobby (`lobby:reset`), a client that left alone reports `lobby:mission false` and sees
 * `missionInProgress` until the host resets. Training: everyone reports `lobby:mission false`; the server closes the
 * training once the last member left (never `lobby:reset`, other members may still be training).
 */
export function endSession(sys: NetSystem): void {
  if (!sys._inSession) return;
  sys._inSession = false;
  sys.missionSeed = null;
  const wasHost = sys.isHost;
  const mode = sys.sessionMode;
  sys._tookOver = false;
  sys._raidBlob = null;
  sys.clearRemotes();
  sys.profileSync.flush();
  if (sys.client.connected && sys._lobby) {
    if (mode === 'raid' && wasHost) sys.client.send({ t: 'lobby:reset' });
    else {
      const me = sys.localId ? sys.getLobbyPlayer(sys.localId) : undefined;
      if (me) me.inMission = false;
      sys.client.send({ t: 'lobby:mission', inMission: false });
    }
  }
  }
