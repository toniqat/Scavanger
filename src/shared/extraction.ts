/**
 * src/shared/extraction.ts — **탈출 흐름의 동기 질의** (`ctx.extraction`, 2026-09-13 탈출 개편).
 *
 * 이 파일이 답하는 질문: *다른 폴더가 탈출 함선에 대해 매 프레임 물어야 하는 것은 무엇인가.*
 *
 * - 적은 착륙한 함선 안으로 **절대** 들어오지 않는다 (사용자 결정). 외피 벽은 extraction 이 `WorldRef.addObstacle`
 *   로 등록한 사각 콜라이더라 누구에게나 벽이지만, 뒤쪽 램프 입구는 사람이 드나드는 구멍이라 열려 있다. 그 구멍을
 *   **적에게만** 막는 것이 `keepEnemyOut` 이다 — `enemies/ai/EnemyAI.integrate` 가 `world.resolveCollision` 뒤에 부른다.
 *   `resolveCollision` 은 누가 부르는지 모르므로 월드 콜라이더로는 "적만" 을 표현할 수 없어서 질의로 뺐다.
 * - 나머지는 HUD · 스모크가 읽는 상태다. 이벤트(`extraction:*`)가 원본이고 이 값들은 그 거울이다.
 */
import type * as THREE from 'three';

/** 탈출 흐름의 단계. `liftoff` 는 함선이 떠나는 중(탑승자는 이륙 연출, 남겨진 사람은 리셋 대기). */
export type ExtractionStage = 'idle' | 'countdown' | 'shipIncoming' | 'landed' | 'departing' | 'liftoff';

export interface ExtractionRef {
  readonly stage: ExtractionStage;
  /** 출발 유예의 남은 초. `departing` 이 아니면 -1. */
  readonly departRemaining: number;
  /** 착륙한 함선이 자동 출발 유예를 걸기까지 남은 초. `landed` 가 아니면 -1. */
  readonly idleRemaining: number;
  /** 로컬 플레이어가 함선에 실려 떠나는 중이다 (이륙 연출이 카메라를 들고 있다). */
  readonly riding: boolean;
  /** `position`(발)이 착륙한 · 이륙 중인 함선의 화물칸 안인가. 함선이 없으면 false. */
  isInShipBay(position: THREE.Vector3): boolean;
  /**
   * 적의 몸(발 위치 · 반지름)을 화물칸 밖으로 민다 — 입구(함선 뒤, 로컬 +Z) 쪽으로만. 움직였으면 true.
   * **적 전용**이다: 플레이어 · 원격 몸 · 투척물은 부르지 않는다. 함선이 땅 가까이 있을 때만 영역이 있다.
   */
  keepEnemyOut(position: THREE.Vector3, radius: number): boolean;
}
