import * as THREE from 'three';
import type { FurnitureDef, FurnitureModelKind, GameContext, GrowTier, Interactable, PlacedFurniture, Rarity, WorkbenchKind } from '@/shared';
import { ANALYZER_MAX_SLOTS, BOOKS_PER_SHELF, CULTURE_MAX_SLOTS, FURNITURE_DEF_MAP, GROW_PLOTS_PER_RACK, GROW_RACK_LAYER_HEIGHT, GROW_SLOTS_PER_TIER, HOUSING_CELL_SIZE, RARITY_COLORS, analyzerSlotsForLevel, benchKindOf, cultureSlotsForLevel, furnitureFootprint, growTiersForLevel } from '@/shared';
import { GeoBatch, HUB_MATS as M, disposeMeshes } from './GeoBatch';
import type { BoxInteriorCollider } from './InteriorCollider';
import { roomCellToWorld, yawToRotation } from './RoomLayout';
import { computerScreenPose, implantBayBody, shipComputerBody } from './stations';
import { TextPlane } from '../Labels';
import type { EditAreaDef } from './types';

/* ────────────────────────────────────────────────────────────────────────────
 * Procedural furniture (함선 꾸미기). Every `FurnitureModelKind` is built from boxes / cylinders through a
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
/** 책장 shelves (BOOKS_PER_SHELF slots spread over them, top shelf first). */
const BOOK_SHELF_ROWS = 3;
const LAMP_GLOW = new THREE.MeshStandardMaterial({ color: 0xffe3a0, roughness: 0.3, metalness: 0, emissive: 0xffc060, emissiveIntensity: 2.4 });
const LEAF = new THREE.MeshStandardMaterial({ color: 0x4f9a4a, roughness: 0.85, metalness: 0 });
const POT = new THREE.MeshStandardMaterial({ color: 0x8a5a3c, roughness: 0.9, metalness: 0.05 });
const TARGET = new THREE.MeshStandardMaterial({ color: 0xe8e2d0, roughness: 0.8, metalness: 0.05 });
const TARGET_RING = new THREE.MeshStandardMaterial({ color: 0xd23a2a, roughness: 0.7, metalness: 0.05 });
/** 시뮬레이션 허브 hologram rings (emissive, translucent — no light). */
const HOLO_RING = new THREE.MeshStandardMaterial({ color: 0x9fe8ff, roughness: 0.3, metalness: 0, emissive: 0x5fd7ff, emissiveIntensity: 2.2, transparent: true, opacity: 0.85, depthWrite: false });
const HOLO_CORE = new THREE.MeshStandardMaterial({ color: 0xc8f4ff, roughness: 0.2, metalness: 0, emissive: 0x8fe0ff, emissiveIntensity: 1.6, transparent: true, opacity: 0.35, depthWrite: false });
/**
 * 재배 스테이션 재배층의 높이 (가구 높이에 대한 비율, 온실 개편 2026-09-11). `GrowTier` 그대로 0 = 중앙 ·
 * 1 = 아래 · 2 = 위이고 **레벨과 무관하게 고정**이다 — 계약(`growTiersForLevel`)이 "Lv.2 는 아래를, Lv.3 은
 * 위를 연다" 이므로 강화해도 이미 자라고 있는 중앙 층이 자리를 옮기면 안 된다. 층 간격은 화분 + 재배등이
 * 들어갈 만큼(가구 높이의 0.28 ≈ 0.62 m) 띄웠다.
 */
const GROW_TIER_Y: Readonly<Record<GrowTier, number>> = { 0: 0.44, 1: 0.16, 2: 0.72 };

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
}

/** Per-piece data a builder may read (Phase 9): the 책장's shelved books by slot (rarity, null = empty). */
export interface BuildExtra {
  books?: readonly (Rarity | null)[];
  /**
   * 연구실 분석기 (A-12, 2026-09-11): how many of this piece's 해석 칸 are **회수 대기** right now
   * (`housing:analysisChanged.ready`). The builder lights that many chambers amber instead of cyan — the only way
   * the model can say "가서 회수해라" without adding a `THREE.PointLight`, which would recompile every shader in
   * the scene (CLAUDE.md 「씬의 광원 개수를 플레이 중에 바꾸지 않는다」).
   */
  analysisReady?: number;
  /**
   * 온실 배양조 (A-14, 2026-09-11): how many of this piece's 배양 칸 are **회수 대기** right now
   * (`housing:cultureChanged.ready`). Exactly the 분석기's convention above — those tubes glow amber instead of
   * the 배양 magenta, and no `THREE.PointLight` is created for it.
   */
  cultureReady?: number;
}

