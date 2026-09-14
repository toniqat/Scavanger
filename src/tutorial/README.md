# src/tutorial — 새 캐릭터 안내

안내는 **세 트랙**이고 각각 따로 건너뛴다 (2026-09-14, 사용자 결정 · 설계 원본
[`docs/DECISIONS.md` 「2026-09-14 — 튜토리얼 개편」](../../docs/DECISIONS.md 「2026-09-14 — 튜토리얼 개편」)):

| 트랙 | 어디서 | 무엇을 |
|---|---|---|
| ① `raid` | 손으로 지은 튜토리얼 행성 (`ctx.missionMode === 'tutorial'`) | 깨어나기 · 이동 · 달리기 · 점프 · 루팅 · **앞으로 이동** · 사격 · 앉기 · 낙하 · 회복 · 수류탄(선택) · 탈출 |
| ② `ship` | 개인 함선 (레이드를 **완주**하고 돌아온 그 한 번) | 레벨업 · 능력치 투자 확정 · 메신저 · 레이븐의 첫 의뢰 |
| ③ `build` | 개인 함선 (손대지 않은 함선) | **16단계** (2026-09-14 3차에 `manageDone` 이 빠졌다) — 하우징 → 제작 → 출격 |

`ctx.tutorial` (`TutorialRef`, 계약은 [`src/shared/tutorial.ts`](../shared/tutorial.ts)).
**돌고 있는 트랙은 언제나 하나**이고 진행률(`stepIndex` / `stepCount`)도 그 트랙 안에서만 센다.

**설계 한 줄**: 진행은 **버스 이벤트 관찰**로만 판단하고, 순서 강제는 **각 폴더가 자기 거절 사유 함수에서
`ctx.tutorial?.blockReason()` 을 한 번 부르는 것**으로 이뤄진다. 튜토리얼은 남의 폴더 안을 들여다보지 않고,
남의 폴더는 튜토리얼의 단계를 모른다. 튜토리얼이 꺼져 있으면 그 호출은 언제나 `null` 이라 평소 동작이
한 글자도 바뀌지 않는다.

---

## 파일

| 파일 | 역할 |
|---|---|
| `TutorialSystem.ts` | `GameSystem` + `TutorialRef`. **3트랙 단계 기계** · 이벤트 구독 · localStorage 저장(v2) · 재료 지급 · dev 콘솔 `tutorial` 명령. `ctx.tutorial` 을 게시한다. |
| `model.ts` | 폴더 공용 어휘 — 저장 키 · blocker 토큰 · 트랙 라벨 · 튜토리얼이 만들게 하는 id들(`furn_bench_gun` · `make_wpn_ar` · `make_ammo_medium`) · 지급 재료 표 · 안내선 수치 · **목표 줄 타입**(`TutorialObjective` · `objectivesOf` · **순차 공개** `visibleObjectives` · `objectiveChain`) · **조작 가이드 표**(`TUTORIAL_CONTROL_HINTS` · `controlHintsFor` · `crouchHints` · `CONTROL_SECTIONS` · `hintPairs`) · **체크포인트 → 단계 표**(`CHECKPOINT_STEP`) · HUD 노출 기준(`HUD_GEAR_STEP` · `HUD_STAMINA_STEP`) · **목표 마커 수치**(`MARKER_*`) · **기상 유예 수치**(`WAKE_REVEAL_DELAY_S` · `WAKE_REVEAL_MOVE_M`, 2026-09-14 4차) · **갈아 끼우는 스포트라이트 목록**(`SPOT_CRAFT_CLOSE` · `SPOT_NONE` — 모듈 상수여야 한다, 아래 ⚠) · `StepDef` 타입. 상태 없음. |
| `Steps.ts` | **단계 표** — 각 단계의 이름 · **목표 줄**(`objectives`, `reveal` · `revealOn` 으로 순차 공개) · `allow`(허용 게이트) · 스포트라이트 선택자(`spot` · `spotUnion` · `spotNoDim`) · 안내선 목표(`guide` · `arriveObjective`). 진행 조건은 여기 없다 (아래 참고). `nextStep` · `stepIndexOf` · `stepCountOf` 는 **자기 트랙 안에서만** 센다 (`trackStepsOf`). |
| `ui/Controls.ts` | **우측 조작 가이드** — **그 단계에서 쓰는 조작만** 보인다 (2026-09-14 3차부터 누적이 아니라 교체). `set(hints)` 하나가 없는 줄을 지우고 · 새 줄을 넣고 · 남는 줄은 문구만 고친다. 줄은 **구간**(이동 / 화면 / 전투 / 장비)으로 묶이고 구간 사이에만 얇은 구분선이 있다. 한 줄이 쌍을 여럿 가질 수 있다(`LMB 사격 · RMB 정조준`). 키 라벨은 그릴 때 `Keys` 에서 읽고 `input:bindingsChanged` 에 다시 그린다. |
| `parts/Gates.ts` | 게이트 판정 순수 함수. `allow` 에 없는 게이트는 전부 막고, 배열이면 그 id 만 허용한다. `hides(gate, id?)` 도 여기 — **막히는 것은 곧 감추는 것**이다. |
| `parts/Guide.ts` | **바닥 안내선** — 흐르는 점선 띠(셰이더) + 목표 빛기둥 + 링. `Interactable.id` 하나로 목표를 잡는다. |
| `parts/Marker.ts` | **3D 목표 마커** (2026-09-14 3차) — 세로선 + 아래를 가리키는 chevron(하이라이트 주황)이 위아래로 천천히 오간다. 지금 쓰는 곳은 `corpseLoot` 의 목표 시체 하나다. 자리는 `ctx.interactables` 에서 찾은 시체(`kind === 'corpse'` 중 가장 가까운 것)라 **좌표가 이 폴더에 없다**. `BoxGeometry` 를 합친 절차 지오메트리 하나 · `MeshBasicMaterial` 하나 — **광원을 만들지 않는다**. chevron 이 평면이라 그룹의 yaw 만 카메라를 향해 돌린다. |
| `parts/Spotlight.ts` | **UI 포커싱** — 화면을 덮는 네 판 + 링 + 말풍선. 판이 클릭을 먹고, 구멍은 그대로 통과시킨다. 링은 **천천히 확대-축소**하고(2026-09-08), 확인 팝업(`YIELD_TO`)이 뜨면 스스로 비켜선다. 대상은 사각형이 있고 `visibility` 가 살아 있는 것만 — 닫힌 `.ship-manage` 처럼 접혀도 사각형이 남는 화면을 밝히지 않는다. `set(selectors, text, union, noDim)` 의 **합집합 모드**(2026-09-08)는 먼저 찾히는 하나가 아니라 **찾히는 전부**를 감싸는 사각형을 뚫는다 — 두 패널에 걸친 드래그를 안내할 때 쓴다. **딤 없는 모드**(`noDim`, 2026-09-14 2차)는 판을 투명하게 두고 **클릭도 통과시킨다**. ⚠ 대상을 찾는 것은 `firstShown(sel)` 하나이고 **`querySelectorAll` 로 그 선택자의 모든 사본을 훑어 실제로 그려진 첫 요소**를 쓴다 (2026-09-14 4차) — 같은 화면이 DOM 에 둘 있을 수 있기 때문이다(캐릭터 시트 = 닫힌 독립 오버레이 + 인벤토리 탭 사본). |
| `ui/Panel.ts` | 좌측 상단 목표 패널 — **퀘스트 패널 모양**(2026-09-14 2차): 글리프 + 트랙 이름 / 체크박스 목표 줄 / 트랙 진행 바. 글자 라벨(`n / m`)도 **건너뛰기 버튼도 없다**. 달성 애니메이션(체크 · 취소선이 좌→우)이 보이도록 다음 단계의 목표 줄을 `TUTORIAL_STEP_DELAY_S` 동안 **패널 안에서** 붙잡는다. 포커싱 중에는 `is-lifted` 를 단다 (상태 표시 — z 는 늘 79). |
| `ui/Popup.ts` | 시작 안내 카드와 건너뛰기 확인 카드 (같은 셸, 버튼만 다름). 모달리스. |
| `tutorial.css` | 위 셋의 스타일. `.ui-btn` · `.ui-label` 은 `ui/styles/base.css` 것을 쓴다. |

### 왜 진행 조건은 표에 없나

단계마다 "무엇으로 끝났다고 볼지"가 제각각이다 — 어떤 것은 이벤트 하나(`housing:roomPurposeChanged`),
어떤 것은 이벤트 + 조건(`loadout:changed` 뒤에 주무기 칸을 다시 읽어 본다), 어떤 것은 상태 폴링에 가깝다
(`inventory:changed` 뒤 가방에 준중량탄이 있나). 표에 억지로 넣으면 술어 함수의 목록이 되어 오히려 읽기
어려워지므로, **표는 표시와 허용만** 갖고 진행은 `TutorialSystem` 의 구독 하나하나가 갖는다.

---

## 단계 — ① `raid` (14)

레이드 트랙의 뼈대는 **체크포인트**(`tutorial:checkpoint`, owner: `world/tutorial`)다. 체크포인트는 구간의 *입구*라,
지나는 순간 앞 구간의 단계가 끝난 것이다 — 표는 `model.CHECKPOINT_STEP` 하나이고 `onCheckpoint` 가 **앞으로만**
접는다. 행동으로 끝나는 단계는 자기 이벤트를 따로 보므로 대개 체크포인트보다 **먼저** 끝나고, 뒤늦게 온
체크포인트는 `advanceIf` 가 조용히 무시한다. 그래서 선택 단계(`grenade`)를 건너뛰어도, 체크포인트 하나를
놓쳐도 안내가 막히지 않는다.

