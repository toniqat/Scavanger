# 연구실 배치 — A-11 · A-12 · A-13 + B-13 (2026-09-11)

`docs/TODO.md` 묶음 1-G 의 **2 · 3 · 4단계**와 B-13 을 한 사이클에 넣는다. 5 · 6단계(A-14 배양조 · A-15 프린터 ·
A-16 생활 가구)와 주방(A-3c)은 **이번 범위 밖**이다 (사용자 결정).

계약(`src/shared/*` · `data/*.csv`)은 이 문서보다 먼저 커밋됐다. **폴더 에이전트는 계약을 고치지 않는다** —
계약이 모자라면 리드에게 말한다.

---

## 1. 사용자 결정 (2026-09-11)

| # | 물음 | 결정 |
|---|---|---|
| 1 | 이번 사이클 범위 | **A-11 · A-12 · A-13 + B-13**. A-14~16 은 다음 사이클 |
| 2 | 어느 방을 열 것인가 | **연구실(`lab`)만**. 주방은 다음 (작물 · 배양조 산물의 소비처는 그때 생긴다) |
| 3 | 신규 행성 게이트 | **소프트 게이트** — 막지 않고, 준비물이 없으면 지속 피해 |
| 4 | 버프 지속 모델 | **함선에서 쓰면 다음 레이드 1회분** (출격에 소모 · 그 레이드 내내 · 사망해도 그 레이드는 유지) |
| 5 | 어느 행성에 환경을 걸 것인가 | **threat 3 두 곳만** — 피로스 VII `heat` · 카민 I `toxin`. 준비물이 **100 % 상쇄** |
| 6 | 분석기 해석 시간 | **현실 시간 대기** (온실과 같은 wall-clock). 도감을 채울수록 빨라진다 |
| 7 | 새 씨앗 공급원 | **둘 다** — 행성별 야생 채집 + 분석기 해석 보상 |
| 8 | 표본 획득처 | 벌레 시체 · 새 채집 노드 · 구조물/지하실 컨테이너. **로그 시체 제외** (로그는 표본에 관심이 없다) |
| 9 | B-13 UI | **클릭 인스펙터**. 그리고 **이미 보유한 실용 가구는 제작 불가** — 딤드 + 목록 맨 아래 |

---

## 2. 계약 (이미 커밋됨 — 읽기만 한다)

### `src/shared/types.ts`
- `ItemCategory` += `'sample'` · `'prep'`
- `SoilTag` += `'saline'` · `'spore'` (`SOIL_TAGS` 동기)
- `GatherNodeKind` += `'seed'` · `'sample'`
- `EnvKind` = `'heat' | 'toxin'`, `ENV_KINDS`
- `SampleDef { analyzeHours, rewardDefId, rewardQty, firstDefId?, firstQty? }` → `ItemDef.sample?`
- `PrepDef { env, short }` → `ItemDef.prep?`
- `WorldRef.env?: EnvKind | null`

### `src/shared/housing.ts`
- `ROOM_PURPOSES_ACTIVE` += `'lab'`, `ROOM_PURPOSE_DESC_KO.lab` 갱신
- `WorkbenchKind` += `'extract'`(추출기) · `'mixer'`(조합대) + LABEL · ICON(`⧗` · `⚛`)
- `FurnitureModelKind` += `'analyzer'` · `'bench_extract'` · `'bench_mixer'`
- `FurnitureInteraction` += `'analyzer'` · `'workbench_extract'` · `'workbench_mixer'`
- `ANALYZER_SLOTS_PER_LEVEL` · `ANALYZER_MAX_SLOTS` · `analyzerSlotsForLevel` · `analyzerSlotUnlockLevel`
- `AnalysisSlot` · `AnalysisSlotInfo` · `ShipState.analyses?` · `ShipState.sampleDex?`
- `isUtilityFurniture(def)` — `interaction !== 'none'`
- `HousingRef` += `getAnalyses` · `startAnalysis` · `cancelAnalysis` · `collectAnalysis` ·
  `collectAllAnalyses` · `getOwnedSamples` · `getSampleDex` · `getSampleDexRatio` · `openAnalyzer` ·
  `furnitureUpgradeBlock` · `furnitureUpgradeCost` · `furnitureCraftBlock`

### `src/shared/constants.ts`
`SHIP_STATE_VERSION` 4 → **5**, `ANALYZE_DEX_SPEEDUP` · `ANALYZE_KNOWN_SPEEDUP` ·
`PLANET_ENV_DPS` · `PLANET_ENV_TICK_S`

### `src/shared/progression.ts`
`PlayerProfile.prep?: string[]` (다음 레이드 대기분) · `prepActive?: string[]` (이번 레이드분)
`ProgressionRef` += `getPreps` · `getActivePreps` · `usePrep` · `hasEnvPrep` · `armPreps` · `clearActivePreps`

