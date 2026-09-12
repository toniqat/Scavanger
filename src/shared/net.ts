import type * as THREE from 'three';
import type { ChatKind, EnemyType, GamePhase, PingKind, Stance, ItemInstanceExtras, StratagemId } from './types';
import type { DeployableKind, GadgetId } from './gadgets';
/* appended (2026-09-11): 드론 (owner: gadgets/drones) */
import type { DroneMessage, DroneRequest } from './drones';
/* appended (2026-09-09): 레이드 플레이 개선 — 의사소통 휠 */
import type { CommsId } from './comms';
import type { ImplantId } from './implants';
/* appended (Phase 7, 2026-09-06): server profile / raid session */
import type { ProfileDocKey, ProfileRecord, ProfileRef, RaidSessionBlob } from './profile';
import type { MissionMode } from './types';
/* appended (Phase 11, 2026-09-07): 행성 선택 + 소셜 */
import type { PlanetId } from './planets';
/* appended (2026-09-08): 공용 함선 격납고 — a visited member's ship layout rides on `ship state` */
import type { PlacedBook, PlacedFurniture, RoomPurpose } from './housing';
import type {
  PlayOutcome, PlayerCode, SocialErrorCode, SocialRef, SocialSnapshot, SquadInvite,
} from './social';
/* appended (2026-09-11): 소셜 · 신뢰 · 연결 (docs/plans/net-social-trust.md) */
import type { InviteOutcome } from './social';

/* ────────────────────────────────────────────────────────────────────────────
 * Multiplayer contract (owner: net/NetSystem publishes `ctx.net`).
 *
 * Topology: Node WebSocket relay server (server/) + host-authoritative gameplay.
 *   - Server owns lobbies (code, players, ready, start) and relays opaque GameMessages.
 *   - The lobby host runs the authoritative simulation (enemies, extraction, waves).
 *   - Every client simulates only its own player and sends PlayerSnapshots to everyone.
 *   - Clients render remote players / enemies from interpolated snapshots.
 *
 * This file is shared by the browser client AND the Node server (type-only imports there),
 * so keep it free of runtime dependencies other than plain constants.
 * ──────────────────────────────────────────────────────────────────────────── */

export const NET_MAX_PLAYERS = 4;
export const NET_LOBBY_CODE_LENGTH = 6;
/** Local player snapshot rate (Hz). */
export const NET_PLAYER_SNAPSHOT_HZ = 20;
/** Host → clients enemy snapshot rate (Hz). */
export const NET_ENEMY_SNAPSHOT_HZ = 10;
/** Phase 9: enemy snapshots are deltas; a full keyframe (`EnemySnapshot.full`) goes out every this many seconds (and right after `flow rejoined / takeover`). */
export const NET_ENEMY_KEYFRAME_S = 2;
/** Seconds of buffered delay used when interpolating remote entities. */
export const NET_INTERP_DELAY = 0.12;
/** Remote entity considered stale (extrapolation stops, avatar fades) after this many seconds without a snapshot. */
export const NET_STALE_AFTER = 1.5;
/** Default relay server path (Vite dev proxies it to the Node server). */
export const NET_WS_PATH = '/ws';
export const NET_DEFAULT_PORT = 8787;
/** URL query parameter carrying an invite code: `?lobby=ABC123`. */
export const NET_INVITE_PARAM = 'lobby';

/* ── appended: session tokens / reconnection / quick match ── */
/** WebSocket URL query params sent on connect: persistent session token (→ stable PeerId) and display name. */
export const NET_TOKEN_PARAM = 't';
export const NET_NAME_PARAM = 'n';
/** Token = 24 url-safe chars, generated once per browser and kept in localStorage. */
export const NET_TOKEN_LENGTH = 24;
export const NET_TOKEN_STORAGE_KEY = 'scav.sessionToken';
/** Server keeps a disconnected member's lobby slot for this long; reconnecting within it restores the same slot/party. */
export const NET_RECONNECT_GRACE_MS = 5 * 60 * 1000;
/** Client auto-reconnect backoff schedule (ms); the last value repeats. */
export const NET_RECONNECT_BACKOFF_MS: readonly number[] = [800, 1500, 3000, 5000, 10000, 20000];
/** Client: after the socket dropped mid-mission, give up waiting for a resume and abort to the hub after this long. */
export const NET_MISSION_RESUME_TIMEOUT_MS = 60 * 1000;
/* appended (Phase 7): mid-mission host migration + ghosts */
/**
 * Server: when the HOST's socket drops during a started mission the host role moves to the lowest-slot connected
 * member after this delay (a brief blip keeps the host). Before Phase 7 the host id was kept for the whole grace.
 */
export const NET_HOST_MIGRATE_DELAY_MS = 4000;
/** Host → all `ghost state` refresh rate while a suspended player's body is being simulated. */
export const NET_GHOST_STATE_HZ = 2;
/** Client (rejoining): fall back to a normal respawn when no `ghost restore` arrived within this many seconds. */
export const NET_GHOST_RESTORE_TIMEOUT_S = 3;
/**
 * Phase 9: a member that left the mission without rejoining (page reload → `lobby:mission {inMission:false}`) has its
 * ghost **parked** on the host for this many seconds: not simulated, not targetable, not counted, but a rejoin inside
 * the window still gets `ghost restore` with the body as it was.
 *
 * 2026-09-07: raised from 120 s to an hour — effectively "for the rest of the raid". The relay now keeps a dropped
 * raider's lobby slot for the whole mission too, so a 2-minute window was the one thing left throwing the body
 * away before the player could get back in. `parked` is cleared with the mission anyway (`clearAll`), so nothing
 * survives past the raid it belongs to.
 */
export const NET_GHOST_PARK_S = 3600;
/** Phase 9: relayed `meta contractHit.amount` above this is dropped (a real hit is always 1; `meta sync` entries are capped by the contract target). */
export const META_HIT_MAX = 10;
/** Nameplate / squad tag for a member whose socket is down but whose slot (and body) is kept. */
export const SUSPENDED_LABEL_KO = '연결 끊김';

/** Per-slot accent colours (hex) shared by remote avatars, nameplates, map icons and the lobby list. */
export const NET_SLOT_COLORS: readonly number[] = [0xffc23a, 0x5fd7ff, 0xff8a4a, 0x7cf07a];
export const NET_SLOT_COLORS_CSS: readonly string[] = ['#ffc23a', '#5fd7ff', '#ff8a4a', '#7cf07a'];

export type PeerId = string;
export type Vec3Tuple = [number, number, number];

/* ── Lobby ─────────────────────────────────────────────────────────────────── */
export interface LobbyPlayer {
  id: PeerId;
  name: string;
  /** 0..NET_MAX_PLAYERS-1, stable for the lobby lifetime (drives spawn offset / colour). */
  slot: number;
  ready: boolean;
  isHost: boolean;
  /* appended (reconnection) */
  /** false while the member's socket is down but their slot is still reserved (NET_RECONNECT_GRACE_MS). */
  connected: boolean;
  /* appended (Phase 7) */
  /**
   * true while the member is inside the running mission (raid: set for every connected member at start and on rejoin;
   * training: only members who entered). Cleared by `lobby:reset` / `lobby:mission {inMission:false}`. Optional so
   * older servers keep parsing; treat undefined as `started && connected`.
   */
  inMission?: boolean;
  /* appended (Phase 11) */
  /**
   * Public 아이디 and level of this member, filled in by the relay from its profile store (absent for an anonymous
   * socket, and on any server without one). Needed because the ESC 분대원 rows show both, and before Phase 11 the
   * lobby wire carried a **name only** — matching a squad-mate against my own friends list by name was ambiguous.
   * Never a `PeerId`: `code` is the same `PlayerCode` every social message uses.
   */
  code?: PlayerCode;
  level?: number;
}

export interface LobbyState {
  code: string;
  hostId: PeerId;
  players: LobbyPlayer[];
  /** true once the host pressed start; the lobby is closed to newcomers. */
  started: boolean;
  seed: number | null;
  /* appended (quick match) */
  /** Public ships are joinable through `lobby:quickmatch`; code-created ships are private (code / invite only). */
  isPublic: boolean;
  /* appended (Phase 7) */
  /** Kind of the running mission while `started` (`'raid'` when absent). A training keeps the lobby open to joins. */
  mode?: MissionMode;
  /* appended (Phase 11) */
  /**
   * 목표 행성 the **host** picked at the terminal (`lobby:planet`), or absent while nothing is chosen. Every member
   * mirrors it, plays the travel cutscene when it changes and may only board a launch slot while it is set. A raid
   * started from this lobby carries it in `game:start.planet`; a training ignores it.
   */
  planet?: PlanetId;
}

export type LobbyErrorCode =
  | 'not_found' | 'full' | 'started' | 'not_host' | 'not_ready' | 'invalid'
  | 'in_lobby' | 'not_in_lobby' | 'server'
  /* appended */
  | 'not_started'   // lobby:launch (rejoin) while no mission is running
  | 'duplicate'     // same session token connected from another tab → the older socket is closed with this code
  /* appended (Phase 7) */
  | 'too_large'     // profile:set / raid:save document over the byte cap
  | 'in_mission'    // lobby:mission {inMission:true} while another mission kind is running
  /* appended (Phase 11) */
  | 'no_planet'     // lobby:start of a raid while the lobby has no 목표 행성
  /* appended (2026-09-11, C-29): server console */
  | 'kicked'        // the operator ran `kick <id>` — socket closed right after, no 재접속 유예 (clients stop reconnecting)
  | 'server_full'   // over the operator's `max <n>` — socket closed; a lobby member reconnecting inside its grace is exempt
  /**
   * appended (2026-09-11, B-11): `lobby:join` / `social:play` into a lobby holding someone **I** blocked.
   * The mirror direction — a member who blocked *me* — is answered `not_found` on purpose, so a block never
   * shows through (the invite path hides it the same way, `server/Invites.ts` `hidden`). Only this direction,
   * my own choice, is told plainly.
   */
  | 'blocked';

/* ── Wire protocol: client ↔ server (JSON) ─────────────────────────────────── */
export type RelayTarget = PeerId | 'host' | 'all' | 'others';

export type ClientToServer =
  | { t: 'lobby:create'; name: string }
  | { t: 'lobby:join'; code: string; name: string }
  | { t: 'lobby:leave' }
  | { t: 'lobby:ready'; ready: boolean }
  /**
   * Host only. Requires every player to be ready. `mode` (appended, Phase 7): `'training'` may be sent by ANY member
   * while nothing is running — no ready gating, only the sender gets `inMission`, others stay in the hub and join later.
   */
  /** `planet` appended (Phase 11): the raid's 목표 행성. Omitted for a training (the arena has no planet). */
  | { t: 'lobby:start'; seed: number; mode?: MissionMode; planet?: PlanetId }
  /** Host only, after a mission ended: started=false, every ready=false, lobby reopened for joins. */
  | { t: 'lobby:reset' }
  /** Relay an opaque game message. 'all' includes the sender; 'others' excludes it. */
  | { t: 'relay'; to: RelayTarget; d: GameMessage }
  | { t: 'ping'; ts: number }
  /* appended (hub / quick match / reconnection) */
  /** Join the first public, not-started lobby with a free slot; create a new public one when none exists. */
  | { t: 'lobby:quickmatch'; name: string }
  /** Host only: toggle public visibility of the lobby (quick-match eligibility). */
  | { t: 'lobby:setPublic'; isPublic: boolean }
  /** Host only, while not started: pick the seed everyone sees in the hub (`LobbyState.seed`). */
  | { t: 'lobby:seed'; seed: number }
  /** Rename (hub terminal); server sanitizes and broadcasts `lobby:state`. */
  | { t: 'lobby:name'; name: string }
  /* appended (Phase 7): mission membership, profile store, credits, raid session */
  /**
   * I entered / left the running mission (training join from the terminal, raid rejoin from a pod, training exit).
   * Server updates `LobbyPlayer.inMission` and broadcasts `lobby:state`; a training whose last member leaves is reset
   * (`started=false`) by the server. `in_mission` error when no mission is running.
   */
  | { t: 'lobby:mission'; inMission: boolean }
  /** Ask for the profile record (also delivered in `welcome.profile`). */
  | { t: 'profile:get' }
  /** Store one opaque document (≤ PROFILE_DOC_MAX_BYTES). No reply; `too_large` error when refused. */
  /** `at` / `fresh` appended (Phase 9): see `ProfileRecord.docsAt` — newest-wins merge on the server. */
  /**
   * `baseRev` / `writeId` appended (2026-09-11, E-6): optimistic concurrency. `baseRev` = the `ProfileRecord.docsRev[key]`
   * this write was made on top of (0 = no document yet). Accepted iff it equals the server's current rev → `profile:ack`;
   * otherwise `profile:conflict` with the server copy. A resend of the last accepted `writeId` is acked again (idempotent).
   * A frame with `baseRev` ignores `at` / `fresh`; a frame without it keeps the Phase 9 stamp rules (old clients).
   */
  | { t: 'profile:set'; key: ProfileDocKey; doc: unknown; at?: number; fresh?: boolean; baseRev?: number; writeId?: string }
  /** Credits transaction; server answers `credits:result {txId}`. */
  | { t: 'credits:tx'; txId: number; delta: number; reason: string }
  /** Save my mid-raid state for a reconnect (only accepted while my lobby is started with `blob.seed`). */
  | { t: 'raid:save'; blob: RaidSessionBlob }
  /* ── appended (Phase 11): 목표 행성 ── */
  /**
   * Host only, while not started: pick the squad's 목표 행성 (`LobbyState.planet`). Broadcast as `lobby:state`, which
   * is what makes every member play the travel cutscene — there is no separate travel message. Refused with
   * `not_host` / `started`, and with `invalid` for an unknown id.
   */
  | { t: 'lobby:planet'; planet: PlanetId }
  /* ── appended (Phase 11): 소셜. Every one of these needs a profile (a token); anonymous → `unavailable`. ── */
  /** Ask for a fresh `social:state` (also delivered in `welcome.social`). */
  | { t: 'social:get' }
  /** Publish my level so friends' rows can show it. The name comes from the socket (`?n=` / `lobby:name`). */
  | { t: 'social:me'; level: number }
  /** Friend request by 아이디. Server answers both sides with `social:state`, or the sender with `social:error`. */
  | { t: 'social:request'; code: PlayerCode }
  /** Accept / decline a request sitting in my `incoming`. */
  | { t: 'social:respond'; code: PlayerCode; accept: boolean }
  /** Mutual removal (both profiles lose the other). */
  | { t: 'social:remove'; code: PlayerCode }
  /**
   * 같이 하기. The server picks the branch and reports it as `social:play {outcome}`: the target already sits in a
   * lobby → the sender is added to it (`lobby:state` follows, the hub plays a docking cutscene); the target has no
   * lobby → a `social:invited` goes to them, the sender's own lobby being created first when they had none.
   */
  | { t: 'social:play'; code: PlayerCode }
  /** Direct message by 아이디, delivered as `social:whisper` if the target is connected. Works outside a lobby. */
  /**
   * `nonce` appended (2026-09-11, B-4): sender-local id of this line. A server that knows it answers
   * `social:whisperAck {nonce}` (sent / stored for an offline friend / failed); without it the old fire-and-forget rules apply.
   */
  | { t: 'social:whisper'; code: PlayerCode; text: string; nonce?: number }
  /* ── appended (2026-09-09): 분대장 지명 이관 ── */
  /**
   * 분대장(호스트)을 `targetId` 에게 넘긴다. 서버가 받아 주는 경우는 둘뿐이다:
   * ① 보낸 사람이 지금 호스트다, ② `claim` 이 true 이고 현재 호스트가 `lobby:hostDown` 으로
   * **완전히 사망**했다고 표시해 두었다 (시체 옆의 분대장 기기). 그 외에는 `not_host`.
   * `targetId` 가 같은 로비의 연결된 멤버가 아니면 `invalid`. 성공하면 새 `lobby:state` 가 방송된다.
   */
  | { t: 'lobby:transferHost'; targetId: PeerId; claim?: boolean }
  /**
   * 호스트 본인이 이 레이드에서 완전히 사망했다(또는 되살아났다)고 서버에 알린다. 서버는 이 표시가
   * 있는 동안에만 남의 `lobby:transferHost {claim:true}` 를 허용한다. 미션이 끝나면 자동으로 지워진다.
   */
  | { t: 'lobby:hostDown'; down: boolean }
  /* appended (2026-09-11): 소셜 · 신뢰 · 연결 — see the last section */
  | ClientToServerAppended2026_09_11b;

