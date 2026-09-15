/**
 * src/shared/cover.ts — **엄폐 자리 고르기** (2026-09-15). 적 인간형(`enemies/ai/RogueCover`)과 안드로이드 분대원(`allies/`)이
 * 같은 식을 쓴다 — 같은 공식이 두 폴더에 있으면 shared 로 온다 (CLAUDE.md §4.1).
 *
 * 월드 질의와 숫자만 받는다: `Enemy` 도, 분대원 엔티티도 모른다. 거리 · 반경 수치는 부르는 쪽이 자기 csv 에서 넘긴다.
 * 레이 검사로 `threat` 의 눈높이에서 `cover` 의 가슴 높이가 가려지는지 보고, 몸을 내밀면 사선이 열리는 `pop` 을 함께 찾는다.
 *
 * 본문은 `enemies/ai/RogueCover.pickCoverImpl` 의 월드 전용 부분을 그대로 옮긴 것이다 (2026-09-15, A5):
 * 후보 = 위협 반대편으로 `장애물 반경 + bodyRadius` 나간 자리 → 맵 안 · 위협과의 거리대 · `anchor` 반경 → 점수 →
 * **웅크린 눈이 가려지는가**(레이) → **몸을 내밀면 보이는가**(`pop`). 비싼 레이는 점수가 지금 1등을 이길 때만 쏜다.
 * 옮기면서 고친 것 하나: 옛 코드는 레이 검사가 「몸 → 위협」 방향 스크래치 벡터를 덮어써서, 두 번째 후보부터
 * 「뒤쪽 장애물 제외」 판정이 엉뚱한 방향으로 돌았다. 여기서는 스크래치를 나눠 쓴다.
 */
import * as THREE from 'three';
import type { Obstacle, WorldRef } from './types';

export interface CoverQuery {
  /** 엄폐할 몸의 발 위치. */
  readonly from: THREE.Vector3;
  /** 피하려는 위협(적)의 발 위치. */
  readonly threat: THREE.Vector3;
  /** 머물러야 하는 중심 — 적은 경계 지점, 안드로이드는 분대장. */
  readonly anchor: THREE.Vector3;
  /** `anchor` 에서 이 반경(m) 안의 자리만 고른다. */
  readonly anchorRadius: number;
  /** 위협과의 거리 범위(m) — 너무 가깝거나 먼 자리는 버린다. */
  readonly minThreatDist: number;
  readonly maxThreatDist: number;
  /** 몸 반지름(m) — 장애물 가장자리에서 이만큼 떨어져 선다. */
  readonly bodyRadius: number;
  /** 엄폐물이 가려야 하는 높이 (웅크린 가슴, 발 위 m). */
  readonly chestHeight: number;
  /** 위협 쪽 눈높이 (발 위 m). */
  readonly threatEyeHeight: number;
  /** 몸에서 이 반경(m) 안의 장애물만 후보로 본다. */
  readonly searchRadius: number;
  /* ── appended (2026-09-15, A5): 부르는 쪽이 붙이는 선택 항목 ── */
  /**
   * 몸을 내밀어 쏠 자리(`pop`)를 판정할 눈높이 (발 위 m — 보통 **선** 자세). 없으면 `chestHeight` 로 본다.
   * 웅크린 높이와 선 높이가 다른 몸(사람 · 안드로이드 · 인간형 적)은 반드시 넘긴다: 안 그러면 몸을 내밀어도
   * 여전히 가려지는 자리가 「쏠 수 있는 자리」로 뽑힌다.
   */
  readonly popEyeHeight?: number;
  /**
   * 후보 한 자리의 점수 (`Infinity` = 이 자리는 버린다). 없으면 **걸어갈 거리(m)** 가 곧 점수다.
   * 측면 가산점 · 직전 자리 회피 · 전진 보너스처럼 부르는 쪽에만 있는 사정은 전부 여기로 접는다.
   * 매 프레임 불리므로 **클로저를 새로 만들지 말고** 모듈 수준 함수 하나를 넘긴다 (할당 금지).
   */
  readonly score?: CoverScore;
}

/** `pickCoverSpot` 의 점수 함수 — `(자리 x, 자리 z, 걸어갈 거리 m, 위협과의 거리 m)` → 점수(낮을수록 좋다). */
export type CoverScore = (x: number, z: number, walk: number, threatDist: number) => number;

export interface CoverSpot {
  /** 웅크릴 자리 (발). 부르는 쪽이 만든 벡터에 값만 쓴다. */
  readonly cover: THREE.Vector3;
  /** 몸을 내밀어 쏠 자리 (발). `hasPop` 이 false 면 `cover` 와 같다. */
  readonly pop: THREE.Vector3;
  hasPop: boolean;
  /** 낮을수록 좋다 (이동 거리 · 측면 노출의 합). */
  score: number;
}

/* ── 판정 기하 상수 (균형 수치가 아니라 「무엇을 엄폐물로 치는가」의 정의라 csv 대상이 아니다) ── */
/** 이보다 가늘거나 낮은 것 뒤에는 몸이 가려지지 않는다 (m). */
const MIN_COVER_RADIUS = 0.5;
const MIN_COVER_HEIGHT = 0.8;
/** 「몸 → 위협」 축으로 이만큼 뒤에 있는 장애물은 후보에서 뺀다 (m) — 등 뒤로 되돌아가는 엄폐를 막는다. */
const BEHIND_SLACK = 2;
/** 사선 검사가 위협 바로 앞에서 멈추는 여유 (m) — 위협 자신의 콜라이더가 늘 사선을 막지 않게. */
const LOS_BACK_OFF = 0.3;
/** 몸을 내밀 자리: 장애물 옆으로 더 나가는 여유(m)와, 엄폐 쪽으로 당기는 비율(장애물 반경 대비). */
const POP_EXTRA = 0.2;
const POP_PULL_BACK = 0.35;

