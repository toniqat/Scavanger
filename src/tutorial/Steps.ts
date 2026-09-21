import type { TutorialStepId, TutorialTrack } from '@/shared';
import { PLANET_IDS, TUTORIAL_RAID_EXTRACT_VALUE_C, TUTORIAL_TRACK_STEPS, tutorialTrackOf } from '@/shared';
import {
  RAID_KILLS_PER_STEP, SPOT_STATS_RAISE, STATS_RAISE_TEXT, TUTORIAL_AMMO_RECIPE, TUTORIAL_BENCH_DEF, TUTORIAL_GUN_RECIPE, TUTORIAL_ROOM_PURPOSE,
  type StepDef,
} from './model';

/* ────────────────────────────────────────────────────────────────────────────
 * src/tutorial/Steps.ts — **the step table**. It records only what each step shows and what it allows. What moves on
 * to the next step (the advance condition) is in `TutorialSystem.onEvent`'s switch — the condition differs per event,
 * so putting them in a table would only read worse.
 *
 * Every gate **not** in `allow` is blocked (user's decision: enforce the order strictly). `community` and `screenTab`
 * (other than the inventory) are in no step at all, so they stay locked for the whole tutorial. `stashItem` (hiding
 * stash items) is a step-independent allow list (`TUTORIAL_STASH_WHITELIST`) that `parts/Gates` judges itself — only
 * `raid` opens everything.
 * ──────────────────────────────────────────────────────────────────────────── */

