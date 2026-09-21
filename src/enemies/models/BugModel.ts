import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BUG_MESH_SEGMENTS, Layers } from '@/shared';
import type { BugType } from '../EnemyTypes';
import { BUG_PARAMS, type BugParams } from './BugParams';

/* ────────────────────────────────────────────────────────────────────────────
 * Shared per-type assets (geometries + template materials), created lazily once.
 * ──────────────────────────────────────────────────────────────────────────── */
interface TypeAssets {
  body: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  eyes: THREE.BufferGeometry;
  mandible: THREE.BufferGeometry;
  femur: THREE.BufferGeometry;
  tibia: THREE.BufferGeometry;
  abdomen: THREE.BufferGeometry | null;
  /** artillery mortar tube (Phase 4) */
  mortar: THREE.BufferGeometry | null;
  chitin: THREE.MeshStandardMaterial;
  eye: THREE.MeshStandardMaterial;
  acid: THREE.MeshStandardMaterial | null;
  /** 2026-09-17: red stripes (hunter) — one geometry and one material per type, never cloned per instance (they take no hit flash · incinerate glow). */
  stripes: THREE.BufferGeometry | null;
  stripeMat: THREE.MeshStandardMaterial | null;
}

const assets = new Map<BugType, TypeAssets>();
const tmpColor = new THREE.Color();

function colorize(geo: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  tmpColor.setHex(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = tmpColor.r; arr[i * 3 + 1] = tmpColor.g; arr[i * 3 + 2] = tmpColor.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/**
 * 2026-09-20 (`docs/PERF.md` perf Phase A, user's decision 「전 타입 12~14 세그먼트」): every sphere a bug body is
 * built from passes through here, so the detail budget lives in one place (`BUG_MESH_SEGMENTS`) while the per-part
 * `seg` arguments keep saying what the part *wants*. Raising a `seg` above the budget now changes nothing — change
 * the csv row instead.
 */
const segBudget = (seg: number): number => Math.min(seg, BUG_MESH_SEGMENTS);

function ellipsoid(rx: number, ry: number, rz: number, x: number, y: number, z: number, hex: number, want = 16): THREE.BufferGeometry {
  const seg = segBudget(want);
  const g = new THREE.SphereGeometry(1, seg, Math.max(8, Math.round(seg * 0.7)));
  g.scale(rx, ry, rz);
  g.translate(x, y, z);
  return colorize(g, hex);
}

function cone(r: number, len: number, hex: number, seg = 7): THREE.BufferGeometry {
  // tip along +Z, base at origin
  const g = new THREE.ConeGeometry(r, len, seg);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, len / 2);
  return colorize(g, hex);
}

function segment(rEnd: number, rStart: number, len: number, hex: number): THREE.BufferGeometry {
  // along +X from origin
  const g = new THREE.CylinderGeometry(rEnd, rStart, len, 6, 1);
  g.rotateZ(-Math.PI / 2);
  g.translate(len / 2, 0, 0);
  return colorize(g, hex);
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) throw new Error('[enemies] mergeGeometries failed');
  merged.computeBoundingSphere();
  return merged;
}

function lighten(hex: number, f: number): number {
  tmpColor.setHex(hex);
  tmpColor.r = Math.min(1, tmpColor.r * f); tmpColor.g = Math.min(1, tmpColor.g * f); tmpColor.b = Math.min(1, tmpColor.b * f);
  return tmpColor.getHex();
}

