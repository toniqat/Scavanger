/**
 * src/enemies/ai/Traverse.ts — **performing a special link** (TODO A-18 phase 2, 2026-09-21).
 *
 * A ladder, a wall climb and a window crawl are not walked, they are *performed*: the body leaves the colliders and the state
 * machine for the length of the link, like a person on a ladder (`shared/nav.ts` — `NavFlowStep.from → via → to`). It is an
 * atomic gate in `updateEnemyAI` right after the hunter flip (`ai/HunterFlip` is the model): while `Enemy.navTrav !== 0` this
 * file owns the tick. Who may take what is the csv `nav` column (`EnemyStats.navCan`): every humanoid takes ladders, **only
 * scavengers** climb walls and crawl through windows (user's decision).
 *
 * All three kinds are one machine — `beginTraverse` normalises them to `from → via → to` and the legs are
 *   0  across the floor to `from`                     (still grounded)
 *   1  window only: the pane is whole → face it, one melee wind-up (`stats.attackWindup`), `NavRef.breakWindow`
 *   2  straight up to `via.y`                          (skipped when `via` is not above the body)
 *   3  across to `via`
 *   4  across to `to`
 *   5  down onto the floor at `to`, seated with `getSurfaceY`
 * - **ladder**: `from` = over the foot, `via` = the top of the rungs (up) / where it stands (down), `to` = `LadderDef.exit` (up)
 *   / the foot (down) — the same geometry as `allies/parts/Nav.tickClimb`.
 * - **climb**: both directions use the graph's `via` — 0.3 m off the outer face, just over the parapet top. Up: the face, then
 *   onto the roof. Down (from the roof): up over the parapet, out to `via`, then down the face head first.
 * - **window**: `via` is the middle of the opening at sill height.
 *
 * The body stays **damageable and killable** throughout: `Enemy.kill` clears the link (`clearNav`) and decides `deathLanded` from
 * the height, so a bug shot on a wall falls (`integrateDeathFall`). A stagger holds it where it hangs until it wears off. The ride
 * is dropped at the start. A link that loses its data (the ladder is gone) or overruns `TRAVERSE_MAX_S` ends where it is, seated
 * on whatever is below.
 *
 * Wire: nothing but the pose hints 26 (on a wall, nose up) · 27 (nose down) · 28 (off the floor, level) — `net/HostSync.animHint`
 * reads `navAloft` / `navClimbDir`, a replica writes the same two fields back from the hint (`net/Replica.drive`) and
 * `Enemy.animate` blends `anim.climb` from them on both sides. Authority only otherwise.
 */
import * as THREE from 'three';
import {
  ENEMY_CLIMB_SPEED, ENEMY_WINDOW_CRAWL_SPEED, LADDER_CLIMB_SPEED, NAV_CAN,
  type LadderDef, type NavLinkKind, type WorldRef,
} from '@/shared';
import type { Enemy, EnemyHost } from '../Enemy';
import { rideRelease } from './Ride';
import { turnToward } from './Steering';

const TWO_PI = Math.PI * 2;
/** A link that takes longer than this is aborted (s) — a wall is ~10 m at 2.6 m/s. Algorithm constant. */
const TRAVERSE_MAX_S = 14;
/** `via` / `to` this far above · below the body count as a vertical leg (m); under it the leg is skipped. Algorithm constant. */
const LEVEL_EPS_M = 0.05;
/** A final drop shorter than this is not drawn nose-down (m) — stepping off a sill is not a wall descent. Algorithm constant. */
const DROP_POSE_M = 0.6;
/** `climb`: `to` lower than `from` by more than this = the link goes **down** the wall. Algorithm constant. */
const DESCEND_M = 0.5;
/** The floor query when seating: this far above the link's end height, so the floor *at* that height is the one found. Algorithm constant. */
const SEAT_UP_M = 0.3;
/** A link whose start is this far above · below the body's feet is not performed (m) — under a storey, over a stair step. Algorithm constant. */
const LINK_START_DY_M = 1;
/** The next body may start a link once the one ahead is two radii plus this from its start (m). Algorithm constant. */
const LINK_SPACING_PAD_M = 0.3;
/** What a leg returns when it is over without having moved (`moveXZ` / `moveY` return minus the distance when they arrive). */
const DONE = -1e-9;

