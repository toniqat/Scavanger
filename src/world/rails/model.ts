/**
 * src/world/rails/model.ts — the **vocabulary** the rail and tram parts share. No state.
 *
 * The rail's real state is **its arc position `s`, one number** (`TramDef.s`). The path is seed deterministic, so
 * every client computes the same point list, and only `s` · direction · state go over the wire in multiplayer.
 */
import * as THREE from 'three';
import type { TramDef } from '@/shared';
import type { ObstacleEntry } from '../SpatialHash';

/**
 * How high the rail top face floats above the terrain (m). The piers make up that height.
 *
 * 2026-09-10: **1.7 → 0.75** (user's decision — "the rail should float a little above the ground"). This height is
 * within `PROP_STEP_UP_MAX` (0.9), so **it can simply be stepped onto from the ground** — that is the condition for
 * "walkable along the rail". Any higher (the old 1.7) and the deck collider becomes a fence across the map: it can
 * neither be stepped onto (`getSurfaceY`'s step-up limit) nor passed under (it is lower than `obb.BOX_HEADROOM` 2.1).
 */
export const RAIL_DECK_Y = 0.75;
/** Tie spacing (m). 2026-09-10: 3.2 → 1.8 (the wide gaps between ties read as "you would fall through"). */
export const TIE_STEP = 1.8;
/** Pier spacing (m). 2026-09-10: 13 → 9 — so the columns still show here and there on the lowered rail. */
export const PIER_STEP = 9;
/** Half the gauge between the two rails (m). */
export const GAUGE_HALF = 0.9;
/**
 * 2026-09-10 — the collider size of the **walkable rail deck**. Only the piers used to be colliders, so the rail
 * was a picture and people fell straight through between the ties. Thin boxes are chained at a coarser spacing.
 *
 * **5 → 3 (2026-09-10, second batch).** A deck box is flat while the rail is tilted, so the box top face sits at
 * its own centre height and is off by up to `RAIL_DECK_STEP/2 × RAIL_MAX_GRADE` at either end. When that error is
 * **`TRAM_FLOOR_UP` (0.35) or more, the rail deck beside the tram ends up level with the tram floor** and
 * `getStandingObstacle` picks **either of the two, tied**; if the rail deck wins it has no `velocity`, so
 * **riding never starts** (that really happened on seed 1234: the error was exactly 0.35).
 * 5 m gives 0.35, right on the boundary; 3 m gives 0.21 and leaves slack. Never change this to a value that breaks
 * the relation `step/2 × grade < TRAM_FLOOR_UP`.
 */
export const RAIL_DECK_STEP = 3;
/** The deck box thickness (m). It is dug downwards so its top face is level with the rail top face. */
export const RAIL_DECK_T = 0.3;
/** The deck half-width (m) — the same as the tie width. */
export const RAIL_DECK_HALF_W = GAUGE_HALF + 0.25;
/** The steepest grade a lifted rail may open against a neighbouring point (relative to the stretch length). */
export const RAIL_MAX_GRADE = 0.14;
/** The distance at which the tram counts as having "reached" a platform (m, measured along the rail). */
export const DOCK_WINDOW = 4;
/** How often the host broadcasts the tram state (seconds). The path is deterministic, so this is enough. */
export const TRAM_NET_INTERVAL = 0.25;
/** Once a client is further than this (m) from the received `s`, it snaps instead of interpolating. */
export const TRAM_SNAP_M = 8;
/**
 * How far the platform deck centre steps sideways off the rail centreline (m).
 * It is `data/structures.csv`'s `rail_platform.halfD` (4.5) + `tram.halfW` (1.9) plus **0.05 and no more** — the
 * deck's inner edge has to sit almost against the tram's flank so that a docked tram **is boarded on foot with no
 * gap**. Widen this and people fall through that gap (the deck query looks at a single point).
 */
export const PLATFORM_OFFSET = 6.45;

/** The seed-deterministic rail centreline. On a `loop` the last point joins back to the first, a closed ring. */
export interface RailPath {
  pts: THREE.Vector3[];
  /** Cumulative stretch length (`cum[0] = 0`, length = stretch count + 1). */
  cum: number[];
  total: number;
  loop: boolean;
}

/** Builds the cumulative lengths from a point list. */
export function makePath(pts: THREE.Vector3[], loop: boolean): RailPath {
  const segs = loop ? pts.length : pts.length - 1;
  const cum = [0];
  let total = 0;
  for (let i = 0; i < segs; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    total += Math.hypot(b.x - a.x, b.z - a.z);
    cum.push(total);
  }
  return { pts, cum, total, loop };
}

