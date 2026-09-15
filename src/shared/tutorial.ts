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
 *   2. **숨김** — 튜토리얼 동안 보이면 안 되는 것은 `hides(gate, id?)` 로 묻고 **아예 그리지 않는다**.
 *      (2026-09-08) 잠긴 항목을 "튜토리얼에서는 ~" 사유와 함께 남겨 두는 것보다, 지금 할 수 있는 것만
 *      보여 주는 편이 훨씬 덜 헷갈린다 — 방 용도 · 가구 카드 · 레시피 · 화면 탭 · 행성 넘김이 이 규칙을 쓴다.
 *
 * 목표 패널 · 스포트라이트 · 바닥 안내선은 전부 `tutorial/` 이 스스로 그린다 — 다른 폴더는 모른다.
 * ──────────────────────────────────────────────────────────────────────────── */

/* ── appended (2026-09-14, 튜토리얼 개편 — `docs/DECISIONS.md` 「2026-09-14 — 튜토리얼 개편」) ──────────────────────────────────
 *
 * 안내가 **세 트랙**으로 갈라졌고 각각 따로 건너뛴다 (사용자 결정).
 *
 *   ① `raid`  — 튜토리얼 레이드. 캐릭터를 만들면 **함선을 거치지 않고** 손으로 지은 튜토리얼 행성에서 깨어나
 *               이동 · 달리기 · 점프 · 루팅 · 사격 · 앉기 · 회복 · 수류탄을 배우고 버려진 함선으로 탈출한다.
 *   ② `ship`  — 함선 첫 진입. 레벨업 · 능력치 포인트 투자 확정 · 메신저에서 레이븐의 첫 연락과 퀘스트.
 *   ③ `build` — 시설 증축 · 작업대 · 제작 · 출격. **기존 17단계가 그대로 이 트랙이다** (id 도 순서도 불변).
 *
 * 트랙이 갈린 것 말고 설계는 그대로다 — 진행은 버스 이벤트 관찰, 순서 강제는 각 폴더의 `blockReason` 한 줄.
 * ──────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** 안내 트랙. 각각 자기 목표 패널 · 자기 건너뛰기를 갖는다. */
export type TutorialTrack = 'raid' | 'ship' | 'build';

export const TUTORIAL_TRACKS: readonly TutorialTrack[] = ['raid', 'ship', 'build'];

