import * as THREE from 'three';
import type { PlanetId } from '@/shared';
import type { MissionMode, TrainingRef } from '@/shared';
import {
  FOG_REVEAL_RADIUS, MAP_SIZE, PROP_STEP_UP_MAX, PROP_TOP_MARGIN, Random, TRAINING_ARENA_SIZE, getPlanet, isPlanetId,
  type CrateDef, type ExtractionPointDef, type FogRef, type GameContext, type GameSystem, type GatherNodeDef,
  type Obstacle, type PlanetDef, type TerrainHit, type WorldRef,
  /* appended (2026-09-09): 레이드 플레이 개선 계약 */
  type StructureDef, type RailLineDef, type TramDef, type HazardRef,
} from '@/shared';
import { Ambience } from './Ambience';
import { BOX_HEADROOM, boxContainsXZ, boxHitNormal, boxPushOut, rayBox } from './obb';
import { Fog } from './Fog';
import { type Biome, biomeById, pickBiome } from './biomes';
import { type BuildCtx, PLAY_LIMIT } from './build';
import { Crates } from './Crates';
import { Gather } from './Gather';
import { Hazard } from './Hazard';
import { generateLayout, padClearance, type WorldLayout } from './layout';
import { Nests } from './Nests';
import { Noise } from './noise';
import { Outposts } from './Outposts';
import { PLATFORM_HEIGHT, PLATFORM_RADIUS, Pads } from './Pads';
import { Props } from './Props';
import { Rails } from './Rails';
import { Structures } from './Structures';
import { type ObstacleEntry, SpatialHash } from './SpatialHash';
import { HALF, Terrain } from './Terrain';
import { TrainingArena } from './TrainingArena';

const SOFT_WALL = HALF - 4;

/** Exact area shared by two circles (`obstacleCoverage`). 0 when they miss, the smaller disc when nested. */
function circleOverlap(d: number, r1: number, r2: number): number {
  if (r1 <= 0 || r2 <= 0) return 0;
  if (d >= r1 + r2) return 0;
  if (d <= Math.abs(r1 - r2)) { const r = Math.min(r1, r2); return Math.PI * r * r; }
  const s1 = r1 * r1, s2 = r2 * r2;
  const a1 = Math.acos(Math.min(1, Math.max(-1, (d * d + s1 - s2) / (2 * d * r1))));
  const a2 = Math.acos(Math.min(1, Math.max(-1, (d * d + s2 - s1) / (2 * d * r2))));
  return s1 * (a1 - Math.sin(2 * a1) / 2) + s2 * (a2 - Math.sin(2 * a2) / 2);
}

