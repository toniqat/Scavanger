import * as THREE from 'three';
import { GeoBatch, HUB_MATS as M } from './GeoBatch';
import type { BoxInteriorCollider } from './InteriorCollider';

/* ────────────────────────────────────────────────────────────────────────────
 * Ship stations (tactical kit): hydroponics garden, repair bench, implant bay.
 * All static geometry goes through the interior's `GeoBatch`, so a station costs
 * **zero extra draw calls** (it merges into the existing per-material meshes; the
 * grow-light / soil materials add one merged mesh each). Only the garden's living
 * plants are dynamic — one `InstancedMesh` owned by `hub/GardenStation`.
 *
 * Local frame (matching `parts.ts`): local +X → (cos ry, −sin ry), local +Z → (sin ry, cos ry),
 * so the *front* (toward the player) is local −Z = (−sin ry, −cos ry).
 * ──────────────────────────────────────────────────────────────────────────── */

/** A station the player can walk up to. `position` is the deck-level interaction anchor in front of it. */
export interface StationDef {
  position: THREE.Vector3;
  yaw: number;
}

/** Hydroponics rack: `plots` are the world positions where a plant grows (tray surface). */
export interface GardenStationDef extends StationDef {
  plots: THREE.Vector3[];
}

/** Every station an interior offers. */
export interface ShipStations {
  garden: GardenStationDef;
  bench: StationDef;
  implantBay: StationDef;
}

const lx = (x: number, ry: number, ox: number, oz: number): number => x + Math.cos(ry) * ox + Math.sin(ry) * oz;
const lz = (z: number, ry: number, ox: number, oz: number): number => z - Math.sin(ry) * ox + Math.cos(ry) * oz;

/** World AABB size of a prop `w × d` (local) rotated by `ry`, for `col.addBox`. */
function footprint(ry: number, w: number, d: number): [number, number] {
  const c = Math.abs(Math.cos(ry)), s = Math.abs(Math.sin(ry));
  return [c * w + s * d, s * w + c * d];
}

/* ── 수경 재배 스테이션 (hydroponics) ─────────────────────────────────────── */
const GARDEN_W = 2.2;
const GARDEN_D = 0.72;
const GARDEN_H = 2.15;
/** Local X offsets of the three plots on each shelf. */
const PLOT_X = [-0.68, 0, 0.68];
/** Tray surface heights (lower shelf, upper shelf). */
const SHELF_Y = [0.92, 1.56];

/**
 * Two-shelf hydroponics rack against a wall: cabinet, soil trays, magenta grow-lights, canopy.
 * Returns the 6 plot positions (bottom-left → top-right) and the interaction anchor.
 */
export function hydroponics(b: GeoBatch, col: BoxInteriorCollider, x: number, z: number, ry: number): GardenStationDef {
  const fx = -Math.sin(ry), fz = -Math.cos(ry);
  const W = GARDEN_W, D = GARDEN_D, H = GARDEN_H;

  // cabinet + posts + canopy
  b.boxB(W, 0.78, D, x, 0, z, M.hullDark, ry);
  b.box(W + 0.06, 0.06, D + 0.04, lx(x, ry, 0, 0), 0.8, lz(z, ry, 0, 0), M.trimDark, ry);
  for (const ox of [-(W / 2 - 0.05), W / 2 - 0.05]) {
    b.boxB(0.1, H, D, lx(x, ry, ox, 0), 0, lz(z, ry, ox, 0), M.hullLight, ry);
  }
  b.box(W, 0.12, D, x, H, z, M.hullLight, ry);
  b.box(0.1, H - 0.8, D, lx(x, ry, 0, D / 2 - 0.05), (H + 0.8) / 2, lz(z, ry, 0, D / 2 - 0.05), M.hullDark, ry);   // back panel

  // shelves: tray + soil + a rail so plants read as contained
  for (let s = 0; s < SHELF_Y.length; s++) {
    const y = SHELF_Y[s];
    b.box(W - 0.18, 0.05, D - 0.1, x, y - 0.055, z, M.hullLight, ry);
    b.box(W - 0.3, 0.07, D - 0.26, x, y - 0.015, z, M.soil, ry);
    b.box(W - 0.28, 0.06, 0.04, lx(x, ry, 0, -(D / 2 - 0.12)), y + 0.02, lz(z, ry, 0, -(D / 2 - 0.12)), M.trimDark, ry);
    // grow-light strip above this shelf (under the next shelf / the canopy)
    const lightY = s + 1 < SHELF_Y.length ? SHELF_Y[s + 1] - 0.1 : H - 0.09;
    b.box(W - 0.34, 0.045, 0.14, x, lightY, z, M.stripGrow, ry);
  }
  // label strip on the canopy front
  b.box(W - 0.5, 0.07, 0.04, lx(x, ry, 0, -(D / 2 + 0.02)), H + 0.12, lz(z, ry, 0, -(D / 2 + 0.02)), M.stripAmber, ry);

  const [fw, fd] = footprint(ry, W, D);
  col.addBox(x, 0, z, fw, H, fd);

  const plots: THREE.Vector3[] = [];
  for (const y of SHELF_Y) {
    for (const ox of PLOT_X) plots.push(new THREE.Vector3(lx(x, ry, ox, 0), y, lz(z, ry, ox, 0)));
  }
  return { position: new THREE.Vector3(x + fx * (D / 2 + 0.95), 0, z + fz * (D / 2 + 0.95)), yaw: ry, plots };
}

