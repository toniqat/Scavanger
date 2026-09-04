import * as THREE from 'three';
import { PLAYER_HEIGHT } from '@/shared';
import type { Enemy, EnemyHost } from '../Enemy';

const _o = new THREE.Vector3();
const _t = new THREE.Vector3();
const _d = new THREE.Vector3();

/** True when nothing (terrain / props) blocks the line from the bug's eyes to the player's chest. */
export function hasLineOfSight(e: Enemy, host: EnemyHost): boolean {
  const ctx = host.ctx;
  const world = ctx.world, player = ctx.player;
  if (!world || !player) return false;
  _o.copy(e.position); _o.y += e.stats.height * 0.8;
  _t.copy(player.position); _t.y += PLAYER_HEIGHT * 0.65;
  _d.subVectors(_t, _o);
  const dist = _d.length();
  if (dist < 1e-3) return true;
  _d.multiplyScalar(1 / dist);
  return world.raycast(_o, _d, dist - 0.3) === null;
}

/** Wake this bug: it now knows about the player. `loud` → screech + propagate to neighbours. */
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
 * and target loss when the player is far and unseen for a while.
 */
export function updatePerception(e: Enemy, dt: number, host: EnemyHost): void {
  const player = host.ctx.player;
  e.perceptionTimer -= dt;
  if (e.perceptionTimer > 0) return;
  e.perceptionTimer = 0.3;
  if (!player || player.isDead) { e.hasLOS = false; return; }
  const dist = e.distToPlayer;
  if (!e.aware) {
    if (dist < e.stats.sightRadius) {
      // very close bugs notice you regardless of LOS; otherwise need a clear line
      const seen = dist < 5 || hasLineOfSight(e, host);
      e.hasLOS = seen;
      if (seen) becomeAlert(e, host, true);
    } else e.hasLOS = false;
  } else {
    e.hasLOS = dist < 90 && hasLineOfSight(e, host);
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
