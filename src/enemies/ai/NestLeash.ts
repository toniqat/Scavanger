/**
 * src/enemies/ai/NestLeash.ts — **the nest bug's leash** (2026-09-18, user's decision 「둥지 반경 60 m 리시」).
 *
 * It answers one question: *how far does a bug that came out of a nest chase.*
 *
 * - **Who**: only bodies with `Enemy.nestOf >= 0` — the garrison laid around the nest at raid start and nest refills
 *   (`NestDirector`). Mid-raid patrols · waves · raider drops · bugs the sandworm spat are -1, so they **return on the
 *   first line** — their chase does not change by a hair.
 * - **How far**: past `NEST_LEASH_M` from the nest (`guardPos`) it drops its target and walks home. While returning it
 *   clears `aware` every tick, so **outside the leash nothing whatsoever makes it charge again**. Back inside the leash
 *   it acquires a target at the usual detection range — 「shake it off and it goes home, follow it to the nest and it fights again」.
 * - **Hysteresis**: judging the return at one 60 m line makes it 「drop it, grab it」 over and over at the boundary. So
 *   once it starts home it keeps going until it is inside `NEST_LEASH_M × NEST_LEASH_RETURN_FRAC` (`Enemy.nestReturning`).
 * - Not cut short once started: airborne (a leap · being spat) · mid-charge · staggered. The same exception as the
 *   tutorial's `Tutorial.tutorialHold`, and it goes home on the next tick it touches the ground.
 *
 * Walking · animation · collision stay with the ordinary bug state machine (`ai/EnemyAI`) — this file restores only state · target.
 * Authority only and no wire (`nestOf` is host memory — a host change releases the leash and it becomes a plain bug, intended).
 */
import type { Enemy } from '../Enemy';
import { NEST_LEASH_M, NEST_LEASH_RETURN_FRAC } from '../factionTables';

/**
 * One tick of a nest bug (`ai/EnemyAI.updateEnemyAI` calls it after the perception update, right before the state machine).
 * A body that was not born at a nest returns on the first line.
 */
export function nestLeashHold(e: Enemy): void {
  if (e.nestOf < 0) return;
  // things that end only when they end — it folds on the next tick it touches the ground (the same exception as `Tutorial.tutorialHold`)
  if (e.airborne || e.spatT > 0 || e.chargePhase !== 0 || e.state === 'stagger' || e.state === 'dead' || e.state === 'flee') return;
  const dx = e.position.x - e.guardPos.x, dz = e.position.z - e.guardPos.z;
  const home2 = dx * dx + dz * dz;
  const leash = Math.max(0, NEST_LEASH_M);
  if (!e.nestReturning) {
    if (home2 <= leash * leash) return;
    e.nestReturning = true;
  } else {
    const back = leash * Math.max(0, Math.min(1, NEST_LEASH_RETURN_FRAC));
    if (home2 <= back * back) { e.nestReturning = false; return; }
  }
  leashToNest(e);
}

/**
 * Folds the chase and sends it home to the nest. It folds the same list as `Tutorial.leashHome` — target · perception ·
 * investigation · lure · any ability in progress. Movement is only pointed at `guardPos` in `wander`; the ordinary state machine walks.
 */
function leashToNest(e: Enemy): void {
  e.aware = false;
  e.lostTimer = 0;
  e.target = null;
  e.hasLOS = false;
  e.investigating = false;
  e.hasLure = false;
  e.lureWeight = 0;
  e.suspicionTimer = 0;
  e.spitPhase = 0;
  e.spitAtPoint = false;
  e.toxicPhase = 0;
  e.leaping = false;
  e.structAttack = false;
  e.structBlocking = false;
  e.structTarget = null;
  e.spawnPos.copy(e.guardPos);
  e.state = 'wander';
  e.stateTime = 0;
  e.wanderTimer = 0;
  e.moveTarget.copy(e.guardPos);
  e.hasMoveTarget = true;
  e.hasFacePoint = false;
}