export type ServerToClient =
  /**
   * First frame after connect. `lobby` (appended) is set when the session token is still a member of a lobby
   * (reconnect within NET_RECONNECT_GRACE_MS or a fresh page load) — the client resumes into it; `started`
   * on that lobby means a mission is in progress and the player may rejoin from a launch slot.
   */
  | {
      t: 'welcome'; id: PeerId; serverTime: number; lobby?: LobbyState | null; resumed?: boolean;
      /* appended (Phase 7) */
      /** Profile record of this token (absent on servers without a store). */
      profile?: ProfileRecord;
      /** My saved mid-raid state when resuming into a started lobby that still runs `blob.seed`. */
      raid?: RaidSessionBlob | null;
      /* appended (Phase 11) */
      /** Friends / requests / recent players of this token (absent on servers without a store, or when anonymous). */
      social?: SocialSnapshot;
    }
  | { t: 'lobby:state'; lobby: LobbyState }
  | { t: 'lobby:error'; code: LobbyErrorCode; message: string }
  /**
   * `reason` / `to` appended (2026-09-11, B-6): `'moved'` = the server moved me straight into lobby `to` (같이 하기 · invite
   * accept) and its `lobby:state` follows at once — the hub skips the undock cutscene and docks into the new ship.
   * Absent = an ordinary leave (as before).
   */
  | { t: 'lobby:left'; reason?: 'moved'; to?: string }
  /** `mode` (appended, Phase 7): a training start reaches everyone but only members with `inMission` enter it. */
  /** `planet` (appended, Phase 11): the raid's 목표 행성, echoed from `LobbyState.planet` at start time. */
  | { t: 'game:start'; seed: number; lobby: LobbyState; mode?: MissionMode; planet?: PlanetId }
  /* appended (Phase 7) */
  | { t: 'profile:docs'; profile: ProfileRecord }
  | { t: 'credits:result'; txId: number; ok: boolean; credits: number; reason?: string }
  | { t: 'relay'; from: PeerId; d: GameMessage }
  /** A peer disconnected/left mid-lobby or mid-game. `lobby` is the updated state (host may have migrated). */
  | { t: 'peer:left'; id: PeerId; lobby: LobbyState }
  | { t: 'pong'; ts: number; serverTime: number }
  /* ── appended (Phase 11): 소셜. Pushed on every change to anyone the change concerns, never polled. ── */
  /** The whole social snapshot. Sent after `social:get`, after any mutation, and whenever a friend's presence moves. */
  | { t: 'social:state'; social: SocialSnapshot }
  /** Someone asked me into their squad. Held client-side for `SQUAD_INVITE_TTL_S`, accepted with a P hold. */
  | { t: 'social:invited'; invite: SquadInvite }
  /** A whisper arrived. `code` / `name` are the sender's. */
  | { t: 'social:whisper'; code: PlayerCode; name: string; text: string; at: number }
  /** How my `social:play` was resolved (`joined` = I am in their lobby now, `invited` = the invite went out). */
  | { t: 'social:play'; code: PlayerCode; name: string; outcome: PlayOutcome }
  | { t: 'social:error'; code: SocialErrorCode; message: string }
  /* appended (2026-09-11): 소셜 · 신뢰 · 연결 — see the last section */
  | ServerToClientAppended2026_09_11b;

/* ── Game messages (relayed verbatim, never inspected by the server) ───────── */

/** Bit flags packed into PlayerSnapshot.f / RemotePlayerRef.flags. */
export const PlayerFlags = {
  SPRINT: 1 << 0,
  AIM: 1 << 1,
  DIVE: 1 << 2,
  AIRBORNE: 1 << 3,
  DEAD: 1 << 4,
  RELOADING: 1 << 5,
  FIRING: 1 << 6,
  TWO_HANDED: 1 << 7,
  HAS_WEAPON: 1 << 8,
  IN_SHIP: 1 << 9,
  /** Inside the hellpod / not yet landed (avatar hidden). */
  DROPPING: 1 << 10,
  /* appended (hub) */
  /** Boarded in a hub launch pod (avatar hidden / pod shown closed). */
  IN_POD: 1 << 11,
  /** Sender is walking around the shared ship (phase 'hub'), not in a mission. */
  IN_HUB: 1 << 12,
  /* appended (Phase 2) */
  /** 전투불능: crawling, revivable (DEAD is not set). */
  DOWNED: 1 << 13,
  /** A consumable (stim / grenade) is in hand instead of a gun. */
  HOLDING_ITEM: 1 << 14,
  /* appended (tactical kit) */
  /** Cloaked (은폐 장막 / 광학미채) — remote avatars render translucent. */
  CLOAKED: 1 << 15,
  /** Barrier implant deployed. */
  BARRIER: 1 << 16,
  /** Melee swing in progress. */
  MELEE: 1 << 17,
  /** Hovering under the tactical backpack. */
  HOVER: 1 << 18,
  /** Buffed by an overcharge beam. */
  OVERCHARGED: 1 << 19,
  /* appended (Phase 7): remote pose sync */
  /** Grenade / gadget wind-up (LMB held with a throwable in hand). */
  THROWING: 1 << 20,
  /** Pin pulled, cooking (R). */
  COOKING: 1 << 21,
  /** Shockgun RMB charge / minigun spin-up (braced stance). */
  CHARGING: 1 << 22,
  /** Flame / arc continuous fire. */
  SPRAYING: 1 << 23,
  /** Heavy carry (bazooka / minigun at the hip). */
  HEAVY: 1 << 24,
  /** The 용검 big slash (MELEE is set too; remotes play the heavy sweep for SLASH_DURATION). */
  MELEE_HEAVY: 1 << 25,
  /* appended (Phase 10): 부상자 들쳐메기 */
  /** A downed squadmate is on this player's right shoulder — unarmed; `PlayerSnapshot.cr` names them. */
  CARRYING: 1 << 26,
  /** This player is carried by a squadmate (DOWNED is set too; ignore their `p`, use the carrier's socket). */
  CARRIED: 1 << 27,
  /* appended (2026-09-09): 채팅 입력 중 말풍선 */
  /** Chat input is open (typing). Set by net from `ui:chatToggled`; remotes draw a `…` speech bubble over the head. */
  TYPING: 1 << 28,
  /* appended (2026-09-11): 사다리 */
  /** Hanging on a ladder (`PlayerRef.climbingLadder`); remotes play the climb pose, `p` moves vertically. */
  CLIMBING: 1 << 29,
} as const;

/** Local player state → everyone, NET_PLAYER_SNAPSHOT_HZ. Owner: net (built from ctx.player / ctx.inventory). */
export interface PlayerSnapshot {
  t: 'ps';
  /** Monotonic per sender; receivers drop out-of-order snapshots. */
  seq: number;
  /** Sender's ctx.time when sampled (for jitter smoothing only; never compared across peers). */
  time: number;
  /** Feet position (world). */
  p: Vec3Tuple;
  v: Vec3Tuple;
  yaw: number;
  pitch: number;
  stance: Stance;
  /** PlayerFlags bitfield. */
  f: number;
  hp: number;
  /** Equipped active weapon def id (WeaponDef.id) or null. */
  w: string | null;
  /** Stride phase (radians) and move blend, for the remote walk cycle. */
  stride: number;
  move: number;
  /* appended (tactical kit) — optional so older senders stay compatible. */
  /** Wielded implant id (grapple / overcharge / scan / atlauncher) so remotes render the device in hand. */
  imp?: ImplantId | null;
  /** Equipped armor def id, for the remote avatar look. */
  ar?: string | null;
  /* appended (Phase 7) — optional, older senders stay compatible. */
  /** Def id of the consumable / gadget in hand while HOLDING_ITEM (remotes build a procedural held-item mesh). */
  h?: string | null;
  /** Attachment def ids socketed on the active weapon (remotes call `WeaponModel.setAttachments`). Omitted when none. */
  att?: string[];
  /* appended (Phase 9) — optional, older senders stay compatible. */
  /** Down-state hp (`PlayerRef.downHp`) while DOWNED, so a host ghost inherits the real bleed pool. Omitted when not downed. */
  dhp?: number;
}

/** Someone fired. Owner: weapons (sends) / net emits `net:remoteFired` on receive. */
/**
 * Appended (unique weapons, 2026-09-06): `m` 1 = RMB alternative fire (0 / undefined = primary), `c` = charge 0..1
 * (shockgun bolt) or spin state; continuous weapons (flame / arc) send `fire` at ≤ 10 Hz while the trigger is held and
 * a final `{ m, c: -1 }` when it stops so remotes can end the loop FX.
 */
export interface FireMessage { t: 'fire'; w: string; o: Vec3Tuple; d: Vec3Tuple; m?: number; c?: number }
export interface ReloadMessage { t: 'reload'; w: string }
/** Grenade thrown (visual replication; explosion damage is resolved by the host via ExplodeRequest). `fuse` (appended) = seconds left when released. */
export interface GrenadeMessage { t: 'grenade'; p: Vec3Tuple; v: Vec3Tuple; fuse?: number }
/* appended (Phase 2): reviver → downed player. `progress` at ≤ 4 Hz while holding, `cancel` on release, `done` when the hold completed. */
export interface ReviveMessage { t: 'revive'; ev: 'progress' | 'cancel' | 'done'; target: PeerId; p?: number }
/*
 * appended (Phase 3): ship calls. `call` (caller → others): a confirmed call; `eta` = seconds until the effect from the
 * receiver's point of view. Every client simulates the effect locally (visuals, own-player damage, structures with the
 * same `seed`); enemy damage goes through the caller's `applyExplosion` (replicas forward `explode` to the host).
 * `structHp` (any → others): a structure of `callId` at `index` changed hp (0 = destroyed) so cover stays in sync.
 */
export type StratagemMessage =
  /**
   * `by` appended (2026-09-11, E-4): the caller, filled in by the **host** when it re-broadcasts a validated
   * `stratq call`. A receiver accepts a `strat call` only when `from === lobby.hostId` (a host's own call carries its own id).
   */
  | { t: 'strat'; ev: 'call'; callId: string; kind: StratagemId; p: Vec3Tuple; eta: number; seed: number; by?: PeerId }
  | { t: 'strat'; ev: 'structHp'; callId: string; index: number; hp: number }
  /* appended (Phase 9): late-join sync — the host answers `stratq sync` / `flow rejoined` with every live call it knows. */
  | { t: 'strat'; ev: 'sync'; calls: StratagemCallWire[] }
  /**
   * appended (2026-09-11, E-8): host → the one caller whose `stratq call` it refused. Until now a refusal was
   * silent and the caller's shared cooldown — started optimistically in `Targeting.confirm` before the request
   * goes out — simply burned. The caller now refunds it (`StratagemSystem.refundCooldown`) and shows why.
   * Accepted only when it comes `from === lobby.hostId` **and** `callId` is one this client sent (`callId`
   * starts with the local peer id, the same ownership rule the host checks in `Wire.onCallRequest`), so nobody
   * can rewind someone else's cooldown. The Korean wording is **not** contract — `stratagems/` owns it, the way
   * `Rescue.DENY_KO` owns the rescue wording.
   */
  | { t: 'strat'; ev: 'deny'; callId: string; reason: StratagemDenyReason };