/* ── 정비대 (repair bench) ────────────────────────────────────────────────── */
/**
 * Workbench with a vise and a wall tool board. `withTable` false reuses an existing bench
 * (the shared ship already models one) and only adds the board + anchor.
 */
export function repairBench(b: GeoBatch, col: BoxInteriorCollider, x: number, z: number, ry: number, withTable = true): StationDef {
  const fx = -Math.sin(ry), fz = -Math.cos(ry);
  const W = 2.0, D = 0.85;

  if (withTable) {
    b.boxB(W, 0.88, D, x, 0, z, M.hullDark, ry);
    b.box(W + 0.1, 0.06, D + 0.06, x, 0.91, z, M.gunmetal, ry);
    b.box(W - 0.2, 0.04, 0.05, lx(x, ry, 0, -(D / 2 + 0.02)), 0.7, lz(z, ry, 0, -(D / 2 + 0.02)), M.stripAmber, ry);
    const [fw, fd] = footprint(ry, W, D);
    col.addBox(x, 0, z, fw, 1.2, fd);
  }
  // vise (clamped to the left edge) + spare-parts bin on the top
  b.boxB(0.26, 0.24, 0.3, lx(x, ry, -0.95, 0), 0.94, lz(z, ry, -0.95, 0), M.gunmetal, ry);
  b.boxB(0.16, 0.1, 0.26, lx(x, ry, -0.95, -0.16), 1.18, lz(z, ry, -0.95, -0.16), M.trim, ry);
  b.boxB(0.42, 0.2, 0.3, lx(x, ry, 0.72, 0), 0.94, lz(z, ry, 0.72, 0), M.crateDark, ry);

  // wall tool board behind the bench (back = local +Z)
  const bz = D / 2 + 0.03;
  b.box(1.7, 0.95, 0.05, lx(x, ry, 0, bz), 1.78, lz(z, ry, 0, bz), M.hullDark, ry);
  for (let i = 0; i < 5; i++) {
    const ox = -0.66 + i * 0.33;
    b.box(0.07, 0.42 + (i % 2) * 0.18, 0.06, lx(x, ry, ox, bz - 0.05), 1.86, lz(z, ry, ox, bz - 0.05), i % 2 ? M.gunmetal : M.hullLight, ry);
  }
  b.box(1.7, 0.05, 0.05, lx(x, ry, 0, bz - 0.04), 2.3, lz(z, ry, 0, bz - 0.04), M.stripCyan, ry);

  return { position: new THREE.Vector3(x + fx * (D / 2 + 0.95), 0, z + fz * (D / 2 + 0.95)), yaw: ry };
}

/* ── 임플란트 시술대 (implant bay) ────────────────────────────────────────── */
/** Reclined surgical chair with a scanner canopy on an arm. */
export function implantBay(b: GeoBatch, col: BoxInteriorCollider, x: number, z: number, ry: number): StationDef {
  const fx = -Math.sin(ry), fz = -Math.cos(ry);
  const W = 0.9, D = 1.55;

  b.cyl(0.34, 0.44, 0.22, 14, x, 0.11, z, M.hullDark);
  b.boxB(0.16, 0.42, 0.4, x, 0.22, z, M.gunmetal, ry);
  // seat pad (slightly reclined) + backrest toward the back of the bay
  b.box(0.72, 0.14, 1.0, lx(x, ry, 0, -0.12), 0.68, lz(z, ry, 0, -0.12), M.padding, ry, -0.12);
  b.box(0.72, 0.12, 0.72, lx(x, ry, 0, 0.5), 0.92, lz(z, ry, 0, 0.5), M.padding, ry, -0.9);
  b.box(0.8, 0.06, 1.1, lx(x, ry, 0, -0.12), 0.6, lz(z, ry, 0, -0.12), M.hullDark, ry, -0.12);
  // canopy arm + scanner head
  b.boxB(0.14, 1.55, 0.14, lx(x, ry, 0, D / 2 - 0.1), 0, lz(z, ry, 0, D / 2 - 0.1), M.hullLight, ry);
  b.box(0.62, 0.14, 0.66, lx(x, ry, 0, 0.28), 1.62, lz(z, ry, 0, 0.28), M.hullLight, ry);
  b.box(0.46, 0.05, 0.5, lx(x, ry, 0, 0.28), 1.53, lz(z, ry, 0, 0.28), M.stripCyan, ry);
  // instrument tray beside the chair
  b.boxB(0.34, 0.72, 0.34, lx(x, ry, -0.62, 0.2), 0, lz(z, ry, -0.62, 0.2), M.hullDark, ry);
  b.box(0.4, 0.05, 0.4, lx(x, ry, -0.62, 0.2), 0.74, lz(z, ry, -0.62, 0.2), M.trimDark, ry);

  const [fw, fd] = footprint(ry, W + 0.5, D);
  col.addBox(lx(x, ry, -0.1, 0.05), 0, lz(z, ry, -0.1, 0.05), fw, 1.7, fd);

  return { position: new THREE.Vector3(x + fx * (D / 2 + 0.85), 0, z + fz * (D / 2 + 0.85)), yaw: ry };
}
