import * as THREE from 'three';
import type { CookGame, FurnitureDef, FurnitureModelKind, FurniturePose, GameContext, GrowTier, Interactable, PeerId, PlacedFurniture, Rarity, RemotePlayerRef, ShelfMedium, WorkbenchKind } from '@/shared';
import { ANALYZER_MAX_SLOTS, BOOKS_PER_SHELF, CULTURE_MAX_SLOTS, FURNITURE_DEF_MAP, GROW_PLOTS_PER_RACK, GROW_RACK_LAYER_HEIGHT, GROW_SLOTS_PER_TIER, GYM_MINIGAME_LABEL_KO, HOUSING_CELL_SIZE, RARITY_COLORS, SHELF_SLOTS, analyzerSlotsForLevel, benchKindOf, cookGamesOfAppliance, cultureSlotsForLevel, furnitureFootprint, growTiersForLevel, gymEquipmentOf, isToggleInteraction, shelfMediumOfInteraction } from '@/shared';
import { GeoBatch, HUB_MATS as M, disposeMeshes } from './GeoBatch';
import { LEISURE_BUILDERS, TV_CONSOLE_LOOKS, TV_CONSOLE_LOOK_BY_KIND, isLeisureKind, type FurnitureRig, type LeisureKind, type TvRig } from './FurnitureLeisure';
import { GameStaging } from './GameStaging';   // 2026-09-13 video games — seat pose · fixed camera · TV game screen
import { KITCHEN_APPLIANCE_BUILDERS, cookBenchTools, type CookRig } from './FurnitureKitchen';
import { MINING_BUILDERS } from './FurnitureMining';
import { COMPUTE_CLUSTER_DEF_ID, COMPUTE_CLUSTER_MAX_CORES } from '@/shared';     // 2026-09-13 crypto mining
import { CookStaging, cookPoseOf } from './CookStaging';
import { GymStaging, gymPoseOf, poseRock, sitPoseOf, type FootBox } from './GymStaging';
import { RemoteFurnitureStaging } from './RemoteFurnitureStaging';
import type { BoxInteriorCollider } from './InteriorCollider';
import { roomCellToWorld, yawToRotation } from './RoomLayout';
import { computerScreenPose, implantBayBody, shipComputerBody } from './stations';
import { TextPlane } from '../Labels';
import type { EditAreaDef } from './types';
import { furnitureAccessOf, furnitureFaceDir } from '@/shared';   // 2026-09-13 placement rules — interaction only from the access face
import { DINING_TABLE_MISSING_REASON } from '@/shared';             // 2026-09-16 the plate model — the 조리대 prompt when there is no 식탁
import { addPlateToBatch } from './TablePlates';

/* ────────────────────────────────────────────────────────────────────────────
 * Procedural furniture (ship decoration). Every `FurnitureModelKind` is built from boxes / cylinders through a
 * `GeoBatch` (one merged mesh per material, ~2–5 draw calls per piece). Models are centred on the footprint,
 * bottom at y 0, **front toward −Z** (the `parts.ts` convention); `yaw` quarter turns rotate the whole group.
 * Materials are shared constants (HUB_MATS + one tinted material per catalogue colour) and never disposed.
 * ──────────────────────────────────────────────────────────────────────────── */

const tintCache = new Map<string, THREE.MeshStandardMaterial>();
/** Tinted material for a catalogue colour (accent strips / panels). Cached forever. */
function tint(css: string): THREE.MeshStandardMaterial {
  let m = tintCache.get(css);
  if (!m) {
    const c = new THREE.Color(css);
    m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.45, metalness: 0.2, emissive: c, emissiveIntensity: 0.55 });
    tintCache.set(css, m);
  }
  return m;
}
const spineCache = new Map<string, THREE.MeshStandardMaterial>();
/** Book-spine material per rarity colour (Phase 9 책장): matte, a faint glow so the colour reads in a dim room. Cached forever. */
function spine(css: string): THREE.MeshStandardMaterial {
  let m = spineCache.get(css);
  if (!m) {
    const c = new THREE.Color(css);
    m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.8, metalness: 0.05, emissive: c, emissiveIntensity: 0.18 });
    spineCache.set(css, m);
  }
  return m;
}
/** 책장 shelves (BOOKS_PER_SHELF slots spread over them, top shelf first). 2026-09-13: 4 × 2 (was 3 × 2). */
const BOOK_SHELF_ROWS = 4;
const LAMP_GLOW = new THREE.MeshStandardMaterial({ color: 0xffe3a0, roughness: 0.3, metalness: 0, emissive: 0xffc060, emissiveIntensity: 2.4 });
const LEAF = new THREE.MeshStandardMaterial({ color: 0x4f9a4a, roughness: 0.85, metalness: 0 });
const POT = new THREE.MeshStandardMaterial({ color: 0x8a5a3c, roughness: 0.9, metalness: 0.05 });
const TARGET = new THREE.MeshStandardMaterial({ color: 0xe8e2d0, roughness: 0.8, metalness: 0.05 });
const TARGET_RING = new THREE.MeshStandardMaterial({ color: 0xd23a2a, roughness: 0.7, metalness: 0.05 });
/** 시뮬레이션 허브 hologram rings (emissive, translucent — no light). */
const HOLO_RING = new THREE.MeshStandardMaterial({ color: 0x9fe8ff, roughness: 0.3, metalness: 0, emissive: 0x5fd7ff, emissiveIntensity: 2.2, transparent: true, opacity: 0.85, depthWrite: false });
const HOLO_CORE = new THREE.MeshStandardMaterial({ color: 0xc8f4ff, roughness: 0.2, metalness: 0, emissive: 0x8fe0ff, emissiveIntensity: 1.6, transparent: true, opacity: 0.35, depthWrite: false });
/**
 * Tier heights of a 재배 스테이션 (a fraction of the furniture height, the greenhouse rework 2026-09-11). Straight
 * `GrowTier`: 0 = middle · 1 = bottom · 2 = top, and **fixed regardless of level** — the contract
 * (`growTiersForLevel`) says "Lv.2 opens the bottom, Lv.3 the top", so an upgrade must never move the middle tier
 * that already has crops in it. Tiers are spaced to take a pot + a grow light (0.28 of the height ≈ 0.62 m).
 */
const GROW_TIER_Y: Readonly<Record<GrowTier, number>> = { 0: 0.44, 1: 0.16, 2: 0.72 };
/**
 * 배양조 glass tube · medium · cell mass (2026-09-17). The old tube was an opaque `glassDark` and hid the fluid inside — for a
 * slot to say what it holds the glass has to show through. Glass and medium are translucent (`depthWrite: false`) and the cell mass
 * is opaque, so it draws first in the opaque pass and shows through both layers. All of it is material — no light is created.
 */
const CULTURE_GLASS = new THREE.MeshStandardMaterial({ color: 0xbfe6ff, roughness: 0.08, metalness: 0.1, emissive: 0x10243a, emissiveIntensity: 0.4, transparent: true, opacity: 0.22, depthWrite: false });
const CULTURE_MASS = new THREE.MeshStandardMaterial({ color: 0xf6ece2, roughness: 0.6, metalness: 0, emissive: 0xffe2c8, emissiveIntensity: 0.6 });
/** Culture-fluid colour for a medium def that has no colour (the same colour as the culture screen's `FLUID_FALLBACK`). */
const CULTURE_FLUID_FALLBACK = '#8fe8ff';
const cultureFluidCache = new Map<string, THREE.MeshStandardMaterial>();
/** Culture-fluid material in a medium's colour (translucent · a faint self-glow). Made once per colour and never disposed (`tint`'s contract). */
function cultureFluid(css: string): THREE.MeshStandardMaterial {
  let m = cultureFluidCache.get(css);
  if (!m) {
    const c = new THREE.Color(css);
    m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.25, metalness: 0, emissive: c, emissiveIntensity: 0.9, transparent: true, opacity: 0.5, depthWrite: false });
    cultureFluidCache.set(css, m);
  }
  return m;
}

/** Ghost materials for the housing-mode preview. */
export const GHOST_OK = new THREE.MeshBasicMaterial({ color: 0x5cff8a, transparent: true, opacity: 0.45, depthWrite: false });
export const GHOST_BAD = new THREE.MeshBasicMaterial({ color: 0xff5a4a, transparent: true, opacity: 0.45, depthWrite: false });

export interface FurnitureModel {
  group: THREE.Group;
  meshes: THREE.Mesh[];
  /** Footprint in metres (unrotated). */
  w: number;
  d: number;
  /** Animated sub-groups (`sim_hub` hologram rings): `spin` turns about Y, `spinInner` tumbles inside it. */
  spin?: THREE.Group;
  spinInner?: THREE.Group;
  /** Turn rate of `spin` (rad/s). Absent = the 시뮬레이션 허브's 0.6 — a 턴테이블 · 축음기 record turns at 3.5 (A-3e, 2026-09-12). */
  spinRate?: number;
  /** Pose geometry + moving parts of a 흔들의자 · gym machine (furniture-local coordinates, `FurnitureLeisure`). A-3e · A-3a, 2026-09-12. */
  rig?: FurnitureRig;
  /** Tool rig of the 조리대 (`bench_cook`) — board · pot · wok · grill pan · beaker and the standing spot (`FurnitureKitchen.cookBenchTools`, 2026-09-13). */
  cook?: CookRig;
  /** The TV's game-screen rig (2026-09-13, video games — `FurnitureLeisure.TvRig`). */
  tv?: TvRig;
}

/** Per-piece data a builder may read (Phase 9): the 책장's shelved books by slot (rarity, null = empty). */
export interface BuildExtra {
  books?: readonly (Rarity | null)[];
  /**
   * The lab 분석기 (A-12, 2026-09-11): how many of this piece's analysis slots are **waiting to be collected** right now
   * (`housing:analysisChanged.ready`). The builder lights that many chambers amber instead of cyan — the only way
   * the model can say "go and collect it" without adding a `THREE.PointLight`, which would recompile every shader in
   * the scene (CLAUDE.md 「Never change the point-light count at runtime」).
   */
  analysisReady?: number;
  /**
   * The greenhouse 배양조 (A-14, 2026-09-11): how many of this piece's culture slots are **waiting to be collected** right
   * now (`housing:cultureChanged.ready`). Exactly the 분석기's convention above — those tubes glow amber instead of
   * the culture magenta, and no `THREE.PointLight` is created for it.
   */
  cultureReady?: number;
  /**
   * 배양조 (2026-09-17, user's decision): the look of each slot — `null` = empty, else the medium colour (`ItemDef.color`) · whether a strain
   * is in it (the same before the start and while culturing — scaffold and strain kind are not told apart) · harvestable. Present = read instead of `cultureReady`. No lights.
   */
  cultureSlots?: readonly (CultureLook | null)[];
  /**
   * 식탁 (2026-09-16, the plate model): the local player's plate on this table (`HousingRef.getPlate`), null · omitted when there is none. The builder
   * puts the meal shape on the top (`TablePlates.addPlateToBatch` — no lights). A changed plate rebuilds only rooms with a 식탁 (`housing:tablePlatesChanged`).
   */
  plate?: { mealDefId: string; quality: number } | null;
  /**
   * 디스크 전시대 · 레코드랙 (A-3e, 2026-09-12): the rarity of the media item in each slot (null = empty). Every slot stands a rarity-coloured case · sleeve.
   * A 책장 still uses `books`.
   */
  media?: readonly (Rarity | null)[];
  /** TV · 축음기 · 주크박스 · 턴테이블 (A-3e): whether it is on (`ShipState.toggled`) — picks the screen · neon · LED material. */
  on?: boolean;
  /** 벤치 랙 · 스미스 머신 (A-3a): a gym session is running on this piece — built with the plates loaded on the barbell. */
  gymActive?: boolean;
  /**
   * 조리대 (2026-09-13, the cooking minigame): the game of the step being cooked on this bench (`housing:cookStep`) — built with that game's
   * tool out on the work spot (a room rebuilt mid-cook never snaps the tool back to rest). null · omitted = not cooking.
   */
  cookGame?: CookGame | null;
  /**
   * 연산 클러스터 (2026-09-13, crypto mining): how many compute cores are mounted — that many core slots light up on both faces (`FurnitureMining`).
   * The look changes with no light, so `housing:clusterChanged` rebuilds the room **only when that value changed**. Omitted = 0.
   */
  cores?: number;
  /** 연산 클러스터: whether it is mining right now (core status light green / amber). */
  clusterMining?: boolean;
  /* ── 2026-09-13 library series · video games ── */
  /** 게임 디스크 전시대: the theme colour of the game disc in each slot (`GameDiscDef.color`, null = empty · an unknown disc → the `media` rarity colour). */
  gameColors?: readonly (string | null)[];
  /** TV: the look of the mounted console (0 … `TV_CONSOLE_LOOKS − 1`, `TV_CONSOLE_LOOKS` = the generic box for an unknown console). null · omitted = no console. */
  consoleLook?: number | null;
  /** TV: a game session is running on this TV — built with the game screen (`model.tv.overlay`) shown. */
  gameActive?: boolean;
}

/** The look of one 배양조 slot (`BuildExtra.cultureSlots`). */
export interface CultureLook {
  /** Medium colour (CSS). */
  color: string;
  /** A strain is in it (waiting to start included). */
  filled: boolean;
  ready: boolean;
}

/** Build the model of `def` (unrotated, centred, front toward −Z). `extra` carries per-piece state (책장 books). */
export function buildFurniture(def: FurnitureDef, level = 1, extra?: BuildExtra): FurnitureModel {
  const g = new THREE.Group();
  g.name = `furn-${def.id}`;
  const b = new GeoBatch();
  const w = def.cols * HOUSING_CELL_SIZE, d = def.rows * HOUSING_CELL_SIZE, h = def.height;
  const accent = tint(def.color);
  const meshes: THREE.Mesh[] = [];
  const model: FurnitureModel = { group: g, meshes, w, d };
  const kind = def.model;
  // A-3e · A-3a (2026-09-12): the 11 library · gym models also add moving sub-groups + pose geometry to the model
  if (isLeisureKind(kind)) LEISURE_BUILDERS[kind](b, model, w, d, h, accent, extra);
  else BUILDERS[kind](b, w, d, h, accent, level, extra);
  b.build(g, meshes);
  if (kind === 'sim_hub') simHubRings(model, Math.min(w, d) / 2, h);
  // 2026-09-13 the cooking minigame: the 조리대's tools (board · pot · wok · grill pan · beaker) move during a cook, so they are attached as sub-groups, not merged
  if (kind === 'bench_cook') cookBenchTools(model, w, d, h, accent, extra);
  return model;
}

/**
 * 시뮬레이션 허브 hologram: an outer horizontal ring with three emitter nodes and a tilted inner ring that tumbles,
 * both in their own groups so `FurnitureLayer.update` can rotate them (the pedestal itself is merged and static).
 */
