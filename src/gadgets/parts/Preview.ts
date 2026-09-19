/**
 * src/gadgets/parts/Preview.ts — **where does the `place` gadget in hand stand if it is put down now, and may it
 * stand there?** (2026-09-11)
 *
 * The test is `computePlacement`, **one** function. The preview runs it every frame (the placement ghost +
 * `GadgetsRef.placement`), and a left click (`Deploy.use`'s place path) places from the result of running that same
 * function again at that moment — green stands it up, red refuses it for the same reason. The host only re-checks a
 * client's `gadq place` lightly, through `resolveRemotePlace` (the item is already consumed on the client, so when
 * the drone is gone it is stood up on the floor below it).
 *
 * The aim ray is the camera reticle (`PlayerWeaponHost.getAimRay`), cut where it leaves the horizontal
 * `GADGET_PLACE_RANGE` circle around the feet. When nothing was hit inside that circle, or a wall was hit, it is
 * dropped to the surface below.
 */
import * as THREE from 'three';
import {
  GADGET_JUMPPAD_RADIUS, GADGET_PLACE_LARGE_MAX_STEP, GADGET_PLACE_LARGE_MIN_NORMAL_Y, GADGET_PLACE_RANGE,
  GADGET_PLACE_SMALL_MIN_NORMAL_Y, THUMPER_GROUND_R, isLargeDeployable, isMountableDeployable,
  type DeployableKind, type GadgetDef, type GadgetId, type GameContext, type Obstacle, type PlacementPreview,
  type PlayerWeaponHost,
} from '@/shared';
import { gadgetDef } from '../GadgetDefs';
import { BARRICADE_HALF } from '../Deployable';
import { PLACE_CLEARANCE, PLACE_VERTICAL_REACH } from '../model';
import type { GadgetSystem } from '../GadgetSystem';

/* ── refusal reasons (the UI prints them verbatim) ── */
const R_NOWHERE = '설치할 수 없는 곳이다';
const R_FAR = '너무 멀다';
const R_SLOPE = '바닥이 너무 기울었다';
const R_UNEVEN = '바닥이 고르지 않다';
const R_SPACE = '공간이 부족하다';
const R_OVERLAP = '다른 설치물과 겹친다';
const R_DRONE_LARGE = '드론 위에는 올릴 수 없다';
const R_DRONE_TAKEN = '이미 드론에 설치물이 있다';
/**
 * 2026-09-15 (the thumper): ground `WorldRef.burrowGroundOk` said no to — a building floor · a roof · rock · water ·
 * a hazard · on top of a nest.
 */
export const R_BURROW = '땅굴벌레가 파고들 수 없는 땅이다';

/* ── geometry classification (values that decide "what did the ray hit", not a balance number) ── */
/**
 * A hit face whose normal y is below this counts as a wall · ceiling rather than a floor → it steps back one pace
 * and is dropped to the floor below.
 */
const WALL_NORMAL_Y = 0.3;
/** The horizontal distance (m) it steps back along the ray when a wall was hit. */
const WALL_BACKOFF = 0.35;
/** The longest ray (m) cast when looking up — when the ray does not end inside the circle around the feet. */
const RAY_CAP = 40;
/** The margin (m) above foot height the surface search looks at — it still lifts onto a chest-high box's top face. */
const DROP_FEET_MARGIN = 0.5;
/**
 * A surface floating this far (m) above the terrain is an obstacle's top face (a building floor · a crate), so its
 * normal is taken as up.
 */
const OBSTACLE_TOP_EPS = 0.05;
/** How far (m) the host trusts a client's drone mount request — loose enough for the replica interpolation lag. */
const MOUNT_TOLERANCE = 4;
/** The radius (m) the turret base and its legs take up (the turret silhouette in `GadgetVisuals`). */
const TURRET_FOOTPRINT = 0.6;
const TURRET_HEIGHT = 1.15;
/** The radius · height (m) of a small deployable (mine · remote mine). */
const SMALL_FOOTPRINT = 0.3;
const SMALL_HEIGHT = 0.3;
const JUMPPAD_HEIGHT = 0.35;
/** The radius · height (m) of the thumper's base and hammer post (its silhouette in `GadgetVisuals`). */
const THUMPER_FOOTPRINT = 0.45;
const THUMPER_HEIGHT = 1.5;

