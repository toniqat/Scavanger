import * as THREE from 'three';
import { ENEMY_FIRE_LOS_S, ENEMY_FIRE_STRAFE_S, ENEMY_WALL_STANDOFF } from '@/shared';
import type { Enemy, EnemyHost } from '../Enemy';
import type { CombatTarget } from '../Targets';

/* ────────────────────────────────────────────────────────────────────────────
 * 총구 사선 (2026-09-10) — 적이 벽에 딱 붙은 채로 사격하지 않게.
 *
 * 문제: 인지(`ai/Perception.hasLineOfSight`)는 **눈**에서 표적의 가슴으로 쏘는 레이다. 총알이 나가는 곳은
 * 눈이 아니라 총구(로그의 소총 끝 · 스퓨어의 입)라, 바위 · 벽 모서리에 몸을 붙이면 눈은 표적을 보는데 총구는
 * 벽 안에 박힌다 — 그 상태로 계속 사격 자세를 잡고 벽에다 쏘는 그림이 나왔다.
 *
 * 규약 세 가지:
 * 1. **사격만 보류한다.** 이동은 절대 막지 않는다 — 문 · 틈처럼 좁은 통로를 지나는 중이라 한순간 사선이
 *    막히는 것은 정상이고, 그때 AI 가 굳으면 훨씬 나쁘다. 막히면 쏘지 않고 `fireLineStrafe` 로 옆으로
 *    비켜서서 사선을 연다.
 * 2. **총구에서 `ENEMY_WALL_STANDOFF` 만큼 뒤로 물러난 지점에서** 레이를 쏜다. 총구가 이미 벽 안에 있으면
 *    총구에서 밖으로 쏜 레이는 벽을 만나지 않고 그냥 통과해 "뚫렸다" 가 되기 때문이다. 물러난 지점은 제 몸
 *    안이고 적은 월드 장애물이 아니므로 오검출이 없다. 이것이 "벽과 최소 거리를 둔다" 규칙의 실체이기도 하다.
 * 3. **핫 패스다.** 결과는 적별로 `ENEMY_FIRE_LOS_S` 동안 캐시한다 — 매 프레임 · 매 발마다 레이캐스트를 쏘지
 *    않는다. 표적이 바뀌면 `ai/Perception.acquireTarget` 이 캐시를 버린다. 스크래치 벡터는 모듈 하나를 돌려
 *    쓰므로 프레임당 할당이 없다.
 *
 * 지형 · 장애물만 본다 — 아군 오사(다른 적 관통)는 보지 않는다(사용자 결정).
 * 포병의 곡사 궤적은 직선이 아니라 이 검사가 아니라 `parts/Attacks.shellArcBlocked` 가 맡는다.
 * ──────────────────────────────────────────────────────────────────────────── */

/** 사선이 막힌 적이 옆으로 한 걸음 잡는 조향 목표까지의 거리(m). 그림/알고리즘 상수라 csv 대상이 아니다. */
const FIRE_STRAFE_STEP = 3.5;

const _o = new THREE.Vector3();
const _t = new THREE.Vector3();
const _d = new THREE.Vector3();

/** 총알/침이 실제로 나가는 지점. 스퓨어는 `ai/EnemyAI` 가 `headCenter + 0.1` 에서 산탄을 뱉는다. */
export function fireOrigin(e: Enemy, out: THREE.Vector3): THREE.Vector3 {
  if (e.type === 'spewer') { e.headCenter(out); out.y += 0.1; return out; }
  return e.muzzle(out);
}

/**
 * 총구 → 표적 가슴 사선이 뚫려 있는가. `ENEMY_FIRE_LOS_S` 주기로만 실제 레이캐스트를 쏘고 그 사이에는
 * `Enemy.fireLineClear` 를 그대로 돌려준다. 뚫려 있으면 진행 중이던 비켜서기(`fireBlockTimer`)를 끝낸다.
 */
