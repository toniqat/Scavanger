/**
 * SCAVANGER relay server: lobbies + opaque GameMessage relay over WebSocket.
 * Protocol = ClientToServer / ServerToClient in src/shared/net.ts (JSON text frames).
 * The server never inspects relayed `d` payloads; gameplay authority lives on the lobby host.
 *
 * Sessions: clients connect with `?t=<token>&n=<name>`; the PeerId is derived from the token, so a page reload or a
 * network drop comes back with the same id. A lobby member whose socket drops keeps their slot (`connected=false`)
 * for `reconnectGraceMs` (NET_RECONNECT_GRACE_MS) and is removed only when that timer expires — except for a member
 * who dropped **inside a running raid**, whose slot is kept for the whole mission (see `armGrace`, 2026-09-07).
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
  NET_HOST_MIGRATE_DELAY_MS, NET_MAX_PLAYERS, isValidLobbyCode, normalizeLobbyCode, sanitizePlayerName,
} from '../src/shared/net.ts';
import { PROFILE_DOC_MAX_BYTES, RAID_BLOB_MAX_BYTES } from '../src/shared/profile.ts';
/* Phase 11 */
import type { PlanetId } from '../src/shared/planets.ts';
import { isPlanetId } from '../src/shared/planets.ts';
import type { PlayerCode, PresenceState, SocialErrorCode, SocialPlayer, SocialSnapshot } from '../src/shared/social.ts';
import {
  SOCIAL_ERROR_MESSAGE_KO, SOCIAL_WHISPER_MAX, normalizePlayerCode, playBlockReason,
} from '../src/shared/social.ts';
/* 2026-09-11 (B-3 · B-4 · B-5 · B-6): 초대 표 · 차단 · 푸시 합치기 · 원자적 이동 */
import type { InviteOutcome, SocialCard } from '../src/shared/social.ts';
import { SQUAD_INVITE_MAX } from '../src/shared/social.ts';
import { InviteTable, PushCoalescer, type OpenInvite } from './Invites.ts';
import { Lobby, LobbyManager, LOBBY_ERROR_MESSAGE_KO } from './Lobby.ts';
import {
  PROFILE_GC_INTERVAL_MS, ProfileStore, SOCIAL_LEVEL_MAX, docBytes, isProfileDocKey,
  type ProfileGcReport, type ProfileStoreOptions,
} from './Store.ts';
/* 2026-09-11 (E-6): 문서 리비전 · 트랜잭션 */
import { PROFILE_WRITE_ID_MAX, type RevWriteResult } from './Store.ts';
import { PROFILE_SETMANY_MAX_BYTES } from '../src/shared/profile.ts';
/* 2026-09-11 (E-4 ⑦): 서버 크레딧 검증 */
import type { EconomyTable } from '../src/shared/credits.ts';
import { CreditEconomy, ECONOMY_TABLE, economyTableIntact } from './Economy.ts';

/** Cap for ordinary frames (lobby ops, relayed game messages). */
export const MAX_MESSAGE_BYTES = 64 * 1024;
/** Cap for `profile:set` / `raid:save` frames: the document cap plus envelope headroom. */
export const MAX_DOC_FRAME_BYTES = Math.max(PROFILE_DOC_MAX_BYTES, RAID_BLOB_MAX_BYTES) + 16 * 1024;
/**
 * 2026-09-11 (E-6): cap for a `profile:setMany` frame — every document of a transaction (`PROFILE_SETMANY_MAX_BYTES`)
 * plus envelope headroom. This is the socket's `maxPayload`; every other frame type keeps its own smaller cap.
 */
export const MAX_TX_FRAME_BYTES = PROFILE_SETMANY_MAX_BYTES + 16 * 1024;
const MAX_REASON_INPUT = 64;
const MISSION_MODES: ReadonlySet<string> = new Set<MissionMode>(['raid', 'training']);
export const HEARTBEAT_MS = 15_000;
/** Length of the PeerId derived from a session token (base64url of sha256, truncated). */
export const PEER_ID_LENGTH = 12;
/** WebSocket close code used when a newer socket with the same session token replaces this one. */
export const CLOSE_DUPLICATE = 4001;
/** 2026-09-11 (C-29): the operator ran `kick` (`lobby:error kicked` is sent first). */
export const CLOSE_KICKED = 4002;
/** 2026-09-11 (C-29): over the operator's `max` (`lobby:error server_full` is sent first, no welcome). */
export const CLOSE_SERVER_FULL = 4003;
const MAX_CODE_INPUT = 32;
const MAX_NAME_INPUT = 64;
const TOKEN_RE = /^[A-Za-z0-9_-]+$/;
/* Phase 11: what a `social:whisper` frame may carry before the handler trims it to `SOCIAL_WHISPER_MAX`. */
const MAX_WHISPER_INPUT = 4 * SOCIAL_WHISPER_MAX;
/* 2026-09-11 (B-3): an invite id is 8 base64url chars (`InviteTable`); anything longer is not ours. */
const MAX_INVITE_ID_INPUT = 64;

interface Client {
  id: PeerId;
  ws: WebSocket;
  alive: boolean;
  name: string;
  remote: string;
  /** Connected with a valid session token → a stable id with a profile record (anonymous ids get none). */
  hasProfile: boolean;
  /** 2026-09-11 (C-29): `Date.now()` at connect — `listClients()` shows how long the socket has been up. */
  connectedAt: number;
  /** 2026-09-11 (C-29): kicked by the operator — frames arriving before the close event are ignored. */
  kicked: boolean;
}

/** 2026-09-11 (C-29): one row of the operator console's `list` (`RelayServer.listClients`). */
export interface RelayClientInfo {
  id: PeerId;
  name: string;
  remote: string;
  /** The 아이디 (`PlayerCode`) — null for an anonymous socket (or before the store assigned one). */
  code: string | null;
  /** Lobby code, or null outside any ship. */
  lobby: string | null;
  host: boolean;
  inMission: boolean;
  connectedAt: number;
}