function simHubRings(model: FurnitureModel, r: number, h: number): void {
  const dishTop = 0.15 + h * 0.42 + 0.17;
  const y = dishTop + (h - dishTop) * 0.55;
  const spin = new THREE.Group(); spin.name = 'sim-spin'; spin.position.y = y;
  const outer = new GeoBatch();
  outer.add(new THREE.TorusGeometry(r * 0.66, 0.022, 8, 48), HOLO_RING, 0, 0, 0, Math.PI / 2);
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    outer.box(0.09, 0.05, 0.05, Math.cos(a) * r * 0.66, 0, Math.sin(a) * r * 0.66, HOLO_RING, -a);
  }
  outer.build(spin, model.meshes, false, false);
  const inner = new THREE.Group(); inner.name = 'sim-spin-inner'; inner.rotation.x = 0.55;
  const ib = new GeoBatch();
  ib.add(new THREE.TorusGeometry(r * 0.44, 0.016, 8, 40), HOLO_RING, 0, 0, 0, Math.PI / 2);
  ib.add(new THREE.TorusGeometry(r * 0.3, 0.012, 8, 32), HOLO_RING, 0, 0, 0, 0, 0, Math.PI / 2);
  ib.build(inner, model.meshes, false, false);
  spin.add(inner);
  model.group.add(spin);
  model.spin = spin;
  model.spinInner = inner;
}

/* ── builders ─────────────────────────────────────────────────────────────── */
export type Builder = (b: GeoBatch, w: number, d: number, h: number, accent: THREE.Material, level: number, extra?: BuildExtra) => void;

/** Shared workbench body: legs, top, drawer block, back tool board, accent strip. `deco` adds the per-kind top items. */
function benchBody(b: GeoBatch, w: number, d: number, h: number, accent: THREE.Material, level: number, deco: (b: GeoBatch) => void): void {
  const topY = h - 0.1;
  for (const sx of [-1, 1]) b.boxB(0.08, topY, d - 0.2, sx * (w / 2 - 0.1), 0, 0, M.gunmetal);
  b.boxB(w * 0.32, topY - 0.05, d - 0.22, w * 0.26, 0.03, 0, M.hullDark);                       // drawer block (right)
  for (let k = 0; k < 3; k++) b.box(w * 0.26, 0.04, 0.03, w * 0.26, 0.2 + k * 0.24, -(d / 2 - 0.1), M.trim);
  b.box(w, 0.07, d, 0, topY + 0.035, 0, M.gunmetal);
  b.box(w - 0.04, 0.02, d - 0.06, 0, topY + 0.08, 0, M.hullLight);
  b.box(w - 0.1, 0.04, 0.05, 0, topY + 0.04, -(d / 2 - 0.03), accent);                          // front accent strip
  // back board (tool wall) with a lamp strip; taller with each level
  const boardH = 0.7 + 0.15 * (level - 1);
  b.box(w - 0.2, boardH, 0.05, 0, topY + 0.35 + boardH / 2, d / 2 - 0.03, M.hullDark);
  b.box(w - 0.18, 0.03, 0.06, 0, topY + 0.36 + boardH, d / 2 - 0.03, M.trim);
  b.box(w * 0.6, 0.05, 0.05, 0, topY + 0.32 + boardH, d / 2 - 0.09, accent);
  for (let k = 0; k < level; k++) b.box(0.06, 0.05, 0.02, -(w / 2 - 0.2) + k * 0.1, topY + 0.42, d / 2 - 0.07, M.stripWhite);   // level pips
  deco(b);
}

/**
 * Every model kind except the 11 library-media · gym pieces (A-3e · A-3a, 2026-09-12), whose builders live in
 * `FurnitureLeisure.ts` (`LEISURE_BUILDERS`) because they also rig moving parts and pose geometry. Between the two
 * records the type still demands **every** `FurnitureModelKind`.
 */
