import type { TutorialStepId, TutorialTrack } from '@/shared';
import { PLANET_IDS, TUTORIAL_STEPS, TUTORIAL_TRACK_STEPS, tutorialTrackOf } from '@/shared';
import { TUTORIAL_AMMO_RECIPE, TUTORIAL_BENCH_DEF, TUTORIAL_GUN_RECIPE, TUTORIAL_ROOM_PURPOSE, type StepDef } from './model';

/* ────────────────────────────────────────────────────────────────────────────
 * src/tutorial/Steps.ts — **단계 표**. 각 단계가 무엇을 보여 주고 무엇을 허용하는지만 적는다.
 * 무엇으로 다음 단계에 넘어가는지(진행 조건)는 `TutorialSystem.onEvent` 의 스위치에 있다 — 조건이
 * 이벤트마다 제각각이라 표로 만들면 오히려 읽기 어려워진다.
 *
 * `allow` 에 **없는** 게이트는 전부 막힌다 (사용자 결정: 순서를 엄격하게 강제). `community` 와
 * `screenTab`(인벤토리 외)은 어느 단계에도 없으므로 튜토리얼 내내 잠긴다. `stashItem`(창고 아이템 숨김)은
 * 단계와 무관한 허용 목록(`TUTORIAL_STASH_WHITELIST`)이라 `parts/Gates` 가 직접 판정한다 — `raid` 만 전부 연다.
 * ──────────────────────────────────────────────────────────────────────────── */

