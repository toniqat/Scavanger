# 요리 재료 티어 — 분석기 결과표 · 흙/배지 내구도와 소켓 · 배양 스캐폴드 · T2–T4 요리 (2026-09-13)

사용자 명세 「티어별 요리 재료」 한 사이클. 계약(`src/shared/*` · 표 수치)은 **리드가 이미 작업 트리에 넣었다** —
폴더 에이전트는 계약을 고치지 않는다. 계약이 모자라면 리드에게 보고한다.

선행: [a3c-a14-a15.md](a3c-a14-a15.md)(주방 · 배양조 · 프린터) · [lab-a11-a13.md](lab-a11-a13.md)(분석기 · 추출기 · 조합대).

---

## 0. 사슬

```
T1  행성 씨앗 · 토양 ──재배 스테이션──▶ 채소 · 버섯 ──조리대 Lv.1──▶ 채소 요리 (능력치 1)          ← 연구실 없이 온실만
T2  미확인 세포 ──분석기(세포 Lv.1)──▶ 소 · 돼지 · 닭 · 양 세포주 ─┐
    작물 ──추출기──▶ 영양 배지 ────────────────────────────────┴─배양조──▶ 고기 페이스트 ─┐
    미확인 광물 ──분석기(광물 Lv.1)──▶ 암염 결정 ──추출기──▶ 소금 ──────────────────────────┴─조리대 Lv.2──▶ 페이스트 요리 (능력치 2)
T3  미확인 세포 ──분석기(세포 Lv.3)──▶ 미세조류 세포주 ──배양조──▶ 셀룰로스 ──조합대──▶ 배양 스캐폴드
    배지 → 스캐폴드 → 소/돼지/닭/양 세포주 ──배양조──▶ 종별 고기
    미확인 세포 ──분석기(세포 Lv.3)──▶ 배양지방 세포주 ──배양조──▶ 동물기름 ──────────────────▶ 조리대 Lv.3 ──▶ 고기 요리 (능력치 3)
T4  미확인 DNA ──분석기(DNA Lv.3)──▶ 난백 세포 ──추출기──▶ 난백 단백질 ─┐+ 동물기름 ──조합대──▶ 배양 달걀
                                     유단백 세포 ──추출기──▶ 카제인 + 유청 ──조합대──▶ 배양 우유 ─(+ 소금)─▶ 배양 치즈
                                     ──조리대 Lv.3──▶ 유제품 요리 (능력치 4)
소켓 미확인 DNA ──분석기(DNA Lv.1·2·4)──▶ 토양 · 배지 소켓 ──▶ 부어 둔 흙 · 배지에 영구 장착
```

## 1. 사용자 결정 (2026-09-13, `AskUserQuestion` 3라운드 12문항)

| # | 물음 | 결정 |
|---|---|---|
| 1 | 표본 체계 | **3종으로 통합** — 새 드롭은 미확인 DNA · 광물 · 세포뿐. 옛 11종은 정의가 남고 드롭에서만 빠지며, 분석기에 넣으면 **자기 계열 표본으로** 해석된다 |
| 2 | 분석 레벨이 바꾸는 것 | **시간 단축 + 결과 해금** (옛 「도감 진척률 → 시간 단축」 대체) |
| 3 | 토양 보관 | **부으면 소모** (지금 그대로) — 칸을 비우면 흙 · 소켓이 함께 사라진다 |
| 4 | 소켓 장착 | **장착하면 영구**. 가득 찬 칸에 덮어 끼우려 하면 **경고 팝업**(옛 소켓 파괴) |
| 5 | 소켓 위치 | **부어 둔 흙 · 배지에** (재배 · 배양 화면). 가방의 토양은 늘 새것이라 겹침이 유지된다 |
| 6 | 영양 배지 | **토양과 같은 내구도 규칙** — 0 이어도 계속 쓰고 배지 속도 보너스 · 소켓 효과가 내구도 비율로 줄어든다 |
| 7 | T3 고기 | **배양조에 스캐폴드 추가** — 배지 → 스캐폴드 → 세포주. 스캐폴드가 있으면 종별 고기, 없으면 고기 페이스트. 스캐폴드는 수확 때 소모 |
| 8 | 기존 배양 콘텐츠 | **전부 새 id + 옛 것 은퇴** (옛 세포주 5 · 배양 산물 5 · 특선 요리 4 — 정의만 남기고 모든 출처에서 뺀다) |
| 9 | 상위 요리의 보상 | **버프는 하나, 거기 붙는 능력치 줄 수와 수치가 늘어난다** (T1 1 · T2 2 · T3 3 · T4 4) |
| 10 | T4 경로 | **성분 + 소금 · 기름 조합** — 추출기: 세포 → 성분, 조합대: 난백 단백질 + 동물기름 → 달걀, 카제인 + 유청 → 우유, 우유 + 소금 → 치즈 |
| 11 | 소켓 수치 | **고정 종류 · 등급별 칸** — csv 에 정해진 종류, 분석기가 하나를 굴린다. 칸 수 = 흙 · 배지 등급 (일반 1 · 고급 2 · 희귀 이상 3) |
| 12 | 새 표본 출처 | **성격별로** — 세포 = 벌레 시체 · 표본 채집지, 광물 = 표본 채집지 · 고철 더미 부가 · 베헤모스, DNA = 구조물 컨테이너 · 벌레 시체 드물게 |

