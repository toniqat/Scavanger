/**
 * src/enemies/parts/Alerts.ts — **what an enemy notices**.
 *
 * Sound (gunshots · lure grenades) · sight · faction clashes · and Phase 12's **shot tracking**: a bullet that came from
 * outside the detection range turns the body toward the shot's origin (`alertShot`), widens its perception that way, and
 * advances when it finds nothing. Target choice (`pickTarget`) and fleeing (`fleeFrom`) are the same perception line.
 */
import * as THREE from 'three';
import {
  BEHEMOTH_KNOCKBACK, BURNOUT_DURATION, CORPSE_LAND_TIMEOUT, CORPSE_LIFETIME, ENEMY_DEATH_DIRS, ENEMY_SHOT_ALERT_DIST, ENEMY_SHOT_IMPACT_DIST, ENEMY_STATUS_BITS, FLAME_AFTERBURN_DPS, FLAME_AFTERBURN_DURATION, GADGET_LURE_RADIUS, MAP_SIZE,
  NET_ENEMY_SNAPSHOT_HZ, PLAYER_HEIGHT, PLAYER_RADIUS, ROGUE_DAMAGE, ROGUE_GRENADE_DAMAGE, ROGUE_GRENADE_FUSE, ROGUE_GRENADE_RADIUS, ROGUE_MAG_ROUNDS, ROGUE_RANGE,
  SHELL_BLAST_RADIUS, SHELL_DAMAGE, SHELL_FLIGHT_TIME, SHOCK_SLOW_DURATION, SHOCK_SLOW_FACTOR, TOXIC_DAMAGE, TOXIC_RADIUS, getPlanet,
  type DamageMessage, type EnemyDeathDir, type EnemyEvent, type EnemyFaction, type EnemyHit, type EnemyManagerRef, type EnemyRef, type EnemySnapshot, type EnemyStatusKind, type EnemyType, type GameContext, type GameSystem,
  type HitRequest, type InterceptableRef, type PeerId, type PlanetEcosystem, type ShotReport, type Vec3Tuple, type WorldRef,
} from '@/shared';
import { FxManager, ParticleBurst } from '@/core/fx';
import { Enemy, type EnemyHost, type HitPart } from '../Enemy';
import { ROGUE_AI, SPEWER_SPIT, isWormType } from '../EnemyTypes';
import { SpatialGrid } from '../SpatialGrid';
import { CombatTarget, TargetList, type TargetId } from '../Targets';
import { SUSPICION_TIME, updateEnemyAI } from '../ai/EnemyAI';
import { LureField } from '../ai/Lures';
import { becomeAlert, canPerceive, hasLineOfSight, hearRadiusOf, senseRadiusOf } from '../ai/Perception';
import { beginInvestigation, endInvestigation } from '../ai/Investigate';
import { ROVER_NOTICE_STOPPED_M } from '@/shared';
import { BloodFX } from '../fx/BloodFX';
import { AcidProjectiles, type AcidHost, type AcidSlow } from '../fx/AcidProjectile';
import { ShellProjectiles, type ShellHost } from '../fx/ShellProjectile';
import { RogueGrenades, type GrenadeHost } from '../fx/RogueGrenade';
import { AmbientSpawner, ambientGroup, waveGroup, type SpawnHost } from '../Spawner';
import { WaveDirector } from '../WaveDirector';
import { disposeBugAssets } from '../models/BugModel';
import { disposeRogueAssets } from '../models/RogueModel';
import { EnemyReplica, type ReplicaHost } from '../net/Replica';
import { animHint, encodeSnapshot, round, SnapshotCache, tuple } from '../net/HostSync';
import { CorpseManager, rollCorpseLootable, type CorpseWireOpts } from '../Corpses';
import { placeRogueGuards, type RogueSpawnHost } from '../RogueGuards';
import { raySphere, rayCapsule, rayStandingCapsule } from '../RayTests';
import { BARRIER_BUMP_INTERVAL, BARRIER_RETARGET_S, BURN_TICK, CLASH_RADIUS, CLASH_THROTTLE, CORPSE_SLACK, EMBER_INTERVAL, FLEE_DURATION, GRENADE_KNOCKBACK, GRENADE_LOB_SPEED, GRENADE_NOISE, GUNFIRE_LURE_DURATION, GUNFIRE_LURE_WEIGHT, INCAP_EMBER_INTERVAL, MAX_REQUEST_DAMAGE, MAX_REQUEST_RADIUS, MAX_SHOT_RANGE, MAX_STATUS_DURATION, PROMOTE_ID_GAP, PROMOTE_SEQ_GAP, RECYCLE_DISTANCE, SHIELD_CONTACT_Y, SHOCK_SPARK_TIME, SHOT_CHECK_INTERVAL, SPARK_INTERVAL, STATUS_REQUEST_INTERVAL, SUSPICION_RADIUS, SUSPICION_REFRESH, _aim, _c, _dir, _eye, _hc, _hd, _hp, _kb, _m, _sd, _sh, _so, _to, _v, _v2, _zero, deathDirIndex, isVec3Tuple, killedBuf, queryBuf } from '../model';
import type { EnemySystem } from '../EnemySystem';

