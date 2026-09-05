import type * as THREE from 'three';
import type { Obstacle } from '@/shared';

/** Obstacle with internal bookkeeping (dedupe stamp for ray queries). */
export interface ObstacleEntry extends Obstacle {
  stamp: number;
  /** what created it — 'rock' | 'tree' | 'nest' | 'crate' | 'wall' | 'pole' | 'crystal' | 'debris' */
  kind: string;
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

  constructor(readonly cellSize = 16) {}

  private key(cx: number, cz: number): number {
    // pack two signed 16-bit ints
    return ((cx + 32768) << 16) | ((cz + 32768) & 0xffff);
  }

  insert(o: ObstacleEntry): void {
    this.all.push(o);
    if (o.radius > this.maxRadius) this.maxRadius = o.radius;
    const s = this.cellSize;
    const x0 = Math.floor((o.position.x - o.radius) / s), x1 = Math.floor((o.position.x + o.radius) / s);
    const z0 = Math.floor((o.position.z - o.radius) / s), z1 = Math.floor((o.position.z + o.radius) / s);
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
    const s = this.cellSize;
    const x0 = Math.floor((o.position.x - o.radius) / s), x1 = Math.floor((o.position.x + o.radius) / s);
    const z0 = Math.floor((o.position.z - o.radius) / s), z1 = Math.floor((o.position.z + o.radius) / s);
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
      const arr = this.cells.get(this.key(cx, cz));
      if (!arr) continue;
      const j = arr.indexOf(o);
      if (j >= 0) arr.splice(j, 1);
    }
  }

  add(position: THREE.Vector3, radius: number, height: number, kind: string): ObstacleEntry {
    const e: ObstacleEntry = { position, radius, height, stamp: 0, kind };
    this.insert(e);
    return e;
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