function buildBodyGeometry(p: BugParams): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const [tx, ty, tz] = p.thorax;
  parts.push(ellipsoid(tx, ty, tz, 0, p.thoraxY, 0, p.base, 18));
  // neck collar
  parts.push(ellipsoid(tx * 0.7, ty * 0.7, tz * 0.35, 0, p.thoraxY - ty * 0.05, tz * 0.75, lighten(p.base, 1.25), 10));
  // carapace plates along the back
  for (let i = 0; i < p.plates; i++) {
    const t = p.plates === 1 ? 0.5 : i / (p.plates - 1);
    const z = THREE.MathUtils.lerp(tz * 0.55, -tz * 0.45, t);
    const plateColor = p.armor ?? lighten(p.base, 1.6);
    parts.push(ellipsoid(tx * (0.95 - t * 0.1), ty * 0.32, tz * 0.3, 0, p.thoraxY + ty * 0.72, z, i === 0 ? plateColor : lighten(p.base, 1.5), 10));
    // accent stripe on each plate edge
    parts.push(ellipsoid(tx * 0.98, ty * 0.06, tz * 0.31, 0, p.thoraxY + ty * 0.7, z, p.accent, 8));
  }
  if (!p.separateAbdomen) {
    const [ax, ay, az] = p.abdomen;
    parts.push(ellipsoid(ax, ay, az, 0, p.abdomenY, p.abdomenZ, p.base, 16));
    for (let i = 0; i < p.rings; i++) {
      const z = p.abdomenZ + az * (0.45 - i * (0.9 / Math.max(1, p.rings)));
      const shrink = Math.sqrt(Math.max(0.05, 1 - ((z - p.abdomenZ) / az) ** 2));
      parts.push(ellipsoid(ax * 1.02 * shrink, ay * 1.02 * shrink, az * 0.06, 0, p.abdomenY, z, p.accent, 12));
    }
    // stinger tip
    const tip = cone(ax * 0.35, az * 0.6, lighten(p.base, 0.8), 6);
    tip.rotateY(Math.PI);
    tip.translate(0, p.abdomenY - ay * 0.2, p.abdomenZ - az * 0.75);
    parts.push(tip);
  }
  if (p.armor !== null) {
    // frontal armor shield (charger / warrior collar)
    parts.push(ellipsoid(tx * 1.06, ty * 1.02, tz * 0.32, 0, p.thoraxY + ty * 0.05, tz * 0.72, p.armor, 14));
  }
  if (p.frontPlate) {
    // behemoth: thick dark plate hanging in front of the head (separate armoured hitbox, see Enemy.isFrontPlate)
    const pz = p.head.z + p.head.r * 0.9;
    parts.push(ellipsoid(tx * 0.95, ty * 1.45, tz * 0.11, 0, p.thoraxY, pz, p.frontPlate.color, 14));
    parts.push(ellipsoid(tx * 0.98, ty * 0.1, tz * 0.12, 0, p.thoraxY + ty * 0.9, pz, p.accent, 8));
    parts.push(ellipsoid(tx * 0.98, ty * 0.1, tz * 0.12, 0, p.thoraxY - ty * 0.9, pz, p.accent, 8));
    for (const side of [-1, 1]) {
      const s = cone(tx * 0.1, ty * 0.7, p.armor ?? p.accent, 6);
      s.translate(side * tx * 0.55, p.thoraxY + ty * 0.3, pz);
      parts.push(s);
    }
    // bridge from the collar to the plate
    parts.push(ellipsoid(tx * 0.5, ty * 0.5, (pz - tz * 0.7) * 0.6, 0, p.thoraxY, (pz + tz * 0.7) * 0.5, p.frontPlate.color, 10));
  }
  if (p.spikes) {
    for (let i = 0; i < 4; i++) {
      const s = cone(tx * 0.12, ty * 0.9, p.accent, 5);
      s.rotateX(-Math.PI / 2 + 0.35); // point up-back
      s.translate((i % 2 === 0 ? -1 : 1) * tx * 0.45, p.thoraxY + ty * 0.7, tz * (0.3 - Math.floor(i / 2) * 0.5));
      parts.push(s);
    }
  }
  return merge(parts);
}

function buildHeadGeometry(p: BugParams): THREE.BufferGeometry {
  const r = p.head.r;
  const parts: THREE.BufferGeometry[] = [];
  parts.push(ellipsoid(r, r * 0.85, r * 1.1, 0, 0, 0, p.base, 14));
  // head plate / brow
  parts.push(ellipsoid(r * 0.95, r * 0.42, r * 0.85, 0, r * 0.55, -r * 0.1, p.armor ?? lighten(p.base, 1.5), 10));
  parts.push(ellipsoid(r * 0.98, r * 0.08, r * 0.86, 0, r * 0.52, -r * 0.1, p.accent, 8));
  // antennae
  for (const side of [-1, 1]) {
    const a = segment(r * 0.03, r * 0.07, p.antennaLen, p.base);
    a.rotateZ(Math.PI / 2 - 0.35 * side);       // up-ish
    a.rotateY(side * 0.55);                      // outward
    a.rotateX(-0.6);                             // forward
    a.translate(side * r * 0.45, r * 0.6, r * 0.5);
    parts.push(a);
  }
  if (p.horns) {
    for (const side of [-1, 1]) {
      const h = cone(r * 0.22, r * 1.6, p.armor ?? p.accent, 7);
      h.rotateX(-0.45);
      h.rotateY(side * 0.25);
      h.translate(side * r * 0.6, r * 0.45, r * 0.5);
      parts.push(h);
    }
  }
  return merge(parts);
}

function buildEyesGeometry(p: BugParams): THREE.BufferGeometry {
  const r = p.head.r;
  const parts: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    const e = new THREE.SphereGeometry(p.eyeR, 8, 6);
    e.translate(side * r * 0.55, r * 0.2, r * 0.82);
    parts.push(e);
    const e2 = new THREE.SphereGeometry(p.eyeR * 0.55, 6, 5);
    e2.translate(side * r * 0.8, r * 0.38, r * 0.55);
    parts.push(e2);
  }
  return merge(parts);
}