/** Build the model of `def` (unrotated, centred, front toward −Z). `extra` carries per-piece state (책장 books). */
export function buildFurniture(def: FurnitureDef, level = 1, extra?: BuildExtra): FurnitureModel {
  const g = new THREE.Group();
  g.name = `furn-${def.id}`;
  const b = new GeoBatch();
  const w = def.cols * HOUSING_CELL_SIZE, d = def.rows * HOUSING_CELL_SIZE, h = def.height;
  const accent = tint(def.color);
  BUILDERS[def.model](b, w, d, h, accent, level, extra);
  const meshes: THREE.Mesh[] = [];
  b.build(g, meshes);
  const model: FurnitureModel = { group: g, meshes, w, d };
  if (def.model === 'sim_hub') simHubRings(model, Math.min(w, d) / 2, h);
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
type Builder = (b: GeoBatch, w: number, d: number, h: number, accent: THREE.Material, level: number, extra?: BuildExtra) => void;

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

const BUILDERS: Record<FurnitureModelKind, Builder> = {
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
   * 정제 작업대 (2026-09-10): 상위 재료 전용 작업대. 나머지 넷이 "물건을 조립하는 책상" 이라면 이것은
   * **용해로**다 — 왼쪽에 호박색으로 달아오른 도가니, 가운데 주형 트레이(식어 가는 잉곳 세 개), 오른쪽에
   * 권취 드럼(케이블 · 직조포). 실루엣만으로 다른 작업대와 구분되게 도가니를 상판 위로 크게 올렸다.
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
   * 재배 스테이션 (온실 개편, 2026-09-11): 한 대짜리 수경 재배기. 옛 재배층처럼 쌓는 것이 아니라 **가구 레벨이
   * 재배층을 연다** — `growTiersForLevel(level)` 이 그대로 그려지는 층이고 높이는 `GROW_TIER_Y` 한 곳에서만
   * 온다(중앙 층은 강화해도 자리가 바뀌지 않는다). 한 층에 `GROW_SLOTS_PER_TIER` 개의 화분이 서고, 화분은
   * 위가 뚫린 원통이라 흙을 붓기 전에는 안이 비어 보인다. 재배등은 emissive 재질(`stripGrow`)뿐 — 광원은
   * 만들지 않는다 (CLAUDE.md 「씬의 광원 개수를 플레이 중에 바꾸지 않는다」).
   */
  grow_station: (b, w, d, h, a, lv) => {
    // ── 프레임: 받침 · 기둥 4개 · 뒷판 · 천장 · 앞면 급액 파이프
    b.boxB(w - 0.08, 0.12, d - 0.08, 0, 0, 0, M.hullDark);                                         // plinth
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.boxB(0.08, h, 0.08, sx * (w / 2 - 0.05), 0, sz * (d / 2 - 0.05), M.gunmetal);
    b.box(w - 0.16, h - 0.24, 0.04, 0, h / 2, d / 2 - 0.05, M.hullDark);                           // back panel
    b.box(w - 0.04, 0.07, d - 0.04, 0, h - 0.035, 0, M.hullLight);                                 // top cap
    b.box(w - 0.3, 0.04, 0.05, 0, h - 0.09, -(d / 2 - 0.04), a);                                   // top accent
    const pipeH = h - 0.24;
    for (const sx of [-1, 1]) b.cyl(0.03, 0.03, pipeH, 8, sx * (w / 2 - 0.05), 0.12 + pipeH / 2, -(d / 2 - 0.005), M.trim);
    // 제어반 (받침 위 왼쪽): 화면 + 레벨 핍
    b.box(0.3, 0.22, 0.06, -w * 0.32, 0.42, -(d / 2 - 0.04), M.hullLight);
    b.box(0.24, 0.15, 0.02, -w * 0.32, 0.44, -(d / 2 + 0.005), M.screen);
    for (let k = 0; k < lv; k++) b.box(0.05, 0.03, 0.02, -w * 0.32 - 0.1 + k * 0.1, 0.29, -(d / 2 + 0.005), M.stripWhite);

    // ── 재배층: 레벨이 연 층만 선다 (Lv.1 중앙 · Lv.2 아래 · Lv.3 위)
    for (const tier of growTiersForLevel(lv)) {
      const y = h * GROW_TIER_Y[tier];
      b.box(w - 0.14, 0.05, d - 0.12, 0, y, 0, M.hullLight);                                       // shelf board
      b.box(w - 0.16, 0.03, 0.04, 0, y + 0.035, -(d / 2 - 0.08), M.trim);                          // front edge
      b.box(w - 0.26, 0.06, 0.14, 0, y + 0.5, 0, M.hullDark);                                      // 재배등 하우징
      b.box(w - 0.3, 0.04, 0.1, 0, y + 0.455, 0, M.stripGrow);                                     // 재배등 (emissive only)
      for (const sx of [-1, 1]) b.box(0.07, 0.05, 0.07, sx * (w / 2 - 0.05), y + 0.09, -(d / 2 - 0.005), a);   // 급액 분기
      for (let k = 0; k < GROW_SLOTS_PER_TIER; k++) {
        const px = -w / 2 + (k + 0.5) * (w / GROW_SLOTS_PER_TIER);
        b.cyl(0.17, 0.15, 0.17, 14, px, y + 0.11, 0, M.hullDark, 0, 0, 0, true);                   // 화분 (위가 뚫려 안이 비어 보인다)
        b.cyl(0.15, 0.15, 0.02, 14, px, y + 0.035, 0, M.crateDark);                                // 화분 바닥
        b.box(0.09, 0.02, 0.03, px, y + 0.07, -(d / 2 - 0.13), a);                                 // 칸 표식
      }
    }
  },
  /**
   * 분석기 (연구실 A-12, 2026-09-11): 재배 스테이션과 같은 결의 스테이션 — **레벨이 자리를 연다**. 앞으로 기운
   * 조작 콘솔 위에 `ANALYZER_MAX_SLOTS` 개의 시료 챔버(위가 뚫린 유리관)가 **언제나** 서 있고, 그 중
   * `analyzerSlotsForLevel(level)` 개만 안쪽 코어에 불이 들어온다(잠긴 칸은 어둡다) — 패널이 잠긴 칸을 딤드로
   * 그리는 것과 같은 규약이라, 강화하면 다음 관이 켜지는 것으로 보인다.
   *
   * 회수 대기(`extra.analysisReady`) 칸은 청록 대신 **호박색**이다. 광원은 하나도 만들지 않는다 — emissive
   * 재질뿐이다 (CLAUDE.md 「씬의 광원 개수를 플레이 중에 바꾸지 않는다」). 색이 바뀌면 `FurnitureLayer` 가
   * 그 조각만 다시 짓는다 (`housing:analysisChanged`, 책장의 `housing:booksChanged` 와 같은 길).
   */
  analyzer: (b, w, d, h, a, lv, extra) => {
    const open = analyzerSlotsForLevel(lv);
    const ready = Math.max(0, Math.min(ANALYZER_MAX_SLOTS, Math.floor(extra?.analysisReady ?? 0)));
    // ── 프레임: 받침 · 뒷기둥 · 뒷판 · 천장
    b.boxB(w - 0.08, 0.14, d - 0.06, 0, 0, 0, M.hullDark);                                        // plinth
    for (const sx of [-1, 1]) b.boxB(0.09, h, 0.09, sx * (w / 2 - 0.05), 0, d / 2 - 0.05, M.gunmetal);
    b.box(w - 0.16, h - 0.34, 0.05, 0, 0.14 + (h - 0.34) / 2, d / 2 - 0.06, M.hullDark);          // back panel
    b.box(w - 0.04, 0.08, d - 0.04, 0, h - 0.04, 0, M.hullLight);                                 // top cap
    b.box(w - 0.3, 0.04, 0.05, 0, h - 0.1, -(d / 2 - 0.04), a);                                   // top accent
    // ── 조작 콘솔: 몸체 + 앞으로 기운 화면 + 레벨 핍
    const deskH = h * 0.36, deskY = 0.14 + deskH;
    b.boxB(w - 0.24, deskH, d - 0.3, 0, 0.14, -0.04, M.hullLight);
    b.box(w - 0.28, 0.06, d - 0.34, 0, deskY, -0.04, M.gunmetal);
    b.box(w * 0.44, 0.03, 0.28, -w * 0.2, deskY + 0.09, -0.1, M.screen, 0, -0.55);                // 기울어진 화면
    b.box(w * 0.46, 0.05, 0.05, -w * 0.2, deskY + 0.02, -(d / 2 - 0.17), M.hullDark);             // 화면 받침
    for (let k = 0; k < 3; k++) b.box(0.06, 0.02, 0.05, w * 0.16 + k * 0.1, deskY + 0.04, -0.12, k < lv ? M.stripWhite : M.hullDark);
    // ── 시료 챔버: 언제나 ANALYZER_MAX_SLOTS 개, 레벨이 연 칸만 불이 들어온다
    const cy = deskY + 0.03;
    const cH = Math.max(0.24, h - cy - 0.18);
    for (let s = 0; s < ANALYZER_MAX_SLOTS; s++) {
      const px = -w / 2 + (s + 0.5) * (w / ANALYZER_MAX_SLOTS);
      const lit = s < open, done = s < ready;
      const glow = lit ? (done ? M.stripAmber : M.stripCyan) : M.hullDark;
      b.cyl(0.1, 0.11, 0.05, 14, px, cy + 0.025, 0.02, M.gunmetal);                               // 받침
      b.cyl(0.095, 0.095, cH, 14, px, cy + 0.05 + cH / 2, 0.02, M.glassDark, 0, 0, 0, true);      // 유리관
      b.cyl(0.045, 0.045, cH * 0.62, 10, px, cy + 0.05 + cH * 0.36, 0.02, glow);                  // 내부 코어
      b.cyl(0.11, 0.11, 0.05, 14, px, cy + 0.08 + cH, 0.02, M.hullLight);                         // 상단 캡
      b.box(0.03, 0.02, 0.02, px, cy + 0.075 + cH, -0.095, glow);                                 // 캡 표시등 (앞면)
      b.box(0.09, 0.02, 0.03, px, cy + 0.02, -(d / 2 - 0.13), lit ? (done ? M.stripAmber : a) : M.hullDark);   // 칸 표식
    }
  },
  /**
   * 추출기 (연구실 A-13, 2026-09-11): 작물 · 약재 · 광물에서 성분을 뽑는 증류탑. 다른 작업대가 "조립하는 책상"
   * 이라면 이것은 **탑**이다 — 왼쪽에 상판 위로 솟은 유리 증류관(안에 호박색 액), 그 위 응축 코일, 가운데
   * 투입 깔때기, 오른쪽에 받이 플라스크 세 개.
   */
  bench_extract: (b, w, d, h, a, lv) => benchBody(b, w, d, h, a, lv, (b) => {
    const top = h - 0.02;
    b.cyl(0.13, 0.15, 0.06, 14, -w * 0.3, top + 0.03, 0.02, M.gunmetal);                          // 증류관 받침
    b.cyl(0.1, 0.1, 0.52, 14, -w * 0.3, top + 0.32, 0.02, M.glassDark, 0, 0, 0, true);            // 유리 증류관
    b.cyl(0.075, 0.075, 0.2, 10, -w * 0.3, top + 0.16, 0.02, M.stripAmber);                       // 끓는 액
    for (let k = 0; k < 3; k++) b.cyl(0.13, 0.13, 0.03, 14, -w * 0.3, top + 0.46 + k * 0.06, 0.02, M.trim);   // 응축 코일
    b.cyl(0.03, 0.03, 0.34, 8, -w * 0.18, top + 0.56, 0.02, M.gunmetal, 0, 0, Math.PI / 2);       // 이송관
    b.cyl(0.14, 0.05, 0.18, 12, w * 0.02, top + 0.19, 0.04, M.hullLight);                         // 투입 깔때기
    b.boxB(0.16, 0.1, 0.16, w * 0.02, top, 0.04, M.hullDark);
    for (let k = 0; k < 3; k++) b.cyl(0.045, 0.03, 0.14, 10, w * 0.24 + k * 0.11, top + 0.07, 0.06, k === 1 ? M.stripCyan : M.glassDark);   // 받이 플라스크
    b.boxB(0.4, 0.03, 0.2, w * 0.29, top, 0.06, M.crateDark);
  }),
  /**
   * 조합대 (연구실 A-13, 2026-09-11): 성분을 섞어 준비물을 만드는 대. 실루엣의 주인공은 **뚜껑 달린 혼합
   * 드럼**(왼쪽, 위로 축이 솟아 있다)이고, 가운데는 계량 저울, 오른쪽은 성분 병 네 개를 꽂은 선반이다.
   */
  bench_mixer: (b, w, d, h, a, lv) => benchBody(b, w, d, h, a, lv, (b) => {
    const top = h - 0.02;
    b.cyl(0.19, 0.21, 0.26, 16, -w * 0.29, top + 0.13, 0.03, M.hullDark);                         // 혼합 드럼
    b.cyl(0.2, 0.2, 0.03, 16, -w * 0.29, top + 0.27, 0.03, M.hullLight);                          // 드럼 뚜껑
    b.cyl(0.04, 0.04, 0.05, 10, -w * 0.29, top + 0.3, 0.03, a);                                   // 축 부싱
    b.cyl(0.022, 0.022, 0.3, 8, -w * 0.29, top + 0.45, 0.03, M.gunmetal);                         // 교반 축
    b.box(0.2, 0.04, 0.05, -w * 0.29, top + 0.58, 0.03, M.hullLight);                             // 모터 암
    b.box(0.05, 0.03, 0.16, -w * 0.29, top + 0.23, -0.19, M.stripCyan);                           // 상태등
    b.boxB(0.24, 0.05, 0.2, w * 0.02, top, 0.05, M.gunmetal);                                     // 계량 저울
    b.box(0.2, 0.02, 0.16, w * 0.02, top + 0.06, 0.05, M.hullLight);
    b.box(0.02, 0.12, 0.02, w * 0.02, top + 0.12, 0.14, M.gunmetal);                              // 계기 지주
    b.box(0.13, 0.1, 0.02, w * 0.02, top + 0.22, 0.14, M.screen);                                 // 계기판
    b.boxB(0.46, 0.04, 0.18, w * 0.32, top, 0.06, M.crateDark);                                   // 성분 선반
    for (let k = 0; k < 4; k++) b.cyl(0.032, 0.032, 0.17, 8, w * 0.32 - 0.16 + k * 0.11, top + 0.12, 0.06, k % 2 ? M.glassDark : a);
    b.box(0.46, 0.03, 0.03, w * 0.32, top + 0.21, 0.14, M.trim);
  }),
  /**
   * 조리대 (주방 A-3c, 2026-09-11): 다른 작업대와 같은 몸체(`benchBody`) 위에 **화구 · 후드**가 올라간다 —
   * 멀리서도 "여기가 주방" 으로 읽히는 실루엣은 상판 위로 내려온 후드 캐노피다. 달아오른 화구 링과 후드
   * 조명은 emissive 재질뿐이고 **광원은 하나도 만들지 않는다** (CLAUDE.md 「씬의 광원 개수를 플레이 중에
   * 바꾸지 않는다」 · `smoke-lights`).
   */
  bench_cook: (b, w, d, h, a, lv) => benchBody(b, w, d, h, a, lv, (b) => {
    const top = h - 0.02;
    const hx = -w * 0.24, hz = 0.02;   // 후드 캐노피(w × 0.5)가 상판 왼쪽 끝을 넘지 않는 자리
    b.box(w * 0.44, 0.03, d * 0.6, hx, top + 0.015, hz, M.hullDark);                             // 화구 판
    for (const ox of [-0.17, 0.17]) for (const oz of [-0.14, 0.14])
      b.cyl(0.08, 0.08, 0.016, 14, hx + ox, top + 0.035, hz + oz, M.stripRed);                   // 달아오른 링
    b.cyl(0.13, 0.115, 0.17, 14, hx - 0.17, top + 0.13, hz - 0.14, M.gunmetal);                  // 냄비
    b.cyl(0.135, 0.135, 0.025, 14, hx - 0.17, top + 0.23, hz - 0.14, M.hullLight);               // 뚜껑
    b.cyl(0.025, 0.025, 0.04, 8, hx - 0.17, top + 0.26, hz - 0.14, M.trim);                      // 손잡이
    b.box(w * 0.44, 0.16, d * 0.6, hx, top + 0.66, hz, M.hullDark);                              // 후드 몸체
    b.box(w * 0.5, 0.08, d * 0.76, hx, top + 0.57, hz, M.hullLight);                             // 후드 캐노피
    b.box(w * 0.4, 0.02, d * 0.5, hx, top + 0.52, hz, M.stripWhite);                             // 후드 조명 (emissive)
    b.box(0.2, 0.34, 0.2, hx, top + 0.91, hz + d * 0.18, M.gunmetal);                            // 덕트
    b.boxB(0.42, 0.04, 0.3, w * 0.2, top, 0.04, M.padding);                                      // 도마
    for (let k = 0; k < 3; k++) b.cyl(0.045, 0.045, 0.05, 10, w * 0.2 - 0.1 + k * 0.1, top + 0.07, 0.04, k === 1 ? a : M.crate);
    b.boxB(0.26, 0.14, 0.24, w * 0.36, top, -0.1, M.crateDark);                                  // 재료 상자
    for (let k = 0; k < 3; k++) b.cyl(0.03, 0.035, 0.14, 8, w * 0.1 + k * 0.09, top + 0.07, d / 2 - 0.14, k % 2 ? M.glassDark : a);   // 조미료 병
  }),
  /**
   * 식탁 (주방 A-3c, 2026-09-11): `maxLevel 1` 이라 **레벨을 읽지 않는다** (핍도 없다). 상판 · 다리 · 가로 보와
   * 발자국 안에 들어오는 의자 넷, 그리고 「먹는 자리」임을 말하는 식기 한 벌. 가운데 등만 emissive 다.
   */
  dining_table: (b, w, d, h, a) => {
    const tw = Math.max(0.8, w - 0.72), td = Math.max(0.6, d - 0.72);
    const topY = h - 0.06;
    b.box(tw, 0.07, td, 0, topY, 0, M.hullLight);                                                // 상판
    b.box(tw - 0.06, 0.02, td - 0.06, 0, topY + 0.045, 0, M.padding);                            // 식탁보
    b.box(tw, 0.03, 0.04, 0, topY - 0.055, -(td / 2 - 0.02), a);                                 // 앞 가장자리 악센트
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.boxB(0.07, topY - 0.035, 0.07, sx * (tw / 2 - 0.1), 0, sz * (td / 2 - 0.1), M.gunmetal);
    b.box(tw - 0.24, 0.05, 0.05, 0, 0.24, 0, M.gunmetal);                                        // 가로 보
    for (const sz of [-1, 1]) for (const ox of [-0.26, 0.26]) {
      b.cyl(0.11, 0.1, 0.02, 14, ox, topY + 0.065, sz * (td / 2 - 0.17), M.stripWhite);          // 접시
      b.box(0.02, 0.012, 0.12, ox + 0.16, topY + 0.06, sz * (td / 2 - 0.17), M.trim);            // 수저
    }
    b.cyl(0.06, 0.08, 0.05, 12, 0, topY + 0.07, 0, M.gunmetal);                                  // 중앙 등 받침
    b.cyl(0.05, 0.05, 0.12, 12, 0, topY + 0.15, 0, M.stripAmber);                                // 불빛 (emissive only)
    for (const sz of [-1, 1]) for (const ox of [-0.34, 0.34]) {
      const cz = sz * (d / 2 - 0.22);
      b.box(0.36, 0.05, 0.34, ox, 0.44, cz, M.padding);                                          // 좌판
      for (const lx of [-1, 1]) for (const lz of [-1, 1]) b.boxB(0.04, 0.44, 0.04, ox + lx * 0.14, 0, cz + lz * 0.13, M.gunmetal);
      b.box(0.36, 0.4, 0.05, ox, 0.66, cz + sz * 0.15, M.padding);                               // 등받이
    }
  },
  /**
   * 배양조 (온실 A-14, 2026-09-11): 분석기 · 재배 스테이션과 **같은 규약의 스테이션** — 화면이 언제나
   * `CULTURE_MAX_SLOTS` 칸을 그리듯 모델도 배양관을 언제나 그만큼 세우고, `cultureSlotsForLevel(level)` 개만
   * 안의 배양액에 불이 들어온다(잠긴 관은 어둡다). 실루엣으로 분석기와 갈라지는 것은 **기울어진 콘솔이
   * 없고 관이 천장 매니폴드까지 길다**는 점이다.
   *
   * 회수 대기(`extra.cultureReady`) 칸은 배양 자홍 대신 **호박색**이다 — 방에 들어서면서 "가서 수확해라" 를
   * 읽을 수 있는 유일한 길이고, **광원은 하나도 만들지 않는다** (재질은 조각마다가 아니라 공용이라 색이
   * 바뀌면 `FurnitureLayer` 가 `housing:cultureChanged` 로 그 조각만 다시 짓는다 — 분석기와 같은 길).
   */
  culture_tank: (b, w, d, h, a, lv, extra) => {
    const open = cultureSlotsForLevel(lv);
    const ready = Math.max(0, Math.min(CULTURE_MAX_SLOTS, Math.floor(extra?.cultureReady ?? 0)));
    // ── 받침 · 배지 캐비닛 · 제어반
    b.boxB(w - 0.08, 0.14, d - 0.06, 0, 0, 0, M.hullDark);
    const cabY = 0.14, cabH = 0.5;
    b.boxB(w - 0.16, cabH, d - 0.12, 0, cabY, 0, M.hullLight);
    b.box(w - 0.2, 0.04, 0.05, 0, cabY + cabH - 0.08, -(d / 2 - 0.06), a);                       // 앞면 악센트
    b.box(w * 0.34, 0.22, 0.04, -w * 0.24, cabY + 0.27, -(d / 2 - 0.05), M.glassDark);           // 배지 저장조 창
    b.box(w * 0.3, 0.11, 0.03, -w * 0.24, cabY + 0.21, -(d / 2 - 0.06), M.stripGrow);            // 배지 (emissive)
    b.box(0.3, 0.16, 0.03, w * 0.24, cabY + 0.3, -(d / 2 - 0.05), M.screen);                     // 제어 화면
    for (let k = 0; k < 3; k++) b.box(0.05, 0.03, 0.02, w * 0.24 - 0.1 + k * 0.1, cabY + 0.14, -(d / 2 - 0.05), k < lv ? M.stripWhite : M.hullDark);
    const deck = cabY + cabH;
    b.box(w - 0.12, 0.05, d - 0.1, 0, deck + 0.025, 0, M.gunmetal);                              // 배관 데크
    // ── 뒷기둥 + 상단 매니폴드
    for (const sx of [-1, 1]) b.boxB(0.08, h - deck, 0.08, sx * (w / 2 - 0.06), deck, d / 2 - 0.06, M.gunmetal);
    b.box(w - 0.1, 0.12, 0.14, 0, h - 0.1, d / 2 - 0.08, M.hullDark);
    b.box(w - 0.16, 0.03, 0.04, 0, h - 0.17, d / 2 - 0.15, a);
    // ── 배양관: 언제나 CULTURE_MAX_SLOTS 개, 레벨이 연 칸만 배양액이 빛난다
    const tubeY = deck + 0.05, tubeH = Math.max(0.3, h - tubeY - 0.24);
    for (let s = 0; s < CULTURE_MAX_SLOTS; s++) {
      const px = -w / 2 + (s + 0.5) * (w / CULTURE_MAX_SLOTS);
      const lit = s < open, done = s < ready;
      const glow = lit ? (done ? M.stripAmber : M.stripGrow) : M.hullDark;
      b.cyl(0.12, 0.14, 0.06, 14, px, tubeY + 0.03, 0, M.gunmetal);                              // 관 받침
      b.cyl(0.115, 0.115, tubeH, 14, px, tubeY + 0.06 + tubeH / 2, 0, M.glassDark, 0, 0, 0, true);   // 유리관
      b.cyl(0.085, 0.085, tubeH * 0.52, 12, px, tubeY + 0.06 + tubeH * 0.26, 0, glow);            // 배양액
      b.cyl(0.018, 0.018, tubeH * 0.78, 6, px, tubeY + 0.06 + tubeH * 0.39, 0.055, M.trim);       // 폭기관
      b.cyl(0.13, 0.13, 0.06, 14, px, tubeY + 0.09 + tubeH, 0, M.hullLight);                      // 상단 캡
      b.cyl(0.024, 0.024, d / 2 - 0.1, 8, px, h - 0.13, (d / 2 - 0.1) / 2, M.trim, Math.PI / 2);  // 급액 라인 (매니폴드 → 관)
      b.cyl(0.02, 0.02, 0.09, 6, px, h - 0.18, 0, M.trim);                                        // 노즐
      b.box(0.09, 0.02, 0.03, px, tubeY + 0.02, -(d / 2 - 0.1), lit ? (done ? M.stripAmber : a) : M.hullDark);   // 칸 표식
    }
  },
  /**
   * 3D 프린터 (A-15, 2026-09-11): 필라멘트로 상급 가방 · 주머니를 찍는 작업대. 다른 작업대와 달리 **책상이
   * 아니라 상자**다 (def height 1.6 — `benchBody` 의 다리를 그 높이로 세우면 사람 키만 한 식탁이 된다).
   * 받침 캐비닛 위에 기둥 넷 · 옆 유리 · 천장으로 챔버를 세우고, 그 안에 조형판 · 가로 갠트리 · 노즐,
   * 뒤쪽에 필라멘트 스풀 두 개. 챔버 조명 · 히팅 베드 · 달아오른 노즐은 전부 emissive 재질이다.
   */
  bench_print: (b, w, d, h, a, lv) => {
    const cabH = Math.min(0.62, h * 0.4);
    // ── 받침 캐비닛
    b.boxB(w - 0.08, 0.12, d - 0.06, 0, 0, 0, M.hullDark);
    b.boxB(w - 0.14, cabH - 0.12, d - 0.12, 0, 0.12, 0, M.hullLight);
    b.box(w - 0.2, 0.04, 0.05, 0, cabH - 0.12, -(d / 2 - 0.06), a);                              // 앞면 악센트
    b.box(0.34, 0.18, 0.03, -w * 0.28, cabH - 0.3, -(d / 2 - 0.05), M.screen);                   // 제어 화면
    for (let k = 0; k < 3; k++) b.box(0.05, 0.03, 0.02, -w * 0.28 - 0.1 + k * 0.1, cabH - 0.46, -(d / 2 - 0.05), k < lv ? M.stripWhite : M.hullDark);
    for (let k = 0; k < 3; k++) b.box(w * 0.28, 0.03, 0.02, w * 0.2, 0.2 + k * 0.13, -(d / 2 - 0.05), M.trim);   // 서랍 손잡이
    // ── 챔버 프레임
    const fy = cabH, fh = h - cabH;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.boxB(0.07, fh, 0.07, sx * (w / 2 - 0.06), fy, sz * (d / 2 - 0.06), M.gunmetal);
    b.box(w - 0.04, 0.07, d - 0.04, 0, h - 0.035, 0, M.hullLight);                               // 천장
    b.box(w - 0.3, 0.04, 0.05, 0, h - 0.09, -(d / 2 - 0.04), a);                                 // 천장 악센트
    b.box(w - 0.16, fh - 0.1, 0.03, 0, fy + fh / 2, d / 2 - 0.05, M.hullDark);                   // 뒷판
    for (const sx of [-1, 1]) b.box(0.03, fh - 0.16, d - 0.2, sx * (w / 2 - 0.07), fy + fh / 2, 0, M.glassDark);   // 옆 유리
    b.box(w - 0.34, 0.02, 0.06, 0, h - 0.1, 0, M.stripWhite);                                    // 챔버 조명 (emissive)
    // ── 조형판 + 쌓이는 조형물
    const plateY = fy + 0.14, plateX = -w * 0.06;
    b.box(w * 0.52, 0.05, d * 0.56, plateX, plateY, 0.02, M.gunmetal);
    b.box(w * 0.48, 0.02, d * 0.5, plateX, plateY + 0.035, 0.02, M.hullLight);
    b.box(w * 0.5, 0.02, 0.03, plateX, plateY + 0.03, -(d * 0.3), M.stripAmber);                 // 히팅 베드 (emissive)
    for (let k = 0; k < 3; k++) b.box(0.3 - k * 0.07, 0.06, 0.22 - k * 0.05, plateX, plateY + 0.08 + k * 0.06, 0.02, a);
    // ── 갠트리 · Z 리드스크루 · 필라멘트 스풀
    const gy = plateY + 0.44;
    b.box(w - 0.2, 0.07, 0.09, 0, gy, 0.02, M.hullLight);
    for (const sx of [-1, 1]) b.boxB(0.1, 0.16, 0.12, sx * (w / 2 - 0.13), gy - 0.08, 0.02, M.gunmetal);
    b.box(0.16, 0.14, 0.16, plateX, gy - 0.12, 0.02, M.hullDark);                                // 출력 헤드
    b.cyl(0.02, 0.045, 0.08, 10, plateX, gy - 0.22, 0.02, M.stripAmber);                         // 노즐 (emissive)
    for (const sx of [-1, 1]) b.cyl(0.018, 0.018, fh - 0.2, 8, sx * (w / 2 - 0.14), fy + 0.06 + (fh - 0.2) / 2, 0.02, M.trim);
    for (let k = 0; k < 2; k++) {
      const sy = fy + 0.26 + k * 0.36;
      b.cyl(0.15, 0.15, 0.07, 16, w * 0.34, sy, 0.22, k === 0 ? a : M.fabric, Math.PI / 2);       // 필라멘트 스풀
      b.cyl(0.05, 0.05, 0.1, 10, w * 0.34, sy, 0.22, M.gunmetal, Math.PI / 2);                    // 스풀 허브
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
  /* 서재 책장 (Phase 9): body + BOOK_SHELF_ROWS shelves, one spine box per shelved book (colour = rarity), empty slots stay empty. */
  bookshelf: (b, w, d, h, a, _lv, extra) => {
    for (const sx of [-1, 1]) b.boxB(0.05, h, d, sx * (w / 2 - 0.03), 0, 0, M.hullLight);
    b.box(w, h, 0.03, 0, h / 2, d / 2 - 0.02, M.hullDark);                                  // back board
    b.box(w, 0.05, d, 0, h - 0.025, 0, M.hullLight);                                        // top
    b.box(w - 0.1, 0.05, d - 0.02, 0, 0.06, 0, M.gunmetal);                                 // plinth
    b.box(w - 0.14, 0.03, 0.04, 0, h - 0.06, -(d / 2 - 0.02), a);                           // accent lip under the top
    const rows = BOOK_SHELF_ROWS, perRow = Math.ceil(BOOKS_PER_SHELF / rows);
    const y0 = 0.1, rowH = (h - 0.2) / rows;
    const books = extra?.books ?? [];
    for (let r = 0; r < rows; r++) {
      const y = y0 + r * rowH;
      b.box(w - 0.1, 0.04, d - 0.06, 0, y, 0.01, M.gunmetal);                              // shelf board
      b.box(w - 0.12, 0.02, 0.03, 0, y + 0.015, -(d / 2 - 0.05), M.trim);                    // front edge
      for (let k = 0; k < perRow; k++) {
        const slot = (rows - 1 - r) * perRow + k;                                          // slot 0 = top-left
        const rarity = books[slot] ?? null;
        if (!rarity) continue;
        const bx = -(w / 2 - 0.16) + k * ((w - 0.32) / Math.max(1, perRow - 1));
        const bh = 0.22 + ((slot * 7) % 3) * 0.03, bt = 0.06 + ((slot * 5) % 2) * 0.02;
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
  chair: (b, w, d, h) => {
    const seatY = h * 0.5;
    b.box(w - 0.1, 0.05, d - 0.1, 0, seatY, 0, M.padding);
    b.box(w - 0.14, 0.03, d - 0.14, 0, seatY - 0.04, 0, M.hullDark);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.boxB(0.04, seatY - 0.05, 0.04, sx * (w / 2 - 0.08), 0, sz * (d / 2 - 0.08), M.gunmetal);
    b.box(w - 0.12, h - seatY, 0.04, 0, seatY + (h - seatY) / 2, d / 2 - 0.07, M.padding, 0, -0.1);
    b.box(w - 0.16, 0.03, 0.03, 0, h - 0.02, d / 2 - 0.09, M.trim);
  },
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
   * 전술 임플란트 시술대 (2026-09-12, 공용 시설 가구): 조종석 붙박이였던 시술대와 **같은 몸체**(`stations.implantBayBody`)다.
   * 몸체가 로컬 x −0.79 … 0.36 · z −0.62 … 0.75 라 발자국(3 × 4 칸 = 1.5 × 2 m) 가운데로 오도록 (+0.2, −0.06) 옮기고,
   * 바닥에 발자국 테두리 판 + 앞 가장자리 악센트만 더한다. 광원 없음 — 캐노피 불빛은 emissive 재질뿐이다.
   */
  implant_bay: (b, w, d, _h, a) => {
    b.box(w - 0.1, 0.03, d - 0.1, 0, 0.015, 0, M.floorGrate);                                    // 바닥 판
    b.box(w - 0.3, 0.02, 0.05, 0, 0.04, -(d / 2 - 0.08), a);                                     // 앞 악센트
    implantBayBody(b, 0.2, -0.06, 0);
  },
  /**
   * 기업 네트워크 컴퓨터 (2026-09-12, 공용 시설 가구): 붙박이 책상과 **같은 몸체**(`stations.shipComputerBody`). 책상 등이
   * 발자국 뒤 가장자리(로컬 +Z)에 붙도록 몸체 중심을 `d/2 − 0.4` 로 민다 — 의자는 앞(−Z) 쪽 발자국 안에 남는다.
   * 왼쪽 모니터 글자판(`TextPlane`)은 빌더가 만들 수 없어 `FurnitureLayer.addPiece` 가 `COMPUTER_SCREEN_LOCAL` 에 붙인다.
   */
  corp_computer: (b, _w, d) => {
    shipComputerBody(b, 0, d / 2 - 0.4, 0);
  },
};

/** 기업 네트워크 컴퓨터 모델의 왼쪽 모니터 자리 (가구 로컬 좌표) — `corp_computer` 빌더와 같은 책상 오프셋이다. */
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
   * 2026-09-12 (사용자 결정 — 시뮬레이션실 제거): `onRangeConsole()` (관물대 → 프리셋 메뉴) and `onSimHub()` (시뮬레이션
   * 허브 → 훈련장) lived here. Both pieces are retired (`retired=1`, refunded on load), presets are gone and the arena is
   * entered from the terminal — `RETIRED_INTERACTIONS` below registers **no** interactable for those kinds.
   */
  /** 전술 임플란트 시술대 (2026-09-12, 공용 시설 가구): the Tab window's implant slots, like the old `hub_implant_bay`. */
  onImplantBay(): void;
  /** 기업 네트워크 컴퓨터 (2026-09-12, 공용 시설 가구): the corporation screen, like the old `hub_computer`. */
  onCorpComputer(): void;
  /**
   * 재배층 (Phase 8). @deprecated 2026-09-11 (온실 개편) — `furn_grow_rack` 은 은퇴했고 `ShipState.sanitize` 가
   * 놓인 것을 걷어내므로 실제로는 불리지 않는다. 계약은 추가만 하므로 경로는 그대로 남긴다.
   */
  onGrowRack(uid: string): void;
  /** 재배 스테이션 (온실 개편, 2026-09-11): 그 스테이션의 재배 화면 (`ctx.housing.openGrowStation(uid)`). */
  onGrowStation(uid: string): void;
  /*
   * 정비 벤치 (Phase 8) — **2026-09-12 은퇴** (사용자 결정). `onRepairBench(): void` 가 여기 있었고
   * `hub/ui/WorkbenchMenu` 를 열었다. 함선에서의 무기 수리는 이제 인벤토리에서 재료로 하므로 그 창도,
   * `furn_repair_bench` 가구도 없다(`data/furniture.csv` 의 `retired=1` → `ShipState.sanitize` 가 환불한다).
   * `FurnitureInteraction` 의 `'repair_bench'` 는 계약이라 남아 있고, 아래 dispatch 가 **아무것도 하지 않는**
   * 분기로 그 값을 잡는다 — 없애면 `else cb.onRangeConsole()` 로 흘러 엉뚱한 창이 열린다.
   */
  /** 책장 (Phase 9): open the bookshelf panel of this piece (`ctx.housing.openBookshelfMenu(uid)`). */
  onBookshelf(uid: string): void;
  /** 분석기 (연구실 A-12, 2026-09-11): open the 해석 panel of this piece (`ctx.housing.openAnalyzer(uid)`). */
  onAnalyzer(uid: string): void;
  /** 배양조 (온실 A-14, 2026-09-11): open the 배양 panel of this piece (`ctx.housing.openCultureTank(uid)`). */
  onCultureTank(uid: string): void;
  /**
   * 식탁 (주방 A-3c, 2026-09-11): open the 식사 panel (`ctx.housing.openDiningTable(uid)`). A placed piece always
   * passes its own `uid`; **`null` is reserved for the shared ship's fixed table**, which is not furniture at all
   * and is registered by `parts/Interior.buildStations` instead of this layer.
   */
  onDiningTable(uid: string): void;
}

/**
 * 개인 함선 방문 (2026-09-08): where the layer reads its pieces from. Default = `ctx.housing` (our own ship). A
 * **visited** ship passes a frozen source built from that member's `ShipVisitWire` instead — it never changes, so
 * the layer also skips its `housing:*` subscriptions and registers no interactables (둘러보기 전용).
 */
export interface FurnitureSource {
  getPlaced(room: number): readonly PlacedFurniture[];
  /** Shelved book rarities of a 책장 by slot (null = empty slot). */
  getBooks(uid: string): readonly (Rarity | null)[];
}

interface Piece {
  item: PlacedFurniture;
  model: FurnitureModel;
  blocker: number;
  sign: TextPlane | null;
  /** 2026-09-12: 기업 네트워크 컴퓨터의 모니터 글자판 (그 조각의 그룹 자식 — 조각과 함께 버린다). */
  screen: TextPlane | null;
  interactable: Interactable | null;
}

/**
 * 2026-09-12: interactions whose furniture is retired (`retired=1`, refunded by housing on load) — a stale piece that
 * somehow reaches the layer is drawn but answers to nothing. `range_console` (관물대 · 프리셋 — the feature is gone),
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
        // A-12 (2026-09-11): 해석이 시작 · 완료 · 회수됐다 → 그 분석기만 다시 짓는다. 회수 대기 칸은 호박색으로
        // 켜지는데, 그것이 **광원 없이** 색을 바꿀 수 있는 유일한 길이다 (재질은 조각마다가 아니라 공용이므로).
        b.on('housing:analysisChanged', ({ uid }) => { const p = this.pieces.get(uid); if (p) this.rebuildRoom(p.item.room); }),
        // A-14 (2026-09-11): 배양이 시작 · 완료 · 회수됐다 → 그 배양조만 다시 짓는다 (분석기와 같은 길, 광원 없음).
        b.on('housing:cultureChanged', ({ uid }) => { const p = this.pieces.get(uid); if (p) this.rebuildRoom(p.item.room); }),
      );
    }
    this.rebuildAll();
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

  /** Per-frame animation: the 시뮬레이션 허브 rings turn slowly (nothing else animates). */
  update(time: number): void {
    for (const p of this.pieces.values()) {
      const m = p.model;
      if (!m.spin) continue;
      m.spin.rotation.y = time * 0.6;
      if (m.spinInner) { m.spinInner.rotation.x = 0.55 + Math.sin(time * 0.7) * 0.35; m.spinInner.rotation.z = time * 0.9; }
    }
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

    // a visited ship is 둘러보기 전용: the pieces are drawn and collide, but nothing answers to E
    let interactable: Interactable | null = null;
    if (def.interaction !== 'none' && !RETIRED_INTERACTIONS.has(def.interaction) && this.source === null) {
      const bench = benchKindOf(def.interaction);
      const kind = def.interaction;
      const stack = Math.max(1, def.stackLimit ?? 1);
      const fixture = FIXTURE_INTERACTABLE[kind];
      const prompt = fixture ? fixture.prompt
        : bench || kind === 'analyzer' || kind === 'culture_tank' ? `${def.name} Lv.${item.level}`
        : stack > 1 ? `${def.name} ${layer + 1}층`
        : def.name;
      // A stack shares one footprint, so every layer would sit on the same anchor: spread the layers along the
      // piece's front edge instead (a control panel per 층) so `findBest` can tell them apart.
      const anchor = _pos.clone();
      const rot = yawToRotation(item.yaw), cos = Math.cos(rot), sin = Math.sin(rot);
      if (stack > 1) {
        const lw = def.cols * HOUSING_CELL_SIZE, ld = def.rows * HOUSING_CELL_SIZE;
        const ox = (layer - (stack - 1) / 2) * (lw / stack);
        const oz = -(ld / 2 + 0.55);
        anchor.set(_pos.x + ox * cos + oz * sin, 0, _pos.z - ox * sin + oz * cos);
      } else if (fixture) {
        // 2026-09-12: a fixture's anchor stands **in front of** the piece (local −Z), where the old station's anchor was
        const oz = -(def.rows * HOUSING_CELL_SIZE / 2 + 0.6);
        anchor.set(_pos.x + oz * sin, 0, _pos.z + oz * cos);
      }
      // the old station id when it is still free (one fixture of a kind per ship), else the generic furniture id
      const id = fixture && !this.ctx.interactables.all().some((i) => i.id === fixture.id) ? fixture.id : `hub_furn_${item.uid}`;
      const cb = this.cb, level = item.level, uid = item.uid;
      interactable = {
        id,
        position: anchor,
        radius: fixture ? fixture.radius : stack > 1 ? 1.2 : Math.max(w, d) / 2 + 1.1,
        getPrompt: () => (cb.canUse() ? prompt : null),
        canInteract: () => cb.canUse(),
        interact: () => {
          if (bench) cb.onBench(bench, level);
          else if (kind === 'implant_bay') cb.onImplantBay();
          else if (kind === 'corp_computer') cb.onCorpComputer();
          else if (kind === 'grow_rack') cb.onGrowRack(uid);
          else if (kind === 'grow_station') cb.onGrowStation(uid);
          else if (kind === 'bookshelf') cb.onBookshelf(uid);
          else if (kind === 'analyzer') cb.onAnalyzer(uid);
          else if (kind === 'culture_tank') cb.onCultureTank(uid);
          else if (kind === 'dining_table') cb.onDiningTable(uid);
          /* anything else (a future interaction nobody wired yet) does nothing rather than opening a wrong window */
        },
      };
      this.ctx.interactables.register(interactable);
    }
    this.pieces.set(item.uid, { item, model, blocker, sign, screen, interactable });
  }

  /** Per-piece state a builder reads: 책장 = shelved books, 분석기 / 배양조 = how many 칸 wait to be collected. */
  private buildExtra(def: FurnitureDef, uid: string): BuildExtra | undefined {
    if (def.model === 'bookshelf') return { books: this.shelfBooks(uid) };
    if (def.model === 'analyzer') return { analysisReady: this.analysisReady(uid) };
    if (def.model === 'culture_tank') return { cultureReady: this.cultureReady(uid) };
    return undefined;
  }

  /**
   * 회수 대기 배양 칸 수 (배양조 관의 색). Same shape as `analysisReady` — a visited ship has none on the wire and
   * `ctx.housing` is duck-typed / try-caught, so an unfinished folder degrades to a dark tank instead of throwing
   * in the middle of a room rebuild.
   */
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
   * 회수 대기 해석 칸 수 (분석기의 챔버 색). A visited ship has no analyses on the wire, and `ctx.housing` is
   * duck-typed / try-caught like everywhere else in this file — an unfinished folder must degrade to a dark model,
   * never throw in the middle of a room rebuild.
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
    for (const p of this.pieces.values()) this.removePiece(p);
    this.pieces.clear();
  }
}