const STEP_DEFS: Readonly<Record<TutorialStepId, StepDef>> = {
  intro: {
    id: 'intro', title: '함선에 오신 것을 환영합니다',
    hint: '안내를 읽고 시작하세요.',
  },
  manage: {
    id: 'manage', title: '함선 관리를 여세요',
    hint: '화면 우측 아래의 시설 관리 버튼이 알려 주는 키(M)를 누르면 함선 관리 화면이 열립니다.',
    objectives: [{ id: 'manageOpen', text: '함선 관리를 연다' }],
    // 2026-09-08: 아무것도 안 열린 상태라 밝힐 화면이 없었다 — 우측 하단에 늘 떠 있는 `시설 관리` 키 힌트를
    //   가리켜 "어디를 봐야 하는지"부터 알려 준다 (`ui/hud/ShipManageHint`).
    spot: ['.ship-hint'],
    spotText: '시설 관리 — M',
  },
  /* 2026-09-13 (사용자 결정 — 전력 할당 폐지): 새 함선의 발전기는 처음부터 Lv.1 이라 이 단계는 `TutorialSystem.setStep` 이 늘 조용히 지나친다.
     발전기가 Lv.0 인 함선이 없어졌을 뿐 단계 id 는 계약(`TUTORIAL_STEPS`)이라 남긴다. */
  generator: {
    id: 'generator', title: '발전기를 가동하세요',
    hint: '시설 증축에는 발전기 Lv.1 이 필요합니다. 방 목록 아래의 발전기를 가동하세요.',
    // 작업실도 함께 열어 둔다 — 발전기가 켜지는 순간 바로 다음 단계로 넘어가므로 목록이 흔들리지 않는다.
    allow: { roomPurpose: [TUTORIAL_ROOM_PURPOSE] },
    spot: ['.sm-gen .sm-gen-btn', '.sm-gen', '.sm-side'],
    spotText: '발전기 가동',
  },
  workshop: {
    id: 'workshop', title: '빈 방을 작업실로 증축하세요',
    hint: '방 목록에서 빈 방을 고르고 작업실 증축을 누릅니다.',
    objectives: [{ id: 'workshopBuilt', text: '빈 방을 작업실로 증축' }],
    allow: { roomPurpose: [TUTORIAL_ROOM_PURPOSE] },
    spot: ['.sm-purposes .sm-purpose[data-purpose="workshop"]', '.sm-purposes', '.sm-side'],
    spotText: '빈 방의 시설 증축 → 작업실',
  },
  bench: {
    id: 'bench', title: '총기 작업대를 만드세요',
    hint: '가구 제작 탭에서 총기 작업대의 제작을 누릅니다. 만든 가구는 가구 창고로 들어갑니다.',
    objectives: [{ id: 'benchCrafted', text: '총기 작업대 제작' }],
    allow: { furniture: [TUTORIAL_BENCH_DEF] },
    spot: ['.sm-cards .fcard[data-def-id="furn_bench_gun"]', '.sm-cards', '.sm-side'],
    spotText: '총기 작업대 제작',
  },
  benchPlace: {
    id: 'benchPlace', title: '만든 작업대를 배치하세요',
    hint: '가구 창고 탭에서 총기 작업대를 고른 다음, 작업실 바닥을 클릭해 내려놓습니다.',
    // 2026-09-14 3차: 「고른다 → 내려놓는다」 두 동작이라 줄도 둘이다 (순차 공개).
    objectives: [
      { id: 'benchPick', text: '가구 창고에서 총기 작업대를 집는다' },
      { id: 'benchDown', text: '작업실 바닥에 내려놓는다', reveal: true },
    ],
    allow: { furniture: [TUTORIAL_BENCH_DEF] },
    // 창고 탭이 아직 열려 있지 않으면 그 탭 버튼을 밝힌다 — 탭 자체가 어두운 판에 덮여 못 눌리던 자리다.
    spot: ['.sm-store .fcard[data-def-id="furn_bench_gun"]', '.sm-tabs .sm-tab[data-tab="store"]', '.sm-side'],
    spotText: '가구 창고 → 총기 작업대',
  },
  /*
   * 2026-09-14 3차 (사용자 결정) — **순서에서 빠졌다.** 「닫으세요」만 하는 단계가 하나 서 있을 이유가 없다:
   * 다음 단계(`craftGun`)는 어차피 작업실로 걸어가는 일이고, 관리 모드는 플레이어가 아무 때나 닫으면 된다.
   * `TUTORIAL_TRACK_STEPS`(계약, `src/shared`)는 못 고치므로 `TutorialSystem.setStep` 이 **늘 조용히 지나친다**
   * (`generator` 와 같은 요령). id 는 계약이라 표에는 남는다 — `openCraft` 와 같은 처리이고, 옛 저장의
   * `manageDone` 은 `normalizeStep` 이 `craftGun` 으로 옮겨 붙인다.
   */
  manageDone: {
    id: 'manageDone', title: '함선 관리를 닫으세요',
    hint: '화면 우측 아래 키 가이드의 닫기 키(Tab)를 누르면 관리 모드를 빠져나옵니다 (M · C 도 됩니다).',
    // 작업대는 계속 허용해 둔다 — 막힌 것은 목록에서 사라지므로, 방금까지 보던 카드가 통째로 비지 않도록.
    allow: { manageExit: true, furniture: [TUTORIAL_BENCH_DEF] },
    // 2026-09-09: 관리 모드가 켜져 있는 동안 우측 하단에 떠 있는 키 가이드(`ui/hud/KeyGuide`, `.key-guide`)를 밝힌다 —
    //   가이드가 스스로 맨 오른쪽에 붙이는 `Tab 닫기` 항목(`.kg-close`)이 먼저, 없으면 가이드 한 줄 전체.
    //   가이드는 `pointer-events:none` 이고 z 84 라 어두운 판(78) 위에 떠 있다 — 링은 그 둘레를 두른다.
    spot: ['.key-guide .kg-close', '.key-guide'],
    spotText: 'Tab — 관리 모드 닫기',
  },
  /*
   * 2026-09-09 — 제작 흐름은 **작업대 한 번**이다: 소총 → (같은 창에서) 준중량탄 → 창 닫기 → 장착 → 탄약 가방에.
   * 그래서 `craftGun` 부터 `stowAmmo` 까지는 소총 · 탄약 레시피를 **둘 다** 허용한다 — 막힌 레시피는 목록에서
   * 사라지므로(`hides`), 소총을 만드는 순간 그 행이 빠지고 탄약 행이 튀어나오면 목록이 흔들린다. 어느 것을
   * 만들 차례인지는 스포트라이트가 가리킨다.
   */
  craftGun: {
    id: 'craftGun', title: '작업대에서 돌격소총을 만드세요',
    hint: '작업실로 걸어가 총기 작업대를 사용하고 돌격소총 제작을 1초간 누릅니다.',
    // 2026-09-14 3차: 「이동 → 작동 → 만들기」 세 줄 (순차 공개). 첫 줄은 작업대 앞에 서면 달성이다.
    objectives: [
      { id: 'craftGunWalk', text: '작업실로 이동' },
      { id: 'craftGunOpen', text: '총기 작업대 작동', reveal: true },
      { id: 'craftGunMade', text: '돌격소총 제작', reveal: true },
    ],
    arriveObjective: 'craftGunWalk',
    // `manageDone` 이 빠지면서(2026-09-14 3차) 관리 모드가 열린 채로 이 단계에 들어설 수 있다 —
    //   그때 가구 카드가 통째로 비지 않도록 작업대는 계속 허용해 둔다 (옛 `manageDone` 의 이유 그대로).
    allow: { craft: [TUTORIAL_GUN_RECIPE, TUTORIAL_AMMO_RECIPE], furniture: [TUTORIAL_BENCH_DEF], manageExit: true },
    spot: [`.inv-craft-row[data-recipe="${TUTORIAL_GUN_RECIPE}"] .inv-craft-btn`, `.inv-craft-row[data-recipe="${TUTORIAL_GUN_RECIPE}"]`, '.inv-panel-craft'],
    spotText: '돌격소총 제작',
    guide: 'bench',
  },
  craftAmmo: {
    id: 'craftAmmo', title: '준중량탄을 만드세요',
    // 소총 바로 다음, **같은 작업대 창**이 열린 채로. 재료 부족분은 이 단계에 들어설 때 `ensureMaterials` 가 채운다.
    hint: '같은 작업대에서 준중량탄 제작을 1초간 누릅니다. 재료는 튜토리얼이 채워 둡니다.',
    objectives: [{ id: 'craftAmmoMade', text: '준중량탄 제작' }],
    allow: { craft: [TUTORIAL_GUN_RECIPE, TUTORIAL_AMMO_RECIPE] },
    // 2026-09-10: `bulk_ammo_medium`(대량 제작)이 제작 대개편에서 사라져 `make_ammo_medium` 으로 옮겼다.
    //   선택자는 `TUTORIAL_AMMO_RECIPE` 에서 만든다 — id 를 손으로 두 번 적으면 다음에 또 어긋난다.
    spot: [`.inv-craft-row[data-recipe="${TUTORIAL_AMMO_RECIPE}"] .inv-craft-btn`, `.inv-craft-row[data-recipe="${TUTORIAL_AMMO_RECIPE}"]`, '.inv-panel-craft'],
    spotText: '준중량탄 제작',
    guide: 'bench',
  },
  openBag: {
    id: 'openBag', title: '제작 창을 닫고 가방을 여세요',
    // 2026-09-08: 제작 중에는 장착 장비 칸이 숨는다 (`.inv-root.is-craft`) — 만든 무기를 장착하려면 먼저 작업대를
    //   닫아야 한다. 그 순서를 안내 없이 두면 "장비 칸이 어디 갔지"에서 막힌다.
    hint: '작업대 우측 상단의 닫기를 누르면 장착 장비와 가방이 나타납니다.',
    objectives: [{ id: 'craftClosed', text: '제작 창을 닫는다' }],
    allow: { craft: [TUTORIAL_GUN_RECIPE, TUTORIAL_AMMO_RECIPE] },
    spot: ['.inv-craft-close', '.inv-panel-craft'],
    spotText: '제작 창 닫기',
  },
  equipGun: {
    id: 'equipGun', title: '만든 소총을 주무기로 장착하세요',
    hint: '가방의 소총을 왼쪽 장착 장비의 주무기 I 또는 II 칸으로 끌어다 놓습니다 (창이 닫혔으면 Tab).',
    /*
     * 2026-09-14 3차 — **제작 창이 열려 있으면 장비 칸이 없다** (`.inv-root.is-craft` 가 숨긴다). 그 상태에서
     * 장비칸+가방을 포커싱하면 가방만 밝고 링이 허공을 두른다. 그래서 「제작 창을 닫는다」가 앞줄이고,
     * 닫혀 있으면 `TutorialSystem` 이 단계에 들어서는 순간 그 줄을 달성으로 적어 다음 줄이 바로 열린다.
     * 스포트라이트도 `craftOpen` 을 따라 닫기 버튼 ↔ 장비칸+가방으로 갈린다 (`TutorialSystem.stepView`).
     */
    objectives: [
      { id: 'equipClose', text: '제작 창을 닫는다' },
      { id: 'equipSlot', text: '소총을 주무기 I · II 칸에 장착', reveal: true },
    ],
    // 직전 단계의 레시피는 그대로 열어 둔다 — 막힌 레시피는 목록에서 사라지므로 작업대가 통째로 비지 않게.
    allow: { craft: [TUTORIAL_GUN_RECIPE, TUTORIAL_AMMO_RECIPE] },
    // 2026-09-08: 주무기 칸 하나만 밝히면 **집을 곳(가방)이 어두운 판 아래** 깔려 드래그를 시작조차 못 했다.
    //   장비 열과 가방은 맞닿아 있으므로(−24 px 이음매) 둘의 합집합이 이어진 도형 하나가 된다.
    // 2026-09-09: 장비 열 전체(`.inv-equip`)가 아니라 **주무기 I · II 칸**(`inventory/ui/parts/SlotPanel.buildSlot` 의
    //   `.inv-slot-primary` · `.inv-slot-primary2`, `data-slot` 도 같다)부터 가방까지만 — 보조무기 · 방탄복 · 가방 칸과
    //   임플란트 칸은 이 단계와 상관없다. 구멍은 여전히 사각형 하나라 두 칸과 가방 패널을 감싸는 최소 사각형이 된다.
    spot: ['.inv-root .inv-equip .inv-slot-primary', '.inv-root .inv-equip .inv-slot-primary2', '.inv-panel-bag'],
    spotUnion: true,
    spotText: '가방의 소총 → 주무기 I · II 칸',
  },
  openCraft: {
    // (순서에서 제외, 2026-09-09) `TUTORIAL_STEPS` 에 없다 — id 가 계약(`TutorialStepId`)에 남아 있어 표에만 자리를 둔다.
    //   예전에는 장착 다음에 가방의 `제작` 버튼을 밝혀 탄약 제작 창을 다시 열게 했는데, 지금은 소총 · 탄약을 작업대에서
    //   한 번에 만들므로 할 일이 없다. `stepDef('openCraft')` 는 안전하게 이 항목을 돌려주고 `nextStep` 은 null 이다.
    id: 'openCraft', title: '제작 창을 여세요',
    hint: '가방 우측 상단의 제작 버튼을 누르면 제작 창이 열립니다 (작업대를 직접 사용해도 됩니다).',
    allow: { craft: [TUTORIAL_GUN_RECIPE, TUTORIAL_AMMO_RECIPE] },
    spot: ['.inv-bag-craft', '.inv-panel-bag'],
    spotText: '제작 창 열기',
  },
  stowAmmo: {
    id: 'stowAmmo', title: '탄약을 가방에 넣으세요',
    hint: '함선 창고의 준중량탄을 가방 격자로 끌어다 놓습니다.',
    objectives: [{ id: 'ammoStowed', text: '준중량탄을 가방에 넣는다' }],
    allow: { craft: [TUTORIAL_GUN_RECIPE, TUTORIAL_AMMO_RECIPE] },
    // `equipGun` 과 같은 이유의 합집합 — 집을 곳(창고)과 놓을 곳(가방)이 둘 다 밝아야 드래그가 된다.
    spot: ['.inv-panel-stash', '.inv-panel-bag'],
    spotUnion: true,
    spotText: '준중량탄을 가방으로',
  },
  terminal: {
    id: 'terminal', title: '조종석 터미널을 사용하세요',
    hint: '조종석으로 걸어가 터미널에 상호작용합니다.',
    objectives: [
      { id: 'terminalWalk', text: '조종석으로 이동' },
      { id: 'terminalOpen', text: '조종석 터미널 작동', reveal: true },
    ],
    arriveObjective: 'terminalWalk',
    allow: { terminal: true },
    guide: 'terminal',
  },
  planet: {
    id: 'planet', title: '목표 행성을 지정하세요',
    hint: '행성 이동 버튼을 눌러 첫 번째 행성으로 향합니다.',
    objectives: [{ id: 'planetPicked', text: '목표 행성 지정' }],
    allow: { terminal: true, planet: [PLANET_IDS[0]] },
    spot: ['.hp-travel', '.hub-col.centre', '.menu.hub-menu.fullscreen .frame'],
    spotText: '행성 이동',
  },
  travel: {
    id: 'travel', title: '행성으로 이동 중입니다',
    hint: '워프가 끝날 때까지 기다리세요.',
    objectives: [{ id: 'travelDone', text: '행성 도착까지 기다린다' }],
    allow: { terminal: true },
  },
  board: {
    id: 'board', title: '발사 슬롯에 탑승하세요',
    hint: '발사 포드로 걸어가 상호작용하면 임무가 시작됩니다.',
    objectives: [
      { id: 'boardWalk', text: '발사 슬롯으로 이동' },
      { id: 'boardOn', text: '발사 슬롯에 탑승', reveal: true },
    ],
    arriveObjective: 'boardWalk',
    allow: { terminal: true, board: true },
    guide: 'pod',
  },
  raid: {
    id: 'raid', title: '탈출 지점을 확인하세요',
    hint: '나침반과 화면의 마커가 탈출 지점을 가리킵니다. 안내는 여기까지입니다.',
    // 레이드는 그대로 진행된다 — 이 단계에서는 아무것도 막지 않고 아무것도 감추지 않는다.
    allow: {
      roomPurpose: true, furniture: true, manageExit: true, craft: true,
      terminal: true, planet: true, board: true, screenTab: true, stashItem: true,
    },
  },

  /* ══ 2026-09-14 튜토리얼 개편 (docs/DECISIONS.md 「2026-09-14 — 튜토리얼 개편」) ══════════════════════════════════════════════
   * ① raid — 손으로 지은 튜토리얼 행성. 안내할 것이 **UI 가 아니라 손가락**이라 스포트라이트가 거의 없다:
   *    배운 키는 우측 조작 가이드(`ui/Controls`, `TUTORIAL_CONTROL_HINTS`)에 한 줄씩 쌓이고, 목표 패널은
   *    "지금 무엇을 하는가"만 말한다. 문구에 키 글자를 **적지 않는다** — 리바인드하면 거짓말이 되고,
   *    조작 가이드가 이미 살아 있는 키 라벨을 그린다.
   * ② ship — 함선 첫 진입. 레벨 · 능력치 · 메신저는 전부 기존 화면이라 **스포트라이트로 가리키기만** 한다.
   * ═══════════════════════════════════════════════════════════════════════════════════════════════════ */
  /* ── ① raid — 튜토리얼 레이드 ── */
  /*
   * 2026-09-14 2차 — 목표 패널이 **체크박스 목록**이 되면서 각 단계가 짧은 목표 문장을 갖는다 (`objectives`).
   * `hint` 는 그대로 두었다: 스포트라이트 말풍선의 기본 문구이자 `objectives` 가 없는 단계의 목표 문장이다.
   */
  /*
   * 2026-09-14 4차 (사용자 결정) — **목표가 없다.** 「몸을 일으킨다」는 플레이어가 하는 일이 아니라
   * 연출이 하는 일이라, 체크박스로 세워 두면 할 수 있는 것이 없는 목표가 화면에 남는다. 그리고 이 단계
   * 동안에는 목표 패널 · 조작 가이드를 **아예 그리지 않는다** (`TutorialSystem.quiet`) — 화면이 아직 검다.
   */
  wake: {
    id: 'wake', title: '정신을 차리세요',
    hint: '강하가 실패했습니다. 몸을 일으키는 중입니다 — 잠시 기다리세요.',
    objectives: [],
  },
  move: {
    id: 'move', title: '주변을 둘러보고 걸어가세요',
    hint: '마우스로 시선을 돌리고, 이동 키로 앞쪽 갈라진 땅까지 걸어갑니다.',
    objectives: [{ id: 'walkCliff', text: '갈라진 땅까지 걸어간다' }],
  },
  sprintJump: {
    id: 'sprintJump', title: '달려서 뛰어넘으세요',
    hint: '달리기를 누른 채 속도를 붙여 점프해야 건너갑니다. 서서 뛰면 닿지 않습니다.',
    objectives: [{ id: 'jumpGap', text: '달려서 갈라진 땅을 뛰어넘는다' }],
  },
  corpseLoot: {
    id: 'corpseLoot', title: '쓰러진 대원의 장비를 챙기세요',
    hint: '시체에 상호작용해 무기 · 가방 · 탄약을 꺼내고, 무기를 주무기 칸에 끌어다 놓습니다.',
    /*
     * 2026-09-14 2차 (사용자 결정) — **총을 드는 것만이 필수**다. 가방 · 탄약 · 붕대는 선택 목표로 내려
     * 체크박스로 함께 보이기만 한다 (안 챙겨도 넘어간다). 총을 장착하는 순간 다음 단계이고,
     * 그 순간 체력 · 무기 HUD 가 나타난다 (`HUD_GEAR_STEP` 이 이 단계라 **지나면** 보인다 — 관계는 그대로).
     */
    /*
     * 2026-09-14 3차 (사용자 결정) — **가방을 닫아야** 다음 단계다. 총을 드는 순간 안내가 벌레 구간으로
     * 넘어가면, 아직 인벤토리 화면을 보고 있는 사람의 등 뒤에서 목표가 바뀌어 있다. 그래서 필수가 둘이고
     * 「가방을 닫는다」는 **총을 든 뒤에** 열린다 (`revealOn` — 앞줄이 선택 목표들이라 `reveal` 을 못 쓴다).
     */
    /*
     * 2026-09-14 4차 (사용자 결정) — 줄이 셋으로 줄었다.
     *   • `corpseStim` 삭제 — 그 시체(`corpse:tut_gear`)에는 **회복 아이템이 없다**. 못 하는 일을 적어 두면
     *     선택 목표가 아니라 못 찾은 목표가 된다 (회복은 `heal` 단계의 보급품 시체에서 배운다).
     *   • `corpseClose` 삭제 — 닫는 것은 목표가 아니라 화면을 빠져나오는 방법이다. **단계를 넘기는 신호로는
     *     그대로 남는다** (`onInventoryClosed`): 총을 든 그 순간 목표에 체크가 들어가고 스포트라이트가 꺼지되,
     *     다음 안내는 인벤토리를 닫을 때 온다 — 화면을 보는 동안 등 뒤에서 안내가 바뀌지 않게.
     */
    objectives: [
      { id: 'corpseGun', text: '시체의 기관단총을 주무기 칸에 장착한다' },
      { id: 'corpseBag', text: '가방을 장비 칸에 장착한다', optional: true },
      { id: 'corpseAmmo', text: '탄약을 챙긴다', optional: true },
    ],
    // 장비 칸 ↔ 시체 격자에 걸친 드래그라 합집합으로 밝힌다 (`equipGun` 과 같은 이유).
    // ⚠ 격자 타일에는 def id 가 없고 `data-uid` 뿐이라(`inventory/ui/GridView`) 총 한 칸만 고르는 선택자가
    //   없다 — 구멍은 「시체 격자 ~ 주무기 칸」, 즉 드래그 경로 전체다. 드래그를 시작하면 받을 수 있는 칸이
    //   초록으로 켜지는 것은 인벤토리가 이미 한다 (`.inv-slot.is-target-ok`).
    spot: ['.inv-panel-container', '.inv-root .inv-equip .inv-slot-primary', '.inv-root .inv-equip .inv-slot-primary2'],
    spotUnion: true,
    // 2026-09-14 2차 (사용자 결정): 이 단계만 **딤이 없다** — 시체 격자 · 장비 칸 말고도 볼 것이 많고,
    //   어두운 판이 화면 절반을 덮으면 처음 여는 인벤토리 화면을 읽을 수가 없다.
    spotNoDim: true,
    spotText: '시체의 기관단총 → 주무기 칸',
  },
  /*
   * ── 「앞으로 이동」 구간 셋 (2026-09-14 4차, 사용자 결정) ────────────────────────────────────────
   * 전에는 앞 구간이 끝나는 순간 다음 구간의 안내가 떴다 — 벌레를 잡자마자 「앉아서 낮은 틈을 지나세요」,
   * 안드로이드를 잡자마자 「아래로 뛰어내리세요」. 그 물건은 아직 30 m 앞에 있는데 안내만 먼저 도착한다.
   * 그래서 구간과 구간 사이는 언제나 이 단계이고, 다음 안내는 **그 물건 앞에 섰을 때** 뜬다.
   *
   * 셋 다 **이미 있는 체크포인트**로 끝난다 (`advance1`→`bugs` · `advance2`→`crawl` · `advance3`→`drop`,
   * `model.CHECKPOINT_STEP`) — 월드에 새 트리거가 없다. 스포트라이트도 안내선도 없고, 조작 가이드만
   * `move` 와 같은 세 줄로 되돌아온다 (`TUTORIAL_CONTROL_HINTS` 의 `MOVE_HINTS`).
   * 셋의 정의가 같은 것은 의도다 — 「어디까지 왔는가」는 진행 바가 말하고, 목표 문장은 늘 한 가지다.
   */
  advance1: {
    id: 'advance1', title: '앞으로 나아가세요',
    hint: '길을 따라 앞으로 이동합니다.',
    objectives: [{ id: 'advance1Walk', text: '앞으로 이동한다' }],
  },
  advance2: {
    id: 'advance2', title: '앞으로 나아가세요',
    hint: '길을 따라 앞으로 이동합니다.',
    objectives: [{ id: 'advance2Walk', text: '앞으로 이동한다' }],
  },
  advance3: {
    id: 'advance3', title: '앞으로 나아가세요',
    hint: '길을 따라 앞으로 이동합니다.',
    objectives: [{ id: 'advance3Walk', text: '앞으로 이동한다' }],
  },
  shoot: {
    id: 'shoot', title: '벌레를 처치하세요',
    hint: '정조준하면 탄이 덜 퍼집니다. 둘 다 쓰러뜨리면 다음으로 넘어갑니다.',
    objectives: [{ id: 'killBugs', text: '벌레 둘을 처치한다' }],
  },
  crouch: {
    id: 'crouch', title: '앉아서 낮은 틈을 지나세요',
    hint: '선 채로는 들어가지 않습니다. 앉기 키로 자세를 낮추세요.',
    objectives: [{ id: 'crouchGap', text: '앉아서 낮은 틈을 지난다' }],
  },
  crouchAim: {
    id: 'crouchAim', title: '앉은 채로 조준해 안드로이드를 처치하세요',
    hint: '앉으면 조준 흔들림이 크게 줄어듭니다 — 먼 표적일수록 차이가 납니다.',
    objectives: [{ id: 'killAndroids', text: '안드로이드 둘을 처치한다' }],
  },
  drop: {
    id: 'drop', title: '아래로 뛰어내리세요',
    hint: '높은 곳에서 떨어지면 다칩니다. 여기서는 죽지는 않습니다.',
    objectives: [{ id: 'dropDown', text: '높은 곳에서 아래로 뛰어내린다' }],
  },
  heal: {
    id: 'heal', title: '보급품을 챙기고 회복하세요',
    hint: '주운 회복 아이템은 빠른 사용 칸에 올려야 꺼낼 수 있습니다. 꺼낸 뒤 길게 눌러 쓰세요.',
    // 2026-09-14 2차 (사용자 결정): 체력이 이미 가득이면 이 단계는 조용히 지나친다 (`TutorialSystem.setStep`).
    /*
     * 2026-09-14 4차 (사용자 결정) — 네 줄이 **두 줄 + 선택 하나**로 합쳐졌다.
     *   • 「붕대를 빠른 사용 칸에 올린다」(`healStock`) 삭제 — 붕대 · 수류탄은 주우면 **빈 휠 칸에 자동 등록**된다.
     *     이미 되어 있는 일을 목표로 세우면 안내가 거짓말을 한다 (딤 없는 포커싱도 그래서 함께 없어졌다).
     *   • 남는 것은 **손에 드는 것**과 **쓰는 것** 둘이고, 한 동작의 앞뒤라 순차 공개 없이 함께 보인다.
     *   • 선택 목표 「수류탄을 챙긴다」 — 그 보급품 시체에 수류탄 2개가 있고, 다음 단계(`grenade`)가 그것을 쓴다.
     *     선택 줄이 맨 뒤에 있어도 앞 줄이 `reveal` 을 쓰지 않으므로 처음부터 보인다.
     * 문구에 키 글자를 적지 않는다 — 리바인드하면 거짓말이 되고, 키는 우측 조작 가이드가 그린다.
     */
    objectives: [
      { id: 'healHold', text: '빠른 사용 휠을 꾹 눌러 붕대를 골라 손에 든다' },
      { id: 'healUse', text: '길게 눌러 붕대를 쓴다' },
      { id: 'healGrenade', text: '수류탄을 챙긴다', optional: true },
    ],
  },
  grenade: {
    id: 'grenade', title: '무너진 벽 너머를 정리하세요',
    hint: '엄폐한 적에게는 수류탄이 답입니다. 쓰지 않고 지나가도 됩니다.',
    // 2026-09-14 2차 (사용자 결정) — 한 단계에 필수 + 선택이 함께 보이는 본보기다.
    /*
     * 2026-09-14 4차 (사용자 결정) — 선택 목표가 「처치」에서 **「꺼내 던진다」**로 바뀌었다. 배우는 것은
     * 수류탄을 손에 드는 길이지 명중이 아니고, 빗나갔다고 해서 배운 것이 없어지지는 않는다.
     * 그래서 판정은 `grenade:exploded` 한 줄이다 (처치 여부를 보지 않는다).
     */
    objectives: [
      { id: 'wallPass', text: '무너진 벽 너머로 나아간다' },
      { id: 'grenadeThrow', text: '수류탄을 꺼내 던진다', optional: true },
    ],
  },
  extract: {
    id: 'extract', title: '버려진 함선으로 탈출하세요',
    hint: '함선 안의 스위치를 누르면 10초 뒤 이륙합니다. 그 함선이 앞으로 당신의 함선입니다.',
    objectives: [{ id: 'extractSwitch', text: '버려진 함선의 스위치를 누른다' }],
    // 레이드가 끝나는 단계다 — 아무것도 막지 않는다 (build 트랙의 `raid` 와 같은 처리).
    allow: {
      roomPurpose: true, furniture: true, manageExit: true, craft: true,
      terminal: true, planet: true, board: true, screenTab: true, stashItem: true,
    },
  },
  /* ── ② ship — 함선 첫 진입 ── */
  levelUp: {
    id: 'levelUp', title: '레벨이 올랐습니다',
    // 넘어가는 신호는 `inventory:opened` 하나다 — 인벤토리 화면이 열리면 그 안의 캐릭터 탭은 다음 단계가 밝힌다.
    hint: '임무 보상으로 능력치 포인트가 생겼습니다. 인벤토리 화면을 여세요.',
    objectives: [{ id: 'levelScreen', text: '인벤토리 화면을 연다' }],
    allow: { screenTab: ['character'] },
    // `.scr-tab` 에는 탭마다의 표식이 없다 — 지금 보이는 탭이 인벤토리 · 캐릭터 둘뿐이라 탭 줄 전체를 밝힌다.
    spot: ['.inv-root .scr-tabs', '.inv-root'],
    spotText: '캐릭터 탭',
  },
  stats: {
    id: 'stats', title: '능력치에 포인트를 투자하세요',
    hint: '＋ 로 나눠 담은 뒤 포인트 투자 확정을 1초간 누릅니다. 확정하기 전에는 되돌릴 수 있습니다.',
    objectives: [{ id: 'statsSpent', text: '능력치 포인트 투자 확정' }],
    allow: { screenTab: ['character'] },
    /*
     * 2026-09-14 4차 — 밝히는 것은 **능력치 열 전체**(`.cs-col` 의 첫 열)다. 예전에는 `.pg-confirm` 이 맨 앞이라,
     * 설령 그것을 찾았어도 구멍이 확정 버튼 하나뿐이라 **＋ 버튼이 어두운 판 밑**에 깔려 투자 자체를 못 했다.
     * 능력치 열은 ＋ 줄과 `되돌리기 · 포인트 투자 확정`(`.pg-alloc`)을 함께 담고 있어 구멍 하나로 끝난다.
     * 캐릭터 탭이 아직 안 열렸으면 탭 줄을 밝힌다 — 밝힐 것이 없어 안내가 끊기는 자리를 만들지 않는다.
     * (`.cs-col` 이 **화면에 없는 사본**을 먼저 집던 문제는 `parts/Spotlight` 가 고쳤다 — 그 파일의 주석 참고.)
     */
    spot: ['.cs-col', '.inv-root .scr-tabs'],
    spotText: '＋ 로 투자 → 포인트 투자 확정 (1초 홀드)',
  },
  messenger: {
    id: 'messenger', title: '메신저를 여세요',
    hint: '우측 상단에 읽지 않은 연락이 와 있습니다.',
    objectives: [{ id: 'messengerOpen', text: '메신저를 연다' }],
    allow: { community: true },
    spot: ['.community .cm-btn', '.community'],
    spotText: '메신저',
  },
  ravenQuest: {
    id: 'ravenQuest', title: '레이븐의 의뢰를 받으세요',
    hint: '대답을 고르고 퀘스트 카드의 수락을 누릅니다.',
    objectives: [
      { id: 'ravenTalk', text: '레이븐의 연락에 대답한다' },
      { id: 'ravenAccept', text: '퀘스트를 수락한다' },
    ],
    allow: { community: true },
    spot: ['.ms-qcard', '.ms-page.chats', '.ms-frame'],
    spotText: '레이븐의 첫 연락',
  },
};

