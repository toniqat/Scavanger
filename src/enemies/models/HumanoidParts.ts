/**
 * src/enemies/models/HumanoidParts.ts — the humanoid rig's **part helpers and asset shapes** (2026-09-13).
 *
 * `RogueModel` (the base for rogue · boss · named) and `FactionLooks` (the android · raider looks) build their parts with
 * the same helpers. All of it is called once at build time (cached per type), so the allocations here are not a hot path.
 * The file holds neither state nor values, so the two files look only at this one and never import each other (no circular import).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** The rig groups a glowing part attaches to — the head's glow is `visor`, separately. */
export type GlowPart = 'pelvis' | 'chest' | 'gunArms' | 'thigh' | 'shin';

/** One type's shared assets (a rig instance clones only the two materials). */
export interface HumanoidAssets {
  pelvis: THREE.BufferGeometry;
  chest: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  /** The head's glowing part (`eyeMat`) */
  visor: THREE.BufferGeometry;
  gunArms: THREE.BufferGeometry;
  thigh: THREE.BufferGeometry;
  shin: THREE.BufferGeometry;
  grenade: THREE.BufferGeometry;
  /** The other glowing parts — joint rings, an antenna tip and so on. Drawn with `eyeMat`, they go out with the visor on death. */
  glow: Partial<Record<GlowPart, THREE.BufferGeometry>>;
  chitin: THREE.MeshStandardMaterial;
  eye: THREE.MeshStandardMaterial;
  grenadeMat: THREE.MeshStandardMaterial;
  /** `eyeMat.emissiveIntensity` while alive */
  eyeGlow: number;
}

export const HIP_Y = 0.95;
export const THIGH = 0.45;
export const SHIN = 0.5;

const tmpColor = new THREE.Color();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();

export function colorize(geo: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  tmpColor.setHex(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = tmpColor.r; arr[i * 3 + 1] = tmpColor.g; arr[i * 3 + 2] = tmpColor.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

export function box(w: number, h: number, d: number, x: number, y: number, z: number, hex: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return colorize(g, hex);
}

/** Cylinder from `a` to `b` (`taper` = top radius / bottom radius). */
export function limb(
  ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, hex: number, taper = 0.85, seg = 7,
): THREE.BufferGeometry {
  _a.set(ax, ay, az); _b.set(bx, by, bz);
  const len = _a.distanceTo(_b);
  const g = new THREE.CylinderGeometry(r * taper, r, len, seg, 1);
  g.translate(0, len / 2, 0);
  _dir.copy(_b).sub(_a).normalize();
  _q.setFromUnitVectors(_up, _dir);
  g.applyQuaternion(_q);
  g.translate(ax, ay, az);
  return colorize(g, hex);
}

/** Low-poly (optionally squashed) sphere. */
export function ball(r: number, x: number, y: number, z: number, hex: number, sx = 1, sy = 1, sz = 1): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(r, 10, 8);
  g.scale(sx, sy, sz);
  g.translate(x, y, z);
  return colorize(g, hex);
}

/** Flat cylinder (a disc) whose face points along `axis`. */
export function disc(r: number, depth: number, x: number, y: number, z: number, hex: number, axis: 'x' | 'y' | 'z' = 'z'): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, depth, 12, 1);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  else if (axis === 'x') g.rotateZ(Math.PI / 2);
  g.translate(x, y, z);
  return colorize(g, hex);
}

/** Thin torus whose hole looks along `axis` (a joint ring around a limb that bends about that axis). */
export function ring(r: number, tube: number, x: number, y: number, z: number, axis: 'x' | 'y' | 'z', hex: number): THREE.BufferGeometry {
  const g = new THREE.TorusGeometry(r, tube, 5, 16);
  if (axis === 'x') g.rotateY(Math.PI / 2);
  else if (axis === 'y') g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  return colorize(g, hex);
}

export function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const m = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!m) throw new Error('[enemies] humanoid mergeGeometries failed');
  m.computeBoundingSphere();
  return m;
}

/** The off-hand grenade every humanoid carries (visible only in the throw wind-up). */
export function grenadeGeometry(): THREE.BufferGeometry {
  return new THREE.SphereGeometry(0.075, 10, 8);
}
export function grenadeMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: 0x2a2e26, emissive: 0xc83a1a, emissiveIntensity: 0.8, roughness: 0.5, metalness: 0.4 });
}
export function eyeMaterial(hex: number, intensity: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: 0x050505, emissive: hex, emissiveIntensity: intensity, roughness: 0.2 });
}
