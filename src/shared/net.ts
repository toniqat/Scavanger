import type * as THREE from 'three';
import type { ChatKind, EnemyType, GamePhase, PingKind, Stance, ItemInstanceExtras, StratagemId } from './types';
import type { EnemySpawnSite } from './types';
import type { DeployableKind, GadgetId } from './gadgets';
/* appended (2026-09-15, sandworm eruption check): `PlayerSnapshot.ws` · `RemotePlayerRef.weightState` */
import type { WeightState } from './gear';
/* appended (2026-09-11): drones (owner: gadgets/drones) */
import type { DroneMessage, DroneRequest } from './drones';
/* appended (2026-09-09): raid play improvements — the communication wheel */
import type { CommsId } from './comms';
import type { ImplantId } from './implants';
/* appended (Phase 7, 2026-09-06): server profile / raid session */
import type { ProfileDocKey, ProfileRecord, ProfileRef, RaidSessionBlob } from './profile';
import type { MissionMode } from './types';
/* appended (Phase 11, 2026-09-07): planet selection + social */
import type { PlanetId } from './planets';
/* appended (2026-09-14): the intel broker — the fixed gimmicks carried on the lobby and the raid start (`src/meta/README.md` Decisions) */
import type { IntelPick } from './intel';
/* appended (2026-09-08): the shared ship's hangar — a visited member's ship layout rides on `ship state` */
import type { PlacedBook, PlacedFurniture, RoomPurpose } from './housing';
import type {
  PlayOutcome, PlayerCode, SocialErrorCode, SocialRef, SocialSnapshot, SquadInvite,
} from './social';
/* appended (2026-09-11): social · trust · link (commits `9bd72ce` (contract) · `b3fc2f0` (implementation)) */
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
  /* appended (2026-09-14): the intel broker — `src/meta/README.md` Decisions */
  /**
   * The **fixed gimmicks** the squad leader bought (`lobby:intel`); absent = nobody bought any. A squadmate reads it
   * in the ship and the intel broker panel shows a summary of it (read-only — only the leader buys and discards).
   * The raid start carries it into `game:start.intel` as it is, and `IntelWire.seed` then beats `seed` (「산 지역으로 간다」).
   */
  intel?: IntelWire | null;
}

/**
 * The intel that rides the wire. It is `IntelSpec` with `planet` taken out — the planet is already in
 * `LobbyState.planet` · `game:start.planet`, and writing it in two places could put them out of step. The server
 * sanitizes **the shape only** and broadcasts it as it is (treated like `planet` — the relay never computes a layout).
 */
export interface IntelWire {
  seed: number;
  picks: IntelPick[];
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
  | 'kicked'        // the operator ran `kick <id>` — socket closed right after, no reconnect grace (clients stop reconnecting)
  | 'server_full'   // over the operator's `max <n>` — socket closed; a lobby member reconnecting inside its grace is exempt
  /**
   * appended (2026-09-11, B-11): `lobby:join` / `social:play` into a lobby holding someone **I** blocked.
   * The mirror direction — a member who blocked *me* — is answered `not_found` on purpose, so a block never
   * shows through (the invite path hides it the same way, `server/Invites.ts` `hidden`). Only this direction,
   * my own choice, is told plainly.
   */
  | 'blocked'
  /** appended (2026-09-15, squad · dock matchmaking): `lobby:ready` · `lobby:start` (raid or training) · `lobby:mission` in a squad that has not docked yet. */
  | 'not_docked'
  /** appended (2026-09-15, abandoning a raid from the title): `lobby:mission {inMission:true}` from a member who abandoned this raid (`LobbyPlayer.drifted`). */
  | 'drifted';

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
  /** `intel` appended (2026-09-14): the fixed gimmicks the squad leader bought. When present, `seed` must be that intel's seed. */
  | { t: 'lobby:start'; seed: number; mode?: MissionMode; planet?: PlanetId; intel?: IntelWire | null }
  /**
   * appended (2026-09-14). Host only, while not started: tells the squad about the intel that was bought (or
   * discarded = null) → `LobbyState.intel`. Same shape as `lobby:planet`; the server sanitizes the shape only.
   */
  | { t: 'lobby:intel'; intel: IntelWire | null }
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
  /**
   * `keep` appended (2026-09-15, resuming from the title): `inMission:false` sent by a **reloaded page** (not a voluntary exit) — the
   * relay keeps my raid blob so the next boot can still resume or abandon with it. Absent = the blob is dropped (as before).
   */
  | { t: 'lobby:mission'; inMission: boolean; keep?: boolean }
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
  /* ── appended (Phase 11): the target planet ── */
  /**
   * Host only, while not started: pick the squad's 목표 행성 (`LobbyState.planet`). Broadcast as `lobby:state`, which
   * is what makes every member play the travel cutscene — there is no separate travel message. Refused with
   * `not_host` / `started`, and with `invalid` for an unknown id.
   */
  | { t: 'lobby:planet'; planet: PlanetId }
  /* ── appended (Phase 11): social. Every one of these needs a profile (a token); anonymous → `unavailable`. ── */
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
  /* ── appended (2026-09-09): naming a new squad leader ── */
  /**
   * Hands the squad leader (host) role to `targetId`. The server accepts it in exactly two cases:
   * ① the sender is the host right now, ② `claim` is true and the current host marked itself **fully dead** with
   * `lobby:hostDown` (the squad-leader device next to the corpse). Anything else is `not_host`.
   * `invalid` when `targetId` is not a connected member of the same lobby. On success a new `lobby:state` is broadcast.
   */
  | { t: 'lobby:transferHost'; targetId: PeerId; claim?: boolean }
  /**
   * The host itself tells the server it is fully dead in this raid (or alive again). Only while that mark is set does
   * the server allow someone else's `lobby:transferHost {claim:true}`. It is cleared automatically when the mission ends.
   */
  | { t: 'lobby:hostDown'; down: boolean }
  /* appended (2026-09-11): social · trust · link — see the last section */
  | ClientToServerAppended2026_09_11b
  /* appended (2026-09-13): crypto quotes — see the crypto quotes section */
  | ClientToServerAppended2026_09_13crypto
  /* appended (2026-09-14): group messenger rooms — see the group messenger rooms section */
  | ClientToServerAppended2026_09_14rooms
  /* appended (2026-09-15): squad · dock matchmaking — see the squad · dock matchmaking section */
  | ClientToServerAppended2026_09_15dock
  /* appended (2026-09-15): android squadmates — see the android squadmates section */
  | ClientToServerAppended2026_09_15android
  /* appended (2026-09-15): abandoning a raid from the title · drifting — see the last section */
  | ClientToServerAppended2026_09_15drift
  /* appended (2026-09-21): player ↔ player trust — `shared/playerTrust.ts` */
  | import('./playerTrust').TrustClientToServer;

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
  /** `intel` (appended, 2026-09-14): the fixed gimmicks the squad leader bought, echoed from `LobbyState.intel` as it is. */
  | { t: 'game:start'; seed: number; lobby: LobbyState; mode?: MissionMode; planet?: PlanetId; intel?: IntelWire | null }
  /* appended (Phase 7) */
  | { t: 'profile:docs'; profile: ProfileRecord }
  | { t: 'credits:result'; txId: number; ok: boolean; credits: number; reason?: string }
  | { t: 'relay'; from: PeerId; d: GameMessage }
  /** A peer disconnected/left mid-lobby or mid-game. `lobby` is the updated state (host may have migrated). */
  | { t: 'peer:left'; id: PeerId; lobby: LobbyState }
  | { t: 'pong'; ts: number; serverTime: number }
  /* ── appended (Phase 11): social. Pushed on every change to anyone the change concerns, never polled. ── */
  /** The whole social snapshot. Sent after `social:get`, after any mutation, and whenever a friend's presence moves. */
  | { t: 'social:state'; social: SocialSnapshot }
  /** Someone asked me into their squad. Held client-side for `SQUAD_INVITE_TTL_S`, accepted with a P hold. */
  | { t: 'social:invited'; invite: SquadInvite }
  /** A whisper arrived. `code` / `name` are the sender's. */
  | { t: 'social:whisper'; code: PlayerCode; name: string; text: string; at: number }
  /** How my `social:play` was resolved (`joined` = I am in their lobby now, `invited` = the invite went out). */
  | { t: 'social:play'; code: PlayerCode; name: string; outcome: PlayOutcome }
  | { t: 'social:error'; code: SocialErrorCode; message: string }
  /* appended (2026-09-11): social · trust · link — see the last section */
  | ServerToClientAppended2026_09_11b
  /* appended (2026-09-13): crypto quotes — see the crypto quotes section */
  | ServerToClientAppended2026_09_13crypto
  /* appended (2026-09-14): group messenger rooms — see the group messenger rooms section */
  | ServerToClientAppended2026_09_14rooms
  /* appended (2026-09-15): android squadmates — see the android squadmates section */
  | ServerToClientAppended2026_09_15android
  /* appended (2026-09-21): player ↔ player trust — `shared/playerTrust.ts` */
  | import('./playerTrust').TrustServerToClient;

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
  /** Downed: crawling, revivable (DEAD is not set). */
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
  /* appended (Phase 10): carrying a wounded squadmate */
  /** A downed squadmate is on this player's right shoulder — unarmed; `PlayerSnapshot.cr` names them. */
  CARRYING: 1 << 26,
  /** This player is carried by a squadmate (DOWNED is set too; ignore their `p`, use the carrier's socket). */
  CARRIED: 1 << 27,
  /* appended (2026-09-09): a speech bubble while typing in chat */
  /** Chat input is open (typing). Set by net from `ui:chatToggled`; remotes draw a `…` speech bubble over the head. */
  TYPING: 1 << 28,
  /* appended (2026-09-11): ladders */
  /** Hanging on a ladder (`PlayerRef.climbingLadder`); remotes play the climb pose, `p` moves vertically. */
  CLIMBING: 1 << 29,
  /* appended (2026-09-13): the rover */
  /** Riding inside the 탐사 차량 (`PlayerRef.roverRide`): remotes hide the avatar · nameplate; enemies do not target this player. */
  IN_ROVER: 1 << 30,
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
  /* appended (2026-09-15, sandworm eruption check) — optional, older senders stay compatible. */
  /**
   * Carry-weight state (`WeightInfo.state`) as an index into `WEIGHT_STATE_WIRE` (0 normal · 1 light · 2 heavy · 3 over).
   * The host's sandworm director counts sprinting squadmates who are `light` or heavier; omitted / unknown = `normal`.
   */
  ws?: number;
}

/** Wire order of `WeightState` for `PlayerSnapshot.ws` (2026-09-15). Never reorder — append only. */
export const WEIGHT_STATE_WIRE: readonly WeightState[] = ['normal', 'light', 'heavy', 'over'];

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
/**
 * appended (2026-09-15, result screen rework): `dmg.src` — the damage source (the wire shape of `PlayerDamageSource`).
 * The receiver passes it into its own `takeDamage(…, source)`. `k` = `DamageCauseKind`, `et` = the enemy's `EnemyType`
 * id verbatim, `ei` = the enemy's network id (the same on host and replica), `hz` = `HazardKind`. The sender already
 * decides `self` / `ally` from the receiver's point of view and puts it on the wire. An older client ignores this
 * field, and a message without it leaves the source undefined (= unknown).
 */
