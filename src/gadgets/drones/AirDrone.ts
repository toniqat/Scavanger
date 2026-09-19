/**
 * src/gadgets/drones/AirDrone.ts — **the air drone body** (2026-09-11).
 *
 * One `DroneBody` implementation. Taking control · applying the camera · link range · hp · networking belong to
 * `DroneSystem` (the core); this file holds only physics · the procedural model · the lens pose · the ray test.
 *
 * ## Coordinate convention
 * - `position` = the **body centre**. `BODY_BOTTOM` below it (the underside of the landing skids), `BODY_TOP`
 *   above (the top face of the mount plate pins).
 * - `yaw` follows **`model.ts`'s drone yaw convention** (both bodies have to agree) — the model's nose = local
 *   **+Z**, `root.rotation.y = yaw`, forward = `(sin yaw, 0, cos yaw)`, right = `(−cos yaw, 0, sin yaw)`,
 *   pitch + = up. It is the opposite of the player yaw (forward = −sin, −cos), so on deploy the core converts it
 *   with `droneYawFromPlayer` (+π). That makes left = local +X (the red navigation LED sits on +X).
 * - While controlled, `yaw` takes the input yaw **as it is** — `getCameraPose` resolves the view from this yaw, so
 *   damping it here makes the mouse lag behind. What follows the input yaw smoothly is the **visible body**
 *   (`visualYaw`).
 *
 * ## Flight
 * - Horizontal: exponential accel / decel towards the input direction × `DRONE_AIR_SPEED`; with the input released
 *   it coasts to a stop like air drag.
 * - Vertical: `input.vertical` × `DRONE_AIR_CLIMB_SPEED`. With no input the vertical speed goes to 0 as well —
 *   **hovering in place**.
 * - With `input === null` (nobody is controlling it · out of link) the velocity decays to 0 and it hangs there.
 *   The up-and-down wobble is not physics but a visual offset in `animate` (`bobY`) — the wire pose never jitters.
 *
 * ## Altitude · collision
 * - Floor = `getSurfaceY(x, z, body underside + FLOOR_GRACE − PROP_STEP_UP_MAX)` — only a top face lower than (or
 *   nearly level with) the body underside counts as floor. So crossing a roof or a treetop makes that top face the
 *   floor, while flying **under** a second-storey floor plate does not make that plate the floor. Minimum
 *   clearance `HOVER_CLEARANCE`, maximum floor + `DRONE_AIR_MAX_ALTITUDE` (past it, it descends gradually).
 * - Obstacles do **not** go through `world.resolveCollision` — that function measures a walking body (2.1 m of
 *   headroom · the step-up exception), so it teleports a drone flying 1 m under a ceiling slab out past the slab's
 *   footprint. They are resolved in 3D against the `getObstaclesNear` list instead: only obstacles overlapping the
 *   body's height span, taking the **shallowest** of pushing sideways · lifting onto the top face · (floating
 *   boxes only) dropping below. All three of cylinder · `Obstacle.box` (+ `ramp`) · `Obstacle.hull`.
 * - One frame of movement is resolved in `SUBSTEP_LEN` substeps (thin-wall tunnelling). When the frame's movement
 *   exceeds half the body radius, `world.raycast` blocks the direction of travel once more (frame hitches ·
 *   training range walls that are not in the hash).
 *
 * **No lights** (the scene point-light count rule, CLAUDE.md) — the LEDs are emissive, the rotor blur a
 * translucent disc.
 */
import * as THREE from 'three';
import {
  DRONE_AIR_ACCEL, DRONE_AIR_CLIMB_SPEED, DRONE_AIR_MAX_ALTITUDE, DRONE_AIR_MIN_CLEARANCE, DRONE_AIR_SPEED, DroneFlags, PROP_STEP_UP_MAX,
} from '@/shared';
import type { GameContext, Obstacle, WorldRef } from '@/shared';
import type { DroneBody, DroneInput } from './model';

/* ── Body dimensions (measured from the model, m) ──────────────────────────────────────────── */
/** Centre → the top face of the mount plate pins. */
const BODY_TOP = 0.11;
/** Centre → the underside of the landing skids. */
const BODY_BOTTOM = 0.15;
/**
 * Horizontal radius — between the outer edge of an axis-aligned prop guard (0.43) and the diagonal tip (0.54).
 * The grapple · bullets · collision all share it.
 */
const BODY_RADIUS = 0.5;
/** Top face of the mount plate (local y). */
const MOUNT_Y = 0.096;
/** Local |x| = |z| of a motor centre. */
const ROTOR_OFF = 0.26;
const ROTOR_Y = 0.085;
/** Gimbal ball centre (local). */
const GIMBAL_Y = -0.095;
const GIMBAL_Z = 0.17;
/** First-person lens: forward / up and down from the body centre. Slightly ahead of the glass (0.228). */
const LENS_FWD = 0.25;
const LENS_Y = GIMBAL_Y;

/* ── Handling (whatever touches gameplay is TODO(csv)) ─────────────────────────────────────── */
const MAX_DT = 0.1;
/** Horizontal accel response (1/s) — `DRONE_AIR_ACCEL` in `data/constants.csv` (the lead moved it 2026-09-11). */
const ACCEL_K = DRONE_AIR_ACCEL;
/** Braking while controlled, once the input is released (1/s). */
const BRAKE_K = 3.2;
/** Decay to a standstill while nobody is controlling it (1/s) — it drifts a little, then stops. */
const HOVER_BRAKE_K = 2.4;
const CLIMB_K = 6;
const CLIMB_BRAKE_K = 7;
/**
 * Minimum clearance (m) between the body underside and the floor — `DRONE_AIR_MIN_CLEARANCE` in
 * `data/constants.csv` (the lead moved it 2026-09-11).
 */
