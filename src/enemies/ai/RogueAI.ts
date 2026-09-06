import * as THREE from 'three';
import {
  ROGUE_AIM_ERROR, ROGUE_AIM_ERROR_SETTLED, ROGUE_BURST, ROGUE_GRENADE_COOLDOWN, ROGUE_GRENADE_HOLD_S, ROGUE_GRENADE_RADIUS, ROGUE_GRENADE_RANGE,
  ROGUE_GRENADE_WINDUP, ROGUE_MAG_ROUNDS, ROGUE_REACTION, ROGUE_RELOAD_TIME, ROGUE_RUSH_CHANCE,
} from '@/shared';
import type { Enemy, EnemyHost } from '../Enemy';
import { ROGUE_AI } from '../EnemyTypes';
import type { CombatTarget } from '../Targets';
import { lookAtTarget } from './Common';
import { integrate } from './EnemyAI';
import { pickCover } from './RogueCover';

/* ────────────────────────────────────────────────────────────────────────────
 * Rogue gunner AI (Phase 4, v2 in Phase 7). Guards idle / patrol around `guardPos` (a crate, or the boss it escorts),
 * react after ROGUE_REACTION, then loop a cover cycle: move to cover → crouch-hold 2–4 s → pop out and fire a burst →
 * (rush with ROGUE_RUSH_CHANCE) → next cover. Shots are resolved by `host.fireGun` (hitscan, occlusion, damage, FX,
 * events). Uses the shared EnemyState machine: idle / wander (patrol), alert (reaction), chase (cover cycle via
 * `roguePhase`), stagger, dead. Movement goes through EnemyAI.integrate like every other enemy.
 *
 * v2 (Phase 7):
 * - cover must block the line of sight and is scored with a flank preference (`RogueCover.ts`);
 * - a magazine of ROGUE_MAG_ROUNDS: every shot spends one round, an empty mag forces a ROGUE_RELOAD_TIME crouched reload
 *   (no shots, hint 12, the `reload` sound at the rogue) regardless of the cover phase;
 * - a grenade toss when the target has been out of sight for ROGUE_GRENADE_HOLD_S within ROGUE_GRENADE_RANGE and the
 *   per-rogue cooldown is over: ROGUE_GRENADE_WINDUP standing throw pose (hint 13, grenade sphere in the off hand), then
 *   `host.throwGrenade` (the boss and its escorts use it too).
 * ──────────────────────────────────────────────────────────────────────────── */

const TWO_PI = Math.PI * 2;
/** Never toss a grenade at something inside its own blast (plus a margin). */
const GRENADE_MIN_DIST = ROGUE_GRENADE_RADIUS + 1.5;

