/**
 * The look of Roden's scan drone (`rogue_scan_drone`) (2026-09-11). `import type` only from `RogueModel`.
 *
 * It decorates the humanoid rig: `rig.body` is hidden whole (pelvis · torso · head · gun · grenade · legs all sit under it)
 * and a small quadcopter is attached to `rig.root`. The dimensions match the hitbox — radius 0.45 · height 0.4 in
 * `data/enemies.csv` become a sphere centred 0.45 m above the feet + the head sphere (`ROGUE_RIG_PARAMS.head.y` 0.2) in
 * `EnemySystem.raycastEx`, so putting the body centre at `FRAME_Y` 0.42 means **what is seen is what is hit**.
 *
 * The hull · blades use `rig.chitin` (the vertex-coloured material cloned per rig) as it is, so the hit flash · burning glow come for free.
 * The red LEDs and the downward-facing scanner lens are **emissive** — no lights (the root CLAUDE.md light-count rule).
 * At hint 20 (emitting a pulse) the lens flashes and pulses. On death it spins as it falls (`ai/EnemyAI.integrateDeathFall`)
 * and comes to rest on its side as a wreck once it touches the ground.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Layers } from '@/shared';
import type { BugAnim } from '../BugModel';
import type { RogueRig } from '../RogueModel';
import type { Enemy } from '../../Enemy';

/** Body centre above the feet (= hit sphere centre). */
const FRAME_Y = 0.42;
/** Motor pods sit this far out on the diagonals (x = z = ±). */
const ARM = 0.24;
const ROTOR_Y = 0.065;
const ROTOR_SPIN = 55;         // rad/s
const TWO_PI = Math.PI * 2;

const C_ARMOR = 0x3a3e44;
const C_DARK = 0x22262a;
const C_METAL = 0x5a5e64;
const C_ACCENT = 0xb02a22;

interface DroneAssets {
  hull: THREE.BufferGeometry;
  blade: THREE.BufferGeometry;
  disc: THREE.BufferGeometry;
  lens: THREE.BufferGeometry;
  led: THREE.BufferGeometry;
  discMat: THREE.MeshBasicMaterial;
}

interface DroneParts {
  kind: 'scanDrone';
  frame: THREE.Group;
  rotors: THREE.Group[];
  lensMat: THREE.MeshStandardMaterial;
  ledMat: THREE.MeshStandardMaterial;
  spin: number;
  spinRate: number;
  pitch: number;
  roll: number;
  tumbleX: number;
  tumbleZ: number;
  flash: number;
}

/* ── shared geometry (reference counted: the pool disposes rigs one by one) ── */
let assets: DroneAssets | null = null;
let assetRefs = 0;
const tmpColor = new THREE.Color();

function colorize(geo: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  tmpColor.setHex(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = tmpColor.r; arr[i * 3 + 1] = tmpColor.g; arr[i * 3 + 2] = tmpColor.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}
function box(w: number, h: number, d: number, x: number, y: number, z: number, hex: number, rotY = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rotY !== 0) g.rotateY(rotY);
  g.translate(x, y, z);
  return colorize(g, hex);
}
function cyl(r: number, h: number, x: number, y: number, z: number, hex: number, seg = 10): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, h, seg, 1);
  g.translate(x, y, z);
  return colorize(g, hex);
}
/** Strip to the attributes every part shares (position / normal / color) so `mergeGeometries` accepts the mix. */
function strip(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  if (ng !== g) g.dispose();
  for (const name of Object.keys(ng.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'color') ng.deleteAttribute(name);
  return ng;
}
function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const list = parts.map(strip);
  const m = mergeGeometries(list, false);
  for (const p of list) p.dispose();
  if (!m) throw new Error('[enemies] scan drone mergeGeometries failed');
  m.computeBoundingSphere();
  return m;
}