const HOVER_CLEARANCE = DRONE_AIR_MIN_CLEARANCE;
/** A top face this far above the body underside still counts as floor (it rides onto a low ledge it brushes). */
const FLOOR_GRACE = 0.25;
/** Descent speed once past the altitude cap = climb speed × this value. */
const OVER_ALT_DESCENT_MUL = 1.5;
const SUBSTEP_LEN = 0.2;
const MAX_SUBSTEPS = 8;
const SWEEP_MIN = BODY_RADIUS * 0.5;
/**
 * Obstacle list cache: re-queried after moving this far or after this long (`getObstaclesNear` builds a new
 * array).
 */
const REQUERY_MOVE = 1;
const REQUERY_S = 0.3;
/** Top-face test margin — biting in this far does not count as an overlap. */
const TOP_SKIN = 0.02;
/**
 * A cylinder prop rises out of the ground — its underside is buried a little (the same value as
 * `WorldSystem.rayCylinder`).
 */
const CYL_SINK = 0.5;

/* ── Visual presentation ───────────────────────────────────────────────────────────────────── */
const MAX_TILT = 0.3;
const TILT_K = 6;
const YAW_FOLLOW_K = 10;
const BOB_AMP = 0.025;
const BOB_W = 2.4;
/** Rotor angular speed (rad/s) — idling · a bonus while controlled · a bonus from speed. */
const ROTOR_IDLE = 70;
const ROTOR_CTRL = 18;
const ROTOR_MOVE = 30;
const ROTOR_SPIN_K = 2.5;
/** The fastest the blade meshes really turn — above it they read as a strobe, so the blur disc takes over. */
const BLADE_VIS_MAX = 22;
const BLUR_START = 25;
const BLUR_FULL = 80;
const BLUR_MAX_OPACITY = 0.32;
const GIMBAL_REST = -0.18;
const GIMBAL_MIN = -1.35;
const GIMBAL_MAX = 0.4;
const GIMBAL_K = 10;
const REMOTE_VEL_K = 8;
const NAV_CYCLE = 1.4;
const LED_ON = 1.4;
const LED_FLASH = 4;
const STATUS_IDLE = 0x3a7bff;
const STATUS_CONTROLLED = 0x33e6ff;
const STATUS_LOST = 0xffa21a;

/* ── Sound ─────────────────────────────────────────────────────────────────────────────────── */
const ROTOR_SFX_SLOW = 0.55;
const ROTOR_SFX_FAST = 0.3;
/** Even when not controlled, it plays the rotor sound while moving above this fraction of top speed. */
const SFX_MOVE_FRAC = 0.15;

/**
 * Motor order (front-left · front-right · rear-right · rear-left; nose = +Z · left = +X) and the spin
 * direction — diagonal pairs turn the same way.
 */
const ROTOR_SIGN_X = [1, -1, -1, 1] as const;
const ROTOR_SIGN_Z = [1, 1, -1, -1] as const;
const ROTOR_DIR = [1, -1, 1, -1] as const;

/**
 * An internal flag world attaches to its hash entries (outside the contract) — a small body passes through a
 * broken window frame.
 */
type PassFlags = { passSmall?: boolean };

/* ── Module scratch (no allocation on hot paths) ───────────────────────────────────────────── */
const _dir = new THREE.Vector3();
const _euler = new THREE.Euler();
/** Horizontal push-out result: the displacement vector and the depth. */
const H = { x: 0, z: 0, depth: 0 };

/* ── Shared geometry · materials (a module cache; instances never dispose them) ────────────── */
interface AirGeo {
  hull: THREE.BufferGeometry; shell: THREE.BufferGeometry; plate: THREE.BufferGeometry; pin: THREE.BufferGeometry;
  nose: THREE.BufferGeometry; stripe: THREE.BufferGeometry; arm: THREE.BufferGeometry; motor: THREE.BufferGeometry;
  hub: THREE.BufferGeometry; blade: THREE.BufferGeometry; disc: THREE.BufferGeometry; guard: THREE.BufferGeometry;
  leg: THREE.BufferGeometry; skid: THREE.BufferGeometry; yoke: THREE.BufferGeometry; ball: THREE.BufferGeometry;
  lens: THREE.BufferGeometry; glass: THREE.BufferGeometry; led: THREE.BufferGeometry;
}
let GEO: AirGeo | null = null;
function geo(): AirGeo {
  if (GEO) return GEO;
  GEO = {
    hull: new THREE.BoxGeometry(0.22, 0.09, 0.36),
    shell: new THREE.CylinderGeometry(0.11, 0.15, 0.035, 8),
    plate: new THREE.BoxGeometry(0.16, 0.018, 0.16),
    pin: new THREE.BoxGeometry(0.018, 0.02, 0.018),
    nose: new THREE.BoxGeometry(0.12, 0.05, 0.05),
    stripe: new THREE.BoxGeometry(0.008, 0.028, 0.28),
    arm: new THREE.BoxGeometry(0.034, 0.024, 0.74),
    motor: new THREE.CylinderGeometry(0.034, 0.04, 0.06, 10),
    hub: new THREE.CylinderGeometry(0.014, 0.014, 0.018, 8),
    blade: new THREE.BoxGeometry(0.3, 0.004, 0.026),
    disc: new THREE.CircleGeometry(0.155, 28).rotateX(-Math.PI / 2),
    guard: new THREE.TorusGeometry(0.165, 0.008, 5, 28).rotateX(Math.PI / 2),
    leg: new THREE.BoxGeometry(0.014, 0.095, 0.014),
    skid: new THREE.BoxGeometry(0.016, 0.015, 0.24),
    yoke: new THREE.BoxGeometry(0.07, 0.014, 0.05),
    ball: new THREE.SphereGeometry(0.042, 14, 10),
    lens: new THREE.CylinderGeometry(0.022, 0.026, 0.03, 12).rotateX(Math.PI / 2),
    glass: new THREE.CircleGeometry(0.019, 14),   // default normal +Z = the nose direction
    led: new THREE.SphereGeometry(0.014, 8, 6),
  };
  return GEO;
}

