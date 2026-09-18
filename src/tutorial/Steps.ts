import type { TutorialStepId, TutorialTrack } from '@/shared';
import { PLANET_IDS, TUTORIAL_RAID_EXTRACT_VALUE_C, TUTORIAL_STEPS, TUTORIAL_TRACK_STEPS, tutorialTrackOf } from '@/shared';
import {
  RAID_KILLS_PER_STEP, SPOT_STATS_RAISE, STATS_RAISE_TEXT, TUTORIAL_AMMO_RECIPE, TUTORIAL_BENCH_DEF, TUTORIAL_GUN_RECIPE, TUTORIAL_ROOM_PURPOSE,
  type StepDef,
} from './model';

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
    // 2026-09-15: 목표 줄은 문장이 아니라 명사구다 — `hint` 가 목표가 되던 단계에도 짧은 줄을 적는다
    objectives: [{ id: 'introRead', text: '시작 안내 확인' }],
  },
  /*
   * 2026-09-17 (사용자 결정 — 「여러 스텝을 하나의 스텝 내 여러 목표로」): **① 시설 관리 → 작업실 증축** 한 단계다 (옛 `manage` ·
   * `generator` · `workshop`). 목표가 순차 공개되고, 포커싱 · 안내선은 **지금 할 목표**의 것이다 (`model.currentObjective`).
   * 「발전기 가동」 줄은 발전기가 Lv.0 인 함선에서만 선다 — 새 함선은 처음부터 Lv.1 이라 `TutorialSystem.objectivesFor` 가
   * 그 줄을 목록에서 뺀다 (옛 `generator` 단계의 「조용히 지나치기」와 같은 뜻). 넘어가는 신호는 작업실 증축 하나다.
   */
  manage: {
    id: 'manage', title: '빈 방을 작업실로 증축하세요',
    hint: '시설 관리 키를 눌러 함선 관리 화면을 열고, 빈 방을 작업실로 증축합니다.',
    objectives: [
      {
        id: 'manageOpen', text: '{MAP} 시설 관리 열기',
        // 2026-09-08: 아무것도 안 열린 상태라 밝힐 화면이 없었다 — 우측 하단에 늘 떠 있는 `시설 관리` 키 힌트를 가리킨다
        spot: ['.ship-hint'], spotText: '시설 관리 {MAP}',
      },
      {
        id: 'generatorOn', text: '발전기 가동', reveal: true,
        spot: ['.sm-gen .sm-gen-btn', '.sm-gen', '.sm-side'], spotText: '발전기 가동',
      },
      {
        id: 'workshopBuilt', text: '빈 방을 작업실로 증축', reveal: true,
        spot: ['.sm-purposes .sm-purpose[data-purpose="workshop"]', '.sm-purposes', '.sm-side'], spotText: '빈 방의 시설 증축 → 작업실',
      },
    ],
    // 작업실은 처음부터 열어 둔다 — 줄이 바뀔 때마다 용도 목록이 흔들리지 않게 (`ui/hud/ShipManage` 는 단계 id 로만 다시 그린다)
    allow: { roomPurpose: [TUTORIAL_ROOM_PURPOSE] },
    spot: ['.ship-hint'],
    spotText: '시설 관리 {MAP}',
  },
  /* 2026-09-13 (사용자 결정 — 전력 할당 폐지): 새 함선의 발전기는 처음부터 Lv.1 이라 이 단계는 `TutorialSystem.setStep` 이 늘 조용히 지나친다.
     발전기가 Lv.0 인 함선이 없어졌을 뿐 단계 id 는 계약(`TUTORIAL_STEPS`)이라 남긴다. */
  generator: {
    id: 'generator', title: '발전기를 가동하세요',
    hint: '시설 증축에는 발전기 Lv.1 이 필요합니다. 방 목록 아래의 발전기를 가동하세요.',
    objectives: [{ id: 'generatorOn', text: '발전기 가동' }],
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
  /*
   * 2026-09-17 (사용자 결정): **② 총기 작업대 제작 → 가구 창고 탭 → 가구 배치 → 하우징 모드 닫기** (옛 `bench` · `benchPlace` ·
   * `manageDone`). 가구 제작은 가운데 모달(`.sm-craft`)의 **1초 홀드** 버튼(`.sm-craft-ok`)이다 — 모달이 떠 있으면 그 버튼을,
   * 아니면 카드를 밝힌다 (먼저 찾히는 하나). 「가구 창고 탭」은 탭 버튼이 켜져 있는가를 `TutorialSystem.poll` 이 본다.
   * 가구를 집은(커서에 든) 동안에는 포커싱을 접는다 — 내려놓을 바닥을 어두운 판이 덮으면 안 된다 (`benchArmed`).
   * 배치가 끝났는데 하우징 모드가 이미 닫혀 있으면 마지막 줄은 할 일이 없으므로 그대로 넘어간다 (옛 `manageDone` 의 조용히 지나치기).
   */
  bench: {
    id: 'bench', title: '총기 작업대를 만들어 배치하세요',
    hint: '가구 제작에서 총기 작업대를 길게 눌러 만들고, 가구 창고 탭에서 작업실에 배치한 뒤 하우징 모드를 닫습니다.',
    objectives: [
      {
        id: 'benchCrafted', text: '총기 작업대 제작',
        spot: ['.sm-craft .sm-craft-ok', '.sm-cards .fcard[data-def-id="furn_bench_gun"]', '.sm-cards', '.sm-side'],
        spotText: '길게 눌러 총기 작업대 제작',
      },
      {
        id: 'benchStore', text: '가구 창고 탭으로 이동', reveal: true,
        spot: ['.sm-tabs .sm-tab[data-tab="store"]', '.sm-side'], spotText: '가구 창고 탭',
      },
      {
        id: 'benchDown', text: '가구 배치', reveal: true,
        spot: ['.sm-store .fcard[data-def-id="furn_bench_gun"]', '.sm-tabs .sm-tab[data-tab="store"]', '.sm-side'],
        spotText: '가구 창고 → 총기 작업대 배치',
      },
      {
        id: 'manageClose', text: '{INVENTORY} 하우징 모드 닫기', reveal: true,
        // 관리 모드가 켜져 있는 동안 우측 하단 키 가이드(`ui/hud/KeyGuide`)가 스스로 붙이는 `Tab 닫기` 항목
        spot: ['.key-guide .kg-close', '.key-guide'], spotText: 'Tab — 하우징 모드 닫기',
      },
    ],
    allow: { furniture: [TUTORIAL_BENCH_DEF], manageExit: true },
    spot: ['.sm-craft .sm-craft-ok', '.sm-cards .fcard[data-def-id="furn_bench_gun"]', '.sm-cards', '.sm-side'],
    spotText: '길게 눌러 총기 작업대 제작',
  },
  benchPlace: {
    id: 'benchPlace', title: '만든 작업대를 배치하세요',
    hint: '가구 창고 탭에서 총기 작업대를 고른 다음, 작업실 바닥을 클릭해 내려놓습니다.',
    // 2026-09-14 3차: 「고른다 → 내려놓는다」 두 동작이라 줄도 둘이다 (순차 공개).
    objectives: [
      { id: 'benchPick', text: '가구 창고에서 총기 작업대 선택' },
      { id: 'benchDown', text: '작업실 바닥에 배치', reveal: true },
    ],
    allow: { furniture: [TUTORIAL_BENCH_DEF] },
    // 창고 탭이 아직 열려 있지 않으면 그 탭 버튼을 밝힌다 — 탭 자체가 어두운 판에 덮여 못 눌리던 자리다.
    spot: ['.sm-store .fcard[data-def-id="furn_bench_gun"]', '.sm-tabs .sm-tab[data-tab="store"]', '.sm-side'],
    spotText: '가구 창고 → 총기 작업대',
  },
  /*
   * 2026-09-14 3차 (사용자 결정) — 순서에서 빠졌었다: 「닫으세요」만 하는 단계가 서 있을 이유가 없다고 봤다.
   * 2026-09-15 (사용자 결정 — 뒤집음) — **순서로 돌아왔다.** 「작업실로 이동」(`craftGun` 의 첫 줄) 바로 앞이다:
   * 관리 모드가 열린 채로는 걸어갈 수 없는데 안내는 걸어가라고 했고, 바닥 안내선까지 관리 카메라 아래에 깔렸다.
   * 그래서 이 단계가 먼저 닫게 하고, 안내선은 관리 모드가 열려 있는 동안 **어느 단계에서도 그리지 않는다**
   * (`TutorialSystem.refreshVisuals` — `ctx.housing.shipManageMode` · `housingMode`).
   * 관리 모드가 이미 닫힌 채 이 단계에 들어서면(콘솔 · 저장 복구) 할 일이 없으므로 `setStep` 이 조용히 지나친다
   * (`generator` 와 같은 요령).
   */
  manageDone: {
    id: 'manageDone', title: '하우징 모드를 닫으세요',
    hint: '화면 우측 아래 키 가이드의 닫기 키(Tab)를 누르면 하우징 모드를 빠져나옵니다 (M · C 도 됩니다).',
    objectives: [{ id: 'manageClose', text: '{INVENTORY} 하우징 모드 닫기' }],
    // 작업대는 계속 허용해 둔다 — 막힌 것은 목록에서 사라지므로, 방금까지 보던 카드가 통째로 비지 않도록.
    allow: { manageExit: true, furniture: [TUTORIAL_BENCH_DEF] },
    // 2026-09-09: 관리 모드가 켜져 있는 동안 우측 하단에 떠 있는 키 가이드(`ui/hud/KeyGuide`, `.key-guide`)를 밝힌다 —
    //   가이드가 스스로 맨 오른쪽에 붙이는 `Tab 닫기` 항목(`.kg-close`)이 먼저, 없으면 가이드 한 줄 전체.
    //   가이드는 `pointer-events:none` 이고 z 84 라 어두운 판(78) 위에 떠 있다 — 링은 그 둘레를 두른다.
    spot: ['.key-guide .kg-close', '.key-guide'],
    spotText: 'Tab — 하우징 모드 닫기',
  },
  /*
   * 2026-09-09 — 제작 흐름은 **작업대 한 번**이다: 소총 → (같은 창에서) 준중량탄 → 창 닫기 → 장착 → 탄약 가방에.
   * 그래서 `craftGun` 부터 `stowAmmo` 까지는 소총 · 탄약 레시피를 **둘 다** 허용한다 — 막힌 레시피는 목록에서
   * 사라지므로(`hides`), 소총을 만드는 순간 그 행이 빠지고 탄약 행이 튀어나오면 목록이 흔들린다. 어느 것을
   * 만들 차례인지는 스포트라이트가 가리킨다.
   */
  /*
   * 2026-09-17 (사용자 결정): **③ 작업실로 이동 → 작업대 작동 → 돌격소총 → 준중량탄 → 제작창 닫기** (옛 `craftGun` · `craftAmmo` ·
   * `openBag`). 준중량탄 재료는 소총이 완성되는 순간 채운다 (`TutorialSystem.onCrafted` → `ensureMaterials`). 닫기는 작업대 창째
   * 닫는다 (`inventory/parts/Crafting.closeCraftWindow`) — 그것이 이 단계의 끝이다.
   * 걸어가는 두 줄은 스포트라이트가 없고(아직 창이 없다) 안내선이 작업대를 가리킨다. 창 안의 줄은 안내선이 없다.
   */
  craftGun: {
    id: 'craftGun', title: '작업대에서 돌격소총과 탄약을 만드세요',
    hint: '작업실로 걸어가 총기 작업대를 사용하고 돌격소총 · 준중량탄 제작을 1초간 누른 뒤 제작창을 닫습니다.',
    objectives: [
      { id: 'craftGunWalk', text: '작업실로 이동', arrive: true, spot: [] },
      { id: 'craftGunOpen', text: '총기 작업대 작동', reveal: true, spot: [] },
      { id: 'craftGunMade', text: '돌격소총 제작', reveal: true, guide: null },
      {
        id: 'craftAmmoMade', text: '준중량탄 제작', reveal: true, guide: null,
        spot: [`.inv-craft-row[data-recipe="${TUTORIAL_AMMO_RECIPE}"] .inv-craft-btn`, `.inv-craft-cell[data-recipe="${TUTORIAL_AMMO_RECIPE}"]`, '.inv-panel-craft'],
        spotText: '준중량탄 제작',
      },
      { id: 'craftClosed', text: '제작창 닫기', reveal: true, guide: null, spot: ['.inv-craft-close', '.inv-panel-craft'], spotText: '제작창 닫기' },
    ],
    arriveObjective: 'craftGunWalk',
    // 관리 모드를 다시 열어도(콘솔 · 저장 복구 · 되돌아간 사람) 가구 카드가 통째로 비지 않도록 작업대는 계속
    //   허용해 둔다 (`manageDone` 과 같은 이유). 2026-09-15 부터는 `manageDone` 이 앞에 있어 평소에는 닫힌 채 들어선다.
    allow: { craft: [TUTORIAL_GUN_RECIPE, TUTORIAL_AMMO_RECIPE], furniture: [TUTORIAL_BENCH_DEF], manageExit: true },
    /* 2026-09-15 3차 (제작 UI 개편): 고른 레시피의 **상세**가 `.inv-craft-row` 라, 그 레시피가 골라져 있으면 홀드 버튼을,
       아직 아니면 눌러야 할 **조합 목록 칸**(`.inv-craft-cell`)을 밝힌다 — `spot` 은 먼저 맞는 것 하나를 고르는 폴백 목록이다. */
    spot: [`.inv-craft-row[data-recipe="${TUTORIAL_GUN_RECIPE}"] .inv-craft-btn`, `.inv-craft-cell[data-recipe="${TUTORIAL_GUN_RECIPE}"]`, '.inv-panel-craft'],
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
    /* 2026-09-15 3차 (제작 UI 개편): 고른 레시피의 **상세**가 `.inv-craft-row` 라, 그 레시피가 골라져 있으면 홀드 버튼을,
       아직 아니면 눌러야 할 **조합 목록 칸**(`.inv-craft-cell`)을 밝힌다 — `spot` 은 먼저 맞는 것 하나를 고르는 폴백 목록이다. */
    spot: [`.inv-craft-row[data-recipe="${TUTORIAL_AMMO_RECIPE}"] .inv-craft-btn`, `.inv-craft-cell[data-recipe="${TUTORIAL_AMMO_RECIPE}"]`, '.inv-panel-craft'],
    spotText: '준중량탄 제작',
    guide: 'bench',
  },
  openBag: {
    id: 'openBag', title: '제작 창을 닫고 가방을 여세요',
    // 2026-09-08: 제작 중에는 장착 장비 칸이 숨는다 (`.inv-root.is-craft`) — 만든 무기를 장착하려면 먼저 작업대를
    //   닫아야 한다. 그 순서를 안내 없이 두면 "장비 칸이 어디 갔지"에서 막힌다.
    // 2026-09-16 (`inventory/parts/Crafting.closeCraftWindow`): 닫기는 제작 열만 접는 것이 아니라 **작업대 창째**
    //   닫는다 — 예전 문구(「장착 장비와 가방이 나타납니다」)는 이제 거짓말이다. 다시 여는 키까지 여기서 적는다.
    hint: '작업대 우측 상단의 닫기를 누르면 작업대 창이 닫힙니다. 이어서 Tab 으로 가방을 엽니다.',
    objectives: [{ id: 'craftClosed', text: '제작 창 닫기' }],
    allow: { craft: [TUTORIAL_GUN_RECIPE, TUTORIAL_AMMO_RECIPE] },
    spot: ['.inv-craft-close', '.inv-panel-craft'],
    spotText: '제작 창 닫기',
  },
  equipGun: {
    id: 'equipGun', title: '만든 소총을 주무기로 장착하세요',
    /*
     * 2026-09-15 3차 (사용자 결정 「제작품은 함선 창고로」) — 만든 소총은 **함선 창고**에 있다. 목표 줄과 완료 판정은
     * 한 줄도 안 바뀌었다(`onLoadout` = 주무기 I · II 어느 쪽이든 그 소총이 들어오면 끝) — 바뀐 것은 **어디서 집어
     * 오는가**뿐이라 안내 문구와 포커싱만 창고까지 넓혔다. 창고 · 가방이 이제 한 패널(`.inv-panel-grids`)이므로
     * 구멍은 여전히 「장비칸 두 개 + 그 옆 격자 카드」 하나로 이어진 사각형이다.
     */
    // 2026-09-16: 작업대 창의 닫기가 창째 닫으므로 이 단계는 **창이 닫힌 채로 시작한다** — Tab 이 앞에 온다
    //   (우측 조작 가이드도 그 한 줄을 띄운다: `model.EQUIP_HINTS`).
    hint: 'Tab 으로 가방을 열고, 함선 창고의 소총을 왼쪽 장착 장비의 주무기 I 또는 II 칸으로 끌어다 놓습니다.',
    /*
     * 2026-09-14 3차 — **제작 창이 열려 있으면 장비 칸이 없다** (`.inv-root.is-craft` 가 숨긴다). 그 상태에서
     * 장비칸+가방을 포커싱하면 가방만 밝고 링이 허공을 두른다. 그래서 「제작 창을 닫는다」가 앞줄이고,
     * 닫혀 있으면 `TutorialSystem` 이 단계에 들어서는 순간 그 줄을 달성으로 적어 다음 줄이 바로 열린다.
     * 스포트라이트도 `craftOpen` 을 따라 닫기 버튼 ↔ 장비칸+가방으로 갈린다 (`TutorialSystem.stepView`).
     */
    /*
     * 2026-09-17 (사용자 결정): **④ Tab 인벤토리 열기 → 돌격소총 장착.** 포커싱은 **딤 없이**(`spotNoDim`). 장착하면 체크만 긋고
     * **인벤토리를 닫을 때까지 조용히 기다린다** — 목표 줄은 없다 (`TutorialSystem.poll`). 예전의 `stowAmmo`(탄약을 가방으로)는
     * 없어졌다. 옛 `equipClose` 줄은 앞 단계가 제작창 닫기로 끝나므로 빠졌다 — 제작 창이 열린 채 들어서는 드문 길(콘솔)만
     * `stepView` 가 닫기 버튼을 먼저 밝힌다.
     */
    objectives: [
      { id: 'equipOpen', text: '{INVENTORY} 인벤토리 열기', spot: [] },
      { id: 'equipSlot', text: '돌격소총 장착', reveal: true },
    ],
    // 직전 단계의 레시피는 그대로 열어 둔다 — 막힌 레시피는 목록에서 사라지므로 작업대가 통째로 비지 않게.
    allow: { craft: [TUTORIAL_GUN_RECIPE, TUTORIAL_AMMO_RECIPE] },
    // 2026-09-08: 주무기 칸 하나만 밝히면 **집을 곳(가방)이 어두운 판 아래** 깔려 드래그를 시작조차 못 했다.
    //   장비 열과 가방은 맞닿아 있으므로(−24 px 이음매) 둘의 합집합이 이어진 도형 하나가 된다.
    // 2026-09-09: 장비 열 전체(`.inv-equip`)가 아니라 **주무기 I · II 칸**(`inventory/ui/parts/SlotPanel.buildSlot` 의
    //   `.inv-slot-primary` · `.inv-slot-primary2`, `data-slot` 도 같다)부터 가방까지만 — 보조무기 · 방탄복 · 가방 칸과
    //   임플란트 칸은 이 단계와 상관없다. 구멍은 여전히 사각형 하나라 두 칸과 가방 패널을 감싸는 최소 사각형이 된다.
    // 2026-09-15 3차: 마지막 칸이 `.inv-panel-bag` → **`.inv-panel-grids`**(창고 + 가방 한 카드) — 소총은 창고에 있다.
    // 2026-09-16: 함선 Tab 이 창고 | 장비 | 가방이 되어 창고가 그 카드 밖(장비 열 왼쪽)이다 → 마지막 칸은 `.inv-panel-stash`.
    spot: ['.inv-root .inv-equip .inv-slot-primary', '.inv-root .inv-equip .inv-slot-primary2', '.inv-panel-stash'],
    spotUnion: true,
    // 2026-09-17 (사용자 결정): 화면 전체 딤은 없다 — 구멍 · 링 · 말풍선만 (`corpseLoot` 과 같다)
    spotNoDim: true,
    spotText: '창고의 소총 → 주무기 I · II 칸',
  },
  openCraft: {
    // (순서에서 제외, 2026-09-09) `TUTORIAL_STEPS` 에 없다 — id 가 계약(`TutorialStepId`)에 남아 있어 표에만 자리를 둔다.
    //   예전에는 장착 다음에 가방의 `제작` 버튼을 밝혀 탄약 제작 창을 다시 열게 했는데, 지금은 소총 · 탄약을 작업대에서
    //   한 번에 만들므로 할 일이 없다. `stepDef('openCraft')` 는 안전하게 이 항목을 돌려주고 `nextStep` 은 null 이다.
    id: 'openCraft', title: '제작 창을 여세요',
    hint: '가방 우측 상단의 제작 버튼을 누르면 제작 창이 열립니다 (작업대를 직접 사용해도 됩니다).',
    objectives: [{ id: 'craftOpened', text: '제작 창 열기' }],
    allow: { craft: [TUTORIAL_GUN_RECIPE, TUTORIAL_AMMO_RECIPE] },
    spot: ['.inv-bag-craft', '.inv-panel-bag'],
    spotText: '제작 창 열기',
  },
  stowAmmo: {
    id: 'stowAmmo', title: '탄약을 가방에 넣으세요',
    hint: '함선 창고의 준중량탄을 가방 격자로 끌어다 놓습니다.',
    objectives: [{ id: 'ammoStowed', text: '준중량탄을 가방으로 이동' }],
    allow: { craft: [TUTORIAL_GUN_RECIPE, TUTORIAL_AMMO_RECIPE] },
    // `equipGun` 과 같은 이유의 합집합 — 집을 곳(창고)과 놓을 곳(가방)이 둘 다 밝아야 드래그가 된다.
    spot: ['.inv-panel-stash', '.inv-panel-bag'],
    spotUnion: true,
    spotText: '준중량탄을 가방으로',
  },
  /*
   * 2026-09-17 (사용자 결정): **⑤ 조종석 이동 → 터미널 작동 → 목표 행성 지정 → (워프 대기) → 발사 슬롯으로 이동 → 탑승 →
   * `{JUMP:hold}` 준비** (옛 `terminal` · `planet` · `travel` · `board`). 워프를 기다리는 줄은 없다 — 「발사 슬롯으로 이동」은 워프가
   * 끝나야(`travelDone`, 목록에 없는 id) 열린다. 포드는 그 줄이 보이는 순간부터 열린다 (목표별 `allow`). 이 트랙 동안
   * 터미널의 `시뮬레이션 훈련장` 버튼과 준비 때의 출격 준비 경고는 감춰진다 (`training` · `launchWarn` 게이트).
   * 레이드가 시작되면(`game:newMission`) 다음 단계다.
   */
  terminal: {
    id: 'terminal', title: '행성을 정하고 출격하세요',
    hint: '조종석 터미널에서 목표 행성을 정하고, 워프가 끝나면 발사 슬롯에 타서 준비합니다.',
    objectives: [
      { id: 'terminalWalk', text: '조종석으로 이동', arrive: true, guide: 'terminal' },
      { id: 'terminalOpen', text: '조종석 터미널 작동', reveal: true, guide: 'terminal' },
      {
        id: 'planetPicked', text: '목표 행성 지정', reveal: true, guide: null,
        spot: ['.hp-travel', '.hub-col.centre', '.menu.hub-menu.fullscreen .frame'], spotText: '행성 이동',
      },
      { id: 'boardWalk', text: '발사 슬롯으로 이동', reveal: true, revealOn: 'travelDone', arrive: true, guide: 'pod', allow: { board: true } },
      { id: 'boardOn', text: '발사 슬롯 탑승', reveal: true, guide: 'pod' },
      { id: 'readyHold', text: '{JUMP:hold} 를 길게 눌러 시작 준비', reveal: true, guide: null },
    ],
    allow: { terminal: true, planet: [PLANET_IDS[0]] },
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
    objectives: [{ id: 'travelDone', text: '행성 도착 대기' }],
    allow: { terminal: true },
  },
  board: {
    id: 'board', title: '발사 슬롯에 탑승하세요',
    hint: '발사 포드로 걸어가 상호작용하면 임무가 시작됩니다.',
    objectives: [
      { id: 'boardWalk', text: '발사 슬롯으로 이동' },
      { id: 'boardOn', text: '발사 슬롯 탑승', reveal: true },
    ],
    arriveObjective: 'boardWalk',
    allow: { terminal: true, board: true },
    guide: 'pod',
  },
  /*
   * 2026-09-18 (사용자 결정): 아래 두 단계(`terminal` · `raid`)는 이제 **출격 안내**(`raid2`) 트랙이다 — id 도 내용도
   * 그대로이고 옮긴 것은 트랙뿐이다 (`shared/tutorial.TUTORIAL_TRACK_STEPS`). 「증축 안내」는 `equipGun` 에서 끝난다.
   */
  /*
   * 2026-09-17 (사용자 결정): **⑥ 레이드 퀘스트** — 이번 레이드에서 얻은 아이템(`raidFound`)의 판매가 합이
   * `TUTORIAL_RAID_EXTRACT_VALUE_C` 이상인 채로 탈출. **기회는 한 번**: 탈출 · 사망 · 포기 어느 쪽이든 그 레이드가 끝나면 트랙이
   * 끝나고, 목표는 조건을 채워 탈출했을 때만 체크된다 (`TutorialSystem.onBuildRaidEnd`). 진행 수는 지금 몸에 지닌 그 합이다.
   * 우측에는 이 레이드에서만 조작 가이드가 뜬다 (`model.RAID_GUIDE_HINTS`, `]` 로 접기).
   */
  raid: {
    id: 'raid', title: '행성에서 전리품을 챙겨 탈출하세요',
    hint: '레이드에서 얻은 아이템을 챙겨 무사히 탈출합니다.',
    objectives: [{
      id: 'raidValue',
      text: `행성에서 가치 ${TUTORIAL_RAID_EXTRACT_VALUE_C.toLocaleString('en-US')} C 이상 아이템을 획득한 후 무사히 탈출`,
      count: TUTORIAL_RAID_EXTRACT_VALUE_C, countUnit: 'C',
    }],
    // 레이드는 그대로 진행된다 — 이 단계에서는 아무것도 막지 않고 아무것도 감추지 않는다.
    allow: {
      roomPurpose: true, furniture: true, manageExit: true, craft: true,
      terminal: true, planet: true, board: true, screenTab: true, stashItem: true,
    },
  },

  /* ══ 2026-09-14 튜토리얼 개편 (docs/DECISIONS.md 「2026-09-14 — 튜토리얼 개편」) ══════════════════════════════════════════════
   * ① raid — 손으로 지은 튜토리얼 행성. 안내할 것이 **UI 가 아니라 손가락**이라 스포트라이트가 거의 없다:
   *    쓰는 키는 우측 조작 가이드(`ui/Controls`, `TUTORIAL_CONTROL_HINTS`)가 그리고, 목표 패널은
   *    "지금 무엇을 하는가"만 말한다.
   *    2026-09-15 (사용자 결정) — 목표는 **짧은 명사구**이고, 키를 말하는 줄은 **키캡 토큰**(`{QUICK:hold}` …)을 쓴다.
   *    예전의 「문구에 키 글자를 적지 않는다」는 글자를 박아 두면 리바인드에 거짓말이 되기 때문이었는데, 토큰은
   *    그릴 때 `Keys` 에서 풀리고 리바인드하면 다시 그려지므로 그 걱정이 없다 (`shared/keycap.renderKeyText`).
   * ② ship — 함선 첫 진입. 레벨 · 능력치는 전부 기존 화면이라 **스포트라이트로 가리키기만** 한다 (2026-09-16: 메신저 단계 제외).
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
  /*
   * 2026-09-15 2차 (사용자 결정) — 목표 문구가 **「앞으로 이동」**이다. 구간과 구간 사이의 `advance1`·`2`·`3` 이
   * 이미 그 문장이고, 첫 걸음만 「갈라진 땅까지 이동」이면 같은 일에 이름이 둘이 된다 (그리고 그 땅은 아직
   * 보이지도 않는다 — 어디까지 가야 하는지는 걸어가 보면 알게 된다).
   */
  move: {
    id: 'move', title: '주변을 둘러보고 걸어가세요',
    hint: '마우스로 시선을 돌리고, 이동 키로 앞으로 걸어갑니다.',
    objectives: [{ id: 'walkCliff', text: '앞으로 이동' }],
  },
  sprintJump: {
    id: 'sprintJump', title: '달려서 뛰어넘으세요',
    hint: '달리기를 누른 채 속도를 붙여 점프해야 건너갑니다. 서서 뛰면 닿지 않습니다.',
    objectives: [{ id: 'jumpGap', text: '{SPRINT:hold} 달리며 {JUMP} 점프로 갈라진 땅 건너기' }],
  },
  /*
   * 2026-09-15 2차 (사용자 결정) — **시체 상호작용.** 전에는 절벽을 넘자마자 곧장 「기관단총을 주무기 칸에 장착」이
   * 떴다: 아직 시체를 열지도 않았는데 그 안의 물건을 옮기라고 한다 (`supplyLoot` 을 넣은 것과 같은 눈이다 —
   * 「줍기도 전에 쓰라고 하지 않는다」). 그래서 시체 앞에 서면 먼저 이 한 줄이고, **시체 가방이 열리면**
   * `corpseLoot` 이다 (`TutorialSystem.onContainerOpened` — `corpse:` 로 시작하는 컨테이너).
   *
   * 스포트라이트가 없다 — 할 일이 화면이 아니라 **월드의 시체**라 밝힐 DOM 이 없다. 대신 3D 목표 마커
   * (`parts/Marker`)가 `corpseLoot` 과 **똑같이** 그 시체 위에 선다.
   */
  corpseOpen: {
    id: 'corpseOpen', title: '쓰러진 대원을 살펴보세요',
    hint: '앞에 쓰러진 대원이 있습니다. 다가가 상호작용하면 그 사람의 가방이 열립니다.',
    objectives: [{ id: 'corpseInteract', text: '{INTERACT} 시체 상호작용' }],
  },
  corpseLoot: {
    id: 'corpseLoot', title: '쓰러진 대원의 장비를 챙기세요',
    hint: '열린 가방에서 무기를 주무기 칸에 끌어다 놓습니다. 가방 · 탄약도 함께 챙길 수 있습니다.',
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
      { id: 'corpseGun', text: '기관단총을 주무기 칸에 장착' },
      { id: 'corpseBag', text: '가방을 장비 칸에 장착', optional: true },
      { id: 'corpseAmmo', text: '탄약 챙기기', optional: true },
    ],
    // 장비 칸 ↔ 시체 격자에 걸친 드래그라 합집합으로 밝힌다 (`equipGun` 과 같은 이유).
    // ⚠ 격자 타일에는 def id 가 없고 `data-uid` 뿐이라(`inventory/ui/GridView`) 총 한 칸만 고르는 선택자가
    //   없다 — 구멍은 「시체 격자 ~ 주무기 칸」, 즉 드래그 경로 전체다. 드래그를 시작하면 받을 수 있는 칸이
    //   초록으로 켜지는 것은 인벤토리가 이미 한다 (`.inv-slot.is-target-ok`).
    // 2026-09-15 (사용자 결정): 구멍을 **방탄복 칸까지** 넓힌다 (`inventory/ui/parts/SlotPanel.buildSlot` 의
    //   `inv-slot-${slot}` — `LOADOUT_SLOTS` 의 `armor`). 창을 곧바로 닫으면 포커싱은 풀린다 (`TutorialSystem.corpseFocusOff`).
    spot: [
      '.inv-panel-container', '.inv-root .inv-equip .inv-slot-primary', '.inv-root .inv-equip .inv-slot-primary2',
      '.inv-root .inv-equip .inv-slot-armor',
    ],
    spotUnion: true,
    // 2026-09-14 2차 (사용자 결정): 이 단계만 **딤이 없다** — 시체 격자 · 장비 칸 말고도 볼 것이 많고,
    //   어두운 판이 화면 절반을 덮으면 처음 여는 인벤토리 화면을 읽을 수가 없다.
    spotNoDim: true,
    // 2026-09-16 (사용자 결정): 옮기는 **방법**을 말한다 — 좌클릭 드래그 · 더블클릭 키캡 (`{MOUSE_LEFT}` · `{DOUBLE_CLICK}` 은
    //   리바인드와 무관한 고정 토큰, `shared/keycap.KEYCAP_FIXED_TOKENS` — 더블클릭 키캡은 키 가이드의 것과 같은 모양이다)
    spotText: '아이템을 {MOUSE_LEFT} 드래그 또는 {DOUBLE_CLICK}해서 장착 칸으로 이동',
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
    objectives: [{ id: 'advance1Walk', text: '앞으로 이동' }],
  },
  advance2: {
    id: 'advance2', title: '앞으로 나아가세요',
    hint: '길을 따라 앞으로 이동합니다.',
    objectives: [{ id: 'advance2Walk', text: '앞으로 이동' }],
  },
  advance3: {
    id: 'advance3', title: '앞으로 나아가세요',
    hint: '길을 따라 앞으로 이동합니다.',
    objectives: [{ id: 'advance3Walk', text: '앞으로 이동' }],
  },
  shoot: {
    id: 'shoot', title: '벌레를 처치하세요',
    hint: '정조준하면 탄이 덜 퍼집니다. 둘 다 쓰러뜨리면 다음으로 넘어갑니다.',
    // 2026-09-15 2차 (사용자 결정): 수는 문구에 적지 않고 **`count` 로 넘긴다** — 패널이 뒤에 `(n/m)` 을 붙이고
    //   처치할 때마다 그 숫자만 갱신한다. 목표 수의 원본은 `RAID_KILLS_PER_STEP` 하나다.
    objectives: [{ id: 'killBugs', text: '벌레 처치', count: RAID_KILLS_PER_STEP }],
  },
  crouch: {
    id: 'crouch', title: '앉아서 낮은 틈을 지나세요',
    hint: '선 채로는 들어가지 않습니다. 앉기 키로 자세를 낮추세요.',
    objectives: [{ id: 'crouchGap', text: '{CROUCH} 앉기 · {PRONE} 포복으로 낮은 틈 통과' }],
  },
  crouchAim: {
    id: 'crouchAim', title: '앉은 채로 조준해 안드로이드를 처치하세요',
    hint: '앉으면 조준 흔들림이 크게 줄어듭니다 — 먼 표적일수록 차이가 납니다.',
    objectives: [{ id: 'killAndroids', text: '안드로이드 처치', count: RAID_KILLS_PER_STEP }],
  },
  drop: {
    id: 'drop', title: '아래로 뛰어내리세요',
    hint: '높은 곳에서 떨어지면 다칩니다. 여기서는 죽지는 않습니다.',
    objectives: [{ id: 'dropDown', text: '아래로 뛰어내리기' }],
  },
  /*
   * 2026-09-15 (사용자 결정) — **보급품 시체 루팅.** `supply` 체크포인트가 여는 단계다 (전에는 곧장 `heal` 이라
   * 붕대를 줍기도 전에 「붕대 사용」이 떴다). 두 줄이 함께 보이고 — 필수 「붕대 획득」 · 선택 「수류탄 획득」 —
   * 가방에 붕대가 들어오면 필수가 체크된다 (`TutorialSystem.onInventory`, 튜토리얼 레이드는 빈손으로 시작하고 첫
   * 시체에는 회복 아이템이 없으므로 「가방 · 빠른 사용 칸에 회복 아이템이 있다」 = 그 시체에서 얻었다).
   * 붕대를 얻은 뒤 **창을 닫으면** `heal` 이다. 줍지 않고 `wall` 까지 가면 `heal` 까지 함께 건너뛴다.
   */
  supplyLoot: {
    id: 'supplyLoot', title: '보급품 시체를 뒤지세요',
    hint: '시체에서 붕대를 꺼내고 창을 닫습니다.',
    objectives: [
      { id: 'supplyBandage', text: '시체에서 붕대 획득' },
      { id: 'supplyGrenade', text: '시체에서 수류탄 획득', optional: true },
    ],
  },
  heal: {
    id: 'heal', title: '보급품을 챙기고 회복하세요',
    hint: '주운 회복 아이템은 빠른 사용 칸에 올려야 꺼낼 수 있습니다. 꺼낸 뒤 길게 눌러 쓰세요.',
    // 2026-09-14 2차 (사용자 결정): 체력이 이미 가득이면 이 단계는 조용히 지나친다 (`TutorialSystem.setStep`).
    /*
     * 2026-09-14 4차 (사용자 결정) — 「붕대를 빠른 사용 칸에 올린다」(`healStock`) 삭제: 붕대 · 수류탄은 주우면
     * **빈 휠 칸에 자동 등록**된다. 남는 것은 **손에 드는 것**과 **쓰는 것** 둘이다.
     *
     * 2026-09-15 (사용자 결정) — ① 두 줄이 **순차 공개**다: 붕대를 손에 들어야 「붕대 사용」이 나타난다.
     * ② 줄 안에 **키캡**이 들어간다 (`{QUICK:hold}` · `{FIRE:hold}`). ③ 선택 목표 「수류탄을 챙긴다」
     * (`healGrenade`)는 삭제 — 보급품 시체 단계(`supplyLoot`)의 「시체에서 수류탄 획득」으로 옮겨 갔다.
     */
    objectives: [
      { id: 'healHold', text: '{QUICK:hold} 길게 눌러 붕대 장착' },
      { id: 'healUse', text: '{FIRE:hold} 길게 눌러 붕대 사용', reveal: true },
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
      // 2026-09-15: 무너진 벽은 사선 방벽이 됐다 — 다른 구간과 같은 「앞으로 이동」 (사용자 결정)
      { id: 'wallPass', text: '앞으로 이동' },
      { id: 'grenadeThrow', text: '{QUICK:hold} 수류탄 장착 후 {FIRE:hold} 투척', optional: true },
    ],
  },
  extract: {
    id: 'extract', title: '버려진 함선으로 탈출하세요',
    hint: '함선 안의 스위치를 누르면 곧바로 이륙합니다. 그 함선이 앞으로 당신의 함선입니다.',
    objectives: [{ id: 'extractSwitch', text: '{INTERACT:hold} 함선 스위치 작동' }],
    // 레이드가 끝나는 단계다 — 아무것도 막지 않는다 (build 트랙의 `raid` 와 같은 처리).
    allow: {
      roomPurpose: true, furniture: true, manageExit: true, craft: true,
      terminal: true, planet: true, board: true, screenTab: true, stashItem: true,
    },
  },
  /* ── ② ship — 함선 첫 진입 ── */
  /*
   * (순서에서 제외, 2026-09-16 2차 — 사용자 결정) `TUTORIAL_TRACK_STEPS.ship` 에 없다. 「인벤토리 화면 열기」는 `stats` 의 첫 목표
   * (`statsMenu`)가 됐고, 옛 저장의 `levelUp` 은 `normalizeStep` 이 `stats` 로 옮긴다. 아래는 순서에 있던 때의 모습이다.
   */
  levelUp: {
    id: 'levelUp', title: '레벨이 올랐습니다',
    // 넘어가는 신호는 `inventory:opened` 하나다 — 인벤토리 화면이 열리면 그 안의 캐릭터 탭은 다음 단계가 밝힌다.
    hint: '임무 보상으로 능력치 포인트가 생겼습니다. 인벤토리 화면을 여세요.',
    objectives: [{ id: 'levelScreen', text: '인벤토리 화면 열기' }],
    allow: { screenTab: ['character'] },
    // `.scr-tab` 에는 탭마다의 표식이 없다 — 지금 보이는 탭이 인벤토리 · 캐릭터 둘뿐이라 탭 줄 전체를 밝힌다.
    spot: ['.inv-root .scr-tabs', '.inv-root'],
    spotText: '캐릭터 탭',
  },
  /*
   * 2026-09-16 2차 (사용자 결정) — **함선 트랙의 유일한 단계.** 목표 넷이 하나씩 열린다 (순차 공개 `reveal`):
   *   ① `statsMenu`  메뉴(Tab 창) 열기 — 우측 조작 가이드에 `{INVENTORY}` 한 줄 (`model.TUTORIAL_CONTROL_HINTS.stats`)
   *   ② `statsTab`   캐릭터 탭으로 이동 — 스포트라이트는 탭 줄의 캐릭터 탭
   *   ③ `statsRaise` 능력치 하나 ＋ — 스포트라이트는 능력치 열 (`progress:statPending` 으로 판정)
   *   ④ `statsSpent` 투자 확정 (1초 홀드) — 스포트라이트는 `되돌리기 · 포인트 투자 확정` 줄
   * ①② 는 화면 상태를 `poll` 이 보고, 어떤 목표에 무엇을 밝힐지는 `TutorialSystem.stepView` 가 고른다 (화면 상태에 따라 갈린다).
   * 확정하는 순간 포커싱이 걷히고 트랙이 **그 자리에서** 끝난다 (`onStatsConfirmed`). `statsSpent` id 는 옛 저장 호환으로 그대로다.
   * 아래 `spot` · `spotText` 는 ③ 의 모습 — 화면 상태를 모를 때(`stepView` 가 가르기 전)의 기본값이다.
   */
  stats: {
    id: 'stats', title: '능력치에 포인트를 투자하세요',
    hint: '임무 보상으로 능력치 포인트가 생겼습니다. 메뉴를 열고 캐릭터 탭에서 ＋ 로 나눠 담은 뒤 포인트 투자 확정을 1초간 누릅니다.',
    objectives: [
      { id: 'statsMenu', text: '{INVENTORY} 메뉴 열기' },
      { id: 'statsTab', text: '캐릭터 탭으로 이동', reveal: true },
      { id: 'statsRaise', text: '능력치 하나 상승', reveal: true },
      { id: 'statsSpent', text: '능력치 투자 확정', reveal: true },
    ],
    allow: { screenTab: ['character'] },
    spot: SPOT_STATS_RAISE,
    spotText: STATS_RAISE_TEXT,
  },
  messenger: {
    id: 'messenger', title: '메신저를 여세요',
    /*
     * (순서에서 제외, 2026-09-16 — 사용자 결정) `TUTORIAL_TRACK_STEPS.ship` 에 없다 — `openCraft` · `ravenQuest` 와 같은 처리로 표에만
     * 남는다. 레벨업 포인트를 나눠 준 뒤 메신저 창으로 끌고 가는 단계를 없앴다: 함선 트랙은 `stats` 에서 끝나고 (화면을 닫을 때 —
     * `TutorialSystem.onStatsConfirmed`), 옛 저장의 `messenger` 는 `retiredTrackEnd` 가 「함선 트랙 끝」으로 읽는다.
     * 아래는 순서에 있던 때의 기록이다.
     *
     * 2026-09-15 (사용자 결정) — 함선 트랙의 **마지막 단계**다. 예전 문구 「읽지 않은 연락이 와 있습니다」는 거짓말이 된다:
     * 레이븐의 첫 연락은 이제 이 트랙이 끝난 뒤에 온다 (`meta/parts/NpcQuests.tutorialBlocks`). 그래서 「어디에 무엇이
     * 오는가」만 말한다. 열리는 순간 트랙이 끝나고(`ui:messengerToggled {open:true}` → `advance` → `finish`) 증축 트랙이
     * 곧바로 이어진다 — 그 트랙은 메신저를 다시 감추므로 열려 있던 창은 닫힌다 (현재 동작).
     */
    hint: '우측 상단의 메신저 버튼을 누릅니다. NPC 의 연락과 의뢰는 여기로 옵니다.',
    objectives: [{ id: 'messengerOpen', text: '메신저 열기' }],
    allow: { community: true },
    /*
     * 2026-09-15 (E-12, smoke-tutorial-ship) — **`.show` 가 붙은 버튼만** 밝힌다. `stats` 는 인벤토리 창 안에서 끝나므로
     * 이 단계는 대개 창이 열린 채 시작하는데, 그동안 `.community` 는 blocker 때문에 `opacity: 0` 으로만 접혀 사각형이
     * 그대로 남는다 — `Spotlight.firstShown` 이 그것을 「보인다」로 읽어 **투명한 버튼에 링을 두르고** 창 전체를 딤으로 덮었다.
     * 창을 닫으면 `.show` 가 붙고 그때 반 박자 뒤에 켜진다.
     */
    spot: ['.community.show .cm-btn', '.community.show'],
    spotText: '메신저',
  },
  /*
   * (순서에서 제외, 2026-09-15 — 사용자 결정) `TUTORIAL_TRACK_STEPS.ship` 에 없다 — `openCraft` 와 같은 처리로 표에만 남는다.
   * 레이븐의 첫 연락은 함선 트랙이 끝난 뒤에 오므로 이 단계가 기다릴 것이 없어졌다. 옛 저장의 `ravenQuest` 는
   * 2026-09-16 부터 `messenger` 와 함께 `retiredTrackEnd` 가 「함선 트랙 끝」으로 읽는다 (옮겨 붙을 순서 안의 단계가 없다).
   */
  ravenQuest: {
    id: 'ravenQuest', title: '레이븐의 의뢰를 받으세요',
    hint: '대답을 고르고 퀘스트 카드의 수락을 누릅니다.',
    objectives: [
      { id: 'ravenTalk', text: '레이븐의 연락에 답장' },
      { id: 'ravenAccept', text: '퀘스트 수락' },
    ],
    allow: { community: true },
    // 2026-09-15 (E-12): 대화 페이지의 클래스는 `.ms-page.chat` 이다 (탭 id `chat`) — `.chats` 는 아무것도 못 찾아 틀 전체로 흘렀다
    spot: ['.ms-qcard', '.ms-page.chat', '.ms-frame'],
    spotText: '레이븐의 첫 연락',
  },
};