/* ── Phase 12: shot tracking · distractions (EnemyManagerRef) ───────────── */
/**
 * A local shot was fired (weapons calls this for every one). Authority: run the alert routine; a joined client
 * forwards it to the host as `shotq` instead (replicas have no AI). No-op on the training range.
 */
export function reportShot(sys: EnemySystem, origin: THREE.Vector3, dir: THREE.Vector3, range: number, hit: THREE.Vector3 | null): void {
  /*
   * 2026-09-14 2nd pass (user's decision: **every enemy**): the tutorial takes this rule unchanged — the `sys.tutorial`
   * no-op added that same morning was pulled out. 「narrow detection range or not, it looks where the bullet came from
   * and tracks the shooter」 must not be an exception for the tutorial alone, and with one a narrow sense radius (12 m)
   * simply means 「shoot it and it never knows」. The **leash** reconciles it with 「fixed posts · no patrolling」: an enemy
   * that went out to investigate cannot pass `Enemy.homeLeash` either (`ai/Investigate` phase 1 · `Tutorial.tutorialHold`)
   * and walks home. The training range (`sys.training`) has no enemies at all, so it is left as it was.
   */
  if (sys.training || !sys.ctx.world?.ready) return;
  if (!sys.authority) {
    if (!sys.multiplayer) return;
    const msg: ShotReport = { t: 'shotq', o: tuple(origin, 2), d: tuple(dir, 3), r: round(range, 1) };
    if (hit) msg.h = tuple(hit, 2);
    sys.ctx.net?.send(msg, 'host');
    return;
  }
  sys.alertShot(origin, dir, range, hit, 'local');
  }

/**
 * Pull aggro toward `pos` (lure grenade, gunfire noise). Registers a lure the AI walks toward and
 * wakes unaware bugs inside the radius. Authority only — replicas follow the host's snapshots.
 */
export function addDistraction(sys: EnemySystem, pos: THREE.Vector3, radius: number, duration: number, weight: number): void {
  if (!sys.authority) return;
  // 2026-09-15 (the sandworm): anything from outside is a 「lure」 (a lure grenade deployable · any other aggro request) — the director reads it apart from a gunshot (`onGunshot`)
  sys.lures.add(pos, radius, duration, weight, sys.ctx.time, 'lure');
  if (weight < 0.3) return;
  // a real lure also wakes the swarm around it
  const r2 = radius * radius;
  let loudBudget = 2;
  for (let i = 0; i < sys.active.length; i++) {
    const e = sys.active[i];
    if (!e.active || e.state === 'dead' || e.state === 'flee') continue;
    const dx = e.position.x - pos.x, dz = e.position.z - pos.z;
    if (dx * dx + dz * dz > r2) continue;
    // 2026-09-14 (tutorial-only enemies): a lure outside its own sense radius is neither heard nor seen
    if (e.senseRadius > 0 && dx * dx + dz * dz > e.senseRadius * e.senseRadius) continue;
    e.lurePos.copy(pos);
    e.lureWeight = Math.max(e.lureWeight, weight);
    e.hasLure = true;
    if (!e.aware) { becomeAlert(e, sys, loudBudget > 0); loudBudget--; }
  }
  }

