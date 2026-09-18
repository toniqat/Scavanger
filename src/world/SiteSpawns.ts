/**
 * src/world/SiteSpawns.ts — **site spawn spots** (2026-09-13, `WorldRef.getSiteSpawnPoints` · `getRuinSites`).
 *
 * The humanoid faction of the planet's threat (android · rogue · raider) occupies structures · rail platforms · POI
 * ruins. Which faction stands in how many groups is `enemies/`'s call; this file answers **where one can stand** only —
 * the host calls it a few times per site on `world:ready` (no per-frame cost).
 *
 * Two rules:
 *  - **Seed-deterministic**: the same map + the same arguments = the same spots. The rng is one
 *    `new Random(seed ^ Random.hash(siteId + place))` and not one step of the world generation rng is spent (the map
 *    layout is not shifted).
 *  - **Filtered by real world queries** — not by a guessed rectangle: `getSurfaceY` (feet first) → `resolveCollision`
 *    (pushed = dropped) → a `raycast` fired upwards (head clearance), in that order. The same order as
 *    `player/PlayerController` · `scripts/smoke-structure-reach`, so only cells a person can stand in are left.
 *
 * Indoor (`indoor`):
 *  - **Structures**: from one step inside the front door (`StructureNav.doorIn`) a body-radius flood fill (`BODY_R`, on
 *    a `FILL_STEP` grid, never leaving the building footprint) collects **the cells reachable on foot** — so the roof
 *    (a ladder) · the locked room (a door) · the inside of a wall never come in at all. A candidate is one of those
 *    cells that stands at a floor level height (`nav.levels[k]`), is inside the outer wall's inner face, has all eight
 *    points around the body on the same floor (dropping the edges of stair holes · basement stair holes), has no ramp
 *    collider (a staircase) under the body and is clear overhead. The basement is not a level height, so it drops out.
 *    The locked room rectangle (`nav.locked`) is subtracted once more, so it drops out even when computed after the
 *    door was opened. A crash-landed ship is the same (one level, footprint = the hull); no way in on foot → empty.
 *    A flood fill is heavy, so it is computed **once, the first time a site is asked**, and cached for the whole raid
 *    (`reset` empties it).
 *  - **Rail platforms**: inside the deck rectangle (the `rail_platform` half-lengths in `structures.csv`), standing at
 *    the deck's top face with no part of the body over its edge. Stairs · call console · containers drop out by collision.
 *  - **POI ruins**: inside the floor plate rectangle, inside the ring of wall cylinders, with no collision.
 *
 * Outdoor (`outdoor`): the seed rng sweeps the `OUT_NEAR`~`OUT_FAR` m band outside the footprint rectangle — inside the
 * map (`PLAY_LIMIT`) · outside the rail corridor (`railClearance`) · gentle ground · a spot with few obstacles
 * (`obstacleCoverage`) · no collision · outside any other structure / platform / ruin floor plate / extraction pad /
 * nest pad · on the ground (a surface barely lifted off the terrain).
 *
 * Picking (`pickClustered`): the candidates are shuffled by the seed and `count` is split into **clumps** of about four
 * — the first clump's anchor is the first candidate in shuffled order (the head of the array), the next anchor is the
 * candidate **farthest** from the anchors so far, and a clump fills **nearest-first** from its anchor while keeping
 * `minGap`. The spawn director asks for more than the sum of a place's group sizes and peels the first spot · the
 * farthest spot off as anchors, so a group clumps while the groups spread. The gap is a 3D distance, so another floor
 * is far away.
 *
 * ⚠ The distances written here (body radius · band width · grid) are **placement geometry**, not balance numbers (the
 * same kind as the building dimensions in `structures/model`).
 */
import * as THREE from 'three';
import {
  Random,
  type RailPlatformDef, type SiteSpawnPlace, type StructureDef, type TerrainHit,
} from '@/shared';
import { PLAY_LIMIT } from './build';
import { railClearance, roverClearance, type WorldLayout } from './layout';
import { hullAreaCentroid } from './hull';
import { boxContainsXZ } from './obb';
import type { OutpostSite } from './Outposts';
import { PLATFORM_RADIUS } from './Pads';
import type { ObstacleEntry, SpatialHash } from './SpatialHash';
import type { StructureNav } from './structures/parts/Build';
import { FLOOR_OVERHANG, WALL_T, structureRow } from './structures/model';

