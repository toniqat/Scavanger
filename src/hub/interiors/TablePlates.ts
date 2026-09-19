import * as THREE from 'three';
import type { GameContext, MealDef } from '@/shared';
import { MEAL_QUALITY_MAX, getMealDef, normalizeMealQuality } from '@/shared';
import { GeoBatch, disposeMeshes } from './GeoBatch';
import { TextPlane } from '../Labels';
import type { TablePlateSlot } from './stations';

/* ────────────────────────────────────────────────────────────────────────────
 * The plates on the dining table (2026-09-16 the plate model, user's decision — a meal is not an item but a plate on the dining table).
 *
 *  • `addPlateToBatch` — puts one plate (the dish + the shape of the food) into a `GeoBatch`. The personal ship's dining-table furniture (the
 *    `dining_table` builder in `Furniture.ts`, `BuildExtra.plate`) and the shared ship's fixed table (`TablePlates`) use the same shape.
 *  • `TablePlates` — puts **every squadmate's plate** (`HousingRef.getTablePlates(null)`) on the four place settings of the shared ship's fixed
 *    table, and stands the cook's name tag by each. Rebuilt on `housing:tablePlatesChanged` · `hub:entered` (not when the plates are unchanged).
 *
 * The tier decides the shape of the food (1 vegetable = a green heap · 2 paste = three round dollops · 3 meat = a thick cut · 4 dairy = a
 * cream-coloured round dish), and quality star `MEAL_QUALITY_MAX` adds one gold garnish. **It creates no light** (CLAUDE.md's 「never change the
 * point-light count at runtime」 — the garnish's glow is emissive only). The materials are standard, so no new shader program appears, and they are
 * made once at module level and used forever (the same contract as `FurnitureKitchen.liquidMat` — never disposed). The colours are presentation values, not balance numbers.
 * ──────────────────────────────────────────────────────────────────────────── */

const std = (color: number, roughness: number, metalness: number, emissive = 0, emissiveIntensity = 0): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness, emissive, emissiveIntensity });

const MAT = {
  porcelain: std(0xe9e4da, 0.35, 0.05),
  rim: std(0xb9b2a4, 0.4, 0.2),
  veg: std(0x7f9c4e, 0.85, 0.02),
  vegDark: std(0x4f6e32, 0.9, 0.02),
  broth: std(0xb58a52, 0.55, 0.05),
  paste: std(0x9a5e3a, 0.75, 0.04),
  meat: std(0x7a3f28, 0.7, 0.05),
  sear: std(0x3e2217, 0.85, 0.05),
  cream: std(0xeadcae, 0.6, 0.03),
  crust: std(0xd49a4a, 0.7, 0.03),
  leaf: std(0x5fae4a, 0.8, 0.02),
  gold: std(0xffd27a, 0.35, 0.3, 0xffa640, 1.2),
};

/** The radius of the plate's dish (m, a presentation value) — without `withDish` (on the shared table's place setting) it is scaled down to that setting. */
const DISH_R = 0.15;

/**
 * Puts one plate into `b`. (`x`, `y`, `z`) = the centre of the dish's base on the table top, `ry` = the table's yaw (it orients the shapes).
 * `withDish` false = only the food goes on top of an already-drawn place setting (the shared ship's table).
 */