const KIND_CODE: Readonly<Record<NavLinkKind, 0 | 1 | 2 | 3>> = { walk: 0, ladder: 1, climb: 2, window: 3 };
const KIND_BIT: Readonly<Record<NavLinkKind, number>> = { walk: 0, ladder: NAV_CAN.LADDER, climb: NAV_CAN.CLIMB, window: NAV_CAN.WINDOW };

/** Does this body's mask (`enemies.csv` `nav`) allow it to perform `kind`? */
export function canTraverse(e: Enemy, kind: NavLinkKind): boolean {
  const bit = KIND_BIT[kind];
  return bit !== 0 && (e.stats.navCan & bit) !== 0;
}

/**
 * Does the body really stand at the link's start? The flow field answers for the node nearest the body, and over a roof hatch
 * that node can be the ladder's **foot** one floor down (the hatch is a hole — the roof has no node there): a bug already on
 * the roof was told 「climb the ladder」, and performing it from up there took it down the rungs and up again, for ever. A
 * start more than `LINK_START_DY_M` above · below the feet is not this body's link — the caller steers as before.
 */
export function atLinkStart(e: Enemy, from: THREE.Vector3): boolean {
  return Math.abs(e.position.y - from.y) <= LINK_START_DY_M;
}

/**
 * Is somebody still in the mouth of this link? A special link is not a gate (the graph has no queue for it), and a body on one
 * is off the separation — so without this ten scavengers go through one window as one overlapping lump. The next body starts
 * once the one ahead has moved `LINK_SPACING_PAD_M` past two radii away from the link's start (3D — up a wall counts), which
 * makes a column up the wall and a stream through the sill. Scans the pool, but only for a body standing at a link start.
 */
export function linkBusy(e: Enemy, active: readonly Enemy[], from: THREE.Vector3): boolean {
  for (let i = 0; i < active.length; i++) {
    const o = active[i];
    if (o === e || o.navTrav === 0 || o.state === 'dead') continue;
    const gap = e.stats.radius + o.stats.radius + LINK_SPACING_PAD_M;
    const dx = o.position.x - from.x, dy = o.position.y - from.y, dz = o.position.z - from.z;
    if (dx * dx + dy * dy + dz * dz < gap * gap) return true;
  }
  return false;
}

function ladderById(world: WorldRef, id: string | null): LadderDef | null {
  if (!id) return null;
  const list = world.getLadders();
  for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}

/**
 * Starts the link. False = it cannot be performed (the ladder is unknown) — the caller falls back to the old steering.
 * `from` / `via` / `to` are copied, so the caller may pass the graph's own scratch.
 */
export function beginTraverse(
  e: Enemy, world: WorldRef, kind: NavLinkKind,
  from: THREE.Vector3, via: THREE.Vector3, to: THREE.Vector3, ladderId: string | null, windowId: string | null,
): boolean {
  const code = KIND_CODE[kind];
  if (code === 0) return false;
  const p = e.position;
  let yaw = e.yaw;
  if (code === 1) {
    const L = ladderById(world, ladderId);
    if (!L) return false;
    const up = to.y > from.y + DESCEND_M;   // the link's own direction — never the body's height against `to` (see `atLinkStart`)
    e.navTravFrom.set(L.base.x, p.y, L.base.z);
    e.navTravVia.set(L.base.x, up ? L.topY : p.y, L.base.z);
    if (up) e.navTravTo.set(L.exit.x, L.topY, L.exit.z); else e.navTravTo.copy(L.base);
    yaw = Math.atan2(-L.normal.x, -L.normal.z);   // hanging, the body faces the rungs (`-normal`)
  } else {
    e.navTravFrom.copy(from);
    e.navTravTo.copy(to);
    // Both climb directions share the graph's `via` (0.3 m off the outer face, over the parapet top), so a body going down
    // steps up over the parapet first — crossing at roof-floor height would pass through it (`world/nav/README.md` Climb).
    e.navTravVia.copy(via);
    const dx = to.x - from.x, dz = to.z - from.z;
    if (dx * dx + dz * dz > 1e-4) yaw = Math.atan2(dx, dz);
  }
  e.navTrav = code;
  e.navTravPhase = 0;
  e.navTravT = 0;
  e.navTravAge = 0;
  e.navTravYaw = yaw;
  e.navTravWindow = code === 3 ? windowId : null;
  e.navClimbDir = 0;
  e.navAloft = false;
  e.navWaitGate = -1;
  rideRelease(e);
  e.velocity.set(0, 0, 0);
  e.hasMoveTarget = false; e.hasFacePoint = false;
  return true;
}

