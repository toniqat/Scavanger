import * as THREE from 'three';
import {
  CORPSE_FALL_MAX_SPEED, CORPSE_LIFETIME, DEATH_FALL_TIME, ENEMY_DEATH_DIRS, Random, ROGUE_GRENADE_COOLDOWN, ROGUE_MAG_ROUNDS, recordRideLocal,
  type DeployableRef, type EnemyDeathDir, type EnemyFaction, type EnemyRef, type EnemyType, type GameContext, type Obstacle,
  type EnemyGrenadeKind, type EnemySpawnSite, type EnemySquadRole,
} from '@/shared';
import { ENEMY_STATS, HUMANOID_RAIDER, HUNTER_LEAP, ROGUE_AI, baseTypeOf, isRogueType, type BugType, type EnemyStats } from './EnemyTypes';
import { createBugRig, createBugAnim, disposeBugRig, animateBug, type BugRig, type BugAnim } from './models/BugModel';
import { animateRogue, createRogueRig, disposeRogueRig, type RogueRig, type RogueType } from './models/RogueModel';
import { animateNamedRig, namedBodyNearest } from './models/named';
/* appended (2026-09-13): the dig-in spawn · the sandworm */
import { BURROW_SINK_EXTRA_M, GRAVITY } from '@/shared';
/* appended (2026-09-13): rover aggro */
import { ROVER_AGGRO_GROUP_RADIUS, ROVER_AGGRO_S, ROVER_DAMAGE_SOURCE } from '@/shared';
/* 2026-09-14 (NPC quest kill objectives): which gun class the local last hit came from (`shared/damageSource`) */
import { localGunHitClass, type WeaponClass } from '@/shared';
import { isWormType } from './EnemyTypes';
import { animateWorm, createWormRig, disposeWormRig, type WormRig } from './models/WormModel';
/* appended (2026-09-18): the bug egg — its own rig (`models/EggModel`) */
import { animateEgg, createEggRig, disposeEggRig, type EggRig } from './models/EggModel';
import { isEggType } from './EnemyTypes';
import { nearestOnStandingCapsule } from './RayTests';
import type { SpatialGrid } from './SpatialGrid';
import { CombatTarget, type TargetId, type TargetList } from './Targets';
import type { ReplicaBuffer } from './net/Replica';

/**
 * Over the last few seconds of a corpse's lifetime the body sinks into the ground (`anim.fade`). It is the value that
 * used to be buried inside `animate`, and since 2026-09-16 every body carries it as `corpseFadeS` — a corpse opened and
 * emptied switches to `CORPSE_EMPTY_SINK_S` (`parts/CorpseEmpty`).
 */
const CORPSE_FADE_S = 3;

export type EnemyState = 'idle' | 'wander' | 'alert' | 'chase' | 'attack' | 'stagger' | 'dead' | 'flee';
export type HitPart = 'head' | 'body' | 'rear' | 'front';
/** Bug rig (six legs) or humanoid rogue rig — both expose `params.head` / `params.strideLength` / `root` / `baseScale`. */
export type EnemyRig = BugRig | RogueRig
  /* appended (2026-09-13): the sandworm (`models/WormModel`) */
  | WormRig
  /* appended (2026-09-18): the bug egg (`models/EggModel`) */
  | EggRig;

/**
 * 2026-09-11 (named rogues): the optional argument to `EnemyHost.fireGun`. **Left out, it is not one hair different
 * from the old rogue shot.** Used by Roden (one round · long range · aimed at the head · its own FX) and the Heavy (a
 * minigun — it does not send an `ee shoot` per round).
 */
export interface RogueShotOpts {
  /** Absolute damage (given, this value replaces `ROGUE_DAMAGE × damageMul`). */
  damage?: number;
  /** Hitscan range (m, `ROGUE_AI.range` by default). */
  range?: number;
  /** The aim point (the target's chest by default). Target-velocity lead is added to this point just the same. */
  aimAt?: THREE.Vector3;
  /** false = no local tracer · gunshot (`shotFx`) — the caller draws its own FX. */
  fx?: boolean;
  /** false = no `enemy:shot` bus event. */
  event?: boolean;
  /** false = no `ee shoot` is sent (the Heavy uses `ee spray` and Roden `ee snipe` instead). */
  wire?: boolean;
  /** Given, the real muzzle · impact point are written into it (for the caller's own FX · the wire). */
  out?: { from: THREE.Vector3; to: THREE.Vector3 };
}

/** Services the entity/AI needs from the owning system (avoids a circular import on EnemySystem). */
export interface EnemyHost {
  readonly ctx: GameContext;
  readonly grid: SpatialGrid<Enemy>;
  /** Every player the bugs can hunt this frame (local + remote). */
  readonly targets: TargetList;
  /** Every active enemy (alive, staggered, corpses) — faction warfare / charge paths scan it. */
  readonly active: readonly Enemy[];
  /** true on a joined multiplayer client: enemies are replicas driven by host snapshots, damage is a request. */
  readonly replica: boolean;
  /** Wake every unaware bug within radius (propagation). */
  alertNear(position: THREE.Vector3, radius: number, source: Enemy | null): void;
  fireAcid(from: THREE.Vector3, shooter: Enemy, target: CombatTarget): void;
  /** Deal melee/leap/charge damage to `target` (default `e.target`): local → ctx.player, remote → dmg message, enemy → takeDamage('ai'). */
  hitTarget(e: Enemy, damage: number, shake?: number, target?: CombatTarget | null): void;
  onEnemyDamaged(e: Enemy, amount: number, part: HitPart, hitPoint: THREE.Vector3 | undefined, hitDir: THREE.Vector3 | undefined): void;
  onEnemyKilled(e: Enemy, countKill: boolean): void;
  /** Replica only: forward a local hit to the host (`HitRequest`) and play the optimistic gore/audio. */
  requestHit(e: Enemy, amount: number, part: HitPart, hitPoint: THREE.Vector3 | undefined, hitDir: THREE.Vector3 | undefined): void;
  playAudio(id: string, position: THREE.Vector3, volume?: number, pitch?: number): void;
  /* ── Phase 4 ── */
  /** Best hostile for `e`: nearest alive player, or an enemy of the other faction (see EnemySystem.pickTarget). */
  pickTarget(e: Enemy): CombatTarget | null;
  /** Rogue hitscan shot at `target` (host resolves occlusion / capsule hits / damage, FX, audio, `enemy:shot`, `ee shoot`). */
  fireGun(e: Enemy, target: CombatTarget, aimError: number, damageMul: number, opts?: RogueShotOpts): boolean;
  /**
   * Artillery: lob a shell at the target's predicted position (`enemy:shellFired`, `ee shell`).
   * 2026-09-10: returns false when nothing was fired — the pool is full, or the **low** arc
   * (`SHELL_ARC_GRAVITY`) is blocked by a hill / tree / structure so the round would burst on the gunner's own
   * position. The AI answers a refusal by relocating (`ai/GimmickAI.chaseArtillery`).
   */
  fireShell(e: Enemy, target: CombatTarget): boolean;
  /** Behemoth charge contact with a player: damage + sideways knockback (local) / `dmg` (remote). */
  chargeHit(e: Enemy, target: CombatTarget, damage: number, knockDir: THREE.Vector3): void;
  /** Behemoth charge started (event + wire). */
  onChargeStarted(e: Enemy, target: THREE.Vector3): void;
  /* ── appended: tactical kit ── */
  /** Strongest lure covering `pos` (own distraction list ∪ `ctx.gadgets.findDistraction`). Writes it into `out`. */
  lureFor(pos: THREE.Vector3, out: THREE.Vector3): number;
  /** Spit at an explicit world point (smoke return fire, deployables) instead of at a player. */
  fireAcidAt(from: THREE.Vector3, aimFeet: THREE.Vector3, shooter: Enemy): void;
  /** Small ember puff for a burning bug (pooled, no lights). */
  emberBurst(position: THREE.Vector3, count: number): void;
  /* ── appended: Phase 7 (rogue AI v2) ── */
  /**
   * Rogue grenade toss at `target` (feet): ballistic `RogueGrenade`, `ee grenade`; the host resolves the blast.
   * Returns false when nothing was thrown (launch path blocked by a rock in the face, pool full).
   */
  throwGrenade(e: Enemy, target: THREE.Vector3): boolean;
  /* ── appended: Phase 12 (barrier bumps, 2026-09-08) ── */
  /**
   * After a grounded enemy integrated its movement: push it out of any raised barrier (`ImplantsRef.resolveBarrierCollision`)
   * and, on contact, retarget it onto the carrier + throttled `implant:barrierBumped`.
   */
  resolveBarrier(e: Enemy): void;
  /* ── appended: 2026-09-13 (the dig-in spawn · the sandworm) ── */
  /** A body the sandworm spat out has landed (`ai/Burrow`) — dust puff + thud on this client. */
  burrowLanded?(e: Enemy): void;
  /* ── appended: 2026-09-17 (the artillery escort · summon) ── */
  /** Stands one bug up on the authority (the same function as `SpawnHost.spawn` — hp multiplier · `ee spawn` · the dig-in FX included). */
  spawn(type: EnemyType, position: THREE.Vector3, yaw: number, chase: boolean, relentless: boolean, emerge?: number): Enemy | null;
}