const STEP_DEFS: Readonly<Record<TutorialStepId, StepDef>> = {
  intro: {
    id: 'intro', title: '함선에 오신 것을 환영합니다',
    hint: '안내를 읽고 시작하세요.',
    // 2026-09-15: an objective row is a noun phrase, not a sentence — even a step where `hint` used to be the
    //   objective gets a short row too
    objectives: [{ id: 'introRead', text: '시작 안내 확인' }],
  },
  /*
   * 2026-09-17 (user's decision — 「여러 스텝을 하나의 스텝 내 여러 목표로」): **① ship management → build the workshop** is one step
   * (old `manage` · `generator` · `workshop`). The objectives reveal in sequence, and the focus · the floor guide
   * belong to the **current objective** (`model.currentObjective`). The 「발전기 가동」 row stands only where the generator
   * is Lv.0 — a new ship is Lv.1 from the start, so `TutorialSystem.objectivesFor` drops that row from the list (the
   * same as the old `generator` step's silent pass). The one signal that advances is the workshop build.
   */
  manage: {
    id: 'manage', title: '빈 방을 작업실로 증축하세요',
    hint: '시설 관리 키를 눌러 함선 관리 화면을 열고, 빈 방을 작업실로 증축합니다.',
    objectives: [
      {
        id: 'manageOpen', text: '{MAP} 시설 관리 열기',
        // 2026-09-08: with nothing open there was no screen to light — it points at the `시설 관리` key hint that always
        //   sits bottom right
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
    // The workshop is open from the start — so the purpose list does not shift every time the row changes
    //   (`ui/hud/ShipManage` redraws by step id only)
    allow: { roomPurpose: [TUTORIAL_ROOM_PURPOSE] },
    spot: ['.ship-hint'],
    spotText: '시설 관리 {MAP}',
  },
  /* 2026-09-13 (user's decision — power allocation removed): a new ship's generator is Lv.1 from the start, so
     this step is always passed silently by `TutorialSystem.setStep`. Only ships with a Lv.0 generator are gone;
     the step id is contract (`TUTORIAL_STEPS`) and stays. */
  generator: {
    id: 'generator', title: '발전기를 가동하세요',
    hint: '시설 증축에는 발전기 Lv.1 이 필요합니다. 방 목록 아래의 발전기를 가동하세요.',
    objectives: [{ id: 'generatorOn', text: '발전기 가동' }],
    // The workshop is left open too — the moment the generator turns on this moves to the next step, so the list does
    //   not shift.
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
   * 2026-09-17 (user's decision): **② craft the gun workbench → the furniture store tab → place the furniture → close
   * housing mode** (old `bench` · `benchPlace` · `manageDone`). The furniture craft is the centre modal's
   * (`.sm-craft`) **1 s hold** button (`.sm-craft-ok`) — with the modal up it lights that button, else the card (the
   * first one found). 「가구 창고 탭」 is `TutorialSystem.poll` reading whether the tab button is on. While furniture is
   * held on the cursor the focus folds — a dim plate must not cover the floor it goes down on (`benchArmed`). A
   * placement that ends with housing mode already closed leaves the last row nothing to do, so it passes straight on
   * (the old `manageDone`'s silent pass).
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
        // The `Tab 닫기` entry the bottom-right key guide (`ui/hud/KeyGuide`) appends itself while management mode is
        //   on
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
    // 2026-09-14 3rd pass: 「picking it up → putting it down」 is two actions, so the rows are two as well (sequential
    //   reveal).
    objectives: [
      { id: 'benchPick', text: '가구 창고에서 총기 작업대 선택' },
      { id: 'benchDown', text: '작업실 바닥에 배치', reveal: true },
    ],
    allow: { furniture: [TUTORIAL_BENCH_DEF] },
    // If the store tab is not open yet it lights that tab button — the tab itself used to sit under a dim plate and
    //   could not be clicked.
    spot: ['.sm-store .fcard[data-def-id="furn_bench_gun"]', '.sm-tabs .sm-tab[data-tab="store"]', '.sm-side'],
    spotText: '가구 창고 → 총기 작업대',
  },
  /*
   * 2026-09-14 3rd pass (user's decision) — it had dropped out of the order: a step that only says 「close it」 was
   * seen as having no reason to stand.
   * 2026-09-15 (user's decision — reversed) — **it is back in the order.** It sits right before 「작업실로 이동」
   * (`craftGun`'s first row): the workshop cannot be walked to while management mode is open, yet the guide told the
   * player to walk there, and the floor guide was laid under the management camera too. So this step closes it first,
   * and the floor guide is **drawn in no step at all** while management mode is open (`TutorialSystem.refreshVisuals`
   * — `ctx.housing.shipManageMode` · `housingMode`). Entering this step with management mode already closed (console
   * · save restore) leaves nothing to do, so `setStep` passes it silently (the same trick as `generator`).
   */
  manageDone: {
    id: 'manageDone', title: '하우징 모드를 닫으세요',
    hint: '화면 우측 아래 키 가이드의 닫기 키(Tab)를 누르면 하우징 모드를 빠져나옵니다 (M · C 도 됩니다).',
    objectives: [{ id: 'manageClose', text: '{INVENTORY} 하우징 모드 닫기' }],
    // The workbench stays allowed — a blocked entry vanishes from the list, so the card being looked at a moment ago
    //   does not go blank.
    allow: { manageExit: true, furniture: [TUTORIAL_BENCH_DEF] },
    // 2026-09-09: lights the key guide (`ui/hud/KeyGuide`, `.key-guide`) that sits bottom right while management mode
    //   is on — the `Tab 닫기` entry the guide appends itself at the far right (`.kg-close`) first, else the whole
    //   guide row. The guide is `pointer-events:none` and at z 84, so it floats over the dim plate (78) — the ring
    //   goes around it.
    spot: ['.key-guide .kg-close', '.key-guide'],
    spotText: 'Tab — 하우징 모드 닫기',
  },
  /*
   * 2026-09-09 — the craft flow is **one visit to the workbench**: the rifle → (in the same window) the ammo → close
   * the window → equip → the ammo into the bag. So `craftGun` through `stowAmmo` allow **both** the rifle and the
   * ammo recipe — a blocked recipe vanishes from the list (`hides`), so the rifle row dropping out and the ammo row
   * popping up the instant the rifle is made would shift the list. Which one is next to make is what the spotlight
   * points at.
   */
  /*
   * 2026-09-17 (user's decision): **③ walk to the workshop → work the bench → the assault rifle → the medium ammo →
   * close the craft window** (old `craftGun` · `craftAmmo` · `openBag`). The ammo's materials are topped up the
   * moment the rifle is finished (`TutorialSystem.onCrafted` → `ensureMaterials`). Closing closes the whole workbench
   * window (`inventory/parts/Crafting.closeCraftWindow`) — that is where this step ends. The two walking rows have no
   * spotlight (there is no window yet) and the floor guide points at the bench; the rows inside the window have no
   * floor guide.
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
    // The workbench stays allowed so that reopening management mode (console · save restore · someone going back)
    //   never leaves the furniture cards blank (the same reason as `manageDone`). Since 2026-09-15 `manageDone` comes
    //   first, so this is normally entered closed.
    allow: { craft: [TUTORIAL_GUN_RECIPE, TUTORIAL_AMMO_RECIPE], furniture: [TUTORIAL_BENCH_DEF], manageExit: true },
    /* 2026-09-15 3rd pass (craft UI rework): the picked recipe's **detail** is `.inv-craft-row`, so with that
       recipe picked it lights the hold button, and otherwise the **recipe list cell** (`.inv-craft-cell`) that has
       to be clicked — `spot` is a fallback list, the first match wins. */
    spot: [`.inv-craft-row[data-recipe="${TUTORIAL_GUN_RECIPE}"] .inv-craft-btn`, `.inv-craft-cell[data-recipe="${TUTORIAL_GUN_RECIPE}"]`, '.inv-panel-craft'],
    spotText: '돌격소총 제작',
    guide: 'bench',
  },
  craftAmmo: {
    id: 'craftAmmo', title: '준중량탄을 만드세요',
    // Right after the rifle, with the **same workbench window** still open. Missing materials are topped up by
    //   `ensureMaterials` on entering this step.
    hint: '같은 작업대에서 준중량탄 제작을 1초간 누릅니다. 재료는 튜토리얼이 채워 둡니다.',
    objectives: [{ id: 'craftAmmoMade', text: '준중량탄 제작' }],
    allow: { craft: [TUTORIAL_GUN_RECIPE, TUTORIAL_AMMO_RECIPE] },
    // 2026-09-10: `bulk_ammo_medium` (bulk crafting) disappeared in the big craft rework, so this moved to
    //   `make_ammo_medium`. The selector is built from `TUTORIAL_AMMO_RECIPE` — writing the id out by hand twice goes
    //   out of step again next time.
    /* 2026-09-15 3rd pass (craft UI rework): the picked recipe's **detail** is `.inv-craft-row`, so with that
       recipe picked it lights the hold button, and otherwise the **recipe list cell** (`.inv-craft-cell`) that has
       to be clicked — `spot` is a fallback list, the first match wins. */
    spot: [`.inv-craft-row[data-recipe="${TUTORIAL_AMMO_RECIPE}"] .inv-craft-btn`, `.inv-craft-cell[data-recipe="${TUTORIAL_AMMO_RECIPE}"]`, '.inv-panel-craft'],
    spotText: '준중량탄 제작',
    guide: 'bench',
  },
  openBag: {
    id: 'openBag', title: '제작 창을 닫고 가방을 여세요',
    // 2026-09-08: the equipment slots are hidden while crafting (`.inv-root.is-craft`) — equipping the crafted weapon
    //   means closing the workbench first. Left unexplained, that order strands the player on "where did the
    //   equipment slots go".
    // 2026-09-16 (`inventory/parts/Crafting.closeCraftWindow`): closing does not just fold the craft column, it
    //   closes the **whole workbench window** — the old wording (「장착 장비와 가방이 나타납니다」) is a lie now. The key that
    //   reopens it is written here too.
    hint: '작업대 우측 상단의 닫기를 누르면 작업대 창이 닫힙니다. 이어서 Tab 으로 가방을 엽니다.',
    objectives: [{ id: 'craftClosed', text: '제작 창 닫기' }],
    allow: { craft: [TUTORIAL_GUN_RECIPE, TUTORIAL_AMMO_RECIPE] },
    spot: ['.inv-craft-close', '.inv-panel-craft'],
    spotText: '제작 창 닫기',
  },
  equipGun: {
    id: 'equipGun', title: '만든 소총을 주무기로 장착하세요',
    /*
     * 2026-09-15 3rd pass (user's decision 「제작품은 함선 창고로」) — the crafted rifle sits in the **ship stash**. The
     * objective rows and the completion check did not change by one line (`onLoadout` = done once that rifle lands in
     * 주무기 I or II) — what changed is only **where it is picked up from**, so the wording and the focus were widened
     * as far as the stash. The stash · the bag are one panel now (`.inv-panel-grids`), so the hole is still one
     * connected rectangle, 「the two equipment slots + the grid card beside them」.
     */
    // 2026-09-16: the workbench window's close closes the whole window, so this step **starts with the window
    //   closed** — Tab comes first (the control guide on the right shows that one row too:
    //   `model.TUTORIAL_CONTROL_HINTS.equipGun`).
    hint: 'Tab 으로 가방을 열고, 함선 창고의 소총을 왼쪽 장착 장비의 주무기 I 또는 II 칸으로 끌어다 놓습니다.',
    /*
     * 2026-09-14 3rd pass — **with the craft window open there are no equipment slots** (`.inv-root.is-craft` hides
     * them). Focusing the equipment slots + bag in that state lights only the bag and the ring is drawn around empty
     * air. So 「close the craft window」 is the first row, and when it is already closed `TutorialSystem` marks that
     * row done the moment the step is entered, so the next row opens at once. The spotlight splits with `craftOpen`
     * too — close button ↔ equipment slots + bag (`TutorialSystem.stepView`).
     */
    /*
     * 2026-09-17 (user's decision): **④ Tab to open the inventory → equip the assault rifle.** The focus carries **no
     * dim** (`spotNoDim`). Equipping only draws the check and then **waits silently until the inventory is closed** —
     * there is no objective row for it (`TutorialSystem.poll`). The old `stowAmmo` (the ammo into the bag) is gone,
     * and the old `equipClose` row dropped out because the previous step ends on closing the craft window — only on
     * the rare path in with it still open (console) does `stepView` light the close button first.
     */
    objectives: [
      { id: 'equipOpen', text: '{INVENTORY} 인벤토리 열기', spot: [] },
      { id: 'equipSlot', text: '돌격소총 장착', reveal: true },
    ],
    // The previous step's recipes are left open — a blocked recipe vanishes from the list, so the workbench does not
    //   go blank.
    allow: { craft: [TUTORIAL_GUN_RECIPE, TUTORIAL_AMMO_RECIPE] },
    // 2026-09-08: lighting only the primary slot left **the place to pick from (the bag) under the dim plate**, so
    //   the drag could not even be started. The equipment column and the bag touch (a −24 px seam), so their union is
    //   one connected shape.
    // 2026-09-09: not the whole equipment column (`.inv-equip`) but **the 주무기 I · II slots**
    //   (`inventory/ui/parts/SlotPanel.buildSlot`'s `.inv-slot-primary` · `.inv-slot-primary2`, `data-slot` the same)
    //   through to the bag — the secondary · armor · bag slots and the implant slots have nothing to do with this
    //   step. The hole is still one rectangle, so it is the smallest one around those two slots and the bag panel.
    // 2026-09-15 3rd pass: the last entry went `.inv-panel-bag` → **`.inv-panel-grids`** (stash + bag, one card) —
    //   the rifle is in the stash.
    // 2026-09-16: the ship Tab became 창고 | 장비 | 가방, putting the stash outside that card (left of the equipment
    //   column) → the last entry is `.inv-panel-stash`.
    spot: ['.inv-root .inv-equip .inv-slot-primary', '.inv-root .inv-equip .inv-slot-primary2', '.inv-panel-stash'],
    spotUnion: true,
    // 2026-09-17 (user's decision): there is no full-screen dim — only the hole · the ring · the callout (the same as
    //   `corpseLoot`)
    spotNoDim: true,
    spotText: '창고의 소총 → 주무기 I · II 칸',
  },
  openCraft: {
    // (out of the order, 2026-09-09) not in `TUTORIAL_STEPS` — the id stays in the contract (`TutorialStepId`), so it
    //   keeps a place in the table only. It used to light the bag's `제작` button after equipping, to reopen the ammo
    //   craft window; now that the rifle · the ammo are made at the workbench in one go there is nothing to do.
    //   `stepDef('openCraft')` safely returns this entry and `nextStep` is null.
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
    // A union for the same reason as `equipGun` — the place to pick from (the stash) and the place to drop (the bag)
    //   must both be lit for the drag to work.
    spot: ['.inv-panel-stash', '.inv-panel-bag'],
    spotUnion: true,
    spotText: '준중량탄을 가방으로',
  },
  /*
   * 2026-09-17 (user's decision): **⑤ walk to the cockpit → work the terminal → pick the target planet → (wait out
   * the warp) → walk to the launch slot → board → `{JUMP:hold}` ready** (old `terminal` · `planet` · `travel` ·
   * `board`). There is no row for waiting out the warp — 「발사 슬롯으로 이동」 opens only once it ends (`travelDone`, an id
   * that is not in the list). The pod opens from the moment that row is visible (the row's own `allow`). For this
   * whole track the terminal's `시뮬레이션 훈련장` button and the ready-time launch warnings are hidden (the `training` ·
   * `launchWarn` gates). The raid starting (`game:newMission`) is the next step.
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
   * 2026-09-18 (user's decision): the two steps below (`terminal` · `raid`) are now the **「출격 안내」** (`raid2`) track —
   * the ids and the contents are unchanged, the only thing moved is the track
   * (`shared/tutorial.TUTORIAL_TRACK_STEPS`). 「증축 안내」 ends at `equipGun`.
   */
  /*
   * 2026-09-17 (user's decision): **⑥ the raid quest** — extract while the sum of the sell prices of the items found
   * in this raid (`raidFound`) is at least `TUTORIAL_RAID_EXTRACT_VALUE_C`. **There is one attempt**: extraction ·
   * death · abandoning, whichever it is, ends the track once that raid ends, and the objective is checked only when
   * the extraction happened with the condition met (`TutorialSystem.onBuildRaidEnd`). The progress count is that sum
   * as it is carried right now. On the right the control guide shows in this raid only (`model.RAID_GUIDE_HINTS`,
   * folded with `]`).
   */
  raid: {
    id: 'raid', title: '행성에서 전리품을 챙겨 탈출하세요',
    hint: '레이드에서 얻은 아이템을 챙겨 무사히 탈출합니다.',
    objectives: [{
      id: 'raidValue',
      text: `행성에서 가치 ${TUTORIAL_RAID_EXTRACT_VALUE_C.toLocaleString('en-US')} C 이상 아이템을 획득한 후 무사히 탈출`,
      count: TUTORIAL_RAID_EXTRACT_VALUE_C, countUnit: 'C',
    }],
    // The raid runs as it normally does — this step blocks nothing and hides nothing.
    allow: {
      roomPurpose: true, furniture: true, manageExit: true, craft: true,
      terminal: true, planet: true, board: true, screenTab: true, stashItem: true,
    },
  },

  /* ══ 2026-09-14 the tutorial rework (docs/DECISIONS.md 「2026-09-14 — 튜토리얼 개편」) ══════════════════════════════════
   * ① raid — a hand-built tutorial planet. What has to be guided is **the fingers, not the UI**, so there is almost
   *    no spotlight: the keys in use are drawn by the control guide on the right (`ui/Controls`,
   *    `TUTORIAL_CONTROL_HINTS`), and the objective panel says only "what is being done right now".
   *    2026-09-15 (user's decision) — an objective is a **short noun phrase**, and a row that names a key uses
   *    **keycap tokens** (`{QUICK:hold}` …). The old 「no key letters in the wording」 was because a letter burned into
   *    the text becomes a lie after a rebinding; a token is resolved from `Keys` at draw time and redrawn on a
   *    rebinding, so that worry is gone (`shared/keycap.renderKeyText`).
   * ② ship — the first ship entry. Level · stats are all existing screens, so it **only points at them with the
   *    spotlight** (2026-09-16: the messenger step excepted).
   * ═══════════════════════════════════════════════════════════════════════════════════════════════════ */
  /* ── ① raid — the tutorial raid ── */
  /*
   * 2026-09-14 2nd pass — the objective panel became a **checkbox list**, so every step carries a short objective
   * sentence (`objectives`). `hint` was left alone: it is the spotlight callout's default wording and the objective
   * sentence of a step that has no `objectives`.
   */
  /*
   * 2026-09-14 4th pass (user's decision) — **there is no objective.** 「getting the body up」 is not something the
   * player does but something the cutscene does, so standing it up as a checkbox leaves an objective on screen that
   * nothing can be done about. And for this step the objective panel · the control guide are **not drawn at all**
   * (`TutorialSystem.quiet`) — the screen is still black.
   */
  wake: {
    id: 'wake', title: '정신을 차리세요',
    hint: '강하가 실패했습니다. 몸을 일으키는 중입니다 — 잠시 기다리세요.',
    objectives: [],
  },
  /*
   * 2026-09-15 2nd pass (user's decision) — the objective wording is **「앞으로 이동」**. `advance1`·`2`·`3` between one
   * stretch and the next already carry that sentence, and making only the first step 「갈라진 땅까지 이동」 would give one
   * thing two names (and that ground is not even visible yet — how far to go is something walking there teaches).
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
   * 2026-09-15 2nd pass (user's decision) — **interacting with a corpse.** Before, 「기관단총을 주무기 칸에 장착」 came up the
   * moment the cliff was cleared: telling someone to move what is inside a corpse they have not even opened yet (the
   * same eye that added `supplyLoot` — 「nothing is told to be used before it is picked up」). So standing in front of
   * the corpse is this one row first, and **once the corpse's bag opens** it is `corpseLoot`
   * (`TutorialSystem.onContainerOpened` — a container id starting `corpse:`).
   *
   * There is no spotlight — what has to be done is **the corpse in the world**, not a screen, so there is no DOM to
   * light. Instead a 3D target marker (`parts/Marker`) stands over that corpse **exactly** as it does in
   * `corpseLoot`.
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
     * 2026-09-14 2nd pass (user's decision) — **only picking up the gun is required.** The bag · the ammo · the
     * bandage drop to optional objectives and are only shown alongside as checkboxes (not taking them still moves
     * on). Equipping the gun is the next step, and at that moment the hp · weapon HUD appears (`HUD_GEAR_STEP` is
     * this step, so it shows **past** it — the relation is unchanged).
     */
    /*
     * 2026-09-14 3rd pass (user's decision) — the next step comes only **once the bag is closed**. If the guide moved
     * on to the bug stretch the moment the gun is taken, the objective would change behind the back of someone still
     * reading the inventory screen. So there are two required rows and 「closing the bag」 opens **after the gun is
     * taken** (`revealOn` — the rows before it are optional objectives, so `reveal` will not do).
     */
    /*
     * 2026-09-14 4th pass (user's decision) — the rows came down to three.
     *   • `corpseStim` removed — that corpse (`corpse:tut_gear`) holds **no healing item**. Writing down something
     *     that cannot be done makes it not an optional objective but an objective that was never found (healing is
     *     taught at `heal`'s supply corpse).
     *   • `corpseClose` removed — closing is not an objective but the way out of the screen. **It stays as the signal
     *     that advances the step** (`onInventoryClosed`): the check goes into the objective and the spotlight turns
     *     off the moment the gun is taken, but the next guidance comes when the inventory is closed — so nothing
     *     changes behind the back of someone reading the screen.
     */
    objectives: [
      { id: 'corpseGun', text: '기관단총을 주무기 칸에 장착' },
      { id: 'corpseBag', text: '가방을 장비 칸에 장착', optional: true },
      { id: 'corpseAmmo', text: '탄약 챙기기', optional: true },
    ],
    // The drag spans the equipment slots ↔ the corpse grid, so it is lit as a union (the same reason as `equipGun`).
    // ⚠ A grid tile carries no def id, only `data-uid` (`inventory/ui/GridView`), so there is no selector that picks
    //   the gun's one cell — the hole is 「the corpse grid ~ the primary slot」, i.e. the whole drag path. Lighting the
    //   cells that can take the item in green once the drag starts is something the inventory already does
    //   (`.inv-slot.is-target-ok`).
    // 2026-09-15 (user's decision): the hole widens **as far as the armor slot**
    //   (`inventory/ui/parts/SlotPanel.buildSlot`'s `inv-slot-${slot}` — `LOADOUT_SLOTS`'s `armor`). Closing the
    //   window at once releases the focus (`TutorialSystem.corpseFocusOff`).
    spot: [
      '.inv-panel-container', '.inv-root .inv-equip .inv-slot-primary', '.inv-root .inv-equip .inv-slot-primary2',
      '.inv-root .inv-equip .inv-slot-armor',
    ],
    spotUnion: true,
    // 2026-09-14 2nd pass (user's decision): this step alone has **no dim** — there is much to look at besides the
    //   corpse grid · the equipment slots, and a dim plate over half the screen makes the first-ever inventory screen
    //   unreadable.
    spotNoDim: true,
    // 2026-09-16 (user's decision): it names the **way** to move it — left-click drag · double-click keycaps
    //   (`{MOUSE_LEFT}` · `{DOUBLE_CLICK}` are fixed tokens independent of rebinding,
    //   `shared/keycap.KEYCAP_FIXED_TOKENS` — the double-click keycap is shaped like the key guide's)
    spotText: '아이템을 {MOUSE_LEFT} 드래그 또는 {DOUBLE_CLICK}해서 장착 칸으로 이동',
  },
  /*
   * ── the three 「앞으로 이동」 stretches (2026-09-14 4th pass, user's decision) ──────────
   * Before, the next stretch's guidance came up the instant the previous one ended — 「앉아서 낮은 틈을 지나세요」 the moment the
   * bug died, 「아래로 뛰어내리세요」 the moment the android died. That thing is still 30 m away and only the guidance arrives
   * first. So between one stretch and the next it is always this step, and the next guidance comes up **on standing
   * in front of that thing**.
   *
   * All three end at a **checkpoint that already exists** (`advance1`→`bugs` · `advance2`→`crawl` ·
   * `advance3`→`drop`, `model.CHECKPOINT_STEP`) — there is no new trigger in the world. No spotlight and no floor
   * guide either; only the control guide is swapped back to movement rows (`model.TUTORIAL_CONTROL_HINTS` —
   * `advance1` · `advance3` come back to `move`'s rows, while `advance2`, walked after the bugs are dead, keeps
   * fire · aim and adds the corpse row on 2026-09-16).
   * The three definitions being identical is deliberate — the progress bar says 「how far along am I」,
   * and the objective sentence is always the one thing.
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
    // 2026-09-15 2nd pass (user's decision): the number is not written into the wording but **passed as `count`** —
    //   the panel appends `(n/m)` after it and refreshes only that number on each kill. The one source of the target
    //   count is `RAID_KILLS_PER_STEP`.
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
   * 2026-09-15 (user's decision) — **looting the supply corpse.** The step the `supply` checkpoint opens (before, it
   * went straight to `heal`, so 「붕대 사용」 came up before a bandage had even been picked up). Two rows show together —
   * required 「붕대 획득」 · optional 「수류탄 획득」 — and the required one is checked once a bandage lands in the bag
   * (`TutorialSystem.onInventory`; the tutorial raid starts empty-handed and the first corpse holds no healing item,
   * so 「a healing item is in the bag · a quick slot」 = it came from that corpse). **Closing the window** after
   * getting the bandage is `heal`. Walking on to `wall` without picking it up skips `heal` too.
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
    // 2026-09-14 2nd pass (user's decision): at full health this step is passed silently (`TutorialSystem.setStep`).
    /*
     * 2026-09-14 4th pass (user's decision) — 「붕대를 빠른 사용 칸에 올린다」 (`healStock`) removed: a bandage · a grenade is
     * **registered into an empty wheel slot automatically** when picked up. What is left is two things, **holding
     * it** and **using it**.
     *
     * 2026-09-15 (user's decision) — ① the two rows are a **sequential reveal**: 「붕대 사용」 appears only once the
     * bandage is held. ② **keycaps** go inside the rows (`{QUICK:hold}` · `{FIRE:hold}`). ③ the optional objective
     * 「수류탄을 챙긴다」 (`healGrenade`) is removed — it moved to 「시체에서 수류탄 획득」 on the supply-corpse step (`supplyLoot`).
     */
    objectives: [
      { id: 'healHold', text: '{QUICK:hold} 길게 눌러 붕대 장착' },
      { id: 'healUse', text: '{FIRE:hold} 길게 눌러 붕대 사용', reveal: true },
    ],
  },
  grenade: {
    id: 'grenade', title: '무너진 벽 너머를 정리하세요',
    hint: '엄폐한 적에게는 수류탄이 답입니다. 쓰지 않고 지나가도 됩니다.',
    // 2026-09-14 2nd pass (user's decision) — the model case of a required + an optional row showing together in one
    //   step.
    /*
     * 2026-09-14 4th pass (user's decision) — the optional objective changed from 「a kill」 to **「take one out and
     * throw it」**. What is being learnt is the path to getting a grenade in hand, not hitting with it, and missing
     * does not undo what was learnt. So the check is one line, `grenade:exploded` (it does not look at whether
     * anything died).
     */
    objectives: [
      // 2026-09-15: the collapsed wall became a diagonal barricade — the same 「앞으로 이동」 as the other stretches (user's
      //   decision)
      { id: 'wallPass', text: '앞으로 이동' },
      { id: 'grenadeThrow', text: '{QUICK:hold} 수류탄 장착 후 {FIRE:hold} 투척', optional: true },
    ],
  },
  extract: {
    id: 'extract', title: '버려진 함선으로 탈출하세요',
    hint: '함선 안의 스위치를 누르면 곧바로 이륙합니다. 그 함선이 앞으로 당신의 함선입니다.',
    objectives: [{ id: 'extractSwitch', text: '{INTERACT:hold} 함선 스위치 작동' }],
    // The step the raid ends on — it blocks nothing (the same treatment as the build track's `raid`).
    allow: {
      roomPurpose: true, furniture: true, manageExit: true, craft: true,
      terminal: true, planet: true, board: true, screenTab: true, stashItem: true,
    },
  },
  /* ── ② ship — the first ship entry ── */
  /*
   * (out of the order, 2026-09-16 2nd pass — user's decision) not in `TUTORIAL_TRACK_STEPS.ship`. 「인벤토리 화면 열기」 became
   * `stats`'s first objective (`statsMenu`), and an old save's `levelUp` is moved to `stats` by `normalizeStep`.
   * Below is how it looked while it was in the order.
   */
  levelUp: {
    id: 'levelUp', title: '레벨이 올랐습니다',
    // The advance signal is `inventory:opened` alone — once the inventory screen opens, the character tab inside it
    //   is lit by the next step.
    hint: '임무 보상으로 능력치 포인트가 생겼습니다. 인벤토리 화면을 여세요.',
    objectives: [{ id: 'levelScreen', text: '인벤토리 화면 열기' }],
    allow: { screenTab: ['character'] },
    // `.scr-tab` carries no per-tab mark — the only tabs visible right now are the inventory · the character, so the
    //   whole tab row is lit.
    spot: ['.inv-root .scr-tabs', '.inv-root'],
    spotText: '캐릭터 탭',
  },
  /*
   * 2026-09-16 2nd pass (user's decision) — **the ship track's only step.** Four objectives open one at a time
   * (sequential reveal, `reveal`):
   *   ① `statsMenu`  open the menu (the Tab window) — one `{INVENTORY}` row in the control guide on the right
   *                  (`model.TUTORIAL_CONTROL_HINTS.stats`)
   *   ② `statsTab`   move to the character tab — the spotlight is the character tab in the tab row
   *   ③ `statsRaise` raise one stat with ＋ — the spotlight is the stat column (judged by `progress:statPending`)
   *   ④ `statsSpent` confirm the investment (a 1 s hold) — the spotlight is the `되돌리기 · 포인트 투자 확정` row
   * ①② are read from the screen state by `poll`, and what to light for which objective is picked by
   * `TutorialSystem.stepView` (it splits on the screen state). The moment it is confirmed the focus is taken down and
   * the track ends **right there** (`onStatsConfirmed`). The `statsSpent` id stays as it is for old-save
   * compatibility. The `spot` · `spotText` below are ③'s look — the default for when the screen state is unknown
   * (before `stepView` splits it).
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
     * (out of the order, 2026-09-16 — user's decision) not in `TUTORIAL_TRACK_STEPS.ship` — it keeps a place in the
     * table only, the same treatment as `openCraft` · `ravenQuest`. The step that dragged the player to the messenger
     * window after handing out the level-up points is gone: the ship track ends at `stats` (when the screen closes —
     * `TutorialSystem.onStatsConfirmed`), and an old save's `messenger` is read by `retiredTrackEnd` as 「the ship
     * track is done」. Below is the record of when it was in the order.
     *
     * 2026-09-15 (user's decision) — the ship track's **last step**. The old wording 「읽지 않은 연락이 와 있습니다」 becomes a
     * lie: Raven's first contact now comes after this track ends (`meta/parts/NpcQuests.tutorialBlocks`). So it says
     * only 「where what arrives」. The moment it opens the track ends (`ui:messengerToggled {open:true}` → `advance` →
     * `finish`) and 「증축 안내」 follows straight on — that track hides the messenger again, so a window left open is
     * closed (current behaviour).
     */
    hint: '우측 상단의 메신저 버튼을 누릅니다. NPC 의 연락과 의뢰는 여기로 옵니다.',
    objectives: [{ id: 'messengerOpen', text: '메신저 열기' }],
    allow: { community: true },
    /*
     * 2026-09-15 (E-12, smoke-tutorial-ship) — it lights **only a button that carries `.show`**. `stats` ends inside
     * the inventory window, so this step usually starts with that window open, and meanwhile `.community` is only
     * folded to `opacity: 0` by the blocker and its rectangle stays — `Spotlight.firstShown` read that as 「visible」
     * and **put the ring around an invisible button**, covering the whole window with the dim. Closing the window
     * adds `.show`, and it lights half a beat later.
     */
    spot: ['.community.show .cm-btn', '.community.show'],
    spotText: '메신저',
  },
  /*
   * (out of the order, 2026-09-15 — user's decision) not in `TUTORIAL_TRACK_STEPS.ship` — it keeps a place in the
   * table only, the same treatment as `openCraft`. Raven's first contact comes after the ship track ends, so this
   * step has nothing left to wait for. Since 2026-09-16 an old save's `ravenQuest`, together with `messenger`, is
   * read by `retiredTrackEnd` as 「the ship track is done」 (there is no step left in the order to join on).
   */
  ravenQuest: {
    id: 'ravenQuest', title: '레이븐의 의뢰를 받으세요',
    hint: '대답을 고르고 퀘스트 카드의 수락을 누릅니다.',
    objectives: [
      { id: 'ravenTalk', text: '레이븐의 연락에 답장' },
      { id: 'ravenAccept', text: '퀘스트 수락' },
    ],
    allow: { community: true },
    // 2026-09-15 (E-12): the conversation page's class is `.ms-page.chat` (tab id `chat`) — `.chats` found nothing
    //   and fell through to the whole frame
    spot: ['.ms-qcard', '.ms-page.chat', '.ms-frame'],
    spotText: '레이븐의 첫 연락',
  },
};

