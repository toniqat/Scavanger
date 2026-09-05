import * as THREE from 'three';
import {
  GRAVITY, PLAYER_HEIGHT, PLAYER_RADIUS, PLAYER_SPRINT_SPEED, PLAYER_WALK_SPEED, PLAYER_CROUCH_SPEED, PLAYER_PRONE_SPEED,
  type WorldRef, type Stance, type InteriorCollider,
} from '@/shared';

export interface MoveInput {
  x: number;      // -1..1 strafe (right +)
  z: number;      // -1..1 forward (+)
  sprint: boolean;
  jump: boolean;  // pressed this frame
  /** body stance decided by PlayerSystem (toggles, stand-up rules, airborne checks) */
  stance: Stance;
  /** launch a dive this frame (PlayerSystem has already checked stamina / grounded / stance) */
  dive: boolean;
  aiming: boolean;
}

export interface MoveResult {
  footstep: boolean;
  /** > 0 when we touched down this frame (impact speed m/s) */
  landed: number;
  jumped: boolean;
  /** dive launched this frame (`diveDir` holds the horizontal direction) */
  dived: boolean;
  /** dive finished this frame (touched ground or timed out) → caller sets stance = 'prone' */
  diveEnded: boolean;
}

export type ShipBounds = { center: THREE.Vector3; halfExtents: THREE.Vector3 } | null;

const JUMP_SPEED = 7.6;
const GROUND_ACCEL = 34;
const GROUND_DECEL = 26;
const AIR_ACCEL = 7;
const SNAP_DOWN = 0.55;
const STEEP_COS = Math.cos(50 * Math.PI / 180);
const DIVE_SPEED = 7.5;
const DIVE_UP = 3.0;
const DIVE_MAX_TIME = 0.9;

const _wish = new THREE.Vector3(), _hv = new THREE.Vector3(), _n = new THREE.Vector3(), _slide = new THREE.Vector3();
const _rayO = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
/** Ceiling probe: from the hips straight up; stops the jump when the head would pass through a deck above. */
const CEIL_PROBE_START = 0.6;

/**
 * Kinematic character controller: camera-relative acceleration, gravity, single jump, stances
 * (stand / crouch / prone speeds), dive launch (no control until touchdown), heightfield ground
 * with slope sliding, obstacle push-out via `world.resolveCollision`, a box-constrained mode
 * for the extraction ship interior, and an `InteriorCollider` mode (hub ships: flat decks via `getFloorAt`,
 * wall push-out via the collider, ceiling clamp via its raycast, no slope sliding, no map bounds).
 */
export class PlayerController {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  /** normalised world move direction (last non-zero) */
  readonly moveDir = new THREE.Vector3(0, 0, -1);
  /** horizontal unit direction of the current / last dive */
  readonly diveDir = new THREE.Vector3(0, 0, -1);
  grounded = true;
  stance: Stance = 'stand';
  sprinting = false;
  /** true from dive launch until touchdown (or DIVE_MAX_TIME) */
  diving = false;
  /** horizontal speed m/s */
  speed = 0;
  /** radians; a step every π */
  stridePhase = 0;
  shipBounds: ShipBounds = null;
  /** Ship-interior collider (hub). Takes precedence over `shipBounds` and the world while set. */
  interior: InteriorCollider | null = null;
  /** external move-speed multiplier (slows: spewer acid, exhaustion, standing up from prone) */
  speedMultiplier = 1;
  private lastStep = 0;
  private wasGrounded = true;
  private coyote = 0;
  private diveTimer = 0;

  get crouching(): boolean { return this.stance === 'crouch'; }
  get prone(): boolean { return this.stance === 'prone'; }

  reset(pos: THREE.Vector3): void {
    this.position.copy(pos);
    this.velocity.set(0, 0, 0);
    this.grounded = true; this.wasGrounded = true;
    this.stance = 'stand'; this.sprinting = false;
    this.diving = false; this.diveTimer = 0;
    this.speed = 0; this.stridePhase = 0; this.lastStep = 0;
  }

  groundHeight(x: number, z: number, world: WorldRef | null): number {
    if (this.interior) return this.interior.getFloorAt(x, z);
    if (this.shipBounds) return this.shipBounds.center.y - this.shipBounds.halfExtents.y;
    if (world && world.ready) return world.getHeightAt(x, z);
    return 0;
  }

  update(dt: number, inp: MoveInput, yaw: number, world: WorldRef | null, out: MoveResult): void {
    out.footstep = false; out.landed = 0; out.jumped = false; out.dived = false; out.diveEnded = false;
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

    // ── dive launch: horizontal burst in the move direction (or camera forward), small hop
    if (inp.dive && this.grounded && !this.diving) {
      if (moving) this.diveDir.copy(_wish).divideScalar(wishLen); else this.diveDir.set(fx, 0, fz);
      vel.x = this.diveDir.x * DIVE_SPEED; vel.z = this.diveDir.z * DIVE_SPEED; vel.y = DIVE_UP;
      this.diving = true; this.diveTimer = 0;
      this.grounded = false; this.coyote = 0;
      this.sprinting = false;
      out.dived = true;
    }

    const standing = this.stance === 'stand';
    const canSprint = inp.sprint && moving && inp.z > 0.2 && !inp.aiming && standing && !this.diving;
    this.sprinting = canSprint;
    let targetSpeed = PLAYER_WALK_SPEED;
    if (this.stance === 'crouch') targetSpeed = PLAYER_CROUCH_SPEED;
    else if (this.stance === 'prone') targetSpeed = PLAYER_PRONE_SPEED;
    else if (canSprint) targetSpeed = PLAYER_SPRINT_SPEED;
    if (inp.aiming) targetSpeed = standing ? Math.min(targetSpeed, PLAYER_WALK_SPEED * 0.8) : targetSpeed * 0.85;
    targetSpeed *= wishLen * this.speedMultiplier;

    // ── horizontal velocity: accelerate toward wish (no control while diving)
    _hv.set(vel.x, 0, vel.z);
    if (!this.diving) {
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
    if (!this.interior && !this.shipBounds && world && world.ready && this.grounded) {
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
    if (inp.jump && this.coyote > 0 && standing && !steep && !this.diving) {
      vel.y = JUMP_SPEED;
      this.grounded = false; this.coyote = 0;
      out.jumped = true;
    }
    if (!this.grounded) vel.y -= GRAVITY * dt;
    else vel.y = Math.max(vel.y, 0);

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
      world.resolveCollision(pos, PLAYER_RADIUS);
    }

    // ── ground contact
    const g = this.groundHeight(pos.x, pos.z, world);
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

    // ── dive end: touchdown or timeout → caller goes prone
    if (this.diving) {
      this.diveTimer += dt;
      if ((this.grounded && !out.dived) || this.diveTimer >= DIVE_MAX_TIME) {
        this.diving = false;
        out.diveEnded = true;
        // bleed the slide off quickly so the body stops where it hit
        vel.x *= 0.35; vel.z *= 0.35;
      }
    }

    // ── stride / footsteps
    this.speed = Math.hypot(vel.x, vel.z);
    if (this.speed > 0.2) { this.moveDir.set(vel.x, 0, vel.z).normalize(); }
    if (this.grounded && this.speed > 0.3 && !this.diving) {
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