/* ── EnemyHost ─────────────────────────────────────────────────────────── */
export function alertNear(sys: EnemySystem, position: THREE.Vector3, radius: number, source: Enemy | null): void {
  if (!sys.authority) return;
  const r2 = radius * radius;
  for (let i = 0; i < sys.active.length; i++) {
    const e = sys.active[i];
    if (e === source || !e.active || e.state === 'dead' || e.aware) continue;
    if (source && e.faction !== source.faction) continue;   // a screeching bug does not wake the rogues (they spot it themselves)
    const dx = e.position.x - position.x, dz = e.position.z - position.z;
    const d2 = dx * dx + dz * dz;
    // 2026-09-14 (tutorial-only enemies): pack propagation stays inside the sense radius too (a scream in the next stretch does not wake this one)
    if (e.senseRadius > 0 && d2 > e.senseRadius * e.senseRadius) continue;
    if (d2 <= r2) becomeAlert(e, sys, false);
  }
  }

/** Strongest lure covering `pos`: own distraction list merged with the authoritative gadget beacon. */
export function lureFor(sys: EnemySystem, pos: THREE.Vector3, out: THREE.Vector3): number {
  let w = sys.lures.best(pos, out, sys.ctx.time);
  const g = sys.ctx.gadgets;
  if (g) {
    const dep = g.findDistraction(pos, GADGET_LURE_RADIUS);
    if (dep) {
      const dw = 0.85;
      if (dw > w) { w = dw; out.copy(dep.position); }
    }
  }
  return w;
  }

/**
 * A shot was heard. Wakes bugs (hearing) and, for those that cannot see through the smoke it came out of,
 * records a suspicion point they answer with very inaccurate fire. Gunfire also acts as a weak lure.
 */
export function onGunshot(sys: EnemySystem, position: THREE.Vector3, radius: number): void {
  sys.alertHearing(position, radius);
  if (!sys.authority || !sys.ctx.isGameplayPhase()) return;
  sys.lures.add(position, radius, GUNFIRE_LURE_DURATION, GUNFIRE_LURE_WEIGHT, sys.ctx.time, 'noise');
  const gadgets = sys.ctx.gadgets;
  const now = sys.ctx.time;
  const r2 = SUSPICION_RADIUS * SUSPICION_RADIUS;
  for (let i = 0; i < sys.active.length; i++) {
    const e = sys.active[i];
    if (!e.active || e.state === 'dead' || e.state === 'flee') continue;
    const dx = e.position.x - position.x, dz = e.position.z - position.z;
    if (dx * dx + dz * dz > r2) continue;
    if (now - e.suspicionAt < SUSPICION_REFRESH) continue;
    e.suspicionAt = now;
    let clarity = 1;
    if (gadgets) {
      _eye.set(e.position.x, e.position.y + e.stats.height * 0.8, e.position.z);
      const v = gadgets.visionFactor(_eye, position);
      if (typeof v === 'number' && v >= 0 && v <= 1) clarity = v;
    }
    e.suspicion.copy(position);
    e.suspicionTimer = SUSPICION_TIME;
    // shooting out of a smoke cloud draws a wide, wild answer; a clear shot is answered accurately
    e.suspicionSpread = clarity > 0.75 ? 1.5 : 3 + (1 - clarity) * 7;
  }
  }

export function alertHearing(sys: EnemySystem, position: THREE.Vector3, radius: number): void {
  if (!sys.authority || !sys.ctx.isGameplayPhase()) return;
  const r2 = radius * radius;
  let loudBudget = 2;
  for (let i = 0; i < sys.active.length; i++) {
    const e = sys.active[i];
    if (!e.active || e.state === 'dead' || e.aware) continue;
    const dx = e.position.x - position.x, dz = e.position.z - position.z;
    const reach = hearingReach(e, radius);
    if (dx * dx + dz * dz <= Math.min(r2, reach * reach)) {
      becomeAlert(e, sys, loudBudget > 0);
      loudBudget--;
    }
  }
  }

