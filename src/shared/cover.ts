/**
 * src/shared/cover.ts — **picking a cover spot** (2026-09-15). Humanoid enemies (`enemies/ai/RogueCover`) and android
 * squadmates (`allies/`) use the same formula — the same formula in two folders moves to shared (CLAUDE.md §4.1).
 *
 * It takes world queries and numbers only: it knows neither `Enemy` nor a squadmate entity. The distance and radius values come from the caller's own csv.
 * A ray test asks whether the chest height at `cover` is hidden from `threat`'s eye height, and finds along with it the `pop` spot where leaning out opens the line of fire.
 *
 * The body of it is the world-only part of `enemies/ai/RogueCover.pickCoverImpl` moved across unchanged (2026-09-15, A5):
 * a candidate = the spot `obstacle radius + bodyRadius` out on the far side from the threat → inside the map · in the
 * threat-distance band · within the `anchor` radius → score → **is the crouched eye hidden** (ray) → **does leaning out see** (`pop`). The expensive rays are fired only when the score beats the current leader.
 * One thing fixed while moving it: in the old code the ray test overwrote the 「body → threat」 direction scratch vector, so
 * from the second candidate on the 「drop obstacles behind me」 test turned in the wrong direction. Here the scratch vectors are kept apart.
 */
import * as THREE from 'three';
import type { Obstacle, WorldRef } from './types';

export interface CoverQuery {
  /** Foot position of the body taking cover. */
  readonly from: THREE.Vector3;
  /** Foot position of the threat (the enemy) being avoided. */
  readonly threat: THREE.Vector3;
  /** The centre it must stay near — a guard point for an enemy, the squad leader for an android. */
  readonly anchor: THREE.Vector3;
  /** Only spots within this radius (m) of `anchor` are picked. */
  readonly anchorRadius: number;
  /** Distance band to the threat (m) — a spot too close or too far is dropped. */
  readonly minThreatDist: number;
  readonly maxThreatDist: number;
  /** Body radius (m) — it stands this far from the obstacle's edge. */
  readonly bodyRadius: number;
  /** The height the cover has to hide (the crouched chest, m above the feet). */
  readonly chestHeight: number;
  /** Eye height on the threat's side (m above its feet). */
  readonly threatEyeHeight: number;
  /** Only obstacles within this radius (m) of the body are considered. */
  readonly searchRadius: number;
  /* ── appended (2026-09-15, A5): optional fields the caller attaches ── */
  /**
   * The eye height used to judge the lean-out firing spot (`pop`) (m above the feet — usually the **standing** pose).
   * Without it `chestHeight` is used. A body whose crouched and standing heights differ (a person · an android · a
   * humanoid enemy) must pass it: otherwise a spot that is still hidden even after leaning out is picked as 「a spot you can shoot from」.
   */
  readonly popEyeHeight?: number;
  /**
   * The score of one candidate spot (`Infinity` = drop this spot). Without it the **walking distance (m)** is the score.
   * Everything only the caller knows — a flanking bonus, avoiding the previous spot, a bonus for moving forward — folds in here.
   * It is called every frame, so **do not build a new closure**: pass one module-level function (no allocation).
   */
  readonly score?: CoverScore;
}

/** The score function of `pickCoverSpot` — `(spot x, spot z, walking distance m, distance to the threat m)` → score (lower is better). */
export type CoverScore = (x: number, z: number, walk: number, threatDist: number) => number;

export interface CoverSpot {
  /** The spot to crouch at (feet). Only the values are written into the vector the caller made. */
  readonly cover: THREE.Vector3;
  /** The spot to lean out and shoot from (feet). The same as `cover` when `hasPop` is false. */
  readonly pop: THREE.Vector3;
  hasPop: boolean;
  /** Lower is better (the sum of the travel distance and the flank exposure). */
  score: number;
}

/* ── Judgement geometry constants (not balance numbers but the definition of 「what counts as cover」, so not csv material) ── */
/** Behind anything thinner or lower than this a body is not hidden (m). */
const MIN_COVER_RADIUS = 0.5;
const MIN_COVER_HEIGHT = 0.8;
/** An obstacle this far back along the 「body → threat」 axis is dropped from the candidates (m) — it stops cover that sends the body back behind itself. */
const BEHIND_SLACK = 2;
/** How far short of the threat the line-of-fire test stops (m) — so the threat's own collider does not always block the line. */
const LOS_BACK_OFF = 0.3;
/** The lean-out spot: the extra margin out to the side of the obstacle (m), and how far it is pulled back toward the cover (against the obstacle radius). */
const POP_EXTRA = 0.2;
const POP_PULL_BACK = 0.35;

/**
 * The radius a ray really stops at — the prop's `shotRadius` when it declares one. Since 「rock cover」 (2026-09-08) a
 * prop's movement collider (`radius`) is deliberately narrower than the visible silhouette. Take a spot by the narrow one
 * and `pop` lands **inside** the rock, both flanks read as 「still hidden」, and in the end no cover is picked at all.
 */
function blockRadius(o: Obstacle): number {
  return o.shotRadius !== undefined && o.shotRadius > o.radius ? o.shotRadius : o.radius;
}

