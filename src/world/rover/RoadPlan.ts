/**
 * src/world/rover/RoadPlan.ts — the **macro plan** of the rover's dirt road (R1, 2026-09-13).
 *
 * `generateLayout` calls it **right after the rail and the drop point, before every other placement** (`rng.fork('rover')`
 * — it does not advance the parent stream, so the rail and drop point draws are what they were before this change), and the
 * extraction pads · nests · ruins · craters · structures after it avoid the corridor (the same rule as the rail: first placed wins).
 *
 * The shape — n (4–5) stations go one per **even angular slot around the map centre** (± `ROVER_STATION_ANGLE_JITTER`), as far
 * apart as possible, and neighbours are joined by **polar interpolation** (angle linear, radius by smoothstep + a bend per stretch).
 * The angle always grows one way, so the loop **never crosses itself** (star-shaped about the centre). The radius stays ≥ `ROVER_RING_MIN_M`, so
 * - with a loop rail (a circle about the origin) that floor is raised to the rail ring + both corridors + `ROVER_RAIL_GAP_M` → **it does not cross the rail**.
 * - with a line rail (a segment through the origin) only points caught by `railFree` have their radius pushed (a repair) → again it does not cross.
 * So there is never a level crossing or a ramp to build (the plan discards those cases).
 *
 * A pure function — it does not use THREE.
 */
import {
  MAP_SIZE, RAIL_CLEARANCE_M, ROVER_MIN_TURN_RADIUS_M, ROVER_PLAN_ATTEMPTS, ROVER_PLAN_STEP_M, ROVER_POLE_OFFSET_M,
  ROVER_RAIL_GAP_M, ROVER_RING_MIN_M, ROVER_ROUTE_BOUND_M, ROVER_ROUTE_CLEARANCE_M, ROVER_ROUTE_WIGGLE_M,
  ROVER_SPAWN_GAP_M, ROVER_STATION_ANGLE_JITTER, ROVER_STATION_COUNT_MAX, ROVER_STATION_COUNT_MIN,
  ROVER_STATION_MIN_GAP_M, ROVER_STATION_PAD_R, numberList, type Random,
} from '@/shared';
import type { RoverPlan, RoverRoadIndex } from './model';

const TAU = Math.PI * 2;
/** The grid cell size (m) and the distance one cell holds (m). A caller's `clearance + extra` must be smaller than this to be exact (up to ~45 m). */
const INDEX_CELL = 24;
const INDEX_REACH = 64;
/** The order in which a caught point's radius is pushed (m) — nearest first. */
const REPAIR_OFFSETS = [4, -4, 8, -8, 12, -12, 18, -18, 26, -26, 36, -36, 48, -48, 62, -62];
/** How many attempts are made to place one station (within its angular slot). */
const STATION_TRIES = 16;
/**
 * The sample check's margin (m). The check runs at **points** `ROVER_PLAN_STEP_M` apart, but the corridor distance
 * (`roverRouteDistance`) looks at the **segments** between them — a 10 m chord grazing a 20 m circle (a platform pad + its corridor) cuts up to 0.6 m inside (0.55 m measured over 3000 seeds). This is that share.
 */
const CHORD_MARGIN = 1.5;

export interface RoadPlanInput {
  /** Does a spot of radius `extra` keep clear of the rail corridor and the platform pads (`generateLayout`'s `railFree`). */
  railFree: (x: number, z: number, extra: number) => boolean;
  /** The loop rail's radius. Null with no rail, or with a line rail. */
  railLoopExtent: number | null;
  /** The drop point's site. */
  spawn: { x: number; z: number; radius: number };
  /**
   * 2026-09-14 (the intel broker's 「탐사 차량 확정」): the attempt count is raised sharply to `ROVER_PLAN_ATTEMPTS_INTEL`. The
   * rolls turn inside their own fork, so outer streams are untouched, and a seed that normally succeeds **leaves on its first
   * success, so its result is unchanged too**. It can still fail (seeds where rail and drop point block the loop) — then it is simply null and the caller prints a warning.
   */
  forcePlan?: boolean;
}

/** The retry count for the intel broker's 「탐사 차량 확정」 (`data/tables.csv`). */
const PLAN_ATTEMPTS_INTEL = numberList('tables.csv', 'ROVER_PLAN_ATTEMPTS_INTEL')[0] ?? 1024;

interface Sample { th: number; r: number; fixed: boolean }

