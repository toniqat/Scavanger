import * as THREE from 'three';
import {
  BEHEMOTH_CHARGE_DAMAGE, BEHEMOTH_CHARGE_SPEED, BEHEMOTH_WINDUP, ENEMY_FIRE_STRAFE_S, PLAYER_RADIUS, SHELL_FLIGHT_TIME, TOXIC_TRIGGER_DIST,
} from '@/shared';
import type { Enemy, EnemyHost } from '../Enemy';
import { ARTILLERY_AI, BEHEMOTH_AI, TOXIC_AI } from '../EnemyTypes';
import type { CombatTarget } from '../Targets';
import { lookAtTarget, startMelee, stumble, type AttackResult } from './Common';
import { shellArcBlocked } from '../parts/Attacks';
/* appended (2026-09-17): the artillery escort · the fire condition · the one-time summon */
import { hasBugSupport, maybeSummon } from './ArtilleryPack';

/* ────────────────────────────────────────────────────────────────────────────
 * Phase 4 bug gimmicks: artillery (stand-off mortar), toxic (suicide runner), behemoth (line charge).
 * Called from EnemyAI's chase / attack dispatch; movement still goes through EnemyAI.integrate.
 * ──────────────────────────────────────────────────────────────────────────── */

const _knock = new THREE.Vector3();
const _side = new THREE.Vector3();

/** Sideways relocation distance (m) for an artillery whose arc is blocked — candidates are 1 · 2 × this. A visual / algorithm constant, not a csv number. */
const ARTILLERY_RELOCATE_M = 7;
/** 2026-09-11 (C-24): distance (m) to the toward-target · uphill candidates. Algorithm constant. */
const ARTILLERY_PROBE_FORWARD_M = 10;
/** A candidate spot covered by obstacles more than this (`obstacleCoverage`) is refused — so it never picks the middle of a rock. */
const ARTILLERY_PROBE_MAX_COVERAGE = 0.25;
/** 2026-09-17: how fast the firing pose (`anim.brace`) relaxes — 1 → 0 in 1/this seconds. Visual only. */
const ARTILLERY_BRACE_RELAX = 2;
const _aimT = new THREE.Vector3();
const _from = new THREE.Vector3();
const _uphill = new THREE.Vector3();

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
  // 2026-09-17: while preparing the barrage (3) · braced and waiting (1) · locked after firing (2) it takes no retreat · approach · relocate branch
  if (e.shellPhase !== 0) return artilleryFireSequence(e, dt, host, t);
  a.brace = Math.max(0, a.brace - dt * ARTILLERY_BRACE_RELAX);
  // 2026-09-18: when its own squad (escort + summoned pack) is wiped out it digs out a new one after the cooldown (`ai/ArtilleryPack`)
  maybeSummon(e, dt, host, t);
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
  /*
   * 2026-09-10 (the low arc): relocating after a shot was refused because the arc is blocked. The apex came down to 9.9 m, so
   * behind a hill · tree · ruin wall the shell lands at its own feet — instead of letting it kill itself every 6–9 s on the same
   * spot it undigs, walks aside and digs in again. **It does not freeze while merely aiming.**
   */
  if (e.fireBlockTimer > 0) {
    e.fireBlockTimer -= dt;
    // 2026-09-11 (C-24): reaching the chosen spot digs it in again at once (the walking time comes from the distance — `artilleryRelocate`)
    // `chase()` overwrites moveTarget with the target every frame, so the spot noted at the refusal (`shellSpot`) is reloaded here
    e.moveTarget.copy(e.shellSpot);
    if (Math.hypot(e.shellSpot.x - e.position.x, e.shellSpot.z - e.position.z) < 1) e.fireBlockTimer = 0;
    e.hasMoveTarget = true;
    e.hasFacePoint = false;
    e.dug = Math.max(0, e.dug - dt * 2);
    a.crouch = e.dug * 0.8;
    return s.speed * 0.9;
  }
  // hold position: dig in, then fire on the timer
  e.hasMoveTarget = false;
  e.dug = Math.min(1, e.dug + dt / ARTILLERY_AI.digTime);
  a.crouch = e.dug * 0.8;
  a.mandible = 0.4;
  e.shellTimer -= dt;
  if (e.shellTimer <= 0) {
    // 2026-09-17 (user's decision): it fires only with another bug beside the target (`supportRadius`) — a lone target is not shot at even in range.
    const ready = e.dug >= 0.95 && d <= ARTILLERY_AI.maxRange && !t.isDeadOrDowned && hasBugSupport(e, host, t);
    if (ready) {
      /* 2026-09-18 (user's decision 「brace for a barrage whenever any bug stands beside the target」): with support up it does not
         fire the **first shot** straight away but holds the barrage-prep pose (3) for `prepTime`. A condition that breaks meanwhile
         cancels the prep and leaves `shellPrepDone` false, so next time it measures from the start; later shots only wait `braceTime`. */
      e.shellPhase = e.shellPrepDone ? 1 : 3;
      e.shellPhaseT = e.shellPrepDone ? ARTILLERY_AI.braceTime : ARTILLERY_AI.prepTime;
      if (!e.shellPrepDone) artilleryPrepTell(e, host);
    } else {
      e.shellPrepDone = false;   // support is gone — it preps again the next time support appears
      e.shellTimer = 0.5;
    }
  }
  return 0;
}