export function updateRogue(e: Enemy, dt: number, host: EnemyHost, t: CombatTarget | null, targetAlive: boolean): void {
  const ctx = host.ctx;
  const world = ctx.world!;
  const s = e.stats;
  const a = e.anim;

  // escorts follow the boss (leash to it); a dead boss frees them where they stand
  if (e.escortOf) {
    if (e.escortOf.isCombatant) e.guardPos.copy(e.escortOf.position);
    else { e.escortOf = null; e.guardPos.copy(e.position); e.leash = ROGUE_AI.leash; }
  }
  if (e.hitCrouchTimer > 0) e.hitCrouchTimer -= dt;
  if (e.grenadeCd > 0) e.grenadeCd -= dt;
  // reload runs in every state (a staggered / relocating rogue keeps working the magazine)
  if (e.reloadTimer > 0) {
    e.reloadTimer -= dt;
    if (e.reloadTimer <= 0) { e.reloadTimer = 0; e.magRounds = ROGUE_MAG_ROUNDS; }
  }
  // LOS hold: how long the current target has been hidden while we hunt it (grenade trigger)
  if (e.aware && targetAlive && e.state === 'chase') e.noLosHold = e.hasLOS ? 0 : e.noLosHold + dt;
  else e.noLosHold = 0;

  // nobody left to fight → stand down
  if (!targetAlive && e.aware && (e.state === 'chase' || e.state === 'alert')) {
    e.aware = false; e.state = 'idle'; e.stateTime = 0; e.wanderTimer = 1.5; e.roguePhase = 0; e.burstLeft = 0; e.throwTimer = 0;
  }

  let speed = 0;
  let aimT = e.aware ? 0.5 : 0;
  let crouchT = 0;
  e.hasMoveTarget = false;
  e.hasFacePoint = false;

  switch (e.state) {
    case 'idle': {
      e.wanderTimer -= dt;
      a.headYaw = THREE.MathUtils.lerp(a.headYaw, Math.sin(a.time * 0.5) * 0.5, dt * 2);
      a.headPitch = THREE.MathUtils.lerp(a.headPitch, 0, dt * 3);
      if (e.wanderTimer <= 0) {
        const ang = Math.random() * TWO_PI;
        const rad = e.escortOf ? 3 + Math.random() * 3 : 6 + Math.random() * 6;
        e.moveTarget.set(e.guardPos.x + Math.cos(ang) * rad, 0, e.guardPos.z + Math.sin(ang) * rad);
        if (!world.isInsideBounds(e.moveTarget.x, e.moveTarget.z)) e.moveTarget.copy(e.guardPos);
        e.state = 'wander'; e.stateTime = 0;
      }
      break;
    }
    case 'wander': {
      e.hasMoveTarget = true;
      speed = s.wanderSpeed;
      const dx = e.moveTarget.x - e.position.x, dz = e.moveTarget.z - e.position.z;
      if (dx * dx + dz * dz < 0.6 || e.stateTime > 8) { e.state = 'idle'; e.stateTime = 0; e.wanderTimer = 2 + Math.random() * 4; }
      break;
    }
    case 'alert': {
      // reaction delay: turn toward the threat, raise the rifle
      if (targetAlive) { e.facePoint.copy(t!.position); e.hasFacePoint = true; lookAtTarget(e, t!, dt); }
      aimT = 0.8;
      if (e.stateTime >= ROGUE_REACTION) { e.state = 'chase'; e.stateTime = 0; e.roguePhase = 0; }
      break;
    }
    case 'chase': {
      if (!targetAlive) { e.state = 'idle'; e.stateTime = 0; e.wanderTimer = 1; e.roguePhase = 0; break; }
      const r = coverCycle(e, dt, host, t!);
      speed = r.speed; aimT = r.aim; crouchT = r.crouch;
      break;
    }
    case 'stagger': {
      e.staggerTimer -= dt;
      if (e.incapTimer > 0) {
        // 전소: rifle dropped to the hip, writhing (anim.writhe); no cover cycle, no shots
        e.incapTimer = Math.max(0, e.incapTimer - dt);
        crouchT = 0.35; aimT = 0;
      } else {
        crouchT = 0.5;
        a.headPitch = THREE.MathUtils.lerp(a.headPitch, 0.3, dt * 6);
      }
      if (e.staggerTimer <= 0 && e.incapTimer <= 0) {
        e.incapTimer = 0;
        e.state = e.aware && targetAlive ? 'chase' : 'idle';
        e.stateTime = 0; e.wanderTimer = 1; e.roguePhase = 0;
      }
      break;
    }
    default: break;
  }

  // reloading overrides the pose in every state: crouched, rifle down (hint 12)
  if (e.reloadTimer > 0 && e.state !== 'stagger') { crouchT = Math.max(crouchT, 1); aimT = Math.min(aimT, 0.25); }

  a.aim += (aimT - a.aim) * Math.min(1, dt * (aimT > a.aim ? 7 : 3));
  a.crouch += (crouchT - a.crouch) * Math.min(1, dt * 7);
  a.shake = Math.max(0, a.shake - dt * 4);
  integrate(e, dt, world, host, speed, false);
}

/** True while the rifle may fire (magazine not empty, not reloading, not winding up a throw). */
function canShoot(e: Enemy): boolean {
  return e.reloadTimer <= 0 && e.magRounds > 0 && e.throwTimer <= 0;
}

/** One rifle shot: spends a round; an empty magazine starts the reload right away (crouch, no shots, `reload` audio). */
function shoot(e: Enemy, host: EnemyHost, t: CombatTarget, aimError: number, boss: boolean): void {
  host.fireGun(e, t, aimError, boss ? ROGUE_AI.bossDamageMul : 1);
  e.anim.recoil = 1;
  e.magRounds = Math.max(0, e.magRounds - 1);
  if (e.magRounds === 0) startReload(e, host);
}

function startReload(e: Enemy, host: EnemyHost): void {
  e.reloadTimer = ROGUE_RELOAD_TIME;
  e.burstLeft = 0;
  host.playAudio('reload', e.position, 0.7, e.type === 'rogue_boss' ? 0.85 : 1);
}

