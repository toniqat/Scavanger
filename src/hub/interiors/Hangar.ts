import * as THREE from 'three';
import { NET_MAX_PLAYERS, NET_SLOT_COLORS } from '@/shared';
import { GeoBatch, HUB_MATS as M, disposeMeshes, yawFromForward } from './GeoBatch';
import type { BoxInteriorCollider } from './InteriorCollider';
import { Parts, fixture } from './parts';
import { buildPersonalExterior, type ExteriorModel } from './ExteriorShips';
import { TextPlane } from '../Labels';

/* ────────────────────────────────────────────────────────────────────────────
 * 공용 함선 격납고 (2026-09-08). The deck **behind** the shared ship's aft 자동문: a 44 × 30 m bay with four square
 * floor markings, one per lobby slot, and a member's 개인 함선 parked on each. Walking to a parked ship's rear ramp
 * and pressing E boards it (`hub/parts/Hangar.ts` owns that interactable — this file is geometry only).
 *
 * It is part of the **shared ship interior**, not an interior of its own: one `BoxInteriorCollider` room touching the
 * ship's own room, so the doorway is an open shared edge and remote avatars walk straight through. Everything static
 * is merged into the caller's `GeoBatch`; only the parked ship models (which come and go with the lobby), the bay
 * signs and the lights own objects, and `setOccupants` rebuilds just the models.
 *
 * Coordinates are world space, like every other interior (every client builds the same deck, so hub snapshots agree).
 * ──────────────────────────────────────────────────────────────────────────── */

/** Deck extent in X and how far it reaches aft of the ship. */
export const HANGAR = { minX: -22, maxX: 22, depth: 30 };
/** Ceiling — far above the ship's 4.2 m deck: a whole 개인 함선 stands in here. */
export const HANGAR_CEIL = 9.0;
export const HANGAR_WALL = 0.4;
/** Half-size of a bay's floor marking (a 9 × 12 m rectangle). */
const BAY_HALF_X = 4.5;
const BAY_HALF_Z = 6.0;
/** Bay centres along X (evenly spread across the deck). */
const BAY_X = [-16.5, -5.5, 5.5, 16.5];
/** Parked ships stand this high on their landing struts (the exterior model's belly sits at local y −0.93). */
const SHIP_Y = 1.45;
/** Deck contact points of the three struts, in the ship's own (unrotated) local XZ. */
const STRUTS: Array<[number, number]> = [[-2.4, 1.6], [2.4, 1.6], [0, -2.2]];
/** Half the personal exterior's hull length — the ramp sits this far toward −Z of the ship's centre. */
const SHIP_HALF_LEN = 4.4;

/**
 * Landing gear + boarding ramp for a parked ship, parented to its bay group (local origin = the ship's centre on the
 * deck). Built per ship rather than merged into the deck: an empty bay must not show struts holding up nothing.
 */
function buildGear(parent: THREE.Object3D): THREE.Mesh[] {
  const b = new GeoBatch();
  for (const [sx, sz] of STRUTS) {
    // ship-local −Z is its nose; the parked model is turned around, so mirror the strut anchors with it
    const x = sx, z = -sz;
    b.cyl(0.12, 0.16, SHIP_Y - 0.55, 8, x, (SHIP_Y - 0.55) / 2, z, M.gunmetal);
    b.boxB(0.7, 0.12, 0.7, x, 0, z, M.hullDark);
    b.box(0.5, 0.03, 0.5, x, 0.13, z, M.trimDark);
  }
  // rear ramp: a plate sloping from the tail down to the deck on the walkway side (local −Z after the turn)
  const rampZ = -SHIP_HALF_LEN + 0.35;
  b.box(2.2, 0.1, 2.6, 0, (SHIP_Y - 0.6) / 2, rampZ, M.hullLight, 0, -0.42);
  b.box(2.3, 0.04, 0.1, 0, 0.03, rampZ - 1.15, M.stripAmber);
  for (const sx of [-1, 1]) b.box(0.06, 0.5, 2.5, sx * 1.1, (SHIP_Y - 0.4) / 2, rampZ, M.trimDark, 0, -0.42);
  const meshes: THREE.Mesh[] = [];
  b.build(parent, meshes, false, true);
  return meshes;
}

/** One bay of the hangar, as the hub sees it. */
export interface HangarBayDef {
  slot: number;
  /** Centre of the floor marking (deck level). */
  position: THREE.Vector3;
  /** Interaction anchor at the foot of the parked ship's rear ramp. */
  entrance: THREE.Vector3;
  /** Player yaw looking at the parked ship (toward +Z). */
  yaw: number;
}