### `src/shared/planetDefs.ts`
`PlanetDef.env: EnvKind | null` ← `data/planets.csv` 의 `env` 열

### `src/shared/labels.ts`
`CATEGORY_*` 에 `sample` · `prep`, `SOIL_TAG_*` 에 `saline` · `spore`,
새 표 `ENV_LABEL_KO` · `ENV_DESC_KO` · `ENV_COLOR` · `ENV_ICON`

### `src/shared/events.ts`
`housing:analysisChanged` · `housing:sampleDexAdded` · `housing:furnitureSelected` ·
`player:envChanged` · `progress:prepChanged`

### 데이터
- `data/samples.csv` **새 파일** — 표본 6종 (`spec_tissue` · `spec_spore` · `spec_chitin` · `spec_resin` ·
  `spec_crystal` · `spec_genome`). `sample_canister_pure`(귀중품)와 섞이지 않도록 접두사가 `spec_` 이다.
- `data/seeds.csv` +6 — 야생 4 (`seed_ashgrain` · `seed_saltmelon` · `seed_sporecap` · `seed_frostberry`),
  분석기 전용 2 (`seed_deeproot` · `seed_lumenpod`)
- `data/items.csv` — 작물 4 · 토양 2(`soil_saline` · `soil_spore`) · 성분 2(`mat_extract_bio` · `mat_extract_min`) ·
  준비물 2(`prep_respirator` · `prep_coolant`) + 새 열 `prepEnv` · `prepShort`
- `data/planets.csv` — 새 열 `seeds` · `seedNodes` · `samples` · `sampleNodes` · `env`, `soils` 에 새 토양 반영
- `data/furniture.csv` +3 (`furn_analyzer` · `furn_bench_extract` · `furn_bench_mixer`, 전부 `room: lab`,
  `maxLevel 3`) + `furniture_upgrades.csv` 6줄
- `data/recipes.csv` +6 (추출기 4 · 조합대 2), `data/quests.csv` +2 (세레스 `cl1` · `cl2`)
- `data/loot_corpses.csv` — 벌레 8종에 `spec_*` (로그 제외), `loot_category_weights.csv` — `sample` 은 티어 3~5,
  `loot_item_weights.csv` — 개량 씨앗 2종 전 티어 0, 티어 3 에서 `spec_genome` · `spec_crystal` 0

---

## 3. 폴더별 할 일

### 3.1 `housing` — 분석기 · B-13 ref · lab 규칙
- **`parts/Lab.ts`** (새 파일, `parts/Garden.ts` 가 그대로 본보기): `analyses()` 접근자 + 일회성 prune,
  `getAnalyses` · `startAnalysis` · `cancelAnalysis` · `collectAnalysis` · `collectAllAnalyses` ·
  `getOwnedSamples` · `getSampleDex` · `getSampleDexRatio` · `openAnalyzer`. `HousingSystem` 에는 한 줄 위임만.
- **`Rules.ts`**: `analyzeDurationMs(analyzeHours, dexRatio, known)` — 순수 함수. 공식은
  `analyzeHours × 3600e3 × (1 − ANALYZE_DEX_SPEEDUP × dexRatio) × (known ? 1 − ANALYZE_KNOWN_SPEEDUP : 1)`,
  최소 1000 ms. `Rules.growDurationMs` 바로 옆에 둔다.
- **`ShipState.ts`**: v5 — `analyses` · `sampleDex` 검증(uid 가 배치된 분석기인지 · 칸이 레벨 안인지 · 중복 제거 ·
  `isSampleDefIdShape` = `/^spec_[A-Za-z0-9_]{1,40}$/`), `freshState` 에 빈 값. **버릴 데이터가 없다** —
  v4 → v5 는 없던 필드가 생기는 것뿐이라 환불 경로가 필요 없다.
- **`furnitureCraftBlock(defId)`**: 재료 부족 사유에 더해, `isUtilityFurniture(def)` 이고 그 def 를
  **이미 배치했거나 가구 창고에 갖고 있으면** `'이미 보유 중입니다'`. 장식 가구는 제한 없음.
- **`furnitureUpgradeCost(uid)`**: `nextFurnitureCost(def, level)` 위임. 최대 레벨 · 없는 uid → null.
- **`ui/Analyzer.ts`** (새 패널, `ui/GrowStation.ts` 가 본보기): 좌 = 해석 칸 `ANALYZER_MAX_SLOTS` 개
  (잠긴 칸은 딤드 + 필요 레벨) + 강화 줄, 우 = 가방 + 함선 창고 (`inv.createTradeGrids`, dropSelector 로
  표본 드래그 투입) + **해석 도감**(`ui/BookDex.ts` 의 `{ root, refresh }` 패턴 그대로 `ui/SampleDex.ts`).
  1 초 틱으로 진행바 · 남은 시간만 갱신 (재구축 금지).
