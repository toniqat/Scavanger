import * as THREE from 'three';
import {
  GRAVITY, IMPLANT_GRAPPLE_SPEED, PLAYER_HEIGHT, PLAYER_RADIUS, PLAYER_SPRINT_SPEED, PLAYER_WALK_SPEED,
  PLAYER_CROUCH_SPEED, PLAYER_PRONE_SPEED, ROLL_DISTANCE, ROLL_DURATION,
  type WorldRef, type Stance, type InteriorCollider,
} from '@/shared';
import { damp } from '@/core/util/MathUtil';

export interface MoveInput {
  x: number;      // -1..1 strafe (right +)
  z: number;      // -1..1 forward (+)
  sprint: boolean;
  jump: boolean;  // pressed this frame
  /** body stance decided by PlayerSystem (toggles, stand-up rules, airborne checks) */
  stance: Stance;
  aiming: boolean;
}

export interface MoveResult {
  footstep: boolean;
  /** > 0 when we touched down this frame (impact speed m/s) */
  landed: number;
  jumped: boolean;
  /** roll finished this frame (duration elapsed) → caller drops the roll blend */
  rollEnded: boolean;
}

export type ShipBounds = { center: THREE.Vector3; halfExtents: THREE.Vector3 } | null;

/**
 * 보행 위상이 도는(= 발소리가 나는) 최소 수평 속도(m/s). 이보다 느리면 위상은 중립으로 되감기기만 한다.
 * 원격 아바타의 발소리(`RemotePlayerSystem`)도 스냅샷 속도로 같은 문턱을 쓴다 — 두 곳의 기준이 갈리면
 * 원격만 제자리에서 소리가 난다.
 */
export const STRIDE_MIN_SPEED = 0.3;

const JUMP_SPEED = 7.6;
const GROUND_ACCEL = 34;
const GROUND_DECEL = 26;
const AIR_ACCEL = 7;
const SNAP_DOWN = 0.55;
const STEEP_COS = Math.cos(50 * Math.PI / 180);
/** Roll travel speed (m/s) so a ROLL_DURATION roll covers ROLL_DISTANCE. */
const ROLL_SPEED = ROLL_DISTANCE / ROLL_DURATION;
/** Terminal fall speed while the tactical backpack hovers. */
const HOVER_FALL_SPEED = -1.2;
/** Grapple: stop pulling this close to the anchor (the implant still owns the release). */
const GRAPPLE_ARRIVE = 1.4;

const _wish = new THREE.Vector3(), _hv = new THREE.Vector3(), _n = new THREE.Vector3(), _slide = new THREE.Vector3();
const _rayO = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _pull = new THREE.Vector3();
/** Ceiling probe: from the hips straight up; stops the jump when the head would pass through a deck above. */
const CEIL_PROBE_START = 0.6;

/**
 * Kinematic character controller: camera-relative acceleration, gravity, single jump, stances
 * (stand / crouch / prone speeds), the tactical-kit **roll** (fixed-speed ground burst, no steering),
 * grapple pull, backpack hover, external impulses, heightfield ground with slope sliding, obstacle
 * push-out via `world.resolveCollision`, a box-constrained mode for the extraction ship interior, and an
 * `InteriorCollider` mode (hub ships: flat decks via `getFloorAt`, wall push-out via the collider,
 * ceiling clamp via its raycast, no slope sliding, no map bounds).
 */
export class PlayerController {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  /** normalised world move direction (last non-zero) */
  readonly moveDir = new THREE.Vector3(0, 0, -1);
  /** horizontal unit direction of the current / last roll */
  readonly rollDir = new THREE.Vector3(0, 0, -1);
  grounded = true;
  stance: Stance = 'stand';
  sprinting = false;
  /** true from the roll launch until ROLL_DURATION elapsed */
  rolling = false;
  /** 0..1 progress through the current roll (stays at 1 after it ended) */
  rollProgress = 0;
  /** horizontal speed m/s */
  speed = 0;
  /** radians; a step every π */
  stridePhase = 0;
  shipBounds: ShipBounds = null;
  /** Ship-interior collider (hub). Takes precedence over `shipBounds` and the world while set. */
  interior: InteriorCollider | null = null;
  /** external move-speed multiplier (slows: spewer acid, exhaustion, standing up from prone, weight, buffs) */
  speedMultiplier = 1;
  /** jump impulse multiplier (√ of `DerivedStats.jumpHeightMul`, set by PlayerSystem) */
  jumpSpeedMul = 1;
  /** Grapple anchor (implants). While set the player is reeled toward it and gravity is suspended. */
  grappleTarget: THREE.Vector3 | null = null;
  /** Tactical backpack hover: caps the fall speed while airborne. */
  hovering = false;
  private lastStep = 0;
  private wasGrounded = true;
  private coyote = 0;
  private rollTimer = 0;

