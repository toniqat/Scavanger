import * as THREE from 'three';
import { GeoBatch, HUB_MATS as M } from './GeoBatch';
import type { BoxInteriorCollider } from './InteriorCollider';

/* ────────────────────────────────────────────────────────────────────────────
 * Ship stations (tactical kit): repair bench, implant bay, ship computer.
 * All static geometry goes through the interior's `GeoBatch`, so a station costs
 * **zero extra draw calls** (it merges into the existing per-material meshes).
 *
 * Phase 8 (2026-09-06): the hydroponics rack and `hub/GardenStation` are gone — 재배 lives in the 온실 room
 * (`furn_grow_rack` furniture → `ctx.housing.openGrowMenu`). The personal ship also lost its built-in repair
 * bench (`furn_repair_bench` furniture in the 작업실); only the shared ship still models one.
 *
 * Local frame (matching `parts.ts`): local +X → (cos ry, −sin ry), local +Z → (sin ry, cos ry),
 * so the *front* (toward the player) is local −Z = (−sin ry, −cos ry).
 * ──────────────────────────────────────────────────────────────────────────── */

/** A station the player can walk up to. `position` is the deck-level interaction anchor in front of it. */
export interface StationDef {
  position: THREE.Vector3;
  yaw: number;
}

/** Every station an interior offers. `bench` only exists where the ship still has a built-in repair bench. */
export interface ShipStations {
  bench?: StationDef;
  implantBay: StationDef;
}

const lx = (x: number, ry: number, ox: number, oz: number): number => x + Math.cos(ry) * ox + Math.sin(ry) * oz;
const lz = (z: number, ry: number, ox: number, oz: number): number => z - Math.sin(ry) * ox + Math.cos(ry) * oz;

