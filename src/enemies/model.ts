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
  type SurfaceMaterial,
} from '@/shared';
import { FxManager, ParticleBurst } from '@/core/fx';
import { Enemy, type EnemyHost, type HitPart } from './Enemy';
import { ENEMY_STATS, ROGUE_AI, SPEWER_SPIT } from './EnemyTypes';
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
/**
 * 2026-09-11 (C-1 · X-6): a replica's `HitRequest.kb` (실드 배쉬 넉백) is clamped to this many m/s on the host — a
 * wire-validation cap like `MAX_REQUEST_DAMAGE`, not a balance number (the bash itself is `IMPLANT_SHIELD_BASH_KNOCKBACK`).
 */
export const MAX_REQUEST_KNOCKBACK = 20;
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
/* ── appended: 낮은 곡사 궤적 · 벽에 대고 쏘지 않기 (2026-09-10) ── */
/**
 * 발사 전 궤적 검사(`parts/Attacks.shellArcBlocked`)가 궤적을 몇 개의 현(chord)으로 나누어 훑는가.
 * 포물선은 위로 볼록하므로 현은 언제나 실제 궤적 **아래**를 지난다 = 검사는 보수적이다(막혔다고 잘못 보긴 해도
 * 뚫렸다고 잘못 보지 않는다). 4개면 현과 궤적의 최대 차이가 `0.5·g·(T/8)²` ≈ 0.6 m 라 충분히 촘촘하다.
 * 시각/알고리즘 상수라 csv 대상이 아니다 (`TRAIL_SAMPLES` 와 같은 부류).
 */
export const SHELL_ARC_SAMPLES = 4;
/**
 * 궤적의 앞쪽 이만큼만 검사한다. 마지막 하강 구간은 조준점(= 땅) 으로 내려꽂히므로 무조건 지형에 걸려
 * 전부 "막힘" 이 된다 — 표적 바로 앞의 벽에 맞는 것은 잡을 필요도 없다(그 자리에서 터지면 그만이다).
 * 0.75·T 시점의 포탄은 발사점보다 아직 7.4 m 위라 평지에서 오검출이 나지 않는다.
 */
export const SHELL_ARC_CHECK_FRAC = 0.75;
export const _arcV = new THREE.Vector3();
export const _arcP = new THREE.Vector3();
export const _arcA = new THREE.Vector3();
export const _arcD = new THREE.Vector3();

export const _v = new THREE.Vector3();
export const _v2 = new THREE.Vector3();
export const _hc = new THREE.Vector3();
export const _hp = new THREE.Vector3();
export const _hd = new THREE.Vector3();
export const _c = new THREE.Vector3();
export const _m = new THREE.Vector3();
export const _aim = new THREE.Vector3();
/** fireShell: the clamped lead vector (2026-09-09). */
export const _lead = new THREE.Vector3();
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

/* ── appended (2026-09-11, C-51 · C-23 · C-22): 적 타입별 소리 표 ─────────────────────────────────────────────
 * 타입마다 흩어져 있던 `bug_attack` · `bug_step` · `bug_hit` 이 로그(특히 타길라)에게까지 새던 경로들(근접 타격 ·
 * 리플리카 `ee attack` · 배리어 흡수 · 돌진 막힘 · 걷기 · 리플리카 `ee damaged`)이 전부 이 세 함수를 본다. 피치 ·
 * 밑값은 "소리 그 자체" 라 코드에 둔다 (발소리 피치와 같은 규약). 재질별 크기 · 거리 곡선은 audio/ 가 갖는다.
 */

/** 한 걸음의 목소리 — id 는 밟은 재질이 정한다(`footstep_<SurfaceMaterial>`), 여기는 피치(무게)와 밑값만. */
export interface EnemyStepVoice { readonly pitch: number; readonly gain: number }
const STEP_VOICES: Readonly<Partial<Record<EnemyType, EnemyStepVoice>>> = {
  warrior: { pitch: 0.82, gain: 0.55 },
  artillery: { pitch: 0.78, gain: 0.55 },
  charger: { pitch: 0.58, gain: 0.95 },
  behemoth: { pitch: 0.4, gain: 1.7 },
  // 로그 계열: 사람 발소리를 낮은 피치로 (무겁고 장비를 멨다)
  rogue_boss: { pitch: 0.86, gain: 0.7 },
  rogue_hammer: { pitch: 0.74, gain: 0.85 },
  rogue_heavy: { pitch: 0.8, gain: 0.8 },
};
const STEP_VOICE_DEFAULT: EnemyStepVoice = { pitch: 0.9, gain: 0.5 };

/** `type` 의 걸음 소리, 또는 null (`data/enemies.csv` 의 `stepSound` 가 false = 조용히 걷는다). */
export function stepSound(type: EnemyType): EnemyStepVoice | null {
  if (!ENEMY_STATS[type]?.stepSound) return null;
  return STEP_VOICES[type] ?? STEP_VOICE_DEFAULT;
}