/** The step definition. An id out of the order (`openCraft` · `ravenQuest`) is in the table too, so a definition
 *  always comes back. */
export const stepDef = (id: TutorialStepId): StepDef => STEP_DEFS[id];

/**
 * The order array of the track that step belongs to (2026-09-14). Progress · the next step are counted **only inside
 * its own track** — each track has its own objective panel and its own skip. An id whose track is unknown
 * (`openCraft` · `ravenQuest`) is read as build (both are moved into the order by `normalizeStep` first, so they
 * never actually reach here).
 */
export const trackStepsOf = (id: TutorialStepId): readonly TutorialStepId[] =>
  TUTORIAL_TRACK_STEPS[tutorialTrackOf(id) ?? 'build'];

/** That step's track (an unknown id is build — `openCraft` · `ravenQuest`). */
export const trackOf = (id: TutorialStepId): TutorialTrack => tutorialTrackOf(id) ?? 'build';

/** Is this a step in the order — it looks at **every track** (`shared/tutorial.TUTORIAL_TRACK_STEPS`, four of them
 *  since `raid2` split off on 2026-09-18). It filters out an id left only in the contract, like `openCraft`. */
export const isOrderedStep = (id: string): id is TutorialStepId =>
  tutorialTrackOf(id as TutorialStepId) !== null;

