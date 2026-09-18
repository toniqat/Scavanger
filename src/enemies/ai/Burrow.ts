/**
 * src/enemies/ai/Burrow.ts — **bugs emerging from the ground · in spat flight** (2026-09-13).
 *
 * The question this file answers: *when do a bug coming up out of the ground and a bug the sandworm spat start fighting.*
 *
 * - **Emerging** (`Enemy.emergeT > 0`, `Enemy.startEmerge`): until the body is all the way out of the ground it **can be hit**
 *   but does not attack or move (user's decision, the recommended option). It only turns slowly toward a nearby target. The
 *   timer is run down by `Enemy.animate` on both the authority and the replica (drawing and judgement read one clock).
 * - **Spat** (`Enemy.spatT > 0`, `Enemy.startSpat`): it flies a fixed arc from the sandworm's mouth to its landing spot. The
 *   authority does it in the AI tick (`updateBurrowGate`), the replica draws the same arc itself from `ee wormSpit`
 *   (`net/Replica.update`). Both call the one `stepSpatFlight`; `airborne` in flight, so a mid-air death falls as before.
 */
import * as THREE from 'three';
import { GRAVITY, type WorldRef } from '@/shared';
import type { Enemy, EnemyHost } from '../Enemy';
import { turnToward, yawTo } from './Steering';

/**
 * Called by `updateEnemyAI` right after the death check (authority AI tick). true = the tick ends here (state machine skipped).
 */
export function updateBurrowGate(e: Enemy, dt: number, host: EnemyHost): boolean {
  if (e.spatT > 0) {
    const world = host.ctx.world;
    if (!world) return true;
    if (stepSpatFlight(e, dt, world)) {
      // landed: hunts at once (a spat pack is relentless)
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
 * One step of a spat body (authority · replica, no allocation). true on landing — position = the landing surface, `airborne` off.
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
  a.crouch = 0.35;   // landing crouch — springs back to the normal pose
  return true;
}
