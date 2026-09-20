import * as THREE from 'three';
import { SHIP_AIRLOCK_DOOR_OPEN_S, SHIP_AIRLOCK_DOOR_RANGE_M } from '@/shared';
import { GeoBatch, HUB_MATS as M, disposeMeshes } from './GeoBatch';
import type { BoxInteriorCollider } from './InteriorCollider';

/**
 * src/hub/interiors/AirlockDoors.ts — **the airlock's automatic doors** (2026-09-21, user's decision).
 *
 * The personal ship's corridor used to simply end in an airlock alcove. It is a room of its own now, shut off by a
 * two-leaf pressure door at each end, and a door opens for **anyone** who walks up to it — the local player or a
 * squadmate visiting the ship — within `SHIP_AIRLOCK_DOOR_RANGE_M`, over `SHIP_AIRLOCK_DOOR_OPEN_S`, and closes
 * again once nobody is left near it.
 *
 * ## Rules
 * - **The collider is the leaf.** Each leaf owns one blocker whose box is rewritten (`setBlockerBox`, never
 *   re-added) as the leaf slides, so what stops you is exactly what you see. The pod doors' on/off blocker would
 *   not do: a half-open door has to stop you over half the opening.
 * - **A leaf parks inside the wall, not in front of it.** Closed, the two leaves meet at the opening's centre;
 *   open, each has slid one opening-half outward and is buried in the solid part of the bulkhead — a pocket door.
 *   That is why the opening must be **narrower than half the chamber** (`leafTravel` ≤ the solid wall beside it):
 *   a wider one would leave the leaf standing in the room.
 * - **No light, ever.** The leaves carry emissive strips from the shared palette (`HUB_MATS`) and nothing else —
 *   the scene's point-light count is fixed (CLAUDE.md §4.5).
 * - **A locked door never moves.** The ship's outer hatch is locked while the ship is in space: an automatic door
 *   onto the void would walk the player out of the airlock. `setLocked` is how a raid arrival would open it.
 * - Nothing here reads the DOM or measures anything — the caller hands in the positions it already has, so this
 *   runs inside a frame without a layout read (§4.2).
 */

/** Leaf thickness along the wall's normal — thinner than the wall it hides in, or the pocket would show. */
const LEAF_T = 0.12;
/** Gap the leaf leaves below the soffit, so the header trim is never intersected. */
const LEAF_TOP_GAP = 0.02;

/** One automatic door. The wall runs along X at plane `z`; the opening is `x ± halfWidth`, `y` 0 … `height`. */
export interface AirlockDoorDef {
  /** Centre of the opening (world X) and the wall plane it sits in (world Z). */
  x: number;
  z: number;
  halfWidth: number;
  height: number;
  /** Accent for the leaf's lit seam (`HUB_MATS` member). */
  strip: THREE.MeshStandardMaterial;
  /** Locked doors never open (the outer hatch while the ship is in space). */
  locked?: boolean;
}

interface Door {
  def: AirlockDoorDef;
  /** −1 (port) and +1 (starboard) leaf groups and their collider indices. */
  leaves: THREE.Group[];
  blockers: number[];
  /** 0 = shut … 1 = fully open. */
  open: number;
  locked: boolean;
}

export class AirlockDoors {
  private readonly doors: Door[] = [];
  private readonly meshes: THREE.Mesh[] = [];

