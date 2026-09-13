import * as THREE from 'three';
import {
  CATEGORY_COLOR,
  GATHER_HERB_QTY2_CHANCE, GATHER_INTERACT_TIME, GATHER_NODES_PER_MISSION, GATHER_SALVAGE_CORE_CHANCE,
  GATHER_SALVAGE_CORE_QTY, GATHER_SALVAGE_MINERAL_CHANCE, GATHER_SALVAGE_MINERAL_QTY, GATHER_SALVAGE_QTY2_CHANCE, Layers,
  SALVAGE_INTERACT_TIME, SALVAGE_NODES_PER_MISSION, SOIL_TAG_COLOR,
  type GameContext, type GatherNodeDef, type GatherNodeKind, type GatherWire, type HarvestMessage, type HarvestRequest,
  type Interactable, type ItemCategory, type ItemInstance, type PeerId, type PlanetEcosystem, type Random, type SoilTag,
} from '@/shared';
/* appended (2026-09-12): 아이템 회수 계약 — 채집물도 레이드 루팅이다 */
import { markRaidFound, raidFoundSeed } from '@/shared';
import { type BuildCtx, PLAY_LIMIT, composeMatrix, displace, isSpotFree, merge, paint, paintGradient, scratch, xform } from './build';
import { SEED_INTERACT_TIME, SEED_NODE_RADIUS, planetSeeds } from './flora';
import {
  GROVE_PICKS_MAX, GROVE_PICKS_MIN, GROVE_PICK_RING_MAX, GROVE_PICK_RING_MIN, GROVE_PICK_VARIANT,
} from './hazard/model';
import { planetSoil } from './soil';
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

// 0–2 약초 · 3 고철 · 4 토양 · 5 씨앗 군락 · 6 미확인 표본 (2026-09-11)
const GLOW_COLORS: readonly number[] = [0xff5a6a, 0x7affc8, 0xffc24a, 0xffb347, 0xd8b06a, 0xe6ff8a, 0x8fd8ff];

/* ── 고철 노드 (2026-09-08) ────────────────────────────────────────────────
 * 폐금속이 상자의 `material` 롤에서만 나오던 병목을 푸는 세 갈래 중 하나. 약초와 **같은 노드 시스템**을 쓴다 —
 * 배치 · 상호작용 · 호스트 권한 동기화(`harv` / `harvq`)가 전부 그대로 돌고, 다른 것은 변종 메시(난파 고철 더미),
 * 프롬프트 동사(`해체`), 집는 시간, 그리고 채집 수율 대신 고정 수량이라는 점뿐이다. */
/** `variants` index of the 고철 더미 mesh (0–2 are the plant shapes). */
const SALVAGE_VARIANT = 3;
/** What a 고철 더미 hands over. */
const SALVAGE_DEF_ID = 'mat_scrap';
/** Interaction radius of a 고철 더미 (a bit wider than a plant — it is a pile). */
const SALVAGE_RADIUS = 2.6;
/** Minimum distance from a 고철 더미 to any other node. */
const SALVAGE_SPACING = 12;
/**
 * 2026-09-11 (C-20): 고철 더미가 확률로 더 주는 **부가 코어**. 확률 · 개수는 `data/constants.csv` 의
 * `GATHER_SALVAGE_CORE_*`, 아이템 id 는 계약 주석(`shared/constants.ts`)이 정한 구동 코어다.
 */
const SALVAGE_CORE_DEF_ID = 'mat_core';
/**
 * 2026-09-13 (요리 재료 티어 — 사용자 결정 「광물 = 표본 채집지 · 고철 더미 부가 · 베헤모스」): 고철 더미가 확률로 더 주는
 * **미확인 광물**. 확률 · 개수는 `data/constants.csv` 의 `GATHER_SALVAGE_MINERAL_*`. 코어와 **따로** 굴리므로 한 더미가 둘 다 줄 수 있다.
 */
const SALVAGE_MINERAL_DEF_ID = 'spec_mineral';

/** 채집물 하나가 수확 때 **아이템만** 하나 더 넣는 부가 결과. */
interface NodeBonus { defId: string; qty: number }

/* ── 토양 더미 (온실 개편, 2026-09-11) ──────────────────────────────────────────
 * 온실의 재배 스테이션은 흙을 먼저 붓고 그 위에 씨앗을 심는다. 그 흙은 **레이드 채집으로만** 나오고 속성은
 * 바이오별로 다르다 (`data/planets.csv` 의 `soils` · `soilNodes`, 읽는 자리는 `world/soil.ts`) — "부엽토가
 * 필요하면 베르단트 III 로 간다" 가 이 파일에서 성립한다.
 *
 * 고철 더미가 그랬듯 **약초 노드 시스템을 그대로 쓴다**: 배치 · 상호작용 · 호스트 권한 동기화(`harv`/`harvq`) ·
 * 수확 애니메이션이 전부 같은 코드이고, 다른 것은 변종 메시(파 놓은 흙더미) · 프롬프트 동사(`채취`) · 집는
 * 시간 · 행성 가중치로 뽑는 아이템뿐이다. 숙련도는 **원예**다 (`gather:collected` 의 kind 가 'salvage' 가
 * 아니면 원예 — `progression/` 의 규칙 그대로라 저쪽은 한 줄도 바뀌지 않는다). */
