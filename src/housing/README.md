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
| `model.ts` | Folder vocabulary (no state): `FACILITY_IDS`, `BOOKS_BLOCK_REASON` / `SHELF_BLOCK_REASON`, shelf labels / glyphs (`SHELF_GLYPH`, `LIBRARY_GLYPH`), `ACTIVE_FURNITURE_DEFS` (= defs minus `retired`), retired-rack answers. |
| `Rules.ts` | Pure rules, no ctx / DOM — see **Rules** below. |
| `MiningRules.ts` | Pure mining rules: `takeCompletedCycles`, `foldProgress`, `sanitizeClusters`, `sanitizeUnitsMap`, `CLUSTER_CORES_BLOCK_REASON`, `MINING_TICK_MS`. Cycle formulas live in `shared/cryptoMarket`. |
| `ShipState.ts` | `freshState`, `sanitize(raw, out?)` (all migrations + validation), `loadState`, `writeState`, `ShipStore` (debounced write + `pagehide` flush + profile upload), `ensureCockpitFurniture`, `placeCockpitDecor`, `is*DefId` helpers, `SHIP_STATE_VERSION_CURRENT`. |
| `index.ts` | Barrel: `HousingSystem`, `Rules`, state helpers. |
| `housing.css` | Shared panel styles (`.hs-*` shell / cards / modal / tip / context menu / rail / tabs, `.gs-*` grow, `.az-*` analyzer, `.cult-*` culture, `.dt-*` dining, `.lib-*` library, `.facility-chip` icon + `[data-fc-tip]` tooltip). Does **not** redeclare the `--inv-*` palette (owner: `inventory/inventory.css`). |
| `parts/Rooms.ts` | Room purposes (build = consume `purposeCost`, remove = full refund), facility info / upgrade (generator, storage), `getBenchLevel`, `getSkillGainMul`, stash size, `consume` / `canAfford`. |
| `parts/Furniture.ts` | Place / move / recover / craft / upgrade furniture, housing mode + ship-manage mode (`openShipManage` remembers the last room in `slotKey('scav.housing.manageRoom')`), `furnitureCraftBlock` / `furnitureUpgradeBlock` / `furnitureUpgradeCost`. |
| `parts/Garden.ts` | Grow station: `fillSoil` → `plantSeedAt` → `harvestAt`, soil durability + sockets, `rescaleGrowsForUpgrade`, `insertGrowSocket`; retired grow-rack API answers "no rack". |
| `parts/Lab.ts` | Analyzer: `startAnalysis` (rolls the result on insert), `cancelAnalysis`, `collectAnalysis` (analysis XP → level-ups, found-dex, research XP), `getAnalysisLevel/Results/Found`, `researchTimeMul`, `devAdvanceAnalysis`. |
| `parts/Culture.ts` | Culture tank: medium → scaffold → strain, medium durability + sockets, harvest, `insertScaffold` / `takeScaffold` / `insertCultureSocket`. |
| `parts/Sockets.ts` | Soil / medium sockets shared by Garden and Culture: `socketSum`, `yieldBonus`, `insertSocket` (replace destroys the old socket), `getOwnedSockets`. |
| `parts/Deliver.ts` | `deliverItem(sys, item, dest)` — the single path a station product takes to the player (`HarvestDestination`: `bag-first` · `stash-first` · `bag` · `stash`; named grids never overflow). |
| `parts/Dining.ts` | Dining table (furniture uid, or `null` = shared-ship fixed table): `getMealStacks`, `eatMeal`, `serveMealToSquad`, `diningBlock`. |
| `parts/Cooking.ts` | Cooking session: `cookRecipes` (all cook-bench recipes with steps, unfiltered), `cookBlock`, `startCook` / `restartCook` / `cancelCook`, `recordCookStep` (+ skill / library score bonus), `completeCookRun` (quality → `inventory.completeCook`), `getCookAuto`, `bindCooking`, `cookDebug`. |
| `parts/CookGames.ts` | DOM-free judges of the six cooking minigames (`ChopGame`, `MinceGame`, `GrillGame`, `StirfryGame`, `StirGame`, `PourGame`), `createCookGame`, `cookJudgeBands`. |
| `parts/Gym.ts` | Gym session: `gymBlock`, `startGymSession`, `completeGymSession` (→ `progression.applyGymSession`, + library `gymScore`), `bindGym`, `gymDebug`. |
| `parts/GymGames.ts` | DOM-free judges `PressGame` / `BreathGame` / `CycleGame`, `createGymGame(kind, tuning?)`, `judgeBands`, `completion`. |
| `parts/VideoGame.ts` | TV consoles (`attachTvConsole` / `detachTvConsole`), seat check (`Rules.tvSeatFor`), `getPlayableGames`, game sessions (gym rules via `applyGymSession`), `bindVideoGame`, `videoGameDebug`. |
| `parts/Library.ts` | Library shelves for every medium (`book` · `disc` · `record` · `game`): place / take / dex / recover-to-stash, on/off toggles, library-effects cache (`ensureLibrary`, `bindLibrary`, `tickLibrary`) and its queries. |
| `parts/Music.ts` | Music player state (no audio): playlist from record racks, `tickMusic`, `musicNext/Prev`, `setMusicMode`, `musicStop`, `housing:musicChanged`. |
| `parts/Mining.ts` | Compute clusters, wallet, trading: `setClusterCoin`, `insertClusterCores` / `removeClusterCores`, `tickMining` (1 Hz, not in raid), `tradeCrypto`, `coinLockReason`, dev cheats. |
| `parts/Presets.ts` | Retired loadout presets (all answer "no slots"), `panels()` registry, `closeMenus`, legacy `openRoomMenu` / `openFacilityMenu` → `openShipManage`. |
| `ui/Panel.ts` | `HousingPanel` base: `.menu.housing-menu`, blocker `'housing'` + cursor mode, `ctx.escape` entry, E / Tab close, `PanelOverlay` stack, `coalesceRefresh`, `ui:housingToggled`, key-guide owner `housing.<page>`. |
| `ui/StationShell.ts` | Common station layout: station card (title, `Lv.`, meta, upgrade button, `rail`, optional `tabsRow`) + one inventory card; `mountStationGrids` mounts one `TradeGrids` (`stash` + `bag`); `stationGridCell`. |
| `ui/UpgradeModal.ts` | Furniture upgrade modal (`PanelOverlay`): cost chips + facility chips, 1 s hold confirm (Enter swallowed), escape token `housing.upgrade`. |
| `ui/StationTip.ts` | Non-item hover card (`TipSpec`) with `.item-tip` looks. |
| `ui/StationMenu.ts` | Right-click menu (`PanelOverlay`), swallows its own Escape. |
| `ui/ProductDrag.ts` | Treat a finished product like an item: drag to a grid (`bag` / `stash`) or double-click (`stash-first`). |
| `ui/SocketFlow.ts` | Socket effect text / tip rows / dots, `SocketAsk` (pick + 1 s hold replace confirm, destructive clear confirm). |
| `ui/dom.ts` | `el`, `section`, `setText`, `renderCost` (→ shared `renderItemCost`), clock helpers (`renderClock`), `formatRemaining`, `facilityChipTip`. |
| `ui/GrowStation.ts` | Grow station screen: rail of stations (9-dot status), tiers of soil pots, drop soil / seed / socket, harvest via `ProductDrag`, right-click clear. `ui:growToggled`. |
| `ui/Analyzer.ts` | Analyzer screen: rail tabs `해석` / `분석 도감`, slots with family chip + result chip, collect / cancel. |
| `ui/SampleDex.ts` | Analysis dex per family (level, XP bar, result rows: found / silhouette / locked). |
| `ui/CultureTank.ts` | Culture tank screen: tubes (fluid = medium durability), drop medium / scaffold / strain / socket, harvest. |
| `ui/DiningTable.ts` | Dining screen: plate (drop target) + meal list (`먹기`, shared ship `분대에 차리기`); exports meal text helpers (`mealEffectText`, `mealBuffText`, `mealTierText`). |
| `ui/BookshelfMenu.ts` | Library screen for every shelf medium: rail = `서재` summary + placed shelf furniture, tabs `선반` / `도감`, drag to place / swap / take. `ui:bookshelfToggled` / `ui:shelfToggled`. |
| `ui/ShelfDrawing.ts` | Drawn shelf (`.lib-case` › `.lib-tier` › `.lib-row` › `.lib-slot`), layout from `SHELF_TIERS` / `SHELF_TIER_COLS`; `.is-div` divider; `paintShelfSlot`. |
| `ui/BookDex.ts` | Library dex rows (series / game discs), exports `libraryEffectText`, `gameDiscText`, `volumeRoman`, `seriesTint`, `statName`. |
| `ui/ShipView.ts` | `createShipView(host)` — the embedded ship tab of the inventory window (generator / storage rows, room list, build / remove popups, `시설 관리` button). No blocker, no pointer lock, no Escape listener. |
| `ui/FacilityRows.ts` | Facility rows + effect summary used by `ShipView`. |
| `ui/cook/CookStation.ts` | Cooking-bench screen (page `cook`): recipe thumbnail grid (`COOK_LIST_COLS`) + detail (effects, ingredients, steps, auto appliance, lock badges), `조리 시작`. `ui:cookStationToggled`. |
| `ui/cook/CookScreen.ts` | Bottom-center cooking overlay: choose (manual / auto) → game → step score → result. Blocker / escape / key-guide `housing.cook`; input on the whole panel while playing. |
| `ui/cook/CookViews.ts` | Six cooking game stages (CSS shapes + item chips, no assets). |
| `ui/cook/cook.css` | `.cook-*`. |
| `ui/gym/GymScreen.ts` | Gym / video-game overlay: intro → game → result, keyboard input via `Keys.JUMP` / `LEFT` / `RIGHT`, rAF loop + fallback interval. Token `housing.gym`. |
| `ui/gym/GymViews.ts` | Gym game stages (press bar, breath / cycle lanes). |
| `ui/gym/gym.css` | `.gym-*`. |
| `ui/tv/TvMenu.ts` | TV screen (page `tv`): power, console attach / swap, seat line, playable games. `ui:tvMenuToggled`. |
| `ui/tv/tv.css` | `.tvm-*`. |
| `ui/mining/MiningScreen.ts` | One mining window (page `cluster`) with top tabs `MINING_TABS` (`채굴` · `클러스터 현황` · `지갑` · `거래소`); rail + grids only on the mining tab. `ui:miningToggled` page = `cluster` for the mining tab, `computer` otherwise. |
| `ui/mining/ClusterPage.ts` | Mining tab: core slots (one core per drop / take), cycle bar, coin picker, stats. |
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
  `facilityRefund`, `removeRoomFacility`, `getBenchLevel`, `getCraftCostMul` (always 1), `getSkillGainMul`.
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
  `getOwnedSamples`, `getAnalysisLevel`, `getAnalysisResults`, `getAnalysisFound`, `openAnalyzer`,
  `devAdvanceAnalysis`. Deprecated: `getSampleDex`, `getSampleDexRatio`.
