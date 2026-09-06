/**
 * SCAVANGER relay server: lobbies + opaque GameMessage relay over WebSocket.
 * Protocol = ClientToServer / ServerToClient in src/shared/net.ts (JSON text frames).
 * The server never inspects relayed `d` payloads; gameplay authority lives on the lobby host.
 *
 * Sessions: clients connect with `?t=<token>&n=<name>`; the PeerId is derived from the token, so a page reload or a
 * network drop comes back with the same id. A lobby member whose socket drops keeps their slot (`connected=false`)
 * for `reconnectGraceMs` (NET_RECONNECT_GRACE_MS) and is removed only when that timer expires.
 *
 * Erasable-TypeScript only (runs under Node 24's native type stripping).
 */
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type {
  ClientToServer, ServerToClient, GameMessage, LobbyErrorCode, LobbyState, PeerId, RelayTarget,
} from '../src/shared/net.ts';
import type { MissionMode } from '../src/shared/types.ts';
import type { RaidSessionBlob } from '../src/shared/profile.ts';
import {
  NET_DEFAULT_PORT, NET_WS_PATH, NET_TOKEN_PARAM, NET_NAME_PARAM, NET_TOKEN_LENGTH, NET_RECONNECT_GRACE_MS,
  NET_HOST_MIGRATE_DELAY_MS, isValidLobbyCode, normalizeLobbyCode, sanitizePlayerName,
} from '../src/shared/net.ts';
import { PROFILE_DOC_MAX_BYTES, RAID_BLOB_MAX_BYTES } from '../src/shared/profile.ts';
import { Lobby, LobbyManager, LOBBY_ERROR_MESSAGE_KO } from './Lobby.ts';
import { ProfileStore, docBytes, isProfileDocKey, type ProfileStoreOptions } from './Store.ts';

/** Cap for ordinary frames (lobby ops, relayed game messages). */
export const MAX_MESSAGE_BYTES = 64 * 1024;
/** Cap for `profile:set` / `raid:save` frames: the document cap plus envelope headroom (the socket's maxPayload). */
export const MAX_DOC_FRAME_BYTES = Math.max(PROFILE_DOC_MAX_BYTES, RAID_BLOB_MAX_BYTES) + 16 * 1024;
const MAX_REASON_INPUT = 64;
const MISSION_MODES: ReadonlySet<string> = new Set<MissionMode>(['raid', 'training']);
export const HEARTBEAT_MS = 15_000;
/** Length of the PeerId derived from a session token (base64url of sha256, truncated). */
export const PEER_ID_LENGTH = 12;
/** WebSocket close code used when a newer socket with the same session token replaces this one. */
export const CLOSE_DUPLICATE = 4001;
const MAX_CODE_INPUT = 32;
const MAX_NAME_INPUT = 64;
const TOKEN_RE = /^[A-Za-z0-9_-]+$/;

interface Client {
  id: PeerId;
  ws: WebSocket;
  alive: boolean;
  name: string;
  remote: string;
  /** Connected with a valid session token → a stable id with a profile record (anonymous ids get none). */
  hasProfile: boolean;
}

export interface RelayServerOptions {
  port?: number;
  host?: string;
  /** Silence per-event logging (selftest). */
  quiet?: boolean;
  heartbeatMs?: number;
  /** How long a disconnected lobby member keeps their slot (default NET_RECONNECT_GRACE_MS; selftest uses ~300 ms). */
  reconnectGraceMs?: number;
  /* Phase 7 */
  /** Delay before a dropped HOST of a started lobby hands the role over (default NET_HOST_MIGRATE_DELAY_MS). */
  hostMigrateDelayMs?: number;
  /** Profile store directory (`null` = memory only; default `server/data/`). */
  dataDir?: string | null;
  /** Debounce for profile file writes (ms). */
  profileSaveDebounceMs?: number;
}

export interface RelayServer {
  readonly port: number;
  readonly http: HttpServer;
  readonly wss: WebSocketServer;
  readonly lobbies: LobbyManager;
  /* Phase 7 */
  readonly store: ProfileStore;
  clientCount(): number;
  close(): Promise<void>;
}

