/**
 * src/gadgets/model.ts — the gadget folder's shared vocabulary.
 *
 * Only the constants · types (and the stateless helpers) split out of `GadgetSystem`. Nothing here references
 * the class, so a `parts/*` module can use it without importing `GadgetSystem.ts` back (no import cycle).
 * `GadgetSystem.ts` re-exports it with `export *`, so every existing import path still works.
 */
import * as THREE from 'three';
import {
  GADGET_DEFUSE_TIME, GADGET_INCENDIARY_DPS, GADGET_JUMPPAD_FORWARD, GADGET_JUMPPAD_IMPULSE,
  GADGET_CLOAK_SHARE_RADIUS, GADGET_LURE_RADIUS, GADGET_MINE_ARM_TIME, GADGET_MINE_DAMAGE, GADGET_TURRET_DPS, JUMP_PAD_RETRIGGER_S, Keys, PLAYER_RADIUS,
  type BuffMessage, type DeployableKind, type DeployableRef, type EnemyRef, type FlowMessage, type GadgetDef,
  type GadgetId, type GadgetMessage, type GadgetRequest, type GameContext, type GameSystem, type GadgetsRef,
  type Interactable, type ItemInstance, type DeployableWire, type PeerId, type PlayerWeaponHost, type Vec3Tuple,
} from '@/shared';
import { GADGET_DEFS, gadgetDef, gadgetForKind, isRecoverable } from './GadgetDefs';
import { Deployable, BARRICADE_HALF, DOME_UNFOLD_TIME, JUMPPAD_TRIGGER_RADIUS, MINE_TRIGGER_RADIUS } from './Deployable';
import { GadgetVisualPool } from './GadgetVisuals';
import { ThrownGadgetManager } from './ThrownGadget';

/* ── tuning that stays inside this folder ─────────────────────────────────── */
/** Distance in front of the player where 'place' gadgets land. */
export const PLACE_DISTANCE = 2.8;
/** Minimum distance between two deployables of the same kind. */
export const PLACE_CLEARANCE = 1.4;
/** Interaction radius of the recover / defuse prompt. */
export const RECOVER_RADIUS = 2.8;
/** Base seconds between two gadget uses (divided by `derived.useSpeedMul`). */
export const USE_COOLDOWN = 0.55;
/** Turret rounds per second (damage per shot = GADGET_TURRET_DPS / this). */
export const TURRET_ROF = 4;
/** Turret head turn rate (rad/s) and the cone it must be inside before firing. */
export const TURRET_TURN_RATE = 3.4;
export const TURRET_AIM_CONE = 0.22;
/** Turret re-target interval (s). */
export const TURRET_RETARGET = 0.35;
/** Seconds between lure aggro pulses / fire-zone status refreshes. */
export const ZONE_TICK = 0.5;
/** Maximum deployables alive at once (oldest of the same owner is evicted). */
export const MAX_DEPLOYABLES = 40;
/** Half-height of the player capsule used for turret friendly-fire tests. */
export const PLAYER_HALF_H = 0.9;
/**
 * 2026-09-11 (the placement preview, `parts/Preview`): a placement spot more than this far (m) above or below
 * the feet reads as `너무 멀다`. The value is `GADGET_PLACE_VERTICAL_REACH` in `data/constants.csv` — the old
 * name is only re-exported for the call sites.
 */
export { GADGET_PLACE_VERTICAL_REACH as PLACE_VERTICAL_REACH } from '@/shared';

export const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
export const _d = new THREE.Vector3(), _e = new THREE.Vector3(), _fwd = new THREE.Vector3();
/** Scratch reserved for playerAlongRay (its callers pass _a / _b in). */
export const _r0 = new THREE.Vector3(), _r1 = new THREE.Vector3(), _r2 = new THREE.Vector3();
export const _r3 = new THREE.Vector3(), _r4 = new THREE.Vector3();
/** Scratch reserved for the pure geometry helpers (segment vs dome / smoke). */
export const _g0 = new THREE.Vector3(), _g1 = new THREE.Vector3(), _g2 = new THREE.Vector3();

export function toTuple(v: THREE.Vector3): Vec3Tuple {
  return [Math.round(v.x * 1000) / 1000, Math.round(v.y * 1000) / 1000, Math.round(v.z * 1000) / 1000];
}
export function angleDelta(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Which peer a turret / mine hurt. */
export type Victim = PeerId | 'local';

/** 2026-09-15 (B-16): the pooled entry `GadgetsRef.getFireZones` reuses — a writable `FireZoneInfo` shape
 *  (`parts/Queries.getFireZones`). */
export interface FireZoneView {
  id: string;
  position: THREE.Vector3;
  radius: number;
  remaining: number;
  hostile: boolean;
}

/**
 * Special gadgets. Publishes `ctx.gadgets` and owns `GADGET_DEFS`.
 *
 * - `use(id, underhand)` consumes the matching `ItemDef` (`gadgetId`) and either applies an instant effect
 *   (cloak veil / defib), throws a canister (dome shield / lure / smoke / fire) or places a deployable in
 *   front of the player (barricade / mine / turret / jump pad).
 * - World deployables are **host-authoritative**: only `ctx.isAuthority` simulates them. Clients send
 *   `gadq place/damage/recover/sync` and mirror the host's `gad spawn/update/remove/fire/sync`.
 * - Mines, fire zones and turrets have **no friend-or-foe check** — they hurt players and bugs alike.
 * - Query API for other folders: `findEnemyTarget`, `findDistraction`, `blocksProjectile`, `visionFactor`,
 *   `fireDamageAt`, `jumpPadAt`.
 */

export const EMPTY_ENEMIES: readonly EnemyRef[] = [];

