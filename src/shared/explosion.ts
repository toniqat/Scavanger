import * as THREE from 'three';
import {
  BLAST_LOS_CHEST_FRAC, BLAST_LOS_FEET_M, BLAST_LOS_HEAD_FRAC, BLAST_LOS_LIFT_M, BLAST_LOS_SLACK_M,
  EXPLOSION_FULL_FRACTION, EXPLOSION_OUTER_MUL, MELEE_LOS_SLACK_M,
} from './constants';
import type { WorldRef } from './types';

/* ────────────────────────────────────────────────────────────────────────────
 * Explosion falloff (2026-09-15, user's decision)
 *
 * **Why this file exists.** The distance falloff of blast damage was the same one
 * line, `damage * (1 - d / radius)`, **copied into seven folders** — weapons (grenade ·
 * bazooka) · enemies (enemy damage · enemy grenade · rover) · gadgets (mine · C4 ·
 * drone) · stratagems (ship-call drops · structures). Fix one of them and the same
 * explosion hurts an enemy and a player, a host and a replica, differently.
 * It is 「the same formula in two folders moves to `shared`」 (`ballistics.ts` set the precedent), exactly.
 *
 * **What changed.** It is not linear but a **two-step stair**:
 *
 *   ┌ 0 … 0.5 × radius ─ 100 % damage
 *   ├ 0.5 × radius … radius ─ 50 % damage (**a fixed value, independent of distance**, 2026-09-17 user's decision 60 → 50 %)
 *   └ outside radius ─ 0
 *
 * The two numbers are `EXPLOSION_FULL_FRACTION` · `EXPLOSION_OUTER_MUL` in `data/constants.csv`.
 * While it was linear, widening the radius barely hurt anywhere but dead centre — the
 * 6 m point of a 7.2 m grenade was 16.7 % of the centre damage under the old formula.
 * Now that it is a stair, 「was it a hit」 comes first and widening the radius really
 * does widen something.
 *
 * Check (`GRENADE_RADIUS` 7.2 · `GRENADE_DAMAGE` 60 · `EXPLOSION_OUTER_MUL` 0.5 — the 2026-09-17 values):
 *   - d = 3.5 m → 3.5 ≤ 3.6 → ×1   → 60
 *   - d = 3.7 m → 3.6 < 3.7 < 7.2 → ×0.5 → 30
 *   - d = 7.0 m → still ×0.5 → 30
 *   - d = 7.2 m → outside the radius → 0
 *
 * ⚠ The **floor clamps** that differ per site (cover 0.3 · enemy 0.15 · rover 0.15 · enemy grenade 0.1)
 * were not removed — `Math.max(floor, explosionFalloff(...))` lays them **on top of** this multiplier.
 * ⚠ Falloff that is not an explosion (camera shake · the sound distance curve · the sandworm eruption's own
 * rule · the toxin burst · the artillery shell's `×0.75` — anything that **wrote down its own different
 * curve**) does not use this function.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The damage multiplier (0 … 1) taken `dist` away from the centre. Outside the radius, and `radius <= 0`, it is 0.
 *
 * `dist` is whatever the caller measured — many sites pass the **distance to the surface**,
 * the body radius already subtracted (enemy · player · drone · cover). A negative folds to 0.
 */
export function explosionFalloff(dist: number, radius: number): number {
  if (!(radius > 0)) return 0;
  const d = dist > 0 ? dist : 0;
  if (d >= radius) return 0;
  return d <= radius * EXPLOSION_FULL_FRACTION ? 1 : EXPLOSION_OUTER_MUL;
}

/** The damage actually taken at that spot (`damage × explosionFalloff`). Outside the radius it is 0. */
export function explosionDamage(damage: number, dist: number, radius: number): number {
  return damage * explosionFalloff(dist, radius);
}

/**
 * The damage range printed on a tooltip — the outer band (`min`) … the centre (`max`). 2026-09-17 (user's decision): a
 * two-step-stair explosive prints its damage as a **range**, like 「30-60」. `min` is `floor(centre × EXPLOSION_OUTER_MUL)`
 * — the real damage is not floored; this is a display-only floor so no card carries a fraction. It lives here so the stair
 * multiplier is never multiplied in again outside this file.
 */
