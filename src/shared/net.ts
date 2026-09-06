import type * as THREE from 'three';
import type { ChatKind, EnemyType, GamePhase, PingKind, Stance, ItemInstanceExtras, StratagemId } from './types';
import type { DeployableKind, GadgetId } from './gadgets';
import type { ImplantId } from './implants';

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
}

export type LobbyErrorCode =
  | 'not_found' | 'full' | 'started' | 'not_host' | 'not_ready' | 'invalid'
  | 'in_lobby' | 'not_in_lobby' | 'server'
  /* appended */
  | 'not_started'   // lobby:launch (rejoin) while no mission is running
  | 'duplicate';    // same session token connected from another tab → the older socket is closed with this code

/* ── Wire protocol: client ↔ server (JSON) ─────────────────────────────────── */
export type RelayTarget = PeerId | 'host' | 'all' | 'others';

export type ClientToServer =
  | { t: 'lobby:create'; name: string }
  | { t: 'lobby:join'; code: string; name: string }
  | { t: 'lobby:leave' }
  | { t: 'lobby:ready'; ready: boolean }
  /** Host only. Requires every player to be ready. */
  | { t: 'lobby:start'; seed: number }
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
  | { t: 'lobby:name'; name: string };

export type ServerToClient =
  /**
   * First frame after connect. `lobby` (appended) is set when the session token is still a member of a lobby
   * (reconnect within NET_RECONNECT_GRACE_MS or a fresh page load) — the client resumes into it; `started`
   * on that lobby means a mission is in progress and the player may rejoin from a launch slot.
   */
  | { t: 'welcome'; id: PeerId; serverTime: number; lobby?: LobbyState | null; resumed?: boolean }
  | { t: 'lobby:state'; lobby: LobbyState }
  | { t: 'lobby:error'; code: LobbyErrorCode; message: string }
  | { t: 'lobby:left' }
  | { t: 'game:start'; seed: number; lobby: LobbyState }
  | { t: 'relay'; from: PeerId; d: GameMessage }
  /** A peer disconnected/left mid-lobby or mid-game. `lobby` is the updated state (host may have migrated). */
  | { t: 'peer:left'; id: PeerId; lobby: LobbyState }
  | { t: 'pong'; ts: number; serverTime: number };

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
  | { t: 'strat'; ev: 'call'; callId: string; kind: StratagemId; p: Vec3Tuple; eta: number; seed: number }
  | { t: 'strat'; ev: 'structHp'; callId: string; index: number; hp: number };
/** Client → host: my local raycast hit enemy `id` for `dmg` (pre-multiplier) at point `p` travelling `d`. Owner: enemies (replica Enemy.takeDamage). */
/**
 * Appended (2026-09-06): `st` = status the host should apply with the hit — bits of `ENEMY_STATUS_BITS`
 * (incinerated / shocked / burning), `dur` = seconds. `dmg` may be 0 for a status-only request.
 */
export interface HitRequest { t: 'hit'; id: number; dmg: number; p: Vec3Tuple; d: Vec3Tuple; st?: number; dur?: number }

/** Enemy status bits on the wire (`EnemyWire.sb`, `HitRequest.st`). */
export const ENEMY_STATUS_BITS = { BURNING: 1 << 0, SLOWED: 1 << 1, INCINERATED: 1 << 2, SHOCKED: 1 << 3 } as const;
/** Client → host: explosion at `p` radius `r` damage `dmg` (grenade). Owner: enemies (replica applyExplosion). */
export interface ExplodeRequest { t: 'explode'; p: Vec3Tuple; r: number; dmg: number }
/** Host → shooter: confirmation of a HitRequest (hitmarker / kill credit). */
export interface HitConfirm { t: 'hitc'; id: number; dmg: number; killed: boolean; part: 'head' | 'body' | 'rear' | 'front' }
/** Host → one client: you took damage. Owner: enemies (host AI) → net applies `ctx.player.takeDamage`. */
export interface DamageMessage { t: 'dmg'; amount: number; from?: Vec3Tuple; slow?: { duration: number; factor: number } }
/** Any → all: I died. */
export interface DiedMessage { t: 'died'; p: Vec3Tuple }

