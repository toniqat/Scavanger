/**
 * src/world/rover/parts/Body.ts — the rover's **body mesh · wheels · turret · collider · placement · wreck look** (R2, 2026-09-13).
 *
 * The axis convention is the tram's (`rails/model`): local +X = forward (length), local +Z = width, and the root's
 * Euler.y = −yaw, so forward is world `(cos yaw, sin yaw)` (`RoverVehicleDef.yaw`). root → `tilt` (terrain pitch · roll) → body · glow · turret · wheels.
 *
 * **There are no point lights** (the raid budget has zero spare — the CLAUDE.md light rule). The headlights, marker
 * lights and the roof beacon are vertex colours on an unlit `MeshBasicMaterial`, so they look self-lit. So is the muzzle flash.
 *
 * The collider is one box around the body (`Obstacle.box`, kind `rover`) and **it has no `velocity`** — it is not a
 * deck to ride (boarding puts you inside, and player seats the body). It is moved every frame with `hash.move`.
 */
import * as THREE from 'three';
import { Layers, ROVER_HALF_LENGTH, ROVER_HALF_WIDTH, ROVER_HULL_H, type Random } from '@/shared';
import { merge, paint, paintGradient, xform } from '../../build';
import type { ObstacleEntry, SpatialHash } from '../../SpatialHash';

const KHAKI = new THREE.Color(0x7a735a);
const KHAKI_DARK = new THREE.Color(0x48452f);
const PANEL = new THREE.Color(0x5d594a);
const RUBBER = new THREE.Color(0x1d1d1c);
const RIM = new THREE.Color(0x55544c);
const GLASS = new THREE.Color(0x1c2a31);
const HEADLIGHT = new THREE.Color(0xfff0c4);
const MARKER = new THREE.Color(0xff8a2a);
const BEACON = new THREE.Color(0x5fe0ff);
/** The colour multiplied into a destroyed body (vertex colour × material colour). */
const WRECK_TINT = new THREE.Color(0x3b3531);

/** The wheel radius (m) — the wheel angle = distance travelled / this value. */
export const ROVER_WHEEL_R = 0.55;
const WHEEL_X = [-2.55, -0.85, 0.85, 2.55];
/** The turret ring's local spot (on the body's top face). */
const TURRET_X = 0.55;

export interface RoverBody {
  /** Position + yaw. */
  root: THREE.Group;
  /** Terrain pitch (about the local Z axis) · roll (about the local X axis). */
  tilt: THREE.Group;
  turret: THREE.Group;
  /** The muzzle tip (its world position is read off it). */
  barrelTip: THREE.Object3D;
  muzzleFlash: THREE.Mesh;
  wheels: THREE.Mesh[];
  hullEntry: ObstacleEntry;
  hullMat: THREE.MeshStandardMaterial;
  wheelMat: THREE.MeshStandardMaterial;
  glowMat: THREE.MeshBasicMaterial;
  wheelAngle: number;
}