/**
 * Why the host refused a `stratq call` (2026-09-11, E-8). The first three are the request's own shape, the rest
 * are `callRefusal`'s: `self` = the caller is the host, `phase` = no raid running, `member` = not in this lobby,
 * `point` = the target is not a finite ground point, `bounds` = outside the map, `caller` = no snapshot for the
 * caller, `range` = farther than `STRAT_MAX_CALL_RANGE`, `cooldown` = the caller's shared cooldown has not run out.
 */
export type StratagemDenyReason =
  | 'callId' | 'kind' | 'host_only'
  | 'not_host' | 'self' | 'phase' | 'member' | 'point' | 'bounds' | 'caller' | 'range' | 'cooldown';
/**
 * One live ship call for a late joiner. `eta` = seconds until it lands (≤ 0 = already landed: the receiver back-dates
 * `landsAt` and lets its own update fast-forward the landing, registering structures / the supply crate at once);
 * `st` = `[index, hp]` for every structure whose hp is below `STRUCTURE_HP` (0 = destroyed), the rest are rebuilt from `seed`.
 */
export interface StratagemCallWire { callId: string; kind: StratagemId; p: Vec3Tuple; seed: number; eta: number; caller: PeerId | null; looted?: boolean; st?: [number, number][] }
/** Client → host (Phase 9): send me every live ship call (`world:ready` on a non-host). */
export type StratagemRequest =
  | { t: 'stratq'; ev: 'sync' }
  /**
   * appended (2026-09-11, E-4): a non-host confirmed a ship call → host. The host checks kind (`STRATAGEM_ORDER`),
   * `STRATAGEM_HOST_ONLY`, the caller's shared cooldown, the rescue grant, map bounds + `STRAT_MAX_CALL_RANGE` from the
   * caller's snapshot, rewrites `eta` from the csv delay, then broadcasts `strat call {…, by}`. A refused call is dropped
   * silently (the caller's local cooldown already ran — same as a lost frame).
   */
  | { t: 'stratq'; ev: 'call'; callId: string; kind: StratagemId; p: Vec3Tuple; seed: number };
/** Client → host: my local raycast hit enemy `id` for `dmg` (pre-multiplier) at point `p` travelling `d`. Owner: enemies (replica Enemy.takeDamage). */
/**
 * Appended (2026-09-06): `st` = status the host should apply with the hit — bits of `ENEMY_STATUS_BITS`
 * (incinerated / shocked / burning), `dur` = seconds. `dmg` may be 0 for a status-only request.
 */
export interface HitRequest {
  t: 'hit'; id: number; dmg: number; p: Vec3Tuple; d: Vec3Tuple; st?: number; dur?: number;
  /**
   * appended (2026-09-11, C-1 · X-6): knockback the host applies to enemy `id` — horizontal impulse of `kb` m/s along
   * `d` (already fallen off by the sender, i.e. what `EnemyManagerRef.pushBack` would have added locally). Sent by a
   * replica's `pushBack` (실드 배쉬) with `dmg: 0`; the host skips a charging behemoth exactly like its own pushBack.
   * The host clamps the speed (`MAX_REQUEST_KNOCKBACK`) and, since 2026-09-11 (E-4 ⑤), refuses it unless the sender's
   * snapshot stands within the bash's reach of the enemy (+ `HIT_KNOCKBACK_RANGE_SLACK`); `dmg` passes a per-sender DPS
   * budget (`HIT_REQUEST_DPS_MAX`).
   *
   * `st` was trusted (duration-capped only) until 2026-09-11 (E-8): the host now masks it to the known
   * `ENEMY_STATUS_BITS`, refuses it unless the sender's snapshot stands within the longest status-capable reach
   * (`max(FLAME_RANGE, SHOCK_RANGE)` + `STATUS_REQUEST_RANGE_SLACK`) of the enemy, and rate-limits it per sender
   * (`STATUS_REQUEST_RATE_MAX` / `STATUS_REQUEST_BURST_S`). The burn DoT the host then ticks is deliberately **not**
   * pre-charged against the DPS budget — the reach check already bounds it, and charging it would trim legitimate
   * flamethrower play across many targets.
   */
  kb?: number;
}

/** Enemy status bits on the wire (`EnemyWire.sb`, `HitRequest.st`). */
export const ENEMY_STATUS_BITS = { BURNING: 1 << 0, SLOWED: 1 << 1, INCINERATED: 1 << 2, SHOCKED: 1 << 3 } as const;
/**
 * Client → host: explosion at `p` radius `r` damage `dmg` (grenade). Owner: enemies (replica applyExplosion).
 *
 * The host's checks (2026-09-11, E-8 — before this it took any `p` at all, from anyone, at any rate): `p` must be a
 * finite `Vec3Tuple`, `0 < dmg ≤ MAX_REQUEST_DAMAGE`, `0 < r ≤ MAX_REQUEST_RADIUS`, the sender must be a lobby member
 * whose snapshot stands within `STRAT_MAX_CALL_RANGE + EXPLODE_REQUEST_RANGE_SLACK` of `p` (the widest legitimate
 * source is a ship call's impact, which lands that far from where its caller stood), and `dmg` is spent
 * from the **same** per-sender budget as `HitRequest.dmg` (`HIT_REQUEST_DPS_MAX`) — separate buckets would let the
 * two paths alternate for twice the total. There is no `kind` on the wire: the caps stay blanket ones.
 *
 * A **dead** sender is accepted on purpose — a thrown explosive outlives its thrower (a grenade fuse, a call's `eta`),
 * so refusing a corpse's request would delete legitimate kills. `HitRequest.kb` does refuse one, because a shield bash
 * from a corpse is not a thing that can happen.
 */
export interface ExplodeRequest { t: 'explode'; p: Vec3Tuple; r: number; dmg: number }
/** Host → shooter: confirmation of a HitRequest (hitmarker / kill credit). */
export interface HitConfirm { t: 'hitc'; id: number; dmg: number; killed: boolean; part: 'head' | 'body' | 'rear' | 'front' }
/** Host → one client: you took damage. Owner: enemies (host AI) → net applies `ctx.player.takeDamage`. */
/** `kb` (appended, Phase 7): knockback the victim applies with `PlayerRef.applyKnockback(d, s)` (behemoth charge, blasts). */
export interface DamageMessage { t: 'dmg'; amount: number; from?: Vec3Tuple; slow?: { duration: number; factor: number }; kb?: { d: Vec3Tuple; s: number } }
/** Any → all: I died. */
export interface DiedMessage { t: 'died'; p: Vec3Tuple }

/** Enemy AI state as seen on the wire (subset of enemies/Enemy.ts EnemyState). */
export type EnemyWireState = 'idle' | 'wander' | 'alert' | 'chase' | 'attack' | 'stagger' | 'dead' | 'flee';

/**
 * Phase 9: `es` is a **delta** stream. In a keyframe (`EnemySnapshot.full`) every field is present for every enemy; in
 * a delta only enemies with a change appear and only the changed fields are set (`ty` / `w` only on an enemy's first
 * appearance since the last keyframe). A replica applies a wire on top of its latest sample; an unknown `id` in a delta
 * is ignored (`ee spawn` / the next keyframe brings it). `a` / `sb` keep their "omitted = 0" meaning **only in a
 * keyframe**; in a delta an omitted field is unchanged.
 */
export interface EnemyWire {
  id: number;
  ty?: EnemyType;
  p?: Vec3Tuple;
  yaw?: number;
  hp?: number;
  st?: EnemyWireState;
  /**
   * Optional animation hints: 0 none, 1 charger windup, 2 charger rush, 3 spewer windup, 4 hunter airborne;
   * Phase 4: 5 rogue shooting, 6 rogue in cover, 7 rogue rushing, 8 artillery aiming, 9 toxic swelling, 10 behemoth windup, 11 behemoth rush.
   * Phase 7: 12 rogue reloading, 13 rogue throwing a grenade.
   * 2026-09-11 (네임드 로그 — `ai/named/*` sets `Enemy.namedHint`): 14 sniper prone idle, 15 sniper glint / aiming,
   * 16 hammer windup, 17 hammer charge, 18 heavy spin-up, 19 heavy firing, 20 scan drone pulsing.
   */
  a?: number;
  /** Phase 4: rogue's weapon def id (model + corpse loot). */
  w?: string;
  /** Appended (2026-09-06): status bits (`ENEMY_STATUS_BITS`) so replicas show burning / 전소 / shocked visuals. */
  sb?: number;
}

/**
 * Host → all, NET_ENEMY_SNAPSHOT_HZ. `full` = keyframe: complete list, every field (ids missing from it were despawned);
 * otherwise a delta (Phase 9). `seq` is monotonic per host (replicas stamp `seenSeq` from it); `gone` lists ids that
 * left the host's list since the previous snapshot (released at once, no need to wait for the keyframe). Owner: enemies.
 */
export interface EnemySnapshot { t: 'es'; time: number; seq: number; full: boolean; e: EnemyWire[]; gone?: number[] }

/** Host → all: discrete enemy events (spawn/kill/attack) for FX, audio and stats. Owner: enemies. */
export type EnemyEvent =
  | { t: 'ee'; ev: 'spawn'; id: number; ty: EnemyType; p: Vec3Tuple; yaw: number }
  /** `dd` (appended Phase 10) = index into `ENEMY_DEATH_DIRS`; omitted = 0 (`'left'`). */
  | { t: 'ee'; ev: 'kill'; id: number; ty: EnemyType; p: Vec3Tuple; killer: PeerId | null; dd?: number }
  | { t: 'ee'; ev: 'despawn'; id: number }
  | { t: 'ee'; ev: 'damaged'; id: number; amount: number; p: Vec3Tuple; d?: Vec3Tuple }
  | { t: 'ee'; ev: 'attack'; id: number; ty: EnemyType; target: PeerId; damage: number; p: Vec3Tuple }
  | { t: 'ee'; ev: 'acid'; id: number; from: Vec3Tuple; target: PeerId }
  | { t: 'ee'; ev: 'wave'; index: number; count: number }
  /* appended (Phase 4) */
  | { t: 'ee'; ev: 'shoot'; id: number; from: Vec3Tuple; to: Vec3Tuple; hit: boolean }
  | { t: 'ee'; ev: 'shell'; sid: number; from: Vec3Tuple; target: Vec3Tuple; flight: number }
  | { t: 'ee'; ev: 'intercept'; sid: number; p: Vec3Tuple }
  | { t: 'ee'; ev: 'shellHit'; sid: number; p: Vec3Tuple }
  | { t: 'ee'; ev: 'charge'; id: number; target: Vec3Tuple }
  | { t: 'ee'; ev: 'toxic'; id: number; p: Vec3Tuple }
  /** `dd` / `lt` appended (Phase 10): death-direction index, and 0 = this corpse rolled un-searchable (omitted = lootable). */
  | { t: 'ee'; ev: 'corpse'; id: number; ty: EnemyType; p: Vec3Tuple; w?: string; dd?: number; lt?: 0 | 1 }
  | { t: 'ee'; ev: 'corpseGone'; id: number }
  /* appended (Phase 7): rogue AI v2 */
  /** A rogue threw a grenade (replicas fly a visual one; the host resolves damage: own player directly, remotes via `dmg`). */
  | { t: 'ee'; ev: 'grenade'; id: number; p: Vec3Tuple; v: Vec3Tuple; fuse: number }
  /** The rogue grenade exploded (FX on replicas). */
  | { t: 'ee'; ev: 'grenadeHit'; p: Vec3Tuple }
  /* appended (2026-09-08): 배리어 정면 흡수 — see the last section */
  | EnemyEventAppended2026_09_08
  /* appended (2026-09-11): 네임드 로그 · 스캔 드론 — see EnemyEventAppended2026_09_11 */
  | EnemyEventAppended2026_09_11;
/** Client → host (Phase 4): my shot intercepted shell `sid`. Owner: enemies. */
export interface InterceptRequest { t: 'intq'; sid: number; p: Vec3Tuple }

/** Host → all: extraction flow. Owner: extraction. */
export type ExtractionMessage =
  | { t: 'ex'; ev: 'activated'; padId: string; duration: number }
  | { t: 'ex'; ev: 'tick'; remaining: number }
  | { t: 'ex'; ev: 'shipIncoming'; eta: number }
  | { t: 'ex'; ev: 'shipLanded' }
  | { t: 'ex'; ev: 'boarding'; boarded: PeerId[]; required: PeerId[] }
  | { t: 'ex'; ev: 'liftoff' }
  | { t: 'ex'; ev: 'reset' }
  /* appended (rejoin): host → one rejoining client, full extraction state in reply to `exq sync`. */
  | { t: 'ex'; ev: 'sync'; state: ExtractionSyncState };

/** Snapshot of the host's extraction flow for a late / rejoining client. Owner: extraction. */
export interface ExtractionSyncState {
  stage: 'idle' | 'countdown' | 'shipIncoming' | 'shipLanded' | 'liftoff';
  padId: string | null;
  /** Countdown seconds left (stage 'countdown') or ship ETA (stage 'shipIncoming'). */
  remaining: number;
  boarded: PeerId[];
  required: PeerId[];
}

/** Client → host: extraction requests. Owner: extraction. */
export type ExtractionRequest =
  | { t: 'exq'; ev: 'activate'; padId: string }
  | { t: 'exq'; ev: 'liftoff' }
  | { t: 'exq'; ev: 'board'; inside: boolean }
  /* appended (rejoin): a client that (re)joined a running mission asks for `ex sync`. */
  | { t: 'exq'; ev: 'sync' };

