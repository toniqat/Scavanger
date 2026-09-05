import * as THREE from 'three';

/** Deterministic tiny hash RNG so every client builds the same star positions. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * Procedural starfield: a sphere of `count` points around `center`, drawn without size attenuation
 * so it reads the same through viewports and in the docking cutscene. Rotates very slowly.
 */
export class Starfield {
  readonly points: THREE.Points;
  private readonly geo: THREE.BufferGeometry;
  private readonly mat: THREE.PointsMaterial;
  private readonly spin: number;

  constructor(radius: number, count = 1800, seed = 7, spin = 0.004) {
    const r = rng(seed);
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const u = r() * 2 - 1, phi = r() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      const rr = radius * (0.9 + r() * 0.1);
      pos[i * 3] = s * Math.cos(phi) * rr;
      pos[i * 3 + 1] = u * rr;
      pos[i * 3 + 2] = s * Math.sin(phi) * rr;
      const b = 0.35 + Math.pow(r(), 3) * 0.65;
      const tint = r();
      col[i * 3] = b * (tint < 0.15 ? 1.0 : 0.85);
      col[i * 3 + 1] = b * 0.9;
      col[i * 3 + 2] = b * (tint > 0.7 ? 1.0 : 0.85);
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.mat = new THREE.PointsMaterial({ size: 1.7, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false, fog: false });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.name = 'HubStarfield';
    this.spin = spin;
  }

  update(dt: number): void {
    this.points.rotation.y += dt * this.spin;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
    this.points.removeFromParent();
  }
}

/** A lit planet sphere with a thin emissive atmosphere shell (seen through viewports). */
export class Planet {
  readonly group = new THREE.Group();
  private readonly disposables: Array<THREE.BufferGeometry | THREE.Material> = [];

  constructor(radius: number, color: number, atmo: number) {
    const g = new THREE.SphereGeometry(radius, 40, 28);
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.95, metalness: 0.0, emissive: color, emissiveIntensity: 0.08 });
    const body = new THREE.Mesh(g, m);
    const ag = new THREE.SphereGeometry(radius * 1.035, 40, 28);
    const am = new THREE.MeshBasicMaterial({ color: atmo, transparent: true, opacity: 0.16, side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false });
    const shell = new THREE.Mesh(ag, am);
    this.group.add(body, shell);
    this.disposables.push(g, m, ag, am);
  }
  update(dt: number): void { this.group.rotation.y += dt * 0.01; }
  dispose(): void { for (const d of this.disposables) d.dispose(); this.group.removeFromParent(); }
}
