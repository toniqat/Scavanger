import * as THREE from 'three';
import { FxManager, ParticleBurst } from '@/core/fx';

/** Pooled beam visuals per owner ('local' or a peer id). */
const CONES = 4;
const ARCS = 4;
/** Arc bolts per owner and jagged segments per bolt. */
export const ARC_BOLTS = 4;
const ARC_SEGS = 9;
const FLAME_COLOR = 0xff6a1e;
const FLAME_CORE = 0xffd27a;
const ARC_COLOR = 0x7fe8ff;
const ARC_CORE = 0xe8fbff;

interface Cone {
  owner: string | null;
  touched: number;
  outer: THREE.Mesh;
  inner: THREE.Mesh;
  outerMat: THREE.MeshBasicMaterial;
  innerMat: THREE.MeshBasicMaterial;
  origin: THREE.Vector3;
  dir: THREE.Vector3;
  length: number;
  halfAngle: number;
  emberT: number;
}

interface Arc {
  owner: string | null;
  touched: number;
  geo: THREE.BufferGeometry;
  positions: Float32Array;
  attr: THREE.BufferAttribute;
  glow: THREE.LineSegments;
  core: THREE.LineSegments;
  count: number;
  sparkT: number;
  /** Bolt end points, copied each frame (the enemies' own vectors move on). */
  ends: THREE.Vector3[];
  origin: THREE.Vector3;
}

const _look = new THREE.Vector3(), _p = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _n = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/**
 * Unique-weapon beam FX: additive flame cones (LMB spray / RMB jet) and jagged lightning arcs (shock gun),
 * pooled per owner so the local player and remote replicas share the same meshes. No lights (constant light
 * count — see the grenade hitch note in the README); buffers are preallocated and rewritten in place.
 *
 * Callers `set*()` every frame while the beam is on; anything not touched this frame is hidden in `update()`.
 */
