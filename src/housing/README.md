# src/housing/ — 함선 꾸미기 (ship housing rules, state, DOM panels)

Owner system: `HousingSystem` → publishes `ctx.housing` (`HousingRef`, contract in `src/shared/housing.ts`).
Registered in `main.ts` right after `ProgressionSystem`, before `WorldSystem` / `HubSystem`, so the hub builds the
personal ship from an already-loaded `ShipState`. This folder owns **every rule and number** (placement, costs,
prerequisites, derived multipliers), persistence, housing-mode *state*, and the remaining DOM panels
(프리셋 · 재배; the 방 메뉴 and 시설 메뉴 were removed in the Phase 8 UI pass). `src/hub/` owns the
3D side (rooms, furniture meshes, housing-mode camera / cursor) and calls into this API; `src/inventory/` supplies the
materials (`countDefAll` / `consumeDefAll`), the stash grid (`housing:stashSizeChanged`) and loadout
capture / apply; `src/progression/` reads `getSkillGainMul` inside `addSkillXp`.

## Files
| File | Role |
|---|---|
| `HousingSystem.ts` | The system + `HousingRef` implementation. Loads the state in the constructor (so `ctx.housing.state` is valid from `init`), emits `housing:loaded` and one `housing:stashSizeChanged` after load, owns housing-mode state (`housingMode / housingRoom / selectedFurniture / selectedYaw`). Every mutation (`setRoomPurpose`, `upgrade`, `place / move / recover`, `craftFurniture`, `upgradeFurniture`, `savePreset / deletePreset / applyPreset`) emits its own event **and** `housing:changed {reason}` and schedules a save. Helpers the panels use beyond the contract: `housingModeBlock(room)`, `purposeBlock(room, purpose)`, `furnitureUpgradeBlock(uid)`, `captureLoadout()`, `countDef`, `nameOf`. Closes panels + leaves housing mode on `game:newMission`, `game:abort`, `hub:left` and any phase change away from `hub`. Phase 7: `onProfileLoaded()` (`net:profileLoaded`) replaces the state with the server `ship` document (see Persistence). **Phase 8**: 함선 관리 state (`shipManageMode` / `openShipManage(room?)` / `setManageRoom` / `closeShipManage`, `shipManageBlock()`, `housing:shipManageChanged`), 온실 재배 (`getPlots / plantSeed / harvestPlot / harvestAll / getOwnedSeeds / openGrowMenu`, `nowMs()` = `ctx.net.serverNow() ?? Date.now()`), stack layers in `place / move / recover` (+ `recoverBlock(uid)`), `defOf(defId)` for the cost chips and `createShipView(host)` (delegates to `ui/ShipView.ts`). **Phase 9**: 서재 책장 — `getBooks / placeBook / takeBook / getOwnedBooks / getBookBonus / getBookDex / openBookshelfMenu`, the private helpers behind them (`books()` prunes ids `ctx.loot` no longer knows, `shelfOf / booksOf / bookAt / dropBooksOf / stashBooksOf / booksBlock / freeStashCells`), `getSkillGainMul` = 사격장 × 서재, and the 책장-aware `recoverBlock` / `purposeBlock('empty')` (`BOOKS_BLOCK_REASON` = `책을 먼저 빼세요`). **2026-09-11 (연구실 · B-13)**: the 분석 화면 panel (`analyzerPanel` — the field is not called `analyzer` so it does not collide with the `openAnalyzer` method), `analysesPruned`, and one-line delegations to `parts/Lab` (`analyses / sampleDex / analyzerOf / analysisAt / dropAnalysesOf / readyAnalyses / analysisChanged / sampleDef` + the nine contract methods) and to `parts/Furniture` (`furnitureUpgradeCost / furnitureCraftBlock`). **2026-09-11 (배양조 A-14 · 식탁 A-3c)**: the 배양 화면 (`cultureTank`) and 식사 화면 (`diningTable`) panels, `culturesPruned`, and one-line delegations to `parts/Culture` (`cultures / tankOf / cultureAt / dropCulturesOf / readyCultures / cultureChanged / mediumDef / strainDef` + the nine contract methods) and to `parts/Dining` (`isSharedTable / diningBlock / mealDef / getOwnedMeals / eatMeal / serveMealToSquad / openDiningTable`). |
| `model.ts` | 폴더 공용 어휘 — `HousingSystem` 에서 떼어낸 상수 · 타입 · 스크래치. 클래스를 참조하지 않으므로 `parts/*` 가 순환 import 없이 쓴다. `HousingSystem.ts` 가 재수출하므로 기존 import 경로는 그대로다. **2026-09-11**: `ACTIVE_FURNITURE_DEFS`(= `FURNITURE_DEFS` − `retired`) 와 `RETIRED_RACK_REASON` |
| `parts/Rooms.ts` | **방 용도와 시설 레벨**. 빈 방에 용도를 주는 것이 **시설 증축**(재료 소모, 발전기 Lv.1 게이트, **모든 용도 함선당 하나**)이다. **2026-09-12: 방 시설(작업실 · 시뮬레이션실)에는 레벨이 없다** — `upgrade('workshop' \| 'range')` 는 거절하고 발전기 · 창고만 레벨을 올린다. 방의 강화는 그 안의 가구가 하고 `placedLevelOf(sys, interaction)` 이 배치된 가구 중 가장 높은 레벨을 읽는다(`getSkillGainMul` = 시뮬레이션 허브). `getCraftCostMul` 은 늘 1. 제거하면 가구는 가구 창고로, 증축 재료는 함선 창고로 전액 돌아온다. 규칙 자체는 `Rules.ts` 가 갖고, 여기서는 그 규칙에 따라 재료를 소모하고 상태를 쓴다. |
| `parts/Furniture.ts` | **가구 배치 · 제작 · 회수**와 시설 관리 모드. 가구는 **아이템이 아니다** — 가구 창고에만 존재하고 거기서 제작된다. 배치 규칙(방 용도에 맞는가, 겹치지 않는가, 쌓을 수 있는가)과 시설 관리 모드의 커서 상태가 여기 있다. |
| `parts/Garden.ts` | **온실 재배 스테이션** (2026-09-11 개편). 한 칸은 두 단계다 — 흙을 붓고(`fillSoil`) 그 위에 씨앗을 심는다(`plantSeedAt`). 재배층은 가구 레벨이 열고(Lv.1 중앙 · Lv.2 아래 · Lv.3 위, 층 id 는 업그레이드해도 그대로), 한 층에 `GROW_SLOTS_PER_TIER`(3) 칸이다. 성장은 `ctx.net.serverNow()` 기준 **실제 시간**이고 토양 궁합 · 원예 숙련은 **심는 순간 `readyAt` 에 확정**된다. 토양은 수확마다 1회 닳아(`soilUsesLeft`) 0 이면 칸이 완전히 비워진다. 은퇴한 재배층 API 6종은 「없는 재배층」 응답으로 남아 있고 `getOwnedSeeds` 만 살아 있다. |
| `parts/Lab.ts` | **연구실 분석기** (A-12, 2026-09-11). `parts/Garden.ts` 와 같은 모양이다 — 상태 접근자(`analyses()` 는 `ctx.loot` 로 한 번 걸러 낸다 · `sampleDex()`) + `analyzerOf` / `analysisAt` / `dropAnalysesOf` / `readyAnalyses` / `analysisChanged` / `sampleDef`, 그리고 계약 9종(`getAnalyses` · `startAnalysis` · `cancelAnalysis` · `collectAnalysis` · `collectAllAnalyses` · `getOwnedSamples` · `getSampleDex` · `getSampleDexRatio` · `openAnalyzer`). 해석 칸은 **가구 레벨이 연다**(`analyzerSlotsForLevel`) 이고 칸 번호는 강화해도 밀리지 않는다. 걸리는 시간은 **넣는 순간** `readyAt` 에 확정된다(`Rules.analyzeDurationMs`). 회수는 all-or-nothing — 첫 해석 보너스가 들어갈 자리가 없으면 산출물까지 되돌리고 칸을 그대로 둔다. |
| `parts/Culture.ts` | **온실 배양조** (A-14, 2026-09-11). `parts/Lab.ts`(레벨이 칸을 연다) 와 `parts/Garden.ts`(두 단계)를 합친 모양이다 — 상태 접근자(`cultures()` 는 `ctx.loot` 로 한 번 걸러 낸다) + `tankOf` / `cultureAt` / `dropCulturesOf` / `readyCultures` / `cultureChanged` / `mediumDef` / `strainDef`, 그리고 계약 9종(`getCultureSlots` · `fillMedium` · `clearMedium` · `insertStrain` · `harvestCulture` · `harvestAllCultures` · `getOwnedMediums` · `getOwnedStrains` · `openCultureTank`). 칸은 **배지 먼저, 세포주 나중**이고 배지는 수확마다 1회 닳아 0 이면 칸이 완전히 빈다. 배양 시간은 **넣는 순간** `readyAt` 에 확정된다(`Rules.cultureDurationMs`). 수확물에는 원예 `gatherYieldMul` 을 **곱하지 않는다** — 배양조는 채집이 아니라 산출량이 세포주에 적혀 있다. |
| `parts/Dining.ts` | **주방 식탁** (A-3c, 2026-09-11). `isSharedTable` · `diningTableOf` · `diningBlock`(레이드 중에는 열리지 않는다) · `mealDef` · `getOwnedMeals` · `eatMeal` · `serveMealToSquad` · `openDiningTable`. 「먹기」는 `ctx.progression.useMeal` 에 **먼저 묻고 성공할 때만** 아이템을 뺀다 (A-13 의 `inventory/parts/StashOps.usePrepItem` 규약 그대로 — 거꾸로 하면 거절당했을 때 되돌릴 곳이 없다). 「분대에 차리기」는 공유 함선에서만 보이고 요리 **1개**를 소모한 뒤 나에게 `serveMeal` 하고 `housing:mealServed {defId, by}` 를 낸다 — **전파는 net 의 몫**이다. |
| `parts/Library.ts` | **서재 책장** (Phase 9). 숙련도마다 책이 하나씩 있고, 책장에 꽂으면 그 숙련도의 XP 배율이 오른다(상한 있음). 책은 **함선 단위**이지 캐릭터 단위가 아니며, 도감은 **꽂아 본 적 있는** 책만 기록한다. **A-3e (2026-09-12) 서재 매체**: 디스크 전시대 · 레코드랙(`ShipState.media` / `mediaDex`) · 보조 가구 · TV / 레코드 플레이어 켜짐(`toggled`) — 계약 11종 + `media()` · `mediaDex()` · `toggledUids()` · `shelfItemsOf` · `shelfBlock` · `stashShelfItemsOf` · `dropToggled`. 책장은 매체 공통 API 가 옛 `placeBook` / `takeBook` 으로 넘긴다. `getBookBonus` = 서재 배율 전체(`getShelfBonus(skill).total`). |
| `parts/Presets.ts` | **로드아웃 프리셋** (시뮬레이션실의 관물대). 저장은 `inventory.captureLoadout`, 적용은 `applyLoadout` 을 그대로 부른다 — 여기서 하는 일은 **배치된 관물대의 레벨**(2026-09-12 까지는 사격장 방 레벨)이 정한 개수(`PRESETS_BY_RANGE_LEVEL`)만큼 슬롯을 관리하는 것뿐이다. 관물대가 없으면 0 이고 저장된 프리셋은 지워지지 않는다. **2026-09-12 (사용자 결정 — 프리셋 기능 제거)**: 관물대가 은퇴하면서 프리셋 자체를 걷어냈다 — `getPresetCount` 0 · `getPresets` [] · `savePreset` / `deletePreset` false · `applyPreset` null · `openPresetMenu` no-op (`ui/PresetMenu.ts` 삭제). `state.presets` 는 세이브에 그대로 남는다. 패널 목록(`panels`)과 옛 메뉴 진입점(`openRoomMenu` · `openFacilityMenu`)은 이 파일에 그대로 있다. |
| `Rules.ts` | Pure functions, no ctx / DOM: `facilityLevel / facilityMaxLevel / nextFacilityCost / facilityBlockReason` (order: max → room → generator gate → materials), `missingIngredients`, `formatCost`, `stashSizeFor`, `presetCountFor` (관물대 level), `craftCostMulFor` (always 1 since 2026-09-12), `skillGainMulFor` (시뮬레이션 허브 level), `legacyRoomLevelCost(id, level)` (2026-09-12 — what an old 작업실 / 사격장 level cost, read only by the v7 migration), `purposeChangeReason` (`lab` needs a greenhouse; **every purpose at most one per ship** since 2026-09-12 — was 작업실 / 사격장 only), `furnitureAllowedIn`, `insideGrid`, `furnitureAtCell`, `canPlaceAt` (purpose or `'any'` + inside `ROOM_GRID_COLS × ROWS` after `furnitureFootprint` + no overlap, `ignoreUid` for moves), `nextFurnitureCost`, `furnitureUpgradeReason`; **Phase 9** `bookWeightOf(def)` (a book's `BOOK_RARITY_MUL[rarity]`, 0 for a non-book) and `bookGainMulFor(skill, books, defOf)` (the 서재 multiplier). **Phase 8 stacking**: `stackLimitOf(def)`, `layerOf(item)`, `stackMembers(state, room, def, x, y, yaw, ignoreUid?)`, `nextFreeLayer(members, limit)`, `topLayer(members)`, `recoverBlockReason(state, item)`; `canPlaceAt` lets a `stackLimit > 1` def share its footprint with the **same** def at the same cell + yaw while the stack is below its limit (everything else keeps the strict no-overlap rule), and `furnitureAtCell` now returns the **top** layer. Callbacks `CountFn` / `NameFn` stand in for inventory and item names. **2026-09-10 자동 배치**: `AUTO_PLACE_YAWS` · `DOOR_CLEAR_DEPTH` / `DOOR_CLEAR_SPAN` · `doorClearanceCell(room)` · `autoPlaceSpot(state, room, def)` → `FurniturePlacement | null` (2026-09-11: 2차 패스 + `doorPassageOpen(state, room, extra?)`) — **2026-09-12 (방 8 × 8 m)**: 순회 상한은 `ROOM_GRID_COLS/ROWS` 라 저절로 따라가고, `DOOR_CLEAR_DEPTH` 2 · `DOOR_CLEAR_SPAN` 4 는 **그대로 둔다** — 둘 다 칸수의 비율이 아니라 문 치수(폭 1.6 m · 플레이어 지름 0.9 m)에서 나오고, `(ROWS − SPAN)/2` 가 16칸에서도 구역을 방 중앙(칸 6…9 = 3.0…5.0 m, 문 3.2…4.8 m)에 물렸다 — 「화면 좌측 상단부터 가로줄 먼저, 가구는 화면 아래를 향한다(yaw 1), 출입구 앞은 비운다」 (아래 `자동 배치` 절). **연구실 (2026-09-11)**: `analyzeDurationMs(analyzeHours, dexRatio, known)` — `growDurationMs` 바로 옆의 순수 함수다 (`analyzeHours × 3600e3 × (1 − ANALYZE_DEX_SPEEDUP × dexRatio) × (known ? 1 − ANALYZE_KNOWN_SPEEDUP : 1)`, 최소 1000 ms). 진행도 · 남은 초는 `growProgress` / `growRemainingS` 를 **그대로 쓴다** — 둘은 순수한 시각 계산이라 작물인지 표본인지 모른다 (같은 폴더 안이므로 한 번 더 베끼지 않는다). **배양조 (2026-09-11)**: `cultureDurationMs(cultureHours, mediumSpeedMul, gardening)` — `analyzeDurationMs` 옆의 순수 함수다 (`cultureHours × 3600e3 × mediumSpeedMul × (1 − GROW_SKILL_SPEEDUP × 원예/SKILL_LEVEL_MAX)`, 최소 1000 ms); 원예 항은 `growDurationMs` 가 쓰는 것과 **같은 항**이다 (온실 가구이므로 같은 숙련이 일한다). **주방 (2026-09-11)**: `NEEDS_GREENHOUSE` (= `['lab','kitchen']`) — 「온실이 먼저 있어야 한다」의 단일 원본이고 `purposeChangeReason` · `ShipState.sanitize` · `Rooms.setRoomPurpose` 셋이 그 한 줄을 읽는다. **2026-09-12 (조종석 · 시설 레벨 요구)**: `isPlaceRoom(state, room)` (방 또는 `COCKPIT_ROOM_INDEX`) · `placeRoomPurpose` (조종석 = `'cockpit'`) · `isAssignablePurpose` (`ROOM_PURPOSES_ASSIGNABLE`); `purposeChangeReason` 은 조종석 · 지을 수 없는 용도(시뮬레이션실 · 휴식 공간)를 한국어 사유로 거절; `insideGrid(def, x, y, yaw, room = 0)` 와 `canPlaceAt` 은 `roomGridSize(room)` · `roomRectBlocked` 를 읽고, `autoPlaceSpot` 은 조종석에서 문 앞 구역 없이 한 패스만 돈다. `generatorRequirement` · `furnitureUpgradeRequirementsFor` · `purposeRequirementsFor` (채워지지 않은 시설 레벨 요구만). `presetCountFor` · `skillGainMulFor` 는 `@deprecated`(호출자 없음). |
| `ShipState.ts` | `freshState()` (**2026-09-07: ten empty rooms and no furniture** — the built-in 작업실 with its 총기 작업대 + 정비 벤치 is gone; generator 0, storage 0, empty furniture storage, no presets, `plots: []`, `nameLocked: false`), `sanitize(raw)` (clamps levels, drops unknown defs / purposes, keeps **at most one facility room of each kind** and moves furniture whose room no longer accepts it into furniture storage, a `lab` without a greenhouse becomes `empty`, every placed piece must pass `canPlaceAt` against the pieces accepted before it, duplicate / malformed uids are re-minted after the highest valid one), `loadState()`, `writeState()`, `ShipStore` (350 ms debounce, `pagehide` / `beforeunload` flush, try/catch around localStorage; Phase 7: `flush()` also `upload()` = `ctx.net.profile.set('ship', state)` when a profile is available, `cancel()` drops a pending write). Key `SHIP_STORAGE_KEY` (`scav.ship`), version **`SHIP_STATE_VERSION_CURRENT` = 3** (Phase 9 — `Math.max(3, SHIP_STATE_VERSION)`; the contract's `SHIP_STATE_VERSION` is 3 now, so the two agree again). Phase 8 also sanitises `plots` (rack must still exist, slot < `GROW_PLOTS_PER_RACK`, one plot per (uid, slot), usable timestamps), re-assigns stack `layer`s (persisted layer kept when free, else the lowest free one; a full stack drops the piece) and ran the **v1 → v2 정비 벤치 grant** (one `furn_repair_bench` Lv.1 into the furniture storage). **2026-09-12 에 그 지급을 걱어냈다** (사용자 결정 — 정비 벤치 은퇴, `data/furniture.csv` 의 `retired=1`): 은퇴 가구를 걱어내는 두 자리(배치 · 보관)가 둘 다 그 줄보다 **위**라, 지급하면 걸러지지 않고 가구 창고에 은퇴 가구가 남았다. `REPAIR_BENCH_DEF_ID` 는 이름만 남긴다(추가만 하고 지우지 않는다); private `hasRepairBench` 는 쓰는 곳이 없어졌다. `isGrowRackDefId(defId)`. **Phase 9 (v3)**: `freshState()` gains empty `books` / `bookDex`; `sanitize` keeps a `PlacedBook` only when its 책장 uid is still placed, its slot is `< BOOKS_PER_SHELF`, the (uid, slot) pair is free and the def id has the `book_*` shape (`isBookDefIdShape` — whether it still resolves to a real 서적 is a runtime check in `HousingSystem.books()`), and rebuilds the 도감 as a unique list of `book_*` ids that always contains every shelved book. `isBookshelfDefId(defId)` (`interaction === 'bookshelf'`). `ShipStore.upload()` dropped its `available` guard: it calls `profile.set('ship', …)` **offline too** and `ProfileSync` queues it (newest-wins on the next connection). **온실 개편 (v4, 2026-09-11)**: `freshState()` gains `grows: []`; `sanitize(raw, out?)` takes an optional `SanitizeOutcome` and (a) sweeps out every `retired` def — placed and stored — accumulating `Rules.furnitureRefundCost × qty` into `out.refund`, (b) drops the old `plots` wholesale (always written back `[]`), (c) validates `grows` against the 재배 스테이션 that owns them (placed uid · a tier the station's **current level** opens · slot `< GROW_SLOTS_PER_TIER` · one entry per (uid, tier, slot) · `soil_*`-shaped id · planting fields only when `plantedAt > 0`). `loadState()` now returns `{state, fresh, refund}`. `isGrowStationDefId(defId)` (`interaction === 'grow_station'`) and `isRetiredDefId(defId)` join `isGrowRackDefId` (deprecated but kept). **연구실 (v5, 2026-09-11)**: `freshState()` gains `analyses: []` / `sampleDex: []`; `sanitize` validates an `AnalysisSlot` against the 분석기 that owns it (placed uid · `slot < analyzerSlotsForLevel(현재 레벨)` · one entry per (uid, slot) · `spec_*`-shaped id (`isSampleDefIdShape`) · a real `startedAt`, `readyAt` clamped to ≥ it) and rebuilds `sampleDex` as a unique list of `spec_*` ids. **v4 → v5 has no migration** — 없던 필드가 생기는 것뿐이라 버릴 데이터도 환불 경로도 없다. `isAnalyzerDefId(defId)` (`interaction === 'analyzer'`). **배양조 (v6, 2026-09-11)**: `freshState()` gains `cultures: []`; `sanitize` validates a `CultureSlot` against the 배양조 that owns it (placed uid · `slot < cultureSlotsForLevel(현재 레벨)` · one entry per (uid, slot) · an item-id-shaped 배지 · the 세포주 fields only together with a real `startedAt` — a half-written entry leaves plain 배지 behind, like `grows` does with its seed). 배지 · 세포주 ids carry **no prefix of their own** (`mat_medium_*` · `strain_*` are ordinary `material` ids), so the shape check only keeps out junk and the real def check is the runtime prune in `parts/Culture.cultures()`. **v5 → v6 도 마이그레이션이 없다.** `isCultureTankDefId(defId)` (`interaction === 'culture_tank'`) · `isDiningTableDefId(defId)` (`interaction === 'dining_table'`). 그리고 「온실 선행」 낙오 처리가 `lab` 뿐 아니라 `Rules.NEEDS_GREENHOUSE` 전부(= 연구실 · 주방)를 본다. **방 시설 레벨 제거 (v7, 2026-09-12)**: 모양은 그대로이고 `RoomState.level` 이 늘 1(빈 방 0)로 내려간다. `version < 7` 세이브만 한 번 옮긴다 — 사격장 Lv.n(n ≥ 2)은 배치된 관물대 · 시뮬레이션 허브의 레벨을 `max` 로 올리고(창고에만 있으면 가장 높은 한 점을 그 레벨로 떼어 낸다), 둘 다 함선에 없으면 `legacyRoomLevelCost('range', n)` 을, 작업실 Lv.n 은 늘 `legacyRoomLevelCost('workshop', n)` 을 `out.refund` 에 더한다(은퇴 가구와 같은 자루 → 함선 창고). `SanitizeOutcome.migratedRoomLevels` · `loadState().migrated` 가 참이면 `HousingSystem` 이 곧바로 저장을 걸고 `editPending` 을 세워, 디바운스 안에 온 옛 서버 사본이 옮긴 결과를 덮지 못하게 한다. 이미 두 개 지어 둔 같은 용도 방은 **그대로 둔다**(강제 철거 없음). **조종석 · 방 8 개 (v8, 2026-09-12)**: `freshState()` 가 `ensureCockpitFurniture` 로 조종석에 시술대(f-1) · 컴퓨터(f-2)를 놓는다. `sanitize` 는 원본 방을 최대 `MAX_SAVED_ROOMS` 개 읽어 방 번호 ≥ `SHIP_ROOM_COUNT` 인 시설 방과 `ROOM_PURPOSES_ASSIGNABLE` 밖의 용도(시뮬레이션실 · 휴식 공간)를 **제거 + 환불**(`roomRefundCost(purpose, 1)` → `out.refund`, 가구 → 가구 창고, 가구 창고로 간 책장의 책 → `out.refund`)하고, 조종석 가구는 `'any'` + `canPlaceAt` 을 지나야 남는다. v7 절(v6 이하 방 레벨)은 관물대 · 허브가 은퇴해 사격장 Lv.n 을 늘 환불한다. 끝에서 `ensureCockpitFurniture` 가 어디에도 없는 공용 시설 가구를 채운다. `SanitizeOutcome.migratedRooms` · `grantedCockpit`, `loadState()` → `{…, migrated, granted}`. |
| `ui/Panel.ts` | `HousingPanel` base for the three menus: `.menu.housing-menu` root under `ctx.uiRoot`, blocker token **`'housing'`** added first and then the **in-game cursor** (`ctx.input.setCursorMode(true, 'housing')` — Phase 10: the pointer lock is *kept*, so there is no `exitPointerLock()` and no microtask re-lock; `close()` releases both), **`Keys.INTERACT` (E)** through a capture-phase `window` keydown listener (registered only while open, `stopImmediatePropagation` so `Input` never sees it) — 2026-09-08: **was Escape**, which is the 일시정지 메뉴 everywhere now; E is the key that opened the panel from the furniture. Ignored while `MENU_BLOCKER` is up, and skipped when the event target is an `<input>` / `<textarea>` (capture runs before the field's own handler, so the E of a 프리셋 이름 would otherwise close the panel), `ui:housingToggled {open, page}` (the 재배 and 책장 pages report `page: null` — the contract's page union is frozen — and carry `ui:growToggled` / `ui:bookshelfToggled` instead). **2026-09-09**: **Tab (`Keys.INVENTORY`) closes them too** (taken even from a focused field), and each panel is a 키 가이드 owner `housing.<page>` with `keys: []` (`ui:keyGuide`). Auto-refresh on `housing:changed`, `inventory:changed`, `inventory:stashChanged`. **2026-09-12**: `coalesceRefresh` (스테이션 네 화면이 켠다) — 한 호출 스택의 이벤트 여러 개를 `queueMicrotask` 로 refresh **한 번**에 합친다 (`requestRefresh()`, `refreshStats {requests, runs}`); `overlays: PanelOverlay[]` — 열린 모달 · 우클릭 메뉴가 있으면 E · Tab 이 그 맨 위 하나만 닫고, `close()` 가 전부 닫는다; `deny(reason)` = 거절음 + `ui:notify` 토스트 + 메시지 줄. |
| `ui/GrowStation.ts` | **재배 화면** (온실 개편 2026-09-11 · 화면 개편 2026-09-12, `openGrowStation(uid)` ← E on a 재배 스테이션). `StationShell` 틀 — 머리줄 「재배 스테이션」 + `Lv. n` · 우상단 업그레이드(`UpgradeModal`, 여는 층은 `growTiersForLevel` 에서 유도), **좌 = 재배층, 우 = 가방 + 함선 창고.** 한 층은 **하얀 바** 하나에 **흙구멍**(위가 잘린 39 px 원, `clip-path`) 3개가 박혀 있고 바의 윗변이 구멍의 윗변이다. 흙을 부으면 구멍이 `SOIL_TAG_COLOR` 로 80 % 차고, 심으면 구멍 위 `--gs-plant-h` 영역에서 줄기 · 잎(씨앗 글리프 → 다 자라면 수확물 글리프)이 `--g`(진행도) transform 으로 자란다 — 그 높이가 층 간격이다. 구멍 아래 한 줄은 **어느 상태에서도 높이가 한 픽셀도 변하지 않는다** (2026-09-12, 사용자 결정): 흙 없음 = 「토양 필요」(빨강) · 흙만 = `00:00`(딤드) · 자라는 중 = `HH:MM:SS` · 다 자람 = 「수확 가능」(초록). CSS 가 `.gs-time` 의 `height` · `line-height` · `font-size` 를 못 박고 상태별로는 **색과 굵기만** 바꾼다. 나머지는 **영역별 호버 카드**(`StationTip`)다 — **흙구멍(`.gs-pot`) 위 = 토양 카드**(종류 · 속성 태그 · 남은 수확 횟수), **그 위의 식물 공간(`.gs-plant`, 시계 · 칸 나머지 포함) = 작물 카드**(씨앗 · 남은 시간 · 궁합 % · 수확물); 정보가 없으면 「비어 있음」 한 줄이다. `.gs-plant` 는 그래서 `pointer-events` 를 되돌려 받았고, **드롭 대상은 여전히 `.gs-pot[data-tier]` 하나**다(둘은 세로로 겹치지 않는다). 우클릭은 `StationMenu`(「흙 비우기」 / 「작물 버리고 흙 비우기」). **잠긴 층은 테두리만**(자식 없음). 드롭은 `createTradeGrids({dropSelector:'.gs-pot[data-tier]'})` → 토양이면 `fillSoil`, 씨앗이면 `plantSeedAt`. **맨 왼쪽 레일 = 함선의 재배 스테이션 목록**(`StationShell.rail`): 항목마다 이름 + **3×3 원형 점 9개**(`getGrowSlots(uid)` 순서 그대로 — 회색 = 자라는 중 · 까망 = 자랄 게 없음(잠긴 칸 포함) · 초록 = 수확 가능) + 익은 칸이 있으면 **레드닷**(이름 왼쪽의 자리를 늘 차지하는 점 — 레일이 세로 스크롤 컨테이너라 모서리 배지는 잘린다), 누르면 그 스테이션으로 전환한다. 목록은 배치 구성이 바뀔 때만 짓고 점 색은 1초 틱(`paint`)이 칠한다. 스테이션이 하나뿐이어도 숨기지 않는다 — 현황 점이 한 대짜리 함선에서도 쓸모 있고 분석기 탭 레일과 같은 자리에 서야 하기 때문이다. 다 자란 칸은 `ProductDrag` — 더블클릭 `harvestAt(…, 'stash-first')`, 격자에 끌어다 놓기 `'bag'` / `'stash'`, 거절은 `deny` 토스트. **층 DOM 은 스테이션 uid · 레벨이 바뀔 때만 다시 짓고**(`debug.builds`), 나머지 변화 · 1초 틱은 `paint()` (클래스 · 흙 색 · `--g` · 시계 · 열린 카드)만. Emits `ui:growToggled {open, uid}`; `ui:housingToggled` 에는 `page: null`. |
| `ui/Analyzer.ts` | **분석 화면** (A-12, 2026-09-11 · 화면 개편 2026-09-12, `openAnalyzer(uid)` ← E on a 분석기). `StationShell` 틀 (업그레이드 모달이 여는 칸 수는 `analyzerSlotsForLevel` 에서 유도). **맨 왼쪽 레일 = 세로 탭(「해석」 · 「해석 도감」, `StationShell.rail` — 2026-09-12 에 좌 패널 안 `.az-split` 에서 화면 바깥의 독립 열로 나갔다. 재배 스테이션 목록과 같은 자리 · 같은 결), 좌 패널 = 그 페이지, 우 = 가방 · 함선 창고 격자.** 해석 칸 `ANALYZER_MAX_SLOTS` 줄 중 **잠긴 칸은 빈 칸**(자식 없음, 드롭 대상 아님)이고, 열린 칸은 **세 열**이다 — 글리프 칸(`.az-cell[data-slot]` = 드롭 대상, 표본이면 `data-item-tip` 으로 아이템 카드) | 본문(이름 · `HH:MM:SS`(끝나면 「해석 완료」) · 진행바) | 버튼(「회수」 `collectAnalysis(…, 'stash-first')` · 「중단」). 버튼은 2026-09-12 에 `position: absolute` 를 버리고 자기 열로 들어왔다 — 좌 패널이 좁아져도 남은 시간 게이지와 겹치지 않는다. 끝난 칸은 `ProductDrag` 로 더블클릭 · 끌기 회수. 도감(`createSampleDex`)은 도감 탭일 때만 갱신한다. 칸 DOM 은 레벨이 바뀔 때만 다시 짓는다. 소비자는 `housing:analysisChanged` 를 본다. |
| `ui/SampleDex.ts` | **해석 도감** (`createSampleDex(ctx, housing, host)` → `SampleDexView {root, refresh()}`): `ui/BookDex.ts` 와 같은 규약 — pure DOM into `host`, no blocker, no listeners. 표본 def 하나에 한 행(해석 시간 짧은 순): 아이템 칩 + 이름 + 「기본 n시간 · 산출물 ×n · 첫 해석 …」 + 해석함 / 미해석. 머리줄은 `getSampleDexRatio()` 와 그것이 지금 주는 해석 시간(`ANALYZE_DEX_SPEEDUP` 의 첫 항을 그대로 되읽는다)을 적는다. 아이템 표의 표본 목록이 바뀌면 행을 다시 짓는다(`builtKey`). |
| `ui/CultureTank.ts` | **배양 화면** (A-14, 2026-09-11 · 화면 개편 2026-09-12, `openCultureTank(uid)` ← E on a 배양조). `StationShell` 틀이고 **수확 규칙은 재배 스테이션과 같다** — 칸 버튼 · 모두 수확이 없고, 끝난 칸은 `ProductDrag`(더블클릭 = 창고 먼저 · 끌기 = 그 격자), 배지 비우기는 우클릭(「배지 비우기」 / 「세포주 버리고 배지 비우기」 = `clearMedium(…, discardStrain)`), 부연은 호버 카드(배지 · 배양 속도 · 세포주 · 남은 시간 · 산출물). 한 줄 = 배양관(`.cult-cell[data-slot]` = 드롭 대상, 안이 배지 색으로 78 % 차오른다 `.cult-fluid`) + 위 이름 · 아래 `HH:MM:SS` / 「수확 가능」 + 진행바. 잠긴 칸은 빈 칸. 떨어뜨린 것이 `def.medium` 이면 `fillMedium`, `def.strain` 이면 `insertStrain`. CSS 이름은 **`.cult-*`** (옛 `.ct-*` 는 기업 화면과 겹쳤다). 소비자는 `housing:cultureChanged` 를 본다. |
| `ui/DiningTable.ts` | **식사 화면** (A-3c, 2026-09-11 · 화면 개편 2026-09-12, `openDiningTable(uid \| null)` ← E on a 식탁; **null = 공유 함선의 고정 식탁**). `StationShell` 틀(`upgrade: false` — `Lv.` · 업그레이드 없음, 설명 줄 없음). **좌 = 접시**(지금 실린 식사 칩 + `mealBuffText` 한 줄 + 안내, `.dt-plate` 자체가 드롭 대상이라 요리를 끌어다 놓아도 먹는다) **+ 가진 요리 목록**(칩 + 이름 · 일반/특선 · 버프 + `먹기`, 공유 함선이면 `분대에 차리기`), **우 = 가방 · 함선 창고 격자.** 규칙은 하나도 여기 없다 — `parts/Dining` 이 돌려주는 한국어 사유를 메시지 줄에 옮길 뿐이다. 버프 표기의 원본은 계약의 `MEAL_BUFF_LABEL_KO` · `MEAL_BUFF_UNIT` 한 쌍이고(`mealBuffText` 가 이 파일에서 export 된다), 단위가 `'%'` 인 줄만 `amount × 100`, 부호는 값이 정한다 — `durabilityLossMul` 은 음수라 「장비 손상 −20 %」로 읽힌다. 1초 틱이 **없다**(현실 시간 타이머가 없는 화면이다). |
| `ui/BookshelfMenu.ts` | **책장 패널** (Phase 9, `openBookshelfMenu(uid)` ← E on a 서재 책장): `BOOKS_PER_SHELF` slot cards (item chip, the skill the book teaches and its weight, 꽂기 / 빼기), a picker of the books the player owns (`getOwnedBooks()` = bag + stash, `buildItemChip` with the count; click = select, click again = deselect) and the 도감 below it. Every rule lives in `HousingSystem.placeBook / takeBook` — the panel only shows their 한국어 refusals. Emits `ui:bookshelfToggled {open, uid}`, `page: null` on the `ui:housingToggled` wire. **A-3e (2026-09-12)**: one panel for **every 서재 보관함** — `openShelf(uid)` reads `getShelfMedium(uid)` and redraws (`data-medium`, `SHELF_SLOTS[m]` cards rebuilt only when the medium changes, `getOwnedShelfItems(m)` picker, 도감 `setMedium(m)`, 매체별 설명 · 단위) plus the 보조 가구 line `.hs-shelf-aux` (`… 배치됨 — 디스크 몫 +25 %`, from `SHELF_AUX_BONUS`). Rules: `placeShelfItem / takeShelfItem`. 책장 → `ui:bookshelfToggled`, 디스크 전시대 · 레코드랙 → `ui:shelfToggled {open, uid, medium}`; switching pieces closes (and emits for) the old one first. |
| `ui/BookDex.ts` | `createBookDex(ctx, housing, host)` → `BookDexView {root, refresh()}`: the **도감**, one row per skill in `SKILL_IDS` order — 한국어 skill name (`ctx.progression.getSkillDef`), the book that teaches it (`ItemDef.book.skill`, chip + title), 보유 / 미보유 from `housing.getBookDex()` and the live 서재 multiplier from `housing.getBookBonus(skill)`. Pure DOM into `host`: no blocker, no listeners — the owner (책장 panel, 함선 tab) calls `refresh()` on its own events. **A-3e (2026-09-12)**: `createBookDex(ctx, housing, host, medium = 'book')` + `setMedium(m)` — rows list the item of that medium per skill (`shelfItemOf`), 보유 from `getShelfDex(m)`, the multiplier column is the whole 서재 배율 and its `title` breaks it down per medium. |
| `ui/FacilityRows.ts` | The 시설 rows + 효과 summary renderer used by `ShipView` (embedded 함선 tab): level, pips, `renderCost` chips, 한국어 block reason, upgrade button, derived summary. Takes the facility ids to list and the section label (**Phase 8 UI pass**: the 함선 tab passes `['generator','storage']` under 기본 시설). **2026-09-12**: 작업실 / 시뮬레이션실 have no levels; the 효과 summary dropped the 제작 비용 배율 line and labels the preset / 사격 숙련 lines with the furniture that drives them (관물대 · 시뮬레이션 허브). Touches only the host element it is handed — **no blocker, no pointer lock, no window listener**. **2026-09-12 (시뮬레이션실 · 프리셋 제거)**: 효과 요약은 창고 크기 · 작업대 레벨만 — 프리셋 슬롯 · 사격 숙련 줄을 뺐다. |
| `ui/ShipView.ts` | `createShipView(ctx, housing, host)` → `EmbeddedView` for the **함선 tab** of the inventory Tab screen. **Phase 8 UI pass layout**: two columns — left `FacilityRows(['generator','storage'], '기본 시설')` + 효과 summary, right the 방 목록 (10 rows: `방 n · 용도`, 가구 n개 + purpose description, a `<select>` purpose picker whose options are disabled from `purposeBlock`, and for a 작업실 / 사격장 room its facility level, cost chips, block reason and 업그레이드 button) — plus a **sticky 시설 관리 (M)** button in the bottom-right corner (`.hs-ship-foot`, `position: sticky`) that calls `ctx.inventory.closeAll()` and then `housing.openShipManage()`. Its own inline `.form-msg`, refreshes on `housing:changed` / `inventory:changed` / `inventory:stashChanged` / `input:bindingsChanged`, `dispose()` unsubscribes and empties the host. Adds **no** ui blocker, never exits the pointer lock, installs **no** Escape listener — the inventory window owns all three. **2026-09-09**: while the 제거 confirm / 증축 popup is up, a capture-phase **Tab** listener closes that popup first (the window stays), removed when both are hidden and in `dispose()`. **2026-09-12**: room rows lost their level tag, cost chips and 업그레이드 button (room facilities have no levels), and the 시설 증축 popup no longer lists purposes the ship already has. **2026-09-12 (방 8 개)**: 방 행은 `state.rooms` 길이(8)만큼, 시설 증축 목록은 `ROOM_PURPOSES_ASSIGNABLE` 만 그리고(시뮬레이션실 · 휴식 공간 없음) 발전기 게이트가 막고 있으면 재료 칩 뒤에 `buildFacilityChip` 을 붙인다 (`purposeRequirements`). 조종석은 이 목록에 없다 (시설 관리 전용). |
| `ui/dom.ts` | `el / section / setText / toggleClass / clear / isolateInput`, `renderCost` (Phase 8: delegates to `renderItemCost` from `@/shared` — thumbnail + 보유/필요 chips, dimmed + red when short; sizes `CHIP_SIZE` 32 / `CHIP_SIZE_SMALL` 28), `levelText`, `formatRemaining` (`2시간 5분` / `12분 30초` / `45초` — 거절 사유 문장용). **2026-09-12**: `clockParts(s)` → `{hm, ss}` (`HH:MM` / `:SS`, 올림 — `00:00:00` 은 진짜 끝났을 때만), `clockText(s)`, `renderClock(host, s)` (`.hs-clock-hm` + `.hs-clock-ss` 두 span 을 재사용 — 2026-09-12 부터 `:SS` 도 `HH:MM` 과 **같은 크기**다), `renderClockText(host, text)`. |
| `ui/StationShell.ts` | **가구 화면 공통 틀** (2026-09-12): `buildStationShell(frame, {title, upgrade, onUpgrade, button})` → `{head, title, level, upBtn, body, rail, left, right, invHost}` — 머리줄 = 제목 + `Lv. n` (좌) · 「업그레이드」 (우), 몸통 = **`.hs-rail`(맨 왼쪽 세로 레일, 기본 `hidden`) + `.hs-pane-left` + `.hs-pane-right`**(격자 호스트 `.hs-inv`). 몸통은 flex 라 레일을 쓰지 않는 화면(배양조 · 식탁)에서는 gap 까지 함께 사라진다. 레일을 쓰는 두 화면은 **재배 스테이션 목록**(`GrowStation`)과 **분석기 탭**(`Analyzer`)이고, 같은 자리 · 같은 폭이라 좌측 정렬이 흔들리지 않는다. `paintStationLevel(shell, level \| null, max)` (마지막 레벨이면 `MAX` + 비활성), `mountStationGrids(ctx, host, dropSelector, onTake)` (`createTradeGrids({grids:['stash','bag']})` — 2026-09-12 사용자 결정 「창고 왼쪽 · 가방 오른쪽」이고 기본값과 같다; housing 이 inventory 보다 먼저 등록되므로 열 때 게으르게 — `cell` 은 넘기지 않아 기본 54, 기업 화면과 같다. 스테이션에서는 `housing.css` 가 **블록마다 자기 스크롤**을 주고, 창이 좁아 두 열이 안 들어가면(`@media (max-width: 1599px)`) 세로로 반씩 쌓는다 — 어느 배치에서도 두 격자가 드래그 전에 다 보인다). 식탁은 `upgrade: false`. |
| `ui/UpgradeModal.ts` | **업그레이드 모달** (2026-09-12, `PanelOverlay`): `open(spec, run)` — `spec()` = `UpgradeSpec {name, level, maxLevel, gain, cost, reason}` 를 매 `refresh()` 마다 다시 읽는다(재료가 오갈 수 있다). 비용은 `renderCost` 44 px 칩, 사유가 있거나 최대 레벨이면 확정 버튼 비활성. 확정은 **`UI_HOLD_CONFIRM_S` 홀드만**(`setInterval` + `performance.now()` — rAF 가 멈춘 헤드리스에서도 된다), 놓거나 벗어나면 0, **Enter 는 삼킨다**, Escape 는 `ctx.escape` 토큰 `housing.upgrade`, 바깥 막을 누르면 닫힘. `holdProgress` (스모크). **2026-09-12**: `UpgradeSpec.requirements?` (`furnitureUpgradeRequirements(uid)`) — 재료 칩 뒤에 같은 줄로 `buildFacilityChip`(가로로 긴 이중 테두리, `현재/필요 레벨`, 칩 크기 44). 재배 스테이션 · 분석기 · 배양조가 넘긴다. |
| `ui/StationTip.ts` | **호버 카드** (2026-09-12): `.item-tip` 겉모습을 빌린 비아이템 툴팁 — `show(spec, x, y)` · `update(spec)` · `move(x, y)` · `hide()`, `TipSpec {name, sub, color(--rc), rows[{k, v, tone}], foot}`. 크기는 내용이 바뀔 때만 재고, 움직일 때는 좌표만 적고 rAF 한 번에 `transform`. |
| `ui/StationMenu.ts` | **우클릭 메뉴** (2026-09-12, `PanelOverlay`): `show(x, y, items[{label, danger, run}])` · `close()`. 가장 안쪽 팝업 규약 — Escape 는 자기 capture 에서 삼키고 닫는다, 바깥 pointerdown · 휠이면 닫힘. |
| `ui/ProductDrag.ts` | **다 된 산물을 아이템처럼** (2026-09-12): 호스트(층 · 칸 목록)에 pointerdown · dblclick 을 달고 `productAt(target)` 이 돌려주는 산물만 다룬다. 5 px 넘게 끌면 `buildItemChip` 고스트(`.hs-ghost`, `document.body`), 놓은 자리의 `closest('[data-tg-grid]')` 가 `'bag'` / `'stash'` 면 `collect(key, 그 격자)`, 더블클릭은 `collect(key, 'stash-first')`. 고스트 `transform` · 격자 강조(`.hs-drop-over`)는 rAF 한 번, 놓을 때 판정은 `pointerup` 좌표로 다시 잰다. |
| `parts/Gym.ts` | **헬스장 운동 세션** (A-3a, 2026-09-12). `GymState {info, pose, finished, result, score}` 가 `sys.gymState` 에 산다. `gymEquipmentAt(uid)` (배치 · def · `gymEquipmentOf`), `gymBlock` — 순서대로 `운동 기구가 아닙니다` · `함선에서만 운동할 수 있습니다`(레이드 · hub 페이즈 아님) · `내 함선에서만 운동할 수 있습니다`(공유 함선 · 방문) · `이미 운동 중입니다` · `다른 화면을 먼저 닫으세요`(하우징 모드 · 시설 관리 · 패널 · 아무 블로커), `startGymSession` (화면을 열고 `housing:gymSession {active:true}` — hub 가 같은 호출 스택에서 취소하면 사유를 돌려준다), `cancelGymSession`, `completeGymSession(score)` (한 세션에 한 번 — `ctx.progression.applyGymSession` 을 duck-type 으로 부르고 `gym_finish` · `housing:gymResult`; 메서드가 없거나 null 이면 결과 null), `endGymSession` (`housing:gymSession {active:false, completed: finished}`), `bindGym` (`game:newMission` · `game:abort` · `hub:left` · hub 밖 페이즈 · 이 세션 자세의 `player:furniturePoseEnded`(caller 제외) → 취소), `gymDebug` (스모크 — `screen` · `game` · `result` · `start()` · `finish(score)` · `makeGame(kind)`). 블로커 토큰은 `GYM_BLOCKER = 'housing.gym'` (패널의 `'housing'` 과 따로). |
| `parts/GymGames.ts` | **미니게임 판정 — DOM · ctx 없는 순수 클래스** (A-3a). `GymGame` (`update(dt)` · `press(action)` · `release(action)` · `judgements` · `done` · `score` = 판정 평균 · `counts()` · `drain()` → `judge` / `sound` 이벤트), `PressGame` (커서 `pos` 0…1 왕복, 속도 `GYM_PRESS_SPEED + 회차 × _STEP`, 가운데 거리 ≤ `_PERFECT` 완벽 · ≤ `_ZONE` 성공), `BreathGame` (후 · 후 · 하 × `GYM_BREATH_CYCLES`, 「하」 뒤 한 박 쉼 · 시작 오차 창 안 **그리고** 떼기 오차 ≤ `_HOLD_TOL`, 완벽은 둘 다 1/3 안), `CycleGame` (A · D 번갈아, 틀린 발 = 실패). 박자 게임 공통: **예비 박자 `GYM_LEAD_BEATS`(4)** 동안 입력 무시, **헛누름 = 다음 표식의 실패**(직전 창이 닫힌 뒤 · 다음 창보다 이를 때 — 연타가 최선의 전략이 되지 않게), 창 밖으로 지나간 표식은 자동 실패. `createGymGame(kind)`, `GYM_QUALITY_LABEL_KO`. |
| `ui/gym/GymScreen.ts` | **운동 화면** (A-3a) — 한 오버레이 `.gym` 가 시작 안내 → 게임 → 결과를 갈아 끼운다. **커서 모드 없음**(키보드 게임): 블로커 `housing.gym` · ESC 토큰 `housing.gym` · 키 가이드 owner `housing.gym`(시작 / 들어 올리기 / 후 · 하(꾹) / 왼발 · 오른발 / 결과는 닫기뿐). `window` capture keydown 이 `Keys.JUMP` · `LEFT` · `RIGHT` 를 사용 시점에 읽어 삼키고(`Input` 은 기록 못 한다), keyup 은 **keydown 을 삼킨 키만** 삼킨다. Tab = 닫기(게임 도중이면 취소) · E = 시작 안내 · 결과에서 닫기, 게임 도중엔 삼키기만 · 반복 keydown 무시 · 입력 필드 · 일시정지 메뉴 위에서는 손대지 않는다. `setInterval` 16 ms + `performance.now()` 틱, 키가 오면 그 순간까지 먼저 민 뒤 판정. 판정마다 `housing:gymBeat` + `audio:play gym_perfect/good/miss` (판정 객체의 `gym_breath` · `gym_pedal` 도), 시작 `gym_start`, 마지막 판정 뒤 `RESULT_DELAY_MS`(700) 동안 판정 글자를 보여 주고 결과 화면. 시작 안내: 기구 이름 · 미니게임 · `근력 +n 단련` + 진행도(`다음 단련까지 a / b`, 상한이면 `단련 최대치`) · 규칙 한 줄 · 근육통이면 `근육통 — 이번 운동으로는 근력이 오르지 않습니다 (남은 HH:MM:SS)`(틱마다 갱신) · `Space 시작`. 결과: 점수 % · 완벽 / 좋음 / 실패 수 · `단련 경험치 +n` · `근력 단련 +1!` · 진행도 · `근육통 · 남은 HH:MM:SS`, progression 이 반영하지 못했으면 `단련 결과를 반영하지 못했습니다`. `finishWith(score)` (스모크). |
| `ui/gym/GymViews.ts` | 게임 무대 (`createGymView(game, parent)` → `GymView {paint, judged, input, relabel, dispose}`). 벤치프레스 = 굵은 바 · 성공 구역 · 완벽 구역 · 가운데 눈금 · 왕복 원형 커서(구역 안이면 강조) · 회차 칸. 호흡 · 사이클 = 오른쪽에서 흘러와 판정선(`--judge` 10 %)에 닿는 표식 — 호흡 한 줄(후 = 원 · 하 = 길이가 있는 알약, 쥐는 동안 `--f` 로 차오름), 사이클 두 줄(줄 머리에 A / D 키캡, 누르면 불이 들어온다). 판정선~오른쪽 끝 = 예비 박자 + 1 박. DOM 은 한 번 짓고 틱마다 `left` · `--x` · `--f` · 클래스만. `replayClass` (한 번 도는 애니메이션 재생). |
| `ui/gym/gym.css` | `.gym-*` 전용 (GymScreen 이 import). 루트는 투명한 막(`pointer-events: none`, z 44) — hub 의 운동 자세가 보여야 해서 화면을 덮지 않는다. 카드는 일시정지 메뉴 자리(가로 25vw · 세로 가운데), 게임 패널은 아래 가운데. `.menu .frame` 결의 반투명 판 + 호박색 모서리. 판정 색: 완벽 = `--c-accent` · 좋음 = `--c-text` · 실패 = `--c-danger`; 판정 글자 `.gym-verdict.show` 620 ms. |
| `parts/Deliver.ts` | **수확물을 넣을 격자** (2026-09-12): `deliverItem(sys, item, dest)` → `'bag' \| 'stash' \| null` (`'bag-first'` = `tryAddItemAnywhere` · `'stash-first'` = 창고 → 가방 · `'bag'` / `'stash'` = 그 격자만, 넘치지 않는다), `noRoomReason(dest)`. `Garden.harvestAt` · `Lab.collectAnalysis`(all-or-nothing 롤백은 그대로) · `Culture.harvestCulture` 가 부른다. |
| `housing.css` | Panel styles (`.hs-*`, Phase 9 adds `.hs-shelf` / `.hs-book` / `.hs-books` / `.hs-bookpick` and the shared `.hs-dex*` 도감 rows; 2026-09-11 adds the 분석 화면 `.az-*` block right under the `.gs-*` one, same 결 — `.az-body/left/right/inv/dexhost`, `.az-up*` 강화 줄, `.az-slot` · `.az-cell` · `.az-glyph` · `.az-prog` · `.az-acts`, `.az-dex-row`; 2026-09-11 adds the 배양 화면 `.ct-*` block — same 결 as `.az-*`, the one difference being `.ct-cell` (a rounded tube) + `.ct-fluid` (배지가 차오른다) — and the 식사 화면 `.dt-*` block: `.dt-body/left/right/inv`, `.dt-plate*` (접시 = 드롭 대상), `.dt-list` · `.dt-row` · `.dt-acts`; **2026-09-12 가구 화면 개편**: those four blocks were replaced by one 공통 틀 block — `.hs-station` frame (`--hs-inv-w` = 가방 5칸 + 창고 10칸이 **가로로** 서는 폭) · `.hs-station-head` · `.hs-lv` · `.hs-up-open` · `.hs-station-body` (**flex**: 레일 + 좌 + 우) · `.hs-pane(-left/-right)` · `.hs-inv` (블록마다 자기 스크롤 — `.tg-scroll` 은 `nowrap` + `stretch`, `.inv-grid` 가 `flex: 0 1 auto` + `overflow-y: auto`; `@media (max-width: 1599px)` 에서는 세로 스택 + `flex: 1 1 0` 반씩) · `[data-tg-grid].hs-drop-over`, `.hs-clock(-hm/-ss)`, the 모달 `.hs-modal*` + `.hs-hold*`, 호버 카드 `.hs-tip*`, 우클릭 `.hs-ctx*`, 고스트 `.hs-ghost`, 맨 왼쪽 레일 `.hs-rail` + `.hs-tab`(분석기 탭) + `.hs-rail-item/-name/-dots/-red`(스테이션 목록) — then `.gs-*` (흙구멍 `--gs-pot` 39 px · `--gs-clip` · `--gs-plant-h`, 바 · 줄기 · 잎 transform, 고정 높이 `.gs-time`), `.az-*` (`.az-pages` · 흐름 안의 `.az-acts`), **`.cult-*`** (was `.ct-*`, which collided with the 기업 화면) and `.dt-*` (plate + list only); no transitions / animated shadows on drop targets), reusing `.menu .frame .ui-btn .ui-input .ui-label .form-msg` from `ui/styles/base.css`; same scrolling-page layout as `hub/hub.css`. **`--inv-*` 팔레트는 여기서 다시 선언하지 않는다** — `.trade-grids`(inventory) 가 원본이다. |
| `index.ts` | Re-exports `HousingSystem`, the rules and the state helpers. |

## Rules (single source of truth — `Rules.ts`)
- **Generator gate**: every facility / furniture upgrade needs `generatorLevel ≥ target level`; the generator itself is ungated. Ship-wide tables (`GENERATOR/STORAGE_UPGRADE_COST[level]`) start at level 1. The room tables (`WORKSHOP/RANGE_UPGRADE_COST`) are **retired** (2026-09-12) and read only by the v7 migration's refund (`Rules.legacyRoomLevelCost`).
- **Storage** level → `getStashSize()` = `STASH_COLS × STASH_ROWS_BY_STORAGE_LEVEL[level]`; `housing:stashSizeChanged` once after load and whenever the level changes.
- **Workshop / range (2026-09-12, 사용자 결정 — 방 시설 레벨 제거)**: no levels. `getFacility('workshop' | 'range')` still answers (level 1 with a room, 0 without; `maxLevel` 1, `nextCost` null, `blocked` = "… 용도의 방이 필요합니다" or "시설 레벨은 없습니다 — 시설 안의 가구를 강화하세요") and `upgrade` refuses. What the levels used to buy moved into the furniture: `getPresetCount()` = `PRESETS_BY_RANGE_LEVEL[highest placed 관물대 level]`, `getSkillGainMul(gun_*)` = `1 + RANGE_SKILL_GAIN_PER_LEVEL × highest placed 시뮬레이션 허브 level` — both pieces are `maxLevel` 5 with the old 사격장 costs in `data/furniture_upgrades.csv`, and `furnitureMaxLevel` applies `BENCH_MAX_LEVEL` (3) to **작업대 only**. The 작업실 craft discount is abolished (`getCraftCostMul()` = 1). **Same day, later (사용자 결정 — 시뮬레이션실 · 프리셋 제거)**: 관물대 · 표적 레인 · 시뮬레이션 허브는 `retired` 이고 시뮬레이션실은 지을 수 없다 — `getPresetCount()` 는 늘 0, `getSkillGainMul` 은 서재 책(`getBookBonus`)뿐이다. 훈련장 입장은 hub 의 함선 터미널로 옮겼다.
- **Purposes**: `setRoomPurpose` refuses `lab` without a greenhouse elsewhere and any purpose while purpose-bound furniture of another purpose is still placed (`'any'` pieces stay); `empty` recovers every piece; same purpose = no-op `true`; removing the last greenhouse resets labs to `empty`. New purpose → level 1, `empty` → 0.
- **작업실 (2026-09-07)**: the Phase 8 UI pass locked a free 작업실 to room 1 (`WORKSHOP_ROOM_INDEX`) with both benches already placed. That is **gone**: a new ship is ten 빈 방 with no furniture, and the 작업실 is an ordinary purpose — buildable in **any** room for `ROOM_PURPOSE_BUILD_COST` behind the 발전기 Lv.1 gate, one per ship like the 사격장 (`facilityPurposeOf`), removable through 시설 제거. The 총기 작업대 and the 정비 벤치 are crafted like any other furniture. `WORKSHOP_ROOM_INDEX` still exists in the contract (append-only) but nothing reads it; `sanitize()` keeps only the "one facility room per kind" rule and still moves furniture whose room no longer accepts it into **furniture storage** instead of dropping it.
- **Furniture**: `place` needs a `StoredFurniture` entry (highest level first) and `canPlace`; uid `f-<n>` continues after the highest persisted uid. `recover` keeps the level. `craftFurniture` → level 1 in storage. `upgradeFurniture` uses `def.upgradeCost[level − 1]` behind the generator gate. `getBenchLevel(kind)` = highest placed bench of that kind. `selectFurniture` ignores defs that are not in storage; `null` clears. **`furn_sim_hub` 시뮬레이션 허브** (Phase 7, `FURNITURE_DEFS` in `shared/housing.ts`: 사격장 only, 2×2, 폐금속 8 + 케이블 2 + 회로 2, `interaction 'sim_hub'`) is plain data here — it appears in `getFurnitureFor('range')`, the room menu's 가구 제작 / 가구 창고 lists and is crafted / placed like every other piece; hub/ draws the model and turns E on it into the training-arena entry. Furniture is never an inventory item (it lives only in `furnitureStorage`).
- **Server profile (Phase 7)**: every flush mirrors the state into the `ship` profile document. `net:profileLoaded` → when the server has a `ship` document it is `sanitize`d and **replaces** the state (panels + housing mode closed first, pending local write cancelled, uid counter re-seeded, localStorage rewritten as the cache, not re-uploaded), then `housing:loaded {state}` + `housing:changed {reason:'profile'}` fire so hub/ rebuilds the personal ship, and `housing:stashSizeChanged` follows when the storage level differs; no document → the local state is uploaded.
- **Presets (2026-09-12, 사용자 결정 — 제거)**: 로드아웃 프리셋 기능이 없어졌다. `getPresetCount()` 는 늘 0 이라 `savePreset` / `deletePreset` 은 false, `applyPreset` 은 null, `openPresetMenu()` 는 아무 일도 하지 않는다. 세이브의 `presets` 는 `sanitize` 가 그대로 읽고 쓴다.
- **조종석 (2026-09-12, 사용자 결정)**: `COCKPIT_ROOM_INDEX`(100)는 `rooms[]` 밖의 고정 공간이다 — 용도 `cockpit`, 레벨 1, 증축 · 제거 · 용도 변경 불가(`조종석은 용도를 바꾸거나 제거할 수 없습니다`). 격자는 `roomGridSize` (`COCKPIT_GRID_COLS × ROWS`), 고정 소품 자리(`COCKPIT_BLOCKED_RECTS`)에는 놓을 수 없고 `room: 'any'` 가구만 받는다. 공용 시설 가구(전술 임플란트 시술대 · 기업 네트워크 컴퓨터)는 모든 함선이 늘 하나씩 가진다 — `ShipState.ensureCockpitFurniture` 가 새 함선 · 모든 로드에서 없으면 조종석(기본 자리 → 자동 배치 → 가구 창고)에 채운다. 제작할 수 없고(`이미 보유 중입니다`), 회수 · 이동은 된다.
- **방 8 개 · 사라진 용도 (v8, 2026-09-12, 사용자 결정 「전부 제거 + 환불」)**: 옛 세이브의 방 9 · 10 과 시뮬레이션실 · 휴식 공간 방은 로드할 때 빈 방/삭제 — 가구는 가구 창고, 증축 재료와 책장의 책은 함선 창고. 빈 방이 될 수 있는 용도는 `ROOM_PURPOSES_ASSIGNABLE` 뿐이다.
- **시설 레벨 요구 (2026-09-12)**: `furnitureUpgradeRequirements(uid)` · `purposeRequirements(purpose)` 는 채워지지 않은 발전기 게이트만 `{facility, have, need}` 로 돌려준다 — 사유 문장(`furnitureUpgradeBlock` · `purposeBlock`)은 그대로이고, ui 는 이것을 재료 칩 옆의 칩으로 그린다.
- **Housing mode**: `enterHousingMode(room)` only in phase `hub` on the personal ship (`ctx.hub.ship === 'personal'`); and only while `ctx.hub.currentRoom === room` (corridor / cockpit = null → `방 n 안에서만 꾸밀 수 있습니다`). Since the Phase 8 UI pass nothing in the game calls it — 시설 관리 (`openShipManage`) is the only entry point — but the gate is kept for API users. Adds **no** ui blocker (hub intercepts input); closes the panels first; `exitHousingMode` resets selection + yaw. The panels open with `exitHousingMode()` so mode and menu never overlap.
- Materials: `countDefAll / consumeDefAll` are guarded with `typeof` (0 / refused when missing); the whole cost is verified before the first `consumeDefAll` call.
- **Stacking (Phase 8)**: `FurnitureDef.stackLimit > 1` (only `furn_grow_rack`, limit 4) lets copies of the same def share one footprint, each on its own `PlacedFurniture.layer` (0 = deck; hub/ lifts layer n by `GROW_RACK_LAYER_HEIGHT`). A stack is homogeneous — same defId, same `x`/`y`, same `yaw`; anything else overlapping is still refused. `place` takes the lowest free layer, `move` requires the piece to be on top and re-seats it on the target stack's lowest free layer, `recover` refuses anything but the top layer (`위층 … 을(를) 먼저 회수하세요`, surfaced by `recoverBlock(uid)` and the 방 메뉴's 회수 button). `setRoomPurpose('empty')` recovers top-down.
- **~~온실 재배 (Phase 8)~~ → 온실 재배 스테이션 (2026-09-11, 사용자 결정)**: 옛 재배층(`furn_grow_rack`, 스택 4층 × 4칸)은
  **은퇴**했고 `furn_grow_station`(maxLevel 3) 하나가 그 자리를 받는다.
  - **층은 레벨이 연다** — Lv.1 중앙(`GrowTier` 0) · Lv.2 아래(1) · Lv.3 위(2). **층 id 는 업그레이드해도 바뀌지 않아**
    자라던 작물이 다른 층으로 옮겨지지 않는다. 화면이 그리는 순서는 `GROW_TIER_DRAW_ORDER`(위 → 중앙 → 아래).
    `getGrowSlots(uid)` 는 **언제나 `3 × GROW_SLOTS_PER_TIER` = 9칸**을 그 순서로 돌려주고 잠긴 층은
    `locked: true` + `unlockLevel`(아래 2 · 위 3)로 표시한다 — 화면이 「Lv.2 강화로 열립니다」를 그릴 수 있어야 하기 때문이다.
    `unlockLevel` 은 코드에 적힌 숫자가 아니라 계약 `growTiersForLevel` 에서 **유도한다**(`Rules.growTierUnlockLevel`).
  - **칸은 두 단계다** — ① `fillSoil(uid, tier, slot, soilDefId)` 로 흙을 붓고(`consumeDefAll` 1개, `soilUsesLeft` 는
    `ItemDef.soil.uses`) ② `plantSeedAt(...)` 로 그 위에 심는다. 흙 없이는 심을 수 없다(`흙을 먼저 채우세요`).
    `clearSoil` 은 흙을 **돌려주지 않는다**(남은 횟수가 있어도 버린다, 사용자 결정) 그리고 심겨 있으면 거부한다.
  - **성장 시간은 심는 순간 확정된다** — `Rules.growDurationMs` =
    `growHours × 3600e3 × (1 − GROW_SKILL_SPEEDUP × 원예/SKILL_LEVEL_MAX) × (궁합 ? 1 − SOIL_MATCH_SPEEDUP : 1 + SOIL_MISMATCH_PENALTY)`.
    궁합은 씨앗의 `soilTag` 와 부어 둔 토양의 `soil.tag` 가 **같은가** 하나뿐이다(토양 없이 심는 경우가 없으므로 기준선이
    「어긋남」이다). 이후 숙련이 오르거나 흙이 바뀌어도 `readyAt` 은 움직이지 않고, 게임을 꺼 둬도 계속 자란다.
  - **토양은 수확마다 1회 닳는다** — `harvestAt` 이 성공하면 `soilUsesLeft − 1`; 0 이면 칸이 **완전히 비워지고**(흙 없음),
    0 이 아니면 「심을 준비가 된 흙」으로 돌아간다. 수확물은 예전처럼 `yieldQty × derived.gatherYieldMul`(≥ 1) 을
    `tryAddItemAnywhere` 로 가방 → 창고에 넣고, 실패하면 `가방과 창고에 자리가 없습니다` 로 거부하며 상태를 유지한다.
    원예 숙련은 그대로 `gather:collected {nodeId: 'grow:<uid>:<tier>:<slot>'}` 로 오른다.
  - `harvestAllStation(uid)` 는 **열린 층만** 훑는다. 스테이션을 회수하면 그 uid 의 `grows` 가 전부 사라진다
    (`dropGrowsOf`, 옛 `dropPlotsOf` 와 같은 자리). 온실 방에 스테이션을 **여러 대** 놓는 것은 기존 가구 규칙 그대로다.
  - 모든 거부 사유는 메서드의 반환값(한국어 한 줄)이다.