/** 2026-09-11 (C-29): `RelayServer.kick` result. `connected` = a live socket was closed (false = only a slot in grace). */
export type RelayKickResult =
  | { ok: true; id: PeerId; name: string; connected: boolean; lobby: string | null }
  | { ok: false; reason: 'not_found' };

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
  /** 2026-09-11 (C-29): connection cap (`null` / ≤ 0 = unlimited, the default). Changeable later with `setMaxClients`. */
  maxClients?: number | null;
  /**
   * 2026-09-11 (B-2): period of the profile GC (`collectGarbage`), default `PROFILE_GC_INTERVAL_MS`. It always runs once
   * at startup; `null` / ≤ 0 turns the periodic run off (a manual `collectGarbage()` still works).
   */
  profileGcIntervalMs?: number | null;
  /** 2026-09-11 (B-3): squad invite lifetime on the server clock (default `SQUAD_INVITE_TTL_S`; the selftest shortens it). */
  inviteTtlMs?: number;
  /** 2026-09-11 (B-5): presence push coalescing window (default `SOCIAL_PUSH_COALESCE_MS`). */
  socialPushCoalesceMs?: number;
  /**
   * 2026-09-11 (E-4 ⑦): accept the dev credit reasons `console` · `smoke:*` · `e2e:*` · `shot` (`CREDIT_DEV_ENV`). Default
   * **off**: `server/index.ts` turns it on from `SCAV_DEV_ECONOMY=1` (only the relay `scripts/verify.mjs` starts itself — `npm run dev:all` keeps it off); `tool.ts`
   * (shipped exe) and the desktop shell's embedded relay never do.
   */
  devEconomy?: boolean;
  /** 2026-09-11 (E-4 ⑦): the economy table (default: the committed `economy.gen.json`). Selftest only. */
  economyTable?: EconomyTable;
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
  /* 2026-09-11 (C-29) — 서버 콘솔 관리 (`server/tool.ts`). 밴은 없다: 쫓겨난 사람이 다시 붙는 것은 막지 않는다. */
  /** Every connected socket, oldest first. */
  listClients(): RelayClientInfo[];
  /**
   * Disconnect `idOrCode` (a PeerId, or an 아이디 typed with or without the dash) **without a reconnect grace**: the
   * lobby slot is removed at once (`peer:left`, host migrated like an ordinary leave), then `lobby:error kicked` and a
   * close with `CLOSE_KICKED`. A member that is only sitting in its grace (no socket) just loses the slot.
   */
  kick(idOrCode: string, reason?: string): RelayKickResult;
  /**
   * Connection cap for **new** sockets (`null` / ≤ 0 = unlimited). Over the cap a connection gets
   * `lobby:error server_full` and is closed before its welcome — except a socket whose id is still a lobby member
   * (a reconnect inside the grace, or a page reload replacing its own socket). Lowering it kicks nobody.
   */
  setMaxClients(n: number | null): void;
  readonly maxClients: number | null;
  /**
   * 2026-09-11 (B-2): one profile GC pass now (`ProfileStore.collectGarbage`) — a connected socket or a lobby member is
   * never collected. Connected players whose social lists changed get a fresh `social:state` and rebuilt watches.
   * `now` is for the selftest.
   */
  collectGarbage(now?: number): ProfileGcReport;
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
  if (text.length > MAX_TX_FRAME_BYTES) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!isRecord(parsed) || typeof parsed.t !== 'string') return null;
  const m = parsed;
  // Only the two document uploads may exceed the ordinary cap (their payload is checked against the doc caps later).
  if (text.length > MAX_MESSAGE_BYTES && m.t !== 'profile:set' && m.t !== 'raid:save' && m.t !== 'profile:setMany') return null;
  // E-6: only a transaction may use the larger `MAX_TX_FRAME_BYTES` (the socket's maxPayload).
  if (text.length > MAX_DOC_FRAME_BYTES && m.t !== 'profile:setMany') return null;
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
      if (m.mode !== undefined && (typeof m.mode !== 'string' || !MISSION_MODES.has(m.mode))) return null;
      /* Phase 11: an unknown planet id is refused here rather than silently dropped. */
      if (m.planet !== undefined && !isPlanetId(m.planet)) return null;
      const out: ClientToServer = { t: 'lobby:start', seed: m.seed };
      if (m.mode !== undefined) out.mode = m.mode as MissionMode;
      if (m.planet !== undefined) out.planet = m.planet as PlanetId;
      return out;
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
    case 'profile:set': {
      // Key validity is answered with `invalid` by the handler (so a wrong key is reported, not silently dropped).
      if (typeof m.key !== 'string' || !('doc' in m)) return null;
      if (m.at !== undefined && (typeof m.at !== 'number' || !Number.isFinite(m.at))) return null;
      if (m.fresh !== undefined && typeof m.fresh !== 'boolean') return null;
      const out: ClientToServer = { t: 'profile:set', key: m.key as never, doc: m.doc };
      if (typeof m.at === 'number') out.at = m.at;
      if (m.fresh === true) out.fresh = true;
      /* E-6: a revision write. A malformed `baseRev` still reaches the handler (as -1) so it is refused *with* its writeId. */
      if (m.writeId !== undefined && (typeof m.writeId !== 'string' || m.writeId.length === 0 || m.writeId.length > PROFILE_WRITE_ID_MAX)) return null;
      if (typeof m.writeId === 'string') out.writeId = m.writeId;
      if (m.baseRev !== undefined) out.baseRev = typeof m.baseRev === 'number' && Number.isInteger(m.baseRev) && m.baseRev >= 0 ? m.baseRev : -1;
      return out;
    }
    /* E-6: a transaction. Only the envelope is checked here; every entry is judged (all or nothing) by the store. */
    case 'profile:setMany':
      return typeof m.txId === 'string' && m.txId.length > 0 && m.txId.length <= PROFILE_WRITE_ID_MAX && isRecord(m.docs)
        ? { t: 'profile:setMany', txId: m.txId, docs: m.docs as never } : null;
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
    /* appended: Phase 11 — 목표 행성 + 소셜. Shapes only; every social rule is the handler's (and the store's). */
    case 'lobby:planet':
      return isPlanetId(m.planet) ? { t: 'lobby:planet', planet: m.planet } : null;
    case 'social:get':
      return { t: 'social:get' };
    case 'social:me':
      return typeof m.level === 'number' && Number.isFinite(m.level) ? { t: 'social:me', level: m.level } : null;
    case 'social:request':
      return validSocialCode(m.code) ? { t: 'social:request', code: m.code as string } : null;
    case 'social:respond':
      return validSocialCode(m.code) && typeof m.accept === 'boolean'
        ? { t: 'social:respond', code: m.code as string, accept: m.accept } : null;
    case 'social:remove':
      return validSocialCode(m.code) ? { t: 'social:remove', code: m.code as string } : null;
    case 'social:play':
      return validSocialCode(m.code) ? { t: 'social:play', code: m.code as string } : null;
    case 'social:whisper': {
      if (!validSocialCode(m.code) || typeof m.text !== 'string' || m.text.length > MAX_WHISPER_INPUT) return null;
      /* B-4: `nonce` (optional) asks for a `social:whisperAck`; a present but non-numeric one is a malformed frame. */
      if (m.nonce !== undefined && (typeof m.nonce !== 'number' || !Number.isFinite(m.nonce))) return null;
      const out: ClientToServer = { t: 'social:whisper', code: m.code as string, text: m.text };
      if (typeof m.nonce === 'number') out.nonce = m.nonce;
      return out;
    }
    /* appended: 2026-09-11 — B-3 초대 응답 · B-4 차단. Shapes only. */
    case 'social:inviteReply':
      return typeof m.id === 'string' && m.id.length > 0 && m.id.length <= MAX_INVITE_ID_INPUT && typeof m.accept === 'boolean'
        ? { t: 'social:inviteReply', id: m.id, accept: m.accept } : null;
    case 'social:block':
      return validSocialCode(m.code) && typeof m.blocked === 'boolean'
        ? { t: 'social:block', code: m.code as string, blocked: m.blocked } : null;
    /* appended: 2026-09-09 — 분대장 지명 이관. 규칙은 전부 핸들러가 본다; 여기서는 모양만. */
    case 'lobby:transferHost': {
      if (typeof m.targetId !== 'string' || m.targetId.length === 0 || m.targetId.length > MAX_CODE_INPUT) return null;
      if (m.claim !== undefined && typeof m.claim !== 'boolean') return null;
      const out: ClientToServer = { t: 'lobby:transferHost', targetId: m.targetId };
      if (m.claim === true) out.claim = true;
      return out;
    }
    case 'lobby:hostDown':
      return typeof m.down === 'boolean' ? { t: 'lobby:hostDown', down: m.down } : null;
    default:
      return null;
  }
}

/** A typed-in 아이디 arrives dashed / lower case; only the shape is checked here (`normalizePlayerCode` follows). */
function validSocialCode(v: unknown): boolean {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_CODE_INPUT;
}

/** One whisper line: control characters and markup out, `SOCIAL_WHISPER_MAX` characters kept. */
function sanitizeWhisper(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const cc = ch.codePointAt(0) ?? 0;
    if (cc < 0x20 || cc === 0x7f) { out += ' '; continue; }  // control characters
    if (ch === '<' || ch === '>') continue;                  // markup
    out += ch;
  }
  return out.trim().slice(0, SOCIAL_WHISPER_MAX);
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