/** Ends the link where the body is: seated on the floor under it, the stuck window restarted, the next walkable check due at once. */
export function endTraverse(e: Enemy, world: WorldRef): void {
  const p = e.position;
  p.y = world.getSurfaceY(p.x, p.z, p.y + SEAT_UP_M);
  e.navTrav = 0; e.navTravPhase = 0; e.navTravT = 0; e.navTravAge = 0; e.navTravWindow = null;
  e.navClimbDir = 0; e.navAloft = false;
  e.velocity.set(0, 0, 0);
  e.navStuckFrom.copy(p); e.navStuckT = 0; e.navStuckWant = 0;
  e.navCheckT = 0;
}

/** Moves `p` toward `(x, z)` by at most `step`; returns the distance covered, negative once it is there. */
function moveXZ(p: THREE.Vector3, x: number, z: number, step: number): number {
  const dx = x - p.x, dz = z - p.z;
  const d = Math.hypot(dx, dz);
  if (d <= step) { p.x = x; p.z = z; return -d - 1e-9; }
  p.x += (dx / d) * step; p.z += (dz / d) * step;
  return step;
}

/** `endTraverse` clears `navTrav` inside the leg loop — read through a call so the narrowing of the early return does not hide that. */
function linkOf(e: Enemy): number { return e.navTrav; }

/** The same as `moveXZ` for the height. */
function moveY(p: THREE.Vector3, y: number, step: number): number {
  const dy = y - p.y;
  if (Math.abs(dy) <= step) { p.y = y; return -Math.abs(dy) - 1e-9; }
  p.y += Math.sign(dy) * step;
  return step;
}

/**
 * One tick of a body on a special link. @returns true = this tick ends here (the AI and `integrate` are skipped).
 * Dead bodies never reach it (`updateEnemyAI` returns for `dead` first).
 */
