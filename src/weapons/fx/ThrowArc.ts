import * as THREE from 'three';
import { GRAVITY, PROP_STEP_UP_MAX, THROW_ARC_PREVIEW_FRACTION, type GameContext } from '@/shared';

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
/** Full simulated flight (every step), before the preview fraction trims it. */
const _sim = new Float32Array((MAX_STEPS + 1) * 3);
const _impact = new THREE.Vector3();

/**
 * 투척 궤적 미리보기 (2026-09-08). A dotted arc from the hand along the throw. **2026-09-11: only the first
 * `THROW_ARC_PREVIEW_FRACTION` of the horizontal flight is drawn and the landing ring is never shown** (사용자 결정).
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
   *
   * 2026-09-11 — **궤적은 끝까지 그리지 않는다** (사용자 결정). 실제 비행을 끝까지 적분한 뒤 수평 비거리의
   * `THROW_ARC_PREVIEW_FRACTION`(0.5) 까지만 점을 찍고, **떨어질 자리 표시(고리)는 없다** — 대충 어디로 날아갈지만
   * 보여 준다. 적분은 그대로라 근력(`derived.throwRangeMul`) · 임플란트로 사거리가 늘면 보이는 궤적도 그만큼
   * 길어진다. `getImpact` 는 여전히 실제 착지점을 돌려준다 (디버그 · 스모크용 — 화면에는 없다).
   */
  show(origin: THREE.Vector3, velocity: THREE.Vector3): void {
    this.ensure();
    const world = this.ctx.world;
    _p.copy(origin);
    _v.copy(velocity);
    // ① 끝까지 적분 — 착지하거나 MAX_STEPS 에 닿을 때까지의 모든 점과 누적 수평 거리
    _sim[0] = _p.x; _sim[1] = _p.y; _sim[2] = _p.z;
    let n = 1;
    for (let i = 0; i < MAX_STEPS; i++) {
      _v.y -= GRAVITY * STEP;
      _p.addScaledVector(_v, STEP);
      let landed = false;
      if (world && world.ready) {
        world.resolveCollision(_p, BODY_R);
        // 2026-09-11: 실제 투척물과 같은 바닥 — 그 자리의 표면 (건물 2층 · 옥상 · 계단)
        const ground = world.getSurfaceY(_p.x, _p.z, _p.y + BODY_R - PROP_STEP_UP_MAX) + BODY_R;
        if (_p.y <= ground) { _p.y = ground; landed = true; }
      }
      _sim[n * 3] = _p.x; _sim[n * 3 + 1] = _p.y; _sim[n * 3 + 2] = _p.z;
      n++;
      if (landed) break;
    }
    _impact.copy(_p);
    let total = 0;
    for (let i = 1; i < n; i++) total += Math.hypot(_sim[i * 3] - _sim[(i - 1) * 3], _sim[i * 3 + 2] - _sim[(i - 1) * 3 + 2]);
    // ② 앞쪽 비율만큼만 점으로 옮긴다 (마지막 점은 경계에서 보간)
    const frac = Math.min(1, Math.max(0, THROW_ARC_PREVIEW_FRACTION));
    const limit = total * frac;
    this.positions[0] = _sim[0]; this.positions[1] = _sim[1]; this.positions[2] = _sim[2];
    let dots = 1, run = 0;
    for (let i = 1; i < n && dots < MAX_DOTS; i++) {
      const ax = _sim[(i - 1) * 3], ay = _sim[(i - 1) * 3 + 1], az = _sim[(i - 1) * 3 + 2];
      const bx = _sim[i * 3], by = _sim[i * 3 + 1], bz = _sim[i * 3 + 2];
      const seg = Math.hypot(bx - ax, bz - az);
      if (run + seg >= limit) {
        const t = seg > 1e-6 ? (limit - run) / seg : 0;
        this.positions[dots * 3] = ax + (bx - ax) * t;
        this.positions[dots * 3 + 1] = ay + (by - ay) * t;
        this.positions[dots * 3 + 2] = az + (bz - az) * t;
        dots++;
        break;
      }
      run += seg;
      if (i % DOT_EVERY === 0) {
        this.positions[dots * 3] = bx; this.positions[dots * 3 + 1] = by; this.positions[dots * 3 + 2] = bz;
        dots++;
      }
    }
    this.geo!.attributes.position.needsUpdate = true;
    this.geo!.setDrawRange(0, dots);
    // 착지 고리는 더 이상 보이지 않는다 — 자리만 기억해 둔다 (`getImpact`)
    const m = this.marker!;
    m.position.copy(_impact);
    m.quaternion.setFromUnitVectors(_ringN, world && world.ready ? world.getNormalAt(_impact.x, _impact.z, _n) : _flat);
    m.visible = false;
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
