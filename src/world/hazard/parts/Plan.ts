/**
 * src/world/hazard/parts/Plan.ts — the hazard **draw** for this raid.
 *
 * Everything is a function of the mission seed: kind · start time · front direction · storm eye centre · spore
 * source spots. That is why there is no wire in normal play — every client that builds the same world from the
 * same seed gets the same plan (the same philosophy as `Fog`). Only a late joiner takes this plan by `hzq sync`.
 *
 * 2026-09-13 — **the kind is decided before the layout** (`drawHazardKind`): a spore raid puts the drop point · pads ·
 * source spots the other way round (central drop · central sources · outer pads). The kind draw is still the root rng's
 * `'hazard'` fork first draw and a fork never advances its parent, so **the same seed draws the same kind as before**.
 */
import {
  HAZARD_FRONT_SPAWN_JITTER_RAD, HAZARD_FULL_S, MAP_SIZE, SPORE_CENTER_GROVE_GAP_M, SPORE_CENTER_RADIUS_M,
  SPORE_GROVE_SPAWN_GAP_M, SPORE_GROWTH_MPS, SPORE_RADIUS_MAX, SPORE_SOURCES_MAX, SPORE_SOURCES_MIN,
  SPORE_SOURCE_INTERVAL_S, SPORE_START_S, type HazardKind, type Random,
} from '@/shared';
import { type BuildCtx, PLAY_LIMIT, isSpotFree } from '../../build';
import { padClearance } from '../../layout';
import { GROVE_RADIUS, type HazardPlan, type SporeSource, isFrontKind, pickStartSeconds } from '../model';

const HALF = MAP_SIZE / 2;

/** The root-rng fork name the hazard draw uses — `drawHazardKind` and `Hazard.build` must pass **the same name**. */
export const HAZARD_FORK = 'hazard';

/** A grove stands only this far from the drop point · extraction pads (nobody may land straight into the poison). */
const GROVE_PAD_CLEAR = 34;
/** Minimum gap (m) between groves. Bunched on one side, the other side stays a safe area to the end. */
const GROVE_MIN_GAP = 130;

/**
 * 2026-09-10 — **a sandstorm never comes to snow-covered terrain** (user's decision). It is swapped for the
 * blizzard, the other `front` hazard: zone · start time · travel direction stay, only the look
 * (`data/hazards.csv`) changes. No second draw happens, so **the same seed still gives the same plan**.
 * (Today's `data/planets.csv` lists only the blizzard on the tundra planet, so this rule never fires yet —
 *  it is nailed into the code so the rule holds if the csv changes or a new snow biome appears.)
 */
const SNOWY_BIOMES: ReadonlySet<string> = new Set(['tundra']);

/** One kind out of the candidates (the first draw of `rng` — no draw with a single candidate). null when empty. */
function pickKind(rng: Random, candidates: readonly HazardKind[], biomeId: string | null): HazardKind | null {
  if (candidates.length === 0) return null;
  const drawn = candidates.length === 1 ? candidates[0] : rng.pick(candidates);
  // Sandstorm on snow terrain → blizzard (`SNOWY_BIOMES` above). A swap after the draw, so seed reproducibility stays.
  return drawn === 'sandstorm' && biomeId !== null && SNOWY_BIOMES.has(biomeId) ? 'blizzard' : drawn;
}

/**
 * 2026-09-13 — draws only this raid's hazard kind, **before the layout**. `root` is the world's root rng and a fresh
 * `'hazard'` fork is made here — `planHazard` in `Hazard.build` makes the same first draw on the same fork, so the two
 * always answer the same. (On spores, `generateLayout` goes central drop · outer pads and `planGroveSpots` central.)
 */
export function drawHazardKind(root: Random, candidates: readonly HazardKind[], biomeId: string | null = null): HazardKind | null {
  return pickKind(root.fork(HAZARD_FORK), candidates, biomeId);
}

/**
 * **Giant mushroom grove spots**. On a planet whose candidates include `spores` they stand on the terrain whatever
 * hazard this raid drew — a grove is that planet's ecology, not a part of the hazard. So they use a **dedicated
 * fork**: the kind draw does not shift these spots.
 *
 * 2026-09-13: `central` = this raid is spores → the groves stand in the **map centre** (inside `SPORE_CENTER_RADIUS_M`,
 * outside `SPORE_GROVE_SPAWN_GAP_M` of the drop point). Spores spread outward, so the last safe area is by the outer pads.
 */
export function planGroveSpots(bctx: BuildCtx, rng: Random, central = false): Array<{ x: number; z: number }> {
  const want = Math.max(1, rng.int(SPORE_SOURCES_MIN, SPORE_SOURCES_MAX));
  return central ? placeCentralSources(bctx, rng, want) : placeSources(bctx, rng, want);
}