- **연구실 분석기 (A-12, 2026-09-11)**: `furn_analyzer`(maxLevel 3, `interaction: 'analyzer'`)는 재배 스테이션과
  **같은 모양의 스테이션**이다 — 레벨이 자리를 연다.
  - **칸은 레벨이 연다** — `analyzerSlotsForLevel(level)` = `ANALYZER_SLOTS_PER_LEVEL × level` (지금 1칸씩 늘어 Lv.3 = 3칸).
    `getAnalyses(uid)` 는 **언제나 `ANALYZER_MAX_SLOTS` 개**를 칸 번호 순으로 돌려주고 잠긴 칸은 `locked: true` +
    `unlockLevel`(계약 `analyzerSlotUnlockLevel` 에서 **유도**)로 표시한다 — 화면이 「Lv.N 강화로 열립니다」를 그릴 수
    있어야 하기 때문이다. **칸 번호는 강화해도 밀리지 않는다** (돌아가던 해석이 다른 칸으로 옮겨 가면 안 된다).
  - **시간은 넣는 순간 확정된다** — `Rules.analyzeDurationMs` =
    `analyzeHours × 3600e3 × (1 − ANALYZE_DEX_SPEEDUP × 도감진척) × (아는 표본이면 1 − ANALYZE_KNOWN_SPEEDUP)`.
    그 뒤로 도감이 더 차도 **돌아가던 해석은 빨라지지 않는다** (온실의 `readyAt` 과 같은 규약). 시계는
    `ctx.net.serverNow() ?? Date.now()` 이므로 함선을 떠나 있어도 흐른다.
  - **도감 진척은 아이템 표가 분모다** — `getSampleDexRatio()` = 「지금 아이템 표가 아는 표본 중 도감에 든 것」의 비율.
    도감에 남아 있는 옛 id 는 세지 않는다 (그러지 않으면 비율이 1 을 넘는다).
  - **넣기 / 중단 / 회수** — `startAnalysis` 는 `consumeDefAll`(가방 → 창고)로 1개를 빼고, `cancelAnalysis` 는
    **표본을 돌려주지 않는다**(부은 흙과 같다, 계약에 적힌 그대로). `collectAnalysis` 는 산출물을
    `tryAddItemAnywhere` 로 넣고, 처음 보는 표본이면 `SampleDef.firstDefId` 보너스를 얹은 뒤 도감에 적고
    `housing:sampleDexAdded` 를 낸다 — **all-or-nothing**: 보너스가 들어갈 자리가 없으면 이미 넣은 산출물을
    `takeItem` 으로 되돌리고 칸을 그대로 둔다(`stashBooksOf` 와 같은 롤백 규약).
  - 분석기를 회수하면 그 uid 의 `analyses` 가 전부 사라진다 (`dropAnalysesOf`, `dropGrowsOf` 옆).
    상태가 바뀔 때마다 `housing:analysisChanged {uid, ready}` 를 낸다 — **강화도 포함**이다(계약의 그 이벤트 설명 그대로).
  - 모든 거부 사유는 메서드의 반환값(한국어 한 줄)이다.
