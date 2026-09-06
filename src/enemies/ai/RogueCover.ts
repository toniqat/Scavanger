import * as THREE from 'three';
import { ROGUE_COVER_FLANK_WEIGHT, type WorldRef } from '@/shared';
import type { Enemy, EnemyHost } from '../Enemy';
import { ROGUE_AI } from '../EnemyTypes';
import type { CombatTarget } from '../Targets';

/* ────────────────────────────────────────────────────────────────────────────
 * Rogue cover selection (Phase 7, rogue AI v2).
 * A candidate is the far side of an obstacle (radius ≥ 0.5, height ≥ 0.8) within COVER_SEARCH_RADIUS that is not behind
 * the rogue, inside the map, 4 m … 90 % of the rifle range from the target and inside the leash — the Phase 4 filters —
 * and, new, the obstacle must actually **block the line of sight** from a crouched rogue at that point to the target's
 * chest (`world.raycast`). Candidates are scored by `distance + ROGUE_COVER_FLANK_WEIGHT × (1 − |sin θ|)` where θ is the
 * angle between the target's facing and the target → candidate direction: a point on the target's flank (θ ≈ ±90°) costs
 * nothing extra, one straight ahead of (or behind) the target costs the full weight, so squads spread around the player
 * instead of stacking up in front of them.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Obstacles farther than this from the rogue are not considered (kept from Phase 4). */
export const COVER_SEARCH_RADIUS = 16;
/** Height above the ground the LOS test starts from at the candidate: a crouched rogue's eyes. */
const COVER_EYE = 0.9;
/** Standing eye height for the pop-out spot (must see the target). */
const STAND_EYE = 1.45;
/** How far past the obstacle's collider the rogue stands. */
const COVER_STANDOFF = 0.7;

const _d = new THREE.Vector3();
const _c = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _chest = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _best = new THREE.Vector3();

/**
 * True when the world (terrain / obstacles) blocks the line from a crouched eye at `(x, groundY + COVER_EYE, z)` to
 * `chest`. Exported for the smoke test, which re-validates the chosen cover the same way.
 */
export function coverBlocksLine(world: WorldRef, x: number, groundY: number, z: number, chest: THREE.Vector3, eyeHeight = COVER_EYE): boolean {
  _eye.set(x, groundY + eyeHeight, z);
  _d.subVectors(chest, _eye);
  const dist = _d.length();
  if (dist < 1e-3) return false;
  _d.multiplyScalar(1 / dist);
  return world.raycast(_eye, _d, dist - 0.3) !== null;
}

/** Flank term: 0 on the target's flank, `ROGUE_COVER_FLANK_WEIGHT` straight ahead of / behind it. */
export function flankCost(target: CombatTarget, x: number, z: number): number {
  target.getForward(_fwd);
  const dx = x - target.position.x, dz = z - target.position.z;
  const l = Math.hypot(dx, dz);
  if (l < 1e-3) return ROGUE_COVER_FLANK_WEIGHT;
  // |sin θ| = |cross(forward, dir)| on the XZ plane
  const sin = Math.abs(_fwd.x * (dz / l) - _fwd.z * (dx / l));
  return ROGUE_COVER_FLANK_WEIGHT * (1 - sin);
}

/**
 * Choose cover for `e` against `t`. Writes `e.coverPos` / `e.hasCover`; no candidate → `hasCover = false` (the rogue
 * crouches where it stands for a short hold instead, as before). Also writes `e.popPos` / `e.hasPop`: the spot beside
 * the chosen obstacle (its flank, `radius + standoff` out) from which a standing rogue *can* see the target's chest —
 * the rogue steps out to it for the burst and back behind the rock afterwards.
 */
