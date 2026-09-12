# A-3a 헬스장 · A-3e 서재 매체 — 설계안 (2026-09-12)

`docs/TODO.md` 묶음 1 의 **A-3a (헬스장)** 와 **A-3e (휴식 공간 → 서재 매체)** 를 한 사이클로 구현한다.
리드가 `src/shared` 계약 + `data/furniture.csv` · `data/constants.csv` 줄을 먼저 커밋했고, 폴더별 에이전트가 병렬로 채운다.
구현이 끝나면 이 파일은 지우고 결과를 `docs/HISTORY.md` 에 남긴다.

---

## 1. 사용자 명세 (요약)

**휴식 공간**
- 책과 같은 역할의 아이템 2종: **디스크**(2×2, 책보다 약간 세다) · **레코드**(3×3, 디스크보다 약간 세다). 전시대에 꽂으면 숙련 상승량이 오른다.
- 보관함 가구: 책장(책) · 디스크 전시대(디스크) · 레코드랙(레코드).
- 보조 가구 — 배치하면 그 보관함 매체의 보너스에 추가 보너스:
  - 흔들의자 → 책. E 로 **앉기 토글**.
  - TV → 디스크. E 로 **화면 빛 토글**.
  - 축음기(레트로) · 주크박스(클래식) · 턴테이블(현대식) → 레코드. E 로 **불 켜기 토글** (BGM 이 없으므로 불만).

**헬스장**
- 가구와 상호작용 → 미니게임 → 근력 / 지구력 향상. **스탯 포인트와 구분해서** 향상 보너스를 표시.
- 사용하면 현실 시간 **24시간 디버프** — 근력 운동 = 근육통, 지구력 운동 = 심폐 피로. 디버프 중 같은 능력치 기구는 상승 보너스 −100 %.
- 벤치 랙(근력): 바벨 · 양 기둥 · 벤치. **벤치프레스 미니게임**, 실행 중 바벨 양옆에 원반이 끼워진다.
  - 벤치프레스: 가로 프로그레스바 위를 좌우로 왕복하는 원형 커서, 가운데 타이밍에 Space → 점수.
- 스미스 머신(근력): 벤치프레스 미니게임 (실행 중 원반 추가).
- 트레드밀(지구력): **호흡 미니게임** — 후-후-하- 에 맞춰 Space 탭-탭-꾹. 오래 달리려고 호흡을 유지하는 컨셉.
- 사이클(지구력): **사이클링 미니게임** — 박자에 맞춰 A · D 를 번갈아.

## 2. 사용자 결정 (AskUserQuestion, 2026-09-12)

| 질문 | 결정 |
|---|---|
| 새 서재 가구가 놓일 방 | **서재(`library`)에 둔다** — 2026-09-12 「휴식 공간은 서재에 합쳐졌다」 유지. 방 용도 추가 없음 |
| 레코드 보조 가구 3종의 차이 | **외형만 다르고 효과는 같다** — 여러 대를 놓아도 한 번만 적용 |
| 운동 향상의 저장 · 표시 | **별도 「단련」 수치** — `PlayerProfile.trained`, 시트에 `10 (+2 단련)` |
| 운동 중 연출 | **자세 + 고정 카메라** — 캐릭터가 기구 위에서 자세를 취하고 옆에서 비춘다 |

## 3. 리드 기본값 (묻지 않고 정한 것 — 바꾸려면 여기부터)

