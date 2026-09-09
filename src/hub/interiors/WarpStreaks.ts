import * as THREE from 'three';
import type { Planet, Starfield } from './Starfield';

/**
 * 워프 별 줄기: the streaked stars of the 행성 이동 warp.
 *
 * `Starfield` draws points, and a `PointsMaterial` cannot be stretched, so the warp gets its own layer: one
 * `LineSegments` with two vertices per streak, laid out in a cylinder shell around the ship's travel axis. The tail
 * vertex is pushed back by `setStretch(k)` — the whole point of the effect — and because rewriting 2 × `count`
 * vertices every frame would be a per-frame buffer upload for nothing, the write is **quantised** (`STRETCH_STEP`):
 * a 6 s warp ends up uploading a couple of dozen times, not 360.
 *
 * **2026-09-09 (창문 워프)**: built for the old exterior cutscene, now owned by each ship interior and watched
 * **through the viewports** from inside the hull. The geometry is generated along −Z and the group is rotated so
 * that local −Z lands on `forward` (the ship's nose: −Z for the personal ship, −X for the shared ship's bridge);
 * `rMin` must clear the hull so no streak ever crosses a walkable room, and the field drifts **backwards** along
 * `forward` so the streaks fly past the windows in the direction of travel. Opacity 0 (the rest state) hides the
 * group and skips its update entirely.
 *
 * Deterministic RNG (same hash as `Starfield`) so every client sees the same warp. Procedural geometry only.
 */

/** Streak length at `stretch = 1` (a dot of light) and how finely `setStretch` is quantised. */
const BASE_LEN = 1.6;
const STRETCH_STEP = 0.35;
/** How fast the field slides past the camera at full stretch (m/s); it wraps by `span`, which a uniform field hides. */
const DRIFT = 260;
/** Stretch at which the drift reaches full speed (`HUB_TRAVEL_WARP_STRETCH` is 22; this stays a local visual knob). */
const DRIFT_FULL_STRETCH = 9;

export interface WarpStreaksOptions {
  count?: number;
  seed?: number;
  /** Unit direction the ship travels in (streaks flow the opposite way). Default −Z. */
  forward?: THREE.Vector3;
  /** Radial shell the streaks live in — `rMin` must clear the hull, the camera sits inside it. Defaults 26 / 240. */
  rMin?: number;
  rMax?: number;
  /** Length of the tube along the axis (centred on the origin). Default 900. */
  span?: number;
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const _negZ = new THREE.Vector3(0, 0, -1);

export class WarpStreaks {
  readonly group = new THREE.Group();
  private readonly geo: THREE.BufferGeometry;
  private readonly mat: THREE.LineBasicMaterial;
  private readonly pos: Float32Array;
  /** Head z of every streak (the tail is `head + BASE_LEN * stretch`). */
  private readonly headZ: Float32Array;
  private readonly count: number;
  private readonly span: number;
  private readonly forward: THREE.Vector3;
  private stretch = 1;
  /** Last quantised stretch actually written into the buffer (−1 = never). */
  private written = -1;
  private drift = 0;

  constructor(opts: WarpStreaksOptions = {}) {
    const count = opts.count ?? 460;
    const r = rng(opts.seed ?? 31);
    const rMin = opts.rMin ?? 26, rMax = opts.rMax ?? 240;
    const span = this.span = opts.span ?? 900;
    this.forward = (opts.forward ?? _negZ).clone().normalize();
    this.count = count;
    const pos = this.pos = new Float32Array(count * 6);
    const col = new Float32Array(count * 6);
    this.headZ = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const phi = r() * Math.PI * 2;
      const rr = rMin + (rMax - rMin) * Math.sqrt(r());
      const x = Math.cos(phi) * rr, y = Math.sin(phi) * rr * 0.8;
      const z = -span / 2 + r() * span;
      this.headZ[i] = z;
      const o = i * 6;
      pos[o] = x; pos[o + 1] = y; pos[o + 2] = z;
      pos[o + 3] = x; pos[o + 4] = y; pos[o + 5] = z + BASE_LEN;
      const b = 0.4 + Math.pow(r(), 2) * 0.6;
      const tint = r() < 0.25 ? 1 : 0.86;
      col[o] = b * tint; col[o + 1] = b * 0.94; col[o + 2] = b;
      col[o + 3] = b * 0.18 * tint; col[o + 4] = b * 0.17; col[o + 5] = b * 0.2;   // tail fades out
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    const lines = new THREE.LineSegments(this.geo, this.mat);
    lines.frustumCulled = false;
    lines.name = 'HubWarpStreaks';
    this.group.add(lines);
    this.group.name = 'HubWarpStreaksGroup';
    // local −Z (the generated axis) → the ship's nose
    this.group.quaternion.setFromUnitVectors(_negZ, this.forward);
    this.group.visible = false;
  }

