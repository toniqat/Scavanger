import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * src/extraction/ShipGreebles.ts — **surface greebles on the dropship hull** (2026-09-15, TODO D-8, user's decision
 * 「merged-geometry greebles」).
 *
 * The question this file answers: *what was added to a hull that read as flat and angular up close, and why none of
 * it touches render cost, colliders or riding.*
 *
 * - **Panel seams · rivet strips · pipes/conduits · louvred vents · intakes · access hatches · antennas · nacelle ribs
 *   · cockpit window frames** are built from thin boxes and cylinders and **merged into one geometry per material**
 *   (`mergeGeometries`) — draw calls grow only by the number of materials (at most 4).
 * - Materials are the instances `Ship.ts` already holds (`hull` · `hullDark` · `accent` · `glass`): **no new shader
 *   program, no texture, no light** (the scene point-light count rule — `smoke-lights`).
 * - Everything sits **on the outer shell only**. Thickness is a few cm above the surface (≤ 0.1 m apart from pipes and
 *   antennas), so the silhouette does not change, and nothing intrudes into `Hull.ts`'s eight shell boxes, the deck
 *   plane (`floorYAt`), the bay (x ±1.72, y 0..2.72, z −5.3..0.6), the arc the ramp swings through (radius 3.05 about
 *   the hinge at (y 0, z 0.25), |x| ≤ 1.66) or the rear opening. That is why nothing is attached to the rear face
 *   (z 0.6) — the rear band of the side plates (|x| 1.6..2.1) is too close to the ramp edge.
 *
 * Coordinates are `Ship.ts`'s hull-local frame (−Z = nose, +Z = ramp, deck origin y 0). Outline: side plate outer face
 * x ±2.1 · roof top y 3.0 · upper deck (x ±1.5, y 2.95..3.55) · spine (x ±0.4, y 3.35..3.85, z −8.3..1.1) · belly
 * underside y −0.3 · wings (x 1.7..4.3, y 2.19..2.41, z −4.5..−1.9) · nacelles (x ±4.2, z −3.2, radius 1.05→0.95,
 * y 0.1..3.7) · nose (square frustum, half width 1.06 @ z −6.5 → 1.45 @ z −9.7, centre y 1.45) · chin (x ±1.3,
 * y 0..0.7) · tail fins (x ±1.4, y 4.1, z 0.2, rz ∓0.45) · horizontal tail (y 3.84..3.96, z −0.4..1.0).
 * These are pure model dimensions, so they are not moved into `data/*.csv` (same treatment as the rest of `Ship.ts`).
 */

export interface GreebleMaterials {
  hull: THREE.Material;
  hullDark: THREE.Material;
  accent: THREE.Material;
  glass: THREE.Material;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);

/** Per-material geometry accumulator; placements may be expressed in a tilted parent frame (cockpit glass, tail fin). */
class GreebleBatch {
  private readonly groups = new Map<THREE.Material, THREE.BufferGeometry[]>();
  /** When set, the next placements are local to this frame (ship-local matrix of a rotated hull part). */
  frame: THREE.Matrix4 | null = null;

  private add(mat: THREE.Material, g: THREE.BufferGeometry, x: number, y: number, z: number, rx: number, ry: number, rz: number): void {
    _e.set(rx, ry, rz);
    _q.setFromEuler(_e);
    _m.compose(_p.set(x, y, z), _q, _s);
    if (this.frame) _m.premultiply(this.frame);
    g.applyMatrix4(_m);
    let list = this.groups.get(mat);
    if (!list) { list = []; this.groups.set(mat, list); }
    list.push(g);
  }

  box(mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): void {
    this.add(mat, new THREE.BoxGeometry(w, h, d), x, y, z, rx, ry, rz);
  }
  /** Cylinder along its local Y (rotate with rx / rz to lay it down). */
  cyl(mat: THREE.Material, rTop: number, rBot: number, h: number, seg: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): void {
    this.add(mat, new THREE.CylinderGeometry(rTop, rBot, h, seg, 1), x, y, z, rx, ry, rz);
  }
  torus(mat: THREE.Material, r: number, tube: number, x: number, y: number, z: number, rx = 0): void {
    this.add(mat, new THREE.TorusGeometry(r, tube, 6, 24), x, y, z, rx, 0, 0);
  }