/**
 * 2026-09-18: the **tell** of the barrage prep. It makes no new assets — only what already exists:
 *   a screech (`bug_screech`, the charger wind-up sound pitched lower) + an abdomen (`anim.abdomen`) throb + the flat brace (`anim.brace` ramp).
 * The danger HUD **gains nothing** — the rule of one indicator per flying shell (`ui/hud/DangerIndicators`) is unchanged
 * (a prep is not a shot yet). Replicas get the same pose from `shellPhase !== 0` → hint 25 (`net/HostSync.animHint`).
 */
function artilleryPrepTell(e: Enemy, host: EnemyHost): void {
  host.playAudio('bug_screech', e.position, 0.85, 0.45);
}

/**
 * 2026-09-17 (user's decision — the artillery fire sequence): ① it lowers its legs flat to the ground and waits `ARTILLERY_AI.braceTime` → ② fires →
 * ③ cannot move for `postFireLock` (no retreat · approach · relocating). If the target went down, left the range or lost the bug beside
 * it while it lay braced, it stands up without firing (it does not lock). A refusal from a blocked arc relocates it as before.
 * The pose is `anim.brace` and replicas receive it as hint 25 (`net/HostSync.animHint`).
 */
function artilleryFireSequence(e: Enemy, dt: number, host: EnemyHost, t: CombatTarget): number {
  const a = e.anim;
  e.hasMoveTarget = false;
  a.crouch = e.dug * 0.8;
  a.mandible = 0.4;
  e.shellPhaseT -= dt;
  /* 2026-09-18: the barrage prep (3) — **once, before the first shot** after support appears. A broken condition cancels it on the spot (no lock).
     When it ends `shellPrepDone` is raised and the ordinary brace (1) follows — later shots skip the prep and only wait `braceTime`. */
  if (e.shellPhase === 3) {
    a.brace = Math.min(1, a.brace + dt / Math.max(0.05, ARTILLERY_AI.prepTime));
    a.abdomen = Math.min(1, a.abdomen + dt * 1.5);
    if (t.isDeadOrDowned || e.distToTarget > ARTILLERY_AI.maxRange || !hasBugSupport(e, host, t)) {
      e.shellPhase = 0; e.shellPhaseT = 0; e.shellTimer = 0.5; a.abdomen = 0;
      return 0;
    }
    if (e.shellPhaseT > 0) return 0;
    e.shellPrepDone = true;
    e.shellPhase = 1; e.shellPhaseT = ARTILLERY_AI.braceTime;
    a.abdomen = 0;
    return 0;
  }
  if (e.shellPhase === 1) {
    a.brace = Math.min(1, a.brace + dt / Math.max(0.05, ARTILLERY_AI.braceTime));
    if (e.shellPhaseT > 0) return 0;
    if (t.isDeadOrDowned || e.distToTarget > ARTILLERY_AI.maxRange || !hasBugSupport(e, host, t)) {
      e.shellPhase = 0; e.shellPhaseT = 0; e.shellTimer = 0.5;
      return 0;
    }
    if (host.fireShell(e, t)) {
      e.shellRefusals = 0;
      a.recoil = 1;
      a.flinch = Math.max(a.flinch, 0.6); a.flinchZ = -0.6; a.flinchX = 0;   // rear squat on fire
      e.shellTimer = ARTILLERY_AI.fireMin + Math.random() * (ARTILLERY_AI.fireMax - ARTILLERY_AI.fireMin);
      e.shellPhase = 2; e.shellPhaseT = ARTILLERY_AI.postFireLock;
    } else {
      e.shellPhase = 0; e.shellPhaseT = 0;
      artilleryRelocate(e, host, t);
    }
    return 0;
  }
  a.brace = 1;
  if (e.shellPhaseT <= 0) { e.shellPhase = 0; e.shellPhaseT = 0; }
  return 0;
}

