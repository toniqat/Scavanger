import * as THREE from 'three';
import { GRAVITY, THROW_ARC_PREVIEW_FRACTION, type GameContext } from '@/shared';

/** Simulation step (s) and flight cap — 2.5 s of arc covers every throw in the game with room to spare. */
const STEP = 1 / 30;
const MAX_STEPS = 75;
/**
 * The minimum length for a downward throw (0.4 s). The end of the flight is 「the point it comes back to the
 * height it was thrown from」, but aiming at one's own feet sends it down from the release moment on, so that
 * condition is true at the first step and not a single point is drawn. The direction still has to be shown.
 */
const MIN_STEPS = 12;
/** Centreline points: the release point, one per simulated step, and the interpolated cut at the preview fraction. */
const MAX_PTS = MAX_STEPS + 2;

/* ── 2026-09-15 arc look (user's decision: a dotted line → a light red trail) ─────────────────────────────── */
/** Ribbon width at the hand (m); it narrows linearly with arc length to a point at the preview's end. */
const TRAIL_WIDTH_M = 0.12;
/** Light red — the default for every caller (the constructor still accepts an override). */
const TRAIL_COLOR = 0xff8080;
/** Material opacity — "slightly transparent". */
const TRAIL_OPACITY = 0.5;
/** Vertex alpha at the far end (1 at the hand) — the tail fades as well as tapers. */
const TAIL_ALPHA = 0.3;

const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
/** Full simulated flight (every step), before the preview fraction trims it. */
const _sim = new Float32Array((MAX_STEPS + 1) * 3);
/** Trimmed centreline the ribbon is built around. */
const _line = new Float32Array(MAX_PTS * 3);
/** Cumulative 3D arc length per centreline point (taper + fade parameter). */
const _cum = new Float32Array(MAX_PTS);
const _tan = new THREE.Vector3();
const _view = new THREE.Vector3();
const _side = new THREE.Vector3();
const _prevSide = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/**
 * The throw preview (2026-09-08). **2026-09-11: only the first `THROW_ARC_PREVIEW_FRACTION` of the horizontal
 * flight is drawn and the landing ring is never shown** (user's decision).
 *
 * **2026-09-14 2nd pass (user's decision) — bounces are not computed. Only 「the arc it flies off along when
 * thrown」 is drawn.**
 * It used to integrate exactly like the real throwable — pushing out of obstacles with `world.resolveCollision`
 * every step and catching the floor with `getSurfaceY`. So the moment it grazed a rock · wall · window frame ·
 * railing the dotted line **bent or slid** along that surface, and that was the motion people read as 「it
 * bounces」. The one question the preview answers is *where is this being thrown*, so **the collision test itself
 * was taken out**: it is now a pure parabola of nothing but the release point · velocity · gravity. So **an arc
 * seen passing through a wall is the intended result** — this arc says 「it goes out this way」, not 「it hits
 * here」. (The real flight · bounce · fuse of a grenade · a throwable gadget stay in `Grenade.ts` /
 * `ThrownGadget` and not one line of them changed.)
 *
 * The end of the flight is likewise not the terrain but **the point it comes back to the height it was thrown
 * from** (a downward throw gets at least `MIN_STEPS`). On flat ground that comes out practically the same length
 * as the old landing time, and the length no longer wavers with what happens to be in the world. The release
 * point · velocity are still exactly the values the throw itself will use (the caller computes them), so `근력`
 * strength `derived.throwRangeMul` · overhand/underhand · the player's own momentum carry over as before.
 *
 * **2026-09-15 (user's decision) — it is a trail, not a dotted line.** The same centreline (length · fraction ·
 * `MIN_STEPS` all unchanged) is drawn as a **light red translucent ribbon**: it starts `TRAIL_WIDTH_M` wide at
 * the hand, narrows in proportion to the arc length to a point at the end of the preview, and its vertex alpha
 * fades to `TAIL_ALPHA`. The ribbon **faces the camera** — each point's side direction is
 * `tangent × (point − camera)`, so a sheet lying edge-on to a third-person camera never collapses into one line.
 * To keep it from flipping as the camera moves, the sign is flipped when the dot product with the neighbouring
 * point's side direction is negative (no twists). The camera position is `ctx.camera.position` as of `show()` —
 * the camera hangs off the scene root (`core/Engine`), and a position one frame late leaves the side direction
 * practically the same.
 *
 * Everything is pooled and light-free: one `Mesh` over a fixed-size indexed quad strip (position + RGBA colour,
 * `setDrawRange` picks how many quads are live), `depthTest: false` so it reads over the terrain it passes, no per-frame
 * allocation.
 */
