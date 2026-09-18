import type * as THREE from 'three';
import type { PeerId } from './net';
import type { ItemInstance } from './types';

/* ────────────────────────────────────────────────────────────────────────────
 * Special gadget consumables.
 * Owner: gadgets/GadgetSystem publishes `ctx.gadgets`; item definitions live in items/.
 * World-persistent gadgets (dome shield, barricade, mine, turret, jump pad, zones) are
 * host-authoritative and replicated with the `gad` / `gadq` messages.
 * ──────────────────────────────────────────────────────────────────────────── */

export type GadgetId =
  | 'cloakVeil'      // 은폐 장막 — cloaks the user and nearby squadmates
  | 'domeShield'     // 돔 실드 — thrown sphere that unfolds into a dome (hp 1000)
  | 'barricade'      // 바리케이드 — big wall placed ahead, recoverable by anyone (3 s)
  | 'lureGrenade'    // 유인 수류탄 — noisy grenade that pulls bug aggro / draws fire
  | 'smokeGrenade'   // 연막탄 — blinds enemies; shooting from inside draws inaccurate return fire
  | 'mine'           // 지뢰 — arms after 3 s, friendly fire, defusable
  | 'turret'         // 포탑 — auto turret, friendly fire, recoverable
  | 'incendiary'     // 화염 지대 — **an internal def with no item** (2026-09-15 fire merge): it stands where a fire grenade burst
  | 'defib'          // 제세동기 — instantly revives a downed squadmate at full hp
  | 'jumpPad'        // 점프대 — launches whoever steps on it, recoverable
  /* appended (2026-09-11) */
  | 'remoteMine'     // 원격 지뢰 — C4. Once placed, hold it and right-click to detonate every one of yours
  | 'droneGround'    // 지상 드론 — `ctx.drones` (shared/drones.ts). The item stays behind as the controller
  | 'droneAir'       // 공중 드론 — the same rules, it hovers in place
  /* 2026-09-15 2nd pass (the fire merge, user's decision): **retired**. `incendiary` is the only def that makes `fire` —
     this id, like `airstrike` · `secondary`, keeps its name for old saves and the old wire only (it has no def). */
  | 'grenadeFire'
  /* appended (2026-09-15, the sandworm): `진동 장치` — it strikes the ground once a second and on the fifth it calls the
     sandworm (`sandworm:summon`). It comes only from the basement of `아켈론 II 전진기지`, cannot be recovered, and when
     the worm erupts everything inside that radius is destroyed. */
  | 'thumper';

export const GADGET_IDS: readonly GadgetId[] = [
  'cloakVeil', 'domeShield', 'barricade', 'lureGrenade', 'smokeGrenade',
  /* 2026-09-15 2nd pass (the fire merge): `'incendiary'` left **the list only** — the item (`gad_incendiary`) is gone and
     it became an **internal def** that stands where a fire grenade burst. The type, the def and the implementation are unchanged (the same treatment as `airstrike`). */
  'mine', 'turret', 'defib', 'jumpPad',
  /* appended (2026-09-11) */
  'remoteMine', 'droneGround', 'droneAir',
  /* appended (2026-09-15, the sandworm) */
  'thumper',
];

/** How the gadget leaves the hand. */
export type GadgetUseKind =
  | 'throw'      // arc throw like a grenade (over/under toggle)
  | 'place'      // placed on the ground in front of the player
  | 'self'       // instant, affects the user / nearby allies
  | 'target'     // aimed at another player (defibrillator)
  /* appended (2026-09-11) */
  | 'drone';     // `ctx.drones.deploy(kind)` — the item is NOT consumed (it stays as the controller)

