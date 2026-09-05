import * as THREE from 'three';
import type { StratagemId } from '@/shared';

/**
 * Procedural visuals for ship calls. No lights, no assets: every effect is an emissive / additive mesh or a small
 * `THREE.Points` burst. Geometries live in `SharedGeo` (one instance per system) and are shared across all effects;
 * only the few materials that need per-instance opacity/colour are created per effect and disposed with it.
 */

export const KIND_COLOR: Readonly<Record<StratagemId, number>> = {
  orbital_laser: 0x66e0ff,
  airstrike: 0xff6a3d,
  supply_drop: 0x4dffb8,
  structure_drop: 0xffd24d,
};

export class SharedGeo {
  /** Flat unit ring (inner 0.9, outer 1.0) lying on XZ. */
  readonly ring = new THREE.RingGeometry(0.9, 1, 48).rotateX(-Math.PI / 2);
  readonly thinRing = new THREE.RingGeometry(0.96, 1, 48).rotateX(-Math.PI / 2);
  readonly disc = new THREE.CircleGeometry(1, 24).rotateX(-Math.PI / 2);
  /** Tick mark: 0.08 × 0.5 plane along +Z, base at the origin. */
  readonly tick = new THREE.PlaneGeometry(0.08, 0.5).rotateX(-Math.PI / 2).translate(0, 0, 0.25);
  /** Unit cylinder, base at y = 0, height 1 (scale y for length). */
  readonly column = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true).translate(0, 0.5, 0);
  readonly sphere = new THREE.SphereGeometry(1, 20, 14);
  readonly box = new THREE.BoxGeometry(1, 1, 1);
  readonly cone = new THREE.ConeGeometry(1, 1, 10, 1, true);
  /** Barricade parts (2.6 × 1.5 × 1.1 m overall). */
  readonly barricadeBody = new THREE.BoxGeometry(2.6, 1.2, 0.9);
  readonly barricadeLip = new THREE.BoxGeometry(2.7, 0.3, 1.1);
  readonly barricadeFoot = new THREE.BoxGeometry(2.6, 0.18, 1.3);
  readonly stripe = new THREE.BoxGeometry(2.62, 0.16, 0.92);
  readonly crack = new THREE.BoxGeometry(2.64, 1.24, 0.94);
  readonly rubble = new THREE.BoxGeometry(0.6, 0.35, 0.45);

  dispose(): void {
    for (const g of Object.values(this) as THREE.BufferGeometry[]) g.dispose?.();
  }
}

function basic(color: number, opacity = 1, additive = false): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
}

/* ────────────────────────────── targeting ring ────────────────────────────── */
/** Ground ring + centre disc + 4 tick marks, pulsing. Scaled to the def's radius. */
export class TargetRing {
  readonly group = new THREE.Group();
  private readonly ringMat = basic(0xffffff, 0.85, true);
  private readonly discMat = basic(0xffffff, 0.5, true);
  private readonly ticks: THREE.Mesh[] = [];
  private radius = 1;

  constructor(geo: SharedGeo) {
    const ring = new THREE.Mesh(geo.ring, this.ringMat);
    const disc = new THREE.Mesh(geo.disc, this.discMat);
    disc.scale.setScalar(0.35);
    this.group.add(ring, disc);
    for (let i = 0; i < 4; i++) {
      const t = new THREE.Mesh(geo.tick, this.ringMat);
      t.rotation.y = i * Math.PI / 2;
      this.ticks.push(t);
      this.group.add(t);
    }
    this.group.visible = false;
    this.group.renderOrder = 5;
  }

  setKind(kind: StratagemId, radius: number): void {
    this.ringMat.color.setHex(KIND_COLOR[kind]);
    this.discMat.color.setHex(KIND_COLOR[kind]);
    this.radius = radius;
  }

  show(visible: boolean): void { this.group.visible = visible; }

  animate(position: THREE.Vector3, time: number): void {
    const pulse = 0.5 + 0.5 * Math.sin(time * 6);
    this.group.position.set(position.x, position.y + 0.08, position.z);
    const r = this.radius;
    this.group.children[0].scale.setScalar(r * (1 + pulse * 0.04));
    this.ringMat.opacity = 0.55 + pulse * 0.4;
    for (let i = 0; i < 4; i++) {
      const t = this.ticks[i];
      t.position.set(Math.sin(i * Math.PI / 2) * r, 0, Math.cos(i * Math.PI / 2) * r);
      t.scale.set(1, 1, Math.max(0.6, r * 0.18));
    }
  }

