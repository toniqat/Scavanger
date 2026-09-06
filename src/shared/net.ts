import type * as THREE from 'three';
import type { ChatKind, EnemyType, GamePhase, PingKind, Stance, ItemInstanceExtras, StratagemId } from './types';
import type { DeployableKind, GadgetId } from './gadgets';
import type { ImplantId } from './implants';
/* appended (Phase 7, 2026-09-06): server profile / raid session */
import type { ProfileDocKey, ProfileRecord, ProfileRef, RaidSessionBlob } from './profile';
import type { MissionMode } from './types';

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
 */
export const NET_GHOST_PARK_S = 120;
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
}

export type LobbyErrorCode =
  | 'not_found' | 'full' | 'started' | 'not_host' | 'not_ready' | 'invalid'
  | 'in_lobby' | 'not_in_lobby' | 'server'
  /* appended */
  | 'not_started'   // lobby:launch (rejoin) while no mission is running
  | 'duplicate'     // same session token connected from another tab → the older socket is closed with this code
  /* appended (Phase 7) */
  | 'too_large'     // profile:set / raid:save document over the byte cap
  | 'in_mission';   // lobby:mission {inMission:true} while another mission kind is running

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
  | { t: 'lobby:start'; seed: number; mode?: MissionMode }
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
  | { t: 'profile:set'; key: ProfileDocKey; doc: unknown; at?: number; fresh?: boolean }
  /** Credits transaction; server answers `credits:result {txId}`. */
  | { t: 'credits:tx'; txId: number; delta: number; reason: string }
  /** Save my mid-raid state for a reconnect (only accepted while my lobby is started with `blob.seed`). */
  | { t: 'raid:save'; blob: RaidSessionBlob };

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
    }
  | { t: 'lobby:state'; lobby: LobbyState }
  | { t: 'lobby:error'; code: LobbyErrorCode; message: string }
  | { t: 'lobby:left' }
  /** `mode` (appended, Phase 7): a training start reaches everyone but only members with `inMission` enter it. */
  | { t: 'game:start'; seed: number; lobby: LobbyState; mode?: MissionMode }
  /* appended (Phase 7) */
  | { t: 'profile:docs'; profile: ProfileRecord }
  | { t: 'credits:result'; txId: number; ok: boolean; credits: number; reason?: string }
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
  | { t: 'strat'; ev: 'call'; callId: string; kind: StratagemId; p: Vec3Tuple; eta: number; seed: number }
  | { t: 'strat'; ev: 'structHp'; callId: string; index: number; hp: number }
  /* appended (Phase 9): late-join sync — the host answers `stratq sync` / `flow rejoined` with every live call it knows. */
  | { t: 'strat'; ev: 'sync'; calls: StratagemCallWire[] };
/**
 * One live ship call for a late joiner. `eta` = seconds until it lands (≤ 0 = already landed: the receiver back-dates
 * `landsAt` and lets its own update fast-forward the landing, registering structures / the supply crate at once);
 * `st` = `[index, hp]` for every structure whose hp is below `STRUCTURE_HP` (0 = destroyed), the rest are rebuilt from `seed`.
 */
export interface StratagemCallWire { callId: string; kind: StratagemId; p: Vec3Tuple; seed: number; eta: number; caller: PeerId | null; looted?: boolean; st?: [number, number][] }
/** Client → host (Phase 9): send me every live ship call (`world:ready` on a non-host). */
export type StratagemRequest = { t: 'stratq'; ev: 'sync' };
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
  | { t: 'ee'; ev: 'corpseGone'; id: number }
  /* appended (Phase 7): rogue AI v2 */
  /** A rogue threw a grenade (replicas fly a visual one; the host resolves damage: own player directly, remotes via `dmg`). */
  | { t: 'ee'; ev: 'grenade'; id: number; p: Vec3Tuple; v: Vec3Tuple; fuse: number }
  /** The rogue grenade exploded (FX on replicas). */
  | { t: 'ee'; ev: 'grenadeHit'; p: Vec3Tuple };
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
export type MetaMessage =
  | { t: 'meta'; ev: 'contractHit'; corp: import('./meta').CorpId; goal: import('./meta').ContractGoalKind; amount: number }
  /* appended (Phase 9): late-join catch-up — every peer answers `metaq sync` ONCE per requester per mission with the hits it broadcast so far this mission. */
  | { t: 'meta'; ev: 'sync'; corp: import('./meta').CorpId; hits: [import('./meta').ContractGoalKind, number][] }
  /* appended (Phase 9 UI pass): this member's own active contract + progress, so every squad HUD can draw it
   * (`ui/hud/ContractPanel`). `id` null = no contract / abandoned / settled. Broadcast on `world:ready`, on every
   * local progress change (≤ 1 Hz) and on accept / abandon, and repeated to whoever asks with `metaq sync`. */
  | { t: 'meta'; ev: 'contract'; id: string | null; progress: number };
/** Client → others (Phase 9): peer-to-peer (the host holds no tallies) — sent on `world:ready` of a rejoin. */
export type MetaRequest = { t: 'metaq'; ev: 'sync' };

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
  | MetaRequest;
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
export interface GhostWire { id: PeerId; p: Vec3Tuple; yaw: number; hp: number; dhp: number; st: GhostState }
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
  | { t: 'cont'; ev: 'taken'; id: string; idx: number; qty: number; by: PeerId }
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
  | { t: 'imp'; ev: 'beam'; target: PeerId | null; self: boolean };

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