/**
 * 2026-09-17: the artillery fire sequence outside `chase` (target lost → `idle`, staggered `stagger` …). A pending brace · barrage prep is
 * cancelled, while the post-fire lock is held to the end **whatever the state is** — on true the caller (`ai/EnemyAI`) sets this tick's movement to 0.
 * 2026-09-18: the own-squad re-summon (`ai/ArtilleryPack.maybeSummon`) runs here too — an artillery that lost its target still refills its squad.
 */
export function artilleryOffChase(e: Enemy, dt: number, host: EnemyHost): boolean {
  const a = e.anim;
  // 2026-09-18: the own-squad re-summon runs with no target too (「once every scavenger is dead they respawn after the cooldown」) — with no target they come out as a guarding pack
  maybeSummon(e, dt, host, null);
  // 2026-09-18: the prep (3) is cancelled like the brace (1) — no target left to chase means no barrage
  if (e.shellPhase === 1 || e.shellPhase === 3) { e.shellPhase = 0; e.shellPhaseT = 0; e.shellPrepDone = false; }
  if (e.shellPhase === 2) {
    e.shellPhaseT -= dt;
    if (e.shellPhaseT > 0) { e.hasMoveTarget = false; a.brace = 1; return true; }
    e.shellPhase = 0; e.shellPhaseT = 0;
  }
  a.brace = Math.max(0, a.brace - dt * ARTILLERY_BRACE_RELAX);
  return false;
}

/** Relocation probes relative to the target line: [along n (toward the target), along p (perpendicular)] in m. */
const ARTILLERY_PROBES: ReadonlyArray<readonly [number, number]> = [
  [0, ARTILLERY_RELOCATE_M], [0, -ARTILLERY_RELOCATE_M],
  [ARTILLERY_PROBE_FORWARD_M, 0],
  [0, ARTILLERY_RELOCATE_M * 2], [0, -ARTILLERY_RELOCATE_M * 2],
  [ARTILLERY_PROBE_FORWARD_M, ARTILLERY_RELOCATE_M], [ARTILLERY_PROBE_FORWARD_M, -ARTILLERY_RELOCATE_M],
];

/**
 * The shot was refused because the arc is blocked (2026-09-11 C-24 · X-4 revision). It undigs, **probes ahead for a clear spot**, moves there and digs in again.
 *
 * Before (2026-09-10) it moved 7 m perpendicular to the target but **flipped the direction every time**, covering ≈3.5 m in a
 * 1.5 s walk and ping-ponging between two spots forever (X-4 ping-pong). Now seven candidates (7 · 14 m to either side, 10 m
 * toward the target, and the combinations) + one uphill spot are probed with `shellArcBlocked` (≤ 32 rays per refusal — it runs
 * on the fire cycle, not a hot path) and it walks to the **nearest** clear one. No alternating sign. With none clear it closes in
 * on the target (down to the retreat distance). `ARTILLERY_AI.maxRefusals` refusals in a row switch target and hold fire for `refusalCooldown`. No high arc, no ridge burst (the 2026-09-10 "on screen" decision).
 */
