import * as THREE from 'three';
import {
  RIDE_INERTIA_DAMP, RIDE_INERTIA_S, recordRideLocal, restoreRideLocal, rideContains, type Obstacle, type WorldRef,
} from '@/shared';
import type { Enemy } from '../Enemy';

/* ────────────────────────────────────────────────────────────────────────────
 * Vehicle riding for enemies and enemy corpses (2026-09-11, C-18).
 *
 * The **same contract** as the player (`player/PlayerController.updateRide`), on the same maths in `shared/ride.ts` — CLAUDE.md
 * "riding is judged by the vehicle volume, not by the platform frame":
 *   ① only entry is a platform query — the `getStandingObstacle` of the spot it stands on, when that platform carries `velocity` (the tram floor).
 *   ② staying is the vehicle OBB + headroom (`rideContains`) — a platform query that misses for one frame on a slope · doorway · edge does not dismount it.
 *   ③ movement writes last frame's spot in vehicle-local coordinates (`rideRecord`) and re-solves it this frame against the
 *      vehicle's **current** transform, adding **only the difference** (`rideCarry`). No snapshot is taken, and a body someone else moved meanwhile (knockback · separation) is not erased.
 *   ④ (2026-09-11 C-63) on dismount it inherits the vehicle's speed at that moment as **inertia** and damps it with `RIDE_INERTIA_DAMP`
 *      for `RIDE_INERTIA_S` — the same constants and the same formula as the player's `releaseRide(true)` · `applyRideInertia`. It is added
 *      to the position only, never to `velocity` (steering · gait · footsteps would shake). Only authority enemies simulate it; replicas follow the snapshots.
 * `Enemy.velocity` stays a **local velocity** all the way — steering, the walk animation and footsteps never shake at tram speed.
 *
 * Tram strikes (world/'s job, `rails/parts/Tram.updateTramHit`) do not ask this state: a body at deck height (above the floor −
 * `TRAM_HIT_FLOOR_CLEAR`) is not struck, and in the `RIDE_FOOT_DROP` band below it a body is exempt **only when the platform under
 * its feet is that tram** (C-63 — the gap where an enemy on a rail deck read as inside the riding window and was exempted). A body carried here is at deck height, so it drops out by itself.
 * ──────────────────────────────────────────────────────────────────────────── */

const _ride = new THREE.Vector3();
const _move = new THREE.Vector3();

/**
 * **Before** the authority's `integrate` step: the stay check → (with none) entry → move the body as far as the vehicle moved this frame.
 * Nothing is moved on the entry frame (the vehicle is already in place). Not riding → the dismount inertia bleeds off. True while riding.
 */
export function rideCarry(e: Enemy, world: WorldRef, dt: number): boolean {
  const pos = e.position;
  if (e.carrier && !rideContains(e.carrier, pos)) rideRelease(e, true);
  if (!e.carrier) {
    const o = world.getStandingObstacle(pos.x, pos.z, pos.y);
    if (o && o.velocity) {
      e.carrier = o;
      e.rideInertia.set(0, 0, 0);
      e.rideInertiaT = 0;
      rideRecord(e);
      return true;
    }
    applyRideInertia(e, dt);
    return false;
  }
  restoreRideLocal(e.carrier, e.rideLocal, _ride);
  pos.x += _ride.x - e.rideWorld.x;
  pos.y += _ride.y - e.rideWorld.y;
  pos.z += _ride.z - e.rideWorld.z;
  return true;
}

/** Writes this frame's final spot back in vehicle coordinates (after integration · collision · the surface snap). */
export function rideRecord(e: Enemy): void {
  const c = e.carrier;
  if (!c) return;
  recordRideLocal(c, e.position, e.rideLocal);
  e.rideWorld.copy(e.position);
}

/**
 * Dismount. With `keepInertia` the body inherits the vehicle's speed (XZ) at that moment as inertia — only a body that
 * walked out of the vehicle volume (`rideCarry`). Paths with a trajectory of their own (leap · death · reset) dismount without it.
 */
export function rideRelease(e: Enemy, keepInertia = false): void {
  const c = e.carrier;
  e.carrier = null;
  if (keepInertia && c && c.velocity) {
    e.rideInertia.set(c.velocity.x, 0, c.velocity.z);
    e.rideInertiaT = RIDE_INERTIA_S;
  } else {
    e.rideInertia.set(0, 0, 0);
    e.rideInertiaT = 0;
  }
}

