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
  ClientToServer, ServerToClient, GameMessage, LobbyErrorCode, LobbyPlayer, LobbyState, PeerId, RelayTarget,
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
/* 2026-09-14: the intel broker — the fixed gimmicks carried on the lobby (only the shape is sanitized,
   docs/DECISIONS.md 「2026-09-14 — 정보상」) */
import type { IntelWire } from '../src/shared/net.ts';
import { sanitizeIntelPicks } from '../src/shared/intel.ts';
import type { PlayerCode, PresenceState, SocialErrorCode, SocialPlayer, SocialSnapshot } from '../src/shared/social.ts';
import {
  SOCIAL_ERROR_MESSAGE_KO, SOCIAL_WHISPER_MAX, normalizePlayerCode, playBlockReason,
} from '../src/shared/social.ts';
/* 2026-09-11 (B-3 · B-4 · B-5 · B-6): the invite table · blocks · push coalescing · the atomic move */
import type { InviteOutcome, SocialCard } from '../src/shared/social.ts';
import { SQUAD_INVITE_MAX } from '../src/shared/social.ts';
import { InviteTable, PushCoalescer, type OpenInvite } from './Invites.ts';
import { Lobby, LobbyManager, LOBBY_ERROR_MESSAGE_KO } from './Lobby.ts';
import {
  PROFILE_GC_INTERVAL_MS, ProfileStore, docBytes, isProfileDocKey,
  type ProfileGcReport, type ProfileStoreOptions,
} from './Store.ts';
/* 2026-09-11 (E-6): document revisions · transactions */
import { PROFILE_WRITE_ID_MAX, type RevWriteResult } from './Store.ts';
import { PROFILE_SETMANY_MAX_BYTES } from '../src/shared/profile.ts';
/* 2026-09-11 (E-4 ⑦): server-side credit validation */
import type { EconomyTable } from '../src/shared/credits.ts';
import { CreditEconomy, ECONOMY_TABLE, economyTableIntact } from './Economy.ts';
/* 2026-09-13: crypto prices (`crypto:watch` · `crypto:history` · `crypto:prices`) */
import { CryptoMarket } from './CryptoMarket.ts';
/* 2026-09-14: group rooms (`room:*` · server/Rooms.ts) */
import type { RoomErrorCode, RoomInfo, RoomInvite, RoomLine, RoomRecord, RoomSnapshot, SocialRecord } from '../src/shared/social.ts';
import {
  ROOM_MEMBER_MAX, ROOM_NAME_MAX, ROOM_SAY_BURST, ROOM_SAY_PER_S, ROOM_TEXT_MAX, formatPlayerCode, isValidRoomId, roomErrorMessage,
  roomSystemTextKo,
} from '../src/shared/social.ts';
import { RoomStore, type RoomOp } from './Rooms.ts';
import { DEFAULT_DATA_DIR } from './Store.ts';
import type { CryptoChartRange } from '../src/shared/cryptoMarket.ts';
/* 2026-09-15: squad · dock matchmaking (`lobby:dock` · `lobby:look` · invite-only `같이 하기` · lonely-party prune) */
import { NET_ACCENT_PARAM, sanitizeAccent, sanitizeShipModel } from '../src/shared/net.ts';
/* 2026-09-15: android squadmates (`lobby:android` · `lobby:androidReturned` · bot members) — the last section
   of `src/shared/net.ts` */
import { ANDROID_BAY_COUNT, isAndroidId, isBotPlayer } from '../src/shared/net.ts';
import type { PlayBlock } from '../src/shared/social.ts';

/** 2026-09-15: what a `lobby:look.accent` string may carry before `sanitizeAccent` judges it (`#rrggbb` + stray whitespace). */
const MAX_ACCENT_INPUT = 32;

/** 2026-09-13: per-socket `crypto:history` token bucket — burst and refill per second (a chart screen asks for one coin × range at a time). */
export const CRYPTO_HISTORY_BURST = 16;
export const CRYPTO_HISTORY_PER_S = 4;

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
/* 2026-09-14: what a `room:*` frame may carry before `sanitizeRoomName` / `sanitizeRoomText` trim it. */
const MAX_ROOM_NAME_INPUT = 4 * ROOM_NAME_MAX;
const MAX_ROOM_TEXT_INPUT = 4 * ROOM_TEXT_MAX;
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

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
  /** 2026-09-13: `crypto:watch {on:true}` — receives `crypto:prices` every market tick. Forgotten with the socket. */
  cryptoWatch: boolean;
  /** 2026-09-13: `crypto:history` token bucket (tokens, `Date.now()` of the last refill). */
  cryptoTokens: number;
  cryptoTokensAt: number;
  /** 2026-09-14: `room:say` token bucket (`ROOM_SAY_BURST`, refilled `ROOM_SAY_PER_S`). */
  roomTokens: number;
  roomTokensAt: number;
  /**
   * 2026-09-15: my accent colour (`#rrggbb`) from `?a=` or the last `lobby:look`, null = unknown. Kept on the socket so every
   * later lobby (create · join · quick match · move · 같이 하기) gets it as `LobbyPlayer.accent` without asking again.
   */
  accent: string | null;
}

