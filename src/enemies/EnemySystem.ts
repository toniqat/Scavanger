import * as THREE from 'three';
import {
  BEHEMOTH_KNOCKBACK, BURNOUT_DURATION, CORPSE_LAND_TIMEOUT, CORPSE_LIFETIME, ENEMY_DEATH_DIRS, ENEMY_STATUS_BITS, FLAME_AFTERBURN_DPS, FLAME_AFTERBURN_DURATION, GADGET_LURE_RADIUS, MAP_SIZE,
  NET_ENEMY_SNAPSHOT_HZ, PLAYER_HEIGHT, PLAYER_RADIUS, ROGUE_DAMAGE, ROGUE_GRENADE_DAMAGE, ROGUE_GRENADE_FUSE, ROGUE_GRENADE_RADIUS, ROGUE_MAG_ROUNDS, ROGUE_RANGE,
  SHELL_BLAST_RADIUS, SHELL_DAMAGE, SHELL_FLIGHT_TIME, SHOCK_SLOW_DURATION, SHOCK_SLOW_FACTOR, TOXIC_DAMAGE, TOXIC_RADIUS,
  type DamageMessage, type EnemyDeathDir, type EnemyEvent, type EnemyFaction, type EnemyHit, type EnemyManagerRef, type EnemyRef, type EnemySnapshot, type EnemyStatusKind, type EnemyType, type GameContext, type GameSystem,
  type HitRequest, type InterceptableRef, type PeerId, type WorldRef,
} from '@/shared';
import { FxManager, ParticleBurst } from '@/core/fx';
import { Enemy, type EnemyHost, type HitPart } from './Enemy';
import { ROGUE_AI, SPEWER_SPIT } from './EnemyTypes';
import { SpatialGrid } from './SpatialGrid';
import { CombatTarget, TargetList, type TargetId } from './Targets';
import { SUSPICION_TIME, updateEnemyAI } from './ai/EnemyAI';
import { LureField } from './ai/Lures';
import { becomeAlert } from './ai/Perception';
import { BloodFX } from './fx/BloodFX';
import { AcidProjectiles, type AcidHost, type AcidSlow } from './fx/AcidProjectile';
import { ShellProjectiles, type ShellHost } from './fx/ShellProjectile';
import { RogueGrenades, type GrenadeHost } from './fx/RogueGrenade';
import { AmbientSpawner, type SpawnHost } from './Spawner';
import { WaveDirector } from './WaveDirector';
import { disposeBugAssets } from './models/BugModel';
import { disposeRogueAssets } from './models/RogueModel';
import { EnemyReplica, type ReplicaHost } from './net/Replica';
import { animHint, encodeSnapshot, round, SnapshotCache, tuple } from './net/HostSync';
import { CorpseManager, rollCorpseLootable, type CorpseWireOpts } from './Corpses';
import { placeRogueGuards, type RogueSpawnHost } from './RogueGuards';
import { raySphere, rayCapsule, rayStandingCapsule } from './RayTests';

/** Wire index of a fall direction (`ee kill.dd` / `ee corpse.dd`); 0 (`'left'`) is the omitted default. */
function deathDirIndex(dir: EnemyDeathDir | undefined): number {
  return dir ? Math.max(0, ENEMY_DEATH_DIRS.indexOf(dir)) : 0;
}

const FLEE_DURATION = 2;
const CORPSE_SLACK = 30;      // corpses allowed above the alive cap before being recycled
const RECYCLE_DISTANCE = 160;
const MAX_REQUEST_DAMAGE = 500;
const MAX_REQUEST_RADIUS = 20;
const CLASH_THROTTLE = 15;
const CLASH_RADIUS = 40;
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
/* ── appended: unique weapons (2026-09-06) ── */
/** 전소: ember puffs come ~3× as fast as plain burning (same pooled particles, no lights). */
const INCAP_EMBER_INTERVAL = 0.12;
/** Shocked: cyan spark puffs while `shockTimer` runs. */
const SPARK_INTERVAL = 0.09;
/** Seconds the spark visual lasts per `applyStatus('shocked')` (the slow itself uses the caller's duration). */
const SHOCK_SPARK_TIME = 0.6;
/** Replica → host status forwarding is throttled per enemy for the continuous callers (flame / arc every tick). */
const STATUS_REQUEST_INTERVAL = 0.25;
/** Host clamps a client's requested status duration. */
const MAX_STATUS_DURATION = 10;
/* ── appended: Phase 7 (rogue AI v2 · live authority) ── */
/** Grenade flight time is distance / this (clamped 0.8 … 1.8 s) — a lazy lob, not a bullet. */
const GRENADE_LOB_SPEED = 11;
/** Knockback speed at the blast centre (falls off linearly with the damage). */
const GRENADE_KNOCKBACK = 7;
/** Hearing radius of a rogue grenade blast (wakes bugs like a player grenade). */
const GRENADE_NOISE = 60;
/** Id headroom on promotion: ids the old host assigned that never reached us must not collide with ours. */
const PROMOTE_ID_GAP = 100;
/** Phase 9: a promoted host continues the snapshot `seq` this far past the last one it saw as a replica (never collides with the old host's counter). */
const PROMOTE_SEQ_GAP = 1000;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _hc = new THREE.Vector3();
const _hp = new THREE.Vector3();
const _hd = new THREE.Vector3();
const _c = new THREE.Vector3();
const _m = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _to = new THREE.Vector3();
const _zero = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _kb = new THREE.Vector3();
const killedBuf: Enemy[] = [];
const queryBuf: Enemy[] = [];

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
export class EnemySystem implements GameSystem, EnemyManagerRef, EnemyHost, SpawnHost, RogueSpawnHost, AcidHost, ShellHost, ReplicaHost, GrenadeHost {
  readonly name = 'enemies';
  ctx!: GameContext;
  readonly grid = new SpatialGrid<Enemy>(MAP_SIZE + 40, 8);
  readonly targets = new TargetList();

  readonly active: Enemy[] = [];
  private readonly byId = new Map<number, Enemy>();
  private readonly pools = new Map<EnemyType, Enemy[]>();
  private fx: BloodFX | null = null;
  private acid: AcidProjectiles | null = null;
  private shells: ShellProjectiles | null = null;
  /** Phase 7: rogue grenades (host = damage, replica = visual copies from `ee grenade`). */
  private grenades: RogueGrenades | null = null;
  readonly corpses = new CorpseManager();
  private readonly spawner = new AmbientSpawner();
  private readonly waves = new WaveDirector();
  private readonly replicaMgr = new EnemyReplica(this);
  /** Noise beacons the bugs walk toward (`addDistraction`, gunfire). Merged with `ctx.gadgets.findDistraction`. */
  private readonly lures = new LureField();
  /** ctx.time when the spatial grid was last rebuilt (so `queryNear` knows it can trust it). */
  private gridTime = -1;
  private nextId = 1;
  private nextShellId = 1;
  private paused = false;
  /** Cached per mission: this client simulates the bugs (single-player or host). */
  private authority = true;
  /** Cached per mission: a lobby session is running (replication on). */
  private multiplayer = false;
  private snapTimer = 0;
  /** Phase 9: delta-snapshot state (last sent fields per enemy, monotonic seq, forced keyframe). */
  private readonly snapCache = new SnapshotCache();
  private resetting = false;
  private lastClash = -Infinity;
  /** Current boss (authority) for debugging / HUD. */
  bossId = 0;
  /* ── Phase 7 ── */
  /** 시뮬레이션 훈련장: no spawner / waves / guards / initial population (set at `world:ready`). */
  private training = false;
  /** Waves announced so far this mission (`enemy:waveStarted`, also from `ee wave` on a replica) — the wave director resumes from it on promotion. */
  private wavesSeen = 0;
  /** Debug counters (smoke tests): rogue grenades thrown / exploded on this client. */
  grenadesThrown = 0;
  grenadesExploded = 0;
  /** Debug: where the last rogue grenade went off. */
  readonly lastGrenadeBlast = new THREE.Vector3();
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
    this.shells = new ShellProjectiles(ctx.scene);
    this.shells.bind(this);
    this.grenades = new RogueGrenades(ctx.scene);
    this.grenades.bind(this);
    this.corpses.bind(ctx);

