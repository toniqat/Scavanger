import * as THREE from 'three';
import { ENEMY_SHOT_ALERT_GIVE_UP_S, ENEMY_SHOT_ALERT_WATCH_S } from '@/shared';
import type { Enemy, EnemyHost } from '../Enemy';
import { CombatTarget } from '../Targets';
import { lookAtTarget } from './Common';
import { integrate } from './EnemyAI';
import { pickApproachCover } from './RogueCover';
import { HUMANOID_ANDROID } from '../EnemyTypes';

/* ────────────────────────────────────────────────────────────────────────────
 * Phase 12: 총알 추적 — an enemy that could not perceive a shooter reacts to the **bullet** (`EnemySystem.reportShot`).
 *
 * The investigation rides on the shared state machine as `state = 'alert'` with `aware = false` (`Enemy.investigating`):
 * `updateEnemyAI` hands the tick to `updateInvestigate` right after perception, so the normal alert / chase / cover
 * cycle never runs while it lasts, and perceiving **any** target (perception widens toward the origin by
 * `ENEMY_SHOT_ALERT_CONE_MUL`, see `Perception.detectionRange`) simply flips `aware` and drops the enemy into the
 * ordinary combat cycle (rogues open fire). The wire needs nothing new: replicas read `alert` as the raised-rifle /
 * crouched-mandibles pose they already have, and a rogue's cover hold reuses `roguePhase` 2 → hint 6.
 *
 *   phase 0  watch   — face the origin for `ENEMY_SHOT_ALERT_WATCH_S`, standing still
 *   phase 1  advance — bugs walk straight at the origin; rogues leg cover-to-cover (`pickApproachCover`), a short
 *                      crouched hold at each rock, straight ahead for a few seconds when no rock qualifies
 *   phase 2  arrived — within `SHOT_ALERT_ARRIVE` of the origin (or a rogue at its leash): one last look, stand down
 *
 * `ENEMY_SHOT_ALERT_GIVE_UP_S` after the start the enemy returns to what it was doing (idle → wander around its own
 * anchor). A later shot while investigating only refreshes the origin (`beginInvestigation` returns false).
 * ──────────────────────────────────────────────────────────────────────────── */

/** Distance to the origin (m) at which the investigation counts as arrived. */
export const SHOT_ALERT_ARRIVE = 8;
/** Seconds of the final look (phase 2) before standing down. */
const ARRIVE_HOLD_S = 2;
/** Rogue crouched hold at each approach cover (s). */
const COVER_HOLD_MIN = 0.8;
const COVER_HOLD_MAX = 1.6;
/** A cover leg that takes longer than this is abandoned (stuck on a rock). */
const COVER_LEG_TIMEOUT = 6;
/** Without a qualifying rock a rogue walks straight at the origin this long before looking for cover again. */
const OPEN_LEG_S = 3;
/** Advance speeds relative to the type's chase speed. */
const BUG_ADVANCE_MUL = 0.8;
const ROGUE_OPEN_MUL = 0.85;

/** Proxy target standing at the shot origin (cover picking / head look need a `CombatTarget`). Never a real target. */
const _proxy = new CombatTarget('ai');

interface Pose { speed: number; aim: number; crouch: number }
const pose: Pose = { speed: 0, aim: 0, crouch: 0 };

/**
 * Start (or refresh) an investigation toward `origin`. Returns true when this call **started** it (the caller emits
 * `enemy:shotAlerted` once); false = already investigating, only the origin moved.
 */
export function beginInvestigation(e: Enemy, origin: THREE.Vector3): boolean {
  if (e.investigating) { e.shotOrigin.copy(origin); return false; }
  e.investigating = true;
  e.shotOrigin.copy(origin);
  e.shotTimer = 0; e.shotPhase = 0; e.shotHold = 0;
  e.hasCover = false; e.hasPop = false; e.roguePhase = 0;
  e.hasMoveTarget = false;
  e.state = 'alert'; e.stateTime = 0;
  return true;
}

/**
 * Stop investigating. Unaware (gave up / arrived): back to idle around the own anchor (bugs: `spawnPos`, rogues:
 * `guardPos` through their wander). Aware (perceived someone meanwhile): stay in `alert` with a fresh `stateTime` so
 * the normal reaction → chase runs.
 */
export function endInvestigation(e: Enemy): void {
  e.investigating = false;
  e.shotPhase = 0; e.shotHold = 0;
  e.hasCover = false; e.hasPop = false; e.roguePhase = 0;
  e.hasMoveTarget = false; e.hasFacePoint = false;
  e.stateTime = 0;
  if (!e.aware && e.state === 'alert') { e.state = 'idle'; e.wanderTimer = 1 + Math.random() * 2; }
}