function buildMortarGeometry(p: BugParams): THREE.BufferGeometry | null {
  const m = p.mortar;
  if (!m) return null;
  const parts: THREE.BufferGeometry[] = [];
  // tube along +Z from the pivot (the rig group tilts it)
  const tube = new THREE.CylinderGeometry(m.r, m.r * 0.85, m.len, 10, 1, true);
  tube.rotateX(Math.PI / 2);
  tube.translate(0, 0, m.len / 2);
  parts.push(colorize(tube, p.armor ?? lighten(p.base, 1.4)));
  const lip = new THREE.TorusGeometry(m.r * 1.05, m.r * 0.18, 6, 12);
  lip.translate(0, 0, m.len);
  parts.push(colorize(lip, p.accent));
  const breech = new THREE.SphereGeometry(m.r * 1.5, 10, 8);
  breech.scale(1, 0.8, 1);
  parts.push(colorize(breech, lighten(p.base, 1.2)));
  return merge(parts);
}

/**
 * 2026-09-17 (telling friend from foe): one red band running along the flank + `bands` bands around the abdomen. They sit
 * 3–4 % outside the thorax · abdomen surface so they show without z-fighting. No test uses them (an enemy is tested against a capsule — `RayTests`).
 */
function buildStripeGeometry(p: BugParams): THREE.BufferGeometry | null {
  const st = p.stripes;
  if (!st) return null;
  const parts: THREE.BufferGeometry[] = [];
  const [tx, ty, tz] = p.thorax;
  // flank band: a thin plate a little wider than the thorax — from the side, a red line across the body
  parts.push(ellipsoid(tx * 1.04, ty * 0.13, tz * 0.86, 0, p.thoraxY + ty * 0.05, 0, st.color, 16));
  // collar band
  parts.push(ellipsoid(tx * 0.74, ty * 0.74, tz * 0.08, 0, p.thoraxY - ty * 0.05, tz * 0.62, st.color, 12));
  if (!p.separateAbdomen) {
    const [ax, ay, az] = p.abdomen;
    for (let i = 0; i < st.bands; i++) {
      const z = p.abdomenZ + az * (0.42 - i * (0.84 / Math.max(1, st.bands)));
      const shrink = Math.sqrt(Math.max(0.05, 1 - ((z - p.abdomenZ) / az) ** 2));
      parts.push(ellipsoid(ax * 1.04 * shrink, ay * 1.04 * shrink, az * 0.09, 0, p.abdomenY, z, st.color, 14));
    }
  }
  return merge(parts);
}

function getAssets(type: BugType): TypeAssets {
  let a = assets.get(type);
  if (a) return a;
  const p = BUG_PARAMS[type];
  const legR = p.legs.r;
  a = {
    body: buildBodyGeometry(p),
    head: buildHeadGeometry(p),
    eyes: buildEyesGeometry(p),
    mandible: cone(p.mandibleR, p.mandibleLen, lighten(p.accent, 0.55), 6),
    femur: segment(legR * 0.72, legR, p.legs.l1, p.base),
    tibia: segment(legR * 0.15, legR * 0.72, p.legs.l2, lighten(p.base, 0.85)),
    // the spewer's sac is its own animated mesh (it swells), so it is not merged — but it obeys the same budget
    abdomen: p.separateAbdomen ? (() => { const s = segBudget(20); const g = new THREE.SphereGeometry(1, s, Math.max(8, Math.round(s * 0.7))); g.scale(p.abdomen[0], p.abdomen[1], p.abdomen[2]); return g; })() : null,
    mortar: buildMortarGeometry(p),
    chitin: new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.35, metalness: 0.1, emissive: 0x000000 }),
    eye: new THREE.MeshStandardMaterial({ color: 0x150500, emissive: p.eye, emissiveIntensity: 2.4, roughness: 0.3 }),
    acid: p.separateAbdomen ? new THREE.MeshStandardMaterial({ color: 0x86b545, emissive: 0x3c7a16, emissiveIntensity: 0.6, roughness: 0.45, metalness: 0.05 }) : null,
    stripes: buildStripeGeometry(p),
    stripeMat: p.stripes ? new THREE.MeshStandardMaterial({ color: p.stripes.color, emissive: p.stripes.emissive, emissiveIntensity: p.stripes.emissiveIntensity, roughness: 0.4, metalness: 0.05 }) : null,
  };
  assets.set(type, a);
  return a;
}

/** Frees every shared geometry / template material. Rigs must be disposed first. */
export function disposeBugAssets(): void {
  for (const a of assets.values()) {
    a.body.dispose(); a.head.dispose(); a.eyes.dispose(); a.mandible.dispose(); a.femur.dispose(); a.tibia.dispose();
    a.abdomen?.dispose(); a.mortar?.dispose(); a.chitin.dispose(); a.eye.dispose(); a.acid?.dispose();
    a.stripes?.dispose(); a.stripeMat?.dispose();
  }
  assets.clear();
}

/* ────────────────────────────────────────────────────────────────────────────
 * Rig
 * ──────────────────────────────────────────────────────────────────────────── */
