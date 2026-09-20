/**
 * src/world/structures/parts/Build.ts — the **geometry and colliders** of the abandoned structures.
 *
 * A bundle of methods split out of the `Structures` class; it holds no state. All it builds is
 * ① geometry pieces for merging, ② the **box (OBB) · ramp colliders** that go into `SpatialHash`, and ③ the spots
 * (world coordinates) where containers · consoles · doors · ladders · windows · lights stand.
 *
 * It keeps two conventions:
 *  - **The collider is the drawn silhouette.** One wall = one box, sized with the same numbers as the drawn
 *    `BoxGeometry`.
 *  - **Rotation convention**: `Obstacle.box.yaw` is the math convention (local +X → world `(cos, sin)`), and the Euler
 *    of the mesh drawing that same box is `-yaw`, its sign flipped (three's Y rotation is the other hand).
 *
 * ## 2026-09-11 — buildings with a ceiling (5 user requests)
 * The "collapsed roof" of 2026-09-09 is gone. Outposts · labs now have
 *  - **a ceiling on every level** (ceiling height = `wallH` = two PCs). The floor plate between levels = the lower
 *    level's ceiling, and the topmost one is the **roof**.
 *  - a **second floor** at random (`upperChance`). Floor 1 → 2 is an **indoor staircase**; the top level → the roof is
 *    a **ladder** on the partition plus a hatch hole in the roof (a single-storey building has a roof too).
 *  - **the map scanner always on the roof**.
 *  - **windows** at random spots on the outer walls of each level (`parts/Glass` — broken by bullets · throwables).
 *  - a ceiling light in every room holding a container (an emissive plate + a light spot `LightFixture`).
 *  - **a basement** that is a room, not a dirt pit: floor plate · walls · ceiling · lighting. The way in is the stair
 *    hole in the floor-1 plate → a **stair corridor** walled on both sides → the landing → a **standing door**
 *    (keycard). The old floor hatch is gone.
 *  - stairs that are all **ramp colliders** (`parts/Stairs`) — no popping up one step at a time.
 *
 * ## 2026-09-12 — the spots people move through are cleared first (4 user reports)
 *  ① The floor 1 → 2 stair entry was a 0.8 m gap (a body's diameter is 0.9 m), so **it could not be entered from
 *     floor 1** → the landing is `STAIR_LANDING` 1.6 m, and the floor-1 room-side wall is gone (the stair solid is
 *     itself closed all the way down, so no wall is needed — and the stairs are visible from the room).
 *  ② A collapsed breach opening in the outer wall the stairs lean on left the stairs open **only outwards** → a breach
 *     avoids the stair solid · the landing. Windows avoid the stair stretch on every level too.
 *  ③ The railing of the basement stair hole blocked the space **right in front of** the front door · the partition
 *     passage → every opening gets an approach (`OPENING_APPROACH`) and the hole + railing do not pick a spot
 *     overlapping it. The partition passage is picked **after** the hole's spot, avoiding what is in front of it.
 *  ④ Invisible walls: the indoor workbench · pallet were a 0.7 m cylinder (under a 2.6 m long rotated box) → now the
 *     box as drawn. The crash-landed ship's nose · wings · ramp · engines had no collider or a different one → they
 *     are measured from the drawn mesh (`fitBox` · `propHullOf`).
 * The order the rng is used in changed, so the **inside** layout of a building on the same seed differs from
 * 2026-09-11 (the site · size · level count · whether there is a basement are `layout.ts` and are unchanged).
 * Reachability is measured over several seeds by `scripts/smoke-structure-reach.mjs`.
 *
 * ## 2026-09-12 — the lab's locked room · the ground-drone vent (the consumable master key)
 *  - A lab has no basement. In **a lab that got a second floor** a **locked room** (two outer wall faces + two inner
 *    wall faces) is built in one floor-2 corner — avoiding the stair hole · the arrival spot · the ladder/hatch area ·
 *    the partition passage approach, and keeping its own door approach (`OPENING_APPROACH`) clear. The spot is picked
 *    with a dedicated rng (`plan.lockRng`), so it does not shift the building's own draw stream. With no spot there is
 *    no room.
 *  - **A vent at the bottom of the wall right beside** a locked door (the basement door · the locked room door): a gap
 *    between wall segments + a lintel (bottom face = floor + `VENT_H`). People · enemies are pushed out by the lintel
 *    and only a ground drone, which passes a height, gets through (`WorldRef.resolveCollision(p, r, height)`). The
 *    basement's is cut into the **corridor side wall** along the landing stretch in front of the door (corridor ↔ the
 *    basement room), the locked room's into the **door wall**. It stays even after the door opens.
 *
 * A third-person camera getting stuck in a ceiling needs no special case — `player/CameraRig` already pulls it in with
 * `world.raycast`.
 */
import * as THREE from 'three';
import { PLAYER_RADIUS, type LightFixture, type Random } from '@/shared';
import { type BuildCtx, merge, paint, paintGradient, xform } from '../../build';
import { propHullOf } from '../../propHull';
import {
  BASEMENT_FLOOR_T, BASEMENT_HALL_HALF, BASEMENT_LANDING, DOOR_H, DOOR_W, FLOOR_LIP, FLOOR_OVERHANG, HATCH_D, HATCH_W,
  LADDER_STANDOFF, LOCKED_DOOR_W, LOCKED_ROOM_DEPTH, LOCKED_ROOM_LEN, OPENING_APPROACH, PARAPET_H, RAIL_H, RAIL_T, SLAB_T,
  STAIR_ARRIVAL, STAIR_LANDING, STAIR_SLOPE, STAIR_W, VENT_H, VENT_MARGIN, VENT_POST, VENT_W,
  WALL_T, WINDOW_SILL, WINDOW_TOP, WINDOW_W,
} from '../model';
import { CONTAINER_REACH } from './Containers';
import type { WindowSpec } from './Glass';
import { buildStairFlight } from './Stairs';

/** The site information one structure needs to be built (carried over from `layout.StructureSite`). */
export interface BuildingPlan {
  cx: number; cz: number; yaw: number;
  /** Ground level floor height (the pad's height). */
  y0: number;
  halfW: number; halfD: number;
  /** A level's ceiling height (m). */
  wallH: number;
  pit: { halfX: number; halfZ: number; depth: number } | null;
  /** Ground level count (1 · 2). It drops to 1 when there is no room for the stairs. */
  floors: number;
  /** Ground · basement container counts. Lighting hangs **only in rooms holding a container**, so picking the spots finishes here. */
  containers: number;
  basementContainers: number;
  /** 2026-09-12: container count of the floor-2 locked room (0 = the room is not built).
   * The room only stands when a second floor actually went up. */
  lockedContainers: number;
  /** An rng for picking the locked room's spot only (taken separately so the building's own stream is not
   * shifted). With none the room is not built. */
  lockRng: Random | null;
}

/** A spot something stands at — world coordinates + the direction it faces away from the wall (math-convention yaw). */
export interface Spot { x: number; y: number; z: number; yaw: number }

/** One ladder (a `LadderDef` with only the id missing). */
export interface LadderSpot {
  base: { x: number; y: number; z: number };
  topY: number;
  normal: { x: number; z: number };
  exit: { x: number; y: number; z: number };
}

/** The basement's standing door. The panel · collider · animation are built by `Structures`. */
export interface DoorSpot {
  /** Middle of the panel's bottom edge. */
  x: number; y: number; z: number;
  /** The direction the panel extends along (math convention). */
  yaw: number;
  halfW: number;
  height: number;
  thick: number;
  /** The world displacement the panel moves by when it opens. */
  slideX: number; slideZ: number;
  /** The card reader (it sits on the corridor wall) — its spot and the direction it faces the corridor. */
  reader: { x: number; z: number; yaw: number };
  /** The interaction spot (the landing, y = the basement floor). */
  interact: { x: number; y: number; z: number };
}

/**
 * 2026-09-21 — where a **ceiling turret** hangs, and the room it watches (`parts/Turret`). One per locked space:
 * the outpost basement and the lab's floor-2 locked room. `room` is a world OBB — the turret never takes a target
 * outside it, which is what 「it does not follow anyone out of the room」 means. The mount point is on the ceiling,
 * so `y` is the ceiling's underside.
 */
export interface TurretSpot {
  /** Ceiling mount point (world). */
  x: number; y: number; z: number;
  /** The watched room, as a world OBB (`yaw` = the math convention, the same as `Obstacle.box.yaw`). */
  room: { x: number; z: number; halfX: number; halfZ: number; yaw: number; yBottom: number; yTop: number };
}

/**
 * 2026-09-12 — the building **nav**: only reach smokes · debug read it (world checks never look at it).
 * `[lx, lz]` is in building-local coordinates; in world it is `(cx + lx·cos − lz·sin, cz + lx·sin + lz·cos)`.
 */
export interface StructureNav {
  cx: number; cz: number; yaw: number; halfW: number; halfD: number;
  /** Ground level floor heights (`levels[k]`, k = 0 · 1). */
  levels: number[];
  /** One step outside · one step inside the front door (the rear ramp for a crash-landed ship). */
  doorOut: [number, number];
  doorIn: [number, number];
  /** The room rectangles (level `k`) — the unit reachable walkable cells are measured over. Empty for a crash-landed ship. */
  rooms: { k: number; x0: number; x1: number; z0: number; z1: number }[];
  /** The floor-1 stair landing · the floor-2 arrival spot (two-storey buildings only). */
  stairBottom: [number, number] | null;
  stairTop: [number, number] | null;
  /** The collapsed breach (null with none) — side 0 north · 1 west · 2 east, `c` = its middle along the wall. */
  breach: { side: number; c: number } | null;
  /** 2026-09-12: the inner rectangle of the floor-2 locked room (level `k`), null with none. The cells a person must not reach while it is locked. */
  locked: { k: number; x0: number; x1: number; z0: number; z1: number } | null;
  /** 2026-09-12: per ground-drone vent, one step on the door side (`out`) · the room side (`in`) and the floor height `y`. */
  vents: { out: [number, number]; in: [number, number]; y: number }[];
}

export interface BuildingOut {
  parts: THREE.BufferGeometry[];
  glow: THREE.BufferGeometry[];
  containers: Spot[];
  basementContainers: Spot[];
  /** The map scanner's spot (the roof). null for a crash-landed ship. */
  console: Spot | null;
  /** The basement door (null with no basement). */
  door: DoorSpot | null;
  /** 2026-09-12: the floor-2 locked room door (null with no room) · that room's container spots.
   * It never stands together with a basement door in one building. */
  lockedDoor: DoorSpot | null;
  lockedContainers: Spot[];
  /** 2026-09-21: the ceiling turrets inside the locked spaces (empty when the building has none). */
  turrets: TurretSpot[];
  /** The basement floor height (y0 with no basement). */
  basementY: number;
  ladders: LadderSpot[];
  windows: WindowSpec[];
  fixtures: LightFixture[];
  /** The ground level count actually built. */
  floors: number;
  /** The roof floor height (NaN with none). */
  roofY: number;
  nav: StructureNav;
}

