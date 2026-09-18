import { GRAVITY } from '@/shared';
import type { Enemy, EnemyHost } from '../Enemy';
import { HUNTER_LEAP } from '../EnemyTypes';

/**
 * 2026-09-17 (user's decision): **the hunter flip.** When the damage accumulated during a leap reaches `HUNTER_LEAP.flipDamage`
 * (`Enemy.noteLeapDamage`) it drops its horizontal speed, falls straight down from there and lies on its back, able to do nothing
 * for `HUNTER_LEAP.flipDuration` s (no movement · turning · attack). It can still be hit and killed while it lies there
 * (`takeDamage` does not refuse). The slow side-to-side rocking pose is drawn by `anim.flip` in `models/BugModel.animateBug` — so it reads apart from a dead body.
 *
 * Authority only (host · single-player). Replicas apply the same pose from wire hints 23 (falling) · 24 (lying)
 * (`net/HostSync.animHint`, `net/Replica.drive`).
 *
 * The fall uses real gravity (not the leap arc's `arcGravityMul`), and the landing is the same **surface under the feet** query
 * as a leap landing (`getSurfaceY(x, z, y)`) — cut short over a low rock, it lies on the rock.
 *
 * @returns true = this tick ends here (the AI and `integrate` are skipped).
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
  // lying: mandibles thrashing, head tipped back. It stays on the surface (on a tram it keeps that spot — riding is picked up again once it rights itself).
  a.mandible += (Math.abs(Math.sin(a.time * 5)) - a.mandible) * Math.min(1, dt * 8);
  e.position.y = world.getSurfaceY(e.position.x, e.position.z, e.position.y);
  e.flipTimer -= dt;
  if (e.flipTimer <= 0) {
    e.flipTimer = 0;
    // the state stays `stagger` (timer 0) — next tick's ordinary stagger-exit branch sends it back to chase / idle (an overlapping incinerate finishes first)
    e.stateTime = 0;
  }
  return true;
}
