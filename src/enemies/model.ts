/**
 * src/enemies/model.ts — 적 폴더의 공용 어휘.
 *
 * EnemySystem 에서 떼어낸 상수 · 타입 · 스크래치 벡터만 있다. 클래스를 참조하지 않으므로
 * parts/* 모듈이 클래스를 되돌아 import 하지 않고 쓸 수 있다(순환 import 방지).
 * EnemySystem.ts 가 그대로 재수출하므로 기존 import 경로는 전부 유지된다.
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
import { Enemy, type EnemyHost, type HitPart } from './Enemy';
import { ROGUE_AI, SPEWER_SPIT } from './EnemyTypes';
import { SpatialGrid } from './SpatialGrid';
import { CombatTarget, TargetList, type TargetId } from './Targets';
import { SUSPICION_TIME, updateEnemyAI } from './ai/EnemyAI';
import { LureField } from './ai/Lures';
import { becomeAlert, canPerceive } from './ai/Perception';
import { beginInvestigation, endInvestigation } from './ai/Investigate';
import { BloodFX } from './fx/BloodFX';
import { EnemyXray } from './fx/Xray';
import { AcidProjectiles, type AcidHost, type AcidSlow } from './fx/AcidProjectile';
import { ShellProjectiles, type ShellHost } from './fx/ShellProjectile';
import { RogueGrenades, type GrenadeHost } from './fx/RogueGrenade';
import { AmbientSpawner, ambientGroup, waveGroup, type SpawnHost } from './Spawner';
import { WaveDirector } from './WaveDirector';
import { disposeBugAssets } from './models/BugModel';
import { disposeRogueAssets } from './models/RogueModel';
import { EnemyReplica, type ReplicaHost } from './net/Replica';
import { animHint, encodeSnapshot, round, SnapshotCache, tuple } from './net/HostSync';
import { CorpseManager, rollCorpseLootable, type CorpseWireOpts } from './Corpses';
import { placeRogueGuards, type RogueSpawnHost } from './RogueGuards';
import { raySphere, rayCapsule, rayStandingCapsule } from './RayTests';

/** Wire index of a fall direction (`ee kill.dd` / `ee corpse.dd`); 0 (`'left'`) is the omitted default. */
export function deathDirIndex(dir: EnemyDeathDir | undefined): number {
  return dir ? Math.max(0, ENEMY_DEATH_DIRS.indexOf(dir)) : 0;
}

