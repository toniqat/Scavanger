import type { PeerId } from './net';

/* ────────────────────────────────────────────────────────────────────────────
 * Social — 아이디 · 친구 · 최근 만난 플레이어 · 귓속말 · 분대 초대 (Phase 11, 2026-09-07).
 *
 * Until Phase 11 a player only existed **inside a lobby**: `LobbyPlayer.name` was the only name anyone else could
 * see, and it vanished the moment the ship undocked. The social layer adds the missing half — a stable public
 * **아이디**, a friends list that survives a session, the last people you were matched with, a whisper channel that
 * works outside a lobby, and squad invites.
 *
 * Identity. The relay already derives a stable `PeerId` from the session token (`sha256(token)`, 12 url-safe chars)
 * and keys the profile store with it. That id is public but unreadable, so a **`PlayerCode`** is derived from it
 * (`playerCodeFrom`) using an alphabet with no I/O/0/1 — 8 characters, displayed in two groups (`AB3D-9KMN`). The
 * server assigns it once, stores it on the profile record and keeps a code → PeerId index; a collision (two peer ids
 * hashing to the same code) is resolved by re-deriving with the next `salt` and storing the result. **The code, not
 * the PeerId, is what travels in every social message and what the player reads and types.**
 *
 * Storage. Friends / requests / the recent list are **server-owned** fields on `ProfileRecord` (not one of the opaque
 * `docs` — the server has to read and cross-reference them). Nothing social is persisted client-side: with no relay
 * the whole feature is simply absent (`SocialRef.available === false`) and the ESC screen says so.
 *
 * This file is imported by the browser AND the Node server (type-only there apart from the pure helpers below).
 * Owner: shared/. `server/` owns the store + presence fan-out, `net/` publishes `ctx.net.social`, `ui/` draws the
 * ESC social column, the community icon and the whisper mode, `hub/` shows nothing of it (ship-only by decision).
 * ──────────────────────────────────────────────────────────────────────────── */

/** A player's public 아이디, e.g. `AB3D-9KMN`. Derived from the PeerId, stable for the life of the session token. */
export type PlayerCode = string;

/** Crockford-ish: no I, O, 0, 1 — a code is read aloud and typed by hand. Same spirit as `NET_LOBBY_ALPHABET`. */
export const PLAYER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const PLAYER_CODE_LENGTH = 8;
/** Display grouping: `AB3D-9KMN`. The stored / wire form is the 8 bare characters. */
export const PLAYER_CODE_GROUP = 4;

/**
 * Deterministic code for a peer id. Pure and shared so the server can assign it and a test can predict it.
 * `salt` is only ever non-zero when the server found a collision with a different peer id.
 */
export function playerCodeFrom(peerId: PeerId, salt = 0): PlayerCode {
  let h1 = 0x811c9dc5 ^ (salt * 0x9e3779b1);
  let h2 = 0x1000193 ^ (salt * 0x85ebca6b);
  for (let i = 0; i < peerId.length; i++) {
    const c = peerId.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c + i, 0x85ebca6b) >>> 0;
  }
  let out = '';
  for (let i = 0; i < PLAYER_CODE_LENGTH; i++) {
    const src = i < 4 ? h1 : h2;
    const shift = (i % 4) * 5;
    out += PLAYER_CODE_ALPHABET[(src >>> shift) & 31];
  }
  return out;
}

/** `AB3D9KMN` → `AB3D-9KMN`. The only place a dash is added; never store or send the dashed form. */
export function formatPlayerCode(code: PlayerCode): string {
  if (code.length <= PLAYER_CODE_GROUP) return code;
  return `${code.slice(0, PLAYER_CODE_GROUP)}-${code.slice(PLAYER_CODE_GROUP)}`;
}