- **Culture tank**: `getCultureSlots`, `fillMedium`, `clearMedium`, `insertStrain`, `insertScaffold`,
  `takeScaffold`, `insertCultureSocket`, `harvestCulture`, `harvestAllCultures`, `getOwnedMediums` /
  `getOwnedStrains` / `getOwnedSockets`, `openCultureTank`.
- **Dining / cooking**: `getMealStacks`, `eatMeal`, `serveMealToSquad`, `diningBlock`, `openDiningTable(uid | null)`;
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
  `getComputeCluster`, `setClusterCoin`, `insertClusterCores`, `removeClusterCores`, `cryptoQuote`, `tradeCrypto`,
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
`housing:libraryChanged`, `housing:mealServed`, `housing:cookSession` / `cookStep` / `cookBeat` / `cookResult`,
`housing:gymSession` / `gymBeat` / `gymResult`, `housing:gameSession` / `gameBeat` / `gameResult`,
`housing:tvConsoleChanged`, `housing:musicChanged`, `housing:clusterChanged`, `housing:cryptoMined`,
`housing:walletChanged`; UI: `ui:housingToggled`, `ui:growToggled`, `ui:bookshelfToggled`, `ui:shelfToggled`,
`ui:cookStationToggled`, `ui:miningToggled`, `ui:tvMenuToggled`, `ui:keyGuide`, `ui:notify`; plus `audio:play`,
`gather:collected` (harvest).