리드가 정한 것(사용자에게 알린다): 소켓 `speed`·`yield` 도 내구도 비율로 준다(0 이면 흙 · 배지를 갈 이유가 생긴다 → 영구 소켓이 소모처가 된다),
분석 결과는 **넣는 순간** 굴려 칸에 적는다(회수 실패로 다시 굴릴 수 없다), 수치 표는 아래 §3.

---

## 2. 계약 (리드 — 이미 들어가 있다)

| 파일 | 추가 |
|---|---|
| `src/shared/types.ts` | `ItemCategory` += `'socket'` · `MealDef.tier` 1–4 · 끝의 블록: `SampleFamily`/`SAMPLE_FAMILIES` · `SampleDef.family` · `GrowSocketTarget`/`GrowSocketEffect`/`GrowSocketDef` · `SoilDef.durability` · `MediumDef.durability` · `StrainDef.scaffoldOutputDefId/Qty/Hours` · `MealEffect` · `MealDef.effects` · `ItemDef.growSocket/scaffold/retired` |
| `src/shared/labels.ts` | 카테고리 `socket`(소켓 `⧈` `#8fe0b0`) · `MEAL_TIER_LABEL_KO` · `SAMPLE_FAMILY_LABEL_KO/COLOR/ICON` · `GROW_SOCKET_TARGET_LABEL_KO` · `GROW_SOCKET_EFFECT_LABEL_KO` |
| `src/shared/housing.ts` | 끝의 블록: 분석 레벨 함수(`ANALYSIS_LEVEL_MAX` · `analysisXpForLevel` · `analysisLevelForXp` · `analysisTimeMul`) · `ANALYSIS_XP_BY_RARITY` · `ANALYSIS_RESULTS`(← `data/analysis_results.csv`) · `AnalysisLevelInfo` · `AnalysisResultInfo` · `AnalysisSlot`/`Info` 추가 필드 · `GrowSlot`/`Info` · `CultureSlot`/`Info` 추가 필드 · `ShipState.analysisXp/analysisFound` · `HousingRef` 9개 · `SOIL_WEAR_PER_HARVEST` · `MEDIUM_WEAR_PER_HARVEST` · `GROW_SOCKET_TIME_FLOOR` · `GROW_WEAR_MUL_FLOOR` · `GROW_SOCKETS_BY_RARITY` · `growSocketSlotsFor` · `GROW_SOCKET_SLOTS_MAX` |
| `src/shared/events.ts` | `housing:analysisFound {family, defId}` · `housing:analysisLevelUp {family, level}` · `housing:socketInserted {uid, target, defId, replaced}` |
| `src/shared/constants.ts` | `SHIP_STATE_VERSION` 11 · `GATHER_SALVAGE_MINERAL_CHANCE` · `GATHER_SALVAGE_MINERAL_QTY` |
| `src/pickups/PickupVisuals.ts` | `REST_Y.socket` |
| `data/analysis_results.csv` (신규) | 계열 × 최소 레벨 × 산출물 × 개수 × 가중치 — 파일 머리 주석 |
| `data/tables.csv` | `ANALYSIS_LEVEL_XP`(0 · 4 · 10 · 20 · 36) · `ANALYSIS_TIME_MUL_BY_LEVEL`(1 · .85 · .7 · .55 · .4) · `ANALYSIS_XP_BY_RARITY`(1 · 1 · 2 · 3 · 4) · `GROW_SOCKETS_BY_RARITY`(1 · 2 · 3 · 3 · 3) |
| `data/tuning.csv` | `SOIL_WEAR_PER_HARVEST` 25 · `MEDIUM_WEAR_PER_HARVEST` 25 · `GROW_SOCKET_TIME_FLOOR` 0.4 · `GROW_WEAR_MUL_FLOOR` 0.2 |
| `data/constants.csv` | `GATHER_SALVAGE_MINERAL_CHANCE` 0.12 · `GATHER_SALVAGE_MINERAL_QTY` 1 |
| `scripts/data-owners.mjs` | `analysis_results.csv` · `sockets.csv` → 폴더 매핑 |

지금 typecheck 가 빨간 곳 = 각 에이전트의 일 (items 로더 · housing parts).

---

## 3. 데이터 · items — **에이전트 A**

### 3.1 `data/samples.csv`

- 새 열 **`family`**(필수, `cell|mineral|dna`) · **`retired`**(선택 bool). `first*` 열은 **모든 줄에서 비운다** (첫 해석 보너스 없음 — 로더는 더 붙이지 않는다).
- `rewardDefId`/`rewardQty` = **결과표가 비었을 때의 대체 산출물** (은퇴 아이템이면 안 된다).
- 옛 11종 → `retired=1` + family: `spec_tissue · spec_chitin · spec_biofilm · spec_adipose · spec_muscle` = **cell** (대체 `mat_bio_sample ×3`),
  `spec_spore · spec_genome · spec_gland · spec_ovule` = **dna** (대체 `mat_extract_bio ×1`), `spec_crystal · spec_resin` = **mineral** (대체 `mat_extract_min ×1`).
  description 끝에 한 문장: 「더 이상 발견되지 않는 옛 표본이다 — 분석기는 <계열> 표본으로 해석한다.」
- 새 3종:

