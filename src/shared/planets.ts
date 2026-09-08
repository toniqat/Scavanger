import type { EnemyType } from './types';

/* ────────────────────────────────────────────────────────────────────────────
 * Planets (Phase 11, 2026-09-07).
 *
 * A mission is still generated from a **random seed** — the seed decides layout, crates, nests, rogue-guard
 * placement and loot. What the player now picks at the terminal is the **planet**: the terrain palette, the sky,
 * whether there is fog at all, and the ecosystem (which enemies live here, how many, which herbs grow).
 *
 * Before Phase 11 both of those came from the seed as well (`world/biomes.pickBiome(seed)` and
 * `core/Atmosphere.applySeed(seed)`, paired only by the implicit "both lists have exactly 5 entries" rule). A planet
 * makes the pairing **explicit**: `PlanetDef.biome` names the `world/biomes.ts` entry and `PlanetDef.sky` names the
 * `core/Sky.ts` `SKY_PALETTES` entry, so neither list can reorder the other into a mismatch again. With no planet
 * selected (an older peer, `game:newMission` without the field) both fall back to the seeded draw exactly as before.
 *
 * This file is imported by the browser AND the Node server (type-only there) — no runtime deps.
 * Owner: shared/. `world/` reads `biome` + `eco.herbs` + `eco.gatherDensity`, `core/` reads `sky` / `fog` / `fogMul`,
 * `enemies/` reads `eco`, `hub/` reads everything for the terminal, `ui/` reads the labels.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Planet ids double as their `world/biomes.ts` biome id — one planet per biome in this build. */
export type PlanetId = 'amber' | 'tundra' | 'mossy' | 'ashen' | 'crimson';

/** Terminal order (left <-> right at the hologram) and the wire order. Never reorder; append only. */
export const PLANET_IDS: readonly PlanetId[] = ['amber', 'tundra', 'mossy', 'ashen', 'crimson'];

/**
 * Who lives here. Every number is a **re-weighting of existing content** — Phase 11 adds no enemy type and no item.
 *
 * `bugs` are relative weights for the composition tables in `enemies/Spawner.ts` (`ambientGroup` / `waveGroup`):
 * a type absent from the map (or 0) never spawns on this planet, and the existing threat gates still apply on top
 * (a `charger` weight does nothing until mission threat has ramped far enough to allow chargers at all), so the
 * difficulty curve is unchanged — only *which* silhouettes fill it.
 */
export function isPlanetId(v: unknown): v is PlanetId {
  return typeof v === 'string' && (PLANET_IDS as readonly string[]).includes(v);
}

export const PLANET_NONE_LABEL = '목표 미지정';

/** localStorage key of the last planet the player picked (hub-owned, client-local; absent = never picked). */
export const PLANET_STORAGE_KEY = 'scav.planet';
