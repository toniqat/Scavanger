# src/inventory — Diablo-2 grid inventory (`ctx.inventory`)

`InventorySystem` owns the player's bag grid (size = equipped bag), the four equipment slots (주무기 I / 주무기 II / 보조무기 / 가방), the eight **quick-use wheel slots** and the currently open loot container. It publishes `ctx.inventory` (itself) and `ctx.loot` (`LootService` from `@/items`). Weapon package (2026-09-05): 3 weapon slots, bag-sized grids, sockets, ammo v2, unload, repair, and a reset policy that lets worn weapons survive a completed mission. Phase 2 (2026-09-06): quick-use slots (`QuickSlots.ts`, rose panel, `consumeItem`) and the `player:respawn` starter reset. **Phase 7** (2026-09-06): Tarkov-style **container search** (items hidden until 감정), **host-authoritative container takes** in multiplayer, `canFit`, `captureRaidState` / `applyRaidState`, and the **server profile** mirror of the stash / loadout saves — see the last section. **Phase 10** (2026-09-07): live container loot sync (`container:itemTaken`, tile vanish animation, `cont taken.rem / seq`), the read-only **분대원 장비 뷰**, credits as `n C` everywhere and the in-game software cursor instead of releasing the pointer lock — see the last section. **Phase 8** (2026-09-06): the hub Tab window **hosts** the 캐릭터 / 기업 / 함선 screens as embedded views, the 전술 임플란트 picker · 필드 제작 · 새 **아이템 분해** dialog became **modeless popups**, every material requirement is an `@/shared` item chip, and the credits pill reads `CREDITS 500` — see the last section.

