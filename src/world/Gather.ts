import * as THREE from 'three';
import {
  CATEGORY_COLOR,
  GATHER_HERB_QTY2_CHANCE, GATHER_INTERACT_TIME, GATHER_NODES_PER_MISSION, GATHER_SALVAGE_CORE_CHANCE,
  GATHER_SALVAGE_CORE_QTY, GATHER_SALVAGE_MINERAL_CHANCE, GATHER_SALVAGE_MINERAL_QTY, GATHER_SALVAGE_QTY2_CHANCE,
  IMPLANT_DASH_MAX_SLOPE_DEG, Layers,
  MINING_HILL_MIN_SLOPE, MINING_NODE_HOLD_S, MINING_SKILL_XP, MINING_YIELD_MAX, MINING_YIELD_MIN,
  RARITY_ORDER, SALVAGE_INTERACT_TIME, SALVAGE_NODES_PER_MISSION, SOIL_TAG_COLOR, getPlanet,
  type GameContext, type GatherNodeDef, type GatherNodeKind, type GatherWire, type HarvestMessage, type HarvestRequest,
  type Interactable, type ItemCategory, type ItemInstance, type PeerId, type PlanetEcosystem, type Random, type SoilTag,
} from '@/shared';
/* appended (2026-09-12): the item recovery contract — a gathered thing is raid loot too */
import { markRaidFound, raidFoundSeed } from '@/shared';
import { type BuildCtx, PLAY_LIMIT, composeMatrix, displace, isSpotFree, merge, paint, paintGradient, scratch, xform } from './build';
import { SEED_INTERACT_TIME, SEED_NODE_RADIUS, planetSeeds } from './flora';
import {
  GROVE_PICKS_MAX, GROVE_PICKS_MIN, GROVE_PICK_RING_MAX, GROVE_PICK_RING_MIN, GROVE_PICK_VARIANT,
} from './hazard/model';
import { mineralRarityWeights, planetMineralNodes, rollMineralRarity, type RarityWeights } from './mineral';
import { planetSoil } from './soil';
import type { ObstacleEntry, SpatialHash } from './SpatialHash';
import { SAMPLE_INTERACT_TIME, SAMPLE_NODE_RADIUS, planetSamples } from './specimen';

/** Seconds the shrink-away animation runs after a node is harvested. */
const HARVEST_ANIM = 0.42;
/** Interaction radius of a plant. */
const NODE_RADIUS = 2.2;
/** A client's `harvq take` is retried after this long without an answer. */
const PENDING_TIMEOUT = 3;
/** Minimum distance between two nodes of different clusters. */
const MIN_SPACING = 7;

/**
 * Herb def ids used when `items/` has not registered any `category: 'herb'` def yet
 * (the folders are built in parallel). Real ids are discovered from `ctx.loot` at generation time.
 */
const FALLBACK_HERB_IDS: readonly string[] = ['herb_bloodroot', 'herb_ashleaf', 'herb_glowcap'];

// 0–2 herb · 3 salvage · 4 soil · 5 seed grove · 6 미확인 표본 (2026-09-11) · 7 광맥 (2026-09-16)
// The vein's purple is deliberately a colour no biome crystal (`biome.crystalEmissive`) shares — it has to read as
// "that is a vein" from the far side of a slope.
const GLOW_COLORS: readonly number[] = [0xff5a6a, 0x7affc8, 0xffc24a, 0xffb347, 0xd8b06a, 0xe6ff8a, 0x8fd8ff, 0xc08cff];

/* ── The salvage node (2026-09-08) ─────────────────────────────────────────
 * One of three ways out of the bottleneck where scrap came only from a crate's `material` roll. It uses **the same
 * node system** as herbs — placement · interaction · host-authoritative sync (`harv` / `harvq`) all run unchanged; what
 * differs is the variant mesh (a wrecked salvage pile), the prompt verb (`해체`), the pick time, and a fixed quantity instead of the gather yield. */
/** `variants` index of the salvage pile mesh (0–2 are the plant shapes). */
const SALVAGE_VARIANT = 3;
/** What a salvage pile hands over. */
const SALVAGE_DEF_ID = 'mat_scrap';
/** Interaction radius of a salvage pile (a bit wider than a plant — it is a pile). */
const SALVAGE_RADIUS = 2.6;
/** Minimum distance from a salvage pile to any other node. */
const SALVAGE_SPACING = 12;
/**
 * 2026-09-11 (C-20): the **bonus core** a salvage pile gives by chance on top. Chance · count are
 * `GATHER_SALVAGE_CORE_*` in `data/constants.csv`; the item id is the drive core the contract comment (`shared/constants.ts`) fixed.
 */
const SALVAGE_CORE_DEF_ID = 'mat_core';
/*
 * 2026-09-13 (cooking material tiers — user's decision 「minerals = the specimen site · the salvage pile bonus · the behemoth」): the **미확인 광물**
 * a salvage pile gives by chance on top. Chance · count are `GATHER_SALVAGE_MINERAL_*` in `data/constants.csv`. It rolls **separately** from the core, so one pile can give both.
 *
 * 2026-09-16 (the specimen overhaul): the fixed id constant `'spec_mineral'` here outlived its def's deletion.
 * `makeItem` silently returns null for an unknown id, so there was no crash — but the pile rolled its chance and handed
 * over nothing, a **dead feature**. So the constant is gone and it gives `mineralDefId(0)` below, the **lowest rarity**
 * 미확인 광물. Rolling the rarity is the vein's identity (the harvester's 채광 skill pushes the higher rarities), and the
 * salvage pile is a bonus yield — one roughest piece whatever the skill.
 */

/** A bonus result: at harvest one gather node puts in **just one more item**. */
interface NodeBonus { defId: string; qty: number }

/* ── The soil pile (greenhouse overhaul, 2026-09-11) ────────────────────────────
 * The greenhouse's grow station pours soil first and plants the seed on top. That soil comes **only from raid
 * gathering** and its tag differs per biome (`soils` · `soilNodes` in `data/planets.csv`, read in `world/soil.ts`) —
 * "go to Verdant III if you need 부엽토" holds from this file.
 *
 * As the salvage pile did, it **uses the herb node system unchanged**: placement · interaction · host-authoritative
 * sync (`harv`/`harvq`) · the harvest animation are all the same code; what differs is the variant mesh (a dug soil
 * mound) · the prompt verb (`채취`) · the pick time · the item drawn from the planet weights. The skill is **원예**
 * (a `gather:collected` whose kind is not 'salvage' means 원예 — `progression/`'s rule unchanged, not one line there). */
/** `variants` index of the soil pile mesh (0–2 = herb, 3 = salvage). */
const SOIL_VARIANT = 4;
/** Interaction radius of a soil pile (a dug mound, so the same as salvage). */
const SOIL_RADIUS = 2.6;
/**
 * Time to shovel one sack of soil. **It deliberately shares the salvage strip value** — so that no new number is
 * written in code (`data/constants.csv` is not this placement's to own). If soil ever needs its own, one constants.csv row.
 */
const SOIL_INTERACT_TIME = SALVAGE_INTERACT_TIME;
/** Minimum distance from a soil pile to another soil pile. */
const SOIL_SPACING = 14;
/** Minimum distance from a soil pile to any herb · salvage node. */
const SOIL_NODE_CLEARANCE = 5;
/** The steepest slope a soil mound can sit on — soil piles up on flat ground (stricter than herb 0.3 · salvage 0.32). */
const SOIL_MAX_SLOPE = 0.24;
/** The colour painted on an instance when the soil tag is unknown (items/ does not know that row yet). */
const SOIL_FALLBACK_COLOR = '#6b5a49';

/* ── The wild seed grove · the specimen gather site (lab placement, 2026-09-11) ─
 * The greenhouse's seeds and the analyzer's specimens are also **picked up in a raid**. Which varieties · which
 * specimens appear differs per planet (`seeds`/`seedNodes` · `samples`/`sampleNodes` in `data/planets.csv`, read in
 * `world/flora.ts` · `world/specimen.ts`), and as the soil pile did they **use the herb node system unchanged** —
 * placement · interaction · sync (`harv`/`harvq`) · harvest animation are the same code; only mesh · verb · time · draw differ.
 *
 * ⚠ Both roll **only from their own rng fork** (`gather_seed` · `gather_sample`). If a per-planet count shifted the
 * `gather` stream by even one step, the herb · salvage placement of the same seed would change wholesale (the same
 * trick as `gather_core` · `gather_soil` — `Random.fork` never advances the parent). */
/** `variants` index of the seed grove mesh (0–2 = herb, 3 = salvage, 4 = soil). */
const SEED_VARIANT = 5;
/** `variants` index of the 미확인 표본 mesh. */
const SAMPLE_VARIANT = 6;
/** Stalks one grove holds (1 anchor + offshoots). `seedNodes` is **the grove count**, so the real node count grows by this. */
const SEED_PATCH_MIN = 2;
const SEED_PATCH_MAX = 3;
/** Minimum spacing (m) between groves — only 4–5 groves per planet, so they are scattered generously. */
const SEED_SPACING = 18;
/** The ring (m) an offshoot sits on inside one grove. */
const SEED_PATCH_RING_MIN = 2.2;
const SEED_PATCH_RING_MAX = 4.2;
/** Minimum distance (m) from a seed grove to any other gather node. */
const SEED_NODE_CLEARANCE = 5;
/** Seed ripens on gentle grassland (stricter than herb 0.3, softer than soil 0.24). */
const SEED_MAX_SLOPE = 0.28;
/** Minimum spacing (m) between specimen gather sites. */
const SAMPLE_SPACING = 26;
/** Minimum distance (m) from a specimen gather site to any other gather node. */
const SAMPLE_NODE_CLEARANCE = 6;
/** The slope a specimen could have hardened on (the same as salvage — it may rest on wreckage). */
const SAMPLE_MAX_SLOPE = 0.32;
/** The ring outside a nest (pad radius 20 m) — placed inside, it is buried in the nest geometry. */
const SAMPLE_NEST_RING_MIN = 22;
const SAMPLE_NEST_RING_MAX = 34;
/** The ring around a POI ruin (wreckage) — a little wider than the salvage pile's (5–14 m) so they do not overlap. */
const SAMPLE_POI_RING_MIN = 7;
const SAMPLE_POI_RING_MAX = 17;

/* ── The planet 광맥 (2026-09-16 user's decision, 채광) ──────────────────────
 * The sixth gather node. Placement · interaction · host-authoritative sync (`harv` / `harvq`) · the harvest animation
 * are **not one line different** from the first five; only four things are:
 *   ① the variant mesh (an outcrop with crystals in it) + a **collider** — a vein really is a rock that blocks a body (the others are walked through).
 *   ② where it stands — only on a **slope** of `MINING_HILL_MIN_SLOPE` or steeper (user's decision 「mostly on hillsides」).
 *   ③ the yield — the rarity is rolled **at harvest**. The other nodes fix their item at generation, but a vein's rarity
 *      is pushed by **the harvester's 채광 skill** (`derived.miningRarityBonus`), so at generation there is no answer.
 *   ④ the skill — **채광**, not 원예 or 제작. So the vein uses `GatherNodeKind`'s sixth value `'mineral'`
 *      (2026-09-16). There is no exception path: it emits `gather:collected` exactly like the others, and the one
 *      place that reads kind to pick a skill is that handler in `ProgressionSystem`. With its own value, the NPC
 *      trust `gathered` mark · the map · the smokes all see the vein by the same path as the other five.
 */