export class UniqueFx {
  readonly group = new THREE.Group();
  private readonly cones: Cone[] = [];
  private readonly arcs: Arc[] = [];
  private readonly coneGeo: THREE.ConeGeometry;
  private readonly arcGlowMat = new THREE.LineBasicMaterial({ color: ARC_COLOR, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  private readonly arcCoreMat = new THREE.LineBasicMaterial({ color: ARC_CORE, transparent: true, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  private frame = 0;
  private time = 0;

  constructor(scene: THREE.Scene) {
    this.group.name = 'UniqueWeaponFX';
    // unit cone: apex at the origin, base at z = +1 (radius 1) — scaled per beam, `lookAt` points +Z down the beam
    const g = new THREE.ConeGeometry(1, 1, 14, 1, true);
    g.rotateX(-Math.PI / 2);
    g.translate(0, 0, 0.5);
    this.coneGeo = g;
    for (let i = 0; i < CONES; i++) {
      const outerMat = new THREE.MeshBasicMaterial({ color: FLAME_COLOR, transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false });
      const innerMat = new THREE.MeshBasicMaterial({ color: FLAME_CORE, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false });
      const outer = new THREE.Mesh(g, outerMat);
      const inner = new THREE.Mesh(g, innerMat);
      outer.visible = inner.visible = false;
      outer.renderOrder = 24; inner.renderOrder = 25;
      outer.frustumCulled = inner.frustumCulled = false;
      this.group.add(outer, inner);
      this.cones.push({ owner: null, touched: -1, outer, inner, outerMat, innerMat, origin: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, -1), length: 1, halfAngle: 0.2, emberT: 0 });
    }
    for (let i = 0; i < ARCS; i++) {
      const positions = new Float32Array(ARC_BOLTS * ARC_SEGS * 2 * 3);
      const geo = new THREE.BufferGeometry();
      const attr = new THREE.BufferAttribute(positions, 3);
      attr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('position', attr);
      geo.setDrawRange(0, 0);
      const glow = new THREE.LineSegments(geo, this.arcGlowMat);
      const core = new THREE.LineSegments(geo, this.arcCoreMat);
      glow.visible = core.visible = false;
      glow.frustumCulled = core.frustumCulled = false;
      glow.renderOrder = 26; core.renderOrder = 27;
      this.group.add(glow, core);
      const ends: THREE.Vector3[] = [];
      for (let k = 0; k < ARC_BOLTS; k++) ends.push(new THREE.Vector3());
      this.arcs.push({ owner: null, touched: -1, geo, positions, attr, glow, core, count: 0, sparkT: 0, ends, origin: new THREE.Vector3() });
    }
    scene.add(this.group);
  }

  private acquire<T extends { owner: string | null; touched: number }>(pool: T[], owner: string): T {
    let free: T | null = null;
    for (const e of pool) {
      if (e.owner === owner) return e;
      if (!free && e.owner === null) free = e;
    }
    if (!free) free = pool[0];
    free.owner = owner;
    return free;
  }

  /** Flame cone for `owner` this frame: apex at `origin`, along `dir`, `length` m, `halfAngle` rad. */
  setFlame(owner: string, origin: THREE.Vector3, dir: THREE.Vector3, length: number, halfAngle: number): void {
    const c = this.acquire(this.cones, owner);
    c.touched = this.frame;
    c.origin.copy(origin); c.dir.copy(dir); c.length = length; c.halfAngle = halfAngle;
    c.outer.visible = c.inner.visible = true;
  }

  /** Lightning arcs for `owner` this frame from `origin` to each of `targets[0..count)`. */
  setArc(owner: string, origin: THREE.Vector3, targets: readonly THREE.Vector3[], count: number): void {
    const a = this.acquire(this.arcs, owner);
    a.touched = this.frame;
    a.count = Math.min(count, ARC_BOLTS);
    a.origin.copy(origin);
    for (let i = 0; i < a.count; i++) a.ends[i].copy(targets[i]);
    a.glow.visible = a.core.visible = a.count > 0;
  }

  /** Stop a specific owner's beams right away (weapon put away, peer left). */
  release(owner: string): void {
    for (const c of this.cones) if (c.owner === owner) this.hideCone(c);
    for (const a of this.arcs) if (a.owner === owner) this.hideArc(a);
  }

  update(dt: number): void {
    this.frame++;
    this.time += dt;
    const fx = FxManager.get();
    const t = this.time;
    for (const c of this.cones) {
      if (c.owner === null) continue;
      // a beam that was not refreshed since the last frame is over (owners call set* every frame)
      if (this.frame - c.touched > 1) { this.hideCone(c); continue; }
      const flicker = 0.85 + 0.15 * Math.sin(t * 31 + c.origin.x) * Math.sin(t * 17);
      const len = c.length * (0.92 + 0.08 * Math.sin(t * 23 + c.origin.z));
      const r = Math.tan(c.halfAngle) * len;
      c.outer.position.copy(c.origin);
      _look.copy(c.origin).add(c.dir);
      c.outer.lookAt(_look);
      c.outer.scale.set(r * 1.05, r * 1.05, len);
      c.inner.position.copy(c.origin);
      c.inner.quaternion.copy(c.outer.quaternion);
      c.inner.scale.set(r * 0.45, r * 0.45, len * 0.75);
      c.outerMat.opacity = 0.3 * flicker;
      c.innerMat.opacity = 0.5 * flicker;
      // embers drifting off the flame body
      c.emberT -= dt;
      if (fx && c.emberT <= 0) {
        c.emberT = 0.05;
        const along = 0.25 + Math.random() * 0.7;
        _p.copy(c.origin).addScaledVector(c.dir, len * along);
        _p.x += (Math.random() - 0.5) * r * along; _p.y += (Math.random() - 0.5) * r * along; _p.z += (Math.random() - 0.5) * r * along;
        ParticleBurst.sparks(fx.additive, _p, c.dir, 2, 3.5, 0xff8a30);
        if (Math.random() < 0.35) ParticleBurst.smoke(fx.alpha, _p, 1, 0.35, 0x3a2a22);
      }
    }
    for (const a of this.arcs) {
      if (a.owner === null) continue;
      if (this.frame - a.touched > 1) { this.hideArc(a); continue; }
      const pos = a.positions;
      let w = 0;
      for (let i = 0; i < a.count; i++) {
        const end = a.ends[i];
        _n.subVectors(end, a.origin);
        const dist = _n.length();
        if (dist < 1e-3) continue;
        _n.divideScalar(dist);
        // perpendicular basis for the jitter
        _a.set(0, 1, 0); if (Math.abs(_n.y) > 0.99) _a.set(1, 0, 0);
        _a.cross(_n).normalize();
        _b.crossVectors(_n, _a);
        const amp = Math.min(0.9, 0.05 + dist * 0.07);
        let px = a.origin.x, py = a.origin.y, pz = a.origin.z;
        for (let s = 1; s <= ARC_SEGS; s++) {
          const f = s / ARC_SEGS;
          const jit = s === ARC_SEGS ? 0 : amp * Math.sin(f * Math.PI);
          const ja = (Math.random() - 0.5) * 2 * jit, jb = (Math.random() - 0.5) * 2 * jit;
          const x = a.origin.x + _n.x * dist * f + _a.x * ja + _b.x * jb;
          const y = a.origin.y + _n.y * dist * f + _a.y * ja + _b.y * jb;
          const z = a.origin.z + _n.z * dist * f + _a.z * ja + _b.z * jb;
          pos[w++] = px; pos[w++] = py; pos[w++] = pz;
          pos[w++] = x; pos[w++] = y; pos[w++] = z;
          px = x; py = y; pz = z;
        }
      }
      a.geo.setDrawRange(0, w / 3);
      a.attr.needsUpdate = true;
      a.sparkT -= dt;
      if (fx && a.sparkT <= 0 && a.count > 0) {
        a.sparkT = 0.09;
        for (let i = 0; i < a.count; i++) ParticleBurst.sparks(fx.additive, a.ends[i], _up, 2, 4, 0x9ff4ff);
      }
    }
  }

  private hideCone(c: Cone): void { c.owner = null; c.outer.visible = c.inner.visible = false; }
  private hideArc(a: Arc): void { a.owner = null; a.count = 0; a.glow.visible = a.core.visible = false; a.geo.setDrawRange(0, 0); }

  clear(): void {
    for (const c of this.cones) this.hideCone(c);
    for (const a of this.arcs) this.hideArc(a);
  }

  dispose(): void {
    this.clear();
    this.coneGeo.dispose();
    for (const c of this.cones) { c.outerMat.dispose(); c.innerMat.dispose(); }
    for (const a of this.arcs) a.geo.dispose();
    this.arcGlowMat.dispose(); this.arcCoreMat.dispose();
    this.group.removeFromParent();
  }
}
