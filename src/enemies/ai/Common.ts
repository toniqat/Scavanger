import * as THREE from 'three';
import type { Enemy, EnemyHost } from '../Enemy';
import type { CombatTarget } from '../Targets';
import { yawTo } from './Steering';

/* Helpers shared by EnemyAI (bugs), RogueAI (humanoids) and GimmickAI (artillery / toxic / behemoth). */

/**
 * 2026-09-14 3rd pass — **holding fire** (`ExtractionRef.holdFire`). It is the one gate that stops an enemy left alive while the
 * tutorial dropship lifts off from shooting the player in the bay. **Only the attack** is blocked; aiming, looking and movement stay —
 * it is **the same handling** as `ai/FireLine` gives a blocked line, so the enemy just sidesteps with its gun up.
 *
 * It is raised in three places: `FireLine.hasFireLine` (every shot that passes the line gate) · `parts/Attacks.fireGun` (including
 * named shots that skip the gate) · `startMelee` (melee). Outside the tutorial `holdFire` itself is always false, so it costs one call.
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
 * Starts a melee attack. Pass `host` and it does not start while fire is held (`holdingFire`) — it does not even mime the
 * swing, it just keeps chasing (2026-09-14 3rd pass). Callers that do not pass it (named Tagilla's own hammer) are unchanged.
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