/** Host → all: mission-level flow that GameFlow must mirror. Owner: game. */
export type FlowMessage =
  | { t: 'flow'; ev: 'over' }                 // everyone is dead → game:over on all clients
  | { t: 'flow'; ev: 'complete' }             // liftoff finished → game:complete on all clients
  | { t: 'flow'; ev: 'abort' }                // host aborted → everyone back to lobby
  | { t: 'flow'; ev: 'phase'; phase: GamePhase }
  /* appended (rejoin): a client re-entered the running mission (sent to 'all'); systems may re-sync it. */
  | { t: 'flow'; ev: 'rejoined' }
  /* appended (Phase 7) */
  /**
   * The NEW host announces it took authority over the running mission (sent to 'others' right after
   * `net:hostChanged {isLocalHost:true}`). Clients re-request every sync (`exq/itemq/gadq/contq/ghostq sync`).
   */
  | { t: 'flow'; ev: 'takeover' };

/** Any → all: a tactical ping. Owner: ui/hud/Pings. `label` (appended) = item name for 'item' pings. */
export interface PingMessage {
  t: 'ping'; p: Vec3Tuple; kind: PingKind; label?: string; enemyId?: number;
  /**
   * appended (2026-09-09): sender-local sequence number of this ping, so a squadmate can name it in a `PingAckMessage`.
   * Older senders omit it — such pings cannot be acknowledged.
   */
  seq?: number;
}

/**
 * appended (2026-09-09): any → all — "알겠다" on a squadmate's ping. `owner` is the peer who placed the ping and `seq`
 * its `PingMessage.seq`. The receiver draws the acker's slot-colour ring on that ping and posts
 * `<이름>이(가) 알겠다고 확인.` to the chat. Owner: ui/hud/Pings.
 */
export interface PingAckMessage { t: 'pingack'; owner: PeerId; seq: number }

/** Any → all: crate opened (so other clients mark it looted). Owner: world/inventory. */
export interface CrateMessage {
  t: 'crate'; id: string;
  /**
   * appended (2026-09-11): `sync` = 이미 열린 상자 · 컨테이너 id 전부(`ids`, 호스트 → 늦게 합류한 사람),
   * `syncq` = 그 목록을 달라는 요청(누구나 → 호스트, `id` 는 빈 문자열). `opened` 는 누구나 → 전원이다
   * (열린 **모습**만 맞춘다 — 내용물은 `cont` 가 따로 동기화한다). Owner: world.
   */
  ev: 'opened' | 'looted' | 'sync' | 'syncq';
  ids?: string[];
}

/** Any → all: short text chat / quick-chat line. Owner: ui/hud/ChatLog. `kind` (appended) defaults to 'text'. */
export interface ChatMessage { t: 'chat'; text: string; kind?: ChatKind }

/* ── appended: world pickups (owner: pickups/PickupSystem; host-authoritative) ── */
/** Wire form of a pickup. `ex` (appended, weapon package) carries durability / loaded rounds / sockets of a dropped weapon. */
export interface PickupWire { id: string; defId: string; qty: number; p: Vec3Tuple; ex?: ItemInstanceExtras }
/**
 * Host → all. `drop` = new pickup (host assigns/keeps `id`), `take` = removed because `by` took it,
 * `sync` = full list for a (re)joining client (reply to `itemq sync`).
 */
export type ItemMessage =
  | { t: 'item'; ev: 'drop'; item: PickupWire; v?: Vec3Tuple }
  | { t: 'item'; ev: 'take'; id: string; by: PeerId }
  | { t: 'item'; ev: 'sync'; items: PickupWire[] };
/**
 * Client → host. `drop` = I dropped this from my bag (host spawns it and broadcasts `item drop`; the dropper's
 * client shows it once the broadcast arrives), `take` = I want pickup `id` (host validates, broadcasts `item take`;
 * the taker adds it to the bag on receipt), `sync` = send me every pickup.
 */
export type ItemRequest =
  | { t: 'itemq'; ev: 'drop'; item: PickupWire; v: Vec3Tuple }
  | { t: 'itemq'; ev: 'take'; id: string }
  | { t: 'itemq'; ev: 'sync' };

/**
 * Phase 5 (owner: meta/): a contract-goal action happened on this client (kill / crate / corpse / ship call). Sent to
 * `others`; a receiver running a contract of the same corp progresses by `amount × CONTRACT_SQUAD_SHARE`. The relay
 * is opaque; NetSystem hands it to `onMessage('meta')` subscribers.
 */
export type MetaMessage =
  | { t: 'meta'; ev: 'contractHit'; corp: import('./meta').CorpId; goal: import('./meta').ContractGoalKind; amount: number }
  /* appended (Phase 9): late-join catch-up — every peer answers `metaq sync` ONCE per requester per mission with the hits it broadcast so far this mission. */
  /** `rid` appended (2026-09-11, E-4): echoes `metaq sync.rid` — a receiver drops a `meta sync` it never asked for. */
  | { t: 'meta'; ev: 'sync'; corp: import('./meta').CorpId; hits: [import('./meta').ContractGoalKind, number][]; rid?: number }
  /* appended (Phase 9 UI pass): this member's own active contract + progress, so every squad HUD can draw it
   * (`ui/hud/ContractPanel`). `id` null = no contract / abandoned / settled. Broadcast on `world:ready`, on every
   * local progress change (≤ 1 Hz) and on accept / abandon, and repeated to whoever asks with `metaq sync`. */
  | { t: 'meta'; ev: 'contract'; id: string | null; progress: number };
/** Client → others (Phase 9): peer-to-peer (the host holds no tallies) — sent on `world:ready` of a rejoin. */
export type MetaRequest = { t: 'metaq'; ev: 'sync'; /** appended (2026-09-11, E-4): request id echoed in `meta sync.rid`. */ rid?: number };

export type GameMessage =
  | PlayerSnapshot
  | FireMessage
  | ReloadMessage
  | GrenadeMessage
  | HitRequest
  | ExplodeRequest
  | HitConfirm
  | DamageMessage
  | DiedMessage
  | EnemySnapshot
  | EnemyEvent
  | ExtractionMessage
  | ExtractionRequest
  | FlowMessage
  | PingMessage
  | CrateMessage
  | ChatMessage
  | ItemMessage
  | ItemRequest
  | ReviveMessage
  | StratagemMessage
  | InterceptRequest
  | ImplantMessage
  | BuffMessage
  | MeleeMessage
  | GadgetMessage
  | GadgetRequest
  | HarvestMessage
  | HarvestRequest
  | MetaMessage
  /* appended (Phase 7) */
  | GhostMessage
  | GhostRequest
  | ContainerMessage
  | ContainerRequest
  /* appended (Phase 9) */
  | StratagemRequest
  | MetaRequest
  /* appended (Phase 10) */
  | CarryMessage
  | CrewMessage
  | CrewRequest
  /* appended (2026-09-08): client → host bullet report (owner: enemies) */
  | ShotReport
  /* appended (2026-09-09): ping acknowledgement (owner: ui/hud/Pings) */
  | PingAckMessage
  /* appended (2026-09-08): 공용 함선 격납고 — 개인 함선 방문 (owner: hub) */
  | ShipVisitMessage
  | ShipVisitRequest
  /* appended (2026-09-09): 사망/시체 · 구조선 · 강하 포드 · 분대장 기기 · 안개 */
  | CorpseMessage
  | CorpseRequest
  | RescueMessage
  | PodMessage
  | LeaderMessage
  | LeaderRequest
  | FogMessage
  | FogRequest
  /* appended (2026-09-09): 레이드 플레이 개선 — 의사소통 · 구조물 · 전차 · 재해 · 로그 강하 (파일 끝 절 참고) */
  | RaidContentMessage
  /* appended (2026-09-11): 드론 (owner: gadgets/drones — shared/drones.ts) */
  | DroneMessage
  | DroneRequest
  /* appended (2026-09-11, A-3c): 공유 함선 식탁 (owner: net/parts/Meal — 아래 `MealMessage` 절) */
  | MealMessage
  /* appended (2026-09-12): 캐릭터 버프 목록 (owner: net — 아래 `CharBuffMessage` 절) */
  | CharBuffMessage
  | CharBuffRequest;
  /* append new message types above this line (keep `t` unique; prefix by owning folder if in doubt) */

/**
 * 공유 함선 식탁 (A-3c, 2026-09-11, owner: net/parts/Meal). 한 명이 요리 하나를 써서 차리면 **분대 전원**이
 * 같은 식사를 받는다 (사용자 결정) — 받는 사람은 아이템을 쓰지 않는다.
 *
 * 권한은 E-4 규약 그대로다: `ev: 'req'` 는 **요청**(누구나 → 호스트), `ev: 'serve'` 는 **사실**(호스트 → 전원)이고
 * 받는 쪽은 **로비 호스트가 보낸 것만** 받아들인다. 호스트는 `shared/buffRules.createBuffGuard` 의 네 겹
 * (모양 · 보낸 사람 · 거리 `MEAL_SERVE_RANGE` · 요율)을 지나게 한 뒤 **사거리 안의 사람에게만** 개별 전송한다 —
 * 그래서 `serve` 에는 받을 사람(`who`)이 실린다.
 */
export interface MealMessage { t: 'meal'; ev: 'req' | 'serve'; def: string; who?: PeerId }

/* ══ 2026-09-12 wire: 캐릭터 버프 · 가구 자세 (사용자 결정 — docs/plans/char-buffs.md) ══════════════════════════════════
 *
 * 앉기 · 운동 같은 가구 상호작용 상태가 **캐릭터 버프**가 됐고, 식사 · 준비물 · 운동 디버프 · 환경 노출도 같은 목록에 산다.
 * 분대원의 목록은 두 길로 온다:
 *
 *   1. **목록 자체**(`cbuf state`) — 보낸 사람의 목록이 바뀔 때 `others` 로 한 번 (드물다).
 *   2. **리비전**(`PlayerSnapshot.bfr`) — 20 Hz 스냅샷에 숫자 하나. 받는 쪽이 가진 목록의 리비전과 다르면 그 사람에게
 *      `cbufq sync` 를 보내 목록을 받는다 (`CHAR_BUFF_SYNC_COOLDOWN_S` 에 한 번). 그래서 **늦게 합류하거나 함선을 방문한
 *      사람**, `cbuf` 를 놓친 사람도 따로 규칙 없이 따라온다 — 사용자 명세 「캐릭터 정보를 불러올 때 버프와 같이」.
 *
 * 가구 자세의 **연속 값**(anchor 높이 · yaw · 누적 위상 · 조각 uid)은 목록이 아니라 스냅샷(`fp` · `fu`)에 실린다 — 동작 위상은
 * 매 프레임 움직이므로 20 Hz 보간이 필요하고, 목록 메시지와 순서가 엇갈려도 자세는 늘 최신 스냅샷을 따른다.
 * 받는 쪽 가드: 로비 멤버가 보낸 것만 · `sanitizeCharBuffs` 로 모양 · 개수(`CHAR_BUFF_WIRE_MAX`)를 자른다. 버프에는 게임 효과가
 * 없으므로(사용자 결정) 권위 검사는 필요 없다 — 효과가 있는 식사 · 준비물은 여전히 자기 프로필이 원본이다.
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════════ */

import type { FurniturePoseKind } from './types';
import type { CharBuff } from './charBuffs';

/** 가구 자세 번호 — `PlayerSnapshot.fp[0]` 이 이 배열의 인덱스다. 순서를 바꾸지 않는다 (추가만). */
export const FURNITURE_POSE_WIRE: readonly FurniturePoseKind[] = ['sit', 'bench', 'run', 'cycle'];

/** 보낸 사람의 버프 목록 전부. `rev` = `PlayerRef.buffsRevision`. */
export interface CharBuffMessage { t: 'cbuf'; ev: 'state'; rev: number; buffs: CharBuff[] }
/** 받는 사람 → 보낸 사람: 네 목록을 달라 (스냅샷 `bfr` 가 내가 가진 리비전과 다를 때). */
export interface CharBuffRequest { t: 'cbufq'; ev: 'sync' }

export interface PlayerSnapshot {
  /* appended (2026-09-12): 캐릭터 버프 · 가구 자세 — optional, 옛 송신자와 호환 */
  /** `PlayerRef.buffsRevision`. 0 · 생략 = 버프가 한 번도 없었다. */
  bfr?: number;
  /**
   * 가구 자세 중에만: `[FURNITURE_POSE_WIRE 인덱스, anchor y, yaw, 누적 위상]` (`FurniturePoseState`). 발의 x · z 는 `p` 가 이미
   * anchor 의 x · z 다 (자세 중 player 가 발을 거기 박는다). 자세가 없으면 생략.
   */
  fp?: [number, number, number, number];
  /** 가구 자세의 조각 uid (`FurniturePoseState.furnitureUid`). 자세가 없거나 모르면 생략. */
  fu?: string;
}

/** 원격 분대원의 가구 자세 — net 이 스냅샷 `fp` · `fu` 를 보간해 만든다. */
export interface RemoteFurniturePose {
  kind: FurniturePoseKind;
  anchorY: number;
  yaw: number;
  /** 보간된 누적 위상 (`FurniturePoseState.phase` 규약). */
  phase: number;
  furnitureUid: string | null;
}

export interface RemotePlayerRef {
  /* ── appended (2026-09-12): 캐릭터 버프 · 가구 자세 (owner: net) ── */
  /** 이 분대원의 버프 목록 (`cbuf state` 로 받은 마지막 것, 검증 뒤). 아직 모르면 빈 배열. 바뀌면 새 배열이다. */
  readonly buffs?: readonly CharBuff[];
  /** 지금 `buffs` 의 리비전 (0 = 아직 받은 적 없음). */
  readonly buffsRevision?: number;
  /** 가구 자세 중이면 보간된 값, 아니면 null. 고스트 · stale 이면 null. */
  readonly furniturePose?: RemoteFurniturePose | null;
}

