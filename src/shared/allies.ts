/**
 * src/shared/allies.ts — **android squadmates** (`ctx.allies`). 2026-09-15 user's decision —
 * docs/DECISIONS.md 「2026-09-15 — 안드로이드 분대원 · 레이드 진입 로딩」.
 *
 * The question this file answers: *who runs a squadmate that is not a person, and what do other folders read.*
 *
 * ## Who owns what
 * - **Squadmate membership** = a bot member of the relay lobby (`LobbyPlayer.bot`, the last section of `net.ts`). One comes
 *   out of one of the `ANDROID_BAY_COUNT` android bays in the shared ship's cockpit — the squad leader holds for
 *   `ALLY_BAY_HOLD_S` → `lobby:android`. Holding the same bay again = leaving.
 *   When a person joins and the squad overflows, the **latest recruited android** goes back to its bay (the relay judges it,
 *   `lobby:androidReturned`). The dev cheat `/android 1|0` puts one in and takes it out of the **local roster** with no
 *   server (it shows in the personal ship too and comes along on a solo raid).
 * - **Simulation** = the `allies/` of the authority (solo · lobby host). A replica interpolates the `ally state` snapshot to
 *   fill the same `AllyBodyView`. When the host changes, the new host picks up from the last snapshot and `ally bag`.
 * - **The body** = player/ reads `getBodies()` every frame and draws it with `SoldierModel` (the android look) — the dormant
 *   bay body, the drop pod, being downed, being carried, the muzzle flash and the revive interaction (`revive:ally:<id>`)
 *   included. allies/ builds no meshes.
 * - **Enemies** = enemies/ folds `getCombatBodies()` into its target list as a side branch and calls `damage()` on a hit
 *   (on the authority only).
 * - **Orders** = there is no new input. It listens to pings (`ping:placedV3`), the communication wheel (`comms:sent`) and
 *   inventory requests (`inventory:itemRequested`, `allyq item` when remote).
 *
 * ## Rules (user's decision)
 * - hp = a person's × `ALLY_HP_MUL`. Like a person it **goes down** and the PC can get it up (it is not a rescue-drop
 *   candidate). An android gets a downed PC up too. 2026-09-16 user's decision: the raid fails only when **every human and
 *   every android** is down or dead (a standing android comes to revive). In every other head count (presence · prune · the grace) an android is still not a person.
 * - The harness anchor = the **squad leader**. A request (heal · shield · ammo · item · crate · extraction · contract) takes
 *   the **first one that arrived** and ignores the others for `ALLY_REQUEST_COOLDOWN_S`. Movement (`attack`, go over there)
 *   and caution (`caution`) pings are obeyed only from the squad leader.
 * - When the state changes, acting on it waits a random `ALLY_REACT_MIN_S` … `ALLY_REACT_MAX_S` — the heavier the action (`ALLY_STATE_WEIGHT`) the longer.
 * - **Infinite ammo** (magazines and reloading do exist). It uses no throwables and no gadgets. The ammo and stims in its bag are there to hand to the PC.
 * - Its gear starts every raid as the **base kit** (`ANDROID_KIT`). The base kit is a **bound thing** — it is never dropped,
 *   never given away, never left in a corpse, never sent to the stash (otherwise every raid would mint free gear). Only
 *   what was found in the raid (`raidFound`) moves, and on extraction it goes to the squad leader's stash
 *   (`ally deposit` → `inventory:allyDeposit`).
 * - Shared ship only (there is no personal-ship bay). Where there is no lobby there is only the cheat roster.
 */
import type * as THREE from 'three';
import type { PeerId } from './net';
import type { ItemInstance, PlayerDamageSource } from './types';

/** Android id. For a lobby bot it is `LobbyPlayer.id` (`androidIdOf(lobby.code, bay)`), for the cheat roster `androidIdOf('local', bay)`. */
export type AllyId = string;

/** Stand-in PeerId for the local player — used in the `carrying` and requester slots in a serverless cheat solo. Online it is `ctx.net.localId`. */
export const ALLY_LOCAL_PEER: PeerId = 'local';