/**
 * One leg — **pose numbers only, no scene node**. 2026-09-20 (`docs/PERF.md` perf Phase 1): the 6 legs used to be
 * 6 × (hipYaw · hipPitch · knee groups + femur · tibia meshes) = 12 of a bug's 17 draw calls and 30 of its scene
 * nodes, and bugs were 60 % of everything drawn in a raid. They are now two `InstancedMesh` of 6 instances each
 * (`BugRig.femurs` · `tibias`), whose matrices `animateBug` composes from these numbers directly — the same
 * `T(hip) · Ry(hipYaw) · Rz(hipPitch)` the group chain used to build, one multiply cheaper.
 */
export interface LegRig {
  side: number;      // +1 left (+X), -1 right
  index: number;     // 0 front, 1 mid, 2 rear
  baseYaw: number;
  restKnee: number;
  /** gait phase offset: tripod gait → alternating triplets */
  phase: number;
}

export interface BugRig {
  kind: 'bug';
  type: BugType;
  params: BugParams;
  /** root scale multiplier (rogue boss uses it; bugs are 1) */
  baseScale: number;
  root: THREE.Group;
  body: THREE.Group;
  bodyMesh: THREE.Mesh;
  head: THREE.Group;
  mandibleL: THREE.Group;
  mandibleR: THREE.Group;
  abdomen: THREE.Mesh | null;
  /** artillery mortar pivot (tilted group holding the tube mesh) */
  mortar: THREE.Group | null;
  legs: LegRig[];
  /** The 6 femurs / tibias, one `InstancedMesh` each — 2 draw calls for what used to be 12 (see `LegRig`). */
  femurs: THREE.InstancedMesh;
  tibias: THREE.InstancedMesh;
  chitin: THREE.MeshStandardMaterial;
  eyeMat: THREE.MeshStandardMaterial;
  acidMat: THREE.MeshStandardMaterial | null;
}

/** Per-frame animation input — owned/mutated by the Enemy entity, read by animateBug. */
export interface BugAnim {
  /** gait phase in radians (advance by distance travelled / stride) */
  gait: number;
  /** 0..1 movement intensity */
  speed: number;
  headYaw: number;
  headPitch: number;
  /** 0 = open, 1 = snapped shut */
  mandible: number;
  /** flinch impulse 0..1 and its local direction */
  flinch: number;
  flinchX: number;
  flinchZ: number;
  /** 0..1 emissive hit flash */
  hitFlash: number;
  /** spewer abdomen swell 0..1 */
  abdomen: number;
  /** charger wind-up shake 0..1 */
  shake: number;
  /** leap anticipation / crouch 0..1 */
  crouch: number;
  /** -1 = alive, else death progress 0..1 (over 4 s — gates the "dying" branch and the eye fade) */
  death: number;
  /**
   * Phase 10: which way the body goes down — index into `ENEMY_DEATH_DIRS` (0 left / 1 right / 2 back).
   * Replaced the old `rollSign`, which was rolled at spawn with unseeded `Math.random()` (host ≠ replica).
   */
  deathDir: number;
  /** Phase 10: fall-pose blend 0..1 over `DEATH_FALL_TIME` (driven by `Enemy.animate` from `deathTimer`). */
  deathFall: number;
  /** body pitch/roll from terrain slope (radians) */
  slopePitch: number;
  slopeRoll: number;
  time: number;
  /* ── Phase 4 ── */
  /** corpse fade-out 0..1 over the last seconds of CORPSE_LIFETIME (body sinks, eyes die) */
  fade: number;
  /** rogue: weapon raised 0..1; artillery: dug-in reuses `crouch`; toxic swell reuses `abdomen`; behemoth wind-up reuses `shake` */
  aim: number;
  /** rogue rifle / artillery mortar recoil impulse 0..1 (decays fast) */
  recoil: number;
  /* ── unique weapons (2026-09-06) ── */
  /** incinerate writhe blend 0..1: body twists side to side, limbs flail, chitin glows orange (Enemy.animate drives it from `incapTimer`). */
  writhe: number;
  /** shocked spark 0..1: cyan-white emissive strobe (flicker computed by Enemy.animate while `shockTimer` runs). */
  spark: number;
  /* ── Phase 7 (rogue AI v2) ── */
  /** rogue reload pose 0..1 (rifle lowered, hands at the magazine); replicas set it from wire hint 12 */
  reload: number;
  /** rogue grenade wind-up 0..1 (rifle to the hip, throwing arm raised with the grenade sphere); wire hint 13 */
  throwing: number;
  /* ── 2026-09-17 ── */
  /** hunter flip 0..1: lying on its back, rocking slowly side to side with its legs flailing (`Enemy.animate` drives it from `flipFalling` / `flipTimer`). */
  flip: number;
  /** 2026-09-17 artillery brace pose 0..1: the legs splay sideways to press the body flat on the ground (`braceTime` before the shot · `postFireLock` after). Replica = hint 25. */
  brace: number;
  /* ── 2026-09-21 (TODO A-18 phase 2) ── */
  /**
   * The wall pose -1..1: +1 = on a wall nose up (climbing; backing down a ladder), -1 = on a wall nose down (going down a face
   * head first). `Enemy.animate` blends it toward `Enemy.navClimbDir` — the authority sets that from `ai/Traverse`, a replica
   * from wire hints 26 · 27.
   */
  climb: number;
}

