import * as THREE from 'three';
import { ENEMY_FIRE_LOS_S, ENEMY_FIRE_STRAFE_S, ENEMY_WALL_STANDOFF } from '@/shared';
import type { Enemy, EnemyHost } from '../Enemy';
import { VEHICLE_RAY_MARGIN, type CombatTarget } from '../Targets';
import { holdingFire } from './Common';

/* ────────────────────────────────────────────────────────────────────────────
 * The muzzle line of fire (2026-09-10) — so an enemy does not shoot while pressed flat against a wall.
 *
 * The problem: perception (`ai/Perception.hasLineOfSight`) is a ray from the **eyes** to the target's chest. Bullets leave
 * the muzzle, not the eyes (the tip of a rogue's rifle · a spewer's mouth), so a body pressed to the corner of a rock or
 * wall has eyes that see the target while the muzzle sits inside the wall — and it kept taking aim and firing into that wall.
 *
 * Three rules:
 * 1. **Only firing is held.** Movement is never blocked — a line of fire briefly blocked while passing a narrow doorway
 *    or gap is normal, and an AI that freezes there is far worse. Blocked means it does not fire and sidesteps with
 *    `fireLineStrafe` to open the line.
 * 2. **The ray starts `ENEMY_WALL_STANDOFF` behind the muzzle.** With the muzzle already inside the wall, a ray cast
 *    outward from it never meets that wall and simply passes through, reading as "clear". The pulled-back point is inside
 *    its own body, and enemies are not world obstacles, so there is no false hit. This is also what "keep a minimum distance from walls" is.
 * 3. **This is a hot path.** The answer is cached per enemy for `ENEMY_FIRE_LOS_S` — no raycast every frame and every
 *    shot. A target change drops the cache in `ai/Perception.acquireTarget`. The scratch vectors are one module-level set
 *    reused by everyone, so nothing is allocated per frame.
 *
 * It only looks at terrain and obstacles — friendly fire (shooting through another enemy) is not checked (user's decision).
 * An artillery's arc is not a straight line, so this check does not own it: `parts/Attacks.shellArcBlocked` does.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Distance (m) to the steering goal one sidestep away for an enemy with a blocked line of fire. A visual / algorithm constant, not a csv number. */
const FIRE_STRAFE_STEP = 3.5;

const _o = new THREE.Vector3();
const _t = new THREE.Vector3();
const _d = new THREE.Vector3();

/** Where the bullet / spit actually leaves. For a spewer `ai/EnemyAI` spits the glob from `headCenter + 0.1`. */
export function fireOrigin(e: Enemy, out: THREE.Vector3): THREE.Vector3 {
  if (e.type === 'spewer') { e.headCenter(out); out.y += 0.1; return out; }
  return e.muzzle(out);
}

/**
 * Is the muzzle → target chest line clear? A real raycast runs only every `ENEMY_FIRE_LOS_S`; in between it returns
 * `Enemy.fireLineClear` as it is. A clear line ends a sidestep in progress (`fireBlockTimer`).
 */
export function hasFireLine(e: Enemy, host: EnemyHost, t: CombatTarget): boolean {
  const world = host.ctx.world;
  if (!world) return false;
  /* 2026-09-14 3rd pass (the tutorial liftoff): while fire is held the answer is **exactly the blocked one** — aiming, looking
     and movement are unchanged and the caller takes its usual "blocked" path (the sidestep). The cache (`fireLineAt` ·
     `fireLineClear`) is untouched, so once the hold ends the next refresh returns the real answer again. */
  if (holdingFire(host)) return false;
  const now = host.ctx.time;
  if (now - e.fireLineAt < ENEMY_FIRE_LOS_S) return e.fireLineClear;
  e.fireLineAt = now;
  fireOrigin(e, _o);
  t.getChest(_t);
  _d.subVectors(_t, _o);
  const dist = _d.length();
  if (dist < 1e-3) { e.fireLineClear = true; e.fireLineGap = Infinity; e.fireBlockTimer = 0; return true; }
  _d.multiplyScalar(1 / dist);
  // starts ENEMY_WALL_STANDOFF behind the muzzle (inside its own body) — rule 2 above.
  _o.addScaledVector(_d, -ENEMY_WALL_STANDOFF);
  // 2026-09-13 (the rover): it stops before entering the hull box — the hull's own collider is the target, not a wall that blocks the line
  let limit = dist + ENEMY_WALL_STANDOFF - 0.3;
  if (t.vehicle) {
    const enter = t.rayVehicle(_o, _d, dist + ENEMY_WALL_STANDOFF);
    if (enter >= 0) limit = enter - VEHICLE_RAY_MARGIN;
  }
  const hit = limit > 0 ? world.raycast(_o, _d, limit) : null;
  // the distance to the blocker is recorded **from the muzzle** (negative = the muzzle is already inside it).
  e.fireLineGap = hit ? hit.distance - ENEMY_WALL_STANDOFF : Infinity;
  e.fireLineClear = hit === null;
  if (e.fireLineClear) e.fireBlockTimer = 0;
  return e.fireLineClear;
}

/**
 * The answer to a blocked line: instead of standing there aiming, **it sidesteps**. Still facing the target, it takes a
 * steering goal `FIRE_STRAFE_STEP` perpendicular to the target direction, and with the muzzle already inside an obstacle
 * (`fireLineGap` closer than `ENEMY_WALL_STANDOFF`) it also backs off a little away from the target.
 *
 * The return value = whether this sidestep leg is still running. `false` means it walked sideways for `ENEMY_FIRE_STRAFE_S`
 * and still did not clear the line, so the caller makes another plan (a rogue picks new cover, a spewer goes the other way,
 * an artillery relocates). **It never stops moving** — `hasMoveTarget` is set, so `integrate` walks as usual.
 */
export function fireLineStrafe(e: Enemy, host: EnemyHost, t: CombatTarget, dt: number): boolean {
  if (e.fireBlockTimer <= 0) { e.fireBlockTimer = ENEMY_FIRE_STRAFE_S; e.fireStrafeSign = -e.fireStrafeSign as 1 | -1; }
  e.fireBlockTimer -= dt;
  e.facePoint.copy(t.position); e.hasFacePoint = true;
  const dx = t.position.x - e.position.x, dz = t.position.z - e.position.z;
  const l = Math.hypot(dx, dz);
  if (l < 1e-3) return e.fireBlockTimer > 0;
  const nx = dx / l, nz = dz / l;
  const side = e.fireStrafeSign;
  const back = e.fireLineGap < e.stats.radius + ENEMY_WALL_STANDOFF ? ENEMY_WALL_STANDOFF : 0;
  const mx = e.position.x - nz * side * FIRE_STRAFE_STEP - nx * back;
  const mz = e.position.z + nx * side * FIRE_STRAFE_STEP - nz * back;
  // never pushed off the map: that side blocked, it turns to the other one
  if (!host.ctx.world!.isInsideBounds(mx, mz)) {
    e.fireStrafeSign = -side as 1 | -1;
    return e.fireBlockTimer > 0;
  }
  e.moveTarget.set(mx, 0, mz);
  e.hasMoveTarget = true;
  return e.fireBlockTimer > 0;
}
