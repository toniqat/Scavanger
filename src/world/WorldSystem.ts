import * as THREE from 'three';
import type { PlanetId } from '@/shared';
import type { MissionMode, TrainingRef, TutorialWorldRef } from '@/shared';
import { CRATE_OPEN_RANGE_SLACK, PLAYER_INTERACT_RANGE, STRUCTURE_INTERACT_RANGE } from '@/shared';
import {
  FOG_REVEAL_RADIUS, MAP_SIZE, PROP_STEP_UP_MAX, PROP_TOP_MARGIN, Random, TRAINING_ARENA_SIZE, getPlanet, isPlanetId,
  type CrateDef, type ExtractionPointDef, type FogRef, type GameContext, type GameSystem, type GatherNodeDef,
  type Obstacle, type PlanetDef, type TerrainHit, type WorldRef,
  /* appended (2026-09-09): the raid play improvement contract */
  type StructureDef, type RailLineDef, type TramDef, type HazardRef,
  /* appended (2026-09-11) */
  type LadderDef, type PeerId,
  /* appended (2026-09-14): the intel broker's map preview */
  type IntelEffects, type MapPreviewLayout,
  /* appended (2026-09-11, C-22) */
  type SurfaceMaterial,
  /* appended (2026-09-11, A-13): the planet's permanent environment */
  type EnvKind,
  /* appended (2026-09-13): site spawn spots */
  type RuinSiteDef, type SiteSpawnPlace,
  /* appended (2026-09-13): the rover */
  type RoverRef,
  /* appended (2026-09-15): android squadmates — the loot container list */
  type LootContainerInfo,
  /* appended (2026-09-18): bug nest egg spots */
  type NestEggSpot,
} from '@/shared';
import { Rover } from './rover/Rover';
import { RoverRoad } from './rover/RoverRoad';
/* 2026-09-15 (the sandworm eruption judgement): `WorldRef.burrowGroundOk`'s rules live in this one file */
import { burrowGroundOk, type BurrowGroundQuery } from './BurrowGround';
import { SiteSpawns } from './SiteSpawns';
import { obstacleMaterial, onOutpostSlab, terrainMaterial } from './surface';
import { Ambience } from './Ambience';
import { BOX_HEADROOM, boxContainsXZ, boxHitNormal, boxPushOut, rampTopAt, rayBox, rayRamp } from './obb';
import { hullAreaCentroid, hullContainsXZ, hullHitNormal, hullPushOut, rayHull } from './hull';
import { GLASS_OBSTACLE_KIND, SMALL_BODY_R } from './structures/parts/Glass';
import { rollCrateContents } from './structures/parts/Containers';
import type { ItemInstance } from '@/shared';
import { Fog } from './Fog';
import type { Biome } from './biomes';
import { type BuildCtx, PLAY_LIMIT } from './build';
import { Crates } from './Crates';
import { Gather } from './Gather';
import { Hazard } from './Hazard';
import { padClearance, type WorldLayout } from './layout';
/* 2026-09-14 (the intel broker): planning the layout · previewing it are one function (`WorldRef.previewLayout`). */
import { planLayoutFor, previewLayoutFor } from './preview';
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
/* 2026-09-14 (the tutorial rework): the hand-built tutorial planet — the same slot · the same wiring as the training range. */
import { TutorialWorld } from './tutorial/TutorialWorld';

const SOFT_WALL = HALF - 4;

/** 2026-09-15: the entry `getLootContainers()` reuses (the contract's `LootContainerInfo` is read-only, so only the inner type is writable). */
type LootContainerEntry = { -readonly [K in keyof LootContainerInfo]: LootContainerInfo[K] };

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
/* appended (2026-09-09): the training range's empty answers */
const NONE_STRUCTURES: readonly StructureDef[] = [];
const NONE_RAILS: readonly RailLineDef[] = [];
const NONE_TRAMS: readonly TramDef[] = [];
const NONE_LADDERS: readonly LadderDef[] = [];
/* appended (2026-09-13) */
const NONE_RUINS: readonly RuinSiteDef[] = [];
/* appended (2026-09-18): bug egg spots — the training range's · tutorial's empty answer */
const NONE_EGGS: readonly NestEggSpot[] = [];

/**
 * Owns the procedural planet surface: terrain, props/obstacles, nests, pads, outposts, crates, ambience.
 * Generates synchronously on `game:newMission`, tears down on `game:abort`.
 * Phase 7: `game:newMission {mode:'training'}` builds the simulation training range (`TrainingArena`) instead — a flat open-top
 * arena (invisible walls, no ceiling since 2026-09-15) with pop-up targets, no crates / nests / gather / extraction; every query below branches on `mode`.
 */
export class WorldSystem implements GameSystem, WorldRef {
  readonly name = 'world';
  /** Map side: `MAP_SIZE` for the planet, `TRAINING_ARENA_SIZE` for the arena, the corridor's own for the tutorial. */
  get size(): number {
    return this.mode === 'training' ? TRAINING_ARENA_SIZE : this.mode === 'tutorial' ? this.tutorialWorld.size : MAP_SIZE;
  }
  /** Mode of the last generated world (`'raid'` until a training / tutorial was built; kept through `clear()`). */
  mode: MissionMode = 'raid';
  /** 2026-09-14: is the current world a planet (procedural)? The training range · tutorial have no crates · nests · gather · rails · hazard at all. */
  private get isPlanet(): boolean { return this.mode === 'raid'; }
  /**
   * Phase 11: the target planet the current world was generated for, or null when it came from the seeded biome draw
   * (an older peer, a `game:newMission` without one, a training). Echoed in `world:ready.planet` and
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
  /** 2026-09-13: the rover — the route · dirt road · stations (R1) and the vehicle itself (R2). */
  private readonly roverRoad = new RoverRoad();
  private readonly roverSys = new Rover();
  private readonly gather = new Gather();
  private readonly hazardSys = new Hazard();
  private readonly ambience = new Ambience();
  private readonly arena = new TrainingArena();
  /** 2026-09-14: the tutorial planet (`world/tutorial/`) — built only while `mode === 'tutorial'`. */
  private readonly tutorialWorld = new TutorialWorld();
  private readonly hash = new SpatialHash(16);
  private layout: WorldLayout | null = null;
  private biome: Biome | null = null;
  /** 2026-09-11 (C-22): the same noise as the terrain colour pass — so the material underfoot changes where the visible patches do. */
  private noise: Noise | null = null;
  private extractionPoints: ExtractionPointDef[] = [];
  private spawnPos = new THREE.Vector3();
  private spawnRng = new Random(1);
  private generated = false;
  private unsubs: (() => void)[] = [];

  /**
   * Fog of war (2026-09-09). Built in a raid only and null in the training range — the map · world markers · compass
   * are gated on `isDiscovered`, so with null everything is visible exactly as it used to be.
   */
  private fogMask: Fog | null = null;