- 디스크 · 레코드는 **숙련 14종마다 하나씩** (`disc_<skill>` · `record_<skill>`) — 「책과 똑같은 역할」. 등급은 **같은 숙련의 책과 같다**. stackMax 1, 제작 불가, 루팅 + 세레스 상점.
- 매체별 몫은 **따로 상한으로 자르고 더한다** (§4). 보조 가구 배율은 자른 뒤에 곱한다 — 상한을 넘기는 유일한 길.
- 디버프 중에도 운동은 **할 수 있다** — 경험치 0, 디버프는 연장되지 않는다. 시작 화면이 미리 경고한다.
- **끝까지 한 세션만** 반영된다. 취소(Esc)는 보상도 디버프도 없다. 점수 0 으로 끝내도 디버프는 걸린다.
- 새 가구 11종은 전부 `maxLevel 1`, 실용 가구 규칙(B-13 — 같은 것은 하나만 제작)이 그대로 적용된다.
- TV · 레코드 플레이어의 켜짐은 `ShipState.toggled` 에 **저장**된다 (새로고침 · 방문자에게도 보인다).
- 흔들의자 앉기 · 운동 자세는 **네트워크로 보내지 않는다** (알려진 한계 — 개인 함선을 방문한 분대원에게는 서 있는 모습).
- 운동 시각 · 디버프 시각은 `ctx.net.serverNow() ?? Date.now()` (온실 · 분석기와 같은 현실 시간).

## 4. 공식

### 서재 배율 (housing — `Rules`)

```
몫[m]    = min(SHELF_GAIN_MAX[m] − 1, SHELF_XP_PER_ITEM[m] × Σ BOOK_RARITY_MUL[등급])     ← 그 숙련을 가르치는, 매체 m 의 꽂힌 것 전부
몫[m]   ×= (그 매체의 보조 가구가 함선에 배치돼 있으면) 1 + SHELF_AUX_BONUS[m]
서재 배율 = 1 + 몫[책] + 몫[디스크] + 몫[레코드]
```

- `getBookBonus(skill)` 이 **이제 서재 배율 전체**다 (`getSkillGainMul` 에 이미 접혀 있으므로 progression 은 한 줄도 안 바뀐다).
  보조 가구 · 디스크 · 레코드가 없으면 예전 값과 **완전히 같다** — `smoke-library` 의 기존 검사가 그대로 통과해야 한다.
- 값: 책 0.05 / 상한 2.0 / 6칸, 디스크 0.06 / 2.0 / 6칸, 레코드 0.07 / 2.0 / 4칸, 보조 가구 +25 % (전부 `data/constants.csv`).

### 단련 · 디버프 (progression)

```
xp            = round(GYM_SESSION_XP × clamp01(점수)) × (디버프 중 ? GYM_FATIGUE_GAIN_MUL : 1)
trainedXpToNext(n) = round(GYM_TRAIN_XP_BASE × (n + 1)^GYM_TRAIN_XP_EXPONENT)     ← n = 지금 단련 보너스
단련 보너스는 GYM_TRAINED_MAX 에서 멈춘다 (진행도 1)
끝낸 세션 && 디버프 없음  →  gymFatigueUntil[stat] = now + GYM_FATIGUE_HOURS × 3600e3
실효 능력치 = stats[id] + 임플란트 보너스 + trained[id]         ← derived 가 이 값에서 계산된다
```

### 미니게임 점수 (housing)

판정마다 완벽 `GYM_SCORE_PERFECT`(1) · 성공 `GYM_SCORE_GOOD`(0.6) · 실패 0, **세션 점수 = 판정들의 평균** (0 … 1).

| 게임 | 기구 | 판정 | 입력 |
|---|---|---|---|
| `press` 벤치프레스 | 벤치 랙 · 스미스 머신 | `GYM_PRESS_REPS` 회. 커서가 바 위를 왕복(속도 `GYM_PRESS_SPEED` + 회차 × `_STEP`), Space 를 누른 순간 가운데와의 거리 ≤ `GYM_PRESS_PERFECT` 면 완벽, ≤ `GYM_PRESS_ZONE` 이면 성공 | `Keys.JUMP` (기본 Space) |
| `breath` 호흡 달리기 | 트레드밀 | `GYM_BREATH_CYCLES` 묶음 × (후 · 후 · 하). 박자 `GYM_BREATH_BEAT_S` 마다 표식이 판정선에 닿는다. 탭 = 누른 시각 오차 ≤ 창/3 완벽, ≤ `GYM_BREATH_WINDOW_S` 성공. 하 = 시작 오차가 창 안 **그리고** `GYM_BREATH_HOLD_S` 뒤 떼는 오차 ≤ `GYM_BREATH_HOLD_TOL_S` | `Keys.JUMP` 탭 · 꾹 |
| `cycle` 사이클링 | 사이클 | `GYM_CYCLE_STROKES` 회, 박자 `GYM_CYCLE_BEAT_S` 마다 왼발(A) · 오른발(D) 번갈아. 오차 ≤ 창/3 완벽, ≤ `GYM_CYCLE_WINDOW_S` 성공, 틀린 발 · 놓침은 실패 | `Keys.LEFT` · `Keys.RIGHT` (기본 A · D) |

