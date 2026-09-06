import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Layers, ROGUE_BOSS_SCALE } from '@/shared';
import { statusEmissive, type BugAnim } from './BugModel';

/* ────────────────────────────────────────────────────────────────────────────
 * Procedural humanoid rig for the rogue gunners (Phase 4). Root at the feet, +Z = facing, 1.8 m tall at scale 1.
 * The boss shares every geometry and is scaled by ROGUE_BOSS_SCALE through `root.scale` (see `baseScale`), with a
 * left shoulder pauldron and a red visor. Vertex-coloured like the bugs; one cloned `chitin` material per rig for the
 * hit flash, one `eyeMat` for the visor glow.
 * ──────────────────────────────────────────────────────────────────────────── */

export type RogueType = 'rogue' | 'rogue_boss';

export interface RogueRigParams {
  head: { r: number; y: number; z: number };
  strideLength: number;
}

export interface RogueRig {
  kind: 'rogue';
  type: RogueType;
  params: RogueRigParams;
  baseScale: number;
  root: THREE.Group;
  /** pelvis pivot at hip height */
  body: THREE.Group;
  torso: THREE.Group;
  head: THREE.Group;
  /** arms + rifle, pivot at the right shoulder */
  gun: THREE.Group;
  /** rifle tip (world position via getWorldPosition) */
  muzzle: THREE.Object3D;
  legs: { hip: THREE.Group; knee: THREE.Group; side: number }[];
  chitin: THREE.MeshStandardMaterial;
  eyeMat: THREE.MeshStandardMaterial;
}

const HIP_Y = 0.95;
const THIGH = 0.45;
const SHIN = 0.5;

export const ROGUE_RIG_PARAMS: Record<RogueType, RogueRigParams> = {
  rogue: { head: { r: 0.16, y: 1.66, z: 0.02 }, strideLength: 1.5 },
  rogue_boss: { head: { r: 0.16 * ROGUE_BOSS_SCALE, y: 1.66 * ROGUE_BOSS_SCALE, z: 0.02 * ROGUE_BOSS_SCALE }, strideLength: 1.5 * ROGUE_BOSS_SCALE },
};

interface Palette { armor: number; cloth: number; accent: number; metal: number; visor: number; skin: number }
const PALETTES: Record<RogueType, Palette> = {
  rogue: { armor: 0x3b3f36, cloth: 0x26262a, accent: 0xc8641e, metal: 0x55575a, visor: 0x40d0ff, skin: 0x8a6a52 },
  rogue_boss: { armor: 0x2e2a30, cloth: 0x1e1c22, accent: 0xb02020, metal: 0x4a4650, visor: 0xff3030, skin: 0x7a5a48 },
};

interface Assets {
  pelvis: THREE.BufferGeometry;
  chest: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  visor: THREE.BufferGeometry;
  gunArms: THREE.BufferGeometry;
  thigh: THREE.BufferGeometry;
  shin: THREE.BufferGeometry;
  chitin: THREE.MeshStandardMaterial;
  eye: THREE.MeshStandardMaterial;
}
const assets = new Map<RogueType, Assets>();
const tmpColor = new THREE.Color();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

function colorize(geo: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  tmpColor.setHex(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = tmpColor.r; arr[i * 3 + 1] = tmpColor.g; arr[i * 3 + 2] = tmpColor.b; }
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
  const g = new THREE.CylinderGeometry(r * 0.85, r, len, 7, 1);
  g.translate(0, len / 2, 0);
  const dir = _b.clone().sub(_a).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  g.applyQuaternion(q);
  g.translate(ax, ay, az);
  return colorize(g, hex);
}
function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const m = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!m) throw new Error('[enemies] rogue mergeGeometries failed');
  m.computeBoundingSphere();
  return m;
}

