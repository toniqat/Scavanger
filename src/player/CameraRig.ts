import * as THREE from 'three';
import { SLASH_FOV_MUL, type InteriorCollider, type WorldRef } from '@/shared';
import { damp, dampVec3, noise1, smoothDamp, type SpringState } from '@/core/util/MathUtil';

export interface RigInput {
  /** world-space pivot (player feet + eye height) */
  pivot: THREE.Vector3;
  aim: number;          // 0..1 blend
  sprint: number;       // 0..1
  crouch: number;       // 0..1
  prone: number;        // 0..1
  dive: number;         // 0..1
  moveBlend: number;    // 0..1
  stridePhase: number;  // kept for API symmetry; the camera no longer reacts to it
  grounded: boolean;
  dead: boolean;
  world: WorldRef | null;
  shipBounds: { center: THREE.Vector3; halfExtents: THREE.Vector3 } | null;
  /** Hub ship interior: camera collides with `interior.raycast` and is clamped to `interior.bounds` (replaces the terrain). */
  interior: InteriorCollider | null;
}

const DEG = Math.PI / 180;
const PITCH_MIN = -60 * DEG;
const PITCH_MIN_PRONE = -25 * DEG;
/** Prone with the ground rising behind the player: the camera may barely look down at all. */
const PITCH_MIN_PRONE_SLOPE = -6 * DEG;
const PITCH_MAX = 70 * DEG;

const HIP_DIST = 3.2;
const ADS_DIST = 1.8;
const SCOPE_DIST = 0.7;
const HIP_SHOULDER = 0.55;
/** ADS pushes the camera further over the shoulder and lifts the pivot so the soldier sits bottom-left of the reticle. */
const ADS_SHOULDER = 0.68;
const ADS_PIVOT_LIFT = 0.22;
const SCOPE_SHOULDER = 0.35;
const SPRINT_FOV_KICK = 3;
const ADS_FOV_DROP = 20;
/** Camera must stay this far above the terrain (segment samples) … */
const TERRAIN_CLEARANCE = 0.35;
/** … and is hard-clamped to this height above the terrain at its final position. */
const TERRAIN_FLOOR = 0.3;
const TERRAIN_SAMPLES = 4;
/** How far behind the player the terrain is probed to detect a rising slope while prone (m). */
const REAR_PROBE = 1.5;
const REAR_RISE_MAX = 1.5;

const _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _desired = new THREE.Vector3();
const _pivotS = new THREE.Vector3(), _rayO = new THREE.Vector3(), _dir = new THREE.Vector3(), _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _q = new THREE.Quaternion(), _qShake = new THREE.Quaternion(), _overrideQ = new THREE.Quaternion();
const _m = new THREE.Matrix4(), _up = new THREE.Vector3(0, 1, 0);

/**
 * Over-the-right-shoulder third-person rig with spring-damped follow, terrain / interior collision,
 * sprint/aim FOV (weapon-driven zoom), recoil and trauma-based screen shake. Also supports a
 * cutscene override pose (hellpod drop, hub docking / launch) that blends back to the rig.
 *
 * Collision model (all pull-ins are instant, the ease-out is a spring that can never overshoot the
 * collision distance):
 * 1. a ray from the shoulder pivot toward the desired camera position against `world.raycast`
 *    (terrain + obstacle cylinders) and, when set, `interior.raycast` (walls / props / decks);
 * 2. the terrain height sampled at 4 points along the remaining segment — the camera is pulled in
 *    to the first point where it would dip under terrain + TERRAIN_CLEARANCE;
 * 3. a slab clamp against `interior.bounds` (hub) or `shipBounds` (extraction dropship);
 * 4. a hard vertical clamp at the final position: never below `getHeightAt(x, z) + TERRAIN_FLOOR`.
 * Prone on a slope: when the ground REAR_PROBE m behind the player is higher than the feet, the pivot
 * is lifted by part of the rise and the pitch-down limit blends from −25° toward −6°.
 *
 * Motion-sickness rules: nothing here oscillates with the stride phase. The pivot's vertical
 * follow is soft on the ground so stride/terrain micro-bumps never reach the camera, while the
 * horizontal follow stays tight.
 */
