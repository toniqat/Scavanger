import * as THREE from 'three';
import { MAP_SIZE, Random } from '@/shared';

export type PadKind = 'spawn' | 'extraction' | 'nest' | 'poi';

/** A flattened circular area blended into the heightfield. */
export interface Pad {
  kind: PadKind;
  x: number;
  z: number;
  radius: number;      // fully flat radius
  blend: number;       // smooth blend width beyond radius
  yaw: number;
  /** Assigned by Terrain once the heightfield is sampled. */
  height: number;
}

export interface Crater { x: number; z: number; radius: number; depth: number }
export interface Basin { x: number; z: number; radius: number; depth: number }

export interface WorldLayout {
  spawn: Pad;
  extraction: Pad[];
  nests: Pad[];
  pois: Pad[];
  pads: Pad[];          // all of the above
  craters: Crater[];
  basins: Basin[];
}

const HALF = MAP_SIZE / 2;

function dist(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

function farFromAll(x: number, z: number, others: readonly { x: number; z: number }[], minD: number): boolean {
  for (const o of others) if (dist(x, z, o.x, o.z) < minD) return false;
  return true;
}

/** Place the macro layout: spawn, extraction pads, nests, POIs, craters, basins. Deterministic per rng. */
export function generateLayout(rng: Random): WorldLayout {
  const margin = 56; // keep pads away from the cliff wall
  const inner = HALF - margin;

  // Spawn near one edge
  const side = rng.int(0, 3);
  const along = rng.range(-inner * 0.6, inner * 0.6);
  const edgeDist = HALF - 64;
  let sx = 0, sz = 0;
  if (side === 0) { sx = -edgeDist; sz = along; }
  else if (side === 1) { sx = edgeDist; sz = along; }
  else if (side === 2) { sx = along; sz = -edgeDist; }
  else { sx = along; sz = edgeDist; }
  const spawn: Pad = { kind: 'spawn', x: sx, z: sz, radius: 18, blend: 22, yaw: Math.atan2(-sx, -sz), height: 0 };

  // Extraction pads: 3, pairwise >= 180 m, >= 150 m from spawn
  const extraction: Pad[] = [];
  {
    let minPair = 180, minSpawn = 150;
    let attempts = 0;
    while (extraction.length < 3) {
      attempts++;
      if (attempts % 400 === 0) { minPair *= 0.92; minSpawn *= 0.92; } // relax slowly if unlucky
      const x = rng.range(-inner, inner), z = rng.range(-inner, inner);
      if (dist(x, z, spawn.x, spawn.z) < minSpawn) continue;
      if (!farFromAll(x, z, extraction, minPair)) continue;
      extraction.push({ kind: 'extraction', x, z, radius: 20, blend: 26, yaw: rng.range(-Math.PI, Math.PI), height: 0 });
    }
  }

  // Nest clusters: 4–6
  const nests: Pad[] = [];
  {
    const n = rng.int(4, 6);
    let attempts = 0;
    while (nests.length < n && attempts < 4000) {
      attempts++;
      const x = rng.range(-inner + 10, inner - 10), z = rng.range(-inner + 10, inner - 10);
      if (dist(x, z, spawn.x, spawn.z) < 110) continue;
      if (!farFromAll(x, z, extraction, 62)) continue;
      if (!farFromAll(x, z, nests, 90)) continue;
      nests.push({ kind: 'nest', x, z, radius: 20, blend: 24, yaw: rng.range(-Math.PI, Math.PI), height: 0 });
    }
  }

  // POIs (ruined outposts): 5–8
  const pois: Pad[] = [];
  {
    const n = rng.int(5, 8);
    let attempts = 0;
    while (pois.length < n && attempts < 4000) {
      attempts++;
      const x = rng.range(-inner + 8, inner - 8), z = rng.range(-inner + 8, inner - 8);
      if (dist(x, z, spawn.x, spawn.z) < 50) continue;
      if (!farFromAll(x, z, extraction, 48)) continue;
      if (!farFromAll(x, z, nests, 48)) continue;
      if (!farFromAll(x, z, pois, 70)) continue;
      pois.push({ kind: 'poi', x, z, radius: 13, blend: 16, yaw: rng.range(-Math.PI, Math.PI), height: 0 });
    }
  }

  const pads = [spawn, ...extraction, ...nests, ...pois];

  // Craters: 3–5, away from pads
  const craters: Crater[] = [];
  {
    const n = rng.int(3, 5);
    let attempts = 0;
    while (craters.length < n && attempts < 2000) {
      attempts++;
      const radius = rng.range(14, 30);
      const x = rng.range(-inner, inner), z = rng.range(-inner, inner);
      if (!farFromAll(x, z, pads, radius + 34)) continue;
      if (!farFromAll(x, z, craters, radius + 40)) continue;
      craters.push({ x, z, radius, depth: rng.range(4, 8) });
    }
  }

  // Basins: 2–3 broad gentle depressions
  const basins: Basin[] = [];
  {
    const n = rng.int(2, 3);
    let attempts = 0;
    while (basins.length < n && attempts < 1000) {
      attempts++;
      const x = rng.range(-inner, inner), z = rng.range(-inner, inner);
      if (!farFromAll(x, z, basins, 120)) continue;
      basins.push({ x, z, radius: rng.range(55, 90), depth: rng.range(3, 6) });
    }
  }

  return { spawn, extraction, nests, pois, pads, craters, basins };
}

/** Distance from (x,z) to nearest pad edge (negative when inside a pad's flat radius). */
export function padClearance(layout: WorldLayout, x: number, z: number, extra = 0): number {
  let best = Infinity;
  for (const p of layout.pads) {
    const d = dist(x, z, p.x, p.z) - (p.radius + extra);
    if (d < best) best = d;
  }
  return best;
}

export function nearestPad(layout: WorldLayout, x: number, z: number, kinds?: readonly PadKind[]): { pad: Pad; d: number } | null {
  let best: Pad | null = null, bd = Infinity;
  for (const p of layout.pads) {
    if (kinds && !kinds.includes(p.kind)) continue;
    const d = dist(x, z, p.x, p.z);
    if (d < bd) { bd = d; best = p; }
  }
  return best ? { pad: best, d: bd } : null;
}

export const tmpV3 = new THREE.Vector3();
