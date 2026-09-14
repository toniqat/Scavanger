# 2026-09-14 4차 묶음 — 튜토리얼 다듬기 · 함선 메뉴

사용자 결정 원본. 구현 중 이 문서와 코드가 어긋나면 **이 문서가 맞다**.
앞 묶음은 [`tutorial-raid.md`](tutorial-raid.md) · [`qol-batch-2026-09-14c.md`](qol-batch-2026-09-14c.md).

## 0. 확정한 것 (AskUserQuestion)

| 질문 | 결정 |
|---|---|
| 벌레 구간 통로 폭 | **반폭 4.6 m** (현재 15.4 에서 −70 %). 벌레를 x ±2.5 로 당겨 세운다 |
| 포복 구간 천장 | **입구 1.35 → 출구 1.95** (지금은 입구 1.81 → 출구 1.39 로 요청과 반대). 끝까지 못 선다(< `BOX_HEADROOM` 2.1) |
| 낙사 부활 자리 | **마지막으로 땅에 서 있던 자리** — 튜토리얼 전체에 적용. 체크포인트는 그 기록이 없을 때의 보험 |
| 함선에서 「타이틀로」·「게임 종료」 | 경고 팝업은 **그대로**, 임무 문구만 함선용으로 교체하고 1초 홀드 → **한 번 탭** |
| 「앞으로 이동」 구간 | **새 단계 id 추가** — `advance1` · `advance2` · `advance3` (raid 트랙 11 → 14 단계) |
| 절벽 2 까지의 거리 | 16 m → **11 m** (가장자리 z −82 → −77) |
| 초록색 구체 | 함선 안·근처 **월드에 떠 있는 빛나는 구** — 조사해서 제거 |
| 붕대·수류탄 휠 등록 | **자동 등록**, 「빠른 사용 칸에 올린다」 목표 줄은 삭제 |

## 1. 계약 (리드가 이미 넣었다 — 추가만)

- `src/shared/tutorial.ts`
  - `TutorialStepId += 'advance1' | 'advance2' | 'advance3'`
  - `TUTORIAL_TRACK_STEPS.raid` = `wake · move · sprintJump · corpseLoot · **advance1** · shoot · **advance2** · crouch · crouchAim · **advance3** · drop · heal · grenade · extract`

셋 다 **이미 있는 체크포인트**로 끝난다 (`advance1`→`bugs`, `advance2`→`crawl`, `advance3`→`drop`) —
월드에 새 트리거를 만들지 않는다. `CHECKPOINT_STEP`(`tutorial/model.ts`)은 한 줄도 안 바뀐다.

## 2. 레인 (파일 소유 — 서로 겹치지 않는다)

| 레인 | 소유 파일 |
|---|---|
| **A 튜토리얼 월드** | `src/world/tutorial/**` |
| **B 튜토리얼 시스템** | `src/tutorial/**` |
| **C 플레이어 · 탈출** | `src/player/**`, `src/extraction/**` |
| **D 적 · 전리품** | `src/enemies/**`, `data/enemies.csv`, `data/loot_*.csv` |
| **E UI 셸** | `src/ui/**` |

`CLAUDE.md` · `src/shared/**` · `docs/**` 는 **리드가** 쓴다. 에이전트는 자기 폴더 `README.md` 만 갱신한다.
검증은 각 레인 `npm run typecheck`(+ csv 를 만졌으면 `npm run data:check`)까지. 스모크는 리드가 마지막에 한 번.

## 3. 레인별 명세

### A — 튜토리얼 월드 (`src/world/tutorial/`)

1. **벌레 구간을 좁힌다** — `CORRIDOR_PROFILE` 의 z 62…0 구간 반폭을 새 상수 `CORRIDOR_BUG_HALF_X = 4.6`
   으로 바꾼다 (`CORRIDOR_MAX_HALF_X` 는 안드로이드 구간 · 마지막 구간용으로 남는다).
   벌레 두 마리는 `x = −2.5` (`tut_bug_loot`) · `x = +2.5` (`tut_bug`) 로. **z 는 그대로**(34 · 28).
   - 깔때기는 지금 규약 그대로 (68 → 62 에서 좁아지고, 0 → −12 에서 통과 폭 7.7 로 돌아온다).
     4.6 이 통과 폭 7.7 보다 **좁다** — 프로파일이 「좁아졌다 넓어지는」 모양이 되는 것은 의도다.
   - `DECKS` 는 늘 `±CORRIDOR_MAX_HALF_X` 규약 유지. 체크포인트 · 낙하 규칙 볼륨의 반폭 `W` 도 그대로.
   - 적 6마리가 여전히 자기 구간의 벽 안인지 **다시 검산**하고 `ENEMIES` 주석의 거리표를 갱신한다.

