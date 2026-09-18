/**
 * src/world/hazard/parts/Zones.ts — plan + `missionTime` → **zone shapes**.
 *
 * Everything `HazardRef.getZones()` returns comes from here. The convention is exactly what the contract
 * (`shared/types.HazardZone`) fixes:
 *
 *   - `front` = a half-plane. The front passes through `center`, its normal is `(dirX, dirZ)` = **the travel
 *     direction**, and **the side opposite the normal** (already passed) is dangerous. ui/'s map and safe-direction arrow read it so.
 *   - `circle` + `safeInside:true` = the storm eye. **Outside** the circle is dangerous.
 *   - `circle` + `safeInside:false` = spores. **Inside** the circle is dangerous.
 *
 * One array is reused (contract: "read it and use it at once"). The zone objects are reused too, so allocation per frame is 0.
 */
import {
  HAZARD_EDGE_M, HAZARD_FULL_S, MAP_SIZE, STORM_EYE_RADIUS_END, STORM_EYE_RADIUS_START, STORM_EYE_START_MARGIN_M, type HazardZone,
} from '@/shared';
import { type HazardPlan, isFrontKind } from '../model';

const HALF = MAP_SIZE / 2;
/**
 * Clearance (m) at both ends so the front starts outside the map and leaves outside it. Without it, at progress
 * 0 · 1 the front lands exactly on a corner (on an axis-aligned direction, **the whole edge**) with sign 0, and
 * "nothing is dangerous yet" and "no safe area is left" go out of step on that one line.
 */
const FRONT_MARGIN = HAZARD_EDGE_M > 0 ? HAZARD_EDGE_M : 8;

/** 0..1 — 1 means the map is fully covered. */
export function progressAt(plan: HazardPlan, missionTime: number): number {
  if (missionTime < plan.startsAt) return 0;
  if (HAZARD_FULL_S <= 0) return 1;
  const t = (missionTime - plan.startsAt) / HAZARD_FULL_S;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * 2026-09-13 (user's decision) — the storm eye's **start radius = the distance from the eye centre to the farthest map corner**
 * (+`STORM_EYE_START_MARGIN_M`). The whole map rectangle is therefore inside the circle (safe) at the first instant and narrows
 * from there over `HAZARD_FULL_S`. The old fixed 300 m swallowed 43 % of the map at once (47 % chance the drop point was inside).
 * `STORM_EYE_RADIUS_START` is a floor only. It is recomputed from the eye centre, not a `HazardPlan` field, so an old host's `hz sync` matches.
 */
export function stormEyeStartRadius(plan: Pick<HazardPlan, 'eyeX' | 'eyeZ'>): number {
  const far = Math.hypot(HALF + Math.abs(plan.eyeX), HALF + Math.abs(plan.eyeZ)) + STORM_EYE_START_MARGIN_M;
  return far > STORM_EYE_RADIUS_START ? far : STORM_EYE_RADIUS_START;
}

/** One blank zone (taken from the pool). */
function blank(id: string): HazardZone {
  return { id, shape: 'circle', center: { x: 0, z: 0 }, radius: 0, dirX: 0, dirZ: 0, safeInside: false };
}

/**
 * Fills `out` with this `missionTime`'s zones (length included). Empties it while the hazard has not started.
 * `pool` exists to reuse the zone objects and is the same array the caller keeps holding.
 */
export function buildZones(plan: HazardPlan, missionTime: number, pool: HazardZone[], out: HazardZone[]): void {
  out.length = 0;
  if (missionTime < plan.startsAt) return;
  const progress = progressAt(plan, missionTime);

  const take = (i: number, id: string): HazardZone => {
    while (pool.length <= i) pool.push(blank(`hz_${pool.length}`));
    const z = pool[i];
    z.id = id;
    return z;
  };

  if (isFrontKind(plan.kind)) {
    /* The front starts outside one side of the map and passes to outside the other over `HAZARD_FULL_S`.
     * `span` is the square map's half-width projected on the normal (+`FRONT_MARGIN`), so pushing s from
     * −span to +span leaves no dangerous point on the map at progress 0 and makes **everything** dangerous at
     * 1 (verified: 0 failures at both ends over 16 directions × a 17×17 sample). */
    const span = HALF * (Math.abs(plan.dirX) + Math.abs(plan.dirZ)) + FRONT_MARGIN;
    const s = -span + progress * 2 * span;
    const z = take(0, 'hz_front');
    z.shape = 'front';
    z.center.x = plan.dirX * s;
    z.center.z = plan.dirZ * s;
    z.radius = 0;
    z.dirX = plan.dirX;
    z.dirZ = plan.dirZ;
    z.safeInside = false;
    out.push(z);
    return;
  }

  if (plan.kind === 'storm_eye') {
    const z = take(0, 'hz_eye');
    z.shape = 'circle';
    z.center.x = plan.eyeX;
    z.center.z = plan.eyeZ;
    const r0 = stormEyeStartRadius(plan);
    z.radius = r0 + (STORM_EYE_RADIUS_END - r0) * progress;
    z.dirX = 0;
    z.dirZ = 0;
    z.safeInside = true;
    out.push(z);
    return;
  }

  // Spores: one circle per source that has already bloomed. One that has not has no zone (the map shows only the grove).
  for (let i = 0; i < plan.sources.length; i++) {
    const src = plan.sources[i];
    if (missionTime < src.eruptAt) continue;
    const grown = (missionTime - src.eruptAt) * src.growthMps;
    const r = grown < plan.sourceRadius ? grown : plan.sourceRadius;
    if (r <= 0.01) continue;
    const z = take(out.length, `hz_spore_${i}`);
    z.shape = 'circle';
    z.center.x = src.x;
    z.center.z = src.z;
    z.radius = r;
    z.dirX = 0;
    z.dirZ = 0;
    z.safeInside = false;
    out.push(z);
  }
}

/**
 * How far (m) `(x, z)` reaches into this zone's **danger area**. Negative means outside.
 * Both `isInside` and the edge feather look at this one alone.
 */
export function zoneDepth(z: HazardZone, x: number, dz: number): number {
  if (z.shape === 'front') {
    // Signed distance along the normal. Positive = still ahead of the front (safe), negative = already passed (dangerous)
    return -((x - z.center.x) * z.dirX + (dz - z.center.z) * z.dirZ);
  }
  const d = Math.hypot(x - z.center.x, dz - z.center.z);
  return z.safeInside ? d - z.radius : z.radius - d;
}

/** The greatest penetration depth (m) over every zone. Negative means inside no danger zone at all. */
export function maxDepth(zones: readonly HazardZone[], x: number, z: number): number {
  let best = -Infinity;
  for (let i = 0; i < zones.length; i++) {
    const d = zoneDepth(zones[i], x, z);
    if (d > best) best = d;
  }
  return best;
}