/**
 * Draws one of the candidates and builds this raid's plan. null when the candidates are empty (a hazard-free planet).
 *
 * `groveSpots` are the grove spots `planGroveSpots` already took — when `spores` is drawn those spots become the
 * sources as they are (user's request: spores bloom from the giant mushroom groves).
 *
 * `spawn` (2026-09-13) = the drop point. Given, the sandstorm · blizzard front enters **from the map edge the drop
 * point sits against** (± `HAZARD_FRONT_SPAWN_JITTER_RAD`). Without it (a smoke's `debugPlanFor`) the direction is
 * fully random as it used to be. The draw count is the same either way.
 *
 * `delayS` (2026-09-14, intel 「기상 예보」) = seconds added straight to the start time. Added **after the roll**, so the
 * draw count stays, and it applies to spores too, whose start time is fixed (`SPORE_START_S`) (user's decision: every hazard).
 */
export function planHazard(
  rng: Random, candidates: readonly HazardKind[], groveSpots: ReadonlyArray<{ x: number; z: number }>,
  biomeId: string | null = null, spawn: { x: number; z: number } | null = null, delayS = 0,
): HazardPlan | null {
  const kind = pickKind(rng, candidates, biomeId);
  if (kind === null) return null;

  // Spores alone have a fixed start time (user's request: 6 minutes). The rest fall between 6 and 8 minutes in 30 s steps.
  const rolled = kind === 'spores' ? SPORE_START_S : pickStartSeconds(rng.next());
  const startsAt = rolled + Math.max(0, Math.round(delayS));

  const plan: HazardPlan = {
    kind, startsAt,
    dirX: 0, dirZ: 0,
    eyeX: 0, eyeZ: 0,
    sources: [],
    sourceRadius: SPORE_RADIUS_MAX,
  };

  if (isFrontKind(kind)) {
    /* 2026-09-13 — the front enters from **the edge the drop point sits against**. The direction used to be fully random: a
     * minute after the start the drop point was behind the front only 2.7 % of the time, 25 % after two (measured over 2000
     * seeds — the storm eye is 47 % at the first instant). The front started outside the far side at about 2 m/s, so the raid
     * usually ended before it met the squad — that was "never having seen a sandstorm". Drop point = seed (`layout.spawn`), no wire. */
    const jitter = rng.range(-1, 1);
    let ang: number;
    if (spawn && Math.hypot(spawn.x, spawn.z) > HALF * 0.3) {
      // Direction from the edge the drop point sits against into the map (the front's travel direction = that edge's inward normal)
      const base = Math.abs(spawn.x) >= Math.abs(spawn.z)
        ? (spawn.x > 0 ? Math.PI : 0)
        : (spawn.z > 0 ? -Math.PI / 2 : Math.PI / 2);
      ang = base + jitter * HAZARD_FRONT_SPAWN_JITTER_RAD;
    } else {
      ang = (jitter + 1) * Math.PI;
    }
    plan.dirX = Math.cos(ang);
    plan.dirZ = Math.sin(ang);
    return plan;
  }

  if (kind === 'storm_eye') {
    // The eye centre stays inside the map's inner 60 % — against an edge the last safe area would be on a cliff.
    const r = HALF * 0.6 * Math.sqrt(rng.next());
    const ang = rng.range(0, Math.PI * 2);
    plan.eyeX = Math.cos(ang) * r;
    plan.eyeZ = Math.sin(ang) * r;
    return plan;
  }

  // ── Spores: the sources are the giant mushroom groves already taken ─────────────────────────
  // A seed that stood up no grove has nowhere for spores to bloom — this raid runs with no hazard.
  if (groveSpots.length === 0) return null;
  const spots = groveSpots;
  const radius = coverRadius(spots);
  plan.sourceRadius = Math.max(SPORE_RADIUS_MAX, radius);
  const full = plan.startsAt + HAZARD_FULL_S;
  plan.sources = spots.map((s, i) => {
    const eruptAt = plan.startsAt + i * SPORE_SOURCE_INTERVAL_S;
    // A source that blooms late must still grow fully within `HAZARD_FULL_S` or a safe area is left
    const growthMps = Math.max(SPORE_GROWTH_MPS, plan.sourceRadius / Math.max(1, full - eruptAt));
    const src: SporeSource = { x: s.x, z: s.z, eruptAt, growthMps };
    return src;
  });
  return plan;
}