2. **포복 구간 천장** (`CRAWL`) — 지금은 들어가는 쪽이 높고 나가는 쪽이 낮아 요청과 정반대다.
   - `clearance`(구간 한가운데) **1.65**, `slabSlope` 부호를 뒤집어 **입구(z0 −14) 1.35 · 출구(z1 −28) 1.95**.
     `crawlClearanceAt` 의 식은 그대로 두고 부호만 바꾼다.
   - `slabSegments` 4 → **7** (조각 2 m). 조각별 밑면이 그려진 밑면과 어긋나는 폭을 줄여, 입구 조각이
     1.35 에 더 가깝게 서도록 한다. **모든 조각의 밑면이 `PLAYER_CROUCH_CLEARANCE_M`(1.3) 초과 ·
     `BOX_HEADROOM`(2.1) 미만**임을 주석에 검산해 둔다 (하나라도 벗어나면 구간이 뜻을 잃는다).
   - `slabThickness` 1.2 → **2.4** — 밑면은 그대로 두고 **위로만** 두껍게 (사용자: 「천장을 위로 더 두껍게」).
   - 출구가 1.95 인 이유는 정조준 카메라다: 앉아서 앞을 겨눌 때 카메라가 슬래브에 박히지 않아야 한다.
     (안드로이드 전투장 z −34…−66 에는 천장이 없다 — 문제가 나던 자리는 **포복 구간 출구**다.)

3. **절벽 2 를 5 m 당긴다** — 가장자리 z **−82 → −77**.
   - `DECKS`: `upper_b.z1` −82 → −77, `lower.z0` −82 → −77.
   - `CORRIDOR_PROFILE` 의 깔때기 제어점 z −78 → **−73** (안드로이드 구간 끝 −66 은 그대로).
   - `FALL_RULES` 의 `clamp` 볼륨 z0 −82 → −77 (z1 은 그대로 −102).
   - `CHECKPOINTS` 의 `drop` 을 **절벽 바로 앞**으로: `(0, 0, −71)`, trigger z0 −68 · z1 −75.
     적 감지 12 m 밖 검산 — (−7,−48) 24.0 m · (7,−54) 18.4 m ✔ (주석의 거리표를 갱신한다).
   - 뒤 구간(`supply` −92 · `wall` −108 · `ship` −143 · `SHIP_POS` · `Z_END`)은 **건드리지 않는다** —
     아래 데크가 5 m 길어질 뿐이다.

4. **낙사 부활 = 마지막으로 땅에 서 있던 자리** (사용자 결정, 튜토리얼 전체).
   **변경은 이 폴더 안에서 끝난다** — 부활 자리를 아는 유일한 곳이 `TutorialWorld.respawnPose()`
   (`TutorialWorld.ts:151`)이고, `game/parts/Death.tutorialRespawn`(`Death.ts:144-156`)은 그것을 **묻기만** 한다.
   - `pollCheckpoints()`(`TutorialWorld.ts:128`, 이미 매 프레임 `ctx.player.position` 을 읽는다) 옆에서
     플레이어가 **접지해 있고**(`PlayerRef.isGrounded` — 이미 계약에 있다, `shared/types.ts:886`)
     ① 낙하 규칙 볼륨 밖 ② `inChasm(x, z, 1.5)` 밖 ③ 데크 윗면 근처(`|y − DECK_*_Y| < 0.4`) 이면
     그 발 위치를 `lastSafe` 에 적는다.
   - `respawnPose()` 는 `lastSafe` 가 있으면 **그 자리**를, 없으면 지금처럼 마지막 체크포인트를 돌려준다.
     돌려주기 전에 `ctx.world.resolveCollision` 을 한 번 통과시켜 벽에 끼지 않게 한다. yaw 는 0(앞).
   - 체크포인트 자체는 그대로 남는다 (안내 진행 · 이어하기 · 보험).
     `gotoCheckpoint`(이어하기, `Phases.ts:229`)는 지금처럼 **체크포인트**로 간다 — 새로고침 복귀는
     「떨어지기 전」이 아니다.
   - **`src/player/**` 와 `src/game/**` 는 건드리지 않는다** (다른 레인의 파일).