| id | name | rarity | value | family | analyzeHours | 대체 산출물 |
|---|---|---|---|---|---|---|
| `spec_cell` | 미확인 세포 | uncommon | 120 | cell | 2 | `mat_bio_sample` ×3 |
| `spec_mineral` | 미확인 광물 | uncommon | 110 | mineral | 1.5 | `mat_extract_min` ×1 |
| `spec_dna` | 미확인 DNA | rare | 260 | dna | 4 | `mat_extract_bio` ×1 |

### 3.2 `data/sockets.csv` (신규, owner items)

`id,name,rarity,target,effect,amount,value,description` — category `socket`, 1×1, 스택 `SOCKET_STACK_MAX`(tuning 5 — A 가 추가), 무게 `SOCKET_WEIGHT`(tuning 0.05 — A 가 추가).
설명에는 **숫자를 적지 않는다** (툴팁이 보여 준다).

| id | name | rarity | target | effect | amount | value |
|---|---|---|---|---|---|---|
| `sock_soil_speed_1` | 뿌리 촉진 인자 I | uncommon | soil | speed | 0.08 | 180 |
| `sock_soil_speed_2` | 뿌리 촉진 인자 II | rare | soil | speed | 0.14 | 420 |
| `sock_soil_speed_3` | 뿌리 촉진 인자 III | epic | soil | speed | 0.2 | 900 |
| `sock_soil_yield_1` | 결실 인자 I | uncommon | soil | yield | 0.3 | 200 |
| `sock_soil_yield_2` | 결실 인자 II | rare | soil | yield | 0.6 | 460 |
| `sock_soil_wear_1` | 토양 안정 인자 I | uncommon | soil | wear | 0.2 | 160 |
| `sock_soil_wear_2` | 토양 안정 인자 II | rare | soil | wear | 0.4 | 380 |
| `sock_medium_speed_1` | 증식 촉진 인자 I | uncommon | medium | speed | 0.08 | 180 |
| `sock_medium_speed_2` | 증식 촉진 인자 II | rare | medium | speed | 0.14 | 420 |
| `sock_medium_speed_3` | 증식 촉진 인자 III | epic | medium | speed | 0.2 | 900 |
| `sock_medium_yield_1` | 분열 인자 I | uncommon | medium | yield | 0.3 | 200 |
| `sock_medium_yield_2` | 분열 인자 II | rare | medium | yield | 0.6 | 460 |
| `sock_medium_wear_1` | 배지 안정 인자 I | uncommon | medium | wear | 0.2 | 160 |
| `sock_medium_wear_2` | 배지 안정 인자 II | rare | medium | wear | 0.4 | 380 |

### 3.3 `data/items.csv`

**새 열** (헤더 끝 `boostUseTime` 뒤에): `soilDurability,mediumDurability,strainScaffoldOut,strainScaffoldQty,strainScaffoldHours,scaffold,retired`.

- 토양 6종 `soilDurability`: `soil_humus` 100 · `soil_ash`/`soil_frost`/`soil_spore` 150 · `soil_mineral`/`soil_saline` 250. 설명의 「(수확 n회)」 삭제.
- 배지 `mediumDurability`: `mat_medium_basic` 100 · `mat_medium_rich` 200. 설명에서 「두 번/네 번」 삭제.
- **은퇴** (`retired=1`): `strain_algae · strain_myocyte · strain_adipocyte · strain_casein · strain_ovum` — **`strainOut/Qty/Hours` 를 비운다**(배양조가 받지 않는다) ·
  `cult_algae · cult_meat · cult_fat · cult_casein · cult_albumen`. 설명 끝에 「더 이상 쓰이지 않는다.」
- **새 줄** (전부 `category: material`, 1×1, `quickUsable` 없음):

| id | name | rarity | stack | value | weight | 배양(strainOut·Qty·Hours) | 스캐폴드 산출(Out·Qty·Hours) | 기타 |
|---|---|---|---|---|---|---|---|---|
| `cell_cow` | 소 세포주 | rare | 5 | 240 | 0.1 | `food_meat_paste`·2·3 | `food_beef`·2·6 | |
| `cell_pig` | 돼지 세포주 | rare | 5 | 230 | 0.1 | `food_meat_paste`·2·3 | `food_pork`·2·6 | |
| `cell_chicken` | 닭 세포주 | rare | 5 | 220 | 0.1 | `food_meat_paste`·2·2.5 | `food_chicken`·2·5 | |
| `cell_sheep` | 양 세포주 | rare | 5 | 250 | 0.1 | `food_meat_paste`·2·3.5 | `food_lamb`·2·7 | |
| `cell_algae` | 미세조류 세포주 | uncommon | 5 | 150 | 0.1 | `food_cellulose`·3·3 | — | |
| `cell_fat` | 배양지방 세포주 | rare | 5 | 260 | 0.1 | `food_animal_fat`·2·5 | — | |
| `cell_albumen` | 난백 세포 | rare | 5 | 280 | 0.1 | — | — | 추출기 재료 |
| `cell_casein` | 유단백 세포 | rare | 5 | 280 | 0.1 | — | — | 추출기 재료 |
| `food_meat_paste` | 고기 페이스트 | uncommon | 10 | 80 | 0.25 | | | |
| `food_beef` | 배양 소고기 | rare | 8 | 200 | 0.3 | | | |
| `food_pork` | 배양 돼지고기 | rare | 8 | 190 | 0.3 | | | |
| `food_chicken` | 배양 닭고기 | rare | 8 | 180 | 0.28 | | | |
| `food_lamb` | 배양 양고기 | rare | 8 | 210 | 0.3 | | | |
| `food_animal_fat` | 동물기름 | rare | 8 | 140 | 0.25 | | | 라드 · 소기름처럼 쓰는 재료 |
| `food_cellulose` | 셀룰로스 | uncommon | 10 | 60 | 0.12 | | | |
| `food_scaffold` | 배양 스캐폴드 | rare | 5 | 170 | 0.15 | | | `scaffold=1` |
| `min_rocksalt` | 암염 결정 | common | 10 | 35 | 0.4 | | | |
| `food_salt` | 소금 | common | 20 | 25 | 0.05 | | | |
| `comp_albumen` | 난백 단백질 | rare | 10 | 110 | 0.1 | | | |
| `comp_casein` | 카제인 | rare | 10 | 110 | 0.1 | | | |
| `comp_whey` | 유청 | uncommon | 10 | 70 | 0.1 | | | |
| `food_egg` | 배양 달걀 | rare | 8 | 150 | 0.2 | | | |
| `food_milk` | 배양 우유 | rare | 8 | 140 | 0.3 | | | |
| `food_cheese` | 배양 치즈 | epic | 6 | 320 | 0.25 | | | |

