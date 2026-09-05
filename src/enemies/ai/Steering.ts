import * as THREE from 'three';
import { PLAYER_RADIUS } from '@/shared';
import type { Enemy } from '../Enemy';
import type { SpatialGrid } from '../SpatialGrid';
import type { CombatTarget } from '../Targets';

const _d = new THREE.Vector3();
const neighborBuf: Enemy[] = new Array(64);

/** Desired velocity (XZ) toward `target` at `speed`, slowing inside `arriveRadius`. */
export function seek(pos: THREE.Vector3, target: THREE.Vector3, speed: number, arriveRadius: number, out: THREE.Vector3): THREE.Vector3 {
  const dx = target.x - pos.x, dz = target.z - pos.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-4) return out.set(0, 0, 0);
  const s = arriveRadius > 0 && dist < arriveRadius ? speed * (dist / arriveRadius) : speed;
  return out.set(dx / dist * s, 0, dz / dist * s);
}

/**
 * Separation from other bugs (positional correction, mass-weighted) + soft push-out from every present, not-dead player (downed bodies included — bugs walk around them).
 * Also accumulates a steering force into `steer` so crowds flow around each other instead of jittering.
 */
export function separate(e: Enemy, grid: SpatialGrid<Enemy>, players: readonly CombatTarget[], steer: THREE.Vector3, allowPlayerOverlap: boolean): void {
  const pos = e.position;
  const r = e.stats.radius;
  const n = grid.query(pos.x, pos.z, r + 2.2, neighborBuf);
  for (let i = 0; i < n; i++) {
    const o = neighborBuf[i];
    if (o === e || o.state === 'dead' || !o.active || o.state === 'flee') continue;
    const dx = pos.x - o.position.x, dz = pos.z - o.position.z;
    const d2 = dx * dx + dz * dz;
    const minD = r + o.stats.radius + 0.15;
    if (d2 >= minD * minD) {
      // gentle spacing force when close but not overlapping
      const soft = minD + 0.9;
      if (d2 < soft * soft && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        const f = (soft - d) / soft * 1.8;
        steer.x += dx / d * f; steer.z += dz / d * f;
      }
      continue;
    }
    let d = Math.sqrt(d2);
    let nx: number, nz: number;
    if (d < 1e-4) { const a = e.id * 2.399; nx = Math.cos(a); nz = Math.sin(a); d = 1e-4; } else { nx = dx / d; nz = dz / d; }
    const overlap = minD - d;
    const w = o.stats.mass / (o.stats.mass + e.stats.mass);
    pos.x += nx * overlap * w; pos.z += nz * overlap * w;
    steer.x += nx * 3; steer.z += nz * 3;
  }
  if (allowPlayerOverlap) return;
  const minD = r + PLAYER_RADIUS + 0.1;
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (p.isDead) continue;
    const dx = pos.x - p.position.x, dz = pos.z - p.position.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < minD * minD) {
      const d = Math.max(1e-4, Math.sqrt(d2));
      const overlap = minD - d;
      pos.x += dx / d * overlap; pos.z += dz / d * overlap;
    }
  }
}

/** Steer around cached nearby obstacle cylinders; writes into `steer`. `dir` = current movement direction (unit XZ). */
export function avoidObstacles(e: Enemy, dir: THREE.Vector3, steer: THREE.Vector3): void {
  const obs = e.nearObstacles;
  if (obs.length === 0) return;
  const pos = e.position;
  const r = e.stats.radius;
  const lookAhead = 2.5 + e.velocity.length() * 0.5;
  for (let i = 0; i < obs.length; i++) {
    const o = obs[i];
    _d.set(o.position.x - pos.x, 0, o.position.z - pos.z);
    const dist = _d.length();
    const clearance = o.radius + r + 0.4;
    if (dist > clearance + lookAhead || dist < 1e-4) continue;
    const ahead = (_d.x * dir.x + _d.z * dir.z) / dist;
    if (ahead < 0.2) {
      // beside/behind: mild repulsion only when very close
      if (dist < clearance + 0.3) { const f = (clearance + 0.3 - dist) * 2; steer.x -= _d.x / dist * f; steer.z -= _d.z / dist * f; }
      continue;
    }
    // lateral offset of obstacle from our path: positive = right
    const side = dir.z * _d.x - dir.x * _d.z;
    const lateral = Math.abs(side) / dist;
    if (lateral * dist > clearance) continue; // path clears it
    const strength = (1 - dist / (clearance + lookAhead)) * 5 * ahead;
    const sgn = side >= 0 ? -1 : 1; // steer away from the side the obstacle is on
    // perpendicular of dir: (dir.z, -dir.x) is "right"
    steer.x += dir.z * sgn * strength;
    steer.z += -dir.x * sgn * strength;
  }
}

/** Rotate `yaw` toward `targetYaw` by at most `rate*dt`; returns new yaw. */
export function turnToward(yaw: number, targetYaw: number, rate: number, dt: number): number {
  let diff = targetYaw - yaw;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  const max = rate * dt;
  if (diff > max) diff = max; else if (diff < -max) diff = -max;
  return yaw + diff;
}

export function yawTo(from: THREE.Vector3, to: THREE.Vector3): number {
  return Math.atan2(to.x - from.x, to.z - from.z);
}
