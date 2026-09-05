import * as THREE from 'three';
import { ROGUE_AIM_ERROR, ROGUE_AIM_ERROR_SETTLED, ROGUE_BURST, ROGUE_REACTION, ROGUE_RUSH_CHANCE } from '@/shared';
import type { Enemy, EnemyHost } from '../Enemy';
import { ROGUE_AI } from '../EnemyTypes';
import type { CombatTarget } from '../Targets';
import { lookAtTarget } from './Common';
import { integrate } from './EnemyAI';

/* ────────────────────────────────────────────────────────────────────────────
 * Rogue gunner AI (Phase 4). Guards idle / patrol around `guardPos` (a crate, or the boss it escorts), react after
 * ROGUE_REACTION, then loop a cover cycle: move to cover → crouch-hold 2–4 s → pop out and fire a burst → (rush with
 * ROGUE_RUSH_CHANCE) → next cover. Shots are resolved by `host.fireGun` (hitscan, occlusion, damage, FX, events).
 * Uses the shared EnemyState machine: idle / wander (patrol), alert (reaction), chase (cover cycle via `roguePhase`),
 * stagger, dead. Movement goes through EnemyAI.integrate like every other enemy.
 * ──────────────────────────────────────────────────────────────────────────── */

const TWO_PI = Math.PI * 2;
const _d = new THREE.Vector3();
const _c = new THREE.Vector3();

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

  // nobody left to fight → stand down
  if (!targetAlive && e.aware && (e.state === 'chase' || e.state === 'alert')) {
    e.aware = false; e.state = 'idle'; e.stateTime = 0; e.wanderTimer = 1.5; e.roguePhase = 0; e.burstLeft = 0;
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
      crouchT = 0.5;
      a.headPitch = THREE.MathUtils.lerp(a.headPitch, 0.3, dt * 6);
      if (e.staggerTimer <= 0) {
        e.state = e.aware && targetAlive ? 'chase' : 'idle';
        e.stateTime = 0; e.wanderTimer = 1; e.roguePhase = 0;
      }
      break;
    }
    default: break;
  }

  a.aim += (aimT - a.aim) * Math.min(1, dt * (aimT > a.aim ? 7 : 3));
  a.crouch += (crouchT - a.crouch) * Math.min(1, dt * 7);
  a.shake = Math.max(0, a.shake - dt * 4);
  integrate(e, dt, world, host, speed, false);
}

interface CycleResult { speed: number; aim: number; crouch: number }
const cycle: CycleResult = { speed: 0, aim: 0, crouch: 0 };