  dispose(): void { this.ringMat.dispose(); this.discMat.dispose(); }
}

/* ────────────────────────────── incoming marker ────────────────────────────── */
/** Thin emissive beacon column + flashing ring at a call target until it lands. */
export class CallMarker {
  readonly group = new THREE.Group();
  private readonly mat: THREE.MeshBasicMaterial;
  private readonly ringMat: THREE.MeshBasicMaterial;
  private readonly ring: THREE.Mesh;

  constructor(geo: SharedGeo, kind: StratagemId, radius: number) {
    const c = KIND_COLOR[kind];
    this.mat = basic(c, 0.7, true);
    this.ringMat = basic(c, 0.8, true);
    const col = new THREE.Mesh(geo.column, this.mat);
    col.scale.set(0.07, 60, 0.07);
    const glow = new THREE.Mesh(geo.column, this.mat);
    glow.scale.set(0.22, 60, 0.22);
    this.ring = new THREE.Mesh(geo.thinRing, this.ringMat);
    this.ring.scale.setScalar(radius);
    this.ring.position.y = 0.06;
    const core = new THREE.Mesh(geo.disc, this.ringMat);
    core.scale.setScalar(0.25); core.position.y = 0.07;
    this.group.add(col, glow, this.ring, core);
  }

  animate(time: number, fraction: number): void {
    // faster flashing as the landing approaches
    const hz = 2 + fraction * 8;
    const on = (Math.sin(time * hz * Math.PI * 2) > 0) ? 1 : 0.25;
    this.ringMat.opacity = 0.35 + on * 0.55;
    this.mat.opacity = 0.35 + on * 0.35;
  }

  dispose(): void { this.mat.dispose(); this.ringMat.dispose(); }
}

/* ────────────────────────────── particle bursts ────────────────────────────── */
/** One-shot particle burst (dust / sparks / rubble chips). Owns its geometry + material; `update` returns false when dead. */
export class Burst {
  readonly points: THREE.Points;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly mat: THREE.PointsMaterial;
  private readonly geom: THREE.BufferGeometry;
  private age = 0;

  constructor(center: THREE.Vector3, count: number, opts: { color: number; size: number; speed: number; up: number; life: number; gravity: number; additive?: boolean; spread?: number }) {
    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    const spread = opts.spread ?? 0.4;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * spread;
      this.pos[i * 3] = center.x + Math.cos(a) * r;
      this.pos[i * 3 + 1] = center.y + Math.random() * 0.3;
      this.pos[i * 3 + 2] = center.z + Math.sin(a) * r;
      const s = opts.speed * (0.4 + Math.random() * 0.6);
      this.vel[i * 3] = Math.cos(a) * s;
      this.vel[i * 3 + 1] = opts.up * (0.3 + Math.random() * 0.7);
      this.vel[i * 3 + 2] = Math.sin(a) * s;
    }
    this.geom = new THREE.BufferGeometry();
    this.geom.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.mat = new THREE.PointsMaterial({
      color: opts.color, size: opts.size, transparent: true, opacity: 0.9, depthWrite: false, sizeAttenuation: true,
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geom, this.mat);
    this.points.frustumCulled = false;
    this.life = opts.life; this.gravity = opts.gravity;
  }
  private readonly life: number;
  private readonly gravity: number;

  update(dt: number): boolean {
    this.age += dt;
    if (this.age >= this.life) return false;
    const n = this.pos.length / 3;
    for (let i = 0; i < n; i++) {
      this.vel[i * 3 + 1] -= this.gravity * dt;
      this.vel[i * 3] *= 0.98; this.vel[i * 3 + 2] *= 0.98;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
    }
    (this.geom.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    this.mat.opacity = 0.9 * (1 - this.age / this.life);
    return true;
  }

  dispose(): void { this.geom.dispose(); this.mat.dispose(); }
}

export function dustBurst(center: THREE.Vector3, radius: number, dark = false): Burst {
  return new Burst(center, Math.round(40 + radius * 12), {
    color: dark ? 0x4a4640 : 0xa89a80, size: 0.45 + radius * 0.06, speed: 2 + radius * 0.9, up: 3 + radius * 0.4,
    life: 1.4 + radius * 0.06, gravity: 4, spread: radius * 0.35,
  });
}

export function sparkBurst(center: THREE.Vector3, color: number): Burst {
  return new Burst(center, 48, { color, size: 0.22, speed: 6, up: 9, life: 0.7, gravity: 14, additive: true, spread: 0.6 });
}

/* ────────────────────────────── orbital laser ────────────────────────────── */
export class LaserBeam {
  readonly group = new THREE.Group();
  private readonly coreMat = basic(0xf4ffff, 0.95, true);
  private readonly glowMat = basic(0x55d8ff, 0.45, true);
  private readonly scorchMat = basic(0x33c8ff, 0.8, true);
  private readonly scorch: THREE.Mesh;
  private readonly glow: THREE.Mesh;

