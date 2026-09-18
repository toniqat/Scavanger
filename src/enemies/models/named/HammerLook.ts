/**
 * src/enemies/models/named/HammerLook.ts — **the look of Tagilla** (`rogue_hammer`) (2026-09-11).
 *
 * On top of the humanoid rogue rig: thick armour (chest · back · flanks · pauldrons · groin · thighs · shins), a welding
 * mask + gas filters + a **red visor slit**, and a **two-handed sledgehammer**. The base rifle is one mesh with the arms
 * (`rig.gun`), so it is hidden whole and the hammer arms go on a new pivot in the middle of the chest (`arms`) — the pose `animateRogue` writes to `rig.gun` still runs, it is simply not visible.
 *
 * Size: the base rogue (1.8 m) × `HAMMER_SCALE`. The silhouette was fitted to the hitbox (`enemies.csv` radius 0.55 ·
 * height 2.05, head 1.86) — the scale gives the height, the armour plates the width.
 *
 * Poses (host AI and replica take the same inputs):
 *  - `e.namedHint` 16 → the hammer rises behind the head and the upper body leans back.
 *  - `anim.recoil` spikes (the moment of the hit — `Hammer.strike` on the host, `ee hammer` on a replica) → it slams down, bending forward and dropping low.
 *  - `e.namedHint` 17 → charge: leaning forward.
 *
 * The geometry is shared by the module (reference count `users`) and the materials are the rig's `chitin` (hit flash) · `eyeMat` (visor) as they are.
 * ⚠ `RogueModel` is `import type` only (circular import).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Layers } from '@/shared';
import type { BugAnim } from '../BugModel';
import type { RogueRig } from '../RogueModel';
import type { Enemy } from '../../Enemy';

/** Wire hints (`EnemyWire.a`) — the AI (`ai/named/Hammer`) writes them and this file reads them. */
export const HAMMER_HINT_WINDUP = 16;
export const HAMMER_HINT_CHARGE = 17;
/** Where the slammed hammer head meets the ground: metres forward of the body centre (a drawing constant matched to the `POSE_STRIKE` pose below). */
export const HAMMER_IMPACT_FORWARD = 1.0;

/** Scale against the base rogue — head 1.66 × 1.12 = 1.86 (`ROGUE_RIG_PARAMS.rogue_hammer`), height ≈ 2.05 m. */
const HAMMER_SCALE = 1.12;
const VISOR_RED = 0xff2a12;
const C = {
  armor: 0x2a2626, plate: 0x3a3432, cloth: 0x1a1818, accent: 0x7a1a14,
  metal: 0x5a5250, dark: 0x242020, rust: 0x6a3a22, wood: 0x3a2c22,
};

/* X rotation of the hammer-arm pivot (rad). 0 = the hammer level and forward, positive = the head down, negative = up · back. */
const POSE_CARRY = 1.1;     // before it is alert: hanging low
const POSE_READY = 0.6;     // in combat: angled forward
const POSE_RAISED = -2.3;   // wind-up: behind the head
const POSE_STRIKE = 0.7;    // the moment of the slam (with the upper-body bend the head reaches the ground)
const POSE_DEAD = 1.5;
const ARMS_Y = 0.5;
const ARMS_Z = 0.06;

interface HammerLookState {
  kind: 'hammer';
  arms: THREE.Group;
  /** 0..1 pose weights that follow smoothly */
  raise: number;
  slam: number;
  lean: number;
  ready: number;
  droop: number;
}

interface HammerAssets {
  chest: THREE.BufferGeometry;
  pelvis: THREE.BufferGeometry;
  mask: THREE.BufferGeometry;
  slit: THREE.BufferGeometry;
  arms: THREE.BufferGeometry;
  thigh: THREE.BufferGeometry;
  shin: THREE.BufferGeometry;
}

let assets: HammerAssets | null = null;
let users = 0;

const _col = new THREE.Color();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();

const smooth = (x: number): number => x * x * (3 - 2 * x);