/** The body radius (m) — 0.45, the same as a person's body (`PLAYER_RADIUS`). A humanoid enemy (0.4) has room to spare. */
const BODY_R = 0.45;
/** The height (m) that has to be clear overhead — a humanoid's 1.8 + a hand's span. */
const HEADROOM = 1.9;
/** The flood fill grid (m) — the same as `smoke-structure-reach` (the size that tells a 0.8 m gap apart). */
const FILL_STEP = 0.3;
/** The cap on flood fill cells (one building = a few thousand cells). */
const FILL_CAP = 60000;
/** The indoor candidate grid = one per `CAND_EVERY` flood fill cells (0.6 m). */
const CAND_EVERY = 2;
/** The tolerance (m) for accepting a height as a floor level. */
const LEVEL_TOL = 0.05;
/** The distance (m) counted as having been pushed one step. */
const PUSH_TOL = 0.02;
/** The outdoor band: the distance (m) outside the footprint rectangle. */
const OUT_NEAR = 3;
const OUT_FAR = 14;
/** How many attempts look for outdoor candidates · how many to collect. */
const OUT_ATTEMPTS = 700;
const OUT_POOL_MIN = 28;
/** An outdoor spot: the max terrain slope · the obstacle area cap within `OUT_COVER_R` · the max lift (m) off the terrain. */
const OUT_MAX_SLOPE = 0.4;
const OUT_COVER_R = 1.6;
const OUT_MAX_COVER = 0.12;
const OUT_MAX_LIFT = 0.35;
/** An outdoor spot's clearance radius (m) — this body must be pushed by no collider (boxes included), so a group does not stand up against a wall · rock. */
const OUT_CLEAR_R = 1.2;
/** The distance (m) from the floor plate's edge to the inner face of the ruin wall cylinders (`Outposts` — radius 0.62 on the half-width − 0.6 line). */
const RUIN_WALL_INSET = 0.6 + 0.62;

/** The queries `WorldSystem` hands over (itself + its internal parts). */
export interface SiteSpawnSources {
  getHeightAt(x: number, z: number): number;
  getSurfaceY(x: number, z: number, feetY?: number): number;
  resolveCollision(position: THREE.Vector3, radius: number): THREE.Vector3;
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): TerrainHit | null;
  structureAt(x: number, z: number): StructureDef | null;
  slopeAt(x: number, z: number): number;
  layout(): WorldLayout | null;
  hash(): SpatialHash;
  structureDefs(): readonly StructureDef[];
  structureNav(id: string): StructureNav | null;
  platforms(): readonly RailPlatformDef[];
  ruins(): readonly OutpostSite[];
}

/** One site's local frame — local (lx, lz) → world `(cx + lx·cos − lz·sin, cz + lx·sin + lz·cos)` (structure · platform · ruin alike). */
interface Frame {
  id: string;
  cx: number; cz: number; cos: number; sin: number;
  /** The footprint half-lengths (what the outdoor band is measured from). */
  halfX: number; halfZ: number;
}

type SiteKind = 'structure' | 'platform' | 'ruin';

interface Site {
  kind: SiteKind;
  frame: Frame;
  structure?: { def: StructureDef; nav: StructureNav };
  platform?: RailPlatformDef;
  ruin?: OutpostSite;
}

const UP = new THREE.Vector3(0, 1, 0);
/** The eight directions around the body (cos, sin). */
const RING: readonly [number, number][] = Array.from({ length: 8 }, (_, i) => [Math.cos((i / 8) * Math.PI * 2), Math.sin((i / 8) * Math.PI * 2)]);

export class SiteSpawns {
  /** Site id → indoor candidates (world coordinates, a list independent of the seed). Kept for the whole raid. */
  private readonly indoorCache = new Map<string, THREE.Vector3[]>();
  private readonly p = new THREE.Vector3();
  private readonly o = new THREE.Vector3();
  private readonly near: ObstacleEntry[] = [];
  private readonly ac = { area: 0, x: 0, z: 0 };

