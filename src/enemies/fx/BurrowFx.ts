/**
 * src/enemies/fx/BurrowFx.ts — **the FX of digging up out of the ground** (2026-09-13).
 *
 * The question this file answers: *how does the ground look while a bug comes up out of it, and before a sandworm rises.*
 *
 * - **Dust · clods** make no new draw call — they go into `core/fx`'s alpha particle pool (`FxManager.alpha`, one
 *   `THREE.Points` the engine puts in the scene from the start = already compiled). A clod = a small dark particle that leaps
 *   up, falls and stops on the ground; dust = large and spreads slowly. Colour from the surface (`WorldRef.getSurfaceMaterial`).
 * - **Emitters** are a fixed pool (`EMITTERS`). One burrow = a small emitter (for the time it takes to come up), a sandworm
 *   warning = a big one (building up). Full → the oldest is overwritten. No per-frame allocation (one spawn-argument scratch).
 * - **The warning ring** is an additive band drawing the damage radius (the same trick as `ScanPulseFx`'s ground band — a short
 *   open cylinder crosses the terrain and reads as a **red line grazing the ground**). Mesh · material are made once in the
 *   constructor and left hidden in the scene, so they are in `world:ready`'s shader pre-compile. **There are no lights.**
 * Screen shake · sound are not this file's (`parts/Burrow` · `sandworm/Director` — the shake de-duplication happens there).
 */
import * as THREE from 'three';
import { Layers, type SurfaceMaterial, type WorldRef } from '@/shared';
import { FxManager, type ParticleSpawn } from '@/core/fx';

/** How many emitters are alive at once. */
const EMITTERS = 24;
/** Warning ring count (in practice there is only one warning at a time). */
const RINGS = 2;
/** Vertical width of the warning ring's band (m). */
const RING_BAND_H = 4;
const RING_COLOR = new THREE.Color(1.0, 0.34, 0.08);

/* Material → dust colour (a drawing number). Unknown = dirt. */
const DUST_COLOR: Readonly<Record<SurfaceMaterial, number>> = {
  dirt: 0x8a7560, sand: 0xc2a878, snow: 0xdfe4e8, mud: 0x5c4a38, moss: 0x66704a, ash: 0x5f5b58,
  rock: 0x7b766f, crystal: 0x93a6b8, organic: 0x6e5448, metal: 0x86857f, concrete: 0x8c8a84,
};
const DEFAULT_DUST = 0x8a7560;

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;

