/**
 * src/enemies/model.ts — the enemy folder's shared vocabulary.
 *
 * Only the constants · types · scratch vectors taken out of EnemySystem. It references no class, so the `parts/*`
 * modules can use it without importing the class back (no circular import).
 * EnemySystem.ts re-exports all of it, so every existing import path still works.
 */
import * as THREE from 'three';
import {
  BEHEMOTH_KNOCKBACK, BURNOUT_DURATION, CORPSE_LAND_TIMEOUT, CORPSE_LIFETIME, ENEMY_DEATH_DIRS, ENEMY_SHOT_ALERT_DIST, ENEMY_SHOT_IMPACT_DIST, ENEMY_STATUS_BITS, FLAME_AFTERBURN_DPS, FLAME_AFTERBURN_DURATION, GADGET_LURE_RADIUS, MAP_SIZE,
  NET_ENEMY_SNAPSHOT_HZ, PLAYER_HEIGHT, PLAYER_RADIUS, ROGUE_DAMAGE, ROGUE_GRENADE_DAMAGE, ROGUE_GRENADE_FUSE, ROGUE_GRENADE_RADIUS, ROGUE_MAG_ROUNDS, ROGUE_RANGE,
  SHELL_BLAST_RADIUS, SHELL_DAMAGE, SHELL_FLIGHT_TIME, SHOCK_SLOW_DURATION, SHOCK_SLOW_FACTOR, TOXIC_DAMAGE, TOXIC_RADIUS, getPlanet,
  FLAME_RANGE, SHOCK_RANGE, STRAT_MAX_CALL_RANGE, EXPLODE_REQUEST_RANGE_SLACK, STATUS_REQUEST_RANGE_SLACK,
  type DamageMessage, type EnemyDeathDir, type EnemyEvent, type EnemyFaction, type EnemyHit, type EnemyManagerRef, type EnemyRef, type EnemySnapshot, type EnemyStatusKind, type EnemyType, type GameContext, type GameSystem,
  type HitRequest, type InterceptableRef, type PeerId, type PlanetEcosystem, type ShotReport, type Vec3Tuple, type WorldRef,
  type SurfaceMaterial,
  BUG_STEP_CROWD_WINDOW_S, BUG_STEP_GIANT_RANGE_M, BUG_STEP_RANGE_M,
} from '@/shared';
import { FxManager, ParticleBurst } from '@/core/fx';
import { Enemy, type EnemyHost, type HitPart } from './Enemy';
import { ENEMY_STATS, ROGUE_AI, SPEWER_SPIT, baseTypeOf } from './EnemyTypes';
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
 * 2026-09-11 (C-1 · X-6): a replica's `HitRequest.kb` (the shield bash knockback) is clamped to this many m/s on the host — a
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
/** Incinerated: ember puffs come ~3× as fast as plain burning (same pooled particles, no lights). */
export const INCAP_EMBER_INTERVAL = 0.12;
/** Shocked: cyan spark puffs while `shockTimer` runs. */
export const SPARK_INTERVAL = 0.09;
/** Seconds the spark visual lasts per `applyStatus('shocked')` (the slow itself uses the caller's duration). */
export const SHOCK_SPARK_TIME = 0.6;
/** Replica → host status forwarding is throttled per enemy for the continuous callers (flame / arc every tick). */
export const STATUS_REQUEST_INTERVAL = 0.25;
/** Host clamps a client's requested status duration. */
export const MAX_STATUS_DURATION = 10;
/* ── appended 2026-09-11 (E-8 — docs/DECISIONS.md 「2026-09-11 — 신뢰 경로의 남은 틈」): the caps before a host trusts a request ──
 * The four csv numbers are named in `shared/constants.ts` like every other guard constant (right under
 * `HIT_KNOCKBACK_RANGE_SLACK` · `CRATE_OPEN_RANGE_SLACK`). All that happens here is folding them into the two reaches
 * the comparisons actually use — `parts/Damage.ts` is every consumer.
 */
export { STATUS_REQUEST_BURST_S, STATUS_REQUEST_RATE_MAX } from '@/shared';