/** Display names in bay order. Chat · pings · the squad list · name tags all use the same name. */
export const ANDROID_NAMES_KO: readonly string[] = ['안드로이드 알파', '안드로이드 베타', '안드로이드 감마'];
export function androidNameOf(bay: number): string {
  return ANDROID_NAMES_KO[bay] ?? `안드로이드 ${bay + 1}`;
}

/**
 * The base kit of every raid (item def ids — names, not numbers, so they live in TS). It is bound: it leaves by no road at
 * all — dropping · handing over · a corpse · the stash (no `raidFound` = the kit). A kit piece taken off after a swap
 * vanishes on the spot.
 */
export const ANDROID_KIT: Readonly<{ primary: string; armor: string; bag: string }> = {
  /** These are item def ids — a weapon is not the class id (`ar`) but that class's item (`wpn_ar`, `items/itemIdForWeapon`). */
  primary: 'wpn_ar',
  armor: 'armor_2',
  bag: 'bag_common',
};

/** `dormant` = inside the bay capsule · `hub` = walking the ship · `raid` = the raid. */
export type AllyMode = 'dormant' | 'hub' | 'raid';
/** Wire order (`AllyWire.md`). Never reorder. */
export const ALLY_MODES: readonly AllyMode[] = ['dormant', 'hub', 'raid'];

/**
 * FSM states. Ship: `dormant` · `emerge` (steps out of the capsule) · `retire` (goes back into it) · `hubIdle` (waiting by the launch pod · beside the PC for the cheat).
 * Raid: `follow` (back to the harness) · `roam` (free search inside the harness — 2026-09-16) · `moveTo` (a `가자` ping) · `lead` (take point) · `watch` (a `주의` ping) · `combat` (cover) · `loot` (a crate) · `pickup` (an item on the ground) ·
 * `deliver` (dropping it for the requester) · `dropJunk` (shedding weight) · `seekExtract` (searching for the way out) · `callExtract` (pressing the console) · `board` (boarding the landed ship) ·
 * `contract` (searching for a contract objective) · `rescue` (getting a downed PC up) · `carry` (running a body out of a hazard) · `downed` · `dead` · `aboard` (aboard the climbing ship).
 */
export type AllyStateId =
  | 'dormant' | 'emerge' | 'retire' | 'hubIdle'
  | 'idle' | 'follow' | 'moveTo' | 'lead' | 'watch' | 'combat'
  | 'loot' | 'pickup' | 'deliver' | 'dropJunk'
  | 'seekExtract' | 'callExtract' | 'board' | 'contract'
  | 'rescue' | 'carry' | 'downed' | 'dead' | 'aboard'
  | 'roam';
/** Wire order (`AllyWire.st`). Never reorder — a new state is appended at the end. */
export const ALLY_STATES: readonly AllyStateId[] = [
  'dormant', 'emerge', 'retire', 'hubIdle',
  'idle', 'follow', 'moveTo', 'lead', 'watch', 'combat',
  'loot', 'pickup', 'deliver', 'dropJunk',
  'seekExtract', 'callExtract', 'board', 'contract',
  'rescue', 'carry', 'downed', 'dead', 'aboard',
  /* 2026-09-16 (free search) — a new state must be appended at the end (the wire index). */
  'roam',
];

/** The pose to draw (player/ maps it onto a `SoldierModel` pose). */
export type AllyPose = 'stand' | 'crouch' | 'downed' | 'dormant' | 'carry' | 'dead';
/** Wire order (`AllyWire.po`). Never reorder. */
export const ALLY_POSES: readonly AllyPose[] = ['stand', 'crouch', 'downed', 'dormant', 'carry', 'dead'];

/** `AllyBodyView.flags` · `AllyWire.f` bits. */
export const ALLY_FLAGS = { AIM: 1, FIRE: 2, RELOAD: 4, SPRINT: 8, HIDDEN: 16 } as const;

export interface AllyRosterEntry {
  readonly id: AllyId;
  /** Cockpit bay 0..ANDROID_BAY_COUNT-1. */
  readonly bay: number;
  /** Lobby slot (colour · launch pod · spawn spacing). The cheat roster takes the first slot the local player is not using. */
  readonly slot: number;
  readonly name: string;
  /** When it joined (ms) — in a lobby the relay's `LobbyPlayer.recruitedAt`. */
  readonly recruitedAt: number;
  /** true = one from the serverless cheat roster. */
  readonly local: boolean;
}

