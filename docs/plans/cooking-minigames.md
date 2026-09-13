# 요리 미니게임 · 요리 품질 · 자동 조리 가구 — 설계안 (2026-09-13)

> **구현 완료 (2026-09-13, 37차)** — 결과는 [HISTORY.md](../HISTORY.md) · [VERIFICATION.md](../VERIFICATION.md) 의 37차. 폴더 README 들이 이 문서의 절(§4 · §6-n)을
> 가리키므로 지우지 않고 남긴다 (`food-tiers.md` · `enemy-factions.md` 와 같은 처리). 구현하며 바뀐 것은 맨 아래 **§8 구현 메모**.

사용자 명세 「요리 미니게임」 한 사이클. **리드가 계약(`src/shared/*`)과 데이터(`data/*.csv`)를 먼저 작업 트리에 넣었고** 폴더 에이전트 5명이 병렬로 채웠다.

선행: [food-tiers.md](food-tiers.md)(요리 티어 · 능력치 여러 줄) · [a3a-a3e.md](a3a-a3e.md)(헬스장 미니게임 · 가구 자세 — **구조를 그대로 본떴다**).

---

## 1. 사용자 명세 (요약)

- 조리대에서 요리 하나를 시작하려면 재료를 넣은 뒤 미니게임을 한다. 요리마다 종류 · 순서가 다르고 **1회(간단한 음식) · 2회(일반) · 3회(상위 티어)**.
- 요리 툴팁마다 해야 하는 미니게임 순서 · 종류를 보여 준다.
- 조리대 외의 가구를 배치하면 관련 미니게임을 스킵할 수 있다 — 썰기/다지기 · 굽기/볶기 · 젓기 · 붓기 자동. 점수 보너스는 그 가구를 **업그레이드해야** 받는다.
- **썰기**: 도마 위 재료 → 좌클 5번 탁탁탁. **다지기**: 좌클 = 좌우, 우클 = 상하, 좌 · 우 게이지 모두 채우기.
- **굽기**: 재료마다 굽는 시간이 다르다. 올려놓으면 알아서 구워지나 너무 오래 두면 점수가 낮다. 50 % 에서 뒤집기 (안 뒤집으면 점수 낮음).
- **볶기**: 타이밍에 맞춰 좌클해 퍼센트 바 채우기. 판정 매우 널널, 타이밍이 안 맞아도 차고 맞출수록 더 찬다.
- **젓기**: 좌클 누르고 있으면 자동으로 저어진다.
- **붓기**: 가운데 계량 비커, 우상단 붓는 비커. 좌클을 누르면 약 0.3 초에 걸쳐 붓는 양 0 → 100 %, 떼면 0.3 초에 걸쳐 0 %. 요리마다 정해진 양, 오차로 점수.

## 2. 사용자 결정 (AskUserQuestion 3라운드, 2026-09-13)

| # | 물음 | 결정 |
|---|---|---|
| 1 | 점수 보너스가 올리는 것 | **요리 품질** — 요리 아이템에 품질이 붙고 먹으면 능력치 수치가 오른다. 품질이 다르면 다른 칸에 쌓인다 |
| 2 | 점수가 낮으면 | **요리는 늘 나온다.** 최저점 = 원래 능력치 100 %, 점수에 따라 **최대 +25 %** |
| 3 | 품질 단계 | **6단계 ★** — ☆☆☆☆☆ 0–19 % +0 · ★ 20–39 +5 · ★★ 40–59 +10 · ★★★ 60–79 +15 · ★★★★ 80–94 +20 · ★★★★★ 95–100 +25 |
| 4 | 자동 가구 | **단계마다 「직접 하기 / 자동」 선택**, 자동 점수 = 가구 레벨 (Lv.1 0 % · Lv.2 60 % · Lv.3 100 %) |
| 5 | 자동 가구 수 | **4종** — 푸드 프로세서(썰기 · 다지기) · 자동 그릴(굽기 · 볶기) · 자동 교반기(젓기) · 계량 디스펜서(붓기) |
| 6 | 조리 흐름 | **전용 조리대 화면, 한 번에 1개** (제작 수량 없음) |
| 7 | 썰기 채점 | **리듬 박자** |
| 8 | 다지기 채점 | **균형 + 시간** — 한쪽만 연타하면 반대쪽이 조금 줄어든다, 걸린 시간으로 채점 |
| 9 | 젓기 채점 | **끓어오름 구간 유지** — 누르면 저어지며 온도 ↓, 떼면 온도 ↑, 초록 구간에 머문 시간 비율 |
| 10 | 굽기 배치 | **전부 자동으로 올라간다** — 조각 클릭 = 뒤집기, 한 번 더 = 꺼내기 |
| 11 | 연출 | **2D 미니게임 + 조리대 앞 자세 · 고정 카메라** (헬스장처럼) |