/** 근접 타격음 — 벌레는 `bug_attack` 을 타입별 피치로, 자기 타격음을 따로 내는 타입(타길라 = `hammer_impact`)은 null. */
export interface EnemySoundVoice { readonly id: string; readonly pitch: number }
const BITE_DEFAULT: EnemySoundVoice = { id: 'bug_attack', pitch: 1.05 };
const MELEE_VOICES: Readonly<Partial<Record<EnemyType, EnemySoundVoice | null>>> = {
  behemoth: { id: 'bug_attack', pitch: 0.4 },
  charger: { id: 'bug_attack', pitch: 0.6 },
  warrior: { id: 'bug_attack', pitch: 0.8 },
  rogue_hammer: null,                               // `ai/named/Hammer` 가 `hammer_impact` 를 낸다 (이중 타격음 방지)
  rogue: { id: 'melee_hit', pitch: 0.95 },
  rogue_boss: { id: 'melee_hit', pitch: 0.85 },
  rogue_sniper: { id: 'melee_hit', pitch: 0.95 },
  rogue_heavy: { id: 'melee_hit', pitch: 0.85 },
  rogue_scan_drone: null,
};
export function meleeHitSound(type: EnemyType): EnemySoundVoice | null {
  const v = MELEE_VOICES[type];
  return v === undefined ? BITE_DEFAULT : v;
}

/** 피격음 — 벌레 `bug_hit`, 사람(로그) `hit_flesh`, 기계(스캔 드론) `drone_hit`. 호스트 · 리플리카가 같은 답을 낸다. */
export function hurtSound(type: EnemyType): string {
  if (type === 'rogue_scan_drone') return 'drone_hit';
  return ENEMY_STATS[type]?.faction === 'rogue' ? 'hit_flesh' : 'bug_hit';
}

/**
 * 적 발소리를 내도 되는 **카메라** 거리(m). audio/ 의 적 발소리 곡선(`ENEMY_STEP_RANGE` 45 m)보다 넉넉한 게이트 —
 * 드론 조종 중에는 귀(카메라)가 몸에서 70–90 m 떨어지므로 로컬 PC 몸 기준(`distToLocal`)으로 거르면 안 된다.
 * 소리 연출 게이트라 csv 대상이 아니다.
 */
export const ENEMY_STEP_EMIT_RANGE = 60;
/** 같은 적의 발소리 사이 최소 간격(s) — 스로틀은 **적 id 별**이다 (예전 전역 id 스로틀은 무리 중 한 마리만 들리게 했다). */
export const ENEMY_STEP_MIN_GAP = 0.12;
const _stepCam = new THREE.Vector3();
const STEP_ID: Readonly<Record<SurfaceMaterial, string>> = {
  dirt: 'footstep_dirt', sand: 'footstep_sand', snow: 'footstep_snow', mud: 'footstep_mud', moss: 'footstep_moss',
  ash: 'footstep_ash', rock: 'footstep_rock', crystal: 'footstep_crystal', organic: 'footstep_organic',
  metal: 'footstep_metal', concrete: 'footstep_concrete',
};

/**
 * 적 한 걸음 (C-23 · C-22). 권위의 `ai/EnemyAI.integrate` 와 리플리카의 `net/Replica.drive` 가 **같은 식**으로 부른다.
 * 크기 감쇠는 audio/ 의 거리 곡선이 한 번만 건다(방출부 선형 감쇠 없음 — X-3 이중 감쇠). `gainMul` / `pitchMul` 은
 * 돌진이 벽에 막힌 쿵 같은 변형용. 소리를 냈으면 true.
 */
export function emitEnemyStep(e: Enemy, ctx: GameContext, gainMul = 1, pitchMul = 1): boolean {
  const v = stepSound(e.type);
  if (!v) return false;
  const now = ctx.time;
  if (now - e.stepAt < ENEMY_STEP_MIN_GAP) return false;
  const p = e.position;
  ctx.camera.getWorldPosition(_stepCam);
  if (_stepCam.distanceToSquared(p) > ENEMY_STEP_EMIT_RANGE * ENEMY_STEP_EMIT_RANGE) return false;
  e.stepAt = now;
  const w = ctx.world;
  const m = w && w.ready ? w.getSurfaceMaterial?.(p.x, p.z, p.y) : undefined;
  const id = (m && STEP_ID[m]) || STEP_ID.dirt;
  ctx.bus.emit('audio:play', { id, position: p, volume: v.gain * gainMul, pitch: v.pitch * pitchMul * (0.95 + Math.random() * 0.1) });
  return true;
}

/* appended (2026-09-10): 적이 수류탄을 하나도 안 던지고 있을 때 `getEnemyGrenades()` 가 돌려주는 빈 목록.
 * 매번 `[]` 를 만들면 HUD 가 프레임마다 부르므로 쓰레기가 된다. */
export const EMPTY_GRENADES: readonly import('@/shared').GrenadeView[] = [];
