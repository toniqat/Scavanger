import * as THREE from 'three';
import { GRAVITY, type GameContext } from '@/shared';

/** Simulation step (s) and flight cap — 2.5 s of arc covers every throw in the game with room to spare. */
const STEP = 1 / 30;
const MAX_STEPS = 75;
/** Every Nth simulated step becomes a dot. 1 = one per step, so even a short lob still draws a readable arc. */
const DOT_EVERY = 1;
const MAX_DOTS = Math.ceil(MAX_STEPS / DOT_EVERY) + 1;
/** Radius the flying body is resolved against — the same value `GrenadeManager` / `ThrownGadgetManager` use. */
const BODY_R = 0.08;
const MARKER_R = 0.8;

const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
/** `RingGeometry` lies in the XY plane, so its own normal is +Z — that is what gets rotated onto the ground normal. */
const _ringN = new THREE.Vector3(0, 0, 1);
const _flat = new THREE.Vector3(0, 1, 0);

/**
 * 투척 궤적 미리보기 (2026-09-08). A dotted arc from the hand to the first ground contact, plus a ring marker where
 * the throw lands.
 *
 * It is a **re-simulation, not an approximation**: `predict()` integrates exactly what `Grenade.update` /
 * `ThrownGadget.update` integrate — gravity, `world.resolveCollision` against the obstacle hash, terrain height —
 * from exactly the release point and velocity the throw will use. So 근력 (`derived.throwRangeMul`, folded into the
 * velocity by the caller), the over/under-hand toggle, the player's own momentum and a rock in the way all show up
 * in the preview for free, and the arc cannot drift out of sync with the throw the way a closed-form parabola would.
 *
 * Everything is pooled and light-free: one `Points` cloud with a fixed buffer (`setDrawRange` picks how much of it is
 * live) and one ring mesh, both `depthTest: false` so they read over the terrain they hug.
 */
export class ThrowArc {
  private group: THREE.Group | null = null;
  private dots: THREE.Points | null = null;
  private marker: THREE.Mesh | null = null;
  private positions: Float32Array = new Float32Array(MAX_DOTS * 3);
  private geo: THREE.BufferGeometry | null = null;
  private dotMat: THREE.PointsMaterial | null = null;
  private ringGeo: THREE.RingGeometry | null = null;
  private ringMat: THREE.MeshBasicMaterial | null = null;
  private shown = false;

  constructor(private readonly ctx: GameContext, private readonly color = 0xf2c14a) {}

  private ensure(): void {
    if (this.group) return;
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geo.setDrawRange(0, 0);
    this.dotMat = new THREE.PointsMaterial({
      color: this.color, size: 6, sizeAttenuation: false,
      transparent: true, opacity: 0.85, depthTest: false, depthWrite: false, toneMapped: false,
    });
    this.dots = new THREE.Points(this.geo, this.dotMat);
    this.dots.frustumCulled = false;
    this.ringGeo = new THREE.RingGeometry(MARKER_R * 0.72, MARKER_R, 24);
    this.ringMat = new THREE.MeshBasicMaterial({
      color: this.color, transparent: true, opacity: 0.9,
      side: THREE.DoubleSide, depthTest: false, depthWrite: false, toneMapped: false,
    });
    this.marker = new THREE.Mesh(this.ringGeo, this.ringMat);
    this.marker.frustumCulled = false;
    this.group = new THREE.Group();
    this.group.name = 'throw-arc';
    this.group.renderOrder = 3;
    this.group.visible = false;
    this.group.add(this.dots, this.marker);
    this.ctx.scene.add(this.group);
  }

  /**
   * Show the arc for a throw released at `origin` with `velocity`. Both must be the values the throw itself will
   * use — the caller owns the release maths so there is exactly one copy of it per throw type.
   */
  show(origin: THREE.Vector3, velocity: THREE.Vector3): void {
    this.ensure();
    const world = this.ctx.world;
    _p.copy(origin);
    _v.copy(velocity);
    let landed = false;
    this.positions[0] = _p.x; this.positions[1] = _p.y; this.positions[2] = _p.z;
    let dots = 1;
    for (let i = 0; i < MAX_STEPS; i++) {
      _v.y -= GRAVITY * STEP;
      _p.addScaledVector(_v, STEP);
      if (world && world.ready) {
        world.resolveCollision(_p, BODY_R);
        const ground = world.getHeightAt(_p.x, _p.z) + BODY_R;
        if (_p.y <= ground) { _p.y = ground; landed = true; }
      }
      if (landed || (i + 1) % DOT_EVERY === 0) {
        if (dots < MAX_DOTS) {
          this.positions[dots * 3] = _p.x; this.positions[dots * 3 + 1] = _p.y; this.positions[dots * 3 + 2] = _p.z;
          dots++;
        }
      }
      if (landed) break;
    }
    this.geo!.attributes.position.needsUpdate = true;
    this.geo!.setDrawRange(0, dots);
    const m = this.marker!;
    m.position.copy(_p);
    if (world && world.ready) {
      world.getNormalAt(_p.x, _p.z, _n);
      m.quaternion.setFromUnitVectors(_ringN, _n);
      m.position.addScaledVector(_n, 0.04);
    } else {
      m.quaternion.setFromUnitVectors(_ringN, _flat);
    }
    m.visible = landed;
    this.group!.visible = true;
    this.shown = true;
  }

  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    if (this.group) this.group.visible = false;
  }

  /** Whether the preview is on screen right now (debug / smoke). */
  get isShowing(): boolean { return this.shown; }
  /** World-space landing point of the last `show()` (debug / smoke); null while hidden. */
  getImpact(out: THREE.Vector3): THREE.Vector3 | null {
    if (!this.shown || !this.marker) return null;
    return out.copy(this.marker.position);
  }

  dispose(): void {
    this.hide();
    if (this.group) { this.ctx.scene.remove(this.group); this.group.clear(); this.group = null; }
    this.geo?.dispose(); this.geo = null;
    this.dotMat?.dispose(); this.dotMat = null;
    this.ringGeo?.dispose(); this.ringGeo = null;
    this.ringMat?.dispose(); this.ringMat = null;
    this.dots = null; this.marker = null;
  }
}