| # | id | 목표 | 다음으로 넘어가는 신호 |
|---|---|---|---|
| 1 | `wake` | **목표 없음** — 기상 연출 (`playIntroWake`). 이 단계 동안 목표 패널 · 조작 가이드를 **안 그린다** | `player:introWakeDone` |
| 2 | `move` | 갈라진 땅까지 걸어간다 (안내는 연출 뒤 **한 박자** 늦게 뜬다 — 아래 절) | 체크포인트 `cliff` |
| 3 | `sprintJump` | 달려서 뛰어넘는다 | 체크포인트 `corpse` |
| 4 | `corpseLoot` | **무기 장착**(필수) + 가방 · 탄약(선택). 총을 드는 순간 체크 + **포커싱이 꺼지고**, 넘어가는 것은 창을 닫을 때 — **지나면 체력 · 무기 HUD 가 나타난다** | `loadout:changed` 에 주무기 → `inventory:closed` · 체크포인트 `bugs` |
| 5 | `advance1` | 앞으로 이동한다 | **`enemy:spawned`** (벌레가 솟는 순간) · 보험은 체크포인트 `crawl` |
| 6 | `shoot` | 벌레 둘 처치 | `enemy:killed` × `RAID_KILLS_PER_STEP` · 체크포인트 `crawl` |
| 7 | `advance2` | 앞으로 이동한다 | 체크포인트 `crawl` |
| 8 | `crouch` | 기둥 밑을 앉아서 지난다 (**조작 가이드 라벨이 자세를 따라간다**) | `player:stanceChanged`(stand 아님) · 체크포인트 `android` |
| 9 | `crouchAim` | 앉은 채 안드로이드 둘 | `enemy:killed` × 2 · 체크포인트 `drop` |
| 10 | `advance3` | 앞으로 이동한다 | 체크포인트 `drop` |
| 11 | `drop` | 높은 곳에서 뛰어내린다 | `player:fell {damage > 0}` · 체크포인트 `supply` |
| 12 | `heal` | 휠에서 붕대를 골라 손에 → 길게 눌러 사용 + **수류탄을 챙긴다**(선택) (**체력이 가득이면 조용히 지나친다**) | `player:stimUsed` · 체크포인트 `wall` |
| 13 | `grenade` | 무너진 벽 너머로(필수) + **수류탄을 꺼내 던진다**(선택 — 터지기만 하면 달성) | 체크포인트 `ship` (수류탄을 안 써도 넘어간다) |
| 14 | `extract` | 버려진 함선의 스위치 | `extraction:departureStarted` · `extraction:liftoff` |

### 「앞으로 이동」 구간 셋 (2026-09-14 4차, 사용자 결정)

전에는 앞 구간이 끝나는 순간 다음 구간의 안내가 떴다 — 벌레를 잡자마자 「앉아서 낮은 틈을 지나세요」, 안드로이드를
잡자마자 「아래로 뛰어내리세요」. 그 물건은 아직 30 m 앞인데 안내만 먼저 도착한다. 이제 구간과 구간 사이는 언제나
`advance1` · `advance2` · `advance3` 이고, 다음 안내는 그 물건 앞에 섰을 때 뜬다.

`advance2` · `advance3` 은 **이미 있는 체크포인트**로 끝난다 (`crawl` · `drop`). 월드에 새 트리거는 없고
스포트라이트 · 안내선도 없다. 조작 가이드만 `move` 와 **같은 배열**(`MOVE_HINTS`)로 되돌아오고,
진행률 분모가 11 → 14 로 늘어난 것은 의도다.

⚠ **`advance1` 만 체크포인트로 끝나지 않는다.** `bugs` 체크포인트는 z 60 인데 벌레(−2.5, 34)·(2.5, 28)의 감지가
12 m 라 첫 마리가 솟는 자리는 z ≈ 45.7 — 체크포인트로 `shoot` 을 열면 「벌레를 처치하세요」를 띄운 채 14 m 를 더
걷는다. 체크포인트 자리는 **못 옮긴다**(부활 자리는 벌레 감지 반경 **밖**이어야 한다는 월드 규약이 그 자리를 정했다).
그래서 `CHECKPOINT_STEP.bugs` 는 `advance1` 만 열고, `shoot` 은 **벌레가 실제로 솟는 순간**(`enemy:spawned` —
`enemies/Tutorial.updateTutorialAmbush` → `parts/Pool.spawn`)이 연다. 그 이벤트를 놓쳐 `advance1` 에 머물러도
막다른 길이 아니다: 다음 체크포인트 `crawl` 이 `crouch` 로 접는다 (`shoot` 을 건너뛸 뿐이다).

### 기상 연출과 첫 안내 (2026-09-14 4차)

`PlayerRef.playIntroWake` 를 부르는 곳은 **`TutorialSystem.update()` 하나**다 — `startRaidTrack()`(그리고 새로고침으로
`wake` 에서 돌아왔을 때는 `onRaid()`)이 `pendingWake` 한 칸만 세우고 다음 프레임이 소비한다.
⚠ **같은 `game:newMission` emit 안에서 부르면 안 된다** — 그 emit 의 뒤쪽 핸들러인 `PlayerSystem` 이
`cancelIntroWake` 로 조용히 지운다 (`world:ready` 구독 안도 같은 이유로 안 된다: 그 안에서 동기 발행된다).
가드는 `step === 'wake'` 하나 — 이어하기로 중간 체크포인트에서 돌아온 사람에게 연출이 걸리면 안 된다.

연출 동안에는 `quiet` 가 서서 목표 패널 · 조작 가이드 · 스포트라이트 · 안내선을 **전부 접는다**. 연출이 끝나
`move` 로 넘어가도 곧바로 띄우지 않고 `WAKE_REVEAL_DELAY_S`(2초)를 세되, 그 안에 스스로 `WAKE_REVEAL_MOVE_M`(1 m)
움직이면 그 순간 함께 나타난다.

각 단계는 **목표 줄**(`StepDef.objectives`)을 하나 이상 갖는다 — 필수는 단계가 넘어가는 순간 전부 달성으로 그어지고,
선택은 실제로 했을 때만 체크된다 (`TutorialSystem.markObjective`). `objectives` 를 안 적은 단계는 `hint` 한 줄이
유일한 필수 목표다. 레이드 트랙을 앞으로 접는 길은 `foldRaid` 하나이고 체크포인트 · 탈출 스위치가 그것을 함께 쓴다.

### 순차 공개 (2026-09-14 3차, 사용자 결정)

할 일이 셋인 단계에서 셋을 한꺼번에 늘어놓으면 「지금 무엇을 하는가」가 묻힌다. 그래서 목표 줄에 두 필드가 붙었다.

- `reveal: true` — **앞 줄을 달성해야 보인다**. 목록 순서가 곧 차례다.
- `revealOn: '<목표 id>'` — 앞 줄이 아니라 **바깥 사건**이 여는 줄. 앞 줄이 선택 목표라 `reveal` 을 못 쓰는 자리
  (`corpseLoot` 의 「가방을 닫는다」)와, 열 앞 줄이 아예 없는 첫 줄에 쓴다.

고르는 것은 순수 함수 `model.visibleObjectives(list, done)` 하나이고 **한 줄이 안 열렸으면 그 뒤는 전부** 닫힌다.
패널은 통과한 목록만 받으므로 「안 열린 줄을 그리지 않는다」가 자동이다. 뒤 줄을 먼저 해낸 사람(휠을 안 열고
탭으로 붕대를 꺼낸 사람)의 앞 줄이 영영 안 켜져 그 뒤가 통째로 숨는 길은 `markObjective` 가 막는다 —
`objectiveChain` 으로 **앞의 공개 사슬까지 함께** 적는다.

새 줄이 나타나는 타이밍은 패널의 반 박자(`markDone` → `TUTORIAL_STEP_DELAY_S`)가 잡는다: 방금 달성한 줄의 체크 ·
취소선이 그려진 **뒤에** 다음 줄이 붙는다. 단계 기계의 타이밍은 여기서도 한 글자도 안 바뀐다.

트랙 시작은 `game:newMission {mode:'tutorial'}`, 새로고침 복귀는 `world:ready` + `ctx.missionMode === 'tutorial'`
(`startRaidTrack` — 둘 다 같은 함수로 모인다). **완주**하면 `pendingShip` 이 남아 다음 함선 진입에서 ② 가 이어지고,
**건너뛰면 남지 않는다** (조작만 아는 사람에게 「레벨이 올랐습니다」를 띄우지 않는다).

## 단계 — ② `ship` (4)

| # | id | 목표 | 다음으로 넘어가는 신호 |
|---|---|---|---|
| 1 | `levelUp` | 레벨업 확인 — 인벤토리 화면 열기 | `inventory:opened` |
| 2 | `stats` | 능력치 투자 → `포인트 투자 확정`(1초 홀드) | `progress:statChanged` |
| 3 | `messenger` | 메신저 열기 | `ui:messengerToggled {open:true}` |
| 4 | `ravenQuest` | 대답 고르기 · 퀘스트 수락 | `npc:questChanged {state:'active'}` |

새 UI 는 하나도 없다 — 전부 **기존 화면을 스포트라이트로 가리킨다** (`.scr-tabs` · `.pg-confirm` ·
`.community .cm-btn` · `.ms-qcard`).

## 단계 — ③ `build` (17)