키는 **사용 시점에 `Keys.X` 를 읽는다** (CLAUDE.md).

## 5. 계약 (리드 커밋 — `src/shared` 는 에이전트가 고치지 않는다)

| 파일 | 추가된 것 |
|---|---|
| `types.ts` | `ItemCategory` += `'disc' \| 'record'` · `ItemDef.disc?` / `record?: BookDef` · `FurniturePoseKind` · `FurniturePose` · `PlayerRef.furniturePose?` / `setFurniturePose?` / `setFurniturePoseDrive?` |
| `labels.ts` | `CATEGORY_LABEL_KO` · `CATEGORY_COLOR` · `CATEGORY_ICON` 에 disc · record |
| `constants.ts` (+ `data/constants.csv`) | `DISC_*` · `RECORD_*` · `SHELF_AUX_BONUS_*` · `GYM_*` (§4) |
| `housing.ts` | `FurnitureModelKind` += 11 · `FurnitureInteraction` += 9 · `ROOM_PURPOSES_ACTIVE` += `gym` · 서재 · 헬스장 설명 · `ShelfMedium` · `SHELF_*` 표 · `shelfMediumOfInteraction` · `shelfAuxMediumOf` · `shelfItemOf` · `TOGGLE_INTERACTIONS` · `isToggleInteraction` · `ShelfBonusInfo` · `ShipState.media?` / `mediaDex?` / `toggled?` · `GymMinigame` · `GYM_MINIGAME_LABEL_KO` · `GymEquipmentDef` · `GYM_EQUIPMENT` · `gymEquipmentOf` · `GymSessionInfo` · `HousingRef` 새 메서드 (전부 optional) |
| `progression.ts` | `GymStat` · `GYM_STATS` · `GYM_FATIGUE_LABEL_KO` · `PlayerProfile.trained?` / `trainedProgress?` / `gymFatigueUntil?` · `GymSessionResult` · `ProgressionRef` 새 메서드 (optional) |
| `events.ts` | `housing:shelfChanged` · `ui:shelfToggled` · `housing:furnitureToggled` · `housing:gymSession` · `housing:gymBeat` · `housing:gymResult` · `progress:trainedChanged` · `progress:gymFatigue` · `player:furniturePoseEnded` |
| `net.ts` | `ShipVisitWire.media?` · `toggled?` |
| `data/furniture.csv` | 11줄 — `furn_disc_stand` · `furn_record_rack` · `furn_rocking_chair` · `furn_tv` · `furn_gramophone` · `furn_jukebox` · `furn_turntable` (서재), `furn_bench_rack` · `furn_smith_machine` · `furn_treadmill` · `furn_exercise_bike` (헬스장) |

계약 커밋이 타입체크를 통과하도록 리드가 **임시로** 넣은 것: `hub/interiors/Furniture.ts` 의 `pendingBody`(새 모델 11종의 상자 몸체),
`ui/hud/ShipManage.ts` 의 `MODEL_GLYPH` 11줄, `pickups/PickupVisuals.ts` 의 `REST_Y` 2줄.

### 인터랙션 → 동작 (hub 가 배선)

