/**
 * src/world/rover/model.ts — the **vocabulary** the rover parts share. No state (2026-09-13).
 *
 * The rules' source is the rover section of `shared/types.ts`. The vehicle's real state is **its arc position `s` on the
 * loop, one number** (`RoverVehicleDef.s`), and the path is seed deterministic, so only `s` · direction · state · hp ·
 * riders go over the wire — the same philosophy as the tram. The path math is the rail's (`rails/model`), used only as a **closed loop**.
 *
 * File ownership: `RoverPlan` · `RoverRoad.ts` = route plan · dirt road · stations (R1), `Rover.ts` = vehicle ·
 * turret · sync (R2). Both sides use this file's function signatures, so they are never changed (adding is fine).
 */
import type * as THREE from 'three';
import { ROVER_FARE_MAX, ROVER_FARE_MIN, ROVER_FARE_PER_M, ROVER_WHEEL_SPEED_MUL_1 } from '@/shared';
import { deltaS, makePath, nearestS, sampleAt, wrapS, type RailPath } from '../rails/model';

/** The loop path (the `loop: true` flavour of `RailPath`). */
export type RoverPath = RailPath;

/**
 * The 2D plan the layout stage (`generateLayout`) decides — no terrain height yet. R1 fills it and `RoverRoad`
 * builds it into a 3D route. R1 may **add** fields.
 */
export interface RoverPlan {
  /** The dirt road centreline's XZ point list (a closed loop, in route order). */
  points: { x: number; z: number }[];
  /** The stations (in route order). `x`/`z` = the centreline point the vehicle stands at, `poleX`/`poleZ` = the sign pole. */
  stations: { x: number; z: number; poleX: number; poleZ: number }[];
  /* ── Added by R1 (2026-09-13) ── */
  /** The station site's (flattening pad's) radius (m) — the same as `layout.pads`' `station` pad. */
  padRadius: number;
  /** The bucket grid for the corridor distance query (`RoadPlan.roverRouteDistance`). */
  index: RoverRoadIndex;
}

/**
 * The dirt road's stretches bucketed into map grid cells (R1). Each cell holds only the stretch numbers **that can fall
 * within `reach` of it**, so `isSpotFree` never sweeps all hundred-odd stretches however often it asks. At `reach` or beyond, the query returns `reach`.
 */
export interface RoverRoadIndex {
  cell: number;
  cols: number;
  /** The grid origin = `-half` (half the map side). */
  half: number;
  reach: number;
  /** `cz * cols + cx` → the list of stretch start-point numbers (stretch i = points[i] → points[(i+1) % n]). */
  cells: number[][];
}

/** Builds a loop path from a point list (y = the road surface height). */
export function makeRoverPath(pts: THREE.Vector3[]): RoverPath {
  return makePath(pts, true);
}

/** Wraps `s` into [0, total). */
export function wrapRouteS(path: RoverPath, s: number): number {
  return wrapS(path, s);
}

/** The position at arc position `s` (y = the road surface) and the horizontal unit tangent (the +s direction). */
export function sampleRoute(path: RoverPath, s: number, outPos: THREE.Vector3, outTan: THREE.Vector3): void {
  sampleAt(path, s, outPos, outTan);
}

/** The arc position on the path nearest `(x, z)`. */
export function nearestRouteS(path: RoverPath, x: number, z: number): number {
  return nearestS(path, x, z);
}

/** The distance from `from` to `to` going **in the +s direction only**, in [0, total). Used by the empty patrol. */
export function forwardDistance(path: RoverPath, from: number, to: number): number {
  const d = (to - from) % path.total;
  return d < 0 ? d + path.total : d;
}

/** A paid trip: the direction and distance of the shorter way round the loop. On a tie, +1. */
export function shortestTrip(path: RoverPath, from: number, to: number): { dir: 1 | -1; distance: number } {
  const f = forwardDistance(path, from, to);
  const b = path.total - f;
  return f <= b ? { dir: 1, distance: f } : { dir: -1, distance: b };
}

/* ── Added by R2 (2026-09-13) ── */

/** The wrapped shortest difference from `from` to `to` on the loop (its sign = the direction). Used by the client correction. */
export function routeDelta(path: RoverPath, from: number, to: number): number {
  return deltaS(path, from, to);
}

