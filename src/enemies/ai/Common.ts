import * as THREE from 'three';
import type { Enemy } from '../Enemy';
import type { CombatTarget } from '../Targets';
import { yawTo } from './Steering';

/* Helpers shared by EnemyAI (bugs), RogueAI (humanoids) and GimmickAI (artillery / toxic / behemoth). */

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

export function startMelee(e: Enemy): void {
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