/**
 * One android's **read-only body state** — player (drawing) · enemies (targets) · ui (the squad list · name tags · the map)
 * read it every frame. The object and its vectors are reused: read it, use it at once, never keep it.
 */
export interface AllyBodyView {
  readonly id: AllyId;
  readonly name: string;
  readonly bay: number;
  readonly slot: number;
  readonly mode: AllyMode;
  readonly state: AllyStateId;
  readonly pose: AllyPose;
  /** Foot position (world). In the ship it is ship-origin coordinates (the interior is built at the origin). */
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  /** Body facing — the same convention as a remote player snapshot. */
  readonly yaw: number;
  readonly pitch: number;
  readonly hp: number;
  readonly maxHp: number;
  readonly shield: number;
  readonly maxShield: number;
  /** The bleed-out pool while downed (0 when not downed). */
  readonly downHp: number;
  readonly downed: boolean;
  readonly dead: boolean;
  /** Not drawn — inside the drop pod · inside a ship that lifted off · `ALLY_FLAGS.HIDDEN`. */
  readonly hidden: boolean;
  /** `ALLY_FLAGS` bits. */
  readonly flags: number;
  /** Def id of the primary in its hands (GearLook), null with none. */
  readonly weaponDefId: string | null;
  readonly armorDefId: string | null;
  readonly bagDefId: string | null;
  /** PeerId of the person being carried (`ALLY_LOCAL_PEER` in a serverless cheat solo), null with none. */
  readonly carrying: PeerId | null;
  /** Look / aim point (a `주의` ping · the body it is fighting). Null with none. */
  readonly lookAt: THREE.Vector3 | null;
  /** Stride phase 0..1 · movement blend 0..1 (the same meaning as on a remote avatar). */
  readonly stridePhase: number;
  readonly moveBlend: number;
}

export interface AllyEquip {
  primary: ItemInstance | null;
  armor: ItemInstance | null;
  bag: ItemInstance | null;
}

/** A view of what it carries — a replica knows it too, from the last `ally bag` (host succession · corpse · debug). */
export interface AllyLoadoutView {
  readonly equip: Readonly<AllyEquip>;
  readonly items: readonly ItemInstance[];
  readonly cols: number;
  readonly rows: number;
  /** kg — the same weight formula as a person (`InventoryRef.weightInfoFor`). */
  readonly weight: number;
  readonly capacity: number;
}

/** `ctx.allies` (owner: allies/AllySystem). */
export interface AlliesRef {
  /** The androids of my squad (in bay order). In a lobby the bot members, otherwise the cheat roster. */
  readonly roster: readonly AllyRosterEntry[];
  /** Does this client simulate the androids (solo · lobby host). */
  readonly simulating: boolean;
  /** Every body this client knows — the dormant bay bodies in the shared ship included. Reused array. */
  getBodies(): readonly AllyBodyView[];
  getBody(id: AllyId): AllyBodyView | null;
  /** Bodies an enemy may target — in a raid · neither downed nor dead · visible. Reused array. enemies calls it every frame. */
  getCombatBodies(): readonly AllyBodyView[];
  getLoadout(id: AllyId): AllyLoadoutView | null;
  /**
   * Deals damage (enemies — on the authority only). Shield → hp → downed → death at the end of the bleed-out. Called on a
   * replica it is ignored. `source` = the same damage source as for a person (an enemy entity id and so on).
   */
  damage(id: AllyId, amount: number, source?: PlayerDamageSource, from?: THREE.Vector3): void;
  /**
   * Gets a downed android up — the local player's revive hold completing (player/) · the defibrillator (gadgets/). On the
   * authority at once, otherwise `allyq revive`. True when the request went out or was applied.
   */
  requestRevive(id: AllyId, opts?: { defib?: boolean }): boolean;
  /** The body of the android carrying this person (player/ raises the carried pose), null with none. */
  carrierOf(peer: PeerId): AllyBodyView | null;
  /** The dev cheat `/android 1|0` — one line of result (Korean). The console calls it. */
  devSetAndroid?(on: boolean): string;
}