/**
 * 2026-09-11 (E-8): every **known** bit of `ENEMY_STATUS_BITS` OR-ed together. The host masks `HitRequest.st` with it
 * before doing anything else, so a bit nobody defined can never reach `applyStatusBits` (harmless today, but the mask
 * is what keeps it harmless when the contract grows a fifth bit). Derived from the contract — no literal here.
 */
export const ENEMY_STATUS_BITS_ALL = Object.values(ENEMY_STATUS_BITS).reduce((a, b) => a | b, 0);
/**
 * 2026-09-11 (E-8): how far a client's status request may legitimately reach, **derived from data** the way
 * `shared/buffRules.limits()` is — the only two things that put a status on an enemy are the flamethrower
 * (`FLAME_RANGE`) and the shock gun (`SHOCK_RANGE`); an incendiary zone (`gadgets`) runs on the authority only and
 * never rides the wire (measured in `parts/Damage.statusInReach`'s comment). `STATUS_REQUEST_RANGE_SLACK` is the
 * snapshot lag on both sides.
 */
export const STATUS_SOURCE_REACH = Math.max(FLAME_RANGE, SHOCK_RANGE) + STATUS_REQUEST_RANGE_SLACK;
/** The cap on an `explode` request's distance — the farthest blast source is a ship call's drop, so its range plus slack. */
export const EXPLODE_SOURCE_REACH = STRAT_MAX_CALL_RANGE + EXPLODE_REQUEST_RANGE_SLACK;
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
/* ── appended: Phase 12 (barrier bumps · shot tracking, 2026-09-08) ── */
/** Seconds a bumped enemy prefers the shield carrier as its target (`pickTarget`). */
export const BARRIER_RETARGET_S = 6;
/** Minimum gap between two `implant:barrierBumped` for the same enemy (≤ 2 Hz). */
export const BARRIER_BUMP_INTERVAL = 0.5;
/** Per-enemy throttle on the perception test a shot report runs (an SMG reports 10+ shots a second). */
export const SHOT_CHECK_INTERVAL = 0.2;
/** A `shotq` claiming a longer range than this is dropped. */
export const MAX_SHOT_RANGE = 400;
/** Height of the barrier panel centre used for the `ee barrierHit` / `implant:barrierBumped` contact point. */
export const SHIELD_CONTACT_Y = 1.0;
/* ── appended: a low shell arc · not firing into a wall (2026-09-10) ── */
/**
 * How many chords the pre-fire arc check (`parts/Attacks.shellArcBlocked`) walks the arc in.
 * A parabola is convex upward, so a chord always passes **below** the real arc = the check is conservative (it may
 * call a clear arc blocked, never a blocked one clear). With 4, the largest gap between chord and arc is
 * `0.5·g·(T/8)²` ≈ 0.6 m, which is close enough.
 * A visual / algorithmic constant, so not a csv one (the same kind as `TRAIL_SAMPLES`).
 */
export const SHELL_ARC_SAMPLES = 4;
/**
 * Only this much of the front of the arc is checked. The final descent drives into the aim point (= the ground), so it
 * always meets terrain and would read "blocked" every time — and a wall right in front of the target is not worth
 * catching anyway (bursting there is fine).
 * At 0.75·T the shell is still 7.4 m above the firing point, so flat ground never gives a false positive.
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

/* ── appended (2026-09-11, C-51 · C-23 · C-22): the per-type enemy sound tables ──────────────────────────── ──
 * `bug_attack` · `bug_step` · `bug_hit` were scattered per type and leaked as far as the rogues (Tagilla above all);
 * every path that did so (melee hits · a replica's `ee attack` · a barrier absorbing · a blocked charge · walking · a
 * replica's `ee damaged`) now reads these three functions. The pitch and base gain are "the sound itself", so they live
 * in code (the footstep-pitch convention). Per-material volume and the distance curves belong to audio/.
 */

/**
 * One footstep's voice — the material underfoot decides the id (`footstep_<SurfaceMaterial>`), and only the pitch
 * (weight) and base gain are here.
 * `layer` (2026-09-13) = a sound id laid over the material footstep at the same volume (the android's servo
 * `android_step`).
 */
