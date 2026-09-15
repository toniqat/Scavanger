import type { PeerId } from './net';

/* ────────────────────────────────────────────────────────────────────────────
 * Social — 아이디 · 친구 · 최근 만난 플레이어 · 개인 대화(옛 귓속말) · 분대 초대 (Phase 11, 2026-09-07).
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
/* `in_other_squad` · `not_leader` appended (2026-09-15, 분대 · 도킹 매칭). `squad_full` is no longer produced (kept: add-only). */
export type PlayBlock = 'self' | 'offline' | 'in_mission' | 'squad_full' | 'my_squad_full' | 'in_other_squad' | 'not_leader'
  /* appended (2026-09-15, flow): 「이미 내 분대에 있다」 — `playBlockReason` 은 내지 않고, 부르는 쪽(`SocialSync.playBlock`)이 먼저 본다 (서버는 `in_squad`) */
  | 'in_squad';

/**
 * 2026-09-15 (분대 · 도킹 매칭, docs/DECISIONS.md): 같이 하기 is **invite only** now — the old branch "the target already
 * has a squad → I move into it" is gone. So a target already in a squad of 2+ cannot be asked (`in_other_squad`; a
 * player alone in their own lobby — e.g. waiting on their own invite — still can), only the leader of my squad (or a
 * player with no squad) may invite (`iAmMember` = I am in a lobby I do not lead → `not_leader`), and my squad needs a
 * free slot. The caller checks "they are already in **my** squad" first (the server answers `in_squad`).
 */
export function playBlockReason(
  target: Pick<SocialPlayer, 'presence' | 'squad'>, mySquad: number, maxSquad: number, isSelf = false, iAmMember = false,
): PlayBlock | null {
  if (isSelf) return 'self';
  if (iAmMember) return 'not_leader';
  if (target.presence === 'offline') return 'offline';
  if (target.presence !== 'ship') return 'in_mission';
  if (target.squad > 1) return 'in_other_squad';
  if (mySquad >= maxSquad) return 'my_squad_full';
  return null;
}