/** Things that persist in the world after use. */
export type DeployableKind =
  | 'domeShield' | 'barricade' | 'mine' | 'turret' | 'jumpPad'
  | 'smoke'      // smoke cloud (vision blocker)
  | 'fire'       // burning ground (damage over time)
  | 'lure'       // noise beacon
  /* appended (2026-09-11) */
  | 'remoteMine'  // 원격 지뢰 (C4) — detonated by its owner
  /* appended (2026-09-15, the sandworm) */
  | 'thumper';    // 진동 장치 — a small deployable, but it cannot be mounted on a drone (it has to strike the ground)

/**
 * 2026-09-11 (the placement preview): a **large deployable** only stands on ground that is reasonably flat and has room —
 * it cannot be mounted on a drone. The other `place` deployables (mine · remote mine) are **small**, so some slope is
 * fine and they can sit on a drone's top face.
 */
export const LARGE_DEPLOYABLE_KINDS: readonly DeployableKind[] = ['barricade', 'jumpPad', 'turret'];
/** Deployables that may sit on a drone's top face (`DroneRef.getMountPoint`). One per drone. */
export const MOUNTABLE_DEPLOYABLE_KINDS: readonly DeployableKind[] = ['mine', 'remoteMine'];
export function isLargeDeployable(kind: DeployableKind | null | undefined): boolean {
  return kind != null && LARGE_DEPLOYABLE_KINDS.includes(kind);
}
export function isMountableDeployable(kind: DeployableKind | null | undefined): boolean {
  return kind != null && MOUNTABLE_DEPLOYABLE_KINDS.includes(kind);
}

/**
 * 2026-09-11: the placement preview of the `place` gadget in hand (owner: gadgets). It is **the same** judgement as the
 * spot a left click really places on — a green preview means it is placed, a red one that it is refused with `reason`.
 */
export interface PlacementPreview {
  gadget: GadgetId;
  kind: DeployableKind;
  valid: boolean;
  /** The refusal reason (one Korean line), null when valid. */
  reason: string | null;
  position: THREE.Vector3;
  yaw: number;
  /** The drone's id while it is being mounted on a drone. */
  mount: string | null;
}

export interface GadgetDef {
  id: GadgetId;
  name: string;
  description: string;
  use: GadgetUseKind;
  /** Deployable spawned on use, or null for pure effects (cloak veil, defib). */
  deployable: DeployableKind | null;
  /** Seconds the effect / deployable lives (0 = until destroyed or recovered). */
  duration: number;
  /** Deployable hit points (0 = indestructible / not damageable). */
  hp: number;
  /** Effect radius in meters (blast, cloud, cloak share, jump pad trigger …). */
  radius: number;
  /** Seconds of hold-to-interact needed to recover / defuse it (0 = not recoverable). */
  recoverTime: number;
  icon: string;
  color: string;
  /* ── appended: 2026-09-15 (the gadget rework, user's decision) ── */
  /**
   * Does damage the deployable took stay as **item durability** (dome shield · barricade).
   * When true the deployable's max hp is taken not from `GadgetDef.hp` but from **that item's `ItemDef.durabilityMax`**,
   * and on recovery the hp left is written back as the returned `ItemInstance.durability` — so whatever was chewed off
   * needs a workbench repair, and the salvage yield rides straight on 「craft materials × the five 20 % durability
   * buckets」 (2026-09-10). No new concept is created.
   */
  wearsItemDurability?: boolean;
}

export interface DeployableRef {
  readonly id: string;
  readonly kind: DeployableKind;
  /** Peer that placed it; 'local' in single-player. */
  readonly owner: PeerId | 'local';
  readonly position: THREE.Vector3;
  readonly yaw: number;
  readonly radius: number;
  readonly hp: number;
  readonly maxHp: number;
  /** false while a mine is still arming (3 s) / a shield is unfolding. */
  readonly armed: boolean;
  /** ctx.time when it expires, or 0 for "no expiry". */
  readonly expires: number;
  readonly object: THREE.Object3D;
  /** Enemies (and friendly fire) chew through deployables with this. */
  takeDamage(amount: number, from?: THREE.Vector3): void;
}

