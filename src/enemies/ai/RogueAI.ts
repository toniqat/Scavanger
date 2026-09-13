import * as THREE from 'three';
import {
  ROGUE_GRENADE_COOLDOWN, ROGUE_GRENADE_HOLD_S, ROGUE_GRENADE_RADIUS, ROGUE_GRENADE_WINDUP, ROGUE_MAG_ROUNDS, ROGUE_RELOAD_TIME,
} from '@/shared';
import type { Enemy, EnemyHost } from '../Enemy';
import { HUMANOID_ANDROID, ROGUE_AI } from '../EnemyTypes';
import type { CombatTarget } from '../Targets';
import { lookAtTarget } from './Common';
import { integrate } from './EnemyAI';
import { hasFireLine, fireLineStrafe } from './FireLine';
import { humanoidAimError, humanoidProfile, rollBurst, rollBurstPause, type HumanoidProfile } from './HumanoidProfile';
import { pickCover } from './RogueCover';
import { isSquadFlanker, updateSquadFlank } from './SquadFlank';

/* ────────────────────────────────────────────────────────────────────────────
 * Humanoid gunner AI (Phase 4, v2 in Phase 7, faction profiles 2026-09-13). Guards idle / patrol around `guardPos`
 * (a site, or the boss it escorts), react after the faction's `reaction`, then fight. Shots are resolved by
 * `host.fireGun` (hitscan, occlusion, damage, FX, events). Uses the shared EnemyState machine: idle / wander (patrol),
 * alert (reaction), chase (the fight), stagger, dead. Movement goes through EnemyAI.integrate like every other enemy.
 *
 * 2026-09-13 — one state machine, three factions (`ai/HumanoidProfile`, csv `HUMANOID_*`):
 * - **rogue / raider**: the cover cycle — move to cover → crouch-hold (`ROGUE_AI.coverMin..Max × coverMul`) → pop out
 *   and fire `burstsPerPop` bursts of `burstMin..burstMax` → (rush with `rushChance`) → next cover. Aim error follows the
 *   faction's **distance curve** (`humanoidAimError`) and settles while standing. A **bug** target is not worth hiding
 *   from: the gunner stands and fires, backing off inside `bugBackoff` (`fightBug`), with `enemyDamageMul`.
 *   A raider with `squadRole 'flanker'` breaks off on a wide arc while its squad trades fire (`ai/SquadFlank`).
 * - **android**: never takes cover (`roguePhase` only 0 / 3), never throws, never rushes — stands in its
 *   `engageMin..engageMax` band, walks slowly toward a target it cannot see or that is too far, slow short bursts
 *   (`androidCycle`).
 *
 * v2 (Phase 7), unchanged:
 * - cover must block the line of sight and is scored with a flank preference (`RogueCover.ts`);
 * - a magazine of ROGUE_MAG_ROUNDS: every shot spends one round, an empty mag forces a ROGUE_RELOAD_TIME crouched reload
 *   (no shots, hint 12, the `reload` sound at the rogue) regardless of the cover phase;
 * - a grenade toss when the target has been out of sight for ROGUE_GRENADE_HOLD_S within the faction's `grenadeRange`
 *   and the per-rogue cooldown is over: ROGUE_GRENADE_WINDUP standing throw pose (hint 13, grenade sphere in the off
 *   hand), then `host.throwGrenade`. 2026-09-13: **only while `grenadeCount > 0`** — the host spends one per toss and the
 *   rest stay on the body (`ee corpse.gc`).
 * ──────────────────────────────────────────────────────────────────────────── */

const TWO_PI = Math.PI * 2;
/** Never toss a grenade at something inside its own blast (plus a margin). */
const GRENADE_MIN_DIST = ROGUE_GRENADE_RADIUS + 1.5;
/** Snap shots while relocating / hip fire while rushing are this much worse than the curve's unsettled error (kept from v2). */
const SNAP_AIM_MUL = 1.5;
const RUSH_AIM_MUL = 1.6;
/** Android backing off / walking a step (m): the steering goal only, not a balance number. */
const STEP_M = 4;
/**
 * Idle patrol stays this far inside the leash (m) — an indoor site group's leash is site radius + 4 (`SiteGroups`), so the
 * patrol ends ~1 m inside the building's footprint. Below `WANDER_MIN_RADIUS` of room the guard does not wander at all.
 * Geometry for the patrol, not balance.
 */
const WANDER_LEASH_MARGIN = 5;
const WANDER_MIN_RADIUS = 1.5;

