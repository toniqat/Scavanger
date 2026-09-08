# src/tutorial — 새 캐릭터 안내

새 프로필이 개인 함선에 처음 들어오면 자동으로 시작해, **함선 안에서 한 바퀴**(하우징 → 제작 → 출격)를
돌리고 레이드가 시작되면 끝난다. `ctx.tutorial` (`TutorialRef`, 계약은 [`src/shared/tutorial.ts`](../shared/tutorial.ts)).

**설계 한 줄**: 진행은 **버스 이벤트 관찰**로만 판단하고, 순서 강제는 **각 폴더가 자기 거절 사유 함수에서
`ctx.tutorial?.blockReason()` 을 한 번 부르는 것**으로 이뤄진다. 튜토리얼은 남의 폴더 안을 들여다보지 않고,
남의 폴더는 튜토리얼의 단계를 모른다. 튜토리얼이 꺼져 있으면 그 호출은 언제나 `null` 이라 평소 동작이
한 글자도 바뀌지 않는다.

---

## 파일

| 파일 | 역할 |
|---|---|
| `TutorialSystem.ts` | `GameSystem` + `TutorialRef`. 단계 기계 · 이벤트 구독 · localStorage 저장 · 재료 지급 · dev 콘솔 `tutorial` 명령. `ctx.tutorial` 을 게시한다. |
| `model.ts` | 폴더 공용 어휘 — 저장 키 · blocker 토큰 · 튜토리얼이 만들게 하는 id들(`furn_bench_gun` · `make_wpn_ar` · `bulk_ammo_medium`) · 지급 재료 표 · 안내선 수치 · `StepDef` 타입. 상태 없음. |
| `Steps.ts` | **단계 표** — 각 단계의 제목 · 부제 · `allow`(허용 게이트) · 스포트라이트 선택자 · 안내선 목표. 진행 조건은 여기 없다 (아래 참고). |
| `parts/Gates.ts` | 게이트 판정 순수 함수. `allow` 에 없는 게이트는 전부 막고, 배열이면 그 id 만 허용한다. `hides(gate, id?)` 도 여기 — **막히는 것은 곧 감추는 것**이다. |
| `parts/Guide.ts` | **바닥 안내선** — 흐르는 점선 띠(셰이더) + 목표 빛기둥 + 링. `Interactable.id` 하나로 목표를 잡는다. |
| `parts/Spotlight.ts` | **UI 포커싱** — 화면을 덮는 네 판 + 링 + 말풍선. 판이 클릭을 먹고, 구멍은 그대로 통과시킨다. 링은 **천천히 확대-축소**하고(2026-09-08), 확인 팝업(`YIELD_TO`)이 뜨면 스스로 비켜선다. |
| `ui/Panel.ts` | 좌측 상단 목표 패널 (`튜토리얼 n / m` · 제목 · 부제 · 진행 바 · **건너뛰기** 버튼). 포커싱 중에는 `is-lifted` 로 어두운 판 위에 올라간다 — 딤 제외 + 건너뛰기는 언제나 눌린다. |
| `ui/Popup.ts` | 시작 안내 카드와 건너뛰기 확인 카드 (같은 셸, 버튼만 다름). 모달리스. |
| `tutorial.css` | 위 셋의 스타일. `.ui-btn` · `.ui-label` 은 `ui/styles/base.css` 것을 쓴다. |

### 왜 진행 조건은 표에 없나

단계마다 "무엇으로 끝났다고 볼지"가 제각각이다 — 어떤 것은 이벤트 하나(`housing:roomPurposeChanged`),
어떤 것은 이벤트 + 조건(`loadout:changed` 뒤에 주무기 칸을 다시 읽어 본다), 어떤 것은 상태 폴링에 가깝다
(`inventory:changed` 뒤 가방에 준중량탄이 있나). 표에 억지로 넣으면 술어 함수의 목록이 되어 오히려 읽기
어려워지므로, **표는 표시와 허용만** 갖고 진행은 `TutorialSystem` 의 구독 하나하나가 갖는다.

---

## 단계 (15)

