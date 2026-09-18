/**
 * src/world/flora.ts — **per-planet wild seed groves** (lab placement A-11, 2026-09-11).
 *
 * Apart from the few the shop sells, seeds to plant in the greenhouse are **picked up in a raid**, and which varieties
 * grow differs per planet — which is what makes "go to Pyros VII if you need the ash-eating grain" hold (advanced
 * varieties are not here; they come only from analyzer resolution). That table is two columns of `data/planets.csv`:
 *
 *  - `seeds`     — `"씨앗아이템id:가중치"` joined with `|` (**the same format** as `herbs` · `soils`).
 *  - `seedNodes` — seed groves (`GatherNodeKind === 'seed'`) per mission. 0, or an empty `seeds`, = none on that planet.
 *
 * ⚠ The proper owner of both columns is `PlanetEcosystem` in `shared/planetDefs.ts` — **the same stopgap** as
 * `world/soil.ts` reading `soils` / `soilNodes` directly (this placement was not to touch `src/shared` either).
 * Moving them later to `eco.seeds` / `eco.seedNodes` leaves this file only reading those.
 * Hold time · radius live in the contract (`shared/constants.ts`) and are only re-exported here — the values' owner is `data/constants.csv`.
 *
 *
 * No THREE — this is only a place that carries numbers over into types.
 */
import { csvRows } from '@/shared';
/* The proper home of hold time · radius is the contract (`shared/constants.ts`) — only the names are re-exported here. */
export { SEED_INTERACT_TIME, SEED_NODE_RADIUS } from '@/shared';

/** The wild seeds one planet gives. */
export interface PlanetSeeds {
  /** Seed item def id → relative weight (positive only). Empty = this planet has no seed grove. */
  weights: Readonly<Record<string, number>>;
  /** Seed groves per mission. */
  nodes: number;
}

const EMPTY: PlanetSeeds = { weights: {}, nodes: 0 };

const BY_PLANET = new Map<string, PlanetSeeds>();
for (const r of csvRows('planets.csv')) {
  const id = r.raw('id');
  if (!id) continue;
  const weights: Record<string, number> = {};
  for (const c of r.costList('seeds')) {
    if (c.qty > 0) weights[c.defId] = (weights[c.defId] ?? 0) + c.qty;
  }
  const nodes = Math.max(0, Math.round(r.num('seedNodes', { min: 0, fallback: 0 })));
  BY_PLANET.set(id, Object.keys(weights).length > 0 && nodes > 0 ? { weights, nodes } : EMPTY);
}

/**
 * The wild seeds this planet gives. No planet chosen (training range · an older peer) or an unknown id → null — **no grove is placed**
 * (the same convention as `planetSoil`: with no planet there is no "old placement" to fall back to).
 */
export function planetSeeds(planetId: string | null | undefined): PlanetSeeds | null {
  if (!planetId) return null;
  const hit = BY_PLANET.get(planetId);
  return hit && hit.nodes > 0 ? hit : null;
}