/** The shortest angle turning from `a` to `b` (−π … π]. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

/** Folds an angle into (−π … π]. */
export function wrapAngle(a: number): number {
  return angleDelta(0, a);
}

/**
 * The fare (credits, for everyone aboard) — **the formula's only source** (`RoverRef.fareTo` calls this). It rounds
 * `ROVER_FARE_MIN + distance × ROVER_FARE_PER_M` to the nearest 10 and clamps it to [MIN, MAX]. The server checks only the range (`shared/credits`' `rover:`).
 */
export function roverFareFor(distance: number): number {
  const raw = ROVER_FARE_MIN + Math.max(0, distance) * ROVER_FARE_PER_M;
  return Math.max(ROVER_FARE_MIN, Math.min(ROVER_FARE_MAX, Math.round(raw / 10) * 10));
}

/* ── Added 2026-09-21 (user's decision): hit zones · two turrets · hostility ─────────────────────────────── */

/**
 * The vehicle's **hit zones**, in the one order the wire (`RoverWire.pt`) uses. Never reorder — an older client
 * reading a newer host's array would read the rear turret's hp as a wheel's.
 *
 * `R`/`F` = rear / front along the body's local +X (forward), `L`/`R` after it = the local +Z / −Z flank. One wheel
 * **zone** covers the two physical wheels of that quadrant (the body draws 8 wheels on 4 axles, and the user's spec
 * is 「4 wheels」), so a zone dying blows both of its wheels.
 */
export type RoverPartId = 'wheelRearRight' | 'wheelRearLeft' | 'wheelFrontRight' | 'wheelFrontLeft' | 'turretFront' | 'turretRear';
export const ROVER_PART_ORDER: readonly RoverPartId[] = [
  'wheelRearRight', 'wheelRearLeft', 'wheelFrontRight', 'wheelFrontLeft', 'turretFront', 'turretRear',
];
/** How many of `ROVER_PART_ORDER`'s leading entries are wheel zones (the rest are turrets). */
export const ROVER_WHEEL_ZONES = 4;
/** Index of the two turrets inside `ROVER_PART_ORDER`. */
export const ROVER_TURRET_FRONT_PART = 4;
export const ROVER_TURRET_REAR_PART = 5;

/** The wheel zone a body-local point falls in: front = local +X, left = local +Z. Matches `ROVER_PART_ORDER`. */
export function roverWheelZoneOf(localX: number, localZ: number): number {
  return (localX >= 0 ? 2 : 0) + (localZ >= 0 ? 1 : 0);
}

/**
 * The speed multiplier for `deadWheels` destroyed wheel zones (user's spec): one is 「30 % slower」
 * (`ROVER_WHEEL_SPEED_MUL_1`), two or more and it **cannot move at all**. It stays a rideable platform at 0 — the
 * ride math (`shared/ride.ts`) only ever reads where the body is, never whether it is going anywhere.
 */
export function roverSpeedMulFor(deadWheels: number): number {
  if (deadWheels >= 2) return 0;
  return deadWheels === 1 ? ROVER_WHEEL_SPEED_MUL_1 : 1;
}

/**
 * Client → host: 「a bullet of mine hit the vehicle at `p` for `a` damage」.
 *
 * ⚠ 2026-09-21 — `RoverRequest` in `src/shared/net.ts` is a **closed union** and the rover section there is not this
 * change's to edit, so this one request is cast at the send and the receive edge (`Rover.reportHit` ·
 * `Rover.handleRequest`). The shape below is final; adding
 *   `| { t: 'roverq'; ev: 'hit'; p: Vec3Tuple; a: number }`
 * to `RoverRequest` lets both casts go away with no other change. Everything else about it follows §4.3: the host is
 * the only one that applies it, and it passes shape → sender (a live lobby member) → the point being on the hull →
 * a per-sender rate bucket before anything moves.
 */
export interface RoverHitRequest {
  t: 'roverq';
  ev: 'hit';
  /** The world-space impact point — the host resolves the part from it, so a point off the hull is refused. */
  p: [number, number, number];
  /** The damage that shot dealt. */
  a: number;
}