/** Folds `s` into the path range (`loop` wraps, `line` stops at its ends). */
export function wrapS(path: RailPath, s: number): number {
  if (!path.loop) return Math.max(0, Math.min(path.total, s));
  const t = s % path.total;
  return t < 0 ? t + path.total : t;
}

/** The position and tangent at arc position `s`. `outTan` is a normalized XZ (horizontal) direction. */
export function sampleAt(path: RailPath, s: number, outPos: THREE.Vector3, outTan: THREE.Vector3): void {
  const q = wrapS(path, s);
  let lo = 0, hi = path.cum.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (path.cum[mid] <= q) lo = mid; else hi = mid;
  }
  const a = path.pts[lo], b = path.pts[(lo + 1) % path.pts.length];
  const segLen = Math.max(1e-4, path.cum[lo + 1] - path.cum[lo]);
  const t = Math.max(0, Math.min(1, (q - path.cum[lo]) / segLen));
  outPos.set(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
  const dx = b.x - a.x, dz = b.z - a.z;
  const l = Math.hypot(dx, dz) || 1;
  outTan.set(dx / l, 0, dz / l);
}

/** The arc position on the path nearest `(x, z)` (used to attach a platform to the rail). */
export function nearestS(path: RailPath, x: number, z: number): number {
  const segs = path.loop ? path.pts.length : path.pts.length - 1;
  let bestS = 0, bestD = Infinity;
  for (let i = 0; i < segs; i++) {
    const a = path.pts[i], b = path.pts[(i + 1) % path.pts.length];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 1e-6 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len2)) : 0;
    const px = a.x + dx * t, pz = a.z + dz * t;
    const d = (px - x) * (px - x) + (pz - z) * (pz - z);
    if (d < bestD) { bestD = d; bestS = path.cum[i] + Math.sqrt(len2) * t; }
  }
  return bestS;
}

/** On a `loop` the wrapped shortest difference, on a `line` the plain difference. */
export function deltaS(path: RailPath, from: number, to: number): number {
  let d = to - from;
  if (!path.loop) return d;
  const h = path.total / 2;
  while (d > h) d -= path.total;
  while (d < -h) d += path.total;
  return d;
}

/* ══ Tram body (2026-09-10 — rewritten to run long along the travel direction) ══════════════════════
 *
 * **Local axis convention**: `local +X = the travel direction (the car's length)`, `local +Z = sideways (width)`,
 * `local +Y = up`. The rail deck, the ties and the platform deck all use it (`Obstacle.box.yaw` is the math
 * convention, so local +X → world `(cos yaw, sin yaw)` = the rail tangent, and the mesh of that box has Euler `-yaw`).
 *
 * Before 2026-09-10 only the body geometry broke this convention — `structures.csv`'s `halfW` (1.9, half **width**)
 * went into local X and `halfD` (6, half **length**) into local Z, hanging **a 12 m plank across the rail**.
 * The sizes were left alone and only the axes corrected (`PLATFORM_OFFSET` was already using `halfW` as the
 * sideways step-off distance, so this was what the csv meant all along).
 *
 * **2026-09-18 (user's decision) — the body orientation is fixed for the whole raid.** `TramDef.yaw` follows the
 * **rail tangent only** and does not look at `dir` (`parts/Tram.placeTram`): forwards one way, backwards on the way
 * back, always facing the same way at every platform. It used to add 180° when `dir < 0`, which **flipped the body
 * in place**, and since a rider re-solves its spot in vehicle-local coordinates every frame (`shared/ride`) it
 * teleported to the other side of the car the moment it departed. That is also why the cab and console are at
 * **each end** — on a car that turns around one end is always the front; on one that does not it is the tail for half of every run.
 */
/** How high the tram floor floats above the rail top face (m). The platform deck top matches it, so people just walk across. */
export const TRAM_FLOOR_UP = 0.35;
/** The doorway half-length (m, **along travel**). The middle of both side panels is left open (on a line rail the platform comes to the other side). */
export const TRAM_DOOR_HALF = 1.4;
/** The floor plate thickness (m). This box's **top face is the walkable deck** and the reference plane for the ride judgement. */
export const TRAM_FLOOR_T = 0.3;
/** The side panel thickness (m). */
export const TRAM_WALL_T = 0.24;
/** The side panel height (m) — waist high. The top has to be open or the third-person camera gets trapped (an open car). */
export const TRAM_WALL_H = 1.05;
/** The front bulkhead (nose) thickness (m). It closes the body's front end, and the cab is behind it. */
export const TRAM_NOSE_T = 0.3;
/** The cab length (m, along travel) — this much behind the bulkhead is space people **walk into**. */
export const TRAM_CAB_LEN = 2.2;
/** The driving console desk: half-length · half-width · height (m). It stands with its back to the bulkhead. */
export const TRAM_DESK_HALF_L = 0.3;
export const TRAM_DESK_HALF_W = 0.85;
export const TRAM_DESK_H = 1.05;

