import * as THREE from 'three';
import type { GameContext } from '@/shared';
import { Starfield } from './interiors/Starfield';
import { buildPersonalExterior, buildSharedExterior, type ExteriorModel } from './interiors/ExteriorShips';

/**
 * The two exterior cutscenes. (`'travel'` lived here from Phase 11 until 2026-09-09 — 행성 이동 is now the
 * **창문 워프** watched from inside the ship, see `parts/Planet.ts`; the docking cutscene itself stays exterior.)
 */
export type DockDirection = 'dock' | 'undock';

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
 * ship's hangar bay while the camera chases it. Drives `ctx.player.setCameraOverride` every frame and disables the
 * controls for its duration (the hub hands them back in `finishTransition`).
 */
export class DockingCutscene {
  readonly root = new THREE.Group();
  private readonly stars: Starfield;
  private readonly small: ExteriorModel;
  private readonly big: ExteriorModel;
  private t = 0;
  private done = false;
  private first = true;

  constructor(private readonly ctx: GameContext, readonly direction: DockDirection, private readonly duration: number, private readonly onEnd: () => void) {
    this.root.name = 'DockingCutscene';
    this.root.position.copy(STAGE);
    this.stars = new Starfield(700, 2600, 5, 0.002);
    this.root.add(this.stars.points);
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

  /** Ship position along the path at progress p (0 = far away, 1 = inside the bay), in stage-local space. */
  private pathAt(p: number, out: THREE.Vector3): THREE.Vector3 {
    // bay mouth in stage-local space (big ship is rotated)
    const ry = this.big.group.rotation.y;
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
    const small = this.small;
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
  /** Seconds of the cutscene played so far (the hub prebuilds the destination ship off this, 2026-09-10). */
  get elapsed(): number { return this.t * this.duration; }

  dispose(): void {
    this.done = true;
    this.stars.dispose();
    this.small.dispose();
    this.big.dispose();
    this.root.removeFromParent();
  }
}