  constructor(geo: SharedGeo, radius: number) {
    const core = new THREE.Mesh(geo.column, this.coreMat);
    core.scale.set(0.5, 300, 0.5);
    this.glow = new THREE.Mesh(geo.column, this.glowMat);
    this.glow.scale.set(1.2, 300, 1.2);
    this.scorch = new THREE.Mesh(geo.ring, this.scorchMat);
    this.scorch.scale.setScalar(radius);
    this.scorch.position.y = 0.1;
    const base = new THREE.Mesh(geo.disc, this.glowMat);
    base.scale.setScalar(radius * 0.6); base.position.y = 0.12;
    this.group.add(core, this.glow, this.scorch, base);
  }

  /** `t` = seconds since ignition, `fade` = 0..1 fade-out at the end. */
  animate(t: number, remaining: number): void {
    const fade = Math.min(1, remaining / 0.6, t / 0.25);
    const flicker = 0.85 + 0.15 * Math.sin(t * 43);
    this.coreMat.opacity = 0.95 * fade * flicker;
    this.glowMat.opacity = 0.45 * fade;
    this.glow.scale.x = this.glow.scale.z = 1.2 + 0.2 * Math.sin(t * 17);
    this.scorch.rotation.y = t * 1.2;
    this.scorchMat.opacity = 0.8 * fade;
  }

  dispose(): void { this.coreMat.dispose(); this.glowMat.dispose(); this.scorchMat.dispose(); }
}

/* ────────────────────────────── airstrike ────────────────────────────── */
export class Fireball {
  readonly group = new THREE.Group();
  private readonly fireMat = basic(0xffb347, 0.95, true);
  private readonly ringMat = basic(0xffe0b0, 0.8, true);
  private readonly fire: THREE.Mesh;
  private readonly ring: THREE.Mesh;

  constructor(geo: SharedGeo, private readonly radius: number) {
    this.fire = new THREE.Mesh(geo.sphere, this.fireMat);
    this.ring = new THREE.Mesh(geo.ring, this.ringMat);
    this.ring.position.y = 0.3;
    this.group.add(this.fire, this.ring);
  }

  /** `t` seconds since impact. Returns false when finished. */
  animate(t: number): boolean {
    const D = 2.0;
    if (t >= D) return false;
    const k = t / D;
    const grow = 1 - Math.pow(1 - Math.min(1, k * 1.6), 3);
    const r = this.radius;
    this.fire.scale.setScalar(0.5 + grow * r * 0.75);
    this.fire.position.y = grow * r * 0.35;
    this.fireMat.opacity = 0.95 * (1 - k) * (1 - k);
    this.fireMat.color.setHSL(0.07 - k * 0.05, 1, 0.65 - k * 0.3);
    this.ring.scale.setScalar(0.5 + k * r * 1.7);
    this.ringMat.opacity = 0.8 * (1 - k);
    return true;
  }

  dispose(): void { this.fireMat.dispose(); this.ringMat.dispose(); }
}

/* ────────────────────────────── supply crate ────────────────────────────── */
export class SupplyCrateMesh {
  readonly group = new THREE.Group();
  private readonly stripMat = new THREE.MeshStandardMaterial({ color: 0x3dffb0, emissive: 0x3dffb0, emissiveIntensity: 1.4, roughness: 0.5 });
  private readonly chute: THREE.Mesh;
  private readonly chuteMat = basic(0xe8e3d4, 0.9);
  private static bodyMat: THREE.MeshStandardMaterial | null = null;
  private static stripeMat: THREE.MeshStandardMaterial | null = null;