/** `variants` index of the 토양 더미 mesh (0–2 = 약초, 3 = 고철). */
const SOIL_VARIANT = 4;
/** Interaction radius of a 토양 더미 (파 놓은 무더기라 고철과 같다). */
const SOIL_RADIUS = 2.6;
/**
 * 흙 한 포대를 퍼내는 시간. **고철 해체와 같은 값을 의도적으로 공유한다** — 새 수치를 코드에 적지 않기 위해서다
 * (`data/constants.csv` 는 이 배치의 소유가 아니다). 토양만 다른 시간이 필요해지면 constants.csv 에 한 줄.
 */
const SOIL_INTERACT_TIME = SALVAGE_INTERACT_TIME;
/** Minimum distance from a 토양 더미 to another 토양 더미. */
const SOIL_SPACING = 14;
/** Minimum distance from a 토양 더미 to any 약초 · 고철 노드. */
const SOIL_NODE_CLEARANCE = 5;
/** 흙더미가 앉을 수 있는 최대 경사 — 흙은 평평한 곳에 쌓인다 (약초 0.3 · 고철 0.32 보다 엄하다). */
const SOIL_MAX_SLOPE = 0.24;
/** 토양 태그를 모를 때 인스턴스에 칠하는 색 (items/ 가 아직 그 줄을 모를 때). */
const SOIL_FALLBACK_COLOR = '#6b5a49';

/* ── 야생 씨앗 군락 · 미확인 표본 채집지 (연구실 배치, 2026-09-11) ──────────────
 * 온실의 씨앗과 분석기의 표본도 **레이드에서 주워 온다**. 어떤 품종 · 어떤 표본이 나오는지는 행성마다 다르고
 * (`data/planets.csv` 의 `seeds`/`seedNodes` · `samples`/`sampleNodes`, 읽는 자리는 `world/flora.ts` ·
 * `world/specimen.ts`), 토양 더미가 그랬듯 **약초 노드 시스템을 그대로 쓴다** — 배치 · 상호작용 · 호스트 권한
 * 동기화(`harv`/`harvq`) · 수확 애니메이션이 전부 같은 코드이고 다른 것은 변종 메시 · 동사 · 시간 · 추첨뿐이다.
 *
 * ⚠ 둘 다 **자기 rng fork** 로만 굴린다 (`gather_seed` · `gather_sample`). 행성마다 다른 개수가 `gather`
 * 스트림을 한 칸이라도 밀면 같은 시드의 약초 · 고철 배치가 통째로 달라진다 (`gather_core` · `gather_soil` 과
 * 같은 수법 — `Random.fork` 는 부모를 전진시키지 않는다). */
/** `variants` index of the 씨앗 군락 mesh (0–2 = 약초, 3 = 고철, 4 = 토양). */
const SEED_VARIANT = 5;
/** `variants` index of the 미확인 표본 mesh. */
const SAMPLE_VARIANT = 6;
/** 한 군락이 품는 포기 수 (앵커 1 + 곁가지). `seedNodes` 는 **군락 수**라 실제 노드는 이만큼 늘어난다. */
const SEED_PATCH_MIN = 2;
const SEED_PATCH_MAX = 3;
/** 군락끼리의 최소 간격(m) — 한 행성에 4~5 군락뿐이라 넉넉히 흩는다. */
const SEED_SPACING = 18;
/** 한 군락 안에서 곁가지가 앉는 고리(m). */
const SEED_PATCH_RING_MIN = 2.2;
const SEED_PATCH_RING_MAX = 4.2;
/** 씨앗 군락에서 다른 채집물까지의 최소 거리(m). */
const SEED_NODE_CLEARANCE = 5;
/** 씨앗이 여무는 곳은 완만한 초지다 (약초 0.3 보다 엄하고 흙 0.24 보다는 무르다). */
const SEED_MAX_SLOPE = 0.28;
/** 표본 채집지끼리의 최소 간격(m). */
const SAMPLE_SPACING = 26;
/** 표본 채집지에서 다른 채집물까지의 최소 거리(m). */
const SAMPLE_NODE_CLEARANCE = 6;
/** 표본이 굳어 있을 만한 경사 (고철과 같다 — 잔해에 얹혀 있어도 된다). */
const SAMPLE_MAX_SLOPE = 0.32;
/** 둥지(패드 반지름 20 m) 바깥 고리 — 안에 놓으면 둥지 지오메트리에 파묻힌다. */
const SAMPLE_NEST_RING_MIN = 22;
const SAMPLE_NEST_RING_MAX = 34;
/** 폐허 전초(잔해) 둘레 고리 — 고철 더미(5–14 m)보다 조금 넓게 잡아 겹치지 않는다. */
const SAMPLE_POI_RING_MIN = 7;
const SAMPLE_POI_RING_MAX = 17;

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
   * 2026-09-09: 거대 버섯 군락에 딸려 심긴 채집 버섯. **`variant` 로는 가릴 수 없다** —
   * `GROVE_PICK_VARIANT` 는 평범한 약초도 쓰는 모양 번호라, 그걸로 판정하면 그 모양의 약초가 전부
   * 군락 버섯으로 잡힌다 (생태계 밀도 단언이 그 자리에서 깨진다). 심는 쪽이 표시한다.
   */
  grove?: boolean;
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
   * 2026-09-11 (C-20): 고철 더미의 **부가 결과** — 생성 때 미션 시드로 정해진다(와이어 없음, 모두가 같은 답).
   * world 내부 값이라 `GatherNodeDef` 에는 없다. 빈 목록 = 부가 결과 없음 (약초는 늘 비어 있다).
   * 2026-09-13: 하나(코어)에서 **목록**으로 — 코어(`gather_core`)와 미확인 광물(`gather_mineral`)이 각자 굴려 둘 다 붙을 수 있다.
   * 순서는 코어 → 광물 고정이다.
   */
  bonus: readonly NodeBonus[];
}

