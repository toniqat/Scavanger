/**
 * src/world/surface.ts — **the material underfoot** (2026-09-11, C-22 `WorldRef.getSurfaceMaterial`).
 *
 * A query picking one footstep sound, so it **has to be cheap** — it is called every step. The only hash query is
 * `WorldSystem.getStandingObstacle`; the rest is the result → material table and an **approximation of the colour rules** (allocation-free).
 *
 * Terrain reads the order `Terrain.computeColors` paints in, backwards: nest goo → crater scorch → the border cliff →
 * slope rock → highland → lowland → the ground variation (`ground2`) → ground. A colour rule's boundary is cut at the
 * middle of its `smoothstep` (0.5). The noise `n1` is the colour pass's own expression (`noise.fbm(x·0.045+3, z·0.045−8, 2)`),
 * so the visible mottling and the footstep change at the same spot. The band → material table per biome is one `BAND_MATERIALS`.
 *
 * THREE is not used as a value (types only).
 */
import type { Obstacle, SurfaceMaterial } from '@/shared';
import type { Biome } from './biomes';
import type { WorldLayout } from './layout';
import type { Noise } from './noise';
import type { OutpostSite } from './Outposts';
import type { Terrain } from './Terrain';

/** A biome's terrain bands → material. A biome not listed is all `dirt` (the old footstep). */
interface BandMaterials { low: SurfaceMaterial; ground: SurfaceMaterial; ground2: SurfaceMaterial; high: SurfaceMaterial }

const BAND_MATERIALS: Readonly<Record<string, BandMaterials>> = {
  // amber desert: sand plain · red dirt mottling · pale dune tops
  amber: { low: 'sand', ground: 'sand', ground2: 'dirt', high: 'sand' },
  // frozen tundra: snow · bare dirt mottling · frozen lowland
  tundra: { low: 'snow', ground: 'snow', ground2: 'dirt', high: 'snow' },
  // mossy wetland: moss ground · mud mottling · black swamp lowland
  mossy: { low: 'mud', ground: 'moss', ground2: 'mud', high: 'moss' },
  // ashen volcanic ground: ash everywhere
  ashen: { low: 'ash', ground: 'ash', ground2: 'ash', high: 'ash' },
  // crimson alien plain: flesh-like ground
  crimson: { low: 'organic', ground: 'organic', ground2: 'organic', high: 'organic' },
};

/**
 * Obstacle `kind` (`SpatialHash.ObstacleEntry.kind`) → material. A kind not listed is `dirt`.
 * Structure floors · walls (`slab` · `building`) are concrete, but metal on **the crash-landed ship** — `obstacleMaterial` decides that.
 */
const KIND_MATERIALS: Readonly<Record<string, SurfaceMaterial>> = {
  rock: 'rock', crystal: 'crystal', debris: 'metal', tree: 'organic', nest: 'organic', grove: 'organic',
  crate: 'metal', wall: 'concrete', pole: 'metal', slab: 'concrete', building: 'concrete', container: 'metal',
  glass: 'concrete', door: 'metal', console: 'metal', hatch: 'metal', rail: 'metal', pier: 'concrete',
  platform: 'metal', sign: 'metal', tram: 'metal', dynamic: 'metal', target: 'metal',
};

/** Radius (m) in which nest goo changes the footstep — where the colour pass's goo strength passes 0.5 (`1 − smoothstep(6, 30, d)` ≈ 15 m). */
const NEST_GOO_M = 15;
/** Crater scorch: within radius × this fraction (the inner part where the colour pass's scorch is darkest). */
const CRATER_SCORCH_FRAC = 0.5;
/** Slope rock: when `1 − normal.y` is above this (the middle of `smoothstep(0.18, 0.42)`). */
const ROCK_SLOPE = 0.3;
/** The border cliff (outside the play area): when the Chebyshev distance − HALF is above this. */
const CLIFF_EDGE_M = 18;

/** One obstacle's material. `wreckAt` answers whether (x, z) is inside the crash-landed ship — asked only for a structure floor. */
export function obstacleMaterial(o: Obstacle, x: number, z: number, wreckAt: (x: number, z: number) => boolean): SurfaceMaterial {
  const kind = (o as Obstacle & { kind?: string }).kind ?? '';
  if ((kind === 'slab' || kind === 'building') && wreckAt(x, z)) return 'metal';
  return KIND_MATERIALS[kind] ?? 'dirt';
}

/** Is (x, z) on a POI ruin's concrete floor slab (a slab with no collider, so a terrain query cannot tell). */
export function onOutpostSlab(sites: readonly OutpostSite[], x: number, z: number): boolean {
  for (let i = 0; i < sites.length; i++) {
    const s = sites[i];
    const dx = x - s.position.x, dz = z - s.position.z;
    if (dx * dx + dz * dz > s.radius * s.radius) continue;
    const c = Math.cos(s.yaw), sn = Math.sin(s.yaw);
    if (Math.abs(dx * c + dz * sn) <= s.slabHalfX && Math.abs(-dx * sn + dz * c) <= s.slabHalfZ) return true;
  }
  return false;
}

/**
 * The terrain band's material — `Terrain.computeColors`' rules read from the back (what was painted later wins).
 * `half` = the play area's half-side (`Terrain.HALF`).
 */
export function terrainMaterial(
  biome: Biome | null, terrain: Terrain, noise: Noise | null, layout: WorldLayout | null, half: number,
  x: number, z: number,
): SurfaceMaterial {
  if (!biome) return 'dirt';
  const bands = BAND_MATERIALS[biome.id];
  if (!bands) return 'dirt';

  if (layout) {
    const nests = layout.nests;
    for (let k = 0; k < nests.length; k++) {
      const dx = x - nests[k].x, dz = z - nests[k].z;
      if (dx * dx + dz * dz < NEST_GOO_M * NEST_GOO_M) return 'organic';
    }
    const craters = layout.craters;
    for (let k = 0; k < craters.length; k++) {
      const c = craters[k];
      const dx = x - c.x, dz = z - c.z, r = c.radius * CRATER_SCORCH_FRAC;
      if (dx * dx + dz * dz < r * r) return 'ash';
    }
  }
  if (Math.max(Math.abs(x), Math.abs(z)) - half > CLIFF_EDGE_M) return 'rock';
  const slope = terrain.getSlopeAt(x, z);
  if (slope > ROCK_SLOPE) return 'rock';

  const h = terrain.getHeightAt(x, z);
  const n1 = noise ? noise.fbm(x * 0.045 + 3, z * 0.045 - 8, 2) : 0;
  // highT = smoothstep(high − 4 + 3·n1, high + 3 + 3·n1, h) × (0 when steep) — the middle is high − 0.5 + 3·n1
  if (h > biome.highLevel - 0.5 + n1 * 3) return bands.high;
  // lowT = 1 − smoothstep(low − 1.5 + 1.5·n1, low + 2.5 + 1.5·n1, h) — the middle is low + 0.5 + 1.5·n1
  if (h < biome.lowLevel + 0.5 + n1 * 1.5) return bands.low;
  // gv = smoothstep(−0.25, 0.35, n1) — the middle is n1 = 0.05
  return n1 > 0.05 ? bands.ground2 : bands.ground;
}
