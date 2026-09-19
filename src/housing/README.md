# housing/ — ship housing: rooms, furniture, stations, library, mining, persistence

`HousingSystem` publishes `ctx.housing` (`HousingRef`, contract in `src/shared/housing.ts` — several appended
`interface HousingRef` blocks). It owns **every housing rule** (placement, access faces, costs, generator gates,
station timers, library effects, mining cycles), the persisted `ShipState` (localStorage + the `ship` server profile
document), housing-mode *state*, and the DOM screens of ship furniture (grow station, analyzer, culture tank, dining
table, library shelves, cooking, gym / video games, mining, TV). `src/hub/` owns the 3D side (rooms, furniture meshes,
housing-mode camera / cursor, staging poses) and calls this API; `src/inventory/` supplies materials and grids;
`src/progression/` reads `getSkillGainMul` / `getLibraryEffects`. Registered in `main.ts` after `ProgressionSystem`
and **before** `InventorySystem` / `WorldSystem` / `HubSystem`.

## Files

| File | Responsibility |
|---|---|
| `HousingSystem.ts` | System + `HousingRef` implementation. Loads state in the constructor, owns housing-mode / ship-manage state and panel instances, server-profile replace (`onProfileLoaded`), retired-furniture refund (`flushRetiredRefund`), one-line delegations into `parts/*`. Re-exports `model.ts`. |
| `model.ts` | Folder vocabulary (no state): `FACILITY_IDS`, `BOOKS_BLOCK_REASON` / `SHELF_BLOCK_REASON` / `UNKNOWN_SHELF_ITEM_CELLS` (the cells an unresolvable shelved def is billed at — one value for both recover pre-checks), shelf labels / glyphs (`SHELF_GLYPH`, `LIBRARY_GLYPH`), `ACTIVE_FURNITURE_DEFS` (= defs minus `retired`), retired-rack answers. |
| `Rules.ts` | Pure rules, no ctx / DOM — see **Rules** below. |
| `MiningRules.ts` | Pure mining rules: per-cell processors (`processorCells`, `processorCount`, `clusterPerf`, `clusterCycleMs`, `wearProcessors`), `takeCompletedCycles`, `foldProgress`, `sanitizeClusters`, `sanitizeUnitsMap`, `CLUSTER_CORES_BLOCK_REASON`, `MINING_TICK_MS`. The base cycle formula lives in `shared/cryptoMarket`; `clusterCycleMs` is its fractional form (a perf sum is not an integer). |
| `ShipState.ts` | `freshState`, `sanitize(raw, out?)` (all migrations + validation), `loadState`, `writeState`, `ShipStore` (debounced write + `pagehide` flush + profile upload), `ensureCockpitFurniture`, `placeCockpitDecor`, `is*DefId` helpers, `SHIP_STATE_VERSION_CURRENT`. |
| `index.ts` | Barrel: `HousingSystem`, `Rules`, state helpers. |
| `housing.css` | Shared panel styles (`.hs-*` shell / cards / modal / tip / context menu / rail / tabs, `.gs-*` grow, `.az-*` analyzer, `.cult-*` culture, `.dt-*` dining, `.lib-*` library, `.facility-chip` icon + `[data-fc-tip]` tooltip). Does **not** redeclare the `--inv-*` palette (owner: `inventory/inventory.css`). |
| `parts/Rooms.ts` | Room purposes (build = consume `purposeCost`, remove = full refund), facility info / upgrade (generator, storage), `getBenchLevel`, `getSkillGainMul`, stash size, `consume` / `canAfford`. |
| `parts/Furniture.ts` | Place / move / recover / craft / upgrade furniture, housing mode + ship-manage mode (`openShipManage` remembers the last room in `slotKey('scav.housing.manageRoom')`), `furnitureCraftBlock` / `furnitureUpgradeBlock` / `furnitureUpgradeCost`. |
| `parts/Garden.ts` | Grow station: `fillSoil` → `plantSeedAt` → `harvestAt`, soil durability + sockets, `rescaleGrowsForUpgrade`, `insertGrowSocket`; retired grow-rack API answers "no rack". |
| `parts/Lab.ts` | Analyzer: `startAnalysis` (rolls the result on insert, sample rarity is the floor), `cancelAnalysis`, `collectAnalysis` (analysis XP → level-ups, found-dex, **sample level**, research XP), `getAnalysisLevel/Results/Found`, `getSampleAnalysis` / `getAnalysisDexByRarity` (speed-up readout), `researchTimeMul`, `devAdvanceAnalysis`. |
| `parts/Culture.ts` | Culture tank: medium → scaffold → strain, medium durability + sockets, harvest, `insertScaffold` / `takeScaffold` / `insertCultureSocket`. |
| `parts/Sockets.ts` | Soil / medium sockets shared by Garden and Culture: `socketSum`, `yieldBonus`, `insertSocket` (replace destroys the old socket), `getOwnedSockets`. |
| `parts/Deliver.ts` | `deliverItem(sys, item, dest)` — the single path a station product takes to the player (`HarvestDestination`: `bag-first` · `stash-first` · `bag` · `stash`; named grids never overflow). `withDropCell(cell, fn)` marks "the player dropped it **here**" for the one delivery inside `fn` (the cell wins; a cell that cannot take it is refused, not auto-placed elsewhere — `noRoomReason` then says `그 칸에는 놓을 수 없습니다`). |
| `parts/Dining.ts` | Dining table + plates (furniture uid, or `null` = shared-ship fixed table): `hasDiningTable`, `getPlate` / `setPlate` / `clearPlate`, `getTablePlates`, `plateEatBlock`, `eatPlate`, `devSetPlate`, squad plates (`SquadPlate`, `net:squadPlate`), `bindDining` (raid start clears the plate), `diningBlock`. |
| `parts/Cooking.ts` | Cooking session: `cookRecipes` (all cook-bench recipes with steps, unfiltered), `cookBlock` (incl. the dining-table gate), `startCook` / `restartCook` / `cancelCook`, `recordCookStep` (+ skill / library score bonus), `completeCookRun` (quality → `inventory.consumeCookInputs` → plate on the table), `getCookAuto`, `bindCooking`, `cookDebug` (`replaceAsk` / `confirmReplace`). |
| `parts/CookGames.ts` | DOM-free judges of the six cooking minigames (`ChopGame`, `MinceGame`, `GrillGame`, `StirfryGame`, `StirGame`, `PourGame`), `createCookGame`, `cookJudgeBands`. |
| `parts/Gym.ts` | Gym session: `gymBlock`, `startGymSession`, `completeGymSession` (→ `progression.applyGymSession`, + library `gymScore`), `bindGym`, `gymDebug`. |
| `parts/GymGames.ts` | DOM-free judges `PressGame` / `BreathGame` / `CycleGame`, `createGymGame(kind, tuning?)`, `judgeBands`, `completion`. |
| `parts/VideoGame.ts` | TV consoles (`attachTvConsole` / `detachTvConsole`, refusal `TV_CONSOLE_BLOCK_REASON`), optional seat pick (`Rules.tvSeatFor` — no seat = standing session), `getPlayableGames`, game sessions (gym rules via `applyGymSession`), `GAME_MINIGAME_LABEL_KO` / `gameMinigameLabel` (the one spelling of a **game disc's** minigame, separate from the gym equipment's `GYM_MINIGAME_LABEL_KO`), `bindVideoGame`, `videoGameDebug`. |
| `parts/Library.ts` | Library shelves for every medium (`book` · `disc` · `record` · `game`): place / take / dex / recover-to-stash, on/off toggles, library-effects cache (`ensureLibrary`, `bindLibrary`, `tickLibrary`) and its queries. |
| `parts/Music.ts` | Music player state (no audio): playlist from record racks, `tickMusic`, `musicNext/Prev`, `setMusicMode`, `musicStop`, `housing:musicChanged`. |
| `parts/Mining.ts` | Compute clusters, wallet, trading: `setClusterCoin`, `insertClusterProcessor` / `removeClusterProcessor` (one named cell) and their count-based wrappers `insertClusterCores` / `removeClusterCores`, `tickMining` (1 Hz, not in raid — settles cycles **and wears the mounted processors**), `tradeCrypto`, `coinLockReason`, dev cheats. |
| `parts/Presets.ts` | Retired loadout presets (all answer "no slots"), `panels()` registry, `closeMenus`, legacy `openRoomMenu` / `openFacilityMenu` → `openShipManage`. |
| `ui/Panel.ts` | `HousingPanel` base: `.menu.housing-menu`, blocker `'housing'` + cursor mode, `ctx.escape` entry, E / Tab close, `PanelOverlay` stack, `coalesceRefresh`, `ui:housingToggled`, key-guide owner `housing.<page>`. |
| `ui/StationShell.ts` | Common station layout: station card (title, `Lv.`, meta, upgrade button, `rail`, optional `tabsRow`) + one inventory card; `mountStationGrids` mounts one `TradeGrids` (`stash` + `bag`); `stationGridCell`. |
| `ui/UpgradeModal.ts` | Upgrade modal (`PanelOverlay`): cost chips + facility chips, 1 s hold confirm (Enter swallowed), escape token `housing.upgrade`. `UpgradeModalOptions.standalone` mounts it on `ctx.uiRoot` instead of a panel (`.hs-modal-top` z, own `.interactive`, swallows Tab, `onClose` hook) — used by the 창고 variant. |
| `ui/StorageUpgrade.ts` | The one standalone `UpgradeModal` the screens outside housing open, for **two subjects**: 창고 시설 (`openStorageUpgrade` — level, cells before/after from `STASH_ROWS_BY_STORAGE_LEVEL × STASH_COLS`, `getFacility('storage')`, confirm = `upgrade('storage')`) and **one placed workbench** (`openBenchUpgrade(kind)` = `HousingRef.openBenchUpgrade` — highest-level piece of that bench kind, `제작 n가지 개방` counted from `InventoryRef.getRecipes`, confirm = `upgradeFurniture(uid)`). `openStorageUpgrade()` routes to the bench while the craft column is in bench mode (`InventoryRef.getBench()`), so the workbench header's 업그레이드 no longer opens the 창고 modal. Toggles on a second call for the same subject, re-reads on housing / inventory events, closed by `closeMenus`. |
| `ui/ItemTile.ts` | `buildStationItemTile(ctx, defId, {cell, durability?})` — the **inventory tile** (`InventoryRef.buildItemTile`) as one station cell: `.hs-tile`, no quantity badge, `--inv-cell` so the glyph follows the cell; `cellToFit(boxW, boxH, w, h)` (the cell edge a footprint fits a box at), `stationTileBox`, `itemFootprint(ctx, defId)` and `buildFootprintCells(w, h, cell)` — an **empty** mount slot drawn as the accepted item's `w × h` grid cells (`.hs-fcells` › `.hs-fcell`, inventory empty-cell look; cluster + shelves, not grow / culture). The one place furniture screens draw an item. |
| `ui/StationTip.ts` | Non-item hover card (`TipSpec`) with `.item-tip` looks. |
| `ui/StationMenu.ts` | Right-click menu (`PanelOverlay`), swallows its own Escape. |
| `ui/ProductDrag.ts` | Treat a finished product like an item: drag to a grid (`bag` / `stash`) or double-click (`stash-first`). The ghost keeps the item's grid footprint (`shared/itemChip` `buildItemGridChip` / `itemGridBox` at `stationGridCell()`, overridable with `cellPx`). With `grids()` given, a release lands in the **cell under the cursor** (`parts/Deliver.withDropCell` → `StationGridsView.placeExternalAt`) and while dragging only that cell's footprint is highlighted (`StationGridsView.previewExternalAt`); the whole-block `.hs-drop-over` is the fallback for a view without preview. |
| `ui/SocketFlow.ts` | Socket effect text / tip rows / dots, `SocketAsk` (pick + 1 s hold replace confirm, destructive clear confirm). |
| `ui/dom.ts` | `el`, `section`, `setText`, `renderCost` (→ shared `renderItemCost`), clock helpers (`renderClock`), `formatRemaining`, `facilityChipTip`. |
| `ui/GrowStation.ts` | Grow station screen: rail of stations (9-dot status), tiers of soil pots, drop soil / seed / socket, harvest via `ProductDrag`, right-click clear. `ui:growToggled`. |
| `ui/Analyzer.ts` | Analyzer screen: rail tabs `해석` / `분석 도감`, slots with family chip + **sample-level chip** (`Lv.n −x %`) + result chip, the 등급별 도감 단축 line above the slots, collect / cancel. |
| `ui/SampleDex.ts` | Analysis dex per family (level, XP bar, result rows: found / silhouette / locked). |
| `ui/CultureTank.ts` | Culture tank screen: rail of tanks (3-dot status), tubes (fluid = medium durability), drop medium / scaffold / strain / socket, `배양 시작` button per tube (1 s hold ask `cult-start`), right-click take back before start, harvest. |
| `ui/DiningTable.ts` | Dining screen (no grid card): plates on the table (`.dt-plate`, cook's name on the shared table, `먹기` / `먹음`) + the pending-meal card (`.dt-meal`), `닫기` inside the card's bottom-right (`.dt-foot`); exports meal text helpers (`mealEffectText`, `mealBuffText`, `mealTierText`, `qualityName`). |
| `ui/BookshelfMenu.ts` | Library screen for every shelf medium: rail = `서재` summary + placed shelf furniture, tabs `선반` / `도감`, drag to place / swap / take. `ui:bookshelfToggled` / `ui:shelfToggled`. |
| `ui/ShelfDrawing.ts` | Drawn shelf (`.lib-case` › `.lib-tier` › `.lib-row` › `.lib-slot` › `.lib-item`), layout from `SHELF_TIERS` / `SHELF_TIER_COLS`; `.is-div` divider; `SHELF_SLOT_BOX` / `shelfSlotBox(medium)` = the room a slot may take; `shelfFootprint(defs, medium)` = largest footprint of that medium's items, and `buildShelfDrawing(host, medium, footprint)` sizes every slot to that footprint's grid box (`drawing.cell`, CSS `--lib-item-w/h`); `paintShelfSlot(view, paint, buildTile, empty?)` — a filled cell holds one **inventory tile**, an empty one the footprint's grid cells. |
| `ui/BookDex.ts` | Library dex rows (series / game discs), exports `libraryEffectText`, `gameDiscText`, `volumeRoman`, `seriesTint`, `statName`. |
| `ui/ShipView.ts` | `createShipView(host)` — the embedded ship tab of the inventory window (generator / storage rows, room list, build / remove popups, `시설 관리` button). No blocker, no pointer lock, no Escape listener. |
| `ui/FacilityRows.ts` | Facility rows + effect summary used by `ShipView`. |
| `ui/cook/CookStation.ts` | Cooking-bench screen (page `cook`): vertical recipe list (`.cook-cell` rows: thumbnail + name, `data-rank`; bench-level- and recipe-book-locked recipes are not listed) + detail (base effects, ingredients, steps, auto appliance, skill-lock badge), `조리 시작`. `ui:cookStationToggled`. |
| `ui/cook/CookScreen.ts` | Bottom-center cooking overlay (root `.cook-ovl` — never `.cook`, that is the grenade cook gauge in `ui/styles/base.css`): choose (manual / auto) → game → step score → result. Blocker / escape / key-guide `housing.cook`; input on the whole panel while playing. |
| `ui/cook/CookViews.ts` | Six cooking game stages (CSS shapes + item chips, no assets). |
| `ui/cook/cook.css` | `.cook-*`. |
| `ui/cook/PlateAsk.ts` | 「식탁의 요리를 바꿉니다」 warning (`openHoldAsk`, id `cook-replace-plate`) before a cook starts / restarts while a plate exists; one at a time in `sys.plateAsk`, `closePlateAsk` on forced exits. |
| `ui/gym/GymScreen.ts` | Gym / video-game overlay: intro → game → result, keyboard input via `Keys.JUMP` / `LEFT` / `RIGHT`, rAF loop + fallback interval. Token `housing.gym`. |
| `ui/gym/GymViews.ts` | Gym game stages (press bar, breath / cycle lanes). |
| `ui/gym/gym.css` | `.gym-*`. |
| `ui/tv/TvMenu.ts` | TV screen (page `tv`): power, console attach / swap, seat line, playable games. `ui:tvMenuToggled`. |
| `ui/tv/tv.css` | `.tvm-*`. |
| `ui/mining/MiningScreen.ts` | One mining window (page `cluster`) with top tabs `MINING_TABS` (`채굴` · `클러스터 현황` · `지갑` · `거래소`) — the Tab screen's own `.scr-tabs` on the menu root (same fixed top as 인벤토리/캐릭터/기업/함선; frame starts below it); rail + grids only on the mining tab. `ui:miningToggled` page = `cluster` for the mining tab, `computer` otherwise. |
| `ui/mining/ClusterPage.ts` | Mining tab: **processor cells** (index = grid cell; the dropped instance goes into the cell it was dropped on, with its durability; slot box = processor footprint measured at paint, empty = 2×1 grid cells), cycle bar, coin picker, stats. No cluster uid (opened from the main computer) → the first placed cluster; an empty cluster shows no banner / red reason. |
| `ui/mining/CoinPicker.ts` | Filterable coin dropdown (locked coins dimmed), `position: fixed`. |
| `ui/mining/ComputerPages.ts` | Cluster overview, wallet, exchange (chart, hold-to-trade, stale-quote gate, price subscription). |
| `ui/mining/CryptoChart.ts` | Canvas candle / line chart with axes and hover OHLC. |
| `ui/mining/common.ts` | Shared mining helpers (`coinInfos`, formatting, `bindHoldButton`, `MiningAsk`). |
| `ui/mining/mining.css` | `.mn-*`. |

## Public API

Contract: `HousingRef` in `src/shared/housing.ts` (types `ShipState`, `FurnitureDef`, slot infos, etc. live there
too). Most mutations return `null` on success or a Korean refusal string. Grouped surface:

- **State / persistence**: `state`, `save()`, `getStashSize()`.
- **Rooms & facilities**: `getRoom`, `setRoomPurpose`, `purposeBlock`, `purposeCost`, `purposeRequirements`,
  `emptyRoomBlock`, `findRoom`, `getFacilities` / `getFacility`, `upgrade('generator' | 'storage')`,
  `facilityRefund`, `removeRoomFacility`, `getBenchLevel`, `getCraftCostMul` (always 1), `getSkillGainMul`,
  `openStorageUpgrade()` / `openBenchUpgrade(kind)` (2026-09-16 — the standalone upgrade modal the inventory Tab stash header and the workbench craft window call; the workbench one raises **that bench**).
- **Furniture**: `getFurnitureDef`, `getAllFurnitureDefs`, `getFurnitureFor`, `getPlaced`, `getPlacedByUid`,
  `getStored`, `canPlace`, `placementBlock`, `findFreeSpot`, `place`, `move`, `recover`, `recoverBlock`,
  `canCraftFurniture`, `craftFurniture`, `furnitureCraftBlock`, `upgradeFurniture`, `furnitureUpgradeBlock`,
  `furnitureUpgradeCost`, `furnitureUpgradeRequirements`, `isFurnitureOn`, `toggleFurniture`,
  `furnitureOperationalBlock` (cluster without main computer), `stationNow` (= `nowMs()`).
- **Housing / ship-manage mode**: `enterHousingMode` (no in-game caller), `exitHousingMode`, `openShipManage(room?)`,
  `setManageRoom`, `closeShipManage`, `selectFurniture`, `rotateSelection`, `housingMode`, `shipManageMode`.
- **Grow station**: `getGrowSlots`, `fillSoil`, `clearSoil`, `plantSeedAt`, `harvestAt`, `harvestAllStation`,
  `insertGrowSocket`, `getOwnedSoils` / `getOwnedSeeds`, `openGrowStation`. Retired: `getPlots`, `plantSeed`,
  `harvestPlot`, `harvestAll`, `openGrowMenu`.
- **Analyzer**: `getAnalyses`, `startAnalysis`, `cancelAnalysis`, `collectAnalysis`, `collectAllAnalyses`,
  `getOwnedSamples`, `getAnalysisLevel`, `getAnalysisResults`, `getAnalysisFound`, `getSampleAnalysis(defId)` /
  `getAnalysisDexByRarity()` (2026-09-16 — sample level, dex entries by rarity and the resulting speed-up),
  `openAnalyzer`, `devAdvanceAnalysis`. Deprecated: `getSampleDex`, `getSampleDexRatio`.
- **Culture tank**: `getCultureSlots`, `fillMedium`, `clearMedium`, `insertStrain`, `insertScaffold`,
  `takeScaffold`, `startCulture`, `takeStrain`, `takeMedium`, `insertCultureSocket`, `harvestCulture`, `harvestAllCultures`, `getOwnedMediums` /
  `getOwnedStrains` / `getOwnedSockets`, `openCultureTank`.
- **Dining / cooking**: `hasDiningTable`, `getPlate`, `getTablePlates(uid | null)`, `plateEatBlock`, `eatPlate(uid, ownerId?)`,
  `devSetPlate`, `clearPlate`, `mealDef` (→ `shared/meals`), `diningBlock`, `openDiningTable(uid | null)`;
  `openCookStation`, `cookSession`, `cookBlock`, `startCook`, `cancelCook`, `getCookAuto`, `cookRecipes`.
- **Gym / video games**: `gymSession`, `gymBlock`, `startGymSession`, `cancelGymSession`; `getTvConsole`,
  `attachTvConsole`, `detachTvConsole`, `getTvSeat`, `tvSeatBlock`, `getPlayableGames`, `openTvMenu`, `gameSession`,
  `gameBlock`, `startGameSession`, `cancelGameSession`.
- **Library**: `getShelfMedium`, `getShelfSlots`, `placeShelfItem`, `takeShelfItem`, `getOwnedShelfItems`,
  `getShelfDex`, `openShelf`, `getLibraryEffects`, `getLibrarySources`, `getSeriesProgress`, `isShelfItemWanted`,
  `isRecipeUnlocked`, `getBookBonus`, `getShelfBonus`, `hasShelfAux`; book-only legacy names (`getBooks`,
  `placeBook`, `takeBook`, `getOwnedBooks`, `getBookDex`, `openBookshelfMenu`).
- **Music**: `getMusicState`, `musicNext`, `musicPrev`, `setMusicMode`, `musicStop`.
- **Mining**: `getCryptoCoins`, `getCryptoWallet`, `getMiningComputerUid`, `getComputeClusters` /
  `getComputeCluster` (`processors` per cell · `processorMax` · `perf`), `setClusterCoin`,
  `insertClusterProcessor(uid, cell, itemUid?)` / `removeClusterProcessor(uid, cell, dest?)`,
  `insertClusterCores` / `removeClusterCores` (count wrappers), `cryptoQuote`, `tradeCrypto`,
  `openComputeCluster` (default tab `채굴`), `openMiningComputer(uid, tab?)` (default `클러스터 현황`); dev
  `devSetCryptoWallet`, `devSetClusterCores`, `devAdvanceMining`.
- **Presets (retired)**: `getPresetCount` 0, `getPresets` [], `savePreset` / `deletePreset` false, `applyPreset` null,
  `openPresetMenu` no-op. `captureLoadout` delegates to inventory.
- **Embedded view**: `createShipView(host)` → `EmbeddedView`.

**Events emitted** (payloads in `src/shared/events.ts`): `housing:loaded`, `housing:changed {reason}`,
`housing:stashSizeChanged`, `housing:roomPurposeChanged`, `housing:facilityUpgraded`, `housing:furniturePlaced` /
`Moved` / `Recovered` / `Upgraded` / `Toggled`, `housing:modeChanged`, `housing:selectionChanged`,
`housing:shipManageChanged`, `housing:growChanged`, `housing:analysisChanged` / `analysisFound` / `analysisLevelUp`,
`housing:cultureChanged`, `housing:socketInserted`, `housing:booksChanged`, `housing:shelfChanged`,
`housing:libraryChanged`, `housing:plateChanged` / `tablePlatesChanged`, `housing:cookSession` / `cookStep` / `cookBeat` / `cookResult`,
`housing:gymSession` / `gymBeat` / `gymResult`, `housing:gameSession` / `gameBeat` / `gameResult`,
`housing:tvConsoleChanged`, `housing:musicChanged`, `housing:clusterChanged`, `housing:cryptoMined`,
`housing:walletChanged`; UI: `ui:housingToggled`, `ui:growToggled`, `ui:bookshelfToggled`, `ui:shelfToggled`,
`ui:cookStationToggled`, `ui:miningToggled`, `ui:tvMenuToggled`, `ui:keyGuide`, `ui:notify`; plus `audio:play`,
`gather:collected` (harvest).

**Events consumed**: `game:newMission`, `game:abort`, `hub:left`, `game:phaseChanged` (close panels, leave modes,
cancel sessions, stop music), `hub:entered`, `net:profileLoaded`, `inventory:changed` / `inventory:stashChanged`,
`input:bindingsChanged`, `player:furniturePoseEnded` (cancel gym / cook / game session),
`progress:trainedChanged` / `progress:gymFatigue`, `meta:creditsChanged`, `net:cryptoPrices` / `net:cryptoHistory`,
`net:squadPlate` / `net:lobbyLeft` / `net:lobbyUpdated` (squad plates), `game:newMission` (clears the plate unless training).

**Blocker / escape tokens**: panels `'housing'` (`ui/Panel`), upgrade modal `housing.upgrade`, gym `housing.gym`,
video game `housing.game`, cooking `housing.cook`.

## Rules

Placement, facility and station rules live in `Rules.ts` as pure functions; the code comments above each carry the
reasoning. The list below is what a maintainer would otherwise break.

### Facilities and rooms
- Generator starts at `GENERATOR_START_LEVEL`, max `GENERATOR_MAX_LEVEL`. It is only a **gate**: building a purpose
  needs `generatorLevel ≥ purposeGeneratorLevel(purpose)` (`data/room_purposes.csv` `generator`), and every
  furniture / storage upgrade to Lv.n needs generator Lv.n. No power allocation exists — the retired power
  contract names in `shared` have no implementation. — `Rules.ts` (`generatorGateReason`, `purposeBuildBlockReason`)
- `generatorRequirement` / `purposeRequirementsFor` / `furnitureUpgradeRequirementsFor` return **satisfied**
  requirements too (for the `have/need` chip). Never gate on array length — the `*Reason` / `*Block` functions decide.
  — `Rules.ts` (`generatorRequirement`)
- Every assignable purpose (`ROOM_PURPOSES_ASSIGNABLE`) is at most one per ship; rooms have no levels (only
  generator and storage do). Room effects come from the furniture inside. `NEEDS_GREENHOUSE` is an empty array
  (no purpose prerequisites); refilling it revives the rule in all three consumers. — `Rules.ts` (`purposeChangeReason`)
- Building a purpose consumes `purposeCost` (all-or-nothing, bag → stash); removing a facility sends furniture to
  furniture storage and refunds the full build price into the ship stash (pre-checked stash space).
  — `parts/Rooms.ts` (`setRoomPurpose`, `removeRoomFacility`)
- Material shortage reasons are always `MISSING_MATERIALS_REASON` (`재료 부족`) — the chips' `.is-short` list what is
  missing. — `Rules.ts`
- The cockpit is `COCKPIT_ROOM_INDEX`, outside `rooms[]`: no purpose change, own grid (`roomGridSize`) with
  `COCKPIT_BLOCKED_RECTS`, accepts `room: 'any'` plus cockpit-only furniture. Cockpit-only facilities (implant bay,
  corp computer) always exist exactly once, can be moved inside the cockpit but never recovered.
  — `ShipState.ts` (`ensureCockpitFurniture`), `parts/Furniture.ts` (`recoverBlock`)

### Furniture
- Furniture is **not an item** — it lives only in `furnitureStorage` / placed `furniture`. `retired` defs are hidden
  from every list and refused by craft / place, but `getFurnitureDef` still resolves them (needed for refunds).
- `furnitureCraftBlock` answers `이미 보유 중입니다` for a utility piece (`isUtilityFurniture`, not `multi`) already
  placed or stored. It is a **query for the UI**, not a rule: `craftFurniture` does not enforce it.
  — `parts/Furniture.ts` (`furnitureCraftBlock`)
- One placement check for every path: `placementBlockOf` (slot → purpose → grid → fixture → stack → overlap → own
  access faces → others' access faces). Access face comes from `data/furniture.csv` `access`: `front` (row in front
  of local −Z clear, not a wall), `sides` (both long faces), `all`, `none`. Clearance cells may overlap each other.
  Hand placement, `move`, `autoPlaceSpot` and `ShipState.sanitize` all go through it. — `Rules.ts` (`placementBlockOf`)
- Auto placement (`findFreeSpot` = `autoPlaceSpot`) scans screen top-left first, prefers yaw 1 (faces screen-down),
  then `AUTO_PLACE_FALLBACK_YAWS`, and keeps a door clearance box free (second pass allows it only while
  `doorPassageOpen`). The door box is **only** in auto placement — putting it in `canPlaceAt` would evict existing
  saves on load. — `Rules.ts` (`autoPlaceSpot`, `DOOR_CLEAR_DEPTH`)
- Recovering a shelf moves its contents to the stash all-or-nothing (`SHELF_BLOCK_REASON` if they do not fit); a
  cluster with cores is refused (`CLUSTER_CORES_BLOCK_REASON`); a TV returns its console to the stash first;
  recovering a station drops its slots (growing crops / samples / cultures are lost).

### Stations (grow station, analyzer, culture tank)
- Timers are real time: `nowMs()` = relay `serverNow()` else `Date.now()`. Duration is **fixed at insert**
  (`readyAt`). The only exception is a grow-station upgrade, which compresses running crops by the speed ratio.
  — `parts/Garden.ts` (`rescaleGrowsForUpgrade`), `Rules.ts` (`rescaleGrowTimes`)
- Grow station: every tier is open from Lv.1 (`growTiersForLevel`); tier ids never shift. Level raises growth speed
  (`GROW_STATION_SPEED_PER_LEVEL`). A slot is soil first, then seed; soil tag vs seed tag gives
  `SOIL_MATCH_SPEEDUP` / `SOIL_MISMATCH_PENALTY`. — `Rules.ts` (`growDurationMs`)
- Soil and culture media carry **durability** and **sockets** in the slot (not in the item); a worn slot stays
  filled, bonuses and socket `speed` / `yield` scale by `durabilityRatio`, `wear` does not. Clearing soil / medium
  never refunds it; replacing a socket destroys the old one. — `parts/Sockets.ts`, `Rules.ts` (`wearAfterHarvest`)
- Analyzer / culture slots are opened by furniture level (`analyzerSlotsForLevel`, `cultureSlotsForLevel`); slot
  indices never shift. `getAnalyses` / `getCultureSlots` always return the max slot count with `locked` +
  `unlockLevel` derived from the contract.
- Analysis result is rolled **on insert** from `data/analysis_results.csv` by family and analysis level. Since
  2026-09-16 the **sample's rarity is the floor of the result's rarity** (`rarityRank(result) >= rarityRank(sample)`);
  a row with `sampleRarity` set belongs only to that rarity and is exempt from the floor (the six 석영 rows — also the
  guard that no rarity ever ends up with an empty pool). The floor callbacks are passed into the pure roll
  (`Rules.AnalysisRollOpts`) because rarities live in the item table. — `Rules.ts` (`rollAnalysisResult`), `parts/Lab.ts`
- Analysis time = `analyzeHours × analysisTimeMul(family level) × (1 − speedup) × derived.researchTimeMul`, fixed at
  insert. `speedup = min(ANALYSIS_SPEEDUP_CAP, dex entries of that rarity × ANALYSIS_DEX_BONUS_PER_ENTRY + level bonus)`
  and `level bonus = 0 | FIRST | FIRST + (n − 1) × STEP` — the gap between `FIRST` and `STEP` **is** "the first analysis
  of a sample pays most". The dex bonus is counted in **entries, per rarity**, and applies to every sample of that
  rarity. — `Rules.ts` (`analysisSpeedup`, `analysisDurationMs`)
- Sample level (`ShipState.sampleLevels`) is **how often that sample was collected** — cancelling never counts, and it
  is capped at `ANALYSIS_SAMPLE_LEVEL_MAX`. Cancel never returns the sample. Collect is all-or-nothing through
  `deliverItem`. — `parts/Lab.ts` (`startAnalysis`, `collectAnalysis`)
- Culture output ignores `gatherYieldMul`; a scaffold switches output to `scaffoldOutputDefId` and is consumed on
  harvest. Retired strains are refused.
- Inserting a strain does **not** start a culture (2026-09-17): "started" = `startedAt > 0` (`parts/Culture.cultureStarted`),
  set only by `startCulture` after the UI's 1 s hold confirm; `readyAt` is fixed there. Before start the strain / scaffold /
  an unused medium come back; after start nothing does. `sanitize` keeps a waiting strain without a timer. — `parts/Culture.ts`
- 재배 스테이션 and 배양조 are `multi` in `data/furniture.csv` — any number, each with its own level and slots (floor space is the
  only limit).
- Products reach the player only through `parts/Deliver.deliverItem`; a named grid never overflows into the other.

### Kitchen, gym, video games
- **Meals are not items** (2026-09-16). A finished cook becomes the ship's **one plate** (`ShipState.plate`) on the
  dining table; cooking again replaces it at completion (the old plate stays if the cook is cancelled). The UI asks with
  a 1 s hold before a cook starts / restarts while a plate exists (`ui/cook/PlateAsk`) — `startCook` itself does not ask.
  Plate writes use `saveSoon` (no `housing:changed`, so hub rebuilds only dining rooms on `housing:tablePlatesChanged`).
  — `parts/Dining.ts` (`setPlate`), `parts/Cooking.ts` (`completeCookRun`)
- No placed dining table → the cook bench cannot be used (`DINING_TABLE_MISSING_REASON`: `cookBlock`, `openCookStation`
  toast, hub prompt; appliances route through the same open). — `parts/Cooking.ts` (`blockCore`, `openCookStation`)
- Eating never consumes the plate: `eatPlate` = `progression.useMeal(meal, quality)` (same meal + quality refused, a
  different one replaces the pending meal). `plateEatBlock`'s `이미 먹었습니다` is display only. The plate is cleared on
  `game:newMission` unless `mode === 'training'` (same condition as `armPreps`). — `parts/Dining.ts` (`bindDining`)
- Shared-ship fixed table (`uid` null) lists my plate + squad plates (`squadPlates`, filled from `net:squadPlate`, pruned
  on `net:lobbyUpdated` / `net:lobbyLeft`, cleared on `game:newMission`); anyone can eat any plate. The old
  `serveMealToSquad` / `housing:mealServed` flow is gone. — `parts/Dining.ts`
- Cooking materials are consumed only in `completeCookRun` (closing mid-way costs nothing). Step score =
  raw + `derived.cookScoreBonus` + library `cookScore[game]`, clamped to 1; average → `mealQualityForScore`.
  Cooking-bench recipes are excluded from the generic craft path. — `parts/Cooking.ts`
- Minigames: "what you see is the judgement" — the perfect band equals the csv window, good extends to
  `GYM_GOOD_OF_PERFECT` / `COOK_GOOD_OF_PERFECT` × it, clamped to half a beat. Stirfry / stir / pour end on
  `CookGameBase.maxTime` even with no input. — `parts/GymGames.ts` (`judgeBands`), `parts/CookGames.ts` (`cookJudgeBands`)
- Sessions (gym, cook, video game) cancel on `game:newMission`, `game:abort`, `hub:left`, phase change and on the
  player's furniture pose ending for another reason. Gym / cook are own ship only (not shared ship / visit).
- Video games use gym rules (`applyGymSession`, per-stat fatigue). A TV needs a console; a seat is **optional**
  (2026-09-17): a valid seat (same room, in front, facing the TV — yaw = TV yaw + 2, corridor free except `low`
  furniture) is sat on, otherwise the session runs standing (`seatUid` null, no pose). `gameBlock` never returns a
  seat reason; `tvSeatBlock` is diagnostic only. The TV's E opens the TV screen, not a power toggle. — `Rules.ts` (`tvSeatFor`), `parts/VideoGame.ts`
- 의자 · 쇼파 (`interaction seat`) are decor furniture (`shared/housing.isUtilityFurniture`) and go in any room.

### Library
- Effects are per **series** (`data/library_series.csv`); share = full set 100 %, else distinct volumes ×
  `SHELF_SERIES_VOLUME_SHARE`. The same def may be shelved only once across all shelves (`이미 꽂혀 있는 …`).
  — `Rules.ts` (`computeLibraryEffects`), `parts/Library.ts` (`isShelvedAnywhere`)
- `getLibraryEffects()` is the single source; consumers (progression, gym, cooking, meta, inventory) read it — UI
  must not recompute. `housing:libraryChanged` fires when the summary signature, shelved kinds or owned shelves
  change. `getSkillGainMul(skill)` = `1 + skillGain[skill]`. — `parts/Library.ts` (`ensureLibrary`)
- Old item ids are resolved with `resolveItemAlias` on load; duplicates beyond the first are refunded.
- Shelf tiers / columns (`SHELF_TIERS`, `SHELF_TIER_COLS`) are display only; the save stores just `slot`.

### Music
- No sound is produced. The last toggled record player wins; the playlist is every record rack's records (placement
  order → slot, unique defs). `musicStop` is the furniture E toggle itself (`toggleFurniture`). Ship only; music
  state is not persisted. `parts/Library.ts` is read only through its public queries. — `parts/Music.ts`