  /**
   * `parent` takes the leaf groups (they move, so they are **not** merged into the ship's static batch); `col` gets
   * one blocker per leaf.
   */
  constructor(parent: THREE.Object3D, private readonly col: BoxInteriorCollider, defs: readonly AirlockDoorDef[]) {
    for (const def of defs) {
      const leaves: THREE.Group[] = [];
      const blockers: number[] = [];
      for (const side of [-1, 1] as const) {
        const g = new THREE.Group();
        g.name = `airlock-leaf-${side < 0 ? 'p' : 's'}`;
        const b = new GeoBatch();
        const w = def.halfWidth, h = def.height - LEAF_TOP_GAP;
        // leaf plate, its outer stile and a lit seam down the meeting edge (local x 0 = the opening's centre)
        b.box(w, h, LEAF_T, side * w / 2, h / 2, 0, M.hullLight);
        b.box(0.06, h, LEAF_T + 0.02, side * (w - 0.03), h / 2, 0, M.trimDark);
        b.box(0.04, h - 0.3, LEAF_T + 0.02, side * 0.03, h / 2, 0, def.strip);
        // hazard chevrons low on the leaf, so a moving door reads as machinery and not as a wall
        for (let i = 0; i < 3; i++) b.box(w * 0.5, 0.05, LEAF_T + 0.015, side * (w * 0.45), 0.35 + i * 0.22, 0, M.trim);
        b.build(g, this.meshes, false, true);
        g.position.set(def.x, 0, def.z);
        parent.add(g);
        leaves.push(g);
        // Added at the **closed** box, not a degenerate one: `addBlocker` is the only call that refreshes the
        // collider's bounds, and `setBlockerBox` deliberately does not.
        const lo = side < 0 ? def.x - def.halfWidth : def.x;
        blockers.push(col.addBlocker(lo, 0, def.z - LEAF_T / 2, lo + def.halfWidth, def.height, def.z + LEAF_T / 2));
      }
      const door: Door = { def, leaves, blockers, open: 0, locked: def.locked === true };
      this.doors.push(door);
      this.place(door);
    }
  }

  /** How far door `i` stands open, 0 … 1 (debug / smoke). */
  openness(i: number): number { return this.doors[i]?.open ?? 0; }
  /** Number of doors (debug / smoke). */
  get count(): number { return this.doors.length; }
  /** Lock / unlock door `i`. A locked door shuts and stays shut; nothing else about it changes. */
  setLocked(i: number, locked: boolean): void {
    const d = this.doors[i];
    if (d) d.locked = locked;
  }
  /** Whether door `i` is locked (debug / smoke). */
  isLocked(i: number): boolean { return this.doors[i]?.locked === true; }

  /**
   * Drive the doors. `occupants` are the XZ positions of everyone standing in this ship — the local player first and
   * every visible squadmate after it (`HubSystem` collects them; a reused array, never kept here).
   */
  update(dt: number, occupants: readonly THREE.Vector3[]): void {
    const step = Math.max(0, dt) / Math.max(0.01, SHIP_AIRLOCK_DOOR_OPEN_S);
    const r2 = SHIP_AIRLOCK_DOOR_RANGE_M * SHIP_AIRLOCK_DOOR_RANGE_M;
    for (const d of this.doors) {
      let near = false;
      if (!d.locked) {
        for (const p of occupants) {
          const dx = p.x - d.def.x, dz = p.z - d.def.z;
          if (dx * dx + dz * dz <= r2) { near = true; break; }
        }
      }
      const target = near ? 1 : 0;
      if (d.open === target) continue;
      d.open = target > d.open ? Math.min(target, d.open + step) : Math.max(target, d.open - step);
      this.place(d);
    }
  }

  /** Put both leaves (and their colliders) where `open` says. */
  private place(d: Door): void {
    const { def } = d;
    // smoothstep, so a door eases into its stops instead of clacking
    const t = d.open * d.open * (3 - 2 * d.open);
    const travel = def.halfWidth * t;
    for (let k = 0; k < 2; k++) {
      const side = k === 0 ? -1 : 1;
      const off = side * travel;
      d.leaves[k].position.x = def.x + off;
      // The leaf covers x ∈ [x + off − halfWidth, x + off] on the port side (mirrored to starboard) — exactly the
      // box the mesh above draws, so the collider and the drawing can never drift apart.
      const lo = side < 0 ? def.x + off - def.halfWidth : def.x + off;
      this.col.setBlockerBox(d.blockers[k], lo, 0, def.z - LEAF_T / 2, lo + def.halfWidth, def.height, def.z + LEAF_T / 2);
    }
  }

  dispose(): void {
    disposeMeshes(this.meshes);
    for (const d of this.doors) {
      for (const g of d.leaves) g.removeFromParent();
      for (const b of d.blockers) this.col.removeBlocker(b);
    }
    this.doors.length = 0;
  }
}
