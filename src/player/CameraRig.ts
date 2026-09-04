import * as THREE from 'three';
import type { WorldRef } from '@/shared';
import { damp, dampVec3, noise1, smoothDamp, type SpringState } from '@/core/util/MathUtil';

export interface RigInput {
  /** world-space pivot (player feet + eye height) */
  pivot: THREE.Vector3;
  aim: number;          // 0..1 blend
  sprint: number;       // 0..1
  crouch: number;       // 0..1
  moveBlend: number;    // 0..1
  stridePhase: number;
  grounded: boolean;
  dead: boolean;
  world: WorldRef | null;
  shipBounds: { center: THREE.Vector3; halfExtents: THREE.Vector3 } | null;
}

const DEG = Math.PI / 180;
const PITCH_MIN = -60 * DEG;
const PITCH_MAX = 70 * DEG;

const _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _desired = new THREE.Vector3();
const _pivotS = new THREE.Vector3(), _dir = new THREE.Vector3(), _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _q = new THREE.Quaternion(), _qShake = new THREE.Quaternion(), _overrideQ = new THREE.Quaternion();
const _m = new THREE.Matrix4(), _up = new THREE.Vector3(0, 1, 0);

/**
 * Over-the-right-shoulder third-person rig with spring-damped follow, terrain collision,
 * sprint/aim FOV, head-bob, recoil and trauma-based screen shake. Also supports a
 * cutscene override pose (hellpod drop) that blends back to the rig.
 */
export class CameraRig {
  yaw = 0;
  /** + = look up */
  pitch = -0.12;
  sensitivity = 0.0022;

  readonly baseFov = 70;
  private fov = 70;
  private readonly distSpring: SpringState = { value: 3.2, velocity: 0 };
  private readonly pivot = new THREE.Vector3();
  private pivotInit = false;
  private shoulder = 0.55;
  private collisionDist = 10;

  // shake
  private trauma = 0;
  private shakeTimer = 0;
  private shakeSeed = Math.random() * 100;
  // recoil (offset that recovers)
  private recoilPitch = 0;
  private recoilYaw = 0;
  // override
  private overrideWeight = 0;
  private overrideTarget = 0;
  private readonly overridePos = new THREE.Vector3();
  private readonly overrideLook = new THREE.Vector3();

  readonly position = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();

  constructor(private readonly camera: THREE.PerspectiveCamera) {}

  /** Mouse look (pixels). */
  applyLook(dx: number, dy: number, aim: number): void {
    const s = this.sensitivity * (1 - 0.45 * aim);
    this.yaw -= dx * s;
    this.pitch -= dy * s;
    this.pitch = THREE.MathUtils.clamp(this.pitch, PITCH_MIN, PITCH_MAX);
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2; else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
  }

  addShake(intensity: number, duration: number): void {
    this.trauma = Math.min(1, this.trauma + intensity);
    this.shakeTimer = Math.max(this.shakeTimer, duration);
  }

  addRecoil(pitch: number, yaw: number): void {
    this.recoilPitch += pitch;
    this.recoilYaw += yaw;
    // part of the kick is permanent so the player must compensate
    this.pitch = THREE.MathUtils.clamp(this.pitch + pitch * 0.35, PITCH_MIN, PITCH_MAX);
    this.yaw += yaw * 0.35;
  }

  /** Cutscene camera. `weight` target 1 = fully overridden; call with null to release. */
  setOverride(pos: THREE.Vector3 | null, lookAt?: THREE.Vector3, snap = false): void {
    if (pos) {
      this.overridePos.copy(pos);
      if (lookAt) this.overrideLook.copy(lookAt);
      this.overrideTarget = 1;
      if (snap) this.overrideWeight = 1;
    } else {
      this.overrideTarget = 0;
    }
  }

  snapTo(pivot: THREE.Vector3, yaw: number): void {
    this.yaw = yaw; this.pitch = -0.12;
    this.pivot.copy(pivot); this.pivotInit = true;
    this.distSpring.value = 3.2; this.distSpring.velocity = 0;
    this.recoilPitch = this.recoilYaw = 0;
    this.trauma = 0;
  }

  /** Horizontal forward from yaw. */
  getForward(out: THREE.Vector3): THREE.Vector3 {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }
  /** Full 3D look direction (including pitch & recoil offsets). */
  getLookDir(out: THREE.Vector3): THREE.Vector3 {
    const p = this.pitch + this.recoilPitch, y = this.yaw + this.recoilYaw;
    const cp = Math.cos(p);
    return out.set(-Math.sin(y) * cp, Math.sin(p), -Math.cos(y) * cp);
  }

