import * as THREE from 'three';
import {
  BEHEMOTH_CHARGE_DAMAGE, BEHEMOTH_CHARGE_SPEED, BEHEMOTH_WINDUP, PLAYER_RADIUS, TOXIC_TRIGGER_DIST,
} from '@/shared';
import type { Enemy, EnemyHost } from '../Enemy';
import { ARTILLERY_AI, BEHEMOTH_AI, TOXIC_AI } from '../EnemyTypes';
import type { CombatTarget } from '../Targets';
import { lookAtTarget, startMelee, stumble, type AttackResult } from './Common';

/* ────────────────────────────────────────────────────────────────────────────
 * Phase 4 bug gimmicks: artillery (stand-off mortar), toxic (suicide runner), behemoth (line charge).
 * Called from EnemyAI's chase / attack dispatch; movement still goes through EnemyAI.integrate.
 * ──────────────────────────────────────────────────────────────────────────── */

const _knock = new THREE.Vector3();
const _side = new THREE.Vector3();

/* ── artillery ──────────────────────────────────────────────────────────── */
/**
 * Keeps ARTILLERY_RANGE from its target: retreats inside `ARTILLERY_AI.retreatDist`, closes in beyond `approachDist`,
 * otherwise digs in and lobs a shell every `fireMin`–`fireMax` s at targets within `maxRange`. Never melees.
 * (2026-09-09: 42 / 88 / 98 m — the whole envelope shrank 30 % with `ARTILLERY_RANGE` 90 → 63.)
 */
export function chaseArtillery(e: Enemy, dt: number, host: EnemyHost, t: CombatTarget): number {
  const s = e.stats;
  const a = e.anim;
  const d = e.distToTarget;
  const tp = t.position;
  e.facePoint.copy(tp); e.hasFacePoint = true;
  lookAtTarget(e, t, dt);
  if (d < ARTILLERY_AI.retreatDist) {
    const dx = e.position.x - tp.x, dz = e.position.z - tp.z;
    const inv = 1 / Math.max(1e-3, d);
    e.moveTarget.set(e.position.x + dx * inv * 15, 0, e.position.z + dz * inv * 15);
    e.hasMoveTarget = true;
    e.hasFacePoint = false;                 // run away facing the way it goes
    e.dug = Math.max(0, e.dug - dt * 2);
    a.crouch = e.dug * 0.8;
    return s.speed;
  }
  if (d > ARTILLERY_AI.approachDist) {
    e.moveTarget.copy(tp); e.hasMoveTarget = true;
    e.dug = Math.max(0, e.dug - dt * 2);
    a.crouch = e.dug * 0.8;
    return s.speed * 0.8;
  }
  // hold position: dig in, then fire on the timer
  e.hasMoveTarget = false;
  e.dug = Math.min(1, e.dug + dt / ARTILLERY_AI.digTime);
  a.crouch = e.dug * 0.8;
  a.mandible = 0.4;
  e.shellTimer -= dt;
  if (e.shellTimer <= 0) {
    if (e.dug >= 0.95 && d <= ARTILLERY_AI.maxRange && !t.isDeadOrDowned) {
      host.fireShell(e, t);
      a.recoil = 1;
      a.flinch = Math.max(a.flinch, 0.6); a.flinchZ = -0.6; a.flinchX = 0;   // rear squat on fire
      e.shellTimer = ARTILLERY_AI.fireMin + Math.random() * (ARTILLERY_AI.fireMax - ARTILLERY_AI.fireMin);
    } else e.shellTimer = 0.5;
  }
  return 0;
}

/* ── toxic ──────────────────────────────────────────────────────────────── */
/** Fast straight runner; swells when within TOXIC_TRIGGER_DIST of any target (its own or another alive player). */
export function chaseToxic(e: Enemy, dt: number, host: EnemyHost, t: CombatTarget): number {
  const s = e.stats;
  const d = e.distToTarget;
  const tp = t.position;
  e.moveTarget.copy(tp); e.hasMoveTarget = true;
  lookAtTarget(e, t, dt);
  if (d > 3) {
    const w = Math.sin(e.anim.time * 3.1 + e.id) * Math.min(1.5, d * 0.1);
    const dx = tp.x - e.position.x, dz = tp.z - e.position.z;
    e.moveTarget.x += -dz / d * w; e.moveTarget.z += dx / d * w;
  }
  const reach = TOXIC_TRIGGER_DIST + e.stats.radius;
  if (d < reach + t.bodyRadius || host.targets.nearestAliveWithin(e.position, reach + PLAYER_RADIUS)) startSwell(e, host);
  return s.speed;
}

function startSwell(e: Enemy, host: EnemyHost): void {
  e.state = 'attack'; e.stateTime = 0; e.attackTimer = 0;
  e.toxicPhase = 1; e.swellTimer = 0;
  e.hasMoveTarget = false;
  host.playAudio('bug_screech', e.position, 0.7, 1.5);
}

/** Swell for TOXIC_AI.swell seconds (hint 9), then burst: `kill(false)` → EnemySystem.onEnemyKilled applies the blast. */
export function attackToxic(e: Enemy, dt: number, host: EnemyHost, t: CombatTarget | null, r: AttackResult): AttackResult {
  const a = e.anim;
  r.speed = 0; r.allowOverlap = false; r.mandible = 1;
  if (t) { e.facePoint.copy(t.position); e.hasFacePoint = true; lookAtTarget(e, t, dt); }
  e.swellTimer += dt;
  a.abdomen = Math.min(1, e.swellTimer / TOXIC_AI.swell);
  a.crouch = a.abdomen * 0.25;
  if (e.swellTimer >= TOXIC_AI.swell) {
    e.toxicPhase = 2;
    e.kill(false);
  }
  void host;
  return r;
}