export function createBugAnim(): BugAnim {
  return {
    gait: 0, speed: 0, headYaw: 0, headPitch: 0, mandible: 0, flinch: 0, flinchX: 0, flinchZ: 0, hitFlash: 0,
    abdomen: 0, shake: 0, crouch: 0, death: -1, deathDir: 0, deathFall: 0, slopePitch: 0, slopeRoll: 0, time: 0,
    fade: 0, aim: 0, recoil: 0, writhe: 0, spark: 0, reload: 0, throwing: 0, flip: 0, brace: 0, climb: 0,
  };
}

const statusColor = new THREE.Color();
/**
 * Emissive for hit flash + incinerate glow + shock spark on a per-rig chitin material (shared by bugs and rogues).
 * With nothing glowing it clears the emissive itself, and only while it is not already black — callers never reset it.
 */
export function statusEmissive(mat: THREE.MeshStandardMaterial, a: BugAnim, flashR: number, flashG: number, flashB: number, flashMul: number): void {
  const glow = a.writhe * (0.32 + 0.18 * Math.abs(Math.sin(a.time * 17)));
  if (a.hitFlash > 0.001 || glow > 0.001 || a.spark > 0.001) {
    statusColor.setRGB(flashR, flashG, flashB).multiplyScalar(a.hitFlash * flashMul);
    if (glow > 0.001) { statusColor.r += 1.0 * glow; statusColor.g += 0.32 * glow; statusColor.b += 0.05 * glow; }
    if (a.spark > 0.001) { statusColor.r += 0.35 * a.spark; statusColor.g += 0.85 * a.spark; statusColor.b += 1.1 * a.spark; }
    mat.emissive.copy(statusColor);
  } else if (mat.emissive.r !== 0 || mat.emissive.g !== 0 || mat.emissive.b !== 0) {
    mat.emissive.setRGB(0, 0, 0);
  }
}

const LEG_SPREAD = [0.55, 0.0, -0.55];

/* ── leg instance matrices (see `LegRig`) — scratch objects, never allocated per frame ── */
const _legPos = new THREE.Vector3();
const _legEuler = new THREE.Euler(0, 0, 0, 'YZX');
const _legQuat = new THREE.Quaternion();
const _legScale = new THREE.Vector3(1, 1, 1);
const _femurM = new THREE.Matrix4();
const _kneeM = new THREE.Matrix4();
const _tibiaM = new THREE.Matrix4();

/**
 * One leg's two instance matrices — exactly the chain the group hierarchy used to hold:
 * `femur = T(hip) · Ry(hipYaw) · Rz(hipPitch)`, `tibia = femur · T(l1,0,0) · Rz(knee)`.
 * Euler order `YZX` composes as `Ry · Rz · Rx` and the x term is always 0 here, so the quaternion is the same
 * rotation the two nested groups produced. Matrices are in `rig.body` space, the instanced meshes' parent.
 */
function setLegMatrices(rig: BugRig, i: number, hipYaw: number, hipPitch: number, knee: number): void {
  const L = rig.params.legs;
  const leg = rig.legs[i];
  _legPos.set(leg.side * L.spreadX, L.hipY, L.zs[leg.index]);
  _legEuler.set(0, hipYaw, hipPitch);
  _legQuat.setFromEuler(_legEuler);
  _femurM.compose(_legPos, _legQuat, _legScale);
  _kneeM.makeRotationZ(knee);
  _kneeM.setPosition(L.l1, 0, 0);
  _tibiaM.multiplyMatrices(_femurM, _kneeM);
  rig.femurs.setMatrixAt(i, _femurM);
  rig.tibias.setMatrixAt(i, _tibiaM);
}

/** All six legs in one pose — the rest stance a freshly built rig stands in until `animateBug` runs. */
function writeLegMatrices(rig: BugRig, hipPitch: number, knee: number): void {
  for (let i = 0; i < 6; i++) setLegMatrices(rig, i, rig.legs[i].baseYaw, hipPitch, knee);
  rig.femurs.instanceMatrix.needsUpdate = true;
  rig.tibias.instanceMatrix.needsUpdate = true;
}

