import * as THREE from 'three';
import type { PlanetId } from '@/shared';
import type { MissionMode, TrainingRef } from '@/shared';
import {
  MAP_SIZE, Random, TRAINING_ARENA_SIZE,
  type CrateDef, type ExtractionPointDef, type GameContext, type GameSystem, type GatherNodeDef,
  type Obstacle, type TerrainHit, type WorldRef,
} from '@/shared';
import { Ambience } from './Ambience';
import { type Biome, pickBiome } from './biomes';
import { type BuildCtx, PLAY_LIMIT } from './build';
import { Crates } from './Crates';
import { Gather } from './Gather';
import { generateLayout, padClearance, type WorldLayout } from './layout';
import { Nests } from './Nests';
import { Noise } from './noise';
import { Outposts } from './Outposts';
import { PLATFORM_HEIGHT, PLATFORM_RADIUS, Pads } from './Pads';
import { Props } from './Props';
import { type ObstacleEntry, SpatialHash } from './SpatialHash';
import { HALF, Terrain } from './Terrain';
import { TrainingArena } from './TrainingArena';

const SOFT_WALL = HALF - 4;
const NONE_CRATES: readonly CrateDef[] = [];
const NONE_VEC: readonly THREE.Vector3[] = [];
const NONE_GATHER: readonly GatherNodeDef[] = [];

/**
 * Owns the procedural planet surface: terrain, props/obstacles, nests, pads, outposts, crates, ambience.
 * Generates synchronously on `game:newMission`, tears down on `game:abort`.
 * Phase 7: `game:newMission {mode:'training'}` builds the 시뮬레이션 훈련장 (`TrainingArena`) instead — a flat walled
 * arena with pop-up targets, no crates / nests / gather / extraction; every query below branches on `mode`.
 */
export class WorldSystem implements GameSystem, WorldRef {
  readonly name = 'world';
  /** Map side: `MAP_SIZE` for the planet, `TRAINING_ARENA_SIZE` for the arena (map screen / ping clamps read it). */
  get size(): number { return this.mode === 'training' ? TRAINING_ARENA_SIZE : MAP_SIZE; }
  /** Mode of the last generated world (`'raid'` until a training was built; kept through `clear()`). */
  mode: MissionMode = 'raid';
  /* Phase 11 skeleton — replace: set from `game:newMission.planet` in `generate()` and echo it in `world:ready`. */
  planet: PlanetId | null = null;
  seed = 0;
  ready = false;

  private ctx: GameContext | null = null;
  private readonly root = new THREE.Group();
  private readonly terrain = new Terrain();
  private readonly props = new Props();
  private readonly nests = new Nests();
  private readonly pads = new Pads();
  private readonly outposts = new Outposts();
  private readonly crates = new Crates();
  private readonly gather = new Gather();
  private readonly ambience = new Ambience();
  private readonly arena = new TrainingArena();
  private readonly hash = new SpatialHash(16);
  private layout: WorldLayout | null = null;
  private biome: Biome | null = null;
  private extractionPoints: ExtractionPointDef[] = [];
  private spawnPos = new THREE.Vector3();
  private spawnRng = new Random(1);
  private generated = false;
  private unsubs: (() => void)[] = [];

  // scratch
  private readonly queryOut: ObstacleEntry[] = [];
  private readonly tmpN = new THREE.Vector3();
  private readonly heightFn = (x: number, z: number) => this.getHeightAt(x, z);
  private hitNx = 0; private hitNy = 1; private hitNz = 0;
  private readonly shellN = new THREE.Vector3(0, 1, 0);

  constructor() { this.root.name = 'World'; }