const NONE_CRATES: readonly CrateDef[] = [];
const NONE_VEC: readonly THREE.Vector3[] = [];
const NONE_GATHER: readonly GatherNodeDef[] = [];
/* appended (2026-09-09): 훈련장의 빈 답 */
const NONE_STRUCTURES: readonly StructureDef[] = [];
const NONE_RAILS: readonly RailLineDef[] = [];
const NONE_TRAMS: readonly TramDef[] = [];

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
  /**
   * Phase 11: 목표 행성 the current world was generated for, or null when it came from the seeded biome draw
   * (an older peer, `MissionComplete`'s 다시 배치 without one, a training). Echoed in `world:ready.planet` and
   * **kept through `clear()`** exactly like `mode`, so a late abort handler can still read it.
   */
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
  private readonly structures = new Structures();
  private readonly rails = new Rails();
  private readonly gather = new Gather();
  private readonly hazardSys = new Hazard();
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

  /**
   * 전장의 안개 (2026-09-09). 레이드에서만 만들어지고 훈련장에서는 null — 지도 · 월드 마커 · 나침반이
   * `isDiscovered` 로 게이트되므로 null 이면 예전처럼 전부 보인다.
   */
  private fogMask: Fog | null = null;

  // scratch
  private readonly queryOut: ObstacleEntry[] = [];
  private readonly surfaceOut: ObstacleEntry[] = [];
  private readonly coverOut: ObstacleEntry[] = [];
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
    this.structures.attach(ctx);
    this.rails.attach(ctx);
    this.unsubs.push(
      // `mode` / `planet` travel on the event; a rejoin without them falls back to `ctx.missionMode` / `ctx.missionPlanet`
      // (the emitter sets both before emitting, per the contract, because generation runs inside this emit)
      ctx.bus.on('game:newMission', ({ seed, mode, planet }) => this.generate(
        seed,
        mode ?? (ctx.missionMode === 'training' ? 'training' : 'raid'),
        planet ?? ctx.missionPlanet,
      )),
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
    this.structures.update(dt, t);
    this.rails.update(dt, t);
    this.gather.update(dt, t);
    this.hazardSys.update(dt, ctx);
    this.ambience.update(dt, ctx.camera);
    this.fogMask?.update(dt);
  }

  dispose(): void {
    this.clear();
    this.gather.detach();
    this.structures.detach();
    this.rails.detach();
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.root.removeFromParent();
    if (this.ctx && this.ctx.world === this) this.ctx.world = null;
  }

  /* ── generation ────────────────────────────────────────────────────── */

  /**
   * `planet` (Phase 11): the 목표 행성 whose biome / ecosystem this world uses. null (or an unknown id) keeps the
   * pre-Phase-11 behaviour — the biome is drawn from the seed and paired with the sky core draws for the same seed.
   */
  generate(seed: number, mode: MissionMode = 'raid', planet: PlanetId | null = null): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.generated) this.clear();
    if (mode === 'training') { this.generateTraining(seed); return; }
    const t0 = performance.now();

    this.mode = 'raid';
    this.seed = seed >>> 0;
    // an unknown id (older peer / hand-edited save) is reported as "no planet" so every reader agrees with core's fallback
    this.planet = isPlanetId(planet) ? planet : null;
    const def: PlanetDef | undefined = getPlanet(this.planet);
    const rng = new Random(this.seed);
    const noise = new Noise(rng.fork('terrain'));
    // 행성이 있으면 팔레트는 데이터로 정해진다; 없으면 시드 추첨 (core 의 하늘 추첨과 짝이 맞는 기존 동작)
    this.biome = biomeById(def?.biome) ?? pickBiome(this.seed);
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
    /* 2026-09-09 — 구조물 · 선로는 **소품 · 상자 앞**에 세운다: 벽 · 데크 · 컨테이너가 먼저 hash 에 들어가야
     * `isSpotFree` 가 그 자리를 피해 바위와 상자를 놓는다 (방 안에 바위가 서지 않는다). 부지 자체는 이미
     * `layout` 이 잡아 뒀고 `Terrain` 이 평탄화 · 지하실 굴착까지 끝냈다. */
    this.structures.build(bctx, ctx);
    this.rails.build(bctx, ctx);
    /* 2026-09-09 — 환경 재해도 **소품 · 상자 앞**이다: 거대 버섯 군락의 줄기가 먼저 hash 에 들어가야
     * `isSpotFree` 가 군락 한가운데를 피한다. 재해 종류 · 시작 시각은 미션 시드에서만 나오므로
     * 여기서 만들어도 클라이언트끼리 어긋나지 않는다. */
    this.hazardSys.build(bctx, ctx, def?.hazards ?? []);
    this.props.build(bctx);
    this.crates.build(bctx, ctx);
    this.gather.build(bctx, ctx, def?.eco ?? null, this.hazardSys.getGroveSpots());
    this.ambience.build(bctx);

    this.extractionPoints = this.layout.extraction.map((p, i) => ({
      id: `extract_${i}`,
      position: new THREE.Vector3(p.x, p.height + PLATFORM_HEIGHT, p.z),
      yaw: p.yaw,
    }));
    const sp = this.layout.spawn;
    this.spawnPos.set(sp.x, this.getHeightAt(sp.x, sp.z), sp.z);

    // 전장의 안개는 레이드에서만 — 스폰 주변은 미리 밝혀 둔다 (강하 지점은 분대가 이미 아는 자리다)
    this.fogMask = new Fog();
    this.fogMask.attach(ctx);
    this.fogMask.reveal(sp.x, sp.z, FOG_REVEAL_RADIUS);

    this.generated = true;
    this.ready = true;
    const ms = performance.now() - t0;
    console.info(`[World] seed ${this.seed} · planet ${def ? `${this.planet} (${def.name})` : '—'} · biome ${this.biome.id} (${this.biome.name}) · ${this.hash.getAll().length} obstacles · ${this.crates.getDefs().length} crates · ${this.gather.getNodes().length} herbs · ${this.structures.getDefs().length} structures · ${this.rails.getLines().length ? this.rails.getLines()[0].kind : 'no'} rail · hazard ${this.hazardSys.kind ?? '—'}${this.hazardSys.kind ? ` @ ${this.hazardSys.startsAt}s` : ''} · ${ms.toFixed(0)} ms`);
    ctx.bus.emit('world:ready', { seed: this.seed, playerSpawn: this.spawnPos.clone(), planet: this.planet });
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
    this.planet = null;              // the arena is not a place — no biome, no ecosystem, no sky palette
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
    ctx.bus.emit('world:ready', { seed: this.seed, playerSpawn: this.spawnPos.clone(), planet: null });
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
    this.fogMask?.dispose();
    this.fogMask = null;
    if (this.mode === 'training') {
      this.arena.dispose();
      this.hash.clear();
      this.extractionPoints = [];
      this.generated = false;
      this.setSpaceMode(false);
      return;
    }
    this.ambience.dispose();
    this.hazardSys.dispose();
    this.gather.dispose();
    this.rails.dispose();
    this.structures.dispose();
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

  /**
   * 2026-09-09 — **걸어 다닐 수 있는 표면**: 지형 높이와 그 자리 장애물 윗면 중 높은 쪽.
   * `feetY` 를 주면 그 발 높이에서 올라설 수 있는 윗면(`feetY + PROP_STEP_UP_MAX` 이하)만 본다 — 그보다
   * 높은 장애물은 벽으로 남아야 하므로 표면으로 세지 않는다. 안 주면 그 자리에서 제일 높은 윗면
   * (총알 · 낙하 판정).
   */
  getSurfaceY(x: number, z: number, feetY?: number): number {
    const ground = this.getHeightAt(x, z);
    if (!this.ready) return ground;
    const out = this.surfaceOut;
    out.length = 0;
    // radius 0: 그 점을 실제로 덮는 원기둥만 (`query` 는 `radius + o.radius` 로 판정한다)
    this.hash.query(x, z, 0, out);
    const ceiling = feetY === undefined ? Infinity : feetY + PROP_STEP_UP_MAX;
    let best = ground;
    for (let i = 0; i < out.length; i++) {
      const o = out[i];
      const top = o.position.y + o.height;
      if (top <= best || top > ceiling) continue;
      // 2026-09-09: 사각 콜라이더는 외접원이 아니라 **상자 단면**이 발판이다 (벽 모서리 바깥 허공에 서지 않게)
      if (o.box && !boxContainsXZ(o, x, z)) continue;
      best = top;
    }
    out.length = 0;
    return best;
  }

  /**
   * 지금 밟고 있는 장애물 (`PROP_TOP_MARGIN` 여유). 그 위에 서 있는 동안 `resolveCollision` 은 이 장애물을
   * 밀어내지 않는다 — 같은 여유를 쓰므로 두 판정이 어긋나 가장자리에서 튕겨 나가는 일이 없다.
   */
  getStandingObstacle(x: number, z: number, feetY: number): Obstacle | null {
    if (!this.ready) return null;
    const out = this.surfaceOut;
    out.length = 0;
    this.hash.query(x, z, 0, out);
    let best: Obstacle | null = null;
    let bestTop = -Infinity;
    for (let i = 0; i < out.length; i++) {
      const o = out[i];
      const top = o.position.y + o.height;
      if (feetY < top - PROP_TOP_MARGIN || feetY > top + PROP_TOP_MARGIN) continue;
      if (o.box && !boxContainsXZ(o, x, z)) continue;
      if (top <= bestTop) continue;
      bestTop = top;
      best = o;
    }
    out.length = 0;
    return best;
  }

  /**
   * 반경 `radius` 원 안을 장애물 단면이 차지하는 면적 비율. 원-원 교차 면적의 합이고 겹침은 보정하지
   * 않으므로 1 을 넘을 수 있다 — 대형 적 스폰 자리를 거르는 용도다 (`enemies/Spawner`).
   */
  obstacleCoverage(x: number, z: number, radius: number): number {
    if (!this.ready || radius <= 0) return 0;
    const out = this.coverOut;
    out.length = 0;
    this.hash.query(x, z, radius, out);
    let area = 0;
    for (let i = 0; i < out.length; i++) {
      const o = out[i];
      area += circleOverlap(Math.hypot(o.position.x - x, o.position.z - z), radius, o.radius);
    }
    out.length = 0;
    return area / (Math.PI * radius * radius);
  }

  /**
   * 서로 `minGap` 이상 떨어진 지점 `count` 개를 `center` 주위 `radius` 안에서 뽑는다 (구조 포드가 겹쳐
   * 떨어지지 않게). 1차 통과에서는 장애물 위를 피하고, 그래도 모자라면 간격만 지키는 2차 통과로 채운다 —
   * 두 통과 모두 같은 `Random` 을 쓰므로 `seed` 를 주면 결정적이다.
   */
  scatterPoints(center: THREE.Vector3, radius: number, count: number, minGap: number, seed?: number): THREE.Vector3[] {
    const out: THREE.Vector3[] = [];
    if (count <= 0 || radius <= 0) return out;
    const rng = new Random(seed === undefined ? (Math.random() * 0xffffffff) >>> 0 : seed >>> 0);
    const gap2 = minGap > 0 ? minGap * minGap : 0;
    const attempts = Math.max(24, count * 24);
    for (let pass = 0; pass < 2 && out.length < count; pass++) {
      for (let a = 0; a < attempts && out.length < count; a++) {
        const ang = rng.range(0, Math.PI * 2);
        const d = radius * Math.sqrt(rng.next());
        const x = center.x + Math.cos(ang) * d, z = center.z + Math.sin(ang) * d;
        if (!this.isInsideBounds(x, z)) continue;
        if (pass === 0 && this.hash.overlaps(x, z, 1.5)) continue;
        let clear = true;
        for (let i = 0; i < out.length; i++) {
          const dx = out[i].x - x, dz = out[i].z - z;
          if (dx * dx + dz * dz < gap2) { clear = false; break; }
        }
        if (!clear) continue;
        out.push(new THREE.Vector3(x, this.getHeightAt(x, z), z));
      }
    }
    return out;
  }

  /** 전장의 안개 (`FogRef`); 훈련장에서는 null. */
  get fog(): FogRef | null { return this.fogMask; }

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
      // 2026-09-09: 윗면에 서 있으면 밀어내지 않는다. 여유는 `getStandingObstacle` 과 같은 `PROP_TOP_MARGIN`
      // 이라 두 판정이 어긋나 가장자리에서 튕겨 나가지 않는다 (예전엔 0.05 로 훨씬 빡빡했다).
      if (position.y >= o.position.y + o.height - PROP_TOP_MARGIN) continue;   // above the obstacle
      if (o.box) {
        // 2026-09-09 — 사각 콜라이더. 상자는 **떠 있을 수 있어서**(지하실 천장 슬래브 · 전차 데크) 머리 위로
        // 지나가는 판은 밀어내지 않는다. 원기둥은 전부 땅에서 올라오므로 이 가지에 오지 않는다.
        if (position.y + BOX_HEADROOM <= o.position.y) continue;
        /* 2026-09-10 — **올라설 수 있는 단은 벽이 아니다.** 윗면이 발 높이에서 `PROP_STEP_UP_MAX` 안이면
         * `getSurfaceY(x, z, feetY)` 가 어차피 그 위로 발을 올려 준다 (움직이는 쪽의 규약: 표면 먼저,
         * 밀어내기 나중). 그런데도 여기서 밀어내면 **몸이 그 단 위로 올라갈 자리에 닿기 전에 밀려나** 영영
         * 못 올라간다 — 지하실 계단이 그 자리에서 걸렸다. 한 단의 디딤폭이 몸통 반지름보다 좁으면 서 있는
         * 단 바로 위의 단이 늘 몸에 겹치므로, 매 프레임 아래로 밀려 계단을 그대로 미끄러져 내려갔다.
         * 조건은 `getSurfaceY` 의 천장과 **같은 식**이라 두 판정이 어긋나지 않는다.
         * 상자에만 건다 — 원기둥 소품의 코드 경로는 2026-09-09 규약대로 한 줄도 바뀌지 않는다. */
        if (o.position.y + o.height <= position.y + PROP_STEP_UP_MAX) continue;
        boxPushOut(o, position, radius);
        continue;
      }
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
      const limit = bestT > 0 ? bestT : maxDist;
      // 2026-09-09: 사각 콜라이더는 슬래브 셋으로 맞힌다 (`obb.rayBox`), 원기둥은 예전 그대로.
      const t = o.box ? rayBox(ox, oy, oz, dx, dy, dz, o, limit) : this.rayCylinder(ox, oy, oz, dx, dy, dz, o, limit);
      if (t >= 0 && (bestT < 0 || t < bestT)) {
        bestT = t;
        bestObs = o;
        if (o.box) this.tmpN.set(boxHitNormal.x, boxHitNormal.y, boxHitNormal.z);
        else this.tmpN.set(this.hitNx, this.hitNy, this.hitNz);   // rayCylinder wrote hitN*
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

  /**
   * Ray vs the finite vertical cylinder an obstacle blocks shots with. Returns `t` or −1; writes the hit normal to
   * `hitN*`.
   *
   * 2026-09-08: two changes, both about 엄폐 that did not work.
   *  - It shoots at `shotRadius` / `shotHeight` when the prop declares them. The movement cylinder is deliberately
   *    narrower than a lumpy rock so nobody walks into an invisible wall — which also let bullets through the
   *    visible sides of a boulder — and, for a boulder, ~0.4 s **taller** than the rock, which stopped bullets in
   *    plain air above it. `src/world/Props.ts` measures the real silhouette and passes it in.
   *  - The slab clip is complete. It used to test only the entry point of the infinite cylinder and, failing that,
   *    the top cap, so a ray that entered the footprint below the base and crossed the body further along (shooting
   *    uphill at a rock on a rise) reported a miss.
   */
  private rayCylinder(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, o: Obstacle, maxT: number): number {
    const r = o.shotRadius !== undefined && o.shotRadius > 0 ? o.shotRadius : o.radius;
    const height = o.shotHeight !== undefined && o.shotHeight > 0 ? o.shotHeight : o.height;
    const cx = o.position.x, cz = o.position.z, base = o.position.y - 0.5, top = o.position.y + height;
    if (top <= base) return -1;
    const fx = ox - cx, fz = oz - cz;
    const a = dx * dx + dz * dz;
    const c = fx * fx + fz * fz - r * r;
    // horizontal span of the infinite cylinder
    let t0: number, t1: number;
    if (a < 1e-8) {
      if (c > 0) return -1;              // vertical ray outside the footprint
      t0 = -Infinity; t1 = Infinity;
    } else {
      const b = 2 * (fx * dx + fz * dz);
      const disc = b * b - 4 * a * c;
      if (disc < 0) return -1;
      const sq = Math.sqrt(disc);
      t0 = (-b - sq) / (2 * a); t1 = (-b + sq) / (2 * a);
    }
    // vertical span of the slab
    let ty0: number, ty1: number;
    if (Math.abs(dy) < 1e-8) {
      if (oy < base || oy > top) return -1;
      ty0 = -Infinity; ty1 = Infinity;
    } else {
      ty0 = (base - oy) / dy; ty1 = (top - oy) / dy;
      if (ty0 > ty1) { const t = ty0; ty0 = ty1; ty1 = t; }
    }
    const enter = Math.max(t0, ty0);
    const exit = Math.min(t1, ty1);
    // `enter < 0` = the origin is already inside the prop: a muzzle buried in a rock does not hit its own shell
    if (enter > exit || enter < 0 || enter > maxT) return -1;
    if (t0 >= ty0) {
      // entered through the side
      const px = ox + dx * enter - cx, pz = oz + dz * enter - cz;
      const inv = 1 / (r || 1);
      this.hitNx = px * inv; this.hitNy = 0; this.hitNz = pz * inv;
    } else {
      this.hitNx = 0; this.hitNy = dy < 0 ? 1 : -1; this.hitNz = 0;
    }
    return enter;
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

  /* ── appended (2026-09-09): 레이드 플레이 개선 ── */
  /** 버려진 구조물 (전진기지 · 연구실 · 불시착 함선). 훈련장은 빈 배열. */
  getStructures(): readonly StructureDef[] { return this.mode === 'training' ? NONE_STRUCTURES : this.structures.getDefs(); }
  /** `(x, z)` 를 품는 구조물, 없으면 null. */
  structureAt(x: number, z: number): StructureDef | null {
    return this.mode === 'training' ? null : this.structures.structureAt(x, z);
  }
  /** 선로 (구역마다 있을 수도, 없을 수도 있다). */
  getRailLines(): readonly RailLineDef[] { return this.mode === 'training' ? NONE_RAILS : this.rails.getLines(); }
  /** 선로 위의 전차. */
  getTrams(): readonly TramDef[] { return this.mode === 'training' ? NONE_TRAMS : this.rails.getTrams(); }
  /** 이번 레이드의 환경 재해. 후보가 없는 행성 · 훈련장이면 null. */
  get hazard(): HazardRef | null { return this.mode === 'training' ? null : this.hazardSys.ref; }

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