/** 단계 정의. 순서에서 빠진 id(`openCraft` · `ravenQuest`)도 표에 있으므로 언제나 정의를 돌려준다. */
export const stepDef = (id: TutorialStepId): StepDef => STEP_DEFS[id];

/**
 * 그 단계가 속한 트랙의 순서 배열 (2026-09-14). 진행률 · 다음 단계는 **자기 트랙 안에서만** 센다 —
 * 트랙마다 목표 패널도 건너뛰기도 따로이기 때문이다. 트랙을 모르는 id(`openCraft` · `ravenQuest`)는 build 로 본다
 * (둘 다 `normalizeStep` 이 먼저 순서 안의 단계로 옮기므로 실제로 여기까지 오지 않는다).
 */
export const trackStepsOf = (id: TutorialStepId): readonly TutorialStepId[] =>
  TUTORIAL_TRACK_STEPS[tutorialTrackOf(id) ?? 'build'];

/** 그 단계의 트랙 (모르는 id 는 build — `openCraft` · `ravenQuest`). */
export const trackOf = (id: TutorialStepId): TutorialTrack => tutorialTrackOf(id) ?? 'build';

/** 순서에 있는 단계인가 — **세 트랙 전부**를 본다 (`openCraft` 처럼 계약에만 남은 id 를 거른다). */
export const isOrderedStep = (id: string): id is TutorialStepId =>
  tutorialTrackOf(id as TutorialStepId) !== null;