/** The spot one kind occupies. The coordinates are deployable-local (before the yaw rotation). */
interface Footprint {
  /** The obstacle-overlap circles `[x, z, r, …]`. */
  circles: readonly number[];
  /** The area query radius — it holds every circle. */
  reach: number;
  /** Only an obstacle reaching into this height "blocks the space". */
  height: number;
  /** The flatness samples `[x, z, …]` (large deployables only). */
  samples: readonly number[];
  /** The radius of the ghost footprint ring (0 = no ring). */
  ringX: number;
  ringZ: number;
}

const FOOTPRINTS = new Map<DeployableKind, Footprint>();

function ringSamples(r: number, n: number): number[] {
  const out = [0, 0];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push(Math.cos(a) * r, Math.sin(a) * r);
  }
  return out;
}

function footprintOf(kind: DeployableKind): Footprint {
  const hit = FOOTPRINTS.get(kind);
  if (hit) return hit;
  let fp: Footprint;
  switch (kind) {
    case 'barricade': {
      const hx = BARRICADE_HALF.x, hz = BARRICADE_HALF.z;
      const cx = hx * 0.66;
      const samples: number[] = [];
      for (const x of [-hx, -hx * 0.5, 0, hx * 0.5, hx]) samples.push(x, -hz, x, 0.5);
      // The feet reach about 0.6 m toward +z (`GadgetVisuals` barricade) → the circle centres are pushed over
      fp = { circles: [-cx, 0.1, 0.75, 0, 0.1, 0.75, cx, 0.1, 0.75], reach: hx + 0.4, height: BARRICADE_HALF.y * 2, samples, ringX: hx + 0.2, ringZ: 0.8 };
      break;
    }
    case 'jumpPad': {
      const r = GADGET_JUMPPAD_RADIUS;
      fp = { circles: [0, 0, r], reach: r, height: JUMPPAD_HEIGHT, samples: ringSamples(r * 0.9, 8), ringX: r, ringZ: r };
      break;
    }
    case 'turret':
      fp = { circles: [0, 0, TURRET_FOOTPRINT], reach: TURRET_FOOTPRINT, height: TURRET_HEIGHT, samples: ringSamples(TURRET_FOOTPRINT, 6), ringX: TURRET_FOOTPRINT + 0.1, ringZ: TURRET_FOOTPRINT + 0.1 };
      break;
    case 'thumper':
      // 2026-09-15: the small rule (slope `GADGET_PLACE_SMALL_MIN_NORMAL_Y`), but the space is measured against
      // its own silhouette. Ghost ring = the ground-test radius (`THUMPER_GROUND_R`)
      fp = { circles: [0, 0, THUMPER_FOOTPRINT], reach: THUMPER_FOOTPRINT, height: THUMPER_HEIGHT, samples: [], ringX: THUMPER_GROUND_R, ringZ: THUMPER_GROUND_R };
      break;
    default:
      fp = { circles: [0, 0, SMALL_FOOTPRINT], reach: SMALL_FOOTPRINT, height: SMALL_HEIGHT, samples: [], ringX: 0, ringZ: 0 };
      break;
  }
  FOOTPRINTS.set(kind, fp);
  return fp;
}

/* scratch — this file's own (model's `_a…` are already held by the caller (Wire)) */
const _o = new THREE.Vector3(), _dir = new THREE.Vector3(), _n = new THREE.Vector3(), _mp = new THREE.Vector3();

export function createPreview(): PlacementPreview {
  return { gadget: 'barricade', kind: 'barricade', valid: false, reason: null, position: new THREE.Vector3(), yaw: 0, mount: null };
}

/** The values last sent on `gadget:placementChanged`. */
export interface PreviewKey { gadget: GadgetId | null; valid: boolean; reason: string | null; mount: string | null }
export function createPreviewKey(): PreviewKey {
  return { gadget: null, valid: false, reason: null, mount: null };
}

function fail(out: PlacementPreview, reason: string): PlacementPreview {
  out.valid = false;
  out.reason = reason;
  return out;
}

/**
 * 2026-09-15 (the thumper): is the ground within `THUMPER_GROUND_R` of this spot ground the sandworm can dig into —
 * the test is world's (`WorldRef.burrowGroundOk`, the same function as the worm director's eruption-site check), and
 * a world that does not have it yet **refuses**. The preview, the left click and the host's re-check all call this.
 */
export function burrowGroundOk(world: NonNullable<GameContext['world']>, x: number, z: number): boolean {
  return world.burrowGroundOk?.(x, z, THUMPER_GROUND_R) ?? false;
}