/** Dismount inertia: added to the position and damped exponentially (the same formula as `PlayerController.applyRideInertia`). */
function applyRideInertia(e: Enemy, dt: number): void {
  if (e.rideInertiaT <= 0) return;
  e.rideInertiaT -= dt;
  const pos = e.position;
  pos.x += e.rideInertia.x * dt;
  pos.z += e.rideInertia.z * dt;
  const k = Math.exp(-RIDE_INERTIA_DAMP * dt);
  e.rideInertia.x *= k;
  e.rideInertia.z *= k;
  if (e.rideInertiaT <= 0) { e.rideInertia.set(0, 0, 0); e.rideInertiaT = 0; }
}

/**
 * Carrying corpses (authority and replica alike, `EnemySystem.update` runs it per dead body every frame). Only a body that reached
 * the ground (`deathLanded`) rides. Leaving the vehicle volume dismounts it and clears `deathLanded` so `integrateDeathFall` drops it
 * to the ground (a running tram turning at the end spills a corpse off its edge — it must not hang in the air). True when the body moved.
 */
export function carryCorpse(e: Enemy, world: WorldRef): boolean {
  if (!e.deathLanded) { if (e.carrier) rideRelease(e); return false; }
  const pos = e.position;
  if (e.carrier && !rideContains(e.carrier, pos)) {
    rideRelease(e);
    e.deathLanded = false; e.deathVy = 0;
    e.corpseDropped = true;   // the caller keeps the searchable spot on the body until it lands
    return false;
  }
  if (!e.carrier) {
    const o = world.getStandingObstacle(pos.x, pos.z, pos.y);
    if (!o || !o.velocity) return false;
    e.carrier = o;
    rideRecord(e);
    return false;
  }
  restoreRideLocal(e.carrier, e.rideLocal, _ride);
  const moved = Math.abs(_ride.x - e.rideWorld.x) + Math.abs(_ride.y - e.rideWorld.y) + Math.abs(_ride.z - e.rideWorld.z) > 1e-5;
  pos.x += _ride.x - e.rideWorld.x;
  pos.y += _ride.y - e.rideWorld.y;
  pos.z += _ride.z - e.rideWorld.z;
  rideRecord(e);
  return moved;
}

/* ── Carrier movement history for replica prediction (2026-09-11, C-63) ────────────────────────────────────
 * C-18's prediction was `vehicle speed × lag` — a linear formula retracing the last lag seconds at the **current** speed, so it went
 * out of step the moment the tram accelerated or braked. The real movement over the last lag seconds is `v·lag − ½·ā·lag²` (ā = the
 * mean acceleration of that stretch), and a tram stops **instantly** in the docking window after a cubic acceleration
 * (`Rails.checkDock`), so one constant acceleration cannot hit the stop. So the acceleration is not estimated: the whole term is read
 * from a history — per vehicle (a platform `Obstacle`) the **current spot** goes into a ring buffer every frame and `P(now) − P(now − lag)` is interpolated out of it. Acceleration, the instant stop, curves and the client's `s` pull are all in it.
 *
 * - The history is a cache inside this module (`Replica.ts` is untouched — `replicaRidePredict` keeps its signature).
 *   The key is the live hash entry (a platform `Obstacle`) and it is a `WeakMap`, so it goes with the entry when a mission change drops it.
 * - Several enemies calling in one frame write once for the same `now`. A gap longer than `TRACK_GAP_S` empties it and starts over.
 * - The front part the history does not cover (just after boarding · after a gap) is filled at the **current speed** — i.e. it falls back to the old linear prediction.
 * - The buffer is created once per vehicle (no hot-path allocation).
 */
const TRACK_N = 96;
/** A history gap of this many seconds is thrown away and rebuilt (no replica was near the vehicle for a while). */
const TRACK_GAP_S = 0.5;

interface CarrierTrack {
  /** [t, x, z] × TRACK_N, a ring buffer. `head` = the newest sample. */
  readonly buf: Float64Array;
  head: number;
  count: number;
}
const _tracks = new WeakMap<Obstacle, CarrierTrack>();

