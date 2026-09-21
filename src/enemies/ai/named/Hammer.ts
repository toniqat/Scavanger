/**
 * src/enemies/ai/named/Hammer.ts — **Tagilla** (`rogue_hammer`, 2026-09-11).
 *
 * The hammer melee boss. In contact it does `attackDamage` every `attackCooldown`, off an `hp` several times an
 * ordinary humanoid's — all three are the `rogue_hammer` row of `data/enemies.csv`. No cover cycle — it charges
 * straight at a target the moment one appears, and with a clear lane inside `chargeDist` it rushes a short way to
 * close the gap.
 *
 * States (`Enemy.state` + `namedPhase`):
 *  - idle / wander   : patrols `patrolRadius` around its spawn structure (`guardPos`). wander + phase 3 = on its way back to the structure.
 *  - alert           : turns onto the target for `ROGUE_REACTION`.
 *  - chase  phase 0  : the chase. In range → swing, the rush conditions → phase 2. Deployables in the way are smashed.
 *  - chase  phase 2  : the rush (hint 17, `chargeSpeed`). It borrows `Enemy.chargePhase = 2` to reuse `integrate`'s
 *                      straight-line movement and its "hitting an obstacle → `stumble`" (a wall · rock · barrier stops it short).
 *  - attack phase 1  : the swing windup (hint 16, `windup`). It strikes once the moment the windup ends.
 *  - attack phase 4  : the short recovery while the hammer is lifted again.
 *  - stagger         : a blocked rush · incineration.
 *
 * The strike period: at the strike it sets `attackCd = attackCooldown − windup`. The next windup therefore ends exactly
 * `attackCooldown` later, so in contact it is `attackDamage / attackCooldown` per second.
 *
 * It runs on the host only. Every strike sends `ee hammer {id, p}` and a replica replays the FX alone through
 * `onHammerEvent`. The pose is drawn by `models/named/HammerLook` from `namedHint` (16 lifted · 17 rushing) +
 * `anim.recoil` (the strike).
 */
import * as THREE from 'three';
import { PLAYER_RADIUS, ROGUE_REACTION, STRUCT_DAMAGE_MUL, type DeployableRef, type EnemyEvent, type GameContext } from '@/shared';
import { FxManager, ParticleBurst } from '@/core/fx';
import type { Enemy, EnemyHost } from '../../Enemy';
import { NAMED_HAMMER } from '../../EnemyTypes';
import type { CombatTarget, TargetList } from '../../Targets';
import type { ReplicaHost } from '../../net/Replica';
import { tuple } from '../../net/HostSync';
import { HAMMER_HINT_CHARGE, HAMMER_HINT_WINDUP, HAMMER_IMPACT_FORWARD } from '../../models/named/HammerLook';
import { lookAtTarget } from '../Common';
import { integrate } from '../EnemyAI';

/* ── Phase numbers (`Enemy.namedPhase`, private to this file) ── */
const PHASE_CHASE = 0;
const PHASE_WINDUP = 1;
const PHASE_CHARGE = 2;
const PHASE_RETURN = 3;
const PHASE_RECOVER = 4;

/* ── Look / algorithm constants (the balance numbers are csv — `NAMED_HAMMER` · `enemies.csv`) ── */
const TWO_PI = Math.PI * 2;
/** Seconds it stands still after a strike while the hammer is lifted again (s). It does not affect the strike period (`attackCooldown`). */
const RECOVER_S = 0.25;
/** Speed multiplier for pushing toward the target during the windup — so one step back does not dodge the windup for free. */
const WINDUP_CREEP = 0.55;
/** Range slack at the moment of the strike (m): within the distance the windup started at + this, it connects. */
const STRIKE_GRACE = 0.6;
/** The frontal-arc cos (≈ 70°). A target that got to the side or behind is missed. Inside `CLOSE_ALWAYS` m (in contact) it connects regardless of direction. */
const FRONT_COS = 0.34;
const CLOSE_ALWAYS = 1.1;
/** It rushes only from at least this far outside the windup range — it does not rush from right in front. */
const CHARGE_MIN_GAP = 2;
/** Seconds before looking again once the rush lane was blocked (s) — no raycast every frame. */
const CHARGE_RETRY_S = 0.6;
/** The height the rush lane is measured at (m, knee) — a low sill or a barricade catches too. */
const CHARGE_LANE_Y = 0.6;
/** How fast it turns after the target during a rush (rad/s) — not so slow that one sidestep wastes the rush, not so fast that it cannot be dodged. */
const CHARGE_TURN = 1.1;
/** Maximum rush time = chargeDist / chargeSpeed × this multiplier. */
const CHARGE_TIME_MUL = 1.6;
/** It faces the target head-on only within this distance (m) — further out it has to look where it walks, so rounding obstacles reads naturally. */
const FACE_DIST = 9;
/** While patrolling, it walks home once it is further from guardPos than patrolRadius × this multiplier. */
const HOME_MUL = 1.6;
/** The walk home = chase speed × this multiplier · the arrival radius (m) · the maximum time for one leg (s). */
const RETURN_SPEED = 0.7;
const RETURN_ARRIVE = 3;
const RETURN_TIMEOUT = 40;
/** The screen shake of the target that was hit · the radius shaken around it (m) · that shake's maximum intensity. */
const HIT_SHAKE = 0.6;
const SHAKE_RADIUS = 16;
const SHAKE_MAX = 0.4;
const DUST_COLOR = 0x8a7a64;
const DEBRIS_COLOR = 0x3a332c;