const _v = new THREE.Vector3();

export class Enemy implements EnemyRef {
  id = 0;
  type: EnemyType = 'scavenger';
  stats: EnemyStats = ENEMY_STATS.scavenger;
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  yaw = 0;
  hp = 1;
  maxHp = 1;
  state: EnemyState = 'idle';
  readonly rig: EnemyRig;
  readonly anim: BugAnim = createBugAnim();
  active = false;

  /* ── AI memory ─────────────────────────────────────────────────────────── */
  readonly spawnPos = new THREE.Vector3();
  readonly moveTarget = new THREE.Vector3();
  hasMoveTarget = false;
  readonly facePoint = new THREE.Vector3();
  hasFacePoint = false;
  aware = false;
  stateTime = 0;
  wanderTimer = 0;
  attackCd = 0;
  attackTimer = 0;
  attackHitDone = false;
  perceptionTimer = 0;
  lostTimer = 0;
  staggerTimer = 0;
  deathTimer = 0;
  fleeTimer = 0;
  readonly fleeFrom = new THREE.Vector3();
  /** hunter flank side */
  flankSign = 1;
  flankTimer = 0;
  /** hunter leap */
  airborne = false;
  leaping = false;
  vy = 0;
  leapCd = 0;
  /** 2026-09-17: damage taken over this leap (from the crouch to the landing) — at or above `HUNTER_LEAP.flipDamage` it flips. Counted on the authority only. */
  leapDamage = 0;
  /** 2026-09-17: the leap was cut short and it is dropping straight down, flipped (authority `ai/HunterFlip` · a replica reads hint 25). */
  flipFalling = false;
  /** 2026-09-17: seconds left lying flipped — while > 0 there is no movement · turning · attack (authority `ai/HunterFlip` · a replica holds the value while hint 24 lasts). */
  flipTimer = 0;
  /** charger / behemoth */
  chargePhase: 0 | 1 | 2 = 0; // 0 none, 1 windup, 2 rushing
  chargeTimer = 0;
  readonly chargeDir = new THREE.Vector3();
  chargeCd = 0;
  /** spewer */
  spitPhase = 0;
  /** cached nearby obstacles (refreshed every ~0.25 s) */
  nearObstacles: Obstacle[] = [];
  obstacleTimer = 0;
  /** What this enemy hunts: a player or (Phase 4) an enemy of the other faction. Kept while dead so "target died" logic can run. */
  target: CombatTarget | null = null;
  targetTimer = 0;
  /** distance to `target` (2D), refreshed each AI tick */
  distToTarget = Infinity;
  /** last known LOS result (to `target`) */
  hasLOS = false;
  /* ── appended: riding a vehicle (2026-09-11, C-18 — `ai/Ride.ts`) ─────────── */
  /** The moving platform (tram floor, `Obstacle.velocity`) this body rides, or null. Live hash entry — re-read every frame. */
  carrier: Obstacle | null = null;
  /** Last frame's resting spot in carrier-local coordinates (`shared/ride.recordRideLocal`) and the world spot it was taken at. */
  readonly rideLocal = new THREE.Vector3();
  readonly rideWorld = new THREE.Vector3();
  /** Replica: 0..1 blend of the ride prediction offset (eases the lag correction in / out). */
  rideBlend = 0;
  /** Replica: the carrier last predicted on, kept while `rideBlend` eases out after leaving it. */
  lastCarrier: Obstacle | null = null;
  /** 2026-09-11 (C-63): the inertia after stepping off (m/s, world XZ) · the time left — authority only (`ai/Ride.rideRelease` · the same `RIDE_INERTIA_*` as the player). */
  readonly rideInertia = new THREE.Vector3();
  rideInertiaT = 0;
  /** A carried corpse slid off its carrier and is falling — the `corpse:<id>` interactable follows it until it lands. */
  corpseDropped = false;
  distTravelled = 0;
  stepAccum = 0;
  /** 2026-09-11 (C-23): ctx.time of this enemy's last footstep sound — the throttle is per enemy (`model.emitEnemyStep`). */
  stepAt = -Infinity;
  spawnTime = 0;
  /** true for wave bugs: never return to idle, always hunt */
  relentless = false;
  /** Who dealt the most recent damage (kill credit on the host; `'ai'` = another enemy, never credited). */
  lastDamager: TargetId = 'local';
  /** Replica: ctx.time of the last optimistic local hit (suppresses the echoed `damaged` flash). */
  lastLocalHit = -Infinity;
  /**
   * 2026-09-14: the gun class when the **last** damage this client dealt was one gun round, else null (a grenade ·
   * gadget · melee · burning). Read by `enemy:killed.weaponClass` — the host reads it at the moment of the last hit, a
   * replica off its own last request.
   */
  lastLocalWeaponClass: WeaponClass | null = null;
  /** Replica: interpolation ring buffer (created lazily by the replica manager, reused across pool cycles). */
  netBuf: ReplicaBuffer | null = null;

