import * as THREE from 'three';
import type { GameContext } from '@/shared';
import { HUB_TRAVEL_WARP_FRACTION, HUB_TRAVEL_WARP_STRETCH } from '@/shared';
import { Starfield, Planet } from './interiors/Starfield';
import { WarpStreaks } from './interiors/WarpStreaks';
import { buildPersonalExterior, buildSharedExterior, type ExteriorModel } from './interiors/ExteriorShips';

/** `travel` appended (Phase 11): the same stage reused as a 행성 이동 warp (no bay, no second ship). */
export type DockDirection = 'dock' | 'undock' | 'travel';

/** Extra arguments the `'travel'` direction needs (ignored by dock / undock). */
export interface TravelOptions {
  /** Which hull flies: the shared ship carries the whole squad, the personal ship flies alone. */
  shared: boolean;
  /** Destination sphere colours (`PlanetDef.hologram` / `hologramAtmo`). */
  color: number;
  atmo: number;
}

/** Cutscene stage sits far above the (empty) hub origin so the idle player model never enters the frame. */
const STAGE = new THREE.Vector3(0, 900, 0);
/** Bay mouth of the shared ship in its local space (see ExteriorShips). */
const BAY = new THREE.Vector3(16, 0, 4);
const START = new THREE.Vector3(230, 38, 95);

const _pos = new THREE.Vector3();
const _prev = new THREE.Vector3();
const _cam = new THREE.Vector3();
const _look = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _side = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _bay = new THREE.Vector3();
const _inside = new THREE.Vector3();

/**
 * Exterior docking / undocking cutscene: the personal ship flies along an eased curve into (or out of) the shared
 * ship's hangar bay while the camera chases it. Drives `ctx.player.setCameraOverride` every frame.
 *
 * Phase 11 adds `direction: 'travel'` — the same stage (far above the hub origin, so the ship interior and the idle
 * player model stay out of frame) reused as the **행성 이동 warp**: our own hull seen from behind, `WarpStreaks`
 * stretching the stars to `HUB_TRAVEL_WARP_STRETCH` for the first `HUB_TRAVEL_WARP_FRACTION`, then the destination
 * sphere resolving ahead in the planet's own colours. The hub does **not** rebuild the interior for it.
 */
export class DockingCutscene {
  readonly root = new THREE.Group();
  private readonly stars: Starfield;
  /** dock / undock only (`'travel'` flies `hull` instead). */
  private readonly small: ExteriorModel | null = null;
  private readonly big: ExteriorModel | null = null;
  private t = 0;
  private done = false;
  private first = true;
  /* ── 행성 이동 (Phase 11), only built for `direction === 'travel'` ── */
  private readonly streaks: WarpStreaks | null = null;
  private readonly dest: Planet | null = null;
  private readonly hull: ExteriorModel | null = null;

  constructor(private readonly ctx: GameContext, readonly direction: DockDirection, private readonly duration: number, private readonly onEnd: () => void, travel?: TravelOptions) {
    this.root.name = 'DockingCutscene';
    this.root.position.copy(STAGE);
    this.stars = new Starfield(700, 2600, 5, 0.002);
    this.root.add(this.stars.points);
    if (direction === 'travel') {
      // Warp: no bay, no second ship — our own hull, streaked stars and the destination sphere resolving ahead.
      const o = travel ?? { shared: false, color: 0x6c8a5a, atmo: 0x8fd0ff };
      // the hull keeps its own nose (−Z) and the camera sits behind it, so the engine glow faces us
      this.hull = o.shared ? buildSharedExterior() : buildPersonalExterior();
      this.root.add(this.hull.group);
      this.streaks = new WarpStreaks();
      this.root.add(this.streaks.group);
      this.dest = new Planet(70, o.color, o.atmo, 0.05);
      this.dest.group.visible = false;
      this.root.add(this.dest.group);
      ctx.scene.add(this.root);
      ctx.player?.setControlsEnabled(false);
      this.placeTravel(0, true);
      return;
    }
    this.big = buildSharedExterior();
    this.big.group.rotation.y = 0.35;
    this.root.add(this.big.group);
    this.small = buildPersonalExterior();
    this.root.add(this.small.group);
    this.big.setThrust(0.4);
    ctx.scene.add(this.root);
    ctx.player?.setControlsEnabled(false);
    this.place(this.direction === 'dock' ? 0 : 1, true);
  }