/** Enemy AI state as seen on the wire (subset of enemies/Enemy.ts EnemyState). */
export type EnemyWireState = 'idle' | 'wander' | 'alert' | 'chase' | 'attack' | 'stagger' | 'dead' | 'flee';

export interface EnemyWire {
  id: number;
  ty: EnemyType;
  p: Vec3Tuple;
  yaw: number;
  hp: number;
  st: EnemyWireState;
  /**
   * Optional animation hints: 0 none, 1 charger windup, 2 charger rush, 3 spewer windup, 4 hunter airborne;
   * Phase 4: 5 rogue shooting, 6 rogue in cover, 7 rogue rushing, 8 artillery aiming, 9 toxic swelling, 10 behemoth windup, 11 behemoth rush.
   */
  a?: number;
  /** Phase 4: rogue's weapon def id (model + corpse loot). */
  w?: string;
  /** Appended (2026-09-06): status bits (`ENEMY_STATUS_BITS`) so replicas show burning / 전소 / shocked visuals. */
  sb?: number;
}

/** Host → all, NET_ENEMY_SNAPSHOT_HZ. `full` = complete list (ids missing from it were despawned). Owner: enemies. */
export interface EnemySnapshot { t: 'es'; time: number; full: boolean; e: EnemyWire[] }

/** Host → all: discrete enemy events (spawn/kill/attack) for FX, audio and stats. Owner: enemies. */
export type EnemyEvent =
  | { t: 'ee'; ev: 'spawn'; id: number; ty: EnemyType; p: Vec3Tuple; yaw: number }
  | { t: 'ee'; ev: 'kill'; id: number; ty: EnemyType; p: Vec3Tuple; killer: PeerId | null }
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
  | { t: 'ee'; ev: 'corpse'; id: number; ty: EnemyType; p: Vec3Tuple; w?: string }
  | { t: 'ee'; ev: 'corpseGone'; id: number };
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
  | { t: 'flow'; ev: 'rejoined' };

/** Any → all: a tactical ping. Owner: ui/hud/Pings. `label` (appended) = item name for 'item' pings. */
export interface PingMessage { t: 'ping'; p: Vec3Tuple; kind: PingKind; label?: string; enemyId?: number }

/** Any → all: crate opened (so other clients mark it looted). Owner: world/inventory. */
export interface CrateMessage { t: 'crate'; id: string; ev: 'opened' | 'looted' }

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
export interface MetaMessage { t: 'meta'; ev: 'contractHit'; corp: import('./meta').CorpId; goal: import('./meta').ContractGoalKind; amount: number }

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
  | MetaMessage;
  /* append new message types above this line (keep `t` unique; prefix by owning folder if in doubt) */

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
}

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
  | { t: 'imp'; ev: 'rocketHit'; p: Vec3Tuple };

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
  | { t: 'gadq'; ev: 'place'; gadget: GadgetId; p: Vec3Tuple; yaw: number; v?: Vec3Tuple }
  | { t: 'gadq'; ev: 'damage'; id: string; dmg: number }
  | { t: 'gadq'; ev: 'recover'; id: string }
  | { t: 'gadq'; ev: 'sync' };

/** Wire form of a gather node. */
export interface GatherWire { id: string; defId: string; p: Vec3Tuple; harvested: boolean }

/** Host ↔ client: harvestable plants (host-authoritative, same shape as pickups). Owner: world. */
export type HarvestMessage =
  | { t: 'harv'; ev: 'taken'; id: string; by: PeerId }
  | { t: 'harv'; ev: 'sync'; nodes: GatherWire[] };
export type HarvestRequest =
  | { t: 'harvq'; ev: 'take'; id: string }
  | { t: 'harvq'; ev: 'sync' };