| # | id | 목표 | 다음으로 넘어가는 신호 |
|---|---|---|---|
| 1 | `intro` | 시작 안내 카드 | 카드의 **시작** |
| 2 | `manage` | M 으로 함선 관리 (포커싱: 우측 하단 `.ship-hint`) | `housing:shipManageChanged {active:true}` |
| 3 | `generator` | 발전기 가동 (Lv.1) — **2026-09-13 부터 늘 건너뛴다** (새 함선이 Lv.1) | `housing:facilityUpgraded {id:'generator', level>=1}` |
| 4 | `workshop` | 빈 방 → 작업실 | `housing:roomPurposeChanged {purpose:'workshop'}` |
| 5 | `bench` | 총기 작업대 **제작** | `housing:changed {reason:'craft'}` + 창고에 `furn_bench_gun` |
| 6 | `benchPlace` | 가구 창고에서 **집고** → 작업실 바닥에 **내려놓기** | `housing:selectionChanged` → `housing:furniturePlaced {defId:'furn_bench_gun'}` |
| ~~7~~ | ~~`manageDone`~~ | **순서에서 빠졌다** (2026-09-14 3차) — `setStep` 이 늘 조용히 지나친다 | — |
| 8 | `craftGun` | **작업실로 이동 → 작업대 작동 → 돌격소총 제작** | `craft:completed {recipeId:'make_wpn_ar'}` |
| 9 | `craftAmmo` | **같은 창에서** 준중량탄 | `craft:completed {recipeId:'make_ammo_medium'}` |
| 10 | `openBag` | 제작 창 닫기 (장비 칸이 돌아온다) | `ui:craftToggled {open:false}` · 또는 제작 열 없이 `inventory:opened` |
| 11 | `equipGun` | **제작 창을 닫고** → **주무기 I 또는 II** 칸에 장착 | `loadout:changed` + `primary`/`primary2` 가 `wpn_ar` |
| 12 | `stowAmmo` | 탄약을 가방에 | `inventory:changed` + 가방에 `ammo_medium` |
| 13 | `terminal` | **조종석으로 이동 → 터미널 작동** | `hub:terminalToggled {open:true}` |
| 14 | `planet` | 목표 행성 지정 | `hub:planetChanged` |
| 15 | `travel` | 워프 대기 | `hub:travel {stage:'end'}` |
| 16 | `board` | **발사 슬롯으로 이동 → 탑승** | `hub:slotChanged` (로컬) 또는 `game:newMission` |
| 17 | `raid` | 탈출 지점 확인 | `world:ready` 6초 뒤 자동 종료 |

> **2026-09-09 — `openCraft` 는 순서에서 빠졌다** (그리고 2026-09-14 3차에 `manageDone` 도 — 16단계). 소총과 탄약을 **작업대 한 번**에 만들므로 장착 뒤에
> 제작 창을 다시 열 일이 없다. id 는 `TutorialStepId` 계약에 남아 있고 (`Steps.ts` 의 표에도 자리를 둔다 —
> `stepDef` 가 언제나 정의를 돌려주도록), 진행 중이던 세이브는 `normalizeStep('openCraft') → 'craftAmmo'` 로
> 옮겨 붙는다. 순서에 있는 id 인지는 `isOrderedStep` 이 판정한다.
>
> **단계 사이에 반 박자**(`TUTORIAL_STEP_DELAY_S`, 0.5초)가 있다. 새 화면이 먼저 보이고 스포트라이트 · 바닥
> 안내선이 그 뒤에 뜬다 — 작업대를 눌렀을 때 제작 창이 뜨기도 전에 구멍이 뚫려 있던 문제를 없앤다. 어두운 판은
> `TUTORIAL_DIM_FADE_S` 동안 서서히 어두워진다 (`.tut-spot.is-lit`).

> `openCraft` 는 2026-09-09 에 생겼다 (사용자 요청). 장착까지 마치고 나면 다음 할 일이 "탄약을 만든다"인데
> 제작 창이 닫혀 있어서, 안내는 제작 행을 가리키는데 그 행이 화면에 없었다. 이제 **가방 우측 상단의 `제작`
> 버튼**(`.inv-bag-craft`)을 밝히는 단계가 하나 들어간다. 넘어가는 신호는 "제작 열이 열렸다" 하나이고, 그 사실이
> 두 경로로 온다 — 작업대 경로는 `ui:craftToggled {open:true}`, 가방 버튼 경로는 제작 열이 자기 줄을 올리는
> `ui:keyGuide {owner:'inventory.craft'}` (`keys ≠ null` = 열림). `TutorialSystem.onCraftPanel` 이 둘을 한곳에 모은다.
> 작업실에 총기 작업대가 놓여 있으면 그 레시피가 가방 제작 창에도 뜨므로(`getRecipes` 가 `getBenchLevel` 로 찾는다)
> 어느 쪽으로 열어도 준중량탄을 만들 수 있다.

> `openBag` 는 **제작 화면이 장착 장비 칸을 숨기게 된 뒤**(2026-09-08, `src/inventory`) 생겼다. 그 전에는
> `equipGun` 이 곧바로 `.inv-slot-primary` 를 밝혔는데, 작업대가 열린 화면에는 그 칸이 아예 없었다.
> 이제 ① 제작 창을 닫고 ② 가방 → 주무기 칸으로 끌어다 놓는 두 단계로 갈라져 있다.
>
> `equipGun` · `stowAmmo` 는 **합집합 포커싱**(`StepDef.spotUnion`)을 쓴다 — 드래그는 **두 패널에 걸친 동작**이라
> 도착점 하나만 밝히면 집을 곳이 어두운 판 아래 깔려 손이 묶인다. 구멍은 언제나 사각형 하나이므로 맞닿은 것들만
> 넘긴다: `equipGun` 은 `.inv-equip` + `.inv-panel-bag`(−24 px 이음매로 실제로 붙어 있다), `stowAmmo` 는
> `.inv-panel-stash` + `.inv-panel-bag`.

> **`manageDone` 은 2026-09-14 3차에 순서에서 빠졌다** (사용자 결정). 「닫으세요」만 하는 단계를 세워 둘 이유가
> 없다 — 다음 단계(`craftGun`)는 어차피 작업실로 걸어가는 일이고, 관리 모드는 플레이어가 아무 때나 닫으면 된다.
> `TUTORIAL_TRACK_STEPS`(계약, `src/shared`)는 추가만 하는 규약이라 배열에서 뺄 수 없으므로, `openCraft` 처럼
> **표에는 남기고** `TutorialSystem.setStep` 이 `generator` 와 같은 요령으로 **늘 조용히 지나친다**. 옛 저장의
> `manageDone` 은 `normalizeStep` 이 `craftGun` 으로 옮겨 붙인다. 진행 바의 분모는 여전히 17 이다 (계약이 그렇다 —
> `generator` 도 같이 세어진다). 관리 모드가 열린 채 `craftGun` 에 들어설 수 있으므로 그 단계의 `allow` 가
> 총기 작업대 카드를 계속 허용한다 — 옛 `manageDone` 이 그랬던 이유 그대로 목록이 통째로 비지 않게.
> (2026-09-09~2026-09-14 2차 동안 이 단계는 우측 하단 키 가이드 `.key-guide .kg-close` 를 밝혔다.)

> `generator` 는 **시설 증축의 전제 조건**이다. 이 단계가 없던 동안에는 발전기 Lv.0 인 새 함선에서
> 작업실 행이 바로 포커싱되고 발전기 게이트에 막혀 **진행 자체가 불가능**했다 (2026-09-08 수정).
> 발전기가 이미 Lv.1 이상인 함선이면 `setStep` 이 이 단계를 조용히 지나친다.
> **2026-09-13 (전력 할당 폐지, 사용자 결정)**: 새 함선의 발전기가 처음부터 **Lv.1** 이고 작업실은 Lv.1 로 지어지므로 이 단계는
> **언제나** 지나쳐진다 — 실제 흐름은 `manage` → `workshop` 이다. 단계 id 는 `TutorialStepId` 계약이라 표에 남긴다 (`openCraft` 와 같은 처리).

> `bench` 와 `benchPlace` 가 갈라진 것도 같은 이유다 (2026-09-08). 가구는 **제작하면 가구 창고로 들어가고**
> 배치는 창고 탭에서 다시 골라야 하는데, 한 단계로 묶여 있던 동안에는 스포트라이트가 제작 카드에 붙은 채
> **가구 창고 탭도 · 내려놓을 바닥도 어두운 판에 덮여** 아무것도 누를 수 없었다. 지금은 ① 제작 ② 창고에서
> 집기 ③ 바닥에 놓기가 각각 자기 안내를 갖고, **가구를 집는 순간 스포트라이트가 스스로 접힌다**
> (`onSelection` — 남은 일이 3D 바닥 클릭뿐이라 밝힐 UI 가 없다. 목표 부제만 바닥 안내로 바뀐다).

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
| `stashItem` | `inventory/ui/InventoryUI` (창고 격자, `hides`) | 흰 목록 밖의 **함선 창고 아이템 전부 숨김** — **증축 트랙에서만** (2026-09-14: 레이드에서 돌아온 전리품을 함선 트랙이 감추면 안 된다) |
| `hud` | `ui/hud/Vitals` · `WeaponPanel` · `ImplantWidget` · `StratagemPanel` (`hides('hud', <part>)`) | **HUD 점진 노출** — 아래 절 |

### HUD 점진 노출 (2026-09-14)

`hides('hud', id)` — id 는 `TutorialHudPart`(`vitals` · `weapon` · `stamina` · `implant` · `stratagem`). **숨김 전용**이라
`blockReason('hud', …)` 은 언제나 `null` 이고, 판정은 **레이드 트랙 안에서만** 산다 (`parts/Gates.hudHidden`) —
함선 · 증축 트랙과 평소 플레이에서는 전부 `false` 라 화면이 한 글자도 안 바뀐다.

| 조각 | 언제 나타나나 |
|---|---|
| `vitals`(체력 · 실드) · `weapon` | 시체에서 장비를 얻는 단계(`HUD_GEAR_STEP` = `corpseLoot`)를 **지나면** |
| `stamina` | **처음 소모될 때** (`player:sprintChanged` · `player:staminaDepleted` → `hudState.staminaUsed`). 늦어도 `HUD_STAMINA_STEP`(`sprintJump`)을 지나면 — 새로고침 보험이다 |
| `implant` · `stratagem` | 튜토리얼 레이드가 끝날 때까지 **안 나타난다** (장착한 것도, 부를 것도 없다) |
| `shipMarker` · `shipScreenMarker` · `extractionTimer` | 튜토리얼 레이드 **내내 안 나타난다**. `shipMarker`(지도 · 월드 마커)는 2026-09-14 4차부터 `extract` 에서도 안 풀린다 — 함선 위에 뜨던 초록 원(`.wmarker.ship`)이 「저게 뭐지」가 됐고, 일직선 통로라 마커 없이도 함선을 못 찾을 수 없다 (사용자 결정) |