/** Is a deployable already mounted on this drone? */
export function droneOccupied(sys: GadgetSystem, droneId: string): boolean {
  for (const d of sys.deployables) if (!d.removing && d.mount === droneId) return true;
  return false;
}

/**
 * The `t` at which the ray leaves the horizontal circle of radius `r` around the feet (the ray is taken to start
 * inside the circle). −1 = it never meets the circle.
 */
function exitT(ox: number, oz: number, dx: number, dz: number, fx: number, fz: number, r: number): number {
  const px = ox - fx, pz = oz - fz;
  const a = dx * dx + dz * dz;
  const c = px * px + pz * pz - r * r;
  if (a < 1e-8) return c <= 0 ? RAY_CAP : -1;
  const b = 2 * (px * dx + pz * dz);
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const t = (-b + Math.sqrt(disc)) / (2 * a);
  return t > 0 ? Math.min(t, RAY_CAP) : -1;
}

/**
 * Does the circle (world XZ) overlap the obstacle's cross-section — a box by its OBB, a convex column by its
 * outline, anything else as a cylinder.
 */
function circleHitsObstacle(o: Obstacle, cx: number, cz: number, r: number): boolean {
  const dx = cx - o.position.x, dz = cz - o.position.z;
  if (o.box) {
    const b = o.box;
    const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
    const lx = dx * c + dz * s, lz = -dx * s + dz * c;
    const qx = lx < -b.halfX ? -b.halfX : lx > b.halfX ? b.halfX : lx;
    const qz = lz < -b.halfZ ? -b.halfZ : lz > b.halfZ ? b.halfZ : lz;
    const ex = lx - qx, ez = lz - qz;
    return ex * ex + ez * ez <= r * r;
  }
  const hull = o.hull;
  if (hull && hull.points.length >= 6) {
    const p = hull.points;
    const m = p.length / 2;
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      const ax = p[i * 2], az = p[i * 2 + 1];
      const ex = p[j * 2] - ax, ez = p[j * 2 + 1] - az;
      const len = Math.sqrt(ex * ex + ez * ez);
      if (len < 1e-9) continue;
      // Counter-clockwise outline: positive = outside that edge
      if (((cx - ax) * ez - (cz - az) * ex) / len > r) return false;
    }
    return true;
  }
  const rr = o.radius + r;
  return dx * dx + dz * dz <= rr * rr;
}

/**
 * **The one placement test.** Where (`position` · `yaw` · `mount`) `def` stands if it is put at the aim point now,
 * and whether it may (`valid` · `reason`). Fills `out` and returns it — no events, no state changes.
 */
