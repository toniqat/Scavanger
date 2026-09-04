import * as THREE from 'three';
import { GRAVITY, PLAYER_RADIUS, type PlayerRef, type WorldRef } from '@/shared';
import type { Enemy, EnemyHost } from '../Enemy';
import { CHARGER_CHARGE, HUNTER_LEAP, SPEWER_SPIT } from '../EnemyTypes';
import { avoidObstacles, seek, separate, turnToward, yawTo } from './Steering';
import { updatePerception } from './Perception';

const _desired = new THREE.Vector3();
const _steer = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _prev = new THREE.Vector3();
const _n = new THREE.Vector3();
const _tmp = new THREE.Vector3();

const TWO_PI = Math.PI * 2;

/**
 * One AI + movement tick for an active bug. Called only while the gameplay phase is running;
 * visuals are refreshed separately by Enemy.animate so frozen bugs still render.
 */
export function updateEnemyAI(e: Enemy, dt: number, host: EnemyHost): void {
  const ctx = host.ctx;
  const world = ctx.world;
  if (!world) return;
  const player = ctx.player;
  const s = e.stats;
  const a = e.anim;
  const playerAlive = !!player && !player.isDead;

  e.stateTime += dt;
  if (e.attackCd > 0) e.attackCd -= dt;
  if (e.leapCd > 0) e.leapCd -= dt;
  if (e.chargeCd > 0) e.chargeCd -= dt;
  e.distToPlayer = playerAlive ? Math.hypot(player!.position.x - e.position.x, player!.position.z - e.position.z) : Infinity;

  if (e.state === 'dead') { e.deathTimer += dt; return; }

  if (e.state === 'flee') {
    e.fleeTimer += dt;
    _dir.set(e.position.x - e.fleeFrom.x, 0, e.position.z - e.fleeFrom.z);
    if (_dir.lengthSq() < 1e-4) _dir.set(Math.sin(e.yaw), 0, Math.cos(e.yaw));
    _dir.normalize();
    e.moveTarget.copy(e.position).addScaledVector(_dir, 10);
    e.hasMoveTarget = true; e.hasFacePoint = false;
    integrate(e, dt, world, player, host, s.speed * 1.4, false);
    return;
  }

  e.obstacleTimer -= dt;
  if (e.obstacleTimer <= 0) {
    e.obstacleTimer = 0.25;
    e.nearObstacles = world.getObstaclesNear(e.position.x, e.position.z, 7);
  }

  updatePerception(e, dt, host);

  // Player died: everything calms down.
  if (!playerAlive && e.aware && !e.airborne && e.chargePhase !== 2 && (e.state === 'chase' || e.state === 'alert' || e.state === 'attack')) {
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
      if (playerAlive) { e.facePoint.copy(player!.position); e.hasFacePoint = true; lookAtPlayer(e, player!, dt); }
      mandibleTarget = 0.7;
      a.crouch = THREE.MathUtils.lerp(a.crouch, 0.25, dt * 8);
      const dur = e.type === 'scavenger' ? 0.4 : e.type === 'hunter' ? 0.5 : 0.75;
      if (e.stateTime >= dur) { e.state = 'chase'; e.stateTime = 0; a.crouch = 0; }
      break;
    }
    case 'chase': {
      if (!playerAlive) { e.state = 'idle'; e.stateTime = 0; e.wanderTimer = 1; break; }
      speed = chase(e, dt, host, player!);
      break;
    }
    case 'attack': {
      if (!playerAlive && !e.airborne && e.chargePhase !== 2) { e.state = 'idle'; e.stateTime = 0; e.spitPhase = 0; e.chargePhase = 0; break; }
      const r = attack(e, dt, host, player!);
      speed = r.speed; allowOverlap = r.allowOverlap; mandibleTarget = r.mandible;
      break;
    }
    case 'stagger': {
      e.staggerTimer -= dt;
      speed = 0;
      a.crouch = THREE.MathUtils.lerp(a.crouch, e.type === 'charger' ? 0.5 : 0.3, dt * 10);
      a.headPitch = THREE.MathUtils.lerp(a.headPitch, 0.35, dt * 6);
      if (e.staggerTimer <= 0) {
        a.crouch = 0;
        e.state = e.aware && playerAlive ? 'chase' : 'idle';
        e.stateTime = 0; e.wanderTimer = 1;
      }
      break;
    }
    default: break;
  }

  a.mandible += (mandibleTarget - a.mandible) * Math.min(1, dt * 10);
  if (e.state !== 'attack') {
    a.shake = Math.max(0, a.shake - dt * 4);
    a.abdomen = Math.max(0, a.abdomen - dt * 2);
    if (e.state !== 'alert' && e.state !== 'stagger') a.crouch = Math.max(0, a.crouch - dt * 5);
  }

  integrate(e, dt, world, player, host, speed, allowOverlap);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Chase (per type)
 * ──────────────────────────────────────────────────────────────────────────── */