### 3.4 `data/meals.csv`

`buff,amount` 두 열을 **`effects`**(`buff:amount` 를 `|` 로)로 바꾸고 `retired` 열을 붙인다. `tier` 1–4.
로더 규칙: 티어 n 요리는 능력치 n 줄 (은퇴 요리 제외 — 어기면 `r.report`). 설명에 숫자를 적지 않는다.

- T1 6종: 지금 `buff:amount` 하나 그대로.
- 은퇴: `meal_cultured_steak · meal_protein_omelet · meal_algae_broth · meal_field_ration` → `retired=1` (tier 2 · 효과 하나 그대로 — 가진 사람은 먹을 수 있다).
- 새 11종:

| id | name | rarity | tier | effects | value | weight |
|---|---|---|---|---|---|---|
| `meal_sausage` | 소시지 | rare | 2 | `maxStamina:20\|carryCapacity:5` | 270 | 0.3 |
| `meal_dumpling` | 만두 | rare | 2 | `staminaRegenMul:0.2\|healPowerMul:0.15` | 280 | 0.3 |
| `meal_meatball` | 미트볼 | rare | 2 | `carryCapacity:8\|searchSpeedMul:0.2` | 280 | 0.35 |
| `meal_beef_steak` | 소고기 스테이크 | epic | 3 | `gritChance:0.1\|maxStamina:25\|carryCapacity:8` | 540 | 0.4 |
| `meal_pork_roast` | 돼지고기 수육 | epic | 3 | `healPowerMul:0.25\|staminaRegenMul:0.25\|interactSpeedMul:0.15` | 520 | 0.4 |
| `meal_chicken_roast` | 닭고기 구이 | epic | 3 | `useSpeedMul:0.2\|maxStamina:20\|staminaRegenMul:0.2` | 500 | 0.35 |
| `meal_lamb_skewer` | 양고기 꼬치 | epic | 3 | `detectRadius:6\|gatherYieldMul:0.25\|searchSpeedMul:0.25` | 560 | 0.35 |
| `meal_lard_rice` | 기름 볶음곡 | epic | 3 | `durabilityLossMul:-0.2\|carryCapacity:10\|maxStamina:15` | 480 | 0.4 |
| `meal_cream_stew` | 크림 스튜 | legendary | 4 | `maxStamina:35\|staminaRegenMul:0.3\|healPowerMul:0.3\|carryCapacity:10` | 980 | 0.45 |
| `meal_omelet` | 치즈 오믈렛 | legendary | 4 | `skillGainMul:0.2\|gatherYieldMul:0.3\|searchSpeedMul:0.3\|interactSpeedMul:0.2` | 1000 | 0.35 |
| `meal_cheese_gratin` | 치즈 그라탕 | legendary | 4 | `gritChance:0.15\|durabilityLossMul:-0.25\|detectRadius:8\|useSpeedMul:0.25` | 1020 | 0.45 |

### 3.5 `data/recipes.csv`

- **삭제**: `cook_cultured_steak · cook_protein_omelet · cook_algae_broth · cook_field_ration`.
- **입력 교체**: `extract_medium_algae` → `food_cellulose:3` (이름 「배지 추출 · 셀룰로스」, 산출 그대로) · `extract_filament_1` → `food_cellulose:4|food_animal_fat:2` ·
  `extract_filament_2` → `mat_filament_1:3|comp_casein:2|mat_weave:1` · `extract_filament_3` → `mat_filament_2:3|food_scaffold:2|comp_albumen:2`.
- **추가** (skill 전부 `crafting`):

