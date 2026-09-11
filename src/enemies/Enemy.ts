import * as THREE from 'three';
import {
  CORPSE_FALL_MAX_SPEED, CORPSE_LIFETIME, DEATH_FALL_TIME, ENEMY_DEATH_DIRS, Random, ROGUE_GRENADE_COOLDOWN, ROGUE_MAG_ROUNDS,
  type DeployableRef, type EnemyDeathDir, type EnemyFaction, type EnemyRef, type EnemyType, type GameContext, type Obstacle,
} from '@/shared';
import { ENEMY_STATS, ROGUE_AI, isRogueType, type BugType, type EnemyStats } from './EnemyTypes';
import { createBugRig, createBugAnim, disposeBugRig, animateBug, type BugRig, type BugAnim } from './models/BugModel';
import { animateRogue, createRogueRig, disposeRogueRig, type RogueRig, type RogueType } from './models/RogueModel';
import { animateNamedRig } from './models/named';
import type { SpatialGrid } from './SpatialGrid';
import { CombatTarget, type TargetId, type TargetList } from './Targets';
import type { ReplicaBuffer } from './net/Replica';

export type EnemyState = 'idle' | 'wander' | 'alert' | 'chase' | 'attack' | 'stagger' | 'dead' | 'flee';
export type HitPart = 'head' | 'body' | 'rear' | 'front';
/** Bug rig (six legs) or humanoid rogue rig — both expose `params.head` / `params.strideLength` / `root` / `baseScale`. */
export type EnemyRig = BugRig | RogueRig;

/**
 * 2026-09-11 (네임드 로그): `EnemyHost.fireGun` 의 선택 인자. **생략하면 예전 로그 사격과 한 치도 다르지 않다.**
 * 로든(한 발 · 먼 사거리 · 머리 조준 · 자기 연출)과 헤비(미니건 — 발마다 `ee shoot` 을 보내지 않는다)가 쓴다.
 */
export interface RogueShotOpts {
  /** 절대 피해 (주면 `ROGUE_DAMAGE × damageMul` 대신 이 값). */
  damage?: number;
  /** 히트스캔 사거리 (m, 기본 `ROGUE_AI.range`). */
  range?: number;
  /** 조준점 (기본 = 표적 가슴). 표적 속도 보정은 이 점에도 똑같이 더해진다. */
  aimAt?: THREE.Vector3;
  /** false = 로컬 트레이서 · 총성(`shotFx`)을 내지 않는다 — 호출자가 자기 연출을 그린다. */
  fx?: boolean;
  /** false = `enemy:shot` 버스 이벤트를 내지 않는다. */
  event?: boolean;
  /** false = `ee shoot` 을 보내지 않는다 (헤비는 `ee spray`, 로든은 `ee snipe` 로 대신한다). */
  wire?: boolean;
  /** 주면 실제 총구 · 탄착점을 여기 써 준다 (자기 연출 · 와이어용). */
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
  /* ── appended: Phase 12 (배리어 충돌, 2026-09-08) ── */
  /**
   * After a grounded enemy integrated its movement: push it out of any raised 배리어 (`ImplantsRef.resolveBarrierCollision`)
   * and, on contact, retarget it onto the carrier + throttled `implant:barrierBumped`.
   */
  resolveBarrier(e: Enemy): void;
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
  distTravelled = 0;
  stepAccum = 0;
  spawnTime = 0;
  /** true for wave bugs: never return to idle, always hunt */
  relentless = false;
  /** Who dealt the most recent damage (kill credit on the host; `'ai'` = another enemy, never credited). */
  lastDamager: TargetId = 'local';
  /** Replica: ctx.time of the last optimistic local hit (suppresses the echoed `damaged` flash). */
  lastLocalHit = -Infinity;
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
  /** toxic: 0 running, 1 swelling, 2 burst */
  toxicPhase = 0;
  swellTimer = 0;
  /** behemoth: charge sequence (victim stamp = id * 1000 + seq) and the end point 6 m past the target */
  chargeSeq = 0;
  readonly chargeEnd = new THREE.Vector3();
  hitByCharge = -1;
  /** behemoth: players already hit during the current charge */
  readonly chargeVictims: TargetId[] = [];
  /** seconds the corpse stays (system sets it from CORPSE_LIFETIME; fades over the last 3 s) */
  corpseLife = CORPSE_LIFETIME;
  /* ── appended: tactical kit ────────────────────────────────────────────── */
  /** Lure (유인 수류탄 / 소음) currently pulling this bug: position + 0..1 strength, refreshed on the perception tick. */
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
  /** Burning DoT (화염지대 / 소이탄). */
  burnDps = 0;
  burnTimer = 0;
  burnTick = 0;
  emberTimer = 0;
  /** Phase 9: who lit the fire (`applyStatus(..., attacker)`); the burn DoT credits it over `lastDamager`. null = unknown. */
  burnAttacker: TargetId | null = null;
  /** Movement slow (0..1 multiplier, 1 = none). */
  slowFactor = 1;
  slowTimer = 0;
  /** Deployable (바리케이드 / 돔 실드 / 포탑 / 유인) this bug is chewing on or shooting at. */
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

