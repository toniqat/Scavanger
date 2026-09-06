import * as THREE from 'three';
import { DOOR_OPEN_DISTANCE, DOOR_SLIDE_SPEED } from '@/shared';
import { HUB_MATS as M } from './GeoBatch';

/* ────────────────────────────────────────────────────────────────────────────
 * 자동문 (Phase 8). Every room doorway and the cockpit arch of the personal ship carries a two-leaf sliding door.
 * They animate, so they can **not** go into the interior's merged `GeoBatch` — each leaf is its own small mesh
 * (two shared box geometries, one shared material, 2 meshes per door). They open when the player is within
 * `DOOR_OPEN_DISTANCE` of the threshold and slide at `DOOR_SLIDE_SPEED` (fraction of the full travel per second).
 *
 * **They never block movement**: no collider blocker is added and none is toggled — the doorway stays the open
 * shared edge the `BoxInteriorCollider` already models, exactly as before this file existed.
 * ──────────────────────────────────────────────────────────────────────────── */

interface Leaf {
  mesh: THREE.Mesh;
  /** Closed / fully open centre positions; the leaf lerps between them. */
  closed: THREE.Vector3;
  open: THREE.Vector3;
}

interface Door {
  /** Doorway centre at deck level — the point the player's distance is measured to. */
  tx: number;
  tz: number;
  leaves: Leaf[];
  /** 0 = closed, 1 = open. */
  amount: number;
}

const _a = new THREE.Vector3();

/** The personal ship's sliding doors (room doorways + cockpit arch). */
export class ShipDoors {
  private doors: Door[] = [];
  private geos: THREE.BufferGeometry[] = [];

  constructor(private readonly parent: THREE.Object3D) {}

  /**
   * Two-leaf door filling an opening `width × height` centred at (x, z) in the wall plane.
   * `axis` is the axis the leaves slide along: `'z'` for a wall facing ±X (room doors), `'x'` for the cockpit arch.
   */
  add(x: number, z: number, width: number, height: number, thickness: number, axis: 'x' | 'z'): void {
    const half = width / 2;
    const geo = axis === 'z'
      ? new THREE.BoxGeometry(thickness, height, half)
      : new THREE.BoxGeometry(half, height, thickness);
    this.geos.push(geo);
    const leaves: Leaf[] = [];
    for (const s of [-1, 1]) {
      const mesh = new THREE.Mesh(geo, M.hullLight);
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      const closed = axis === 'z'
        ? new THREE.Vector3(x, height / 2, z + s * half / 2)
        : new THREE.Vector3(x + s * half / 2, height / 2, z);
      const open = axis === 'z'
        ? new THREE.Vector3(x, height / 2, z + s * (half / 2 + half))
        : new THREE.Vector3(x + s * (half / 2 + half), height / 2, z);
      mesh.position.copy(closed);
      this.parent.add(mesh);
      leaves.push({ mesh, closed, open });
    }
    this.doors.push({ tx: x, tz: z, leaves, amount: 0 });
  }

  /** Slide every door toward its target (player within `DOOR_OPEN_DISTANCE` of the threshold = open). */
  update(dt: number, px: number, pz: number): void {
    const step = DOOR_SLIDE_SPEED * dt;
    const r2 = DOOR_OPEN_DISTANCE * DOOR_OPEN_DISTANCE;
    for (const d of this.doors) {
      const dx = px - d.tx, dz = pz - d.tz;
      const target = dx * dx + dz * dz <= r2 ? 1 : 0;
      if (d.amount === target) continue;
      d.amount = target > d.amount ? Math.min(target, d.amount + step) : Math.max(target, d.amount - step);
      for (const l of d.leaves) l.mesh.position.copy(_a.lerpVectors(l.closed, l.open, d.amount));
    }
  }

  /** Open fraction of door `i` (debug / smoke). */
  openAmount(i: number): number { return this.doors[i]?.amount ?? 0; }
  get count(): number { return this.doors.length; }

  dispose(): void {
    for (const d of this.doors) for (const l of d.leaves) l.mesh.removeFromParent();
    for (const g of this.geos) g.dispose();
    this.geos.length = 0;
    this.doors.length = 0;
  }
}