  /**
   * 2026-09-13: site spawn spots (`getSiteSpawnPoints`) — a structure's indoor candidates are computed once, the first
   * time that site is asked, and held for the whole raid (`clear()` empties it). No world generation rng is spent.
   */
  private readonly siteSpawns = new SiteSpawns({
    getHeightAt: (x, z) => this.getHeightAt(x, z),
    getSurfaceY: (x, z, feetY) => this.getSurfaceY(x, z, feetY),
    resolveCollision: (p, r) => this.resolveCollision(p, r),
    raycast: (o, d, m) => this.raycast(o, d, m),
    structureAt: (x, z) => this.structures.structureAt(x, z),
    slopeAt: (x, z) => this.terrain.getSlopeAt(x, z),
    layout: () => this.layout,
    hash: () => this.hash,
    structureDefs: () => this.structures.getDefs(),
    structureNav: (id) => this.structures.navOf(id),
    platforms: () => this.rails.getLines()[0]?.platforms ?? [],
    ruins: () => this.outposts.getSites(),
  });

  /**
   * 2026-09-11 (C-40): the last planet generation's cost per step (ms) — `layout` · `terrain` (+ `terrain.*` detail) ·
   * `structures` · `rails` · `hazard` · `props` (+ `props.*`) · `crates` · `gather` · `total`. For debugging and
   * measurement, not a contract.
   */
  readonly genTimings: Record<string, number> = {};

  // scratch
  private readonly queryOut: ObstacleEntry[] = [];
  private readonly surfaceOut: ObstacleEntry[] = [];
  private readonly coverOut: ObstacleEntry[] = [];
  private readonly tmpN = new THREE.Vector3();
  private readonly heightFn = (x: number, z: number) => this.getHeightAt(x, z);
  private hitNx = 0; private hitNy = 1; private hitNz = 0;
  private readonly shellN = new THREE.Vector3(0, 1, 0);
  private readonly hullN = { x: 0, y: 1, z: 0 };
  private readonly hullAC = { area: 0, x: 0, z: 0 };
  /* 2026-09-11: syncing the **opened look** of crates · containers (`crate opened / sync / syncq`) */
  private readonly openedIds = new Set<string>();
  private openNetHooked = false;
  /** 2026-09-11 (C-57): `crate opened` refused (unknown id / sender too far) — debug · smoke-trust. */
  openRefused = 0;
  private readonly eyeTmp = new THREE.Vector3();

  constructor() { this.root.name = 'World'; }

  /* ── lifecycle ─────────────────────────────────────────────────────── */

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.world = this;
    ctx.scene.add(this.root);
    this.gather.attach(ctx);
    this.structures.attach(ctx);
    this.rails.attach(ctx);
    this.roverSys.attach(ctx);
    this.ensureOpenNet();
    this.unsubs.push(
      // `mode` / `planet` travel on the event; a rejoin without them falls back to `ctx.missionMode` / `ctx.missionPlanet`
      // (the emitter sets both before emitting, per the contract, because generation runs inside this emit)
      ctx.bus.on('game:newMission', ({ seed, mode, planet }) => this.generate(
        seed,
        // 2026-09-14: there are three modes now — with none on the event, `ctx.missionMode` is used as it is (set before the emit, per the contract)
        mode ?? ctx.missionMode,
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
    if (this.mode === 'tutorial') { this.tutorialWorld.update(dt); return; }
    this.props.update(t);
    this.nests.update(t);
    this.pads.update(t);
    this.outposts.update(t);
    this.crates.update(dt, t);
    this.structures.update(dt, t, this.eyeFor(ctx));
    this.rails.update(dt, t);
    this.roverSys.update(dt, t);
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
    this.roverSys.detach();
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.root.removeFromParent();
    if (this.ctx && this.ctx.world === this) this.ctx.world = null;
  }

  /* ── generation ────────────────────────────────────────────────────── */

  /**
   * `planet` (Phase 11): the target planet whose biome / ecosystem this world uses. null (or an unknown id) keeps the
   * pre-Phase-11 behaviour — the biome is drawn from the seed and paired with the sky core draws for the same seed.
   */
  generate(seed: number, mode: MissionMode = 'raid', planet: PlanetId | null = null): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.generated) this.clear();
    if (mode === 'training') { this.generateTraining(seed); return; }
    if (mode === 'tutorial') { this.generateTutorial(seed); return; }
    const t0 = performance.now();
    /* 2026-09-11 (C-40): ms per step — the end of the one console line and `genTimings` (read by smokes · measuring scripts). */
    const T = this.genTimings;
    for (const k of Object.keys(T)) delete T[k];
    let tl = t0;
    const lap = (name: string): void => { const n = performance.now(); T[name] = n - tl; tl = n; };

    this.mode = 'raid';
    this.seed = seed >>> 0;
    // an unknown id (older peer / hand-edited save) is reported as "no planet" so every reader agrees with core's fallback
    this.planet = isPlanetId(planet) ? planet : null;
    const def: PlanetDef | undefined = getPlanet(this.planet);
    const rng = new Random(this.seed);
    const noise = new Noise(rng.fork('terrain'));
    this.noise = noise;
    /* 2026-09-13 — **the hazard kind is drawn before the layout** (`Plan.drawHazardKind` — the first draw of the root's
     * `'hazard'` fork, which `Hazard.build` draws again to the same value), because a toxic-spore raid means a central
     * drop · outer extraction pads. The extraction pad count (planet threat · spores) is drawn once in its own fork
     * too. A fork does not advance its parent, so neither shifts another stream and every client answers the same.
     * 2026-09-14 (the intel broker) — those three lines were gathered into one `preview.planLayoutFor`. The preview map
     * on the intel broker's screen calls **the same function**, so the two cannot split. `ctx.missionIntel` is set
     * before `game:newMission` is emitted (the contract). */
    const plan = planLayoutFor(this.seed, this.planet, ctx.missionIntel ?? null, rng);
    this.biome = plan.biome;
    this.layout = plan.layout;
    this.spawnRng = rng.fork('spawns');
    lap('layout');

    this.terrain.build(this.layout, this.biome, noise, rng.fork('terrainMesh'));
    this.root.add(this.terrain.group);
    lap('terrain');

    const bctx: BuildCtx = {
      rng, noise, biome: this.biome, layout: this.layout, terrain: this.terrain, hash: this.hash, root: this.root,
    };
    this.nests.build(bctx);
    this.pads.build(bctx);
    this.outposts.build(bctx);
    lap('nests+pads+outposts');
    /* 2026-09-09 — Structures · rails are built **before props · crates**: the walls · decks · containers have to be in
     * the hash first for `isSpotFree` to dodge those spots when it places rocks and crates (no rock stands in a room).
     * The sites themselves were fixed by `layout` already, and `Terrain` has finished flattening · digging basements. */
    this.structures.build(bctx, ctx);
    lap('structures');
    this.rails.build(bctx, ctx);
    lap('rails');
    /* 2026-09-13 — The rover comes **before props · crates** too: the road corridor · station poles · the body have to
     * be in the hash first for `isSpotFree` to dodge them. The route itself (`layout.rover`) was fixed earlier by
     * `generateLayout`, like the rail. No route placed = no vehicle. */
    this.roverRoad.build(bctx, ctx);
    if (this.roverRoad.route) this.roverSys.build(this.roverRoad.route, bctx);
    lap('rover');
    /* 2026-09-09 — The hazard comes **before props · crates** too: the giant mushroom grove's stems have to be in the
     * hash first for `isSpotFree` to dodge the middle of a grove. The hazard kind · start time come from the mission
     * seed alone, so building them here cannot put clients out of step. */
    this.hazardSys.build(bctx, ctx, def?.hazards ?? []);
    lap('hazard');
    this.props.build(bctx);
    lap('props');
    this.crates.build(bctx, ctx);
    lap('crates');
    // 2026-09-11 (the greenhouse rework): the **planet** decides the soil piles (`soils` · `soilNodes` in `data/planets.csv`) —
    // `PlanetEcosystem` has no columns for those two yet, so the id is passed through and `world/soil.ts` reads the table.
    this.gather.build(bctx, ctx, def?.eco ?? null, this.hazardSys.getGroveSpots(), this.planet);
    lap('gather');
    /* 2026-09-11 — The light pillars are gone; the **opened look** says "already searched" instead. A crate · container
     * opened first on this client is announced so it opens on every squadmate's screen too (the contents are matched
     * separately by `cont` in `inventory/`). */
    this.crates.setOpenListener(this.onLocalOpened);
    this.structures.setOpenListener(this.onLocalOpened);
    this.rails.setOpenListener(this.onLocalOpened);
    this.ambience.build(bctx);

    this.extractionPoints = this.layout.extraction.map((p, i) => ({
      id: `extract_${i}`,
      position: new THREE.Vector3(p.x, p.height + PLATFORM_HEIGHT, p.z),
      yaw: p.yaw,
    }));
    const sp = this.layout.spawn;
    this.spawnPos.set(sp.x, this.getHeightAt(sp.x, sp.z), sp.z);

    // Fog of war in a raid only — around the spawn it is revealed up front (the squad already knows the drop point)
    this.fogMask = new Fog();
    this.fogMask.attach(ctx);
    this.fogMask.setOutposts(this.outposts.getSites());
    this.fogMask.setRoverStations(this.roverRoad.route?.stations ?? []);   // 2026-09-13: rover station discovered → map   // 2026-09-11 (C-11): ruin discovered → map icon
    this.fogMask.reveal(sp.x, sp.z, FOG_REVEAL_RADIUS);

    lap('ambience+fog');
    for (const [k, v] of Object.entries(this.terrain.timings)) T[`terrain.${k}`] = v;
    for (const [k, v] of Object.entries(this.props.timings)) T[`props.${k}`] = v;

    this.generated = true;
    this.ready = true;
    const ms = performance.now() - t0;
    T.total = ms;
    console.info(`[World] seed ${this.seed} · planet ${def ? `${this.planet} (${def.name})` : '—'} · biome ${this.biome.id} (${this.biome.name}) · ${this.hash.getAll().length} obstacles · ${this.crates.getDefs().length} crates · ${this.gather.getNodes().length} herbs · ${this.structures.getDefs().length} structures · ${this.rails.getLines().length ? this.rails.getLines()[0].kind : 'no'} rail · hazard ${this.hazardSys.kind ?? '—'}${this.hazardSys.kind ? ` @ ${this.hazardSys.startsAt}s` : ''} · ${ms.toFixed(0)} ms`);
    this.ensureOpenNet();
    this.requestOpenSync();
    ctx.bus.emit('world:ready', { seed: this.seed, playerSpawn: this.spawnPos.clone(), planet: this.planet });
  }

