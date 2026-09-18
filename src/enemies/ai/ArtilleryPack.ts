/**
 * src/enemies/ai/ArtilleryPack.ts — **the artillery's escort · fire condition · own-squad re-summon** (2026-09-17 · 2026-09-18 user's decision).
 *
 * The question this file answers: *who walks beside the artillery, when does it fire, and when does it call up a pack.*
 *
 * - **Escort**: when an artillery burrow-spawns (`Spawner.maybeArtillery`) `ARTILLERY_AI.escortMin`–`escortMax` scavengers dig
 *   out with it (`spawnArtilleryEscort`). An escort's `Enemy.escortOf` is that artillery and it stays by it **until it notices
 *   a target on its own** (`aware` false) — its wander centre (`spawnPos`) follows the artillery and past `escortFollowDist`
 *   it runs back (`escortFollow`). Once aware it rushes the target like any scavenger; a dead artillery drops `escortOf`.
 * - **Fire condition**: it fires only when at least one non-artillery bug (a living, fighting `bug` faction body) stands within
 *   `supportRadius` of the target (`hasBugSupport`). A lone target is not fired at, even inside range.
 * - **Own squad** (2026-09-18 user's decision — 「separately from that, it summons scavengers of its own squad. When every
 *   scavenger dies they respawn after a cooldown」): when **not one** scavenger bound to this artillery is left (dig-in escort
 *   + summoned pack = the bodies whose `escortOf` is this artillery), `ARTILLERY_AI.squadCooldown` starts, and when it runs
 *   out `summonMin`–`summonMax` dig out around it (`maybeSummon`). The old 「once per lifetime」 limit is gone — it refills as
 *   long as the squad dies. A person target in range is what they are sent at (`relentless`, never swapped until it goes down);
 *   with none they guard the artillery like the dig-in escort. Type `scavenger_summon` (0 % drops · `raidXp` 0) — no farming.
 *
 * Every decision · spawn happens only in the authority's (host · single-player) AI tick; the replica sees the result as `ee spawn`.
 * The escort link (`escortOf`) is not on the wire — on a host change `EnemySystem.promote` releases it into plain bugs (intended).
 */
import * as THREE from 'three';
import { BURROW_EMERGE_S, type EnemyType, type GameContext } from '@/shared';
import type { Enemy } from '../Enemy';
import { ARTILLERY_AI } from '../EnemyTypes';
import type { CombatTarget } from '../Targets';

/** The type that digs out alongside as escort (user's decision: scavenger). */
const ESCORT_TYPE: EnemyType = 'scavenger';
/** The summoned pack's type — its own 0 % drops · `raidXp` 0 row (`data/enemies.csv`). */
const SUMMON_TYPE: EnemyType = 'scavenger_summon';
const TWO_PI = Math.PI * 2;
/** How many times one pack member's spot is re-rolled (outside the bounds → again). An algorithm constant. */
const PLACE_TRIES = 4;

const _p = new THREE.Vector3();

/** The minimum shape that both `SpawnHost` and `EnemyHost` satisfy. */
export interface PackSpawnHost {
  readonly ctx: GameContext;
  spawn(type: EnemyType, position: THREE.Vector3, yaw: number, chase: boolean, relentless: boolean, emerge?: number): Enemy | null;
}

/** The part of `EnemyHost` the fire condition reads. */
export interface PackQueryHost {
  readonly active: readonly Enemy[];
}