const BUILDERS: Record<Exclude<FurnitureModelKind, LeisureKind>, Builder> = {
  /* 2026-09-13 the cooking minigame: the four auto appliances (푸드 프로세서 · 자동 그릴 · 자동 교반기 · 계량 디스펜서) — `FurnitureKitchen.ts` */
  ...KITCHEN_APPLIANCE_BUILDERS,
  /* 2026-09-13 crypto mining: the lead's placeholder bodies (the contract grew the model kinds and `Record` demands them) — `FurnitureMining.ts` builds the real ones */
  /* 2026-09-13 crypto mining: 연산 클러스터 (3×3 core slots on both faces · lit cores = `extra.cores`) · 메인 컴퓨터 (three monitors) — `FurnitureMining.ts` */
  ...MINING_BUILDERS,
  bench_gun: (b, w, d, h, a, lv) => benchBody(b, w, d, h, a, lv, (b) => {
    const top = h - 0.02;
    b.boxB(0.26, 0.16, 0.2, -w * 0.3, top, 0.05, M.hullDark);                                   // vise
    b.box(0.32, 0.05, 0.05, -w * 0.3, top + 0.24, 0.05, M.hullLight);
    b.boxB(0.5, 0.12, 0.12, 0.05, top, 0.12, M.hullDark);                                       // rifle rest
    b.cyl(0.03, 0.03, 0.7, 8, 0.1, top + 0.2, 0.1, M.gunmetal, 0, 0, Math.PI / 2);              // barrel on the rest
    for (let k = 0; k < 3; k++) b.box(0.05, 0.28 + (k % 2) * 0.1, 0.05, -0.3 + k * 0.3, top + 0.75, d / 2 - 0.08, k % 2 ? M.hullLight : M.gunmetal);
  }),
  bench_gear: (b, w, d, h, a, lv) => benchBody(b, w, d, h, a, lv, (b) => {
    const top = h - 0.02;
    b.boxB(0.36, 0.5, 0.2, -w * 0.28, top, 0.02, M.padding);                                    // armour torso on a stand
    b.boxB(0.12, 0.08, 0.12, -w * 0.28, top, 0.02, M.gunmetal);
    b.cyl(0.14, 0.14, 0.34, 10, w * 0.05, top + 0.17, 0.1, M.fabric, 0, 0, Math.PI / 2);        // fabric roll
    b.boxB(0.28, 0.1, 0.22, w * 0.3, top, 0.1, M.crateDark);                                    // parts tray
  }),
  bench_gadget: (b, w, d, h, a, lv) => benchBody(b, w, d, h, a, lv, (b) => {
    const top = h - 0.02;
    b.boxB(0.34, 0.24, 0.3, -w * 0.28, top, 0.02, M.crateDark);                                 // component crate
    b.box(0.3, 0.03, 0.03, -w * 0.28, top + 0.2, -0.14, M.stripCyan);
    b.cyl(0.07, 0.09, 0.2, 10, w * 0.05, top + 0.1, 0.08, M.gunmetal);                          // mine shell
    b.cyl(0.02, 0.02, 0.05, 8, w * 0.05, top + 0.22, 0.08, M.stripRed);
    b.boxB(0.2, 0.14, 0.14, w * 0.3, top, 0.06, M.hullLight);                                   // charger box
  }),
  bench_medical: (b, w, d, h, a, lv) => benchBody(b, w, d, h, a, lv, (b) => {
    const top = h - 0.02;
    b.boxB(0.44, 0.32, 0.3, -w * 0.28, top, 0.02, M.stripWhite);                                // white cabinet
    b.box(0.2, 0.05, 0.02, -w * 0.28, top + 0.17, -0.14, M.stripRed);                           // red cross
    b.box(0.05, 0.2, 0.02, -w * 0.28, top + 0.17, -0.14, M.stripRed);
    for (let k = 0; k < 3; k++) b.cyl(0.03, 0.03, 0.16, 8, w * 0.05 + k * 0.1, top + 0.08, 0.08, M.glassDark);   // vials
    b.boxB(0.26, 0.1, 0.2, w * 0.3, top, 0.08, M.hullLight);
  }),
  /**
   * 정제 작업대 (2026-09-10): the bench for the higher-tier materials. Where the other four are "a desk that assembles
   * things", this one is a **smelter** — a crucible glowing amber on the left, a mould tray in the middle (three cooling
   * ingots), a winding drum on the right (cable · woven cloth). The crucible is raised large above the top so the silhouette alone tells it apart.
   */
  bench_refine: (b, w, d, h, a, lv) => benchBody(b, w, d, h, a, lv, (b) => {
    const top = h - 0.02;
    b.cyl(0.17, 0.21, 0.34, 12, -w * 0.3, top + 0.17, 0.02, M.hullDark);                        // crucible shell
    b.cyl(0.14, 0.14, 0.05, 12, -w * 0.3, top + 0.33, 0.02, M.stripAmber);                      // molten pool
    b.cyl(0.03, 0.03, 0.42, 8, -w * 0.3, top + 0.55, 0.02, M.gunmetal);                         // extractor pipe
    b.boxB(0.46, 0.07, 0.26, w * 0.02, top, 0.06, M.crateDark);                                 // mould tray
    for (let k = 0; k < 3; k++) b.box(0.11, 0.06, 0.16, w * 0.02 - 0.14 + k * 0.14, top + 0.09, 0.06, k === 0 ? M.stripAmber : M.trim);
    b.cyl(0.11, 0.11, 0.26, 10, w * 0.3, top + 0.11, 0.08, M.fabric, 0, 0, Math.PI / 2);        // winding drum
    b.box(0.04, 0.04, 0.3, w * 0.3, top + 0.11, 0.08, M.gunmetal);                              // drum axle
  }),
  /**
   * 정비 벤치 (Phase 8): the old cockpit `Parts.workbench` silhouette at furniture scale — steel table with a
   * drawer block, a vise on the left, a parts tray and the wall tool board that `benchBody` already draws.
   */
  repair_bench: (b, w, d, h, a, lv) => benchBody(b, w, d, h, a, lv, (b) => {
    const top = h - 0.02;
    b.boxB(0.3, 0.18, 0.22, -w * 0.3, top, 0.04, M.hullDark);                                   // vise body
    b.box(0.36, 0.05, 0.05, -w * 0.3, top + 0.26, 0.04, M.hullLight);                            // vise jaw
    b.cyl(0.02, 0.02, 0.3, 8, -w * 0.3, top + 0.24, -0.1, M.trim, 0, 0, Math.PI / 2);           // vise handle
    b.boxB(0.44, 0.08, 0.3, w * 0.28, top, 0.06, M.crateDark);                                   // spare-parts tray
    b.boxB(0.5, 0.12, 0.12, 0.02, top, 0.14, M.hullDark);                                        // weapon rest block
    for (let k = 0; k < 4; k++) b.box(0.04, 0.22 + (k % 2) * 0.12, 0.04, -0.36 + k * 0.24, top + 0.72, d / 2 - 0.08, k % 2 ? M.gunmetal : M.hullLight);
  }),
  /**
   * 재배층 (Phase 8): a shallow hydroponic tray on four short legs with `GROW_PLOTS_PER_RACK` plot pads and a
   * magenta grow strip under the tray (it lights the layer below — stacks read as a vertical farm). The whole
   * model stays under `GROW_RACK_LAYER_HEIGHT` so stacked layers never intersect.
   */
  grow_rack: (b, w, d, h, a) => {
    const trayY = Math.min(h, GROW_RACK_LAYER_HEIGHT) - 0.3;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.boxB(0.07, trayY, 0.07, sx * (w / 2 - 0.06), 0, sz * (d / 2 - 0.06), M.gunmetal);
    b.box(w - 0.06, 0.05, d - 0.06, 0, trayY + 0.025, 0, M.hullLight);                            // tray floor
    b.box(w - 0.5, 0.05, 0.12, 0, trayY - 0.04, 0, M.stripGrow);                                  // grow light under the tray
    for (const sz of [-1, 1]) b.box(w - 0.06, 0.14, 0.05, 0, trayY + 0.12, sz * (d / 2 - 0.055), M.hullDark);
    for (const sx of [-1, 1]) b.box(0.05, 0.14, d - 0.16, sx * (w / 2 - 0.055), trayY + 0.12, 0, M.hullDark);
    b.box(w - 0.16, 0.05, d - 0.16, 0, trayY + 0.08, 0, M.soil);                                  // soil bed
    for (let k = 0; k < GROW_PLOTS_PER_RACK; k++) {
      const px = -w / 2 + (k + 0.5) * (w / GROW_PLOTS_PER_RACK);
      b.cyl(0.11, 0.13, 0.07, 12, px, trayY + 0.12, 0, M.crateDark);                              // plot pad
      b.box(0.05, 0.02, 0.03, px, trayY + 0.2, -(d / 2 - 0.11), a);                               // plot marker
    }
    b.box(w - 0.3, 0.04, 0.04, 0, trayY - 0.14, -(d / 2 - 0.04), a);                              // front accent
  },
  /**
   * 재배 스테이션 (the greenhouse rework, 2026-09-11): a single hydroponic unit. It is not stacked like the old 재배층 —
   * **the furniture level opens tiers** instead: `growTiersForLevel(level)` is exactly what is drawn, and the heights come
   * from `GROW_TIER_Y` alone (an upgrade never moves the middle tier). `GROW_SLOTS_PER_TIER` pots stand on each tier, and
   * a pot is an open-topped cylinder, so it looks empty until soil is poured in. The grow light is emissive material only
   * (`stripGrow`) — no light is created (CLAUDE.md 「Never change the point-light count at runtime」).
   */
  grow_station: (b, w, d, h, a, lv) => {
    // ── Frame: plinth · 4 posts · back panel · top · front feed pipes
    b.boxB(w - 0.08, 0.12, d - 0.08, 0, 0, 0, M.hullDark);                                         // plinth
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.boxB(0.08, h, 0.08, sx * (w / 2 - 0.05), 0, sz * (d / 2 - 0.05), M.gunmetal);
    b.box(w - 0.16, h - 0.24, 0.04, 0, h / 2, d / 2 - 0.05, M.hullDark);                           // back panel
    b.box(w - 0.04, 0.07, d - 0.04, 0, h - 0.035, 0, M.hullLight);                                 // top cap
    b.box(w - 0.3, 0.04, 0.05, 0, h - 0.09, -(d / 2 - 0.04), a);                                   // top accent
    const pipeH = h - 0.24;
    for (const sx of [-1, 1]) b.cyl(0.03, 0.03, pipeH, 8, sx * (w / 2 - 0.05), 0.12 + pipeH / 2, -(d / 2 - 0.005), M.trim);
    // Control panel (left, on the plinth): screen + level pips
    b.box(0.3, 0.22, 0.06, -w * 0.32, 0.42, -(d / 2 - 0.04), M.hullLight);
    b.box(0.24, 0.15, 0.02, -w * 0.32, 0.44, -(d / 2 + 0.005), M.screen);
    for (let k = 0; k < lv; k++) b.box(0.05, 0.03, 0.02, -w * 0.32 - 0.1 + k * 0.1, 0.29, -(d / 2 + 0.005), M.stripWhite);

    // ── Tiers: only the ones the level opened stand (Lv.1 middle · Lv.2 bottom · Lv.3 top)
    for (const tier of growTiersForLevel(lv)) {
      const y = h * GROW_TIER_Y[tier];
      b.box(w - 0.14, 0.05, d - 0.12, 0, y, 0, M.hullLight);                                       // shelf board
      b.box(w - 0.16, 0.03, 0.04, 0, y + 0.035, -(d / 2 - 0.08), M.trim);                          // front edge
      b.box(w - 0.26, 0.06, 0.14, 0, y + 0.5, 0, M.hullDark);                                      // grow-light housing
      b.box(w - 0.3, 0.04, 0.1, 0, y + 0.455, 0, M.stripGrow);                                     // grow light (emissive only)
      for (const sx of [-1, 1]) b.box(0.07, 0.05, 0.07, sx * (w / 2 - 0.05), y + 0.09, -(d / 2 - 0.005), a);   // feed branch
      for (let k = 0; k < GROW_SLOTS_PER_TIER; k++) {
        const px = -w / 2 + (k + 0.5) * (w / GROW_SLOTS_PER_TIER);
        b.cyl(0.17, 0.15, 0.17, 14, px, y + 0.11, 0, M.hullDark, 0, 0, 0, true);                   // pot (open-topped, so it looks empty inside)
        b.cyl(0.15, 0.15, 0.02, 14, px, y + 0.035, 0, M.crateDark);                                // pot floor
        b.box(0.09, 0.02, 0.03, px, y + 0.07, -(d / 2 - 0.13), a);                                 // slot marker
      }
    }
  },
  /**
   * 분석기 (the lab, A-12, 2026-09-11): a station of the same grain as the 재배 스테이션 — **the level opens the slots**. On the
   * forward-tilted control console `ANALYZER_MAX_SLOTS` sample chambers (open-topped glass tubes) stand **always**, and only
   * `analyzerSlotsForLevel(level)` of them light their inner core (a locked slot stays dark) — the same contract as the panel
   * drawing a locked slot dimmed, so an upgrade reads as the next tube coming on.
   *
   * A slot waiting to be collected (`extra.analysisReady`) is **amber** instead of cyan. No light is created — it is emissive
   * material only (CLAUDE.md 「Never change the point-light count at runtime」). When a colour changes `FurnitureLayer`
   * rebuilds only that piece (`housing:analysisChanged`, the same path as a 책장's `housing:booksChanged`).
   */
  analyzer: (b, w, d, h, a, lv, extra) => {
    const open = analyzerSlotsForLevel(lv);
    const ready = Math.max(0, Math.min(ANALYZER_MAX_SLOTS, Math.floor(extra?.analysisReady ?? 0)));
    // ── Frame: plinth · rear posts · back panel · top
    b.boxB(w - 0.08, 0.14, d - 0.06, 0, 0, 0, M.hullDark);                                        // plinth
    for (const sx of [-1, 1]) b.boxB(0.09, h, 0.09, sx * (w / 2 - 0.05), 0, d / 2 - 0.05, M.gunmetal);
    b.box(w - 0.16, h - 0.34, 0.05, 0, 0.14 + (h - 0.34) / 2, d / 2 - 0.06, M.hullDark);          // back panel
    b.box(w - 0.04, 0.08, d - 0.04, 0, h - 0.04, 0, M.hullLight);                                 // top cap
    b.box(w - 0.3, 0.04, 0.05, 0, h - 0.1, -(d / 2 - 0.04), a);                                   // top accent
    // ── Control console: body + forward-tilted screen + level pips
    const deskH = h * 0.36, deskY = 0.14 + deskH;
    b.boxB(w - 0.24, deskH, d - 0.3, 0, 0.14, -0.04, M.hullLight);
    b.box(w - 0.28, 0.06, d - 0.34, 0, deskY, -0.04, M.gunmetal);
    b.box(w * 0.44, 0.03, 0.28, -w * 0.2, deskY + 0.09, -0.1, M.screen, 0, -0.55);                // tilted screen
    b.box(w * 0.46, 0.05, 0.05, -w * 0.2, deskY + 0.02, -(d / 2 - 0.17), M.hullDark);             // screen rest
    for (let k = 0; k < 3; k++) b.box(0.06, 0.02, 0.05, w * 0.16 + k * 0.1, deskY + 0.04, -0.12, k < lv ? M.stripWhite : M.hullDark);
    // ── Sample chambers: always ANALYZER_MAX_SLOTS of them, only the slots the level opened light up
    const cy = deskY + 0.03;
    const cH = Math.max(0.24, h - cy - 0.18);
    for (let s = 0; s < ANALYZER_MAX_SLOTS; s++) {
      const px = -w / 2 + (s + 0.5) * (w / ANALYZER_MAX_SLOTS);
      const lit = s < open, done = s < ready;
      const glow = lit ? (done ? M.stripAmber : M.stripCyan) : M.hullDark;
      b.cyl(0.1, 0.11, 0.05, 14, px, cy + 0.025, 0.02, M.gunmetal);                               // base
      b.cyl(0.095, 0.095, cH, 14, px, cy + 0.05 + cH / 2, 0.02, M.glassDark, 0, 0, 0, true);      // glass tube
      b.cyl(0.045, 0.045, cH * 0.62, 10, px, cy + 0.05 + cH * 0.36, 0.02, glow);                  // inner core
      b.cyl(0.11, 0.11, 0.05, 14, px, cy + 0.08 + cH, 0.02, M.hullLight);                         // top cap
      b.box(0.03, 0.02, 0.02, px, cy + 0.075 + cH, -0.095, glow);                                 // cap indicator (front)
      b.box(0.09, 0.02, 0.03, px, cy + 0.02, -(d / 2 - 0.13), lit ? (done ? M.stripAmber : a) : M.hullDark);   // slot marker
    }
  },
  /**
   * 추출기 (the lab, A-13, 2026-09-11): a still that draws components out of crops · herbs · minerals. Where the other benches
   * are "a desk that assembles", this one is a **tower** — a glass still column rising above the top on the left (amber liquid
   * inside), its condenser coils above it, a feed funnel in the middle, three receiving flasks on the right.
   */
  bench_extract: (b, w, d, h, a, lv) => benchBody(b, w, d, h, a, lv, (b) => {
    const top = h - 0.02;
    b.cyl(0.13, 0.15, 0.06, 14, -w * 0.3, top + 0.03, 0.02, M.gunmetal);                          // still-column base
    b.cyl(0.1, 0.1, 0.52, 14, -w * 0.3, top + 0.32, 0.02, M.glassDark, 0, 0, 0, true);            // glass still column
    b.cyl(0.075, 0.075, 0.2, 10, -w * 0.3, top + 0.16, 0.02, M.stripAmber);                       // boiling liquid
    for (let k = 0; k < 3; k++) b.cyl(0.13, 0.13, 0.03, 14, -w * 0.3, top + 0.46 + k * 0.06, 0.02, M.trim);   // condenser coils
    b.cyl(0.03, 0.03, 0.34, 8, -w * 0.18, top + 0.56, 0.02, M.gunmetal, 0, 0, Math.PI / 2);       // transfer pipe
    b.cyl(0.14, 0.05, 0.18, 12, w * 0.02, top + 0.19, 0.04, M.hullLight);                         // feed funnel
    b.boxB(0.16, 0.1, 0.16, w * 0.02, top, 0.04, M.hullDark);
    for (let k = 0; k < 3; k++) b.cyl(0.045, 0.03, 0.14, 10, w * 0.24 + k * 0.11, top + 0.07, 0.06, k === 1 ? M.stripCyan : M.glassDark);   // receiving flasks
    b.boxB(0.4, 0.03, 0.2, w * 0.29, top, 0.06, M.crateDark);
  }),
  /**
   * 조합대 (the lab, A-13, 2026-09-11): the bench that mixes components into preparations. The silhouette's lead is the **lidded
   * mixing drum** (left, its shaft rising out of the top); a weighing scale in the middle, a shelf of four component bottles on the right.
   */
  bench_mixer: (b, w, d, h, a, lv) => benchBody(b, w, d, h, a, lv, (b) => {
    const top = h - 0.02;
    b.cyl(0.19, 0.21, 0.26, 16, -w * 0.29, top + 0.13, 0.03, M.hullDark);                         // mixing drum
    b.cyl(0.2, 0.2, 0.03, 16, -w * 0.29, top + 0.27, 0.03, M.hullLight);                          // drum lid
    b.cyl(0.04, 0.04, 0.05, 10, -w * 0.29, top + 0.3, 0.03, a);                                   // shaft bushing
    b.cyl(0.022, 0.022, 0.3, 8, -w * 0.29, top + 0.45, 0.03, M.gunmetal);                         // stirrer shaft
    b.box(0.2, 0.04, 0.05, -w * 0.29, top + 0.58, 0.03, M.hullLight);                             // motor arm
    b.box(0.05, 0.03, 0.16, -w * 0.29, top + 0.23, -0.19, M.stripCyan);                           // status light
    b.boxB(0.24, 0.05, 0.2, w * 0.02, top, 0.05, M.gunmetal);                                     // weighing scale
    b.box(0.2, 0.02, 0.16, w * 0.02, top + 0.06, 0.05, M.hullLight);
    b.box(0.02, 0.12, 0.02, w * 0.02, top + 0.12, 0.14, M.gunmetal);                              // gauge post
    b.box(0.13, 0.1, 0.02, w * 0.02, top + 0.22, 0.14, M.screen);                                 // gauge face
    b.boxB(0.46, 0.04, 0.18, w * 0.32, top, 0.06, M.crateDark);                                   // component shelf
    for (let k = 0; k < 4; k++) b.cyl(0.032, 0.032, 0.17, 8, w * 0.32 - 0.16 + k * 0.11, top + 0.12, 0.06, k % 2 ? M.glassDark : a);
    b.box(0.46, 0.03, 0.03, w * 0.32, top + 0.21, 0.14, M.trim);
  }),
  /**
   * 조리대 (the kitchen, A-3c, 2026-09-11): the same body as the other benches (`benchBody`) with **hob · hood** on top —
   * the silhouette that reads as "this is the kitchen" from across the room is the hood canopy coming down over the top.
   * The glowing hob rings and the hood light are emissive material only and **no light is ever created** (CLAUDE.md
   * 「Never change the point-light count at runtime」 · `smoke-lights`).
   *
   * 2026-09-13 (the cooking minigame): pot and board are not merged here — they come out onto the work spot and move during a cook, so after
   * the merge `buildFurniture` attaches board (+ knife) · pot (+ ladle) · wok · grill pan · beaker as sub-groups through
   * `FurnitureKitchen.cookBenchTools`. The hob plate's placement (hx · hz · rings ±0.17 · ±0.14) is that function's rest spot for the tools — move this and fix that too.
   */
  bench_cook: (b, w, d, h, a, lv) => benchBody(b, w, d, h, a, lv, (b) => {
    const top = h - 0.02;
    const hx = -w * 0.24, hz = 0.02;   // the spot where the hood canopy (w × 0.5) does not overhang the top's left edge
    b.box(w * 0.44, 0.03, d * 0.6, hx, top + 0.015, hz, M.hullDark);                             // hob plate
    for (const ox of [-0.17, 0.17]) for (const oz of [-0.14, 0.14])
      b.cyl(0.08, 0.08, 0.016, 14, hx + ox, top + 0.035, hz + oz, M.stripRed);                   // glowing ring
    b.box(w * 0.44, 0.16, d * 0.6, hx, top + 0.66, hz, M.hullDark);                              // hood body
    b.box(w * 0.5, 0.08, d * 0.76, hx, top + 0.57, hz, M.hullLight);                             // hood canopy
    b.box(w * 0.4, 0.02, d * 0.5, hx, top + 0.52, hz, M.stripWhite);                             // hood light (emissive)
    b.box(0.2, 0.34, 0.2, hx, top + 0.91, hz + d * 0.18, M.gunmetal);                            // duct
    b.boxB(0.26, 0.14, 0.24, w * 0.36, top, -0.1, M.crateDark);                                  // ingredient crate
    for (let k = 0; k < 3; k++) b.cyl(0.03, 0.035, 0.14, 8, w * 0.1 + k * 0.09, top + 0.07, d / 2 - 0.14, k % 2 ? M.glassDark : a);   // seasoning bottles
  }),
  /**
   * 식탁 (the kitchen, A-3c, 2026-09-11): `maxLevel 1`, so it **never reads the level** (and has no pips). A top · legs · a cross
   * rail, four chairs that fit inside the footprint, and one setting of tableware that says 「a place to eat」. Only the centre lamp is emissive.
   */
  dining_table: (b, w, d, h, a, _lv, extra) => {
    const tw = Math.max(0.8, w - 0.72), td = Math.max(0.6, d - 0.72);
    const topY = h - 0.06;
    // 2026-09-16 (the plate model): the served meal — the free spot beside the centre lamp (local −X), on the tablecloth (clear of the four settings and the lamp)
    if (extra?.plate) addPlateToBatch(b, -(tw / 2 - 0.2), topY + 0.055, 0, extra.plate.mealDefId, extra.plate.quality);
    b.box(tw, 0.07, td, 0, topY, 0, M.hullLight);                                                // table top
    b.box(tw - 0.06, 0.02, td - 0.06, 0, topY + 0.045, 0, M.padding);                            // tablecloth
    b.box(tw, 0.03, 0.04, 0, topY - 0.055, -(td / 2 - 0.02), a);                                 // front-edge accent
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.boxB(0.07, topY - 0.035, 0.07, sx * (tw / 2 - 0.1), 0, sz * (td / 2 - 0.1), M.gunmetal);
    b.box(tw - 0.24, 0.05, 0.05, 0, 0.24, 0, M.gunmetal);                                        // cross rail
    for (const sz of [-1, 1]) for (const ox of [-0.26, 0.26]) {
      b.cyl(0.11, 0.1, 0.02, 14, ox, topY + 0.065, sz * (td / 2 - 0.17), M.stripWhite);          // plate
      b.box(0.02, 0.012, 0.12, ox + 0.16, topY + 0.06, sz * (td / 2 - 0.17), M.trim);            // cutlery
    }
    b.cyl(0.06, 0.08, 0.05, 12, 0, topY + 0.07, 0, M.gunmetal);                                  // centre lamp base
    b.cyl(0.05, 0.05, 0.12, 12, 0, topY + 0.15, 0, M.stripAmber);                                // lamp glow (emissive only)
    for (const sz of [-1, 1]) for (const ox of [-0.34, 0.34]) {
      const cz = sz * (d / 2 - 0.22);
      b.box(0.36, 0.05, 0.34, ox, 0.44, cz, M.padding);                                          // seat
      for (const lx of [-1, 1]) for (const lz of [-1, 1]) b.boxB(0.04, 0.44, 0.04, ox + lx * 0.14, 0, cz + lz * 0.13, M.gunmetal);
      b.box(0.36, 0.4, 0.05, ox, 0.66, cz + sz * 0.15, M.padding);                               // backrest
    }
  },
  /**
   * 배양조 (the greenhouse, A-14, 2026-09-11): a station on **the same contract as the 분석기 · 재배 스테이션** — just as the
   * screen always draws `CULTURE_MAX_SLOTS` slots, the model always stands that many culture tubes and only
   * `cultureSlotsForLevel(level)` of them light the fluid inside (a locked tube stays dark). What splits its silhouette from
   * the 분석기 is that it has **no tilted console and its tubes run up to the ceiling manifold**.
   *
   * A slot waiting to be collected (`extra.cultureReady`) is **amber** instead of culture magenta — the only way to read "go
   * and harvest" on the way into the room, and **no light is ever created** (the materials are shared, not per piece, so a
   * colour change makes `FurnitureLayer` rebuild only that piece through `housing:cultureChanged` — the 분석기's path).
   */
  culture_tank: (b, w, d, h, a, lv, extra) => {
    const open = cultureSlotsForLevel(lv);
    const ready = Math.max(0, Math.min(CULTURE_MAX_SLOTS, Math.floor(extra?.cultureReady ?? 0)));
    const looks = extra?.cultureSlots;
    // ── Plinth · medium cabinet · control panel
    b.boxB(w - 0.08, 0.14, d - 0.06, 0, 0, 0, M.hullDark);
    const cabY = 0.14, cabH = 0.5;
    b.boxB(w - 0.16, cabH, d - 0.12, 0, cabY, 0, M.hullLight);
    b.box(w - 0.2, 0.04, 0.05, 0, cabY + cabH - 0.08, -(d / 2 - 0.06), a);                       // front accent
    b.box(w * 0.34, 0.22, 0.04, -w * 0.24, cabY + 0.27, -(d / 2 - 0.05), M.glassDark);           // medium reservoir window
    b.box(w * 0.3, 0.11, 0.03, -w * 0.24, cabY + 0.21, -(d / 2 - 0.06), M.stripGrow);            // medium (emissive)
    b.box(0.3, 0.16, 0.03, w * 0.24, cabY + 0.3, -(d / 2 - 0.05), M.screen);                     // control screen
    for (let k = 0; k < 3; k++) b.box(0.05, 0.03, 0.02, w * 0.24 - 0.1 + k * 0.1, cabY + 0.14, -(d / 2 - 0.05), k < lv ? M.stripWhite : M.hullDark);
    const deck = cabY + cabH;
    b.box(w - 0.12, 0.05, d - 0.1, 0, deck + 0.025, 0, M.gunmetal);                              // plumbing deck
    // ── Rear posts + top manifold
    for (const sx of [-1, 1]) b.boxB(0.08, h - deck, 0.08, sx * (w / 2 - 0.06), deck, d / 2 - 0.06, M.gunmetal);
    b.box(w - 0.1, 0.12, 0.14, 0, h - 0.1, d / 2 - 0.08, M.hullDark);
    b.box(w - 0.16, 0.03, 0.04, 0, h - 0.17, d / 2 - 0.15, a);
    // ── Culture tubes: always CULTURE_MAX_SLOTS of them, only the slots the level opened glow with fluid
    const tubeY = deck + 0.05, tubeH = Math.max(0.3, h - tubeY - 0.24);
    for (let s = 0; s < CULTURE_MAX_SLOTS; s++) {
      const px = -w / 2 + (s + 0.5) * (w / CULTURE_MAX_SLOTS);
      const lit = s < open;
      b.cyl(0.12, 0.14, 0.06, 14, px, tubeY + 0.03, 0, M.gunmetal);                              // tube base
      if (looks) {
        // 2026-09-17: the slot's real state — only a tube with medium poured in fills with fluid in that medium's colour, and a strain in it stands cell masses in the liquid
        const look = lit ? looks[s] ?? null : null;
        const done = !!look?.ready;
        b.cyl(0.115, 0.115, tubeH, 14, px, tubeY + 0.06 + tubeH / 2, 0, lit ? CULTURE_GLASS : M.glassDark, 0, 0, 0, true);   // glass tube
        const fluidH = tubeH * 0.62, fluidY = tubeY + 0.06;
        if (look) b.cyl(0.1, 0.1, fluidH, 14, px, fluidY + fluidH / 2, 0, cultureFluid(look.color));                     // culture fluid
        else b.cyl(0.1, 0.1, 0.02, 14, px, fluidY + 0.01, 0, lit ? M.hullDark : M.gunmetal);                             // empty tube floor
        if (look?.filled) {
          // Three cell masses — 「something is in it」, never which kind. Opaque, so they show through the fluid and the glass
          b.add(new THREE.SphereGeometry(0.042, 10, 8), CULTURE_MASS, px, fluidY + fluidH * 0.42, -0.012);
          b.add(new THREE.SphereGeometry(0.03, 10, 8), CULTURE_MASS, px + 0.035, fluidY + fluidH * 0.62, 0.018);
          b.add(new THREE.SphereGeometry(0.024, 8, 6), CULTURE_MASS, px - 0.032, fluidY + fluidH * 0.27, 0.02);
        }
        b.cyl(0.018, 0.018, tubeH * 0.78, 6, px, tubeY + 0.06 + tubeH * 0.39, 0.075, M.trim);       // aeration pipe
        b.cyl(0.13, 0.13, 0.06, 14, px, tubeY + 0.09 + tubeH, 0, M.hullLight);                      // top cap
        b.cyl(0.024, 0.024, d / 2 - 0.1, 8, px, h - 0.13, (d / 2 - 0.1) / 2, M.trim, Math.PI / 2);  // feed line (manifold → tube)
        b.cyl(0.02, 0.02, 0.09, 6, px, h - 0.18, 0, M.trim);                                        // nozzle
        b.box(0.09, 0.02, 0.03, px, tubeY + 0.02, -(d / 2 - 0.1), lit ? (done ? M.stripAmber : a) : M.hullDark);   // slot marker
        continue;
      }
      const done = s < ready;
      const glow = lit ? (done ? M.stripAmber : M.stripGrow) : M.hullDark;
      b.cyl(0.115, 0.115, tubeH, 14, px, tubeY + 0.06 + tubeH / 2, 0, M.glassDark, 0, 0, 0, true);   // glass tube
      b.cyl(0.085, 0.085, tubeH * 0.52, 12, px, tubeY + 0.06 + tubeH * 0.26, 0, glow);            // culture fluid
      b.cyl(0.018, 0.018, tubeH * 0.78, 6, px, tubeY + 0.06 + tubeH * 0.39, 0.055, M.trim);       // aeration pipe
      b.cyl(0.13, 0.13, 0.06, 14, px, tubeY + 0.09 + tubeH, 0, M.hullLight);                      // top cap
      b.cyl(0.024, 0.024, d / 2 - 0.1, 8, px, h - 0.13, (d / 2 - 0.1) / 2, M.trim, Math.PI / 2);  // feed line (manifold → tube)
      b.cyl(0.02, 0.02, 0.09, 6, px, h - 0.18, 0, M.trim);                                        // nozzle
      b.box(0.09, 0.02, 0.03, px, tubeY + 0.02, -(d / 2 - 0.1), lit ? (done ? M.stripAmber : a) : M.hullDark);   // slot marker
    }
  },
  /**
   * 3D 프린터 (A-15, 2026-09-11): the bench that prints higher-grade bags · pouches out of filament. Unlike the other benches
   * it is **a box, not a desk** (def height 1.6 — `benchBody`'s legs at that height would make a table as tall as a person).
   * Four posts · side glass · a top raise a chamber over the base cabinet, holding the build plate · a cross gantry · the
   * nozzle, with two filament spools behind. Chamber light · heated bed · glowing nozzle are all emissive material.
   */
  bench_print: (b, w, d, h, a, lv) => {
    const cabH = Math.min(0.62, h * 0.4);
    // ── Base cabinet
    b.boxB(w - 0.08, 0.12, d - 0.06, 0, 0, 0, M.hullDark);
    b.boxB(w - 0.14, cabH - 0.12, d - 0.12, 0, 0.12, 0, M.hullLight);
    b.box(w - 0.2, 0.04, 0.05, 0, cabH - 0.12, -(d / 2 - 0.06), a);                              // front accent
    b.box(0.34, 0.18, 0.03, -w * 0.28, cabH - 0.3, -(d / 2 - 0.05), M.screen);                   // control screen
    for (let k = 0; k < 3; k++) b.box(0.05, 0.03, 0.02, -w * 0.28 - 0.1 + k * 0.1, cabH - 0.46, -(d / 2 - 0.05), k < lv ? M.stripWhite : M.hullDark);
    for (let k = 0; k < 3; k++) b.box(w * 0.28, 0.03, 0.02, w * 0.2, 0.2 + k * 0.13, -(d / 2 - 0.05), M.trim);   // drawer handles
    // ── Chamber frame
    const fy = cabH, fh = h - cabH;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.boxB(0.07, fh, 0.07, sx * (w / 2 - 0.06), fy, sz * (d / 2 - 0.06), M.gunmetal);
    b.box(w - 0.04, 0.07, d - 0.04, 0, h - 0.035, 0, M.hullLight);                               // top
    b.box(w - 0.3, 0.04, 0.05, 0, h - 0.09, -(d / 2 - 0.04), a);                                 // top accent
    b.box(w - 0.16, fh - 0.1, 0.03, 0, fy + fh / 2, d / 2 - 0.05, M.hullDark);                   // back panel
    for (const sx of [-1, 1]) b.box(0.03, fh - 0.16, d - 0.2, sx * (w / 2 - 0.07), fy + fh / 2, 0, M.glassDark);   // side glass
    b.box(w - 0.34, 0.02, 0.06, 0, h - 0.1, 0, M.stripWhite);                                    // chamber light (emissive)
    // ── Build plate + the print rising on it
    const plateY = fy + 0.14, plateX = -w * 0.06;
    b.box(w * 0.52, 0.05, d * 0.56, plateX, plateY, 0.02, M.gunmetal);
    b.box(w * 0.48, 0.02, d * 0.5, plateX, plateY + 0.035, 0.02, M.hullLight);
    b.box(w * 0.5, 0.02, 0.03, plateX, plateY + 0.03, -(d * 0.3), M.stripAmber);                 // heated bed (emissive)
    for (let k = 0; k < 3; k++) b.box(0.3 - k * 0.07, 0.06, 0.22 - k * 0.05, plateX, plateY + 0.08 + k * 0.06, 0.02, a);
    // ── Gantry · Z lead screws · filament spools
    const gy = plateY + 0.44;
    b.box(w - 0.2, 0.07, 0.09, 0, gy, 0.02, M.hullLight);
    for (const sx of [-1, 1]) b.boxB(0.1, 0.16, 0.12, sx * (w / 2 - 0.13), gy - 0.08, 0.02, M.gunmetal);
    b.box(0.16, 0.14, 0.16, plateX, gy - 0.12, 0.02, M.hullDark);                                // print head
    b.cyl(0.02, 0.045, 0.08, 10, plateX, gy - 0.22, 0.02, M.stripAmber);                         // nozzle (emissive)
    for (const sx of [-1, 1]) b.cyl(0.018, 0.018, fh - 0.2, 8, sx * (w / 2 - 0.14), fy + 0.06 + (fh - 0.2) / 2, 0.02, M.trim);
    for (let k = 0; k < 2; k++) {
      const sy = fy + 0.26 + k * 0.36;
      b.cyl(0.15, 0.15, 0.07, 16, w * 0.34, sy, 0.22, k === 0 ? a : M.fabric, Math.PI / 2);       // filament spool
      b.cyl(0.05, 0.05, 0.1, 10, w * 0.34, sy, 0.22, M.gunmetal, Math.PI / 2);                    // spool hub
    }
  },
  range_console: (b, w, d, h, a) => {
    b.boxB(w - 0.1, h - 0.45, d - 0.2, 0, 0, 0.05, M.hullDark);
    b.box(w - 0.06, 0.06, d - 0.16, 0, h - 0.43, 0.05, M.trimDark);
    b.box(w - 0.2, 0.5, 0.1, 0, h - 0.15, -0.02, M.hullLight, 0, -0.35);
    b.box(w - 0.3, 0.36, 0.03, 0, h - 0.14, -0.1, M.screen, 0, -0.35);
    b.box(w - 0.3, 0.04, 0.1, 0, h - 0.42, -(d / 2 - 0.16), a);
    b.cyl(0.05, 0.05, 0.3, 8, w * 0.3, h - 0.3, 0.25, M.gunmetal);                              // antenna
    b.cyl(0.02, 0.02, 0.5, 6, w * 0.3, h - 0.05, 0.25, M.trim);
  },
  target_lane: (b, w, d, h, a) => {
    b.box(w - 0.06, 0.03, d - 0.06, 0, 0.015, 0, M.floorGrate);                                 // lane plate
    for (const sx of [-1, 1]) b.boxB(0.05, 0.28, d - 0.1, sx * (w / 2 - 0.05), 0, 0, M.hullLight);
    for (let k = 0; k < 4; k++) b.box(w - 0.12, 0.01, 0.04, 0, 0.032, -(d / 2) + 0.4 + k * (d - 0.8) / 3, a);   // distance marks
    b.boxB(w - 0.1, 0.5, 0.06, 0, 0, -(d / 2 - 0.08), M.hullDark);                              // shooter's barrier
    b.box(w - 0.14, 0.04, 0.08, 0, 0.5, -(d / 2 - 0.08), M.stripAmber);
    // target at the far end: post + board + rings
    b.boxB(0.08, h - 0.9, 0.08, 0, 0, d / 2 - 0.16, M.gunmetal);
    b.box(0.6, 0.9, 0.04, 0, h - 0.45, d / 2 - 0.16, TARGET);
    b.cyl(0.2, 0.2, 0.02, 20, 0, h - 0.45, d / 2 - 0.19, TARGET_RING, Math.PI / 2);
    b.cyl(0.1, 0.1, 0.02, 16, 0, h - 0.45, d / 2 - 0.2, TARGET, Math.PI / 2);
    b.boxB(w, 0.04, 0.12, 0, h - 0.04, d / 2 - 0.1, M.hullLight);                                // top rail
    b.box(w - 0.2, 0.02, 0.05, 0, h - 0.06, d / 2 - 0.02, M.stripWhite);                          // lane light
  },
  locker: (b, w, d, h, a) => {
    b.boxB(w - 0.06, h, d - 0.06, 0, 0, 0, M.hullDark);
    // a 1 × 2 locker is 0.5 m wide and 1 m deep: its two doors sit on the −X / +X faces
    for (const sx of [-1, 1]) {
      b.box(0.02, h - 0.14, d - 0.12, sx * (w / 2 - 0.03), h / 2, 0, M.hullLight);
      b.box(0.02, 0.24, 0.05, sx * (w / 2 - 0.05), h * 0.55, 0.12, M.trim);
      b.box(0.02, 0.03, d * 0.35, sx * (w / 2 - 0.05), h * 0.8, 0, M.trim);
    }
    b.box(w - 0.1, 0.05, d - 0.1, 0, h + 0.02, 0, a);
  },
  table: (b, w, d, h) => {
    b.box(w, 0.06, d, 0, h - 0.03, 0, M.gunmetal);
    b.box(w - 0.06, 0.02, d - 0.06, 0, h + 0.01, 0, M.hullLight);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.boxB(0.07, h - 0.06, 0.07, sx * (w / 2 - 0.08), 0, sz * (d / 2 - 0.08), M.hullDark);
    b.box(w - 0.2, 0.04, 0.04, 0, h - 0.12, 0, M.hullDark);
    b.boxB(0.3, 0.08, 0.2, -w * 0.25, h, 0.1, M.crateDark);
  },
  /* The library 책장 (Phase 9): body + BOOK_SHELF_ROWS shelves, one spine box per shelved book (colour = rarity), empty slots stay empty. */
  bookshelf: (b, w, d, h, a, _lv, extra) => {
    for (const sx of [-1, 1]) b.boxB(0.05, h, d, sx * (w / 2 - 0.03), 0, 0, M.hullLight);
    b.box(w, h, 0.03, 0, h / 2, d / 2 - 0.02, M.hullDark);                                  // back board
    b.box(w, 0.05, d, 0, h - 0.025, 0, M.hullLight);                                        // top
    b.box(w - 0.1, 0.05, d - 0.02, 0, 0.06, 0, M.gunmetal);                                 // plinth
    b.box(w - 0.14, 0.03, 0.04, 0, h - 0.06, -(d / 2 - 0.02), a);                           // accent lip under the top
    // 2026-09-13: 4 shelves × 2 slots (BOOKS_PER_SHELF 8) — slot 0 = top-left, row-major, same order as the 2D panel
    const rows = BOOK_SHELF_ROWS, perRow = Math.ceil(BOOKS_PER_SHELF / rows);
    const y0 = 0.1, rowH = (h - 0.2) / rows;
    const books = extra?.books ?? [];
    const slotW = (w - 0.1) / perRow;
    for (let r = 0; r < rows; r++) {
      const y = y0 + r * rowH;
      b.box(w - 0.1, 0.04, d - 0.06, 0, y, 0.01, M.gunmetal);                              // shelf board
      b.box(w - 0.12, 0.02, 0.03, 0, y + 0.015, -(d / 2 - 0.05), M.trim);                    // front edge
      for (let k = 1; k < perRow; k++) {
        b.boxB(0.02, Math.min(0.36, rowH - 0.08), d - 0.1, -(w - 0.1) / 2 + k * slotW, y + 0.02, 0.01, M.gunmetal);   // slot divider
      }
      for (let k = 0; k < perRow; k++) {
        const slot = (rows - 1 - r) * perRow + k;                                          // slot 0 = top-left
        const rarity = books[slot] ?? null;
        if (!rarity) continue;
        const bx = -(w - 0.1) / 2 + (k + 0.5) * slotW;                                     // centred in its slot
        const bh = Math.min(rowH - 0.1, 0.24 + ((slot * 7) % 3) * 0.03), bt = 0.1 + ((slot * 5) % 2) * 0.02;
        b.boxB(bt, bh, d - 0.18, bx, y + 0.02, 0.02, spine(RARITY_COLORS[rarity]));        // spine (the book stands upright)
        b.box(bt + 0.01, 0.015, d - 0.2, bx, y + 0.02 + bh * 0.72, 0.02, M.trim);           // title band
      }
    }
  },
  shelf: (b, w, d, h) => {
    for (const sx of [-1, 1]) b.boxB(0.05, h, d, sx * (w / 2 - 0.03), 0, 0, M.hullLight);
    b.box(w, h, 0.03, 0, h / 2, d / 2 - 0.02, M.hullDark);
    for (let k = 0; k < 3; k++) {
      const y = 0.3 + k * (h - 0.4) / 2;
      b.box(w - 0.1, 0.04, d - 0.04, 0, y, 0, M.gunmetal);
      b.boxB(0.18, 0.16 + (k % 2) * 0.08, d * 0.5, -w * 0.25 + k * 0.12, y + 0.02, 0, k % 2 ? M.crate : M.crateDark);
      b.boxB(0.12, 0.2, d * 0.4, w * 0.25, y + 0.02, 0.02, M.padding);
    }
  },
  crate: (b, w, d, h) => {
    b.boxB(w - 0.06, h, d - 0.06, 0, 0, 0, M.crate);
    b.box(w - 0.02, 0.05, d - 0.02, 0, h / 2, 0, M.crateDark);
    b.box(0.26, 0.05, 0.05, 0, h - 0.12, -(d / 2 - 0.02), M.stripAmber);
    b.box(w - 0.1, 0.03, 0.03, 0, h + 0.01, 0, M.hullDark);
  },
  lamp: (b, w, _d, h) => {
    b.cyl(0.16, 0.2, 0.05, 14, 0, 0.025, 0, M.hullDark);
    b.cyl(0.025, 0.025, h - 0.4, 8, 0, (h - 0.4) / 2 + 0.05, 0, M.gunmetal);
    b.cyl(w * 0.34, w * 0.44, 0.34, 14, 0, h - 0.2, 0, M.padding, 0, 0, 0, true);
    b.cyl(w * 0.28, w * 0.28, 0.3, 12, 0, h - 0.2, 0, LAMP_GLOW);
    b.cyl(0.04, 0.04, 0.04, 8, 0, h - 0.01, 0, M.trim);
  },
  plant: (b, w, _d, h) => {
    b.cyl(w * 0.34, w * 0.26, 0.34, 12, 0, 0.17, 0, POT);
    b.cyl(w * 0.3, w * 0.3, 0.04, 12, 0, 0.35, 0, M.soil);
    b.cyl(0.02, 0.03, h - 0.5, 6, 0, 0.35 + (h - 0.5) / 2, 0, LEAF);
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2, y = 0.55 + k * 0.1;
      b.box(0.28, 0.02, 0.1, Math.cos(a) * 0.12, y, Math.sin(a) * 0.12, LEAF, -a, 0, 0.5);
    }
    b.box(0.16, 0.02, 0.08, 0, h - 0.05, 0, LEAF, 0.6, 0, 0.3);
  },
  /* The 의자 (`chair`) moved to `FurnitureLeisure.ts` on 2026-09-13 — its sitting pose geometry (`rig`) has to ship with the model. */
  /** 시뮬레이션 허브 (Phase 7): holo pedestal — base plate, glowing foot ring, column, dish with three control pads,
   *  emitter disc and a translucent core beam; the rotating rings are added by `simHubRings` after the merge. */
  sim_hub: (b, w, d, h, a) => {
    const r = Math.min(w, d) / 2;
    b.cyl(r - 0.04, r, 0.1, 24, 0, 0.05, 0, M.hullDark);                                       // base plate
    b.cyl(r - 0.1, r - 0.07, 0.04, 24, 0, 0.12, 0, a);                                          // foot glow ring
    const colH = h * 0.42;
    b.cyl(r * 0.42, r * 0.58, colH, 16, 0, 0.14 + colH / 2, 0, M.gunmetal);                    // column
    for (let k = 0; k < 4; k++) b.box(0.03, colH - 0.1, 0.02, Math.cos(k * Math.PI / 2) * r * 0.5, 0.14 + colH / 2, Math.sin(k * Math.PI / 2) * r * 0.5, M.trim, -k * Math.PI / 2);
    const dishY = 0.14 + colH;
    b.cyl(r * 0.82, r * 0.52, 0.17, 24, 0, dishY + 0.085, 0, M.hullLight);                     // dish
    const dishTop = dishY + 0.17;
    b.cyl(r * 0.68, r * 0.68, 0.03, 24, 0, dishTop + 0.015, 0, a);                             // emitter disc
    for (let k = 0; k < 3; k++) {                                                              // control pads
      const ang = (k / 3) * Math.PI * 2 + Math.PI / 6;
      const px = Math.cos(ang) * r * 0.86, pz = Math.sin(ang) * r * 0.86;
      b.box(0.2, 0.05, 0.13, px, dishTop - 0.02, pz, M.hullDark, -ang);
      b.box(0.15, 0.012, 0.08, px, dishTop + 0.01, pz, M.screen, -ang);
    }
    b.cyl(0.05, 0.11, h - dishTop - 0.15, 12, 0, dishTop + (h - dishTop - 0.15) / 2 + 0.03, 0, HOLO_CORE);   // core beam
  },
  bunk: (b, w, d, h) => {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.boxB(0.07, h, 0.07, sx * (w / 2 - 0.05), 0, sz * (d / 2 - 0.05), M.hullLight);
    for (const y of [0.45, h - 0.4]) {
      b.box(w, 0.08, d, 0, y, 0, M.hullDark);
      b.box(w - 0.1, 0.12, d - 0.1, 0, y + 0.1, 0, M.fabric);
      b.box(0.36, 0.08, 0.26, 0, y + 0.2, d / 2 - 0.25, M.padding);
      b.box(w - 0.12, 0.04, 0.04, 0, y + 0.3, -(d / 2 - 0.03), M.trim);                        // guard rail
    }
    b.box(0.05, 0.03, 0.4, -(w / 2 - 0.1), 0.9, -(d / 2 - 0.02), M.gunmetal);                   // ladder rungs
    for (let k = 0; k < 4; k++) b.box(0.3, 0.03, 0.03, -(w / 2 - 0.25), 0.6 + k * 0.25, -(d / 2 - 0.02), M.gunmetal);
  },
  /**
   * 전술 임플란트 시술대 (2026-09-12, 공용 시설 가구): **the same body** as the implant bay built into the cockpit (`stations.implantBayBody`).
   * The body spans local x −0.79 … 0.36 · z −0.62 … 0.75, so it is shifted by (+0.2, −0.06) to sit in the middle of the footprint
   * (3 × 4 cells = 1.5 × 2 m); only a rim plate over the footprint and a front-edge accent are added on the floor. No lights — the canopy glow is emissive material only.
   */
  implant_bay: (b, w, d, _h, a) => {
    b.box(w - 0.1, 0.03, d - 0.1, 0, 0.015, 0, M.floorGrate);                                    // floor plate
    b.box(w - 0.3, 0.02, 0.05, 0, 0.04, -(d / 2 - 0.08), a);                                     // front accent
    implantBayBody(b, 0.2, -0.06, 0);
  },
  /**
   * 기업 네트워크 컴퓨터 (2026-09-12, 공용 시설 가구): **the same body** as the built-in desk (`stations.shipComputerBody`). The body's centre
   * is pushed to `d/2 − 0.4` so the desk's back sits against the footprint's rear edge (local +Z) — the chair stays inside the footprint at the front (−Z).
   * The left monitor's text panel (`TextPlane`) is beyond a builder, so `FurnitureLayer.addPiece` attaches it at `COMPUTER_SCREEN_LOCAL`.
   */
  corp_computer: (b, _w, d) => {
    shipComputerBody(b, 0, d / 2 - 0.4, 0);
  },
  /**
   * 서랍장 (2026-09-13, decorative furniture `furn_drawer`): the same look as the stash cabinet built into the cockpit's back wall
   * (`PersonalShip.stashCabinet`) — dark body · top slab · three drawers (light panel + handle) · an amber strip. Only the depth was cut to fit
   * the old dimensions (0.9 × 2.2 × 0.55 m) into the footprint (2 × 1 cells = 1.0 × 0.5 m); drawer height scales with `h` (at h 2.2 the old values). The drawers face front (−Z). No lights.
   */
  drawer: (b, w, d, h) => {
    const bw = Math.min(0.9, w - 0.1), bd = d - 0.04, front = -bd / 2;
    const k = h / 2.2;
    b.boxB(bw, h, bd, 0, 0, 0, M.hullDark);
    b.box(bw + 0.04, 0.05, bd + 0.03, 0, h + 0.02, 0, M.trimDark);
    for (let i = 0; i < 3; i++) {
      const y = (0.4 + i * 0.62) * k;
      b.box(bw - 0.1, 0.5 * k, 0.03, 0, y, front - 0.01, M.hullLight);
      b.box(0.3, 0.04, 0.03, 0, y, front - 0.03, M.trim);
    }
    b.box(bw - 0.2, 0.05, 0.04, 0, h - 0.15 * k, front - 0.01, M.stripAmber);
  },
  /* 2026-09-13 (library series · video games): 게임 디스크 전시대 · 쇼파 · 좌식 테이블 · 러그 are built by `FurnitureLeisure.ts` (the lead's placeholder boxes are gone) */
};