  update(dt: number, inp: RigInput): void {
    // ── recoil recovery
    this.recoilPitch = damp(this.recoilPitch, 0, 9, dt);
    this.recoilYaw = damp(this.recoilYaw, 0, 9, dt);

    // ── pivot smoothing (vertical lags a little for stairs/slopes; horizontal tight)
    if (!this.pivotInit) { this.pivot.copy(inp.pivot); this.pivotInit = true; }
    this.pivot.x = damp(this.pivot.x, inp.pivot.x, 30, dt);
    this.pivot.z = damp(this.pivot.z, inp.pivot.z, 30, dt);
    this.pivot.y = damp(this.pivot.y, inp.pivot.y, inp.grounded ? 14 : 30, dt);

    // ── look basis
    const p = this.pitch + this.recoilPitch, y = this.yaw + this.recoilYaw;
    const cp = Math.cos(p);
    _fwd.set(-Math.sin(y) * cp, Math.sin(p), -Math.cos(y) * cp);
    _right.set(Math.cos(y), 0, -Math.sin(y));

    // ── distance: hip 3.2 / aim 1.8 / dead 4.5, pulled in by collisions
    const wantDist = inp.dead ? 4.5 : THREE.MathUtils.lerp(3.2 + 0.35 * inp.sprint, 1.8, inp.aim) - 0.25 * inp.crouch;
    const shoulder = THREE.MathUtils.lerp(0.55, 0.42, inp.aim);
    this.shoulder = damp(this.shoulder, shoulder, 10, dt);
    // pivot pushed to the shoulder side so the character sits left of the reticle
    _pivotS.copy(this.pivot).addScaledVector(_right, this.shoulder);
    // collision from shoulder pivot backward
    _dir.copy(_fwd).negate();
    let maxDist = wantDist;
    if (inp.world && inp.world.ready) {
      const hit = inp.world.raycast(_pivotS, _dir, wantDist + 0.3);
      if (hit) maxDist = Math.max(0.6, hit.distance - 0.3);
    }
    // ship interior: keep camera inside the box
    if (inp.shipBounds) {
      const c = inp.shipBounds.center, h = inp.shipBounds.halfExtents;
      // find largest t along -fwd staying in the box (slab test)
      let tMax = wantDist;
      const axes: Array<'x' | 'y' | 'z'> = ['x', 'y', 'z'];
      for (const ax of axes) {
        const d = _dir[ax];
        if (Math.abs(d) < 1e-5) continue;
        const bound = d > 0 ? c[ax] + h[ax] - 0.25 : c[ax] - h[ax] + 0.25;
        const t = (bound - _pivotS[ax]) / d;
        if (t >= 0) tMax = Math.min(tMax, t);
      }
      maxDist = Math.min(maxDist, Math.max(0.5, tMax));
    }
    // pull in instantly, ease out
    if (maxDist < this.distSpring.value) { this.distSpring.value = maxDist; this.distSpring.velocity = 0; this.collisionDist = maxDist; }
    else { this.collisionDist = maxDist; smoothDamp(this.distSpring, maxDist, 0.18, dt); }
    const dist = Math.min(this.distSpring.value, this.collisionDist);

    _desired.copy(_pivotS).addScaledVector(_fwd, -dist);

    // ── head-bob when moving on ground (reduced when aiming)
    const bobAmp = 0.028 * inp.moveBlend * (inp.grounded ? 1 : 0) * (1 - 0.7 * inp.aim) * (1 + 0.6 * inp.sprint);
    const bobY = Math.sin(inp.stridePhase * 2) * bobAmp;
    const bobX = Math.cos(inp.stridePhase) * bobAmp * 0.6;
    _desired.y += bobY;
    _desired.addScaledVector(_right, bobX);

    // ── spring-damped position for weight (tight so it never jitters against the pivot)
    if (dt > 0) dampVec3(this.position, _desired, 40, dt); else this.position.copy(_desired);

    // ── shake: trauma decays, noise offsets rotation
    if (this.shakeTimer > 0) this.shakeTimer -= dt; else this.trauma = damp(this.trauma, 0, 6, dt);
    if (this.shakeTimer > 0) this.trauma = damp(this.trauma, 0, 1.5, dt);
    const shake = this.trauma * this.trauma;
    const st = performance.now() * 0.001 * 18;
    const sx = noise1(st, this.shakeSeed) * 0.06 * shake;
    const sy = noise1(st, this.shakeSeed + 7) * 0.06 * shake;
    const sz = noise1(st, this.shakeSeed + 13) * 0.04 * shake;

    _euler.set(p, y, 0, 'YXZ');
    _q.setFromEuler(_euler);
    _euler.set(sx, sy, sz, 'YXZ');
    _qShake.setFromEuler(_euler);
    this.quaternion.copy(_q).multiply(_qShake);

    // ── FOV
    const targetFov = this.baseFov + 8 * inp.sprint * inp.moveBlend - 20 * inp.aim;
    this.fov = damp(this.fov, targetFov, 8, dt);

    // ── cutscene override blend
    this.overrideWeight = damp(this.overrideWeight, this.overrideTarget, this.overrideTarget > 0.5 ? 12 : 4, dt);
    if (this.overrideWeight > 0.001) {
      _m.lookAt(this.overridePos, this.overrideLook, _up);
      _overrideQ.setFromRotationMatrix(_m);
      this.camera.position.lerpVectors(this.position, this.overridePos, this.overrideWeight);
      this.camera.quaternion.slerpQuaternions(this.quaternion, _overrideQ, this.overrideWeight);
      // keep shake on top during override too
      this.camera.quaternion.multiply(_qShake);
    } else {
      this.camera.position.copy(this.position);
      this.camera.quaternion.copy(this.quaternion);
    }
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