  /* ── appended: Phase 10 (사망 다각화 · 공중 사망 낙하 · 확률 루팅) ────────── */
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

  /* ── appended: Phase 12 (총알 추적 · 배리어 충돌, 2026-09-08) ─────────────── */
  /**
   * 총알 추적: this (unaware) enemy is investigating a shot it could not attribute to anyone (`ai/Investigate.ts`).
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
  /** 배리어 충돌: prefer the shield carrier as the target until this ctx.time (`pickTarget`). */
  barrierUntil = -Infinity;
  barrierOwner: TargetId | null = null;
  /** ctx.time of the last `implant:barrierBumped` for this enemy (≤ 2 Hz). */
  barrierBumpAt = -Infinity;

  /* ── appended: 총구 사선 (2026-09-10, 벽에 대고 쏘지 않게) ─────────────────── */
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

  /* ── appended: 네임드 로그 · 스캔 드론 (2026-09-11) ─────────────────── */
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

  constructor(type: EnemyType) {
    this.rig = isRogueType(type) ? createRogueRig(type as RogueType) : createBugRig(type as BugType);
    this.type = type;
    this.stats = ENEMY_STATS[type];
    this.rig.root.visible = false;
    this.asTarget.enemy = this;
  }

  get radius(): number { return this.stats.radius; }
  get height(): number { return this.stats.height; }
  get isDead(): boolean { return this.state === 'dead' || !this.active; }
  get object(): THREE.Object3D { return this.rig.root; }
  get faction(): EnemyFaction { return this.stats.faction; }
  get isRogue(): boolean { return this.stats.faction === 'rogue'; }
  /** 전소 (incinerated): writhing on the spot — no movement / attacks, still damageable (a kill mid-writhe works). */
  get isIncapacitated(): boolean { return this.active && this.state !== 'dead' && this.incapTimer > 0; }
  /** Alive and fighting (not dead / fleeing / inactive / 전소). Incapacitated enemies are non-combatants: the other faction stops hunting them. */
  get isCombatant(): boolean { return this.active && this.state !== 'dead' && this.state !== 'flee' && this.incapTimer <= 0; }

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
    this.chargePhase = 0; this.chargeTimer = 0; this.chargeCd = 2;
    this.spitPhase = 0;
    this.nearObstacles.length = 0; this.obstacleTimer = Math.random() * 0.25;
    this.target = null; this.targetTimer = 0; this.distToTarget = Infinity; this.hasLOS = false;
    this.distTravelled = 0; this.stepAccum = 0;
    this.spawnTime = now;
    this.relentless = false;
    this.lastDamager = 'local'; this.lastLocalHit = -Infinity;
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
    this.hasCover = false; this.hasPop = false; this.coverTimer = 0; this.burstLeft = 0; this.burstTimer = 0; this.standTime = 0;
    this.rushTimer = 0; this.hitCrouchTimer = 0; this.noLosTimer = 0; this.weaponId = '';
    this.shellTimer = 3 + Math.random() * 3; this.dug = 0;
    this.toxicPhase = 0; this.swellTimer = 0;
    this.chargeSeq = 0; this.hitByCharge = -1; this.chargeVictims.length = 0;
    this.corpseLife = CORPSE_LIFETIME;
    // Phase 7: full magazine, grenade cooldown staggered so a squad never volleys at once
    this.magRounds = ROGUE_MAG_ROUNDS; this.reloadTimer = 0;
    this.grenadeCd = ROGUE_GRENADE_COOLDOWN * (0.25 + Math.random() * 0.5); this.noLosHold = 0; this.throwTimer = 0;
    // Phase 10
    this.deathDir = undefined; this.lootable = undefined;
    this.deathVy = 0; this.deathLanded = false; this.corpsePending = false;
    // Phase 12
    this.investigating = false; this.shotTimer = 0; this.shotPhase = 0; this.shotHold = 0; this.shotCheckAt = -Infinity;
    this.barrierUntil = -Infinity; this.barrierOwner = null; this.barrierBumpAt = -Infinity;
    // 2026-09-10 (총구 사선)
    this.fireLineAt = -Infinity; this.fireLineClear = true; this.fireLineGap = Infinity;
    this.fireBlockTimer = 0; this.fireStrafeSign = Math.random() < 0.5 ? -1 : 1;
    // 2026-09-11 (네임드 로그)
    this.namedHint = 0; this.namedPhase = 0; this.namedTimer = 0; this.namedCooldown = 0; this.namedData = null;
    this.syncTarget();
    const a = this.anim;
    a.gait = Math.random() * Math.PI * 2; a.speed = 0; a.headYaw = 0; a.headPitch = 0; a.mandible = 0;
    a.flinch = 0; a.flinchX = 0; a.flinchZ = 0; a.hitFlash = 0; a.abdomen = 0; a.shake = 0; a.crouch = 0;
    a.death = -1; a.deathDir = 0; a.deathFall = 0; a.slopePitch = 0; a.slopeRoll = 0; a.time = Math.random() * 10;
    a.fade = 0; a.aim = 0; a.recoil = 0; a.writhe = 0; a.spark = 0; a.reload = 0; a.throwing = 0;
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