export class Hangar {
  readonly root = new THREE.Group();
  readonly bays: HangarBayDef[] = [];
  /** Deck bounds, for the caller's doors / status text. */
  readonly minZ: number;
  readonly maxZ: number;

  private lights: THREE.PointLight[] = [];
  private signs: TextPlane[] = [];
  /** Parked ship models by slot (null = empty bay). Driven by `setOccupants`. */
  private parked: (ExteriorModel | null)[] = new Array(NET_MAX_PLAYERS).fill(null);
  private bayGroups: THREE.Group[] = [];
  /** Landing gear + boarding ramp per bay, built with the parked model and disposed with it. */
  private gear: (THREE.Mesh[] | null)[] = new Array(NET_MAX_PLAYERS).fill(null);
  /** Per-bay marking strip material (own instance so an occupied bay can light up). */
  private bayStrips: THREE.MeshStandardMaterial[] = [];
  private beaconMat: THREE.MeshBasicMaterial;
  private beacons: THREE.Mesh[] = [];

  /**
   * Build the hangar into `b` / `col` — the shared ship's own batch and collider, so the deck costs no extra draw
   * calls. `wallZ` is the outer face of the ship's +Z wall (the hangar starts there) and `doorHalfWidth` matches the
   * opening the caller left in it.
   */
  constructor(b: GeoBatch, col: BoxInteriorCollider, ship: { wallZ: number; halfWidth: number; ceil: number }, doorHalfWidth: number) {
    this.root.name = 'Hangar';
    const minZ = ship.wallZ;
    const maxZ = minZ + HANGAR.depth;
    this.minZ = minZ; this.maxZ = maxZ;
    const H = HANGAR_CEIL;
    const P = new Parts(b, col, H);

    // walkable deck — it touches the ship's room at `wallZ`, so the doorway is an open shared edge
    col.addRoom(HANGAR.minX, HANGAR.maxX, minZ, maxZ, 0, H);

    // floor + ceiling. Not `Parts.deck`: that draws a centre grate and ceiling channels sized for a corridor.
    const cz = (minZ + maxZ) / 2, w = HANGAR.maxX - HANGAR.minX, d = maxZ - minZ;
    b.plane(w, d, 0, 0, cz, M.floor);
    b.plane(w, d, 0, H, cz, M.hullDark, Math.PI / 2);
    /*
     * The forward (−Z) wall is the **ship's own aft wall**, which already stands in this plane with the 자동문 hole
     * in it. Drawing a second slab there would z-fight it, so the opening below spans the ship's whole width: what
     * is left is the two outboard flanks plus the band above the ship's 4.2 m ceiling, which is exactly the wall the
     * hangar still needs. `doorHalfWidth` therefore only sizes the trim, not a hole.
     */
    P.walls({ minX: HANGAR.minX, maxX: HANGAR.maxX, minZ, maxZ }, HANGAR_WALL, {
      n: { lo: -(ship.halfWidth + 0.05), hi: ship.halfWidth + 0.05, y0: 0, y1: ship.ceil },
      s: { lo: -9.2, hi: 9.2, y0: 0, y1: 7.0 },                        // the exterior gate (a closed slab, below)
    });
    // the 자동문 opening is `doorHalfWidth` wide in that shared wall; a lit reveal marks it from the hangar side
    b.box(doorHalfWidth * 2 + 0.5, 0.1, 0.14, 0, 3.3, minZ + 0.1, M.stripCyan);

    /*
     * ── exterior bay gate (+Z): a closed blast door ──
     * Emissive trim is deliberately thin here. The first pass outlined the whole 18 × 7 m door in `stripAmber`
     * (emissiveIntensity 2.4) and bloom turned the far wall into a solid sheet of amber — the gate is big, so it
     * only needs a line, and the structural gold (`trim`, not emissive) carries the rest.
     */
    b.box(18.3, 7.1, 0.25, 0, 3.6, maxZ + HANGAR_WALL / 2, M.hullDark);
    col.addBlocker(-9.2, 0, maxZ - 0.1, 9.2, H, maxZ + HANGAR_WALL);
    for (const sx of [-1, 1]) b.box(0.3, 7.1, 0.34, sx * 9.05, 3.6, maxZ + HANGAR_WALL / 2 - 0.08, M.trim);
    b.box(18.6, 0.3, 0.34, 0, 7.2, maxZ + HANGAR_WALL / 2 - 0.08, M.trim);
    b.box(18.4, 0.07, 0.36, 0, 7.0, maxZ + HANGAR_WALL / 2 - 0.1, M.stripAmber);           // one lit line, not an outline
    b.box(0.16, 6.9, 0.32, 0, 3.55, maxZ + HANGAR_WALL / 2 - 0.1, M.trim);                 // centre seam
    for (let i = 0; i < 5; i++) b.box(0.1, 6.9, 0.28, -6 + i * 3, 3.55, maxZ + HANGAR_WALL / 2 - 0.09, M.trimDark);
    // hazard hatching **on the deck** in front of the gate (the first pass floated it on the door itself)
    for (let i = 0; i < 11; i++) b.box(0.55, 0.02, 2.0, -8.5 + i * 1.7, 0.01, maxZ - 1.6, i % 2 ? M.stripAmber : M.hullDark, 0, 0, 0.5);
    b.box(19, 0.03, 0.12, 0, 0.015, maxZ - 0.7, M.stripRed);                               // gate threshold line

    // ── structure: gantry frames + roof beams across the span ──
    for (const z of [minZ + 4, minZ + 11, minZ + 18, minZ + 25]) {
      P.beam(w, 0, z);
      for (const x of [HANGAR.minX + 0.35, HANGAR.maxX - 0.35]) {
        b.box(0.5, H, 0.5, x, H / 2, z, M.hullLight);
        col.addBox(x, 0, z, 0.5, H, 0.5);
      }
      b.box(w, 0.06, 0.1, 0, H - 0.5, z, M.stripWhite);
    }
    // service catwalk down both flanks (decorative, well above head height)
    for (const s of [-1, 1]) {
      const x = s * (HANGAR.maxX - 1.4);
      b.box(2.0, 0.14, d - 2, x, 4.4, cz, M.floorGrate);
      b.box(0.08, 0.9, d - 2, x - s * 0.95, 4.9, cz, M.trimDark);
      b.box(0.06, 0.05, d - 2, x, 5.35, cz, M.stripCyan);
    }

    // ── four bays ──
    for (let i = 0; i < NET_MAX_PLAYERS; i++) {
      const bx = BAY_X[i], bz = minZ + 14;
      const colour = NET_SLOT_COLORS[i % NET_SLOT_COLORS.length];
      const css = `#${colour.toString(16).padStart(6, '0')}`;
      // floor marking: a slot-coloured outline (own material instance so an occupied bay reads brighter)
      const strip = M.stripAmber.clone();
      strip.color.setHex(colour); strip.emissive.setHex(colour); strip.emissiveIntensity = 0.4;
      this.bayStrips.push(strip);
      // The outline is dashed on purpose: 42 m of continuous emissive per bay read as a glowing puddle under bloom.
      const t = 0.16;
      for (const sn of [-1, 1]) {
        b.box(BAY_HALF_X * 2, 0.02, t, bx, 0.012, bz + sn * BAY_HALF_Z, strip);
        for (let k = 0; k < 6; k++) b.box(t, 0.02, 1.1, bx + sn * BAY_HALF_X, 0.012, bz - BAY_HALF_Z + 0.9 + k * 2.05, strip);
      }
      // hazard hatching inside the square + a plate under the ramp
      for (let k = 0; k < 7; k++) b.box(0.5, 0.02, BAY_HALF_Z * 1.7, bx - 3.6 + k * 1.2, 0.008, bz, M.floorGrate, 0, 0, 0.55);
      b.box(2.6, 0.02, 1.6, bx, 0.014, bz - BAY_HALF_Z + 1.1, M.hullDark);
      // service pillar beside the bay (the sign hangs over it, facing the walkway)
      const px = bx + BAY_HALF_X + 0.7, pz = bz - BAY_HALF_Z + 0.6;
      b.boxB(0.6, 3.2, 0.6, px, 0, pz, M.hullLight);
      b.box(0.66, 0.08, 0.66, px, 3.24, pz, M.trimDark);
      b.box(0.62, 0.06, 0.06, px, 2.9, pz - 0.32, strip);
      col.addBox(px, 0, pz, 0.6, 3.2, 0.6);

      const shipZ = bz + 1.0;
      this.bays.push({
        slot: i,
        position: new THREE.Vector3(bx, 0, bz),
        entrance: new THREE.Vector3(bx, 0, shipZ - SHIP_HALF_LEN - 1.6),
        yaw: yawFromForward(0, 1),
      });

      const sign = new TextPlane(2.0, 0.6, 384);
      sign.mesh.position.set(bx, 3.9, bz - BAY_HALF_Z + 0.3);
      sign.mesh.rotation.y = Math.PI;      // PlaneGeometry faces +Z; the walkway is at −Z, so turn it around

      sign.set([`정박 ${i + 1}`, '비어 있음'], css, 'rgba(6,8,10,0.85)', '#9fb4c8');
      this.root.add(sign.mesh);
      this.signs.push(sign);

      const g = new THREE.Group();
      g.name = `hangar-bay-${i}`;
      g.position.set(bx, 0, shipZ);
      this.root.add(g);
      this.bayGroups.push(g);
    }

    /*
     * ── walkway markings between the door and the bays ──
     * Dashed, and in structural gold rather than `stripAmber`: an unbroken 40 m emissive line ran the full width of
     * the deck and bloom turned it into a solid bar of light across the screen. Emissive belongs on short accents.
     */
    for (const z of [minZ + 5.0, minZ + 7.4]) {
      for (let i = 0; i < 13; i++) b.box(2.2, 0.02, 0.1, -19.8 + i * 3.3, 0.012, z, M.trim);
    }
    b.box(2.4, 0.02, 5.4, 0, 0.013, minZ + 3.0, M.floorGrate);
    // deck-level guide lights along the centre of the walkway (short, so they read as lamps and not as a bar)
    for (let i = 0; i < 9; i++) b.box(0.5, 0.03, 0.12, -16 + i * 4, 0.015, minZ + 6.2, M.stripAmber);

    /*
     * ── lights (9, constant) ──
     * Hung off the gantries at 5.6 m, **not** under the 9 m ceiling: `PointLight` decays with the square of the
     * distance, so the first pass (6 lamps at 8.2 m, intensity 90) put roughly a third of the ship deck's
     * illuminance on a deck 3.6× its area and the whole hangar read as a black void with glowing strips. At 5.6 m
     * an intensity of 130 lands at ≈ 4 — a working-bay brightness that still falls off between the rows.
     */
    for (const z of [minZ + 5, minZ + 20]) {
      for (const x of [-15, -5, 5, 15]) fixture(this.root, x, 5.6, z, 0xdfe9ff, 130, 30, this.lights);
    }
    fixture(this.root, 0, 4.6, maxZ - 3.0, 0xffb347, 26, 16, this.lights);

    // hazard beacons flanking the gate
    this.beaconMat = new THREE.MeshBasicMaterial({ color: 0xff8a3a, transparent: true, opacity: 0.75 });
    for (const s of [-1, 1]) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), this.beaconMat);
      m.position.set(s * 9.6, 7.5, maxZ - 0.35);
      this.root.add(m);
      this.beacons.push(m);
    }
  }

  /**
   * Park (or clear) the ships. `names[i]` = the crew name standing in bay `i`, null = empty. Only the models and the
   * signs change — the deck is merged static geometry and is never rebuilt.
   */
  setOccupants(names: readonly (string | null)[]): void {
    for (let i = 0; i < this.bayGroups.length; i++) {
      const name = names[i] ?? null;
      const want = name !== null;
      if (want !== (this.parked[i] !== null)) {
        if (want) {
          const ship = buildPersonalExterior();
          // the model's nose is −Z; the rear ramp must face the walkway, so the ship is parked turned around
          ship.group.rotation.y = Math.PI;
          ship.group.position.y = SHIP_Y;
          ship.setThrust(0);
          this.bayGroups[i].add(ship.group);
          this.parked[i] = ship;
          this.gear[i] = buildGear(this.bayGroups[i]);
        } else {
          this.parked[i]?.dispose();
          this.parked[i] = null;
          disposeMeshes(this.gear[i] ?? []);
          this.gear[i] = null;
        }
      }
      const colour = NET_SLOT_COLORS[i % NET_SLOT_COLORS.length];
      const css = `#${colour.toString(16).padStart(6, '0')}`;
      this.signs[i]?.set([`정박 ${i + 1}`, name ?? '비어 있음'], want ? css : '#7d848c', 'rgba(6,8,10,0.85)', '#9fb4c8');
      const strip = this.bayStrips[i];
      if (strip) strip.emissiveIntensity = want ? 2.2 : 0.4;
    }
  }

  /** True while a ship stands in bay `slot` (debug / smoke). */
  isParked(slot: number): boolean { return this.parked[slot] != null; }

  update(_dt: number, time: number): void {
    this.beaconMat.opacity = 0.3 + 0.45 * (0.5 + 0.5 * Math.sin(time * 3));
  }

  dispose(): void {
    for (const s of this.parked) s?.dispose();
    this.parked.fill(null);
    for (const g of this.gear) disposeMeshes(g ?? []);
    this.gear.fill(null);
    for (const g of this.bayGroups) g.removeFromParent();
    this.bayGroups.length = 0;
    for (const s of this.signs) s.dispose();
    this.signs.length = 0;
    for (const m of this.bayStrips) m.dispose();     // per-bay clones, not shared
    this.bayStrips.length = 0;
    for (const bm of this.beacons) { bm.geometry.dispose(); bm.removeFromParent(); }
    this.beacons.length = 0;
    this.beaconMat.dispose();
    for (const l of this.lights) l.removeFromParent();
    this.lights.length = 0;
    this.root.removeFromParent();
  }
}