  constructor(private readonly src: SiteSpawnSources) {}

  /** When the mission ends (`WorldSystem.clear`). */
  reset(): void { this.indoorCache.clear(); }

  /** `WorldRef.getSiteSpawnPoints` — the caller (`WorldSystem`) already filtered out the training range · pre-start. */
  points(siteId: string, place: SiteSpawnPlace, count: number, minGap: number, seed: number): THREE.Vector3[] {
    if (typeof siteId !== 'string' || !(count >= 1)) return [];
    if (place !== 'indoor' && place !== 'outdoor') return [];
    const site = this.resolve(siteId);
    if (!site) return [];
    const n = Math.floor(count);
    const gap = Number.isFinite(minGap) && minGap > 0 ? minGap : 0;
    const rng = new Random(((seed >>> 0) ^ Random.hash(siteId + place)) >>> 0);
    const cands = place === 'indoor' ? this.indoorOf(site) : this.outdoorOf(site, rng, n);
    return pickClustered(cands, n, gap, rng);
  }

  /* ── Finding the site ────────────────────────────────────────────── */

  private resolve(id: string): Site | null {
    const s = this.src;
    if (id.startsWith('struct_')) {
      const def = s.structureDefs().find((d) => d.id === id);
      const nav = def ? s.structureNav(id) : null;
      if (!def || !nav) return null;
      // The floor plate stands `FLOOR_OVERHANG` out past the wall — the outdoor band is measured from that plate's edge
      return { kind: 'structure', frame: frameOf(id, nav.cx, nav.cz, nav.yaw, nav.halfW + FLOOR_OVERHANG, nav.halfD + FLOOR_OVERHANG), structure: { def, nav } };
    }
    if (id.startsWith('outpost_')) {
      const ruin = s.ruins().find((r) => r.id === id);
      if (!ruin) return null;
      return { kind: 'ruin', frame: frameOf(id, ruin.position.x, ruin.position.z, ruin.yaw, ruin.slabHalfX, ruin.slabHalfZ), ruin };
    }
    const plat = s.platforms().find((p) => p.id === id);
    if (plat) {
      const { hx, hz } = platformHalf();
      return { kind: 'platform', frame: frameOf(id, plat.position.x, plat.position.z, plat.yaw, hx, hz), platform: plat };
    }
    return null;
  }

  /* ── Indoor ─────────────────────────────────────────────────────── */

  private indoorOf(site: Site): THREE.Vector3[] {
    const hit = this.indoorCache.get(site.frame.id);
    if (hit) return hit;
    const out = site.structure ? this.structureIndoor(site.frame, site.structure.def, site.structure.nav)
      : site.platform ? this.platformIndoor(site.frame, site.platform)
        : site.ruin ? this.ruinIndoor(site.frame, site.ruin) : [];
    this.indoorCache.set(site.frame.id, out);
    return out;
  }