  dispose(): void {
    if (this.rig.kind === 'bug') disposeBugRig(this.rig); else disposeRogueRig(this.rig);
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
    if (this.host?.replica) {
      this.host.requestHit(this, amount, part, hitPoint, hitDir);
      return;
    }
    this.hp -= dmg;
    this.lastDamager = attacker;
    // wake up
    if (!this.aware) {
      this.aware = true;
      if (this.state === 'idle' || this.state === 'wander') { this.state = 'alert'; this.stateTime = 0; }
      this.host?.alertNear(this.position, 14, this);
    }
    if (this.isRogue && this.roguePhase === 3) this.hitCrouchTimer = ROGUE_AI.hitCrouch;   // duck when hit while popped out
    this.host?.onEnemyDamaged(this, dmg, part, hitPoint, hitDir);
    if (this.hp <= 0) {
      this.hp = 0;
      this.kill(true);
      return;
    }
    // stagger on heavy hits
    const threshold = this.maxHp * this.stats.staggerFraction * (this.chargePhase === 2 ? 1.6 : 1);
    if (dmg >= threshold && this.state !== 'stagger' && !this.airborne && this.toxicPhase === 0) {
      this.enterStagger(this.type === 'charger' || this.type === 'behemoth' ? 0.9 : 0.6);
    }
  }

  /**
   * Damage-over-time tick (burning). Quieter than `takeDamage`: no gore burst, no `enemy:damaged` broadcast
   * and no stagger — the host's enemy snapshots carry the falling hp to the clients.
   * Authority only; `attacker` gets the kill credit.
   */
  applyDot(amount: number, attacker: TargetId = 'local'): void {
    if (!this.active || this.state === 'dead' || amount <= 0) return;
    this.hp -= amount;
    this.lastDamager = attacker;
    this.anim.hitFlash = Math.max(this.anim.hitFlash, 0.45);
    if (!this.aware) {
      this.aware = true;
      if (this.state === 'idle' || this.state === 'wander') { this.state = 'alert'; this.stateTime = 0; }
    }
    if (this.hp <= 0) { this.hp = 0; this.kill(true); }
  }

  enterStagger(duration: number): void {
    this.state = 'stagger';
    this.stateTime = 0;
    // a stagger never shortens a running 전소
    this.staggerTimer = Math.max(duration, this.incapTimer);
    this.chargePhase = 0;
    this.spitPhase = 0;
    this.roguePhase = 0;
    this.burstLeft = 0;
    this.throwTimer = 0;      // a stagger drops the wind-up (the cooldown was not spent)
    this.investigating = false;   // Phase 12: a hit ends a 총알 추적 (the damage made us aware anyway)
    this.anim.shake = 0;
    this.anim.abdomen = 0;
    this.hasMoveTarget = false;
    this.velocity.multiplyScalar(0.2);
  }

