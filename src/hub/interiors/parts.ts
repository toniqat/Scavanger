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
      // wainscot band + trim line
      const band = 1.0;
      if (s.axisX) {
        this.b.box(s.hi - s.lo, band, 0.04, (s.lo + s.hi) / 2, band / 2, s.at + (s.k === 'n' ? t / 2 + 0.02 : -t / 2 - 0.02), M.hullDark);
        this.b.box(s.hi - s.lo, 0.05, 0.05, (s.lo + s.hi) / 2, band + 0.05, s.at + (s.k === 'n' ? t / 2 + 0.03 : -t / 2 - 0.03), M.trim);
      } else {
        this.b.box(0.04, band, s.hi - s.lo, s.at + (s.k === 'w' ? t / 2 + 0.02 : -t / 2 - 0.02), band / 2, (s.lo + s.hi) / 2, M.hullDark);
        this.b.box(0.05, 0.05, s.hi - s.lo, s.at + (s.k === 'w' ? t / 2 + 0.03 : -t / 2 - 0.03), band + 0.05, (s.lo + s.hi) / 2, M.trim);
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

  /** Small wall-mounted sign strip with a light. */
  signStrip(x: number, y: number, z: number, w: number, mat: THREE.Material, ry = 0): void {
    this.b.box(w, 0.08, 0.04, x, y, z, mat, ry);
  }
}

/** Constant-count point light with a small emissive fixture. */
export function fixture(parent: THREE.Object3D, x: number, y: number, z: number, color: number, intensity: number, distance: number, out: THREE.PointLight[]): void {
  const l = new THREE.PointLight(color, intensity, distance, 2);
  l.position.set(x, y, z);
  l.castShadow = false;
  parent.add(l);
  out.push(l);
}