**Events consumed**: `game:newMission`, `game:abort`, `hub:left`, `game:phaseChanged` (close panels, leave modes,
cancel sessions, stop music), `hub:entered`, `net:profileLoaded`, `inventory:changed` / `inventory:stashChanged`,
`input:bindingsChanged`, `player:furniturePoseEnded` (cancel gym / cook / game session),
`progress:trainedChanged` / `progress:gymFatigue`, `meta:creditsChanged`, `net:cryptoPrices` / `net:cryptoHistory`.

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
- Analysis result is rolled **on insert** from `data/analysis_results.csv` by family and analysis level; time =
  `analysisDurationMs × derived.researchTimeMul`. Cancel never returns the sample. Collect is all-or-nothing through
  `deliverItem`. — `parts/Lab.ts` (`startAnalysis`, `collectAnalysis`)
- Culture output ignores `gatherYieldMul`; a scaffold switches output to `scaffoldOutputDefId` and is consumed on
  harvest. Retired strains are refused.
- Products reach the player only through `parts/Deliver.deliverItem`; a named grid never overflows into the other.

### Kitchen, gym, video games
- Eating / serving: ask `progression.useMeal` / `serveMeal` **first**, consume the item only on success.
  `housing:mealServed` is emitted for net to propagate; housing must **not** subscribe to it (net re-emits it, the
  meal would be consumed twice). — `parts/Dining.ts`