function buildAssets(): DroneAssets {
  const hullParts: THREE.BufferGeometry[] = [
    box(0.3, 0.1, 0.34, 0, 0, 0, C_ARMOR),                  // hub
    box(0.22, 0.03, 0.26, 0, 0.065, 0, C_METAL),            // top plate
    box(0.09, 0.05, 0.06, 0, 0.01, 0.19, C_ACCENT),         // front sensor bump
    box(0.03, 0.12, 0.03, -0.08, 0.1, -0.12, C_DARK),       // antenna
    cyl(0.1, 0.06, 0, -0.07, 0, C_DARK, 12),                // scanner housing
  ];
  // four arms on the diagonals + motor pods
  for (let i = 0; i < 4; i++) {
    const sx = i === 0 || i === 3 ? 1 : -1;
    const sz = i < 2 ? 1 : -1;
    const ang = Math.atan2(sx, sz);
    hullParts.push(box(0.04, 0.03, 0.36, sx * ARM * 0.5, 0.01, sz * ARM * 0.5, C_DARK, ang));
    hullParts.push(cyl(0.045, 0.07, sx * ARM, 0.02, sz * ARM, C_METAL));
  }
  const dishGeo = new THREE.SphereGeometry(0.11, 14, 6, 0, TWO_PI, Math.PI / 2, Math.PI / 2);   // lower hemisphere
  dishGeo.translate(0, -0.09, 0);
  hullParts.push(colorize(dishGeo, C_METAL));
  const hull = merge(hullParts);

  const blade = merge([
    box(0.3, 0.008, 0.035, 0, 0, 0, C_DARK),
    box(0.035, 0.008, 0.3, 0, 0, 0, C_DARK),
  ]);
  const disc = new THREE.CircleGeometry(0.15, 18);
  disc.rotateX(-Math.PI / 2);
  const lens = new THREE.SphereGeometry(0.05, 12, 8);
  lens.translate(0, -0.17, 0);
  const led = new THREE.BoxGeometry(0.035, 0.025, 0.035);
  return {
    hull, blade, disc, lens, led,
    discMat: new THREE.MeshBasicMaterial({ color: 0x8a8e94, transparent: true, opacity: 0.14, depthWrite: false, side: THREE.DoubleSide }),
  };
}

function acquireAssets(): DroneAssets {
  if (!assets) assets = buildAssets();
  assetRefs++;
  return assets;
}

function releaseAssets(): void {
  assetRefs = Math.max(0, assetRefs - 1);
  if (assetRefs > 0 || !assets) return;
  assets.hull.dispose(); assets.blade.dispose(); assets.disc.dispose(); assets.lens.dispose(); assets.led.dispose();
  assets.discMat.dispose();
  assets = null;
}

function partsOf(rig: RogueRig): DroneParts | null {
  const p = rig.named as DroneParts | undefined;
  return p && p.kind === 'scanDrone' ? p : null;
}

function enemyMesh(g: THREE.BufferGeometry, m: THREE.Material, shadow: boolean): THREE.Mesh {
  const x = new THREE.Mesh(g, m);
  x.castShadow = shadow;
  x.layers.enable(Layers.ENEMY);
  return x;
}

export function decorateScanDroneLook(rig: RogueRig): void {
  // the humanoid (pelvis → torso → head / rifle / grenade, legs) lives entirely under `body`
  rig.body.visible = false;
  const a = acquireAssets();
  const frame = new THREE.Group();
  frame.name = 'scanDrone';
  frame.position.y = FRAME_Y;
  frame.add(enemyMesh(a.hull, rig.chitin, true));

  const lensMat = new THREE.MeshStandardMaterial({ color: 0x140404, emissive: 0xff2a1a, emissiveIntensity: 1.2, roughness: 0.25, metalness: 0.2 });
  const ledMat = new THREE.MeshStandardMaterial({ color: 0x140404, emissive: 0xff2020, emissiveIntensity: 2.2, roughness: 0.4 });
  frame.add(enemyMesh(a.lens, lensMat, false));

  const rotors: THREE.Group[] = [];
  for (let i = 0; i < 4; i++) {
    const sx = i === 0 || i === 3 ? 1 : -1;
    const sz = i < 2 ? 1 : -1;
    const rotor = new THREE.Group();
    rotor.position.set(sx * ARM, ROTOR_Y, sz * ARM);
    rotor.add(enemyMesh(a.blade, rig.chitin, false));
    const disc = new THREE.Mesh(a.disc, a.discMat);
    disc.layers.enable(Layers.NO_RAYCAST);
    rotor.add(disc);
    frame.add(rotor);
    rotors.push(rotor);
    const led = enemyMesh(a.led, ledMat, false);
    led.position.set(sx * ARM, -0.03, sz * ARM);
    frame.add(led);
  }
  rig.root.add(frame);
  const parts: DroneParts = {
    kind: 'scanDrone', frame, rotors, lensMat, ledMat,
    spin: Math.random() * TWO_PI, spinRate: ROTOR_SPIN, pitch: 0, roll: 0, tumbleX: 0, tumbleZ: 0, flash: 0,
  };
  rig.named = parts;
}

