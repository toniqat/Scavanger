/* ────────────────────────────────────────────────────────────────────────────
 * 튜토리얼 (2026-09-08). Owner: `tutorial/TutorialSystem` publishes `ctx.tutorial`.
 *
 * 새 프로필이 처음 개인 함선에 들어오면 자동으로 시작해, 함선 안에서 **하우징 → 제작 → 출격**까지 한 바퀴
 * 돌린 뒤 레이드가 시작되면 끝난다. 진행 단계는 localStorage 에 남아 새로고침을 견딘다.
 *
 * 이 계약이 하는 일은 두 가지뿐이다.
 *   1. **게이트** — 튜토리얼은 순서를 엄격하게 강제한다. 각 폴더는 자기 거절 사유 함수 안에서
 *      `ctx.tutorial?.blockReason(gate, id)` 를 한 번 부르고, null 이 아니면 그 한국어 사유를 그대로 쓴다.
 *      튜토리얼이 꺼져 있으면 언제나 null 이므로 평소 동작은 한 글자도 바뀌지 않는다.
 *   2. **숨김** — 튜토리얼 동안 아예 보이면 안 되는 셸 요소(커뮤니티 버튼 · 매치메이킹 섹션)는
 *      `hides(gate)` 로 묻는다.
 *
 * 목표 패널 · 스포트라이트 · 바닥 안내선은 전부 `tutorial/` 이 스스로 그린다 — 다른 폴더는 모른다.
 * ──────────────────────────────────────────────────────────────────────────── */

/** 순서대로 진행하는 단계. `intro` 는 시작 팝업, `done` 은 끝난 상태(= 비활성). */
export type TutorialStepId =
  | 'intro'        // 시작 팝업 — 확인을 누르면 다음으로
  | 'manage'       // M 으로 함선 관리 열기
  | 'workshop'     // 빈 방 하나를 작업실로 증축
  | 'bench'        // 총기 작업대 제작 + 작업실에 배치
  | 'manageDone'   // 함선 관리 종료
  | 'craftGun'     // 작업실로 걸어가 총기 작업대에서 무기 제작
  | 'equipGun'     // 만든 무기를 주무기 칸에 장착
  | 'craftAmmo'    // 그 무기의 탄약 제작
  | 'stowAmmo'     // 탄약을 가방에 넣기
  | 'terminal'     // 조종석 터미널 상호작용
  | 'planet'       // 목표 행성 지정 (1번 행성만)
  | 'travel'       // 행성 이동 컷씬 종료 대기
  | 'board'        // 발사 슬롯 탑승
  | 'raid';        // 레이드 시작 — 탈출구 인디케이터를 강조하고 끝난다

export const TUTORIAL_STEPS: readonly TutorialStepId[] = [
  'intro', 'manage', 'workshop', 'bench', 'manageDone',
  'craftGun', 'equipGun', 'craftAmmo', 'stowAmmo',
  'terminal', 'planet', 'travel', 'board', 'raid',
];

/**
 * 게이트 종류. `id` 의 의미는 종류마다 다르다:
 *   `roomPurpose` → `RoomPurpose` · `furniture` → 가구 def id · `craft` → 레시피 id ·
 *   `planet` → `PlanetId` · 나머지는 id 를 쓰지 않는다.
 */
export type TutorialGate =
  | 'roomPurpose'   // 방 용도 증축
  | 'furniture'     // 가구 제작 / 배치
  | 'manageExit'    // 함선 관리 종료
  | 'craft'         // 아이템 제작
  | 'terminal'      // 터미널 열기
  | 'matchmaking'   // 신호 찾기 · 코드 도킹 · 신호 송출 (숨김 전용)
  | 'planet'        // 행성 지정
  | 'board'         // 발사 슬롯 탑승
  | 'screenTab'     // Tab 화면의 화면 탭 (id = 'character' | 'corp' | 'ship'; 인벤토리는 언제나 열려 있다)
  | 'community';    // 우측 상단 커뮤니티 버튼 (숨김 전용)

/** 튜토리얼이 저장하는 것. `step` 이 null 이면 아직 시작하지 않았다. */
export interface TutorialSave {
  version: number;
  /** 현재 단계. 끝났으면 null. */
  step: TutorialStepId | null;
  /** 끝났다(완주 또는 건너뛰기) — 다시 자동 시작하지 않는다. */
  done: boolean;
  /** 튜토리얼이 만들어 준 방 번호(있으면). 안내선이 그 방을 가리킨다. */
  room?: number;
}

export interface TutorialRef {
  /** 튜토리얼이 돌고 있다. */
  readonly active: boolean;
  /** 현재 단계 (비활성이면 null). */
  readonly step: TutorialStepId | null;
  /** 진행률 표시용 — 1-based 순번과 전체 개수. 비활성이면 둘 다 0. */
  readonly stepIndex: number;
  readonly stepCount: number;

  /**
   * 지금 이 행동이 튜토리얼 때문에 막히는지. 막히면 **한국어 사유**, 아니면 null.
   * 튜토리얼이 꺼져 있으면 항상 null 이므로 호출부는 `?? 평소 규칙` 으로 이어 쓰면 된다.
   */
  blockReason(gate: TutorialGate, id?: string): string | null;
  /** 그 요소를 지금 숨겨야 하는가 (커뮤니티 버튼 · 매치메이킹 섹션). */
  hides(gate: TutorialGate): boolean;

  /** 처음부터 시작 (이미 돌고 있으면 아무 일도 없다). */
  start(): boolean;
  /** 건너뛰기 — 즉시 끝내고 모든 게이트를 푼다. */
  skip(): void;
  /** dev 콘솔 전용: 특정 단계로 건너뛴다. */
  goto(step: TutorialStepId): boolean;
}