/** Builds the body. The geometries and materials it makes are handed back in `geos` · `mats` (`Rover.dispose` throws them away). */
export function buildRoverBody(hash: SpatialHash, rng: Random, geos: THREE.BufferGeometry[], mats: THREE.Material[]): RoverBody {
  const L = ROVER_HALF_LENGTH, W = ROVER_HALF_WIDTH;

  /* ── The body (a single vertex-colour pass) ─────────────────────────── */
  const hull: THREE.BufferGeometry[] = [];
  const box = (
    into: THREE.BufferGeometry[], sx: number, sy: number, sz: number, x: number, y: number, z: number,
    color: THREE.Color, rot?: THREE.Euler, bottom?: THREE.Color,
  ): void => {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    xform(g, { x, y, z }, rot);
    if (bottom) paintGradient(g, bottom, color); else paint(g, color, 0.04, rng);
    into.push(g);
  };
  box(hull, L * 2 * 0.96, 0.9, W * 2 * 0.86, 0, 1.0, 0, KHAKI, undefined, KHAKI_DARK);        // lower hull
  box(hull, L * 2 * 0.84, 0.72, W * 2, -0.25, 1.81, 0, KHAKI);                                // upper hull (wider, over the fenders)
  box(hull, 1.55, 0.14, W * 2 * 0.98, L - 0.55, 1.62, 0, PANEL, new THREE.Euler(0, 0, -0.62)); // sloped front armour
  box(hull, 0.95, 0.14, W * 2 * 0.86, L - 0.22, 0.9, 0, KHAKI_DARK, new THREE.Euler(0, 0, 0.7)); // lower nose plate
  box(hull, 0.14, 1.5, W * 2 * 0.9, -L + 0.1, 1.3, 0, KHAKI_DARK);                            // rear plate
  box(hull, 0.06, 0.95, 1.05, -L + 0.02, 1.25, 0, PANEL);                                     // rear door outline
  for (const side of [-1, 1]) {
    box(hull, L * 2 * 0.9, 0.1, 0.34, 0, 1.2, side * (W - 0.12), KHAKI_DARK);                  // fender
    box(hull, L * 2 * 0.86, 0.36, 0.08, 0, 1.0, side * (W + 0.02), PANEL);                     // side armour skirt
    box(hull, 0.12, 0.12, 0.3, L - 1.25, 2.22, side * 0.55, GLASS);                            // driver's periscope
    box(hull, 0.7, 0.08, 0.7, -1.4, 2.21, side * 0.6, PANEL);                                  // roof hatch
  }
  box(hull, 0.9, 0.35, 0.5, -1.95, 2.35, -0.85, KHAKI_DARK);                                   // stowage bin
  box(hull, 0.6, 0.25, 0.12, -2.4, 1.7, W + 0.06, RUBBER);                                     // exhaust
  {
    const antenna = new THREE.CylinderGeometry(0.02, 0.025, 1.6, 5);
    xform(antenna, { x: -L + 0.7, y: 2.17 + 0.8, z: W - 0.3 });
    paint(antenna, RIM);
    hull.push(antenna);
  }
  const hullGeo = merge(hull);
  geos.push(hullGeo);
  const hullMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0.32 });
  mats.push(hullMat);

  const root = new THREE.Group();
  root.name = 'rover';
  const tilt = new THREE.Group();
  root.add(tilt);
  const hullMesh = new THREE.Mesh(hullGeo, hullMat);
  hullMesh.name = 'rover_body';
  hullMesh.castShadow = true; hullMesh.receiveShadow = true;
  hullMesh.layers.enable(Layers.PROP);
  tilt.add(hullMesh);

  /* ── Glow (headlights · marker lights · beacon) — unlit vertex colours ───── */
  const glow: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    box(glow, 0.06, 0.16, 0.3, L * 0.96 + 0.02, 1.3, side * 0.95, HEADLIGHT);
    box(glow, 0.05, 0.1, 0.14, -L + 0.02, 1.95, side * (W - 0.25), MARKER);
    box(glow, 0.14, 0.06, 0.05, L * 0.84 - 0.2, 1.72, side * (W + 0.03), MARKER);
  }
  box(glow, 0.08, 0.06, 0.5, -2.95, 2.2, 0, BEACON);
  const glowGeo = merge(glow);
  geos.push(glowGeo);
  const glowMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  mats.push(glowMat);
  const glowMesh = new THREE.Mesh(glowGeo, glowMat);
  glowMesh.name = 'rover_glow';
  tilt.add(glowMesh);

  /* ── The turret ─────────────────────────────────────────────────────── */
  const tur: THREE.BufferGeometry[] = [];
  {
    const ring = new THREE.CylinderGeometry(0.78, 0.86, 0.28, 14);
    xform(ring, { x: 0, y: 0.14, z: 0 });
    paint(ring, KHAKI_DARK, 0.03, rng);
    tur.push(ring);
  }
  box(tur, 1.1, 0.46, 1.0, -0.05, 0.5, 0, KHAKI, undefined, KHAKI_DARK);
  box(tur, 0.3, 0.36, 0.5, 0.55, 0.52, 0, PANEL);
  box(tur, 0.26, 0.2, 0.26, -0.1, 0.83, 0.3, GLASS);
  {
    const barrel = new THREE.CylinderGeometry(0.065, 0.078, 1.7, 8);
    xform(barrel, { x: 1.5, y: 0.52, z: 0.08 }, new THREE.Euler(0, 0, -Math.PI / 2));
    paint(barrel, RIM);
    tur.push(barrel);
    const coax = new THREE.CylinderGeometry(0.035, 0.035, 0.7, 6);
    xform(coax, { x: 1.0, y: 0.42, z: -0.17 }, new THREE.Euler(0, 0, -Math.PI / 2));
    paint(coax, RUBBER);
    tur.push(coax);
  }
  const turGeo = merge(tur);
  geos.push(turGeo);
  const turret = new THREE.Group();
  turret.name = 'rover_turret';
  turret.position.set(TURRET_X, 2.17, 0);
  const turMesh = new THREE.Mesh(turGeo, hullMat);
  turMesh.castShadow = true;
  turMesh.layers.enable(Layers.PROP);
  turret.add(turMesh);
  const barrelTip = new THREE.Object3D();
  barrelTip.position.set(2.36, 0.52, 0.08);
  turret.add(barrelTip);
  const flashGeo = new THREE.ConeGeometry(0.17, 0.6, 7);
  xform(flashGeo, { x: 0, y: 0, z: 0 }, new THREE.Euler(0, 0, -Math.PI / 2));
  geos.push(flashGeo);
  const flashMat = new THREE.MeshBasicMaterial({
    color: 0xffc36a, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  mats.push(flashMat);
  const muzzleFlash = new THREE.Mesh(flashGeo, flashMat);
  muzzleFlash.position.set(2.66, 0.52, 0.08);
  muzzleFlash.scale.setScalar(1e-4);   // hidden = scale 0 (turning `visible` off would drop it from the shader pre-compile)
  muzzleFlash.frustumCulled = false;
  turret.add(muzzleFlash);
  tilt.add(turret);

  /* ── Eight wheels (one shared geometry) ─────────────────────────────── */
  const wheelParts: THREE.BufferGeometry[] = [];
  {
    const tire = new THREE.CylinderGeometry(ROVER_WHEEL_R, ROVER_WHEEL_R, 0.42, 16);
    xform(tire, { x: 0, y: 0, z: 0 }, new THREE.Euler(Math.PI / 2, 0, 0));
    paint(tire, RUBBER, 0.03, rng);
    wheelParts.push(tire);
    const hub = new THREE.CylinderGeometry(0.27, 0.27, 0.44, 8);
    xform(hub, { x: 0, y: 0, z: 0 }, new THREE.Euler(Math.PI / 2, 0, 0));
    paint(hub, RIM);
    wheelParts.push(hub);
    const spoke = new THREE.BoxGeometry(0.09, 0.42, 0.46);   // the one bar that makes the spin visible
    paint(spoke, KHAKI_DARK);
    wheelParts.push(spoke);
  }
  const wheelGeo = merge(wheelParts);
  geos.push(wheelGeo);
  const wheelMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0.1 });
  mats.push(wheelMat);
  const wheels: THREE.Mesh[] = [];
  for (const wx of WHEEL_X) {
    for (const side of [-1, 1]) {
      const m = new THREE.Mesh(wheelGeo, wheelMat);
      m.position.set(wx, ROVER_WHEEL_R, side * (W - 0.2));
      m.castShadow = true;
      tilt.add(m);
      wheels.push(m);
    }
  }

  const hullEntry = hash.addBox(new THREE.Vector3(0, -9999, 0), L, W, 0, ROVER_HULL_H, 'rover');

  return { root, tilt, turret, barrelTip, muzzleFlash, wheels, hullEntry, hullMat, wheelMat, glowMat, wheelAngle: 0 };
}