const CONCRETE = new THREE.Color(0x7a7770);
const CONCRETE_DARK = new THREE.Color(0x4a4844);
const CEILING = new THREE.Color(0x5b5954);
const METAL = new THREE.Color(0x424750);
const METAL_DARK = new THREE.Color(0x24272c);
const RUST = new THREE.Color(0x6d4a30);

/** Room light colour · intensity · reach (drawing values — not balance numbers). */
const LIGHT_WARM = 0xffd9a8;
const LIGHT_COOL = 0xd2ecff;
const LIGHT_INTENSITY = 16;
const LIGHT_DISTANCE = 12;

/** Width · height (m) of the collapsed breach in the floor-1 outer wall. */
const BREACH_W = 3.2;
const BREACH_H = 2.9;

/** A local rectangle (building coordinates). */
interface Rect { x0: number; x1: number; z0: number; z1: number }
const rect = (xa: number, xb: number, za: number, zb: number): Rect =>
  ({ x0: Math.min(xa, xb), x1: Math.max(xa, xb), z0: Math.min(za, zb), z1: Math.max(za, zb) });
const grow = (r: Rect, m: number): Rect => ({ x0: r.x0 - m, x1: r.x1 + m, z0: r.z0 - m, z1: r.z1 + m });
const inRect = (r: Rect, x: number, z: number): boolean => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1;
const overlaps = (a: Rect, b: Rect): boolean => a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0;

/** An opening in a wall (door · window · collapsed breach). `y0`/`y1` are measured from the level's floor. */
interface Opening { c: number; w: number; y0: number; y1: number }

/**
 * 2026-09-12 — measures geometry that is **already in world space** as a box aligned to the `frameYaw` axis (math
 * convention, local +X = `(cos, sin)`). Instead of hand-fitting a collider to a tilted or rolled mesh (the
 * crash-landed ship's side plates · engines), it is taken straight from the drawn vertices.
 */
function fitBox(g: THREE.BufferGeometry, frameYaw: number): { x: number; z: number; halfX: number; halfZ: number; yMin: number; yMax: number } {
  const pos = g.getAttribute('position');
  const c = Math.cos(frameYaw), s = Math.sin(frameYaw);
  let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const a = x * c + z * s, b = -x * s + z * c;
    if (a < aMin) aMin = a; if (a > aMax) aMax = a;
    if (b < bMin) bMin = b; if (b > bMax) bMax = b;
    if (y < yMin) yMin = y; if (y > yMax) yMax = y;
  }
  const am = (aMin + aMax) / 2, bm = (bMin + bMax) / 2;
  return { x: am * c - bm * s, z: am * s + bm * c, halfX: (aMax - aMin) / 2, halfZ: (bMax - bMin) / 2, yMin, yMax };
}

/**
 * One above-ground building (outpost · lab).
 */
