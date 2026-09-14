import * as THREE from 'three';
import type { Enemy, EnemyHost } from '../Enemy';
import type { CombatTarget } from '../Targets';
import { yawTo } from './Steering';

/* Helpers shared by EnemyAI (bugs), RogueAI (humanoids) and GimmickAI (artillery / toxic / behemoth). */

/**
 * 2026-09-14 3차 — **사격 보류**(`ExtractionRef.holdFire`). 튜토리얼 탈출선이 뜨는 동안 미처 처치하지 못한 적이
 * 화물칸의 플레이어를 쏘는 것을 막는 유일한 문이다. 막는 것은 **공격뿐**이고 조준 · 바라보기 · 이동은 그대로다 —
 * `ai/FireLine` 이 사선이 막혔을 때 하는 것과 **같은 처리**라, 적은 총을 겨눈 채 옆으로 비켜설 뿐이다.
 *
 * 거는 자리는 셋이다: `FireLine.hasFireLine`(사선 게이트를 지나는 모든 사격) · `parts/Attacks.fireGun`(게이트를
 * 지나지 않는 네임드 사격까지) · `startMelee`(근접). 튜토리얼이 아니면 `holdFire` 자체가 늘 false 라 비용은 호출 하나다.
 */
export function holdingFire(host: EnemyHost): boolean {
  return host.ctx.extraction?.holdFire?.() === true;
}

export function lookAtTarget(e: Enemy, t: CombatTarget, dt: number): void {
  const a = e.anim;
  const wanted = yawTo(e.position, t.position);
  let rel = wanted - e.yaw;
  rel = Math.atan2(Math.sin(rel), Math.cos(rel));
  a.headYaw = THREE.MathUtils.lerp(a.headYaw, THREE.MathUtils.clamp(rel, -0.8, 0.8), Math.min(1, dt * 8));
  const dy = (t.position.y + t.bodyHeight * 0.65) - (e.position.y + e.rig.params.head.y);
  const pitch = -Math.atan2(dy, Math.max(0.5, t.dist2D(e.position)));
  a.headPitch = THREE.MathUtils.lerp(a.headPitch, THREE.MathUtils.clamp(pitch, -0.6, 0.6), Math.min(1, dt * 8));
}

/**
 * 근접 공격을 시작한다. `host` 를 넘기면 **사격 보류**(`holdingFire`) 중에는 시작하지 않는다 — 휘두르는 시늉도
 * 하지 않고 그대로 쫓기만 한다 (2026-09-14 3차). 넘기지 않는 호출부(네임드 타길라의 자기 망치)는 예전 그대로다.
 */
export function startMelee(e: Enemy, host?: EnemyHost): void {
  if (host && holdingFire(host)) return;
  e.state = 'attack'; e.stateTime = 0;
  e.attackTimer = 0; e.attackHitDone = false; e.leaping = false;
  e.spitPhase = 0; e.chargePhase = 0;
  // tactical kit: a fresh swing is aimed at the player unless the AI re-targets a deployable
  e.structAttack = false;
  e.spitAtPoint = false;
}

/** End a charge (charger / behemoth) with a stagger and the type's cooldown. */
export function stumble(e: Enemy, cooldown: number, duration: number): void {
  e.chargePhase = 0;
  e.chargeCd = cooldown;
  e.attackCd = 1.0;
  e.enterStagger(duration);
  e.velocity.multiplyScalar(0.25);
}

export interface AttackResult { speed: number; allowOverlap: boolean; mandible: number }
export const attackResult: AttackResult = { speed: 0, allowOverlap: false, mandible: 0 };
