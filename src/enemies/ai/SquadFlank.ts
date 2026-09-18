import * as THREE from 'three';
import type { Enemy, EnemyHost } from '../Enemy';
import { HUMANOID_RAIDER } from '../EnemyTypes';
import type { CombatTarget } from '../Targets';

/* ────────────────────────────────────────────────────────────────────────────
 * 2026-09-13: the raider flanker — one per group (`Enemy.squadRole === 'flanker'`, handed out by the spawn director) swings wide
 * while the squad trades fire from cover, reaches the target's flank · rear and pushes. The numbers are csv `HUMANOID_RAIDER.flank*`.
 *
 *   condition  another member of the same `squadId` is engaged (chase · aware) · this one's own engagement has lasted `flankDelay`
 *              (`flankCd`) · target distance is `flankMinDist … flankMaxDist` · not reloading, throwing or rushing · not a drone target.
 *              With no squad (`squadId` −1, left alone) it is an ordinary raider.
 *   arc        (`flankPhase` 1, wire hint 0) it runs **along an arc** around the target: the goal bearing = the side opposite the
 *              target's facing, pushed `flankBehind` toward its back (the goal turns with the target = it stays out of sight). Every tick it
 *              steers to a waypoint `flankArcStep` degrees ahead of the current bearing, at a radius 4 m inside the current one (at least
 *              `flankRadius`) — it spirals in instead of charging straight. Obstacles go to `integrate`'s avoidance. Speed × `flankSpeedMul`, no firing.
 *   push       inside `flankArrive` degrees of the goal bearing, or past `flankMaxTime`, it hands over to `roguePhase` 4 (the existing
 *              rush — hint 7, hip fire) and sets `flankCd` = `flankCooldown`. After the rush it returns to the usual cover cycle (the leash pulls it back).
 * ──────────────────────────────────────────────────────────────────────────── */

const DEG = Math.PI / 180;
/** With the conditions unmet it looks again this many seconds later (the squad scan does not run every tick) — an algorithm constant. */
const RETRY_S = 0.5;
/** The waypoint radius is taken this much inside the current one every tick (m) — how tight the spiral is, a visual constant. */
const SPIRAL_IN_M = 4;

const _f = new THREE.Vector3();

export interface FlankPose { speed: number; aim: number; crouch: number }

/**
 * A raider squad's flanker. It never rushes on its own (`RogueAI` skips `rushChance` for it): its push comes at the end of
 * the arc — a random rush in the first seconds would carry it to the target's face and spend the flank before it starts.
 */
export function isSquadFlanker(e: Enemy): boolean {
  return e.squadRole === 'flanker' && e.squadId >= 0 && e.faction === 'raider';
}

/** True while the flank arc owns this tick (`pose` written); false = run the normal cover cycle (maybe the push, phase 4). */
export function updateSquadFlank(e: Enemy, dt: number, host: EnemyHost, t: CombatTarget, pose: FlankPose): boolean {
  if (!isSquadFlanker(e)) return false;
  const P = HUMANOID_RAIDER;
  if (e.flankPhase === 0) {
    if (e.flankCd > 0 || e.roguePhase === 4 || e.reloadTimer > 0 || e.throwTimer > 0 || t.drone !== null || t.vehicle !== null) return false;
    const d = e.distToTarget;
    if (d < P.flankMinDist || d > P.flankMaxDist || !squadEngaged(e, host)) { e.flankCd = RETRY_S; return false; }
    // take the flank we are already on (the shorter arc)
    t.getForward(_f);
    const ox = e.position.x - t.position.x, oz = e.position.z - t.position.z;
    e.flankSide = _f.x * oz - _f.z * ox >= 0 ? 1 : -1;
    e.flankPhase = 1; e.flankClock = 0;
    e.roguePhase = 0; e.burstLeft = 0; e.popBursts = 0; e.hasCover = false; e.hasPop = false; e.stateTime = 0;
  }

  e.flankClock += dt;
  const cx = t.position.x, cz = t.position.z;
  const ox = e.position.x - cx, oz = e.position.z - cz;
  const re = Math.hypot(ox, oz);
  // goal bearing: the target's side (perpendicular to its forward, on our side) pushed `flankBehind` toward its back
  t.getForward(_f);
  const side = e.flankSide;
  const b = THREE.MathUtils.clamp(P.flankBehind, 0, 1);
  const gx = side * -_f.z * (1 - b) - _f.x * b;
  const gz = side * _f.x * (1 - b) - _f.z * b;
  const thG = Math.atan2(gx, gz);
  const thE = Math.atan2(ox, oz);
  let delta = thG - thE;
  delta = Math.atan2(Math.sin(delta), Math.cos(delta));

  if (Math.abs(delta) < P.flankArrive * DEG || e.flankClock > P.flankMaxTime) {
    // arrived on the flank (or took too long): push like a rush, then back to the cover cycle
    endFlank(e);
    e.roguePhase = 4; e.rushTimer = 0; e.burstTimer = 0.2; e.stateTime = 0;
    return false;
  }

  const step = Math.min(Math.abs(delta), P.flankArcStep * DEG) * Math.sign(delta);
  const thW = thE + step;
  const rw = Math.max(P.flankRadius, re - SPIRAL_IN_M);
  const wx = cx + Math.sin(thW) * rw, wz = cz + Math.cos(thW) * rw;
  if (!host.ctx.world!.isInsideBounds(wx, wz)) {
    // the arc runs off the map on this side: give it up for a while (the squad keeps the pressure)
    endFlank(e);
    e.roguePhase = 0; e.stateTime = 0;
    return false;
  }
  e.moveTarget.set(wx, 0, wz); e.hasMoveTarget = true;
  e.hasFacePoint = false;                         // run the way we go; the head still tracks the target (lookAtTarget)
  pose.speed = e.stats.speed * P.flankSpeedMul;
  pose.aim = 0.45;
  pose.crouch = 0;
  return true;
}

function endFlank(e: Enemy): void {
  e.flankPhase = 0;
  e.flankCd = HUMANOID_RAIDER.flankCooldown * (0.85 + Math.random() * 0.3);
}

/** Is another member of `e`'s squad fighting right now? */
function squadEngaged(e: Enemy, host: EnemyHost): boolean {
  const list = host.active;
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    if (o === e || o.squadId !== e.squadId || !o.isCombatant) continue;
    if (o.aware && o.state === 'chase') return true;
  }
  return false;
}