  /* ── Phase 4 ──────────────────────────────────────────────────────────── */
  /** This enemy as a target for the other faction (position/velocity/isDead synced by the system each frame). */
  readonly asTarget = new CombatTarget('ai');
  /** rogue: 0 none, 1 moving to cover, 2 holding in cover, 3 popped out / firing, 4 rushing */
  roguePhase: 0 | 1 | 2 | 3 | 4 = 0;
  /** rogue: guard anchor (crate) or the boss it escorts; leash radius */
  readonly guardPos = new THREE.Vector3();
  leash = ROGUE_AI.leash;
  escortOf: Enemy | null = null;
  /* ── 2026-09-14: tutorial-only enemies (`Tutorial.ts`) ──────────────── ── */
  /**
   * \> 0 replaces this one's detection radius (m) with it instead of `stats.sightRadius` — for **sight · sound · lures ·
   * spreading through the pack alike** (read by `ai/Perception.senseRadiusOf` and the radius maths in `parts/Alerts`).
   * 0 = the table as usual.
   * The one place that sets it is `Tutorial.placeTutorialEnemies`, so an enemy in the main game · training range is
   * always 0.
   */
  senseRadius = 0;
  /**
   * \> 0 makes it drop the chase and walk home once it is this far (m) from `guardPos` (the hard leash in `ai/EnemyAI`).
   * A humanoid's `leash` is the soft one — "follow a little farther while it can see you" — so in the tutorial this sits
   * on top of it.
   */
  homeLeash = 0;
  /**
   * 2026-09-15 — an enemy that **dropped its aggro** because the tutorial moved past its stretch
   * (`Tutorial.onTutorialCheckpoint` · `onTutorialFell`). While true, `Tutorial.tutorialHold` walks it home every frame
   * and it never fights again. An enemy in the main game · training range is always false.
   */
  tutorialReleased = false;
  readonly coverPos = new THREE.Vector3();
  hasCover = false;
  coverTimer = 0;
  burstLeft = 0;
  burstTimer = 0;
  /** seconds standing still while firing → aim error settles */
  standTime = 0;
  rushTimer = 0;
  hitCrouchTimer = 0;
  noLosTimer = 0;
  /** rogue rifle item def id (model / corpse loot / `EnemyWire.w`) */
  weaponId = '';
  /** artillery */
  shellTimer = 0;
  dug = 0;
  /** artillery (2026-09-11 C-24): shots refused in a row because the arc was blocked — `ARTILLERY_AI.maxRefusals` → retarget + cooldown. */
  shellRefusals = 0;
  /**
   * artillery (2026-09-11 C-24): the pre-checked clear spot it walks to after a refusal. Its own field because `chase()`
   * rewrites `moveTarget` to the target every frame — the 2026-09-10 relocation wrote `moveTarget` and so actually
   * walked **at the target**, never sideways.
   */
  readonly shellSpot = new THREE.Vector3();
  /**
   * artillery (2026-09-17): the firing sequence — 0 = ordinary, 1 = legs lowered, braced flat and waiting
   * (`ARTILLERY_AI.braceTime`), 2 = locked in place after firing (`postFireLock`). Added 2026-09-18: **3 = the barrage
   * prep** (`ARTILLERY_AI.prepTime`) — it runs once, in front of the first shell, after a bug has moved in beside the
   * target. The seconds left are `shellPhaseT`. A replica gets only the pose for all three, as anim hint 25 (braced
   * flat) (`net/HostSync.animHint` — there is no new hint).
   */
  shellPhase: 0 | 1 | 2 | 3 = 0;
  shellPhaseT = 0;
  /**
   * artillery (2026-09-18, user's decision): the seconds left before it may call its own scavengers (the dig-in escort +
   * the summoned pack) again. 0 = it may call now. `ARTILLERY_AI.squadCooldown` goes in the moment that pack is **wiped
   * out** (`ai/ArtilleryPack.maybeSummon`). It replaces 2026-09-17's 「once in a lifetime」 (`summonDone`).
   */
  squadCd = 0;
  /**
   * artillery (2026-09-18): this engagement's **barrage prep** (`ARTILLERY_AI.prepTime`) is already done. It goes back
   * to false once the bug beside the target is gone, so the prep runs 「once, in front of the first shell after support
   * arrives」 (`ai/GimmickAI.chaseArtillery`).
   */
  shellPrepDone = false;
  /** artillery (2026-09-17): the seconds left until the next summon-condition check (`ARTILLERY_AI.supportCheckS`). */
  supportCheckT = 0;
  /* ── appended: 2026-09-18 (the bug nest leash · refill, user's decision) ───── ── */
  /**
   * The **nest index** this body was born at (an index into `WorldRef.getNestPositions()`), -1 = it did not come from a
   * nest. Only the nest garrison (the raid's opening placement) and a nest refill fill it in — a mid-raid patrol · wave ·
   * drop · sandworm spit is -1 and chases without limit as before. When it is filled in, `guardPos` is that nest's spot
   * and `ai/NestLeash` holds the leash. Authority-only (it is not on the wire — a host change releases the leash, the
   * same intent as `escortOf` in `ai/ArtilleryPack`).
   */
  nestOf = -1;
  /** Past the leash and **walking home** to the nest (`ai/NestLeash`'s hysteresis — so the boundary does not grab and release it). */
  nestReturning = false;
  /** toxic: 0 running, 1 swelling, 2 burst */
  toxicPhase = 0;
  swellTimer = 0;
  /** behemoth: charge sequence (victim stamp = id * 1000 + seq) and the end point 6 m past the target */
  chargeSeq = 0;
  readonly chargeEnd = new THREE.Vector3();
  hitByCharge = -1;
  /** behemoth: players already hit during the current charge */
  readonly chargeVictims: TargetId[] = [];
  /** behemoth (2026-09-11 C-47): drone ids already hit during the current charge (drone proxies all share the id 'ai') */
  readonly chargeDrones: string[] = [];
  /** seconds the corpse stays (system sets it from CORPSE_LIFETIME; sinks over the last `corpseFadeS` s — cut short when emptied) */
  corpseLife = CORPSE_LIFETIME;
  /* ── appended: tactical kit ────────────────────────────────────────────── */
  /** Lure (a lure grenade / noise) currently pulling this bug: position + 0..1 strength, refreshed on the perception tick. */
  readonly lurePos = new THREE.Vector3();
  hasLure = false;
  lureWeight = 0;
  /**
   * Last spot a shot was heard from while the shooter was hidden (smoke). Ranged bugs answer with very
   * inaccurate fire at `suspicion` scattered by `suspicionSpread` meters.
   */
  readonly suspicion = new THREE.Vector3();
  suspicionTimer = 0;
  suspicionSpread = 0;
  /** ctx.time of the last suspicion refresh (throttles the per-shot vision test). */
  suspicionAt = -Infinity;
  /** Spit at `spitPoint` instead of at a player (smoke return fire / deployable). */
  spitAtPoint = false;
  readonly spitPoint = new THREE.Vector3();
  /** Burning DoT (a fire zone / an incendiary round). */
  burnDps = 0;
  burnTimer = 0;
  burnTick = 0;
  emberTimer = 0;
  /** Phase 9: who lit the fire (`applyStatus(..., attacker)`); the burn DoT credits it over `lastDamager`. null = unknown. */
  burnAttacker: TargetId | null = null;
  /** Movement slow (0..1 multiplier, 1 = none). */
  slowFactor = 1;
  slowTimer = 0;
  /** Deployable (barricade / dome shield / turret / lure) this bug is chewing on or shooting at. */
  structTarget: DeployableRef | null = null;
  structTimer = 0;
  /** true while the current attack swing is aimed at `structTarget` instead of a player. */
  structAttack = false;
  /** true when `structTarget` is what stands between this bug and its player target. */
  structBlocking = false;
  /* ── appended: unique weapons (2026-09-06) ─────────────────────────────── */
  /**
   * 전소 (incinerated): seconds left writhing on the spot. Rides on the `stagger` state (`staggerTimer` is kept ≥ this)
   * so every AI / wire path that already stops a staggered enemy stops this one too; `isIncapacitated` reads it.
   * Authority: ticked by the AI stagger case. Replica: held from `EnemyWire.sb` (INCINERATED bit) each snapshot.
   */
  incapTimer = 0;
  /** Shocked spark visual (cyan flicker + spark particles) seconds left; the slow itself uses `slowFactor` / `slowTimer`. */
  shockTimer = 0;
  /** Spark / writhe ember FX interval accumulator. */
  sparkTimer = 0;
  /** Replica: last status bits forwarded to the host as a `HitRequest.st` and when (throttle for per-tick callers). */
  statusReqBits = 0;
  statusReqAt = -Infinity;
  /* ── appended: Phase 7 (rogue AI v2, 2026-09-06) ─────────────────────── */
  /** rogue: rounds left in the magazine (`ROGUE_MAG_ROUNDS`); 0 → reload */
  magRounds = ROGUE_MAG_ROUNDS;
  /** rogue: seconds of reload left (no shots, crouched, wire hint 12) */
  reloadTimer = 0;
  /** rogue: per-rogue grenade cooldown (s) */
  grenadeCd = 0;
  /** rogue: seconds the target has been out of LOS while hunting (grenade trigger after `ROGUE_GRENADE_HOLD_S`) */
  noLosHold = 0;
  /** rogue: grenade wind-up left (> 0 = throw pose, wire hint 13); the toss happens when it reaches 0 */
  throwTimer = 0;
  /** rogue: where the grenade goes (target feet at wind-up start) */
  readonly grenadeTarget = new THREE.Vector3();
  /**
   * rogue: the spot beside the cover obstacle with a clear standing line to the target — the rogue steps out to it to
   * fire (LOS-validated cover hides the rogue *and* the target, so popping out in place would never see anything).
   */
  readonly popPos = new THREE.Vector3();
  hasPop = false;

  /* ── appended: Phase 10 (varied deaths · the death fall in mid-air · chance looting) ── */
  /**
   * Which way this body went down. Picked in `kill()` from an **independent** seeded stream (world seed × id) so host
   * and replicas agree without a wire field; the wire (`ee kill.dd` / `ee corpse.dd`) still overrides it for authority.
   * undefined while alive.
   */
  deathDir: EnemyDeathDir | undefined = undefined;
  /** false when this corpse rolled un-searchable (`CORPSE_LOOT_CHANCE`, decided in `Corpses.rollCorpseLootable`). */
  lootable: boolean | undefined = undefined;
  /**
   * Vertical speed of a dead body still falling to the terrain (m/s, negative = down, clamped to
   * `CORPSE_FALL_MAX_SPEED`). Seeded from the live `vy` in `kill()` — a bug shot mid-leap keeps its arc.
   */
  deathVy = 0;
  /** true once the dead body sits on the terrain (`ai/EnemyAI.integrateDeathFall`). A ground kill lands immediately. */
  deathLanded = false;
  /** Authority: the `corpse:<id>` interactable is waiting for the body to land (or `CORPSE_LAND_TIMEOUT`). */
  corpsePending = false;
  /* appended (2026-09-16): removing an emptied corpse (`parts/CorpseEmpty`) */
  /** A corpse opened and emptied — the authority decided it (`ee corpseEmptied`). While `corpseReleased` is true, `corpseLife` is already cut to 「now + the delay + the sink」. */
  corpseEmptied = false;
  /**
   * appended (2026-09-16, 2nd pass): an emptied corpse's lifetime was cut — **after the last window closed**. On the
   * authority, `corpseEmptied` true on its own means somebody is still looking into it
   * (`parts/CorpseEmpty.updateEmptyCorpses`).
   */
  corpseReleased = false;
  /** How long a corpse sinks for (s, `anim.fade` 0→1). Normally the last `CORPSE_FADE_S` of its lifetime; an emptied corpse uses `CORPSE_EMPTY_SINK_S`. */
  corpseFadeS = CORPSE_FADE_S;

