import * as THREE from 'three';
import { COMPUTE_CLUSTER_MAX_CORES } from '@/shared';
import { GeoBatch, HUB_MATS as M } from './GeoBatch';
import type { Builder } from './Furniture';

/* ────────────────────────────────────────────────────────────────────────────
 * Mining facility furniture (2026-09-13, crypto mining — docs/DECISIONS.md 「2026-09-13 — 가구 접근 면 · 발전기 · 암호화폐 채굴」, agent ④).
 *
 *   • `compute_cluster` — the compute cluster: a slim server rack 2 cells wide × 1 deep × 1.9 m. **Both wide faces (local
 *     ±Z) are access faces** (`access = sides`), so the same 3 × 3 of core slots sits on the front and the back. As many
 *     slots light up as there are mounted cores (`BuildExtra.cores`, top row from the left); while mining
 *     (`BuildExtra.clusterMining`) each slot's status light is green, amber when stopped. Sides: cooling fins · cables; top: two fans.
 *   • `mining_computer` — the main computer: three monitors on a 3 × 2 cell desk (centre = a candle chart, left = a line chart,
 *     right = the quote list — all of them emissive bars), keyboard · mouse · the tower under the desk (a lit strip).
 *
 * Spread straight into `Furniture.ts`'s `BUILDERS` (the `Builder` shape of `FurnitureKitchen` · centred · floor y 0 · front −Z · `GeoBatch`).
 * **No light is ever created** — cores, status lights and screens are emissive materials only (CLAUDE.md 「never change the
 * point-light count at runtime」). The materials are module constants, so a rebuild for a changed core count creates and disposes
 * none (`GeoBatch.build` drops the source geometry after merging, `removePiece` the merged mesh); `mining-core-lit` is named for the smokes.
 * ──────────────────────────────────────────────────────────────────────────── */

function std(color: number, roughness: number, metalness: number, emissive = 0, emissiveIntensity = 0, name = ''): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color, roughness, metalness, emissive, emissiveIntensity });
  if (name) m.name = name;
  return m;
}

/** The lit core's emissive bar (cyan). */
export const MINING_CORE_LIT = std(0xa8e6ff, 0.3, 0.1, 0x3ab8ff, 2.2, 'mining-core-lit');
/** A mining core's status light (green). */
const CORE_OK = std(0xb4ffc8, 0.4, 0.1, 0x3aff7a, 2.0, 'mining-core-ok');
/** The dark bar of an empty slot. */
const CORE_OFF = std(0x12171d, 0.6, 0.3, 0, 0, 'mining-core-off');
/** The core module body. */
const CORE_BODY = std(0x3a4452, 0.42, 0.6);
/** Cables (blue · orange). */
const CABLE_BLUE = std(0x1f4a78, 0.7, 0.1);
const CABLE_ORANGE = std(0x9a5a22, 0.7, 0.1);
/** Monitor screen background (dimly emissive — so the chart bars laid over it read as floating). */
const SCREEN_BG = std(0x061019, 0.3, 0.2, 0x08222e, 0.9);
const CHART_UP = std(0x8ff5b0, 0.4, 0.1, 0x2fe07a, 1.9);
const CHART_DOWN = std(0xff9a8a, 0.4, 0.1, 0xff3a2a, 1.9);
const CHART_LINE = std(0xa8e6ff, 0.4, 0.1, 0x49c6ff, 2.0);
const SCREEN_TEXT = std(0xb8c6d4, 0.5, 0.1, 0x5a7890, 1.1);
const KEYCAP = std(0x3a3f46, 0.75, 0.2);

const MAX_CORES = Math.max(1, Math.floor(COMPUTE_CLUSTER_MAX_CORES));
const ALONG_X = Math.PI / 2;

/** Furniture-local (lx, lz) → the spot it lands on for a piece standing at (cx, cz) turned by ry — three's own Y rotation formula. */
function rotXZ(cx: number, cz: number, ry: number, lx: number, lz: number): [number, number] {
  const c = Math.cos(ry), s = Math.sin(ry);
  return [cx + lx * c + lz * s, cz - lx * s + lz * c];
}

/* ── compute cluster ────────────────────────────────────────────────────── */