/**
 * 저장 · 콘솔에서 들어온 id 를 순서 안의 단계로 고친다 (2026-09-09). 순서에서 빠진 단계는 **그 자리를 이어받은**
 * 단계로 옮겨 붙는다 — 진행 중이던 저장이 새 순서에서도 막히지 않고 이어진다. 모르는 값은 null.
 *
 * `openCraft`(2026-09-09) → `craftAmmo`. `ravenQuest`(2026-09-15) · `messenger`(2026-09-16) → **null** — 둘 다 함선 트랙의
 *   마지막 자리였고 그 뒤를 이을 단계가 없다. 그 저장은 `retiredTrackEnd` 가 「그 트랙은 끝났다」로 읽는다 (`TutorialSystem.load`).
 * ⚠ 셋 다 `TutorialStepId` 와 위 `STEP_DEFS` 표에는 **남아 있다** (계약은 이름을 지우지 않는다) — 빠진 것은
 *   `TUTORIAL_TRACK_STEPS` 의 **순서**뿐이다. 그래서 `tutorialTrackOf` 가 null 을 돌려주고 `trackOf` 가 build 로 본다.
 * `manageDone` 은 2026-09-14 3차 → 2026-09-15 사이에만 여기서 `craftGun` 으로 옮겨졌다 — 순서로 돌아왔으므로
 *   이제 `isOrderedStep` 이 그대로 통과시킨다 (그 사이의 저장은 `craftGun` 을 들고 있으니 옮길 것이 없다).
 */