/**
 * How far `e` can hear a sound of radius `radius` — the formula gunshots already used, independent of the noise source (gunshot · grenade · drone).
 * 2026-09-14: on top of that a tutorial enemy is clipped once more by its own sense radius (`hearRadiusOf`).
 */
function hearingReach(e: Enemy, radius: number): number {
  const reach = Math.min(radius, e.stats.hearRadius + (radius - 55));
  return e.senseRadius > 0 ? Math.min(reach, hearRadiusOf(e)) : reach;
}

/**
 * To be targeted, a drone has to be this much **clearly** closer than the player — the same value as the target-swap
 * hysteresis in `ai/Perception.acquireTarget` (0.6 with LOS). An algorithm constant, not a csv number.
 */
const DRONE_PREFER_MUL = 0.6;

/** An enemy that fights in melee only — it does not target an air drone hovering above its attack range (it would circle underneath forever). */
function isMeleeOnly(e: Enemy): boolean {
  if (e.type === 'spewer' || e.type === 'artillery') return false;
  return !e.isHumanoid || e.type === 'rogue_hammer';
}

/**
 * 2026-09-11 (enemy ↔ drone): the nearest drone `e` may target right now. Candidates come from `TargetList.drones` (= `aggroable`
 * — a walking ground drone is never in it) and must ① be closer than `maxDist`, ② for a melee-only enemy float with their
 * underside within `height + attack range`, and ③ pass the existing perception rule (`canPerceive`: sight radius × stealth ·
 * smoke, within 5 m or a clear line, the shot-tracking cone included). The raycast is fired only at a drone that passed the two cheap checks. The scan drone (`rogue_scan_drone`) never targets a drone.
 */
export function pickDroneTarget(sys: EnemySystem, e: Enemy, maxDist: number): CombatTarget | null {
  const list = sys.targets.drones;
  if (list.length === 0 || e.type === 'rogue_scan_drone') return null;
  const meleeOnly = isMeleeOnly(e);
  const reachUp = e.stats.height + e.stats.attackRange;
  let best: CombatTarget | null = null;
  let bestD = Math.min(maxDist, senseRadiusOf(e));
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (t.isDeadOrDowned) continue;
    const d = t.dist2D(e.position);
    if (d >= bestD) continue;
    if (meleeOnly && t.droneAltitude > reachUp) continue;
    if (!canPerceive(e, sys, t, true)) continue;
    best = t; bestD = d;
  }
  return best;
}

/** Enemies that never target the vehicle — the flying scan drone, the rooted sandworm, and Roden, who shoots people only (user's decision). */
function ignoresVehicle(e: Enemy): boolean {
  return e.type === 'rogue_scan_drone' || isWormType(e.type) || e.type === 'rogue_sniper';
}

/**
 * 2026-09-15 (android squadmates): enemies that never target an android — the named sniper Roden shoots **people only** (the
 * existing rule; `ai/named/Sniper.ts` picks straight out of `targets.alive`). To every other enemy an android is a target of exactly a person's standing.
 */
function ignoresAllies(e: Enemy): boolean {
  return e.type === 'rogue_sniper';
}

/**
 * 2026-09-13 (the rover): the vehicle proxy (`TargetList.vehicles`) when `e` may target it right now, else null.
 * - **Aggro** (`e.vehicleAggroUntil` — an enemy the turret or a ramming hit, and its pack): the vehicle, whatever the distance or perception.
 * - Otherwise it has to be **clearly** closer than the player (`< DRONE_PREFER_MUL ×`; irrelevant with no player) — a visible player comes first.
 * - A **driving** vehicle (`patrol` · `trip`) qualifies inside the hearing radius (`stats.hearRadius`, to the hull's edge) or by the usual perception rule (`canPerceive`).
 * - A **standing** vehicle only within `ROVER_NOTICE_STOPPED_M` and with a line of sight (an empty car parked quietly at a stop does not catch the eye).
 * The raycast is fired only once the cheap checks above have passed.
 */