- `openGrowStation` 이 그랬듯 `Furniture.recover` 가 그 uid 의 `analyses` 를 버린다.
- `setRoomPurpose('lab')` 의 온실 선행 규칙(`Rules.ts:315`)은 이미 있다 — 건드리지 않는다.
- **`housing/README.md` 갱신.**

### 3.2 `hub` — 절차 모델 · 연구실 인테리어
- `interiors/Furniture.ts` 의 `Record<FurnitureModelKind, Builder>` 에 `analyzer` · `bench_extract` ·
  `bench_mixer` 셋을 더한다 (지금 타입 에러가 그 자리를 가리킨다). 분석기는 `level` 을 읽어 **열린 칸 수만큼**
  발광 창을 켠다 (`grow_station` 이 재배층을 그리는 것과 같은 방식). 외부 에셋 금지 — 전부 지오메트리.
- 분석기에 해석이 끝난 칸이 있으면 알아보게 한다 (`housing:analysisChanged` 의 `ready`).
  **광원을 새로 만들지 않는다** — 발광 재질이다 (CLAUDE.md 「씬의 광원 개수를 플레이 중에 바꾸지 않는다」).
- **B-13 클릭 인스펙터의 입력 절반**: 시설 관리 모드(`shipManageMode`)에서 배치된 가구를 클릭하면
  `housing:furnitureSelected { uid }`, 빈 곳을 클릭하면 `{ uid: null }` 을 낸다. 배치/이동 경로는 그대로 두고
  **읽기 전용 선택**만 추가한다.
- 행성 터미널 브리핑에 `PlanetDef.env` 한 줄 (`ENV_LABEL_KO` · `ENV_DESC_KO` · `ENV_ICON`).
  준비물이 없으면 경고색으로 (`ctx.progression.hasEnvPrep(env)`).
- **`hub/README.md` 갱신.**

### 3.3 `ui` — B-13 인스펙터 · 제작 잠금 · HUD 배지
- `hud/ShipManage.ts`
  - `MODEL_GLYPH` 에 새 모델 3종 (지금 타입 에러).
  - **클릭 인스펙터**: `housing:furnitureSelected` 를 받아 `.sm-confirm` 과 같은 결의 모달리스 카드를 띄운다 —
    가구 이름 · 글리프 · **Lv.n / max** · 다음 강화 비용 칩(`furnitureUpgradeCost`) · 거절 사유
    (`furnitureUpgradeBlock`) · `강화` 버튼(`upgradeFurniture`). 홀드 확정은 **없다** (되돌릴 수 없는 확정이
    아니다 — `GrowStation` 의 강화 줄과 같은 판단). 성공하면 카드를 다시 그린다.
  - **제작 카드 잠금**: `refreshCards` 가 `housing.furnitureCraftBlock(def.id)` 를 묻고, 사유가 있으면
    카드를 딤드 + `title` 에 사유 + `제작` 버튼 비활성. 정렬은 **만들 수 있는 것 먼저, 잠긴 것은 맨 아래**
    (`cardsKey` 에 그 사유를 넣어야 다시 그린다).
- `hud/` 에 **환경 배지**: `player:envChanged` 를 받아 레이드 HUD 에 `ENV_ICON` + `ENV_LABEL_KO`,
  `protected` 면 차분한 색 + 「차단됨」, 아니면 경고색 + 맥박. 레이드에서만 보인다.
- 출격 준비 점검(`LaunchWarning` 경로)에 「이 행성은 <환경>입니다 — 준비물이 없습니다」 한 줄.
  **막지는 않는다** (소프트 게이트).
- 준비물 · 표본 아이템 툴팁: `ItemTip` 이 `def.prep` 이면 「다음 레이드 1회분 · <환경> 차단」,
  `def.sample` 이면 「분석기 해석 n시간 · 산출물」 한 줄.
- **`ui/README.md` 갱신.**

### 3.4 `items` — 표본 · 준비물 정의
- `ItemDefs.ts`: `data/samples.csv` 로더 (`SEED_ITEM_DEFS` 가 본보기) → `category: 'sample'`,
  1×1, `stackMax` 는 `tuning.csv` 의 `SEED_STACK_MAX` 와 같은 결로 새 키를 쓰지 말고 3 고정이 아니라
  **rarity 로 굴리지 말고** 표에 없으므로 `SAMPLE_STACK_MAX` 를 `data/tuning.csv` 에 추가해도 된다(리드에게 알릴 것).
  아이콘 `◍`, 무게는 `SEED_WEIGHT` 수준으로 새 tuning 키.