export class ThrowArc {
  private mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | null = null;
  /** Two vertices per centreline point (left, right). */
  private positions: Float32Array = new Float32Array(MAX_PTS * 2 * 3);
  /** RGBA per vertex — rgb stays 1 (the material carries the colour), alpha fades toward the tail. */
  private colors: Float32Array = new Float32Array(MAX_PTS * 2 * 4).fill(1);
  private geo: THREE.BufferGeometry | null = null;
  private mat: THREE.MeshBasicMaterial | null = null;
  /** End of the last `show()` 's parabola (debug / smoke — not drawn). */
  private readonly impact = new THREE.Vector3();
  private shown = false;

  constructor(private readonly ctx: GameContext, private readonly color = TRAIL_COLOR) {}

  private ensure(): void {
    if (this.mesh) return;
    const geo = new THREE.BufferGeometry();
    const pos = new THREE.BufferAttribute(this.positions, 3);
    pos.setUsage(THREE.DynamicDrawUsage);
    const col = new THREE.BufferAttribute(this.colors, 4);
    col.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', pos);
    geo.setAttribute('color', col);
    // static quad strip: segment i = vertices (2i, 2i+1, 2i+2, 2i+3)
    const index = new Uint16Array((MAX_PTS - 1) * 6);
    for (let i = 0; i < MAX_PTS - 1; i++) {
      const a = i * 2, o = i * 6;
      index[o] = a; index[o + 1] = a + 1; index[o + 2] = a + 2;
      index[o + 3] = a + 1; index[o + 4] = a + 3; index[o + 5] = a + 2;
    }
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.setDrawRange(0, 0);
    this.geo = geo;
    this.mat = new THREE.MeshBasicMaterial({
      color: this.color, vertexColors: true, transparent: true, opacity: TRAIL_OPACITY,
      side: THREE.DoubleSide, depthTest: false, depthWrite: false, toneMapped: false,
    });
    const mesh = new THREE.Mesh(geo, this.mat);
    mesh.name = 'throw-arc';
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    mesh.visible = false;
    this.mesh = mesh;
    this.ctx.scene.add(mesh);
  }

  /**
   * Show the arc for a throw released at `origin` with `velocity`. Both must be the values the throw itself will
   * use — the caller owns the release maths so there is exactly one copy of it per throw type.
   *
   * 2026-09-11 — **the arc is not drawn to the end** (user's decision). The flight is integrated to the end, and
   * then only the first `THROW_ARC_PREVIEW_FRACTION` (0.5) of the horizontal distance is drawn, and **there is no
   * landing marker (ring)** — it shows roughly where the throw goes, no more. When `근력` strength
   * (`derived.throwRangeMul`) · an implant lengthens the range, the drawn arc lengthens with it.
   *
   * 2026-09-14 2nd pass — the integration is **gravity only** (the class comment). It asks the world nothing, so
   * the same arc comes out while `world` is still absent (loading the ship · the training range) or being
   * swapped. What `getImpact` returns is no longer the real landing point but **the spot that parabola ends at**
   * (debug · smoke — it is not on screen).
   */
  show(origin: THREE.Vector3, velocity: THREE.Vector3): void {
    this.ensure();
    _p.copy(origin);
    _v.copy(velocity);
    // ① integrate to the end — every point until it returns to the throw height or hits MAX_STEPS (no collision)
    _sim[0] = _p.x; _sim[1] = _p.y; _sim[2] = _p.z;
    let n = 1;
    for (let i = 0; i < MAX_STEPS; i++) {
      _v.y -= GRAVITY * STEP;
      _p.addScaledVector(_v, STEP);
      _sim[n * 3] = _p.x; _sim[n * 3 + 1] = _p.y; _sim[n * 3 + 2] = _p.z;
      n++;
      if (n > MIN_STEPS && _v.y < 0 && _p.y <= origin.y) break;
    }
    this.impact.copy(_p);
    let total = 0;
    for (let i = 1; i < n; i++) total += Math.hypot(_sim[i * 3] - _sim[(i - 1) * 3], _sim[i * 3 + 2] - _sim[(i - 1) * 3 + 2]);
    // ② copy only the leading fraction into the centreline (the last point is interpolated at the boundary)
    const frac = Math.min(1, Math.max(0, THROW_ARC_PREVIEW_FRACTION));
    const limit = total * frac;
    _line[0] = _sim[0]; _line[1] = _sim[1]; _line[2] = _sim[2];
    let pts = 1, run = 0;
    for (let i = 1; i < n && pts < MAX_PTS; i++) {
      const ax = _sim[(i - 1) * 3], ay = _sim[(i - 1) * 3 + 1], az = _sim[(i - 1) * 3 + 2];
      const bx = _sim[i * 3], by = _sim[i * 3 + 1], bz = _sim[i * 3 + 2];
      const seg = Math.hypot(bx - ax, bz - az);
      if (run + seg >= limit) {
        const t = seg > 1e-6 ? (limit - run) / seg : 0;
        _line[pts * 3] = ax + (bx - ax) * t;
        _line[pts * 3 + 1] = ay + (by - ay) * t;
        _line[pts * 3 + 2] = az + (bz - az) * t;
        pts++;
        break;
      }
      run += seg;
      _line[pts * 3] = bx; _line[pts * 3 + 1] = by; _line[pts * 3 + 2] = bz;
      pts++;
    }
    // ③ centreline → a camera-facing ribbon that narrows toward the end
    this.buildRibbon(pts);
    this.mesh!.visible = true;
    this.shown = true;
  }