  /** Structures: a body-radius flood fill from inside the front door → the cells of a floor level reachable on foot. */
  private structureIndoor(f: Frame, def: StructureDef, nav: StructureNav): THREE.Vector3[] {
    const s = this.src;
    const p = this.p;
    const I = Math.ceil(nav.halfW / FILL_STEP), J = Math.ceil(nav.halfD / FILL_STEP);
    const limX = nav.halfW - 0.1, limZ = nav.halfD - 0.1;
    /** The world XZ of cell (i, j). */
    const wx = (i: number, j: number): number => f.cx + i * FILL_STEP * f.cos - j * FILL_STEP * f.sin;
    const wz = (i: number, j: number): number => f.cz + i * FILL_STEP * f.sin + j * FILL_STEP * f.cos;
    const blocked = (x: number, y: number, z: number): boolean => {
      p.set(x, y, z);
      s.resolveCollision(p, BODY_R);
      return Math.hypot(p.x - x, p.z - z) >= PUSH_TOL;
    };

    const y0 = nav.levels[0];
    const si = Math.round(nav.doorIn[0] / FILL_STEP), sj = Math.round(nav.doorIn[1] / FILL_STEP);
    if (Math.abs(si) > I || Math.abs(sj) > J) return [];
    const sy = s.getSurfaceY(wx(si, sj), wz(si, sj), y0 + 0.3);
    if (blocked(wx(si, sj), sy, wz(si, sj))) return [];

    // flood fill — the key is (i, j, height in half spans). Each cell is judged exactly once.
    const key = (i: number, j: number, y: number): string => `${i},${j},${Math.round(y * 2)}`;
    const seen = new Set<string>([key(si, sj, sy)]);
    const bad = new Set<string>();
    const qi: number[] = [si], qj: number[] = [sj], qy: number[] = [sy];
    for (let head = 0; head < qi.length && qi.length < FILL_CAP; head++) {
      const i = qi[head], j = qj[head], y = qy[head];
      for (let d = 0; d < 4; d++) {
        const ni = i + (d === 0 ? 1 : d === 1 ? -1 : 0), nj = j + (d === 2 ? 1 : d === 3 ? -1 : 0);
        if (Math.abs(ni * FILL_STEP) > limX || Math.abs(nj * FILL_STEP) > limZ) continue;
        const x = wx(ni, nj), z = wz(ni, nj);
        const ny = s.getSurfaceY(x, z, y);
        const k = key(ni, nj, ny);
        if (seen.has(k) || bad.has(k)) continue;
        if (blocked(x, ny, z)) { bad.add(k); continue; }
        seen.add(k);
        qi.push(ni); qj.push(nj); qy.push(ny);
      }
    }

    // Floor level · inside the outer wall · outside the locked room · body ring on one floor · no stairs · head clearance
    const building = def.kind !== 'wreck';
    const inX = (building ? nav.halfW - WALL_T / 2 : nav.halfW) - BODY_R;
    const inZ = (building ? nav.halfD - WALL_T / 2 : nav.halfD) - BODY_R;
    const lock = nav.locked;
    const out: THREE.Vector3[] = [];
    for (let n = 0; n < qi.length; n++) {
      const i = qi[n], j = qj[n], y = qy[n];
      if (((i % CAND_EVERY) + CAND_EVERY) % CAND_EVERY !== 0 || ((j % CAND_EVERY) + CAND_EVERY) % CAND_EVERY !== 0) continue;
      const k = nav.levels.findIndex((lv) => Math.abs(y - lv) <= LEVEL_TOL);
      if (k < 0) continue;
      const lx = i * FILL_STEP, lz = j * FILL_STEP;
      if (Math.abs(lx) > inX || Math.abs(lz) > inZ) continue;
      if (lock && lock.k === k && lx > lock.x0 - 0.8 && lx < lock.x1 + 0.8 && lz > lock.z0 - 0.8 && lz < lock.z1 + 0.8) continue;
      const x = wx(i, j), z = wz(i, j);
      if (!this.bodyOnFloor(x, y, z)) continue;
      out.push(new THREE.Vector3(x, y, z));
    }
    return out;
  }

  /** Rail platforms: inside the deck rectangle, cells where the whole body stands on the deck's top face. */
  private platformIndoor(f: Frame, plat: RailPlatformDef): THREE.Vector3[] {
    const top = plat.position.y;
    const step = FILL_STEP * CAND_EVERY;
    const ex = f.halfX - BODY_R - 0.15, ez = f.halfZ - BODY_R - 0.15;
    const out: THREE.Vector3[] = [];
    for (let lx = -Math.floor(ex / step) * step; lx <= ex + 1e-6; lx += step) {
      for (let lz = -Math.floor(ez / step) * step; lz <= ez + 1e-6; lz += step) {
        const x = f.cx + lx * f.cos - lz * f.sin, z = f.cz + lx * f.sin + lz * f.cos;
        const y = this.src.getSurfaceY(x, z, top + 0.3);
        if (Math.abs(y - top) > LEVEL_TOL) continue;
        if (!this.collisionFree(x, y, z)) continue;
        if (!this.bodyOnFloor(x, y, z)) continue;
        out.push(new THREE.Vector3(x, y, z));
      }
    }
    return out;
  }