| interaction | E 동작 | 프롬프트 |
|---|---|---|
| `disc_stand` · `record_rack` | `ctx.housing.openShelf(uid)` | 가구 이름 |
| `rocking_chair` | `ctx.player.setFurniturePose({kind:'sit', anchor, yaw, releaseOnInteract:true})` — 앉아 있는 동안 E 는 player 가 받아 일어난다 | `흔들의자 · 앉기` |
| `tv` · `record_player` | `ctx.housing.toggleFurniture(uid)` | `TV · 켜기` / `끄기` (지금 상태로) |
| `gym_*` | `ctx.housing.startGymSession(uid)` — 거절 사유는 토스트 | `벤치 랙 · 벤치프레스` 등 (`GYM_MINIGAME_LABEL_KO`) |

### 운동 세션의 흐름

```
hub (E) ─ startGymSession(uid) ─▶ housing: gymBlock 검사 → 세션 상태 → 미니게임 화면(시작 안내: 디버프 중이면 경고) 
                                   └ emit housing:gymSession {active:true}
hub  ◀─ housing:gymSession active ─ 원반을 끼우고 자세 anchor · yaw · 옆 고정 카메라 계산 → ctx.player.setFurniturePose(...)
                                     (false 가 오면 ctx.housing.cancelGymSession())
housing 미니게임 ─ 판정마다 emit housing:gymBeat ─▶ hub: 바벨 · 벨트 · 페달 애니메이션 + ctx.player.setFurniturePoseDrive(위상)
                                                   audio: 소리
housing 미니게임 끝 ─ ctx.progression.applyGymSession(stat, 점수) → emit housing:gymResult → 결과 화면
결과 화면 닫기 · Esc 취소 ─ emit housing:gymSession {active:false, completed} ─▶ hub: 원반 빼기 · setFurniturePose(null)
```

## 6. 폴더별 할 일 (에이전트 1명 = 1줄)

각 에이전트는 **자기 폴더만** 고친다. 계약이 모자라면 고치지 말고 보고서에 적는다 (리드가 판단).

### 6-1. items (+ inventory 의 카테고리 목록이 손으로 적힌 곳이 있으면 거기까지)
- `data/discs.csv` · `data/records.csv` (books.csv 와 같은 열: `skill,name,rarity,description`) — 14줄씩, 등급 = 같은 숙련의 책. 이름 · 설명은 한국어, 설명에 숫자를 적지 않는다.
- `ItemDefs.ts`: `DISC_ITEM_DEFS` · `RECORD_ITEM_DEFS` · `discItemIdFor` · `recordItemIdFor` · `DISC_DEF_BY_SKILL` · `RECORD_DEF_BY_SKILL` — 2×2 / 3×3, stackMax 1, `DISC_VALUE_BY_RARITY` · `RECORD_VALUE_BY_RARITY`(tables.csv, 책보다 높게), `DISC_WEIGHT` · `RECORD_WEIGHT`(tuning.csv), `ITEM_DEFS` 에 책 뒤로.
- 루팅: `loot_category_weights.csv` — 디스크 티어 2–4(책보다 조금 낮게) · 레코드 티어 3–5. 세레스 상점 `corp_stock.csv` (디스크 신뢰도 3 · 레코드 4 — 신뢰도 상한을 확인할 것).
- `data:check` 가 새 csv 두 개를 검사하게 (`scripts/data-owners.mjs` 매핑 포함), 그리고 **아이템 가치가 경제 표에 들어가므로 `npm run data:check -- --write`** 로 `server/economy.gen.json` 을 다시 굽는다.
- 인벤토리 필터 칩 · 정렬 순서에 카테고리를 손으로 적은 곳이 있으면 disc · record 를 넣는다.
- README (items · 건드렸으면 inventory).