| # | id | 목표 | 다음으로 넘어가는 신호 |
|---|---|---|---|
| 1 | `intro` | 시작 안내 카드 | 카드의 **시작** |
| 2 | `manage` | M 으로 함선 관리 | `housing:shipManageChanged {active:true}` |
| 3 | `generator` | 발전기 가동 (Lv.1) | `housing:facilityUpgraded {id:'generator', level>=1}` |
| 4 | `workshop` | 빈 방 → 작업실 | `housing:roomPurposeChanged {purpose:'workshop'}` |
| 5 | `bench` | 총기 작업대 제작 + 배치 | `housing:furniturePlaced {defId:'furn_bench_gun'}` |
| 6 | `manageDone` | 함선 관리 닫기 | `housing:shipManageChanged {active:false}` |
| 7 | `craftGun` | 작업대에서 돌격소총 | `craft:completed {recipeId:'make_wpn_ar'}` |
| 8 | `equipGun` | 주무기 칸에 장착 | `loadout:changed` + 주무기가 `wpn_ar` |
| 9 | `craftAmmo` | 준중량탄 제작 | `craft:completed {recipeId:'bulk_ammo_medium'}` |
| 10 | `stowAmmo` | 탄약을 가방에 | `inventory:changed` + 가방에 `ammo_medium` |
| 11 | `terminal` | 조종석 터미널 | `hub:terminalToggled {open:true}` |
| 12 | `planet` | 목표 행성 지정 | `hub:planetChanged` |
| 13 | `travel` | 워프 대기 | `hub:travel {stage:'end'}` |
| 14 | `board` | 발사 슬롯 탑승 | `hub:slotChanged` (로컬) 또는 `game:newMission` |
| 15 | `raid` | 탈출 지점 확인 | `world:ready` 6초 뒤 자동 종료 |

> `generator` 는 **시설 증축의 전제 조건**이다. 이 단계가 없던 동안에는 발전기 Lv.0 인 새 함선에서
> 작업실 행이 바로 포커싱되고 발전기 게이트에 막혀 **진행 자체가 불가능**했다 (2026-09-08 수정).
> 발전기가 이미 Lv.1 이상인 함선이면 `setStep` 이 이 단계를 조용히 지나친다.

---

## 게이트 (순서 강제)

사용자 결정: **엄격하게 강제**. `Steps.ts` 의 `allow` 에 없는 게이트는 전부 막힌다.
호출부는 전부 이미 있던 "왜 안 되나" 함수 안이라, 사유가 기존 UI(프롬프트 · 툴팁 · 인라인 문구)에 그대로 실린다.

| 게이트 | 호출하는 곳 | 무엇이 막히나 |
|---|---|---|
| `roomPurpose` | `housing/parts/Rooms.purposeBlock` | 작업실 외의 시설 증축 |
| `furniture` | `housing/parts/Furniture.canCraftFurniture` · `place` | 총기 작업대 외의 가구 제작 · 배치 |
| `craft` | `inventory/parts/Crafting.canCraft` (→ `craft`) | 그 단계의 레시피 외 전부 |
| `terminal` | `hub/parts/Interior` (터미널 `canInteract`) | 터미널 단계 전의 터미널 |
| `planet` | `hub/parts/Planet.travelBlockReason` (→ `setPlanet`) | 첫 번째 행성(`PLANET_IDS[0]`) 외 |
| `board` | `hub/parts/Pods.podBlockReason` | 탑승 단계 전의 발사 슬롯 |
| `screenTab` | `inventory/ui/parts/Screens.setTab` · `markTab` | 인벤토리 외 화면 탭 (자물쇠 + 사유 툴팁) |
| `matchmaking` | `hub/ui/HubMenu.refresh` (`hides`) | 신호 · 공유 함선 섹션 **숨김** |
| `community` | `ui/hud/Community.update` (`hides`) | 우측 상단 커뮤니티 버튼 **숨김** |

### 잠그지 않고 **감춘다** (2026-09-08)

사용자 결정: 잠긴 항목에 "튜토리얼에서는 ~" 사유를 달아 남겨 두는 것이 오히려 헷갈린다 — **지금 할 수 있는
것만 남긴다.** `hides(gate, id?)` 가 그 판정이고, 규칙은 두 줄뿐이다.

- `id` 를 준 호출 = 항목 하나. `blockReason` 이 막으면 그리지 않는다.
- `id` 없는 호출 = "이 게이트가 **완전히** 열려 있나". 아니면 그 UI 를 좁힌다.

| 어디 | 무엇이 사라지나 |
|---|---|
| `ui/hud/ShipManage.refreshPurposes` | 그 단계가 허락한 용도 외의 **용도 행 전부** (안내 중에는 발전기 행 + 작업실 한 줄) |
| `ui/hud/ShipManage.refreshCards` | 허락한 가구 외의 **가구 카드** |
| `inventory/ui/CraftPanel.refresh` | 허락한 레시피 외의 **제작 행** |
| `inventory/ui/parts/Screens.markTab` | 인벤토리 외의 **화면 탭** (자물쇠 + 툴팁이 아니라 `hidden`) |
| `hub/ui/HubMenu.refreshTravel` | 행성 **넘김 화살표 · 점** (고를 수 있는 행성이 하나뿐이라) |

목록이 통째로 비면 그것대로 이상하므로 `Steps.ts` 가 인접 단계의 항목을 열어 둔다 — `manageDone` 은 작업대
카드를, `equipGun` · `stowAmmo` 는 직전 단계의 레시피를 그대로 허용한다. 네 호출부 모두 캐시 키에 현재
단계를 섞고 `tutorial:changed` 를 구독하므로, **건너뛰거나 끝나면 감춰 둔 것이 그 자리에서 전부 돌아온다.**