export function updateRogue(e: Enemy, dt: number, host: EnemyHost, t: CombatTarget | null, targetAlive: boolean): void {
  const ctx = host.ctx;
  const world = ctx.world!;
  const s = e.stats;
  const a = e.anim;
  const prof = humanoidProfile(e);

  // escorts follow the boss (leash to it); a dead boss frees them where they stand
  if (e.escortOf) {
    if (e.escortOf.isCombatant) e.guardPos.copy(e.escortOf.position);
    else { e.escortOf = null; e.guardPos.copy(e.position); e.leash = ROGUE_AI.leash; }
  }
  if (e.hitCrouchTimer > 0) e.hitCrouchTimer -= dt;
  if (e.grenadeCd > 0) e.grenadeCd -= dt;
  if (e.flankCd > 0 && e.state === 'chase') e.flankCd -= dt;   // the squad flank waits for an engagement, not for wall time
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
    e.popBursts = 0; e.flankPhase = 0;
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
        let rad = e.escortOf ? 3 + Math.random() * 3 : 6 + Math.random() * 6;
        // 2026-09-13: an indoor site group's leash is the site radius + a few m — keep the patrol well inside it so a
        // guard with nobody to fight never strolls out through the door; too small a leash = stand the post, just look around
        if (!e.escortOf) {
          const maxRad = e.leash - WANDER_LEASH_MARGIN;
          if (maxRad < WANDER_MIN_RADIUS) { e.wanderTimer = 2 + Math.random() * 3; break; }
          rad = Math.min(rad, maxRad);
        }
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
      if (e.stateTime >= prof.reaction) { e.state = 'chase'; e.stateTime = 0; e.roguePhase = 0; }
      break;
    }
    case 'chase': {
      if (!targetAlive) { e.state = 'idle'; e.stateTime = 0; e.wanderTimer = 1; e.roguePhase = 0; break; }
      const r = e.faction === 'android' ? androidCycle(e, dt, host, t!, prof) : coverCycle(e, dt, host, t!, prof);
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

/**
 * True while the rifle may fire: magazine not empty, not reloading, not winding up a throw — and, since 2026-09-10,
 * the **muzzle** (not the eyes) has a clear line to the target. `e.hasLOS` is an eye-to-chest ray, so a rogue with its
 * shoulder against a wall passes it while the rifle tip sits inside the wall; that is exactly the "벽에 대고 쏜다"
 * picture. The test is cached per rogue (`ENEMY_FIRE_LOS_S`), so putting it in the shot condition costs nothing.
 */
function canShoot(e: Enemy, host: EnemyHost, t: CombatTarget): boolean {
  return e.reloadTimer <= 0 && e.magRounds > 0 && e.throwTimer <= 0 && hasFireLine(e, host, t);
}

/** Aim error for the next shot: the faction's distance curve, settled by the time spent standing (× `mul`). */
function aimError(e: Enemy, prof: HumanoidProfile, settled: boolean, mul = 1): number {
  const settle = settled ? THREE.MathUtils.clamp(e.standTime / ROGUE_AI.settleTime, 0, 1) : 0;
  return humanoidAimError(prof, e.distToTarget, settle) * mul;
}

/**
 * One rifle shot: spends a round; an empty magazine starts the reload right away (crouch, no shots, `reload` audio).
 * 2026-09-13: damage = the faction's `damageMul` against players / drones, `enemyDamageMul` against another faction's
 * enemy (rogues and raiders mow bugs down), × the boss multiplier.
 */
function shoot(e: Enemy, host: EnemyHost, t: CombatTarget, err: number, prof: HumanoidProfile, boss: boolean): void {
  const mul = (t.enemy ? prof.enemyDamageMul : prof.damageMul) * (boss ? ROGUE_AI.bossDamageMul : 1);
  host.fireGun(e, t, err, mul);
  e.anim.recoil = 1;
  e.magRounds = Math.max(0, e.magRounds - 1);
  if (e.magRounds === 0) startReload(e, host);
}

function startReload(e: Enemy, host: EnemyHost): void {
  e.reloadTimer = ROGUE_RELOAD_TIME;
  e.burstLeft = 0;
  host.playAudio('reload', e.position, 0.7, e.type === 'rogue_boss' ? 0.85 : 1);
}

/** Rounds in one burst (the boss keeps its long `bossRounds` burst). */
function burstSize(e: Enemy, prof: HumanoidProfile, boss: boolean): number {
  const n = rollBurst(prof);
  return Math.min(e.magRounds, boss ? Math.max(ROGUE_AI.bossRounds, n) : n);
}

/**
 * Grenade trigger: the target has been hidden for ROGUE_GRENADE_HOLD_S, is within the faction's range but outside our own
 * blast, we still **carry** a grenade, the cooldown is over and nothing else (reload, stagger) is going on. Starts the
 * wind-up (hint 13). Androids carry none (`grenadeMax` 0), so this never fires for them.
 */
function maybeStartThrow(e: Enemy, t: CombatTarget, prof: HumanoidProfile): boolean {
  if (e.grenadeCount <= 0 || e.throwTimer > 0 || e.grenadeCd > 0 || e.reloadTimer > 0 || e.hasLOS) return false;
  if (e.noLosHold < ROGUE_GRENADE_HOLD_S) return false;
  const d = e.distToTarget;
  if (d > prof.grenadeRange || d < GRENADE_MIN_DIST) return false;
  e.throwTimer = ROGUE_GRENADE_WINDUP;
  e.grenadeTarget.copy(t.position);
  e.burstLeft = 0;
  e.stateTime = 0;
  return true;
}

interface CycleResult { speed: number; aim: number; crouch: number }
const cycle: CycleResult = { speed: 0, aim: 0, crouch: 0 };

/** One tick of the cover cycle (rogue / raider) while a live target exists. */
function coverCycle(e: Enemy, dt: number, host: EnemyHost, t: CombatTarget, prof: HumanoidProfile): CycleResult {
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
      if (host.throwGrenade(e, e.grenadeTarget)) {  // spends one of `grenadeCount` (parts/Attacks.throwGrenade)
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

  // 2026-09-13: a raider squad's flanker breaks off on a wide arc while the others trade fire (ai/SquadFlank)
  if (updateSquadFlank(e, dt, host, t, r)) return r;

  // leash: never wander off the site / boss unless rushing or the fight is right here
  const leashD = Math.hypot(e.position.x - e.guardPos.x, e.position.z - e.guardPos.z);
  if (e.roguePhase !== 4 && leashD > e.leash && !(e.hasLOS && d < 30)) {
    e.moveTarget.copy(e.guardPos); e.hasMoveTarget = true;
    e.facePoint.copy(t.position); e.hasFacePoint = true;
    e.roguePhase = 0;
    r.speed = s.speed; r.aim = 0.6;
    return r;
  }

  // 2026-09-13: bugs rush — hiding behind a rock from a scavenger only gets you bitten. Stand and shoot.
  if (e.roguePhase !== 4 && t.enemy !== null && !t.enemy.isHumanoid) return fightBug(e, dt, host, t, prof, boss);

  // a hidden target inside grenade range gets a grenade instead of another cover shuffle (not while rushing)
  if (e.roguePhase !== 4 && maybeStartThrow(e, t, prof)) { r.aim = 0.2; return r; }

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
        if (dx * dx + dz * dz < 0.8 || e.stateTime > 6) enterCover(e, boss, prof);
        // (Math.random() 를 먼저 본다 — 사선 검사는 캐시돼 있어도 총구 월드 행렬을 갱신하므로 공짜는 아니다)
        else if (e.hasLOS && e.burstTimer <= 0 && d < 45 && Math.random() < dt * 0.6 && canShoot(e, host, t)) {
          // an occasional snap shot while relocating
          shoot(e, host, t, aimError(e, prof, false, SNAP_AIM_MUL), prof, boss);
          e.burstTimer = 0.6;
        }
        e.burstTimer -= dt;
      } else enterCover(e, boss, prof);
      break;
    }
    case 2: {
      // crouched behind cover (hint 6); a reload extends the hold until it is done
      r.crouch = 1; r.aim = 0.35;
      e.facePoint.copy(t.position); e.hasFacePoint = true;
      e.coverTimer -= dt;
      if (e.reloadTimer > 0) break;
      if (e.coverTimer <= 0 || d < 6) popOut(e, boss, prof);
      break;
    }
    case 3: {
      // popped out: step out beside the rock (`popPos`, v2) and fire the bursts standing (hint 5)
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
      /*
       * 2026-09-10: 눈으로는 보이는데 **총구 사선**이 막혔다 = 바위 · 벽에 몸을 붙이고 있다. 조준만 하고 서
       * 있지 말고 옆으로 비켜서서 사선을 연다(사격만 보류, 이동은 그대로). 아직 `popPos` 로 걸어 나가는
       * 중이면(`stepping`) 원래 자리가 막혀 있는 게 정상이므로 건드리지 않는다. 한 다리(`ENEMY_FIRE_STRAFE_S`)
       * 를 다 걸어도 못 뚫으면 이 바위는 쏠 수 없는 자리이므로 새 엄폐물을 고른다.
       */
      if (!stepping && !hasFireLine(e, host, t)) {
        if (!fireLineStrafe(e, host, t, dt)) { e.fireBlockTimer = 0; e.roguePhase = 0; e.stateTime = 0; }
        r.speed = s.speed * 0.85;
        r.crouch = 0;
        break;
      }
      e.burstTimer -= dt;
      if (e.reloadTimer > 0) {
        // the magazine ran dry mid-burst: duck back into cover for the rest of the reload
        e.roguePhase = 2; e.coverTimer = 0.4; e.stateTime = 0;
        break;
      }
      if (e.burstLeft > 0) {
        if (e.burstTimer <= 0 && e.hitCrouchTimer <= 0 && canShoot(e, host, t)) {
          shoot(e, host, t, aimError(e, prof, true), prof, boss);
          e.burstLeft--;
          if (e.burstLeft > 0) e.burstTimer = prof.shotGap;
          else if (e.popBursts > 1 && e.magRounds > 0) {
            // 2026-09-13: the next burst of this pop-out after a short pause (rogues press the fight)
            e.popBursts--;
            e.burstLeft = burstSize(e, prof, boss);
            e.burstTimer = rollBurstPause(prof);
          } else { e.popBursts = 0; e.burstTimer = rollBurstPause(prof); }
        }
      } else if (e.burstTimer <= 0) {
        // (a squad flanker's push is the end of its arc — it never rushes on its own, see `ai/SquadFlank.isSquadFlanker`)
        if (!isSquadFlanker(e) && Math.random() < prof.rushChance && d > ROGUE_AI.rushDist + 3) { e.roguePhase = 4; e.rushTimer = 0; e.burstTimer = 0.2; }
        else { e.roguePhase = 0; e.stateTime = 0; }
      }
      break;
    }
    case 4: {
      // rushing (also the raider flanker's push): close to ~8 m while firing from the hip (hint 7)
      e.moveTarget.copy(t.position); e.hasMoveTarget = true;
      e.facePoint.copy(t.position); e.hasFacePoint = true;
      r.speed = s.speed * 1.1;
      e.rushTimer += dt;
      e.burstTimer -= dt;
      // 돌격 중에는 **사격만** 보류한다 — 사선이 막혀도 계속 달린다(이동을 막지 않는다).
      if (e.burstTimer <= 0 && e.hasLOS && canShoot(e, host, t)) {
        shoot(e, host, t, aimError(e, prof, false, RUSH_AIM_MUL), prof, boss);
        e.burstTimer = 0.28;
      }
      if (d <= ROGUE_AI.rushDist || e.rushTimer > ROGUE_AI.rushMax) { e.roguePhase = 0; e.stateTime = 0; }
      break;
    }
  }
  return r;
}