/** Places the body and its collider at `(x, y, z)` (y = the road surface) and `yaw`. */
export function placeRoverBody(body: RoverBody, hash: SpatialHash | null, x: number, y: number, z: number, yaw: number): void {
  body.root.position.set(x, y, z);
  body.root.rotation.y = -yaw;
  hash?.move(body.hullEntry, x, y, z, yaw);
}

/** The terrain tilt (radians). `pitch` > 0 = the nose lifts, `roll` > 0 = the local +Z side lifts. */
export function tiltRoverBody(body: RoverBody, pitch: number, roll: number): void {
  body.tilt.rotation.set(-roll, 0, pitch);
}

/** Rolls the wheels `distance` m (+ = forwards). */
export function spinRoverWheels(body: RoverBody, distance: number): void {
  body.wheelAngle = (body.wheelAngle + distance / ROVER_WHEEL_R) % (Math.PI * 2);
  for (const w of body.wheels) w.rotation.z = -body.wheelAngle;
}

/** The destroyed look — scorched colours · dead lights · a twisted turret. Only material colours change, so no shader recompiles. */
export function applyRoverWreckLook(body: RoverBody): void {
  body.hullMat.color.copy(WRECK_TINT);
  body.wheelMat.color.set(0x2e2c2a);
  body.glowMat.color.set(0x1a1a1a);
  body.turret.rotation.set(0.12, body.turret.rotation.y + 0.7, -0.08);
  body.muzzleFlash.scale.setScalar(1e-4);
}
