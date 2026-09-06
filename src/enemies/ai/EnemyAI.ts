import * as THREE from 'three';
import { GRAVITY, PLAYER_RADIUS, type WorldRef } from '@/shared';
import type { Enemy, EnemyHost } from '../Enemy';
import { BEHEMOTH_AI, CHARGER_CHARGE, HUNTER_LEAP, SPEWER_SPIT } from '../EnemyTypes';
import type { CombatTarget } from '../Targets';
import { avoidObstacles, seek, separate, turnToward, yawTo } from './Steering';
import { acquireTarget, updatePerception } from './Perception';
import { attackResult, lookAtTarget, startMelee, stumble, type AttackResult } from './Common';
import { updateRogue } from './RogueAI';
import { attackBehemoth, attackToxic, chaseArtillery, chaseBehemoth, chaseToxic } from './GimmickAI';

export { lookAtTarget } from './Common';
import { biteStructure, refreshStructureTarget } from './Structures';

const _desired = new THREE.Vector3();
const _steer = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _prev = new THREE.Vector3();
const _n = new THREE.Vector3();
const _tmp = new THREE.Vector3();

const TWO_PI = Math.PI * 2;

/** A lure at least this strong overrides a live player target (유인 수류탄). */
const LURE_OVERRIDE_WEIGHT = 0.6;
/** Distance at which a bug considers itself "at" the lure and mills around it. */
const LURE_ARRIVE = 2.5;
/** Seconds a suspicion (shot heard from inside smoke) stays actionable. */
export const SUSPICION_TIME = 4;

/**
 * One AI + movement tick for an active bug (host / single-player only). Called only while the gameplay phase is
 * running; visuals are refreshed separately by Enemy.animate so frozen bugs still render.
 * Every player-relative decision goes through `e.target` (a CombatTarget: local or remote player) so the same code
 * hunts one player in single-player and up to four in a session.
 */