### B — 튜토리얼 시스템 (`src/tutorial/`)

1. **오프닝이 실제로 돌게 한다.** `PlayerRef.playIntroWake` 를 **`src/` 어디서도 부르지 않는다**
   (도입 커밋부터 배선이 빠져 있었다) — 그래서 2초 페이드도, 쓰러진 채 일어나는 애니메이션도 한 번도
   나오지 않았다. `player:introWakeDone` 이 영영 안 와도 `cliff` 체크포인트가 `sprintJump` 까지 접어 주므로
   진행이 막히지 않아 눈에 안 띄었다.
   - **부르는 자리는 `TutorialSystem.update()` 의 다음 프레임**이다. `startRaidTrack()` 에서 `pendingWake`
     한 칸만 세우고 `update()` 가 소비한다. ⚠ 같은 `game:newMission` emit 안에서 부르면 안 된다 —
     그 emit 의 뒤쪽 핸들러인 `PlayerSystem`(`PlayerSystem.ts:817`)이 `cancelIntroWake` 로 **조용히
     지운다**. `world:ready` 구독 안도 같은 이유로 안 된다(그 안에서 동기 발행된다).
     `TutorialWorld.placeShip` 이 이미 같은 이유로 한 프레임 미루고 있다 — 그 선례를 따른다.
   - 가드: `step === 'wake'` 일 때만. 솔로 이어하기(`gotoCheckpoint`)로 중간 체크포인트에서 돌아온
     사람에게 연출이 걸리면 안 된다. 선택 메서드이므로 `?.` 로 부른다.
   - 인자는 `TUTORIAL_INTRO_WAKE_S`(csv, 현재 9초). 코드에 숫자를 적지 않는다.

2. **`wake` 단계에서 「몸을 일으킨다」 목표를 없앤다** (`objectives: []`).
   기상 연출 동안에는 **목표 패널도 우측 조작 가이드도 그리지 않는다**. 연출이 끝나면(`player:introWakeDone`)
   `move` 로 넘어가되, **패널·가이드는 그 뒤 2초** 또는 **플레이어가 1 m 이상 움직인 순간** 중 먼저 오는 때에
   함께 나타난다 (연출 상수는 `tutorial/model.ts` 에 — `MARKER_*` · `GUIDE_*` 와 같은 자리).

3. **`advance1` · `advance2` · `advance3`** 단계 정의 (`Steps.ts`).
   - 제목 · 목표는 셋 다 「앞으로 나아가세요」 / 「앞으로 이동한다」 계열의 한 줄. 스포트라이트 없음.
   - 조작 가이드는 `move` 와 같은 세 줄(이동 · 달리기 · 점프)을 유지한다.
   - 넘어가는 신호는 이미 있는 체크포인트다 (`bugs` · `crawl` · `drop` → `foldRaid`). 새 이벤트 없음.
   - 진행률 분모가 11 → 14 로 늘어나는 것은 의도다.

4. **`corpseLoot` 목표 재구성** (사용자 결정).
   - `corpseGun`(필수) · `corpseBag`(선택) · `corpseAmmo`(선택) **셋만**.
   - `corpseStim` **삭제** — 그 시체(`corpse:tut_gear`)에는 회복 아이템이 없다.
   - `corpseClose`(가방을 닫는다) **삭제** — 닫기는 목표가 아니다.
   - 총을 주무기 칸에 넣는 순간 **그 단계는 끝난 것**이다: 목표에 체크가 들어가고 **스포트라이트를 끈다**.
     다만 다음 단계(`advance1`)로 넘기는 것은 **인벤토리를 닫을 때**다 — 화면을 보는 동안 등 뒤에서 안내가
     바뀌지 않게 하고, 그 사이에 선택 목표를 할지 말지 고르게 한다.

5. **벌레 구간은 걸어가다 시작한다.** `corpseLoot` → `advance1` → (`bugs` 체크포인트) → `shoot`.
   벌레가 솟는 연출(D 레인)도 `shoot` 단계 진입에 걸려 있으므로 자동으로 늦춰진다 — 그 배선을 확인한다.