/**
 * Grenade trigger: the target has been hidden for ROGUE_GRENADE_HOLD_S, is within range but outside our own blast,
 * the cooldown is over and nothing else (reload, stagger) is going on. Starts the wind-up (hint 13).
 */
function maybeStartThrow(e: Enemy, t: CombatTarget): boolean {
  if (e.throwTimer > 0 || e.grenadeCd > 0 || e.reloadTimer > 0 || e.hasLOS) return false;
  if (e.noLosHold < ROGUE_GRENADE_HOLD_S) return false;
  const d = e.distToTarget;
  if (d > ROGUE_GRENADE_RANGE || d < GRENADE_MIN_DIST) return false;
  e.throwTimer = ROGUE_GRENADE_WINDUP;
  e.grenadeTarget.copy(t.position);
  e.burstLeft = 0;
  e.stateTime = 0;
  return true;
}

interface CycleResult { speed: number; aim: number; crouch: number }
const cycle: CycleResult = { speed: 0, aim: 0, crouch: 0 };

/** One tick of the cover cycle while a live target exists. */
function coverCycle(e: Enemy, dt: number, host: EnemyHost, t: CombatTarget): CycleResult {
  const s = e.stats;
  const r = cycle;
  const d = e.distToTarget;
  const boss = e.type === 'rogue_boss';
  r.speed = 0; r.aim = 1; r.crouch = 0;
  lookAtTarget(e, t, dt);

  // grenade wind-up (Phase 7): step out beside the rock first (a lob from behind it would bounce straight back),
  // then stand, face the last known position and toss
  if (e.throwTimer > 0) {
    e.facePoint.copy(e.grenadeTarget); e.hasFacePoint = true;
    r.aim = 0.2; r.crouch = 0;
    if (e.hasPop && e.stateTime < 2) {
      const dx = e.popPos.x - e.position.x, dz = e.popPos.z - e.position.z;
      if (dx * dx + dz * dz > 0.36) {
        e.moveTarget.copy(e.popPos); e.hasMoveTarget = true;
        r.speed = s.speed * 0.85;
        return r;                                   // the wind-up itself starts once we are out
      }
    }
    e.throwTimer -= dt;
    if (e.throwTimer <= 0) {
      e.throwTimer = 0;
      if (host.throwGrenade(e, e.grenadeTarget)) {
        e.grenadeCd = ROGUE_GRENADE_COOLDOWN * (boss ? 0.7 : 1) * (0.9 + Math.random() * 0.2);
        e.noLosHold = 0;
      } else {
        // launch path blocked (rock in the face): try again in a moment from somewhere else
        e.grenadeCd = 2;
        e.noLosHold = ROGUE_GRENADE_HOLD_S * 0.5;
      }
      // back to cover after the toss (the blast will flush the target; a short hold keeps us from popping into it)
      e.roguePhase = 0; e.stateTime = 0;
    }
    return r;
  }

  // leash: never wander off the crate / boss unless rushing or the fight is right here
  const leashD = Math.hypot(e.position.x - e.guardPos.x, e.position.z - e.guardPos.z);
  if (e.roguePhase !== 4 && leashD > e.leash && !(e.hasLOS && d < 30)) {
    e.moveTarget.copy(e.guardPos); e.hasMoveTarget = true;
    e.facePoint.copy(t.position); e.hasFacePoint = true;
    e.roguePhase = 0;
    r.speed = s.speed; r.aim = 0.6;
    return r;
  }

  // a hidden target inside grenade range gets a grenade instead of another cover shuffle (not while rushing)
  if (e.roguePhase !== 4 && maybeStartThrow(e, t)) { r.aim = 0.2; return r; }

  if (e.roguePhase === 0) {
    pickCover(e, host, t);
    e.roguePhase = 1;
    e.noLosTimer = 0;
  }
  switch (e.roguePhase) {
    case 1: {
      e.facePoint.copy(t.position); e.hasFacePoint = true;
      r.aim = 0.7;
      if (e.hasCover) {
        e.moveTarget.copy(e.coverPos); e.hasMoveTarget = true;
        r.speed = s.speed;
        const dx = e.coverPos.x - e.position.x, dz = e.coverPos.z - e.position.z;
        if (dx * dx + dz * dz < 0.8 || e.stateTime > 6) enterCover(e, boss);
        else if (e.hasLOS && e.burstTimer <= 0 && d < 45 && canShoot(e) && Math.random() < dt * 0.6) {
          // an occasional snap shot while relocating
          shoot(e, host, t, ROGUE_AIM_ERROR * 1.5, boss);
          e.burstTimer = 0.6;
        }
        e.burstTimer -= dt;
      } else enterCover(e, boss);
      break;
    }
    case 2: {
      // crouched behind cover (hint 6); a reload extends the hold until it is done
      r.crouch = 1; r.aim = 0.35;
      e.facePoint.copy(t.position); e.hasFacePoint = true;
      e.coverTimer -= dt;
      if (e.reloadTimer > 0) break;
      if (e.coverTimer <= 0 || d < 6) popOut(e, boss);
      break;
    }
    case 3: {
      // popped out: step out beside the rock (`popPos`, v2) and fire the burst standing (hint 5)
      e.facePoint.copy(t.position); e.hasFacePoint = true;
      r.crouch = e.hitCrouchTimer > 0 ? 0.7 : 0;
      let stepping = false;
      if (e.hasPop) {
        const dx = e.popPos.x - e.position.x, dz = e.popPos.z - e.position.z;
        if (dx * dx + dz * dz > 0.36 && e.stateTime < 2.5) {
          e.moveTarget.copy(e.popPos); e.hasMoveTarget = true;
          r.speed = s.speed * 0.85;
          stepping = true;
        }
      }
      if (!stepping) e.standTime += dt;
      if (!e.hasLOS) {
        // the target moved: wait a moment (not while still stepping out), then pick a new rock
        if (!stepping) e.noLosTimer += dt;
        if (e.noLosTimer > 1.2) { e.roguePhase = 0; e.stateTime = 0; }
        break;
      }
      e.noLosTimer = 0;
      e.burstTimer -= dt;
      if (e.reloadTimer > 0) {
        // the magazine ran dry mid-burst: duck back into cover for the rest of the reload
        e.roguePhase = 2; e.coverTimer = 0.4; e.stateTime = 0;
        break;
      }
      if (e.burstLeft > 0) {
        if (e.burstTimer <= 0 && e.hitCrouchTimer <= 0 && canShoot(e)) {
          const err = THREE.MathUtils.lerp(ROGUE_AIM_ERROR, ROGUE_AIM_ERROR_SETTLED, THREE.MathUtils.clamp(e.standTime / ROGUE_AI.settleTime, 0, 1));
          shoot(e, host, t, err, boss);
          e.burstLeft--;
          e.burstTimer = e.burstLeft > 0 ? ROGUE_AI.shotGap : 0.5;
        }
      } else if (e.burstTimer <= 0) {
        if (Math.random() < ROGUE_RUSH_CHANCE && d > ROGUE_AI.rushDist + 3) { e.roguePhase = 4; e.rushTimer = 0; e.burstTimer = 0.2; }
        else { e.roguePhase = 0; e.stateTime = 0; }
      }
      break;
    }
    case 4: {
      // rushing: close to ~8 m while firing from the hip (hint 7)
      e.moveTarget.copy(t.position); e.hasMoveTarget = true;
      e.facePoint.copy(t.position); e.hasFacePoint = true;
      r.speed = s.speed * 1.1;
      e.rushTimer += dt;
      e.burstTimer -= dt;
      if (e.burstTimer <= 0 && e.hasLOS && canShoot(e)) {
        shoot(e, host, t, ROGUE_AIM_ERROR * 1.6, boss);
        e.burstTimer = 0.28;
      }
      if (d <= ROGUE_AI.rushDist || e.rushTimer > ROGUE_AI.rushMax) { e.roguePhase = 0; e.stateTime = 0; }
      break;
    }
  }
  return r;
}

function enterCover(e: Enemy, boss: boolean): void {
  e.roguePhase = 2;
  e.coverTimer = e.hasCover ? ROGUE_AI.coverMin + Math.random() * (ROGUE_AI.coverMax - ROGUE_AI.coverMin) : 0.8 + Math.random() * 1.2;
  if (boss) e.coverTimer *= 0.6;
  e.stateTime = 0;
}

function popOut(e: Enemy, boss: boolean): void {
  e.roguePhase = 3;
  e.burstLeft = Math.min(e.magRounds, boss ? ROGUE_AI.bossRounds : ROGUE_BURST);
  e.burstTimer = 0.15;
  e.standTime = 0;
  e.noLosTimer = 0;
  e.stateTime = 0;
}