/** Where the left monitor sits on the 기업 네트워크 컴퓨터 model (furniture-local coordinates) — the same desk offset as the `corp_computer` builder. */
function computerScreenLocal(d: number): { pos: THREE.Vector3; rot: THREE.Euler } {
  const { screenPos, screenRot } = computerScreenPose(0, d / 2 - 0.4, 0);
  return { pos: screenPos, rot: screenRot };
}

/* ── placed-furniture layer ───────────────────────────────────────────────── */
export interface FurnitureCallbacks {
  /** Interactables are usable (walking the ship, no menu, not boarded, not in housing mode). */
  canUse(): boolean;
  onBench(kind: WorkbenchKind, level: number): void;
  /*
   * 2026-09-12 (user's decision — the 시뮬레이션실 was removed): `onRangeConsole()` (관물대 → the preset menu) and `onSimHub()` (시뮬레이션
   * 허브 → the training arena) lived here. Both pieces are retired (`retired=1`, refunded on load), presets are gone and the arena is
   * entered from the terminal — `RETIRED_INTERACTIONS` below registers **no** interactable for those kinds.
   */
  /** 전술 임플란트 시술대 (2026-09-12, 공용 시설 가구): the Tab window's implant slots, like the old `hub_implant_bay`. */
  onImplantBay(): void;
  /** 기업 네트워크 컴퓨터 (2026-09-12, 공용 시설 가구): the corporation screen, like the old `hub_computer`. */
  onCorpComputer(): void;
  /**
   * 재배층 (Phase 8). @deprecated 2026-09-11 (the greenhouse rework) — `furn_grow_rack` is retired and `ShipState.sanitize`
   * sweeps away any placed one, so this is never actually called. The contract is add-only, so the path stays.
   */
  onGrowRack(uid: string): void;
  /** 재배 스테이션 (the greenhouse rework, 2026-09-11): that station's grow screen (`ctx.housing.openGrowStation(uid)`). */
  onGrowStation(uid: string): void;
  /*
   * 정비 벤치 (Phase 8) — **retired 2026-09-12** (user's decision). `onRepairBench(): void` lived here and opened
   * `hub/ui/WorkbenchMenu`. Repairing a weapon in the ship is now done from the inventory with materials, so neither that
   * window nor the `furn_repair_bench` piece exists (`retired=1` in `data/furniture.csv` → `ShipState.sanitize` refunds it).
   * `'repair_bench'` stays in `FurnitureInteraction` because the contract is add-only, and the dispatch below catches that
   * value in a branch that does **nothing** — drop it and it falls through to `else cb.onRangeConsole()` and opens the wrong window.
   */
  /** 책장 (Phase 9): open the bookshelf panel of this piece (`ctx.housing.openBookshelfMenu(uid)`). */
  onBookshelf(uid: string): void;
  /** 분석기 (the lab, A-12, 2026-09-11): open this piece's `해석` panel (`ctx.housing.openAnalyzer(uid)`). */
  onAnalyzer(uid: string): void;
  /** 배양조 (the greenhouse, A-14, 2026-09-11): open this piece's `배양` panel (`ctx.housing.openCultureTank(uid)`). */
  onCultureTank(uid: string): void;
  /**
   * 식탁 (the kitchen, A-3c, 2026-09-11): open the `식사` panel (`ctx.housing.openDiningTable(uid)`). A placed piece always
   * passes its own `uid`; **`null` is reserved for the shared ship's fixed table**, which is not furniture at all
   * and is registered by `parts/Interior.buildStations` instead of this layer.
   */
  onDiningTable(uid: string): void;
  /**
   * The 조리대 screen (2026-09-13, the cooking minigame): `ctx.housing.openCookStation(uid)`. A 조리대 passes its own uid, an auto appliance
   * the ship's 조리대 uid (`FurnitureLayer.cookBenchUid`) — **null** when there is none (toast `조리대가 없습니다`). A 조리대 no longer goes through `onBench`.
   */
  onCookStation(uid: string | null): void;
  /* ── A-3e · A-3a (2026-09-12) ── */
  /** 디스크 전시대 · 레코드랙: that holder's screen (`ctx.housing.openShelf(uid)`). */
  onShelf(uid: string): void;
  /**
   * 흔들의자: sits with `pose` (anchor on the seat's top face · yaw facing front · released with E) through `ctx.player.setFurniturePose`.
   * True once seated — the layer rocks the chair meanwhile.
   */
  onSit(uid: string, pose: FurniturePose): boolean;
  /** TV · record player: turn on / off (`ctx.housing.toggleFurniture(uid)`). */
  onToggle(uid: string): void;
  /** A gym machine: the minigame session (`ctx.housing.startGymSession(uid)` — a refusal reason is a toast). The pose · camera are raised by the layer's `GymStaging`. */
  onGym(uid: string): void;
  /**
   * The TV screen (2026-09-13, video games — optional): `ctx.housing.openTvMenu(uid)`. The layer takes this path only when `openTvMenu` exists (else the old
   * on / off `onToggle`), and calls `ctx.housing.openTvMenu` directly when there is no callback.
   */
  onTvMenu?(uid: string): void;
  /* ── Crypto mining (2026-09-13) — both optional: without them the layer calls `ctx.housing.openComputeCluster` / `openMiningComputer` directly ── */
  /** 연산 클러스터: the unified mining window on that cluster's `채굴` tab (`ctx.housing.openComputeCluster(uid)`). */
  onComputeCluster?(uid: string): void;
  /** 메인 컴퓨터: the same window on the `클러스터 현황` tab (`ctx.housing.openMiningComputer(uid)`). */
  onMiningComputer?(uid: string): void;
  /* ── Remote furniture staging (2026-09-12, character buffs · furniture-pose sync) — both optional; a visited ship's layer gets the same ── */
  /** The remote squadmate list (a smoke's debug refs included). Absent = `ctx.net.getRemotePlayers()`. */
  remotePlayers?(): readonly RemotePlayerRef[];
  /** The ship the player stands in (`HubRef.hubSite`). Absent = `ctx.hub.hubSite`. */
  hubSite?(): PeerId | null;
}