/** C-29: a usable connection cap, or null (= unlimited) for anything that is not a positive number. */
function normalizeMax(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
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
  /* E-4 (⑦): credits:tx rules. `devEconomy` only from `server/index.ts` (env) — the shipped exe / desktop shell never pass it. */
  const economy = new CreditEconomy(opts.economyTable ?? ECONOMY_TABLE, { dev: opts.devEconomy === true });
  log(`economy table ${economy.table.hash}${economyTableIntact(economy.table) ? '' : ' (digest mismatch — regenerate with npm run data:check -- --write)'} · ${Object.keys(economy.table.items).length} items · dev reasons ${economy.dev ? 'ON' : 'off'}`);
  const lobbies = new LobbyManager();
  const clients = new Map<PeerId, Client>();
  /** C-29: `null` = unlimited. */
  let maxClients: number | null = normalizeMax(opts.maxClients);
  /** Lobby members whose socket is down: id → grace timer that removes them. */
  const graceTimers = new Map<PeerId, ReturnType<typeof setTimeout>>();
  /** Started lobbies whose host dropped: lobby code → timer that migrates the host role (Phase 7). */
  const migrateTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const http = createServer((req, res) => {
    const url = req.url ?? '/';
    if (req.method === 'GET' && (url === '/health' || url.startsWith('/health?'))) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ ok: true, lobbies: lobbies.count, clients: clients.size, pendingReconnects: graceTimers.size, profiles: store.size, uptime: Math.round(process.uptime()), maxClients, devEconomy: economy.dev, economy: economy.table.hash }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('SCAVANGER relay: websocket at ' + NET_WS_PATH);
  });

  const wss = new WebSocketServer({ server: http, path: NET_WS_PATH, maxPayload: MAX_TX_FRAME_BYTES, perMessageDeflate: false });

  /* ── outbound helpers ─────────────────────────────────────────────────── */
  const sendTo = (c: Client, msg: ServerToClient): void => {
    if (c.ws.readyState !== WebSocket.OPEN) return;
    try { c.ws.send(JSON.stringify(msg)); } catch (e) { log(`send failed to ${c.id}: ${(e as Error).message}`); }
  };
  const sendError = (c: Client, code: LobbyErrorCode, message?: string): void => {
    sendTo(c, { t: 'lobby:error', code, message: message ?? LOBBY_ERROR_MESSAGE_KO[code] });
  };
  /** 2026-09-11 (E-6): the one answer to a revision write — `profile:ack` / `profile:conflict` / `profile:refused`, tagged with its id. */
  const replyProfileWrite = (c: Client, tag: { writeId?: string; txId?: string }, res: RevWriteResult): void => {
    const id = tag.writeId !== undefined ? { writeId: tag.writeId } : tag.txId !== undefined ? { txId: tag.txId } : {};
    if (res.kind === 'ack') sendTo(c, { t: 'profile:ack', ...id, revs: res.revs });
    else if (res.kind === 'conflict') sendTo(c, { t: 'profile:conflict', ...id, docs: res.docs });
    else sendTo(c, { t: 'profile:refused', ...id, code: res.code });
    if (res.kind !== 'ack' || !res.replay) log(`profile ${c.id}: ${tag.txId !== undefined ? `tx ${tag.txId}` : `write ${tag.writeId ?? '-'}`} → ${res.kind}${res.kind === 'ack' ? ` ${JSON.stringify(res.revs)}` : res.kind === 'conflict' ? ` ${Object.keys(res.docs).join(',')}` : ` ${res.code}`}`);
  };
  const broadcast =(lobby: Lobby, msg: ServerToClient, except?: PeerId): void => {
    const text = JSON.stringify(msg);
    for (const id of lobby.players.keys()) {
      if (id === except) continue;
      const c = clients.get(id);
      if (!c || c.ws.readyState !== WebSocket.OPEN) continue;
      try { c.ws.send(text); } catch { /* peer is going away; heartbeat will reap it */ }
    }
  };
  /**
   * Phase 11: every `LobbyState` that leaves the server carries each member's 아이디 + level from the profile store.
   * `Lobby` itself knows nothing about the store (it is pure data), so the decoration happens here — one place every
   * emitter goes through. Anonymous members simply have neither field.
   */
  const lobbyState = (lobby: Lobby): LobbyState => {
    const state: LobbyState = lobby.toState();
    for (const p of state.players) {
      const card = store.card(p.id);
      if (!card) continue;
      p.code = card.code;
      if (card.level > 0) p.level = card.level;
    }
    return state;
  };
  const broadcastState = (lobby: Lobby): void => {
    broadcast(lobby, { t: 'lobby:state', lobby: lobbyState(lobby) });
  };

  /* ── Phase 11: presence + the out-of-lobby push channel ───────────────── */
  /**
   * Presence is only a fold of what the relay already knows: no socket → `offline` (a member inside the reconnect
   * grace is gone *now*), inside a started mission → `raid` / `training`, anything else (personal ship, shared ship,
   * docking, title) → `ship`. `squad` is their lobby's size — slots held by disconnected members count as taken.
   */
  const presenceOf = (id: PeerId): { presence: PresenceState; squad: number } => {
    if (!clients.has(id)) return { presence: 'offline', squad: 0 };
    const lobby = lobbies.lobbyOf(id);
    if (!lobby) return { presence: 'ship', squad: 0 };
    const inside = lobby.started && (lobby.get(id)?.inMission ?? false);
    const presence: PresenceState = inside ? (lobby.mode === 'training' ? 'training' : 'raid') : 'ship';
    return { presence, squad: lobby.size };
  };

  /** One resolved row. null when the 아이디 has no profile any more — the caller then skips it. */
  const resolveRow = (viewer: PeerId, mySquad: number, code: PlayerCode, at?: number): SocialPlayer | null => {
    const id = store.peerByCode(code);
    if (id === undefined) return null;
    const card = store.card(id);
    if (!card) return null;
    const { presence, squad } = presenceOf(id);
    const row: SocialPlayer = {
      code: card.code, name: card.name, level: card.level, presence, squad,
      joinable: playBlockReason({ presence, squad }, mySquad, NET_MAX_PLAYERS, id === viewer) === null,
    };
    if (at !== undefined) row.at = at;
    /* B-3 배지: my invite to them is still open (a hidden one too — for me it is an ordinary unanswered invite). */
    const inv = invites.pair(viewer, id);
    if (inv) row.inviteAt = inv.at;
    return row;
  };

  /**
   * The whole ESC social screen for one profile, resolved from codes only: a client never learns another player's
   * PeerId. null for a connection without a profile (anonymous socket).
   */
  const buildSnapshot = (id: PeerId): SocialSnapshot | null => {
    const soc = store.social(id);
    if (!soc) return null;
    const mySquad = lobbies.lobbyOf(id)?.size ?? 0;
    const rows = (codes: readonly PlayerCode[]): SocialPlayer[] => {
      const out: SocialPlayer[] = [];
      for (const code of codes) { const r = resolveRow(id, mySquad, code); if (r) out.push(r); }
      return out;
    };
    const recent: SocialPlayer[] = [];
    for (const e of soc.recent) { const r = resolveRow(id, mySquad, e.code, e.at); if (r) recent.push(r); }
    /* B-4: the block list is cards only — no presence for someone I blocked. */
    const blocked: SocialCard[] = [];
    for (const code of soc.blocked ?? []) {
      const other = store.peerByCode(code);
      const card = other === undefined ? null : store.card(other);
      if (card) blocked.push(card);
    }
    return {
      me: { code: soc.code, name: soc.name, level: soc.level },
      friends: rows(soc.friends), incoming: rows(soc.incoming), outgoing: rows(soc.outgoing), recent, blocked,
    };
  };

  /**
   * `broadcast()` only reaches a lobby, so a friend sitting in their own personal ship would never hear about a
   * presence change. These two indexes are the missing channel: `watchers` = subject → connected clients that have
   * the subject in **any** of their four lists (2026-09-11, B-5 — friends · incoming · outgoing · recent; it used to be
   * friends only, so a request or a 최근 만난 플레이어 row showed a stale presence), `watching` = its reverse so a disconnect
   * costs O(rows). Nothing polls.
   */
  const watchers = new Map<PeerId, Set<PeerId>>();
  const watching = new Map<PeerId, Set<PeerId>>();

  const unwatchAll = (id: PeerId): void => {
    const subs = watching.get(id);
    if (subs === undefined) return;
    for (const s of subs) {
      const set = watchers.get(s);
      if (!set) continue;
      set.delete(id);
      if (set.size === 0) watchers.delete(s);
    }
    watching.delete(id);
  };

  /**
   * (Re)build one connected client's watch entries from all four of its lists (connect, and after anything that
   * changes a list: request · respond · remove · block · 최근 만난 플레이어 · GC).
   */
  const rewatch = (id: PeerId): void => {
    unwatchAll(id);
    if (!clients.has(id)) return;
    const soc = store.social(id);
    if (!soc) return;
    const subs = new Set<PeerId>();
    const add = (code: PlayerCode): void => {
      const other = store.peerByCode(code);
      if (other === undefined || other === id || subs.has(other)) return;
      subs.add(other);
      let set = watchers.get(other);
      if (set === undefined) { set = new Set<PeerId>(); watchers.set(other, set); }
      set.add(id);
    };
    for (const code of soc.friends) add(code);
    for (const code of soc.incoming) add(code);
    for (const code of soc.outgoing) add(code);
    for (const e of soc.recent) add(e.code);
    if (subs.size > 0) watching.set(id, subs);
  };

  /** Send `id` its snapshot right now (no-op for a socket without a profile). Only the coalescer calls this. */
  const sendSocial = (id: PeerId): void => {
    const c = clients.get(id);
    if (!c || !c.hasProfile) return;
    const snap = buildSnapshot(id);
    if (snap) sendTo(c, { t: 'social:state', social: snap });
  };
  /* B-5: every push goes through one coalescer — a viewer gets at most one snapshot per window. */
  const pushes = new PushCoalescer({ send: sendSocial, windowMs: opts.socialPushCoalesceMs });
  /** `id`'s snapshot is stale: it goes out with the next coalescing window. */
  const pushSocial = (id: PeerId): void => { if (clients.get(id)?.hasProfile) pushes.mark(id); };
  /** A direct answer to `id`'s own request: sent now (and not again when the window closes). */
  const pushSocialNow = (id: PeerId): void => { pushes.now(id); };
  /** Everyone who has `id` in one of their lists learns about it (the subject itself excluded). */
  const notifyWatchers = (id: PeerId): void => {
    const set = watchers.get(id);
    if (set === undefined) return;
    for (const w of set) if (w !== id) pushSocial(w);
  };
  /** `id` moved (connected / disconnected / joined / left / entered a mission / picked a planet). */
  const pushPresence = (id: PeerId): void => { pushSocial(id); notifyWatchers(id); };
  /** A whole squad moved at once (start, reset, membership, 목표 행성). */
  const pushLobbyPresence = (lobby: Lobby): void => { for (const id of lobby.players.keys()) pushPresence(id); };

  const socialError = (c: Client, code: SocialErrorCode): void => {
    sendTo(c, { t: 'social:error', code, message: SOCIAL_ERROR_MESSAGE_KO[code] });
  };
  /** My own social record, or null when this connection has no profile (anonymous → `unavailable`). */
  const socialOf = (c: Client) => (c.hasProfile ? store.ensureSocial(c.id, c.name) : null);
  /** `PlayerCode` → PeerId for an incoming request; undefined for an unknown / malformed 아이디. */
  const peerOfCode = (raw: string): { code: PlayerCode; id: PeerId } | null => {
    const code = normalizePlayerCode(raw);
    if (!code) return null;
    const id = store.peerByCode(code);
    return id === undefined ? null : { code, id };
  };

  /**
   * 최근 만난 플레이어: a join put two or more profiles in the same ship, so each pair remembers the other (unless
   * they are already friends). Mutation only — the caller broadcasts the fresh snapshots.
   */
  const recordMet = (lobby: Lobby, joiner: PeerId): void => {
    if (!store.social(joiner)) return;
    let any = false;
    for (const id of lobby.players.keys()) {
      if (id === joiner || !store.social(id)) continue;
      if (store.recordMet(joiner, id)) { rewatch(id); any = true; }   // B-5: the new recent row is watched at once
    }
    if (any) rewatch(joiner);
  };

  /* ── 2026-09-11 (B-11): 차단한 사이는 같은 분대에 서지 않는다 ─────────────────── */
  /**
   * true when the profile `owner` has blocked `other`. 차단 is kept **by 아이디**, so a profile without a social
   * record (anonymous, or one that never connected with a token) can neither block nor be blocked.
   */
  const blocks = (owner: PeerId, other: PeerId): boolean => {
    const code = store.card(other)?.code;
    return code !== undefined && store.isBlocked(owner, code);
  };

  /**
   * Why `joiner` must not be put into `lobby` because of a 차단, or null. **Direction decides the answer** (사용자 결정):
   *
   * - a member `joiner` has blocked → `'blocked'`: it is my own choice, so it is told plainly.
   * - a member who has blocked `joiner` → `'not_found'`: a 차단 must never show through, and being indistinguishable
   *   from a mistyped code is exactly the point (the invite path hides it the same way, `Invites.ts` `hidden`).
   *
   * My own direction wins when both are present — it is the one the player can act on. Callers ask this **before**
   * the join really happens, so a refusal leaves no trace in the lobby.
   */
  const blockRefusal = (lobby: Lobby, joiner: PeerId): 'blocked' | 'not_found' | null => {
    if (store.card(joiner) === null) return null;
    let hidden = false;
    for (const other of lobby.players.keys()) {
      if (other === joiner) continue;
      if (blocks(joiner, other)) return 'blocked';
      if (blocks(other, joiner)) hidden = true;
    }
    return hidden ? 'not_found' : null;
  };

  /* ── 2026-09-11 (B-3): 초대 표 — every invite closes exactly once, through `closeInvite`, which tells both sides ── */
  const inviteCode = (id: PeerId): PlayerCode => store.card(id)?.code ?? '';
  const inviteName = (id: PeerId): string => store.card(id)?.name ?? '';

  /**
   * Close `inv` with `outcome` and tell both sides: the inviter `social:inviteResult`, the invitee `social:inviteClosed`
   * — except when the invitee is the one answering (`toldInvitee`: its own reply needs no echo) and for a hidden invite
   * (the invitee never saw it). The inviter's rows lose their `inviteAt` badge on the next push. false = already closed.
   */
  const closeInvite = (inv: OpenInvite, outcome: InviteOutcome, reason?: SocialErrorCode, toldInvitee = false): boolean => {
    if (!invites.remove(inv)) return false;
    const from = clients.get(inv.from);
    if (from) {
      const res: ServerToClient = { t: 'social:inviteResult', id: inv.id, code: inviteCode(inv.to), name: inviteName(inv.to), outcome };
      if (reason !== undefined) res.reason = reason;
      sendTo(from, res);
      pushSocial(inv.from);
    }
    const to = clients.get(inv.to);
    if (to && !toldInvitee && !inv.hidden) {
      const closed: ServerToClient = { t: 'social:inviteClosed', id: inv.id, outcome };
      if (reason !== undefined) closed.reason = reason;
      sendTo(to, closed);
    }
    log(`social: invite ${inv.id} ${inviteCode(inv.from)} → ${inviteCode(inv.to)} ${outcome}${reason ? ` (${reason})` : ''}${inv.hidden ? ' [hidden]' : ''}`);
    return true;
  };

  const invites = new InviteTable({ ttlMs: opts.inviteTtlMs, onExpire: (inv) => { closeInvite(inv, 'expired'); } });

  /**
   * Every open invite whose ship can no longer take the invitee is closed `failed`: the lobby is gone or the inviter is
   * no longer in it (`not_found`), it filled up (`full`), a raid started (`in_mission`). Called after every lobby event
   * that can cause one of those (leave · grace expiry · kick · join · quick match · move · start). A training keeps its
   * lobby joinable, so its invites stay open.
   */
  const sweepInvites = (): void => {
    for (const inv of invites.all()) {
      const lobby = lobbies.byCode(inv.lobby);
      if (!lobby || !lobby.has(inv.from)) { closeInvite(inv, 'failed', 'not_found'); continue; }
      const refused = lobby.canAdd();
      if (refused === 'full') closeInvite(inv, 'failed', 'full');
      else if (refused === 'started') closeInvite(inv, 'failed', 'in_mission');
    }
  };

  /** `joiner` is in `lobby` now (any path — an old client's `lobby:join` too): invites into it are answered. */
  const settleInvitesInto = (joiner: PeerId, lobby: Lobby, toldInvitee: boolean): void => {
    for (const inv of invites.toPeer(joiner, true)) if (inv.lobby === lobby.code) closeInvite(inv, 'accepted', undefined, toldInvitee);
  };

  /** `LobbyManager.move` refusal → the `social:error` the contract names for it. */
  const moveErrorCode = (code: LobbyErrorCode): SocialErrorCode =>
    code === 'full' ? 'full' : code === 'started' ? 'in_mission' : code === 'not_found' ? 'not_found' : code === 'in_lobby' ? 'in_squad' : 'invalid';

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

  /**
   * A started lobby whose last member left the mission (`inMission` all false) is closed by the server: a training
   * as in Phase 7, and (Phase 9) a raid as well — nobody is inside it any more, a parked host would never return to
   * it. Returns true when it reset (a not-started lobby → false).
   */
  const autoResetMission = (lobby: Lobby): boolean => {
    if (!lobby.started || lobby.inMissionCount() > 0) return false;
    const kind = lobby.mode ?? 'raid';
    lobby.reset();
    clearMigrate(lobby.code);
    log(`lobby ${lobby.code}: ${kind} ended (last member left) → reset`);
    // The reset reopened the hub rules: a dropped host hands over at once again.
    if (lobby.migrateHost()) log(`lobby ${lobby.code}: host now ${lobby.hostId} (hub rule after reset)`);
    return true;
  };

  /**
   * Phase 9: a connected host that is no longer inside the running mission (page reload → `lobby:mission false`)
   * must not keep the authority — hand it to a connected in-mission member when there is one.
   */
  const migrateHostAway = (lobby: Lobby, id: PeerId): boolean => {
    if (!lobby.started || lobby.hostId !== id) return false;
    if (!lobby.migrateHost(true)) return false;
    clearMigrate(lobby.code);
    log(`lobby ${lobby.code}: host ${id} left the mission → host now ${lobby.hostId}`);
    return true;
  };

  /**
   * What the rest of a lobby hears after `id` was taken out of it (`LobbyManager.leave` / `move` already ran):
   * `peer:left`, an auto-reset of a mission nobody is inside any more, the presence pushes, and (B-3) every invite that
   * pointed at the lobby or was sent by the leaver is re-checked.
   */
  const announceLeave = (
    id: PeerId, name: string, reason: 'leave' | 'timeout' | 'kick' | 'moved',
    res: { lobby: Lobby; hostMigrated: boolean; deleted: boolean }, wasStarted: boolean,
  ): void => {
    const { lobby, hostMigrated, deleted } = res;
    const ended = wasStarted && !lobby.started;
    log(`lobby ${lobby.code}: ${name}(${id}) ${reason}${ended ? ' → mission over (nobody inside) → reset' : ''}${hostMigrated ? ` → host now ${lobby.hostId}` : ''}${deleted ? ' → lobby deleted' : ''}`);
    if (deleted) { clearMigrate(lobby.code); pushPresence(id); sweepInvites(); return; }
    if (hostMigrated || ended) clearMigrate(lobby.code);
    broadcast(lobby, { t: 'peer:left', id, lobby: lobbyState(lobby) });
    if (autoResetMission(lobby) || ended) broadcastState(lobby);
    /* Phase 11: the leaver's squad shrank to nothing and the rest of the squad got smaller. */
    pushPresence(id);
    pushLobbyPresence(lobby);
    sweepInvites();
  };

  /** Final removal (explicit leave or grace expiry): `peer:left` to the rest, empty lobby deleted. */
  const removeFromLobby = (id: PeerId, name: string, reason: 'leave' | 'timeout' | 'kick'): void => {
    clearGrace(id);
    const wasStarted = lobbies.lobbyOf(id)?.started ?? false;
    const res = lobbies.leave(id);
    if (!res) return;
    announceLeave(id, name, reason, res, wasStarted);
  };

  /**
   * 2026-09-11 (B-6): move a connected client into lobby `toCode` **atomically** (`LobbyManager.move` — the target is
   * checked before the old lobby is touched, a refusal changes nothing). On success the old lobby hears an ordinary
   * leave, the mover gets `lobby:left {reason:'moved', to}` (only when it had a lobby to leave) and then, with the new
   * squad, the new `lobby:state`. Rules about the mover itself (squad in tow, inside a mission) are the caller's.
   */
  const moveToLobby = (
    c: Client, toCode: string, why: string, answering?: OpenInvite,
  ): { ok: true; lobby: Lobby } | { ok: false; code: SocialErrorCode } => {
    clearGrace(c.id);
    const wasStarted = lobbies.lobbyOf(c.id)?.started ?? false;
    const res = lobbies.move(c.id, toCode, c.name);
    if (!res.ok) return { ok: false, code: moveErrorCode(res.code) };
    /*
     * B-3: answered invites first — every sweep from here on (the old lobby's leave included) would otherwise read
     * "the ship I just filled is full" as a failure of the very invite being accepted.
     */
    if (answering) closeInvite(answering, 'accepted', undefined, true);
    settleInvitesInto(c.id, res.to, false);
    if (res.from) {
      announceLeave(c.id, c.name, 'moved', { lobby: res.from, hostMigrated: res.hostMigrated, deleted: res.fromDeleted }, wasStarted);
      sendTo(c, { t: 'lobby:left', reason: 'moved', to: res.to.code });
    }
    log(`lobby ${res.to.code}: ${c.name}(${c.id}) moved in (${why}, ${res.to.size} players)`);
    recordMet(res.to, c.id);
    broadcastState(res.to);
    pushLobbyPresence(res.to);
    sweepInvites();
    return { ok: true, lobby: res.to };
  };

  /**
   * B-3: `c` invites `targetId` into `lobby`. The pair's previous invite is `superseded`, the oldest visible invite past
   * the invitee's `SQUAD_INVITE_MAX` is closed (`failed` / `limit`), and — unless `hidden` (B-4: they blocked me) — the
   * invitee gets `social:invited` with the invite id. My rows get the `inviteAt` badge at once (my own action).
   */
  const openInvite = (c: Client, from: SocialCard, targetId: PeerId, lobby: Lobby, hidden: boolean): OpenInvite => {
    const prev = invites.pair(c.id, targetId);
    if (prev) closeInvite(prev, 'superseded');
    if (!hidden) {
      const visible = invites.toPeer(targetId);
      while (visible.length >= SQUAD_INVITE_MAX) {
        const oldest = visible.shift();
        if (oldest) closeInvite(oldest, 'failed', 'limit');
      }
    }
    const inv = invites.add(c.id, targetId, lobby.code, Date.now(), hidden);
    const tc = clients.get(targetId);
    if (tc && !hidden) sendTo(tc, { t: 'social:invited', invite: { id: inv.id, from: from.code, name: from.name, lobby: lobby.code, at: inv.at } });
    log(`social: ${from.code} invited ${inviteCode(targetId)} to ${lobby.code} (invite ${inv.id})${hidden ? ' [hidden: blocked]' : ''}`);
    pushSocialNow(c.id);
    return inv;
  };

  /**
   * Socket of a lobby member went away: keep the slot, flag it, arm the grace timer (`armGrace` — inside a running
   * raid the slot is kept for the whole mission). Host role: not started (hub) →
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
    /* B-5: the dropped member reads offline and the squad's rows change for everyone watching them (coalesced). */
    pushLobbyPresence(lobby);
    if (hostDropped) {
      clearMigrate(lobby.code);
      const timer = setTimeout(() => {
        migrateTimers.delete(lobby.code);
        if (lobbies.byCode(lobby.code) !== lobby || !lobby.started) return;
        if (lobby.migrateHost()) {
          log(`lobby ${lobby.code}: host ${c.id} still down after ${migrateMs} ms → host now ${lobby.hostId}`);
          broadcastState(lobby);
        } else {
          // Phase 9: nobody connected inside the mission → the role is parked until an in-mission member reconnects.
          log(`lobby ${lobby.code}: host ${c.id} still down after ${migrateMs} ms, no connected in-mission member → host parked`);
        }
      }, migrateMs);
      timer.unref();
      migrateTimers.set(lobby.code, timer);
    }
    armGrace(c);
  };

  /**
   * Arm (or re-arm) the reconnect-grace timer for a disconnected lobby member.
   *
   * 2026-09-07: a member who dropped **inside a running raid** keeps their slot for as long as the raid lasts, not
   * just `graceMs` — the host holds their body as a ghost and a reconnect drops straight back into it, so reaping
   * the slot at 5 minutes was throwing the run away mid-mission. The timer simply re-arms while
   * `started && raid && inMission && another connected member is still inside`; that last clause keeps an abandoned
   * lobby from living forever — when the expiring member was the last one in the raid the slot is reaped exactly as
   * before, which ends the mission and migrates the host.
   * The host role does **not** wait for that: it still moves at the first expiry (on top of the `migrateMs` path),
   * so the squad never sits without an authority.
   */
  const armGrace = (c: Client): void => {
    clearGrace(c.id);
    const timer = setTimeout(() => {
      graceTimers.delete(c.id);
      // Reconnected in the meantime (timer should have been cleared, but be safe).
      if (clients.has(c.id)) return;
      const lobby = lobbies.lobbyOf(c.id);
      const me = lobby?.get(c.id);
      // A 훈련장 is entered and left individually and holds no body — only a **raid** keeps the slot, and only while
      // somebody else is still actually inside it (the last member inside expiring ends the mission, as before).
      let othersInside = 0;
      if (lobby) for (const p of lobby.players.values()) if (p.id !== c.id && p.connected && p.inMission) othersInside++;
      if (lobby && me && lobby.started && lobby.mode !== 'training' && me.inMission && othersInside > 0) {
        if (lobby.hostId === c.id && lobby.migrateHost()) {
          log(`lobby ${lobby.code}: host ${c.id} still down after ${graceMs} ms → host now ${lobby.hostId} (slot kept: raid running)`);
          broadcastState(lobby);
        }
        armGrace(c);
        return;
      }
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
        pushPresence(c.id);
        return;
      }

      case 'lobby:quickmatch': {
        c.name = sanitizePlayerName(m.name);
        /* B-11: a lobby holding a 차단 (either direction) is not a candidate — all filtered out → a new lobby. */
        const res = lobbies.quickMatch(c.id, c.name, (l) => blockRefusal(l, c.id) === null);
        if (typeof res === 'string') { sendError(c, res); return; }
        log(`lobby ${res.lobby.code}: quickmatch ${res.created ? 'created (public)' : `joined (${res.lobby.size} players)`} by ${c.name}(${c.id})`);
        if (!res.created) recordMet(res.lobby, c.id);
        broadcastState(res.lobby);
        pushLobbyPresence(res.lobby);
        if (!res.created) { settleInvitesInto(c.id, res.lobby, false); sweepInvites(); }   // B-3: it may be full now
        return;
      }

      case 'lobby:join': {
        const code = normalizeLobbyCode(m.code);
        if (!isValidLobbyCode(code)) { sendError(c, 'invalid', '잘못된 로비 코드입니다.'); return; }
        c.name = sanitizePlayerName(m.name);
        /* B-11: 차단 is checked **before** `lobbies.join`, so a refusal never touches the lobby. */
        const target = lobbies.byCode(code);
        if (target && !lobbies.lobbyOf(c.id)) {
          const refused = blockRefusal(target, c.id);
          if (refused !== null) { sendError(c, refused); return; }
        }
        const res = lobbies.join(c.id, code, c.name);
        if (typeof res === 'string') { sendError(c, res); return; }
        log(`lobby ${code}: ${c.name}(${c.id}) joined (${res.size} players)`);
        recordMet(res, c.id);
        broadcastState(res);
        pushLobbyPresence(res);
        /* B-3: an older client accepts an invite with a plain `lobby:join` — that answers it too; the ship may be full now. */
        settleInvitesInto(c.id, res, false);
        sweepInvites();
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
        if (lobby.started) { sendTo(c, { t: 'lobby:state', lobby: lobbyState(lobby) }); return; }
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
          // A training has no 목표 행성 (the arena is not on a planet), so `planet` is ignored here.
          lobby.start(m.seed, 'training', c.id);
          log(`lobby ${lobby.code}: training started seed=${m.seed} by ${c.name}(${c.id})`);
          broadcast(lobby, { t: 'game:start', seed: m.seed, lobby: lobbyState(lobby), mode: 'training' });
          pushLobbyPresence(lobby);
          return;
        }
        if (lobby.hostId !== c.id) { sendError(c, 'not_host'); return; }
        if (!lobby.allReady()) { sendError(c, 'not_ready'); return; }
        /* Phase 11: a raid needs a destination — the message's planet, or the one already picked (`lobby:planet`). */
        const planet: PlanetId | null = m.planet ?? lobby.planet;
        if (planet === null) { sendError(c, 'no_planet'); return; }
        lobby.planet = planet;
        lobby.start(m.seed, 'raid', c.id);
        log(`lobby ${lobby.code}: started seed=${m.seed} planet=${planet} players=${lobby.size} (${lobby.connectedCount()} connected)`);
        broadcast(lobby, { t: 'game:start', seed: m.seed, lobby: lobbyState(lobby), mode: 'raid', planet });
        pushLobbyPresence(lobby);
        sweepInvites();   // B-3: a raid closes the ship → its open invites fail (in_mission)
        return;
      }

      case 'lobby:reset': {
        const lobby = lobbies.lobbyOf(c.id);
        if (!lobby) { sendError(c, 'not_in_lobby'); return; }
        if (lobby.hostId !== c.id) { sendError(c, 'not_host'); return; }
        lobby.reset(); // Phase 11: keeps `planet` — the destination outlives the mission
        clearMigrate(lobby.code);
        log(`lobby ${lobby.code}: reset (reopened)`);
        broadcastState(lobby);
        pushLobbyPresence(lobby);
        return;
      }

      /* appended: Phase 11 */
      case 'lobby:planet': {
        const lobby = lobbies.lobbyOf(c.id);
        if (!lobby) { sendError(c, 'not_in_lobby'); return; }
        if (lobby.hostId !== c.id) { sendError(c, 'not_host'); return; }
        if (lobby.started) { sendError(c, 'started'); return; }
        if (lobby.planet === m.planet) { sendTo(c, { t: 'lobby:state', lobby: lobbyState(lobby) }); return; }
        lobby.planet = m.planet;
        log(`lobby ${lobby.code}: planet=${m.planet} (by ${c.name})`);
        // No travel message exists: every member starts the cutscene off its own copy of `LobbyState.planet`.
        broadcastState(lobby);
        pushLobbyPresence(lobby);
        return;
      }

      /* appended: 2026-09-09 — 분대장(호스트) 지명 이관 */
      case 'lobby:transferHost': {
        const lobby = lobbies.lobbyOf(c.id);
        if (!lobby) { sendError(c, 'not_in_lobby'); return; }
        /*
         * 허용되는 두 경우뿐이다: ① 보낸 사람이 지금 호스트다, ② `claim` 이고 현재 호스트가 `lobby:hostDown`
         * 으로 사망 표시를 켜 두었다 (시체 옆의 분대장 기기를 집은 사람). 그 외에는 `not_host`.
         */
        const isHost = lobby.hostId === c.id;
        const claiming = m.claim === true && lobby.hostDown && !isHost;
        if (!isHost && !claiming) { sendError(c, 'not_host'); return; }
        const target = lobby.get(m.targetId);
        if (!target || !target.connected) { sendError(c, 'invalid', '분대에 없는(또는 접속이 끊긴) 대원입니다.'); return; }
        if (lobby.hostId === m.targetId) {
          // 이미 그 사람이 분대장 — 사망 표시만 걷고 상태를 되돌려 준다 (`lobby:planet` 의 no-op 과 같은 규약).
          lobby.hostDown = false;
          sendTo(c, { t: 'lobby:state', lobby: lobbyState(lobby) });
          return;
        }
        lobby.transferHostTo(m.targetId);
        clearMigrate(lobby.code);
        log(`lobby ${lobby.code}: host handed to ${m.targetId} by ${c.name}(${c.id})${claiming ? ' (claim: host down)' : ''}`);
        broadcastState(lobby);
        pushLobbyPresence(lobby);
        return;
      }

      case 'lobby:hostDown': {
        const lobby = lobbies.lobbyOf(c.id);
        if (!lobby) { sendError(c, 'not_in_lobby'); return; }
        if (lobby.hostId !== c.id) { sendError(c, 'not_host'); return; }
        if (lobby.hostDown === m.down) return;
        lobby.hostDown = m.down;
        log(`lobby ${lobby.code}: host ${c.id} down=${m.down}`);
        return;
      }

      /* appended: Phase 7 */
      case 'lobby:mission': {
        const lobby = lobbies.lobbyOf(c.id);
        if (!lobby) { sendError(c, 'not_in_lobby'); return; }
        if (m.inMission && !lobby.started) { sendError(c, 'in_mission'); return; }
        lobby.setInMission(c.id, m.inMission);
        log(`lobby ${lobby.code}: ${c.name}(${c.id}) inMission=${m.inMission} (${lobby.inMissionCount()} in mission)`);
        if (!m.inMission) { lobby.raid.delete(c.id); migrateHostAway(lobby, c.id); }
        else if (!migrateTimers.has(lobby.code)) {
          // Phase 9: entering a mission whose host is parked (down past its delay) or outside it → this member takes the role.
          const host = lobby.get(lobby.hostId);
          if ((!host || !host.connected || !host.inMission) && lobby.migrateHost(true)) log(`lobby ${lobby.code}: host handed over → host now ${lobby.hostId}`);
        }
        autoResetMission(lobby);
        broadcastState(lobby);
        pushLobbyPresence(lobby);
        return;
      }

      case 'profile:get': {
        sendTo(c, { t: 'profile:docs', profile: store.snapshot(c.id) });
        return;
      }

      case 'profile:set': {
        /* E-6: a frame with `baseRev` is a revision write — always answered (ack / conflict / refused), never `stale`. */
        if (m.baseRev !== undefined) {
          if (!c.hasProfile) { replyProfileWrite(c, { writeId: m.writeId }, { kind: 'refused', code: 'invalid' }); return; }
          const entries: Record<string, unknown> = { [String(m.key)]: { doc: m.doc, baseRev: m.baseRev } };
          replyProfileWrite(c, { writeId: m.writeId }, store.writeDocs(c.id, m.writeId, entries));
          return;
        }
        if (!c.hasProfile) { sendError(c, 'invalid', '프로필이 없는 연결입니다 (세션 토큰 필요).'); return; }
        if (!isProfileDocKey(m.key)) { sendError(c, 'invalid', '알 수 없는 프로필 문서 키입니다.'); return; }
        const res = store.setDoc(c.id, m.key, m.doc, m.at, m.fresh);
        if (res === 'too_large') { sendError(c, 'too_large'); return; }
        if (res === 'invalid') { sendError(c, 'invalid'); return; }
        // 'stale' (older stamp / fresh over an existing doc) is ignored silently: the client keeps the server copy.
        // E-6: this silent rule is for Phase 9 frames only (no `baseRev`).
        return;
      }

      case 'profile:setMany': {
        if (!c.hasProfile) { replyProfileWrite(c, { txId: m.txId }, { kind: 'refused', code: 'invalid' }); return; }
        replyProfileWrite(c, { txId: m.txId }, store.writeDocs(c.id, m.txId, m.docs as Record<string, unknown>));
        return;
      }

      case 'credits:tx': {
        if (!c.hasProfile) { sendTo(c, { t: 'credits:result', txId: m.txId, ok: false, credits: 0, reason: '프로필이 없는 연결입니다.' }); return; }
        /* E-4 (⑦): `reason` is parsed and the amount checked against the generated economy table + the profile's ledger. */
        const res = store.applyCreditsTx(c.id, m.delta, m.reason, economy);
        log(`credits ${c.id}: ${m.delta >= 0 ? '+' : ''}${m.delta} (${m.reason}) → ${res.ok ? res.credits : `refused (${res.why ?? res.reason})`}`);
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
        /* Phase 11: the social record keeps the last name, so an offline friend still has one. */
        if (c.hasProfile) { store.ensureSocial(c.id, c.name); pushPresence(c.id); }
        const lobby = lobbies.lobbyOf(c.id);
        if (!lobby) return; // nothing to broadcast; the name is used by the next create/join anyway
        lobby.setName(c.id, c.name);
        broadcastState(lobby);
        return;
      }

      /* ── appended: Phase 11 — 소셜. Every branch needs a profile; an anonymous socket gets `unavailable`. ── */
      /*
       * 2026-09-11 (B-5): a direct answer to the sender's own request (`get` · `me` · `request` · `respond` · `remove` ·
       * `block`) goes out at once (`pushSocialNow`); everyone else it concerns is marked and gets one coalesced snapshot.
       */
      case 'social:get': {
        if (!socialOf(c)) { socialError(c, 'unavailable'); return; }
        pushSocialNow(c.id);
        return;
      }

      case 'social:me': {
        if (!socialOf(c)) { socialError(c, 'unavailable'); return; }
        if (store.setSocialLevel(c.id, m.level)) notifyWatchers(c.id);
        pushSocialNow(c.id);
        return;
      }

      case 'social:request': {
        const soc = socialOf(c);
        if (!soc) { socialError(c, 'unavailable'); return; }
        const target = peerOfCode(m.code);
        if (!target) { socialError(c, 'not_found'); return; }
        if (target.id === c.id || target.code === soc.code) { socialError(c, 'self'); return; }
        const res = store.addFriendRequest(c.id, target.id);
        if (res !== 'ok') { socialError(c, res); return; }
        /* B-4: when they blocked me the request only landed in my outgoing — they are not told (not even a snapshot). */
        const swallowed = store.isBlocked(target.id, soc.code);
        log(`social: ${soc.code} → ${target.code} 친구 요청${swallowed ? ' [swallowed: blocked]' : ''}`);
        rewatch(c.id);   // B-5: an outgoing row is watched too
        pushSocialNow(c.id);
        if (!swallowed) { rewatch(target.id); pushSocial(target.id); }
        return;
      }

      case 'social:respond': {
        const soc = socialOf(c);
        if (!soc) { socialError(c, 'unavailable'); return; }
        const target = peerOfCode(m.code);
        if (!target) { socialError(c, 'invalid'); return; }
        const res = store.respondFriendRequest(c.id, target.id, m.accept);
        if (res !== 'ok') { socialError(c, res); return; }
        log(`social: ${soc.code} ${m.accept ? '수락' : '거절'} ${target.code}`);
        // A request row became a friend row (or vanished): both watch sets change.
        rewatch(c.id);
        rewatch(target.id);
        pushSocialNow(c.id);
        pushSocial(target.id);
        return;
      }

      case 'social:remove': {
        const soc = socialOf(c);
        if (!soc) { socialError(c, 'unavailable'); return; }
        const target = peerOfCode(m.code);
        if (!target) { socialError(c, 'invalid'); return; }
        const res = store.removeFriend(c.id, target.id);
        if (res !== 'ok') { socialError(c, res); return; }
        log(`social: ${soc.code} 친구 삭제 ${target.code}`);
        rewatch(c.id);
        rewatch(target.id);
        pushSocialNow(c.id);
        pushSocial(target.id);
        return;
      }

      /* appended: 2026-09-11 (B-4) — 차단 */
      case 'social:block': {
        const soc = socialOf(c);
        if (!soc) { socialError(c, 'unavailable'); return; }
        const target = peerOfCode(m.code);
        if (!target) { socialError(c, 'not_found'); return; }
        if (target.id === c.id || target.code === soc.code) { socialError(c, 'self'); return; }
        const res = store.setBlocked(c.id, target.id, m.blocked);
        if (res !== 'ok') { socialError(c, res); return; }
        if (m.blocked) {
          for (const inv of invites.between(c.id, target.id)) {
            if (inv.from === c.id) { closeInvite(inv, 'failed'); continue; }   // mine to them: withdrawn like a leave
            /* theirs to me: gone for me, still "waiting" for them — it ends as `expired`, exactly like a new one would. */
            if (!inv.hidden) { inv.hidden = true; sendTo(c, { t: 'social:inviteClosed', id: inv.id, outcome: 'declined' }); }
          }
        }
        log(`social: ${soc.code} ${m.blocked ? '차단' : '차단 해제'} ${target.code}`);
        rewatch(c.id);
        rewatch(target.id);
        pushSocialNow(c.id);
        pushSocial(target.id);
        return;
      }

      case 'social:play': {
        const soc = socialOf(c);
        if (!soc) { socialError(c, 'unavailable'); return; }
        const target = peerOfCode(m.code);
        if (!target) { socialError(c, 'not_found'); return; }
        if (target.id === c.id) { socialError(c, 'self'); return; }
        /* B-4: nothing is offered toward someone I blocked (unblock first). */
        if (blocks(c.id, target.id)) { socialError(c, 'invalid'); return; }
        const mine = lobbies.lobbyOf(c.id);
        const theirs = lobbies.lobbyOf(target.id);
        const where = presenceOf(target.id);
        /* The same gate the UI greys the button out with (`playBlockReason`), mapped onto the error codes. */
        const block = playBlockReason(where, mine?.size ?? 0, NET_MAX_PLAYERS);
        if (block === 'offline') { socialError(c, 'offline'); return; }
        if (block === 'in_mission') { socialError(c, 'in_mission'); return; }
        if (block === 'my_squad_full') { socialError(c, 'my_squad_full'); return; }
        if (block !== null) { socialError(c, 'full'); return; }   // squad_full
        const name = store.card(target.id)?.name ?? '';
        if (theirs && theirs === mine) { socialError(c, 'in_squad'); return; }
        /*
         * B-4: they blocked me. Moving into their ship is exactly what a block must prevent, and refusing would reveal
         * it — so it becomes an invite into my ship that they never see and that ends `expired` (branch ③, hidden).
         */
        const blockedByThem = blocks(target.id, c.id);
        if (theirs && !blockedByThem) {
          /* ② they already have a ship: I move over — but only if I am not dragging a squad along. */
          if (mine && mine.size > 1) { socialError(c, 'busy'); return; }
          /* B-6: nor out of a mission I am inside (a 훈련장 too — moving would end it under me). */
          if (mine?.get(c.id)?.inMission) { socialError(c, 'busy'); return; }
          if (!theirs.isJoinable()) { socialError(c, 'in_mission'); return; }
          const moved = moveToLobby(c, theirs.code, '같이 하기');
          if (!moved.ok) { socialError(c, moved.code); return; }
          log(`social: ${soc.code} joined ${target.code}'s ship ${moved.lobby.code} (같이 하기)`);
          sendTo(c, { t: 'social:play', code: target.code, name, outcome: 'joined' });
          return;
        }
        /* ③ they have no ship: make sure I have one, then invite them into it. */
        let lobby = mine;
        if (lobby === undefined) {
          const created = lobbies.create(c.id, c.name, false);
          if (typeof created === 'string') { socialError(c, 'invalid'); return; }
          lobby = created;
          log(`lobby ${lobby.code}: created (private) by ${c.name}(${c.id}) for 같이 하기`);
          broadcastState(lobby);
          pushPresence(c.id);
        } else if (!lobby.isJoinable()) { socialError(c, 'busy'); return; }
        else if (lobby.canAdd() === 'full') { socialError(c, 'my_squad_full'); return; }
        if (!clients.has(target.id)) { socialError(c, 'offline'); return; }
        openInvite(c, soc, target.id, lobby, blockedByThem);
        sendTo(c, { t: 'social:play', code: target.code, name, outcome: 'invited' });
        return;
      }

      /* appended: 2026-09-11 (B-3) — 초대 응답. Accepting is a server-side move (B-6), so every refusal is one `social:error`. */
      case 'social:inviteReply': {
        if (!socialOf(c)) { socialError(c, 'unavailable'); return; }
        const inv = invites.get(m.id);
        if (!inv || inv.to !== c.id || inv.hidden) { socialError(c, 'expired'); return; }
        if (!m.accept) { closeInvite(inv, 'declined', undefined, true); return; }
        const target = lobbies.byCode(inv.lobby);
        if (!target || !target.has(inv.from)) { closeInvite(inv, 'failed', 'not_found', true); socialError(c, 'not_found'); return; }
        const mine = lobbies.lobbyOf(c.id);
        if (mine === target) {
          closeInvite(inv, 'accepted', undefined, true);
          sendTo(c, { t: 'lobby:state', lobby: lobbyState(target) });
          return;
        }
        /* Someone else's squad in tow, or inside a mission: refused, and the invite stays open (leave, then accept). */
        if (mine && (mine.size > 1 || (mine.get(c.id)?.inMission ?? false))) { socialError(c, 'busy'); return; }
        const moved = moveToLobby(c, target.code, `invite ${inv.id}`, inv);
        if (!moved.ok) { closeInvite(inv, 'failed', moved.code, true); socialError(c, moved.code); return; }
        return;
      }

      case 'social:whisper': {
        /* B-4: a sender that passed `nonce` hears every outcome as `social:whisperAck`; an older one keeps `social:error`. */
        const nonce = m.nonce;
        const refuse = (code: SocialErrorCode): void => {
          if (nonce === undefined) socialError(c, code);
          else sendTo(c, { t: 'social:whisperAck', nonce, ok: false, code });
        };
        const soc = socialOf(c);
        if (!soc) { refuse('unavailable'); return; }
        const text = sanitizeWhisper(m.text);
        if (text.length === 0) { refuse('invalid'); return; }
        const target = peerOfCode(m.code);
        if (!target) { refuse('not_found'); return; }
        if (store.isBlocked(c.id, target.code)) { refuse('invalid'); return; }   // I blocked them: unblock first
        const at = Date.now();
        const tc = clients.get(target.id);
        if (tc) {
          /* They blocked me: dropped, and my ack says delivered (they are never revealed). */
          if (!store.isBlocked(target.id, soc.code)) sendTo(tc, { t: 'social:whisper', code: soc.code, name: soc.name, text, at });
          if (nonce !== undefined) sendTo(c, { t: 'social:whisperAck', nonce, ok: true, at });
          return;
        }
        /* Offline: a friend's inbox keeps it (only for a client that can be told so — the old rule stays `offline`). */
        if (nonce !== undefined && soc.friends.includes(target.code)
          && store.pushWhisperInbox(target.id, { from: soc.code, name: soc.name, text, at }, at)) {
          sendTo(c, { t: 'social:whisperAck', nonce, ok: true, at, stored: true });
          return;
        }
        refuse('offline');
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
    const c: Client = {
      id, ws, alive: true, name: name ?? '', remote: req.socket.remoteAddress ?? '?', hasProfile: token !== null,
      connectedAt: Date.now(), kicked: false,
    };

    // Same session already attached (second tab / zombie socket): the newest connection wins.
    const old = clients.get(id);

    /*
     * C-29: operator cap. Refused before anything else happens (no welcome, no social record, no presence push).
     * Exempt: a socket replacing its own (`old`), and an id that is still a lobby member — a squadmate coming back
     * inside its reconnect grace must never be locked out of the raid it was in.
     */
    if (maxClients !== null && !old && clients.size >= maxClients && !lobbies.lobbyOf(id)) {
      log(`refused ${id} from ${c.remote}: server full (${clients.size}/${maxClients})`);
      const refusal: ServerToClient = { t: 'lobby:error', code: 'server_full', message: LOBBY_ERROR_MESSAGE_KO.server_full };
      try {
        ws.send(JSON.stringify(refusal));
        ws.close(CLOSE_SERVER_FULL, 'server full');
      } catch { /* already gone */ }
      setTimeout(() => { try { ws.terminate(); } catch { /* ignore */ } }, 2000).unref();
      ws.on('error', () => { /* refused socket: nothing to clean up */ });
      return;
    }
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
    /* Phase 11: a token connection gets (or is given) an 아이디 and its social snapshot; anonymous gets neither. */
    if (c.hasProfile) { store.ensureSocial(id, c.name); store.touchSeen(id); }
    if (lobby) {
      const wasDown = clearGrace(id) || !(lobby.get(id)?.connected ?? true);
      lobby.setConnected(id, true);
      // A returning host inside the migrate delay keeps the role; after it, `welcome.lobby.hostId` tells it otherwise.
      if (lobby.hostId === id) clearMigrate(lobby.code);
      if (c.name) lobby.setName(id, c.name); else c.name = lobby.get(id)?.name ?? '';
      let note = '';
      if (old) {
        // Phase 9: a replaced socket is a new page — that page is not inside the mission any more (the client also
        // reports `lobby:mission false` itself on a plain reload; here the old socket never got to). A host that was
        // inside hands the authority to a connected in-mission member.
        const me = lobby.get(id);
        if (lobby.started && me?.inMission) {
          lobby.setInMission(id, false);
          lobby.raid.delete(id);
          note += ' (duplicate socket → left the mission)';
          if (migrateHostAway(lobby, id)) note += ` → host now ${lobby.hostId}`;
          if (autoResetMission(lobby)) note += ' → mission over → reset';
        }
      } else if (lobby.started && lobby.hostId !== id && lobby.get(id)?.inMission && !migrateTimers.has(lobby.code)) {
        // Phase 9: the host is parked (down past its delay with nobody eligible) or out of the mission (reloaded) →
        // this returning in-mission member takes the role now (a still-pending delay keeps its own schedule).
        const host = lobby.get(lobby.hostId);
        if (!host || !host.connected || !host.inMission) {
          if (lobby.migrateHost(true)) note += ` → host handed over: host now ${lobby.hostId}`;
        }
      }
      const raid = lobby.getRaid(id);
      log(`lobby ${lobby.code}: ${c.name}(${id}) resumed${wasDown ? ' (was disconnected)' : ''}${raid ? ' + raid blob' : ''}${note}`);
      const welcome: ServerToClient = { t: 'welcome', id, serverTime: Date.now(), lobby: lobbyState(lobby), resumed: true };
      if (profile) welcome.profile = profile;
      if (raid) welcome.raid = raid;
      const social = c.hasProfile ? buildSnapshot(id) : null;
      if (social) welcome.social = social;
      sendTo(c, welcome);
      broadcastState(lobby);
    } else {
      const welcome: ServerToClient = { t: 'welcome', id, serverTime: Date.now() };
      if (profile) welcome.profile = profile;
      const social = c.hasProfile ? buildSnapshot(id) : null;
      if (social) welcome.social = social;
      sendTo(c, welcome);
    }
    if (c.hasProfile) {
      /* B-4: whispers friends left while I was away — once, right after the welcome, then the inbox is empty. */
      const backlog = store.takeWhisperInbox(id);
      if (backlog.length > 0) {
        sendTo(c, { t: 'social:whisperBacklog', lines: backlog.map((l) => ({ code: l.from, name: l.name, text: l.text, at: l.at })) });
        log(`social: ${store.card(id)?.code ?? id} got ${backlog.length} kept whisper(s)`);
      }
      /* B-3: a page reload lost the invite cards — invites still open for me are shown again (same ids). */
      for (const inv of invites.toPeer(id)) {
        const from = store.card(inv.from);
        if (from) sendTo(c, { t: 'social:invited', invite: { id: inv.id, from: from.code, name: from.name, lobby: inv.lobby, at: inv.at } });
      }
      /* Phase 11: subscribe this socket to the presence of everyone in its lists and tell everyone watching that it is online. */
      rewatch(id);
      notifyWatchers(id);
    }

    ws.on('pong', () => { c.alive = true; });
    ws.on('message', (raw: RawData, isBinary: boolean) => {
      if (clients.get(c.id) !== c) return; // replaced by a newer socket; ignore stragglers
      if (c.kicked) return;               // C-29: the close is on its way — a late `lobby:quickmatch` must not rejoin
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
      if (c.hasProfile) store.touchSeen(c.id);   // B-2: the GC counts inactivity from the last time the owner was here
      try { suspendInLobby(c); } catch (e) { log(`cleanup error ${c.id}: ${(e as Error).message}`); }
      /* Phase 11: the socket is gone → presence `offline` for everyone watching, and its own watches are dropped. */
      try {
        notifyWatchers(c.id);
        unwatchAll(c.id);
        /* B-3: invites waiting on me cannot be answered any more (a hidden one keeps its own clock → `expired`). */
        for (const inv of invites.toPeer(c.id)) closeInvite(inv, 'offline');
      } catch (e) { log(`social cleanup error ${c.id}: ${(e as Error).message}`); }
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

  /* ── C-29: operator console (server/tool.ts) ─────────────────────────── */
  const listClients = (): RelayClientInfo[] => {
    const out: RelayClientInfo[] = [];
    for (const c of clients.values()) {
      const lobby = lobbies.lobbyOf(c.id);
      out.push({
        id: c.id,
        name: c.name,
        remote: c.remote,
        code: store.card(c.id)?.code ?? null,
        lobby: lobby?.code ?? null,
        host: lobby?.hostId === c.id,
        inMission: (lobby?.started ?? false) && (lobby?.get(c.id)?.inMission ?? false),
        connectedAt: c.connectedAt,
      });
    }
    return out.sort((a, b) => a.connectedAt - b.connectedAt);
  };

  /** A typed target → PeerId: an exact connected / lobby-member id first, then an 아이디 (dash and case ignored). */
  const resolveKickTarget = (raw: string): PeerId | null => {
    const text = raw.trim();
    if (!text) return null;
    if (clients.has(text) || lobbies.lobbyOf(text)) return text;
    const code = normalizePlayerCode(text);
    if (!code) return null;
    return store.peerByCode(code) ?? null;
  };

  const kick = (idOrCode: string, reason?: string): RelayKickResult => {
    const id = resolveKickTarget(idOrCode);
    const c = id !== null ? clients.get(id) : undefined;
    const lobby = id !== null ? lobbies.lobbyOf(id) : undefined;
    if (id === null || (!c && !lobby)) return { ok: false, reason: 'not_found' };
    const name = c?.name || lobby?.get(id)?.name || '';
    const lobbyCode = lobby?.code ?? null;
    // No grace: the slot goes first (peer:left + host migration, exactly like a leave), then the socket.
    if (lobby) removeFromLobby(id, name, 'kick');
    if (c) {
      c.kicked = true;
      const why = typeof reason === 'string' ? reason.trim().slice(0, MAX_REASON_INPUT) : '';
      sendError(c, 'kicked', why ? `${LOBBY_ERROR_MESSAGE_KO.kicked} (${why})` : undefined);
      try { c.ws.close(CLOSE_KICKED, 'kicked'); } catch { /* ignore */ }
      const sock = c.ws;
      setTimeout(() => { try { sock.terminate(); } catch { /* ignore */ } }, 2000).unref();
      // The close handler below does the rest (clients map, presence → offline for friends).
    }
    log(`kick ${name}(${id})${lobbyCode ? ` from lobby ${lobbyCode}` : ''}${c ? '' : ' (slot only — socket was already down)'}`);
    return { ok: true, id, name, connected: !!c, lobby: lobbyCode };
  };

  const setMaxClients = (n: number | null): void => {
    maxClients = normalizeMax(n);
    log(`max clients → ${maxClients ?? 'unlimited'} (${clients.size} connected)`);
  };

  /* ── 2026-09-11 (B-2): profile GC ─────────────────────────────────────── */
  const collectGarbage = (now: number = Date.now()): ProfileGcReport => {
    const report = store.collectGarbage((id) => clients.has(id) || lobbies.lobbyOf(id) !== undefined, now);
    // A friend that vanished must also leave the watch index and the open ESC screen of whoever is online right now.
    for (const id of report.changed) {
      if (!clients.has(id)) continue;
      rewatch(id);
      pushSocial(id);
    }
    if (report.removed.length + report.danglingRefs + report.expiredRecent + report.expiredRequests > 0) {
      log(`profile gc: removed ${report.removed.length} inactive profiles, dropped ${report.danglingRefs} dangling / `
        + `${report.expiredRecent} old recent / ${report.expiredRequests} old request entries (${store.size} profiles left)`);
    }
    return report;
  };
  collectGarbage();
  const gcEvery = opts.profileGcIntervalMs === undefined ? PROFILE_GC_INTERVAL_MS : opts.profileGcIntervalMs;
  const gcTimer = typeof gcEvery === 'number' && gcEvery > 0 ? setInterval(() => collectGarbage(), gcEvery) : null;
  gcTimer?.unref();

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
        listClients,
        kick,
        setMaxClients,
        get maxClients() { return maxClients; },
        collectGarbage,
        close: () => new Promise<void>((done) => {
          clearInterval(heartbeat);
          if (gcTimer) clearInterval(gcTimer);
          for (const t of graceTimers.values()) clearTimeout(t);
          graceTimers.clear();
          for (const t of migrateTimers.values()) clearTimeout(t);
          migrateTimers.clear();
          /* Phase 11: the presence push channel is per-process state — drop it with the sockets. */
          watchers.clear();
          watching.clear();
          pushes.close();    // B-5: the pending coalescing timer
          invites.clear();   // B-3: every invite TTL timer
          store.close();
          for (const c of clients.values()) { try { c.ws.terminate(); } catch { /* ignore */ } }
          wss.close(() => { http.close(() => done()); });
        }),
      });
    });
  });
}