export function createBugRig(type: BugType): BugRig {
  const p = BUG_PARAMS[type];
  const a = getAssets(type);
  const chitin = a.chitin.clone();
  const eyeMat = a.eye.clone();
  const acidMat = a.acid ? a.acid.clone() : null;

  const root = new THREE.Group();
  root.name = `bug_${type}`;
  const body = new THREE.Group();
  root.add(body);

  const bodyMesh = new THREE.Mesh(a.body, chitin);
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = false;
  bodyMesh.layers.enable(Layers.ENEMY);
  body.add(bodyMesh);

  const head = new THREE.Group();
  head.position.set(0, p.head.y, p.head.z);
  const headMesh = new THREE.Mesh(a.head, chitin);
  headMesh.layers.enable(Layers.ENEMY);
  head.add(headMesh);
  const eyes = new THREE.Mesh(a.eyes, eyeMat);
  eyes.layers.enable(Layers.ENEMY);
  head.add(eyes);
  body.add(head);

  const r = p.head.r;
  const mandibleL = new THREE.Group();
  const mandibleR = new THREE.Group();
  for (const [grp, side] of [[mandibleL, 1], [mandibleR, -1]] as const) {
    grp.position.set(side * r * 0.5, -r * 0.35, r * 0.8);
    grp.rotation.y = -side * 0.55;
    const m = new THREE.Mesh(a.mandible, chitin);
    m.layers.enable(Layers.ENEMY);
    grp.add(m);
    head.add(grp);
  }

  let abdomen: THREE.Mesh | null = null;
  if (a.abdomen && acidMat) {
    abdomen = new THREE.Mesh(a.abdomen, acidMat);
    abdomen.position.set(0, p.abdomenY, p.abdomenZ);
    abdomen.layers.enable(Layers.ENEMY);
    body.add(abdomen);
  }

  // 2026-09-17: red stripes — shared geometry + shared material (disposeBugRig leaves them alone, disposeBugAssets releases them)
  if (a.stripes && a.stripeMat) {
    const stripeMesh = new THREE.Mesh(a.stripes, a.stripeMat);
    stripeMesh.castShadow = false;
    stripeMesh.layers.enable(Layers.ENEMY);
    body.add(stripeMesh);
  }

  let mortar: THREE.Group | null = null;
  if (a.mortar && p.mortar) {
    mortar = new THREE.Group();
    mortar.position.set(0, p.mortar.y, p.mortar.z);
    mortar.rotation.x = -p.mortar.elev;           // tube points up-forward
    const tube = new THREE.Mesh(a.mortar, chitin);
    tube.layers.enable(Layers.ENEMY);
    mortar.add(tube);
    body.add(mortar);
  }

  const legs: LegRig[] = [];
  const L = p.legs;
  const kneeHeight = L.hipY + L.l1 * Math.sin(L.femurUp);
  const tibiaDown = Math.asin(Math.min(0.98, kneeHeight / L.l2));
  const restKnee = -(L.femurUp + tibiaDown);
  for (let i = 0; i < 3; i++) {
    for (const side of [1, -1]) {
      // tripod gait: (L0, R1, L2) in phase, (R0, L1, R2) opposite
      const tripod = (i + (side > 0 ? 0 : 1)) % 2;
      legs.push({
        side, index: i,
        baseYaw: side > 0 ? -LEG_SPREAD[i] : Math.PI + LEG_SPREAD[i],
        restKnee, phase: tripod * Math.PI + i * 0.25,
      });
    }
  }
  const femurs = legInstances(a.femur, chitin, p);
  const tibias = legInstances(a.tibia, chitin, p);
  body.add(femurs, tibias);

  const rig: BugRig = { kind: 'bug', type, params: p, baseScale: 1, root, body, bodyMesh, head, mandibleL, mandibleR, abdomen, mortar, legs, femurs, tibias, chitin, eyeMat, acidMat };
  writeLegMatrices(rig, L.femurUp, restKnee);   // a rig drawn before its first `animateBug` still stands on its legs
  return rig;
}

/**
 * One leg segment for all 6 legs. The instance matrices are rewritten every frame, so the bounding sphere three
 * would compute once and cache is stale by construction — it gets a fixed one instead, centred on the hip band and
 * wide enough for any pose, so the legs are culled together with the body they belong to instead of never.
 */
function legInstances(geo: THREE.BufferGeometry, mat: THREE.Material, p: BugParams): THREE.InstancedMesh {
  const L = p.legs;
  const m = new THREE.InstancedMesh(geo, mat, 6);
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  m.castShadow = false;            // legs never cast — only `bodyMesh` does (one shadow per bug)
  m.receiveShadow = false;
  m.layers.enable(Layers.ENEMY);
  const reach = L.spreadX + L.l1 + L.l2 + Math.max(Math.abs(L.zs[0]), Math.abs(L.zs[1]), Math.abs(L.zs[2]));
  m.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, L.hipY, 0), reach);
  return m;
}