export function addPlateToBatch(b: GeoBatch, x: number, y: number, z: number, mealDefId: string, quality: number, ry = 0, withDish = true): void {
  const meal: MealDef | undefined = getMealDef(mealDefId)?.meal;
  const s = withDish ? 1 : 0.78;
  let top = y;
  if (withDish) {
    b.cyl(DISH_R, DISH_R * 0.8, 0.022, 20, x, y + 0.011, z, MAT.porcelain);
    b.cyl(DISH_R + 0.004, DISH_R + 0.004, 0.008, 20, x, y + 0.024, z, MAT.rim, 0, 0, 0, true);   // the rim (an open cylinder)
    top = y + 0.024;
  }
  const L = (ox: number, oz: number): [number, number] => [x + Math.cos(ry) * ox + Math.sin(ry) * oz, z - Math.sin(ry) * ox + Math.cos(ry) * oz];
  switch (meal?.tier ?? 1) {
    case 1: {                                                          // a vegetable · broth dish: a layer of broth + a heap of vegetables + leaves
      b.cyl(0.1 * s, 0.1 * s, 0.012, 16, x, top + 0.006, z, MAT.broth);
      b.cyl(0.05 * s, 0.085 * s, 0.04 * s, 12, x, top + 0.012 + 0.02 * s, z, MAT.veg);
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * Math.PI * 2 + 0.4;
        const [px, pz] = L(Math.cos(a) * 0.05 * s, Math.sin(a) * 0.05 * s);
        b.box(0.03 * s, 0.012, 0.018 * s, px, top + 0.05 * s, pz, k === 1 ? MAT.vegDark : MAT.leaf, ry + a);
      }
      break;
    }
    case 2: {                                                          // a paste dish: three round dollops
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * Math.PI * 2;
        const [px, pz] = L(Math.cos(a) * 0.045 * s, Math.sin(a) * 0.045 * s);
        b.cyl(0.026 * s, 0.03 * s, 0.03 * s, 10, px, top + 0.015 * s, pz, MAT.paste);
        b.cyl(0.018 * s, 0.024 * s, 0.008, 10, px, top + 0.032 * s, pz, MAT.sear);
      }
      b.box(0.04 * s, 0.01, 0.02 * s, x, top + 0.04 * s, z, MAT.leaf, ry + 0.6);
      break;
    }
    case 3: {                                                          // a meat dish: a thick cut + sear marks + a garnish
      const [mx, mz] = L(-0.012 * s, 0);
      b.box(0.14 * s, 0.035 * s, 0.09 * s, mx, top + 0.0175 * s, mz, MAT.meat, ry + 0.25);
      b.box(0.1 * s, 0.004, 0.012 * s, mx, top + 0.037 * s, mz, MAT.sear, ry + 0.25);
      const [gx, gz] = L(0.07 * s, 0.045 * s);
      b.box(0.035 * s, 0.018 * s, 0.03 * s, gx, top + 0.009 * s, gz, MAT.leaf, ry);
      break;
    }
    default: {                                                         // a dairy dish: a cream-coloured round dish + a browned top
      b.cyl(0.075 * s, 0.09 * s, 0.035 * s, 18, x, top + 0.0175 * s, z, MAT.cream);
      b.cyl(0.055 * s, 0.07 * s, 0.01, 18, x, top + 0.037 * s, z, MAT.crust);
      break;
    }
  }
  if (normalizeMealQuality(quality) >= MEAL_QUALITY_MAX) {
    const [gx, gz] = L(0, -0.02 * s);
    b.box(0.014, 0.014, 0.014, gx, top + 0.07 * s, gz, MAT.gold, ry + Math.PI / 4, Math.PI / 4);   // the gold garnish (five stars)
  }
}

/** The plates on the shared ship's fixed dining table — every squadmate (`getTablePlates(null)`). More of them than place settings (`slots`) = from the front. */
export class TablePlates {
  private readonly group = new THREE.Group();
  private readonly meshes: THREE.Mesh[] = [];
  private labels: TextPlane[] = [];
  private key = '';
  private readonly offs: Array<() => void>;
  /** Smoke test: how many plates are on the table right now. */
  shown = 0;

  constructor(private readonly ctx: GameContext, parent: THREE.Object3D, private readonly slots: readonly TablePlateSlot[], private readonly yaw: number) {
    this.group.name = 'table-plates';
    parent.add(this.group);
    this.offs = [
      ctx.bus.on('housing:tablePlatesChanged', () => this.refresh()),
      ctx.bus.on('hub:entered', () => this.refresh()),
    ];
    this.refresh();
  }

  refresh(): void {
    let plates: ReturnType<NonNullable<NonNullable<GameContext['housing']>['getTablePlates']>> = [];
    try { plates = this.ctx.housing?.getTablePlates?.(null) ?? []; } catch { plates = []; }
    const list = plates.slice(0, this.slots.length);
    const key = list.map((p) => `${p.ownerId ?? 'me'}:${p.mealDefId}:${p.quality}:${p.ownerName}`).join('|');
    if (key === this.key) return;
    this.key = key;
    this.clear();
    const b = new GeoBatch();
    const ry = this.yaw;
    list.forEach((p, i) => {
      const slot = this.slots[i];
      addPlateToBatch(b, slot.position.x, slot.position.y, slot.position.z, p.mealDefId, p.quality, ry, false);
      // the cook's name tag — stood behind the place setting (toward the middle of the table), facing whoever sits at that spot (PlaneGeometry faces +Z)
      const tag = new TextPlane(0.3, 0.075, 256);
      const inward = -slot.side * 0.15;
      tag.mesh.position.set(slot.position.x + Math.sin(ry) * inward, slot.position.y + 0.1, slot.position.z + Math.cos(ry) * inward);
      tag.mesh.rotation.y = ry + (slot.side < 0 ? Math.PI : 0);
      tag.set([p.mine ? `${p.ownerName} (나)` : p.ownerName], p.mine ? '#ffc98a' : '#e8e6e1', 'rgba(6,8,10,0.78)');
      this.group.add(tag.mesh);
      this.labels.push(tag);
    });
    b.build(this.group, this.meshes, true, true);
    this.shown = list.length;
  }

  private clear(): void {
    disposeMeshes(this.meshes);
    for (const t of this.labels) { t.mesh.removeFromParent(); t.dispose(); }
    this.labels = [];
    this.shown = 0;
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.clear();
    this.group.removeFromParent();
  }
}
