/**
 * src/world/preview.ts — the pure path that computes **the layout only** (the intel broker's map preview, 2026-09-14).
 *
 * The intel broker's screen shows 「the area to buy」 blurred, over the real layout (user's decision). That means
 * running `generateLayout` alone with no mesh and no terrain, but **the stage in front of it** (hazard kind · biome ·
 * extraction pad count) was scattered through `WorldSystem.generate`. It is gathered here into one `planLayoutFor`,
 * which `generate` calls too — a preview and the real map split into two copies of the code make the screen lie
 * silently (CLAUDE.md 「previewing contents must equal opening」).
 *
 * ⚠ Stream convention: the root rng **does not advance one step** in this stage — the hazard kind is the first draw of
 * the `'hazard'` fork, and the layout · pad count each have their own fork (`Random.fork` never touches the parent).
 * So `generate` carries its own root rng untouched into the next stage (terrain · props).
 *
 * Does not use THREE.
 */
import { MAP_SIZE, Random, getPlanet, isPlanetId, planetThreat, type HazardKind, type IntelEffects, type MapPreviewLayout, type MapPreviewSpot, type PlanetId } from '@/shared';
import { type Biome, biomeById, pickBiome } from './biomes';
import { drawHazardKind } from './hazard/parts/Plan';
import { extractionPadCount, generateLayout, type Pad, type WorldLayout } from './layout';

/** The result of `generate`'s layout stage — the preview uses only this, and real generation continues from it. */
export interface LayoutPlan {
  seed: number;
  planet: PlanetId | null;
  biome: Biome;
  hazardKind: HazardKind | null;
  layout: WorldLayout;
}

/**
 * Plans the macro layout for this seed · planet · purchased intel. **Pure** — it builds no scene and no terrain.
 * Given a `root` it uses that rng (it only forks, so it does not advance); with none it makes a new one from the seed.
 */
export function planLayoutFor(seed: number, planet: PlanetId | null, intel: IntelEffects | null = null, root?: Random): LayoutPlan {
  const s = seed >>> 0;
  const id = isPlanetId(planet) ? planet : null;
  const def = getPlanet(id);
  const rng = root ?? new Random(s);
  // With a planet the palette is decided by data; with none it is a seed draw (existing behaviour, paired with core's sky draw)
  const biome = biomeById(def?.biome) ?? pickBiome(s);
  const hazardKind = drawHazardKind(rng, def?.hazards ?? [], biome.id);
  const sporeLayout = hazardKind === 'spores';
  const extractionCount = extractionPadCount(rng.fork('extractionPads'), planetThreat(id), sporeLayout)
    + Math.max(0, Math.round(intel?.extractionBonus ?? 0));   // the intel broker's 「탈출 지점」 — added on top of the roll
  const layout = generateLayout(rng.fork('layout'), { extractionCount, sporeLayout, intel });
  return { seed: s, planet: id, biome, hazardKind, layout };
}

const spot = (p: { x: number; z: number; radius?: number }, r = 0): MapPreviewSpot => ({ x: p.x, z: p.z, r: p.radius ?? r });
const spots = (list: readonly Pad[]): MapPreviewSpot[] => list.map((p) => spot(p));

/** The body of `WorldRef.previewLayout` — moves the plan into flat data the screen reads (no `world/` type leaks). */
export function previewLayoutFor(seed: number, planet: PlanetId | null, intel: IntelEffects | null = null): MapPreviewLayout {
  const plan = planLayoutFor(seed, planet, intel);
  const l = plan.layout;
  return {
    seed: plan.seed,
    planet: plan.planet,
    mapSize: MAP_SIZE,
    spawn: spot(l.spawn),
    extraction: spots(l.extraction),
    nests: spots(l.nests),
    pois: spots(l.pois),
    craters: l.craters.map((c) => ({ x: c.x, z: c.z, r: c.radius })),
    structures: l.structures.map((st) => ({
      x: st.pad.x, z: st.pad.z, r: st.pad.radius,
      kind: st.kind, basement: st.pit !== null, floors: st.floors,
    })),
    rail: l.rail ? { kind: l.rail.kind, extent: l.rail.extent, angle: l.rail.angle, platforms: spots(l.rail.platforms) } : null,
    rover: l.rover
      ? {
        stations: l.rover.stations.map((st) => ({ x: st.x, z: st.z, r: l.rover!.padRadius })),
        route: l.rover.points.map((p) => ({ x: p.x, z: p.z })),
      }
      : null,
    hazard: plan.hazardKind,
  };
}