  /** POI ruins: inside the floor plate, inside the wall line, cells with no collision (the plate has no collider, so the terrain is walked). */
  private ruinIndoor(f: Frame, ruin: OutpostSite): THREE.Vector3[] {
    const step = FILL_STEP * CAND_EVERY;
    const ex = ruin.slabHalfX - RUIN_WALL_INSET - BODY_R, ez = ruin.slabHalfZ - RUIN_WALL_INSET - BODY_R;
    const out: THREE.Vector3[] = [];
    if (ex <= 0 || ez <= 0) return out;
    for (let lx = -Math.floor(ex / step) * step; lx <= ex + 1e-6; lx += step) {
      for (let lz = -Math.floor(ez / step) * step; lz <= ez + 1e-6; lz += step) {
        const x = f.cx + lx * f.cos - lz * f.sin, z = f.cz + lx * f.sin + lz * f.cos;
        if (Math.hypot(x - ruin.position.x, z - ruin.position.z) > ruin.radius) continue;
        const ground = this.src.getHeightAt(x, z);
        const y = this.src.getSurfaceY(x, z, ground + 0.3);
        if (y - ground > OUT_MAX_LIFT) continue;             // the ground, not the top of a drum · wreckage
        if (this.src.slopeAt(x, z) > OUT_MAX_SLOPE) continue;
        if (!this.collisionFree(x, y, z)) continue;
        if (!this.bodyOnFloor(x, y, z, 0.3)) continue;
        out.push(new THREE.Vector3(x, y, z));
      }
    }
    return out;
  }

  /* ── Outdoor ────────────────────────────────────────────────────── */

  private outdoorOf(site: Site, rng: Random, count: number): THREE.Vector3[] {
    const s = this.src;
    const layout = s.layout();
    if (!layout) return [];
    const f = site.frame;
    const selfStructure = site.structure?.def.id ?? null;
    const plats = s.platforms();
    const { hx: phx, hz: phz } = platformHalf();
    const ruins = s.ruins();
    const poolCap = Math.max(OUT_POOL_MIN, count * 6);
    const spanX = f.halfX + OUT_FAR, spanZ = f.halfZ + OUT_FAR;
    const out: THREE.Vector3[] = [];
    for (let a = 0; a < OUT_ATTEMPTS && out.length < poolCap; a++) {
      const lx = rng.range(-spanX, spanX), lz = rng.range(-spanZ, spanZ);
      const d = rectDistance(lx, lz, f.halfX, f.halfZ);
      if (d < OUT_NEAR || d > OUT_FAR) continue;
      const x = f.cx + lx * f.cos - lz * f.sin, z = f.cz + lx * f.sin + lz * f.cos;
      if (Math.abs(x) > PLAY_LIMIT || Math.abs(z) > PLAY_LIMIT) continue;
      if (railClearance(layout, x, z) < BODY_R) continue;
      if (roverClearance(layout, x, z) < BODY_R) continue;       // 2026-09-13: the rover dirt-road corridor · station sites
      if (s.slopeAt(x, z) > OUT_MAX_SLOPE) continue;
      // Not inside another site · landing pad · nest
      const st = s.structureAt(x, z);
      if (st && st.id !== selfStructure) continue;
      if (plats.some((pl) => pl.id !== f.id && insideRect(pl.position.x, pl.position.z, pl.yaw, phx + 2, phz + 2, x, z))) continue;
      if (ruins.some((r) => r.id !== f.id && insideRect(r.position.x, r.position.z, r.yaw, r.slabHalfX + 1, r.slabHalfZ + 1, x, z))) continue;
      if (layout.extraction.some((e) => Math.hypot(e.x - x, e.z - z) < PLATFORM_RADIUS + OUT_NEAR)) continue;
      if (layout.nests.some((nest) => Math.hypot(nest.x - x, nest.z - z) < nest.radius)) continue;
      const ground = s.getHeightAt(x, z);
      const y = s.getSurfaceY(x, z, ground + 0.3);
      if (y - ground > OUT_MAX_LIFT) continue;
      /* A spot with few obstacles: `obstacleCoverage` counts a box collider by its **circumscribed circle** and so
       * reads everything beside a building's floor plate (circle radius ≈ 15 m) as "full" — the ratio is therefore
       * used for circle · outline props only, and clearance including boxes is judged by a real collision test with a
       * wide body (`OUT_CLEAR_R`). */
      if (this.roundCoverage(x, z) > OUT_MAX_COVER) continue;
      if (!this.collisionFree(x, y, z, OUT_CLEAR_R)) continue;
      if (!this.bodyOnFloor(x, y, z, 0.6)) continue;
      out.push(new THREE.Vector3(x, y, z));
    }
    return out;
  }

