import * as THREE from 'three';
import type { Obstacle, WorldRef } from '@/shared';
import { BAY_HALF_W, BAY_HEIGHT, BAY_Z_MAX, BAY_Z_MIN, type Dropship } from './Ship';

/**
 * src/extraction/Hull.ts — **착륙한 탈출 함선의 몸통 콜라이더와 적 출입 금지 영역** (2026-09-13 탈출 개편).
 *
 * 이 파일이 답하는 질문: *벌레 · 로그가 왜 함선 외피를 뚫고 화물칸에 들어왔고, 이제 무엇이 막는가.*
 *
 * 함선은 메시만 있고 **월드 콜라이더가 하나도 없었다** — 적(과 총알 · 수류탄)에게 함선은 허공이었다. 이제 착륙하는 순간
 * 외피를 사각 콜라이더(`Obstacle.box`) 여덟 개로 `WorldRef.addObstacle` 에 등록하고, 함선이 **올라가기 시작할 때**
 * 걷는다. 움직이는 콜라이더로 만들지 않은 이유: 이륙 중 탑승자는 `setShipInterior` 상자 모드라 월드 충돌을 안 보지만,
 * 떠오르는 지붕 판은 발 + `BOX_HEADROOM` 창에 걸려 **옆으로 밀어내는** 쪽이라 두면 오히려 해롭다. 착륙해 있는 동안 함선은
 * 1 cm 흔들릴 뿐이므로 정지 콜라이더로 충분하다.
 *
 * 뒤쪽 램프 자리는 사람이 드나드는 구멍이라 콜라이더가 없다. 그 구멍을 **적에게만** 막는 것이 `keepEnemyOut` 이다 —
 * `resolveCollision` 은 누가 부르는지 모르므로 "적만" 은 월드 콜라이더로 표현할 수 없다. 화물칸 사각형(몸 반지름만큼
 * 부풀린)에 들어온 적은 **입구 쪽(로컬 +Z)으로만** 밀려 나간다: 옆 · 앞은 외피 콜라이더가 이미 막으므로, 옆으로 밀면
 * 벽 판 안으로 밀어 넣어 두 판정이 서로 싸운다.
 */

/** One hull box in ship-local space: centre (x, z), half extents, base above the deck origin (`y0`) and height. */
interface HullBox { x: number; z: number; halfX: number; halfZ: number; y0: number; h: number }

/*
 * Local −Z is the nose, the ramp faces +Z. Outline from `Ship.ts`: shell x ±2.1 (bay opening ±1.6), y −0.3..3.0,
 * z −6.6..0.6; nose + chin to z −9.7; nacelles at x ±4.2, z −3.2 (r ≈ 1.05, y 0.1..3.7).
 */
const HULL_BOXES: readonly HullBox[] = [
  { x: -1.85, z: -3.0, halfX: 0.25, halfZ: 3.6, y0: -0.3, h: 3.3 },      // left side slab (inner face x −1.6)
  { x: 1.85, z: -3.0, halfX: 0.25, halfZ: 3.6, y0: -0.3, h: 3.3 },       // right side slab
  { x: 0, z: -3.0, halfX: 2.1, halfZ: 3.6, y0: -0.3, h: 0.3 },           // belly — its top is the deck (getSurfaceY: corpses, grenades)
  { x: 0, z: -3.0, halfX: 2.1, halfZ: 3.6, y0: BAY_HEIGHT, h: 1.25 },    // roof + top deck + spine (bullets / camera; above a body's headroom)
  { x: 0, z: -5.95, halfX: 1.6, halfZ: 0.65, y0: -0.3, h: 3.3 },         // bay front wall → front cap (solid between them)
  { x: 0, z: -8.15, halfX: 1.45, halfZ: 1.55, y0: -0.3, h: 3.3 },        // nose + chin + cockpit
  { x: -4.2, z: -3.2, halfX: 1.0, halfZ: 1.0, y0: 0, h: 3.7 },           // left nacelle
  { x: 4.2, z: -3.2, halfX: 1.0, halfZ: 1.0, y0: 0, h: 3.7 },            // right nacelle
];

/** The doorway plane the enemy exclusion pushes out to (the ramp hinge sits at local z 0.25). */
const DOOR_Z = BAY_Z_MAX + 0.05;
/** Inner face of the side slabs. */
const BAY_INNER_HALF_W = BAY_HALF_W + 0.1;
/** Vertical band (above the deck origin) where a body counts as "in the bay". */
const BAY_Y_MIN = -1.2;

const _local = new THREE.Vector3();

export class ShipHull {
  private readonly obstacles: Obstacle[] = HULL_BOXES.map((b) => ({
    position: new THREE.Vector3(),
    radius: Math.hypot(b.halfX, b.halfZ),     // the circumscribed circle — `SpatialHash` buckets on it (`Obstacle.box` contract)
    height: b.h,
    box: { halfX: b.halfX, halfZ: b.halfZ, yaw: 0 },
  }));
  private removers: Array<() => void> = [];

  get registered(): boolean { return this.removers.length > 0; }

  /** Register the hull where the ship sits now (touchdown). Replaces a previous registration. */
  register(world: WorldRef | null, ship: Dropship): void {
    this.unregister();
    if (!world?.ready || typeof world.addObstacle !== 'function') return;
    const yaw = ship.yaw;
    const baseY = ship.getGroundY();   // not `root.y` — the landed ship bobs by a centimetre
    for (let i = 0; i < HULL_BOXES.length; i++) {
      const b = HULL_BOXES[i], o = this.obstacles[i];
      ship.bayToWorld(b.x, b.z, baseY + b.y0, o.position);
      // three.js rotation.y θ maps local +X to (cos θ, −sin θ); `Obstacle.box.yaw` is the math convention (cos, sin) → −θ
      o.box!.yaw = -yaw;
      this.removers.push(world.addObstacle(o));
    }
  }

  unregister(): void {
    for (const r of this.removers) r();
    this.removers.length = 0;
  }

  /** Is `p` (feet) inside the bay rectangle of a ship that is on / near the pad? */
  static inBay(ship: Dropship, p: THREE.Vector3, pad = 0): boolean {
    if (!ship.nearGround) return false;
    const l = ship.bayLocal(p, _local);
    return l.y > BAY_Y_MIN && l.y < BAY_HEIGHT
      && Math.abs(l.x) < BAY_INNER_HALF_W + pad && l.z < DOOR_Z + pad && l.z > BAY_Z_MIN - 0.1 - pad;
  }

  /**
   * Push an enemy body out through the doorway (see the file comment). The rectangle is grown by the body radius, so a
   * big body is kept clear of the opening, while one hugging the outside of a side slab (|x| ≥ 2.1 + r) never overlaps it.
   */
  static keepEnemyOut(ship: Dropship, p: THREE.Vector3, radius: number): boolean {
    if (!ship.nearGround) return false;
    const r = Math.max(0, radius);
    const l = ship.bayLocal(p, _local);
    if (l.y <= BAY_Y_MIN || l.y >= BAY_HEIGHT) return false;
    if (Math.abs(l.x) >= BAY_INNER_HALF_W + r) return false;
    if (l.z >= DOOR_Z + r || l.z <= BAY_Z_MIN - 0.1 - r) return false;
    ship.bayToWorld(l.x, DOOR_Z + r + 0.01, p.y, p);
    return true;
  }
}
