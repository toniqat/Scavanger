import type * as THREE from 'three';
import type { PeerId, Vec3Tuple } from './net';
import type { GadgetId } from './gadgets';
import type { Rarity } from './types';

/* ────────────────────────────────────────────────────────────────────────────
 * Drones (2026-09-11). Owner: `gadgets/drones/DroneSystem` publishes `ctx.drones`.
 *
 * A drone is taken out with a gadget item (`droneGround` / `droneAir`) but is **not a deployable (`DeployableRef`)** —
 * a deployable is host-authoritative, while a drone needs the controlling hand to be the authority or the input lags.
 * So its rules are the opposite:
 *
 *  - **Owner-authoritative.** Position · hp · whether it is being controlled are simulated by the owner client and
 *    broadcast as `drone state`. Everyone else (the host included) interpolates and draws a replica. When an enemy on the
 *    host hits a drone, `droneq damage` goes to the owner.
 *  - **The item is not consumed.** Once taken out, the drone item in the quick slot stays where it is and serves as the
 *    **controller** (hold it and hold `R` = control). Only when the drone is **destroyed** does one of those items leave
 *    the owner's bag. Recovering it with a hold of E consumes nothing.
 *  - **One per kind.** One player keeps at most one ground drone and one air drone at a time.
 *  - **While controlling, the PC stays crouched and still** (`PlayerRef.setDroneControl`). Damage to the PC breaks the
 *    control (`releaseControl('damage')`). So does going out of range (`'range'`) — the drone stays where it is
 *    (an air drone hovers), and once the PC is back in range a hold of `R` reconnects.
 * ──────────────────────────────────────────────────────────────────────────── */

export type DroneKind = 'ground' | 'air';

export const DRONE_KINDS: readonly DroneKind[] = ['ground', 'air'];

/** Drone kind ↔ the gadget that takes it out. */
export const DRONE_GADGET_OF: Readonly<Record<DroneKind, GadgetId>> = { ground: 'droneGround', air: 'droneAir' };

export function droneKindOfGadget(id: GadgetId | null | undefined): DroneKind | null {
  if (id === 'droneGround') return 'ground';
  if (id === 'droneAir') return 'air';
  return null;
}

/** Why the control ended — the HUD line and the audio differ by it. */
export type DroneReleaseReason = 'manual' | 'damage' | 'range' | 'destroyed' | 'reset';

export interface DroneRef {
  /** `${peerId | 'sp'}-d${n}` — the owner makes it. */
  readonly id: string;
  readonly kind: DroneKind;
  readonly owner: PeerId | 'local';
  /** Ground drone = the ground point its wheels touch, air drone = the body centre. */
  readonly position: THREE.Vector3;
  readonly yaw: number;
  readonly hp: number;
  readonly maxHp: number;
  readonly radius: number;
  readonly height: number;
  readonly object: THREE.Object3D;
  /** Somebody (= the owner) is looking through this drone right now. */
  readonly controlled: boolean;
  /** The ground drone is sprinting (noise · aggro). */
  readonly sprinting: boolean;
  /**
   * May an enemy notice and attack this drone right now. Ground drone = it sprinted within the last
   * `DRONE_NOISE_MEMORY_S` (a walking ground drone is **ignored** — no noise, no aggro), air drone = always true.
   */
  readonly aggroable: boolean;
  /** Distance to the owner PC ÷ the range (0 = right beside it, ≥ 1 = the link is lost). */
  readonly linkRatio: number;
  /** The owner PC is out of range, so it cannot be controlled. */
  readonly linkLost: boolean;
  /**
   * Id of the small deployable (mine · remote mine) riding on this drone, null with none. **Derived, never
   * written** (2026-09-19, B-56): the implementation walks `GadgetsRef.getDeployables()` for `mount === this.id`,
   * so gadgets marks a mount by setting `Deployable.mount` — assigning this field does nothing.
   */
  readonly mountedDeployableId: string | null;
  /** Centre of the top face a small deployable sits on (world coordinates, it moves with the drone). */
  getMountPoint(out: THREE.Vector3): THREE.Vector3;
}

export interface DroneRayHit {
  drone: DroneRef;
  point: THREE.Vector3;
  distance: number;
}

export interface DronesRef {
  getDrones(): readonly DroneRef[];
  getDrone(id: string): DroneRef | null;
  /** The `kind` drone the local player put out, null with none. */
  getOwnDrone(kind: DroneKind): DroneRef | null;
  /** The drone whose view the local player is borrowing right now, null with none. */
  readonly controlled: DroneRef | null;
  /** Progress 0..1 of the `R` hold that takes control (0 when not held). The HUD's hold ring reads it. */
  readonly controlHold: number;

  /**
   * Takes the drone out (`gadgets.use('droneGround' | 'droneAir')` hands over to this). **It does not touch the inventory.**
   * False, with a refusal toast, when that kind is already out or there is nowhere to put it.
   */
  deploy(kind: DroneKind): boolean;
  /** Ends the control and returns to the PC's view. Does nothing when not controlling. */
  releaseControl(reason: DroneReleaseReason): void;
  /** Ray intersection against a drone body (the grapple · the placement preview). `kind` may filter it. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, kind?: DroneKind): DroneRayHit | null;
  /** Damage an enemy attack or an explosion did to a drone. When not the owner it is passed on as `droneq damage`. */
  damageDrone(id: string, amount: number, from?: THREE.Vector3): void;
  /** Linear-falloff damage to every drone inside the radius (mine · remote mine · grenade). */
  applyExplosion(center: THREE.Vector3, radius: number, damage: number): void;
  clear(): void;
}