6. **앉기도 마찬가지** — `shoot` → `advance2` → (`crawl` 체크포인트, 포복 구간 바로 앞) → `crouch`.
   `crouch` 의 조작 가이드는 **자세를 따라간다** (`crouchHints`): 서 있으면 C 앉기 · Z 포복, 앉아 있으면
   C 일어서기 · Z 포복, 엎드려 있으면 C 앉기 · Z 일어서기. 이미 그렇게 돼 있으면 확인만 하고 남긴다.

7. **뛰어내리기도 마찬가지** — `crouchAim` → `advance3` → (`drop` 체크포인트, 절벽 앞) → `drop`.

8. **`heal` 목표 통합** (사용자 결정).
   - 「빠른 사용 칸에 올린다」(`healStock`) **삭제** — 붕대 · 수류탄은 주우면 빈 휠 칸에 **자동 등록**된다
     (이미 그런 규칙이 있으면 그대로 쓰고, 없으면 리드에게 보고한다 — inventory 는 다른 레인이다).
   - 남는 줄: ① 「빠른 사용 휠을 꾹 눌러 붕대를 골라 손에 든다」 ② 「길게 눌러 붕대를 쓴다」.
     문구에 키 글자를 적지 않는다 (리바인드하면 거짓말이 된다 — 키는 우측 조작 가이드가 그린다).
   - **선택 목표 추가**: 「수류탄을 챙긴다」 (그 시체에 수류탄 2개가 있다).
   - 첫 줄의 딤 없는 포커싱(`SPOT_HEAL_STOCK`)은 「시체 격자 → 빠른 사용 칸」이 사라졌으므로 정리한다.

9. **`grenade` 선택 목표 통합** — 「수류탄으로 적을 처치한다」 → 「빠른 사용 휠에서 수류탄을 꺼내 던진다」.
   **던져서 터지기만 하면 달성**이다 (처치 여부를 보지 않는다). 필수 목표 「무너진 벽 너머로 나아간다」는 그대로.

10. **`stats` 스포트라이트 버그** — 캐릭터 탭을 눌러 능력치 화면이 열렸는데도 포커싱이 화면 위쪽
    「인벤토리 · 캐릭터」 탭 줄(`.scr-tabs`)에 남아 포인트를 투자할 수 없다. 원인을 찾아 고친다.
    선택자 목록은 `['.pg-confirm', '.pg-alloc', '.cs-col', '.inv-root .scr-tabs']` 이고 `Spotlight.find` 는
    **먼저 찾히는 하나**를 쓴다 — 앞의 셋이 안 잡히는 이유(존재하지 않는가 · `visibility: hidden` 인가 ·
    `getClientRects()` 가 비는가)를 실제로 확인하고, 필요하면 캐릭터 시트가 열렸을 때의 선택자를 고친다.
    캐릭터 시트 DOM 은 `src/progression/ui/SheetBody.ts` 다 (**읽기만** 한다 — 다른 레인의 파일).