  /* ── Shared judgements ─────────────────────────────────────────── */

  /** A body of radius `r` is not pushed (head clearance is `bodyOnFloor`'s job). */
  private collisionFree(x: number, y: number, z: number, r = BODY_R): boolean {
    const p = this.p.set(x, y, z);
    this.src.resolveCollision(p, r);
    return Math.hypot(p.x - x, p.z - z) < PUSH_TOL;
  }

  /**
   * The share of the `OUT_COVER_R` circle taken by **cylinder · convex outline** props — the same expression as
   * `WorldSystem.obstacleCoverage` with boxes taken out (counted by its circle a box is far larger than it is, and
   * everything beside a building reads as blocked — boxes are the collision test's business).
   */
  private roundCoverage(x: number, z: number): number {
    const near = this.near;
    near.length = 0;
    this.src.hash().query(x, z, OUT_COVER_R, near);
    let area = 0;
    for (let i = 0; i < near.length; i++) {
      const o = near[i];
      if (o.box) continue;
      if (o.hull) {
        hullAreaCentroid(o.hull.points, this.ac);
        area += circleOverlap(Math.hypot(this.ac.x - x, this.ac.z - z), OUT_COVER_R, Math.sqrt(Math.max(0, this.ac.area) / Math.PI));
      } else {
        area += circleOverlap(Math.hypot(o.position.x - x, o.position.z - z), OUT_COVER_R, o.radius);
      }
    }
    near.length = 0;
    return area / (Math.PI * OUT_COVER_R * OUT_COVER_R);
  }

  private headroom(x: number, y: number, z: number): boolean {
    return this.src.raycast(this.o.set(x, y + 0.1, z), UP, HEADROOM - 0.1) === null;
  }

  /**
   * All eight points around the body are on the same floor (within `tol`), there is no ramp collider (a staircase)
   * under the body, and it is clear overhead. Cells where the body hangs over a stair hole · basement stair hole ·
   * deck edge drop out here.
   */
  private bodyOnFloor(x: number, y: number, z: number, tol = LEVEL_TOL): boolean {
    const s = this.src;
    for (const [c, sn] of RING) {
      const py = s.getSurfaceY(x + c * BODY_R, z + sn * BODY_R, y + 0.3);
      if (Math.abs(py - y) > tol) return false;
    }
    const near = this.near;
    near.length = 0;
    s.hash().query(x, z, BODY_R + 0.2, near);
    for (let i = 0; i < near.length; i++) {
      const o = near[i];
      if (o.ramp && o.box && boxContainsXZ(o, x, z, BODY_R + 0.1)) { near.length = 0; return false; }
    }
    near.length = 0;
    return this.headroom(x, y, z);
  }
}

/* ── Pure helpers ─────────────────────────────────────────────────── */

function frameOf(id: string, cx: number, cz: number, yaw: number, halfX: number, halfZ: number): Frame {
  return { id, cx, cz, cos: Math.cos(yaw), sin: Math.sin(yaw), halfX, halfZ };
}

/** The platform deck half-lengths — the same line `Rails` builds with (including the 7 × 4.5 fallback in `rails/parts/Platform`). */
function platformHalf(): { hx: number; hz: number } {
  const row = structureRow('rail_platform');
  return { hx: row ? row.halfW : 7, hz: row ? row.halfD : 4.5 };
}