export function updateEnemyAI(e: Enemy, dt: number, host: EnemyHost): void {
  const ctx = host.ctx;
  const world = ctx.world;
  if (!world) return;
  const s = e.stats;
  const a = e.anim;

  e.stateTime += dt;
  if (e.attackCd > 0) e.attackCd -= dt;
  if (e.leapCd > 0) e.leapCd -= dt;
  if (e.chargeCd > 0) e.chargeCd -= dt;
  if (e.suspicionTimer > 0) e.suspicionTimer -= dt;
  if (e.slowTimer > 0) { e.slowTimer -= dt; if (e.slowTimer <= 0) e.slowFactor = 1; }
  acquireTarget(e, dt, host);
  const t = e.target;
  const targetAlive = !!t && !t.isDeadOrDowned;

  if (e.state === 'dead') { e.deathTimer += dt; return; }

  if (e.state === 'flee') {
    e.fleeTimer += dt;
    _dir.set(e.position.x - e.fleeFrom.x, 0, e.position.z - e.fleeFrom.z);
    if (_dir.lengthSq() < 1e-4) _dir.set(Math.sin(e.yaw), 0, Math.cos(e.yaw));
    _dir.normalize();
    e.moveTarget.copy(e.position).addScaledVector(_dir, 10);
    e.hasMoveTarget = true; e.hasFacePoint = false;
    integrate(e, dt, world, host, s.speed * 1.4, false);
    return;
  }

  e.obstacleTimer -= dt;
  if (e.obstacleTimer <= 0) {
    e.obstacleTimer = 0.25;
    e.nearObstacles = world.getObstaclesNear(e.position.x, e.position.z, 7);
  }

  updatePerception(e, dt, host);
  refreshStructureTarget(e, dt, host, t);

  // A lure (유인 수류탄 / 소음) drags a patrolling or idle bug toward the noise.
  if (e.hasLure && e.lureWeight >= 0.35 && (e.state === 'idle' || e.state === 'wander')
    && (!targetAlive || !e.aware || e.lureWeight >= LURE_OVERRIDE_WEIGHT)) {
    if (e.state === 'idle') { e.state = 'wander'; e.stateTime = 0; }
    e.moveTarget.copy(e.lurePos);
  }

  // Phase 4: humanoid gunners run their own state machine (cover cycle) on top of the shared movement integration.
  if (e.isRogue) { updateRogue(e, dt, host, t, targetAlive); return; }

  // Nobody left to hunt: everything calms down.
  if (!targetAlive && e.aware && !e.airborne && e.chargePhase !== 2 && e.toxicPhase === 0 && (e.state === 'chase' || e.state === 'alert' || e.state === 'attack')) {
    e.aware = false; e.state = 'idle'; e.stateTime = 0; e.wanderTimer = 2; e.spawnPos.copy(e.position);
    e.spitPhase = 0; e.chargePhase = 0; a.shake = 0; a.abdomen = 0;
  }

  // default animation targets (states override below)
  let mandibleTarget = e.aware ? 0.25 : 0;
  let speed = s.speed;
  let allowOverlap = false;
  e.hasMoveTarget = false;
  e.hasFacePoint = false;

  switch (e.state) {
    case 'idle': {
      e.wanderTimer -= dt;
      a.headYaw = THREE.MathUtils.lerp(a.headYaw, Math.sin(a.time * 0.7) * 0.35, dt * 3);
      a.headPitch = THREE.MathUtils.lerp(a.headPitch, Math.sin(a.time * 1.1) * 0.1, dt * 3);
      if (e.wanderTimer <= 0) {
        const ang = Math.random() * TWO_PI;
        const rad = 3 + Math.random() * 7;
        e.moveTarget.set(e.spawnPos.x + Math.cos(ang) * rad, 0, e.spawnPos.z + Math.sin(ang) * rad);
        if (!world.isInsideBounds(e.moveTarget.x, e.moveTarget.z)) e.moveTarget.copy(e.spawnPos);
        e.state = 'wander'; e.stateTime = 0;
      }
      break;
    }
    case 'wander': {
      e.hasMoveTarget = true;
      speed = s.wanderSpeed;
      a.headYaw = THREE.MathUtils.lerp(a.headYaw, Math.sin(a.time * 0.9) * 0.3, dt * 3);
      a.headPitch = THREE.MathUtils.lerp(a.headPitch, 0.1, dt * 3);
      const dx = e.moveTarget.x - e.position.x, dz = e.moveTarget.z - e.position.z;
      if (dx * dx + dz * dz < 0.5 || e.stateTime > 7) {
        e.state = 'idle'; e.stateTime = 0; e.wanderTimer = 1.5 + Math.random() * 3;
      }
      break;
    }
    case 'alert': {
      if (targetAlive) { e.facePoint.copy(t!.position); e.hasFacePoint = true; lookAtTarget(e, t!, dt); }
      mandibleTarget = 0.7;
      a.crouch = THREE.MathUtils.lerp(a.crouch, 0.25, dt * 8);
      const dur = e.type === 'scavenger' ? 0.4 : e.type === 'hunter' ? 0.5 : 0.75;
      if (e.stateTime >= dur) { e.state = 'chase'; e.stateTime = 0; a.crouch = 0; }
      break;
    }
    case 'chase': {
      if (!targetAlive) { e.state = 'idle'; e.stateTime = 0; e.wanderTimer = 1; break; }
      speed = chase(e, dt, host, t!);
      break;
    }
    case 'attack': {
      // a spit or bite aimed at a deployable finishes even when no player is alive
      if (!targetAlive && !e.airborne && e.chargePhase !== 2 && e.toxicPhase === 0 && !e.spitAtPoint && !e.structAttack) {
        e.state = 'idle'; e.stateTime = 0; e.spitPhase = 0; e.chargePhase = 0; break;
      }
      const r = attack(e, dt, host, t);
      speed = r.speed; allowOverlap = r.allowOverlap; mandibleTarget = r.mandible;
      break;
    }
    case 'stagger': {
      e.staggerTimer -= dt;
      speed = 0;
      if (e.incapTimer > 0) {
        // 전소: writhing on the spot (pose from anim.writhe), mandibles snapping, no attacks until it wears off
        e.incapTimer = Math.max(0, e.incapTimer - dt);
        a.crouch = THREE.MathUtils.lerp(a.crouch, 0.45, dt * 8);
        a.headPitch = THREE.MathUtils.lerp(a.headPitch, -0.15, dt * 6);
        mandibleTarget = 1;
      } else {
        a.crouch = THREE.MathUtils.lerp(a.crouch, e.type === 'charger' || e.type === 'behemoth' ? 0.5 : 0.3, dt * 10);
        a.headPitch = THREE.MathUtils.lerp(a.headPitch, 0.35, dt * 6);
      }
      if (e.staggerTimer <= 0 && e.incapTimer <= 0) {
        a.crouch = 0;
        e.incapTimer = 0;
        e.state = e.aware && targetAlive ? 'chase' : 'idle';
        e.stateTime = 0; e.wanderTimer = 1;
      }
      break;
    }
    default: break;
  }

  // status effects: burning does not slow, 'slowed' (acid / cryo gadgets) scales every movement state
  if (e.slowFactor < 1) speed *= e.slowFactor;

  a.mandible += (mandibleTarget - a.mandible) * Math.min(1, dt * 10);
  if (e.state !== 'attack') {
    a.shake = Math.max(0, a.shake - dt * 4);
    a.abdomen = Math.max(0, a.abdomen - dt * 2);
    if (e.state !== 'alert' && e.state !== 'stagger' && e.type !== 'artillery') a.crouch = Math.max(0, a.crouch - dt * 5);
  }

  integrate(e, dt, world, host, speed, allowOverlap);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Chase (per type)
 * ──────────────────────────────────────────────────────────────────────────── */
function chase(e: Enemy, dt: number, host: EnemyHost, t: CombatTarget): number {
  const s = e.stats;
  const d = e.distToTarget;
  const tp = t.position;
  const meleeRange = s.attackRange + PLAYER_RADIUS;
  lookAtTarget(e, t, dt);
  e.moveTarget.copy(tp);
  e.hasMoveTarget = true;
  let speed = s.speed;

  // ── a wall / dome / turret in the way gets chewed on first (근접형) ──
  const st = e.structTarget;
  if (st && st.hp > 0 && e.type !== 'spewer' && e.chargePhase === 0 && !e.leaping) {
    const sd = Math.hypot(st.position.x - e.position.x, st.position.z - e.position.z);
    const bite = s.attackRange + s.radius + st.radius + 0.5;
    if (sd <= bite) {
      e.hasFacePoint = true; e.facePoint.copy(st.position);
      e.hasMoveTarget = false;
      if (e.attackCd <= 0) { startMelee(e); e.structAttack = true; }
      return 0;
    }
    if (e.structBlocking) {
      // path toward the obstruction instead of walking into it forever
      e.moveTarget.copy(st.position);
      return speed;
    }
  }

  // ── a strong lure outranks the player (유인 수류탄) ──
  if (e.hasLure && e.lureWeight >= LURE_OVERRIDE_WEIGHT && d > meleeRange + 1) {
    const ld = Math.hypot(e.lurePos.x - e.position.x, e.lurePos.z - e.position.z);
    if (ld > LURE_ARRIVE) { e.moveTarget.copy(e.lurePos); return speed; }
    e.hasMoveTarget = false;
    e.hasFacePoint = true; e.facePoint.copy(e.lurePos);
    // spewers keep shooting the beacon they are milling around
    if (e.type === 'spewer' && st && st.hp > 0 && e.attackCd <= 0) startSpit(e, st.position);
    return 0;
  }

  switch (e.type) {
    case 'scavenger': {
      // weave while approaching so the swarm reads as a churning mass
      if (d > 4) {
        const w = Math.sin(e.anim.time * 2.3 + e.id) * Math.min(2.5, d * 0.15);
        const dx = tp.x - e.position.x, dz = tp.z - e.position.z;
        e.moveTarget.x += -dz / d * w; e.moveTarget.z += dx / d * w;
      }
      if (d < meleeRange && e.attackCd <= 0) startMelee(e);
      break;
    }
    case 'hunter': {
      e.flankTimer -= dt;
      if (e.flankTimer <= 0) { e.flankTimer = 2 + Math.random() * 2.5; if (Math.random() < 0.35) e.flankSign = -e.flankSign; }
      if (d > 4.5) {
        const dx = tp.x - e.position.x, dz = tp.z - e.position.z;
        const off = e.flankSign * Math.min(7, d * 0.5);
        e.moveTarget.x += -dz / d * off; e.moveTarget.z += dx / d * off;
      }
      if (e.hasLOS && e.leapCd <= 0 && e.attackCd <= 0 && d >= HUNTER_LEAP.minDist && d <= HUNTER_LEAP.maxDist) startLeap(e, host);
      else if (d < meleeRange && e.attackCd <= 0) startMelee(e);
      break;
    }
    case 'warrior': {
      if (d < meleeRange && e.attackCd <= 0) startMelee(e);
      break;
    }
    case 'spewer': {
      // 원거리형: destroy lure beacons / barricades / turrets it can reach
      const dep = e.structTarget;
      if (dep && dep.hp > 0 && e.attackCd <= 0) {
        const dd = Math.hypot(dep.position.x - e.position.x, dep.position.z - e.position.z);
        if (dd <= SPEWER_SPIT.maxDist) { startSpit(e, dep.position); break; }
      }
      // very inaccurate return fire toward a shot that came out of a smoke cloud
      if (!e.hasLOS && e.suspicionTimer > 0 && e.attackCd <= 0) {
        const sd = Math.hypot(e.suspicion.x - e.position.x, e.suspicion.z - e.position.z);
        if (sd <= SPEWER_SPIT.maxDist) {
          _tmp.copy(e.suspicion);
          _tmp.x += (Math.random() * 2 - 1) * e.suspicionSpread;
          _tmp.z += (Math.random() * 2 - 1) * e.suspicionSpread;
          startSpit(e, _tmp);
          break;
        }
      }
      if (d < 6.5) {
        if (d < meleeRange && e.attackCd <= 0) startMelee(e);
      } else if (d < 9) {
        // keep distance: back away while facing the target
        const dx = e.position.x - tp.x, dz = e.position.z - tp.z;
        e.moveTarget.set(e.position.x + dx / d * 4, 0, e.position.z + dz / d * 4);
        e.facePoint.copy(tp); e.hasFacePoint = true;
        speed = s.speed * 0.7;
        if (e.hasLOS && e.attackCd <= 0 && d >= SPEWER_SPIT.minDist) startSpit(e);
      } else if (d <= SPEWER_SPIT.maxDist && e.hasLOS) {
        if (e.attackCd <= 0) startSpit(e);
        else { e.hasMoveTarget = false; e.facePoint.copy(tp); e.hasFacePoint = true; }
      }
      break;
    }
    case 'charger': {
      if (e.hasLOS && e.chargeCd <= 0 && d >= CHARGER_CHARGE.minDist && d <= CHARGER_CHARGE.maxDist) startCharge(e, host);
      else if (d < meleeRange && e.attackCd <= 0) startMelee(e);
      break;
    }
    /* Phase 4 gimmicks */
    case 'artillery': speed = chaseArtillery(e, dt, host, t); break;
    case 'toxic': speed = chaseToxic(e, dt, host, t); break;
    case 'behemoth': speed = chaseBehemoth(e, dt, host, t); break;
    default: break;
  }
  return speed;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Attacks
 * ──────────────────────────────────────────────────────────────────────────── */

function startLeap(e: Enemy, host: EnemyHost): void {
  e.state = 'attack'; e.stateTime = 0;
  e.attackTimer = 0; e.attackHitDone = false;
  e.airborne = false; // becomes true after the crouch
  e.leaping = true;
  e.spitPhase = 0; e.chargePhase = 0;
  host.playAudio('bug_screech', e.position, 0.6, 1.3);
}

/** `point` (optional) → spit at that spot instead of at the current player target. */
function startSpit(e: Enemy, point?: THREE.Vector3): void {
  e.state = 'attack'; e.stateTime = 0;
  e.attackTimer = 0; e.attackHitDone = false;
  e.spitPhase = 1;
  if (point) { e.spitAtPoint = true; e.spitPoint.copy(point); }
  else e.spitAtPoint = false;
}

function startCharge(e: Enemy, host: EnemyHost): void {
  e.state = 'attack'; e.stateTime = 0;
  e.attackTimer = 0; e.attackHitDone = false;
  e.chargePhase = 1; e.chargeTimer = 0;
  host.playAudio('bug_screech', e.position, 1.0, 0.5);
}

/** `t` may be a dead target only while a charge rush / leap is already in flight (those finish regardless). */
function attack(e: Enemy, dt: number, host: EnemyHost, t: CombatTarget | null): AttackResult {
  const s = e.stats;
  const a = e.anim;
  const r = attackResult;
  r.speed = 0; r.allowOverlap = false; r.mandible = 0.3;
  e.attackTimer += dt;
  const tp = t ? t.position : e.position;

  // ── Phase 4 gimmicks ──────────────────────────────────────────────────
  if (e.type === 'toxic' && e.toxicPhase > 0) return attackToxic(e, dt, host, t, r);
  if (e.type === 'behemoth' && e.chargePhase > 0) return attackBehemoth(e, dt, host, t, r);

  // ── charger: wind-up → rush ───────────────────────────────────────────
  if (e.chargePhase === 1) {
    e.facePoint.copy(tp); e.hasFacePoint = true;
    if (t) lookAtTarget(e, t, dt);
    a.shake = Math.min(1, e.attackTimer / CHARGER_CHARGE.windup);
    a.crouch = a.shake * 0.35;
    r.mandible = 1;
    if (e.attackTimer >= CHARGER_CHARGE.windup) {
      e.chargePhase = 2; e.chargeTimer = 0;
      e.chargeDir.set(tp.x - e.position.x, 0, tp.z - e.position.z);
      if (e.chargeDir.lengthSq() < 1e-4) e.facing(e.chargeDir); else e.chargeDir.normalize();
      e.yaw = Math.atan2(e.chargeDir.x, e.chargeDir.z);
      a.shake = 0; a.crouch = 0;
      host.playAudio('bug_attack', e.position, 1.0, 0.5);
    }
    return r;
  }
  if (e.chargePhase === 2) {
    e.chargeTimer += dt;
    r.allowOverlap = true; r.speed = CHARGER_CHARGE.speed; r.mandible = 1;
    e.velocity.set(e.chargeDir.x * CHARGER_CHARGE.speed, 0, e.chargeDir.z * CHARGER_CHARGE.speed);
    e.hasFacePoint = false; e.hasMoveTarget = false;
    a.headYaw = THREE.MathUtils.lerp(a.headYaw, 0, dt * 6);
    a.headPitch = THREE.MathUtils.lerp(a.headPitch, -0.2, dt * 6);
    // contact with any player in the path (not only the one it aimed at)
    const hitR = s.radius + PLAYER_RADIUS + 0.35;
    const victim = host.targets.nearestAliveWithin(e.position, hitR);
    if (victim) {
      host.hitTarget(e, CHARGER_CHARGE.damage, 1.0, victim);
      stumble(e, CHARGER_CHARGE.cooldown, CHARGER_CHARGE.stumble);
      return r;
    }
    // overshot the target
    const passed = (tp.x - e.position.x) * e.chargeDir.x + (tp.z - e.position.z) * e.chargeDir.z;
    if ((passed < -2.5 && e.chargeTimer > 0.4) || e.chargeTimer > CHARGER_CHARGE.maxDuration) { stumble(e, CHARGER_CHARGE.cooldown, CHARGER_CHARGE.stumble); return r; }
    return r;
  }

  // ── spewer: spit wind-up ──────────────────────────────────────────────
  if (e.spitPhase === 1) {
    const aimAt = e.spitAtPoint ? e.spitPoint : tp;
    e.facePoint.copy(aimAt); e.hasFacePoint = true;
    if (t && !e.spitAtPoint) lookAtTarget(e, t, dt);
    a.abdomen = Math.min(1, e.attackTimer / SPEWER_SPIT.windup);
    a.crouch = a.abdomen * 0.2;
    r.mandible = a.abdomen;
    if (e.attackTimer >= SPEWER_SPIT.windup) {
      if (e.spitAtPoint) {
        e.headCenter(_tmp);
        _tmp.y += 0.1;
        host.fireAcidAt(_tmp, e.spitPoint, e);
        // globs only test players and terrain, so a targeted structure takes the damage directly
        const dep = e.structTarget;
        if (dep && dep.hp > 0 && Math.hypot(dep.position.x - e.spitPoint.x, dep.position.z - e.spitPoint.z) < 1.5) {
          dep.takeDamage(SPEWER_SPIT.damage, e.position);
        }
        host.playAudio('bug_attack', e.position, 0.9, 0.7);
        e.spitAtPoint = false;
      } else if (t && !t.isDeadOrDowned) {
        e.headCenter(_tmp);
        _tmp.y += 0.1;
        host.fireAcid(_tmp, e, t);
        host.playAudio('bug_attack', e.position, 0.9, 0.7);
      }
      e.spitPhase = 0;
      e.attackCd = SPEWER_SPIT.cooldown * (0.85 + Math.random() * 0.3);
      e.state = 'chase'; e.stateTime = 0;
      a.abdomen = 0.2;
    }
    return r;
  }

  // ── hunter: leap ──────────────────────────────────────────────────────
  if (e.leaping) {
    const crouchTime = 0.2;
    if (!e.airborne) {
      e.facePoint.copy(tp); e.hasFacePoint = true;
      a.crouch = Math.min(1, e.attackTimer / crouchTime);
      r.mandible = 0.8;
      if (e.attackTimer >= crouchTime) {
        const T = HUNTER_LEAP.flightTime;
        _tmp.copy(tp);
        if (t) _tmp.addScaledVector(t.velocity, T * 0.5);
        e.velocity.set((_tmp.x - e.position.x) / T, 0, (_tmp.z - e.position.z) / T);
        const vmax = 16;
        if (e.velocity.length() > vmax) e.velocity.setLength(vmax);
        e.vy = (_tmp.y - e.position.y) / T + 0.5 * GRAVITY * T;
        e.airborne = true;
        a.crouch = 0;
        e.yaw = Math.atan2(e.velocity.x, e.velocity.z);
        host.playAudio('bug_attack', e.position, 0.8, 1.2);
      }
      return r;
    }
    // airborne
    e.vy -= GRAVITY * dt;
    e.position.x += e.velocity.x * dt;
    e.position.z += e.velocity.z * dt;
    e.position.y += e.vy * dt;
    const world = host.ctx.world!;
    world.resolveCollision(e.position, s.radius);
    const ground = world.getHeightAt(e.position.x, e.position.z);
    a.crouch = -0.3; // stretched
    a.headPitch = THREE.MathUtils.lerp(a.headPitch, 0.3, dt * 5);
    r.mandible = 1;
    if (e.position.y <= ground && e.attackTimer > crouchTime + 0.15) {
      e.position.y = ground;
      e.airborne = false;
      e.leaping = false;
      e.vy = 0;
      e.velocity.multiplyScalar(0.2);
      const victim = host.targets.nearestAliveWithin(e.position, HUNTER_LEAP.hitRadius);
      if (victim) host.hitTarget(e, HUNTER_LEAP.damage, 0.5, victim);
      else host.playAudio('bug_step', e.position, 0.6, 1.1);
      e.leapCd = HUNTER_LEAP.cooldown * (0.8 + Math.random() * 0.5);
      e.attackCd = 0.5;
      e.state = 'chase'; e.stateTime = 0;
      a.crouch = 0.6; // land squash, decays in the chase state
    }
    return r;
  }

  // ── generic melee (a player, or a deployable that blocks the way) ──────
  const struct = e.structAttack ? e.structTarget : null;
  const aim = struct ? struct.position : tp;
  e.facePoint.copy(aim); e.hasFacePoint = true;
  if (t && !struct) lookAtTarget(e, t, dt);
  const windup = s.attackWindup;
  const reach = s.attackRange + PLAYER_RADIUS + 0.6;
  const structReach = struct ? s.attackRange + s.radius + struct.radius + 0.8 : 0;
  if (e.attackTimer < windup) {
    r.mandible = 0.05;
    a.crouch = (e.attackTimer / windup) * 0.3;
    // creep toward the target during wind-up so it does not stall at the edge of range
    if (!struct && e.distToTarget > s.attackRange * 0.7) { e.moveTarget.copy(tp); e.hasMoveTarget = true; r.speed = s.speed * 0.6; }
  } else {
    if (!e.attackHitDone) {
      e.attackHitDone = true;
      a.crouch = 0;
      a.flinch = Math.max(a.flinch, 0.5); a.flinchZ = 0.8; a.flinchX = 0;   // lunge forward (nose dips)
      if (struct && struct.hp > 0 && Math.hypot(struct.position.x - e.position.x, struct.position.z - e.position.z) < structReach) {
        biteStructure(e, host, struct);
      } else if (!struct && t && !t.isDeadOrDowned && e.distToTarget < reach) {
        host.hitTarget(e, s.attackDamage, e.type === 'warrior' || e.type === 'charger' || e.type === 'behemoth' ? 0.45 : 0.18, t);
      } else host.playAudio('bug_attack', e.position, 0.5, 1.1);
    }
    r.mandible = 1;
    if (e.attackTimer >= windup + 0.3) {
      e.attackCd = s.attackCooldown * (0.85 + Math.random() * 0.3);
      e.structAttack = false;
      e.state = 'chase'; e.stateTime = 0;
    }
  }
  return r;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Movement integration (shared by every grounded state)
 * ──────────────────────────────────────────────────────────────────────────── */
export function integrate(e: Enemy, dt: number, world: WorldRef, host: EnemyHost, speed: number, allowOverlap: boolean): void {
  const s = e.stats;
  const a = e.anim;
  const pos = e.position;
  const charging = e.chargePhase === 2;

  if (e.airborne) {
    // handled in the leap branch; only refresh gait/animation speed
    a.speed = THREE.MathUtils.lerp(a.speed, 0.2, dt * 5);
    return;
  }

  if (!charging) {
    if (e.hasMoveTarget && speed > 0) seek(pos, e.moveTarget, speed, e.state === 'wander' ? 1.5 : 0.6, _desired);
    else _desired.set(0, 0, 0);
    _steer.set(0, 0, 0);
    const dl = _desired.lengthSq();
    if (dl > 0.01) {
      _dir.copy(_desired).multiplyScalar(1 / Math.sqrt(dl));
      avoidObstacles(e, _dir, _steer);
      _desired.addScaledVector(_steer, Math.max(1, speed) * 0.4);
      const max = Math.max(speed, 0.1) * 1.15;
      if (_desired.lengthSq() > max * max) _desired.setLength(max);
    }
    const rate = s.accel / Math.max(1, s.speed);
    const k = 1 - Math.exp(-rate * dt);
    e.velocity.x += (_desired.x - e.velocity.x) * k;
    e.velocity.z += (_desired.z - e.velocity.z) * k;
    e.velocity.y = 0;
  }

  // separation (positional + soft steering)
  _steer.set(0, 0, 0);
  separate(e, host.grid, host.targets.all, _steer, allowOverlap || charging);
  if (!charging) e.velocity.addScaledVector(_steer, dt * 4);

  _prev.copy(pos);
  pos.x += e.velocity.x * dt;
  pos.z += e.velocity.z * dt;
  world.resolveCollision(pos, s.radius);
  if (charging) {
    // hitting a rock / wall or leaving the map interrupts the charge
    const intendedX = _prev.x + e.velocity.x * dt, intendedZ = _prev.z + e.velocity.z * dt;
    const dev = Math.hypot(pos.x - intendedX, pos.z - intendedZ);
    if (dev > 0.05 || !world.isInsideBounds(pos.x + e.chargeDir.x * 2, pos.z + e.chargeDir.z * 2)) {
      const big = e.type === 'behemoth';
      stumble(e, big ? BEHEMOTH_AI.chargeCooldown : CHARGER_CHARGE.cooldown, big ? BEHEMOTH_AI.stumble : CHARGER_CHARGE.stumble);
      host.playAudio('bug_step', pos, 1.0, big ? 0.35 : 0.5);
      if (host.targets.distToLocal(pos) < (big ? 45 : 25)) host.ctx.bus.emit('camera:shake', { intensity: big ? 0.6 : 0.35, duration: 0.35 });
    }
  }
  pos.y = world.getHeightAt(pos.x, pos.z);

  // gait from distance travelled
  const moved = Math.hypot(pos.x - _prev.x, pos.z - _prev.z);
  e.distTravelled += moved;
  a.gait += (moved / e.rig.params.strideLength) * TWO_PI;
  if (a.gait > 1e6) a.gait -= 1e6;
  const spd = dt > 0 ? moved / dt : 0;
  const targetAnimSpeed = Math.min(1, spd / Math.max(1, s.speed * 0.8));
  a.speed += (targetAnimSpeed - a.speed) * Math.min(1, dt * 8);

  // footsteps (heavies only, near the local listener)
  if (s.stepSound) {
    const dl = host.targets.distToLocal(pos);
    if (dl < 30) {
      e.stepAccum += moved;
      if (e.stepAccum >= e.rig.params.strideLength * 0.5) {
        e.stepAccum = 0;
        const heavy = e.type === 'charger' || e.type === 'behemoth';
        const vol = THREE.MathUtils.clamp(1 - dl / 30, 0.1, 1) * (heavy ? 1 : 0.6);
        host.playAudio('bug_step', pos, vol, e.type === 'behemoth' ? 0.4 : e.type === 'charger' ? 0.6 : 0.9);
        if (e.type === 'behemoth' && dl < 40) host.ctx.bus.emit('camera:shake', { intensity: 0.12 * (1 - dl / 40), duration: 0.2 });
      }
    }
  }

  // yaw
  let targetYaw = e.yaw;
  if (e.hasFacePoint) targetYaw = yawTo(pos, e.facePoint);
  else if (e.velocity.x * e.velocity.x + e.velocity.z * e.velocity.z > 0.2) targetYaw = Math.atan2(e.velocity.x, e.velocity.z);
  e.yaw = turnToward(e.yaw, targetYaw, s.turnRate * (charging ? 0.3 : 1), dt);

  // slope conforming
  applySlope(e, world, dt);
}

/** Tilt the body with the terrain normal (shared with the replica driver). */
export function applySlope(e: Enemy, world: WorldRef, dt: number): void {
  const a = e.anim;
  world.getNormalAt(e.position.x, e.position.z, _n);
  const fx = Math.sin(e.yaw), fz = Math.cos(e.yaw);
  const pitch = (_n.x * fx + _n.z * fz) * 0.7;
  const roll = -(_n.x * fz - _n.z * fx) * 0.7;
  a.slopePitch += (pitch - a.slopePitch) * Math.min(1, dt * 6);
  a.slopeRoll += (roll - a.slopeRoll) * Math.min(1, dt * 6);
}
