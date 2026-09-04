import * as THREE from 'three';
import {
  MAP_SIZE, type EnemyHit, type EnemyManagerRef, type EnemyRef, type EnemyType, type GameContext, type GameSystem,
} from '@/shared';
import { Enemy, type EnemyHost, type HitPart } from './Enemy';
import { SPEWER_SPIT } from './EnemyTypes';
import { SpatialGrid } from './SpatialGrid';
import { updateEnemyAI } from './ai/EnemyAI';
import { becomeAlert } from './ai/Perception';
import { BloodFX } from './fx/BloodFX';
import { AcidProjectiles } from './fx/AcidProjectile';
import { AmbientSpawner, type SpawnHost } from './Spawner';
import { WaveDirector } from './WaveDirector';
import { disposeBugAssets } from './models/BugModel';

const DEATH_DURATION = 4;
const FLEE_DURATION = 2;
const CORPSE_SLACK = 10;      // corpses allowed above the alive cap before being recycled
const RECYCLE_DISTANCE = 160;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _hc = new THREE.Vector3();
const _n = new THREE.Vector3();

/**
 * Owns every bug: pooling, AI ticks, hit detection, spawning (ambient + extraction waves), gore FX.
 * Publishes itself as `ctx.enemies` (EnemyManagerRef).
 */
export class EnemySystem implements GameSystem, EnemyManagerRef, EnemyHost, SpawnHost {
  readonly name = 'enemies';
  ctx!: GameContext;
  readonly grid = new SpatialGrid<Enemy>(MAP_SIZE + 40, 8);

  private readonly active: Enemy[] = [];
  private readonly pools = new Map<EnemyType, Enemy[]>();
  private fx: BloodFX | null = null;
  private acid: AcidProjectiles | null = null;
  private readonly spawner = new AmbientSpawner();
  private readonly waves = new WaveDirector();
  private nextId = 1;
  private paused = false;
  private readonly unsub: Array<() => void> = [];
  private readonly lastAudio = new Map<string, number>();

  /* ── lifecycle ─────────────────────────────────────────────────────────── */
  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.enemies = this;
    this.fx = new BloodFX(ctx.scene);
    this.acid = new AcidProjectiles(ctx.scene, this.fx);