export function explosionDamageRange(damage: number): { readonly min: number; readonly max: number } {
  return { min: Math.floor(damage * EXPLOSION_OUTER_MUL), max: damage };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Blast · melee occlusion (2026-09-18, user's decision 「폭발 · 근접 공격이 벽 · 지붕 · 바닥을 뚫지 않는다」)
 *
 * It used to measure distance alone — a room beyond a wall, a person under a shell on the roof, a bug beyond the floor of
 * the storey above were all hit the same. The judgement is one call, `WorldRef.raycastBlast` (terrain · structure floor
 * plates · roofs · walls · stairs · props · **window glass**).
 *
 * **Why `raycastBlast` and not `raycast`** (2026-09-18 user's decision 「창은 깨졌어도 폭발을 막고, 낮은
 * 엄폐물은 기존대로」): a broken window frame leaves its collider behind but becomes `Obstacle.passRays`, which lets
 * `raycast` through. So a person standing in the middle of a room was seen — through the one window that room has — by an
 * artillery blast outside, and took the damage. `raycastBlast` blocks on **glass alone**, broken or not; bullets, enemy
 * sight lines and thrown things pass exactly as before.
 * 「Low cover as before」 keeps itself: cover is not `passRays` and blocks both rays the same way, and a person with only
 * their head over the cover is saved by the **three body points** rule below.
 *
 * **Three body points** (user's decision): ankle (`BLAST_LOS_FEET_M`) · chest (`× BLAST_LOS_CHEST_FRAC`) · head (`× BLAST_LOS_HEAD_FRAC`).
 * If even one of them sees the blast centre the damage stands unchanged; only when all three are blocked is it 0 — a person with just their head over a low sill is hit.
 *
 * **The ray runs body → blast centre.** A shell bursts on the face it hit (`hit.point`), so the centre may sit a float's
 * width inside the wall, and a ray starting in there does not see that wall (`rayBox` · `rayCylinder` miss when the origin
 * is inside). Shot from the body, a person on the far side of the wall is stopped at the wall's entry face. A face within
 * `BLAST_LOS_SLACK_M` of the end point is the face the centre is stuck to, so it is not a block.
 * The centre is measured lifted by `BLAST_LOS_LIFT_M` — so a blast lying on a floor or the top of a roof is not blocked by the face right under itself.
 *
 * With no `world` (the hub · tests) nothing blocks. Damage to the cover itself (destructible cover · structures) does not
 * call this — that body *is* the collider the ray hits.
 * ──────────────────────────────────────────────────────────────────────────── */

const _losFrom = new THREE.Vector3();
const _losTo = new THREE.Vector3();
const _losDir = new THREE.Vector3();

/**
 * Is the segment `from` → `to` unblocked by the world. `slack` = a face hit within this distance of the end point is ignored.
 * Melee (attacker's head → the strike point) and the blast three-point test share it.
 *
 * **Melee uses the same `raycastBlast`** (2026-09-18, this file's decision): a window blocks even when broken. A broken
 * frame still pushes the bodies of people and enemies out (`passSmall` lets only a grenade-sized thing through), so the
 * enemy has to bite while standing **outside** the frame, and that is no different from 「biting through a wall」. Block
 * the spot where one window makes a wall disappear for blasts but leave it open for melee, and the same room behaves
 * differently per attack kind and there are two rules — the ray stays one.
 * (There was a counter-argument that a fist may as well pass through a broken window, but as long as the frame blocks the body there is no standing in that spot.)
 */
export function lineClear(world: WorldRef | null | undefined, from: THREE.Vector3, to: THREE.Vector3, slack: number): boolean {
  if (!world || !world.ready) return true;
  _losDir.subVectors(to, from);
  const len = _losDir.length();
  const reach = len - Math.max(0, slack);
  if (!(reach > 1e-3)) return true;
  _losDir.multiplyScalar(1 / len);
  return world.raycastBlast(from, _losDir, reach) === null;
}

/**
 * Does the blast centre `center` see any of the three points of a body with feet at `(x, feetY, z)` and height `height`. `height <= 0` = one point (a drone body centre and the like).
 * Call it **after** the damage is computed, and only on a target already judged inside the radius (at most three rays — it ends at the first point that sees).
 */
export function blastReachesBody(
  world: WorldRef | null | undefined, center: THREE.Vector3, x: number, feetY: number, z: number, height: number,
): boolean {
  if (!world || !world.ready) return true;
  _losTo.set(center.x, center.y + BLAST_LOS_LIFT_M, center.z);
  return bodyPointsVisible(world, _losTo, x, feetY, z, height, BLAST_LOS_SLACK_M);
}

/**
 * Does a melee attack (an enemy's bite · leap · charge · hammer, 2026-09-18) reach the body — it looks at the same three body points from the attacker's mouth/head `from`.
 * Nothing is lifted, and the slack is shorter, `MELEE_LOS_SLACK_M` (the bodies are touching, so a face just before the end point is a wall).
 * Biting a head over low cover lands; through the floor of the storey above, or through a wall, it misses.
 */
export function meleeReachesBody(
  world: WorldRef | null | undefined, from: THREE.Vector3, x: number, feetY: number, z: number, height: number,
): boolean {
  if (!world || !world.ready) return true;
  _losTo.copy(from);
  return bodyPointsVisible(world, _losTo, x, feetY, z, height, MELEE_LOS_SLACK_M);
}

/** Is there any point that sees `target`, tried chest → head → ankle (`height <= 0` = the single foot point). `target` must not be a module scratch vector. */
function bodyPointsVisible(world: WorldRef, target: THREE.Vector3, x: number, feetY: number, z: number, height: number, slack: number): boolean {
  if (!(height > 0)) return lineClear(world, _losFrom.set(x, feetY, z), target, slack);
  if (lineClear(world, _losFrom.set(x, feetY + height * BLAST_LOS_CHEST_FRAC, z), target, slack)) return true;
  if (lineClear(world, _losFrom.set(x, feetY + height * BLAST_LOS_HEAD_FRAC, z), target, slack)) return true;
  return lineClear(world, _losFrom.set(x, feetY + Math.min(BLAST_LOS_FEET_M, height * 0.5), z), target, slack);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Blast → destructible world objects (2026-09-21, B-98, user's decision
 * 「공용 경로로 전부」)
 *
 * Until now only the bazooka walked the obstacle list: every other explosive —
 * grenade, mine, remote mine, ship call, fire zone — damaged enemies, players and
 * drones and left `Obstacle.destructible` alone. That is why the 탐사 차량, which
 * became shootable on 2026-09-21 through exactly that hook, could not be blown up:
 * a bullet reached it and a grenade did not.
 *
 * So the bazooka's loop moved here and every player-side blast calls it. One place
 * decides what an explosion breaks, so dropped cover, window glass and the vehicle
 * all answer the same explosion the same way.
 *
 * **Player-side only.** The vehicle counts what comes through `destructible` toward
 * its hostility (`ROVER_AGGRO_DAMAGE`), so an enemy blast must not arrive here —
 * enemies keep their own `Targets.damageVehicleAt`, which never touches `aggro`.
 *
 * **No occlusion test.** `blastReachesBody` is for bodies *behind* a collider; the
 * thing being damaged here **is** a collider, and a ray from a body inside its own
 * box sees nothing. A wall takes the blast that hits it — that is the point.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Hands `damage`, faded by the shared two-step stair, to every `Obstacle.destructible` whose surface is inside
 * `radius` of `center`. `minFalloff` is the per-site floor laid on top (cover 0.3, a fire zone 1 = the whole zone
 * burns evenly). The point handed to `onDamage` is the **blast centre**, so an owner with hit zones (the 탐사 차량)
 * resolves which part the blast sat next to.
 */
export function blastDestructibles(
  world: WorldRef | null | undefined, center: THREE.Vector3, radius: number, damage: number, minFalloff = 0,
): void {
  if (!world || !world.ready || !(radius > 0) || !(damage > 0)) return;
  if (typeof world.getObstaclesNear !== 'function') return;
  const near = world.getObstaclesNear(center.x, center.z, radius + 1.5);
  for (let i = 0; i < near.length; i++) {
    const o = near[i];
    if (!o.destructible) continue;
    const d = Math.max(0, o.position.distanceTo(center) - o.radius);
    if (d > radius) continue;
    const amount = damage * Math.max(minFalloff, explosionFalloff(d, radius));
    if (amount > 0) o.destructible.onDamage(amount, center);
  }
}