  /**
   * 행성 이동 frame at progress `p`: the first `HUB_TRAVEL_WARP_FRACTION` stretches the stars up to
   * `HUB_TRAVEL_WARP_STRETCH`, then the streaks collapse and the destination sphere grows in ahead of the hull.
   */
  private placeTravel(p: number, snap: boolean): void {
    const wf = HUB_TRAVEL_WARP_FRACTION;
    // warp envelope: ramp in over the first 30 % of the warp phase, ramp out over its last 25 %
    let w = 0;
    if (p < wf) {
      const inK = Math.min(1, p / (wf * 0.3));
      const outK = 1 - THREE.MathUtils.clamp((p - wf * 0.75) / (wf * 0.25), 0, 1);
      w = inK * outK;
    }
    const streaks = this.streaks;
    if (streaks) {
      streaks.setStretch(1 + w * (HUB_TRAVEL_WARP_STRETCH - 1));
      streaks.setOpacity(Math.min(1, w * 1.4));
    }
    const hull = this.hull;
    if (hull) {
      hull.setThrust(0.35 + w * 0.65);
      hull.group.position.set(0, -1.6 + Math.sin(p * 7) * 0.25, -14);
      hull.group.rotation.z = Math.sin(p * 4.5) * 0.05 - w * 0.04;
    }
    // destination sphere: hidden through the warp, then closing in
    const dest = this.dest;
    if (dest) {
      const q = THREE.MathUtils.clamp((p - wf) / Math.max(0.05, 1 - wf), 0, 1);
      dest.group.visible = q > 0.001;
      const e = q * q * (3 - 2 * q);
      dest.group.position.set(-24, -34, -900 + e * 620);
      dest.setOpacity(Math.min(1, q * 3));
    }
    // chase camera: fixed behind / above the hull, nudged sideways by the warp
    _cam.set(2.6 + w * 0.9 * Math.sin(p * 31), 4.4, 10 + w * 2.2).add(this.root.position);
    _look.set(0, -1.4, -60).add(this.root.position);
    this.ctx.player?.setCameraOverride(_cam, _look, snap);
  }

  /** Ship position along the path at progress p (0 = far away, 1 = inside the bay), in stage-local space. */
  private pathAt(p: number, out: THREE.Vector3): THREE.Vector3 {
    // bay mouth in stage-local space (big ship is rotated)
    const ry = this.big?.group.rotation.y ?? 0;
    _bay.copy(BAY).applyAxisAngle(_up, ry);
    _inside.set(-4, 0, 0).applyAxisAngle(_up, ry).add(_bay);
    // quadratic bezier: START → control (approach line) → bay, then a short straight run inside
    if (p < 0.9) {
      const q = p / 0.9;
      const cx = _bay.x + 70, cy = _bay.y + 6, cz = _bay.z + 20;
      const a = 1 - q;
      out.set(
        a * a * START.x + 2 * a * q * cx + q * q * _bay.x,
        a * a * START.y + 2 * a * q * cy + q * q * _bay.y,
        a * a * START.z + 2 * a * q * cz + q * q * _bay.z,
      );
    } else {
      const q = (p - 0.9) / 0.1;
      out.lerpVectors(_bay, _inside, q);
    }
    return out;
  }

  private place(progress: number, snap: boolean): void {
    if (this.direction === 'travel') { this.placeTravel(progress, snap); return; }
    const small = this.small;
    if (!small) return;
    // ease: slow arrival for docking, quick departure for undocking
    const e = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;
    const p = this.direction === 'dock' ? e : 1 - e;
    this.pathAt(p, _pos);
    this.pathAt(THREE.MathUtils.clamp(p + (this.direction === 'dock' ? 0.01 : -0.01), 0, 1), _prev);
    _dir.subVectors(_prev, _pos);
    if (_dir.lengthSq() < 1e-6) _dir.set(-1, 0, 0);
    _dir.normalize();
    small.group.position.copy(_pos);
    // nose (−Z) toward travel direction
    _look.copy(_pos).add(_dir);
    small.group.lookAt(_look.add(this.root.position));
    small.group.rotateY(Math.PI);
    small.group.rotation.z = -_dir.z * 0.25;
    const thrust = this.direction === 'dock' ? 1 - p * 0.85 : 0.3 + p * 0.7;
    small.setThrust(thrust);

    // chase camera: behind + above + to the side of the small ship, looking a little ahead of it toward the bay
    _side.crossVectors(_dir, _up).normalize();
    _cam.copy(_pos).addScaledVector(_dir, -16).addScaledVector(_side, 7).addScaledVector(_up, 4.5);
    if (p > 0.85) {
      // hold the camera outside the bay while the ship slips in
      const hold = (p - 0.85) / 0.15;
      _cam.addScaledVector(_dir, -hold * 12).addScaledVector(_side, hold * 6);
    }
    _cam.add(this.root.position);
    _look.copy(_pos).addScaledVector(_dir, 6).add(this.root.position);
    this.ctx.player?.setCameraOverride(_cam, _look, snap);
  }

  update(dt: number): void {
    if (this.done) return;
    this.stars.update(dt);
    this.streaks?.update(dt);
    this.dest?.update(dt);
    this.t += dt / this.duration;
    if (this.t >= 1) {
      this.t = 1;
      this.place(1, false);
      this.done = true;
      this.onEnd();
      return;
    }
    this.place(this.t, this.first);
    this.first = false;
  }

  /** Skip to the end immediately (resume / interrupted). Fires `onEnd` once. */
  finishNow(): void {
    if (this.done) return;
    this.done = true;
    this.onEnd();
  }

  get finished(): boolean { return this.done; }

  dispose(): void {
    this.done = true;
    this.stars.dispose();
    this.small?.dispose();
    this.big?.dispose();
    this.streaks?.dispose();
    this.dest?.dispose();
    this.hull?.dispose();
    this.root.removeFromParent();
  }
}