호출부는 전부 위젯이 **자기 이름으로 한 줄** 묻는 것이고, 접는 방법은 `.hud-tut-hidden`(`ui/styles/raidHud.css`,
`display:none !important`) 하나다 — 위젯마다 이미 쓰는 `hidden` · `.show` · `.off` 와 싸우지 않게 클래스를 갈랐다.
`WeaponPanel` 만 매 프레임 도는 `update` 가 없어(전부 이벤트 구동) `tutorial:changed` · `world:ready` ·
`game:phaseChanged` 세 순간에 다시 묻는다. 스태미나처럼 **표로 못 정하는 상태**가 바뀌면
`TutorialSystem.markStaminaUsed` 가 `tutorial:changed` 를 한 번 더 낸다.

---

## 우측 조작 가이드 (2026-09-14 · 3차)

**그 단계에서 쓰는 조작만 보인다** (`ui/Controls.ts`, CSS `.tut-controls`, 머리 라벨 `조작`). 우하단 키
가이드(`ui/hud/KeyGuide`, `.key-guide` — right 28 / bottom 28 / z 84)와 **주인도 자리도 다르다**: 그쪽은 "지금 열린
**화면**의 키"라 화면이 열리고 닫힐 때마다 갈리고, 이쪽은 "지금 **구간**에서 쓰는 조작"이다.

**2026-09-14 3차 (사용자 결정) — 누적에서 교체로.** 예전에는 배운 줄이 쌓이기만 해서 레이드 끝에는 여덟 줄이
우측을 채웠고, 정작 지금 배우는 키가 그 안에 파묻혔다. 이제 `TUTORIAL_CONTROL_HINTS[step]` 은 「그 단계에
**보일** 줄 전부」이고 단계가 바뀌면 `TutorialControls.set(hints)` 가 **없는 줄을 지우고 · 새 줄을 넣고 ·
남는 줄은 문구만 고친다**(요소를 다시 만들지 않으므로 살아남은 줄이 깜빡이지 않는다).

- ⚠ **표에 없는 단계는 직전 단계의 줄을 그대로 유지한다** (`wake` · `sprintJump` · `crouchAim` · `drop` — 새로
  배우는 키가 없는 단계). `undefined` = 유지, 빈 배열 = 비우기라 뜻이 다르다.
- **`move` 단계에 이동 · 달리기 · 점프 세 줄이 한꺼번에** 뜬다 (기상 직후 — 사용자 결정). 그래서 `sprintJump` 는
  표에 줄이 없다.
- **`crouch` 단계의 두 줄은 자세를 따라간다** (`model.crouchHints(stance)`): 서 있으면 `앉기` · `포복`,
  앉아 있으면 C 가 `일어서기`, 엎드려 있으면 Z 가 `일어서기`. `player:stanceChanged` 에 다시 그린다
  (`applyControls(step, force)` — 줄 목록은 같고 **문구만** 바뀌는 유일한 자리다).
- 단계별 줄: `move` · `advance1` · `advance2` · `advance3` 이동·달리기·점프(같은 배열 `MOVE_HINTS`) /
  `corpseLoot` 상호작용·가방 / `shoot` 사격+정조준·재장전 /
  `crouch` 앉기·포복 / `heal` 빠른 사용(꺼내기 + 휠)·길게 눌러 사용 / `grenade` 빠른 사용·던지기 / `extract` 지도.

**자리 (2026-09-14 2차)**: 우하단 무기 패널(`.weapon` bottom 32 — `.wbox` ≈ 108 + 퀵슬롯 54 + gap → 위 끝이
바닥에서 약 202 px)과 그 아래 키 가이드를 **가리지 않도록** `bottom: 232px` 를 자기 바닥으로 삼고,
위로는 `top: 104px`(메신저 버튼 `.community` top 28 + 64 아래)까지의 띠 안에서 세로 가운데에 선다
(`height: fit-content` + `margin-block: auto`, `max-height: calc(100vh - 336px)`). 1440×900 · 1920×1080 둘 다에서 겹치지 않는다.

- **구간**(`ControlSection` — `move` 이동 / `screen` 화면 / `combat` 전투 / `gear` 장비)으로 묶이고 구간 사이에만
  얇은 구분선이 있다. 구간 상자는 **첫 줄이 들어올 때 생겨** 제 자리에 끼워지므로 빈 구간은 DOM 에 아예 없다 —
  그래서 구분선이 `.tut-ctl-sec + .tut-ctl-sec` 한 줄로 끝난다 (`:empty` + 인접 선택자는 숨은 상자를 그대로 세어
  맨 위에 선을 남긴다). **해금은 여전히 줄마다 따로**다.
- 한 줄이 **쌍을 여럿** 가질 수 있다 (`ControlHint.more` — `LMB 사격 · RMB 정조준`이 한 줄이다).
- **인벤토리 화면이 열려 있는 동안에는 접힌다** (`inventory:opened` / `inventory:closed`). 그 화면이 우측을 통째로 쓴다.
- 표는 `model.TUTORIAL_CONTROL_HINTS` (자세를 타는 단계는 `controlHintsFor(step, stance)` 가 갈라 준다).
- 표가 들고 있는 것은 **키 액션 이름**(`FORWARD` · `SPRINT` …)뿐이다 — 라벨은 그릴 때 `keyLabel(Keys[action])`
  로 만들고 리바인드하면 `input:bindingsChanged` 에 다시 읽는다 ([docs/CONTROLS.md](../../docs/CONTROLS.md)).
- 꾹 누르는 줄은 기존 `.keycap.kc-hold` 규약을 **그대로** 쓴다. HUD 위젯과 같은 이름의 modifier 를 새로 만들지
  않는다 (2026-09-10 `kc-hold` 사고: `.hold` 가 크로스헤어 홀드 링과 겹쳐 키캡이 통째로 사라졌다).
- **지금** 떠 있는 줄의 id 가 `TutorialSave.learned` 에 남아 새로고침을 견디고, 트랙이 끝나면 비워진다
  (2026-09-14 3차부터 「쌓인 줄」이 아니라 「지금 줄」이다 — 옛 저장의 누적 목록도 그대로 뜨고, 다음 단계
  전환이 그 자리를 지금 줄로 갈아 끼운다).

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
| `inventory/ui/GridView` (창고 뷰) | 안내에 쓰지 않는 **창고 아이템** — 타일을 아예 그리지 않는다 |

목록이 통째로 비면 그것대로 이상하므로 `Steps.ts` 가 인접 단계의 항목을 열어 둔다 — `craftGun` 은 작업대
카드를(옛 `manageDone` 이 하던 몫, 2026-09-14 3차), `equipGun` · `stowAmmo` 는 직전 단계의 레시피를 그대로 허용한다. 네 호출부 모두 캐시 키에 현재
단계를 섞고 `tutorial:changed` 를 구독하므로, **건너뛰거나 끝나면 감춰 둔 것이 그 자리에서 전부 돌아온다.**

---

## 시작 · 저장 · 재시작

### 트랙 이어 가기 (2026-09-14)

`hub:entered {ship:'personal'}` 하나가 관문이고 순서는 `autoStart()` 세 줄이다 — 각 줄의 근거가 다르다.

1. **레이드** — *함선 안에 있다는 것 자체가* 그 트랙이 뒤에 있다는 뜻이다 (완주했든 · 건너뛰었든 · 진입 흐름이
   아직 레이드로 안 보내는 옛 경로든). 조용히 `done` 으로 적는다.
2. **함선** — 레이드를 **완주하고 막 돌아온 그 한 번**만 (`pendingShip`). 그렇지 않으면 `done` 으로 적는다.
3. **증축** — 2026-09-08 부터의 규칙 그대로 **손대지 않은 함선**일 때만. ⚠ 여기서 보는 것은
   `shipUntouched()`(가구 0 · 용도 있는 방 0)이지 `looksFresh()`가 **아니다** — 튜토리얼 레이드를 마치고 온
   사람은 이미 레벨 2 지만 함선은 여전히 빈 함선이고, 그 사람이야말로 증축 안내를 받아야 할 사람이다.
   레벨 조건은 「저장이 아예 없는 프로필」을 가르는 데만 쓴다.

함선 트랙이 끝나면 `finish()` 가 그 자리에서 `autoStart()` 를 한 번 더 불러 증축 트랙으로 이어진다.
`skipTrack(track)` 은 **그 트랙만** 푼다 — 다른 트랙은 그대로 남아 제 때 시작한다 (사용자 결정).

### 저장 — `TutorialSave` **v2**

```jsonc
{ "version": 2,
  "tracks": { "raid": { "step": null, "done": true }, "ship": …, "build": { "step": "craftGun", "done": false } },
  "granted": true, "benchUid": "f-7", "pendingShip": false, "learned": ["move", "sprint"],
  "objectives": ["corpseBag"], "topped": ["craftGun"] }
```

`objectives` (2026-09-14 2차)는 **지금 단계에서** 달성한 목표 id 다 — 선택 목표를 해 놓고 새로고침했을 때
체크가 사라지지 않게 하는 것이 전부이고, 단계가 넘어가면 비워진다.

- **v1 → v2 마이그레이션**: v1 의 최상위 `step` · `done` 은 전부 지금의 `build` 트랙 것이었으므로 그리로 옮겨
  붙이고, 그 프로필은 **레이드 · 함선 트랙을 이미 끝낸 것으로 본다**. 안 그러면 하던 사람이 다음 접속에서
  튜토리얼 레이드로 끌려간다 — `isTrackDone('raid')` 가 진입 흐름(`ui/menus/enterShip`)을 정하기 때문이다.
- **저장이 아예 없는 프로필**도 모양이 같다(새 캐릭터든, 튜토리얼이 없던 시절부터 하던 사람이든). 그래서
  `isTrackDone` 은 그 트랙의 기록이 없으면 `!looksFresh()` 로 답한다 — 이미 하던 사람에게는 전부 `true` 다.