  /* ── appended: Phase 12 (shot tracking · barrier bumps, 2026-09-08) ────── ── */
  /**
   * Shot tracking: this (unaware) enemy is investigating a shot it could not attribute to anyone (`ai/Investigate.ts`).
   * Rides on the `alert` wire state with `aware` false; perceiving any target ends it and drops into the normal cycle.
   */
  investigating = false;
  /** Where the bullet came from (refreshed by a later shot while investigating). */
  readonly shotOrigin = new THREE.Vector3();
  /** Seconds since the investigation started (give-up at `ENEMY_SHOT_ALERT_GIVE_UP_S`). */
  shotTimer = 0;
  /** 0 watching the origin, 1 advancing toward it, 2 arrived / stopped — holding a last look before standing down. */
  shotPhase: 0 | 1 | 2 = 0;
  /** Seconds in phase 2 (or, for a rogue in phase 1, since the current cover leg started). */
  shotHold = 0;
  /** ctx.time of the last per-shot perception test (`reportShot` throttle). */
  shotCheckAt = -Infinity;
  /** Barrier bump: prefer the shield carrier as the target until this ctx.time (`pickTarget`). */
  barrierUntil = -Infinity;
  /**
   * 2026-09-13 (the rover): it hunts the vehicle until this `ctx.time` — the enemy hit by the vehicle's turret or a ram
   * (`attacker === ROVER_DAMAGE_SOURCE`) and the pack around it (`noteVehicleAggro`). While it runs,
   * `parts/Alerts.pickTarget` picks the vehicle over a player and `ai/Perception.acquireTarget` switches with no
   * hysteresis. Authority only.
   */
  vehicleAggroUntil = -Infinity;
  barrierOwner: TargetId | null = null;
  /** ctx.time of the last `implant:barrierBumped` for this enemy (≤ 2 Hz). */
  barrierBumpAt = -Infinity;

  /* ── appended: the muzzle line of fire (2026-09-10, so it does not shoot into a wall) ── */
  /** ctx.time of the last muzzle → target line test (`ai/FireLine`, throttled to `ENEMY_FIRE_LOS_S`). */
  fireLineAt = -Infinity;
  /** Cached result of that test. Defaults to true so an enemy nobody tested behaves exactly as before. */
  fireLineClear = true;
  /** Distance from the **muzzle** to whatever blocks the line (Infinity = clear; ≤ standoff = we are flush against it). */
  fireLineGap = Infinity;
  /** Seconds left of the current sideways step taken to open a blocked line (`ai/FireLine.fireLineStrafe`). */
  fireBlockTimer = 0;
  /** Which way that step goes; flipped whenever a new leg starts so a rogue works both flanks of a wall. */
  fireStrafeSign: 1 | -1 = 1;

  /* ── appended: named rogues · the scan drone (2026-09-11) ────────── ── */
  /**
   * Wire animation hint a named AI sets directly (14..20 — see `EnemyWire.a`). `net/HostSync.animHint` sends it as-is
   * when > 0; a replica writes the received `a` here too so `ai/named/*` visuals can read one field on both sides.
   */
  namedHint = 0;
  /** Per-type phase / timers for `ai/named/*` — the meaning is private to that type's file. */
  namedPhase = 0;
  namedTimer = 0;
  namedCooldown = 0;
  /** Per-type scratch object owned by that type's AI file (null after `reset`). */
  namedData: unknown = null;

  /* ── appended: the humanoid faction per planet (2026-09-13, the contract) ── */
  /** The site it was placed at (a loot input — `CorpseLootOpts.site`). null = outside a site (debug · a named · a bug). */
  site: EnemySpawnSite | null = null;
  /** The group id (-1 = none) · its role in the group. The spawn director passes them through `spawnRogue(…, opts)`. */
  squadId = -1;
  squadRole: EnemySquadRole = 'member';
  /** The grenade kind it carries · how many are left (0 = none). The humanoid AI owner rolls them at spawn and decrements on a throw — what is left goes to the corpse. */
  grenadeKind: EnemyGrenadeKind = 'frag';
  grenadeCount = 0;

  /* ── appended: the dig-in spawn · the sandworm (2026-09-13 — `ai/Burrow` · `parts/Burrow` · `sandworm/Director`) ── */
  /** Digging up out of the ground: the seconds left (0 = fully out). `animate` decrements it on the authority and a replica alike — the picture and the judgement share one clock. */
  emergeT = 0;
  /** This dig-in's total time (s). 0 = there was none, or it is over. */
  emergeDur = 0;
  /** How deep it was buried when the dig-in started (m) = the body height + `BURROW_SINK_EXTRA_M`. */
  emergeDepth = 0;
  /** In flight after the sandworm spat it: the seconds left · the total time (0 = it is not). */
  spatT = 0;
  spatDur = 0;
  readonly spatFrom = new THREE.Vector3();
  readonly spatTo = new THREE.Vector3();
  /** The velocity at the moment it was spat (solved so a `GRAVITY` parabola reaches `spatTo` in `spatDur`). */
  readonly spatVel = new THREE.Vector3();
  /** The sandworm: the `ctx.time` its bug-spitting phase ends (poison after that). A replica fills it in from `ee wormErupt` too, against a promotion. */
  wormSpitUntil = 0;
  /** The sandworm: the seconds left until the next spit · poison (authority). */
  wormTimer = 0;
  /* ── appended: humanoid faction AI (2026-09-13 — `ai/RogueAI` · `ai/SquadFlank`) ─────── ── */
  /** rogue / raider: bursts still to fire in the current pop-out (`HUMANOID_*.burstsPerPop`). */
  popBursts = 0;
  /** raider flanker: 0 = with the squad, 1 = moving on the flank arc (the push itself is `roguePhase` 4). */
  flankPhase: 0 | 1 = 0;
  /** raider flanker: seconds of engagement (chase) before the next flank may start — `flankDelay` at spawn, `flankCooldown` after one. */
  flankCd = 0;
  /** raider flanker: which side of the target the arc goes to (+1 = the target's left of its forward… see `SquadFlank`). */
  flankSide: 1 | -1 = 1;
  /** raider flanker: seconds on the current arc (`flankMaxTime` → push anyway). */
  flankClock = 0;

  constructor(type: EnemyType) {
    /* 2026-09-14 (3rd pass): a tutorial-only type has no rig of its own and uses the **base type**'s as it is
       (`baseTypeOf`) — the shared geometry caches (`assets` · `BUG_PARAMS`) are the same too, so the tutorial bakes no
       new shader and no new mesh. */
    const look = baseTypeOf(type);
    this.rig = isEggType(look) ? createEggRig(look) : isWormType(look) ? createWormRig(look) : isRogueType(look) ? createRogueRig(look as RogueType) : createBugRig(look as BugType);
    this.type = type;
    /* 2026-09-18 (bug eggs): only an egg carries **its own `EnemyStats` copy per instance**. The size varies 0.35~0.7 m
       per egg spot (`NestEggSpot.radius`) while the hit capsule · separation · blast distance all read `stats.radius` /
       `stats.height` — without a copy that becomes 「the egg you see ≠ the hitbox」 (`NestDirector.spawnEgg` puts it in
       just before the spawn). Every other type points at the table object as it always did. */
    this.stats = isEggType(type) ? { ...ENEMY_STATS[type] } : ENEMY_STATS[type];
    this.rig.root.visible = false;
    this.asTarget.enemy = this;
  }

  get radius(): number { return this.stats.radius; }
  get height(): number { return this.stats.height; }
  get isDead(): boolean { return this.state === 'dead' || !this.active; }
  get object(): THREE.Object3D { return this.rig.root; }
  get faction(): EnemyFaction { return this.stats.faction; }
  get isRogue(): boolean { return this.stats.faction === 'rogue'; }
  /**
   * 2026-09-13: a **humanoid AI** rather than a bug (rogue · raider · android · a named · the scan drone). Until
   * 2026-09-13 `isRogue` meant this — four factions split the two apart. The AI branch · the recycling exemption · the
   * human sounds all read this one.
   */
  get isHumanoid(): boolean { return this.stats.faction !== 'bug'; }
  /**
   * 2026-09-18 (bug eggs): a **fixed target** that does not fight. It never moves, turns, attacks or becomes aware, and
   * `isCombatant` below is always false for it, so it drops out of everywhere that counts 「living, fighting bodies」 —
   * the patrol · wave head cap (`Pool.aliveCount`), recycling candidates (`Pool.ensureCapacity`), the artillery's fire
   * support test (`ai/ArtilleryPack.hasBugSupport`), another faction's target pick (`asTarget.isDead`), push-back
   * (`parts/Damage.pushBack`) and noise investigation (`parts/Alerts`). Bullets and blasts still land on it
   * (`EnemySystem.raycastEx` · `parts/Damage.explode` filter on `state === 'dead'` alone).
   */
  get isEgg(): boolean { return isEggType(this.type); }
  /** Incinerated: writhing on the spot — no movement / attacks, still damageable (a kill mid-writhe works). */
  get isIncapacitated(): boolean { return this.active && this.state !== 'dead' && this.incapTimer > 0; }
  /** Alive and fighting (not dead / fleeing / inactive / incinerated). Incapacitated enemies are non-combatants: the other faction stops hunting them. */
  get isCombatant(): boolean { return this.active && this.state !== 'dead' && this.state !== 'flee' && this.incapTimer <= 0 && !this.isEgg; }