- **온실 배양조 (A-14, 2026-09-11)**: `furn_culture_tank`(maxLevel 3, `interaction: 'culture_tank'`, 온실 방)는
  분석기와 **같은 모양의 스테이션**이고 칸의 몸짓만 온실에서 왔다.
  - **칸은 레벨이 연다** — `cultureSlotsForLevel(level)` = `CULTURE_SLOTS_PER_LEVEL × level`. `getCultureSlots(uid)` 는
    **언제나 `CULTURE_MAX_SLOTS` 개**를 칸 번호 순으로 돌려주고 잠긴 칸은 `locked: true` + `unlockLevel`(계약
    `cultureSlotUnlockLevel` 에서 **유도**)이다. **칸 번호는 강화해도 밀리지 않는다.**
  - **칸은 두 단계다** — ① `fillMedium(uid, slot, 배지)` 로 영양 배지를 붓고(`consumeDefAll` 1개, `mediumUsesLeft` 는
    `ItemDef.medium.uses`) ② `insertStrain(...)` 으로 세포주를 넣는다. 배지 없이는 넣을 수 없다(`영양 배지를 먼저
    채우세요`). `clearMedium` 은 배지를 **돌려주지 않고**(부은 흙과 같다) 배양 중이면 거부한다.
  - **시간은 넣는 순간 확정된다** — `Rules.cultureDurationMs` = `cultureHours × 배지 등급(`MediumDef.speedMul`) ×
    원예 단축`. 토양의 태그 매칭에 해당하는 축은 **없다**: 배지는 등급 하나다 (사용자 결정 — 축을 하나 더 만들 이유가
    없다). 그 뒤로 배지를 갈거나 숙련이 올라도 `readyAt` 은 움직이지 않고, 시계는 `ctx.net.serverNow() ?? Date.now()` 다.
  - **배지는 수확마다 1회 닳는다** — 0 이면 칸이 **완전히 비워지고**, 아니면 「넣을 준비가 된 배지」로 돌아간다.
    수확물은 `tryAddItemAnywhere`(가방 → 창고)이고 자리가 없으면 상태를 유지한 채 거부한다. 산출량에 원예
    `gatherYieldMul` 을 **곱하지 않는다** — 배양조는 채집이 아니다(`StrainDef.outputQty` 그대로).
  - 배양조를 회수하면 그 uid 의 `cultures` 가 전부 사라진다 (`dropCulturesOf`, `dropAnalysesOf` 옆).
    상태가 바뀔 때마다 `housing:cultureChanged {uid, ready}` 를 낸다 — **강화도 포함**이다.