    const bus = ctx.bus;
    this.unsub.push(
      bus.on('world:ready', ({ seed, playerSpawn }) => {
        this.refreshMode();
        this.reset();
        this.spawner.reset();
        this.ensureNet();
        // Phase 7: the training arena has no enemies at all (world/ reports `mode`, game/ sets `ctx.missionMode` before emitting)
        this.training = ctx.isTraining() || ctx.missionMode === 'training' || (ctx.world as Partial<WorldRef> | null)?.mode === 'training';
        if (this.training) return;
        if (this.authority && ctx.world?.ready) {
          this.targets.refresh(ctx);
          this.spawner.initialPopulate(this, playerSpawn);
          const guards = placeRogueGuards(this, seed);
          if (guards.boss) {
            this.bossId = guards.boss.id;
            ctx.bus.emit('enemy:bossSpawned', { id: guards.boss.id, type: guards.boss.type, position: guards.boss.position });
          }
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
        this.wavesSeen = Math.max(this.wavesSeen, index + 1);
        if (this.hosting) this.ctx.net!.send({ t: 'ee', ev: 'wave', index, count }, 'others');
      }),
      bus.on('crate:looted', ({ crateId }) => this.corpses.markLooted(crateId)),
      // Phase 7: mid-mission host migration — the only place authority changes while a mission runs
      bus.on('net:hostChanged', ({ isLocalHost }) => this.setAuthority(isLocalHost)),
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
      net.onMessage('hit', (msg, from) => this.onHitRequest(msg, from)),
      net.onMessage('explode', (msg, from) => this.onExplodeRequest(msg.p, msg.r, msg.dmg, from)),
      // Phase 9: a member that (re)joined the mission or a takeover needs a full picture — the next `es` is a keyframe
      net.onMessage('flow', (msg) => {
        if ((msg.ev === 'rejoined' || msg.ev === 'takeover') && this.hosting) this.snapCache.forceFull = true;
      }),
      net.onMessage('intq', (msg) => {
        // a client's bullet hit shell `sid`: validate it still exists, pop it here and broadcast
        if (!this.hosting || !this.shells) return;
        _c.set(msg.p[0], msg.p[1], msg.p[2]);
        this.shells.interceptById(msg.sid, _c, true);
      }),
    );
  }

  update(dt: number, ctx: GameContext): void {
    const world = ctx.world;
    if (!world || !world.ready || this.paused) return;
    this.targets.refresh(ctx);

    // spatial grid for neighbour queries + faction target proxies
    const grid = this.grid;
    grid.clear();
    for (let i = 0; i < this.active.length; i++) {
      const e = this.active[i];
      e.syncTarget();
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
        this.shells?.update(dt, this);
        this.grenades?.update(dt);
        if (!this.training) {
          this.spawner.update(dt, this);
          this.waves.update(dt, this);
        }
      }
      if (this.hosting) {
        this.snapTimer -= dt;
        if (this.snapTimer <= 0) {
          this.snapTimer = Math.max(0, this.snapTimer + 1 / NET_ENEMY_SNAPSHOT_HZ);
          ctx.net!.send(encodeSnapshot(this.active, ctx.time, this.snapCache), 'others');
        }
      }
    } else {
      this.replicaMgr.update(dt);
      this.acid?.update(dt, this);      // visual only: damageTargetAcid is a no-op here
      this.shells?.update(dt, this);    // visual only: onShellLanded applies no damage on a replica
      if (ctx.isGameplayPhase()) this.grenades?.update(dt);   // visual copies (`authority` false → FX only)
    }

