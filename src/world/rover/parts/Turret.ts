/**
 * src/world/rover/parts/Turret.ts — the rover's **turret** (R2, 2026-09-13).
 *
 * - `updateTurretVisual` — every client: turns the turret toward the aim point (the body's front with none) and
 *   switches the muzzle flash on and off. A replica does not know the target, so it takes the host's `rover fire {p}` impact point as the aim point.
 * - `updateTurretLogic` — **the authority (single player · host) only**, and only while running (`patrol` · `trip`): it picks the
 *   nearest living enemy within `ROVER_TURRET_RANGE` with a clear line of sight, turns onto it and fires once inside the aim cone.
 *   Damage is `EnemyRef.takeDamage(…, ROVER_DAMAGE_SOURCE)` — enemies take aggro on the vehicle with no kill credit. **A player is never hit.**
 */
import * as THREE from 'three';
import {
  ROVER_DAMAGE_SOURCE, ROVER_TURRET_AIM_CONE, ROVER_TURRET_DAMAGE, ROVER_TURRET_INTERVAL_S, ROVER_TURRET_RANGE,
  ROVER_TURRET_RETARGET_S, ROVER_TURRET_TURN_RATE,
  type EnemyRef, type GameContext, type WorldRef,
} from '@/shared';
import { angleDelta } from '../model';
import type { RoverBody } from './Body';

/** After this long (seconds) with no aim point, the turret returns to the front. */
const AIM_HOLD_S = 0.8;
/** How long the muzzle flash stays on (seconds). */
const FLASH_S = 0.05;
/** The sight ray starts this far (m) ahead of the turret — so it does not hit the body's own collider. */
const LOS_SKIP_M = 4.4;

export interface TurretState {
  /** The turret's world yaw (the body yaw convention). */
  worldYaw: number;
  targetId: number | null;
  retarget: number;
  fireTimer: number;
  readonly aim: THREE.Vector3;
  /** It aims at `aim` until this moment (`ctx.time`). */
  aimUntil: number;
  flashUntil: number;
}

export function makeTurretState(): TurretState {
  return { worldYaw: 0, targetId: null, retarget: 0, fireTimer: 0, aim: new THREE.Vector3(), aimUntil: -Infinity, flashUntil: -Infinity };
}

const _pivot = new THREE.Vector3();
const _tgt = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _muzzle = new THREE.Vector3();

/** Every client: the turret rotation and the muzzle flash. */
export function updateTurretVisual(ts: TurretState, body: RoverBody, hullYaw: number, now: number, dt: number): void {
  body.turret.getWorldPosition(_pivot);
  const want = now < ts.aimUntil ? Math.atan2(ts.aim.z - _pivot.z, ts.aim.x - _pivot.x) : hullYaw;
  const d = angleDelta(ts.worldYaw, want);
  const step = ROVER_TURRET_TURN_RATE * dt;
  ts.worldYaw += Math.max(-step, Math.min(step, d));
  body.turret.rotation.y = -(ts.worldYaw - hullYaw);
  body.muzzleFlash.scale.setScalar(now < ts.flashUntil ? 1 : 1e-4);
}

/** A replica received one of the host's shots — the aim point and muzzle flash only. The muzzle's world position is written into `outMuzzle`. */
export function applyRemoteShot(ts: TurretState, body: RoverBody, p: THREE.Vector3, now: number, outMuzzle: THREE.Vector3): void {
  ts.aim.copy(p);
  ts.aimUntil = now + AIM_HOLD_S;
  ts.flashUntil = now + FLASH_S;
  body.barrelTip.getWorldPosition(outMuzzle);
}

/**
 * The authority: picking a target · aiming · firing. `fire(from, to, targetId)` is called once per shot (`Rover`
 * does the FX, the broadcast and the event). `from` and `to` are scratch — they are not kept. The target is handed
 * over with the shot rather than read back off `ts.targetId`, so `rover:fired` names the body that took the damage
 * on the line above even when the next frame has already retargeted (2026-09-21, B-73).
 */
export function updateTurretLogic(
  game: GameContext, ts: TurretState, body: RoverBody, dt: number, now: number,
  fire: (from: THREE.Vector3, to: THREE.Vector3, targetId: number) => void,
): void {
  ts.fireTimer -= dt;
  ts.retarget -= dt;
  const enemies = game.enemies, world = game.world;
  if (!enemies || !world) return;
  body.turret.getWorldPosition(_pivot);
  _pivot.y += 0.5;

  let target: EnemyRef | null = null;
  if (ts.retarget <= 0 || ts.targetId === null) {
    ts.retarget = ROVER_TURRET_RETARGET_S;
    let best = Infinity;
    const near = enemies.queryNear(_pivot, ROVER_TURRET_RANGE);
    for (let i = 0; i < near.length; i++) {
      const e = near[i];
      if (e.isDead) continue;
      const d2 = e.position.distanceToSquared(_pivot);
      if (d2 >= best) continue;
      if (!lineOfSight(world, _pivot, e)) continue;
      best = d2;
      target = e;
    }
    ts.targetId = target ? target.id : null;
  } else {
    const near = enemies.queryNear(_pivot, ROVER_TURRET_RANGE + 2);
    for (let i = 0; i < near.length; i++) if (near[i].id === ts.targetId) { target = near[i]; break; }
    if (!target || target.isDead) { ts.targetId = null; target = null; }
  }
  if (!target) return;

  _tgt.copy(target.position);
  _tgt.y += target.height * 0.55;
  ts.aim.copy(_tgt);
  ts.aimUntil = now + AIM_HOLD_S;
  const want = Math.atan2(_tgt.z - _pivot.z, _tgt.x - _pivot.x);
  if (Math.abs(angleDelta(ts.worldYaw, want)) > ROVER_TURRET_AIM_CONE || ts.fireTimer > 0) return;
  if (!lineOfSight(world, _pivot, target)) { ts.targetId = null; return; }

  ts.fireTimer = ROVER_TURRET_INTERVAL_S;
  ts.flashUntil = now + FLASH_S;
  body.barrelTip.getWorldPosition(_muzzle);
  _dir.subVectors(_tgt, _muzzle).normalize();
  target.takeDamage(ROVER_TURRET_DAMAGE, _tgt.clone(), _dir.clone(), ROVER_DAMAGE_SOURCE);
  fire(_muzzle, _tgt, target.id);
}

/** Is the line from the turret to the enemy's mid-body clear of terrain and obstacles? The ray starts outside the body. */
function lineOfSight(world: WorldRef, from: THREE.Vector3, e: EnemyRef): boolean {
  _tgt.copy(e.position);
  _tgt.y += e.height * 0.55;
  _dir.subVectors(_tgt, from);
  const dist = _dir.length();
  if (dist <= LOS_SKIP_M) return true;
  _dir.divideScalar(dist);
  _origin.copy(from).addScaledVector(_dir, LOS_SKIP_M);
  const hit = world.raycast(_origin, _dir, dist - LOS_SKIP_M);
  return !hit || hit.distance >= dist - LOS_SKIP_M - e.radius - 0.4;
}