/**
 * Fixes an id coming in from a save · the console into a step inside the order (2026-09-09). A step that is out of
 * the order is moved onto the step that **took over its place** — a save in progress carries on under the new order
 * instead of being stuck. An unknown value is null.
 *
 * `openCraft` (2026-09-09) → `craftGun` (it went to `craftAmmo` first, and `craftAmmo` itself was folded into
 *   `craftGun` on 2026-09-17 — `RETIRED_BUILD` is the table that answers).
 * `ravenQuest` (2026-09-15) · `messenger` (2026-09-16) → **null** — both were
 *   the ship track's last place and no step follows them. Such a save is read by `retiredTrackEnd` as 「that track is
 *   done」 (`TutorialSystem.load`).
 * ⚠ All three **stay** in `TutorialStepId` and in the `STEP_DEFS` table above (a contract does not erase a name) —
 *   what is gone is only the **order** in `TUTORIAL_TRACK_STEPS`. So `tutorialTrackOf` returns null and `trackOf`
 *   reads them as build.
 * `manageDone` was moved here to `craftGun` only between 2026-09-14 3rd pass and 2026-09-15 — it came back into the
 *   order, so `isOrderedStep` now passes it through as it is (a save from in between holds `craftGun`, so there is
 *   nothing to move).
 */