- **자동 시작**: `hub:entered {ship:'personal'}` 에서, 저장이 없고 **정말 새 캐릭터일 때만**.
  "새 캐릭터"는 `looksFresh()` 가 본다 — 놓인 가구 0 · 용도 있는 방 0 · 레벨 1. **2026-09-12**: 조종석의 기본 공용 가구
  (`COCKPIT_DEFAULT_FURNITURE` — 전술 임플란트 시술대 · 기업 네트워크 컴퓨터)는 모든 함선에 늘 놓여 있으므로 「놓인 가구」에서 뺀다
  (빼지 않으면 새 함선도 꾸민 함선으로 읽혀 튜토리얼이 영영 시작되지 않았다 — `smoke-tutorial` 이 잡았다). 튜토리얼이 없던 시절부터
  하던 프로필도 `scav.tutorial` 이 없기는 마찬가지라, 그런 프로필은 조용히 `done` 으로 표시하고 다시는 켜지 않는다.
- **저장**: `scav.tutorial` (`TutorialSave` + `granted` · `benchUid`). 단계가 바뀔 때마다 쓰므로 새로고침을 견딘다.
  `ui/menus/newCharacter.resetCharacterSaves()` 가 `scav.` 접두 키를 전부 지우므로 **새 캐릭터로 시작**하면 다시 돈다.
- **끝내기**: 완주(`raid` 6초 뒤) 또는 **건너뛰기**. 둘 다 `done: true` 로 남고 모든 게이트가 풀린다.
  **2026-09-14 2차부터 건너뛰기는 ESC 메뉴에서 한다** (`TutorialRef.skipTrack(track)` — 목표 패널의 버튼은 없어졌다).
  시작 안내 카드의 `건너뛰기` → 확인 카드(1초 홀드) 경로는 그대로다.
- **다시 보기**: dev 콘솔 `tutorial start` / `tutorial skip` / `tutorial step <id>` / `tutorial status`.

## 재료 지급

기본 지급품(`STARTER_STASH`)은 발전기 Lv.1 + 작업실 증축 + 작업대 제작으로 폐금속 20 · 케이블 3 · 합금 2 를
쓰도록 맞춰져 있어서, **작업대를 짓고 나면 아무것도 만들 수 없다**. 두 겹으로 채운다.

1. **바닥 (한 번)** — `craftGun` 에 들어설 때 `TUTORIAL_CRAFT_GRANT`(폐금속 16 · 합금 2 · 화약 20)를 넣는다
   (`granted` 플래그로 튜토리얼당 한 번).
2. **top-up (2026-09-09, 멱등)** — 제작 단계(`craftGun` · `craftAmmo`)에 들어설 때마다
   `ensureMaterials(recipeId)` 가 **그 레시피의 재료를 하나씩 보고 `필요 − 보유` 만큼만** 더 준다. 필요량은
   레시피(`ctx.loot`)에서 읽으므로 코드에 숫자가 없고, 보유는 `canCraft` 와 같은 자리(가방)를 본다. 가방부터
   넣고 자리가 없으면 함선 창고로 (`tryAddItemAnywhere`). 모자란 것이 없으면 아무 일도 없고 토스트도 뜨지 않는다.

②가 생긴 이유는 명확하다: 소총이 폐금속을 먹고 나면 준중량탄의 폐금속이 모자라서 **제작 자체가 불가능**했다
(2026-09-09 사용자 보고). 고정 표를 키우는 대신 부족분만 채우는 쪽을 골랐다 — 레시피 수치를 csv 에서 바꿔도
안내가 계속 성립한다. **2026-09-10 제작 대개편이 그 설계를 그대로 증명했다**: 소총이 `폐금속 6 · 합금 1` →
`폐금속 8` 로, 탄약이 `화약 16 · 폐금속 5`(대량 90발) → `화약 6 · 폐금속 2`(30발) 로 바뀌었는데 `ensureMaterials`
는 한 글자도 고치지 않았다 — 재료 종류와 수량을 그때그때 `ctx.loot` 의 레시피에서 읽기 때문이다.
`TUTORIAL_CRAFT_GRANT`(바닥)만 주석의 근거 수치를 새 값으로 고쳤다.

같은 이유로 **총기 작업대 Lv.1 에 `make_wpn_ar`(돌격소총 제작) 레시피를 새로 넣었다** — 그 전에는 작업대
Lv.1 이 대량 탄약밖에 못 만들어 "작업대로 총을 만든다"는 동작 자체가 없었다 (`src/items/Recipes.ts`).

## 스모크

`scripts/smoke-tutorial.mjs` — **증축 트랙**(16단계)을 끝까지 몰고, 3트랙 계약(어느 트랙이 도는가 ·
`isTrackDone` · HUD 게이트가 증축 트랙에서 아무것도 안 감추는가 · 조작 가이드가 안 뜨는가)을 덧붙여 본다.
트랙 ①(레이드 조작)의 스모크는 그 트랙을 구현하는 쪽(`world/tutorial`)이 더한다.

`scripts/smoke-tutorial-ship.mjs` (2026-09-15, E-12) — **함선 트랙**(4단계)을 끝까지 실제 입력으로 몬다: 레이드 트랙의 완주 경로
(`extract` → `finish(false)` → `pendingShip`) + `TUTORIAL_RAID_XP` 로 Lv.2 → 함선 진입 → Tab(levelUp) · 이미 열린 창의 캐릭터 탭 클릭 →
보이는 `.cs-col` 구멍 · ＋ 클릭 · `포인트 투자 확정` 1초 포인터 홀드 → 새로고침(v2 저장, `messenger` 에서 이어짐) → 레이븐 첫 연락 ·
P → 대화 줄 클릭 · 선택지 클릭 → 답 → `introAfter` → 퀘스트 카드(타이핑 연출 순서) → [수락] → `tutorial:finished {ship}` → 증축 트랙 intro.

**다른 스모크는 전부** `evaluateOnNewDocument` 에서 `scav.tutorial` 을 done 으로 심고 시작한다 — 튜토리얼은
새 프로필에서 자동으로 켜져 그 스크립트들이 드라이브하는 행동을 순서대로 잠그기 때문이다. **2026-09-14 부터
그 모양은 v2 다** — 세 트랙 **모두** done 이어야 한다:

```js
localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 2, tracks: {
  raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true } } }));
```

---

## 변경 이력

프로젝트 전체 이력은 [docs/HISTORY.md](../../docs/HISTORY.md) 에 있다.

- **2026-09-15 (함선 트랙 주행 스모크, E-12)** — `scripts/smoke-tutorial-ship.mjs` 가 처음으로 함선 트랙을 끝까지 몰며 셋을 잡았다.
  ① `messenger` 포커싱이 **투명한 버튼**을 둘렀다 — `stats` 가 인벤토리 창 안에서 끝나 이 단계는 창이 열린 채 시작하는데,
  그동안 `.community` 는 `opacity: 0` 으로만 접혀 사각형이 남는다(`Spotlight.firstShown` 은 visibility 만 본다). 선택자를
  `.community.show .cm-btn` · `.community.show` 로 좁혔다. ② `ravenQuest` 의 `.ms-page.chats` 는 오타였다(페이지 클래스는
  `.ms-page.chat`) — 구멍이 틀 전체(`.ms-frame`)로 흘렀다. ③ 「레이븐의 연락에 대답한다」를 적는 곳이 없어 수락할 때 두 줄이
  한꺼번에 그어졌다 — `npc:message {npc: TUTORIAL_RAVEN_NPC, entry.e: 'choice'}` 가 `ravenQuest` 에서 그 줄을 적는다
  (`model.TUTORIAL_RAVEN_NPC` 신설). `smoke-tutorial` 91 / 0 그대로.

- **2026-09-14 5차 (오프닝이 끝나지 않던 것 — 이 폴더 코드는 무변경)** — 4차에서 배선한 기상 연출이 `player/parts/IntroWake` 의 **음수 타이머
  버그**로 끝나지 않았다: 타이머가 0 을 지나친 프레임에 `endIntroWake` 가 「연출 중 아님」 으로 읽고 돌아가 `player:introWakeDone` 이 안 왔고,
  `wake` 에 머문 채 목표 패널 · 조작 가이드가 안 떴다(`cliff` 체크포인트가 접을 때까지). 페이드도 reduced motion 에서 한 프레임에 끝났다.
  둘 다 player/ · ui/ 에서 고쳤고(카메라는 일어서며 백뷰로 블렌드 · 나침반은 연출 뒤 페이드인 · Tab 은 연출 끝까지 무시 · 튜토리얼 레이드는
  시계 · 탈출 타이머 없음 — 사용자 결정), 흐름 전체를 `scripts/smoke-intro-wake.mjs` 가 진짜 생성 → 새로고침 → 기상으로 잰다.
  이 폴더의 `wake` 단계 조건(`player:introWakeDone`)과 `pendingWake` 예약은 그대로 옳았다.

