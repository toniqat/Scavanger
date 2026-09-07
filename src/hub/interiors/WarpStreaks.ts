import * as THREE from 'three';

/**
 * 워프 별 줄기 (Phase 11): the streaked stars of the 행성 이동 cutscene.
 *
 * `Starfield` draws points, and a `PointsMaterial` cannot be stretched, so the warp gets its own layer: one
 * `LineSegments` with two vertices per streak, laid out in a cylinder shell around the −Z travel axis. The tail
 * vertex is pushed back by `setStretch(k)` — the whole point of the effect — and because rewriting 2 × `count`
 * vertices every frame would be a per-frame buffer upload for nothing, the write is **quantised** (`STRETCH_STEP`):
 * a 4.5 s cutscene ends up uploading a couple of dozen times, not 270.
 *
 * Deterministic RNG (same hash as `Starfield`) so every client sees the same warp. Procedural geometry only.
 */

const SPAN = 900;
/** Radial shell the streaks live in (the camera sits inside it). */
const R_MIN = 26;
const R_MAX = 240;
/** Streak length at `stretch = 1` (a dot of light) and how finely `setStretch` is quantised. */
const BASE_LEN = 1.6;
const STRETCH_STEP = 0.35;
/** How fast the field slides past the camera (m/s); it wraps by `SPAN`, which a uniform field hides. */
const DRIFT = 260;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export class WarpStreaks {
  readonly group = new THREE.Group();
  private readonly geo: THREE.BufferGeometry;
  private readonly mat: THREE.LineBasicMaterial;
  private readonly pos: Float32Array;
  /** Head z of every streak (the tail is `head + BASE_LEN * stretch`). */
  private readonly headZ: Float32Array;
  private readonly count: number;
  private stretch = 1;
  /** Last quantised stretch actually written into the buffer (−1 = never). */
  private written = -1;
  private drift = 0;

  constructor(count = 460, seed = 31) {
    const r = rng(seed);
    this.count = count;
    const pos = this.pos = new Float32Array(count * 6);
    const col = new Float32Array(count * 6);
    this.headZ = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const phi = r() * Math.PI * 2;
      const rr = R_MIN + (R_MAX - R_MIN) * Math.sqrt(r());
      const x = Math.cos(phi) * rr, y = Math.sin(phi) * rr * 0.8;
      const z = -SPAN / 2 + r() * SPAN;
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

  /** 0..1 layer opacity (the streaks only exist while the warp runs). */
  setOpacity(o: number): void {
    this.mat.opacity = THREE.MathUtils.clamp(o, 0, 1);
    this.group.visible = this.mat.opacity > 0.01;
  }

  update(dt: number): void {
    this.drift = (this.drift + dt * DRIFT * (this.stretch > 2 ? 1 : 0.25)) % SPAN;
    this.group.position.z = this.drift;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
    this.group.removeFromParent();
  }
}