function randomPeerId(): PeerId {
  // 6 bytes → 8 url-safe chars. Short enough for the wire, unique enough per process.
  return randomBytes(6).toString('base64url');
}

/** Deterministic PeerId for a session token. Exported so the selftest can predict ids. */
export function peerIdFromToken(token: string): PeerId {
  return createHash('sha256').update(token, 'utf8').digest('base64url').slice(0, PEER_ID_LENGTH);
}

export function isValidSessionToken(token: unknown): token is string {
  return typeof token === 'string' && token.length === NET_TOKEN_LENGTH && TOKEN_RE.test(token);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parse + shallow-validate an inbound frame. Returns null on anything suspicious. */
function parseClientMessage(raw: RawData, isBinary: boolean): ClientToServer | null {
  if (isBinary) return null;
  const text = typeof raw === 'string' ? raw : Array.isArray(raw) ? Buffer.concat(raw).toString('utf8') : raw.toString('utf8');
  if (text.length > MAX_DOC_FRAME_BYTES) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!isRecord(parsed) || typeof parsed.t !== 'string') return null;
  const m = parsed;
  // Only the two document uploads may exceed the ordinary cap (their payload is checked against the doc caps later).
  if (text.length > MAX_MESSAGE_BYTES && m.t !== 'profile:set' && m.t !== 'raid:save') return null;
  const validName = typeof m.name === 'string' && m.name.length <= MAX_NAME_INPUT;
  switch (m.t) {
    case 'lobby:create':
      return validName ? { t: 'lobby:create', name: m.name as string } : null;
    case 'lobby:join':
      return typeof m.code === 'string' && m.code.length <= MAX_CODE_INPUT && validName
        ? { t: 'lobby:join', code: m.code, name: m.name as string } : null;
    case 'lobby:leave':
      return { t: 'lobby:leave' };
    case 'lobby:ready':
      return typeof m.ready === 'boolean' ? { t: 'lobby:ready', ready: m.ready } : null;
    case 'lobby:start': {
      if (typeof m.seed !== 'number' || !Number.isFinite(m.seed)) return null;
      if (m.mode === undefined) return { t: 'lobby:start', seed: m.seed };
      return typeof m.mode === 'string' && MISSION_MODES.has(m.mode) ? { t: 'lobby:start', seed: m.seed, mode: m.mode as MissionMode } : null;
    }
    case 'lobby:reset':
      return { t: 'lobby:reset' };
    case 'relay':
      return typeof m.to === 'string' && m.to.length <= 64 && isRecord(m.d) && typeof m.d.t === 'string'
        ? { t: 'relay', to: m.to as RelayTarget, d: m.d as unknown as GameMessage } : null;
    case 'ping':
      return typeof m.ts === 'number' && Number.isFinite(m.ts) ? { t: 'ping', ts: m.ts } : null;
    /* appended: hub / quick match / reconnection */
    case 'lobby:quickmatch':
      return validName ? { t: 'lobby:quickmatch', name: m.name as string } : null;
    case 'lobby:setPublic':
      return typeof m.isPublic === 'boolean' ? { t: 'lobby:setPublic', isPublic: m.isPublic } : null;
    case 'lobby:seed':
      return typeof m.seed === 'number' && Number.isFinite(m.seed) ? { t: 'lobby:seed', seed: m.seed } : null;
    case 'lobby:name':
      return validName ? { t: 'lobby:name', name: m.name as string } : null;
    /* appended: Phase 7 — mission membership, profile store, credits, raid session */
    case 'lobby:mission':
      return typeof m.inMission === 'boolean' ? { t: 'lobby:mission', inMission: m.inMission } : null;
    case 'profile:get':
      return { t: 'profile:get' };
    case 'profile:set':
      // Key validity is answered with `invalid` by the handler (so a wrong key is reported, not silently dropped).
      return typeof m.key === 'string' && 'doc' in m ? { t: 'profile:set', key: m.key as never, doc: m.doc } : null;
    case 'credits:tx':
      return typeof m.txId === 'number' && Number.isFinite(m.txId) && typeof m.delta === 'number' && Number.isFinite(m.delta)
        && typeof m.reason === 'string' && m.reason.length <= MAX_REASON_INPUT
        ? { t: 'credits:tx', txId: m.txId, delta: m.delta, reason: m.reason } : null;
    case 'raid:save': {
      const b = m.blob;
      if (!isRecord(b) || typeof b.seed !== 'number' || !Number.isFinite(b.seed) || typeof b.missionTime !== 'number'
        || !isRecord(b.stats) || !('inventory' in b) || typeof b.savedAt !== 'number') return null;
      return { t: 'raid:save', blob: b as unknown as RaidSessionBlob };
    }
    default:
      return null;
  }
}