- **주방 · 식탁 (A-3c, 2026-09-11, 사용자 결정)**: `kitchen` 이 `ROOM_PURPOSES_ACTIVE` 에 들어왔고 **온실 선행**이
  붙었다 — 작물이 유일한 요리 재료이기 때문이다. 연구실이 쓰던 규칙을 그대로 재사용한다: `Rules.NEEDS_GREENHOUSE`
  한 줄이 `purposeChangeReason` · `ShipState.sanitize` 의 낙오 처리 · 「마지막 온실이 사라지면 딸린 방도 비운다」
  (`Rooms.setRoomPurpose`) 셋의 원본이다.
  - **먹는 행위는 식탁에서 일어난다**. 개인 함선에서는 `furn_dining_table` 가구가(`uid`), 공유 함선에서는 hub 가
    심어 둔 **고정 식탁**이(**`uid` = null**) `openDiningTable` 을 부른다. 레이드 중에는 열리지 않는다.
  - **규칙의 주인은 progression 이다** — `eatMeal` 은 `ProgressionRef.useMeal(defId)` 에 **먼저 묻고 null 일 때만**
    `consumeDefAll` 로 1개를 뺀다 (A-13 의 `StashOps.usePrepItem` 규약: 거꾸로 하면 거절당했을 때 되돌릴 곳이 없다).
    이미 차려 둔 식사는 **교체**된다 — 거절 사유가 아니다.
  - **분대에 차리기**는 공유 함선에서만 보이고 요리 **1개**만 소모한다: 내 몫은 `serveMeal` 로 직접 챙기고
    `housing:mealServed {defId, by}` 를 낸다 — `by` 는 PeerId 가 아니라 **표시 이름**(`ctx.net.playerName`, 없으면
    `나`)이다: 토스트가 그대로 찍는다. **실제 전파와 권위 검사는 net 의 몫**이다 — housing 은 이벤트만 낸다
    (「남에게 영향 주는 메시지는 권위에서만 받는다」). 그리고 **housing 은 그 이벤트를 구독하지 않는다** —
    net 의 수신 경로가 같은 이벤트를 다시 내므로, 여기서 듣고 소모하면 차린 본인의 요리가 두 번 빠진다.
- **B-13 — 배치된 가구 강화 · 제작 잠금 (2026-09-11, 사용자 결정)**: `furnitureUpgradeBlock(uid)` 은 예전부터
  `HousingSystem` 에 있던 것을 계약에 올린 것뿐이고, `furnitureUpgradeCost(uid)` 는 `Rules.nextFurnitureCost` 에
  위임한다(최대 레벨 · 없는 uid → null). `furnitureCraftBlock(defId)` 의 순서는 다른 block 함수와 같다 —
  **구조(알 수 없는 · 은퇴 · 제작 불가) → 튜토리얼 → 보유 → 재료**. 「보유」가 B-13 이다: `isUtilityFurniture(def)`
  (= `interaction !== 'none'`, E 로 뭔가를 하는 가구)를 **배치 + 가구 창고 합산**으로 하나라도 갖고 있으면
  `'이미 보유 중입니다'` — 벤치 레벨은 가장 높은 하나만 세므로 두 번째를 만들 이유가 없다. 장식 가구는 제한 없다.
- **은퇴 가구 (`FurnitureDef.retired`, 2026-09-11)**: 목록 · 제작 · 배치 어디에도 나오지 않는다 —
  `getAllFurnitureDefs` / `getFurnitureFor` 는 `model.ACTIVE_FURNITURE_DEFS` 를 보고, `canCraftFurniture` · `place` 는
  맨 앞에서 거절한다. **`getFurnitureDef(id)` 만은 계속 돌려준다** — 옛 세이브의 그 가구를 재료로 환불하려면 값을
  알아야 하기 때문이다. `ShipState.sanitize` 가 배치 · 보관된 은퇴 가구를 전부 걷어내고 `Rules.furnitureRefundCost`
  (제작비 + 그 레벨까지의 강화비)를 `SanitizeOutcome.refund` 에 모으며, `HousingSystem.flushRetiredRefund()` 가
  **`ctx.inventory` 가 생긴 첫 프레임**에 함선 창고로 넣는다(housing 은 inventory 보다 **먼저** 등록되므로 로드
  시점에는 창고가 없다). 창고가 모자라면 들어가는 만큼만 넣고 남은 것은 버리되 **한국어 경고 토스트 + `console.warn`**
  을 남긴다 — 조용히 사라지지 않는다.