  get crouching(): boolean { return this.stance === 'crouch'; }
  get prone(): boolean { return this.stance === 'prone'; }
  /** Wire-compatible alias: the roll replaced the dive. */
  get diving(): boolean { return this.rolling; }

  reset(pos: THREE.Vector3): void {
    this.position.copy(pos);
    this.velocity.set(0, 0, 0);
    this.grounded = true; this.wasGrounded = true;
    this.stance = 'stand'; this.sprinting = false;
    this.rolling = false; this.rollTimer = 0; this.rollProgress = 0;
    this.grappleTarget = null; this.hovering = false;
    this.speed = 0; this.stridePhase = 0; this.lastStep = 0;
  }

  /**
   * Launch a roll in `dir` (horizontal unit vector). PlayerSystem has already checked stamina, cooldown,
   * stance, weight and ground contact. No steering until it ends.
   */
  startRoll(dir: THREE.Vector3): void {
    this.rollDir.set(dir.x, 0, dir.z);
    if (this.rollDir.lengthSq() < 1e-6) this.rollDir.set(0, 0, -1); else this.rollDir.normalize();
    this.velocity.x = this.rollDir.x * ROLL_SPEED;
    this.velocity.z = this.rollDir.z * ROLL_SPEED;
    this.rolling = true;
    this.rollTimer = 0;
    this.rollProgress = 0;
    this.sprinting = false;
    this.hovering = false;
  }

  /** Cancel an in-flight roll (death, downed, pod). */
  cancelRoll(): void {
    if (!this.rolling) return;
    this.rolling = false;
    this.rollTimer = 0;
    this.rollProgress = 1;
    this.velocity.x *= 0.3; this.velocity.z *= 0.3;
  }

  /** Add to the velocity (jump pad, rocket blast, jump backpack). Positive Y also unsticks from the ground. */
  applyImpulse(impulse: THREE.Vector3): void {
    this.velocity.add(impulse);
    if (impulse.y > 0.01) { this.grounded = false; this.coyote = 0; this.position.y += 0.02; }
  }

  /**
   * 발이 닿는 표면의 높이. 2026-09-09 부터 지형만이 아니라 **장애물 윗면**도 본다 (`getSurfaceY`) —
   * 낮은 바위 위로 걸어 올라갈 수 있는 이유다. `feetY` 를 반드시 넘겨라: 그래야 지금 발 높이에서
   * `PROP_STEP_UP_MAX` 안에 있는 윗면만 잡는다. 생략하면 그 자리에서 제일 높은 윗면이 나오는데
   * 그건 총알 · 낙하용 질의지 걷기용이 아니다.
   */
  groundHeight(x: number, z: number, world: WorldRef | null, feetY?: number): number {
    if (this.interior) return this.interior.getFloorAt(x, z);
    if (this.shipBounds) return this.shipBounds.center.y - this.shipBounds.halfExtents.y;
    if (world && world.ready) return world.getSurfaceY(x, z, feetY);
    return 0;
  }

