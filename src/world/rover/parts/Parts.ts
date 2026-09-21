/**
 * src/world/rover/parts/Parts.ts — the rover's **hit zones · hostility** (2026-09-21, user's decision).
 *
 * The vehicle used to be one hp pool behind one box collider. It still is one collider — **the hit zones are a
 * damage-resolution layer, not new colliders** — because the box is what walking, riding (`shared/ride.ts`) and the
 * enemy hit test all stand on, and splitting it would mean splitting all three. What changed is that a landed shot
 * now asks *where* on the body it landed: 4 wheel zones · the front turret · the rear turret · everything else (the
 * hull).
 *
 * ## The rules (all from `data/constants.csv`)
 * - A part has its own hp (`ROVER_WHEEL_HP` · `ROVER_TURRET_HP`) **and the same damage comes off the hull** at
 *   `ROVER_PART_HULL_MUL` (1 = in full), so shooting only the wheels still kills the car — that is the user's
 *   decision, and it is why no part can ever be a safe place to dump damage.
 * - One wheel zone dead → `ROVER_WHEEL_SPEED_MUL_1`; two or more → it cannot move at all. It stays a **rideable
 *   platform** at 0 m/s: riders are unharmed, the seat still tracks the body and `shared/ride.ts` is untouched.
 * - A dead turret stops firing; the other one carries on.
 * - Player-side damage sums into `aggro`, and past `ROVER_AGGRO_DAMAGE` the vehicle is **hostile for the rest of the
 *   raid** — no timeout. Enemy (`RoverRef.damage`) and hazard damage never touch `aggro`.
 *
 * Only the **authority** changes any of this; a client is told through `RoverWire.pt` / `.ho` and only re-plays the
 * look (`applyRoverPartLooks`).
 */
import * as THREE from 'three';
import {
  ROVER_AGGRO_DAMAGE, ROVER_HALF_LENGTH, ROVER_HALF_WIDTH, ROVER_HULL_H, ROVER_PART_HULL_MUL, ROVER_TURRET_HP, ROVER_WHEEL_HP,
} from '@/shared';
import {
  ROVER_PART_ORDER, ROVER_TURRET_FRONT_PART, ROVER_TURRET_REAR_PART, ROVER_WHEEL_ZONES, roverSpeedMulFor, roverWheelZoneOf,
} from '../model';
import { ROVER_WHEEL_R, applyRoverTurretWreck, applyRoverWheelWreck, type RoverBody } from './Body';

/** Answer of `resolveRoverPart` for "the shot landed on plain hull". */
export const ROVER_PART_HULL = -1;

/** The turret model's own bounding box, in a mount's `inner` space — the ring, the box and the barrel out front. */
const TURRET_BOX = { x0: -0.95, x1: 2.45, y0: -0.05, y1: 1.0, z: 0.6 };
/** A wheel zone's window in body-local space: the wheels sit at `y = ROVER_WHEEL_R` on both flanks. */
const WHEEL_Y_SLACK = 0.3;
const WHEEL_X_SLACK = 0.75;
const WHEEL_Z_IN = ROVER_HALF_WIDTH - 0.55;
const WHEEL_Z_OUT = ROVER_HALF_WIDTH + 0.5;
/** Where the wheels stand along the body's local +X — mirrors `Body.WHEEL_X`. */
const WHEEL_AXLES = [-2.55, -0.85, 0.85, 2.55];

/** The live part state. The host owns it; a client mirrors it off the wire. */
export interface RoverParts {
  /** Hp per `ROVER_PART_ORDER` entry. */
  hp: number[];
  /** Cumulative **player-side** damage (host only — a client never sums it). */
  aggro: number;
  /** Hostile for the rest of the raid. */
  hostile: boolean;
}

export function makeRoverParts(): RoverParts {
  return { hp: ROVER_PART_ORDER.map(maxHpOf), aggro: 0, hostile: false };
}

/** Back to a whole, calm vehicle (a new raid). */
export function resetRoverParts(p: RoverParts): void {
  for (let i = 0; i < p.hp.length; i++) p.hp[i] = maxHpOf(ROVER_PART_ORDER[i]);
  p.aggro = 0;
  p.hostile = false;
}

function maxHpOf(id: (typeof ROVER_PART_ORDER)[number]): number {
  return id === 'turretFront' || id === 'turretRear' ? ROVER_TURRET_HP : ROVER_WHEEL_HP;
}

/** How many wheel zones are gone. */
export function deadWheelCount(p: RoverParts): number {
  let n = 0;
  for (let i = 0; i < ROVER_WHEEL_ZONES; i++) if (p.hp[i] <= 0) n++;
  return n;
}

/** The drive speed multiplier the wheels allow right now (0 = it cannot move). */
export function roverPartSpeedMul(p: RoverParts): number {
  return roverSpeedMulFor(deadWheelCount(p));
}

/** Can turret `which` (0 front · 1 rear) still fire? */
export function roverTurretAlive(p: RoverParts, which: number): boolean {
  return p.hp[which === 0 ? ROVER_TURRET_FRONT_PART : ROVER_TURRET_REAR_PART] > 0;
}

const _local = new THREE.Vector3();

/**
 * Which hit zone a **world-space** impact point falls in (`ROVER_PART_ORDER` index, or `ROVER_PART_HULL`).
 * The turrets are tested first because they sit above everything and they turn — each is tested in its own `inner`
 * space, so a hit on the swung-out barrel still counts as that gun. The body must have had `updateMatrixWorld` run
 * this frame (`Rover.place` does).
 */