/** One wide face (`s` = −1 front · +1 back): the 3 × 3 of core slots · the top band · the vent grille. */
function clusterFace(b: GeoBatch, w: number, d: number, s: -1 | 1, accent: THREE.Material, cores: number, mining: boolean): void {
  const zFace = s * (d / 2);
  const cols = 3, rows = Math.ceil(MAX_CORES / cols);
  const x0 = -(w / 2 - 0.08), bayW = (w - 0.16) / cols;
  const yTop = 1.62, yBot = 0.24, bayH = (yTop - yBot) / rows;
  for (let i = 0; i < MAX_CORES; i++) {
    const r = Math.floor(i / cols), c = i % cols;
    const cx = x0 + (c + 0.5) * bayW;
    const cy = yTop - (r + 0.5) * bayH;
    const lit = i < cores;
    b.box(bayW - 0.02, bayH - 0.025, 0.02, cx, cy, zFace - s * 0.05, M.hullDark);                              // slot surround (recessed)
    b.box(bayW - 0.07, bayH - 0.08, 0.03, cx, cy, zFace - s * 0.035, lit ? CORE_BODY : M.gunmetal);            // core module / blank cover
    b.box(bayW - 0.12, 0.035, 0.01, cx - 0.015, cy + bayH * 0.3, zFace - s * 0.016, lit ? MINING_CORE_LIT : CORE_OFF);   // emissive bar
    b.box(0.026, 0.026, 0.01, cx + bayW * 0.34, cy + bayH * 0.3, zFace - s * 0.016, lit ? (mining ? CORE_OK : M.stripAmber) : CORE_OFF);   // status light
    for (let k = 0; k < 3; k++) b.box(bayW - 0.12, 0.012, 0.008, cx, cy - 0.03 - k * 0.045, zFace - s * 0.017, lit ? M.hullDark : M.floorGrate);   // vent slits
  }
  b.box(w - 0.14, 0.05, 0.012, 0, 1.73, zFace - s * 0.02, accent);                                              // top band (the furniture colour)
  b.box(0.22, 0.028, 0.014, w / 2 - 0.2, 1.8, zFace - s * 0.02, mining ? CORE_OK : cores > 0 ? M.stripAmber : M.stripRed);   // rack status light
  b.box(w - 0.2, 0.09, 0.012, 0, 0.14, zFace - s * 0.02, M.floorGrate);                                        // lower vent grille
}

function computeCluster(b: GeoBatch, w: number, d: number, h: number, accent: THREE.Material, cores: number, mining: boolean): void {
  b.boxB(w, 0.08, d, 0, 0, 0, M.hullDark);                                                                       // plinth
  b.boxB(w - 0.1, h - 0.2, d - 0.12, 0, 0.08, 0, M.hullDark);                                                    // inner body
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.boxB(0.05, h - 0.14, 0.05, sx * (w / 2 - 0.025), 0.08, sz * (d / 2 - 0.025), M.gunmetal);   // posts
  b.box(w, 0.06, d, 0, h - 0.09, 0, M.gunmetal);                                                                 // top plate
  for (const sx of [-1, 1]) {
    const x = sx * (w / 2 - 0.012);
    b.box(0.02, h - 0.3, d - 0.1, x, h / 2, 0, M.hullLight);                                                     // side plate
    for (let k = 0; k < 11; k++) b.box(0.03, 0.018, d - 0.16, sx * (w / 2 + 0.004), 0.3 + k * 0.12, 0, M.gunmetal);   // cooling fins
    // cable bundles (aft · fore on the side face) + the loop crossing onto the top plate
    b.cyl(0.016, 0.016, h - 0.4, 6, sx * (w / 2 + 0.03), h / 2 - 0.05, -0.14, CABLE_BLUE);
    b.cyl(0.014, 0.014, h - 0.5, 6, sx * (w / 2 + 0.03), h / 2 - 0.1, 0.14, CABLE_ORANGE);
    b.box(0.03, 0.02, 0.3, sx * (w / 2 + 0.03), h - 0.2, 0, M.trimDark);
  }
  clusterFace(b, w, d, -1, accent, cores, mining);
  clusterFace(b, w, d, 1, accent, cores, mining);
  // the two top fans (frame · blades · lit centre hub)
  for (const sx of [-1, 1]) {
    const fx = sx * w * 0.24, fy = h - 0.05;
    b.cyl(0.17, 0.17, 0.035, 22, fx, fy, 0, M.gunmetal);
    for (const a of [0.4, 0.4 + Math.PI / 2, 0.4 + Math.PI / 4, 0.4 + (3 * Math.PI) / 4]) b.box(0.28, 0.008, 0.045, fx, fy + 0.022, 0, M.hullLight, a);
    b.cyl(0.045, 0.045, 0.04, 12, fx, fy + 0.025, 0, M.stripCyan);
  }
}