## 3. 리드 기본값 (묻지 않고 정한 것 — 사용자에게 알렸다)

- **요리 점수 = 단계 점수의 평균**. 자동으로 넘긴 단계는 그 가구 레벨의 점수로 센다.
- 공유 함선 식탁의 「분대에 차리기」는 **차린 요리의 품질 그대로** 분대원이 받는다 (`MealMessage.q`).
- 재료는 **끝날 때** 뺀다 — 중간에 닫으면(Esc · Tab · 페이즈 변경 · 자세 리셋) 아무것도 소모되지 않는다. 시작할 때도 `cookBlock` 으로 한 번 본다.
- 산출물은 **창고 먼저 → 가방** (재배 · 배양 수확과 같은 쪽). 자리가 없으면 시작 자체가 막힌다.
- 판매가는 품질과 무관 (서버 크레딧 검증이 def 가치만 안다 — E-4).
- 조리대 E 는 **인벤토리 제작 창을 더 이상 열지 않는다**. 조리대 레시피(`bench cook`)는 인벤토리 제작 경로(`canCraft` · `craft` · 제작 창)에서 빠진다 — 품질 없이 만드는 뒷문을 막는다.
- 조리 숙련 XP 는 지금처럼 `craft:completed` 가 준다 (제작 숙련, 1회분). 튜토리얼 · 토스트도 같은 이벤트를 산다.
- 자동 가구는 **함선 어디에 배치돼 있든**(주방에만 놓인다) 가장 높은 레벨 한 대가 센다. 실용 가구 규칙(같은 것은 하나만 제작)이 그대로 적용된다.
- 조리 중 자세 · 조리 버프(`cooking`)는 원격으로도 보인다 (`FURNITURE_POSE_WIRE` 에 `cook` 추가 — 누적 위상 규약 그대로).

## 4. 공식 · 판정 (수치 = `data/constants.csv` 의 `COOK_*` · `data/tables.csv`)

```
단계 점수 ∈ [0, 1]      자동이면 cookAutoScore(가구 레벨)
요리 점수 = 평균(단계 점수)                                    cookScoreOf
품질     = max{q : 요리 점수 ≥ MEAL_QUALITY_SCORE_MIN[q]}     mealQualityForScore  (0 … MEAL_QUALITY_MAX = 5)
먹었을 때 = 줄마다 amount × (1 + MEAL_QUALITY_BONUS[품질])     derive.applyMealBuff (가산 + 0 하한 규칙은 그대로)
```

판정 한 번 = 완벽 `COOK_SCORE_PERFECT`(1) · 좋음 `COOK_SCORE_GOOD`(0.6) · 실패 0. 박자 판정은 오차 ≤ 창/3 완벽, ≤ 창 좋음.