interface AirMat {
  hull: THREE.Material; shell: THREE.Material; accent: THREE.Material;
  rubber: THREE.Material; blade: THREE.Material; lens: THREE.Material;
}
let MAT: AirMat | null = null;
function mat(): AirMat {
  if (MAT) return MAT;
  MAT = {
    hull: new THREE.MeshStandardMaterial({ color: 0x2a2f35, roughness: 0.5, metalness: 0.55 }),
    shell: new THREE.MeshStandardMaterial({ color: 0x3d444c, roughness: 0.42, metalness: 0.35 }),
    accent: new THREE.MeshStandardMaterial({ color: 0xd8a020, roughness: 0.55, metalness: 0.2 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x141517, roughness: 0.9, metalness: 0 }),
    blade: new THREE.MeshStandardMaterial({ color: 0x1c1e21, roughness: 0.6, metalness: 0.1 }),
    lens: new THREE.MeshStandardMaterial({
      color: 0x04070a, roughness: 0.08, metalness: 0.9, emissive: 0x0b3a48, emissiveIntensity: 0.6,
    }),
  };
  return MAT;
}

function ledMat(hex: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0x111111, emissive: hex, emissiveIntensity: LED_ON, roughness: 0.4, metalness: 0,
  });
}

/* ── Pure maths ────────────────────────────────────────────────────────────────────────────── */
function clampN(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }

function wrapAngle(a: number): number {
  const t = Math.PI * 2;
  return ((((a + Math.PI) % t) + t) % t) - Math.PI;
}

/**
 * Top-face height of a ramp (the same formula as `world/obb.rampTopAt` — importing another feature folder is
 * forbidden, so it is re-solved here from contract fields alone).
 */
function rampTopAt(o: Obstacle, x: number, z: number): number {
  const b = o.box!, r = o.ramp!;
  const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
  const lx = clampN((x - o.position.x) * c + (z - o.position.z) * s, -b.halfX, b.halfX);
  const t = b.halfX > 1e-6 ? (lx + b.halfX) / (2 * b.halfX) : 1;
  return o.position.y + o.height - r.rise + r.rise * t;
}

/**
 * Circle vs a cylinder's cross-section (the bullet silhouette `shotRadius` wins — a flying body has to hit the
 * shape it looks like).
 */
function pushCircle(o: Obstacle, px: number, pz: number, radius: number): boolean {
  const r = o.shotRadius !== undefined && o.shotRadius > 0 ? o.shotRadius : o.radius;
  let dx = px - o.position.x, dz = pz - o.position.z;
  let d = Math.sqrt(dx * dx + dz * dz);
  const min = radius + r;
  if (d >= min) return false;
  if (d < 1e-4) { dx = 1; dz = 0; d = 1; }
  const push = min - d;
  H.x = (dx / d) * push; H.z = (dz / d) * push; H.depth = push;
  return true;
}

/**
 * Circle vs a rotated box's cross-section (the same convention as `world/obb.boxPushOut`: a centre inside leaves
 * through the shallowest face).
 */
function pushBox(o: Obstacle, px: number, pz: number, radius: number): boolean {
  const b = o.box!;
  const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
  const rx = px - o.position.x, rz = pz - o.position.z;
  const lx = rx * c + rz * s, lz = -rx * s + rz * c;
  const qx = clampN(lx, -b.halfX, b.halfX), qz = clampN(lz, -b.halfZ, b.halfZ);
  let ux = lx - qx, uz = lz - qz;
  const d2 = ux * ux + uz * uz;
  if (d2 >= radius * radius) return false;
  let depth: number;
  if (d2 > 1e-8) {
    const d = Math.sqrt(d2);
    depth = radius - d;
    ux = (ux / d) * depth; uz = (uz / d) * depth;
  } else {
    const penX = b.halfX - Math.abs(lx), penZ = b.halfZ - Math.abs(lz);
    if (penX <= penZ) { depth = penX + radius; ux = (lx >= 0 ? 1 : -1) * depth; uz = 0; }
    else { depth = penZ + radius; ux = 0; uz = (lz >= 0 ? 1 : -1) * depth; }
  }
  H.x = ux * c - uz * s; H.z = ux * s + uz * c; H.depth = depth;
  return true;
}