- **2026-09-14 4차 (오프닝 배선 · 「앞으로 이동」 · 목표 정리 — 사용자 결정, `docs/DECISIONS.md` 「2026-09-14 — 튜토리얼 개편」)**
  ① **오프닝이 실제로 돈다.** `PlayerRef.playIntroWake` 를 **`src/` 어디서도 부르지 않아** 2초 페이드도 쓰러진 채
  일어나는 애니메이션도 한 번도 나오지 않았다 (`player:introWakeDone` 이 영영 안 와도 `cliff` 체크포인트가
  `sprintJump` 까지 접어 줘서 진행이 막히지 않아 눈에 안 띄었다). 부르는 자리는 `update()` 의 **다음 프레임**이다 —
  위 「기상 연출과 첫 안내」 절의 ⚠ 가 왜 거기여야 하는지를 적어 두었다.
  ② **`wake` 는 목표가 없고 안내를 그리지 않는다** (`objectives: []` + `quiet`). 연출이 끝나면 `move` 로 넘어가되
  패널 · 조작 가이드는 `WAKE_REVEAL_DELAY_S`(2초) 뒤 또는 `WAKE_REVEAL_MOVE_M`(1 m) 움직인 그 순간에 함께 뜬다.
  ③ **`advance1` · `advance2` · `advance3`** — 구간 사이의 「앞으로 이동」 (raid 11 → 14 단계). 위 절 참고.
  ⚠ `CHECKPOINT_STEP.bugs` 는 `shoot` → **`advance1`** 로 바뀌었고 `shoot` 은 `enemy:spawned`(벌레가 솟는 순간)가
  연다 — 체크포인트(z 60)와 스폰 자리(z ≈ 45.7)가 14 m 어긋나 있기 때문이다. 위 ⚠ 절이 그 계산과 보험을 적어 두었다.
  ④ **`corpseLoot` 목표 셋** — `corpseStim`(그 시체에 회복 아이템이 없다) · `corpseClose`(닫기는 목표가 아니다) 삭제.
  총을 드는 순간 **스포트라이트를 끈다**(`stepView`), 다음 단계로 넘기는 것은 그대로 `inventory:closed` 다.
  ⑤ **`heal` 두 줄 + 선택 하나** — `healStock`(빠른 사용 칸에 올린다) 삭제: 붕대 · 수류탄은 주우면 빈 휠 칸에
  **자동 등록**된다(`inventory/parts/AutoQuick`). 그래서 딤 없는 포커싱 `SPOT_HEAL_STOCK` 과 `quick:wheelChanged` ·
  `inventory:quickSlotsChanged` 구독도 함께 없어졌다. 선택 목표 「수류탄을 챙긴다」(`healGrenade`)가 붙었다.
  ⑥ **`grenade` 선택 목표** 「수류탄으로 처치」 → **「꺼내 던진다」** (`grenade:exploded` 한 줄, 처치 여부를 안 본다).
  `GRENADE_KILL_WINDOW_S` 와 `onKill` 의 막타 계열 판정이 함께 없어졌다.
  ⑦ **`stats` 스포트라이트 버그** — `Spotlight` 가 `document.querySelector` **하나**로 대상을 찾고 있었는데, 캐릭터
  시트는 DOM 에 **둘** 있다: `progression` 이 부팅 때 세워 두는 독립 오버레이(`.menu.char-sheet`, 닫혀 있는 동안
  `[hidden]` = `display:none`)와 인벤토리 캐릭터 탭의 사본(`SheetView`)이 같은 `SheetBody` 를 그린다. `progression` 이
  `inventory` 보다 먼저 등록되므로 **닫힌 쪽이 문서 순서에서 앞**이라 `.pg-confirm` · `.pg-alloc` · `.cs-col` 이 전부
  숨은 사본을 집었고, 사각형이 없으니 그 선택자가 통째로 실패한 것으로 읽혀 보험 선택자 `.inv-root .scr-tabs` 까지
  흘러내렸다. 이제 `firstShown(sel)` 이 `querySelectorAll` 로 **그려진 첫 요소**를 고른다. 선택자도 `.cs-col` 부터로
  바꿨다 — `.pg-confirm` 만 뚫으면 정작 **＋ 버튼이 어두운 판 밑**이라 투자 자체가 안 된다.
  ⑧ **탈출 함선 마커** — `hides('hud','shipMarker')` 가 `extract` 에서 풀리던 한 줄을 **레이드 내내 숨김**으로.
  함선 위에 뜨던 초록 원(`ui/hud/WorldMarkers` 의 `.wmarker.ship`)이 정체 모를 물체로 보였다 (사용자 결정).

- **2026-09-14 3차 (순차 공개 · 조작 가이드 교체 · 목표 세분화 — 사용자 결정, `docs/DECISIONS.md` 「2026-09-14 — 튜토리얼 개편」)**
  ① **목표 순차 공개** — `TutorialObjective.reveal`(앞 줄을 달성해야 보인다) · `revealOn`(바깥 사건이 연다).
  고르는 것은 순수 함수 `visibleObjectives` 하나이고 패널은 통과한 줄만 받는다. 뒤 줄을 먼저 해낸 사람의 앞 줄이
  안 켜져 그 뒤가 통째로 숨는 길은 `markObjective` 가 `objectiveChain` 으로 막는다. 위 「순차 공개」 절 참고.
  ② **조작 가이드가 누적에서 교체로** — `TUTORIAL_CONTROL_HINTS[step]` 이 「그 단계에 **보일** 줄 전부」가 됐고
  `TutorialControls.set(hints)` 가 지우고 · 넣고 · 문구만 고친다. 머리 라벨 `배운 조작` → **`조작`**.
  **표에 없는 단계는 직전 줄을 유지**한다(`undefined` ≠ `[]`). `move` 에 이동 · 달리기 · 점프가 한꺼번에 온다.
  ③ **자세를 따라가는 앉기 / 포복 라벨** — `crouchHints(stance)`. `player:stanceChanged` 에 `applyControls(step, true)`
  로 **문구만** 다시 그린다 (줄 목록이 같아도 갈아 끼우는 유일한 자리라 `force` 가 있다).
  ④ **`corpseLoot` 는 가방을 닫아야 넘어간다** — 총을 드는 순간 넘기면 아직 인벤토리를 보고 있는 사람의 등 뒤에서
  목표가 바뀐다. `loadout:changed` 는 목표 `corpseGun` 을 적기만 하고, 다음 단계는 `inventory:closed` 다.
  「가방을 닫는다」 줄은 `revealOn: 'corpseGun'` 으로 그때 열린다(앞줄이 선택 목표라 `reveal` 을 못 쓴다).
  `HUD_GEAR_STEP` 의 뜻은 그대로다 — 이 단계를 **지나면** 체력 · 무기 HUD.
  ⑤ **3D 목표 마커** (`parts/Marker.ts`) — `corpseLoot` 의 목표 시체 위에 세로선 + 아래를 가리키는 chevron 이
  주황으로 서서 천천히 오간다. 자리는 `ctx.interactables` 의 `kind === 'corpse'` 중 가장 가까운 것이라
  **좌표가 이 폴더에 없다**(`world/tutorial` 이 시체를 옮겨도 따라간다). 광원 0 · 절차 지오메트리 하나.
  ⑥ **회복(`heal`) 4줄** — 「붕대를 빠른 사용 칸에 올린다」(필수) → 휠에서 고른다 → 손에 든다 → 길게 눌러 쓴다
  (뒤 셋은 선택 + 순차 공개). 올리기 전에는 **시체 격자 + 빠른 사용 로제트**를 딤 없이 함께 밝히고, 올린 뒤에는
  밝힐 UI 가 없다(휠은 화면이 아니라 손가락이다 — 조작 가이드가 살아 있는 키를 그린다). 체력이 가득이면
  단계 전체를 조용히 지나가는 동작은 **그대로**다.
  ⑦ **함선 트랙 목표 세분화** — 「이동 → 작동 → 만들기」. `terminal` = 조종석으로 이동 → 터미널 작동,
  `craftGun` = 작업실로 이동 → 작업대 작동 → 돌격소총 제작, `board` = 발사 슬롯으로 이동 → 탑승,
  `benchPlace` = 집는다 → 내려놓는다, `equipGun` = 제작 창을 닫는다 → 장착. **단계 수는 안 늘렸다.**
  「…으로 이동」의 달성 신호는 새 이벤트가 아니라 `StepDef.arriveObjective` + `ctx.interactables` 로 잰
  **상호작용 범위 안에 들어섰나**다 (`TutorialSystem.poll`).
  ⑧ **`manageDone` 이 순서에서 빠졌다** — `setStep` 이 늘 조용히 지나치고 `normalizeStep` 이 옛 저장을 `craftGun`
  으로 옮긴다. 위 `manageDone` 주석 참고.
  ⑨ **버그 둘** — (a) `levelUp` 이 **인벤토리가 이미 열린 채** 캐릭터 탭을 누르면 안 넘어갔다(`inventory:opened`
  가 안 온다): `poll()` 이 `ctx.inventory.screenTab` 이 `inventory` 가 아닌지도 본다. (b) `equipGun` 포커싱이
  제작 창이 열려 있으면 장비 칸을 못 찾아 가방만 밝혔다: 제작 창이 열려 있는 동안에는 목표 줄 「제작 창을
  닫는다」와 `.inv-craft-close` 포커싱이 먼저고, 닫히면 장비칸+가방 합집합으로 넘어간다 (`stepView`).
  ⚠ 상황에 따라 갈아 끼우는 스포트라이트 목록은 **모듈 상수**여야 한다 (`SPOT_CRAFT_CLOSE` · `SPOT_HEAL_STOCK` ·
  `SPOT_NONE`) — `Spotlight.set` 이 배열을 **참조로** 비교해 「대상이 바뀌었다」를 판단하므로, 부를 때마다 새
  배열을 넘기면 `refreshVisuals` 가 돌 때마다 포커싱이 꺼져 영영 안 켜진다.