export interface EnemyStepVoice {
  readonly pitch: number; readonly gain: number; readonly layer?: string;
  /**
   * 2026-09-16 (bug footsteps): when set, **this id** plays instead of the material footstep — the bug-only
   * `bug_step_skitter` / `_heavy` / `_giant`. Sharing no id with a person's footstep lets audio/ cap bug footsteps as
   * one group. `range` = the emit gate (m, the same csv value as audio/'s curve).
   */
  readonly id?: string; readonly range?: number;
}
/* 2026-09-16: a bug's footstep is its own, by size — a small bug = a chitin tap, a big one = a thud, the behemoth = a
 * ground rumble (carrying a little farther). A tutorial bug goes to the scavenger through `baseTypeOf`.
 * 2026-09-18 (user's decision 「뒤에 있을 때 소리로 알아차리게」): base gains raised — small bugs ×1.7 · big bugs ×1.4 ·
 * the behemoth 1.1 → 1.5. The range (`BUG_STEP_RANGE_M` 22 → 32) and the distance curve
 * (`AudioSystem.RANGED_SOUNDS` exponent 1.4 → 1.0) went up with them. `audio:play` caps volume at 2. */
const STEP_VOICES: Readonly<Partial<Record<EnemyType, EnemyStepVoice>>> = {
  scavenger: { id: 'bug_step_skitter', pitch: 1.15, gain: 0.77, range: BUG_STEP_RANGE_M },
  hunter: { id: 'bug_step_skitter', pitch: 1.0, gain: 0.94, range: BUG_STEP_RANGE_M },
  toxic: { id: 'bug_step_skitter', pitch: 1.08, gain: 0.85, range: BUG_STEP_RANGE_M },
  spewer: { id: 'bug_step_skitter', pitch: 0.82, gain: 1.02, range: BUG_STEP_RANGE_M },
  warrior: { id: 'bug_step_heavy', pitch: 1.05, gain: 0.98, range: BUG_STEP_RANGE_M },
  artillery: { id: 'bug_step_heavy', pitch: 0.92, gain: 0.98, range: BUG_STEP_RANGE_M },
  charger: { id: 'bug_step_heavy', pitch: 0.75, gain: 1.26, range: BUG_STEP_RANGE_M },
  behemoth: { id: 'bug_step_giant', pitch: 1.0, gain: 1.5, range: BUG_STEP_GIANT_RANGE_M },
  // The rogue family: a person's footstep at a lower pitch (heavy, and carrying gear)
  // 2026-09-15 (B-16, the user's 「로그 · 레이더 모두 켬다」): a plain rogue = a lighter step than a raider
  rogue: { pitch: 0.86, gain: 0.6 },
  rogue_boss: { pitch: 0.86, gain: 0.7 },
  rogue_hammer: { pitch: 0.74, gain: 0.85 },
  rogue_heavy: { pitch: 0.8, gain: 0.8 },
  // 2026-09-13: an android = a light, hard step + one servo; a raider = heavier boots than a rogue
  android: { pitch: 1.18, gain: 0.42, layer: 'android_step' },
  raider: { pitch: 0.8, gain: 0.68 },
};
const STEP_VOICE_DEFAULT: EnemyStepVoice = { pitch: 0.9, gain: 0.5 };

/** `type`'s footstep voice, or null (`stepSound` false in `data/enemies.csv` = it walks silently). */
export function stepSound(type: EnemyType): EnemyStepVoice | null {
  // 2026-09-14 (3rd pass): whether it steps at all is its **own csv row** (stepSound); which sound is the base type (the tutorial-only types).
  if (!ENEMY_STATS[type]?.stepSound) return null;
  return STEP_VOICES[baseTypeOf(type)] ?? STEP_VOICE_DEFAULT;
}

