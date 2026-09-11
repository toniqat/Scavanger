import type * as THREE from 'three';
import { RIDE_EDGE_MARGIN, RIDE_FOOT_DROP, RIDE_HEADROOM } from './constants';
import type { Obstacle } from './types';

/* ── 차량 탑승 좌표 변환 (2026-09-10 player/PlayerController → 2026-09-11 shared, C-18) ─────────────────────
 * 플레이어 · 적 · 시체가 **같은 식**으로 움직이는 발판(`Obstacle.velocity` 가 있는 전차 데크)에 탄다. 규약은
 * CLAUDE.md "탑승은 발판 프레임이 아니라 차량 부피로 판정한다" 그대로다: 진입만 `getStandingObstacle` 로 하고,
 * 유지는 차량 OBB + 헤드룸(`rideContains`), 이동은 지난 프레임의 자리를 차량 로컬 좌표로 적어 두었다가
 * (`recordRideLocal`) 이번 프레임에 차량의 **지금** 변환으로 다시 푼다(`restoreRideLocal`). 스냅샷을 찍지 않는다.
 *
 * `Obstacle.box`(2026-09-09)는 `{halfX, halfZ, yaw}` 이고 `yaw` 는 수학 규약(로컬 +X → 월드 `(cos, sin)`)이다.
 * 상자가 없는(원기둥) 발판은 yaw 0 으로 취급하므로 같은 코드가 그대로 돈다. 전부 순수 함수이고 할당이 없다.
 * 옮기면서 동작은 한 줄도 바꾸지 않았다 — 기본 인자가 옛 `PlayerController` 의 상수 그대로다.
 */

/** 월드 좌표 → 차량 로컬 (`out.y` 는 **발판 윗면 기준** 높이). `out` 을 돌려준다. */
export function recordRideLocal(c: Obstacle, pos: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const yaw = c.box ? c.box.yaw : 0;
  const dx = pos.x - c.position.x, dz = pos.z - c.position.z;
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  return out.set(dx * cs + dz * sn, pos.y - (c.position.y + c.height), -dx * sn + dz * cs);
}

/** 차량 로컬 → 월드 (차량의 **지금** 변환으로 푼다). `pos` 를 돌려준다. */
export function restoreRideLocal(c: Obstacle, local: THREE.Vector3, pos: THREE.Vector3): THREE.Vector3 {
  const yaw = c.box ? c.box.yaw : 0;
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  return pos.set(
    c.position.x + local.x * cs - local.z * sn,
    c.position.y + c.height + local.y,
    c.position.z + local.x * sn + local.z * cs,
  );
}

/**
 * 아직 이 차량에 타고 있는가 — 차량 단면(+`edge`) 안이고 발판 윗면 기준 `[-footDrop, +headroom]` 높이 안일 때만.
 * `pos` 는 **발** 위치다. 기본값은 플레이어 규약(`RIDE_*`, `data/constants.csv`) — 몸 크기가 다른 쪽(대형 적)은
 * 인자로 넘긴다.
 */
export function rideContains(
  c: Obstacle, pos: THREE.Vector3,
  headroom: number = RIDE_HEADROOM, footDrop: number = RIDE_FOOT_DROP, edge: number = RIDE_EDGE_MARGIN,
): boolean {
  const top = c.position.y + c.height;
  if (pos.y > top + headroom || pos.y < top - footDrop) return false;
  const dx = pos.x - c.position.x, dz = pos.z - c.position.z;
  if (!c.box) return dx * dx + dz * dz <= (c.radius + edge) ** 2;
  const cs = Math.cos(c.box.yaw), sn = Math.sin(c.box.yaw);
  const lx = dx * cs + dz * sn, lz = -dx * sn + dz * cs;
  return Math.abs(lx) <= c.box.halfX + edge && Math.abs(lz) <= c.box.halfZ + edge;
}