const NO_REMOTES: readonly RemotePlayerRef[] = [];
/** The catalogue's console kinds (sorted) — gathered once when first needed (`FurnitureLayer.consoleLookOf`). The catalogue never changes during a session. */
let consoleKinds: string[] | null = null;

/**
 * Visiting a personal ship (2026-09-08): where the layer reads its pieces from. Default = `ctx.housing` (the player's own ship). A
 * **visited** ship passes a frozen source built from that member's `ShipVisitWire` instead — it never changes, so
 * the layer also skips its `housing:*` subscriptions and registers no interactables (look-around only).
 */
export interface FurnitureSource {
  getPlaced(room: number): readonly PlacedFurniture[];
  /** Shelved book rarities of a 책장 by slot (null = empty slot). */
  getBooks(uid: string): readonly (Rarity | null)[];
  /** A-3e (2026-09-12): the rarity of the media in a 디스크 전시대 · 레코드랙, in slot order (`ShipVisitWire.media`). */
  getMedia?(uid: string): readonly (Rarity | null)[];
  /** A-3e (2026-09-12): whether a TV · record player is on (`ShipVisitWire.toggled`). */
  isOn?(uid: string): boolean;
  /** 2026-09-17: 배양조 slots — the medium def id · whether a strain is in it (`ShipVisitWire.cultures`). */
  getCultures?(uid: string): readonly { slot: number; medium: string; filled: boolean }[];
}