### Mining
- Each cluster is one clock; `tickMining` banks completed cycles into `cryptoWallet` (skipped during raids).
  Changing the mounted processors folds progress; changing coin resets progress. A cluster needs a main computer.
- **Processors are mounted directly** (2026-09-16 — the 연산 코어 item is gone). A cluster holds a **list of cells**
  (`ComputeClusterSlot.processors`, `null` = empty) whose **index is the UI grid cell**, so one worn processor can be
  pulled out on its own and repaired at the ship workbench; it carries its durability both ways
  (`loot.createItem(…, { durability })`). Speed is not the count but the **sum of `processorPerf`** — linear from
  `PROCESSOR_PERF_MIN` at durability 0 to 1 at full, so **a fully worn processor is worth half a fresh one**. Every
  completed cycle wears every mounted processor by `PROCESSOR_WEAR_PER_CYCLE`; a catch-up of several cycles is billed
  at the segment's starting perf (the wear itself is exact). A cluster with processors cannot be recovered.
  — `MiningRules.ts` (`clusterPerf`, `clusterCycleMs`, `wearProcessors`), `parts/Mining.ts` (`settle`)
- Coin unlock = `ctx.meta.getQuestState(def.unlockQuest) === 'complete'`. Trading is a `credits:tx` reason
  validated by the relay against the quote window; the exchange screen keeps a price subscription open until each
  trade resolves. — `parts/Mining.ts`, `ui/mining/ComputerPages.ts`