/**
 * 2026-09-13: a bug (another faction's non-humanoid) is the target — no cover, no grenade. Stand and fire bursts
 * (hint 5), backing off inside `bugBackoff`; a blocked muzzle strafes as usual.
 */
function fightBug(e: Enemy, dt: number, host: EnemyHost, t: CombatTarget, prof: HumanoidProfile, boss: boolean): CycleResult {
  const s = e.stats;
  const r = cycle;
  const d = e.distToTarget;
  e.facePoint.copy(t.position); e.hasFacePoint = true;
  e.hasPop = false;
  e.roguePhase = 3;
  r.aim = 1; r.crouch = 0;
  if (d < prof.bugBackoff && backOff(e, host, t)) { r.speed = s.speed * 0.85; e.standTime = 0; }
  else e.standTime += dt;
  e.burstTimer -= dt;
  if (!e.hasLOS || e.reloadTimer > 0) return r;
  if (!hasFireLine(e, host, t)) {
    if (!e.hasMoveTarget) { fireLineStrafe(e, host, t, dt); r.speed = s.speed * 0.85; }
    return r;
  }
  if (e.burstLeft <= 0) {
    if (e.burstTimer <= 0) { e.burstLeft = burstSize(e, prof, boss); e.burstTimer = 0; }
    return r;
  }
  if (e.burstTimer <= 0 && canShoot(e, host, t)) {
    shoot(e, host, t, aimError(e, prof, true), prof, boss);
    e.burstLeft--;
    e.burstTimer = e.burstLeft > 0 ? prof.shotGap : rollBurstPause(prof);
  }
  return r;
}

