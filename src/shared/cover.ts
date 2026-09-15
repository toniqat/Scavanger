/**
 * src/shared/cover.ts — **엄폐 자리 고르기** (2026-09-15). 적 인간형(`enemies/ai/RogueCover`)과 안드로이드 분대원(`allies/`)이
 * 같은 식을 쓴다 — 같은 공식이 두 폴더에 있으면 shared 로 온다 (CLAUDE.md §4.1).
 *
 * 월드 질의와 숫자만 받는다: `Enemy` 도, 분대원 엔티티도 모른다. 거리 · 반경 수치는 부르는 쪽이 자기 csv 에서 넘긴다.
 * 레이 검사로 `threat` 의 눈높이에서 `cover` 의 가슴 높이가 가려지는지 보고, 몸을 내밀면 사선이 열리는 `pop` 을 함께 찾는다.
 *
 * 2026-09-15 계약 커밋에는 **서명만** 있다 (늘 false). 본문은 enemies 가 `RogueCover.pickCoverImpl` 의 월드 전용 부분을 옮겨 채우고,
 * `pickCover` · `pickApproachCover` 가 이 함수를 부르게 바꾼다.
 */
import type * as THREE from 'three';
import type { WorldRef } from './types';

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
}

export interface CoverSpot {
  /** 웅크릴 자리 (발). 부르는 쪽이 만든 벡터에 값만 쓴다. */
  readonly cover: THREE.Vector3;
  /** 몸을 내밀어 쏠 자리 (발). `hasPop` 이 false 면 `cover` 와 같다. */
  readonly pop: THREE.Vector3;
  hasPop: boolean;
  /** 낮을수록 좋다 (이동 거리 · 측면 노출의 합). */
  score: number;
}

/** 조건에 맞는 엄폐 자리를 `out` 에 쓰고 true, 없으면 false (`out` 은 건드리지 않는다). 할당 없이 매 프레임 불러도 된다. */
export function pickCoverSpot(world: WorldRef, q: CoverQuery, out: CoverSpot): boolean {
  void world; void q; void out;
  return false;
}
