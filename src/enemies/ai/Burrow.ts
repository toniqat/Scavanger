/**
 * src/enemies/ai/Burrow.ts — **파고 나오는 중 · 뱉어져 날아가는 중인 버그** (2026-09-13).
 *
 * 이 파일이 답하는 질문: *땅에서 올라오는 버그와 지하벌레가 뱉은 버그는 언제부터 싸우나.*
 *
 * - **굴착**(`Enemy.emergeT > 0`, `Enemy.startEmerge`): 몸이 땅에서 다 올라올 때까지 **맞기는 하지만** 공격 · 이동하지 않는다
 *   (사용자 결정 권고안). 가까운 표적 쪽으로 천천히 돌아볼 뿐이다. 시간은 `Enemy.animate` 가 권위 · 리플리카 모두에서 줄인다
 *   (그림과 판정이 같은 시계를 본다).
 * - **뱉어짐**(`Enemy.spatT > 0`, `Enemy.startSpat`): 지하벌레 입에서 착지점까지 정해진 포물선을 날아간다. 권위는 AI 틱에서
 *   (`updateBurrowGate`), 리플리카는 `ee wormSpit` 을 받아 같은 식으로 스스로 그린다(`net/Replica.update`). 둘 다
 *   `stepSpatFlight` 하나를 부른다. 날아가는 동안 `airborne` 이라 공중에서 죽으면 기존 사망 낙하가 이어받는다.
 */
import * as THREE from 'three';
import { GRAVITY, type WorldRef } from '@/shared';
import type { Enemy, EnemyHost } from '../Enemy';
import { turnToward, yawTo } from './Steering';

/**
 * 권위의 AI 틱에서 `updateEnemyAI` 가 사망 검사 바로 뒤에 부른다. true = 이번 틱은 여기서 끝 (평소 상태 기계를 건너뛴다).
 */
export function updateBurrowGate(e: Enemy, dt: number, host: EnemyHost): boolean {
  if (e.spatT > 0) {
    const world = host.ctx.world;
    if (!world) return true;
    if (stepSpatFlight(e, dt, world)) {
      // 착지: 곧장 사냥한다 (뱉어진 무리는 relentless)
      e.aware = true;
      if (e.state === 'idle' || e.state === 'wander' || e.state === 'alert') { e.state = 'chase'; e.stateTime = 0; }
      e.perceptionTimer = 0;
      host.burrowLanded?.(e);
    }
    return true;
  }
  if (e.emergeT > 0) {
    e.velocity.set(0, 0, 0);
    e.hasMoveTarget = false;
    const t = e.target;
    if (t && !t.isDeadOrDowned) e.yaw = turnToward(e.yaw, yawTo(e.position, t.position), e.stats.turnRate * 0.5, dt);
    e.anim.speed += (0 - e.anim.speed) * Math.min(1, dt * 8);
    e.anim.mandible += (0.8 - e.anim.mandible) * Math.min(1, dt * 6);
    return true;
  }
  return false;
}

/**
 * 뱉어진 몸 한 걸음 (권위 · 리플리카 공용, 할당 없음). 착지한 순간 true — 위치는 착지점의 표면, `airborne` 해제.
 */
export function stepSpatFlight(e: Enemy, dt: number, world: WorldRef): boolean {
  if (e.spatT <= 0) return false;
  e.spatT = Math.max(0, e.spatT - dt);
  const tt = e.spatDur - e.spatT;
  const f = e.spatFrom, v = e.spatVel;
  e.position.set(f.x + v.x * tt, f.y + v.y * tt - 0.5 * GRAVITY * tt * tt, f.z + v.z * tt);
  e.vy = v.y - GRAVITY * tt;
  e.velocity.set(v.x, 0, v.z);
  e.airborne = true;
  e.leaping = false;
  if (v.x * v.x + v.z * v.z > 1e-4) e.yaw = Math.atan2(v.x, v.z);
  const a = e.anim;
  a.speed += (0.2 - a.speed) * Math.min(1, dt * 5);
  a.crouch += (-0.3 - a.crouch) * Math.min(1, dt * 6);
  a.mandible += (1 - a.mandible) * Math.min(1, dt * 8);
  a.headPitch = THREE.MathUtils.lerp(a.headPitch, THREE.MathUtils.clamp(-e.vy * 0.04, -0.5, 0.5), Math.min(1, dt * 6));
  if (e.spatT > 0) return false;
  const to = e.spatTo;
  e.position.set(to.x, world.getSurfaceY(to.x, to.z, to.y + 0.4), to.z);
  e.airborne = false;
  e.vy = 0;
  e.velocity.set(0, 0, 0);
  a.crouch = 0.35;   // 착지 웅크림 — 평소 자세로 금방 돌아간다
  return true;
}