export function normalizeStep(id: string | null | undefined): TutorialStepId | null {
  if (typeof id !== 'string') return null;
  // 2026-09-17: 증축 트랙이 7 단계로 묶였다 — 빠진 단계는 자기를 삼킨 단계로 (`RETIRED_BUILD`)
  const grouped = RETIRED_BUILD[id];
  if (grouped) return grouped.step;
  // 2026-09-16 2차: 「메뉴 열기」는 `stats` 의 첫 목표가 됐다 — 그 자리에 서 있던 저장은 `stats` 를 처음부터 한다
  if (id === 'levelUp') return 'stats';
  return isOrderedStep(id) ? id : null;
}

/**
 * 2026-09-17 (사용자 결정 — 증축 트랙 17 → 7 단계): 순서에서 빠진 증축 단계 → **그것을 삼킨 단계**와 그 자리에 서 있던 사람이
 * **이미 한 목표**. 옛 저장이 새 단계의 첫 줄부터 다시 하지 않게 `TutorialSystem.load` 가 목표를 채워 넣는다.
 * (`openCraft` 는 2026-09-09 부터 `craftAmmo` 로 옮겨졌고, 이제 그 `craftAmmo` 도 `craftGun` 에 들어갔다.)
 * `stowAmmo` 는 할 일이 없어진 단계라 다음 단계(`terminal`)의 처음이다.
 */
