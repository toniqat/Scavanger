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
  type HumanoidSpawnOpts, type HitRequest, type InterceptableRef, type PeerId, type PlanetEcosystem, type ShotReport, type Vec3Tuple, type WorldRef,
} from '@/shared';
import { FxManager, ParticleBurst } from '@/core/fx';
import { Enemy, type EnemyHost, type HitPart } from '../Enemy';
import { ROGUE_AI, SPEWER_SPIT, isWormType } from '../EnemyTypes';
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
import type { RogueSpawnHost } from '../RogueGuards';
import { disposeRogueDropAssets } from '../RogueDrop';
import { raySphere, rayCapsule, rayStandingCapsule } from '../RayTests';
import { BARRIER_BUMP_INTERVAL, BARRIER_RETARGET_S, BURN_TICK, CLASH_RADIUS, CLASH_THROTTLE, CORPSE_SLACK, EMBER_INTERVAL, FLEE_DURATION, GRENADE_KNOCKBACK, GRENADE_LOB_SPEED, GRENADE_NOISE, GUNFIRE_LURE_DURATION, GUNFIRE_LURE_WEIGHT, INCAP_EMBER_INTERVAL, MAX_REQUEST_DAMAGE, MAX_REQUEST_RADIUS, MAX_SHOT_RANGE, MAX_STATUS_DURATION, PROMOTE_ID_GAP, PROMOTE_SEQ_GAP, RECYCLE_DISTANCE, SHIELD_CONTACT_Y, SHOCK_SPARK_TIME, SHOT_CHECK_INTERVAL, SPARK_INTERVAL, STATUS_REQUEST_INTERVAL, SUSPICION_RADIUS, SUSPICION_REFRESH, _aim, _c, _dir, _eye, _hc, _hd, _hp, _kb, _m, _sd, _sh, _so, _to, _v, _v2, _zero, deathDirIndex, isVec3Tuple, killedBuf, queryBuf } from '../model';
import type { EnemySystem } from '../EnemySystem';
import { rollGrenadeLoadout } from '../ai/HumanoidProfile';
import { isNamedAiType } from '../ai/named';
/* appended (2026-09-13): 굴착 스폰 · 땅굴벌레 */
import { emergeFx } from './Burrow';
import { disposeWormAssets } from '../models/WormModel';

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
  sys.sandworm.reset();       // 2026-09-13: 땅굴벌레 굴림 · 전조 · 받아 둔 메타도 레이드마다
  sys.burrowFx?.clear();
  sys.burrowShakeAt = -Infinity;
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
  sys.nextSquadId = 1;        // 2026-09-13: 분대 id 는 레이드 안에서만 유일하다 (거점 그룹 · 강하 파도 · 헤비 분대)
  sys.sitePlacement = null;   // 2026-09-13: 거점 점거 기록 (디버그 · 스모크)
  sys.lastClash = -Infinity;
  sys.training = false;
  sys.tutorial = false;             // 2026-09-14: `world:ready` 가 매 미션 다시 정한다
  sys.tutorialPlacement = null;     // 2026-09-14: 튜토리얼 고정 배치 기록 (디버그 · 스모크)
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

/**
 * 종류별 상한(포병 · 베헤모스)이 세는 **살아 있는 몸**. 2026-09-17 (포병 2마리 버그): 예전에는 `isCombatant` 로 셌는데, 그것은 전소로
 * 몸부림치는 몸(`incapTimer > 0`)과 이륙에 놀라 달아나는 몸(`flee`, `FLEE_DURATION` 뒤에야 사라진다)을 **빼고** 센다 — 그 몇 초 사이에
 * 순찰 틱이 돌면 상한 1 인 행성에 포병이 하나 더 파고 나왔다. 상한은 "지금 월드에 서 있는 몸" 이라 죽지 않은 몸은 모두 센다.
 */
export function countAlive(sys: EnemySystem, type: EnemyType): number {
  let n = 0;
  for (let i = 0; i < sys.active.length; i++) { const e = sys.active[i]; if (e.type === type && e.active && e.state !== 'dead') n++; }
  return n;
  }