/**
 * Circle vs a convex outline (the same convention as `world/hull.hullPushOut`; the points are counter-clockwise
 * `[x0, z0, …]`).
 */
function pushHull(p: Float32Array, px: number, pz: number, radius: number): boolean {
  const m = p.length >> 1;
  if (m < 3) return false;
  let sMax = -Infinity, nxM = 0, nzM = 0;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    const ax = p[i * 2], az = p[i * 2 + 1];
    const dx = p[j * 2] - ax, dz = p[j * 2 + 1] - az;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1e-9) continue;
    const nx = dz / len, nz = -dx / len;
    const s = (px - ax) * nx + (pz - az) * nz;
    if (s > sMax) { sMax = s; nxM = nx; nzM = nz; }
  }
  if (sMax === -Infinity || sMax >= radius) return false;
  if (sMax <= 0) {
    const depth = radius - sMax;
    H.x = nxM * depth; H.z = nzM * depth; H.depth = depth;
    return true;
  }
  let best = Infinity, cx = px, cz = pz;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    const ax = p[i * 2], az = p[i * 2 + 1];
    const dx = p[j * 2] - ax, dz = p[j * 2 + 1] - az;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 1e-12 ? clampN(((px - ax) * dx + (pz - az) * dz) / l2, 0, 1) : 0;
    const qx = ax + dx * t, qz = az + dz * t;
    const d2 = (px - qx) * (px - qx) + (pz - qz) * (pz - qz);
    if (d2 < best) { best = d2; cx = qx; cz = qz; }
  }
  if (best >= radius * radius) return false;
  const d = Math.sqrt(best);
  if (d < 1e-6) { H.x = nxM * radius; H.z = nzM * radius; H.depth = radius; return true; }
  const depth = radius - d;
  H.x = ((px - cx) / d) * depth; H.z = ((pz - cz) / d) * depth; H.depth = depth;
  return true;
}

export class AirDrone implements DroneBody {
  readonly kind = 'air' as const;
  readonly root = new THREE.Group();
  readonly radius = BODY_RADIUS;
  readonly height = BODY_TOP + BODY_BOTTOM;
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  yaw = 0;
  readonly sprinting = false;
  readonly airborne = true;

  /** The body that carries tilt · wobble (root holds only the position + the visual yaw). */
  private readonly tilt = new THREE.Group();
  private readonly gimbal = new THREE.Group();
  /** The parts that block the lens in the owner's view. */
  private readonly ownerHidden: THREE.Object3D[] = [];
  private readonly rotors: THREE.Group[] = [];
  private readonly discs: THREE.Mesh[] = [];

  /* Instance materials — each drone blinks and blurs on its own (only these four are disposed). */
  private readonly blurMat: THREE.MeshBasicMaterial;
  private readonly ledRed: THREE.MeshStandardMaterial;
  private readonly ledGreen: THREE.MeshStandardMaterial;
  private readonly ledStatus: THREE.MeshStandardMaterial;

  private visualYaw = 0;
  private tiltX = 0;
  private tiltZ = 0;
  private appliedTiltX = 0;
  private appliedTiltZ = 0;
  private bobY = 0;
  private rotorSpin = 0;
  private bladeAngle = 0;
  private gimbalPitch = GIMBAL_REST;
  private gimbalTarget = GIMBAL_REST;
  private readonly phase = Math.random() * Math.PI * 2;

  private controlled = false;
  private linkLost = false;
  /** The last pose came in through `applyRemote` (velocity is estimated from the position change). */
  private remote = false;
  private statusMode = -1;
  private readonly remoteVel = new THREE.Vector3();
  private readonly lastAnimPos = new THREE.Vector3();
  private hasAnimPos = false;

  private obstacles: Obstacle[] = [];
  private hasCache = false;
  private cacheX = 0;
  private cacheZ = 0;
  private cacheAge = 0;

  private sfxTimer = 0;
  private disposed = false;