export class CameraRig {
  yaw = 0;
  /** + = look up */
  pitch = -0.12;
  sensitivity = 0.0022;

  readonly baseFov = 70;
  private fov = 70;
  /** ADS FOV divisor from the active weapon (1 = default ADS, 4 = sniper scope). */
  aimZoom = 1;
  /** 용검 slash view widen (`PlayerRef.setViewWiden`): target FOV × SLASH_FOV_MUL while true, damped both ways. */
  viewWiden = false;
  private fovMul = 1;
  /** true → while aiming the camera tucks into the shoulder so the soldier leaves the frame. */
  scoped = false;
  private pitchMin = PITCH_MIN;
  private readonly distSpring: SpringState = { value: HIP_DIST, velocity: 0 };
  private readonly pivot = new THREE.Vector3();
  private pivotInit = false;
  private shoulder = HIP_SHOULDER;
  private collisionDist = 10;
  private rearRise = 0;
  private pivotDist = HIP_DIST;

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

  /** Current (damped) vertical FOV in degrees. */
  get currentFov(): number { return this.fov; }
  /** Distance from the actual camera (override included) to the shoulder pivot — drives the near-clip body fade. */
  get pivotDistance(): number { return this.pivotDist; }
  /** true while a cutscene override owns most of the camera. */
  get isOverridden(): boolean { return this.overrideWeight > 0.5; }

  /** Mouse look (pixels). Sensitivity scales with the FOV ratio while aiming (4× scope → ¼ sensitivity). */
  applyLook(dx: number, dy: number, aim: number): void {
    const s = this.sensitivity * THREE.MathUtils.lerp(1, this.fov / this.baseFov, aim);
    this.yaw -= dx * s;
    this.pitch -= dy * s;
    this.pitch = THREE.MathUtils.clamp(this.pitch, this.pitchMin, PITCH_MAX);
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
    this.pitch = THREE.MathUtils.clamp(this.pitch + pitch * 0.35, this.pitchMin, PITCH_MAX);
    this.yaw += yaw * 0.35;
  }

  /** Weapon-driven ADS zoom. zoom ≤ 1 → default ADS (base − 20°); zoom > 1 → base / zoom. */
  setAimZoom(zoom: number, scope: boolean): void {
    this.aimZoom = Math.max(1, zoom || 1);
    this.scoped = scope;
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
    this.distSpring.value = HIP_DIST; this.distSpring.velocity = 0;
    this.collisionDist = HIP_DIST;
    this.recoilPitch = this.recoilYaw = 0;
    this.trauma = 0;
    this.rearRise = 0;
    this.pitchMin = PITCH_MIN;
    // place the camera behind the pivot right away so the first frame doesn't lerp from the old spot
    _pivotS.set(pivot.x + Math.cos(yaw) * HIP_SHOULDER, pivot.y, pivot.z - Math.sin(yaw) * HIP_SHOULDER);
    this.position.set(_pivotS.x + Math.sin(yaw) * HIP_DIST, _pivotS.y + 0.38, _pivotS.z + Math.cos(yaw) * HIP_DIST);
  }