export const FLEE_DURATION = 2;
export const CORPSE_SLACK = 30;      // corpses allowed above the alive cap before being recycled
export const RECYCLE_DISTANCE = 160;
export const MAX_REQUEST_DAMAGE = 500;
export const MAX_REQUEST_RADIUS = 20;
export const CLASH_THROTTLE = 15;
export const CLASH_RADIUS = 40;
/* ── appended: tactical kit ── */
/** Burning damage is applied in discrete ticks (quiet: no gore burst / `ee damaged` per tick). */
export const BURN_TICK = 0.5;
/** Ember puff interval for a burning bug. */
export const EMBER_INTERVAL = 0.35;
/** Bugs within this range of a shot remember where it came from (smoke return fire). */
export const SUSPICION_RADIUS = 55;
/** Per-bug throttle on the (cheap but not free) `visionFactor` test used to grade a shot. */
export const SUSPICION_REFRESH = 0.2;
/** Gunfire also acts as a weak lure so swarms converge on a firefight. */
export const GUNFIRE_LURE_WEIGHT = 0.25;
export const GUNFIRE_LURE_DURATION = 4;
/* ── appended: unique weapons (2026-09-06) ── */
/** 전소: ember puffs come ~3× as fast as plain burning (same pooled particles, no lights). */
export const INCAP_EMBER_INTERVAL = 0.12;
/** Shocked: cyan spark puffs while `shockTimer` runs. */
export const SPARK_INTERVAL = 0.09;
/** Seconds the spark visual lasts per `applyStatus('shocked')` (the slow itself uses the caller's duration). */
export const SHOCK_SPARK_TIME = 0.6;
/** Replica → host status forwarding is throttled per enemy for the continuous callers (flame / arc every tick). */
export const STATUS_REQUEST_INTERVAL = 0.25;
/** Host clamps a client's requested status duration. */
export const MAX_STATUS_DURATION = 10;
/* ── appended: Phase 7 (rogue AI v2 · live authority) ── */
/** Grenade flight time is distance / this (clamped 0.8 … 1.8 s) — a lazy lob, not a bullet. */
export const GRENADE_LOB_SPEED = 11;
/** Knockback speed at the blast centre (falls off linearly with the damage). */
export const GRENADE_KNOCKBACK = 7;
/** Hearing radius of a rogue grenade blast (wakes bugs like a player grenade). */
export const GRENADE_NOISE = 60;
/** Id headroom on promotion: ids the old host assigned that never reached us must not collide with ours. */
export const PROMOTE_ID_GAP = 100;
/** Phase 9: a promoted host continues the snapshot `seq` this far past the last one it saw as a replica (never collides with the old host's counter). */
export const PROMOTE_SEQ_GAP = 1000;
/* ── appended: Phase 12 (배리어 충돌 · 총알 추적, 2026-09-08) ── */
/** Seconds a bumped enemy prefers the shield carrier as its target (`pickTarget`). */
export const BARRIER_RETARGET_S = 6;
/** Minimum gap between two `implant:barrierBumped` for the same enemy (≤ 2 Hz). */
export const BARRIER_BUMP_INTERVAL = 0.5;
/** Per-enemy throttle on the perception test a shot report runs (an SMG reports 10+ shots a second). */
export const SHOT_CHECK_INTERVAL = 0.2;
/** A `shotq` claiming a longer range than this is dropped. */
export const MAX_SHOT_RANGE = 400;
/** Height of the 배리어 panel centre used for the `ee barrierHit` / `implant:barrierBumped` contact point. */
export const SHIELD_CONTACT_Y = 1.0;

export const _v = new THREE.Vector3();
export const _v2 = new THREE.Vector3();
export const _hc = new THREE.Vector3();
export const _hp = new THREE.Vector3();
export const _hd = new THREE.Vector3();
export const _c = new THREE.Vector3();
export const _m = new THREE.Vector3();
export const _aim = new THREE.Vector3();
export const _dir = new THREE.Vector3();
export const _to = new THREE.Vector3();
export const _zero = new THREE.Vector3();
export const _eye = new THREE.Vector3();
export const _kb = new THREE.Vector3();
export const _so = new THREE.Vector3();
export const _sd = new THREE.Vector3();
export const _sh = new THREE.Vector3();
export const killedBuf: Enemy[] = [];

/** Finite 3-tuple guard for wire input. */
export function isVec3Tuple(v: unknown): v is Vec3Tuple {
  return Array.isArray(v) && v.length === 3 && Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
}
export const queryBuf: Enemy[] = [];

/**
 * Owns every enemy: pooling, AI ticks, hit detection, spawning (ambient + extraction waves + rogue guards), gore FX,
 * artillery shells and lootable corpses. Publishes itself as `ctx.enemies` (EnemyManagerRef).
 *
 * Multiplayer (host-authoritative): on the authority (single-player or lobby host) the AI hunts every player via
 * `TargetList` (and, Phase 4, enemies of the other faction through `Enemy.asTarget`), and when a session is running it
 * broadcasts `EnemySnapshot`s (10 Hz) + `EnemyEvent`s and serves client `hit` / `explode` / `intq` requests. On a
 * joined client (`!ctx.isAuthority`) the same pools render replicas driven by `net/Replica.ts`; `Enemy.takeDamage`
 * becomes an optimistic FX + `HitRequest`. Authority is read at `world:ready` / `game:newMission` (`refreshMode`) and
 * changes **live** through `setAuthority` (Phase 7: `net:hostChanged` mid-mission promotes replicas into simulated
 * enemies or demotes the simulation into replicas) — nothing else caches it.
 */
