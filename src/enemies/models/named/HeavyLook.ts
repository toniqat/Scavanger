/**
 * src/enemies/models/named/HeavyLook.ts — **the look of Heavy** (`rogue_heavy`) (2026-09-11).
 *
 * Added on top of the humanoid rogue rig: thick body armour (breastplate · both pauldrons · waist · thigh/shin plates) ·
 * a helmet + a yellow visor (`rig.eyeMat` — it goes out with the base rig on death) · an ammo-can backpack and belt · and a **six-barrel minigun at hip height**.
 *
 * - The base rifle mesh (one lump merged with the arms inside `rig.gun`) is only **hidden** — the group itself keeps
 *   moving with `animateRogue`, there is simply nothing visible. The minigun and the arms holding it go on a pivot between the two shoulders (`pivot`, a child of the torso).
 * - `rig.muzzle` is **moved onto** the minigun's muzzle → `Enemy.muzzle()` · `ai/FireLine` · `fireGun` all fire from there.
 * - The barrel cluster spins at `Enemy.namedHint` 18 (spin) · 19 (firing) with a damped speed, and at 19 the whole gun
 *   shakes and the barrel tips heat up. The host AI and the replica fill the same fields, so both draw the same picture.
 * - The walk is heavy: a shorter stride, the pelvis settling on every footfall, and a sway from side to side.
 *
 * The materials are the rig's `chitin` (vertex colours · the shared hit flash) and `eyeMat`; the only thing this file makes is the one muzzle-heat material.
 * Geometry is built per rig and released by `disposeHeavyLook` (at most one Heavy per raid, so a shared cache is not needed).
 * No lights. ⚠ `RogueModel` is `import type` only (circular import).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Layers } from '@/shared';
import type { BugAnim } from '../BugModel';
import type { RogueRig } from '../RogueModel';
import type { Enemy } from '../../Enemy';

/* Wire hints (`EnemyWire.a`) — the same values as ai/named/Heavy.ts (written out here to avoid a circular import) */
const HINT_SPIN = 18;
const HINT_FIRE = 19;

const COL = {
  armor: 0x33372e, plate: 0x40453a, cloth: 0x202420, accent: 0xd0a020, metal: 0x4e524c,
  dark: 0x18191a, gun: 0x34373a, brass: 0xb4903c, strap: 0x2b2a22,
} as const;

/* ── drawing constants ── */
/** Top barrel spin rate (rad/s). */
const BARREL_MAX_RAD_S = 38;
/** Rate of approach to the spin target (1/s) — spinning up / spinning down. */
const SPIN_UP_RATE = 2.4;
const SPIN_DOWN_RATE = 1.3;
/** Minigun pivot (torso space, between the two shoulders = the same height as the base rifle group). */
const PIVOT_Y = 0.5;
const PIVOT_Z = 0.06;
/** Gun axis (pivot space). 0.44 m below the pivot = about 1.1 m above the feet, hip height. */
const GUN_X = 0.1;
const GUN_Y = -0.44;
const BARREL_Z0 = 0.46;
const BARREL_LEN = 0.86;
const BARREL_RING = 0.056;
const TWO_PI = Math.PI * 2;

interface HeavyParts {
  kind: 'heavy';
  /** minigun + the arms holding it; pivot between the shoulders (child of `rig.torso`) */
  pivot: THREE.Group;
  /** the six-barrel cluster, spins about its local Z */
  barrels: THREE.Group;
  /** muzzle-end heat glow (emissive only, no light) */
  heatMat: THREE.MeshStandardMaterial;
  geos: THREE.BufferGeometry[];
  /** 0..1 barrel speed */
  spin: number;
  angle: number;
  /** 0..1 muzzle heat */
  heat: number;
  /** 0..1 firing blend (shake) */
  fire: number;
}

/* ── build-time helpers (allocate only while decorating) ── */
const _c = new THREE.Color();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