/** Builds the plan. Null when every attempt is spent without one (that raid has no rover). */
export function planRoverRoute(rng: Random, input: RoadPlanInput): RoverPlan | null {
  const C = ROVER_ROUTE_CLEARANCE_M;
  const padR = ROVER_STATION_PAD_R;
  const lo = Math.max(2, Math.round(ROVER_STATION_COUNT_MIN));
  const n = rng.int(lo, Math.max(lo, Math.round(ROVER_STATION_COUNT_MAX)));
  const rMin = input.railLoopExtent !== null
    ? Math.max(ROVER_RING_MIN_M, input.railLoopExtent + RAIL_CLEARANCE_M + C + ROVER_RAIL_GAP_M)
    : ROVER_RING_MIN_M;
  const spawn = input.spawn;
  const bound = ROVER_ROUTE_BOUND_M;
  const attempts = Math.max(1, input.forcePlan ? Math.max(ROVER_PLAN_ATTEMPTS, PLAN_ATTEMPTS_INTEL) : ROVER_PLAN_ATTEMPTS);
  let spawnGapRoute = 0, spawnGapStation = 0;

  const routeOk = (th: number, r: number): boolean => {
    if (r < rMin) return false;
    const x = Math.cos(th) * r, z = Math.sin(th) * r;
    if (Math.abs(x) > bound || Math.abs(z) > bound) return false;
    if (Math.hypot(x - spawn.x, z - spawn.z) < spawnGapRoute + CHORD_MARGIN) return false;
    return input.railFree(x, z, C + CHORD_MARGIN);
  };

  const slot = TAU / n;
  const jitter = Math.max(0, Math.min(0.45, ROVER_STATION_ANGLE_JITTER));
  for (let attempt = 0; attempt < attempts; attempt++) {
    /* The drop point clearance (`ROVER_SPAWN_GAP_M`) applies **only over the first half of the attempts**: when an edge drop
     * point shares a side with a line rail's end platform, the ~66 m between them cannot hold 「platform + corridor」 and 「drop
     * point + corridor + clearance」 at once (19 of 3000 seeds). Over the second half the clearance is 0 — the corridor itself still clears the drop site. */
    /* 2026-09-14: the threshold is half the **normal** attempt count — even when the intel broker raises the count, the
     * first `ROVER_PLAN_ATTEMPTS` rolls and judgements are identical to the letter (a seed that normally succeeded yields no other route). */
    const spawnGap = attempt < ROVER_PLAN_ATTEMPTS / 2 ? ROVER_SPAWN_GAP_M : 0;
    spawnGapRoute = spawn.radius + C + spawnGap;
    spawnGapStation = spawn.radius + padR + spawnGap;
    const a0 = rng.range(0, TAU);
    const th: number[] = [];
    const rs: number[] = [];
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < STATION_TRIES; k++) {
        const t = a0 + i * slot + rng.range(-jitter, jitter) * slot;
        const hi = (bound - padR) / Math.max(Math.abs(Math.cos(t)), Math.abs(Math.sin(t)));
        if (hi < rMin) continue;
        const r = rng.range(rMin, hi);
        const x = Math.cos(t) * r, z = Math.sin(t) * r;
        if (Math.hypot(x - spawn.x, z - spawn.z) < spawnGapStation) continue;
        if (!input.railFree(x, z, padR + 4)) continue;
        if (!routeOk(t, r)) continue;
        th.push(t); rs.push(r);
        break;
      }
      if (th.length !== i + 1) break;
    }
    if (th.length !== n) continue;

    let gapOk = true;
    for (let i = 0; i < n && gapOk; i++) {
      for (let j = i + 1; j < n; j++) {
        const d = Math.hypot(Math.cos(th[i]) * rs[i] - Math.cos(th[j]) * rs[j], Math.sin(th[i]) * rs[i] - Math.sin(th[j]) * rs[j]);
        if (d < ROVER_STATION_MIN_GAP_M) { gapOk = false; break; }
      }
    }
    if (!gapOk) continue;

    /* Stretch samples — a station's sample (`fixed`) never moves */
    const samples: Sample[] = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const t0 = th[i];
      const t1 = j === 0 ? th[0] + TAU : th[j];
      const r0 = rs[i], r1 = rs[j];
      const span = t1 - t0;
      const k = Math.max(3, Math.ceil(((r0 + r1) / 2) * span / Math.max(2, ROVER_PLAN_STEP_M)));
      const wig = rng.range(-ROVER_ROUTE_WIGGLE_M, ROVER_ROUTE_WIGGLE_M);
      for (let q = 0; q < k; q++) {
        const u = q / k;
        const e = u * u * (3 - 2 * u);
        samples.push({ th: t0 + span * u, r: r0 + (r1 - r0) * e + wig * Math.sin(Math.PI * u), fixed: q === 0 });
      }
    }

    /* Repair + smoothing: push the radius of a point caught in a corridor, then flatten the step with [1,2,1]/4 */
    const m = samples.length;
    const src = new Float64Array(m);
    for (let round = 0; round < 6; round++) {
      let bad = 0;
      for (const s of samples) {
        if (s.fixed || routeOk(s.th, s.r)) continue;
        bad++;
        for (const dr of REPAIR_OFFSETS) {
          if (routeOk(s.th, s.r + dr)) { s.r += dr; break; }
        }
      }
      if (bad === 0 && round > 0) break;
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < m; i++) src[i] = samples[i].r;
        for (let i = 0; i < m; i++) {
          if (samples[i].fixed) continue;
          samples[i].r = (src[(i - 1 + m) % m] + 2 * src[i] + src[(i + 1) % m]) / 4;
        }
      }
    }
    if (!samples.every((s) => routeOk(s.th, s.r))) continue;

    const points = samples.map((s) => ({ x: Math.cos(s.th) * s.r, z: Math.sin(s.th) * s.r }));
    if (minTurnRadius(points) < ROVER_MIN_TURN_RADIUS_M) continue;

    const stations: RoverPlan['stations'] = [];
    for (let i = 0; i < m; i++) {
      if (!samples[i].fixed) continue;
      const p = points[i];
      const a = points[(i - 1 + m) % m], b = points[(i + 1) % m];
      const tl = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      let nx = -(b.z - a.z) / tl, nz = (b.x - a.x) / tl;
      if (nx * p.x + nz * p.z < 0) { nx = -nx; nz = -nz; }        // outwards from the map
      stations.push({ x: p.x, z: p.z, poleX: p.x + nx * ROVER_POLE_OFFSET_M, poleZ: p.z + nz * ROVER_POLE_OFFSET_M });
    }
    return { points, stations, padRadius: padR, index: buildIndex(points) };
  }
  return null;
}