/** `variants` index of the 광맥 mesh (0–2 = herb, 3 = salvage, 4 = soil, 5 = seed, 6 = specimen). */
const MINERAL_VARIANT = 7;
/**
 * The **cap** on the slope a vein stands on. Not a new number but 「the steepest ground reachable on foot」 as a tan —
 * the csv nails `IMPLANT_DASH_MAX_SLOPE_DEG` (50°) to the same value as the walking slope limit. A vein standing on a
 * cliff steeper than this would only be visible, never mineable.
 */
const MINERAL_MAX_SLOPE = Math.tan(THREE.MathUtils.degToRad(IMPLANT_DASH_MAX_SLOPE_DEG));
/**
 * A vein's interaction radius · spacing · distance to other gather nodes **deliberately share the specimen site's values**
 * (the same call as `SOIL_INTERACT_TIME` borrowing the salvage value): 3–7 per planet is a like count, and if the vein ever needs its own, one csv row then.
 */
const MINERAL_RADIUS = SAMPLE_NODE_RADIUS;
const MINERAL_SPACING = SAMPLE_SPACING;
const MINERAL_NODE_CLEARANCE = SAMPLE_NODE_CLEARANCE;
/**
 * The drawn outcrop's silhouette above ground (m) — **the collider uses this value as is** (`§4.4`: a collider measures
 * what is visible and does not count the buried part). Change `makeMineralGeometry`'s body size and change this too.
 */
const MINERAL_BODY_R = 0.95;
const MINERAL_BODY_H = 1.6;
/** The naming convention of 미확인 광물 item ids (`data/samples.csv`: Roman numeral = rarity index). The fallback while items/ does not know them. */
const MINERAL_ID_PREFIX = 'spec_mineral_';

interface Variant {
  meshes: THREE.InstancedMesh[];
  geometries: THREE.BufferGeometry[];
  glowMat: THREE.MeshStandardMaterial;
  count: number;
}

/** One placed cluster member: where it stands, which of the 3 shapes it uses and which herb it hands over. */
interface Spot {
  x: number; z: number; variant: number; defId: string; kind: GatherNodeKind;
  /**
   * 2026-09-09: a harvest mushroom planted along with a giant mushroom grove. **`variant` cannot tell it apart** —
   * `GROVE_PICK_VARIANT` is a shape number ordinary herbs use too, so judging by it catches every herb of that shape
   * as a grove mushroom (the ecosystem density assertion breaks right there). The planting side marks it.
   */
  grove?: boolean;
  /**
   * 2026-09-16: the vein. `kind` cannot tell it apart — `GatherNodeKind` has no vein value, so it uses `'sample'`
   * (the closest thing to true, since mining it yields a specimen). The placing side marks it.
   */
  vein?: boolean;
}

interface Node {
  def: GatherNodeDef;
  variant: number;
  kind: GatherNodeKind;
  slot: number;
  x: number; y: number; z: number;
  yaw: number;
  scale: number;
  /** -1 idle, else seconds since the harvest started (shrink animation). */
  anim: number;
  /** Client only: a `harvq take` is in flight. */
  pending: boolean;
  pendingAt: number;
  interactable: Interactable;
  /**
   * 2026-09-11 (C-20): the salvage pile's **bonus result** — fixed at generation from the mission seed (no wire, the same answer for everyone).
   * A world-internal value, so it is not on `GatherNodeDef`. An empty list = no bonus (herbs are always empty).
   * 2026-09-13: from one (the core) to a **list** — the core (`gather_core`) and 미확인 광물 (`gather_mineral`) roll separately and both can attach.
   * The order is fixed: core → mineral.
   */
  bonus: readonly NodeBonus[];
  /** 2026-09-16: is it a vein (the same meaning as `Spot.vein`). */
  vein?: boolean;
  /**
   * 2026-09-16: the vein's **collider**. A vein is a rock that blocks a body, so it goes into the hash — and leaves it
   * when the vein is mined away (the mesh must not shrink to nothing and leave an invisible wall behind).
   */
  obstacle?: ObstacleEntry;
}

/**
 * Harvestable gather nodes scattered over the map — herb plants and, since 2026-09-08, salvage piles.
 *
 * - `GATHER_NODES_PER_MISSION` procedural plants in 3 variants plus `SALVAGE_NODES_PER_MISSION` salvage piles
 *   (variant `SALVAGE_VARIANT`), drawn with one `InstancedMesh` per part (2 parts per variant → 8 draw calls
 *   total) so the whole set costs nothing. `GatherNodeDef.kind` says which a node is; salvage piles hand over
 *   `mat_scrap`, take `SALVAGE_INTERACT_TIME` to strip, ignore the gather yield multiplier and grant 제작 XP.
 * - Each node registers an `Interactable` with `holdTime = GATHER_INTERACT_TIME` (the player scales holds by `derived.interactSpeedMul`).
 * - Harvesting emits `gather:collected` and then hands the herb to `ctx.inventory.tryAddItem`
 *   (quantity scaled by `derived.gatherYieldMul`).
 * - Multiplayer is host-authoritative, mirroring pickups: clients send `harvq take/sync`, the host answers with
 *   `harv taken/sync`. Node ids/positions are deterministic from the mission seed, so only the id travels.
 */
export class Gather {
  readonly group = new THREE.Group();
  private variants: Variant[] = [];
  private bodyMat: THREE.MeshStandardMaterial | null = null;
  /**
   * The body material for soil piles only. It is split from `bodyMat` because of **instance colour** (`setColorAt`) —
   * a soil mound must differ in colour per tag, and a mesh carrying `instanceColor` gets a different shader program.
   * Sharing one material with herbs · salvage would split their program too and waste the pre-compile (`ctx.shaders`).
   */
  private soilMat: THREE.MeshStandardMaterial | null = null;
  private readonly nodes: Node[] = [];
  private readonly byId = new Map<string, Node>();
  private readonly defs: GatherNodeDef[] = [];
  private game: GameContext | null = null;
  private netHooked = false;
  private readonly unsubs: Array<() => void> = [];
  private matrixDirty = false;
  private built = false;
  /* ── The vein (2026-09-16) ── */
  /** Removing the collider needs the hash (a harvest happens long after the build finished). */
  private hash: SpatialHash | null = null;
  /** This planet's rarity weights (the `tier = threat` row). null on a planet with no veins. */
  private mineralWeights: RarityWeights | null = null;
  /** Rarity index (`RARITY_ORDER`) → 미확인 광물 item id. A rarity items/ does not know is null. */
  private mineralIds: readonly (string | null)[] = [];
  /**
   * The random stream that rolls the rarity at harvest. The result depends on **the harvester's skill**, so it differs
   * per client anyway and the yield goes only to whoever mined it — forked from the mission seed but never synced.
   */
  private mineralRoll: Random | null = null;

  constructor() { this.group.name = 'GatherNodes'; }

  /* ── lifecycle ─────────────────────────────────────────────────────── */

  /** Called once from `WorldSystem.init`; net hooks are attached lazily (NetSystem publishes `ctx.net` first). */
  attach(game: GameContext): void {
    this.game = game;
    this.ensureNet();
  }

  getNodes(): readonly GatherNodeDef[] { return this.defs; }