export function pickVehicleTarget(sys: EnemySystem, e: Enemy, playerDist: number): CombatTarget | null {
  const t = sys.targets.vehicleTarget();
  if (!t || t.isDeadOrDowned || ignoresVehicle(e)) return null;
  if (sys.ctx.time < e.vehicleAggroUntil) return t;
  const d = t.dist2D(e.position);
  if (d >= playerDist * DRONE_PREFER_MUL) return null;
  if (t.vehicleMoving) return d < hearRadiusOf(e) || canPerceive(e, sys, t, true) ? t : null;
  return d < ROVER_NOTICE_STOPPED_M && hasLineOfSight(e, sys, t) ? t : null;
}

/**
 * 2026-09-11 (enemy ↔ drone): `world:noise` — a ground drone at a sprint. It is emitted **only on the authority client** and only
 * the authority reacts here. An enemy that has **not perceived anything yet** and is within hearing (`hearingReach`, the gunshot
 * formula) goes to investigate the sound (`ai/Investigate` reused: watch → advance). Sound alone never hands out a target — the
 * perception cone widens toward the sound while investigating, and once the drone is **seen** `pickTarget` takes it. Enemies
 * already fighting, wave bugs, staggered bodies and the scan drone are left alone; one already investigating only moves its origin (that is what `beginInvestigation` does).
 */
export function onWorldNoise(sys: EnemySystem, position: THREE.Vector3, radius: number): void {
  // 2026-09-14: a no-op in the tutorial too — investigating (= leaving its post and advancing) collides with 「no patrolling」
  if (sys.training || sys.tutorial || !sys.authority || !sys.ctx.isGameplayPhase() || !(radius > 0)) return;
  for (let i = 0; i < sys.active.length; i++) {
    const e = sys.active[i];
    if (!e.isCombatant || e.aware || e.relentless || e.state === 'stagger' || e.type === 'rogue_scan_drone') continue;
    const dx = e.position.x - position.x, dz = e.position.z - position.z;
    const reach = hearingReach(e, radius);
    if (dx * dx + dz * dz > reach * reach) continue;
    beginInvestigation(e, position);
  }
}

/**
 * Phase 4 target selection. Bugs: nearest of (alive players, rogues within sight radius) — equal priority.
 * Rogues: the nearest alive player within ROGUE_RANGE; otherwise a bug within ROGUE_AI.bugRange, else the nearest player.
 * 2026-09-11 (enemy ↔ drone): an **aggroable** drone (`pickDroneTarget`) is picked when it is clearly closer than the player
 * (< `DRONE_PREFER_MUL` ×) or there is no player, and at least as close as the hostile enemy. Bugs never take Roden's
 * scan drone (`rogue_scan_drone`) as a hostile — it flies, so a melee bug would circle underneath it forever.
 */