/** 순서대로 진행하는 단계. `intro` 는 시작 팝업, `done` 은 끝난 상태(= 비활성). */
export type TutorialStepId =
  /* ── ① raid (2026-09-14): 튜토리얼 레이드 ── */
  | 'wake'         // 쓰러진 채로 깨어난다 (`PlayerRef.playIntroWake`) — 일어서면 다음으로
  | 'move'         // WASD 이동
  | 'sprintJump'   // 달리기 + 점프로 절벽을 넘는다 (떨어지면 즉사 · 체크포인트)
  /*
   * appended (2026-09-15 2차, 사용자 결정) — **시체와 상호작용.** 전에는 절벽을 넘자마자 「기관단총을 주무기 칸에
   * 장착」이 떴다 — 아직 시체를 열지도 않았는데 그 안의 물건을 옮기라고 하는 셔이다 (`supplyLoot` 을 넣은 것과 같은 눈).
   * 그래서 시체 앞에 서면 먼저 「{INTERACT} 시체 상호작용」 한 줄이고, 가방이 열리면 `corpseLoot` 이다.
   */
  | 'corpseOpen'
  | 'corpseLoot'   // 시체에서 무기 · 가방 · 탄약을 꺼내 장착 (여기서 체력 · 무기 HUD 가 나타난다)
  /*
   * appended (2026-09-14 4차, 사용자 결정) — **「앞으로 이동」 세 구간.** 전에는 앞 단계가 끝나는 순간
   * 다음 단계의 안내가 떴다: 벌레를 잡자마자 「앉아서 낮은 틈을 지나세요」, 안드로이드를 잡자마자
   * 「아래로 뛰어내리세요」 — 그 물건이 30 m 앞에 있는데 안내만 먼저 도착한다. 그래서 **구간과 구간
   * 사이는 언제나 「앞으로 이동」**이고, 다음 안내는 그 물건 앞에 섰을 때(= 체크포인트) 뜬다.
   *   advance1 = 시체 루팅 → 벌레 (`bugs` 체크포인트에서 벌레가 솟는다)
   *   advance2 = 벌레 → 포복 구간 앞 (`crawl`)
   *   advance3 = 안드로이드 → 절벽 2 앞 (`drop`)
   * 셋 다 `CHECKPOINT_STEP`(tutorial/model) 이 이미 아는 체크포인트로 끝나므로 월드에 새 트리거는 없다.
   */
  | 'advance1'
  | 'shoot'        // 벌레 둘 처치 — 사격 · 정조준
  | 'advance2'
  | 'crouch'       // 기둥 밑을 앉아서 지난다
  | 'crouchAim'    // 앉은 채 정조준 — 흔들림이 잦아든다. 안드로이드 둘
  | 'advance3'
  | 'drop'         // 높은 곳에서 뛰어내린다 (낙하 피해, 체력 1 클램프)
  /*
   * appended (2026-09-15, 사용자 결정) — **보급품 시체 루팅.** 전에는 `supply` 체크포인트가 곧장 `heal` 을 열어, 붕대를 줍기도
   * 전에 「붕대를 사용」 이 떴다. 이제 `supply` → `supplyLoot`(필수: 시체에서 붕대 획득 · 선택: 수류탄 획득) → 붕대를 얻은 뒤
   * 시체 가방을 **닫으면** `heal`. 줍지 않고 무너진 벽(`wall`)까지 가면 `heal` 도 건너뛰고 `grenade` 다.
   */
  | 'supplyLoot'
  | 'heal'        // 시체에서 회복 아이템 · 수류탄 (퀵슬롯 자동 장착) → 회복 사용
  | 'grenade'      // 무너진 벽 너머의 안드로이드 둘 — **선택 단계** (쓰지 않고 돌아가도 된다)
  | 'extract'      // 버려진 함선 안의 스위치 → 10초 유예 → 이륙
  /* ── ② ship (2026-09-14): 함선 첫 진입 ── */
  | 'levelUp'      // 레이드 보상으로 오른 레벨 확인
  | 'stats'        // 능력치 포인트 투자 → `포인트 투자 확정` (1초 홀드)
  | 'messenger'    // 메신저 열기 (읽지 않은 연락이 있다)
  | 'ravenQuest'   // 레이븐의 첫 연락 · 대답 고르기 · 퀘스트 수락
  /* ── ③ build: 기존 17단계 (id 불변) ── */
  | 'intro'        // 시작 팝업 — 확인을 누르면 다음으로
  | 'manage'       // M 으로 함선 관리 열기
  | 'generator'    // 발전기 가동 (Lv.1) — 시설 증축의 전제 조건
  | 'workshop'     // 빈 방 하나를 작업실로 증축
  | 'bench'        // 총기 작업대 제작 (가구 창고로 들어간다)
  | 'benchPlace'   // 가구 창고 → 작업대를 골라 작업실 바닥에 배치
  | 'manageDone'   // 함선 관리 종료
  | 'craftGun'     // 작업실로 걸어가 총기 작업대에서 무기 제작
  | 'openBag'      // 제작 창을 닫고 가방 + 장착 장비를 연다 (제작 중에는 장비 칸이 숨어 있다)
  | 'equipGun'     // 만든 무기를 주무기 칸에 장착
  | 'openCraft'    // (순서에서 제외, 2026-09-09) 가방 우측 상단의 제작 버튼으로 제작 창 열기 — 소총 · 탄약을 작업대에서 한 번에 만들면서 빠졌다
  | 'craftAmmo'    // 그 무기의 탄약 제작
  | 'stowAmmo'     // 탄약을 가방에 넣기
  | 'terminal'     // 조종석 터미널 상호작용
  | 'planet'       // 목표 행성 지정 (1번 행성만)
  | 'travel'       // 행성 이동(창문 워프) 종료 대기
  | 'board'        // 발사 슬롯 탑승
  | 'raid';        // 레이드 시작 — 탈출구 인디케이터를 강조하고 끝난다

