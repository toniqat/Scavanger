/**
 * src/world/soil.ts — **per-planet soil** (greenhouse rework, 2026-09-11).
 *
 * The greenhouse's grow station pours soil first and plants the seed on top of it (`GrowSlot.soilDefId` in `shared/housing`).
 * That soil is obtained **only by gathering in a raid**, and which tag appears differs per planet — which is what makes
 * "go to Verdant III if you need 부엽토" hold. That table is two columns of `data/planets.csv`:
 *
 *  - `soils`     — `"토양아이템id:가중치"` joined with `|` (**the same format** as `herbs`).
 *  - `soilNodes` — soil piles (`GatherNodeKind === 'soil'`) per mission. 0, or an empty `soils`, = none on that planet.
 *
 * ⚠ The proper owner of both columns is `PlanetEcosystem` in `shared/planetDefs.ts`. That placement was not to touch
 * `src/shared`, so world/ reads them directly — the same stopgap as `structures/model.ts` reading `RAIL_CLEARANCE_M`,
 * and moving them later to `eco.soils` / `eco.soilNodes` leaves this file only reading those.
 * (Until then, putting this module in `DATA_OWNERS` of `scripts/data-owners.mjs` lets `data:check` catch column typos too.)
 *
 * No THREE — this is only a place that carries numbers over into types.
 */
import { csvRows } from '@/shared';

/** The soil one planet gives. */
export interface PlanetSoil {
  /** Soil item def id → relative weight (positive only). Empty = this planet has no soil pile. */
  weights: Readonly<Record<string, number>>;
  /** Soil piles per mission. */
  nodes: number;
}

const EMPTY: PlanetSoil = { weights: {}, nodes: 0 };

const BY_PLANET = new Map<string, PlanetSoil>();
for (const r of csvRows('planets.csv')) {
  const id = r.raw('id');
  if (!id) continue;
  const weights: Record<string, number> = {};
  for (const c of r.costList('soils')) {
    if (c.qty > 0) weights[c.defId] = (weights[c.defId] ?? 0) + c.qty;
  }
  const nodes = Math.max(0, Math.round(r.num('soilNodes', { min: 0, fallback: 0 })));
  BY_PLANET.set(id, Object.keys(weights).length > 0 && nodes > 0 ? { weights, nodes } : EMPTY);
}

/**
 * The soil this planet gives. No planet chosen (training range · an older peer) or an unknown id → null — **no soil pile is placed**
 * (there is no old behaviour to fall back to, as herbs have with "no planet = the old placement").
 */
export function planetSoil(planetId: string | null | undefined): PlanetSoil | null {
  if (!planetId) return null;
  const hit = BY_PLANET.get(planetId);
  return hit && hit.nodes > 0 ? hit : null;
}
