import * as THREE from 'three';
import type { GameContext, Obstacle } from '@/shared';

/** Only colliders within this radius (m) around the player are drawn. */
const RADIUS = 30;
/** Rebuild interval (s) — enough to follow a moving collider such as the tram. */
const REBUILD_S = 0.25;
/** Segments around a cylinder. */
const CIRCLE_SEGS = 16;

const COLOR_CYLINDER = new THREE.Color(0xffd84a);
const COLOR_BOX = new THREE.Color(0x4ae3ff);
const COLOR_RAMP = new THREE.Color(0x6bff7a);
const COLOR_HULL = new THREE.Color(0xff9a3c);
const COLOR_BAND = new THREE.Color(0xb86a2a);

/**
 * 2026-09-12 — the **collider wireframe** of the `colliders` command (developer console only).
 *
 * Draws those of `ctx.world.getObstacles()` within `RADIUS` of the player (the camera when there is none) as line
 * segments: cylinder yellow · box (OBB) sky blue · ramp green · convex hull orange (bullet bands a darker orange).
 * One `LineSegments` has its buffers refilled, so while it is on the only allocation is the buffer growing. Drawn
 * with the depth test off — a collider buried in a wall has to be visible to find an "invisible wall". No lights are
 * created (the light budget contract).
 * Outside gameplay phases it hides; turning it off disposes the geometry and the material.
 */
export class ColliderOverlay {
  private lines: THREE.LineSegments | null = null;
  private geo: THREE.BufferGeometry | null = null;
  private mat: THREE.LineBasicMaterial | null = null;
  private pos = new Float32Array(0);
  private col = new Float32Array(0);
  private n = 0;
  private timer = 0;
  private _count = 0;

  constructor(private readonly ctx: GameContext) {}

