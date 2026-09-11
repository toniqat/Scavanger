/**
 * src/enemies/parts/Alerts.ts — **적이 무엇을 눈치채는가**.
 *
 * 소리(총성 · 유인탄) · 시야 · 팩션 충돌 · 그리고 Phase 12 의 **총알 추적**: 감지 범위 밖에서 날아온
 * 총알의 발사 지점을 향해 돌아서서(`alertShot`) 그 방향 감지를 넓히고, 못 찾으면 전진한다.
 * 표적 선택(`pickTarget`)과 도주(`fleeFrom`)도 같은 인지 계통이다.
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
import { ROGUE_AI, SPEWER_SPIT } from '../EnemyTypes';
import { SpatialGrid } from '../SpatialGrid';
import { CombatTarget, TargetList, type TargetId } from '../Targets';
import { SUSPICION_TIME, updateEnemyAI } from '../ai/EnemyAI';
import { LureField } from '../ai/Lures';
import { becomeAlert, canPerceive } from '../ai/Perception';
import { beginInvestigation, endInvestigation } from '../ai/Investigate';
import { BloodFX } from '../fx/BloodFX';
import { EnemyXray } from '../fx/Xray';
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

/* ── Phase 12: 총알 추적 · 정찰 x-ray (EnemyManagerRef) ─────────────────── */
/**
 * A local shot was fired (weapons calls this for every one). Authority: run the alert routine; a joined client
 * forwards it to the host as `shotq` instead (replicas have no AI). No-op on the 훈련장.
 */