export function computePlacement(sys: GadgetSystem, def: GadgetDef, out: PlacementPreview): PlacementPreview {
  const ctx = sys.ctx;
  const kind = def.deployable ?? 'mine';
  out.gadget = def.id;
  out.kind = kind;
  out.valid = false;
  out.reason = null;
  out.mount = null;
  const p = ctx.player;
  const world = ctx.world;
  if (!p) return fail(out, R_NOWHERE);
  out.yaw = p.yaw;
  out.position.copy(p.position);
  if (!world || !world.ready) return fail(out, R_NOWHERE);

  const large = isLargeDeployable(kind);
  const feet = p.position;

  // ── The aim ray (the reticle), cut at the horizontal radius around the feet ──
  const host = p as unknown as Partial<PlayerWeaponHost>;
  if (typeof host.getAimRay === 'function') host.getAimRay(_o, _dir);
  else { p.getEyePosition(_o); p.getForward(_dir); }
  if (_dir.lengthSq() < 1e-8) return fail(out, R_NOWHERE);
  _dir.normalize();
  const tMax = exitT(_o.x, _o.z, _dir.x, _dir.z, feet.x, feet.z, GADGET_PLACE_RANGE);
  if (tMax <= 0) return fail(out, R_FAR);

  const hit = world.raycast(_o, _dir, tMax);

  // ── A drone body nearer than the world means it mounts on the drone ──
  const drones = ctx.drones;
  const droneHit = drones ? drones.raycast(_o, _dir, hit ? hit.distance : tMax) : null;
  if (droneHit && (!hit || droneHit.distance < hit.distance)) {
    const drone = droneHit.drone;
    drone.getMountPoint(out.position);
    if (large || !isMountableDeployable(kind)) return fail(out, R_DRONE_LARGE);
    out.mount = drone.id;
    if (droneOccupied(sys, drone.id)) return fail(out, R_DRONE_TAKEN);
    out.valid = true;
    return out;
  }

  // ── The floor ──
  let drop = false;
  if (hit) {
    out.position.copy(hit.point);
    _n.copy(hit.normal);
    if (_n.y < WALL_NORMAL_Y) {
      // A wall · a ceiling's underside: step back one pace along the ray and take the floor under it
      const flat = Math.hypot(_dir.x, _dir.z);
      if (flat > 1e-4) {
        out.position.x -= (_dir.x / flat) * WALL_BACKOFF;
        out.position.z -= (_dir.z / flat) * WALL_BACKOFF;
      }
      drop = true;
    }
  } else {
    // Nothing was hit inside the radius → cut at the edge of the radius and take the surface under it
    out.position.copy(_o).addScaledVector(_dir, tMax);
    drop = true;
  }
  const x = out.position.x, z = out.position.z;
  if (!world.isInsideBounds(x, z)) return fail(out, R_NOWHERE);
  if (drop) {
    const probe = Math.min(out.position.y, feet.y + DROP_FEET_MARGIN);
    const y = world.getSurfaceY(x, z, probe);
    out.position.y = y;
    if (y > world.getHeightAt(x, z) + OBSTACLE_TOP_EPS) _n.set(0, 1, 0);
    else world.getNormalAt(x, z, _n);
  }
  const y = out.position.y;
  if (Math.abs(y - feet.y) > PLACE_VERTICAL_REACH) return fail(out, R_FAR);
  // Nothing is stood up on a moving platform (the tram deck) — a deployable does not travel with the platform
  const standing = world.getStandingObstacle(x, z, y);
  if (standing && standing.velocity) return fail(out, R_NOWHERE);

  // ── Slope ──
  if (_n.y < (large ? GADGET_PLACE_LARGE_MIN_NORMAL_Y : GADGET_PLACE_SMALL_MIN_NORMAL_Y)) return fail(out, R_SLOPE);

  // ── The thumper: is this ground the sandworm can dig into (2026-09-15) — world answers, and a world without
  //    the query (parallel development) places it nowhere ──
  if (kind === 'thumper' && !burrowGroundOk(world, x, z)) return fail(out, R_BURROW);

  const fp = footprintOf(kind);
  const cos = Math.cos(out.yaw), sin = Math.sin(out.yaw);

  // ── Flatness (large deployables): the highest − the lowest surface height inside the footprint ──
  if (large && fp.samples.length > 0) {
    let lo = y, hi = y;
    for (let i = 0; i < fp.samples.length; i += 2) {
      const lx = fp.samples[i], lz = fp.samples[i + 1];
      const sx = x + lx * cos + lz * sin, sz = z - lx * sin + lz * cos;
      if (!world.isInsideBounds(sx, sz)) return fail(out, R_NOWHERE);
      const sy = world.getSurfaceY(sx, sz, y);
      if (sy < lo) lo = sy;
      if (sy > hi) hi = sy;
      if (hi - lo > GADGET_PLACE_LARGE_MAX_STEP) return fail(out, R_UNEVEN);
    }
  }

  // ── Space: obstacles overlapping the footprint circles (minus the floor it stands on · the slab overhead) ──
  const near = world.getObstaclesNear(x, z, fp.reach);
  const floorTop = y + GADGET_PLACE_LARGE_MAX_STEP;
  const ceil = y + fp.height;
  for (let k = 0; k < near.length; k++) {
    const o = near[k];
    if (o.position.y + o.height <= floorTop) continue;
    if (o.position.y >= ceil) continue;
    for (let i = 0; i < fp.circles.length; i += 3) {
      const lx = fp.circles[i], lz = fp.circles[i + 1], r = fp.circles[i + 2];
      const cx = x + lx * cos + lz * sin, cz = z - lx * sin + lz * cos;
      if (circleHitsObstacle(o, cx, cz, r)) return fail(out, R_SPACE);
    }
  }

  // ── Clearance from other deployables (the current `PLACE_CLEARANCE` rule, doubled for a barricade) ──
  for (const d of sys.deployables) {
    if (d.removing || d.mount) continue;
    if (d.kind === 'smoke' || d.kind === 'fire' || d.kind === 'domeShield') continue;
    const clearance = d.kind === 'barricade' || kind === 'barricade' ? PLACE_CLEARANCE * 2 : PLACE_CLEARANCE;
    if (d.position.distanceToSquared(out.position) < clearance * clearance) return fail(out, R_OVERLAP);
  }

  out.valid = true;
  return out;
}