function build(type: RogueType): Assets {
  const c = PALETTES[type];
  const boss = type === 'rogue_boss';
  // pelvis + belt (relative to the hip pivot)
  const pelvis = merge([
    box(0.34, 0.2, 0.24, 0, -0.02, 0, c.cloth),
    box(0.36, 0.06, 0.26, 0, 0.08, 0, c.metal),
    box(0.1, 0.12, 0.08, 0.16, -0.06, 0.1, c.armor),      // holster pouch
  ]);
  // chest (relative to torso pivot slightly above the hips)
  const chestParts = [
    box(0.42, 0.5, 0.26, 0, 0.3, 0, c.cloth),
    box(0.44, 0.34, 0.1, 0, 0.36, 0.1, c.armor),          // chest plate
    box(0.3, 0.05, 0.11, 0, 0.5, 0.11, c.accent),         // stripe
    box(0.36, 0.3, 0.14, 0, 0.3, -0.16, c.armor),         // backpack
    box(0.12, 0.1, 0.16, 0.24, 0.52, 0, c.armor),         // right shoulder pad
    box(0.12, 0.1, 0.16, -0.24, 0.52, 0, c.armor),        // left shoulder pad
  ];
  if (boss) {
    chestParts.push(box(0.22, 0.16, 0.26, -0.3, 0.56, 0, c.metal));   // pauldron
    chestParts.push(box(0.24, 0.04, 0.28, -0.3, 0.65, 0, c.accent));
    chestParts.push(box(0.06, 0.3, 0.06, -0.3, 0.8, 0, c.metal));      // antenna spike
  }
  const chest = merge(chestParts);
  const headGeo = new THREE.SphereGeometry(0.135, 12, 9);
  headGeo.scale(1, 1.05, 1.02);
  const head = merge([
    colorize(headGeo, c.armor),
    box(0.3, 0.08, 0.3, 0, 0.1, -0.01, c.armor),          // helmet brim
    box(0.08, 0.06, 0.06, 0.15, -0.02, 0.02, c.metal),    // ear cup
    box(0.08, 0.06, 0.06, -0.15, -0.02, 0.02, c.metal),
    box(0.16, 0.08, 0.04, 0, -0.08, 0.12, c.skin),        // chin
  ]);
  const visor = box(0.2, 0.055, 0.04, 0, 0.01, 0.125, c.visor);
  // arms posed around the rifle, relative to the right shoulder pivot; rifle points +Z
  const gunArms = merge([
    limb(0, 0, 0, 0.02, -0.16, 0.24, 0.045, c.cloth),                 // right upper arm
    limb(0.02, -0.16, 0.24, -0.08, -0.2, 0.42, 0.04, c.armor),        // right forearm → grip
    limb(-0.46, 0, 0, -0.3, -0.2, 0.3, 0.045, c.cloth),               // left upper arm
    limb(-0.3, -0.2, 0.3, -0.12, -0.22, 0.56, 0.04, c.armor),         // left forearm → foregrip
    box(0.06, 0.1, 0.72, -0.1, -0.16, 0.5, c.metal),                   // rifle body
    box(0.05, 0.05, 0.3, -0.1, -0.13, 0.95, c.metal),                  // barrel
    box(0.05, 0.12, 0.08, -0.1, -0.26, 0.34, c.cloth),                 // grip
    box(0.06, 0.1, 0.16, -0.1, -0.2, 0.16, c.cloth),                   // stock
    box(0.04, 0.12, 0.06, -0.1, -0.28, 0.52, c.metal),                 // magazine
    box(0.03, 0.05, 0.14, -0.1, -0.08, 0.6, c.accent),                 // sight
  ]);
  const thigh = merge([limb(0, 0, 0, 0, -THIGH, 0, 0.075, c.cloth), box(0.14, 0.2, 0.08, 0, -0.2, 0.06, c.armor)]);
  const shin = merge([limb(0, 0, 0, 0, -SHIN, 0, 0.06, c.cloth), box(0.12, 0.14, 0.12, 0, -SHIN + 0.07, 0.03, c.armor), box(0.13, 0.08, 0.26, 0, -SHIN + 0.04, 0.05, c.metal)]);
  return {
    pelvis, chest, head, visor, gunArms, thigh, shin,
    chitin: new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.6, metalness: 0.15, emissive: 0x000000 }),
    eye: new THREE.MeshStandardMaterial({ color: 0x050505, emissive: c.visor, emissiveIntensity: 2.2, roughness: 0.2 }),
  };
}