function colorize(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  _c.setHex(hex);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = _c.r; arr[i * 3 + 1] = _c.g; arr[i * 3 + 2] = _c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}
function box(w: number, h: number, d: number, x: number, y: number, z: number, hex: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return colorize(g, hex);
}
/** Cylinder from a to b. */
function limb(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, hex: number): THREE.BufferGeometry {
  _a.set(ax, ay, az); _b.set(bx, by, bz);
  const len = _a.distanceTo(_b);
  const g = new THREE.CylinderGeometry(r * 0.9, r, len, 8, 1);
  g.translate(0, len / 2, 0);
  _d.subVectors(_b, _a).normalize();
  _q.setFromUnitVectors(UP, _d);
  g.applyQuaternion(_q);
  g.translate(ax, ay, az);
  return colorize(g, hex);
}
/** Cylinder along Z from z0 to z1 at (x, y). */
function cylZ(r: number, z0: number, z1: number, x: number, y: number, hex: number, seg = 8): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, z1 - z0, seg, 1);
  g.rotateX(Math.PI / 2);
  g.translate(x, y, (z0 + z1) / 2);
  return colorize(g, hex);
}
/** Cylinder along X from x0 to x1 at (y, z). */
function cylX(r: number, x0: number, x1: number, y: number, z: number, hex: number, seg = 12): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, x1 - x0, seg, 1);
  g.rotateZ(Math.PI / 2);
  g.translate((x0 + x1) / 2, y, z);
  return colorize(g, hex);
}
function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const m = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!m) throw new Error('[enemies] heavy mergeGeometries failed');
  m.computeBoundingSphere();
  return m;
}
function attach(parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.layers.enable(Layers.ENEMY);
  parent.add(m);
  return m;
}

/* ── part geometry ── */

function torsoArmorGeo(): THREE.BufferGeometry {
  const C = COL;
  return merge([
    box(0.52, 0.42, 0.1, 0, 0.36, 0.19, C.plate),            // breastplate
    box(0.44, 0.035, 0.012, 0, 0.47, 0.245, C.accent),       // warning stripes
    box(0.44, 0.035, 0.012, 0, 0.27, 0.245, C.accent),
    box(0.44, 0.12, 0.08, 0, 0.1, 0.17, C.armor),            // abdomen plate
    box(0.46, 0.1, 0.36, 0, 0.6, 0, C.armor),                // neck collar
    box(0.08, 0.36, 0.26, 0.27, 0.3, 0, C.armor),            // flank plate
    box(0.08, 0.36, 0.26, -0.27, 0.3, 0, C.armor),
    box(0.26, 0.16, 0.32, 0.34, 0.58, 0, C.metal),           // pauldron
    box(0.27, 0.04, 0.33, 0.34, 0.67, 0, C.accent),
    box(0.26, 0.16, 0.32, -0.34, 0.58, 0, C.metal),
    box(0.27, 0.04, 0.33, -0.34, 0.67, 0, C.accent),
    // ammo-can backpack
    box(0.48, 0.52, 0.24, 0, 0.32, -0.3, C.armor),
    box(0.5, 0.06, 0.28, 0, 0.6, -0.3, C.metal),
    cylX(0.17, -0.22, 0.22, 0.16, -0.38, C.metal),
    cylX(0.175, -0.24, -0.2, 0.16, -0.38, C.accent),
    cylX(0.175, 0.2, 0.24, 0.16, -0.38, C.accent),
    box(0.06, 0.5, 0.05, 0.18, 0.34, -0.16, C.strap),        // shoulder straps
    box(0.06, 0.5, 0.05, -0.18, 0.34, -0.16, C.strap),
  ]);
}

function helmetGeo(): THREE.BufferGeometry {
  const C = COL;
  const shell = new THREE.SphereGeometry(0.165, 12, 9);
  shell.scale(1.05, 0.95, 1.08);
  shell.translate(0, 0.02, 0);
  return merge([
    colorize(shell, C.armor),
    box(0.36, 0.05, 0.36, 0, 0.1, -0.01, C.plate),           // brim
    box(0.24, 0.12, 0.08, 0, -0.08, 0.14, C.plate),          // chin guard
    box(0.06, 0.16, 0.16, 0.17, -0.01, 0.01, C.metal),       // ear plate
    box(0.06, 0.16, 0.16, -0.17, -0.01, 0.01, C.metal),
    box(0.05, 0.03, 0.3, 0, 0.19, -0.02, C.accent),          // crest
  ]);
}