export function buildBuilding(ctx: BuildCtx, plan: BuildingPlan, rng: Random, lab: boolean): BuildingOut {
  const { cx, cz, yaw, y0, halfW, halfD } = plan;
  const H = plan.wallH;
  const parts: THREE.BufferGeometry[] = [];
  const glow: THREE.BufferGeometry[] = [];
  const windows: WindowSpec[] = [];
  const fixtures: LightFixture[] = [];
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  const rot = (lx: number, lz: number): [number, number] => [cx + lx * cos - lz * sin, cz + lx * sin + lz * cos];
  const dirW = (dx: number, dz: number): [number, number] => [dx * cos - dz * sin, dx * sin + dz * cos];
  const iw = halfW - WALL_T / 2, id = halfD - WALL_T / 2;          // the walls' inner faces
  const pit = plan.pit;
  const lightColor = lab ? LIGHT_COOL : LIGHT_WARM;

  /* ── Drawing · collider helpers ────────────────────────────────────────── */
  /** One box: centred at local (lx, lz); with `alongZ` its long side runs along local Z.
   * Colour is a gradient over the height range [gy0, gy1]. */
  const solid = (
    lx: number, lz: number, halfLen: number, halfThick: number, yBot: number, h: number, alongZ: boolean,
    kind: string | null, dark = CONCRETE_DARK, light = CONCRETE, gy0 = yBot, gy1 = yBot + h,
  ): void => {
    if (halfLen <= 0.02 || h <= 0.02) return;
    const [wx, wz] = rot(lx, lz);
    const byaw = yaw + (alongZ ? Math.PI / 2 : 0);
    const g = new THREE.BoxGeometry(halfLen * 2, h, halfThick * 2);
    xform(g, { x: wx, y: yBot + h / 2, z: wz }, new THREE.Euler(0, -byaw, 0));
    paintGradient(g, dark, light, gy0, gy1);
    parts.push(g);
    if (kind) ctx.hash.addBox(new THREE.Vector3(wx, yBot, wz), halfLen, halfThick, byaw, h, kind);
  };

  /**
   * One floor plate piece — **the plate drawn and the plate stood on are the same** (2026-09-10). The collider's top
   * face is exactly `yTop` and its bottom face `yTop − SLAB_T`, so from the level below it is simply the ceiling.
   * `lip` raises only the drawn top face, to avoid z-fighting with the terrain.
   */
  const plate = (x0: number, x1: number, z0: number, z1: number, yTop: number, lip: number, color: THREE.Color): void => {
    if (x1 - x0 < 0.2 || z1 - z0 < 0.2) return;
    const hx = (x1 - x0) / 2, hz = (z1 - z0) / 2;
    const [wx, wz] = rot((x0 + x1) / 2, (z0 + z1) / 2);
    const g = new THREE.BoxGeometry(hx * 2, SLAB_T, hz * 2);
    xform(g, { x: wx, y: yTop + lip - SLAB_T / 2, z: wz }, new THREE.Euler(0, -yaw, 0));
    paintGradient(g, CEILING, color, yTop - SLAB_T, yTop);
    parts.push(g);
    ctx.hash.addBox(new THREE.Vector3(wx, yTop - SLAB_T, wz), hx, hz, yaw, SLAB_T, 'slab');
  };
  /** A floor plate with one hole cut in it (four pieces). */
  const slab = (fx: number, fz: number, yTop: number, lip: number, color: THREE.Color, hole: Rect | null): void => {
    if (!hole) { plate(-fx, fx, -fz, fz, yTop, lip, color); return; }
    plate(-fx, fx, -fz, hole.z0, yTop, lip, color);
    plate(-fx, fx, hole.z1, fz, yTop, lip, color);
    plate(-fx, hole.x0, hole.z0, hole.z1, yTop, lip, color);
    plate(hole.x1, fx, hole.z0, hole.z1, yTop, lip, color);
  };

  /** Stands a wall along one side, leaving the openings out — above and below an opening
   * (the lintel · the sill) is wall too (there is a ceiling now). */
  const wallRun = (alongZ: boolean, fixed: number, from: number, to: number, yBase: number, h: number, ops: Opening[]): void => {
    const cuts = ops.slice().sort((a, b) => a.c - b.c);
    let s = from;
    const seg = (a: number, b: number, yb: number, hh: number): void => {
      if (b - a < 0.05 || hh < 0.03) return;
      const mid = (a + b) / 2, hl = (b - a) / 2;
      if (alongZ) solid(fixed, mid, hl, WALL_T / 2, yb, hh, true, 'building', CONCRETE_DARK, CONCRETE, yBase, yBase + h);
      else solid(mid, fixed, hl, WALL_T / 2, yb, hh, false, 'building', CONCRETE_DARK, CONCRETE, yBase, yBase + h);
    };
    for (const op of cuts) {
      const g0 = Math.max(from, op.c - op.w / 2), g1 = Math.min(to, op.c + op.w / 2);
      if (g1 <= s) continue;
      if (g0 > s) seg(s, g0, yBase, h);
      const a = Math.max(s, g0);
      seg(a, g1, yBase, op.y0);
      seg(a, g1, yBase + op.y1, h - op.y1);
      s = g1;
    }
    seg(s, to, yBase, h);
  };

  /** 2026-09-12: per ground-drone vent, one step on the door side · the room side (the reach smoke
   * tries to pass with a drone body · a person's body). */
  const vents: StructureNav['vents'] = [];
  /**
   * 2026-09-12 — the vent's **drawing**: the frame (a head piece + two posts) + a louvred cover swung up toward the
   * room. It has no collider — what blocks is the wall segments and the lintel only. `c` is its middle along the wall,
   * `thick` the wall thickness, and `toward` the sign of the side the cover swings to (the building axis perpendicular
   * to the wall — Z for a wall running along X, X for a wall running along Z). The cover's lower edge lifts higher
   * than the drone's height.
   */
  const ventDecor = (alongZ: boolean, fixed: number, c: number, yBase: number, thick: number, toward: number): void => {
    const at = (along: number): [number, number] => (alongZ ? [fixed, along] : [along, fixed]);
    {
      const [tx, tz] = at(c);
      solid(tx, tz, VENT_W / 2 + 0.07, thick / 2 + 0.04, yBase + VENT_H, 0.07, alongZ, null, METAL_DARK, METAL);
    }
    for (const s of [-1, 1]) {
      const [px, pz] = at(c + s * (VENT_W / 2 + 0.035));
      solid(px, pz, 0.035, thick / 2 + 0.04, yBase, VENT_H, alongZ, null, METAL_DARK, METAL);
    }
    const fh = VENT_H * 0.92;
    const pieces: THREE.BufferGeometry[] = [];
    const plateG = new THREE.BoxGeometry(VENT_W - 0.05, fh, 0.025);
    plateG.translate(0, -fh / 2, 0);
    pieces.push(plateG);
    for (let i = 0; i < 4; i++) {
      const slat = new THREE.BoxGeometry(VENT_W - 0.12, 0.035, 0.07);
      slat.translate(0, -fh * (0.16 + i * 0.22), 0.02);
      pieces.push(slat);
    }
    const flap = merge(pieces);
    for (const p of pieces) p.dispose();
    // Local +Z is building +Z for a wall running along X and building −X for one running along Z (the same convention as `solid`'s Euler).
    // rotateX(a) sends the lower edge to local −sign(a) Z → rotate by the opposite sign of the side wanted. At 1.4 rad the lower edge is floor + 0.51 m.
    const localToward = toward * (alongZ ? -1 : 1);
    flap.rotateX(-localToward * 1.4);
    const [hx, hz] = rot(...at(c));
    xform(flap, { x: hx, y: yBase + VENT_H - 0.02, z: hz }, new THREE.Euler(0, -(yaw + (alongZ ? Math.PI / 2 : 0)), 0));
    paint(flap, METAL_DARK);   // uses no rng — the basement vent must not shift the building's own draw stream
    parts.push(flap);
  };

  /* ── Placement decisions: front door → partition · indoor stairs · basement stair hole · partition passage →
   * collapsed breach ──────────────────────────────────────────────────────────────────────────────────────────
   * The constraints collide with each other: a room long enough for the stairs, the basement stair hole not running
   * under the partition, that corridor fitting inside the pit, and (2026-09-12) **no opening's approach overlapping
   * anything that blocks**. The partition's spot is rolled several times and the one satisfying all of them at once
   * is picked. */
  const stairRise = H + SLAB_T;
  const stairRun = stairRise / STAIR_SLOPE;
  const needStairRoom = STAIR_LANDING + stairRun + STAIR_ARRIVAL;
  const bRise = pit ? pit.depth - BASEMENT_FLOOR_T : 0;
  const yB = y0 - bRise;
  const bRun = bRise / STAIR_SLOPE;
  const bLen = bRun + BASEMENT_LANDING + WALL_T;
  const pitInX = pit ? pit.halfX - 0.15 : 0, pitInZ = pit ? pit.halfZ - 0.15 : 0;

  let floors = plan.floors >= 2 ? 2 : 1;
  const stairSide = rng.chance(0.5) ? 1 : -1;
  const sOuter = stairSide * iw, sInner = stairSide * (iw - STAIR_W);
  const sXc = (sOuter + sInner) / 2;

  /* The front door opens in the south wall regardless of the partition — it is decided first and
   * everything else keeps the space in front of it clear. */
  const doorX = rng.range(-halfW * 0.45, halfW * 0.45);
  const frontZone = rect(doorX - DOOR_W / 2, doorX + DOOR_W / 2, -id, -id + OPENING_APPROACH);

  /** With the floor 1 → 2 stairs standing in the `room` side of partition `pz`: the solid (what it blocks on
   * floor 1) · the landing + the room-side entry (the spot to keep clear). */
  const stairAt = (pz: number, room: number): { face: number; bottom: number; top: number; body: Rect; landing: Rect } => {
    const face = pz + room * WALL_T / 2;
    const bottom = face + room * STAIR_LANDING;
    const top = bottom + room * stairRun;
    return {
      face, bottom, top,
      body: rect(sOuter, sInner, bottom, top),
      landing: rect(sOuter, sInner - stairSide * OPENING_APPROACH, face, bottom),
    };
  };
  /** The basement stair hole (along the pit wall on the `side` side, from the high end `zA` toward `dz`):
   * what it blocks including the railing · the entry approach. */
  const holeAt = (side: number, dz: number, zA: number): { block: Rect; entry: Rect } => {
    const outer = side * pitInX, inner = side * (pitInX - 2 * BASEMENT_HALL_HALF);
    return {
      block: grow(rect(outer, inner, zA, zA + dz * bRun), RAIL_T + 0.05),
      entry: rect(outer, inner, zA - dz * OPENING_APPROACH, zA),
    };
  };
  /** The partition passage's approach (in both rooms). */
  const passZoneAt = (pz: number, x: number): Rect =>
    rect(x - DOOR_W / 2, x + DOOR_W / 2, pz - WALL_T / 2 - OPENING_APPROACH, pz + WALL_T / 2 + OPENING_APPROACH);

  let partZ = 0;
  let hasPartition = true;
  let stairRoom = 1;                                      // +1 = the room behind the partition (+Z), −1 = the one in front
  let stair = stairAt(0, 1);
  let bSide = -stairSide;
  let bDz = 1;
  let bZA = 0;
  let passX = 0;
  let relaxFront = false;
  const partMargin = WALL_T / 2 + 0.25;

  const tryLayout = (pz: number, fl: number, withPartition: boolean): boolean => {
    if (fl === 2) {
      const front = (pz - WALL_T / 2) + id;
      const back = id - (pz + WALL_T / 2);
      const opts: number[] = [];
      if (back >= needStairRoom) opts.push(1);
      if (front >= needStairRoom) opts.push(-1);
      const fit = opts.filter((r) => !overlaps(stairAt(pz, r).body, frontZone));
      if (fit.length === 0) return false;
      stairRoom = fit[rng.int(0, fit.length - 1)];
      stair = stairAt(pz, stairRoom);
    }
    /** Candidates for the partition passage (away from the stair column, and where the basement hole
     * does not block the space in front of it). */
    const passOptions = (block: Rect | null): number[] => {
      const out: number[] = [];
      const lo = -iw + DOOR_W / 2 + 0.6, hi = iw - DOOR_W / 2 - 0.6;
      for (let x = lo; x <= hi + 1e-6; x += 0.25) {
        if (fl === 2 && Math.abs(x - sXc) < STAIR_W / 2 + DOOR_W / 2 + 0.4) continue;
        if (block && overlaps(passZoneAt(pz, x), block)) continue;
        out.push(x);
      }
      return out;
    };
    if (pit) {
      bSide = fl === 2 ? -stairSide : (rng.chance(0.5) ? 1 : -1);
      const cands: [number, number][] = [];
      for (const dz of [1, -1]) {
        for (let k = 0; k <= 40; k++) {
          const zA = dz > 0 ? -pitInZ + k * 0.25 : pitInZ - k * 0.25;
          const zLow = zA + dz * bRun, zEnd = zA + dz * bLen;
          const beyond = dz > 0 ? pitInZ - zEnd : zEnd + pitInZ;
          if (beyond < 2.4) break;
          const h = holeAt(bSide, dz, zA);
          if (h.entry.z0 < -id + 0.05 || h.entry.z1 > id - 0.05) continue;       // the entry approach stays inside the building
          if (withPartition) {
            const h0 = Math.min(zA, zLow), h1 = Math.max(zA, zLow);
            if (pz + partMargin > h0 && pz - partMargin < h1) continue;           // the hole would run under the partition
            if (h.entry.z0 < pz + WALL_T / 2 && h.entry.z1 > pz - WALL_T / 2) continue;   // the partition would split the approach
          }
          if (!relaxFront && overlaps(h.block, frontZone)) continue;             // the railing would block the front door
          if (fl === 2 && (overlaps(h.block, stair.body) || overlaps(h.block, stair.landing) || overlaps(h.entry, stair.body))) continue;
          cands.push([dz, zA]);
        }
      }
      while (cands.length > 0) {
        const i = rng.int(0, cands.length - 1);
        const [dz, zA] = cands[i];
        if (withPartition) {
          const xs = passOptions(holeAt(bSide, dz, zA).block);
          if (xs.length === 0) { cands.splice(i, 1); continue; }
          passX = xs[rng.int(0, xs.length - 1)];
        }
        bDz = dz; bZA = zA;
        return true;
      }
      return false;
    }
    if (withPartition) {
      const xs = passOptions(null);
      if (xs.length === 0) return false;
      passX = xs[rng.int(0, xs.length - 1)];
    }
    return true;
  };
  let ok = false;
  for (let a = 0; a < 60 && !ok; a++) { partZ = rng.range(-halfD * 0.35, halfD * 0.3); ok = tryLayout(partZ, floors, true); }
  if (!ok && floors === 2) {
    floors = 1;
    for (let a = 0; a < 60 && !ok; a++) { partZ = rng.range(-halfD * 0.35, halfD * 0.3); ok = tryLayout(partZ, 1, true); }
  }
  if (!ok) {
    hasPartition = false; partZ = 0;
    if (!tryLayout(0, 1, false)) { relaxFront = true; tryLayout(0, 1, false); }
  }

  const levelY = (k: number): number => y0 + k * (H + SLAB_T);
  const topK = floors - 1;
  const roofY = levelY(floors);

  /* The indoor stairs (when there are two floors) — they lean on one outer wall and climb from the
   * landing toward an outer wall (north · south). */
  const stairFace = stair.face;
  const sBottomZ = stair.bottom;
  const sTopZ = stair.top;
  const stairRect = stair.body;
  /* The hole cut in the floor plate stops a hand's width short of the stairs' high end — the ramp's end and the plate
   * have to overlap so feet do not drop through the seam (on exactly the same line, floating-point error makes both
   * colliders miss that point). */
  const stairHole = rect(sOuter, sInner, sBottomZ, sTopZ - stairRoom * 0.08);

  /* The basement stair corridor — it descends along one wall of the pit. */
  const bOuter = bSide * pitInX, bInner = bSide * (pitInX - 2 * BASEMENT_HALL_HALF);
  const bXc = (bOuter + bInner) / 2;
  const bLowZ = bZA + bDz * bRun;
  const bDoorZ = bLowZ + bDz * (BASEMENT_LANDING + WALL_T / 2);
  const bHole = rect(bOuter, bInner, bZA, bLowZ);
  const bHoleSlab = rect(bOuter, bInner, bZA + bDz * 0.08, bLowZ);
  const bBlock = pit ? holeAt(bSide, bDz, bZA).block : null;

  /* The collapsed breach (one of floor 1's north · west · east): it avoids the stair solid · the landing ·
   * the space in front of the basement hole. With no spot that fits there is no breach. */
  const breachZoneAt = (side: number, c: number): Rect =>
    side === 0 ? rect(c - BREACH_W / 2, c + BREACH_W / 2, id - OPENING_APPROACH, id)
      : side === 1 ? rect(-iw, -iw + OPENING_APPROACH, c - BREACH_W / 2, c + BREACH_W / 2)
        : rect(iw - OPENING_APPROACH, iw, c - BREACH_W / 2, c + BREACH_W / 2);
  let breach: { side: number; c: number } | null = null;
  for (let a = 0; a < 24 && !breach; a++) {
    const side = rng.int(0, 2);                 // 0 = north, 1 = west, 2 = east (floor 1 only)
    const c = rng.range(-0.45, 0.45) * (side === 0 ? halfW : halfD) * 2;
    const zone = breachZoneAt(side, c);
    if (floors === 2 && (overlaps(zone, grow(stairRect, 0.3)) || overlaps(zone, stair.landing))) continue;
    if (bBlock && overlaps(zone, bBlock)) continue;
    breach = { side, c };
  }

  /* The ladder (top level → roof): it sits on a partition face and whoever hangs on it faces the partition.
   * Stepping onto the roof carries them over the partition. */
  const mountZ = hasPartition ? partZ : 0;
  let ladderSide = 1, ladderX = 0;
  {
    let found = false;
    for (let a = 0; a < 80 && !found; a++) {
      const side = a % 2 === 0 ? 1 : -1;
      const lx = rng.range(-iw + 1.1, iw - 1.1);
      if (hasPartition && Math.abs(lx - passX) < DOOR_W / 2 + 1.1) continue;
      const face = mountZ + side * WALL_T / 2;
      const zone = rect(lx - 1.1, lx + 1.1, face, face + side * 2.0);
      if (Math.abs(face + side * 2.0) > id) continue;
      if (floors === 2 && overlaps(zone, grow(stairRect, 0.6))) continue;
      if (floors === 1 && pit && overlaps(zone, grow(bHole, 1.0))) continue;
      ladderSide = side; ladderX = lx; found = true;
    }
  }
  const ladderFace = mountZ + ladderSide * WALL_T / 2;
  const hatch = rect(ladderX - HATCH_W / 2, ladderX + HATCH_W / 2, ladderFace, ladderFace + ladderSide * HATCH_D);
  const ladderZone = rect(ladderX - 1.1, ladderX + 1.1, ladderFace, ladderFace + ladderSide * 2.0);

  /* ── 2026-09-12: the floor-2 locked room's spot ────────────────────────────
   * It attaches to one corner (sx, sz). Coordinates are measured in a (u, b) frame — u runs along the door wall from
   * the side-wall end (0) toward the outer wall (L), b runs inward from the corner's outer wall inner face (0). The
   * door wall stands at b = D + WALL_T/2, the side wall at u = −WALL_T/2.
   * `alongZ` = the door wall runs along local Z. The 8 candidates (4 corners × 2 door wall directions) are shuffled
   * with the dedicated rng and the first one that fits is used. */
  interface LockPlan {
    sx: number; sz: number; alongZ: boolean;
    map: (u: number, b: number) => [number, number];
    block: Rect; yard: Rect; interior: Rect;
  }
  const LOCK_L = LOCKED_ROOM_LEN, LOCK_D = LOCKED_ROOM_DEPTH;
  const LOCK_U_VENT = VENT_MARGIN + VENT_W / 2;
  const LOCK_U_DOOR0 = VENT_MARGIN + VENT_W + VENT_POST;
  const LOCK_U_DOOR = LOCK_U_DOOR0 + LOCKED_DOOR_W / 2;
  let lock: LockPlan | null = null;
  if (floors === 2 && plan.lockedContainers > 0 && plan.lockRng) {
    const lr = plan.lockRng;
    const makeLock = (sx: number, sz: number, alongZ: boolean): LockPlan => {
      const map = (u: number, b: number): [number, number] => (alongZ
        ? [sx * (iw - b), sz * (id - LOCK_L + u)]
        : [sx * (iw - LOCK_L + u), sz * (id - b)]);
      const fr = (u0: number, u1: number, b0: number, b1: number): Rect => {
        const [xa, za] = map(u0, b0), [xb, zb] = map(u1, b1);
        return rect(xa, xb, za, zb);
      };
      return {
        sx, sz, alongZ, map,
        block: fr(-WALL_T, LOCK_L, 0, LOCK_D + WALL_T),
        yard: fr(0, LOCK_U_DOOR0 + LOCKED_DOOR_W, LOCK_D + WALL_T, LOCK_D + WALL_T + OPENING_APPROACH),
        interior: fr(0, LOCK_L, 0, LOCK_D),
      };
    };
    // Floor 2's stair hole + railing + arrival spot (whoever arrives leaves sideways inward, so it is kept generously clear)
    const stairZone2 = rect(sOuter, sInner, sBottomZ - stairRoom * RAIL_T, sTopZ + stairRoom * STAIR_ARRIVAL);
    const ladderWall = hasPartition ? null : rect(ladderX - 1.6, ladderX + 1.6, mountZ - WALL_T / 2, mountZ + WALL_T / 2);
    const fits = (c: LockPlan): boolean => {
      if (overlaps(grow(c.block, 1.2), stairZone2) || overlaps(c.yard, grow(stairZone2, 0.3))) return false;
      if (overlaps(grow(c.block, 1.0), ladderZone) || overlaps(c.yard, grow(ladderZone, 0.2))) return false;
      if (ladderWall && (overlaps(grow(c.block, 1.0), ladderWall) || overlaps(c.yard, ladderWall))) return false;
      if (hasPartition) {
        const pz0 = partZ - WALL_T / 2, pz1 = partZ + WALL_T / 2;
        // The room · its approach stay on one side of the partition, and the room keeps enough distance
        // (1.2 m) from it for a person to pass (no dead gap is created)
        const z0 = Math.min(c.block.z0, c.yard.z0), z1 = Math.max(c.block.z1, c.yard.z1);
        if (c.sz > 0 ? z0 < pz1 + 0.05 : z1 > pz0 - 0.05) return false;
        if (c.sz > 0 ? c.block.z0 - pz1 < 1.2 : pz0 - c.block.z1 < 1.2) return false;
        const pass = passZoneAt(partZ, passX);
        if (overlaps(grow(c.block, 0.6), pass) || overlaps(c.yard, pass)) return false;
      }
      return true;
    };
    const cands: LockPlan[] = [];
    for (const sx of [1, -1]) for (const sz of [1, -1]) for (const az of [false, true]) cands.push(makeLock(sx, sz, az));
    for (let i = cands.length - 1; i > 0; i--) { const j = lr.int(0, i); const t = cands[i]; cands[i] = cands[j]; cands[j] = t; }
    lock = cands.find(fits) ?? null;
  }

  /* ── Floor plates · ceilings · roof ──────────────────────────────────────── */
  const fx0 = halfW + FLOOR_OVERHANG, fz0 = halfD + FLOOR_OVERHANG;
  const fxs = halfW + WALL_T / 2, fzs = halfD + WALL_T / 2;
  slab(fx0, fz0, y0, FLOOR_LIP, CONCRETE_DARK, pit ? bHoleSlab : null);                  // floor 1's plate = the basement ceiling
  if (floors === 2) {
    slab(fxs, fzs, levelY(1), 0, CONCRETE_DARK, stairHole);                          // floor 2's plate = floor 1's ceiling
    slab(fxs, fzs, roofY, 0, CONCRETE, hatch);                                        // the roof = floor 2's ceiling
  } else {
    slab(fxs, fzs, roofY, 0, CONCRETE, hatch);                                        // the roof = floor 1's ceiling
  }

  /* ── Per level: outer walls · partition · windows ────────────────────────── */
  /** The window spots in one wall (1–3 at random). The pane specs and the sills are built by `emitWindows` after the wall stands. */
  const windowOps = (len: number, forbid: { c: number; w: number }[]): Opening[] => {
    const ops: Opening[] = [];
    const want = rng.int(1, len > 9.5 ? 3 : 2);
    for (let a = 0; a < 40 && ops.length < want; a++) {
      const c = rng.range(-len + 1.4, len - 1.4);
      if (forbid.some((f) => Math.abs(c - f.c) < (f.w + WINDOW_W) / 2 + 0.5)) continue;
      if (ops.some((o) => Math.abs(c - o.c) < WINDOW_W + 1.0)) continue;
      ops.push({ c, w: WINDOW_W, y0: WINDOW_SILL, y1: WINDOW_TOP });
    }
    return ops;
  };
  const emitWindows = (alongZ: boolean, fixed: number, yBase: number, ops: Opening[]): void => {
    for (const o of ops) {
      if (o.y0 <= 0.01) continue;                             // a door · a breach
      const lx = alongZ ? fixed : o.c, lz = alongZ ? o.c : fixed;
      const [wx, wz] = rot(lx, lz);
      windows.push({
        x: wx, y: yBase + o.y0, z: wz, halfW: o.w / 2, height: o.y1 - o.y0,
        yaw: yaw + (alongZ ? Math.PI / 2 : 0),
      });
      solid(lx, lz, o.w / 2 + 0.1, WALL_T / 2 + 0.08, yBase + o.y0 - 0.07, 0.07, alongZ, null, METAL_DARK, METAL);
    }
  };

  for (let k = 0; k < floors; k++) {
    const yk = levelY(k);
    const south: Opening[] = [], north: Opening[] = [], west: Opening[] = [], east: Opening[] = [];
    const fS: { c: number; w: number }[] = [], fN: { c: number; w: number }[] = [];
    const fW: { c: number; w: number }[] = [], fE: { c: number; w: number }[] = [];
    if (hasPartition) { fW.push({ c: partZ, w: WALL_T + 0.6 }); fE.push({ c: partZ, w: WALL_T + 0.6 }); }
    if (k === 0) {
      south.push({ c: doorX, w: DOOR_W, y0: 0, y1: DOOR_H }); fS.push({ c: doorX, w: DOOR_W });
      if (breach) {
        const f = { c: breach.c, w: BREACH_W };
        const bOp: Opening = { ...f, y0: 0, y1: BREACH_H };
        if (breach.side === 0) { north.push(bOp); fN.push(f); }
        if (breach.side === 1) { west.push(bOp); fW.push(f); }
        if (breach.side === 2) { east.push(bOp); fE.push(f); }
      }
    }
    // 2026-09-12: on the outer wall the stairs lean on, no window is cut into the stair stretch (the landing included) **on any level**
    if (floors === 2) (stairSide > 0 ? fE : fW).push({ c: (stairFace + sTopZ) / 2, w: Math.abs(sTopZ - stairFace) + 1.2 });
    // 2026-09-12: no window is cut into the two outer wall faces the locked room attaches to (so an inner
    // wall never meets a window's middle — the room is a sealed vault)
    if (k === 1 && lock) {
      const b = lock.block;
      (lock.sz > 0 ? fN : fS).push({ c: (b.x0 + b.x1) / 2, w: b.x1 - b.x0 + 0.8 });
      (lock.sx > 0 ? fE : fW).push({ c: (b.z0 + b.z1) / 2, w: b.z1 - b.z0 + 0.8 });
    }
    south.push(...windowOps(iw, fS));
    north.push(...windowOps(iw, fN));
    west.push(...windowOps(id, fW));
    east.push(...windowOps(id, fE));
    wallRun(false, -halfD, -halfW, halfW, yk, H, south);
    wallRun(false, halfD, -halfW, halfW, yk, H, north);
    wallRun(true, -halfW, -halfD, halfD, yk, H, west);
    wallRun(true, halfW, -halfD, halfD, yk, H, east);
    emitWindows(false, -halfD, yk, south);
    emitWindows(false, halfD, yk, north);
    emitWindows(true, -halfW, yk, west);
    emitWindows(true, halfW, yk, east);
    if (hasPartition) wallRun(false, partZ, -iw, iw, yk, H, [{ c: passX, w: DOOR_W, y0: 0, y1: DOOR_H }]);
  }
  if (!hasPartition) {
    // A building with no room for a partition: only one short wall segment is stood on the top level for the ladder
    solid(ladderX, mountZ, 1.6, WALL_T / 2, levelY(topK), H, false, 'building');
  }

  /* ── 2026-09-12: the floor-2 locked room — two inner wall faces · the door (its spot only; the panel is
   * `Structures`) · the vent · lighting · container spots ────────────────────────────────────────────── */
  let lockedDoor: DoorSpot | null = null;
  const lockedSpots: Spot[] = [];
  const turrets: TurretSpot[] = [];
  /** A local rectangle + a height band turned into the world OBB a ceiling turret watches. */
  const watchRoom = (r: Rect, yBottom: number, yTop: number): TurretSpot['room'] => {
    const [wx, wz] = rot((r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2);
    return { x: wx, z: wz, halfX: (r.x1 - r.x0) / 2, halfZ: (r.z1 - r.z0) / 2, yaw, yBottom, yTop };
  };
  if (lock) {
    const L = LOCK_L, D = LOCK_D;
    const y1 = levelY(1);
    const wallB = D + WALL_T / 2;
    /** Turns a u on the door wall into the local coordinate that wall runs along. */
    const along = (u: number): number => { const [x, z] = lock!.map(u, wallB); return lock!.alongZ ? z : x; };
    const [fx, fz] = lock.map(0, wallB);
    const doorWallFixed = lock.alongZ ? fx : fz;
    const a0 = along(0), a1 = along(L);
    wallRun(lock.alongZ, doorWallFixed, Math.min(a0, a1), Math.max(a0, a1), y1, H, [
      { c: along(LOCK_U_VENT), w: VENT_W, y0: 0, y1: VENT_H },
      { c: along(LOCK_U_DOOR), w: LOCKED_DOOR_W, y0: 0, y1: DOOR_H },
    ]);
    // The side wall (perpendicular to the door wall, including the corner column's share)
    {
      const sideAlongZ = !lock.alongZ;
      const [p0x, p0z] = lock.map(-WALL_T / 2, 0), [p1x, p1z] = lock.map(-WALL_T / 2, D + WALL_T);
      const fixed = sideAlongZ ? p0x : p0z;
      const s0 = sideAlongZ ? p0z : p0x, s1 = sideAlongZ ? p1z : p1x;
      wallRun(sideAlongZ, fixed, Math.min(s0, s1), Math.max(s0, s1), y1, H, []);
    }
    // The door frame: both jambs + the head piece (they stick out a little from the wall face, so they get
    // colliders — the same as the basement door frame)
    for (const u of [LOCK_U_DOOR0 - 0.08, LOCK_U_DOOR0 + LOCKED_DOOR_W + 0.08]) {
      const [px, pz] = lock.map(u, wallB);
      solid(px, pz, 0.08, WALL_T / 2 + 0.05, y1, DOOR_H, lock.alongZ, 'building', METAL_DARK, METAL);
    }
    {
      const [px, pz] = lock.map(LOCK_U_DOOR, wallB);
      solid(px, pz, LOCKED_DOOR_W / 2 + 0.16, WALL_T / 2 + 0.05, y1 + DOOR_H - 0.1, 0.12, lock.alongZ, 'building', METAL_DARK, METAL);
      // The warning light strip above the door (drawing only)
      const [gx, gz] = rot(...lock.map(LOCK_U_DOOR, D + WALL_T + 0.06));
      const lampG = new THREE.BoxGeometry(0.6, 0.1, 0.08);
      xform(lampG, { x: gx, y: y1 + DOOR_H + 0.25, z: gz }, new THREE.Euler(0, -(yaw + (lock.alongZ ? Math.PI / 2 : 0)), 0));
      glow.push(lampG);
    }
    ventDecor(lock.alongZ, doorWallFixed, along(LOCK_U_VENT), y1, WALL_T, lock.alongZ ? lock.sx : lock.sz);
    {
      const [ox, oz] = lock.map(LOCK_U_VENT, D + WALL_T + 0.8), [ix, iz] = lock.map(LOCK_U_VENT, D - 0.8);
      vents.push({ out: [ox, oz], in: [ix, iz], y: y1 });
    }
    // The door (the panel slides into the pocket inside the wall = toward +u — the panel is 0.18 thick,
    // less than the wall, so an open panel hides inside it)
    {
      const [dlx, dlz] = lock.map(LOCK_U_DOOR, wallB);
      const [dx, dz] = rot(dlx, dlz);
      const slide = LOCKED_DOOR_W + 0.02;
      const [sxw, szw] = lock.alongZ ? dirW(0, lock.sz * slide) : dirW(lock.sx * slide, 0);
      const [rx, rz] = rot(...lock.map(VENT_MARGIN + VENT_W + VENT_POST / 2, D + WALL_T + 0.08));
      const [ix, iz] = rot(...lock.map(LOCK_U_DOOR, D + WALL_T + 0.85));
      const byaw = yaw + (lock.alongZ ? Math.PI / 2 : 0);
      lockedDoor = {
        x: dx, y: y1, z: dz, yaw: byaw, halfW: LOCKED_DOOR_W / 2 - 0.06, height: DOOR_H - 0.04, thick: 0.18,
        slideX: sxw, slideZ: szw,
        reader: { x: rx, z: rz, yaw: byaw },
        interact: { x: ix, y: y1, z: iz },
      };
    }
    // The room light (this room holds containers — one spot in the light pool)
    {
      const [wx, wz] = rot(...lock.map(L / 2, D / 2));
      const g = new THREE.BoxGeometry(1.1, 0.07, 0.45);
      xform(g, { x: wx, y: y1 + H - 0.04, z: wz }, new THREE.Euler(0, -yaw, 0));
      glow.push(g);
      fixtures.push({ x: wx, y: y1 + H - 0.4, z: wz, color: lightColor, intensity: LIGHT_INTENSITY * 0.8, distance: LIGHT_DISTANCE });
    }
    /* 2026-09-21: the ceiling turret. It hangs away from the light plate (which sits at the room's middle) and
     * closer to the door wall, so the door · the vent · every container is in front of it. No light of its own —
     * the raid's point-light count is fixed (`core/LightBudget`, CLAUDE.md §4.5). */
    {
      const [wx, wz] = rot(...lock.map(L / 2, D * 0.72));
      turrets.push({ x: wx, y: y1 + H, z: wz, room: watchRoom(lock.interior, y1, y1 + H) });
    }
    // Container spots: backed onto the outer wall (b = 0) and facing the door wall — the same inset as the level's other containers
    {
      const n = Math.min(4, plan.lockedContainers);
      const facing = lock.alongZ ? (lock.sx > 0 ? Math.PI : 0) : -lock.sz * Math.PI / 2;
      for (let i = 0; i < n; i++) {
        const [wx, wz] = rot(...lock.map(L * (i + 0.5) / n, 0.95));
        lockedSpots.push({ x: wx, y: y1, z: wz, yaw: yaw + facing });
      }
    }
  }

  /* The front door lintel trim + lamp (drawing only — above door height, so it never touches a head) */
  {
    solid(doorX, -halfD, DOOR_W / 2 + 0.45, WALL_T / 2 + 0.1, y0 + DOOR_H - 0.05, 0.4, false, null, METAL, METAL);
    const [lx, lz] = rot(doorX, -halfD - WALL_T / 2 - 0.1);
    const lamp = new THREE.BoxGeometry(0.5, 0.12, 0.16);
    xform(lamp, { x: lx, y: y0 + DOOR_H + 0.5, z: lz }, new THREE.Euler(0, -yaw, 0));
    glow.push(lamp);
  }

  /* ── The roof: parapet · hatch railing · antenna ──────────────────────────── */
  wallRun(false, -halfD, -halfW, halfW, roofY, PARAPET_H, []);
  wallRun(false, halfD, -halfW, halfW, roofY, PARAPET_H, []);
  wallRun(true, -halfW, -halfD, halfD, roofY, PARAPET_H, []);
  wallRun(true, halfW, -halfD, halfD, roofY, PARAPET_H, []);
  {
    // Three sides around the hatch (the side stepped onto = the partition side is left open)
    const far = ladderFace + ladderSide * HATCH_D;
    solid(ladderX, far + ladderSide * RAIL_T / 2, HATCH_W / 2 + RAIL_T, RAIL_T / 2, roofY, RAIL_H, false, 'building', METAL_DARK, METAL);
    for (const s of [-1, 1]) {
      solid(ladderX + s * (HATCH_W / 2 + RAIL_T / 2), ladderFace + ladderSide * HATCH_D / 2, HATCH_D / 2, RAIL_T / 2,
        roofY, RAIL_H, true, 'building', METAL_DARK, METAL);
    }
  }

  /* ── The ladder (drawing — hanging is done by `player/`, so it gets no collider) ──────── */
  const ladders: LadderSpot[] = [];
  {
    const yLow = levelY(topK), yHigh = roofY + 1.15;
    const railZ = ladderFace + ladderSide * 0.07;
    for (const s of [-1, 1]) {
      solid(ladderX + s * 0.26, railZ, 0.035, 0.035, yLow, yHigh - yLow, true, null, METAL_DARK, METAL);
    }
    for (let y = yLow + 0.3; y < yHigh - 0.1; y += 0.32) {
      solid(ladderX, railZ, 0.26, 0.022, y, 0.045, false, null, METAL, METAL);
    }
    const [bx, bz] = rot(ladderX, ladderFace + ladderSide * LADDER_STANDOFF);
    const [nx, nz] = dirW(0, ladderSide);
    const [ex, ez] = rot(ladderX, mountZ - ladderSide * (WALL_T / 2 + 0.85));
    ladders.push({ base: { x: bx, y: yLow, z: bz }, topY: roofY, normal: { x: nx, z: nz }, exit: { x: ex, y: roofY, z: ez } });
  }

  /* ── The indoor stairs (floor 1 → 2) ──────────────────────────────────── */
  if (floors === 2) {
    const [hx, hz] = rot(sXc, sTopZ);
    const [ux, uz] = dirW(0, -stairRoom);
    buildStairFlight(ctx, parts, rng, {
      hx, hz, ux, uz, width: STAIR_W - 0.04, run: stairRun, topY: levelY(1), bottomY: y0, solidY: y0,
      dark: CONCRETE_DARK, light: CONCRETE, kind: 'slab',
    });
    /* 2026-09-12: the floor-1 room-side wall (up to the ceiling) is gone. The stair solid is one piece rising from the
     * floor at every step, so there is no gap to get under it, and the low end can be stepped onto from the side — the
     * wall only narrowed the entry to one 0.8 m gap and hid the stairs from the room. */
    // The floor-2 stair hole railing: the long room-side edge + the short lower-end edge (the upper end = the arrival side is left open)
    const y1 = levelY(1);
    solid(sInner - stairSide * RAIL_T / 2, (sBottomZ + sTopZ) / 2, stairRun / 2, RAIL_T / 2, y1, RAIL_H, true, 'building', METAL_DARK, METAL);
    solid(sXc, sBottomZ - stairRoom * RAIL_T / 2, STAIR_W / 2, RAIL_T / 2, y1, RAIL_H, false, 'building', METAL_DARK, METAL);
  }

  /* ── The basement ─────────────────────────────────────────────────────── */
  let door: DoorSpot | null = null;
  const basementSpots: Spot[] = [];
  if (pit) {
    const pitBottom = y0 - pit.depth;
    /* The pit's earth walls are clad in concrete and get colliders (trusting the terrain alone lets a body
     * climb the dirt and get stuck in the ceiling). */
    for (const [alongZ, fixed] of [[false, -pit.halfZ], [false, pit.halfZ], [true, -pit.halfX], [true, pit.halfX]] as [boolean, number][]) {
      const len = alongZ ? pit.halfZ : pit.halfX;
      solid(alongZ ? fixed : 0, alongZ ? 0 : fixed, len, 0.15, pitBottom, pit.depth, alongZ, 'building',
        CONCRETE_DARK.clone().multiplyScalar(0.7), CONCRETE_DARK, pitBottom, y0);
    }
    /* The basement floor plate (top face = yB) */
    plate(-pit.halfX, pit.halfX, -pit.halfZ, pit.halfZ, yB, 0, CONCRETE_DARK.clone().multiplyScalar(0.85));

    /* The stairs: they descend along the corridor from the high end (bZA) of the hole in floor 1's plate */
    {
      const [hx, hz] = rot(bXc, bZA);
      const [ux, uz] = dirW(0, bDz);
      buildStairFlight(ctx, parts, rng, {
        hx, hz, ux, uz, width: 2 * BASEMENT_HALL_HALF - 0.04, run: bRun, topY: y0, bottomY: yB, solidY: yB,
        dark: CONCRETE_DARK, light: CONCRETE, kind: 'slab',
      });
    }
    /* The walls either side of the stairs — the outer one is the pit wall, and a wall is stood on the room side (from
     * the hole's start to just before the door wall, up to floor 1's height). It breaks off a hand's width before the
     * door wall — an opened panel slides through that gap toward the room. */
    {
      const zEnd = bDoorZ - bDz * (WALL_T / 2 + 0.14);
      const wx = bInner - bSide * 0.1;
      /* 2026-09-12: a **ground-drone vent** in the middle of the landing stretch right in front of the door (the
       * stairs' low end ~ the wall's end) — two wall segments + a lintel. Only a drone passes corridor → basement room
       * (a person is pushed out by the lintel). The 1.1 m on the room side is already clear of container spots. */
      const vc = (bLowZ + zEnd) / 2;
      const v0 = vc - VENT_W / 2, v1 = vc + VENT_W / 2;
      const zLo = Math.min(bZA, zEnd), zHi = Math.max(bZA, zEnd);
      const seg = (a: number, b: number, yb: number, h: number): void => {
        if (b - a > 0.05 && h > 0.03) solid(wx, (a + b) / 2, (b - a) / 2, 0.1, yb, h, true, 'building', CONCRETE_DARK, CONCRETE, yB, yB + bRise);
      };
      seg(zLo, v0, yB, bRise);
      seg(v0, v1, yB + VENT_H, bRise - VENT_H);
      seg(v1, zHi, yB, bRise);
      ventDecor(true, wx, vc, yB, 0.2, -bSide);
      vents.push({ out: [bInner + bSide * 0.6, vc], in: [bInner - bSide * 0.9, vc], y: yB });
    }
    /* Three railing sides so nobody falls into the hole from floor 1 (the high end = the way in is left open) */
    solid(bInner - bSide * RAIL_T / 2, (bZA + bLowZ) / 2, bRun / 2, RAIL_T / 2, y0, RAIL_H, true, 'building', METAL_DARK, METAL);
    solid(bOuter + bSide * RAIL_T / 2, (bZA + bLowZ) / 2, bRun / 2, RAIL_T / 2, y0, RAIL_H, true, 'building', METAL_DARK, METAL);
    solid(bXc, bLowZ + bDz * RAIL_T / 2, BASEMENT_HALL_HALF, RAIL_T / 2, y0, RAIL_H, false, 'building', METAL_DARK, METAL);

    /* The door wall: the lintel above the door + the frame post (the panel is hung by `Structures`) */
    solid(bXc, bDoorZ, BASEMENT_HALL_HALF, WALL_T / 2, yB + DOOR_H, (y0 - SLAB_T) - (yB + DOOR_H), false, 'building');
    // The door frame: the post on the pit wall side + the head piece above (no post on the room side — the panel slides out that way).
    // 2026-09-12: the drawn post · head piece get colliders (they used to be drawing only, so a body passed through the post's corner).
    solid(bXc + bSide * (BASEMENT_HALL_HALF - 0.06), bDoorZ, 0.08, WALL_T / 2 + 0.05, yB, DOOR_H, false, 'building', METAL_DARK, METAL);
    solid(bXc, bDoorZ, BASEMENT_HALL_HALF, WALL_T / 2 + 0.05, yB + DOOR_H - 0.1, 0.12, false, 'building', METAL_DARK, METAL);
    {
      const [dx, dz] = rot(bXc, bDoorZ);
      const slide = 2 * BASEMENT_HALL_HALF + 0.15;
      const [sx, sz] = dirW(-bSide * slide, 0);
      const [rx, rz] = rot(bInner + bSide * 0.22, bDoorZ - bDz * 0.75);
      const [ix, iz] = rot(bXc, bDoorZ - bDz * 0.85);
      door = {
        x: dx, y: yB, z: dz, yaw, halfW: BASEMENT_HALL_HALF - 0.08, height: DOOR_H - 0.04, thick: 0.18,
        slideX: sx, slideZ: sz,
        reader: { x: rx, z: rz, yaw: yaw + (bSide > 0 ? 0 : Math.PI) },
        interact: { x: ix, y: yB, z: iz },
      };
    }

    /* The basement lighting: the middle of the room past the door + the room beside the corridor (an
     * emissive plate + a light spot) + an emissive strip on the corridor ceiling */
    const ceilY = y0 - SLAB_T;
    const farEdge = bDz > 0 ? pitInZ : -pitInZ;
    const roomA = { x: -bSide * pitInX * 0.3, z: (bDoorZ + bDz * WALL_T / 2 + farEdge) / 2 };
    const roomB = { x: (bInner - bSide * 0.2 + -bSide * pitInX) / 2, z: (bZA + bDoorZ) / 2 };
    for (const r of [roomA, roomB]) {
      const [wx, wz] = rot(r.x, r.z);
      const g = new THREE.BoxGeometry(1.3, 0.07, 0.45);
      xform(g, { x: wx, y: ceilY - 0.04, z: wz }, new THREE.Euler(0, -yaw, 0));
      glow.push(g);
      fixtures.push({ x: wx, y: ceilY - 0.35, z: wz, color: lightColor, intensity: LIGHT_INTENSITY * 0.8, distance: LIGHT_DISTANCE });
    }
    {
      const [wx, wz] = rot(bXc, (bLowZ + bDoorZ) / 2);
      const g = new THREE.BoxGeometry(0.12, 0.06, Math.abs(bDoorZ - bLowZ) + 0.6);
      xform(g, { x: wx, y: ceilY - 0.04, z: wz }, new THREE.Euler(0, -yaw, 0));
      glow.push(g);
    }

    /* 2026-09-21: the basement's ceiling turret — over the room past the door (`roomA`, the room the containers
     * stand in), offset from that room's light plate. The watched volume is the **whole pit**, so a body that
     * came down the stair corridor is a target too — while the door is shut its panel is a collider and blocks
     * the line of fire, which is exactly the rule. No light of its own (CLAUDE.md §4.5). */
    {
      const [wx, wz] = rot(roomA.x + bSide * 0.9, roomA.z);
      turrets.push({
        x: wx, y: ceilY, z: wz,
        room: watchRoom(rect(-pitInX, pitInX, -pitInZ, pitInZ), yB, ceilY),
      });
    }

    /* The basement container spots (backed onto a wall, keeping the corridor · the space in front of the door clear) */
    {
      const corridor = rect(bOuter, bInner - bSide * 1.1, bZA - bDz * 0.3, bDoorZ + bDz * 2.0);
      const cand: Spot[] = [];
      const inset = 0.8;
      for (let lx = -pitInX + inset; lx <= pitInX - inset; lx += 2.0) {
        for (const [lz, f] of [[-pitInZ + inset, Math.PI / 2], [pitInZ - inset, -Math.PI / 2]] as [number, number][]) {
          if (inRect(corridor, lx, lz)) continue;
          const [wx, wz] = rot(lx, lz);
          cand.push({ x: wx, y: yB, z: wz, yaw: yaw + f });
        }
      }
      for (let lz = -pitInZ + inset * 2; lz <= pitInZ - inset * 2; lz += 2.0) {
        for (const [lx, f] of [[-pitInX + inset, 0], [pitInX - inset, Math.PI]] as [number, number][]) {
          if (inRect(corridor, lx, lz)) continue;
          const [wx, wz] = rot(lx, lz);
          cand.push({ x: wx, y: yB, z: wz, yaw: yaw + f });
        }
      }
      for (let i = cand.length - 1; i > 0; i--) { const j = rng.int(0, i); const t = cand[i]; cand[i] = cand[j]; cand[j] = t; }
      basementSpots.push(...cand.slice(0, Math.max(0, plan.basementContainers)));
    }
  }

  /* ── The spots to keep clear on the ground levels ──────────────────────── */
  const exclusions = (k: number): Rect[] => {
    const ex: Rect[] = [];
    if (hasPartition) ex.push(rect(passX - DOOR_W * 0.8, passX + DOOR_W * 0.8, partZ - 1.5, partZ + 1.5));
    if (k === 0) {
      ex.push(rect(doorX - DOOR_W, doorX + DOOR_W, -id, -id + 1.6));
      if (breach) ex.push(grow(breachZoneAt(breach.side, breach.c), 0.6));
      if (floors === 2) ex.push(grow(stairRect, 0.2), grow(stair.landing, 0.2));
      if (pit) ex.push(grow(rect(bOuter, bInner, bZA - bDz * 1.6, bLowZ), 0.9));
    }
    if (k === 1) ex.push(grow(rect(sOuter, sInner, sBottomZ, sTopZ + stairRoom * 1.6), 0.5));
    if (k === 1 && lock) ex.push(grow(lock.block, 0.8), grow(lock.yard, 0.4));   // 2026-09-12: the locked room · its door approach
    if (k === topK) ex.push(grow(ladderZone, 0.2));
    return ex;
  };
  /**
   * 2026-09-14 — how far the **centre** has to back off when something is placed outside a 「spot to keep clear」: its
   * own bulk (`reach`) + the width a body needs to **pass** (a diameter). Subtracting the bulk alone leaves the object
   * outside the spot while its **push-out band** eats the spot's edge — and when the inside of the spot is already one
   * wall, as with the stair hole railing, that alone seals the arrival spot entirely (see the container section below).
   */
  const clearFor = (reach: number): number => reach + PLAYER_RADIUS * 2;

  /* ── Indoor props (workbenches in a lab, ammo pallets in an outpost) ────────
   * 2026-09-12: the collider is **the box as drawn**. It used to be a 0.7 m cylinder, so both ends of a long
   * workbench could be walked through while 30 cm in front of it was an invisible wall. Their height is within
   * `PROP_STEP_UP_MAX`, so they can be stepped on by the box rule. */
  for (let k = 0; k < floors; k++) {
    const ex = exclusions(k);
    const n = rng.int(1, 3);
    for (let i = 0; i < n; i++) {
      const lx = rng.range(-iw + 1.6, iw - 1.6), lz = rng.range(-id + 1.6, id - 1.6);
      const w = lab ? rng.range(1.6, 2.6) : rng.range(1.0, 1.6);
      const h = lab ? 0.9 : rng.range(0.5, 0.9);
      const d = lab ? 0.8 : rng.range(0.9, 1.4);
      const pyaw = yaw + rng.range(-0.4, 0.4);
      const reach = Math.hypot(w, d) / 2;
      // 2026-09-14: the old 0.3 m clearance was narrower than a body's radius (0.45), so a prop's push-out
      // band ate the spot to keep clear → `clearFor`
      if (ex.some((r) => inRect(grow(r, clearFor(reach)), lx, lz))) continue;
      if (hasPartition && Math.abs(lz - partZ) < WALL_T / 2 + reach + 0.6) continue;
      const [px, pz] = rot(lx, lz);
      const g = new THREE.BoxGeometry(w, h, d);
      xform(g, { x: px, y: levelY(k) + h / 2, z: pz }, new THREE.Euler(0, -pyaw, 0));
      paint(g, lab ? METAL : RUST, 0.1, rng);
      parts.push(g);
      ctx.hash.addBox(new THREE.Vector3(px, levelY(k), pz), w / 2, d / 2, pyaw, h, 'building');
    }
  }

  /* ── Container spots (along the walls of each level) ──────────────────────── */
  const floorSpots: { spot: Spot; room: string; rx: number; rz: number; k: number }[] = [];
  for (let k = 0; k < floors; k++) {
    const yk = levelY(k);
    const ex = exclusions(k);
    const inset = 1.15;
    const push = (lx: number, lz: number, facing: number): void => {
      if (ex.some((r) => inRect(r, lx, lz))) return;
      const [wx, wz] = rot(lx, lz);
      const back = hasPartition && lz > partZ;
      floorSpots.push({ spot: { x: wx, y: yk, z: wz, yaw: yaw + facing }, room: `${k}${back ? 'b' : 'f'}`, rx: lx, rz: lz, k });
    };
    const step = 2.1;
    for (let lx = -halfW + inset; lx <= halfW - inset; lx += step) {
      push(lx, -halfD + inset, Math.PI / 2);
      push(lx, halfD - inset, -Math.PI / 2);
      if (hasPartition) {
        push(lx, partZ - inset, -Math.PI / 2);
        push(lx, partZ + inset, Math.PI / 2);
      }
    }
    for (let lz = -halfD + inset * 2; lz <= halfD - inset * 2; lz += step) {
      if (hasPartition && Math.abs(lz - partZ) < 1.0) continue;
      push(-halfW + inset, lz, 0);
      push(halfW - inset, lz, Math.PI);
    }
  }
  for (let i = floorSpots.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    const t = floorSpots[i]; floorSpots[i] = floorSpots[j]; floorSpots[j] = t;
  }
  /* ── 2026-09-14: containers are filtered **by bulk** too ───────────────────────
   * The `push` above looked only at the spot's **centre point** with `inRect` (props already looked at their bulk).
   * So a container stood on the wall right beside the stair arrival spot, and its body (`CONTAINER_REACH` from the
   * centre) + a person's radius met the push-out band of the stair hole **railing** and sealed the floor-2 arrival
   * spot entirely — on seed 21 `struct_lab_0` the two floor-2 rooms measured 15/1469 · 0/1256 and the ladder · the
   * locked room door · the containers were all unreachable (`smoke-structure-reach` · `smoke-site-spawns`).
   * ⚠ The filtering happens **after the shuffle** — the list length is the shuffle's draw count above, so filtering
   * first shifts every remaining draw on the same seed. With too few spots that building simply gets fewer containers
   * (better than a blocked one). */
  const contClear = clearFor(CONTAINER_REACH);
  const exByFloor = Array.from({ length: floors }, (_, k) => exclusions(k).map((r) => grow(r, contClear)));
  const chosen: typeof floorSpots = [];
  for (const c of floorSpots) {
    if (chosen.length >= Math.max(0, plan.containers)) break;
    if (exByFloor[c.k].some((r) => inRect(r, c.rx, c.rz))) continue;
    chosen.push(c);
  }

  /* One ceiling light per room holding containers (an emissive plate + a light spot) */
  {
    const rooms = new Set(chosen.map((c) => c.room));
    for (const room of rooms) {
      const k = Number(room[0]);
      const back = room[1] === 'b';
      const z0 = hasPartition ? (back ? partZ + WALL_T / 2 : -id) : -id;
      const z1 = hasPartition ? (back ? id : partZ - WALL_T / 2) : id;
      // The light sits a little off the room's middle, away from the stairs (so no emissive plate floats under floor 2's hole)
      let lx = floors === 2 ? -stairSide * iw * 0.3 : 0;
      const lz = (z0 + z1) / 2;
      // 2026-09-12: when that spot falls inside the locked room it moves outside (the locked room has its own light)
      if (k === 1 && lock && inRect(grow(lock.block, 0.5), lx, lz)) {
        const alt = [0, stairSide * iw * 0.3, -stairSide * iw * 0.6].find((x) =>
          !inRect(grow(lock!.block, 0.5), x, lz) && !inRect(grow(stairRect, 0.3), x, lz));
        if (alt !== undefined) lx = alt;
      }
      const ceil = levelY(k) + H;
      const [wx, wz] = rot(lx, lz);
      const g = new THREE.BoxGeometry(1.4, 0.07, 0.5);
      xform(g, { x: wx, y: ceil - 0.04, z: wz }, new THREE.Euler(0, -yaw, 0));
      glow.push(g);
      fixtures.push({ x: wx, y: ceil - 0.4, z: wz, color: lightColor, intensity: LIGHT_INTENSITY, distance: LIGHT_DISTANCE });
    }
  }

  /* ── The map scanner's spot on the roof ───────────────────────────────────── */
  let consoleSpot: Spot | null = null;
  {
    const [ex, ez] = [ladderX, mountZ - ladderSide * (WALL_T / 2 + 0.85)];
    for (let a = 0; a < 60 && !consoleSpot; a++) {
      const lx = rng.range(-iw + 1.6, iw - 1.6), lz = rng.range(-id + 1.6, id - 1.6);
      if (inRect(grow(hatch, 1.8), lx, lz)) continue;
      if (Math.hypot(lx - ex, lz - ez) < 2.5) continue;
      const [wx, wz] = rot(lx, lz);
      // Facing the middle of the roof (its back toward the parapet)
      consoleSpot = { x: wx, y: roofY, z: wz, yaw: Math.atan2(cz - wz, cx - wx) - Math.PI / 2 };
    }
    if (!consoleSpot) {
      const [wx, wz] = rot(-ladderX * 0.5, -mountZ * 0.5 - ladderSide * 3);
      consoleSpot = { x: wx, y: roofY, z: wz, yaw };
    }
    // The antenna mast (at the roof's edge). 2026-09-12: a thin collider on the mast — it used to be drawing only, so a body walked through it.
    const ax = stairSide * (iw - 0.8), az = -id + 0.8;
    solid(ax, az, 0.08, 0.08, roofY, 3.2, false, 'building', METAL_DARK, METAL);
    solid(ax, az, 0.5, 0.04, roofY + 2.6, 0.06, false, null, METAL, METAL);
    const [mx, mz] = rot(ax, az);
    const tip = new THREE.BoxGeometry(0.12, 0.12, 0.12);
    xform(tip, { x: mx, y: roofY + 3.25, z: mz });
    glow.push(tip);
  }

  /* ── The nav (smoke · debug) ──────────────────────────────────────────────── */
  const rooms: StructureNav['rooms'] = [];
  for (let k = 0; k < floors; k++) {
    if (hasPartition) {
      rooms.push({ k, x0: -iw, x1: iw, z0: -id, z1: partZ - WALL_T / 2 });
      rooms.push({ k, x0: -iw, x1: iw, z0: partZ + WALL_T / 2, z1: id });
    } else {
      rooms.push({ k, x0: -iw, x1: iw, z0: -id, z1: id });
    }
  }
  const nav: StructureNav = {
    cx, cz, yaw, halfW, halfD,
    levels: Array.from({ length: floors }, (_, k) => levelY(k)),
    doorOut: [doorX, -halfD - FLOOR_OVERHANG - 1.4],
    doorIn: [doorX, -id + 0.8],
    rooms,
    stairBottom: floors === 2 ? [sXc, (stairFace + sBottomZ) / 2] : null,
    stairTop: floors === 2 ? [sXc, sTopZ + stairRoom * STAIR_ARRIVAL / 2] : null,
    breach,
    locked: lock ? { k: 1, ...lock.interior } : null,
    vents,
  };

  return {
    parts, glow,
    containers: chosen.map((c) => c.spot),
    basementContainers: basementSpots,
    console: consoleSpot, door, lockedDoor, lockedContainers: lockedSpots, turrets, basementY: pit ? yB : y0,
    ladders, windows, fixtures, floors, roofY, nav,
  };
}

/**
 * A crash-landed ship. It has no basement, and the hull, **torn open at the top**, is the room itself — with no
 * ceiling there is no roof and no scanner (2026-09-11, user's decision: the map scanner is only on outpost · lab
 * roofs). It holds containers, so it gets one emergency-light spot.
 *
 * 2026-09-12 — the colliders are measured **from the drawn mesh**. Before there was ① an upright box on a tilted side
 * plate, ② no collider at all on the nose · wings · rear ramp (one could walk forward straight through the nose), and
 * ③ an upright cylinder on an engine nacelle lying down. The nose · engines also used Euler order `XYZ`, so they were
 * laid down about the **world X axis** and pointed a different way from the hull whenever the ship was rotated →
 * `YXZ` (yaw last). The front side plates narrow inward while the container spots used the rear width, so the front
 * containers stood **outside** the side plate — that is fixed too.
 */
export function buildWreck(ctx: BuildCtx, plan: BuildingPlan, rng: Random): BuildingOut {
  const { cx, cz, yaw, y0, halfW, halfD, wallH } = plan;
  const parts: THREE.BufferGeometry[] = [];
  const glow: THREE.BufferGeometry[] = [];
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  const rot = (lx: number, lz: number): [number, number] => [cx + lx * cos - lz * sin, cz + lx * sin + lz * cos];
  /** The math-convention yaw of the hull axis (local +Z). */
  const axisYaw = yaw + Math.PI / 2;
  /** How much side-plate segment `i` (0 = rear · 2 = front) narrows toward the front. */
  const plateShrink = (i: number): number => {
    const mid = -halfD + ((i + 0.5) / 3) * halfD * 2;
    return 1 - Math.max(0, mid / halfD) * 0.35;
  };

  /* The floor (the hull deck) — the plate drawn is the plate stood on */
  {
    const fx = halfW + FLOOR_OVERHANG, fz = halfD + FLOOR_OVERHANG;
    const [wx, wz] = rot(0, 0);
    const g = new THREE.BoxGeometry(fx * 2, SLAB_T, fz * 2);
    xform(g, { x: wx, y: y0 + FLOOR_LIP - SLAB_T / 2, z: wz }, new THREE.Euler(0, -yaw, 0));
    paint(g, METAL_DARK, 0.05, rng);
    parts.push(g);
    ctx.hash.addBox(new THREE.Vector3(wx, y0 - SLAB_T, wz), fx, fz, yaw, SLAB_T, 'slab');
  }

  // The side plates (narrowing toward the front) — three segments each. The collider is a box measured from the tilted plate's vertices.
  for (const s of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const t0 = -halfD + (i / 3) * halfD * 2, t1 = -halfD + ((i + 1) / 3) * halfD * 2;
      if (s < 0 && i === 1 && rng.chance(0.55)) continue;      // a flank torn away = the way in
      const mid = (t0 + t1) / 2;
      const shrink = plateShrink(i);
      const lx = s * halfW * shrink;
      const h = wallH * (0.75 + 0.25 * shrink);
      const [wx, wz] = rot(lx, mid);
      const g = new THREE.BoxGeometry((t1 - t0), h, 0.4);
      xform(g, { x: wx, y: y0 + h / 2, z: wz }, new THREE.Euler(0, -axisYaw, s * 0.12));
      paintGradient(g, METAL_DARK, METAL, y0, y0 + h);
      parts.push(g);
      const f = fitBox(g, axisYaw);
      const base = Math.max(f.yMin, y0 - SLAB_T);
      ctx.hash.addBox(new THREE.Vector3(f.x, base, f.z), f.halfX, f.halfZ, axisYaw, f.yMax - base, 'building');
    }
  }

  // The rear bulkhead (an open ramp)
  let rampOut = -(halfD + FLOOR_OVERHANG + 3.4);
  {
    for (const s of [-1, 1]) {
      const seg = halfW - DOOR_W / 2;
      if (seg < 0.4) break;
      const [px, pz] = rot(s * (halfW - seg / 2), -halfD);
      const g = new THREE.BoxGeometry(seg, wallH, 0.4);
      xform(g, { x: px, y: y0 + wallH / 2, z: pz }, new THREE.Euler(0, -yaw, 0));
      paintGradient(g, METAL_DARK, METAL, y0, y0 + wallH);
      parts.push(g);
      ctx.hash.addBox(new THREE.Vector3(px, y0, pz), seg / 2, 0.2, yaw, wallH, 'building');
    }
    /* The ramp: a plate running from the deck's end (its high end = the deck top) down to the ground. It tilts along
     * the hull axis (`rotateX` first, yaw after), and what is stepped on is a ramp collider of the same tilt. */
    const len = 2.6, rise = 0.3, thick = 0.16;
    const highZ = -(halfD + FLOOR_OVERHANG - 0.1);
    const midZ = highZ - len / 2;
    const tilt = Math.atan2(rise, len);
    const topMid = y0 + FLOOR_LIP - rise / 2;
    const [rx, rz] = rot(0, midZ);
    const ramp = new THREE.BoxGeometry(DOOR_W, thick, len);
    ramp.rotateX(-tilt);
    xform(ramp, { x: rx, y: topMid - thick / 2, z: rz }, new THREE.Euler(0, -yaw, 0));
    paint(ramp, METAL, 0.06, rng);
    parts.push(ramp);
    const base = y0 - 0.8;
    ctx.hash.addRamp(new THREE.Vector3(rx, base, rz), len / 2, DOOR_W / 2, axisYaw, (y0 + FLOOR_LIP) - base, rise, 'building');
    rampOut = highZ - len - 1.4;
  }

  // The nose (a crumpled cone) · engine nacelles · a broken wing
  {
    const nose = new THREE.CylinderGeometry(halfW * 0.42, halfW * 0.9, halfD * 0.8, 7);
    const [nx, nz] = rot(0, halfD + halfD * 0.32);
    xform(nose, { x: nx, y: y0 + wallH * 0.45, z: nz }, new THREE.Euler(Math.PI / 2 + 0.18, -yaw, 0, 'YXZ'));
    paintGradient(nose, METAL, METAL_DARK);
    parts.push(nose);
    // The nose collider = the convex outline of the cone visible above ground (measured like rocks · spires)
    {
      const pc = propHullOf(ctx, nose, new THREE.Matrix4());
      if (pc) {
        const base = ctx.terrain.getHeightAt(pc.x, pc.z) - 0.3;
        ctx.hash.addHull(new THREE.Vector3(pc.x, base, pc.z), pc.hull, Math.max(0.1, pc.top - base), 'building');
      }
    }
    for (const s of [-1, 1]) {
      /* The wing: a plate whose outer end is lifted by a roll about the hull axis. So that the outer part, which can
       * be walked under, is not blocked, its length is cut into segments and each segment gets a ramp collider running
       * **from the plate's bottom face** to its top face (as one wedge, the empty air under the lifted wing becomes a
       * wall). */
      const wingLen = halfW * 1.5, wingT = 0.3, wingD = halfD * 0.6;
      const wing = new THREE.BoxGeometry(wingLen, wingT, wingD);
      const wcx = s * halfW * 1.5, wcz = -halfD * 0.25, wcy = y0 + 0.5;
      const [px, pz] = rot(wcx, wcz);
      const roll = rng.range(0.2, 0.5);
      xform(wing, { x: px, y: wcy, z: pz }, new THREE.Euler(0, -yaw, s * roll));
      paint(wing, s < 0 ? RUST : METAL, 0.09, rng);
      parts.push(wing);
      {
        const segs = Math.max(2, Math.ceil(wingLen / 1.5));
        const sr = Math.sin(roll), cr = Math.cos(roll);
        const halfT = (wingT / 2) * cr;
        const ground = y0;
        for (let j = 0; j < segs; j++) {
          // v = the length measured outward from the wing's middle (the outer end is higher)
          const v0 = -wingLen / 2 + (j / segs) * wingLen, v1 = -wingLen / 2 + ((j + 1) / segs) * wingLen;
          const topHi = wcy + v1 * sr + halfT;
          if (topHi <= ground - 0.05) continue;                  // entirely below the deck · the ground
          const under = wcy + v0 * sr - halfT;
          const base = Math.max(ground - 0.5, under);
          const [sx, sz] = rot(wcx + s * ((v0 + v1) / 2) * cr, wcz);
          ctx.hash.addRamp(new THREE.Vector3(sx, base, sz), ((v1 - v0) / 2) * cr, wingD / 2, s > 0 ? yaw : yaw + Math.PI,
            topHi - base, (v1 - v0) * sr, 'building');
        }
      }
      const nacelle = new THREE.CylinderGeometry(0.7, 0.85, 2.4, 8);
      const [ex, ez] = rot(s * halfW * 1.7, -halfD * 0.7);
      xform(nacelle, { x: ex, y: y0 + 0.7, z: ez }, new THREE.Euler(Math.PI / 2, -yaw, 0, 'YXZ'));
      paint(nacelle, METAL_DARK, 0.06, rng);
      parts.push(nacelle);
      const f = fitBox(nacelle, yaw);
      const base = Math.max(f.yMin, y0 - 0.5);
      ctx.hash.addBox(new THREE.Vector3(f.x, base, f.z), f.halfX, f.halfZ, yaw, f.yMax - base, 'building');
    }
    for (const s of [-1, 1]) {
      const g = new THREE.BoxGeometry(0.18, 0.12, 0.5);
      const [px, pz] = rot(s * halfW * 0.85, halfD * 0.3);
      xform(g, { x: px, y: y0 + wallH * 0.8, z: pz }, new THREE.Euler(0, -yaw, 0));
      glow.push(g);
    }
  }

  // Container spots — along the deck, a hand's width in from the inner face of the side plate at that spot
  const spots: Spot[] = [];
  for (let lz = -halfD + 1.6; lz <= halfD - 1.6; lz += 2.0) {
    const i = Math.max(0, Math.min(2, Math.floor(((lz + halfD) / (halfD * 2)) * 3)));
    const inner = halfW * plateShrink(i) - 1.1;
    for (const s of [-1, 1]) {
      const [wx, wz] = rot(s * inner, lz);
      spots.push({ x: wx, y: y0, z: wz, yaw: yaw + (s < 0 ? 0 : Math.PI) });
    }
  }
  for (let i = spots.length - 1; i > 0; i--) { const j = rng.int(0, i); const t = spots[i]; spots[i] = spots[j]; spots[j] = t; }

  const [fxw, fzw] = rot(0, halfD * 0.3);
  const fixtures: LightFixture[] = [{ x: fxw, y: y0 + wallH * 0.75, z: fzw, color: 0xff9a78, intensity: LIGHT_INTENSITY * 0.7, distance: LIGHT_DISTANCE }];

  const nav: StructureNav = {
    cx, cz, yaw, halfW, halfD, levels: [y0],
    doorOut: [0, rampOut], doorIn: [0, -halfD + 1.2],
    rooms: [], stairBottom: null, stairTop: null, breach: null, locked: null, vents: [],
  };

  return {
    parts, glow, containers: spots.slice(0, Math.max(0, plan.containers)), basementContainers: [], console: null, door: null,
    lockedDoor: null, lockedContainers: [], turrets: [],
    basementY: y0, ladders: [], windows: [], fixtures, floors: 1, roofY: Number.NaN, nav,
  };
}

/** The colours the containers · consoles · doors use (exported so the same palette is used outside the parts too). */
export const PALETTE = { CONCRETE, CONCRETE_DARK, METAL, METAL_DARK, RUST };

/** Merges `parts` into one. null when empty (merging with an empty geometry makes three throw). */
export function mergeOrNull(parts: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (parts.length === 0) return null;
  return merge(parts);
}