interface Piece {
  item: PlacedFurniture;
  model: FurnitureModel;
  blocker: number;
  sign: TextPlane | null;
  /** 2026-09-12: the 기업 네트워크 컴퓨터's monitor text panel (a child of that piece's group — disposed with the piece). */
  screen: TextPlane | null;
  interactable: Interactable | null;
  /** World box (the same dimensions as the collider blocker) — tells whether the gym camera is occluded by neighbouring furniture (A-3a, 2026-09-12). */
  box: FootBox;
}

/**
 * 2026-09-12: interactions whose furniture is retired (`retired=1`, refunded by housing on load) — a stale piece that
 * somehow reaches the layer is drawn but answers to nothing. `range_console` (관물대 · presets — the feature is gone),
 * `sim_hub` (시뮬레이션 허브 — the arena is entered from the terminal), `repair_bench` (정비 벤치, retired the same day).
 */
const RETIRED_INTERACTIONS: ReadonlySet<string> = new Set(['range_console', 'sim_hub', 'repair_bench']);

/**
 * 2026-09-12: the two **공용 시설 가구** keep the interactable ids their built-in cockpit fixtures had, so the tutorial,
 * the smokes and anything else that looks up `hub_computer` / `hub_implant_bay` keeps working. Radius and prompt are
 * the old stations' too.
 */
const FIXTURE_INTERACTABLE: Readonly<Partial<Record<string, { id: string; prompt: string; radius: number }>>> = {
  corp_computer: { id: 'hub_computer', prompt: '기업 네트워크', radius: 2.2 },
  implant_bay: { id: 'hub_implant_bay', prompt: '전술 임플란트 장착', radius: 2.3 },
};

const _pos = new THREE.Vector3();

/**
 * `housing:changed` reasons whose furniture effect already arrived through a per-piece `housing:furniture*` event
 * (or that touch no placed piece at all) — the layer must not rebuild all ten rooms for them. Anything else
 * (an unknown / future reason) still rebuilds everything.
 */
const COVERED_CHANGE_REASONS: ReadonlySet<string> = new Set([
  'place', 'move', 'recover', 'furnitureUpgrade',   // per-piece events rebuilt the room
  'craft', 'preset', 'purpose',                       // storage / presets / purpose (its recoveries were per-piece)
  'books',                                            // Phase 9: `housing:booksChanged` rebuilds that shelf's room
  'facility:generator', 'facility:storage', 'facility:workshop', 'facility:range',
  'shelfPlace', 'shelfTake',                          // A-3e: `housing:shelfChanged` rebuilds that holder's room
  'toggle',                                           // A-3e: `housing:furnitureToggled` rebuilds that TV · record player's room
]);

/**
 * Renders `ctx.housing.getPlaced(room)` for every room of the personal ship: a model per piece under the room's
 * `furnitureGroup`, a collider blocker, a `Lv.n` sign for upgradeable pieces and an `Interactable`
 * `hub_furn_<uid>` for pieces with an interaction. Rebuilds a room on every `housing:furniture*`; `housing:changed`
 * rebuilds everything only for a reason no per-piece event covered (`COVERED_CHANGE_REASONS`), `housing:loaded` always.
 */
export class FurnitureLayer {
  private pieces = new Map<string, Piece>();
  private unsubs: Array<() => void> = [];
  /** Gym-session staging (A-3a) — only in the player's own ship (null in a visited ship). */
  private staging: GymStaging | null = null;
  /** The uid of the 흔들의자 being sat in (A-3e) — rocked while the player's pose is `sit`. */
  private sitUid: string | null = null;
  /**
   * Remote furniture staging (2026-09-12) — turns the piece a squadmate in the same ship points at by that person's phase. Unlike
   * `GymStaging` it exists **in a visited ship's layer too** (a visitor watching the owner work out is what this is for).
   */
  private remote: RemoteFurnitureStaging | null = null;
  /** Cook staging (2026-09-13, the cooking minigame) — only in the player's own ship (null in a visited ship). */
  private cook: CookStaging | null = null;
  /** Video-game staging (2026-09-13) — seat pose · fixed camera · TV game screen. Only in the player's own ship (null in a visited ship). */
  private game: GameStaging | null = null;
  /** 연산 클러스터 uid → the key of the look it was built with (`cores:mining`, 2026-09-13) — rebuilt only when that changes. */
  private clusterKeys = new Map<string, string>();
  private lastTime = -1;

  /**
   * `source` (2026-09-08) overrides `ctx.housing` — a visited member's ship. A sourced layer is **read-only**: it
   * subscribes to nothing (the wire never changes under it) and registers no interactables at all.
   */
  /**
   * `areas` (2026-09-12, was `rooms`): every furniture area of the ship — the rooms **and the cockpit**
   * (`COCKPIT_ROOM_INDEX`), each with its own `furnitureGroup`. Pieces are matched to an area by `index`, never by array
   * position (the cockpit's index is not a list slot).
   */
  constructor(private readonly ctx: GameContext, private readonly areas: readonly EditAreaDef[], private readonly collider: BoxInteriorCollider, private readonly cb: FurnitureCallbacks, private readonly source: FurnitureSource | null = null) {
    const b = ctx.bus;
    if (source === null) {
      this.unsubs.push(
        b.on('housing:furniturePlaced', ({ item }) => this.rebuildRoom(item.room)),
        b.on('housing:furnitureMoved', ({ item }) => this.rebuildRoom(item.room)),
        b.on('housing:furnitureUpgraded', ({ item }) => this.rebuildRoom(item.room)),
        b.on('housing:furnitureRecovered', ({ room }) => this.rebuildRoom(room)),
        b.on('housing:changed', ({ reason }) => { if (!COVERED_CHANGE_REASONS.has(reason)) this.rebuildAll(); }),
        b.on('housing:loaded', () => this.rebuildAll()),
        // Phase 9: a book went on / off a 책장 → redraw that piece's room (the shelf model carries the spines)
        b.on('housing:booksChanged', ({ uid }) => { const p = this.pieces.get(uid); if (p) this.rebuildRoom(p.item.room); }),
        // A-12 (2026-09-11): an analysis started · finished · was collected → rebuild only that 분석기. A slot waiting to be
        // collected lights amber, the only way to change a colour **with no light** (materials are shared, not per piece).
        b.on('housing:analysisChanged', ({ uid }) => { const p = this.pieces.get(uid); if (p) this.rebuildRoom(p.item.room); }),
        // A-14 (2026-09-11): a culture started · finished · was collected → rebuild only that 배양조 (the 분석기's path, no lights).
        b.on('housing:cultureChanged', ({ uid }) => { const p = this.pieces.get(uid); if (p) this.rebuildRoom(p.item.room); }),
        // A-3e (2026-09-12): a disc · record went in / out → only that holder's room (a 책장 is already rebuilt by `housing:booksChanged` above)
        b.on('housing:shelfChanged', ({ uid, medium }) => { if (medium === 'book') return; const p = this.pieces.get(uid); if (p) this.rebuildRoom(p.item.room); }),
        // A-3e: a TV · record player was turned on / off → the screen · neon · LED material changes, so rebuild only that room (no lights)
        b.on('housing:furnitureToggled', ({ uid }) => { const p = this.pieces.get(uid); if (p) this.rebuildRoom(p.item.room); }),
        // 2026-09-13 crypto mining: only a 연산 클러스터 whose core count · mining flag **changed** rebuilds its room (the core slots glow — no lights)
        b.on('housing:clusterChanged', ({ uid }) => this.refreshClusterPiece(uid)),
        // 2026-09-13 video games: a TV's console changed → rebuild only that TV's room (the console model on the top)
        b.on('housing:tvConsoleChanged', ({ uid }) => { const p = this.pieces.get(uid); if (p) this.rebuildRoom(p.item.room); }),
        // 2026-09-16 the plate model: a 식탁's plate changed → rebuild only the rooms with a 식탁 (the meal model on the top — no lights)
        b.on('housing:tablePlatesChanged', () => this.rebuildDiningRooms()),
      );
      this.staging = new GymStaging(ctx, (uid) => this.pieces.get(uid) ?? null, (uid) => this.blockersFor(uid));
      this.cook = new CookStaging(ctx, (uid) => this.pieces.get(uid) ?? null, (uid) => this.blockersFor(uid));
      this.game = new GameStaging(ctx, (uid) => this.pieces.get(uid) ?? null, (uid) => this.blockersFor(uid));
    }
    this.remote = new RemoteFurnitureStaging({
      find: (uid) => this.pieces.get(uid) ?? null,
      isLocal: (uid) => this.staging?.uid === uid || this.sitUid === uid || this.cook?.uid === uid || this.game?.seatUid === uid,
    });
    this.rebuildAll();
  }

  /** Debug · smoke (2026-09-12): the pieces being staged from a remote squadmate's pose. */
  get remoteStage(): Array<{ peer: PeerId; uid: string; kind: string; phase: number }> {
    return this.remote?.staged ?? [];
  }

  /**
   * Debug · smoke (A-3e · A-3a): the pose this piece would give the player (흔들의자 = sitting, a gym machine = anchor · yaw · side
   * camera), null for furniture with no pose.
   */
  poseFor(uid: string): FurniturePose | null {
    const p = this.pieces.get(uid);
    if (!p) return null;
    return sitPoseOf(p) ?? gymPoseOf(p, this.blockersFor(uid)) ?? cookPoseOf(p, this.blockersFor(uid));
  }

  /** Debug · smoke (2026-09-13): the 조리대 being staged · the game · the hand phase · the tool out on the work spot, null when there is none. */
  get cookStage(): CookStaging['stage'] {
    return this.cook?.stage ?? null;
  }

  /** Debug · smoke (2026-09-13 video games): the game session being staged (TV · seat · flicker · progress · game screen), null when there is none. */
  get gameStage(): GameStaging['stage'] {
    return this.game?.stage ?? null;
  }

  /** The world boxes of the other pieces in the same room (the gym camera's occlusion test). */
  private blockersFor(uid: string): FootBox[] {
    const me = this.pieces.get(uid);
    const out: FootBox[] = [];
    if (!me) return out;
    for (const p of this.pieces.values()) if (p !== me && p.item.room === me.item.room) out.push(p.box);
    return out;
  }

  /** Debug · smoke (A-3a): the uid of the gym machine being staged and its motion phase, null when there is none. */
  get gymStage(): { uid: string; phase: number } | null {
    const s = this.staging;
    return s && s.uid ? { uid: s.uid, phase: s.drivePhase ?? 0 } : null;
  }