  /** Merge each material's pieces into one mesh under `parent`; the merged geometry goes to `keep` (the owner disposes it). */
  build(parent: THREE.Object3D, keep: (g: THREE.BufferGeometry) => void): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const [mat, list] of this.groups) {
      const merged = list.length > 0 ? mergeGeometries(list, false) : null;
      for (const g of list) g.dispose();
      if (!merged) continue;
      keep(merged);
      const mesh = new THREE.Mesh(merged, mat);
      mesh.name = 'ship-greebles';
      mesh.matrixAutoUpdate = false;        // identity in the ship frame; matrixWorld still follows `body`
      parent.add(mesh);
      out.push(mesh);
    }
    this.groups.clear();
    return out;
  }
}

/** Rivet pointing along ±X (on a side face). */
function rivetX(b: GreebleBatch, mat: THREE.Material, x: number, y: number, z: number): void {
  b.cyl(mat, 0.022, 0.022, 0.03, 6, x, y, z, 0, 0, Math.PI / 2);
}
/** Rivet pointing up (+Y). */
function rivetY(b: GreebleBatch, mat: THREE.Material, x: number, y: number, z: number): void {
  b.cyl(mat, 0.02, 0.02, 0.03, 6, x, y, z);
}

/** Nacelle skin radius at ship-local height `y` (the cylinder tapers 1.05 → 0.95 over y 0.1..3.7). */
const nacelleR = (y: number): number => 1.05 - ((y - 0.1) / 3.6) * 0.1;
/** Nose side half-width at ship-local `z` (4-sided frustum, 1.06 at z −6.5 → 1.45 at z −9.7). */
const noseHalf = (z: number): number => 1.5 / Math.SQRT2 + ((-6.5 - z) / 3.2) * ((2.05 - 1.5) / Math.SQRT2);

/**
 * Build every greeble into `parent` (the ship's `body`), merged per material. Returns the merged meshes; their geometries are
 * handed to `keep` so the ship's own dispose list owns them.
 */