/* ── main computer ──────────────────────────────────────────────────────── */

type ScreenKind = 'candle' | 'line' | 'list';

/** One monitor — stand · neck · bezel · screen + the emissive chart bars over it. (cx, cy, cz) = bezel centre, ry = facing (front = −Z). */
function monitor(b: GeoBatch, T: number, cx: number, cy: number, cz: number, ry: number, kind: ScreenKind, accent: THREE.Material): void {
  const SW = 0.5, SH = 0.3;
  const at = (lx: number, lz: number): [number, number] => rotXZ(cx, cz, ry, lx, lz);
  const [nx, nz] = at(0, 0.06);
  b.boxB(0.05, cy - T - 0.1, 0.04, nx, T + 0.02, nz, M.gunmetal, ry);                                           // neck
  b.box(0.22, 0.016, 0.15, nx, T + 0.028, nz, M.gunmetal, ry);                                                  // stand
  b.box(SW + 0.04, SH + 0.04, 0.03, cx, cy, cz, M.hullDark, ry);                                                // bezel
  const [sx, sz] = at(0, -0.016);
  b.box(SW, SH, 0.004, sx, cy, sz, SCREEN_BG, ry);                                                             // screen
  const [hx, hz] = at(0, -0.02);
  b.box(SW - 0.04, 0.018, 0.002, hx, cy + SH / 2 - 0.03, hz, accent, ry);                                       // screen top band
  const zf = -0.021;
  if (kind === 'candle') {
    const n = 12, span = SW - 0.08;
    let prev = 0;
    for (let i = 0; i < n; i++) {
      const lx = -span / 2 + (i + 0.5) * (span / n);
      const mid = Math.sin(i * 0.9) * 0.04 + i * 0.006 - 0.03;
      const up = mid >= prev;
      const bh = 0.025 + Math.abs(Math.sin(i * 1.7)) * 0.04;
      const [px, pz] = at(lx, zf);
      b.box(0.004, bh + 0.035, 0.002, px, cy - 0.01 + mid, pz, up ? CHART_UP : CHART_DOWN, ry);                  // wick
      b.box(0.022, bh, 0.002, px, cy - 0.01 + mid, pz, up ? CHART_UP : CHART_DOWN, ry);                          // body
      prev = mid;
    }
  } else if (kind === 'line') {
    const n = 11, span = SW - 0.08;
    const pt = (i: number): [number, number] => [-span / 2 + (i / (n - 1)) * span, Math.sin(i * 0.8) * 0.045 + Math.cos(i * 0.37) * 0.025 + i * 0.005 - 0.04];
    for (let i = 0; i < n - 1; i++) {
      const [x1, y1] = pt(i), [x2, y2] = pt(i + 1);
      const len = Math.hypot(x2 - x1, y2 - y1);
      const [px, pz] = at((x1 + x2) / 2, zf);
      b.box(len + 0.004, 0.008, 0.002, px, cy - 0.02 + (y1 + y2) / 2, pz, CHART_LINE, ry, 0, Math.atan2(y2 - y1, x2 - x1));
    }
    const [gx, gz] = at(0, zf + 0.001);
    b.box(SW - 0.08, 0.003, 0.001, gx, cy - 0.1, gz, SCREEN_TEXT, ry);                                          // baseline
  } else {
    for (let r = 0; r < 6; r++) {
      const ly = cy + SH / 2 - 0.075 - r * 0.036;
      const up = Math.sin(r * 2.3) > 0;
      const [ax, az] = at(-SW / 2 + 0.05, zf);
      b.box(0.018, 0.018, 0.002, ax, ly, az, r % 3 === 0 ? M.stripAmber : M.stripCyan, ry);                     // coin glyph
      const [tx, tz] = at(-0.06, zf);
      b.box(0.2, 0.009, 0.002, tx, ly, tz, SCREEN_TEXT, ry);                                                    // name
      const [vx, vz] = at(SW / 2 - 0.08, zf);
      b.box(0.08, 0.011, 0.002, vx, ly, vz, up ? CHART_UP : CHART_DOWN, ry);                                     // change %
    }
  }
}