export interface GadgetsRef {
  getDefs(): readonly GadgetDef[];
  getDef(id: GadgetId): GadgetDef | undefined;
  getDeployables(): readonly DeployableRef[];

  /**
   * Use one gadget from the bag (quick-use bar or inventory). Consumes the item through `ctx.inventory`
   * and, for host-authoritative deployables, sends a `gadq` request. false when the item is missing
   * or placement failed.
   */
  use(id: GadgetId, underhand?: boolean): boolean;

  /** Enemy AI: nearest deployable an enemy should shoot / chew (barricade, turret, lure beacon), or null. */
  findEnemyTarget(pos: THREE.Vector3, radius: number): DeployableRef | null;
  /** Enemy AI: strongest active distraction (lure grenade) within `radius`, or null. */
  findDistraction(pos: THREE.Vector3, radius: number): DeployableRef | null;
  /**
   * Segment test against solid deployables (dome shield, barricade).
   * `fromEnemy` = the projectile was fired by an enemy. Returns the blocked point or null.
   */
  blocksProjectile(from: THREE.Vector3, to: THREE.Vector3, fromEnemy: boolean): THREE.Vector3 | null;
  /** 0 = fully obscured by smoke, 1 = clear. Enemy perception multiplies its detection range by this. */
  visionFactor(from: THREE.Vector3, to: THREE.Vector3): number;
  /** Damage-per-second a position takes from fire zones (0 when not standing in one). */
  fireDamageAt(pos: THREE.Vector3): number;
  /** Jump pad under `pos` that should launch a mover, or null. */
  jumpPadAt(pos: THREE.Vector3): DeployableRef | null;
  /** Item returned when a deployable is recovered (barricade / turret / jump pad), or null. */
  recover(id: string): ItemInstance | null;

  clear(): void;
}

/* ── appended (2026-09-11): the placement preview · remote mines · drone mounting (owner: gadgets) ── */
export interface DeployableRef {
  /** For a deployable riding on a drone, that drone's id (`DroneRef.id`) — its position follows the drone every frame. */
  readonly mount?: string | null;
}

export interface GadgetsRef {
  /** The current placement preview of the `place` gadget in hand, null when none is held. */
  readonly placement?: PlacementPreview | null;
  /**
   * Detonates **every** remote mine the local player placed (armed ones only). A non-host sends a `gadq detonate` request.
   * When one target is caught by several in the same detonation, only the strongest lands in full and the rest are
   * × `GADGET_REMOTE_MINE_STACK_MUL`. The return = how many were detonated (or requested).
   */
  detonateRemoteMines?(): number;
  /** How many remote mines owned by the local player are still in the world (the detonator hand pose · the HUD). */
  liveRemoteMineCount?(): number;
}

/* ══ appended (2026-09-15, B-16): the fire-zone query · G-10 the incendiary grenade ═════════════════ */
import type { FireZoneInfo } from './types';

export interface GadgetsRef {
  /**
   * The living `fire` deployables (all `hostile: false`). **Every client** answers (replicas included). Called every frame — reused array.
   */
  getFireZones?(): readonly FireZoneInfo[];
  /**
   * A fire grenade (`ItemDef.grenade === 'fire'`) burst at `position` — this stands up a fire zone owned by the local
   * player (since the 2026-09-15 2nd-pass fire merge it is the internal `GadgetId 'incendiary'` def,
   * `GRENADE_INCENDIARY_RADIUS` · `GRENADE_INCENDIARY_DURATION`, damage per second `GADGET_INCENDIARY_DPS`). The name is
   * contract, so it is left alone.
   * It is the same road as the fire grenade's `onThrownImpact` — on the authority `spawnDeployable` at once, otherwise a `gadq place` request to the host.
   * The one call site is the local grenade explosion in weapons.
   */
  igniteGrenadeFire?(position: THREE.Vector3): void;
}
/* ══ end 2026-09-15 fire zones ══ */