/** One AI + movement tick while `e.investigating && !e.aware` (called instead of the state switch). */
export function updateInvestigate(e: Enemy, dt: number, host: EnemyHost): void {
  const world = host.ctx.world!;
  const s = e.stats;
  const a = e.anim;
  const o = e.shotOrigin;
  e.shotTimer += dt;
  if (e.shotTimer >= ENEMY_SHOT_ALERT_GIVE_UP_S) { endInvestigation(e); return; }

  _proxy.position.copy(o);
  _proxy.present = true; _proxy.isDead = false;
  const dO = Math.hypot(o.x - e.position.x, o.z - e.position.z);
  const r = pose;
  r.speed = 0; r.aim = 0.8; r.crouch = e.isHumanoid ? 0 : 0.25;
  e.hasMoveTarget = false;
  e.hasFacePoint = true; e.facePoint.copy(o);

  switch (e.shotPhase) {
    case 0: {
      if (e.shotTimer >= ENEMY_SHOT_ALERT_WATCH_S) {
        e.shotPhase = dO <= SHOT_ALERT_ARRIVE ? 2 : 1;
        e.shotHold = 0; e.roguePhase = 0; e.hasCover = false;
      }
      break;
    }
    case 1: {
      const leashed = e.isHumanoid && Math.hypot(e.position.x - e.guardPos.x, e.position.z - e.guardPos.z) > e.leash;
      if (dO <= SHOT_ALERT_ARRIVE || leashed) { e.shotPhase = 2; e.shotHold = 0; e.roguePhase = 0; break; }
      if (e.faction === 'android') {
        // 2026-09-13: an android never takes cover — it walks straight at the origin, rifle up, at its slow advance pace
        e.moveTarget.copy(o); e.hasMoveTarget = true;
        e.roguePhase = 0;
        r.speed = s.speed * HUMANOID_ANDROID.advanceMul; r.aim = 0.8;
      } else if (e.isHumanoid) advanceRogue(e, dt, host, dO, r);
      else {
        e.moveTarget.copy(o); e.hasMoveTarget = true;
        e.hasFacePoint = false;                     // bugs run the way they go
        r.speed = s.speed * BUG_ADVANCE_MUL; r.crouch = 0;
      }
      break;
    }
    case 2: {
      e.shotHold += dt;
      if (e.shotHold >= ARRIVE_HOLD_S) { endInvestigation(e); return; }
      break;
    }
    default: break;
  }

  // pose: head on the origin, rifle raised / mandibles working, the rest as the phase says
  lookAtTarget(e, _proxy, dt);
  if (e.isHumanoid) {
    a.aim += (r.aim - a.aim) * Math.min(1, dt * (r.aim > a.aim ? 7 : 3));
    a.crouch += (r.crouch - a.crouch) * Math.min(1, dt * 7);
  } else {
    a.mandible += (0.7 - a.mandible) * Math.min(1, dt * 10);
    a.crouch = THREE.MathUtils.lerp(a.crouch, r.crouch, dt * 8);
    a.abdomen = Math.max(0, a.abdomen - dt * 2);
  }
  a.shake = Math.max(0, a.shake - dt * 4);
  let speed = r.speed;
  if (e.slowFactor < 1) speed *= e.slowFactor;
  integrate(e, dt, world, host, speed, false);
}

/**
 * Rogue approach leg: `roguePhase` 0 pick a rock that closes in → 1 move to it facing the origin (or straight ahead
 * for `OPEN_LEG_S` when none qualifies) → 2 short crouched hold (wire hint 6) → 0 again.
 */
function advanceRogue(e: Enemy, dt: number, host: EnemyHost, dO: number, r: Pose): void {
  const s = e.stats;
  if (e.roguePhase === 0) {
    // the proxy "faces" the rogue so `getChest` / LOS tests behave like a real target at the origin
    _proxy.yaw = Math.atan2(-(e.position.x - _proxy.position.x), -(e.position.z - _proxy.position.z));
    pickApproachCover(e, host, _proxy);
    e.roguePhase = 1; e.shotHold = 0;
  }
  if (e.roguePhase === 1) {
    e.shotHold += dt;
    r.aim = 0.7;
    if (e.hasCover) {
      e.moveTarget.copy(e.coverPos); e.hasMoveTarget = true;
      r.speed = s.speed;
      const dx = e.coverPos.x - e.position.x, dz = e.coverPos.z - e.position.z;
      if (dx * dx + dz * dz < 0.8 || e.shotHold > COVER_LEG_TIMEOUT) {
        e.roguePhase = 2;
        e.coverTimer = COVER_HOLD_MIN + Math.random() * (COVER_HOLD_MAX - COVER_HOLD_MIN);
      }
    } else {
      // open ground: walk straight at the origin for a while, then look for a rock again
      e.moveTarget.copy(e.shotOrigin); e.hasMoveTarget = true;
      r.speed = s.speed * ROGUE_OPEN_MUL;
      if (e.shotHold > OPEN_LEG_S || dO <= SHOT_ALERT_ARRIVE) e.roguePhase = 0;
    }
    return;
  }
  // roguePhase 2: crouched behind the rock, eyes on the origin (hint 6 on the wire)
  r.crouch = 1; r.aim = 0.35;
  e.coverTimer -= dt;
  if (e.coverTimer <= 0) e.roguePhase = 0;
}
