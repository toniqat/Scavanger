import * as THREE from 'three';
import {
  EXTRACTION_OUTER_MIN_M, EXTRACTION_PADS_MAX_BY_THREAT, EXTRACTION_PADS_MIN_BY_THREAT, EXTRACTION_PADS_SPORES_MAX,
  EXTRACTION_PADS_SPORES_MIN, MAP_SIZE, RAIL_CHANCE, Random, SPORE_SPAWN_CENTER_M, type RailKind, type StructureKind,
  /* 2026-09-13: the rover */
  ROVER_CHANCE, ROVER_ROUTE_CLEARANCE_M, ROVER_STATION_PAD_BLEND,
  /* 2026-09-14: the intel broker — the resolved form of the bought gimmicks (docs/DECISIONS.md 「2026-09-14 — 정보상」) */
  type IntelEffects, numberList,
} from '@/shared';
import { RAIL_CLEARANCE_M, STRUCTURE_ROWS, structureRow } from './structures/model';
import type { RoverPlan } from './rover/model';
import { planRoverRoute, roverRouteDistance } from './rover/RoadPlan';

/**
 * 2026-09-09 — `structure` (an abandoned structure's site) and `platform` (a rail platform) were added.
 * Both are spots the terrain **has to flatten**, so they are fixed first, in the macro layout stage.
 */
export type PadKind = 'spawn' | 'extraction' | 'nest' | 'poi' | 'structure' | 'platform'
  /* 2026-09-13: the rover station site */
  | 'station';

/** A flattened circular area blended into the heightfield. */
export interface Pad {
  kind: PadKind;
  x: number;
  z: number;
  radius: number;      // fully flat radius
  blend: number;       // smooth blend width beyond radius
  yaw: number;
  /** Assigned by Terrain once the heightfield is sampled. */
  height: number;
}

export interface Crater { x: number; z: number; radius: number; depth: number }
export interface Basin { x: number; z: number; radius: number; depth: number }

/**
 * 2026-09-09 — One abandoned structure's **site**. The terrain flattens this spot and digs out underneath it when
 * there is a basement (the step **after** pad flattening in `Terrain.build`). `world/Structures.ts` builds the house.
 */
export interface StructureSite {
  kind: StructureKind;
  pad: Pad;
  /** The building floor's half-length (m, on the pad's local axes). */
  halfW: number;
  halfD: number;
  wallH: number;
  /** The basement pit. null = no basement. Half-lengths on the local axes + the floor depth (m). */
  pit: { halfX: number; halfZ: number; depth: number } | null;
  /** Above-ground floors (2026-09-11) — 1 or 2. Either way it has a roof. */
  floors: number;
}

/**
 * 2026-09-09 — This map's rail plan. The real rail · tram are built by `world/Rails.ts`, reading the terrain height
 * (the rail does not flatten terrain — piers make up the height). Only **the shape and the platform spots** are here.
 */
export interface RailPlan {
  kind: RailKind;
  /** `loop` = the loop radius (m), `line` = the half-length from the centre to an end (m). */
  extent: number;
  /** `loop` = the ring's phase, `line` = the rail direction (rad). */
  angle: number;
  /** Platform spots written as a fraction (0..1) of the travel distance `s` along the rail. `Rails` resolves the point. */
  stops: number[];
  platforms: Pad[];
}

export interface WorldLayout {
  spawn: Pad;
  extraction: Pad[];
  nests: Pad[];
  pois: Pad[];
  pads: Pad[];          // all of the above
  craters: Crater[];
  basins: Basin[];
  /* appended (2026-09-09): raid play improvements */
  structures: StructureSite[];
  rail: RailPlan | null;
  /* appended (2026-09-13): the rover dirt-road plan (`rover/RoadPlan.ts`). null = no rover on this map */
  rover: RoverPlan | null;
}

const HALF = MAP_SIZE / 2;

