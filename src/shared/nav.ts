/**
 * src/shared/nav.ts — **shared pathfinding** (TODO A-18, 2026-09-21, user's decision 「안드로이드뿐 아니라 적에게도」).
 *
 * `world/` bakes the walkable graph of a raid and publishes it as `WorldRef.nav`; any authority-side mover asks it for
 * a way round a wall. Nothing about a path goes on the wire — only the authority (solo · lobby host) moves the bodies
 * that use it, and every client bakes the same graph from the same seed, so a host change finds it ready.
 *
 * The shape of the graph (owner: `world/nav/`):
 *  - **outdoors** a world-aligned grid of `NAV_CELL_M` cells, one node per cell at the walkable surface there;
 *  - **every structure** its own grid aligned to the building's axes at `NAV_STRUCT_CELL_M`, with one node per floor
 *    level that is standable at that column (basement · ground floor · floor 2 · roof). Stairs need no special case —
 *    they are ramps (`Obstacle.ramp`), so the cells up a flight differ by less than a step and link like any floor;
 *  - **links** that are not a step between neighbouring cells: a ladder (`'ladder'`), and — from phase 2 — a small bug
 *    climbing a wall (`'climb'`) or crawling through a window (`'window'`). Which of them a body may take is the
 *    `can` mask of the query (`NAV_CAN`).
 *
 * A mover never *has* to use this: a straight line that is walkable (`NavRef.walkable`) keeps the steering it always
 * had, and a query that finds nothing (`'none'`) or runs before the bake finished (`'pending'`) means 「steer as
 * before」. The graph only ever adds a way round; it never takes the old behaviour away.
 */
import type * as THREE from 'three';

/**
 * How a waypoint is reached **from the previous one**. `'walk'` is ordinary movement on the floor; the rest are the
 * special links a body must be able to take (`NAV_CAN`).
 */
export type NavLinkKind = 'walk' | 'ladder' | 'climb' | 'window';

/**
 * What the querying body can do — bits of `NavRef.findPath`'s `can`. A link whose bit is missing is never taken, and a
 * body without `INDOOR` never enters a structure's grid at all (a giant bug would path through a doorway it cannot fit).
 */
export const NAV_CAN = {
  /** Climbs a ladder (people, androids, humanoid enemies). */
  LADDER: 1,
  /** Climbs a building's outer wall onto its roof (small bugs only — 2026-09-21 user's decision; phase 2). */
  CLIMB: 2,
  /** Crawls through a window, breaking the pane first if it is whole (small bugs only; phase 2). */
  WINDOW: 4,
  /** Fits through a doorway and walks a structure's floors. */
  INDOOR: 8,
} as const;

/** A person's (and an android's) mask: ladders and interiors, no wall climbing. */
export const NAV_CAN_PERSON = NAV_CAN.LADDER | NAV_CAN.INDOOR;

/** One point of a path. `position.y` is the walkable surface there (the feet). */
export interface NavWaypoint {
  readonly position: THREE.Vector3;
  /** How this point is reached from the previous one. */
  kind: NavLinkKind;
  /** `'ladder'` only: the `LadderDef.id` climbed to get here (the previous point is its foot or its exit). */
  ladderId: string | null;
}

/**
 * `ok` = the path reaches the goal · `partial` = the search budget ran out, the path ends at the node nearest the goal
 * it found · `none` = the goal is not reachable from here (a locked room, another island) · `pending` = the graph is
 * not baked yet. `none` and `pending` leave `points` empty.
 */
export type NavPathStatus = 'ok' | 'partial' | 'none' | 'pending';

/**
 * A reusable path buffer — made once by `NavRef.createPath()` and handed to `findPath` again and again, so a replan
 * allocates nothing. Only `points[0 .. count-1]` are valid; `points[0]` is the first point **after** the start.
 */
export interface NavPath {
  status: NavPathStatus;
  readonly points: NavWaypoint[];
  count: number;
}

/** `WorldRef.nav` (owner: world/nav). Null outside a planet raid (training range · tutorial · the ship). */
export interface NavRef {
  /** The bake finished. Until then `findPath` answers `pending` and `walkable` answers true (steer as before). */
  readonly ready: boolean;
  /**
   * Bumped every time a re-measured cell changed its answer (a door opened, a barricade went up, the tram moved on).
   * A mover that cached a path may compare it to decide to plan again.
   */
  readonly revision: number;
  /** A new, empty path buffer. */
  createPath(): NavPath;
  /**
   * Plans from `from` to `to` for a body that can do `can` (`NAV_CAN` bits) and writes the result into `out`
   * (smoothed: straight stretches collapse to their ends). Both ends are snapped to the nearest walkable node within
   * `NAV_SNAP_M` at the height closest to the given `y`, so a goal inside a crate's collider still resolves to the
   * floor in front of it. Returns `out.status`.
   */
  findPath(from: THREE.Vector3, to: THREE.Vector3, can: number, out: NavPath): NavPathStatus;
  /**
   * Can a body walk the straight segment `from → to` on the floor it stands on? Samples the graph along the line
   * (walkable cells, no step higher than a step) and the floor it ends on must be the goal's (within one storey of
   * `to.y` — a goal right above on floor 2 is not reached by walking straight on floor 1). Cheap enough to call
   * before every replan.
   */
  walkable(from: THREE.Vector3, to: THREE.Vector3): boolean;
}
