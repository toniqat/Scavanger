import * as THREE from 'three';
import type { FurnitureDef, FurnitureModelKind, GameContext, Interactable, PlacedFurniture, WorkbenchKind } from '@/shared';
import { FURNITURE_DEF_MAP, HOUSING_CELL_SIZE, benchKindOf, furnitureFootprint } from '@/shared';
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
const LAMP_GLOW = new THREE.MeshStandardMaterial({ color: 0xffe3a0, roughness: 0.3, metalness: 0, emissive: 0xffc060, emissiveIntensity: 2.4 });
const LEAF = new THREE.MeshStandardMaterial({ color: 0x4f9a4a, roughness: 0.85, metalness: 0 });
const POT = new THREE.MeshStandardMaterial({ color: 0x8a5a3c, roughness: 0.9, metalness: 0.05 });
const TARGET = new THREE.MeshStandardMaterial({ color: 0xe8e2d0, roughness: 0.8, metalness: 0.05 });
const TARGET_RING = new THREE.MeshStandardMaterial({ color: 0xd23a2a, roughness: 0.7, metalness: 0.05 });
/** Ghost materials for the housing-mode preview. */
export const GHOST_OK = new THREE.MeshBasicMaterial({ color: 0x5cff8a, transparent: true, opacity: 0.45, depthWrite: false });
export const GHOST_BAD = new THREE.MeshBasicMaterial({ color: 0xff5a4a, transparent: true, opacity: 0.45, depthWrite: false });

export interface FurnitureModel {
  group: THREE.Group;
  meshes: THREE.Mesh[];
  /** Footprint in metres (unrotated). */
  w: number;
  d: number;
}

/** Build the model of `def` (unrotated, centred, front toward −Z). */
export function buildFurniture(def: FurnitureDef, level = 1): FurnitureModel {
  const g = new THREE.Group();
  g.name = `furn-${def.id}`;
  const b = new GeoBatch();
  const w = def.cols * HOUSING_CELL_SIZE, d = def.rows * HOUSING_CELL_SIZE, h = def.height;
  const accent = tint(def.color);
  BUILDERS[def.model](b, w, d, h, accent, level);
  const meshes: THREE.Mesh[] = [];
  b.build(g, meshes);
  return { group: g, meshes, w, d };
}

/* ── builders ─────────────────────────────────────────────────────────────── */
type Builder = (b: GeoBatch, w: number, d: number, h: number, accent: THREE.Material, level: number) => void;

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
  /* Phase 7 skeleton (hub/ agent builds the real holo pedestal): plain pedestal so the catalogue stays complete. */
  sim_hub: (b, w, d, h) => { b.box(w * 0.8, h * 0.5, d * 0.8, 0, h * 0.25, 0, M.hullDark); b.box(w * 0.5, h * 0.5, d * 0.5, 0, h * 0.75, 0, M.stripWhite); },
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

  constructor(private readonly ctx: GameContext, private readonly rooms: readonly RoomDef[], private readonly collider: BoxInteriorCollider, private readonly cb: FurnitureCallbacks) {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('housing:furniturePlaced', ({ item }) => this.rebuildRoom(item.room)),
      b.on('housing:furnitureMoved', ({ item }) => this.rebuildRoom(item.room)),
      b.on('housing:furnitureUpgraded', ({ item }) => this.rebuildRoom(item.room)),
      b.on('housing:furnitureRecovered', ({ room }) => this.rebuildRoom(room)),
      b.on('housing:changed', ({ reason }) => { if (!COVERED_CHANGE_REASONS.has(reason)) this.rebuildAll(); }),
      b.on('housing:loaded', () => this.rebuildAll()),
    );
    this.rebuildAll();
  }

  /** Placed piece under a room cell, or null. */
  pieceAt(room: number, x: number, y: number): PlacedFurniture | null {
    for (const p of this.pieces.values()) {
      const it = p.item;
      if (it.room !== room) continue;
      const def = FURNITURE_DEF_MAP.get(it.defId);
      if (!def) continue;
      const fp = furnitureFootprint(def, it.yaw);
      if (x >= it.x && x < it.x + fp.cols && y >= it.y && y < it.y + fp.rows) return it;
    }
    return null;
  }

  /** Number of rendered pieces (debug / smoke). */
  get count(): number { return this.pieces.size; }

  rebuildAll(): void {
    for (const r of this.rooms) this.rebuildRoom(r.index);
  }

  rebuildRoom(room: number): void {
    const def = this.rooms[room];
    if (!def) return;
    for (const [uid, p] of this.pieces) if (p.item.room === room) { this.removePiece(p); this.pieces.delete(uid); }
    const housing = this.ctx.housing;
    if (!housing || typeof housing.getPlaced !== 'function') return;
    let placed: readonly PlacedFurniture[] = [];
    try { placed = housing.getPlaced(room); } catch { placed = []; }
    for (const item of placed) this.addPiece(def, item);
  }

  private addPiece(roomDef: RoomDef, item: PlacedFurniture): void {
    const def = FURNITURE_DEF_MAP.get(item.defId);
    if (!def) return;
    const fp = furnitureFootprint(def, item.yaw);
    const model = buildFurniture(def, item.level);
    roomCellToWorld(item.room, item.x, item.y, _pos, fp.cols, fp.rows);
    model.group.position.copy(_pos);
    model.group.rotation.y = yawToRotation(item.yaw);
    roomDef.furnitureGroup.add(model.group);
    const w = fp.cols * HOUSING_CELL_SIZE, d = fp.rows * HOUSING_CELL_SIZE;
    const blocker = this.collider.addBox(_pos.x, 0, _pos.z, w, def.height, d);

    let sign: TextPlane | null = null;
    if (def.maxLevel > 1) {
      sign = new TextPlane(0.5, 0.2, 128);
      sign.mesh.position.set(_pos.x, def.height + 0.9, _pos.z);
      sign.mesh.rotation.y = yawToRotation(item.yaw) + Math.PI;     // PlaneGeometry faces +Z; the model's front is −Z
      sign.set([`Lv.${item.level}`], def.color, 'rgba(6,8,10,0.75)');
      roomDef.furnitureGroup.add(sign.mesh);
    }

    let interactable: Interactable | null = null;
    if (def.interaction !== 'none') {
      const bench = benchKindOf(def.interaction);
      const prompt = bench ? `${def.name} Lv.${item.level}` : def.name;
      const cb = this.cb, level = item.level;
      interactable = {
        id: `hub_furn_${item.uid}`,
        position: _pos.clone(),
        radius: Math.max(w, d) / 2 + 1.1,
        getPrompt: () => (cb.canUse() ? prompt : null),
        canInteract: () => cb.canUse(),
        interact: () => { if (bench) cb.onBench(bench, level); else cb.onRangeConsole(); },
      };
      this.ctx.interactables.register(interactable);
    }
    this.pieces.set(item.uid, { item, model, blocker, sign, interactable });
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