export function ensureCapacity(sys: EnemySystem, n: number, cap: number): number {
  // 1) recycle far, unseen, unaware bugs when the alive cap is tight (rogue guards stay)
  let alive = sys.aliveCount();
  if (alive + n > cap && sys.targets.all.length > 0) {
    for (let i = sys.active.length - 1; i >= 0 && alive + n > cap; i--) {
      const e = sys.active[i];
      if (!e.active || e.state === 'dead' || e.aware || e.relentless || e.isHumanoid) continue;
      if (e.escortOf && e.escortOf.isCombatant) continue;   // 2026-09-17: 살아 있는 포병의 호위는 포병과 함께 남는다 (`ai/ArtilleryPack`)
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

/** `emerge` (2026-09-13) > 0 = 벌레가 그 초 동안 땅을 파고 올라온다 (`Enemy.startEmerge` + 연출 + `ee spawn.em`). 인간형은 무시. */
export function spawn(sys: EnemySystem, type: EnemyType, position: THREE.Vector3, yaw: number, chase: boolean, relentless: boolean, emerge = 0): Enemy | null {
  const ctx = sys.ctx;
  const e = sys.acquire(sys.nextId++, type, position, yaw);
  if (!e) return null;
  e.relentless = relentless;
  if (chase) { e.aware = true; e.state = 'chase'; e.perceptionTimer = 0.3 + Math.random() * 0.3; }
  const em = emerge > 0 && e.faction === 'bug' ? emerge : 0;
  if (em > 0) { e.startEmerge(em); emergeFx(sys, e); }
  ctx.bus.emit('enemy:spawned', { id: e.id, type, position: e.position });
  if (sys.hosting) {
    const msg: Extract<EnemyEvent, { ev: 'spawn' }> = { t: 'ee', ev: 'spawn', id: e.id, ty: type, p: tuple(e.position, 2), yaw: round(yaw, 3) };
    if (em > 0) msg.em = round(em, 2);
    ctx.net!.send(msg, 'others');
  }
  return e;
  }

/* ── RogueSpawnHost ────────────────────────────────────────────────────── */
export function spawnRogue(sys: EnemySystem, type: EnemyType, position: THREE.Vector3, yaw: number, guardPos: THREE.Vector3, weaponId: string, escortOf: Enemy | null, opts?: HumanoidSpawnOpts): Enemy | null {
  const e = sys.spawn(type, position, yaw, false, false);
  if (!e) return null;
  e.guardPos.copy(guardPos);
  e.weaponId = weaponId;
  e.escortOf = escortOf;
  if (escortOf) e.leash = ROGUE_AI.escortLeash;
  // 2026-09-13 (계약): 거점 · 분대 · 역할. 수류탄 보유(`grenadeKind` / `grenadeCount`)는 인간형 AI 담당이 여기서 굴린다.
  e.site = opts?.site ?? null;
  e.squadId = opts?.squadId ?? -1;
  e.squadRole = opts?.role ?? 'member';
  // 팩션 표(`HUMANOID_*.grenadeMin/Max · incendiaryChance`)로 1–3개 · 종류. 안드로이드 0, 네임드 · 스캔 드론은 던지는 AI 가 없어 0.
  rollGrenadeLoadout(e, isNamedAiType(type));
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
  // 2026-09-14: 행성 threat 벌레 체력 (`BUG_HP_MUL_BY_THREAT`). 권위 스폰(`spawn`)도 리플리카(`ee spawn` · 스냅샷이 처음 본 id)도 여기를
  // 지나고, 배수는 모든 클라이언트가 `world:ready` 에서 같은 행성으로 정해 둔다 — 그래서 와이어 없이 리플리카의 `maxHp`(피격 흔들림 ·
  // 승격 때 hp 상한)가 호스트와 같다. 인간형 팩션 · 땅굴벌레(자기 `SANDWORM_HP_*` 굴림) 제외, 훈련장 · 행성 없음은 ×1.
  const hpMul = sys.bugTuning.hpMul;
  if (hpMul !== 1 && e.faction === 'bug' && !isWormType(type)) e.hp = e.maxHp = Math.max(1, Math.round(e.stats.hp * hpMul));
  // 2026-09-14 4차: 이번 레이드의 시체 수명 (`reset` 이 넣은 `CORPSE_LIFETIME` 을 덮는다). 튜토리얼만 `Infinity` 라
  // 본편 · 훈련장은 45초 그대로이고, 리플리카도 같은 값을 쓴다 (레이드 종류는 모든 클라이언트가 `world:ready` 에서 같이 정한다).
  e.corpseLife = sys.corpseLifetime;
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
  disposeWormAssets();        // 2026-09-13: 땅굴벌레 공유 지오메트리 (리그는 위 풀 dispose 에서 먼저 빠졌다)
  }