export function normalizeStep(id: string | null | undefined): TutorialStepId | null {
  if (typeof id !== 'string') return null;
  // 2026-09-17: 「증축 안내」 was grouped into 7 steps — a dropped step maps to the step that swallowed it
  //   (`RETIRED_BUILD`)
  const grouped = RETIRED_BUILD[id];
  if (grouped) return grouped.step;
  // 2026-09-16 2nd pass: 「메뉴 열기」 became `stats`'s first objective — a save standing at that place does `stats` from
  //   the beginning
  if (id === 'levelUp') return 'stats';
  return isOrderedStep(id) ? id : null;
}

/**
 * 2026-09-17 (user's decision — 「증축 안내」 17 → 7 steps): a build step out of the order → **the step that swallowed it**
 * and the objectives someone standing at that place has **already done**. `TutorialSystem.load` fills those in so
 * that an old save does not redo the new step from its first row. (`openCraft` moved to `craftAmmo` back on
 * 2026-09-09, and now that `craftAmmo` has gone into `craftGun` too.) `stowAmmo` is a step with nothing left to do,
 * so it maps to the start of the next step (`terminal`).
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

/** For an old build step id, the objectives already done at that place (in the new step's terms); otherwise null. */
export function retiredObjectives(id: string | null | undefined): readonly string[] | null {
  return typeof id === 'string' ? RETIRED_BUILD[id]?.done ?? null : null;
}