/* ── behemoth ───────────────────────────────────────────────────────────── */
/** Approach to ~18 m, then wind up and line-charge; melee like a warrior when the charge is cooling down. */
export function chaseBehemoth(e: Enemy, dt: number, host: EnemyHost, t: CombatTarget): number {
  const s = e.stats;
  const d = e.distToTarget;
  const meleeRange = s.attackRange + PLAYER_RADIUS;
  lookAtTarget(e, t, dt);
  e.moveTarget.copy(t.position); e.hasMoveTarget = true;
  if (d < meleeRange && e.attackCd <= 0) { startMelee(e); return 0; }
  if (d <= BEHEMOTH_AI.engageDist + 4 && d > meleeRange * 0.8 && e.chargeCd <= 0 && e.hasLOS) { startCharge(e, host); return 0; }
  if (d > BEHEMOTH_AI.engageDist) return s.speed;
  return s.speed * 0.6;   // lumber while the charge cools down
}

function startCharge(e: Enemy, host: EnemyHost): void {
  e.state = 'attack'; e.stateTime = 0;
  e.attackTimer = 0; e.attackHitDone = false;
  e.chargePhase = 1; e.chargeTimer = 0;
  e.hasMoveTarget = false;
  e.chargeVictims.length = 0;
  host.playAudio('bug_screech', e.position, 1.0, 0.35);
}

const _tp = new THREE.Vector3();

export function attackBehemoth(e: Enemy, dt: number, host: EnemyHost, t: CombatTarget | null, r: AttackResult): AttackResult {
  const a = e.anim;
  const tp = t ? t.position : e.position;
  r.speed = 0; r.allowOverlap = false; r.mandible = 1;

  if (e.chargePhase === 1) {
    e.facePoint.copy(tp); e.hasFacePoint = true;
    if (t) lookAtTarget(e, t, dt);
    a.shake = Math.min(1, e.attackTimer / BEHEMOTH_WINDUP);
    a.crouch = a.shake * 0.3;
    if (e.attackTimer >= BEHEMOTH_WINDUP) {
      e.chargePhase = 2; e.chargeTimer = 0; e.chargeSeq++;
      e.chargeDir.set(tp.x - e.position.x, 0, tp.z - e.position.z);
      if (e.chargeDir.lengthSq() < 1e-4) e.facing(e.chargeDir); else e.chargeDir.normalize();
      e.yaw = Math.atan2(e.chargeDir.x, e.chargeDir.z);
      e.chargeEnd.copy(tp).addScaledVector(e.chargeDir, BEHEMOTH_AI.overshoot);
      a.shake = 0; a.crouch = 0;
      host.playAudio('bug_attack', e.position, 1.0, 0.4);
      _tp.copy(tp);
      host.onChargeStarted(e, _tp);
    }
    return r;
  }

  // rushing along a straight line
  e.chargeTimer += dt;
  r.allowOverlap = true; r.speed = BEHEMOTH_CHARGE_SPEED;
  e.velocity.set(e.chargeDir.x * BEHEMOTH_CHARGE_SPEED, 0, e.chargeDir.z * BEHEMOTH_CHARGE_SPEED);
  e.hasFacePoint = false; e.hasMoveTarget = false;
  a.headYaw = THREE.MathUtils.lerp(a.headYaw, 0, dt * 6);
  a.headPitch = THREE.MathUtils.lerp(a.headPitch, -0.2, dt * 6);
  const stamp = e.id * 1000 + e.chargeSeq;
  const pos = e.position;

  // players in the path (each once per charge): damage + sideways shove
  const players = host.targets.alive;
  const hitR = e.stats.radius + PLAYER_RADIUS + 0.4;
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (e.chargeVictims.indexOf(p.id) >= 0) continue;
    if (p.dist2D(pos) >= hitR) continue;
    e.chargeVictims.push(p.id);
    const side = Math.sign(e.chargeDir.z * (p.position.x - pos.x) - e.chargeDir.x * (p.position.z - pos.z)) || 1;
    _knock.set(e.chargeDir.z * side, 0.35, -e.chargeDir.x * side).addScaledVector(e.chargeDir, 0.45).normalize();
    host.chargeHit(e, p, BEHEMOTH_CHARGE_DAMAGE, _knock);
  }
  // enemies of either faction in the path: heavy damage + shove
  const active = host.active;
  for (let i = 0; i < active.length; i++) {
    const o = active[i];
    if (o === e || !o.isCombatant || o.hitByCharge === stamp) continue;
    const reach = e.stats.radius + o.stats.radius * 0.8;
    const dx = o.position.x - pos.x, dz = o.position.z - pos.z;
    if (dx * dx + dz * dz >= reach * reach) continue;
    o.hitByCharge = stamp;
    const side = Math.sign(e.chargeDir.z * dx - e.chargeDir.x * dz) || 1;
    _side.set(e.chargeDir.z * side, 0, -e.chargeDir.x * side);
    o.takeDamage(BEHEMOTH_AI.enemyDamage, undefined, undefined, 'ai');
    if (o.isCombatant) {
      o.velocity.addScaledVector(_side, BEHEMOTH_AI.enemyShove);
      if (o.type !== 'behemoth' && !o.airborne) o.enterStagger(0.8);
    }
  }
  // past the end point / too long → stagger out of the charge
  const passed = (e.chargeEnd.x - pos.x) * e.chargeDir.x + (e.chargeEnd.z - pos.z) * e.chargeDir.z;
  if ((passed < 0 && e.chargeTimer > 0.3) || e.chargeTimer > BEHEMOTH_AI.maxDuration) {
    stumble(e, BEHEMOTH_AI.chargeCooldown, BEHEMOTH_AI.stumble);
  }
  return r;
}