export function updateTraverse(e: Enemy, dt: number, host: EnemyHost): boolean {
  if (e.navTrav === 0) {
    // a body promoted from a replica still carries the hint's flags — it is on the floor as far as the authority knows
    if (e.navAloft || e.navClimbDir !== 0) { e.navAloft = false; e.navClimbDir = 0; }
    return false;
  }
  const world = host.ctx.world;
  if (!world) return true;
  const a = e.anim;
  const p = e.position;
  e.velocity.set(0, 0, 0);
  e.hasMoveTarget = false; e.hasFacePoint = false;
  a.slopePitch += (0 - a.slopePitch) * Math.min(1, dt * 6);
  a.slopeRoll += (0 - a.slopeRoll) * Math.min(1, dt * 6);

  // A stagger (a heavy hit · incinerated) holds it where it hangs; the timers run here because the state machine does not.
  if (e.state === 'stagger') {
    e.staggerTimer -= dt;
    if (e.incapTimer > 0) e.incapTimer = Math.max(0, e.incapTimer - dt);
    a.speed = Math.max(0, a.speed - dt * 6);
    if (e.staggerTimer <= 0 && e.incapTimer <= 0) {
      e.incapTimer = 0;
      e.state = e.aware && e.target && !e.target.isDeadOrDowned ? 'chase' : 'idle';
      e.stateTime = 0; e.wanderTimer = 1; e.roguePhase = 0;
    }
    return true;
  }

  e.navTravAge += dt;
  if (e.navTravAge > TRAVERSE_MAX_S) { endTraverse(e, world); return true; }

  const bug = !e.isHumanoid;
  const slow = e.slowFactor < 1 ? e.slowFactor : 1;
  const vSpeed = (bug ? ENEMY_CLIMB_SPEED : LADDER_CLIMB_SPEED) * slow;
  const hSpeed = (bug ? ENEMY_WINDOW_CRAWL_SPEED : e.stats.wanderSpeed) * slow;
  const from = e.navTravFrom, via = e.navTravVia, to = e.navTravTo;
  let moved = 0;
  let pane = false;

  // A finished leg hands the rest of the tick to the next one, so the legs a kind does not have cost no time.
  for (let guard = 0; guard < 6 && linkOf(e) !== 0; guard++) {
    let r = 0;
    switch (e.navTravPhase) {
      case 0: {   // across the floor to the start — still grounded
        r = moveXZ(p, from.x, from.z, e.stats.speed * slow * dt);
        p.y = world.getSurfaceY(p.x, p.z, p.y);
        break;
      }
      case 1: {   // window: break a whole pane first
        const nav = world.nav ?? null;
        const id = e.navTravWindow;
        if (!id || !nav || !nav.windowWhole(id)) { r = DONE; break; }
        pane = true;
        e.navTravT += dt;
        const windup = Math.max(0.05, e.stats.attackWindup);
        a.crouch = Math.min(1, e.navTravT / windup) * 0.3;   // the melee wind-up pose (`ai/EnemyAI.attack`)
        if (e.navTravT >= windup) {
          a.crouch = 0;
          a.flinch = Math.max(a.flinch, 0.5); a.flinchZ = 0.8; a.flinchX = 0;   // the same lunge as a bite
          host.playAudio('bug_attack', p, 0.5, 1.1);
          nav.breakWindow(id);
          r = DONE;
        }
        break;
      }
      case 2: r = via.y > p.y + LEVEL_EPS_M ? moveY(p, via.y, vSpeed * dt) : DONE; break;
      case 3: r = moveXZ(p, via.x, via.z, hSpeed * dt); break;
      case 4: r = moveXZ(p, to.x, to.z, hSpeed * dt); break;
      default: {  // 5: down onto the floor
        r = p.y > to.y + LEVEL_EPS_M ? moveY(p, to.y, vSpeed * dt) : DONE;
        if (r < 0) { moved += -r; endTraverse(e, world); }
        break;
      }
    }
    if (r >= 0) { moved += r; break; }
    if (linkOf(e) === 0) break;
    moved += -r;
    e.navTravPhase++;
    e.navTravT = 0;
  }

  // what the pose (and the wire hint) reads
  const ph = e.navTravPhase;
  if (linkOf(e) === 0 || ph < 2) { e.navAloft = false; e.navClimbDir = 0; }
  else {
    e.navAloft = true;
    if (ph === 2) e.navClimbDir = 1;
    else if (ph === 5 && p.y - to.y > DROP_POSE_M) e.navClimbDir = e.navTrav === 1 ? 1 : -1;   // a ladder is backed down, a wall is gone down head first
    else if (ph !== 5) e.navClimbDir = 0;
  }

  // gait from the distance covered (vertical too — the legs work up a wall), head level, mouth working while it chews the pane
  e.distTravelled += moved;
  a.gait += (moved / e.rig.params.strideLength) * TWO_PI;
  if (a.gait > 1e6) a.gait -= 1e6;
  const spd = dt > 0 ? moved / dt : 0;
  a.speed += (Math.min(1, spd / Math.max(1, e.stats.speed * 0.8)) - a.speed) * Math.min(1, dt * 8);
  a.headYaw += (0 - a.headYaw) * Math.min(1, dt * 4);
  a.headPitch += (0 - a.headPitch) * Math.min(1, dt * 4);
  a.mandible += ((pane ? 0.9 : 0.25) - a.mandible) * Math.min(1, dt * 10);
  if (!pane) a.crouch = Math.max(0, a.crouch - dt * 5);
  a.shake = Math.max(0, a.shake - dt * 4);
  a.abdomen = Math.max(0, a.abdomen - dt * 2);
  e.yaw = turnToward(e.yaw, e.navTravYaw, e.stats.turnRate, dt);
  return true;
}
