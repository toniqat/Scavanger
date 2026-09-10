import * as THREE from 'three';
import { GeoBatch, HUB_MATS as M } from './GeoBatch';
import type { BoxInteriorCollider } from './InteriorCollider';

/** Transparent viewport glass (shared, constant). */
export const GLASS_MAT = new THREE.MeshStandardMaterial({
  color: 0x9fc4ff, transparent: true, opacity: 0.1, roughness: 0.05, metalness: 0.3, depthWrite: false, side: THREE.DoubleSide,
});

export interface Box2 { minX: number; maxX: number; minZ: number; maxZ: number }

/** Reusable building blocks shared by both ship interiors. */
export class Parts {
  constructor(readonly b: GeoBatch, readonly col: BoxInteriorCollider, readonly ceilY: number) {}

  /** Deck plate + centre grate strip + ceiling. */
  deck(room: Box2, grateAlongX: boolean): void {
    const w = room.maxX - room.minX, d = room.maxZ - room.minZ;
    const cx = (room.minX + room.maxX) / 2, cz = (room.minZ + room.maxZ) / 2;
    this.b.plane(w, d, cx, 0, cz, M.floor);
    if (grateAlongX) this.b.box(w - 1, 0.02, 1.6, cx, 0.011, cz, M.floorGrate);
    else this.b.box(1.6, 0.02, d - 1, cx, 0.011, cz, M.floorGrate);
    this.b.plane(w, d, cx, this.ceilY, cz, M.hullDark, Math.PI / 2);
    // recessed ceiling light channels
    const n = Math.max(1, Math.round((grateAlongX ? w : d) / 4));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      if (grateAlongX) this.b.box(0.18, 0.04, d * 0.6, room.minX + w * t, this.ceilY - 0.03, cz, M.stripWhite);
      else this.b.box(w * 0.6, 0.04, 0.18, cx, this.ceilY - 0.03, room.minZ + d * t, M.stripWhite);
    }
    // amber floor edge strips
    this.b.box(w - 0.4, 0.02, 0.06, cx, 0.012, room.minZ + 0.25, M.stripAmber);
    this.b.box(w - 0.4, 0.02, 0.06, cx, 0.012, room.maxZ - 0.25, M.stripAmber);
  }

  /**
   * Four walls (thickness `t`) around `room`, with optional rectangular openings per side
   * (`open.{n,s,e,w}` = { lo, hi, y0, y1 } along the wall axis). Blockers for every solid piece.
   */
  walls(room: Box2, t: number, open: Partial<Record<'n' | 's' | 'e' | 'w', { lo: number; hi: number; y0: number; y1: number }>> = {}): void {
    const H = this.ceilY;
    const sides: Array<{ k: 'n' | 's' | 'e' | 'w'; axisX: boolean; at: number; lo: number; hi: number }> = [
      { k: 'n', axisX: true, at: room.minZ - t / 2, lo: room.minX - t, hi: room.maxX + t },   // -Z
      { k: 's', axisX: true, at: room.maxZ + t / 2, lo: room.minX - t, hi: room.maxX + t },   // +Z
      { k: 'w', axisX: false, at: room.minX - t / 2, lo: room.minZ, hi: room.maxZ },          // -X
      { k: 'e', axisX: false, at: room.maxX + t / 2, lo: room.minZ, hi: room.maxZ },          // +X
    ];
    for (const s of sides) {
      const o = open[s.k];
      const segs: Array<{ lo: number; hi: number; y0: number; y1: number }> = [];
      if (!o) segs.push({ lo: s.lo, hi: s.hi, y0: 0, y1: H });
      else {
        segs.push({ lo: s.lo, hi: o.lo, y0: 0, y1: H });
        segs.push({ lo: o.hi, hi: s.hi, y0: 0, y1: H });
        if (o.y0 > 0) segs.push({ lo: o.lo, hi: o.hi, y0: 0, y1: o.y0 });
        if (o.y1 < H) segs.push({ lo: o.lo, hi: o.hi, y0: o.y1, y1: H });
      }
      for (const g of segs) {
        const len = g.hi - g.lo, h = g.y1 - g.y0;
        if (len <= 0.001 || h <= 0.001) continue;
        const mid = (g.lo + g.hi) / 2, my = (g.y0 + g.y1) / 2;
        if (s.axisX) {
          this.b.box(len, h, t, mid, my, s.at, M.hull);
          this.col.addBlocker(g.lo, g.y0, s.at - t / 2, g.hi, g.y1, s.at + t / 2);
        } else {
          this.b.box(t, h, len, s.at, my, mid, M.hull);
          this.col.addBlocker(s.at - t / 2, g.y0, g.lo, s.at + t / 2, g.y1, g.hi);
        }
      }
      // Wainscot band + trim line. It is **split around a floor-level opening** (`o.y0 < band`): the band used to run
      // the full length of every side, which left a waist-high slab standing across each doorway and the cockpit arch.
      const band = 1.0;
      const bandSegs: Array<{ lo: number; hi: number }> = o && o.y0 < band
        ? [{ lo: s.lo, hi: o.lo }, { lo: o.hi, hi: s.hi }]
        : [{ lo: s.lo, hi: s.hi }];
      for (const g of bandSegs) {
        const len = g.hi - g.lo;
        if (len <= 0.001) continue;
        const mid = (g.lo + g.hi) / 2;
        if (s.axisX) {
          this.b.box(len, band, 0.04, mid, band / 2, s.at + (s.k === 'n' ? t / 2 + 0.02 : -t / 2 - 0.02), M.hullDark);
          this.b.box(len, 0.05, 0.05, mid, band + 0.05, s.at + (s.k === 'n' ? t / 2 + 0.03 : -t / 2 - 0.03), M.trim);
        } else {
          this.b.box(0.04, band, len, s.at + (s.k === 'w' ? t / 2 + 0.02 : -t / 2 - 0.02), band / 2, mid, M.hullDark);
          this.b.box(0.05, 0.05, len, s.at + (s.k === 'w' ? t / 2 + 0.03 : -t / 2 - 0.03), band + 0.05, mid, M.trim);
        }
      }
    }
  }

  /** Viewport glass in an opening (axis-aligned). */
  glass(parent: THREE.Object3D, w: number, h: number, x: number, y: number, z: number, ry: number, out: THREE.Mesh[]): void {
    const g = new THREE.PlaneGeometry(w, h);
    const m = new THREE.Mesh(g, GLASS_MAT);
    m.position.set(x, y, z); m.rotation.y = ry;
    m.renderOrder = 2;
    parent.add(m);
    out.push(m);
    // frame bars
    const t = 0.08;
    const along = ry === 0 || Math.abs(ry) === Math.PI;
    const n = Math.max(1, Math.round(w / 2.5));
    for (let i = 1; i < n; i++) {
      const off = -w / 2 + (w * i) / n;
      if (along) this.b.box(t, h, t, x + off, y, z, M.hullDark);
      else this.b.box(t, h, t, x, y, z + off, M.hullDark);
    }
  }

  /** Vertical structural rib against a wall + ceiling beam stub. */
  rib(x: number, z: number, ry = 0): void {
    this.b.box(0.28, this.ceilY, 0.28, x, this.ceilY / 2, z, M.hullLight, ry);
    this.b.box(0.34, 0.12, 0.34, x, 0.06, z, M.hullDark, ry);
  }
  /** Ceiling beam spanning `len` along X (ry=0) or Z (ry=π/2). */
  beam(len: number, x: number, z: number, ry = 0): void {
    this.b.box(len, 0.22, 0.28, x, this.ceilY - 0.11, z, M.hullLight, ry);
  }

  /** Stack of supply crates (with blockers). */
  crates(x: number, z: number, count: number, ry = 0): void {
    const s = 0.8;
    const fx = -Math.sin(ry), fz = -Math.cos(ry);   // front (toward the room)
    for (let i = 0; i < count; i++) {
      const lvl = Math.floor(i / 2), side = i % 2;
      const ox = side ? s * 0.55 : -s * 0.55;
      const px = x + Math.cos(ry) * ox, pz = z - Math.sin(ry) * ox;
      const y0 = lvl * (s * 0.7);
      this.b.boxB(s, s * 0.7, s * 0.8, px, y0, pz, M.crate, ry);
      this.b.box(s * 1.02, 0.06, s * 0.82, px, y0 + s * 0.35, pz, M.crateDark, ry);
      this.b.box(0.3, 0.06, 0.06, px + fx * s * 0.41, y0 + s * 0.6, pz + fz * s * 0.41, M.stripAmber, ry);
    }
    const w = s * 2.2, d = s * 0.9;
    this.col.addBox(x, 0, z, Math.abs(Math.cos(ry)) * w + Math.abs(Math.sin(ry)) * d, s * 0.7 * Math.ceil(count / 2), Math.abs(Math.sin(ry)) * w + Math.abs(Math.cos(ry)) * d);
  }

  /** Row of `n` lockers against a wall (facing direction ry). */
  lockers(x: number, z: number, n: number, ry = 0): void {
    const w = 0.6, h = 2.0, d = 0.5;
    const fx = -Math.sin(ry), fz = -Math.cos(ry);   // front (toward the room)
    for (let i = 0; i < n; i++) {
      const off = (i - (n - 1) / 2) * (w + 0.04);
      const px = x + Math.cos(ry) * off, pz = z - Math.sin(ry) * off;
      this.b.boxB(w, h, d, px, 0, pz, M.hullDark, ry);
      this.b.box(w * 0.9, 0.03, 0.02, px + fx * (d / 2 + 0.01), 1.5, pz + fz * (d / 2 + 0.01), M.trim, ry);
      this.b.box(0.06, 0.25, 0.02, px + fx * (d / 2 + 0.01) + Math.cos(ry) * 0.2, 1.0, pz + fz * (d / 2 + 0.01) - Math.sin(ry) * 0.2, M.hullLight, ry);
    }
    const tw = n * (w + 0.04);
    this.col.addBox(x, 0, z, Math.abs(Math.cos(ry)) * tw + Math.abs(Math.sin(ry)) * d, h, Math.abs(Math.sin(ry)) * tw + Math.abs(Math.cos(ry)) * d);
  }

  /** Terminal pedestal + slanted screen frame. The screen texture itself is a TextPlane added by the caller. */
  consolePedestal(x: number, z: number, ry: number): { screenPos: THREE.Vector3; screenRot: THREE.Euler } {
    const fx = -Math.sin(ry), fz = -Math.cos(ry);   // facing direction (toward the user)
    this.b.boxB(1.1, 0.9, 0.6, x, 0, z, M.hullDark, ry);
    this.b.box(1.15, 0.08, 0.65, x, 0.92, z, M.trimDark, ry);
    // slanted housing (box front = local −Z = `f`; tilt leans the top away from the user)
    this.b.box(1.0, 0.7, 0.12, x - fx * 0.12, 1.28, z - fz * 0.12, M.hullLight, ry, -0.35);
    this.b.box(0.9, 0.04, 0.2, x + fx * 0.2, 0.98, z + fz * 0.2, M.stripCyan, ry);
    this.col.addBox(x, 0, z, Math.abs(Math.cos(ry)) * 1.2 + Math.abs(Math.sin(ry)) * 0.7, 1.6, Math.abs(Math.sin(ry)) * 1.2 + Math.abs(Math.cos(ry)) * 0.7);
    // PlaneGeometry faces +Z, so yaw it by ry + π to face `f`; −0.35 tilts the normal upward toward the eyes
    const screenPos = new THREE.Vector3(x - fx * 0.03, 1.30, z - fz * 0.03);
    const screenRot = new THREE.Euler(-0.35, ry + Math.PI, 0, 'YXZ');
    return { screenPos, screenRot };
  }

  /**
   * Weapon workbench against a wall: steel table with a drawer block, vise, tool board on the wall behind, lamp strip.
   * `ry` = facing direction (front toward the room, same convention as the other parts). ~1.9 × 0.75 m footprint,
   * one collider box. Returns the interaction anchor (0.95 m in front, deck level), the yaw a player looking at the
   * bench should have, and the transform for a wall sign above the tool board (`TextPlane` added by the caller).
   */
  workbench(x: number, z: number, ry: number): { position: THREE.Vector3; yaw: number; signPos: THREE.Vector3; signRot: THREE.Euler } {
    const fx = -Math.sin(ry), fz = -Math.cos(ry);   // front (toward the room)
    const sx = Math.cos(ry), sz = -Math.sin(ry);    // sideways (local +X)
    const b = this.b;
    // table: legs + top + drawer block
    for (const s of [-0.85, 0.85]) {
      b.boxB(0.08, 0.86, 0.6, x + sx * s, 0, z + sz * s, M.gunmetal, ry);
    }
    b.boxB(0.7, 0.8, 0.62, x + sx * 0.5, 0.03, z + sz * 0.5, M.hullDark, ry);
    for (let k = 0; k < 3; k++) b.box(0.55, 0.04, 0.03, x + sx * 0.5 + fx * 0.32, 0.22 + k * 0.25, z + sz * 0.5 + fz * 0.32, M.trim, ry);
    b.box(1.9, 0.07, 0.75, x, 0.9, z, M.gunmetal, ry);
    b.box(1.86, 0.02, 0.7, x, 0.945, z, M.hullLight, ry);
    b.box(1.9, 0.04, 0.05, x + fx * 0.36, 0.905, z + fz * 0.36, M.stripAmber, ry);     // front edge strip
    // vise (left) + parts tray (right)
    b.boxB(0.28, 0.16, 0.2, x - sx * 0.55, 0.955, z - sz * 0.55, M.hullDark, ry);
    b.box(0.34, 0.05, 0.05, x - sx * 0.55, 1.12, z - sz * 0.55, M.hullLight, ry);
    b.cyl(0.02, 0.02, 0.32, 8, x - sx * 0.55 - fx * 0.12, 1.1, z - sz * 0.55 - fz * 0.12, M.trim, 0, ry, Math.PI / 2);
    b.boxB(0.42, 0.06, 0.3, x + sx * 0.45, 0.955, z + sz * 0.45, M.crateDark, ry);
    b.boxB(0.5, 0.12, 0.12, x + sx * 0.05, 0.955, z + sz * 0.05 - fz * 0.18, M.hullDark, ry);   // rifle rest block
    // wall tool board (behind the bench, above the top)
    const bx = x - fx * 0.34, bz = z - fz * 0.34;
    b.box(1.7, 0.9, 0.05, bx, 1.65, bz, M.hullDark, ry);
    b.box(1.72, 0.03, 0.06, bx, 2.11, bz, M.trim, ry);
    for (let k = 0; k < 5; k++) {
      const off = -0.6 + k * 0.3;
      b.box(0.05, 0.4 + (k % 2) * 0.15, 0.05, bx + sx * off + fx * 0.03, 1.62, bz + sz * off + fz * 0.03, k % 2 ? M.hullLight : M.gunmetal, ry);
    }
    b.box(1.2, 0.06, 0.06, bx + fx * 0.1, 2.25, bz + fz * 0.1, M.stripCyan, ry);     // lamp strip
    // one collider box (yaw-aligned to 90° multiples in practice)
    const w = 1.95, d = 0.8;
    this.col.addBox(x, 0, z, Math.abs(Math.cos(ry)) * w + Math.abs(Math.sin(ry)) * d, 1.3, Math.abs(Math.sin(ry)) * w + Math.abs(Math.cos(ry)) * d);
    const position = new THREE.Vector3(x + fx * 0.95, 0, z + fz * 0.95);
    // player forward = (−sin yaw, −cos yaw); looking at the bench = −f
    const yaw = Math.atan2(fx, fz);
    const signPos = new THREE.Vector3(bx + fx * 0.04, 2.5, bz + fz * 0.04);
    const signRot = new THREE.Euler(0, ry + Math.PI, 0, 'YXZ');    // PlaneGeometry faces +Z → yaw by ry + π to face `f`
    return { position, yaw, signPos, signRot };
  }

  /** Small wall-mounted sign strip with a light. */
  signStrip(x: number, y: number, z: number, w: number, mat: THREE.Material, ry = 0): void {
    this.b.box(w, 0.08, 0.04, x, y, z, mat, ry);
  }
}

/*
 * `fixture()` (a PointLight of the ship's own) was removed on 2026-09-10: interiors list `LightFixture`s and a
 * `LightPool` of `HUB_POINT_LIGHTS` lights serves the nearest of them, so the scene-wide point-light count never
 * changes (see `LightPool.ts` and `core/LightBudget`).
 */