function pelvisArmorGeo(): THREE.BufferGeometry {
  const C = COL;
  return merge([
    box(0.44, 0.09, 0.32, 0, 0.08, 0, C.strap),              // ammo belt
    box(0.12, 0.12, 0.1, 0.16, 0, 0.16, C.armor),            // pouch
    box(0.12, 0.12, 0.1, -0.16, 0, 0.16, C.armor),
    box(0.1, 0.12, 0.12, -0.24, -0.02, 0, C.armor),
    box(0.16, 0.2, 0.05, 0.1, -0.13, 0.16, C.plate),         // waist plate
    box(0.16, 0.2, 0.05, -0.1, -0.13, 0.16, C.plate),
  ]);
}

function thighArmorGeo(): THREE.BufferGeometry {
  return merge([box(0.18, 0.24, 0.08, 0, -0.2, 0.09, COL.plate)]);
}

function shinArmorGeo(): THREE.BufferGeometry {
  const C = COL;
  return merge([
    box(0.15, 0.13, 0.08, 0, -0.02, 0.1, C.metal),           // knee
    box(0.14, 0.26, 0.06, 0, -0.24, 0.08, C.plate),          // shin
    box(0.16, 0.1, 0.3, 0, -0.46, 0.05, C.dark),             // heavy boot
  ]);
}

/** Minigun body + the arms holding it + ammo belt, in pivot space (+Z = forward). */
function gunGeo(): THREE.BufferGeometry {
  const C = COL;
  const parts: THREE.BufferGeometry[] = [
    // right arm → rear grip
    limb(0.23, 0, 0, 0.3, -0.26, -0.06, 0.062, C.cloth),
    limb(0.3, -0.26, -0.06, 0.2, -0.52, 0.02, 0.055, C.armor),
    box(0.09, 0.09, 0.09, 0.3, -0.26, -0.06, C.metal),
    box(0.08, 0.08, 0.09, 0.2, -0.54, 0.02, C.dark),
    // left arm → front grip
    limb(-0.23, 0, 0, -0.22, -0.28, 0.16, 0.062, C.cloth),
    limb(-0.22, -0.28, 0.16, 0.04, -0.5, 0.4, 0.055, C.armor),
    box(0.09, 0.09, 0.09, -0.22, -0.28, 0.16, C.metal),
    box(0.08, 0.08, 0.09, 0.05, -0.52, 0.42, C.dark),
    // body
    cylZ(0.085, -0.16, 0, GUN_X, GUN_Y, C.dark, 10),                         // motor
    box(0.2, 0.22, 0.46, GUN_X, GUN_Y, 0.22, C.gun),                         // receiver
    box(0.12, 0.03, 0.4, GUN_X, GUN_Y + 0.125, 0.22, C.metal),               // top rail
    box(0.035, 0.035, 0.3, GUN_X, GUN_Y + 0.22, 0.22, C.metal),              // carry handle
    box(0.03, 0.09, 0.03, GUN_X, GUN_Y + 0.17, 0.1, C.metal),
    box(0.03, 0.09, 0.03, GUN_X, GUN_Y + 0.17, 0.34, C.metal),
    box(0.05, 0.16, 0.05, 0.2, -0.52, 0.02, C.dark),                         // rear grip
    box(0.1, 0.04, 0.04, 0.15, -0.46, 0.02, C.metal),
    box(0.05, 0.14, 0.05, 0.05, -0.56, 0.42, C.dark),                        // front grip
    box(0.13, 0.17, 0.22, -0.04, GUN_Y - 0.04, 0.2, C.armor),                // feed box
    box(0.135, 0.03, 0.225, -0.04, GUN_Y + 0.02, 0.2, C.accent),
    box(0.06, 0.08, 0.1, 0.23, GUN_Y - 0.02, 0.14, C.metal),                 // feed port
    cylZ(0.1, BARREL_Z0 - 0.02, BARREL_Z0 + 0.04, GUN_X, GUN_Y, C.metal, 12), // front bearing
  ];
  // ammo belt: from the right of the backpack, around the right hip, into the feed port (a chain of short cylinders along a quadratic Bézier)
  const p0x = 0.22, p0y = -0.34, p0z = -0.38;
  const cx = 0.4, cy = -0.66, cz = -0.14;
  const p2x = 0.24, p2y = -0.47, p2z = 0.12;
  const LINKS = 9;
  let px = p0x, py = p0y, pz = p0z;
  for (let i = 1; i <= LINKS; i++) {
    const u = i / LINKS, v = 1 - u;
    const qx = v * v * p0x + 2 * v * u * cx + u * u * p2x;
    const qy = v * v * p0y + 2 * v * u * cy + u * u * p2y;
    const qz = v * v * p0z + 2 * v * u * cz + u * u * p2z;
    parts.push(limb(px, py, pz, qx, qy, qz, 0.03, i % 2 === 0 ? C.brass : C.strap));
    px = qx; py = qy; pz = qz;
  }
  return merge(parts);
}