/* ══ 2026-09-09 wire: 시체 · 구조선 · 강하 포드 · 분대장 기기 · 안개 ════════════════════════════════════════
 *
 * 권한 규칙은 기존과 같다 — **호스트가 진실의 원본**이고, 늦게 합류한 클라이언트는 `*q sync` 로 현황을 받는다.
 * 다만 시체의 **내용물**은 이미 있는 `cont` (ContainerMessage) 경로를 그대로 탄다: 시체는 컨테이너 하나이고
 * 그 id 가 `pcorpse:<owner>:<n>` 일 뿐이다. 아래 메시지는 시체가 **어디에 있고 누구 것인지**만 나른다.
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════ */

/** 시체 안의 아이템 하나 — 정의 id · 개수 · (무기/방어구면) 내구도·장전·소켓. `PickupWire.ex` 와 같은 그릇이다. */
export interface CorpseItemWire { defId: string; qty: number; ex?: ItemInstanceExtras }
/**
 * 한 구의 시체. `items` 는 **사망 시점의 전부**(장비 · 임플란트 · 가방 · 퀵슬롯)이고 굴림이 아니라
 * 실측이므로 반드시 와이어에 실린다 — 상자처럼 시드로 재현할 수 없다. 받은 쪽은 이걸로
 * `openContainerItemsSized('pcorpse:...', ...)` 컨테이너를 만들고, 이후의 **가져가기**는 기존
 * `cont` / `contq` 호스트 권한 경로를 그대로 탄다.
 */
export interface PlayerCorpseWire {
  id: string;
  owner: PeerId;
  name: string;
  p: Vec3Tuple;
  yaw: number;
  /** 사망 시각 (보낸 쪽 `ctx.missionTime`). */
  at: number;
  items: CorpseItemWire[];
  /**
   * appended (2026-09-11, C-63): 보낸 쪽에서 시체가 **전차에 실려 있으면** 그 전차(`TramDef.id`)와 차량 로컬 좌표 ·
   * 차량 기준 yaw. 받는 쪽은 `p` 로 발판을 찾지 않고 자기 전차의 **현재** 변환으로 이 로컬 좌표를 푼다 — 보간 지연
   * 때문에 전차 후미 끝의 시체가 전차를 놓치던 틈. 생략 = 탑승 없음(옛 클라이언트 · 땅 위 시체), 모르는 id = 무시하고 `p`.
   */
  ride?: { tram: string; local: Vec3Tuple; yaw: number };
}
/**
 * 사망한 플레이어의 시체. `spawn` 은 **죽은 본인**이 all 로 보낸다 (자기 인벤토리만이 진실이므로).
 * `sync` 는 호스트가 `pcorpseq sync` / `flow rejoined` 에 답하는 전체 목록이다 — 그래서 호스트는
 * 남의 시체도 `items` 채로 들고 있어야 한다.
 */
export type CorpseMessage =
  | { t: 'pcorpse'; ev: 'spawn'; corpse: PlayerCorpseWire }
  | { t: 'pcorpse'; ev: 'emptied'; id: string }
  | { t: 'pcorpse'; ev: 'sync'; corpses: PlayerCorpseWire[] };
/** 클라이언트 → 호스트: 지금 서 있는 시체 목록을 달라 (`world:ready` 이후 · 재합류). */
export type CorpseRequest = { t: 'pcorpseq'; ev: 'sync' };

/**
 * 구조선 투하. 분대 공용 카운터는 **호스트가 들고 있다** — 아무나 `req` 를 보내고 호스트가
 * `grant`(횟수 차감 + 착륙 지점 확정) 또는 `deny` 로 답한다. `count` 는 남은 횟수 방송이다.
 * 착륙 지점은 호스트가 `world.scatterPoints` 로 뽑아 겹치지 않게 정한다.
 */
export type RescueMessage =
  | { t: 'rescue'; ev: 'req'; target: PeerId; p: Vec3Tuple }
  | { t: 'rescue'; ev: 'grant'; callId: string; target: PeerId; by: PeerId; p: Vec3Tuple; eta: number }
  | { t: 'rescue'; ev: 'deny'; reason: 'empty' | 'alive' | 'busy' }
  | { t: 'rescue'; ev: 'count'; left: number };

/**
 * **강하 포드를 남들도 보이게** 하는 유일한 메시지 (2026-09-09). 지금까지 원격 분대원은 자리에 그냥
 * 스폰된 것처럼 보였다. 미션 시작 강하와 구조선 강하 둘 다 이걸 보낸다 — 받은 쪽은 `who` 의 아바타를
 * 숨긴 채 포드를 떨어뜨리고, 문이 열리면 아바타를 되돌린다.
 * `kind`: 0 = 미션 시작, 1 = 구조선.
 */
export interface PodMessage { t: 'pod'; ev: 'drop'; who: PeerId; p: Vec3Tuple; yaw: number; kind: 0 | 1 }

/**
 * 분대장 기기 — 호스트가 완전히 사망하면 시체 옆에 떨어지는 **오브젝트**(아이템이 아니다).
 * `drop` 은 죽은 호스트가, `taken` 은 3초 홀드를 마친 사람이 보낸다. 실제 호스트 교체는
 * `NetRef.transferHost(me, true)` → 서버 → `lobby:state` 로 확정되고, 이 메시지는 오브젝트만 치운다.
 */
export type LeaderMessage =
  | { t: 'lead'; ev: 'drop'; p: Vec3Tuple; host: PeerId }
  | { t: 'lead'; ev: 'taken'; by: PeerId }
  | { t: 'lead'; ev: 'sync'; p: Vec3Tuple | null; host: PeerId | null };
/** 클라이언트 → 호스트: 지금 바닥에 분대장 기기가 있나. */
export type LeaderRequest = { t: 'leadq'; ev: 'sync' };

/**
 * 전장의 안개. 평소에는 **와이어가 없다** — 모두가 이미 흐르는 `ps` 스냅샷의 분대원 좌표로
 * 각자 자기 마스크를 칠하므로 자연히 같아진다. 늦게 합류한 사람만 호스트에게 지금까지의 마스크를 받는다.
 * `mask` 는 `FogRef.serialize()` 의 base64.
 */
export type FogMessage = { t: 'fog'; ev: 'sync'; mask: string };
export type FogRequest = { t: 'fogq'; ev: 'sync' };

export type GameMessageType = GameMessage['t'];
export type GameMessageOf<T extends GameMessageType> = Extract<GameMessage, { t: T }>;

/* ── Runtime refs on ctx ───────────────────────────────────────────────────── */

/** Avatar for a remote player, created by player/RemotePlayerSystem and attached to the RemotePlayerRef. */
export interface RemoteAvatarRef {
  readonly root: THREE.Object3D;
  /** Right-hand socket; weapons/WeaponSystem parents a WeaponModel here (weapon -Z = barrel forward). */
  readonly weaponSocket: THREE.Object3D;
  getHeadPosition(out: THREE.Vector3): THREE.Vector3;
}

/**
 * Interpolated view of a remote player. Owned/updated by net/NetSystem every frame (position, yaw, … are
 * smoothed toward the snapshot stream). Read-only for everyone except `avatar`, which player/RemotePlayerSystem sets.
 */
export interface RemotePlayerRef {
  readonly id: PeerId;
  readonly name: string;
  readonly slot: number;
  /** Interpolated feet position (world). Scratch-safe: the same Vector3 instance for the ref's lifetime. */
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  readonly yaw: number;
  readonly pitch: number;
  readonly stance: Stance;
  /** PlayerFlags bitfield from the latest snapshot. */
  readonly flags: number;
  readonly hp: number;
  readonly maxHp: number;
  readonly isDead: boolean;
  readonly weaponId: string | null;
  readonly stridePhase: number;
  readonly moveBlend: number;
  /** ctx.time when the last snapshot arrived. */
  readonly lastUpdate: number;
  /** false once the peer left (ref is removed shortly after). */
  readonly connected: boolean;
  /** true when no snapshot arrived for NET_STALE_AFTER seconds. */
  readonly stale: boolean;
  avatar: RemoteAvatarRef | null;
  /* appended (Phase 2): `flags & DOWNED` — crawling, revivable (RemotePlayerSystem registers a `revive:<id>` interactable). */
  readonly isDowned: boolean;
  /* appended (tactical kit) */
  /** Wielded implant id from the latest snapshot, or null. */
  readonly implantId: ImplantId | null;
  /** Equipped armor def id from the latest snapshot. */
  readonly armorId: string | null;
  /** `flags & CLOAKED`. */
  readonly isCloaked: boolean;
  /* appended (Phase 7): suspended members / ghosts / mission membership */
  /**
   * true while the member's socket is down but the slot is kept (`LobbyPlayer.connected === false` during a session).
   * The ref stays alive (never removed for it); `position / hp / isDowned / isDead` then come from the host's
   * `ghost state` instead of snapshots, so consumers keep treating the ref as present (enemies target it, the avatar
   * stays visible in grey with `SUSPENDED_LABEL_KO`). `stale` is still true (no snapshots) — check `suspended` first.
   */
  readonly suspended: boolean;
  /** `LobbyPlayer.inMission` mirror (false = in the hub / not part of the running mission). */
  readonly inMission: boolean;
  /* appended (Phase 9): ghost state on the ref (net applies `ghost state / sync`; game/ no longer keeps its own map) */
  /** Host ghost state while `suspended` (0 alive / 1 downed / 2 dead); undefined when the ref is snapshot-driven. */
  readonly ghostState?: GhostState;
  /** Ghost bleed pool while `ghostState === 1`. */
  readonly ghostDownHp?: number;
  /** `PlayerSnapshot.dhp` of the latest snapshot (the member's own down pool while DOWNED); undefined when unknown. */
  readonly downHp?: number;
}

export type NetStatus = 'offline' | 'connecting' | 'connected' | 'error';

export interface NetRef {
  readonly status: NetStatus;
  readonly connected: boolean;
  readonly localId: PeerId | null;
  readonly playerName: string;
  readonly lobby: LobbyState | null;
  /** true while a multiplayer mission is running (lobby started and not yet left). Single-player → false. */
  readonly inSession: boolean;
  /** true when this client is the lobby host. */
  readonly isHost: boolean;
  /** Authority to simulate enemies / extraction: single-player OR host. Systems gate on this. */
  readonly isAuthority: boolean;
  /** Local player's lobby slot (0 in single-player). */
  readonly localSlot: number;
  readonly rttMs: number;
  /** Invite code parsed from the page URL (?lobby=CODE) at startup, or null. UI pre-fills the join field with it. */
  readonly inviteCode: string | null;

  /** Connect to the relay (defaults to same-origin NET_WS_PATH or VITE_WS_URL). Resolves when `welcome` arrives. */
  connect(url?: string): Promise<void>;
  disconnect(): void;
  setPlayerName(name: string): void;

  createLobby(): void;
  joinLobby(code: string): void;
  leaveLobby(): void;
  setReady(ready: boolean): void;
  /** Host only: starts the mission for everyone (server broadcasts game:start → net emits game:newMission). */
  startGame(seed: number): void;
  /** Shareable invite URL for the current lobby (`?lobby=CODE`), or null. */
  getInviteUrl(): string | null;

  /** Send a game message. Default target 'others'. No-op when not in a session. */
  send(msg: GameMessage, to?: RelayTarget): void;
  /** Subscribe to a game message type. Returns unsubscribe. */
  onMessage<T extends GameMessageType>(type: T, handler: (msg: GameMessageOf<T>, from: PeerId) => void): () => void;

  getRemotePlayers(): readonly RemotePlayerRef[];
  getRemotePlayer(id: PeerId): RemotePlayerRef | undefined;
  /** Lobby player info for any peer (including local), or undefined. */
  getLobbyPlayer(id: PeerId): LobbyPlayer | undefined;

  /* ── appended: hub / quick match / reconnection ── */
  /** Persistent per-browser session token (localStorage). Sent on connect; the server derives a stable PeerId from it. */
  readonly sessionToken: string;
  /** true while auto-reconnect is running after an unexpected socket drop. */
  readonly reconnecting: boolean;
  /** true while we are a lobby member and that lobby's mission is running but we are NOT in it (hub after resume / late). */
  readonly missionInProgress: boolean;
  /**
   * Connect if needed (idempotent; resolves when `welcome` arrived). Called by the hub at startup; failure → offline
   * personal ship. Never throws for "already connected".
   */
  ensureConnected(): Promise<boolean>;
  /** Quick match: join an open public ship or create one. Result via `net:matched` / `net:lobbyUpdated` or `net:error`. */
  quickMatch(): void;
  /** Host only: make the ship public/private (quick-match eligibility). */
  setPublic(isPublic: boolean): void;
  /** Host only (not started): share the mission seed with the ship (`LobbyState.seed`). */
  setLobbySeed(seed: number): void;
  /**
   * Re-enter the running mission of our lobby (after a resume): sets `inSession`, emits `net:gameStarting` +
   * `game:newMission {seed: lobby.seed}` locally and sends `flow rejoined`; systems then request their syncs.
   * No-op unless `missionInProgress`.
   */
  rejoinMission(): void;
  /** Snapshots are also exchanged while in a lobby in phase 'hub' (shared ship). true when that is happening. */
  readonly inHubSession: boolean;

  /* ── appended: Phase 7 (2026-09-06) — profile store, raid session, host migration, training ── */
  /** Server profile store (documents + credits). Always present; `available` is false offline. */
  readonly profile: ProfileRef;
  /** Raid blob the server returned in `welcome.raid` (resume into a running raid), consumed by game/ on rejoin. */
  readonly raidBlob: RaidSessionBlob | null;
  /** Upload my mid-raid state (game/ calls it every RAID_SAVE_INTERVAL_S and on loot). No-op outside a raid session. */
  saveRaid(blob: RaidSessionBlob): void;