| id | bench | Lv | inputs | output | extra | dur | 요구 |
|---|---|---|---|---|---|---|---|
| `extract_salt` | extract | 1 | `min_rocksalt:2` | `food_salt` ×3 | | 5 | 5 |
| `extract_albumen` | extract | 2 | `cell_albumen:1` | `comp_albumen` ×3 | | 8 | 30 |
| `extract_casein` | extract | 2 | `cell_casein:1` | `comp_casein` ×2 | `comp_whey:2` | 8 | 30 |
| `mix_scaffold` | mixer | 1 | `food_cellulose:3` | `food_scaffold` ×1 | | 7 | 25 |
| `mix_egg` | mixer | 2 | `comp_albumen:2\|food_animal_fat:1` | `food_egg` ×2 | | 8 | 35 |
| `mix_milk` | mixer | 2 | `comp_casein:2\|comp_whey:2` | `food_milk` ×2 | | 8 | 35 |
| `mix_cheese` | mixer | 3 | `food_milk:2\|food_salt:1` | `food_cheese` ×1 | | 10 | 40 |
| `cook_sausage` | cook | 2 | `food_meat_paste:2\|food_salt:1\|crop_ashgrain:1` | `meal_sausage` | | 8 | 20 |
| `cook_dumpling` | cook | 2 | `food_meat_paste:2\|crop_leafgreen:2\|crop_ashgrain:2` | `meal_dumpling` | | 8 | 20 |
| `cook_meatball` | cook | 2 | `food_meat_paste:3\|crop_tuber:1\|food_salt:1` | `meal_meatball` | | 8 | 20 |
| `cook_beef_steak` | cook | 3 | `food_beef:2\|food_animal_fat:1\|food_salt:1` | `meal_beef_steak` | | 10 | 30 |
| `cook_pork_roast` | cook | 3 | `food_pork:2\|crop_leafgreen:2\|food_salt:1` | `meal_pork_roast` | | 10 | 30 |
| `cook_chicken_roast` | cook | 3 | `food_chicken:2\|food_animal_fat:1\|crop_frostberry:1` | `meal_chicken_roast` | | 10 | 30 |
| `cook_lamb_skewer` | cook | 3 | `food_lamb:2\|food_animal_fat:1\|crop_saltmelon:1` | `meal_lamb_skewer` | | 10 | 30 |
| `cook_lard_rice` | cook | 3 | `food_animal_fat:2\|crop_ashgrain:3\|food_salt:1` | `meal_lard_rice` | | 10 | 30 |
| `cook_cream_stew` | cook | 3 | `food_milk:2\|crop_tuber:2\|food_salt:1` | `meal_cream_stew` | | 12 | 40 |
| `cook_omelet` | cook | 3 | `food_egg:2\|food_cheese:1\|crop_capfungus:1` | `meal_omelet` | | 12 | 40 |
| `cook_cheese_gratin` | cook | 3 | `food_cheese:1\|food_milk:1\|crop_tuber:2\|food_animal_fat:1` | `meal_cheese_gratin` | | 12 | 40 |

- `data/furniture.csv` **설명만**: 분석기(표본을 계열별로 해석해 요리 재료 · 소켓으로 바꾼다) · 추출기(… 소금 · 성분) · 조합대(… 스캐폴드 · 달걀 · 우유 · 치즈) ·
  조리대(「강화하면 특선 요리」 → 고기 · 유제품 요리) · 배양조(배지 → 스캐폴드 → 세포주).

### 3.6 루팅 · 출처

- `loot_corpses.csv` (벌레): 옛 `spec_*` 줄을 전부 새 셋으로 — 확률은 대략 scavenger `spec_cell` .10 · hunter `spec_cell` .10 + `spec_dna` .01 ·
  warrior `spec_cell` .12 + `spec_dna` .015 · spewer `spec_cell` .10 + `spec_dna` .03 · charger `spec_cell` .10 + `spec_mineral` .04 · toxic `spec_cell` .10 + `spec_dna` .03 ·
  artillery `spec_mineral` .08 + `spec_dna` .03 · behemoth `spec_mineral` 1–2 .5 + `spec_cell` 1–2 .4 + `spec_dna` 1 .15.
  ⚠ 줄 수가 바뀌면 그 적의 `rollCorpse` rng 소비가 밀린다 — 고정 굴림을 세는 selftest(`inventory/__selftest__` 등)가 쓰는 적 종류인지 먼저 본다.
- `loot_item_weights.csv`: 표본 티어 3–5 = `spec_dna` 1 · `spec_mineral` 0.3 · `spec_cell` 0.15 (「DNA 는 구조물 컨테이너 위주」). 옛 표본 줄은 지운다.
  **새 material 줄 전부**(세포 8 · 식재료 16)는 옛 `strain_*`/`cult_*` 처럼 **티어 1–5 모두 `0`** — 안 넣으면 상자 재료 픽에 섞인다. 옛 `strain_*`/`cult_*` 0 줄은 남긴다.
- `planets.csv` `samples`: amber `spec_cell:3|spec_mineral:1` · tundra `spec_cell:2|spec_mineral:2` · mossy `spec_cell:4|spec_mineral:1` · ashen `spec_mineral:3|spec_cell:1` · crimson `spec_mineral:3|spec_cell:2`.
- 상점: 어떤 `corp_stock.csv` 규칙도 새 세포 · 식재료 · 소켓 · 은퇴 아이템을 팔지 않는지 확인만.

### 3.7 코드 (`src/items/`)