---

## 시작 · 저장 · 재시작

- **자동 시작**: `hub:entered {ship:'personal'}` 에서, 저장이 없고 **정말 새 캐릭터일 때만**.
  "새 캐릭터"는 `looksFresh()` 가 본다 — 놓인 가구 0 · 용도 있는 방 0 · 레벨 1. 튜토리얼이 없던 시절부터
  하던 프로필도 `scav.tutorial` 이 없기는 마찬가지라, 그런 프로필은 조용히 `done` 으로 표시하고 다시는 켜지 않는다.
- **저장**: `scav.tutorial` (`TutorialSave` + `granted` · `benchUid`). 단계가 바뀔 때마다 쓰므로 새로고침을 견딘다.
  `ui/menus/newCharacter.resetCharacterSaves()` 가 `scav.` 접두 키를 전부 지우므로 **새 캐릭터로 시작**하면 다시 돈다.
- **끝내기**: 완주(`raid` 6초 뒤) 또는 **건너뛰기**(확인 카드 → `skip()`). 둘 다 `done: true` 로 남고 모든 게이트가 풀린다.
- **다시 보기**: dev 콘솔 `tutorial start` / `tutorial skip` / `tutorial step <id>` / `tutorial status`.

## 재료 지급

기본 지급품(`STARTER_STASH`)은 발전기 Lv.1 + 작업실 증축 + 작업대 제작으로 폐금속 20 · 케이블 3 · 합금 2 를
쓰도록 맞춰져 있어서, **작업대를 짓고 나면 아무것도 만들 수 없다**. `craftGun` 단계에 들어설 때
`TUTORIAL_CRAFT_GRANT`(폐금속 16 · 합금 2 · 화약 20)를 함선 창고에 한 번 넣어 준다 (`granted` 플래그로 한 번만).
같은 이유로 **총기 작업대 Lv.1 에 `make_wpn_ar`(돌격소총 제작) 레시피를 새로 넣었다** — 그 전에는 작업대
Lv.1 이 대량 탄약밖에 못 만들어 "작업대로 총을 만든다"는 동작 자체가 없었다 (`src/items/Recipes.ts`).

## 스모크

`scripts/smoke-tutorial.mjs` (46). **다른 스모크는 전부** `evaluateOnNewDocument` 에서
`scav.tutorial` 을 `done` 으로 심고 시작한다 — 튜토리얼은 새 프로필에서 자동으로 켜져 그 스크립트들이
드라이브하는 행동을 순서대로 잠그기 때문이다.

---

## 변경 이력

프로젝트 전체 이력은 [docs/HISTORY.md](../../docs/HISTORY.md) 에 있다.

- **2026-09-08 (UI/UX 수정 4건)** —
  ① 시작 카드가 떠도 커서가 없어 아무것도 누를 수 없었다: `hub/parts/Transitions.enter` 가 `hub:entered` 를
  쏜 **직후** 무조건 `requestPointerLock()` 을 불러, 같은 tick 에 커서를 잡은 카드에서 마우스를 도로 빼앗았다.
  `Input.requestPointerLock` 이 커서 주인이 있으면 아예 요청하지 않고, 이미 날아간 요청이 뒤늦게 도착하면
  `pointerlockchange` 에서 즉시 돌려준다 (`src/shared/Input.ts`).
  ② **`generator` 단계 신설** — 발전기 Lv.0 인 새 함선에서 작업실 행부터 포커싱되어 진행이 막혔다.
  ③ 잠긴 항목은 사유를 달지 않고 **감춘다** (위 절). ④ 포커싱 링이 밝기만 오가서 눈에 안 띄던 것을
  **천천히 확대-축소 + 에코 링**으로 바꿨고, 목표 패널은 딤 위로 올려 건너뛰기를 언제든 누를 수 있게 했다.
  덤으로, 스포트라이트가 시설 증축 확인 팝업(`.sm-confirm`)을 덮어 **확인을 누를 수 없던** 문제도 함께 고쳤다
  (스포트라이트가 비켜서고, 팝업 z-index 를 79 로 올렸다).

- **2026-09-08 (신규)** — 폴더 생성. 사용자 결정 넷: 순서를 **엄격하게 강제** · UI 포커싱은 **스포트라이트 +
  클릭 차단** · 바닥 안내선은 **흐르는 점선 + 목표 빛기둥** · 발동은 **새 프로필 자동 + 콘솔 재시작**.
  제작 단계는 레시피가 없어서 만들 수 없었고(작업대 Lv.1 = 대량 탄약뿐), 재료도 모자랐다 — 소총 레시피를
  추가하고 재료는 튜토리얼이 한 번 지급하는 것으로 정리했다.