const RETIRED_BUILD: Readonly<Record<string, { step: TutorialStepId; done: readonly string[] }>> = {
  generator: { step: 'manage', done: ['manageOpen'] },
  workshop: { step: 'manage', done: ['manageOpen', 'generatorOn'] },
  benchPlace: { step: 'bench', done: ['benchCrafted'] },
  manageDone: { step: 'bench', done: ['benchCrafted', 'benchStore', 'benchDown'] },
  craftAmmo: { step: 'craftGun', done: ['craftGunWalk', 'craftGunOpen', 'craftGunMade'] },
  openCraft: { step: 'craftGun', done: ['craftGunWalk', 'craftGunOpen', 'craftGunMade'] },
  openBag: { step: 'craftGun', done: ['craftGunWalk', 'craftGunOpen', 'craftGunMade', 'craftAmmoMade'] },
  stowAmmo: { step: 'terminal', done: [] },
  planet: { step: 'terminal', done: ['terminalWalk', 'terminalOpen'] },
  travel: { step: 'terminal', done: ['terminalWalk', 'terminalOpen', 'planetPicked'] },
  board: { step: 'terminal', done: ['terminalWalk', 'terminalOpen', 'planetPicked', 'travelDone'] },
};

/** 옛 증축 단계 id 면 그 자리에서 이미 한 목표 (새 단계 기준), 아니면 null. */
export function retiredObjectives(id: string | null | undefined): readonly string[] | null {
  return typeof id === 'string' ? RETIRED_BUILD[id]?.done ?? null : null;
}

/**
 * 순서에서 빠진 **트랙의 마지막 자리** → 그 트랙 (2026-09-16). 저장에 이 id 가 남아 있으면 그 사람은 트랙의 끝에 서 있던 것이므로
 * 이어 붙일 단계 대신 「끝났다」로 읽는다 — `stats` 로 되돌리면 이미 쓴 포인트를 다시 투자하라는 막다른 길이 된다.
 */
const RETIRED_TRACK_END: Readonly<Record<string, TutorialTrack>> = { messenger: 'ship', ravenQuest: 'ship' };

/** 저장에 남은 id 가 순서에서 빠진 트랙의 마지막 자리면 그 트랙, 아니면 null. */
export function retiredTrackEnd(id: string | null | undefined): TutorialTrack | null {
  return typeof id === 'string' ? RETIRED_TRACK_END[id] ?? null : null;
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
