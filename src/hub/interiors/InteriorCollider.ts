import * as THREE from 'three';
import type { InteriorCollider, TerrainHit } from '@/shared';

/** Walkable rectangle of deck (XZ) with its floor and ceiling heights. Rooms may touch/overlap to form doorways. */
interface Room { minX: number; maxX: number; minZ: number; maxZ: number; floorY: number; ceilY: number }
/** Solid axis-aligned box (walls, props, consoles). */
interface Blocker { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number; enabled: boolean }

/** Height band of the player circle that blockers must overlap to count (feet .. chest). */
const BODY_MIN = 0.12;
const BODY_MAX = 1.5;
const EPS = 1e-4;

const _c = new THREE.Vector3();
const _n = new THREE.Vector3();

/**
 * Deterministic AABB interior collider: rooms = walkable union, blockers = solids.
 * `resolveCollision` pushes a circle out of blockers and back into the room union (doorways between touching
 * rooms stay open); `raycast` slab-tests blockers plus each room's floor / ceiling.
 * No per-frame allocation except the returned `TerrainHit` on a hit.
 */
export class BoxInteriorCollider implements InteriorCollider {
  private rooms: Room[] = [];
  private blockers: Blocker[] = [];
  private baseFloor = 0;
  readonly bounds = { center: new THREE.Vector3(), halfExtents: new THREE.Vector3(1, 1, 1) };

  addRoom(minX: number, maxX: number, minZ: number, maxZ: number, floorY = 0, ceilY = 3): void {
    this.rooms.push({ minX, maxX, minZ, maxZ, floorY, ceilY });
    this.refreshBounds();
  }

  /** Solid box by min/max corners. Returns the blocker index (see `setBlockerEnabled`). */
  addBlocker(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): number {
    const b: Blocker = {
      minX: Math.min(minX, maxX), maxX: Math.max(minX, maxX),
      minY: Math.min(minY, maxY), maxY: Math.max(minY, maxY),
      minZ: Math.min(minZ, maxZ), maxZ: Math.max(minZ, maxZ),
      enabled: true,
    };
    const reuse = this.free.pop();
    if (reuse !== undefined) { this.blockers[reuse] = b; return reuse; }   // bounds unchanged: furniture sits inside a room
    this.blockers.push(b);
    this.refreshBounds();
    return this.blockers.length - 1;
  }

  /** Solid box by centre + full size (y = bottom). Returns the blocker index. */
  addBox(cx: number, bottomY: number, cz: number, w: number, h: number, d: number): number {
    return this.addBlocker(cx - w / 2, bottomY, cz - d / 2, cx + w / 2, bottomY + h, cz + d / 2);
  }

  /** Toggle a blocker (pod doors open/close). */
  setBlockerEnabled(index: number, enabled: boolean): void {
    const b = this.blockers[index];
    if (b) b.enabled = enabled;
  }

  /**
   * Remove a dynamic blocker (placed furniture). The slot is disabled and recycled by the next `addBlocker`, so
   * indices handed out earlier stay valid.
   */
  removeBlocker(index: number): void {
    const b = this.blockers[index];
    if (!b) return;
    b.enabled = false;
    b.minX = b.maxX = b.minY = b.maxY = b.minZ = b.maxZ = 0;
    this.free.push(index);
  }

  private free: number[] = [];