/**
 * `want` source spots. It draws several candidates and keeps the one **furthest from those already placed**, a
 * best-of-k, so they never bunch up. A spot must be gentle and free (a grove stem becomes a collider) and must
 * keep its distance from the drop point · extraction pads as well.
 */
function placeSources(bctx: BuildCtx, rng: Random, want: number): Array<{ x: number; z: number }> {
  const out: Array<{ x: number; z: number }> = [];
  const limit = PLAY_LIMIT - GROVE_RADIUS - 6;
  for (let n = 0; n < want; n++) {
    let bestX = 0, bestZ = 0, bestScore = -Infinity;
    for (let a = 0; a < 260; a++) {
      const x = rng.range(-limit, limit), z = rng.range(-limit, limit);
      if (padClearance(bctx.layout, x, z, GROVE_PAD_CLEAR) < GROVE_RADIUS) continue;
      if (!isSpotFree(bctx, x, z, GROVE_RADIUS, { maxSlope: 0.28, padExtra: GROVE_PAD_CLEAR, limit })) continue;
      let near = Infinity;
      for (const p of out) near = Math.min(near, Math.hypot(p.x - x, p.z - z));
      if (near < GROVE_MIN_GAP && out.length > 0) near -= 1e6;   // a candidate that breaks the gap is effectively rejected
      if (near > bestScore) { bestScore = near; bestX = x; bestZ = z; }
    }
    if (bestScore === -Infinity) break;      // no spot left to place on this seed
    out.push({ x: bestX, z: bestZ });
  }
  return out;
}

/**
 * 2026-09-13 — the **central groves** of a spore raid. The same best-of-k as `placeSources`, but candidates are drawn
 * only inside a `SPORE_CENTER_RADIUS_M` disc around the map centre, must be outside `SPORE_GROVE_SPAWN_GAP_M` of the
 * drop point (`layout.spawn`, which is central), and the gap between groves is `SPORE_CENTER_GROVE_GAP_M`. With no spot
 * in the disc (a seed whose centre is taken by a structure · rail · nest) it retries at ×1.4 and ×1.8 the radius.
 */
function placeCentralSources(bctx: BuildCtx, rng: Random, want: number): Array<{ x: number; z: number }> {
  const out: Array<{ x: number; z: number }> = [];
  const limit = PLAY_LIMIT - GROVE_RADIUS - 6;
  const spawn = bctx.layout.spawn;
  for (let n = 0; n < want; n++) {
    let bestX = 0, bestZ = 0, bestScore = -Infinity;
    for (let pass = 0; pass < 3 && bestScore < 0; pass++) {
      const reach = Math.min(limit, SPORE_CENTER_RADIUS_M * (1 + pass * 0.4));
      for (let a = 0; a < 220; a++) {
        const ang = rng.range(0, Math.PI * 2);
        const r = reach * Math.sqrt(rng.next());
        const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
        if (Math.abs(x) > limit || Math.abs(z) > limit) continue;
        if (Math.hypot(x - spawn.x, z - spawn.z) < SPORE_GROVE_SPAWN_GAP_M) continue;
        if (padClearance(bctx.layout, x, z, GROVE_PAD_CLEAR) < GROVE_RADIUS) continue;
        if (!isSpotFree(bctx, x, z, GROVE_RADIUS, { maxSlope: 0.28, padExtra: GROVE_PAD_CLEAR, limit })) continue;
        let near = Infinity;
        for (const p of out) near = Math.min(near, Math.hypot(p.x - x, p.z - z));
        if (near < SPORE_CENTER_GROVE_GAP_M && out.length > 0) near -= 1e6;
        if (near > bestScore) { bestScore = near; bestX = x; bestZ = z; }
      }
    }
    if (bestScore === -Infinity) break;
    out.push({ x: bestX, z: bestZ });
  }
  return out;
}

/**
 * For this arrangement, **the distance from any point of the map to its nearest source**. Once every source has
 * grown this far no safe area is left. A 33×33 grid sample errs by about 8 m, so a clearance (+8 m) is added.
 */
function coverRadius(spots: ReadonlyArray<{ x: number; z: number }>): number {
  if (spots.length === 0) return 0;
  const N = 33;
  let worst = 0;
  for (let i = 0; i < N; i++) {
    const x = -HALF + (i / (N - 1)) * MAP_SIZE;
    for (let j = 0; j < N; j++) {
      const z = -HALF + (j / (N - 1)) * MAP_SIZE;
      let near = Infinity;
      for (const s of spots) {
        const d = Math.hypot(s.x - x, s.z - z);
        if (d < near) near = d;
      }
      if (near > worst) worst = near;
    }
  }
  return worst + MAP_SIZE / (N - 1);
}
