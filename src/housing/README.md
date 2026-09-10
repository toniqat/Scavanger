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
| `HousingSystem.ts` | The system + `HousingRef` implementation. Loads the state in the constructor (so `ctx.housing.state` is valid from `init`), emits `housing:loaded` and one `housing:stashSizeChanged` after load, owns housing-mode state (`housingMode / housingRoom / selectedFurniture / selectedYaw`). Every mutation (`setRoomPurpose`, `upgrade`, `place / move / recover`, `craftFurniture`, `upgradeFurniture`, `savePreset / deletePreset / applyPreset`) emits its own event **and** `housing:changed {reason}` and schedules a save. Helpers the panels use beyond the contract: `housingModeBlock(room)`, `purposeBlock(room, purpose)`, `furnitureUpgradeBlock(uid)`, `captureLoadout()`, `countDef`, `nameOf`. Closes panels + leaves housing mode on `game:newMission`, `game:abort`, `hub:left` and any phase change away from `hub`. Phase 7: `onProfileLoaded()` (`net:profileLoaded`) replaces the state with the server `ship` document (see Persistence). **Phase 8**: 함선 관리 state (`shipManageMode` / `openShipManage(room?)` / `setManageRoom` / `closeShipManage`, `shipManageBlock()`, `housing:shipManageChanged`), 온실 재배 (`getPlots / plantSeed / harvestPlot / harvestAll / getOwnedSeeds / openGrowMenu`, `nowMs()` = `ctx.net.serverNow() ?? Date.now()`), stack layers in `place / move / recover` (+ `recoverBlock(uid)`), `defOf(defId)` for the cost chips and `createShipView(host)` (delegates to `ui/ShipView.ts`). **Phase 9**: 서재 책장 — `getBooks / placeBook / takeBook / getOwnedBooks / getBookBonus / getBookDex / openBookshelfMenu`, the private helpers behind them (`books()` prunes ids `ctx.loot` no longer knows, `shelfOf / booksOf / bookAt / dropBooksOf / stashBooksOf / booksBlock / freeStashCells`), `getSkillGainMul` = 사격장 × 서재, and the 책장-aware `recoverBlock` / `purposeBlock('empty')` (`BOOKS_BLOCK_REASON` = `책을 먼저 빼세요`). |
| `model.ts` | 폴더 공용 어휘 — `HousingSystem` 에서 떼어낸 상수 · 타입 · 스크래치. 클래스를 참조하지 않으므로 `parts/*` 가 순환 import 없이 쓴다. `HousingSystem.ts` 가 재수출하므로 기존 import 경로는 그대로다 |
| `parts/Rooms.ts` | **방 용도와 시설 레벨**. 빈 방에 용도를 주는 것이 **시설 증축**(재료 소모, 발전기 Lv.1 게이트, 함선당 하나)이고, 그 뒤로는 레벨을 올린다. 제거하면 가구는 가구 창고로, 업그레이드 재료는 함선 창고로 전액 돌아온다. 규칙 자체는 `Rules.ts` 가 갖고, 여기서는 그 규칙에 따라 재료를 소모하고 상태를 쓴다. |
| `parts/Furniture.ts` | **가구 배치 · 제작 · 회수**와 시설 관리 모드. 가구는 **아이템이 아니다** — 가구 창고에만 존재하고 거기서 제작된다. 배치 규칙(방 용도에 맞는가, 겹치지 않는가, 쌓을 수 있는가)과 시설 관리 모드의 커서 상태가 여기 있다. |
| `parts/Garden.ts` | **온실 재배** (Phase 8). 쌓을 수 있는 재배층에 씨앗을 심으면 `ctx.net.serverNow()` 기준 **실제 시간** 1–6 시간 뒤에 여문다 (레이드 중에도 자란다). 시계는 서버가 검증하지 않으므로 오프라인 프로필은 로컬 시계를 믿는다. |
| `parts/Library.ts` | **서재 책장** (Phase 9). 숙련도마다 책이 하나씩 있고, 책장에 꽂으면 그 숙련도의 XP 배율이 오른다(상한 있음). 책은 **함선 단위**이지 캐릭터 단위가 아니며, 도감은 **꽂아 본 적 있는** 책만 기록한다. |
| `parts/Presets.ts` | **로드아웃 프리셋** (사격장의 관물대). 저장은 `inventory.captureLoadout`, 적용은 `applyLoadout` 을 그대로 부른다 — 여기서 하는 일은 사격장 레벨이 정한 개수만큼 슬롯을 관리하는 것뿐이다. |
| `Rules.ts` | Pure functions, no ctx / DOM: `facilityLevel / facilityMaxLevel / nextFacilityCost / facilityBlockReason` (order: max → room → generator gate → materials), `missingIngredients`, `formatCost`, `stashSizeFor`, `presetCountFor`, `craftCostMulFor`, `skillGainMulFor`, `purposeChangeReason` (`lab` needs a greenhouse; **작업실 / 사격장 at most one per ship** — their facility level lives on that room, `facilityPurposeOf`), `furnitureAllowedIn`, `insideGrid`, `furnitureAtCell`, `canPlaceAt` (purpose or `'any'` + inside `ROOM_GRID_COLS × ROWS` after `furnitureFootprint` + no overlap, `ignoreUid` for moves), `nextFurnitureCost`, `furnitureUpgradeReason`; **Phase 9** `bookWeightOf(def)` (a book's `BOOK_RARITY_MUL[rarity]`, 0 for a non-book) and `bookGainMulFor(skill, books, defOf)` (the 서재 multiplier). **Phase 8 stacking**: `stackLimitOf(def)`, `layerOf(item)`, `stackMembers(state, room, def, x, y, yaw, ignoreUid?)`, `nextFreeLayer(members, limit)`, `topLayer(members)`, `recoverBlockReason(state, item)`; `canPlaceAt` lets a `stackLimit > 1` def share its footprint with the **same** def at the same cell + yaw while the stack is below its limit (everything else keeps the strict no-overlap rule), and `furnitureAtCell` now returns the **top** layer. Callbacks `CountFn` / `NameFn` stand in for inventory and item names. **2026-09-10 자동 배치**: `AUTO_PLACE_YAWS` · `DOOR_CLEAR_DEPTH` / `DOOR_CLEAR_SPAN` · `doorClearanceCell(room)` · `autoPlaceSpot(state, room, def)` → `FurniturePlacement | null` — 「화면 좌측 상단부터 가로줄 먼저, 가구는 화면 아래를 향한다(yaw 1), 출입구 앞은 비운다」 (아래 `자동 배치` 절). |
| `ShipState.ts` | `freshState()` (**2026-09-07: ten empty rooms and no furniture** — the built-in 작업실 with its 총기 작업대 + 정비 벤치 is gone; generator 0, storage 0, empty furniture storage, no presets, `plots: []`, `nameLocked: false`), `sanitize(raw)` (clamps levels, drops unknown defs / purposes, keeps **at most one facility room of each kind** and moves furniture whose room no longer accepts it into furniture storage, a `lab` without a greenhouse becomes `empty`, every placed piece must pass `canPlaceAt` against the pieces accepted before it, duplicate / malformed uids are re-minted after the highest valid one), `loadState()`, `writeState()`, `ShipStore` (350 ms debounce, `pagehide` / `beforeunload` flush, try/catch around localStorage; Phase 7: `flush()` also `upload()` = `ctx.net.profile.set('ship', state)` when a profile is available, `cancel()` drops a pending write). Key `SHIP_STORAGE_KEY` (`scav.ship`), version **`SHIP_STATE_VERSION_CURRENT` = 3** (Phase 9 — `Math.max(3, SHIP_STATE_VERSION)`; the contract's `SHIP_STATE_VERSION` is 3 now, so the two agree again). Phase 8 also sanitises `plots` (rack must still exist, slot < `GROW_PLOTS_PER_RACK`, one plot per (uid, slot), usable timestamps), re-assigns stack `layer`s (persisted layer kept when free, else the lowest free one; a full stack drops the piece) and runs the **v1 → v2 정비 벤치 grant** (one `furn_repair_bench` Lv.1 into the furniture storage, skipped when the ship already owns one anywhere — a v2 save never runs it again). `isGrowRackDefId(defId)`. **Phase 9 (v3)**: `freshState()` gains empty `books` / `bookDex`; `sanitize` keeps a `PlacedBook` only when its 책장 uid is still placed, its slot is `< BOOKS_PER_SHELF`, the (uid, slot) pair is free and the def id has the `book_*` shape (`isBookDefIdShape` — whether it still resolves to a real 서적 is a runtime check in `HousingSystem.books()`), and rebuilds the 도감 as a unique list of `book_*` ids that always contains every shelved book. `isBookshelfDefId(defId)` (`interaction === 'bookshelf'`). `ShipStore.upload()` dropped its `available` guard: it calls `profile.set('ship', …)` **offline too** and `ProfileSync` queues it (newest-wins on the next connection). |
| `ui/Panel.ts` | `HousingPanel` base for the three menus: `.menu.housing-menu` root under `ctx.uiRoot`, blocker token **`'housing'`** added first and then the **in-game cursor** (`ctx.input.setCursorMode(true, 'housing')` — Phase 10: the pointer lock is *kept*, so there is no `exitPointerLock()` and no microtask re-lock; `close()` releases both), **`Keys.INTERACT` (E)** through a capture-phase `window` keydown listener (registered only while open, `stopImmediatePropagation` so `Input` never sees it) — 2026-09-08: **was Escape**, which is the 일시정지 메뉴 everywhere now; E is the key that opened the panel from the furniture. Ignored while `MENU_BLOCKER` is up, and skipped when the event target is an `<input>` / `<textarea>` (capture runs before the field's own handler, so the E of a 프리셋 이름 would otherwise close the panel), `ui:housingToggled {open, page}` (the 재배 and 책장 pages report `page: null` — the contract's page union is frozen — and carry `ui:growToggled` / `ui:bookshelfToggled` instead). **2026-09-09**: **Tab (`Keys.INVENTORY`) closes them too** (taken even from a focused field), and each panel is a 키 가이드 owner `housing.<page>` with `keys: []` (`ui:keyGuide`). Auto-refresh on `housing:changed`, `inventory:changed`, `inventory:stashChanged`. |
| `ui/PresetMenu.ts` | 프리셋 메뉴 (`openPresetMenu()`): one card per slot (`getPresetCount()`), name field (`change` renames), 현재 장비 저장 (`captureLoadout` + name), 적용 (result line `장착 n · 없음: …`), 삭제. Refresh is skipped while a name field has focus. |
| `ui/GrowMenu.ts` | **재배 패널** (Phase 8, `openGrowMenu(uid)` ← E on a 재배층): `GROW_PLOTS_PER_RACK` plot cards (progress bar, 남은 시간, 수확), a seed picker built from `getOwnedSeeds()` with `buildItemChip` (click = select, click again = deselect), 심기 / 수확 / footer 모두 수확 `(n)`. Ticks once a second while open (`paint()` only repaints text / bar / buttons; the timers live in `ShipState.plots`). Emits `ui:growToggled {open, uid}`; on the `ui:housingToggled` wire it reports `page: null` (the contract's page union is frozen). |
| `ui/BookshelfMenu.ts` | **책장 패널** (Phase 9, `openBookshelfMenu(uid)` ← E on a 서재 책장): `BOOKS_PER_SHELF` slot cards (item chip, the skill the book teaches and its weight, 꽂기 / 빼기), a picker of the books the player owns (`getOwnedBooks()` = bag + stash, `buildItemChip` with the count; click = select, click again = deselect) and the 도감 below it. Every rule lives in `HousingSystem.placeBook / takeBook` — the panel only shows their 한국어 refusals. Emits `ui:bookshelfToggled {open, uid}`, `page: null` on the `ui:housingToggled` wire. |
| `ui/BookDex.ts` | `createBookDex(ctx, housing, host)` → `BookDexView {root, refresh()}`: the **도감**, one row per skill in `SKILL_IDS` order — 한국어 skill name (`ctx.progression.getSkillDef`), the book that teaches it (`ItemDef.book.skill`, chip + title), 보유 / 미보유 from `housing.getBookDex()` and the live 서재 multiplier from `housing.getBookBonus(skill)`. Pure DOM into `host`: no blocker, no listeners — the owner (책장 panel, 함선 tab) calls `refresh()` on its own events. |
| `ui/FacilityRows.ts` | The 시설 rows + 효과 summary renderer used by `ShipView` (embedded 함선 tab): level, pips, `renderCost` chips, 한국어 block reason, upgrade button, derived summary. Takes the facility ids to list and the section label (**Phase 8 UI pass**: the 함선 tab passes `['generator','storage']` under 기본 시설 — 작업실 / 사격장 are room facilities and are upgraded from their row in the 방 목록). Touches only the host element it is handed — **no blocker, no pointer lock, no window listener**. |
| `ui/ShipView.ts` | `createShipView(ctx, housing, host)` → `EmbeddedView` for the **함선 tab** of the inventory Tab screen. **Phase 8 UI pass layout**: two columns — left `FacilityRows(['generator','storage'], '기본 시설')` + 효과 summary, right the 방 목록 (10 rows: `방 n · 용도`, 가구 n개 + purpose description, a `<select>` purpose picker whose options are disabled from `purposeBlock`, and for a 작업실 / 사격장 room its facility level, cost chips, block reason and 업그레이드 button) — plus a **sticky 시설 관리 (M)** button in the bottom-right corner (`.hs-ship-foot`, `position: sticky`) that calls `ctx.inventory.closeAll()` and then `housing.openShipManage()`. Its own inline `.form-msg`, refreshes on `housing:changed` / `inventory:changed` / `inventory:stashChanged` / `input:bindingsChanged`, `dispose()` unsubscribes and empties the host. Adds **no** ui blocker, never exits the pointer lock, installs **no** Escape listener — the inventory window owns all three. **2026-09-09**: while the 제거 confirm / 증축 popup is up, a capture-phase **Tab** listener closes that popup first (the window stays), removed when both are hidden and in `dispose()`. |
| `ui/dom.ts` | `el / section / setText / toggleClass / clear / isolateInput`, `renderCost` (Phase 8: delegates to `renderItemCost` from `@/shared` — thumbnail + 보유/필요 chips, dimmed + red when short; sizes `CHIP_SIZE` 32 / `CHIP_SIZE_SMALL` 28), `levelText`, `formatRemaining` (`2시간 5분` / `12분 30초` / `45초`). |
| `housing.css` | Panel styles (`.hs-*`, Phase 9 adds `.hs-shelf` / `.hs-book` / `.hs-books` / `.hs-bookpick` and the shared `.hs-dex*` 도감 rows), reusing `.menu .frame .ui-btn .ui-input .ui-label .form-msg` from `ui/styles/base.css`; same scrolling-page layout as `hub/hub.css`. |
| `index.ts` | Re-exports `HousingSystem`, the rules and the state helpers. |

## Rules (single source of truth — `Rules.ts`)
- **Generator gate**: every facility / bench upgrade needs `generatorLevel ≥ target level`; the generator itself is ungated. Ship-wide tables (`GENERATOR/STORAGE_UPGRADE_COST[level]`) start at level 1; room tables (`WORKSHOP/RANGE_UPGRADE_COST[level − 1]`) start at level 2 because level 1 comes free with the purpose.
- **Storage** level → `getStashSize()` = `STASH_COLS × STASH_ROWS_BY_STORAGE_LEVEL[level]`; `housing:stashSizeChanged` once after load and whenever the level changes.
- **Workshop / range** levels live on the (first) room of that purpose (`RoomState.level`); no room → level 0 → `FacilityInfo.blocked` = "… 용도의 방이 필요합니다". `getCraftCostMul()` = `max(0.5, 1 − 0.1 × (workshopLevel − 1))`; `getSkillGainMul(gun_*)` = `1 + 0.1 × rangeLevel`; `getPresetCount()` = `PRESETS_BY_RANGE_LEVEL[rangeLevel]`.
- **Purposes**: `setRoomPurpose` refuses `lab` without a greenhouse elsewhere and any purpose while purpose-bound furniture of another purpose is still placed (`'any'` pieces stay); `empty` recovers every piece; same purpose = no-op `true`; removing the last greenhouse resets labs to `empty`. New purpose → level 1, `empty` → 0.
- **작업실 (2026-09-07)**: the Phase 8 UI pass locked a free 작업실 to room 1 (`WORKSHOP_ROOM_INDEX`) with both benches already placed. That is **gone**: a new ship is ten 빈 방 with no furniture, and the 작업실 is an ordinary purpose — buildable in **any** room for `ROOM_PURPOSE_BUILD_COST` behind the 발전기 Lv.1 gate, one per ship like the 사격장 (`facilityPurposeOf`), removable through 시설 제거. The 총기 작업대 and the 정비 벤치 are crafted like any other furniture. `WORKSHOP_ROOM_INDEX` still exists in the contract (append-only) but nothing reads it; `sanitize()` keeps only the "one facility room per kind" rule and still moves furniture whose room no longer accepts it into **furniture storage** instead of dropping it.
- **Furniture**: `place` needs a `StoredFurniture` entry (highest level first) and `canPlace`; uid `f-<n>` continues after the highest persisted uid. `recover` keeps the level. `craftFurniture` → level 1 in storage. `upgradeFurniture` uses `def.upgradeCost[level − 1]` behind the generator gate. `getBenchLevel(kind)` = highest placed bench of that kind. `selectFurniture` ignores defs that are not in storage; `null` clears. **`furn_sim_hub` 시뮬레이션 허브** (Phase 7, `FURNITURE_DEFS` in `shared/housing.ts`: 사격장 only, 2×2, 폐금속 8 + 케이블 2 + 회로 2, `interaction 'sim_hub'`) is plain data here — it appears in `getFurnitureFor('range')`, the room menu's 가구 제작 / 가구 창고 lists and is crafted / placed like every other piece; hub/ draws the model and turns E on it into the training-arena entry. Furniture is never an inventory item (it lives only in `furnitureStorage`).
- **Server profile (Phase 7)**: every flush mirrors the state into the `ship` profile document. `net:profileLoaded` → when the server has a `ship` document it is `sanitize`d and **replaces** the state (panels + housing mode closed first, pending local write cancelled, uid counter re-seeded, localStorage rewritten as the cache, not re-uploaded), then `housing:loaded {state}` + `housing:changed {reason:'profile'}` fire so hub/ rebuilds the personal ship, and `housing:stashSizeChanged` follows when the storage level differs; no document → the local state is uploaded.
- **Presets**: `savePreset(index)` only for `index < getPresetCount()`; `applyPreset` only in phase `hub` and only when `inventory.applyLoadout` exists → `housing:presetApplied`.
- **Housing mode**: `enterHousingMode(room)` only in phase `hub` on the personal ship (`ctx.hub.ship === 'personal'`); and only while `ctx.hub.currentRoom === room` (corridor / cockpit = null → `방 n 안에서만 꾸밀 수 있습니다`). Since the Phase 8 UI pass nothing in the game calls it — 시설 관리 (`openShipManage`) is the only entry point — but the gate is kept for API users. Adds **no** ui blocker (hub intercepts input); closes the panels first; `exitHousingMode` resets selection + yaw. The panels open with `exitHousingMode()` so mode and menu never overlap.
- Materials: `countDefAll / consumeDefAll` are guarded with `typeof` (0 / refused when missing); the whole cost is verified before the first `consumeDefAll` call.
- **Stacking (Phase 8)**: `FurnitureDef.stackLimit > 1` (only `furn_grow_rack`, limit 4) lets copies of the same def share one footprint, each on its own `PlacedFurniture.layer` (0 = deck; hub/ lifts layer n by `GROW_RACK_LAYER_HEIGHT`). A stack is homogeneous — same defId, same `x`/`y`, same `yaw`; anything else overlapping is still refused. `place` takes the lowest free layer, `move` requires the piece to be on top and re-seats it on the target stack's lowest free layer, `recover` refuses anything but the top layer (`위층 … 을(를) 먼저 회수하세요`, surfaced by `recoverBlock(uid)` and the 방 메뉴's 회수 button). `setRoomPurpose('empty')` recovers top-down.
- **온실 재배 (Phase 8)**: `ShipState.plots`, `GROW_PLOTS_PER_RACK` (4) per 재배층. `plantSeed` resolves the seed through `ctx.loot.getItemDef` (`ItemDef.seed` required), consumes 1 with `consumeDefAll`, and stamps `plantedAt = ctx.net.serverNow?.() ?? Date.now()` + `readyAt = plantedAt + growHours × 3600e3 × (1 − GROW_SKILL_SPEEDUP × 원예 / SKILL_LEVEL_MAX)` — computed **once**, so a later skill change never moves a running timer and the crop keeps growing while the game is closed. `harvestPlot` creates `yieldQty × derived.gatherYieldMul` (≥ 1) of `seed.yieldDefId`, places it with `tryAddItemAnywhere` (bag → stash; refuses with `가방과 창고에 자리가 없습니다` and keeps the plot), emits `gather:collected {nodeId: 'grow:<uid>:<slot>'}` (that is what raises the 원예 skill) and `housing:growChanged {uid, ready}`. Recovering a 재배층 drops its plots. Every 한국어 failure reason is the method's return value.
- **함선 관리 (Phase 8)**: `openShipManage(room?)` = housing mode **without** the room-presence gate (only phase `hub` + personal ship, `shipManageBlock()`); the room defaults to `ctx.hub.currentRoom`, else the first room with a purpose, else room 1. `setManageRoom` retargets it, `closeShipManage` (and any `exitHousingMode`) leaves both and emits `housing:shipManageChanged {active:false, room:null}`. hub/ drives the camera off that event; `enterHousingMode` keeps its old room-local gate for API users.
- **서재 책장 (Phase 9)**: `ShipState.books` holds one `PlacedBook {uid, slot, defId}` per filled shelf slot (`BOOKS_PER_SHELF` = 6 per 책장, `furn_bookshelf`, 서재 room, 2×1, 폐금속 6 + 합금판 1). `placeBook(uid, slot, defId)` works only in phase `hub`, on a real 책장, into a free slot, with a book the player owns — it consumes 1 through `consumeDefAll` (**bag first, then stash**) and adds the id to the 도감 (`bookDex`, append-only: a book that was ever shelved stays listed even after it leaves). `takeBook(uid, slot)` re-creates the item and places it with `tryAddItemAnywhere` (bag → stash, refused with `공간 없음 …`). Both return `null` on success and a 한국어 reason otherwise, and emit `housing:booksChanged {uid, count}` + `housing:changed`. **Bonus**: `getBookBonus(skill)` = `min(BOOK_GAIN_MAX 2.0, 1 + BOOK_XP_PER_BOOK 0.05 × Σ BOOK_RARITY_MUL[rarity])` over **every** shelved book of that skill on the ship (any shelf, any room; weights common 1 / uncommon 1.5 / rare 2.5 / epic 4 / legendary 6 — so one epic book = ×1.20, and the cap needs Σ 20). It is multiplied into `getSkillGainMul` next to the 사격장 factor, so progression/ keeps reading exactly one number. `getOwnedBooks()` lists owned books in `SKILL_IDS` order; `getBookDex()` is the 도감 list.
- **Recovering a 책장**: `recover(uid)` first hands its books to the **stash** (`stashBooksOf`, all-or-nothing — a partial move is rolled back with `takeItem`); when they do not fit, nothing moves and the refusal is `책을 먼저 빼세요` (`BOOKS_BLOCK_REASON`). `recoverBlock(uid)` and `purposeBlock(room, 'empty')` (which recovers everything) report the same reason ahead of the click, using a cheap free-stash-cell estimate (`freeStashCells`; unknown → let `recover` try for real).
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
  실패 처리는 그대로 `null` → 호출부의 `자리 없음` 이다. **한계**: 출입구 여유 때문에 손으로는 아직 놓을 수 있는
  방이 자동 배치에서는 `자리 없음` 이 될 수 있다 (그 경우 하우징 모드에서 직접 놓으면 된다).

- **Removed panels (Phase 8 UI pass)**: `openRoomMenu(room)` and `openFacilityMenu()` are still on `HousingRef` but now **redirect to `openShipManage(room?)`** — the standalone 방 메뉴 / 시설 메뉴 (and the 시설 메뉴's 프리셋 button) are gone. Loadout presets are reached only through the **관물대** (`furn_range_console`, renamed from 사격장 콘솔, model `locker`) placed in a 사격장 room.

## Verification
`node scripts/smoke-housing.mjs` (**151 checks**, 0 console errors, 2026-09-06 — Phase 7 added the 15th def `furn_sim_hub` in the 사격장 catalogue only, its craft (회로 −2) / `canPlace` (workshop refused, range allowed) / place `f-5` / room-menu rows, and the server `ship` document through a fake `ctx.net.profile`: `profile.set('ship')` on save, no document → upload, `net:profileLoaded` replace → room 8 kitchen / storage 2 → 36 rows / crate `f-90` / uid `f-91` next / `housing:loaded` + `housing:changed {profile}` / cache updated without echo; the relay socket is parked so a relay on 8787 cannot interfere). Earlier coverage: fresh state + first-run bench, `hub:enter`, lab refused / workshop assigned / events, `canPlace` bounds · rotation · purpose · overlap, place → `f-1`, move (+ ignoreUid), recover (level kept) → re-place `f-2`, purpose change refused while a bench is placed, 40 폐금속 via `tryAddItem`, generator 0→1→2 (케이블), storage 1 → rows 30 mirrored by `inventory.getStashSize()`, workshop gated → unblocked → level 2 → cost ×0.9, 한국어 block reasons, furniture craft (stacking, refused when short), bench Lv2 + Lv3 gated, range room → 3 presets, skill ×1.1, save / refuse index 3 / apply (`{equipped: 4, missing: []}`) / delete, target lane, lounge keeps an `'any'` locker and `empty` recovers it, gym + greenhouse + lab, housing mode + selection + rotation, three panels (DOM contents, 7 badges, red materials, blocked click → message, Esc + blocker, 닫기, single-blocker switching, `closeMenus`), reload persistence (rooms / levels / furniture / storage / preset / stash 30 / uid `f-5`), corrupt save sanitised (lab → empty, generator clamped to 5, bad room / purpose / overlap / duplicate uid handled).
Registered in `scripts/verify.mjs` (`smoke-housing`, folders housing / hub / inventory / progression).
**Phase 8 changes the smoke's expectations**: a fresh state now holds **two** furniture-storage entries (총기 작업대 + 정비 벤치), only **6** purposes carry the 다음 업데이트 badge (온실 is active), cost lines are `.item-chip` elements instead of `.mat` spans, and there are new cases to add — 재배층 stacking (4 layers on one footprint, 5th refused, only the top recovers), 온실 plots (plant → progress → harvest → `gather:collected`), 함선 관리 (`openShipManage` outside the room, `setManageRoom`, `housing:shipManageChanged`), `createShipView` (renders, adds no blocker, disposes clean) and the v1 → v2 정비 벤치 grant.

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
- **`getSkillGainMul` = 사격장 × 서재** — the only number progression/ reads (it was not changed).
- **Offline profile saves** — `ShipStore.upload()` no longer checks `profile.available`; `ProfileSync` queues the
  document and the newest stamp wins on the next connection (Phase 9 contract).

## Known follow-ups
- `housing:loaded` fires inside `init()`, before later systems subscribe — consumers should read `ctx.housing.state` directly in their own init (the event only reaches systems registered earlier). The Phase 7 re-emit on `net:profileLoaded` does reach everyone; hub/ must rebuild the personal ship on it (also while the player stands inside — furniture may vanish under them).
- `ROOM_PURPOSES_ACTIVE` gates nothing beyond the badge: the seven inactive purposes accept `'any'` furniture only (no purpose-bound defs exist for them yet).
- Facility levels of workshop / range are read from the *first* room of that purpose; a second workshop room is decorative.
- The preset name field saves on `change` (blur / Enter); Esc **blurs the field** without saving the edit (2026-09-08: it no longer closes the panel — E does).
- Hydroponics / kitchen / lab mechanics and a buy-only path (`craft: null`) are not wired — `craftFurniture` refuses non-craftable defs. Furniture is by design not an inventory item (`ItemDef.furnitureId` stays unused).
- The server `ship` document is uploaded whole on every save (no delta); two clients on the same token overwrite each other last-writer-wins.
- **Phase 8**: `SHIP_STATE_VERSION` in `src/shared/constants.ts` was still `1` back then, so housing/ wrote its own
  `SHIP_STATE_VERSION_CURRENT`; Phase 9 bumped the contract to `3` and the two agree again (the local `Math.max` stays
  as the guard). `GrowPlot` has no per-plot fertiliser / soil quality and a plot keeps growing even if the room later loses its
  온실 purpose (only recovering the rack drops it). Growth uses the relay clock when connected and the local clock
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