  /**
   * `eco` (Phase 11): the target planet's ecosystem — `eco.herbs` are relative weights **by herb def id** (replacing the
   * old uniform "one herb per plant shape") and `eco.gatherDensity` scales `GATHER_NODES_PER_MISSION`.
   * null (no planet / an unknown id) reproduces the pre-Phase-11 placement draw exactly for the same seed.
   */
  build(
    ctx: BuildCtx, game: GameContext, eco: PlanetEcosystem | null = null,
    groves: ReadonlyArray<{ x: number; z: number }> = [],
    planetId: string | null = null,
  ): void {
    this.game = game;
    this.ensureNet();
    const rng = ctx.rng.fork('gather');
    const herbIds = this.resolveHerbIds(game);
    const weights = this.resolveHerbWeights(herbIds, eco);
    const target = this.nodeTarget(eco);
    /* 2026-09-11 (greenhouse overhaul): soil rolls **only from its own fork** — if the soil mound's geometry · placement ·
     * colour shifted the `gather` stream by one step, the same seed's herb · salvage layout would change wholesale (the `gather_core` trick). */
    const soil = planetSoil(planetId);
    const soilTarget = soil ? soil.nodes : 0;
    const soilRng = ctx.rng.fork('gather_soil');
    const soilWeights = soil ? this.resolveNodeWeights(game, soil.weights, 'soil', 'soil_') : null;
    /* 2026-09-11 (lab A-11 · A-12): seed · specimen each have their own fork too — the same reason as soil, and the
     * three do not shift one another's streams either (a planet commonly has only two of the three). */
    const seeds = planetSeeds(planetId);
    const seedTarget = seeds ? seeds.nodes : 0;
    const seedRng = ctx.rng.fork('gather_seed');
    const seedWeights = seeds ? this.resolveNodeWeights(game, seeds.weights, 'seed', 'seed_') : null;
    const samples = planetSamples(planetId);
    const sampleTarget = samples ? samples.nodes : 0;
    const sampleRng = ctx.rng.fork('gather_sample');
    const sampleWeights = samples ? this.resolveNodeWeights(game, samples.weights, 'sample', 'spec_') : null;
    /* 2026-09-16 (the planet vein): the vein has **its own fork** too — a per-planet vein count shifts none of the
     * streams before it (the `gather_soil` · `gather_seed` · `gather_sample` trick). The random stream that rolls the
     * rarity at harvest is a further branch beside it (`gather_vein_roll`), so how many veins were mined never shakes the placement stream. */
    const mineralTarget = planetMineralNodes(planetId);
    const veinQtyMin = Math.max(1, Math.round(MINING_YIELD_MIN));
    const veinQtyMax = Math.max(veinQtyMin, Math.round(MINING_YIELD_MAX));
    const veinRng = ctx.rng.fork('gather_vein');
    this.mineralRoll = ctx.rng.fork('gather_vein_roll');
    this.mineralWeights = mineralTarget > 0 ? mineralRarityWeights(getPlanet(planetId)?.threat ?? 1) : null;
    this.mineralIds = mineralTarget > 0 ? this.resolveMineralIds(game) : [];
    this.hash = ctx.hash;

    this.bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0.0, side: THREE.DoubleSide });
    // soil is matte, as if damp, and uses no back faces (one dome + clods, so every surface is closed)
    this.soilMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.0 });

    // variants 0–2 are the plant shapes, 3 the salvage pile, 4 the soil pile, 5 the seed grove, 6 the 미확인 표본
    // — each mesh is sized for its own node budget
    const salvageTarget = SALVAGE_NODES_PER_MISSION;
    // 2026-09-09: the harvest mushrooms around a giant grove are all spore caps (variant 1), so only that variant takes extra slots
    const groveExtra = groves.length * GROVE_PICKS_MAX;
    const capacityOf = (k: number): number => (
      k === SALVAGE_VARIANT ? salvageTarget : k === SOIL_VARIANT ? soilTarget
        : k === SEED_VARIANT ? seedTarget * SEED_PATCH_MAX : k === SAMPLE_VARIANT ? sampleTarget
          : k === MINERAL_VARIANT ? mineralTarget
            : k === GROVE_PICK_VARIANT ? target + groveExtra : target
    );
    const variantRng = (k: number): Random => (
      k === SOIL_VARIANT ? soilRng : k === SEED_VARIANT ? seedRng : k === SAMPLE_VARIANT ? sampleRng
        : k === MINERAL_VARIANT ? veinRng : rng
    );
    for (let k = 0; k <= MINERAL_VARIANT; k++) {
      const glowMat = new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 0.35, metalness: 0.0,
        emissive: new THREE.Color(GLOW_COLORS[k]), emissiveIntensity: 1.1,
      });
      const geos = this.makeVariantGeometry(k, ctx, variantRng(k));
      const meshes: THREE.InstancedMesh[] = [];
      const mat = k === SOIL_VARIANT ? this.soilMat : this.bodyMat;
      const bodyIm = new THREE.InstancedMesh(geos[0], mat, Math.max(1, capacityOf(k)));
      const glowIm = new THREE.InstancedMesh(geos[1], glowMat, Math.max(1, capacityOf(k)));
      for (const im of [bodyIm, glowIm]) {
        im.name = k === SALVAGE_VARIANT ? 'gather_salvage' : k === SOIL_VARIANT ? 'gather_soil'
          : k === SEED_VARIANT ? 'gather_seed' : k === SAMPLE_VARIANT ? 'gather_sample'
            : k === MINERAL_VARIANT ? 'gather_vein' : `gather_plant_${k}`;
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        im.castShadow = false;
        im.receiveShadow = false;
        im.frustumCulled = false;
        im.layers.enable(Layers.INTERACTABLE);
        im.count = 0;
        meshes.push(im);
      }
      this.variants.push({ meshes, geometries: geos, glowMat, count: 0 });
    }

    // ── placement: sparse clusters on gentle, unoccupied ground ──────────
    const spots: Spot[] = [];
    const spacing2 = MIN_SPACING * MIN_SPACING;
    const free = (x: number, z: number, near: number): boolean => {
      if (!isSpotFree(ctx, x, z, 0.7, { maxSlope: 0.3, padExtra: 3 })) return false;
      for (let i = 0; i < spots.length; i++) {
        const dx = spots[i].x - x, dz = spots[i].z - z;
        if (dx * dx + dz * dz < near) return false;
      }
      return true;
    };
    for (let a = 0; a < 5000 && spots.length < target; a++) {
      const x = rng.range(-PLAY_LIMIT + 8, PLAY_LIMIT - 8);
      const z = rng.range(-PLAY_LIMIT + 8, PLAY_LIMIT - 8);
      if (!free(x, z, spacing2)) continue;
      const variant = rng.int(0, 2);
      // Phase 11: the plant **shape** (`variant`) and the **herb it drops** (`defId`) are independent draws now — the
      // shape is cosmetic, the herb comes from the planet's weights. With no planet the old `herbIds[variant]` pairing
      // is used verbatim so the rng stream (and therefore the whole layout) is byte-identical to before.
      const defId = weights ? this.pickHerb(weights, rng) : herbIds[variant % herbIds.length];
      spots.push({ x, z, variant, defId, kind: 'herb' });
      // small cluster of the same herb so gathering feels like finding a patch
      const extra = rng.chance(0.55) ? rng.int(1, 2) : 0;
      for (let c = 0; c < extra && spots.length < target; c++) {
        const ang = rng.range(0, Math.PI * 2), d = rng.range(2.2, 4.2);
        const cx = x + Math.cos(ang) * d, cz = z + Math.sin(ang) * d;
        if (free(cx, cz, 1.6 * 1.6)) spots.push({ x: cx, z: cz, variant, defId, kind: 'herb' });
      }
    }

    // ── Salvage piles (2026-09-08): around POIs first, the rest in the open ──────
    // Drawn **after** the plant placement finished, so the herb layout of the same seed is byte-identical to before.
    {
      const salvageSpots: Spot[] = [];
      const freeSalvage = (x: number, z: number): boolean => {
        if (!isSpotFree(ctx, x, z, 1.1, { maxSlope: 0.32, padExtra: 4 })) return false;
        const near = SALVAGE_SPACING * SALVAGE_SPACING;
        for (const p of salvageSpots) if ((p.x - x) ** 2 + (p.z - z) ** 2 < near) return false;
        for (const p of spots) if ((p.x - x) ** 2 + (p.z - z) ** 2 < 5 * 5) return false;
        return true;
      };
      const push = (x: number, z: number): boolean => {
        if (!freeSalvage(x, z)) return false;
        salvageSpots.push({ x, z, variant: SALVAGE_VARIANT, defId: SALVAGE_DEF_ID, kind: 'salvage' });
        return true;
      };
      for (const poi of ctx.layout.pois) {
        if (salvageSpots.length >= salvageTarget) break;
        for (let a = 0; a < 24; a++) {
          const ang = rng.range(0, Math.PI * 2), d = rng.range(5, 14);
          if (push(poi.x + Math.cos(ang) * d, poi.z + Math.sin(ang) * d)) break;
        }
      }
      for (let a = 0; a < 3000 && salvageSpots.length < salvageTarget; a++) {
        push(rng.range(-PLAY_LIMIT + 12, PLAY_LIMIT - 12), rng.range(-PLAY_LIMIT + 12, PLAY_LIMIT - 12));
      }
      spots.push(...salvageSpots);
    }

    /* ── The harvest mushrooms of a giant grove (2026-09-09) ──────────────────
     * The grove itself is built by `world/Hazard` (its stems are already in the hash). All that happens here is
     * planting **harvestable mushrooms** on the ring around it; node · interaction · host-authoritative sync are the
     * herb code unchanged. By the salvage pile's trick it is drawn **after the herb · salvage placement**, so it shifts no earlier rng stream. */
    if (groves.length > 0) {
      const groveSpots: Spot[] = [];
      const clear = (x: number, z: number): boolean => {
        if (!isSpotFree(ctx, x, z, 0.7, { maxSlope: 0.34, padExtra: 3 })) return false;
        for (const p of spots) if ((p.x - x) ** 2 + (p.z - z) ** 2 < 2.6 * 2.6) return false;
        for (const p of groveSpots) if ((p.x - x) ** 2 + (p.z - z) ** 2 < 2.6 * 2.6) return false;
        return true;
      };
      for (const g of groves) {
        const want = rng.int(GROVE_PICKS_MIN, GROVE_PICKS_MAX);
        // one grove, one kind — the same rule as an herb cluster (drawn from the planet weights when there are any)
        const defId = weights ? this.pickHerb(weights, rng) : herbIds[GROVE_PICK_VARIANT % herbIds.length];
        let placed = 0;
        for (let a = 0; a < 80 && placed < want; a++) {
          const ang = rng.range(0, Math.PI * 2);
          const d = rng.range(GROVE_PICK_RING_MIN, GROVE_PICK_RING_MAX);
          const x = g.x + Math.cos(ang) * d, z = g.z + Math.sin(ang) * d;
          if (!clear(x, z)) continue;
          groveSpots.push({ x, z, variant: GROVE_PICK_VARIANT, defId, kind: 'herb', grove: true });
          placed++;
        }
      }
      spots.push(...groveSpots);
    }

    /* ── Soil piles (greenhouse overhaul, 2026-09-11) ──────────────────────────
     * Count · kind all come from `data/planets.csv` (`world/soil.ts`). Soil piles up in the **lowlands** where water
     * used to gather, so basins (`layout.basins`) are aimed at first and the open field takes the rest. Placement and
     * draw are all `soilRng`, so the `gather` stream of herbs · salvage · groves never shifts a step — the same seed's old gather placement is unchanged.
     * Spot · kind are functions of the mission seed, so there is **no wire** (only harvest sync rides the existing `harv`/`harvq`). */
    if (soilTarget > 0 && soilWeights) {
      const soilSpots: Spot[] = [];
      const near2 = SOIL_SPACING * SOIL_SPACING;
      const clear2 = SOIL_NODE_CLEARANCE * SOIL_NODE_CLEARANCE;
      const push = (x: number, z: number): boolean => {
        if (!isSpotFree(ctx, x, z, 1.1, { maxSlope: SOIL_MAX_SLOPE, padExtra: 4 })) return false;
        for (const p of soilSpots) if ((p.x - x) ** 2 + (p.z - z) ** 2 < near2) return false;
        for (const p of spots) if ((p.x - x) ** 2 + (p.z - z) ** 2 < clear2) return false;
        soilSpots.push({ x, z, variant: SOIL_VARIANT, defId: this.pickHerb(soilWeights, soilRng), kind: 'soil' });
        return true;
      };
      const basins = ctx.layout.basins;
      for (let n = 0; n < soilTarget; n++) {
        let placed = false;
        if (basins.length > 0) {
          for (let a = 0; a < 24 && !placed; a++) {
            const b = basins[soilRng.int(0, basins.length - 1)];
            const ang = soilRng.range(0, Math.PI * 2), d = soilRng.range(0, b.radius * 0.85);
            placed = push(b.x + Math.cos(ang) * d, b.z + Math.sin(ang) * d);
          }
        }
        for (let a = 0; a < 120 && !placed; a++) {
          placed = push(soilRng.range(-PLAY_LIMIT + 12, PLAY_LIMIT - 12), soilRng.range(-PLAY_LIMIT + 12, PLAY_LIMIT - 12));
        }
      }
      spots.push(...soilSpots);
    }

    /* ── Wild seed groves (lab A-11, 2026-09-11) ───────────────────────────────
     * Count (of groves) · variety all come from `data/planets.csv` (`world/flora.ts`). Seed ripens on **grassland ·
     * lowland** with water and sun, so basins (`layout.basins`) are aimed at first and gentle open ground takes the
     * rest (the same grain as the soil mound, but a slightly softer slope bar and standing further apart). One grove is
     * an anchor stalk + 1–2 offshoots, **all the same variety** — the herb cluster rule, so it reads as "one bush stripped".
     * Draw · placement are all `seedRng`, so no earlier stream shifts. */
    if (seedTarget > 0 && seedWeights) {
      const seedSpots: Spot[] = [];
      const near2 = SEED_SPACING * SEED_SPACING;
      const clear2 = SEED_NODE_CLEARANCE * SEED_NODE_CLEARANCE;
      const free = (x: number, z: number, near: number): boolean => {
        if (!isSpotFree(ctx, x, z, 0.8, { maxSlope: SEED_MAX_SLOPE, padExtra: 3 })) return false;
        for (const p of seedSpots) if ((p.x - x) ** 2 + (p.z - z) ** 2 < near) return false;
        for (const p of spots) if ((p.x - x) ** 2 + (p.z - z) ** 2 < clear2) return false;
        return true;
      };
      const basins = ctx.layout.basins;
      for (let n = 0; n < seedTarget; n++) {
        const defId = this.pickHerb(seedWeights, seedRng);
        let anchor: { x: number; z: number } | null = null;
        if (basins.length > 0) {
          for (let a = 0; a < 24 && !anchor; a++) {
            const b = basins[seedRng.int(0, basins.length - 1)];
            const ang = seedRng.range(0, Math.PI * 2), d = seedRng.range(0, b.radius * 0.9);
            const x = b.x + Math.cos(ang) * d, z = b.z + Math.sin(ang) * d;
            if (free(x, z, near2)) anchor = { x, z };
          }
        }
        for (let a = 0; a < 120 && !anchor; a++) {
          const x = seedRng.range(-PLAY_LIMIT + 12, PLAY_LIMIT - 12);
          const z = seedRng.range(-PLAY_LIMIT + 12, PLAY_LIMIT - 12);
          if (free(x, z, near2)) anchor = { x, z };
        }
        if (!anchor) continue;
        seedSpots.push({ x: anchor.x, z: anchor.z, variant: SEED_VARIANT, defId, kind: 'seed' });
        const want = seedRng.int(SEED_PATCH_MIN, SEED_PATCH_MAX) - 1;
        for (let c = 0; c < want; c++) {
          const ang = seedRng.range(0, Math.PI * 2);
          const d = seedRng.range(SEED_PATCH_RING_MIN, SEED_PATCH_RING_MAX);
          const x = anchor.x + Math.cos(ang) * d, z = anchor.z + Math.sin(ang) * d;
          // offshoots may stand close together (they are one bush) — only the grove spacing is kept
          if (free(x, z, 1.8 * 1.8)) seedSpots.push({ x, z, variant: SEED_VARIANT, defId, kind: 'seed' });
        }
      }
      spots.push(...seedSpots);
    }

    /* ── Specimen gather sites (lab A-12, 2026-09-11) ───────────────────────────
     * A specimen is left **where something lived or died** — the ring outside a nest (moults · eggshells) and around a
     * POI ruin (resin or crystal hardened on the wreckage) are aimed at first, and only the rest is scattered in the
     * open. Count · kind come from `data/planets.csv` (`world/specimen.ts`); draw · placement are all `sampleRng`. */
    if (sampleTarget > 0 && sampleWeights) {
      const sampleSpots: Spot[] = [];
      const near2 = SAMPLE_SPACING * SAMPLE_SPACING;
      const clear2 = SAMPLE_NODE_CLEARANCE * SAMPLE_NODE_CLEARANCE;
      const push = (x: number, z: number): boolean => {
        if (!isSpotFree(ctx, x, z, 1.0, { maxSlope: SAMPLE_MAX_SLOPE, padExtra: 4 })) return false;
        for (const p of sampleSpots) if ((p.x - x) ** 2 + (p.z - z) ** 2 < near2) return false;
        for (const p of spots) if ((p.x - x) ** 2 + (p.z - z) ** 2 < clear2) return false;
        sampleSpots.push({
          x, z, variant: SAMPLE_VARIANT, defId: this.pickHerb(sampleWeights, sampleRng), kind: 'sample',
        });
        return true;
      };
      const ring = (cx: number, cz: number, lo: number, hi: number, tries: number): boolean => {
        for (let a = 0; a < tries; a++) {
          const ang = sampleRng.range(0, Math.PI * 2), d = sampleRng.range(lo, hi);
          if (push(cx + Math.cos(ang) * d, cz + Math.sin(ang) * d)) return true;
        }
        return false;
      };
      for (const nest of ctx.layout.nests) {
        if (sampleSpots.length >= sampleTarget) break;
        ring(nest.x, nest.z, SAMPLE_NEST_RING_MIN, SAMPLE_NEST_RING_MAX, 24);
      }
      for (const poi of ctx.layout.pois) {
        if (sampleSpots.length >= sampleTarget) break;
        ring(poi.x, poi.z, SAMPLE_POI_RING_MIN, SAMPLE_POI_RING_MAX, 24);
      }
      for (let a = 0; a < 600 && sampleSpots.length < sampleTarget; a++) {
        push(sampleRng.range(-PLAY_LIMIT + 12, PLAY_LIMIT - 12), sampleRng.range(-PLAY_LIMIT + 12, PLAY_LIMIT - 12));
      }
      spots.push(...sampleSpots);
    }

    /* ── Planet 광맥 (2026-09-16 user's decision, 채광) ────────────────────────
     * The count is `mineralNodes` in `data/planets.csv` (`world/mineral.ts`). The user's decision 「mostly on hillsides」
     * is this block's **only** special rule: spots are drawn by rejection sampling over open ground, but only cells
     * with `getSlopeAt >= MINING_HILL_MIN_SLOPE` pass (no vein stands on flat ground at all). The upper limit
     * `MINERAL_MAX_SLOPE` is the steepest ground reachable on foot, so every visible vein can be mined.
     *
     * `isSpotFree` filters out pads · the **rail corridor** (`railClearance`) · the **rover corridor**
     * (`roverClearance`) · every collider already standing (§4.4's placement order convention — the vein comes last, so
     * structures · rails · roads · forest are already in the hash). A structure's doorway approach was cleared by
     * `Structures` with `clearFor` and a collider holds that spot, so the same one `isSpotFree` line blocks the door too. */
    if (mineralTarget > 0) {
      const veinSpots: Spot[] = [];
      const near2 = MINERAL_SPACING * MINERAL_SPACING;
      const clear2 = MINERAL_NODE_CLEARANCE * MINERAL_NODE_CLEARANCE;
      const push = (x: number, z: number): boolean => {
        // hillsides only — this one line enforces the user's decision (the number is csv's MINING_HILL_MIN_SLOPE)
        if (ctx.terrain.getSlopeAt(x, z) < MINING_HILL_MIN_SLOPE) return false;
        if (!isSpotFree(ctx, x, z, MINERAL_BODY_R, { maxSlope: MINERAL_MAX_SLOPE, padExtra: 4 })) return false;
        for (const p of veinSpots) if ((p.x - x) ** 2 + (p.z - z) ** 2 < near2) return false;
        for (const p of spots) if ((p.x - x) ** 2 + (p.z - z) ** 2 < clear2) return false;
        /* `defId` is only **the family's anchor** (common-rarity 미확인 광물). The rarity that actually comes out is
           rolled at the moment of mining, from the harvester's 채광 skill — at generation there is no answer. The prompt does not read this id either. */
        veinSpots.push({ x, z, variant: MINERAL_VARIANT, defId: this.mineralDefId(0), kind: 'mineral' });
        return true;
      };
      for (let a = 0; a < 6000 && veinSpots.length < mineralTarget; a++) {
        push(veinRng.range(-PLAY_LIMIT + 12, PLAY_LIMIT - 12), veinRng.range(-PLAY_LIMIT + 12, PLAY_LIMIT - 12));
      }
      spots.push(...veinSpots);
    }

    /* 2026-09-11 (C-20): the bonus core rolls from **its own fork** — drawn from `rng` (gather) it would shift the yaw ·
     * scale · quantity draws after it by one step and change the look of the same seed's nodes. `Random.fork` never advances the parent. */
    const coreRng = ctx.rng.fork('gather_core');
    /* 2026-09-13: the bonus 미확인 광물 has **its own fork** too — drawn from `gather_core`, the core roll would shift by one step
     * from the second pile on and change which piles carry a core for the same seed. A fork does not advance the parent (`ctx.rng`), so this line touches no other stream. */
    const mineralRng = ctx.rng.fork('gather_mineral');
    const coreQty = Math.max(0, Math.round(GATHER_SALVAGE_CORE_QTY));
    const mineralQty = Math.max(0, Math.round(GATHER_SALVAGE_MINERAL_QTY));
    let id = 0;
    for (const s of spots) {
      const v = this.variants[s.variant];
      if (v.count >= capacityOf(s.variant)) continue;
      const y = ctx.terrain.getHeightAt(s.x, s.z);
      const salvage = s.kind === 'salvage';
      const isSoil = s.kind === 'soil';
      const isSeed = s.kind === 'seed';
      const isVein = s.kind === 'mineral';
      const isSample = s.kind === 'sample';
      /* As with placement, soil draws yaw · scale from **its own fork** — soil spots come last so they shift nothing
         before them, but the fork is needed here too so the soil mound count (which differs per planet) cannot change
         the length of the `gather` stream. The 2026-09-11 seed · specimen have their own forks for the same reason. */
      const r = isSoil ? soilRng : isSeed ? seedRng : isVein ? veinRng : isSample ? sampleRng : rng;
      const yaw = r.range(0, Math.PI * 2);
      const scale = salvage ? r.range(0.9, 1.15)
        : isSoil ? r.range(0.85, 1.2)
          : isSeed ? r.range(0.9, 1.25)
            // a vein is an outcrop, so its size range is wide — it has to stand out from across a slope
            : isVein ? r.range(0.85, 1.25)
              : isSample ? r.range(0.85, 1.15) : r.range(0.85, 1.3);
      const def: GatherNodeDef = {
        /* 2026-09-09: a grove mushroom is told apart by `grove_` — its kind stays herb (원예 XP), but whoever counts
           "ecosystem density" (the map · the smokes) has to split the two. Grove spots are at the **very end** of
           spots, so not one character of the existing herb · salvage ids changes. The 2026-09-11 soil pile (`soil_`)
           follows them, and seed (`seed_`) · specimen (`sample_`) follow that again. */
        // 2026-09-16: the vein is `vein_` — at the **very end** of spots, so not one character of the five ids before it changes
        id: salvage ? `salvage_${id++}`
          : isSoil ? `soil_${id++}`
            : isSeed ? `seed_${id++}`
              : isVein ? `vein_${id++}`
                : isSample ? `sample_${id++}`
                  : s.grove ? `grove_${id++}` : `gather_${id++}`,
        position: new THREE.Vector3(s.x, y, s.z),
        defId: s.defId,
        // Salvage: 1 scrap, 2 on `GATHER_SALVAGE_QTY2_CHANCE`. Herb: 2 on `GATHER_HERB_QTY2_CHANCE`.
        // 2026-09-11 (C-20): the old hard-coded 0.3 / 0.25 moved into csv — the same values, so rng use and result are unchanged.
        // Soil: exactly one sack per pile (one sack survives `ItemDef.soil.uses` harvests — the depth lives over there).
        // Seed: one grain per stalk (a grove is several stalks, so one bush gives 2–3 grains + the 원예 yield multiplies).
        // Specimen: a single lump, so a fixed 1 and the yield does not multiply it (the same call as salvage — see `collect`).
        // Vein (2026-09-16): `MINING_YIELD_MIN`…`MAX`, uniform integer. Rolled **separately** from the rarity (the count is
        // fixed to the spot; only the rarity rides the harvester's skill). The gather yield (`gatherYieldMul`) multiplies it as for herbs — see `collect`.
        qty: isVein ? veinRng.int(veinQtyMin, veinQtyMax)
          : isSoil || isSeed || isSample ? 1
            : salvage ? (rng.chance(GATHER_SALVAGE_QTY2_CHANCE) ? 2 : 1) : (rng.chance(GATHER_HERB_QTY2_CHANCE) ? 2 : 1),
        harvested: false,
        kind: s.kind,
      };
      /* Per salvage pile: one core roll · one mineral roll, **always** taken from their own forks (the roll is consumed
         even when the count is 0 — the same consumption as the old core form `chance(...) && qty > 0`, so the `gather_core` stream stays byte-identical). */
      const bonus: NodeBonus[] = [];
      if (salvage) {
        if (coreRng.chance(GATHER_SALVAGE_CORE_CHANCE) && coreQty > 0) bonus.push({ defId: SALVAGE_CORE_DEF_ID, qty: coreQty });
        if (mineralRng.chance(GATHER_SALVAGE_MINERAL_CHANCE) && mineralQty > 0) bonus.push({ defId: this.mineralDefId(0), qty: mineralQty });
      }
      const node: Node = {
        def, variant: s.variant, kind: s.kind, slot: v.count,
        x: s.x, y, z: s.z, yaw, scale, anim: -1, pending: false, pendingAt: -Infinity,
        interactable: null as unknown as Interactable,
        bonus,
        vein: isVein,
      };
      /* Only the vein carries a collider (the other nodes are grass · piles and are walked through). One cylinder — the
         drawn outcrop is roughly axisymmetric, so it does not disagree with the silhouette (§4.4: a collider measures
         **only what shows above ground**. The outcrop body reaches below y<0, but that part is buried and is not counted). `position.y` is its bottom face. */
      if (isVein) {
        node.obstacle = ctx.hash.add(
          new THREE.Vector3(s.x, y, s.z), MINERAL_BODY_R * scale, MINERAL_BODY_H * scale, 'crystal',
        );
      }
      node.interactable = this.makeInteractable(node);
      this.writeMatrix(node, 1);
      // a soil mound's colour is its **tag** (부엽토 · 화산재토 · 동토 이탄 · 광물토) — the same mesh is painted by instance colour
      if (isSoil) this.paintSoilInstance(game, v, node.slot, s.defId);
      v.count++;
      this.nodes.push(node);
      this.byId.set(def.id, node);
      this.defs.push(def);
      game.interactables.register(node.interactable);
    }

    for (const v of this.variants) {
      for (const im of v.meshes) {
        im.count = v.count;
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
        if (v.count > 0) this.group.add(im);
      }
    }
    this.built = true;
    ctx.root.add(this.group);

    // (re)joining client: ask the host which nodes are already gone
    this.requestSync();
  }

  update(dt: number, time: number): void {
    if (!this.built) return;
    for (let k = 0; k < this.variants.length; k++) {
      const v = this.variants[k];
      v.glowMat.emissiveIntensity = 0.75 + 0.4 * Math.sin(time * 1.5 + k * 2.1) + 0.12 * Math.sin(time * 4.7 + k);
    }
    const now = this.game?.time ?? time;
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      if (n.pending && now - n.pendingAt > PENDING_TIMEOUT) n.pending = false;
      if (n.anim < 0) continue;
      n.anim += dt;
      const t = Math.min(1, n.anim / HARVEST_ANIM);
      this.writeMatrix(n, 1 - t);
      if (t >= 1) n.anim = -1;
    }
    if (this.matrixDirty) {
      for (const v of this.variants) for (const im of v.meshes) im.instanceMatrix.needsUpdate = true;
      this.matrixDirty = false;
    }
  }

  dispose(): void {
    const game = this.game;
    for (const n of this.nodes) {
      game?.interactables.unregister(n.interactable.id);
      // drop the reference to the vein collider (the hash itself is emptied wholesale by `WorldSystem.clear`)
      n.obstacle = undefined;
    }
    this.nodes.length = 0;
    this.byId.clear();
    this.defs.length = 0;
    for (const v of this.variants) {
      for (const im of v.meshes) { this.group.remove(im); im.dispose(); }
      for (const g of v.geometries) g.dispose();
      v.glowMat.dispose();
    }
    this.variants.length = 0;
    this.bodyMat?.dispose();
    this.bodyMat = null;
    this.soilMat?.dispose();
    this.soilMat = null;
    this.hash = null;
    this.mineralWeights = null;
    this.mineralIds = [];
    this.mineralRoll = null;
    this.group.removeFromParent();
    this.built = false;
  }

  /** Unhook net listeners (system dispose only — `clear()` between missions keeps them). */
  detach(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.netHooked = false;
    this.game = null;
  }

  /* ── harvesting ────────────────────────────────────────────────────── */

  private makeInteractable(node: Node): Interactable {
    const game = () => this.game;
    // 2026-09-08: a salvage pile takes longer and reads `해체` — every other rule is the herb's
    // 2026-09-11: a soil pile is `채취` — the three split by one word each (약초 채집 · 고철 해체 · 토양 채취)
    // 2026-09-11 (lab): a seed grove is `채취` like soil, a 미확인 표본 is `수습` (user's decision) —
    // five kinds split across four words (약초 채집 · 고철 해체 · 토양/씨앗 채취 · 표본 수습).
    // 2026-09-16: the vein is `채굴` — six kinds across five words (채집 · 해체 · 채취 · 수습 · 채굴).
    const salvage = node.kind === 'salvage';
    const soil = node.kind === 'soil';
    const seed = node.kind === 'seed';
    const vein = node.kind === 'mineral';
    const sample = node.kind === 'sample';
    const verb = salvage ? '해체' : vein ? '채굴' : sample ? '수습' : soil || seed ? '채취' : '채집';
    return {
      id: `gather:${node.def.id}`,
      position: node.def.position,
      // base hold; the player applies `derived.interactSpeedMul` to every hold (Phase 5)
      holdTime: salvage ? SALVAGE_INTERACT_TIME
        : soil ? SOIL_INTERACT_TIME
          : seed ? SEED_INTERACT_TIME
            : vein ? MINING_NODE_HOLD_S
              : sample ? SAMPLE_INTERACT_TIME : GATHER_INTERACT_TIME,
      radius: salvage ? SALVAGE_RADIUS
        : soil ? SOIL_RADIUS
          : seed ? SEED_NODE_RADIUS
            : vein ? MINERAL_RADIUS
              : sample ? SAMPLE_NODE_RADIUS : NODE_RADIUS,
      getPrompt: () => {
        if (node.def.harvested) return null;
        /* The vein alone does not use the item's name — which rarity comes out is known **only by mining it**
           (`def.defId` is just the family's anchor, so reading it would lie 「미확인 광물 I」). */
        if (vein) return node.pending ? `광맥 ${verb} 중…` : `광맥 ${verb} (E)`;
        const fallback = salvage ? '고철' : soil ? '토양' : seed ? '씨앗' : sample ? '표본' : '약초';
        const name = this.game?.loot?.getItemDef(node.def.defId)?.name ?? fallback;
        return node.pending ? `${name} ${verb} 중…` : `${name} ${verb} (E)`;
      },
      canInteract: () => {
        const g = this.game;
        return !!g && g.isGameplayActive() && !node.def.harvested && !node.pending;
      },
      interact: () => this.onInteract(node),
    };
  }

  private onInteract(node: Node): void {
    const ctx = this.game;
    if (!ctx || node.def.harvested || node.pending) return;
    const net = ctx.net;
    if (ctx.isMultiplayer && net && !net.isHost) {
      node.pending = true;
      node.pendingAt = ctx.time;
      net.send({ t: 'harvq', ev: 'take', id: node.def.id }, 'host');
      return;
    }
    const by: string = net?.localId ?? 'local';
    this.collect(node, by, true);
    if (ctx.isMultiplayer && net) net.send({ t: 'harv', ev: 'taken', id: node.def.id, by }, 'others');
  }

  /** Mark the node consumed; `award` → the local player gets the herb and `gather:collected` fires. */
  private collect(node: Node, _by: string, award: boolean): void {
    const ctx = this.game;
    if (!ctx || node.def.harvested) return;
    node.def.harvested = true;
    node.pending = false;
    node.anim = 0;
    ctx.interactables.unregister(node.interactable.id);
    /* The vein's collider is removed **whoever mined it** (a remote harvest passes through here too) — no invisible
       rock may be left where the outcrop shrank away. The hash is emptied wholesale at mission end, so this removal is the only one needed. */
    if (node.obstacle) { this.hash?.remove(node.obstacle); node.obstacle = undefined; }
    if (!award) return;

    /* ── The vein (2026-09-16 user's decision, 채광) ─────────────────────────
     * The only harvest path that splits from the other gather nodes.
     *  · The rarity is rolled **now** — the weights are this planet's difficulty row (`mineral.ts`), and the
     *    harvester's `derived.miningRarityBonus` **multiplies** the higher-rarity side of them. Being a multiplier, a
     *    rarity the difficulty shut to 0 never appears however high 채광 goes (the proof is in `rollMineralRarity`).
     *  · The count is `def.qty` fixed at generation (`MINING_YIELD_MIN`…`MAX`) × the gather yield — the herb rule.
     *  · The skill is **채광**. `gather:collected`'s `kind` is `'mineral'`, so progression raises 채광 by itself —
     *    `addSkillXp` is never called directly here (that one place decides how skills are handed out).
     *  · The only difference from the others is **when defId is decided**, so the event carries the id just rolled. */
    if (node.kind === 'mineral') {
      const mul = ctx.progression?.derived.gatherYieldMul ?? 1;
      const qty = Math.max(1, Math.round(node.def.qty * (mul > 0 ? mul : 1)));
      const defId = this.rollMineralDefId(ctx);
      ctx.bus.emit('gather:collected', { nodeId: node.def.id, defId, qty, kind: node.kind });
      ctx.bus.emit('audio:play', { id: 'gather', position: node.def.position, volume: 0.7 });
      const ore = this.makeItem(defId, qty);
      markRaidFound(ore, raidFoundSeed(ctx));
      if (ore) ctx.inventory?.tryAddItem(ore);
      return;
    }

    /* The gather yield (원예) applies to **herb · soil · seed** — salvage gives exactly what was torn off.
     * Soil · seed sit on the 원예 side for the same reason as their XP: shovelling soil and stripping ears are both farm work.
     * 2026-09-11: **the 미확인 표본 is not multiplied** — a single lump is not something 원예 can grow (the same as salvage). */
    const mul = node.kind === 'salvage' || node.kind === 'sample' ? 1 : (ctx.progression?.derived.gatherYieldMul ?? 1);
    const qty = Math.max(1, Math.round(node.def.qty * (mul > 0 ? mul : 1)));
    ctx.bus.emit('gather:collected', { nodeId: node.def.id, defId: node.def.defId, qty, kind: node.kind });
    ctx.bus.emit('audio:play', { id: 'gather', position: node.def.position, volume: 0.7 });
    const item = this.makeItem(node.def.defId, qty);
    const seed = raidFoundSeed(ctx);   // 2026-09-12: the item recovery contract mark (null in the training range · the ship)
    markRaidFound(item, seed);
    if (item) ctx.inventory?.tryAddItem(item);
    /* 2026-09-11 (C-20): a bonus result puts in **just one more item** each — `gather:collected` · the sound · 제작 XP happen once, above.
     * It is not multiplied by the gather yield (원예), as with scrap. 2026-09-13: it can be both core and 미확인 광물 (a def items/
     * does not know drops out silently, `makeItem` returning null). The mark (`raidFound`) is the main yield's. */
    for (const b of node.bonus) {
      const extra = this.makeItem(b.defId, b.qty);
      markRaidFound(extra, seed);
      if (extra) ctx.inventory?.tryAddItem(extra);
    }
  }

  /**
   * 2026-09-11 (C-20), for the smokes: node id → the bonus **core** (null with none). Its meaning did not change when the
   * bonus became a list in 2026-09-13 — `smoke-ecology`'s core signature reads this. For the mineral too, `debugBonusesOf`.
   */
  debugBonusOf(id: string): { defId: string; qty: number } | null {
    return this.byId.get(id)?.bonus.find((b) => b.defId === SALVAGE_CORE_DEF_ID) ?? null;
  }

  /** 2026-09-13, for the smokes: node id → every bonus result (core → mineral order; an empty list with none). */
  debugBonusesOf(id: string): Array<{ defId: string; qty: number }> {
    return (this.byId.get(id)?.bonus ?? []).map((b) => ({ ...b }));
  }

  /* ── What a vein yields (2026-09-16) ───────────────────────────────────── */

  /**
   * Rarity index (`RARITY_ORDER`) → 미확인 광물 item id. Built by lining the **mineral family** (`sample.family`
   * `'mineral'`) of `data/samples.csv` up by rarity — the code never counts Roman numerals, so it follows the table growing or shrinking.
   * While `items/` does not know that row (the folders are built in parallel) it falls back to the naming convention `spec_mineral_<rarity index>`.
   */
  private resolveMineralIds(game: GameContext): readonly (string | null)[] {
    const out: (string | null)[] = RARITY_ORDER.map(() => null);
    for (const d of game.loot?.getAllItemDefs?.() ?? []) {
      if (d.category !== 'sample' || d.sample?.family !== 'mineral' || d.retired) continue;
      const rank = RARITY_ORDER.indexOf(d.rarity);
      if (rank >= 0 && !out[rank]) out[rank] = d.id;
    }
    return out;
  }

  /** Rarity index → item id (the naming convention when unknown). */
  private mineralDefId(rank: number): string {
    return this.mineralIds[rank] ?? `${MINERAL_ID_PREFIX}${rank + 1}`;
  }

  /**
   * One vein rarity roll → an item id. The weights are the **planet difficulty row** (the same table as weapon drops),
   * and the harvester's 채광 skill multiplies the higher-rarity weights. If `items/` does not know that rarity's
   * mineral it steps down one at a time and gives a rarity it does know (nobody is sent away empty-handed).
   */
  private rollMineralDefId(ctx: GameContext): string {
    const weights = this.mineralWeights;
    if (!weights) return this.mineralDefId(0);
    const bonus = ctx.progression?.derived.miningRarityBonus ?? 0;
    const rarity = rollMineralRarity(weights, bonus, this.mineralRoll?.next() ?? 0);
    let rank = RARITY_ORDER.indexOf(rarity);
    if (rank < 0) rank = 0;
    while (rank > 0 && !this.mineralIds[rank]) rank--;
    return this.mineralDefId(rank);
  }

  private makeItem(defId: string, qty: number): ItemInstance | null {
    const ctx = this.game;
    const loot = ctx?.loot;
    if (loot?.getItemDef(defId)) {
      try { return loot.createItem(defId, qty); } catch { /* fall through */ }
    }
    // items/ has not defined this herb yet — do not fabricate an instance the inventory cannot render
    return null;
  }

  /* ── multiplayer (host authority) ──────────────────────────────────── */

  private ensureNet(): void {
    const ctx = this.game;
    const net = ctx?.net;
    if (!net || this.netHooked) return;
    this.netHooked = true;
    this.unsubs.push(
      net.onMessage('harv', (m) => this.onHarvestMessage(m)),
      net.onMessage('harvq', (m, from) => this.onHarvestRequest(m, from)),
      net.onMessage('flow', (m, from) => {
        if (m.ev === 'rejoined' && this.game?.net?.isHost) this.sendSync(from);
      }),
      // Phase 9: a promoted host never saw our harvests as authority — re-request the taken set from the new host
      ctx.bus.on('net:hostChanged', ({ isLocalHost }) => { if (!isLocalHost && this.built) this.requestSync(); }),
    );
  }

  private requestSync(): void {
    const ctx = this.game;
    const net = ctx?.net;
    if (!ctx || !net || !ctx.isMultiplayer || net.isHost) return;
    net.send({ t: 'harvq', ev: 'sync' }, 'host');
  }

  /** Host → clients. */
  private onHarvestMessage(m: HarvestMessage): void {
    const ctx = this.game;
    const net = ctx?.net;
    if (!ctx || !net || !ctx.isMultiplayer || net.isHost) return;
    if (m.ev === 'taken') {
      const node = this.byId.get(m.id);
      if (!node) return;
      this.collect(node, m.by, m.by === net.localId);
      return;
    }
    // full state for a (re)joining client
    for (const w of m.nodes) {
      const node = this.byId.get(w.id);
      if (!node) continue;
      node.pending = false;
      if (w.harvested && !node.def.harvested) this.collect(node, 'host', false);
    }
  }

  /** Clients → host. */
  private onHarvestRequest(m: HarvestRequest, from: PeerId): void {
    const ctx = this.game;
    const net = ctx?.net;
    if (!ctx || !net || !ctx.isMultiplayer || !net.isHost) return;
    if (m.ev === 'sync') { this.sendSync(from); return; }
    const node = this.byId.get(m.id);
    if (!node || node.def.harvested) return;   // already gone → the requester's pending flag times out
    this.collect(node, from, false);
    net.send({ t: 'harv', ev: 'taken', id: node.def.id, by: from }, 'others');
  }

  private sendSync(to: PeerId): void {
    const ctx = this.game;
    const net = ctx?.net;
    if (!ctx || !net || !ctx.isMultiplayer) return;
    const nodes: GatherWire[] = [];
    for (const n of this.nodes) {
      if (!n.def.harvested) continue;    // only the deltas travel; positions are seed-deterministic
      nodes.push({ id: n.def.id, defId: n.def.defId, p: [n.x, n.y, n.z], harvested: true });
    }
    net.send({ t: 'harv', ev: 'sync', nodes }, to);
  }

  /* ── geometry ──────────────────────────────────────────────────────── */

  private resolveHerbIds(game: GameContext): string[] {
    const defs = game.loot?.getAllItemDefs?.() ?? [];
    const herbs = defs.filter((d) => d.category === 'herb').map((d) => d.id);
    if (herbs.length > 0) return herbs.slice(0, 3);
    return FALLBACK_HERB_IDS.slice();
  }

  /**
   * Phase 11: `eco.herbs` folded into a cumulative table over the herb ids this build actually knows.
   * An id `items/` never registered is ignored (contract), and a planet whose whole mix is unknown / non-positive
   * falls back to null = the old shape-bound pairing.
   */
  private resolveHerbWeights(herbIds: readonly string[], eco: PlanetEcosystem | null): { ids: string[]; cum: number[] } | null {
    if (!eco) return null;
    const ids: string[] = [];
    const cum: number[] = [];
    let total = 0;
    for (const id of herbIds) {
      const w = eco.herbs[id];
      if (typeof w !== 'number' || !(w > 0)) continue;   // absent / 0 / NaN → this herb does not grow here
      total += w;
      ids.push(id);
      cum.push(total);
    }
    return ids.length > 0 && total > 0 ? { ids, cum } : null;
  }

  /**
   * 2026-09-11 (greenhouse overhaul · lab placement): folds the planet's weight table (`soils` · `seeds` · `samples`
   * in `planets.csv`) onto **the items this build actually knows**. An id `items/` does not know is dropped silently
   * (the herb contract) — a table that empties out entirely is null and not one node of that kind stands.
   *
   * The category filter is there so that one typo cannot turn "I thought it was soil" into a grenade. `items/` may not
   * know that row yet (the folders are built in parallel), so the **naming convention** (`soil_` · `seed_` · `spec_`)
   * is the second gate — the specimen prefix alone is `spec_` because `data/samples.csv` fixed it that way, to keep
   * it from mixing with the valuable `sample_canister_pure`.
   */
  private resolveNodeWeights(
    game: GameContext, weights: Readonly<Record<string, number>>, category: ItemCategory, prefix: string,
  ): { ids: string[]; cum: number[] } | null {
    const loot = game.loot;
    const ids: string[] = [];
    const cum: number[] = [];
    let total = 0;
    for (const [id, w] of Object.entries(weights)) {
      if (!(w > 0)) continue;
      const def = loot?.getItemDef(id);
      if (def && def.category !== category) continue;   // a different item whose name collided
      // 2026-09-13 (cooking material tiers): a retired item (the 11 old specimens etc.) stands no gather site even when left in the csv — a pin separate from data:check
      if (def?.retired) continue;
      if (!def && !id.startsWith(prefix)) continue;     // items/ does not know it and it is not the naming convention either — dropped
      total += w;
      ids.push(id);
      cum.push(total);
    }
    return ids.length > 0 && total > 0 ? { ids, cum } : null;
  }

  /**
   * Paints one soil pile instance in its **tag colour** (`SOIL_TAG_COLOR` in `shared/labels` — the same table as the
   * soil on the grow screen). The body geometry's vertex colours are only a shading ramp, so this colour is the soil colour.
   */
  private paintSoilInstance(game: GameContext, v: Variant, slot: number, defId: string): void {
    const def = game.loot?.getItemDef(defId);
    // items/ may not know that row yet — try the id convention (`soil_<tag>`) once more
    const tag = def?.soil?.tag ?? (defId.startsWith('soil_') ? defId.slice(5) as SoilTag : undefined);
    const hex = (tag && SOIL_TAG_COLOR[tag]) ?? SOIL_FALLBACK_COLOR;
    scratch.c.set(hex);
    v.meshes[0].setColorAt(slot, scratch.c);
  }

  private pickHerb(w: { ids: string[]; cum: number[] }, rng: Random): string {
    const r = rng.next() * w.cum[w.cum.length - 1];
    for (let i = 0; i < w.cum.length; i++) if (r < w.cum[i]) return w.ids[i];
    return w.ids[w.ids.length - 1];
  }

  /** Node count for this mission: `GATHER_NODES_PER_MISSION × eco.gatherDensity`, at least 1 plant. */
  private nodeTarget(eco: PlanetEcosystem | null): number {
    const d = eco && Number.isFinite(eco.gatherDensity) ? eco.gatherDensity : 1;
    if (!(d > 0)) return 0;
    return Math.max(1, Math.round(GATHER_NODES_PER_MISSION * d));
  }

  private writeMatrix(node: Node, shrink: number): void {
    const v = this.variants[node.variant];
    const s = node.scale * Math.max(0, shrink);
    const sink = (1 - Math.max(0, shrink)) * 0.35;
    const m = composeMatrix(node.x, node.y - sink, node.z, node.yaw, 0, 0, s, s, s);
    for (const im of v.meshes) im.setMatrixAt(node.slot, m);
    this.matrixDirty = true;
  }

  /**
   * [body, glow] geometry for variant `k` — 0–2 are plants tinted from the biome, 3 the salvage pile,
   * 4 the soil pile, 5 the seed grove, 6 the 미확인 표본.
   */
  private makeVariantGeometry(k: number, ctx: BuildCtx, rng: Random): THREE.BufferGeometry[] {
    if (k === SOIL_VARIANT) return this.makeSoilGeometry(ctx, rng);
    if (k === SEED_VARIANT) return this.makeSeedGeometry(rng);
    if (k === SAMPLE_VARIANT) return this.makeSampleGeometry(ctx, rng);
    if (k === MINERAL_VARIANT) return this.makeMineralGeometry(ctx, rng);
    if (k === SALVAGE_VARIANT) return this.makeSalvageGeometry(rng);
    const b = ctx.biome;
    const stemLow = b.trunk.clone().lerp(b.grass, 0.5).multiplyScalar(0.8);
    const stemHigh = b.grass.clone().lerp(b.grassTip, 0.4);
    const leaf = b.grass.clone().lerp(b.canopy, 0.35);
    const leafTip = b.grassTip.clone();
    const glowCol = new THREE.Color(GLOW_COLORS[k]);
    const body: THREE.BufferGeometry[] = [];
    const glow: THREE.BufferGeometry[] = [];

    if (k === 0) {
      // 혈청초: slim stalk with drooping blades and a hanging bulb
      const stalk = new THREE.CylinderGeometry(0.03, 0.07, 0.95, 5);
      xform(stalk, { x: 0, y: 0.47, z: 0 });
      paintGradient(stalk, stemLow, stemHigh);
      body.push(stalk);
      const blades = 5;
      for (let i = 0; i < blades; i++) {
        const ang = (i / blades) * Math.PI * 2 + rng.range(-0.2, 0.2);
        const len = rng.range(0.45, 0.68);
        const g = new THREE.ConeGeometry(0.09, len, 3, 1, true);
        xform(g, { x: 0, y: len * 0.5, z: 0 });
        xform(g, undefined, new THREE.Euler(0, 0, 1.05 + rng.range(-0.2, 0.2)));
        xform(g, { x: Math.cos(ang) * 0.16, y: rng.range(0.18, 0.42), z: Math.sin(ang) * 0.16 }, new THREE.Euler(0, ang, 0));
        paintGradient(g, leaf, leafTip);
        body.push(g);
      }
      const bulb = new THREE.IcosahedronGeometry(0.13, 1);
      xform(bulb, { x: 0, y: 1.0, z: 0 }, undefined, { x: 1, y: 1.25, z: 1 });
      paint(bulb, glowCol);
      glow.push(bulb);
      const seedRing = new THREE.TorusGeometry(0.09, 0.02, 4, 8);
      xform(seedRing, { x: 0, y: 0.86, z: 0 }, new THREE.Euler(Math.PI / 2, 0, 0));
      paint(seedRing, glowCol.clone().multiplyScalar(0.7));
      glow.push(seedRing);
    } else if (k === 1) {
      // 포자균: squat fungal cap with a glowing gill ring underneath
      const stalk = new THREE.CylinderGeometry(0.11, 0.16, 0.42, 6);
      xform(stalk, { x: 0, y: 0.21, z: 0 });
      paintGradient(stalk, stemLow, stemLow.clone().lerp(stemHigh, 0.6));
      body.push(stalk);
      const cap = new THREE.SphereGeometry(0.34, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.55);
      xform(cap, { x: 0, y: 0.42, z: 0 }, undefined, { x: 1, y: 0.62, z: 1 });
      paintGradient(cap, b.canopy.clone().multiplyScalar(0.55), b.canopy);
      body.push(cap);
      for (let i = 0; i < 2; i++) {
        const small = new THREE.SphereGeometry(0.15, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.55);
        const ang = rng.range(0, Math.PI * 2);
        xform(small, { x: Math.cos(ang) * 0.26, y: 0.16, z: Math.sin(ang) * 0.26 }, undefined, { x: 1, y: 0.6, z: 1 });
        paintGradient(small, b.canopy.clone().multiplyScalar(0.5), b.canopy);
        body.push(small);
      }
      const gills = new THREE.CylinderGeometry(0.3, 0.3, 0.05, 12, 1, true);
      xform(gills, { x: 0, y: 0.4, z: 0 });
      paint(gills, glowCol);
      glow.push(gills);
    } else {
      // 철넝쿨: low tangle of blades with glowing berries
      for (let i = 0; i < 7; i++) {
        const ang = (i / 7) * Math.PI * 2 + rng.range(-0.3, 0.3);
        const len = rng.range(0.5, 0.85);
        const g = new THREE.ConeGeometry(0.055, len, 3, 1, true);
        xform(g, { x: 0, y: len * 0.5, z: 0 });
        xform(g, undefined, new THREE.Euler(0, 0, rng.range(0.25, 0.75)));
        xform(g, { x: Math.cos(ang) * 0.08, y: 0, z: Math.sin(ang) * 0.08 }, new THREE.Euler(0, ang, 0));
        paintGradient(g, leaf.clone().multiplyScalar(0.75), leafTip);
        body.push(g);
      }
      for (let i = 0; i < 4; i++) {
        const berry = new THREE.IcosahedronGeometry(rng.range(0.055, 0.085), 0);
        const ang = rng.range(0, Math.PI * 2), r = rng.range(0.1, 0.3);
        xform(berry, { x: Math.cos(ang) * r, y: rng.range(0.25, 0.6), z: Math.sin(ang) * r });
        paint(berry, glowCol);
        glow.push(berry);
      }
    }

    return [merge(body), merge(glow)];
  }

  /**
   * The salvage pile (2026-09-08): one crushed cargo drum with a few bent hull plates and pipes leaning on it, an
   * amber marker glowing at every cut point. No biome colour — metal is metal on any planet, so it reads apart from plants at a distance.
   */
  private makeSalvageGeometry(rng: Random): THREE.BufferGeometry[] {
    const steel = new THREE.Color(0x6b7078);
    const steelDark = new THREE.Color(0x3a3e44);
    const rust = new THREE.Color(0x8a5a3a);
    const glowCol = new THREE.Color(GLOW_COLORS[SALVAGE_VARIANT]);
    const body: THREE.BufferGeometry[] = [];
    const glow: THREE.BufferGeometry[] = [];

    // crushed cargo drum, tipped over
    const drum = new THREE.CylinderGeometry(0.34, 0.38, 0.86, 8);
    xform(drum, { x: 0, y: 0.34, z: 0 }, new THREE.Euler(Math.PI / 2, 0, rng.range(-0.25, 0.25)), { x: 1, y: 1, z: 0.78 });
    paintGradient(drum, steelDark, steel);
    body.push(drum);

    // bent hull plates leaning on the drum
    for (let i = 0; i < 3; i++) {
      const ang = (i / 3) * Math.PI * 2 + rng.range(-0.35, 0.35);
      const w = rng.range(0.34, 0.6), h = rng.range(0.5, 0.85);
      const plate = new THREE.BoxGeometry(w, h, 0.045);
      xform(plate, { x: 0, y: h * 0.5, z: 0 });
      xform(plate, undefined, new THREE.Euler(rng.range(0.35, 0.7), 0, rng.range(-0.3, 0.3)));
      xform(plate, { x: Math.cos(ang) * 0.42, y: 0, z: Math.sin(ang) * 0.42 }, new THREE.Euler(0, ang, 0));
      paintGradient(plate, i === 1 ? rust : steel, steelDark);
      body.push(plate);
    }

    // a couple of pipes poking out of the pile
    for (let i = 0; i < 2; i++) {
      const len = rng.range(0.7, 1.05);
      const pipe = new THREE.CylinderGeometry(0.05, 0.05, len, 6);
      const ang = rng.range(0, Math.PI * 2);
      xform(pipe, { x: 0, y: len * 0.5, z: 0 });
      xform(pipe, undefined, new THREE.Euler(0, 0, rng.range(0.7, 1.15)));
      xform(pipe, { x: Math.cos(ang) * 0.2, y: 0.12, z: Math.sin(ang) * 0.2 }, new THREE.Euler(0, ang, 0));
      paintGradient(pipe, steel, rust);
      body.push(pipe);
    }

    // cut markers: a band around the drum and two studs, so the pile reads as harvestable from a distance
    const band = new THREE.TorusGeometry(0.3, 0.028, 4, 10);
    xform(band, { x: 0, y: 0.34, z: 0 }, new THREE.Euler(0, Math.PI / 2, 0));
    paint(band, glowCol);
    glow.push(band);
    for (let i = 0; i < 2; i++) {
      const stud = new THREE.IcosahedronGeometry(0.07, 0);
      const ang = rng.range(0, Math.PI * 2);
      xform(stud, { x: Math.cos(ang) * 0.34, y: rng.range(0.5, 0.78), z: Math.sin(ang) * 0.34 });
      paint(stud, glowCol.clone().multiplyScalar(0.85));
      glow.push(stud);
    }

    return [merge(body), merge(glow)];
  }

  /**
   * The soil pile (greenhouse overhaul, 2026-09-11): a **dug mound of soil**, as if someone stopped halfway through
   * shovelling — one lumpy dome with a few clods around it, and one thin rim band glowing faintly so it reads as a gather node from far off.
   *
   * The vertex colours are **only a shading ramp** (dark below, light above). The real soil colour comes from the
   * per-instance tag colour (`paintSoilInstance` → `instanceColor`) multiplied in — one planet can give two tags, so
   * one mesh has to be several colours. No biome colour, for the salvage pile's reason: soil must look like soil anywhere.
   */
  private makeSoilGeometry(ctx: BuildCtx, rng: Random): THREE.BufferGeometry[] {
    // the shading ramp (it will be multiplied, so it never exceeds 1.0)
    const shadeLow = new THREE.Color(0.45, 0.45, 0.45);
    const shadeHigh = new THREE.Color(1, 1, 1);
    const glowCol = new THREE.Color(GLOW_COLORS[SOIL_VARIANT]);
    const body: THREE.BufferGeometry[] = [];
    const glow: THREE.BufferGeometry[] = [];

    // the half-shovelled mound — one squashed dome made lumpy by noise
    const mound = new THREE.SphereGeometry(0.62, 12, 7, 0, Math.PI * 2, 0, Math.PI * 0.5);
    displace(mound, ctx.noise, 0.09, 2.6, rng.range(0, 40));
    xform(mound, { x: 0, y: 0.02, z: 0 }, undefined, { x: 1, y: 0.52, z: 1 });
    paintGradient(mound, shadeLow, shadeHigh);
    body.push(mound);

    // a few clods that rolled off to the side
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2 + rng.range(-0.5, 0.5);
      const r = rng.range(0.45, 0.7);
      const clod = new THREE.IcosahedronGeometry(rng.range(0.09, 0.17), 0);
      xform(clod, { x: Math.cos(ang) * r, y: rng.range(0.02, 0.09), z: Math.sin(ang) * r },
        new THREE.Euler(rng.range(0, 3), rng.range(0, 3), rng.range(0, 3)), { x: 1, y: 0.72, z: 1 });
      paintGradient(clod, shadeLow, shadeHigh);
      body.push(clod);
    }

    // the thin band around the dug spot — not a light pillar but a "something was dug here" marker (pillars are corpse-only, 2026-09-11)
    const rim = new THREE.TorusGeometry(0.66, 0.022, 4, 16);
    xform(rim, { x: 0, y: 0.03, z: 0 }, new THREE.Euler(Math.PI / 2, 0, 0));
    paint(rim, glowCol);
    glow.push(rim);
    // one marker stake driven in (it splits the silhouette from a rock's)
    const stake = new THREE.CylinderGeometry(0.018, 0.018, 0.44, 5);
    const sang = rng.range(0, Math.PI * 2);
    xform(stake, { x: 0, y: 0.22, z: 0 });
    xform(stake, undefined, new THREE.Euler(0, 0, rng.range(0.12, 0.3)));
    xform(stake, { x: Math.cos(sang) * 0.4, y: 0.06, z: Math.sin(sang) * 0.4 }, new THREE.Euler(0, sang, 0));
    paint(stake, glowCol.clone().multiplyScalar(0.8));
    glow.push(stake);

    return [merge(body), merge(glow)];
  }

  /**
   * The wild seed grove (lab A-11, 2026-09-11): a waist-high **bush of dry ears** — seven stalks fanned out, each
   * carrying a drooping ear, and only the ripe ears glow faintly so it reads as "there is something to pick" from far
   * off. A few fallen grains lie around the base.
   *
   * No biome colour: **`CATEGORY_COLOR.seed` is baked into the vertices** — instance colour (`instanceColor`) is not
   * used as it is for the soil mound, because a seed grove has one colour per kind and nothing varies per instance
   * (a mesh carrying instance colour gets its own shader program and wastes the pre-compile — see the `soilMat` comment).
   * The same colour on every planet, so it never mixes with herbs.
   */
  private makeSeedGeometry(rng: Random): THREE.BufferGeometry[] {
    const husk = new THREE.Color(CATEGORY_COLOR.seed);
    const huskLow = husk.clone().multiplyScalar(0.42);
    const glowCol = new THREE.Color(GLOW_COLORS[SEED_VARIANT]);
    const body: THREE.BufferGeometry[] = [];
    const glow: THREE.BufferGeometry[] = [];

    const stalks = 7;
    for (let i = 0; i < stalks; i++) {
      const ang = (i / stalks) * Math.PI * 2 + rng.range(-0.25, 0.25);
      const len = rng.range(0.62, 0.95);
      const lean = rng.range(0.12, 0.4);
      // stalk: fans out from the base and leans outward
      const stalk = new THREE.CylinderGeometry(0.012, 0.03, len, 4);
      xform(stalk, { x: 0, y: len * 0.5, z: 0 });
      xform(stalk, undefined, new THREE.Euler(0, 0, lean));
      xform(stalk, { x: Math.cos(ang) * 0.07, y: 0, z: Math.sin(ang) * 0.07 }, new THREE.Euler(0, ang, 0));
      paintGradient(stalk, huskLow, husk);
      body.push(stalk);
      /* Ear: a long cluster of grains drooping from the stalk's **tip** (glowing = ripe).
         It has to ride the **same transform chain** as the stalk (tilt in place → to the stalk tip → `lean` → the fan
         `ang`) to sit exactly on the tip — computing the tip coordinate separately leaves it floating tens of cm per tilt. */
      const earLen = rng.range(0.16, 0.26);
      const ear = new THREE.IcosahedronGeometry(0.055, 0);
      xform(ear, undefined, new THREE.Euler(0, 0, rng.range(0.25, 0.6)), { x: 1, y: earLen / 0.11, z: 1 });
      xform(ear, { x: 0, y: len - earLen * 0.3, z: 0 });
      xform(ear, undefined, new THREE.Euler(0, 0, lean));
      xform(ear, { x: Math.cos(ang) * 0.07, y: 0, z: Math.sin(ang) * 0.07 }, new THREE.Euler(0, ang, 0));
      paint(ear, glowCol.clone().multiplyScalar(rng.range(0.72, 1)));
      glow.push(ear);
    }

    // a few grains fallen at the base — looking down, "something dropped here" is visible
    for (let i = 0; i < 3; i++) {
      const ang = rng.range(0, Math.PI * 2), d = rng.range(0.16, 0.34);
      const grain = new THREE.IcosahedronGeometry(rng.range(0.028, 0.045), 0);
      xform(grain, { x: Math.cos(ang) * d, y: 0.02, z: Math.sin(ang) * d }, undefined, { x: 1.5, y: 0.7, z: 1 });
      paintGradient(grain, huskLow, husk);
      body.push(grain);
    }

    return [merge(body), merge(glow)];
  }

  /**
   * The 미확인 표본 (lab A-12, 2026-09-11): an **unidentifiable lump** half buried in the ground — a lumpy body with a
   * few shards poking out of it, and only a thin ring floating above it and the bead inside glow coldly. It is **one
   * silhouette** to mean it could be a bug shell, hardened resin or a crystal (the item name says which).
   *
   * The colour bakes `CATEGORY_COLOR.sample` into the vertices (the seed grove's call — no instance colour).
   */
  private makeSampleGeometry(ctx: BuildCtx, rng: Random): THREE.BufferGeometry[] {
    const shell = new THREE.Color(CATEGORY_COLOR.sample);
    const shellLow = shell.clone().multiplyScalar(0.35);
    const glowCol = new THREE.Color(GLOW_COLORS[SAMPLE_VARIANT]);
    const body: THREE.BufferGeometry[] = [];
    const glow: THREE.BufferGeometry[] = [];

    // the half-buried lump — distorted by noise so it resembles no prop
    const lump = new THREE.IcosahedronGeometry(0.34, 1);
    displace(lump, ctx.noise, 0.07, 3.1, rng.range(0, 40));
    xform(lump, { x: 0, y: 0.17, z: 0 }, new THREE.Euler(rng.range(0, 3), rng.range(0, 3), rng.range(0, 3)),
      { x: 1.15, y: 0.8, z: 1 });
    paintGradient(lump, shellLow, shell);
    body.push(lump);

    // three shards poking out
    for (let i = 0; i < 3; i++) {
      const ang = (i / 3) * Math.PI * 2 + rng.range(-0.4, 0.4);
      const len = rng.range(0.16, 0.3);
      const shard = new THREE.ConeGeometry(rng.range(0.045, 0.08), len, 4, 1);
      xform(shard, { x: 0, y: len * 0.5, z: 0 });
      xform(shard, undefined, new THREE.Euler(0, 0, rng.range(0.5, 1.05)));
      xform(shard, { x: Math.cos(ang) * 0.22, y: 0.16, z: Math.sin(ang) * 0.22 }, new THREE.Euler(0, ang, 0));
      paintGradient(shard, shellLow, shell);
      body.push(shard);
    }

    // the gather marker: a thin ring floating over the lump + the bead showing through inside (pillars are corpse-only, 2026-09-11)
    const ring = new THREE.TorusGeometry(0.3, 0.02, 4, 14);
    xform(ring, { x: 0, y: 0.42, z: 0 }, new THREE.Euler(Math.PI / 2, 0, rng.range(-0.3, 0.3)));
    paint(ring, glowCol);
    glow.push(ring);
    const core = new THREE.IcosahedronGeometry(0.1, 0);
    xform(core, { x: 0, y: 0.2, z: 0 });
    paint(core, glowCol.clone().multiplyScalar(0.85));
    glow.push(core);

    return [merge(body), merge(glow)];
  }

  /**
   * The 광맥 (2026-09-16 user's decision, 채광). **A readable silhouette** is the requirement — seen from across a
   * hillside it has to say "there is something to mine there". So it is split into two masses:
   *
   *  · The body — an outcrop in the biome's rock colour. Its base is sunk to `y < 0` so it **looks planted in the
   *    ground from any angle on a slope** (gather nodes are not tilted to the terrain normal — tilting would split the
   *    matrix path of all six kinds). The collider measures only the part above ground (`MINERAL_BODY_R` × `MINERAL_BODY_H`).
   *  · The crystals — five octahedra breaking out of the outcrop. Only these use `glowMat` (self-lit), so they read as
   *    purple dots from far off. No light pillar and no point light (pillars are corpse-only, and the raid point-light budget has zero spare).
   */
  private makeMineralGeometry(ctx: BuildCtx, rng: Random): THREE.BufferGeometry[] {
    const rock = ctx.biome.boulder.clone();
    const rockHi = ctx.biome.rock.clone().lerp(new THREE.Color(1, 1, 1), 0.12);
    const glowCol = new THREE.Color(GLOW_COLORS[MINERAL_VARIANT]);
    const body: THREE.BufferGeometry[] = [];
    const glow: THREE.BufferGeometry[] = [];

    // the outcrop body — one vertically stretched rock. Its base goes underground, so it never floats even on a slope.
    const core = new THREE.DodecahedronGeometry(0.8, 0);
    displace(core, ctx.noise, 0.16, 1.9, rng.range(0, 40));
    xform(core, { x: 0, y: 0.62, z: 0 }, new THREE.Euler(rng.range(-0.25, 0.25), rng.range(0, 3), rng.range(-0.25, 0.25)),
      { x: 1.05, y: 1.35, z: 1.05 });
    paintGradient(core, rock, rockHi);
    body.push(core);

    // three broken stones at the base — they widen the lower silhouette so it reads as "a vein someone broke open"
    for (let i = 0; i < 3; i++) {
      const ang = (i / 3) * Math.PI * 2 + rng.range(-0.5, 0.5);
      const d = rng.range(0.45, 0.72);
      const chunk = new THREE.IcosahedronGeometry(rng.range(0.2, 0.34), 0);
      displace(chunk, ctx.noise, 0.1, 3.4, rng.range(0, 40));
      xform(chunk, { x: Math.cos(ang) * d, y: rng.range(0.05, 0.2), z: Math.sin(ang) * d },
        new THREE.Euler(rng.range(0, 3), rng.range(0, 3), rng.range(0, 3)));
      paintGradient(chunk, rock, rockHi);
      body.push(chunk);
    }

    // five crystals — breaking out of the outcrop's upper part at an angle (a stretched octahedron = the cheapest crystal silhouette)
    for (let i = 0; i < 5; i++) {
      const ang = (i / 5) * Math.PI * 2 + rng.range(-0.4, 0.4);
      const up = rng.range(0.55, 1.15);
      const d = rng.range(0.2, 0.42);
      const shard = new THREE.OctahedronGeometry(rng.range(0.11, 0.19), 0);
      xform(shard, undefined, undefined, { x: 0.7, y: 1.9, z: 0.7 });
      xform(shard, { x: Math.cos(ang) * d, y: up, z: Math.sin(ang) * d },
        new THREE.Euler(rng.range(-0.5, 0.5), ang, rng.range(-0.5, 0.5)));
      paint(shard, glowCol.clone().multiplyScalar(rng.range(0.7, 1)));
      glow.push(shard);
    }

    return [merge(body), merge(glow)];
  }
}