- `ItemDefs.ts`: 표본 `family` · `retired`, `first*` 더 안 붙임 · `SOCKET_ITEM_DEFS`(← sockets.csv, `ITEM_DEFS` 에서 표본 뒤) · 일반 줄의 `soil.durability`(soilTag 가 있으면 필수) ·
  `medium.durability`(mediumUses 가 있으면 필수) · 스캐폴드 산출 3열(셋 다 있거나 셋 다 없거나 — 어기면 report) · `scaffold` · `retired` · 요리 `effects`(`buff:amount` 파싱, buff enum,
  `buff`/`amount` = `effects[0]`) · `tier` max 4.
- `LootTables.ts`: `retired` 아이템은 **상자 · 보급 추첨에 절대 안 들어간다** (csv 와 별개의 안전핀).
- `scripts/data-check.mjs`: 참조 검사 — `analysis_results.csv` defId 존재 · 비은퇴, 레시피 입력/산출/extraOutputs 비은퇴, `loot_corpses`/`planets.samples` 비은퇴,
  표본 `rewardDefId` 비은퇴, 세포주 산출 · 스캐폴드 산출 존재.
- `Salvage.checkSalvageEconomy()` 초록 확인. `npm run data:check -- --write` 로 `server/economy.gen.json` 재생성.
- 문서: `items/README.md` · `data/README.md` (2026-09-13 절).

---

## 4. housing 규칙 — **에이전트 B**

소유: `src/housing/{HousingSystem.ts, Rules.ts, ShipState.ts, model.ts, parts/*}` · `housing/README.md` · `scripts/smoke-housing.mjs` · 새 `scripts/smoke-food-chain.mjs`.

### 4.1 `Rules.ts` (순수)

- `durabilityRatio(cur, max)` → 0…1 (max ≤ 0 → 0).
- `growDurationMs(growHours, matched, gardening, stationLevel, bonusRatio = 1, socketSpeed = 0)` — **뒤 두 인자 추가, 기본값이면 지금과 똑같다**.
  흙 항 = 맞으면 `1 − SOIL_MATCH_SPEEDUP × bonusRatio`, 아니면 `1 + SOIL_MISMATCH_PENALTY`. 소켓 항 = `max(GROW_SOCKET_TIME_FLOOR, 1 − socketSpeed × bonusRatio)`.
- `cultureDurationMs(hours, mediumSpeedMul, gardening, bonusRatio = 1, socketSpeed = 0)` — 배지 항 = `1 − (1 − speedMul) × bonusRatio`, 소켓 항 같음.
- `analysisDurationMs(analyzeHours, level)` = `hours × 3600e3 × analysisTimeMul(level)`, 최소 1000 ms. (`analyzeDurationMs` 는 `@deprecated` 로 남긴다.)
- `wearAfterHarvest(cur, wearPerHarvest, wearSum)` = `max(0, cur − wear × max(GROW_WEAR_MUL_FLOOR, 1 − wearSum))`.
- `rollAnalysisResult(family, level, rng01, defOk)` → `{defId, qty} | null` — `ANALYSIS_RESULTS` 에서 family · `minLevel ≤ level` · `weight > 0` · `defOk(defId)`(존재 · 비은퇴) 만 가중 추첨.
- `analysisChances(family, level, defOk)` → defId 별 확률 (도감용 — 같은 식).

### 4.2 `parts/Sockets.ts` (신규) — 흙 · 배지 공용

`socketSum(sys, ids, effect)` · `yieldBonus(sys, ids, ratio, rng01)`(소켓마다 `amount × ratio` 확률로 +1) · `sanitizeSocketIds(sys, ids, target, slots)` ·
`insertSocket(sys, holder, target, socketDefId, slots, replaceIndex)`(공용 검사 · 소모 · 교체 · 이벤트) · `getOwnedSockets(sys, target?)`.
사유: 흙/배지 없음 → `흙을 먼저 채우세요` / `배지를 먼저 채우세요` · 소켓 아님 → `소켓이 아닙니다` · 반대 대상 → `배지 소켓은 배양조에 끼웁니다` / `토양 소켓은 재배 스테이션에 끼웁니다` ·
가득 참 + `replaceIndex` 없음 → `소켓 칸이 가득 찼습니다` · 범위 밖 → `없는 소켓 칸입니다`. 끼우면 `housing:socketInserted`.

### 4.3 `parts/Lab.ts`

- `startAnalysis`: family = 표본 def 의 `family` · level = 그 계열 레벨 · `readyAt = start + analysisDurationMs(hours, level)` · **결과를 지금 굴려** `family/resultDefId/resultQty` 를 적는다
  (표가 비면 표본의 `rewardDefId/rewardQty`). 옛 「도감 비율 · 기지식」 항은 쓰지 않는다.
- `getAnalyses`: `family` · 끝난 칸만 `resultDefId/resultQty` 와 `rewardDefId/rewardQty`, `firstTime` = 끝났고 결과가 `analysisFound` 에 없다.
- `collectAnalysis`: 결과가 없는 옛 칸은 **지금 레벨로 굴린다** · 산출물 하나만 전달(첫 해석 보너스 없음) · 성공하면 칸 제거 → 경험치 `+ANALYSIS_XP_BY_RARITY[표본 등급]` →
  레벨이 오르면 `housing:analysisLevelUp` → 새 산출물이면 `analysisFound` push + `housing:analysisFound`. `sampleDex` 는 조용히 계속 채우되 **`housing:sampleDexAdded` 는 더 내지 않는다**.