/** The smallest turn radius of a closed point list (m) — the circumradius of three consecutive points. */
export function minTurnRadius(pts: readonly { x: number; z: number }[]): number {
  const m = pts.length;
  let best = Infinity;
  for (let i = 0; i < m; i++) {
    const a = pts[(i - 1 + m) % m], b = pts[i], c = pts[(i + 1) % m];
    const ab = Math.hypot(b.x - a.x, b.z - a.z), bc = Math.hypot(c.x - b.x, c.z - b.z), ca = Math.hypot(a.x - c.x, a.z - c.z);
    const cross = Math.abs((b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x));
    if (cross < 1e-6) continue;
    const r = (ab * bc * ca) / (2 * cross);
    if (r < best) best = r;
  }
  return best;
}

function buildIndex(pts: readonly { x: number; z: number }[]): RoverRoadIndex {
  const half = MAP_SIZE / 2;
  const cols = Math.ceil(MAP_SIZE / INDEX_CELL);
  const cells: number[][] = [];
  for (let i = 0; i < cols * cols; i++) cells.push([]);
  const m = pts.length;
  const clampC = (v: number): number => Math.max(0, Math.min(cols - 1, Math.floor((v + half) / INDEX_CELL)));
  for (let i = 0; i < m; i++) {
    const a = pts[i], b = pts[(i + 1) % m];
    const c0 = clampC(Math.min(a.x, b.x) - INDEX_REACH), c1 = clampC(Math.max(a.x, b.x) + INDEX_REACH);
    const r0 = clampC(Math.min(a.z, b.z) - INDEX_REACH), r1 = clampC(Math.max(a.z, b.z) + INDEX_REACH);
    for (let cz = r0; cz <= r1; cz++) for (let cx = c0; cx <= c1; cx++) cells[cz * cols + cx].push(i);
  }
  return { cell: INDEX_CELL, cols, half, reach: INDEX_REACH, cells };
}

/**
 * The XZ distance (m) from `(x, z)` to the dirt road's **centreline**. At `index.reach` or beyond it returns
 * `reach` (nothing further is needed — callers only compare it against `clearance + radius`).
 */
export function roverRouteDistance(plan: RoverPlan, x: number, z: number): number {
  const ix = plan.index;
  const cx = Math.floor((x + ix.half) / ix.cell), cz = Math.floor((z + ix.half) / ix.cell);
  if (cx < 0 || cz < 0 || cx >= ix.cols || cz >= ix.cols) return ix.reach;
  const list = ix.cells[cz * ix.cols + cx];
  const pts = plan.points;
  const m = pts.length;
  let best2 = ix.reach * ix.reach;
  for (let k = 0; k < list.length; k++) {
    const a = pts[list[k]], b = pts[(list[k] + 1) % m];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 1e-6 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len2)) : 0;
    const px = a.x + dx * t - x, pz = a.z + dz * t - z;
    const d2 = px * px + pz * pz;
    if (d2 < best2) best2 = d2;
  }
  return Math.sqrt(best2);
}