export const PLAY_BLOCK_LABELS: Readonly<Record<PlayBlock, string>> = {
  self: '본인입니다',
  offline: '오프라인',
  in_mission: '임무 중',
  squad_full: '상대 분대가 가득 참',
  my_squad_full: '내 분대가 가득 참',
  in_other_squad: '이미 다른 분대에 있음',
  not_leader: '분대장만 초대할 수 있음',
  in_squad: '이미 같은 분대',
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
  | 'invalid'
  /* appended (2026-09-11, B-3): the invite answered is no longer open (`social:inviteReply` after it closed). */
  | 'expired'
  /* appended (2026-09-15, 분대 · 도킹 매칭 — see `playBlockReason`) */
  | 'in_other_squad' // the target already sits in a squad of 2+ (같이 하기 is invite-only now)
  | 'not_leader';    // I am in a squad I do not lead — only the leader invites

export const SOCIAL_ERROR_MESSAGE_KO: Readonly<Record<SocialErrorCode, string>> = {
  in_other_squad: '상대가 이미 다른 분대에 있습니다',
  not_leader: '분대장만 초대할 수 있습니다',
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
  expired: '이미 끝난 초대입니다',
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

/* ── appended (2026-09-11): 초대 결과 · 차단 · 전송 확인 · 오프라인 보관 · 합치기 (B-3 · B-4 · B-5) ── */

/**
 * How a squad invite ended (B-3). The server holds invites in memory (`server/` ① — not persisted) and closes each one
 * exactly once through one function that tells **both** sides.
 * - `accepted` — the invitee accepted and the server moved them into the lobby.
 * - `declined` — the invitee said no (card ×). The inviter reads "OO 님이 초대를 거절했습니다" (user decision: distinct from expired).
 * - `expired` — `SQUAD_INVITE_TTL_S` passed on the server clock. Also what an inviter the invitee **blocked** sees (hidden).
 * - `failed` — the lobby dissolved / filled / started, or the inviter left it (`reason` says which).
 * - `offline` — the invitee's socket closed.
 * - `superseded` — the same inviter sent the same invitee a newer invite.
 */
export type InviteOutcome = 'accepted' | 'declined' | 'expired' | 'failed' | 'offline' | 'superseded';

export const SOCIAL_INVITE_OUTCOME_KO: Readonly<Record<InviteOutcome, string>> = {
  accepted: '님이 분대에 합류했습니다',
  declined: '님이 초대를 거절했습니다',
  expired: '님이 초대에 응답하지 않았습니다',
  failed: '님에게 보낸 초대가 취소되었습니다',
  offline: '님이 접속을 종료했습니다',
  superseded: '님에게 새 초대를 보냈습니다',
};

export interface SquadInvite {
  /**
   * appended (B-3): server invite id — answer with `social:inviteReply {id}`. Absent from an older server: the client
   * falls back to the Phase 11 `lobby:join` path.
   */
  id?: string;
}

export interface SocialPlayer {
  /**
   * appended (B-3, user decision "커뮤니티 행에 배지도"): server time (epoch ms) **I** sent this player a squad invite
   * that is still open. The row shows `초대 중` with the time left (`SQUAD_INVITE_TTL_S`). Absent = none open.
   */
  inviteAt?: number;
}

export interface SocialSnapshot {
  /** appended (B-4): players I blocked, newest first (unblock from the community screen). Absent from an older server. */
  blocked?: SocialCard[];
}

export interface SocialRecord {
  /** appended (B-4): 아이디 I blocked, newest first, at most `SOCIAL_BLOCK_MAX`. Server-owned; `sanitizeSocial` keeps it. */
  blocked?: PlayerCode[];
  /**
   * appended (B-4): whispers from **friends** that arrived while I was offline, oldest first — at most
   * `SOCIAL_WHISPER_INBOX_MAX`, each dropped after `SOCIAL_WHISPER_INBOX_TTL_MS`. Delivered once as
   * `social:whisperBacklog` after `welcome`, then emptied. Lives in the profile file, so the B-2 GC removes it with the profile.
   */
  inbox?: { from: PlayerCode; name: string; text: string; at: number }[];
}

export interface WhisperLine {
  /** appended (B-4): my own line's `social:whisper.nonce` — the ack finds the line by it. Absent on received lines. */
  nonce?: number;
  /**
   * appended (B-4): delivery state of an **outgoing** line. `pending` = drawn dimmed until the ack; `sent`; `stored` = kept
   * in an offline friend's inbox; `failed` (`failCode`). Absent on received lines and on an older server (treated as `sent`).
   */
  state?: 'pending' | 'sent' | 'stored' | 'failed';
  failCode?: SocialErrorCode;
  /** appended (B-4): arrived through `social:whisperBacklog` (the sender wrote it while I was offline). */
  backlog?: boolean;
}

/** B-4: players one profile may block. */
export const SOCIAL_BLOCK_MAX = 100;
/** B-4: offline whispers kept per receiver (friends only). */
export const SOCIAL_WHISPER_INBOX_MAX = 20;
/** B-4: an offline whisper nobody collected for this long is dropped. */
export const SOCIAL_WHISPER_INBOX_TTL_MS = 7 * 24 * 60 * 60_000;
/**
 * B-5: presence / social pushes to a viewer are coalesced into one `social:state` per this window. The requester's own
 * answer to `social:request` · `respond` · `remove` · `block` is **not** delayed.
 */
export const SOCIAL_PUSH_COALESCE_MS = 250;

export interface SocialRef {
  /* ── appended (2026-09-11) ── */
  /** B-4: players I blocked (empty while unavailable / older server). */
  readonly blocked: readonly SocialCard[];
  /** B-4: true when `code` is in my `blocked` list (squad chat lines from that member are not drawn). */
  isBlocked(code: PlayerCode): boolean;
  /** B-4: block / unblock. */
  block(code: PlayerCode, blocked: boolean): void;
  /**
   * B-3: decline an invite (sends `social:inviteReply {accept:false}` when the invite has an `id`; otherwise local only).
   * `dismissInvite` (the card ×) now does the same.
   */
  declineInvite(from: PlayerCode): void;
  /** B-4: this character's saved conversation with `code`, oldest first (client-side, `slotKey(WHISPER_STORAGE_KEY)`). */
  whisperHistory(code: PlayerCode): readonly WhisperLine[];
  /** B-4: conversation partners, most recent first (at most `WHISPER_HISTORY_PEERS`). */
  whisperPeers(): readonly { code: PlayerCode; name: string; at: number }[];
  /** B-4: the last player I whispered with (either direction) — the chat's `/r` target. null = none. */
  readonly lastWhisperPeer: PlayerCode | null;
}

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

/* ══ appended: 2026-09-14 — 개인 대화(옛 귓속말) 읽음 · 단체 메신저방 (docs/DECISIONS.md 「2026-09-14 — 메신저 · NPC 퀘스트 · 단체방」) ══
 * 소유: server/ (방 저장소 · 권한 · fan-out), net/ (`ctx.net.rooms` · 읽지 않음), ui/ (메신저).
 * 사용자 결정: 방장형 — 누구나 만들고 **친구를** 초대, 초대 · 강퇴 · 이름 변경은 방장만, 방장이 나가면 가장 먼저 들어온 멤버가 방장,
 * 마지막 멤버가 나가면 방 삭제. 최대 `ROOM_MEMBER_MAX` 명, 서버가 최근 `ROOM_LINES_MAX` 줄 보관. **채팅창과 연동하지 않는다** (메신저 안에서만).
 * A 에이전트(서버 · 넷)가 이 절 **안에서** 필드를 더할 수 있다 (기존 필드 변경 금지). */

/** 공식 명칭 (2026-09-14): 귓속말 → 개인 대화. UI 문자열은 이 상수를 쓴다. */
export const PRIVATE_CHAT_LABEL_KO = '개인 대화';

export interface SocialRef {
  /** 그 상대와의 개인 대화 중 읽지 않은 받은 줄 수 (슬롯 localStorage 의 상대별 readAt 기준). 옛 구현이면 없음. */
  whisperUnread?(code: PlayerCode): number;
  /** 그 상대와의 개인 대화를 읽음으로 (메신저가 그 대화를 보고 있을 때). `social:unreadChanged`. */
  markWhisperRead?(code: PlayerCode): void;
  /** 모든 상대의 읽지 않은 개인 대화 합. */
  readonly whisperUnreadTotal?: number;
}

export type RoomId = string;

export const ROOM_MEMBER_MAX = 20;
/** 서버가 방마다 보관하는 최근 줄 수. */
export const ROOM_LINES_MAX = 200;
export const ROOM_NAME_MAX = 24;
/** 한 사람이 동시에 들어가 있을 수 있는 방 수. */
export const ROOM_JOINED_MAX = 20;
/** 응답하지 않은 방 초대가 사라지는 시간. */
export const ROOM_INVITE_TTL_MS = 7 * 24 * 60 * 60_000;
/** 한 줄 글자 수 (개인 대화와 같다). */
export const ROOM_TEXT_MAX = SOCIAL_WHISPER_MAX;
/** `room:history` 한 번에 돌려주는 줄 수. */
export const ROOM_HISTORY_PAGE = 50;

/** 시스템 줄 종류 — 방 만들기 · 참여 · 나가기 · 강퇴 · 이름 변경 · 방장 변경. */
export type RoomSystemKind = 'create' | 'join' | 'leave' | 'kick' | 'rename' | 'owner';

export interface RoomMember extends SocialCard {
  presence: PresenceState;
}

export interface RoomInfo {
  id: RoomId;
  name: string;
  owner: PlayerCode;
  /** 들어온 순서 (첫 멤버가 다음 방장 후보). */
  members: RoomMember[];
  /** 초대했지만 아직 답하지 않은 사람 (멤버 모두에게 보인다). */
  pending: SocialCard[];
  createdAt: number;
  /** 마지막 줄 시각 (없으면 createdAt). */
  lastAt: number;
  /** 마지막 줄 미리보기 (시스템 줄 포함, 없으면 생략). */
  lastText?: string;
}

export interface RoomInvite {
  room: RoomId;
  /** 방 이름. */
  name: string;
  from: PlayerCode;
  fromName: string;
  /** 초대 시점의 멤버 수. */
  members: number;
  at: number;
}

export interface RoomSnapshot {
  rooms: RoomInfo[];
  invites: RoomInvite[];
}

export type RoomErrorCode = SocialErrorCode | 'not_member' | 'not_owner' | 'room_full' | 'room_limit' | 'not_friend';

export const ROOM_ERROR_MESSAGE_KO: Readonly<Record<Exclude<RoomErrorCode, SocialErrorCode>, string>> = {
  not_member: '방 멤버가 아닙니다',
  not_owner: '방장만 할 수 있습니다',
  room_full: '방이 가득 찼습니다',
  room_limit: '더 이상 방에 들어갈 수 없습니다',
  not_friend: '친구만 초대할 수 있습니다',
};

export function roomErrorMessage(code: RoomErrorCode): string {
  return (ROOM_ERROR_MESSAGE_KO as Record<string, string>)[code] ?? SOCIAL_ERROR_MESSAGE_KO[code as SocialErrorCode] ?? '요청을 처리할 수 없습니다';
}

export interface RoomLine {
  room: RoomId;
  /** 보낸 사람 (시스템 줄은 그 행동을 한 사람). */
  code: PlayerCode;
  name: string;
  text: string;
  at: number;
  /** 내 줄의 `room:say.nonce` (ack 가 이것으로 찾는다). */
  nonce?: number;
  /** 내 줄의 전송 상태 (받은 줄 · 옛 서버는 없음 = sent). */
  state?: 'pending' | 'sent' | 'failed';
  failCode?: RoomErrorCode;
  /** 시스템 줄이면 그 종류 (`text` 는 비어 있어도 된다 — ui 가 문장을 만든다). */
  system?: RoomSystemKind;
  /** join · kick · owner 의 대상. */
  target?: PlayerCode;
  targetName?: string;
}

/** 서버 저장 모양 (owner: server/ — 클라이언트로 그대로 나가지 않는다). */
export interface RoomRecord {
  id: RoomId;
  name: string;
  owner: PlayerCode;
  members: PlayerCode[];
  invites: { code: PlayerCode; from: PlayerCode; at: number }[];
  lines: { code: PlayerCode; name: string; text: string; at: number; system?: RoomSystemKind; target?: PlayerCode; targetName?: string }[];
  createdAt: number;
  updatedAt: number;
}

export interface SocialRecord {
  /** 2026-09-14: 들어가 있는 방 id (서버 색인). */
  rooms?: RoomId[];
}

/** `ctx.net.rooms` — 단체방 클라이언트 거울 (owner: net/). 사용 불가(오프라인 · 익명 · 옛 서버)면 `available` false 이고 모든 변경은 무시된다. */
export interface RoomsRef {
  readonly available: boolean;
  /** 들어가 있는 방, 마지막 줄이 최근인 순. */
  readonly rooms: readonly RoomInfo[];
  /** 받은 초대, 최근 순. */
  readonly invites: readonly RoomInvite[];
  find(room: RoomId): RoomInfo | undefined;
  /** 받아 둔 줄 (오래된 것 → 최근). 처음 열면 `requestHistory` 로 채운다. */
  history(room: RoomId): readonly RoomLine[];
  /** `before` (epoch ms) 보다 오래된 줄 한 쪽을 요청 → `room:history {room}`. 생략 = 최근 쪽. */
  requestHistory(room: RoomId, before?: number): void;
  /** 더 오래된 줄이 서버에 남아 있나 (마지막 `room:history.more`). */
  hasMore(room: RoomId): boolean;
  /** 방을 만든다 (`invite` = 함께 초대할 친구). false = 보낼 수 없음 (사용 불가 · 이름 없음). */
  create(name: string, invite?: readonly PlayerCode[]): boolean;
  invite(room: RoomId, code: PlayerCode): void;
  respond(room: RoomId, accept: boolean): void;
  leave(room: RoomId): void;
  kick(room: RoomId, code: PlayerCode): void;
  rename(room: RoomId, name: string): void;
  /** 한 줄 보내기 — 곧바로 `pending` 줄이 생기고 ack 로 확정된다. false = 보낼 수 없음. */
  say(room: RoomId, text: string): boolean;
  /** 읽지 않은 줄 수 (내 줄 · 시스템 줄 제외, 슬롯 localStorage 의 방별 readAt 기준). */
  unread(room: RoomId): number;
  markRead(room: RoomId): void;
  readonly unreadTotal: number;
}

/* ── 2026-09-14 (A 에이전트 — 서버 · 넷): 위 계약에 더한 것 ── */

export interface RoomInfo {
  /** 마지막 줄을 쓴 사람 (시스템 줄은 그 행동을 한 사람). 읽지 않음 추정에 쓴다 — 줄을 아직 받지 않은 방. */
  lastCode?: PlayerCode;
  /** 마지막 줄이 시스템 줄이면 그 종류 (시스템 줄은 읽지 않음에 세지 않는다). */
  lastSystem?: RoomSystemKind;
}

/** 방별 읽음 표시 (`slotKey` 로 캐릭터 슬롯마다 갈라진다 — owner: net/RoomSync). `{v:1, rooms: {roomId: epochMs}}`. */
export const ROOM_READ_STORAGE_KEY = 'scav.roomRead';
/** 서버 `room:say` 토큰 버킷 — 한 번에 몰아 보낼 수 있는 줄 수 · 초당 회복량. 넘치면 `room:ack {ok:false, code:'limit'}`. */
export const ROOM_SAY_BURST = 12;
export const ROOM_SAY_PER_S = 2;

/** 방 id — 서버가 만드는 base64url 문자열. 이 모양이 아니면 와이어에서 버린다. */
export function isValidRoomId(v: unknown): v is RoomId {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{6,32}$/.test(v);
}

/** 제어 문자는 공백, 마크업 `<` `>` 는 제거 (개인 대화 · 이름과 같은 규칙). */
function stripRoomChars(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const cc = ch.codePointAt(0) ?? 0;
    if (cc < 0x20 || cc === 0x7f) { out += ' '; continue; }
    if (ch === '<' || ch === '>') continue;
    out += ch;
  }
  return out;
}

/** 방 이름: 제어 문자 · 마크업 제거, 공백 한 칸으로 접기, `ROOM_NAME_MAX` 자. 빈 문자열 = 쓸 수 없는 이름. 서버 · 클라이언트 공용. */
export function sanitizeRoomName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return stripRoomChars(raw).replace(/\s+/g, ' ').trim().slice(0, ROOM_NAME_MAX).trim();
}