const _p = new THREE.Vector3();
const _f = new THREE.Vector3();
const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** `Enemy.namedData` of a `rogue_hammer` — created once per spawn (no per-frame allocation). */
interface HammerData {
  kind: 'hammer';
  /** Seconds the target has been unseen and outside `giveUpDist` (s). */
  lost: number;
}

function hammerData(e: Enemy): HammerData {
  const d = e.namedData as HammerData | null;
  if (d && d.kind === 'hammer') return d;
  const n: HammerData = { kind: 'hammer', lost: 0 };
  e.namedData = n;
  return n;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Host AI
 * ──────────────────────────────────────────────────────────────────────────── */

export function updateHammer(e: Enemy, dt: number, host: EnemyHost, t: CombatTarget | null, targetAlive: boolean): void {
  const world = host.ctx.world!;
  const s = e.stats;
  const a = e.anim;
  const data = hammerData(e);
  if (e.namedCooldown > 0) e.namedCooldown -= dt;

  // Nothing to fight → it calms down (a windup or a rush under way is dropped too)
  if (!targetAlive && e.aware && (e.state === 'chase' || e.state === 'alert' || e.state === 'attack')) {
    clearAction(e);
    e.aware = false; e.state = 'idle'; e.stateTime = 0; e.wanderTimer = 1.5;
  }

  // The leash: with the target unseen outside giveUpDist for giveUpTime, it walks back to the structure (not counted during a rush or a stagger)
  if (e.aware && targetAlive && e.state !== 'stagger' && e.namedPhase !== PHASE_CHARGE) {
    if (!e.hasLOS && e.distToTarget > NAMED_HAMMER.giveUpDist) {
      data.lost += dt;
      if (data.lost >= NAMED_HAMMER.giveUpTime) goHome(e, data);
    } else data.lost = 0;
  } else if (!e.aware) data.lost = 0;

  let speed = 0;
  let crouchT = 0;
  e.hasMoveTarget = false;
  e.hasFacePoint = false;

  switch (e.state) {
    case 'idle': {
      clearAction(e);
      e.wanderTimer -= dt;
      a.headYaw = THREE.MathUtils.lerp(a.headYaw, Math.sin(a.time * 0.5) * 0.5, Math.min(1, dt * 2));
      a.headPitch = THREE.MathUtils.lerp(a.headPitch, 0, Math.min(1, dt * 3));
      const r = NAMED_HAMMER.patrolRadius;
      const hx = e.guardPos.x - e.position.x, hz = e.guardPos.z - e.position.z;
      if (hx * hx + hz * hz > (r * HOME_MUL) * (r * HOME_MUL)) { startReturn(e); break; }
      if (e.wanderTimer <= 0) {
        const ang = Math.random() * TWO_PI;
        const rad = r * (0.35 + Math.random() * 0.65);
        e.moveTarget.set(e.guardPos.x + Math.cos(ang) * rad, 0, e.guardPos.z + Math.sin(ang) * rad);
        if (!world.isInsideBounds(e.moveTarget.x, e.moveTarget.z)) e.moveTarget.copy(e.guardPos);
        e.state = 'wander'; e.stateTime = 0;
      }
      break;
    }
    case 'wander': {
      e.hasMoveTarget = true;
      const returning = e.namedPhase === PHASE_RETURN;
      if (returning) e.moveTarget.copy(e.guardPos);
      speed = returning ? s.speed * RETURN_SPEED : s.wanderSpeed;
      const dx = e.moveTarget.x - e.position.x, dz = e.moveTarget.z - e.position.z;
      const arrive = returning ? RETURN_ARRIVE * RETURN_ARRIVE : 0.6;
      if (dx * dx + dz * dz < arrive || e.stateTime > (returning ? RETURN_TIMEOUT : 8)) {
        e.state = 'idle'; e.stateTime = 0; e.wanderTimer = 2 + Math.random() * 4; e.namedPhase = PHASE_CHASE;
      }
      break;
    }
    case 'alert': {
      clearAction(e);
      if (targetAlive) { e.facePoint.copy(t!.position); e.hasFacePoint = true; lookAtTarget(e, t!, dt); }
      crouchT = 0.2;
      if (e.stateTime >= ROGUE_REACTION) { e.state = 'chase'; e.stateTime = 0; }
      break;
    }
    case 'chase': {
      if (!targetAlive) { clearAction(e); e.state = 'idle'; e.stateTime = 0; e.wanderTimer = 1; break; }
      speed = e.namedPhase === PHASE_CHARGE ? charge(e, dt, host, t!) : chase(e, dt, host, t!);
      break;
    }
    case 'attack': {
      speed = swing(e, dt, host, t, targetAlive);
      crouchT = e.namedPhase === PHASE_RECOVER ? 0.3 : 0.1;
      break;
    }
    case 'stagger': {
      clearAction(e);
      e.staggerTimer -= dt;
      if (e.incapTimer > 0) {
        e.incapTimer = Math.max(0, e.incapTimer - dt);
        crouchT = 0.35;
      } else {
        crouchT = 0.5;
        a.headPitch = THREE.MathUtils.lerp(a.headPitch, 0.3, Math.min(1, dt * 6));
      }
      if (e.staggerTimer <= 0 && e.incapTimer <= 0) {
        e.incapTimer = 0;
        e.state = e.aware && targetAlive ? 'chase' : 'idle';
        e.stateTime = 0; e.wanderTimer = 1;
      }
      break;
    }
    default: break;
  }

  if (e.slowFactor < 1) speed *= e.slowFactor;
  a.aim += (0 - a.aim) * Math.min(1, dt * 6);          // it carries no rifle — it never takes the aim pose
  a.crouch += (crouchT - a.crouch) * Math.min(1, dt * 7);
  a.shake = Math.max(0, a.shake - dt * 4);
  integrate(e, dt, world, host, speed, false);
  // A rush blocked by a wall · rock · barrier is put into a stagger by `integrate` through `stumble` — the rush state is dropped with it
  if (e.state === 'stagger' && e.namedPhase !== PHASE_CHASE) clearAction(e);
}

/** Drops every windup · rush · return marker (`namedHint` 0 → the wire falls back to the default rogue hints too). */
function clearAction(e: Enemy): void {
  e.namedPhase = PHASE_CHASE;
  e.namedTimer = 0;
  e.namedHint = 0;
  e.chargePhase = 0;
  e.structAttack = false;
}

function startReturn(e: Enemy): void {
  e.state = 'wander'; e.stateTime = 0;
  e.namedPhase = PHASE_RETURN;
  e.moveTarget.copy(e.guardPos); e.hasMoveTarget = true;
}

function goHome(e: Enemy, data: HammerData): void {
  clearAction(e);
  e.aware = false;
  e.lostTimer = 0;
  data.lost = 0;
  startReturn(e);
}

/** The centre-to-centre distance a windup starts at — a big target (a behemoth and the like) is struck from its body radius further out. */
function strikeRange(e: Enemy, t: CombatTarget): number {
  return e.stats.attackRange + Math.max(0, t.bodyRadius - PLAYER_RADIUS);
}

/**
 * 2026-09-11 (drone targets): whether the hammer reaches **vertically** too. With the bottom of the target's body
 * higher up than its own height (`stats.height`) — an air drone hovering — it neither swings nor rushes nor connects.
 * Always true for players · enemies · ground drones.
 */
function canReachVertically(e: Enemy, t: CombatTarget): boolean {
  const bottom = t.position.y - e.position.y;
  return bottom <= e.stats.height && bottom + t.bodyHeight >= -e.stats.height * 0.5;
}

function inFront(e: Enemy, t: CombatTarget): boolean {
  const dx = t.position.x - e.position.x, dz = t.position.z - e.position.z;
  const l = Math.hypot(dx, dz);
  if (l <= CLOSE_ALWAYS + Math.max(0, t.bodyRadius - PLAYER_RADIUS)) return true;
  return (dx * Math.sin(e.yaw) + dz * Math.cos(e.yaw)) / l >= FRONT_COS;
}

/** One tick of the chase. Returns the move speed. */
function chase(e: Enemy, dt: number, host: EnemyHost, t: CombatTarget): number {
  const s = e.stats;
  const d = e.distToTarget;
  const reach = strikeRange(e, t);
  lookAtTarget(e, t, dt);
  e.moveTarget.copy(t.position); e.hasMoveTarget = true;
  if (d < FACE_DIST) { e.facePoint.copy(t.position); e.hasFacePoint = true; }

  // A barricade · dome shield · turret in the way is smashed (`ai/Structures` picks it by the same rule as the melee bugs)
  const st = e.structTarget;
  if (st && st.hp > 0 && d > reach) {
    const sd = Math.hypot(st.position.x - e.position.x, st.position.z - e.position.z);
    if (sd <= s.attackRange + s.radius + st.radius + 0.5) {
      e.facePoint.copy(st.position); e.hasFacePoint = true;
      e.hasMoveTarget = false;
      if (e.attackCd <= 0) startSwing(e, host, true);
      return 0;
    }
    if (e.structBlocking) { e.moveTarget.copy(st.position); return s.speed; }
  }

  const reachable = canReachVertically(e, t);
  if (d <= reach && reachable) {
    e.facePoint.copy(t.position); e.hasFacePoint = true;
    if (e.attackCd <= 0) { startSwing(e, host, false); return 0; }
    // It stays in contact while waiting for the next strike — no loitering at the edge of its range
    return d > s.attackRange * 0.6 ? s.speed * 0.5 : 0;
  }

  if (reachable && e.namedCooldown <= 0 && d <= NAMED_HAMMER.chargeDist && d > reach + CHARGE_MIN_GAP && e.hasLOS) {
    if (chargeLaneClear(e, host, t)) { startCharge(e, host, t); return 0; }
    e.namedCooldown = CHARGE_RETRY_S;
  }
  return s.speed;
}

function startSwing(e: Enemy, host: EnemyHost, struct: boolean): void {
  e.state = 'attack'; e.stateTime = 0;
  e.namedPhase = PHASE_WINDUP; e.namedTimer = 0; e.namedHint = HAMMER_HINT_WINDUP;
  e.chargePhase = 0;
  e.attackHitDone = false;
  e.structAttack = struct;
  e.hasMoveTarget = false;
  host.playAudio('hammer_swing', e.position, 1, 0.92 + Math.random() * 0.16);
}

/** Windup (phase 1) → the strike → recovery (phase 4). Returns the move speed. */
function swing(e: Enemy, dt: number, host: EnemyHost, t: CombatTarget | null, targetAlive: boolean): number {
  const s = e.stats;
  e.namedTimer += dt;
  if (e.namedPhase === PHASE_WINDUP) {
    const struct = e.structAttack ? e.structTarget : null;
    if (struct && struct.hp > 0) { e.facePoint.copy(struct.position); e.hasFacePoint = true; }
    else if (t) { e.facePoint.copy(t.position); e.hasFacePoint = true; lookAtTarget(e, t, dt); }
    let speed = 0;
    if (!struct && t && targetAlive && e.distToTarget > s.attackRange * 0.5) {
      e.moveTarget.copy(t.position); e.hasMoveTarget = true;
      speed = s.speed * WINDUP_CREEP;
    }
    if (e.namedTimer >= NAMED_HAMMER.windup) strike(e, host, targetAlive ? t : null, struct);
    return speed;
  }
  // Recovery: it stands while the struck hammer is lifted again
  if (t && targetAlive) lookAtTarget(e, t, dt);
  if (e.namedPhase !== PHASE_RECOVER || e.namedTimer >= RECOVER_S) {
    e.namedPhase = PHASE_CHASE; e.namedTimer = 0;
    e.state = targetAlive ? 'chase' : 'idle'; e.stateTime = 0; e.wanderTimer = 1;
  }
  return 0;
}

/** The moment of the strike: damage once when in range and in front, always the ground-strike FX + `ee hammer`. */
function strike(e: Enemy, host: EnemyHost, t: CombatTarget | null, struct: DeployableRef | null): void {
  const s = e.stats;
  const ctx = host.ctx;
  const world = ctx.world!;
  e.attackHitDone = true;
  e.namedPhase = PHASE_RECOVER; e.namedTimer = 0; e.namedHint = 0;
  e.attackCd = Math.max(0, s.attackCooldown - NAMED_HAMMER.windup);
  e.structAttack = false;
  e.anim.recoil = 1;                                    // HammerLook: the strike

  if (struct) {
    const sd = Math.hypot(struct.position.x - e.position.x, struct.position.z - e.position.z);
    if (struct.hp > 0 && sd <= s.attackRange + s.radius + struct.radius + 0.8) struct.takeDamage(s.attackDamage * STRUCT_DAMAGE_MUL, e.position);
  } else if (t && !t.isDeadOrDowned && t.dist2D(e.position) <= strikeRange(e, t) + STRIKE_GRACE && inFront(e, t) && canReachVertically(e, t)) {
    // With a drone target, `hitTarget` routes it to `ctx.drones.damageDrone` (no player event). The knockback path is not used.
    host.hitTarget(e, s.attackDamage, t.isDrone ? 0 : HIT_SHAKE, t);
  }

  e.facing(_f);
  _p.set(e.position.x + _f.x * HAMMER_IMPACT_FORWARD, e.position.y, e.position.z + _f.z * HAMMER_IMPACT_FORWARD);
  _p.y = world.getSurfaceY(_p.x, _p.z, e.position.y + 0.3);
  impactFx(host, _p);
  host.playAudio('hammer_impact', _p, 1, 0.94 + Math.random() * 0.12);
  if (!host.replica && ctx.isMultiplayer && ctx.net) ctx.net.send({ t: 'ee', ev: 'hammer', id: e.id, p: tuple(_p, 2) }, 'others');
}

/** Whether the lane to the target is clear at knee height (once when deciding to rush — blocked, it looks again after `CHARGE_RETRY_S`). */
function chargeLaneClear(e: Enemy, host: EnemyHost, t: CombatTarget): boolean {
  const world = host.ctx.world;
  if (!world) return false;
  _o.set(e.position.x, e.position.y + CHARGE_LANE_Y, e.position.z);
  _d.set(t.position.x - _o.x, t.position.y + CHARGE_LANE_Y - _o.y, t.position.z - _o.z);
  const len = _d.length();
  if (len < 1e-3) return false;
  _d.multiplyScalar(1 / len);
  return world.raycast(_o, _d, Math.max(0.1, len - t.bodyRadius - e.stats.radius)) === null;
}

function startCharge(e: Enemy, host: EnemyHost, t: CombatTarget): void {
  e.namedPhase = PHASE_CHARGE; e.namedTimer = 0; e.namedHint = HAMMER_HINT_CHARGE;
  e.namedCooldown = NAMED_HAMMER.chargeCooldown;
  e.chargePhase = 2;                                    // integrate: straight-line movement · an obstacle → stumble
  e.chargeDir.set(t.position.x - e.position.x, 0, t.position.z - e.position.z);
  if (e.chargeDir.lengthSq() < 1e-4) e.facing(e.chargeDir); else e.chargeDir.normalize();
  e.yaw = Math.atan2(e.chargeDir.x, e.chargeDir.z);
  e.hasMoveTarget = false; e.hasFacePoint = false;
  host.playAudio('hammer_swing', e.position, 0.85, 0.7);
}

/** One tick of the rush. Reaching strike range it goes straight into the swing. Returns the move speed (during a rush `integrate` uses velocity as it is). */
function charge(e: Enemy, dt: number, host: EnemyHost, t: CombatTarget): number {
  e.namedTimer += dt;
  const dx = t.position.x - e.position.x, dz = t.position.z - e.position.z;
  const d = Math.hypot(dx, dz);
  if (d > 1e-3) {
    // It turns gently after the target
    const cur = Math.atan2(e.chargeDir.x, e.chargeDir.z);
    let rel = Math.atan2(dx, dz) - cur;
    rel = Math.atan2(Math.sin(rel), Math.cos(rel));
    const ny = cur + THREE.MathUtils.clamp(rel, -CHARGE_TURN * dt, CHARGE_TURN * dt);
    e.chargeDir.set(Math.sin(ny), 0, Math.cos(ny));
  }
  const sp = NAMED_HAMMER.chargeSpeed * (e.slowFactor < 1 ? e.slowFactor : 1);
  e.velocity.set(e.chargeDir.x * sp, 0, e.chargeDir.z * sp);
  e.hasMoveTarget = false; e.hasFacePoint = false;
  lookAtTarget(e, t, dt);

  if (!canReachVertically(e, t)) { endCharge(e); return 0; }   // a drone that climbed — the rush is dropped
  if (d <= strikeRange(e, t)) {
    endCharge(e);
    if (e.attackCd <= 0) startSwing(e, host, false);
    return 0;
  }
  const ahead = dx * e.chargeDir.x + dz * e.chargeDir.z;   // < 0 = it overshot
  const maxT = NAMED_HAMMER.chargeDist / Math.max(0.1, NAMED_HAMMER.chargeSpeed) * CHARGE_TIME_MUL;
  if ((ahead < 0 && e.namedTimer > 0.25) || e.namedTimer > maxT) endCharge(e);
  return 0;
}

function endCharge(e: Enemy): void {
  e.namedPhase = PHASE_CHASE; e.namedTimer = 0; e.namedHint = 0;
  e.chargePhase = 0;
  e.velocity.multiplyScalar(0.6);
}

/* ────────────────────────────────────────────────────────────────────────────
 * FX (shared by host and replica) — no lights, pooled particles only
 * ──────────────────────────────────────────────────────────────────────────── */

function impactFx(host: { readonly ctx: GameContext; readonly targets: TargetList }, p: THREE.Vector3): void {
  const fx = FxManager.get();
  if (fx) {
    ParticleBurst.groundBlast(fx.alpha, p, 26, 6, DUST_COLOR, 0.25);
    ParticleBurst.dust(fx.alpha, p, UP, 12, 1.4, DUST_COLOR);
    ParticleBurst.dust(fx.alpha, p, UP, 7, 0.55, DEBRIS_COLOR);   // debris
    ParticleBurst.sparks(fx.additive, p, UP, 14, 7);
  }
  const dl = host.targets.distToLocal(p);
  if (dl < SHAKE_RADIUS) host.ctx.bus.emit('camera:shake', { intensity: SHAKE_MAX * (1 - dl / SHAKE_RADIUS), duration: 0.28 });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Replica (called by `./remote`)
 * ──────────────────────────────────────────────────────────────────────────── */

/** A replica does not integrate the rush (`Replica.drive`'s `chargePhase` only looks at 1/2/10/11) — there is nothing to do. */
export function beforeHammerReplica(_e: Enemy, _hint: number): void { /* deliberately empty */ }

/**
 * On top of the default replica pose: the rifle aim pose is cleared and the body is lowered during a windup or a rush.
 * The arms and the hammer are drawn by `HammerLook`. `host` is always passed by `net/Replica.drive` — it is the exit
 * for the windup sound (`hammer_swing`).
 */
export function afterHammerReplica(e: Enemy, hint: number, dt: number, host: ReplicaHost): void {
  const a = e.anim;
  a.aim = 0;
  // A replica runs no AI, so the previous hint is parked in `namedPhase` — a fresh 16 means the windup sound.
  // (On promotion the AI reads 16/17 as a phase it does not know and the chase · recovery branches soon put it back to 0.)
  if (hint === HAMMER_HINT_WINDUP && e.namedPhase !== HAMMER_HINT_WINDUP) {
    host.playAudio('hammer_swing', e.position, 1, 0.92 + Math.random() * 0.16);
  }
  e.namedPhase = hint;
  if (hint === HAMMER_HINT_WINDUP) a.crouch += (0.1 - a.crouch) * Math.min(1, dt * 8);
  else if (hint === HAMMER_HINT_CHARGE) {
    a.crouch += (0.12 - a.crouch) * Math.min(1, dt * 8);
    a.headPitch = THREE.MathUtils.lerp(a.headPitch, -0.15, Math.min(1, dt * 6));
  }
}

/** `ee hammer`: the strike pose · dust · debris · shake · `hammer_impact`. It changes no game state. */
export function onHammerEvent(host: ReplicaHost, msg: Extract<EnemyEvent, { ev: 'hammer' }>): void {
  _p.set(msg.p[0], msg.p[1], msg.p[2]);
  const e = host.find(msg.id);
  if (e && e.active && e.state !== 'dead') e.anim.recoil = 1;
  impactFx(host, _p);
  host.playAudio('hammer_impact', _p, 1, 0.94 + Math.random() * 0.12);
}
