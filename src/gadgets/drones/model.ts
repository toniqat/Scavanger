/**
 * src/gadgets/drones/model.ts — **the drone folder's shared vocabulary.**
 *
 * `DroneSystem` (the core: deploy · the control switch · the camera · link range · owner-authoritative sync ·
 * recovery) knows nothing about the body kinds. The ground drone (`GroundDrone`) and the air drone (`AirDrone`) each
 * implement this `DroneBody` and fill in physics · model · camera pose.
 * The public contract is `drones.ts` in `@/shared`; this file is used inside the folder only.
 */
import * as THREE from 'three';
import type { DroneKind, GameContext } from '@/shared';
import {
  DRONE_AIR_HP, DRONE_AIR_RANGE, DRONE_GROUND_HP, DRONE_GROUND_RANGE, DroneFlags,
  type DroneRef, type Interactable, type PeerId,
} from '@/shared';

/** One frame of control input. `DroneSystem` builds it from keys · mouse (a body never reads `ctx.input` itself). */
export interface DroneInput {
  /** −1..1 — forward (+) / back, in the drone view's frame. */
  forward: number;
  /** −1..1 — right (+) / left. */
  right: number;
  /** Air drone: Space = +1, C = −1. The ground drone ignores it. */
  vertical: number;
  /** Ground drone: Shift sprint. */
  sprint: boolean;
  /** Ground drone: Space was **pressed** this frame (not held). */
  jump: boolean;
  /** The drone view's yaw / pitch (rad). */
  yaw: number;
  pitch: number;
}

export interface DroneBody {
  readonly kind: DroneKind;
  /**
   * The root that attaches to the scene. **No lights** — the scene point-light count rule (CLAUDE.md). Glow comes
   * from emissive / additive only.
   */
  readonly root: THREE.Group;
  readonly radius: number;
  readonly height: number;
  /** Ground = the foot point, air = the body centre. `DroneRef.position` hands out this very vector. */
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  readonly yaw: number;
  readonly sprinting: boolean;
  readonly airborne: boolean;
  /** Resets to the deploy spot · facing. */
  reset(position: THREE.Vector3, yaw: number, ctx: GameContext): void;
  /** One frame of owner-side physics. `input` null = nobody is controlling it (ground stops, air hovers in place). */
  simulate(dt: number, ctx: GameContext, input: DroneInput | null): void;
  /** Replica: applies the interpolated wire pose (`DroneFlags` included) as it is. */
  applyRemote(position: THREE.Vector3, yaw: number, flags: number): void;
  /** Visual presentation such as wheels · rotor · LEDs (owner and replica alike). */
  animate(dt: number, time: number): void;
  /** The first-person lens position and the point it looks at. */
  getCameraPose(pitch: number, outPos: THREE.Vector3, outLook: THREE.Vector3): void;
  /** The centre of the top face a small deployable mounts on. */
  getMountPoint(out: THREE.Vector3): THREE.Vector3;
  /** Ray intersection distance with the body, −1 with no hit. Allocates nothing. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): number;
  /** Hides the parts that cover the lens while the owner looks through this drone. */
  setOwnerView(looking: boolean): void;
  dispose(): void;
}

/* ═══════════════════════ appended (2026-09-11, drone core) ═══════════════════════ */

/*
 * ── The yaw convention (both bodies must agree on it) ──────────────────────────────
 * A drone's yaw follows the convention **nose = model +Z** — with `root.rotation.y = yaw` the nose points along
 *   forward = ( sin yaw, 0, cos yaw ),   right = ( −cos yaw, 0, sin yaw )
 * and + pitch is up (`look.y = sin pitch`). The mouse turns it exactly as the player camera rig does —
 * `yaw −= dx × sensitivity`, `pitch −= dy × sensitivity` — so pushing the mouse right turns the nose right.
 * The player's yaw is the opposite convention (forward = −sin, −cos), so deploying a drone facing where the PC
 * looks adds `+π` (`droneYawFromPlayer`).
 */
export function droneYawFromPlayer(playerYaw: number): number { return wrapAngle(playerYaw + Math.PI); }