function artilleryRelocate(e: Enemy, host: EnemyHost, t: CombatTarget): void {
  const world = host.ctx.world!;
  e.dug = 0;
  e.shellRefusals++;
  /*
   * 2026-09-13 (X-4 again): picking 「the nearest clear spot」 alone revived the ping-pong on some terrain — while shots keep being refused it
   * picks B 7 m aside from A, then A again from B (`smoke-phase4` C-24 read −1 · +1 · −1 against the same target). So **while refusals continue
   * it prefers the same side as the last sidestep** (same side of the target line · forward · lateral component 0) and only crosses over when
   * that side has no clear spot at all. The last side goes in `Enemy.fireStrafeSign` — artillery does not use the `ai/FireLine` sidestep, so borrowing the field collides with nothing. A first refusal · a retarget are free.
   */
  let continuing = e.shellRefusals > 1;
  e.fireBlockTimer = ENEMY_FIRE_STRAFE_S;
  // the shell timer only runs while dug in (`chaseArtillery`), so it waits for the re-dig, not for the walk
  e.shellTimer = ARTILLERY_AI.digTime + 0.2;
  if (e.shellRefusals >= ARTILLERY_AI.maxRefusals) {
    e.shellRefusals = 0;
    e.shellTimer = Math.max(e.shellTimer, ARTILLERY_AI.refusalCooldown);
    const other = otherTargetInRange(e, host, t);
    if (other) { e.target = other; e.targetTimer = ARTILLERY_AI.refusalCooldown; e.distToTarget = other.dist2D(e.position); continuing = false; }
  }
  const tp = (e.target ?? t).position;   // after a retarget the new spot is searched against the new target
  const dx = tp.x - e.position.x, dz = tp.z - e.position.z;
  const l = Math.hypot(dx, dz);
  if (l < 1e-3) { e.fireBlockTimer = 0; return; }
  const nx = dx / l, nz = dz / l;
  _aimT.set(tp.x, world.getHeightAt(tp.x, tp.z), tp.z);
  const prevSide = continuing ? e.fireStrafeSign : 0;
  let bestD = Infinity, bx = 0, bz = 0, bestSide = 0;
  let revD = Infinity, rx = 0, rz = 0, revSide = 0;
  const probe = (cx: number, cz: number): void => {
    if (!world.isInsideBounds(cx, cz)) return;
    const walk = Math.hypot(cx - e.position.x, cz - e.position.z);
    // sign of the lateral component against the target line (+ = left as seen from the target · the same formula as `smoke-phase4`'s side)
    const lateral = (cz - e.position.z) * nx - (cx - e.position.x) * nz;
    const side = Math.abs(lateral) < 0.5 ? 0 : Math.sign(lateral);
    const reversing = prevSide !== 0 && side !== 0 && side !== prevSide;
    if (walk >= (reversing ? revD : bestD)) return;
    const td = Math.hypot(tp.x - cx, tp.z - cz);
    if (td < ARTILLERY_AI.retreatDist || td > ARTILLERY_AI.maxRange) return;
    if (world.obstacleCoverage(cx, cz, e.stats.radius) > ARTILLERY_PROBE_MAX_COVERAGE) return;
    _from.set(cx, world.getHeightAt(cx, cz) + e.stats.height * 0.95, cz);
    if (shellArcBlocked(world, _from, _aimT, SHELL_FLIGHT_TIME)) return;
    if (reversing) { revD = walk; rx = cx; rz = cz; revSide = side; }
    else { bestD = walk; bx = cx; bz = cz; bestSide = side; }
  };
  for (let i = 0; i < ARTILLERY_PROBES.length; i++) {
    const [along, side] = ARTILLERY_PROBES[i];
    probe(e.position.x + nx * along - nz * side, e.position.z + nz * along + nx * side);
  }
  // uphill: the terrain normal's horizontal part points downhill — a higher spot clears a ridge in front
  world.getNormalAt(e.position.x, e.position.z, _uphill);
  const hl = Math.hypot(_uphill.x, _uphill.z);
  if (hl > 0.05) probe(e.position.x - _uphill.x / hl * ARTILLERY_PROBE_FORWARD_M, e.position.z - _uphill.z / hl * ARTILLERY_PROBE_FORWARD_M);
  if (bestD === Infinity && revD < Infinity) { bestD = revD; bx = rx; bz = rz; bestSide = revSide; }
  if (bestD < Infinity) {
    if (bestSide !== 0) e.fireStrafeSign = bestSide > 0 ? 1 : -1;
    e.shellSpot.set(bx, 0, bz); walkFor(e, bestD); return;
  }
  // nothing clear nearby: close in on the target (never inside the retreat distance)
  const step = Math.min(ARTILLERY_PROBE_FORWARD_M * 1.5, l - ARTILLERY_AI.retreatDist - 2);
  if (step > 2) { e.shellSpot.set(e.position.x + nx * step, 0, e.position.z + nz * step); walkFor(e, step); }
  else e.fireBlockTimer = 0;   // nowhere to go — dig in again where it stands (the refusal cap handles the rest)
}