  /**
   * `WorldRef.previewLayout` (2026-09-14, the intel broker) — computes **the layout only**. It builds no terrain and no
   * mesh and touches not one line of this instance's state, so it can be called **from the ship too** (`ctx.world` is
   * attached from boot). It goes through the same `preview.planLayoutFor` real generation uses, so the preview and the
   * real map cannot drift apart.
   */
  previewLayout(seed: number, planet: PlanetId | null, intel?: IntelEffects | null): MapPreviewLayout {
    return previewLayoutFor(seed, planet, intel ?? null);
  }

  /**
   * The simulation training range: flat arena, three lanes of pop-up targets, exit console. No terrain / props / crates / nests /
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

  /**
   * The tutorial planet (2026-09-14, `docs/DECISIONS.md` 「2026-09-14 — 튜토리얼 개편」): a hand-built linear map. It does
   * not go through the procedural generator at all and is wired **exactly like the training range** — no terrain ·
   * props · crates · nests · gather · rails · hazard · fog whatsoever, and every walkable surface is a box collider
   * (a deck), so a cliff is atrue vertical face. The detail is in `tutorial/model.ts`.
   * Unlike the training range the sky is **not switched to space mode** — this is on a planet, so the usual atmosphere
   * · sun stay.
   */
  private generateTutorial(seed: number): void {
    const ctx = this.ctx!;
    const t0 = performance.now();
    this.mode = 'tutorial';
    this.seed = seed >>> 0;
    this.planet = null;              // the tutorial planet is not a planet in `data/planets.csv` (no ecosystem · hazard · permanent environment)
    const rng = new Random(this.seed);
    this.layout = null;
    this.biome = null;
    this.noise = null;
    this.spawnRng = rng.fork('spawns');
    this.tutorialWorld.build(ctx, this.root, this.hash);
    this.extractionPoints = [];      // no extraction console — the abandoned ship has been landed from the start
    this.spawnPos.copy(this.tutorialWorld.spawn);
    this.generated = true;
    this.ready = true;
    const ms = performance.now() - t0;
    console.info(`[World] tutorial · seed ${this.seed} · ${this.hash.getAll().length} obstacles · ${this.tutorialWorld.enemySpawns().length} enemies · ${ms.toFixed(0)} ms`);
    ctx.bus.emit('world:ready', { seed: this.seed, playerSpawn: this.spawnPos.clone(), planet: null });
  }