/* ══ appended (2026-09-12): the ground-drone scan — docs/DECISIONS.md 「2026-09-12 — 전투 소모품」 ══════════════════
 * While controlling a ground drone, put the lens-centre ray on a crate · container · corpse · supply box and hold the
 * left button for `DRONE_SCAN_HOLD_S`, and the **best rarity** inside stays as a world label over the target for the rest
 * of the raid (shared with the squad + one chat line). An air drone cannot do it.
 * The preview is **the same roll as opening it** (`InventoryRef.peekContainerItems` · `peekSuppliedItems` ·
 * `WorldRef.previewContainerItems`) — a scan opens nothing, rolls nothing away and moves nothing. No sound, no noise, no aggro either. */

/** The kinds of target that can be scanned — told apart by the `Interactable.id` prefix. */
export type DroneScanTargetKind = 'crate' | 'container' | 'corpse' | 'playerCorpse' | 'supply';

/**
 * Interaction id → scan target kind, null when it cannot be scanned. Map crate `crate_<n>` · structure/platform/tram
 * container `container:<spec>` · enemy corpse `corpse:<enemyId>` · squadmate corpse `pcorpse:<owner>:<n>` · supply box
 * `supply:<callId>`.
 */
export function droneScanKindOf(id: string): DroneScanTargetKind | null {
  if (typeof id !== 'string') return null;
  if (id.startsWith('crate_')) return 'crate';
  if (id.startsWith('container:')) return 'container';
  if (id.startsWith('corpse:')) return 'corpse';
  if (id.startsWith('pcorpse:')) return 'playerCorpse';
  if (id.startsWith('supply:')) return 'supply';
  return null;
}

/** Target name used in chat, hints and labels. */
export const DRONE_SCAN_TARGET_NAME: Readonly<Record<DroneScanTargetKind, string>> = {
  crate: '상자', container: '컨테이너', corpse: '시체', playerCorpse: '유해', supply: '보급 상자',
};

/** The scan target currently on the drone's aim line (the HUD hint). */
export interface DroneScanAim {
  readonly id: string;
  readonly kind: DroneScanTargetKind;
  readonly name: string;
  /** 3-D distance from the lens to the target centre (m). */
  readonly distance: number;
  /** Inside `DRONE_SCAN_RANGE`, so holding now fills the gauge. */
  readonly inRange: boolean;
}

/** One scan result kept for the raid (the latest one per target — scanning again replaces it). */
export interface DroneScanResult {
  readonly id: string;
  readonly kind: DroneScanTargetKind;
  readonly name: string;
  /** The best rarity inside, null = empty. */
  readonly rarity: Rarity | null;
  /** The target's live position (when known, the target's own `Interactable.position` vector — it follows even on a tram). */
  readonly position: THREE.Vector3;
  /** I scanned it (false = a squadmate did). */
  readonly local: boolean;
  readonly byName: string;
  /** When it was scanned, on the `ctx.time` clock. */
  readonly at: number;
}

export interface DronesRef {
  /* ── appended (2026-09-12, the drone scan) — optional: a stub or an old implementation may not have it ── */
  /** Scan hold progress 0..1 (0 when not held, or with nothing aimed at). */
  readonly scanHold?: number;
  /** The scan target on the aim line of the ground drone being controlled (inside `DRONE_SCAN_HINT_RANGE`), null with none. */
  readonly scanAim?: DroneScanAim | null;
  /** Every scan result of this raid (mine + squadmates'). Cleared on a raid reset (`game:newMission/abort` · `hub:entered` · `world:ready`). */
  getScanResults?(): readonly DroneScanResult[];
}

/* ── wire (owner: gadgets/drones) ─────────────────────────────────────────── */

/** `DroneWire.fl` / `drone state.fl` bits. */
export const DroneFlags = {
  CONTROLLED: 1,
  SPRINTING: 2,
  AIRBORNE: 4,
  /** Out of the owner's range. */
  LINK_LOST: 8,
  /** Recent sprint noise (`aggroable`). */
  NOISY: 16,
} as const;

export interface DroneWire {
  id: string;
  kind: DroneKind;
  owner: PeerId;
  p: Vec3Tuple;
  yaw: number;
  hp: number;
  maxHp: number;
  fl: number;
}

/** Owner → others. `state` flows at `DRONE_NET_HZ`. Each owner answers a late-joining peer with `sync`. */
export type DroneMessage =
  | { t: 'drone'; ev: 'spawn'; d: DroneWire }
  | { t: 'drone'; ev: 'state'; id: string; p: Vec3Tuple; yaw: number; hp: number; fl: number }
  | { t: 'drone'; ev: 'remove'; id: string; reason: 'destroyed' | 'recovered' | 'expired' }
  | { t: 'drone'; ev: 'sync'; items: DroneWire[] }
  /**
   * appended (2026-09-12, the drone scan): the scanner → others. `id` = the target's `Interactable.id`, `r` = the best
   * rarity (null = empty), `p` = where the target stood at the moment of the scan. It is **display only**, so nothing is
   * committed — the receiver checks the lobby membership, the shape and the sender's ground-drone distance and then only
   * raises a label (`gadgets/drones/parts/Scan.onRemoteScan`). It never goes to a late joiner (design note §7).
   */
  | { t: 'drone'; ev: 'scan'; id: string; r: Rarity | null; p: Vec3Tuple };

/** Any → drone owner (`damage`) / any → others (`sync` = send me your list of drones). */
export type DroneRequest =
  | { t: 'droneq'; ev: 'damage'; id: string; dmg: number }
  | { t: 'droneq'; ev: 'sync' };