- `getAnalysisLevel` · `getAnalysisResults`(minLevel 오름차순, 같은 레벨은 가중치 내림차순) · `getAnalysisFound`. `getSampleDexRatio` = 발견한 산출물 ÷ 결과표의 서로 다른 산출물 수 (`@deprecated`).
- `getOwnedSamples`: 은퇴 표본도 포함(해석된다) — 계열 순 → 시간 순.

### 4.4 `parts/Garden.ts`

- `grows()` 정리 때: `soilDurability` 가 없으면 `round(durability × clamp(soilUsesLeft / uses))` 로 옮긴다 · `sockets` 는 `sanitizeSocketIds(…, 'soil', 흙 등급 칸 수)`.
- `fillSoil`: `soilDurability = def.soil.durability`, `sockets = []`. `soilUsesLeft` 필드는 계약상 필수라 남기되 **의미는 「내구도 0 까지 남은 수확」** (`ceil(내구도 / 마모)`)로 갱신한다.
- `plantSeedAt`: `bonusRatio` · 소켓 speed 합으로 `growDurationMs` (심는 순간 확정 — 강화 재조정 `rescaleGrowsForUpgrade` 는 그대로).
- `harvestAt`: 수량 = `yieldQty(seed.yieldQty)` + `yieldBonus`(마모 **전** 비율) → 전달 → `wearAfterHarvest` → **칸을 비우지 않는다**. `gather:collected.qty` 에 보너스 포함.
- `getGrowSlots`: 새 5필드. `insertGrowSocket` · `clearSoil`(그대로 — 소켓도 사라진다) · `getOwnedSoils` 정렬 = 내구도.

### 4.5 `parts/Culture.ts`

- `cultures()` 정리: `mediumDurability` 이관 · 소켓 정리 · `scaffoldDefId` 가 스캐폴드 def 가 아니면 삭제 · **세포주 def 에 `strain` 이 없으면(은퇴) 세포주 필드만 지운다**(배지는 남는다).
- `fillMedium`: 내구도 최대 · `sockets = []`.
- `insertScaffold`(배지 있음 · 세포주 없음 · 스캐폴드 없음 · `def.scaffold`) · `takeScaffold`(세포주 없을 때만 되돌려준다, `deliverItem`).
- `insertStrain`: 스캐폴드가 있는데 세포주에 스캐폴드 산출이 없으면 `이 세포주는 스캐폴드에서 자라지 않습니다`. 시간 = 스캐폴드면 `scaffoldHours` 아니면 `cultureHours` → `cultureDurationMs(…, ratio, speed)`.
- `harvestCulture`: 산출 = 스캐폴드면 스캐폴드 산출 · 아니면 기본 산출, 수량 + `yieldBonus` → 전달 → 세포주 · **스캐폴드** 필드 삭제 → 배지 마모 → **칸을 비우지 않는다**.
- `getCultureSlots`: 새 필드, `yieldDefId/Qty` 는 스캐폴드를 반영. `insertCultureSocket`.

### 4.6 `ShipState.ts` (v11)

`freshState` 에 `analysisXp: {}` · `analysisFound: []`. **`sanitize` 가 새 필드를 버리지 않게** — `grows[].soilDurability`(유한 ≥ 0) · `grows[].sockets`(아이템 id 모양, 최대 `GROW_SOCKET_SLOTS_MAX`) ·
`cultures[].mediumDurability` · `sockets` · `scaffoldDefId` · `analyses[].family`(enum) · `resultDefId`(id 모양) · `resultQty`(정수 ≥ 1) · `analysisXp`(계열별 유한 ≥ 0) · `analysisFound`(중복 없는 id).
환불 · 마이그레이션 경로 없음 (없던 필드가 생기는 것뿐 — 옛 값 이관은 런타임 정리가 한다).

### 4.7 나머지

- `HousingSystem.ts`: 계약 9개 한 줄 위임.
- `scripts/smoke-food-chain.mjs` (신규, `window.__game`): 분석 결과를 넣는 순간 굴린다 · 회수 → 경험치 · 레벨업 · 도감 · 흙 내구도 마모 · 0 이어도 칸 유지 · 비율 보너스 ·
  소켓 끼우기 / 가득 참 / 교체 · 배양 스캐폴드 → 종별 고기 · 은퇴 세포주 거절 · **요리 `effects` 가 `derived` 에 전부 접히는지**(D 의 몫이 들어오면). `scripts/verify.mjs` 매핑(housing · items · progression)
  과 `scripts/README.md` 에 등록. `smoke-housing.mjs` 가 흙이 비는 것 · 첫 해석 보너스를 기대하면 고친다.

---

## 5. housing 화면 — **에이전트 C**

소유: `src/housing/ui/*` · `src/housing/housing.css` · `scripts/smoke-stations.mjs`. **`housing/README.md` 는 고치지 않고** 리드에게 줄 문장을 보고한다.

- **분석 화면**(`ui/Analyzer.ts`): 칸 본문에 계열 칩(`SAMPLE_FAMILY_*`) · 해석 중 결과 자리는 「?」 · 끝나면 결과 칩(`resultDefId ×qty`, `data-item-tip`) + `firstTime` 이면 「새 발견」.
  레일 탭 「해석」 · 「분석 도감」.