  /* ── appended: Phase 8 (2026-09-06) ── */
  /**
   * Best estimate of the relay's wall clock in epoch ms (`welcome.serverTime` plus the elapsed local time, refreshed
   * on every pong). Falls back to `Date.now()` while offline. Used for real-time systems that must agree across
   * devices and must not be advanced by moving the local clock — today only 온실 재배 (`GrowPlot.plantedAt`).
   */
  serverNow(): number;
  /** Kind of the lobby's running mission (`lobby.mode ?? 'raid'`), null when nothing runs. */
  readonly missionMode: MissionMode | null;
  /**
   * Start a mission for the lobby. `'raid'` (default) = host only, every member ready (as before). `'training'` = any
   * member, no ready gating; only the caller enters (server marks it `inMission`), the rest stay in the hub.
   */
  startGame(seed: number, mode?: MissionMode): void;
  /**
   * Leave the running mission but stay in the lobby (training exit / raid abort by a client): ends the session
   * locally (`inSession=false`, remotes cleared) and sends `lobby:mission {inMission:false}`.
   */
  leaveMission(): void;
  /** true once the local client was promoted to host DURING a session (authority taken over mid-mission). */
  readonly tookOver: boolean;
}

/* ── appended: Phase 7 — ghosts (host-simulated bodies of suspended members; owner: player/RemotePlayerSystem on the host) ── */
/** 0 alive (standing where they were), 1 downed (bleeding `dhp`), 2 dead. */
export type GhostState = 0 | 1 | 2;
export interface GhostWire {
  id: PeerId; p: Vec3Tuple; yaw: number; hp: number; dhp: number; st: GhostState;
  /** appended (2026-09-10): 실드 — 없거나 0 이면 생략된다. 옛 호스트가 보낸 고스트는 실드가 없다. */
  sh?: number;
}
/**
 * Host → all `state` (on change + NET_GHOST_STATE_HZ) while a member is suspended; `sync` = every ghost (reply to
 * `ghostq sync` / `flow rejoined`); `restore` → the returning member only: your body as the host left it — apply with
 * `PlayerRef.restoreState` (the host then drops the ghost); `gone` = ghost removed (member returned or left).
 */
export type GhostMessage =
  | { t: 'ghost'; ev: 'state'; g: GhostWire }
  | { t: 'ghost'; ev: 'sync'; ghosts: GhostWire[] }
  | { t: 'ghost'; ev: 'restore'; g: GhostWire }
  | { t: 'ghost'; ev: 'gone'; id: PeerId };
/** Client → host. `revive` = I finished the revive hold on suspended member `id` (their socket is down, so the host applies it). */
export type GhostRequest =
  | { t: 'ghostq'; ev: 'sync' }
  | { t: 'ghostq'; ev: 'revive'; id: PeerId };

/* ── appended: Phase 7 — host-authoritative container contents (owner: inventory) ── */
/**
 * Crate / corpse / supply contents are still rolled deterministically per client (seed ^ id), so only the TAKEN state is
 * shared: `idx` = index of the item in the roll order (`Container.fill`), `qty` = units taken from that stack.
 * Host → all `taken` (confirmation of a `contq take`; the taker adds the item to its bag on receipt, everyone else
 * removes it from their copy — or records it for a container they have not opened yet); `sync` = every taken entry
 * (reply to `contq sync` / `flow rejoined`). `t` entries are `[idx, qtyTaken]`.
 */
export interface ContainerTakenWire { id: string; t: [number, number][] }
export type ContainerMessage =
  /**
   * `rem` / `seq` appended (Phase 10, live container view sync): `rem` = units of `idx` left in the host's copy after
   * the take (omitted when the host cannot roll the container, e.g. a corpse it never opened); `seq` = the host's
   * monotonic take counter for this container, so a viewer drops a duplicate / out-of-order take instead of animating twice.
   */
  | { t: 'cont'; ev: 'taken'; id: string; idx: number; qty: number; by: PeerId; rem?: number; seq?: number }
  | { t: 'cont'; ev: 'denied'; id: string; idx: number }
  | { t: 'cont'; ev: 'sync'; items: ContainerTakenWire[] };
/** Client → host. `take` = I want `qty` units of item `idx` from container `id` (host validates against its taken map). */
export type ContainerRequest =
  | { t: 'contq'; ev: 'take'; id: string; idx: number; qty: number }
  | { t: 'contq'; ev: 'sync' };

/* ── helpers usable by both server and client ──────────────────────────────── */
/** Lobby code alphabet: no I/O/0/1 to avoid confusion when read aloud. */
export const NET_LOBBY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function isValidLobbyCode(code: string): boolean {
  if (code.length !== NET_LOBBY_CODE_LENGTH) return false;
  for (let i = 0; i < code.length; i++) if (!NET_LOBBY_ALPHABET.includes(code[i])) return false;
  return true;
}
/** Upper-case and strip separators / whitespace; invalid characters are then rejected by isValidLobbyCode. */
export function normalizeLobbyCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}
/** Strip markup / control characters, clamp to 16 chars, fall back to a default Korean name. */
export function sanitizePlayerName(raw: string): string {
  const s = raw.replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 16);
  return s.length > 0 ? s : '스캐빈저';
}

/* ── appended: tactical kit ───────────────────────────────────────────────── */

/** Any → all: implant FX that remotes must see (grapple wire, barrier, scan pulse, rocket). Owner: implants. */
export type ImplantMessage =
  | { t: 'imp'; ev: 'wield'; id: ImplantId; wielded: boolean }
  | { t: 'imp'; ev: 'grapple'; o: Vec3Tuple; p: Vec3Tuple | null }
  | { t: 'imp'; ev: 'dash'; o: Vec3Tuple; d: Vec3Tuple }
  | { t: 'imp'; ev: 'barrier'; active: boolean; p: Vec3Tuple; yaw: number; hp: number }
  | { t: 'imp'; ev: 'scan'; p: Vec3Tuple; radius: number }
  | { t: 'imp'; ev: 'rocket'; o: Vec3Tuple; d: Vec3Tuple }
  | { t: 'imp'; ev: 'rocketHit'; p: Vec3Tuple }
  /* appended (Phase 7): overcharge beam replication. `target` null = beam off; `self` = healing myself (no target). */
  | { t: 'imp'; ev: 'beam'; target: PeerId | null; self: boolean }
  /**
   * appended (Phase 10): the 배리어 is a shield carried in hand. Its transform comes from the sender's own
   * `PlayerSnapshot` (`p`, `yaw`) plus `PlayerFlags.BARRIER`, so only the state and durability travel here.
   * `ev:'barrier'` above is dead for the local implant but still parsed, so an older peer keeps working.
   */
  | { t: 'imp'; ev: 'shield'; up: boolean; hp: number }
  /* appended (2026-09-08): 실드 배쉬 · 정찰 one-shot — see the last section */
  | ImplantMessageAppended2026_09_08;

/**
 * Any → one peer: a friendly effect. 'heal' / 'boost' are the overcharge implant, 'revive' the defibrillator
 * and 'cloak' the cloak veil sharing its cloak with a nearby squadmate.
 * Owner: implants/ applies 'heal' and 'boost', gadgets/ applies 'revive' and 'cloak' — each kind has exactly
 * one owner so a buff is never applied twice.
 */
export interface BuffMessage {
  t: 'buff';
  kind: 'heal' | 'boost' | 'revive' | 'cloak';
  /** hp restored for 'heal' / 'revive'; speed multiplier for 'boost'; unused for 'cloak'. */
  amount: number;
  duration: number;
  /** Sender's display name for the kill / assist feed. */
  by: string;
}

/** Any → all: a melee swing landed (FX + audio on remotes). Owner: weapons. */
export interface MeleeMessage { t: 'melee'; p: Vec3Tuple; d: Vec3Tuple; hit: boolean }

/** Wire form of a deployable. */
export interface DeployableWire {
  id: string;
  kind: DeployableKind;
  owner: PeerId;
  p: Vec3Tuple;
  yaw: number;
  hp: number;
  maxHp: number;
  armed: boolean;
  /** Seconds of life left (0 = no expiry). */
  ttl: number;
  /** appended (2026-09-11): 드론 위에 올라탄 설치물이면 그 드론 id (`DroneWire.id`). 생략 = 바닥. */
  mount?: string;
}

/** Host → all: authoritative deployable state. Owner: gadgets. */
export type GadgetMessage =
  | { t: 'gad'; ev: 'spawn'; d: DeployableWire }
  | { t: 'gad'; ev: 'update'; id: string; hp: number; armed: boolean }
  | { t: 'gad'; ev: 'remove'; id: string; reason: 'destroyed' | 'recovered' | 'expired' }
  | { t: 'gad'; ev: 'fire'; id: string; target: Vec3Tuple }
  | { t: 'gad'; ev: 'sync'; items: DeployableWire[] };

/** Client → host: deployable requests. Owner: gadgets. */
export type GadgetRequest =
  /** `mount` appended (2026-09-11): 드론 윗면에 올리는 설치 요청이면 그 드론 id. */
  | { t: 'gadq'; ev: 'place'; gadget: GadgetId; p: Vec3Tuple; yaw: number; v?: Vec3Tuple; mount?: string }
  | { t: 'gadq'; ev: 'damage'; id: string; dmg: number }
  | { t: 'gadq'; ev: 'recover'; id: string }
  | { t: 'gadq'; ev: 'sync' }
  /** appended (2026-09-11): 보낸 사람(relay `from`) 소유의 무장된 원격 지뢰를 호스트가 전부 기폭한다. */
  | { t: 'gadq'; ev: 'detonate' };

/* ══ appended (2026-09-11): 네임드 로그 · 스캔 드론 (owner: enemies — shared/named.ts) ══════════════════════════ */
export type EnemyEventAppended2026_09_11 =
  /** Host → all: scan drone `id` pulsed (`n` of `of`). `tg` = peers inside radius `r` with line of sight (host includes its own id). */
  | { t: 'ee'; ev: 'scanPulse'; id: number; p: Vec3Tuple; r: number; n: number; of: number; tg: PeerId[] }
  /** Host → all: sniper `id`'s scope glints at `target` for `dur` s — the shot follows. */
  | { t: 'ee'; ev: 'glint'; id: number; dur: number; target: PeerId | null }
  /** Host → all: the sniper's shot (tracer · crack · impact). Damage is already resolved by the host (`dmg`). */
  | { t: 'ee'; ev: 'snipe'; id: number; from: Vec3Tuple; to: Vec3Tuple; hit: boolean; target: PeerId | null }
  /** Host → all: the hammer landed at `p` (FX · shake). */
  | { t: 'ee'; ev: 'hammer'; id: number; p: Vec3Tuple }
  /** Host → all: the heavy's minigun spray started (1) / stopped (0). Replicas draw tracers themselves; damage stays on the host. */
  | { t: 'ee'; ev: 'spray'; id: number; on: 0 | 1 }
  /**
   * appended (2026-09-11, C-48): enemy `id` spat acid from `from` at the **aim point** `to` (feet position after the
   * host's lead / body-height correction). For every target `ee acid` cannot name — a drone, another enemy, a
   * deployable, the smoke counter-spit (`fireAcidAt`). Replicas fly the same projectile; damage stays on the host.
   */
  | { t: 'ee'; ev: 'acidAt'; id: number; from: Vec3Tuple; to: Vec3Tuple };

/** Wire form of a gather node. */
export interface GatherWire { id: string; defId: string; p: Vec3Tuple; harvested: boolean }

/** Host ↔ client: harvestable plants (host-authoritative, same shape as pickups). Owner: world. */
export type HarvestMessage =
  | { t: 'harv'; ev: 'taken'; id: string; by: PeerId }
  | { t: 'harv'; ev: 'sync'; nodes: GatherWire[] };
export type HarvestRequest =
  | { t: 'harvq'; ev: 'take'; id: string }
  | { t: 'harvq'; ev: 'sync' };

/* ══ appended: Phase 10 — UI 개선 pass (2026-09-07) ═════════════════════════════════════════════════════════ */

/* ── 부상자 들쳐메기 (owner: player) ── */
/**
 * Carrier → everyone. The steady state rides on `PlayerFlags.CARRYING` + `PlayerSnapshot.cr`, so these one-shots only
 * buy instant feedback (and tell the host where a body landed when the carrier suspends mid-carry).
 */
export type CarryMessage =
  | { t: 'carry'; ev: 'pick'; target: PeerId }
  | { t: 'carry'; ev: 'drop'; target: PeerId; p: Vec3Tuple };

/* ── 발사 준비 패널 crew cards (owner: hub, relayed in the shared ship) ── */
/**
 * A member's ship-side crew card: what the READY panel needs but no snapshot carries — `PlayerSnapshot.imp` and `.w`
 * are nulled in the hub (`Snapshotter`) and `LobbyPlayer` has no level. Broadcast to `others` on `hub:entered`
 * (shared ship) and whenever level / implant / armor / weapons change, debounced by `CREW_CARD_MIN_INTERVAL_S`.
 */
export interface CrewCardWire {
  /** `ProgressionRef.level`. */
  level: number;
  /** Implant chosen on the ship (`ImplantsRef.equipped`), null = none. */
  implant: ImplantId | null;
  /** Equipped armor def id (mirrors `PlayerSnapshot.ar`, so one card is enough to pose a portrait). */
  armor: string | null;
  /** Equipped weapon def ids per slot, for the card / portrait (no attachments). */
  primary?: string | null;
  primary2?: string | null;
  secondary?: string | null;
}
export type CrewMessage =
  | { t: 'crew'; ev: 'card'; card: CrewCardWire }
  /**
   * Full card + the sender's opaque loadout document (`InventoryRef.captureCrewLoadout()`), answered to whoever sent
   * `crewq loadout`. The receiver validates it exactly like `RaidSessionBlob.inventory` before rendering.
   */
  | { t: 'crew'; ev: 'loadout'; card: CrewCardWire; loadout: unknown };