- **2026-09-14 2차 (목표 패널 = 퀘스트 패널 · 조작 가이드 구간 · corpseLoot · heal — 사용자 결정)**
  ① **목표 패널 전면 개편** (`ui/Panel.ts` + css). `조작 안내 n / m` 글자 라벨이 사라지고 그 자리를 **트랙 진행
  바**가 대신한다. `제목 + 부제` 두 줄은 **체크박스가 달린 목표 줄 목록**이 됐다 (`StepDef.objectives`, 없으면
  `hint` 한 줄이 유일한 필수 목표). 필수 목표는 **단계가 넘어가는 순간** 전부 달성으로 그어지고(`completeRequired`),
  선택 목표는 실제로 했을 때만 체크된다(`markObjective`). 달성 연출은 체크가 좌→우(`stroke-dashoffset`)로 그려지고
  취소선이 좌→우(`clip-path` + line-through 겹침 — `::after` 막대 하나로는 **두 줄로 접힌 목표**의 허공에 줄이
  그어진다)로 그어지며 글자가 회색이 된다. 그 연출이 보이도록 다음 단계의 목표 줄을 `TUTORIAL_STEP_DELAY_S`
  (csv, 0.5초 — 스포트라이트 · 안내선이 이미 쓰는 창) 동안 **패널 안에서** 붙잡는다 — **단계 기계의 타이밍은
  한 글자도 안 바뀌었다**(미루는 것은 그리기뿐이다).
  ② **패널의 건너뛰기 버튼 삭제** — 건너뛰기는 ESC 메뉴(`skipTrack`)로 갔다. 시작 카드의 `건너뛰기` → 확인
  카드(1초 홀드)는 그대로다. `setLifted` · `is-lifted` 는 남긴다.
  ③ **`corpseLoot`** — **딤 없는 포커싱**(`StepDef.spotNoDim` → `Spotlight` 의 `is-nodim`: 판이 투명해지고
  **클릭도 통과**한다 — 어두운 판이 없는데 손만 묶이면 더 나쁘다). 필수는 **무기 장착 하나**이고 그 순간
  다음 단계다(`loadout:changed` 에 주무기가 들어오면 — def id 는 `world/tutorial` 이 정하므로 종류를 안 본다).
  가방 · 탄약 · 회복은 **선택 목표**로 내렸다. `HUD_GEAR_STEP` 관계는 그대로다 (이 단계를 **지나면** 체력 · 무기 HUD).
  ⚠ 격자 타일에는 def id 가 없고 `data-uid` 뿐이라(`inventory/ui/GridView`) **총 한 칸만 고르는 선택자가 없다** —
  구멍은 「시체 격자 ~ 주무기 칸」 합집합, 즉 드래그 경로 전체다. 드래그 중 받을 칸이 초록으로 켜지는 것은
  인벤토리가 이미 한다(`.inv-slot.is-target-ok`).
  ④ **`grenade`** — 한 단계에 필수 + 선택이 함께 보이는 본보기. 필수 「무너진 벽 너머로 나아간다」(체크포인트
  `ship`), 선택 「수류탄으로 적을 처치한다」(수류탄이 터진 뒤 `GRENADE_KILL_WINDOW_S` 안의 **비총기** 처치 =
  `enemy:killed.weaponClass == null`). 그래서 `grenade:thrown` 으로 단계를 넘기지 않는다 — 대신 탈출 스위치도
  `foldRaid('extract')` 로 앞으로 접어, 체크포인트를 놓쳐도 막히지 않게 했다.
  ⑤ **`heal`** — 체력이 이미 가득이면 **조용히 지나친다** (`generator` · `bench` 와 같은 요령, `advance(true)` 는
  달성 표시도 소리도 내지 않는다).
  ⑥ **우측 조작 가이드** — 줄이 **구간**으로 묶이고(이동 / 화면 / 전투 / 장비) 구간 사이에만 얇은 구분선이 있다.
  `LMB 사격 · RMB 정조준`이 **한 줄**이 됐다(`ControlHint.more`). **인벤토리 화면이 열려 있으면 접힌다**.
  자리를 무기 패널 · 퀵슬롯 **위**로 뺐다 (`bottom: 232px`, 위 절 참고).

- **2026-09-14 (3트랙 단계 기계 · 우측 조작 가이드 · HUD 점진 노출 — `docs/DECISIONS.md` 「2026-09-14 — 튜토리얼 개편」)** — 같은 날 먼저 들어온 계약 위에
  **진짜 구현**이 올라갔다.
  ① **저장 v2** — `TutorialSave.tracks` 로 트랙별 `{step, done}`. v1(최상위 `step`/`done`)은 `tracks.build` 로 옮겨 붙이고
  그 프로필은 **레이드 · 함선 트랙을 이미 끝낸 것으로** 본다 (안 그러면 하던 사람이 다음 접속에 튜토리얼 레이드로 끌려간다 —
  `isTrackDone('raid')` 가 진입 흐름을 정한다). 저장이 **아예 없는** 프로필은 새 캐릭터와 모양이 같으므로
  `isTrackDone` 이 `!looksFresh()` 로 답한다. **다른 스모크 81개가 심는 한 줄도 v2 로 같이 고쳤다.**
  ② **트랙 기계** — `track` · `isTrackDone` · `startTrack` · `skipTrack` 이 `save.tracks` 를 보는 진짜 구현이 됐고,
  `nextStep` · `stepIndexOf` · `stepCountOf` 는 **자기 트랙 안에서만** 센다. 돌고 있는 트랙은 늘 하나다. 이어 가기는
  `autoStart()` 세 줄(위 절) 이고 ⚠ 증축 트랙의 조건은 `looksFresh()` 가 아니라 **`shipUntouched()`** 다 —
  레이드를 마치고 온 사람은 레벨 2 지만 함선은 비어 있고, 그 사람이 증축 안내를 받아야 한다.
  ③ **레이드 · 함선 트랙 15단계**를 채웠다 (문구 · 스포트라이트 · 허용 게이트). 진행은 전부 **이미 있는 이벤트의 관찰**이고
  레이드의 뼈대는 `tutorial:checkpoint` → `CHECKPOINT_STEP` 표 하나다 (앞으로만 접으므로 선택 단계 `grenade` 를 지나쳐도,
  체크포인트를 하나 놓쳐도 막히지 않는다). 함선 트랙은 새 UI 가 없다 — 기존 화면을 가리키기만 한다.
  ④ **우측 조작 가이드**(`ui/Controls.ts`) — 배운 키가 쌓이고 사라지지 않는다. 우하단 키 가이드와 자리가 겹치지 않게
  화면 우측 세로 가운데(`max-height: 52vh`)에 서고, 키 라벨은 그릴 때 `Keys` 에서 읽는다.
  ⑤ **HUD 점진 노출** — 새 게이트 `hud`. 숨김 전용이고 **레이드 트랙 안에서만** 산다. 호출부는 네 위젯이 자기 이름으로
  한 줄 묻는 것이고 접는 방법은 `.hud-tut-hidden` 하나다.
  ⑥ `community` 가 `ALWAYS_HIDDEN` 에서 빠졌다 (함선 트랙이 메신저를 **써야** 한다). 동작은 같다 — `allow` 가 없는 단계는
  `blockReason` 이 막고 `hides` 가 그것을 그대로 읽는다. 같은 이유로 `stashItem` 흰 목록은 **증축 트랙에서만** 적용된다.

- **2026-09-14 2차 (풀피로 시작 · 풀피로 부활 — 사용자 결정, 리드 마무리)** — 아래 「딸피로 깨어난다」를 **뒤집었다**.
  `applyLowHp()` · `LOW_HP_DONE_STEPS` 를 지웠고 `player:spawned` · `player:respawn` · `player:introWakeDone` 세 구독도
  함께 빠졌다 (`TUTORIAL_START_HP` 는 읽는 곳 없는 은퇴 상수로 남는다). 긴장을 만드는 일은 이제 **낙하 피해**가 한다 —
  `drop` 단계에서 실제로 깎인 체력을 `heal` 단계의 붕대로 되돌리는 것이 「낙뎀 인지 → 회복」의 한 줄이고, 체력이 이미
  가득이면 `heal` 은 조용히 지나간다.

- ~~**2026-09-14 (딸피로 깨어난다 — 리드 마무리)**~~ *(위 2차에서 뒤집힘)* — 사용자 명세의 「플레이어는 딸피 상태라 벌레에게
  공격당하면 사망」이 빠져 있었다. `applyLowHp()` 가 `player:spawned` · `player:respawn` · `player:introWakeDone` 마다
  `PlayerRef.setHp(TUTORIAL_START_HP)` 를 건다 — **부활할 때마다 다시 건다**는 것이 요점이다(`player:respawn` 은 체력을
  가득 채워 주므로 그대로 두면 한 번 죽은 뒤부터 긴장이 사라진다). `LOW_HP_DONE_STEPS`(`heal` 부터)에 닿으면 손을 둔다 —
  그 단계가 바로 회복 아이템을 줍고 쓰는 곳이다. 솔로 레이드라 체력 0 은 전투불능이 아니라 **즉사** → 체크포인트다.

- **2026-09-14 (튜토리얼 개편 — 계약만 먼저, `docs/DECISIONS.md` 「2026-09-14 — 튜토리얼 개편」)** — 사용자 결정으로 안내가 **세 트랙**으로 갈라진다:
  ① `raid`(손으로 지은 튜토리얼 행성에서 깨어나 조작을 배우고 버려진 함선으로 탈출) ② `ship`(레벨업 · 능력치 투자 · 메신저 레이븐)
  ③ `build`(하우징 → 제작 → 출격 — 2026-09-14 3차에 `manageDone` 이 빠져 16단계). 각각 따로 건너뛴 수 있다 — 조작은 아는데 함선 증축은 처음인 사람이 있기 때문이다.
  **이번 커밋은 계약과 자리만 잡았다**: `Steps.ts` 에 두 트랙의 단계 15개가 **빈 자리**로 들어왔고(문구 · 스포트라이트 · 허용 게이트는
  그 트랙을 구현하는 쪽이 채운다), `TutorialRef` 의 `track` · `isTrackDone` · `startTrack` · `skipTrack` 은 「이 폴더는 아직 build 하나만 돌고 있다」를
  정직하게 답하는 얇은 답변이다. `isTrackDone('raid')` 가 **true** 를 돌려주는 것이 중요하다 — 진입 흐름(`ui/menus/enterShip`)이 그 답을 보고
  튜토리얼 레이드를 띄우므로, 구현 전에는 지금까지와 똑같이 함선으로 가야 한다. `SaveV1` 은 계약에서 선택 필드가 된 `step` · `done` 을 여기서 다시
  필수로 좁혀 둔 것이고, 트랙 기계를 구현할 때 `TutorialSave.tracks`(v2)로 옮겨 간다. **그때 스모크가 심는 저장 모양도 v2 로 같이 고친다** —
  다른 스모크 전부가 `scav.tutorial` 을 `done` 으로 심고 시작하므로 그 한 줄을 안 고치면 전부 빨개진다.