/**
 * The height a ray stops at — the same change also made the bullet cylinder **lower**. Filter by the movement collider's
 * height and a low rock the crouched eye can see over stays among the candidates and is dropped only by the later ray
 * test. Filter by this height from the start.
 */
function blockHeight(o: Obstacle): number {
  return o.shotHeight !== undefined && o.shotHeight > 0 ? o.shotHeight : o.height;
}

const _eye = new THREE.Vector3();
const _ray = new THREE.Vector3();
const _chest = new THREE.Vector3();
const _pop = new THREE.Vector3();

/**
 * Does the world (terrain · props) block the line from `(x, eyeY, z)` to `point`. It stops `LOS_BACK_OFF` short so it does
 * not catch on the target's own collider. The cover test (crouched eye) and the `pop` test (standing eye) use the same function.
 */
export function coverLineBlocked(world: WorldRef, x: number, eyeY: number, z: number, point: THREE.Vector3): boolean {
  _eye.set(x, eyeY, z);
  _ray.subVectors(point, _eye);
  const dist = _ray.length();
  if (dist < 1e-3) return false;
  _ray.multiplyScalar(1 / dist);
  return world.raycast(_eye, _ray, dist - LOS_BACK_OFF) !== null;
}

/**
 * The lean-out spot beside obstacle `o`: of the two flanks perpendicular to the threat line (out past
 * `radius + bodyRadius + POP_EXTRA`, pulled a little back toward the cover), the nearer one that **sees `_chest` at
 * standing eye height**. Writes `out` and returns true; false when both are hidden.
 */
function findPopSpot(world: WorldRef, o: Obstacle, br: number, q: CoverQuery, cx: number, cz: number, eyeHeight: number, out: THREE.Vector3): boolean {
  const reach = br + q.bodyRadius + POP_EXTRA;
  const pull = br * POP_PULL_BACK;
  let bestD = Infinity;
  for (let side = -1; side <= 1; side += 2) {
    const px = o.position.x + (-cz * side) * reach + cx * pull;
    const pz = o.position.z + (cx * side) * reach + cz * pull;
    if (!world.isInsideBounds(px, pz)) continue;
    const py = world.getHeightAt(px, pz);
    if (coverLineBlocked(world, px, py + eyeHeight, pz, _chest)) continue;   // still hidden = not a spot to shoot from
    const d = Math.hypot(px - q.from.x, pz - q.from.z);
    if (d < bestD) { bestD = d; out.set(px, py, pz); }
  }
  return bestD < Infinity;
}

/** Writes a cover spot matching the conditions into `out` and returns true, else false (`out` is left alone). No allocation — safe to call every frame. */
export function pickCoverSpot(world: WorldRef, q: CoverQuery, out: CoverSpot): boolean {
  const from = q.from, threat = q.threat;
  const obstacles = world.getObstaclesNear(from.x, from.z, q.searchRadius);
  if (obstacles.length === 0) return false;
  _chest.set(threat.x, threat.y + q.threatEyeHeight, threat.z);
  const popEye = q.popEyeHeight !== undefined ? q.popEyeHeight : q.chestHeight;
  // body → threat direction (horizontal unit vector) — used only to filter out 「obstacles behind me」
  let fx = threat.x - from.x, fz = threat.z - from.z;
  const fl = Math.hypot(fx, fz);
  if (fl > 1e-3) { fx /= fl; fz /= fl; }
  let best = Infinity;
  let found = false;
  for (let i = 0; i < obstacles.length; i++) {
    const o = obstacles[i];
    const br = blockRadius(o);
    if (br < MIN_COVER_RADIUS || blockHeight(o) < MIN_COVER_HEIGHT) continue;
    const ox = o.position.x - from.x, oz = o.position.z - from.z;
    if (ox * fx + oz * fz < -BEHIND_SLACK) continue;
    // the cover spot = the far side from the threat
    let cx = o.position.x - threat.x, cz = o.position.z - threat.z;
    const cl = Math.hypot(cx, cz);
    if (cl < 1e-3) continue;
    cx /= cl; cz /= cl;
    const px = o.position.x + cx * (br + q.bodyRadius), pz = o.position.z + cz * (br + q.bodyRadius);
    if (!world.isInsideBounds(px, pz)) continue;
    const toThreat = Math.hypot(threat.x - px, threat.z - pz);
    if (toThreat < q.minThreatDist || toThreat > q.maxThreatDist) continue;
    if (Math.hypot(px - q.anchor.x, pz - q.anchor.z) > q.anchorRadius) continue;
    // cheapest terms first: a candidate that cannot beat the current leader gets no ray
    const walk = Math.hypot(px - from.x, pz - from.z);
    const score = q.score ? q.score(px, pz, walk, toThreat) : walk;
    if (!(score < best)) continue;
    const py = world.getHeightAt(px, pz);
    if (!coverLineBlocked(world, px, py + q.chestHeight, pz, _chest)) continue;   // is this obstacle really hiding it
    if (!findPopSpot(world, o, br, q, cx, cz, popEye, _pop)) continue;            // …and can it shoot by leaning out
    best = score;
    out.cover.set(px, py, pz);
    out.pop.copy(_pop);
    out.hasPop = true;
    out.score = score;
    found = true;
  }
  return found;
}