  /** (Re)initialize a pooled instance. */
  reset(id: number, position: THREE.Vector3, yaw: number, now: number): void {
    this.id = id;
    this.active = true;
    this.position.copy(position);
    this.spawnPos.copy(position);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.hp = this.maxHp = this.stats.hp;
    this.state = 'idle';
    this.hasMoveTarget = false; this.hasFacePoint = false;
    this.aware = false;
    this.stateTime = 0; this.wanderTimer = 1 + Math.random() * 2;
    this.attackCd = 0.5; this.attackTimer = 0; this.attackHitDone = false;
    this.perceptionTimer = Math.random() * 0.3;
    this.lostTimer = 0; this.staggerTimer = 0; this.deathTimer = 0; this.fleeTimer = 0;
    this.flankSign = Math.random() < 0.5 ? -1 : 1; this.flankTimer = 0;
    this.airborne = false; this.leaping = false; this.vy = 0; this.leapCd = 1;
    this.leapDamage = 0; this.flipFalling = false; this.flipTimer = 0;   // 2026-09-17: the hunter flip
    this.chargePhase = 0; this.chargeTimer = 0; this.chargeCd = 2;
    this.spitPhase = 0;
    this.nearObstacles.length = 0; this.obstacleTimer = Math.random() * 0.25;
    this.target = null; this.targetTimer = 0; this.distToTarget = Infinity; this.hasLOS = false;
    this.distTravelled = 0; this.stepAccum = 0; this.stepAt = -Infinity;
    this.carrier = null; this.lastCarrier = null; this.rideBlend = 0; this.corpseDropped = false;
    this.rideInertia.set(0, 0, 0); this.rideInertiaT = 0;
    this.spawnTime = now;
    this.relentless = false;
    this.lastDamager = 'local'; this.lastLocalHit = -Infinity; this.lastLocalWeaponClass = null;
    this.hasLure = false; this.lureWeight = 0;
    this.suspicionTimer = 0; this.suspicionSpread = 0; this.suspicionAt = -Infinity;
    this.spitAtPoint = false;
    this.burnDps = 0; this.burnTimer = 0; this.burnTick = 0; this.emberTimer = 0; this.burnAttacker = null;
    this.slowFactor = 1; this.slowTimer = 0;
    this.structTarget = null; this.structTimer = 0; this.structAttack = false; this.structBlocking = false;
    this.incapTimer = 0; this.shockTimer = 0; this.sparkTimer = 0; this.statusReqBits = 0; this.statusReqAt = -Infinity;
    this.netBuf?.clear();
    // Phase 4
    this.roguePhase = 0; this.guardPos.copy(position); this.leash = ROGUE_AI.leash; this.escortOf = null;
    // 2026-09-14: the tutorial-only values switch off every time a body is borrowed from the pool — only `Tutorial.placeTutorialEnemies` turns them back on
    this.senseRadius = 0; this.homeLeash = 0; this.tutorialReleased = false;
    this.hasCover = false; this.hasPop = false; this.coverTimer = 0; this.burstLeft = 0; this.burstTimer = 0; this.standTime = 0;
    this.rushTimer = 0; this.hitCrouchTimer = 0; this.noLosTimer = 0; this.weaponId = '';
    this.shellTimer = 3 + Math.random() * 3; this.dug = 0; this.shellRefusals = 0;
    this.shellPhase = 0; this.shellPhaseT = 0; this.supportCheckT = 0;   // 2026-09-17: the firing stance
    this.squadCd = 0; this.shellPrepDone = false;                       // 2026-09-18: the barrage prep · re-summoning the squad
    this.nestOf = -1; this.nestReturning = false;                       // 2026-09-18: the nest leash (the spawn path fills it back in)
    this.toxicPhase = 0; this.swellTimer = 0;
    this.chargeSeq = 0; this.hitByCharge = -1; this.chargeVictims.length = 0; this.chargeDrones.length = 0;
    this.corpseLife = CORPSE_LIFETIME;
    // 2026-09-13: site · squad · grenades (the spawn path fills them back in)
    this.site = null; this.squadId = -1; this.squadRole = 'member'; this.grenadeKind = 'frag'; this.grenadeCount = 0;
    // 2026-09-13: the dig-in · being spat · the sandworm (the spawn path fills them back in)
    this.emergeT = 0; this.emergeDur = 0; this.emergeDepth = 0; this.spatT = 0; this.spatDur = 0; this.wormSpitUntil = 0; this.wormTimer = 0;
    this.popBursts = 0; this.flankPhase = 0; this.flankCd = HUMANOID_RAIDER.flankDelay; this.flankSide = 1; this.flankClock = 0;
    // Phase 7: full magazine, grenade cooldown staggered so a squad never volleys at once
    this.magRounds = ROGUE_MAG_ROUNDS; this.reloadTimer = 0;
    this.grenadeCd = ROGUE_GRENADE_COOLDOWN * (0.25 + Math.random() * 0.5); this.noLosHold = 0; this.throwTimer = 0;
    // Phase 10
    this.deathDir = undefined; this.lootable = undefined;
    this.deathVy = 0; this.deathLanded = false; this.corpsePending = false;
    this.corpseEmptied = false; this.corpseReleased = false; this.corpseFadeS = CORPSE_FADE_S;   // 2026-09-16: removing an emptied corpse
    // Phase 12
    this.investigating = false; this.shotTimer = 0; this.shotPhase = 0; this.shotHold = 0; this.shotCheckAt = -Infinity;
    this.barrierUntil = -Infinity; this.barrierOwner = null; this.barrierBumpAt = -Infinity;
    this.vehicleAggroUntil = -Infinity;
    // 2026-09-10 (the muzzle line of fire)
    this.fireLineAt = -Infinity; this.fireLineClear = true; this.fireLineGap = Infinity;
    this.fireBlockTimer = 0; this.fireStrafeSign = Math.random() < 0.5 ? -1 : 1;
    // 2026-09-11 (named rogues)
    this.namedHint = 0; this.namedPhase = 0; this.namedTimer = 0; this.namedCooldown = 0; this.namedData = null;
    this.syncTarget();
    const a = this.anim;
    a.gait = Math.random() * Math.PI * 2; a.speed = 0; a.headYaw = 0; a.headPitch = 0; a.mandible = 0;
    a.flinch = 0; a.flinchX = 0; a.flinchZ = 0; a.hitFlash = 0; a.abdomen = 0; a.shake = 0; a.crouch = 0;
    a.death = -1; a.deathDir = 0; a.deathFall = 0; a.slopePitch = 0; a.slopeRoll = 0; a.time = Math.random() * 10;
    a.fade = 0; a.aim = 0; a.recoil = 0; a.writhe = 0; a.spark = 0; a.reload = 0; a.throwing = 0; a.brace = 0;
    a.flip = 0;   // 2026-09-17
    this.rig.root.visible = true;
    this.rig.root.scale.setScalar(this.rig.baseScale);
    this.rig.root.position.copy(position);
    this.rig.root.rotation.set(0, yaw, 0);
    this.animateRig();
  }

  /** Refresh the `asTarget` proxy the other faction hunts (called by the system once per frame). */
  syncTarget(): void {
    const t = this.asTarget;
    t.position.copy(this.position);
    t.velocity.copy(this.velocity);
    t.yaw = this.yaw;
    t.isDead = !this.isCombatant;
    t.downed = false;
    t.present = this.active;
  }

  deactivate(): void {
    this.active = false;
    this.state = 'dead';
    this.rig.root.visible = false;
    this.asTarget.present = false;
    this.asTarget.isDead = true;
  }

  /* ── appended: 2026-09-13 (the dig-in spawn · the sandworm) ── */
  /**
   * Digs up out of the ground over `duration` seconds — it starts at the body height + `BURROW_SINK_EXTRA_M` deep and
   * rises with an ease-out. Only **the picture** is lowered: the judgement position (`position`) stays on the ground, so
   * it can be hit throughout. Blocking attacks and movement is `ai/Burrow.updateBurrowGate`. 0 or less is ignored.
   */
  startEmerge(duration: number): void {
    if (!(duration > 0)) return;
    this.emergeDur = duration;
    this.emergeT = duration;
    this.emergeDepth = this.stats.height * this.rig.baseScale + BURROW_SINK_EXTRA_M;
    if (this.rig.kind !== 'worm') this.rig.root.position.y = this.position.y - this.emergeDepth;
  }