function colorize(geo: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  _col.setHex(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = _col.r; arr[i * 3 + 1] = _col.g; arr[i * 3 + 2] = _col.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, hex: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return colorize(g, hex);
}

/** Cylinder from `a` to `b`. */
function limb(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, hex: number): THREE.BufferGeometry {
  _a.set(ax, ay, az); _b.set(bx, by, bz);
  const len = _a.distanceTo(_b);
  const g = new THREE.CylinderGeometry(r * 0.85, r, len, 8, 1);
  g.translate(0, len / 2, 0);
  _dir.subVectors(_b, _a).normalize();
  _q.setFromUnitVectors(_up, _dir);
  g.applyQuaternion(_q);
  g.translate(ax, ay, az);
  return colorize(g, hex);
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const m = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!m) throw new Error('[enemies] hammer mergeGeometries failed');
  m.computeBoundingSphere();
  return m;
}

function build(): HammerAssets {
  // upper body (in torso pivot space — the base chest is 0.42 × 0.5 × 0.26, centre y 0.3)
  const chest = merge([
    box(0.5, 0.4, 0.12, 0, 0.35, 0.15, C.plate),       // thick chest plate
    box(0.3, 0.05, 0.13, 0, 0.47, 0.16, C.accent),     // red band
    box(0.06, 0.06, 0.06, 0.15, 0.33, 0.22, C.metal),  // bolts
    box(0.06, 0.06, 0.06, -0.15, 0.33, 0.22, C.metal),
    box(0.44, 0.15, 0.1, 0, 0.1, 0.14, C.armor),       // abdomen plate
    box(0.46, 0.42, 0.12, 0, 0.32, -0.2, C.armor),     // back plate
    box(0.08, 0.36, 0.26, 0.25, 0.3, 0, C.armor),      // flank plate
    box(0.08, 0.36, 0.26, -0.25, 0.3, 0, C.armor),
    box(0.34, 0.1, 0.32, 0, 0.62, 0, C.dark),          // neck guard
    box(0.22, 0.16, 0.3, 0.34, 0.56, 0, C.metal),      // pauldron
    box(0.24, 0.04, 0.32, 0.34, 0.65, 0, C.rust),
    box(0.22, 0.16, 0.3, -0.34, 0.56, 0, C.metal),
    box(0.24, 0.04, 0.32, -0.34, 0.65, 0, C.rust),
  ]);
  // pelvis (in hip pivot space)
  const pelvis = merge([
    box(0.4, 0.08, 0.3, 0, 0.08, 0, C.dark),           // wide belt
    box(0.08, 0.06, 0.06, 0, 0.08, 0.16, C.rust),      // buckle
    box(0.16, 0.22, 0.06, 0.12, -0.14, 0.15, C.armor), // front groin plate
    box(0.16, 0.22, 0.06, -0.12, -0.14, 0.15, C.armor),
    box(0.36, 0.2, 0.06, 0, -0.12, -0.15, C.armor),    // back
  ]);
  // head (in head pivot space — the base head sphere r 0.135; the base visor at z 0.125 is hidden behind the mask plate)
  const mask = merge([
    box(0.27, 0.26, 0.06, 0, -0.01, 0.13, C.dark),     // welding mask plate
    box(0.29, 0.05, 0.09, 0, 0.12, 0.12, C.metal),     // brow ledge
    box(0.22, 0.03, 0.03, 0, 0.066, 0.168, C.metal),   // rim above the visor slit
    box(0.22, 0.03, 0.03, 0, 0.004, 0.168, C.metal),   // rim below it
    box(0.05, 0.05, 0.05, 0.15, 0.08, 0.06, C.metal),  // hinge
    box(0.05, 0.05, 0.05, -0.15, 0.08, 0.06, C.metal),
    limb(0.07, -0.1, 0.15, 0.13, -0.15, 0.24, 0.042, C.metal),    // gas filters
    limb(-0.07, -0.1, 0.15, -0.13, -0.15, 0.24, 0.042, C.metal),
    box(0.075, 0.075, 0.03, 0.135, -0.155, 0.245, C.accent),
    box(0.075, 0.075, 0.03, -0.135, -0.155, 0.245, C.accent),
    box(0.32, 0.07, 0.32, 0, 0.15, -0.01, C.armor),    // helmet cap
    box(0.3, 0.18, 0.06, 0, 0, -0.14, C.armor),        // nape guard
  ]);
  const slit = new THREE.BoxGeometry(0.2, 0.03, 0.02);  // the red glowing slit (eyeMat — no vertex colours)
  slit.translate(0, 0.035, 0.172);
  // hammer arms (in chest pivot space, pose 0 = arms reaching forward with the haft along +Z)
  const arms = merge([
    limb(0.26, 0, -0.02, 0.21, -0.13, 0.2, 0.07, C.cloth),        // right upper arm
    limb(0.21, -0.13, 0.2, 0.05, -0.06, 0.42, 0.064, C.armor),    // right forearm → grip
    limb(-0.26, 0, -0.02, -0.21, -0.12, 0.26, 0.07, C.cloth),     // left upper arm
    limb(-0.21, -0.12, 0.26, -0.03, -0.06, 0.62, 0.064, C.armor), // left forearm → the front of the grip
    box(0.11, 0.11, 0.11, 0.21, -0.13, 0.2, C.metal),             // elbow
    box(0.11, 0.11, 0.11, -0.21, -0.12, 0.26, C.metal),
    box(0.13, 0.13, 0.13, 0.05, -0.06, 0.42, C.dark),             // gauntlet
    box(0.13, 0.13, 0.13, -0.03, -0.06, 0.62, C.dark),
    limb(0, -0.06, 0.12, 0, -0.06, 1.2, 0.036, C.wood),           // haft
    box(0.085, 0.085, 0.36, 0, -0.06, 0.52, C.cloth),             // grip wrap
    box(0.13, 0.15, 0.14, 0, -0.06, 1.12, C.metal),               // head neck
    box(0.26, 0.56, 0.3, 0, -0.06, 1.3, C.metal),                 // hammer head (long axis Y, striking face −Y)
    box(0.28, 0.1, 0.32, 0, -0.06, 1.3, C.rust),                  // rust band
    box(0.3, 0.07, 0.34, 0, -0.37, 1.3, C.dark),                  // striking face
    box(0.3, 0.07, 0.34, 0, 0.25, 1.3, C.dark),                   // opposite face
  ]);
  const thigh = merge([
    box(0.18, 0.26, 0.1, 0, -0.2, 0.08, C.armor),
    box(0.19, 0.04, 0.11, 0, -0.12, 0.08, C.rust),
  ]);
  const shin = merge([
    box(0.16, 0.15, 0.09, 0, -0.02, 0.09, C.metal),    // knee guard
    box(0.14, 0.28, 0.06, 0, -0.24, 0.09, C.armor),    // shin plate
    box(0.16, 0.1, 0.3, 0, -0.46, 0.06, C.dark),       // steel-plated boot
  ]);
  return { chest, pelvis, mask, slit, arms, thigh, shin };
}

