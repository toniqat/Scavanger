/**
 * src/enemies/parts/Pool.ts — **적 인스턴스 풀**.
 *
 * 적은 생성/파괴하지 않고 고정 풀에서 빌려 쓴다(`acquire` / `release`) — 프레임당 할당을 피하려는 것이고,
 * 그래서 id 재사용 규칙(`find`)과 용량 확장(`ensureCapacity`)이 한곳에 있어야 한다.
 * 미션 리셋(`reset`)과 지오메트리 dispose(`disposePools`)도 이 파일의 책임이다.
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
import { disposeRogueDropAssets } from '../RogueDrop';
import { raySphere, rayCapsule, rayStandingCapsule } from '../RayTests';
import { BARRIER_BUMP_INTERVAL, BARRIER_RETARGET_S, BURN_TICK, CLASH_RADIUS, CLASH_THROTTLE, CORPSE_SLACK, EMBER_INTERVAL, FLEE_DURATION, GRENADE_KNOCKBACK, GRENADE_LOB_SPEED, GRENADE_NOISE, GUNFIRE_LURE_DURATION, GUNFIRE_LURE_WEIGHT, INCAP_EMBER_INTERVAL, MAX_REQUEST_DAMAGE, MAX_REQUEST_RADIUS, MAX_SHOT_RANGE, MAX_STATUS_DURATION, PROMOTE_ID_GAP, PROMOTE_SEQ_GAP, RECYCLE_DISTANCE, SHIELD_CONTACT_Y, SHOCK_SPARK_TIME, SHOT_CHECK_INTERVAL, SPARK_INTERVAL, STATUS_REQUEST_INTERVAL, SUSPICION_RADIUS, SUSPICION_REFRESH, _aim, _c, _dir, _eye, _hc, _hd, _hp, _kb, _m, _sd, _sh, _so, _to, _v, _v2, _zero, deathDirIndex, isVec3Tuple, killedBuf, queryBuf } from '../model';
import type { EnemySystem } from '../EnemySystem';

export function killAll(sys: EnemySystem): void {
  for (let i = 0; i < sys.active.length; i++) {
    const e = sys.active[i];
    if (e.active && e.state !== 'dead') e.kill(false);
  }
  }

export function reset(sys: EnemySystem): void {
  sys.resetting = true;
  sys.lures.clear();
  sys.xray.clear();
  for (let i = sys.active.length - 1; i >= 0; i--) sys.despawn(sys.active[i]);
  sys.active.length = 0;
  sys.byId.clear();
  sys.waves.reset();
  sys.spawner.reset();
  sys.replicaMgr.clear();
  sys.targets.clear();
  sys.corpses.clear();
  sys.rogueDrops.reset();     // 2026-09-09: 굴림 기록(구역당 1회)도 레이드마다 새로 시작한다
  sys.named.reset();          // 2026-09-11: 네임드 굴림 결과 · 알림 기록도 레이드마다 (네임드 · 호위는 로그라 `ensureCapacity` 재활용 대상이 아니다)
  sys.fx?.clear();
  sys.acid?.clear();
  sys.shells?.clear();
  sys.grenades?.clear();
  sys.lastAudio.clear();
  sys.snapTimer = 0;
  sys.hazardTick = 0;
  sys.snapCache.reset();
  sys.bossId = 0;
  sys.lastClash = -Infinity;
  sys.training = false;
  sys.wavesSeen = 0;
  sys.grenadesThrown = 0;
  sys.grenadesExploded = 0;
  sys.resetting = false;
  }

/* ── SpawnHost ─────────────────────────────────────────────────────────── */
export function aliveCount(sys: EnemySystem): number {
  let n = 0;
  for (let i = 0; i < sys.active.length; i++) { const e = sys.active[i]; if (e.isCombatant) n++; }
  return n;
  }

export function countAlive(sys: EnemySystem, type: EnemyType): number {
  let n = 0;
  for (let i = 0; i < sys.active.length; i++) { const e = sys.active[i]; if (e.type === type && e.isCombatant) n++; }
  return n;
  }

