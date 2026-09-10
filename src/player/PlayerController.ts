import * as THREE from 'three';
import {
  GRAVITY, IMPLANT_GRAPPLE_SPEED, PLAYER_HEIGHT, PLAYER_RADIUS, PLAYER_SPRINT_SPEED, PLAYER_WALK_SPEED,
  PLAYER_CROUCH_SPEED, PLAYER_PRONE_SPEED, ROLL_DISTANCE, ROLL_DURATION,
  RIDE_EDGE_MARGIN, RIDE_FOOT_DROP, RIDE_HEADROOM, RIDE_INERTIA_DAMP, RIDE_INERTIA_S,
  type Obstacle, type WorldRef, type Stance, type InteriorCollider,
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
/** 차량 탑승 스크래치 — 차량의 현재 변환으로 푼 자리. */
const _ride = new THREE.Vector3();
/** Ceiling probe: from the hips straight up; stops the jump when the head would pass through a deck above. */
const CEIL_PROBE_START = 0.6;

/* ── 차량 탑승 좌표 변환 (2026-09-10) ────────────────────────────────────────────────────────────────
 * `Obstacle.box`(계약, 2026-09-09)는 `{halfX, halfZ, yaw}` 이고 `yaw` 는 수학 규약(로컬 +X → 월드
 * `(cos, sin)`)이다. 여기서는 그 **계약 필드만** 읽어 세 줄짜리 회전을 직접 푼다 — `world/obb.ts` 를
 * import 하면 폴더 내부를 건드리는 것이고, 이만한 식을 `shared` 로 올릴 만큼 쓰는 곳이 많지도 않다.
 * 상자가 없는(원기둥) 발판은 yaw 0 으로 취급하므로 같은 코드가 그대로 돈다.
 */
/** 월드 좌표 → 차량 로컬 (`out.y` 는 **발판 윗면 기준** 높이). */
function recordRideLocal(c: Obstacle, pos: THREE.Vector3, out: THREE.Vector3): void {
  const yaw = c.box ? c.box.yaw : 0;
  const dx = pos.x - c.position.x, dz = pos.z - c.position.z;
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  out.set(dx * cs + dz * sn, pos.y - (c.position.y + c.height), -dx * sn + dz * cs);
}

/** 차량 로컬 → 월드 (차량의 **지금** 변환으로 푼다). */
function restoreRideLocal(c: Obstacle, local: THREE.Vector3, pos: THREE.Vector3): void {
  const yaw = c.box ? c.box.yaw : 0;
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  pos.set(
    c.position.x + local.x * cs - local.z * sn,
    c.position.y + c.height + local.y,
    c.position.z + local.x * sn + local.z * cs,
  );
}

/** 아직 이 차량에 타고 있는가 — 차량 단면(+`RIDE_EDGE_MARGIN`) 안이고 높이 범위 안일 때만. */
function rideContains(c: Obstacle, pos: THREE.Vector3): boolean {
  const top = c.position.y + c.height;
  if (pos.y > top + RIDE_HEADROOM || pos.y < top - RIDE_FOOT_DROP) return false;
  const dx = pos.x - c.position.x, dz = pos.z - c.position.z;
  if (!c.box) return dx * dx + dz * dz <= (c.radius + RIDE_EDGE_MARGIN) ** 2;
  const cs = Math.cos(c.box.yaw), sn = Math.sin(c.box.yaw);
  const lx = dx * cs + dz * sn, lz = -dx * sn + dz * cs;
  return Math.abs(lx) <= c.box.halfX + RIDE_EDGE_MARGIN && Math.abs(lz) <= c.box.halfZ + RIDE_EDGE_MARGIN;
}

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
  /**
   * 지금 타고 있는 **차량**(움직이는 발판). null = 걷고 있다. 2026-09-10 부터 탑승은 상태다 — 자세한 이유는
   * `updateRide` 의 주석에 있다. 참조는 `SpatialHash` 안의 살아 있는 `Obstacle` 이라 **매 프레임 현재
   * 변환을 다시 읽는다** (스냅샷을 찍지 않는다).
   */
  private carrier: Obstacle | null = null;
  /** 차량 로컬 좌표 (x = 차 길이 방향, z = 폭 방향, y = 발판 윗면 기준 높이). */
  private readonly rideLocal = new THREE.Vector3();
  /** `rideLocal` 을 적어 둔 순간의 **월드** 자리. 차이만 더하려고 들고 있다. */
  private readonly rideWorld = new THREE.Vector3();
  /** 하차 관성 (m/s, 월드 XZ). 마찰로 감쇠한다. */
  private readonly rideInertia = new THREE.Vector3();
  private rideInertiaT = 0;
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
    this.carrier = null; this.rideInertia.set(0, 0, 0); this.rideInertiaT = 0;
  }

  /** 지금 차량(전차 데크 등)에 타고 있는가. HUD · 디버그용. */
  get riding(): boolean { return this.carrier !== null; }

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

  /**
   * **차량(움직이는 발판) 탑승** — 진입 · 유지 · 이탈이 전부 여기 있다 (2026-09-10).
   *
   * ## 왜 상태인가
   * 2026-09-09 판은 매 프레임 `getStandingObstacle(...)?.velocity` 를 찾아 그 속도를 위치에 더했다.
   * 그러면 **발판 질의에서 한 프레임만 빠져도** 그 프레임만큼 차량이 발밑에서 빠져나간다 — 점프 · 경사 ·
   * 승강구 · 데크 가장자리에서 늘 생기는 일이고, 몇 프레임이면 차 밖이다 ("조금만 움직여도 내려진다").
   * 그래서 탑승을 **명시적인 상태**(`carrier`)로 들고, 유지 조건을 발판 질의가 아니라
   * **차량 OBB + 헤드룸**(`RIDE_*`)으로 본다. 특정 발판 프레임을 밟았는지는 진입에만 쓴다.
   *
   * ## 이동은 차량 좌표에서 푼다
   * 지난 프레임의 자리를 차량 로컬 좌표(`rideLocal`)로 적어 두고, 이번 프레임에 **차량의 현재 변환**으로
   * 다시 푼다 — 직선 속도만이 아니라 곡선 구간의 **회전**까지 정확히 따라가고, 프레임 누락이 없다.
   * 스냅샷은 절대 찍지 않는다 (`CLAUDE.md`: 함선 실내가 같은 이유로 깨졌다).
   *
   * ## `vel` 은 손대지 않는다
   * 옮기는 것은 **위치뿐**이고 `vel` 은 끝까지 **차량 기준 로컬 속도**다. 이동 속도 · 스태미나(`sprinting`) ·
   * 보행 애니메이션(`speed` · `stridePhase`)이 전차 속도로 흔들리지 않는다 — 2026-09-09 규약의 **이유**가
   * 그것이고, 여기서도 그대로 지킨다. 점프해도 헤드룸 안이므로 차량과 함께 날아간다.
   *
   * ## 하차
   * OBB(+`RIDE_EDGE_MARGIN`) 나 높이 범위를 벗어나면 그 순간의 차량 속도를 **관성**으로 넘겨받아
   * `RIDE_INERTIA_S` 동안 `RIDE_INERTIA_DAMP` 로 감쇠시킨다 — 달리는 전차에서 옆으로 뛰어내리면
   * 앞으로 날아간다.
   */
  private updateRide(dt: number, world: WorldRef | null): void {
    const pos = this.position;
    if (this.interior || this.shipBounds || !world || !world.ready) {
      this.releaseRide(false);
      this.applyRideInertia(dt);
      return;
    }
    // ① 유지 — 차량 OBB + 헤드룸 안이면 계속 탄 것이다 (발판을 밟았는지는 보지 않는다)
    if (this.carrier && !rideContains(this.carrier, pos)) this.releaseRide(true);
    // ② 진입 — 새로 잡을 때만 발판 질의를 쓴다. 잡은 프레임에는 옮기지 않는다 (차량은 이미 제자리다)
    if (!this.carrier && this.grounded) {
      const o = world.getStandingObstacle(pos.x, pos.z, pos.y);
      if (o && o.velocity) {
        this.carrier = o;
        this.rideInertia.set(0, 0, 0);
        this.rideInertiaT = 0;
        this.recordRide();
        return;
      }
    }
    // ③ 이동 — 차량의 **현재** 변환으로 지난 프레임의 로컬 좌표를 다시 푼다.
    //    자리를 통째로 덮어쓰지 않고 **차이만** 더한다 — 그 사이에 남이 몸을 옮겼다면(순간이동 · 임펄스)
    //    그것을 지우지 않기 위해서다.
    if (this.carrier) {
      restoreRideLocal(this.carrier, this.rideLocal, _ride);
      pos.x += _ride.x - this.rideWorld.x;
      pos.y += _ride.y - this.rideWorld.y;
      pos.z += _ride.z - this.rideWorld.z;
    } else {
      this.applyRideInertia(dt);
    }
  }

  /** 지금 자리를 차량 좌표로 적어 둔다 (다음 프레임에 차량의 새 변환으로 푼다). */
  private recordRide(): void {
    const c = this.carrier;
    if (!c) return;
    recordRideLocal(c, this.position, this.rideLocal);
    this.rideWorld.copy(this.position);
  }

  /** 하차. `keepInertia` 면 그 순간의 차량 속도를 관성으로 넘겨받는다. */
  private releaseRide(keepInertia: boolean): void {
    const c = this.carrier;
    if (!c) return;
    this.carrier = null;
    if (keepInertia && c.velocity) {
      this.rideInertia.set(c.velocity.x, 0, c.velocity.z);
      this.rideInertiaT = RIDE_INERTIA_S;
    } else {
      this.rideInertia.set(0, 0, 0);
      this.rideInertiaT = 0;
    }
  }

  /** 하차 관성: 위치에 더하고 지수 감쇠시킨다 (`vel` 에는 넣지 않는다 — 스태미나 · 보행이 흔들린다). */
  private applyRideInertia(dt: number): void {
    if (this.rideInertiaT <= 0) return;
    this.rideInertiaT -= dt;
    const pos = this.position;
    pos.x += this.rideInertia.x * dt;
    pos.z += this.rideInertia.z * dt;
    const k = Math.exp(-RIDE_INERTIA_DAMP * dt);
    this.rideInertia.x *= k;
    this.rideInertia.z *= k;
    if (this.rideInertiaT <= 0 || this.rideInertia.lengthSq() < 0.04) {
      this.rideInertiaT = 0;
      this.rideInertia.set(0, 0, 0);
    }
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

    // ── 차량 탑승 (2026-09-10): 차량이 이번 프레임에 옮겨 간 만큼 몸을 먼저 옮긴다. `vel` 은 손대지 않는다.
    this.updateRide(dt, world);

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

    // 이번 프레임의 최종 자리를 **차량 좌표로 다시 적어 둔다** — 다음 프레임에 차량의 새 변환으로 푼다.
    this.recordRide();

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