  constructor() {
    const g = geo(), m = mat();
    this.root.name = 'AirDrone';
    this.root.add(this.tilt);

    this.blurMat = new THREE.MeshBasicMaterial({
      color: 0xaeb6bf, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
    });
    this.ledRed = ledMat(0xff2a1a);
    this.ledGreen = ledMat(0x2aff5a);
    this.ledStatus = ledMat(STATUS_IDLE);

    const add = (
      gg: THREE.BufferGeometry, mm: THREE.Material, x: number, y: number, z: number,
      parent: THREE.Object3D = this.tilt,
    ): THREE.Mesh => {
      const mesh = new THREE.Mesh(gg, mm);
      mesh.position.set(x, y, z);
      parent.add(mesh);
      return mesh;
    };

    // Hull · top shell · mount plate (+ corner pins) · front sensor · side warning bands
    add(g.hull, m.hull, 0, 0, 0).castShadow = true;
    add(g.shell, m.shell, 0, 0.06, -0.01).castShadow = true;
    add(g.plate, m.rubber, 0, 0.0865, 0);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(g.pin, m.accent, sx * 0.07, 0.1, sz * 0.07);
    this.ownerHidden.push(add(g.nose, m.shell, 0, 0.005, 0.19));
    add(g.stripe, m.accent, -0.113, 0, -0.01);
    add(g.stripe, m.accent, 0.113, 0, -0.01);

    // X arms
    add(g.arm, m.hull, 0, 0.02, 0).rotation.y = Math.PI / 4;
    add(g.arm, m.hull, 0, 0.02, 0).rotation.y = -Math.PI / 4;

    // Motors · prop guards · rotors (blades + hub) · blur discs
    for (let i = 0; i < 4; i++) {
      const x = ROTOR_SIGN_X[i] * ROTOR_OFF, z = ROTOR_SIGN_Z[i] * ROTOR_OFF;
      add(g.motor, m.hull, x, 0.05, z);
      add(g.guard, m.shell, x, ROTOR_Y, z);
      const rotor = new THREE.Group();
      rotor.position.set(x, ROTOR_Y + 0.004, z);
      rotor.rotation.y = i * 0.7;
      add(g.blade, m.blade, 0, 0, 0, rotor);
      add(g.hub, m.accent, 0, 0.004, 0, rotor);
      this.tilt.add(rotor);
      this.rotors.push(rotor);
      const disc = add(g.disc, this.blurMat, x, ROTOR_Y + 0.007, z);
      disc.renderOrder = 1;
      disc.visible = false;
      this.discs.push(disc);
    }

    // Navigation LEDs (red = left = +X, green = right = −X, at the front arm tips) · the rear (−Z) status LED
    add(g.led, this.ledRed, ROTOR_OFF, 0.012, ROTOR_OFF);
    add(g.led, this.ledGreen, -ROTOR_OFF, 0.012, ROTOR_OFF);
    add(g.led, this.ledStatus, 0, 0.02, -0.182);

    // Landing legs + skids
    const legs = new THREE.Group();
    this.tilt.add(legs);
    for (const sx of [-1, 1]) {
      add(g.leg, m.rubber, sx * 0.085, -0.0925, -0.08, legs);
      add(g.leg, m.rubber, sx * 0.085, -0.0925, 0.08, legs);
      add(g.skid, m.rubber, sx * 0.085, -0.1425, 0, legs);
    }
    this.ownerHidden.push(legs);

    // Gimbal: yoke (fixed) + ball · scope tube · glass (pitch)
    this.ownerHidden.push(add(g.yoke, m.hull, 0, -0.052, GIMBAL_Z));
    this.gimbal.position.set(0, GIMBAL_Y, GIMBAL_Z);
    this.gimbal.rotation.x = -GIMBAL_REST;
    add(g.ball, m.shell, 0, 0, 0, this.gimbal);
    add(g.lens, m.rubber, 0, 0, 0.042, this.gimbal);
    add(g.glass, m.lens, 0, 0, 0.0575, this.gimbal);
    this.tilt.add(this.gimbal);
    this.ownerHidden.push(this.gimbal);
  }

  /* ── DroneBody ───────────────────────────────────────────────────────────────────────────── */

  reset(position: THREE.Vector3, yaw: number, ctx: GameContext): void {
    this.position.copy(position);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.visualYaw = yaw;
    this.tiltX = this.tiltZ = this.appliedTiltX = this.appliedTiltZ = 0;
    this.bobY = 0;
    this.rotorSpin = 0;
    this.gimbalPitch = this.gimbalTarget = GIMBAL_REST;
    this.controlled = false;
    this.linkLost = false;
    this.remote = false;
    this.remoteVel.set(0, 0, 0);
    this.hasAnimPos = false;
    this.obstacles = [];
    this.hasCache = false;
    this.cacheAge = 0;
    this.sfxTimer = 0;
    const world = ctx.world;
    if (world && world.ready) this.clampAltitude(world, 0);   // so it is never deployed inside the ground
    this.syncRoot();
  }