export type CrewRequest =
  | { t: 'crewq'; ev: 'sync' }
  | { t: 'crewq'; ev: 'loadout' };

export interface PlayerSnapshot {
  /* appended (Phase 10) — optional, older senders stay compatible. */
  /** PeerId of the downed squadmate on our right shoulder while `CARRYING`; omitted otherwise. */
  cr?: PeerId | null;
  /** Carried-shield hp while `BARRIER` is set, so remotes tint the panel and a late joiner needs no `imp shield`. */
  bhp?: number;
}

export interface RemoteAvatarRef {
  /**
   * Right-shoulder socket (appended Phase 10): a carried squadmate's body is parented here. Optional — a caller must
   * feature-detect, and `player/` lifts its children to the body render order like it does for `weaponSocket`.
   */
  readonly shoulderSocket?: THREE.Object3D;
}

export interface RemotePlayerRef {
  /* appended (Phase 10): 들쳐메기 */
  /** `PlayerSnapshot.cr` — the peer this ref is carrying, or null. */
  readonly carrying?: PeerId | null;
  /** `flags & CARRIED` — this ref's body hangs on `carriedBy`'s shoulder; ignore `position`. */
  readonly isCarried?: boolean;
  /** Peer carrying this ref (derived by net/ from everyone's `cr`), or null. */
  readonly carriedBy?: PeerId | null;
  /* appended (Phase 10): 배리어 방패 */
  /** `flags & BARRIER` — the peer's shield is raised (implants/ follows their position + yaw with it). */
  readonly isBarrierUp?: boolean;
  /** `PlayerSnapshot.bhp` of the latest snapshot; undefined when unknown. */
  readonly barrierHp?: number;
  /* appended (Phase 10): crew card */
  /** `CrewCardWire.level`; undefined until a `crew card` arrived. */
  readonly crewLevel?: number;
  /** Implant EQUIPPED on the ship — distinct from `implantId`, which is the *wielded* one and always null in the hub. */
  readonly equippedImplant?: ImplantId | null;
}

export interface NetRef {
  /* ── appended: Phase 10 — 발사 준비 패널 ── */
  /** Last `crew card` seen for `id`, including the local player's own card. null when none arrived. */
  getCrewCard(id: PeerId): CrewCardWire | null;
  /** Ask `id` for its full loadout (`crewq loadout`); the answer arrives as the `net:crewLoadout` event. */
  requestCrewLoadout(id: PeerId): void;
}

/* ══ appended: Phase 11 — 행성 선택 · 소셜 (2026-09-07) ═════════════════════════════════════════════════════ */

export interface NetRef {
  /* ── 목표 행성 ── */
  /** The squad's 목표 행성 (`lobby.planet`), or null outside a lobby / while nothing is picked. */
  readonly lobbyPlanet: PlanetId | null;
  /**
   * Host only, while not started: share the 목표 행성 with the ship (`lobby:planet`). Mirrors `lobby.planet`
   * optimistically like `setLobbySeed` does, so the host's own terminal reacts without a round trip.
   */
  setLobbyPlanet(planet: PlanetId): void;
  /**
   * `planet` appended (Phase 11): the raid's 목표 행성. Host only for `'raid'`; ignored for `'training'`.
   * A raid started without one is refused by the server (`no_planet`) — hub/ gates the launch slots long before that.
   */
  startGame(seed: number, mode?: MissionMode, planet?: PlanetId): void;

  /* ── 소셜 ── */
  /** Friends / requests / recent players / whispers / squad invites. Always present; `available` is false offline. */
  readonly social: SocialRef;
}

/* ══ appended: 2026-09-08 — 총알 추적 · 배리어 정면 흡수 · 실드 배쉬 · 정찰 rework ════════════════════════════════
 * These members are joined into `GameMessage` / `EnemyEvent` / `ImplantMessage` below (the unions are re-declared as
 * `type X = XBase | XAppended` — no existing member changed). Owners as noted.
 * ────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
/**
 * Client → host: a shot I fired (owner: enemies — `EnemyManagerRef.reportShot` forwards it on a non-host, the host
 * applies it to its simulated enemies). `o` origin, `d` unit direction, `r` range, `h` impact point or absent.
 */
export interface ShotReport { t: 'shotq'; o: Vec3Tuple; d: Vec3Tuple; r: number; h?: Vec3Tuple }

/** Host → one peer: an enemy melee attack was absorbed by **your** raised shield — deduct `amount` from it (owner: enemies → implants). */
export type EnemyEventAppended2026_09_08 =
  | { t: 'ee'; ev: 'barrierHit'; id: number; amount: number; p: Vec3Tuple };

export type ImplantMessageAppended2026_09_08 =
  /** Any → others: 실드 배쉬 swing FX at `p` facing `yaw` (damage is resolved by the caster on its own replicas → `hit`). */
  | { t: 'imp'; ev: 'bash'; p: Vec3Tuple; yaw: number }
  /** Any → others: the one-shot 정찰 pulse. Receivers reveal interactables + enemies inside `radius` of `p` for `dur` s. */
  | { t: 'imp'; ev: 'scanCast'; p: Vec3Tuple; radius: number; dur: number };

/* ══ appended: 2026-09-08 — 공용 함선 격납고 (owner: hub) ═══════════════════════════════════════════════════════
 * The shared ship's aft door opens onto a **격납고** where every squad member's 개인 함선 stands in its own bay.
 * Boarding one swaps the hub interior to that member's personal ship — read-only for someone else's.
 *
 * Rendering a peer's ship needs their housing layout, which nothing else on the wire carries. `ship state` is that
 * payload and behaves exactly like a `crew card`: broadcast to `others` on arrival in the shared ship and whenever
 * the sender's ship changes (debounced by `SHIP_VISIT_MIN_INTERVAL_S`), and answered on demand to `shipq state`.
 * ────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * What a visitor needs to **draw** a member's personal ship. Private data (창고 · 로드아웃 프리셋 · 도감 · 재배
 * 타이머) is deliberately absent — a visit is 둘러보기 only, so nothing here can be acted on.
 */
export interface ShipVisitWire {
  /** `SHIP_ROOM_COUNT` entries in room order — the door signs and 방 조명 of the visited ship. */
  rooms: { purpose: RoomPurpose; level: number }[];
  generatorLevel: number;
  storageLevel: number;
  /** Every placed piece (all rooms). The visitor's `FurnitureLayer` renders these instead of reading `ctx.housing`. */
  furniture: PlacedFurniture[];
  /** Books on 책장 shelves so the spines read right. Omitted when the ship has none. */
  books?: PlacedBook[];
  /** appended (2026-09-12, A-3e): 디스크 전시대 · 레코드랙에 꽂힌 것 (`ShipState.media`). 없으면 생략. */
  media?: PlacedBook[];
  /** appended (2026-09-12, A-3e): 켜 둔 TV · 레코드 플레이어 uid (`ShipState.toggled`). 없으면 생략. */
  toggled?: string[];
}
export type ShipVisitMessage = { t: 'ship'; ev: 'state'; ship: ShipVisitWire };
export type ShipVisitRequest = { t: 'shipq'; ev: 'state' };

export interface PlayerSnapshot {
  /**
   * 격납고 (2026-09-08): the PeerId whose 개인 함선 I am standing inside (my own id while in my own ship). Omitted
   * or null = 공유 함선 + 격납고, i.e. the deck everybody shares. Remote avatars are hidden for anyone whose `hs`
   * differs from ours, so two members touring the same ship see each other and nobody else.
   */
  hs?: PeerId | null;
}

export interface RemotePlayerRef {
  /* appended (2026-09-08): 격납고 */
  /** `PlayerSnapshot.hs` — the personal ship this peer is inside, or null on the shared deck. */
  readonly hubSite?: PeerId | null;
}

export interface NetRef {
  /* ── appended (2026-09-08): 공용 함선 격납고 ── */
  /** Last `ship state` seen for `id` (including our own), or null when none arrived yet. */
  getShipVisit(id: PeerId): ShipVisitWire | null;
  /** Ask `id` for its ship layout (`shipq state`); the answer lands as `net:shipVisit`. */
  requestShipVisit(id: PeerId): void;
}

/* ══ 2026-09-09: 분대장(호스트) 지명 이관 (owner: game/parts/Leader) ══════════════════════════════════════ */
export interface NetRef {
  /* ── appended (2026-09-09) ── */
  /**
   * 분대장(호스트)을 `targetId` 에게 넘긴다. 서버가 `lobby:transferHost` 를 처리하고 새 `lobby:state` 를
   * 뿌리면 모두가 `net:hostChanged` 를 받는다.
   *
   * 서버가 허용하는 경우는 둘뿐이다 — ① 부르는 사람이 지금 호스트다, 또는 ② `claim` 이 true 이고
   * 현재 호스트가 이 레이드에서 **완전히 사망**했다고 서버가 알고 있다 (분대장 기기). 그 외에는
   * `lobby:error {code:'not_host'}` 가 돌아온다. 세션 밖에서는 no-op.
   */
  transferHost(targetId: PeerId, claim?: boolean): void;
  /**
   * 호스트가 이 레이드에서 완전히 사망했다고 서버에 알린다 (호스트 본인이 보낸다).
   * 서버는 이 표시가 있을 때만 다른 사람의 `transferHost({claim:true})` 를 받아 준다.
   */
  reportHostDown(down: boolean): void;
}

/* ══ 2026-09-09: 레이드 플레이 개선 — 의사소통 · 구조물 · 전차 · 재해 · 로그 강하 ═══════════════════════════
 * 전부 `GameMessage` 에 **추가**된다 (아래 union 참고). 권위 규약은 기존과 같다:
 *   - `*q` 로 끝나는 것은 **요청**(누구나 → 호스트), 접미사 없는 것은 **사실**(호스트 → 전원).
 *   - 싱글 플레이에서는 아무것도 나가지 않는다 (`ctx.net` 이 없거나 `!inSession`).
 * ────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * 누구나 → 전원: 의사소통 휠 한 마디. `text` 는 **이미 완성된 문장**이다 (숫자가 든 문구는 보낸 쪽이 채운다).
 * 받는 쪽은 `id` 로 색 · 아이콘을, `text` 로 채팅 줄을 만든다. Owner: ui/hud/CommsWheel.
 */
export interface CommsMessage { t: 'comm'; id: CommsId; text: string }

/**
 * 구조물 (owner: world/Structures). 호스트가 지하실 잠금 해제 · 행성 스캔 · 로그 강하 소모를 확정한다 —
 * 두 사람이 같은 문을 동시에 열어 키카드가 둘 다 사라지는 일을 막는다.
 */
export type StructureMessage =
  | { t: 'struct'; ev: 'unlocked'; id: string; by: PeerId | null }
  | { t: 'struct'; ev: 'scanned'; id: string }
  /**
   * appended (2026-09-11): 창문 `w` 번이 깨졌다. **누구나 → 전원** (깬 사람이 보낸다 — 여러 명이 같은 창을 동시에
   * 깨도 결과가 같으므로 호스트 확정이 필요 없다). 호스트는 목록을 들고 있다가 `sync.glass` 에 싣는다.
   */
  | { t: 'struct'; ev: 'glass'; id: string; w: number }
  /** 이미 발생한 구조물 이벤트 전체 (늦게 합류 · 호스트 이관용). `glass` (appended 2026-09-11) = 깨진 창 `<id>:<w>`. */
  | { t: 'struct'; ev: 'sync'; unlocked: string[]; scanned: string[]; rogued: string[]; glass?: string[] };
export type StructureRequest =
  | { t: 'structq'; ev: 'unlock'; id: string }
  | { t: 'structq'; ev: 'scan'; id: string }
  | { t: 'structq'; ev: 'sync' };

/** 전차 한 대의 와이어 상태. `st` = `TRAM_STATES` 의 index. */
export interface TramWire { id: string; s: number; dir: 1 | -1; st: number }
/** 전차 (owner: world/Rails). 위치는 선로 위 거리 `s` 하나로 충분하다 — 경로는 시드 결정적이다. */
export type TramMessage =
  | { t: 'tram'; ev: 'state'; tram: TramWire }
  | { t: 'tram'; ev: 'sync'; trams: TramWire[] };
export type TramRequest =
  | { t: 'tramq'; ev: 'start'; id: string }
  | { t: 'tramq'; ev: 'sync' };

/**
 * 환경 재해 (owner: world/Hazard). 종류 · 시작 시각은 **미션 시드에서** 나오므로 평상시에는 아무것도 흐르지
 * 않는다 — 늦게 합류한 사람만 `hzq sync` 로 진행 상태(`HazardRef.serialize`)를 받는다.
 */
export type HazardMessage = { t: 'hz'; ev: 'sync'; data: string };
export type HazardRequest = { t: 'hzq'; ev: 'sync' };

/** 로그 강하 (owner: enemies/RogueDrop). 실제 적 스폰은 기존 `ee spawn` 이 싣는다 — 이건 예고 연출용이다. */
export type RogueDropMessage =
  | { t: 'rdrop'; ev: 'incoming'; dropId: string; p: Vec3Tuple; eta: number; count: number; boss: boolean }
  | { t: 'rdrop'; ev: 'landed'; dropId: string; p: Vec3Tuple };

/**
 * 2026-09-09 이후 `GameMessage` 에 더해지는 것들. 기존 union 선언은 손대지 않고 여기서 **합집합으로 확장**한다
 * — `GameMessage` 는 `GameMessageType` / `GameMessageOf` 의 원본이므로 이 파일 안에서 한 번만 넓힌다.
 */
export type RaidContentMessage =
  | CommsMessage
  | StructureMessage
  | StructureRequest
  | TramMessage
  | TramRequest
  | HazardMessage
  | HazardRequest
  | RogueDropMessage;

/* ══ appended (2026-09-10): 방탄복 = 실드 ═══════════════════════════════════════════════════════════════ */