/**
 * Walk long enough to actually reach a spot `dist` m away (the 2026-09-10 fixed `ENEMY_FIRE_STRAFE_S` covered ≈3.5 m of a
 * 7 m leg — half of X-4); arriving early ends the walk (`chaseArtillery`), then it digs in again.
 */
function walkFor(e: Enemy, dist: number): void {
  e.fireBlockTimer = Math.min(8, Math.max(ENEMY_FIRE_STRAFE_S, dist / Math.max(0.5, e.stats.speed * 0.9) + 0.4));
}

/**
 * Nearest alive player other than `cur` within `ARTILLERY_AI.maxRange` (the refusal cap's new target), or null.
 * 2026-09-15 (android squadmates): an android is a candidate too — so an artillery never latches onto one person and never fires again.
 */
function otherTargetInRange(e: Enemy, host: EnemyHost, cur: CombatTarget): CombatTarget | null {
  let best: CombatTarget | null = null, bestD = ARTILLERY_AI.maxRange;
  const list = host.targets.alive;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === cur) continue;
    const dd = c.dist2D(e.position);
    if (dd < bestD) { bestD = dd; best = c; }
  }
  const allies = host.targets.allies;
  for (let i = 0; i < allies.length; i++) {
    const c = allies[i];
    if (c === cur || c.isDeadOrDowned) continue;
    const dd = c.dist2D(e.position);
    if (dd < bestD) { bestD = dd; best = c; }
  }
  return best;
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
  if (d < meleeRange && e.attackCd <= 0) { startMelee(e, host); return 0; }
  // 2026-09-11 (C-47): it does not charge **underneath** a hovering air drone — a charge at a target its body cannot touch only goes to waste
  if (d <= BEHEMOTH_AI.engageDist + 4 && d > meleeRange * 0.8 && e.chargeCd <= 0 && e.hasLOS && canBodyReach(e, t)) { startCharge(e, host); return 0; }
  if (d > BEHEMOTH_AI.engageDist) return s.speed;
  return s.speed * 0.6;   // lumber while the charge cools down
}

function startCharge(e: Enemy, host: EnemyHost): void {
  e.state = 'attack'; e.stateTime = 0;
  e.attackTimer = 0; e.attackHitDone = false;
  e.chargePhase = 1; e.chargeTimer = 0;
  e.hasMoveTarget = false;
  e.chargeVictims.length = 0;
  e.chargeDrones.length = 0;
  host.playAudio('bug_screech', e.position, 1.0, 0.35);
}