export function buildShipGreebles(parent: THREE.Object3D, mats: GreebleMaterials, keep: (g: THREE.BufferGeometry) => void): THREE.Mesh[] {
  const { hull, hullDark, accent, glass } = mats;
  const b = new GreebleBatch();

  for (const sx of [-1, 1]) {
    // ── Side slabs (outer face x ±2.1, y −0.3..3.0, z −6.6..0.6) ──────────────────────────────────────
    const fx = sx * 2.108;                                   // thin strips, 5 mm sunk into the skin
    // Rivet band along the waist, two rows of rivets on it.
    b.box(hullDark, 0.03, 0.12, 6.9, sx * 2.11, 1.25, -3.05);
    for (let z = -6.3; z <= 0.31; z += 0.4) {
      rivetX(b, hull, sx * 2.13, 1.215, z);
      rivetX(b, hull, sx * 2.13, 1.285, z);
    }
    // Horizontal panel seams (low belt, above the wing root).
    b.box(hullDark, 0.025, 0.04, 6.9, fx, 0.35, -3.05);
    b.box(hullDark, 0.025, 0.04, 6.9, fx, 2.75, -3.05);
    // Vertical panel seams.
    for (const z of [-5.0, -3.75, -2.0, -0.15]) b.box(hullDark, 0.025, 3.1, 0.04, fx, 1.3, z);
    // Front access hatch (frame + handle + corner rivets).
    {
      const hz = -5.75, hy = 0.85, hw = 0.8, hh = 0.5;
      b.box(hullDark, 0.03, 0.05, hw, sx * 2.11, hy + hh / 2, hz);
      b.box(hullDark, 0.03, 0.05, hw, sx * 2.11, hy - hh / 2, hz);
      b.box(hullDark, 0.03, hh + 0.05, 0.05, sx * 2.11, hy, hz - hw / 2);
      b.box(hullDark, 0.03, hh + 0.05, 0.05, sx * 2.11, hy, hz + hw / 2);
      b.box(accent, 0.04, 0.06, 0.22, sx * 2.12, hy, hz);
      for (const dy of [-0.17, 0.17]) for (const dz of [-0.3, 0.3]) rivetX(b, hull, sx * 2.12, hy + dy, hz + dz);
    }
    // Rear upper hatch with a warning plate above it.
    {
      const hz = -1.0, hy = 1.75, hw = 0.8, hh = 0.5;
      b.box(hullDark, 0.03, 0.05, hw, sx * 2.11, hy + hh / 2, hz);
      b.box(hullDark, 0.03, 0.05, hw, sx * 2.11, hy - hh / 2, hz);
      b.box(hullDark, 0.03, hh + 0.05, 0.05, sx * 2.11, hy, hz - hw / 2);
      b.box(hullDark, 0.03, hh + 0.05, 0.05, sx * 2.11, hy, hz + hw / 2);
      b.box(accent, 0.02, 0.08, 0.3, sx * 2.11, hy + hh / 2 + 0.08, hz);
      for (const dy of [-0.17, 0.17]) for (const dz of [-0.3, 0.3]) rivetX(b, hull, sx * 2.12, hy + dy, hz + dz);
    }
    // Louvred side vent.
    b.box(hullDark, 0.02, 0.4, 1.0, sx * 2.105, 0.75, -3.0);
    for (let i = 0; i < 5; i++) b.box(hull, 0.07, 0.02, 0.9, sx * 2.125, 0.6 + i * 0.075, -3.0, 0, 0, sx * 0.6);
    // Low coolant pipe with clamps and elbows into the hull, plus a thin conduit above it.
    b.cyl(hullDark, 0.045, 0.045, 6.4, 8, sx * 2.16, 0.05, -3.0, Math.PI / 2);
    for (const z of [-6.2, 0.2]) b.cyl(hullDark, 0.045, 0.045, 0.1, 8, sx * 2.12, 0.05, z, 0, 0, Math.PI / 2);
    for (const z of [-5.8, -4.4, -3.0, -1.6, -0.2]) b.box(hull, 0.12, 0.13, 0.07, sx * 2.15, 0.05, z);
    b.cyl(hullDark, 0.025, 0.025, 5.5, 6, sx * 2.13, 0.2, -3.25, Math.PI / 2);
    // Rear-edge hazard stripe (the side face only — never the rear face by the ramp) and the landing-light housing.
    b.box(accent, 0.03, 3.1, 0.1, sx * 2.11, 1.25, 0.5);
    b.box(hullDark, 0.06, 0.24, 0.72, sx * 2.115, 0.4, 0.1);

    // ── Front cap shoulders (face z −6.6, outboard of the nose) ─────────────────────────────────────
    b.box(hullDark, 0.04, 3.0, 0.03, sx * 1.25, 1.35, -6.612);
    b.box(hullDark, 0.5, 0.7, 0.02, sx * 1.72, 1.5, -6.608);
    for (let i = 0; i < 8; i++) b.box(hull, 0.44, 0.02, 0.07, sx * 1.72, 1.22 + i * 0.08, -6.632, -0.6);

    // ── Roof shoulders (y 3.0, x 1.5..2.1): paired conduits with straps, edge rivets ────────────────
    b.cyl(hullDark, 0.04, 0.04, 6.2, 8, sx * 1.72, 3.035, -3.2, Math.PI / 2);
    b.cyl(hullDark, 0.03, 0.03, 6.2, 8, sx * 1.86, 3.025, -3.2, Math.PI / 2);
    for (const z of [-5.6, -3.9, -2.2, -0.6]) b.box(hull, 0.36, 0.1, 0.07, sx * 1.79, 3.04, z);
    for (let z = -6.3; z <= 0.31; z += 0.5) rivetY(b, hull, sx * 2.05, 3.01, z);

    // ── Upper deck (x ±1.5, y 2.95..3.55, z −6.4..0) ─────────────────────────────────────────────────
    // Louvred vents on its side faces.
    for (const vz of [-4.6, -1.6]) {
      b.box(hullDark, 0.02, 0.36, 1.3, sx * 1.51, 3.25, vz);
      for (let i = 0; i < 6; i++) b.box(hull, 0.07, 0.02, 1.2, sx * 1.525, 3.1 + i * 0.06, vz, 0, 0, sx * 0.6);
    }
    // Grilles on its top face beside the spine.
    for (const gz of [-5.0, -2.0]) {
      b.box(hullDark, 0.7, 0.02, 1.0, sx * 0.95, 3.555, gz);
      for (let i = 0; i < 6; i++) b.box(hull, 0.62, 0.025, 0.06, sx * 0.95, 3.57, gz - 0.4 + i * 0.16, 0.5);
    }
    for (const z of [-6.0, -3.5, -0.4]) b.box(hullDark, 1.08, 0.015, 0.04, sx * 0.95, 3.556, z);
    b.box(hullDark, 0.03, 0.015, 6.3, sx * 1.44, 3.557, -3.2);

    // ── Wing top (x 1.7..4.3; visible x 2.1..3.2 between hull and nacelle) ──────────────────────────
    b.box(hullDark, 0.04, 0.015, 2.5, sx * 2.65, 2.415, -3.2);
    b.box(hullDark, 1.05, 0.015, 0.04, sx * 2.65, 2.415, -2.25);
    b.box(hullDark, 1.1, 0.06, 0.04, sx * 2.65, 2.3, -4.51);
    for (const wx of [2.3, 2.6, 2.9]) for (const wz of [-4.3, -2.05]) rivetY(b, hull, sx * wx, 2.415, wz);

    // ── Nacelle (centre x ±4.2, z −3.2) ─────────────────────────────────────────────────────────────
    {
      const cx = sx * 4.2, cz = -3.2;
      // Ribs (never across the wing root band y 2.19..2.41). 18 segments like the nacelle, so the facets line up.
      for (const y of [0.75, 1.45, 2.85, 3.4]) {
        const r = nacelleR(y) + 0.025;
        b.cyl(hullDark, r, r, 0.09, 18, cx, y, cz);
      }
      // Longitudinal strakes on the outboard half (clear of the wing, which ends at |x| 4.3).
      const lean = Math.atan(0.1 / 3.6);
      const rMid = nacelleR(1.9) + 0.02;
      for (const a of [-0.7, 0, 0.7]) {
        const dx = sx * Math.cos(a), dz = Math.sin(a);
        b.box(hull, 0.05, 3.2, 0.07, cx + dx * rMid, 1.9, cz + dz * rMid, 0, Math.atan2(-dz, dx), lean);
      }
      // Top intake: ring, spokes and hub.
      b.torus(hullDark, 0.62, 0.05, cx, 3.72, cz, Math.PI / 2);
      b.box(hullDark, 1.24, 0.04, 0.06, cx, 3.72, cz);
      b.box(hullDark, 0.06, 0.04, 1.24, cx, 3.72, cz);
      b.cyl(hull, 0.22, 0.22, 0.12, 12, cx, 3.74, cz);
    }

    // ── Chin intake (side face x ±1.3, visible z −8.47..−6.6) ───────────────────────────────────────
    b.box(hullDark, 0.02, 0.44, 1.1, sx * 1.305, 0.35, -7.5);
    for (let i = 0; i < 5; i++) b.box(hull, 0.06, 0.02, 1.0, sx * 1.32, 0.2 + i * 0.08, -7.5, 0, 0, sx * 0.6);

    // ── Nose sides (slanted faces x = ±noseHalf(z)) ─────────────────────────────────────────────────
    {
      const slope = Math.atan(((2.05 - 1.5) / Math.SQRT2) / 3.2);
      for (const y of [1.45, 2.1]) b.box(hullDark, 0.03, 0.04, 3.1, sx * (noseHalf(-8.1) + 0.01), y, -8.1, 0, -sx * slope);
      b.box(hullDark, 0.03, 2.3, 0.04, sx * (noseHalf(-8.9) + 0.01), 1.45, -8.9);
      for (const z of [-7.2, -7.8, -8.4, -9.0]) rivetX(b, hull, sx * (noseHalf(z) + 0.02), 1.55, z);
    }

    // ── Tail fin (frame: fin centre, rotated about Z) ────────────────────────────────────────────────
    b.frame = new THREE.Matrix4().compose(
      new THREE.Vector3(sx * 1.4, 4.1, 0.2), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -sx * 0.45)), _s);
    b.box(hullDark, 0.14, 0.06, 1.82, 0, 0.8, 0);
    b.box(hullDark, 0.13, 1.5, 0.06, 0, 0, 0.9);
    b.box(glass, 0.12, 0.08, 0.2, 0, 0.84, -0.7);
    b.frame = null;

    // ── Belly underside (y −0.3; gear legs at (±1.8, −1.0) stay clear) ──────────────────────────────
    b.box(hullDark, 0.04, 0.02, 7.0, sx * 1.0, -0.305, -3.0);
  }

  // ── Belly (centre) ──────────────────────────────────────────────────────────────────────────────────
  for (const z of [-5.2, -3.2, -1.8]) b.box(hullDark, 4.1, 0.02, 0.04, 0, -0.305, z);
  b.box(hullDark, 1.2, 0.03, 0.8, 0, -0.31, -4.2);
  b.box(accent, 0.25, 0.03, 0.05, 0, -0.33, -4.2);

  // ── Spine (accent, x ±0.4, y 3.35..3.85): dark bands, blade + whip antennas, nav sensor puck ─────────
  for (const z of [-7.6, -5.8, -4.0, -2.2, -0.4]) b.box(hullDark, 0.86, 0.54, 0.08, 0, 3.6, z);
  b.box(hullDark, 0.03, 0.3, 0.45, 0, 4.0, -6.9, 0.35);
  b.cyl(hullDark, 0.05, 0.07, 0.08, 8, 0.22, 3.89, -1.2);
  b.cyl(hullDark, 0.012, 0.012, 0.7, 5, 0.22, 4.28, -1.2);
  b.cyl(accent, 0.025, 0.025, 0.04, 6, 0.22, 4.64, -1.2);
  b.cyl(hullDark, 0.04, 0.05, 0.14, 8, -0.22, 3.92, -0.9);
  b.cyl(glass, 0.12, 0.12, 0.05, 16, 0, 3.87, -3.1);

  // ── Nose tip face (z −9.7, x ±1.45, y 0..2.9): sensor strip, bumper, hazard chevrons, centre seam ────
  b.box(hullDark, 1.5, 0.3, 0.03, 0, 2.05, -9.705);
  b.box(glass, 1.3, 0.16, 0.04, 0, 2.05, -9.715);
  b.box(hullDark, 2.4, 0.12, 0.05, 0, 0.55, -9.72);
  b.box(hullDark, 0.03, 1.75, 0.03, 0, 0.975, -9.71);
  for (const sx of [-1, 1]) for (let k = 0; k < 2; k++) b.box(accent, 0.45, 0.07, 0.03, sx * 0.95, 1.25 + k * 0.18, -9.712, 0, 0, sx * 0.7);

  // ── Cockpit glass frame (frame: glass box 2.1 × 0.9 × 1.6 at (0, 2.55, −7.2), rx 0.25) ─────────────
  b.frame = new THREE.Matrix4().compose(
    new THREE.Vector3(0, 2.55, -7.2), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.25, 0, 0)), _s);
  for (const lx of [-1.04, -0.35, 0.35, 1.04]) b.box(hullDark, 0.05, 0.035, 1.62, lx, 0.455, 0);
  b.box(hullDark, 2.12, 0.035, 0.05, 0, 0.455, -0.1);
  b.box(hullDark, 2.12, 0.05, 0.05, 0, 0.44, -0.8);
  b.frame = null;

  // ── Tail plane top (y 3.96, x ±1.7, z −0.4..1.0) ────────────────────────────────────────────────────
  for (const sx of [-1, 1]) b.box(hullDark, 0.04, 0.015, 1.38, sx * 0.9, 3.965, 0.3);
  b.box(hullDark, 3.0, 0.015, 0.03, 0, 3.965, 0.75);

  return b.build(parent, keep);
}
