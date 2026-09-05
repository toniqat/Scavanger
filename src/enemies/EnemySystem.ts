import * as THREE from 'three';
import {
  GADGET_LURE_RADIUS, MAP_SIZE, NET_ENEMY_SNAPSHOT_HZ,
  type DamageMessage, type EnemyEvent, type EnemyHit, type EnemyManagerRef, type EnemyRef, type EnemyType, type GameContext, type GameSystem,
} from '@/shared';
import { Enemy, type EnemyHost, type HitPart } from './Enemy';
import { SPEWER_SPIT } from './EnemyTypes';
import { SpatialGrid } from './SpatialGrid';
import { CombatTarget, TargetList, type TargetId } from './Targets';
import { SUSPICION_TIME, updateEnemyAI } from './ai/EnemyAI';
import { LureField } from './ai/Lures';
import { becomeAlert } from './ai/Perception';
import { BloodFX } from './fx/BloodFX';
import { AcidProjectiles, type AcidHost, type AcidSlow } from './fx/AcidProjectile';
import { AmbientSpawner, type SpawnHost } from './Spawner';
import { WaveDirector } from './WaveDirector';
import { disposeBugAssets } from './models/BugModel';
import { EnemyReplica, type ReplicaHost } from './net/Replica';
import { encodeSnapshot, round, tuple } from './net/HostSync';

const DEATH_DURATION = 4;
const FLEE_DURATION = 2;
const CORPSE_SLACK = 10;      // corpses allowed above the alive cap before being recycled
const RECYCLE_DISTANCE = 160;
const MAX_REQUEST_DAMAGE = 500;
const MAX_REQUEST_RADIUS = 20;
/* ── appended: tactical kit ── */
/** Burning damage is applied in discrete ticks (quiet: no gore burst / `ee damaged` per tick). */
const BURN_TICK = 0.5;
/** Ember puff interval for a burning bug. */
const EMBER_INTERVAL = 0.35;
/** Bugs within this range of a shot remember where it came from (smoke return fire). */
const SUSPICION_RADIUS = 55;
/** Per-bug throttle on the (cheap but not free) `visionFactor` test used to grade a shot. */
const SUSPICION_REFRESH = 0.2;
/** Gunfire also acts as a weak lure so swarms converge on a firefight. */
const GUNFIRE_LURE_WEIGHT = 0.25;
const GUNFIRE_LURE_DURATION = 4;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _hc = new THREE.Vector3();
const _n = new THREE.Vector3();
const _hp = new THREE.Vector3();
const _hd = new THREE.Vector3();
const _c = new THREE.Vector3();
const _zero = new THREE.Vector3();
const _eye = new THREE.Vector3();
const killedBuf: Enemy[] = [];
const queryBuf: Enemy[] = [];

/**
 * Owns every bug: pooling, AI ticks, hit detection, spawning (ambient + extraction waves), gore FX.
 * Publishes itself as `ctx.enemies` (EnemyManagerRef).
 *
 * Multiplayer (host-authoritative): on the authority (single-player or lobby host) the AI hunts every player via
 * `TargetList`, and when a session is running it broadcasts `EnemySnapshot`s (10 Hz) + `EnemyEvent`s and serves
 * client `hit` / `explode` requests. On a joined client (`!ctx.isAuthority`) the same pools render replicas driven
 * by `net/Replica.ts`; `Enemy.takeDamage` becomes an optimistic FX + `HitRequest`.
 * Authority is read at `world:ready` / `game:newMission` and cached for the mission (host migration only takes
 * effect between missions).
 */
export class EnemySystem implements GameSystem, EnemyManagerRef, EnemyHost, SpawnHost, AcidHost, ReplicaHost {
  readonly name = 'enemies';
  ctx!: GameContext;
  readonly grid = new SpatialGrid<Enemy>(MAP_SIZE + 40, 8);
  readonly targets = new TargetList();

  readonly active: Enemy[] = [];
  private readonly byId = new Map<number, Enemy>();
  private readonly pools = new Map<EnemyType, Enemy[]>();
  private fx: BloodFX | null = null;
  private acid: AcidProjectiles | null = null;
  private readonly spawner = new AmbientSpawner();
  private readonly waves = new WaveDirector();
  private readonly replicaMgr = new EnemyReplica(this);
  /** Noise beacons the bugs walk toward (`addDistraction`, gunfire). Merged with `ctx.gadgets.findDistraction`. */
  private readonly lures = new LureField();
  /** ctx.time when the spatial grid was last rebuilt (so `queryNear` knows it can trust it). */
  private gridTime = -1;
  private nextId = 1;
  private paused = false;
  /** Cached per mission: this client simulates the bugs (single-player or host). */
  private authority = true;
  /** Cached per mission: a lobby session is running (replication on). */
  private multiplayer = false;
  private snapTimer = 0;
  private resetting = false;
  private readonly unsub: Array<() => void> = [];
  private readonly netUnsub: Array<() => void> = [];
  private readonly lastAudio = new Map<string, number>();

  get replica(): boolean { return !this.authority; }
  /** Authority inside a running session: replicate out. */
  private get hosting(): boolean { return this.authority && this.multiplayer && !!this.ctx.net; }

  /* ── lifecycle ─────────────────────────────────────────────────────────── */
  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.enemies = this;
    this.fx = new BloodFX(ctx.scene);
    this.acid = new AcidProjectiles(ctx.scene, this.fx);