export function reportShot(sys: EnemySystem, origin: THREE.Vector3, dir: THREE.Vector3, range: number, hit: THREE.Vector3 | null): void {
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
  sys.lures.add(pos, radius, duration, weight, sys.ctx.time);
  if (weight < 0.3) return;
  // a real lure also wakes the swarm around it
  const r2 = radius * radius;
  let loudBudget = 2;
  for (let i = 0; i < sys.active.length; i++) {
    const e = sys.active[i];
    if (!e.active || e.state === 'dead' || e.state === 'flee') continue;
    const dx = e.position.x - pos.x, dz = e.position.z - pos.z;
    if (dx * dx + dz * dz > r2) continue;
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
    if (dx * dx + dz * dz <= r2) becomeAlert(e, sys, false);
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
  sys.lures.add(position, radius, GUNFIRE_LURE_DURATION, GUNFIRE_LURE_WEIGHT, sys.ctx.time);
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

/** 반경 `radius` 의 소리를 `e` 가 들을 수 있는 거리 — 총성에서 쓰던 식 그대로이고 소음원(총성 · 수류탄 · 드론)과 무관하다. */
function hearingReach(e: Enemy, radius: number): number {
  return Math.min(radius, e.stats.hearRadius + (radius - 55));
}

/**
 * 드론을 노리려면 플레이어보다 이만큼 **확실히** 가까워야 한다 — `ai/Perception.acquireTarget` 의 표적 교체
 * 히스테리시스(LOS 있을 때 0.6)와 같은 값이다. 알고리즘 상수라 csv 대상이 아니다.
 */
const DRONE_PREFER_MUL = 0.6;

/** 근접으로만 싸우는 적 — 공중 드론이 공격 사거리 위에 떠 있으면 노리지 않는다 (밑에서 영원히 맴돈다). */
function isMeleeOnly(e: Enemy): boolean {
  if (e.type === 'spewer' || e.type === 'artillery') return false;
  return !e.isRogue || e.type === 'rogue_hammer';
}

/**
 * 2026-09-11 (적 ↔ 드론): `e` 가 지금 노릴 수 있는 가장 가까운 드론. 후보는 `TargetList.drones`(= `aggroable` —
 * 걷는 지상 드론은 애초에 없다) 중에서 ① `maxDist` 보다 가깝고 ② 근접형이면 드론 밑면이 `키 + 공격 사거리` 안에
 * 떠 있고 ③ 기존 인지 규칙(`canPerceive`: 시야 반경 × 은폐 · 연막, 5 m 근접 또는 사선, 총알 추적 콘 포함)을
 * 통과하는 것. 레이캐스트는 앞의 두 값싼 검사를 통과한 드론에만 쏜다. 스캔 드론(`rogue_scan_drone`)은 드론을 노리지 않는다.
 */
export function pickDroneTarget(sys: EnemySystem, e: Enemy, maxDist: number): CombatTarget | null {
  const list = sys.targets.drones;
  if (list.length === 0 || e.type === 'rogue_scan_drone') return null;
  const meleeOnly = isMeleeOnly(e);
  const reachUp = e.stats.height + e.stats.attackRange;
  let best: CombatTarget | null = null;
  let bestD = Math.min(maxDist, e.stats.sightRadius);
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

/**
 * 2026-09-11 (적 ↔ 드론): `world:noise` — 질주하는 지상 드론. **권한 클라이언트에서만** 나오고 여기서도 권한만 반응한다.
 * 들을 수 있는 거리(`hearingReach`, 총성과 같은 식) 안에서 **아직 아무것도 인지하지 못한** 적이 그 소리 쪽을 조사하러
 * 간다(`ai/Investigate` 재사용: 주시 → 전진). 소리만으로 표적을 주지는 않는다 — 조사하는 동안 인지 콘이 소리 쪽으로
 * 넓어지고, 드론이 **보이면** `pickTarget` 이 그것을 고른다. 이미 싸우는 적 · 웨이브 벌레 · 경직 · 스캔 드론은
 * 건드리지 않고, 이미 조사 중이면 원점만 옮긴다(`beginInvestigation` 이 그렇게 동작한다).
 */
export function onWorldNoise(sys: EnemySystem, position: THREE.Vector3, radius: number): void {
  if (sys.training || !sys.authority || !sys.ctx.isGameplayPhase() || !(radius > 0)) return;
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
 * 2026-09-11 (적 ↔ 드론): an **aggroable** drone (`pickDroneTarget`) is picked when it is clearly closer than the player
 * (< `DRONE_PREFER_MUL` ×) or there is no player, and at least as close as the hostile enemy. Bugs never take 로든's
 * scan drone (`rogue_scan_drone`) as a hostile — it flies, so a melee bug would circle underneath it forever.
 */
export function pickTarget(sys: EnemySystem, e: Enemy): CombatTarget | null {
  // Phase 12: an enemy that bumped a raised 배리어 hunts the carrier for BARRIER_RETARGET_S
  if (e.barrierOwner !== null && sys.ctx.time < e.barrierUntil) {
    const carrier = sys.targets.get(e.barrierOwner);
    if (carrier && carrier.present && !carrier.isDeadOrDowned) return carrier;
  }
  const player = sys.targets.nearestAlive(e.position);
  const pd = player ? player.dist2D(e.position) : Infinity;
  const range = e.isRogue ? ROGUE_AI.bugRange : e.stats.sightRadius;
  let foe: Enemy | null = null;
  let fd = range;
  for (let i = 0; i < sys.active.length; i++) {
    const o = sys.active[i];
    if (o === e || !o.isCombatant || o.faction === e.faction) continue;
    if (o.type === 'rogue_scan_drone') continue;   // 버그만 여기까지 온다 (로그에게는 같은 팩션)
    const d = Math.hypot(o.position.x - e.position.x, o.position.z - e.position.z);
    if (d < fd) { fd = d; foe = o; }
  }
  const drone = pickDroneTarget(sys, e, player ? pd * DRONE_PREFER_MUL : Infinity);
  if (drone && (!foe || drone.dist2D(e.position) <= fd)) return drone;
  if (e.isRogue) {
    if (player && pd < ROGUE_RANGE && (!foe || fd > pd * 0.5)) return player;
    return foe ? foe.asTarget : player;
  }
  if (foe && fd < pd) return foe.asTarget;
  return player;
  }

/* ── Phase 12: 총알 추적 ───────────────────────────────────────────────── */
/**
 * `shotq` from a client (host only): validate and run the shooter's report as if it were local, credited to `from`.
 * `force` (debug / smoke) skips the session gate but keeps the authority one and the validation.
 */
export function onShotReport(sys: EnemySystem, msg: ShotReport, from: PeerId, force = false): void {
  if (sys.training || !sys.authority || (!force && !sys.hosting)) return;
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
 */
export function alertShot(sys: EnemySystem, origin: THREE.Vector3, dir: THREE.Vector3, range: number, hit: THREE.Vector3 | null, shooter: TargetId): void {
  if (!sys.ctx.isGameplayPhase()) return;
  const now = sys.ctx.time;
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
      const t = THREE.MathUtils.clamp(ox * dir.x + oy * dir.y + oz * dir.z, 0, range);
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
    const dx = e.position.x - position.x, dz = e.position.z - position.z;
    if (dx * dx + dz * dz > r2) continue;
    e.state = 'flee'; e.stateTime = 0; e.fleeTimer = 0;
    e.fleeFrom.copy(position);
    e.aware = false; e.investigating = false; e.airborne = false; e.chargePhase = 0; e.spitPhase = 0; e.roguePhase = 0; e.toxicPhase = 0;
    e.anim.shake = 0; e.anim.abdomen = 0; e.anim.crouch = 0;
  }
  }
