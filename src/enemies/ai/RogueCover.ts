import * as THREE from 'three';
import { ENEMY_WALL_STANDOFF, ROGUE_COVER_FLANK_WEIGHT, coverLineBlocked, pickCoverSpot, type CoverQuery, type CoverSpot, type WorldRef } from '@/shared';
import type { Enemy, EnemyHost } from '../Enemy';
import { ROGUE_AI } from '../EnemyTypes';
import type { CombatTarget } from '../Targets';

/* ────────────────────────────────────────────────────────────────────────────
 * Rogue cover selection (Phase 7, rogue AI v2).
 * A candidate is the far side of an obstacle (radius ≥ 0.5, height ≥ 0.8) within COVER_SEARCH_RADIUS that is not behind
 * the rogue, inside the map, 4 m … 90 % of the rifle range from the target and inside the leash — the Phase 4 filters —
 * and the obstacle must actually **block the line of sight** from a crouched rogue at that point to the target's chest.
 * Candidates are scored by `distance + ROGUE_COVER_FLANK_WEIGHT × (1 − |sin θ|)` where θ is the angle between the
 * target's facing and the target → candidate direction: a point on the target's flank (θ ≈ ±90°) costs nothing extra,
 * one straight ahead of (or behind) the target costs the full weight, so squads spread around the player instead of
 * stacking up in front of them.
 *
 * 2026-09-15 (안드로이드 분대원): the **world-only** half — candidate generation, the map / distance / anchor filters,
 * the crouched-eye LOS ray and the pop-out spot — now lives in `shared/cover.ts` (`pickCoverSpot`), because the
 * androids of `allies/` pick cover by exactly the same rule. What stays here is what only an `Enemy` knows: which
 * numbers to hand over, and the scoring (flank spread, "not the rock we are already at", the approach bonus).
 * ──────────────────────────────────────────────────────────────────────────── */

/** Obstacles farther than this from the rogue are not considered (kept from Phase 4). */
export const COVER_SEARCH_RADIUS = 16;
/** Height above the ground the LOS test starts from at the candidate: a crouched rogue's eyes. */
export const COVER_EYE = 0.9;
/** Standing eye height for the pop-out spot (must see the target). */
export const STAND_EYE = 1.45;
/** Cover closer than this to the target is refused (Phase 4 filter). */
export const COVER_MIN_TARGET_DIST = 4;
/** …and farther than this fraction of the rifle range, from which it could not answer fire. */
export const COVER_MAX_RANGE_FRAC = 0.9;
/*
 * How far past the obstacle's blocking cylinder the rogue stands (hiding spot · pop-out spot): `ENEMY_WALL_STANDOFF`.
 * 2026-09-11 (C-25): the private `COVER_STANDOFF` 0.7 is gone — `ai/FireLine` pulls its muzzle test back by
 * `ENEMY_WALL_STANDOFF` (1 m), so a pop-out spot only 0.7 m off the rock could read as "blocked" from the very spot
 * cover selection had just validated. One number now decides both.
 */

const _chest = new THREE.Vector3();
const _fwd = new THREE.Vector3();

/**
 * True when the world (terrain / obstacles) blocks the line from a crouched eye at `(x, groundY + COVER_EYE, z)` to
 * `chest`. Exported for the smoke test, which re-validates the chosen cover the same way. The ray itself is
 * `shared/cover.coverLineBlocked` — one formula for enemies and androids.
 */
export function coverBlocksLine(world: WorldRef, x: number, groundY: number, z: number, chest: THREE.Vector3, eyeHeight = COVER_EYE): boolean {
  return coverLineBlocked(world, x, groundY + eyeHeight, z, chest);
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
  pickCoverImpl(e, host, t, false);
}

/**
 * Phase 12 (총알 추적): cover for a rogue **advancing** on `t` — a proxy target standing at the shot origin. Same
 * candidates and LOS validation as `pickCover`, but a rock only qualifies when it brings the rogue at least
 * `APPROACH_GAIN` closer to the origin, the flank term is dropped (we want to close in, not to spread out) and the
 * score favours progress toward the origin over a short walk. No candidate → `hasCover = false` (the rogue walks
 * straight toward the origin for a while and looks again).
 */