/** World AABB size of a prop `w × d` (local) rotated by `ry`, for `col.addBox`. */
function footprint(ry: number, w: number, d: number): [number, number] {
  const c = Math.abs(Math.cos(ry)), s = Math.abs(Math.sin(ry));
  return [c * w + s * d, s * w + c * d];
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

/* ── 함선 컴퓨터 (ship computer, Phase 5) ─────────────────────────────────── */
/** Desk + two monitors. The left monitor is an emissive `TextPlane` (`기업 네트워크`) the caller adds at `screenPos / screenRot`. */
export interface ComputerStationDef extends StationDef {
  screenPos: THREE.Vector3;
  screenRot: THREE.Euler;
}

const DESK_W = 1.5;
const DESK_D = 0.65;
const DESK_H = 0.76;
/** Monitor tilt (top away from the user). */
const MON_TILT = 0.14;

/**
 * Ship computer against a wall (back = local +Z, front toward the room): steel desk with a drawer block and a PC
 * tower, keyboard + mouse, two tilted monitors on stands (right = emissive cyan panel, left = the caller's
 * `TextPlane`), a chair tucked under the front edge and a cyan lamp strip on the wall above. One collider box
 * covers desk + chair. Returns the interaction anchor 0.9 m in front of the chair.
 */
export function shipComputer(b: GeoBatch, col: BoxInteriorCollider, x: number, z: number, ry: number): ComputerStationDef {
  const fx = -Math.sin(ry), fz = -Math.cos(ry);
  const W = DESK_W, D = DESK_D, H = DESK_H;
  const L = (ox: number, oz: number): [number, number] => [lx(x, ry, ox, oz), lz(z, ry, ox, oz)];

  // desk: top (dark frame + light surface + amber front edge), side panels, modesty panel
  b.box(W, 0.05, D, x, H - 0.025, z, M.gunmetal, ry);
  b.box(W - 0.04, 0.02, D - 0.06, x, H + 0.01, z, M.hullLight, ry);
  { const [px, pz] = L(0, -(D / 2 - 0.02)); b.box(W - 0.1, 0.03, 0.03, px, H - 0.05, pz, M.stripAmber, ry); }
  for (const ox of [-(W / 2 - 0.03), W / 2 - 0.03]) { const [px, pz] = L(ox, 0); b.boxB(0.06, H - 0.05, D - 0.05, px, 0, pz, M.hullDark, ry); }
  { const [px, pz] = L(0, D / 2 - 0.03); b.box(W - 0.12, 0.42, 0.03, px, H - 0.27, pz, M.hullDark, ry); }
  // drawer block (right) with three handles, PC tower (left) with a power LED
  { const [px, pz] = L(W / 2 - 0.27, 0.02); b.boxB(0.44, H - 0.08, D - 0.1, px, 0, pz, M.hullDark, ry); }
  for (let k = 0; k < 3; k++) { const [px, pz] = L(W / 2 - 0.27, -(D / 2 - 0.06)); b.box(0.3, 0.03, 0.02, px, 0.16 + k * 0.2, pz, M.trim, ry); }
  { const [px, pz] = L(-(W / 2 - 0.2), 0.05); b.boxB(0.2, 0.46, 0.46, px, 0.02, pz, M.gunmetal, ry); }
  { const [px, pz] = L(-(W / 2 - 0.2), -(D / 2 - 0.12)); b.box(0.12, 0.02, 0.02, px, 0.42, pz, M.stripAmber, ry); }
  // keyboard + mouse
  { const [px, pz] = L(-0.1, -(D / 2 - 0.15)); b.box(0.46, 0.02, 0.16, px, H + 0.03, pz, M.hullDark, ry); }
  { const [px, pz] = L(0.28, -(D / 2 - 0.16)); b.box(0.06, 0.025, 0.1, px, H + 0.03, pz, M.hullLight, ry); }

  // two monitors on stands near the back of the desk (frame tilted `MON_TILT`, top away from the user)
  const mz = D / 2 - 0.16, my = H + 0.44;
  for (const ox of [-0.38, 0.38]) {
    const [px, pz] = L(ox, mz);
    b.box(0.22, 0.02, 0.16, px, H + 0.03, pz, M.gunmetal, ry);
    b.box(0.05, 0.22, 0.04, px, H + 0.14, pz, M.gunmetal, ry);
    b.box(0.64, 0.42, 0.035, px, my, pz, M.hullDark, ry, MON_TILT);
  }
  // tilted screen normal (toward the user, up), the screen's own up vector and its sideways axis (local +X)
  const nx = fx * Math.cos(MON_TILT), ny = Math.sin(MON_TILT), nz = fz * Math.cos(MON_TILT);
  const ux = -fx * Math.sin(MON_TILT), uy = Math.cos(MON_TILT), uz = -fz * Math.sin(MON_TILT);
  const sxv = Math.cos(ry), szv = -Math.sin(ry);
  // right monitor: emissive panel + a dark title bar and two cyan "text" lines
  {
    const [px, pz] = L(0.38, mz);
    b.box(0.58, 0.36, 0.012, px + nx * 0.02, my + ny * 0.02, pz + nz * 0.02, M.screen, ry, MON_TILT);
    b.box(0.5, 0.035, 0.012, px + nx * 0.03 + ux * 0.13, my + ny * 0.03 + uy * 0.13, pz + nz * 0.03 + uz * 0.13, M.hullDark, ry, MON_TILT);
    b.box(0.3, 0.018, 0.012, px + nx * 0.03 + ux * 0.04 - sxv * 0.08, my + ny * 0.03 + uy * 0.04, pz + nz * 0.03 + uz * 0.04 - szv * 0.08, M.stripCyan, ry, MON_TILT);
    b.box(0.22, 0.018, 0.012, px + nx * 0.03 - ux * 0.02 - sxv * 0.12, my + ny * 0.03 - uy * 0.02, pz + nz * 0.03 - uz * 0.02 - szv * 0.12, M.stripCyan, ry, MON_TILT);
  }
  // left monitor: the caller's TextPlane (PlaneGeometry faces +Z → yaw by ry + π to face the user, −tilt = top away)
  const [sx, sz] = L(-0.38, mz);
  const screenPos = new THREE.Vector3(sx + nx * 0.02, my + ny * 0.02, sz + nz * 0.02);
  const screenRot = new THREE.Euler(-MON_TILT, ry + Math.PI, 0, 'YXZ');

  // chair tucked under the front edge (backrest toward the user)
  const cz = -(D / 2 + 0.2);
  { const [px, pz] = L(0, cz); b.cyl(0.26, 0.3, 0.04, 12, px, 0.02, pz, M.gunmetal); b.cyl(0.03, 0.03, 0.4, 8, px, 0.24, pz, M.gunmetal); b.box(0.48, 0.07, 0.48, px, 0.47, pz, M.padding, ry); }
  { const [px, pz] = L(0, cz - 0.21); b.box(0.46, 0.5, 0.06, px, 0.78, pz, M.padding, ry); }
  // lamp strip on the wall above the monitors
  { const [px, pz] = L(0, D / 2 + 0.02); b.box(W - 0.3, 0.05, 0.04, px, 1.75, pz, M.stripCyan, ry); }

  // one collider box: desk + chair
  const [fw, fd] = footprint(ry, W + 0.04, D + 0.5);
  const [cx, czw] = L(0, -0.25);
  col.addBox(cx, 0, czw, fw, 1.3, fd);

  const reach = D / 2 + 0.25 + 0.9;
  return { position: new THREE.Vector3(x + fx * reach, 0, z + fz * reach), yaw: ry, screenPos, screenRot };
}