  /** Placed piece under a room cell, or null. With a stack (재배층) the **top** layer wins — housing only lets the top one be recovered. */
  pieceAt(room: number, x: number, y: number): PlacedFurniture | null {
    let best: PlacedFurniture | null = null;
    for (const p of this.pieces.values()) {
      const it = p.item;
      if (it.room !== room) continue;
      const def = FURNITURE_DEF_MAP.get(it.defId);
      if (!def) continue;
      const fp = furnitureFootprint(def, it.yaw);
      if (x < it.x || x >= it.x + fp.cols || y < it.y || y >= it.y + fp.rows) continue;
      if (!best || (it.layer ?? 0) > (best.layer ?? 0)) best = it;
    }
    return best;
  }

  /** Number of rendered pieces (debug / smoke). */
  get count(): number { return this.pieces.size; }

  /**
   * Per-frame animation: the 시뮬레이션 허브 rings and a playing 턴테이블 · 축음기 record turn (`spin` · `spinRate`),
   * the 흔들의자 the player sits in rocks, and `GymStaging` drives the barbell / belt / crank of a running gym session.
   */
  update(time: number): void {
    const dt = this.lastTime < 0 ? 0 : Math.min(0.1, Math.max(0, time - this.lastTime));
    this.lastTime = time;
    for (const p of this.pieces.values()) {
      const m = p.model;
      if (!m.spin) continue;
      m.spin.rotation.y = time * (m.spinRate ?? 0.6);
      if (m.spinInner) { m.spinInner.rotation.x = 0.55 + Math.sin(time * 0.7) * 0.35; m.spinInner.rotation.z = time * 0.9; }
    }
    // 2026-09-13: when the game session's seat is a 흔들의자, rock it (the game pose replaced the ordinary sitting `sitUid`, so stop and clear that one)
    const gameSeat = this.game?.seatUid ?? null;
    if (gameSeat) {
      if (this.sitUid && this.sitUid !== gameSeat) { const old = this.pieces.get(this.sitUid)?.model.rig; if (old?.rock) old.rock.rotation.x = 0; }
      this.sitUid = null;
      const rig = this.pieces.get(gameSeat)?.model.rig;
      if (rig && this.ctx.player?.furniturePose === 'sit') poseRock(rig, time);
    } else if (this.sitUid) {
      const rig = this.pieces.get(this.sitUid)?.model.rig;
      if (this.ctx.player?.furniturePose === 'sit') {
        if (rig) poseRock(rig, time);
      } else {
        if (rig?.rock) rig.rock.rotation.x = 0;
        this.sitUid = null;
      }
    }
    this.staging?.update(dt);
    this.cook?.update(dt);
    this.game?.update(dt);
    // Remote squadmates' furniture poses — this runs after the local staging so it skips a piece the local side took this frame
    if (this.remote) {
      const cb = this.cb;
      const refs = cb.remotePlayers ? cb.remotePlayers() : this.netRemotes();
      const site = cb.hubSite ? cb.hubSite() : (this.ctx.hub?.hubSite ?? null);
      this.remote.update(dt, time, refs, site);
    }
  }

  private netRemotes(): readonly RemotePlayerRef[] {
    const net = this.ctx.net;
    return net && typeof net.getRemotePlayers === 'function' ? net.getRemotePlayers() : NO_REMOTES;
  }

  /**
   * 2026-09-12: the root object of a placed piece (its model group), or null — `HousingMode` hands it to `ctx.outline`
   * for the hover / selected outline. The object is **replaced** when the piece's area is rebuilt, so callers compare
   * the returned reference rather than caching it.
   */
  objectOf(uid: string): THREE.Object3D | null {
    return this.pieces.get(uid)?.model.group ?? null;
  }

  rebuildAll(): void {
    for (const r of this.areas) this.rebuildRoom(r.index);
  }

  rebuildRoom(room: number): void {
    const def = this.areas.find((a) => a.index === room);
    if (!def) return;
    for (const [uid, p] of this.pieces) if (p.item.room === room) { this.removePiece(p); this.pieces.delete(uid); }
    let placed: readonly PlacedFurniture[] = [];
    if (this.source) {
      try { placed = this.source.getPlaced(room); } catch { placed = []; }
    } else {
      const housing = this.ctx.housing;
      if (!housing || typeof housing.getPlaced !== 'function') return;
      try { placed = housing.getPlaced(room); } catch { placed = []; }
    }
    for (const item of placed) this.addPiece(def, item);
  }

  private addPiece(roomDef: EditAreaDef, item: PlacedFurniture): void {
    const def = FURNITURE_DEF_MAP.get(item.defId);
    if (!def) return;
    const fp = furnitureFootprint(def, item.yaw);
    const model = buildFurniture(def, item.level, this.buildExtra(def, item.uid));
    roomCellToWorld(item.room, item.x, item.y, _pos, fp.cols, fp.rows);
    // stacked furniture (재배층): each layer sits GROW_RACK_LAYER_HEIGHT higher on the same footprint
    const layer = item.layer ?? 0;
    const layerY = layer * GROW_RACK_LAYER_HEIGHT;
    model.group.position.set(_pos.x, layerY, _pos.z);
    model.group.rotation.y = yawToRotation(item.yaw);
    roomDef.furnitureGroup.add(model.group);
    const w = fp.cols * HOUSING_CELL_SIZE, d = fp.rows * HOUSING_CELL_SIZE;
    const blocker = this.collider.addBox(_pos.x, layerY, _pos.z, w, def.height, d);

    let sign: TextPlane | null = null;
    if (def.maxLevel > 1) {
      sign = new TextPlane(0.5, 0.2, 128);
      sign.mesh.position.set(_pos.x, layerY + def.height + 0.9, _pos.z);
      sign.mesh.rotation.y = yawToRotation(item.yaw) + Math.PI;     // PlaneGeometry faces +Z; the model's front is −Z
      sign.set([`Lv.${item.level}`], def.color, 'rgba(6,8,10,0.75)');
      roomDef.furnitureGroup.add(sign.mesh);
    }

    // 기업 네트워크 컴퓨터 (2026-09-12): the left monitor's text panel rides on the piece's own group (disposed with it)
    let screen: TextPlane | null = null;
    if (def.model === 'corp_computer') {
      const pose = computerScreenLocal(def.rows * HOUSING_CELL_SIZE);
      screen = new TextPlane(0.56, 0.34, 256, false);
      screen.mesh.position.copy(pose.pos);
      screen.mesh.rotation.copy(pose.rot);
      screen.set(['기업 네트워크', '접속 대기'], '#7cf07a', 'rgba(4,14,10,1)', '#9fd8b0');
      model.group.add(screen.mesh);
    }

    // a visited ship is look-around only: the pieces are drawn and collide, but nothing answers to E
    let interactable: Interactable | null = null;
    if (def.interaction !== 'none' && !RETIRED_INTERACTIONS.has(def.interaction) && this.source === null) {
      const bench = benchKindOf(def.interaction);
      const kind = def.interaction;
      const stack = Math.max(1, def.stackLimit ?? 1);
      const fixture = FIXTURE_INTERACTABLE[kind];
      // A-3e · A-3a (2026-09-12): holders · 흔들의자 · furniture that toggles · gym machines
      // 2026-09-13 video games: a 게임 디스크 전시대 opens the holder screen too, 의자 · 쇼파 (`seat`) sit like a 흔들의자, and a TV opens the TV screen (when there is one)
      const shelf = kind === 'disc_stand' || kind === 'record_rack' || kind === 'game_stand';
      const seat = kind === 'rocking_chair' || kind === 'seat';
      const tvKind = kind === 'tv';
      const toggle = isToggleInteraction(kind);
      const gym = gymEquipmentOf(kind);
      // 2026-09-13 the cooking minigame: 조리대 · auto appliances — both open the 조리대 screen (a 조리대 is a `bench` too, so it is caught before that)
      const cookBench = kind === 'workbench_cook';
      const cookAppliance = cookGamesOfAppliance(kind).length > 0;
      // 2026-09-13 crypto mining: 연산 클러스터 (its prompt follows the core count) · 메인 컴퓨터
      const cluster = kind === 'compute_cluster';
      const miningPc = kind === 'mining_computer';
      const prompt = fixture ? fixture.prompt
        : miningPc ? '메인 컴퓨터'
        : cookBench ? `${def.name} · 요리하기`
        : cookAppliance ? `${def.name} · 조리대 열기`
        : bench || kind === 'analyzer' || kind === 'culture_tank' ? `${def.name} Lv.${item.level}`
        : stack > 1 ? `${def.name} ${layer + 1}층`
        : seat ? `${def.name} · 앉기`
        : gym ? `${def.name} · ${GYM_MINIGAME_LABEL_KO[gym.minigame]}`
        : def.name;
      // A stack shares one footprint, so every layer would sit on the same anchor: spread the layers along the
      // piece's front edge instead (a control panel per layer) so `findBest` can tell them apart.
      const anchor = _pos.clone();
      const rot = yawToRotation(item.yaw), cos = Math.cos(rot), sin = Math.sin(rot);
      /* 2026-09-13 (placement rules — access faces, user's decision): front = from the front only, sides = from the two wide faces (local ±Z) only, all · none = anywhere.
         The player's feet are projected from the piece's centre along its front direction (`furnitureFaceDir` — grid x = world +X, grid y = world +Z) and must land outside half the body's depth.
         A front piece's anchor is moved right in front of its front face (that is where the built-in fixtures' anchors were). */
      const access = furnitureAccessOf(def);
      const faceDir = furnitureFaceDir(item.yaw, 'front');
      const faceX = faceDir.dx, faceZ = faceDir.dy;
      const halfDepth = (faceX !== 0 ? w : d) / 2, faceHalfWidth = (faceX !== 0 ? d : w) / 2;
      const pcx = _pos.x, pcz = _pos.z;
      const accessOk = (): boolean => {
        if (access !== 'front' && access !== 'sides') return true;
        const p = this.ctx.player?.position;
        if (!p) return true;
        const s = (p.x - pcx) * faceX + (p.z - pcz) * faceZ;
        return access === 'front' ? s >= halfDepth : Math.abs(s) >= halfDepth;
      };
      if (stack > 1) {
        const lw = def.cols * HOUSING_CELL_SIZE, ld = def.rows * HOUSING_CELL_SIZE;
        const ox = (layer - (stack - 1) / 2) * (lw / stack);
        const oz = -(ld / 2 + 0.55);
        anchor.set(_pos.x + ox * cos + oz * sin, 0, _pos.z - ox * sin + oz * cos);
      } else if (fixture) {
        // 2026-09-12: a fixture's anchor stands **in front of** the piece (local −Z), where the old station's anchor was
        const oz = -(def.rows * HOUSING_CELL_SIZE / 2 + 0.6);
        anchor.set(_pos.x + oz * sin, 0, _pos.z + oz * cos);
      } else if (access === 'front') {
        anchor.set(pcx + faceX * (halfDepth + 0.4), 0, pcz + faceZ * (halfDepth + 0.4));
      }
      // the old station id when it is still free (one fixture of a kind per ship), else the generic furniture id
      const id = fixture && !this.ctx.interactables.all().some((i) => i.id === fixture.id) ? fixture.id : `hub_furn_${item.uid}`;
      const cb = this.cb, level = item.level, uid = item.uid;
      interactable = {
        id,
        position: anchor,
        radius: fixture ? fixture.radius : stack > 1 ? 1.2 : access === 'front' ? faceHalfWidth + 1.1 : Math.max(w, d) / 2 + 1.1,
        // The TV · record player prompt follows the current state (`TV · 켜기` / `TV · 끄기`). 2026-09-13: with a TV screen it is `TV 화면`
        getPrompt: () => (cb.canUse() && accessOk()
          ? (tvKind && this.tvMenuAvailable() ? `${def.name} 화면` : toggle ? `${def.name} · ${this.isOn(uid) ? '끄기' : '켜기'}` : cluster ? this.clusterPrompt(uid)
            // 2026-09-16 (the plate model): with no 식탁 piece the 조리대 · auto appliances cannot be used — the prompt says so before the press
            : (cookBench || cookAppliance) && this.ctx.housing?.hasDiningTable?.() === false ? `${def.name} · ${DINING_TABLE_MISSING_REASON}`
            : prompt)
          : null),
        canInteract: () => cb.canUse() && accessOk(),
        interact: () => {
          if (cookBench) cb.onCookStation(uid);
          else if (cookAppliance) cb.onCookStation(this.cookBenchUid(uid));
          else if (bench) cb.onBench(bench, level);
          else if (kind === 'implant_bay') cb.onImplantBay();
          else if (kind === 'corp_computer') cb.onCorpComputer();
          else if (kind === 'grow_rack') cb.onGrowRack(uid);
          else if (kind === 'grow_station') cb.onGrowStation(uid);
          else if (kind === 'bookshelf') cb.onBookshelf(uid);
          else if (kind === 'analyzer') cb.onAnalyzer(uid);
          else if (kind === 'culture_tank') cb.onCultureTank(uid);
          else if (kind === 'dining_table') cb.onDiningTable(uid);
          else if (shelf) cb.onShelf(uid);
          else if (seat) {
            // 2026-09-13: a 쇼파 seats the player on the cushion nearest their feet (a 의자 · 흔들의자 has one spot)
            const piece = this.pieces.get(uid);
            const pose = piece ? sitPoseOf(piece, this.ctx.player?.position ?? null) : null;
            if (pose && cb.onSit(uid, pose)) this.sitUid = uid;
          }
          else if (tvKind && this.tvMenuAvailable()) this.openTvMenu(uid);   // 2026-09-13 video games: with a TV screen the TV opens like a station
          else if (toggle) cb.onToggle(uid);
          else if (gym) cb.onGym(uid);
          else if (cluster) this.openMining(uid, 'cluster');
          else if (miningPc) this.openMining(uid, 'computer');
          /* anything else (a future interaction nobody wired yet) does nothing rather than opening a wrong window */
        },
      };
      this.ctx.interactables.register(interactable);
    }
    const box: FootBox = { minX: _pos.x - w / 2, maxX: _pos.x + w / 2, minY: layerY, maxY: layerY + def.height, minZ: _pos.z - d / 2, maxZ: _pos.z + d / 2 };
    this.pieces.set(item.uid, { item, model, blocker, sign, screen, interactable, box });
  }

  /**
   * The 조리대 an auto appliance opens (2026-09-13): among the 조리대 placed in the ship, **one in the same room** as that appliance → then the
   * highest level. null when there is none. One room per purpose means one kitchen and a 조리대 never moves rooms, but an old save is not trusted.
   */
  private cookBenchUid(fromUid: string): string | null {
    const room = this.pieces.get(fromUid)?.item.room ?? null;
    let best: PlacedFurniture | null = null, bestScore = -Infinity;
    for (const p of this.pieces.values()) {
      if (FURNITURE_DEF_MAP.get(p.item.defId)?.interaction !== 'workbench_cook') continue;
      const score = (p.item.room === room ? 1000 : 0) + p.item.level;
      if (score > bestScore) { bestScore = score; best = p.item; }
    }
    return best?.uid ?? null;
  }

