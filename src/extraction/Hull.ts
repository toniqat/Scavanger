import * as THREE from 'three';
import type { Obstacle, WorldRef } from '@/shared';
import { BAY_HALF_W, BAY_HEIGHT, BAY_Z_MAX, BAY_Z_MIN, type Dropship } from './Ship';

/**
 * src/extraction/Hull.ts — **hull colliders of the landed extraction ship, and the enemy exclusion zone**
 * (2026-09-13 extraction rework).
 *
 * The question this file answers: *why did bugs and rogues walk through the ship's shell into the bay, and what
 * stops them now.*
 *
 * The ship was mesh only and had **no world collider at all** — to enemies (and bullets, and grenades) it was thin
 * air. Now the shell is registered with `WorldRef.addObstacle` as eight box colliders (`Obstacle.box`) the moment it
 * touches down, and they are removed when the ship **starts to rise**. Why they are not moving colliders: during
 * liftoff a passenger is in `setShipInterior` box mode and never sees world collision, while the rising roof plate
 * catches the feet + `BOX_HEADROOM` window and **pushes bodies sideways** — keeping it would do harm, not good. While
 * the ship sits on the pad it only sways by a centimetre, so static colliders are enough.
 *
 * The rear ramp has no collider — it is the hole people walk through. Closing that hole **to enemies only** is
 * `keepEnemyOut`: `resolveCollision` does not know who calls it, so "enemies only" cannot be expressed as a world
 * collider. An enemy inside the bay rectangle (grown by the body radius) is pushed out **through the doorway (local
 * +Z) only** — sideways and forward are already blocked by the shell colliders, so a sideways push would shove the
 * body into a wall plate and set the two resolutions fighting each other.
 */

/** One hull box in ship-local space: centre (x, z), half extents, base above the deck origin (`y0`) and height. */
interface HullBox { x: number; z: number; halfX: number; halfZ: number; y0: number; h: number }

/*
 * Local −Z is the nose, the ramp faces +Z. Outline from `Ship.ts`: shell x ±2.1 (bay opening ±1.6), y −0.3..3.0,
 * z −6.6..0.6; nose + chin to z −9.7; nacelles at x ±4.2, z −3.2 (r ≈ 1.05, y 0.1..3.7).
 */
const HULL_BOXES: readonly HullBox[] = [
  { x: -1.85, z: -3.0, halfX: 0.25, halfZ: 3.6, y0: -0.3, h: 3.3 },      // left side slab (inner face x −1.6)
  { x: 1.85, z: -3.0, halfX: 0.25, halfZ: 3.6, y0: -0.3, h: 3.3 },       // right side slab
  { x: 0, z: -3.0, halfX: 2.1, halfZ: 3.6, y0: -0.3, h: 0.3 },           // belly — its top is the deck (getSurfaceY: corpses, grenades)
  { x: 0, z: -3.0, halfX: 2.1, halfZ: 3.6, y0: BAY_HEIGHT, h: 1.25 },    // roof + top deck + spine (bullets / camera; above a body's headroom)
  { x: 0, z: -5.95, halfX: 1.6, halfZ: 0.65, y0: -0.3, h: 3.3 },         // bay front wall → front cap (solid between them)
  { x: 0, z: -8.15, halfX: 1.45, halfZ: 1.55, y0: -0.3, h: 3.3 },        // nose + chin + cockpit
  { x: -4.2, z: -3.2, halfX: 1.0, halfZ: 1.0, y0: 0, h: 3.7 },           // left nacelle
  { x: 4.2, z: -3.2, halfX: 1.0, halfZ: 1.0, y0: 0, h: 3.7 },            // right nacelle
];

/** The doorway plane the enemy exclusion pushes out to (the ramp hinge sits at local z 0.25). */
const DOOR_Z = BAY_Z_MAX + 0.05;
/** Inner face of the side slabs. */
const BAY_INNER_HALF_W = BAY_HALF_W + 0.1;
/** Vertical band (above the deck origin) where a body counts as "in the bay". */
const BAY_Y_MIN = -1.2;

const _local = new THREE.Vector3();

export class ShipHull {
  private readonly obstacles: Obstacle[] = HULL_BOXES.map((b) => ({
    position: new THREE.Vector3(),
    radius: Math.hypot(b.halfX, b.halfZ),     // the circumscribed circle — `SpatialHash` buckets on it (`Obstacle.box` contract)
    height: b.h,
    box: { halfX: b.halfX, halfZ: b.halfZ, yaw: 0 },
  }));
  private removers: Array<() => void> = [];

  get registered(): boolean { return this.removers.length > 0; }

  /** Register the hull where the ship sits now (touchdown). Replaces a previous registration. */
  register(world: WorldRef | null, ship: Dropship): void {
    this.unregister();
    if (!world?.ready || typeof world.addObstacle !== 'function') return;
    const yaw = ship.yaw;
    const baseY = ship.getGroundY();   // not `root.y` — the resting height, whatever the drawn hull does (liftoff spool shake)
    for (let i = 0; i < HULL_BOXES.length; i++) {
      const b = HULL_BOXES[i], o = this.obstacles[i];
      ship.bayToWorld(b.x, b.z, baseY + b.y0, o.position);
      // three.js rotation.y θ maps local +X to (cos θ, −sin θ); `Obstacle.box.yaw` is the math convention (cos, sin) → −θ
      o.box!.yaw = -yaw;
      this.removers.push(world.addObstacle(o));
    }
  }

  unregister(): void {
    for (const r of this.removers) r();
    this.removers.length = 0;
  }

  /** Is `p` (feet) inside the bay rectangle of a ship that is on / near the pad? */
  static inBay(ship: Dropship, p: THREE.Vector3, pad = 0): boolean {
    if (!ship.nearGround) return false;
    const l = ship.bayLocal(p, _local);
    return l.y > BAY_Y_MIN && l.y < BAY_HEIGHT
      && Math.abs(l.x) < BAY_INNER_HALF_W + pad && l.z < DOOR_Z + pad && l.z > BAY_Z_MIN - 0.1 - pad;
  }

  /**
   * Push an enemy body out through the doorway (see the file comment). The rectangle is grown by the body radius, so a
   * big body is kept clear of the opening, while one hugging the outside of a side slab (|x| ≥ 2.1 + r) never overlaps it.
   */
  static keepEnemyOut(ship: Dropship, p: THREE.Vector3, radius: number): boolean {
    if (!ship.nearGround) return false;
    const r = Math.max(0, radius);
    const l = ship.bayLocal(p, _local);
    if (l.y <= BAY_Y_MIN || l.y >= BAY_HEIGHT) return false;
    if (Math.abs(l.x) >= BAY_INNER_HALF_W + r) return false;
    if (l.z >= DOOR_Z + r || l.z <= BAY_Z_MIN - 0.1 - r) return false;
    ship.bayToWorld(l.x, DOOR_Z + r + 0.01, p.y, p);
    return true;
  }
}