/** One collider piece moving with the body. The offsets are **local** (`ox` = along the length, `oz` = along the width). */
export interface MovingPart {
  entry: ObstacleEntry;
  ox: number; oz: number;
  /** The box bottom face's y offset (relative to the tram floor). */
  oy: number;
}

/** One tram's live state. `Rails` holds exactly one and `rails/parts/Tram` runs it. */
export interface TramInst {
  def: TramDef;
  root: THREE.Group;
  parts: MovingPart[];
  /** Every deck collider references **the same object** — fixing it in place changes all of them at once. */
  vel: THREE.Vector3;
  /**
   * 2026-09-18 (user's decision) — **there are no cabin containers.** The tram is transport and the farming spot
   * is the platform (`parts/Platform`'s containers are unchanged). A moving container means reviving the whole
   * `ContainerSpec.dynamic` branch, so start here when putting them back (`ContainerSet` already knows dynamic).
   *
   * The two **live** cab console positions (`Interactable.position` is exactly these objects).
   * Index 0 = the local +X end, 1 = the local −X end — the body never turns, so **either end starts it**.
   */
  consolePos: THREE.Vector3[];
  /** The body half-length · half-width · wall height (m) — the hit judgement reads them every frame. */
  halfLen: number; halfWid: number; wallH: number;
  dockTimer: number;
  /**
   * 2026-09-10 — the time (seconds) since this run began. It is set to `-TRAM_START_DELAY_S` the moment the departure
   * notice appears, so **while it is negative the tram stands**; past 0 it rises to `TRAM_SPEED` over `TRAM_ACCEL_S`
   * by a cubic ease-in. Clients run the same value — the position is corrected by the host's `s`, but the deck velocity (`vel`) is their own.
   */
  runT: number;
  lastDock: string | null;
  /** The host's `s` a client converges to (unused on the host). */
  targetS: number;
  /**
   * 2026-09-11 (C-18): the hit cooldown **per target** — key (`local` · `e:<enemy id>` · `g:<PeerId>`) → the `ctx.time`
   * at which it can be hit again. The old one number per tram let every other body beside it pass through for `TRAM_HIT_COOLDOWN_S` once one was hit.
   */
  hitUntil: Map<string, number>;
}

/* ── Colours · build sink (2026-09-10, the `parts/` split) ──────────────────────────────────────────
 * `Rails` disposes the merged geometries and materials itself, so a part hands back what it made **by putting it
 * here**. It uses values (THREE.Color), but this module is not on the axis `data-check` reads early
 * (`structures/model` · `hazard/model`), so that is not a problem.
 */
export const STEEL = new THREE.Color(0x6a6f76);
export const STEEL_DARK = new THREE.Color(0x33383e);
export const TIE_COLOR = new THREE.Color(0x4a423a);
export const DECK = new THREE.Color(0x6d6a63);
export const DECK_DARK = new THREE.Color(0x45433e);
/** The cab glass · the console screen. */
export const GLASS = new THREE.Color(0x1b3742);
export const SCREEN = new THREE.Color(0x2f8ea8);
/**
 * The platform call console's **glow** colour (2026-09-10). This colour alone is drawn with a separate emissive
 * material — the rail body is a single vertex-colour pass, so the screen did not glow and did not read as "a thing you operate".
 */
export const CONSOLE_GLOW = new THREE.Color(0x59d8ff);
/** That material's (nearly black) diffuse colour — the same pattern other folders' glowing objects use. */
export const CONSOLE_GLOW_BASE = new THREE.Color(0x0a1c22);

/** Where what a part built is handed over. `Rails.dispose` throws away everything put in here. */
export interface RailBuild {
  geos: THREE.BufferGeometry[];
  group: THREE.Group;
  mat: THREE.MeshStandardMaterial;
  /**
   * The glow pieces (the call console's screen · band · buttons). A part puts **world-space geometry only** in
   * here, and once every platform is up `Rails.build` merges it into **one lump**, a single emissive mesh.
   * A moving object's glow (the tram's) never goes in here — the merged mesh stays where it is.
   */
  glow: THREE.BufferGeometry[];
}
