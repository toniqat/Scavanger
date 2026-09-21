import type * as THREE from 'three';
import type { Obstacle, ObstacleHull } from '@/shared';
import { hullRadiusFrom } from './hull';

/** Obstacle with internal bookkeeping (dedupe stamp for ray queries). */
export interface ObstacleEntry extends Obstacle {
  stamp: number;
  /** what created it — 'rock' | 'tree' | 'nest' | 'crate' | 'wall' | 'pole' | 'crystal' | 'debris' */
  kind: string;
  /** 2026-09-11 (world-internal): rays ignore it — a broken window frame (`structures/parts/Glass`). */
  passRays?: boolean;
  /** 2026-09-11 (world-internal): a body under `SMALL_BODY_R` (a throwable) is not pushed out — a broken frame. */
  passSmall?: boolean;
}

/**
 * Uniform grid spatial hash over XZ for cylinder obstacles.
 * Cells are `cellSize` meters; each obstacle is inserted into every cell its footprint overlaps.
 */
export class SpatialHash {
  private cells = new Map<number, ObstacleEntry[]>();
  private all: ObstacleEntry[] = [];
  private stampCounter = 1;
  maxRadius = 0;
  /**
   * 2026-09-21 (A-18): told the circle a collider covers whenever one is inserted, removed or **really** moved — the
   * nav graph (`nav/NavGraph.onHashChange`) re-measures the cells under it (a door opening, a barricade, the tram).
   * Null outside a baked raid, so every other world keeps paying nothing.
   */
  onChange: ((x: number, z: number, r: number) => void) | null = null;

  constructor(readonly cellSize = 16) {}

  private key(cx: number, cz: number): number {
    // pack two signed 16-bit ints
    return ((cx + 32768) << 16) | ((cz + 32768) & 0xffff);
  }