const _tp = new THREE.Vector3();
/** 2026-09-13: the rover mark put into `Enemy.chargeDrones` — a drone id never starts with `#`. */
const VEHICLE_CHARGE_MARK = '#rover';
/** 2026-09-15: the android mark prefix put into the same list (it collides with neither a drone id nor the vehicle mark). */
const ALLY_CHARGE_MARK = '#ally:';

/**
 * 2026-09-11 (C-47): can the charging body touch `t` at all? A target whose underside floats above the behemoth's height
 * (a hovering air drone) is out of reach — same rule as `ai/named/Hammer.canReachVertically`. Players / enemies /
 * ground drones always pass.
 */
function canBodyReach(e: Enemy, t: CombatTarget): boolean {
  const bottom = t.position.y - e.position.y;
  return bottom <= e.stats.height && bottom + t.bodyHeight >= -e.stats.height * 0.5;
}

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
  // 2026-09-11 (C-47): an aggroable drone is rammed too — only while the bodies overlap vertically (it passes under a hovering air drone).
  // Every drone proxy's id is 'ai', so once per charge is keyed by `droneId`. The damage goes through `applyDamage`'s drone branch → `damageDrone`.
  const drones = host.targets.drones;
  for (let i = 0; i < drones.length; i++) {
    const dr = drones[i];
    if (dr.isDeadOrDowned || dr.droneId === null || e.chargeDrones.indexOf(dr.droneId) >= 0) continue;
    if (dr.dist2D(pos) >= e.stats.radius + dr.bodyRadius + 0.4) continue;
    if (dr.position.y > pos.y + e.stats.height || dr.position.y + dr.bodyHeight < pos.y - 0.5) continue;
    e.chargeDrones.push(dr.droneId);
    _knock.copy(e.chargeDir);
    host.chargeHit(e, dr, BEHEMOTH_CHARGE_DAMAGE, _knock);
  }
  // 2026-09-15 (android squadmates): rammed by the same rule as people. Every proxy id is 'ai', so once per charge is keyed by the
  // android id — with a prefix, into `chargeDrones`, so it never mixes with `chargeVictims` (TargetId).
  const chargeAllies = host.targets.allies;
  for (let i = 0; i < chargeAllies.length; i++) {
    const a = chargeAllies[i];
    if (a.isDeadOrDowned || a.allyId === null) continue;
    const mark = ALLY_CHARGE_MARK + a.allyId;
    if (e.chargeDrones.indexOf(mark) >= 0) continue;
    if (a.dist2D(pos) >= hitR) continue;
    e.chargeDrones.push(mark);
    const side = Math.sign(e.chargeDir.z * (a.position.x - pos.x) - e.chargeDir.x * (a.position.z - pos.z)) || 1;
    _knock.set(e.chargeDir.z * side, 0.35, -e.chargeDir.x * side).addScaledVector(e.chargeDir, 0.45).normalize();
    host.chargeHit(e, a, BEHEMOTH_CHARGE_DAMAGE, _knock);
  }
  // 2026-09-13 (the rover): touching the hull footprint counts once per charge (a mark in `chargeDrones` that cannot collide with a drone id). The damage goes through `applyDamage`'s vehicle branch.
  const vehicles = host.targets.vehicles;
  for (let i = 0; i < vehicles.length; i++) {
    const v = vehicles[i];
    if (v.isDeadOrDowned || e.chargeDrones.indexOf(VEHICLE_CHARGE_MARK) >= 0) continue;
    if (v.dist2D(pos) >= e.stats.radius + 0.4) continue;
    if (v.position.y > pos.y + e.stats.height || v.position.y + v.bodyHeight < pos.y - 0.5) continue;
    e.chargeDrones.push(VEHICLE_CHARGE_MARK);
    _knock.copy(e.chargeDir);
    host.chargeHit(e, v, BEHEMOTH_CHARGE_DAMAGE, _knock);
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
