import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/* Shared material palette for every ship interior / exterior (constant, never disposed). */
function std(color: number, roughness: number, metalness: number, emissive = 0, emissiveIntensity = 0): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness, emissive, emissiveIntensity });
}
export const HUB_MATS = {
  hull: std(0x4b5158, 0.62, 0.55),
  hullDark: std(0x2b2f35, 0.72, 0.5),
  hullLight: std(0x6f767e, 0.55, 0.5),
  floor: std(0x33373d, 0.85, 0.3),
  floorGrate: std(0x23262b, 0.9, 0.35),
  trim: std(0xc9a03a, 0.55, 0.35),
  trimDark: std(0x7a5f22, 0.6, 0.35),
  glassDark: std(0x0c141c, 0.12, 0.9, 0x10243a, 0.5),
  screen: std(0x0a1a22, 0.3, 0.2, 0x1e7fa8, 1.6),
  stripWhite: std(0xe8f0ff, 0.4, 0.1, 0xdfe9ff, 2.2),
  stripAmber: std(0xffc98a, 0.4, 0.1, 0xffa640, 2.4),
  stripRed: std(0xff8a7a, 0.4, 0.1, 0xff3a2a, 2.0),
  stripCyan: std(0x9be8ff, 0.4, 0.1, 0x3ac8ff, 2.0),
  padding: std(0x5a4636, 0.95, 0.05),
  fabric: std(0x36453a, 0.95, 0.05),
  crate: std(0x4a5a3c, 0.8, 0.25),
  crateDark: std(0x2e3a26, 0.85, 0.25),
  gunmetal: std(0x2a2d31, 0.5, 0.8),
  engine: new THREE.MeshBasicMaterial({ color: 0x7fd8ff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
};

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
/** YXZ: yaw the prop first, then tilt it around its own X (screens, slanted housings). */
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _s = new THREE.Vector3(1, 1, 1);
const _p = new THREE.Vector3();

/**
 * Accumulates static box / cylinder geometry per material and merges it into one mesh per material
 * (keeps ship interiors at a few dozen draw calls). Source geometries are disposed on `build()`.
 */
export class GeoBatch {
  private groups = new Map<THREE.Material, THREE.BufferGeometry[]>();

  add(geom: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): void {
    _e.set(rx, ry, rz);
    _q.setFromEuler(_e);
    _p.set(x, y, z);
    _m.compose(_p, _q, _s);
    geom.applyMatrix4(_m);
    let list = this.groups.get(mat);
    if (!list) { list = []; this.groups.set(mat, list); }
    list.push(geom);
  }

  /** Box centred at (x, y, z). */
  box(w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material, ry = 0, rx = 0, rz = 0): void {
    this.add(new THREE.BoxGeometry(w, h, d), mat, x, y, z, rx, ry, rz);
  }
  /** Box whose bottom face sits at `bottomY`. */
  boxB(w: number, h: number, d: number, x: number, bottomY: number, z: number, mat: THREE.Material, ry = 0): void {
    this.box(w, h, d, x, bottomY + h / 2, z, mat, ry);
  }
  cyl(rTop: number, rBot: number, h: number, seg: number, x: number, y: number, z: number, mat: THREE.Material, rx = 0, ry = 0, rz = 0, open = false): void {
    this.add(new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, open), mat, x, y, z, rx, ry, rz);
  }
  /** Flat plane facing +Y (floors) or rotated. */
  plane(w: number, h: number, x: number, y: number, z: number, mat: THREE.Material, rx = -Math.PI / 2, ry = 0, rz = 0): void {
    this.add(new THREE.PlaneGeometry(w, h), mat, x, y, z, rx, ry, rz);
  }

  build(parent: THREE.Object3D, out: THREE.Mesh[], castShadow = true, receiveShadow = true): void {
    for (const [mat, list] of this.groups) {
      if (list.length === 0) continue;
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = castShadow;
      mesh.receiveShadow = receiveShadow;
      mesh.matrixAutoUpdate = false;
      parent.add(mesh);
      out.push(mesh);
    }
    this.groups.clear();
  }
}

/** Dispose merged meshes' geometries (materials are shared and kept). */
export function disposeMeshes(meshes: THREE.Mesh[]): void {
  for (const m of meshes) {
    m.geometry.dispose();
    m.removeFromParent();
  }
  meshes.length = 0;
}

/** Player yaw whose horizontal forward is (fx, fz) — player forward = (−sin yaw, −cos yaw). */
export function yawFromForward(fx: number, fz: number): number {
  return Math.atan2(-fx, -fz);
}