    const bus = ctx.bus;
    this.unsub.push(
      bus.on('world:ready', ({ playerSpawn }) => {
        this.refreshMode();
        this.reset();
        this.spawner.reset();
        this.ensureNet();
        if (this.authority && ctx.world?.ready) {
          this.targets.refresh(ctx);
          this.spawner.initialPopulate(this, playerSpawn);
        }
      }),
      // WorldSystem (registered earlier) generates synchronously inside ITS game:newMission handler and emits
      // world:ready before this handler runs, so the initial population already exists here. Only reset when the
      // world did not (yet) generate for this seed; otherwise we would wipe the bugs we just spawned.
      bus.on('game:newMission', ({ seed }) => {
        this.refreshMode();
        if (!(ctx.world?.ready && ctx.world.seed === seed)) this.reset();
      }),
      bus.on('game:abort', () => { this.reset(); this.disposePools(); this.refreshMode(); }),
      // multiplayer pause menus keep simulating (freeze === false)
      bus.on('game:paused', ({ paused, freeze }) => { this.paused = paused && freeze !== false; }),
      bus.on('weapon:fired', ({ origin }) => this.onGunshot(origin, 55)),
      bus.on('net:remoteFired', ({ origin }) => this.onGunshot(origin, 55)),
      bus.on('grenade:exploded', ({ position }) => this.onGunshot(position, 80)),
      bus.on('extraction:activated', ({ position }) => this.startExtractionWaves(position)),
      bus.on('extraction:liftoff', ({ position }) => {
        this.stopExtractionWaves();
        if (this.authority) this.fleeFrom(position, 18);
      }),
      bus.on('enemy:waveStarted', ({ index, count }) => {
        if (this.hosting) this.ctx.net!.send({ t: 'ee', ev: 'wave', index, count }, 'others');
      }),
    );
    this.refreshMode();
    this.ensureNet();
  }

  private refreshMode(): void {
    const ctx = this.ctx;
    this.multiplayer = ctx.isMultiplayer;
    this.authority = !this.multiplayer || ctx.isAuthority;
  }

  /** Subscribe to relayed game messages once `ctx.net` exists (NetSystem registers first, but stay defensive). */
  private ensureNet(): void {
    const net = this.ctx.net;
    if (!net || this.netUnsub.length > 0) return;
    this.netUnsub.push(
      net.onMessage('es', (msg) => { if (this.replica) this.replicaMgr.onSnapshot(msg); }),
      net.onMessage('ee', (msg) => { if (this.replica) this.replicaMgr.onEvent(msg); }),
      net.onMessage('hitc', (msg) => {
        if (!this.replica) return;
        if (msg.killed) this.ctx.bus.emit('ui:hitmarker', { kill: true, headshot: msg.part === 'head' });
      }),
      net.onMessage('hit', (msg, from) => this.onHitRequest(msg.id, msg.dmg, msg.p, msg.d, from)),
      net.onMessage('explode', (msg, from) => this.onExplodeRequest(msg.p, msg.r, msg.dmg, from)),
    );
  }

  update(dt: number, ctx: GameContext): void {
    const world = ctx.world;
    if (!world || !world.ready || this.paused) return;
    this.targets.refresh(ctx);

    // spatial grid for neighbour queries
    const grid = this.grid;
    grid.clear();
    for (let i = 0; i < this.active.length; i++) {
      const e = this.active[i];
      if (e.state !== 'dead' && e.state !== 'flee') grid.insert(e);
    }
    this.gridTime = ctx.time;
    this.lures.prune(ctx.time);
    // status effects tick on every client (embers are visual); only the authority applies the damage
    if (ctx.isGameplayPhase()) this.updateStatuses(dt);

    if (this.authority) {
      if (ctx.isGameplayPhase()) {
        for (let i = 0; i < this.active.length; i++) updateEnemyAI(this.active[i], dt, this);
        this.acid?.update(dt, this);
        this.spawner.update(dt, this);
        this.waves.update(dt, this);
      }
      if (this.hosting) {
        this.snapTimer -= dt;
        if (this.snapTimer <= 0) {
          this.snapTimer = Math.max(0, this.snapTimer + 1 / NET_ENEMY_SNAPSHOT_HZ);
          ctx.net!.send(encodeSnapshot(this.active, ctx.time), 'others');
        }
      }
    } else {
      this.replicaMgr.update(dt);
      this.acid?.update(dt, this);      // visual only: damageTargetAcid is a no-op here
    }

    // visuals always tick (frozen AI still renders idle motion), then despawn finished corpses / fled bugs
    const corpseLife = this.authority ? DEATH_DURATION : DEATH_DURATION + 1;   // replicas: host despawn normally arrives first
    for (let i = this.active.length - 1; i >= 0; i--) {
      const e = this.active[i];
      e.animate(dt);
      if ((e.state === 'dead' && e.deathTimer >= corpseLife) || (e.state === 'flee' && e.fleeTimer >= FLEE_DURATION)) this.despawn(e);
    }
    this.fx?.update(dt, world);
  }

  dispose(): void {
    for (const off of this.unsub) off();
    this.unsub.length = 0;
    for (const off of this.netUnsub) off();
    this.netUnsub.length = 0;
    this.reset();
    this.disposePools();
    this.fx?.dispose(); this.fx = null;
    this.acid?.dispose(); this.acid = null;
    if (this.ctx && this.ctx.enemies === this) this.ctx.enemies = null;
  }

  /* ── EnemyManagerRef ───────────────────────────────────────────────────── */
  getEnemies(): readonly EnemyRef[] { return this.active; }

  getAliveCount(): number { return this.aliveCount(); }

  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): EnemyHit | null {
    let best: Enemy | null = null;
    let bestT = maxDist;
    let bestPart: HitPart = 'body';
    let bestKind = 0; // 0 cylinder, 1 cap, 2 head
    let bestCapY = 0;
    for (let i = 0; i < this.active.length; i++) {
      const e = this.active[i];
      if (!e.active || e.state === 'dead' || e.state === 'flee') continue;
      const r = e.stats.radius, h = e.stats.height;
      // broad phase: bounding sphere around the capsule + head
      const cx = e.position.x, cy = e.position.y + h * 0.5, cz = e.position.z;
      const R = Math.max(r, h * 0.5) + e.stats.headRadius + e.rig.params.head.z * 0.5 + 0.2;
      const ox = cx - origin.x, oy = cy - origin.y, oz = cz - origin.z;
      const tc = ox * dir.x + oy * dir.y + oz * dir.z;
      if (tc < -R || tc - R > bestT) continue;
      const perp2 = ox * ox + oy * oy + oz * oz - tc * tc;
      if (perp2 > R * R) continue;

      // head sphere
      e.headCenter(_hc);
      const th = raySphere(origin, dir, _hc, e.stats.headRadius);
      if (th >= 0 && th < bestT) { best = e; bestT = th; bestPart = 'head'; bestKind = 2; }

      // body capsule (vertical)
      const y0 = e.position.y + r;
      const y1 = Math.max(y0, e.position.y + h - r);
      const res = rayCapsule(origin, dir, cx, cz, y0, y1, r);
      if (res.t >= 0 && res.t < bestT) {
        best = e; bestT = res.t; bestKind = res.kind; bestCapY = res.capY;
        bestPart = e.classifyHit(undefined, dir);
      }
    }
    if (!best) return null;
    const point = new THREE.Vector3(origin.x + dir.x * bestT, origin.y + dir.y * bestT, origin.z + dir.z * bestT);
    const normal = new THREE.Vector3();
    if (bestKind === 2) { best.headCenter(_hc); normal.subVectors(point, _hc).normalize(); }
    else if (bestKind === 1) { normal.set(point.x - best.position.x, point.y - bestCapY, point.z - best.position.z).normalize(); }
    else { normal.set(point.x - best.position.x, 0, point.z - best.position.z).normalize(); }
    if (normal.lengthSq() < 0.5) normal.copy(dir).negate();
    return { enemy: best, point, normal, distance: bestT, part: bestPart };
  }

  /** Radial damage. On a replica this only plays local FX and forwards an `ExplodeRequest` to the host (returns 0). */
  applyExplosion(center: THREE.Vector3, radius: number, damage: number): number {
    if (this.replica) {
      for (let i = 0; i < this.active.length; i++) {
        const e = this.active[i];
        if (!e.active || e.state === 'dead') continue;
        _v.set(e.position.x, e.position.y + e.stats.height * 0.5, e.position.z);
        if (_v.distanceToSquared(center) < radius * radius) {
          _v2.subVectors(_v, center);
          if (_v2.lengthSq() < 1e-4) _v2.set(0, 1, 0); else _v2.normalize();
          this.fx?.burst(_v, 6, 'blood', 5, _v2, 0.6);
          e.anim.hitFlash = 1;
        }
      }
      this.ctx.net?.send({ t: 'explode', p: tuple(center, 2), r: round(radius, 2), dmg: round(damage, 1) }, 'host');
      return 0;
    }
    return this.explode(center, radius, damage, 'local', null);
  }

  private explode(center: THREE.Vector3, radius: number, damage: number, attacker: TargetId, killedOut: Enemy[] | null): number {
    let kills = 0;
    const r2 = radius * radius;
    for (let i = 0; i < this.active.length; i++) {
      const e = this.active[i];
      if (!e.active || e.state === 'dead') continue;
      _v.set(e.position.x, e.position.y + e.stats.height * 0.5, e.position.z);
      const d2 = _v.distanceToSquared(center);
      const reach = radius + e.stats.radius;
      if (d2 > reach * reach) continue;
      const d = Math.sqrt(d2);
      const falloff = 1 - Math.max(0, d - e.stats.radius) / radius;
      const dmg = damage * THREE.MathUtils.clamp(falloff, 0.15, 1);
      _v2.subVectors(_v, center);
      if (_v2.lengthSq() < 1e-4) _v2.set(0, 1, 0); else _v2.normalize();
      // explosions are omnidirectional: no head/rear multipliers (hitPoint at capsule center, dir ignored for part)
      e.takeDamage(dmg, undefined, undefined, attacker);
      const killed = e.hp <= 0;
      if (killed) { kills++; killedOut?.push(e); }
      else if (dmg > e.maxHp * 0.1 && e.chargePhase !== 2) {
        // knock-back nudge
        e.velocity.addScaledVector(_v2, 6 * (1 - d / reach));
      }
      if (d2 < r2) this.fx?.burst(_v, 6, 'blood', 5, _v2, 0.6);
    }
    return kills;
  }

  setThreatLevel(level: number): void { this.spawner.threat = THREE.MathUtils.clamp(level, 0, 1); }

  startExtractionWaves(target: THREE.Vector3): void { this.waves.start(target); }

  stopExtractionWaves(): void { this.waves.stop(); }

  killAll(): void {
    for (let i = 0; i < this.active.length; i++) {
      const e = this.active[i];
      if (e.active && e.state !== 'dead') e.kill(false);
    }
  }

  /* ── EnemyManagerRef: appended tactical-kit queries ────────────────────── */

  /**
   * Alive enemies within `radius` of `pos` (turrets, scans, explosions, lures).
   * Uses the per-frame spatial grid when it is fresh, else a linear scan — both allocation-free apart
   * from the returned array.
   */
  queryNear(pos: THREE.Vector3, radius: number): EnemyRef[] {
    const out: EnemyRef[] = [];
    const r2 = radius * radius;
    const usable = this.gridTime === this.ctx.time && this.active.length > 24;
    if (usable) {
      queryBuf.length = 0;
      const n = this.grid.query(pos.x, pos.z, radius, queryBuf);
      for (let i = 0; i < n; i++) {
        const e = queryBuf[i];
        if (!e.active || e.state === 'dead' || e.state === 'flee') continue;
        const dx = e.position.x - pos.x, dy = e.position.y + e.stats.height * 0.5 - pos.y, dz = e.position.z - pos.z;
        if (dx * dx + dy * dy + dz * dz <= r2) out.push(e);
      }
      queryBuf.length = 0;
      return out;
    }
    for (let i = 0; i < this.active.length; i++) {
      const e = this.active[i];
      if (!e.active || e.state === 'dead' || e.state === 'flee') continue;
      const dx = e.position.x - pos.x, dy = e.position.y + e.stats.height * 0.5 - pos.y, dz = e.position.z - pos.z;
      if (dx * dx + dy * dy + dz * dz <= r2) out.push(e);
    }
    return out;
  }

  /**
   * Pull aggro toward `pos` (lure grenade, gunfire noise). Registers a lure the AI walks toward and
   * wakes unaware bugs inside the radius. Authority only — replicas follow the host's snapshots.
   */
  addDistraction(pos: THREE.Vector3, radius: number, duration: number, weight: number): void {
    if (!this.authority) return;
    this.lures.add(pos, radius, duration, weight, this.ctx.time);
    if (weight < 0.3) return;
    // a real lure also wakes the swarm around it
    const r2 = radius * radius;
    let loudBudget = 2;
    for (let i = 0; i < this.active.length; i++) {
      const e = this.active[i];
      if (!e.active || e.state === 'dead' || e.state === 'flee') continue;
      const dx = e.position.x - pos.x, dz = e.position.z - pos.z;
      if (dx * dx + dz * dz > r2) continue;
      e.lurePos.copy(pos);
      e.lureWeight = Math.max(e.lureWeight, weight);
      e.hasLure = true;
      if (!e.aware) { becomeAlert(e, this, loudBudget > 0); loudBudget--; }
    }
  }

  /**
   * Apply a status effect. `burning` deals `dps` damage (in 0.5 s ticks) for `duration` seconds and
   * spits embers; `slowed` reads `dps` as the fraction of speed removed (0.4 → 60 % speed), clamped to 0.2…1.
   * `dps` 0 clears the effect. Visuals run everywhere; damage only on the authority.
   */
  applyStatus(id: number, status: 'burning' | 'slowed', dps: number, duration: number): void {
    const e = this.byId.get(id);
    if (!e || !e.active || e.state === 'dead') return;
    if (status === 'burning') {
      if (dps <= 0) { e.burnDps = 0; e.burnTimer = 0; return; }
      e.burnDps = Math.max(e.burnDps, dps);
      e.burnTimer = Math.max(e.burnTimer, duration);
      if (e.burnTick <= 0) e.burnTick = BURN_TICK;
      return;
    }
    if (dps <= 0) { e.slowFactor = 1; e.slowTimer = 0; return; }
    const factor = THREE.MathUtils.clamp(dps <= 1 ? 1 - dps : 1 / dps, 0.2, 1);
    e.slowFactor = Math.min(e.slowFactor, factor);
    e.slowTimer = Math.max(e.slowTimer, duration);
  }

  /**
   * Radial damage credited to `by` (turret, mine, rocket). Same falloff as `applyExplosion`.
   * On a replica this plays the local FX and forwards an `ExplodeRequest` (the host credits the requester).
   */
  applyAreaDamage(center: THREE.Vector3, radius: number, damage: number, by?: string): number {
    if (this.replica) return this.applyExplosion(center, radius, damage);
    return this.explode(center, radius, damage, (by as TargetId | undefined) ?? 'local', null);
  }

  reset(): void {
    this.resetting = true;
    this.lures.clear();
    for (let i = this.active.length - 1; i >= 0; i--) this.despawn(this.active[i]);
    this.active.length = 0;
    this.byId.clear();
    this.waves.reset();
    this.spawner.reset();
    this.replicaMgr.clear();
    this.targets.clear();
    this.fx?.clear();
    this.acid?.clear();
    this.lastAudio.clear();
    this.snapTimer = 0;
    this.resetting = false;
  }

  /* ── client → host requests (authority only) ───────────────────────────── */
  private onHitRequest(id: number, dmg: number, p: readonly number[], d: readonly number[], from: string): void {
    if (!this.hosting) return;
    if (!(dmg > 0) || dmg > MAX_REQUEST_DAMAGE) return;
    const e = this.byId.get(id);
    if (!e || !e.active || e.state === 'dead') return;
    _hp.set(p[0], p[1], p[2]);
    _hd.set(d[0], d[1], d[2]);
    const dir = _hd.lengthSq() > 0.5 ? _hd : undefined;
    const part = e.classifyHit(_hp, dir);
    const before = e.hp;
    e.takeDamage(dmg, _hp, dir, from);
    this.ctx.net!.send({ t: 'hitc', id: e.id, dmg: round(before - e.hp, 1), killed: e.isDead, part }, from);
  }

  private onExplodeRequest(p: readonly number[], r: number, dmg: number, from: string): void {
    if (!this.hosting) return;
    if (!(dmg > 0) || dmg > MAX_REQUEST_DAMAGE || !(r > 0) || r > MAX_REQUEST_RADIUS) return;
    _c.set(p[0], p[1], p[2]);
    killedBuf.length = 0;
    this.explode(_c, r, dmg, from, killedBuf);
    const net = this.ctx.net!;
    for (let i = 0; i < killedBuf.length; i++) {
      const e = killedBuf[i];
      net.send({ t: 'hitc', id: e.id, dmg: round(e.maxHp, 1), killed: true, part: 'body' }, from);
    }
    killedBuf.length = 0;
  }

  /* ── SpawnHost ─────────────────────────────────────────────────────────── */
  aliveCount(): number {
    let n = 0;
    for (let i = 0; i < this.active.length; i++) { const e = this.active[i]; if (e.active && e.state !== 'dead' && e.state !== 'flee') n++; }
    return n;
  }

  ensureCapacity(n: number, cap: number): number {
    // 1) recycle far, unseen, unaware bugs when the alive cap is tight
    let alive = this.aliveCount();
    if (alive + n > cap && this.targets.all.length > 0) {
      for (let i = this.active.length - 1; i >= 0 && alive + n > cap; i--) {
        const e = this.active[i];
        if (!e.active || e.state === 'dead' || e.aware || e.relentless) continue;
        if (this.targets.minDist(e.position) > RECYCLE_DISTANCE) { this.despawn(e); alive--; }
      }
    }
    // 2) recycle oldest corpses so total entity count stays bounded
    let total = this.active.length;
    if (total + n > cap + CORPSE_SLACK) {
      let oldest: Enemy | null;
      do {
        oldest = null;
        for (let i = 0; i < this.active.length; i++) {
          const e = this.active[i];
          if (e.state === 'dead' && (!oldest || e.deathTimer > oldest.deathTimer)) oldest = e;
        }
        if (oldest) { this.despawn(oldest); total--; }
      } while (oldest && total + n > cap + CORPSE_SLACK);
    }
    return Math.max(0, Math.min(n, cap - alive));
  }

  spawn(type: EnemyType, position: THREE.Vector3, yaw: number, chase: boolean, relentless: boolean): Enemy | null {
    const ctx = this.ctx;
    const e = this.acquire(this.nextId++, type, position, yaw);
    if (!e) return null;
    e.relentless = relentless;
    if (chase) { e.aware = true; e.state = 'chase'; e.perceptionTimer = 0.3 + Math.random() * 0.3; }
    ctx.bus.emit('enemy:spawned', { id: e.id, type, position: e.position });
    if (this.hosting) ctx.net!.send({ t: 'ee', ev: 'spawn', id: e.id, ty: type, p: tuple(e.position, 2), yaw: round(yaw, 3) }, 'others');
    return e;
  }

  /* ── ReplicaHost ───────────────────────────────────────────────────────── */
  find(id: number): Enemy | undefined { return this.byId.get(id); }

  /** Pool → active with an explicit id (host-assigned on the authority, host's id on replicas). Silent. */
  acquire(id: number, type: EnemyType, position: THREE.Vector3, yaw: number): Enemy | null {
    const ctx = this.ctx;
    if (!ctx.world?.ready) return null;
    let pool = this.pools.get(type);
    if (!pool) { pool = []; this.pools.set(type, pool); }
    let e = pool.pop();
    if (!e) {
      e = new Enemy(type);
      e.bindHost(this);
    }
    if (!e.rig.root.parent) ctx.scene.add(e.rig.root);
    e.reset(id, position, yaw, ctx.time);
    this.active.push(e);
    this.byId.set(id, e);
    return e;
  }

  release(e: Enemy): void { this.despawn(e); }

  bloodBurst(point: THREE.Vector3, count: number, dir: THREE.Vector3 | null): void {
    if (!this.fx) return;
    if (dir) this.fx.burst(point, count, 'blood', 4.5, dir, 0.9);
    else this.fx.burst(point, count, 'blood', 4);
  }

  acidVisual(from: THREE.Vector3, target: CombatTarget, shooterId: number): void {
    this.acid?.fireAt(from, target.position, shooterId);
  }

  private despawn(e: Enemy): void {
    if (this.hosting && !this.resetting && e.active) this.ctx.net!.send({ t: 'ee', ev: 'despawn', id: e.id }, 'others');
    const idx = this.active.indexOf(e);
    if (idx >= 0) {
      const last = this.active.length - 1;
      this.active[idx] = this.active[last];
      this.active.pop();
    }
    if (this.byId.get(e.id) === e) this.byId.delete(e.id);
    e.deactivate();
    let pool = this.pools.get(e.type);
    if (!pool) { pool = []; this.pools.set(e.type, pool); }
    pool.push(e);
  }

  private disposePools(): void {
    for (const pool of this.pools.values()) { for (const e of pool) e.dispose(); pool.length = 0; }
    this.pools.clear();
    disposeBugAssets();
  }

  /* ── EnemyHost ─────────────────────────────────────────────────────────── */
  alertNear(position: THREE.Vector3, radius: number, source: Enemy | null): void {
    if (!this.authority) return;
    const r2 = radius * radius;
    for (let i = 0; i < this.active.length; i++) {
      const e = this.active[i];
      if (e === source || !e.active || e.state === 'dead' || e.aware) continue;
      const dx = e.position.x - position.x, dz = e.position.z - position.z;
      if (dx * dx + dz * dz <= r2) becomeAlert(e, this, false);
    }
  }

  /** Strongest lure covering `pos`: own distraction list merged with the authoritative gadget beacon. */
  lureFor(pos: THREE.Vector3, out: THREE.Vector3): number {
    let w = this.lures.best(pos, out, this.ctx.time);
    const g = this.ctx.gadgets;
    if (g) {
      const dep = g.findDistraction(pos, GADGET_LURE_RADIUS);
      if (dep) {
        const dw = 0.85;
        if (dw > w) { w = dw; out.copy(dep.position); }
      }
    }
    return w;
  }

  /** Spit at an explicit point (smoke return fire / deployables) — the glob still hurts whoever it lands on. */
  fireAcidAt(from: THREE.Vector3, aimFeet: THREE.Vector3, shooter: Enemy): void {
    this.acid?.fireAt(from, aimFeet, shooter.id);
  }

  emberBurst(position: THREE.Vector3, count: number): void {
    this.fx?.burst(position, count, 'ember', 1.6);
  }

  /* ── status effects (burning / slow) ───────────────────────────────────── */
  private updateStatuses(dt: number): void {
    const authority = this.authority;
    for (let i = 0; i < this.active.length; i++) {
      const e = this.active[i];
      if (!e.active || e.state === 'dead' || e.burnTimer <= 0) continue;
      e.burnTimer -= dt;
      e.emberTimer -= dt;
      if (e.emberTimer <= 0) {
        e.emberTimer = EMBER_INTERVAL;
        _v.set(e.position.x, e.position.y + e.stats.height * 0.55, e.position.z);
        this.emberBurst(_v, 4);
      }
      if (authority) {
        e.burnTick -= dt;
        if (e.burnTick <= 0) {
          e.burnTick += BURN_TICK;
          e.applyDot(e.burnDps * BURN_TICK, e.lastDamager);
        }
      }
      if (e.burnTimer <= 0) { e.burnDps = 0; e.burnTick = 0; }
    }
  }

  /**
   * A shot was heard. Wakes bugs (hearing) and, for those that cannot see through the smoke it came out of,
   * records a suspicion point they answer with very inaccurate fire. Gunfire also acts as a weak lure.
   */
  private onGunshot(position: THREE.Vector3, radius: number): void {
    this.alertHearing(position, radius);
    if (!this.authority || !this.ctx.isGameplayPhase()) return;
    this.lures.add(position, radius, GUNFIRE_LURE_DURATION, GUNFIRE_LURE_WEIGHT, this.ctx.time);
    const gadgets = this.ctx.gadgets;
    const now = this.ctx.time;
    const r2 = SUSPICION_RADIUS * SUSPICION_RADIUS;
    for (let i = 0; i < this.active.length; i++) {
      const e = this.active[i];
      if (!e.active || e.state === 'dead' || e.state === 'flee') continue;
      const dx = e.position.x - position.x, dz = e.position.z - position.z;
      if (dx * dx + dz * dz > r2) continue;
      if (now - e.suspicionAt < SUSPICION_REFRESH) continue;
      e.suspicionAt = now;
      let clarity = 1;
      if (gadgets) {
        _eye.set(e.position.x, e.position.y + e.stats.height * 0.8, e.position.z);
        const v = gadgets.visionFactor(_eye, position);
        if (typeof v === 'number' && v >= 0 && v <= 1) clarity = v;
      }
      e.suspicion.copy(position);
      e.suspicionTimer = SUSPICION_TIME;
      // shooting out of a smoke cloud draws a wide, wild answer; a clear shot is answered accurately
      e.suspicionSpread = clarity > 0.75 ? 1.5 : 3 + (1 - clarity) * 7;
    }
  }

  private alertHearing(position: THREE.Vector3, radius: number): void {
    if (!this.authority || !this.ctx.isGameplayPhase()) return;
    const r2 = radius * radius;
    let loudBudget = 2;
    for (let i = 0; i < this.active.length; i++) {
      const e = this.active[i];
      if (!e.active || e.state === 'dead' || e.aware) continue;
      const dx = e.position.x - position.x, dz = e.position.z - position.z;
      const reach = Math.min(radius, e.stats.hearRadius + (radius - 55));
      if (dx * dx + dz * dz <= Math.min(r2, reach * reach)) {
        becomeAlert(e, this, loudBudget > 0);
        loudBudget--;
      }
    }
  }

  fireAcid(from: THREE.Vector3, shooter: Enemy, target: CombatTarget): void {
    this.acid?.fire(from, target, shooter.id);
    if (this.hosting) {
      const net = this.ctx.net!;
      const tid = target.isLocal ? net.localId : target.id;
      if (tid) net.send({ t: 'ee', ev: 'acid', id: shooter.id, from: tuple(from, 2), target: tid }, 'others');
    }
  }

  hitTarget(e: Enemy, damage: number, shake = 0, target: CombatTarget | null = e.target): void {
    if (!target || target.isDead) return;
    this.applyDamage(target, damage, e.position, e.id, e.type, null, shake, true);
    this.playAudio('bug_attack', e.position, 1, e.type === 'charger' ? 0.6 : e.type === 'warrior' ? 0.8 : 1.05);
  }

  /* ── AcidHost ──────────────────────────────────────────────────────────── */
  damageTargetAcid(target: CombatTarget, amount: number, from: THREE.Vector3, shooterId: number, slow: AcidSlow): void {
    if (!this.authority || target.isDead) return;
    this.applyDamage(target, amount, from, shooterId, 'spewer', slow, 0, false);
  }

  /**
   * Route damage to a player. Local → `ctx.player.takeDamage` + `enemy:attacked` (+ slow / shake).
   * Remote → `dmg` message to that peer (net applies it there) and, when `announce`, an `ee attack` to everyone else
   * so they hear the bite (the victim mirrors `enemy:attacked` from it).
   */
  private applyDamage(target: CombatTarget, amount: number, from: THREE.Vector3, id: number, type: EnemyType, slow: AcidSlow | null, shake: number, announce: boolean): void {
    const ctx = this.ctx;
    if (target.isLocal) {
      const player = ctx.player;
      if (!player || player.isDead) return;
      player.takeDamage(amount, from);
      ctx.bus.emit('enemy:attacked', { id, type, damage: amount, position: from });
      if (slow) ctx.bus.emit('player:applySlow', slow);
      if (shake >= 0.4) ctx.bus.emit('camera:shake', { intensity: shake, duration: 0.3 });
      return;
    }
    const net = ctx.net;
    if (!net) return;
    const msg: DamageMessage = { t: 'dmg', amount: round(amount, 1), from: tuple(from, 2) };
    if (slow) msg.slow = slow;
    net.send(msg, target.id);
    if (announce) net.send({ t: 'ee', ev: 'attack', id, ty: type, target: target.id, damage: round(amount, 1), p: tuple(from, 2) }, 'others');
  }

  /** Replica: optimistic gore/audio for a local shot, then ask the host to apply it. */
  requestHit(e: Enemy, amount: number, part: HitPart, hitPoint: THREE.Vector3 | undefined, hitDir: THREE.Vector3 | undefined): void {
    const ctx = this.ctx;
    e.lastLocalHit = ctx.time;
    if (hitPoint) _v.copy(hitPoint); else _v.set(e.position.x, e.position.y + e.stats.height * 0.5, e.position.z);
    if (this.fx) {
      const count = part === 'head' ? 14 : 8;
      if (hitDir) { _v2.copy(hitDir); this.fx.burst(_v, count, 'blood', 4.5, _v2, 0.9); }
      else this.fx.burst(_v, count, 'blood', 4);
    }
    this.playAudio('bug_hit', e.position, 0.6, 0.9 + Math.random() * 0.2);
    ctx.net?.send({ t: 'hit', id: e.id, dmg: round(amount, 2), p: tuple(_v, 2), d: tuple(hitDir ?? _zero, 3) }, 'host');
  }

  onEnemyDamaged(e: Enemy, amount: number, part: HitPart, hitPoint: THREE.Vector3 | undefined, hitDir: THREE.Vector3 | undefined): void {
    const ctx = this.ctx;
    ctx.bus.emit('enemy:damaged', { id: e.id, type: e.type, amount, position: e.position, hp: e.hp });
    if (hitPoint) _v.copy(hitPoint); else _v.set(e.position.x, e.position.y + e.stats.height * 0.5, e.position.z);
    if (this.fx) {
      const count = part === 'head' ? 14 : 8;
      if (hitDir) { _v2.copy(hitDir); this.fx.burst(_v, count, 'blood', 4.5, _v2, 0.9); }
      else this.fx.burst(_v, count, 'blood', 4);
    }
    this.playAudio('bug_hit', e.position, 0.6, 0.9 + Math.random() * 0.2);
    if (this.hosting) {
      const msg: Extract<EnemyEvent, { ev: 'damaged' }> = { t: 'ee', ev: 'damaged', id: e.id, amount: round(amount, 1), p: tuple(_v, 2) };
      if (hitDir) msg.d = tuple(hitDir, 2);
      ctx.net!.send(msg, 'others');
    }
  }

  onEnemyKilled(e: Enemy, countKill: boolean): void {
    const ctx = this.ctx;
    const localKill = e.lastDamager === 'local';
    // in a session remote killers get credit on their own client (from the `kill` event)
    if (countKill && (!this.multiplayer || localKill)) {
      ctx.stats.kills++;
      ctx.bus.emit('enemy:killed', { id: e.id, type: e.type, position: e.position });
    }
    this.playAudio('bug_death', e.position, 1, e.type === 'charger' ? 0.5 : e.type === 'scavenger' ? 1.2 : 0.85);
    if (this.fx) {
      _v.set(e.position.x, e.position.y + e.stats.height * 0.5, e.position.z);
      this.fx.burst(_v, 18 + Math.round(e.stats.radius * 22), 'blood', 3 + e.stats.radius * 2);
      this.fx.splat(e.position, e.stats.radius * 1.6, 'blood', ctx.world);
    }
    if (e.type === 'spewer') this.acidBurst(e);
    if (this.hosting) {
      const net = ctx.net!;
      const killer = localKill ? net.localId : e.lastDamager;
      net.send({ t: 'ee', ev: 'kill', id: e.id, ty: e.type, p: tuple(e.position, 2), killer }, 'others');
    }
  }

  private acidBurst(e: Enemy): void {
    const ctx = this.ctx;
    _v.set(e.position.x, e.position.y + 0.9, e.position.z);
    this.fx?.burst(_v, 90, 'acid', 7);
    this.fx?.splat(e.position, SPEWER_SPIT.deathBurstRadius * 0.6, 'acid', ctx.world);
    this.playAudio('acid_splash', e.position, 1, 0.7);
    if (this.authority) {
      const players = this.targets.alive;
      for (let i = 0; i < players.length; i++) {
        const t = players[i];
        const d = t.position.distanceTo(e.position);
        if (d < SPEWER_SPIT.deathBurstRadius) {
          const dmg = SPEWER_SPIT.deathBurstDamage * (1 - d / SPEWER_SPIT.deathBurstRadius * 0.6);
          this.applyDamage(t, dmg, e.position, e.id, e.type, { duration: 1.2, factor: 0.7 }, 0, false);
        }
      }
    }
    const local = this.targets.local();
    if (local && !local.isDead) {
      const d = local.position.distanceTo(e.position);
      if (d < 12) ctx.bus.emit('camera:shake', { intensity: 0.3 * (1 - d / 12), duration: 0.25 });
    }
  }

  playAudio(id: string, position: THREE.Vector3, volume = 1, pitch = 1): void {
    const now = this.ctx.time;
    const gap = id === 'bug_step' ? 0.05 : id === 'bug_hit' ? 0.04 : 0.12;
    const last = this.lastAudio.get(id);
    if (last !== undefined && now - last < gap) return;
    this.lastAudio.set(id, now);
    this.ctx.bus.emit('audio:play', { id, position, volume, pitch });
  }

  /* ── helpers ───────────────────────────────────────────────────────────── */
  private fleeFrom(position: THREE.Vector3, radius: number): void {
    const r2 = radius * radius;
    for (let i = 0; i < this.active.length; i++) {
      const e = this.active[i];
      if (!e.active || e.state === 'dead' || e.state === 'flee') continue;
      const dx = e.position.x - position.x, dz = e.position.z - position.z;
      if (dx * dx + dz * dz > r2) continue;
      e.state = 'flee'; e.stateTime = 0; e.fleeTimer = 0;
      e.fleeFrom.copy(position);
      e.aware = false; e.airborne = false; e.chargePhase = 0; e.spitPhase = 0;
      e.anim.shake = 0; e.anim.abdomen = 0; e.anim.crouch = 0;
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Analytic ray tests (no allocations)
 * ──────────────────────────────────────────────────────────────────────────── */
function raySphere(o: THREE.Vector3, d: THREE.Vector3, c: THREE.Vector3, r: number): number {
  const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  let t = -b - s;
  if (t < 0) t = -b + s;
  return t < 0 ? -1 : t;
}

const capsuleResult = { t: -1, kind: 0, capY: 0 };

/** Ray vs vertical capsule (axis x=cx,z=cz from y0..y1, radius r). kind: 0 side, 1 cap. */
function rayCapsule(o: THREE.Vector3, d: THREE.Vector3, cx: number, cz: number, y0: number, y1: number, r: number): typeof capsuleResult {
  const res = capsuleResult;
  res.t = -1; res.kind = 0; res.capY = y0;
  const ox = o.x - cx, oz = o.z - cz;
  const a = d.x * d.x + d.z * d.z;
  let tSide = -1;
  if (a > 1e-8) {
    const b = ox * d.x + oz * d.z;
    const c = ox * ox + oz * oz - r * r;
    const disc = b * b - a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      let t = (-b - s) / a;
      if (t < 0) t = (-b + s) / a;
      if (t >= 0) {
        const y = o.y + d.y * t;
        if (y >= y0 && y <= y1) tSide = t;
      }
    }
  }
  if (tSide >= 0) { res.t = tSide; res.kind = 0; return res; }
  // caps
  _n.set(cx, y0, cz);
  let tc = raySphere(o, d, _n, r);
  let capY = y0;
  if (y1 > y0) {
    _n.set(cx, y1, cz);
    const t2 = raySphere(o, d, _n, r);
    if (t2 >= 0 && (tc < 0 || t2 < tc)) { tc = t2; capY = y1; }
  }
  if (tc >= 0) { res.t = tc; res.kind = 1; res.capY = capY; }
  return res;
}