| 게임 | 입력 | 판정 · 끝 | 점수 |
|---|---|---|---|
| `chop` 썰기 | 좌클릭 | 예비 `COOK_LEAD_BEATS` 박 뒤 박자 `COOK_CHOP_BEAT_S` 마다 표식 `COOK_CHOP_CUTS` 개, 창 `COOK_CHOP_WINDOW_S`. **창 밖 헛클릭은 다음 표식의 실패**(직전 창이 닫힌 뒤) — 헬스장 `BeatGame.strayMiss` 와 같은 규칙. 놓치면 실패 | 판정 평균 |
| `mince` 다지기 | 좌클릭 = 좌우 게이지 · 우클릭 = 상하 게이지 | 클릭마다 그 게이지 +`COOK_MINCE_FILL`, **직전 클릭과 같은 버튼이면** 반대 게이지 −`COOK_MINCE_DRAIN`(0 하한). 둘 다 1 이면 끝, `COOK_MINCE_MAX_S` 가 지나면 강제 끝(점수 0) | 걸린 시간 t: t ≤ `PERFECT_S` → 1, t ≥ `ZERO_S` → 0, 사이 선형 |
| `grill` 굽기 | 조각 좌클릭 | 조각 i 는 `i × COOK_GRILL_STAGGER_S` 뒤부터 `cookGrillSeconds(재료)` 에 걸쳐 진행도 0 → 1 (계속 오른다). 안 뒤집은 조각 클릭: 진행도 < `EARLY_REMOVE` 면 **뒤집기**(\|p − 0.5\| ≤ `FLIP_PERFECT` 완벽 · ≤ `FLIP_GOOD` 좋음 · 밖 실패), ≥ `EARLY_REMOVE` 면 뒤집기 실패 + 곧장 꺼내기. 뒤집은 조각 클릭 = **꺼내기**(\|p − 1\| ≤ `DONE_PERFECT` · ≤ `DONE_GOOD` · 밖 실패). 진행도 `BURN_AT` = 타서 내려감(남은 판정 실패). 모든 조각이 내려가면 끝 | 조각 × 2 판정의 평균 |
| `stirfry` 볶기 | 좌클릭 | 예비 박 뒤 박자 `COOK_STIRFRY_BEAT_S`, 창 `COOK_STIRFRY_WINDOW_S`. 클릭은 가장 가까운 박자에 판정하고 **한 박자에 한 번만**(같은 박자의 두 번째 클릭은 무시). 바 += `FILL_PERFECT` / `FILL_GOOD` / `FILL_MISS`. 바 ≥ 1 이면 끝 | 판정 평균 |
| `stir` 젓기 | 좌클릭 꾹 | 온도 T 시작 = 구간 한가운데. 누르는 동안 T −= `HEAT_FALL`·dt, 완성 += dt / `COOK_STIR_TIME_S`. 떼면 T += `HEAT_RISE` × (1 + `SURGE` × sin(2π t / `SURGE_S`)) · dt. T 는 0 … 1. 완성 1 이면 끝 | 초록 구간(`BAND_LOW` … `BAND_HIGH`) 안 시간 비율 r: r ≥ `PERFECT_RATIO` → 1, ≤ `ZERO_RATIO` → 0, 사이 선형 |
| `pour` 붓기 | 좌클릭 꾹 | 흐름 f 는 누르면 1 로, 떼면 0 으로 `COOK_POUR_RAMP_S` 에 걸쳐 선형으로 간다. 양 += f × `COOK_POUR_RATE_ML_S` · dt. 한 번이라도 부은 뒤 f = 0 이고 `COOK_POUR_SETTLE_S` 동안 안 누르면 끝, 양 ≥ 목표 × `COOK_POUR_BEAKER_MUL` 이면 넘쳐서 곧장 끝 | 오차 e = \|양 − 목표\| / 목표: e ≤ `PERFECT_ERR` → 1, ≥ `ZERO_ERR` → 0, 사이 선형 |

단계표: `data/cook_steps.csv` (요리 def id × 순서 × 게임 × 재료 · 액체 · 목표량). 굽기 시간: `data/cook_grill.csv`.
`data:check` 가 참조(요리 · 재료 · 조리대 레시피)와 순서의 연속성을 본다.

## 5. 계약 (리드)