export function hasFireLine(e: Enemy, host: EnemyHost, t: CombatTarget): boolean {
  const world = host.ctx.world;
  if (!world) return false;
  const now = host.ctx.time;
  if (now - e.fireLineAt < ENEMY_FIRE_LOS_S) return e.fireLineClear;
  e.fireLineAt = now;
  fireOrigin(e, _o);
  t.getChest(_t);
  _d.subVectors(_t, _o);
  const dist = _d.length();
  if (dist < 1e-3) { e.fireLineClear = true; e.fireLineGap = Infinity; e.fireBlockTimer = 0; return true; }
  _d.multiplyScalar(1 / dist);
  // 총구보다 ENEMY_WALL_STANDOFF 뒤(제 몸 안)에서 출발한다 — 위 규약 2.
  _o.addScaledVector(_d, -ENEMY_WALL_STANDOFF);
  const hit = world.raycast(_o, _d, dist + ENEMY_WALL_STANDOFF - 0.3);
  // 막은 물체까지의 거리를 **총구 기준**으로 기록한다(음수 = 총구가 이미 그 안이다).
  e.fireLineGap = hit ? hit.distance - ENEMY_WALL_STANDOFF : Infinity;
  e.fireLineClear = hit === null;
  if (e.fireLineClear) e.fireBlockTimer = 0;
  return e.fireLineClear;
}

/**
 * 사선이 막혔을 때의 답: 제자리에서 조준만 하고 있지 말고 **옆으로 비켜선다**. 표적을 계속 바라보면서
 * 표적 방향의 수직으로 `FIRE_STRAFE_STEP` 만큼 조향 목표를 잡고, 총구가 이미 장애물 안이면
 * (`fireLineGap` 이 `ENEMY_WALL_STANDOFF` 보다 가깝다) 표적 반대쪽으로도 조금 떼어 놓는다.
 *
 * 반환값 = 이번 비켜서기 다리가 아직 남았는가. `false` 면 `ENEMY_FIRE_STRAFE_S` 동안 옆으로 걸었는데도
 * 못 뚫은 것이므로 호출부가 다른 계획을 세운다(로그는 새 엄폐물, 스퓨어는 반대쪽, 포병은 자리 이동).
 * **이동을 멈추지 않는다** — `hasMoveTarget` 을 세워 두므로 `integrate` 는 평소대로 걷는다.
 */
export function fireLineStrafe(e: Enemy, host: EnemyHost, t: CombatTarget, dt: number): boolean {
  if (e.fireBlockTimer <= 0) { e.fireBlockTimer = ENEMY_FIRE_STRAFE_S; e.fireStrafeSign = -e.fireStrafeSign as 1 | -1; }
  e.fireBlockTimer -= dt;
  e.facePoint.copy(t.position); e.hasFacePoint = true;
  const dx = t.position.x - e.position.x, dz = t.position.z - e.position.z;
  const l = Math.hypot(dx, dz);
  if (l < 1e-3) return e.fireBlockTimer > 0;
  const nx = dx / l, nz = dz / l;
  const side = e.fireStrafeSign;
  const back = e.fireLineGap < e.stats.radius + ENEMY_WALL_STANDOFF ? ENEMY_WALL_STANDOFF : 0;
  const mx = e.position.x - nz * side * FIRE_STRAFE_STEP - nx * back;
  const mz = e.position.z + nx * side * FIRE_STRAFE_STEP - nz * back;
  // 맵 밖으로 밀지 않는다: 그쪽이 막혔으면 반대쪽으로 돈다
  if (!host.ctx.world!.isInsideBounds(mx, mz)) {
    e.fireStrafeSign = -side as 1 | -1;
    return e.fireBlockTimer > 0;
  }
  e.moveTarget.set(mx, 0, mz);
  e.hasMoveTarget = true;
  return e.fireBlockTimer > 0;
}