/** Steer a step straight away from the target. False when that step leaves the map. */
function backOff(e: Enemy, host: EnemyHost, t: CombatTarget): boolean {
  const dx = e.position.x - t.position.x, dz = e.position.z - t.position.z;
  const l = Math.hypot(dx, dz);
  if (l < 1e-3) return false;
  const x = e.position.x + (dx / l) * STEP_M, z = e.position.z + (dz / l) * STEP_M;
  if (!host.ctx.world!.isInsideBounds(x, z)) return false;
  e.moveTarget.set(x, 0, z);
  e.hasMoveTarget = true;
  return true;
}

/**
 * 2026-09-13: the android fight — **no cover, no grenades, no rush** (`roguePhase` stays 0 or 3). Inside the
 * `engageMin..engageMax` band with a line it stands (hint 5) and fires slow short bursts; a target it cannot see or that
 * stands too far is approached at `advanceMul` × speed (never past the leash), one too close is backed away from.
 * A blocked muzzle strafes like everybody else's. Aim error is the android curve — it is not meant to kill.
 */
function androidCycle(e: Enemy, dt: number, host: EnemyHost, t: CombatTarget, prof: HumanoidProfile): CycleResult {
  const s = e.stats;
  const r = cycle;
  const d = e.distToTarget;
  const slow = s.speed * HUMANOID_ANDROID.advanceMul;
  r.speed = 0; r.aim = 1; r.crouch = 0;
  lookAtTarget(e, t, dt);
  e.facePoint.copy(t.position); e.hasFacePoint = true;
  e.hasPop = false; e.hasCover = false;
  e.popBursts = 0;

  // leash: walk back to the post unless the target is in plain sight inside the band
  const leashD = Math.hypot(e.position.x - e.guardPos.x, e.position.z - e.guardPos.z);
  if (leashD > e.leash && !(e.hasLOS && d < HUMANOID_ANDROID.engageMax)) {
    e.moveTarget.copy(e.guardPos); e.hasMoveTarget = true;
    e.roguePhase = 0; e.burstLeft = 0;
    r.speed = slow; r.aim = 0.6;
    return r;
  }

  let moving = false;
  if (!e.hasLOS || d > HUMANOID_ANDROID.engageMax) {
    e.moveTarget.copy(t.position); e.hasMoveTarget = true;
    r.speed = slow; moving = true;
  } else if (d < HUMANOID_ANDROID.engageMin && backOff(e, host, t)) {
    r.speed = slow; moving = true;
  }
  if (moving) e.standTime = 0; else e.standTime += dt;
  e.burstTimer -= dt;
  if (!e.hasLOS) { e.roguePhase = 0; e.burstLeft = 0; r.aim = 0.6; return r; }
  e.roguePhase = 3;   // rifle up on the target (hint 5) — never the cover phases
  if (e.reloadTimer > 0) return r;
  if (!hasFireLine(e, host, t)) {
    if (!moving) { fireLineStrafe(e, host, t, dt); r.speed = slow; }
    return r;
  }
  if (e.burstLeft <= 0) {
    if (e.burstTimer <= 0) { e.burstLeft = Math.min(e.magRounds, rollBurst(prof)); e.burstTimer = 0; }
    return r;
  }
  if (e.burstTimer <= 0 && canShoot(e, host, t)) {
    shoot(e, host, t, aimError(e, prof, true), prof, false);
    e.burstLeft--;
    e.burstTimer = e.burstLeft > 0 ? prof.shotGap : rollBurstPause(prof);
  }
  return r;
}

function enterCover(e: Enemy, boss: boolean, prof: HumanoidProfile): void {
  e.roguePhase = 2;
  e.coverTimer = e.hasCover ? (ROGUE_AI.coverMin + Math.random() * (ROGUE_AI.coverMax - ROGUE_AI.coverMin)) * prof.coverMul : 0.8 + Math.random() * 1.2;
  if (boss) e.coverTimer *= 0.6;
  e.stateTime = 0;
}

function popOut(e: Enemy, boss: boolean, prof: HumanoidProfile): void {
  e.roguePhase = 3;
  e.burstLeft = burstSize(e, prof, boss);
  e.popBursts = Math.max(1, Math.round(prof.burstsPerPop));
  e.burstTimer = 0.15;
  e.standTime = 0;
  e.noLosTimer = 0;
  e.stateTime = 0;
}