export function animateScanDroneLook(rig: RogueRig, a: BugAnim, e: Enemy, dt: number): void {
  const p = partsOf(rig);
  if (!p) return;
  const dead = a.death >= 0;
  const t = a.time;
  const k = Math.min(1, dt * 5);

  // rotors: full spin alive, winding down once shot out of the sky
  p.spinRate = dead ? Math.max(0, p.spinRate - dt * 35) : ROTOR_SPIN;
  p.spin = (p.spin + p.spinRate * dt) % TWO_PI;
  for (let i = 0; i < p.rotors.length; i++) p.rotors[i].rotation.y = i % 2 === 0 ? p.spin : -p.spin;

  if (!dead) {
    // lean into the flight direction (local frame), a little hover bob and a shiver on hits
    if (p.tumbleX !== 0 || p.tumbleZ !== 0) { p.tumbleX = 0; p.tumbleZ = 0; }
    const s = Math.sin(e.yaw), c = Math.cos(e.yaw);
    const fwd = e.velocity.x * s + e.velocity.z * c;
    const side = e.velocity.x * c - e.velocity.z * s;
    p.pitch += (THREE.MathUtils.clamp(fwd * 0.035, -0.38, 0.38) - p.pitch) * k;
    p.roll += (THREE.MathUtils.clamp(-side * 0.035, -0.38, 0.38) - p.roll) * k;
    const shiver = a.flinch * 0.25;
    p.frame.position.y = FRAME_Y + Math.sin(t * 2.3 + e.id) * 0.04;
    p.frame.rotation.set(p.pitch + shiver * a.flinchZ + Math.sin(t * 31) * shiver * 0.3, 0, p.roll + shiver * a.flinchX);

    // scanner lens: steady glow, bright strobing flash while emitting a pulse (hint 20)
    p.flash = e.namedHint === 20 ? 1 : Math.max(0, p.flash - dt * 2.5);
    p.lensMat.emissiveIntensity = 1.2 + 7 * p.flash * (0.65 + 0.35 * Math.sin(t * 34));
    // red LEDs blink
    p.ledMat.emissiveIntensity = Math.sin(t * 6 + e.id) > 0.2 ? 2.4 : 0.5;
  } else {
    // falling: tumble; landed: settle onto its side as a wreck and sink with the corpse fade
    if (!e.deathLanded) {
      p.tumbleX += dt * 4.2;
      p.tumbleZ += dt * 2.9;
    } else {
      const restX = Math.round(p.tumbleX / Math.PI) * Math.PI + 0.25;
      const restZ = Math.round(p.tumbleZ / Math.PI) * Math.PI + 0.35;
      p.tumbleX += (restX - p.tumbleX) * Math.min(1, dt * 6);
      p.tumbleZ += (restZ - p.tumbleZ) * Math.min(1, dt * 6);
    }
    p.frame.position.y = FRAME_Y * 0.45 - a.fade * 0.5;
    p.frame.rotation.set(p.pitch + p.tumbleX, 0, p.roll + p.tumbleZ);
    p.flash = 0;
    if (p.lensMat.emissiveIntensity !== 0) p.lensMat.emissiveIntensity = 0;
    if (p.ledMat.emissiveIntensity !== 0) p.ledMat.emissiveIntensity = 0;
  }
}

export function disposeScanDroneLook(rig: RogueRig): void {
  const p = partsOf(rig);
  if (!p) return;
  p.frame.removeFromParent();
  p.lensMat.dispose();
  p.ledMat.dispose();
  rig.named = undefined;
  releaseAssets();
}