export function pickApproachCover(e: Enemy, host: EnemyHost, t: CombatTarget): void {
  pickCoverImpl(e, host, t, true);
}

/** A cover leg toward a shot origin must gain at least this many metres on it. */
const APPROACH_GAIN = 3;

/* ── 점수: `pickCoverSpot` 에 넘기는 **모듈 수준** 함수 하나 (매 프레임 클로저를 만들지 않는다) ─────────
 * 부르기 직전에 `pickCoverImpl` 이 아래 상태를 채운다. `pickCoverSpot` 은 한 번의 호출 안에서 동기적으로만
 * 이 함수를 부르므로 재진입이 없다.
 */
let _sTarget: CombatTarget | null = null;
let _sApproach = false;
let _sHadCover = false;
let _sPrevX = 0, _sPrevZ = 0;
let _sDist = 0;

function enemyCoverScore(x: number, z: number, walk: number, toTarget: number): number {
  if (_sApproach && toTarget > _sDist - APPROACH_GAIN) return Infinity;   // Phase 12: the leg must actually close in
  let score = _sApproach ? toTarget + walk * 0.5 : walk;
  if (walk < 1.5) score += 6;                                             // prefer a different rock than the one we are at
  if (_sHadCover && Math.hypot(x - _sPrevX, z - _sPrevZ) < 2.5) score += 6;   // …or the one we just left
  if (!_sApproach) {
    score += Math.max(0, toTarget - 35) * 0.5;
    score += flankCost(_sTarget!, x, z);
  }
  return score;
}

/** 한 벌만 만들어 돌려 쓰는 질의 · 결과 (할당 없음). */
type MutableCoverQuery = { -readonly [K in keyof CoverQuery]: CoverQuery[K] };
const _query: MutableCoverQuery = {
  from: new THREE.Vector3(), threat: new THREE.Vector3(), anchor: new THREE.Vector3(),
  anchorRadius: Infinity, minThreatDist: COVER_MIN_TARGET_DIST, maxThreatDist: 0,
  bodyRadius: ENEMY_WALL_STANDOFF, chestHeight: COVER_EYE, threatEyeHeight: 0,
  searchRadius: COVER_SEARCH_RADIUS, popEyeHeight: STAND_EYE, score: enemyCoverScore,
};
const _spot: CoverSpot = { cover: new THREE.Vector3(), pop: new THREE.Vector3(), hasPop: false, score: 0 };

function pickCoverImpl(e: Enemy, host: EnemyHost, t: CombatTarget, approach: boolean): void {
  const world = host.ctx.world!;
  t.getChest(_chest);
  _sTarget = t;
  _sApproach = approach;
  _sHadCover = e.hasCover;
  _sPrevX = e.coverPos.x; _sPrevZ = e.coverPos.z;
  _sDist = Math.hypot(t.position.x - e.position.x, t.position.z - e.position.z);
  const q = _query;
  q.from = e.position;
  q.threat = t.position;
  // 호위병(`escortOf`)은 리시가 없다 — 대장을 따라다니므로 경계 지점에 묶으면 아예 엄폐하지 못한다
  q.anchor = e.escortOf ? e.position : e.guardPos;
  q.anchorRadius = e.escortOf ? Infinity : e.leash;
  q.maxThreatDist = ROGUE_AI.range * COVER_MAX_RANGE_FRAC;
  // 표적의 가슴 = 종류마다 다르다 (사람 · 적 · 드론 · 차량) — `getChest` 가 답한 높이를 그대로 넘긴다
  q.threatEyeHeight = _chest.y - t.position.y;
  e.hasCover = false;
  e.hasPop = false;
  if (pickCoverSpot(world, q, _spot)) {
    e.coverPos.copy(_spot.cover);
    e.popPos.copy(_spot.pop);
    e.hasCover = true;
    e.hasPop = _spot.hasPop;
  }
  _sTarget = null;
}