- Cooking materials are consumed only in `completeCookRun` (closing mid-way costs nothing). Step score =
  raw + `derived.cookScoreBonus` + library `cookScore[game]`, clamped to 1; average → `mealQualityForScore`.
  Cooking-bench recipes are excluded from the generic craft path. — `parts/Cooking.ts`
- Minigames: "what you see is the judgement" — the perfect band equals the csv window, good extends to
  `GYM_GOOD_OF_PERFECT` / `COOK_GOOD_OF_PERFECT` × it, clamped to half a beat. Stirfry / stir / pour end on
  `CookGameBase.maxTime` even with no input. — `parts/GymGames.ts` (`judgeBands`), `parts/CookGames.ts` (`cookJudgeBands`)
- Sessions (gym, cook, video game) cancel on `game:newMission`, `game:abort`, `hub:left`, phase change and on the
  player's furniture pose ending for another reason. Gym / cook are own ship only (not shared ship / visit).
- Video games use gym rules (`applyGymSession`, per-stat fatigue). A TV needs a console and a valid seat:
  same room, in front, facing the TV (yaw = TV yaw + 2), corridor free except `low` furniture. The TV's E opens the
  TV screen, not a power toggle. — `Rules.ts` (`tvSeatFor`)

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
  Changing cores folds progress; changing coin resets progress. A cluster needs a main computer.
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
- The analysis dex's time multiplier (`ui/SampleDex`) shows only the analysis-level `timeMul`; it does not include
  `derived.researchTimeMul`.
- The whole `ship` document is uploaded on every save (no delta).
- A client with a wrong system clock (offline) can start timers "in the future"; progress bars clamp.
- Mining cores are saved as a count, so filled core slots are always the first n.

## Recent changes
Last 5 only — older: `git log -- src/housing`.
- 2026-09-15 — Station inventory is a single card; cooking bench is a recipe thumbnail grid + detail pane.
- 2026-09-15 — Library: no slot numbers, per-shelf effect cards, shelf divider; facility chips icon-only with tooltip;
  ship manage remembers last room; Tab only for the top screen; `devAdvanceAnalysis`.
- 2026-09-15 — Left-click hold keycaps inside hold buttons; minigame / ship keycaps via `shared/keycap`.
- 2026-09-15 — Cooking bench shows skill-locked recipes dimmed with a skill badge (B-15).
- 2026-09-14 — Mining screen unified (four tabs), library screen rail/tabs rework, music player state, minigame
  judgement bands = csv windows, `NEEDS_GREENHOUSE` emptied.