/**
 * Is the hand the **detonator** — the hand weapons leaves behind after the last remote mine was placed (no slot ·
 * quantity 0). `heldItemId` stays the C4 def id all the while, so this is what tells the two apart. The field is not
 * in the contract type, so it is read through a cast.
 */
export function isDetonatorHand(ctx: GameContext): boolean {
  return (ctx.weapons?.remoteState as { detonator?: boolean } | undefined)?.detonator === true;
}

/** The `place` gadget in hand right now, null when there is none. */
function heldPlaceDef(ctx: GameContext): GadgetDef | null {
  if (!ctx.isGameplayActive()) return null;
  if (isDetonatorHand(ctx)) return null;
  const p = ctx.player;
  // 2026-09-13: inside the rover — no placement ghost
  if (!p || p.isDead || p.isDowned || p.droneControl || p.roverRide) return null;
  const itemId = ctx.weapons?.remoteState?.heldItemId;
  if (!itemId) return null;
  const gid = ctx.loot?.getItemDef(itemId)?.gadgetId as GadgetId | undefined;
  if (!gid) return null;
  const def = gadgetDef(gid);
  return def && def.use === 'place' && def.deployable ? def : null;
}

function emitIfChanged(sys: GadgetSystem): void {
  const sent = sys.previewSent;
  const pv = sys.previewActive ? sys.preview : null;
  const gadget = pv ? pv.gadget : null;
  const valid = pv ? pv.valid : false;
  const reason = pv ? pv.reason : null;
  const mount = pv ? pv.mount : null;
  if (sent.gadget === gadget && sent.valid === valid && sent.reason === reason && sent.mount === mount) return;
  sent.gadget = gadget; sent.valid = valid; sent.reason = reason; sent.mount = mount;
  sys.ctx.bus.emit('gadget:placementChanged', { gadget, valid, reason, mount });
}

/** Every frame: with a `place` gadget in hand, the test → the placement ghost → (only on a change) the event. */
export function updatePreview(sys: GadgetSystem, ctx: GameContext): void {
  const def = heldPlaceDef(ctx);
  if (!def || !def.deployable) { resetPreview(sys); return; }
  const pv = computePlacement(sys, def, sys.preview);
  sys.previewActive = true;
  const fp = footprintOf(pv.kind);
  sys.visuals.showGhost(pv.kind, pv.position, pv.yaw, pv.valid, ctx.time, pv.mount ? 0 : fp.ringX, fp.ringZ);
  emitIfChanged(sys);
}

/** Hides the placement ghost and puts `placement` back to null (mission reset · the hub · taken out of the hand). */
export function resetPreview(sys: GadgetSystem): void {
  sys.previewActive = false;
  sys.visuals.hideGhost();
  emitIfChanged(sys);
}

/**
 * The host: re-checks a client's `gadq place` lightly. Fixes `pos` in place.
 * Returns the drone id to mount on, null = the floor, false = refused (off the map).
 */
export function resolveRemotePlace(sys: GadgetSystem, def: GadgetDef, pos: THREE.Vector3, mount: string | null): string | null | false {
  const world = sys.ctx.world;
  if (world && world.ready && !world.isInsideBounds(pos.x, pos.z)) return false;
  if (mount && isMountableDeployable(def.deployable)) {
    const drone = sys.ctx.drones?.getDrone(mount) ?? null;
    if (drone && !droneOccupied(sys, mount)) {
      drone.getMountPoint(_mp);
      if (_mp.distanceTo(pos) <= MOUNT_TOLERANCE) { pos.copy(_mp); return mount; }
    }
  }
  // The floor (or, when the drone is gone, the floor under it): a surface that can be stepped onto near the
  // requested height
  if (world && world.ready) pos.y = world.getSurfaceY(pos.x, pos.z, pos.y + 0.2);
  // 2026-09-15: the thumper is the thing that summons the sandworm, so the host re-runs the ground test too — the
  // same function on the same seed, so it always agrees with an honest client
  if (def.deployable === 'thumper' && world && world.ready && !burrowGroundOk(world, pos.x, pos.z)) return false;
  return null;
}