export function wrapAngle(a: number): number {
  a %= Math.PI * 2;
  if (a > Math.PI) a -= Math.PI * 2; else if (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** The shortest angle from `from` to `to`. */
export function angleDelta(from: number, to: number): number { return wrapAngle(to - from); }

/** Per drone kind: link range (m, 3D) · max hp · Korean name. */
export function droneRange(kind: DroneKind): number { return kind === 'air' ? DRONE_AIR_RANGE : DRONE_GROUND_RANGE; }
export function droneMaxHp(kind: DroneKind): number { return kind === 'air' ? DRONE_AIR_HP : DRONE_GROUND_HP; }
export function droneName(kind: DroneKind): string { return kind === 'air' ? '공중 드론' : '지상 드론'; }

/* ── Handling feel · visuals · networking helper values (not gameplay numbers) ── */
/** The same value as `player/CameraRig.sensitivity` (a fixed value — settings do not change it). */
export const DRONE_LOOK_SENSITIVITY = 0.0022;
/** Pitch limit of the drone view (rad). A body may clamp it tighter. */
export const DRONE_LOOK_PITCH_MAX = 1.4;
/** Replica interpolation: a gap between samples wider than this teleports instead of easing across (m). */
export const DRONE_REPLICA_SNAP_DIST = 8;
/** Repeat interval of the sprint sound · the static · the move sound while controlled (s, an audio beat). */
export const DRONE_SPRINT_SFX_S = 0.32;
export const DRONE_STATIC_SFX_S = 0.45;
export const DRONE_MOVE_SFX_S = 0.42;
/** Minimum interval before asking an owner for `droneq sync` again after a `state` for an unknown drone (s). */
export const DRONE_SYNC_RETRY_S = 2;

/* ── Handling-feel numbers — the lead moved them into `data/constants.csv` on 2026-09-11; the old names are
 * re-exported only for the call sites. ── */
export {
  DRONE_DEPLOY_DIST_GROUND, DRONE_DEPLOY_DIST_AIR, DRONE_DEPLOY_LIFT_AIR,
  DRONE_GROUND_ACCEL, DRONE_GROUND_BRAKE, DRONE_GROUND_AIR_ACCEL, DRONE_RECOVER_AIR_BONUS,
} from '@/shared';

/* ── Scratch (split by purpose — so that one function's scratch argument is never overwritten by another) ── */
export const UP = new THREE.Vector3(0, 1, 0);
/** Control: the camera pose. */
export const _camPos = new THREE.Vector3();
export const _camLook = new THREE.Vector3();
/** Lifecycle: the deploy spot · rays. */
export const _l0 = new THREE.Vector3();
export const _l1 = new THREE.Vector3();
export const _l2 = new THREE.Vector3();
/** Wire: a received sample. */
export const _w0 = new THREE.Vector3();

/**
 * The `DroneRef` implementation — one body (`DroneBody`) and that drone's core state. The owner side
 * (`owner === 'local'`) simulates the body directly; a replica interpolates the wire samples and applies them with
 * `applyRemote`.
 *
 * `owner` is **always `'local'` for my own drone** (single-player and multiplayer alike) and the owner's PeerId on a
 * replica — the wire carries my own PeerId.
 */
export class Drone implements DroneRef {
  readonly id: string;
  readonly kind: DroneKind;
  readonly owner: PeerId | 'local';
  readonly body: DroneBody;
  private readonly ctx: GameContext;
  hp: number;
  maxHp: number;
  removing = false;
  /** Owner side: this client is looking through this drone right now. */
  localControlled = false;
  /** Replica: the last wire flags. Owner: the flags last sent. */
  flags = 0;
  linkRatio = 0;
  /** Owner side: the sprint noise lasts until this time (`ctx.time`) → `aggroable`. */
  noiseUntil = -Infinity;
  /** The authority client: the time at which the next `world:noise` may be emitted. */
  noiseNextAt = 0;
  /**
   * `world:noise.position` · the position for the explosion / recovery audio — a vector owned by this drone, so a
   * receiver that holds on to it is safe.
   */
  readonly noisePos = new THREE.Vector3();
  readonly fxPos = new THREE.Vector3();
  /** The control view (the drone yaw convention). */
  lookYaw = 0;
  lookPitch = 0;
  /* Networking (owner) */
  netNextAt = 0;
  netDirty = true;
  /* Audio beats */
  sprintSfxT = 0;
  /** Replica: was it airborne last frame (jump · landing sound). */
  airborneSeen = false;
  interactable: Interactable | null = null;
  /* Replica interpolation — from the pose drawn now to the last sample, over the sample interval */
  readonly fromPos = new THREE.Vector3();
  fromYaw = 0;
  readonly toPos = new THREE.Vector3();
  toYaw = 0;
  lerpT0 = 0;
  lerpDur = 0;
  lastSampleAt = -1;
  readonly renderPos = new THREE.Vector3();

  constructor(ctx: GameContext, id: string, kind: DroneKind, owner: PeerId | 'local', body: DroneBody, hp: number, maxHp: number) {
    this.ctx = ctx;
    this.id = id;
    this.kind = kind;
    this.owner = owner;
    this.body = body;
    this.hp = hp;
    this.maxHp = maxHp;
  }

  get isLocal(): boolean { return this.owner === 'local'; }
  get position(): THREE.Vector3 { return this.body.position; }
  get yaw(): number { return this.body.yaw; }
  get radius(): number { return this.body.radius; }
  get height(): number { return this.body.height; }
  get object(): THREE.Object3D { return this.body.root; }
  get controlled(): boolean { return this.isLocal ? this.localControlled : (this.flags & DroneFlags.CONTROLLED) !== 0; }
  get sprinting(): boolean { return this.isLocal ? this.body.sprinting : (this.flags & DroneFlags.SPRINTING) !== 0; }
  get aggroable(): boolean {
    if (this.kind === 'air') return true;
    return this.isLocal ? this.ctx.time < this.noiseUntil : (this.flags & DroneFlags.NOISY) !== 0;
  }
  get linkLost(): boolean { return this.linkRatio >= 1; }
  get mountedDeployableId(): string | null {
    const list = this.ctx.gadgets?.getDeployables();
    if (!list) return null;
    for (let i = 0; i < list.length; i++) if (list[i].mount === this.id) return list[i].id;
    return null;
  }
  getMountPoint(out: THREE.Vector3): THREE.Vector3 { return this.body.getMountPoint(out); }

  /** The flags the owner side puts on the wire. */
  ownFlags(): number {
    let fl = 0;
    if (this.localControlled) fl |= DroneFlags.CONTROLLED;
    if (this.body.sprinting) fl |= DroneFlags.SPRINTING;
    if (this.body.airborne) fl |= DroneFlags.AIRBORNE;
    if (this.linkRatio >= 1) fl |= DroneFlags.LINK_LOST;
    if (this.kind === 'ground' && this.ctx.time < this.noiseUntil) fl |= DroneFlags.NOISY;
    return fl;
  }
}