/**
 * A **track's last place** that dropped out of the order → that track (2026-09-16). This id left in a save means that
 * player stood at the track's end, so it is read as 「done」 instead of a step to join on — going back to `stats` would
 * be a dead end that asks for points already spent to be invested again.
 */
const RETIRED_TRACK_END: Readonly<Record<string, TutorialTrack>> = { messenger: 'ship', ravenQuest: 'ship' };

/** If the id left in a save is the last place of a track that dropped out of the order, that track; otherwise
 *  null. */
export function retiredTrackEnd(id: string | null | undefined): TutorialTrack | null {
  return typeof id === 'string' ? RETIRED_TRACK_END[id] ?? null : null;
}

/** The next step in the same track (null at that track's last = the track ends). */
export function nextStep(id: TutorialStepId): TutorialStepId | null {
  const arr = trackStepsOf(id);
  const i = arr.indexOf(id);
  return i < 0 || i + 1 >= arr.length ? null : arr[i + 1];
}

/** The 1-based position inside its own track (0 for a step that is not there). */
export const stepIndexOf = (id: TutorialStepId | null): number =>
  (id ? trackStepsOf(id).indexOf(id) + 1 : 0);

/** The number of steps in its own track (0 for a step that is not there). */
export const stepCountOf = (id: TutorialStepId | null): number => (id ? trackStepsOf(id).length : 0);