function dist(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

function farFromAll(x: number, z: number, others: readonly { x: number; z: number }[], minD: number): boolean {
  for (const o of others) if (dist(x, z, o.x, o.z) < minD) return false;
  return true;
}

/** A point on `RailPlan`'s centreline (`t` = 0..1). **The same expression** `Rails.build` builds its point list with. */
function railPointAt(loop: boolean, extent: number, angle: number, t: number): { x: number; z: number } {
  return loop
    ? { x: Math.cos(angle + t * Math.PI * 2) * extent, z: Math.sin(angle + t * Math.PI * 2) * extent }
    : { x: Math.cos(angle) * (t * 2 - 1) * extent, z: Math.sin(angle) * (t * 2 - 1) * extent };
}

/**
 * The XZ distance from `(x, z)` to the rail **centreline**. Infinity when there is no rail.
 * `loop` is a closed circle, so point-to-circle; `line` is a segment through the origin, so point-to-segment.
 */
export function railDistance(rail: RailPlan | null, x: number, z: number): number {
  if (!rail) return Infinity;
  if (rail.kind === 'loop') return Math.abs(Math.hypot(x, z) - rail.extent);
  const dx = Math.cos(rail.angle), dz = Math.sin(rail.angle);
  const t = Math.max(-rail.extent, Math.min(rail.extent, x * dx + z * dz));
  return Math.hypot(x - dx * t, z - dz * t);
}

/**
 * The clearance (m) to the rail corridor — negative means **inside the corridor**, where nothing is placed (read by
 * `isSpotFree`). A platform is a rail facility and is not counted here (its spot is held by a `platform` pad in `layout.pads`).
 */
export function railClearance(layout: WorldLayout, x: number, z: number): number {
  return railDistance(layout.rail, x, z) - RAIL_CLEARANCE_M;
}

/**
 * 2026-09-13 — The clearance (m) to the rover dirt-road corridor · station sites. Negative means **inside a corridor ·
 * site**, where nothing is placed (read by `isSpotFree` · `SiteSpawns` — the same use as `railClearance`). Infinity
 * with no dirt road. The road-side value saturates at `RoverRoadIndex.reach − clearance` (nobody asks past that).
 */
export function roverClearance(layout: WorldLayout, x: number, z: number): number {
  const plan = layout.rover;
  if (!plan) return Infinity;
  let c = roverRouteDistance(plan, x, z) - ROVER_ROUTE_CLEARANCE_M;
  for (const s of plan.stations) {
    const d = dist(x, z, s.x, s.z) - plan.padRadius;
    if (d < c) c = d;
  }
  return c;
}

/**
 * 2026-09-13 — The macro layout knows the **hazard kind · planet threat**. Both are decided from the seed before the
 * layout (`WorldSystem.generate` — the hazard kind in `hazard/parts/Plan.drawHazardKind`'s own fork, the pad count in
 * `extractionPadCount`'s own fork), so multiplayer determinism is unchanged.
 */
export interface LayoutOptions {
  /** The extraction pad count (`extractionPadCount`). With none, the old 3. */
  extractionCount?: number;
  /**
   * Is this raid's hazard **toxic spores**? Spores spread from the map centre outwards, so the drop point stands in
   * the centre (`SPORE_SPAWN_CENTER_M`) and the extraction pads outside (`EXTRACTION_OUTER_MIN_M`) — the reverse of
   * every other hazard.
   */
  sporeLayout?: boolean;
  /**
   * 2026-09-14 (the intel broker) — the resolved form of the **fixed gimmicks** bought for this raid
   * (`ctx.missionIntel`). null = nothing was bought.
   *
   * ⚠ One rule decides everything: **the rng draw is consumed as it was and only the result is overwritten** (writing
   * `rng.chance(...)` as `if (force) … else rng.chance(...)` puts the stream out of step and gives not 「a map whose
   * basements alone differ」 but an entirely different map). A gimmick that raises a count (extraction pads · nests ·
   * platforms · structures) inevitably shifts the placement after it, but the preview
   * (`world/preview.planLayoutFor`) runs **the same function with the same values**, so the screen does not lie.
   */
  intel?: IntelEffects | null;
}

/** The bug nest count range — moved from a code constant (4–6) to `data/tables.csv` on 2026-09-14. */
const NEST_COUNT_MIN = numberList('tables.csv', 'NEST_COUNT_MIN')[0] ?? 4;
const NEST_COUNT_MAX = numberList('tables.csv', 'NEST_COUNT_MAX')[0] ?? 6;

/**
 * 2026-09-13 (user's decision) — the extraction pad count. Planet threat 1 = 2–3 · 2 = 2 · 3 = 1–2
 * (`EXTRACTION_PADS_MIN/MAX_BY_THREAT` in `tables.csv`); a toxic-spore raid is 2–3 whatever the threat
 * (`EXTRACTION_PADS_SPORES_*`). `rng` is a **dedicated fork** from the caller — one draw, so the layout stream stays.
 */
export function extractionPadCount(rng: Random, threat: number, spores: boolean): number {
  const i = Math.max(0, Math.min(2, Math.round(threat) - 1));
  const lo0 = spores ? EXTRACTION_PADS_SPORES_MIN : (EXTRACTION_PADS_MIN_BY_THREAT[i] ?? 3);
  const hi0 = spores ? EXTRACTION_PADS_SPORES_MAX : (EXTRACTION_PADS_MAX_BY_THREAT[i] ?? lo0);
  const lo = Math.max(1, Math.round(lo0));
  const hi = Math.max(lo, Math.round(hi0));
  return rng.int(lo, hi);
}

/** Place the macro layout: spawn, extraction pads, nests, POIs, craters, basins. Deterministic per rng. */
export function generateLayout(rng: Random, opts: LayoutOptions = {}): WorldLayout {
  const margin = 56; // keep pads away from the cliff wall
  const inner = HALF - margin;

  /* ── 2026-09-10: the rail is fixed **first of all** ──────────────────────────
   * The requirement is "nothing is placed inside the rail corridor", but the rail has one degree of freedom: `line` =
   * one direction, `loop` = one radius (both pass through the origin, and `Rails` uses `extent` · `angle` as given).
   * Drawing all twenty pads first and then finding an angle · radius that threads between them is in practice
   * impossible — one disc of radius 20 m blocks about 0.4 rad, so twenty of them pass π. So the order was reversed:
   * **the rail stands first and everything else avoids it** (`railFree`). The 2026-09-09 courtesy of "rolled after the
   * craters" for the sake of rng order ends here — the macro layout of the same seed differs from before this change
   * (multiplayer determinism is unchanged: everyone runs the same code on the same seed). */
  const intel = opts.intel ?? null;
  /* 2026-09-14 (the intel broker's 「궤도 운행」): the roll is **always** consumed; only a buyer overwrites it true. */
  const railRoll = rng.chance(RAIL_CHANCE);
  const railBonus = Math.max(0, Math.round(intel?.railPlatformBonus ?? 0));
  let rail: RailPlan | null = null;
  if (railRoll || railBonus > 0) {
    const platRow = structureRow('rail_platform');
    const stopCount = Math.max(2, platRow ? platRow.minCount : 2) + railBonus;
    const loop = rng.chance(0.5);
    const extent = loop ? inner * 0.62 : inner * 0.72;
    const angle = loop ? rng.range(0, Math.PI * 2) : (rng.chance(0.5) ? 0 : Math.PI / 2) + rng.range(-0.35, 0.35);
    const stops: number[] = [];
    for (let i = 0; i < stopCount; i++) stops.push(loop ? i / stopCount : i / (stopCount - 1));
    const platforms: Pad[] = stops.map((t) => {
      const p = railPointAt(loop, extent, angle, t);
      return { kind: 'platform' as PadKind, x: p.x, z: p.z, radius: 13, blend: 12, yaw: 0, height: 0 };
    });
    rail = { kind: (loop ? 'loop' : 'line') as RailKind, extent, angle, stops, platforms };
  }

  /** Does a spot of radius `extra` keep clear of the rail corridor · platform pads? */
  const railFree = (x: number, z: number, extra: number): boolean => {
    if (!rail) return true;
    if (railDistance(rail, x, z) < RAIL_CLEARANCE_M + extra) return false;
    for (const p of rail.platforms) if (dist(x, z, p.x, p.z) < p.radius + extra) return false;
    return true;
  };

  let spawn: Pad;
  if (opts.sporeLayout) {
    /* 2026-09-13 — A toxic-spore raid drops in the map's **centre** (spores spread from the centre outwards). A `line`
     * rail passes through the origin and its middle platform may stand there, so a hit on the corridor re-draws with a
     * slightly wider radius each time. */
    let sx = 0, sz = 0;
    for (let a = 0; a < 240; a++) {
      const reach = SPORE_SPAWN_CENTER_M + a * 0.75;
      const ang = rng.range(0, Math.PI * 2);
      const r = reach * Math.sqrt(rng.next());
      sx = Math.cos(ang) * r; sz = Math.sin(ang) * r;
      if (railFree(sx, sz, 18)) break;
    }
    spawn = { kind: 'spawn', x: sx, z: sz, radius: 18, blend: 22, yaw: rng.range(-Math.PI, Math.PI), height: 0 };
  } else {
    // Spawn near one edge (a hit on the rail corridor re-draws along that edge)
    const side = rng.int(0, 3);
    let along = rng.range(-inner * 0.6, inner * 0.6);
    const edgeDist = HALF - 64;
    const edgePoint = (a: number): { x: number; z: number } => (
      side === 0 ? { x: -edgeDist, z: a }
        : side === 1 ? { x: edgeDist, z: a }
          : side === 2 ? { x: a, z: -edgeDist }
            : { x: a, z: edgeDist });
    for (let a = 0; a < 60; a++) {
      const p = edgePoint(along);
      if (railFree(p.x, p.z, 18)) break;
      along = rng.range(-inner * 0.6, inner * 0.6);
    }
    const { x: sx, z: sz } = edgePoint(along);
    spawn = { kind: 'spawn', x: sx, z: sz, radius: 18, blend: 22, yaw: Math.atan2(-sx, -sz), height: 0 };
  }

  /* ── 2026-09-13: the rover dirt road — **right after** the rail · drop point, before other placement ───
   * It stands early for the rail's reason: the road is a ring all the way round the map, so drawn later it has nowhere
   * to dodge to. Its own fork does not shift the parent stream — the rail · drop point are as before this change, and
   * the placement after them differs because of the corridor check (`roverFree`) (accepted by the user).
   *
   * 2026-09-14 (user's decision): a **chance placement** like the rail (`ROVER_CHANCE`) — it used to be planned always,
   * measured at 100 %, which left the intel broker's 「탐사 차량 확정」 nothing to sell. ⚠ The roll is always consumed
   * as the **first draw inside the fork** and only the result is overwritten (written as
   * `if (force) … else roverRng.chance(…)`, a raid that has a rover and a raid that bought one get different station
   * positions, and the preview map lies). */
  const roverRng = rng.fork('rover');
  const roverRoll = roverRng.chance(ROVER_CHANCE);
  const roverForce = intel?.roverForce === true;
  const rover = (roverRoll || roverForce) ? planRoverRoute(roverRng, {
    railFree, railLoopExtent: rail && rail.kind === 'loop' ? rail.extent : null, spawn,
    // 2026-09-14 (the intel broker's 「탐사 차량」): only the attempt count rises — its own fork leaves the outer stream alone
    forcePlan: roverForce,
  }) : null;
  if (intel?.roverForce && !rover) console.warn('[world] 정보상 「탐사 차량 확정」 — 시도를 다 써도 흙길을 놓지 못했다 (이 레이드에는 차량이 없다)');
  /** Does a spot of radius `extra` keep clear of the dirt-road corridor · station sites? */
  const roverFree = (x: number, z: number, extra: number): boolean => {
    if (!rover) return true;
    if (roverRouteDistance(rover, x, z) < ROVER_ROUTE_CLEARANCE_M + extra) return false;
    for (const s of rover.stations) if (dist(x, z, s.x, s.z) < rover.padRadius + extra) return false;
    return true;
  };
  const stationPads: Pad[] = rover
    ? rover.stations.map((s) => ({
      kind: 'station' as PadKind, x: s.x, z: s.z, radius: rover.padRadius, blend: ROVER_STATION_PAD_BLEND, yaw: 0, height: 0,
    }))
    : [];

  /* Extraction pads: `opts.extractionCount` (2026-09-13 — the old fixed 3), pairwise >= 180 m, >= 150 m from spawn.
   * A toxic-spore raid puts them on the map's **outside** only (larger of x · z ≥ `EXTRACTION_OUTER_MIN_M`) — where the
   * spores arrive last. */
  const extraction: Pad[] = [];
  {
    const want = Math.max(1, Math.round(opts.extractionCount ?? 3));
    let minPair = 180, minSpawn = 150;
    let outer = opts.sporeLayout ? Math.min(EXTRACTION_OUTER_MIN_M, inner - 4) : 0;
    let attempts = 0;
    while (extraction.length < want) {
      attempts++;
      if (attempts % 400 === 0) { minPair *= 0.92; minSpawn *= 0.92; outer *= 0.96; } // relax slowly if unlucky
      const x = rng.range(-inner, inner), z = rng.range(-inner, inner);
      if (outer > 0 && Math.max(Math.abs(x), Math.abs(z)) < outer) continue;
      if (dist(x, z, spawn.x, spawn.z) < minSpawn) continue;
      if (!farFromAll(x, z, extraction, minPair)) continue;
      if (!railFree(x, z, 20)) continue;
      if (!roverFree(x, z, 22)) continue;
      extraction.push({ kind: 'extraction', x, z, radius: 20, blend: 26, yaw: rng.range(-Math.PI, Math.PI), height: 0 });
    }
  }

  // Nest clusters: `NEST_COUNT_MIN`–`NEST_COUNT_MAX` (+ the intel broker's 「벌레 둥지」 — added on top of the roll)
  const nests: Pad[] = [];
  {
    const bonus = Math.max(0, Math.round(intel?.nestBonus ?? 0));
    const n = rng.int(NEST_COUNT_MIN, NEST_COUNT_MAX) + bonus;
    let attempts = 0;
    // More to place raises the attempts with it — otherwise a bought nest silently vanishes for want of a spot (0 keeps the old value)
    const maxAttempts = 4000 + bonus * 3000;
    while (nests.length < n && attempts < maxAttempts) {
      attempts++;
      const x = rng.range(-inner + 10, inner - 10), z = rng.range(-inner + 10, inner - 10);
      if (dist(x, z, spawn.x, spawn.z) < 110) continue;
      if (!farFromAll(x, z, extraction, 62)) continue;
      if (!farFromAll(x, z, nests, 90)) continue;
      if (!railFree(x, z, 20)) continue;
      if (!roverFree(x, z, 26)) continue;
      nests.push({ kind: 'nest', x, z, radius: 20, blend: 24, yaw: rng.range(-Math.PI, Math.PI), height: 0 });
    }
  }

  // POIs (ruined outposts): 5–8
  const pois: Pad[] = [];
  {
    const n = rng.int(5, 8);
    let attempts = 0;
    while (pois.length < n && attempts < 4000) {
      attempts++;
      const x = rng.range(-inner + 8, inner - 8), z = rng.range(-inner + 8, inner - 8);
      if (dist(x, z, spawn.x, spawn.z) < 50) continue;
      if (!farFromAll(x, z, extraction, 48)) continue;
      if (!farFromAll(x, z, nests, 48)) continue;
      if (!farFromAll(x, z, pois, 70)) continue;
      if (!railFree(x, z, 13)) continue;
      if (!roverFree(x, z, 16)) continue;
      pois.push({ kind: 'poi', x, z, radius: 13, blend: 16, yaw: rng.range(-Math.PI, Math.PI), height: 0 });
    }
  }

  /* Platform pads go in **before the structures**: they cannot overlap (`railFree`), but `Terrain` flattens in array
   * order, so on the off chance they do the structure floor behind wins — better than a tilted indoor floor. */
  const pads = [spawn, ...extraction, ...nests, ...pois, ...(rail ? rail.platforms : []), ...stationPads];

  // Craters: 3–5, away from pads
  const craters: Crater[] = [];
  {
    const n = rng.int(3, 5);
    let attempts = 0;
    while (craters.length < n && attempts < 2000) {
      attempts++;
      const radius = rng.range(14, 30);
      const x = rng.range(-inner, inner), z = rng.range(-inner, inner);
      if (!farFromAll(x, z, pads, radius + 34)) continue;
      if (!farFromAll(x, z, craters, radius + 40)) continue;
      // The rail does not flatten terrain — crossing a crater only makes the piers longer and floats the track
      if (!railFree(x, z, radius)) continue;
      if (!roverFree(x, z, radius + 6)) continue;
      craters.push({ x, z, radius, depth: rng.range(4, 8) });
    }
  }

  // Basins: 2–3 broad gentle depressions
  const basins: Basin[] = [];
  {
    const n = rng.int(2, 3);
    let attempts = 0;
    while (basins.length < n && attempts < 1000) {
      attempts++;
      const x = rng.range(-inner, inner), z = rng.range(-inner, inner);
      if (!farFromAll(x, z, basins, 120)) continue;
      basins.push({ x, z, radius: rng.range(55, 90), depth: rng.range(3, 6) });
    }
  }

  /* ── 2026-09-09: abandoned structure sites ─────────────────────────────────
   * Rolled **after every crater · basin has been drawn**, so the rng the structures consume does not shift the draws
   * before them (the macro terrain shape of the same seed is as it was before this change). The new pads do go into
   * `pads`, though, so the spots of props · crates · enemy spawns that read `padClearance` change — which is right,
   * if a rock is not to stand inside a building. */
  const structures: StructureSite[] = [];
  {
    /* 2026-09-14 (the intel broker's 「지하 시설」 +N): **an outpost = a basement**, **a lab = a locked room on the
     * upper floor** (a lab has `basementChance` and `basementDepth` both 0 — forcing a pit gives an empty hole of
     * depth 0 with 0 containers. As `structures.csv`'s comment says, a lab's 「지하 시설」 is replaced by the locked
     * room upstairs, so that is what is fixed).
     *
     * 「+N」 really means **N more buildings stand** — overwriting the roll of one already placed leaves seeds where
     * the count does not move although money was paid, because the natural chance is high already (an outpost basement
     * 0.65 · a lab's upper floor 0.5) (measured). So it **goes past `maxCount` in the csv**: that cap is the limit of
     * natural placement, and the intel broker is the explicit exception one buys to open it. The share is split
     * between the two kinds (N=1 → outpost, N=2 → one outpost · one lab). The roll is consumed as it was and only the
     * result is overwritten. */
    const basementBonus = Math.max(0, Math.round(intel?.basementBonus ?? 0));
    const basementExtra: Partial<Record<StructureKind, number>> = {
      outpost: Math.ceil(basementBonus / 2),
      lab: Math.floor(basementBonus / 2),
    };
    for (const row of STRUCTURE_ROWS) {
      if (row.kind !== 'outpost' && row.kind !== 'lab' && row.kind !== 'wreck') continue;
      /** How many buildings on this row 「the intel broker bought」 — the last `forced` ones always have the facility. */
      const forced = basementExtra[row.kind] ?? 0;
      const want = (row.maxCount <= 0 ? 0 : rng.int(row.minCount, row.maxCount)) + forced;
      const reach = Math.hypot(row.halfW, row.halfD);
      let placed = 0;
      for (let a = 0; a < 3000 && placed < want; a++) {
        const x = rng.range(-inner + reach, inner - reach), z = rng.range(-inner + reach, inner - reach);
        if (dist(x, z, spawn.x, spawn.z) < row.minGap) continue;
        if (!farFromAll(x, z, extraction, 70)) continue;
        if (!farFromAll(x, z, nests, 80)) continue;
        if (!farFromAll(x, z, pois, 55)) continue;
        if (!farFromAll(x, z, structures.map((s) => s.pad), 110)) continue;
        if (!railFree(x, z, reach + 4)) continue;
        if (!roverFree(x, z, reach + 8)) continue;
        const pad: Pad = {
          kind: 'structure', x, z, radius: reach + 4, blend: 11,
          yaw: rng.range(-Math.PI, Math.PI), height: 0,
        };
        // Basements only under an outpost · lab (a crash-landed ship has nothing below). Dug 2.2 m inside the walls.
        // 2026-09-12: a lab's `basementChance` became 0, but **both enterable kinds always consume this draw** — with
        // the condition as `basementChance > 0` a lab skips one draw and every site · floor · structure draw after it shifts.
        const pitRoll = (row.kind === 'outpost' || row.kind === 'lab') && rng.chance(row.basementChance);
        // 2026-09-11: whether it has an upper floor. Rolled **last of all** — it must not shift the draws before it.
        const upperRoll = row.upperChance > 0 && rng.chance(row.upperChance);
        // 2026-09-14: the added buildings (the last `forced` ones) have that kind's facility for certain (the roll is spent already)
        const isForced = placed >= want - forced;
        const wantPit = row.basementDepth > 0 && (pitRoll || (isForced && row.kind === 'outpost'));
        const pit = wantPit && row.halfW > 3.4 && row.halfD > 3.4
          ? { halfX: row.halfW - 2.2, halfZ: row.halfD - 2.2, depth: row.basementDepth }
          : null;
        const floors = (upperRoll || (isForced && row.kind === 'lab')) ? 2 : 1;
        structures.push({ kind: row.kind, pad, halfW: row.halfW, halfD: row.halfD, wallH: row.wallH, pit, floors });
        placed++;
      }
    }
    for (const s of structures) pads.push(s.pad);
  }

  /* The rail plan was already fixed at the **very start** of this function (the 2026-09-10 comment above) — nothing
   * happens here. The platform pads are already in `pads` too. */

  return { spawn, extraction, nests, pois, pads, craters, basins, structures, rail, rover };
}

/** Distance from (x,z) to nearest pad edge (negative when inside a pad's flat radius). */
export function padClearance(layout: WorldLayout, x: number, z: number, extra = 0): number {
  let best = Infinity;
  for (const p of layout.pads) {
    const d = dist(x, z, p.x, p.z) - (p.radius + extra);
    if (d < best) best = d;
  }
  return best;
}

export function nearestPad(layout: WorldLayout, x: number, z: number, kinds?: readonly PadKind[]): { pad: Pad; d: number } | null {
  let best: Pad | null = null, bd = Infinity;
  for (const p of layout.pads) {
    if (kinds && !kinds.includes(p.kind)) continue;
    const d = dist(x, z, p.x, p.z);
    if (d < bd) { bd = d; best = p; }
  }
  return best ? { pad: best, d: bd } : null;
}

export const tmpV3 = new THREE.Vector3();