export function ensureCapacity(sys: EnemySystem, n: number, cap: number): number {
  // 1) recycle far, unseen, unaware bugs when the alive cap is tight (rogue guards stay)
  let alive = sys.aliveCount();
  if (alive + n > cap && sys.targets.all.length > 0) {
    for (let i = sys.active.length - 1; i >= 0 && alive + n > cap; i--) {
      const e = sys.active[i];
      if (!e.active || e.state === 'dead' || e.aware || e.relentless || e.isRogue) continue;
      if (sys.targets.minDist(e.position) > RECYCLE_DISTANCE) { sys.despawn(e); alive--; }
    }
  }
  // 2) recycle oldest corpses so total entity count stays bounded
  let total = sys.active.length;
  if (total + n > cap + CORPSE_SLACK) {
    let oldest: Enemy | null;
    do {
      oldest = null;
      for (let i = 0; i < sys.active.length; i++) {
        const e = sys.active[i];
        if (e.state === 'dead' && (!oldest || e.deathTimer > oldest.deathTimer)) oldest = e;
      }
      if (oldest) { sys.despawn(oldest); total--; }
    } while (oldest && total + n > cap + CORPSE_SLACK);
  }
  return Math.max(0, Math.min(n, cap - alive));
  }

export function spawn(sys: EnemySystem, type: EnemyType, position: THREE.Vector3, yaw: number, chase: boolean, relentless: boolean): Enemy | null {
  const ctx = sys.ctx;
  const e = sys.acquire(sys.nextId++, type, position, yaw);
  if (!e) return null;
  e.relentless = relentless;
  if (chase) { e.aware = true; e.state = 'chase'; e.perceptionTimer = 0.3 + Math.random() * 0.3; }
  ctx.bus.emit('enemy:spawned', { id: e.id, type, position: e.position });
  if (sys.hosting) ctx.net!.send({ t: 'ee', ev: 'spawn', id: e.id, ty: type, p: tuple(e.position, 2), yaw: round(yaw, 3) }, 'others');
  return e;
  }

/* ── RogueSpawnHost ────────────────────────────────────────────────────── */
export function spawnRogue(sys: EnemySystem, type: EnemyType, position: THREE.Vector3, yaw: number, guardPos: THREE.Vector3, weaponId: string, escortOf: Enemy | null): Enemy | null {
  const e = sys.spawn(type, position, yaw, false, false);
  if (!e) return null;
  e.guardPos.copy(guardPos);
  e.weaponId = weaponId;
  e.escortOf = escortOf;
  if (escortOf) e.leash = ROGUE_AI.escortLeash;
  return e;
  }

/* ── ReplicaHost ───────────────────────────────────────────────────────── */
export function find(sys: EnemySystem, id: number): Enemy | undefined { return sys.byId.get(id); }

/** Pool → active with an explicit id (host-assigned on the authority, host's id on replicas). Silent. */
export function acquire(sys: EnemySystem, id: number, type: EnemyType, position: THREE.Vector3, yaw: number): Enemy | null {
  const ctx = sys.ctx;
  if (!ctx.world?.ready) return null;
  let pool = sys.pools.get(type);
  if (!pool) { pool = []; sys.pools.set(type, pool); }
  let e = pool.pop();
  if (!e) {
    e = new Enemy(type);
    e.bindHost(sys);
  }
  if (!e.rig.root.parent) ctx.scene.add(e.rig.root);
  e.reset(id, position, yaw, ctx.time);
  sys.active.push(e);
  sys.byId.set(id, e);
  return e;
  }

export function release(sys: EnemySystem, e: Enemy): void { sys.despawn(e); }

export function despawn(sys: EnemySystem, e: Enemy): void {
  sys.xray.remove(e);
  if (sys.hosting && !sys.resetting && e.active) sys.ctx.net!.send({ t: 'ee', ev: 'despawn', id: e.id }, 'others');
  if (!sys.resetting && sys.corpses.remove(e.id) && sys.hosting) sys.ctx.net!.send({ t: 'ee', ev: 'corpseGone', id: e.id }, 'others');
  const idx = sys.active.indexOf(e);
  if (idx >= 0) {
    const last = sys.active.length - 1;
    sys.active[idx] = sys.active[last];
    sys.active.pop();
  }
  if (sys.byId.get(e.id) === e) sys.byId.delete(e.id);
  e.deactivate();
  let pool = sys.pools.get(e.type);
  if (!pool) { pool = []; sys.pools.set(e.type, pool); }
  pool.push(e);
  }

export function disposePools(sys: EnemySystem): void {
  sys.xray.dispose();   // overlays are children of the pooled rigs — detach before the rigs go
  for (const pool of sys.pools.values()) { for (const e of pool) e.dispose(); pool.length = 0; }
  sys.pools.clear();
  sys.rogueDrops.dispose(sys.ctx.scene);   // 2026-09-09: 강하 포드도 같은 리셋에서 씬에서 빠진다
  disposeBugAssets();
  disposeRogueAssets();
  disposeRogueDropAssets();
  }