function stateOf(rig: RogueRig): HammerLookState | null {
  const s = rig.named as HammerLookState | undefined;
  return s && s.kind === 'hammer' ? s : null;
}

export function decorateHammerLook(rig: RogueRig): void {
  if (!assets) assets = build();
  users++;
  const A = assets;
  const mesh = (g: THREE.BufferGeometry, m: THREE.Material = rig.chitin): THREE.Mesh => {
    const x = new THREE.Mesh(g, m);
    x.castShadow = true;
    x.layers.enable(Layers.ENEMY);
    return x;
  };
  rig.torso.add(mesh(A.chest));
  rig.body.add(mesh(A.pelvis));
  rig.head.add(mesh(A.mask), mesh(A.slit, rig.eyeMat));
  for (const leg of rig.legs) { leg.hip.add(mesh(A.thigh)); leg.knee.add(mesh(A.shin)); }

  const arms = new THREE.Group();
  arms.name = 'hammer_arms';
  arms.position.set(0, ARMS_Y, ARMS_Z);
  arms.rotation.x = POSE_CARRY;
  arms.add(mesh(A.arms));
  rig.torso.add(arms);

  rig.gun.visible = false;                 // the rifle + the arms holding it (one mesh) — the hammer arms take their place. `muzzle` stays inside it
  rig.eyeMat.emissive.setHex(VISOR_RED);   // a per-rig cloned material, so it does not bleed onto other rogues
  rig.baseScale = HAMMER_SCALE;
  rig.root.scale.setScalar(HAMMER_SCALE);
  const state: HammerLookState = { kind: 'hammer', arms, raise: 0, slam: 0, lean: 0, ready: 0, droop: 0 };
  rig.named = state;
}