  /**
   * How deep it still is underground mid-dig (m). 0 with no dig-in.
   * 2026-09-14 (4th pass): it keeps shrinking after death so the body finishes rising — a corpse left buried cannot be
   * searched (the comment in `animate`).
   * Only the sandworm stops where it died.
   */
  get burrowSink(): number {
    if (!(this.emergeDur > 0)) return 0;
    const k = 1 - Math.max(0, this.emergeT) / this.emergeDur;
    const ease = 1 - (1 - k) * (1 - k) * (1 - k);
    return this.emergeDepth * (1 - ease);
  }

  /**
   * Spat from `from` (the sandworm's mouth) to `to` (the landing surface) on a `T`-second parabola. It is `airborne`
   * throughout — dying in the air hands over to the existing death fall. One step is `ai/Burrow.stepSpatFlight` (shared
   * by the authority and a replica).
   */
  startSpat(from: THREE.Vector3, to: THREE.Vector3, T: number): void {
    const t = Math.max(0.2, T);
    this.spatFrom.copy(from);
    this.spatTo.copy(to);
    this.spatVel.set((to.x - from.x) / t, (to.y - from.y) / t + 0.5 * GRAVITY * t, (to.z - from.z) / t);
    this.spatDur = t;
    this.spatT = t;
    this.position.copy(from);
    this.airborne = true;
    this.leaping = false;
    this.vy = this.spatVel.y;
    this.emergeT = 0;
    this.emergeDur = 0;
  }

  dispose(): void {
    if (this.rig.kind === 'bug') disposeBugRig(this.rig);
    else if (this.rig.kind === 'worm') disposeWormRig(this.rig);
    else if (this.rig.kind === 'egg') disposeEggRig(this.rig);   // 2026-09-18
    else disposeRogueRig(this.rig);
  }

  /** Horizontal facing direction (unit). */
  facing(out: THREE.Vector3): THREE.Vector3 {
    return out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  /** World-space head hit-sphere center. */
  headCenter(out: THREE.Vector3): THREE.Vector3 {
    const h = this.rig.params.head;
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    return out.set(this.position.x + s * h.z, this.position.y + h.y, this.position.z + c * h.z);
  }

  /**
   * `EnemyRef.nearestBodyPoint` (C-62, 2026-09-11): the point of the **body** hitbox nearest to `from` — the capsule
   * `EnemySystem.raycastEx` tests for the body: the lying capsule of a prone sniper (`models/named.namedBodyNearest`, same
   * `sniperBodyCapsule` as `namedBodyRay`), else the vertical capsule (`RayTests.nearestOnStandingCapsule`, a sphere for most
   * bugs). `from` itself when it is inside. The head sphere and the behemoth plate are **not** included: melee reach is
   * measured from the body, and the heads / plate stick out ahead (charger +0.6 m, behemoth plate +2.3 m) — adding them
   * would lengthen frontal melee on exactly the enemies whose feel must not change.
   */
  nearestBodyPoint(from: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    if (this.rig.kind === 'rogue' && namedBodyNearest(this, from, out)) return out;
    return nearestOnStandingCapsule(from, this.position, this.stats.radius, this.stats.height, out);
  }

  /** Rifle muzzle (rogues; falls back to chest height ahead of the body). */
  muzzle(out: THREE.Vector3): THREE.Vector3 {
    if (this.rig.kind === 'rogue') {
      this.rig.root.updateMatrixWorld(true);
      return this.rig.muzzle.getWorldPosition(out);
    }
    this.facing(out).multiplyScalar(this.stats.radius);
    out.add(this.position); out.y += this.stats.height * 0.75;
    return out;
  }

  /* ── behemoth front plate (armoured hitbox) ────────────────────────────── */
  get hasFrontPlate(): boolean { return this.type === 'behemoth'; }

  /** Plate capsule: axis position, radius and vertical span (feet-relative). */
  plateAxis(out: THREE.Vector3): THREE.Vector3 {
    const h = this.rig.params.head;
    const d = h.z + h.r * 0.9;
    return out.set(this.position.x + Math.sin(this.yaw) * d, this.position.y, this.position.z + Math.cos(this.yaw) * d);
  }
  get plateRadius(): number { return this.stats.radius * 0.5; }
  get plateY0(): number { return this.stats.height * 0.25; }
  get plateY1(): number { return this.stats.height * 0.88; }

  /** True when `point` lies on the behemoth's front plate (world space). */
  isFrontPlate(point: THREE.Vector3): boolean {
    if (!this.hasFrontPlate) return false;
    this.plateAxis(_v);
    const dx = point.x - _v.x, dz = point.z - _v.z;
    const r = this.plateRadius * 1.15;
    if (dx * dx + dz * dz > r * r) return false;
    const y = point.y - this.position.y;
    return y >= this.plateY0 - r && y <= this.plateY1 + r;
  }

  /**
   * Classify a hit for damage multipliers.
   *
   * 2026-09-09: the **head sphere is tested first**. The behemoth's plate capsule (`plateRadius` = radius × 0.5,
   * hanging `head.z + head.r × 0.9` ahead) swallows most of its own head sphere, so with the plate first a side or
   * overhead shot that `raycastEx` had already resolved as `'head'` was demoted to the armoured `'front'` when
   * `takeDamage` re-classified the same point — i.e. the behemoth had no headshot at all, which only became
   * visible once its `headMul` went 1 → 2. A point that is genuinely on the head is a headshot; the plate still
   * claims everything else in front, so frontal shots are armoured exactly as before.
   */
  classifyHit(hitPoint?: THREE.Vector3, hitDir?: THREE.Vector3): HitPart {
    if (hitPoint) {
      this.headCenter(_v);
      if (_v.distanceToSquared(hitPoint) <= (this.stats.headRadius * 1.15) ** 2) return 'head';
      if (this.hasFrontPlate && this.isFrontPlate(hitPoint)) return 'front';
    }
    if (hitDir) {
      const d = hitDir.x * Math.sin(this.yaw) + hitDir.z * Math.cos(this.yaw);
      if (d > 0.45) return 'rear';   // ray travels the way we face → came from behind
      if (d < -0.45) return 'front';
    }
    return 'body';
  }

  multiplierFor(part: HitPart): number {
    switch (part) {
      case 'head': return this.stats.headMul;
      case 'rear': return this.stats.rearMul;
      case 'front': return this.stats.frontMul;
      default: return 1;
    }
  }

  private host: EnemyHost | null = null;
  bindHost(host: EnemyHost): void { this.host = host; }

  /**
   * Apply damage. `attacker` is who dealt it (kill credit; host only — WeaponSystem calls with the default 'local',
   * enemy-vs-enemy damage passes 'ai'). On a replica (joined client) hp never changes here: the hit is shown
   * optimistically and forwarded to the host.
   */
  takeDamage(amount: number, hitPoint?: THREE.Vector3, hitDir?: THREE.Vector3, attacker: TargetId = 'local'): void {
    if (!this.active || this.state === 'dead' || amount <= 0) return;
    /* 2026-09-13 (the rover): the vehicle (its turret · a ram) is host authority — a replica builds no request for it.
     * It folds to `'ai'` so kill credit goes to nobody (it never reads as a PeerId), and the enemy hit plus its pack
     * hunt the vehicle. */
    const fromRover = attacker === ROVER_DAMAGE_SOURCE;
    if (fromRover) {
      if (this.host?.replica) return;
      attacker = 'ai';
    }
    const part = this.classifyHit(hitPoint, hitDir);
    const dmg = amount * this.multiplierFor(part);
    // visual feedback
    const a = this.anim;
    a.hitFlash = 1;
    a.flinch = Math.min(1, a.flinch + Math.min(1, dmg / this.maxHp * 4 + 0.25));
    if (hitDir) {
      // lean away from the shot in local space
      const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
      a.flinchX = -(hitDir.x * c - hitDir.z * s);   // roll: +X side dips when pushed toward +X
      a.flinchZ = (hitDir.x * s + hitDir.z * c);    // pitch: nose dips when pushed forward
    } else { a.flinchX = (Math.random() - 0.5) * 2; a.flinchZ = 0.3; }
    if (attacker === 'local') this.lastLocalWeaponClass = localGunHitClass();   // 2026-09-14: kills by gun class for NPC quests
    if (this.host?.replica) {
      this.host.requestHit(this, amount, part, hitPoint, hitDir);
      return;
    }
    this.hp -= dmg;
    this.lastDamager = attacker;
    /* wake up. 2026-09-18: an egg does not wake (user's decision 「알아채지 않는다」) — moving its state to `alert` would
       shake the hint and the replica's pose, and above all it would break the promise that it is a 「fixed target」. The
       gunshot itself still wakes the bugs around it through the ordinary path (`reportShot` · `onGunshot`), so shooting
       an egg is never quiet. */
    if (!this.aware && !this.isEgg) {
      this.aware = true;
      if (this.state === 'idle' || this.state === 'wander') { this.state = 'alert'; this.stateTime = 0; }
      this.host?.alertNear(this.position, 14, this);
    }
    if (fromRover) this.noteVehicleAggro();
    // duck when hit while popped out — 2026-09-13: not an android (it never takes cover; hint 6 would crouch it on replicas)
    if (this.isHumanoid && this.roguePhase === 3 && this.faction !== 'android') this.hitCrouchTimer = ROGUE_AI.hitCrouch;
    this.host?.onEnemyDamaged(this, dmg, part, hitPoint, hitDir);
    if (this.hp <= 0) {
      this.hp = 0;
      this.kill(true);
      return;
    }
    // 2026-09-17: damage accumulated mid-leap → the flip. A replica's hit request passes this same line on the host, so a squadmate's damage piles up with it.
    if (this.leaping) this.noteLeapDamage(dmg);
    // stagger on heavy hits
    const threshold = this.maxHp * this.stats.staggerFraction * (this.chargePhase === 2 ? 1.6 : 1);
    if (dmg >= threshold && this.state !== 'stagger' && !this.airborne && this.toxicPhase === 0) {
      this.enterStagger(this.type === 'charger' || this.type === 'behemoth' ? 0.9 : 0.6);
    }
  }

  /**
   * 2026-09-13 (the rover): it was hit by the vehicle — this enemy and every combatant of the same faction within
   * `ROVER_AGGRO_GROUP_RADIUS` hunt the vehicle for `ROVER_AGGRO_S` (waking the pack is the same `alertNear` as being
   * hit by a player). It re-evaluates the target at once. The scan drone · sandworm · Roden never hunt a vehicle
   * (`parts/Alerts.pickVehicleTarget`), so the mark left on them is harmless. Authority only.
   */
  noteVehicleAggro(): void {
    const host = this.host;
    if (!host || host.replica) return;
    const until = host.ctx.time + ROVER_AGGRO_S;
    host.alertNear(this.position, ROVER_AGGRO_GROUP_RADIUS, this);
    const r2 = ROVER_AGGRO_GROUP_RADIUS * ROVER_AGGRO_GROUP_RADIUS;
    const list = host.active;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (o !== this && (!o.isCombatant || o.faction !== this.faction)) continue;
      const dx = o.position.x - this.position.x, dz = o.position.z - this.position.z;
      if (o !== this && dx * dx + dz * dz > r2) continue;
      if (until > o.vehicleAggroUntil) o.vehicleAggroUntil = until;
      o.targetTimer = 0;
    }
  }

