import * as THREE from 'three';
import { CORPSE_LIFETIME, type DeployableRef, type EnemyFaction, type EnemyRef, type EnemyType, type GameContext, type Obstacle } from '@/shared';
import { ENEMY_STATS, ROGUE_AI, isRogueType, type BugType, type EnemyStats } from './EnemyTypes';
import { createBugRig, createBugAnim, disposeBugRig, animateBug, type BugRig, type BugAnim } from './models/BugModel';
import { animateRogue, createRogueRig, disposeRogueRig, type RogueRig, type RogueType } from './models/RogueModel';
import type { SpatialGrid } from './SpatialGrid';
import { CombatTarget, type TargetId, type TargetList } from './Targets';
import type { ReplicaBuffer } from './net/Replica';

export type EnemyState = 'idle' | 'wander' | 'alert' | 'chase' | 'attack' | 'stagger' | 'dead' | 'flee';
export type HitPart = 'head' | 'body' | 'rear' | 'front';
/** Bug rig (six legs) or humanoid rogue rig — both expose `params.head` / `params.strideLength` / `root` / `baseScale`. */
export type EnemyRig = BugRig | RogueRig;

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
  fireGun(e: Enemy, target: CombatTarget, aimError: number, damageMul: number): void;
  /** Artillery: lob a shell at the target's predicted position (`enemy:shellFired`, `ee shell`). */
  fireShell(e: Enemy, target: CombatTarget): void;
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
    this.burnDps = 0; this.burnTimer = 0; this.burnTick = 0; this.emberTimer = 0;
    this.slowFactor = 1; this.slowTimer = 0;
    this.structTarget = null; this.structTimer = 0; this.structAttack = false; this.structBlocking = false;
    this.incapTimer = 0; this.shockTimer = 0; this.sparkTimer = 0; this.statusReqBits = 0; this.statusReqAt = -Infinity;
    this.netBuf?.clear();
    // Phase 4
    this.roguePhase = 0; this.guardPos.copy(position); this.leash = ROGUE_AI.leash; this.escortOf = null;
    this.hasCover = false; this.coverTimer = 0; this.burstLeft = 0; this.burstTimer = 0; this.standTime = 0;
    this.rushTimer = 0; this.hitCrouchTimer = 0; this.noLosTimer = 0; this.weaponId = '';
    this.shellTimer = 3 + Math.random() * 3; this.dug = 0;
    this.toxicPhase = 0; this.swellTimer = 0;
    this.chargeSeq = 0; this.hitByCharge = -1; this.chargeVictims.length = 0;
    this.corpseLife = CORPSE_LIFETIME;
    this.syncTarget();
    const a = this.anim;
    a.gait = Math.random() * Math.PI * 2; a.speed = 0; a.headYaw = 0; a.headPitch = 0; a.mandible = 0;
    a.flinch = 0; a.flinchX = 0; a.flinchZ = 0; a.hitFlash = 0; a.abdomen = 0; a.shake = 0; a.crouch = 0;
    a.death = -1; a.rollSign = Math.random() < 0.5 ? -1 : 1; a.slopePitch = 0; a.slopeRoll = 0; a.time = Math.random() * 10;
    a.fade = 0; a.aim = 0; a.recoil = 0; a.writhe = 0; a.spark = 0;
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

  /** Classify a hit for damage multipliers. */
  classifyHit(hitPoint?: THREE.Vector3, hitDir?: THREE.Vector3): HitPart {
    if (hitPoint) {
      if (this.hasFrontPlate && this.isFrontPlate(hitPoint)) return 'front';
      this.headCenter(_v);
      if (_v.distanceToSquared(hitPoint) <= (this.stats.headRadius * 1.15) ** 2) return 'head';
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

  /** Transition to dead (death animation, corpse stays `corpseLife` seconds, then the system despawns). */
  kill(countKill: boolean): void {
    if (!this.active || this.state === 'dead') return;
    this.state = 'dead';
    this.stateTime = 0;
    this.deathTimer = 0;
    this.airborne = false;
    this.leaping = false;
    this.chargePhase = 0;
    this.spitPhase = 0;
    this.roguePhase = 0;
    this.anim.death = 0;
    this.anim.shake = 0;
    this.anim.abdomen = this.type === 'toxic' ? 0 : this.anim.abdomen;
    this.anim.crouch = 0;
    this.anim.aim = 0;
    this.anim.mandible = 0.2;
    this.velocity.set(0, 0, 0);
    this.syncTarget();
    this.burnDps = 0; this.burnTimer = 0;
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
      a.fade = THREE.MathUtils.clamp((this.deathTimer - (this.corpseLife - 3)) / 3, 0, 1);
      a.speed = Math.max(0, a.speed - dt * 6);
    }
    if (this.state === 'flee') {
      const s = Math.max(0.01, 1 - this.fleeTimer / 2);
      this.rig.root.scale.setScalar(s * this.rig.baseScale);
    }
    this.rig.root.position.copy(this.position);
    this.rig.root.rotation.y = this.yaw;
    this.animateRig();
  }

  private animateRig(): void {
    if (this.rig.kind === 'bug') animateBug(this.rig, this.anim); else animateRogue(this.rig, this.anim);
  }
}