  /** Debug / smoke: the arena (targets, counters) while a training world is up. */
  get trainingArena(): TrainingArena | null { return this.mode === 'training' && this.ready ? this.arena : null; }
  /** `ctx.world.training` (Phase 9): the arena implements `TrainingRef` (modes / score / timed course); null outside a training world. */
  get training(): TrainingRef | null { return this.trainingArena; }
  /**
   * `ctx.world.tutorial` (2026-09-14, `docs/DECISIONS.md` 「2026-09-14 — 튜토리얼 개편」): the tutorial world's checkpoints ·
   * fall rules · enemy spots. null when this is not a tutorial world, and the callers (`player/` · `game/` ·
   * `enemies/`) chain it with `?.` · `?? 'normal'`, so the main game's behaviour does not change by one letter.
   */
  get tutorial(): TutorialWorldRef | null { return this.mode === 'tutorial' && this.ready ? this.tutorialWorld : null; }

  private setSpaceMode(on: boolean): void {
    const atmo = this.ctx?.scene.userData.atmosphere as { setSpaceMode?: (on: boolean) => void } | undefined;
    atmo?.setSpaceMode?.(on);
  }

  clear(): void {
    if (!this.generated) return;
    this.ready = false;
    this.openedIds.clear();
    this.siteSpawns.reset();
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
    if (this.mode === 'tutorial') {
      this.tutorialWorld.dispose();
      this.hash.clear();
      this.extractionPoints = [];
      this.generated = false;
      return;
    }
    this.ambience.dispose();
    this.hazardSys.dispose();
    this.gather.dispose();
    this.roverSys.dispose();
    this.roverRoad.dispose();
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
    this.noise = null;
    this.generated = false;
  }

  /** What the light pool picks the nearest rooms by — a living player's eyes, or the camera with none. */
  private eyeFor(ctx: GameContext): THREE.Vector3 {
    const p = ctx.player;
    if (p && !p.isDead) return p.getEyePosition(this.eyeTmp);
    return this.eyeTmp.copy(ctx.camera.position);
  }

  /* ── 2026-09-11: syncing opened crates · containers ──────────────────
   * Anyone → everyone, `crate opened {id}` (whoever opened it announces it — the result is the same, so no authority
   * is needed). The host keeps the list and hands it to a late joiner (`flow rejoined` · `crate syncq`) as
   * `crate sync {ids}`. */
  private readonly onLocalOpened = (id: string): void => {
    this.openedIds.add(id);
    const ctx = this.ctx;
    const net = ctx?.net;
    if (ctx?.isMultiplayer && net) net.send({ t: 'crate', ev: 'opened', id }, 'others');
  };

  /**
   * 2026-09-11 (C-57): only an id that exists in this world is marked — and remembered for the host's `sync`, so the host
   * never hands a late joiner an id it could not verify. Returns whether it was applied.
   */
  private applyOpened(id: string): boolean {
    if (!this.ready || !this.isPlanet || typeof id !== 'string') return false;
    if (!this.openablePositionOf(id)) return false;
    this.openedIds.add(id);
    if (this.crates.markOpened(id)) return true;
    if (this.structures.markContainerOpened(id)) return true;
    this.rails.markContainerOpened(id);
    return true;
  }

  /** 2026-09-11 (C-57): where crate / container `id` stands in this world (null = no such thing here). */
  private openablePositionOf(id: string): THREE.Vector3 | null {
    return this.crates.positionOf(id) ?? this.structures.containerPositionOf(id) ?? this.rails.containerPositionOf(id);
  }

  /**
   * 2026-09-11 (C-57): a peer's `crate opened` is believed when the id exists here **and** the sender's snapshot stands
   * within reach of it — max(PLAYER_INTERACT_RANGE, STRUCTURE_INTERACT_RANGE) + `CRATE_OPEN_RANGE_SLACK` (3-D, so a
   * crate one floor up does not count). A sender without a live ref (no snapshot yet) is refused.
   */
  private peerOpenPlausible(id: string, from: PeerId): boolean {
    const net = this.ctx?.net;
    const at = typeof id === 'string' ? this.openablePositionOf(id) : null;
    if (!net || !at || from === net.localId) return false;
    /* 2026-09-15 (android squadmates): **what the lobby host sent is not distance-checked.** The host opens crates on an
     * android's behalf (`InventoryRef.takeContainerItemFor` → `markContainerOpened`), so the host's own body may be on
     * the far side of the map. Trusting the host as the authority is the `crate sync` · `cont taken` rule (CLAUDE.md §4.3). */
    if (from === net.lobby?.hostId) return true;
    const ref = net.getRemotePlayer(from);
    if (!ref || ref.connected === false) return false;
    const reach = Math.max(PLAYER_INTERACT_RANGE, STRUCTURE_INTERACT_RANGE) + CRATE_OPEN_RANGE_SLACK;
    return ref.position.distanceToSquared(at) <= reach * reach;
  }

  private ensureOpenNet(): void {
    const ctx = this.ctx;
    const net = ctx?.net;
    if (!ctx || !net || this.openNetHooked) return;
    this.openNetHooked = true;
    this.unsubs.push(
      net.onMessage('crate', (m, from) => {
        if (!ctx.isMultiplayer) return;
        if (m.ev === 'opened') {
          if (this.peerOpenPlausible(m.id, from)) this.applyOpened(m.id);
          else this.openRefused++;
          return;
        }
        if (m.ev === 'syncq') { if (net.isHost) this.sendOpenSync(from); return; }
        // only the host's list, and each id still has to exist here
        if (m.ev === 'sync' && !net.isHost) {
          const hostId = net.lobby?.hostId;
          if (hostId && from !== hostId) return;
          for (const id of Array.isArray(m.ids) ? m.ids : []) this.applyOpened(id);
        }
      }),
      net.onMessage('flow', (m, from) => { if (m.ev === 'rejoined' && net.isHost) this.sendOpenSync(from); }),
      ctx.bus.on('net:hostChanged', ({ isLocalHost }) => { if (!isLocalHost) this.requestOpenSync(); }),
    );
  }

  private requestOpenSync(): void {
    const ctx = this.ctx;
    const net = ctx?.net;
    if (!ctx || !net || !ctx.isMultiplayer || net.isHost || !this.ready) return;
    net.send({ t: 'crate', ev: 'syncq', id: '' }, 'host');
  }

  private sendOpenSync(to: PeerId): void {
    const ctx = this.ctx;
    const net = ctx?.net;
    if (!ctx || !net || !ctx.isMultiplayer || !this.ready) return;
    net.send({ t: 'crate', ev: 'sync', id: '', ids: [...this.openedIds] }, to);
  }

  /** Current biome (null before generation). */
  getBiome(): Biome | null { return this.biome; }

  /* ── WorldRef: terrain queries ─────────────────────────────────────── */