- **분석 도감**(`ui/SampleDex.ts` 재작성): 계열 3구획 — 머리줄(계열 · `Lv.n` · 경험치 막대 `(xp − levelXp)/(next − levelXp)` · 「해석 시간 ×0.85」),
  결과 행(발견 = 아이템 칩 + 이름 / 미발견 = 실루엣 + 「???」 / 잠김 = 「Lv.n 해금」, 확률 %, 개수 범위).
- **재배 화면**(`ui/GrowStation.ts`): 흙구멍 호버 카드에 내구도 `n / max` · 보너스 `%` · 소켓 줄. 흙구멍 안에 소켓 점(칸 수만큼, 찬 것은 채움) — **구멍 아래 시계 줄의 높이 규칙을 깨지 않는다**.
  드롭: `def.growSocket` → 빈 칸이면 `insertGrowSocket`, 가득 차면 교체할 소켓을 고르게 한 뒤 `openHoldAsk`(1초 홀드, 「끼운 소켓은 빼낼 수 없습니다 — 교체하면 <이름>은 파괴됩니다」) → `replaceIndex`.
  반대 대상 소켓은 거절 토스트. 우클릭 「흙 비우기」 에 소켓이 있으면 「소켓도 함께 사라집니다」 1초 홀드 확인.
- **배양 화면**(`ui/CultureTank.ts`): 드롭 `def.scaffold` → `insertScaffold`, 배지 소켓 흐름은 재배와 같다. 배양관 안에 스캐폴드(격자 무늬) · 소켓 점 · 내구도.
  우클릭에 「스캐폴드 빼기」(세포주 없을 때). 호버 카드: 배지 내구도 · 속도(비율 반영) · 소켓 · 스캐폴드 · 산출물(종별 고기).
- **식사 화면**(`ui/DiningTable.ts`): `mealBuffText` → 요리의 `effects` 전부 (` · ` 로 잇거나 여러 줄), 티어 이름 `MEAL_TIER_LABEL_KO`.
- `scripts/smoke-stations.mjs`: 흙이 비지 않는 것 · 새 필드 · 소켓 드롭/교체 팝업 · 스캐폴드 드롭.

---

## 6. progression · ui · world — **에이전트 D**

소유: `src/progression/derive.ts`(+README) · `src/ui/hud/*`(+README) · `src/world/Gather.ts` · `src/world/specimen.ts`(+README).

- **progression**: `applyMealBuff` 가 `meal.effects` 전부를 접는다 (없으면 `[{buff, amount}]` 로 읽는다 — 옛 def 호환). 버프마다 기존 하한 규칙 그대로.
- **ui/hud/ItemTip**: 요리 = 티어 이름 + 능력치 줄 전부 · 토양 = 내구도 최대 · 소켓 칸 수(「수확 n회」 없음) · 배지 = 내구도 · 속도 · 소켓 칸 · 세포주 = 산출 · 시간 + 스캐폴드 산출 줄 ·
  스캐폴드 = 한 줄 설명 · 소켓 = 대상 · 효과 · 수치(speed/wear %, yield 확률 %) · 표본 = 계열 칩 · 은퇴 = 「더 이상 쓰이지 않는 아이템」.
- **ui/hud/mealText**: 여러 줄 요리 문구 헬퍼. 식사가 보이는 다른 곳(`BuffStrip` 툴팁 · 식사 배지 등)이 `effects` 전부를 보이게.
- **ui 토스트**: `housing:analysisFound` 「분석 도감 — <산출물> 발견」 · `housing:analysisLevelUp` 「<계열> 분석 Lv.n — 해석 시간 ×… · 새 결과: …」(`ANALYSIS_RESULTS` 의 `minLevel === level`).
  옛 `housing:sampleDexAdded` 토스트는 남겨도 되지만 이제 나지 않는다.
- **world**: 고철 더미 부가 미확인 광물 — `GATHER_SALVAGE_MINERAL_CHANCE/QTY`, 자기 fork `gather_mineral`(코어와 같은 수법, `gather`·`gather_core` 스트림을 밀지 않는다), 코어와 둘 다 붙을 수 있다.
  `specimen.ts`/`resolveNodeWeights` 가 `retired` 아이템을 거른다(안전핀).

---

## 7. 공통 규칙

- **계약 금지**: `src/shared/*` · `data/analysis_results.csv` · 리드가 넣은 `tables/tuning/constants.csv` 줄. (A 만 `tuning.csv` 에 `SOCKET_STACK_MAX` · `SOCKET_WEIGHT` 를 더한다.)
- **자기 폴더만**. 같은 파일을 두 에이전트가 고치지 않는다 — 특히 `housing/README.md`(B) · `data/README.md`(A).
- 파일은 CRLF 다. 한국어 사유 · UI 문구.
- 확인은 `npm run typecheck`(+ A 는 `npm run data:check`). 다른 에이전트가 작업 중이라 **남의 폴더 에러는 무시**하고 자기 것만 초록으로.
  스모크를 꼭 돌려야 하면 **자기 전용 vite**(B 5291 · C 5292 · D 5293)를 띄우고 끝나면 끈다 — `npm run verify` · 5273 · git commit 금지. 전체 검증은 리드가 마지막에 한 번.
- 끝나면 보고: 바꾼 파일 · 계약과 다르게 한 것 · 남은 문제 · (C 는 README 문장).