/** One tick of the cover cycle while a live target exists. */
function coverCycle(e: Enemy, dt: number, host: EnemyHost, t: CombatTarget): CycleResult {
  const s = e.stats;
  const a = e.anim;
  const r = cycle;
  const d = e.distToTarget;
  const boss = e.type === 'rogue_boss';
  r.speed = 0; r.aim = 1; r.crouch = 0;
  lookAtTarget(e, t, dt);

  // leash: never wander off the crate / boss unless rushing or the fight is right here
  const leashD = Math.hypot(e.position.x - e.guardPos.x, e.position.z - e.guardPos.z);
  if (e.roguePhase !== 4 && leashD > e.leash && !(e.hasLOS && d < 30)) {
    e.moveTarget.copy(e.guardPos); e.hasMoveTarget = true;
    e.facePoint.copy(t.position); e.hasFacePoint = true;
    e.roguePhase = 0;
    r.speed = s.speed; r.aim = 0.6;
    return r;
  }

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
        else if (e.hasLOS && e.burstTimer <= 0 && d < 45 && Math.random() < dt * 0.6) {
          // an occasional snap shot while relocating
          host.fireGun(e, t, ROGUE_AIM_ERROR * 1.5, boss ? ROGUE_AI.bossDamageMul : 1);
          a.recoil = 1; e.burstTimer = 0.6;
        }
        e.burstTimer -= dt;
      } else enterCover(e, boss);
      break;
    }
    case 2: {
      // crouched behind cover (hint 6)
      r.crouch = 1; r.aim = 0.35;
      e.facePoint.copy(t.position); e.hasFacePoint = true;
      e.coverTimer -= dt;
      if (e.coverTimer <= 0 || d < 6) popOut(e, boss);
      break;
    }
    case 3: {
      // popped out: stand and fire the burst (hint 5)
      e.facePoint.copy(t.position); e.hasFacePoint = true;
      e.standTime += dt;
      r.crouch = e.hitCrouchTimer > 0 ? 0.7 : 0;
      if (!e.hasLOS) {
        e.noLosTimer += dt;
        if (e.noLosTimer > 1.2) { e.roguePhase = 0; e.stateTime = 0; }
        break;
      }
      e.noLosTimer = 0;
      e.burstTimer -= dt;
      if (e.burstLeft > 0) {
        if (e.burstTimer <= 0 && e.hitCrouchTimer <= 0) {
          const err = THREE.MathUtils.lerp(ROGUE_AIM_ERROR, ROGUE_AIM_ERROR_SETTLED, THREE.MathUtils.clamp(e.standTime / ROGUE_AI.settleTime, 0, 1));
          host.fireGun(e, t, err, boss ? ROGUE_AI.bossDamageMul : 1);
          a.recoil = 1;
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
      if (e.burstTimer <= 0 && e.hasLOS) {
        host.fireGun(e, t, ROGUE_AIM_ERROR * 1.6, boss ? ROGUE_AI.bossDamageMul : 1);
        a.recoil = 1;
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
  e.burstLeft = boss ? ROGUE_AI.bossRounds : ROGUE_BURST;
  e.burstTimer = 0.15;
  e.standTime = 0;
  e.noLosTimer = 0;
  e.stateTime = 0;
}

/**
 * Choose cover: an obstacle within 16 m that lies roughly between the rogue and its target; the cover point sits on
 * the far side of the obstacle (away from the target), inside the leash. No candidate → `hasCover = false` (the rogue
 * crouches where it stands for a short "cover" hold instead).
 */
function pickCover(e: Enemy, host: EnemyHost, t: CombatTarget): void {
  const world = host.ctx.world!;
  const obstacles = world.getObstaclesNear(e.position.x, e.position.z, 16);
  const tp = t.position;
  _d.set(tp.x - e.position.x, 0, tp.z - e.position.z);
  const dist = _d.length();
  if (dist > 1e-3) _d.multiplyScalar(1 / dist);
  let best: number = Infinity;
  e.hasCover = false;
  for (let i = 0; i < obstacles.length; i++) {
    const o = obstacles[i];
    if (o.radius < 0.5 || o.height < 0.8) continue;
    const ox = o.position.x - e.position.x, oz = o.position.z - e.position.z;
    const along = ox * _d.x + oz * _d.z;
    if (along < -2) continue;                                    // behind us
    // cover point: behind the obstacle relative to the target
    _c.set(o.position.x - tp.x, 0, o.position.z - tp.z);
    const l = _c.length();
    if (l < 1e-3) continue;
    _c.multiplyScalar(1 / l);
    const px = o.position.x + _c.x * (o.radius + 0.7), pz = o.position.z + _c.z * (o.radius + 0.7);
    if (!world.isInsideBounds(px, pz)) continue;
    const toTarget = Math.hypot(tp.x - px, tp.z - pz);
    if (toTarget < 4 || toTarget > ROGUE_AI.range * 0.9) continue;
    if (!e.escortOf && Math.hypot(px - e.guardPos.x, pz - e.guardPos.z) > e.leash) continue;
    let score = Math.hypot(px - e.position.x, pz - e.position.z);
    if (score < 1.5) score += 6;                                  // prefer a different rock than the one we are at
    score += Math.max(0, toTarget - 35) * 0.5;
    if (score < best) { best = score; e.coverPos.set(px, world.getHeightAt(px, pz), pz); e.hasCover = true; }
  }
}