  getHeightAt(x: number, z: number): number {
    if (this.mode === 'training') return 0;
    if (this.mode === 'tutorial') return this.tutorialWorld.heightAt();
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
   * 2026-09-09 — **The walkable surface**: the higher of the terrain height and the top of an obstacle at that spot.
   * Given `feetY` it reads only the tops a body at that foot height can step onto (at most
   * `feetY + PROP_STEP_UP_MAX`) — anything higher has to stay a wall and is not counted as a surface. With none, the
   * highest top at that spot (bullets · fall judgement).
   */
  getSurfaceY(x: number, z: number, feetY?: number): number {
    const ground = this.getHeightAt(x, z);
    if (!this.ready) return ground;
    const out = this.surfaceOut;
    out.length = 0;
    // radius 0: only the cylinders that really cover that point (`query` judges by `radius + o.radius`)
    this.hash.query(x, z, 0, out);
    const ceiling = feetY === undefined ? Infinity : feetY + PROP_STEP_UP_MAX;
    let best = ground;
    for (let i = 0; i < out.length; i++) {
      const o = out[i];
      let top = o.position.y + o.height;
      if (top <= best) continue;
      // 2026-09-09: for a box collider the floor is the **box cross-section**, not its circle (no standing on thin air past a wall corner)
      if (o.box) {
        if (!boxContainsXZ(o, x, z)) continue;
        // 2026-09-11: for a ramp floor plate (a staircase) it is the slope height at that spot
        if (o.ramp) { top = rampTopAt(o, x, z); if (top <= best) continue; }
      } else if (o.hull && !hullContainsXZ(o.hull.points, x, z)) continue;   // 2026-09-11: the convex outline's cross-section
      if (top > ceiling) continue;
      best = top;
    }
    out.length = 0;
    return best;
  }

  /**
   * The obstacle currently underfoot (with `PROP_TOP_MARGIN` to spare). While a body stands on it `resolveCollision`
   * does not push it out — both use the same margin, so they cannot disagree and fling the body off an edge.
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
      if (o.box && !boxContainsXZ(o, x, z)) continue;
      if (o.hull && !hullContainsXZ(o.hull.points, x, z)) continue;
      const top = o.ramp ? rampTopAt(o, x, z) : o.position.y + o.height;
      if (feetY < top - PROP_TOP_MARGIN || feetY > top + PROP_TOP_MARGIN) continue;
      /*
       * 2026-09-11 (C-38): inside the window a **moving floor (one carrying `velocity` — a stopped tram too) beats
       * height**. A radius-0 query walks one cell in insertion order and the rail deck goes in before the tram, so with
       * tops at the same height the static deck almost always won and riding never even started (it used to rest on the
       * single inequality: deck top error < `TRAM_FLOOR_UP`).
       */
      if (best) {
        const moving = !!o.velocity, bestMoving = !!best.velocity;
        if (moving !== bestMoving) { if (!moving) continue; }
        else if (top <= bestTop) continue;
      }
      bestTop = top;
      best = o;
    }
    out.length = 0;
    return best;
  }

  /**
   * 2026-09-11 (C-22) — **the material underfoot** (footsteps). Given `feetY`, the obstacle being stood on at that foot
   * height wins (`getStandingObstacle`'s rules exactly — this is the only hash query); with none, the order is the
   * extraction pad · ruin floor plate (colliderless concrete) → the terrain band. The training range is all concrete.
   * The table and the terrain rules are in `surface.ts`.
   */
  getSurfaceMaterial(x: number, z: number, feetY?: number): SurfaceMaterial {
    if (this.mode === 'training') return 'concrete';
    if (this.mode === 'tutorial') return this.tutorialWorld.surfaceMaterial(x, z);
    if (!this.ready) return 'dirt';
    if (feetY !== undefined) {
      const o = this.getStandingObstacle(x, z, feetY);
      if (o) return obstacleMaterial(o, x, z, this.wreckAt);
    }
    const layout = this.layout;
    if (layout) {
      // The extraction pad: a concrete disc (`getHeightAt` already gives its top like terrain — it has no collider)
      const R = PLATFORM_RADIUS + 0.9;
      for (let i = 0; i < layout.extraction.length; i++) {
        const p = layout.extraction[i];
        const dx = x - p.x, dz = z - p.z;
        if (dx * dx + dz * dz <= R * R) return 'concrete';
      }
      if (onOutpostSlab(this.outposts.getSites(), x, z)) return 'concrete';
    }
    return terrainMaterial(this.biome, this.terrain, this.noise, layout, HALF, x, z);
  }

  private readonly wreckAt = (x: number, z: number): boolean => this.structures.structureAt(x, z)?.kind === 'wreck';

  /**
   * The share of the `radius` circle taken by obstacle cross-sections. It is a sum of circle-circle intersections with
   * no correction for overlap, so it can pass 1 — its job is filtering spots for large enemy spawns (`enemies/Spawner`).
   */
  obstacleCoverage(x: number, z: number, radius: number): number {
    if (!this.ready || radius <= 0) return 0;
    const out = this.coverOut;
    out.length = 0;
    this.hash.query(x, z, radius, out);
    let area = 0;
    for (let i = 0; i < out.length; i++) {
      const o = out[i];
      if (o.hull) {
        // 2026-09-11: a convex outline counts as an **equal-area circle** (at its centroid), not its circumscribed one —
        // on a slope a rock's instance origin sits metres from the visible part and the circle is far too large.
        hullAreaCentroid(o.hull.points, this.hullAC);
        const req = Math.sqrt(Math.max(0, this.hullAC.area) / Math.PI);
        area += circleOverlap(Math.hypot(this.hullAC.x - x, this.hullAC.z - z), radius, req);
        continue;
      }
      // A box collider counts by its circumscribed circle (`radius`) — an over-estimate, but erring towards blocking is safe when filtering large enemy spawns.
      area += circleOverlap(Math.hypot(o.position.x - x, o.position.z - z), radius, o.radius);
    }
    out.length = 0;
    return area / (Math.PI * radius * radius);
  }

  /**
   * Draws `count` points at least `minGap` apart within `radius` of `center` (so rescue pods do not land on top of one
   * another). The first pass avoids standing on obstacles; short of that, a second pass fills the rest keeping the gap
   * alone — both passes use the same `Random`, so it is deterministic when given a `seed`.
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

  /** Fog of war (`FogRef`); null in the training range. */
  get fog(): FogRef | null { return this.fogMask; }

  getNormalAt(x: number, z: number, out: THREE.Vector3 = new THREE.Vector3()): THREE.Vector3 {
    if (!this.isPlanet) return out.set(0, 1, 0);   // the training range's · tutorial's ground is flat
    const e = 0.6;
    const hl = this.getHeightAt(x - e, z), hr = this.getHeightAt(x + e, z);
    const hd = this.getHeightAt(x, z - e), hu = this.getHeightAt(x, z + e);
    out.set((hl - hr) / (2 * e), 1, (hd - hu) / (2 * e));
    return out.normalize();
  }

  isInsideBounds(x: number, z: number): boolean {
    if (this.mode === 'training') return this.arena.isInside(x, z);
    if (this.mode === 'tutorial') return this.tutorialWorld.isInside(x, z);
    return Math.abs(x) <= HALF && Math.abs(z) <= HALF;
  }

  /* ── WorldRef: collision ───────────────────────────────────────────── */

  /**
   * 2026-09-12 (C): `height` = that body's height. Given it, the space under a floating box · outline is measured by
   * this height instead of the human headroom (`BOX_HEADROOM`) — that is how a ground drone passes the vent beside a
   * locked door (the lintel's underside = the floor + `VENT_H`). With none, it is as it was.
   */
  resolveCollision(position: THREE.Vector3, radius: number, height?: number): THREE.Vector3 {
    const out = this.queryOut;
    out.length = 0;
    const bodyH = height !== undefined && height > 0 ? height : 0;
    this.hash.query(position.x, position.z, radius, out);
    for (let i = 0; i < out.length; i++) {
      const o = out[i];
      // 2026-09-11: a broken window frame blocks people · enemies but lets grenades · thrown gadgets through (`structures/parts/Glass`)
      if (o.passSmall && radius < SMALL_BODY_R) continue;
      // 2026-09-11: a ramp floor plate's top is the slope height where the body stands (clamped to the cross-section)
      const top = o.ramp ? rampTopAt(o, position.x, position.z) : o.position.y + o.height;
      // 2026-09-09: standing on the top face is not pushed out. The margin is the same `PROP_TOP_MARGIN` as
      // `getStandingObstacle`'s, so the two cannot disagree and fling a body off an edge (it used to be a far tighter 0.05).
      if (position.y >= top - PROP_TOP_MARGIN) continue;   // above the obstacle
      if (o.hull) {
        // 2026-09-11 — A convex prism. **The same rules** as a cylinder prop (no step-up exception), only judged by the
        // outline instead of a circle. Its bottom is buried in the ground, so the headroom test practically never fires.
        if (position.y + (bodyH > 0 ? bodyH : BOX_HEADROOM) <= o.position.y) continue;
        hullPushOut(o.hull.points, position, radius);
        continue;
      }
      if (o.box) {
        // 2026-09-09 — A box collider. A box **may float** (a basement ceiling slab · a tram deck), so a plate passing
        // overhead is not pushed out. Cylinders all rise from the ground and never reach this branch.
        // 2026-09-11: **a small body (a throwable) gets only its own size as headroom**, and no "step-up" exception below.
        // With the human figure (2.1 m) a grenade thrown indoors caught on the ceiling slab only 1.5 m up and was
        // pushed out of the building, was pushed back by the wall over a window and could not pass it, and went straight
        // through railings · window sills.
        const small = radius < SMALL_BODY_R;
        // 2026-09-12 (C): a body that states its height gets that height as headroom (a ground drone — under a vent lintel)
        if (position.y + (bodyH > 0 ? bodyH : small ? radius * 2 : BOX_HEADROOM) <= o.position.y) continue;
        /* 2026-09-10 — **a step one can climb is not a wall.** When a top is within `PROP_STEP_UP_MAX` of the foot
         * height, `getSurfaceY(x, z, feetY)` lifts the feet onto it anyway (the mover's convention: surface first,
         * push-out second). Pushing out here regardless means **the body is pushed away before it can reach the spot
         * it would climb from** and never gets up — the basement stairs stuck exactly there. When one step's tread is
         * narrower than the body radius, the step right above the one being stood on always overlaps the body, so it
         * was pushed down every frame and slid straight back down the staircase.
         * The condition is **the same expression** as `getSurfaceY`'s ceiling, so the two cannot disagree.
         * Boxes only — the cylinder prop code path does not change by one line, per the 2026-09-09 convention. */
        if (!small && top <= position.y + PROP_STEP_UP_MAX) continue;
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
    if (this.mode === 'tutorial') { this.tutorialWorld.clampInside(position, radius); out.length = 0; return position; }
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
    return this.rayQuery(origin, dir, maxDist, false);
  }

  /**
   * 2026-09-18 (user's decision 「창은 깨졌어도 폭발을 막고, 낮은 엄폐물은 기존대로」) — the same ray as `raycast`, except
   * that **window glass alone** blocks it whether broken or not (only for `shared/explosion.lineClear`).
   *
   * Why it was needed: a broken window frame keeps its collider and turns `passRays`
   * (`structures/parts/Glass.breakPane`), so `raycast` walks straight through. That let an artillery blast outside see
   * a body standing **in the middle of a room** through that room's one window and hurt it.
   *
   * Why **glass** and not all of `passRays`: the tutorial fence's ghost band (`tut_fence_ghost`) is `passRays` too.
   * That one is not a window but the device that draws 「a low obstacle you still cannot step over」, so a blast has to
   * pass it exactly as before (blocking it would turn the tutorial's low fence into a shield). So the test is one
   * thing — whether the collider's `kind` is `GLASS_OBSTACLE_KIND`. Glass is made in `Glass.ts` alone, so the label is
   * the identity.
   *
   * Low cover (`destructible` crates · wreckage) was never `passRays` and blocks both rays identically — that is, this
   * function **does not touch the cover judgement at all**. A person hit while peeking their head over cover is still
   * `blastReachesBody`'s 3-point rule (ankle · chest · head).
   */
  raycastBlast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): TerrainHit | null {
    return this.rayQuery(origin, dir, maxDist, true);
  }

  /** The shared body of `raycast` / `raycastBlast`. `blockGlass` = broken window glass blocks too. */
  private rayQuery(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, blockGlass: boolean): TerrainHit | null {
    const ox = origin.x, oy = origin.y, oz = origin.z;
    let dx = dir.x, dy = dir.y, dz = dir.z;
    const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dl < 1e-8) return null;
    dx /= dl; dy /= dl; dz /= dl;

    const training = this.mode === 'training';
    const tutorial = this.mode === 'tutorial';
    let bestT = training
      ? this.arena.raycastShell(ox, oy, oz, dx, dy, dz, maxDist, this.shellN)
      : tutorial
        ? this.tutorialWorld.raycastGround(oy, dy, maxDist, this.shellN)
        : this.terrain.raycast(ox, oy, oz, dx, dy, dz, maxDist, this.heightFn);
    let bestObs: ObstacleEntry | null = null;
    const limitT = bestT > 0 ? bestT : maxDist;

    // obstacles along the segment
    const ex = ox + dx * limitT, ez = oz + dz * limitT;
    this.hash.walkSegment(ox, oz, ex, ez, this.hash.maxRadius, (o) => {
      const limit = bestT > 0 ? bestT : maxDist;
      // 2026-09-11: a broken window frame — bullets · sight pass through.
      // 2026-09-18: except that in `raycastBlast` (blast · melee visibility) **glass alone** blocks even broken (see `raycastBlast`).
      if (o.passRays && !(blockGlass && o.kind === GLASS_OBSTACLE_KIND)) return false;
      // 2026-09-09: a box collider is hit by three slabs (`obb.rayBox`); cylinders are as they were.
      // 2026-09-11: a ramp floor plate is a wedge (`obb.rayRamp`), a convex prism is per-band outlines (`rayHullObstacle`).
      const t = o.hull ? this.rayHullObstacle(ox, oy, oz, dx, dy, dz, o, limit)
        : o.box ? (o.ramp ? rayRamp(ox, oy, oz, dx, dy, dz, o, limit) : rayBox(ox, oy, oz, dx, dy, dz, o, limit))
          : this.rayCylinder(ox, oy, oz, dx, dy, dz, o, limit);
      if (t >= 0 && (bestT < 0 || t < bestT)) {
        bestT = t;
        bestObs = o;
        if (o.hull) this.tmpN.set(this.hullN.x, this.hullN.y, this.hullN.z);
        else if (o.box) this.tmpN.set(boxHitNormal.x, boxHitNormal.y, boxHitNormal.z);
        else this.tmpN.set(this.hitNx, this.hitNy, this.hitNz);   // rayCylinder wrote hitN*
      }
      return false;
    });

    if (bestT < 0) return null;
    const point = new THREE.Vector3(ox + dx * bestT, oy + dy * bestT, oz + dz * bestT);
    const normal = bestObs ? this.tmpN.clone() : training || tutorial ? this.shellN.clone() : this.getNormalAt(point.x, point.z, new THREE.Vector3());
    const hit: TerrainHit = { point, normal, distance: bestT };
    if (bestObs) hit.obstacle = bestObs as Obstacle;
    return hit;
  }

  /**
   * 2026-09-11 — Ray vs convex prism. With bands (`hull.bands`) the nearest band, without them the movement outline
   * from the bottom face to the top. The hit band's normal is left in `hullN`. −1 = a miss.
   */
  private rayHullObstacle(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, o: Obstacle, maxT: number): number {
    const hull = o.hull!;
    if (!hull.bands || hull.bands.length === 0) {
      const t = rayHull(ox, oy, oz, dx, dy, dz, hull.points, o.position.y, o.position.y + o.height, maxT);
      if (t >= 0) { this.hullN.x = hullHitNormal.x; this.hullN.y = hullHitNormal.y; this.hullN.z = hullHitNormal.z; }
      return t;
    }
    let best = -1;
    for (let i = 0; i < hull.bands.length; i++) {
      const b = hull.bands[i];
      const t = rayHull(ox, oy, oz, dx, dy, dz, b.points, b.y0, b.y1, best >= 0 ? best : maxT);
      if (t >= 0 && (best < 0 || t < best)) {
        best = t;
        this.hullN.x = hullHitNormal.x; this.hullN.y = hullHitNormal.y; this.hullN.z = hullHitNormal.z;
      }
    }
    return best;
  }

  /**
   * Ray vs the finite vertical cylinder an obstacle blocks shots with. Returns `t` or −1; writes the hit normal to
   * `hitN*`.
   *
   * 2026-09-08: two changes, both about cover that did not work.
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
    // 2026-09-13 (the extraction rework): box colliders ride along too — a landed extraction ship's hull arrives as `Obstacle.box`.
    // The caller fills `radius` with the circumscribed circle (`hypot(halfX, halfZ)`) (the `SpatialHash.addBox` convention). Cylinder callers are unchanged.
    if (obstacle.box) entry.box = obstacle.box;
    this.hash.insert(entry);
    let removed = false;
    return () => { if (removed) return; removed = true; this.hash.remove(entry); };
  }

  getObstaclesNear(x: number, z: number, radius: number): Obstacle[] {
    return this.hash.query(x, z, radius, []);
  }

  getPlayerSpawn(): THREE.Vector3 { return this.spawnPos.clone(); }

  getExtractionPoints(): readonly ExtractionPointDef[] { return this.extractionPoints; }

  getCrates(): readonly CrateDef[] { return this.isPlanet ? this.crates.getDefs() : NONE_CRATES; }

  getNestPositions(): readonly THREE.Vector3[] { return this.isPlanet ? this.nests.getHolePositions() : NONE_VEC; }

  /**
   * 2026-09-18: bug egg spots. Planet raids only — the training range · tutorial have no nests, so an empty array
   * (the same `isPlanet` gate as `getNestPositions`).
   *
   * ⚠ `NestEggSpot.nest` is **the nest pad's index** and not an index into `getNestPositions()` — one pad holds 4~6
   * holes (mounds), so the two run differently. The reason is in `Nests.getEggSpots`'s comment.
   */
  getNestEggSpots(): readonly NestEggSpot[] { return this.isPlanet ? this.nests.getEggSpots() : NONE_EGGS; }

  /** Harvestable plants (consumed nodes stay in the list with `harvested: true`). */
  getGatherNodes(): readonly GatherNodeDef[] { return this.isPlanet ? this.gather.getNodes() : NONE_GATHER; }

  /* ── appended (2026-09-09): raid play improvements ── */
  /** Abandoned structures (outpost · lab · crash-landed ship). An empty array in the training range. */
  getStructures(): readonly StructureDef[] { return this.isPlanet ? this.structures.getDefs() : NONE_STRUCTURES; }
  /** The structure holding `(x, z)`, or null with none. */
  structureAt(x: number, z: number): StructureDef | null {
    return this.isPlanet ? this.structures.structureAt(x, z) : null;
  }
  /** The rail (a map may or may not have one). */
  getRailLines(): readonly RailLineDef[] { return this.isPlanet ? this.rails.getLines() : NONE_RAILS; }
  /** The trams on the rail. */
  getTrams(): readonly TramDef[] { return this.isPlanet ? this.rails.getTrams() : NONE_TRAMS; }
  /** This raid's environmental hazard. null on a planet with no candidate, and in the training range. */
  get hazard(): HazardRef | null { return this.isPlanet ? this.hazardSys.ref : null; }
  /** 2026-09-13: this raid's rover. null in the training range · with no route · before the world is ready. */
  get rover(): RoverRef | null { return this.isPlanet && this.ready ? this.roverSys.ref : null; }
  /**
   * 2026-09-11 (A-13): the **permanent environment** of this raid's planet (`env` in `data/planets.csv`), null with none.
   * A thin query that returns `getPlanet(id)?.env` as it is — world answers on the caller's behalf so nobody has to
   * carry the planet id around (which is why it sits beside `hazard`: the two queries that ask 「what kind of place is
   * this map」). The training range is not a planet, so it is always null (`generate` clears `this.planet` — and `mode`
   * blocks it once more anyway).
   */
  get env(): EnvKind | null {
    if (!this.isPlanet) return null;
    return getPlanet(this.planet)?.env ?? null;
  }
  /** 2026-09-11: structure ladders (an empty array in the training range). */
  getLadders(): readonly LadderDef[] { return this.isPlanet ? this.structures.getLadders() : NONE_LADDERS; }

  /* ── appended (2026-09-15): the sandworm eruption rework — `WorldRef.burrowGroundOk` ── */
  /** The window `burrowGroundOk` reads (built once and reused — the host asks every 2 s, the thumper preview every frame). */
  private burrowQuery: BurrowGroundQuery | null = null;
  /**
   * Is the `radius` m around `(x, z)` flat bare ground a sandworm can erupt through — the rules are in
   * `BurrowGround.ts`'s header comment. false outside planet mode (training range · tutorial) and before it is ready.
   */
  burrowGroundOk(x: number, z: number, radius: number): boolean {
    if (!this.isPlanet || !this.ready || !this.layout) return false;
    if (!this.burrowQuery) {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const self = this;
      this.burrowQuery = {
        heightAt: (qx, qz) => this.getHeightAt(qx, qz),
        slopeAt: (qx, qz) => this.terrain.getSlopeAt(qx, qz),
        insideBounds: (qx, qz) => this.isInsideBounds(qx, qz),
        hashQuery: (qx, qz, r, out) => this.hash.query(qx, qz, r, out),
        get layout() { return self.layout!; },
        get structures() { return self.structures.getDefs(); },
        get nestHoles() { return self.nests.getHolePositions(); },
        get gather() { return self.gather.getNodes(); },
        get crates() { return self.crates.getDefs(); },
        get hazard() { return self.hazard; },
      };
    }
    return burrowGroundOk(this.burrowQuery, x, z, radius);
  }

  /* ── appended (2026-09-13): the per-planet enemy faction — site spawn spots (`SiteSpawns.ts`) ── */
  /** This map's POI ruins (`Outposts.getSites()` as it is — not the enterable outpost `struct_outpost_*`). Training range · not ready = an empty array. */
  getRuinSites(): readonly RuinSiteDef[] {
    return this.isPlanet && this.ready ? this.outposts.getSites() : NONE_RUINS;
  }
  /**
   * `count` spots where a humanoid group can stand at the site `siteId` (`struct_*` · a platform id · `outpost_<i>`) —
   * at least `minGap` apart, seed-deterministic. The rules are in `SiteSpawns.ts`'s header comment. An unknown id · the
   * training range · not ready = an empty array.
   */
  getSiteSpawnPoints(siteId: string, place: SiteSpawnPlace, count: number, minGap: number, seed: number): THREE.Vector3[] {
    if (!this.isPlanet || !this.ready) return [];
    return this.siteSpawns.points(siteId, place, count, minGap, seed);
  }

  /**
   * 2026-09-12 (C) — `WorldRef.previewContainerItems`: what a container world owns **would hold when first opened**. A
   * structure · rail container goes through the same `ContainerSet.preview` the opening code uses (the key bonus roll
   * included); a map crate through the same expression as the crate code (`rollCrateContents`). Pure — it touches no
   * opened mark, event or cache. null for an unknown id · the training range · before it is ready.
   */
  previewContainerItems(containerId: string): ItemInstance[] | null {
    const ctx = this.ctx;
    if (!ctx || !this.ready || !this.isPlanet || typeof containerId !== 'string') return null;
    const fromSets = this.structures.previewContainerItems(containerId) ?? this.rails.previewContainerItems(containerId);
    if (fromSets) return fromSets;
    const crate = this.crates.getDefs().find((c) => c.id === containerId);
    return crate ? rollCrateContents(ctx, crate.id, crate.tier) : null;
  }

  /**
   * 2026-09-16 — `WorldRef.crateLootOpts`: the roll rules for a container id. A locked room exists only in structures,
   * so only the structure set is asked (a map crate · rail · tram container · an unknown id · not ready = undefined).
   * Inventory's opening path · peek pass this value straight through.
   */
  crateLootOpts(containerId: string) {
    if (!this.ready || !this.isPlanet || typeof containerId !== 'string') return undefined;
    return this.structures.crateLootOpts(containerId);
  }

  /* ── 2026-09-15 (android squadmates, `docs/DECISIONS.md` 「2026-09-15 — 안드로이드 분대원 · 레이드 진입 로딩」) ─────── */

  /** The array `getLootContainers()` returns and its entry pool (0 allocations per call — androids ask often). */
  private readonly lootList: LootContainerEntry[] = [];
  private readonly lootPool: LootContainerEntry[] = [];

  /**
   * Every loot container on this map — map crates + structure · platform · tram containers. `id` is the **inventory
   * container id** (a crate's `CrateDef.id`; a container's spec id, its interaction id with `container:` stripped) —
   * the id `crate:open` · `peekContainerItems` · `InventoryRef.takeContainerItemFor` use. Both the array and the
   * entries are **reused**: read them, use them at once, never store them. `position` is a live vector, so a container
   * inside a tram follows it by itself. The training range · not ready = an empty array.
   */
  getLootContainers(): readonly LootContainerInfo[] {
    this.lootList.length = 0;
    if (!this.ready || !this.isPlanet) return this.lootList;
    let n = 0;
    const push = (id: string, position: THREE.Vector3, tier: number, opened: boolean, kind: 'crate' | 'structure'): void => {
      while (this.lootPool.length <= n) this.lootPool.push({ id: '', position, tier: 0, opened: false, kind: 'crate' });
      const e = this.lootPool[n++];
      e.id = id; e.position = position; e.tier = tier; e.opened = opened; e.kind = kind;
      this.lootList.push(e);
    };
    for (const c of this.crates.getDefs()) push(c.id, c.position, c.tier, c.opened, 'crate');
    this.structures.collectContainers((id, p, tier, opened) => push(id, p, tier, opened, 'structure'));
    this.rails.collectContainers((id, p, tier, opened) => push(id, p, tier, opened, 'structure'));
    return this.lootList;
  }

  /**
   * Gives a crate · container an android opened its **opened look** and tells the squad (`crate opened`). Unlike a
   * person's interaction it raises no event, no stats and no `감정` appraisal XP — those rise only when a person pressed
   * E. The one caller is the authority's `InventoryRef.takeContainerItemFor`. false for an id not on this map.
   */
  markContainerOpened(id: string): boolean {
    if (this.openedIds.has(id)) return true;   // already in the opened look — `crate opened` is not sent again
    if (!this.applyOpened(id)) return false;
    this.onLocalOpened(id);
    return true;
  }

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