export const TUTORIAL_STEPS: readonly TutorialStepId[] = [
  'intro', 'manage', 'generator', 'workshop', 'bench', 'benchPlace',
  // 2026-09-09: 총기 작업대에서 소총 → 탄약을 **한 번에** 만든다 — `openCraft` 는 순서에서 빠졌다 (id 는 계약이라 남긴다).
  // 2026-09-14 3차 (사용자 결정 — 「닫기 누르기는 튜토리얼 스텝에서 뺀다」): `manageDone` 도 같은 처리다.
  //   관리 모드를 언제 닫든 안내가 막히지 않고, 진행 바의 분모도 실제로 할 일의 수와 맞는다.
  //   id 는 `TutorialStepId` · `Steps.ts` 의 표에 그대로 있고 옛 저장은 `normalizeStep` 이 `craftGun` 으로 옮긴다.
  'craftGun', 'craftAmmo', 'openBag', 'equipGun', 'stowAmmo',
  'terminal', 'planet', 'travel', 'board', 'raid',
];

/**
 * 트랙별 순서 (2026-09-14). `TUTORIAL_STEPS` 는 **`build` 트랙과 같은 배열**이라 기존 호출부가 그대로 돈다.
 * 진행률(`stepIndex` / `stepCount`)은 지금 도는 트랙 안에서만 센다.
 */
export const TUTORIAL_TRACK_STEPS: Readonly<Record<TutorialTrack, readonly TutorialStepId[]>> = {
  // 2026-09-14 4차: 구간과 구간 사이의 「앞으로 이동」 셋(`advance1`·`2`·`3`)이 들어와 11 → 14 단계다.
  raid: [
    // 2026-09-15 2차: `corpseOpen`(시체 상호작용)이 `corpseLoot` 앞에 들어와 16 단계다.
    'wake', 'move', 'sprintJump', 'corpseOpen', 'corpseLoot', 'advance1', 'shoot', 'advance2', 'crouch', 'crouchAim',
    // 2026-09-15: `supplyLoot`(보급품 시체 루팅)이 `drop` 과 `heal` 사이에 들어왔다.
    'advance3', 'drop', 'supplyLoot', 'heal', 'grenade', 'extract',
  ],
  ship: ['levelUp', 'stats', 'messenger', 'ravenQuest'],
  build: TUTORIAL_STEPS,
};

/** 그 단계가 속한 트랙 (모르는 id 면 null). */
export function tutorialTrackOf(step: TutorialStepId): TutorialTrack | null {
  for (const t of TUTORIAL_TRACKS) if (TUTORIAL_TRACK_STEPS[t].includes(step)) return t;
  return null;
}

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
  | 'community'     // 우측 상단 커뮤니티 버튼 (숨김 전용)
  | 'stashItem'     // 함선 창고 격자의 아이템 (id = 아이템 def id; 숨김 전용, 2026-09-09 — 튜토리얼 재료 · 산출물만 남긴다)
  /**
   * appended (2026-09-14): **HUD 점진 노출** (숨김 전용). id = `TutorialHudPart` —
   * 배우기 전의 HUD 조각을 아예 그리지 않는다. 체력 · 무기는 시체에서 장비를 얻은 뒤에, 스태미나는 처음
   * 소모된 뒤에 나타나고, 임플란트 · 함선 호출은 튜토리얼 레이드 내내 없다(가진 것이 없다).
   */
  | 'hud';

/**
 * `hides('hud', id)` 의 id. 이 이름을 그리는 위젯이 제 이름으로 묻는다.
 *
 * appended (2026-09-14 2차, 사용자 결정) — 튜토리얼 레이드의 **탈출 함선 표시**와 **상단 탈출 타이머**:
 *   • `shipMarker`       지도 마커 · 월드 마커. **튜토리얼 레이드 내내** 뜨지 않는다.
 *                        2026-09-14 4차 (사용자 결정 — 「함선 스위치 단계의 초록색 구체 제거」)에 2차의
 *                        「`extract` 단계에 들어서면 풀린다」를 뒤집었다: 그 월드 마커는 `--c-success` 초록 원
 *                        (`ui/styles/base.css` 의 `.wmarker.ship`)이라 마지막 단계에서 화면에 초록 구슬이
 *                        떠 있었고, 일직선 통로 끝의 함선을 못 찾을 길이 없어 안내 역할도 없었다.
 *   • `shipScreenMarker` 화면(나침반 · 화면 밖 화살표) 함선 마커. **튜토리얼 레이드 내내** 뜨지 않는다.
 *   • `extractionTimer`  상단 중앙의 「자동 출발까지」 · 「도착」 라벨 (튜토리얼 함선은 자동 출발을 걸지 않는다).
 */