  /**
   * The 식탁 plate (2026-09-16): the local player's plate for this table — only on the **first 식탁 piece** of their own ship (never while visiting), because a ship has one plate.
   * The piece it was built on is written to `diningPlateUid` (for the smokes).
   */
  private plateFor(uid: string): { mealDefId: string; quality: number } | null {
    if (this.source !== null) return null;
    const h = this.ctx.housing;
    let plate: { mealDefId: string; quality: number } | null = null;
    try { plate = h?.getPlate?.() ?? null; } catch { plate = null; }
    const first = plate ? h?.state.furniture.find((f) => FURNITURE_DEF_MAP.get(f.defId)?.interaction === 'dining_table') : undefined;
    const on = !!plate && !!first && first.uid === uid;
    if (on) this.plateUid = uid;
    else if (this.plateUid === uid) this.plateUid = null;
    return on ? plate : null;
  }

  /** Debug · smoke (2026-09-16): the uid of the 식탁 piece built with the plate on it, null when there is none. */
  get diningPlateUid(): string | null { return this.plateUid; }
  private plateUid: string | null = null;

  /** Rebuilds only the rooms that hold a 식탁 piece (`housing:tablePlatesChanged`). */
  private rebuildDiningRooms(): void {
    const rooms = new Set<number>();
    for (const p of this.pieces.values()) if (FURNITURE_DEF_MAP.get(p.item.defId)?.interaction === 'dining_table') rooms.add(p.item.room);
    if (rooms.size === 0) this.plateUid = null;
    for (const r of rooms) this.rebuildRoom(r);
  }

  /** Per-piece state a builder reads: 책장 = shelved books, 분석기 / 배양조 = how many slots wait to be collected. */
  private buildExtra(def: FurnitureDef, uid: string): BuildExtra | undefined {
    if (def.model === 'bookshelf') return { books: this.shelfBooks(uid) };
    if (def.model === 'analyzer') return { analysisReady: this.analysisReady(uid) };
    if (def.model === 'culture_tank') return { cultureReady: this.cultureReady(uid), cultureSlots: this.cultureLooks(uid) };
    // A-3e · A-3a (2026-09-12)
    const medium = shelfMediumOfInteraction(def.interaction);
    // 2026-09-13 video games: a 게임 디스크 전시대 gets the per-slot theme colours along with the rarity (the visit wire's fallback)
    if (medium === 'game') return { media: this.shelfMedia(uid, medium), gameColors: this.gameDiscColors(uid) };
    if (medium && medium !== 'book') return { media: this.shelfMedia(uid, medium) };
    // 2026-09-13 video games: a TV gets, beyond being on, the mounted console's look · whether a game session is running
    if (def.model === 'tv') return { on: this.isOn(uid), consoleLook: this.consoleLookOf(uid), gameActive: this.game?.activeOn(uid) === true };
    if (isToggleInteraction(def.interaction)) return { on: this.isOn(uid) };
    // 2026-09-13: a 조리대 mid-cook is built with the current step's tool out on the work spot
    if (def.model === 'bench_cook') return { cookGame: this.cook?.gameFor(uid) ?? null };
    // 2026-09-16 (the plate model): a 식탁 is built with the local player's plate on it
    if (def.model === 'dining_table') return { plate: this.plateFor(uid) };
    // 2026-09-13 crypto mining: a 연산 클러스터 is built with as many slots lit as it has cores mounted (the key of that look is recorded)
    if (def.model === 'compute_cluster') {
      const s = this.clusterState(uid);
      this.clusterKeys.set(uid, `${s.cores}:${s.mining ? 1 : 0}`);
      return { cores: s.cores, clusterMining: s.mining };
    }
    // 2026-09-12: a machine a remote squadmate is using is built with its plates loaded too (so they do not vanish for the rebuild frame)
    if (gymEquipmentOf(def.interaction)) return { gymActive: this.staging?.uid === uid || this.remote?.drives(uid) === true };
    return undefined;
  }

  /**
   * The rarity of the media in a 디스크 전시대 · 레코드랙 (slot order, `SHELF_SLOTS[medium]` slots). A visited ship reads the wire
   * (`FurnitureSource.getMedia`), the player's own ship `ctx.housing.getShelfSlots(uid)` — both are duck-typed / try-caught, so an
   * unfinished folder never throws in the middle of a room rebuild.
   */
  private shelfMedia(uid: string, medium: ShelfMedium): (Rarity | null)[] {
    const out: (Rarity | null)[] = new Array(SHELF_SLOTS[medium]).fill(null);
    if (this.source) {
      try {
        const src = this.source.getMedia?.(uid) ?? [];
        for (let i = 0; i < out.length && i < src.length; i++) out[i] = src[i] ?? null;
      } catch { /* malformed wire */ }
      return out;
    }
    const h = this.ctx.housing;
    if (!h || typeof h.getShelfSlots !== 'function') return out;
    try {
      for (const s of h.getShelfSlots(uid)) if (s.defId && s.slot >= 0 && s.slot < out.length) out[s.slot] = s.rarity ?? 'common';
    } catch { /* stub */ }
    return out;
  }

  /** Whether the TV screen (`ctx.housing.openTvMenu`) exists — false in a visited ship (no interactions) or while housing is still missing (falls back to the old on / off). */
  private tvMenuAvailable(): boolean {
    return this.source === null && typeof this.ctx.housing?.openTvMenu === 'function';
  }

  /** Opens the TV screen — the callback when there is one (hub owns the toast contract), else `ctx.housing.openTvMenu` directly. */
  private openTvMenu(uid: string): void {
    if (this.cb.onTvMenu) { this.cb.onTvMenu(uid); return; }
    try { this.ctx.housing?.openTvMenu?.(uid); } catch (err) { console.warn('[hub] openTvMenu failed', err); }
  }

  /**
   * The look of the console mounted on a TV (`BuildExtra.consoleLook`). The console kind (`GameConsoleDef.console`) is looked up in the sorted list
   * of every kind in the catalogue, and its index % `TV_CONSOLE_LOOKS` decides — every client shares the catalogue, so every client draws the
   * same look. An unknown def = the generic box (`TV_CONSOLE_LOOKS`), no console = null. A visited ship carries no console on the wire, so null (later work).
   */
  private consoleLookOf(uid: string): number | null {
    if (this.source) return null;
    const h = this.ctx.housing;
    if (!h || typeof h.getTvConsole !== 'function') return null;
    let defId: string | null = null;
    try { defId = h.getTvConsole(uid); } catch { return null; }
    if (!defId) return null;
    const loot = this.ctx.loot;
    let kind: string | undefined;
    try { kind = loot?.getItemDef(defId)?.gameConsole?.console; } catch { kind = undefined; }
    if (!kind || !loot) return TV_CONSOLE_LOOKS;
    const named = TV_CONSOLE_LOOK_BY_KIND[kind];
    if (named !== undefined) return named;
    if (!consoleKinds) {
      try {
        const set = new Set<string>();
        for (const d of loot.getAllItemDefs()) if (d.gameConsole?.console) set.add(d.gameConsole.console);
        consoleKinds = [...set].sort();
      } catch { return TV_CONSOLE_LOOKS; }
    }
    const i = consoleKinds.indexOf(kind);
    return i < 0 ? TV_CONSOLE_LOOKS : i % TV_CONSOLE_LOOKS;
  }

  /** The per-slot theme colours of a 게임 디스크 전시대 (`GameDiscDef.color`). An empty array while visiting — the wire's rarity (`media`) stands in. */
  private gameDiscColors(uid: string): (string | null)[] {
    const out: (string | null)[] = new Array(SHELF_SLOTS.game).fill(null);
    if (this.source) return out;
    const h = this.ctx.housing;
    if (!h || typeof h.getShelfSlots !== 'function') return out;
    try {
      for (const s of h.getShelfSlots(uid)) {
        if (!s.defId || s.slot < 0 || s.slot >= out.length) continue;
        const c = this.ctx.loot?.getItemDef(s.defId)?.gameDisc?.color;
        out[s.slot] = typeof c === 'string' && c ? c : null;
      }
    } catch { /* stub */ }
    return out;
  }

  /** Whether a TV · record player is on — the wire while visiting, else `ctx.housing.isFurnitureOn(uid)`. */
  private isOn(uid: string): boolean {
    if (this.source) {
      try { return this.source.isOn?.(uid) === true; } catch { return false; }
    }
    const h = this.ctx.housing;
    if (!h || typeof h.isFurnitureOn !== 'function') return false;
    try { return h.isFurnitureOn(uid) === true; } catch { return false; }
  }

  /**
   * A 연산 클러스터's current look (2026-09-13): how many cores are mounted · whether it is mining. A visited ship carries no mining state on
   * the wire, so 0 / false; `ctx.housing` is duck-typed / try-caught — an unfinished folder never throws in the middle of a room rebuild.
   */
  private clusterState(uid: string): { cores: number; mining: boolean } {
    if (this.source) return { cores: 0, mining: false };
    const h = this.ctx.housing;
    if (!h || typeof h.getComputeCluster !== 'function') return { cores: 0, mining: false };
    try {
      const c = h.getComputeCluster(uid);
      return { cores: Math.max(0, Math.floor(c?.cores ?? 0)), mining: !!c?.mining };
    } catch { return { cores: 0, mining: false }; }
  }

  /** Rebuilds the room only for a 연산 클러스터 whose look changed (`housing:clusterChanged` also arrives on every mining tick). */
  private refreshClusterPiece(uid: string): void {
    const p = this.pieces.get(uid);
    if (!p || p.item.defId !== COMPUTE_CLUSTER_DEF_ID) return;
    const s = this.clusterState(uid);
    if (this.clusterKeys.get(uid) === `${s.cores}:${s.mining ? 1 : 0}`) return;
    this.rebuildRoom(p.item.room);
  }

  /** `연산 클러스터 · 코어 n/9` — the core count is read right now. */
  private clusterPrompt(uid: string): string {
    return `연산 클러스터 · 코어 ${this.clusterState(uid).cores}/${COMPUTE_CLUSTER_MAX_CORES}`;
  }

  /**
   * Opens the mining screen — the callback when there is one (hub owns the toast contract), else `ctx.housing` directly.
   * Unified 2026-09-14: both paths go to **the same window** and differ only in the default tab (`'cluster'` → `채굴`,
   * `'computer'` → `클러스터 현황`). Both contract names (`openComputeCluster` · `openMiningComputer`) stay.
   */
  private openMining(uid: string, page: 'cluster' | 'computer'): void {
    const cb = this.cb;
    if (page === 'cluster' && cb.onComputeCluster) { cb.onComputeCluster(uid); return; }
    if (page === 'computer' && cb.onMiningComputer) { cb.onMiningComputer(uid); return; }
    const h = this.ctx.housing;
    try {
      if (page === 'cluster') h?.openComputeCluster?.(uid);
      else h?.openMiningComputer?.(uid);
    } catch (err) { console.warn('[hub] open mining screen failed', err); }
  }

  /**
   * The number of culture slots waiting to be collected (a 배양조's tube colours). Same shape as `analysisReady` — a
   * visited ship has none on the wire and `ctx.housing` is duck-typed / try-caught, so an unfinished folder degrades
   * to a dark tank instead of throwing in the middle of a room rebuild.
   */
  /**
   * The per-slot look of a 배양조 (2026-09-17). The player's own ship reads `ctx.housing.getCultureSlots`, a visited ship the wire (`FurnitureSource.getCultures`
   * ← `ShipVisitWire.cultures`). Either way the medium colour comes from the local catalogue (a book rarity's path). Both duck-typed / try-caught.
   */
  private cultureLooks(uid: string): (CultureLook | null)[] {
    const out: (CultureLook | null)[] = new Array(CULTURE_MAX_SLOTS).fill(null);
    const colorOf = (defId: string): string => {
      try { return this.ctx.loot?.getItemDef(defId)?.color || CULTURE_FLUID_FALLBACK; } catch { return CULTURE_FLUID_FALLBACK; }
    };
    if (this.source) {
      try {
        for (const c of this.source.getCultures?.(uid) ?? []) {
          if (c.slot >= 0 && c.slot < CULTURE_MAX_SLOTS) out[c.slot] = { color: colorOf(c.medium), filled: c.filled, ready: false };
        }
      } catch { /* old wire */ }
      return out;
    }
    const h = this.ctx.housing;
    if (!h || typeof h.getCultureSlots !== 'function') return out;
    try {
      for (const s of h.getCultureSlots(uid)) {
        if (s.locked || !s.mediumDefId || s.slot < 0 || s.slot >= CULTURE_MAX_SLOTS) continue;
        out[s.slot] = { color: colorOf(s.mediumDefId), filled: !!s.strainDefId, ready: s.ready };
      }
    } catch { /* unfinished folder */ }
    return out;
  }

  private cultureReady(uid: string): number {
    if (this.source) return 0;
    const h = this.ctx.housing;
    if (!h || typeof h.getCultureSlots !== 'function') return 0;
    try {
      let n = 0;
      for (const s of h.getCultureSlots(uid)) if (s.ready) n++;
      return n;
    } catch { return 0; }
  }

  /**
   * The number of analysis slots waiting to be collected (a 분석기's chamber colours). A visited ship has no analyses
   * on the wire, and `ctx.housing` is duck-typed / try-caught like everywhere else in this file — an unfinished folder
   * must degrade to a dark model, never throw in the middle of a room rebuild.
   */
  private analysisReady(uid: string): number {
    if (this.source) return 0;
    const h = this.ctx.housing;
    if (!h || typeof h.getAnalyses !== 'function') return 0;
    try {
      let n = 0;
      for (const s of h.getAnalyses(uid)) if (s.ready) n++;
      return n;
    } catch { return 0; }
  }

  /** Shelved books of a 책장 by slot (rarity or null), from the source or `ctx.housing.getBooks(uid)`. */
  private shelfBooks(uid: string): (Rarity | null)[] {
    const out: (Rarity | null)[] = new Array(BOOKS_PER_SHELF).fill(null);
    if (this.source) {
      try {
        const src = this.source.getBooks(uid);
        for (let i = 0; i < out.length && i < src.length; i++) out[i] = src[i] ?? null;
      } catch { /* malformed wire */ }
      return out;
    }
    const h = this.ctx.housing;
    if (!h || typeof h.getBooks !== 'function') return out;
    try {
      for (const s of h.getBooks(uid)) if (s.defId && s.slot >= 0 && s.slot < BOOKS_PER_SHELF) out[s.slot] = s.rarity ?? 'common';
    } catch { /* stub */ }
    return out;
  }

  private removePiece(p: Piece): void {
    disposeMeshes(p.model.meshes);
    p.model.group.removeFromParent();
    this.collider.removeBlocker(p.blocker);
    p.sign?.dispose();
    if (p.screen) { p.screen.mesh.removeFromParent(); p.screen.dispose(); }
    if (p.interactable) this.ctx.interactables.unregister(p.interactable.id);
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.staging?.dispose(); this.staging = null;
    this.cook?.dispose(); this.cook = null;
    this.game?.dispose(); this.game = null;
    this.remote?.dispose(); this.remote = null;
    for (const p of this.pieces.values()) this.removePiece(p);
    this.pieces.clear();
  }
}