/** 2026-09-11 (C-29): one row of the operator console's `list` (`RelayServer.listClients`). */
export interface RelayClientInfo {
  id: PeerId;
  name: string;
  remote: string;
  /** The player code (`PlayerCode`) — null for an anonymous socket (or before the store assigned one). */
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
   * **off**: `server/index.ts` turns it on from `SCAV_DEV_ECONOMY=1` (only the relay `scripts/verify.mjs` starts itself — `npm run dev:all` and
   * `start-server.bat` keep it off). The desktop shell has no relay since 2026-09-15.
   */
  devEconomy?: boolean;
  /** 2026-09-11 (E-4 ⑦): the economy table (default: the committed `economy.gen.json`). Selftest only. */
  economyTable?: EconomyTable;
  /** 2026-09-13: RNG seed of a **fresh** crypto market (a `crypto.json` keeps its own). Selftest only. */
  cryptoSeed?: number;
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
  /* 2026-09-11 (C-29) — operator console administration (`server/Console.ts`, the start-server.bat window). There
     is no ban: a kicked person is never stopped from connecting again. */
  /** Every connected socket, oldest first. */
  listClients(): RelayClientInfo[];
  /**
   * Disconnect `idOrCode` (a PeerId, or a player code typed with or without the dash) **without a reconnect
   * grace**: the
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
  /** 2026-09-13: the crypto market (null when the economy table has no `crypto` section). */
  readonly crypto: CryptoMarket | null;
  /** 2026-09-14: the group room store (`rooms.json` next to `profiles.json`). */
  readonly rooms: RoomStore;
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
      /* 2026-09-14 (the intel broker): only the shape is read — what the values mean is the client world
         generator's business (treated like `planet`). */
      if (m.intel !== undefined) out.intel = sanitizeIntelWire(m.intel);
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
      if (typeof m.inMission !== 'boolean') return null;
      /* 2026-09-15: `keep` = a reloaded page's `false` — the blob is kept (omitted · not true = dropped as before) */
      return m.keep === true && !m.inMission ? { t: 'lobby:mission', inMission: false, keep: true } : { t: 'lobby:mission', inMission: m.inMission };
    /* appended: 2026-09-15 — abandoning the raid from the title (drifting) */
    case 'lobby:abandon':
      return { t: 'lobby:abandon' };
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
    /* appended: Phase 11 — the target planet + social. Shapes only; every social rule is the handler's (and the
       store's). */
    case 'lobby:planet':
      return isPlanetId(m.planet) ? { t: 'lobby:planet', planet: m.planet } : null;
    /* appended: 2026-09-14 — the intel broker. `null` is a valid value (it is a discarded 「지역 재배치」). */
    case 'lobby:intel':
      return m.intel === null || isRecord(m.intel) ? { t: 'lobby:intel', intel: sanitizeIntelWire(m.intel) } : null;
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
    /* appended: 2026-09-11 — B-3 the invite reply · B-4 blocks. Shapes only. */
    case 'social:inviteReply':
      return typeof m.id === 'string' && m.id.length > 0 && m.id.length <= MAX_INVITE_ID_INPUT && typeof m.accept === 'boolean'
        ? { t: 'social:inviteReply', id: m.id, accept: m.accept } : null;
    case 'social:block':
      return validSocialCode(m.code) && typeof m.blocked === 'boolean'
        ? { t: 'social:block', code: m.code as string, blocked: m.blocked } : null;
    /* appended: 2026-09-09 — host transfer by nomination. Every rule is the handler's; only the shape here. */
    case 'lobby:transferHost': {
      if (typeof m.targetId !== 'string' || m.targetId.length === 0 || m.targetId.length > MAX_CODE_INPUT) return null;
      if (m.claim !== undefined && typeof m.claim !== 'boolean') return null;
      const out: ClientToServer = { t: 'lobby:transferHost', targetId: m.targetId };
      if (m.claim === true) out.claim = true;
      return out;
    }
    case 'lobby:hostDown':
      return typeof m.down === 'boolean' ? { t: 'lobby:hostDown', down: m.down } : null;
    /* appended: 2026-09-15 — squad · dock matchmaking. Shapes only; a string that is not `#rrggbb` is ignored by
       the handler (not refused). */
    case 'lobby:dock':
      return typeof m.isPublic === 'boolean' ? { t: 'lobby:dock', isPublic: m.isPublic } : null;
    case 'lobby:look': {
      /* 2026-09-21: `shipModel` rides along and both fields are optional — a sender pushes whichever changed, so the
         only message refused here is one carrying neither. */
      const look: { t: 'lobby:look'; accent?: string; shipModel?: string } = { t: 'lobby:look' };
      if (typeof m.accent === 'string' && m.accent.length <= MAX_ACCENT_INPUT) look.accent = m.accent;
      if (typeof m.shipModel === 'string' && m.shipModel.length <= MAX_ACCENT_INPUT) look.shipModel = m.shipModel;
      return look.accent === undefined && look.shipModel === undefined ? null : look;
    }
    /* appended: 2026-09-15 — android squadmates. Shapes only: the bay's range · whether it already is in that
       state are answered `invalid` by the handler. */
    case 'lobby:android':
      return typeof m.bay === 'number' && Number.isInteger(m.bay) && typeof m.recruit === 'boolean'
        ? { t: 'lobby:android', bay: m.bay, recruit: m.recruit } : null;
    /* appended: 2026-09-13 — crypto prices. Shapes only: an unknown coin / range is ignored by the handler
       (contract: silently ignored). */
    case 'crypto:watch':
      return typeof m.on === 'boolean' ? { t: 'crypto:watch', on: m.on } : null;
    case 'crypto:history':
      return typeof m.coin === 'string' && m.coin.length > 0 && m.coin.length <= MAX_CODE_INPUT && typeof m.range === 'string' && m.range.length <= 4
        ? { t: 'crypto:history', coin: m.coin, range: m.range as CryptoChartRange } : null;
    /* appended: 2026-09-14 — group rooms. Shapes + input caps only; membership / owner / friend rules
       are the handler's and the store's. */
    case 'room:get':
      return { t: 'room:get' };
    case 'room:create': {
      if (typeof m.name !== 'string' || m.name.length > MAX_ROOM_NAME_INPUT || !isFiniteNum(m.nonce)) return null;
      if (m.invite === undefined) return { t: 'room:create', name: m.name, nonce: m.nonce };
      if (!Array.isArray(m.invite) || m.invite.length > ROOM_MEMBER_MAX || !m.invite.every(validSocialCode)) return null;
      return { t: 'room:create', name: m.name, invite: m.invite as string[], nonce: m.nonce };
    }
    case 'room:invite':
      return isValidRoomId(m.room) && validSocialCode(m.code) ? { t: 'room:invite', room: m.room, code: m.code as string } : null;
    case 'room:kick':
      return isValidRoomId(m.room) && validSocialCode(m.code) ? { t: 'room:kick', room: m.room, code: m.code as string } : null;
    case 'room:reply':
      return isValidRoomId(m.room) && typeof m.accept === 'boolean' ? { t: 'room:reply', room: m.room, accept: m.accept } : null;
    case 'room:leave':
      return isValidRoomId(m.room) ? { t: 'room:leave', room: m.room } : null;
    case 'room:rename':
      return isValidRoomId(m.room) && typeof m.name === 'string' && m.name.length <= MAX_ROOM_NAME_INPUT ? { t: 'room:rename', room: m.room, name: m.name } : null;
    case 'room:say':
      return isValidRoomId(m.room) && typeof m.text === 'string' && m.text.length <= MAX_ROOM_TEXT_INPUT && isFiniteNum(m.nonce)
        ? { t: 'room:say', room: m.room, text: m.text, nonce: m.nonce } : null;
    case 'room:history':
      if (!isValidRoomId(m.room) || (m.before !== undefined && !isFiniteNum(m.before))) return null;
      return m.before === undefined ? { t: 'room:history', room: m.room } : { t: 'room:history', room: m.room, before: m.before as number };
    default:
      return null;
  }
}

/**
 * 2026-09-14 (the intel broker) — sanitizes **the shape only** of an `IntelWire`. The relay neither knows nor needs
 * to know what the value means: the layout is built by the client (the same limit as `planet`) and the server merely
 * passes it on to the squad. An empty pick · an unknown gimmick folds to "nothing was bought" (null) — the formula
 * lives in one place, `src/shared/intel.ts`.
 */
function sanitizeIntelWire(raw: unknown): IntelWire | null {
  if (!isRecord(raw)) return null;
  const seed = raw.seed;
  if (typeof seed !== 'number' || !Number.isFinite(seed)) return null;
  const picks = sanitizeIntelPicks(raw.picks);
  return picks.length ? { seed: Math.floor(seed), picks } : null;
}

/** A typed-in code arrives dashed / lower case; only the shape is checked here (`normalizePlayerCode` follows). */
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