    const bus = ctx.bus;
    this.unsub.push(
      bus.on('world:ready', ({ playerSpawn }) => {
        this.reset();
        this.spawner.reset();
        if (ctx.world?.ready) this.spawner.initialPopulate(this, playerSpawn);
      }),
      bus.on('game:newMission', () => this.reset()),
      bus.on('game:abort', () => { this.reset(); this.disposePools(); }),
      bus.on('game:paused', ({ paused }) => { this.paused = paused; }),
      bus.on('weapon:fired', ({ origin }) => this.alertHearing(origin, 55)),
      bus.on('grenade:exploded', ({ position }) => this.alertHearing(position, 80)),
      bus.on('extraction:activated', ({ position }) => this.startExtractionWaves(position)),
      bus.on('extraction:liftoff', ({ position }) => {
        this.stopExtractionWaves();
        this.fleeFrom(position, 18);
      }),
    );
  }

  update(dt: number, ctx: GameContext): void {
    const world = ctx.world;
    if (!world || !world.ready || this.paused) return;
    const gameplay = ctx.isGameplayPhase();

    // spatial grid for neighbour queries
    const grid = this.grid;
    grid.clear();
    for (let i = 0; i < this.active.length; i++) {
      const e = this.active[i];
      if (e.state !== 'dead' && e.state !== 'flee') grid.insert(e);
    }

    if (gameplay) {
      for (let i = 0; i < this.active.length; i++) updateEnemyAI(this.active[i], dt, this);
      this.acid?.update(dt, ctx);
      this.spawner.update(dt, this);
      this.waves.update(dt, this);
    }

    // visuals always tick (frozen AI still renders idle motion), then despawn finished corpses / fled bugs
    for (let i = this.active.length - 1; i >= 0; i--) {
      const e = this.active[i];
      e.animate(dt);
      if ((e.state === 'dead' && e.deathTimer >= DEATH_DURATION) || (e.state === 'flee' && e.fleeTimer >= FLEE_DURATION)) this.despawn(e);
    }
    this.fx?.update(dt, world);
  }

  dispose(): void {
    for (const off of this.unsub) off();
    this.unsub.length = 0;
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

  applyExplosion(center: THREE.Vector3, radius: number, damage: number): number {
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
      e.takeDamage(dmg, undefined, undefined);
      const killed = e.hp <= 0;
      if (killed) kills++;
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

  reset(): void {
    for (let i = this.active.length - 1; i >= 0; i--) this.despawn(this.active[i]);
    this.active.length = 0;
    this.waves.reset();
    this.spawner.reset();
    this.fx?.clear();
    this.acid?.clear();
    this.lastAudio.clear();
  }

  /* ── SpawnHost ─────────────────────────────────────────────────────────── */
  aliveCount(): number {
    let n = 0;
    for (let i = 0; i < this.active.length; i++) { const e = this.active[i]; if (e.active && e.state !== 'dead' && e.state !== 'flee') n++; }
    return n;
  }

  ensureCapacity(n: number, cap: number): number {
    const player = this.ctx.player;
    // 1) recycle far, unseen, unaware bugs when the alive cap is tight
    let alive = this.aliveCount();
    if (alive + n > cap && player) {
      for (let i = this.active.length - 1; i >= 0 && alive + n > cap; i--) {
        const e = this.active[i];
        if (!e.active || e.state === 'dead' || e.aware || e.relentless) continue;
        const d = Math.hypot(e.position.x - player.position.x, e.position.z - player.position.z);
        if (d > RECYCLE_DISTANCE) { this.despawn(e); alive--; }
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
    if (!ctx.world?.ready) return null;
    let pool = this.pools.get(type);
    if (!pool) { pool = []; this.pools.set(type, pool); }
    let e = pool.pop();
    if (!e) {
      e = new Enemy(type);
      e.bindHost(this);
    }
    if (!e.rig.root.parent) ctx.scene.add(e.rig.root);
    e.reset(this.nextId++, position, yaw, ctx.time);
    e.relentless = relentless;
    if (chase) { e.aware = true; e.state = 'chase'; e.perceptionTimer = 0.3 + Math.random() * 0.3; }
    this.active.push(e);
    ctx.bus.emit('enemy:spawned', { id: e.id, type, position: e.position });
    return e;
  }

  private despawn(e: Enemy): void {
    const idx = this.active.indexOf(e);
    if (idx >= 0) {
      const last = this.active.length - 1;
      this.active[idx] = this.active[last];
      this.active.pop();
    }
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
    const r2 = radius * radius;
    for (let i = 0; i < this.active.length; i++) {
      const e = this.active[i];
      if (e === source || !e.active || e.state === 'dead' || e.aware) continue;
      const dx = e.position.x - position.x, dz = e.position.z - position.z;
      if (dx * dx + dz * dz <= r2) becomeAlert(e, this, false);
    }
  }

  private alertHearing(position: THREE.Vector3, radius: number): void {
    if (!this.ctx.isGameplayPhase()) return;
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

  fireAcid(from: THREE.Vector3, shooter: Enemy): void {
    this.acid?.fire(from, this.ctx, shooter.id);
  }

  hitPlayer(e: Enemy, damage: number, shake = 0): void {
    const ctx = this.ctx;
    const player = ctx.player;
    if (!player || player.isDead) return;
    player.takeDamage(damage, e.position);
    ctx.bus.emit('enemy:attacked', { id: e.id, type: e.type, damage, position: e.position });
    this.playAudio('bug_attack', e.position, 1, e.type === 'charger' ? 0.6 : e.type === 'warrior' ? 0.8 : 1.05);
    if (shake >= 0.4) ctx.bus.emit('camera:shake', { intensity: shake, duration: 0.3 });
  }

  onEnemyDamaged(e: Enemy, amount: number, part: HitPart, hitPoint: THREE.Vector3 | undefined, hitDir: THREE.Vector3 | undefined): void {
    const ctx = this.ctx;
    ctx.bus.emit('enemy:damaged', { id: e.id, type: e.type, amount, position: e.position, hp: e.hp });
    if (this.fx) {
      if (hitPoint) _v.copy(hitPoint); else _v.set(e.position.x, e.position.y + e.stats.height * 0.5, e.position.z);
      const count = part === 'head' ? 14 : 8;
      if (hitDir) { _v2.copy(hitDir); this.fx.burst(_v, count, 'blood', 4.5, _v2, 0.9); }
      else this.fx.burst(_v, count, 'blood', 4);
    }
    this.playAudio('bug_hit', e.position, 0.6, 0.9 + Math.random() * 0.2);
  }

  onEnemyKilled(e: Enemy, countKill: boolean): void {
    const ctx = this.ctx;
    if (countKill) {
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
  }

  private acidBurst(e: Enemy): void {
    const ctx = this.ctx;
    _v.set(e.position.x, e.position.y + 0.9, e.position.z);
    this.fx?.burst(_v, 90, 'acid', 7);
    this.fx?.splat(e.position, SPEWER_SPIT.deathBurstRadius * 0.6, 'acid', ctx.world);
    this.playAudio('acid_splash', e.position, 1, 0.7);
    const player = ctx.player;
    if (player && !player.isDead) {
      const d = player.position.distanceTo(e.position);
      if (d < SPEWER_SPIT.deathBurstRadius) {
        const dmg = SPEWER_SPIT.deathBurstDamage * (1 - d / SPEWER_SPIT.deathBurstRadius * 0.6);
        player.takeDamage(dmg, e.position);
        ctx.bus.emit('enemy:attacked', { id: e.id, type: e.type, damage: dmg, position: e.position });
        ctx.bus.emit('player:applySlow', { duration: 1.2, factor: 0.7 });
      }
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
