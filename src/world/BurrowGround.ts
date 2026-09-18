/**
 * src/world/BurrowGround.ts — **is this bare ground a sandworm can dig out of** (`WorldRef.burrowGroundOk`, 2026-09-15).
 *
 * The question this file answers: *is the `radius` m around `(x, z)` flat bare ground a sandworm can erupt from.*
 * The host's spawn-spot check (`enemies/sandworm/Director.validSpot`) and the thumper placement preview
 * (`gadgets/parts/Preview`) must use **the same judgement**, so it lives here alone (docs/DECISIONS.md 「2026-09-15 — 땅굴벌레」).
 *
 * ## Rules (all must pass for true)
 * 1. The whole circle is inside the map (the centre + both rings' samples).
 * 2. Terrain: over the `BURROW_GROUND_RING_SAMPLES` samples of the centre and the r · r/2 rings, highest − lowest ≤ `BURROW_GROUND_MAX_RISE_M`,
 *    and no sample's slope exceeds `BURROW_GROUND_MAX_SLOPE` (`Terrain.getSlopeAt`).
 * 3. Corridors: extraction pads (`padClearance`) · the rail (`railClearance`) · the dirt road + stations (`roverClearance`) do not overlap the circle.
 * 4. Structures: it overlaps no `StructureDef`'s `radius` circle.
 * 5. Spatial hash: not one collider overlaps the circle — rocks · trees · nest mounds · mushroom stems · the tram · crates · a landed extraction ship's hull ·
 *    dropped cover, all of it (crates and box colliders are read as their circumscribed circle — a generous filter).
 * 6. Not within `BURROW_GROUND_NEST_CLEAR_M` of a nest hole (the small mounds stand far from the hole).
 * 7. It overlaps no gather node and no crate (crates are in the hash too — both are checked).
 * 8. Hazard: no overlap with a toxic spore grove (the spots of `HazardRef.getSources()`, grove radius `GROVE_RADIUS`), and neither the centre
 *    nor a ring sample is inside the current damage zone (`HazardRef.isInside`).
 * The training range · the tutorial never call it (`WorldSystem` answers false outside planet mode).
 *
 * Allocation-free: sample coordinates are only computed, and hash queries land in a reused array.
 */
import type * as THREE from 'three';
import {
  BURROW_GROUND_MAX_RISE_M, BURROW_GROUND_MAX_SLOPE, BURROW_GROUND_NEST_CLEAR_M, BURROW_GROUND_RING_SAMPLES,
  type CrateDef, type GatherNodeDef, type HazardRef, type StructureDef,
} from '@/shared';
import { padClearance, railClearance, roverClearance, type WorldLayout } from './layout';
import { GROVE_RADIUS } from './hazard/model';
import type { ObstacleEntry } from './SpatialHash';

/** The read window `WorldSystem` fills in — the functions simply wrap that system's queries. */
export interface BurrowGroundQuery {
  heightAt(x: number, z: number): number;
  slopeAt(x: number, z: number): number;
  insideBounds(x: number, z: number): boolean;
  hashQuery(x: number, z: number, radius: number, out: ObstacleEntry[]): ObstacleEntry[];
  readonly layout: WorldLayout;
  readonly structures: readonly StructureDef[];
  readonly nestHoles: readonly THREE.Vector3[];
  readonly gather: readonly GatherNodeDef[];
  readonly crates: readonly CrateDef[];
  readonly hazard: HazardRef | null;
}

const hashOut: ObstacleEntry[] = [];
const TWO_PI = Math.PI * 2;

/** One sample's terrain check — false outside the map, inside the hazard zone, or over the slope. Heights accumulate into `acc`. */
function sampleOk(q: BurrowGroundQuery, x: number, z: number, acc: { min: number; max: number }): boolean {
  if (!q.insideBounds(x, z)) return false;
  if (q.hazard && q.hazard.active && q.hazard.isInside(x, z)) return false;
  if (q.slopeAt(x, z) > BURROW_GROUND_MAX_SLOPE) return false;
  const h = q.heightAt(x, z);
  if (h < acc.min) acc.min = h;
  if (h > acc.max) acc.max = h;
  return true;
}

const acc = { min: 0, max: 0 };

export function burrowGroundOk(q: BurrowGroundQuery, x: number, z: number, radius: number): boolean {
  const r = Math.max(0, radius);
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(r)) return false;

  // 1 · 2 · 8 (the zone): terrain samples
  acc.min = Infinity; acc.max = -Infinity;
  if (!sampleOk(q, x, z, acc)) return false;
  const n = Math.max(3, Math.round(BURROW_GROUND_RING_SAMPLES));
  for (let ring = 0; ring < 2; ring++) {
    const rr = ring === 0 ? r : r * 0.5;
    if (rr <= 0) continue;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TWO_PI + ring * (Math.PI / n);
      if (!sampleOk(q, x + Math.cos(a) * rr, z + Math.sin(a) * rr, acc)) return false;
    }
  }
  if (acc.max - acc.min > BURROW_GROUND_MAX_RISE_M) return false;

  // 3: corridors
  const layout = q.layout;
  if (padClearance(layout, x, z, r) < 0) return false;
  if (railClearance(layout, x, z) < r) return false;
  if (roverClearance(layout, x, z) < r) return false;

  // 4: structure footprints
  const structures = q.structures;
  for (let i = 0; i < structures.length; i++) {
    const s = structures[i];
    const dx = s.position.x - x, dz = s.position.z - z;
    const reach = s.radius + r;
    if (dx * dx + dz * dz < reach * reach) return false;
  }

  // 5: hash colliders (rocks · trees · mounds · stems · the tram · crates · the ship hull · cover)
  hashOut.length = 0;
  const hits = q.hashQuery(x, z, r, hashOut);
  for (let i = 0; i < hits.length; i++) {
    const o = hits[i];
    const dx = o.position.x - x, dz = o.position.z - z;
    const reach = o.radius + r;
    if (dx * dx + dz * dz < reach * reach) { hashOut.length = 0; return false; }
  }
  hashOut.length = 0;

  // 6: nest holes
  const holes = q.nestHoles;
  const nestReach = BURROW_GROUND_NEST_CLEAR_M + r;
  for (let i = 0; i < holes.length; i++) {
    const dx = holes[i].x - x, dz = holes[i].z - z;
    if (dx * dx + dz * dz < nestReach * nestReach) return false;
  }

  // 7: gather nodes · crates
  const gather = q.gather;
  for (let i = 0; i < gather.length; i++) {
    const dx = gather[i].position.x - x, dz = gather[i].position.z - z;
    const reach = r + 1;
    if (dx * dx + dz * dz < reach * reach) return false;
  }
  const crates = q.crates;
  for (let i = 0; i < crates.length; i++) {
    const dx = crates[i].position.x - x, dz = crates[i].position.z - z;
    const reach = r + 1;
    if (dx * dx + dz * dz < reach * reach) return false;
  }

  // 8: toxic spore groves (giant mushrooms — the stems are in the hash, but the whole grove is kept clear)
  const hz = q.hazard;
  if (hz) {
    const sources = hz.getSources();
    const reach = GROVE_RADIUS + r;
    for (let i = 0; i < sources.length; i++) {
      const dx = sources[i].position.x - x, dz = sources[i].position.z - z;
      if (dx * dx + dz * dz < reach * reach) return false;
    }
  }
  return true;
}