/** 방 한 줄: 제어 문자 · 마크업 제거, `ROOM_TEXT_MAX` 자. 빈 문자열 = 보낼 수 없음. 서버 · 클라이언트 공용. */
export function sanitizeRoomText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return stripRoomChars(raw).trim().slice(0, ROOM_TEXT_MAX);
}

/**
 * 시스템 줄의 한국어 문장 (서버의 `lastText` 미리보기와 메신저 말풍선이 같은 문장을 쓴다).
 * create · join · leave = `code/name` 이 그 사람, kick = `name` 이 방장 · `targetName` 이 내보낸 사람,
 * rename = `text` 가 새 이름, owner = `name` 이 나간 방장 · `targetName` 이 새 방장.
 */
export function roomSystemTextKo(line: Pick<RoomLine, 'system' | 'name' | 'targetName' | 'text'>): string {
  const who = line.name || '누군가';
  const target = line.targetName || '누군가';
  switch (line.system) {
    case 'create': return `${who} 님이 방을 만들었습니다`;
    case 'join': return `${who} 님이 들어왔습니다`;
    case 'leave': return `${who} 님이 나갔습니다`;
    case 'kick': return `${who} 님이 ${target} 님을 내보냈습니다`;
    case 'rename': return `${who} 님이 방 이름을 「${line.text}」(으)로 바꿨습니다`;
    case 'owner': return `${target} 님이 방장이 되었습니다`;
    default: return line.text;
  }
}
/* ══ end 2026-09-14 단체 메신저방 ══ */