/** The melee hit sound — a bug plays `bug_attack` at its type's pitch; a type that plays its own (Tagilla = `hammer_impact`) is null. */
export interface EnemySoundVoice { readonly id: string; readonly pitch: number }
const BITE_DEFAULT: EnemySoundVoice = { id: 'bug_attack', pitch: 1.05 };
const MELEE_VOICES: Readonly<Partial<Record<EnemyType, EnemySoundVoice | null>>> = {
  behemoth: { id: 'bug_attack', pitch: 0.4 },
  charger: { id: 'bug_attack', pitch: 0.6 },
  warrior: { id: 'bug_attack', pitch: 0.8 },
  rogue_hammer: null,                               // `ai/named/Hammer` plays `hammer_impact` (so there is no double hit sound)
  rogue: { id: 'melee_hit', pitch: 0.95 },
  rogue_boss: { id: 'melee_hit', pitch: 0.85 },
  rogue_sniper: { id: 'melee_hit', pitch: 0.95 },
  rogue_heavy: { id: 'melee_hit', pitch: 0.85 },
  rogue_scan_drone: null,
  android: { id: 'melee_hit', pitch: 1.15 },        // 2026-09-13: a light metal fist
  raider: { id: 'melee_hit', pitch: 0.88 },
};
export function meleeHitSound(type: EnemyType): EnemySoundVoice | null {
  const v = MELEE_VOICES[baseTypeOf(type)];
  return v === undefined ? BITE_DEFAULT : v;
}

/**
 * The hurt sound — a bug `bug_hit`, a person (rogue · raider) `hit_flesh`, a machine (the scan drone) `drone_hit`, an
 * android `android_hit` (a metal shell). The host and a replica give the same answer.
 */
/** 2026-09-13: hit · death debris — an android is a machine, so sparks instead of blood. The host (`parts/Damage`) and a replica (`ee damaged`) give the same answer. */
export function goreKindOf(type: EnemyType): 'blood' | 'spark' {
  return baseTypeOf(type) === 'android' ? 'spark' : 'blood';
}

export function hurtSound(type: EnemyType): string {
  if (type === 'rogue_scan_drone') return 'drone_hit';   // everything else splits by faction, and a tutorial type's own faction is the right one
  const f = ENEMY_STATS[type]?.faction;
  if (f === 'android') return 'android_hit';
  return f && f !== 'bug' ? 'hit_flesh' : 'bug_hit';
}

/* ── appended (2026-09-13): humanoid death · incineration screams — read by `parts/Damage.onEnemyKilled` · `parts/Status.incinerate` ── */
const HUMANOID_DEATH_DEFAULT: EnemySoundVoice = { id: 'player_death', pitch: 1 };
const HUMANOID_DEATH: Readonly<Partial<Record<EnemyType, EnemySoundVoice>>> = {
  rogue_boss: { id: 'player_death', pitch: 0.7 },
  raider: { id: 'player_death', pitch: 0.9 },
  android: { id: 'android_death', pitch: 1 },       // the sound of power cutting out (not a scream)
};
/** The sound a humanoid enemy (not a bug, not the scan drone) makes as it goes down. */
export function humanoidDeathSound(type: EnemyType): EnemySoundVoice {
  return HUMANOID_DEATH[baseTypeOf(type)] ?? HUMANOID_DEATH_DEFAULT;
}
const HUMANOID_PAIN_DEFAULT: EnemySoundVoice = { id: 'player_hurt', pitch: 0.9 };
const HUMANOID_PAIN: Readonly<Partial<Record<EnemyType, EnemySoundVoice>>> = {
  android: { id: 'android_glitch', pitch: 1 },       // a burning android gives a malfunction alarm, not a scream
};
/** The sound a humanoid enemy makes entering the incinerated state (burning and writhing). */
export function humanoidPainSound(type: EnemyType): EnemySoundVoice {
  return HUMANOID_PAIN[baseTypeOf(type)] ?? HUMANOID_PAIN_DEFAULT;
}

/**
 * The **camera** distance (m) within which an enemy footstep may play. A looser gate than audio/'s enemy footstep
 * curve (`ENEMY_STEP_RANGE` 45 m) — while controlling a drone the ear (the camera) is 70–90 m from the body, so
 * filtering by the local PC's body (`distToLocal`) would be wrong.
 * A sound-presentation gate, so not a csv one.
 */