- **함선 관리 (Phase 8)**: `openShipManage(room?)` = housing mode **without** the room-presence gate (only phase `hub` + personal ship, `shipManageBlock()`); the room defaults to `ctx.hub.currentRoom`, else the first room with a purpose, else room 1. `setManageRoom` retargets it, `closeShipManage` (and any `exitHousingMode`) leaves both and emits `housing:shipManageChanged {active:false, room:null}`. hub/ drives the camera off that event; `enterHousingMode` keeps its old room-local gate for API users.
- **서재 책장 (Phase 9)**: `ShipState.books` holds one `PlacedBook {uid, slot, defId}` per filled shelf slot (`BOOKS_PER_SHELF` = 6 per 책장, `furn_bookshelf`, 서재 room, 2×1, 폐금속 6 + 합금판 1). `placeBook(uid, slot, defId)` works only in phase `hub`, on a real 책장, into a free slot, with a book the player owns — it consumes 1 through `consumeDefAll` (**bag first, then stash**) and adds the id to the 도감 (`bookDex`, append-only: a book that was ever shelved stays listed even after it leaves). `takeBook(uid, slot)` re-creates the item and places it with `tryAddItemAnywhere` (bag → stash, refused with `공간 없음 …`). Both return `null` on success and a 한국어 reason otherwise, and emit `housing:booksChanged {uid, count}` + `housing:changed`. **Bonus**: `getBookBonus(skill)` = `min(BOOK_GAIN_MAX 2.0, 1 + BOOK_XP_PER_BOOK 0.05 × Σ BOOK_RARITY_MUL[rarity])` over **every** shelved book of that skill on the ship (any shelf, any room; weights common 1 / uncommon 1.5 / rare 2.5 / epic 4 / legendary 6 — so one epic book = ×1.20, and the cap needs Σ 20). It is multiplied into `getSkillGainMul` next to the 사격장 factor, so progression/ keeps reading exactly one number. `getOwnedBooks()` lists owned books in `SKILL_IDS` order; `getBookDex()` is the 도감 list.
- **Recovering a 책장**: `recover(uid)` first hands its books to the **stash** (`stashBooksOf`, all-or-nothing — a partial move is rolled back with `takeItem`); when they do not fit, nothing moves and the refusal is `책을 먼저 빼세요` (`BOOKS_BLOCK_REASON`). `recoverBlock(uid)` and `purposeBlock(room, 'empty')` (which recovers everything) report the same reason ahead of the click, using a cheap free-stash-cell estimate (`freeStashCells`; unknown → let `recover` try for real).
- **서재 매체 (A-3e, 2026-09-12)**: 디스크 전시대(`disc_stand`, 6칸) · 레코드랙(`record_rack`, 4칸)은 책장과 같은 규칙이고 `ShipState.media` 에 산다 — 매체가 보관함과 맞아야 꽂히고(`disc_*` 는 전시대에만), 도감은 `mediaDex`. 배율은 매체마다 따로 잘라 더한다(`Rules.shelfGainFor`, 변경 이력 참고). 보조 가구(흔들의자 → 책 · TV → 디스크 · 축음기/주크박스/턴테이블 → 레코드)는 **배치만으로** 켜지고 여러 대여도 한 번이다. TV · 레코드 플레이어의 켜짐(`toggled`)은 겉모습일 뿐 배율에 관여하지 않는다. 회수 · 빈 방 · 시설 제거는 디스크 · 레코드도 책처럼 창고로(all-or-nothing) 옮긴다.
- **자동 배치 (2026-09-10)**: `HousingRef.findFreeSpot(room, defId)` = `Rules.autoPlaceSpot`. 시설 관리의 가구 창고
  `배치` 버튼만 이 질의를 쓴다 — 손으로 놓는 경로(하우징 모드 고스트 · `move`)와 `canPlaceAt` 자체는 **하나도
  바뀌지 않았다.** 규칙 세 줄:
  - **순서**: 화면 **좌측 상단부터 가로줄을 먼저** 채우고 다음 줄로 내려간다. 화면 ↔ 격자 대응의 근거는
    `hub/interiors/RoomLayout`(격자 `x` = 월드 +X, `y` = 월드 +Z)과 `hub/HousingMode`(시설 관리 카메라는 모든 방을
    +X 쪽에서 −X 로 내려다본다 ⇒ **화면 오른쪽 = −Z, 화면 아래 = +X**)이다. 그래서 훑는 순서는
    **`x` 오름차순(바깥) × `y` 내림차순(안쪽)**이고, 앵커가 격자 최소 모서리라 `y` 는 `ROOM_GRID_ROWS − fp.rows`
    에서 시작한다.
  - **회전**: `AUTO_PLACE_YAWS = [1, 0]`. 모델 정면은 로컬 −Z 이고 월드 회전이 `−yaw·π/2` 라
    `R_y(−yaw·π/2)·(0,0,−1) = (−sinθ, −cosθ)` → **yaw 1 = +X = 화면 아래**. 예전 `[0, 1]` 은 yaw 0 = −Z =
    **화면 오른쪽 벽**이라, 총기 작업대가 벽을 보고 서서 쓰려면 벽 틈으로 끼어 들어가야 했다.
  - **출입구 앞은 비운다**: 방문은 ±X 벽 한가운데(폭 1.6 m)에 있고 어느 벽인지는 방 번호가 정한다 —
    앞 절반(0…4, 좌현)은 +X 벽, 뒤 절반(5…9, 우현)은 −X 벽. 순서만 바꾸면 우현 방에서 첫 자리가 문 앞이 되어
    4×2 작업대가 문틈의 절반(0.8 m)을 막고 `PLAYER_RADIUS × 2` = 0.9 m 인 플레이어가 **드나들지 못한다.**
    그래서 자동 배치만 `DOOR_CLEAR_DEPTH`(2칸 = 1.0 m) × `DOOR_CLEAR_SPAN`(4칸 = 2.0 m) 상자를 비켜 간다.
    좌현 방에서는 그 상자가 화면 **아래쪽 끝**이라 「좌측 상단부터」가 그대로 성립한다.
    이 여유를 `canPlaceAt` 에 넣지 **않은** 이유는 세이브다 — `ShipState.sanitize` 가 저장된 배치를 전부
    `canPlaceAt` 으로 다시 검사하므로, 이미 문 앞에 가구를 둔 함선이 로드할 때 그 가구를 가구 창고로 빼앗겼을 것이다.
  두 칸 수치는 밸런스가 아니라 **치수**라 csv 가 아니라 `Rules.ts` 에 있다 (`data/README.md` 의 "csv 로 옮기지
  않은 것" — `world/structures/model.ts` 가 벽 두께 · 문 폭을 TS 에 두는 것과 같은 이유).
  실패 처리는 그대로 `null` → 호출부의 `자리 없음` 이다. ~~**한계**: 출입구 여유 때문에 손으로는 아직 놓을 수 있는
  방이 자동 배치에서는 `자리 없음` 이 될 수 있다 (그 경우 하우징 모드에서 직접 놓으면 된다).~~
  - **2차 패스 (2026-09-11, C-27)**: 여유 상자를 통째로 피해서는 자리가 없으면 같은 순서로 다시 훑되 상자에 걸치는
    자리도 받는다 — 단 놓은 뒤에도 **`doorPassageOpen(state, room, extra)`**, 즉 문 폭 4칸 중 **인접 2칸**(1.0 m ≥
    플레이어 지름 0.9 m)이 문 쪽 벽에서 깊이 2칸까지 전부 비어 있어야 한다. 그래서 거의 찬 방에서도 통로 한 줄은
    남기고 `자리 없음` 이 줄어든다. 이미 손으로 통로를 막아 둔 방이면 2차 패스도 아무것도 주지 않는다.
    `canPlaceAt` 은 여전히 문을 모른다.
- **온실 순수 규칙 (2026-09-11)**: `growTierUnlockLevel(tier)` (계약 `growTiersForLevel` 에서 유도) · `growTierOpen(level, tier)` ·
  `soilMatches(soilTag, seedTag)` · `growDurationMs(growHours, matched, gardening)` · `growProgress(now, plantedAt, readyAt)` ·
  `growRemainingS(now, readyAt)`, 그리고 은퇴 가구 환불용 `furnitureRefundCost(def, level)` · `mergeCost(into, add, times?)`.
  수치는 하나도 여기 적지 않는다 — 전부 `@/shared`(= `data/*.csv`) 에서 온다.

- **Removed panels (Phase 8 UI pass)**: `openRoomMenu(room)` and `openFacilityMenu()` are still on `HousingRef` but now **redirect to `openShipManage(room?)`** — the standalone 방 메뉴 / 시설 메뉴 (and the 시설 메뉴's 프리셋 button) are gone. Loadout presets are reached only through the **관물대** (`furn_range_console`, renamed from 사격장 콘솔, model `locker`) placed in a 사격장 room.

## Verification
`node scripts/smoke-housing.mjs` (**151 checks**, 0 console errors, 2026-09-06 — Phase 7 added the 15th def `furn_sim_hub` in the 사격장 catalogue only, its craft (회로 −2) / `canPlace` (workshop refused, range allowed) / place `f-5` / room-menu rows, and the server `ship` document through a fake `ctx.net.profile`: `profile.set('ship')` on save, no document → upload, `net:profileLoaded` replace → room 8 kitchen / storage 2 → 36 rows / crate `f-90` / uid `f-91` next / `housing:loaded` + `housing:changed {profile}` / cache updated without echo; the relay socket is parked so a relay on 8787 cannot interfere). Earlier coverage: fresh state + first-run bench, `hub:enter`, lab refused / workshop assigned / events, `canPlace` bounds · rotation · purpose · overlap, place → `f-1`, move (+ ignoreUid), recover (level kept) → re-place `f-2`, purpose change refused while a bench is placed, 40 폐금속 via `tryAddItem`, generator 0→1→2 (케이블), storage 1 → rows 30 mirrored by `inventory.getStashSize()`, workshop gated → unblocked → level 2 → cost ×0.9, 한국어 block reasons, furniture craft (stacking, refused when short), bench Lv2 + Lv3 gated, range room → 3 presets, skill ×1.1, save / refuse index 3 / apply (`{equipped: 4, missing: []}`) / delete, target lane, lounge keeps an `'any'` locker and `empty` recovers it, gym + greenhouse + lab, housing mode + selection + rotation, three panels (DOM contents, 7 badges, red materials, blocked click → message, Esc + blocker, 닫기, single-blocker switching, `closeMenus`), reload persistence (rooms / levels / furniture / storage / preset / stash 30 / uid `f-5`), corrupt save sanitised (lab → empty, generator clamped to 5, bad room / purpose / overlap / duplicate uid handled).
Registered in `scripts/verify.mjs` (`smoke-housing`, folders housing / hub / inventory / progression).
**Phase 8 changes the smoke's expectations**: a fresh state now holds **two** furniture-storage entries (총기 작업대 + 정비 벤치), only **6** purposes carry the 다음 업데이트 badge (온실 is active), cost lines are `.item-chip` elements instead of `.mat` spans, and there are new cases to add — 재배층 stacking (4 layers on one footprint, 5th refused, only the top recovers), 온실 plots (plant → progress → harvest → `gather:collected`), 함선 관리 (`openShipManage` outside the room, `setManageRoom`, `housing:shipManageChanged`), `createShipView` (renders, adds no blocker, disposes clean) and the v1 → v2 정비 벤치 grant (**2026-09-12 부터 그 지급은 없다** — 정비 벤치 은퇴).

## Phase 8 additions (2026-09-06)
- **재배층 stacking** — `Rules.ts` stack helpers + `place / move / recover` layer handling (see the Rules section above).
- **온실 재배** — `getPlots / plantSeed / harvestPlot / harvestAll / getOwnedSeeds / openGrowMenu` + `ui/GrowMenu.ts`.
- **함선 관리** — `shipManageMode / openShipManage / setManageRoom / closeShipManage` (`housing:shipManageChanged`).
- **함선 tab** — `createShipView(host)` → `ui/ShipView.ts` on top of the extracted `ui/FacilityRows.ts`.
- **Cost chips** — every cost line (방 메뉴 level / 가구 업그레이드 / 가구 제작, 시설 rows, 재배 seeds) renders through
  `renderItemCost` from `@/shared`; the text-only `renderCost` is gone (the name survives as a thin wrapper).
- **정비벤치 지급** — state version 2: `freshState()` and the v1 → v2 migration each hand out exactly one
  `furn_repair_bench` Lv.1, never twice.
- **온실 용도** is active (`ROOM_PURPOSES_ACTIVE`), so the 방 메뉴 no longer badges it 다음 업데이트 (data-driven, no code change).

## Phase 9 additions (2026-09-06)
- **서재 책장** — state v3 (`books` / `bookDex`), `Rules.bookWeightOf / bookGainMulFor`, the seven `HousingRef` book
  methods, `ui/BookshelfMenu.ts` + the shared `ui/BookDex.ts` 도감 (also rendered under the 방 목록 of the 함선 tab).
  Items owns the 14 book defs (`ItemDef.book.skill`), housing owns the shelves, the bonus and the 도감.
- **`getSkillGainMul` = 사격장 × 서재** — the only number progression/ reads (it was not changed). *(2026-09-12: the first factor is the placed 시뮬레이션 허브's level now, not the room.)*
- **Offline profile saves** — `ShipStore.upload()` no longer checks `profile.available`; `ProfileSync` queues the
  document and the newest stamp wins on the next connection (Phase 9 contract).

## Known follow-ups
- `housing:loaded` fires inside `init()`, before later systems subscribe — consumers should read `ctx.housing.state` directly in their own init (the event only reaches systems registered earlier). The Phase 7 re-emit on `net:profileLoaded` does reach everyone; hub/ must rebuild the personal ship on it (also while the player stands inside — furniture may vanish under them).
- `ROOM_PURPOSES_ACTIVE` gates nothing beyond the badge: the seven inactive purposes accept `'any'` furniture only (no purpose-bound defs exist for them yet).
- Facility levels of workshop / range are read from the *first* room of that purpose; a second workshop room is decorative.
- The preset name field saves on `change` (blur / Enter); Esc **blurs the field** without saving the edit (2026-09-08: it no longer closes the panel — E does).
- ~~Hydroponics / kitchen / lab mechanics~~ (2026-09-11: 온실 · 연구실 · 주방이 모두 붙었다 — 재배 스테이션 ·
  분석기 · 배양조 · 식탁) and a buy-only path (`craft: null`) are not wired — `craftFurniture` refuses non-craftable defs. Furniture is by design not an inventory item (`ItemDef.furnitureId` stays unused).
- The server `ship` document is uploaded whole on every save (no delta); two clients on the same token overwrite each other last-writer-wins.
- **Phase 8**: `SHIP_STATE_VERSION` in `src/shared/constants.ts` was still `1` back then, so housing/ wrote its own
  `SHIP_STATE_VERSION_CURRENT`; Phase 9 bumped the contract to `3` and the 온실 개편 to **`4`**, and the two agree again
  (the local `Math.max` stays as the guard). ~~`GrowPlot` has no per-plot fertiliser / soil quality~~ (2026-09-11: 토양이
  생겼다) and a 칸 keeps growing even if the room later loses its
  온실 purpose (only recovering the station drops it). Growth uses the relay clock when connected and the local clock
  otherwise, so a client with a wrong system clock can plant "in the future" — the progress bar clamps, nothing breaks.
  `getOwnedSeeds` walks every item def on each refresh (fine at panel scale). The embedded 함선 view uses a `<select>`
  per room rather than the 방 메뉴's 10-button purpose grid (the grid does not fit a tab column); the 하우징 모드 /
  가구 제작 lists stay in the 방 메뉴 and the M screen.
- **Phase 9**: the 도감 is append-only and never forgets, so there is no way to "unsee" a book. A shelved book leaves the
  inventory entirely (it is neither weight nor stash space until it is taken back), and books on a shelf are not part of
  any loadout preset. `getOwnedBooks` / the 도감 walk every item def per refresh (panel scale, fine). `booksBlock` is a
  free-cell estimate — a stash that is fragmented but not full can still refuse a 회수 at the real `tryAddToStash` call
  (the recover then rolls back and toasts). `placeBook` requires phase `hub`; `takeBook` does not (nothing calls it
  elsewhere). Shelves are per-ship state, so the books never appear in a raid.
- **온실 개편 (2026-09-11)**: ① 은퇴 가구 환불은 `ctx.inventory` 가 생기기를 기다리므로(첫 `update` 프레임),
  그 전에 브라우저를 닫으면 다음 로드 때 다시 계산된다 — 저장된 상태에는 이미 그 가구가 없으므로 **두 번 환불되지는
  않는다**(같은 이유로, 창고가 꽉 찬 채로 계속 플레이하면 그 판의 잔여분은 버려진다). ② 환불액은 **지금의 표**
  (`data/furniture.csv` + `furniture_upgrades.csv`)로 계산한다 — 시설 환불과 같은 성질이다. ③ `sanitize` 는
  `soil_*` **모양**만 보고, 진짜 토양인지는 `parts/Garden.grows()` 가 `ctx.loot` 로 한 번 걸러 낸다(서재와 같다).
  ④ 드래그해 온 스택이 창고에 있어도 실제 소모는 `consumeDefAll`(가방 → 창고) 이라 **가방에 같은 토양이 있으면
  그쪽이 먼저 빠진다** — 책 꽂기와 같은 규약이다. ⑤ 스테이션을 회수하면 자라던 작물도 함께 사라진다(경고 없음).
  ⑥ `ui/GrowStation` 의 격자 뷰는 `--inv-*` 팔레트를 `housing.css` 에서 다시 선언한다(패널이 `.inv-root` 밖이라
  `inventory/ui/CrewLoadoutView` 와 같은 처지다) — **값의 원본은 `inventory/inventory.css` 다.**
- **연구실 분석기 (2026-09-11)**: ① **「이미 보유 중」은 규칙이 아니라 화면의 질의다** — `furnitureCraftBlock` 만
  그것을 말하고 `canCraftFurniture` / `craftFurniture` 는 예전 그대로라, API 로 직접 부르면 실용 가구를 두 번
  만들 수 있다 (설계안 §3.1 의 범위 그대로다: 잠그는 곳은 시설 관리 카드다). 규칙으로 올릴 때는 튜토리얼의
  총기 작업대 경로와 v1 → v2 정비 벤치 지급을 함께 본다. ② 분석기를 회수하면 해석 중이던 표본이 **경고 없이**
  사라진다 (재배 스테이션과 같다). ③ 해석 취소도 표본을 돌려주지 않는다 — 계약에 적힌 사용자 결정이다.
  ④ 해석은 `ctx.net.serverNow()` 를 쓰므로 시스템 시계가 틀린 클라이언트는 「미래에」 넣을 수 있다 — 진행바가
  클램프될 뿐 깨지지 않는다(온실과 같다). ⑤ 분석 화면에는 전용 toggled 이벤트가 **없다**(계약에 그런 이벤트가
  없다) — 열렸는지 알아야 하는 폴더가 생기면 계약에 추가해야 한다. ⑥ `getOwnedSamples` · 도감은 매 refresh 마다
  아이템 def 를 전부 훑는다 (패널 규모라 괜찮다, 서재 · 온실과 같다).

## Phase 9 UI pass (2026-09-07)

- `Rules.facilityRefundCost(id, level)` — the cumulative upgrade cost of a facility, merged per material. Room
  facilities start at level 1 (granted with the purpose) so only levels 2… are summed; ship-wide ones start at 0.
- `HousingSystem.facilityRefund(index)` / `removeRoomFacility(index)` implement 시설 제거: the room is emptied through
  the existing `setRoomPurpose(index, 'empty')` path (every piece goes to furniture storage) and the refund is dropped
  into the 함선 창고 with `inventory.tryAddToStash`, split at each item's `stackMax`. The stash space is **pre-checked**
  with the same free-cell estimate `booksBlock` uses, so a full stash refuses the removal instead of eating materials.
- `ui/ShipView.ts` rewritten: no 도감 (books are read on a 책장 in the 서재), no 용도 드롭다운 (assignment moved to
  시설 관리), no room numbers / furniture counts / purpose descriptions. A room row is **thumbnail + 용도 + 레벨** with
  the upgrade cost chips, a wide 업그레이드 button and a red 🗑 제거 icon that opens an in-screen confirmation card
  (never a browser dialog — the inventory window owns the keyboard). Empty rooms keep the same row height. The
  시설 관리 (M) button moved into its own sticky `.hs-ship-bar` under the two columns.
- `ui/FacilityRows.ts` lost `FACILITY_DESC` (the pips, the cost chips and the block reason already say it) and each row
  now leads with the shared `facilityThumb`.
- `ui/dom.facilityThumb(parent, glyph, color)` is the single thumbnail renderer for a facility / room purpose.

### Known follow-ups (Phase 9 UI pass)
- The refund is computed from the **current cost tables**: rebalancing `RANGE_UPGRADE_COST` / `WORKSHOP_UPGRADE_COST`
  changes what an already-built facility hands back. It also refunds at 100 %, so 짓고 부수기 is free — deliberate for
  now (there is no other way to move a facility to another room).
- `removeRoomFacility` pre-checks stash space with a free-cell estimate; a fragmented stash can still lose the tail of
  a refund at the real `tryAddToStash` call (a warning toast says so). Furniture storage is unbounded, so the pieces
  always land.
- A room's purpose can still be **assigned** only in 시설 관리 — the 함선 tab levels and removes, it does not create.

## Phase 9 UI/UX 개선 pass (2026-09-07)

- **시설 증축 costs materials.** Giving an empty room a purpose is no longer free: `ROOM_PURPOSE_BUILD_COST`
  (`@/shared`) is the price of the facility's level 1 and `ROOM_PURPOSE_BUILD_GENERATOR_LEVEL` (1) gates it like every
  other upgrade. `Rules.purposeBuildCost` / `purposeBuildBlockReason` are the pure rules, `HousingRef.purposeCost`
  exposes the table to the pickers, `setRoomPurpose` consumes it (all-or-nothing, bag → stash) and `purposeBlock` now
  reports 발전기 / 재료 shortages alongside the structural reasons. 빈 방 stays free.
- **시설 제거 refunds it too.** `Rules.roomRefundCost(purpose, level)` = the 시설 증축 price **plus** every upgrade
  above level 1, so `facilityRefund` works on any assigned room (it used to return `[]` for a room without a
  작업실 / 사격장 facility and for a facility still at level 1).
- **`ui/ShipView.ts` (함선 tab)** — the `용도가 정해진 방 n / m · 발전기 Lv.x` subtitle is gone; the host gets an
  `is-ship` class so the **panel no longer scrolls** and the 방 목록 scrolls on its own; an **empty** room row carries a
  **시설 증축** button that opens a centred `.hs-build` popup — one row per purpose with its cost chips, disabled with
  the 한국어 reason when the rules or the materials refuse it, dismissed with 닫기 or a click on the backdrop. The
  popup re-renders on every `refresh()`, so material counts and block reasons follow the state while it is open.
- The 용도 지정 picker and the 가구 제작 / 가구 창고 tabs live in `ui/hud/ShipManage.ts` (the ui folder owns that
  screen's DOM); this folder only supplies `purposeCost`, `purposeBlock`, `getFurnitureFor`, `getStored`,
  `canCraftFurniture` / `craftFurniture` and `selectFurniture`.

## Phase 10 UI 개선 pass (2026-09-07)

- **인게임 커서 (§2 of `docs/DECISIONS.md`).** `ui/Panel.ts` — the shell every housing panel (프리셋 / 재배 /
  책장 / 도감) inherits — now adds the `'housing'` blocker and then calls `ctx.input.setCursorMode(true, 'housing')`
  **without** exiting the pointer lock; `close()` deletes the token and calls `setCursorMode(false, 'housing')`, and
  the `relock()` microtask is gone (nothing ever unlocked). `close(relock)`'s parameter survives for the call
  signature only. `setCursorMode` is ref-counted per blocker token, so a housing panel opened over another cursor
  surface never steals the cursor from it on close.
- **No DOM handler changed.** The software cursor dispatches real bubbling `pointer*` / `mouse*` / `click` /
  `contextmenu` / `wheel` events at its virtual position, so every panel's click / hover / input wiring works
  untouched. This folder polls neither `input.mouseX / mouseY` nor `document.elementFromPoint` (the top-down
  placement cursor lives in `hub/HousingMode`, not here), so there was nothing else to migrate.
- **크레딧 없음.** Material requirements keep rendering through `shared/itemChip.ts` (`renderItemCost`) — they are
  item counts, not credits, so the new `formatCredits` rollout does not touch this folder.

## Phase 12 (2026-09-08) — "재료가 충분해 보이는데 증축이 안 됨" (plan item 16)

**Root cause (reproduced headless on a fresh ship with the 기본 지급품, `smoke-housing` "fresh ship → 발전기 → 작업실").**
Nothing in this folder was wrong in the sense of a broken rule — the rules were *invisible*:

1. `ShipState.freshState()` starts the ship at **`generatorLevel: 0`** (deliberate since the 2026-09-07 기본 작업실 폐지),
   and `Rules.purposeBuildBlockReason` refuses **every** 시설 증축 behind `generatorGateReason(state,
   ROOM_PURPOSE_BUILD_GENERATOR_LEVEL)` (= 1) **before** it looks at the materials. So on a brand-new ship all nine
   purposes answer `발전기 레벨 1 필요 (현재 0)` even though the `ROOM_PURPOSE_BUILD_COST` chips render as fully
   affordable (폐금속 16 · 케이블 3 · 합금 2 in the 창고 vs 작업실 8 + 2).
2. The 시설 관리 picker (`ui/hud/ShipManage`) surfaced that reason only as the `title` tooltip of a **`disabled`**
   button — so a click did literally nothing, and with the pointer-lock cursor there is rarely a hover to read it.
3. The only place the generator could be raised was Tab → 함선 tab (`ui/FacilityRows`); the screen that refused the
   build never pointed there.

Not the cause (checked): `countDefAll` / `consumeDefAll` agree (bag + stash both sides), `setRoomPurpose` returns false
only when `purposeBlock` is set or `consume` fails, and the click handler reads the live `this.room`.

**Fix.** The rules are unchanged (the gate is the design, and the 함선 tab already obeys it). The presentation moved to
the screen that refused: `ui/hud/ShipManage` now leads the 용도 지정 picker with a **발전기 row** (`getFacility('generator')`
→ level, `nextCost` chips, 가동 / 업그레이드 → confirm popup → `upgrade('generator')`), prints every `purposeBlock`
reason inline under its row, keeps blocked rows clickable (→ the reason as a toast) and confirms a build in a centred
modeless popup (`정말로 N번 방을 <용도> 시설로 만들겠습니까?` + `purposeCost` chips; Esc closes the popup only). This
folder only supplies what it already did — `getFacility`, `upgrade`, `purposeBlock`, `purposeCost`, `setRoomPurpose`.

**Follow-up for items/ (not this folder):** the 기본 지급품 is 폐금속 16 · 케이블 3 · 합금 2. 발전기 Lv.1 (폐금속 4) +
작업실 증축 (폐금속 8 · 케이블 2) fits, leaving 폐금속 4 · 케이블 1 · 합금 2 — the 총기 작업대 (`furn_bench_gun.craft` =
폐금속 8 · 합금 2 · 케이블 1) is then **4 폐금속 short**. `STARTER_STASH`'s comment says it covers 작업실 + 작업대, but
it was sized before the generator gate applied to a fresh ship; +4 폐금속 (or a 3rd stack) would make the intended
first-session chain complete.


## 파일 분할 규약 (`model.ts` + `parts/`, 2026-09-08)

`HousingSystem.ts` 는 한 파일에 다 있기에는 너무 커져서 **동작을 바꾸지 않고** 갈랐다. 규칙은 세 줄이다.

1. **`model.ts`** — 폴더 공용 어휘(타입 · 상수 · 스크래치 객체, 상태 없는 보조 클래스).
   `HousingSystem.ts` 이 `export * from './model'` 로 재수출하므로 **기존 import 경로는 전부 그대로 동작한다.**
2. **`parts/*.ts`** — 클래스에서 떼어낸 메서드 묶음. 각 함수는 인스턴스를 첫 인자 `sys` 로 받는다:
   ```ts
   export function foo(sys: HousingSystem, …) { … }   // 예전의 this → sys
   ```
   클래스에는 같은 이름의 **한 줄 위임 메서드**가 남아 있으므로 호출부는 하나도 바뀌지 않았다.
3. `parts/` 가 닿는 클래스 멤버는 `private` 이 벗겨져 있다. **폴더 밖에서 쓰라는 뜻이 아니다** —
   외부와의 계약은 `@/shared` 의 `*Ref` 인터페이스가 전부다.

새 `parts/` 파일은 맨 위 doc 주석에 **그 파일이 답하는 질문 한 줄**을 적고 위 표에 행을 추가한다.
순환 import 를 만들지 않으려면 `parts/` 는 `HousingSystem.ts` 에서 **타입만** 가져와야 한다 — 값은 `model.ts` 로.

---

## 변경 이력

- **2026-09-12 (A-3a 헬스장 — 운동 미니게임 세션)** — 계약(`HousingRef.gymSession` · `gymBlock` · `startGymSession` · `cancelGymSession`,
  `housing:gymSession` · `gymBeat` · `gymResult`)의 housing 몫. 새 파일 `parts/Gym.ts` · `parts/GymGames.ts` · `ui/gym/{GymScreen,GymViews}.ts` ·
  `ui/gym/gym.css`, `HousingSystem.ts` 에는 `/* ══ 헬스장 (A-3a) ══ */` 블록 + `init` · `dispose` 한 줄씩(`GymScreen` · `bindGym`).
  - **판정은 순수 클래스**라 스모크가 화면 없이 규칙만 몬다(`gymDebug.makeGame`). 설계안 §4 에 없던 빈칸 두 개를 여기서 정했다:
    박자 게임의 **예비 박자 4 박**(첫 표식이 걸어올 시간 — `data/constants.csv` 의 `GYM_LEAD_BEATS`)과 **헛누름 = 다음 표식의
    실패**(Space 연타로 모든 창을 줍지 못하게). 호흡의 「하」 뒤에는 한 박 쉼이 있다(`하` 길이 1.2 s 가 박자 0.6 s 보다 길어 겹친다).
  - **화면은 커서 모드를 켜지 않는다** — 블로커 `housing.gym` 만 올리고 capture keydown 으로 `Keys.JUMP` · `LEFT` · `RIGHT` 를 삼킨다.
    keyup 은 keydown 을 삼킨 키만 삼킨다(열리기 전부터 쥐고 있던 D 의 keyup 을 먹으면 `Input` 이 그 키를 영영 눌린 것으로 안다).
    게임 도중의 E 는 닫지 않고 삼키기만 한다(사이클의 D 바로 위 키).
  - `completed` = 게임을 끝까지 했다(점수를 넘겼다). 취소(Esc · Tab · 페이즈 변경 · `cancelGymSession`)는 결과도 디버프도 없다.
    progression 이 `applyGymSession` 을 갖고 있지 않으면 결과 화면이 「반영하지 못했습니다」라고 말한다.
  - 새 스모크 `scripts/smoke-gym.mjs` (verify 매핑: housing · progression · hub · player).

- **2026-09-12 (A-3e 서재 매체 — 디스크 전시대 · 레코드랙 · 보조 가구, docs/plans/a3a-a3e.md §6-2)**
  - **공식** (`Rules.shelfGainFor` · `shelfPartFor` · `shelfAuxPlaced` · `shelfItemWeightOf` · `shelfMediumOfDefId` · `SHELF_ID_PREFIX`):
    매체마다 `min(SHELF_GAIN_MAX[m] − 1, SHELF_XP_PER_ITEM[m] × Σ BOOK_RARITY_MUL)` 로 **따로 자르고**, 보조 가구(`SHELF_AUX_INTERACTION[m]`)가
    함선 어디든 배치돼 있으면 자른 뒤 `× (1 + SHELF_AUX_BONUS[m])`, 셋을 더해 `1 + Σ`. 레코드 플레이어 셋은 모두 `record_player` 라 몇 대든
    한 번이다. `getBookBonus(skill)` = 이 합(`getShelfBonus(skill).total`) — 책만 있고 보조 가구가 없으면 옛 `bookGainMulFor` 와 같은 값이고
    그 함수는 남겨 뒀다. `getSkillGainMul` 이 이것을 읽으므로 progression/ 무변경.
  - **`parts/Library.ts`**: 계약 11종(`getShelfMedium` · `getShelfSlots` · `placeShelfItem` · `takeShelfItem` · `getOwnedShelfItems` · `getShelfDex` ·
    `getShelfBonus` · `hasShelfAux` · `openShelf` · `isFurnitureOn` · `toggleFurniture`) + `media()`(런타임 prune — `books()` 와 같은 규약, 배열 기준
    `WeakSet` 이라 서버 사본으로 바뀐 상태도 다시 거른다) · `mediaDex()` · `toggledUids()` · `shelfItemsOf` · `shelfBlock` · `stashShelfItemsOf` ·
    `dropToggled`. **책장은 옛 경로 그대로**(`placeBook` · `takeBook` · `housing:booksChanged`, 사유 `bookPlace` / `bookTake`)이고 매체 공통 API 가
    책장이면 그리로 넘긴다 — `booksChanged` 는 이제 `housing:shelfChanged {medium:'book'}` 도 낸다. 디스크 · 레코드는 `shelfPlace` / `shelfTake`.
    켜기는 `toggled` 를 뒤집고 `changed('toggle')` + `housing:furnitureToggled` + `audio:play`(`tv_on` · `tv_off` · `record_on` · `record_off`).
  - **회수 · 시설 제거**: `recover` 가 디스크 · 레코드도 책처럼 창고로(all-or-nothing, 실패 사유 `model.SHELF_BLOCK_REASON` =
    `디스크를 먼저 빼세요` / `레코드를 먼저 빼세요`) 옮기고 `housing:shelfChanged {count: 0}`, 회수한 조각의 uid 는 `toggled` 에서 뺀다.
    `recoverBlock` · `Rooms.emptyRoomBlock`(= `purposeBlock(room, 'empty')` · `removeRoomFacility`) 이 모든 보관함을 본다.
  - **`ShipState` v9** (`SHIP_STATE_VERSION_CURRENT = max(9, …)`): `media`(배치된 디스크 전시대 · 레코드랙 uid · **보관함 매체 = id 모양의 매체** ·
    칸 < `SHELF_SLOTS[m]` · (uid, slot) 하나), `mediaDex`(`disc_*` · `record_*` 모양 유일 목록, 꽂힌 것 전부 포함), `toggled`(배치된 켤 수 있는
    조각 uid, 중복 없이). v8 의 사라진 방 환불이 가구 창고로 간 보관함의 **같은 매체** 디스크 · 레코드도 `out.refund` 로 돌려준다.
  - **화면**: `ui/BookshelfMenu.ts` 한 장이 매체를 바꿔 그린다(`openShelf(uid)` → `data-medium`, 칸 카드 수 · 보유 목록 · 도감 · 설명이 매체를 따른다) +
    보조 가구 한 줄(`.hs-shelf-aux`, `TV 배치됨 — 디스크 몫 +25 %`, 수치는 `SHELF_AUX_BONUS`). 책장은 `ui:bookshelfToggled`, 디스크 · 레코드는
    `ui:shelfToggled`. `ui/BookDex.ts` 는 `createBookDex(…, medium)` + `setMedium(m)`, 배율 칸은 서재 합산이고 `title` 이 매체별 몫을 적는다.
    `model.ts`: `SHELF_BLOCK_REASON` · `SHELF_OBJ_KO` · `SHELF_UNIT_KO` · `shelfHolderName(m)` · `shelfAuxNames(m)`.
  - 스모크: `smoke-library` 8절(매체 질의 · 꽂기/빼기 · 거절 · 매체별 상한과 합산 · 보조 가구 · 레코드 플레이어 3대 = 한 번 · 켜기 저장 · 패널 전환 ·
    회수 · v9 sanitize · 사라진 방 환불), `smoke-housing` 의 버전 기대값 8 → 9.

- **2026-09-12 (시설관리 정리 — 조종석 · 방 8 개 · 시뮬레이션실 / 휴식 공간 / 프리셋 제거, 사용자 결정)**
  - **조종석** (`COCKPIT_ROOM_INDEX` = 100, 계약 `shared/housing.ts`): `rooms[]` 에 들지 않는 고정 공간이다.
    `Rules.isPlaceRoom` · `placeRoomPurpose` 가 「가구를 놓을 자리」를 방과 조종석으로 넓히고, `canPlaceAt` · `insideGrid` ·
    `autoPlaceSpot` 은 `roomGridSize(room)` 과 `roomRectBlocked(...)`(고정 소품 표 `COCKPIT_BLOCKED_RECTS`)를 읽는다 — 조종석에는
    문 앞 여유 구역이 없다(표가 통로를 이미 비운다). `getRoom(100)` = `{purpose: 'cockpit', level: 1}`, `getFurnitureFor('cockpit')` =
    `room: 'any'` 가구, `openShipManage` · `setManageRoom` 이 받는다. `purposeBlock` · `setRoomPurpose` · `removeRoomFacility` 는
    `조종석은 용도를 바꾸거나 제거할 수 없습니다`, `facilityRefund` 는 `[]`.
  - **공용 시설 가구 두 점**(전술 임플란트 시술대 `furn_implant_bay` · 기업 네트워크 컴퓨터 `furn_corp_computer`, `craft` 없음):
    `ShipState.ensureCockpitFurniture` 가 **새 함선과 모든 로드**에서 「어디에도(배치 · 가구 창고) 없으면」 조종석 기본 자리
    (`COCKPIT_DEFAULT_FURNITURE`) → 자동 배치 자리 → 가구 창고 순으로 채운다. 새 함선의 uid 는 f-1 · f-2. `furnitureCraftBlock` 은
    보유 판정을 `craft` 검사보다 먼저 해 늘 `이미 보유 중입니다` 로 답한다. 회수는 허용된다.
  - **ShipState v8**: 방은 `SHIP_ROOM_COUNT`(8). 옛 세이브의 방 번호 ≥ 8 인 시설 방과 `ROOM_PURPOSES_ASSIGNABLE` 밖의 용도
    (시뮬레이션실 · 휴식 공간)는 **전부 제거 + 환불** — 증축 재료(`roomRefundCost(purpose, 1)`) → `out.refund`(함선 창고), 그 방의
    가구 → 가구 창고, 가구 창고로 간 책장에 꽂혀 있던 책 → `out.refund`. 관물대 · 표적 레인 · 시뮬레이션 허브는 `retired=1` 이라 은퇴
    청소가 재료로 돌려준다. v6 이하 사격장 Lv.n 을 가구로 옮기던 v7 절은 옮길 곳이 없어져 **늘 환불**로 줄었다(방 레벨은 제거 전
    원본 목록 `rawPurposes` 에서 읽는다). `SanitizeOutcome.migratedRooms` · `grantedCockpit` 추가, `loadState()` 는 `granted` 도 돌려준다
    — `migrated` 는 `editPending` 을 세우고(옛 서버 사본이 덮지 못한다), `granted` 는 저장만 건다.
  - **시설 레벨 요구 질의** `furnitureUpgradeRequirements(uid)` · `purposeRequirements(purpose)` (`Rules.furnitureUpgradeRequirementsFor` ·
    `purposeRequirementsFor` · `generatorRequirement` — `generatorGateReason` 과 같은 식, 채워지지 않은 것만).
    `ui/UpgradeModal` 의 `UpgradeSpec.requirements` 와 `ui/ShipView` 의 시설 증축 목록이 재료 칩 뒤에 `buildFacilityChip` 으로 그린다.
  - **프리셋 기능 제거**: `ui/PresetMenu.ts` 삭제, `parts/Presets.ts` 는 「슬롯 없음」(`getPresetCount` 0 · `save` false · `apply` null ·
    `openPresetMenu` no-op), `state.presets` 는 세이브에 그대로. `getSkillGainMul` = 서재 책뿐(`Rules.presetCountFor` ·
    `skillGainMulFor` 는 `@deprecated`, 호출자 없음). `FacilityRows` 효과 요약에서 프리셋 · 사격 숙련 줄을 뺐다.
  - 스모크: `smoke-housing`(조종석 · v8 마이그레이션 · 은퇴 · 프리셋 no-op · 시설 제거 1초 홀드 · 인스펙터 위치 이동 버튼 제거) ·
    `smoke-library`(사격 숙련 = 책뿐 · 방 8 개) · `smoke-controls-hub`(Tab 함선 탭 방 8 개).

- **2026-09-12 (방 8 × 8 m · 정비 벤치 은퇴 — hub 에이전트가 결들인 부분)** — 이 폴더에서 실제로 바뀐 것은 세 줄이다.
  - **`Rules.ts`** — 동작은 한 줄도 안 바뀐다. `ROOM_GRID_COLS/ROWS` 가 8 → 16 이 된 뒤에도 `insideGrid` · `autoPlaceSpot`
    은 상수를 읽으므로 저절로 따라가고, `DOOR_CLEAR_DEPTH`(2) · `DOOR_CLEAR_SPAN`(4)은 **일부러 그대로 둔다** — 둘 다
    방 크기의 비율이 아니라 문 폭 1.6 m · 플레이어 지름 0.9 m 에서 나온 치수라, 같이 키우면 새로 생긴 공간을 도로 빼앗는다.
    구역이 여전히 문 앞인지만 다시 재서 주석으로 남겼다 (16칸: 칸 6…9 = 3.0…5.0 m, 문은 3.2…4.8 m).
    `canPlaceAt` 에는 여전히 문 앞 여유를 넣지 않는다(CLAUDE.md 의 경고 — `sanitize` 가 이미 문 앞에 둔 가구를 빼앗는다).
  - **`ShipState.ts` — 버전을 올리지 않았다.** `PlacedFurniture.x/y` 는 좌상단(방의 min-x / min-z) 원점 정수라 격자가
    **커지기만** 하면 뜻이 한 자도 안 바뀌고, `canPlaceAt` 의 세 조건 중 용도 · 겹침은 격자와 무관 · `insideGrid` 는
    느슬해지기만 한다 — 8칸에서 통과한 배치는 16칸에서 전부 통과한다. 그 근거를 `sanitize` 의 해당 줄 위에 적어 두었다
    (⚠ 그 검사는 **클램프가 아니라 드롭**이라, 격자를 **줄이는** 변경을 한다면 그때는 마이그레이션이 필요하다).
  - **`ShipState.ts` — v1 → v2 정비 벤치 지급을 걱어냈다.** 그 가구가 은퇴하면서(사용자 결정, `data/furniture.csv` 의
    `retired=1`) 지급은 낝비를 넘어 **버그**가 됐다 — 은퇴 가구 청소 두 자리(배치 · 보관)가 둘 다 지급보다 **위**라,
    밀어 넣으면 걸러지지 않고 가구 창고에 남아 `getStored()` 에 뜨면서 배치는 안 된다. 이미 벤치를 가진 세이브는
    `sanitize` 의 은퇴 환불을 받는다. 계약 이름 `REPAIR_BENCH_DEF_ID` 는 남긴다.
  - 나머지(실내 지오메트리 · 광원 자리 · 정비 벤치 배선 제거)는 전부 `src/hub/` 쪽이다 — `src/hub/README.md` 의 같은 날짜 항목.

- **2026-09-12 (가구 화면 2차 — 좌측 레일 · 영역별 툴팁 · 겹침/크기 정리, 사용자 결정)** — 아래 개편의 뒤처리다.
  `ui/**` 와 `housing.css` 만 건드렸고 규칙 · 상태 · 질의는 한 줄도 바뀌지 않았다 (`ctx.housing` 의 기존 질의만 읽는다).
  - **맨 왼쪽 세로 레일 `StationShell.rail`** — 화면이 여러 대상 · 여러 페이지를 가질 때 그것을 고르는 줄이 **늘 같은
    자리**에 선다. 몸통을 grid 에서 **flex** 로 바꿔, 레일을 쓰지 않는 화면(배양조 · 식탁)에서는 `hidden` 한 줄로
    gap 까지 함께 사라진다.
  - **재배 스테이션 목록** (레일) — 함선의 재배 스테이션 한 줄씩, 각 줄에 **3×3 원형 점 9개**(`getGrowSlots` 순서 ·
    회색 자라는 중 / 까망 자랄 게 없음(잠긴 칸 포함) / 초록 수확 가능)와 익은 칸이 있으면 **레드닷**. 누르면 그
    스테이션으로 전환한다. 목록은 배치 구성이 바뀔 때만 짓고 점은 기존 1초 틱(`paint`)이 칠한다. 스테이션이 하나여도
    숨기지 않는다 — 현황 점이 한 대짜리 함선에서도 쓸모 있고, 분석기 탭 레일과 같은 자리에 서야 두 화면의 좌측이
    어긋나지 않는다. 레드닷은 모서리 배지가 아니라 **이름 왼쪽의 자리를 늘 차지하는 점**이다: 레일은 세로 스크롤
    컨테이너라 `overflow-x` 가 `visible` 로 계산되지 않아 모서리 배지가 잘린다.
  - **분석기 탭이 레일로** — `.az-split`(좌 패널 안의 세로 탭 + 페이지)을 없애고 탭을 `shell.rail` 로 옮겼다.
    좌 패널에는 `.az-pages` 만 남는다.
  - **분석기 버튼 ↔ 게이지 겹침** — 원인은 `.az-acts { position: absolute }` 가 흐름에서 빠져 본문 위에 얹힌 것
    하나였다(좌 패널이 좁아질수록 남은 시간 · 진행바를 덮었다). 칸을 **세 열**(글리프 | 본문 | 버튼)로 만들고
    버튼을 자기 열에 세로로 쌓았다 — `.az-slot-body` 에 우측 예약 폭을 주는 우회가 필요 없어진다.
  - **재배 칸 하단 시간의 높이 고정** — 상태마다 인라인 박스 구성이 달라(`renderClock` 은 span 둘, `renderClockText`
    는 텍스트 노드 하나) 전환 때 베이스라인이 흔들렸다. `.gs-time` 에 **고정 `height` + 한 가지 `font-size`**,
    상태별로는 **색과 굵기만**. 빈 칸도 자리를 차지한다: **흙 없음 = 「토양 필요」(빨강) · 흙만 = `00:00`(딤드)**.
  - **`:SS` 가 `HH:MM` 과 같은 크기** — `.hs-clock-ss` 의 `font-size: 0.5em` 을 걷어냈다. **스테이션 네 화면 공용**으로
    같게 뒀다: 화면마다 다른 크기를 쓰면 같은 시계가 화면마다 달라 보이고, 위의 높이 고정도 글자 크기가 하나여야
    성립한다. `tabular-nums` 는 `.hs-clock` 에 그대로 있다.
  - **영역별 호버 카드** — 칸 전체에 하나이던 툴팁을 **흙구멍(`.gs-pot`) = 토양 카드 / 그 위 식물 공간(`.gs-plant`)
    = 작물 카드**로 갈랐다. 「식물 이미지뿐 아니라 자라날 공간 전체」가 대상이라 `.gs-plant` 의 `pointer-events: none`
    을 풀었다 — **드롭 대상은 여전히 `.gs-pot[data-tier]` 하나**이고 두 영역은 세로로 겹치지 않으므로 드래그 드롭
    경로(`TradeGrids` → `dropSelector`)는 한 줄도 바뀌지 않는다. 정보가 없는 영역은 「비어 있음」으로 짧게 답한다.
  - **가방 · 창고가 제작 UI 와 같아 보이게** — `.hs-inv` 의 `--inv-*` **재선언을 통째로 걷어냈다**. 그 사본에만
    `--inv-bg` · `--inv-bg-2` · `--inv-swap` 이 더 있어 `.trade-grids`(inventory, **값의 원본**)와 어긋나 있었다.
    같은 배치에서 우 패널 폭을 `auto`(창 폭과 무관하게 늘어난다)에서 **`flex: 0 1 auto` + `max-width: --hs-inv-w`**
    로 바꿔 새 **가로 2열** `TradeGrids`(가방 5칸 + 창고 10칸이 나란히)에 맞췄고, 프레임을 1180 → 1540 px 로
    넓혔다(레일 176 + 좌 300 + 우 936 + gap 32 + `.menu .frame` 여백 80). 스택 전환 breakpoint 는 1100 → 1180 px.
  - **스테이션의 격자는 블록마다 자기 스크롤** (같은 날 회귀 수정 — 드래그 두 방향이 다 막혔던 자리) —
    두 격자가 가로로 나란히 서려면 우 패널에 892 px 이 필요하고, 레일 176 + gap 16 + 좌 패널 최소 300 + gap 16 +
    프레임 여백 80 + `.menu` 여백 48 을 더하면 **뷰포트 1580 px 부터**다 (실측: 1560 줄바꿈 · 1580 나란히).
    그보다 좁으면 `.tg-scroll` 의 `flex-wrap` 이 가방을 아랫줄로 내리는데, **한 스크롤에 세로로 이어 붙이는 한
    어느 쪽을 위에 올려도 다른 쪽이 화면 밖**이다 — 창고 격자 24행 = 1381 px · 가방 틀 12행 = 709 px 인데 스크롤
    창은 600 px 남짓이라, 창고가 위면 가방이 y≈1574, 가방이 위면 창고가 y≈900 에서 시작한다. **끌고 있는
    동안에는 스크롤할 수 없으므로** 그때마다 「창고 → 흙구멍」이나 「수확물 → 가방」 한 쪽이 통째로 막혔다
    (`smoke-stations` 의 `elementFromPoint` 가 null 이던 것 · `soil: null` 이던 것 둘 다 이것이다).
    그래서 `.hs-inv` 안에서는 **`.tg-scroll` 이 한 줄(`flex-wrap: nowrap`)이고 블록이 그 높이를 나눠 가지며,
    넘치는 행은 각자 `.inv-grid` 안에서 스크롤한다** (`flex: 0 1 auto` + `overflow-y: auto`). 가로 2열일 때는
    `align-items: stretch` 로 높이를 채우는데, `nowrap` 이 **필수**다 — 여러 줄 flex 상자에서 `stretch` 는 상자가
    아니라 그 줄(= 1381 px)까지만 늘린다. 좁을 때(`@media (max-width: 1599px)`)는 세로 스택 + `flex: 1 1 0` 으로
    **반씩** 나눈다(비례로 나누면 창고가 대부분을 가져가 기본 6행 가방이 잘린다); 순서는 DOM 그대로 **창고 위 ·
    가방 아래**다 — 「창고 왼쪽 · 가방 오른쪽」을 읽는 순서대로 내린 것이고, 이제 둘 다 보이므로 순서가 닿고
    못 닿고를 정하지 않는다. 실측(1280 · 1440 · 1536 · 1600 · 1920) 다섯 폭 모두 두 블록이 화면 안에 있다.
    값 · 기본 배치의 원본(`.trade-grids`)은 손대지 않았다 — **기업 거래 화면은 한 줄도 바뀌지 않는다**.

- **2026-09-12 (가구 화면 개편 — 재배 스테이션 · 분석기 · 배양조 · 식탁, 사용자 결정)** — 네 화면이 한 틀을 쓴다.
  - **공통 틀 `ui/StationShell`** — 제목(방 번호 없음) + 옆에 `Lv. n` · 우상단 「업그레이드」, 좌 패널(가구 내용) / 우 패널
    (가방 · 함선 창고 격자). 설명 줄 · 「가방 · 함선 창고」 라벨 · 안내문 · 「모두 수확」 · 「모두 회수」를 걷어냈다. 식탁은
    레벨이 없어 `Lv.` · 업그레이드만 없다.
  - **업그레이드 모달 `ui/UpgradeModal`** — 옛 강화 줄(`.gs-up` · `.az-up` · `.ct-up`)을 대신한다. 재료 칩 · 여는 것 한 줄 ·
    사유, **`UI_HOLD_CONFIRM_S` 1초 홀드**(클릭 · Enter 로는 확정 안 됨). Escape 는 `ctx.escape`, E · Tab 은 패널의
    `overlays` 가 먼저 닫는다 (`ui/Panel` 의 `PanelOverlay`). 홀드는 rAF 가 아니라 `setInterval` + 경과 시간.
  - **시간 `HH:MM:SS`** (`dom.clockParts` · `renderClock` — `:SS` 는 절반 크기). 끝나면 「수확 가능」 / 「해석 완료」.
  - **재배 스테이션** — 잠긴 층은 테두리만, 흙구멍 50 %(39 px) · 하얀 바 윗변 = 흙구멍 윗변 · 작물은 구멍 위에서 자라고
    (`--g` transform) 그 높이만큼 층 사이를 벌렸다. 층 라벨 · 「N칸 사용 중」 · 궁합 줄 · 수확 버튼은 **호버 카드
    `ui/StationTip`**(씨앗 · 토양 · 남은 시간 · 궁합 %) 와 **우클릭 메뉴 `ui/StationMenu`**(「흙 비우기」 /
    「작물 버리고 흙 비우기」 = `clearSoil(…, discardCrop)`) 로 옮겼다.
  - **수확 = 아이템처럼 (`ui/ProductDrag`)** — 더블클릭 = **함선 창고 먼저**, 끌어서 격자에 놓으면 **그 격자에만**
    (`[data-tg-grid]`). 배양조도 똑같다 (우클릭 「배지 비우기」 = `clearMedium(…, discardStrain)`), 분석기는 버튼(우하단)
    + 더블클릭 · 끌기. 넣을 곳은 새 `parts/Deliver.deliverItem(sys, item, dest)` 하나가 정한다 — 계약에 `HarvestDestination`
    과 `harvestAt` · `collectAnalysis` · `harvestCulture` 의 선택 인자 `dest` 를 **추가**했다 (기본 `'bag-first'` = 예전 그대로).
  - **분석기** — 좌측 세로 탭 「해석」 · 「해석 도감」 (도감이 격자 밑에서 자기 탭으로), 잠긴 칸 = 빈 칸, 위 이름 · 아래 시간,
    「처음 해석」 부연 제거.
  - **드래그 렉** — 드롭 한 번에 `refresh()` 가 명시 호출 + `housing:changed` + `inventory:changed` + `stashChanged` 로 3–4번
    돌고 매번 층 DOM 을 통째로 다시 지었다(+ 격자 뷰 `refresh`). 이제 `HousingPanel.coalesceRefresh` 가 한 마이크로태스크로
    합치고(스테이션 네 화면만 켠다 — 프리셋 · 책장은 동기 그대로), 층 DOM 은 **레벨이 바뀔 때만** 짓는다 (`debug.builds` ·
    `refreshStats`). 드롭 강조는 전환 없는 배경색이다. 격자 쪽 고스트 · hit test 는 inventory 의 `TradeGrids` 가 고쳤다.
  - **`.ct-*` → `.cult-*`** — 배양조 CSS 가 기업 화면의 `.ct-cell` · `.ct-slots` 와 이름이 같아 거래 칸이 배양관 모양으로
    그려졌다. 스모크 `scripts/smoke-stations.mjs` (verify 매핑 housing · inventory · items).

- **2026-09-12 (하우징 모드 UI 개선 · 방 시설 레벨 제거 · 이름 변경 — 사용자 결정)** — 셋 다 이 폴더의 규칙에서 시작한다.
  - **모든 용도가 함선당 하나** (`Rules.purposeChangeReason`) — 시설 관리의 용도 지정 목록과 함선 탭의 증축 팝업이
    이미 지은 용도를 아예 그리지 않는다. 두 개 지어 둔 옛 세이브는 그대로 둔다.
  - **방 시설 레벨 제거** — 작업실 · 시뮬레이션실에는 레벨이 없다. 프리셋 슬롯은 **관물대**, 사격 숙련 상승은
    **시뮬레이션 허브** 레벨(둘 다 maxLevel 5, 옛 사격장 강화비를 `furniture_upgrades.csv` 로 옮겼다)이 정하고 제작 재료
    할인은 폐지. `furnitureMaxLevel` 의 `BENCH_MAX_LEVEL` 상한은 작업대에만. `ShipView` 의 방 행에서 레벨 · 비용 ·
    업그레이드 버튼을, `FacilityRows` 효과 요약에서 제작 비용 배율을 걷어냈다. `facility_upgrades.csv` 의 workshop · range
    묶음은 **은퇴 표**(환불 계산용)로 남는다.
  - **ShipState v7** — 옛 방 레벨을 가구 레벨로 옮기거나 재료로 환불한다 (위 `ShipState.ts` 행). 환불 토스트 문구가
    「없어진 시설 · 가구를 정리…」로 넓어졌다 (은퇴 재배층과 같은 자루).
  - **이름**: 사격장 → **시뮬레이션실**, 채굴 시설 → **암호화폐 채굴 시설** (`shared/housing.ts` 의 표시 이름만 — id 는
    `range` · `mining` 그대로). 이 폴더의 프리셋 안내 문구도 따라 바뀌었다.
  - 선택 → 위치 이동 상태 · 인스펙터 토스트는 `hub/HousingMode` · `ui/hud/ShipManage` 의 일이다 (각 README).
  - 스모크: `smoke-housing` (방 레벨 단언 교체 · 관물대/허브 레벨 · v7 마이그레이션 3건 · 하위 탭 · 위치 이동 상태),
    `smoke-library` (허브를 놓아야 ×1.1).

- **2026-09-11 (배양조 A-14 · 주방 식탁 A-3c)** — 계약(`src/shared/housing.ts` 의 「온실 — 배양조」 · 「주방 —
  식탁」 블록 · `types.ts` 의 `MealDef` · `StrainDef` · `MediumDef` · `labels.ts` 의 `MEAL_BUFF_*` ·
  `progression.ts` 의 `useMeal` / `serveMeal`)과 `data/furniture.csv` · `data/items.csv` · `data/meals.csv` 는 먼저
  커밋됐고(61ef305) 이 폴더는 그것을 구현했다. 설계안은 `docs/plans/a3c-a14-a15.md`.
  - 새 것: `parts/Culture.ts`(배양조 상태 · 규칙 전부), `parts/Dining.ts`(식탁), `Rules.cultureDurationMs`
    (`analyzeDurationMs` 바로 옆) · `Rules.NEEDS_GREENHOUSE`, `ui/CultureTank.ts`(배양 화면 — `ui/Analyzer` 가
    본보기) · `ui/DiningTable.ts`(식사 화면 + `mealBuffText`), `housing.css` 의 `.ct-*` · `.dt-*` 블록,
    `ShipState` **v6**(`cultures`) + `isCultureTankDefId` · `isDiningTableDefId`.
  - 고친 것: `HousingSystem` 에 한 줄 위임 24개 + 패널 둘(`cultureTank` · `diningTable`) + `culturesPruned` 플래그,
    `parts/Furniture.recover` 가 `dropCulturesOf(uid)` 도 부른다, `parts/Presets.panels` 에 새 패널 둘,
    `ui/Panel.HousingPage` += `'culture'` · `'dining'`(와이어는 그대로 `page: null` — 계약의 page union 은 동결이라
    이제 `WIRE_PAGES` **화이트리스트**로 거른다: 새 페이지를 더할 때마다 부정 목록을 늘리지 않는다),
    `index.ts` 가 두 def-id 판별자를 재수출.
  - **주방도 온실 선행**이다(작물이 유일한 요리 재료다). 연구실이 쓰던 조건을 복사하지 않고 `NEEDS_GREENHOUSE`
    한 줄로 합쳤다 — 그래서 `purposeChangeReason` · `sanitize` 낙오 처리 · 「마지막 온실이 사라지면」 셋이 저절로
    같이 움직인다 (전에는 `sanitize` 와 `setRoomPurpose` 가 `'lab'` 을 각자 적고 있었다).
  - v5 → v6 은 **마이그레이션이 없다**: 없던 필드가 생기는 것뿐이라 버릴 데이터도 환불 경로도 없고, 옛 세이브는
    빈 `cultures` 로 열린다.
  - 이 폴더가 **하지 않는 것**: 배양조 · 조리대 · 식탁 · 프린터의 절차 모델과 공유 함선 고정 식탁의 상호작용
    지점(hub), 새 아이템 로더(items), 주머니 격자(inventory), `PlayerProfile.meal` 영속화 · `derived` 접기
    (progression), `meal serve` 와이어(net), 식사 배지 · 툴팁(ui).

- **2026-09-11 (연구실 — 분석기 A-12 · B-13 ref)** — 계약(`src/shared/housing.ts` 의 「연구실 — 분석기」 블록 ·
  `types.ts` 의 `SampleDef` · `constants.ts` 의 `ANALYZE_*`)과 `data/samples.csv` · `data/furniture.csv` 는 먼저
  커밋됐고(652aff6) 이 폴더는 그것을 구현했다.
  - 새 것: `parts/Lab.ts`(분석기 상태 · 규칙 전부), `Rules.analyzeDurationMs`(`growDurationMs` 바로 옆),
    `ui/Analyzer.ts`(분석 화면 — `ui/GrowStation` 이 본보기), `ui/SampleDex.ts`(해석 도감 — `ui/BookDex` 의
    `{root, refresh}` 패턴 그대로), `housing.css` 의 `.az-*` 블록, `ShipState` **v5**(`analyses` · `sampleDex`).
  - 고친 것: `HousingSystem` 에 한 줄 위임 15개 + `analyzerPanel` 패널 + `analysesPruned` 플래그,
    `parts/Furniture.recover` 가 `dropAnalysesOf(uid)` 도 부르고 `upgradeFurniture` 가 분석기면
    `housing:analysisChanged` 를 함께 낸다, `parts/Presets.panels` 에 새 패널, `ui/Panel.HousingPage` += `'analyzer'`
    (와이어는 그대로 `page: null` — 계약의 page union 은 동결), `index.ts` 가 `isAnalyzerDefId` 재수출.
  - **B-13**: `furnitureUpgradeCost` · `furnitureCraftBlock` 신설, `furnitureUpgradeBlock` 은 이미 있던 것이 계약에
    올라온 것뿐이다. 「이미 보유 중」은 **`furnitureCraftBlock` 의 사유일 뿐 규칙이 아니다** — `canCraftFurniture` ·
    `craftFurniture` 는 한 줄도 바뀌지 않았다 (아래 `알려진 한계` 참고).
  - v4 → v5 는 **마이그레이션이 없다**: 없던 필드가 생기는 것뿐이라 버릴 데이터도 환불 경로도 없고, 옛 세이브는
    빈 `analyses` · `sampleDex` 로 열린다.

- **2026-09-11 (재배 스테이션 강화 줄 — 닿을 수 없던 Lv.2 · Lv.3)** — 온실 개편이 「가구 레벨이 재배층을 연다」로
  설계됐는데 `HousingRef.upgradeFurniture` / `furnitureUpgradeBlock` 을 부르는 UI 가 `src/` 어디에도 없었다
  (옛 방 메뉴가 Phase 8 에 시설 관리로 리다이렉트되면서 사라졌고, 시설 관리의 `.fcard` 는 **배치된 가구가 아니라
  가구 def** 카드다). 그래서 Lv.2 · Lv.3 재배층이 통째로 죽은 콘텐츠였다. 이제 **재배 화면이 자기 스테이션을
  강화한다** — `ui/GrowStation` 의 재배층 열 **위**에 `.gs-up` 한 줄: `Lv.n / 3` · 다음 레벨이 여는 층
  (`growTiersForLevel` 에서 **유도** — 층 번호를 코드에 적지 않는다) · 비용 칩(`renderCost` → `shared/itemChip`) ·
  「강화」 버튼. 사유는 전부 `furnitureUpgradeBlock(uid)` 의 한국어 한 줄이고 버튼 비활성 + 인라인 + `title` 로
  같이 보인다. 성공하면 `refresh()` 가 새 층과 우측 `createTradeGrids` 격자(재료가 가방 · 창고에서 빠진다)를
  함께 다시 그린다. 되돌릴 수 있는 확정이라 **1초 홀드는 쓰지 않는다**(그 규약은 파티 떠나기 · 캐릭터 삭제 같은
  빨간 버튼 전용). 잠긴 층 문구도 버튼을 가리키게 다듬었다 (`🔒 Lv.N 강화로 열립니다 · 위 「강화」`).
  `housing.css` 에 `.gs-up*` 5종 추가 — 이 패널 전용 이름이라 HUD 위젯 클래스와 겹치지 않는다.
  **작업대(`bench_*`) Lv.2–3 도 같은 이유로 못 닿지만 이번 범위가 아니다** — 그것은 시설 관리 화면(`src/ui/` 소유)의
  일이고 `docs/TODO.md` 에 별도 항목으로 남아 있다.

- **2026-09-11 (온실 개편 — 재배층 → 재배 스테이션)** — 사용자 결정 「옛 것 폐기」. 스택 4층짜리 옛 재배층
  (`furn_grow_rack`)은 `FurnitureDef.retired` 로 은퇴했고, 레벨이 재배층을 여는 **재배 스테이션**(`furn_grow_station`,
  maxLevel 3 · Lv.1 중앙 / Lv.2 아래 / Lv.3 위 · 층마다 3칸)이 그 자리를 받는다. 칸은 **두 단계**다 — 흙을 붓고
  (`fillSoil`, 토양에는 `SoilTag` 속성이 있다) 그 위에 심는다(`plantSeedAt`); 씨앗의 `soilTag` 와 맞으면
  `SOIL_MATCH_SPEEDUP` 만큼 빨리, 아니면 `SOIL_MISMATCH_PENALTY` 만큼 느리게 자라고 **그 값은 심는 순간
  `readyAt` 에 확정**된다. 토양은 수확마다 1회 닳아(`soilUsesLeft` ← `ItemDef.soil.uses`) 0 이면 칸이 비워진다.
  - 새 것: `Rules` 의 순수 규칙 6종 + `furnitureRefundCost` / `mergeCost`, `parts/Garden.ts` 전면 재작성
    (`getGrowSlots` · `fillSoil` · `clearSoil` · `plantSeedAt` · `harvestAt` · `harvestAllStation` · `getOwnedSoils` ·
    `openGrowStation`), `ui/GrowStation.ts`(좌 재배층 · 우 `createTradeGrids` 가방 + 창고, 드래그&드롭), `model` 의
    `ACTIVE_FURNITURE_DEFS`, `ShipState` **v4**.
  - 지운 것: `ui/GrowMenu.ts` (은퇴 가구의 패널) 와 `.hs-plots` / `.hs-plot` / `.hs-seed` 스타일.
  - 남긴 것: Phase 8 계약 6종은 **지우지 않고** 「없는 재배층」 응답으로 만들었다 (`getPlots` → `[]`, 변경자 →
    한국어 사유, `harvestAll` → 0, `openGrowMenu` → 아무 일 없음). `getOwnedSeeds` 는 새 화면도 쓰므로 그대로 살아 있다.
  - 마이그레이션: 로드할 때 배치 · 보관된 은퇴 가구를 전부 걷어내고 제작비 + 강화비를 **함선 창고**로 환불한다.
    `sanitize` 는 ctx 가 없으므로 금액만 계산하고(`SanitizeOutcome.refund`), `HousingSystem.flushRetiredRefund()` 가
    `ctx.inventory` 가 생긴 첫 프레임에 실제로 넣는다 — 창고가 차면 들어가는 만큼만 넣고 경고 토스트 + `console.warn`
    을 남긴다. 옛 `plots` 는 전부 버린다.

- **2026-09-11 (프로필 로드가 방금 한 편집을 되돌리던 것)** — `net:profileLoaded`(릴레이 welcome)가 편집 직후 350 ms 저장
  debounce 안에 도착하면 `onProfileLoaded` 가 `p.get('ship')` — 서버 사본이거나 **우리가 먼저 큐에 넣은 더 오래된 저장**
  (부팅 때의 fresh 상태) — 으로 상태를 갈아 끼우고 `store.cancel()` 로 대기 중인 저장까지 버려, **놓은 가구가 조용히
  사라졌다** (부하가 걸린 머신에서 `smoke-training` 의 시뮬레이션 허브가 0 메시 · 상호작용 없음으로 빨갛게 됐다. 릴레이
  수신을 붙잡아 두는 재현 스크립트로 확정). 이제 `changed()` 가 세우는 `editPending` 과 새 `ShipStore.isDirty` 가 둘 다
  참이면 로컬 편집이 가장 새 문서이므로(ProfileSync = newest wins) **그것을 곧바로 저장 · 업로드하고 교체하지 않는다.**
  부팅 fresh 저장만 대기 중일 때는 예전처럼 서버 사본을 받는다 (새 브라우저의 기존 플레이어). `smoke-housing` 에 단언 1개.

- **2026-09-11 (C-27 자동 배치 2차 패스 · C-7 스모크)** — `Rules.autoPlaceSpot` 이 1차(문 앞 여유 상자 밖)에서 자리를
  못 찾으면 2차로 상자 안의 자리를 받되, 놓은 뒤에도 문 폭 4칸 중 인접 2칸이 깊이 전부 비어 있어야 한다
  (새 export `doorPassageOpen`). `canPlaceAt` · `ShipState.sanitize` 는 그대로라 세이브는 소급해서 바뀌지 않는다.
  `scripts/smoke-housing.mjs`: 합성 `ShipState` 로 2차 패스 단언 3개(빈 방 = 1차 그대로 · 꽉 찬 방 = 구역 안 4개 후 통로
  2줄 남김 · 통로가 이미 막힌 방 = 자리 없음 + `canPlaceAt` 은 허용), 그리고 `openRoomMenu(5)` · `openRoomMenu(3)` 호출을
  `openShipManage(n)` 로 바꿨다 (C-7 — `openRoomMenu` · `openFacilityMenu` 는 `@deprecated`, 리다이렉트 단언 두 개는
  계약 보존 확인용으로 남겼다).

- **2026-09-10 (자동 가구 배치 방향 · 순서)** — 사용자 보고: 튜토리얼에서 자동 배치된 총기 작업대가 **오른쪽 벽을
  바라보고** 서서, 쓰려면 벽 사이로 끼어 들어가야 했다. 규칙이 `ui/hud/ShipManage.findFreeSpot` 안에 있었는데
  (`yaw 0` → `yaw 1`, `y` 바깥 × `x` 안쪽), 그건 **배치 규칙**이라 housing 이 가질 것이다. 새 `Rules.autoPlaceSpot`
  (+ `AUTO_PLACE_YAWS` · `doorClearanceCell` · `DOOR_CLEAR_DEPTH` / `SPAN`) → `parts/Furniture.findFreeSpot` →
  `HousingRef.findFreeSpot` (계약 **추가만**) 으로 옮기면서 순서를 **화면 좌측 상단부터 가로줄 먼저**
  (`x` 오름차순 × `y` 내림차순), 회전을 **화면 아래(yaw 1)** 로 바꿨고, 그 첫 자리가 우현 방(5…9)에서는 문 앞이라
  문을 막아 버리므로 **출입구 앞 상자를 비켜 가는 규칙**을 자동 배치에만 더했다. 자세한 근거는 위 `자동 배치` 절.
  `canPlaceAt` · 하우징 모드의 손 배치 · 저장된 `ShipState` 는 **한 줄도 바뀌지 않았다** (사용자가 돌려 놓은 회전과
  이미 놓인 가구는 그대로다 — 새로 자동 배치되는 것만 바뀐다). `ui/hud/ShipManage` 는 자기 루프를 지우고
  `ctx.housing.findFreeSpot` 을 부르기만 한다 (`FreeSpot.yaw` 를 `0|1` → `0|1|2|3` 으로 넓힌 것이 딸린 변경).
  튜토리얼(`benchPlace`)은 손댈 것이 없었다 — 스포트라이트는 `.sm-store .fcard[data-def-id=…]` 를, 바닥 안내선은
  `hub_furn_<uid>` 를 잡으므로 둘 다 자리 · 회전을 전제하지 않는다.

- **2026-09-10 (보조무기 제거)** — 프리셋 메뉴(`ui/PresetMenu`)의 행이 `주무기 I · 주무기 II · 가방 · 방탄복`
  넷이다. `LoadoutPreset.secondary` 필드와 `ShipState` 직렬화는 **그대로** 둔다 — 저장된 프리셋을 깨지 않는다
  (읽을 때 그 칸은 언제나 null 이 된다).

프로젝트 전체 이력은 [docs/HISTORY.md](../../docs/HISTORY.md) 에 있다.

- **2026-09-09 (키 가이드 · Tab 닫기)** — 계약 `ui:keyGuide` (`src/shared/events.ts`) 채택. ① `ui/Panel.ts` 의 capture
  keydown 이 **`Keys.INVENTORY`(Tab)** 도 닫기 키로 받는다 (E 와 같이 `stopImmediatePropagation` 이라 `Input` 이 누름을
  기록하지 않고 인벤토리가 열리지 않는다; E 와 달리 포커스된 입력 필드에서도 받는다 — Tab 으로 타이핑하는 글자는 없다).
  열릴 때 owner **`housing.<page>`** (`housing.bookshelf` · `housing.grow` · `housing.presets`) 로 `keys: []` 를,
  닫힐 때 `null` 을 보낸다 — 패널은 버튼만 있어 가이드에는 `Tab 닫기` 만 뜬다. ② `ui/ShipView.ts` — 시설 제거 확인
  카드와 시설 증축 팝업이 열려 있는 동안만 window capture Tab 리스너를 달아 **그 팝업을 먼저** 닫는다 (Tab 창은 남는다);
  `dispose()` 가 리스너를 거둔다. 시설 관리 모드 자체의 Tab 종료와 `'housing'` owner 는 `hub/HousingMode` 가 한다
  (규칙: 내부 팝업 → 모드 순으로 닫힌다)

- **2026-09-09 (수치 csv 이관)** — 가구 표가 `shared/housing.ts` 에서 `data/furniture.csv` +
  `data/furniture_upgrades.csv`(레벨별 강화 비용) 로, 방 용도 증축 비용이 `data/room_purposes.csv` 로 나갔다.
  시설(발전기 · 창고 · 작업실 · 사격장) 강화 비용은 `data/facility_upgrades.csv`, 시설 레벨 상한 · 보관함 행 수 ·
  프리셋 수 · 서재/온실 계수는 `data/constants.csv` 와 `data/tables.csv` 에 있다

- **Phase 7** — server `ship` document (`profile.set` on save, replace + `housing:loaded` on `net:profileLoaded`), `furn_sim_hub` in the 사격장 catalogue

- **Phase 8** — 온실 active — stackable 재배층 (`FurnitureDef.stackLimit` 4, `PlacedFurniture.layer`, top-layer-only recover) with real-time 재배 (`getPlots / plantSeed / harvestPlot / harvestAll / getOwnedSeeds / openGrowMenu`, `ui/GrowMenu`, epoch stamps from `ctx.net.serverNow()`), **함선 관리** (`shipManageMode / openShipManage / setManageRoom / closeShipManage`, `housing:shipManageChanged`), `createShipView(host)` for the 함선 tab, `lockCrewName()`, ship state **v2** (+ a free `furn_repair_bench`), costs via `renderItemCost`

- **Phase 8 UI pass** — the standalone `ui/RoomMenu` + `ui/FacilityMenu` are **deleted** (`openRoomMenu / openFacilityMenu` redirect to `openShipManage`), **방 1 = 작업실 forever** (`WORKSHOP_ROOM_INDEX`, enforced in `Rules.purposeChangeReason` + migrated in `ShipState.sanitize`, fresh ships start with the 총기 작업대 + 정비 벤치 already **placed** in it, displaced furniture goes to storage), `FacilityRows` takes the facility list (`기본 시설` = 발전기 · 창고 only), `ui/ShipView` is two columns + a sticky **시설 관리 (M)** button

- **Phase 9** — **서재 활성화** — `furn_bookshelf` (2×1, `BOOKS_PER_SHELF` 6) holds 서적 items (`ShipState.books` / `bookDex`, v3), `getBooks / placeBook / takeBook / getOwnedBooks / getBookBonus / getBookDex / openBookshelfMenu`, bonus `1 + BOOK_XP_PER_BOOK × Σ BOOK_RARITY_MUL` capped at `BOOK_GAIN_MAX` and folded into `getSkillGainMul`, recovering a shelf returns its books to the stash, `ui/BookshelfMenu` + `ui/BookDex` (도감 — 책장 패널 전용)

- **Phase 9 UI/UX 개선** — **시설 증축 비용** (`ROOM_PURPOSE_BUILD_COST`, 발전기 Lv.1 게이트, `Rules.purposeBuildCost / purposeBuildBlockReason`, `purposeCost`, `setRoomPurpose` 가 소모) 과 그만큼 늘어난 환급 (`Rules.roomRefundCost` = 증축 + 업그레이드), `ui/ShipView` 는 부제 삭제 · 패널 고정 (`is-ship`, 방 목록만 스크롤) · 빈 방마다 **시설 증축** 버튼 → 중앙 `.hs-build` 팝업. **Phase 9 UI pass**: `Rules.facilityRefundCost` + `facilityRefund / removeRoomFacility` (시설 제거: 가구는 가구 창고로, 업그레이드 재료는 함선 창고로, 창고가 차면 거부), `ui/dom.facilityThumb` (모든 시설 표시의 아이콘), `ui/ShipView` 재작성 — 도감 · 용도 드롭다운 · 방 번호 · 가구 수 · 설명 제거, 행은 썸네일 + 용도 + 레벨 + 업그레이드 + 빨간 🗑 제거(확인 카드), 빈 방도 같은 높이, 시설 관리(M) 버튼은 별도 하단 바(`.hs-ship-bar`); `FacilityRows` 설명문 제거

- **2026-09-07 (기본 작업실 폐지)** — `freshState()` 가 **빈 방 10개 · 가구 0**이 되고(무료 작업실 + 총기 작업대 + 정비 벤치 삭제), 작업실은 아무 방에나 지을 수 있는 보통 용도가 되었다 — `Rules.purposeChangeReason` 의 방 1 분기 삭제, `sanitize` 는 "시설 방은 종류당 하나"만 유지, `ui/ShipView` 의 잠금 표시(`is-locked` · `기본` 태그) 제거

- **Phase 12 (2026-09-08)** — 규칙 무변경 — "재료가 충분해 보이는데 증축이 안 됨"의 원인은 새 함선의 발전기 Lv.0 게이트가 **비활성 버튼의 tooltip 으로만** 표시된 것이었고(포인터 락 아래에서는 보이지 않는다), 수정은 `ui/hud/ShipManage`(발전기 행 + 확인 팝업) 쪽이다 — README 에 근본 원인을 적어 두었다

- **2026-09-08 (UI/UX)** — `LoadoutPreset.implantItems` (append-only, 임플란트 **아이템** def id 배열)를 프리셋이 함께 나른다: `parts/Presets.savePreset` 이 문자열만 남겨 최대 16개까지 복사하고(필드가 없으면 아예 넣지 않는다 — 빈 배열은 "전부 해제"라는 뜻이라 옛 경로가 실수로 만들면 안 된다), `ShipState.sanitize` 가 로드할 때 같은 규칙으로 걸러내며, `ui/PresetMenu` 가 카드에 `임플란트` 줄로 이름을 이어 붙인다. 전술 임플란트 줄은 `전술 임플란트` 로 이름이 바뀌었다. 실제 장착/해제는 `inventory.applyLoadout` 이 한다

- **2026-09-08 (튜토리얼 게이트)** — `parts/Rooms.purposeBlock` 과 `parts/Furniture.canCraftFurniture` / `place`
  가 맨 앞에서 `ctx.tutorial?.blockReason('roomPurpose' | 'furniture', id)` 를 본다. 튜토리얼이 도는 동안에는
  작업실과 총기 작업대만 허용되고, 사유는 기존 차단 문구 자리에 그대로 실린다. 규칙은 하나도 바뀌지 않았다 —
  튜토리얼이 없으면 이 호출은 언제나 null 이다


## 2026-09-08 — 하우징 패널은 E 로 닫는다

`ui/Panel.ts` (the shared shell of 재배 / 책장 / 프리셋) no longer captures Escape — Escape is the 일시정지 메뉴
everywhere now. It captures **`Keys.INTERACT` (E)** instead, the key that opened the panel from the furniture, and
ignores it while `MENU_BLOCKER` is up. Because the listener is capture-phase on `window` it runs *before* a focused
field's own handler, so it skips events whose target is an `<input>` / `<textarea>` — otherwise the E of a 프리셋
이름 would close the panel. `ui/PresetMenu`'s name field keeps `isolateInput`, but its Escape now only blurs.

함선 관리 mode itself is left with **M** (`hub/HousingMode`), not Escape.

### 2026-09-09 — ESC 닫기

`ui/Panel` 이 `openPanel()` 에서 `ctx.escape.push(BLOCKER, () => this.close())` 하고 `close()` 에서 `remove` 한다 —
하우징 패널(재배 · 서재 · 프리셋)이 E 외에 Tab · ESC 로도 닫힌다. E 캡처 리스너와 `PresetMenu` 이름 칸의
`isolateInput` 은 그대로다. 순서는 `shared/escape`(열린 순서의 역순), 정책은 `game/parts/Phases.escapeKey`.