/**
 * Harvestable nodes (채집물) scattered over the map — 약초 plants and, since 2026-09-08, 고철 더미.
 *
 * - `GATHER_NODES_PER_MISSION` procedural plants in 3 variants plus `SALVAGE_NODES_PER_MISSION` 고철 더미
 *   (variant `SALVAGE_VARIANT`), drawn with one `InstancedMesh` per part (2 parts per variant → 8 draw calls
 *   total) so the whole set costs nothing. `GatherNodeDef.kind` says which a node is; 고철 더미 hand over
 *   `mat_scrap`, take `SALVAGE_INTERACT_TIME` to strip, ignore the 채집 수율 multiplier and grant 제작 XP.
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
   * 토양 더미 전용 본체 재질. `bodyMat` 과 갈라 둔 이유는 **인스턴스 색**(`setColorAt`) 때문이다 —
   * 흙더미는 속성마다 색이 달라야 하는데 `instanceColor` 가 붙은 메시는 셰이더 프로그램이 달라진다.
   * 같은 재질을 약초 · 고철과 공유하면 그 둘까지 프로그램이 갈려 선컴파일(`ctx.shaders`)이 헛돈다.
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

  constructor() { this.group.name = 'GatherNodes'; }

  /* ── lifecycle ─────────────────────────────────────────────────────── */

  /** Called once from `WorldSystem.init`; net hooks are attached lazily (NetSystem publishes `ctx.net` first). */
  attach(game: GameContext): void {
    this.game = game;
    this.ensureNet();
  }

  getNodes(): readonly GatherNodeDef[] { return this.defs; }

  /**
   * `eco` (Phase 11): the 목표 행성's ecosystem — `eco.herbs` are relative weights **by herb def id** (replacing the
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
    /* 2026-09-11 (온실 개편): 토양은 **자기 fork** 로만 굴린다 — 흙더미 지오메트리 · 배치 · 색이 `gather`
     * 스트림을 한 칸이라도 밀면 같은 시드의 약초 · 고철 레이아웃이 통째로 달라진다 (`gather_core` 와 같은 수법). */
    const soil = planetSoil(planetId);
    const soilTarget = soil ? soil.nodes : 0;
    const soilRng = ctx.rng.fork('gather_soil');
    const soilWeights = soil ? this.resolveNodeWeights(game, soil.weights, 'soil', 'soil_') : null;
    /* 2026-09-11 (연구실 A-11 · A-12): 씨앗 · 표본도 각자 자기 fork 다 — 토양과 같은 이유이고, 셋이 서로의
     * 스트림도 밀지 않는다 (행성마다 셋 중 둘만 있는 경우가 흔하다). */
    const seeds = planetSeeds(planetId);
    const seedTarget = seeds ? seeds.nodes : 0;
    const seedRng = ctx.rng.fork('gather_seed');
    const seedWeights = seeds ? this.resolveNodeWeights(game, seeds.weights, 'seed', 'seed_') : null;
    const samples = planetSamples(planetId);
    const sampleTarget = samples ? samples.nodes : 0;
    const sampleRng = ctx.rng.fork('gather_sample');
    const sampleWeights = samples ? this.resolveNodeWeights(game, samples.weights, 'sample', 'spec_') : null;

    this.bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0.0, side: THREE.DoubleSide });
    // 흙은 젖은 듯 무광이고 뒷면을 쓰지 않는다 (돔 하나 + 덩어리들이라 전부 닫힌 면이다)
    this.soilMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.0 });

    // variants 0–2 are the plant shapes, 3 the 고철 더미, 4 the 토양 더미, 5 the 씨앗 군락, 6 the 미확인 표본
    // — each mesh is sized for its own node budget
    const salvageTarget = SALVAGE_NODES_PER_MISSION;
    // 2026-09-09: 거대 버섯 군락 둘레의 채집 버섯은 전부 포자균 갓(변종 1)이라 그 변종만 자리를 더 잡는다
    const groveExtra = groves.length * GROVE_PICKS_MAX;
    const capacityOf = (k: number): number => (
      k === SALVAGE_VARIANT ? salvageTarget : k === SOIL_VARIANT ? soilTarget
        : k === SEED_VARIANT ? seedTarget * SEED_PATCH_MAX : k === SAMPLE_VARIANT ? sampleTarget
          : k === GROVE_PICK_VARIANT ? target + groveExtra : target
    );
    const variantRng = (k: number): Random => (
      k === SOIL_VARIANT ? soilRng : k === SEED_VARIANT ? seedRng : k === SAMPLE_VARIANT ? sampleRng : rng
    );
    for (let k = 0; k <= SAMPLE_VARIANT; k++) {
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
          : k === SEED_VARIANT ? 'gather_seed' : k === SAMPLE_VARIANT ? 'gather_sample' : `gather_plant_${k}`;
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

    // ── 고철 더미 (2026-09-08): 구조물(POI) 주변에 먼저, 남는 만큼 개활지에 ──────
    // 플랜트 배치가 끝난 **뒤에** 뽑으므로 같은 시드의 약초 레이아웃은 이전과 바이트 단위로 같다.
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

    /* ── 거대 버섯 군락의 채집 버섯 (2026-09-09) ──────────────────────────────
     * 군락 자체는 `world/Hazard` 가 세운다 (줄기가 이미 hash 에 들어가 있다). 여기서 하는 것은 그 둘레
     * 고리에 **채집 가능한 버섯**을 심는 것뿐이고, 노드 · 상호작용 · 호스트 권한 동기화는 약초 코드 그대로다.
     * 고철 더미와 같은 수법으로 **약초 · 고철 배치가 끝난 뒤에** 뽑으므로 앞의 rng 스트림을 밀지 않는다. */
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
        // 한 군락은 한 종류로 — 약초 무리와 같은 규칙 (행성 가중치가 있으면 그것으로 뽑는다)
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

    /* ── 토양 더미 (온실 개편, 2026-09-11) ─────────────────────────────────────
     * 개수 · 종류가 전부 `data/planets.csv` 에서 온다 (`world/soil.ts`). 흙은 물이 고이던 **저지대**에 쌓이므로
     * 분지(`layout.basins`) 안을 먼저 노리고, 못 잡으면 개활지로 흩는다. 배치 · 추첨은 전부 `soilRng` 이라
     * 약초 · 고철 · 군락의 `gather` 스트림은 한 칸도 밀리지 않는다 — 같은 시드의 옛 채집물 배치가 그대로다.
     * 자리 · 종류가 미션 시드의 함수라 **와이어가 없다** (수확 동기화만 기존 `harv`/`harvq` 를 탄다). */
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

    /* ── 야생 씨앗 군락 (연구실 A-11, 2026-09-11) ──────────────────────────────
     * 개수(군락 수) · 품종이 전부 `data/planets.csv` 에서 온다 (`world/flora.ts`). 씨앗은 물과 볕이 있는
     * **초지 · 저지대**에서 여무니까 분지(`layout.basins`) 안을 먼저 노리고, 못 잡으면 완만한 개활지로 흩는다
     * (흙더미와 같은 결이지만 경사 기준이 조금 무르고 서로 더 멀리 선다). 한 군락은 앵커 한 포기 + 곁가지
     * 1~2 포기이고 **전부 같은 품종**이다 — 약초 무리와 같은 규칙이라 "한 덤불을 훑었다" 로 읽힌다.
     * 추첨 · 배치가 전부 `seedRng` 이라 앞의 어느 스트림도 밀지 않는다. */
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
          // 곁가지끼리는 붙어 있어도 된다 (한 덤불이다) — 군락 간격만 지킨다
          if (free(x, z, 1.8 * 1.8)) seedSpots.push({ x, z, variant: SEED_VARIANT, defId, kind: 'seed' });
        }
      }
      spots.push(...seedSpots);
    }

    /* ── 미확인 표본 채집지 (연구실 A-12, 2026-09-11) ───────────────────────────
     * 표본은 **무언가 살거나 죽은 자리**에 남는다 — 둥지 바깥 고리(허물 · 알 껍질)와 폐허 전초 둘레(잔해에
     * 굳은 수지 · 결정)를 먼저 노리고, 남는 만큼만 개활지로 흩는다. 개수 · 종류는 `data/planets.csv`
     * (`world/specimen.ts`) 이고 추첨 · 배치는 전부 `sampleRng` 이다. */
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

    /* 2026-09-11 (C-20): 부가 코어는 **자기 fork** 로 굴린다 — `rng`(gather) 에서 뽑으면 그 뒤의 yaw · scale ·
     * 수량 추첨이 한 칸씩 밀려 같은 시드의 채집물 모습이 달라진다. `Random.fork` 는 부모를 전진시키지 않는다. */
    const coreRng = ctx.rng.fork('gather_core');
    /* 2026-09-13: 부가 미확인 광물도 **자기 fork** 다 — `gather_core` 에서 뽑으면 두 번째 더미부터 코어 굴림이 한 칸씩 밀려
     * 같은 시드의 코어 더미가 달라진다. fork 는 부모(`ctx.rng`)를 전진시키지 않으므로 이 줄이 다른 스트림을 건드리지 않는다. */
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
      const isSample = s.kind === 'sample';
      /* 토양은 배치와 마찬가지로 **자기 fork** 에서 yaw · scale 을 뽑는다 — soil spots 가 맨 뒤라 앞을 밀지는
         않지만, 흙더미 개수(행성마다 다르다)가 `gather` 스트림의 길이를 바꾸지 않게 하려면 여기도 갈라야 한다.
         2026-09-11 의 씨앗 · 표본도 같은 이유로 자기 fork 다. */
      const r = isSoil ? soilRng : isSeed ? seedRng : isSample ? sampleRng : rng;
      const yaw = r.range(0, Math.PI * 2);
      const scale = salvage ? r.range(0.9, 1.15)
        : isSoil ? r.range(0.85, 1.2)
          : isSeed ? r.range(0.9, 1.25)
            : isSample ? r.range(0.85, 1.15) : r.range(0.85, 1.3);
      const def: GatherNodeDef = {
        /* 2026-09-09: 군락 버섯은 `grove_` 로 구분한다 — 종류(kind)는 약초 그대로(원예 XP)지만 "생태계 밀도"
           를 세는 쪽(지도 · 스모크)은 이 둘을 갈라야 한다. 군락 자리는 spots 의 **맨 뒤**라 기존 약초 · 고철의
           id 는 한 글자도 바뀌지 않는다. 2026-09-11 의 토양 더미(`soil_`)는 그 뒤에, 씨앗(`seed_`) · 표본
           (`sample_`)은 다시 그 뒤에 붙는다. */
        id: salvage ? `salvage_${id++}`
          : isSoil ? `soil_${id++}`
            : isSeed ? `seed_${id++}`
              : isSample ? `sample_${id++}`
                : s.grove ? `grove_${id++}` : `gather_${id++}`,
        position: new THREE.Vector3(s.x, y, s.z),
        defId: s.defId,
        // 고철: 폐금속 1, `GATHER_SALVAGE_QTY2_CHANCE` 로 2. 약초: `GATHER_HERB_QTY2_CHANCE` 로 2.
        // 2026-09-11 (C-20): 옛 하드코딩 0.3 / 0.25 를 csv 로 옮겼다 — 같은 값이라 rng 소비도 결과도 그대로다.
        // 토양: 한 더미에 한 포대 고정 (한 포대가 `ItemDef.soil.uses` 만큼 수확을 버틴다 — 깊이는 그쪽에 있다).
        // 씨앗: 한 포기에 한 알 (군락이 여러 포기라 한 덤불에서 2~3 알이 나온다 + 원예 수율이 곱해진다).
        // 표본: 하나짜리 덩어리라 1 고정이고 수율도 곱하지 않는다 (고철과 같은 판단 — `collect` 참조).
        qty: isSoil || isSeed || isSample ? 1
          : salvage ? (rng.chance(GATHER_SALVAGE_QTY2_CHANCE) ? 2 : 1) : (rng.chance(GATHER_HERB_QTY2_CHANCE) ? 2 : 1),
        harvested: false,
        kind: s.kind,
      };
      /* 고철 더미마다 코어 한 번 · 광물 한 번, 각자의 fork 에서 **늘** 굴린다 (개수가 0 이어도 굴림은 소비한다 — 옛 코어 식
         `chance(...) && qty > 0` 과 같은 소비라 `gather_core` 스트림이 바이트 단위로 그대로다). */
      const bonus: NodeBonus[] = [];
      if (salvage) {
        if (coreRng.chance(GATHER_SALVAGE_CORE_CHANCE) && coreQty > 0) bonus.push({ defId: SALVAGE_CORE_DEF_ID, qty: coreQty });
        if (mineralRng.chance(GATHER_SALVAGE_MINERAL_CHANCE) && mineralQty > 0) bonus.push({ defId: SALVAGE_MINERAL_DEF_ID, qty: mineralQty });
      }
      const node: Node = {
        def, variant: s.variant, kind: s.kind, slot: v.count,
        x: s.x, y, z: s.z, yaw, scale, anim: -1, pending: false, pendingAt: -Infinity,
        interactable: null as unknown as Interactable,
        bonus,
      };
      node.interactable = this.makeInteractable(node);
      this.writeMatrix(node, 1);
      // 흙더미의 색은 **속성**이다 (부엽토 · 화산재토 · 동토 이탄 · 광물토) — 같은 메시를 인스턴스 색으로 칠한다
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
    for (const n of this.nodes) game?.interactables.unregister(n.interactable.id);
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
    // 2026-09-08: 고철 더미는 더 오래 걸리고 `해체` 라고 뜬다 — 나머지 규칙은 약초와 같다
    // 2026-09-11: 토양 더미는 `채취` 다 — 셋이 한 단어로 갈라진다 (약초 채집 · 고철 해체 · 토양 채취)
    // 2026-09-11 (연구실): 씨앗 군락은 흙과 같은 `채취`, 미확인 표본은 `수습` 이다 (사용자 결정) —
    // 다섯 종류가 네 단어로 갈린다 (약초 채집 · 고철 해체 · 토양/씨앗 채취 · 표본 수습).
    const salvage = node.kind === 'salvage';
    const soil = node.kind === 'soil';
    const seed = node.kind === 'seed';
    const sample = node.kind === 'sample';
    const verb = salvage ? '해체' : sample ? '수습' : soil || seed ? '채취' : '채집';
    return {
      id: `gather:${node.def.id}`,
      position: node.def.position,
      // base hold; the player applies `derived.interactSpeedMul` to every hold (Phase 5)
      holdTime: salvage ? SALVAGE_INTERACT_TIME
        : soil ? SOIL_INTERACT_TIME
          : seed ? SEED_INTERACT_TIME
            : sample ? SAMPLE_INTERACT_TIME : GATHER_INTERACT_TIME,
      radius: salvage ? SALVAGE_RADIUS
        : soil ? SOIL_RADIUS
          : seed ? SEED_NODE_RADIUS
            : sample ? SAMPLE_NODE_RADIUS : NODE_RADIUS,
      getPrompt: () => {
        if (node.def.harvested) return null;
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
    if (!award) return;

    /* 채집 수율(원예)은 **약초 · 토양 · 씨앗**에 붙는다 — 고철은 뜯어낸 만큼 그대로 나온다.
     * 토양 · 씨앗이 원예 쪽인 것은 XP 와 같은 이유다: 흙을 퍼는 것도 이삭을 훑는 것도 밭일이다.
     * 2026-09-11: **미확인 표본은 곱하지 않는다** — 하나짜리 덩어리라 원예가 늘릴 수 있는 것이 아니다(고철과 같다). */
    const mul = node.kind === 'salvage' || node.kind === 'sample' ? 1 : (ctx.progression?.derived.gatherYieldMul ?? 1);
    const qty = Math.max(1, Math.round(node.def.qty * (mul > 0 ? mul : 1)));
    ctx.bus.emit('gather:collected', { nodeId: node.def.id, defId: node.def.defId, qty, kind: node.kind });
    ctx.bus.emit('audio:play', { id: 'gather', position: node.def.position, volume: 0.7 });
    const item = this.makeItem(node.def.defId, qty);
    const seed = raidFoundSeed(ctx);   // 2026-09-12: 아이템 회수 계약 표식 (훈련장 · 함선이면 null)
    markRaidFound(item, seed);
    if (item) ctx.inventory?.tryAddItem(item);
    /* 2026-09-11 (C-20): 부가 결과는 **아이템만 하나씩 더** 넣는다 — `gather:collected` · 소리 · 제작 XP 는 위의 1회뿐.
     * 채집 수율(원예)을 곱하지 않는 것은 폐금속과 같다. 2026-09-13: 코어 · 미확인 광물 둘 다일 수 있다 (items/ 가 모르는 def 는
     * `makeItem` 이 null 을 돌려 조용히 빠진다). 표식(`raidFound`)은 본 산출물과 같다. */
    for (const b of node.bonus) {
      const extra = this.makeItem(b.defId, b.qty);
      markRaidFound(extra, seed);
      if (extra) ctx.inventory?.tryAddItem(extra);
    }
  }

  /**
   * 2026-09-11 (C-20) 스모크: 노드 id → 부가 **코어** (없으면 null). 2026-09-13 에 부가 결과가 목록이 된 뒤에도 뜻을 바꾸지 않았다 —
   * `smoke-ecology` 의 코어 서명이 이것을 읽는다. 광물까지 보려면 `debugBonusesOf`.
   */
  debugBonusOf(id: string): { defId: string; qty: number } | null {
    return this.byId.get(id)?.bonus.find((b) => b.defId === SALVAGE_CORE_DEF_ID) ?? null;
  }

  /** 2026-09-13 스모크: 노드 id → 부가 결과 전부 (코어 → 광물 순, 없으면 빈 목록). */
  debugBonusesOf(id: string): Array<{ defId: string; qty: number }> {
    return (this.byId.get(id)?.bonus ?? []).map((b) => ({ ...b }));
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
   * 2026-09-11 (온실 개편 · 연구실 배치): 행성의 가중치 표(`planets.csv` 의 `soils` · `seeds` · `samples`)를
   * **이 빌드가 실제로 아는 아이템**으로 접는다. `items/` 가 모르는 id 는 조용히 버린다 (약초와 같은 계약) —
   * 표가 통째로 비면 null 이고 그 종류의 노드가 한 개도 서지 않는다.
   *
   * 카테고리로 거르는 이유는 오타 한 줄이 "흙인 줄 알았더니 수류탄" 이 되지 않게 하기 위해서다. `items/` 가
   * 아직 그 줄을 모를 수 있으므로(폴더가 나란히 지어진다) **이름 규약**(`soil_` · `seed_` · `spec_`)을
   * 두 번째 관문으로 둔다 — 표본만 접두사가 `spec_` 인 것은 귀중품 `sample_canister_pure` 와 섞이지 않게
   * `data/samples.csv` 가 그렇게 정했기 때문이다.
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
      if (def && def.category !== category) continue;   // 이름이 겹친 다른 아이템이다
      // 2026-09-13 (요리 재료 티어): 은퇴 아이템(옛 표본 11종 등)은 csv 에 남아 있어도 채집지에 서지 않는다 — data:check 와 별개의 안전핀
      if (def?.retired) continue;
      if (!def && !id.startsWith(prefix)) continue;     // items/ 가 모르고 이름 규약도 아니면 버린다
      total += w;
      ids.push(id);
      cum.push(total);
    }
    return ids.length > 0 && total > 0 ? { ids, cum } : null;
  }

  /**
   * 토양 더미 인스턴스 하나를 그 **속성 색**으로 칠한다 (`shared/labels` 의 `SOIL_TAG_COLOR` — 재배 화면의 흙과
   * 같은 표다). 본체 지오메트리의 정점 색은 명암 램프뿐이라 이 색이 곧 흙색이 된다.
   */
  private paintSoilInstance(game: GameContext, v: Variant, slot: number, defId: string): void {
    const def = game.loot?.getItemDef(defId);
    // items/ 가 아직 그 줄을 모를 수 있다 — id 규약(`soil_<tag>`)으로 한 번 더 맞춰 본다
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
   * [body, glow] geometry for variant `k` — 0–2 are plants tinted from the biome, 3 the 고철 더미,
   * 4 the 토양 더미, 5 the 씨앗 군락, 6 the 미확인 표본.
   */
  private makeVariantGeometry(k: number, ctx: BuildCtx, rng: Random): THREE.BufferGeometry[] {
    if (k === SOIL_VARIANT) return this.makeSoilGeometry(ctx, rng);
    if (k === SEED_VARIANT) return this.makeSeedGeometry(rng);
    if (k === SAMPLE_VARIANT) return this.makeSampleGeometry(ctx, rng);
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
   * 고철 더미 (2026-09-08): 찌그러진 화물통 하나에 휜 강판 몇 장과 파이프를 기대 놓고, 잘라낼 자리마다 호박색
   * 표식이 빛난다. 바이옴 색을 쓰지 않는다 — 금속은 어느 행성에서나 금속이라 멀리서도 식물과 구분된다.
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
   * 토양 더미 (온실 개편, 2026-09-11): 누가 퍼내다 만 것처럼 **파 놓은 흙 무더기** — 울퉁불퉁한 돔 하나에 흙덩이
   * 몇 개가 굴러 있고, 가장자리를 두른 얇은 띠 하나만 은은히 빛나 멀리서도 채집물로 읽힌다.
   *
   * 정점 색은 **명암 램프뿐**이다 (아래가 어둡고 위가 밝다). 진짜 흙색은 인스턴스마다의 속성 색
   * (`paintSoilInstance` → `instanceColor`)이 곱해져 나온다 — 한 행성이 두 속성을 줄 수 있으므로 메시 하나가
   * 여러 색이어야 한다. 바이옴 색을 쓰지 않는 것은 고철과 같은 이유다: 흙은 어디서나 흙으로 보여야 한다.
   */
  private makeSoilGeometry(ctx: BuildCtx, rng: Random): THREE.BufferGeometry[] {
    // 명암 램프 (곱해질 것이므로 1.0 을 넘지 않는다)
    const shadeLow = new THREE.Color(0.45, 0.45, 0.45);
    const shadeHigh = new THREE.Color(1, 1, 1);
    const glowCol = new THREE.Color(GLOW_COLORS[SOIL_VARIANT]);
    const body: THREE.BufferGeometry[] = [];
    const glow: THREE.BufferGeometry[] = [];

    // 퍼내다 만 무더기 — 눌린 돔 하나를 노이즈로 울퉁불퉁하게
    const mound = new THREE.SphereGeometry(0.62, 12, 7, 0, Math.PI * 2, 0, Math.PI * 0.5);
    displace(mound, ctx.noise, 0.09, 2.6, rng.range(0, 40));
    xform(mound, { x: 0, y: 0.02, z: 0 }, undefined, { x: 1, y: 0.52, z: 1 });
    paintGradient(mound, shadeLow, shadeHigh);
    body.push(mound);

    // 옆으로 흘러내린 흙덩이 몇 개
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2 + rng.range(-0.5, 0.5);
      const r = rng.range(0.45, 0.7);
      const clod = new THREE.IcosahedronGeometry(rng.range(0.09, 0.17), 0);
      xform(clod, { x: Math.cos(ang) * r, y: rng.range(0.02, 0.09), z: Math.sin(ang) * r },
        new THREE.Euler(rng.range(0, 3), rng.range(0, 3), rng.range(0, 3)), { x: 1, y: 0.72, z: 1 });
      paintGradient(clod, shadeLow, shadeHigh);
      body.push(clod);
    }

    // 파 낸 자리를 두른 얇은 띠 — 빛기둥이 아니라 "여기 팠다" 는 표식이다 (빛기둥은 시체에만, 2026-09-11)
    const rim = new THREE.TorusGeometry(0.66, 0.022, 4, 16);
    xform(rim, { x: 0, y: 0.03, z: 0 }, new THREE.Euler(Math.PI / 2, 0, 0));
    paint(rim, glowCol);
    glow.push(rim);
    // 꽂아 둔 표식 막대 하나 (실루엣이 바위와 갈린다)
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
   * 야생 씨앗 군락 (연구실 A-11, 2026-09-11): 허리 높이의 **마른 이삭 덤불** — 부챗살로 벌어진 줄기 일곱에
   * 고개 숙인 이삭이 달리고, 여문 이삭만 은은히 빛나 멀리서도 "딸 것이 있다" 로 읽힌다. 밑동에는 떨어진
   * 낟알 몇 개가 굴러 있다.
   *
   * 바이옴 색을 쓰지 않고 **`CATEGORY_COLOR.seed` 를 정점에 구워 넣는다** — 흙더미처럼 인스턴스 색
   * (`instanceColor`)을 쓰지 않는 이유는 씨앗 군락은 한 종류당 색이 하나라 인스턴스마다 달라질 일이 없기
   * 때문이다 (인스턴스 색이 붙은 메시는 셰이더 프로그램이 갈려 선컴파일이 헛돈다 — `soilMat` 주석 참조).
   * 어느 행성에서나 같은 색이라 약초와 섞이지 않는다.
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
      // 줄기: 밑동에서 벌어져 바깥으로 기운다
      const stalk = new THREE.CylinderGeometry(0.012, 0.03, len, 4);
      xform(stalk, { x: 0, y: len * 0.5, z: 0 });
      xform(stalk, undefined, new THREE.Euler(0, 0, lean));
      xform(stalk, { x: Math.cos(ang) * 0.07, y: 0, z: Math.sin(ang) * 0.07 }, new THREE.Euler(0, ang, 0));
      paintGradient(stalk, huskLow, husk);
      body.push(stalk);
      /* 이삭: 줄기 **끝**에서 고개를 숙인 길쭉한 알갱이 뭉치 (발광 = 여문 것).
         줄기와 **같은 변환 사슬**(제자리 기울기 → 줄기 끝으로 → `lean` → 부챗살 `ang`)을 타야 끝에 정확히
         붙는다 — 끝 좌표를 따로 계산해 넣으면 기울기마다 몇십 cm 씩 떠 있다. */
      const earLen = rng.range(0.16, 0.26);
      const ear = new THREE.IcosahedronGeometry(0.055, 0);
      xform(ear, undefined, new THREE.Euler(0, 0, rng.range(0.25, 0.6)), { x: 1, y: earLen / 0.11, z: 1 });
      xform(ear, { x: 0, y: len - earLen * 0.3, z: 0 });
      xform(ear, undefined, new THREE.Euler(0, 0, lean));
      xform(ear, { x: Math.cos(ang) * 0.07, y: 0, z: Math.sin(ang) * 0.07 }, new THREE.Euler(0, ang, 0));
      paint(ear, glowCol.clone().multiplyScalar(rng.range(0.72, 1)));
      glow.push(ear);
    }

    // 밑동에 떨어진 낟알 몇 개 — 발밑을 보면 "여기서 뭔가 떨어졌다" 가 보인다
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
   * 미확인 표본 (연구실 A-12, 2026-09-11): 땅에 반쯤 묻힌 **정체 모를 덩어리** — 울퉁불퉁한 몸체에 조각 몇
   * 개가 삐져나와 있고, 그 위에 떠 있는 얇은 고리 하나와 속의 구슬만 차갑게 빛난다. 벌레 껍질일 수도,
   * 굳은 수지일 수도, 결정일 수도 있다는 뜻으로 **한 가지 실루엣**이다 (종류는 아이템 이름이 말한다).
   *
   * 색은 `CATEGORY_COLOR.sample` 을 정점에 구워 넣는다 (씨앗 군락과 같은 판단 — 인스턴스 색을 쓰지 않는다).
   */
  private makeSampleGeometry(ctx: BuildCtx, rng: Random): THREE.BufferGeometry[] {
    const shell = new THREE.Color(CATEGORY_COLOR.sample);
    const shellLow = shell.clone().multiplyScalar(0.35);
    const glowCol = new THREE.Color(GLOW_COLORS[SAMPLE_VARIANT]);
    const body: THREE.BufferGeometry[] = [];
    const glow: THREE.BufferGeometry[] = [];

    // 반쯤 묻힌 덩어리 — 노이즈로 일그러뜨려 어느 소품과도 닮지 않게
    const lump = new THREE.IcosahedronGeometry(0.34, 1);
    displace(lump, ctx.noise, 0.07, 3.1, rng.range(0, 40));
    xform(lump, { x: 0, y: 0.17, z: 0 }, new THREE.Euler(rng.range(0, 3), rng.range(0, 3), rng.range(0, 3)),
      { x: 1.15, y: 0.8, z: 1 });
    paintGradient(lump, shellLow, shell);
    body.push(lump);

    // 삐져나온 조각 셋
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

    // 채집 표식: 덩어리 위에 뜬 얇은 고리 + 속에서 비치는 구슬 (빛기둥은 시체에만, 2026-09-11)
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
}