### Persistence (`ShipState`)
- Key `slotKey(SHIP_STORAGE_KEY)`; version `SHIP_STATE_VERSION_CURRENT` (≥ the contract's `SHIP_STATE_VERSION`).
  Every load goes through `sanitize`, which carries all migrations (retired furniture refund, removed rooms /
  purposes, generator-gated facilities removed + refunded, access-face violations evicted to storage with slot
  contents refunded, cockpit furniture / decor, library alias + dedupe). **A new state field must be copied in
  `sanitize`**, or the first save drops it. — `ShipState.ts` (`sanitize`)
- Refunds computed during load are paid on the first `update` frame where `ctx.inventory` exists (housing is
  registered before inventory). — `HousingSystem.ts` (`flushRetiredRefund`)
- `ShipStore` debounces writes, flushes on `pagehide`, and uploads the whole state as the `ship` profile document
  (offline too — `ProfileSync` queues it). On `net:profileLoaded` the server copy replaces local state **unless** a
  local edit is still inside the debounce (`editPending` + `isDirty`) — then the edit is flushed and kept.
  — `HousingSystem.ts` (`onProfileLoaded`)
- `housing:loaded` is emitted inside `init`, so systems registered later never see the boot emit — read
  `ctx.housing.state` in your own `init`; the re-emit after `net:profileLoaded` reaches everyone and hub must rebuild
  the personal ship on it.

### UI conventions
- Panels close with E (the key that opened them) and Tab; Tab is taken only when `ctx.escape.topKey` is the
  panel's own token (a screen opened later owns Tab). Inner overlays (`PanelOverlay`) close first. — `ui/Panel.ts`
- `ui:housingToggled` only knows `room` / `facility` / `presets`; newer pages report `page: null` and have their own
  toggle events. — `ui/Panel.ts` (`wirePage`)
- Hold buttons put the left-click hold keycap inside the button (`createHoldButtonCap`); note lines under them are
  refusal-only (hidden when empty).
- Station inventory is one `TradeGrids` card (stash left, bag right). — `ui/StationShell.ts` (`mountStationGrids`)

## Known limits
- The whole `ship` document is uploaded on every save (no delta).
- A client with a wrong system clock (offline) can start timers "in the future"; progress bars clamp.
- A catch-up that completes several mining cycles at once uses the perf the cluster had when the segment opened, so a
  long offline stretch is slightly faster than ticking it live (the wear is exact either way).
- The 분석 도감 shows chances **for a common sample** (the widest pool); with the rarity floor the real chance depends
  on the sample you insert. Its `timeMul` line still shows only the analysis-level multiplier, not
  `derived.researchTimeMul` nor the dex / sample-level speed-up (those are on the 해석 tab).
- **Library books belong to the ship, not the character**; the dex records only what is shelved, and there is no bookshelf
  upgrade path.
- A ripe crop is shown by the station's glow and the screen's badge only (`housing:growChanged`) — no toast, no messenger
  notice.
- **Furniture comes from crafting only** — shop-bought and looted furniture were left out (2026-09-11 user decision, old
  A-4).
- **Removing a facility refunds 100 % of the current price list**, so a rebalance changes what an already-built facility
  gives back and moving a facility is effectively free (intended — there is no other way to move one).
- **The grow station's tier lock is dead but kept.** Every tier is open from Lv.1 (2026-09-13), so `GrowSlotInfo.locked` is
  false for every tier and the screen's locked branch (`ui/GrowStation.build`, `.gs-tier.is-locked`) never draws in play. The
  contract still reports `locked` / `unlockLevel` and `Rules.growTierUnlockLevel` still derives the level, so refilling
  `growTiersForLevel` revives the gate with no screen change — intended, do not delete either side.
- **`ComputeClusterInfo.power` is always 0 and nothing reads it.** Power allocation was dropped on 2026-09-13, but the field
  is **required** in the contract (`shared/housing.ts`), so `parts/Mining.infoOf` keeps writing 0. Retiring it is a contract
  change, not a housing one.
- **Processor wear is per processor** (down to half), but cluster speed is exponential in the count, so letting all nine
  slots wear out is ≈22.6× slower than new (user-confirmed figure). The 3D furniture's LED cells
  (`hub/interiors/FurnitureMining.ts`) show the **count** only, so a worn slot looks like a new one. A neighbouring save's
  `clusters[].cores` are not mounted — they are refunded to the stash as **full-durability** processors.

## Recent changes

Last 5 only — older: `git log -- src/housing`.
- 2026-09-19 — Audit B-32…B-35: 18 stale comments corrected, 8 dead-code spots cleared (`SHELF_COLS` · `analysisEstimateMs` removed, preset stubs, `rowRank`, cook-result `landed`, gym `ruleText`) and 6 behaviour fixes — stirfry score divides by **beats offered** (one perfect click no longer scores 1.0), a late grill flip emits `beat('flip','miss')`, `Deliver.blockedCell` is saved/restored by `withDropCell`, both shelf recover pre-checks bill an unknown def at `UNKNOWN_SHELF_ITEM_CELLS`, the TV console refusal is `TV_CONSOLE_BLOCK_REASON`, `placeCockpitDecor` sets `changed` after the branch ran. A game disc's minigame is named by `gameMinigameLabel` everywhere (the library catalogue printed a third variant).
- 2026-09-19 — Code comments translated to English (project-wide rule change, CLAUDE.md §4.1); Korean on-screen labels and decision headings kept verbatim in backticks / 「」, no string literal touched. One quoted-label-only line stays Korean (`ui/SocketFlow.ts:100`).
- 2026-09-17 — Gym / game result card: `+N` without `단련` (`근력 +1!`, trained block `+N`), XP line `<능력치> 경험치 +n`, progress tail `다음 +1까지 x / y` against the stat-XP bar (`statXpToNext`) — 단련 now fills the stat-XP bar (progression).
- 2026-09-17 — 배양 시작 확인: `insertStrain` no longer starts the timer — a 시작 대기 slot (`strainDefId`, no `startedAt`) starts only through `startCulture` (UI: `배양 시작` button under each tube → `openHoldAsk` 「배양을 시작하겠습니까?」, 1 s hold); before that `takeStrain` / `takeScaffold` / `takeMedium` (unused medium only) give items back. `CultureSlotInfo.started` / `mediumReturnable`; saves need no migration (old strains always carry `startedAt`). 배양조 · 재배 스테이션 are `multi` (build several); the culture screen got the left tank rail; both rails widened to 200 px so `재배 스테이션 n` fits; cell bob 14 s / ±1.5 px.
- 2026-09-17 — Mount slots take the accepted item's shape: the 연산 클러스터 (processor 2×1, footprint read at paint — the constructor ran before `ctx.loot`) and every 보관함 (`shelfFootprint`) draw empty slots as that footprint's grid cells; dragging a mounted item out highlights the target **cell** footprint (`previewExternalAt`) instead of the whole grid. Mining tabs moved to the Tab screen's `.scr-tabs` position; the 채굴 tab opened from the main computer picks the first cluster (was `연산 클러스터가 없습니다`); an empty cluster shows no guidance banner.