| File | Purpose |
|---|---|
| `Grid.ts` | Pure occupancy grid: `canPlace/blockersAt/place/remove/moveTo/rotate/findFreeSlot/autoPlace/mergeIntoStacks/mergeInto/canAbsorb/totalValue`, plus **`resize(cols, rows, priority?)`** (in-bounds items keep their cells, the rest are `autoPlace`d largest-first, what does not fit is returned; `priority` entries are placed first, at their hint cell when possible), **`snapshot()` / `restore()`** for all-or-nothing attempts. `cols`/`rows` are getters (mutated only by resize/restore). Rotation swaps the footprint; `rotate()` tries in place, then nearby offsets. `version` counter drives UI diffing |
| `Sockets.ts` | Pure socket bookkeeping on `ItemInstance.sockets`: `socketOf(def)`, `socketContent`, `attachedItems`, `filledSocketCount`, `setSocket` (returns the previous attachment), `clearSocket`, `clearAllSockets`, `findSocketed(weapons, uid)`. No events, no compatibility checks (those live in the system via `LootRef.canAttach`) |
| `QuickSlots.ts` | Pure quick-use wheel bookkeeping on a `QuickSlotUids` array (length `QUICK_SLOTS`, index = wheel direction, values = bag item uids): `createQuickSlots`, `isQuickUsable(def)` (`QUICK_USABLE_CATEGORIES`), `isQuickIndex`, `quickSlotOf`, `firstFreeQuickSlot(slots, active)`, `assignQuickSlot` (one slot per uid — moves), `clearQuickSlotOf`, `relinkQuickSlot(from, to)` (slot follows a surviving stack), `pruneQuickSlots(has)` (item left the bag), `autoAssignQuickSlots` (starter policy), `quickSlotsSignature` (change detection). No events, no grid access |
| `QuickSwap.ts` | **2026-09-10 — 퀵슬롯 1:1 교체에서 밀려난 스택이 갈 자리.** 순수 규칙 두 개뿐이다: `canQuickSwap(plan)` (아무것도 바꾸지 않는다 — `previewDrop` 의 하이라이트)와 `applyQuickSwap(plan)` (실제로 놓는다 — `setQuickSlot`). 순서는 **출발지가 가방인가**로 갈린다 — `가방 → 휠` 은 **① 비운 바로 그 칸 → ② 가방 아무 데나**, `상자 · 창고 → 휠` 은 **① 가방 → ② 비운 그 칸(= 그 컨테이너의 빈 자리) → ③ 출발 격자 아무 데나**. 컨테이너에서 올 때 가방이 먼저인 것은 의도한 것이다: 가방에 자리가 **있을 때**의 동작(= 늘 가방으로)은 한 줄도 바꾸지 않는다 — 이 파일이 고치는 것은 자리가 **없을 때** 통째로 거절되던 쪽이다. 어디에도 못 놓으면 `null` 이라 호출자가 통째로 거절한다(격자는 하나도 바뀌지 않는다). `allowSource: false` = 멀티플레이의 **공유 상자** — 내 물건을 넣을 수 없으므로 ①③을 건너뛴다. 격자 두 개(가방 · 출발)만 알고 `InventorySystem` 도 이벤트도 모른다 |
| `Serialize.ts` | **Phase 5**: item (de)serialisation shared by the stash and the loadout save — `SavedExtras` (`defId / qty / durability / ammoInMag / sockets` recursive) + `SavedPlacement` (`+ rotated / x / y`), `serializeExtras` / `serializePlacement`, `reviveItem(sv, getDef, loot, tag)` (fresh instance via `LootRef.createItem`, clamps, unknown def → null + warning), `savedCell`, `safeStorage` / `readSaveFile` / `writeSaveFile` (every localStorage access in try/catch). **Never carries `searched`** (Phase 7): a saved / dropped item is always searched |
| `Stash.ts` | **함선 창고** (2026-09-06): `STASH_COLS × STASH_ROWS` (10×24) `Grid` by default, persisted in localStorage `scav.stash` (positions + `durability` / `ammoInMag` / nested `sockets` through `Serialize.ts`; uids are re-minted on load, unknown defs dropped with a warning, overlapping cells auto-placed). **Phase 6**: the save (v2) also carries `cols` / `rows` (v1 files migrate to the default size; a corrupt size is ignored, cap 40×200) and `resize(cols, rows)` grows the grid in place / refuses a shrink while any item would fall outside. `markDirty()` debounces a save 350 ms after a change, `flush()` on pagehide / dispose. Survives missions, deaths and reloads — the bag / loadout have their own save + reset policy (`Loadout.ts`). **Phase 7**: `onSaved(file)` hook after every write (→ `ctx.net.profile.set('stash', …)`), `saveFile()`, `Stash.isSaveFile(doc)`, `loadFrom(doc)` replaces the contents with a server document (`StashSaveFile`) and rewrites the local file without echoing it back. **2026-09-07**: also the home of the 기본 지급품 flag — `STARTER_GRANT_KEY` (`scav.grant`) + `starterGrantState()` / `setStarterGrantState()` (`none` / `pending` / `done`), deliberately **outside** the stash file so a server document replacing the stash cannot make the grant repeat; `firstRun` is now only about whether that grant uploads as a `fresh` document |
| `Loadout.ts` | **Phase 5 loadout persistence**: `LoadoutSave` v1 (`slots` by `LoadoutSlot` as `SavedExtras`, `bag` as `SavedPlacement[]`, `quick` = bag index per wheel direction), `loadLoadoutSave()` (sanitised, null when missing / corrupt), **`sanitizeLoadoutSave(obj)`** (Phase 7: the same sanitiser for a server document / raid state; extra per-entry fields such as `searched` pass through), `isEmptyLoadoutSave`, and `LoadoutStore` — the system hands it a `capture()` callback; `markDirty(reason)` debounces 350 ms (first reason of a burst wins), `saveNow(reason)` writes unconditionally, `flush()` on pagehide / beforeunload / dispose; every write calls `onSaved(reason, file)` (the system emits `inventory:loadoutSaved {reason}` and mirrors the file to the server profile). Key `LOADOUT_STORAGE_KEY` (`scav.loadout`) |
| `Container.ts` | `Container` (6×4 grid + world position + `tier` + optional `title`; `fill(items)` auto-places largest-first, overflow dropped with a `console.warn`) and `ContainerStore` cache keyed by container id: `getOrCreate(id, tier, …)` rolls `ctx.loot.rollCrate(tier, Random(seed ^ hash(id)))` on first open; `getOrCreateWithItems(id, items, position, title?, size?)` places caller-supplied contents (corpses; `tier` 0, `title` default `CONTAINER_DEFAULT_TITLE` = `컨테이너`) on first open and ignores `items` for a known id. **2026-09-09**: `Container` 생성자와 `getOrCreateWithItems` 가 격자 크기를 받는다 (기본 6×4 그대로; 플레이어 유해는 `PLAYER_CORPSE_COLS × PLAYER_CORPSE_ROWS`). 만들어진 뒤에는 여전히 resize 하지 않는다. **Phase 7**: `fill` marks every item `searched: false` and appends it to **`order`** (uids in roll order = the wire `idx`, never shrinks); `indexOf / uidAt / remainingAt`; **`taken`** (idx → units removed from this copy through the authoritative channel), `applyTaken(idx, qty)` / `recordTaken`, `takenWire()`; search state `searchProgress` (uid → seconds), `nextToSearch()` (first unsearched in grid order), `placementsInSearchOrder`, `unsearchedCount`, `searchDoneEmitted`. `ContainerStore`: `pendingTaken` for takes confirmed before a container was opened here (applied on its first open), `recordPending / pendingTakenOf`, `takenWire()` (opened + pending) and `applySync(items)` for `cont sync`, `all()`. **Phase 10**: `nextTakeSeq / acceptTakeSeq / resetTakeSeq` (the `cont taken.seq` counter + duplicate filter) and the `onTaken` hook that reports a catch-up removal (`applyPending` / `applySync`) as `container:itemTaken {live: false}` |
| `InventorySystem.ts` | `GameSystem` + `InventoryRef`. **Phase 7** (see the last section): `updateSearch` (per-frame reveal loop), `isItemLocked`, `unsearchedCount`, `guardedTake / requestTake / trackTake / announceTake`, `pendingTakeUids`, `onContainerMessage / onContainerRequest / requestContainerSync / materializeCrate`, `canFit`, `captureRaidState / applyRaidState` (`RaidInventoryState`), `uploadProfileDoc / onProfileLoaded` (Phase 9: `withFreshSave` instead of the removed `offlineDocs` queue), `takeOne`, `checkLootedFor`; `OpResult` gained `'pending'`. Event wiring, Tab/Escape/R/X handling, auto-close (> 6 m from crate, death, phase change), reset policy, and all mutations used by the UI: `drop`, `previewDrop`, `dropPartial`, `previewPartial`, `previewAttach`, `attachFrom`, `quickMove`, `activate` (double-click), `equipTargetFor`, `rotateItem`, `takeAll`, `registerQuick`, `quickIndexOf`, plus the contract methods (`dropItem`, `splitItem`, `getBagSize`, `findItem`, `updateItem`, `attachToWeapon`, `detachAllSockets`, `unloadWeapon`, `repairWeapon`, `equip`, `getQuickSlots`, `setQuickSlot`, `getQuickSlotCount`, `consumeItem`, `openContainerItems`) and the quick-chat `requestItem`. **Phase 6** (see the sections below): `openCatalog / closeCatalog / isCatalogOpen` + `catalogQty / previewCatalog / dropFromCatalog / takeFromCatalog`, `getStashSize / setStashSize`, `countDefAll / consumeDefAll`, `captureLoadout / applyLoadout`, `openBenchCraft / getBench / closeBench / getBenchRecipes / benchRepairRows / benchRepairAll`, `getRecipes(station, bench?, level?)`, `craftCostMul / craftCost`. **2026-09-07**: `nearestFreeSpot(uid, from, gridId, x, y, rotated)` — the free footprint closest to a cell, used by the drag UI for equipment-slot drops that land on an occupied cell. **Phase 5**: loadout persistence (`captureLoadoutSave / restoreLoadoutSave / announceLoaded`, see below), `findItemAnywhere / tryAddToStash / tryAddItemAnywhere / takeItem` (contract, corp shop), `inventory:containerOpened` from `openContainer / openContainerItems`, `relockLater()`. **Phase 8**: `disassembleRecipeFor(uid)` + `openDisassemble(uid)` and the module-level `isDisassembleRecipe(r)` (`break_*` rows are filtered out of `getBenchRecipes()` but still craftable); `openCharacter()` / `openCorp()` are **gone** — the tabs build embedded views inside the window instead. **Phase 10**: `emitItemTaken` (the single `container:itemTaken` emitter, live vs. catch-up), `rem` / `seq` on `cont taken`, `captureCrewLoadout / createCrewLoadoutView`, and `setOpen` running the software cursor instead of releasing the pointer lock (`relockLater` removed). `locate(uid)` finds an item in bag → container → slots. Exports the UI vocabulary (`GridId`, `SlotId` = `LoadoutSlot`, `LOADOUT_SLOTS`, `WEAPON_SLOT_IDS`, `slotAccepts`, `ItemLocation`, `DropTarget` incl. `{kind:'weapon'}` / `{kind:'quick', index}`, `OpResult`, `DropPreview`, `BagSize`, `ActiveBench`, `BenchRecipeRow`, `BenchRepairRow`) |
| `model.ts` | **2026-09-12**: `LOADOUT_SLOTS` 순서가 곧 장비칸 배치다 — `primary · armor · primary2 · bag · pouch` (두 열: 주무기 I ∣ 방탄복 / 주무기 II ∣ 가방 / 전술 임플란트 ∣ 주머니). 폴더 공용 어휘 — `GridId`(2026-09-11: += `'pouch'`) / `ItemLocation` / `DropTarget` / `OpResult` / `slotAccepts` / `isPouchDef` · `pouchAcceptsDef` 등 타입 · 상수 · 순수 술어. 상태도 DOM 도 없다. `InventorySystem.ts` 가 `export *` 로 재수출하므로 기존 import 경로는 그대로다. **2026-09-10**: `RepairCostRow` · `RepairInfo`(우클릭 `수리` readout, `bucket` 은 제작 재료 규칙으로 값이 나왔을 때만 채워진다) 가 붙었고 `BenchRepairRow` 에 `bucket: DurabilityBucketInfo` 가 추가됐다 |
| `parts/Lifecycle.ts` | **세이브 · 기본 지급품 · 미션 리셋.** `InventorySystem` 에서 떼어낸 함수들이다. 인스턴스를 첫 인자 `sys` 로 받고, 클래스에는 같은 이름의 한 줄 위임 메서드가 남아 있으므로 **호출부는 전부 그대로**다. 여기가 답하는 질문은 하나다 — *레이드가 시작 · 종료 · 실패할 때 플레이어의 장비에 무슨 일이 일어나는가.* 규칙 전문은 폴더 README 의 `Reset policy` 절에 있다. |
| `parts/DropResolver.ts` | **2026-09-12 (사용자 결정)**: ① `canSocketAt` — **창고 안 총기에도 부착물이 끼워진다** (`locKind` 의 뜻은 그대로 두고 부착 경로에서만 `'stash'` 를 허용한다. 상자 · 시체는 계속 거부). 소켓이 바뀌면 그 무기가 든 격자의 `version` 을 올리고(`bumpWeaponGrid`), 빠진 부착물은 가방 → 창고 → 바닥 순으로 간다(`stowDetached`). ② **창고 더블클릭 = 빈 자리로 곧장** — `tryAutoPlace`(빈 장비칸 → 임플란트 칸 → 빈 퀵슬롯)를 **가방보다 먼저** 본다. 차 있으면 예전처럼 가방, 가방도 꽉 차면 `activateFallback`(같은 함수, 문구만 다르다). 상자 · 시체는 2026-09-10 그대로. **드래그 앤 드롭 판정.** UI 가 묻는 두 가지 질문에만 답한다 — *여기 놓으면 어떻게 되나* (`preview*`, 타일 하이라이트 색)와 *실제로 놓아라* (`drop` / `quickMove` / `activate` / `rotateItem` / `attachFrom`). 스왑 · 병합 · 장비칸 · 퀵슬롯 · 소켓 · 부분 수량(Shift/Ctrl 드래그)이 전부 이 파일의 규칙이고, DOM 은 하나도 없다. |
| `parts/StashOps.ts` | **함선 창고를 함께 보는 연산.** 가방 하나만 보는 연산(`countDef` 등)은 클래스에 남아 있고, 여기 있는 것은 전부 **가방 + 창고**를 하나의 보관 공간으로 취급한다: 재료 집계 · 소모, 로드아웃 프리셋 저장/적용, 창고로 이동, 어디든 넣기, 공간 확인. 창고는 함선에서만 존재하므로 레이드 중에는 이 함수들이 가방만 본다. |
| `parts/Crafting.ts` | **2026-09-12**: `switchBench(kind \| null, level)` — 열려 있는 제작 열 안에서 작업대만 갈아 끼운다 (창을 열지도 닫지도 않는다; `null` = 빠른제작). `benchRepairRows` 는 **작업대 종류를 보지 않는다** — 정비 벤치가 은퇴해 "함선이면 재료만 갖다 바치면 수리"가 규칙이 됐으므로 무기 · 방탄복 · 가방 전부이고 레이드 중에는 빈 배열이다. **제작 · 분해 · 작업대.** 필드 제작(`제작` 열)과 함선 작업대(`openBenchCraft`)는 같은 규칙을 쓰고 재료 출처만 다르다: 레이드에서는 가방만, 함선에서는 가방 + 함선 창고(`countDefAll` / `consumeDefAll`). 분해(`break_*`)는 제작 목록이 아니라 아이템 우클릭에서 열리며 진행 게이지를 `inventory:disassembleProgress` 로 흘린다. **2026-09-10 (제작 대개편 2단계)**: 분해 산출이 **남은 내구도**를 탄다 — `resolveRecipe(sys, r, targetUid)` 가 `ctx.loot.getSalvageFor(inst)` 로 레시피를 다시 풀고, `disassembleRecipeFor`(미리보기) · `craftHasRoom(id, count, targetUid)`(자리 검사) · `updateCraft`(실제 소비 · 산출) 셋이 **같은 레시피**를 본다. `getAllRecipes()` 에 실린 줄은 구간 4(81~100 %) 기준이라 그대로 쓰면 다 망가진 총도 새 총만큼 뱉는다. id 는 그대로이므로 `craft()` 의 게이트(`availableRecipes` 동일성 · `canCraft`)는 바뀌지 않는다. `benchRepairRows` 의 재료는 `parts/Durability.repairMaterials` 를 지나므로 **방탄복 줄에도 재료가 뜬다** |
| `parts/Durability.ts` | **2026-09-12**: `detachAllSockets` 의 대상이 `canSocketAt`(`parts/DropResolver`) 로 바뀌어 **함선 창고 총기**도 소켓을 뽑을 수 있고, 넘치는 부착물은 가방 → 창고 → 바닥이다. **내구도 · 수리 · 소켓.** 무기와 방어구가 닳고(`damageDurability`), 재료로 고쳐지고(`repair` / `repairWeapon`), 부착물이 붙고 떨어지는(`attachToWeapon` / `detachAllSockets`) 경로. 회복 스프레이의 게이지 충전도 여기 있다 (`sprayRepairCost` — 남은 게이지 비율만큼만 재료를 받는다). **2026-09-10**: 수리 재료를 정하는 곳이 **`repairMaterials(sys, item, def)` 하나**가 됐다 — `LootRef.getRepairCost` 를 먼저 보고 비었을 때만 `sprayRepairCost` 로 내려간다. 예전 삼항(`getEffectiveStats ? getRepairCost : sprayRepairCost`)은 무기일 때만 `getRepairCost` 를 물어서 **방탄복이 재료 없이 만피로 복구**됐다. `repairInfo` 는 `bucket`(남은 내구도 구간)을 함께 돌려준다. **2026-09-11**: ① `wearBagForRaid` — 장착 가방이 레이드당 한 번 `BAG_DURABILITY_PER_RAID` 닳는다(탈출 성공 `game:complete` · 사망 `stripForCorpse` 중 먼저 온 쪽, `bagWornThisRaid` 는 `world:ready` 에서 내린다, 훈련장 제외, `durability:broken` 없음 — 0 이어도 효과 없음). ② 수리비가 비었는데 `needsRepairCost(def)`(`@/items` — 내구도 + 제작 레시피)면 `repair` · `repairInfo` · 작업대 수리 목록이 **거절**한다 (무료 수리 구멍 차단) |
| `parts/LaunchCheck.ts` | **출격 준비 점검** (2026-09-08). `getLaunchWarnings()` 의 규칙 — 주무기 없음 · 장착 무기 구경별 탄약이 한 세트(`AMMO_STACK_ROUNDS`, 중량탄 25발) 미만 · 가방 없음 · 방탄복 없음 · 전술 임플란트 없음 · 가방에 회복 아이템(`category: 'stim'`, **2026-09-10 부터 실드 충전기는 제외** — 체력을 채우지 않는다) 없음. 읽기만 하고 아무것도 막지 않는다 — 결과를 그리는 건 `hub/ui/LaunchWarnPanel`. |
| `parts/ContainerNet.ts` | **컨테이너 획득의 호스트 권한 경로 (Phase 7).** 싱글 플레이에서 상자에서 아이템을 집으면 즉시 반영되지만, 멀티에서는 호스트가 심판이다: 클라이언트는 `contq take` 를 보내고 `cont taken` / `cont denied` 를 기다린다 (`OpResult` 의 `'pending'`). 이 파일이 그 대기열(`pendingTakes`) · 타임아웃 · 호스트 측 검증 · 다른 대원의 획득 반영을 전부 갖는다. |
| `parts/ProfileDocs.ts` | **서버 프로필 문서 · 레이드 세션 상태.** 창고(`stash`)와 로드아웃(`loadout`)을 릴레이의 프로필 저장소에 올리고 내려받는 경로, 그리고 레이드 도중 끊긴 플레이어가 복귀할 때 쓰는 `captureRaidState` / `applyRaidState` 가 여기 있다. 오프라인 편집이 서버의 빈 문서에 지워지지 않게 하는 규칙(`fresh` 저장)도 이 파일의 책임이다. |
| `parts/CorpseLoot.ts` | **죽으면 들고 있던 것이 전부 시체로 간다** (2026-09-09). `stripForCorpse()` 가 장비 슬롯 · 가방 격자 · 퀵슬롯을 하나의 목록으로 뽑고 로컬 인벤토리를 **빈손**으로 만든다 (무기의 내구도 · 장전 탄약 · 소켓은 `ItemInstance` 채로 넘어가므로 보존된다). `openContainerItemsSized()` 는 `openContainerItems` 와 같지만 격자 크기를 지정한다 (`PLAYER_CORPSE_COLS × PLAYER_CORPSE_ROWS`). **2026-09-11**: 장착 임플란트의 **망가진 짝**(`ctx.progression.stripImplantsForCorpse?.()`, 옵셔널 — 없으면 빈 배열)을 목록 끝에 합치고(C-12), 뽑기 전에 장착 가방을 레이드 1회분 닳게 한다(C-36, `wearBagForRaid`). 시체 격자는 `fitCorpseGrid(items, cols, rows)` 가 **그 순서 그대로 전부 들어가도록 행을 늘린다** — 예전에는 넘치는 것이 `Container.fill` 의 경고 한 줄과 함께 사라졌다. `hookCorpseWire()` 는 `pcorpse` 를 구독해 시체 컨테이너를 **열지 않고 미리 만들어 둔다** — 호스트는 자기가 한 번도 열어 본 적 없는 시체의 `contq take` 도 심판해야 하기 때문이다. 가져가기 자체는 상자와 똑같이 기존 `cont` / `contq` 경로다. |
| `parts/Pouch.ts` | **주머니는 가방 격자가 아니다** (2026-09-11, A-15). 장비칸 `pouch` **한 칸**(`POUCH_SLOTS` = 1)에 끼운 주머니가 여는 별도 격자의 전부 — `getEquippedPouch` · `getPouchSize`(주머니가 없으면 `{0,0}`) · `pouchAccepts`(`PouchDef.accepts`) · `pouchItems` / `pouchTotalValue` · `pouchSignature` + `emitPouchChanged`(`inventory:pouchChanged`, `quickSlotsSignature` 와 같은 게이트) · `resetPouchGrid` / `drainPouch`(킷 리셋 · 시체) · **`changePouch(next, from, oldTo, hint?, dest?)`**. `changeBag` 이 본보기이지만 거절 규칙이 하나 더 있다: 새 주머니가 못 받는(또는 자리가 없는) 내용물은 가방으로 가고, **하나라도 못 들어가면 전부 되돌리고 이동 자체를 거절한다** (`setQuickSlot` 이 세운 "휠 아이템을 조용히 버리지 않는다" 그대로 — 주머니 안의 물건도 바닥에 흘리지 않는다). 격자가 없을 때의 내부 `Grid` 는 1×1 이고 `getPouchSize()` 가 `{0,0}` 으로 "그리지 마라" 를 말한다 |
| `parts/Sort.ts` | **가방 · 창고 자동 정렬** (2026-09-12). `sortGrid(sys, 'bag' \| 'stash', keep?)` — 카테고리(`SORT_CATEGORY_ORDER`) → 등급(높은 것 먼저) → 크기(큰 것 먼저) → 이름 → 수량. 같은 아이템 스택을 `stackMax` 까지 합치고(`keep` uid 는 합치지 않는다 — 기업 거래 트레이가 uid 로 들고 있다) 위에서부터 줄 단위로 채운다. 카테고리 순서로 다 안 들어가면 크기 순으로 한 번 더, 그래도 안 되면 `snapshot()` 으로 **정렬 전 그대로** 되돌리고 `'fail'` (합친 수량까지 복원) — 아이템을 절대 잃지 않는다. 창고는 함선에서만. `compareForSort` 는 순서 자체 |
| `parts/Catalog.ts` | **무한 상자 (개발자 카탈로그, Phase 6).** `/items` 콘솔 명령이 여는 치트 창이다. 다른 그리드와 달리 원본이 줄지 않고 드래그마다 **새 인스턴스**를 만든다 (`dropFromCatalog` / `takeFromCatalog`). 훈련장의 무기 거치대도 카테고리를 지정해 이 창을 연다. |
| `ui/model.ts` | 인벤토리 창의 공용 어휘 (타입 · 상수). `ui/InventoryUI.ts` 가 재수출한다 |
| `ui/parts/Drag.ts` | **아이템 끌어 놓기.** 누름 판정 → 고스트 생성 → 커서 추적 → 대상 격자/칸 판정 → 놓기 까지의 포인터 상태 기계 전부. 어떤 칸에 놓을 수 있는지는 여기서 정하지 않는다 — `inventory/parts/DropResolver.ts` 에 물어보고 그 답(`ok` / `swap` / `merge` / `bad`)을 하이라이트 색으로 그릴 뿐이다. 고스트는 커서 **중앙**에 붙고, 확대는 CSS `scale:` 이 아니라 `positionGhost` 의 transform 안에 있다 (개별 변환은 translate → scale 순이라 JS 가 쓴 translate 가 곱해져 커서에서 벌어졌다). |
| `ui/parts/ContextMenu.ts` | **우클릭 메뉴 · 수량 분할 · 버리기.** 아이템마다 무엇을 할 수 있는지(장착 · 수리 · 분해 · 장전 탄약 탈착 · 소켓 탈착 · 창고로 이동 · 버리기 · 채팅에 올리기)를 한곳에서 정한다. 실제 동작은 전부 `ctx.inventory` 를 부르고, 이 파일은 **어떤 항목을 보여줄지**만 결정한다. |
| `ui/parts/Screens.ts` | **Tab 창의 화면 탭과 부속 열.** 함선에서 Tab 은 인벤토리 / 캐릭터 / 기업 / 함선 네 화면을 한 창 안에서 전환한다 (각 화면은 그 폴더가 준 `EmbeddedView` 라서 이 파일은 붙였다 뗐다만 한다). 제작 열과 무한 상자 카탈로그의 열고 닫기도 여기 있다. **2026-09-09**: `setTab` 이 탭마다 `sys.emitGuide()` 로 키 가이드 줄을 갱신하고, `setCraftOpen` 이 `'inventory.craft'` owner (`1초 홀드 제작`) 를 열고 닫는다. |
| `ui/parts/SlotPanel.ts` | **장비 칸 (주무기 I / II · 보조무기 · 가방 · 방탄복).** 칸 다섯 개의 DOM 을 만들고 아이템 타일을 그린다. 무엇이 어느 칸에 들어갈 수 있는지는 `model.ts` 의 `slotAccepts` 가 정하고, 여기서는 그림과 포인터 바인딩만 맡는다. |
| `ui/parts/QuickPanel.ts` | **빠른 사용 나침반 로제트.** 가방이 정한 개수만큼 8방향 칸을 열어 주고(잠긴 칸은 회색), 각 칸에 가방 아이템의 uid 를 물린다. 드래그로 채우고 우클릭으로 비운다. |
| `ui/InventoryUI.ts` | DOM layout under `ctx.uiRoot` (**Phase 7**: `.inv-search-status` readout in the container header, `setSearchProgress(uid, p, active)` / `refreshSearchStatus()` / `shakeItem(uid, loc)`; an unsearched tile (`sys.isItemLocked`) gets no tooltip, press / drag, context menu, double-click or middle-click request; `result()` treats `'pending'` as silent): container panel (left), bag (center, width follows the grid columns; **quick-slot rose** under the grid), equipment column (right: 4 slots), hint bar, world-drop zone. Drag & drop with live ghost + valid/invalid/swap/merge highlight, **attachment → weapon tile drag** (socket target lit green/red via `previewAttach`), **stim/grenade → wheel cell drag**, cell → cell / cell → out drags, Shift/Ctrl partial drags, R to rotate, right-click quick action / context menu, middle-click request, X drop, double-click equip/move/register, "모두 가져가기", tooltip, shake on refusal, `audio:play` sfx. **Phase 6**: hosts the `CatalogView` (leftmost panel) and drives **catalog drags** (`DragState.catalog`: a fresh instance per press, targets = equipment slots + active grids only, `previewCatalog` / `dropFromCatalog`, no world drop, no wheel; double press within 400 ms = `takeFromCatalog`), `setCatalog(open)`, `setCraftOpen(open)` for bench mode. **Phase 8**: screen tabs 인벤토리 / 캐릭터 / 기업 / 함선 (`setTab` / `screenTab`, `.scr-tabs` hidden outside hub mode) swap `.inv-layout` for the `.inv-screen` host and build `ctx.progression.createSheetView` / `ctx.meta.createCorpView` / `ctx.housing.createShipView` into it (`refresh()` on show, `dispose()` on leave); the `.inv-modeless-layer` holds the modeless popups, `closeCraft()`, `openDisassemble(uid)`, `canDisassemble`, `disassemblePanel`; the 수리 context entry renders `renderItemCost` chips. **2026-09-07**: 제작 left the modeless layer and is a column of `.inv-layout` again (`.is-craft`, `.inv-col-right`), and `showScreenTab(tab)` backs `InventorySystem.openScreen`. **2026-09-07 (안정화)**: the hint bar and the world-drop zone share one fixed-height `.inv-footer` (the swap at drag start used to re-centre the whole window), and `resolveGridTarget()` resolves a drag's grid **strictly first** — a grid that actually contains the pointer beats one that only sits inside its half-cell tolerance, so 가방 and 함선 창고 (stacked with a gap) stop stealing each other's edge rows. An **equipment slot → grid** drop whose exact cell is blocked now retargets to `sys.nearestFreeSpot` (highlight included) instead of snapping the weapon back into its slot with a shake; grid → grid keeps the strict Diablo rule. **2026-09-07 (2)**: `positionGhost` writes the ghost's 1.04 size lift into its own `transform` — as the standalone `scale:` property it was applied *before* the `transform` (CSS order: translate → rotate → scale → transform), which multiplied the translate and drew the item 42 px right of the cursor at x = 1080, further out the wider the window; the picture and the in-game cursor visibly came apart mid-drag |
| `ui/GridTools.ts` | **2026-09-12** — 가방 · 창고 머리의 `정렬` 버튼(`buildSortButton`)과 필터 칩 줄(`buildFilterChips` → `{ el, set(id) }`, 칩 = `FILTER_GROUPS` 의 글리프 + `title`). Tab 인벤토리와 `TradeGrids` 가 같은 DOM · 같은 클래스(`.inv-filters` · `.inv-filter-chip` · `.inv-sort-btn`)를 쓴다. 상태 없음. **칩은 한 줄에 균등 분할된 가로로 긴 사각형**이고 칸 수는 CSS 에 없다 — `--inv-filter-n` 으로 건네는 `FILTER_GROUPS.length` 하나가 원본이다 |
| `ui/TradeGrids.ts` | 다른 폴더 화면(기업 거래 · 재배 스테이션 · 분석기 · 배양조 · 식탁)에 끼우는 **진짜 가방 / 함선 창고 격자** — 읽기 + 끌어내기 전용(`onTake`). **2026-09-12 (2차, 사용자 결정)**: 기본 순서가 `['stash','bag']` 이고 `.tg-scroll` 이 **가로 2열**이다 — **창고 왼쪽 · 가방 오른쪽**, 폭이 모자라면 `flex-wrap` 이 가방을 아랫줄로 내린다(끼어드는 화면마다 열 폭이 달라 뷰포트 미디어 쿼리로 추측하지 않는다 — 다만 **세로가 되면 한 스크롤 안에서 둘 중 하나가 화면 밖으로 나가므로**, 그걸 감당 못 하는 화면은 스스로 해결한다: 가구 화면은 `.hs-inv` 에서 블록마다 자기 스크롤을 준다). 격자마다 **감싸는 상자 `.tg-gridwrap`** 이 하나 있다 — 기본값에서는 아무 일도 하지 않고, 세로 스크롤을 걸 화면이 그것을 쓴다(격자 자신은 폭이 px 로 못박혀 있어 스크롤바가 마지막 열을 갉아먹는다). `GridView.setClip` 도 그 상자를 가리킨다. 탄약 사선 띠도 여기서 갱신한다(`setNeededAmmoFrom`). **2026-09-12 (1차)**: 가방과 창고가 **한 스크롤**(`.tg-scroll`) 안에 붙는다(가방 5칸 · 틀 `BAG_FRAME_ROWS` / 창고 10칸), 칩 줄(`.tg-tools`)은 스크롤 밖 맨 위, 블록 머리마다 `정렬`(`sortGrid(id, isStaged)` — 이 뷰가 인벤토리를 바꾸는 유일한 동작), 블록에 `data-tg-grid="bag" \| "stash"`. 드래그는 pointermove 를 **rAF 한 번**으로 합쳐 고스트를 `transform` 으로 옮기고(크기는 집을 때 계산 — 이동 중 `offsetWidth` 를 읽지 않는다) `elementFromPoint` 도 프레임당 한 번, 고스트에 `filter` 없음. 버스 이벤트는 rAF 하나로 합쳐 갱신하고 `refresh()` 는 버전 게이트(바뀐 타일만 다시 그린다) + 타일 플래그(`is-staged` · `data-item-tip`)만 훑는다 |
| `ui/ContextMenu.ts` | Cursor-anchored right-click menu (`MenuEntry[]`), closes on selection / outside pointerdown / Escape / hide |
| `ui/SplitDialog.ts` | "수량 지정" modal: number input + slider over 1..qty-1, 확인/취소, Enter/Escape. **2026-09-09**: `onToggle(open)` constructor callback — the window turns it into the `'inventory.split'` 키 가이드 owner (`Enter 확인`); Tab closes it first (`closePopups`) |
| `ui/GridView.ts` | **2026-09-12 (사용자 결정)**: **내게 필요한 탄약에만 우상단 사선 띠.** `buildTileContent` 는 격자 · 장비칸 · 고스트 · 카탈로그 · 거래 화면이 함께 쓰는 순수 함수라 로드아웃을 모르므로, "지금 필요한 탄종"만 이 모듈이 들고(`setNeededAmmoFrom(loadout, getStats)` → 바뀔 때만 true, `isNeededAmmo(def)`) 타일에 `.is-ammo-needed` 를 건다. 갱신하는 곳은 `InventoryUI.refresh` 와 `TradeGrids.refresh` 둘. `tileSignature` 에 그 상태가 들어가므로 **무기를 바꾸면 탄약 타일이 다시 그려진다**. Renders one `Grid`: cell layer (rebuilt by `syncDims` whenever the grid's cols/rows change — bag swap, stash resize), uid-diffed absolutely positioned tiles, highlight rect, `markSplitSource()` for partial drags, `setSocketTarget()`, `setQuickBadges(uid → glyph)` (forces a re-render when the set changes); `buildTileContent(el, item, def, w, h, stats?)` shared with slots, wheel cells, catalog tiles and the ghost — weapons get five socket pips + a durability bar; `addQuickBadge(el, glyph)` adds the wheel-direction badge. **Phase 7**: `isHiddenItem(item)` (`searched === false`) → `buildTileContent` renders the **footprint mask** (`.inv-tile.rarity-hidden.is-hidden-item`, `?` icon, `???` name, no rarity class / colour / qty / pips / bar / badge); `setScan(uid | null, progress)` keeps the `.inv-tile-scan` gauge (`--p` 0..100 %) on the item being searched across re-renders; `setPending(uids)` pulses tiles whose take awaits the host. **Phase 10**: `vanish(uid)` — the next `refresh()` that no longer finds the item animates the tile out (`.is-vanishing`, `translate:` / `scale:` / `opacity` only) instead of removing it on the spot, and a removed tile's `scan` state is cleared right away. **2026-09-07**: `hitTest(px, py, pad)` + `hitPad`, and `cellForGhost(..., pad)` takes the tolerance as an argument so `InventoryUI` can run a strict pass before the padded one. **2026-09-09**: `setHideItem(pred | null)` — items the predicate accepts are **not drawn at all** (no tile → no hover, no drag, no menu) while staying in the grid data; the 함선 창고 view passes `ctx.tutorial.hides('stashItem', defId)`, and because a grid's `version` does not move when the 단계 does, `InventoryUI` forces `stashView.refresh(true)` on `tutorial:changed`. **2026-09-11 (C-60)**: `setClip(el)` — the scroll viewport the grid sits in; while that viewport really overflows, `hitTest` is trimmed to the visible rows (and a clipped edge loses its tolerance), so rows scrolled out of sight are not a drop target. Cell math still reads the grid's own `getBoundingClientRect` (it already carries the scroll offset — nothing is cached) |
| `ui/CatalogView.ts` | **무한 상자** panel (Phase 6): category tabs (`CATALOG_TABS`, derived from `ItemCategory`: 전체 / 무기 / 탄약 / 부착물 / 가방 / 방탄복 / 가젯 / 소모품 / 재료 / 약초 / **씨앗** (Phase 8) / **서적** (Phase 9) / 가구 — a tab without defs is dropped), search box (Korean substring on the name, plus the id; key events stop at the field so the game's `Input` never sees them), one uniform 2×2 tile per `ItemDef` from `ctx.loot.getAllItemDefs()` with a caption, a scrolling grid, `닫기`. Tiles are built once and re-appended on filter; `CatalogHandlers` hand press / hover / close to the window. `tileEl(defId)`, `shake`, `setTab`, **`setTabForCategory(cat)`** (Phase 9: picks the built tab whose `categories` include `cat`, false when there is none), `setQuery`, `visibleCount` for tests |
| `ui/CraftPanel.ts` | **2026-09-12 (사용자 결정, 4열 개편)**: 패널이 가로 두 열이다 — **`.inv-craft-benches`(세로 작업대 리스트) + `.inv-craft-main`(머리 + 제작품 목록)**. 리스트 항목은 맨 위 `빠른제작`(`station: 'field'`) + **이 함선에 실제로 설치된** 작업대(`ctx.housing.getBenchLevel > 0`, `WORKBENCH_KINDS` 순서) + **지금 열고 들어온** 작업대(`getBench()` — 제목과 리스트의 원본을 하나로 묶는다)뿐이고 누르면 그 자리에서 `InventoryRef.switchBench` 로 갈아 끼운다(창은 안 닫힌다). 2026-09-10 의 가로 탭(`.inv-craft-tabs`)과 `전체` 탭은 **없어졌다**. 제작품 목록은 고정 높이 + 세로 스크롤(창고 격자와 같은 식). `모두 수리` 는 **함선이면 언제나** 뜬다(레이드 중에만 숨는다) — 정비 벤치 은퇴. Hold-to-craft panel (`제작` button, or a 작업실 bench). **Bench mode** (Phase 6, `sys.getBench()`): eyebrow `WORKSHOP BENCH`, title `WORKBENCH_LABEL_KO[kind] Lv.n`, rows from `sys.getBenchRecipes()` (locked rows `is-bench-locked` with a `작업대 Lv.n 필요` tag and no button), material chips from `sys.craftCost` (workshop discount, `작업실 할인 −n %` chip), a `닫기` button (`sys.closeBench`) and — **2026-09-08** — a `모두 수리` button left of it (`.inv-repair-open`, gun / gear benches only) that opens `ui/RepairPanel`. Same cost readout as `hub/ui/WorkbenchMenu.ts` (copied, not imported). **Phase 8**: material costs are `renderItemCost` item chips from `@/shared`, the `닫기` button is always shown (bench → `closeBench`, otherwise the window's `onClose`), and the `break_*` 분해 rows are gone from the list. **2026-09-08**: the hold is `CRAFT_HOLD_TIME` (1 s) for every recipe, the `2.0 s` 시간 칩 is gone, and the repair list that used to sit under the recipes moved into the popup. **2026-09-09 (제작 UI 2차)**: a row is about the **thing being made** — a **산출물 썸네일** drawn with `buildTileContent` at the grid's own `CELL` (`.inv-craft-thumb`, so a 4×2 소총 is a 4×2 tile; `data-item-tip` + `data-def-id` give it the shared `ui/hud/ItemTip` hover card; a non-stacking output made in twos gets an `.inv-craft-thumb-qty` badge), the title is `산출물 이름 ×n` where `n` is what **one** craft makes (so the title never moves; the recipe name is gone), the `.inv-craft-desc` line is **removed**, and a **제작 수량** stepper (`.inv-craft-count`: `◀` `.inv-craft-count-v` `▶`, wheel over it steps too, non-passive so the list does not scroll) sits above the hold button reading the **total units the hold will make** — 경량탄 30 · 60 · 90 (사용자 결정: "몇 발 나오나"이지 "몇 번 도나"가 아니다), stepped by `outputQty` and capped by `sys.maxCraftCount(id)`. The material chips scale with it, and one hold makes `outputQty × count`. **2026-09-10 — 만들 수 있는 것이 위로** (`applySort`, `paint()` 안에서 돈다): `!locked && canCraft(id, 1)` 인 줄이 먼저 오고 그 안에서는 **원래 순서(csv 순서)를 유지**한다(안정 정렬). 숙련도는 애초에 `getRecipes` 가 걸러 목록에 없고 작업대 레벨은 `locked` 이므로 볼 것은 그 하나뿐이다 — 스테퍼(◀▶)에 걸린 수량이나 `craftHasRoom` 은 보지 **않는다**(수량을 올렸다고 줄이 내려가면 그 줄을 놓치고, 가방이 찬 것은 레시피의 성질이 아니다). 재료를 넣고 빼면 `afterChange` → `InventoryUI.refresh` → `paint` 로 정렬이 곧바로 따라오고, `sortSig` 가 같으면 DOM 을 건드리지 않는다. **홀드 중에는 줄을 움직이지 않는다** — 누르고 있는 버튼의 DOM 을 옮기면 `pointerleave` 로 읽혀 제작이 취소된다. 정렬만 바뀌었고 필터 · 숨김은 그대로다. **2026-09-10 — 작업대 탭 + 홀드 중 최소 갱신**: 레시피가 48 → 94 줄로 늘고 다섯 번째 작업대(**정제 작업대**)가 생기면서 함선의 `제작` 패널 한 목록이 읽히지 않게 됐다. `.inv-craft-tabs` 가 `전체` · 작업대 다섯(`WORKBENCH_KINDS` 순서 · 이름은 `WORKBENCH_LABEL_KO` · 글리프는 `TEXT.craftTabs.icon`) · `빠른제작`(bench 없는 현장 레시피) 로 가른다 — **작업대를 열고 들어온 화면에는 탭이 없고**(이미 그 작업대 하나다) 고를 것이 하나뿐이면 줄 자체가 숨는다. 고른 탭은 `sig` 에 들어가므로 탭을 바꾸면 목록을 다시 만든다. 그리고 **홀드가 도는 동안에는 게이지만 다시 그린다**(`frozen` → `paintProgress`): `updateCraft` 가 매 프레임 `refreshCraft()` 를 부르는데 94 줄 × (`canCraft` · `maxCraftCount` · `craftHasRoom`(가방 · 창고 격자를 통째로 복사한다)) 는 2.2 ms/프레임이었다 → 0.02 ms. 홀드 중 재배치 금지 규약과 같은 뿌리다 |
| `ui/RepairPanel.ts` | **2026-09-08 — 장비 수리 모달 팝업.** Opened by the bench header's `모두 수리`. A `Modeless` frame (variant `repair`, centred) **plus a scrim** (`.inv-rep-scrim`) that this file owns, so it reads as a modal while still taking no blocker and no pointer-lock change. Rows come from `sys.benchRepairRows(true)` — **worn gear only** — one wide row each (슬롯 · 이름 + 내구도 막대 + `현재 / 최대` · 재료 칩 · `×`). `×` (`.inv-repair-drop`) excludes that item from the batch (`.is-excluded`, click again to put it back); under the list the **summed** materials of what is left (`.inv-rep-total`, 보유/필요 chips) and the `모두 수리 (n)` button → `sys.benchRepairAll(excluded)`. The exclusion set is cleared on close (user decision: a scratch selection for one batch, not a saved setting). Individual repair stays in the item right-click menu. **2026-09-10**: 수리비가 `제작 재료 × 남은 내구도 구간의 배수` 라서 줄마다 `현재 / 최대` 뒤에 `.inv-repair-bucket`(`61~80 % · 제작 재료의 20 %`)이 붙고, 목록 아래 `.inv-rep-hint` 가 두 줄(개별 수리 위치 + `내구도가 낮을수록 수리 재료가 많이 듭니다`)이 됐다. 방탄복 줄에도 재료 칩이 뜬다 |
| `ui/Modeless.ts` | **Phase 8** — shell of the **모달리스 팝업** (`.inv-modeless`, variant class `-implant` / `-craft` / `-disassemble`) shared by the implant picker, the craft panel and the 분해 dialog. `withHeader(eyebrow, title)` / `adopt(panel)` / `open(anchor?, centred?)` / `place()` / `close()` / `dispose()`. Adds **no** `ctx.uiBlockers` token and never touches the pointer lock — the window owns both; dismissed by the window's Escape chain (`closeOverlays`) or by a capture-phase `pointerdown` outside the panel *and* its anchor (so a click on the opener toggles). Anchored popups sit to the left of the anchor (clamped into the viewport), anchorless ones get `is-centred` (the craft popup is parked at the right edge by CSS). **Phase 8 UI pass**: `centred` keeps the anchor purely as the "this press is not outside" element while the frame stays in the middle of the screen — that is how the 전술 임플란트 panel is both centred *and* still toggled by a second click on its slot |
| `ui/DisassemblePanel.ts` | **Phase 8** — the **아이템 분해** dialog: a `Modeless` showing the **expected result** (`재료` input chip with 보유/필요 → `결과물` output chip ×n, both `buildItemChip` from `@/shared`) and a `분해` button that runs the item's `break_*` recipe through `InventorySystem.craft` (a second click cancels). **2026-09-08**: the button **is** the progress bar (`.inv-craft-fill`) — the `1회 분해 · n s` hint line and the separate `.inv-dis-bar` under it are gone — and the bag is checked **before** the hold (`InventorySystem.craftHasRoom`), so a full bag disables the button up front with `가방에 공간이 없습니다` on it instead of failing after 2 s. `open(uid)` / `close()` / `refresh()` / `isOpen` / `itemUid` / `barEl` (now the button) / `progress`; emits `ui:disassembleToggled {open, uid}` on both edges and closes itself when the source stack is gone. **2026-09-10**: 미리보기가 **남은 내구도**를 탄다 — 매 `refresh()` 마다 `sys.disassembleRecipeFor(uid)` 로 레시피를 다시 풀고 자리 검사도 `craftHasRoom(id, 1, uid)` 로 그 아이템 기준으로 묻는다. 미리보기 밑 `.inv-dur-note` 한 줄이 `남은 내구도 / 21~40 % · 제작 재료의 16 % / 내구도가 낮을수록 나오는 재료가 적습니다` 를 말하고, 내구도가 없는 아이템(탄약 · 재료)에서는 숨는다 |
| `ui/ImplantPanel.ts` | **2026-09-12 (사용자 결정)**: 이 블록(`.inv-implants`)이 **장비칸 그리드의 `implant` 칸**(주무기 II 아래 · 주머니 왼쪽)이고, 전술 임플란트 슬롯은 가로 바가 아니라 **정사각 썸네일**이다 (아이콘 가운데 · 이름 하단 캡션 · 구동 방식 우상단 태그 · 설명은 `title`). **임플란트 칸** (2026-09-08, 캐릭터 시트에서 이사). 장착 장비 격자(`.inv-equip-grid`) 바로 아래 `.inv-implants` 블록 두 개: **전술 임플란트** 슬롯 카드 + 모달리스 피커(`.inv-imp-pop`, 6종 카드, `ctx.implants.setEquipped`)와 **임플란트 아이템** (`임플란트 n / m칸` + 핍 줄, 장착한 것 한 줄씩(클릭 = 해제), `+ 장착` → `.inv-impi-pop` 이 가방 + 함선 창고의 후보를 나열; 망가짐 / 장착칸 부족은 사유와 함께 비활성). 두 피커 모두 **`ctx.uiRoot` 직속 자식**이다 (`.inv-root` 의 열림 애니메이션이 남기는 `scale:` 이 `position: fixed` 팝업의 컨테이닝 블록이 되므로). 능력치 임플란트는 `ctx.progression`, 전술 임플란트는 `ctx.implants` 로만 오간다 — 상태를 하나도 들고 있지 않다. `closePickers()` 가 `closeOverlays()` 사슬에 들어가 Escape 한 번을 먹는다. |
| `ui/CrewLoadoutView.ts` | **Phase 10** — `createCrewLoadoutView(host, loadout, opts)`: a **read-only** 장비 / 가방 / 빠른 사용 view of another member's `captureCrewLoadout()` document (발사 준비 패널 → 우클릭). `sanitizeLoadoutSave` validates, `reviveItem` mints the items onto a throwaway `Grid`, `GridView` + `buildTileContent` draw them with no-op handlers. Blocks `['equip','bag','quick']` (no 함선 창고, no 크레딧), unknown def ids skipped, `EmbeddedView` (no blocker / pointer lock / Escape listener) — see the last section |
| `ui/Tooltip.ts` | **2026-09-12 (사용자 결정)**: ① **내구도는 게이지 한 줄**(`buildDurabilityBar` → `.inv-tt-durbar`, 무기 2×2 게이지와 같은 `.track` / `.fill` 을 전체 폭으로) — 무기 · 가방 · 방탄복 · 회복 스프레이가 같은 함수를 부르고, 그 아래 있던 `구간` 줄(C-37)과 `TooltipLookups.getDurabilityBucket` / `canSalvage` · `TEXT.durability.tooltip*` · `.is-bucket` 은 **전부 사라졌다**(구간 안내는 수리 · 분해 팝업이 계속 적는다). ② **가방**에 「소지 한계 +N kg」 한 줄(`Gear.bagCapacityBonus` — 무게 계산과 같은 식, 0 이면 생략). ③ **방탄복**의 `특성` 행은 설명 문단과 글자가 같으면 서지 않는다(유니크 description 이 곧 퍽 문장이라 같은 줄이 두 번 나왔다). Hover card (name, category · rarity, description; attachments: socket, 호환, effects; bags: grid + 퀵슬롯 + **내구도 (2026-09-11)**; **서적 (Phase 9)**: 스킬 (한국어 name via the new `TooltipLookups.getSkillName` → `ctx.progression.getSkillDef`, the raw id as fallback) + 용도 `서재 책장에 꽂으면 해당 스킬 XP 증가`; qty). **2026-09-09 무기 카드 재설계**: 대미지 · 연사 · 반동 · 사거리 are a **2×2 게이지 격자** (`.inv-tt-gauges`, bar = value ÷ the **catalog maximum** of that stat, computed lazily once from `TooltipLookups.allWeaponItemDefs()` × `getBaseStats(defId)` = `LootRef.getEffectiveStats(defId)`; damage = `damage × pellets`, range = `effectiveRange(weapon)`; the raw number stays small at the right). Two layers per bar: the bare def value in **white**, a socket surplus as a **green `.bonus`** segment, a socket reduction (muzzle brake on 반동) as a **hollow green `.reduced` outline** over the removed span. The head's right corner holds the **탄종 썸네일** (`.inv-tt-ammo`, `findAmmoDef(type)` → the `ammo` item's glyph in its colour + the calibre name as a caption inside; no ammo def → dashed square with the label alone). The five sockets are a **row of 34 px squares** (`.inv-tt-sock`: attachment glyph + rarity border, or dashed + `socketAbbr`; `title` = `조준경: 없음` / `총구: 소음기`). Kept rows: 장전 `n / max` (that is where the mag size lives now), 발사 모드, 배율, 내구도 (`is-low` / `is-broken`). **Gone for every item**: 크기 and 무게 rows — the bottom bar (`.inv-tt-value`) is two-ended, **무게 left** (stack total, only with `def.weight`) and **가치 right** |
| `ui/labels.ts` | Cell metrics (`CELL=54`, `GAP=2`, `STEP`), `SLOT_LABEL` / `SLOT_KEY`, `QUICK_DIR_GLYPH` (▲ ◥ ► ◢ ▼ ◣ ◄ ◤), `QUICK_ROSE_ORDER` (3×3 DOM order), Korean UI strings (hints, menu, quick panel, split dialog, stat labels, **`search`**: `?` / `???` / `감정 중 · n개 남음` / `감정 완료` / denied toast), formatters (`fmtDeg`, `fmtMul`, `gradeLabel`), `DURABILITY_LOW` (0.3). **Phase 8**: `TEXT.tabs` gained `ship` / the per-tab hints / `unavailable`, `TEXT.disassemble` (분해 dialog), `TEXT.modelessClose`, `TEXT.catalog.tabs.seed`, and **`TEXT.credits.value` returns the bare number** so the pill reads `CREDITS 500`. **Phase 9**: `TEXT.bookStats` (스킬 / 용도 / the 서재 책장 line) and `TEXT.catalog.tabs.book` (`서적`). **Phase 10**: `fmtValue` = `formatCredits` from `@/shared` (`1,200 C`, no `₩`) and `TEXT.credits.value` = `formatCreditAmount`. **2026-09-09**: `socketAbbr(slot)` (two-letter caption of an empty tooltip socket square) · `socketTip(slot, name?)` (`조준경: 없음` / `총구: 소음기`) · `TEXT.socketNone`. **2026-09-10**: `TEXT.durability`(내구도 구간 문구 — `repair(label, mul)` / `salvage(label, mul)` / 안내 두 줄; 배수는 `ctx.loot.durabilityBucketInfo` 에서 오고 여기에 숫자는 없다) 와 `TEXT.craftTabs`(작업대 탭의 `전체` · `빠른제작` 라벨 + 글리프. 작업대 **이름**은 `WORKBENCH_LABEL_KO` 가 원본이다) |
| `inventory.css` | Styles (imported by `InventoryUI.ts`); scoped under `.inv-*` (`.inv-quick*` for the wheel panel, `.inv-tile-quick` badge, `.inv-cat-*` catalog, `.inv-repair-*` bench repair list, **Phase 7** `.is-hidden-item` footprint mask, `.inv-tile-scan` bottom-to-top gauge (`::before` height = `--p`) under the moving sheen, `.is-scanning`, `.inv-search-status` (`is-done` / `is-paused`; **2026-09-07** a fixed `min-width` so 감정 중 ↔ 감정 완료 cannot resize the container panel), `.inv-footer` (fixed-height slot shared by the hints and the drop zone; collapsed in `.is-hub`), `.is-pending` pulse; **Phase 8** `.inv-screen` / `.inv-screen-note` embedded-screen host, `.inv-modeless-layer` / `.inv-modeless[-implant|-craft|-disassemble]` / `.inv-modeless-head` / `.inv-modeless-body` / `.inv-modeless-close` / `.is-centred`, `.inv-dis-*` dialog, `.inv-craft-costs`, `.inv-menu-line` / `.inv-menu-item.has-costs` / `.inv-menu-costs`), no dependency on `src/ui/styles` — **except** the `.item-chip*` rules of `buildItemChip` / `renderItemCost`, which `src/ui/styles/base.css` owns (Phase 8 contract). **2026-09-11 (C-60)** `.inv-cont-scroll` (+ `.is-scroll`): the container grid's vertical scroll viewport |
| `__selftest__.ts` | `runInventorySelfTest()` — console.assert checks for grid/rotation/stack/split-merge, `resize` (grow/shrink/overflow/priority/snapshot-restore), sockets (`Sockets.ts` + `canAttach` + effective stats), quick slots (auto-assign under 2 / 6 usable slots, move, clear, prune, consume-to-0 relink, signature), **퀵슬롯 1:1 교체 (`QuickSwap.ts`, 2026-09-10: 꽉 찬 가방 + 가방 출발 / 상자 출발 / 가방에 자리가 있는 경우 / 공유 상자 거절 / 어디에도 안 들어가면 원상복구 / 병합으로 나는 자리)**, loot determinism, starter ids (dev use; exported via `@/inventory`, run from the browser console or `scripts/smoke-quickslots.mjs`) |
| `index.ts` | Barrel — import via `@/inventory` |

## Equipment slots

| Slot | Key | Accepts | Notes |
|---|---|---|---|
| `primary` 주무기 I | 1 | category `primary` | |
| `primary2` 주무기 II | 2 | category `primary` | drag a slot weapon onto the other primary slot to swap them |
| `bag` 가방 | — | category `bag` | sets the bag grid size (see below) |
| `armor` 방탄복 | — | category `armor` | 실드(추가 체력) — 피해를 깎지 않는다 (2026-09-10) |
| `pouch` 주머니 | — | category `pouch` | **고정 1칸** (`POUCH_SLOTS`, 2026-09-11 A-15) — 퀵슬롯 아래에 별도 격자를 연다 (아래 *주머니* 절) |

**2026-09-12 — 장비칸 배치는 두 열이다** (사용자 결정, A안):

```
주무기 I     |  방탄복
주무기 II    |  가방
전술 임플란트 |  주머니
```

원본은 두 곳이다 — 좁은 폭의 DOM(= 세로 한 줄) 순서는 `model.LOADOUT_SLOTS`
(`primary · armor · primary2 · bag · pouch`), 행/열 자리는 `inventory.css` 의 `grid-template-areas`
(`"primary armor" "primary2 bag" "implant pouch"`). 전술 임플란트는 장비칸이 아니라 `ui/ImplantPanel` 의 블록
(`.inv-implants`)이므로 `InventoryUI.mount` 가 `pouch` **앞에** 끼워 넣는다.
같은 배치에서 **아이템이 든 칸의 테두리는 한 겹**이다 — `.inv-slot.has-item .inv-slot-body` 가 여백(6px)과
테두리 색을 내주고 카드가 칸을 꽉 채운다 (상자 크기는 한 픽셀도 안 바뀌었다: `content-box` → `border-box` +
예전 겉 크기를 그대로 적었다). 드롭 하이라이트(`is-target-ok` / `is-target-bad`)는 그 투명 테두리 자리를 쓴다.

**2026-09-10 — `secondary` 보조무기 칸은 없다** (사용자 결정). `LOADOUT_SLOTS` 에서 빠졌고 `slotAccepts` 는 그 칸에
언제나 false 를 돌려준다. 타입(`LoadoutSlot` · `Loadout.secondary` · `WeaponSlot`)은 계약이라 남아 있고 값은 늘
null 이다 — 저장된 프리셋 · 크루 카드 · 로드아웃 세이브가 그 이름을 쓴다.

**2026-09-10 — 상자 · 시체의 더블클릭은 언제나 가방이 먼저다** (사용자 결정). 상자 · 시체에서 더블클릭한 것은
장착 아이템(무기 · 방탄복 · 가방 · 임플란트)이라도 **무조건 가방 격자로** 들어간다 — 주우면서 지금 든 총이
조용히 바뀌면 레이드 중에는 사고다. **가방에 자리가 없을 때만** `activateFallback`
(`parts/DropResolver.ts`)이 `tryAutoPlace` 로 순서대로 시도한다: ① **비어 있는** 장비 칸 (`emptyEquipTargetFor` —
이미 장착한 것을 밀어내지 않는다), ② 임플란트 아이템이면 `ctx.progression.equipImplant` (함선에서만 ·
`findItemAnywhere` 가 가방 · 창고만 보므로 사실상 **함선 창고**에서 누른 경우다), ③ 퀵슬롯에 올릴 수 있는
소모품이면 **빈** 휠 칸, ④ 셋 다 아니면 `inventory:full` (거부음 + 가방 가득 참 토스트). ①②③ 으로 갔을 때는
`가방이 가득 찼습니다 — <이름> → <어디>` 를 `ui:notify` 로 띄운다 — 물건이 어디로 사라졌는지 몰라서는 안 된다.
가방 · 휠 · 장비 칸에서 누른 더블클릭은 예전 그대로다 (거기서는 "장착"이 하려는 일 그 자체다).

**2026-09-12 — 함선 창고는 그 예외다** (사용자 결정). 2026-09-10 의 결정이 지키려던 것은 *레이드 중에 손에 든
것이 조용히 바뀌지 않는다* 였고, 출격 전 창고 앞에서 장비를 고르는 동안에는 그 위험이 없다. 그래서 **창고
더블클릭은 같은 `tryAutoPlace` 를 가방보다 먼저** 본다 — 그 종류의 장비칸(주무기 I · II · 가방 · 방탄복 ·
주머니) 또는 임플란트 칸이 **비어 있으면 곧장 거기로**, 퀵슬롯에 올라가는 소모품이면 **빈 휠 칸으로**.
이미 차 있으면 예전처럼 가방으로 회수하고, 가방마저 꽉 차면 `activateFallback` 이 마지막으로 훑는다.
행선지는 `<이름> → <어디>` 토스트로 알린다 (사고가 아니므로 「가방이 가득」 문구가 아니다).

`slotAccepts(def, slot)` is the single rule. Double-click / `장착` on a primary **in the bag** uses `equipTargetFor`: first empty primary slot, else swap with 주무기 I (the displaced weapon lands in the source cells / auto-place / the bag when the source was a container; refused + shake when nothing fits). `InventoryRef.equip(uid | null, slot)` = the same `dropOnSlot` path (`null` unequips via `quickMove`). Equipped items live in `Loadout`, not in grid cells. Every change emits `loadout:changed {primary, secondary, primary2, bag}`.

## Bag grid

`getBagSize()` = equipped bag's `def.bag` (`cols × rows`, `quickSlots`), else `BAG_DEFAULT_COLS × BAG_DEFAULT_ROWS` (5×3, 1 quick slot). Starter `bag_common` → 5×6.

**2026-09-12 — 가방은 전부 가로 5칸 · 세로로 길다** (사용자 결정). `data/bags.csv` 의 칸 수를 5의 배수로 반올림했다:
일반 5×6 · 고급 5×7 · 희귀 5×10 · 서사 5×11 · 전설 5×12 · 희귀 전술 5×8 · 서사 전술 5×10 · 전설 전술 5×11.
화면의 가방 **틀**은 가장 긴 가방(`model.BAG_FRAME_ROWS` — 표에서 읽는다)으로 고정이고, 작은 가방은 아래가 격자 없는 빈
여백이다 (`GridView.setFrameRows` — 여백은 드롭 대상이 아니다). 옛 세이브의 `x ≥ 5` 칸은 새 격자에 없으므로
`parts/Lifecycle.applyLoadoutSave` 가 **하나라도 못 서면 가방 전체를 큰 것부터 다시 채우고**(합치지 않는다), 그래도 남는 것은
**함선 창고**로 보낸다 — 창고마저 가득일 때만 예전처럼 경고와 함께 버린다.

Equipping / unequipping / dropping the bag runs `changeBag()`:
1. the new bag leaves its grid, the bag grid is `resize`d to the new size;
2. the **displaced bag is placed first** (at the new bag's former cells when in bounds, else at the first free slot); in-bounds items keep their cells, out-of-bounds items are auto-placed around it;
3. whatever no longer fits is **dropped into the world** through the normal drop path (`inventory:itemRemoved` + `inventory:itemDropped` per item; `ui:notify` warning with the count);
4. `inventory:bagChanged {cols, rows, quickSlots, dropped}` and `loadout:changed` fire, the bag `GridView` re-renders for the new size (panel width follows the columns).

**Refusal rule**: the swap is refused (shake + `ui_error`, nothing changes — `Grid.snapshot/restore`) only when the *displaced bag item itself* cannot be placed in the new grid at all. Because it is placed with priority before anything else and the smallest grid is 5×3 while bags are 2×2, this never triggers with the shipped defs; it guards hypothetical oversized bags. Loose items are never a reason to refuse — they overflow to the ground instead. Dropping the equipped bag (`dropItem`, X, drag to the backdrop) shrinks the grid the same way and throws the bag itself.

## Reset policy (+ Phase 5 persistence)

Since Phase 5 (2026-09-06) the bag, the five slots and the quick slots are **persisted in localStorage `scav.loadout`** (`Loadout.ts`). The save is read **once, in `init`** — from then on the session state is the truth and the file only mirrors it:

| Event | Effect |
|---|---|
| `init` | a non-empty save fills the slots (wrong-category entries dropped), resizes the bag to the saved bag and places every stack at its cell (fallback `autoPlace`, else discarded with a warning), then rebuilds the quick slots from the saved bag indices (locked slots keep theirs). No events yet — the other systems subscribe after us — so `announcePending` is set |
| first `hub:entered` | **2026-09-07**: `STARTER_LOADOUT` only when the kit is empty **and** either this session just granted `STARTER_STASH` (a brand-new profile) or the 함선 창고 is empty too; otherwise, when `announcePending`, **announce** the restored loadout: gates reset (`lastEquipUids`, weight, counts, quick signature) + `inventory:bagChanged` + `loadout:changed` / `equip:changed` + `afterChange()` (which saves once more, reason `hub`) |
| every `afterChange()` while `ctx.isHubPhase()` | `markDirty('hub')` → one debounced write per burst (drag session, preset, bench craft, stash move…) |
| `world:ready` | **2026-09-07**: nothing anywhere (`isDestitute()`: no loadout, empty bag **and** an empty 함선 창고) → `STARTER_LOADOUT`; otherwise the kit the player equipped in the ship is what they raid with. Always re-emits `loadout:changed` (weapons clear their slots on `world:ready`), `grenade:countChanged`, `stim:countChanged`, `inventory:changed` (a pending announce is folded in here when a mission starts without a hub entry) |
| mission changes (loot, consumption, drops) | **not saved** until the mission ends: a reload mid-mission restores the last ship state |
| `game:complete` | keep everything (worn weapons return to the ship for the workbench) and `saveNow('complete')`; the `game:abort` the hub emits right after is ignored |
| `player:respawn` (Phase 2 death flow: hellpod re-drop after `PLAYER_RESPAWN_DELAY`) | `STARTER_LOADOUT` immediately; the mission continues, so rolled containers and `outcome` are kept |
| `game:over` (legacy mission failure; the Phase 2 flow no longer emits it) | **`loseKit()`**: the carried kit is gone (slots + bag emptied, quick slots cleared) and the player re-equips from the 함선 창고; only an empty 창고 falls back to `STARTER_LOADOUT` |
| `game:abort` | after `game:complete` → keep; after `game:over` → already reset; otherwise (quit mid-mission, lobby lost, back to title) → `loseKit()` |
| `reset()` (public) | `loseKit()` — same rule as a failed raid |
| every `applyStarter()` / `loseKit()` | **`saveNow('starter')`** right after, so a reload can never resurrect a bag that was lost to death / abort |
| `pagehide` / `beforeunload` / `dispose` | `flush()` the pending debounced write |
| **2026-09-11 (E-6)** every debounced write | the 창고 and the loadout share **one** 350 ms timer (`Stash.schedule` / `LoadoutStore.schedule` → `parts/ProfileDocs.scheduleSaves`); `flushSaves` writes both and uploads them as **one** `ProfileRef.setMany({stash, loadout})` when both changed (a `fresh` save keeps its own `set`). Page hide (registered before the stores' own listeners) / `dispose` / `InventoryRef.flushSaves` go through the same path |
| **2026-09-11 (E-5)** `world:ready` of a **solo raid** | `LoadoutStore.markRaid(seed)`: the **local** file gets `raidSeed` (never uploaded, never part of `LoadoutSave`); `game:complete` / `game:over` / `game:abort` → `clearRaid()`. `InventoryRef.soloRaidSeed` exposes it — game/ fails a run whose marker has no matching solo raid save at boot. Multiplayer raids and trainings never mark |
| `game:newMission` | close windows, forget rolled containers |

Every write emits `inventory:loadoutSaved {reason}` (`starter` / `hub` / `complete`). The stash (`scav.stash`) is independent and never reset.

**기본 지급품 (2026-09-07)** — `tryStarterGrant()` writes `STARTER_STASH` (`@/items`) into the 함선 창고 **once per
profile**, and `firstRunGrant` makes the same session's first `hub:entered` equip the minimum kit (a grant that lands
while the player is already aboard equips it right away). The condition used to be `Stash.firstRun` (no `scav.stash`
file), which skipped every profile that existed before the grant did and every profile whose local file was written
before the server document arrived — a "new character" then opened onto an empty 창고. The state lives in its own
localStorage key (`scav.grant`, `Stash.ts`): a 창고 that already holds something settles to **done** with no grant;
otherwise **none** grants (inside `withFreshSave` on a true first run, so a real server profile still wins) and marks
**pending**, and **pending** is re-checked exactly once at `net:profileLoaded` — after the server's documents have
been applied, so a grant an empty server 창고 replaced is handed out again — and settles to **done** either way. At
most one extra grant can ever come out of that, and a client that never connects simply stays `pending`. Entries are `{id, qty, stacks?}` — `qty` units per stack (clamped to
`stackMax`), `stacks` stacks of them, i.e. one 세트 per grid cell. An entry that no longer fits the 창고 is warned about
and skipped. Since the kit is lost on a failed / abandoned raid, those spare 가방 · 방탄복 · 총기 are what the player
re-equips from.

`STARTER_LOADOUT` = `{primary, primary2, secondary, bag, items: [{id, qty}]}`; ammo `qty` are rounds, added through `addUnits` (merge into stacks, then new stacks chunked by `stackMax`). A reset always emits `inventory:bagChanged` (dropped `[]`), `loadout:changed`, both count events, `inventory:quickSlotsChanged` (after `autoAssignQuickSlots`, see below) and `inventory:changed`.

## Quick-use wheel slots (Phase 2)

`quickSlots: (string | null)[]` of length `QUICK_SLOTS` (8) holds **bag item uids** by wheel direction (`QUICK_SLOT_DIRS`: 0 N, 1 NE, 2 E, 3 SE, 4 S, 5 SW, 6 W, 7 NW). Stacks stay in the grid; a slot only references them.

- `getQuickSlots()` resolves uids to the live `ItemInstance`s (null = empty). `getQuickSlotCount()` = equipped bag `def.bag.quickSlots`, else `BAG_DEFAULT_QUICK_SLOTS` (1), clamped to 8 (2026-09-11: no bag defines more — `bag_legendary_tac` is 8 and the loader rejects anything above `QUICK_SLOTS`; the clamp stays as a guard). A bag with n quick slots unlocks the first n entries of **`QUICK_SLOT_UNLOCK_ORDER` = [0 N, 4 S, 2 E, 6 W, 1 NE, 3 SE, 5 SW, 7 NW]** (`isQuickSlotActive(index, count)` from `@/shared`) — not indices 0..n-1. Slots not unlocked are **locked**: they keep their assignment (visible, dimmed) but cannot be filled until a better bag is equipped. `inventory:quickSlotsChanged.active` stays the count.
- `setQuickSlot(index, uid | null)`: index in range; `uid` must be a bag item whose def category is in `QUICK_USABLE_CATEGORIES` (`grenade`, `stim`) and `isQuickSlotActive(index, getQuickSlotCount())`. A uid occupies one slot only — assigning it elsewhere moves it (the previous occupant of the target slot is simply unassigned). Clearing a locked slot is allowed. Returns true for a valid call even when nothing changed; emits `inventory:quickSlotsChanged {slots, active}` only on a change.
  - **2026-09-10 — 1:1 교체는 가방 여유를 요구하지 않는다.** 밀려난 스택의 자리는 이제 `QuickSwap.ts` 가 정한다:
    `가방 → 휠` 은 **① 비운 바로 그 칸 → ② 가방 아무 데나**, `상자 · 창고 → 휠` 은
    **① 가방 → ② 비운 그 칸 → ③ 출발 격자 아무 데나**. 예전에는 가방만 봤고(`returnQuickToBag`),
    그래서 **가방이 꽉 차면 교체 자체가 거절**됐다 — 자리를 맞바꾸기만 하면 되는데도. 버그는 두 군데였다:
    ⓐ `previewDrop` 이 `bag.canAbsorb(occupant)` 를 **들어오는 스택이 아직 격자에 있는 상태**에서 물어 그것이 곧
    비울 칸을 세지 않았고(→ `가방 → 휠` 이 빨간불, `dropImpl` 이 곧장 `'fail'`), ⓑ `setQuickSlot` 이 밀려난 스택을
    **가방에서만** 찾았다(→ `상자 · 창고 → 휠` 거절). 이제 미리보기와 실행이 `canQuickSwap` / `applyQuickSwap` 으로
    **같은 계획**(`InventorySystem.quickSwapPlan`)을 본다. 컨테이너에서 올 때 가방이 먼저인 것은 의도한 것이다 —
    가방에 자리가 있는데 내 소모품을 상자 바닥에 흘려 두고 오면 안 된다(자리가 있을 때의 예전 동작 그대로,
    고친 것은 자리가 **없을 때** 통째로 거절되던 쪽이다). 교체가 성립하지
    않으면 **아무것도 바꾸지 않고** 거절하고(들어온 스택은 원래 칸으로 되돌아간다) `inventory:full` 을 낸다.
    멀티플레이의 공유 상자에는 내 물건을 넣을 수 없으므로 그때만 ①③을 건너뛴다. 휠 ↔ 휠 교체는 예전처럼
    두 칸을 맞바꾸는 것이라 격자를 아예 건드리지 않는다. 밀려난 스택이 상자 · 창고로 갔을 때는
    `emitTransfer` 가 `inventory:itemRemoved` 로 그 사실을 알린다.
- `consumeItem(uid, qty = 1)` (weapons: stim injected / grenade thrown): removes up to `qty` from that exact bag stack, returns the count. At 0 → `inventory:itemRemoved`; then `stim:countChanged` / `grenade:countChanged` / `inventory:changed` as `consumeWhere` does. `consumeWhere` shares the 0-stack path.
- **Consistency**: `afterChange()` runs `syncQuickSlots()` — prune uids that are no longer in the bag (drop, move to a container, bag-shrink overflow, consumed) and emit when the signature (uids + quantities + active count) changed. So the HUD also gets an event when a slot's stack count changes or the bag swap changes `active`. When a stack **merges away** entirely (drag onto a same-def stack in the bag) or is **consumed to 0**, its slot is handed to the surviving / a sibling stack of the same def that has no slot of its own (`relinkQuickSlot`); otherwise the slot clears. Splits keep the slot on the source stack.
- **Starter policy** (`autoAssignQuickSlots`, on every starter reset incl. `player:respawn`): biggest grenade stack → slot 0 (N); biggest stim stack → slot 4 (S) — the first two unlocks, so both are usable with the common starter bag (2 slots). A locked / taken preferred slot falls back to `firstFreeQuickSlot` (first empty slot in unlock order; with no bag = 1 slot only the grenade is assigned). `world:ready` re-emits `inventory:quickSlotsChanged` even without a reset.
- **UI**: the bag panel shows a 3×3 compass rose under the grid (DOM order NW N NE / W centre E / SW S SE; the centre shows `F` + `active/8`). Cells carry their glyph (`QUICK_DIR_GLYPH`) hugging the edge of their direction; locked cells are dimmed with a padlock and `title="가방 등급이 낮아 잠김"`. Assigned bag tiles get a top-left direction badge (`.inv-tile-quick`).
  - Drag a stim / grenade from **any grid** — 가방 · 열어 둔 상자 · 함선 창고 (2026-09-10; 예전에는 가방뿐) — onto a cell → `setQuickSlot` (usable cells glow amber during such a drag; hovering one lights green / blue = replaces / red = refused — locked cell, non-usable item, unsearched container item). 상자에서 오는 것은 `guardedTake` 를 지나므로 멀티에서 호스트가 확인한다.
  - Drag a cell tile onto another cell → move; onto a **grid** (가방 · 상자 · 창고) → 그 칸으로 옮긴다 (2026-09-10); 아무 목표도 없는 곳에서 놓으면 예전처럼 슬롯이 비고 스택은 가방으로 돌아간다 (never a world drop; the 버리기 zone stays hidden for cell drags).
  - Right-click a cell → `빠른 슬롯 해제` (+ 상자가 열려 있으면 `상자로 이동`, + `요청`); double-click a cell tile also clears. Right-click a stim / grenade in **any grid** now always opens the menu: `빠른 슬롯에 등록` (first free usable slot, `registerQuick`) or `빠른 슬롯 해제 (glyph)` when assigned. Double-click a bag stim / grenade with no crate open = 등록.
  - The panel refreshes with every `InventoryUI.refresh()` (system `afterChange` / `setQuickSlot`), covering `inventory:quickSlotsChanged` and `inventory:bagChanged`.

## 주머니는 가방 격자가 아니다 (A-15, 2026-09-11)

2026-09-09 의 **「퀵슬롯은 가방 격자가 아니다」가 그은 선을 그대로** 따르는 두 번째 컨테이너다 (사용자 결정).
장비칸 `pouch` **한 칸**(`POUCH_SLOTS` = 1 — 넷 중 하나만)에 주머니를 끼우면 **퀵슬롯 패널 바로 아래**에
그 주머니의 격자가 열린다. 규칙과 구현은 전부 **`parts/Pouch.ts`** 하나에 있다.

| 주머니 | 아이템 크기 | 격자 | 받는 것 (`PouchDef.accepts`) |
|---|---|---|---|
| 채집 주머니 `pouch_gather` | 2×1 | **2×2** | `herb` · `seed` · `soil` · `crop` · `sample` |
| 열쇠 주머니 `pouch_key` | 2×1 | **3×1** | `key` |
| 구급 주머니 `pouch_medical` | 2×1 | **4×1** | `stim` |
| 귀중품 주머니 `pouch_valuable` | 2×1 | **2×2** | `valuable` |

- **어휘**: `GridId` += `'pouch'`, `LOADOUT_SLOTS` += `'pouch'`(맨 뒤), `slotAccepts(def, 'pouch')`,
  `isPouchDef` · `pouchAcceptsDef` (`model.ts`). **`ItemLocation` / `DropTarget` 에는 새 종류를 만들지 않았다** —
  주머니 칸은 그냥 `{ kind: 'grid', grid: 'pouch' }` 이고, 그래서 드래그 · 우클릭 · 툴팁 · 분할이 한 줄도 안 바뀐다.
- **퀵슬롯이 그은 선 그대로**: `getWeight` · `countWhere` · `consumeWhere` · `getTotalValue` · `stripForCorpse` ·
  레이드 blob(`captureRaidState`)은 주머니를 **본다**. `getAllItems()`(기업 거래 · 작업대 수리 목록)는
  **여전히 가방 격자만**이다. `locKind('pouch')` 는 `'player'` 이므로 가방 ↔ 주머니 이동은 전송이 아니다
  (`inventory:itemAdded` / `itemRemoved` 가 나지 않는다).
  `consumeWhere` 의 순서는 **가방 → 주머니 → 휠**이다 — 일부러 넣어 둔 것일수록 나중에 먹힌다.
- **격자가 거절한다**: `PouchDef.accepts` 밖의 카테고리는 미리보기에서 `bad`, 실행에서 `fail` 이다
  (`previewDrop` · `dropImpl` · `validatePartial` · `nearestFreeSpot` · `previewCatalog` / `dropFromCatalog`).
  **교체도 같은 판정을 받는다** — 주머니에서 가방 아이템 위로 끌어다 놓는 1:1 교체는 밀려난 쪽이 주머니로
  들어가는 이동이기도 하므로, 주머니가 그것을 안 받으면 교체 자체가 성립하지 않는다. 같은 이유로
  `quickSwapPlan` 은 출발 격자가 주머니일 때 그 주머니가 밀려난 스택을 받아 줄 때만 후보로 남긴다
  (구급 주머니에서 붕대를 휠에 올리며 수류탄이 조용히 그 안에 들어가면 안 된다).
- **거절 규칙** (`changePouch`): 주머니를 벗거나 다른 주머니로 갈아 끼울 때, 새 주머니가 못 받는(또는 자리가
  없는) 내용물은 **가방**으로 간다. 하나라도 못 들어가면 **전부 되돌리고 이동 자체를 거절한다**
  (`inventory:full` + 흔들림). `setQuickSlot` 의 "휠 아이템을 조용히 버리지 않는다" 와 같은 규약이고,
  벗은 주머니 자신도 갈 자리가 없으면 같은 이유로 거절된다. 가방처럼 넘치는 것을 바닥에 떨어뜨리지 않는다.
- **주머니 칸을 지나는 길은 전부 `changePouch` 하나다**: 드래그(`dropOnSlot` · `dropImpl` 의 `from.slot === 'pouch'`
  가지) · 우클릭(`quickMoveImpl`) · `X`(`dropItemImpl`) · `창고로 이동`(`moveToStash`) · 프리셋 적용
  (`equipFromStorage` / `unequipToStorage`) · 무한 상자(`dropFromCatalog`). 그냥 `detach` 하면 격자의 내용물이
  갈 데 없이 남기 때문이고, 이것은 가방(`changeBag`)이 같은 이유로 그렇게 하는 것과 똑같다.
- **저장**: `LoadoutSave` **v3** — `pouch: SavedPlacement[]` (주머니 **아이템**은 여느 장비처럼 `slots.pouch`).
  v2 → v3 은 없던 필드가 생기는 것뿐이라 `sanitizeLoadoutSave` 가 빈 배열로 읽는다. 되살릴 때 그 주머니가
  안 받는 것(데이터가 바뀐 경우)은 가방으로 간다.
- **이벤트**: `inventory:pouchChanged` — `afterChange` 마다 `pouchSignature`(장착 uid + 크기 + 스택 자리/수량)로
  게이트한다 (휠의 `quickSlotsSignature` 와 같은 방식).
- **UI**: `ui/InventoryUI.refreshPouch()` 가 퀵슬롯 패널 아래 `.inv-pouch` 블록을 그린다 — 제목 한 줄은
  `<주머니 이름> · <받는 종류>`(`TEXT.pouch.line` + `pouchAcceptsLabel`)이고, **장착한 주머니가 없으면 블록이
  통째로 `hidden`** 이라 "비어 있음" 자리조차 없다. 숨어 있는 동안은 `activeViews()` 에도 들어가지 않는다
  (감춰진 격자가 가방을 노린 드롭을 삼키면 안 된다). 장비칸에는 `주머니` 슬롯 한 칸이 늘었다
  (넓은 배치의 `grid-template-areas` 셋째 줄).

## 요리 먹기 (A-3c, 2026-09-11)

요리(`ItemDef.meal`)는 **함선에서 우클릭 → `먹기 (다음 레이드 1회분)`** — 준비물의 `사용` 바로 옆이다
(`ui/parts/ContextMenu.menuEntries` 의 1c-3 · `InventorySystem.useMealItem` → `parts/StashOps.useMealItem`).

- **순서는 준비물과 똑같다**: `ctx.progression.useMeal(defId)` 에게 **먼저 묻고 성공(null)일 때만** 아이템을 뺀다.
  거절 사유는 한국어 그대로 토스트로 나가고 아이템은 **그대로 남는다**. 레이드 중에는 항목이
  `레이드 중에는 먹을 수 없음` 힌트를 달고 잠긴다.
- ⚠ **「먹는 행위」의 제자리는 주방의 식탁이다** (사용자 결정 — `housing/ui/DiningTable`). 우클릭 `먹기` 는
  편의 경로일 뿐이고 둘 다 같은 `useMeal` 로 간다 — 규칙은 progression 한 군데에만 있다.
- 출격 준비 점검(`parts/LaunchCheck`)에 여덟 번째 줄 **`noMeal`** 이 붙었다 (`ctx.progression.getMeal()` 이 비었을 때).
  `noEnvPrep` 과 똑같이 **막지 않는다** — 소프트 게이트이고 팝업의 한 줄일 뿐이다.

## Sockets

- `attachToWeapon(weaponUid, attachmentUid)` / UI `attachFrom`: weapon must be player-owned (bag or weapon slot), attachment from the bag or the open container, `ctx.loot.canAttach` decides. The previous attachment in that socket goes back to the bag via `autoPlace` (it always fits the 1×1 cell the new one vacated) or drops to the ground. Emits `inventory:socketChanged {weapon, socket, attachment}`, then `inventory:itemUpdated {item: weapon}` and `inventory:changed`.
- `detachAllSockets(uid)`: one `inventory:socketChanged {attachment: null}` per emptied socket, attachments back to the bag (overflow drops). False when nothing was attached.
- After any socket change a magazine larger than the new `magSize` (extended mag removed) spills its excess rounds back into the bag as ammo.
- `findItem(uid)` (contract form, no location) searches bag → loadout slots → sockets of owned weapons; `updateItem(uid, {durability?, ammoInMag?})` patches and emits `inventory:itemUpdated` + `inventory:changed` (weapons call it every shot; the bag `version` is bumped so tiles refresh).
- UI: drag an attachment tile over any weapon tile (bag or equipment slot) — the tile lights green (`is-socket-ok`) / red (`is-socket-bad`); release to socket it. Weapon tiles show five pips (`.inv-pip.is-filled`) in `SOCKET_SLOTS` order and a durability bar (`.inv-tile-dur`, `is-low` < 30 %, `is-broken` at 0). Attachments have no `장착` menu entry (drag only).

## Ammo v2 / unload / repair

- Ammo items are stacks of rounds (`qty`); the tile badge shows the count. Reserve for weapons = `countWhere` on the calibre; reload uses `consumeWhere`.
- `unloadWeapon(uid)`: `ammoInMag` → ammo item of `getEffectiveStats(inst).ammoType` (`ammoItemIdFor`), merged into existing stacks first, new stacks chunked by `stackMax`, overflow dropped to the ground; `ammoInMag = 0`; `inventory:itemUpdated`. False when the magazine is empty.
- `repairWeapon(uid)`: cost from `ctx.loot.getRepairCost`; every entry checked with `countWhere` before anything is consumed (never partial); `durability = maxDurability`; `inventory:itemUpdated` + `inventory:changed`. False when nothing is missing or materials are short.
- **2026-09-10 — 수리 재료를 정하는 곳은 `parts/Durability.repairMaterials` 하나다.** `LootRef.getRepairCost`
  (= 제작 재료 × 남은 내구도 구간의 배수, 올림)를 **먼저** 보고 비었을 때만 회복 스프레이의 게이지 충전
  (`sprayRepairCost`)으로 내려간다. `repair()` · `repairInfo()` · `parts/Crafting.benchRepairRows()` 셋이 전부
  이 함수를 지난다 — 예전에는 셋 다 `getEffectiveStats(item) ? getRepairCost(item) : …` 였고, 그래서 **방탄복이
  재료 없이 만피로 복구**됐다. 무기는 여전히 `repairWeapon` 이 맡고(실효 최대 내구도를 쓴다), 나머지는
  `repair()` 가 `def.durabilityMax` 로 채운다. ~~가방은 `durabilityMax` 자체가 없어 수리 목록에 오르지 않는다.~~
  **2026-09-11**: 가방에도 `durabilityMax`(100)가 생겨 방탄복과 같은 경로로 수리 목록에 오르고 재료를 낸다.

## Behaviour contract (unchanged parts)

- `crate:open {crateId, tier, position}` → `openContainer()`; `crate:looted` emitted once when a container's grid first becomes empty (also when the last item leaves through another peer's confirmed take, Phase 7). `inventory:containerOpened.first` = the id was never opened on this client (a crate the host rolled only to validate a request still counts as first).
- **Phase 4 — caller-supplied containers**: `openContainerItems(containerId, items, position, title?)` (contract) opens the same loot window for contents the caller rolled (corpses: `ctx.loot.rollCorpse`). First open for an id places `items` largest-first on the fixed 6×4 grid (overflow dropped silently with a `console.warn`); a later open of a known id shows what is left and ignores `items`. The loot window shows `title` (default `컨테이너`) instead of the tier label, eyebrow `REMAINS` for `corpse:*` ids / `CONTAINER` otherwise. Everything else is shared with crates: take-all, drag, `inventory:opened {containerId}`, auto-close > 6 m, and `crate:looted {crateId: containerId}` when emptied (enemies remove the corpse on `crate:looted {crateId: 'corpse:<id>'}`). Contents are per-client, like crates.
- Opening adds `'inventory'` to `ctx.uiBlockers` and turns on the **software cursor** (`ctx.input.setCursorMode(true, 'inventory')`, Phase 10 — the pointer lock is **kept**, so GameFlow's lock-loss pause never fires); closing removes both. `inventory:opened/closed` emitted. `closeAll(relock?)` no longer re-requests the lock (there is nothing to re-acquire); the parameter is kept for its callers.
- Tab (`Keys.INVENTORY`) toggles the bag during gameplay phases (ignored while another blocker is active). Escape closes via a capture-phase keydown listener; when the context menu or split dialog is open, the first Escape only closes that overlay.
- `inventory:itemAdded` when an item enters player possession (bag, slot or socket) from a container or `tryAddItem`; `inventory:itemRemoved` when it leaves (to container / consumed to 0 / dropped into the world). `inventory:full` when a bag add is refused.
- `countWhere/consumeWhere/getTotalValue/getAllItems` cover the bag only (not equipped weapons, not socketed attachments).

## Drop / split / request

**Gesture scheme** (hint bar: `R 회전 · 우클릭 빠른 이동/메뉴 · Shift+드래그 절반 · Ctrl+드래그 하나 · 드래그→무기 부착 · 드래그→퀵슬롯 등록 · X 버리기 · 휠클릭 요청`):

| Gesture | Effect |
|---|---|
| Right-click on a weapon, a bag, a stack with qty ≥ 2, or a bag stim / grenade | Context menu |
| Right-click on anything else (attachment, single valuable, container consumable) | Quick action directly (container ↔ bag, slot → bag) |
| Stim / grenade drag → wheel cell; cell → cell; cell → anywhere else | Assign / move / clear the quick slot (see above) |
| **Shift + right-click** | Always the context menu |
| Shift + drag a stack | Drags **half** (`floor(qty/2)`, min 1); ghost shows the carried qty, source badge shows the remainder |
| Ctrl + drag a stack | Drags **one** unit |
| Partial drag → free cell / same-def stack / source | New stack (`inventory:itemSplit`) / merge capped by `stackMax` / cancel |
| Attachment drag → weapon tile | Socket it (`attachFrom`) |
| Drag released over the dark backdrop or the `버리기` zone | World drop of the dragged qty (`dropItem`) |
| Drag released on a panel but not on a valid cell | Snap back + shake |
| X (hovered or dragged item) | Drop whole item; **Shift+X** one unit; **Ctrl+X** half |
| Middle-click on any item / slot | `chat:post` request (see below) |

**Context menu entries, in order**
- Weapons: quick action (`장착` / `주무기 II로 장착` / `가방으로 이동` / `상자로 이동`; a bag primary that would go to 주무기 I also offers `주무기 II로 장착`), `장전된 탄약 모두 탈착` (only when `ammoInMag > 0`), `무기 소켓 모두 탈착` (only when a socket is filled), `탄약 요청`, `버리기`.
- Bags: `장착` / `가방으로 이동` (slot), `요청`, `버리기`.
- Attachments: quick move (no `장착` — drag only), `요청`, `버리기`.
- Stacks: quick action, `절반 나누기` · `하나 나누기` (qty > 2) · `수량 지정…`, `요청`, `버리기` (+ `하나 버리기`).
- Bag stims / grenades additionally: `빠른 슬롯에 등록` or `빠른 슬롯 해제 (glyph)` right after the quick action.

**System API / events**
- `dropItem(uid, qty?)` — searches bag, open container and equipment slots. Weapons/bags/attachments always drop as the whole `ItemInstance` (sockets, durability and rounds travel with it; `pickups/` forwards them as `ex`). Partial qty creates a new `ItemInstance` via `ctx.loot.createItem` and decrements the source. Emits `inventory:itemRemoved` (player-owned items only), `loadout:changed` (slot items) and `inventory:itemDropped { item, position, velocity }` with `position = eye − 0.3 m up + 0.4 m forward`, `velocity = forward × 3.5 + up 2.0`. The `pickups/` folder spawns and syncs the world object; inventory does no networking. UI plays `ui_drop`.
- `splitItem(uid, qty)` — stackables only, `1 ≤ qty ≤ item.qty − 1`; the new stack is `place()`d at the first free slot of the same grid. Emits `inventory:itemSplit { source, created }`.
- `requestItem(uid, from)` — `chat:post { kind: 'request' }` with **`탄약 필요: <AMMO_LABEL_KO[getEffectiveStats(inst).ammoType]>`** for weapons (2026-09-09: the weapon name is gone — the squad needs the calibre) or `<def.name> 필요` otherwise. Middle-click on a grid tile, an equipment-slot tile (`ui/parts/SlotPanel` → `beginPress`) and a quick-slot cell all reach it through `Drag.beginPress`'s `MIDDLE_BUTTON` branch; the context menu's `탄약 요청` / `요청` entries call it too.

## Known limits
- Pickups dropped while in the hub (bag swap at the ship) settle in place but `pickups/` only lets the player take them during gameplay — swap bags with room to spare, or on a mission.
- Container weapons cannot receive attachments (player-owned only); socketing an attachment from a container into an owned weapon counts as taking it (`inventory:itemAdded`).
- Quick slots: a Shift/Ctrl partial drag onto a wheel cell is refused (assign the whole stack); container stims must be taken into the bag first.

## Verification (2026-09-06)
`npm run typecheck` 0 errors. `node scripts/smoke-quickslots.mjs [url]` (headless Chrome, real mouse; against `npm run dev` it also runs `runInventorySelfTest()` through Vite's module server, against a `vite preview` build that step is skipped) 45/45 dev · 44/44 preview, 0 console errors: starter N grenade / S stim / `active` 2, `setQuickSlot` refusals (locked E / ammo / range), move = one event, `consumeItem` qty + event + `stim:countChanged` + removed-at-0 + slot clear, `dropItem` clears, sibling relink, `reset()` / `player:respawn` re-apply, `bag_epic_tac` → 8 + event, unequip → 1, 8 cells with E W + diagonals locked + tooltip, badges ▲ ▼, rose DOM order, mouse drags (bag → N, → locked E refused, → S, cell → cell, cell → backdrop keeps the item, ammo refused), menu 등록 / 해제. Note: the dev server HMR-reloads the page when another agent edits a file mid-run — rerun, or run against a `vite build` + `vite preview` snapshot.

## 함선 화면 (hub Tab, 2026-09-06)
Tab in the **hub phase** opens the same window in `is-hub` mode (`InventorySystem.toggleBag()` → `ui.show(null, true)`; the crate window is unchanged):
screen tabs **인벤토리 · 캐릭터 · 기업 · 함선** on top (`.scr-tabs` from `ui/styles/base.css`; **Phase 8**: they no longer close the window — see the Phase 8 section) with the **크레딧** pill (`CREDITS n`) to their right,
then **함선 창고** (`GridId 'stash'`, `GridView('stash')` inside a scrolling `.inv-stash-scroll`) · **장비** (5 slots; two columns ≥ 1600 px wide) with the
**전술 임플란트 slot** under them (`ctx.implants.equipped`; click → inline picker of `getAllDefs()` cards, click = `setEquipped`, clicking the equipped card = unequip;
locked with a toast during a raid) · **가방** with the quick-use rose to its right (`.inv-bag-body` row).
- Moves: drag between stash / bag / slots, right-click quick action (stash ↔ bag; equipped item → 가방으로 이동 / 창고로 이동 via `moveToStash`), double-click equips.
  `locKind('stash')` is `'container'` (HUD counts treat the stash like a crate), so bag → stash emits `inventory:itemRemoved` and stash → bag `inventory:itemAdded`.
  **2026-09-12:** stash → bag carries **`fromStash: true`** (`emitTransfer`) — it is a move, not a pickup, so `ui/hud/Notifications` shows no 획득 ticker for it (사용자 결정). A crate / corpse → bag is unchanged.
- **수리**: right-click on a worn weapon / armor the player owns shows `수리` with the material cost as item chips (`repairInfo(uid)` → `ctx.loot.getRepairCost` → `renderItemCost`; armor is free) → `repair(uid)`.
  Slot meta shows the durability; `.is-worn` tints it. The terminal's 정비 tab is gone; the workbench menu remains for weapons.
- **No world drops in the ship**: `dropItem` returns false, the X key / drop zone / 버리기 entries are off; overflow from a bag swap or socket swap goes to the stash
  (`throwToWorld` → `stash.autoPlace`, toast `… → 함선 창고`) and only drops when the stash is full too.
- The hint bar hides in the hub; on a mission its R / X labels follow `Keys.ROTATE_ITEM` / `Keys.DROP_ITEM` (`input:bindingsChanged`), as do the slot keycaps (`slotKeyLabel`)
  and the quick-rose key (`Keys.QUICK`). The escape handler closes the implant picker / menu / dialog first.
- Events: `inventory:stashChanged {count}` after any change of the stash grid.
- Smoke: `npm run smoke:controls` covers the ship screen (layout, stash move + reload persistence, picker, repair menu, tabs).

## Phase 6 (2026-09-06): 무한 상자 · 창고 크기 · 프리셋 · 작업대 제작

### 무한 상자 (`/items` cheat catalog)
`openCatalog(opts?)` (console `/items`; Phase 9 `opts.category` preselects the tab that holds that category — the 훈련장 무기 거치대 passes `'primary'`, and on an already-open catalog it just switches the tab) shows the `CatalogView` as the leftmost panel of the inventory window — the ship screen in the hub, the bag window on a mission (refused with a toast in menus). It opens the window itself when needed (blocker `'inventory'`, `inventory:opened {containerId: null}`) and emits `ui:catalogToggled {open}`; `closeCatalog()` hides only the panel (the `닫기` button); **Tab** closes the whole window through `closeAll()` (which also closes the catalog) — since 2026-09-08 Escape does not, it only cancels a popup and otherwise opens the 일시정지 메뉴 over the window. `isCatalogOpen` is the state.
- One tile per `ItemDef` (every weapon grade is its own def; 124 tiles today), category tabs and a search box (Korean substring of the name; typing never reaches the game). Tooltips reuse `ui/Tooltip.ts` with a sample instance (`uid` `cat:<defId>`, qty = `catalogQty(def)` = `stackMax` for stackables, else 1).
- **Drag** a tile → the press mints `ctx.loot.createItem(defId, catalogQty)` (weapons loaded, full durability) and the normal drag runs with `DragState.catalog = true`: targets are the equipment slots and the active grids (bag; stash in the ship; the crate panel if one is open) — `previewCatalog` (free cell `ok` / same-def stack `merge` / slot `ok` or `swap`) and `dropFromCatalog` (grid place or `mergeInto`; slot equip with the displaced gear stowed bag → stash (ship) → refused; the bag slot goes through `changeBag(item, null, 'grid')`, i.e. a *detached* `next`). Wheel cells, weapon sockets and the world drop are not targets; releasing anywhere else just discards the fresh instance (`ui_error`). The tile never disappears. R rotates the ghost; X cancels the drag.
- **Double press** on a tile (two presses within 400 ms — detected in `beginCatalogPress`, because a cancelled pointerdown keeps Chrome from synthesising `dblclick`) → `takeFromCatalog(defId)`: `bag.autoPlace` (merge first), `inventory:itemAdded`, or `inventory:full` + shake + toast.
- Every catalog item entering the bag / a slot emits `inventory:itemAdded`; into the stash / a crate only `inventory:stashChanged` / `inventory:changed`.

### Stash size (housing 창고)
`getStashSize()` = the live grid dims; `setStashSize(cols, rows)` → `Stash.resize` (grow keeps every placement; shrink refused — returns false, nothing changes — when an item would fall outside) then `afterChange()` (persist via `markDirty`, `inventory:stashChanged`, the hub Tab screen re-renders the `GridView` at the new size inside its scrolling `.inv-stash-scroll`).
- **Startup**: `ctx.housing?.getStashSize()` (guarded with `typeof`) is applied **grow-only** — a persisted larger grid is kept (older facility state, a cheat `setStashSize(10, 30)` survives a reload) and a startup shrink could strand items. `housing:stashSizeChanged {cols, rows}` applies the size exactly (a refused shrink shows a warning toast).
- The save file (`scav.stash` v2) carries `cols` / `rows`; v1 saves load at 10×24.

### Materials across bag + stash
`countDefAll(defId)` = bag units + stash units. `consumeDefAll(defId, qty)` is all-or-nothing: false when the total is short, otherwise the **bag first** (`consumeWhere`, its usual events) then the stash smallest stacks first (empties removed, `inventory:stashChanged` through `afterChange`). Facility upgrades / furniture crafting (`housing/`) use these; recipe crafting and repairs still read the **bag only** (`countDef` / `countWhere`).

### Loadout presets (사격장)
`captureLoadout()` → `{ name: '프리셋', primary, primary2, secondary, bag, armor }` as def ids (null = empty slot) + `implant` (`ctx.progression.profile.implant`, else `ctx.implants.equipped`).
`applyLoadout(preset)` — **hub phase only** (elsewhere `{equipped: 0, missing: []}` and nothing changes). Per slot in `LOADOUT_SLOTS` order: `null` = leave the slot as it is; the same def already equipped counts as equipped; otherwise the **first instance with that def id in the bag, then the stash** moves into the slot (`equipFromStorage`: the displaced item goes to the bag, else the stash, else the cells the new item vacated; the bag slot runs `changeBag` and parks the old bag in the stash first when it would not fit the new grid); a def found nowhere **empties the slot** (`unequipToStorage`: bag → stash; the bag slot shrinks the grid as usual) and lands in `missing`. The implant goes through `ctx.implants.setEquipped(id)` (the same path as the Tab screen picker; a refusal lists the implant id in `missing`). Ends with `loadout:changed` + `afterChange()`; `equipped` counts slots (and the implant) that hold the wanted def afterwards.

### 작업실 bench crafting
`openBenchCraft(bench, level)` — hub only (toast otherwise). Sets the active bench (`getBench()` → `{kind, level}`), opens the ship screen if the window is closed, shows the craft panel in bench mode and emits `ui:craftToggled {open: true}`. `closeBench()` (panel `닫기`, the bag's `제작` button while in bench mode, or `closeAll`) clears it, cancels a running craft and emits `ui:craftToggled {open: false}`.
- **Rows**: `getBenchRecipes()` = `getRecipes('ship', kind, level)` (craftable) followed by the bench's recipes with `benchLevel > level` as **locked** rows (skill-gated recipes stay hidden, as everywhere else). `craft()` only accepts recipes of the active bench (`availableRecipes()`).
- **Cost multiplier**: `craftCostMul()` = `ctx.housing?.getCraftCostMul()` at the ship station (clamped to (0, 1], 1 without housing / on a mission); `craftCost(recipe)` = `ceil(qty × mul)` (min 1) — used by the chips, `canCraft` and the consumption in `updateCraft`, so the discount applies to every ship craft, not only bench mode.
- **Repair list**: `benchRepairRows()` — gun bench: every owned weapon (slots + bag, socketed or not); gear bench: armor + bags that track durability (bags have none today, so armor); gadget / medical: none (the list is hidden). Rows carry `getDurability`, the `getRepairCost` materials with bag counts and `short`. `수리` → `repair(uid)`; `benchRepairAll()` repairs worn rows in order while the materials last and returns `{done, skipped}`.

### `getRecipes(station, bench?, level?)`
Skill gate first (`ctx.progression.getSkill(r.skill) ≥ r.skillRequired`). `field`: `station: 'field'` recipes only (bench args ignored). `ship`: field recipes too; a recipe with `bench` needs that bench — with `bench` given, `r.bench === bench && (r.benchLevel ?? 1) ≤ level`; without one (the bag's `제작` panel, the legacy `hub_workbench`), a **placed** bench of that kind at that level (`ctx.housing.getBenchLevel(kind)`, 0 without housing — so bench recipes only appear once the 작업실 has the bench).

### Verification (Phase 6)
`node scripts/smoke-inventory-p6.mjs` 63/63, 0 console errors: catalog open/blocker/event, 124 tiles = defs, tabs + 무기 filter, search `붕대`, real-mouse drags (tile → free bag cell = full 폐금속 stack, tile → stash, AR III → 주무기 II loaded), double press → bag, Esc closes all; `setStashSize(10, 30)` + event, shrink refused with an item in row 29 / accepted at 26, Tab screen 300 cells + scroll, save v2 `cols/rows`, size kept after reload; `countDefAll` 4+7, `consumeDefAll` short refusal / 9 = bag 0 + stash 2 / 0 no-op; `captureLoadout`, `applyLoadout` (stash SMG → 주무기 I, missing def empties 주무기 II + reported, null untouched, armor from stash, implant `dash`, displaced gear stowed, no-op outside the hub); `openBenchCraft('gun', 2)` title / blocker / event, craftable rows = `getRecipes`, 6 locked level-3 rows, repair list with the worn 주무기 I cost, ×0.8 ceil costs + discount chip, `수리` restores durability, gear bench without weapons, gadget bench without a repair list, `닫기` leaves bench mode, refused on a mission; catalog on a mission (no stash) + `closeCatalog` keeps the window. Regression: `smoke-quickslots` 45/45, `smoke-controls-hub` 60/60.

### Known limits (Phase 6)
- Catalog drags cannot socket an attachment straight into a weapon tile or land on a wheel cell (take it into the bag first). No catalog item is ever a world pickup.
- Ship crafting and repairs still draw materials from the bag only; `countDefAll` / `consumeDefAll` (bag + stash) serve the housing facilities.
- `applyLoadout` swaps by *def id* only — the first matching instance wins (a worn / unsocketed copy may be picked over a better one).
- `openBenchCraft` shows the bench at the level the caller passes; it does not verify a bench is placed (that is the hub / housing side).

## Phase 5 (2026-09-06): loadout persistence · corp-shop access · 기업 tab

### Loadout persistence
See **Reset policy** above for the full event table. Shape of `scav.loadout` (v1, `Loadout.ts`):
```json
{ "v": 1,
  "slots": { "primary": { "defId": "wpn_ar", "qty": 1, "durability": 480, "ammoInMag": 30, "sockets": { "muzzle": { "defId": "att_suppressor", "qty": 1 } } }, "bag": { … }, "armor": { … } },
  "bag":   [ { "defId": "grenade_frag", "qty": 2, "rotated": false, "x": 0, "y": 0 }, … ],
  "quick": [ 0, null, null, null, 1, null, null, null ] }
```
Uids are session-local: every load mints fresh instances (`Serialize.reviveItem`, shared with the stash). Quick slots are stored as **indices into `bag`** and re-linked after the bag is placed (an entry that did not fit / merged away simply clears). The save file is only ever read at `init` — editing localStorage while the game runs changes nothing until a reload.

### Corp-shop access (`InventoryRef`, used by `meta/`)
- `getStashItems()` — read-only list of the stash stacks.
- `findItemAnywhere(uid)` — `findItem` (bag → slots → sockets of owned weapons), then the stash grid, then sockets of stashed weapons.
- `tryAddToStash(item)` — `stash.grid.autoPlace` (merges into same-def stacks first); `afterChange()` persists the stash and emits `inventory:stashChanged`. False when the def is unknown or nothing fits.
- `tryAddItemAnywhere(item)` — bag (`inventory:itemAdded`) → stash → `null`. Unlike `tryAddItem` it never emits `inventory:full`; the caller (shop / quest reward) reports. The stash is reachable in any phase (meta gates purchases to the ship).
- `takeItem(uid, qty?)` — bag / stash only (crate contents, equipped gear, socketed attachments → `0`); `qty` defaults to the whole stack, clamps to it, `< 1` → `0`. A bag stack that hits 0 leaves through `removeEmptyStack` (`inventory:itemRemoved`, wheel slot relinked to a sibling stack or cleared → `inventory:quickSlotsChanged`); a partial take bumps the grid version. Ends with `afterChange()` (counts, weight, stash persistence / event, hub save).
- `inventory:containerOpened {containerId, first}` fires after `inventory:opened` from both `openContainer` (`crate:open`) and `openContainerItems`; `first` = the id was not in the `ContainerStore` yet (the store is cleared on `game:newMission` / `world:ready`, so it is per mission).

### Ship screen additions
- **크레딧 readout** `.inv-credits` (top-right pill beside the `.scr-tabs`, hub mode only): `크레딧 n` from `ctx.meta.credits` (`크레딧 —` + `is-unavailable` without a meta system). Refreshed with every `refresh()` and on `meta:creditsChanged` while the window is open — the readout always reads `ctx.meta.credits`, the event only triggers the repaint.
- **기업 tab** is one of the embedded screens (Phase 8): `setTab('corp')` builds `ctx.meta.createCorpView(host)` into `.inv-screen` and the window stays open with its single `'inventory'` blocker. Since 2026-09-07 it is the **only** 기업 screen — the ship computer reaches it through `openScreen('corp')` (the standalone overlay and its `'corp'` blocker are gone). The older `openCorp()` / `relockLater()` flow described here through Phase 5 no longer exists.

### Verification (Phase 5)
`node scripts/smoke-loadout.mjs [url]` 45/45, 0 console errors: fresh save → starter on the first hub entry + `loadoutSaved starter` + file shape; gem + SMG (durability 123 / 5 rounds) in the ship → `loadoutSaved hub` → file → reload restores at init, identical snapshot after `hub:entered`, `loadout:changed` / `inventory:quickSlotsChanged` re-announced, no starter; `player:respawn` → starter saved immediately → reload keeps the starter; mission loot unsaved until a synthetic `game:complete` → saved → kept in the ship; `tryAddToStash` (+ stash file), `tryAddItemAnywhere` bag → `'stash'` when full, unknown def null; `takeItem` partial / whole / stash / equipped / unknown / qty 0 / quick-slotted stim clears S; `findItemAnywhere`; `crate:open` ×2 + `openContainerItems` ×2 → `first` true / false; ship screen 크레딧 readout + refresh, 기업 tab active → window closes + corp screen (blocker `corp`) or warning fallback, mission → warning only. Regression: `smoke-quickslots` 45/45, `smoke-controls-hub` 60/60 (its tab expectation now reads `인벤토리* 캐릭터 기업`), `smoke-inventory-p6` 63/63.

### Known limits (Phase 5)
- Mission changes are saved only on `game:complete`: a reload mid-mission returns to the last ship state (loot found on that mission is lost, the pre-mission bag comes back). Death / abort save the starter, so nothing is duplicated.
- The loadout save is per browser (localStorage), like the stash — not per profile / server.
- `takeItem` cannot sell an attachment that sits in a socket (detach first) or an equipped item (unequip first).
- `tryAddItemAnywhere` falls back to the stash even on a mission; nothing in the game calls it there today.

## Phase 7 (2026-09-06): 컨테이너 검색 (감정) · 호스트 권위 컨테이너 · canFit · 레이드 상태 · 서버 프로필

### Container search (Tarkov style)
Every item a container is filled with (crates via `rollCrate`, corpses / supply via `openContainerItems`) starts **`searched: false`** (`Container.fill`). Anything not from a container — starter kit, catalog, stash, pickups, crafted, purchased — has `searched` undefined, which means searched.
- **Reveal loop** (`updateSearch`, every frame while the container window is open): the first unsearched item in **grid order (top-left → bottom-right, row-major by cell)** accumulates `dt` while the player is within `SEARCH_MAX_DISTANCE` (4 m; the window itself only auto-closes at 6 m — between the two it stays open with the readout dimmed, `is-paused`). Time per item = `Gear.searchTimeFor(def, derived.searchSpeedMul)` = `SEARCH_TIME_BY_RARITY[rarity] × (1 + (w·h − 1) × 0.05) ÷ searchSpeedMul` (the table lives in `@/shared` since Phase 7; `Gear.ts` re-exports it; 감정 maxed = ×2 speed). When the time is up: `item.searched = true`, `container:itemRevealed {containerId, uid, defId, rarity}` (progression pays 감정 XP here), a soft `ui_pickup`, the tile re-renders; when nothing is left: `container:searchDone {containerId}` once per container (also for a container that is empty on open). `container:searchProgress {containerId, uid, progress}` is emitted at most 20 Hz (`SEARCH_EMIT_INTERVAL`) while progress advances.
- **Progress is kept on the container** (`searchProgress`, `searched` on the instances): closing the window pauses, reopening resumes the same item; a revealed item is never re-searched (`getOrCreate` returns the cached container). `game:newMission` / abort forget everything.
- **Unsearched items are inert**: `isItemLocked(uid, from)` gates `previewDrop / drop / dropPartial / quickMove / activate / equip / rotateItem / splitItem / dropItem / attachFrom / previewAttach / requestItem` (`'fail'` / `'bad'` / false), a searched item may not be merged into or swapped with an unsearched one, `takeAll` skips them, and the UI (`InventoryUI.locked`) shows no tooltip, no drag, no menu, no double-click, no middle-click request. Tiles render the **footprint mask** only (`GridView.isHiddenItem` → `.is-hidden-item`: neutral dashed tile, `?` / `???`, no rarity class / colour / qty / pips / durability / quick badge — nothing leaks the def).
- **Gauge**: the item being searched carries `.inv-tile-scan` (`--p` 0..100 %, cyan fill rising bottom → top under a moving sheen, tile `is-scanning`); `InventoryUI.setSearchProgress` is called every frame (one custom property, no re-render). The container header shows `감정 중 · n개 남음` / `감정 완료` (`.inv-search-status`).
- Anything that leaves a container is `searched: true` (`detach`, `dropOnSlot`, `attachFrom`, swaps, `takeOne`), so bag / slot items are always searched. `Serialize.ts` and `PickupWire.ex` never carry `searched` — a saved or dropped item is searched.

### Host-authoritative container takes (multiplayer)
Contents are still rolled per client (deterministic `seed ^ hash(id)`), only the **taken state** is shared (`ContainerMessage` / `ContainerRequest` in `@/shared/net`). `Container.order` = uids in roll order → the wire `idx`; `qty` = units.
- **Client** (`ctx.isMultiplayer && !ctx.isAuthority`): every container → player move (`drop` to bag / slot / weapon socket, `dropPartial`, `quickMove`, `activate`, `equip`, `attachFrom`, `dropItem`, each item of `takeAll`) goes through `guardedTake` → `requestTake`: `contq take {id, idx, qty}` to `'host'`, the op returns **`'pending'`** (new `OpResult`; the UI stays silent, the tile pulses `is-pending`, a second request for the same item is `'noop'`). `cont taken {by: me}` → `resolvePendingTake` replays the stored operation (also when the window closed meanwhile — the container is swapped in for the replay) and records `taken`; if the replay took less than granted (bag changed) the rest is removed anyway to stay consistent with the host. `cont denied` → pending dropped, `ui_error`, shake, toast `다른 대원이 먼저 가져갔습니다`. A request the host never answers expires after `TAKE_REQUEST_TIMEOUT` (8 s sim). `cont taken {by: someone else}` → `applyTaken` on my copy (window refreshed, `crate:looted` when it empties) or `ContainerStore.recordPending` for a container not opened here (applied on its first open). Only messages from `lobby.hostId` are trusted.
- **Nothing goes into a shared container**: in multiplayer bag / slot → container drops, quick-moves and swaps are refused (`refusesIntoContainer`), splits inside the container are refused (a new stack would have no `idx`), and gear displaced by equipping from a container goes to the bag only.
- **Host / single-player** run the move immediately; the multiplayer host (`trackTake`) diffs the item's qty before / after, records it and broadcasts `cont taken {by: me}` to `'others'`. A peer's `contq take` (`onContainerRequest`) is validated against the host's copy — a world crate it never opened is rolled on demand (`materializeCrate` via `ctx.world.getCrates()`); for a container it cannot roll (corpse it never opened) the **first take of an idx is granted, later ones denied** (`pendingTakenOf`) — then applied to its copy / recorded and broadcast to `'others'`; invalid → `cont denied` to the requester.
- **Sync**: `contq sync` and `flow rejoined` from a peer → `cont sync {items}` (`ContainerStore.takenWire()`: opened + pending maps) to that peer; `net:hostChanged {isLocalHost: false}` → the client drops its pending requests and sends `contq sync` to the new host; `cont sync` → `applySync` removes what this copy has not applied yet (per idx delta against `taken`) and stores unknown ids as pending. A newly promoted host simply keeps its own `taken` maps as the authority.
- Single-player keeps the old immediate path (no messages).

### `canFit` / raid state (InventoryRef)
- `canFit(defId, qty = 1)` → `'bag'` when the units fit the bag now (merge into stacks, then new stacks chunked by `stackMax` — a trial placement rolled back through `Grid.snapshot / restore`, version untouched), else `'stash'` in the hub phase, else `null` (also for qty < 1 / unknown def). The corp shop greys `공간 없음` from it.
- `captureRaidState()` → `RaidInventoryState` = the loadout save (`captureLoadoutSave`: 5 slots + bag placements with durability / rounds / sockets + quick slots as bag indices) `+ raid: 1` and a `searched` flag on every bag entry whose instance has one. **2026-09-11 (C-61)**: `+ bagWorn` = this raid's `missionSeed` while `bagWornThisRaid` stands (omitted otherwise). Opaque to game/ (raid session blob, training freeze).
- `applyRaidState(state)` → `sanitizeLoadoutSave` (false for null / wrong shape / version), cancels a running craft, `applyLoadoutSave` (slots, bag resize + placements, quick slots), restores the `searched` flags and announces like a restored save (`inventory:bagChanged`, `loadout:changed` / `equip:changed`, counts, `inventory:quickSlotsChanged`, `inventory:changed`, weight). **C-61**: also restores `bagWornThisRaid` — true only when `bagWorn` is **this** raid's seed (a missing field = 옛 blob = false; another seed, e.g. the 훈련장 snapshot, never carries a mark across raids), and remembers the stamp in `bagWornRestoreSeed`. Not saved to disk on a mission (the hub save policy is unchanged).

### Server profile documents
- After every stash write (`Stash.onSaved`) and every loadout write (`LoadoutStore.onSaved(reason, file)`, except reason `profile`) the file goes to `ctx.net.profile.set('stash' | 'loadout', file)` (net debounces the upload).
  **2026-09-11 (E-6)**: inside the merged flush both documents go up together as `setMany`; the corpse strip joins the empty
  loadout and the progression document the implant strip just saved (`joinProfileTx`). `net:profileLoaded` now carries **our
  queued document** for a key whose local edit won (net/ProfileSync revision merge), so the "identical to the local state"
  skip below also covers an offline session that was reloaded before it could upload — the server copy no longer replaces it.
- `net:profileLoaded {profile}`: the **stash** document replaces the local stash (`Stash.loadFrom` → grid rebuilt, local file rewritten without echo, `inventory:stashChanged`); the **loadout** document replaces slots / bag / quick slots (`applyLoadoutSave` + announce, local file rewritten with reason `profile`) — only outside a raid (`!ctx.isRaidActive()`, mid-mission the raid blob is the truth); an empty loadout doc in the hub applies the starter **only when the player has nothing anywhere** (2026-09-07 — it used to wipe a kit the player was standing in). A key the server has never seen gets the current local state uploaded.
- **Offline edits (Phase 9 — the local queue is gone)**: `offlineDocs` / `offlineArmed` / `suppressOfflineQueue` were removed. `uploadProfileDoc` now hands **every** save to `profile.set`, online or not: `ProfileSync` stamps it with `serverNow()`, keeps the newest document per key while offline and pushes it on the next connection, where the server decides newest-wins by stamp. What used to be "not an edit" is now a **`fresh` document**: `withFreshSave(fn)` sets a flag so every save `fn` triggers goes up as `profile.set(key, doc, {fresh:true})` — the server keeps such a document only while it has none for that key. Two callers use it: the fresh-browser starter kit on the first `hub:entered` and the startup stash resize to the 창고 facility size. So a brand-new browser can never overwrite a real server profile, and a genuine offline edit always survives.
- `onProfileLoaded` is correspondingly simpler: the record it receives is **already merged** (ProfileSync weighed its pending edits against the server's `docsAt`), so a present document just replaces the local state and a missing one gets the current local state uploaded — except an empty local loadout, which is not worth a document (the starter kit follows as a `fresh` one).
- A document that is **byte-identical to the current local state** (`InventorySystem.sameDoc`, JSON compare) is our own upload coming back inside that merged record: it is skipped entirely — no `Stash.loadFrom`, no `applyLoadoutSave`, no `loadout:changed`, no `inventory:loadoutSaved {reason:'profile'}`. Without it the very first welcome after the starter kit re-applied and re-saved the starter under the reason `profile` (the fresh save is queued in `ProfileSync`, so it is part of the merged record).

### Verification (Phase 7)
`node scripts/smoke-search.mjs [url]` **51/51**, 0 console errors (registered in `scripts/verify.mjs` for `inventory`; run against a private `npx vite --port 5306` while other agents edit): `searchTimeFor` (table / bulk / ÷ mul / invalid mul) + `serializeExtras` without `searched`; `canFit` exact bag capacity → bag, +1 → stash (hub), qty 0 / unknown → null, non-mutating; profile hooks (`profile.set('stash')` v2 / `('loadout')` v1 after saves, `net:profileLoaded` replaces stash + loadout with events + local mirror without echo, an offline save is still handed to `profile.set` and the merged record carrying it back changes nothing, a missing key is uploaded, plus the real `net/ProfileSync` merge driven directly: newer local stamp wins + is flushed with its `at`, older loses, `fresh` only fills an absent key); a tier-3 crate opens fully hidden (footprint tiles, no rarity leak, `감정 중` readout), every operation / tooltip / menu / drag / double-click refused on an unsearched item, one gauge on the top-left item, reveal order = grid order, timing ≈ table × bulk per item and in total, progress events ≤ 20 Hz (19.4 measured), `searchDone` once, a revealed item moves to the bag `searched: true`; `모두 가져가기` takes only the searched items that fit; 5 m away the window stays open but nothing accumulates (`is-paused`), back in range it fills, closing keeps progress + flags, reopening resumes the same item; corpse contents (`openContainerItems`) start unsearched; maxed 감정 halves the first reveal; `captureRaidState` shape (durability 123 / 5 rounds / muzzle socket / `searched` flags) and `applyRaidState` refusals + exact round-trip + events; synthetic multiplayer through the real `NetSystem` handlers (`inSession` / `isAuthority` / `localId` / `lobby` shadowed, `send` spied): client `contq take` → pending + pulse + no double request, into-container / split refused, `cont denied` shake + toast, impostor `cont taken` ignored, host's `cont taken` lands the item, a peer's take removes it, a take before the first open is applied on open, `net:hostChanged` → `contq sync`, `cont sync` catch-up (opened + pending); host: own take broadcasts `cont taken` to others, a peer request is applied + broadcast, a second take denied, `contq sync` / `flow rejoined` → `cont sync`, an unrolled container grants the first take only.
Regression on the same vite: `smoke-loadout` 46/46, `smoke-quickslots` 45/45, `smoke-inventory-p6` 63/63, `smoke-controls-hub` 60/60. `npm run typecheck` 0 errors.

### Known limits (Phase 7)
- The host validates a container it cannot roll (a corpse it never opened) by "first take of an idx wins" — two players taking different parts of the same stack there are not both granted. Corpse contents are rolled by enemies/ on the opener's client, so the host has no copy until it opens the corpse itself.
- A confirmed take the client cannot fit any more (bag changed during the round trip) is removed from its copy anyway (host consistency) — the units are lost for that player.
- Local rearranging inside a shared container (moves / rotation) is per client; search order follows each client's own grid layout.
- `container:searchProgress` stops while the player is out of range; there is no event for "paused" (the UI reads it from `setSearchProgress`).
- ~~Profile documents carry no timestamps~~ — **closed in Phase 9**: `profile:set` carries `at` / `fresh`, the server keeps `docsAt` per document and the newest write wins; `ProfileSync` no longer drops an offline `set`, so this folder's own queue was deleted (see *Server profile documents* above).

## Phase 8 (2026-09-06): Tab 화면 호스트 · 모달리스 팝업 · 아이템 분해 · 요구 아이템 칩

### Tab 화면이 캐릭터 / 기업 / 함선을 품는다
The hub Tab window is now the single screen. `SCREEN_TABS` = **인벤토리 · 캐릭터 · 기업 · 함선**; the pill (`.scr-tabs`) is
shown **only in hub mode** (before Phase 8 it also drew over a mission crate window — fixed), and the 함선 button hides
itself when there is no `ctx.housing`.

- Selecting a tab no longer closes the window and opens a separate full-screen popup. `InventoryUI.setTab(tab)` hides
  `.inv-layout`, shows the `.inv-screen` host and builds the owning folder's **`EmbeddedView`** into it:
  캐릭터 → `ctx.progression.createSheetView(host)`, 기업 → `ctx.meta.createCorpView(host)`, 함선 → `ctx.housing.createShipView(host)`.
  `refresh()` runs when the tab is shown and on every window `refresh()`; `dispose()` runs when the tab is left, when the
  window closes (`hide()` returns to 인벤토리) and in `dispose()`. Exactly one view exists at a time.
- The window keeps **one blocker** (`inventory`) for the whole screen; embedded views must not add their own, exit the
  pointer lock or install an Escape listener. The blurred `.inv-root` backdrop is the 배경 블러 the design asks for, and
  since the **Phase 8 UI pass** `.inv-screen` carries the same opaque panel chrome as `.inv-panel` (background, border,
  radius, shadow, padding) so the embedded screens are readable instead of floating straight on the blur.
- A missing owner (no `ctx.progression` / `ctx.meta` / `ctx.housing`, or a throwing `create*View`) is not fatal: the tab
  snaps back to 인벤토리, plays `ui_error` and shows `.inv-screen-note` (`… 정보를 사용할 수 없습니다`).
- `InventorySystem.openCharacter()` / `openCorp()` are **removed** (nothing else called them).
- Smoke handles: `.scr-tab` buttons, `InventoryUI.screenTab`, `.inv-screen` (`hidden` mirrors the active tab).

### 모달리스 팝업 (`ui/Modeless.ts`)
Three popups float above the window in `.inv-modeless-layer` while the grid stays visible **and interactive** behind
them. None of them adds a `ctx.uiBlockers` token or touches the pointer lock — the window already owns both — and all
three are dismissed by the window's existing Escape chain (`closeOverlays()`, which now returns true for them), by their
`닫기` button, or by a capture-phase `pointerdown` outside the panel *and* its anchor.

| Popup | Opened by | Notes |
|---|---|---|
| 전술 임플란트 picker (`.inv-modeless-implant`) | the implant slot on the equipment column | **Phase 8 UI pass**: a **centred, fixed-size** panel (380 × min(620px, 100vh − 140px)) whose card list scrolls inside it, opened with `open(slot, true)` so the slot still toggles it; the `장착 중 · 클릭해 해제` label hangs **under the description** (`.body::after`) instead of off the right edge of the row. Same `ctx.implants.setEquipped` API, equipped card = unequip, raid lock unchanged |
| 필드 제작 / 작업대 (`.inv-panel-craft`) | the bag's `제작` button, or `openBenchCraft(kind, level)` | **2026-09-07**: back to a **column of the window** (it was a modeless popup in Phase 8). `.inv-layout.is-craft` puts the recipe list leftmost — where 함선 창고 sits otherwise — and `.inv-col-right` stacks 가방 over 함선 창고 on the right; in a raid the row is 제작 · 장비 · 가방 + 퀵슬롯. `CraftPanel` keeps every renderer. `닫기` leaves the bench in bench mode, otherwise closes the column. Closing the window closes it too. **2026-09-08**: `.is-craft` also lands on `.inv-root` and *hides* 장착 장비 + 임플란트 열 · 퀵슬롯 로즈 · 상단 화면 탭 · 가방의 `제작` 버튼 · 하단 가치 — 제작 화면에는 레시피와 재료만 남는다 (가방 용량은 남긴다). 장비 칸이 없으니 만든 무기를 장착하려면 창을 닫아야 하고, 튜토리얼의 `openBag` 단계가 그 순서를 안내한다 |
| 아이템 분해 (`.inv-modeless-disassemble`) | the item context menu's `분해` entry, or `InventoryRef`-level `openDisassemble(uid)` | centred; see below |

### 아이템 분해
The four `break_ammo_*` recipes are gone from the craft list (`getBenchRecipes()` filters `isDisassembleRecipe`, i.e.
any `break_*` id) — `getRecipes()` and `craft()` still know them, so nothing else changed about crafting.

- `disassembleRecipeFor(uid)` returns the `break_*` recipe whose **only** input is that item's def id (the ammo packs
  today), or null. The context menu adds a `분해` entry for any **bag** item with one (a crate / 창고 stack has to be
  taken into the bag first, because the recipe consumes from the bag) and `hasMenu` counts it, so even a 1-round stack
  opens the menu instead of quick-moving.
- The entry opens `DisassemblePanel`: `재료` (input chip, 보유/필요, dimmed + red when short) `→` `결과물` (output chip
  `×n`) and a `분해` button. The button runs `sys.craft(recipe.id)` (the button fills as the hold runs, a second click
  cancels, `분해 완료` / `분해할 수 없습니다` for 2.5 s) and the dialog closes itself when the source stack is gone.
  **2026-09-08**: it refuses **before** the hold when the materials are short *or* the bag has no room for the output
  (`craftHasRoom`, the same test `updateCraft` makes at the end) — the reason replaces the button label.
- `ui:disassembleToggled {open, uid}` is emitted on both edges (`uid` is the item on close as well).

**2026-09-10 (제작 대개편 2단계) — 미리보기는 실제와 같아야 한다.** 분해 산출은 이제 `그 아이템의 제작 재료 ×
남은 내구도 구간의 배수`(내림)다. `getAllRecipes()` 에 실려 있는 `break_*` 줄은 **구간 4(81~100 %) 기준**이므로
그것을 그대로 쓰면 다 망가진 총도 새 총만큼 뱉는다 — 실제로 내구도 5 % 인 방탄복 I 이 만피와 똑같이
`폐금속 4 + 천조각 2` 라고 적혀 있었고 그대로 나왔다(정답은 `폐금속 1`).

- `disassembleRecipeFor(uid)` 는 이제 `ctx.loot.getSalvageFor(inst)` **하나**를 돌려준다. `id` 는 `getAllRecipes()`
  의 그 줄과 같고 달라지는 것은 `outputQty` / `extraOutputs` 뿐이다.
- `parts/Crafting.resolveRecipe(sys, recipe, targetUid)` 가 그 변환의 단일 지점이고 **세 곳**이 지난다:
  미리보기(`disassembleRecipeFor`) · 자리 검사(`craftHasRoom(id, count, targetUid)`) · 실제 소비/산출
  (`updateCraft`). 셋이 어긋나면 "목록에 뜬 숫자와 실제로 나온 숫자가 다르다" 가 된다.
- `craft(recipeId, uid)` 의 게이트는 **바뀌지 않았다** — `craft()` 는 여전히 정적 레시피로 `availableRecipes`
  동일성과 `canCraft` 를 보고, 두 레시피의 `inputs` 는 어차피 같다. 다시 푸는 것은 홀드가 끝난 뒤다.
- 팝업은 **매 `refresh()` 마다** 다시 푼다(열 때 한 번이 아니다). 미리보기 밑의 `.inv-dur-note` 가
  `남은 내구도 · 21~40 % · 제작 재료의 16 % · 내구도가 낮을수록 나오는 재료가 적습니다` 를 말하고,
  내구도가 없는 아이템(탄약 · 재료)에서는 그 줄이 숨는다.

### 요구 아이템 칩 (`buildItemChip` / `renderItemCost` from `@/shared`)
Every material requirement this folder renders is now a **thumbnail with 보유/필요 at the bottom right**, dimmed with a
red 보유 number when short (`.is-short`) — text chips are gone:

- `ui/CraftPanel.ts` recipe rows (`.inv-craft-costs` inside `.inv-craft-inputs`) and the 수리 팝업
  (`ui/RepairPanel.ts`: `.inv-repair-cost` per row + the summed `.inv-rep-total-chips`).
- The 수리 context-menu entry: `MenuEntry.costs` (new) is an element the menu adopts on a second line
  (`.inv-menu-item.has-costs` / `.inv-menu-costs`).
- The 분해 dialog (both sides of the preview, `withName: true`).

The `.item-chip*` CSS itself is **owned by `src/ui/styles/base.css`** (Phase 8 contract) — this folder only positions
the chips.

### 크레딧 라벨
`TEXT.credits.value(n)` returns the bare `n.toLocaleString('ko-KR')` (`none` = `—`), so the pill's `CREDITS` eyebrow +
value reads **`CREDITS 500`** instead of `CREDITS 크레딧 500`.

### 씨앗
`ItemCategory 'seed'` gets its own 무한 상자 tab (`CATALOG_TABS` += `{ id: 'seed', label: '씨앗', categories: ['seed'] }`,
after 약초). Seeds are otherwise ordinary 1×1 stackable items — no other change in this folder, and no exhaustive
`Record<ItemCategory, …>` lives here.

### Known limits (Phase 8)
- The embedded views are refreshed on every window `refresh()`; a very expensive `EmbeddedView.refresh` would be felt
  during a drag (none of the three is today).
- A modeless popup is never re-opened after the window closes: `hide()` runs `closeOverlays()`, which closes all three.
- The 분해 dialog runs one craft at a time (it shares the system's single `craftJob` with the craft panel), so opening
  it while a craft is running cancels that craft.
- `분해` is offered on bag items only; a stash / crate stack shows no entry even when the bag holds enough of the same
  ammo to run the recipe.
- The craft popup is parked at the right edge by CSS rather than anchored to the 제작 button — on a very narrow window
  it can overlap the equipment column.

## Phase 8 UI pass (2026-09-06)
- **전술 임플란트** is a centred fixed-size panel with its own scrollbar (see 모달리스 팝업 above); the 장착 중 label
  moved under the description.
- **필드 제작 / 작업대**: a dimmed row (`.is-locked`, `.is-bench-locked`) is now dimmed by **colour**, never by
  `opacity` — an alpha row let the blurred world show through it and the recipe became unreadable. The row keeps an
  opaque background and mutes its own text / chip thumbnails instead.
- **`.inv-screen`** (캐릭터 / 기업 / 함선 tabs) has the panel background described above.
- Every cost chip the folder renders through `buildItemChip` / `renderItemCost` now carries `data-def-id`, which
  `ui/hud/ItemTip` turns into an inventory-style hover card — the craft rows, the repair list, the 분해 dialog and the
  context menu all get item tooltips for free. The folder's own `ui/Tooltip.ts` (instance-level: durability, sockets,
  loaded ammo) is unchanged and still owns the grid tiles.

## Phase 9 UI pass (2026-09-07) — `ui/TradeGrids.ts`

`InventoryRef.createTradeGrids(host, opts)` renders the player's **real 가방 / 함선 창고 grids** into another folder's
screen (the 기업 거래 desk) with the same `GridView` the Tab window uses. Deliberately narrow: **read + drag-out only**
— no rearranging, no rotation, no socketing, no drop-to-world. A tile dragged onto one of the caller's `dropSelector`
targets (or double-clicked) calls `onTake` with the `ItemInstance`; everything the caller then does to the item goes
through the public `InventoryRef` API (`takeItem` / `tryAddItemAnywhere`). `isStaged(uid)` dims tiles the caller has
already staged. The view adds **no blocker, no pointer-lock call and no window key listener** — the caller's shell owns
those — and `dispose()` removes exactly what it added.

Known follow-ups: the drag ghost is a plain tile copy (no rotation preview, no stack split — a drag stages the whole
stack), and there is no tooltip inside these grids.

## Phase 9 UI/UX 개선 pass (2026-09-07)

- **인게임 가방 = 함선 가방 − 창고.** The mission window now uses the ship layout: panel order is
  `상자 · 장착 장비 · 가방 · 제작` (it used to be `상자 · 가방 · 제작 · 장비`), the equipment column is the two-column
  grid (`primary / primary2 / secondary` left, `armor / bag` right) and the quick-use rose sits to the right of the bag
  grid. The wide arrangement needs room, so it is gated at **1280 px** on a mission and stays at **1600 px** in the
  ship (which also carries the 창고 panel). The 버리기 zone and the key-hint bar remain mission-only — a raid still
  needs to throw things away.
- **전술 임플란트 slot moved out.** `buildImplantSlot` / `refreshImplant` / the `implant` `Modeless` picker and every
  `.inv-slot-implant` / `.inv-implant-*` style are gone from this folder; the implant is chosen on the **캐릭터 tab**
  (`progression/ui/SheetBody`, which owns its own labels). `TEXT.implant` was removed from `ui/labels.ts`.
  `inventory:*` still triggers a window refresh on `implant:equipped`, which is now only cosmetic.
- **`ui/TradeGrids.ts`** stamps `data-item-tip` + `data-def-id` on every tile it renders, so the shared
  `ui/hud/ItemTip` hover card describes a 기업 거래 tile — this view still owns no tooltip of its own.

## 2026-09-08 UI pass — 장착 슬롯 카드 · 패널 합치기

- **장착 슬롯은 한 크기의 카드다.** The slot box used to be the item's own grid footprint (무기 4×2, 방탄복 2×3,
  가방 2×2) with the tile scaled down to fit, so a 5×1 저격소총 drew visibly *smaller* than a 4×2 돌격소총 — the
  footprint is a bag-packing property and says nothing about the gun. Every slot is now the same box
  (`3 × --inv-cell` wide) and the item fills it as a card: **이름 좌상단 · 소켓 우상단 · 발수 좌하단 · 내구도
  우하단**(한 단계 작게) over the green durability bar along the bottom edge. The footprint still shows up where it
  matters — in the drag ghost.
- **`.inv-slot-meta` 삭제.** The sentence under each slot (`돌격소총 I · 45/45발 · 내구도 500/500`,
  `방탄복 III · 피해감소 24% · 내구도 228/380`, `희귀 가방 · 8×6 · 퀵슬롯 4`) is gone; the card carries all of it,
  and 방탄복 / 가방 get the same bar + bottom-right reading a gun gets. A 가방 has no `durabilityMax` today, so its
  card simply draws no bar — it will the moment bags get durability.
- **`GridView.buildSlotCardContent(el, item, def, stats)`** is that renderer, shared with the read-only 분대원 장비
  view (`ui/CrewLoadoutView`) so the two can never drift apart. It keeps the `.inv-tile` (+ `.is-weapon`) +
  `data-uid` contract the drag / socket-drop / tooltip code matches on, and returns whether the item is worn so the
  caller can flag `.inv-slot.is-worn`.
- **장비 + 가방 = 하나의 패널.** They are already neighbours in the flex order, so the 24 px gap between them is
  cancelled and the two touching edges are squared off (`.inv-layout:not(.is-craft)` — the 제작 layout stacks 가방
  over 함선 창고 in a real column, where the join would mean nothing). The headings that separated them are gone:
  the 장비 eyebrow, the bag panel's `INVENTORY` eyebrow + `가방` title, and the quick rose's whole legend
  (`QUICK USE` / `빠른 사용` / the "끌어다 놓기" hint). The grids, the compass glyphs and the centre key cap say it.
- **읽어야 할 숫자만.** The capacity readout left of 제작 is `used / total` — the `5×3` grid size and the
  `퀵슬롯 n` count both restated what the grid and the rose draw right below it. And the 가치 readout now counts the
  **equipped** gear too (`equippedValue()`), so equipping a rifle no longer drops the number you are carrying out of
  the raid.

## Phase 10 UI 개선 pass (2026-09-07)

### 컨테이너 실시간 루팅 (`container:itemTaken`)
`cont taken` was **always** broadcast to `'others'`, so a squad mate's take already reached every client and
`applyRemoteTaken` already removed the item — what was missing was the presentation and a way to tell a live take from
a catch-up. One private helper (`InventorySystem.emitItemTaken`) is now the single emitter of
**`container:itemTaken {containerId, idx, uid, qty, remaining, by, byName, byLocal, live}`**:

| Path | `live` | `by` |
|---|---|---|
| `trackTake` — my own take (single-player or host) | `true` | `null` in single-player, my `localId` in a lobby (`byLocal: true`) |
| `resolvePendingTake` — my `contq take` confirmed | `true` | my `localId` (`byLocal: true`) |
| `applyRemoteTaken` — another member's confirmed take | `true` | the taker (`byName` from `net.getLobbyPlayer(by)?.name`) |
| `onContainerRequest` — the host applying a peer's request to its own copy | `true` | the requester |
| `ContainerStore.applySync` / `applyPending` (new `onTaken` hook) | `false` | `null` — a `cont sync` / first-open catch-up is silent |

- `uid` is read with `Container.uidAt(idx)` **before** `applyTaken` drops the placement, so a consumer can still match
  the tile that disappeared; `remaining` is what is left in **this** copy.
- **Exit animation**: a live take by someone else calls `InventoryUI.vanishContainerItem(uid)` → `GridView.vanish(uid)`
  *before* the refresh, so the removal loop in `refresh()` adds `.is-vanishing` and deletes the node after
  `CONTAINER_TAKE_ANIM_S` instead of removing it synchronously. The keyframes (`inv-vanish`, next to `inv-pop`) drive
  only the **`translate:` / `scale:` / `opacity`** channels — `transform` is the tile's cell position and an animation
  on it would fight the layout — and the values come from `CONTAINER_TAKE_RISE_PX` / `_END_SCALE` through
  `--vanish-*` custom properties. A drag of that very item is cancelled first (it is not ours any more).
- **`rem` / `seq`** (`ContainerMessage`): the host stamps every `cont taken` with its own `remainingAt(idx)` and a
  monotonic per-container counter (`ContainerStore.nextTakeSeq`). A receiver drops a duplicate / out-of-order message
  (`acceptTakeSeq`; a message without `seq` from an older peer is always accepted) and, when its own copy still holds
  more units than `rem`, removes the difference so the copies converge. `net:hostChanged` resets the filter
  (`resetTakeSeq`) because a promoted host counts from 1 again.
- Fixed along the way: the search gauge state (`GridView.scan`) is cleared when the scanned tile is removed by a
  remote take — it used to linger until the next `updateSearch` frame.

### 분대원 장비 열람 (`ui/CrewLoadoutView.ts`)
`captureCrewLoadout()` = `captureLoadoutSave()` **without** the per-container `searched` flags (a crew card is public;
`captureRaidState()` is the one that keeps them). `createCrewLoadoutView(host, loadout, opts)` renders another member's
document read-only: `sanitizeLoadoutSave` validates it (a non-loadout → `null`), `Serialize.reviveItem` mints fresh
instances on a **throwaway `Grid`** (unknown def ids are skipped with a warning, so does anything that no longer fits),
and the real `GridView` / `buildTileContent` draw the tiles with **every `TileHandlers` entry a no-op** — no drag,
rotation, socketing, context menu or drop, and nothing touches the local inventory. Blocks default to
`['equip', 'bag', 'quick']`: **no 함선 창고 column and no 크레딧 pill**. Tiles carry `data-item-tip` + `data-def-id`,
so the shared `ui/hud/ItemTip` describes them. Like `ui/TradeGrids.ts` it is an `EmbeddedView`: no `ctx.uiBlockers`
token, no pointer-lock call, no window Escape listener — the popup frame belongs to `hub/`. Because the view lives
outside `.inv-root`, `.crew-loadout` re-declares the `--inv-*` palette tokens in `inventory.css`.

### 크레딧 표기
`ui/labels.ts`'s `fmtValue` is `formatCredits` from `@/shared` (the `₩` prefix is gone — `1,200 C`), which also changes
the bag footer's 가치 readout, and `TEXT.credits.value` routes through `formatCreditAmount`. The tooltip's 가치 row
left the stats table and became the card's **bottom bar** (`.inv-tt-value`: label left, amount right; a stack shows
`단가 × 수량` beside the total from `itemCreditValue(def, qty)`) — the same shape as `ui/hud/ItemTip`'s bar.

### 인게임 커서
`setOpen` calls `ctx.input.setCursorMode(true | false, 'inventory')` instead of `exitPointerLock()`, and `relockLater`
is gone. The three `document.elementFromPoint` hit tests (`quickCellAt`, `weaponTileAt`, `isOverPanel`) were
**verified, not assumed**: all three are fed `e.clientX / e.clientY` of the event being handled, and a synthesised
`SoftCursor` event carries the virtual position in exactly those fields — no change needed. Nothing in this folder
polls `input.mouseX / mouseY`. The modeless popups (`ui/Modeless.ts`) still take no blocker and no cursor owner of
their own; the window's ref-counted token covers them.

### Known limits (Phase 10)
- `container:itemTaken` is emitted for a container this client has **not** opened only through the catch-up path
  (`live: false`, `uid: null`); a live take for an unopened container is recorded in `pendingTaken` and stays silent
  until the first open, because there is no local copy to name the item from.
- The vanish animation is only for **other** members' takes. My own take already moves the tile into the bag, and
  animating both ends would double the motion.
- `rem` convergence only ever *removes* units (the host is authoritative); a copy that somehow holds fewer units than
  the host is not refilled.
- The crew view is a **snapshot**: `refresh()` only repaints what was minted, so new data means building a new view.
  It has no tooltip of its own (it relies on `ItemTip`), shows no 무게 / 크레딧 totals, and its bag grid size comes
  from the document's 가방 slot — a member with no bag renders the 5×3 default.
- Since the window keeps the pointer lock, closing it with **Escape** (which Chrome always uses to drop the lock)
  leaves the player unlocked until the canvas is clicked again — the same fallback GameFlow already has for any other
  lock loss. Tab / a click keeps the lock throughout.

## 2026-09-07 UI/UX pass — 드래그 · 제작 열 · 화면 탭 · 그리드 칸 크기

- **드래그 고스트가 커서 중앙에 붙는다.** `ui/InventoryUI.beginPress` / `beginCatalogPress` 는 이제 잡은 지점이
  아니라 발자국의 절반(`tileSize(w,h) / 2`)을 `grabX / grabY` 로 쓰고, `rebuildGhost` 는 회전 뒤에도 다시 가운데로
  맞춘다. 드롭 셀 계산(`cellForGhost`)은 고스트의 좌상단으로 하던 그대로라 "커서가 가리키는 칸에 놓인다"가 된다.
- **드래그 중 윈도우 커서가 번쩍이던 문제.** `.inv-root.is-dragging *` 의 `cursor: grabbing !important` 가
  `body.soft-cursor-on *` 의 `cursor: none !important` 보다 명시도가 높아 실제 OS 커서를 되살리고 있었다. 규칙을
  `body:not(.soft-cursor-on)` 로 한정했다 (`inventory.css`). **2026-09-07 커서 rework 로 무효**: 소프트 커서가
  사라져 `.inv-root.is-dragging { cursor: grabbing }` 은 폴백일 뿐이고, 드래그 중 커서는 `ui/hud/GameCursor` 가
  그 규칙을 미러링해 만든 **잡기 아트**다.
- **제작이 다시 창의 열이다.** Phase 8 의 모달리스 팝업(`Modeless('craft')`)을 걷어내고 `CraftPanel.el` 을
  `.inv-layout` 에 직접 넣는다. `setCraftOpen` 이 `.inv-layout.is-craft` 를 토글하면 제작 목록이 맨 왼쪽(함선 창고
  자리)으로 가고, 새 래퍼 `.inv-col-right` 가 평소의 `display: contents` 를 벗고 실제 열이 되어 **가방 위 · 함선
  창고 아래**로 쌓인다. 레이드에는 창고가 없으므로 그대로 `제작 · 장비 · 가방 + 퀵슬롯`이 된다. 블로커 · 포인터 락은
  예전처럼 창의 것이다.
- **`openScreen(tab)` / `screenTab`** (`InventorySystem`, `InventoryRef`): 함선에서 Tab 창을 특정 화면 탭으로 연다.
  `ctx.meta.openCorpMenu()` 가 이걸 부르면서 기업 전용 오버레이가 사라졌다 — `ui/InventoryUI.showScreenTab` 이
  실제로 그 탭이 떴는지 돌려준다(허브 밖이거나 해당 폴더가 없으면 인벤토리 탭으로 되돌아간다).
- **그리드 칸 크기가 뷰마다 다를 수 있다.** `GridView` 가 생성자 인자로 `cell` 을 받아 타일 · 셀 레이어 · 하이라이트 ·
  드래그 셀 계산을 전부 그 값으로 하고(`--inv-cell` 을 자기 루트에 찍는다), `buildTileContent(..., cell)` 과
  `labels.tileSizeAt(w, h, cell)` 이 그 계산의 공용 지점이다. `TradeGridsOptions.cell` 로 노출되며 기업 거래 화면이
  40 px 을 넘긴다 — Tab 창 · 컨테이너는 기본 54 px 그대로다.

### Known limits (2026-09-07)
- 제작 열이 열려 있을 때 컨테이너 패널(레이드 중 상자)은 제작 열의 **오른쪽**에 남는다 (`order` 만 바꿨을 뿐 자리를
  옮기지는 않았다). 무한 상자 카탈로그는 제작 열보다 더 왼쪽(`order: -2`)이다.
- 오른쪽 열은 `max-height: calc(100vh - 140px)` 안에서 스크롤한다. 짧은 창에서는 함선 창고 격자가 먼저 줄어든다
  (`.inv-layout.is-craft .inv-stash-scroll`).
- `GridView` 의 `cell` 은 생성 시점에 고정이다. 살아 있는 뷰의 칸 크기를 바꾸려면 뷰를 새로 만들어야 한다.


## 2026-09-08 — Tab 으로 닫는다

The window (bag, container, and the 캐릭터 / 기업 / 함선 tabs alike) **no longer closes on Escape**. `Keys.INVENTORY`
(Tab) is both the open and the close key; the Tab poll additionally ignores the press while `MENU_BLOCKER` is up, so
it cannot reach through the 일시정지 메뉴 stacked on top.

Escape still cancels the **innermost popup**: the capture-phase handler calls the new `InventoryUI.closePopups()`
(split dialog · right-click context menu · 분해 dialog) and swallows the key **only** when one of them was open;
otherwise it falls through to `game/` and the menu opens over the window. `closeOverlays()` keeps its old meaning
(popups **+** the 제작 column) for the internal close path — the 제작 column is a column of the window, not a popup,
so it deliberately stays open under the menu.

## 2026-09-08 Phase 12 — 분해 게이지 · 회복 스프레이 수리 · 임플란트 아이템 (`docs/DECISIONS.md` Phase 12 · #7 · #9)

Data-driven off the frozen contract (`ItemCategory 'implant'`, `ItemDef.implant`, `PERK_DEFS`, `HEAL_SPRAY_GAUGE` 200,
`inventory:disassembleProgress`); the implant defs themselves are items/ (`imp_<stat>_<1..4>`, `imp_perk_*`,
`imp_broken_*`). Nothing in `src/shared` or another folder changed for this.

- **분해 게이지** (`ui/DisassemblePanel.ts`): the `분해 중…` **button itself** fills 0 → 100 % (`.inv-craft-fill`) — its width is
  written per frame by the cheap `tick()` (called from `InventoryUI.refreshCraft`, which `InventorySystem.updateCraft` already
  runs every frame the job advances; `refresh()` still rebuilds the chips and ends in a `tick()`). **2026-09-08**: the second
  horizontal bar that used to sit under the button (`.inv-dis-bar`) is gone, and so is the `1회 분해 · n s` hint line above it —
  the button is the only gauge, and `barEl` now returns it. The panel reports the hold through a fourth constructor callback → the window emits
  `inventory:disassembleProgress {uid, t, done}`: throttled to `PROGRESS_EMIT_MS` (≤ 30 Hz) while running, **exactly
  one** `{t:1, done:true}` when the recipe completes, and `{t:0, done:false}` when a cancel (second click / 닫기 / outside
  click / death) resets a hold that had already been reported. `barEl` / `progress` are exposed for the smokes.
- **회복 스프레이 수리** (`InventorySystem.repair` / `repairInfo`): in the ship the right-click **수리** entry (the same
  `repairInfo` path armor uses) offers a spray whose `durability < durabilityMax` for **캔 1 + 소독약 1 per full refill**
  (`SPRAY_REFILL_COST`, existing `mat_can` / `mat_antiseptic` defs), scaled by the missing fraction with ceil and a floor
  of 1 each (`sprayRepairCost(item, def)` — so today it is always 1 + 1). Materials come from the **bag**, like a weapon
  repair; all or nothing; the result is `durabilityMax` (200). A can at **0 is a valid item everywhere**: nothing here
  removes it (`updateItem` / `reviveItem` / `serializeExtras` all keep an explicit 0 — `?? max` only fires on
  `undefined`), the tooltip shows `게이지 0 / 200` (new row for `def.heal.spray`), and `GridView` now draws the same thin
  durability bar under a spray tile (`appendDurabilityBar`, `is-broken` at 0) that weapons have.
- **임플란트 아이템 표시** (`ui/Tooltip.ts`): `장착칸 n`, one `근력 +2` line per `implant.stats` entry (names from the new
  `getStatName` lookup → `ctx.progression.getStatDef`), a `.inv-tt-perk` paragraph with the `PERK_DEFS` name +
  description for legendaries, and for `broken` ones the red `.inv-tt-broken` line `망가짐 — 세레스 바이오에서 수리` plus
  `repairCost` as `renderItemCost` chips (보유 = `countDefAll`, bag + 창고, through the new `countOwned` lookup). The 무한
  상자 has an **임플란트** tab (`CATALOG_TABS`, label `CATEGORY_LABEL_KO.implant`), listed working + broken. Implants are
  never quick-slottable (`QUICK_USABLE_CATEGORIES` has no `implant`) and fit no equipment slot (`slotAccepts` /
  `equipTargetFor` are category checks) — verified, no code change needed.
- **Grid ops for progression** — `tryAddToStash` / `tryAddItemAnywhere` / `findItemAnywhere` / `takeItem` all work on an
  implant instance unchanged (stackMax 1, no special casing). `takeItem` returns the **count**, never the instance (the
  `InventoryRef` signature is frozen), so progression must `findItemAnywhere(uid)` first, copy `{uid, defId,
  durability}`, then `takeItem(uid)` — the captured object's `qty` drops to 0 afterwards.

### Known limits (Phase 12)
- Spray repair materials are **bag-only** (the weapon-repair convention), while the tooltip's 보유 count for a broken
  implant's repair chips is bag + 창고 — two readouts, two conventions; a bag + 창고 repair would need `consumeDefAll`.
- The 분해 게이지 is per **frame**, so on a stalled tab it stalls with the job; `inventory:disassembleProgress` is emitted
  only while the dialog is open (a craft started any other way reports nothing).
- Only the modeless 분해 dialog (and the ship 수리 entry) know about the new rules; the bench repair list
  (`CraftPanel`, gear bench = armor + bags) does not list sprays.


## 파일 분할 규약 (`model.ts` + `parts/`, 2026-09-08)

`InventorySystem.ts` 는 한 파일에 다 있기에는 너무 커져서 **동작을 바꾸지 않고** 갈랐다. 규칙은 세 줄이다.

1. **`model.ts`** — 폴더 공용 어휘(타입 · 상수 · 스크래치 객체). 상태도 클래스 참조도 없다.
   `InventorySystem.ts` 이 `export * from './model'` 로 재수출하므로 **기존 import 경로는 전부 그대로 동작한다.**
2. **`parts/*.ts`** — 클래스에서 떼어낸 메서드 묶음. 각 함수는 인스턴스를 첫 인자 `sys` 로 받는다:
   ```ts
   export function applyDamage(sys: InventorySystem, …) { … }   // 예전의 this → sys
   ```
   클래스에는 같은 이름의 **한 줄 위임 메서드**가 남아 있으므로 `ctx.*` 를 통한 호출부와
   폴더 안의 `this.foo()` 호출은 **하나도 바뀌지 않았다.**
3. `parts/` 가 닿는 클래스 멤버는 `private` 이 벗겨져 있다. **폴더 밖에서 쓰라는 뜻이 아니다** —
   접근 범위는 여전히 이 폴더이고, 외부와의 계약은 `@/shared` 의 `*Ref` 인터페이스가 전부다.

`parts/` 에 새 파일을 만들 때는 맨 위 doc 주석에 **그 파일이 답하는 질문 한 줄**을 적고
위 표에 행을 추가한다. 순환 import 를 만들지 않으려면 `parts/` 는 `InventorySystem.ts` 에서 **타입만**
가져와야 한다(`import type { InventorySystem }`) — 값이 필요하면 `model.ts` 로 옮긴다.

---

## 정렬 · 필터 · 합치기 · 즉시 이동 (2026-09-12, 사용자 결정)

- **자동 정렬** — 가방 · 창고 머리의 `정렬` (`parts/Sort.ts`). Tab 인벤토리와 `TradeGrids` 양쪽.
  실패(다시 채울 자리가 없다)하면 아무것도 안 바뀌고 `정렬할 자리가 부족합니다` 토스트.
- **필터** — 칩 10개(`model.FILTER_GROUPS`: 전체 · 무기/부착물 · 방어구/가방 · 탄약 · 소모품 · 가젯/수류탄 · 재료 ·
  귀중품/열쇠 · 재배/연구 · 기타). 걸러진 타일은 `.is-filtered-out` 로 **어두워질 뿐 자리를 지키고 끌 수도 있다** —
  격자 인벤토리에서 숨기면 어느 칸이 비었는지 거짓말이 된다. Tab 창에서는 가방 · 창고 · 주머니가 한 선택을 나눠 쓴다.
- **퀵슬롯 합치기** — 같은 아이템이 든 휠 칸에 놓으면 교체가 아니라 합친다 (`previewDrop` 의 `'merge'` →
  `InventorySystem.mergeIntoQuickSlot`; 가방 · 창고 · 상자 · 주머니 · 다른 휠 칸 어디서 와도). 반대 방향(휠 → 같은 아이템의
  격자 스택)은 원래 `dropImpl` 의 합치기다. Shift / Ctrl 로 나눈 스택도 휠 칸에 놓을 수 있다 (`previewQuickPartial` /
  `dropQuickPartial` — 빈 칸이면 새 스택, 같은 아이템이면 합치기).
- **넘친 수량은 커서에 남는다** — 합치기(격자끼리 · 휠 포함)에서 다 못 옮긴 몫은 **출발지를 떠나지 않은 채** 드래그가 이어진다
  (`ui/parts/Drag.holdRemainder`, `DragState.held`). 다음 좌클릭의 **떼는 순간**이 놓기이고(누름은 캡처 단계에서 삼킨다 —
  밑의 타일 · 버튼 · 탭이 반응하지 않는다), 아무 목표도 없는 곳 · 우클릭 · Escape(`escHandler`) · 창 닫기는 그냥 놓아 준다
  (스택은 이미 제자리다). 휠에서 시작한 held 드래그도 빈 곳에 놓았다고 **칸을 비우지 않는다**. 이어진 놓기가 또 넘치면 또
  남는다. 세이브 · 시체 벗기기는 그 사이에 끼어들어도 아이템을 제자리에서 본다. held 놓기 뒤 `CLICK_SUPPRESS_MS` 동안은
  같은 클릭에서 나온 `dblclick` / `contextmenu` 가 타일에 먹히지 않는다.
- **즉시 이동** — `.inv-tile` 의 `transform` · `opacity` 전환, 새 격자에 들어온 타일의 `.is-new` 팝, 드롭 하이라이트의 미끄럼을
  없앴다. 호버 강조의 짧은 전환만 남았다. 다른 대원이 상자에서 가져간 타일의 `.is-vanishing` 은 **내 이동이 아니므로** 그대로다.
- **타일 diff** — `GridView.refresh` 는 버전이 바뀌면 모든 타일의 DOM 을 다시 만들었다(창고 200 스택 × `innerHTML`).
  이제 타일마다 그리는 내용의 서명(`tileSignature`)을 두고 바뀐 타일만 다시 만든다. 위치는 매번 쓴다.
- **`InventoryRef.buildItemTile(defId, qty, {cell, durability})`** — 격자 타일과 똑같은 독립 타일(`.inv-tile.is-standalone`,
  `data-item-tip` + `data-def-id`). 기업 거래 화면의 재고 · 트레이가 가방 · 창고와 같은 모양을 쓰게 하려고 붙였다.

## 준비물 사용 (A-13, 2026-09-11)

준비물(`ItemDef.prep`)은 **함선에서 우클릭 → `사용 (다음 레이드 1회분)`** 으로 쓴다
(`ui/parts/ContextMenu.menuEntries` 의 1c-2 · `InventorySystem.usePrepItem` → `parts/StashOps.usePrepItem`).

- **순서가 규약이다** — `ctx.progression.usePrep(defId)` 에게 **먼저 묻고, 성공(null)일 때만** `takeItem(uid, 1)`
  로 뺀다. 뒤집으면(빼고 나서 묻는다) 거절당했을 때 되돌릴 곳이 없다 — `PlayerProfile.prep` 은 이 폴더의
  것이 아니다. 뺄 수 없는 자리(열어 둔 상자 · 장비 칸)는 **묻기 전에** 사유로 거른다.
- 거절은 조용히 삼키지 않는다: 한국어 사유가 그대로 토스트로 나가고 아이템은 **그대로 남는다**
  (`이미 준비했습니다` · `<이름> 을(를) 이미 준비했습니다` · `함선에서만 사용할 수 있습니다` …).
- 레이드 중에는 항목이 `레이드 중에는 쓸 수 없음` 힌트를 달고 잠긴다 (눌러도 경고 토스트뿐).
  `사용` 항목이 있으므로 준비물은 평범한 우클릭으로도 메뉴가 열린다(`hasMenu`).
- 분해 · 수리 대상이 아니다 — `Durability` · `Salvage` 경로는 한 줄도 바뀌지 않았다.

## 변경 이력

- **2026-09-12 (2차 UI/UX 묶음 9건, 에이전트 inventory)** — 계약(`src/shared`) · `data/` 는 한 글자도 안 건드렸다.
  ① **툴팁** — 내구도가 `내구도  120 / 300` 텍스트 행에서 **가로 게이지 한 줄**(`buildDurabilityBar` →
  `.inv-tt-durbar`, 무기 2×2 게이지의 `.track` / `.fill` 재사용)로. 그 아래 `구간` 줄(C-37)과 그것을 위해 있던
  `TooltipLookups.getDurabilityBucket` / `canSalvage`, `TEXT.durability.tooltip` / `tooltipKey`, CSS `.is-bucket`
  을 **전부 제거**. 방탄복 `특성` 행은 설명 문단과 글자가 같으면 서지 않고(유니크 description = 퍽 문장),
  가방에 「소지 한계 +N kg」 한 줄 추가(`Gear.bagCapacityBonus`).
  ② **장착칸** — 아이템이 든 칸의 **테두리 한 겹**(`.inv-slot-body` `content-box` → `border-box`, `has-item` 이면
  `padding: 0` + 투명 테두리; 겉 크기 불변), 배치 A안(`LOADOUT_SLOTS` = `primary · armor · primary2 · bag · pouch`,
  `grid-template-areas` 에 `implant` 칸 추가), 전술 임플란트 슬롯이 가로 바 → **정사각 썸네일**이고
  `.inv-implants` 가 장비칸 그리드 안으로 들어갔다(`InventoryUI.mount` 가 `pouch` 앞에 끼운다).
  ③ **필터** — `.inv-filters` 가 `grid-template-columns: repeat(var(--inv-filter-n), 1fr)`(칸 수는
  `FILTER_GROUPS.length` 가 준다), 칩은 낮고 넓은 사각형. 필터 줄이 **패널 맨 위**(머리보다 위)로 올라가고
  `.inv-root` 는 `justify-content: center` 대신 `flex-start` + `padding-top`(함선 74px = `.scr-tabs` 자리,
  레이드 8px).
  ④ **탄약 사선 띠** — 장착 주무기가 쓰는 탄종의 탄약 타일 우상단에 코너 리본(`.is-ammo-needed`). 표는
  `ui/GridView` 의 `setNeededAmmoFrom` / `isNeededAmmo` 하나이고 `tileSignature` 에 실려 무기를 바꾸면 다시 그린다.
  ⑤ **창고 총기 소켓** — `DropResolver.canSocketAt` 이 `'stash'` 를 명시 허용(상자 · 시체는 거부),
  `bumpWeaponGrid` / `stowDetached` 가 붙었고 `Durability.detachAllSockets` 도 같은 술어를 쓴다.
  ⑥ **창고 더블클릭 자동 장착** — `activateFallback` 의 ①②③ 을 `tryAutoPlace` 로 떼어내 창고에서는 **가방보다
  먼저** 돌린다(문구만 `<이름> → <어디>` 로 다르다).
  ⑦ **제작 4열** — `[작업대 목록][제작품 목록][함선 창고][내 가방]`. 가로 탭(`.inv-craft-tabs` · `전체`)을 왼쪽
  **세로 작업대 리스트**(`.inv-craft-benches`, 빠른제작 + 설치된 작업대만)로 바꾸고 `InventoryRef.switchBench`
  (신규, 창을 열지도 닫지도 않는다)로 그 자리에서 갈아 끼운다. `.inv-col-right` 가 제작 중에 **가로**(창고 · 가방)로,
  제작품 목록은 고정 높이 + 세로 스크롤.
  ⑧ **TradeGrids 좌우** — 기본 `['stash','bag']`, `.tg-scroll` 이 `flex-wrap` 가로 2열(폭이 모자라면 가방이
  아랫줄로).
  ⑨ **수리 진입점** — 정비 벤치 은퇴에 맞춰 `benchRepairRows` 가 작업대 종류를 안 보고(무기 · 방탄복 · 가방 전부,
  **레이드 중에는 빈 배열**) `모두 수리` 버튼은 함선이면 언제나 뜬다. 우클릭 `수리` 는 원래 작업대 게이트가
  없었다(함선 + 내가 들고 있는 것 + `repairInfo`).
  **알려진 것**: `scripts/smoke-inventory-p6.mjs` 의 작업대 **탭** 검사(`.inv-craft-tabs` / `.inv-craft-tab`)는 이
  개편으로 선택자가 없어졌다 — 세로 리스트(`.inv-craft-bench[data-bench]`)로 고쳐야 한다 (scripts/ 는 이 배치의
  담당 밖이라 손대지 않았다).
  **리드 통합 2차 (스모크 3개 빨강)**: 둘은 소스가 잘못돼 있었다. ① **함선 화면의 가방 패널이 화면 밖으로**
  나갔다 — ③ 의 `flex-start` + `padding-top: 74px` 은 남는 높이를 전부 아래로 보내는데 `.inv-bag-scroll` 예산
  (`100vh − 430px`)은 레이드의 8px 기준이라, 1280×760 Tab 창에서 패널이 76 → **811 px**(화면 760)로 서서
  무게 · 가치 줄이 잘렸다(`smoke-tutorial` equipGun 이 잡았다 — 스포트라이트 구멍은 화면 밖으로 못 나간다).
  쌓이는 배치의 **함선**에만 66px(74 − 8)을 더 뺀다(`100vh − 496px`) → 745 px. **대가**: 1280×760 함선 창의
  가방 보이는 높이가 330 → 264 px 라 기본 가방(6줄 336 px)의 **마지막 줄은 스크롤해야 보인다**. 피할 수 없다 —
  패널의 나머지(로제트 183 · 머리 · 필터 · 무게 · 가치 · 여백 = 405)와 위 여백 76 을 더하면 6줄을 다 보여 주는 데
  817 px 이 들고 화면은 760 px 이다(12줄 전설 가방은 애초에 어떤 값으로도 안 들어간다 — 고정 틀이 이미 스크롤을
  전제한다). 드래그 중 스크롤은 `bScroll` 의 `scroll` 리스너가 받아 준다. 그래서 `smoke-quickslots` 의
  `freeBagCell()` 은 칸을 **`scrollIntoView` 한 뒤 실제로 재서** 클릭한다(예전엔 격자 원점에서 계산해 로제트를 찍었다). ② **열고 들어온 작업대가 왼쪽
  리스트에 없었다** — `buildBenches` 가 `ctx.housing.getBenchLevel > 0` 만 보는데 그 값이 0 인 경로(공유 · 방문
  함선처럼 가구가 내 함선 밖)에서는 제목이 `가공 작업대 Lv.3` 인데 리스트에는 그 줄이 없어 **아무것도 선택돼
  있지 않은** 화면이 됐다. 이제 활성 작업대는 언제나 목록에 있고 그 레벨로 선다.
  ③ 가젯 작업대의 `모두 수리` 와 툴팁 내구도 게이지는 **스모크가 옛 사양**을 본 것이라 검사를 고쳤다.
- **2026-09-12 (가방 5칸 · 정렬 · 필터 · 합치기 · 즉시 이동, 에이전트 inventory)** — 계약 추가 하나:
  `InventoryRef.buildItemTile`. ① `data/bags.csv` 가방 8종 전부 가로 5칸(칸 수 5의 배수로 반올림), `recipes.csv` 설명 동기화,
  옛 세이브는 로드 때 큰 것부터 재배치 + 넘치면 함선 창고. ② 가방 틀 고정(`BAG_FRAME_ROWS`, `GridView.setFrameRows`,
  `.inv-bag-scroll`). ③ 자동 정렬 `parts/Sort.ts` + 필터 칩 `ui/GridTools.ts` + `model.FILTER_GROUPS` / `filterPredicate` /
  `SORT_CATEGORY_ORDER` — Tab 창과 `TradeGrids` 양쪽. ④ 같은 아이템 퀵슬롯 합치기(`mergeIntoQuickSlot`, 나눈 스택 포함) +
  넘친 수량은 커서에(`Drag.holdRemainder` / `handleHeldDown`, `DragState.held` / `armed`, Escape 는 `escHandler`). ⑤ 이동 애니메이션
  제거(CSS) + `GridView` 타일 서명 diff. ⑥ `TradeGrids` 재작성 — 한 스크롤 · 정렬 · 필터 · rAF 드래그 · 갱신 합치기 ·
  `data-tg-grid`. 스모크: `smoke-quickslots`(합치기 · held 놓기 · Escape · 휠 → 격자 역방향), `smoke-inventory-p6`(가방 틀 ·
  창고 정렬 · 필터 칩), `smoke-weapons`(전설 가방 5×12).
  **리드 통합**: 고정 틀 때문에 1280×760 Tab 창의 가방 패널이 867 px 로 화면 밖에 나가(`smoke-tutorial` equipGun 스포트라이트 실패)
  제작 창에서는 1920×1080 에서도 함선 창고가 1320 px 까지 밀려났다. 로제트가 가방 아래로 쌓이는 배치(함선 1600 px 미만 ·
  레이드 1280 px 미만)는 `.inv-bag-scroll` 을 `max(168px, 100vh − 430px)`, 넓은 배치는 예전 `100vh − 300px`, 제작 중에는
  `parts/Screens.setCraftOpen` 이 `setFrameRows(null)` 로 틀을 끄고 `max(224px, 100vh − 560px)`. 재측정: 1280×760 가방 패널 737 px ·
  제작 창 창고 끝 724 px, 1920×1080 제작 창 창고 끝 992 px.
- **2026-09-11 (A-15 주머니 · A-3c 요리 먹기, 에이전트 inventory)** — 계약은 읽기만 했다
  (`ItemCategory` += `pouch`/`key`/`meal`, `ItemDef.pouch`/`meal`, `LoadoutSlot` += `pouch`, `POUCH_SLOTS`,
  `inventory:pouchChanged`, `InventoryRef.getEquippedPouch`/`getPouchSize`, `ProgressionRef.useMeal`/`getMeal`,
  `LaunchWarningId` += `noMeal`).
  ① **주머니** — 새 파일 `parts/Pouch.ts` 하나가 규칙 전부를 갖고 `InventorySystem` 에는 한 줄 위임만 남았다
  (`pouch: Grid` · `lastPouchSig` 두 필드). `model.ts` 에 `GridId` += `'pouch'` · `LOADOUT_SLOTS` += `'pouch'` ·
  `slotAccepts` 의 한 줄 · `isPouchDef` · `pouchAcceptsDef`. `ItemLocation` / `DropTarget` 은 **손대지 않았다**.
  `Loadout.ts` 는 v2 → **v3**(`pouch: SavedPlacement[]`, v2 는 빈 배열로 읽힌다). 자세한 것은 위 *주머니는 가방
  격자가 아니다* 절.
  ② **요리 먹기** — `parts/StashOps.useMealItem` + `InventorySystem.useMealItem` 한 줄 위임, 우클릭 메뉴 항목
  하나(`TEXT.menu.eatMeal` · `eatMealRaid`), `parts/LaunchCheck` 의 여덟 번째 경고 `noMeal`. 순서 규약
  (progression 에게 **먼저 묻는다**)은 A-13 준비물 그대로다.
  ③ **C-60 회귀 수정 (같은 배치에서 드러난 잠복 버그)** — `syncContainerScroll()` 을 `ResizeObserver` **하나만**
  몰고 있었다. 콜백은 다음 프레임에 오는데 행이 늘어난 시체 창을 닫고 **곧바로** 평범한 상자를 열면 그 사이에
  콜백이 한 번도 안 들어올 수 있어, 시체 창에서 붙은 `.is-scroll` 이 남아 넘치지도 않는 6×4 상자가 8 px 넓어졌다
  (`smoke-quickslots` C-60 이 2회 중 1회꼴로 빨갰다 — 이 배치가 `refresh()` 에 일감을 더하면서 프레임 타이밍이
  밀려 드러났다). 옵저버가 새 노드를 못 보는 것은 **아니었다**(`containerView.el` 은 교체되지 않는다) — **다시 재는
  사람이 없었을 뿐**이다. 이제 `show()` 와 `refresh()` 의 컨테이너 교체 가지가 `syncContainerScroll()` 을 직접
  부른다(`scrollHeight` 읽기가 레이아웃을 동기로 민다). 옵저버는 창이 서 있는 동안의 변화만 맡는다.
  수정 뒤 `smoke-quickslots` 4회 연속 94/94.
  손대지 않은 것: 소켓 · 내구도 · 수리 · 분해 · 컨테이너 네트워크 경로 · 함선 창고 저장.

- **2026-09-11 (A-13 준비물 사용, 에이전트 prep)** — 계약은 읽기만 했다 (`ItemDef.prep`, `ProgressionRef.usePrep`).
  `parts/StashOps.usePrepItem(sys, uid, from)` 신설 + `InventorySystem.usePrepItem` 한 줄 위임,
  `ui/labels` 의 `TEXT.menu.usePrep` · `usePrepRaid`, `ui/parts/ContextMenu` 의 메뉴 항목 하나와 `hasMenu` 한 칸.
  위 *준비물 사용* 절이 전부다. 격자 · 드래그 · 창고 저장 경로는 건드리지 않았다.

- **2026-09-11 (C-60 · C-61 — 시체 창 스크롤 · 가방 소모 표시의 영속화, 에이전트 c6061)** —
  ① **컨테이너 격자가 패널 안에서 스크롤한다**(C-60, 사용자 결정 "컨테이너 패널 세로 스크롤"): `fitCorpseGrid` 가 행을
  늘린 시체 창이 작은 화면 밖으로 밀려나던 문제. `ui/InventoryUI` 가 `containerView.el` 을 **`.inv-cont-scroll`**
  (`max-height: max(166px, calc(100vh - 240px))` · `overflow-y: auto`, 스크롤바 색은 `--sb-track` / `--sb-thumb` /
  `--sb-thumb-hover` 를 fallback 과 함께 참조 — 값은 `ui/styles/base.css` 가 갖는다)로 감싸고 `GridView.setClip` 으로
  잇는다. **상한에 못 미치는 상자는 상자가 격자와 같은 크기라 모양이 그대로다** — 넘칠 때만 `ResizeObserver` 가
  `.is-scroll`(스크롤바 자리 8 px)을 건다(`syncContainerScroll`). 드래그 판정: 격자 좌표는 예전처럼 매번
  `getBoundingClientRect` 라 스크롤 오프셋이 저절로 들어가고(캐시 없음), `hitTest` 만 보이는 영역으로 잘린다.
  가장자리 **자동 스크롤**은 `ui/parts/Drag` 의 `autoScrollSpeed` · `autoScrollTick`(rAF, 드래그 동안만; 상수는
  `ui/model` 의 `AUTO_SCROLL_EDGE_IN` · `_OUT` · `_MAX_SPEED`)이고, 스크롤이 일어나면 `updateDragTarget` 을 다시 돌려
  하이라이트가 따라온다(휠로 굴려도 — 뷰포트의 `scroll` 리스너). 컨테이너를 새로 열면 맨 위에서 시작한다.
  ② **가방 레이드 1회 소모가 레이드 세션에 실린다**(C-61, 사용자 결정 "레이드 세션 상태에 싣는다"): `RaidInventoryState`
  에 `bagWorn`(그 레이드의 **미션 시드**) 추가, `captureRaidState` 가 `bagWornThisRaid` 일 때만 찍고 `applyRaidState` 가
  시드가 맞을 때만 되살린다(`InventorySystem.bagWornRestoreSeed`). 멀티 복귀(`RaidSessionBlob.inventory`)와 솔로
  복귀(`game/SoloRaid` 의 `inventory` — 그대로 통과시키므로 파일 변경은 주석뿐)가 같은 blob 을 쓴다. 순서는 실제로
  `world:ready`(표시 내림) → `applyRaidState`(표시 복원)이고, `parts/Lifecycle.onWorldReady` 가 반대 순서
  (`ctx.rejoinPending` + 같은 시드)에서도 표시를 지키는 한 줄을 들고 있다. 생략 = 모름 = false (옛 blob 호환).
  검증: `smoke-quickslots` 94/94 (C-60 6 · C-61 4), `smoke-raidflow` 84/84 (멀티 복귀 · 솔로 새로고침 복귀 3),
  `smoke-search` 75/75, `smoke-loadout` 69/69.
- **2026-09-11 (저장 무결성 — E-5 · E-6, 에이전트 ③)** —
  ① **창고 + 로드아웃 한 트랜잭션**(E-6): `Stash` · `LoadoutStore` 에 `schedule` 훅, `InventorySystem` 의 `uploadBatch` ·
  `saveTimer` · 페이지 숨김 핸들러(스토어들보다 먼저 등록), `parts/ProfileDocs` 의 `scheduleSaves` · `flushSaves` ·
  `joinProfileTx`. 둘 다 바뀐 저장은 `setMany({stash, loadout})` 하나. `InventoryRef.flushSaves` (meta 퀘스트 완료가 부른다).
  `parts/CorpseLoot.stripForCorpse` 가 끝에 `joinProfileTx(['loadout', 'progression'])`.
  ② **솔로 레이드 표식**(E-5): `LoadoutStore.raidSeed` · `markRaid` · `clearRaid` (로컬 파일만, `sanitizeLoadoutSave` 가 버린다),
  `parts/Lifecycle.onWorldReady` 가 솔로 레이드에서만 표시하고 `onGameOver` · `onAbort` · `game:complete` 가 지운다,
  `InventoryRef.soloRaidSeed`. 계약 추가(`src/shared/types.ts` `InventoryRef` 두 줄)는 보고했다.
  검증: `smoke-search` 75/75 (합친 디바운스 · 페이지 숨김 · E-6 병합 스텁 12), `smoke-raidflow` 81/81 (E-5 7).
- **2026-09-11 (C 항목 배치 — C-5 · C-12 · C-16 · C-26 · C-36 · C-37)** —
  ① **사망 시 임플란트**(C-12, `parts/CorpseLoot`): `stripForCorpse` 가 `ctx.progression.stripImplantsForCorpse?.()` 의
  망가진 짝을 시체 목록 끝에 합친다 (progression 구현이 없으면 빈 배열 — 예전과 똑같다). 새 `fitCorpseGrid` 가 시체
  격자를 **내용물이 전부 들어갈 때까지 행을 늘려** 만든다 (`openContainerItemsSized` · `primeCorpseContainer` 둘 다,
  같은 목록 → 같은 크기). 주석의 "무기 3" 을 실제 칸(주무기 I · II · 방탄복 · 가방)으로 정정.
  ② **같은 컨테이너 재오픈 무시**(C-16, `InventorySystem.isShowingContainer`): 창이 이미 그 컨테이너를 보여 주고 있으면
  `openContainer` · `openContainerItems` · `openContainerItemsSized` 가 아무것도 하지 않는다 — 구조물 컨테이너가
  `openContainerItems` 뒤에 같은 id 로 `crate:open` 을 내서 창이 두 번 떴고(`inventory:opened` ×2, `ui_open` 이중 재생)
  `first:false` 이벤트가 하나 더 나갔다. 닫은 뒤 다시 여는 것은 예전 그대로(`first:false`).
  ③ **가방 내구도**(C-36, `parts/Durability.wearBagForRaid` · `InventorySystem.bagWornThisRaid`): 레이드당 한 번,
  탈출 성공(`game:complete` 의 `stats.extracted`, 저장 **전**) 또는 사망(`stripForCorpse` **전**) 중 먼저 온 쪽.
  중간에 가방을 바꿔도 한 번이고 가방 없이 죽었으면 표시를 세우지 않는다. `durability:changed` 만 내고
  `durability:broken` 은 내지 않는다 (0 = 효과 없음). 수리비가 빈 "제작 레시피가 있는" 아이템은 `repair` ·
  `repairInfo` · `benchRepairRows` 가 거절한다 (`@/items` 의 `needsRepairCost`).
  ④ **툴팁 내구도 구간 한 줄**(C-37, `ui/Tooltip.ts`): 무기 · 방탄복 · 가방의 내구도 줄 아래 `구간 81~100 % · 분해 40 % ·
  수리 10 %` (유니크는 분해 없이 수리만). `TooltipLookups.getDurabilityBucket?` · `canSalvage?` 추가(폴더 안 인터페이스),
  `InventoryUI` 가 `LootRef.durabilityBucketInfo` · `getSalvageFor` 로 잇는다. 가방 툴팁에 `내구도 n / max` 줄 신규.
  문구는 `labels.TEXT.durability.tooltip` · `bagStats.durability`, 스타일 `.inv-tt-stats .v.is-bucket`.
  ⑤ C-5: 퀵슬롯 클램프 주석 정정 (전설 전술 가방은 이제 8). ⑥ C-26: `model.ts` 의 슬롯 주석에서 죽은 `ui/hud/SlotStrip`
  대신 실제로 칸을 정하는 `hub/ui/WorkbenchMenu` 를 적었다.
  ⑦ `__selftest__.ts`: 가방 구간 · 가방 수리비 단언. `scripts/smoke-quickslots.mjs` 에 C-5 · C-36 · C-16 · C-12 단언 11개.

- **2026-09-10 (달리는 전차 안의 컨테이너가 곧바로 닫히던 것)** — `Container.position` 은 연 순간의 **복사본**이라,
  전차 객실 컨테이너(`world/structures/parts/Containers` 의 `dynamic` 스펙)는 창을 연 지 약 0.4초 만에 자동 닫힘
  거리(`AUTO_CLOSE_DISTANCE` 6 m)를 넘었고 감정(`SEARCH_MAX_DISTANCE`)도 "사거리 밖" 으로 멈췄다 — 플레이어와
  컨테이너가 함께 달리는데 둘 사이 거리를 달리기 전 자리에서 쟀기 때문이다 (헤드리스 프로브로 재현).
  이제 `ContainerStore.getOrCreate*` 가 여는 쪽이 넘긴 **살아 있는 객체**를 `Container.anchor` 에 들고,
  두 거리 판정이 `livePosition`(= `anchor ?? position`)을 본다. 여는 쪽(상자 def · 컨테이너 spec · 적 시체 ·
  플레이어 시체 · 보급 상자)은 전부 수명이 긴 객체를 넘긴다 — **스크래치 벡터를 넘기면 안 된다.**
  멈춰 있는 상자에서는 두 값이 같아 동작이 바뀌지 않는다.

- **2026-09-10 (제작 대개편 2단계 — 내구도 연동 분해 · 수리, 정제 작업대 탭)** — 1단계(`data/` · `src/items` ·
  `LootRef` 계약) 위에 인벤토리를 맞췄다. 새 파일은 없고 전부 기존 `parts/` · `ui/` 안이다.

  ① **분해 산출이 남은 내구도를 탄다** (`parts/Crafting.resolveRecipe`). `ctx.loot.getAllRecipes()` 에 실려
  있는 `break_*` 줄의 수량은 **구간 4(81~100 %) 기준**인데 `updateCraft` 도 `disassembleRecipeFor`(미리보기)도
  그 줄을 그대로 썼다 — 내구도 5 % 인 방탄복 I 이 만피와 똑같이 `폐금속 4 + 천조각 2` 를 뱉었다(정답은
  `폐금속 1`). 이제 **분해 대상이 지정되면** `ctx.loot.getSalvageFor(inst)` 로 레시피를 다시 풀고, 미리보기 ·
  자리 검사(`craftHasRoom(id, count, targetUid)`) · 실제 소비/산출이 **같은 레시피**를 본다. 레시피 `id` 는
  같으므로 `craft(id, uid)` 의 게이트(`availableRecipes` 동일성 · `canCraft` · `craftCost`)는 한 줄도 바뀌지
  않았다 — 두 레시피의 `inputs` 는 어차피 같기 때문이다. 분해 팝업은 열 때 한 번이 아니라 매 `refresh()` 마다
  다시 푼다.

  ② **방탄복 수리가 더 이상 공짜가 아니다** (`parts/Durability.repairMaterials`). 세 곳(`repair` ·
  `repairInfo` · `Crafting.benchRepairRows`)이 전부 `getEffectiveStats(item) ? getRepairCost(item) : …` 였다.
  즉 **무기일 때만** `getRepairCost` 를 물었고, 방탄복은 else 가지로 흘러 `sprayRepairCost` 도 null 이라
  **재료 없이 만피로 복구**됐다(실측: 10 / 200 짜리 방탄복 I 이 폐금속 0 을 쓰고 200 이 됐다). 1단계가
  `getRepairCost` 를 방탄복까지 넓혔으므로 삼항을 **뒤집어** `getRepairCost` 를 먼저 보고 비었을 때만
  회복 스프레이의 게이지 충전으로 내려간다. 그 결정을 하는 곳은 `repairMaterials` **하나**다. 방탄복 I 을
  10 % 에서 고치면 이제 `폐금속 5 + 천조각 3 + 구동 코어 1`(= 제작 재료 × 0.5, 올림)이 실제로 빠진다.

  ③ **수리 · 분해 팝업이 내구도 구간을 말한다** (사양서 §4). 수리 팝업은 줄마다 `현재 / 최대` 뒤에
  `.inv-repair-bucket`(`61~80 % · 제작 재료의 20 %`)을, 아래에 `내구도가 낮을수록 수리 재료가 많이 듭니다` 를.
  분해 팝업은 미리보기 밑에 `.inv-dur-note` 한 줄(`남은 내구도` / 구간 · 배수 / `내구도가 낮을수록 나오는
  재료가 적습니다`). 우클릭 메뉴의 `수리` 항목도 hint 로 같은 구간을 단다. 내구도를 쓰지 않는 아이템
  (탄약 · 재료 · 가방)은 언제나 구간 4 이므로 **줄 자체를 그리지 않는다**. 배수는 전부
  `ctx.loot.durabilityBucketInfo` 에서 오고(원본 `data/tables.csv`) UI 코드에는 숫자가 없다. 회복 스프레이는
  구간이 아니라 **남은 게이지 비율**로 값이 정해지므로 `RepairInfo.bucket` 이 null 이고 구간을 말하지 않는다.

  ④ **정제 작업대 탭** (`ui/CraftPanel.buildTabs`). 정제 작업대 자체(가구 · 모델 · 상호작용 · 레시피 ·
  `WorkbenchKind`)는 1단계와 다른 폴더가 이미 만들어 뒀고, 여기서 붙인 것은 **제작 UI 의 탭**이다.
  함선의 `제작` 패널은 작업대를 가리지 않고 전부 한 목록에 쏟아 놓는데 레시피가 48 → 94 줄이 되면서
  읽히지 않았다. `전체` · 총기 · 장비 · 가젯 · 의학 · **정제** · `빠른제작` 일곱 칸이고, 이름은
  `WORKBENCH_LABEL_KO` 가 원본이라 함선 관리 화면 · 작업대 제목과 **같은 어휘**다. 작업대를 열고 들어온
  화면에는 탭이 없다.

  ⑤ **홀드 중에는 게이지만 다시 그린다** (`CraftPanel.frozen` → `paintProgress`). `updateCraft` 가 매 프레임
  `refreshCraft()` 를 부르므로 94 줄 × (`canCraft` · `maxCraftCount` · `craftHasRoom` — 뒤엣것은 가방 · 창고
  격자를 통째로 복사한다) 이 1 초 홀드 동안 60 번 돌고 있었다(측정 **2.2 ms/프레임**). 홀드 중에 바뀌는 것은
  막대뿐이고 **줄을 움직이지 않는다는 규약**(`applySort`)도 이미 있으므로, 첫 프레임만 제대로 그리고 그 뒤로는
  막대만 옮긴다(**0.02 ms/프레임**). 정렬 자체는 94 줄에서도 그대로 성립한다(스모크가 `^1*0*$` 로 검사한다).

  검증: `smoke-inventory-p6` 144/144(새 검사 14개), `smoke-quickslots` 73/73(`runInventorySelfTest` 에
  내구도 구간 · 분해/수리 방향 · 무한 이득 없음 회귀 추가), `smoke-loadout` 69/69, `smoke-search` 61/61,
  `npm run data:check` ok, `npx tsc --noEmit` clean.

- **2026-09-10 (상자 더블클릭 · 퀵슬롯 교체 · 제작 정렬)** — 플레이 피드백 3건. 전부 국소 수정이고 새 파일은
  순수 모듈 `QuickSwap.ts` 하나다.

  ① **컨테이너 더블클릭은 가방이 먼저다** (`parts/DropResolver.activateImpl`). 상자 · 시체 · 함선 창고에서
  더블클릭한 장착 아이템이 곧장 장비 칸으로 들어가 **지금 든 총이 조용히 바뀌던** 문제. 이제 `from` 이
  가방이 아닌 격자면 언제나 `bag.canAbsorb` → `quickMoveImpl` 이고, **가방이 꽉 찼을 때만**
  `activateFallback` 이 `빈 장비 칸 → 임플란트 칸 → 빈 퀵슬롯 → 거절` 순으로 간다. 폴백으로 들어간 자리는
  `ui:notify` 가 말한다 (`가방이 가득 찼습니다 — <이름> → 주무기 II`). 자세한 규칙은 위 `Equipment slots` 절.

  ② **가방이 꽉 차면 퀵슬롯 소모품을 교체할 수 없던 버그** (`QuickSwap.ts` 신규, `InventorySystem.setQuickSlot`
  + `parts/DropResolver.previewDrop`). 원인이 두 개였다 — ⓐ 미리보기가 `bag.canAbsorb(occupant)` 를 들어오는
  스택이 **아직 격자에 있는 채로** 물어 그것이 곧 비울 칸을 세지 않았고(가방 → 휠이 빨간불), ⓑ `setQuickSlot`
  이 밀려난 스택을 가방에서만 찾았다(상자 · 창고 → 휠이 거절). 1:1 교체는 자리를 맞바꾸는 것이라 가방 여유가
  필요 없다: 이제 양쪽이 `canQuickSwap` / `applyQuickSwap` 으로 **같은 계획**을 보고
  `가방 → 휠` 은 `비운 그 칸 → 가방`, `상자 · 창고 → 휠` 은 `가방 → 비운 그 칸 → 출발 격자` 순으로 자리를 찾는다. 성립하지 않으면 **원자적으로** 거절한다
  (들어온 스택은 원래 칸으로, `inventory:full`). 휠 ↔ 휠 교체는 예전 그대로. 자세한 것은
  `Quick-use wheel slots` 절의 2026-09-10 항목.

  ③ **제작 목록: 만들 수 있는 것이 위로** (`ui/CraftPanel.applySort`). 안정 정렬이라 만들 수 있는 것끼리 ·
  없는 것끼리는 csv 순서를 유지하고, `paint()` 안에서 도므로 재료를 넣고 빼면 곧바로 따라온다.
  **정렬만** 바꿨다 — 필터도 숨김도 새로 만들지 않았다.

  검증: `smoke-quickslots` 73/73, `smoke-loadout` 69/69, `smoke-inventory-p6` 124/124, `smoke-search` 61/61,
  `smoke-housing` 206/206, `smoke-tutorial` 83/83, `smoke-meta` 172/172, `smoke-console` 63/63,
  `smoke-library` 126/126, `smoke-controls-hub` 144/144, `smoke-weapons` 136/136, `smoke-phase2` 57/57,
  `smoke-tactical` 87/87, `smoke-raidflow` 59/59, typecheck ok. `__selftest__` 에 `QuickSwap` 회귀 6묶음 추가
  (`smoke-quickslots` 가 `runInventorySelfTest()` 로 돌린다).

- **2026-09-10 (방탄복 = 실드)** — 방탄복 툴팁의 **`피해 감소 x %` 줄이 `실드 +N` 으로** 바뀌었다
  (`ui/Tooltip.ts`, `ArmorDef.shield`; `TEXT.armorStats.shield` 신규 — `dr` 은 안 쓰지만 남겼다).
  같은 카드에 **실드 충전기**(`shieldChargeOf(def.id)`, `@/items`) 의 `실드 회복 +20` / `최대치까지` ·
  `사용 시간 2 s` 두 줄이 붙었다 (`TEXT.shieldChargeStats`). `parts/LaunchCheck` 의 "회복 아이템 없음" 은
  실드 충전기를 세지 않는다 — 같은 `category: 'stim'` 이지만 체력을 채우지 않기 때문이다.
  격자 크기 · 장비 칸 · 내구도 · 수리 · `stripForCorpse` 는 **한 줄도 바뀌지 않았다** (방탄복은 여전히
  내구도가 닳고 함선 작업대에서 수리한다 — 이제 실드가 먹은 피해만큼 닳는다).

- **2026-09-10 (상자 ↔ 퀵슬롯 · 보조무기 칸 제거)** —
  ① **상자에서 곧장 퀵슬롯으로, 퀵슬롯에서 곧장 상자로.** 예전에는 휠에 올릴 수 있는 출처가 **가방 격자뿐**이었고
  (`previewDrop` 의 `fromBag`), 휠 칸을 끌면 다른 휠 칸 말고는 전부 "해제" 였다. 지금은 ⓐ `previewDrop` 의 휠
  분기가 **모든 격자**(가방 · 열어 둔 상자 · 함선 창고)를 받고, ⓑ `setQuickSlot` 이 `locateInGrids` 로 출처를
  찾아 그 격자에서 꺼내며(감정 안 된 상자 아이템은 거절, 컨테이너에서 나오면 `searched = true`, 위치가 바뀌었으니
  `emitTransfer`), ⓒ `drop` 의 `takes` 에서 `target.kind !== 'quick'` 예외가 빠져 **상자 → 휠도 `guardedTake`**
  를 지난다 (멀티에서 호스트 확인). `registerQuick`(우클릭 · `빠른 슬롯에 등록`)도 상자 출처면 같은 관문을 탄다.
  UI 는 `ui/parts/Drag` 가 휠 드래그에도 격자 · 장비 칸을 겨냥하게 하고(목표가 **하나도 없을 때만** 해제),
  `ui/parts/ContextMenu` 가 상자 · 창고 아이템에도 `빠른 슬롯에 등록` 을, 휠 칸 메뉴에는 상자가 열려 있을 때
  `상자로 이동` 을 붙인다. `quickMoveImpl` 의 휠 → 목적지도 상자가 열려 있으면 상자다 (없으면 예전대로 가방).
  ② **보조무기 칸이 사라졌다** (사용자 결정). `LOADOUT_SLOTS` = 주무기 I · II · 가방 · 방탄복, `WEAPON_SLOT_IDS`
  = 주무기 둘, `slotAccepts('secondary')` 는 언제나 false. `Loadout.secondary` · `LoadoutSlot` 의 `'secondary'`
  **자체는 지우지 않았다** — `src/shared` 는 추가만 하는 계약이고 저장된 프리셋 · 크루 카드가 그 이름을 쓴다
  (`airstrike` 와 같은 처리). 장비 열은 3행 → **2행**이 됐다 (`inventory.css`: `"primary armor" "primary2 bag"`),
  무한 상자의 `무기` 탭도 `primary` 만 본다.

- **2026-09-09 (아이템 툴팁 재설계 · `탄약 필요`)** — `ui/Tooltip.ts` + `inventory.css` (`.inv-tooltip` 폭 264 → 312 px).
  ① **무기 카드의 숫자 표를 게이지로 바꿨다.** 종류 · 등급 · 대미지 · 탄창 · 연사 · 반동 · 정조준 시간 · 재장전 · 탄종 ·
  유효 사거리 줄이 사라지고, 대미지 · 연사 · 반동 · 사거리는 **2×2 게이지 격자**(`.inv-tt-gauges`)다 — 라벨 + 가로 막대 +
  작은 회색 숫자(`60` · `9 /s` · `2.40°` · `55 m`). 막대는 **카탈로그 최댓값**으로 정규화한다: `TooltipLookups.allWeaponItemDefs()`
  (`ctx.loot.getAllItemDefs()` 중 `weaponId` 가 있는 것) 하나하나에 `getBaseStats(def.id)` = `LootRef.getEffectiveStats(defId)`
  (등급 반영 · 소켓 없음)를 물어 `damage × pellets` · `fireRate` · `recoilV` · `effectiveRange(weapon)` 의 최대를 **툴팁당 한 번**
  게으르게 잡는다 (`Tooltip.gaugeMaxima`). 그래서 산탄총 · 저격총은 대미지가, 저격총 · DMR 은 사거리가, SMG · 산탄총은 사거리가
  낮게 읽힌다. 유니크 무기도 카탈로그에 들어가므로 (예: 미니건의 연사) 일반 무기의 연사 막대는 그 기준으로 짧아진다 — 의도.
  ② **소켓 보너스 색.** 막대는 두 층이다 — 소켓 없는 정의값(`getBaseStats`)이 **흰색**, `getStats(item)` 이 그보다 크면
  늘어난 구간이 **초록 `.bonus`**, 작으면(총구 브레이크의 반동) 흰 채움이 실효값까지 줄고 빠진 구간이 **속 빈 초록 윤곽
  `.reduced`** 로 남는다. 사거리는 소켓 영향이 없어 한 층이다. 초록은 `var(--c-success, #5ee08a)` (이 파일은 base.css 를
  import 하지 않으므로 fallback 을 적는다).
  ③ **탄종 썸네일** (`.inv-tt-ammo`, 44 px, 머리글 오른쪽 구석): `findAmmoDef(type)` 이 카탈로그에서 `category 'ammo'` +
  `ammoType` 이 같은 아이템을 찾아 그 글리프를 그 색으로, 아래 안쪽에 탄종 한국어 이름을 작게 쓴다. 수량은 없다. 탄약 아이템이
  없는 탄종(유니크의 연료 · 전지 등)은 점선 사각형에 이름만.
  ④ **소켓 5줄 → 정사각 썸네일 한 줄** (`.inv-tt-sock`, 34 px, `SOCKET_SLOTS` 순): 찬 칸은 부착물 글리프(그 색) + 희귀도
  테두리, 빈 칸은 점선 + `socketAbbr` 두 글자. 부착물 스탯 글은 여기 없다 — 떼어서 그 카드를 읽는다. `소켓` 제목은 뺐고
  칸마다 `title` (`조준경: 없음` / `총구: 소음기`, `labels.socketTip`).
  ⑤ **모든 아이템**: `크기 w × h` 줄과 `무게` 줄 삭제. 하단 바(`.inv-tt-value`)가 **왼쪽 무게**(`def.weight` 가 있을 때만,
  스택 합계 `fmtKg`) · **오른쪽 가치** 의 양끝 바가 됐다. 희귀도는 `분류 · 희귀도` 부제에 그대로. 남은 무기 줄은 `장전 n / max`
  (탄창 크기는 여기서 읽는다) · 발사 모드 · 배율 · 내구도.
  ⑥ `InventorySystem.requestItem` 의 무기 문구가 `탄약 요청: <무기> (<탄종>)` → **`탄약 필요: <탄종>`**. 비무기는
  `<이름> 필요` 그대로. 장비 칸 타일도 `SlotPanel` → `beginPress` → `MIDDLE_BUTTON` 으로 같은 길을 이미 타고 있었다 (추가 없음).
  `TooltipLookups` 에 `getBaseStats?` · `allWeaponItemDefs?` · `findAmmoDef?` 를 **추가만** 했고 `InventoryUI.mount` 가 `ctx.loot` 로
  채운다. `TEXT.weaponStats` 의 안 쓰는 라벨(`weaponClass` · `grade` · `sockets` …)과 `gradeLabel` · `weaponClassLabel` 은 계약처럼 남겨 뒀다.

- **2026-09-09 (사망 → 시체)** — 새 `parts/CorpseLoot.ts`: `InventoryRef.stripForCorpse()` (사망 시점의 전부를 뽑고 인벤토리를 비운다 — **완전 빈손 부활**) · `openContainerItemsSized()` (시체는 상자보다 큰 격자) · `pcorpse` 와이어로 시체 컨테이너 미리 만들기. `Container` 생성자와 `ContainerStore.getOrCreateWithItems` 가 격자 크기를 받는다(기본 6×4 그대로). `parts/Lifecycle.onRespawn` 은 `strippedForCorpse` 가 서 있으면 **스타터 킷을 지급하지 않는다** — 구조선 부활은 빈손이다. 레이드 실패 후 함선 복귀의 킷 리셋(`loseKit`)은 그대로.
  ~~**알려진 한계**: 임플란트 아이템은 `ctx.progression` 이 들고 있고 `unequipImplant` 가 함선 전용이라 시체로 넘어가지 않는다 (계약 추가 필요).~~ → 2026-09-11 C-12 에서 해소 (`ProgressionRef.stripImplantsForCorpse`).

- **2026-09-09 (제작 UI 2차 · 제작 수량 · 창고 숨김 · 스크롤바)** —
  ① **제작 행이 만들 물건을 보여 준다.** 레시피 이름 대신 `산출물 이름 ×n`, 그 왼쪽에 **인벤토리 격자 그대로의
  썸네일**(`buildTileContent`, `CELL` 크기 — 4×2 소총이면 정말 4×2 다), 설명 줄은 삭제. 썸네일에 `data-item-tip`
  + `data-def-id` 를 찍어 다른 곳과 **같은 아이템 호버 카드**(`ui/hud/ItemTip`)가 뜬다.
  ② **제작 수량** (사용자 결정: 단위는 레시피의 `outputQty` 그대로 — 준중량탄이면 90 · 180 · 270). 홀드 버튼 위의
  `◀ 총 개수 ▶` 스테퍼(횟수가 아니라 **나오는 개수**를 읽는다 — 경량탄 30 · 60 · 90), 휠로도 조절(리스트가 같이 스크롤되지 않도록 non-passive + `preventDefault`), 상한은
  `maxCraftCount(id)` = **가방** 재료가 감당하는 횟수. 재료 칩의 필요량과 제목이 같이 배가 되고, **한 번의 홀드가
  n 회를 만든다** — 계약은 `canCraft(id, count?)` · `craft(id, targetUid?, count?)` · `craft:started/completed {count}`.
  `updateCraft` 의 공간 검사는 이제 **배치 전체**를 본다 (`roomForOutputs`: 기존 스택에 합치고 남는 만큼을
  `stackMax` 조각으로 `Grid.findFreeSlot` 과 같은 순서로 놓아 보는 dry run) — 90발은 들어가지만 270발은 못 들어가는
  가방에서 **화약 한 톨 쓰기 전에** 실패한다.
  ③ **튜토리얼 중 함선 창고 숨김**: `GridView.setHideItem` 이 새로 생겨, 창고 뷰가
  `ctx.tutorial.hides('stashItem', defId)` 를 물어보고 막히는 아이템은 **그리지 않는다**. 격자 데이터는 그대로라
  튜토리얼이 끝나면 (`tutorial:changed` → `stashView.refresh(true)`) 그 자리에 그대로 돌아온다.
  ④ 제작 열의 키 가이드 줄이 비었다 — 버튼이 이미 `길게 눌러 제작` 이라 `1초 홀드 — 제작` 은 같은 말을 두 번 하는 것이었다.
  ⑤ `inventory.css` 의 스크롤바가 `--sb-thumb` / `--sb-track` 토큰을 쓴다 (이 파일은 `ui/styles/base.css` 를
  import 하지 않으므로 fallback 을 함께 적는다 — 값은 base.css 에서만 고친다).

프로젝트 전체 이력은 [docs/HISTORY.md](../../docs/HISTORY.md) 에 있다.

- **2026-09-09 (키 가이드 · Tab 은 안쪽 팝업부터 닫는다)** — 계약 `ui:keyGuide {owner, keys}` (`src/shared/events.ts`,
  그리는 쪽은 `ui/hud/KeyGuide`) 를 창이 쓴다. ① `ui/InventoryUI.guideKeys()` / `emitGuide()` — owner **`'inventory'`**,
  인벤토리 탭은 `R 회전 · X 버리기(함선에서는 창고로) · 우클릭 빠른 이동 · 메뉴 · 휠클릭 요청`, 캐릭터 / 기업 / 함선 탭은
  마우스 전용이라 `[]` (가이드가 `Tab 닫기` 를 스스로 붙이므로 닫기 키는 절대 넣지 않는다). `show()` · 탭 전환
  (`ui/parts/Screens.setTab`) · `input:bindingsChanged` 마다 다시 보내고 `hide()` 가 `null` 을 보낸다.
  ② 팝업은 자기 owner 를 가진다 — `'inventory.craft'`(`Screens.setCraftOpen`, `1초 홀드 제작`) · `'inventory.repair'`
  (`ui/RepairPanel`, `[]`) · `'inventory.disassemble'`(`ui/DisassemblePanel`, `홀드 분해`) · `'inventory.split'`
  (`ui/SplitDialog` 의 새 `onToggle` 콜백, `Enter 확인`). 가이드는 owner 스택의 맨 위를 그리므로 팝업이 열리면 그 줄이
  위에 뜨고 닫히면 창의 줄로 돌아간다. ③ **Tab 은 Escape 처럼 가장 안쪽 팝업을 먼저 닫는다** —
  `InventorySystem.update` 가 `ui.closePopups()` 가 무언가를 닫았으면 창을 그대로 두고, 아니면 `toggleBag()`. 제작 열은
  창의 한 열이라 창과 함께 닫힌다. 기업 네트워크 콘솔(`hub/Computer`)은 이 창의 기업 탭을 여는 것이라 별도 owner 가
  없다 — `'inventory'` 의 `[]` 줄이 그 화면의 가이드다

- **2026-09-08 (분해 UX)** — ① `InventorySystem.craftHasRoom(recipeId)` 추가 (`parts/Crafting`): `updateCraft`
  가 홀드 끝에 하던 **가방 칸 검사**(출력물 + `extraOutputs`)를 그대로 앞으로 뺀 것. ② `ui/DisassemblePanel` 이
  그 값으로 버튼을 **미리** 잠근다 — 라벨이 `가방에 공간이 없습니다` 로 바뀐다 (전에는 2 초를 쓰고 나서 실패했다).
  ③ 미리보기 밑의 `1회 분해 · 2.0 s` 줄 삭제 (`TEXT.disassemble.hint` → `noRoom`). ④ 버튼 아래 가로
  `.inv-dis-bar` 게이지 삭제 — **버튼 자체**(`.inv-craft-fill`)가 진행 바다. `inventory:disassembleProgress` 계약과
  `panel.progress` 는 그대로이고, `panel.barEl` 은 이제 버튼을 가리킨다.

- **2026-09-08 (폐금속 공급 · 분해 두 가지)** — items/ 가 늘린 고물 분해를 받기 위한 제작 쪽 변경 둘.
  ① **다중 산출물** — `updateCraft` 가 `CraftRecipe.extraOutputs` 를 처리한다. **재료를 쓰기 전에** 주 산출물과
  추가 산출물 전부의 자리를 확인하고(`bag.canAbsorb`), 모자라면 `craft:failed {reason:'space'}` 로 아무것도
  소모하지 않고 끝낸다. 오늘 이걸 쓰는 레시피는 `break_machine_parts`(폐금속 3 + 전력 케이블 1) 하나다.
  `DisassemblePanel` 은 결과물 칩을 나란히 그린다 (`.inv-dis-side` 에 `flex-wrap`).
  ② **분해 대상 지정** — `craft(recipeId, targetUid?)` 와 `CraftJob.targetUid`. 분해 다이얼로그가 연 그 uid 를
  넘기면 `updateCraft` 가 **그 인스턴스부터** 소모하고 모자란 만큼만 `consumeDef` 로 채운다. 예전에는 defId 로만
  소모해서 똑같은 총 두 정 중 부착물이 달린 쪽이 갈릴 수 있었다. 분해 레시피일 때는 소모 직전
  `detachAllSockets(targetUid)` 로 **부착물을 먼저 가방에 돌려준다** — 총보다 조준경이 비싸다.

- **2026-09-08 (임플란트 칸 · 창고 안내 줄)** — `ui/ImplantPanel` 정리 둘.
  ① **전술 임플란트 장착칸에서 설명을 뺐다** — 설명은 교체 피커의 카드(`.inv-imp-card .desc`)에만 있다.
  ② **장착한 임플란트 아이템은 정사각 썸네일 가로 나열**(`.inv-impi-cell`, 줄 끝의 `＋` 셀이 피커)이다.
  셀에는 글자가 없고 이름 · 장착칸 · 퍽 · 능력치는 `data-item-tip` 으로 `ui/hud/ItemTip` 이 띄운다 —
  인벤토리 한 칸에 임플란트마다 문단 세 줄이 쌓이던 것을 없앴다.
  덤으로 `ui/InventoryUI` 함선 창고 아래의 `가방 ↔ 창고: 드래그 또는 우클릭…` 안내 줄을 지웠다
  (사용자 결정: 당연한 설명은 화면에 남기지 않는다).

- **2026-09-08 (main 병합)** — 장착 슬롯이 아이템 발자국이 아니라 모두 같은 크기의 상자 + 카드(`GridView.buildSlotCardContent`)로 바뀌면서 `ui/model.SlotView` 의 `bodyW` · `bodyH` · `meta` 가 사라졌고 `ui/parts/SlotPanel` 이 그에 맞춰졌다. 퀵 사용 장미의 범례는 `ui/parts/QuickPanel` 에서 빠졌다(`quickHold` 도 함께). Escape 는 이제 **가장 안쪽 팝업만** 취소한다 — 새 `closePopups()` 가 그 몫이고 `closeOverlays()`(팝업 + 제작 열)는 내부 닫기 경로용으로 남는다. 창 자체는 Tab 으로 닫는다

- **tactical kit** — **armor slot** (`LoadoutSlot` `armor`, `getEquipped(slot)`, `equip:changed`), **weight budget** (`getWeight()` → `WeightInfo`, `inventory:weightChanged`, readout in the bag panel), `consumeDef`, **field crafting** (`ui/CraftPanel` behind the 제작 button, `getRecipes/canCraft/craft/cancelCraft`, hold-to-craft), gear durability (`getDurability`, `damageDurability`, `repair`), `Gear.ts` helpers; **hub Tab ship screen** (2026-09-06): Tab in the hub opens the window in `is-hub` mode — screen tabs 인벤토리 / 캐릭터 / 기업(off), **함선 창고** (`Stash.ts`: 10×24 grid persisted in localStorage `scav.stash`, `GridId 'stash'`, `inventory:stashChanged`) · 장비 + **전술 임플란트 slot** (click → picker, click the equipped card = unequip) · 가방 (quick rose to its right ≥ 1600 px); right-click **수리** with the material cost on worn gear (`repairInfo`), 창고로 이동, no world drops in the ship (drops / overflow land in the stash)

- **Phase 6** — **무한 상자** catalog (`ui/CatalogView`, `openCatalog`, tabs + search, drag/double-press creates fresh instances, `ui:catalogToggled`), stash size from housing (`getStashSize/setStashSize`, save v2 with cols/rows, grow-only at startup), `countDefAll/consumeDefAll` (bag → stash), `captureLoadout/applyLoadout` (presets; missing defs empty the slot), **bench crafting** `openBenchCraft(kind, level)` (`CraftPanel` bench mode: locked rows, 작업실 discount, repair list), `getRecipes(station, bench?, level?)`

- **Phase 5** — `Loadout.ts` + `Serialize.ts` — bag / 5 slots / quick slots persisted in localStorage `scav.loadout` (restored once at init; saved on every hub change, `game:complete` and every starter reset, `inventory:loadoutSaved`), `findItemAnywhere / tryAddToStash / tryAddItemAnywhere / takeItem` for the corp shop, `inventory:containerOpened {first}`, 크레딧 readout + active **기업** tab (→ `ctx.meta.openCorpMenu`) on the hub Tab screen

- **Phase 7** — **Tarkov-style container search** (items start `searched:false`, revealed one at a time in grid order while the window is open within `SEARCH_MAX_DISTANCE`, time by rarity ÷ `derived.searchSpeedMul`, footprint mask + fill gauge, locked until revealed, progress kept across close / reopen, `container:searchProgress / itemRevealed / searchDone`), **host-authoritative container takes** in multiplayer (`contq take` → `cont taken / denied / sync`, `Container.order` idx, pending map for unopened containers), `canFit`, `captureRaidState / applyRaidState`, stash + loadout uploaded as profile docs and replaced on `net:profileLoaded` (offline edits win)

- **Phase 8** — the Tab screen hosts 캐릭터 / 기업 / **함선** tabs as embedded views (`.inv-screen`, window never closes, `.scr-tabs` hidden outside the hub), 전술 임플란트 / 필드 제작 / **아이템 분해** are modeless popups (`ui/Modeless.ts`, `ui/DisassemblePanel.ts`, `break_*` moved out of the craft list into the right-click menu), costs render as `renderItemCost` chips, credits pill = `CREDITS 500`, 씨앗 catalog tab

- **Phase 8 UI pass** — the 전술 임플란트 popup is a **centred fixed-size** panel that scrolls internally (장착 중 label under the description), dimmed 제작 rows are dimmed by colour instead of `opacity`, and `.inv-screen` (캐릭터 / 기업 / 함선) carries the `.inv-panel` chrome

- **Phase 9** — the folder's own offline-document queue is gone (`ProfileSync` owns it) — a starter / default save uploads as `profile.set(key, doc, {fresh:true})` instead, `openCatalog({category})` preselects a tab (훈련장 무기 거치대) and the catalog has a **서적** tab

- **Phase 9 UI/UX 개선** — 인게임 가방이 **함선 레이아웃 − 창고** (장비 좌 · 가방 우 · 퀵슬롯 오른쪽, 1280 px 부터; 버리기 존 · 키 힌트는 레이드 전용으로 유지), **전술 임플란트 슬롯 · 모달리스 picker 삭제** (캐릭터 탭으로 이전), `TradeGrids` 타일에 `data-item-tip` 스탬프. **Phase 9 UI pass**: `ui/TradeGrids.ts` + `createTradeGrids(host, opts)` — the real 가방 / 함선 창고 격자를 다른 폴더 화면(기업 거래)에 embed, **읽기 + 끌어내기 전용**(`dropSelector` 위에 놓거나 더블클릭 → `onTake`), 블로커 · 포인터 락 · 키 리스너 없음

- **Phase 10** — **live container loot sync** (`cont taken` already reached every peer, so this was a presentation gap — new `container:itemTaken {uid, qty, remaining, by, byName, byLocal, live}` separates a real-time take from a `cont sync` catch-up, another member's take plays a float-up + fade-out via `GridView.vanish` / `.is-vanishing` on the `translate:` / `scale:` / `opacity` channels, and `cont taken.rem / seq` converge the copy and drop duplicate / out-of-order takes), `ui/CrewLoadoutView.ts` (`captureCrewLoadout` / `createCrewLoadoutView` — another member's 장비 / 가방 / 빠른 사용 rendered **read-only** from the wire document, no 함선 창고 column, no credits), the 가치 row moved into a **bottom credit bar** of the tile tooltip, `fmtValue` reimplemented on `formatCredits` (`100 C`, no currency prefix), and the `'inventory'` cursor migration (Tab still opens while boarded in a pod — the READY panel's blocker is ignored)

- **2026-09-07 UI/UX pass** — the drag ghost rides the cursor **centred** (`grabX/Y` = half the footprint, re-centred after a rotation) and `.inv-root.is-dragging *`'s `cursor: grabbing !important` is scoped `body:not(.soft-cursor-on)` (it out-specified the software cursor's `cursor: none` and flashed the real Windows cursor for the length of a drag), **제작 is a column of the window again** (the `Modeless('craft')` popup is gone — `.inv-layout.is-craft` puts the recipe list leftmost and the new `.inv-col-right` wrapper drops its `display: contents` to stack 가방 over 함선 창고), **`openScreen(tab)` / `screenTab`** (the 기업 네트워크 console opens the Tab window's 기업 tab), and `GridView` / `buildTileContent` / `labels.tileSizeAt` / `TradeGridsOptions.cell` take a **per-view cell size** (기업 거래 40 px, everything else the default 54)

- **2026-09-07 (커서 편의성)** — 드래그 고스트의 1.04 확대를 CSS `scale:` 대신 `positionGhost` 의 `transform` 안에 넣었다 — 개별 변환은 translate → rotate → scale → `transform` 순이라 `scale:` 이 JS 가 쓴 translate 를 곱해, 화면 우하단으로 갈수록 아이템 그림이 커서에서 벌어졌다(x = 1080 에서 42 px)

- **2026-09-07 (기본 지급품 · 장비 상실)** — `Stash.firstRun` 이면 `STARTER_STASH` 를 **한 번** 창고에 넣고(`fresh` 문서) 같은 세션의 첫 `hub:entered` 에서 최소 킷을 장착한다, 레이드마다 주던 스타터가 사라지고(`world:ready` 는 **아무 것도 없을 때만** — `isDestitute()`), 레이드 실패 · 중단 · `reset()` 은 새 **`loseKit()`** 으로 들고 간 장비를 잃으며(창고까지 비었을 때만 최소 킷), 서버의 빈 loadout 문서는 더는 장비를 지우지 않는다

- **2026-09-07 (안정화)** — 힌트 바와 버리기 존이 **고정 높이 `.inv-footer`** 를 공유해 드래그 시작에 창이 위로 튀지 않고, `.inv-search-status` 가 고정 폭이라 감정 중 ↔ 감정 완료 에 컨테이너 패널 폭이 변하지 않으며, 드래그의 그리드 판정이 **엄격 판정 우선**(`GridView.hitTest` + `resolveGridTarget`)이라 인접한 가방 / 함선 창고가 서로의 가장자리 줄을 훔치지 않고, **장비 칸 → 격자** 드롭이 막힌 칸에 떨어지면 `nearestFreeSpot` 로 재조준한다(예전에는 무기가 칸으로 돌아가며 흔들렸다)

- **2026-09-07 (지급 조건 수정)** — 기본 지급품이 **프로필당 한 번**이 되었다 — 조건이 `Stash.firstRun`(= `scav.stash` 파일 없음)에서 새 플래그 `scav.grant`(`Stash.ts` 의 `starterGrantState` `none` / `pending` / `done`)로 바뀌고, `tryStarterGrant()` 가 init 에서 지급하고 **`net:profileLoaded` 직후** 한 번 더 확인한다(서버의 빈 창고 문서가 방금 지급을 덮어썼을 수 있으므로; 이미 뭔가 가진 프로필은 지급 없이 `done`)

- **Phase 12 (2026-09-08)** — 분해 게이지(`ui/DisassemblePanel` — 버튼 아래 `.inv-dis-bar` 를 프레임마다 갱신, `inventory:disassembleProgress` ≤ 30 Hz + `done:true` 1회, 취소 시 `{t:0}`), 회복 스프레이 함선 수리(우클릭 수리 — `sprayRepairCost` 캔 1 + 소독약 1 을 남은 게이지 비율로, `HEAL_SPRAY_GAUGE` 200 까지 충전; 게이지 0 인 캔도 아이템으로 남아 `게이지 0 / 200` 툴팁 + 타일 바), 임플란트 타일 툴팁(장착칸 · 능력치 줄 · `PERK_DEFS` 퍽 · 빨간 망가짐 + `repairCost` 칩)과 무한 상자 **임플란트** 탭; 임플란트는 기존 카테고리 검사로 퀵슬롯 · 장비칸에 들어가지 않는다

- **2026-09-08 (UI/UX)** — **임플란트가 인벤토리로 이사했다** (`ui/ImplantPanel.ts` — 전술 임플란트 + 임플란트 아이템 두 블록, `.inv-equip` 안 장비 격자 아래). 임플란트는 캐릭터 스탯 화면이 아니라 레이드에 들고 나가는 **장비**이고 로드아웃 프리셋에 함께 저장되어야 하므로 여기가 제자리다 — `progression/ui/SheetBody` 에는 아무것도 남지 않았다. `LoadoutPreset.implantItems`(append-only, def id 배열)를 `parts/StashOps` 의 `captureLoadout` 이 채우고 `applyLoadout` 이 적용한다(전부 해제 → 프리셋 순서대로 재장착; `[]` = 전부 해제, `undefined` = 건드리지 않음). `.inv-implants` 는 `width: 0` + `min-width: 100%` 다 — 장착 장비 칸은 `flex: none`(max-content)이라 임플란트 설명 줄이 고유 폭 계산에 들어가면 칸이 800 px 로 벌어져 가방 격자를 화면 밖으로 밀어낸다

- **2026-09-08 (UI/UX)** — 상자를 연 뒤 **0.1초 지나서** 감정이 시작한다 (`model.ts` 의 `SEARCH_START_DELAY`, `showContainer` 에서 무장하고 `updateSearch` 가 소진). 창이 뜨는 애니메이션이 끝나기도 전에 첫 아이템 게이지가 차 있던 것을 고쳤다 — 열 때마다 다시 지연되지만 `Container.searchProgress` 에 쌓인 초는 그대로다

- **2026-09-08 (UI/UX)** — `parts/LaunchCheck.ts` + `InventoryRef.getLaunchWarnings()` — 발사 슬롯 탑승 전 점검 6종. 판정은 가방 · 장비 · 탄약 스택 · 회복 아이템을 아는 이 폴더가 하고, 팝업은 `hub/ui/LaunchWarnPanel` 이 그린다

- **2026-09-08 (UI/UX)** — Tab 화면의 **캐릭터 탭에 레드닷** — `ui/parts/Screens.markTab` 이 `ctx.progression.statPoints > 0` 이면 `.has-alert` + `data-alert`(남은 포인트 수)를 붙이고, `progress:levelUp` / `progress:statChanged` / `progress:loaded` 에 다시 그린다 (점 자체는 `ui/styles/base.css` 의 `.scr-tab.has-alert::after`)

- **2026-09-08 (튜토리얼 게이트)** — `parts/Crafting.canCraft` 가 `ctx.tutorial?.blockReason('craft', recipeId)` 를
  보고(따라서 `craft` 도 함께 막힌다), `ui/parts/Screens.setTab` 은 튜토리얼 중 인벤토리 외 탭을 되돌리며
  `markTab` 이 그 탭에 자물쇠 + 사유 툴팁(`.scr-tab.is-locked`)을 붙인다. `ui/CraftPanel` 의 행에는
  `data-recipe` 가 이미 있었고, 튜토리얼 스포트라이트가 그것으로 대상을 집는다

- **2026-09-08 (튜토리얼: 잠그지 않고 감춘다)** — `ui/parts/Screens.markTab` 이 튜토리얼이 막는 화면 탭을
  자물쇠가 아니라 `hidden` 으로 처리하고, `ui/CraftPanel.refresh` 가 `ctx.tutorial.hides('craft', id)` 인
  레시피를 목록에서 뺀다 (재구축 서명에 현재 단계가 들어간다). `ui/InventoryUI` 가 `tutorial:changed` 를
  구독해 `markTab()` + `refresh()` 하므로, 건너뛰거나 끝나면 감춰 둔 탭 · 레시피가 즉시 돌아온다



- **2026-09-08 (제작 UI 정리)** — 제작 화면에서 **제작에 쓰지 않는 것을 전부 뺐다** (사용자 결정).
  ① 홀드 시간이 `model.ts` 의 **`CRAFT_HOLD_TIME` = 1 s 로 통일**됐다 (`parts/Crafting.craftDuration` 이 레시피와
  무관하게 그 값을 돌려준다). 이 누름은 만드는 시간이 아니라 **재료를 소모하기 전의 유예**라 레시피마다 다를 이유가
  없다 — 돌격소총이 6초짜리 누르기였다. `CraftRecipe.duration` 은 데이터로 남지만 시간으로 읽히지 않고, 행의
  `2.0 s` 칩도 없앴다 (분해도 같은 1초를 쓴다). ② `.inv-root.is-craft` / `.inv-layout.is-craft` 가 **장착 장비 +
  임플란트 열 · 퀵슬롯 로즈 · 상단 화면 탭 · 가방 헤더의 `제작` 버튼 · 하단 가치**를 숨긴다 (가방 용량은 남는다 —
  만든 것이 들어갈 자리인지 알려 준다). ③ 작업대 하단의 **수리 목록이 사라지고** `모두 수리` 가 헤더(닫기 왼쪽)로
  올라가 `ui/RepairPanel` 모달을 연다. 장비 칸이 숨으므로 만든 무기를 장착하려면 제작 창을 닫아야 하고,
  튜토리얼에 그 순서를 안내하는 `openBag` 단계가 새로 생겼다 (`src/tutorial`)

### 2026-09-09 — 제작 목록: 한 칸 썸네일 + 넣을 자리 검사 (가방 → 창고)

- **산출물 썸네일은 언제나 1×1** (`CraftPanel`). 실제 격자 크기로 그리니 4×2 돌격소총 한 줄이 탄약 한 줄의
  네 배로 벌어져 목록이 무너졌다. 여기서 알아야 할 것은 "무엇이 나오는가"이고, 몇 칸을 먹는지는 툴팁과
  아래의 공간 안내가 말한다. 겹치는 아이템의 수량은 1×1 타일도 그대로 그린다. 분해 팝업은 원래
  `buildItemChip`(정사각 칩)이라 손댈 것이 없었다.
- **누르기 전에 넣을 자리를 본다.** 재료가 다 있어도 결과물이 들어갈 데가 없으면 1초를 눌러 봐야 홀드 끝에서
  거절당했다. 이제 `CraftPanel.paint` 가 **스테퍼에 걸린 수량 그대로** `craftHasRoom(id, n)` 을 물어 버튼을
  잠그고(`.is-nospace`, 라벨 `가방·창고 공간 부족`, `title` 에 이유), `InventoryUI.refresh()` 를 타고
  **작업대를 열 때 한 번 + 가방 · 창고가 바뀔 때마다** 다시 검사한다.
- **가방 → 안 되면 함선 창고** (사용자 결정). `roomForOutputs` 가 가방 격자와 창고 격자를 한 덩어리씩
  `addUnits` 와 같은 순서로 시뮬레이션하고(가방 스택 합치기 → 가방 빈칸 → 창고 스택 합치기 → 창고 빈칸),
  `updateCraft` 는 `addUnits` 가 돌려준 넘침을 `tryAddToStash` 로 넘긴다 — 함선에서 넘치는 물건을 창고로
  보내는 규칙은 `throwToWorld` 가 이미 쓰던 것이다. 레이드 중에는 창고가 없으므로 예전대로 가방만 본다.
  분해 팝업도 같은 `craftHasRoom` 을 쓰므로 함께 따라간다.
  *(재료 쪽은 그대로 **가방만** 본다 — `canCraft` → `countDef` → `countWhere`. 가방 + 창고를 함께 쓰는 것은
  가구 제작 · 시설 업그레이드(`housing/`, `countDefAll`) 쪽이다.)*

### 2026-09-09 — ESC 닫기

`setOpen(true)` 가 `ctx.uiBlockers.add` 옆에서 `ctx.escape.push(BLOCKER_TOKEN, () => this.closeAll())` 하고
`setOpen(false)` 가 `remove` 한다. 창(가방 · 컨테이너 · 함선 3열 · 캐릭터 / 기업 / 함선 탭)이 ESC 로도 닫힌다 —
열린 화면 중 맨 위 하나만이므로 위에 다른 화면이 있으면 그것이 먼저다 (`shared/escape`, `game/escapeKey`).
**팝업 우선 규칙은 그대로다**: `escHandler` 가 `closePopups()` 로 수량 지정 · 우클릭 메뉴 · 분해 · 수리 ·
임플란트 피커를 먼저 취소하고 `stopPropagation` 하므로 그 Escape 는 `Input` 에 기록조차 되지 않는다.

### 2026-09-09 — 퀵슬롯은 또 하나의 가방 공간이다

사용자 결정: **소모품을 퀵슬롯에 올리면 가방 격자에서 사라진다.** 예전에는 퀵슬롯이 가방 아이템의 `uid` 를
가리키는 링크였고 스택은 격자에 그대로 있었다 — 같은 물건이 두 곳에 보였다.

- **모델** (`QuickSlots.ts`) — `QuickSlotUids`(uid 배열) → **`QuickSlotItems`**(`ItemInstance` 배열). 링크 시절의
  `assignQuickSlot` · `relinkQuickSlot` · `pruneQuickSlots` · `clearQuickSlotOf` · `autoAssignQuickSlots` 는 함께
  사라졌고, 대신 컨테이너로서 필요한 것들이 들어왔다: `lockedQuickItems`(작은 가방이 못 여는 칸의 스택),
  `mergeIntoQuick`(주움 · 제작이 휠 스택부터 채운다), `pickStarterQuick`(시작 키트가 **고르기만** 하고 옮기는 것은
  부르는 쪽). `quickSlotsSignature` 는 uid 해석 함수 없이 `(slots, active)` 두 인자다.
- **이동** (`InventorySystem.setQuickSlot`) — 가방 → 칸은 **옮기기**다(격자 칸이 빈다). 칸에 있던 것은 가방으로
  돌아가고, **가방에 자리가 없으면 이동 자체를 거절한다**(`inventory:full`) — 휠 아이템을 조용히 없애거나
  바닥에 떨어뜨리지 않는다. 이미 휠에 있는 스택을 다른 칸으로 옮기는 것은 두 칸을 맞바꾸는 것이고 가방을
  건드리지 않는다. `unregisterQuick(index)` 가 반대 방향(칸 → 가방)이다.
- **질의** — `countWhere` · `consumeWhere` · `getWeight` · `getTotalValue` · `findItem` · `locate` · `takeItem` 이
  휠을 함께 본다 (`locate` 를 빠뜨리면 휠 스택을 **버릴 수 없다** — `dropItem` 이 uid 를 그것으로 푼다)
  (퀵슬롯의 붕대도 들고 다니는 짐이고 레시피 재료다). `consumeWhere` 는 **가방을 먼저** 비우고 휠은 마지막이다 —
  일부러 올려 둔 것이 레시피에 먼저 먹히지 않게. `consumeItem(uid)` 는 반대로 **휠을 먼저** 본다 (빠른 사용의 손이
  거기서 꺼낸다). `getAllItems()` 는 여전히 가방 격자만이다 (거래 · 수리 목록).
- **예외: `splitItem` 은 격자 전용이다** (`locateInGrids`). 휠 칸은 한 칸이라 쪼갠 스택을 놓을 자리가 없다 —
  나눠야 하면 먼저 가방으로 되돌린다.
- **위치** (`model.ts`) — `ItemLocation` 에 `{ kind: 'quick'; index }` 가 추가됐다(`locKind` 는 `'player'`).
  UI 는 휠 칸을 그 위치로 넘긴다 — 예전처럼 `BAG_LOC` 으로 넘기면 `findItem` 이 못 찾는다. 무기는 휠에 오지
  않으므로 소켓 · 장비 슬롯 경로는 `quick` 을 거절한다.
- **세이브** (`Loadout.ts`, `LOADOUT_SAVE_VERSION` 1 → **2**) — `quick[i]` 가 `bag` 인덱스가 아니라 **스택 자체**
  (`SavedExtras`)다. **v1 파일은 읽을 때 이관된다**(`sanitizeLoadoutSave`): v1 의 `quick` 인덱스가 가리키던 항목을
  `bag` 에서 **빼내** `quick` 으로 옮긴다 — 살아 있는 모델과 같은 모양이 된다. 레이드 세션 blob · 크루 카드도
  같은 함수를 지나므로 함께 따라간다.
- **사망 · 가방 교체** — `stripForCorpse` 가 휠 스택도 시체에 넣는다. 가방을 더 작은 것으로 바꾸면
  `lockedQuickItems` 로 잠긴 칸의 스택을 가방으로 되돌리고, 그것도 넘치면 기존 `overflow` 와 함께 바닥에 떨어진다.