### 6-2. housing — 서재 매체 (`parts/Library.ts` · `Rules.ts` · `ShipState.ts` · `ui/BookshelfMenu.ts` · `ui/BookDex.ts`)
- 보관함 일반화: `getShelfMedium` · `getShelfSlots` · `placeShelfItem` · `takeShelfItem` · `getOwnedShelfItems` · `getShelfDex` · `getShelfBonus` · `hasShelfAux` · `openShelf` (책장은 기존 `books` / `bookDex` 경로를 그대로 탄다). `getBookBonus` = 서재 배율 전체.
- `Rules`: 매체 몫 · 합산 순수 함수 (`shelfGainFor(skill, books, media, defOf, aux) → ShelfBonusInfo`), 기존 `bookGainMulFor` 는 남긴다.
- 켜기 / 끄기: `isFurnitureOn` · `toggleFurniture` → `state.toggled`, `housing:furnitureToggled` + `changed('toggle')` + 저장, `audio:play` (`tv_on` · `tv_off` · `record_on` · `record_off`).
- 회수 · 시설 제거: 디스크 · 레코드도 책처럼 창고로 (all-or-nothing, `recoverBlock` 사유). `housing:shelfChanged` (회수 = count 0).
- `ShipState` **v9**: `media` 검증(배치된 보관함 uid · 매체 일치 · 칸 < `SHELF_SLOTS` · (uid, slot) 하나) · `mediaDex` 유일 목록 · `toggled`(배치된 켤 수 있는 가구만). v8 의 방 제거 환불 경로가 책을 환불하던 것처럼 매체도. v8 → v9 는 없던 필드가 생기는 것뿐.
- 화면: 책장 패널을 매체 인자로 일반화(또는 같은 결의 `ui/MediaShelfMenu.ts`) — 칸 카드 · 가진 목록 · 도감 · 「TV 가 있어 디스크 몫 +25 %」 한 줄. 디스크 · 레코드는 `ui:shelfToggled`. CSS 접두사는 기존 `.hs-shelf` · `.hs-book*` 를 쓰거나 새로 고를 때 `rg` 로 비었는지 본다.
- `changed` 사유: `shelfPlace` · `shelfTake` · `toggle` (hub 가 `COVERED_CHANGE_REASONS` 에 넣는다).
- `smoke-library` 확장: 디스크 · 레코드 꽂기/빼기, 매체별 상한, 합산, 보조 가구 배율(레코드 플레이어 3대 = 한 번), 토글 저장 · 새로고침, sanitize.

### 6-3. housing — 헬스장 (`parts/Gym.ts` · `ui/gym/*` · 게임 판정 순수 로직)
- `gymSession` · `gymBlock`(운동 기구가 아니다 · 함선이 아니다 · 레이드 · 이미 세션 중 · 다른 화면이 열려 있다) · `startGymSession` · `cancelGymSession`.
- 미니게임 3종 — **판정은 DOM 없는 순수 클래스**(`update(dt)` · `press(key)` · `release(key)` → 판정 목록 · 점수)로 떼고 화면은 그것을 그린다 (스모크가 판정만 따로 검사할 수 있게). 시각은 `performance.now()` 기반 dt.
- 화면: 가운데 오버레이 (Arc Raiders 결의 미니멀 — 굵은 가로 바, 원형 커서, 판정 글자 `완벽` · `좋음` · `실패`, 회차 표시), blocker `housing` · 커서 모드 없음(키보드 게임) · `ctx.escape` 토큰 `housing.gym` (취소) · 키 가이드 owner `housing.gym` · 키는 capture keydown/keyup 에서 `Keys.JUMP` · `Keys.LEFT` · `Keys.RIGHT` 를 사용 시점에 읽고 삼킨다 (`Input` 이 점프를 기록하지 않게).
- 시작 안내: 기구 이름 · 올리는 능력치 · 지금 단련 보너스 · 디버프 중이면 「근육통 — 이번 운동으로는 근력이 오르지 않습니다 (남은 HH:MM:SS)」 · `Space 시작`.
- 결과: 점수 · 판정 수 · `단련 경험치 +n` · `근력 단련 +1!` · 디버프 시각. 닫으면 `housing:gymSession {active:false, completed:true}`.
- 소리: `audio:play` — `gym_start` · `gym_perfect` · `gym_good` · `gym_miss` · `gym_finish` · `gym_breath`(후 · 하) · `gym_pedal`.
- CSS 접두사 `.gym-` (`rg "\.gym-" src` 로 비었는지 확인), 모든 수치는 `GYM_*` 상수.
- 디버그 훅: `HousingSystem` 에서 스모크가 판정을 몰 수 있는 최소한 (`gymDebug` — 예: 현재 게임 객체, `finish(score)`).
- 새 스모크 `scripts/smoke-gym.mjs` (+ `scripts/verify.mjs` `SMOKES` 등록 — folders `housing` · `progression` · `hub` · `player`, `scripts/README.md`).

