import * as THREE from 'three';

/** Marker colour — the same red the HUD uses for danger (`--c-danger`). */
const COLOR = 0xff3b30;
/** Ring radius per metre of camera distance (≈ 1° of view): the circle reads the same size near or far. */
const SIZE_PER_M = 0.018;
const SIZE_MIN = 0.045;
const SIZE_MAX = 0.35;
/** Lift off the surface along its normal (the ring never hides inside the wall it marks). */
const LIFT = 0.02;

const _ringN = new THREE.Vector3(0, 0, 1);
const _n = new THREE.Vector3();

/**
 * 총구 막힘 표시 (2026-09-12). While the gun's line meets a wall / cover in its first `WEAPON_MUZZLE_BLOCK_RANGE` m that
 * is not what the crosshair is on, a red ring + dot is drawn **on that surface** — the spot the bullet will really hit
 * (`parts/AimLine.updateAimBlock` feeds it the resolver's hit, the same one `fire()` would use).
 *
 * Pooled and light-free: one group with a ring and a dot, `MeshBasicMaterial` with `depthTest: false` so it reads even
 * when the marked face is at a grazing angle. It is created in the scene at `init` (hidden), so the core shader warm-up
 * compiles it with everything else.
 */
export class AimBlockMarker {
  private readonly group = new THREE.Group();
  private readonly ringGeo = new THREE.RingGeometry(0.62, 1, 32);
  private readonly dotGeo = new THREE.CircleGeometry(0.2, 16);
  private readonly mat = new THREE.MeshBasicMaterial({
    color: COLOR, transparent: true, opacity: 0.9,
    side: THREE.DoubleSide, depthTest: false, depthWrite: false, toneMapped: false,
  });
  private shown = false;

  constructor(private readonly scene: THREE.Scene) {
    const ring = new THREE.Mesh(this.ringGeo, this.mat);
    const dot = new THREE.Mesh(this.dotGeo, this.mat);
    for (const m of [ring, dot]) { m.frustumCulled = false; m.renderOrder = 4; }
    this.group.add(ring, dot);
    this.group.name = 'aim-block-marker';
    this.group.renderOrder = 4;
    this.group.visible = false;
    scene.add(this.group);
  }

  /** Put the marker on `point`, facing `normal` (falls back to `-dir` when the hit carries no usable normal). */
  show(point: THREE.Vector3, normal: THREE.Vector3, dir: THREE.Vector3, camera: THREE.Camera, time: number): void {
    _n.copy(normal);
    if (_n.lengthSq() < 0.25) _n.copy(dir).negate();
    _n.normalize();
    const g = this.group;
    g.position.copy(point).addScaledVector(_n, LIFT);
    g.quaternion.setFromUnitVectors(_ringN, _n);
    const s = THREE.MathUtils.clamp(camera.position.distanceTo(g.position) * SIZE_PER_M, SIZE_MIN, SIZE_MAX);
    g.scale.setScalar(s);
    this.mat.opacity = 0.72 + 0.2 * Math.sin(time * 9);
    g.visible = true;
    this.shown = true;
  }

  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    this.group.visible = false;
  }

  /** Whether the marker is drawn right now (debug / smoke). */
  get isShowing(): boolean { return this.shown; }
  /** World position of the marker (debug / smoke); null while hidden. */
  getPoint(out: THREE.Vector3): THREE.Vector3 | null { return this.shown ? out.copy(this.group.position) : null; }

  dispose(): void {
    this.hide();
    this.scene.remove(this.group);
    this.group.clear();
    this.ringGeo.dispose(); this.dotGeo.dispose(); this.mat.dispose();
  }
}