    // visuals always tick (frozen AI still renders idle motion), then despawn finished corpses / fled bugs
    const slack = this.authority ? 0 : 1;   // replicas: the host's despawn normally arrives first
    for (let i = this.active.length - 1; i >= 0; i--) {
      const e = this.active[i];
      e.animate(dt);
      // Phase 10: a mid-air kill registers its corpse once the body has come to rest (or after CORPSE_LAND_TIMEOUT)
      if (e.corpsePending && this.authority && !this.resetting && (e.deathLanded || e.deathTimer >= CORPSE_LAND_TIMEOUT)) this.registerCorpse(e);
      if ((e.state === 'dead' && e.deathTimer >= e.corpseLife + slack) || (e.state === 'flee' && e.fleeTimer >= FLEE_DURATION)) this.despawn(e);
    }
    this.corpses.update(dt);
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
    this.shells?.dispose(); this.shells = null;
    this.grenades?.dispose(); this.grenades = null;
    if (this.ctx && this.ctx.enemies === this) this.ctx.enemies = null;
  }

  /* ── EnemyManagerRef ───────────────────────────────────────────────────── */
  getEnemies(): readonly EnemyRef[] { return this.active; }

  getAliveCount(): number { return this.aliveCount(); }

  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): EnemyHit | null {
    return this.raycastEx(origin, dir, maxDist, null);
  }

  /** Ray vs every enemy hitbox except `exclude` (rogue shots skip the shooter). */
  private raycastEx(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, exclude: Enemy | null): EnemyHit | null {
    let best: Enemy | null = null;
    let bestT = maxDist;
    let bestPart: HitPart = 'body';
    let bestKind = 0; // 0 cylinder, 1 cap, 2 head, 3 armour plate
    let bestCapY = 0;
    for (let i = 0; i < this.active.length; i++) {
      const e = this.active[i];
      if (e === exclude || !e.active || e.state === 'dead' || e.state === 'flee') continue;
      const r = e.stats.radius, h = e.stats.height;
      // broad phase: bounding sphere around the capsule + head (+ plate)
      const cx = e.position.x, cy = e.position.y + h * 0.5, cz = e.position.z;
      const R = Math.max(r, h * 0.5) + e.stats.headRadius + e.rig.params.head.z * 0.5 + 0.2 + (e.hasFrontPlate ? r : 0);
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

      // behemoth front plate (armoured): a thick vertical capsule hanging in front of the head
      if (e.hasFrontPlate) {
        e.plateAxis(_hc);
        const pr = e.plateRadius;
        const pres = rayCapsule(origin, dir, _hc.x, _hc.z, e.position.y + e.plateY0 + pr, e.position.y + e.plateY1 - pr, pr);
        if (pres.t >= 0 && pres.t <= bestT) { best = e; bestT = pres.t; bestKind = 3; bestPart = 'front'; }
      }
    }
    if (!best) return null;
    const point = new THREE.Vector3(origin.x + dir.x * bestT, origin.y + dir.y * bestT, origin.z + dir.z * bestT);
    const normal = new THREE.Vector3();
    if (bestKind === 2) { best.headCenter(_hc); normal.subVectors(point, _hc).normalize(); }
    else if (bestKind === 3) { best.plateAxis(_hc); normal.set(point.x - _hc.x, 0, point.z - _hc.z).normalize(); }
    else if (bestKind === 1) { normal.set(point.x - best.position.x, point.y - bestCapY, point.z - best.position.z).normalize(); }
    else { normal.set(point.x - best.position.x, 0, point.z - best.position.z).normalize(); }
    if (normal.lengthSq() < 0.5) normal.copy(dir).negate();
    const hit: EnemyHit = { enemy: best, point, normal, distance: bestT, part: bestPart };
    if (bestKind === 3) hit.armored = true;
    return hit;
  }

  raycastInterceptable(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): { target: InterceptableRef; point: THREE.Vector3; distance: number } | null {
    return this.shells ? this.shells.raycast(origin, dir, maxDist) : null;
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
    return this.explode(center, radius, damage, 'local', null, null);
  }

  /** `skipFaction` (Phase 7): enemies of that faction are spared (a rogue grenade hurts bugs, not the rogues). */
  private explode(center: THREE.Vector3, radius: number, damage: number, attacker: TargetId, killedOut: Enemy[] | null, exclude: Enemy | null, skipFaction: EnemyFaction | null = null): number {
    let kills = 0;
    const r2 = radius * radius;
    for (let i = 0; i < this.active.length; i++) {
      const e = this.active[i];
      if (e === exclude || !e.active || e.state === 'dead') continue;
      if (skipFaction !== null && e.faction === skipFaction) continue;
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

  startExtractionWaves(target: THREE.Vector3): void { if (!this.training) this.waves.start(target); }

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
   * `incinerated` (전소, 2026-09-06): `duration` s of writhing on the spot — no movement / attacks, still damageable —
   * `isIncapacitated`, faster embers, `enemy:incinerated`; `dps` is ignored. `shocked`: `dps` is the **speed
   * multiplier** (0..1, `SHOCK_SLOW_FACTOR` = 55 % speed) for `duration` s, plus a cyan spark strobe and
   * `enemy:shocked` (emitted once per shock, not per tick — the arc calls this every frame).
   * `dps` 0 (or `duration` 0 for 전소) clears the effect. Visuals run everywhere; gameplay only on the authority:
   * a replica keeps the optimistic visual and forwards the request to the host as `hit {dmg: 0, st, dur}`
   * (`ENEMY_STATUS_BITS`), throttled per enemy for the continuous callers.
   */
  applyStatus(id: number, status: EnemyStatusKind, dps: number, duration: number, attacker?: string): void {
    const e = this.byId.get(id);
    if (!e || !e.active || e.state === 'dead') return;
    // Phase 9: the fire's owner gets the burn-kill credit (host side only; a replica's request carries it as the relay `from`)
    if (attacker !== undefined && !this.replica && (status === 'burning' || status === 'incinerated') && (status === 'incinerated' ? duration > 0 : dps > 0)) {
      e.burnAttacker = this.normalizeAttacker(attacker);
    }
    switch (status) {
      case 'incinerated': {
        if (!(duration > 0)) { e.incapTimer = 0; return; }
        if (this.replica) {
          this.requestStatus(e, ENEMY_STATUS_BITS.INCINERATED, duration);
          if (e.incapTimer <= 0) this.ctx.bus.emit('enemy:incinerated', { id: e.id, position: e.position, duration });
          e.incapTimer = Math.max(e.incapTimer, duration);
          return;
        }
        this.incinerate(e, duration);
        return;
      }
      case 'shocked': {
        if (!(duration > 0) || !(dps > 0)) { e.shockTimer = 0; e.slowFactor = 1; e.slowTimer = 0; return; }
        if (this.replica) this.requestStatus(e, ENEMY_STATUS_BITS.SHOCKED, duration);
        const factor = THREE.MathUtils.clamp(dps, 0.2, 1);
        e.slowFactor = Math.min(e.slowFactor, factor);
        e.slowTimer = Math.max(e.slowTimer, duration);
        if (e.shockTimer <= 0) {
          this.ctx.bus.emit('enemy:shocked', { id: e.id, position: e.position });
          this.playAudio('bug_hit', e.position, 0.35, 1.6);
          e.sparkTimer = 0;
        }
        e.shockTimer = Math.max(e.shockTimer, Math.min(duration, SHOCK_SPARK_TIME));
        return;
      }
      case 'burning': {
        if (dps <= 0) { e.burnDps = 0; e.burnTimer = 0; return; }
        if (this.replica) this.requestStatus(e, ENEMY_STATUS_BITS.BURNING, duration);
        e.burnDps = Math.max(e.burnDps, dps);
        e.burnTimer = Math.max(e.burnTimer, duration);
        if (e.burnTick <= 0) e.burnTick = BURN_TICK;
        return;
      }
      default: {
        if (dps <= 0) { e.slowFactor = 1; e.slowTimer = 0; return; }
        if (this.replica) this.requestStatus(e, ENEMY_STATUS_BITS.SLOWED, duration);
        const factor = THREE.MathUtils.clamp(dps <= 1 ? 1 - dps : 1 / dps, 0.2, 1);
        e.slowFactor = Math.min(e.slowFactor, factor);
        e.slowTimer = Math.max(e.slowTimer, duration);
      }
    }
  }

  /** Authority: put `e` into 전소 for `duration` s (event, scream, ember burst). */
  private incinerate(e: Enemy, duration: number): void {
    const fresh = e.incapTimer <= 0;
    e.incinerate(duration);
    if (!e.isIncapacitated) return;
    if (fresh) {
      this.ctx.bus.emit('enemy:incinerated', { id: e.id, position: e.position, duration });
      if (e.isRogue) this.playAudio('player_hurt', e.position, 0.8, 0.9);
      else this.playAudio('bug_screech', e.position, 0.9, e.type === 'behemoth' ? 0.5 : e.type === 'charger' ? 0.7 : 1.35);
      _v.set(e.position.x, e.position.y + e.stats.height * 0.6, e.position.z);
      this.emberBurst(_v, 14);
      e.sparkTimer = 0;
    }
  }

  /**
   * Replica: forward a status to the host as a damage-less `HitRequest` (`st` bits + `dur`). Repeats of the same
   * bits inside STATUS_REQUEST_INTERVAL are dropped (the flamethrower / arc call `applyStatus` every tick).
   */
  private requestStatus(e: Enemy, bits: number, duration: number): void {
    const now = this.ctx.time;
    if ((e.statusReqBits & bits) === bits && now - e.statusReqAt < STATUS_REQUEST_INTERVAL) return;
    e.statusReqBits = now - e.statusReqAt < STATUS_REQUEST_INTERVAL ? e.statusReqBits | bits : bits;
    e.statusReqAt = now;
    _v.set(e.position.x, e.position.y + e.stats.height * 0.5, e.position.z);
    const msg: HitRequest = { t: 'hit', id: e.id, dmg: 0, p: tuple(_v, 2), d: tuple(_zero, 3), st: bits, dur: round(Math.min(MAX_STATUS_DURATION, duration), 2) };
    this.ctx.net?.send(msg, 'host');
  }

  /** Host: apply the status bits a client attached to its hit (`HitRequest.st` / `dur`); the wire carries no dps, so the defaults are the constants. */
  private applyStatusBits(e: Enemy, bits: number, dur: number | undefined, from?: string): void {
    const d = dur !== undefined && dur > 0 ? Math.min(MAX_STATUS_DURATION, dur) : 0;
    if (bits & ENEMY_STATUS_BITS.INCINERATED) this.applyStatus(e.id, 'incinerated', 0, d || BURNOUT_DURATION, from);
    if (bits & ENEMY_STATUS_BITS.SHOCKED) this.applyStatus(e.id, 'shocked', SHOCK_SLOW_FACTOR, d || SHOCK_SLOW_DURATION, from);
    if (bits & ENEMY_STATUS_BITS.BURNING) this.applyStatus(e.id, 'burning', FLAME_AFTERBURN_DPS, d || FLAME_AFTERBURN_DURATION, from);
    if (bits & ENEMY_STATUS_BITS.SLOWED) this.applyStatus(e.id, 'slowed', 0.4, d || 2, from);
  }

  /**
   * Radial damage credited to `by` (turret, mine, rocket). Same falloff as `applyExplosion`.
   * On a replica this plays the local FX and forwards an `ExplodeRequest` (the host credits the requester).
   */
  /**
   * Phase 7: live authority switch (mid-mission host migration; `net:hostChanged` → this). `true` promotes every replica
   * into a simulated enemy seeded from its last wire sample and resumes the spawner / wave director; `false` demotes the
   * simulation into replicas that the new host's first full `es` overwrites. Outside a running mission only the flag
   * changes (the next `world:ready` re-reads `ctx.isAuthority` anyway).
   */
  setAuthority(authority: boolean): void {
    if (authority === this.authority) return;
    const ctx = this.ctx;
    this.authority = authority;
    this.multiplayer = ctx.isMultiplayer;
    if (!ctx.world?.ready) return;
    if (authority) this.promote(); else this.demote();
  }

  /** Replicas → simulated enemies. */
  private promote(): void {
    const ctx = this.ctx;
    let maxId = 0;
    for (let i = 0; i < this.active.length; i++) {
      const e = this.active[i];
      if (!e.active) continue;
      maxId = Math.max(maxId, e.id);
      if (e.state === 'dead') continue;                 // corpses are adopted as they are (registered from `ee corpse`)
      const s = this.replicaMgr.latestOf(e);
      const st = s ? s.st : e.state;
      if (s) e.hp = Math.min(e.maxHp, Math.max(0.1, s.hp));
      const aware = st !== 'idle' && st !== 'wander';
      e.aware = aware;
      e.state = aware ? 'chase' : 'idle';
      e.stateTime = 0; e.wanderTimer = 1 + Math.random() * 2;
      e.spawnPos.copy(e.position);
      e.guardPos.copy(e.position); e.escortOf = null; e.leash = ROGUE_AI.leash;
      e.target = null; e.targetTimer = 0; e.perceptionTimer = Math.random() * 0.3; e.hasLOS = false; e.lostTimer = 0;
      e.roguePhase = 0; e.chargePhase = 0; e.spitPhase = 0; e.toxicPhase = 0; e.swellTimer = 0; e.dug = 0;
      e.airborne = false; e.leaping = false; e.vy = 0;
      e.burstLeft = 0; e.throwTimer = 0; e.reloadTimer = 0; e.magRounds = ROGUE_MAG_ROUNDS;
      e.hasMoveTarget = false; e.hasFacePoint = false; e.hasCover = false;
      e.velocity.set(0, 0, 0);
      e.relentless = false;
      e.lastDamager = 'ai';                               // whoever hurt it before belongs to the old host — no kill credit here
      e.netBuf?.clear();
      // status holds (0.35 s from the wire) become real durations
      if (e.incapTimer > 0) e.incinerate(Math.max(e.incapTimer, 1.5));
      if (e.burnTimer > 0) { e.burnDps = Math.max(e.burnDps, FLAME_AFTERBURN_DPS); e.burnTimer = Math.max(e.burnTimer, 1); e.burnTick = BURN_TICK; }
      if (e.slowTimer > 0) { e.slowTimer = Math.max(e.slowTimer, 1); if (e.slowFactor >= 1) e.slowFactor = SHOCK_SLOW_FACTOR; }
      if (e.shockTimer > 0) e.shockTimer = Math.min(e.shockTimer, SHOCK_SPARK_TIME);
    }
    this.nextId = Math.max(this.nextId, maxId + PROMOTE_ID_GAP);
    this.nextShellId += 1000;
    // Phase 9: fresh delta cache → our first `es` is a keyframe, with a seq the clients cannot confuse with the old host's
    this.snapCache.reset(this.replicaMgr.lastSeq + PROMOTE_SEQ_GAP);
    this.replicaMgr.clear();
    this.lures.clear();
    this.grenades?.setAuthorityAll(true);
    this.snapTimer = 0;
    this.spawner.resume();
    this.waves.reset();
    this.waves.prime(this.wavesSeen);                     // extraction/ re-requests `startExtractionWaves` on the new host
    this.targets.refresh(ctx);
  }

  /** Simulated enemies → replicas (the next full snapshot from the new host takes over). */
  private demote(): void {
    const now = this.ctx.time;
    this.waves.stop();
    this.lures.clear();
    this.grenades?.setAuthorityAll(false);
    for (let i = 0; i < this.active.length; i++) {
      const e = this.active[i];
      if (!e.active || e.state === 'dead') continue;
      e.throwTimer = 0; e.reloadTimer = 0;
      e.target = null; e.hasMoveTarget = false; e.hasFacePoint = false;
      e.chargePhase = 0; e.spitPhase = 0; e.toxicPhase = 0; e.roguePhase = 0; e.airborne = false; e.leaping = false;
      e.velocity.set(0, 0, 0);
      this.replicaMgr.adopt(e, now);
    }
  }

  applyAreaDamage(center: THREE.Vector3, radius: number, damage: number, by?: string): number {
    if (this.replica) return this.applyExplosion(center, radius, damage);
    return this.explode(center, radius, damage, by === undefined ? 'local' : this.normalizeAttacker(by), null, null);
  }

  /**
   * Phase 9: other folders name the local player by its peer id (`ctx.net.localId ?? 'local'`); the kill-credit rules
   * key on `'local'`, so fold our own id back before it lands in `lastDamager` / `burnAttacker`.
   */
  private normalizeAttacker(by: string): TargetId {
    if (by === 'local' || by === 'ai') return by;
    const me = this.ctx.net?.localId;
    return me !== undefined && me !== null && by === me ? 'local' : (by as PeerId);
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
    this.corpses.clear();
    this.fx?.clear();
    this.acid?.clear();
    this.shells?.clear();
    this.grenades?.clear();
    this.lastAudio.clear();
    this.snapTimer = 0;
    this.snapCache.reset();
    this.bossId = 0;
    this.lastClash = -Infinity;
    this.training = false;
    this.wavesSeen = 0;
    this.grenadesThrown = 0;
    this.grenadesExploded = 0;
    this.resetting = false;
  }

  /* ── debug hooks (window.__game.getSystem('enemies')) ─────────────────── */
  /** Spawn one enemy at `position` (authority only). `chase` makes it hunt immediately. Returns the entity or null. */
  debugSpawn(type: EnemyType, position: THREE.Vector3 | { x: number; y?: number; z: number }, chase = false): Enemy | null {
    if (!this.authority || !this.ctx.world?.ready) return null;
    const world = this.ctx.world;
    _v.set(position.x, 0, position.z);
    _v.y = world.getHeightAt(_v.x, _v.z);
    if (type === 'rogue' || type === 'rogue_boss') {
      return this.spawnRogue(type, _v, 0, _v, type === 'rogue_boss' ? ROGUE_AI.bossWeapon : ROGUE_AI.weapons[0], null);
    }
    return this.spawn(type, _v, 0, chase, false);
  }
  /** Live artillery shells. */
  get shellCount(): number { return this.shells?.count() ?? 0; }
  /** Live rogue grenades (Phase 7). */
  get grenadeCount(): number { return this.grenades?.count() ?? 0; }
  /** Position of a live grenade thrown by rogue `id` (debug), or null. */
  debugGrenade(id: number): THREE.Vector3 | null { return this.grenades?.findByOwner(id) ?? null; }
  /** true while this client simulates the enemies (debug / smoke). */
  get isAuthority(): boolean { return this.authority; }
  /** true in a 시뮬레이션 훈련장 world (no spawning). */
  get isTrainingWorld(): boolean { return this.training; }
  /**
   * Phase 9 (debug / smoke): encode the next snapshot through the live delta cache exactly as the host send would
   * (advances `seq`, updates the cache). `force` = keyframe.
   */
  debugSnapshot(force = false): EnemySnapshot { return encodeSnapshot(this.active, this.ctx.time, this.snapCache, force); }
  /** Phase 9 (debug / smoke): feed a snapshot into the replica path (only meaningful after `setAuthority(false)`). */
  debugApplySnapshot(msg: EnemySnapshot): void { if (this.replica) this.replicaMgr.onSnapshot(msg); }
  /** Phase 9 (debug / smoke): delta-cache diagnostics + the replica's last seq / ignored-unknown count. */
  get debugSnapshotState(): { seq: number; cached: number; forceFull: boolean; lastFull: boolean; replicaSeq: number; ignoredUnknown: number; replicaLastFull: boolean } {
    return { seq: this.snapCache.seq, cached: this.snapCache.size, forceFull: this.snapCache.forceFull, lastFull: this.snapCache.lastFull, replicaSeq: this.replicaMgr.lastSeq, ignoredUnknown: this.replicaMgr.ignoredUnknown, replicaLastFull: this.replicaMgr.lastFull };
  }
  /** Wire animation hint (`EnemyWire.a`) enemy `id` would be sent with right now (debug / smoke), −1 when unknown. */
  debugHint(id: number): number { const e = this.byId.get(id); return e ? animHint(e) : -1; }
  /** Position of live shell `sid` (debug), or null. */
  debugShell(sid: number): THREE.Vector3 | null { return this.shells?.find(sid)?.position ?? null; }

  /* ── client → host requests (authority only) ───────────────────────────── */
  /** `hit` from a client: damage (as before) and / or the status bits (`st` + `dur`, 2026-09-06; `dmg` may be 0 for a status-only request). */
  private onHitRequest(msg: HitRequest, from: string): void {
    if (!this.hosting) return;
    const { id, dmg, p, d } = msg;
    const st = msg.st ?? 0;
    if (!(dmg >= 0) || dmg > MAX_REQUEST_DAMAGE) return;
    if (dmg <= 0 && st === 0) return;
    const e = this.byId.get(id);
    if (!e || !e.active || e.state === 'dead') return;
    if (dmg > 0) {
      _hp.set(p[0], p[1], p[2]);
      _hd.set(d[0], d[1], d[2]);
      const dir = _hd.lengthSq() > 0.5 ? _hd : undefined;
      const part = e.classifyHit(_hp, dir);
      const before = e.hp;
      e.takeDamage(dmg, _hp, dir, from);
      this.ctx.net!.send({ t: 'hitc', id: e.id, dmg: round(before - e.hp, 1), killed: e.isDead, part }, from);
    }
    if (st !== 0 && !e.isDead) this.applyStatusBits(e, st, msg.dur, from);
  }

  private onExplodeRequest(p: readonly number[], r: number, dmg: number, from: string): void {
    if (!this.hosting) return;
    if (!(dmg > 0) || dmg > MAX_REQUEST_DAMAGE || !(r > 0) || r > MAX_REQUEST_RADIUS) return;
    _c.set(p[0], p[1], p[2]);
    killedBuf.length = 0;
    this.explode(_c, r, dmg, from, killedBuf, null);
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
    for (let i = 0; i < this.active.length; i++) { const e = this.active[i]; if (e.isCombatant) n++; }
    return n;
  }

  countAlive(type: EnemyType): number {
    let n = 0;
    for (let i = 0; i < this.active.length; i++) { const e = this.active[i]; if (e.type === type && e.isCombatant) n++; }
    return n;
  }

  ensureCapacity(n: number, cap: number): number {
    // 1) recycle far, unseen, unaware bugs when the alive cap is tight (rogue guards stay)
    let alive = this.aliveCount();
    if (alive + n > cap && this.targets.all.length > 0) {
      for (let i = this.active.length - 1; i >= 0 && alive + n > cap; i--) {
        const e = this.active[i];
        if (!e.active || e.state === 'dead' || e.aware || e.relentless || e.isRogue) continue;
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

  /* ── RogueSpawnHost ────────────────────────────────────────────────────── */
  spawnRogue(type: EnemyType, position: THREE.Vector3, yaw: number, guardPos: THREE.Vector3, weaponId: string, escortOf: Enemy | null): Enemy | null {
    const e = this.spawn(type, position, yaw, false, false);
    if (!e) return null;
    e.guardPos.copy(guardPos);
    e.weaponId = weaponId;
    e.escortOf = escortOf;
    if (escortOf) e.leash = ROGUE_AI.escortLeash;
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

  rogueShotVisual(id: number, from: THREE.Vector3, to: THREE.Vector3, hit: boolean): void {
    const e = this.byId.get(id);
    this.shotFx(from, to, hit ? 1 : 0);
    this.ctx.bus.emit('enemy:shot', { id, type: e?.type ?? 'rogue', from: from.clone(), to: to.clone(), hit });
  }

  shellVisual(sid: number, from: THREE.Vector3, target: THREE.Vector3, flight: number): void {
    this.shells?.fire(sid, from, target, flight);
    this.playAudio('bug_attack', from, 1, 0.45);
    this.ctx.bus.emit('enemy:shellFired', { sid, from: from.clone(), target: target.clone(), flightTime: flight });
  }

  shellInterceptedRemote(sid: number, p: THREE.Vector3): void {
    // pop it if it still flies here (local = false: nothing to send back)
    if (!this.shells?.interceptById(sid, p, false)) this.onShellIntercepted(sid, p, false);
  }

  shellLandedRemote(sid: number, p: THREE.Vector3): void {
    if (!this.shells) return;
    if (this.shells.find(sid)) { this.shells.landById(sid, p); this.onShellLanded(sid, p); }
    // else: it already landed locally (own simulation) — FX and event were played then
  }

  chargeVisual(id: number, target: THREE.Vector3): void {
    const e = this.byId.get(id);
    if (e) this.playAudio('bug_attack', e.position, 1.0, 0.4);
    this.ctx.bus.emit('enemy:chargeStarted', { id, position: e ? e.position : target.clone(), target: target.clone() });
  }

  toxicVisual(id: number, p: THREE.Vector3): void {
    this.toxicFx(p);
    this.ctx.bus.emit('enemy:toxicBurst', { id, position: p.clone(), radius: TOXIC_RADIUS });
  }

  corpseSpawnedRemote(id: number, type: EnemyType, p: THREE.Vector3, weaponId: string | undefined, opts?: CorpseWireOpts): void {
    // Phase 10: the host's `lt` / `dd` win over the local seeded roll (identical seeds agree anyway — this just makes
    // the authority explicit) and the body's own fall direction is corrected to match.
    const e = this.byId.get(id);
    if (e) {
      if (opts?.lootable !== undefined) e.lootable = opts.lootable;
      if (opts?.deathDir) { e.deathDir = opts.deathDir; e.anim.deathDir = Math.max(0, ENEMY_DEATH_DIRS.indexOf(opts.deathDir)); }
      e.corpsePending = false;
    }
    this.corpses.add(id, type, p, weaponId, this.ctx.world?.seed ?? 0, opts);
  }

  corpseGoneRemote(id: number): void { this.corpses.remove(id); }

  grenadeVisual(id: number, p: THREE.Vector3, v: THREE.Vector3, fuse: number): void {
    if (!this.grenades) return;
    this.grenades.throw(id, p, v, fuse, false);
    this.grenadesThrown++;
    const e = this.byId.get(id);
    this.playAudio('grenade_throw', e ? e.position : p, 0.7, 0.95);
  }

  grenadeHitRemote(p: THREE.Vector3): void { this.grenades?.explodeNear(p); }

  private despawn(e: Enemy): void {
    if (this.hosting && !this.resetting && e.active) this.ctx.net!.send({ t: 'ee', ev: 'despawn', id: e.id }, 'others');
    if (!this.resetting && this.corpses.remove(e.id) && this.hosting) this.ctx.net!.send({ t: 'ee', ev: 'corpseGone', id: e.id }, 'others');
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
    disposeRogueAssets();
  }

  /* ── EnemyHost ─────────────────────────────────────────────────────────── */
  alertNear(position: THREE.Vector3, radius: number, source: Enemy | null): void {
    if (!this.authority) return;
    const r2 = radius * radius;
    for (let i = 0; i < this.active.length; i++) {
      const e = this.active[i];
      if (e === source || !e.active || e.state === 'dead' || e.aware) continue;
      if (source && e.faction !== source.faction) continue;   // a screeching bug does not wake the rogues (they spot it themselves)
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

  /* ── Phase 7: rogue grenades ───────────────────────────────────────────── */
  /** Authority: lob a grenade from the rogue's off hand onto `target` (feet), `ee grenade` to the others. */
  throwGrenade(e: Enemy, target: THREE.Vector3): boolean {
    const ctx = this.ctx;
    const world = ctx.world;
    if (!world || !this.grenades || !this.authority) return false;
    // launch point: off-hand height, a little ahead of the body
    e.facing(_m).multiplyScalar(e.stats.radius * 0.8);
    _m.add(e.position); _m.y += e.stats.height * 0.78;
    _aim.copy(target);
    _aim.x += (Math.random() - 0.5) * 2; _aim.z += (Math.random() - 0.5) * 2;
    if (!world.isInsideBounds(_aim.x, _aim.z)) _aim.copy(target);
    _aim.y = world.getHeightAt(_aim.x, _aim.z);
    const dist = Math.hypot(_aim.x - _m.x, _aim.z - _m.z);
    const flight = THREE.MathUtils.clamp(dist / GRENADE_LOB_SPEED, 0.8, 1.8);
    RogueGrenades.launchVelocity(_m, _aim, flight, _dir);
    // a rock right in front of the hand would bounce the grenade back onto the thrower: refuse (the AI retries elsewhere)
    _v.copy(_dir).normalize();
    if (world.raycast(_m, _v, 2.5) !== null) return false;
    if (!this.grenades.throw(e.id, _m, _dir, ROGUE_GRENADE_FUSE, true)) return false;
    this.grenadesThrown++;
    this.playAudio('grenade_throw', e.position, 0.7, 0.95);
    if (this.hosting) ctx.net!.send({ t: 'ee', ev: 'grenade', id: e.id, p: tuple(_m, 2), v: tuple(_dir, 2), fuse: ROGUE_GRENADE_FUSE }, 'others');
    return true;
  }

  /* ── GrenadeHost ───────────────────────────────────────────────────────── */
  /**
   * Fuse ran out. Authority: ROGUE_GRENADE_DAMAGE with linear falloff over ROGUE_GRENADE_RADIUS to every alive player
   * (local directly, remote via `dmg {kb}`, suspended via `ghost:damage`) and to enemies of the other faction, blast
   * noise, `ee grenadeHit`. Everyone: audio, shake near the local player.
   */
  onGrenadeExploded(p: THREE.Vector3, authority: boolean, owner: number): void {
    const ctx = this.ctx;
    this.grenadesExploded++;
    this.lastGrenadeBlast.copy(p);
    if (authority && this.authority) {
      const thrower = this.byId.get(owner);
      const type: EnemyType = thrower?.type ?? 'rogue';
      const players = this.targets.alive;
      const reach = ROGUE_GRENADE_RADIUS + PLAYER_RADIUS;
      for (let i = 0; i < players.length; i++) {
        const t = players[i];
        _c.set(t.position.x, t.position.y + PLAYER_HEIGHT * 0.5, t.position.z);
        const d = _c.distanceTo(p);
        if (d >= reach) continue;
        const falloff = THREE.MathUtils.clamp(1 - Math.max(0, d - PLAYER_RADIUS) / ROGUE_GRENADE_RADIUS, 0.1, 1);
        _kb.subVectors(_c, p); _kb.y = Math.max(_kb.y, 0) + 0.35;
        if (_kb.lengthSq() < 1e-4) _kb.set(0, 1, 0); else _kb.normalize();
        this.applyDamage(t, ROGUE_GRENADE_DAMAGE * falloff, p, owner, type, null, 0.9 * falloff, false, _kb, GRENADE_KNOCKBACK * falloff);
      }
      this.explode(p, ROGUE_GRENADE_RADIUS, ROGUE_GRENADE_DAMAGE, 'ai', null, null, 'rogue');
      this.alertHearing(p, GRENADE_NOISE);
      if (this.hosting) ctx.net!.send({ t: 'ee', ev: 'grenadeHit', p: tuple(p, 2) }, 'others');
    }
    this.playAudio('explosion', p, 0.9, 1.15);
    const dl = this.targets.distToLocal(p);
    if (dl < 30) ctx.bus.emit('camera:shake', { intensity: 0.7 * (1 - dl / 30), duration: 0.35 });
  }

  /* ── status effects (burning / slow / 전소 / shocked) ──────────────────── */
  private updateStatuses(dt: number): void {
    const authority = this.authority;
    for (let i = 0; i < this.active.length; i++) {
      const e = this.active[i];
      if (!e.active || e.state === 'dead') continue;
      const incap = e.incapTimer > 0;
      // replicas hold `incapTimer` / `slowTimer` from the wire bits (the AI ticks them on the authority)
      if (!authority) {
        if (incap) e.incapTimer = Math.max(0, e.incapTimer - dt);
        if (e.slowTimer > 0) { e.slowTimer -= dt; if (e.slowTimer <= 0) e.slowFactor = 1; }
      }
      if (e.burnTimer > 0 || incap) {
        if (e.burnTimer > 0) e.burnTimer -= dt;
        e.emberTimer -= dt;
        if (e.emberTimer <= 0) {
          e.emberTimer = incap ? INCAP_EMBER_INTERVAL : EMBER_INTERVAL;
          _v.set(e.position.x + (Math.random() - 0.5) * e.stats.radius, e.position.y + e.stats.height * (incap ? 0.35 + Math.random() * 0.4 : 0.55), e.position.z + (Math.random() - 0.5) * e.stats.radius);
          this.emberBurst(_v, incap ? 5 : 4);
        }
        if (authority && e.burnTimer > 0) {
          e.burnTick -= dt;
          if (e.burnTick <= 0) {
            e.burnTick += BURN_TICK;
            // Phase 9: the fire's owner (applyStatus attacker) takes the credit; a remote owner also gets the kill hitmarker
            const by = e.burnAttacker ?? e.lastDamager;
            e.applyDot(e.burnDps * BURN_TICK, by);
            if (e.isDead && this.hosting && by !== 'local' && by !== 'ai') {
              this.ctx.net!.send({ t: 'hitc', id: e.id, dmg: round(e.burnDps * BURN_TICK, 1), killed: true, part: 'body' }, by);
            }
          }
        }
        if (e.burnTimer <= 0) { e.burnDps = 0; e.burnTick = 0; e.burnAttacker = null; }
      }
      if (e.shockTimer > 0) {
        e.shockTimer -= dt;
        e.sparkTimer -= dt;
        if (e.sparkTimer <= 0) {
          e.sparkTimer = SPARK_INTERVAL;
          _v.set(e.position.x + (Math.random() - 0.5) * e.stats.radius * 1.4, e.position.y + e.stats.height * (0.3 + Math.random() * 0.6), e.position.z + (Math.random() - 0.5) * e.stats.radius * 1.4);
          this.fx?.burst(_v, 3, 'spark', 2.2);
        }
      }
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

  /**
   * Phase 4 target selection. Bugs: nearest of (alive players, rogues within sight radius) — equal priority.
   * Rogues: the nearest alive player within ROGUE_RANGE; otherwise a bug within ROGUE_AI.bugRange, else the nearest player.
   */
  pickTarget(e: Enemy): CombatTarget | null {
    const player = this.targets.nearestAlive(e.position);
    const pd = player ? player.dist2D(e.position) : Infinity;
    const range = e.isRogue ? ROGUE_AI.bugRange : e.stats.sightRadius;
    let foe: Enemy | null = null;
    let fd = range;
    for (let i = 0; i < this.active.length; i++) {
      const o = this.active[i];
      if (o === e || !o.isCombatant || o.faction === e.faction) continue;
      const d = Math.hypot(o.position.x - e.position.x, o.position.z - e.position.z);
      if (d < fd) { fd = d; foe = o; }
    }
    if (e.isRogue) {
      if (player && pd < ROGUE_RANGE && (!foe || fd > pd * 0.5)) return player;
      return foe ? foe.asTarget : player;
    }
    if (foe && fd < pd) return foe.asTarget;
    return player;
  }

  fireAcid(from: THREE.Vector3, shooter: Enemy, target: CombatTarget): void {
    if (target.enemy) {
      // bug vs rogue: spit straight at the enemy position (no player target on the wire)
      this.acid?.fireAt(from, target.position, shooter.id);
      return;
    }
    this.acid?.fire(from, target, shooter.id);
    if (this.hosting) {
      const net = this.ctx.net!;
      const tid = target.isLocal ? net.localId : target.id;
      if (tid) net.send({ t: 'ee', ev: 'acid', id: shooter.id, from: tuple(from, 2), target: tid }, 'others');
    }
  }

  hitTarget(e: Enemy, damage: number, shake = 0, target: CombatTarget | null = e.target): void {
    if (!target || target.isDeadOrDowned) return;
    this.applyDamage(target, damage, e.position, e.id, e.type, null, shake, true);
    this.playAudio('bug_attack', e.position, 1, e.type === 'behemoth' ? 0.4 : e.type === 'charger' ? 0.6 : e.type === 'warrior' ? 0.8 : 1.05);
  }

  /** Rogue hitscan shot (authority): occlusion, player capsules, enemy hitboxes, damage, FX, audio, events, wire. */
  fireGun(e: Enemy, target: CombatTarget, aimError: number, damageMul: number): void {
    const ctx = this.ctx;
    const world = ctx.world;
    if (!world) return;
    e.muzzle(_m);
    target.getChest(_aim);
    _aim.addScaledVector(target.velocity, 0.06);
    _dir.subVectors(_aim, _m);
    if (_dir.lengthSq() < 1e-4) e.facing(_dir); else _dir.normalize();
    // aim error: rotate around the right / up axes (triangular distribution)
    const ey = (Math.random() + Math.random() - 1) * aimError;
    const ep = (Math.random() + Math.random() - 1) * aimError * 0.7;
    _v.set(-_dir.z, 0, _dir.x).normalize();
    _dir.addScaledVector(_v, ey);
    _dir.y += ep;
    _dir.normalize();

    let hitT = ROGUE_AI.range;
    const wh = world.raycast(_m, _dir, hitT);
    if (wh) hitT = wh.distance;
    let victim: CombatTarget | null = null;
    const players = this.targets.alive;
    for (let i = 0; i < players.length; i++) {
      const t = players[i];
      const tt = rayStandingCapsule(_m, _dir, t.position, PLAYER_RADIUS, PLAYER_HEIGHT);
      if (tt >= 0 && tt < hitT) { hitT = tt; victim = t; }
    }
    let foe: Enemy | null = null;
    const eh = this.raycastEx(_m, _dir, hitT, e);
    if (eh && eh.distance < hitT) { hitT = eh.distance; victim = null; foe = eh.enemy as Enemy; }
    // Phase 9: a 배리어 in the line stops the round (one pure raycast per shot; the barrier takes the block damage)
    let barrier = false;
    const imp = ctx.implants;
    if (imp) {
      const bh = imp.raycastBarrier(_m, _dir, hitT, true);
      if (bh) {
        const bd = bh.point.distanceTo(_m);
        if (bd < hitT) { hitT = bd; victim = null; foe = null; barrier = true; imp.damageBarrier(bh.owner, bh.point); }
      }
    }
    _to.copy(_m).addScaledVector(_dir, hitT);

    const dmg = ROGUE_DAMAGE * damageMul;
    if (victim) this.applyDamage(victim, dmg, e.position, e.id, e.type, null, 0.2, false);
    else if (foe && foe.faction !== e.faction) {
      foe.takeDamage(dmg, _to, _dir, 'ai');
      this.noteClash(_to);
    }
    if (wh && !victim && !foe && !barrier) {
      const fx = FxManager.get();
      if (fx) ParticleBurst.dust(fx.alpha, wh.point, wh.normal, 4, 0.5);
    }
    this.shotFx(_m, _to, victim ? 1 : 0);
    ctx.bus.emit('enemy:shot', { id: e.id, type: e.type, from: _m.clone(), to: _to.clone(), hit: !!victim });
    if (this.hosting) ctx.net!.send({ t: 'ee', ev: 'shoot', id: e.id, from: tuple(_m, 2), to: tuple(_to, 2), hit: !!victim }, 'others');
  }

  /** Tracer + muzzle flash sprite (no lights) + rifle report at the muzzle. */
  private shotFx(from: THREE.Vector3, to: THREE.Vector3, hit: number): void {
    const fx = FxManager.get();
    if (fx) {
      fx.tracers.add(from, to, 0xffc890, 0.03, 0.09, 0);
      fx.flashes.flash(from, 0xffc070, 0, 0.55, 0.05);
    }
    this.playAudio('shot_rifle', from, 0.75, 0.9);
    if (hit) this.playAudio('hit_flesh', to, 0.6, 0.9);
  }

  /** Artillery: shell `sid` toward the target's predicted position, landing after SHELL_FLIGHT_TIME. */
  fireShell(e: Enemy, target: CombatTarget): void {
    const ctx = this.ctx;
    const world = ctx.world;
    if (!world || !this.shells) return;
    const sid = this.nextShellId++;
    _aim.copy(target.position).addScaledVector(target.velocity, SHELL_FLIGHT_TIME * 0.5);
    _aim.x += (Math.random() - 0.5) * 3; _aim.z += (Math.random() - 0.5) * 3;
    _aim.y = world.getHeightAt(_aim.x, _aim.z);
    _m.set(e.position.x, e.position.y + e.stats.height * 0.95, e.position.z);
    if (!this.shells.fire(sid, _m, _aim, SHELL_FLIGHT_TIME)) return;
    this.playAudio('bug_attack', e.position, 1, 0.45);
    const fx = FxManager.get();
    if (fx) { ParticleBurst.smoke(fx.alpha, _m, 10, 1.0, 0x3a3532); fx.flashes.flash(_m, 0xffa060, 0, 1.4, 0.08); }
    ctx.bus.emit('enemy:shellFired', { sid, from: _m.clone(), target: _aim.clone(), flightTime: SHELL_FLIGHT_TIME });
    if (this.hosting) ctx.net!.send({ t: 'ee', ev: 'shell', sid, from: tuple(_m, 2), target: tuple(_aim, 2), flight: SHELL_FLIGHT_TIME }, 'others');
  }

  /* ── ShellHost ─────────────────────────────────────────────────────────── */
  onShellLanded(sid: number, p: THREE.Vector3): void {
    const ctx = this.ctx;
    if (this.authority) {
      const players = this.targets.alive;
      for (let i = 0; i < players.length; i++) {
        const t = players[i];
        const d = t.position.distanceTo(p);
        if (d < SHELL_BLAST_RADIUS + PLAYER_RADIUS) {
          _v.set(p.x, p.y + 0.6, p.z);
          if (this.barrierBlocks(_v, t)) continue;   // Phase 9: the blast stops at a 배리어 between the crater and the player
          const dmg = SHELL_DAMAGE * THREE.MathUtils.clamp(1 - Math.max(0, d - PLAYER_RADIUS) / SHELL_BLAST_RADIUS * 0.75, 0.25, 1);
          this.applyDamage(t, dmg, p, 0, 'artillery', null, 0.9, false);
        }
      }
      this.explode(p, SHELL_BLAST_RADIUS, SHELL_DAMAGE, 'ai', null, null);   // friendly fire on bugs and rogues alike
    }
    this.playAudio('explosion', p, 1, 0.85);
    const dl = this.targets.distToLocal(p);
    if (dl < 45) ctx.bus.emit('camera:shake', { intensity: 0.9 * (1 - dl / 45), duration: 0.4 });
    ctx.bus.emit('enemy:shellLanded', { sid, position: p.clone(), radius: SHELL_BLAST_RADIUS });
    if (this.hosting) ctx.net!.send({ t: 'ee', ev: 'shellHit', sid, p: tuple(p, 2) }, 'others');
  }

  onShellIntercepted(sid: number, p: THREE.Vector3, local: boolean): void {
    const ctx = this.ctx;
    this.playAudio('explosion', p, 0.6, 1.4);
    ctx.bus.emit('enemy:shellIntercepted', { sid, position: p.clone() });
    if (this.hosting) ctx.net!.send({ t: 'ee', ev: 'intercept', sid, p: tuple(p, 2) }, 'others');
    else if (this.replica && local) ctx.net?.send({ t: 'intq', sid, p: tuple(p, 2) }, 'host');
  }

  /* ── behemoth ──────────────────────────────────────────────────────────── */
  chargeHit(e: Enemy, target: CombatTarget, damage: number, knockDir: THREE.Vector3): void {
    if (target.isDeadOrDowned) return;
    // local: applyKnockback; remote: `dmg.kb` (Phase 7); suspended: `ghost:damage.kb`
    this.applyDamage(target, damage, e.position, e.id, e.type, null, 1.0, true, knockDir, BEHEMOTH_KNOCKBACK);
    this.playAudio('bug_attack', e.position, 1, 0.4);
  }

  onChargeStarted(e: Enemy, target: THREE.Vector3): void {
    const ctx = this.ctx;
    ctx.bus.emit('enemy:chargeStarted', { id: e.id, position: e.position, target: target.clone() });
    if (this.hosting) ctx.net!.send({ t: 'ee', ev: 'charge', id: e.id, target: tuple(target, 2) }, 'others');
  }

  /* ── AcidHost ──────────────────────────────────────────────────────────── */
  damageTargetAcid(target: CombatTarget, amount: number, from: THREE.Vector3, shooterId: number, slow: AcidSlow): void {
    if (!this.authority || target.isDeadOrDowned) return;
    // Phase 9: acid that crossed a 배리어 on its way in is stopped by it (checked once at the hit, from the spewer's mouth
    // for a direct glob and from the splash point for the splash — the glob itself keeps flying visually)
    const shooter = this.byId.get(shooterId);
    if (shooter && slow.factor <= 0.6) _v.set(shooter.position.x, shooter.position.y + shooter.stats.height * 0.7, shooter.position.z);
    else _v.copy(from);
    if (this.barrierBlocks(_v, target)) return;
    this.applyDamage(target, amount, from, shooterId, 'spewer', slow, 0, false);
  }

  /**
   * Phase 9: does a 배리어 stand between `from` and the target's chest? If so the barrier takes the block damage
   * (`ImplantsRef.damageBarrier`) and the caller deals none. One pure raycast per call — call it per hit, never per tick.
   */
  private barrierBlocks(from: THREE.Vector3, target: CombatTarget): boolean {
    const imp = this.ctx.implants;
    if (!imp) return false;
    target.getChest(_aim);
    _dir.subVectors(_aim, from);
    const d = _dir.length();
    if (d < 1e-3) return false;
    _dir.multiplyScalar(1 / d);
    const bh = imp.raycastBarrier(from, _dir, d, true);
    if (!bh) return false;
    imp.damageBarrier(bh.owner, bh.point);
    return true;
  }

  /**
   * Route damage to a target. Local player → `ctx.player.takeDamage` + `enemy:attacked` (+ slow / shake).
   * Remote player → `dmg` message to that peer (net applies it there) and, when `announce`, an `ee attack` to everyone
   * else so they hear the bite (the victim mirrors `enemy:attacked` from it).
   * Phase 4: an enemy target (`target.enemy`) takes `takeDamage(…, 'ai')` — no kill credit, faction clash toast.
   * Phase 7: `kbDir` / `kbSpeed` = knockback (behemoth charge, grenade blast): local → `applyKnockback`, remote →
   * `dmg.kb`; a **suspended** member (host-simulated ghost) gets `ghost:damage {id, amount, from, kb}` on the bus
   * instead of a `dmg` message.
   */
  private applyDamage(target: CombatTarget, amount: number, from: THREE.Vector3, id: number, type: EnemyType, slow: AcidSlow | null, shake: number, announce: boolean, kbDir: THREE.Vector3 | null = null, kbSpeed = 0): void {
    if (target.isDeadOrDowned) return; // downed players are never AI victims (Phase 2)
    const ctx = this.ctx;
    if (target.enemy) {
      const victim = target.enemy;
      if (!victim.isCombatant) return;
      _hd.subVectors(victim.position, from); _hd.y = 0;
      const dir = _hd.lengthSq() > 1e-4 ? _hd.normalize() : undefined;
      victim.takeDamage(amount, undefined, dir, 'ai');
      this.noteClash(victim.position);
      return;
    }
    if (target.isLocal) {
      const player = ctx.player;
      if (!player || player.isDead || player.isDowned) return;
      player.takeDamage(amount, from);
      ctx.bus.emit('enemy:attacked', { id, type, damage: amount, position: from });
      if (slow) ctx.bus.emit('player:applySlow', slow);
      if (shake >= 0.4) ctx.bus.emit('camera:shake', { intensity: shake, duration: 0.3 });
      if (kbDir && kbSpeed > 0 && !player.isDead && typeof player.applyKnockback === 'function') player.applyKnockback(kbDir, kbSpeed);
      return;
    }
    if (target.suspended) {
      // Phase 7: the member's socket is down — the host's RemotePlayerSystem simulates the body from this event
      ctx.bus.emit('ghost:damage', {
        id: target.id as PeerId, amount, from: from.clone(),
        kb: kbDir && kbSpeed > 0 ? { direction: kbDir.clone(), speed: kbSpeed } : undefined,
      });
      if (announce && this.hosting) ctx.net!.send({ t: 'ee', ev: 'attack', id, ty: type, target: target.id, damage: round(amount, 1), p: tuple(from, 2) }, 'others');
      return;
    }
    const net = ctx.net;
    if (!net) return;
    const msg: DamageMessage = { t: 'dmg', amount: round(amount, 1), from: tuple(from, 2) };
    if (slow) msg.slow = slow;
    if (kbDir && kbSpeed > 0) msg.kb = { d: tuple(kbDir, 2), s: round(kbSpeed, 1) };
    net.send(msg, target.id);
    if (announce) net.send({ t: 'ee', ev: 'attack', id, ty: type, target: target.id, damage: round(amount, 1), p: tuple(from, 2) }, 'others');
  }

  /** First bug ↔ rogue engagement within CLASH_RADIUS of the local player (throttled) → `enemy:factionClash`. */
  private noteClash(position: THREE.Vector3): void {
    const ctx = this.ctx;
    if (ctx.time - this.lastClash < CLASH_THROTTLE) return;
    if (this.targets.distToLocal(position) > CLASH_RADIUS) return;
    this.lastClash = ctx.time;
    ctx.bus.emit('enemy:factionClash', { position: position.clone() });
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
    this.playAudio(e.isRogue ? 'hit_flesh' : 'bug_hit', e.position, 0.6, 0.9 + Math.random() * 0.2);
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
    this.playAudio(e.isRogue ? 'hit_flesh' : 'bug_hit', e.position, 0.6, 0.9 + Math.random() * 0.2);
    if (this.hosting) {
      const msg: Extract<EnemyEvent, { ev: 'damaged' }> = { t: 'ee', ev: 'damaged', id: e.id, amount: round(amount, 1), p: tuple(_v, 2) };
      if (hitDir) msg.d = tuple(hitDir, 2);
      ctx.net!.send(msg, 'others');
    }
  }

  onEnemyKilled(e: Enemy, countKill: boolean): void {
    const ctx = this.ctx;
    const localKill = e.lastDamager === 'local';
    // Phase 9: `by` names the credit - 'local' for us (our own peer id is folded back by `normalizeAttacker`, so the
    // payload reads the same online and offline), the peer id for a remote killer, null for an AI (faction) kill.
    const by: string | null = localKill ? 'local' : e.lastDamager === 'ai' ? null : e.lastDamager;
    // only our own kills bump the local counters: a remote killer counts it on its own client (from the `kill` event /
    // a `hitc`), an AI kill is credited to nobody and never reaches the bus.
    if (countKill && localKill) ctx.stats.kills++;
    if (countKill && by !== null) ctx.bus.emit('enemy:killed', { id: e.id, type: e.type, position: e.position, by, deathDir: e.deathDir });
    if (e.isRogue) this.playAudio('player_death', e.position, 0.8, e.type === 'rogue_boss' ? 0.7 : 1);
    else this.playAudio('bug_death', e.position, 1, e.type === 'behemoth' ? 0.35 : e.type === 'charger' ? 0.5 : e.type === 'scavenger' || e.type === 'toxic' ? 1.2 : 0.85);
    if (this.fx) {
      _v.set(e.position.x, e.position.y + e.stats.height * 0.5, e.position.z);
      this.fx.burst(_v, 18 + Math.round(Math.min(2, e.stats.radius) * 22), 'blood', 3 + Math.min(2, e.stats.radius) * 2);
      this.fx.splat(e.position, Math.min(3.5, e.stats.radius * 1.6), 'blood', ctx.world);
    }
    if (e.type === 'spewer') this.acidBurst(e);
    if (e.type === 'toxic' && this.authority) this.toxicBurst(e);
    // lootable corpse (authority registers; replicas mirror the `corpse` event).
    // Phase 10: a body that died in the air registers **after it lands** — `GameContext.findBest` measures a 3-D
    // distance, so a corpse pinned at the mid-air kill position was both floating and unreachable.
    if (this.authority && ctx.world) {
      if (e.deathLanded) this.registerCorpse(e);
      else e.corpsePending = true;
    }
    if (this.hosting) {
      const net = ctx.net!;
      const killer = localKill ? net.localId : e.lastDamager === 'ai' ? null : e.lastDamager;
      const msg: Extract<EnemyEvent, { ev: 'kill' }> = { t: 'ee', ev: 'kill', id: e.id, ty: e.type, p: tuple(e.position, 2), killer };
      const dd = deathDirIndex(e.deathDir);
      if (dd > 0) msg.dd = dd;
      net.send(msg, 'others');
    }
  }

  /**
   * Authority: register the `corpse:<id>` interactable at the body's **resting** position and mirror it to the
   * clients. Called from `onEnemyKilled` for a ground kill (same frame, as before) and from the update loop once a
   * mid-air body lands or `CORPSE_LAND_TIMEOUT` runs out.
   * Phase 10: the lootable roll (`CORPSE_LOOT_CHANCE`) happens here, on its own seeded stream — `rollCorpse` is only
   * ever called afterwards, by `Corpse.interact()`, so its stream is untouched.
   */
  private registerCorpse(e: Enemy): void {
    const ctx = this.ctx;
    e.corpsePending = false;
    if (!ctx.world) return;
    const lootable = rollCorpseLootable(ctx.world.seed, e.id, e.type);
    e.lootable = lootable;
    const opts: CorpseWireOpts = { lootable, deathDir: e.deathDir };
    this.corpses.add(e.id, e.type, e.position, e.weaponId || undefined, ctx.world.seed, opts);
    if (this.hosting) {
      const msg: Extract<EnemyEvent, { ev: 'corpse' }> = { t: 'ee', ev: 'corpse', id: e.id, ty: e.type, p: tuple(e.position, 2) };
      if (e.weaponId) msg.w = e.weaponId;
      const dd = deathDirIndex(e.deathDir);
      if (dd > 0) msg.dd = dd;
      if (!lootable) msg.lt = 0;
      ctx.net!.send(msg, 'others');
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

  /** Toxic burst (authority): TOXIC_DAMAGE with falloff to players and enemies of both factions, green FX, event, wire. */
  private toxicBurst(e: Enemy): void {
    const ctx = this.ctx;
    _c.copy(e.position);
    this.toxicFx(_c);
    const players = this.targets.alive;
    for (let i = 0; i < players.length; i++) {
      const t = players[i];
      const d = t.position.distanceTo(_c);
      if (d < TOXIC_RADIUS + PLAYER_RADIUS) {
        const dmg = TOXIC_DAMAGE * THREE.MathUtils.clamp(1 - Math.max(0, d - PLAYER_RADIUS) / TOXIC_RADIUS * 0.8, 0.2, 1);
        this.applyDamage(t, dmg, _c, e.id, e.type, { duration: 1.5, factor: 0.65 }, 0.5, false);
      }
    }
    this.explode(_c, TOXIC_RADIUS, TOXIC_DAMAGE, 'ai', null, e);
    ctx.bus.emit('enemy:toxicBurst', { id: e.id, position: _c.clone(), radius: TOXIC_RADIUS });
    if (this.hosting) ctx.net!.send({ t: 'ee', ev: 'toxic', id: e.id, p: tuple(_c, 2) }, 'others');
  }

  private toxicFx(p: THREE.Vector3): void {
    const ctx = this.ctx;
    _v.set(p.x, p.y + 0.6, p.z);
    this.fx?.burst(_v, 110, 'acid', 8);
    this.fx?.splat(p, TOXIC_RADIUS * 0.55, 'acid', ctx.world);
    const fx = FxManager.get();
    if (fx) { ParticleBurst.ichor(fx.additive, _v, _zero, 30, 0x9fe64a); ParticleBurst.smoke(fx.alpha, _v, 26, 2.4, 0x3d6a1a); }
    this.playAudio('acid_splash', p, 1, 0.55);
    const dl = this.targets.distToLocal(p);
    if (dl < 16) ctx.bus.emit('camera:shake', { intensity: 0.45 * (1 - dl / 16), duration: 0.3 });
  }

  playAudio(id: string, position: THREE.Vector3, volume = 1, pitch = 1): void {
    const now = this.ctx.time;
    const gap = id === 'bug_step' ? 0.05 : id === 'bug_hit' || id === 'hit_flesh' ? 0.04 : id === 'shot_rifle' ? 0.03 : 0.12;
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
      e.aware = false; e.airborne = false; e.chargePhase = 0; e.spitPhase = 0; e.roguePhase = 0; e.toxicPhase = 0;
      e.anim.shake = 0; e.anim.abdomen = 0; e.anim.crouch = 0;
    }
  }
}

// CORPSE_LIFETIME is applied per entity (`Enemy.corpseLife`); re-exported here for smoke scripts.
export { CORPSE_LIFETIME };