export type TutorialHudPart =
  | 'vitals' | 'weapon' | 'stamina' | 'implant' | 'stratagem'
  | 'shipMarker' | 'shipScreenMarker' | 'extractionTimer';

/** 한 트랙의 상태. */
export interface TutorialTrackSave {
  /** 현재 단계. 끝났으면 null. */
  step: TutorialStepId | null;
  /** 끝났다(완주 또는 건너뛰기) — 다시 자동 시작하지 않는다. */
  done: boolean;
}

/**
 * 튜토리얼이 저장하는 것.
 *
 * **v2 (2026-09-14)**: 트랙별로 갈렸다. `tracks` 에 없는 트랙은 아직 시작 전이다.
 * v1 세이브(`step` · `done` 이 최상위)는 읽을 때 `tracks.build` 로 옮겨 붙인다 — v1 의 단계는 전부 build 트랙의
 * 것이었고, 그 프로필은 레이드 · 함선 트랙을 **이미 지난 것으로** 본다(안 그러면 하던 사람에게 튜토리얼이 다시 뜬다).
 *
 * ⚠ 스모크가 심는 모양도 v2 다 — `{version:2, tracks:{raid:{step:null,done:true}, ship:…, build:…}}`.
 */
export interface TutorialSave {
  version: number;
  /** appended (2026-09-14). */
  tracks?: Partial<Record<TutorialTrack, TutorialTrackSave>>;
  /** v1 — 읽기 전용 하위 호환 (새로 쓰지 않는다). */
  step?: TutorialStepId | null;
  /** v1 — 읽기 전용 하위 호환 (새로 쓰지 않는다). */
  done?: boolean;
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
  /**
   * 그 요소를 지금 **그리지 말아야** 하는가.
   *   • `id` 를 주면 그 항목 하나를 묻는다 — `blockReason` 이 막는 것은 전부 숨긴다
   *     (방 용도 · 가구 def · 레시피 · 화면 탭 …).
   *   • `id` 없이 부르면 "이 게이트가 **완전히** 열려 있나"를 묻는다. 열려 있지 않으면 그 UI 를 좁힌다
   *     (커뮤니티 버튼 · 매치메이킹 섹션 · 행성 넘김 화살표).
   */
  hides(gate: TutorialGate, id?: string): boolean;

  /** 처음부터 시작 (이미 돌고 있으면 아무 일도 없다). */
  start(): boolean;
  /** 건너뛰기 — 즉시 끝내고 모든 게이트를 푼다. */
  skip(): void;
  /** dev 콘솔 전용: 특정 단계로 건너뛴다. */
  goto(step: TutorialStepId): boolean;

  /* ── appended (2026-09-14): 3트랙 ── */
  /** 지금 도는 트랙 (비활성이면 null). */
  readonly track: TutorialTrack | null;
  /** 그 트랙이 끝났는가 — 완주 · 건너뛰기 둘 다 true. 아직 시작 전이면 false. */
  isTrackDone(track: TutorialTrack): boolean;
  /** 그 트랙을 처음부터 시작한다. 이미 끝났거나 다른 트랙이 돌고 있으면 false. */
  startTrack(track: TutorialTrack): boolean;
  /**
   * **그 트랙만** 건너뛴다 (목표 패널의 건너뛰기 버튼 · 1초 홀드). 다른 트랙은 그대로 남아 제 때 시작한다 —
   * 조작은 아는데 함선 증축은 처음인 사람이 있기 때문이다 (사용자 결정).
   */
  skipTrack(track: TutorialTrack): void;
}