/**
 * 레이가 실제로 멈추는 반경 — 프롭이 `shotRadius` 를 선언하면 그것이다. 2026-09-08 「바위 엄폐」 이후 프롭의
 * 이동 콜라이더(`radius`)는 보이는 실루엣보다 일부러 좁다. 좁은 쪽으로 자리를 잡으면 `pop` 이 바위 **속**이 되어
 * 두 옆구리 모두 「아직 가려져 있다」로 읽히고, 결국 아무 엄폐도 고르지 못한다.
 */
function blockRadius(o: Obstacle): number {
  return o.shotRadius !== undefined && o.shotRadius > o.radius ? o.shotRadius : o.radius;
}

/**
 * 레이가 멈추는 높이 — 같은 수정이 총알 원기둥을 **더 낮게**도 만들었다. 이동 콜라이더 높이로 거르면 웅크린 눈이
 * 넘겨다볼 수 있는 낮은 바위가 후보에 남아 뒤의 레이 검사에서만 떨어진다. 처음부터 이 높이로 거른다.
 */
function blockHeight(o: Obstacle): number {
  return o.shotHeight !== undefined && o.shotHeight > 0 ? o.shotHeight : o.height;
}

const _eye = new THREE.Vector3();
const _ray = new THREE.Vector3();
const _chest = new THREE.Vector3();
const _pop = new THREE.Vector3();

/**
 * `(x, eyeY, z)` 에서 `point` 까지의 선을 월드(지형 · 프롭)가 막는가. 표적 자신의 콜라이더에 걸리지 않도록
 * `LOS_BACK_OFF` 앞에서 멈춘다. 엄폐 검사(웅크린 눈)와 `pop` 검사(선 눈)가 같은 함수를 쓴다.
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
 * 장애물 `o` 옆에서 몸을 내밀 자리: 위협선에 수직인 두 옆구리(`반경 + bodyRadius + POP_EXTRA` 밖, 엄폐 쪽으로 조금
 * 당김) 중 **선 눈높이로 `_chest` 가 보이는** 가까운 쪽. `out` 에 쓰고 true, 둘 다 가려져 있으면 false.
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
    if (coverLineBlocked(world, px, py + eyeHeight, pz, _chest)) continue;   // 여전히 가려져 있다 = 쏠 자리가 못 된다
    const d = Math.hypot(px - q.from.x, pz - q.from.z);
    if (d < bestD) { bestD = d; out.set(px, py, pz); }
  }
  return bestD < Infinity;
}

/** 조건에 맞는 엄폐 자리를 `out` 에 쓰고 true, 없으면 false (`out` 은 건드리지 않는다). 할당 없이 매 프레임 불러도 된다. */
export function pickCoverSpot(world: WorldRef, q: CoverQuery, out: CoverSpot): boolean {
  const from = q.from, threat = q.threat;
  const obstacles = world.getObstaclesNear(from.x, from.z, q.searchRadius);
  if (obstacles.length === 0) return false;
  _chest.set(threat.x, threat.y + q.threatEyeHeight, threat.z);
  const popEye = q.popEyeHeight !== undefined ? q.popEyeHeight : q.chestHeight;
  // 몸 → 위협 방향 (수평 단위 벡터) — 「등 뒤의 장애물」을 거르는 데만 쓴다
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
    // 엄폐 자리 = 위협 반대편
    let cx = o.position.x - threat.x, cz = o.position.z - threat.z;
    const cl = Math.hypot(cx, cz);
    if (cl < 1e-3) continue;
    cx /= cl; cz /= cl;
    const px = o.position.x + cx * (br + q.bodyRadius), pz = o.position.z + cz * (br + q.bodyRadius);
    if (!world.isInsideBounds(px, pz)) continue;
    const toThreat = Math.hypot(threat.x - px, threat.z - pz);
    if (toThreat < q.minThreatDist || toThreat > q.maxThreatDist) continue;
    if (Math.hypot(px - q.anchor.x, pz - q.anchor.z) > q.anchorRadius) continue;
    // 값싼 항부터: 지금 1등을 이기지 못하는 후보에는 레이를 쏘지 않는다
    const walk = Math.hypot(px - from.x, pz - from.z);
    const score = q.score ? q.score(px, pz, walk, toThreat) : walk;
    if (!(score < best)) continue;
    const py = world.getHeightAt(px, pz);
    if (!coverLineBlocked(world, px, py + q.chestHeight, pz, _chest)) continue;   // 진짜로 가려 주는 장애물인가
    if (!findPopSpot(world, o, br, q, cx, cz, popEye, _pop)) continue;            // …그리고 몸을 내밀면 쏠 수 있는가
    best = score;
    out.cover.set(px, py, pz);
    out.pop.copy(_pop);
    out.hasPop = true;
    out.score = score;
    found = true;
  }
  return found;
}