/** A band bright only at its vertical centre + stripes running around it (faster as the progress rises). */
const RING_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor;
uniform float uAlpha;
uniform float uTime;
varying vec2 vUv;
void main() {
  #include <logdepthbuf_fragment>
  float c = 1.0 - abs(vUv.y * 2.0 - 1.0);
  float stripe = 0.55 + 0.45 * sin(vUv.x * 96.0 - uTime * 4.0);
  float a = (pow(c, 14.0) * 0.95 * stripe + pow(c, 3.0) * 0.1) * uAlpha;
  gl_FragColor = vec4(uColor, a);
}`;

interface Emitter {
  active: boolean;
  /** 0 burrow · 1 warning. */
  kind: 0 | 1;
  readonly p: THREE.Vector3;
  scale: number;
  radius: number;
  start: number;
  dur: number;
  clodAcc: number;
  dustAcc: number;
  r: number; g: number; b: number;
}

interface Ring {
  readonly mesh: THREE.Mesh;
  readonly mat: THREE.ShaderMaterial;
  active: boolean;
  start: number;
  dur: number;
  radius: number;
}

/** Particle spawn argument scratch — `ParticlePool.spawn` copies the values, so one is reused over and over. */
const S: Required<ParticleSpawn> = {
  x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, size: 0.2, sizeEnd: 1,
  r: 1, g: 1, b: 1, rEnd: 1, gEnd: 1, bEnd: 1, gravity: 0, drag: 0, alpha: 1, groundY: 0,
};
const _rgb = new THREE.Color();

/** Dust colour of the material underfoot → `_rgb`. No world, or an unknown material, = dirt. */
function surfaceColor(world: WorldRef | null, p: THREE.Vector3): void {
  const m = world && world.ready ? world.getSurfaceMaterial?.(p.x, p.z, p.y) : undefined;
  _rgb.setHex((m && DUST_COLOR[m]) ?? DEFAULT_DUST);
}

export class BurrowFx {
  private readonly emitters: Emitter[] = [];
  private readonly rings: Ring[] = [];
  private readonly ringGeo = new THREE.CylinderGeometry(1, 1, 1, 72, 1, true);
  private readonly group = new THREE.Group();
  private live = 0;
  /** Debug · smoke: how many burrow FX have started so far. */
  emergeCount = 0;

  constructor(private readonly scene: THREE.Scene) {
    for (let i = 0; i < EMITTERS; i++) {
      this.emitters.push({ active: false, kind: 0, p: new THREE.Vector3(), scale: 1, radius: 1, start: 0, dur: 1, clodAcc: 0, dustAcc: 0, r: 0.5, g: 0.45, b: 0.38 });
    }
    this.group.name = 'burrowFx';
    for (let i = 0; i < RINGS; i++) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: VERT, fragmentShader: RING_FRAG,
        uniforms: { uColor: { value: RING_COLOR.clone() }, uAlpha: { value: 0 }, uTime: { value: 0 } },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(this.ringGeo, mat);
      mesh.visible = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.renderOrder = 18;
      mesh.layers.enable(Layers.NO_RAYCAST);
      this.group.add(mesh);
      this.rings.push({ mesh, mat, active: false, start: 0, dur: 1, radius: 1 });
    }
    scene.add(this.group);
  }

  /** Live emitter count (debug). */
  get activeEmitters(): number { return this.live; }
  /** Is a warning ring visible (debug). */
  get ringVisible(): boolean { for (const r of this.rings) if (r.active) return true; return false; }

  /**
   * One bug digs out: a ring of dust underfoot at once + clods · dust rising for `dur`. `scale` ≈ body size (0.7 … 3).
   */
  emerge(p: THREE.Vector3, scale: number, dur: number, world: WorldRef | null, now: number): void {
    const em = this.claim();
    em.kind = 0; em.p.copy(p); em.scale = scale; em.radius = 0.5 * scale; em.start = now; em.dur = Math.max(0.2, dur);
    em.clodAcc = 0; em.dustAcc = 0;
    this.colorAt(em, world);
    this.emergeCount++;
    const fx = FxManager.get();
    if (!fx) return;
    // the first instant: dust spreading underfoot in a ring (as wide as the body)
    const n = Math.round(8 + 6 * scale);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.4;
      const s = (1.2 + Math.random() * 1.6) * Math.sqrt(scale);
      this.dust(fx, em, p.x + Math.cos(a) * 0.3 * scale, p.y + 0.1, p.z + Math.sin(a) * 0.3 * scale, Math.cos(a) * s, 0.6 + Math.random() * 0.8, Math.sin(a) * s, (0.35 + Math.random() * 0.3) * scale);
    }
  }

  /** Sandworm warning: a ring drawing `radius` + churned soil · dust building up at the centre (`dur` seconds). */
  warn(p: THREE.Vector3, radius: number, dur: number, world: WorldRef | null, now: number, elapsed = 0): void {
    const em = this.claim();
    em.kind = 1; em.p.copy(p); em.scale = 1; em.radius = radius; em.start = now - elapsed; em.dur = Math.max(0.5, dur + elapsed);
    em.clodAcc = 0; em.dustAcc = 0;
    this.colorAt(em, world);
    let ring: Ring | null = null;
    for (const r of this.rings) { if (!r.active) { ring = r; break; } if (!ring || r.start < ring.start) ring = r; }
    if (!ring) return;
    ring.active = true; ring.start = em.start; ring.dur = em.dur; ring.radius = radius;
    ring.mesh.position.copy(p);
    ring.mesh.scale.set(radius, RING_BAND_H, radius);
    ring.mat.uniforms.uAlpha.value = 0;
    ring.mesh.visible = true;
  }

  /** Ends the warning (eruption · cancel). Turns off the ring and the warning emitter. */
  endWarn(): void {
    for (const r of this.rings) if (r.active) { r.active = false; r.mesh.visible = false; }
    for (const em of this.emitters) if (em.active && em.kind === 1) this.release(em);
  }

  /** Eruption: a soil blast spreading out to the radius + smoke + clods flying everywhere (once). */
  erupt(p: THREE.Vector3, radius: number, world: WorldRef | null): void {
    const fx = FxManager.get();
    if (!fx) return;
    surfaceColor(world, p);
    const cr = _rgb.r, cg = _rgb.g, cb = _rgb.b;
    const ring = Math.round(70 + radius * 4);
    for (let i = 0; i < ring; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = radius * (0.9 + Math.random() * 0.9);
      this.spawnRaw(fx, p.x + Math.cos(a) * 1.5, p.y + Math.random() * 1.2, p.z + Math.sin(a) * 1.5,
        Math.cos(a) * s, 2 + Math.random() * 6, Math.sin(a) * s,
        1.4 + Math.random() * 1.2, 0.9 + Math.random() * 0.9, 3, cr, cg, cb, 0.8, 2.5, 2.2, 0.65, p.y);
    }
    for (let i = 0; i < 26; i++) {
      this.spawnRaw(fx, p.x + (Math.random() - 0.5) * 3, p.y + 1 + Math.random() * 4, p.z + (Math.random() - 0.5) * 3,
        (Math.random() - 0.5) * 5, 5 + Math.random() * 8, (Math.random() - 0.5) * 5,
        2 + Math.random() * 1.6, 1.8 + Math.random() * 1.4, 2.6, cr * 0.7, cg * 0.7, cb * 0.7, 1.1, -0.6, 1.4, 0.5, -1e9);
    }
    for (let i = 0; i < 90; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 6 + Math.random() * 12;
      this.spawnRaw(fx, p.x + Math.cos(a) * 0.8, p.y + 0.5 + Math.random() * 2, p.z + Math.sin(a) * 0.8,
        Math.cos(a) * s * 0.6, 9 + Math.random() * 12, Math.sin(a) * s * 0.6,
        1.1 + Math.random() * 0.6, 0.22 + Math.random() * 0.22, 1, cr * 0.45, cg * 0.42, cb * 0.4, 1, 20, 0.2, 1, p.y);
    }
  }

  /** A spat bug landed: a handful of dust underfoot. */
  puff(p: THREE.Vector3, scale: number, world: WorldRef | null): void {
    const fx = FxManager.get();
    if (!fx) return;
    surfaceColor(world, p);
    const cr = _rgb.r, cg = _rgb.g, cb = _rgb.b;
    const n = Math.round(8 + 4 * scale);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 1.5 + Math.random() * 2.5;
      this.spawnRaw(fx, p.x, p.y + 0.15, p.z, Math.cos(a) * s, 0.5 + Math.random(), Math.sin(a) * s,
        0.6 + Math.random() * 0.5, (0.3 + Math.random() * 0.3) * scale, 2.4, cr, cg, cb, 0.7, 1.2, 3.5, 0.55, p.y);
    }
  }

  update(now: number, dt: number): void {
    const ringsOn = this.ringVisible;
    if (ringsOn) {
      for (const r of this.rings) {
        if (!r.active) continue;
        const t = (now - r.start) / r.dur;
        if (t >= 1.05) { r.active = false; r.mesh.visible = false; continue; }
        const k = THREE.MathUtils.clamp(t, 0, 1);
        r.mat.uniforms.uTime.value = now * (1 + 2.5 * k);
        r.mat.uniforms.uAlpha.value = Math.min(1, t / 0.15) * (0.35 + 0.65 * k) * (0.8 + 0.2 * Math.sin(now * (6 + 14 * k)));
      }
    }
    if (this.live === 0 || dt <= 0) return;
    const fx = FxManager.get();
    for (let i = 0; i < this.emitters.length; i++) {
      const em = this.emitters[i];
      if (!em.active) continue;
      const t = (now - em.start) / em.dur;
      if (t >= 1) { this.release(em); continue; }
      if (!fx) continue;
      if (em.kind === 0) {
        // burrow: strongest at the start, dying down as the body comes out
        const k = 1 - t;
        em.clodAcc += dt * (10 + 16 * em.scale) * k;
        em.dustAcc += dt * (4 + 5 * em.scale) * k;
        while (em.clodAcc >= 1) { em.clodAcc -= 1; this.clod(fx, em, em.radius, 1); }
        while (em.dustAcc >= 1) { em.dustAcc -= 1; this.dustAt(fx, em, em.radius * 1.4, 0.5 * em.scale); }
      } else {
        // warning: builds up with progress², and the churned spot spreads from the centre toward the radius. Dust rises at the rim too.
        const k = THREE.MathUtils.clamp(t, 0, 1);
        const spread = em.radius * (0.15 + 0.45 * k);
        em.clodAcc += dt * (8 + 110 * k * k);
        em.dustAcc += dt * (4 + 36 * k * k);
        while (em.clodAcc >= 1) { em.clodAcc -= 1; this.clod(fx, em, spread, 1 + 0.8 * k); }
        while (em.dustAcc >= 1) {
          em.dustAcc -= 1;
          if (Math.random() < 0.35) this.rimDust(fx, em);
          else this.dustAt(fx, em, spread, 0.9 + 0.9 * k);
        }
      }
    }
  }

  /** Mission reset: turns everything off (mesh · material stay in the pool). */
  clear(): void {
    for (const em of this.emitters) em.active = false;
    for (const r of this.rings) { r.active = false; r.mesh.visible = false; }
    this.live = 0;
    this.emergeCount = 0;
  }

  dispose(): void {
    this.clear();
    this.scene.remove(this.group);
    for (const r of this.rings) r.mat.dispose();
    this.rings.length = 0;
    this.ringGeo.dispose();
  }

  /* ── internals ────────────────────────────────────────────────────────── */
  private claim(): Emitter {
    let pick: Emitter | null = null;
    for (const em of this.emitters) {
      if (!em.active) { pick = em; break; }
      if (em.kind === 0 && (!pick || em.start < pick.start)) pick = em;   // a warning emitter is never overwritten
    }
    const em = pick ?? this.emitters[0];
    if (!em.active) this.live++;
    em.active = true;
    return em;
  }

  private release(em: Emitter): void {
    em.active = false;
    if (this.live > 0) this.live--;
  }

  private colorAt(em: Emitter, world: WorldRef | null): void {
    surfaceColor(world, em.p);
    em.r = _rgb.r; em.g = _rgb.g; em.b = _rgb.b;
  }

  /** A clod: small and dark, leaps up, falls and stops on the ground. */
  private clod(fx: FxManager, em: Emitter, spread: number, power: number): void {
    const a = Math.random() * Math.PI * 2;
    const d = Math.random() * spread;
    const out = 0.8 + Math.random() * 2.2;
    this.spawnRaw(fx, em.p.x + Math.cos(a) * d, em.p.y + 0.1, em.p.z + Math.sin(a) * d,
      Math.cos(a) * out * power, (3 + Math.random() * 4) * power, Math.sin(a) * out * power,
      0.7 + Math.random() * 0.5, 0.1 + Math.random() * 0.14 * Math.min(2, em.scale), 1,
      em.r * 0.55, em.g * 0.5, em.b * 0.45, 1, 18, 0.3, 1, em.p.y);
  }

  private dustAt(fx: FxManager, em: Emitter, spread: number, size: number): void {
    const a = Math.random() * Math.PI * 2;
    const d = Math.random() * spread;
    this.dust(fx, em, em.p.x + Math.cos(a) * d, em.p.y + 0.2, em.p.z + Math.sin(a) * d,
      Math.cos(a) * (0.6 + Math.random()), 0.8 + Math.random() * 1.2, Math.sin(a) * (0.6 + Math.random()), size * (0.6 + Math.random() * 0.6));
  }

  /** Dust at the warning ring's rim — how far the danger reaches reads from the ground too. */
  private rimDust(fx: FxManager, em: Emitter): void {
    const a = Math.random() * Math.PI * 2;
    const r = em.radius * (0.92 + Math.random() * 0.12);
    this.dust(fx, em, em.p.x + Math.cos(a) * r, em.p.y + 0.15, em.p.z + Math.sin(a) * r,
      (Math.random() - 0.5) * 0.6, 0.6 + Math.random() * 0.9, (Math.random() - 0.5) * 0.6, 0.6 + Math.random() * 0.5);
  }

  private dust(fx: FxManager, em: Emitter, x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number): void {
    this.spawnRaw(fx, x, y, z, vx, vy, vz, 0.7 + Math.random() * 0.7, size, 2.6, em.r, em.g, em.b, 0.75, 1.0, 3.2, 0.5, -1e9);
  }

  private spawnRaw(fx: FxManager, x: number, y: number, z: number, vx: number, vy: number, vz: number,
    life: number, size: number, sizeEnd: number, r: number, g: number, b: number, endMul: number,
    gravity: number, drag: number, alpha: number, groundY: number): void {
    S.x = x; S.y = y; S.z = z; S.vx = vx; S.vy = vy; S.vz = vz;
    S.life = life; S.size = size; S.sizeEnd = sizeEnd;
    S.r = r; S.g = g; S.b = b; S.rEnd = r * endMul; S.gEnd = g * endMul; S.bEnd = b * endMul;
    S.gravity = gravity; S.drag = drag; S.alpha = alpha; S.groundY = groundY;
    fx.alpha.spawn(S);
  }
}
