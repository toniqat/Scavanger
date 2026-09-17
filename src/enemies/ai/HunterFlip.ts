import { GRAVITY } from '@/shared';
import type { Enemy, EnemyHost } from '../Enemy';
import { HUNTER_LEAP } from '../EnemyTypes';

/**
 * 2026-09-17 (사용자 결정): **헌터 뒤집힘.** 도약 중 누적 피해가 `HUNTER_LEAP.flipDamage` 에 닿으면(`Enemy.noteLeapDamage`)
 * 수평 속도를 버리고 그 자리에서 수직으로 떨어진 뒤 등으로 누워 `HUNTER_LEAP.flipDuration` s 동안 아무것도 못 한다
 * (이동 · 회전 · 공격 없음). 누운 동안에도 맞고 죽을 수 있다(`takeDamage` 는 막지 않는다). 좌우로 천천히 흔들리는
 * 자세는 `models/BugModel.animateBug` 의 `anim.flip` 이 그린다 — 죽은 몸과 구분되게.
 *
 * 권위(호스트 · 싱글)만 돈다. 리플리카는 와이어 힌트 23(떨어지는 중) · 24(누워 있음)로 같은 자세를 입힌다
 * (`net/HostSync.animHint`, `net/Replica.drive`).
 *
 * 떨어짐은 실제 중력(도약 포물선의 `arcGravityMul` 이 아니다)이고, 착지는 도약 착지와 같은 **발밑 표면** 질의
 * (`getSurfaceY(x, z, y)`) — 낮은 바위 위에서 끊기면 바위 위에 눕는다.
 *
 * @returns true = 이번 틱은 이것으로 끝 (AI · `integrate` 를 건너뛴다).
 */
export function updateHunterFlip(e: Enemy, dt: number, host: EnemyHost): boolean {
  if (!e.flipFalling && e.flipTimer <= 0) return false;
  const world = host.ctx.world;
  if (!world) return true;
  e.velocity.set(0, 0, 0);
  e.hasMoveTarget = false; e.hasFacePoint = false;
  const a = e.anim;
  a.speed = Math.max(0, a.speed - dt * 6);
  a.crouch += (0 - a.crouch) * Math.min(1, dt * 8);
  if (e.flipFalling) {
    e.airborne = true;
    e.vy -= GRAVITY * dt;
    e.position.y += e.vy * dt;
    world.resolveCollision(e.position, e.stats.radius);
    const ground = world.getSurfaceY(e.position.x, e.position.z, e.position.y);
    if (e.position.y <= ground) {
      e.position.y = ground;
      e.vy = 0;
      e.airborne = false;
      e.flipFalling = false;
      e.flipTimer = HUNTER_LEAP.flipDuration;
      host.playAudio('bug_step', e.position, 0.9, 0.8);
    }
    return true;
  }
  // 누워 있다: 버둥거리는 입, 머리는 뒤로 젖힌다. 표면에 붙어 있는다 (전차 위였다면 그 위치 그대로 — 탑승 추적은 일어난 뒤 다시 잡는다).
  a.mandible += (Math.abs(Math.sin(a.time * 5)) - a.mandible) * Math.min(1, dt * 8);
  e.position.y = world.getSurfaceY(e.position.x, e.position.z, e.position.y);
  e.flipTimer -= dt;
  if (e.flipTimer <= 0) {
    e.flipTimer = 0;
    // 상태는 `stagger`(타이머 0) 그대로 — 다음 틱의 평소 경직 종료 가지가 추격 / 대기로 돌려보낸다 (전소가 겹쳤으면 그것이 먼저 끝난다)
    e.stateTime = 0;
  }
  return true;
}
