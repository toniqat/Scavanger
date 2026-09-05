import * as THREE from 'three';
import type { Enemy, EnemyHost } from '../Enemy';
import type { CombatTarget } from '../Targets';

const _o = new THREE.Vector3();
const _t = new THREE.Vector3();
const _d = new THREE.Vector3();

/** True when nothing (terrain / props) blocks the line from the bug's eyes to the target's chest. */
export function hasLineOfSight(e: Enemy, host: EnemyHost, target: CombatTarget): boolean {
  const world = host.ctx.world;
  if (!world) return false;
  _o.copy(e.position); _o.y += e.stats.height * 0.8;
  target.getChest(_t);
  _d.subVectors(_t, _o);
  const dist = _d.length();
  if (dist < 1e-3) return true;
  _d.multiplyScalar(1 / dist);
  return world.raycast(_o, _d, dist - 0.3) === null;
}

/**
 * Pick / keep the bug's target: nearest alive player, re-evaluated every 0.5–0.9 s or as soon as the current one
 * dies, goes down or leaves. Hysteresis: a different player must be clearly closer (×0.6 with LOS on the current, ×0.75 without)
 * before the bug switches. A dead or downed target is kept (so "target died → calm down" logic runs) until another is alive.
 * Also refreshes `distToTarget`.
 */
export function acquireTarget(e: Enemy, dt: number, host: EnemyHost): void {
  e.targetTimer -= dt;
  const cur = e.target;
  const curValid = !!cur && cur.present && !cur.isDeadOrDowned;
  if (!curValid || e.targetTimer <= 0) {
    e.targetTimer = 0.5 + Math.random() * 0.4;
    const best = host.targets.nearestAlive(e.position);
    if (!best) {
      if (cur && !cur.present) e.target = null;
    } else if (!curValid) {
      e.target = best;
    } else if (best !== cur) {
      const keep = e.hasLOS ? 0.6 : 0.75;
      if (best.dist2D(e.position) < cur.dist2D(e.position) * keep) e.target = best;
    }
    if (e.target !== cur) { e.hasLOS = false; e.perceptionTimer = 0; }
  }
  e.distToTarget = e.target ? e.target.dist2D(e.position) : Infinity;
}

/** Wake this bug: it now knows about the players. `loud` → screech + propagate to neighbours. */
export function becomeAlert(e: Enemy, host: EnemyHost, loud: boolean): void {
  if (e.state === 'dead' || e.state === 'flee' || !e.active) return;
  const wasAware = e.aware;
  e.aware = true;
  e.lostTimer = 0;
  if (e.state === 'idle' || e.state === 'wander') {
    e.state = 'alert';
    e.stateTime = 0;
    e.hasMoveTarget = false;
  }
  if (!wasAware && loud) {
    host.ctx.bus.emit('enemy:alerted', { id: e.id, type: e.type, position: e.position });
    if (e.type === 'scavenger' || e.type === 'hunter') host.playAudio('bug_screech', e.position, 0.9, e.type === 'scavenger' ? 1.15 : 0.9);
    else host.playAudio('bug_screech', e.position, 0.7, e.type === 'charger' ? 0.55 : 0.75);
    host.alertNear(e.position, 20, e);
  }
}

/**
 * Staggered perception tick (≤ every 0.3 s per bug): sight acquisition with LOS,
 * and target loss when the target is far and unseen for a while.
 */
export function updatePerception(e: Enemy, dt: number, host: EnemyHost): void {
  e.perceptionTimer -= dt;
  if (e.perceptionTimer > 0) return;
  e.perceptionTimer = 0.3;
  const t = e.target;
  if (!t || t.isDeadOrDowned) { e.hasLOS = false; return; }
  const dist = e.distToTarget;
  if (!e.aware) {
    if (dist < e.stats.sightRadius) {
      // very close bugs notice you regardless of LOS; otherwise need a clear line
      const seen = dist < 5 || hasLineOfSight(e, host, t);
      e.hasLOS = seen;
      if (seen) becomeAlert(e, host, true);
    } else e.hasLOS = false;
  } else {
    e.hasLOS = dist < 90 && hasLineOfSight(e, host, t);
    if (!e.relentless) {
      if (!e.hasLOS && dist > 60) {
        e.lostTimer += 0.3;
        if (e.lostTimer > 10) {
          e.aware = false;
          e.lostTimer = 0;
          e.spawnPos.copy(e.position);
          if (e.state === 'chase' || e.state === 'alert') { e.state = 'idle'; e.stateTime = 0; e.wanderTimer = 1; e.hasMoveTarget = false; }
        }
      } else e.lostTimer = 0;
    }
  }
}