/** Accepts what a player typed (lower case, dashes, spaces) and returns the canonical 8-char form, or ''. */
export function normalizePlayerCode(raw: string): PlayerCode {
  const up = (raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return up.length === PLAYER_CODE_LENGTH && isValidPlayerCode(up) ? up : '';
}

export function isValidPlayerCode(code: string): boolean {
  if (typeof code !== 'string' || code.length !== PLAYER_CODE_LENGTH) return false;
  for (const ch of code) if (!PLAYER_CODE_ALPHABET.includes(ch)) return false;
  return true;
}

/* ── Presence ─────────────────────────────────────────────────────────────── */

/**
 * Where a player is, as far as the relay knows.
 * - `offline` — no socket (a member inside the 5-minute reconnect grace also reads `offline`: they are gone *now*).
 * - `ship` — connected and not in a running mission (personal ship, shared ship, title screen, docking).
 * - `raid` — inside a started raid.
 * - `training` — inside a 시뮬레이션 훈련장.
 */
export type PresenceState = 'offline' | 'ship' | 'raid' | 'training';

export const PRESENCE_LABELS: Readonly<Record<PresenceState, string>> = {
  offline: '오프라인', ship: '함선', raid: '임무 중', training: '훈련장',
};

/** The minimum a player is known by. `level` is pushed by the owner (`social:me`); 0 = never reported. */
export interface SocialCard {
  code: PlayerCode;
  name: string;
  level: number;
}

/** One row in the ESC social column, resolved by the server (the client never sees another profile's raw record). */
export interface SocialPlayer extends SocialCard {
  presence: PresenceState;
  /** Members in their squad: 0 = 개인 함선 / no lobby, 1..NET_MAX_PLAYERS = lobby size. */
  squad: number;
  /** Server's verdict on 같이 하기 for *this* requester right now (see `playBlockReason`). UI greys out when false. */
  joinable: boolean;
  /** Recent list only: epoch ms we last shared a ship. */
  at?: number;
}

/** Everything the ESC screen renders. Sent whole (`social:state`) — small enough that deltas are not worth it. */
export interface SocialSnapshot {
  me: SocialCard;
  friends: SocialPlayer[];
  /** Friend requests I received, newest first. */
  incoming: SocialPlayer[];
  /** Friend requests I sent and that are still pending. */
  outgoing: SocialPlayer[];
  /** People I was matched with and have NOT befriended, newest first, at most `SOCIAL_RECENT_MAX`. */
  recent: SocialPlayer[];
}

/** A squad invite waiting for a P-hold. Lives only in memory on the receiving client. */
export interface SquadInvite {
  from: PlayerCode;
  name: string;
  /** Lobby code to join on accept — the client calls the ordinary `net.joinLobby(lobby)`. */
  lobby: string;
  /** `ctx.net.serverNow()` when it arrived; expires `SQUAD_INVITE_TTL_S` later. */
  at: number;
}

/** One whisper line. `out` = I sent it (the echo the sender renders locally). */
export interface WhisperLine {
  code: PlayerCode;
  name: string;
  text: string;
  at: number;
  out: boolean;
}

/* ── Rules (pure — the UI greys out with them, the server refuses with them) ─ */

/**
 * Why 같이 하기 cannot be offered, or null when it can. `mySquad` = members in my own lobby (0 = none).
 * `maxSquad` is `NET_MAX_PLAYERS`; passed in so this file stays free of a runtime import from `net.ts`.
 */
export type PlayBlock = 'self' | 'offline' | 'in_mission' | 'squad_full' | 'my_squad_full';

export function playBlockReason(
  target: Pick<SocialPlayer, 'presence' | 'squad'>, mySquad: number, maxSquad: number, isSelf = false,
): PlayBlock | null {
  if (isSelf) return 'self';
  if (target.presence === 'offline') return 'offline';
  if (target.presence !== 'ship') return 'in_mission';
  if (target.squad >= maxSquad) return 'squad_full';
  /* Joining them frees my slot; inviting them needs a slot on my side. Only the invite direction can fail here. */
  if (target.squad === 0 && mySquad >= maxSquad) return 'my_squad_full';
  return null;
}

export const PLAY_BLOCK_LABELS: Readonly<Record<PlayBlock, string>> = {
  self: '본인입니다',
  offline: '오프라인',
  in_mission: '임무 중',
  squad_full: '상대 분대가 가득 참',
  my_squad_full: '내 분대가 가득 참',
};

/** How the server resolved a 같이 하기 (`social:play`), reported back so the UI can toast the right sentence. */
export type PlayOutcome =
  /** The target was in a shared ship and I was moved into their lobby — a docking cutscene follows. */
  | 'joined'
  /** The target has no squad: an invite was sent to them (mine was created first when I had none). */
  | 'invited';

export type SocialErrorCode =
  | 'unavailable'   // no profile (anonymous socket) / the server has no store
  | 'not_found'     // unknown 아이디
  | 'self'
  | 'offline'
  | 'already'       // already friends / already sent
  | 'limit'         // SOCIAL_FRIEND_MAX / SOCIAL_REQUEST_MAX / SOCIAL_RECENT_MAX
  | 'busy'          // 같이 하기 while I lead a squad with other members in it
  | 'full'          // target squad full
  /* appended alongside the first draft: `playBlockReason` distinguishes these, so the messages must too. */
  | 'my_squad_full' // my own squad has no free slot to invite them into
  | 'in_squad'      // they are already in my squad
  | 'in_mission'
  | 'invalid';

export const SOCIAL_ERROR_MESSAGE_KO: Readonly<Record<SocialErrorCode, string>> = {
  unavailable: '소셜 기능을 사용할 수 없습니다',
  not_found: '해당 아이디를 찾을 수 없습니다',
  self: '본인에게는 보낼 수 없습니다',
  offline: '상대가 접속 중이 아닙니다',
  already: '이미 처리된 요청입니다',
  limit: '목록이 가득 찼습니다',
  busy: '분대를 먼저 해체하거나 초대를 보내세요',
  full: '상대 분대가 가득 찼습니다',
  my_squad_full: '내 분대가 가득 찼습니다',
  in_squad: '이미 같은 분대입니다',
  in_mission: '상대가 임무 중입니다',
  invalid: '잘못된 요청입니다',
};

/* ── Caps / timings ───────────────────────────────────────────────────────── */

/** 최근 만난 플레이어 kept per profile (the spec's 최대 20명). */
export const SOCIAL_RECENT_MAX = 20;
export const SOCIAL_FRIEND_MAX = 100;
/** Incoming + outgoing friend requests kept per profile. */
export const SOCIAL_REQUEST_MAX = 50;
/** Characters of one whisper (the relay truncates; `sanitizePlayerName` already caps names at 16). */
export const SOCIAL_WHISPER_MAX = 200;
/** A squad invite disappears from the panel this long after it arrived. */
export const SQUAD_INVITE_TTL_S = 90;
/** Hold 분대 초대 수락 (`Keys.INVITE`, P) this long to join. */
export const SQUAD_INVITE_HOLD_S = 3;
/** At most this many invite panels stack under the community thumbnail; older ones are dropped. */
export const SQUAD_INVITE_MAX = 3;
/** Debounce for pushing my own `social:me` (level changes fire on every XP tick). */
export const SOCIAL_ME_DEBOUNCE_MS = 2000;

/* ── Server-side record (owner: server/Store.ts; never sent to a client verbatim) ── */

/**
 * The social half of a profile. Lives on `ProfileRecord.social`, is written by the server only, and is resolved into
 * a `SocialSnapshot` before it goes out — a client never learns another player's PeerId, only their `PlayerCode`.
 */
export interface SocialRecord {
  code: PlayerCode;
  /** Salt used to derive `code` (0 unless a collision forced a re-derive). */
  salt: number;
  /** Last name this profile connected with (`?n=` / `lobby:name`), so an offline friend still has one. */
  name: string;
  /** Last level the owner reported (`social:me`); 0 = never reported. */
  level: number;
  friends: PlayerCode[];
  incoming: PlayerCode[];
  outgoing: PlayerCode[];
  recent: { code: PlayerCode; at: number }[];
  updatedAt: number;
}

/* ── appended (2026-09-11, B-2): 소셜 레코드 만료 ── */

export interface SocialRecord {
  /**
   * When each pending friend request was made (`PlayerCode` → server epoch ms), for both `incoming` and `outgoing` —
   * a code can never sit in both (`addFriendRequest` refuses `already`). Written by `addFriendRequest` on both records
   * with the same stamp. A request without a stamp (made before 2026-09-11) is stamped when the store loads it, so it
   * expires `SOCIAL_REQUEST_TTL_MS` after the upgrade rather than at once.
   */
  requestsAt?: Record<PlayerCode, number>;
}
/** A 최근 만난 플레이어 entry older than this is dropped by the relay's GC. */
export const SOCIAL_RECENT_TTL_MS = 30 * 24 * 60 * 60_000;
/** A friend request nobody answered for this long is withdrawn on both sides by the relay's GC. */
export const SOCIAL_REQUEST_TTL_MS = 30 * 24 * 60 * 60_000;

/* ── `ctx.net.social` (owner: net/SocialSync.ts) ──────────────────────────── */

/**
 * The client mirror. Every method is a no-op while `available` is false (offline / anonymous / a relay without a
 * store), and every mutation is answered by a fresh `social:state` — the client never edits the lists itself.
 */
export interface SocialRef {
  /** true once the relay answered with a snapshot for this connection. */
  readonly available: boolean;
  /** My own card (code / name / level), or null while unavailable. */
  readonly me: SocialCard | null;
  readonly friends: readonly SocialPlayer[];
  readonly incoming: readonly SocialPlayer[];
  readonly outgoing: readonly SocialPlayer[];
  readonly recent: readonly SocialPlayer[];
  /** Live squad invites, newest last, already filtered by `SQUAD_INVITE_TTL_S`. */
  readonly invites: readonly SquadInvite[];
  /** Friends whose `presence` is not `offline` — the number on the community thumbnail. */
  readonly onlineFriends: number;
  /** true while a friend request is waiting for me (the red dot on the thumbnail). */
  readonly hasNews: boolean;

  /** Ask for a fresh snapshot (the ESC screen calls it on open; `welcome` already delivers one). */
  refresh(): void;
  /** Send a friend request to a 아이디. */
  requestFriend(code: PlayerCode): void;
  /** Accept / decline a request in `incoming`. */
  respondFriend(code: PlayerCode, accept: boolean): void;
  /** Mutual removal — both profiles lose the other. */
  removeFriend(code: PlayerCode): void;
  /**
   * 같이 하기. The **server** picks the branch (`PlayOutcome`): the target already has a squad → I am moved into
   * their lobby; the target has none → an invite goes to them (and my own lobby is created first when I had none).
   */
  playWith(code: PlayerCode): void;
  /** Accept a squad invite (joins `invite.lobby` through the ordinary lobby path). Drops it from `invites`. */
  acceptInvite(from: PlayerCode): void;
  /** Dismiss an invite locally (the sender is not told — it simply expires for them). */
  dismissInvite(from: PlayerCode): void;
  /** Send a whisper. Returns false when it could not be sent (offline / unavailable / empty text). */
  whisper(code: PlayerCode, text: string): boolean;
  /** Publish my level (progression calls it on `progress:levelUp` and at load; debounced). */
  setLevel(level: number): void;
  /** Look up a row by 아이디 across friends / incoming / outgoing / recent. */
  find(code: PlayerCode): SocialPlayer | undefined;
  /** Why 같이 하기 is unavailable for this row right now, or null. Pure — mirrors the server's own check. */
  playBlock(code: PlayerCode): PlayBlock | null;
}