export function resolveRoverPart(body: RoverBody, point: THREE.Vector3): number {
  for (let i = 0; i < body.turrets.length; i++) {
    const p = body.turrets[i].inner.worldToLocal(_local.copy(point));
    if (p.x >= TURRET_BOX.x0 && p.x <= TURRET_BOX.x1 && p.y >= TURRET_BOX.y0 && p.y <= TURRET_BOX.y1 && Math.abs(p.z) <= TURRET_BOX.z) {
      return i === 0 ? ROVER_TURRET_FRONT_PART : ROVER_TURRET_REAR_PART;
    }
  }
  const b = body.tilt.worldToLocal(_local.copy(point));
  const az = Math.abs(b.z);
  if (b.y <= ROVER_WHEEL_R * 2 + WHEEL_Y_SLACK && az >= WHEEL_Z_IN && az <= WHEEL_Z_OUT) {
    for (const ax of WHEEL_AXLES) {
      if (Math.abs(b.x - ax) <= WHEEL_X_SLACK) return roverWheelZoneOf(b.x, b.z);
    }
  }
  return ROVER_PART_HULL;
}

/**
 * The world point a player-side hit at `center` should be **resolved and reported** from (2026-09-21, B-98,
 * user's decision 「부위 판정 + 적대 누적」): the point itself when it already falls in a zone, else the nearest
 * point on the hull box.
 *
 * A bullet stops *on* the body, so it comes back untouched — including a hit on a swung-out turret barrel, which
 * `resolveRoverPart` claims before any clamping could push it down onto the hull. A **blast centre** almost never
 * is: a grenade that rolled under the front-left wheel sits in the dirt beside it, and the raw point would read as
 * plain hull every time — 「수류탄으로 바퀴를 날린다」 would be impossible. Clamped, it is the spot the blast
 * actually washed over, and a non-host client that sends this point has the host read the same zone and
 * `pointOnHull` accept it (`Rover.hitAllowed`).
 */
export function roverBlastPoint(body: RoverBody, center: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  if (resolveRoverPart(body, center) !== ROVER_PART_HULL) return out.copy(center);
  const p = body.tilt.worldToLocal(out.copy(center));
  p.x = clamp(p.x, -ROVER_HALF_LENGTH, ROVER_HALF_LENGTH);
  p.y = clamp(p.y, 0, ROVER_HULL_H);
  p.z = clamp(p.z, -ROVER_HALF_WIDTH, ROVER_HALF_WIDTH);
  return body.tilt.localToWorld(p);
}

function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }

/**
 * Authority: puts `amount` into hit zone `part` (`ROVER_PART_HULL` = plain hull) and answers **what the hull loses**.
 * A part that is already gone passes the whole shot through to the hull — there is a hole there now.
 */
export function damageRoverPart(p: RoverParts, part: number, amount: number): number {
  if (part < 0 || part >= p.hp.length || p.hp[part] <= 0) return amount;
  p.hp[part] = Math.max(0, p.hp[part] - amount);
  return amount * ROVER_PART_HULL_MUL;
}

/**
 * Authority: counts `amount` of **player-side** damage toward hostility. True the moment it tips over
 * `ROVER_AGGRO_DAMAGE` (the caller announces it once); already hostile it stays quiet.
 */
export function addRoverAggro(p: RoverParts, amount: number): boolean {
  if (p.hostile || !(amount > 0)) return false;
  p.aggro += amount;
  if (p.aggro < ROVER_AGGRO_DAMAGE) return false;
  p.hostile = true;
  return true;
}

/** Every client: re-plays the look of every dead part. Idempotent — the poses are absolute, so it may run any time. */
export function applyRoverPartLooks(body: RoverBody, p: RoverParts): void {
  for (let i = 0; i < ROVER_WHEEL_ZONES; i++) if (p.hp[i] <= 0) applyRoverWheelWreck(body, i);
  if (p.hp[ROVER_TURRET_FRONT_PART] <= 0) applyRoverTurretWreck(body, 0);
  if (p.hp[ROVER_TURRET_REAR_PART] <= 0) applyRoverTurretWreck(body, 1);
}

/** The wire form of the part hp (`RoverWire.pt`) — whole hp, in `ROVER_PART_ORDER`. */
export function packRoverParts(p: RoverParts): number[] {
  return p.hp.map((v) => Math.round(v));
}

/**
 * A client applies the host's `pt` / `ho`. `looks` is true when something newly died (the caller re-plays the look)
 * and `turnedHostile` when this very message is the one that flipped it — the caller announces that once, so a
 * replica tells its player why the turrets swung around even though they were not the one shooting.
 */
export function applyRoverPartsWire(p: RoverParts, pt: number[] | undefined, ho: 0 | 1 | undefined): { looks: boolean; turnedHostile: boolean } {
  let changed = false;
  const wasHostile = p.hostile;
  for (let i = 0; i < p.hp.length; i++) {
    const max = maxHpOf(ROVER_PART_ORDER[i]);
    const next = Array.isArray(pt) && Number.isFinite(pt[i]) ? Math.max(0, Math.min(max, pt[i])) : max;
    if (next <= 0 && p.hp[i] > 0) changed = true;
    p.hp[i] = next;
  }
  p.hostile = ho === 1;
  return { looks: changed, turnedHostile: p.hostile && !wasHostile };
}
