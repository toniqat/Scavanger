/**
 * src/shared/fragile.ts — **깨지는 판(창문 유리)을 투척물이 깨고 지나가게** 하는 한 줄 (2026-09-11).
 *
 * 총알은 `weapons/` 의 기존 `hit.obstacle.destructible.onDamage` 경로로 유리를 깬다. 그런데 수류탄 · 투척 가젯 ·
 * 로그 수류탄은 레이가 아니라 `world.resolveCollision`(원 밀어내기)으로 부딪히므로 유리에서 **튕기기만** 한다.
 * 그 셋이 한 걸음마다 자기 비행 선분을 이 함수로 훑는다 — 세 폴더(weapons · gadgets · enemies)가 같은 규칙을 써야
 * 하므로 `shared` 에 둔다 (CLAUDE.md: 같은 것을 두 폴더가 쓰면 shared 로 뽑는다).
 *
 * 깨진 판은 world 가 곧바로 레이 · 작은 몸이 지나가는 창틀로 바꾸므로(`world/structures/parts/Glass`) 같은 걸음의
 * `resolveCollision` 은 더 이상 그것을 밀어내지 않는다 — 투척물은 속도를 잃지 않고 창을 뚫고 나간다.
 */
import * as THREE from 'three';
import type { WorldRef } from './types';

const _d = new THREE.Vector3();

/** `from → to` 선분 위의 깨지는 판을 전부 깬다 (최대 3 장). 하나라도 깼으면 true. */
export function breakFragileAlong(world: WorldRef, from: THREE.Vector3, to: THREE.Vector3): boolean {
  _d.subVectors(to, from);
  const len = _d.length();
  if (len < 1e-4) return false;
  _d.divideScalar(len);
  let broke = false;
  for (let i = 0; i < 3; i++) {
    const hit = world.raycast(from, _d, len + 0.05);
    const o = hit?.obstacle;
    if (!hit || !o || !o.fragile || !o.destructible) break;
    o.destructible.onDamage(1, hit.point);
    broke = true;
  }
  return broke;
}