export interface DamageSourceWire { k: import('./types').DamageCauseKind; et?: string; ei?: number; hz?: string }
export interface DamageMessage { t: 'dmg'; amount: number; from?: Vec3Tuple; slow?: { duration: number; factor: number }; kb?: { d: Vec3Tuple; s: number }; /** appended (2026-09-15) */ src?: DamageSourceWire }
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
   * 2026-09-11 (named rogues — `ai/named/*` sets `Enemy.namedHint`): 14 sniper prone idle, 15 sniper glint / aiming,
   * 16 hammer windup, 17 hammer charge, 18 heavy spin-up, 19 heavy firing, 20 scan drone pulsing. Appended 2026-09-17: 25 artillery braced flat (before / after firing).
   * 2026-09-17 (appended): 23 hunter flipped and falling, 24 hunter lying flipped (`enemies/ai/HunterFlip`).
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
  | { t: 'ee'; ev: 'spawn'; id: number; ty: EnemyType; p: Vec3Tuple; yaw: number;
      /* appended (2026-09-13): burrow spawn — seconds spent digging up out of the ground. Omitted = it stands right there (the first placement · humanoids · a spat-out bug). */
      em?: number }
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
  | { t: 'ee'; ev: 'corpse'; id: number; ty: EnemyType; p: Vec3Tuple; w?: string; dd?: number; lt?: 0 | 1;
      /* appended (2026-09-13): the inputs of the corpse loot — `si` the spawn site (`EnemySpawnSite`), `gc` grenades
         left, `gk` their kind (`ENEMY_GRENADE_KINDS` index, omitted = 0 = frag). Omitted = none. A replica rolls the
         same list as the host. */
      si?: EnemySpawnSite; gc?: number; gk?: number }
  | { t: 'ee'; ev: 'corpseGone'; id: number }
  /**
   * appended (2026-09-16, 빈 시체 제거): the corpse of enemy `id` was **opened and emptied** — every client shortens that body's
   * `corpseLife` to delay + sink (`CORPSE_EMPTY_REMOVE_DELAY_S` + `CORPSE_EMPTY_SINK_S`); the normal despawn (`despawn` ·
   * `corpseGone`) follows. Decided by the host (its own `crate:looted`, or a client's `ecorpseq emptied` that passed the guard).
   * 2026-09-16 (2차): sent only once nobody has that corpse's loot window open (`cviewq`, `shared/corpseViewers`) — so the
   * delay counts from the moment the last viewer closed. Same timing for `pcorpse emptied`.
   */
  | { t: 'ee'; ev: 'corpseEmptied'; id: number }
  /* appended (Phase 7): rogue AI v2 */
  /** A rogue threw a grenade (replicas fly a visual one; the host resolves damage: own player directly, remotes via `dmg`). */
  | { t: 'ee'; ev: 'grenade'; id: number; p: Vec3Tuple; v: Vec3Tuple; fuse: number;
      /** appended (2026-09-13): grenade kind = `ENEMY_GRENADE_KINDS` index (omitted = 0 = frag). A replica picks the same model and explosion FX. */
      k?: number }
  /** The rogue grenade exploded (FX on replicas). */
  | { t: 'ee'; ev: 'grenadeHit'; p: Vec3Tuple;
      /** appended (2026-09-13): kind = `ENEMY_GRENADE_KINDS` index (omitted = the kind of the replicated grenade that was flying, or frag when there is none). An incendiary turns the fire-zone FX on for replicas too (the damage stays on the host). */
      k?: number }
  /* appended (2026-09-08): the barrier absorbing frontal hits — see the last section */
  | EnemyEventAppended2026_09_08
  /* appended (2026-09-11): named rogues · scan drones — see EnemyEventAppended2026_09_11 */
  | EnemyEventAppended2026_09_11
  /* appended (2026-09-13): sandworm events — see EnemyEventAppended2026_09_13 */
  | EnemyEventAppended2026_09_13;
/** Client → host (Phase 4): my shot intercepted shell `sid`. Owner: enemies. */
export interface InterceptRequest { t: 'intq'; sid: number; p: Vec3Tuple }

/** Host → all: extraction flow. Owner: extraction. */
export type ExtractionMessage =
  /**
   * `shipModel` appended (2026-09-21, 함선 구매 훅): the **caller's** ship (`LobbyPlayer.shipModel`, a plain string
   * for the same reason it is one there). The ship that lands is the one the person who pressed the console owns,
   * so it has to travel — a replica has no other way to know whose extraction this is. Omitted = the default.
   */
  | { t: 'ex'; ev: 'activated'; padId: string; duration: number; shipModel?: string }
  | { t: 'ex'; ev: 'tick'; remaining: number }
  | { t: 'ex'; ev: 'shipIncoming'; eta: number }
  | { t: 'ex'; ev: 'shipLanded' }
  | { t: 'ex'; ev: 'boarding'; boarded: PeerId[]; required: PeerId[] }
  /**
   * 2026-09-13 (appended optional): `riders` = who the host saw aboard (alive and inside the ship), `squadDone` = no
   * living squadmate is left outside the ship (only then does the raid end for everybody). Whether the receiver is
   * aboard is decided by **its own local judgement**. Omitted = an older host → squadDone true.
   */
  | { t: 'ex'; ev: 'liftoff'; riders?: PeerId[]; squadDone?: boolean }
  | { t: 'ex'; ev: 'reset' }
  /* appended (rejoin): host → one rejoining client, full extraction state in reply to `exq sync`. */
  | { t: 'ex'; ev: 'sync'; state: ExtractionSyncState }
  /* appended (2026-09-13, extraction rework): the departure grace started · the remaining time is synced every 0.5 s (`auto` = it was raised by the idle timer running out) */
  | { t: 'ex'; ev: 'depart'; remaining: number; auto: boolean }
  /* appended (2026-09-13, extraction rework): seconds left until the automatic departure after landing (every 1 s) */
  | { t: 'ex'; ev: 'wait'; remaining: number };