/** Six barrels + spindle + clamps, in barrel-group space (axis = +Z from 0). */
function barrelsGeo(): THREE.BufferGeometry {
  const C = COL;
  const parts: THREE.BufferGeometry[] = [
    cylZ(0.024, 0, BARREL_LEN, 0, 0, C.dark, 8),
    cylZ(0.085, 0.3, 0.34, 0, 0, C.metal, 12),
    cylZ(0.082, BARREL_LEN - 0.14, BARREL_LEN - 0.1, 0, 0, C.metal, 12),
    box(0.03, 0.014, 0.05, 0, 0.088, 0.32, C.accent),        // a mark that makes the spin readable
    box(0.03, 0.014, 0.05, 0, 0.085, BARREL_LEN - 0.12, C.accent),
  ];
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * TWO_PI;
    parts.push(cylZ(0.019, 0, BARREL_LEN - 0.06, Math.cos(ang) * BARREL_RING, Math.sin(ang) * BARREL_RING, C.gun, 6));
  }
  return merge(parts);
}

/** The last 6 cm of each barrel — drawn with the heat material. */
function barrelTipsGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * TWO_PI;
    parts.push(cylZ(0.021, BARREL_LEN - 0.06, BARREL_LEN, Math.cos(ang) * BARREL_RING, Math.sin(ang) * BARREL_RING, 0xffffff, 6));
  }
  return merge(parts);
}

/* ── RogueModel hooks ── */

export function decorateHeavyLook(rig: RogueRig): void {
  const mat = rig.chitin;
  const geos: THREE.BufferGeometry[] = [];
  const own = (g: THREE.BufferGeometry): THREE.BufferGeometry => { geos.push(g); return g; };

  // bulk: only the chest · pelvis meshes are widened (the head · leg groups stay as they are, so nothing drifts from the hitbox parameters)
  const chest = rig.torso.children[0];
  if (chest && (chest as THREE.Mesh).isMesh) chest.scale.set(1.14, 1.04, 1.18);
  const pelvis = rig.body.children[0];
  if (pelvis && (pelvis as THREE.Mesh).isMesh) pelvis.scale.set(1.16, 1, 1.16);

  // hide the base rifle + arms (one merged mesh) — animateRogue keeps moving the group, there is just nothing visible
  for (const c of rig.gun.children) if ((c as THREE.Mesh).isMesh) c.visible = false;

  attach(rig.torso, own(torsoArmorGeo()), mat);
  attach(rig.head, own(helmetGeo()), mat);
  attach(rig.head, own(box(0.26, 0.075, 0.035, 0, 0.02, 0.18, COL.accent)), rig.eyeMat);   // yellow visor (eyeMat = the palette's visor)
  attach(rig.body, own(pelvisArmorGeo()), mat);
  const thigh = own(thighArmorGeo());
  const shin = own(shinArmorGeo());
  for (const leg of rig.legs) {
    attach(leg.hip, thigh, mat);
    attach(leg.knee, shin, mat);
  }

  // minigun
  const pivot = new THREE.Group();
  pivot.name = 'heavy_minigun';
  pivot.position.set(0, PIVOT_Y, PIVOT_Z);
  rig.torso.add(pivot);
  attach(pivot, own(gunGeo()), mat);

  const barrels = new THREE.Group();
  barrels.name = 'heavy_barrels';
  barrels.position.set(GUN_X, GUN_Y, BARREL_Z0);
  pivot.add(barrels);
  attach(barrels, own(barrelsGeo()), mat);
  const heatMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, emissive: 0xff6a1a, emissiveIntensity: 0, roughness: 0.45, metalness: 0.6 });
  attach(barrels, own(barrelTipsGeo()), heatMat);

  // the muzzle marker moves to the minigun's tip — Enemy.muzzle() / FireLine / fireGun fire from here
  rig.muzzle.removeFromParent();
  rig.muzzle.position.set(GUN_X, GUN_Y, BARREL_Z0 + BARREL_LEN + 0.04);
  pivot.add(rig.muzzle);

  const parts: HeavyParts = { kind: 'heavy', pivot, barrels, heatMat, geos, spin: 0, angle: 0, heat: 0, fire: 0 };
  rig.named = parts;
}