/** `?t=…&n=…` from the upgrade request. Invalid / missing token → null (random id). */
function parseConnectQuery(req: IncomingMessage): { token: string | null; name: string | null } {
  let token: string | null = null;
  let name: string | null = null;
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const t = url.searchParams.get(NET_TOKEN_PARAM);
    if (isValidSessionToken(t)) token = t;
    const n = url.searchParams.get(NET_NAME_PARAM);
    if (typeof n === 'string' && n.length > 0 && n.length <= MAX_NAME_INPUT) name = sanitizePlayerName(n);
  } catch { /* malformed url → anonymous */ }
  return { token, name };
}

export function startRelayServer(opts: RelayServerOptions = {}): Promise<RelayServer> {
  const port = opts.port ?? Number(process.env.PORT ?? NET_DEFAULT_PORT);
  const host = opts.host ?? process.env.HOST ?? '0.0.0.0';
  const quiet = opts.quiet ?? false;
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const graceMs = opts.reconnectGraceMs ?? NET_RECONNECT_GRACE_MS;
  const migrateMs = opts.hostMigrateDelayMs ?? NET_HOST_MIGRATE_DELAY_MS;
  const log = (line: string): void => { if (!quiet) console.log(`[relay ${new Date().toISOString()}] ${line}`); };

  const storeOpts: ProfileStoreOptions = { quiet };
  if (opts.dataDir !== undefined) storeOpts.dataDir = opts.dataDir;
  if (opts.profileSaveDebounceMs !== undefined) storeOpts.saveDebounceMs = opts.profileSaveDebounceMs;
  const store = new ProfileStore(storeOpts);
  const lobbies = new LobbyManager();
  const clients = new Map<PeerId, Client>();
  /** Lobby members whose socket is down: id → grace timer that removes them. */
  const graceTimers = new Map<PeerId, ReturnType<typeof setTimeout>>();
  /** Started lobbies whose host dropped: lobby code → timer that migrates the host role (Phase 7). */
  const migrateTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const http = createServer((req, res) => {
    const url = req.url ?? '/';
    if (req.method === 'GET' && (url === '/health' || url.startsWith('/health?'))) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ ok: true, lobbies: lobbies.count, clients: clients.size, pendingReconnects: graceTimers.size, profiles: store.size, uptime: Math.round(process.uptime()) }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('SCAVANGER relay: websocket at ' + NET_WS_PATH);
  });

  const wss = new WebSocketServer({ server: http, path: NET_WS_PATH, maxPayload: MAX_DOC_FRAME_BYTES, perMessageDeflate: false });

  /* ── outbound helpers ─────────────────────────────────────────────────── */
  const sendTo = (c: Client, msg: ServerToClient): void => {
    if (c.ws.readyState !== WebSocket.OPEN) return;
    try { c.ws.send(JSON.stringify(msg)); } catch (e) { log(`send failed to ${c.id}: ${(e as Error).message}`); }
  };
  const sendError = (c: Client, code: LobbyErrorCode, message?: string): void => {
    sendTo(c, { t: 'lobby:error', code, message: message ?? LOBBY_ERROR_MESSAGE_KO[code] });
  };
  const broadcast = (lobby: Lobby, msg: ServerToClient, except?: PeerId): void => {
    const text = JSON.stringify(msg);
    for (const id of lobby.players.keys()) {
      if (id === except) continue;
      const c = clients.get(id);
      if (!c || c.ws.readyState !== WebSocket.OPEN) continue;
      try { c.ws.send(text); } catch { /* peer is going away; heartbeat will reap it */ }
    }
  };
  const broadcastState = (lobby: Lobby): void => {
    const state: LobbyState = lobby.toState();
    broadcast(lobby, { t: 'lobby:state', lobby: state });
  };

  /* ── lobby ops ────────────────────────────────────────────────────────── */
  const clearGrace = (id: PeerId): boolean => {
    const t = graceTimers.get(id);
    if (t === undefined) return false;
    clearTimeout(t);
    graceTimers.delete(id);
    return true;
  };

  const clearMigrate = (code: string): void => {
    const t = migrateTimers.get(code);
    if (t === undefined) return;
    clearTimeout(t);
    migrateTimers.delete(code);
  };

  /** A training whose last member left (`inMission` all false) is closed by the server; returns true when it reset. */
  const autoResetTraining = (lobby: Lobby): boolean => {
    if (!lobby.started || lobby.mode !== 'training' || lobby.inMissionCount() > 0) return false;
    lobby.reset();
    clearMigrate(lobby.code);
    log(`lobby ${lobby.code}: training ended (last member left) → reset`);
    return true;
  };

  /** Final removal (explicit leave or grace expiry): `peer:left` to the rest, empty lobby deleted. */
  const removeFromLobby = (id: PeerId, name: string, reason: 'leave' | 'timeout'): void => {
    clearGrace(id);
    const res = lobbies.leave(id);
    if (!res) return;
    const { lobby, hostMigrated, deleted } = res;
    log(`lobby ${lobby.code}: ${name}(${id}) ${reason}${hostMigrated ? ` → host now ${lobby.hostId}` : ''}${deleted ? ' → lobby deleted' : ''}`);
    if (deleted) { clearMigrate(lobby.code); return; }
    if (hostMigrated) clearMigrate(lobby.code);
    broadcast(lobby, { t: 'peer:left', id, lobby: lobby.toState() });
    if (autoResetTraining(lobby)) broadcastState(lobby);
  };

  /**
   * Socket of a lobby member went away: keep the slot, flag it, arm the grace timer. Host role: not started (hub) →
   * migrates at once so the party can still launch; started → kept for `migrateMs` (a brief blip keeps the host),
   * then moved to a connected member inside the mission (`Lobby.migrateHost` prefers `inMission`).
   */
  const suspendInLobby = (c: Client): void => {
    const lobby = lobbies.lobbyOf(c.id);
    if (!lobby) return;
    lobby.setConnected(c.id, false);
    const migrated = lobby.started ? false : lobby.migrateHost();
    const hostDropped = lobby.started && lobby.hostId === c.id;
    log(`lobby ${lobby.code}: ${c.name}(${c.id}) disconnected, slot kept ${graceMs} ms${migrated ? ` → host now ${lobby.hostId}` : hostDropped ? ` (host kept ${migrateMs} ms: mission running)` : ''}`);
    broadcastState(lobby);
    if (hostDropped) {
      clearMigrate(lobby.code);
      const timer = setTimeout(() => {
        migrateTimers.delete(lobby.code);
        if (lobbies.byCode(lobby.code) !== lobby || !lobby.started) return;
        if (lobby.migrateHost()) {
          log(`lobby ${lobby.code}: host ${c.id} still down after ${migrateMs} ms → host now ${lobby.hostId}`);
          broadcastState(lobby);
        }
      }, migrateMs);
      timer.unref();
      migrateTimers.set(lobby.code, timer);
    }
    clearGrace(c.id);
    const timer = setTimeout(() => {
      graceTimers.delete(c.id);
      // Reconnected in the meantime (timer should have been cleared, but be safe).
      if (clients.has(c.id)) return;
      removeFromLobby(c.id, c.name, 'timeout');
    }, graceMs);
    timer.unref();
    graceTimers.set(c.id, timer);
  };

  const handle = (c: Client, m: ClientToServer): void => {
    switch (m.t) {
      case 'ping':
        sendTo(c, { t: 'pong', ts: m.ts, serverTime: Date.now() });
        return;

      case 'lobby:create': {
        c.name = sanitizePlayerName(m.name);
        const res = lobbies.create(c.id, c.name, false);
        if (typeof res === 'string') { sendError(c, res); return; }
        log(`lobby ${res.code}: created (private) by ${c.name}(${c.id})`);
        broadcastState(res);
        return;
      }

      case 'lobby:quickmatch': {
        c.name = sanitizePlayerName(m.name);
        const res = lobbies.quickMatch(c.id, c.name);
        if (typeof res === 'string') { sendError(c, res); return; }
        log(`lobby ${res.lobby.code}: quickmatch ${res.created ? 'created (public)' : `joined (${res.lobby.size} players)`} by ${c.name}(${c.id})`);
        broadcastState(res.lobby);
        return;
      }

      case 'lobby:join': {
        const code = normalizeLobbyCode(m.code);
        if (!isValidLobbyCode(code)) { sendError(c, 'invalid', '잘못된 로비 코드입니다.'); return; }
        c.name = sanitizePlayerName(m.name);
        const res = lobbies.join(c.id, code, c.name);
        if (typeof res === 'string') { sendError(c, res); return; }
        log(`lobby ${code}: ${c.name}(${c.id}) joined (${res.size} players)`);
        broadcastState(res);
        return;
      }

      case 'lobby:leave': {
        const lobby = lobbies.lobbyOf(c.id);
        if (!lobby) { sendError(c, 'not_in_lobby'); return; }
        removeFromLobby(c.id, c.name, 'leave');
        sendTo(c, { t: 'lobby:left' });
        return;
      }

      case 'lobby:ready': {
        const lobby = lobbies.lobbyOf(c.id);
        if (!lobby) { sendError(c, 'not_in_lobby'); return; }
        // Started lobby: ready = "in pod" is handled client-side in the hub; accept as a no-op and echo the state.
        if (lobby.started) { sendTo(c, { t: 'lobby:state', lobby: lobby.toState() }); return; }
        lobby.setReady(c.id, m.ready);
        log(`lobby ${lobby.code}: ${c.name} ready=${m.ready}`);
        broadcastState(lobby);
        return;
      }

      case 'lobby:start': {
        const lobby = lobbies.lobbyOf(c.id);
        if (!lobby) { sendError(c, 'not_in_lobby'); return; }
        const mode: MissionMode = m.mode ?? 'raid';
        if (lobby.started) { sendError(c, 'started'); return; }
        if (mode === 'training') {
          // Any member, no ready gating: only the starter enters; the rest join later through `lobby:mission`.
          lobby.start(m.seed, 'training', c.id);
          log(`lobby ${lobby.code}: training started seed=${m.seed} by ${c.name}(${c.id})`);
          broadcast(lobby, { t: 'game:start', seed: m.seed, lobby: lobby.toState(), mode: 'training' });
          return;
        }
        if (lobby.hostId !== c.id) { sendError(c, 'not_host'); return; }
        if (!lobby.allReady()) { sendError(c, 'not_ready'); return; }
        lobby.start(m.seed, 'raid', c.id);
        log(`lobby ${lobby.code}: started seed=${m.seed} players=${lobby.size} (${lobby.connectedCount()} connected)`);
        broadcast(lobby, { t: 'game:start', seed: m.seed, lobby: lobby.toState(), mode: 'raid' });
        return;
      }

      case 'lobby:reset': {
        const lobby = lobbies.lobbyOf(c.id);
        if (!lobby) { sendError(c, 'not_in_lobby'); return; }
        if (lobby.hostId !== c.id) { sendError(c, 'not_host'); return; }
        lobby.reset();
        clearMigrate(lobby.code);
        log(`lobby ${lobby.code}: reset (reopened)`);
        broadcastState(lobby);
        return;
      }

      /* appended: Phase 7 */
      case 'lobby:mission': {
        const lobby = lobbies.lobbyOf(c.id);
        if (!lobby) { sendError(c, 'not_in_lobby'); return; }
        if (m.inMission && !lobby.started) { sendError(c, 'in_mission'); return; }
        lobby.setInMission(c.id, m.inMission);
        log(`lobby ${lobby.code}: ${c.name}(${c.id}) inMission=${m.inMission} (${lobby.inMissionCount()} in mission)`);
        if (!m.inMission) lobby.raid.delete(c.id);
        autoResetTraining(lobby);
        broadcastState(lobby);
        return;
      }

      case 'profile:get': {
        sendTo(c, { t: 'profile:docs', profile: store.snapshot(c.id) });
        return;
      }

      case 'profile:set': {
        if (!c.hasProfile) { sendError(c, 'invalid', '프로필이 없는 연결입니다 (세션 토큰 필요).'); return; }
        if (!isProfileDocKey(m.key)) { sendError(c, 'invalid', '알 수 없는 프로필 문서 키입니다.'); return; }
        const res = store.setDoc(c.id, m.key, m.doc);
        if (res === 'too_large') { sendError(c, 'too_large'); return; }
        if (res === 'invalid') { sendError(c, 'invalid'); return; }
        return;
      }

      case 'credits:tx': {
        if (!c.hasProfile) { sendTo(c, { t: 'credits:result', txId: m.txId, ok: false, credits: 0, reason: '프로필이 없는 연결입니다.' }); return; }
        const res = store.applyCredits(c.id, m.delta, m.reason);
        log(`credits ${c.id}: ${m.delta >= 0 ? '+' : ''}${m.delta} (${m.reason}) → ${res.ok ? res.credits : `refused (${res.reason})`}`);
        sendTo(c, res.reason !== undefined
          ? { t: 'credits:result', txId: m.txId, ok: res.ok, credits: res.credits, reason: res.reason }
          : { t: 'credits:result', txId: m.txId, ok: res.ok, credits: res.credits });
        return;
      }

      case 'raid:save': {
        const lobby = lobbies.lobbyOf(c.id);
        if (!lobby) return; // silently ignored: the mission is over for us
        if (docBytes(m.blob) > RAID_BLOB_MAX_BYTES) { sendError(c, 'too_large'); return; }
        lobby.setRaid(c.id, m.blob); // false = not a running raid of that seed → ignored
        return;
      }

      case 'lobby:setPublic': {
        const lobby = lobbies.lobbyOf(c.id);
        if (!lobby) { sendError(c, 'not_in_lobby'); return; }
        if (lobby.hostId !== c.id) { sendError(c, 'not_host'); return; }
        lobby.isPublic = m.isPublic;
        log(`lobby ${lobby.code}: isPublic=${m.isPublic}`);
        broadcastState(lobby);
        return;
      }

      case 'lobby:seed': {
        const lobby = lobbies.lobbyOf(c.id);
        if (!lobby) { sendError(c, 'not_in_lobby'); return; }
        if (lobby.hostId !== c.id) { sendError(c, 'not_host'); return; }
        if (lobby.started) { sendError(c, 'started'); return; }
        lobby.seed = m.seed;
        log(`lobby ${lobby.code}: seed=${m.seed}`);
        broadcastState(lobby);
        return;
      }

      case 'lobby:name': {
        c.name = sanitizePlayerName(m.name);
        const lobby = lobbies.lobbyOf(c.id);
        if (!lobby) return; // nothing to broadcast; the name is used by the next create/join anyway
        lobby.setName(c.id, c.name);
        broadcastState(lobby);
        return;
      }

      case 'relay': {
        const lobby = lobbies.lobbyOf(c.id);
        if (!lobby) { sendError(c, 'not_in_lobby'); return; }
        const out: ServerToClient = { t: 'relay', from: c.id, d: m.d };
        if (m.to === 'all') broadcast(lobby, out);
        else if (m.to === 'others') broadcast(lobby, out, c.id);
        else if (m.to === 'host') {
          const h = clients.get(lobby.hostId);
          if (h) sendTo(h, out);
        } else {
          if (!lobby.has(m.to)) return; // unknown / foreign peer: drop silently
          const target = clients.get(m.to);
          if (target) sendTo(target, out);
        }
        return;
      }
    }
  };

  /* ── connection lifecycle ─────────────────────────────────────────────── */
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const { token, name } = parseConnectQuery(req);
    const id = token ? peerIdFromToken(token) : randomPeerId();
    const c: Client = { id, ws, alive: true, name: name ?? '', remote: req.socket.remoteAddress ?? '?', hasProfile: token !== null };

    // Same session already attached (second tab / zombie socket): the newest connection wins.
    const old = clients.get(id);
    if (old) {
      log(`duplicate session ${id}: closing previous socket from ${old.remote}`);
      sendError(old, 'duplicate');
      try { old.ws.close(CLOSE_DUPLICATE, 'duplicate session'); } catch { /* ignore */ }
      const zombie = old.ws;
      setTimeout(() => { try { zombie.terminate(); } catch { /* ignore */ } }, 2000).unref();
    }
    clients.set(id, c);
    log(`connect ${id}${token ? ' (token)' : ' (anonymous)'} from ${c.remote} (${clients.size} clients)`);

    // Still a lobby member (reconnect within grace, page reload, or replaced socket) → resume into it.
    const lobby = lobbies.lobbyOf(id);
    const profile = c.hasProfile ? store.snapshot(id) : undefined;
    if (lobby) {
      const wasDown = clearGrace(id) || !(lobby.get(id)?.connected ?? true);
      lobby.setConnected(id, true);
      // A returning host inside the migrate delay keeps the role; after it, `welcome.lobby.hostId` tells it otherwise.
      if (lobby.hostId === id) clearMigrate(lobby.code);
      if (c.name) lobby.setName(id, c.name); else c.name = lobby.get(id)?.name ?? '';
      const raid = lobby.getRaid(id);
      log(`lobby ${lobby.code}: ${c.name}(${id}) resumed${wasDown ? ' (was disconnected)' : ''}${raid ? ' + raid blob' : ''}`);
      const welcome: ServerToClient = { t: 'welcome', id, serverTime: Date.now(), lobby: lobby.toState(), resumed: true };
      if (profile) welcome.profile = profile;
      if (raid) welcome.raid = raid;
      sendTo(c, welcome);
      broadcastState(lobby);
    } else {
      const welcome: ServerToClient = { t: 'welcome', id, serverTime: Date.now() };
      if (profile) welcome.profile = profile;
      sendTo(c, welcome);
    }

    ws.on('pong', () => { c.alive = true; });
    ws.on('message', (raw: RawData, isBinary: boolean) => {
      if (clients.get(c.id) !== c) return; // replaced by a newer socket; ignore stragglers
      c.alive = true;
      let msg: ClientToServer | null = null;
      try { msg = parseClientMessage(raw, isBinary); } catch { msg = null; }
      if (!msg) { sendError(c, 'invalid'); return; }
      try { handle(c, msg); } catch (e) {
        log(`handler error for ${c.id} (${msg.t}): ${(e as Error).stack ?? e}`);
        sendError(c, 'server');
      }
    });
    ws.on('error', (err: Error) => { log(`socket error ${c.id}: ${err.message}`); });
    ws.on('close', () => {
      // A replaced (duplicate) socket closing must not touch the lobby membership of the live one.
      if (clients.get(c.id) !== c) { log(`closed replaced socket ${c.id}`); return; }
      clients.delete(c.id);
      try { suspendInLobby(c); } catch (e) { log(`cleanup error ${c.id}: ${(e as Error).message}`); }
      log(`disconnect ${c.id} (${clients.size} clients)`);
    });
  });
  wss.on('error', (err: Error) => { log(`wss error: ${err.message}`); });

  const heartbeat = setInterval(() => {
    for (const c of clients.values()) {
      if (!c.alive) { log(`heartbeat: terminating dead socket ${c.id}`); c.ws.terminate(); continue; }
      c.alive = false;
      try { c.ws.ping(); } catch { /* ignore */ }
    }
  }, heartbeatMs);
  heartbeat.unref();

  return new Promise<RelayServer>((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, host, () => {
      const addr = http.address();
      const boundPort = typeof addr === 'object' && addr ? addr.port : port;
      log(`listening on http://${host}:${boundPort}  ws path ${NET_WS_PATH}  health GET /health  grace ${graceMs} ms  host migrate ${migrateMs} ms  profiles ${store.path ?? '(memory)'}`);
      resolve({
        port: boundPort,
        http,
        wss,
        lobbies,
        store,
        clientCount: () => clients.size,
        close: () => new Promise<void>((done) => {
          clearInterval(heartbeat);
          for (const t of graceTimers.values()) clearTimeout(t);
          graceTimers.clear();
          for (const t of migrateTimers.values()) clearTimeout(t);
          migrateTimers.clear();
          store.close();
          for (const c of clients.values()) { try { c.ws.terminate(); } catch { /* ignore */ } }
          wss.close(() => { http.close(() => done()); });
        }),
      });
    });
  });
}