  /* ── lifecycle ─────────────────────────────────────────────────────── */

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.world = this;
    ctx.scene.add(this.root);
    this.gather.attach(ctx);
    this.unsubs.push(
      // `mode` travels on the event; a rejoin without it falls back to `ctx.missionMode` (set by the emitter beforehand)
      ctx.bus.on('game:newMission', ({ seed, mode }) => this.generate(seed, mode ?? (ctx.missionMode === 'training' ? 'training' : 'raid'))),
      ctx.bus.on('game:abort', () => {
        this.clear();
        ctx.bus.emit('world:cleared', {});
      }),
    );
  }

  update(dt: number, ctx: GameContext): void {
    if (!this.ready) return;
    const t = ctx.time;
    if (this.mode === 'training') { this.arena.update(dt, t); return; }
    this.props.update(t);
    this.nests.update(t);
    this.pads.update(t);
    this.outposts.update(t);
    this.crates.update(dt, t);
    this.gather.update(dt, t);
    this.ambience.update(dt, ctx.camera);
  }

  dispose(): void {
    this.clear();
    this.gather.detach();
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.root.removeFromParent();
    if (this.ctx && this.ctx.world === this) this.ctx.world = null;
  }

  /* ── generation ────────────────────────────────────────────────────── */

  generate(seed: number, mode: MissionMode = 'raid'): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.generated) this.clear();
    if (mode === 'training') { this.generateTraining(seed); return; }
    const t0 = performance.now();

    this.mode = 'raid';
    this.seed = seed >>> 0;
    const rng = new Random(this.seed);
    const noise = new Noise(rng.fork('terrain'));
    this.biome = pickBiome(this.seed);   // paired with the sky palette core picks for the same seed
    this.layout = generateLayout(rng.fork('layout'));
    this.spawnRng = rng.fork('spawns');

    this.terrain.build(this.layout, this.biome, noise, rng.fork('terrainMesh'));
    this.root.add(this.terrain.group);

    const bctx: BuildCtx = {
      rng, noise, biome: this.biome, layout: this.layout, terrain: this.terrain, hash: this.hash, root: this.root,
    };
    this.nests.build(bctx);
    this.pads.build(bctx);
    this.outposts.build(bctx);
    this.props.build(bctx);
    this.crates.build(bctx, ctx);
    this.gather.build(bctx, ctx);
    this.ambience.build(bctx);

    this.extractionPoints = this.layout.extraction.map((p, i) => ({
      id: `extract_${i}`,
      position: new THREE.Vector3(p.x, p.height + PLATFORM_HEIGHT, p.z),
      yaw: p.yaw,
    }));
    const sp = this.layout.spawn;
    this.spawnPos.set(sp.x, this.getHeightAt(sp.x, sp.z), sp.z);

    this.generated = true;
    this.ready = true;
    const ms = performance.now() - t0;
    console.info(`[World] seed ${this.seed} · biome ${this.biome.id} (${this.biome.name}) · ${this.hash.getAll().length} obstacles · ${this.crates.getDefs().length} crates · ${ms.toFixed(0)} ms`);
    ctx.bus.emit('world:ready', { seed: this.seed, playerSpawn: this.spawnPos.clone() });
  }

  /**
   * 시뮬레이션 훈련장: flat arena, three lanes of pop-up targets, exit console. No terrain / props / crates / nests /
   * gather / ambience; `world:ready` fires like the planet's. The atmosphere is switched to its space mode right after
   * `world:ready` (Engine's handler re-applied the planet palette inside the emit) so the arena reads as an interior lit
   * by its own emissive strips; `clear()` switches it back.
   */
  private generateTraining(seed: number): void {
    const ctx = this.ctx!;
    const t0 = performance.now();
    this.mode = 'training';
    this.seed = seed >>> 0;
    const rng = new Random(this.seed);
    this.layout = null;
    this.biome = null;
    this.spawnRng = rng.fork('spawns');
    this.arena.build(ctx, rng, this.root, this.hash);
    this.extractionPoints = [];
    this.spawnPos.copy(this.arena.spawn);
    this.generated = true;
    this.ready = true;
    const ms = performance.now() - t0;
    console.info(`[World] training arena · seed ${this.seed} · ${this.arena.targetCount} targets · ${this.hash.getAll().length} obstacles · ${ms.toFixed(0)} ms`);
    ctx.bus.emit('world:ready', { seed: this.seed, playerSpawn: this.spawnPos.clone() });
    this.setSpaceMode(true);
    this.arena.announce();
  }

  /** Debug / smoke: the arena (targets, counters) while a training world is up. */
  get trainingArena(): TrainingArena | null { return this.mode === 'training' && this.ready ? this.arena : null; }
  /** `ctx.world.training` (Phase 9): the arena implements `TrainingRef` (modes / score / timed course); null outside a training world. */
  get training(): TrainingRef | null { return this.trainingArena; }

  private setSpaceMode(on: boolean): void {
    const atmo = this.ctx?.scene.userData.atmosphere as { setSpaceMode?: (on: boolean) => void } | undefined;
    atmo?.setSpaceMode?.(on);
  }

  clear(): void {
    if (!this.generated) return;
    this.ready = false;
    if (this.mode === 'training') {
      this.arena.dispose();
      this.hash.clear();
      this.extractionPoints = [];
      this.generated = false;
      this.setSpaceMode(false);
      return;
    }
    this.ambience.dispose();
    this.gather.dispose();
    this.crates.dispose();
    this.props.dispose();
    this.outposts.dispose();
    this.pads.dispose();
    this.nests.dispose();
    this.terrain.dispose();
    this.root.remove(this.terrain.group);
    this.hash.clear();
    this.extractionPoints = [];
    this.layout = null;
    this.biome = null;
    this.generated = false;
  }

  /** Current biome (null before generation). */
  getBiome(): Biome | null { return this.biome; }

  /* ── WorldRef: terrain queries ─────────────────────────────────────── */

  getHeightAt(x: number, z: number): number {
    if (this.mode === 'training') return 0;
    let h = this.terrain.getHeightAt(x, z);
    const layout = this.layout;
    if (layout) {
      const ex = layout.extraction;
      const R = PLATFORM_RADIUS, R1 = R + 1.0;
      for (let i = 0; i < ex.length; i++) {
        const p = ex[i];
        const dx = x - p.x, dz = z - p.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > R1 * R1) continue;
        const top = p.height + PLATFORM_HEIGHT;
        const d = Math.sqrt(d2);
        const t = d <= R ? 1 : 1 - (d - R) / (R1 - R);
        const ph = top * t + h * (1 - t);
        if (ph > h) h = ph;
      }
    }
    return h;
  }

  getNormalAt(x: number, z: number, out: THREE.Vector3 = new THREE.Vector3()): THREE.Vector3 {
    if (this.mode === 'training') return out.set(0, 1, 0);
    const e = 0.6;
    const hl = this.getHeightAt(x - e, z), hr = this.getHeightAt(x + e, z);
    const hd = this.getHeightAt(x, z - e), hu = this.getHeightAt(x, z + e);
    out.set((hl - hr) / (2 * e), 1, (hd - hu) / (2 * e));
    return out.normalize();
  }

  isInsideBounds(x: number, z: number): boolean {
    if (this.mode === 'training') return this.arena.isInside(x, z);
    return Math.abs(x) <= HALF && Math.abs(z) <= HALF;
  }

  /* ── WorldRef: collision ───────────────────────────────────────────── */

  resolveCollision(position: THREE.Vector3, radius: number): THREE.Vector3 {
    const out = this.queryOut;
    out.length = 0;
    this.hash.query(position.x, position.z, radius, out);
    for (let i = 0; i < out.length; i++) {
      const o = out[i];
      if (position.y > o.position.y + o.height - 0.05) continue;   // above the obstacle
      let dx = position.x - o.position.x, dz = position.z - o.position.z;
      let d = Math.sqrt(dx * dx + dz * dz);
      const min = radius + o.radius;
      if (d >= min) continue;
      if (d < 1e-4) { dx = 1; dz = 0; d = 1; }
      const push = min - d;
      position.x += (dx / d) * push;
      position.z += (dz / d) * push;
    }
    if (this.mode === 'training') { this.arena.clampInside(position, radius); out.length = 0; return position; }
    // soft map wall
    const limit = SOFT_WALL - radius;
    if (position.x > limit) position.x = limit + (position.x - limit) * 0.2;
    else if (position.x < -limit) position.x = -limit + (position.x + limit) * 0.2;
    if (position.z > limit) position.z = limit + (position.z - limit) * 0.2;
    else if (position.z < -limit) position.z = -limit + (position.z + limit) * 0.2;
    out.length = 0;
    return position;
  }

  /* ── WorldRef: raycast ─────────────────────────────────────────────── */

  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): TerrainHit | null {
    const ox = origin.x, oy = origin.y, oz = origin.z;
    let dx = dir.x, dy = dir.y, dz = dir.z;
    const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dl < 1e-8) return null;
    dx /= dl; dy /= dl; dz /= dl;

    const training = this.mode === 'training';
    let bestT = training
      ? this.arena.raycastShell(ox, oy, oz, dx, dy, dz, maxDist, this.shellN)
      : this.terrain.raycast(ox, oy, oz, dx, dy, dz, maxDist, this.heightFn);
    let bestObs: ObstacleEntry | null = null;
    const limitT = bestT > 0 ? bestT : maxDist;

    // obstacles along the segment
    const ex = ox + dx * limitT, ez = oz + dz * limitT;
    this.hash.walkSegment(ox, oz, ex, ez, this.hash.maxRadius, (o) => {
      const t = this.rayCylinder(ox, oy, oz, dx, dy, dz, o, bestT > 0 ? bestT : maxDist);
      if (t >= 0 && (bestT < 0 || t < bestT)) {
        bestT = t;
        bestObs = o;
        // capture normal computed by rayCylinder (stored in hitN*)
        this.tmpN.set(this.hitNx, this.hitNy, this.hitNz);
      }
      return false;
    });

    if (bestT < 0) return null;
    const point = new THREE.Vector3(ox + dx * bestT, oy + dy * bestT, oz + dz * bestT);
    const normal = bestObs ? this.tmpN.clone() : training ? this.shellN.clone() : this.getNormalAt(point.x, point.z, new THREE.Vector3());
    const hit: TerrainHit = { point, normal, distance: bestT };
    if (bestObs) hit.obstacle = bestObs as Obstacle;
    return hit;
  }

  /** Ray vs finite vertical cylinder (side + top cap). Returns t or -1; writes hit normal to hitN*. */
  private rayCylinder(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, o: Obstacle, maxT: number): number {
    const cx = o.position.x, cz = o.position.z, base = o.position.y - 0.5, top = o.position.y + o.height;
    const r = o.radius;
    const fx = ox - cx, fz = oz - cz;
    const a = dx * dx + dz * dz;
    const b = 2 * (fx * dx + fz * dz);
    const c = fx * fx + fz * fz - r * r;
    if (a < 1e-8) {
      // vertical ray
      if (c > 0) return -1;
      if (oy > top && dy < 0) {
        const t = (top - oy) / dy;
        if (t <= maxT) { this.hitNx = 0; this.hitNy = 1; this.hitNz = 0; return t; }
      }
      return -1;
    }
    const disc = b * b - 4 * a * c;
    if (disc < 0) return -1;
    const sq = Math.sqrt(disc);
    const t0 = (-b - sq) / (2 * a), t1 = (-b + sq) / (2 * a);
    if (t1 < 0 || t0 > maxT) return -1;
    if (t0 >= 0) {
      const y = oy + dy * t0;
      if (y >= base && y <= top) {
        const px = ox + dx * t0 - cx, pz = oz + dz * t0 - cz;
        const inv = 1 / (r || 1);
        this.hitNx = px * inv; this.hitNy = 0; this.hitNz = pz * inv;
        return t0;
      }
      if (y > top && dy < 0) {
        const tc = (top - oy) / dy;
        if (tc >= t0 && tc <= t1 && tc <= maxT) { this.hitNx = 0; this.hitNy = 1; this.hitNz = 0; return tc; }
      }
      return -1;
    }
    // origin inside the infinite cylinder footprint
    if (oy > top && dy < 0) {
      const tc = (top - oy) / dy;
      if (tc <= t1 && tc <= maxT) { this.hitNx = 0; this.hitNy = 1; this.hitNz = 0; return tc; }
    }
    return -1;
  }

  /* ── WorldRef: data ────────────────────────────────────────────────── */

  getObstacles(): readonly Obstacle[] { return this.hash.getAll(); }

  /** Phase 3: runtime obstacle (dropped cover / supply crate). Lives in the same hash as the props; `clear()` drops it with the world. */
  addObstacle(obstacle: Obstacle): () => void {
    const entry = { position: obstacle.position, radius: obstacle.radius, height: obstacle.height, stamp: 0, kind: 'dynamic', destructible: obstacle.destructible } as Obstacle & { stamp: number; kind: string };
    this.hash.insert(entry);
    let removed = false;
    return () => { if (removed) return; removed = true; this.hash.remove(entry); };
  }

  getObstaclesNear(x: number, z: number, radius: number): Obstacle[] {
    return this.hash.query(x, z, radius, []);
  }

  getPlayerSpawn(): THREE.Vector3 { return this.spawnPos.clone(); }

  getExtractionPoints(): readonly ExtractionPointDef[] { return this.extractionPoints; }

  getCrates(): readonly CrateDef[] { return this.mode === 'training' ? NONE_CRATES : this.crates.getDefs(); }

  getNestPositions(): readonly THREE.Vector3[] { return this.mode === 'training' ? NONE_VEC : this.nests.getHolePositions(); }

  /** Harvestable plants (consumed nodes stay in the list with `harvested: true`). */
  getGatherNodes(): readonly GatherNodeDef[] { return this.mode === 'training' ? NONE_GATHER : this.gather.getNodes(); }

  getEnemySpawnPoints(around: THREE.Vector3, count: number, minDist: number, maxDist: number): THREE.Vector3[] {
    const result: THREE.Vector3[] = [];
    if (!this.ready || !this.layout) return result;
    const rng = this.spawnRng;
    const attempts = Math.max(20, count * 14);
    const preferMin = Math.max(minDist, 25);
    for (let a = 0; a < attempts && result.length < count; a++) {
      // prefer far positions during the first two-thirds of the attempts
      const lo = a < attempts * 0.66 ? Math.min(preferMin, maxDist) : minDist;
      const ang = rng.range(0, Math.PI * 2);
      const d = rng.range(lo, Math.max(lo, maxDist));
      const x = around.x + Math.cos(ang) * d, z = around.z + Math.sin(ang) * d;
      if (Math.abs(x) > PLAY_LIMIT || Math.abs(z) > PLAY_LIMIT) continue;
      if (this.terrain.getSlopeAt(x, z) > 0.45) continue;
      if (padClearance(this.layout, x, z, 2) < 0) continue;
      if (this.hash.overlaps(x, z, 1.0)) continue;
      result.push(new THREE.Vector3(x, this.getHeightAt(x, z), z));
    }
    return result;
  }
}