  /**
   * Damage-over-time tick (burning). Quieter than `takeDamage`: no gore burst, no `enemy:damaged` broadcast
   * and no stagger — the host's enemy snapshots carry the falling hp to the clients.
   * Authority only; `attacker` gets the kill credit.
   * 2026-09-11 (C-14): `quiet` = the environmental hazard tick — no hit flash and it does **not** wake the enemy (a storm is not an
   * attacker); the caller passes `'ai'` so a hazard kill credits nobody.
   */
  applyDot(amount: number, attacker: TargetId = 'local', quiet = false): void {
    if (!this.active || this.state === 'dead' || amount <= 0) return;
    this.hp -= amount;
    this.lastDamager = attacker;
    if (attacker === 'local') this.lastLocalWeaponClass = null;   // 2026-09-14: a last hit from a DoT has no gun class
    if (quiet) { if (this.hp <= 0) { this.hp = 0; this.kill(true); } return; }
    this.anim.hitFlash = Math.max(this.anim.hitFlash, 0.45);
    if (!this.aware && !this.isEgg) {   // 2026-09-18: an egg does not wake even while burning
      this.aware = true;
      if (this.state === 'idle' || this.state === 'wander') { this.state = 'alert'; this.stateTime = 0; }
    }
    if (this.hp <= 0) { this.hp = 0; this.kill(true); return; }
    if (this.leaping) this.noteLeapDamage(amount);   // 2026-09-17: a burn tick counts toward the damage accumulated mid-leap too (the hazard's quiet tick does not)
  }

  /**
   * 2026-09-17 (user's decision): once the damage taken within one leap reaches `HUNTER_LEAP.flipDamage` the leap is cut
   * — it throws away its horizontal speed, drops straight down where it is (`flipFalling`; the landing is
   * `ai/HunterFlip.updateHunterFlip`) and lies flipped for `flipDuration` s.
   * Still crouching (on the ground) it flips at once. The state is left at `stagger` so a flinch or another AI branch
   * cannot cut in (the stagger timer is 0 — when the flip ends the ordinary flinch-end branch returns it to chase /
   * idle). Authority only.
   */
  private noteLeapDamage(dmg: number): void {
    if (this.host?.replica || this.flipFalling || this.flipTimer > 0) return;
    this.leapDamage += dmg;
    if (this.leapDamage < HUNTER_LEAP.flipDamage) return;
    this.leaping = false;
    this.leapDamage = 0;
    this.velocity.set(0, 0, 0);
    if (this.airborne) { this.flipFalling = true; this.vy = Math.min(this.vy, 0); }
    else this.flipTimer = HUNTER_LEAP.flipDuration;
    this.state = 'stagger'; this.stateTime = 0; this.staggerTimer = 0;
    this.attackTimer = 0; this.attackHitDone = true;
    this.hasMoveTarget = false; this.hasFacePoint = false;
    this.leapCd = Math.max(this.leapCd, HUNTER_LEAP.cooldown);
    this.anim.crouch = 0;
    this.host?.playAudio('bug_screech', this.position, 0.7, 1.6);
  }

  enterStagger(duration: number): void {
    this.state = 'stagger';
    this.stateTime = 0;
    // a stagger never shortens a running incineration
    this.staggerTimer = Math.max(duration, this.incapTimer);
    this.chargePhase = 0;
    this.spitPhase = 0;
    this.roguePhase = 0;
    this.burstLeft = 0;
    this.throwTimer = 0;      // a stagger drops the wind-up (the cooldown was not spent)
    this.investigating = false;   // Phase 12: a hit ends shot tracking (the damage made us aware anyway)
    this.anim.shake = 0;
    this.anim.abdomen = 0;
    this.hasMoveTarget = false;
    this.velocity.multiplyScalar(0.2);
  }

  /**
   * Incinerated: writhe on the spot for `duration` s (authority). Rides on the stagger state — movement, attacks, charges,
   * bursts, spits and toxic swells all stop — while `incapTimer` drives the writhing pose and `isIncapacitated`.
   * Damage still applies (a kill mid-writhe works); when the timer runs out the AI stagger exit resumes chase / idle.
   */
  incinerate(duration: number): void {
    if (!this.active || this.state === 'dead' || !(duration > 0)) return;
    const extend = Math.max(this.incapTimer, duration);
    if (this.state !== 'stagger') this.enterStagger(extend);
    this.incapTimer = extend;
    this.staggerTimer = Math.max(this.staggerTimer, extend);
    this.toxicPhase = 0; this.swellTimer = 0;
    this.hitCrouchTimer = 0; this.rushTimer = 0;
    this.spitAtPoint = false; this.structAttack = false;
    this.anim.aim = 0;
    this.syncTarget();
  }

  /**
   * Which way this body falls. Phase 10: an **independent** seeded stream (world seed × id) so every client agrees —
   * the old `BugAnim.rollSign` was rolled at spawn with unseeded `Math.random()` and host / replica never matched.
   */
  private rollDeathDir(): EnemyDeathDir {
    const seed = this.host?.ctx.world?.seed ?? 0;
    const rng = new Random(((seed ^ (this.id * 0x85ebca6b)) >>> 0) || 1);
    return ENEMY_DEATH_DIRS[rng.int(0, ENEMY_DEATH_DIRS.length - 1)];
  }