/** Uniform integer in [min, max] (a fractional csv value is rounded; reversed bounds give min). */
function rollCount(min: number, max: number): number {
  const lo = Math.max(0, Math.round(Number.isFinite(min) ? min : 0));
  const hi = Math.max(lo, Math.round(Number.isFinite(max) ? max : lo));
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/** One ground spot `packRingMin`–`packRingMax` m around `center` → `_p`. false when it stays outside the bounds. */
function placeAround(ctx: GameContext, center: THREE.Vector3, i: number, n: number): boolean {
  const world = ctx.world;
  if (!world) return false;
  const lo = Math.max(0, ARTILLERY_AI.packRingMin);
  const hi = Math.max(lo, ARTILLERY_AI.packRingMax);
  for (let a = 0; a < PLACE_TRIES; a++) {
    const ang = (i / Math.max(1, n)) * TWO_PI + Math.random() * 0.8 + a * 1.3;
    const rad = lo + Math.random() * (hi - lo);
    _p.set(center.x + Math.cos(ang) * rad, 0, center.z + Math.sin(ang) * rad);
    if (!world.isInsideBounds(_p.x, _p.z)) continue;
    world.resolveCollision(_p, 1.2);          // the same trick as `Spawner.placeMember` — inside a rock it is pushed out
    _p.y = world.getHeightAt(_p.x, _p.z);
    return true;
  }
  return false;
}

/**
 * Stands escort scavengers beside the artillery `arty` that has just started digging out (authority only — the spawn path
 * calls it). They come up over the same emerge time as the artillery, knowing no target. Returns the number stood up.
 */
export function spawnArtilleryEscort(host: PackSpawnHost, arty: Enemy): number {
  const n = rollCount(ARTILLERY_AI.escortMin, ARTILLERY_AI.escortMax);
  let made = 0;
  for (let i = 0; i < n; i++) {
    if (!placeAround(host.ctx, arty.position, i, n)) continue;
    const e = host.spawn(ESCORT_TYPE, _p, arty.yaw + (Math.random() - 0.5) * 0.8, false, false, BURROW_EMERGE_S);
    if (!e) continue;
    e.escortOf = arty;
    e.spawnPos.copy(arty.position);
    made++;
  }
  return made;
}

/**
 * One escort tick (`ai/EnemyAI` calls it right before the bug state machine). An escort that noticed a target, and a bug that
 * is not an escort, do nothing. true = too far from the artillery — this tick it **runs** to it as `wander` (chase speed).
 */
export function escortFollow(e: Enemy): boolean {
  const lead = e.escortOf;
  if (!lead) return false;
  if (!lead.active || lead.state === 'dead') { e.escortOf = null; return false; }   // the artillery died → a plain bug
  if (e.aware) return false;                                                         // in combat — rushes like an ordinary bug
  e.spawnPos.copy(lead.position);
  if (e.state !== 'idle' && e.state !== 'wander') return false;
  const dx = e.position.x - lead.position.x, dz = e.position.z - lead.position.z;
  const d = Math.hypot(dx, dz);
  if (d <= ARTILLERY_AI.escortFollowDist) return false;
  const back = Math.max(0, ARTILLERY_AI.packRingMin);
  e.state = 'wander'; e.stateTime = 0;   // restarted every tick so the 7 s wander limit does not cut it off
  e.moveTarget.set(lead.position.x + (dx / d) * back, 0, lead.position.z + (dz / d) * back);
  return true;
}

/** Radius cap (m) when an escort picks a wander spot — so it does not wander off and get pulled back over and over. Not an escort = `rad` unchanged. */
export function escortWanderRadius(e: Enemy, rad: number): number {
  return e.escortOf ? Math.min(rad, Math.max(0, ARTILLERY_AI.escortFollowDist)) : rad;
}

/** Is there a living, fighting non-artillery bug within `supportRadius` of the target `t` (the artillery's fire condition). */
export function hasBugSupport(arty: Enemy, host: PackQueryHost, t: CombatTarget): boolean {
  const r = ARTILLERY_AI.supportRadius;
  const r2 = r * r;
  const tx = t.position.x, tz = t.position.z;
  const list = host.active;
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    /* 2026-09-18 (bug eggs): an egg is not 「a bug beside it」 — it neither moves nor fights, so it must not open a barrage on a
       target standing by a nest. `isCombatant` is false already so the earlier check drops it, but **this condition is the rule**. */
    if (o === arty || o.isEgg || !o.isCombatant || o.faction !== 'bug' || o.type === 'artillery') continue;
    if (t.enemy === o) continue;
    const dx = o.position.x - tx, dz = o.position.z - tz;
    if (dx * dx + dz * dz <= r2) return true;
  }
  return false;
}

/** A person · android squadmate target (enemies of another faction · drones · vehicles are not summon targets). */
function isPersonTarget(t: CombatTarget): boolean {
  return !t.isEnemy && !t.isDrone && !t.isVehicle;
}

/** Is any body bound to this artillery (dig-in escort + summoned pack) still alive and fighting. */
export function hasLivingSquad(arty: Enemy, host: PackQueryHost): boolean {
  const list = host.active;
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    if (o.escortOf === arty && o.isCombatant) return true;
  }
  return false;
}

/**
 * **Own-squad re-summon** (2026-09-18 user's decision, `GimmickAI.chaseArtillery` calls it every chase tick — authority only).
 *
 * When the scavengers bound to the artillery are **wiped out** it starts `ARTILLERY_AI.squadCooldown`, and when that runs out
 * `summonMin`–`summonMax` dig out around it. One left alive sends the cooldown clock back to 0 (「when all of them die, after
 * a cooldown」). A person · android target in range is what they are sent at (`relentless` + target locked), otherwise they
 * guard it like the dig-in escort. The check period is the same `supportCheckS` as the escort · fire condition (no frame sweep).
 */
export function maybeSummon(e: Enemy, dt: number, host: PackSpawnHost & PackQueryHost, t: CombatTarget | null): void {
  if (e.squadCd > 0) e.squadCd = Math.max(0, e.squadCd - dt);
  e.supportCheckT -= dt;
  if (e.supportCheckT > 0) return;
  e.supportCheckT = ARTILLERY_AI.supportCheckS;
  if (hasLivingSquad(e, host)) { e.squadCd = ARTILLERY_AI.squadCooldown; return; }
  if (e.squadCd > 0) return;
  // with a target in range they are sent at it (with none, a 「guard it」 pack like the dig-in escort)
  const send = t && !t.isDeadOrDowned && isPersonTarget(t) && e.distToTarget <= ARTILLERY_AI.maxRange ? t : null;
  const n = rollCount(ARTILLERY_AI.summonMin, ARTILLERY_AI.summonMax);
  for (let i = 0; i < n; i++) {
    if (!placeAround(host.ctx, e.position, i, n)) continue;
    const yaw = send ? Math.atan2(send.position.x - _p.x, send.position.z - _p.z) : e.yaw + (Math.random() - 0.5) * 0.8;
    const s = host.spawn(SUMMON_TYPE, _p, yaw, send !== null, send !== null, BURROW_EMERGE_S);
    if (!s) continue;
    // the squad bookkeeping is the dig-in escort's (`escortOf`) — the next check's 「wiped out?」 counts this
    s.escortOf = e;
    s.spawnPos.copy(e.position);
    if (!send) continue;
    // sent at that target — never swapped until it goes down or disappears (`acquireTarget` re-picks only an invalid target)
    s.target = send;
    s.targetTimer = Number.POSITIVE_INFINITY;
    s.distToTarget = send.dist2D(s.position);
  }
  // even if none was stood up (no spot · pool full) the cooldown is set, so it does not retry on every check
  e.squadCd = ARTILLERY_AI.squadCooldown;
}