/** Every frame after `animateRogue`. The base pose is `set` every frame, so this only adds to it. */
export function animateHammerLook(rig: RogueRig, a: BugAnim, e: Enemy, dt: number): void {
  const L = stateOf(rig);
  if (!L) return;
  const dying = a.death >= 0;
  const hint = dying ? 0 : e.namedHint;

  const raiseT = hint === HAMMER_HINT_WINDUP ? 1 : 0;
  L.raise += (raiseT - L.raise) * Math.min(1, dt * (raiseT > 0 ? 10 : 3.5));
  const slamT = !dying && a.recoil > 0.35 ? 1 : 0;
  L.slam += (slamT - L.slam) * Math.min(1, dt * (slamT > 0 ? 30 : 3));
  const leanT = hint === HAMMER_HINT_CHARGE ? 1 : 0;
  L.lean += (leanT - L.lean) * Math.min(1, dt * 6);
  const readyT = e.aware && !dying ? 1 : 0;
  L.ready += (readyT - L.ready) * Math.min(1, dt * 3);
  const droopT = !dying && e.state === 'stagger' ? 1 : 0;
  L.droop += (droopT - L.droop) * Math.min(1, dt * 6);

  const sr = smooth(THREE.MathUtils.clamp(L.raise, 0, 1));
  const ss = smooth(THREE.MathUtils.clamp(L.slam, 0, 1));
  const t = a.time;
  const wr = dying ? 0 : a.writhe;

  let pose = THREE.MathUtils.lerp(POSE_CARRY, POSE_READY, L.ready);
  pose += Math.sin(a.gait) * 0.08 * a.speed * (1 - L.ready * 0.6);   // swing with the walk
  pose = THREE.MathUtils.lerp(pose, POSE_RAISED + Math.sin(t * 38) * 0.02, sr);
  pose = THREE.MathUtils.lerp(pose, POSE_STRIKE, ss);
  pose += L.droop * 0.4 + L.lean * 0.35 + Math.sin(t * 9.3) * 0.5 * wr;
  if (dying) pose = THREE.MathUtils.lerp(pose, POSE_DEAD, Math.min(1, a.deathFall * 1.5));

  L.arms.rotation.set(pose, a.headYaw * 0.25 * (1 - sr), Math.sin(t * 7.1) * 0.3 * wr);
  L.arms.position.set(0, ARMS_Y + sr * 0.06 - ss * 0.04, ARMS_Z - sr * 0.04 + ss * 0.05);

  if (dying) return;
  // body: wind-up = leaning back, slam = bending forward and dropping low, charge = leaning forward (the head goes the other way to keep facing front)
  rig.torso.rotation.x += -0.28 * sr + 0.35 * ss + 0.28 * L.lean;
  rig.body.rotation.x += 0.12 * ss + 0.25 * L.lean;
  rig.body.position.y -= 0.1 * ss;
  rig.head.rotation.x += 0.2 * sr - 0.25 * ss - 0.2 * L.lean;
}

export function disposeHammerLook(rig: RogueRig): void {
  const L = stateOf(rig);
  if (!L) return;
  rig.named = undefined;
  L.arms.removeFromParent();
  users--;
  if (users <= 0 && assets) {
    const A = assets;
    A.chest.dispose(); A.pelvis.dispose(); A.mask.dispose(); A.slit.dispose(); A.arms.dispose(); A.thigh.dispose(); A.shin.dispose();
    assets = null;
    users = 0;
  }
}
