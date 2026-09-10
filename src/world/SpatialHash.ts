import type * as THREE from 'three';
import type { Obstacle, ObstacleHull } from '@/shared';
import { hullRadiusFrom } from './hull';

/** Obstacle with internal bookkeeping (dedupe stamp for ray queries). */
export interface ObstacleEntry extends Obstacle {
  stamp: number;
  /** what created it — 'rock' | 'tree' | 'nest' | 'crate' | 'wall' | 'pole' | 'crystal' | 'debris' */
  kind: string;
  /** 2026-09-11 (world 내부): 레이가 무시한다 — 깨진 창틀 (`structures/parts/Glass`). */
  passRays?: boolean;
  /** 2026-09-11 (world 내부): 반지름 `SMALL_BODY_R` 미만의 몸(투척물)은 밀어내지 않는다 — 깨진 창틀. */
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

  constructor(readonly cellSize = 16) {}

  private key(cx: number, cz: number): number {
    // pack two signed 16-bit ints
    return ((cx + 32768) << 16) | ((cz + 32768) & 0xffff);
  }

  insert(o: ObstacleEntry): void {
    this.all.push(o);
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
   *   Pass it whenever the collider is deliberately smaller or taller than what the prop looks like, so 엄폐 lines up
   *   with the silhouette; omit it and the ray uses the collider, as before.
   */
  add(position: THREE.Vector3, radius: number, height: number, kind: string, shot?: { radius: number; height: number }): ObstacleEntry {
    const e: ObstacleEntry = { position, radius, height, stamp: 0, kind };
    if (shot) { e.shotRadius = shot.radius; e.shotHeight = shot.height; }
    this.insert(e);
    return e;
  }

  /**
   * 2026-09-09 — **사각(OBB) 콜라이더** (`Obstacle.box`): 건물 벽 · 전차 차체처럼 원기둥이 거짓말이 되는 것들.
   * `radius` 는 계약대로 외접원(`boxRadius`)으로 채워 두므로 버킷팅 · `overlaps` · `query` 는 예전 그대로
   * 돌아가고, 정확한 판정은 `WorldSystem` 의 밀어내기 · 레이 · 윗면 세 곳에서만 갈린다.
   * `position.y` 는 상자 **밑면**이고 `height` 만큼 위로 선다 (뜬 슬래브도 그대로 표현된다).
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
   * 2026-09-11 — **경사 발판** (`Obstacle.ramp`): 계단. 상자와 같은 OBB 이고 윗면이 로컬 +X 로 `rise` 만큼 올라간다
   * (`obb.rampTopAt`). `position.y` 는 밑면, `height` 는 **높은 쪽 끝**의 윗면까지다.
   */
  addRamp(position: THREE.Vector3, halfX: number, halfZ: number, yaw: number, height: number, rise: number, kind: string): ObstacleEntry {
    const e = this.addBox(position, halfX, halfZ, yaw, height, kind);
    e.ramp = { rise: Math.max(0, Math.min(height, rise)) };
    return e;
  }

  /**
   * 2026-09-11 — **볼록 다각형 기둥** (`Obstacle.hull`): 바위 · 첨탑 · 크리스탈 · 잔해. `radius` 는 계약대로
   * `position` 에서 가장 먼 꼭짓점(층 포함)까지의 외접원이라 버킷팅 · `overlaps` · `query` 는 그대로다.
   * `position.y` 는 밑면, `height` 는 그려진 윗면까지다.
   */
  addHull(position: THREE.Vector3, hull: ObstacleHull, height: number, kind: string): ObstacleEntry {
    const e: ObstacleEntry = { position, radius: Math.max(0.05, hullRadiusFrom(hull, position.x, position.z)), height, stamp: 0, kind, hull };
    this.insert(e);
    return e;
  }

  /**
   * 움직이는 장애물(전차)을 옮긴다. 덮는 셀 범위가 바뀔 때만 다시 버킷팅한다 — `TrainingArena.setTargetX`
   * 와 같은 수법이다. `position` 객체는 그대로 재사용하므로 이 항목을 참조하는 쪽(플레이어의 발판 질의 ·
   * 메시)은 아무것도 다시 잡을 필요가 없다.
   */
  move(o: ObstacleEntry, x: number, y: number, z: number, yaw?: number): void {
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
