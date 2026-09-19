import * as THREE from 'three';
import {
  BOX_HEADROOM,
  GRAVITY, IMPLANT_GRAPPLE_SPEED, PLAYER_CROUCH_CLEARANCE_M, PLAYER_HEIGHT, PLAYER_PRONE_CLEARANCE_M, PLAYER_RADIUS, PLAYER_SPRINT_SPEED, PLAYER_WALK_SPEED,
  PLAYER_CROUCH_SPEED, PLAYER_PRONE_SPEED, ROLL_DISTANCE, ROLL_DURATION,
  RIDE_INERTIA_DAMP, RIDE_INERTIA_S, recordRideLocal, restoreRideLocal, rideContains,
  LADDER_CLIMB_SPEED, LADDER_DROP_PUSH, LADDER_JUMP_PUSH, LADDER_JUMP_SPEED, LADDER_MOUNT_S, LADDER_SPRINT_SPEED,
  type LadderDef, type Obstacle, type WorldRef, type Stance, type InteriorCollider,
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
  /* ── appended (2026-09-11): ladder ── */
  /** One ladder rung was passed (the `ladder_step` sound). */
  rung: boolean;
  /** Why the ladder was released this frame, if it was. */
  climbEnded: ClimbEnd | null;
  /* ── appended (2026-09-14): global fall damage ── */
  /**
   * The **fall height** (m) if the body landed this frame — the height the fall started from (the peak reached
   * while airborne) − the landing height. 0 when it did not land or the fall is **exempt** (`fallExempt` —
   * grapple · bag hover · a vehicle deck · releasing a ladder · the ship interior). Turning height into damage
   * is `player/parts/Fall`'s job; the controller measures the **height only**.
   */
  fallHeight: number;
}

/** Why the ladder was released — mounted at the top · stepped off at the bottom · released with E · jumped. */
export type ClimbEnd = 'top' | 'bottom' | 'drop' | 'jump';

/** Input while hanging on (PlayerSystem fills it from the key · stamina rules). */
export interface ClimbInput {
  /** -1..1 (W = +1 up, S = -1 down) */
  z: number;
  /** the sprint key + stamina left → `LADDER_SPRINT_SPEED` */
  fast: boolean;
  /** jump this frame (the caller has already checked the stamina) */
  jump: boolean;
  /** E this frame — releases on the spot and drops */
  drop: boolean;
}

export type ShipBounds = { center: THREE.Vector3; halfExtents: THREE.Vector3 } | null;

/**
 * Minimum horizontal speed (m/s) at which the stride phase turns (= footsteps sound). Slower than this and the phase
 * only rewinds toward neutral. Remote avatars' footsteps (`RemotePlayerSystem`) use the same threshold on the
 * snapshot speed — if the two differ, only remote bodies make footstep sounds standing still.
 */
export const STRIDE_MIN_SPEED = 0.3;

/**
 * Ladder rung spacing (m) — every rung the hanging body's vertical movement passes turns the stride phase by π (one
 * hand takes the next rung). Remote avatars (`RemoteAvatar`) build the same phase from the snapshot height change.
 */
export const LADDER_RUNG_M = 0.35;
/* Ladder geometry (bound to the body's dimensions — speed · stamina are `LADDER_*` in `data/constants.csv`). */
/** Once the feet reach this far below `topY`, W starts the mount onto the roof (`LADDER_MOUNT_S`). */
const LADDER_MOUNT_MARGIN = 0.2;
/** Grabbing at the top hangs the feet this far below `topY` (the head at the roof opening's height). */
const LADDER_TOP_GRAB_DEPTH = 1.1;
/** Grabbing at the bottom lifts the feet to at most this far below `topY` (so the mount does not start at once). */
const LADDER_BOTTOM_GRAB_CLEAR = 0.5;

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
/** Ride scratch — the spot solved with the vehicle's current transform. */
const _ride = new THREE.Vector3();
/** Ceiling probe: from the hips straight up; stops the jump when the head would pass through a deck above. */
const CEIL_PROBE_START = 0.6;
/**
 * World ceiling clearance (m above the feet) — **is** `world/obb.ts` `BOX_HEADROOM` (2.1), imported from `@/shared`
 * since 2026-09-11 so both read the one `data/constants.csv` row (nothing is copied here any more; the local name
 * only says what the value means on this side). It has to be that value: `WorldRef.resolveCollision` pushes a box
 * out sideways as soon as `feet + BOX_HEADROOM` passes its underside, so clamping only the 1.8 m head would still
 * let the push-out shove a jumping body out from under a slab.
 */
