import * as THREE from 'three';

/** Deterministic tiny hash RNG so every client builds the same star positions. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** The point stars' resting opacity (`setOpacity(1)`). */
const STARFIELD_BASE_OPACITY = 0.95;

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
    this.mat = new THREE.PointsMaterial({ size: 1.7, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: STARFIELD_BASE_OPACITY, depthWrite: false, fog: false });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.name = 'HubStarfield';
    this.spin = spin;
  }

  /**
   * 0..1 fade (창문 워프, 2026-09-09): the point stars give way to `WarpStreaks` as the warp speed rises. Scales the
   * material's own opacity and hides the object at 0 so an invisible field costs no draw call.
   */
  setOpacity(o: number): void {
    const k = THREE.MathUtils.clamp(o, 0, 1);
    this.mat.opacity = STARFIELD_BASE_OPACITY * k;
    this.points.visible = k > 0.01;
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

/**
 * A lit planet sphere with a thin emissive atmosphere shell (seen through viewports, and — since Phase 11 — inside
 * the terminal's planet hologram). `setColors` re-tints it in place so the ship's window planet can follow the
 * 목표 행성 without rebuilding the geometry, and `setOpacity` drives the hologram's `PLANET_SWAP_TIME` cross-fade.
 *
 * **2026-09-09 (목표 행성이 없으면 창밖에 행성도 없다):** `group.visible` is owned here and is the AND of two gates —
 * `setShown(on)` (is there a destination at all? the hub decides from `HubRef.planet`) and the opacity being above
 * `HIDE_BELOW` (the warp fade). Neither caller touches `group.visible` directly, so the two never fight: a hidden
 * planet stays hidden through a warp's fade-in until the destination is known, and a shown planet still vanishes at
 * opacity 0 (an invisible-but-drawn sphere would write depth and punch a hole in the streaks behind it).
 */
export class Planet {
  readonly group = new THREE.Group();
  private readonly disposables: Array<THREE.BufferGeometry | THREE.Material> = [];
  private readonly bodyMat: THREE.MeshStandardMaterial;
  private readonly shellMat: THREE.MeshBasicMaterial;
  /** Atmosphere opacity at full strength (`setOpacity` scales this, never overwrites it). */
  private readonly shellBase: number;
  private readonly spin: number;
  /** Below this opacity the sphere is not drawn at all (depth-write hole in the warp streaks otherwise). */
  private static readonly HIDE_BELOW = 0.01;
  /** Destination gate (`setShown`); defaults to visible so the hologram and legacy callers behave as before. */
  private shown = true;
  private opacity = 1;

  constructor(radius: number, color: number, atmo: number, spin = 0.01, shellOpacity = 0.16) {
    const g = new THREE.SphereGeometry(radius, 40, 28);
    const m = this.bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.95, metalness: 0.0, emissive: color, emissiveIntensity: 0.08 });
    const body = new THREE.Mesh(g, m);
    const ag = new THREE.SphereGeometry(radius * 1.035, 40, 28);
    const am = this.shellMat = new THREE.MeshBasicMaterial({ color: atmo, transparent: true, opacity: shellOpacity, side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false });
    const shell = new THREE.Mesh(ag, am);
    this.group.add(body, shell);
    this.group.name = 'HubPlanet';
    body.name = 'HubPlanetBody';
    this.disposables.push(g, m, ag, am);
    this.shellBase = shellOpacity;
    this.spin = spin;
  }

  /** Re-tint the sphere and its shell (the 목표 행성 changed) — no geometry is rebuilt. */
  setColors(color: number, atmo: number): void {
    this.bodyMat.color.setHex(color);
    this.bodyMat.emissive.setHex(color);
    this.shellMat.color.setHex(atmo);
  }

  /** 0..1 fade for the hologram swap / warp (1 = the material's own opacity). Opacity ≈ 0 also hides the group. */
  setOpacity(o: number): void {
    const k = THREE.MathUtils.clamp(o, 0, 1);
    this.opacity = k;
    this.bodyMat.transparent = k < 1;
    this.bodyMat.opacity = k;
    this.shellMat.opacity = this.shellBase * k;
    this.applyVisible();
  }

  /**
   * Destination gate (2026-09-09): `false` = there is no 목표 행성, so nothing hangs outside the window whatever the
   * opacity says; `true` = the planet shows as the fade allows. Independent of `setOpacity` — both are ANDed.
   */
  setShown(on: boolean): void {
    if (this.shown === on) return;
    this.shown = on;
    this.applyVisible();
  }

  /** Whether the destination gate is open (debug / smoke). */
  get isShown(): boolean { return this.shown; }

  private applyVisible(): void {
    this.group.visible = this.shown && this.opacity > Planet.HIDE_BELOW;
  }

  update(dt: number): void { this.group.rotation.y += dt * this.spin; }
  dispose(): void { for (const d of this.disposables) d.dispose(); this.group.removeFromParent(); }
}