11. **`extract` 단계의 초록색 구체 제거** — 정체는 **탈출 함선의 월드 마커** `.wmarker.ship` 이다.
    3D 구체가 아니라 CSS 원(`ui/styles/base.css:409-418` — `border-radius: 50%` + `--c-success` #4fd17e + 글로우)이라
    지오메트리 검색으로는 안 잡혔다. 켜지는 계기는 **이 폴더의 게이트**다:
    `tutorial/parts/Gates.ts:52` `case 'shipMarker': return i < RAID_STEPS.indexOf('extract');`
    → `shipScreenMarker` 와 같게 **레이드 내내 숨김**으로 바꾼다. 지도 마커(`ui/map/MapScreen.ts:1409`)가 함께
    꺼지는 것도 의도다 — 튜토리얼 맵은 일직선 통로라 마커 없이 함선을 못 찾을 수 없다.
    ⚠ `ExtractionSystem` 이 `extraction:shipLanded` 를 내는 것 자체는 **건드리지 않는다** — 음악 전환 · 페이즈
    전이가 거기 묶여 있다(`ExtractionSystem.ts:241-248`).

### ~~C — 플레이어 · 탈출~~ (레인 없음)

조사 결과 **고칠 것이 없다.**
- 오프닝 페이드 길이는 이미 맞다 — `TUTORIAL_INTRO_WAKE_S`(9) × (`FADE_DONE` 0.26 − `FADE_HOLD` 0.04) = **1.98 s**.
  안 보였던 이유는 길이가 아니라 **호출자가 없어서**였고, 그것은 B 레인이 붙인다.
- `playIntroWake` 는 `world:ready` 시점에 이미 `spawned === true` 라 pending 칸이 필요 없다
  (`PlayerSystem` 의 `world:ready` 핸들러가 `respawnAt` 으로 먼저 스폰시킨다 — 등록 순서 Player 92 < Tutorial 113).
  B 가 한 프레임 미뤄 부르므로 `PlayerSystem.ts:817` 의 `cancelIntroWake` 도 피한다.
- 초록색 구체는 `extraction/` 이 아니라 튜토리얼 게이트의 문제였다 (위 B-11).

### D — 적 · 전리품 (`src/enemies/`, `data/enemies.csv`, `data/loot_*.csv`)

1. **튜토리얼 고정 드롭이 실제로 나오게 한다.**
   **데이터와 굴림 경로는 정상이다** — 실제 로더를 돌려 확인했다: `rollCorpseOn('tut_android_loot')` 는
   `wpn_ar` · `mat_cable` · `ammo_medium x50` 을 돌려주고, `baseTypeOf` 는 전리품 경로에 **끼어들지 않는다**
   (리그 · AI · 소리에서만 쓴다). 그러니 `data/loot_*.csv` 와 `src/items/**` 는 **원인이 아니다.**
   원인은 `Corpse.interact()` **앞단** 둘이다:
   - **시체 수명 45초** (`data/constants.csv` `CORPSE_LIFETIME` → `EnemySystem.ts:424`). 튜토리얼 예외가 없어,
     목표 패널을 읽으며 천천히 걷는 속도에서는 도착 전에 시체가 사라진다. → 튜토리얼 레이드에서는
     사라지지 않게 한다 (새 수치가 필요하면 csv 에 줄을 먼저 만든다. **본편 45초는 불변**).
   - **굴착 스폰 도중 사망** — 솟는 1초 동안에도 맞으므로(`Pool.ts:130`) 그때 죽으면 시체가 **데크 아래 y** 에
     등록되고, 상호작용 반경이 3-D 거리 2.4 m 라 영영 닿지 않는다. → 시체 등록 지점에서 `emergeT > 0` 이면
     `getSurfaceY` 로 올린다 (본편 굴착 스폰도 같은 문제이므로 **공통으로** 고친다).
   - `tut_bug` · `tut_android` 는 `CORPSE_LOOT_CHANCE` 0 이라 **애초에 열리지 않는다** — 설계 그대로 둔다
     (사용자가 요구한 드롭은 왼쪽 벌레 · 오른쪽 안드로이드 둘뿐이다).
2. **벌레 굴착 스폰**이 `shoot` 단계 진입에 걸려 있는지 확인한다 — B 레인이 그 단계를 늦추므로
   (걸어가다 벌레가 솟는다) 배선이 단계에 걸려 있어야 한다. 좌표·타입은 `world/tutorial` 소유다.

### E — UI 셸 (`src/ui/`)

1. **일시정지 메뉴의 「타이틀로」·「게임 종료」** (`ui/menus/PauseMenu.ts`) — **임무 중이 아닐 때**(함선):
   - 경고 팝업의 본문에서 **임무 관련 문구를 뺀다**. 지금은 「진행 중인 임무를 포기하고 … 회수하지 못한
     전리품은 사라집니다」인데 함선에서는 잃을 것이 없다. 함선용 문구로 갈아 끼운다.
   - **1초 홀드 → 한 번 탭**. 홀드 안내 줄(`.pause-ask-hint`)도 그때는 그리지 않는다.
   - **임무 중에는 지금 그대로다** (임무 문구 + 1초 홀드). 「파티 떠나기」는 함선에서도 그대로 홀드다
     (분대에 영향을 준다).
   - 판정은 한 곳에서만 한다 — 「지금 임무 중인가」를 묻는 기존 질의를 쓰고 새 상태를 만들지 않는다.

## 4. 검증

- 각 레인: `npm run typecheck` (csv 를 만졌으면 `npm run data:check`).
- 리드: `npm run verify` 한 번 (`smoke-tutorial` · `smoke-props-collision` · `smoke-structure-reach` 가 걸린다).