function trackOf(c: Obstacle, now: number): CarrierTrack {
  let tr = _tracks.get(c);
  if (!tr) { tr = { buf: new Float64Array(TRACK_N * 3), head: -1, count: 0 }; _tracks.set(c, tr); }
  const b = tr.buf;
  if (tr.count > 0) {
    const lastT = b[tr.head * 3];
    if (now <= lastT + 1e-6) {
      // second call in the same frame — only the spot is refreshed (the tram is already at this frame's spot)
      b[tr.head * 3 + 1] = c.position.x; b[tr.head * 3 + 2] = c.position.z;
      return tr;
    }
    if (now - lastT > TRACK_GAP_S) tr.count = 0;
  }
  tr.head = (tr.head + 1) % TRACK_N;
  b[tr.head * 3] = now; b[tr.head * 3 + 1] = c.position.x; b[tr.head * 3 + 2] = c.position.z;
  tr.count = Math.min(TRACK_N, tr.count + 1);
  return tr;
}

/** The vehicle's horizontal displacement over `[now − span, now]` into `out` (y = 0). The front part the history lacks is filled at the current speed. */
function carrierDisplacement(c: Obstacle, tr: CarrierTrack, now: number, span: number, out: THREE.Vector3): THREE.Vector3 {
  const b = tr.buf;
  const x0 = c.position.x, z0 = c.position.z;
  const target = now - Math.max(0, span);
  let i = tr.head, n = tr.count;
  let tA = b[i * 3], xA = b[i * 3 + 1], zA = b[i * 3 + 2];
  if (n <= 0 || target >= tA) {
    // no history, or the window starts past the newest sample — use the current speed
    const v = c.velocity;
    return out.set(v ? v.x * span : 0, 0, v ? v.z * span : 0);
  }
  while (--n > 0) {
    const j = (i - 1 + TRACK_N) % TRACK_N;
    const tB = b[j * 3], xB = b[j * 3 + 1], zB = b[j * 3 + 2];
    if (tB <= target) {
      const f = tA - tB > 1e-9 ? (target - tB) / (tA - tB) : 0;
      return out.set(x0 - (xB + (xA - xB) * f), 0, z0 - (zB + (zA - zB) * f));
    }
    i = j; tA = tB; xA = xB; zA = zB;
  }
  // before the oldest sample (tA) — that part uses the current speed (the same assumption as the linear prediction)
  const v = c.velocity;
  const rest = tA - target;
  return out.set(x0 - xA + (v ? v.x * rest : 0), 0, z0 - zA + (v ? v.z * rest : 0));
}

/**
 * The replica's riding **prediction** (C-18 · C-63). A replica draws the host's snapshots interpolated `NET_INTERP_DELAY` behind,
 * while every client rolls the tram to its **current** spot from the synchronised `s` — so an enemy on the tram lagged by delay ×
 * tram speed (up to 11.2 m/s) and appeared to slide off the back of the deck. `latest` (the newest sample) advanced by however far
 * the vehicle moved since counts as riding when it falls inside the vehicle volume, and **the displacement the vehicle really
 * covered over the last `lag` seconds** (`v·lag − ½·ā·lag²`, read from the history — the section above) is added to the interpolated
 * spot `out`. `rideBlend` mixes it in over about 0.15 s so it does not pop on and off. Returns the vehicle speed to subtract this frame's carried horizontal component (null with none).
 */
export function replicaRidePredict(
  e: Enemy, world: WorldRef, latest: { t: number; x: number; y: number; z: number },
  now: number, lag: number, dt: number, out: THREE.Vector3,
): THREE.Vector3 | null {
  let c = e.carrier;
  const since = Math.max(0, now - latest.t);
  if (c && c.velocity) {
    carrierDisplacement(c, trackOf(c, now), now, since, _move);
    _ride.set(latest.x + _move.x, latest.y, latest.z + _move.z);
    if (!rideContains(c, _ride)) c = null;
  }
  if (!c) {
    const o = world.getStandingObstacle(latest.x, latest.z, latest.y);
    c = o && o.velocity ? o : null;
  }
  e.carrier = c;
  const target = c ? 1 : 0;
  e.rideBlend += (target - e.rideBlend) * Math.min(1, dt * 8);
  if (e.rideBlend < 1e-3 && !c) { e.rideBlend = 0; return null; }
  const carrier = c ?? e.lastCarrier;
  if (c) e.lastCarrier = c;
  if (!carrier || !carrier.velocity) return null;
  carrierDisplacement(carrier, trackOf(carrier, now), now, lag, _move);
  out.x += _move.x * e.rideBlend;
  out.z += _move.z * e.rideBlend;
  return c ? carrier.velocity : null;
}