  /**
   * 전소: writhe on the spot for `duration` s (authority). Rides on the stagger state — movement, attacks, charges,
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
    this.deathDir = dir ?? this.rollDeathDir();
    this.anim.deathDir = Math.max(0, ENEMY_DEATH_DIRS.indexOf(this.deathDir));
    this.anim.deathFall = 0;
    const world = this.host?.ctx.world ?? null;
    // 2026-09-09: 지형이 아니라 **밟고 있는 표면** — 바위 위에서 죽으면 바위 위에 눕는다
    const ground = world && world.ready ? world.getSurfaceY(this.position.x, this.position.z, this.position.y) : this.position.y;
    this.deathLanded = this.position.y <= ground + 0.05;
    if (this.deathLanded) { this.position.y = ground; this.deathVy = 0; }
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

  /** Update purely visual state (called every frame, also while gameplay is frozen). */
  animate(dt: number): void {
    const a = this.anim;
    a.time += dt;
    a.hitFlash = Math.max(0, a.hitFlash - dt * 6);
    a.flinch = Math.max(0, a.flinch - dt * 4.5);
    a.recoil = Math.max(0, a.recoil - dt * 6);
    // Phase 7 rogue poses: reload (rifle down, hands at the magazine) / throw (grenade arm raised) blend in from the timers
    if (this.isRogue) {
      const alive = this.state !== 'dead';
      const reloadT = alive && this.reloadTimer > 0 ? 1 : 0;
      const throwT = alive && this.throwTimer > 0 ? 1 : 0;
      a.reload += (reloadT - a.reload) * Math.min(1, dt * (reloadT > 0 ? 10 : 6));
      a.throwing += (throwT - a.throwing) * Math.min(1, dt * (throwT > 0 ? 12 : 8));
      if (a.reload < 0.001 && reloadT === 0) a.reload = 0;
      if (a.throwing < 0.001 && throwT === 0) a.throwing = 0;
    }
    // 전소 writhe blends in fast and settles out; the spark flicker is a short cyan strobe while `shockTimer` runs
    const writheT = this.state !== 'dead' && this.incapTimer > 0 ? 1 : 0;
    a.writhe += (writheT - a.writhe) * Math.min(1, dt * (writheT > 0 ? 9 : 4));
    if (a.writhe < 0.001 && writheT === 0) a.writhe = 0;
    if (this.state !== 'dead' && this.shockTimer > 0) {
      const t = a.time;
      a.spark = 0.55 + 0.45 * Math.abs(Math.sin(t * 41) * Math.cos(t * 17 + 1.3));
    } else if (a.spark > 0) a.spark = Math.max(0, a.spark - dt * 8);
    if (this.state === 'dead') {
      a.death = Math.min(1, this.deathTimer / 4);
      // Phase 10: the fall pose (left / right / back) blends in over DEATH_FALL_TIME; `death` still gates the eye fade
      a.deathFall = THREE.MathUtils.clamp(this.deathTimer / DEATH_FALL_TIME, 0, 1);
      a.fade = THREE.MathUtils.clamp((this.deathTimer - (this.corpseLife - 3)) / 3, 0, 1);
      a.speed = Math.max(0, a.speed - dt * 6);
    }
    if (this.state === 'flee') {
      const s = Math.max(0.01, 1 - this.fleeTimer / 2);
      this.rig.root.scale.setScalar(s * this.rig.baseScale);
    }
    this.rig.root.position.copy(this.position);
    this.rig.root.rotation.y = this.yaw;
    this.animateRig(dt);
  }

  private animateRig(dt = 0): void {
    if (this.rig.kind === 'bug') animateBug(this.rig, this.anim);
    else {
      animateRogue(this.rig, this.anim);
      // 2026-09-11: 네임드 로그 · 스캔 드론 — 기본 휴머노이드 자세 위에 종류별 부품 · 자세를 더한다 (models/named/*)
      if (this.rig.named !== undefined) animateNamedRig(this.rig, this.anim, this, dt);
    }
  }
}