export interface PlayerSnapshot {
  /**
   * 실드(방탄복이 주는 추가 체력)와 그 최대치. **방탄복을 입었을 때만 실린다** (`dhp` 가 전투불능일 때만
   * 타는 것과 같은 규약) — 옛 송신자는 둘 다 없다. 원격 체력 바가 실드를 그리고, 호스트가 고스트를 만들 때
   * 그 사람의 실드를 물려주며, 재접속 복귀(`ghost restore`)가 실드를 되돌려 준다.
   */
  sh?: number;
  shm?: number;
}

export interface RemotePlayerRef {
  /** `PlayerSnapshot.sh` — 이 peer 의 현재 실드. 방탄복이 없거나 아직 모르면 undefined. */
  readonly shield?: number;
  /** `PlayerSnapshot.shm` — 이 peer 의 실드 최대치. */
  readonly maxShield?: number;
}

/* ══ appended (2026-09-10): 서버 주소 — 배포용 릴레이에 붙는 길 ════════════════════════════════════════════
 * 릴레이는 이제 저장소 없이도 켤 수 있는 **단독 exe**(`server/tool.ts` → `npm run server:dist`)로 배포되고,
 * 클라이언트는 그 주소를 **네 곳**에서 얻는다. 위에서부터 먼저 이긴다:
 *
 *   ① 게임 안 `설정 › 서버 설정` 에 적은 주소  (localStorage `RELAY_STORAGE_KEY`, 캐릭터 슬롯 공용)
 *   ② `SCAVANGER.exe --relay=<url>` / `SCAV_RELAY`
 *   ③ exe 옆 `relay.txt` 첫 줄
 *   ④ 아무것도 없음 → 같은 오리진의 `/ws` (vite 프록시 · 데스크톱 앱의 임베디드 릴레이)
 *
 * ②③④ 는 셸(`electron/main.ts`)이 고르고 렌더러에는 **같은 오리진 `/ws`** 로만 보인다 — 그래서 ① 만
 * `defaultUrl()` 안에서 갈라지면 된다. 브라우저에서도 ① 은 그대로 동작한다.
 * ──────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** 사용자가 적어 둔 릴레이 주소 (`scav.relay`). **슬롯 공용 키**다 — `saveSlot.SHARED_KEYS` 참고. */
export const RELAY_STORAGE_KEY = 'scav.relay';

/**
 * 사람이 적은 주소 한 줄 → 완전한 ws URL. `ws://host:port/ws` 는 그대로, `host:port` 와 맨 `host` 는
 * 포트(`NET_DEFAULT_PORT`)와 경로(`NET_WS_PATH`)를 채운다. 형식이 아니면 `null`.
 *
 * `electron/main.ts`(프록시 목적지) · `ui/menus/SettingsMenu`(입력 검사) · `net/parts/Socket`(접속)이 **같은**
 * 함수를 쓴다 — 셋이 각자 정규화하면 설정에서 초록불이 뜬 주소로 앱이 다른 데 붙는다.
 */
export function relayUrlFrom(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(/^wss?:\/\//i.test(text) ? text : `ws://${text}`);
  } catch {
    return null;
  }
  if (!url.hostname) return null;
  if (!url.port) url.port = String(NET_DEFAULT_PORT);
  if (!url.pathname || url.pathname === '/') url.pathname = NET_WS_PATH;
  url.search = '';
  url.hash = '';
  return url.href;
}

/** `probeRelay` 결과. `ms` 는 소켓 open 부터 `welcome` 까지. */
export interface RelayProbe {
  ok: boolean;
  /** 실제로 두드린 주소 (정규화 뒤). 주소가 틀렸으면 빈 문자열. */
  url: string;
  /** 왕복 시간 ms (실패면 0). */
  ms: number;
  /** 한국어 실패 사유 (성공이면 없음). */
  error?: string;
}

/**
 * 한 대의 컴퓨터에서 밖으로 보이는 IPv4 후보를 **쓸 만한 순서로** 정렬한다. 개발 PC 는 Hyper-V · WSL · VPN
 * 스위치까지 여러 개를 갖고 `ipconfig` 순서는 쓸모가 없으므로, 가상 어댑터를 뒤로 밀고 실제 사설망 범위를
 * 앞으로 당긴다. `scripts/lan-address.mjs`(배너)와 `server/tool.ts`(배포 서버의 첫 줄)가 같은 답을 내야 해서
 * 여기 있다. `networkInterfaces()` 의 결과를 그대로 넘긴다 — `shared/` 는 node 를 import 하지 않는다.
 */
export function lanAddresses(
  interfaces: Record<string, readonly { address: string; family: string | number; internal: boolean }[] | undefined>,
): { name: string; address: string }[] {
  const VIRTUAL = /vEthernet|VMware|VirtualBox|Hyper-V|WSL|Loopback|TAP|Tailscale|ZeroTier|Bluetooth|Npcap/i;
  const score = (name: string, address: string): number => {
    let s = VIRTUAL.test(name) ? 0 : 100;
    if (address.startsWith('192.168.')) s += 30;
    else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) s += 20;
    else if (address.startsWith('10.')) s += 10;
    else if (address.startsWith('169.254.')) s -= 50;        // APIPA: DHCP 가 응답하지 않았다
    else if (address.startsWith('100.')) s += 5;             // CGNAT 범위, Tailscale 도 여기다
    return s;
  };
  return Object.entries(interfaces)
    .flatMap(([name, addrs]) => (addrs ?? []).map((a) => ({ name, ...a })))
    .filter((a) => (a.family === 'IPv4' || a.family === 4) && !a.internal)
    .map((a) => ({ name: a.name, address: a.address, score: score(a.name, a.address) }))
    .sort((a, b) => b.score - a.score || a.address.localeCompare(b.address))
    .map(({ name, address }) => ({ name, address }));
}

export interface NetRef {
  /* ── appended (2026-09-10): 서버 주소 ── */
  /** 지금 접속에 쓰는(또는 쓸) 릴레이 주소. */
  readonly relayUrl: string;
  /** 설정에 적어 둔 주소 그대로 (없으면 빈 문자열 = 배포 기본값을 쓴다). */
  readonly relayOverride: string;
  /**
   * 설정의 주소를 바꾼다. 빈 문자열 = 기본값으로 되돌린다. 형식이 아니면 `false` 를 돌려주고 아무것도
   * 저장하지 않는다. **저장만 한다** — 실제로 옮겨 붙는 것은 `reconnectRelay()` 다.
   */
  setRelayOverride(raw: string): boolean;
  /**
   * 주소 하나를 **익명으로** 두드려 본다 (토큰을 보내지 않는다 — 보내면 서버가 같은 세션의 중복 접속으로
   * 보고 살아 있는 내 소켓을 끊는다). 살아 있는 연결 · 로비를 건드리지 않는다. 인자가 없으면 지금 설정값.
   */
  probeRelay(raw?: string): Promise<RelayProbe>;
  /** 저장된 주소로 다시 붙는다. 로비에 있었다면 떠난다. 성공 여부를 돌려준다. */
  reconnectRelay(): Promise<boolean>;
}

/* ══ appended: 2026-09-11 — 소셜 · 신뢰 · 연결 (docs/plans/net-social-trust.md) ═════════════════════════════════════
 * B-3 초대 결과 · B-4 차단 / 전송 확인 / 오프라인 보관 · E-6 문서 리비전 · B-1 링크 상태. 전부 추가만.
 * Owners: server/ (①소셜 · ③저장), net/ (②소셜 · ③ProfileSync · ④Socket), ui/ · hub/ (②④).
 * ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════ */

/** Client → server additions. Every social one needs a profile (anonymous → `social:error unavailable`). */
export type ClientToServerAppended2026_09_11b =
  /**
   * B-3: answer a squad invite by its `SquadInvite.id`. `accept` → the **server** moves me into the inviter's lobby
   * (`lobby:left {reason:'moved'}` + `lobby:state`; refused with `social:error` busy / full / started / not_found / expired),
   * `accept:false` → declined. Both close the invite on both sides (`social:inviteResult` / `social:inviteClosed`).
   */
  | { t: 'social:inviteReply'; id: string; accept: boolean }
  /**
   * B-4: block / unblock a 아이디. Blocking also removes them from my friends / incoming / outgoing / recent **and** me
   * from theirs, and closes open invites between us. Everything a blocked player sends me afterwards is swallowed
   * silently (they are never told). Answered with `social:state` (my `blocked` list), refused with `limit` over
   * `SOCIAL_BLOCK_MAX`.
   */
  | { t: 'social:block'; code: PlayerCode; blocked: boolean }
  /**
   * E-6: several documents in **one** transaction — the server checks every `baseRev` first and stores all or none.
   * Answered with one `profile:ack {txId, revs}` or one `profile:conflict {txId, docs}` (every conflicting key) or
   * `profile:refused {txId}` (a document over `PROFILE_DOC_MAX_BYTES`, bad key). A resend of the last accepted `txId` is acked again.
   */
  | { t: 'profile:setMany'; txId: string; docs: Partial<Record<ProfileDocKey, { doc: unknown; baseRev: number }>> };

/** Server → client additions. */
export type ServerToClientAppended2026_09_11b =
  /** B-3 → the **inviter**: how invite `id` to `code` ended. `reason` narrows `failed` (full · started · not_found · busy · in_mission). */
  | { t: 'social:inviteResult'; id: string; code: PlayerCode; name: string; outcome: InviteOutcome; reason?: SocialErrorCode }
  /** B-3 → the **invitee**: invite `id` is gone (the card closes). Not sent for the invitee's own reply. */
  | { t: 'social:inviteClosed'; id: string; outcome: InviteOutcome; reason?: SocialErrorCode }
  /**
   * B-4 → the sender of `social:whisper {nonce}`. `ok` = delivered (also true when the target blocked me — hidden),
   * `stored` = the target is an offline **friend** and the line went to their inbox, `!ok` → `code` (offline · not_found · invalid).
   */
  | { t: 'social:whisperAck'; nonce: number; ok: boolean; at?: number; stored?: boolean; code?: SocialErrorCode }
  /** B-4: whispers kept for me while I was offline (friends only), oldest first — sent once right after `welcome`, then the inbox is emptied. */
  | { t: 'social:whisperBacklog'; lines: { code: PlayerCode; name: string; text: string; at: number }[] }
  /** E-6: write `writeId` (a `profile:set`) or `txId` (a `profile:setMany`) was stored; `revs` = the new rev of every key written. */
  | { t: 'profile:ack'; writeId?: string; txId?: string; revs: Partial<Record<ProfileDocKey, number>> }
  /**
   * E-6: the write was made on a stale rev and nothing was stored. `docs` = the server's copy + rev of every conflicting key
   * (a `setMany` lists all of them). Policy (user decision): **the server wins** — the client adopts the copy, re-emits
   * `net:profileLoaded` for those keys and logs a warning.
   */
  | { t: 'profile:conflict'; writeId?: string; txId?: string; docs: Partial<Record<ProfileDocKey, { rev: number; doc: unknown }>> }
  /** E-6: the write can never succeed as sent (too large · unknown key · malformed) — drop it from the queue. */
  | { t: 'profile:refused'; writeId?: string; txId?: string; code: LobbyErrorCode };

/* ── B-1: 링크 상태 (owner: net/parts/Socket) ── */

/**
 * - `idle` — nothing tried yet this page (offline single-player until someone calls `ensureConnected`).
 * - `connecting` — a socket is opening (bounded by `NET_CONNECT_TIMEOUT_MS`).
 * - `connected` — `welcome` arrived.
 * - `unreachable` — the last attempt failed / timed out; an anonymous background probe runs on `NET_PROBE_BACKOFF_MS`
 *   (not for the desktop shell's embedded relay — `embedded`).
 * - `refused` — the server said kicked / server_full / duplicate: no probing, no auto-reconnect until an explicit connect.
 * - `reconnecting` — was connected, socket dropped, the reconnect backoff is running.
 */
export type NetLinkState = 'idle' | 'connecting' | 'connected' | 'unreachable' | 'refused' | 'reconnecting';

export interface NetLinkInfo {
  state: NetLinkState;
  /** The relay address this state is about (`NetRef.relayUrl`). */
  url: string;
  /** `unreachable`: ms until the next background probe (null = not probing, e.g. `embedded`). */
  nextProbeInMs?: number | null;
  /** `refused`: why. */
  refused?: 'kicked' | 'server_full' | 'duplicate';
  /** `reconnecting`: 1-based attempt. */
  attempt?: number;
  /** The target is the desktop shell's same-origin embedded relay (starts on demand — never probed). */
  embedded?: boolean;
  /** `unreachable` after a probe succeeded while in a raid / training: a server is there, connect from the ship. */
  found?: boolean;
}

export interface NetRef {
  /* ── appended (2026-09-11, B-1) ── */
  /** Current link state; changes are announced with `net:linkChanged`. */
  readonly link: NetLinkInfo;
}

/** B-1: a connect attempt that has not reached `welcome` within this long is closed and reported `unreachable`. */
export const NET_CONNECT_TIMEOUT_MS = 6000;
/** B-1: background anonymous probe schedule while `unreachable` (ms); the last value repeats. */
export const NET_PROBE_BACKOFF_MS: readonly number[] = [5000, 10000, 20000, 30000, 60000];
/**
 * B-1 (appended 2026-09-11, owner: electron/main.ts serves it): the desktop shell's loopback route answering
 * `{ target, source }` — which relay its same-origin `/ws` goes to. `ui/menus/SettingsMenu` shows it as the default line,
 * `net/parts/Socket` reads it to tell the **embedded** relay (never probed: it starts on the first `/ws`) from a
 * configured one. A browser / vite has no such route (vite answers index.html — not JSON).
 */
export const NET_SHELL_RELAY_ROUTE = '/__scav/relay';
