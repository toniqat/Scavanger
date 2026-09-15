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
/*
 * 2026-09-15 화염 호흡 (visual only — the damage cone is the handler's `range` / `halfAngle`). A cone that appears
 * (freshly acquired, or its length changed — LMB spray ↔ RMB jet) blooms from `FLAME_GROW_FROM` of its size to full over
 * `FLAME_GROW_S` (ease-out). While on, radius and length breathe on layered incommensurate sines with a per-cone phase
 * seed (± ~`FLAME_BREATH_RAD` / `FLAME_BREATH_LEN` in total), the hot core on its own phase, so the fire reads as roaring.
 */
const FLAME_GROW_S = 0.26;
const FLAME_GROW_FROM = 0.12;
const FLAME_BREATH_LEN = 0.15;
const FLAME_BREATH_RAD = 0.12;

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
  /** 2026-09-15: `UniqueFx.time` when this cone (re)appeared — drives the bloom-in — and its breathing phase seed. */
  bornT: number;
  seed: number;
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
  /** Sparks at the bolt ends (false for a shock arc that found nothing and discharges into the air / a wall). */
  sparks: boolean;
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
      this.cones.push({ owner: null, touched: -1, outer, inner, outerMat, innerMat, origin: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, -1), length: 1, halfAngle: 0.2, emberT: 0, bornT: 0, seed: i * 17.3 });
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
      this.arcs.push({ owner: null, touched: -1, geo, positions, attr, glow, core, count: 0, sparkT: 0, sparks: true, ends, origin: new THREE.Vector3() });
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
    let had = false;
    for (let i = 0; i < this.cones.length; i++) if (this.cones[i].owner === owner) { had = true; break; }
    const c = this.acquire(this.cones, owner);
    // 2026-09-15: a cone that just appeared (or switched spray ↔ jet) blooms in from small instead of popping at full size
    if (!had || !c.outer.visible || Math.abs(length - c.length) > 0.2 * Math.max(c.length, 1e-3)) {
      c.bornT = this.time;
      c.seed = Math.random() * 100;
    }
    c.touched = this.frame;
    c.origin.copy(origin); c.dir.copy(dir); c.length = length; c.halfAngle = halfAngle;
    c.outer.visible = c.inner.visible = true;
  }

  /**
   * Lightning arcs for `owner` this frame from `origin` to each of `targets[0..count)`. `sparks` false = no spark
   * bursts at the ends (2026-09-14: the shock gun's forked discharge when nothing is in its cone).
   */
  setArc(owner: string, origin: THREE.Vector3, targets: readonly THREE.Vector3[], count: number, sparks = true): void {
    const a = this.acquire(this.arcs, owner);
    a.touched = this.frame;
    a.sparks = sparks;
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
      const s = c.seed;
      const flicker = 0.8 + 0.2 * Math.sin(t * 31 + s) * Math.sin(t * 17 + s * 0.5);
      // bloom-in: ease-out from FLAME_GROW_FROM to full size over FLAME_GROW_S after the cone appeared
      const g = Math.min(1, Math.max(0, (t - c.bornT) / FLAME_GROW_S));
      const grow = FLAME_GROW_FROM + (1 - FLAME_GROW_FROM) * (1 - (1 - g) * (1 - g) * (1 - g));
      // breathing: three incommensurate sines each for length and radius (weights sum to 1), the core on its own phase
      const bl = 0.47 * Math.sin(t * 5.3 + s) + 0.33 * Math.sin(t * 11.7 + s * 1.7) + 0.2 * Math.sin(t * 23.1 + s * 2.3);
      const br = 0.45 * Math.sin(t * 4.1 + s * 0.7 + 1.3) + 0.33 * Math.sin(t * 9.3 + s * 1.3) + 0.22 * Math.sin(t * 19.7 + s * 3.1);
      const bc = 0.6 * Math.sin(t * 7.7 + s * 2.9) + 0.4 * Math.sin(t * 15.3 + s * 0.3);
      const len = c.length * grow * (1 + FLAME_BREATH_LEN * bl);
      const r = Math.tan(c.halfAngle) * len * (1 + FLAME_BREATH_RAD * br);
      c.outer.position.copy(c.origin);
      _look.copy(c.origin).add(c.dir);
      c.outer.lookAt(_look);
      c.outer.scale.set(r * 1.05, r * 1.05, len);
      c.inner.position.copy(c.origin);
      c.inner.quaternion.copy(c.outer.quaternion);
      const core = 1 + 0.12 * bc;
      c.inner.scale.set(r * 0.45 * core, r * 0.45 * core, len * 0.75 * (1 + 0.08 * bc));
      c.outerMat.opacity = 0.3 * flicker * (0.55 + 0.45 * grow);
      c.innerMat.opacity = 0.5 * flicker * (0.55 + 0.45 * grow);
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
      if (fx && a.sparks && a.sparkT <= 0 && a.count > 0) {
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