function getAssets(type: RogueType): Assets {
  let a = assets.get(type);
  if (!a) { a = build(type); assets.set(type, a); }
  return a;
}

export function disposeRogueAssets(): void {
  for (const a of assets.values()) {
    a.pelvis.dispose(); a.chest.dispose(); a.head.dispose(); a.visor.dispose(); a.gunArms.dispose(); a.thigh.dispose(); a.shin.dispose();
    a.chitin.dispose(); a.eye.dispose();
  }
  assets.clear();
}

export function createRogueRig(type: RogueType): RogueRig {
  const a = getAssets(type);
  const chitin = a.chitin.clone();
  const eyeMat = a.eye.clone();
  const mesh = (g: THREE.BufferGeometry, m: THREE.Material = chitin): THREE.Mesh => {
    const x = new THREE.Mesh(g, m);
    x.castShadow = true;
    x.layers.enable(Layers.ENEMY);
    return x;
  };

  const root = new THREE.Group();
  root.name = `rogue_${type}`;
  const body = new THREE.Group();
  body.position.y = HIP_Y;
  root.add(body);
  body.add(mesh(a.pelvis));

  const torso = new THREE.Group();
  torso.position.y = 0.1;
  body.add(torso);
  torso.add(mesh(a.chest));

  const head = new THREE.Group();
  head.position.set(0, 0.61 + 0.14, 0.02);
  head.add(mesh(a.head), mesh(a.visor, eyeMat));
  torso.add(head);

  const gun = new THREE.Group();
  gun.position.set(0.23, 0.5, 0.06);
  gun.rotation.x = 0.6;
  gun.add(mesh(a.gunArms));
  const muzzle = new THREE.Object3D();
  muzzle.position.set(-0.1, -0.13, 1.1);
  gun.add(muzzle);
  torso.add(gun);

  const legs: RogueRig['legs'] = [];
  for (const side of [1, -1]) {
    const hip = new THREE.Group();
    hip.position.set(side * 0.13, -0.08, 0);
    hip.add(mesh(a.thigh));
    const knee = new THREE.Group();
    knee.position.y = -THIGH;
    knee.add(mesh(a.shin));
    hip.add(knee);
    body.add(hip);
    legs.push({ hip, knee, side });
  }

  const baseScale = type === 'rogue_boss' ? ROGUE_BOSS_SCALE : 1;
  root.scale.setScalar(baseScale);
  return { kind: 'rogue', type, params: ROGUE_RIG_PARAMS[type], baseScale, root, body, torso, head, gun, muzzle, legs, chitin, eyeMat };
}