  constructor(geo: SharedGeo) {
    SupplyCrateMesh.bodyMat ??= new THREE.MeshStandardMaterial({ color: 0x3a3f46, roughness: 0.85, metalness: 0.25 });
    SupplyCrateMesh.stripeMat ??= new THREE.MeshStandardMaterial({ color: 0xff8a2a, roughness: 0.7 });
    const body = new THREE.Mesh(geo.box, SupplyCrateMesh.bodyMat);
    body.scale.set(1.2, 1.2, 1.2); body.position.y = 0.6;
    this.group.add(body);
    for (const x of [-0.36, 0.36]) {
      const s = new THREE.Mesh(geo.box, SupplyCrateMesh.stripeMat);
      s.scale.set(0.18, 1.22, 1.22); s.position.set(x, 0.6, 0);
      this.group.add(s);
    }
    // emissive edge strips
    for (const [x, z] of [[-0.61, 0], [0.61, 0], [0, -0.61], [0, 0.61]] as const) {
      const e = new THREE.Mesh(geo.box, this.stripMat);
      e.scale.set(x !== 0 ? 0.04 : 1.0, 0.05, z !== 0 ? 0.04 : 1.0);
      e.position.set(x, 1.15, z);
      this.group.add(e);
    }
    this.chute = new THREE.Mesh(geo.cone, this.chuteMat);
    this.chute.scale.set(2.2, 1.6, 2.2); this.chute.position.y = 3.2;
    this.group.add(this.chute);
  }

  setFalling(falling: boolean): void { this.chute.visible = falling; }
  setLooted(): void { this.stripMat.emissiveIntensity = 0.15; this.stripMat.color.setHex(0x2a5a48); }
  dispose(): void { this.stripMat.dispose(); this.chuteMat.dispose(); }
}

/* ────────────────────────────── cover structure ────────────────────────────── */
export class BarricadeMesh {
  readonly group = new THREE.Group();
  private readonly crackMat = basic(0x0a0a0a, 0);
  private static concrete: THREE.MeshStandardMaterial | null = null;
  private static hazard: THREE.MeshStandardMaterial | null = null;

  constructor(geo: SharedGeo, yaw: number) {
    BarricadeMesh.concrete ??= new THREE.MeshStandardMaterial({ color: 0x5a5c5e, roughness: 0.95, metalness: 0.05 });
    BarricadeMesh.hazard ??= new THREE.MeshStandardMaterial({ color: 0xe0b32a, emissive: 0x6a5010, emissiveIntensity: 0.35, roughness: 0.8 });
    const body = new THREE.Mesh(geo.barricadeBody, BarricadeMesh.concrete);
    body.position.y = 0.75; body.rotation.x = -0.14;          // slanted face
    const lip = new THREE.Mesh(geo.barricadeLip, BarricadeMesh.concrete);
    lip.position.set(0, 1.35, -0.05);
    const foot = new THREE.Mesh(geo.barricadeFoot, BarricadeMesh.concrete);
    foot.position.y = 0.09;
    const stripe = new THREE.Mesh(geo.stripe, BarricadeMesh.hazard);
    stripe.position.set(0, 0.42, 0.005); stripe.rotation.x = -0.14;
    const crack = new THREE.Mesh(geo.crack, this.crackMat);
    crack.position.y = 0.75; crack.rotation.x = -0.14;
    this.group.add(body, lip, foot, stripe, crack);
    this.group.rotation.y = yaw;
  }

  /** 0 = intact, 1 = about to break: darkening crack overlay. */
  setDamage(frac: number): void { this.crackMat.opacity = Math.min(0.75, frac * 0.8); }
  dispose(): void { this.crackMat.dispose(); }
}

/** A few concrete chunks left where a structure fell apart. Shares the concrete material. */
export function makeRubble(geo: SharedGeo, seed: number): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x4c4e50, roughness: 1 });
  for (let i = 0; i < 4; i++) {
    const m = new THREE.Mesh(geo.rubble, mat);
    const a = seed * 1.7 + i * 1.9, r = 0.5 + ((i * 37 + seed) % 7) * 0.12;
    m.position.set(Math.cos(a) * r, 0.16, Math.sin(a) * r);
    m.rotation.set(0, a, 0.2 * (i % 2 ? 1 : -1));
    g.add(m);
  }
  g.userData.mat = mat;
  return g;
}