function miningComputer(b: GeoBatch, w: number, d: number, h: number, accent: THREE.Material, level: number): void {
  const T = 0.74;
  const dd = Math.min(0.78, d - 0.1), dz = d / 2 - dd / 2 - 0.04;                                               // the desk sits against the back
  b.box(w, 0.05, dd, 0, T, dz, M.gunmetal);                                                                     // top
  b.box(w - 0.04, 0.012, dd - 0.04, 0, T + 0.03, dz, M.hullLight);
  b.box(w - 0.1, 0.022, 0.02, 0, T - 0.01, dz - dd / 2 + 0.005, accent);                                        // front edge band
  for (const sx of [-1, 1]) b.boxB(0.05, T - 0.025, dd - 0.06, sx * (w / 2 - 0.05), 0, dz, M.hullDark);          // side panel legs
  b.boxB(w - 0.14, 0.42, 0.03, 0, 0.26, dz + dd / 2 - 0.05, M.hullDark);                                         // back panel
  // the tower under the desk (right): vent grille · vertical lit strip · power button
  const tx = w / 2 - 0.22, tz = dz - 0.04;
  b.boxB(0.22, 0.54, 0.5, tx, 0, tz, M.hullLight);
  b.box(0.15, 0.3, 0.008, tx + 0.02, 0.3, tz - 0.254, M.floorGrate);
  b.box(0.018, 0.42, 0.008, tx - 0.075, 0.28, tz - 0.254, M.stripCyan);
  b.cyl(0.018, 0.018, 0.01, 10, tx + 0.02, 0.49, tz - 0.254, level > 0 ? CORE_OK : CORE_OFF, ALONG_X);
  // the three monitors — the centre one faces front, the outer two turn inward toward it (front −Z; left = −X is a negative yaw)
  const my = T + 0.42, mz = dz + dd / 2 - 0.2;
  monitor(b, T, 0, my, mz, 0, 'candle', accent);
  monitor(b, T, -0.55, my - 0.01, mz - 0.1, -0.42, 'line', accent);
  monitor(b, T, 0.55, my - 0.01, mz - 0.1, 0.42, 'list', accent);
  // keyboard · mouse · cup
  const kz = dz - dd / 2 + 0.2;
  b.box(0.46, 0.02, 0.16, 0, T + 0.045, kz, M.gunmetal);
  for (let r = 0; r < 4; r++) b.box(0.42, 0.01, 0.026, 0, T + 0.06, kz - 0.052 + r * 0.035, KEYCAP);
  b.box(0.1, 0.004, 0.02, 0.17, T + 0.066, kz - 0.052, M.stripCyan);                                            // lit key row
  b.box(0.055, 0.024, 0.085, 0.34, T + 0.045, kz, M.hullLight);                                                  // mouse
  b.cyl(0.035, 0.03, 0.085, 12, -0.5, T + 0.07, kz + 0.02, M.trim);                                              // cup
  // tower → the cable behind the desk
  b.cyl(0.012, 0.012, 0.3, 6, tx - 0.02, 0.69, tz + 0.2, CABLE_BLUE);
}

export type MiningKind = 'compute_cluster' | 'mining_computer';

export const MINING_BUILDERS: Readonly<Record<MiningKind, Builder>> = {
  compute_cluster: (b, w, d, h, a, _lv, extra) => {
    const cores = Math.max(0, Math.min(MAX_CORES, Math.floor(extra?.cores ?? 0)));
    computeCluster(b, w, d, h, a, cores, !!extra?.clusterMining && cores > 0);
  },
  mining_computer: (b, w, d, h, a, lv) => miningComputer(b, w, d, h, a, lv),
};