| 파일 | 추가 |
|---|---|
| `src/shared/cooking.ts` (신규, `index.ts` 가 export) | `CookGame` · `COOK_GAMES` · `COOK_GAME_LABEL_KO` · `COOK_GAME_ICON` · `CookJudge` · `COOK_JUDGE_LABEL_KO` · `CookBeatAction` · `CookLiquid` · `COOK_LIQUID_*` · `COOK_STEPS_MAX` · `COOK_GRILL_PIECES_MAX` · `CookStepDef` · `COOK_STEPS` · `cookStepsOf` · `cookGrillSeconds` · `COOK_*` 판정 수치 전부 · `COOK_APPLIANCE_GAMES` · `cookGamesOfAppliance` · `cookApplianceOf` · `COOK_AUTO_SCORE_BY_LEVEL` · `cookAutoScore` · `CookAutoInfo` · `MEAL_QUALITY_SCORE_MIN` · `MEAL_QUALITY_BONUS` · `MEAL_QUALITY_MAX` · `normalizeMealQuality` · `mealQualityForScore` · `mealQualityBonus` · `mealQualityStars` · `cookScoreOf` · `CookSessionInfo` · `CookResult` |
| `src/shared/types.ts` | `FurniturePoseKind` += `'cook'` · 끝 블록: `ItemInstance.quality?` · `InventoryRef.countDefQualityAll?` · `consumeDefQualityAll?` · `getMealStacks?` · `cookBlock?` · `completeCook?` |
| `src/shared/housing.ts` | `FurnitureModelKind` += `food_processor` · `auto_grill` · `auto_stirrer` · `pour_dispenser` · `FurnitureInteraction` += `cook_processor` · `cook_grill` · `cook_stirrer` · `cook_dispenser` · 끝 블록: `HousingRef.openCookStation?` · `cookSession?` · `cookBlock?` · `startCook?` · `cancelCook?` · `getCookAuto?` |
| `src/shared/progression.ts` | `useMeal(defId, quality?)` · `serveMeal(defId, quality?)` · 끝 블록: `PlayerProfile.mealQuality?` · `mealActiveQuality?` · `ProgressionRef.getMealQuality?` · `getActiveMealQuality?` |
| `src/shared/events.ts` | `progress:mealChanged` += `mealQuality?` · `activeQuality?` · `housing:mealServed` += `quality?` · 끝 블록: `ui:cookStationToggled` · `housing:cookSession` · `housing:cookStep` · `housing:cookBeat` · `housing:cookResult` |
| `src/shared/net.ts` | `FURNITURE_POSE_WIRE` += `'cook'` · 끝 블록: `PickupWire.q?` · `CorpseItemWire.q?` · `MealMessage.q?` |
| `src/shared/charBuffs.ts` | `CharBuffKind` += `'cooking'` (KINDS · ORDER · LABEL · GLYPH · COLOR · title) · `CharBuff.quality?` (meal, sanitize · same 비교 · title 에 별) |
| `data/constants.csv` | `COOK_*` 40줄 (파일 끝 블록) |
| `data/tables.csv` | `COOK_AUTO_SCORE_BY_LEVEL` · `MEAL_QUALITY_SCORE_MIN` · `MEAL_QUALITY_BONUS` |
| `data/cook_steps.csv` · `data/cook_grill.csv` (신규) | 17요리 단계 · 굽기 시간 |
| `data/furniture.csv` · `data/furniture_upgrades.csv` | 자동 조리 가구 4종 (kitchen, maxLevel 3) + 강화비 8줄 |
| `scripts/data-owners.mjs` · `scripts/data-check.mjs` | 새 csv 매핑 · 단계표 참조 검사 |

### 흐름

```
hub (E on 조리대) ─ ctx.housing.openCookStation(uid) ─▶ housing 조리대 화면 (요리 목록 · 재료 · 단계 · 자동 가구 · 창고/가방)
    (E on 자동 조리 가구 → 함선의 조리대 uid 로 같은 화면, 없으면 토스트 「조리대가 없습니다」)
조리 시작 ─ startCook(uid, recipeId): cookBlock → 세션 → 화면 닫고 오버레이 열기 → emit housing:cookSession {active:true}
hub ◀─ housing:cookSession active ─ 조리대 앞 anchor · yaw · 고정 카메라 → ctx.player.setFurniturePose({kind:'cook', …, furnitureUid})
                                     (false → ctx.housing.cancelCook())
오버레이: 단계 i ─ emit housing:cookStep {phase:'choose'} (자동 가구가 있을 때만 선택 카드, 없으면 곧장 play)
          ─ 직접: 미니게임 → 입력마다 emit housing:cookBeat → hub 손 동작(setFurniturePoseDrive) · audio 소리
          ─ 자동: 짧은 연출(`cook_auto`) → 점수 = cookAutoScore(level)
          ─ emit housing:cookStep {phase:'done', score}
마지막 단계 끝 ─ quality = mealQualityForScore(cookScoreOf) → ctx.inventory.completeCook(recipeId, 조리대 레벨, quality)
          ─ emit housing:cookResult → 결과 카드 (별 · 점수 · 요리 칩 · 올라가는 능력치 · 어디로 갔나) → 「다시 만들기」 / 「닫기」
닫기 · Esc · Tab ─ emit housing:cookSession {active:false, completed} ─▶ hub setFurniturePose(null)
```

## 6. 폴더별 할 일 (에이전트 1명 = 1묶음)