  /** Fill the first `pts` centreline points' vertex pairs and set the draw range. No allocation. */
  private buildRibbon(pts: number): void {
    const geo = this.geo!;
    if (pts < 2) { geo.setDrawRange(0, 0); return; }
    const pos = this.positions, col = this.colors;
    _cum[0] = 0;
    for (let i = 1; i < pts; i++) {
      const a = (i - 1) * 3, b = i * 3;
      _cum[i] = _cum[i - 1] + Math.hypot(_line[b] - _line[a], _line[b + 1] - _line[a + 1], _line[b + 2] - _line[a + 2]);
    }
    const len = _cum[pts - 1] > 1e-6 ? _cum[pts - 1] : 1;
    const cam = this.ctx.camera.position;
    _prevSide.set(0, 0, 0);
    for (let i = 0; i < pts; i++) {
      const c = i * 3;
      const a = (i > 0 ? i - 1 : 0) * 3, b = (i < pts - 1 ? i + 1 : pts - 1) * 3;
      const px = _line[c], py = _line[c + 1], pz = _line[c + 2];
      _tan.set(_line[b] - _line[a], _line[b + 1] - _line[a + 1], _line[b + 2] - _line[a + 2]);
      _view.set(px - cam.x, py - cam.y, pz - cam.z);
      _side.crossVectors(_tan, _view);
      if (_side.lengthSq() < 1e-10) {
        // looking straight down the arc here: keep the neighbour's direction, else fall back to horizontal
        if (_prevSide.lengthSq() > 0) _side.copy(_prevSide);
        else { _side.crossVectors(_tan, _up); if (_side.lengthSq() < 1e-10) _side.set(1, 0, 0); }
      }
      _side.normalize();
      if (_prevSide.lengthSq() > 0 && _side.dot(_prevSide) < 0) _side.negate();   // no half-twists along the strip
      _prevSide.copy(_side);
      const f = _cum[i] / len;
      const hw = TRAIL_WIDTH_M * 0.5 * (1 - f);
      const v = i * 6;
      pos[v] = px + _side.x * hw; pos[v + 1] = py + _side.y * hw; pos[v + 2] = pz + _side.z * hw;
      pos[v + 3] = px - _side.x * hw; pos[v + 4] = py - _side.y * hw; pos[v + 5] = pz - _side.z * hw;
      const alpha = 1 + (TAIL_ALPHA - 1) * f;
      col[i * 8 + 3] = alpha;
      col[i * 8 + 7] = alpha;
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.setDrawRange(0, (pts - 1) * 6);
  }

  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    if (this.mesh) this.mesh.visible = false;
  }

  /** Whether the preview is on screen right now (debug / smoke). */
  get isShowing(): boolean { return this.shown; }
  /**
   * World-space end of the last `show()` 's arc (debug / smoke); null while hidden.
   * 2026-09-14 2nd pass: it is not the landing point.
   */
  getImpact(out: THREE.Vector3): THREE.Vector3 | null {
    if (!this.shown || !this.mesh) return null;
    return out.copy(this.impact);
  }

  dispose(): void {
    this.hide();
    if (this.mesh) { this.ctx.scene.remove(this.mesh); this.mesh = null; }
    this.geo?.dispose(); this.geo = null;
    this.mat?.dispose(); this.mat = null;
  }
}
