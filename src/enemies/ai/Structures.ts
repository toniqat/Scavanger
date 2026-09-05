import * as THREE from 'three';
import type { DeployableRef } from '@/shared';
import type { Enemy, EnemyHost } from '../Enemy';
import { SPEWER_SPIT } from '../EnemyTypes';
import type { CombatTarget } from '../Targets';

const _eye = new THREE.Vector3();
const _chest = new THREE.Vector3();

/** How often a bug re-evaluates which deployable it should be attacking. */
const SCAN_INTERVAL = 0.7;
/** Extra reach beyond the melee range at which a blocking wall is worth chewing on. */
const MELEE_SCAN_PAD = 3.5;
/** Damage multiplier bugs get against structures (they tear walls faster than flesh). */
export const STRUCT_DAMAGE_MUL = 1.6;

function dist2D(a: THREE.Vector3, b: THREE.Vector3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * Refresh `e.structTarget` — a gadget deployable (바리케이드 / 돔 실드 / 포탑 / 유인 비콘) the bug should destroy.
 *
 * - Melee types only care about something that physically stands between them and their player target
 *   (`ctx.gadgets.blocksProjectile(eye, chest, true)`), or a deployable already within biting range.
 * - Spewers (원거리형) additionally shoot lure grenades, barricades and turrets they can see, preferring them
 *   whenever the player is not visible.
 *
 * Cheap: at most one `findEnemyTarget` + one `blocksProjectile` call per bug per `SCAN_INTERVAL`.
 */
export function refreshStructureTarget(e: Enemy, dt: number, host: EnemyHost, target: CombatTarget | null): void {
  e.structTimer -= dt;
  const cur = e.structTarget;
  if (cur && cur.hp <= 0) { e.structTarget = null; e.structBlocking = false; e.structAttack = false; }
  if (e.structTimer > 0) return;
  e.structTimer = SCAN_INTERVAL;

  const g = host.ctx.gadgets;
  if (!g) { e.structTarget = null; e.structBlocking = false; return; }

  const ranged = e.type === 'spewer';
  const reach = ranged ? SPEWER_SPIT.maxDist : e.stats.attackRange + e.stats.radius + MELEE_SCAN_PAD;
  const dep = g.findEnemyTarget(e.position, reach);
  if (!dep || dep.hp <= 0) { e.structTarget = null; e.structBlocking = false; return; }

  let blocking = false;
  if (target) {
    _eye.set(e.position.x, e.position.y + e.stats.height * 0.8, e.position.z);
    target.getChest(_chest);
    blocking = g.blocksProjectile(_eye, _chest, true) !== null;
  }

  if (ranged) {
    // shoot structures when the player is hidden, when something is in the way, or when they are simply closer
    const worth = !e.hasLOS || blocking || !target || dist2D(e.position, dep.position) < e.distToTarget * 0.8;
    e.structTarget = worth ? dep : null;
  } else {
    const near = dist2D(e.position, dep.position) <= e.stats.attackRange + e.stats.radius + dep.radius + 0.6;
    e.structTarget = (blocking || near) ? dep : null;
  }
  e.structBlocking = blocking;
}

/** Damage a deployable with a bug's melee swing. */
export function biteStructure(e: Enemy, host: EnemyHost, dep: DeployableRef): void {
  dep.takeDamage(e.stats.attackDamage * STRUCT_DAMAGE_MUL, e.position);
  host.playAudio('bug_attack', e.position, 0.8, e.type === 'charger' ? 0.6 : 0.95);
}