  /**
   * Transition to dead (death animation, corpse stays `corpseLife` seconds, then the system despawns).
   * Phase 10: `dir` overrides the seeded fall direction (the host's `ee kill.dd` / `ee corpse.dd` wins on a replica),
   * the live `vy` is carried into `deathVy` **before** `airborne` is cleared so a mid-leap kill keeps falling, and
   * `deathLanded` is decided right here so a normal ground kill still registers its corpse in the same frame.
   */
  kill(countKill: boolean, dir?: EnemyDeathDir): void {
    if (!this.active || this.state === 'dead') return;
    this.deathVy = this.airborne ? THREE.MathUtils.clamp(this.vy, -CORPSE_FALL_MAX_SPEED, CORPSE_FALL_MAX_SPEED) : 0;
    this.state = 'dead';
    this.stateTime = 0;
    this.deathTimer = 0;
    this.airborne = false;
    this.leaping = false;
    this.flipFalling = false; this.flipTimer = 0;   // 2026-09-17: a body that died flipped keeps its `anim.flip` and comes to rest on its back
    this.spatT = 0;   // 2026-09-13: a body in mid-spit-flight is handed to the death fall from here (`deathVy` was taken above)
    this.deathDir = dir ?? this.rollDeathDir();
    this.anim.deathDir = Math.max(0, ENEMY_DEATH_DIRS.indexOf(this.deathDir));
    this.anim.deathFall = 0;
    const world = this.host?.ctx.world ?? null;
    // 2026-09-09: the **surface underfoot**, not the terrain — dying on a rock leaves the body on the rock
    const ground = world && world.ready ? world.getSurfaceY(this.position.x, this.position.z, this.position.y) : this.position.y;
    this.deathLanded = this.position.y <= ground + 0.05;
    if (this.deathLanded) { this.position.y = ground; this.deathVy = 0; }
    // 2026-09-11 (C-18): a body that dies on a moving tram keeps riding as a corpse (`ai/Ride.carryCorpse`) — re-anchor
    // the carrier-local spot here so the first carried frame does not replay a stale offset (replica prediction included)
    if (this.carrier && this.deathLanded) { recordRideLocal(this.carrier, this.position, this.rideLocal); this.rideWorld.copy(this.position); }
    else this.carrier = null;
    this.rideBlend = 0; this.lastCarrier = null;
    this.rideInertia.set(0, 0, 0); this.rideInertiaT = 0;   // C-63: a body stops sliding when it dies
    this.chargePhase = 0;
    this.spitPhase = 0;
    this.roguePhase = 0;
    this.anim.death = 0;
    this.anim.shake = 0;
    this.anim.abdomen = this.type === 'toxic' ? 0 : this.anim.abdomen;
    this.anim.crouch = 0;
    this.anim.aim = 0;
    this.anim.mandible = 0.2;
    this.throwTimer = 0; this.reloadTimer = 0;
    this.velocity.set(0, 0, 0);
    this.syncTarget();
    this.burnDps = 0; this.burnTimer = 0; this.burnAttacker = null;
    this.slowFactor = 1; this.slowTimer = 0;
    this.incapTimer = 0; this.shockTimer = 0;
    this.structTarget = null; this.structAttack = false; this.structBlocking = false;
    this.hasLure = false; this.spitAtPoint = false;
    this.host?.onEnemyKilled(this, countKill);
  }

  /**
   * Update purely visual state (called every frame, also while gameplay is frozen).
   *
   * @param poseSkip 2026-09-20 animation LOD (`EnemySystem.poseSkip`, `data/constants.csv` `ENEMY_ANIM_LOD_*`):
   *   leave the **joints** where they are this frame. Everything else still runs — the timers, the root position and
   *   facing, the death · flee · dig-in bookkeeping — so a far body still walks and turns, its legs just do not
   *   re-solve. The caller never passes true for a body that is dead, flashing, burning, shocked or flipped.
   */
  animate(dt: number, poseSkip = false): void {
    const a = this.anim;
    a.time += dt;
    a.hitFlash = Math.max(0, a.hitFlash - dt * 6);
    a.flinch = Math.max(0, a.flinch - dt * 4.5);
    a.recoil = Math.max(0, a.recoil - dt * 6);
    // Phase 7 rogue poses: reload (rifle down, hands at the magazine) / throw (grenade arm raised) blend in from the timers
    if (this.isHumanoid) {
      const alive = this.state !== 'dead';
      const reloadT = alive && this.reloadTimer > 0 ? 1 : 0;
      const throwT = alive && this.throwTimer > 0 ? 1 : 0;
      a.reload += (reloadT - a.reload) * Math.min(1, dt * (reloadT > 0 ? 10 : 6));
      a.throwing += (throwT - a.throwing) * Math.min(1, dt * (throwT > 0 ? 12 : 8));
      if (a.reload < 0.001 && reloadT === 0) a.reload = 0;
      if (a.throwing < 0.001 && throwT === 0) a.throwing = 0;
    }
    // The incinerated writhe blends in fast and settles out; the spark flicker is a short cyan strobe while `shockTimer` runs
    const writheT = this.state !== 'dead' && this.incapTimer > 0 ? 1 : 0;
    a.writhe += (writheT - a.writhe) * Math.min(1, dt * (writheT > 0 ? 9 : 4));
    if (a.writhe < 0.001 && writheT === 0) a.writhe = 0;
    // 2026-09-17: the hunter flip — it turns over fast while falling and comes back a little more slowly as it gets up. A dead body is left in that pose.
    if (this.state !== 'dead') {
      const flipT = this.flipFalling || this.flipTimer > 0 ? 1 : 0;
      a.flip += (flipT - a.flip) * Math.min(1, dt * (flipT > 0 ? 7 : 4));
      if (a.flip < 0.001 && flipT === 0) a.flip = 0;
    }
    if (this.state !== 'dead' && this.shockTimer > 0) {
      const t = a.time;
      a.spark = 0.55 + 0.45 * Math.abs(Math.sin(t * 41) * Math.cos(t * 17 + 1.3));
    } else if (a.spark > 0) a.spark = Math.max(0, a.spark - dt * 8);
    if (this.state === 'dead') {
      a.death = Math.min(1, this.deathTimer / 4);
      // Phase 10: the fall pose (left / right / back) blends in over DEATH_FALL_TIME; `death` still gates the eye fade
      a.deathFall = THREE.MathUtils.clamp(this.deathTimer / DEATH_FALL_TIME, 0, 1);
      a.fade = THREE.MathUtils.clamp((this.deathTimer - (this.corpseLife - this.corpseFadeS)) / this.corpseFadeS, 0, 1);
      a.speed = Math.max(0, a.speed - dt * 6);
    }
    if (this.state === 'flee') {
      const s = Math.max(0.01, 1 - this.fleeTimer / 2);
      this.rig.root.scale.setScalar(s * this.rig.baseScale);
    }
    this.rig.root.position.copy(this.position);
    this.rig.root.rotation.y = this.yaw;
    /* 2026-09-13 (the dig-in): a body rising out of the ground — only the picture is lowered (for the sandworm the rig
       lowers the torso alone).
       2026-09-14 (4th pass): **a body that died mid-dig finishes rising too.** The judgement position (`position`) is at
       the surface throughout the dig, so the corpse search spot (`corpse:<id>`) stands on the ground — but the picture
       used to freeze at that depth the moment it died, buried by the body height + `BURROW_SINK_EXTRA_M`, and a bug that
       had only just begun to rise was entirely underground. To the player that read as 「no corpse = no drop」 (the
       tutorial's first bug is exactly that spot). It now finishes rising over the remaining dig time, so the death FX
       overlaps and it climbs out of the hole as it falls. The sandworm dies rooted by design and still stops. */
    if (this.emergeDur > 0) {
      const rising = this.state !== 'dead' || this.rig.kind !== 'worm';
      if (this.emergeT > 0 && rising) this.emergeT = Math.max(0, this.emergeT - dt);
      if (this.rig.kind !== 'worm') this.rig.root.position.y -= this.burrowSink;
      if (this.emergeT <= 0 && rising) this.emergeDur = 0;
    }
    if (!poseSkip) this.animateRig(dt);
  }

  private animateRig(dt = 0): void {
    if (this.rig.kind === 'worm') { animateWorm(this.rig, this.anim, this.burrowSink); return; }   // 2026-09-13
    /* 2026-09-18 (bug eggs): the damage level = 1 − hp / maxHp. The host and a replica both carry `hp` (the snapshot brings it), so the picture matches with no wire field. */
    if (this.rig.kind === 'egg') { animateEgg(this.rig, this.anim, 1 - Math.max(0, Math.min(1, this.hp / Math.max(1, this.maxHp)))); return; }
    if (this.rig.kind === 'bug') animateBug(this.rig, this.anim);
    else {
      animateRogue(this.rig, this.anim);
      // 2026-09-11: named rogues · the scan drone — the per-type parts and pose go on top of the base humanoid pose (models/named/*)
      if (this.rig.named !== undefined) animateNamedRig(this.rig, this.anim, this, dt);
    }
  }
}