### 6-1. housing — 조리대 화면 · 미니게임 · 식탁 품질 (에이전트 `cook-housing`)
- `parts/CookGames.ts` — DOM · ctx 없는 순수 판정 클래스 6종 (`parts/GymGames.ts` 를 본뜬다), §4 표 그대로, 수치는 전부 `COOK_*`. `createCookGame(step)`.
- `parts/Cooking.ts` — `openCookStation` · `cookBlock` · `startCook` · `cancelCook` · `cookSession` · `getCookAuto` · 완료(`InventoryRef.completeCook` → `housing:cookResult`) · `bindCooking`(페이즈 변경 · `hub:left` · 자세 리셋이면 취소).
- `ui/cook/CookStation.ts` — `StationShell` 카드 배치: 요리 레일(티어별) · 선택한 요리(능력치 범위 · 재료 칩 · 단계 칩 + 자동 가구 · `조리 시작`).
- `ui/cook/CookScreen.ts` + `CookViews.ts` + `cook.css` — 하단 중앙 오버레이, 마우스 입력, 커서 모드 · blocker · Escape · Tab · 키 가이드 토큰 `housing.cook`, rAF 루프, 게임 뷰 6종, 결과 카드.
- 식탁 품질 · `cookDebug` · `scripts/smoke-cooking.mjs`.

### 6-2. inventory (+ pickups · game 와이어) — 품질 스택 · 저장 · 조리 API (에이전트 `cook-inventory`)
- 스택 열쇠에 품질 · 모든 나누기 · 복사 경로가 품질을 옮긴다 · `SavedExtras.q` · 픽업/시체 와이어 `q`.
- `countDefQualityAll` · `consumeDefQualityAll` · `getMealStacks` · `cookBlock` · `completeCook`.
- 조리대 레시피를 일반 제작 경로에서 뺀다 · 타일 ★n 배지 · 정렬은 같은 def 안에서 품질 높은 순.

### 6-3. progression + player — 식사 품질 · 조리 자세 · 버프 (에이전트 `cook-progression-player`)
- progression: 프로필 두 필드 + `migrate` · `useMeal` / `serveMeal` 품질 · 출격/종료 이동 · `applyMealBuff` 보너스.
- player: `cook` 자세(상판 기준 수치 `FURN_COOK` 가 원본) · `RemoteAvatar` · 버프 `cooking` · 식사 버프 품질.

### 6-4. hub — 자동 조리 가구 모델 · 조리대 배선 · 조리 연출 (에이전트 `cook-hub`)
- 절차 모델 4종(점광원 0) · 조리대 E → `openCookStation` · 자동 가구 E → 함선의 조리대 화면 · `interiors/CookStaging.ts`(anchor · 고정 카메라 · 손 위상).

### 6-5. ui · audio · net · console (에이전트 `cook-misc`)
- 요리 툴팁 품질 · 조리 순서 줄 · 가구 글리프 · 버프 ★ · 결과 토스트 · SFX 16종 · 식탁 와이어 `q` · `cook give`.

## 7. 병렬 작업 규칙

자기 폴더만 · 공용 파일은 편집 직전 재읽기 후 덧붙이기만 · 에이전트마다 전용 vite(5311–5315) · 최종 검증과 `CLAUDE.md` · `docs/*` 는 리드 · 커밋은 하지 않는다.
같은 트리에서 다른 세션 둘(행성별 적 팩션 · 탈출/재해/지하벌레)이 동시에 작업했다.

## 8. 구현 메모 (계획과 달라진 것)

- **손 동작 위상**: hub 는 썰기 · 다지기 · 볶기 입력마다 **한 주기**를 빠르게 돈다 (「반 주기」 는 칼이 도마에 남는다). 젓기는 누르는 동안 housing 이 0.25 s 마다 `stir` 박자를 내고,
  hub 는 마지막 박자 0.45 s 뒤 국자를 멈춘다 (계약에 「뗐다」 이벤트가 없다).
- **조리대 도구**: 기존 조리대 모델의 도마는 앞 가장자리에서 0.54 m 안쪽이라 자세의 손(가장자리 +0.3 m)이 닿지 않았다 — hub 가 도마 · 냄비 · 웍 · 그릴팬 · 비커를 움직이는 하위 그룹으로
  만들고 지금 단계의 도구를 손 앞으로 당긴다.
- **재료는 가방 → 함선 창고** 순으로 센다 (함선 작업대 제작 규칙).
- **조리대 레일은 `getRecipes('ship', 'cook', 99)`** 라 제작 숙련이 모자란 요리는 목록에 없다 — 조리대 레벨 잠김만 딤드로 보인다 (미해결).