  insert(o: ObstacleEntry): void {
    this.all.push(o);
    this.onChange?.(o.position.x, o.position.z, o.radius);
    // 2026-09-08: bucket by the **larger** of the movement and shot cylinders. `query` still filters on `o.radius`,
    // so a wider bucketing changes nothing there — it only keeps `walkSegment` from missing a prop whose shot
    // cylinder reaches into a cell its collider does not.
    const rr = o.shotRadius !== undefined && o.shotRadius > o.radius ? o.shotRadius : o.radius;
    if (rr > this.maxRadius) this.maxRadius = rr;
    const s = this.cellSize;
    const x0 = Math.floor((o.position.x - rr) / s), x1 = Math.floor((o.position.x + rr) / s);
    const z0 = Math.floor((o.position.z - rr) / s), z1 = Math.floor((o.position.z + rr) / s);
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
      const k = this.key(cx, cz);
      let arr = this.cells.get(k);
      if (!arr) { arr = []; this.cells.set(k, arr); }
      arr.push(o);
    }
  }

  /** Remove a previously inserted entry from every cell and from `all` (Phase 3 dynamic obstacles). */
  remove(o: ObstacleEntry): void {
    const i = this.all.indexOf(o);
    if (i >= 0) this.all.splice(i, 1);
    this.onChange?.(o.position.x, o.position.z, o.radius);
    const s = this.cellSize;
    const rr = o.shotRadius !== undefined && o.shotRadius > o.radius ? o.shotRadius : o.radius;
    const x0 = Math.floor((o.position.x - rr) / s), x1 = Math.floor((o.position.x + rr) / s);
    const z0 = Math.floor((o.position.z - rr) / s), z1 = Math.floor((o.position.z + rr) / s);
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
      const arr = this.cells.get(this.key(cx, cz));
      if (!arr) continue;
      const j = arr.indexOf(o);
      if (j >= 0) arr.splice(j, 1);
    }
  }

  /**
   * @param shot optional `{ radius, height }` of the cylinder **bullets** stop at (`Obstacle.shotRadius/shotHeight`).
   *   Pass it whenever the collider is deliberately smaller or taller than what the prop looks like, so cover lines up
   *   with the silhouette; omit it and the ray uses the collider, as before.
   */
  add(position: THREE.Vector3, radius: number, height: number, kind: string, shot?: { radius: number; height: number }): ObstacleEntry {
    const e: ObstacleEntry = { position, radius, height, stamp: 0, kind };
    if (shot) { e.shotRadius = shot.radius; e.shotHeight = shot.height; }
    this.insert(e);
    return e;
  }

  /**
   * 2026-09-09 — **box (OBB) collider** (`Obstacle.box`): things a cylinder lies about, like a building wall or a
   * tram body. `radius` is filled with the circumscribed circle (`boxRadius`) as the contract demands, so bucketing ·
   * `overlaps` · `query` run exactly as before and only three places differ — push-out · ray · top face in
   * `WorldSystem`. `position.y` is the box's **bottom face** and it stands `height` up (a floating slab too).
   */
  addBox(position: THREE.Vector3, halfX: number, halfZ: number, yaw: number, height: number, kind: string): ObstacleEntry {
    const e: ObstacleEntry = {
      position, radius: Math.hypot(halfX, halfZ), height, stamp: 0, kind,
      box: { halfX, halfZ, yaw },
    };
    this.insert(e);
    return e;
  }

  /**
   * 2026-09-11 — **ramp floor plate** (`Obstacle.ramp`): a staircase. The same OBB as a box, its top face rising by
   * `rise` along local +X (`obb.rampTopAt`). `position.y` is the bottom face, `height` reaches the **high end**'s top.
   */
  addRamp(position: THREE.Vector3, halfX: number, halfZ: number, yaw: number, height: number, rise: number, kind: string): ObstacleEntry {
    const e = this.addBox(position, halfX, halfZ, yaw, height, kind);
    e.ramp = { rise: Math.max(0, Math.min(height, rise)) };
    return e;
  }

  /**
   * 2026-09-11 — **convex prism** (`Obstacle.hull`): rocks · spires · crystals · debris. `radius` is, as the contract
   * demands, the circle out to the farthest vertex from `position` (bands included), so bucketing · `overlaps` ·
   * `query` are unchanged. `position.y` is the bottom face, `height` reaches the drawn top face.
   */
  addHull(position: THREE.Vector3, hull: ObstacleHull, height: number, kind: string): ObstacleEntry {
    const e: ObstacleEntry = { position, radius: Math.max(0.05, hullRadiusFrom(hull, position.x, position.z)), height, stamp: 0, kind, hull };
    this.insert(e);
    return e;
  }

  /**
   * Moves a moving obstacle (the tram). It is re-bucketed only when the range of cells it covers changes — the same
   * trick as `TrainingArena.setTargetX`. The `position` object is reused as it is, so whatever references this entry
   * (the player's standing query · the mesh) has to re-acquire nothing.
   */
  move(o: ObstacleEntry, x: number, y: number, z: number, yaw?: number): void {
    // A parked tram · rover is moved to where it already is every frame — only a real move is news to the nav graph.
    if (this.onChange && (o.position.x !== x || o.position.y !== y || o.position.z !== z || (yaw !== undefined && o.box && o.box.yaw !== yaw))) {
      this.onChange(o.position.x, o.position.z, o.radius);
      this.onChange(x, z, o.radius);
    }
    const s = this.cellSize;
    const rr = o.shotRadius !== undefined && o.shotRadius > o.radius ? o.shotRadius : o.radius;
    const same =
      Math.floor((o.position.x - rr) / s) === Math.floor((x - rr) / s) &&
      Math.floor((o.position.x + rr) / s) === Math.floor((x + rr) / s) &&
      Math.floor((o.position.z - rr) / s) === Math.floor((z - rr) / s) &&
      Math.floor((o.position.z + rr) / s) === Math.floor((z + rr) / s);
    if (same) {
      o.position.set(x, y, z);
      if (yaw !== undefined && o.box) o.box.yaw = yaw;
      return;
    }
    this.remove(o);
    o.position.set(x, y, z);
    if (yaw !== undefined && o.box) o.box.yaw = yaw;
    this.insert(o);
  }

  getAll(): readonly ObstacleEntry[] { return this.all; }

  /**
   * Collect obstacles whose circle intersects the query circle. Appends to `out` (not cleared).
   * Deduplicated via stamps.
   */
  query(x: number, z: number, radius: number, out: ObstacleEntry[]): ObstacleEntry[] {
    const s = this.cellSize;
    const stamp = ++this.stampCounter;
    const x0 = Math.floor((x - radius) / s), x1 = Math.floor((x + radius) / s);
    const z0 = Math.floor((z - radius) / s), z1 = Math.floor((z + radius) / s);
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
      const arr = this.cells.get(this.key(cx, cz));
      if (!arr) continue;
      for (let i = 0; i < arr.length; i++) {
        const o = arr[i];
        if (o.stamp === stamp) continue;
        o.stamp = stamp;
        const dx = o.position.x - x, dz = o.position.z - z;
        const rr = radius + o.radius;
        if (dx * dx + dz * dz <= rr * rr) out.push(o);
      }
    }
    return out;
  }

  /** True if any obstacle overlaps the circle (fast early-out). */
  overlaps(x: number, z: number, radius: number): boolean {
    const s = this.cellSize;
    const x0 = Math.floor((x - radius) / s), x1 = Math.floor((x + radius) / s);
    const z0 = Math.floor((z - radius) / s), z1 = Math.floor((z + radius) / s);
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
      const arr = this.cells.get(this.key(cx, cz));
      if (!arr) continue;
      for (let i = 0; i < arr.length; i++) {
        const o = arr[i];
        const dx = o.position.x - x, dz = o.position.z - z;
        const rr = radius + o.radius;
        if (dx * dx + dz * dz <= rr * rr) return true;
      }
    }
    return false;
  }

  /** Visit each obstacle in the cells along an XZ segment (deduped). Callback returns true to stop early. */
  walkSegment(x0: number, z0: number, x1: number, z1: number, pad: number, visit: (o: ObstacleEntry) => boolean): void {
    const s = this.cellSize;
    const stamp = ++this.stampCounter;
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(len / s));
    const r = s * 0.75 + pad;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = x0 + dx * t, z = z0 + dz * t;
      const cx0 = Math.floor((x - r) / s), cx1 = Math.floor((x + r) / s);
      const cz0 = Math.floor((z - r) / s), cz1 = Math.floor((z + r) / s);
      for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) {
        const arr = this.cells.get(this.key(cx, cz));
        if (!arr) continue;
        for (let j = 0; j < arr.length; j++) {
          const o = arr[j];
          if (o.stamp === stamp) continue;
          o.stamp = stamp;
          if (visit(o)) return;
        }
      }
    }
  }

  clear(): void {
    this.cells.clear();
    this.all.length = 0;
    this.maxRadius = 0;
  }
}
