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

  /* ── appended (2026-09-14, 튜토리얼 개편 — `docs/plans/tutorial-raid.md`) ── */
  /**
   * **이미 착륙해 있는 탈출선**을 그 자리에 세운다 — 콘솔 · 호출 20초 · 착륙 연출을 전부 건너뛰고 곧장 `landed`.
   * 튜토리얼의 「버려진 함선」이 이것이다: 함선 메시를 따로 만들지 않고 진짜 탈출선을 처음부터 놓아 두므로,
   * 안의 스위치 → 취소 불가 10초 유예 → 이륙 → 결과 · 정산이 **평소 경로 그대로** 흐른다.
   *
   * `ctx.missionMode !== 'tutorial'` 이거나 이미 `idle` 이 아니면 false (본편 탈출 흐름에는 문이 없다).
   * `autoDepart: false` 면 무응답 60초 자동 출발을 걸지 않는다 — 튜토리얼은 둘러보는 시간이 필요하다.
   */
  beginPreLanded?(position: THREE.Vector3, yaw: number, opts?: { autoDepart?: boolean }): boolean;

  /* ── appended (2026-09-14 2차, 사용자 결정 — 튜토리얼 건너뛰기 = 즉시 탈출) ── */
  /**
   * 걸어가서 타는 것을 건너뛰고 **곧장 이륙시킨다** — 로컬 플레이어를 화물칸에 세운 뒤 유예 없이 `liftoff` 로
   * 넘어가므로, 그 뒤의 결과 화면 · 정산 · 함선 획득이 **평소 탈출 경로 그대로** 흐른다.
   *
   * 튜토리얼 전용이다: `ctx.missionMode !== 'tutorial'` 이거나 함선이 `landed` 가 아니면 false.
   * 부르는 곳은 `TutorialSystem.skipTrack('raid')` 하나다 (ESC 메뉴의 「튜토리얼 건너뛰기」가 그리로 간다).
   */
  skipToLiftoff?(): boolean;

  /* ── appended (2026-09-14 3차, 사용자 결정 — 튜토리얼 함선은 스위치를 누르면 즉시 뜬다) ── */
  /**
   * true 면 적이 플레이어를 **바라보되 쏘지 않는다**. 튜토리얼 이륙 동안 미처 처치하지 못한 안드로이드가
   * 화물칸의 플레이어를 쏘는 것을 막는 유일한 문이다 — `keepEnemyOut` 과 같은 이유로 월드 콜라이더가 아니라
   * 질의다 (`enemies/ai` 가 사격 직전에 부른다). 튜토리얼이 아니면 늘 false.
   */
  holdFire?(): boolean;
}