### 6-4. progression
- `Profile.migrate` 에 세 필드 (정수 0 … `GYM_TRAINED_MAX` · 진행도 0 … <1(상한이면 1) · 시각은 유한 ≥ 0 · `GYM_STATS` 키만). `resetProfile` 이 비운다.
- `derive.ts`: 실효 능력치에 단련을 더한다 (임플란트와 같은 자리). `getStatWithImplants` 가 단련까지 포함 — 소비자를 `rg` 로 확인.
- `getTrainedBonus` · `getTrainedProgress` · `trainedXpToNext` · `getGymFatigueUntil` · `applyGymSession` (함선 전용 · §4 공식 · 이벤트 · `derived` 재계산 · 즉시 저장).
- 캐릭터 시트: 능력치 값 옆 `(+n 단련)` — 임플란트 `(+n)` 과 다른 span · 다른 색. 디버프 중이면 행 아래 `근육통 · 남은 HH:MM:SS` (시트가 보이는 동안 1초 갱신). 단련 진행도는 짧은 한 줄.
- `smoke-progression` 확장 (공식 · 상한 · 이월 · 디버프 · 새로고침 보존 · 레이드 거절).

### 6-5. player
- `setFurniturePose` · `furniturePose` · `setFurniturePoseDrive` · `player:furniturePoseEnded` — 계약 주석의 규칙 전부 (함선 전용, 드론 · 사다리 · 포드 · 전투불능 거절, 풀면 직전 자리로, reset 조건).
- 절차 자세 4종 (`SoldierModel` 의 뼈대를 쓰는 방식으로): `sit` 흔들의자에 기대 앉기 · `bench` 벤치에 누워 바를 미는 팔(드라이브 0 → 1) · `run` 제자리 달리기(드라이브 = 걸음 위상) · `cycle` 안장에 앉아 페달(드라이브 = 크랭크 위상, 무릎이 페달을 따라간다).
- 자세 중: 이동 · 점프 · 자세 · 구르기 · 무기 · 상호작용 입력 무시, 콜라이더 해소를 건너뛰고 몸을 anchor 에 고정. `releaseOnInteract` 면 E 가 풀기(다른 상호작용은 뜨지 않는다). `camera` 가 있으면 `setCameraOverride` 로 블렌드하고 풀 때 되돌린다.
- 원격 아바타 동기화는 **하지 않는다** (§3).
- 스모크: `scripts/smoke-pose.mjs` (+ verify 등록, folders `player` · `hub`) — 거절 조건 · 풀기 · 자리 복귀 · E 풀기 · reset.

### 6-6. hub
- 절차 모델 11종 (`pendingBody` 를 지운다) — 실루엣이 읽히게, emissive 로만 빛나고 **점광원 0개** (`smoke-lights`):
  디스크 전시대(꽂힌 칸마다 등급색 케이스) · 레코드랙(슬리브) · 흔들의자(곡선 다리) · TV(`on` 이면 화면 emissive) · 축음기(나팔) · 주크박스(아치 · `on` 이면 네온) · 턴테이블(플래터 · `on` 이면 LED) · 벤치 랙(양 기둥 · 바벨 · 벤치, 세션 중 원반) · 스미스 머신(레일 프레임 · 바, 세션 중 원반) · 트레드밀(벨트 · 콘솔) · 사이클(안장 · 핸들 · 크랭크).
