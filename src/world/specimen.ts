/**
 * src/world/specimen.ts — **per-planet 미확인 표본 gather sites** (lab placement A-12, 2026-09-11).
 *
 * ## 2026-09-18 (user's decision) — **not one specimen site stands any more**
 * All five rows of `data/planets.csv` have `sampleNodes = 0` · an empty `samples`. The decision split where specimens
 * come from three ways instead, with no gather site at all: **미확인 광물 = the mineral vein · the salvage pile**,
 * **미확인 세포 = killing bugs (and bug eggs)**, **미확인 유전자 = lab containers**. 「specimens lying about on the planet floor」 is what was dropped, not specimens.
 *
 * **This file and both columns are left alone** (the retirement convention — the same place as `ItemDef.retired`). It runs
 * on data alone and `nodes = 0` already means 「this planet has no gather site」, so putting one csv number back
 * stands them up again — there is no logic to delete. An empty column is not a 「missing value」 to fill in.
 *
 * The specimens the analyzer resolves come from three places — bug corpses (`data/loot_corpses.csv`) · structure and
 * basement containers (`data/loot_category_weights.csv`), and **the gather sites this file places**. Which specimens
 * appear differs per planet (genome · crystal only on dangerous ones). That table is two columns of `data/planets.csv`:
 *
 *  - `samples`     — `"표본아이템id:가중치"` joined with `|` (the same format as `herbs` · `soils` · `seeds`).
 *  - `sampleNodes` — specimen gather sites (`GatherNodeKind === 'sample'`) per mission. 0 or empty = none on that planet.
 *
 * ⚠ The proper owner of both columns is `PlanetEcosystem` in `shared/planetDefs.ts` — **the same stopgap** as
 * `world/soil.ts` reading `soils` / `soilNodes` directly, and moving them to `eco.samples` / `eco.sampleNodes` leaves
 * this file only reading those. Hold time · radius live in the contract (`shared/constants.ts`) and are re-exported here.
 *
 * No THREE — this is only a place that carries numbers over into types.
 *
 * 2026-09-13 (cooking material tiers — three specimens merged): the new table values centre on `spec_cell` · `spec_mineral`.
 * This file carries the csv over **verbatim** (it does not know item defs); the pin that drops a retired old specimen
 * (`ItemDef.retired`) is `Gather.resolveNodeWeights`, which does know defs — an old id in the table stands no site. 미확인 광물 also comes from the salvage pile bonus (`gather_mineral`).
 */
import { csvRows } from '@/shared';
/* The proper home of hold time · radius is the contract (`shared/constants.ts`) — only the names are re-exported here. */
export { SAMPLE_INTERACT_TIME, SAMPLE_NODE_RADIUS } from '@/shared';

/** The 미확인 표본 one planet gives. */
export interface PlanetSamples {
  /** Specimen item def id → relative weight (positive only). Empty = this planet has no specimen gather site. */
  weights: Readonly<Record<string, number>>;
  /** Specimen gather sites per mission. */
  nodes: number;
}

const EMPTY: PlanetSamples = { weights: {}, nodes: 0 };

const BY_PLANET = new Map<string, PlanetSamples>();
for (const r of csvRows('planets.csv')) {
  const id = r.raw('id');
  if (!id) continue;
  const weights: Record<string, number> = {};
  for (const c of r.costList('samples')) {
    if (c.qty > 0) weights[c.defId] = (weights[c.defId] ?? 0) + c.qty;
  }
  const nodes = Math.max(0, Math.round(r.num('sampleNodes', { min: 0, fallback: 0 })));
  BY_PLANET.set(id, Object.keys(weights).length > 0 && nodes > 0 ? { weights, nodes } : EMPTY);
}

/**
 * The 미확인 표본 this planet gives. No planet chosen or an unknown id → null — **no gather site is placed**
 * (the same convention as `planetSoil` · `planetSeeds`).
 */
export function planetSamples(planetId: string | null | undefined): PlanetSamples | null {
  if (!planetId) return null;
  const hit = BY_PLANET.get(planetId);
  return hit && hit.nodes > 0 ? hit : null;
}