const WORLD_CEIL_HEADROOM = BOX_HEADROOM;

/* ── Ride coordinate transforms ───────────────────────────────────────────────────────────────
 * Born here on 2026-09-10 as three private functions; on 2026-09-11 (C-18), when enemies · corpses came to ride the
 * tram the same way, they moved to `ride.ts` in `@/shared` (`recordRideLocal` · `restoreRideLocal` · `rideContains`).
 * Not one line of the formulas changed, and `rideContains`'s default arguments are still the old constants
 * (`RIDE_HEADROOM` · `RIDE_FOOT_DROP` · `RIDE_EDGE_MARGIN`).
 */

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
   * The **vehicle** (moving platform) currently ridden. null = walking. Since 2026-09-10 riding is a state — the
   * full reason is in `updateRide`'s comment. The reference is a live `Obstacle` inside the `SpatialHash`, so its
   * **current transform is re-read every frame** (no snapshot is taken).
   */
  private carrier: Obstacle | null = null;
  /** Vehicle-local coordinates (x = along the car, z = across it, y = height above the deck's top face). */
  private readonly rideLocal = new THREE.Vector3();
  /** The **world** spot at the moment `rideLocal` was recorded. Held so that only the difference is added. */
  private readonly rideWorld = new THREE.Vector3();
  /** Exit inertia (m/s, world XZ). Damped by friction. */
  private readonly rideInertia = new THREE.Vector3();
  private rideInertiaT = 0;
  /**
   * The ladder being hung on (2026-09-11). null = not hanging on. While hanging on, `updateClimb` runs instead of
   * `update` — no gravity, no `world.resolveCollision`, no ground snap (the body passes through the hole in the
   * roof slab, so it must not be pushed out).
   */
  climbLadder: LadderDef | null = null;
  /** Progress 0..1 of the mount onto the roof. -1 = climbing up or down the ladder. */
  climbMount = -1;
  /** Whether this frame climbed fast (sprint) — the basis for the stamina drain. */
  climbFast = false;
  /** Absolute vertical speed this frame (m/s) — the basis for the stamina regen rate. */
  climbSpeed = 0;
  private readonly mountFrom = new THREE.Vector3();
  private lastStep = 0;
  private coyote = 0;
  private rollTimer = 0;
  /**
   * Global fall damage (2026-09-14): the height the current fall **started from**. While grounded it follows
   * the feet, and while airborne only the peak rises — so it is not 「the height jumped up to and then fallen
   * from」 but the **height actually fallen**.
   */
  private fallFromY = 0;
  /**
   * This fall computes no damage. Raised as soon as a 「not really a fall」 state — grapple · bag hover · a
   * vehicle deck · the ship interior — has held even once during the fall, and lowered the moment the body lands
   * (a fall that began by releasing a ladder belongs here too).
   */
  private fallExempt = false;
  /**
   * 2026-09-14: an `applyImpulse` was received in the air — until landing (or `reset` · grapple) air control does
   * not shave horizontal momentum above the target speed (`update`'s horizontal-velocity section). The bazooka
   * rocket jump's 「further」 rests on this.
   */
  private airCarry = false;
  /**
   * 2026-09-16 (the `운반` hauling skill bug — user's decision 「제 힘으로 움직인 거리만」): the horizontal distance (m)
   * the body moved **under its own power** in this `update`; reset to 0 on the first line of `update`/`updateClimb`.
   * Counted: walking · sprinting · crouched / prone movement · rolling · a jump taken on its own legs. Not counted —
   * the share a vehicle deck moved · exit inertia (`updateRide` adds it **before** the integration, so it is outside
   * the measured span), the grapple pull, an impulse given by someone else (jump pad · bazooka · knockback —
   * `airCarry`) and air a fall exemption stood through (after a grapple release · dash · ladder release —
   * `fallExempt`), the ship interior · the extraction ship's hold, and everything that writes the position outside
   * this function (teleport · dash · revive · ride attachment). The share above the speed the body can reach on its
   * own this frame (`targetSpeed`, the roll speed while rolling) is not counted either — slope sliding · knockback
   * on the ground must not make distance without input. A stride blocked by a wall counts only what really moved (0).
   * Other body states (drone control · pod · attached …) are filtered by `PlayerSystem.update` before it accumulates.
   */
  selfMoved = 0;

  get crouching(): boolean { return this.stance === 'crouch'; }
  get prone(): boolean { return this.stance === 'prone'; }
  /** Wire-compatible alias: the roll replaced the dive. */
  get diving(): boolean { return this.rolling; }

  reset(pos: THREE.Vector3): void {
    this.position.copy(pos);
    this.velocity.set(0, 0, 0);
    this.grounded = true;
    this.stance = 'stand'; this.sprinting = false;
    this.rolling = false; this.rollTimer = 0; this.rollProgress = 0;
    this.grappleTarget = null; this.hovering = false;
    this.speed = 0; this.stridePhase = 0; this.lastStep = 0;
    this.carrier = null; this.rideInertia.set(0, 0, 0); this.rideInertiaT = 0;
    this.climbLadder = null; this.climbMount = -1; this.climbFast = false; this.climbSpeed = 0;
    // 2026-09-14: spawn · revive · a teleport (dash · console) is not a fall — measured again from the new spot
    this.fallFromY = pos.y; this.fallExempt = false;
    this.airCarry = false;
  }

  /** Whether a vehicle (a tram deck …) is being ridden right now. For the HUD · debug. */
  get riding(): boolean { return this.carrier !== null; }

  /**
   * 2026-09-14: takes the fall in progress **out of fall damage** — called by movement that is not a walked fall
   * (a teleport such as a dash). It releases itself the moment the body lands, so it can be set and forgotten.
   */
  exemptFall(): void { this.fallExempt = true; this.fallFromY = this.position.y; }

  /* ── Ladder (2026-09-11) ───────────────────────────────────────────────────────────────────────────
   * The state is one field, `climbLadder`. Grabbing (`startClimb`) sticks the body to the ladder's XZ, and while
   * hanging on `updateClimb` stands in for `update`: W/S move vertically only, S at the foot = stepping off
   * (grounded), W at the top = mounting to `exit` over `LADDER_MOUNT_S` (up first, over afterwards), E = dropping
   * away toward `normal`, jump = releasing the ladder and leaping up + `-normal` (past the ladder). Once released,
   * `update`'s usual landing rules run as always.
   */
  get climbing(): boolean { return this.climbLadder !== null; }

  /** Hangs on the ladder. The rule checks (death · downed · shouldering …) were already done by PlayerSystem. */
  startClimb(ladder: LadderDef, from: 'bottom' | 'top'): void {
    this.releaseRide(false);
    this.cancelRoll();
    this.grappleTarget = null; this.hovering = false; this.sprinting = false;
    this.velocity.set(0, 0, 0);
    this.speed = 0;
    const b = ladder.base;
    const hangMax = Math.max(b.y, ladder.topY - LADDER_BOTTOM_GRAB_CLEAR);
    const y = from === 'top'
      ? Math.max(b.y, ladder.topY - LADDER_TOP_GRAB_DEPTH)
      : Math.min(hangMax, Math.max(b.y, this.position.y));
    this.position.set(b.x, y, b.z);
    this.climbLadder = ladder;
    this.climbMount = -1;
    this.climbFast = false; this.climbSpeed = 0;
    this.grounded = false; this.coyote = 0;
    this.lastStep = Math.floor(this.stridePhase / Math.PI);
  }

  /** Releases the ladder without touching the velocity (death · downed · reset paths). The body drops on the spot. */
  releaseClimb(): void {
    if (!this.climbLadder) return;
    this.climbLadder = null; this.climbMount = -1; this.climbFast = false; this.climbSpeed = 0;
    this.grounded = false; this.coyote = 0;
    // 2026-09-14: a body that dropped off a ladder takes no fall damage (hanging on there is no landing at all)
    this.fallFromY = this.position.y; this.fallExempt = true;
  }

  /** One frame while hanging on. Called instead of `update`. */
  updateClimb(dt: number, inp: ClimbInput, out: MoveResult): void {
    out.footstep = false; out.landed = 0; out.jumped = false; out.rollEnded = false;
    out.rung = false; out.climbEnded = null; out.fallHeight = 0;
    this.selfMoved = 0;   // 2026-09-16: a ladder moves vertically only — it does not count as hauling distance
    const l = this.climbLadder;
    if (!l || dt <= 0) return;
    const pos = this.position, vel = this.velocity;
    this.speed = 0;
    this.climbFast = false;

    // ── Mounting onto the roof: ease-out going up (first), ease-in going over (after) — no scraping the slab edge
    if (this.climbMount >= 0) {
      const prevY = pos.y;
      this.climbMount = Math.min(1, this.climbMount + dt / Math.max(0.05, LADDER_MOUNT_S));
      const t = this.climbMount;
      const up = 1 - (1 - t) * (1 - t), over = t * t;
      const f = this.mountFrom, e = l.exit;
      pos.set(f.x + (e.x - f.x) * over, f.y + (e.y - f.y) * up, f.z + (e.z - f.z) * over);
      vel.set(0, 0, 0);
      this.climbSpeed = Math.abs(pos.y - prevY) / dt;
      if (t >= 1) { pos.copy(e); this.endClimb(out, 'top', true); }
      return;
    }

    // ── Jump: releases the ladder and leaps up + past it (near the top this clears the roof edge)
    if (inp.jump) {
      vel.set(-l.normal.x * LADDER_JUMP_PUSH, LADDER_JUMP_SPEED * this.jumpSpeedMul, -l.normal.z * LADDER_JUMP_PUSH);
      out.jumped = true;
      this.endClimb(out, 'jump', false);
      return;
    }
    // ── E: releases on the spot — a nudge away from the ladder so the body does not drop hugging the wall
    if (inp.drop) {
      vel.set(l.normal.x * LADDER_DROP_PUSH, 0, l.normal.z * LADDER_DROP_PUSH);
      this.endClimb(out, 'drop', false);
      return;
    }

    // ── W/S: vertical movement only. XZ is pinned to the ladder
    const z = THREE.MathUtils.clamp(inp.z, -1, 1);
    const moving = Math.abs(z) > 0.01;
    this.climbFast = inp.fast && moving;
    const speed = (this.climbFast ? LADDER_SPRINT_SPEED : LADDER_CLIMB_SPEED) * Math.max(0, this.speedMultiplier);
    const prevY = pos.y;
    const hangTop = Math.max(l.base.y, l.topY - LADDER_MOUNT_MARGIN);
    let y = prevY + z * speed * dt;
    pos.x = l.base.x; pos.z = l.base.z;
    vel.set(0, 0, 0);
    if (z < 0 && y <= l.base.y) {
      pos.y = l.base.y;
      this.advanceRung(Math.abs(pos.y - prevY), out);
      this.endClimb(out, 'bottom', true);
      return;
    }
    if (y >= hangTop) {
      y = hangTop;
      if (z > 0) { this.climbMount = 0; this.mountFrom.set(pos.x, y, pos.z); }
    }
    if (y < l.base.y) y = l.base.y;
    pos.y = y;
    const moved = y - prevY;
    vel.y = moved / dt;                       // for snapshot interpolation (remotes extrapolate vertical movement)
    this.climbSpeed = Math.abs(vel.y);
    this.advanceRung(Math.abs(moved), out);
  }

  /** Turns the rung phase by the vertical distance moved, and sets `out.rung` every time a rung is passed. */
  private advanceRung(dist: number, out: MoveResult): void {
    if (dist <= 0) return;
    this.stridePhase += dist / LADDER_RUNG_M * Math.PI;
    const idx = Math.floor(this.stridePhase / Math.PI);
    if (idx !== this.lastStep) { this.lastStep = idx; out.rung = true; }
  }

  private endClimb(out: MoveResult, end: ClimbEnd, grounded: boolean): void {
    this.climbLadder = null; this.climbMount = -1; this.climbFast = false; this.climbSpeed = 0;
    this.grounded = grounded; this.coyote = grounded ? 0.1 : 0;
    if (grounded) this.velocity.set(0, 0, 0);
    // 2026-09-14: a fall from releasing the ladder (E · jump) is exempt — mounting · stepping off just set a base
    this.fallFromY = this.position.y; this.fallExempt = !grounded;
    out.climbEnded = end;
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
    // 2026-09-14: a body lifted into the air keeps its horizontal momentum until landing (`update`'s air section)
    if (impulse.y > 0.01 || !this.grounded) this.airCarry = true;
    if (impulse.y > 0.01) {
      this.grounded = false; this.coyote = 0; this.position.y += 0.02;
      /*
       * 2026-09-14 (global fall damage): **a body something else lifted does not die on landing.** Jump pads ·
       * bazooka super jumps · explosions · enemy knockback all pass through this one line (`applyKnockback` arrives
       * here too). Otherwise a bazooka super jump (+29.9 m/s → 45 m peak) becomes a **suicide button** that takes
       * capped damage on landing, and a person who steps onto their own jump pad dies — both were made as means of
       * travel. The exemption lives **only until the next landing** (`exemptFall` → the landing frame reverts it).
       * An ordinary jump made on its own legs writes the velocity directly instead of an impulse, so it still hurts
       * by its height.
       */
      this.exemptFall();
    }
  }

  /**
   * The height of the surface the feet stand on. Since 2026-09-09 it looks at **obstacle top faces** too, not only
   * the terrain (`getSurfaceY`) — that is why a low rock can be walked up onto. Always pass `feetY`: only then are
   * the top faces within `PROP_STEP_UP_MAX` of the current feet height taken. Omitting it returns the highest top
   * face at that spot, which is a query for bullets · falling things, not for walking.
   */
  groundHeight(x: number, z: number, world: WorldRef | null, feetY?: number): number {
    if (this.interior) return this.interior.getFloorAt(x, z);
    if (this.shipBounds) return this.shipBounds.center.y - this.shipBounds.halfExtents.y;
    if (world && world.ready) return world.getSurfaceY(x, z, feetY);
    return 0;
  }

  /**
   * **Riding a vehicle (a moving platform)** — entry · staying on · leaving are all here (2026-09-10).
   *
   * ## Why it is a state
   * The 2026-09-09 version looked up `getStandingObstacle(...)?.velocity` every frame and added that velocity to the
   * position. That way **a single frame missed by the platform query** lets the vehicle slip that far out from under
   * the feet — which happens constantly on jumps · slopes · the doorway · the deck edge, and a few frames put the
   * body off the car ("조금만 움직여도 내려진다"). So riding is held as an **explicit state** (`carrier`), and the
   * condition for staying on is not the platform query but the **vehicle OBB + headroom** (`RIDE_*`). Whether a
   * particular platform frame was stood on is used for entry only.
   *
   * ## Movement is solved in vehicle coordinates
   * The previous frame's spot is recorded in vehicle-local coordinates (`rideLocal`) and solved again this frame
   * with the **vehicle's current transform** — which follows not only the linear velocity but the **rotation** on a
   * curve exactly, and misses no frame. A snapshot is never taken (`CLAUDE.md`: the ship interior broke that way).
   *
   * ## `vel` is left alone
   * Only the **position** is moved; `vel` stays a **vehicle-local velocity** throughout. Movement speed · stamina
   * (`sprinting`) · the walk animation (`speed` · `stridePhase`) therefore do not swing with the tram's speed —
   * that is the **reason** behind the 2026-09-09 contract, and it is kept here too. A jump stays inside the
   * headroom, so the body flies along with the vehicle.
   *
   * ## Leaving
   * Leaving the OBB (+`RIDE_EDGE_MARGIN`) or the height range hands over the vehicle's velocity at that moment as
   * **inertia**, damped by `RIDE_INERTIA_DAMP` for `RIDE_INERTIA_S` — jumping sideways off a running tram throws
   * the body forward.
   */
  private updateRide(dt: number, world: WorldRef | null): void {
    const pos = this.position;
    if (this.interior || this.shipBounds || !world || !world.ready) {
      this.releaseRide(false);
      this.applyRideInertia(dt);
      return;
    }
    // ① Staying on — inside the vehicle OBB + headroom is still riding (the platform query is not consulted)
    if (this.carrier && !rideContains(this.carrier, pos)) this.releaseRide(true);
    // ② Entry — the platform query is used only to grab anew; the grab frame moves nothing (the vehicle is in place)
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
    // ③ Movement — the previous frame's local coordinates are solved again with the vehicle's **current**
    //    transform. The spot is not overwritten wholesale; only the **difference** is added — so that a move
    //    somebody else made in the meantime (teleport · impulse) is not erased.
    if (this.carrier) {
      restoreRideLocal(this.carrier, this.rideLocal, _ride);
      pos.x += _ride.x - this.rideWorld.x;
      pos.y += _ride.y - this.rideWorld.y;
      pos.z += _ride.z - this.rideWorld.z;
    } else {
      this.applyRideInertia(dt);
    }
  }

  /**
   * The **headroom** the current stance asks for (2026-09-14, crouching through a low passage).
   * Standing it is the same `WORLD_CEIL_HEADROOM` (= `BOX_HEADROOM` 2.1) as before, so the main game's routes do not
   * change. This value must be the height handed to `resolveCollision` — if the ceiling clamp and the push-out look
   * at different heights, a body under a slab is not stopped going up but is pushed out sideways (or the reverse).
   */
  private get bodyClearance(): number {
    if (this.stance === 'crouch') return PLAYER_CROUCH_CLEARANCE_M;
    if (this.stance === 'prone') return PLAYER_PRONE_CLEARANCE_M;
    return Math.max(PLAYER_HEIGHT, WORLD_CEIL_HEADROOM);
  }

  /**
   * The world ceiling (2026-09-11) — the same shape as the interior mode's ceiling probe. The ray is cast from the
   * hips at the **feet height before the integration**: cast from the post-integration spot, the hips are already
   * inside the slab and the ray does not see it. Called only on a rising frame.
   */
  private clampWorldCeiling(world: WorldRef, feetBefore: number): void {
    const pos = this.position;
    const clearance = this.bodyClearance;
    _rayO.set(pos.x, feetBefore + CEIL_PROBE_START, pos.z);
    const reach = pos.y + clearance - _rayO.y + 0.05;
    if (reach <= 0) return;
    const hit = world.raycast(_rayO, _up, reach);
    if (!hit) return;
    const maxFeet = _rayO.y + hit.distance - clearance;
    if (pos.y > maxFeet) { pos.y = Math.max(feetBefore, maxFeet); this.velocity.y = 0; }
  }

  /** Records the current spot in vehicle coordinates (solved next frame with the vehicle's new transform). */
  private recordRide(): void {
    const c = this.carrier;
    if (!c) return;
    recordRideLocal(c, this.position, this.rideLocal);
    this.rideWorld.copy(this.position);
  }

  /** Leaves the vehicle. With `keepInertia` the vehicle's velocity at that moment is handed over as inertia. */
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

  /** Exit inertia: added to the position, decayed exponentially (not into `vel` — that swings stamina · walking). */
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
    out.rung = false; out.climbEnded = null; out.fallHeight = 0;
    this.selfMoved = 0;
    if (dt <= 0) return;
    const pos = this.position, vel = this.velocity;
    this.stance = inp.stance;
    // 2026-09-16 (`selfMoved`): split on the state at the **start** of the frame — the landing frame's movement was
    //   made in the air too, and an impulse · dash (`exemptFall`) that arrived between frames is caught here. A roll
    //   can end inside this frame, so the start value is used.
    const selfTainted = this.airCarry || this.fallExempt || this.grappleTarget !== null;
    const rollingAtStart = this.rolling;

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
      /*
       * 2026-09-14 (the bazooka rocket jump): **horizontal momentum given by something else lives until landing**
       * (`airCarry` ← `applyImpulse`). It used to be pulled toward the target speed (sprint 7.2 m/s) by `AIR_ACCEL`
       * in the air as well, so a horizontal boost fell back to the sprint speed within a second — 「further」 did
       * not hold. While faster than the target speed, air control only turns the direction (the magnitude is kept)
       * and decelerates by that component with `AIR_ACCEL` **only when pushed the other way**. Letting go does not
       * shrink it. At or below the target speed, and a jump made on its own legs (no impulse), behave as before.
       */
      const carried = this.airCarry && !this.grounded ? Math.hypot(_hv.x, _hv.z) : 0;
      let brake = 0;
      if (carried > 1e-3 && moving) {
        const along = (_wish.x * _hv.x + _wish.z * _hv.z) / (wishLen * carried);
        if (along < 0) brake = -along * AIR_ACCEL * dt;
      }
      _wish.multiplyScalar(targetSpeed);
      const dx = _wish.x - _hv.x, dz = _wish.z - _hv.z;
      const dl = Math.hypot(dx, dz);
      if (dl > 1e-5) {
        const step = Math.min(dl, accel * dt);
        _hv.x += dx / dl * step; _hv.z += dz / dl * step;
      }
      if (carried > targetSpeed) {
        const nl = Math.hypot(_hv.x, _hv.z), floor = carried - brake;
        if (nl > 1e-5 && nl < floor) { const k = floor / nl; _hv.x *= k; _hv.z *= k; }
      }
    }

    // ── slope handling (heightfield only)
    // 2026-09-13: **only when the feet are on terrain**. Standing on an obstacle top face — a structure floor plate,
    // a tram deck — must not slide or block even when the terrain beneath is steep: on the ground floor above a
    // basement pit every direction toward the outer wall read as "uphill", the body stopped 1–2 m short of the wall,
    // and only coming in through the front door (downhill) worked, never going out. The test is the same
    // `surface > terrain + 0.02` shape throwables · items already use.
    let steep = false;
    if (!this.interior && !this.shipBounds && world && world.ready && this.grounded && !this.rolling
      && world.getHeightAt(pos.x, pos.z) >= pos.y - 0.02) {
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
      this.airCarry = false;   // 2026-09-14: the reel owns the velocity; its release keeps the old air decay
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

    // ── Ride (2026-09-10): the body is moved first by however far the vehicle moved this frame. `vel` is untouched.
    this.updateRide(dt, world);
    const feetBefore = pos.y;
    const selfX = pos.x, selfZ = pos.z;   // 2026-09-16: **after** the ride · exit inertia — the body's own share

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
      // Ceiling (2026-09-11): structures gained ceilings · floating slab boxes. Entering `resolveCollision` with the
      // head buried in a slab pushes the body out sideways, so measure upward once, **before the push-out**, and
      // only while rising.
      if (vel.y > 0) this.clampWorldCeiling(world, feetBefore);
      // Walking on terrain features (2026-09-09): **resolve the surface first**, then push out.
      // `getSurfaceY(x, z, feetY)` returns only top faces within `PROP_STEP_UP_MAX` of the current feet height, and
      // once the body has stepped up, `resolveCollision` does not push it off that obstacle by the same
      // `PROP_TOP_MARGIN` test. Reversed, the body is pushed out sideways first and can never get onto a low rock.
      if (this.grounded) {
        const step = world.getSurfaceY(pos.x, pos.z, pos.y);
        if (step > pos.y) pos.y = step;
      }
      // 2026-09-14: the stance height goes along — standing it is the same 2.1 as before, and only a crouched or
      //   prone body passes under a low slab. Whether it can stand up again is blocked separately by
      //   `parts/Locomotion.canStandHere`.
      world.resolveCollision(pos, PLAYER_RADIUS, this.bodyClearance);
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
    if (this.grounded) this.hovering = false;

    /*
     * Fall tracking (2026-09-14, global fall damage). While grounded the feet height is the base for the next fall,
     * and airborne only the peak rises — it is the 「height fallen」, not the 「speed」 (walking down a slope keeps
     * the body grounded, so 0, and jumping and landing on the spot is only the feet-height difference). An
     * exemption, raised **even once during the fall**, is held until landing: while reeled by the grapple · bag
     * hover (the automatic catch included) · on a vehicle deck · the ship interior · a body released from a ladder.
     */
    if (this.grappleTarget || this.hovering || this.carrier || this.interior || this.shipBounds) this.fallExempt = true;
    if (this.grounded) {
      if (!wasGrounded) out.fallHeight = this.fallExempt ? 0 : Math.max(0, this.fallFromY - pos.y);
      this.fallFromY = pos.y;
      this.fallExempt = false;
      this.airCarry = false;
    } else if (pos.y > this.fallFromY) {
      this.fallFromY = pos.y;
    }

    // The frame's final spot is **re-recorded in vehicle coordinates** — solved next frame with the new transform.
    this.recordRide();

    // ── Distance moved under its own power (2026-09-16, the `운반` hauling skill — see the `selfMoved` field)
    if (!selfTainted && !this.grappleTarget && !this.interior && !this.shipBounds) {
      const own = Math.hypot(pos.x - selfX, pos.z - selfZ);
      const cap = (rollingAtStart ? ROLL_SPEED : targetSpeed) * dt;
      this.selfMoved = Math.min(own, Math.max(0, cap));
    }

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