export function pickCover(e: Enemy, host: EnemyHost, t: CombatTarget): void {
  const world = host.ctx.world!;
  const obstacles = world.getObstaclesNear(e.position.x, e.position.z, COVER_SEARCH_RADIUS);
  const tp = t.position;
  t.getChest(_chest);
  _d.set(tp.x - e.position.x, 0, tp.z - e.position.z);
  const dist = _d.length();
  if (dist > 1e-3) _d.multiplyScalar(1 / dist);
  let best = Infinity;
  const hadCover = e.hasCover;
  const prevX = e.coverPos.x, prevZ = e.coverPos.z;
  e.hasCover = false;
  e.hasPop = false;
  for (let i = 0; i < obstacles.length; i++) {
    const o = obstacles[i];
    if (o.radius < 0.5 || o.height < 0.8) continue;
    const ox = o.position.x - e.position.x, oz = o.position.z - e.position.z;
    const along = ox * _d.x + oz * _d.z;
    if (along < -2) continue;                                    // behind us
    // cover point: behind the obstacle relative to the target
    _c.set(o.position.x - tp.x, 0, o.position.z - tp.z);
    const l = _c.length();
    if (l < 1e-3) continue;
    _c.multiplyScalar(1 / l);
    const px = o.position.x + _c.x * (o.radius + COVER_STANDOFF), pz = o.position.z + _c.z * (o.radius + COVER_STANDOFF);
    if (!world.isInsideBounds(px, pz)) continue;
    const toTarget = Math.hypot(tp.x - px, tp.z - pz);
    if (toTarget < 4 || toTarget > ROGUE_AI.range * 0.9) continue;
    if (!e.escortOf && Math.hypot(px - e.guardPos.x, pz - e.guardPos.z) > e.leash) continue;
    // cheap terms first, the raycast last: skip candidates that cannot beat the current best anyway
    let score = Math.hypot(px - e.position.x, pz - e.position.z);
    if (score < 1.5) score += 6;                                  // prefer a different rock than the one we are at
    if (hadCover && Math.hypot(px - prevX, pz - prevZ) < 2.5) score += 6;   // …or the one we just left
    score += Math.max(0, toTarget - 35) * 0.5;
    score += flankCost(t, px, pz);
    if (score >= best) continue;
    const py = world.getHeightAt(px, pz);
    if (!coverBlocksLine(world, px, py, pz, _chest)) continue;    // the rock must actually hide us
    // …and we must be able to step out beside it and see the target, otherwise we would hide forever
    if (!findPopSpot(world, o, tp, e.position, _chest, _best)) continue;
    best = score;
    e.coverPos.set(px, py, pz);
    e.popPos.copy(_best);
    e.hasCover = true;
    e.hasPop = true;
  }
}

/**
 * Pop-out spot for obstacle `o`: either flank (perpendicular to the target line, `radius + standoff` out, pulled a
 * little back toward the cover side), the nearer one from which a standing eye sees `chest`. Writes `out`; false when
 * neither flank has a line.
 */
function findPopSpot(world: WorldRef, o: { position: THREE.Vector3; radius: number }, tp: THREE.Vector3, from: THREE.Vector3, chest: THREE.Vector3, out: THREE.Vector3): boolean {
  _c.set(o.position.x - tp.x, 0, o.position.z - tp.z);
  const l = _c.length();
  if (l < 1e-3) return false;
  _c.multiplyScalar(1 / l);
  const reach = o.radius + COVER_STANDOFF + 0.2;
  let bestD = Infinity;
  for (let side = -1; side <= 1; side += 2) {
    const px = o.position.x + (-_c.z * side) * reach + _c.x * o.radius * 0.35;
    const pz = o.position.z + (_c.x * side) * reach + _c.z * o.radius * 0.35;
    if (!world.isInsideBounds(px, pz)) continue;
    const py = world.getHeightAt(px, pz);
    if (coverBlocksLine(world, px, py, pz, chest, STAND_EYE)) continue;   // still hidden: useless as a firing spot
    const d = Math.hypot(px - from.x, pz - from.z);
    if (d < bestD) { bestD = d; out.set(px, py, pz); }
  }
  return bestD < Infinity;
}