function chase(e: Enemy, dt: number, host: EnemyHost, player: PlayerRef): number {
  const s = e.stats;
  const d = e.distToPlayer;
  const meleeRange = s.attackRange + PLAYER_RADIUS;
  lookAtPlayer(e, player, dt);
  e.moveTarget.copy(player.position);
  e.hasMoveTarget = true;
  let speed = s.speed;

  switch (e.type) {
    case 'scavenger': {
      // weave while approaching so the swarm reads as a churning mass
      if (d > 4) {
        const w = Math.sin(e.anim.time * 2.3 + e.id) * Math.min(2.5, d * 0.15);
        const dx = player.position.x - e.position.x, dz = player.position.z - e.position.z;
        e.moveTarget.x += -dz / d * w; e.moveTarget.z += dx / d * w;
      }
      if (d < meleeRange && e.attackCd <= 0) startMelee(e);
      break;
    }
    case 'hunter': {
      e.flankTimer -= dt;
      if (e.flankTimer <= 0) { e.flankTimer = 2 + Math.random() * 2.5; if (Math.random() < 0.35) e.flankSign = -e.flankSign; }
      if (d > 4.5) {
        const dx = player.position.x - e.position.x, dz = player.position.z - e.position.z;
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
      if (d < 6.5) {
        if (d < meleeRange && e.attackCd <= 0) startMelee(e);
      } else if (d < 9) {
        // keep distance: back away while facing the player
        const dx = e.position.x - player.position.x, dz = e.position.z - player.position.z;
        e.moveTarget.set(e.position.x + dx / d * 4, 0, e.position.z + dz / d * 4);
        e.facePoint.copy(player.position); e.hasFacePoint = true;
        speed = s.speed * 0.7;
        if (e.hasLOS && e.attackCd <= 0 && d >= SPEWER_SPIT.minDist) startSpit(e);
      } else if (d <= SPEWER_SPIT.maxDist && e.hasLOS) {
        if (e.attackCd <= 0) startSpit(e);
        else { e.hasMoveTarget = false; e.facePoint.copy(player.position); e.hasFacePoint = true; }
      }
      break;
    }
    case 'charger': {
      if (e.hasLOS && e.chargeCd <= 0 && d >= CHARGER_CHARGE.minDist && d <= CHARGER_CHARGE.maxDist) startCharge(e, host);
      else if (d < meleeRange && e.attackCd <= 0) startMelee(e);
      break;
    }
  }
  return speed;
}

function lookAtPlayer(e: Enemy, player: PlayerRef, dt: number): void {
  const a = e.anim;
  const wanted = yawTo(e.position, player.position);
  let rel = wanted - e.yaw;
  rel = Math.atan2(Math.sin(rel), Math.cos(rel));
  a.headYaw = THREE.MathUtils.lerp(a.headYaw, THREE.MathUtils.clamp(rel, -0.8, 0.8), Math.min(1, dt * 8));
  const dy = (player.position.y + 1.2) - (e.position.y + e.rig.params.head.y);
  const pitch = -Math.atan2(dy, Math.max(0.5, e.distToPlayer));
  a.headPitch = THREE.MathUtils.lerp(a.headPitch, THREE.MathUtils.clamp(pitch, -0.6, 0.6), Math.min(1, dt * 8));
}

/* ────────────────────────────────────────────────────────────────────────────
 * Attacks
 * ──────────────────────────────────────────────────────────────────────────── */
function startMelee(e: Enemy): void {
  e.state = 'attack'; e.stateTime = 0;
  e.attackTimer = 0; e.attackHitDone = false; e.leaping = false;
  e.spitPhase = 0; e.chargePhase = 0;
}

function startLeap(e: Enemy, host: EnemyHost): void {
  e.state = 'attack'; e.stateTime = 0;
  e.attackTimer = 0; e.attackHitDone = false;
  e.airborne = false; // becomes true after the crouch
  e.leaping = true;
  e.spitPhase = 0; e.chargePhase = 0;
  host.playAudio('bug_screech', e.position, 0.6, 1.3);
}

function startSpit(e: Enemy): void {
  e.state = 'attack'; e.stateTime = 0;
  e.attackTimer = 0; e.attackHitDone = false;
  e.spitPhase = 1;
}

function startCharge(e: Enemy, host: EnemyHost): void {
  e.state = 'attack'; e.stateTime = 0;
  e.attackTimer = 0; e.attackHitDone = false;
  e.chargePhase = 1; e.chargeTimer = 0;
  host.playAudio('bug_screech', e.position, 1.0, 0.5);
}

interface AttackResult { speed: number; allowOverlap: boolean; mandible: number }
const attackResult: AttackResult = { speed: 0, allowOverlap: false, mandible: 0 };

function attack(e: Enemy, dt: number, host: EnemyHost, player: PlayerRef): AttackResult {
  const s = e.stats;
  const a = e.anim;
  const r = attackResult;
  r.speed = 0; r.allowOverlap = false; r.mandible = 0.3;
  e.attackTimer += dt;

  // ── charger: wind-up → rush ───────────────────────────────────────────
  if (e.chargePhase === 1) {
    e.facePoint.copy(player.position); e.hasFacePoint = true;
    lookAtPlayer(e, player, dt);
    a.shake = Math.min(1, e.attackTimer / CHARGER_CHARGE.windup);
    a.crouch = a.shake * 0.35;
    r.mandible = 1;
    if (e.attackTimer >= CHARGER_CHARGE.windup) {
      e.chargePhase = 2; e.chargeTimer = 0;
      e.chargeDir.set(player.position.x - e.position.x, 0, player.position.z - e.position.z).normalize();
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
    // contact with player
    const hitR = s.radius + PLAYER_RADIUS + 0.35;
    if (!player.isDead && e.distToPlayer < hitR) {
      host.hitPlayer(e, CHARGER_CHARGE.damage, 1.0);
      stumble(e);
      return r;
    }
    // overshot the player
    const passed = (player.position.x - e.position.x) * e.chargeDir.x + (player.position.z - e.position.z) * e.chargeDir.z;
    if ((passed < -2.5 && e.chargeTimer > 0.4) || e.chargeTimer > CHARGER_CHARGE.maxDuration) { stumble(e); return r; }
    return r;
  }

  // ── spewer: spit wind-up ──────────────────────────────────────────────
  if (e.spitPhase === 1) {
    e.facePoint.copy(player.position); e.hasFacePoint = true;
    lookAtPlayer(e, player, dt);
    a.abdomen = Math.min(1, e.attackTimer / SPEWER_SPIT.windup);
    a.crouch = a.abdomen * 0.2;
    r.mandible = a.abdomen;
    if (e.attackTimer >= SPEWER_SPIT.windup) {
      e.headCenter(_tmp);
      _tmp.y += 0.1;
      host.fireAcid(_tmp, e);
      host.playAudio('bug_attack', e.position, 0.9, 0.7);
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
      e.facePoint.copy(player.position); e.hasFacePoint = true;
      a.crouch = Math.min(1, e.attackTimer / crouchTime);
      r.mandible = 0.8;
      if (e.attackTimer >= crouchTime) {
        const T = HUNTER_LEAP.flightTime;
        _tmp.copy(player.position).addScaledVector(player.velocity, T * 0.5);
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
      if (!player.isDead && e.distToPlayer < HUNTER_LEAP.hitRadius) host.hitPlayer(e, HUNTER_LEAP.damage, 0.5);
      else host.playAudio('bug_step', e.position, 0.6, 1.1);
      e.leapCd = HUNTER_LEAP.cooldown * (0.8 + Math.random() * 0.5);
      e.attackCd = 0.5;
      e.state = 'chase'; e.stateTime = 0;
      a.crouch = 0.6; // land squash, decays in the chase state
    }
    return r;
  }

  // ── generic melee ─────────────────────────────────────────────────────
  e.facePoint.copy(player.position); e.hasFacePoint = true;
  lookAtPlayer(e, player, dt);
  const windup = s.attackWindup;
  const reach = s.attackRange + PLAYER_RADIUS + 0.6;
  if (e.attackTimer < windup) {
    r.mandible = 0.05;
    a.crouch = (e.attackTimer / windup) * 0.3;
    // creep toward the target during wind-up so it does not stall at the edge of range
    if (e.distToPlayer > s.attackRange * 0.7) { e.moveTarget.copy(player.position); e.hasMoveTarget = true; r.speed = s.speed * 0.6; }
  } else {
    if (!e.attackHitDone) {
      e.attackHitDone = true;
      a.crouch = 0;
      a.flinch = Math.max(a.flinch, 0.5); a.flinchZ = 0.8; a.flinchX = 0;   // lunge forward (nose dips)
      if (!player.isDead && e.distToPlayer < reach) host.hitPlayer(e, s.attackDamage, e.type === 'warrior' || e.type === 'charger' ? 0.45 : 0.18);
      else host.playAudio('bug_attack', e.position, 0.5, 1.1);
    }
    r.mandible = 1;
    if (e.attackTimer >= windup + 0.3) {
      e.attackCd = s.attackCooldown * (0.85 + Math.random() * 0.3);
      e.state = 'chase'; e.stateTime = 0;
    }
  }
  return r;
}

function stumble(e: Enemy): void {
  e.chargePhase = 0;
  e.chargeCd = CHARGER_CHARGE.cooldown;
  e.attackCd = 1.0;
  e.enterStagger(CHARGER_CHARGE.stumble);
  e.velocity.multiplyScalar(0.25);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Movement integration (shared by every grounded state)
 * ──────────────────────────────────────────────────────────────────────────── */
function integrate(e: Enemy, dt: number, world: WorldRef, player: PlayerRef | null, host: EnemyHost, speed: number, allowOverlap: boolean): void {
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
  separate(e, host.grid, player, _steer, allowOverlap || charging);
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
      stumble(e);
      host.playAudio('bug_step', pos, 1.0, 0.5);
      if (e.distToPlayer < 25) host.ctx.bus.emit('camera:shake', { intensity: 0.35, duration: 0.3 });
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

  // footsteps (heavies only, near the player)
  if (s.stepSound && e.distToPlayer < 30) {
    e.stepAccum += moved;
    if (e.stepAccum >= e.rig.params.strideLength * 0.5) {
      e.stepAccum = 0;
      const vol = THREE.MathUtils.clamp(1 - e.distToPlayer / 30, 0.1, 1) * (e.type === 'charger' ? 1 : 0.6);
      host.playAudio('bug_step', pos, vol, e.type === 'charger' ? 0.6 : 0.9);
    }
  }

  // yaw
  let targetYaw = e.yaw;
  if (e.hasFacePoint) targetYaw = yawTo(pos, e.facePoint);
  else if (e.velocity.x * e.velocity.x + e.velocity.z * e.velocity.z > 0.2) targetYaw = Math.atan2(e.velocity.x, e.velocity.z);
  e.yaw = turnToward(e.yaw, targetYaw, s.turnRate * (charging ? 0.3 : 1), dt);

  // slope conforming
  world.getNormalAt(pos.x, pos.z, _n);
  const fx = Math.sin(e.yaw), fz = Math.cos(e.yaw);
  const pitch = (_n.x * fx + _n.z * fz) * 0.7;
  const roll = -(_n.x * fz - _n.z * fx) * 0.7;
  a.slopePitch += (pitch - a.slopePitch) * Math.min(1, dt * 6);
  a.slopeRoll += (roll - a.slopeRoll) * Math.min(1, dt * 6);
}