export function pickTarget(sys: EnemySystem, e: Enemy): CombatTarget | null {
  // Phase 12: an enemy that bumped a raised barrier hunts the carrier for BARRIER_RETARGET_S
  if (e.barrierOwner !== null && sys.ctx.time < e.barrierUntil) {
    const carrier = sys.targets.get(e.barrierOwner);
    if (carrier && carrier.present && !carrier.isDeadOrDowned) return carrier;
  }
  /* 2026-09-15 (android squadmates): a person and an android are targets of **exactly equal standing** — the nearer one wins.
     `nearestAlive` itself still sees people only (spawner anchors · wave facing · a replica's gaze must be measured on people). */
  let player = sys.targets.nearestAlive(e.position);
  let pd = player ? player.dist2D(e.position) : Infinity;
  if (!ignoresAllies(e)) {
    const ally = sys.targets.nearestAllyAlive(e.position);
    if (ally) {
      const ad = ally.dist2D(e.position);
      if (ad < pd) { player = ally; pd = ad; }
    }
  }
  // 2026-09-13 (the rover): an enemy the vehicle hit goes for the vehicle first — after the barrier carrier, before every other rule
  const vehicle = pickVehicleTarget(sys, e, pd);
  if (vehicle && sys.ctx.time < e.vehicleAggroUntil) return vehicle;
  // 2026-09-14 (tutorial-only enemies): the radius that looks for another faction stays inside the sense radius too — a bug and an android do not bite each other across stretches
  const range = e.senseRadius > 0
    ? Math.min(e.isHumanoid ? ROGUE_AI.bugRange : e.stats.sightRadius, e.senseRadius)
    : (e.isHumanoid ? ROGUE_AI.bugRange : e.stats.sightRadius);
  let foe: Enemy | null = null;
  let fd = range;
  for (let i = 0; i < sys.active.length; i++) {
    const o = sys.active[i];
    if (o === e || !o.isCombatant || o.faction === e.faction) continue;
    if (o.type === 'rogue_scan_drone') continue;   // only bugs get this far (to a rogue it is the same faction)
    const d = Math.hypot(o.position.x - e.position.x, o.position.z - e.position.z);
    if (d < fd) { fd = d; foe = o; }
  }
  const drone = pickDroneTarget(sys, e, player ? pd * DRONE_PREFER_MUL : Infinity);
  if (drone && (!foe || drone.dist2D(e.position) <= fd)) return drone;
  // 2026-09-13: a noticed vehicle (clearly closer than the player — `pickVehicleTarget`) — when it is as close as the hostile-faction enemy, or closer
  if (vehicle && (!foe || vehicle.dist2D(e.position) <= fd)) return vehicle;
  if (e.isHumanoid) {
    if (player && pd < ROGUE_RANGE && (!foe || fd > pd * 0.5)) return player;
    return foe ? foe.asTarget : player;
  }
  if (foe && fd < pd) return foe.asTarget;
  return player;
  }

/* ── Phase 12: shot tracking ───────────────────────────────────────────── */
/**
 * `shotq` from a client (host only): validate and run the shooter's report as if it were local, credited to `from`.
 * `force` (debug / smoke) skips the session gate but keeps the authority one and the validation.
 */
export function onShotReport(sys: EnemySystem, msg: ShotReport, from: PeerId, force = false): void {
  if (sys.training || !sys.authority || (!force && !sys.hosting)) return;   // 2026-09-14 2nd pass: the tutorial exception is gone (the `reportShot` comment)
  if (!isVec3Tuple(msg.o) || !isVec3Tuple(msg.d) || !(msg.r > 0)) return;
  _so.set(msg.o[0], msg.o[1], msg.o[2]);
  _sd.set(msg.d[0], msg.d[1], msg.d[2]);
  if (_sd.lengthSq() < 0.5) return;
  _sd.normalize();
  let hit: THREE.Vector3 | null = null;
  if (msg.h !== undefined) {
    if (!isVec3Tuple(msg.h)) return;
    hit = _sh.set(msg.h[0], msg.h[1], msg.h[2]);
  }
  sys.alertShot(_so, _sd, Math.min(msg.r, MAX_SHOT_RANGE), hit, sys.normalizeAttacker(from));
  }

/**
 * The alert routine (authority). Every alive simulated enemy that has **no perceived target** (unaware, not
 * incapacitated / staggered / fleeing / a wave bug) and sits within `ENEMY_SHOT_ALERT_DIST` of the bullet path
 * (closest approach of its body centre to origin → origin + dir × range) or `ENEMY_SHOT_IMPACT_DIST` of the
 * impact, and that could **not** perceive the shooter by the normal rule (`canPerceive`, no cone — it would spot the
 * shooter on its own next tick anyway), starts investigating the origin (`ai/Investigate.ts`) → `enemy:shotAlerted`
 * once. An enemy already investigating only refreshes its origin. The perception test is throttled per enemy.
 *
 * 2026-09-14 2nd pass: it counts **only as far as the bullet actually stopped**. `range` is the gun's range (up to 300 m), so
 * shooting a wall right in front used to read as 「a bullet grazed me」 to every enemy within 300 m along that bearing — the
 * most painful misjudgement there is for sniping and stealth. With a `hit` the segment is cut there (`hit` is where this bullet got no further).
 */
