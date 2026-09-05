import * as THREE from 'three';
import type { EnemyRef, EnemyType, GameContext, Obstacle } from '@/shared';
import { ENEMY_STATS, type EnemyStats } from './EnemyTypes';
import { createBugRig, createBugAnim, disposeBugRig, animateBug, type BugRig, type BugAnim } from './models/BugModel';
import type { SpatialGrid } from './SpatialGrid';
import type { CombatTarget, TargetId, TargetList } from './Targets';
import type { ReplicaBuffer } from './net/Replica';

export type EnemyState = 'idle' | 'wander' | 'alert' | 'chase' | 'attack' | 'stagger' | 'dead' | 'flee';
export type HitPart = 'head' | 'body' | 'rear' | 'front';

/** Services the entity/AI needs from the owning system (avoids a circular import on EnemySystem). */
export interface EnemyHost {
  readonly ctx: GameContext;
  readonly grid: SpatialGrid<Enemy>;
  /** Every player the bugs can hunt this frame (local + remote). */
  readonly targets: TargetList;
  /** true on a joined multiplayer client: enemies are replicas driven by host snapshots, damage is a request. */
  readonly replica: boolean;
  /** Wake every unaware bug within radius (propagation). */
  alertNear(position: THREE.Vector3, radius: number, source: Enemy | null): void;
  fireAcid(from: THREE.Vector3, shooter: Enemy, target: CombatTarget): void;
  /** Deal melee/leap/charge damage to `target` (default `e.target`): local → ctx.player, remote → dmg message. */
  hitTarget(e: Enemy, damage: number, shake?: number, target?: CombatTarget | null): void;
  onEnemyDamaged(e: Enemy, amount: number, part: HitPart, hitPoint: THREE.Vector3 | undefined, hitDir: THREE.Vector3 | undefined): void;
  onEnemyKilled(e: Enemy, countKill: boolean): void;
  /** Replica only: forward a local hit to the host (`HitRequest`) and play the optimistic gore/audio. */
  requestHit(e: Enemy, amount: number, part: HitPart, hitPoint: THREE.Vector3 | undefined, hitDir: THREE.Vector3 | undefined): void;
  playAudio(id: string, position: THREE.Vector3, volume?: number, pitch?: number): void;
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
  readonly rig: BugRig;
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
  /** charger */
  chargePhase: 0 | 1 | 2 = 0; // 0 none, 1 windup, 2 rushing
  chargeTimer = 0;
  readonly chargeDir = new THREE.Vector3();
  chargeCd = 0;
  /** spewer */
  spitPhase = 0;
  /** cached nearby obstacles (refreshed every ~0.25 s) */
  nearObstacles: Obstacle[] = [];
  obstacleTimer = 0;
  /** Player this bug hunts (nearest alive, re-evaluated by the AI). Kept while dead so "target died" logic can run. */
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
  /** Who dealt the most recent damage (kill credit on the host). */
  lastDamager: TargetId = 'local';
  /** Replica: ctx.time of the last optimistic local hit (suppresses the echoed `damaged` flash). */
  lastLocalHit = -Infinity;
  /** Replica: interpolation ring buffer (created lazily by the replica manager, reused across pool cycles). */
  netBuf: ReplicaBuffer | null = null;

  constructor(type: EnemyType) {
    this.rig = createBugRig(type);
    this.type = type;
    this.stats = ENEMY_STATS[type];
    this.rig.root.visible = false;
  }

  get radius(): number { return this.stats.radius; }
  get height(): number { return this.stats.height; }
  get isDead(): boolean { return this.state === 'dead' || !this.active; }
  get object(): THREE.Object3D { return this.rig.root; }

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
    this.netBuf?.clear();
    const a = this.anim;
    a.gait = Math.random() * Math.PI * 2; a.speed = 0; a.headYaw = 0; a.headPitch = 0; a.mandible = 0;
    a.flinch = 0; a.flinchX = 0; a.flinchZ = 0; a.hitFlash = 0; a.abdomen = 0; a.shake = 0; a.crouch = 0;
    a.death = -1; a.rollSign = Math.random() < 0.5 ? -1 : 1; a.slopePitch = 0; a.slopeRoll = 0; a.time = Math.random() * 10;
    this.rig.root.visible = true;
    this.rig.root.scale.setScalar(1);
    this.rig.root.position.copy(position);
    this.rig.root.rotation.set(0, yaw, 0);
    animateBug(this.rig, a);
  }

  deactivate(): void {
    this.active = false;
    this.state = 'dead';
    this.rig.root.visible = false;
  }

  dispose(): void {
    disposeBugRig(this.rig);
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

  /** Classify a hit for damage multipliers. */
  classifyHit(hitPoint?: THREE.Vector3, hitDir?: THREE.Vector3): HitPart {
    if (hitPoint) {
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
   * Apply damage. `attacker` is who dealt it (kill credit; host only — WeaponSystem calls with the default 'local').
   * On a replica (joined client) hp never changes here: the hit is shown optimistically and forwarded to the host.
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
    this.host?.onEnemyDamaged(this, dmg, part, hitPoint, hitDir);
    if (this.hp <= 0) {
      this.hp = 0;
      this.kill(true);
      return;
    }
    // stagger on heavy hits
    const threshold = this.maxHp * this.stats.staggerFraction * (this.chargePhase === 2 ? 1.6 : 1);
    if (dmg >= threshold && this.state !== 'stagger' && !this.airborne) {
      this.enterStagger(this.type === 'charger' ? 0.9 : 0.6);
    }
  }

  enterStagger(duration: number): void {
    this.state = 'stagger';
    this.stateTime = 0;
    this.staggerTimer = duration;
    this.chargePhase = 0;
    this.spitPhase = 0;
    this.anim.shake = 0;
    this.anim.abdomen = 0;
    this.hasMoveTarget = false;
    this.velocity.multiplyScalar(0.2);
  }

  /** Transition to dead (death animation runs 4 s, then the system despawns). */
  kill(countKill: boolean): void {
    if (!this.active || this.state === 'dead') return;
    this.state = 'dead';
    this.stateTime = 0;
    this.deathTimer = 0;
    this.airborne = false;
    this.leaping = false;
    this.chargePhase = 0;
    this.spitPhase = 0;
    this.anim.death = 0;
    this.anim.shake = 0;
    this.anim.abdomen = 0;
    this.anim.crouch = 0;
    this.anim.mandible = 0.2;
    this.velocity.set(0, 0, 0);
    this.host?.onEnemyKilled(this, countKill);
  }

  /** Update purely visual state (called every frame, also while gameplay is frozen). */
  animate(dt: number): void {
    const a = this.anim;
    a.time += dt;
    a.hitFlash = Math.max(0, a.hitFlash - dt * 6);
    a.flinch = Math.max(0, a.flinch - dt * 4.5);
    if (this.state === 'dead') {
      a.death = Math.min(1, this.deathTimer / 4);
      a.speed = Math.max(0, a.speed - dt * 6);
    }
    if (this.state === 'flee') {
      const s = Math.max(0.01, 1 - this.fleeTimer / 2);
      this.rig.root.scale.setScalar(s);
    }
    this.rig.root.position.copy(this.position);
    this.rig.root.rotation.y = this.yaw;
    animateBug(this.rig, a);
  }
}