/** 단계 정의. 순서에서 빠진 id(`openCraft`)도 표에 있으므로 언제나 정의를 돌려준다. */
export const stepDef = (id: TutorialStepId): StepDef => STEP_DEFS[id];

/**
 * 그 단계가 속한 트랙의 순서 배열 (2026-09-14). 진행률 · 다음 단계는 **자기 트랙 안에서만** 센다 —
 * 트랙마다 목표 패널도 건너뛰기도 따로이기 때문이다. 트랙을 모르는 id(`openCraft`)는 build 로 본다.
 */
export const trackStepsOf = (id: TutorialStepId): readonly TutorialStepId[] =>
  TUTORIAL_TRACK_STEPS[tutorialTrackOf(id) ?? 'build'];

/** 그 단계의 트랙 (모르는 id 는 build — `openCraft` 가 유일하다). */
export const trackOf = (id: TutorialStepId): TutorialTrack => tutorialTrackOf(id) ?? 'build';

/** 순서에 있는 단계인가 — **세 트랙 전부**를 본다 (`openCraft` 처럼 계약에만 남은 id 를 거른다). */
export const isOrderedStep = (id: string): id is TutorialStepId =>
  tutorialTrackOf(id as TutorialStepId) !== null;

/**
 * 저장 · 콘솔에서 들어온 id 를 순서 안의 단계로 고친다 (2026-09-09). 순서에서 빠진 단계는 **그 자리를 이어받은**
 * 단계로 옮겨 붙는다 — 진행 중이던 저장이 새 순서에서도 막히지 않고 이어진다. 모르는 값은 null.
 *
 * `openCraft`(2026-09-09) → `craftAmmo`, `manageDone`(2026-09-14 3차) → `craftGun`.
 * ⚠ 둘 다 `TutorialStepId` 와 아래 `STEP_DEFS` 표에는 **남아 있다** (계약은 이름을 지우지 않는다) — 빠진 것은
 *   `TUTORIAL_STEPS` 의 **순서**뿐이다. 그래서 `tutorialTrackOf` 가 null 을 돌려주고 `trackOf` 가 build 로 본다.
 *   `setStep` 의 `manageDone` 가지는 그래도 남겨 둔다 — 콘솔 `tutorial step manageDone` 의 안전망이다.
 */
export function normalizeStep(id: string | null | undefined): TutorialStepId | null {
  if (typeof id !== 'string') return null;
  if (id === 'openCraft') return 'craftAmmo';
  if (id === 'manageDone') return 'craftGun';
  return isOrderedStep(id) ? id : null;
}

/** 같은 트랙의 다음 단계 (그 트랙의 마지막이면 null = 트랙 종료). */
export function nextStep(id: TutorialStepId): TutorialStepId | null {
  const arr = trackStepsOf(id);
  const i = arr.indexOf(id);
  return i < 0 || i + 1 >= arr.length ? null : arr[i + 1];
}

/** 자기 트랙 안에서의 1-based 순번 (없는 단계는 0). */
export const stepIndexOf = (id: TutorialStepId | null): number =>
  (id ? trackStepsOf(id).indexOf(id) + 1 : 0);

/** 자기 트랙의 단계 수 (없는 단계는 0). */
export const stepCountOf = (id: TutorialStepId | null): number => (id ? trackStepsOf(id).length : 0);