  /**
   * Teleport follow (`PlayerRef.teleport`): move the pivot and carry the camera along by the same offset, keeping
   * pitch / yaw (unless `yaw` is given), the distance spring and the collision state — so a per-frame move cheat
   * never resets the look and nothing lerps across the map on the next frame.
   */
  jumpTo(pivot: THREE.Vector3, yaw?: number): void {
    if (yaw !== undefined) this.yaw = yaw;
    if (this.pivotInit) { _pivotS.subVectors(pivot, this.pivot); this.position.add(_pivotS); }
    this.pivot.copy(pivot); this.pivotInit = true;
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
    const world = inp.world && inp.world.ready && !inp.interior ? inp.world : null;

    // ── recoil recovery
    this.recoilPitch = damp(this.recoilPitch, 0, 9, dt);
    this.recoilYaw = damp(this.recoilYaw, 0, 9, dt);

    // ── prone on a slope: probe the terrain behind the player; a rising rear lifts the pivot and
    //    narrows the pitch-down range so the camera never orbits into the hillside
    let rearRise = 0;
    if (inp.prone > 0.001 && world) {
      const hFeet = world.getHeightAt(inp.pivot.x, inp.pivot.z);
      const bx = inp.pivot.x + Math.sin(this.yaw) * REAR_PROBE, bz = inp.pivot.z + Math.cos(this.yaw) * REAR_PROBE;
      rearRise = THREE.MathUtils.clamp(world.getHeightAt(bx, bz) - hFeet, 0, REAR_RISE_MAX);
    }
    this.rearRise = damp(this.rearRise, rearRise, 6, dt);
    const slopeT = this.rearRise / REAR_RISE_MAX;
    const proneMin = THREE.MathUtils.lerp(PITCH_MIN_PRONE, PITCH_MIN_PRONE_SLOPE, slopeT);
    this.pitchMin = THREE.MathUtils.lerp(PITCH_MIN, proneMin, inp.prone);
    if (this.pitch < this.pitchMin) this.pitch = damp(this.pitch, this.pitchMin, 12, dt);
    // ADS (non-scoped): lift the pivot so the character drops toward the bottom-left of the frame, clear of the reticle
    const adsLift = this.scoped ? 0 : ADS_PIVOT_LIFT * inp.aim;
    const pivotLift = this.rearRise * 0.6 * inp.prone + adsLift;

    // ── pivot smoothing: vertical is soft on the ground (stride / terrain bumps stay out of the
    //    camera), horizontal stays tight so strafing never lags
    if (!this.pivotInit) { this.pivot.copy(inp.pivot); this.pivotInit = true; }
    this.pivot.x = damp(this.pivot.x, inp.pivot.x, 30, dt);
    this.pivot.z = damp(this.pivot.z, inp.pivot.z, 30, dt);
    this.pivot.y = damp(this.pivot.y, inp.pivot.y + pivotLift, inp.grounded ? 7 : 30, dt);

    // ── look basis
    const p = this.pitch + this.recoilPitch, y = this.yaw + this.recoilYaw;
    const cp = Math.cos(p);
    _fwd.set(-Math.sin(y) * cp, Math.sin(p), -Math.cos(y) * cp);
    _right.set(Math.cos(y), 0, -Math.sin(y));

    // ── distance: hip 3.2 / ADS 1.8 / scoped 0.7 / dead 4.5, pulled in by collisions
    const hipDist = HIP_DIST + 0.35 * inp.sprint - 0.25 * inp.crouch - 0.5 * inp.prone + 0.3 * inp.dive;
    const adsDist = this.scoped ? SCOPE_DIST : ADS_DIST;
    const wantDist = inp.dead ? 4.5 : THREE.MathUtils.lerp(hipDist, adsDist, inp.aim);
    const shoulder = THREE.MathUtils.lerp(HIP_SHOULDER, this.scoped ? SCOPE_SHOULDER : ADS_SHOULDER, inp.aim);
    this.shoulder = damp(this.shoulder, shoulder, 10, dt);
    // pivot pushed to the shoulder side so the character sits left of the reticle
    _pivotS.copy(this.pivot).addScaledVector(_right, this.shoulder);
    _dir.copy(_fwd).negate();
    // while prone the pivot is 0.45 m off the ground, so the world ray starts a little higher and
    // the camera never collapses closer than ~1.2 m
    const minDist = Math.min(wantDist, THREE.MathUtils.lerp(0.6, 1.2, inp.prone));
    let maxDist = wantDist;

    // 1. ray vs terrain + obstacles / vs the interior
    if (world) {
      _rayO.copy(_pivotS); _rayO.y += 0.35 * inp.prone;
      const hit = world.raycast(_rayO, _dir, wantDist + 0.3);
      if (hit) maxDist = Math.max(minDist, hit.distance - 0.3);
    }
    if (inp.interior) {
      const hit = inp.interior.raycast(_pivotS, _dir, wantDist + 0.3);
      if (hit) maxDist = Math.min(maxDist, Math.max(0.5, hit.distance - 0.3));
    }

    // 2. terrain clearance along the segment: pull in to the first sample that dips under the surface
    if (world) {
      let prevT = 0;
      let prevGap = Infinity; // camera height minus (terrain + clearance) at the previous sample
      for (let i = 1; i <= TERRAIN_SAMPLES; i++) {
        const t = maxDist * i / TERRAIN_SAMPLES;
        const sx = _pivotS.x + _dir.x * t, sy = _pivotS.y + _dir.y * t, sz = _pivotS.z + _dir.z * t;
        const gap = sy - (world.getHeightAt(sx, sz) + TERRAIN_CLEARANCE);
        if (gap < 0) {
          // linear crossing between the last good sample and this one
          const f = prevGap === Infinity || prevGap <= 0 ? 0 : prevGap / (prevGap - gap);
          maxDist = Math.max(minDist, prevT + (t - prevT) * f);
          break;
        }
        prevT = t; prevGap = gap;
      }
    }

    // 3. bounds slab (hub interior or extraction dropship): keep the camera inside the box
    const bounds = inp.interior ? inp.interior.bounds : inp.shipBounds;
    if (bounds) {
      const c = bounds.center, h = bounds.halfExtents;
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

    // pull in instantly, ease out; the spring output is capped by the live collision distance so the
    // camera can never pop through on the way back out
    if (maxDist < this.distSpring.value) { this.distSpring.value = maxDist; this.distSpring.velocity = 0; this.collisionDist = maxDist; }
    else { this.collisionDist = maxDist; smoothDamp(this.distSpring, maxDist, 0.18, dt); }
    const dist = Math.min(this.distSpring.value, this.collisionDist);

    _desired.copy(_pivotS).addScaledVector(_fwd, -dist);
    // 4. hard floor: never under the terrain at the final position
    if (world) {
      const floor = world.getHeightAt(_desired.x, _desired.z) + TERRAIN_FLOOR;
      if (_desired.y < floor) _desired.y = floor;
    }

    // ── spring-damped position for weight (tight so it never jitters against the pivot)
    if (dt > 0) dampVec3(this.position, _desired, 40, dt); else this.position.copy(_desired);
    if (world) {
      const floor = world.getHeightAt(this.position.x, this.position.z) + TERRAIN_FLOOR;
      if (this.position.y < floor) this.position.y = floor;
    }

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

    // ── FOV: gentle sprint kick; ADS either the default −20° or the weapon's zoom divisor
    const hipFov = this.baseFov + SPRINT_FOV_KICK * inp.sprint * inp.moveBlend;
    const aimFov = this.aimZoom > 1 ? this.baseFov / this.aimZoom : this.baseFov - ADS_FOV_DROP;
    const targetFov = THREE.MathUtils.lerp(hipFov, aimFov, inp.aim);
    // view widen (big slash): multiplies whatever the sprint / ADS logic wants, snappy in, softer out
    this.fovMul = damp(this.fovMul, this.viewWiden ? SLASH_FOV_MUL : 1, this.viewWiden ? 14 : 7, dt);
    this.fov = damp(this.fov, Math.min(150, targetFov * this.fovMul), 6, dt);

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
    this.pivotDist = this.camera.position.distanceTo(_pivotS);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