- **2026-09-10 (제작 대개편에 맞춰 탄약 단계 복구)** — 같은 날의 제작 대개편이 `data/recipes.csv` 에서
  **총탄 대량 제작 4줄**(`bulk_ammo_light` · `_medium` · `_heavy` · `_shell`)을 지웠는데 `TUTORIAL_AMMO_RECIPE` 가
  `bulk_ammo_medium` 을 가리키고 있었다 — 목록에 없는 레시피라 `craft:completed` 가 영영 오지 않아 **새 캐릭터
  안내가 9단계(`craftAmmo`)에서 멈췄다.** 그 자리를 잇는 것은 **`make_ammo_medium`**(`화약 6 · 폐금속 2` → 30발)이다:
  `station: 'field'` · `bench` 없음 이라 ① 현장에서도 되고 ② 작업대 창의 목록이 `bench` 없는 레시피를 전부 싣기
  때문에(`inventory/parts/Crafting.getRecipes` 의 `if (r.bench === undefined) return true`) **총기 작업대 창에도
  그대로 뜬다** — "같은 창에서 소총 → 탄약" 흐름이 유지된다. 산출이 90 → 30발로 줄었지만 `stowAmmo` 는
  "가방에 준중량탄이 **있나**"만 보므로 수량과 무관하다 (스모크가 이제 그것을 직접 못 박는다).
  `Steps.craftAmmo` 의 선택자는 이제 문자열이 아니라 **`TUTORIAL_AMMO_RECIPE` 에서 만든다** (`craftGun` 도 같이) —
  같은 id 를 두 곳에 손으로 적어 둔 것이 이번 회귀의 절반이었다. 문구도 `준중량탄 대량 제작` → `준중량탄 제작`.
  **재료 top-up 은 한 글자도 안 고쳤다** — 재료 종류·수량을 레시피에서 읽는 설계라 새 재료 구성(화약 6 · 폐금속 2)
  에서 그대로 돈다. 같은 대개편의 나머지(작업대 `refine` 추가 · 새 재료 5종 · `break_*` 의 `data/salvage.csv` 이관 ·
  실드 충전기의 의학 작업대 이동 · 가젯 레벨 재배치)는 튜토리얼이 참조하지 않는다: 이 폴더가 아는 id 는
  `furn_bench_gun` · `make_wpn_ar` · `wpn_ar` · `make_ammo_medium` · `ammo_medium` 과 지급 재료 셋뿐이고
  (`model.ts`), 새 작업대·새 가구·새 레시피는 게이트가 **감추므로**(`hides`) 목록이 늘어도 안내는 그대로다.

- **2026-09-09 (안내 6건)** — 사용자 요청.
  ① **`openCraft` 단계 신설** (17 → 18단계): 장착 다음에 **가방의 `제작` 버튼**을 밝힌다. 그 전에는 제작 행을
  가리키는데 제작 창이 닫혀 있어 밝힐 것이 없었다. 넘어가는 신호는 작업대 경로(`ui:craftToggled`)와 가방 버튼
  경로(`ui:keyGuide {owner:'inventory.craft'}`) 둘 다 받는다.
  ② **재료 top-up** — `ensureMaterials(recipeId)` 가 제작 단계마다 `필요 − 보유` 만큼만 채운다. 소총이 폐금속을
  먹어 준중량탄을 못 만들던 진행 불가를 없앴다. 숫자는 레시피에서 읽으므로 코드에 없다.
  ③ **`manageDone` 이 키 가이드를 밝힌다** (`.key-guide .kg-close`) — 화면에 늘 떠 있는 `Tab 닫기` 를 가리켜
  관리 모드를 어떻게 나가는지 보여 준다.
  ④ **스포트라이트의 1 px 띠 수정** — `place()` 가 판마다 좌표를 따로 반올림해서, 대상 사각형이 소수점이면
  구멍 위아래에 어둡지 않은 가로줄이 남았다 (8단계에서 잘 보였다). 이제 네 모서리를 먼저 정수로 굳히고
  (`floor`/`ceil`) 판 넷과 링을 전부 거기서 파생한다 — 아래 판의 `top` 이 곧 옆 판의 `bottom` 이다.
  ⑤ **목표 패널이 언제나 화면들 위에** (`z-index: 79` 고정). 예전에는 24 였다가 포커싱 중에만 79 로 올라가서,
  대상을 못 찾은 순간마다 인벤토리 창(z 50 + 블러)이 패널을 덮었다 (11단계). `is-lifted` 와 `setLifted` 는
  상태 표시로만 남는다.
  ⑥ **건너뛰기가 어려워졌다** — 확인 카드의 본문 두 줄(제한 해제 안내 · 콘솔 `tutorial start`)을 지워 제목과
  버튼만 남기고, 건너뛰기는 **채워진 빨간 홀드 버튼**(`SKIP_HOLD_TIME` 1초)이 됐다. 클릭은 무시하고 게이지가
  다 차야 끝난다 (`ui/Popup.PopupButton.hold`, 제작의 1초 홀드와 같은 문법).
  ⑦ **튜토리얼 중 함선 창고 정리** — 새 게이트 `stashItem` 이 흰 목록(`TUTORIAL_STASH_WHITELIST`: 지급 재료 ·
  만든 소총 · 만든 탄약) 밖의 창고 아이템을 전부 감춘다. 단계마다 다른 목록이 아니라 튜토리얼 내내 같은 목록이라
  `Steps.ts` 의 `allow` 가 아니라 `parts/Gates` 가 직접 판정한다 (`raid` 만 `stashItem: true` 로 전부 연다).

- **2026-09-08 (함선 관리 단계 포커싱)** — `manage` 단계에 열린 화면이 없어 밝힐 것이 없었다. 우측 하단에 늘 떠
  있는 `시설 관리` 키 힌트(`ui/hud/ShipManageHint`, `.ship-hint`)를 포커싱해 "어디를 봐야 하는지"부터 알려 준다.
  같은 날 하우징 모드가 Escape 를 먹게 되어 `manageDone` 의 `Esc 또는 C` 안내는 다시 사실이 됐다.

- **2026-09-08 (가구 제작 → 배치 재안내)** — `bench` 한 단계가 "제작 + 배치"를 함께 요구해 **진행이 막혔다**:
  제작한 가구는 가구 창고로 들어가는데 스포트라이트는 제작 카드에 붙어 있어 창고 탭이 어두운 판에 덮였고,
  설령 집었더라도 내려놓을 바닥까지 판이 먹었다. `benchPlace` 단계를 새로 만들어 셋으로 나누고(제작 → 창고에서
  집기 → 바닥에 놓기), 가구가 커서에 들리면(`housing:selectionChanged`) 스포트라이트를 접는다.
  `ui/hud/ShipManage` 의 탭 버튼에 `data-tab`, 가구 창고 카드에 `data-def-id` 를 달아 포커싱이 집을 수 있게 했고,
  `Spotlight.find` 는 `visibility:hidden` 조상(닫힌 `.ship-manage`) 아래의 요소를 더 이상 밝히지 않는다.

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

### 2026-09-09 — 행성 이동을 마쳐도 16/18 에서 멈추던 문제

`planet` 단계를 `hub:planetChanged` 로 넘기고 있었는데, 그 이벤트는 `hub/parts/Planet.finishTravel` 이 **도착해서**
`hub:travel {end}` 를 낸 **바로 다음에** 낸다. 그래서 순서가 엇갈렸다 — 워프가 끝나는 순간 `travel {end}` 가
먼저 오지만 그때 단계는 아직 `planet` 이라 무시되고, 이어 온 `planetChanged` 가 `travel` 로 넘긴 뒤에는 기다릴
`travel {end}` 가 이미 지나간 뒤였다. 이제 `planet` 은 **`hub:travel {start}`**(워프 시작)에서 넘어가므로 두
단계가 워프의 앞뒤를 하나씩 맡는다. `hub:planetChanged` 구독은 도착만 보고 들어오는 경로의 보험으로 남겨 뒀다
(`advanceIf` 는 현재 단계가 아니면 아무것도 하지 않는다).

### 2026-09-09 — 반 박자 지연이 스포트라이트를 영영 안 띄우던 문제

`TUTORIAL_STEP_DELAY_S` 를 넣은 첫 구현이 `parts/Spotlight.update` 에서 이렇게 셌다:

```ts
if (this.wait > 0) this.wait -= dt;                 // 음수로 넘어간다
...
if (this.wait < 0) this.wait = TUTORIAL_STEP_DELAY_S;   // 그 음수를 "대상이 지금 나타났다" 로 읽는다
if (this.wait > 0) { this.timer = Math.min(RETARGET_INTERVAL, this.wait); return; }
```

`timer` 를 `min(RETARGET_INTERVAL, wait)` 로 잡는 순간 **둘이 같은 값이 되어** 늘 같은 프레임에 0 을 지난다.
그 프레임에서 `wait` 은 아주 작은 **음수**가 되고, 바로 아래 줄이 그것을 `-1`(아직 안 세고 있다) 표식으로
오해해 0.5초를 다시 세기 시작한다 — `place()` 는 `wait` 이 **정확히 0** 인 프레임에만 도달하므로 사실상
영영 안 온다. 계측값은 0.5 → 0.0004 → 0.5 → 0.0002 … 의 무한 반복이었고, 실제로 켜지기까지 23.7초가
걸리거나 60초 안에 끝내 안 켜졌다 (설계값 0.5초).

고친 것은 한 줄이다 — **세는 동안 0 밑으로 내려가지 않게** 한다:

```ts
if (this.wait > 0) this.wait = Math.max(0, this.wait - dt);
```

`-1` 은 "아직 세고 있지 않다" 는 **별개의 표식**이므로 이제 그 뜻으로만 읽힌다. 같은 지연을 쓰는
`parts/Guide` 는 처음부터 `if (this.wait > 0) { this.wait -= dt; if (this.wait > 0) return; }` 모양이라
멀쩡했다 (~490 ms). 카운터를 두 개(`wait` · `timer`) 돌리면서 하나를 다른 하나로 잡아 줄 때는
**표식 값과 오버슈트가 겹치지 않는지** 확인한다.
