/**
 * src/gadgets/model.ts — the gadget folder's shared vocabulary.
 *
 * Only the constants · types (and the stateless helpers) split out of `GadgetSystem`. Nothing here references
 * the class, so a `parts/*` module can use it without importing `GadgetSystem.ts` back (no import cycle).
 * `GadgetSystem.ts` re-exports it with `export *`, so every existing import path still works.
 */
import * as THREE from 'three';
import type { EnemyRef, PeerId, Vec3Tuple } from '@/shared';

/* ── tuning that stays inside this folder ─────────────────────────────────── */
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

/** The shared empty answer the enemy queries return when there is no enemy manager (no allocation per call). */
export const EMPTY_ENEMIES: readonly EnemyRef[] = [];