- `items.csv` 의 `prepEnv` / `prepShort` 를 읽어 `ItemDef.prep` 을 만든다 (`soil` 파싱이 본보기).
- `ITEM_DEFS` 순서: `crop` · `soil` 뒤에 `sample`, 그다음 `prep`.
- 표본 · 준비물은 **분해 · 수리 대상이 아니다** — `Salvage` 를 건드리지 않는다.
- `data/samples.csv` 가 「아무도 읽지 않는 csv」로 남아 있으므로 이 작업이 `data:check` 를 초록으로 만든다.
- **`items/README.md` 갱신.**

### 3.5 `world` — 야생 씨앗 · 표본 채집지 · 환경 질의
- `world/soil.ts` 와 **같은 모양**으로 `world/flora.ts`(씨앗) · `world/specimen.ts`(표본) 또는 soil.ts 를
  일반화한 한 파일. `data/planets.csv` 의 `seeds`/`seedNodes` · `samples`/`sampleNodes` 를 읽는다.
- `Gather.ts`: `GatherNodeKind` `'seed'` · `'sample'` 배치. **각자 전용 rng fork**
  (`ctx.rng.fork('gather_seed')` · `'gather_sample'`) — 기존 약초 · 고철 · 토양 배치가 흔들리면 안 된다
  (같은 시드 결과 바이트 동일 규약).
- 씨앗 군락은 초지/저지대, 표본은 둥지 · 잔해 근처가 어울린다. 상호작용 동사는 씨앗 `채취` · 표본 `수습`.
- 절차 메시 2종 (`makeSoilGeometry` 가 본보기) + `paintSoilInstance` 결의 색 (씨앗은 `CATEGORY_COLOR.seed`,
  표본은 `CATEGORY_COLOR.sample`).
- 구조물 · 지하실 컨테이너의 표본은 `loot_category_weights.csv` 가 이미 처리한다 — **코드 변경 없음**.
- `WorldRef.env` 구현: 이번 레이드 행성의 `getPlanet(id)?.env ?? null`, 훈련장은 null.
- **`world/README.md` 갱신.**

### 3.6 `prep` 에이전트 — `progression` + `player` + `inventory` + `game`
- **`progression`**: `PlayerProfile.prep` / `prepActive` 영속화(옛 세이브 = 빈 배열), `getPreps` ·
  `getActivePreps` · `usePrep` · `hasEnvPrep` · `armPreps` · `clearActivePreps`, `progress:prepChanged`.
  `usePrep` 은 **함선에서만**, 같은 `env` 가 이미 있으면 한국어 사유로 거절하고 **아무것도 바꾸지 않는다**.
- **`inventory`**: 준비물 아이템을 함선에서 쓰는 경로 — 우클릭 메뉴의 `사용` (또는 더블클릭). 아이템을
  `consumeDefAll(defId, 1)` 로 뺀 **뒤** `ctx.progression.usePrep(defId)` 가 거절하면 되돌린다
  (거절이 먼저 오도록 `usePrep` 을 먼저 묻고 성공할 때만 빼는 쪽이 더 안전하다 — 구현자가 고른다).
  레이드 중에는 `사용` 이 안 보이거나 사유와 함께 잠긴다.
- **`player`**: `PLANET_ENV_TICK_S` 마다 `ctx.world.env` 를 보고, 있고 `ctx.progression.hasEnvPrep(env)` 가
  false 면 `PLANET_ENV_DPS × tick` 만큼 **체력만** 깎는다 (실드 우회 — 대기는 방탄복이 막지 못한다).
  전투불능 · 사망 · 함선 · 훈련장에서는 적용하지 않는다. 상태가 바뀔 때만 `player:envChanged`.
- **`game`**: 레이드 시작에 `armPreps()`, 레이드 종료(탈출 · 전멸 · 포기 · `game:abort`)에
  `clearActivePreps()`. 사망만으로는 비우지 않는다 — 「이미 마신 약」이다.
- 재접속 복귀에서 준비물이 사라지지 않는지 확인한다 (프로필에 살기 때문에 저절로 되지만 **확인은 한다**).
- **각 폴더 `README.md` 갱신.**

---

## 4. 하지 않는 것

- 계약(`src/shared/*`)을 고치는 것. 모자라면 리드에게 말한다.
- 주방 · 요리 · 배양조 · 3D 프린터 · 주머니 · 상급 가방 (A-14 ~ A-16, A-3c).
- 신규 행성 추가. 환경은 기존 threat 3 두 곳에만 붙는다.
- `npm run verify` / 개별 스모크 실행 — **리드가 마지막에 한 번** 돌린다. 에이전트는 `npm run typecheck`
  (와 필요하면 `npm run data:check`) 까지만.
