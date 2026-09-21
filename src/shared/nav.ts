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
 *
 * **Phase 2 (2026-09-21) — many bodies, one goal.** Sixty enemies chasing one player must not run sixty searches, so a
 * chase reads a **flow field** instead (`NavRef.flowTo`): one Dijkstra outward from the goal over `NAV_FLOW_RADIUS_M`,
 * built over a few frames and shared by every body with the same `can` mask. A **private** goal (a bug walking home,
 * a gunner's cover spot) still uses `findPath`. Narrow passages are published as **gates** (`NavRef.gates`): the
 * movers' owner lets `NAV_GATE_CAPACITY` bodies through one at a time and reports the queue (`setGateLoad`), which the
 * next field build turns into cost so the rest spread to another door or a window. A special link is **performed**, not
 * walked — the body leaves the colliders for it (`NavFlowStep.from → via → to`), like a person on a ladder.
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
  /**
   * appended (phase 2) — `'climb'` · `'window'` only: the point the body passes on the way from the previous waypoint
   * to this one. `'climb'`: the top of the wall face right above the start (go straight up to it, then across).
   * `'window'`: the middle of the opening at sill height. Untouched (stale) for every other kind.
   */
  readonly via: THREE.Vector3;
  /** appended (phase 2) — `'window'` only: the pane in the way (`NavRef.windowWhole` · `breakWindow`), else null. */
  windowId: string | null;
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

  /* ── appended (phase 2, 2026-09-21): flow fields · gates · windows ─────────────────────────────────────────── */

  /**
   * The flow field toward a **moving goal many bodies share** (a player, an android). `key` names the goal (one field
   * per `key` + `can`); call it **every time you are about to sample** — the call is what moves the goal and keeps the
   * field alive (one nobody asked for within `NAV_FLOW_IDLE_S` is dropped). A field is rebuilt when its goal moved
   * `NAV_FLOW_REBUILD_M`, when the graph's `revision` changed or when gate loads changed, never more often than
   * `NAV_FLOW_MIN_REBUILD_S`, within `NAV_FLOW_BUDGET_MS` a frame; the last finished build keeps answering meanwhile.
   * Null when the graph is not ready or all `NAV_FLOW_MAX_FIELDS` are in use — steer as before.
   */
  flowTo(key: string, goal: THREE.Vector3, can: number): NavFlow | null;
  /** A new, reusable step buffer for `NavFlow.sample`. */
  createFlowStep(): NavFlowStep;
  /** The raid's chokepoints, fixed once `ready` (index = `NavGate.id`). Empty before. */
  readonly gates: readonly NavGate[];
  /**
   * The movers' owner reports how many bodies are **waiting outside** gate `gate`. Each one adds
   * `NAV_GATE_LOAD_COST_M` to crossing it in the next field build. Report 0 when the queue is gone.
   */
  setGateLoad(gate: number, waiting: number): void;
  /** Is the pane `windowId` (`NavFlowStep.windowId` · `NavWaypoint.windowId`) still whole? False for an unknown id. */
  windowWhole(windowId: string): boolean;
  /**
   * Breaks the pane for everyone — the same path a bullet takes (sound, shards, `struct glass` on the wire). Authority
   * only; a no-op when it is already broken.
   */
  breakWindow(windowId: string): void;
}

/** A narrow passage (a doorway, a stair flight, a corridor) — a connected patch of cells `NAV_GATE_MAX_SPAN_M` wide or less. */
export interface NavGate {
  readonly id: number;
  /** The middle of the patch (y = its floor). */
  readonly position: THREE.Vector3;
}

/**
 * What a body standing at `from` should do next on a flow field — filled by `NavFlow.sample`.
 *
 * `kind === 'walk'`: steer at `aim` (a point `NAV_FLOW_LOOKAHEAD_M` down the field, never past a special link's start).
 * Any other kind: the body **stands at the start of a special link** (within `NAV_LINK_START_M`) and performs it:
 * `from` → `via` → `to`, ignoring colliders. `'ladder'`: `ladderId` is set and `via` is unused. `'climb'`: `via` is the
 * top of the wall face above `from`. `'window'`: `via` is the middle of the opening at sill height and `windowId` the
 * pane — break it first when `NavRef.windowWhole` says so.
 */
export interface NavFlowStep {
  readonly aim: THREE.Vector3;
  kind: NavLinkKind;
  readonly from: THREE.Vector3;
  readonly via: THREE.Vector3;
  readonly to: THREE.Vector3;
  ladderId: string | null;
  windowId: string | null;
  /** The first gate the next `NAV_GATE_LOOK_M` of the way crosses (or the one the body stands in), -1 with none. */
  gate: number;
  /** Metres along the field to that gate's first cell (0 when standing in it). Meaningless while `gate` is -1. */
  gateDist: number;
  /** Metres left along the field to the goal. */
  dist: number;
}

/** One goal's flow field (`NavRef.flowTo`). The object is the graph's — never keep it across frames, ask again. */
export interface NavFlow {
  /** A finished build exists. The first one takes a few frames. */
  readonly ready: boolean;
  /**
   * Fills `out` for a body at `from`. False = the field has no answer here (not built yet, farther than
   * `NAV_FLOW_RADIUS_M`, unreachable with this mask, or already within `NAV_FLOW_ARRIVE_M` of the goal) — steer as before.
   */
  sample(from: THREE.Vector3, out: NavFlowStep): boolean;
}

/** `data/enemies.csv` `nav` cell → `NAV_CAN` mask: tokens joined by `+` (`indoor+ladder`), empty or `none` = 0. Null = a bad token. */
export const NAV_CAN_TOKENS: Readonly<Record<string, number>> = {
  indoor: NAV_CAN.INDOOR, ladder: NAV_CAN.LADDER, climb: NAV_CAN.CLIMB, window: NAV_CAN.WINDOW,
};
export function parseNavCan(cell: string): number | null {
  const text = cell.trim().toLowerCase();
  if (text === '' || text === 'none') return 0;
  let mask = 0;
  for (const tok of text.split('+')) {
    const bit = NAV_CAN_TOKENS[tok.trim()];
    if (bit === undefined) return null;
    mask |= bit;
  }
  return mask;
}
