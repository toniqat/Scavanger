import * as THREE from 'three';
import type { FurnitureDef, FurnitureModelKind, GameContext, GrowTier, Interactable, PlacedFurniture, Rarity, WorkbenchKind } from '@/shared';
import { BOOKS_PER_SHELF, FURNITURE_DEF_MAP, GROW_PLOTS_PER_RACK, GROW_RACK_LAYER_HEIGHT, GROW_SLOTS_PER_TIER, HOUSING_CELL_SIZE, RARITY_COLORS, benchKindOf, furnitureFootprint, growTiersForLevel } from '@/shared';
import { GeoBatch, HUB_MATS as M, disposeMeshes } from './GeoBatch';
import type { BoxInteriorCollider } from './InteriorCollider';
import { roomCellToWorld, yawToRotation } from './RoomLayout';
import { TextPlane } from '../Labels';
import type { RoomDef } from './types';

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
};

/* ── placed-furniture layer ───────────────────────────────────────────────── */
export interface FurnitureCallbacks {
  /** Interactables are usable (walking the ship, no menu, not boarded, not in housing mode). */
  canUse(): boolean;
  onBench(kind: WorkbenchKind, level: number): void;
  onRangeConsole(): void;
  /** 시뮬레이션 허브 (Phase 7): start / join the 시뮬레이션 훈련장. */
  onSimHub(): void;
  /**
   * 재배층 (Phase 8). @deprecated 2026-09-11 (온실 개편) — `furn_grow_rack` 은 은퇴했고 `ShipState.sanitize` 가
   * 놓인 것을 걷어내므로 실제로는 불리지 않는다. 계약은 추가만 하므로 경로는 그대로 남긴다.
   */
  onGrowRack(uid: string): void;
  /** 재배 스테이션 (온실 개편, 2026-09-11): 그 스테이션의 재배 화면 (`ctx.housing.openGrowStation(uid)`). */
  onGrowStation(uid: string): void;
  /** 정비 벤치 (Phase 8): open the weapon-repair menu (the cockpit bench moved into the 작업실). */
  onRepairBench(): void;
  /** 책장 (Phase 9): open the bookshelf panel of this piece (`ctx.housing.openBookshelfMenu(uid)`). */
  onBookshelf(uid: string): void;
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
  interactable: Interactable | null;
}

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
  constructor(private readonly ctx: GameContext, private readonly rooms: readonly RoomDef[], private readonly collider: BoxInteriorCollider, private readonly cb: FurnitureCallbacks, private readonly source: FurnitureSource | null = null) {
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

  rebuildAll(): void {
    for (const r of this.rooms) this.rebuildRoom(r.index);
  }

  rebuildRoom(room: number): void {
    const def = this.rooms[room];
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

  private addPiece(roomDef: RoomDef, item: PlacedFurniture): void {
    const def = FURNITURE_DEF_MAP.get(item.defId);
    if (!def) return;
    const fp = furnitureFootprint(def, item.yaw);
    const model = buildFurniture(def, item.level, def.model === 'bookshelf' ? { books: this.shelfBooks(item.uid) } : undefined);
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

    // a visited ship is 둘러보기 전용: the pieces are drawn and collide, but nothing answers to E
    let interactable: Interactable | null = null;
    if (def.interaction !== 'none' && this.source === null) {
      const bench = benchKindOf(def.interaction);
      const kind = def.interaction;
      const stack = Math.max(1, def.stackLimit ?? 1);
      const prompt = bench ? `${def.name} Lv.${item.level}`
        : kind === 'sim_hub' ? `${def.name} · 훈련장 입장`
        : stack > 1 ? `${def.name} ${layer + 1}층`
        : def.name;
      // A stack shares one footprint, so every layer would sit on the same anchor: spread the layers along the
      // piece's front edge instead (a control panel per 층) so `findBest` can tell them apart.
      const anchor = _pos.clone();
      if (stack > 1) {
        const lw = def.cols * HOUSING_CELL_SIZE, ld = def.rows * HOUSING_CELL_SIZE;
        const ox = (layer - (stack - 1) / 2) * (lw / stack);
        const oz = -(ld / 2 + 0.55);
        const rot = yawToRotation(item.yaw), cos = Math.cos(rot), sin = Math.sin(rot);
        anchor.set(_pos.x + ox * cos + oz * sin, 0, _pos.z - ox * sin + oz * cos);
      }
      const cb = this.cb, level = item.level, uid = item.uid;
      interactable = {
        id: `hub_furn_${item.uid}`,
        position: anchor,
        radius: stack > 1 ? 1.2 : Math.max(w, d) / 2 + 1.1,
        getPrompt: () => (cb.canUse() ? prompt : null),
        canInteract: () => cb.canUse(),
        interact: () => {
          if (bench) cb.onBench(bench, level);
          else if (kind === 'sim_hub') cb.onSimHub();
          else if (kind === 'grow_rack') cb.onGrowRack(uid);
          else if (kind === 'grow_station') cb.onGrowStation(uid);
          else if (kind === 'repair_bench') cb.onRepairBench();
          else if (kind === 'bookshelf') cb.onBookshelf(uid);
          else cb.onRangeConsole();
        },
      };
      this.ctx.interactables.register(interactable);
    }
    this.pieces.set(item.uid, { item, model, blocker, sign, interactable });
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
    if (p.interactable) this.ctx.interactables.unregister(p.interactable.id);
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    for (const p of this.pieces.values()) this.removePiece(p);
    this.pieces.clear();
  }
}
