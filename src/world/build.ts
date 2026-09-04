import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Random } from '@/shared';
import type { Biome } from './biomes';
import type { WorldLayout } from './layout';
import { padClearance } from './layout';
import type { Noise } from './noise';
import type { SpatialHash } from './SpatialHash';
import { HALF, Terrain } from './Terrain';

/** Everything a world sub-builder needs. Created once per mission by WorldSystem. */
export interface BuildCtx {
  rng: Random;
  noise: Noise;
  biome: Biome;
  layout: WorldLayout;
  terrain: Terrain;
  hash: SpatialHash;
  /** Scene-level group all world meshes are added to. */
  root: THREE.Group;
}

/** Playable area limit for gameplay-relevant placement (crates, spawns). */
export const PLAY_LIMIT = HALF - 10;

/**
 * Is a circle at (x,z) free for placing something?
 * Checks bounds, slope, pad clearance (negative `padExtra` allows entering pads) and obstacle overlap.
 */
export function isSpotFree(
  ctx: BuildCtx, x: number, z: number, radius: number,
  opts: { maxSlope?: number; padExtra?: number; limit?: number; ignorePads?: boolean } = {},
): boolean {
  const limit = opts.limit ?? PLAY_LIMIT;
  if (Math.abs(x) > limit || Math.abs(z) > limit) return false;
  const maxSlope = opts.maxSlope ?? 0.35;
  if (ctx.terrain.getSlopeAt(x, z) > maxSlope) return false;
  if (!opts.ignorePads && padClearance(ctx.layout, x, z, opts.padExtra ?? 4) < radius) return false;
  if (ctx.hash.overlaps(x, z, radius)) return false;
  return true;
}

/** Assigns a flat vertex color to a geometry (creates/overwrites the color attribute). */
export function paint(geo: THREE.BufferGeometry, color: THREE.Color, jitter = 0, rng?: Random): THREE.BufferGeometry {
  const n = geo.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const j = jitter && rng ? 1 + (rng.next() * 2 - 1) * jitter : 1;
    arr[i * 3] = Math.min(1, color.r * j);
    arr[i * 3 + 1] = Math.min(1, color.g * j);
    arr[i * 3 + 2] = Math.min(1, color.b * j);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** Vertical gradient vertex color between `bottom` (y=minY) and `top` (y=maxY). */
export function paintGradient(geo: THREE.BufferGeometry, bottom: THREE.Color, top: THREE.Color, minY?: number, maxY?: number): THREE.BufferGeometry {
  const pos = geo.getAttribute('position');
  const n = pos.count;
  let lo = minY ?? Infinity, hi = maxY ?? -Infinity;
  if (minY === undefined || maxY === undefined) {
    for (let i = 0; i < n; i++) { const y = pos.getY(i); if (y < lo) lo = y; if (y > hi) hi = y; }
  }
  const span = Math.max(1e-4, hi - lo);
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const t = THREE.MathUtils.clamp((pos.getY(i) - lo) / span, 0, 1);
    arr[i * 3] = bottom.r + (top.r - bottom.r) * t;
    arr[i * 3 + 1] = bottom.g + (top.g - bottom.g) * t;
    arr[i * 3 + 2] = bottom.b + (top.b - bottom.b) * t;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** Displace vertices along their normal by 3D noise. Recomputes normals. */
export function displace(geo: THREE.BufferGeometry, noise: Noise, amp: number, freq: number, offset = 0): THREE.BufferGeometry {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    const len = v.length() || 1;
    const n = noise.noise3(v.x * freq + offset, v.y * freq + offset * 0.7, v.z * freq - offset) +
      0.5 * noise.noise3(v.x * freq * 2.3 + 9, v.y * freq * 2.3, v.z * freq * 2.3 + 4);
    const s = 1 + n * amp / len;
    pos.setXYZ(i, v.x * s, v.y * s, v.z * s);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/** Merge geometries (all must share the same attribute set) and drop the inputs. */
export function merge(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  // Ensure every part has a color attribute + no index mismatch
  for (const g of geos) {
    if (!g.getAttribute('color')) paint(g, new THREE.Color(1, 1, 1));
    if (g.getAttribute('uv') === undefined) {
      const n = g.getAttribute('position').count;
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    }
  }
  const nonIndexed = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  const out = mergeGeometries(nonIndexed, false);
  for (const g of geos) g.dispose();
  for (const g of nonIndexed) if (!geos.includes(g)) g.dispose();
  if (!out) throw new Error('[world] mergeGeometries failed');
  // strip uv2/others that may confuse instancing
  return out;
}

/** Apply a transform to a geometry in place. */
export function xform(geo: THREE.BufferGeometry, pos?: THREE.Vector3Like, rot?: THREE.Euler, scale?: number | THREE.Vector3Like): THREE.BufferGeometry {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  if (rot) q.setFromEuler(rot);
  const s = typeof scale === 'number' ? new THREE.Vector3(scale, scale, scale) : scale ? new THREE.Vector3(scale.x, scale.y, scale.z) : new THREE.Vector3(1, 1, 1);
  m.compose(pos ? new THREE.Vector3(pos.x, pos.y, pos.z) : new THREE.Vector3(), q, s);
  geo.applyMatrix4(m);
  return geo;
}

/** Shared scratch objects for instance matrix composition (not reentrant — generation is single-threaded). */
export const scratch = {
  m: new THREE.Matrix4(),
  q: new THREE.Quaternion(),
  p: new THREE.Vector3(),
  s: new THREE.Vector3(),
  e: new THREE.Euler(),
  c: new THREE.Color(),
};

/** Build a Matrix4 from position / yaw+tilt / uniform or non-uniform scale using scratch objects. */
export function composeMatrix(x: number, y: number, z: number, yaw: number, tiltX: number, tiltZ: number, sx: number, sy: number, sz: number): THREE.Matrix4 {
  scratch.e.set(tiltX, yaw, tiltZ, 'YXZ');
  scratch.q.setFromEuler(scratch.e);
  scratch.p.set(x, y, z);
  scratch.s.set(sx, sy, sz);
  return scratch.m.compose(scratch.p, scratch.q, scratch.s);
}

/** Small round soft-particle sprite texture (radial gradient). */
export function makeSoftParticleTexture(size = 64): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const c = canvas.getContext('2d')!;
  const g = c.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.6)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

export { Terrain };