  private refreshBounds(): void {
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const r of this.rooms) {
      minX = Math.min(minX, r.minX); maxX = Math.max(maxX, r.maxX);
      minZ = Math.min(minZ, r.minZ); maxZ = Math.max(maxZ, r.maxZ);
      minY = Math.min(minY, r.floorY); maxY = Math.max(maxY, r.ceilY);
    }
    for (const b of this.blockers) {
      minX = Math.min(minX, b.minX); maxX = Math.max(maxX, b.maxX);
      minY = Math.min(minY, b.minY); maxY = Math.max(maxY, b.maxY);
      minZ = Math.min(minZ, b.minZ); maxZ = Math.max(maxZ, b.maxZ);
    }
    if (!isFinite(minX)) return;
    this.bounds.center.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
    this.bounds.halfExtents.set((maxX - minX) / 2, (maxY - minY) / 2, (maxZ - minZ) / 2);
    if (this.rooms.length) this.baseFloor = this.rooms[0].floorY;
  }

  private roomAt(x: number, z: number): Room | null {
    for (const r of this.rooms) {
      if (x >= r.minX - EPS && x <= r.maxX + EPS && z >= r.minZ - EPS && z <= r.maxZ + EPS) return r;
    }
    return null;
  }

  getFloorAt(x: number, z: number): number {
    const r = this.roomAt(x, z);
    return r ? r.floorY : this.baseFloor;
  }

  resolveCollision(position: THREE.Vector3, radius: number): THREE.Vector3 {
    // 1) keep the circle inside the room union (edges shared with a neighbouring room are open)
    let room = this.roomAt(position.x, position.z);
    if (!room) {
      let best: Room | null = null, bestD = Infinity;
      for (const r of this.rooms) {
        const dx = Math.max(r.minX - position.x, 0, position.x - r.maxX);
        const dz = Math.max(r.minZ - position.z, 0, position.z - r.maxZ);
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = r; }
      }
      if (!best) return position;
      position.x = THREE.MathUtils.clamp(position.x, best.minX + radius, best.maxX - radius);
      position.z = THREE.MathUtils.clamp(position.z, best.minZ + radius, best.maxZ - radius);
      room = best;
    }
    if (position.x - radius < room.minX && !this.roomAt(position.x - radius, position.z)) position.x = room.minX + radius;
    if (position.x + radius > room.maxX && !this.roomAt(position.x + radius, position.z)) position.x = room.maxX - radius;
    if (position.z - radius < room.minZ && !this.roomAt(position.x, position.z - radius)) position.z = room.minZ + radius;
    if (position.z + radius > room.maxZ && !this.roomAt(position.x, position.z + radius)) position.z = room.maxZ - radius;

    // 2) push out of blockers (two passes so corners between two boxes settle)
    const yLo = position.y + BODY_MIN, yHi = position.y + BODY_MAX;
    for (let pass = 0; pass < 2; pass++) {
      for (const b of this.blockers) {
        if (!b.enabled || b.maxY < yLo || b.minY > yHi) continue;
        const cx = THREE.MathUtils.clamp(position.x, b.minX, b.maxX);
        const cz = THREE.MathUtils.clamp(position.z, b.minZ, b.maxZ);
        const dx = position.x - cx, dz = position.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= radius * radius) continue;
        if (d2 > 1e-8) {
          const d = Math.sqrt(d2);
          const push = radius - d;
          position.x += (dx / d) * push;
          position.z += (dz / d) * push;
        } else {
          // centre inside the box: exit through the nearest face
          const pl = position.x - b.minX, pr = b.maxX - position.x;
          const pb = position.z - b.minZ, pf = b.maxZ - position.z;
          const m = Math.min(pl, pr, pb, pf);
          if (m === pl) position.x = b.minX - radius;
          else if (m === pr) position.x = b.maxX + radius;
          else if (m === pb) position.z = b.minZ - radius;
          else position.z = b.maxZ + radius;
        }
      }
    }
    return position;
  }

  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): TerrainHit | null {
    let bestT = maxDist;
    let nx = 0, ny = 0, nz = 0;
    let hit = false;

    // blockers (slab test)
    for (const b of this.blockers) {
      if (!b.enabled) continue;
      let tmin = 0, tmax = bestT;
      let axisN = -1, axisSign = 0;
      let t1: number, t2: number;
      for (let axis = 0; axis < 3; axis++) {
        const o = axis === 0 ? origin.x : axis === 1 ? origin.y : origin.z;
        const d = axis === 0 ? dir.x : axis === 1 ? dir.y : dir.z;
        const lo = axis === 0 ? b.minX : axis === 1 ? b.minY : b.minZ;
        const hi = axis === 0 ? b.maxX : axis === 1 ? b.maxY : b.maxZ;
        if (Math.abs(d) < 1e-9) {
          if (o < lo || o > hi) { tmin = Infinity; break; }
          continue;
        }
        const inv = 1 / d;
        t1 = (lo - o) * inv; t2 = (hi - o) * inv;
        let sign = -1;
        if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; sign = 1; }
        if (t1 > tmin) { tmin = t1; axisN = axis; axisSign = sign; }
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) { tmin = Infinity; break; }
      }
      if (tmin === Infinity || tmin >= bestT || tmin <= 0 || axisN < 0) continue;
      bestT = tmin; hit = true;
      nx = axisN === 0 ? axisSign : 0; ny = axisN === 1 ? axisSign : 0; nz = axisN === 2 ? axisSign : 0;
    }

    // floors / ceilings
    for (const r of this.rooms) {
      if (dir.y < -1e-6) {
        const t = (r.floorY - origin.y) / dir.y;
        if (t > 0 && t < bestT) {
          const x = origin.x + dir.x * t, z = origin.z + dir.z * t;
          if (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ) { bestT = t; hit = true; nx = 0; ny = 1; nz = 0; }
        }
      } else if (dir.y > 1e-6) {
        const t = (r.ceilY - origin.y) / dir.y;
        if (t > 0 && t < bestT) {
          const x = origin.x + dir.x * t, z = origin.z + dir.z * t;
          if (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ) { bestT = t; hit = true; nx = 0; ny = -1; nz = 0; }
        }
      }
    }

    if (!hit) return null;
    _c.copy(dir).multiplyScalar(bestT).add(origin);
    _n.set(nx, ny, nz);
    return { point: _c.clone(), normal: _n.clone(), distance: bestT };
  }
}
