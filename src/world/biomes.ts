import * as THREE from 'three';
import { Random } from '@/shared';

export type TreeStyle = 'fungal' | 'dead' | 'none';

/** Per-biome palette + scatter tuning. All colors are linear-space THREE.Color. */
export interface Biome {
  id: string;
  name: string;                 // Korean display name
  /**
   * Name of the src/core SKY_PALETTES entry this biome is tuned against. Core picks its sky with
   * `new Random(seed).fork('atmosphere').pick(SKY_PALETTES)`; `pickBiome(seed)` reproduces that draw so the
   * pairing holds without core knowing about biomes. Purely informational here.
   */
  pairedSky: string;
  /** Suggested fog color if a future core version wants to consume it (hex). */
  fogHint: number;
  // terrain bands
  low: THREE.Color;             // sand / lakebed / lowlands
  ground: THREE.Color;          // main ground
  ground2: THREE.Color;         // ground variation (noise mixed)
  rock: THREE.Color;            // steep slopes
  high: THREE.Color;            // above highLevel (snow / ash / crust)
  cliff: THREE.Color;           // border mountains
  lowLevel: number;             // y below which `low` dominates
  highLevel: number;            // y above which `high` dominates
  // props
  boulder: THREE.Color;
  boulder2: THREE.Color;
  grass: THREE.Color;
  grassTip: THREE.Color;
  trunk: THREE.Color;
  canopy: THREE.Color;
  canopyEmissive: THREE.Color;
  crystal: THREE.Color;
  crystalEmissive: THREE.Color;
  spore: THREE.Color;
  dust: THREE.Color;
  treeStyle: TreeStyle;
  // densities are multipliers on the base scatter counts
  boulderDensity: number;
  spireDensity: number;
  treeDensity: number;
  crystalDensity: number;
  grassDensity: number;
  debrisDensity: number;
  /** Nest goo tint that bleeds into terrain around hives */
  nestGoo: THREE.Color;
}

const c = (hex: number) => new THREE.Color(hex);

/**
 * Order matters: index i is paired with src/core SKY_PALETTES[i]
 * (amber-dusk, cold-blue, toxic-green, rust-storm, pale-noon).
 */