- `BuildExtra` 에 매체 칸 · `on` · 세션 여부. 움직이는 부분(바벨 · 벨트 줄무늬 · 크랭크)은 `FurnitureLayer.update` 에서.
- 인터랙션 배선(§5 표) · 프롬프트, `COVERED_CHANGE_REASONS` += `shelfPlace` · `shelfTake` · `toggle`, `housing:shelfChanged` · `housing:furnitureToggled` 에 그 조각의 방만 다시 짓기.
- 운동 세션 연출(§5 흐름): anchor · yaw · 옆 고정 카메라 계산, 원반 표시, 박자에 맞춘 바벨 · 페달 · 몸 위상 → `setFurniturePoseDrive`. 흔들의자 앉기 anchor. 앉을 때 `audio:play chair_creak`.
- 방문한 함선(`FurnitureSource`)이 디스크 · 레코드 · 켜짐을 그리게 (`ShipVisitWire.media` · `toggled`).
- `smoke-housing` 에 새 가구 배치 · 상호작용 id 확인이 필요하면 추가.

### 6-7. ui · audio · net · console (작은 것들)
- `ui/hud/ItemTip`: 디스크 · 레코드 툴팁에 책과 같은 「숙련」 줄 (+ 꽂는 보관함 이름).
- `ui/hud/ShipManage`: 새 글리프 다듬기 (리드의 임시 글자), 서재 · 헬스장 카드가 어색하지 않은지.
- **함선 전용 디버프 배지** `ui/hud/GymFatigueBadge` — 함선(허브)에 있을 때 걸린 디버프마다 `근육통 23:12:05`, 1초 틱, 레이드에서는 숨김. `progress:gymFatigue` 를 듣고 `ctx.progression.getGymFatigueUntil` 로 판정.
- `audio/`: 절차 SFX — `gym_start` · `gym_perfect` · `gym_good` · `gym_miss` · `gym_finish` · `gym_breath` · `gym_pedal` · `chair_creak` · `tv_on` · `tv_off` · `record_on` · `record_off`.
- `net/`: 방문 와이어(`ShipVisitWire`)에 `media` · `toggled` 를 싣는다 (`books` 를 싣는 자리 옆).
- `console/`: `gym [clear|<str|end> <xp>]` — 디버프 지우기 · 단련 경험치 주기 (`applyGymSession` 을 우회해야 하면 progression 의 공개 API 로 가능한 만큼만, 모자라면 보고).
- 각 폴더 README.

## 7. 병렬 작업 규칙

1. **자기 폴더만.** `src/shared` · `data/furniture.csv` · 다른 폴더는 고치지 않는다. 필요하면 보고서에 적는다.
2. **같은 파일을 두 에이전트가 만진다**: `src/housing/HousingSystem.ts` 와 `src/housing/README.md` (서재 매체 · 헬스장). 편집 **직전에 반드시 다시 Read** 하고, `HousingSystem.ts` 에는 자기 블록(`/* ══ 서재 매체 (A-3e) ══ */` · `/* ══ 헬스장 (A-3a) ══ */`)과 생성자 · dispose 의 한두 줄만 넣는다.
3. **타입체크**: `npm run typecheck` 는 트리 전체를 본다. 다른 에이전트가 짓는 중인 폴더의 에러는 무시하되 **자기 폴더의 에러는 0** 으로 끝낸다.
4. **스모크**: 다른 에이전트의 편집이 vite 를 전체 새로고침시키므로 5273 을 같이 쓰지 않는다. 돌려 보고 싶으면 개인 포트(`npx vite --port 53xx --strictPort`)와
   `node scripts/verify.mjs --only <스모크> --url http://localhost:53xx/ --log-dir scripts/logs/<이름> --keep-relay --no-typecheck`. 남의 편집 때문에 새로고침돼 깨진 것은 실패가 아니다. **최종 검증(`npm run verify:all`)은 리드가 한다.**
5. `CLAUDE.md` · `docs/HISTORY.md` · `docs/TODO.md` · `docs/VERIFICATION.md` 는 리드가 쓴다. 에이전트는 **자기 폴더 README**(구조 + `변경 이력`)만.
6. 커밋하지 않는다.
7. 끝나면 짧게 보고: 바꾼 파일, 계약에서 모자랐던 것, 남은 한계 · 확인 못 한 것.
