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
import {
  NET_DEFAULT_PORT, NET_WS_PATH, NET_TOKEN_PARAM, NET_NAME_PARAM, NET_TOKEN_LENGTH, NET_RECONNECT_GRACE_MS,
  isValidLobbyCode, normalizeLobbyCode, sanitizePlayerName,
} from '../src/shared/net.ts';
import { Lobby, LobbyManager, LOBBY_ERROR_MESSAGE_KO } from './Lobby.ts';

export const MAX_MESSAGE_BYTES = 64 * 1024;
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
}

export interface RelayServerOptions {
  port?: number;
  host?: string;
  /** Silence per-event logging (selftest). */
  quiet?: boolean;
  heartbeatMs?: number;
  /** How long a disconnected lobby member keeps their slot (default NET_RECONNECT_GRACE_MS; selftest uses ~300 ms). */
  reconnectGraceMs?: number;
}

export interface RelayServer {
  readonly port: number;
  readonly http: HttpServer;
  readonly wss: WebSocketServer;
  readonly lobbies: LobbyManager;
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
  if (text.length > MAX_MESSAGE_BYTES) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!isRecord(parsed) || typeof parsed.t !== 'string') return null;
  const m = parsed;
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
    case 'lobby:start':
      return typeof m.seed === 'number' && Number.isFinite(m.seed) ? { t: 'lobby:start', seed: m.seed } : null;
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
  const log = (line: string): void => { if (!quiet) console.log(`[relay ${new Date().toISOString()}] ${line}`); };

  const lobbies = new LobbyManager();
  const clients = new Map<PeerId, Client>();
  /** Lobby members whose socket is down: id → grace timer that removes them. */
  const graceTimers = new Map<PeerId, ReturnType<typeof setTimeout>>();

  const http = createServer((req, res) => {
    const url = req.url ?? '/';
    if (req.method === 'GET' && (url === '/health' || url.startsWith('/health?'))) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ ok: true, lobbies: lobbies.count, clients: clients.size, pendingReconnects: graceTimers.size, uptime: Math.round(process.uptime()) }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('SCAVANGER relay: websocket at ' + NET_WS_PATH);
  });

  const wss = new WebSocketServer({ server: http, path: NET_WS_PATH, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });

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

  /** Final removal (explicit leave or grace expiry): `peer:left` to the rest, empty lobby deleted. */
  const removeFromLobby = (id: PeerId, name: string, reason: 'leave' | 'timeout'): void => {
    clearGrace(id);
    const res = lobbies.leave(id);
    if (!res) return;
    const { lobby, hostMigrated, deleted } = res;
    log(`lobby ${lobby.code}: ${name}(${id}) ${reason}${hostMigrated ? ` → host now ${lobby.hostId}` : ''}${deleted ? ' → lobby deleted' : ''}`);
    if (!deleted) broadcast(lobby, { t: 'peer:left', id, lobby: lobby.toState() });
  };

  /** Socket of a lobby member went away: keep the slot, flag it, migrate host if needed, arm the grace timer. */
  const suspendInLobby = (c: Client): void => {
    const lobby = lobbies.lobbyOf(c.id);
    if (!lobby) return;
    lobby.setConnected(c.id, false);
    // Hub (not started): hand the host role over right away so the party can still launch. Mission running: keep the
    // host id through the grace so a returning host resumes as the authority; `remove()` migrates on expiry / leave.
    const migrated = lobby.started ? false : lobby.migrateHost();
    log(`lobby ${lobby.code}: ${c.name}(${c.id}) disconnected, slot kept ${graceMs} ms${migrated ? ` → host now ${lobby.hostId}` : lobby.started && lobby.hostId === c.id ? ' (host kept: mission running)' : ''}`);
    broadcastState(lobby);
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
        if (lobby.hostId !== c.id) { sendError(c, 'not_host'); return; }
        if (lobby.started) { sendError(c, 'started'); return; }
        if (!lobby.allReady()) { sendError(c, 'not_ready'); return; }
        lobby.start(m.seed);
        log(`lobby ${lobby.code}: started seed=${m.seed} players=${lobby.size} (${lobby.connectedCount()} connected)`);
        broadcast(lobby, { t: 'game:start', seed: m.seed, lobby: lobby.toState() });
        return;
      }

      case 'lobby:reset': {
        const lobby = lobbies.lobbyOf(c.id);
        if (!lobby) { sendError(c, 'not_in_lobby'); return; }
        if (lobby.hostId !== c.id) { sendError(c, 'not_host'); return; }
        lobby.reset();
        log(`lobby ${lobby.code}: reset (reopened)`);
        broadcastState(lobby);
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
    const c: Client = { id, ws, alive: true, name: name ?? '', remote: req.socket.remoteAddress ?? '?' };

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
    if (lobby) {
      const wasDown = clearGrace(id) || !(lobby.get(id)?.connected ?? true);
      lobby.setConnected(id, true);
      if (c.name) lobby.setName(id, c.name); else c.name = lobby.get(id)?.name ?? '';
      log(`lobby ${lobby.code}: ${c.name}(${id}) resumed${wasDown ? ' (was disconnected)' : ''}`);
      sendTo(c, { t: 'welcome', id, serverTime: Date.now(), lobby: lobby.toState(), resumed: true });
      broadcastState(lobby);
    } else {
      sendTo(c, { t: 'welcome', id, serverTime: Date.now() });
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
      log(`listening on http://${host}:${boundPort}  ws path ${NET_WS_PATH}  health GET /health  grace ${graceMs} ms`);
      resolve({
        port: boundPort,
        http,
        wss,
        lobbies,
        clientCount: () => clients.size,
        close: () => new Promise<void>((done) => {
          clearInterval(heartbeat);
          for (const t of graceTimers.values()) clearTimeout(t);
          graceTimers.clear();
          for (const c of clients.values()) { try { c.ws.terminate(); } catch { /* ignore */ } }
          wss.close(() => { http.close(() => done()); });
        }),
      });
    });
  });
}