export function disposeRogueRig(rig: RogueRig): void {
  rig.chitin.dispose();
  rig.eyeMat.dispose();
  rig.root.removeFromParent();
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/**
 * Drive the humanoid from the shared BugAnim: gait/speed (walk cycle), crouch (cover), aim (rifle raised), recoil,
 * headYaw/headPitch (look + aim direction), flinch/hitFlash, death (fall) + fade (sink).
 */
export function animateRogue(rig: RogueRig, a: BugAnim): void {
  const t = a.time;
  const dying = a.death >= 0;
  const moving = a.speed > 0.03 ? 1 : 0;
  const crouch = THREE.MathUtils.clamp(a.crouch, 0, 1);

  // 전소 writhe: staggering half-crouch, torso and pelvis bucking, legs kicking, rifle waved around
  const wr = dying ? 0 : a.writhe;

  // legs
  for (const leg of rig.legs) {
    const ph = a.gait + (leg.side > 0 ? 0 : Math.PI);
    const swing = Math.sin(ph) * 0.65 * a.speed * moving;
    const bend = Math.max(0, -Math.cos(ph)) * 1.0 * a.speed * moving;
    const kick = wr * (0.35 + Math.sin(t * 10.5 + leg.side * 1.4) * 0.45);
    leg.hip.rotation.x = -swing + crouch * 1.15 + (dying ? 0.3 : 0) + kick;
    leg.knee.rotation.x = bend + crouch * 1.5 + wr * (0.5 + Math.cos(t * 12 + leg.side) * 0.4);
    leg.hip.rotation.z = leg.side * crouch * 0.25 + leg.side * wr * 0.2;
  }

  // pelvis: bob, crouch, death fall
  const bob = Math.abs(Math.sin(a.gait)) * 0.035 * a.speed;
  const shake = a.shake > 0 ? (Math.sin(t * 50) * 0.02) * a.shake : 0;
  let y = HIP_Y - crouch * 0.42 + bob - wr * 0.22;
  let pitch = a.slopePitch + a.speed * 0.08 + crouch * 0.28 + a.flinch * a.flinchZ * 0.25 + wr * (0.25 + Math.sin(t * 7.3) * 0.2);
  let roll = a.slopeRoll + a.flinch * a.flinchX * 0.3 + shake + Math.sin(t * 9.1) * 0.3 * wr;
  if (dying) {
    const fall = smooth(Math.min(1, a.death / 0.3));
    pitch += -fall * 1.5 * (a.rollSign > 0 ? 1 : 0.55);     // fall backward (or mostly sideways)
    roll += a.rollSign * fall * (a.rollSign > 0 ? 0.35 : 1.3);
    y = THREE.MathUtils.lerp(y, 0.3, fall) - smooth(a.fade) * 1.4;
  }
  rig.body.position.set(shake, y, 0);
  rig.body.rotation.set(pitch, 0, roll);

  // torso lean into the aim / cover
  rig.torso.rotation.set(a.aim * 0.1 + crouch * 0.15 + wr * 0.2, a.aim * a.headYaw * 0.35 + Math.sin(t * 8.4 + 1) * 0.45 * wr, Math.sin(t * 6.2) * 0.15 * wr);

  // head
  rig.head.rotation.set(a.headPitch * 0.7 + (dying ? -0.6 : 0) + Math.sin(t * 11) * 0.3 * wr, a.headYaw * (1 - a.aim * 0.35) + Math.sin(t * 7.7) * 0.35 * wr, 0);

  // rifle: low-ready ↔ aimed, kick on recoil, sway while idle (flailed around while writhing)
  const k = a.recoil * a.recoil;
  const sway = (1 - a.aim) * (Math.sin(t * 1.3) * 0.03 + Math.sin(t * 2.1) * 0.02) + wr * (Math.sin(t * 9.6) * 0.5 - 0.3);
  rig.gun.rotation.set(THREE.MathUtils.lerp(0.6, a.headPitch, a.aim) - k * 0.2 + sway + (dying ? 0.8 : 0), THREE.MathUtils.lerp(0.12, a.headYaw * 0.65, a.aim) + Math.sin(t * 8.8 + 2) * 0.4 * wr, 0);
  rig.gun.position.set(0.23 - a.aim * 0.05, 0.5 - a.aim * 0.03, 0.06 - k * 0.07);

  // hit flash / 전소 glow / shock spark / visor
  statusEmissive(rig.chitin, a, 1, 0.6, 0.35, 1.1);
  if (dying) rig.eyeMat.emissiveIntensity = 2.2 * (1 - smooth(Math.min(1, a.death / 0.4)));
  else if (rig.eyeMat.emissiveIntensity !== 2.2) rig.eyeMat.emissiveIntensity = 2.2;
}