  update(dt: number, inp: MoveInput, yaw: number, world: WorldRef | null, out: MoveResult): void {
    out.footstep = false; out.landed = 0; out.jumped = false; out.rollEnded = false;
    if (dt <= 0) return;
    const pos = this.position, vel = this.velocity;
    this.stance = inp.stance;

    // ── wish direction (camera relative)
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    _wish.set(fx * inp.z + rx * inp.x, 0, fz * inp.z + rz * inp.x);
    let wishLen = _wish.length();
    if (wishLen > 1) { _wish.divideScalar(wishLen); wishLen = 1; }
    const moving = wishLen > 0.01;

    // ── roll: fixed-speed ground burst in the launch direction, no steering
    if (this.rolling) {
      this.rollTimer += dt;
      this.rollProgress = Math.min(1, this.rollTimer / ROLL_DURATION);
      vel.x = this.rollDir.x * ROLL_SPEED;
      vel.z = this.rollDir.z * ROLL_SPEED;
      if (this.rollTimer >= ROLL_DURATION) {
        this.rolling = false;
        out.rollEnded = true;
        vel.x *= 0.35; vel.z *= 0.35;      // bleed the slide so the body stops where it landed
      }
    }

    const standing = this.stance === 'stand';
    const canSprint = inp.sprint && moving && inp.z > 0.2 && !inp.aiming && standing && !this.rolling;
    this.sprinting = canSprint;
    let targetSpeed = PLAYER_WALK_SPEED;
    if (this.stance === 'crouch') targetSpeed = PLAYER_CROUCH_SPEED;
    else if (this.stance === 'prone') targetSpeed = PLAYER_PRONE_SPEED;
    else if (canSprint) targetSpeed = PLAYER_SPRINT_SPEED;
    if (inp.aiming) targetSpeed = standing ? Math.min(targetSpeed, PLAYER_WALK_SPEED * 0.8) : targetSpeed * 0.85;
    targetSpeed *= wishLen * this.speedMultiplier;

    // ── horizontal velocity: accelerate toward wish (no control while rolling)
    _hv.set(vel.x, 0, vel.z);
    if (!this.rolling) {
      const accel = this.grounded ? (moving ? GROUND_ACCEL : GROUND_DECEL) : AIR_ACCEL;
      _wish.multiplyScalar(targetSpeed);
      const dx = _wish.x - _hv.x, dz = _wish.z - _hv.z;
      const dl = Math.hypot(dx, dz);
      if (dl > 1e-5) {
        const step = Math.min(dl, accel * dt);
        _hv.x += dx / dl * step; _hv.z += dz / dl * step;
      }
    }

    // ── slope handling (heightfield only)
    let steep = false;
    if (!this.interior && !this.shipBounds && world && world.ready && this.grounded && !this.rolling) {
      world.getNormalAt(pos.x, pos.z, _n);
      if (_n.y < STEEP_COS) {
        steep = true;
        _slide.set(_n.x, 0, _n.z);
        const l = _slide.length();
        if (l > 1e-4) {
          _slide.divideScalar(l);
          _hv.addScaledVector(_slide, GRAVITY * (1 - _n.y) * 1.5 * dt);
          // block uphill movement component
          const uphill = -(_hv.x * _slide.x + _hv.z * _slide.z);
          if (uphill > 0) _hv.addScaledVector(_slide, uphill * 0.85);
        }
      }
    }

    vel.x = _hv.x; vel.z = _hv.z;

    // ── jump / gravity
    if (this.grounded) this.coyote = 0.1; else this.coyote -= dt;
    if (inp.jump && this.coyote > 0 && standing && !steep && !this.rolling) {
      vel.y = JUMP_SPEED * this.jumpSpeedMul;
      this.grounded = false; this.coyote = 0;
      out.jumped = true;
    }
    if (this.grappleTarget) {
      // reeled in: full control of the velocity vector, no gravity
      _pull.copy(this.grappleTarget).sub(pos);
      _pull.y -= PLAYER_HEIGHT * 0.5;           // aim at the chest, not the feet
      const dist = _pull.length();
      if (dist > GRAPPLE_ARRIVE) {
        _pull.divideScalar(dist).multiplyScalar(IMPLANT_GRAPPLE_SPEED);
        vel.copy(_pull);
        this.grounded = false; this.coyote = 0;
      } else {
        vel.multiplyScalar(0.6);
      }
    } else if (!this.grounded) {
      vel.y -= GRAVITY * dt;
      // tactical backpack hover: bleed the fall down to a gentle drift (no fall damage on landing)
      if (this.hovering && vel.y < HOVER_FALL_SPEED) vel.y = damp(vel.y, HOVER_FALL_SPEED, 9, dt);
    } else {
      vel.y = Math.max(vel.y, 0);
    }

    // ── 움직이는 발판 (2026-09-09): 전차 데크처럼 `Obstacle.velocity` 를 가진 것 **윗면에 서 있으면** 함께
    //    실려 간다. 발판 속도는 `vel` 에 더하지 않고 **위치에 직접** 더한다 — 이동 속도 · 스태미나 · 보행
    //    애니메이션이 전차 속도로 흔들리지 않게. 실내(함선) 모드에서는 발판이 없으므로 건너뛴다.
    if (this.grounded && !this.interior && world && world.ready) {
      const ride = world.getStandingObstacle(pos.x, pos.z, pos.y)?.velocity;
      if (ride) { pos.x += ride.x * dt; pos.y += ride.y * dt; pos.z += ride.z * dt; }
    }

    // ── integrate
    pos.x += vel.x * dt;
    pos.z += vel.z * dt;
    pos.y += vel.y * dt;

    // ── collision & bounds
    if (this.interior) {
      this.interior.resolveCollision(pos, PLAYER_RADIUS);
      // ceiling: never let the head pass through a deck above (jumping inside a ship)
      if (vel.y > 0) {
        _rayO.set(pos.x, pos.y + CEIL_PROBE_START, pos.z);
        const hit = this.interior.raycast(_rayO, _up, PLAYER_HEIGHT - CEIL_PROBE_START + 0.05);
        if (hit) {
          const maxFeet = _rayO.y + hit.distance - PLAYER_HEIGHT;
          if (pos.y > maxFeet) { pos.y = maxFeet; vel.y = 0; }
        }
      }
    } else if (this.shipBounds) {
      const c = this.shipBounds.center, h = this.shipBounds.halfExtents;
      pos.x = THREE.MathUtils.clamp(pos.x, c.x - h.x + PLAYER_RADIUS, c.x + h.x - PLAYER_RADIUS);
      pos.z = THREE.MathUtils.clamp(pos.z, c.z - h.z + PLAYER_RADIUS, c.z + h.z - PLAYER_RADIUS);
    } else if (world && world.ready) {
      // 지형지물 위 걷기 (2026-09-09): **표면을 먼저 잡고** 밀어낸다. `getSurfaceY(x, z, feetY)` 는 지금 발
      // 높이에서 `PROP_STEP_UP_MAX` 안에 있는 윗면만 돌려주고, 일단 올라선 뒤에는 `resolveCollision` 이
      // 같은 `PROP_TOP_MARGIN` 판정으로 그 장애물을 밀어내지 않는다. 순서를 뒤집으면 옆으로 밀려난
      // 다음이라 낮은 바위에 영영 못 올라간다.
      if (this.grounded) {
        const step = world.getSurfaceY(pos.x, pos.z, pos.y);
        if (step > pos.y) pos.y = step;
      }
      world.resolveCollision(pos, PLAYER_RADIUS);
    }

    // ── ground contact
    const g = this.groundHeight(pos.x, pos.z, world, pos.y);
    const wasGrounded = this.grounded;
    if (pos.y <= g + 0.001) {
      if (!wasGrounded && vel.y < -1) out.landed = -vel.y;
      pos.y = g; vel.y = 0; this.grounded = true;
    } else if (wasGrounded && vel.y <= 0 && pos.y - g < SNAP_DOWN) {
      pos.y = g; vel.y = 0; this.grounded = true;
    } else {
      this.grounded = false;
    }
    this.wasGrounded = wasGrounded;
    if (this.grounded) this.hovering = false;

    // ── stride / footsteps
    this.speed = Math.hypot(vel.x, vel.z);
    if (this.speed > 0.2) { this.moveDir.set(vel.x, 0, vel.z).normalize(); }
    if (this.grounded && this.speed > STRIDE_MIN_SPEED && !this.rolling) {
      // meters per full cycle (2 steps); prone = crawl reach
      const strideLen = this.sprinting ? 1.9 : this.stance === 'crouch' ? 1.1 : this.stance === 'prone' ? 0.8 : 1.45;
      this.stridePhase += (this.speed * dt / strideLen) * Math.PI * 2;
      const stepIdx = Math.floor(this.stridePhase / Math.PI);
      if (stepIdx !== this.lastStep) { this.lastStep = stepIdx; out.footstep = true; }
    } else if (this.grounded) {
      // settle the phase to the nearest neutral pose so legs return smoothly
      const target = Math.round(this.stridePhase / Math.PI) * Math.PI;
      this.stridePhase += (target - this.stridePhase) * Math.min(1, dt * 10);
      this.lastStep = Math.floor(this.stridePhase / Math.PI);
    }
  }
}