export const BIOMES: Biome[] = [
  {
    // warm orange fog (0xc99a6c) → keep ground paler/greyer than the fog, dark red-brown dirt + charcoal rock for contrast
    id: 'amber', name: '호박빛 사막', pairedSky: 'amber-dusk', fogHint: 0xc99a6c,
    low: c(0xd2bc90), ground: c(0xb89a68), ground2: c(0x7e5a3c), rock: c(0x4a4038), high: c(0xe0d0b0), cliff: c(0x3e3430),
    lowLevel: 1.0, highLevel: 32,
    boulder: c(0x6a5448), boulder2: c(0x8a7260), grass: c(0x7a6a30), grassTip: c(0xc8b060),
    trunk: c(0x3e2a1e), canopy: c(0xd4a24a), canopyEmissive: c(0x000000),
    crystal: c(0x35c8e0), crystalEmissive: c(0x1aa0c8), spore: c(0xffe0a0), dust: c(0xd8b068),
    treeStyle: 'dead',
    boulderDensity: 1.1, spireDensity: 1.2, treeDensity: 0.4, crystalDensity: 0.6, grassDensity: 0.6, debrisDensity: 1.0,
    nestGoo: c(0x5a2a1c),
  },
  {
    // blue-grey fog (0x8aa2bd) → neutral/warm-tinted snow, brown exposed dirt, near-black rock
    id: 'tundra', name: '동토 툰드라', pairedSky: 'cold-blue', fogHint: 0x8aa2bd,
    low: c(0x8a9aa0), ground: c(0xcbd0cc), ground2: c(0x847a6c), rock: c(0x3a3c3e), high: c(0xf4f7fa), cliff: c(0x2e343c),
    lowLevel: 1.0, highLevel: 22,
    boulder: c(0x4e565e), boulder2: c(0x7a8088), grass: c(0x5e6a58), grassTip: c(0xb8c0a0),
    trunk: c(0x2e2826), canopy: c(0x9ab0c0), canopyEmissive: c(0x000000),
    crystal: c(0x9ad8ff), crystalEmissive: c(0x50a0ff), spore: c(0xe8f4ff), dust: c(0xc8d8e8),
    treeStyle: 'dead',
    boulderDensity: 1.0, spireDensity: 0.9, treeDensity: 0.5, crystalDensity: 1.0, grassDensity: 0.4, debrisDensity: 0.9,
    nestGoo: c(0x5a2a24),
  },
  {
    // yellow-green fog (0x8d9c5f) → desaturated olive/brown ground, lots of dirt & grey rock, cream canopies so trees read
    id: 'mossy', name: '이끼 습지', pairedSky: 'toxic-green', fogHint: 0x9aa078,
    low: c(0x3a3a2c), ground: c(0x66683c), ground2: c(0x5a4a34), rock: c(0x55544e), high: c(0xa4a888), cliff: c(0x3a3c36),
    lowLevel: 2.0, highLevel: 30,
    boulder: c(0x5c5e56), boulder2: c(0x787a6a), grass: c(0x5e6a30), grassTip: c(0xc0c26a),
    trunk: c(0x5a4634), canopy: c(0xe0c884), canopyEmissive: c(0x3a3010),
    crystal: c(0x5affb0), crystalEmissive: c(0x20c070), spore: c(0xe8f0b0), dust: c(0xa0a080),
    treeStyle: 'fungal',
    boulderDensity: 0.8, spireDensity: 0.5, treeDensity: 1.6, crystalDensity: 0.7, grassDensity: 1.6, debrisDensity: 0.8,
    nestGoo: c(0x4a2a1c),
  },
  {
    // rust fog (0xa86d4d) → cool dark greys + black, so the warm sky reads against the ground
    id: 'ashen', name: '잿빛 화산지대', pairedSky: 'rust-storm', fogHint: 0xa86d4d,
    low: c(0x34343a), ground: c(0x4c4c4e), ground2: c(0x2c2a2c), rock: c(0x1e1e20), high: c(0x6e6c6a), cliff: c(0x1a1a1c),
    lowLevel: 0.0, highLevel: 30,
    boulder: c(0x323234), boulder2: c(0x4c4642), grass: c(0x4a3a2a), grassTip: c(0x9a6a3a),
    trunk: c(0x1c1a18), canopy: c(0x3a2a24), canopyEmissive: c(0x000000),
    crystal: c(0xff7a1a), crystalEmissive: c(0xff4a00), spore: c(0xff9a4a), dust: c(0x6a5a52),
    treeStyle: 'dead',
    boulderDensity: 1.5, spireDensity: 1.6, treeDensity: 0.35, crystalDensity: 1.2, grassDensity: 0.25, debrisDensity: 1.2,
    nestGoo: c(0x4a1c14),
  },
  {
    // pale neutral fog (0xbcc8d2) → saturated crimson/magenta ground pops
    id: 'crimson', name: '적색 외계 평원', pairedSky: 'pale-noon', fogHint: 0xbcc8d2,
    low: c(0x6a2a3a), ground: c(0x8e3c4c), ground2: c(0x62283e), rock: c(0x3a2430), high: c(0xc47a88), cliff: c(0x2a1a24),
    lowLevel: 1.0, highLevel: 30,
    boulder: c(0x4a2e3a), boulder2: c(0x6c3e4c), grass: c(0x8a2a4a), grassTip: c(0xff7a9a),
    trunk: c(0x3a1a24), canopy: c(0xd858a0), canopyEmissive: c(0x4a1030),
    crystal: c(0xff5ad0), crystalEmissive: c(0xd020a0), spore: c(0xffb0e0), dust: c(0x9a6a7a),
    treeStyle: 'fungal',
    boulderDensity: 1.0, spireDensity: 1.1, treeDensity: 1.2, crystalDensity: 1.4, grassDensity: 1.0, debrisDensity: 1.0,
    nestGoo: c(0x3a1010),
  },
];

/**
 * Pick the biome paired with the sky core will choose for this seed.
 * Mirrors `Atmosphere.applySeed`: `new Random(seed).fork('atmosphere').pick(list)` with a 5-entry list —
 * `Random.pick` only depends on the list length, so the index matches as long as both lists have 5 entries.
 */
export function pickBiome(seed: number): Biome {
  const rng = new Random(seed >>> 0).fork('atmosphere');
  return rng.pick(BIOMES);
}

const BIOME_BY_ID = new Map<string, Biome>(BIOMES.map((b) => [b.id, b]));

/**
 * Biome named by a planet (Phase 11): `PlanetDef.biome` is a `Biome.id`, so the seed no longer decides the palette
 * when a 목표 행성 is set. Returns `undefined` for null / an unknown id — every caller falls back to `pickBiome(seed)`,
 * which keeps the pre-Phase-11 behaviour for an older peer or a training.
 */
export function biomeById(id: string | null | undefined): Biome | undefined {
  return id == null ? undefined : BIOME_BY_ID.get(id);
}