/** The area two circles overlap in (the same expression as `WorldSystem.obstacleCoverage`). */
function circleOverlap(d: number, r1: number, r2: number): number {
  if (r1 <= 0 || r2 <= 0 || d >= r1 + r2) return 0;
  if (d <= Math.abs(r1 - r2)) { const r = Math.min(r1, r2); return Math.PI * r * r; }
  const s1 = r1 * r1, s2 = r2 * r2;
  const a1 = Math.acos(Math.min(1, Math.max(-1, (d * d + s1 - s2) / (2 * d * r1))));
  const a2 = Math.acos(Math.min(1, Math.max(-1, (d * d + s2 - s1) / (2 * d * r2))));
  return s1 * (a1 - Math.sin(2 * a1) / 2) + s2 * (a2 - Math.sin(2 * a2) / 2);
}

/** The outside distance from the local point (lx, lz) to the origin-centred rectangle (±hx, ±hz) (0 when inside). */
function rectDistance(lx: number, lz: number, hx: number, hz: number): number {
  const dx = Math.max(0, Math.abs(lx) - hx), dz = Math.max(0, Math.abs(lz) - hz);
  return Math.hypot(dx, dz);
}

/** Is the world point (x, z) inside the (±hx, ±hz) rectangle of the (cx, cz, yaw) frame? */
function insideRect(cx: number, cz: number, yaw: number, hx: number, hz: number, x: number, z: number): boolean {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const dx = x - cx, dz = z - cz;
  return Math.abs(dx * c + dz * s) <= hx && Math.abs(-dx * s + dz * c) <= hz;
}

/** How many returned spots make one clump — the size of one humanoid group (1–4). */
const CLUMP = 4;

/**
 * **Clumped, then spread.** `count` is split into `floor(count / CLUMP)` clumps (at least 1):
 *  ① the first clump's anchor = the first candidate in seed-shuffled order (the **head** of the returned array),
 *  ② each next anchor = the candidate **farthest** from the anchors so far (among those at least `gap` away; ties keep
 *     the shuffled order),
 *  ③ every clump fills nearest-first (3D) from its anchor while keeping `gap` (the last clump takes the remainder).
 * The array is in clump order. The spawn director (`enemies/SiteGroups`) takes the first spot as the first group's
 * anchor and the spot farthest from the anchors so far as the next, then peels off what stands beside an anchor — so
 * each group becomes one clump spread around the site, and one group stands together.
 * The candidate array is left alone (it is the cache).
 */
function pickClustered(cands: readonly THREE.Vector3[], count: number, gap: number, rng: Random): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  if (cands.length === 0 || count <= 0) return out;
  const order = cands.map((_, i) => i);
  rng.shuffle(order);
  const rank = new Array<number>(cands.length);
  order.forEach((ci, r) => { rank[ci] = r; });
  const gap2 = gap * gap;

  // ①② Anchors — farthest-point sampling
  const clumps = Math.max(1, Math.floor(count / CLUMP));
  const anchors: number[] = [order[0]];
  while (anchors.length < clumps) {
    let best = -1, bestD = -1;
    for (const ci of order) {
      let d = Infinity;
      for (const a of anchors) d = Math.min(d, cands[ci].distanceToSquared(cands[a]));
      if (d < gap2 || d <= bestD) continue;
      bestD = d; best = ci;
    }
    if (best < 0) break;
    anchors.push(best);
  }

  // ③ Filling the clumps
  const per = Math.ceil(count / anchors.length);
  const taken = new Uint8Array(cands.length);
  anchors.forEach((a, k) => {
    const quota = k === anchors.length - 1 ? count - out.length : Math.min(per, count - out.length);
    if (quota <= 0) return;
    const base = cands[a];
    const byNear = order.slice().sort((x, y) => (cands[x].distanceToSquared(base) - cands[y].distanceToSquared(base)) || (rank[x] - rank[y]));
    let got = 0;
    for (const ci of byNear) {
      if (got >= quota) break;
      if (taken[ci]) continue;
      const c = cands[ci];
      let ok = true;
      for (let i = 0; i < out.length; i++) if (out[i].distanceToSquared(c) < gap2) { ok = false; break; }
      if (!ok) continue;
      taken[ci] = 1;
      out.push(c.clone());
      got++;
    }
  });
  return out;
}
