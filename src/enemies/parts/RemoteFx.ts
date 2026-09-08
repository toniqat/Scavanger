/**
 * src/enemies/parts/RemoteFx.ts — **리플리카에서 재생하는 연출**.
 *
 * 비호스트 클라이언트는 AI 를 돌리지 않는다. 호스트가 보낸 `ee` 이벤트(피격 · 산성 · 포탄 · 돌진 · 시체 ·
 * 수류탄)를 받아 여기서 **그림과 소리만** 만든다. 게임 상태는 하나도 바꾸지 않는 것이 이 파일의 계약이다.
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

export function bloodBurst(sys: EnemySystem, point: THREE.Vector3, count: number, dir: THREE.Vector3 | null): void {
  if (!sys.fx) return;
  if (dir) sys.fx.burst(point, count, 'blood', 4.5, dir, 0.9);
  else sys.fx.burst(point, count, 'blood', 4);
  }

export function acidVisual(sys: EnemySystem, from: THREE.Vector3, target: CombatTarget, shooterId: number): void {
  sys.acid?.fireAt(from, target.position, shooterId);
  }

export function rogueShotVisual(sys: EnemySystem, id: number, from: THREE.Vector3, to: THREE.Vector3, hit: boolean): void {
  const e = sys.byId.get(id);
  sys.shotFx(from, to, hit ? 1 : 0);
  sys.ctx.bus.emit('enemy:shot', { id, type: e?.type ?? 'rogue', from: from.clone(), to: to.clone(), hit });
  }

export function shellVisual(sys: EnemySystem, sid: number, from: THREE.Vector3, target: THREE.Vector3, flight: number): void {
  sys.shells?.fire(sid, from, target, flight);
  sys.playAudio('bug_attack', from, 1, 0.45);
  sys.ctx.bus.emit('enemy:shellFired', { sid, from: from.clone(), target: target.clone(), flightTime: flight });
  }

export function shellInterceptedRemote(sys: EnemySystem, sid: number, p: THREE.Vector3): void {
  // pop it if it still flies here (local = false: nothing to send back)
  if (!sys.shells?.interceptById(sid, p, false)) sys.onShellIntercepted(sid, p, false);
  }

export function shellLandedRemote(sys: EnemySystem, sid: number, p: THREE.Vector3): void {
  if (!sys.shells) return;
  if (sys.shells.find(sid)) { sys.shells.landById(sid, p); sys.onShellLanded(sid, p); }
  // else: it already landed locally (own simulation) — FX and event were played then
  }

export function chargeVisual(sys: EnemySystem, id: number, target: THREE.Vector3): void {
  const e = sys.byId.get(id);
  if (e) sys.playAudio('bug_attack', e.position, 1.0, 0.4);
  sys.ctx.bus.emit('enemy:chargeStarted', { id, position: e ? e.position : target.clone(), target: target.clone() });
  }

export function toxicVisual(sys: EnemySystem, id: number, p: THREE.Vector3): void {
  sys.toxicFx(p);
  sys.ctx.bus.emit('enemy:toxicBurst', { id, position: p.clone(), radius: TOXIC_RADIUS });
  }

export function corpseSpawnedRemote(sys: EnemySystem, id: number, type: EnemyType, p: THREE.Vector3, weaponId: string | undefined, opts?: CorpseWireOpts): void {
  // Phase 10: the host's `lt` / `dd` win over the local seeded roll (identical seeds agree anyway — this just makes
  // the authority explicit) and the body's own fall direction is corrected to match.
  const e = sys.byId.get(id);
  if (e) {
    if (opts?.lootable !== undefined) e.lootable = opts.lootable;
    if (opts?.deathDir) { e.deathDir = opts.deathDir; e.anim.deathDir = Math.max(0, ENEMY_DEATH_DIRS.indexOf(opts.deathDir)); }
    e.corpsePending = false;
  }
  sys.corpses.add(id, type, p, weaponId, sys.ctx.world?.seed ?? 0, opts);
  }

export function corpseGoneRemote(sys: EnemySystem, id: number): void { sys.corpses.remove(id); }

export function grenadeVisual(sys: EnemySystem, id: number, p: THREE.Vector3, v: THREE.Vector3, fuse: number): void {
  if (!sys.grenades) return;
  sys.grenades.throw(id, p, v, fuse, false);
  sys.grenadesThrown++;
  const e = sys.byId.get(id);
  sys.playAudio('grenade_throw', e ? e.position : p, 0.7, 0.95);
  }

export function grenadeHitRemote(sys: EnemySystem, p: THREE.Vector3): void { sys.grenades?.explodeNear(p); }

export function onChargeStarted(sys: EnemySystem, e: Enemy, target: THREE.Vector3): void {
  const ctx = sys.ctx;
  ctx.bus.emit('enemy:chargeStarted', { id: e.id, position: e.position, target: target.clone() });
  if (sys.hosting) ctx.net!.send({ t: 'ee', ev: 'charge', id: e.id, target: tuple(target, 2) }, 'others');
  }

export function playAudio(sys: EnemySystem, id: string, position: THREE.Vector3, volume = 1, pitch = 1): void {
  const now = sys.ctx.time;
  const gap = id === 'bug_step' ? 0.05 : id === 'bug_hit' || id === 'hit_flesh' ? 0.04 : id === 'shot_rifle' ? 0.03 : 0.12;
  const last = sys.lastAudio.get(id);
  if (last !== undefined && now - last < gap) return;
  sys.lastAudio.set(id, now);
  sys.ctx.bus.emit('audio:play', { id, position, volume, pitch });
  }