export function alertShot(sys: EnemySystem, origin: THREE.Vector3, dir: THREE.Vector3, range: number, hit: THREE.Vector3 | null, shooter: TargetId): void {
  if (!sys.ctx.isGameplayPhase()) return;
  const now = sys.ctx.time;
  const pathLen = hit ? Math.min(range, origin.distanceTo(hit)) : range;
  const sh = shooter === 'ai' ? undefined : sys.targets.get(shooter);
  const shooterUp = !!sh && sh.present && !sh.isDeadOrDowned;
  for (let i = 0; i < sys.active.length; i++) {
    const e = sys.active[i];
    if (!e.isCombatant || e.aware || e.relentless || e.state === 'stagger') continue;
    const r = e.stats.radius;
    const cx = e.position.x, cy = e.position.y + e.stats.height * 0.5, cz = e.position.z;
    let near = false;
    if (hit) {
      const dx = cx - hit.x, dy = cy - hit.y, dz = cz - hit.z;
      const reach = ENEMY_SHOT_IMPACT_DIST + r;
      near = dx * dx + dy * dy + dz * dz <= reach * reach;
    }
    if (!near) {
      const ox = cx - origin.x, oy = cy - origin.y, oz = cz - origin.z;
      const t = THREE.MathUtils.clamp(ox * dir.x + oy * dir.y + oz * dir.z, 0, pathLen);
      const px = ox - dir.x * t, py = oy - dir.y * t, pz = oz - dir.z * t;
      const reach = ENEMY_SHOT_ALERT_DIST + r;
      near = px * px + py * py + pz * pz <= reach * reach;
    }
    if (!near) continue;
    if (e.investigating) { e.shotOrigin.copy(origin); continue; }
    if (now - e.shotCheckAt < SHOT_CHECK_INTERVAL) continue;
    e.shotCheckAt = now;
    if (shooterUp && canPerceive(e, sys, sh!, false)) continue;
    if (!beginInvestigation(e, origin)) continue;
    sys.ctx.bus.emit('enemy:shotAlerted', { id: e.id, position: e.position.clone(), toward: origin.clone() });
  }
  }

/** First bug ↔ rogue engagement within CLASH_RADIUS of the local player (throttled) → `enemy:factionClash`. */
export function noteClash(sys: EnemySystem, position: THREE.Vector3): void {
  const ctx = sys.ctx;
  if (ctx.time - sys.lastClash < CLASH_THROTTLE) return;
  if (sys.targets.distToLocal(position) > CLASH_RADIUS) return;
  sys.lastClash = ctx.time;
  ctx.bus.emit('enemy:factionClash', { position: position.clone() });
  }

/* ── helpers ───────────────────────────────────────────────────────────── */
export function fleeFrom(sys: EnemySystem, position: THREE.Vector3, radius: number): void {
  const r2 = radius * radius;
  for (let i = 0; i < sys.active.length; i++) {
    const e = sys.active[i];
    if (!e.active || e.state === 'dead' || e.state === 'flee') continue;
    if (isWormType(e.type)) continue;   // 2026-09-13: it is rooted in the ground — it never flees (fleeing makes a body despawn after FLEE_DURATION)
    // 2026-09-18: a bug egg does not flee either, for the same reason — once in `flee` it is filtered out by `raycastEx`, so a nest's eggs could not be shot after liftoff
    if (e.isEgg) continue;
    const dx = e.position.x - position.x, dz = e.position.z - position.z;
    if (dx * dx + dz * dz > r2) continue;
    e.state = 'flee'; e.stateTime = 0; e.fleeTimer = 0;
    e.fleeFrom.copy(position);
    e.aware = false; e.investigating = false; e.airborne = false; e.chargePhase = 0; e.spitPhase = 0; e.roguePhase = 0; e.toxicPhase = 0;
    e.anim.shake = 0; e.anim.abdomen = 0; e.anim.crouch = 0;
  }
  }