export function animateHeavyLook(rig: RogueRig, a: BugAnim, e: Enemy, dt: number): void {
  const p = rig.named as HeavyParts | undefined;
  if (!p || p.kind !== 'heavy') return;
  const t = a.time;
  const dying = a.death >= 0;
  const hint = dying ? 0 : e.namedHint;
  const spinning = hint === HINT_SPIN || hint === HINT_FIRE;
  const firing = hint === HINT_FIRE;

  // barrels: damped speed → integrated angle
  p.spin += ((spinning ? 1 : 0) - p.spin) * Math.min(1, dt * (spinning ? SPIN_UP_RATE : SPIN_DOWN_RATE));
  if (!spinning && p.spin < 0.002) p.spin = 0;
  p.angle += p.spin * p.spin * BARREL_MAX_RAD_S * dt;
  if (p.angle > TWO_PI) p.angle -= TWO_PI * Math.floor(p.angle / TWO_PI);
  p.barrels.rotation.z = p.angle;
  p.fire += ((firing ? 1 : 0) - p.fire) * Math.min(1, dt * (firing ? 10 : 5));
  p.heat += ((firing ? 1 : 0) - p.heat) * Math.min(1, dt * (firing ? 0.7 : 0.3));
  const hi = p.heat * 2.4;
  if (Math.abs(p.heatMat.emissiveIntensity - hi) > 0.002) p.heatMat.emissiveIntensity = hi;

  // the heavy walk (added on top of the pose animateRogue set): 70 % stride, a wide stance, settling on each footfall, swaying side to side
  if (!dying) {
    const mv = a.speed > 0.03 ? a.speed * (1 - a.writhe) : 0;
    for (const leg of rig.legs) {
      const ph = a.gait + (leg.side > 0 ? 0 : Math.PI);
      leg.hip.rotation.x += Math.sin(ph) * 0.65 * mv * 0.3;
      leg.hip.rotation.z += leg.side * 0.05;
    }
    rig.body.position.y -= Math.max(0, -Math.cos(a.gait * 2)) * 0.035 * mv;
    rig.body.rotation.z += Math.sin(a.gait) * 0.07 * mv;
    rig.torso.rotation.z -= Math.sin(a.gait) * 0.05 * mv;
    // a forward lean to carry the gun's weight + leaning into the recoil while firing
    rig.torso.rotation.x += 0.06 + p.fire * 0.05;
    rig.torso.rotation.y += p.fire * Math.sin(t * 37) * 0.012;
  }

  // minigun pose: hip fire held low ↔ aiming (head pitch), recoil, the shake while firing
  const aim = dying ? 0 : a.aim;
  const pitch = THREE.MathUtils.clamp(a.headPitch, -0.4, 0.4);
  const r2 = a.recoil * a.recoil;
  const jit = p.fire * (Math.sin(t * 73) * 0.014 + Math.sin(t * 51 + 1.7) * 0.009);
  const sway = (1 - aim) * Math.sin(t * 1.1) * 0.02 + a.writhe * (Math.sin(t * 9.6) * 0.4 - 0.2);
  p.pivot.rotation.set(
    THREE.MathUtils.lerp(0.26, pitch * 0.85 - 0.02, aim) - r2 * 0.035 + jit + sway + (dying ? 0.45 : 0),
    THREE.MathUtils.lerp(0.08, a.headYaw * 0.4, aim) + p.fire * Math.sin(t * 43) * 0.008,
    p.fire * Math.sin(t * 61 + 0.5) * 0.01,
  );
  p.pivot.position.set(p.fire * Math.sin(t * 67) * 0.006, PIVOT_Y + jit * 0.4, PIVOT_Z - r2 * 0.03);
}

export function disposeHeavyLook(rig: RogueRig): void {
  const p = rig.named as HeavyParts | undefined;
  if (!p || p.kind !== 'heavy') return;
  for (const g of p.geos) g.dispose();
  p.heatMat.dispose();
  p.pivot.removeFromParent();
  rig.named = undefined;
}