  simulate(dt: number, ctx: GameContext, input: DroneInput | null): void {
    if (this.disposed || !(dt > 0)) return;
    if (dt > MAX_DT) dt = MAX_DT;
    this.remote = false;
    this.controlled = input !== null;
    const p = this.position, v = this.velocity;

    // ── Target velocity
    let tvx = 0, tvy = 0, tvz = 0, kH = HOVER_BRAKE_K, kV = HOVER_BRAKE_K;
    if (input) {
      this.yaw = input.yaw;
      this.gimbalTarget = clampN(input.pitch, GIMBAL_MIN, GIMBAL_MAX);
      const f = clampN(input.forward, -1, 1), r = clampN(input.right, -1, 1);
      const sy = Math.sin(input.yaw), cy = Math.cos(input.yaw);
      // forward = (sin, cos) · right = (−cos, sin) — the same formula as `GroundDrone`
      let wx = sy * f - cy * r, wz = cy * f + sy * r;
      const wl = Math.sqrt(wx * wx + wz * wz);
      if (wl > 1) { wx /= wl; wz /= wl; }
      tvx = wx * DRONE_AIR_SPEED;
      tvz = wz * DRONE_AIR_SPEED;
      tvy = clampN(input.vertical, -1, 1) * DRONE_AIR_CLIMB_SPEED;
      kH = wl > 0.01 ? ACCEL_K : BRAKE_K;
      kV = tvy !== 0 ? CLIMB_K : CLIMB_BRAKE_K;
    } else {
      this.gimbalTarget = GIMBAL_REST;
    }
    const aH = 1 - Math.exp(-kH * dt);
    v.x += (tvx - v.x) * aH;
    v.z += (tvz - v.z) * aH;
    v.y += (tvy - v.y) * (1 - Math.exp(-kV * dt));
    if (Math.abs(v.x) < 1e-4) v.x = 0;
    if (Math.abs(v.y) < 1e-4) v.y = 0;
    if (Math.abs(v.z) < 1e-4) v.z = 0;

    // ── Movement (substeps) + collision + altitude
    const world = ctx.world && ctx.world.ready ? ctx.world : null;
    let mx = v.x * dt, my = v.y * dt, mz = v.z * dt;
    const dist = Math.sqrt(mx * mx + my * my + mz * mz);
    if (world) {
      this.refreshObstacles(world, dt);
      const scale = this.sweepScale(world, mx, my, mz, dist);
      mx *= scale; my *= scale; mz *= scale;
    }
    const steps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(Math.sqrt(mx * mx + my * my + mz * mz) / SUBSTEP_LEN)));
    const sx = mx / steps, sy = my / steps, sz = mz / steps, sdt = dt / steps;
    for (let i = 0; i < steps; i++) {
      const px = p.x, pz = p.z;
      p.x += sx; p.y += sy; p.z += sz;
      if (!world) continue;
      if (!world.isInsideBounds(p.x, p.z)) {
        if (world.isInsideBounds(p.x, pz)) { p.z = pz; v.z = 0; }
        else if (world.isInsideBounds(px, p.z)) { p.x = px; v.x = 0; }
        else { p.x = px; p.z = pz; v.x = 0; v.z = 0; }
      }
      this.resolveObstacles(world);
      this.clampAltitude(world, sdt);
    }
    this.syncRoot();

    // ── Rotor sound (only while controlled · while moving)
    const frac = clampN(Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) / DRONE_AIR_SPEED, 0, 1);
    if (this.controlled || frac > SFX_MOVE_FRAC) {
      this.sfxTimer -= dt;
      if (this.sfxTimer <= 0) {
        this.sfxTimer = ROTOR_SFX_SLOW + (ROTOR_SFX_FAST - ROTOR_SFX_SLOW) * frac;
        ctx.bus.emit('audio:play', {
          id: 'drone_rotor', position: this.position, volume: 0.3 + 0.4 * frac, pitch: 0.9 + 0.25 * frac,
        });
      }
    } else {
      this.sfxTimer = 0;
    }
  }

  applyRemote(position: THREE.Vector3, yaw: number, flags: number): void {
    this.remote = true;
    this.position.copy(position);
    this.yaw = yaw;
    this.controlled = (flags & DroneFlags.CONTROLLED) !== 0;
    this.linkLost = (flags & DroneFlags.LINK_LOST) !== 0;
    this.gimbalTarget = GIMBAL_REST;
    this.root.position.copy(position);
  }

  animate(dt: number, time: number): void {
    if (this.disposed) return;
    const p = this.position;
    const d = dt > 0 ? Math.min(dt, MAX_DT) : 0;

    // Velocity: the owner uses the physics value, a replica estimates it from the position change
    let vx: number, vy: number, vz: number;
    if (this.remote) {
      if (this.hasAnimPos && dt > 1e-4) {
        const a = 1 - Math.exp(-REMOTE_VEL_K * d);
        const cap = DRONE_AIR_SPEED * 2;
        this.remoteVel.x += (clampN((p.x - this.lastAnimPos.x) / dt, -cap, cap) - this.remoteVel.x) * a;
        this.remoteVel.y += (clampN((p.y - this.lastAnimPos.y) / dt, -cap, cap) - this.remoteVel.y) * a;
        this.remoteVel.z += (clampN((p.z - this.lastAnimPos.z) / dt, -cap, cap) - this.remoteVel.z) * a;
      }
      vx = this.remoteVel.x; vy = this.remoteVel.y; vz = this.remoteVel.z;
    } else {
      vx = this.velocity.x; vy = this.velocity.y; vz = this.velocity.z;
    }
    this.lastAnimPos.copy(p);
    this.hasAnimPos = true;
    const frac = clampN(Math.sqrt(vx * vx + vy * vy + vz * vz) / DRONE_AIR_SPEED, 0, 1);

    // The visual yaw follows the input yaw smoothly
    this.visualYaw = wrapAngle(this.visualYaw + wrapAngle(this.yaw - this.visualYaw) * (1 - Math.exp(-YAW_FOLLOW_K * d)));
    this.root.position.copy(p);
    this.root.rotation.y = this.visualYaw;

    // Tilt into the direction of travel (moving forward dips the nose, moving right drops the right
    // side) + the idling wobble. Rx(+) drops +Z (the nose) and Rz(+) drops −X (the right side), so both take the
    // sign of the velocity component as it is.
    const s = Math.sin(this.visualYaw), c = Math.cos(this.visualYaw);
    const vf = vx * s + vz * c, vr = -vx * c + vz * s;
    const aT = 1 - Math.exp(-TILT_K * d);
    this.tiltX += (clampN(vf / DRONE_AIR_SPEED, -1, 1) * MAX_TILT - this.tiltX) * aT;
    this.tiltZ += (clampN(vr / DRONE_AIR_SPEED, -1, 1) * MAX_TILT - this.tiltZ) * aT;
    const calm = 1 - 0.7 * frac;
    this.appliedTiltX = this.tiltX + Math.sin(time * 1.3 + this.phase) * 0.012 * calm;
    this.appliedTiltZ = this.tiltZ + Math.sin(time * 1.7 + this.phase * 1.3) * 0.015 * calm;
    this.tilt.rotation.set(this.appliedTiltX, 0, this.appliedTiltZ);
    this.bobY = Math.sin(time * BOB_W + this.phase) * BOB_AMP * calm;
    this.tilt.position.y = this.bobY;

    // Rotors: the blades only turn up to the visible speed; above that the blur disc darkens
    const climb = vy > 0 ? (vy / DRONE_AIR_CLIMB_SPEED) * 10 : 0;
    const target = ROTOR_IDLE + (this.controlled ? ROTOR_CTRL : 0) + ROTOR_MOVE * frac + climb;
    this.rotorSpin += (target - this.rotorSpin) * (1 - Math.exp(-ROTOR_SPIN_K * d));
    this.bladeAngle = (this.bladeAngle + Math.min(this.rotorSpin, BLADE_VIS_MAX) * d) % (Math.PI * 2);
    for (let i = 0; i < this.rotors.length; i++) this.rotors[i].rotation.y = this.bladeAngle * ROTOR_DIR[i] + i * 0.7;
    const blur = clampN((this.rotorSpin - BLUR_START) / (BLUR_FULL - BLUR_START), 0, 1) * BLUR_MAX_OPACITY;
    this.blurMat.opacity = blur;
    const showDisc = blur > 0.01;
    for (let i = 0; i < this.discs.length; i++) this.discs[i].visible = showDisc;

    // Gimbal
    this.gimbalPitch += (this.gimbalTarget - this.gimbalPitch) * (1 - Math.exp(-GIMBAL_K * d));
    this.gimbal.rotation.x = -this.gimbalPitch;   // Rx(+) drops +Z (the lens), so pitch + = up flips the sign

    // Navigation LEDs: lit, with a double flash every cycle
    const cyc = (((time + this.phase) % NAV_CYCLE) + NAV_CYCLE) % NAV_CYCLE;
    const nav = cyc < 0.07 || (cyc > 0.16 && cyc < 0.23) ? LED_FLASH : LED_ON;
    this.ledRed.emissiveIntensity = nav;
    this.ledGreen.emissiveIntensity = nav;

    // Status LED: controlled = cyan · out of link = an amber blink · idle = a slow blue pulse
    const mode = this.linkLost ? 2 : this.controlled ? 1 : 0;
    if (mode !== this.statusMode) {
      this.statusMode = mode;
      this.ledStatus.emissive.setHex(mode === 2 ? STATUS_LOST : mode === 1 ? STATUS_CONTROLLED : STATUS_IDLE);
    }
    this.ledStatus.emissiveIntensity = mode === 2
      ? (Math.sin(time * 25) > 0 ? 3 : 0.2)
      : mode === 1
        ? 2.2 + 0.3 * Math.sin(time * 6)
        : 0.5 + 0.4 * (0.5 + 0.5 * Math.sin(time * 2.2 + this.phase));
  }

  getCameraPose(pitch: number, outPos: THREE.Vector3, outLook: THREE.Vector3): void {
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    outPos.set(this.position.x + s * LENS_FWD, this.position.y + LENS_Y + this.bobY, this.position.z + c * LENS_FWD);
    const cp = Math.cos(pitch);
    outLook.set(outPos.x + s * cp, outPos.y + Math.sin(pitch), outPos.z + c * cp);
  }

  getMountPoint(out: THREE.Vector3): THREE.Vector3 {
    // The same rotation as root(Ry) × tilt(Rx·Rz) = Euler 'YXZ'
    _euler.set(this.appliedTiltX, this.visualYaw, this.appliedTiltZ, 'YXZ');
    out.set(0, MOUNT_Y, 0).applyEuler(_euler);
    out.x += this.position.x;
    out.y += this.position.y + this.bobY;
    out.z += this.position.z;
    return out;
  }

  /**
   * A flattened ellipsoid (horizontal radius `radius`, vertical radius `height / 2`). An origin inside it
   * returns −1 (the world convention).
   */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): number {
    if (this.disposed || !(maxDist > 0)) return -1;
    let dx = dir.x, dy = dir.y, dz = dir.z;
    const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dl < 1e-8) return -1;
    dx /= dl; dy /= dl; dz /= dl;
    const ry = this.height * 0.5;
    const k = BODY_RADIUS / ry;
    const cy = this.position.y + (BODY_TOP - BODY_BOTTOM) * 0.5;
    const ox = origin.x - this.position.x, oy = (origin.y - cy) * k, oz = origin.z - this.position.z;
    const ey = dy * k;
    const a = dx * dx + ey * ey + dz * dz;
    const b = ox * dx + oy * ey + oz * dz;
    const cc = ox * ox + oy * oy + oz * oz - BODY_RADIUS * BODY_RADIUS;
    if (cc <= 0) return -1;
    const disc = b * b - a * cc;
    if (disc < 0) return -1;
    const t = (-b - Math.sqrt(disc)) / a;
    return t >= 0 && t <= maxDist ? t : -1;
  }

  setOwnerView(looking: boolean): void {
    for (let i = 0; i < this.ownerHidden.length; i++) this.ownerHidden[i].visible = !looking;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.removeFromParent();
    this.blurMat.dispose();
    this.ledRed.dispose();
    this.ledGreen.dispose();
    this.ledStatus.dispose();
    this.obstacles = [];
  }

  /* ── internals ───────────────────────────────────────────────────────────────────────────── */

  private syncRoot(): void {
    this.root.position.copy(this.position);
    this.root.rotation.y = this.visualYaw;
  }

  private refreshObstacles(world: WorldRef, dt: number): void {
    const p = this.position;
    this.cacheAge += dt;
    const dx = p.x - this.cacheX, dz = p.z - this.cacheZ;
    if (this.hasCache && this.cacheAge < REQUERY_S && dx * dx + dz * dz <= REQUERY_MOVE * REQUERY_MOVE) return;
    const reach = BODY_RADIUS + REQUERY_MOVE + Math.max(DRONE_AIR_SPEED, DRONE_AIR_CLIMB_SPEED) * MAX_DT + 0.25;
    this.obstacles = world.getObstaclesNear(p.x, p.z, reach);
    this.cacheX = p.x;
    this.cacheZ = p.z;
    this.cacheAge = 0;
    this.hasCache = true;
  }

  /**
   * Blocks a long frame movement with a ray along the direction of travel. Returns a movement scale (0..1) and
   * clears the velocity component pointing into the wall.
   */
  private sweepScale(world: WorldRef, mx: number, my: number, mz: number, dist: number): number {
    if (dist <= SWEEP_MIN) return 1;
    _dir.set(mx / dist, my / dist, mz / dist);
    const hit = world.raycast(this.position, _dir, dist + BODY_RADIUS);
    if (!hit) return 1;
    if (hit.obstacle && (hit.obstacle as Obstacle & PassFlags).passSmall) return 1;
    const allowed = Math.max(0, hit.distance - BODY_RADIUS);
    if (allowed >= dist) return 1;
    const n = hit.normal, v = this.velocity;
    const vn = v.x * n.x + v.y * n.y + v.z * n.z;
    if (vn < 0) { v.x -= n.x * vn; v.y -= n.y * vn; v.z -= n.z * vn; }
    return allowed / dist;
  }

  /**
   * Takes the body out of every obstacle overlapping its height span, the shallowest way: sideways · up · (for a
   * floating box) down.
   */
  private resolveObstacles(world: WorldRef): void {
    const list = this.obstacles;
    const p = this.position, v = this.velocity;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if ((o as Obstacle & PassFlags).passSmall) continue;
      let base: number, top: number;
      if (o.box) {
        base = o.position.y;
        top = o.ramp ? rampTopAt(o, p.x, p.z) : base + o.height;
      } else if (o.hull) {
        base = o.position.y;
        top = base + o.height;
      } else {
        base = o.position.y - CYL_SINK;
        top = o.position.y + (o.shotHeight !== undefined && o.shotHeight > 0 ? o.shotHeight : o.height);
      }
      const yb = p.y - BODY_BOTTOM, yt = p.y + BODY_TOP;
      if (yb >= top - TOP_SKIN || yt <= base) continue;
      const hit = o.box ? pushBox(o, p.x, p.z, BODY_RADIUS)
        : o.hull ? pushHull(o.hull.points, p.x, p.z, BODY_RADIUS)
          : pushCircle(o, p.x, p.z, BODY_RADIUS);
      if (!hit) continue;
      const up = top - yb;
      // Only a floating box with room for the drone underneath (a ceiling · a second-storey floor plate ·
      // the wall above a window) pushes it down
      let down = Infinity;
      if (o.box && base - world.getHeightAt(p.x, p.z) > this.height + HOVER_CLEARANCE + 0.1) down = yt - base;
      if (up <= H.depth && up <= down) {
        p.y += up;
        if (v.y < 0) v.y = 0;
      } else if (down < H.depth) {
        p.y -= down;
        if (v.y > 0) v.y = 0;
      } else {
        p.x += H.x;
        p.z += H.z;
        const inv = H.depth > 1e-6 ? 1 / H.depth : 0;
        const nx = H.x * inv, nz = H.z * inv;
        const vn = v.x * nx + v.z * nz;
        if (vn < 0) { v.x -= nx * vn; v.z -= nz * vn; }
      }
    }
  }

  /** Minimum clearance above the surface underfoot ~ the maximum altitude. `dt` 0 = immediate (reset). */
  private clampAltitude(world: WorldRef, dt: number): void {
    const p = this.position, v = this.velocity;
    const bottom = p.y - BODY_BOTTOM;
    let floor = world.getSurfaceY(p.x, p.z, bottom + FLOOR_GRACE - PROP_STEP_UP_MAX);
    // Flying at a slope, it also looks at the terrain ahead so the rotors do not dig in first
    const hs = Math.sqrt(v.x * v.x + v.z * v.z);
    if (hs > 0.5) {
      const k = (BODY_RADIUS * 0.8) / hs;
      const lead = world.getHeightAt(p.x + v.x * k, p.z + v.z * k);
      if (lead > floor) floor = lead;
    }
    const minY = floor + BODY_BOTTOM + HOVER_CLEARANCE;
    if (p.y < minY) {
      p.y = minY;
      if (v.y < 0) v.y = 0;
    }
    const maxY = floor + DRONE_AIR_MAX_ALTITUDE;
    if (p.y > maxY) {
      p.y = dt > 0 ? Math.max(maxY, p.y - DRONE_AIR_CLIMB_SPEED * OVER_ALT_DESCENT_MUL * dt) : maxY;
      if (v.y > 0) v.y = 0;
    }
  }
}