export function disposeBugRig(rig: BugRig): void {
  rig.femurs.dispose(); rig.tibias.dispose();   // the per-instance matrix buffers (geometry · material are shared)
  rig.chitin.dispose();
  rig.eyeMat.dispose();
  rig.acidMat?.dispose();
  rig.root.removeFromParent();
}

/* ────────────────────────────────────────────────────────────────────────────
 * Animation
 * ──────────────────────────────────────────────────────────────────────────── */
const smooth = (t: number) => t * t * (3 - 2 * t);

export function animateBug(rig: BugRig, a: BugAnim): void {
  const p = rig.params;
  const body = rig.body;
  const dying = a.death >= 0;
  const t = a.time;

  // ── body bob / lean / flinch ────────────────────────────────────────────
  const bob = Math.sin(a.gait * 2) * p.bobAmp * a.speed;
  const shake = a.shake > 0 ? (Math.sin(t * 55) * 0.03 + Math.sin(t * 37) * 0.02) * a.shake : 0;
  body.position.set(shake, bob - a.crouch * p.thoraxY * 0.3, 0);
  let pitch = a.slopePitch + a.speed * -0.06 + a.crouch * 0.18 + a.flinch * a.flinchZ * 0.35;
  let roll = a.slopeRoll + Math.sin(a.gait) * 0.02 * a.speed + a.flinch * a.flinchX * 0.4 + shake * 4;
  let yaw = 0;
  let sink = 0;
  let curl = 0;
  /*
   * 2026-09-17: artillery brace pose — the body drops far enough for the abdomen to touch the ground (the thorax centre comes to half the thorax thickness · minus what the crouch already lowered).
   * The legs splay sideways in the leg loop below. A drawing-only ratio, so it is not a csv number.
   */
  const br = dying ? 0 : a.brace;
  if (br > 0.001) {
    body.position.y -= br * Math.max(0, p.thoraxY - p.thorax[1] - a.crouch * p.thoraxY * 0.3);
  }
  // incinerate writhe: the whole body twists and bucks, thorax dropped toward the ground
  const wr = a.writhe;
  if (wr > 0.001 && !dying) {
    roll += Math.sin(t * 9.3) * 0.38 * wr;
    pitch += (Math.sin(t * 7.1 + 0.7) * 0.22 - 0.1) * wr;
    yaw += Math.sin(t * 5.4 + 2.1) * 0.3 * wr;
    body.position.x += Math.sin(t * 23) * 0.04 * wr;
    body.position.y -= p.thoraxY * 0.18 * wr;
  }
  if (dying) {
    // Phase 10: three real fall directions (`a.deathDir`) blended over DEATH_FALL_TIME instead of one canned roll.
    const fall = smooth(THREE.MathUtils.clamp(a.deathFall, 0, 1));
    const settle = Math.sin(a.deathFall * Math.PI) * (1 - a.deathFall);   // one small bounce as the body settles
    if (a.deathDir === 2) {
      // back: the bug rears over onto its abdomen — big pitch, legs up, almost no roll
      pitch += -fall * 1.25 - settle * 0.18;
      roll += Math.sin(t * 1.7) * 0.06 * fall;
      yaw += fall * 0.12;
      body.position.z -= fall * p.thorax[2] * 0.25;
    } else {
      const side = a.deathDir === 1 ? 1 : -1;   // 1 right, 0 left
      roll += side * (fall * 1.42 + settle * 0.12);
      pitch += fall * 0.22;
      yaw += fall * side * 0.42;
      body.position.x += side * fall * p.thorax[0] * 0.3;
    }
    curl = smooth(Math.min(1, a.deathFall / 1.55));
    // the corpse stays on the ground (lootable) and only sinks away during the final fade
    const sinkT = smooth(Math.min(1, Math.max(0, a.fade)));
    sink = sinkT * (p.thoraxY + p.thorax[1]) * 1.4;
    body.position.y -= sink - fall * p.thorax[1] * 0.2;
  }
  // 2026-09-21 (A-18 phase 2): on a wall — the body lies along the face, belly to it (positive pitch = nose down, so nose up is
  // negative). Not quite a right angle, so the back still reads from below. A drawing-only ratio, so it is not a csv number.
  if (!dying && a.climb !== 0) pitch -= a.climb * 1.4;
  // 2026-09-17: hunter flip — the whole body rolls half a turn about the front-back axis onto its back and is lifted so the back touches the ground.
  // Lying there it rocks slowly side to side (so it reads apart from a corpse). The rocking backs x out, so the contact point on the back stays put.
  const fl = a.flip > 0.001 ? smooth(Math.min(1, a.flip)) : 0;
  if (fl > 0) {
    const lift = p.thoraxY + p.thorax[1];
    const rock = dying ? 0 : Math.sin(t * 2.3) * 0.26 * fl;
    roll += Math.PI * fl + rock;
    body.position.y += lift * fl;
    body.position.x -= Math.sin(rock) * lift;
  }
  body.rotation.set(pitch, yaw, roll);

  // ── head tracking + mandibles ───────────────────────────────────────────
  rig.head.rotation.set(a.headPitch + (dying ? curl * 0.6 : 0) + Math.sin(t * 3.1) * 0.02 + Math.sin(t * 11) * 0.25 * wr, a.headYaw + Math.sin(t * 8.2) * 0.3 * wr, 0);
  const snap = Math.max(a.mandible, wr * Math.abs(Math.sin(t * 10.5)));
  rig.mandibleL.rotation.y = -0.55 + snap * 0.5 + (dying ? 0 : Math.sin(t * 6 + 1) * 0.05);
  rig.mandibleR.rotation.y = 0.55 - snap * 0.5 - (dying ? 0 : Math.sin(t * 6) * 0.05);

  // ── spewer abdomen pulse ────────────────────────────────────────────────
  if (rig.abdomen) {
    const swell = p.sacSwell ?? 0.18;
    const pulse = 1 + Math.sin(t * (2.2 + a.abdomen * 12)) * (0.03 + a.abdomen * 0.04) + a.abdomen * swell;
    rig.abdomen.scale.set(pulse, pulse * 0.97, pulse * 1.03);
    if (rig.acidMat) rig.acidMat.emissiveIntensity = 0.6 + a.abdomen * 1.6;
  }

  // ── artillery mortar: recoil along the tube + dig-in settle ─────────────
  if (rig.mortar && p.mortar) {
    const k = a.recoil * a.recoil;
    rig.mortar.position.set(0, p.mortar.y - k * 0.12, p.mortar.z - k * 0.22);
    rig.mortar.rotation.x = -p.mortar.elev - k * 0.25 + a.crouch * 0.12;
  }

  // ── legs: tripod gait ───────────────────────────────────────────────────
  const L = p.legs;
  const swingAmp = 0.42 * (0.35 + 0.65 * a.speed);
  const liftAmp = 0.55 * (0.3 + 0.7 * a.speed);
  const idleAmp = 0.03 * (1 - a.speed);
  for (let i = 0; i < 6; i++) {
    const leg = rig.legs[i];
    const ph = a.gait + leg.phase;
    const s = Math.sin(ph);
    const c = Math.cos(ph);
    const lift = Math.max(0, c) * liftAmp * (a.speed > 0.02 ? 1 : 0);
    const idle = Math.sin(t * 1.7 + i * 1.3) * idleAmp;
    let hipYaw = leg.baseYaw - leg.side * (s * swingAmp * (a.speed > 0.02 ? 1 : 0));
    let hipPitch = L.femurUp + lift * 0.6 + idle;
    let knee = leg.restKnee - lift * 0.55 - idle * 0.5;
    if (a.crouch > 0) { hipPitch += a.crouch * 0.35; knee -= a.crouch * 0.4; }
    if (br > 0.001) { hipPitch += br * 0.7; knee -= br * 0.6; }   // 2026-09-17: artillery brace pose — the femur lifts and splays sideways, the knee bends
    if (a.flinch > 0) { hipPitch += a.flinch * 0.15; }
    if (wr > 0.001) {
      // incinerate: legs kick and claw at the air out of phase with each other
      hipYaw += Math.sin(t * 9 + i * 1.7) * 0.35 * wr;
      hipPitch += (0.45 + Math.sin(t * 11.5 + i * 1.9) * 0.5) * wr;
      knee -= (0.35 + Math.cos(t * 13 + i * 1.3) * 0.45) * wr;
    }
    if (fl > 0 && !dying) {
      // flipped: the legs pointing at the sky flail slowly
      hipYaw += Math.sin(t * 3.1 + i * 1.4) * 0.25 * fl;
      hipPitch += (0.2 + Math.sin(t * 4.2 + i * 1.9) * 0.35) * fl;
      knee -= (0.3 + Math.cos(t * 3.7 + i * 1.1) * 0.35) * fl;
    }
    if (curl > 0) {
      hipYaw += leg.side * (leg.index - 1) * -0.4 * curl;
      hipPitch += curl * 1.0;
      knee -= curl * 1.5;
    }
    setLegMatrices(rig, i, hipYaw, hipPitch, knee);
  }
  rig.femurs.instanceMatrix.needsUpdate = true;
  rig.tibias.instanceMatrix.needsUpdate = true;

  // ── hit flash / incinerate glow / shock spark ───────────────────────────
  statusEmissive(rig.chitin, a, 1, 0.55, 0.3, 1.2);
  if (dying) {
    rig.eyeMat.emissiveIntensity = 2.4 * (1 - smooth(Math.min(1, a.death / 0.5)));
    if (a.fade > 0) rig.eyeMat.emissiveIntensity = 0;
  } else if (rig.eyeMat.emissiveIntensity !== 2.4) {
    rig.eyeMat.emissiveIntensity = 2.4;
  }
}
