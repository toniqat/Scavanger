import type * as THREE from 'three';
import { RIDE_EDGE_MARGIN, RIDE_FOOT_DROP, RIDE_HEADROOM } from './constants';
import type { Obstacle } from './types';

/* ── The ride coordinate transform (2026-09-10 player/PlayerController → 2026-09-11 shared, C-18) ───────────
 * The player · enemies · corpses board a moving platform (a tram deck, which has `Obstacle.velocity`) by **the same
 * formula**. The convention is CLAUDE.md's "riding is judged by the vehicle's volume, not the platform frame", exactly:
 * entering goes through `getStandingObstacle` alone, staying is the vehicle OBB + headroom (`rideContains`), and
 * movement writes last frame's spot down in vehicle-local coordinates (`recordRideLocal`) and resolves it again this
 * frame with the vehicle's **current** transform (`restoreRideLocal`). No snapshot is taken.
 *
 * `Obstacle.box` (2026-09-09) is `{halfX, halfZ, yaw}`, and `yaw` follows the math convention (local +X → world `(cos, sin)`).
 * A platform with no box (a cylinder) is treated as yaw 0, so the same code runs unchanged. These are all pure functions with no allocation.
 * Not one line of behaviour changed while moving it — the default arguments are the old `PlayerController` constants exactly.
 */

/** World coordinates → vehicle local (`out.y` is the height **measured from the platform's top face**). Returns `out`. */
export function recordRideLocal(c: Obstacle, pos: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const yaw = c.box ? c.box.yaw : 0;
  const dx = pos.x - c.position.x, dz = pos.z - c.position.z;
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  return out.set(dx * cs + dz * sn, pos.y - (c.position.y + c.height), -dx * sn + dz * cs);
}

/** Vehicle local → world (resolved with the vehicle's **current** transform). Returns `pos`. */
export function restoreRideLocal(c: Obstacle, local: THREE.Vector3, pos: THREE.Vector3): THREE.Vector3 {
  const yaw = c.box ? c.box.yaw : 0;
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  return pos.set(
    c.position.x + local.x * cs - local.z * sn,
    c.position.y + c.height + local.y,
    c.position.z + local.x * sn + local.z * cs,
  );
}

/**
 * Is the body still riding this vehicle — only while it is inside the vehicle's cross-section (+`edge`) and within the
 * height band `[-footDrop, +headroom]` measured from the platform's top face.
 * `pos` is the **foot** position. The defaults are the player's convention (`RIDE_*`, `data/constants.csv`) — a body of
 * a different size (a large enemy) passes its own as arguments.
 */
export function rideContains(
  c: Obstacle, pos: THREE.Vector3,
  headroom: number = RIDE_HEADROOM, footDrop: number = RIDE_FOOT_DROP, edge: number = RIDE_EDGE_MARGIN,
): boolean {
  const top = c.position.y + c.height;
  if (pos.y > top + headroom || pos.y < top - footDrop) return false;
  const dx = pos.x - c.position.x, dz = pos.z - c.position.z;
  if (!c.box) return dx * dx + dz * dz <= (c.radius + edge) ** 2;
  const cs = Math.cos(c.box.yaw), sn = Math.sin(c.box.yaw);
  const lx = dx * cs + dz * sn, lz = -dx * sn + dz * cs;
  return Math.abs(lx) <= c.box.halfX + edge && Math.abs(lz) <= c.box.halfZ + edge;
}
