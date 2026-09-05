import * as THREE from 'three';
import { GRAVITY, Layers, type WorldRef } from '@/shared';

/** `ember` is particle-only (burning bugs); `splat` falls back to the acid decal for it. */
export type SplatKind = 'blood' | 'acid' | 'ember';

const MAX_PARTICLES = 1600;
const MAX_DECALS = 40;
const DECAL_LIFE = 20;

const _v = new THREE.Vector3();
const _c = new THREE.Color();

function makeSplatTexture(r: number, g: number, b: number): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx2d = canvas.getContext('2d')!;
  const grad = ctx2d.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, `rgba(${r},${g},${b},0.95)`);
  grad.addColorStop(0.45, `rgba(${r},${g},${b},0.8)`);
  grad.addColorStop(0.75, `rgba(${r},${g},${b},0.35)`);
  grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx2d.fillStyle = grad;
  ctx2d.fillRect(0, 0, size, size);
  // irregular droplets around the core
  for (let i = 0; i < 14; i++) {
    const ang = Math.random() * Math.PI * 2;
    const dist = size * (0.25 + Math.random() * 0.22);
    const rad = size * (0.03 + Math.random() * 0.06);
    ctx2d.fillStyle = `rgba(${r},${g},${b},${0.5 + Math.random() * 0.4})`;
    ctx2d.beginPath();
    ctx2d.arc(size / 2 + Math.cos(ang) * dist, size / 2 + Math.sin(ang) * dist, rad, 0, Math.PI * 2);
    ctx2d.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

interface Decal { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; life: number; baseOpacity: number }

/**
 * Pooled gore: one Points cloud for blood/acid droplets (ring-buffer reuse) and a pool of
 * flat gradient decals (splats) that fade out over 20 s. No allocations after construction.
 */
export class BloodFX {
  private readonly points: THREE.Points;
  private readonly geo: THREE.BufferGeometry;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly colAttr: THREE.BufferAttribute;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly vel = new Float32Array(MAX_PARTICLES * 3);
  private readonly life = new Float32Array(MAX_PARTICLES);
  private readonly maxLife = new Float32Array(MAX_PARTICLES);
  private readonly baseCol = new Float32Array(MAX_PARTICLES * 3);
  private readonly settled = new Uint8Array(MAX_PARTICLES);
  private cursor = 0;
  private aliveHigh = 0;
  private readonly material: THREE.PointsMaterial;

  private readonly decals: Decal[] = [];
  private decalCursor = 0;
  private readonly decalGeo = new THREE.PlaneGeometry(1, 1);
  private readonly bloodTex: THREE.CanvasTexture;
  private readonly acidTex: THREE.CanvasTexture;

  constructor(private readonly scene: THREE.Scene) {
    this.pos = new Float32Array(MAX_PARTICLES * 3);
    this.col = new Float32Array(MAX_PARTICLES * 3);
    for (let i = 0; i < MAX_PARTICLES; i++) this.pos[i * 3 + 1] = -9999;
    this.geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3);
    this.colAttr = new THREE.BufferAttribute(this.col, 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', this.posAttr);
    this.geo.setAttribute('color', this.colAttr);
    this.material = new THREE.PointsMaterial({ size: 0.16, vertexColors: true, sizeAttenuation: true, transparent: false, depthWrite: true });
    this.points = new THREE.Points(this.geo, this.material);
    this.points.frustumCulled = false;
    this.points.layers.enable(Layers.NO_RAYCAST);
    this.points.name = 'enemy_gore_points';
    scene.add(this.points);

    this.bloodTex = makeSplatTexture(36, 78, 22);
    this.acidTex = makeSplatTexture(120, 200, 40);
    for (let i = 0; i < MAX_DECALS; i++) {
      const mat = new THREE.MeshBasicMaterial({ map: this.bloodTex, transparent: true, opacity: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      const mesh = new THREE.Mesh(this.decalGeo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      mesh.renderOrder = 2;
      mesh.layers.enable(Layers.NO_RAYCAST);
      scene.add(mesh);
      this.decals.push({ mesh, mat, life: 0, baseOpacity: 0.85 });
    }
  }

  /** Emit a burst of droplets. `dir` (optional, unit) biases the spray; `spread` 0..1. */
  burst(center: THREE.Vector3, count: number, kind: SplatKind, speed = 4, dir?: THREE.Vector3, spread = 1): void {
    if (kind === 'blood') _c.setRGB(0.28, 0.62, 0.16);
    else if (kind === 'ember') _c.setRGB(1.0, 0.45, 0.08);
    else _c.setRGB(0.55, 0.95, 0.2);
    for (let n = 0; n < count; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % MAX_PARTICLES;
      if (i + 1 > this.aliveHigh) this.aliveHigh = i + 1;
      const i3 = i * 3;
      this.pos[i3] = center.x + (Math.random() - 0.5) * 0.3;
      this.pos[i3 + 1] = center.y + (Math.random() - 0.5) * 0.3;
      this.pos[i3 + 2] = center.z + (Math.random() - 0.5) * 0.3;
      // random direction in a sphere, biased by dir
      let dx = Math.random() * 2 - 1, dy = Math.random() * 1.2 + 0.1, dz = Math.random() * 2 - 1;
      const len = Math.hypot(dx, dy, dz) || 1;
      dx /= len; dy /= len; dz /= len;
      if (dir) { dx = dx * spread + dir.x * 1.2; dy = dy * spread + dir.y * 0.6 + 0.35; dz = dz * spread + dir.z * 1.2; }
      const s = speed * (0.4 + Math.random() * 0.9);
      this.vel[i3] = dx * s; this.vel[i3 + 1] = dy * s; this.vel[i3 + 2] = dz * s;
      const l = 0.9 + Math.random() * 1.3;
      this.life[i] = l; this.maxLife[i] = l;
      this.settled[i] = 0;
      const shade = 0.75 + Math.random() * 0.45;
      this.baseCol[i3] = _c.r * shade; this.baseCol[i3 + 1] = _c.g * shade; this.baseCol[i3 + 2] = _c.b * shade;
      this.col[i3] = this.baseCol[i3]; this.col[i3 + 1] = this.baseCol[i3 + 1]; this.col[i3 + 2] = this.baseCol[i3 + 2];
    }
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
  }

  /** Place a ground splat at `pos` (terrain height is sampled). */
  splat(pos: THREE.Vector3, radius: number, kind: SplatKind, world: WorldRef | null): void {
    const d = this.decals[this.decalCursor];
    this.decalCursor = (this.decalCursor + 1) % MAX_DECALS;
    const y = world ? world.getHeightAt(pos.x, pos.z) : pos.y;
    d.mesh.position.set(pos.x, y + 0.04, pos.z);
    d.mesh.rotation.z = Math.random() * Math.PI * 2;
    const s = radius * (1.6 + Math.random() * 0.6);
    d.mesh.scale.set(s, s * (0.8 + Math.random() * 0.4), 1);
    d.mat.map = kind === 'blood' ? this.bloodTex : this.acidTex;
    d.baseOpacity = kind === 'blood' ? 0.85 : 0.75;
    d.mat.opacity = d.baseOpacity;
    d.life = DECAL_LIFE;
    d.mesh.visible = true;
  }

  update(dt: number, world: WorldRef | null): void {
    let any = false;
    const g = GRAVITY * 0.8;
    for (let i = 0; i < this.aliveHigh; i++) {
      if (this.life[i] <= 0) continue;
      any = true;
      const i3 = i * 3;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.pos[i3 + 1] = -9999;
        continue;
      }
      if (!this.settled[i]) {
        this.vel[i3 + 1] -= g * dt;
        this.pos[i3] += this.vel[i3] * dt;
        this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
        this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
        if (world) {
          const h = world.getHeightAt(this.pos[i3], this.pos[i3 + 2]);
          if (this.pos[i3 + 1] < h + 0.03) { this.pos[i3 + 1] = h + 0.03; this.settled[i] = 1; this.life[i] = Math.min(this.life[i], 0.7); }
        }
      }
      const f = Math.min(1, this.life[i] / (this.maxLife[i] * 0.5));
      this.col[i3] = this.baseCol[i3] * f; this.col[i3 + 1] = this.baseCol[i3 + 1] * f; this.col[i3 + 2] = this.baseCol[i3 + 2] * f;
    }
    if (any) { this.posAttr.needsUpdate = true; this.colAttr.needsUpdate = true; }

    for (let i = 0; i < MAX_DECALS; i++) {
      const d = this.decals[i];
      if (!d.mesh.visible) continue;
      d.life -= dt;
      if (d.life <= 0) { d.mesh.visible = false; d.mat.opacity = 0; continue; }
      d.mat.opacity = d.baseOpacity * Math.min(1, d.life / (DECAL_LIFE * 0.6));
    }
  }

  clear(): void {
    for (let i = 0; i < MAX_PARTICLES; i++) { this.life[i] = 0; this.pos[i * 3 + 1] = -9999; }
    this.aliveHigh = 0; this.cursor = 0;
    this.posAttr.needsUpdate = true;
    for (const d of this.decals) { d.mesh.visible = false; d.life = 0; }
  }

  dispose(): void {
    this.scene.remove(this.points);
    this.geo.dispose();
    this.material.dispose();
    for (const d of this.decals) { this.scene.remove(d.mesh); d.mat.dispose(); }
    this.decals.length = 0;
    this.decalGeo.dispose();
    this.bloodTex.dispose();
    this.acidTex.dispose();
  }
}

/** Helper: random point on a unit sphere into out. */
export function randomUnit(out: THREE.Vector3): THREE.Vector3 {
  const z = Math.random() * 2 - 1;
  const t = Math.random() * Math.PI * 2;
  const r = Math.sqrt(1 - z * z);
  return out.set(r * Math.cos(t), z, r * Math.sin(t));
}

export const bloodScratch = _v;