/** Snapshot of the host's extraction flow for a late / rejoining client. Owner: extraction. */
export interface ExtractionSyncState {
  /** 2026-09-13: `'departing'` appended — the landed ship is inside its departure grace. */
  stage: 'idle' | 'countdown' | 'shipIncoming' | 'shipLanded' | 'liftoff' | 'departing';
  padId: string | null;
  /** Countdown seconds left (stage 'countdown') or ship ETA (stage 'shipIncoming'). */
  remaining: number;
  boarded: PeerId[];
  required: PeerId[];
  /* ── appended (2026-09-13, extraction rework) — omitted = unknown (the receiver starts from its default) ── */
  /** Seconds left until the automatic departure grace after landing (`shipLanded`). */
  idleRemaining?: number;
  /** Seconds left until liftoff (`departing`). */
  departRemaining?: number;
  /** Was the departure grace raised by the idle timer running out (`departing`)? */
  departAuto?: boolean;
  /** Seconds since liftoff (`liftoff`) — it lines up when a player left behind resets the flow. */
  sinceLiftoff?: number;
  /** Was that liftoff the end for the whole squad (`liftoff`)? */
  squadDone?: boolean;
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
   * appended (2026-09-19): for a `'crate'` ping, the **container id** it snapped onto (`CrateDef.id` · a structure
   * container's spec id — the id `WorldRef.getLootContainers` · `peekContainerItems` · `takeContainerItemFor` use).
   * `allies/` takes its 「go check that crate」 order from this (`AllyRequest.targetId`); `label` beside it is a
   * display string (`보급 상자 (2등급)`) and never an id. Absent from a ping that snapped onto nothing — the
   * receiver then matches the crate by position.
   */
  containerId?: string;
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
   * appended (2026-09-11): `sync` = every already-opened crate / container id (`ids`, host → a late joiner),
   * `syncq` = the request for that list (anyone → host, `id` is the empty string). `opened` is anyone → everyone
   * (it only lines up the opened **look** — the contents are synced separately by `cont`). Owner: world.
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
  /* appended (2026-09-08): the shared ship's hangar — visiting a personal ship (owner: hub) */
  | ShipVisitMessage
  | ShipVisitRequest
  /* appended (2026-09-09): death / corpses · the rescue drop · drop pods · the squad-leader device · fog */
  | CorpseMessage
  | CorpseRequest
  | RescueMessage
  | PodMessage
  | LeaderMessage
  | LeaderRequest
  | FogMessage
  | FogRequest
  /* appended (2026-09-09): raid play improvements — communication · structures · the tram · hazards · rogue drops (see the section at the end of the file) */
  | RaidContentMessage
  /* appended (2026-09-11): drones (owner: gadgets/drones — shared/drones.ts) */
  | DroneMessage
  | DroneRequest
  /* appended (2026-09-11, A-3c): the shared ship's dining table (owner: net/parts/Meal — the `MealMessage` section below) */
  | MealMessage
  /* appended (2026-09-12): the character buff list (owner: net — the `CharBuffMessage` section below) */
  | CharBuffMessage
  | CharBuffRequest
  /* appended (2026-09-13): the rover (owner: world/rover — the `RoverMessage` section below) */
  | RoverMessage
  | RoverRequest
  /* appended (2026-09-15, B-14): the landing sound of a squadmate's fall (owner: player) */
  | FallMessage
  /* appended (2026-09-15): android squadmates (owner: allies) · raid entry loading (owner: game) — the section at the end of the file */
  | AllyMessage
  | AllyRequest
  | LoadMessage
  /* appended (2026-09-16): dining-table plates (owner: net/parts/Plates — the `PlateMessage` section below) */
  | PlateMessage
  | PlateRequest
  /* appended (2026-09-16): the empty-enemy-corpse request (owner: enemies/parts/CorpseEmpty) */
  | EnemyCorpseRequest
  /* appended (2026-09-16): who is looking into a corpse — an empty one sinks only after the window is closed (owner: shared/corpseViewers) */
  | CorpseViewRequest;
  /* append new message types above this line (keep `t` unique; prefix by owning folder if in doubt) */

/**
 * Dining-table plates (2026-09-16, owner: net/parts/Plates — the rules are the plate section of `shared/housing.ts`).
 * The shared ship's fixed dining table holds every squad member's plate and anyone may eat from one (a plate is not
 * used up · it becomes the eater's pending meal).
 *
 * `plate state` = the sender's **own** plate (`def` omitted = no plate, `q` omitted = quality 0, `fresh` 1 = just
 * cooked — for the toast). It goes to `others` whenever the plate changes while `inHubSession` and on entering the hub
 * session, and whoever enters asks for everybody's plates with `plateq sync` (a receiver answers the requester alone
 * with its own `plate state`). There is no authority check — a plate is the sender's own state, and eating only
 * touches **the eater's own** profile (`useMeal`). The receiver reads only lobby members (bots excluded), the meal id
 * (`getMealDef`) and a whole-number quality. Not one line of the server changes.
 */
export interface PlateMessage { t: 'plate'; ev: 'state'; def?: string; q?: number; fresh?: 1 }
/** Whoever entered the hub session → others: send me your plate. */
export interface PlateRequest { t: 'plateq'; ev: 'sync' }

/**
 * The shared ship's dining table (A-3c, 2026-09-11, owner: net/parts/Meal). When one person serves by spending one
 * cooked dish, **every squad member** gets the same meal (user's decision) — the receivers spend no item.
 *
 * Authority follows the E-4 rule as it is: `ev: 'req'` is a **request** (anyone → host), `ev: 'serve'` is a **fact**
 * (host → everyone), and a receiver accepts it **only from the lobby host**. The host puts it through the four layers
 * of `shared/buffRules.createBuffGuard` (shape · sender · distance `MEAL_SERVE_RANGE` · rate) and then sends it
 * individually **only to the people inside that range** — which is why `serve` carries the receiver (`who`).
 */
export interface MealMessage { t: 'meal'; ev: 'req' | 'serve'; def: string; who?: PeerId }

/* ══ 2026-09-12 wire: character buffs · furniture poses (user's decision — `src/player/README.md` Decisions) ══
 *
 * Furniture interaction states such as sitting and exercising became **character buffs**, and meals · preparations ·
 * the gym debuff · environment exposure live in the same list. A squadmate's list arrives by two roads:
 *
 *   1. **The list itself** (`cbuf state`) — once to `others` whenever the sender's list changes (rare).
 *   2. **The revision** (`PlayerSnapshot.bfr`) — one number in the 20 Hz snapshot. When it differs from the revision of
 *      the list the receiver holds, the receiver sends that person a `cbufq sync` and gets the list (at most once per
 *      `CHAR_BUFF_SYNC_COOLDOWN_S`). So **a late joiner or a ship visitor**, and anyone who missed a `cbuf`, follows
 *      along with no extra rule — the user's spec 「캐릭터 정보를 불러올 때 버프와 같이」.
 *
 * The **continuous values** of a furniture pose (anchor height · yaw · accumulated phase · piece uid) ride the snapshot
 * (`fp` · `fu`), not the list — the motion phase moves every frame, so it needs 20 Hz interpolation, and even when it
 * arrives out of order with a list message the pose always follows the newest snapshot.
 * Receiver guard: only from a lobby member · `sanitizeCharBuffs` trims the shape and the count (`CHAR_BUFF_WIRE_MAX`).
 * A buff has no game effect (user's decision), so no authority check is needed — meals and preparations, which do have
 * one, still have the owner's own profile as their source.
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════════ */

import type { FurniturePoseKind } from './types';
import type { CharBuff } from './charBuffs';

/** Furniture pose numbers — `PlayerSnapshot.fp[0]` is the index into this array. Never reorder (append only). */
export const FURNITURE_POSE_WIRE: readonly FurniturePoseKind[] = ['sit', 'bench', 'run', 'cycle', /* 2026-09-13 cooking minigame */ 'cook'];

/** The sender's whole buff list. `rev` = `PlayerRef.buffsRevision`. */
export interface CharBuffMessage { t: 'cbuf'; ev: 'state'; rev: number; buffs: CharBuff[] }
/** Receiver → sender: send me your list (when the snapshot's `bfr` differs from the revision I hold). */
export interface CharBuffRequest { t: 'cbufq'; ev: 'sync' }

export interface PlayerSnapshot {
  /* appended (2026-09-12): character buffs · furniture poses — optional, compatible with older senders */
  /** `PlayerRef.buffsRevision`. 0 · omitted = there has never been a buff. */
  bfr?: number;
  /**
   * Only while in a furniture pose: `[FURNITURE_POSE_WIRE index, anchor y, yaw, accumulated phase]`
   * (`FurniturePoseState`). The feet's x · z need no field — `p` is already the anchor's x · z (player pins the feet
   * there during the pose). Omitted when there is no pose.
   */
  fp?: [number, number, number, number];
  /** Uid of the pose's furniture piece (`FurniturePoseState.furnitureUid`). Omitted when there is no pose or it is unknown. */
  fu?: string;
}

/** A remote squadmate's furniture pose — net builds it by interpolating the snapshot's `fp` · `fu`. */
export interface RemoteFurniturePose {
  kind: FurniturePoseKind;
  anchorY: number;
  yaw: number;
  /** The interpolated accumulated phase (the `FurniturePoseState.phase` convention). */
  phase: number;
  furnitureUid: string | null;
}

export interface RemotePlayerRef {
  /* ── appended (2026-09-12): character buffs · furniture poses (owner: net) ── */
  /** This squadmate's buff list (the last one received by `cbuf state`, after validation). An empty array while unknown. A change makes a new array. */
  readonly buffs?: readonly CharBuff[];
  /** Revision of the current `buffs` (0 = never received one). */
  readonly buffsRevision?: number;
  /** The interpolated value while in a furniture pose, otherwise null. null for a ghost or a stale ref. */
  readonly furniturePose?: RemoteFurniturePose | null;
}

/* ══ 2026-09-09 wire: corpses · the rescue drop · drop pods · the squad-leader device · fog ═══════════════
 *
 * The authority rule is unchanged — **the host is the source of truth**, and a late-joining client gets the current
 * state with `*q sync`. The **contents** of a corpse simply ride the `cont` (ContainerMessage) path that already
 * exists: a corpse is one container whose id happens to be `pcorpse:<owner>:<n>`. The messages below carry only
 * **where a corpse is and whose it is**.
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════ */

/** One item inside a corpse — def id · count · (for a weapon / armor) durability, loaded rounds and sockets. The same vessel as `PickupWire.ex`. */
export interface CorpseItemWire { defId: string; qty: number; ex?: ItemInstanceExtras }
/**
 * One corpse. `items` is **everything at the moment of death** (equipment · implants · bag · quick slots), and it is a
 * measurement rather than a roll, so it must ride the wire — unlike a crate it cannot be reproduced from a seed. The
 * receiver builds an `openContainerItemsSized('pcorpse:...', ...)` container from it, and every **take** after that
 * rides the existing host-authoritative `cont` / `contq` path as it is.
 */
export interface PlayerCorpseWire {
  id: string;
  owner: PeerId;
  name: string;
  p: Vec3Tuple;
  yaw: number;
  /** Time of death (the sender's `ctx.missionTime`). */
  at: number;
  items: CorpseItemWire[];
  /**
   * appended (2026-09-11, C-63): when the corpse **rides a tram** on the sender's side, that tram (`TramDef.id`) plus
   * the vehicle-local position and the vehicle-relative yaw. The receiver does not look for a floor with `p` but
   * resolves these local coordinates against its own tram's **current** transform — the gap where interpolation lag
   * let a corpse at the tram's rear end lose the tram. Omitted = not riding (an older client · a corpse on the
   * ground); an unknown id = ignored, `p` is used.
   */
  ride?: { tram: string; local: Vec3Tuple; yaw: number };
}
/**
 * The corpse of a dead player. `spawn` is sent to all by **the person who died** (their own inventory is the only
 * truth). `sync` is the full list the host answers `pcorpseq sync` / `flow rejoined` with — which is why the host has
 * to keep somebody else's corpse with its `items` too.
 */
export type CorpseMessage =
  | { t: 'pcorpse'; ev: 'spawn'; corpse: PlayerCorpseWire }
  | { t: 'pcorpse'; ev: 'emptied'; id: string }
  | { t: 'pcorpse'; ev: 'sync'; corpses: PlayerCorpseWire[] };
/** Client → host: send me the list of corpses standing right now (after `world:ready` · on a rejoin). */
export type CorpseRequest = { t: 'pcorpseq'; ev: 'sync' };
/**
 * appended (2026-09-16, removing empty corpses — owner: enemies/parts/CorpseEmpty). Client → host: on my side the enemy
 * corpse container `corpse:<id>` went empty (`crate:looted`). Enemy corpse contents are rolled from a seed on every
 * client, so the host cannot know that a corpse it never opened is empty — hence a **request**. Once it passed shape →
 * sender → distance (`CORPSE_EMPTY_REQUEST_REACH_M`) → rate (`CORPSE_EMPTY_REQUEST_RATE_MAX` / `_BURST`), the host
 * broadcasts the **fact** as `ee corpseEmptied`.
 */
export interface EnemyCorpseRequest { t: 'ecorpseq'; ev: 'emptied'; id: number }
/**
 * appended (2026-09-16, an empty corpse disappears **once the looting ended** — owner:
 * `shared/corpseViewers.CorpseViewTracker`, used by: game · enemies). Client → host: my window opened / closed the
 * corpse container `id` (`pcorpse:…` · `corpse:<enemyId>`). The host keeps the viewers per corpse and broadcasts
 * `pcorpse emptied` · `ee corpseEmptied` only once there are none. Guard: `open` passes shape → sender (a living
 * snapshot) → distance (`CORPSE_EMPTY_REQUEST_REACH_M`) → rate (a per-sender bucket); `close` only removes the
 * sender's own entry. One person views one corpse at a time. On leaving · dropping · rejoining · death · walking out
 * of range the host removes it itself.
 */
export interface CorpseViewRequest { t: 'cviewq'; ev: 'open' | 'close'; id: string }

/**
 * The rescue drop. The squad's shared counter **is held by the host** — anyone sends `req` and the host answers with
 * `grant` (deduct one + fix the landing spot) or `deny`. `count` broadcasts how many are left.
 * The host picks the landing spot from `world.scatterPoints` so that they never overlap.
 */
export type RescueMessage =
  | { t: 'rescue'; ev: 'req'; target: PeerId; p: Vec3Tuple }
  | { t: 'rescue'; ev: 'grant'; callId: string; target: PeerId; by: PeerId; p: Vec3Tuple; eta: number }
  | { t: 'rescue'; ev: 'deny'; reason: 'empty' | 'alive' | 'busy' }
  | { t: 'rescue'; ev: 'count'; left: number };

/**
 * The only message that makes **a drop pod visible to everyone else** (2026-09-09). Until now a remote squadmate
 * looked as if they had simply spawned in place. Both the mission-start drop and the rescue drop send it — the
 * receiver hides `who`'s avatar, drops the pod and brings the avatar back when the door opens.
 * `kind`: 0 = mission start, 1 = the rescue drop.
 */
export interface PodMessage { t: 'pod'; ev: 'drop'; who: PeerId; p: Vec3Tuple; yaw: number; kind: 0 | 1 }

/**
 * The squad-leader device — an **object** (not an item) that drops next to the corpse when the host dies fully.
 * `drop` is sent by the host that died, `taken` by whoever finished the 3 s hold. The real host change is settled by
 * `NetRef.transferHost(me, true)` → server → `lobby:state`; this message only clears the object away.
 */
export type LeaderMessage =
  | { t: 'lead'; ev: 'drop'; p: Vec3Tuple; host: PeerId }
  | { t: 'lead'; ev: 'taken'; by: PeerId }
  | { t: 'lead'; ev: 'sync'; p: Vec3Tuple | null; host: PeerId | null };
/** Client → host: is there a squad-leader device on the ground right now? */
export type LeaderRequest = { t: 'leadq'; ev: 'sync' };

/**
 * Fog of war. Normally **nothing goes on the wire** — everyone paints their own mask from the squadmate positions of
 * the `ps` snapshots that already flow, so the masks agree by themselves. Only a late joiner gets the mask so far from
 * the host. `mask` is the base64 of `FogRef.serialize()`.
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
  /* appended (2026-09-15, sandworm eruption check) */
  /** `PlayerSnapshot.ws` of the latest snapshot decoded through `WEIGHT_STATE_WIRE`; undefined when the sender never said (older sender) → treat as `normal`. */
  readonly weightState?: WeightState;
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
  /** appended (2026-09-10): the shield — omitted when there is none or it is 0. A ghost from an older host has no shield. */
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
  /* appended (2026-09-08): the shield bash · the one-shot recon — see the last section */
  | ImplantMessageAppended2026_09_08;

/**
 * Any → one peer: a friendly effect. 'heal' / 'boost' are the overcharge implant, 'revive' the defibrillator
 * and 'cloak' the cloak veil sharing its cloak with a nearby squadmate.
 * Owner: implants/ applies 'heal' and 'boost', gadgets/ applies 'revive' and 'cloak' — each kind has exactly
 * one owner so a buff is never applied twice.
 */
export interface BuffMessage {
  t: 'buff';
  kind: 'heal' | 'boost' | 'revive' | 'cloak' | 'shield';
  /**
   * hp restored for 'heal' / 'revive'; speed multiplier for 'boost'; unused for 'cloak'.
   * appended (2026-09-21, 아군에게 실드 충전기): shield points for 'shield', and **-1 means「fill it up」**
   * (`shield_charger_full`, whose `items.csv` `shieldHp` is -1) — the receiver clamps to its own max either way.
   */
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
  /** appended (2026-09-11): the drone id (`DroneWire.id`) when the deployable rides on a drone. Omitted = on the ground. */
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
  /** `mount` appended (2026-09-11): the drone id when the request places it on top of a drone. */
  /** `hp` appended (2026-09-15, 2nd pass): **the durability left on the item** when a non-host places a deployable
      with `GadgetDef.wearsItemDurability` (the dome shield · the barricade). Omitted means 「unknown」, so the host stands
      it up at `ItemDef.durabilityMax` (as new) — exactly as an older client does. */
  | { t: 'gadq'; ev: 'place'; gadget: GadgetId; p: Vec3Tuple; yaw: number; v?: Vec3Tuple; mount?: string; hp?: number }
  | { t: 'gadq'; ev: 'damage'; id: string; dmg: number }
  | { t: 'gadq'; ev: 'recover'; id: string }
  | { t: 'gadq'; ev: 'sync' }
  /** appended (2026-09-11): the host detonates every armed remote mine owned by the sender (relay `from`). */
  | { t: 'gadq'; ev: 'detonate' };

/* ══ appended (2026-09-11): named rogues · scan drones (owner: enemies — shared/named.ts) ══════════════ */
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

/* ══ appended (2026-09-13): sandworm events (owner: enemies — `enemies/sandworm/Director`) ═══════════════════
 * Host-authoritative, and a receiver accepts only what the lobby host sent (the common `ee` rule). The sandworm
 * itself · its swarm · the spat-out bugs all arrive through the existing `ee spawn` (`em` for the burrow) and the `es`
 * snapshots, and acid through the existing `ee acid` · `ee acidAt`. The sandworm's wire animation hints
 * (`EnemyWire.a`) are 21 = spitting bugs (mouth open), 22 = the toxic volley winding up · firing.
 */
export type EnemyEventAppended2026_09_13 =
  /** Host → all: the omen — an eruption at `p` (on the ground) in `eta` seconds, damage radius `r`. A late joiner is sent it again with the `eta` that is left. */
  | { t: 'ee'; ev: 'wormWarn'; p: Vec3Tuple; eta: number; r: number }
  /**
   * Host → all: sandworm `id` erupted at `p` (dust · shake · sound). `hp` = the max hp that was rolled, `spit` =
   * seconds left of the bug-spitting stage (the rise included). `sy` 1 = a late-join / reconnect sync — it lines up
   * the max hp and the stage only, with no FX.
   */
  | { t: 'ee'; ev: 'wormErupt'; id: number; p: Vec3Tuple; r: number; hp: number; spit: number; sy?: 1;
      /** appended (2026-09-15): the kind that erupted (`sandworm` the adult · `sandworm_weak` the young one of threat 1). Omitted = an older host = the adult. The body was already stood up by `ee spawn.ty` — this value is for validation and for a late joiner's radius display. */
      ty?: EnemyType }
  /**
   * Host → all: sandworm `id` spat bugs out of its mouth `from`. `b` = the list of `[bug id, landing x, y, z]`, `T` =
   * the flight time (seconds). The bugs are created first by the `ee spawn` of the same frame, and a replica draws the
   * same arc itself from this event (after the landing it is the snapshots).
   */
  | { t: 'ee'; ev: 'wormSpit'; id: number; from: Vec3Tuple; b: [number, number, number, number][]; T: number };

/** Wire form of a gather node. */
export interface GatherWire { id: string; defId: string; p: Vec3Tuple; harvested: boolean }

/** Host ↔ client: harvestable plants (host-authoritative, same shape as pickups). Owner: world. */
export type HarvestMessage =
  | { t: 'harv'; ev: 'taken'; id: string; by: PeerId }
  | { t: 'harv'; ev: 'sync'; nodes: GatherWire[] };
export type HarvestRequest =
  | { t: 'harvq'; ev: 'take'; id: string }
  | { t: 'harvq'; ev: 'sync' };

/* ══ appended: Phase 10 — the UI improvement pass (2026-09-07) ════════════════════════════════════════════ */

/* ── carrying a wounded squadmate (owner: player) ── */
/**
 * Carrier → everyone. The steady state rides on `PlayerFlags.CARRYING` + `PlayerSnapshot.cr`, so these one-shots only
 * buy instant feedback (and tell the host where a body landed when the carrier suspends mid-carry).
 */
export type CarryMessage =
  | { t: 'carry'; ev: 'pick'; target: PeerId }
  | { t: 'carry'; ev: 'drop'; target: PeerId; p: Vec3Tuple };

/* ── crew cards of the launch READY panel (owner: hub, relayed in the shared ship) ── */
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
  /* appended (Phase 10): carrying */
  /** `PlayerSnapshot.cr` — the peer this ref is carrying, or null. */
  readonly carrying?: PeerId | null;
  /** `flags & CARRIED` — this ref's body hangs on `carriedBy`'s shoulder; ignore `position`. */
  readonly isCarried?: boolean;
  /** Peer carrying this ref (derived by net/ from everyone's `cr`), or null. */
  readonly carriedBy?: PeerId | null;
  /* appended (Phase 10): the barrier shield */
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
  /* ── appended: Phase 10 — the launch READY panel ── */
  /** Last `crew card` seen for `id`, including the local player's own card. null when none arrived. */
  getCrewCard(id: PeerId): CrewCardWire | null;
  /** Ask `id` for its full loadout (`crewq loadout`); the answer arrives as the `net:crewLoadout` event. */
  requestCrewLoadout(id: PeerId): void;
}

/* ══ appended: Phase 11 — planet selection · social (2026-09-07) ══════════════════════════════════════ */

export interface NetRef {
  /* ── the target planet ── */
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

  /* ── social ── */
  /** Friends / requests / recent players / whispers / squad invites. Always present; `available` is false offline. */
  readonly social: SocialRef;
}

/* ══ appended: 2026-09-08 — bullet tracking · barrier absorption · shield bash · recon rework ════
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

/* ══ appended: 2026-09-08 — the shared ship's hangar (owner: hub) ════════════════════════════════════════
 * The shared ship's aft door opens onto a **hangar** where every squad member's personal ship stands in its own bay.
 * Boarding one swaps the hub interior to that member's personal ship — read-only for someone else's.
 *
 * Rendering a peer's ship needs their housing layout, which nothing else on the wire carries. `ship state` is that
 * payload and behaves exactly like a `crew card`: broadcast to `others` on arrival in the shared ship and whenever
 * the sender's ship changes (debounced by `SHIP_VISIT_MIN_INTERVAL_S`), and answered on demand to `shipq state`.
 * ────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * What a visitor needs to **draw** a member's personal ship. Private data (the stash · loadout presets · the media
 * catalogue · growing timers) is deliberately absent — a visit is only for looking around, so nothing here can be
 * acted on.
 */
export interface ShipVisitWire {
  /** `SHIP_ROOM_COUNT` entries in room order — the door signs and room lighting of the visited ship. */
  rooms: { purpose: RoomPurpose; level: number }[];
  generatorLevel: number;
  storageLevel: number;
  /** Every placed piece (all rooms). The visitor's `FurnitureLayer` renders these instead of reading `ctx.housing`. */
  furniture: PlacedFurniture[];
  /** Books on the bookshelf shelves so the spines read right. Omitted when the ship has none. */
  books?: PlacedBook[];
  /** appended (2026-09-12, A-3e): what is slotted into the disc display stand · the record rack (`ShipState.media`). Omitted when there is none. */
  media?: PlacedBook[];
  /** appended (2026-09-12, A-3e): uids of the TV · record player left switched on (`ShipState.toggled`). Omitted when there is none. */
  toggled?: string[];
  /**
   * appended (2026-09-17): the look of a culture tank slot — the medium's def id (the colour comes from the receiver's
   * catalogue) and whether a cell line is in it (`s: 1`). The scaffold, the cell line's kind and the timer are not
   * carried (the 3D only draws 「something is in there」). Omitted when there is none.
   */
  cultures?: { uid: string; slot: number; medium: string; s?: 1 }[];
}
export type ShipVisitMessage = { t: 'ship'; ev: 'state'; ship: ShipVisitWire };
export type ShipVisitRequest = { t: 'shipq'; ev: 'state' };

export interface PlayerSnapshot {
  /**
   * The hangar (2026-09-08): the PeerId whose personal ship I am standing inside (my own id while in my own ship).
   * Omitted or null = the shared ship + the hangar, i.e. the deck everybody shares. Remote avatars are hidden for
   * anyone whose `hs` differs from ours, so two members touring the same ship see each other and nobody else.
   */
  hs?: PeerId | null;
}

export interface RemotePlayerRef {
  /* appended (2026-09-08): the hangar */
  /** `PlayerSnapshot.hs` — the personal ship this peer is inside, or null on the shared deck. */
  readonly hubSite?: PeerId | null;
}

export interface NetRef {
  /* ── appended (2026-09-08): the shared ship's hangar ── */
  /** Last `ship state` seen for `id` (including our own), or null when none arrived yet. */
  getShipVisit(id: PeerId): ShipVisitWire | null;
  /** Ask `id` for its ship layout (`shipq state`); the answer lands as `net:shipVisit`. */
  requestShipVisit(id: PeerId): void;
}

/* ══ 2026-09-09: naming a new squad leader (host) (owner: game/parts/Leader) ════════════════════ */
export interface NetRef {
  /* ── appended (2026-09-09) ── */
  /**
   * Hands the squad leader (host) role to `targetId`. Once the server handled `lobby:transferHost` and broadcast a new
   * `lobby:state`, everyone gets `net:hostChanged`.
   *
   * The server allows it in exactly two cases — ① the caller is the host right now, or ② `claim` is true and the
   * server knows the current host is **fully dead** in this raid (the squad-leader device). Anything else comes back
   * as `lobby:error {code:'not_host'}`. A no-op outside a session.
   */
  transferHost(targetId: PeerId, claim?: boolean): void;
  /**
   * Tells the server the host is fully dead in this raid (sent by the host itself).
   * Only while that mark is set does the server accept someone else's `transferHost({claim:true})`.
   */
  reportHostDown(down: boolean): void;
}

/* ══ 2026-09-09: raid play improvements — communication · structures · the tram · hazards · rogue drops ═══════
 * All of it is **added** to `GameMessage` (see the union below). The authority rule is unchanged:
 *   - anything ending in `*q` is a **request** (anyone → host); without that suffix it is a **fact** (host → everyone).
 *   - nothing goes out in single-player (no `ctx.net`, or `!inSession`).
 * ────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Anyone → everyone: one line of the communication wheel. `text` is **an already-finished sentence** (a phrase with a
 * number in it is filled in by the sender). The receiver builds the colour and icon from `id` and the chat line from
 * `text`. Owner: ui/hud/CommsWheel.
 */
export interface CommsMessage { t: 'comm'; id: CommsId; text: string }

/**
 * Structures (owner: world/Structures). The host settles unlocking a locked door (the basement · a locked room), the
 * planet scan and spending a rogue drop — so that two people opening the same door at once never lose both the key
 * and the keycard.
 */
export type StructureMessage =
  | { t: 'struct'; ev: 'unlocked'; id: string; by: PeerId | null }
  | { t: 'struct'; ev: 'scanned'; id: string }
  /**
   * appended (2026-09-11): window number `w` broke. **Anyone → everyone** (sent by whoever broke it — several people
   * breaking the same window at once end in the same result, so no host ruling is needed). The host keeps the list
   * and puts it into `sync.glass`.
   */
  | { t: 'struct'; ev: 'glass'; id: string; w: number }
  /**
   * appended (2026-09-21, B-100): the **ceiling turret** `id` picked a body, or let one go. Host → everyone, on a
   * change only (an idle turret says nothing). `tg` = the target: a PeerId (the host's own for the host's player)
   * · an android id · `''` for none. `st` = 0 parked · 1 acquired (the alarm · the aiming laser · the warm-up) ·
   * 2 armed (warm-up over, shooting every `CEIL_TURRET_INTERVAL_S`).
   *
   * Why a wire at all when no damage rides on it: switching **off** travels as `unlocked` and damage is the
   * authority's alone, but before 2026-09-21 the turning, the laser and the alarm were each client's own guess from
   * the door state plus 20 Hz positions — so a replica could paint a squadmate while the host was warming up on
   * **you**, and the one person who needed the warning never got it. The choice of body is now one fact.
   */
  | { t: 'struct'; ev: 'turret'; id: string; tg: string; st: 0 | 1 | 2 }
  /** Every structure event that already happened (for a late join · a host transfer). `glass` (appended 2026-09-11) = the broken windows `<id>:<w>`. */
  | { t: 'struct'; ev: 'sync'; unlocked: string[]; scanned: string[]; rogued: string[]; glass?: string[] };
export type StructureRequest =
  | { t: 'structq'; ev: 'unlock'; id: string }
  | { t: 'structq'; ev: 'scan'; id: string }
  | { t: 'structq'; ev: 'sync' };

/** The wire state of one tram. `st` = index into `TRAM_STATES`. */
export interface TramWire { id: string; s: number; dir: 1 | -1; st: number }
/** The tram (owner: world/Rails). One distance along the rail, `s`, is enough for the position — the route is seed-deterministic. */
export type TramMessage =
  | { t: 'tram'; ev: 'state'; tram: TramWire }
  | { t: 'tram'; ev: 'sync'; trams: TramWire[] };
export type TramRequest =
  | { t: 'tramq'; ev: 'start'; id: string }
  | { t: 'tramq'; ev: 'sync' };

/**
 * Environmental hazards (owner: world/Hazard). The kind and the start time come **from the mission seed**, so nothing
 * flows in normal play — only a late joiner gets the progress (`HazardRef.serialize`) with `hzq sync`.
 */
export type HazardMessage = { t: 'hz'; ev: 'sync'; data: string };
export type HazardRequest = { t: 'hzq'; ev: 'sync' };

/** Rogue drops (owner: enemies/RogueDrop). The actual enemy spawn still rides the existing `ee spawn` — this is for the warning FX. */
export type RogueDropMessage =
  | { t: 'rdrop'; ev: 'incoming'; dropId: string; p: Vec3Tuple; eta: number; count: number; boss: boolean }
  | { t: 'rdrop'; ev: 'landed'; dropId: string; p: Vec3Tuple };

/**
 * What is added to `GameMessage` after 2026-09-09. The existing union declaration is left alone and **widened by a
 * union** here — `GameMessage` is the source of `GameMessageType` / `GameMessageOf`, so it is widened exactly once
 * inside this file.
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

/* ══ appended (2026-09-10): armor = the shield ═════════════════════════════════════════════════════ */

export interface PlayerSnapshot {
  /**
   * The shield (the extra hp armor gives) and its maximum. **Carried only while armor is worn** (the same convention
   * as `dhp` riding only while downed) — an older sender has neither. The remote health bar draws the shield, the host
   * passes that person's shield on when it makes a ghost, and a reconnect (`ghost restore`) gives it back.
   */
  sh?: number;
  shm?: number;
}

export interface RemotePlayerRef {
  /** `PlayerSnapshot.sh` — this peer's current shield. undefined with no armor, or while it is still unknown. */
  readonly shield?: number;
  /** `PlayerSnapshot.shm` — this peer's maximum shield. */
  readonly maxShield?: number;
}

/* ══ appended (2026-09-10): the server address — how a build reaches a relay ═════════════════
 * 2026-09-15: **a build ships no server** — a relay is started only from this project folder's `start-server.bat`
 * (`npm run server` · `dev:all`) (the old standalone exe `server/tool.ts` and the desktop app's embedded relay are
 * gone). A client gets the address from **four places**, the topmost winning:
 *
 *   ① the address written into `설정 › 서버 설정` in game  (localStorage `RELAY_STORAGE_KEY`, shared by every slot)
 *   ② `SCAVANGER.exe --relay=<url>` / `SCAV_RELAY`
 *   ③ the first line of `server.txt` next to the exe (the old `relay.txt` is read too)
 *   ④ nothing at all → same-origin `/ws` (the vite proxy · the desktop app forwards it to this PC's `ws://127.0.0.1:8787/ws`)
 *
 * ②③④ are picked by the shell (`electron/main.ts`) and the renderer only ever sees **same-origin `/ws`** — so only ①
 * has to branch inside `defaultUrl()`. ① works in the browser just the same.
 * ──────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** The relay address the user wrote down (`scav.relay`). A **key shared by every slot** — see `saveSlot.SHARED_KEYS`. */
export const RELAY_STORAGE_KEY = 'scav.relay';

/**
 * One line of address a person typed → a full ws URL. `ws://host:port/ws` stays as it is; `host:port` and a bare
 * `host` get the port (`NET_DEFAULT_PORT`) and the path (`NET_WS_PATH`) filled in. `null` when it is not an address.
 *
 * `electron/main.ts` (the proxy target) · `ui/menus/SettingsMenu` (input validation) · `net/parts/Socket` (connecting)
 * all use **the same** function — three separate normalisations would let the app connect somewhere other than the
 * address the settings screen showed a green light for.
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

/** The result of `probeRelay`. `ms` is from the socket opening to `welcome`. */
export interface RelayProbe {
  ok: boolean;
  /** The address actually knocked on (after normalisation). An empty string when the address was wrong. */
  url: string;
  /** Round-trip time in ms (0 on failure). */
  ms: number;
  /** Korean failure reason (absent on success). */
  error?: string;
}

/**
 * Sorts one machine's outward-facing IPv4 candidates **into the order that is actually useful**. A development PC has
 * several of them, down to Hyper-V · WSL · VPN switches, and the `ipconfig` order is no help — so virtual adapters are
 * pushed back and the real private ranges pulled forward. It lives here because `scripts/lan-address.mjs` (the
 * start-server.bat banner) and `server/Console.ts` have to give the same answer. The result of `networkInterfaces()`
 * is passed straight in — `shared/` does not import node.
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
    else if (address.startsWith('169.254.')) s -= 50;        // APIPA: DHCP never answered
    else if (address.startsWith('100.')) s += 5;             // the CGNAT range; Tailscale lives here too
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
  /* ── appended (2026-09-10): the server address ── */
  /** The relay address this connection uses (or will use). */
  readonly relayUrl: string;
  /** The address written in the settings, verbatim (an empty string = the shipped default is used). */
  readonly relayOverride: string;
  /**
   * Changes the address in the settings. An empty string restores the default. When it is not an address it returns
   * `false` and stores nothing. **It only stores** — actually moving the connection over is `reconnectRelay()`.
   */
  setRelayOverride(raw: string): boolean;
  /**
   * Knocks on one address **anonymously** (no token is sent — sending one would make the server read it as a duplicate
   * connection of the same session and close my live socket). It touches neither the live connection nor the lobby.
   * With no argument it uses the current setting.
   */
  probeRelay(raw?: string): Promise<RelayProbe>;
  /** Reconnects to the stored address. Leaves the lobby when in one. Returns whether it succeeded. */
  reconnectRelay(): Promise<boolean>;
}

/* ══ appended: 2026-09-11 — social · trust · link (commits `9bd72ce` contract · `b3fc2f0` implementation) ═══════
 * B-3 invite outcome · B-4 blocking / delivery ack / the offline inbox · E-6 document revisions · B-1 link state. All add-only.
 * Owners: server/ (① social · ③ storage), net/ (② social · ③ ProfileSync · ④ Socket), ui/ · hub/ (② ④).
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

/* ── B-1: the link state (owner: net/parts/Socket) ── */

/**
 * - `idle` — nothing tried yet this page (offline single-player until someone calls `ensureConnected`).
 * - `connecting` — a socket is opening (bounded by `NET_CONNECT_TIMEOUT_MS`).
 * - `connected` — `welcome` arrived.
 * - `unreachable` — the last attempt failed / timed out; an anonymous background probe runs on `NET_PROBE_BACKOFF_MS`
 *   (every target — the desktop shell has no embedded relay since 2026-09-15).
 * - `refused` — the server said kicked / server_full / duplicate: no probing, no auto-reconnect until an explicit connect.
 * - `reconnecting` — was connected, socket dropped, the reconnect backoff is running.
 */
export type NetLinkState = 'idle' | 'connecting' | 'connected' | 'unreachable' | 'refused' | 'reconnecting';

export interface NetLinkInfo {
  state: NetLinkState;
  /** The relay address this state is about (`NetRef.relayUrl`). */
  url: string;
  /** `unreachable`: ms until the next background probe (null = not probing). */
  nextProbeInMs?: number | null;
  /** `refused`: why. */
  refused?: 'kicked' | 'server_full' | 'duplicate';
  /** `reconnecting`: 1-based attempt. */
  attempt?: number;
  /**
   * Retired 2026-09-15 — the target used to be the desktop shell's embedded relay (never probed). Builds ship no relay
   * any more, so nothing sets it; kept only because the contract is add-only.
   */
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
 * `{ target, source }` — which relay its same-origin `/ws` goes to. `ui/menus/SettingsMenu` shows it as the default line.
 * (Until 2026-09-15 `net/parts/Socket` also read it to spot the embedded relay; builds ship no relay now, so with no address
 * configured the target is this PC's `start-server.bat` relay.) A browser / vite has no such route (vite answers index.html — not JSON).
 */
export const NET_SHELL_RELAY_ROUTE = '/__scav/relay';

/* ══ appended: 2026-09-12 — the recovery contract: the 「found in this raid」 mark crosses the wire (`shared/raidFound.ts`) ══
 * `ItemInstanceExtras` is a `Pick<>` alias and cannot be widened, so it rides a field next to it. Omitted = no mark (an older peer · an item brought along). */
export interface PickupWire {
  /** `ItemInstance.raidFound` of an item dropped on the ground (the raid map seed). */
  rf?: number;
}
export interface CorpseItemWire {
  /** `ItemInstance.raidFound` of an item inside a player corpse. */
  rf?: number;
}

/* ══ appended: 2026-09-13 — cooking quality crosses the wire (`ItemInstance.quality`, `src/housing/README.md` Decisions) ══
 * It rides in the same place as `rf`. Omitted = quality 0 (an older peer · an item that is not a dish). The receiver clamps it with `normalizeMealQuality`. */
export interface PickupWire {
  /** `ItemInstance.quality` of a dish dropped on the ground. */
  q?: number;
}
export interface CorpseItemWire {
  /** `ItemInstance.quality` of a dish inside a player corpse. */
  q?: number;
}
export interface MealMessage {
  /** Quality of the dish served at the shared ship's dining table (both `req` and `serve`). */
  q?: number;
}
/* ══ end 2026-09-13 cooking quality ══ */

/* ══ appended: 2026-09-13 — the rover (owner: world/rover · rules in the rover section of `shared/types.ts`) ══
 * Host-authoritative — the route is seed-deterministic, so all that flows is the distance travelled · the state · hp · the riders (the same philosophy as `tram`).
 * A receiver accepts **only what the lobby host sent**. For a request (`roverq`) the host checks the shape · the sender (a lobby member · alive) · the distance.
 * The world/rover agent may add variants **only inside** this section (never change an existing field). */
/**
 * The wire state of one vehicle. `st` = `ROVER_STATES` index · `stn`/`tgt` = station index (−1 = none) · `tm` =
 * `RoverVehicleDef.timer` · `rd` = the riders' PeerIds (the host's own id is a PeerId too) · `rv` = the stations are revealed.
 */
export interface RoverWire {
  s: number; dir: 1 | -1; st: number; stn: number; tgt: number; tm: number; hp: number; rd: string[]; rv: 0 | 1;
  /**
   * appended (2026-09-21, 부위 파괴): part hp in the fixed order of `world/rover/model.ts` `ROVER_PART_ORDER` —
   * the 4 wheel zones, then the front and the rear turret. Whole hp (the wire never needs the fraction).
   * Omitted = every part intact, which is what an older build sends.
   */
  pt?: number[];
  /**
   * appended (2026-09-21, 적대화): 1 = the vehicle has turned hostile for the rest of the raid (the player side dealt
   * more than `ROVER_AGGRO_DAMAGE`). One flag, not a list of attackers: hostility covers the attacker **and their
   * squad**, and a raid's squad is the lobby, so everyone who can read this message is a target. Omitted = 0.
   */
  ho?: 0 | 1;
}
export type RoverMessage =
  /** Host → everyone: every `ROVER_NET_INTERVAL` plus on every change of state · riders · hp. This is also the answer to a late joiner's `roverq sync`. */
  | { t: 'rover'; ev: 'state'; rover: RoverWire }
  /** Host → everyone: the result of a request. `to` = the requester's PeerId, `rid` = that request's number — a receiver takes only its own. `exit` = the spot to step out at (a refused board · a settled exit). */
  | { t: 'rover'; ev: 'reply'; to: string; rid: number; req: 'board' | 'exit' | 'trip'; ok: boolean; reason?: string; exit?: Vec3Tuple }
  /** Host → everyone: a paid departure is settled. `by` = the payer's PeerId — **only that person** pays the credits. */
  | { t: 'rover'; ev: 'trip'; by: string; from: number; to: number; fare: number }
  /** Host → everyone: a forced exit (arrival · destruction). `exits` = rider PeerId → the spot to step out at. */
  | { t: 'rover'; ev: 'eject'; reason: 'arrived' | 'destroyed'; exits: Record<string, Vec3Tuple> }
  /** Host → everyone: one turret shot (FX · sound). `p` = the impact point. */
  | { t: 'rover'; ev: 'fire'; p: Vec3Tuple };
export type RoverRequest =
  | { t: 'roverq'; ev: 'board'; rid: number }
  | { t: 'roverq'; ev: 'exit'; rid: number }
  /** `to` = station index, `fare` = the fare the requester saw (the host recalculates it and refuses a mismatch). */
  | { t: 'roverq'; ev: 'trip'; rid: number; to: number; fare: number }
  | { t: 'roverq'; ev: 'sync' }
  /**
   * appended (2026-09-21, 부위 파괴): a non-host client's player-side damage landed on the car — `p` is a point
   * **on the body in world space** and `a` the damage. The host resolves which part was hit and whether it turns the
   * car hostile, so the guard tests the point against the hull rather than the sender's distance (a sniper may
   * legally be anywhere).
   *
   * Two things ride on that 「on the body」: an **explosion** (B-98) reports the point of the body nearest its centre,
   * not the centre, so one message shape covers bullets and blasts alike; and the sender sums a whole frame **per
   * hit zone** before sending (B-99), so `a` is a frame's worth of one zone rather than a single bullet.
   */
  | { t: 'roverq'; ev: 'hit'; p: Vec3Tuple; a: number };
/* ══ end 2026-09-13 the rover ══ */

/* ══ appended: 2026-09-13 — crypto quotes (`src/housing/README.md` Decisions · owner: server/CryptoMarket · net/parts/Crypto) ══
 * The relay simulates the coin quotes (`CRYPTO_TICK_S`) and stores the candle history — the chart and trading need a server connection (user's decision).
 * The source of the values is the `crypto` section of `server/economy.gen.json` (← data/crypto.csv · tuning.csv). Anonymous connections are accepted too (a quote is no secret).
 * A trade itself is not a new message but the `credits:tx` reasons `cbuy:` · `csell:` (`shared/credits.ts`). */
import type { CryptoCandle, CryptoChartRange } from './cryptoMarket';

export type ClientToServerAppended2026_09_13crypto =
  /** Quote subscription on / off. While on, `crypto:prices` on every tick (and once immediately when it goes on). The server forgets it when the connection drops — turn it back on after reconnecting. */
  | { t: 'crypto:watch'; on: boolean }
  /** Asks for one coin's candles for one range → `crypto:history`. An unknown coin or range is silently ignored. */
  | { t: 'crypto:history'; coin: string; range: CryptoChartRange };

export type ServerToClientAppended2026_09_13crypto =
  /** The current quote of every coin (credits per coin) + the 24-hour change (as a ratio). `at` = server epoch ms. */
  | { t: 'crypto:prices'; at: number; prices: Record<string, number>; change24h: Record<string, number> }
  /** The answer to `crypto:history`. Oldest candle → newest, at most `CRYPTO_CANDLE_COUNT[range]` of them. The last candle may still be running. */
  | { t: 'crypto:history'; coin: string; range: CryptoChartRange; at: number; candles: CryptoCandle[] };

/** `ctx.net.crypto` — the quote window the exchange screen and housing's estimates read (owner: net/). */
export interface CryptoMarketRef {
  /** Connected to a server and a quote arrived at least once (false = no chart and no trading — 「서버에 연결되어야 합니다」). */
  readonly available: boolean;
  /** The quote of the last `crypto:prices`. An empty object when none ever arrived. */
  readonly prices: Readonly<Record<string, number>>;
  readonly change24h: Readonly<Record<string, number>>;
  /** Server epoch ms of the last quote (0 = none arrived). */
  readonly pricesAt: number;
  /** Raises a quote subscription (reference-counted — `crypto:watch on` on the first, off on the last release). Release it with the returned function. It raises itself again after a reconnect. */
  watch(): () => void;
  /** Asks for the candle history — on arrival, `net:cryptoHistory {coin, range}`. */
  requestHistory(coin: string, range: CryptoChartRange): void;
  /** The last candle history received (null when there is none). */
  getHistory(coin: string, range: CryptoChartRange): readonly CryptoCandle[] | null;
}

export interface NetRef {
  /* ── appended (2026-09-13): crypto quotes ── */
  readonly crypto?: CryptoMarketRef;
}
/* ══ end 2026-09-13 crypto quotes ══ */

/* ══ appended: 2026-09-14 — group messenger rooms (`src/meta/README.md` Decisions · owner: server/ · net/) ══
 * Server-authoritative · persistent. A profile (a token) is required — anonymous gets `room:error {code:'unavailable'}`. The types and constants are the last section of `shared/social.ts`.
 * A receiver gets `room:state` whole (the room list and the invites are small). Lines fan out to the connected members with `room:line`.
 * Agent A (server · net) may add variants **only inside** this section (never change an existing field). */
import type { RoomErrorCode, RoomId, RoomLine, RoomSnapshot, RoomsRef } from './social';

export type ClientToServerAppended2026_09_14rooms =
  /** Ask for the room list · invites again → `room:state` (right after `welcome` the server sends it first). */
  | { t: 'room:get' }
  /** Create a room (me = the owner). `invite` = the `아이디` of friends to invite with it. Answer: `room:ack {nonce, room}` + `room:state`. */
  | { t: 'room:create'; name: string; invite?: PlayerCode[]; nonce: number }
  /** Owner only · friends only. */
  | { t: 'room:invite'; room: RoomId; code: PlayerCode }
  /** Answers an invite I received. */
  | { t: 'room:reply'; room: RoomId; accept: boolean }
  | { t: 'room:leave'; room: RoomId }
  /** Owner only. */
  | { t: 'room:kick'; room: RoomId; code: PlayerCode }
  /** Owner only. */
  | { t: 'room:rename'; room: RoomId; name: string }
  /** One line. Answer: `room:ack {nonce, ok, at}` (+ `room:line` to the members). */
  | { t: 'room:say'; room: RoomId; text: string; nonce: number }
  /** One page older than `before` (`ROOM_HISTORY_PAGE`); omitted = the newest page. */
  | { t: 'room:history'; room: RoomId; before?: number };

export type ServerToClientAppended2026_09_14rooms =
  | { t: 'room:state'; rooms: RoomSnapshot }
  | { t: 'room:line'; line: RoomLine }
  | { t: 'room:ack'; nonce: number; ok: boolean; room?: RoomId; at?: number; code?: RoomErrorCode }
  /** Oldest → newest. `more` = older lines are still there. */
  | { t: 'room:history'; room: RoomId; lines: RoomLine[]; more: boolean }
  | { t: 'room:error'; code: RoomErrorCode; message: string };

export interface NetRef {
  /* ── appended (2026-09-14): group messenger rooms ── */
  readonly rooms?: RoomsRef;
}
/* ══ end 2026-09-14 group messenger rooms ══ */

/* ══ appended (2026-09-14): the intel broker — the NetRef surface (`src/meta/README.md` Decisions) ════════
 *
 * The wire (`IntelWire` · `LobbyState.intel` · `lobby:intel` · `lobby:start.intel` · `game:start.intel`) is already
 * above, but **the `NetRef` method that sends it was missing** — `meta/parts/Intel.ts` (telling the squad after a
 * purchase) and `hub/parts/Pods.launch` (launching with the intel that was bought) had nowhere to call. This is
 * **add-only**, with no rename and no deletion (the existing `startGame(seed, mode?, planet?)` stays as an overload —
 * leaving the argument out is the old behaviour).
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════════ */
export interface NetRef {
  /** The fixed gimmicks the squad leader bought (`lobby.intel`). null with no lobby, or when nobody bought any. A squadmate **only reads** it. */
  readonly lobbyIntel: IntelWire | null;
  /**
   * Squad leader only, before the lobby starts: tells the squad about the intel that was bought (or discarded = null)
   * (`lobby:intel`). The same convention as `setLobbyPlanet` — it mirrors `lobby.intel` optimistically and the
   * server's `lobby:state` settles it. It does nothing when not the host or once the lobby already started.
   */
  setLobbyIntel(intel: IntelWire | null): void;
  /**
   * `intel` appended (2026-09-14): the fixed gimmicks to carry into this raid. When present, `seed` must be **that
   * intel's seed** (「산 지역으로 간다」). Left out, `lobby.intel` is carried instead; a training always ignores it.
   */
  startGame(seed: number, mode?: MissionMode, planet?: PlanetId, intel?: IntelWire | null): void;
}
/* ══ end 2026-09-14 the intel broker ══ */

/* ══ appended (2026-09-15, B-14): a squadmate's landing after a fall ═════════════════════
 * Sent to `others` by **the person who actually took the damage** (`player/parts/Fall.onLanded`, the very place that emits `player:fell`).
 * `p` = the feet position on landing, `d` = how much was actually taken off (shield + hp). The receiver (player)
 * accepts it **only from a lobby member**, clamps `d` to `[0, FALL_DAMAGE_MAX]`, drops it when it is outside
 * `FALL_REMOTE_SOUND_RANGE` of the local camera and then emits `player:remoteFell`.
 * It exists for the sound alone — hp and the shield already ride the snapshots. The tutorial and the training range are solo, so they never send it. */
export interface FallMessage { t: 'fall'; p: Vec3Tuple; d: number }

/* ══ appended (2026-09-15, B-16): the grenade kind ══════════════════════════════════════════════
 * A remote grenade's explosion **damages the receiver's local player** (`RemoteWeapons.onGrenade`) — so guessing the
 * small explosion of the G-10 incendiary grenade from the held-item snapshot means that, the moment one snapshot is
 * missed, it lands as high explosive (250 / 6 m) instead. The thrower carries the kind itself. */
export interface GrenadeMessage {
  /** 1 = the G-10 incendiary grenade (`ItemDef.grenadeFire`) — replayed as the small explosion. Omitted = unknown (an older client → the receiver guesses from the held-item snapshot). */
  fire?: 1;
}

/* ══ appended (2026-09-15): squad · dock matchmaking — `src/hub/README.md` Decisions ════════
 *
 * The squad (lobby) and the shared ship are **separate** now. Before, a lobby *was* the shared ship: getting one (create ·
 * join · quick match · 같이 하기 · invite accept) played the docking cutscene at once. Now:
 * - **Sending an invite** creates a lobby led by the sender with `docked: false`. Everyone stays in **their own personal
 *   ship**. The invitee joins only by accepting (P hold). The relay dissolves an undocked lobby left with one member and
 *   no open invite into it.
 * - The leader docks from 터미널 > 매칭 (`비공개 매칭` / `공개 매칭` → `lobby:dock`): `docked` becomes true. The player who
 *   pressed it fades out → docking cutscene at once; every other member sees a `HUB_SQUAD_DOCK_COUNTDOWN_S` countdown,
 *   then their screens close and the same fade → cutscene runs. Nobody moves until the leader docked. A member cannot
 *   send `lobby:dock` (`not_host`). A member who joins an **already docked** lobby also counts down, then docks.
 * - 공개 매칭: a player **on their own** (no lobby, or alone in an undocked lobby) joins an open public shared ship as a
 *   member, or creates one when none is open. A **squad of 2+** docks its own lobby as public and never merges with another
 *   squad — only players on their own fill its free slots.
 * - In an undocked squad the personal launch pod and the training range are locked (`not_docked`). Once docked,
 *   `lobby:leave` (도킹 해제) takes out **only me** (as before).
 * - The old paths (`lobby:create` · `lobby:join` · `lobby:quickmatch`) still create / join **docked** lobbies — smokes and
 *   older clients rely on them. The UI no longer offers codes, links or the public/private toggle.
 * Server rules: server/Lobby.ts (`docked`), server/RelayServer.ts (`lobby:dock`, `social:play`, lonely-party prune).
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════════ */

/** URL query param carrying my personal accent colour (`#rrggbb`) on connect, next to `NET_NAME_PARAM`. */
export const NET_ACCENT_PARAM = 'a';

export interface LobbyPlayer {
  /**
   * This member's personal accent colour (`#rrggbb`, their character's `PlayerProfile.accent`), from `?a=` on connect or
   * `lobby:look`. Absent = unknown (anonymous / older client) → portraits fall back to `NET_SLOT_COLORS_CSS[slot]`.
   * Only the 매칭 탭 portraits read it; in-raid avatars keep the slot colour.
   */
  accent?: string;
  /**
   * appended (2026-09-21, 함선 구매 훅): this member's ship model id (`shared/shipModel.ts` `ShipModelId`, kept as a
   * plain string here because `net.ts` must stay free of three.js — the relay imports this file). The shared ship's
   * **hangar** parks each member's own ship with it. Absent (anonymous · older client · nothing bought) = the
   * default drop-ship, and an id the reader does not know resolves to the default too (`resolveShipModelId`).
   * **Filled by the relay from that member's own `progression` document** (B-101, 2026-09-21), the way `code` ·
   * `level` already are — it used to be echoed from whatever the client put in `lobby:look`, and a purchase is not
   * the client's word to give. A relay that has no document for a member sends nothing and the reader defaults.
   */
  shipModel?: string;
}

export interface LobbyState {
  /**
   * false = the squad is formed but every member is still in their own personal ship (an invite created it).
   * true = the squad lives in the shared ship. **Absent = true** (older server) — always read it through `isDockedLobby`.
   */
  docked?: boolean;
}

export type ClientToServerAppended2026_09_15dock =
  /**
   * 터미널 > 매칭: take the squad to the shared ship. No lobby → the relay makes one (private = a new docked lobby;
   * public = join an open public ship, or create one). With a lobby: leader only (`not_host`), before a start
   * (`started`), not already docked (`in_lobby`). Public + alone in an undocked lobby → moved into an open public ship
   * when there is one (`lobby:left {reason:'moved'}` then its `lobby:state`), else the own lobby docks as public.
   * A squad of 2+ → its own lobby becomes `docked: true` with `isPublic` and is broadcast.
   */
  | { t: 'lobby:dock'; isPublic: boolean }
  /** Update my `LobbyPlayer.accent` (the relay keeps it for later lobbies too; invalid per `sanitizeAccent` → ignored). */
  /**
   * 2026-09-21: `shipModel` rides the same message, and both fields are optional — a sender pushes whichever of the
   * two actually changed.
   *
   * The two are **not** read the same way (B-101, the same day). `accent` is taste and the relay takes it as sent;
   * `shipModel` is property, so the relay reads only its shape and then throws the value away — the one the squad
   * receives in `LobbyPlayer.shipModel` is read out of the sender's own `progression` document in the profile store.
   * Sending it is therefore a **nudge** meaning 「my ship changed, re-read it」, kept because that re-read has to be
   * triggered by something. A client that stops sending it loses nothing but the promptness.
   */
  | { t: 'lobby:look'; accent?: string; shipModel?: string };

/** Is this lobby's squad in the shared ship? null / undefined → false; `docked` absent (older server) → true. */
export function isDockedLobby(lobby: LobbyState | null | undefined): boolean {
  return !!lobby && lobby.docked !== false;
}

/**
 * appended (2026-09-21): a ship model id on the wire, or null. The one parser, relay and client alike — and it
 * deliberately checks only the **shape** (`a–z 0–9 _`, at most 24), never the registry: `shared/shipModel.ts` pulls
 * three.js in and the relay must never load it. An id that passes here but names no model resolves to the default
 * drop-ship on the client (`resolveShipModelId`), so an unknown value can only ever under-deliver.
 */
export function sanitizeShipModel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  return /^[a-z0-9_]{1,24}$/.test(s) ? s : null;
}

/** `#rrggbb` (lower-cased) or null. The one parser for an accent on the wire — relay and client alike. */
export function sanitizeAccent(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(s) ? s : null;
}

export interface NetRef {
  /**
   * 터미널 > 매칭: `비공개 매칭` (false) / `공개 매칭` (true) → `lobby:dock`. Not connected → `net:error`. The result is
   * the usual `net:lobbyUpdated` (a docked lobby) or `net:error`.
   */
  requestDock(isPublic: boolean): void;
  /**
   * true from `requestDock` until a docked lobby state arrives, a `lobby:error` comes back or the lobby is left. hub/
   * reads it to tell **my own** dock (fade → cutscene at once) from the leader's dock reaching me (countdown first).
   */
  readonly dockPending: boolean;
}
/* ══ end 2026-09-15 squad · dock matchmaking ══ */

/* ══ appended (2026-09-15): android squadmates · raid entry loading — `src/allies/README.md` Decisions ══
 *
 * **Bot members** (owner: server/ · net/). A squadmate that came out of an android bay of the shared ship's cockpit
 * (bay 0..ANDROID_BAY_COUNT-1) is a member of the relay lobby — with no socket and `bot: true`, always
 * `connected: true` · `ready: true`, and `inMission: true` once the raid starts. id = `androidIdOf(lobby.code, bay)`.
 * - `lobby:android {bay, recruit}` — squad leader only (`not_host`), a **docked** lobby only (`not_docked`), before a
 *   start only (`started`); a bay out of range, or one already in that state, is `invalid`. With no free slot,
 *   `lobby:error full` plus `lobby:androidReturned {bay, reason:'full'}` to the requester.
 * - **A human wins.** When a human joins (an invite accepted · joined by code · moved) a lobby full of humans + bots,
 *   the bot with the latest `recruitedAt` is taken out and the human put in its place → `lobby:androidReturned
 *   {bay, reason:'human_joined'}` + `lobby:state` to the whole lobby.
 *   The quick-match candidate check **counts** bots — a lobby filled with bots is not matched (「더 이상 다른 플레이어가 매칭되지 않음」).
 *   `canAdd` (a human joining) · the invitable check (`my_squad_full`) · the invite sweep (`sweepInvites` full) count humans only.
 * - A bot **never** becomes the host (`migrateHost` · `transferHostTo` · host succession), is never a relay target, and
 *   is left out of presence · recently played with · the block check · dissolving a lonely squad (`pruneLonely` — it
 *   counts humans) · the 「people still inside」 of the reconnect grace · the empty-mission reset (`autoResetMission`).
 *   It stays `ready: true` even after `reset()`. Once every human has left it disappears with the lobby.
 *
 * **The android wire** (`ally` · `allyq`, owner: allies/). Host-authoritative — a receiver accepts only an `ally` the
 * lobby host sent. `allyq` is squadmate → `host`. The serverless cheat roster uses no wire.
 *
 * **Raid entry loading** (`load`, owner: game/). When the launch countdown ends everyone fades to black, reports the
 * progress of world generation and shader compilation to `others` (`p`), and the host sends `go` once everyone (human,
 * connected, in the mission) is done or at `RAID_LOAD_TIMEOUT_S`. A latecomer releases on its own when its own loading ends.
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════════ */
import type { ItemInstance as AllyItemInstance, ItemRequestKind } from './types';

/** Android bays in the shared ship's cockpit — a structural constant the ship model and the relay's checks share (the relay cannot read csv). */
export const ANDROID_BAY_COUNT = 3;
/** Prefix of an android id. A profile PeerId (12 base64url characters) holds no `:`, so they can never collide. */
export const ANDROID_ID_PREFIX = 'android:';

/** `scope` = the lobby code (`'local'` for the serverless cheat roster). */
export function androidIdOf(scope: string, bay: number): PeerId {
  return `${ANDROID_ID_PREFIX}${scope}:${bay}`;
}
export function isAndroidId(id: unknown): boolean {
  return typeof id === 'string' && id.startsWith(ANDROID_ID_PREFIX);
}

export interface LobbyPlayer {
  /** true = an android bot member (no socket). Omitted = a person. */
  bot?: boolean;
  /** The cockpit bay the bot came out of, 0..ANDROID_BAY_COUNT-1. */
  bay?: number;
  /** Server epoch ms the bot joined at — when a human joins a full lobby, the latest bot goes back to its bay first. */
  recruitedAt?: number;
}

export function isBotPlayer(p: LobbyPlayer | null | undefined): boolean {
  return !!p && p.bot === true;
}
/** Human members only (regardless of connection). */
export function humanPlayersOf(lobby: LobbyState | null | undefined): LobbyPlayer[] {
  return lobby ? lobby.players.filter((p) => p.bot !== true) : [];
}
/** Bot members only, in bay order. */
export function androidPlayersOf(lobby: LobbyState | null | undefined): LobbyPlayer[] {
  return lobby ? lobby.players.filter((p) => p.bot === true).sort((a, b) => (a.bay ?? 0) - (b.bay ?? 0)) : [];
}
export function androidOnBay(lobby: LobbyState | null | undefined, bay: number): LobbyPlayer | null {
  return lobby?.players.find((p) => p.bot === true && p.bay === bay) ?? null;
}

export type ClientToServerAppended2026_09_15android =
  /** Squad leader: takes the android of cockpit bay `bay` into the squad (`recruit`) / sends it back to its bay. The result is `lobby:state`. */
  | { t: 'lobby:android'; bay: number; recruit: boolean };

export type ServerToClientAppended2026_09_15android =
  /** One android could not join the squad / left it and went back to its bay (`full` = to the requester only, `human_joined` = to the whole lobby). */
  | { t: 'lobby:androidReturned'; bay: number; reason: 'human_joined' | 'full' };

export interface NetRef {
  /** Squad leader only → `lobby:android`. It does nothing with no connection or no lobby. The result is `net:lobbyUpdated` or `net:error`. */
  setAndroidBay?(bay: number, recruit: boolean): void;
}

/** The snapshot of one android (host → everyone, `ALLY_NET_INTERVAL_S`). Coordinates are trimmed to 2 decimal places. */
export interface AllyWire {
  id: PeerId;
  /** `ALLY_MODES` index. */
  md: number;
  /** `ALLY_STATES` index. */
  st: number;
  /** `ALLY_POSES` index. */
  po: number;
  p: Vec3Tuple;
  v: Vec3Tuple;
  y: number;
  pt: number;
  hp: number;
  mhp: number;
  sh: number;
  msh: number;
  /** The downed bleed pool (0 = standing). */
  dhp: number;
  /** `ALLY_FLAGS` bits. */
  f: number;
  /** Def ids of the primary weapon · armor · bag. */
  w: string | null;
  a: string | null;
  b: string | null;
  /** PeerId of the person being carried. */
  c: PeerId | null;
  /** Look / aim point. */
  lk?: Vec3Tuple;
}

export type AllyMessage =
  /** Host → everyone: the snapshots of every android — **in a raid only** (`allies/parts/Sync.update` returns at once unless `raidActive`; the ship has no wire, every client computes the bay / pod poses from the lobby). A late joiner's `allyq sync` is answered with this + `bag`. */
  | { t: 'ally'; ev: 'state'; allies: AllyWire[] }
  /** Host → everyone: one android's equipment / bag changed (host succession · corpses · debugging). `kit` = uids of the base kit gear (the bound items). */
  | { t: 'ally'; ev: 'bag'; id: PeerId; equip: { primary: AllyItemInstance | null; armor: AllyItemInstance | null; bag: AllyItemInstance | null }; items: AllyItemInstance[]; kit: string[] }
  /** Host → everyone: one shot (FX · sound — the damage was already applied by the host). */
  | { t: 'ally'; ev: 'fire'; id: PeerId; from: Vec3Tuple; to: Vec3Tuple; w: string | null }
  /** Host → everyone: an android placed a ping. The receiving ui draws it under the android's name. */
  | { t: 'ally'; ev: 'ping'; id: PeerId; kind: PingKind; p: Vec3Tuple; label?: string; enemyId?: number }
  /** Host → everyone: one chat line from an android. A receiver never relays it again. */
  | { t: 'ally'; ev: 'chat'; id: PeerId; text: string }
  /** Host → `target`: an android got you up (`defib` = the defibrillator — the same healing as a person's). */
  | { t: 'ally'; ev: 'revive'; id: PeerId; target: PeerId; defib?: 1 }
  /** Host → everyone: the drop pod's falling FX (player `RemotePods`). */
  | { t: 'ally'; ev: 'drop'; id: PeerId; p: Vec3Tuple; yaw: number }
  /** Host → `to` (the squad leader): what an extracted android picked up in the raid — the receiver puts it into its own stash. */
  | { t: 'ally'; ev: 'deposit'; id: PeerId; to: PeerId; items: AllyItemInstance[] };

export type AllyRequest =
  /** A late join · a reconnect → host: `ally state` + one `ally bag` per android. */
  | { t: 'allyq'; ev: 'sync' }
  /** Squadmate → host: I got a downed android up (the revive hold completed · the defibrillator). The host re-checks the distance and the state. */
  | { t: 'allyq'; ev: 'revive'; id: PeerId; defib?: 1 }
  /** Squadmate → host: an inventory request (middle-click · the menu). `p` = the requester's position. */
  | { t: 'allyq'; ev: 'item'; kind: ItemRequestKind; defId?: string; ammoType?: string; p: Vec3Tuple }
  /** Squadmate → host: I opened this container — an android that was looting that crate stops. */
  | { t: 'allyq'; ev: 'viewing'; containerId: string }
  /**
   * appended (2026-09-21, 회복 아이템을 아군에게): squadmate → host: I used a 회복 소모품 on this android.
   * The host re-checks the distance and the state exactly as it does for `revive`, then applies it.
   */
  | { t: 'allyq'; ev: 'heal'; id: PeerId; hp: number }
  /** appended (2026-09-21): the same for a 실드 충전기 — `amount` -1 = fill it up (`BuffMessage.amount`). */
  | { t: 'allyq'; ev: 'shield'; id: PeerId; amount: number };

export type LoadMessage =
  /** Each client → others: loading progress 0..1 for this seed (every `RAID_LOAD_REPORT_S`, 1 = done). */
  | { t: 'load'; ev: 'p'; seed: number; v: number }
  /** Host → everyone: release (everyone done · timed out). `to` 1 = timed out. */
  | { t: 'load'; ev: 'go'; seed: number; to?: 1 };
/* ══ end 2026-09-15 android squadmates · raid entry loading ══ */

/* ══ appended (2026-09-15, the sandworm · the thumper — owner: gadgets) ════════════════════════════ */
export interface DeployableWire {
  /**
   * The thumper (`kind: thumper`) only: seconds since it was placed. A replica uses it to line its strike phase (a 1 s
   * period) up with the host's — so the hammer falls on the same beat in a late joiner's `gad sync` too. Omitted (= 0)
   * for every other kind. No message is sent per strike.
   */
  age?: number;
}

/* ══ appended (2026-09-15): abandoning a raid from the title · drifting — `src/game/README.md` Decisions ══
 *
 * A squadmate who reloaded picks `이어하기` or `레이드 포기` at the title (`shared/raidResume`).
 * - The `lobby:mission {inMission:false, keep:true}` a reloaded page answers `welcome` with **keeps the raid blob** —
 *   so resuming or abandoning still works off that blob after two reloads. A voluntary return · leaving the training
 *   range · extracting still send it without `keep`, and the blob is dropped.
 * - `lobby:abandon` — members of a lobby whose raid (`mode` raid) is running only (`not_in_lobby` · `not_started`). The
 *   relay marks that member `drifted`, sets `inMission:false`, deletes the blob, transfers the host role when it was
 *   the host, resets when nobody is left, and then broadcasts `lobby:state`. An already-drifted member just gets the state back.
 * - A drifted member's `lobby:mission {inMission:true}` is refused with `drifted`. `start()` · `reset()` clear the mark (the next round is a new round).
 * - The corpse: the client that abandoned sends `pcorpse spawn` to `others` from the blob's belongings and
 *   `RaidSessionBlob.pose` (exactly the `pcorpse` convention that the person who died sends it). Rescue-drop
 *   candidates (`stratagems/parts/Rescue`) leave a drifted member out.
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════════ */

export interface LobbyPlayer {
  /** true = this member abandoned the running raid from the title: dead there, no rescue drop, no rejoin. Absent = false. Cleared by the next start / reset. */
  drifted?: boolean;
}

export type ClientToServerAppended2026_09_15drift =
  /** Abandon the running raid I dropped out of (title → `레이드 포기`). The result is the usual `lobby:state`. */
  | { t: 'lobby:abandon' };

export interface NetRef {
  /** → `lobby:abandon`, marking me `drifted` locally at once. No-op without a connected lobby whose raid runs, or inside the session. */
  abandonRaid?(): void;
}
/* ══ end 2026-09-15 abandoning a raid from the title · drifting ══ */

/* ══ appended 2026-09-21: player ↔ player trust (owner: net — `shared/playerTrust.ts`) ══ */
export interface NetRef {
  /** Pair trust with other players, pushed by the relay. Null / absent before the net system is up or offline. */
  readonly trust?: import('./playerTrust').TrustRef | null;
}