  get enabled(): boolean { return this.lines !== null; }
  /** How many colliders the last rebuild drew. */
  get count(): number { return this._count; }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    if (!on) { this.dispose(); return; }
    this.geo = new THREE.BufferGeometry();
    this.mat = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false, transparent: true, opacity: 0.8 });
    this.lines = new THREE.LineSegments(this.geo, this.mat);
    this.lines.name = 'DevColliderOverlay';
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 999;
    this.ctx.scene.add(this.lines);
    this.timer = 0;
    this.rebuild();
  }

  update(dt: number): void {
    const lines = this.lines;
    if (!lines) return;
    const world = this.ctx.world;
    lines.visible = !!world && this.ctx.isGameplayPhase();
    if (!lines.visible) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = REBUILD_S;
    this.rebuild();
  }

  dispose(): void {
    this.lines?.removeFromParent();
    this.geo?.dispose();
    this.mat?.dispose();
    this.lines = null;
    this.geo = null;
    this.mat = null;
    this._count = 0;
  }

  private rebuild(): void {
    const world = this.ctx.world;
    const geo = this.geo;
    if (!world || !geo) return;
    const eye = this.ctx.player?.position ?? this.ctx.camera.position;
    this.n = 0;
    let count = 0;
    for (const o of world.getObstacles()) {
      const dx = o.position.x - eye.x, dz = o.position.z - eye.z;
      const reach = RADIUS + o.radius;
      if (dx * dx + dz * dz > reach * reach) continue;
      count++;
      if (o.hull) this.hull(o);
      else if (o.box && o.ramp) this.ramp(o);
      else if (o.box) this.box(o);
      else this.cylinder(o);
    }
    this._count = count;
    const attr = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!attr || attr.array !== this.pos) {
      geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    } else {
      attr.needsUpdate = true;
      (geo.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    }
    geo.setDrawRange(0, this.n);
  }

  /* ── Segment building ──────────────────────────────────────────────────── */

  private seg(ax: number, ay: number, az: number, bx: number, by: number, bz: number, c: THREE.Color): void {
    if ((this.n + 2) * 3 > this.pos.length) {
      const cap = Math.max(4096, this.pos.length * 2);
      const p = new Float32Array(cap), q = new Float32Array(cap);
      p.set(this.pos); q.set(this.col);
      this.pos = p; this.col = q;
    }
    const i = this.n * 3;
    this.pos[i] = ax; this.pos[i + 1] = ay; this.pos[i + 2] = az;
    this.pos[i + 3] = bx; this.pos[i + 4] = by; this.pos[i + 5] = bz;
    this.col[i] = c.r; this.col[i + 1] = c.g; this.col[i + 2] = c.b;
    this.col[i + 3] = c.r; this.col[i + 4] = c.g; this.col[i + 5] = c.b;
    this.n += 2;
  }

  /** Draws the closed XZ polygon `pts` (x, z pairs) at heights y0 · y1, plus a vertical at every vertex. */
  private prism(pts: ArrayLike<number>, y0: number, y1: number, c: THREE.Color, verticals = true): void {
    const k = pts.length / 2;
    for (let i = 0; i < k; i++) {
      const j = (i + 1) % k;
      const ax = pts[i * 2], az = pts[i * 2 + 1], bx = pts[j * 2], bz = pts[j * 2 + 1];
      this.seg(ax, y0, az, bx, y0, bz, c);
      this.seg(ax, y1, az, bx, y1, bz, c);
      if (verticals) this.seg(ax, y0, az, ax, y1, az, c);
    }
  }

  private cylinder(o: Obstacle): void {
    const y0 = o.position.y, y1 = o.position.y + o.height;
    const pts = new Float32Array(CIRCLE_SEGS * 2);
    for (let i = 0; i < CIRCLE_SEGS; i++) {
      const a = (i / CIRCLE_SEGS) * Math.PI * 2;
      pts[i * 2] = o.position.x + Math.cos(a) * o.radius;
      pts[i * 2 + 1] = o.position.z + Math.sin(a) * o.radius;
    }
    const k = CIRCLE_SEGS;
    for (let i = 0; i < k; i++) {
      const j = (i + 1) % k;
      this.seg(pts[i * 2], y0, pts[i * 2 + 1], pts[j * 2], y0, pts[j * 2 + 1], COLOR_CYLINDER);
      this.seg(pts[i * 2], y1, pts[i * 2 + 1], pts[j * 2], y1, pts[j * 2 + 1], COLOR_CYLINDER);
      if (i % 4 === 0) this.seg(pts[i * 2], y0, pts[i * 2 + 1], pts[i * 2], y1, pts[i * 2 + 1], COLOR_CYLINDER);
    }
  }

  /** The box's four corners (XZ) — math-convention yaw, local (±halfX, ±halfZ). */
  private corners(o: Obstacle): Float32Array {
    const b = o.box!;
    const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
    const out = new Float32Array(8);
    const local = [[-b.halfX, -b.halfZ], [b.halfX, -b.halfZ], [b.halfX, b.halfZ], [-b.halfX, b.halfZ]];
    for (let i = 0; i < 4; i++) {
      const [lx, lz] = local[i];
      out[i * 2] = o.position.x + lx * c - lz * s;
      out[i * 2 + 1] = o.position.z + lx * s + lz * c;
    }
    return out;
  }

  private box(o: Obstacle): void {
    this.prism(this.corners(o), o.position.y, o.position.y + o.height, COLOR_BOX);
  }

  /** Ramp: the bottom rectangle + the tilted top face (the local −X end is `rise` lower) + verticals. */
  private ramp(o: Obstacle): void {
    const p = this.corners(o);
    const y0 = o.position.y, hi = o.position.y + o.height, lo = hi - o.ramp!.rise;
    // Corner order: 0 (−X,−Z) · 1 (+X,−Z) · 2 (+X,+Z) · 3 (−X,+Z)
    const top = [lo, hi, hi, lo];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      this.seg(p[i * 2], y0, p[i * 2 + 1], p[j * 2], y0, p[j * 2 + 1], COLOR_RAMP);
      this.seg(p[i * 2], top[i], p[i * 2 + 1], p[j * 2], top[j], p[j * 2 + 1], COLOR_RAMP);
      this.seg(p[i * 2], y0, p[i * 2 + 1], p[i * 2], top[i], p[i * 2 + 1], COLOR_RAMP);
    }
  }

  private hull(o: Obstacle): void {
    const h = o.hull!;
    this.prism(h.points, o.position.y, o.position.y + o.height, COLOR_HULL);
    if (h.bands) for (const b of h.bands) this.prism(b.points, b.y0, b.y1, COLOR_BAND, false);
  }
}