  /** `k` = 1 (points of light) … `HUB_TRAVEL_WARP_STRETCH` (full warp). Writes the buffer only when it moved. */
  setStretch(k: number): void {
    this.stretch = Math.max(1, k);
    const q = Math.round(this.stretch / STRETCH_STEP);
    if (q === this.written) return;
    this.written = q;
    const len = BASE_LEN * q * STRETCH_STEP;
    for (let i = 0; i < this.count; i++) this.pos[i * 6 + 5] = this.headZ[i] + len;
    (this.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  /** 0..1 layer opacity (the streaks only exist while the warp runs; 0 hides the group and stops its drift). */
  setOpacity(o: number): void {
    this.mat.opacity = THREE.MathUtils.clamp(o, 0, 1);
    this.group.visible = this.mat.opacity > 0.01;
  }

  get visible(): boolean { return this.group.visible; }

  update(dt: number): void {
    if (!this.group.visible) return;
    const k = THREE.MathUtils.clamp((this.stretch - 1) / (DRIFT_FULL_STRETCH - 1), 0.15, 1);
    this.drift = (this.drift + dt * DRIFT * k) % this.span;
    // the field slides **backwards** along the nose: streaks fly past the windows the way the stars would
    this.group.position.copy(this.forward).multiplyScalar(-this.drift);
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
    this.group.removeFromParent();
  }
}

/**
 * The view outside a ship's windows during a warp (2026-09-09) — shared by `PersonalShip` and `SharedShip` so the
 * two `setWarp` implementations are one. Owns the `WarpStreaks` layer; borrows the interior's `Starfield` and
 * window `Planet` (they stay the interior's to dispose).
 *
 * `set(speed, dest)`: point stars fade out as `speed` rises, streaks fade in and stretch to `maxStretch`, the planet
 * fades out on the way up and — re-tinted to `dest` the moment the warp is at full speed or starts easing off —
 * fades back in on the way down. A planet at opacity 0 is also made invisible: an invisible-but-drawn sphere would
 * still write depth and punch a hole in the streaks behind it.
 */
export class ViewportWarp {
  readonly streaks: WarpStreaks;
  private speed = 0;
  private tinted = false;

  constructor(parent: THREE.Object3D, private readonly stars: Starfield, private readonly planet: Planet, private readonly maxStretch: number, opts: WarpStreaksOptions) {
    this.streaks = new WarpStreaks(opts);
    parent.add(this.streaks.group);
  }

  set(speed: number, dest?: { color: number; atmo: number }): void {
    const k = THREE.MathUtils.clamp(speed, 0, 1);
    const easing = k < this.speed;
    if (dest && !this.tinted && (k >= 0.98 || (easing && k > 0))) {
      this.planet.setColors(dest.color, dest.atmo);
      this.tinted = true;
    }
    if (k <= 0) this.tinted = false;
    this.speed = k;
    this.stars.setOpacity(1 - k);
    this.streaks.setStretch(1 + k * (this.maxStretch - 1));
    this.streaks.setOpacity(Math.min(1, k * 1.4));
    const po = 1 - k;
    this.planet.setOpacity(po);
    this.planet.group.visible = po > 0.01;
  }

  get active(): boolean { return this.speed > 0; }

  update(dt: number): void { this.streaks.update(dt); }

  dispose(): void { this.streaks.dispose(); }
}
