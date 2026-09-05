/**
 * SCAVANGER relay server: lobbies + opaque GameMessage relay over WebSocket.
 * Protocol = ClientToServer / ServerToClient in src/shared/net.ts (JSON text frames).
 * The server never inspects relayed `d` payloads; gameplay authority lives on the lobby host.
 *
 * Erasable-TypeScript only (runs under Node 24's native type stripping).
 */
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type {
  ClientToServer, ServerToClient, GameMessage, LobbyErrorCode, LobbyState, PeerId, RelayTarget,
} from '../src/shared/net.ts';
import {
  NET_DEFAULT_PORT, NET_WS_PATH, isValidLobbyCode, normalizeLobbyCode, sanitizePlayerName,
} from '../src/shared/net.ts';
import { Lobby, LobbyManager, LOBBY_ERROR_MESSAGE_KO } from './Lobby.ts';

export const MAX_MESSAGE_BYTES = 64 * 1024;
export const HEARTBEAT_MS = 15_000;
const MAX_CODE_INPUT = 32;
const MAX_NAME_INPUT = 64;

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
}

export interface RelayServer {
  readonly port: number;
  readonly http: HttpServer;
  readonly wss: WebSocketServer;
  readonly lobbies: LobbyManager;
  clientCount(): number;
  close(): Promise<void>;
}

function newPeerId(): PeerId {
  // 6 bytes → 8 url-safe chars. Short enough for the wire, unique enough per process.
  return randomBytes(6).toString('base64url');
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
  switch (m.t) {
    case 'lobby:create':
      return typeof m.name === 'string' && m.name.length <= MAX_NAME_INPUT ? { t: 'lobby:create', name: m.name } : null;
    case 'lobby:join':
      return typeof m.code === 'string' && m.code.length <= MAX_CODE_INPUT && typeof m.name === 'string' && m.name.length <= MAX_NAME_INPUT
        ? { t: 'lobby:join', code: m.code, name: m.name } : null;
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
    default:
      return null;
  }
}

export function startRelayServer(opts: RelayServerOptions = {}): Promise<RelayServer> {
  const port = opts.port ?? Number(process.env.PORT ?? NET_DEFAULT_PORT);
  const host = opts.host ?? process.env.HOST ?? '0.0.0.0';
  const quiet = opts.quiet ?? false;
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const log = (line: string): void => { if (!quiet) console.log(`[relay ${new Date().toISOString()}] ${line}`); };

  const lobbies = new LobbyManager();
  const clients = new Map<PeerId, Client>();

  const http = createServer((req, res) => {
    const url = req.url ?? '/';
    if (req.method === 'GET' && (url === '/health' || url.startsWith('/health?'))) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ ok: true, lobbies: lobbies.count, clients: clients.size, uptime: Math.round(process.uptime()) }));
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
  const removeFromLobby = (c: Client, reason: 'leave' | 'disconnect'): void => {
    const res = lobbies.leave(c.id);
    if (!res) return;
    const { lobby, hostMigrated, deleted } = res;
    log(`lobby ${lobby.code}: ${c.name}(${c.id}) ${reason}${hostMigrated ? ` → host now ${lobby.hostId}` : ''}${deleted ? ' → lobby deleted' : ''}`);
    if (!deleted) broadcast(lobby, { t: 'peer:left', id: c.id, lobby: lobby.toState() });
  };

  const handle = (c: Client, m: ClientToServer): void => {
    switch (m.t) {
      case 'ping':
        sendTo(c, { t: 'pong', ts: m.ts, serverTime: Date.now() });
        return;

      case 'lobby:create': {
        c.name = sanitizePlayerName(m.name);
        const res = lobbies.create(c.id, c.name);
        if (typeof res === 'string') { sendError(c, res); return; }
        log(`lobby ${res.code}: created by ${c.name}(${c.id})`);
        broadcastState(res);
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
        removeFromLobby(c, 'leave');
        sendTo(c, { t: 'lobby:left' });
        return;
      }

      case 'lobby:ready': {
        const lobby = lobbies.lobbyOf(c.id);
        if (!lobby) { sendError(c, 'not_in_lobby'); return; }
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
        log(`lobby ${lobby.code}: started seed=${m.seed} players=${lobby.size}`);
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
    const c: Client = { id: newPeerId(), ws, alive: true, name: '', remote: req.socket.remoteAddress ?? '?' };
    clients.set(c.id, c);
    log(`connect ${c.id} from ${c.remote} (${clients.size} clients)`);
    sendTo(c, { t: 'welcome', id: c.id, serverTime: Date.now() });

    ws.on('pong', () => { c.alive = true; });
    ws.on('message', (raw: RawData, isBinary: boolean) => {
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
      clients.delete(c.id);
      try { removeFromLobby(c, 'disconnect'); } catch (e) { log(`cleanup error ${c.id}: ${(e as Error).message}`); }
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
      log(`listening on http://${host}:${boundPort}  ws path ${NET_WS_PATH}  health GET /health`);
      resolve({
        port: boundPort,
        http,
        wss,
        lobbies,
        clientCount: () => clients.size,
        close: () => new Promise<void>((done) => {
          clearInterval(heartbeat);
          for (const c of clients.values()) { try { c.ws.terminate(); } catch { /* ignore */ } }
          wss.close(() => { http.close(() => done()); });
        }),
      });
    });
  });
}