/** `?t=…&n=…&a=…` from the upgrade request. Invalid / missing token → null (random id); an invalid accent → null (unknown). */
function parseConnectQuery(req: IncomingMessage): { token: string | null; name: string | null; accent: string | null } {
  let token: string | null = null;
  let name: string | null = null;
  let accent: string | null = null;
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const t = url.searchParams.get(NET_TOKEN_PARAM);
    if (isValidSessionToken(t)) token = t;
    const n = url.searchParams.get(NET_NAME_PARAM);
    if (typeof n === 'string' && n.length > 0 && n.length <= MAX_NAME_INPUT) name = sanitizePlayerName(n);
    /* 2026-09-15: the accent colour of the face tiles in the `매칭` tab — the one parser (`sanitizeAccent`)
       decides; anything else is simply unknown. */
    const a = url.searchParams.get(NET_ACCENT_PARAM);
    if (typeof a === 'string' && a.length <= MAX_ACCENT_INPUT) accent = sanitizeAccent(a);
  } catch { /* malformed url → anonymous */ }
  return { token, name, accent };
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
  /* 2026-09-13: crypto prices — the one entrypoint (`server/index.ts`, started by start-server.bat / verify) goes
     through here. Same directory as the profile store (`crypto.json` next to `profiles.json`); `dataDir: null`
     keeps it in memory. */
  const market = economy.table.crypto
    ? new CryptoMarket({ table: economy.table.crypto, dataDir: opts.dataDir === undefined ? DEFAULT_DATA_DIR : opts.dataDir, quiet, ...(opts.cryptoSeed !== undefined ? { seed: opts.cryptoSeed } : {}) })
    : null;
  economy.setCryptoQuotes(market);
  if (!market) log('crypto market off (economy table has no crypto section)');
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
      res.end(JSON.stringify({ ok: true, lobbies: lobbies.count, clients: clients.size, pendingReconnects: graceTimers.size, profiles: store.size, uptime: Math.round(process.uptime()), maxClients, devEconomy: economy.dev, economy: economy.table.hash, crypto: market ? market.coinIds.length : 0 }));
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
   * Phase 11: every `LobbyState` that leaves the server carries each member's code + level from the profile store.
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
    /* 2026-09-21 (B-101): and the ship model, out of that member's own `progression` document. It used to be
       whatever the client said in `lobby:look` — fine while no ship can be bought, a free ship the day one can, so
       it is filled here beside `code` · `level` instead. A profile that has not uploaded one simply has no field
       and the client falls back to `DEFAULT_SHIP_MODEL`. */
    for (const p of state.players) {
      const ship = store.shipModel(p.id);
      if (ship) p.shipModel = ship;
    }
    return state;
  };
  const broadcastState = (lobby: Lobby): void => {
    broadcast(lobby, { t: 'lobby:state', lobby: lobbyState(lobby) });
  };
  /**
   * 2026-09-15 (android squadmates): tells **everyone** in the lobby about a bot that went back to its bay to let
   * a human in. Called **after** the join is done — the newcomer has to hear the same news for its squad list and
   * the cockpit bays to be right. It follows `broadcastState` on every path that puts a human in (joining by code ·
   * accepting an invite · a move · public matchmaking).
   */
  const announceBotReturns = (lobby: Lobby): void => {
    for (const bot of lobby.takeReturnedBots()) {
      const bay = bot.bay ?? 0;
      log(`lobby ${lobby.code}: android bay ${bay} returned to its slot (a human joined)`);
      broadcast(lobby, { t: 'lobby:androidReturned', bay, reason: 'human_joined' });
    }
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
    /* 2026-09-15: a squad's size counts **humans only** — a squad filled with androids can still invite people
       (humans win over bots). */
    return { presence, squad: lobby.humanCount() };
  };

  /**
   * One resolved row. null when the code has no profile any more — the caller then skips it.
   * 2026-09-15: `iAmMember` = the viewer sits in a lobby it does not lead — 같이 하기 is invite-only now, so only a leader (or
   * someone with no squad) sees `joinable` (the same `playBlockReason` call `social:play` makes).
   */
  const resolveRow = (viewer: PeerId, mySquad: number, iAmMember: boolean, code: PlayerCode, at?: number): SocialPlayer | null => {
    const id = store.peerByCode(code);
    if (id === undefined) return null;
    const card = store.card(id);
    if (!card) return null;
    const { presence, squad } = presenceOf(id);
    const row: SocialPlayer = {
      code: card.code, name: card.name, level: card.level, presence, squad,
      joinable: playBlockReason({ presence, squad }, mySquad, NET_MAX_PLAYERS, id === viewer, iAmMember) === null,
    };
    if (at !== undefined) row.at = at;
    /* B-3 badge: my invite to them is still open (a hidden one too — for me it is an ordinary unanswered invite). */
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
    const myLobby = lobbies.lobbyOf(id);
    const mySquad = myLobby?.humanCount() ?? 0;   // 2026-09-15: bots are left out of the invitability test
    const iAmMember = myLobby !== undefined && myLobby.hostId !== id;
    const rows = (codes: readonly PlayerCode[]): SocialPlayer[] => {
      const out: SocialPlayer[] = [];
      for (const code of codes) { const r = resolveRow(id, mySquad, iAmMember, code); if (r) out.push(r); }
      return out;
    };
    const recent: SocialPlayer[] = [];
    for (const e of soc.recent) { const r = resolveRow(id, mySquad, iAmMember, e.code, e.at); if (r) recent.push(r); }
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
   * the subject in **any** of their four lists (2026-09-11, B-5 — friends · incoming · outgoing · recent; it used
   * to be friends only, so a request or a recent-player row showed a stale presence), `watching` = its reverse so
   * a disconnect costs O(rows). Nothing polls.
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
   * changes a list: request · respond · remove · block · recent players · GC).
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
  const pushPresence = (id: PeerId): void => { pushSocial(id); notifyWatchers(id); markRoomPeers(id); };
  /** A whole squad moved at once (start, reset, membership, the target planet). */
  /* 2026-09-15: a bot has neither a profile nor a socket — it is not a presence subject. */
  const pushLobbyPresence = (lobby: Lobby): void => { for (const p of lobby.players.values()) if (!isBotPlayer(p)) pushPresence(p.id); };

  /* ── 2026-09-14: group rooms (server/Rooms.ts — rules + persistence; here: profiles, friends, blocks,
     presence, fan-out) ── */
  const rooms = new RoomStore({
    dataDir: opts.dataDir === undefined ? DEFAULT_DATA_DIR : opts.dataDir,
    quiet,
    ...(opts.profileSaveDebounceMs !== undefined ? { saveDebounceMs: opts.profileSaveDebounceMs } : {}),
    nameOf: (code) => { const pid = store.peerByCode(code); return (pid !== undefined ? store.card(pid)?.name : '') || formatPlayerCode(code); },
  });
  /** One `RoomInfo` as `viewer`-independent data (presence folded from the relay's live state). */
  const roomInfo = (r: RoomRecord, now: number): RoomInfo => {
    const members: RoomInfo['members'] = [];
    for (const code of r.members) {
      const pid = store.peerByCode(code);
      const card = pid === undefined ? null : store.card(pid);
      if (pid !== undefined && card) members.push({ ...card, presence: presenceOf(pid).presence });
    }
    const pending: RoomInfo['pending'] = [];
    for (const inv of rooms.pendingOf(r, now)) {
      const pid = store.peerByCode(inv.code);
      const card = pid === undefined ? null : store.card(pid);
      if (card) pending.push(card);
    }
    const info: RoomInfo = { id: r.id, name: r.name, owner: r.owner, members, pending, createdAt: r.createdAt, lastAt: RoomStore.lastAt(r) };
    const last = r.lines.at(-1);
    if (last) {
      const wire = RoomStore.wire(r, last);
      info.lastText = last.system ? roomSystemTextKo(wire) : last.text;
      info.lastCode = last.code;
      if (last.system) info.lastSystem = last.system;
    }
    return info;
  };
  /** Rooms + open invites of one profile socket (null without a social record). Invites from someone I blocked are hidden. */
  const buildRoomSnapshot = (id: PeerId): RoomSnapshot | null => {
    const soc = store.social(id);
    if (!soc) return null;
    const now = Date.now();
    const invitesOut: RoomInvite[] = [];
    for (const inv of rooms.invitesOf(soc.code, now)) {
      if (store.isBlocked(id, inv.from)) continue;
      const pid = store.peerByCode(inv.from);
      const fromName = (pid !== undefined ? store.card(pid)?.name : '') || formatPlayerCode(inv.from);
      invitesOut.push({ room: inv.room.id, name: inv.room.name, from: inv.from, fromName, members: inv.room.members.length, at: inv.at });
    }
    return { rooms: rooms.roomsOf(soc.code).map((r) => roomInfo(r, now)), invites: invitesOut };
  };
  const sendRooms = (id: PeerId): void => {
    const c = clients.get(id);
    if (!c || !c.hasProfile) return;
    const snap = buildRoomSnapshot(id);
    if (snap) sendTo(c, { t: 'room:state', rooms: snap });
  };
  /* Same coalescing as social pushes: a member hears at most one `room:state` per window; the actor's own answer goes now. */
  const roomPushes = new PushCoalescer({ send: sendRooms, windowMs: opts.socialPushCoalesceMs });
  const roomError = (c: Client, code: RoomErrorCode): void => { sendTo(c, { t: 'room:error', code, message: roomErrorMessage(code) }); };
  /** `id` moved (presence): everyone sharing a room with it gets a fresh (coalesced) `room:state`. */
  const markRoomPeers = (id: PeerId): void => {
    const code = store.card(id)?.code;
    if (!code) return;
    for (const r of rooms.roomsOf(code)) {
      for (const m of r.members) {
        if (m === code) continue;
        const pid = store.peerByCode(m);
        if (pid !== undefined && clients.get(pid)?.hasProfile) roomPushes.mark(pid);
      }
    }
  };
  /** A room line to every connected member (`except` = the sender of a `room:say`, who has its ack). */
  const sendRoomLine = (room: RoomRecord, line: RoomLine, except?: PeerId): void => {
    let text: string | null = null;
    for (const code of room.members) {
      const pid = store.peerByCode(code);
      if (pid === undefined || pid === except) continue;
      const rc = clients.get(pid);
      if (!rc || rc.ws.readyState !== WebSocket.OPEN) continue;
      text ??= JSON.stringify({ t: 'room:line', line } satisfies ServerToClient);
      try { rc.ws.send(text); } catch { /* the close handler cleans up */ }
    }
  };
  /**
   * Fan a successful store mutation out: `room:state` first (the actor at once, everyone else coalesced — so a joiner knows
   * the room before its `join` line arrives), then the appended lines to the current members.
   */
  const applyRoomOp = (actor: Client | null, op: Extract<RoomOp, { ok: true }>, except?: PeerId): void => {
    for (const code of new Set(op.notify)) {
      const pid = store.peerByCode(code);
      if (pid === undefined || !clients.get(pid)?.hasProfile) continue;
      if (actor && pid === actor.id) roomPushes.now(pid); else roomPushes.mark(pid);
    }
    if (op.room) for (const line of op.lines) sendRoomLine(op.room, line, except);
  };
  const roomActor = (soc: SocialRecord): { code: PlayerCode; name: string } => ({ code: soc.code, name: soc.name });
  /** `room:invite` (also each `room:create.invite` entry): room rules first, then friends-only + blocks. null = invited. */
  const inviteToRoom = (c: Client, soc: SocialRecord, roomId: string, raw: string): RoomErrorCode | null => {
    const room = rooms.get(roomId);
    if (!room || !room.members.includes(soc.code)) return 'not_member';
    if (room.owner !== soc.code) return 'not_owner';
    const target = peerOfCode(raw);
    if (!target) return 'not_found';
    if (target.id === c.id || target.code === soc.code) return 'self';
    if (store.isBlocked(c.id, target.code)) return 'invalid';        // I blocked them: unblock first (same as a whisper)
    if (store.isBlocked(target.id, soc.code)) return 'not_found';    // they blocked me: reads as a wrong code
    if (!soc.friends.includes(target.code)) return 'not_friend';
    const op = rooms.invite(roomId, soc.code, target.code, Date.now());
    if (!op.ok) return op.code;
    applyRoomOp(c, op);
    log(`rooms: ${soc.code} invited ${target.code} to ${roomId}`);
    return null;
  };

  const socialError = (c: Client, code: SocialErrorCode): void => {
    sendTo(c, { t: 'social:error', code, message: SOCIAL_ERROR_MESSAGE_KO[code] });
  };
  /** My own social record, or null when this connection has no profile (anonymous → `unavailable`). */
  const socialOf = (c: Client) => (c.hasProfile ? store.ensureSocial(c.id, c.name) : null);
  /** `PlayerCode` → PeerId for an incoming request; undefined for an unknown / malformed code. */
  const peerOfCode = (raw: string): { code: PlayerCode; id: PeerId } | null => {
    const code = normalizePlayerCode(raw);
    if (!code) return null;
    const id = store.peerByCode(code);
    return id === undefined ? null : { code, id };
  };

  /**
   * Recent players: a join put two or more profiles in the same ship, so each pair remembers the other (unless
   * they are already friends). Mutation only — the caller broadcasts the fresh snapshots.
   */
  const recordMet = (lobby: Lobby, joiner: PeerId): void => {
    if (!store.social(joiner)) return;
    let any = false;
    for (const p of lobby.players.values()) {
      const id = p.id;
      if (isBotPlayer(p)) continue;   // 2026-09-15: an android is never a recent player (it has no profile)
      if (id === joiner || !store.social(id)) continue;
      if (store.recordMet(joiner, id)) { rewatch(id); any = true; }   // B-5: the new recent row is watched at once
    }
    if (any) rewatch(joiner);
  };

  /* ── 2026-09-11 (B-11): two people who blocked each other never stand in one squad ────── */
  /**
   * true when the profile `owner` has blocked `other`. A block is kept **by code**, so a profile without a social
   * record (anonymous, or one that never connected with a token) can neither block nor be blocked.
   */
  const blocks = (owner: PeerId, other: PeerId): boolean => {
    const code = store.card(other)?.code;
    return code !== undefined && store.isBlocked(owner, code);
  };

  /**
   * Why `joiner` must not be put into `lobby` because of a block, or null. **Direction decides the answer**
   * (user's decision):
   *
   * - a member `joiner` has blocked → `'blocked'`: it is my own choice, so it is told plainly.
   * - a member who has blocked `joiner` → `'not_found'`: a block must never show through, and being indistinguishable
   *   from a mistyped code is exactly the point (the invite path hides it the same way, `Invites.ts` `hidden`).
   *
   * My own direction wins when both are present — it is the one the player can act on. Callers ask this **before**
   * the join really happens, so a refusal leaves no trace in the lobby.
   */
  const blockRefusal = (lobby: Lobby, joiner: PeerId): 'blocked' | 'not_found' | null => {
    if (store.card(joiner) === null) return null;
    let hidden = false;
    for (const p of lobby.players.values()) {
      const other = p.id;
      if (isBotPlayer(p)) continue;   // 2026-09-15: an android can neither block nor be blocked
      if (other === joiner) continue;
      if (blocks(joiner, other)) return 'blocked';
      if (blocks(other, joiner)) hidden = true;
    }
    return hidden ? 'not_found' : null;
  };

  /* ── 2026-09-11 (B-3): the invite table — every invite closes exactly once, through `closeInvite`, which tells
     both sides ── */
  const inviteCode = (id: PeerId): PlayerCode => store.card(id)?.code ?? '';
  const inviteName = (id: PeerId): string => store.card(id)?.name ?? '';

  /**
   * Close `inv` with `outcome` and tell both sides: the inviter `social:inviteResult`, the invitee `social:inviteClosed`
   * — except when the invitee is the one answering (`toldInvitee`: its own reply needs no echo) and for a hidden invite
   * (the invitee never saw it). The inviter's rows lose their `inviteAt` badge on the next push. false = already closed.
   *
   * 2026-09-15: every close then asks `pruneLonely` about the invite's lobby — an undocked squad that was only waiting on
   * this invite is dissolved. `prune = false` only for `openInvite`'s `superseded` close: the replacement invite into the
   * very same lobby is added right after, so the lobby is not lonely, it just looks that way for one line.
   */
  const closeInvite = (inv: OpenInvite, outcome: InviteOutcome, reason?: SocialErrorCode, toldInvitee = false, prune = true): boolean => {
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
    if (prune) pruneLonely(lobbies.byCode(inv.lobby));
    return true;
  };

  const invites = new InviteTable({ ttlMs: opts.inviteTtlMs, onExpire: (inv) => { closeInvite(inv, 'expired'); } });

  /**
   * 2026-09-15 (squad · dock matchmaking): an **undocked**, not-started lobby with exactly one member and no open
   * invite into it is a squad of nobody — the invite that made it is gone (declined · expired · failed · offline ·
   * a block · the member left). It is
   * dissolved: the member gets `lobby:left` (no reason — nobody moved them anywhere), the lobby is deleted, presence pushed.
   *
   * Called after every path that can leave that state behind: `closeInvite` (any outcome), `announceLeave` (leave · grace
   * expiry · kick · move out) and a reconnect (`connection`, before the welcome). Re-entrancy: nothing here opens or closes an
   * invite (by definition none points at this lobby), and the `lobbies.byCode` identity check makes a second call for a lobby
   * that a nested sweep already dissolved a no-op. A member whose socket is down is left alone — its grace timer removes it
   * (and deletes the lobby) or the reconnect prunes it.
   * Returns true when the lobby was dissolved.
   */
  const pruneLonely = (lobby: Lobby | undefined): boolean => {
    if (!lobby || lobbies.byCode(lobby.code) !== lobby) return false;
    /* 2026-09-15: "alone" means exactly one **human** (an undocked squad cannot hold androids, but the test lives
       in one place). */
    if (lobby.docked || lobby.started || lobby.humanCount() !== 1) return false;
    for (const inv of invites.all()) if (inv.lobby === lobby.code) return false;
    let only: LobbyPlayer | undefined;
    for (const p of lobby.players.values()) if (!isBotPlayer(p)) { only = p; break; }
    const member = only ? clients.get(only.id) : undefined;
    if (!only || !only.connected || !member) return false;
    const res = lobbies.leave(only.id);
    if (!res) return false;
    clearMigrate(lobby.code);
    log(`lobby ${lobby.code}: dissolved — undocked squad with only ${only.name}(${only.id}) left and no open invite`);
    sendTo(member, { t: 'lobby:left' });
    pushPresence(only.id);
    return true;
  };

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
    /* 2026-09-15: the one left behind in an undocked squad with nobody invited is let go (a sweep above may already have). */
    pruneLonely(lobby);
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
    const res = lobbies.move(c.id, toCode, c.name, c.accent);
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
    announceBotReturns(res.to);   // 2026-09-15: accepting an invite · a `공개 매칭` move — humans win over bots here too
    pushLobbyPresence(res.to);
    sweepInvites();
    return { ok: true, lobby: res.to };
  };

  /**
   * `lobby:quickmatch`, and (2026-09-15) `lobby:dock {isPublic:true}` from a player with no lobby: join the best open public
   * **docked** lobby (B-11: one holding a block either way is not a candidate) or create a docked public one. The
   * caller has set `c.name`.
   */
  const quickMatchClient = (c: Client, why: string): void => {
    const res = lobbies.quickMatch(c.id, c.name || sanitizePlayerName(''), (l) => blockRefusal(l, c.id) === null, c.accent);
    if (typeof res === 'string') { sendError(c, res); return; }
    log(`lobby ${res.lobby.code}: ${why} ${res.created ? 'created (public)' : `joined (${res.lobby.size} players)`} by ${c.name}(${c.id})`);
    if (!res.created) recordMet(res.lobby, c.id);
    broadcastState(res.lobby);
    /* 2026-09-15: quick-match candidates count bots too, so no android is ever pushed out here — one rule per path
       all the same. */
    announceBotReturns(res.lobby);
    pushLobbyPresence(res.lobby);
    if (!res.created) { settleInvitesInto(c.id, res.lobby, false); sweepInvites(); }   // B-3: it may be full now
  };

  /**
   * B-3: `c` invites `targetId` into `lobby`. The pair's previous invite is `superseded`, the oldest visible invite past
   * the invitee's `SQUAD_INVITE_MAX` is closed (`failed` / `limit`), and — unless `hidden` (B-4: they blocked me) — the
   * invitee gets `social:invited` with the invite id. My rows get the `inviteAt` badge at once (my own action).
   */
  const openInvite = (c: Client, from: SocialCard, targetId: PeerId, lobby: Lobby, hidden: boolean): OpenInvite => {
    const prev = invites.pair(c.id, targetId);
    if (prev) closeInvite(prev, 'superseded', undefined, false, false);   // 2026-09-15: the new invite keeps the lobby alive — no prune
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
      // The training range is entered and left individually and holds no body — only a **raid** keeps the slot,
      // and only while somebody else is still actually inside it (the last member inside expiring ends the mission,
      // as before).
      /* 2026-09-15: "somebody still inside" — androids do not count (a raid left to bots is an abandoned one). */
      let othersInside = 0;
      if (lobby) for (const p of lobby.players.values()) if (p.id !== c.id && p.connected && p.inMission && !isBotPlayer(p)) othersInside++;
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
        const res = lobbies.create(c.id, c.name, false, { accent: c.accent });   // 2026-09-15: docked, as before
        if (typeof res === 'string') { sendError(c, res); return; }
        log(`lobby ${res.code}: created (private) by ${c.name}(${c.id})`);
        broadcastState(res);
        pushPresence(c.id);
        return;
      }

      case 'lobby:quickmatch': {
        c.name = sanitizePlayerName(m.name);
        quickMatchClient(c, 'quickmatch');
        return;
      }

      /* appended: 2026-09-15 — squad · dock matchmaking. The `비공개 매칭` / `공개 매칭` of 터미널 > 매칭. */
      case 'lobby:dock': {
        const mine = lobbies.lobbyOf(c.id);
        const name = c.name || sanitizePlayerName('');
        if (!mine) {
          /* No squad: private = a docked private lobby of my own, public = the old quick match unchanged (join an
             open public ship, or open a new one). */
          if (m.isPublic) { quickMatchClient(c, 'dock public'); return; }
          const res = lobbies.create(c.id, name, false, { accent: c.accent });
          if (typeof res === 'string') { sendError(c, res); return; }
          log(`lobby ${res.code}: created (private, docked) by ${name}(${c.id}) — 비공개 매칭`);
          broadcastState(res);
          pushPresence(c.id);
          return;
        }
        if (mine.hostId !== c.id) { sendError(c, 'not_host'); return; }
        if (mine.started) { sendError(c, 'started'); return; }
        if (mine.docked) { sendError(c, 'in_lobby'); return; }
        if (m.isPublic && mine.size === 1) {
          /*
           * A lone leader (one that only has an invite out) is a "lone player" — with an open public ship around it
           * **moves over into it**. The old lobby is emptied and deleted, and the invite pointing at it fails in the
           * ordinary sweep (`failed / not_found`). With even one squadmate this branch is never taken — squads never
           * merge (user's decision).
           */
          const open = lobbies.findQuickMatch((l) => l !== mine && blockRefusal(l, c.id) === null);
          if (open) {
            const moved = moveToLobby(c, open.code, '공개 매칭');
            if (moved.ok) return;
            log(`lobby ${mine.code}: 공개 매칭 move into ${open.code} refused (${moved.code}) → docking own lobby instead`);
          }
        }
        /* Docking in place: a private one takes invites only, a public one becomes a quick-match candidate (only a
           lone matcher fills its free slots). */
        mine.docked = true;
        mine.isPublic = m.isPublic;
        log(`lobby ${mine.code}: docked (${m.isPublic ? 'public' : 'private'}, ${mine.size} players) by ${c.name}(${c.id})`);
        broadcastState(mine);
        return;
      }

      /*
       * appended: 2026-09-15 — android squadmates. The result of the squad leader holding a bay in the shared
       * ship's cockpit for 3 s. The order: in a lobby → the leader → docked → not started → the bay (its range ·
       * already in that state) → a free slot. Only the last one is `full`, and then `lobby:androidReturned
       * {reason:'full'}` goes with the error **to the sender alone** (the cockpit animation runs back).
       */
      case 'lobby:android': {
        const lobby = lobbies.lobbyOf(c.id);
        if (!lobby) { sendError(c, 'not_in_lobby'); return; }
        if (lobby.hostId !== c.id) { sendError(c, 'not_host'); return; }
        if (!lobby.docked) { sendError(c, 'not_docked'); return; }   // android bays exist only in a shared ship
        if (lobby.started) { sendError(c, 'started'); return; }
        if (m.bay < 0 || m.bay >= ANDROID_BAY_COUNT) { sendError(c, 'invalid'); return; }
        const cur = lobby.botOnBay(m.bay);
        if (m.recruit === (cur !== null)) { sendError(c, 'invalid'); return; }   // already in that state
        if (m.recruit) {
          const res = lobby.addBot(m.bay, Date.now());
          if (typeof res === 'string') {
            sendError(c, res);
            if (res === 'full') sendTo(c, { t: 'lobby:androidReturned', bay: m.bay, reason: 'full' });
            return;
          }
          log(`lobby ${lobby.code}: android bay ${m.bay} recruited into slot ${res.slot} (${lobby.humanCount()} humans, ${lobby.botCount()} androids)`);
        } else {
          lobby.removeBot(m.bay);
          log(`lobby ${lobby.code}: android bay ${m.bay} dismissed (${lobby.humanCount()} humans, ${lobby.botCount()} androids)`);
        }
        broadcastState(lobby);
        pushLobbyPresence(lobby);
        return;
      }

      /* appended: 2026-09-15 — the accent colour of the face tiles in the `매칭` tab. A bad value is silently
         ignored (never refused). */
      case 'lobby:look': {
        const accent = sanitizeAccent(m.accent);
        /* 2026-09-21 (B-101): `shipModel` is no longer **taken** from the client — it is only a nudge saying
           「my ship changed, re-read it」. The value the squad receives comes from the sender's own `progression`
           document (`lobbyState` → `Store.shipModel`), so a purchase can never be self-declared. The field is still
           shape-checked so a malformed one is ignored rather than forcing a broadcast. */
        const shipNudge = sanitizeShipModel(m.shipModel) !== null;
        if (accent === null && !shipNudge) return;
        if (accent !== null) c.accent = accent;
        const lobby = lobbies.lobbyOf(c.id);
        if (!lobby) return;
        let changed = false;
        if (accent !== null && lobby.setAccent(c.id, accent)) changed = true;
        /* The value written is the **store's**, never the sender's, and only a real change broadcasts — a nudge that
           moves nothing must stay silent, or the `lobby:state` it causes nudges the sender right back. */
        const ship = shipNudge ? store.shipModel(c.id) : null;
        if (ship !== null && lobby.setShipModel(c.id, ship)) changed = true;
        if (changed) broadcastState(lobby);
        return;
      }

      case 'lobby:join': {
        const code = normalizeLobbyCode(m.code);
        if (!isValidLobbyCode(code)) { sendError(c, 'invalid', '잘못된 로비 코드입니다.'); return; }
        c.name = sanitizePlayerName(m.name);
        /* B-11: a block is checked **before** `lobbies.join`, so a refusal never touches the lobby. */
        const target = lobbies.byCode(code);
        if (target && !lobbies.lobbyOf(c.id)) {
          const refused = blockRefusal(target, c.id);
          if (refused !== null) { sendError(c, refused); return; }
        }
        const res = lobbies.join(c.id, code, c.name, c.accent);
        if (typeof res === 'string') { sendError(c, res); return; }
        log(`lobby ${code}: ${c.name}(${c.id}) joined (${res.size} players)`);
        recordMet(res, c.id);
        broadcastState(res);
        announceBotReturns(res);   // 2026-09-15: the human won — the pushed-out android is announced, newcomer too
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
        if (!lobby.docked) { sendError(c, 'not_docked'); return; }   // 2026-09-15: an undocked squad has no pods
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
        /* 2026-09-15: an undocked squad locks the solo launch and the training range — both are refused here. */
        if (!lobby.docked) { sendError(c, 'not_docked'); return; }
        if (lobby.started) { sendError(c, 'started'); return; }
        if (mode === 'training') {
          // Any member, no ready gating: only the starter enters; the rest join later through `lobby:mission`.
          // A training has no target planet (the arena is not on a planet), so `planet` is ignored here.
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
        /* 2026-09-14 (the intel broker): the start message's wins, else the `lobby:intel` already uploaded. It has
         * to be set before `lobby.start` so `lobbyState(lobby)` and `game:start.intel` carry the same value. */
        if (m.intel !== undefined) lobby.intel = m.intel;
        const intel = lobby.intel;
        lobby.start(m.seed, 'raid', c.id);
        log(`lobby ${lobby.code}: started seed=${m.seed} planet=${planet}${intel ? ` intel=${intel.picks.map((p) => `${p.g}${p.tier}`).join(',')}` : ''} players=${lobby.size} (${lobby.connectedCount()} connected)`);
        broadcast(lobby, { t: 'game:start', seed: m.seed, lobby: lobbyState(lobby), mode: 'raid', planet, intel });
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

      /* appended: 2026-09-14 — the intel broker. Host only · before the start. The server sanitizes **the shape
         only** and broadcasts it as it is (it computes no layout). */
      case 'lobby:intel': {
        const lobby = lobbies.lobbyOf(c.id);
        if (!lobby) { sendError(c, 'not_in_lobby'); return; }
        if (lobby.hostId !== c.id) { sendError(c, 'not_host'); return; }
        if (lobby.started) { sendError(c, 'started'); return; }
        lobby.intel = m.intel;
        log(`lobby ${lobby.code}: intel=${m.intel ? `${m.intel.seed}/${m.intel.picks.map((p) => `${p.g}${p.tier}`).join(',')}` : '—'} (by ${c.name})`);
        broadcastState(lobby);
        return;
      }

      /* appended: 2026-09-09 — host transfer by nomination */
      case 'lobby:transferHost': {
        const lobby = lobbies.lobbyOf(c.id);
        if (!lobby) { sendError(c, 'not_in_lobby'); return; }
        /*
         * Exactly two cases pass: ① the sender is the host right now, ② it is a `claim` and the current host has
         * raised its down flag with `lobby:hostDown` (somebody picked up the squad-leader device beside the corpse).
         * Anything else is `not_host`.
         */
        const isHost = lobby.hostId === c.id;
        const claiming = m.claim === true && lobby.hostDown && !isHost;
        if (!isHost && !claiming) { sendError(c, 'not_host'); return; }
        const target = lobby.get(m.targetId);
        /* 2026-09-15: an android cannot be the squad leader — there is no client to run the simulation (the same
           rule as `Lobby.transferHostTo`). */
        if (!target || !target.connected || isBotPlayer(target)) { sendError(c, 'invalid', '분대에 없는(또는 접속이 끊긴) 대원입니다.'); return; }
        if (lobby.hostId === m.targetId) {
          // They are the leader already — only the down flag is cleared and the state echoed back (the same
          // convention as `lobby:planet`'s no-op).
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
        if (m.inMission && !lobby.docked) { sendError(c, 'not_docked'); return; }   // 2026-09-15 (`false` stays allowed)
        if (m.inMission && !lobby.started) { sendError(c, 'in_mission'); return; }
        // 2026-09-15 (abandoning the raid from the title): an abandoned raid can never be entered again (the
        // training range has nothing to do with drifting — the flag is raised in a raid only)
        if (m.inMission && lobby.get(c.id)?.drifted) { sendError(c, 'drifted'); return; }
        lobby.setInMission(c.id, m.inMission);
        log(`lobby ${lobby.code}: ${c.name}(${c.id}) inMission=${m.inMission}${m.keep ? ' (reload, blob kept)' : ''} (${lobby.inMissionCount()} in mission)`);
        // 2026-09-15: a reload (`keep`) keeps the blob — the next boot's title resumes or abandons the raid with it
        if (!m.inMission) { if (!m.keep) lobby.raid.delete(c.id); migrateHostAway(lobby, c.id); }
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

      /* appended: 2026-09-15 — abandoning the raid from the title: death + drifting (`Lobby.setDrifted`). */
      case 'lobby:abandon': {
        const lobby = lobbies.lobbyOf(c.id);
        if (!lobby) { sendError(c, 'not_in_lobby'); return; }
        if (!lobby.started || (lobby.mode ?? 'raid') !== 'raid') { sendError(c, 'not_started'); return; }
        // Already drifted (a double press · a resend) — nothing to change, just the current state back
        if (lobby.get(c.id)?.drifted) { sendTo(c, { t: 'lobby:state', lobby: lobbyState(lobby) }); return; }
        if (!lobby.setDrifted(c.id)) { sendError(c, 'invalid'); return; }
        let note = '';
        if (migrateHostAway(lobby, c.id)) note += ` → host now ${lobby.hostId}`;
        if (autoResetMission(lobby)) note += ' → mission over → reset';
        log(`lobby ${lobby.code}: ${c.name}(${c.id}) abandoned the raid → drifted${note}`);
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

      /* ── appended: Phase 11 — social. Every branch needs a profile; an anonymous socket gets `unavailable`. ── */
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

      /* appended: 2026-09-11 (B-4) — blocks */
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
        /* They already sit in my squad (answered before the leader gate — a member asking about a squadmate hears `in_squad`). */
        if (mine && mine.has(target.id)) { socialError(c, 'in_squad'); return; }
        /*
         * 2026-09-15 (squad · dock matchmaking): `같이 하기` is **invite only** — the old branch "they already have a
         * ship → I move into it"
         * is gone. The same gate the UI greys the button out with (`playBlockReason`, `iAmMember` = I am in a squad I do not
         * lead), mapped onto the error codes.
         */
        /* 2026-09-15: my squad's size counts **humans only** — even a squad filled with androids can invite
         * somebody it knows (humans win over bots — on an accept the latest-recruited unit goes back to its bay). */
        const block: PlayBlock | null = playBlockReason(
          presenceOf(target.id), mine?.humanCount() ?? 0, NET_MAX_PLAYERS, false, mine !== undefined && mine.hostId !== c.id,
        );
        if (block !== null) {
          const code: SocialErrorCode = block === 'offline' ? 'offline' : block === 'in_mission' ? 'in_mission'
            : block === 'my_squad_full' ? 'my_squad_full' : block === 'in_other_squad' ? 'in_other_squad'
              : block === 'not_leader' ? 'not_leader' : block === 'self' ? 'self' : block === 'in_squad' ? 'in_squad'
                : 'full';   // squad_full: no longer produced
          socialError(c, code);
          return;
        }
        const name = store.card(target.id)?.name ?? '';
        /* B-4: they blocked me — an ordinary-looking invite they never see, which ends `expired` for me. */
        const blockedByThem = blocks(target.id, c.id);
        let lobby = mine;
        if (lobby === undefined) {
          /* No squad yet: sending the invite makes me its leader at once — **undocked**, everyone stays in their own ship. */
          const created = lobbies.create(c.id, c.name || sanitizePlayerName(''), false, { docked: false, accent: c.accent });
          if (typeof created === 'string') { socialError(c, 'invalid'); return; }
          lobby = created;
          log(`lobby ${lobby.code}: created (private, undocked squad) by ${c.name}(${c.id}) for 같이 하기`);
          broadcastState(lobby);
          pushPresence(c.id);
        } else if (!lobby.isJoinable()) { socialError(c, 'busy'); return; }   // a raid running (a training keeps the ship open)
        else if (lobby.canAdd() === 'full') { socialError(c, 'my_squad_full'); return; }
        openInvite(c, soc, target.id, lobby, blockedByThem);
        sendTo(c, { t: 'social:play', code: target.code, name, outcome: 'invited' });
        return;
      }

      /* appended: 2026-09-11 (B-3) — the invite reply. Accepting is a server-side move (B-6), so every refusal is
         one `social:error`. */
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
        /* 2026-09-15: "dragging a squad along" means two or more **humans** — someone who only has androids with
         * them is alone (on the move the old lobby loses its last human and those units go with it,
         * `LobbyManager.leave`). */
        if (mine && (mine.humanCount() > 1 || (mine.get(c.id)?.inMission ?? false))) { socialError(c, 'busy'); return; }
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

      /* ── appended: 2026-09-13 — crypto prices. Anonymous sockets too (prices are not secret). ── */
      case 'crypto:watch': {
        if (!market) return;
        c.cryptoWatch = m.on;
        if (m.on) sendTo(c, market.pricesMessage());
        return;
      }
      case 'crypto:history': {
        if (!market) return;
        const now = Date.now();
        c.cryptoTokens = Math.min(CRYPTO_HISTORY_BURST, c.cryptoTokens + ((now - c.cryptoTokensAt) / 1000) * CRYPTO_HISTORY_PER_S);
        c.cryptoTokensAt = now;
        if (c.cryptoTokens < 1) return;   // over the rate: dropped silently, like an unknown coin
        c.cryptoTokens -= 1;
        const candles = market.history(m.coin, m.range);
        if (!candles) return;
        sendTo(c, { t: 'crypto:history', coin: m.coin, range: m.range, at: market.pricesAt, candles });
        return;
      }

      /* ── appended: 2026-09-14 — group rooms. Profile sockets only (anonymous → `unavailable`).
       * `create` / `say` answer with `room:ack {nonce}`; every other refusal is `room:error`. ── */
      case 'room:get': {
        if (!socialOf(c)) { roomError(c, 'unavailable'); return; }
        roomPushes.now(c.id);
        return;
      }
      case 'room:create': {
        const soc = socialOf(c);
        if (!soc) { sendTo(c, { t: 'room:ack', nonce: m.nonce, ok: false, code: 'unavailable' }); return; }
        const op = rooms.create(roomActor(soc), m.name, Date.now());
        if (!op.ok) { sendTo(c, { t: 'room:ack', nonce: m.nonce, ok: false, code: op.code }); return; }
        sendTo(c, { t: 'room:ack', nonce: m.nonce, ok: true, room: op.roomId, at: op.lines[0]?.at ?? Date.now() });
        applyRoomOp(c, op);
        let invited = 0;
        for (const code of m.invite ?? []) if (inviteToRoom(c, soc, op.roomId, code) === null) invited++;
        log(`rooms: ${soc.code} created ${op.roomId} (${op.room?.name ?? ''}) with ${invited} invite(s)`);
        return;
      }
      case 'room:invite': {
        const soc = socialOf(c);
        if (!soc) { roomError(c, 'unavailable'); return; }
        const err = inviteToRoom(c, soc, m.room, m.code);
        if (err) roomError(c, err);
        return;
      }
      case 'room:reply': {
        const soc = socialOf(c);
        if (!soc) { roomError(c, 'unavailable'); return; }
        const op = rooms.reply(m.room, roomActor(soc), m.accept, Date.now());
        if (!op.ok) { roomError(c, op.code); roomPushes.now(c.id); return; }   // the refusal also refreshes my invite list
        applyRoomOp(c, op);
        log(`rooms: ${soc.code} ${m.accept ? 'joined' : 'declined'} ${m.room}`);
        return;
      }
      case 'room:leave': {
        const soc = socialOf(c);
        if (!soc) { roomError(c, 'unavailable'); return; }
        const op = rooms.leave(m.room, roomActor(soc), Date.now());
        if (!op.ok) { roomError(c, op.code); return; }
        applyRoomOp(c, op);
        log(`rooms: ${soc.code} left ${m.room}${op.room ? '' : ' (deleted — nobody left)'}`);
        return;
      }
      case 'room:kick': {
        const soc = socialOf(c);
        if (!soc) { roomError(c, 'unavailable'); return; }
        const code = normalizePlayerCode(m.code);   // a member whose profile is gone can still be kicked by code
        if (!code) { roomError(c, 'not_found'); return; }
        const op = rooms.kick(m.room, roomActor(soc), code, Date.now());
        if (!op.ok) { roomError(c, op.code); return; }
        applyRoomOp(c, op);
        log(`rooms: ${soc.code} kicked ${code} from ${m.room}`);
        return;
      }
      case 'room:rename': {
        const soc = socialOf(c);
        if (!soc) { roomError(c, 'unavailable'); return; }
        const op = rooms.rename(m.room, roomActor(soc), m.name, Date.now());
        if (!op.ok) { roomError(c, op.code); return; }
        applyRoomOp(c, op);
        return;
      }
      case 'room:say': {
        const refuse = (code: RoomErrorCode): void => { sendTo(c, { t: 'room:ack', nonce: m.nonce, ok: false, code }); };
        const soc = socialOf(c);
        if (!soc) { refuse('unavailable'); return; }
        const now = Date.now();
        c.roomTokens = Math.min(ROOM_SAY_BURST, c.roomTokens + ((now - c.roomTokensAt) / 1000) * ROOM_SAY_PER_S);
        c.roomTokensAt = now;
        if (c.roomTokens < 1) { refuse('limit'); return; }
        const op = rooms.say(m.room, roomActor(soc), m.text, now);
        if (!op.ok) { refuse(op.code); return; }
        c.roomTokens -= 1;
        sendTo(c, { t: 'room:ack', nonce: m.nonce, ok: true, room: op.roomId, at: op.lines[0].at });
        applyRoomOp(c, op, c.id);
        return;
      }
      case 'room:history': {
        const soc = socialOf(c);
        if (!soc) { roomError(c, 'unavailable'); return; }
        const res = rooms.history(m.room, soc.code, m.before);
        if (!res.ok) { roomError(c, res.code); return; }
        sendTo(c, { t: 'room:history', room: m.room, lines: res.lines, more: res.more });
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
          /* 2026-09-15: an android has no socket — a lobby member it may be, but never a relay target (dropped
             silently). */
          if (isAndroidId(m.to)) return;
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
    const { token, name, accent } = parseConnectQuery(req);
    const id = token ? peerIdFromToken(token) : randomPeerId();
    const c: Client = {
      id, ws, alive: true, name: name ?? '', remote: req.socket.remoteAddress ?? '?', hasProfile: token !== null,
      connectedAt: Date.now(), kicked: false,
      cryptoWatch: false, cryptoTokens: CRYPTO_HISTORY_BURST, cryptoTokensAt: Date.now(),
      roomTokens: ROOM_SAY_BURST, roomTokensAt: Date.now(),
      accent,
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
    /* Phase 11: a token connection gets (or is given) a code and its social snapshot; anonymous gets neither. */
    if (c.hasProfile) { store.ensureSocial(id, c.name); store.touchSeen(id); }
    if (lobby) {
      const wasDown = clearGrace(id) || !(lobby.get(id)?.connected ?? true);
      lobby.setConnected(id, true);
      // A returning host inside the migrate delay keeps the role; after it, `welcome.lobby.hostId` tells it otherwise.
      if (lobby.hostId === id) clearMigrate(lobby.code);
      if (c.name) lobby.setName(id, c.name); else c.name = lobby.get(id)?.name ?? '';
      /* 2026-09-15: same rule for the accent — a fresh `?a=` wins, otherwise the socket inherits the slot's. */
      if (c.accent) lobby.setAccent(id, c.accent); else c.accent = lobby.get(id)?.accent ?? null;
      let note = '';
      if (old) {
        // Phase 9: a replaced socket is a new page — that page is not inside the mission any more (the client also
        // reports `lobby:mission false` itself on a plain reload; here the old socket never got to). A host that was
        // inside hands the authority to a connected in-mission member.
        const me = lobby.get(id);
        if (lobby.started && me?.inMission) {
          lobby.setInMission(id, false);
          // 2026-09-15 (title resume): the blob is kept — a replaced socket is the same event as a reload
          // (`lobby:mission {false, keep}`), and the new page's title resumes or abandons the raid with that blob
          // (it used to be dropped here, so a resume vanished in the race with a reload)
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
      /*
       * 2026-09-15: an undocked squad I sat in alone, whose invites all closed while my socket was down, was left to this
       * moment (`pruneLonely` skips a disconnected member). The resume goes out first and the dissolve follows as an
       * ordinary `lobby:left` — the client drops it as "left", not as a lost connection (a welcome without `lobby`).
       */
      pruneLonely(lobby);
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
      /* 2026-09-14: my rooms + open room invites right after the welcome (clients never ask on their own), and room-mates see me online. */
      roomPushes.now(id);
      markRoomPeers(id);
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
        if (c.hasProfile) markRoomPeers(c.id);   // 2026-09-14: room-mates see me offline
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

  /* ── 2026-09-13: crypto prices — every tick that moved the market goes to the watching sockets (one JSON) ── */
  if (market) {
    market.onTick = (msg) => {
      let text: string | null = null;
      for (const c of clients.values()) {
        if (!c.cryptoWatch || c.ws.readyState !== WebSocket.OPEN) continue;
        text ??= JSON.stringify(msg);
        try { c.ws.send(text); } catch { /* the close handler cleans up */ }
      }
    };
    market.start();
  }

  /* ── C-29: operator console (server/Console.ts) ──────────────────────── */
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

  /**
   * 2026-09-15: an android bot is not in the `byPeer` index (it has no socket, so it does not fit what that index
   * means — "the lobby this person is in"). The lobbies are walked only for the operator console's
   * `kick <an android id>` (there is only ever a handful of lobbies).
   */
  const lobbyOfBot = (id: PeerId): Lobby | undefined => {
    if (!isAndroidId(id)) return undefined;
    for (const l of lobbies.lobbies.values()) if (l.has(id)) return l;
    return undefined;
  };

  /** A typed target → PeerId: an exact connected / lobby-member id first, then a code (dash and case ignored). */
  const resolveKickTarget = (raw: string): PeerId | null => {
    const text = raw.trim();
    if (!text) return null;
    if (clients.has(text) || lobbies.lobbyOf(text) || lobbyOfBot(text)) return text;
    const code = normalizePlayerCode(text);
    if (!code) return null;
    return store.peerByCode(code) ?? null;
  };

  const kick = (idOrCode: string, reason?: string): RelayKickResult => {
    const id = resolveKickTarget(idOrCode);
    /*
     * 2026-09-15: kicking an android is the same thing as sending it back to its bay — there is no socket to close
     * and no grace. No `lobby:androidReturned` is sent (that news has only two reasons: a human joined · the squad
     * is full). The fresh `lobby:state` makes everyone read the roster again — a client's android roster comes out
     * of the lobby state.
     */
    const botLobby = id !== null ? lobbyOfBot(id) : undefined;
    if (id !== null && botLobby) {
      const bot = botLobby.get(id);
      const removed = bot ? botLobby.removeBot(bot.bay ?? -1) : null;
      if (!removed) return { ok: false, reason: 'not_found' };
      log(`kick ${removed.name}(${id}) from lobby ${botLobby.code} (android bay ${removed.bay} → back to its slot)`);
      broadcastState(botLobby);
      return { ok: true, id, name: removed.name, connected: false, lobby: botLobby.code };
    }
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
    /* 2026-09-14: a collected code leaves its rooms (owner handoff / empty room deleted); expired invites go too. */
    const rg = rooms.collectGarbage((code) => store.peerByCode(code) !== undefined, now);
    for (const code of rg.notify) {
      const pid = store.peerByCode(code);
      if (pid !== undefined && clients.get(pid)?.hasProfile) roomPushes.mark(pid);
    }
    for (const { room, line } of rg.lines) sendRoomLine(room, line);
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
        crypto: market,
        rooms,
        close: () => new Promise<void>((done) => {
          clearInterval(heartbeat);
          market?.close();   // 2026-09-13: stops the tick timer, writes crypto.json synchronously
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
          roomPushes.close();   // 2026-09-14
          rooms.close();        // 2026-09-14: writes rooms.json synchronously
          store.close();
          for (const c of clients.values()) { try { c.ws.terminate(); } catch { /* ignore */ } }
          wss.close(() => { http.close(() => done()); });
        }),
      });
    });
  });
}
