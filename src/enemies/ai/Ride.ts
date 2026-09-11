import * as THREE from 'three';
import { recordRideLocal, restoreRideLocal, rideContains, type WorldRef } from '@/shared';
import type { Enemy } from '../Enemy';

/* ────────────────────────────────────────────────────────────────────────────
 * 적 · 적 시체의 차량 탑승 (2026-09-11, C-18).
 *
 * 플레이어(`player/PlayerController.updateRide`)와 **같은 규약**이고 수학도 같은 `shared/ride.ts` 다 — CLAUDE.md
 * "탑승은 발판 프레임이 아니라 차량 부피로 판정한다":
 *   ① 진입만 발판 질의 — 서 있는 자리의 `getStandingObstacle` 이 `velocity` 를 가진 발판(전차 바닥)이면 잡는다.
 *   ② 유지는 차량 OBB + 헤드룸 (`rideContains`) — 경사 · 승강구 · 가장자리에서 발판 질의가 한 프레임 빠져도 내리지 않는다.
 *   ③ 이동은 지난 프레임의 자리를 차량 로컬 좌표로 적어 두었다가(`rideRecord`) 이번 프레임에 차량의 **지금** 변환으로
 *      다시 풀어 **차이만** 더한다(`rideCarry`). 스냅샷을 찍지 않고, 그 사이 남이 옮긴 몸(넉백 · 분리)은 지우지 않는다.
 * `Enemy.velocity` 는 끝까지 **로컬 속도**다 — 조향 · 보행 애니메이션 · 발소리가 전차 속도로 흔들리지 않는다.
 *
 * 전차 치임(world/ 담당)은 이 상태를 묻지 않는다: 전차 OBB 안에서 발이 데크 윗면 − `RIDE_FOOT_DROP` 위인 몸은
 * 치지 않는다는 합의라, 여기서 태운 몸은 저절로 빠진다.
 * ──────────────────────────────────────────────────────────────────────────── */

const _ride = new THREE.Vector3();

/**
 * 권위 `integrate` 의 적분 **앞**: 유지 검사 → (없으면) 진입 → 차량이 이번 프레임에 옮겨 간 만큼 몸을 옮긴다.
 * 진입한 프레임에는 옮기지 않는다 (차량은 이미 제자리다). 탑승 중이면 true.
 */
export function rideCarry(e: Enemy, world: WorldRef): boolean {
  const pos = e.position;
  if (e.carrier && !rideContains(e.carrier, pos)) rideRelease(e);
  if (!e.carrier) {
    const o = world.getStandingObstacle(pos.x, pos.z, pos.y);
    if (!o || !o.velocity) return false;
    e.carrier = o;
    rideRecord(e);
    return true;
  }
  restoreRideLocal(e.carrier, e.rideLocal, _ride);
  pos.x += _ride.x - e.rideWorld.x;
  pos.y += _ride.y - e.rideWorld.y;
  pos.z += _ride.z - e.rideWorld.z;
  return true;
}

/** 이번 프레임의 최종 자리를 차량 좌표로 다시 적어 둔다 (적분 · 충돌 · 표면 스냅이 끝난 뒤). */
export function rideRecord(e: Enemy): void {
  const c = e.carrier;
  if (!c) return;
  recordRideLocal(c, e.position, e.rideLocal);
  e.rideWorld.copy(e.position);
}

/** 하차 (관성 없음 — 적의 조향이 곧바로 제 속도로 되돌린다). */
export function rideRelease(e: Enemy): void {
  e.carrier = null;
}

/**
 * 시체 실어 나르기 (권위 · 리플리카 공통, `EnemySystem.update` 가 죽은 몸마다 매 프레임). 땅에 닿은(`deathLanded`)
 * 몸만 탄다. 차량 부피 밖으로 벗어나면 내리고 `deathLanded` 를 풀어 `integrateDeathFall` 이 땅까지 떨어뜨린다
 * (달리던 전차가 끝에서 돌아서며 모서리의 시체를 흘린 경우 — 허공에 떠 있지 않게). 몸이 움직였으면 true.
 */
export function carryCorpse(e: Enemy, world: WorldRef): boolean {
  if (!e.deathLanded) { if (e.carrier) rideRelease(e); return false; }
  const pos = e.position;
  if (e.carrier && !rideContains(e.carrier, pos)) {
    rideRelease(e);
    e.deathLanded = false; e.deathVy = 0;
    e.corpseDropped = true;   // the caller keeps the searchable spot on the body until it lands
    return false;
  }
  if (!e.carrier) {
    const o = world.getStandingObstacle(pos.x, pos.z, pos.y);
    if (!o || !o.velocity) return false;
    e.carrier = o;
    rideRecord(e);
    return false;
  }
  restoreRideLocal(e.carrier, e.rideLocal, _ride);
  const moved = Math.abs(_ride.x - e.rideWorld.x) + Math.abs(_ride.y - e.rideWorld.y) + Math.abs(_ride.z - e.rideWorld.z) > 1e-5;
  pos.x += _ride.x - e.rideWorld.x;
  pos.y += _ride.y - e.rideWorld.y;
  pos.z += _ride.z - e.rideWorld.z;
  rideRecord(e);
  return moved;
}

/**
 * 리플리카의 탑승 **예측** (C-18). 리플리카는 호스트 스냅샷을 `NET_INTERP_DELAY` 뒤에서 보간해 그리는데 전차는 각
 * 클라이언트가 동기화된 `s` 로 **지금** 자리를 굴린다 — 그래서 전차 위 적이 지연 × 전차 속도(최고 11.2 m/s)만큼
 * 뒤처져 데크 뒤로 미끄러져 보였다. `latest`(가장 새 샘플)를 그 뒤 흐른 시간만큼 차량 속도로 앞당긴 자리가 차량
 * 부피 안이면 탄 것으로 보고, 보간 자리 `out` 에 `차량 속도 × lag` 를 더한다. 오르내리며 튀지 않게 `rideBlend` 로
 * 0.15 초 남짓에 걸쳐 섞는다. 반환 = 이번 프레임에 차량이 몸을 옮긴 수평 속도 성분을 빼기 위한 차량 속도(없으면 null).
 */
export function replicaRidePredict(
  e: Enemy, world: WorldRef, latest: { t: number; x: number; y: number; z: number },
  now: number, lag: number, dt: number, out: THREE.Vector3,
): THREE.Vector3 | null {
  let c = e.carrier;
  const since = Math.max(0, now - latest.t);
  if (c && c.velocity) {
    _ride.set(latest.x + c.velocity.x * since, latest.y, latest.z + c.velocity.z * since);
    if (!rideContains(c, _ride)) c = null;
  }
  if (!c) {
    const o = world.getStandingObstacle(latest.x, latest.z, latest.y);
    c = o && o.velocity ? o : null;
  }
  e.carrier = c;
  const target = c ? 1 : 0;
  e.rideBlend += (target - e.rideBlend) * Math.min(1, dt * 8);
  if (e.rideBlend < 1e-3 && !c) { e.rideBlend = 0; return null; }
  const v = (c ?? e.lastCarrier)?.velocity;
  if (c) e.lastCarrier = c;
  if (!v) return null;
  out.x += v.x * lag * e.rideBlend;
  out.z += v.z * lag * e.rideBlend;
  return c ? v : null;
}