export const ENEMY_STEP_EMIT_RANGE = 60;
/** The least gap (s) between one enemy's footsteps — the throttle is **per enemy id** (the old global one let only one of a pack be heard). */
export const ENEMY_STEP_MIN_GAP = 0.12;
const _stepCam = new THREE.Vector3();
const STEP_ID: Readonly<Record<SurfaceMaterial, string>> = {
  dirt: 'footstep_dirt', sand: 'footstep_sand', snow: 'footstep_snow', mud: 'footstep_mud', moss: 'footstep_moss',
  ash: 'footstep_ash', rock: 'footstep_rock', crystal: 'footstep_crystal', organic: 'footstep_organic',
  metal: 'footstep_metal', concrete: 'footstep_concrete',
};

/**
 * One enemy footstep (C-23 · C-22). The authority's `ai/EnemyAI.integrate` and a replica's `net/Replica.drive` call it
 * **the same way**. Volume falloff is applied once, by audio/'s distance curve (no linear falloff at the emitter — the
 * X-3 double falloff). `gainMul` / `pitchMul` are for variants such as the thud of a charge stopped by a wall. true
 * when a sound played.
 */
export function emitEnemyStep(e: Enemy, ctx: GameContext, gainMul = 1, pitchMul = 1): boolean {
  const v = stepSound(e.type);
  if (!v) return false;
  const now = ctx.time;
  if (now - e.stepAt < ENEMY_STEP_MIN_GAP) return false;
  const p = e.position;
  ctx.camera.getWorldPosition(_stepCam);
  // 2026-09-16: a bug is gated by its own footstep range — `stepAt` has to mean 「took a step within earshot」 for the crowd count to hold.
  const gate = v.id ? (v.range ?? BUG_STEP_RANGE_M) : ENEMY_STEP_EMIT_RANGE;
  if (_stepCam.distanceToSquared(p) > gate * gate) return false;
  e.stepAt = now;
  if (v.id) {
    ctx.bus.emit('audio:play', { id: v.id, position: p, volume: (v.gain * gainMul) / Math.sqrt(bugStepCrowd(ctx, now)), pitch: v.pitch * pitchMul * (0.94 + Math.random() * 0.12) });
    return true;
  }
  const w = ctx.world;
  const m = w && w.ready ? w.getSurfaceMaterial?.(p.x, p.z, p.y) : undefined;
  const id = (m && STEP_ID[m]) || STEP_ID.dirt;
  ctx.bus.emit('audio:play', { id, position: p, volume: v.gain * gainMul, pitch: v.pitch * pitchMul * (0.95 + Math.random() * 0.1) });
  if (v.layer) ctx.bus.emit('audio:play', { id: v.layer, position: p, volume: v.gain * gainMul, pitch: pitchMul * (0.92 + Math.random() * 0.16) });
  return true;
}

/**
 * 2026-09-16: n, the number of 「bugs walking within earshot」 right now (≥ 1, the one that just stepped included) —
 * bug footstep volume × 1/√n.
 * `stepAt` is stamped only after passing the bug footstep range gate, so a `stepAt` inside `BUG_STEP_CROWD_WINDOW_S`
 * is an audible step.
 * Every step walks the active list once (no allocation; steps per frame × enemies ≈ a few hundred comparisons).
 * Humanoids drop out by `faction`.
 */
function bugStepCrowd(ctx: GameContext, now: number): number {
  const list = ctx.enemies?.getEnemies();
  if (!list) return 1;
  let n = 0;
  for (let i = 0; i < list.length; i++) {
    const x = list[i] as Enemy;
    if (x.stepAt <= now && now - x.stepAt < BUG_STEP_CROWD_WINDOW_S && x.faction === 'bug') n++;
  }
  return Math.max(1, n);
}

/* appended (2026-09-10): the empty list `getEnemyGrenades()` returns while no enemy has a grenade in the air.
 * Building `[]` each time would be garbage, because the HUD calls it every frame. */
export const EMPTY_GRENADES: readonly import('@/shared').GrenadeView[] = [];
/* appended (2026-09-15, B-16): the empty list `getFireZones()` returns with no pool (after a dispose) — shared for the same reason. */
export const EMPTY_FIRE_ZONES: readonly import('@/shared').FireZoneInfo[] = [];
