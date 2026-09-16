# inventory/ — grid inventory, loadout, stash, containers and crafting UI

`InventorySystem` (`name: 'inventory'`) owns the Diablo-2-style bag grid, equipment slots, quick-use wheel, pouch
grid, ship stash (`함선 창고`), the open loot container (crates, corpses, supply) and the Tab window (inventory /
character / corp / ship tabs, craft column, catalog). It publishes `ctx.inventory` (itself, `InventoryRef`) and
`ctx.loot` (`LootService` from `@/items`). Item defs, recipes, repair / salvage tables and loot rolls belong to
`items/`; world pickups to `pickups/`; implant rules to `progression/` / `implants/`. Other folders reach the
inventory only through `InventoryRef` (`src/shared/types.ts`) and bus events.

## Files

| File | Responsibility |
|---|---|
| `InventorySystem.ts` | `GameSystem` + `InventoryRef`: event wiring, Tab / R / X, open / close, auto-close, mutations, one-line delegates into `parts/`; re-exports `model.ts` |
| `model.ts` | Folder vocabulary, no state: `GridId`, `ItemLocation`, `DropTarget`, `OpResult`, `LOADOUT_SLOTS`, `slotAccepts`, pouch predicates, `FILTER_GROUPS`, `BAG_FRAME_ROWS`, UI constants (`AUTO_CLOSE_DISTANCE`, `CRAFT_HOLD_TIME`, `TAKE_REQUEST_TIMEOUT` …) |
| `Grid.ts` | Pure occupancy grid (place / move / rotate / autoPlace / merge, `resize`, `snapshot` / `restore`, `version`); module stack-key rule (`setStackKeyRule`, `stackKeyOf`) |
| `Container.ts` | `Container` (grid, tier, title, roll `order`, `taken`, search state) and `ContainerStore` (per-mission cache, pending takes, take `seq`, `applySync`, `raidMark`) |
| `Sockets.ts` | Pure socket bookkeeping on `ItemInstance.sockets` (compatibility is `LootRef.canAttach`) |
| `QuickSlots.ts` | Pure wheel bookkeeping on `QuickSlotItems` (stacks): free slot in unlock order, `mergeIntoQuick`, starter picks, signature |
| `QuickSwap.ts` | Where a stack displaced by a 1:1 wheel swap goes (`canQuickSwap` / `applyQuickSwap`) |
| `Gear.ts` | Weight / carry capacity (`bagCapacityBonus`), durability info, `searchTimeFor`, `gearMultipliers` |
| `Serialize.ts` | `SavedExtras` / `SavedPlacement`, `serializeExtras`, `reviveItem` (alias resolve, unknown def → null), `detachForbiddenSockets`, slot-keyed storage helpers |
| `Stash.ts` | Stash grid + `scav.stash` save (with size), `resize` (shrink refused while items would fall out), `loadFrom(doc)`, starter-grant flag `scav.grant` |
| `Loadout.ts` | `LoadoutSave` v3 (slots, bag, quick stacks, pouch, optional `fav`), `sanitizeLoadoutSave` (migrates v1/v2), `LoadoutStore` (debounce, `saveNow`, solo raid marker) |
| `__selftest__.ts` | `runInventorySelfTest()` console-assert checks |
| `index.ts` | Barrel (`@/inventory`) |
| `inventory.css` | `.inv-*` / `.tg-*` / `.crew-loadout` styles (`.item-chip*` is `src/ui/styles/base.css`) |
| `parts/Lifecycle.ts` | Save restore, starter grant / kit, mission reset (`Reset policy`) |
| `parts/DropResolver.ts` | Drop rules: `previewDrop` / `drop`, partial drags, `quickMove`, `activate` (auto-place), swaps, `changeBag`, attach, `takeAll`, `canSocketAt` |
| `parts/StashOps.ts` | Bag + stash as one store: `countDefAll` / `consumeDefAll`, presets, `moveToStash`, `moveBagToStash` (bag grid → stash, largest first), `tryAddToStash` / `tryAddItemAnywhere`, `canFit`, `usePrepItem` |
| `parts/Crafting.ts` | Station, bench open / switch, recipe lists, costs, craft job, outputs, salvage resolve, repair rows, research refund, `cookBlock` / `consumeCookInputs` |
| `parts/Durability.ts` | Wear, `repairMaterials`, `repair` / `repairWeapon` / `repairInfo`, spray refill, bag wear per raid, attach / detach all, unload |
| `parts/ContainerNet.ts` | Host-authoritative container takes, `container:itemTaken` emitter |
| `parts/ProfileDocs.ts` | Server profile documents, merged save flush (`setMany`), `withFreshSave`, raid session state |
| `parts/CorpseLoot.ts` | `stripForCorpse`, corpse grid sizing (`fitCorpseGrid`), `pcorpse` pre-creation |
| `parts/Pouch.ts` | Pouch grid: size, accepts, signature event, `changePouch` |
| `parts/Sort.ts` | `sortGrid` / `compareForSort` (favourite → category → rarity → size → name → quality) |
| `parts/Favorites.ts` | Favourite def ids, persisted in loadout `fav` |
| `parts/RaidFound.ts` | Installs the raid-found stack rule and crate mark; strips marks at raid end |
| `parts/MealQuality.ts` | Quality-aware meal stack queries |
| `parts/AutoQuick.ts` | Auto-seat picked-up consumables on a free wheel slot |
| `parts/SocketDetach.ts` | Drag one attachment out of a pinned weapon tooltip |
| `parts/SocketRules.ts` | `returnForbiddenAttachments` at load |
| `parts/ShelfWanted.ts` | "Not yet shelved" ribbon source (`HousingRef.isShelfItemWanted`) |
| `parts/Peek.ts` | `peekContainerItems` / `peekSuppliedItems` |
| `parts/Allies.ts` | Android hooks: `createAllyBag`, `weightInfoFor`, `takeContainerItemFor`, item-request / container-viewed events, `inventory:allyDeposit` → stash |
| `parts/Catalog.ts` | Dev infinite-crate catalog (`/items`) |
| `parts/LaunchCheck.ts` | `getLaunchWarnings()` (drawn by `hub/ui/LaunchWarnPanel`) |
| `ui/InventoryUI.ts` | Window DOM, panels, drag wiring, pouch block, flashes, hover validation, resize cell sync |
| `ui/model.ts` | UI vocabulary: `DragState`, `SCREEN_TABS`, thresholds |
| `ui/labels.ts` | Cell size source (`CELL`, `STEP`, `gridCellForHeight`, `applyGridCellVar`), `TEXT`, formatters, `weaponClassLabel`, `capacityLabel` (the one `사용칸 / 전체칸` string) |
| `ui/GridView.ts` | Renders one `Grid` (signature-diffed tiles, highlight, frame rows, clip, hidden mask, scan gauge, vanish); `buildTileContent`, `buildSlotCardContent`; display copies of favourites / needed ammo / recovery scope / shelf-wanted |
| `ui/GridTools.ts` | `buildFilterSelect` (`FILTER_GROUPS` on `shared/dropdown.buildDropdown`), `buildSortButton` |
| `ui/parts/Drag.ts` | Pointer state machine; held remainder after partial merges |
| `ui/parts/ContextMenu.ts` | Which right-click entries each item gets |
| `ui/parts/Screens.ts` | Screen tabs (기업 hidden and refused until any corp reaches `CORP_ACCESS_REP_LEVEL` — `corpTabLocked`, re-checked live by `onCorpAccessChanged`), embedded views, craft column, catalog layout, key guide |
| `ui/parts/SlotPanel.ts` | Equipment slot cards |
| `ui/parts/QuickPanel.ts` | Wheel rose |
| `ui/ContextMenu.ts` | Menu widget (mouse-glyph hints) |
| `ui/SplitDialog.ts` | `수량 지정` modal |
| `ui/CatalogView.ts` | Catalog panel: tabs, search (`.inv-cat-search`, focused on open), tiles |
| `ui/CraftPanel.ts` | Craft panel `.inv-panel-craft` (bench list, 5-column thumbnail grid `CRAFT_LIST_COLS`, cell hover → item tooltip via `CraftHoverHandlers`) + the sibling detail card `detailEl` (`.inv-panel-craft-detail`, tooltip-style header, `CraftDetail`, stepper, hold button) |
| `ui/RepairPanel.ts` | `모두 수리` modal |
| `ui/DisassemblePanel.ts` | `분해` dialog: durability-aware preview, room check, favourite confirm, progress events |
| `ui/Modeless.ts` | Modeless popup frame (no blocker, no cursor owner) |
| `ui/ImplantPanel.ts` | Implant block: tactical implant picker + implant items |
| `ui/CrewLoadoutView.ts` | Read-only squad member loadout view |
| `ui/TradeGrids.ts` | Real bag / stash grids for other folders' screens (move · rotate · merge through `DropResolver`; caller tray first) |
| `ui/TipPin.ts` | Hold-to-pin tooltip, socket hover / drag-out |
| `ui/Tooltip.ts` | Instance tooltip card (weapon gauges, sockets, durability bar, `items/itemSpecRows`, implant / book / meal lines, weight · value bar) |

## Public API

### `ctx.inventory` (`InventoryRef`, `src/shared/types.ts`)

- Window: `isOpen`, `toggleBag`, `closeAll`, `openContainer`, `openContainerItems`, `openContainerItemsSized`,
  `openScreen(tab)` / `screenTab`, `openCatalog` / `closeCatalog`, `openBenchCraft(kind, level)`.
- Queries: `getLoadout`, `getEquipped`, `getBagSize`, `getWeight`, `getTotalValue`, `getAllItems` (**bag grid
  only**), `countWhere` / `consumeWhere` / `consumeDef` (bag + pouch + wheel), `countDefAll` / `consumeDefAll`
  (+ stash), `findItem`, `findItemAnywhere`, `getStashItems`, `getStashSize` / `setStashSize`, `canFit` →
  `'bag' | 'stash' | null`, `getQuickSlots`, `getEquippedPouch`, `getDurability`, `getLaunchWarnings`,
  `soloRaidSeed`, `isFavorite`, `getMealStacks`, `countDefQualityAll`, `peekContainerItems` (drone scan).
- Mutations: `tryAddItem` (the gate for items entering from outside — pickups, gathering, supply ammo, gadget
  recovery), `tryAddToStash`, `tryAddItemAnywhere` (bag → stash, no `inventory:full`), `takeItem(uid, qty?)` (hands
  the item **out** of the inventory; moving is `quickMove`), `dropItem`, `splitItem`, `updateItem`, `equip`,
  `setQuickSlot`, `consumeItem`, `attachToWeapon`, `detachAllSockets`, `unloadWeapon`, `repair` / `repairWeapon`,
  `damageDurability`, `captureLoadout` / `applyLoadout`, `toggleFavorite`, `consumeDefQualityAll`, `cookBlock` /
  `consumeCookInputs` (housing cook station — no output), `reset`, `flushSaves`; crafting `getRecipes`, `canCraft`, `craft`.
- Raid / death: `captureRaidState` / `applyRaidState` (opaque to `game/`), `stripForCorpse`, `captureCrewLoadout`.
- Views (`EmbeddedView`: no blocker, pointer lock or key listener): `createTradeGrids`, `createCrewLoadoutView`,
  `buildItemTile(defId, qty, opts)`.

Folder-internal (not contract): `previewDrop` / `drop`, `quickMove`, `activate`, `moveBagToStash`, `switchBench`, `craftCountDef`,
`maxCraftCount`, `craftHasRoom`, `benchRepairRows`, `disassembleRecipeFor`, `detachSocket`, `readOnlyReason`.

### TradeGrids (`createTradeGrids`)

Used by `meta/ui/CorpView` and `housing/ui/StationShell`. Real stash / bag grids. A tile dropped on the caller's
`dropSelector` (or double-clicked) calls `onTake(item, gridId, target)` and the caller mutates through `InventoryRef`;
the tray is tested **before** the grids, so a caller's drop zone always wins. 2026-09-16: a tile released on a **cell**
instead is a real move — same cell, the other grid, `R` to rotate mid-drag, merge onto a matching stack — judged and
executed by `parts/DropResolver` (`previewDrop` / `drop`), exactly as in the Tab window, including the merge remainder
left on the cursor (`DragInfo.held`). The view still owns no blocker, no pointer lock and no standing key listener (the
rotate key is bound only while a drag is in flight); it has no equipment / wheel / container targets and no world drop,
so a release over nothing leaves the item where it was. 2026-09-16 (2nd): `placeExternalAt(item, x, y)` puts an item that is in **no grid yet** (a shelf's book, a cluster's core,
a station's product — `housing/ui/ProductDrag`) into the cell under the cursor, resolved by the same two-pass hit test as a
tile drag: free cell → placed, matching stack with room for all of it → merged, anything else → `'blocked'` (nothing is
displaced; the caller refuses), not over a cell → `null` (the caller falls back to its own rule). 2026-09-17:
`previewExternalAt(defId, qty, x, y)` paints the same judgement as the tile-drag footprint highlight (`ok` / `merge` / `bad`,
nothing changes) and `clearExternalPreview()` hides it — furniture drags light the **cell** under the cursor, not the block. Options
(`TradeGridsViewOptions`): `grids` (default `['stash', 'bag']`), `layout` (`'wrap'`
and `'split'` render the same side-by-side panel), `chips` (`'block'` own dropdown per block, `'shared'`, `'none'` +
`mountFilterChips(host)`), `cell`, `isStaged`, `takeLabel`, `className`. `setCell(px)` rebuilds keeping filter and
scroll (narrow with `typeof view.setCell === 'function'`). Call it **once** for stash + bag to get one card; blocks
scroll in `.tg-gridwrap`, so the host needs a height-constrained flex parent.

### Events and wire

- Emits `inventory:{opened, closed, changed, itemAdded (fromStash), itemRemoved, itemUpdated, itemSplit,
  itemRotated, itemDropped, full, bagChanged, stashChanged, quickSlotsChanged, pouchChanged, socketChanged,
  weightChanged, overloaded, loadoutSaved, containerOpened, favoritesChanged, disassembleProgress}`,
  `loadout:changed`, `equip:changed`, `grenade:countChanged`, `stim:countChanged`, `durability:{changed, broken}`,
  `craft:{started, completed, failed}`, `repair:completed`, `crate:looted`,
  `container:{itemRevealed, searchProgress, searchDone, itemTaken}`, `ui:{craftToggled, catalogToggled,
  disassembleToggled, tipPinned, cursorHold, keyGuide, notify}`, `chat:post` (middle-click request), `audio:play`.
- Consumes `crate:open`, `world:ready`, `game:{newMission, complete, over, abort, phaseChanged}`, `player:died`,
  `player:respawn`, `hub:entered`, `net:profileLoaded`, `net:hostChanged`, `housing:stashSizeChanged`,
  `housing:libraryChanged`, `tutorial:changed`, `implant:equipped`, `progress:*`, `meta:creditsChanged`,
  `meta:repChanged` / `meta:loaded` (기업 tab gate), `input:bindingsChanged`.
- Androids (2026-09-15, `parts/Allies.ts`): `createAllyBag(cols, rows)` → `AllyBagRef` (a DOM-less `Grid` with the
  player's stack rules), `weightInfoFor(carried, bag)` (the player formula with no carry relief, base capacity
  `DEFAULT_CARRY_CAPACITY`), `takeContainerItemFor(containerId, tier, defId, by)` (authority only; `containerId` is
  the inventory container id = `WorldRef.getLootContainers()` id — `crate_<n>` or the structure spec id **without**
  the `container:` prefix). Emits `inventory:itemRequested` (kind `shield` / `ammo` / `heal` / `item`; `defId` is
  the def of the clicked item, `ammoType` the calibre) next to the old chat line, `inventory:containerViewed` from
  `showContainer` (the one door every loot window goes through), and `ally:deposited` for `inventory:allyDeposit`.
  A non-authority client also sends `allyq item` / `allyq viewing` to the host.
- Wire (`src/shared/net.ts`): `cont` (`taken {rem, seq}` / `denied` / `sync`) host → clients; `contq` (`take` /
  `sync`) client → host; `flow rejoined` → `cont sync`; `pcorpse` pre-creates corpse containers;
  `allyq item` / `allyq viewing` client → host.
- Storage (via `slotKey`): `scav.stash`, `scav.loadout`, `scav.grant`; profile documents `stash`, `loadout`.

## Equipment slots

| Slot | Accepts | Notes |
|---|---|---|
| `primary` 주무기 I | category `primary` | key 1 |
| `primary2` 주무기 II | category `primary` | key 2; drag onto the other primary slot swaps |
| `armor` 방탄복 | category `armor` | shield, not damage reduction |
| `bag` 가방 | category `bag` | sets the bag grid size |
| `pouch` 주머니 | pouch items | `POUCH_SLOTS`; opens the pouch grid |

- `slotAccepts(def, slot)` is the single rule. `LOADOUT_SLOTS` order is the narrow DOM order; the wide layout
  (`primary armor / primary2 bag / implant pouch`) is `grid-template-areas` in `inventory.css`. The implant block is
  inserted before `pouch` and hidden while `ctx.tutorial.hides('hud', 'implant')`.
- `secondary` has no slot (`slotAccepts` false); its type names remain because saves and crew cards use them.

**Double-click auto-place** (`DropResolver.activateImpl` → `tryAutoPlace`), same order from every grid:

| Order | Target | Condition |
|---|---|---|
| 1 | empty equipment slot | `slotAccepts` and slot **empty** |
| 2 | empty implant slot | `def.implant && !broken` → `ctx.progression.equipImplant` (ship) |
| 3 | empty wheel slot | `autoQuickIndexFor`; skipped for bag tiles (bag double-click = `registerQuick` with no container open, move into the container otherwise) |
| 4 | fallback | bag: `equipTargetFor` (may **swap** with 주무기 I) → `quickMoveImpl`; others: into the bag, else `inventory:full` |

Auto-place never displaces equipped gear — only drag or the context menu `장착` (`equip`) does. Stash double-clicks
toast (`notifySentTo`); other grids flash the landing slot (`.is-flash`).

**무한 상자** double-click (`Catalog.takeFromCatalog`, 2026-09-17): a fresh instance goes to the **stash first** when the
stash pane shows (`hubMode`, ship), else / then the bag; on a mission the bag only. No equipment auto-place. Container
windows never show the stash (`showContainer` clears `hubMode`), so container double-clicks are unchanged.

## Bag grid

- `getBagSize()` = equipped `def.bag`, else `BAG_DEFAULT_COLS × BAG_DEFAULT_ROWS`. All bags are 5 columns
  (`data/bags.csv`). The frame is `BAG_FRAME_ROWS` (tallest bag); padding rows are not drop targets
  (`GridView.setFrameRows`, off in the craft layout).
- `changeBag()`: resize; displaced bag placed first; in-bounds items keep cells, the rest auto-place; overflow goes
  to `throwToWorld` (ship: stash first). Refused (via `snapshot` / `restore`) only when the displaced bag itself
  cannot be placed.
- Restoring a save whose cells no longer fit reflows the bag largest-first; leftovers go to the stash.
- Bag wears once per raid (`BAG_DURABILITY_PER_RAID`) on extraction or corpse strip, not in training
  (`wearBagForRaid`, flag restored from `RaidInventoryState.bagWorn`). At 0 it has no effect but is kept.

## Quick-use wheel

- `quickSlots: QuickSlotItems` holds **stacks** by wheel direction; they are not in the bag grid. Weight,
  `countWhere`, `consumeWhere`, `stripForCorpse` and the raid blob include them; `getAllItems()` does not.
- Usable: `QUICK_USABLE_CATEGORIES`. A bag with n quick slots unlocks the first n of `QUICK_SLOT_UNLOCK_ORDER`;
  locked slots keep their stack, dimmed.
- `setQuickSlot` **moves**. A displaced stack (`QuickSwap.ts`): bag → wheel = vacated cell, then bag; container /
  stash → wheel = bag, vacated cell, source grid (shared containers skip the source). Nowhere → whole swap refused.
  Preview and execution share `quickSwapPlan`.
- Same-def drops merge (`mergeIntoQuickSlot`); partial drags work (`previewQuickPartial` / `dropQuickPartial`).
- **Auto-seat** (`parts/AutoQuick.ts`, game-wide): a quick-usable, searched stack not already on the wheel takes the
  first free slot after merging into wheel stacks. Hooked only in `tryAddItem`, `DropResolver.takeOne` (take all)
  and auto-place step 3 — not drags, menu moves, or `tryAddItemAnywhere` (shop / craft / harvest).

## Pouch

`parts/Pouch.ts`. The pouch item's `PouchDef.accepts` (`data/items.csv`) decides accepted categories. Carried-item
rules match the wheel; `consumeWhere` order is bag → pouch → wheel.

- Pouch cells are `{kind: 'grid', grid: 'pouch'}`; `locKind` is `'player'`, so bag ↔ pouch is not a transfer.
- Every preview / drop path refuses non-accepted categories, including swaps whose displaced item would enter.
- Every path through the pouch slot uses `changePouch`; contents the new pouch cannot take go to the bag, and if any
  cannot move **the whole change is refused**.
- `.inv-pouch` is `hidden` (not a drop target) with no pouch; `inventory:pouchChanged` is gated by `pouchSignature`.

## Reset policy

The loadout is persisted in `scav.loadout` and read **once in `init`**; afterwards session state is the truth.

| Event | Effect |
|---|---|
| `init` | restore save (wrong-category entries dropped, forbidden attachments returned); `announcePending` |
| first `hub:entered` | starter kit only if the kit is empty **and** (starter stash just granted **or** stash empty); else announce restored loadout; flush deferred favourites; strip raid marks |
| `afterChange()` in ship | `markDirty('hub')` |
| `world:ready` | `isDestitute()` (no loadout, empty bag **and** stash) → starter kit; else raid with the ship kit; re-emit loadout / count / quick events; solo raid → `markRaid(seed)` |
| mission changes | not saved until the mission ends |
| `game:complete` | keep; bag wear if extracted; strip raid marks; `saveNow('complete')`; clear solo marker |
| `player:died` | close window; `game/parts/CorpseNet` calls `stripForCorpse` |
| `player:respawn` | after a corpse strip → empty-handed; otherwise starter kit |
| `game:over` / `reset()` | `loseKit()` |
| `game:abort` | after complete / over → keep; else `loseKit()` |
| `game:newMission` | close windows, forget containers |

- `loseKit()` empties slots, bag, wheel, pouch; an empty stash falls back to the starter kit. Every `applyStarter` /
  `loseKit` ends with `saveNow('starter')`, so a reload cannot resurrect a lost kit.
- Starter stash (`tryStarterGrant`): once per profile, `none` / `pending` / `done` in `scav.grant` (outside the stash
  file, so a replacing server document cannot repeat it); `pending` settles once at `net:profileLoaded`.
- Stash and loadout share one debounce (`scheduleSaves`) and upload together as `ProfileRef.setMany`.
- `net:profileLoaded`: stash doc replaces the stash; loadout doc replaces the kit only outside a raid; a doc identical
  to local state is skipped (`sameProfileDoc`); a missing key uploads local state. Saves inside `withFreshSave`
  (starter kit, startup stash resize) go up `fresh`, so a real server profile wins. Unsent favourite toggles win.
- Stash size: startup applies `HousingRef.getStashSize()` grow-only; `housing:stashSizeChanged` applies exactly.

## Containers

- `crate:open` → `openContainer` (rolled once per id with `Random(seed ^ hash(id))` and `ctx.world.crateLootOpts(id)` — lab
  locked rooms skip the epic+ gate; `parts/Peek`, `parts/Allies` and `ContainerNet.materializeCrate` pass the same value); caller-supplied contents use
  `openContainerItems` / `openContainerItemsSized`. Default `CONTAINER_COLS × CONTAINER_ROWS`; corpse grids grow rows
  to fit everything (`fitCorpseGrid`) and scroll. Auto-close beyond `AUTO_CLOSE_DISTANCE` of the **live** position,
  on death, and outside gameplay / hub phases.
- **Search**: filled items start `searched: false` (footprint mask). Within `SEARCH_MAX_DISTANCE`, the first
  unsearched item in grid order accumulates `searchTimeFor(def, derived.searchSpeedMul)` → `container:itemRevealed`;
  `container:searchDone` once. Unsearched items are inert (`isItemLocked` gates operations, tooltip, menu, drag).
  Anything leaving a container is searched; only the raid blob stores `searched`.
- **Multiplayer takes** (`ContainerNet.ts`): contents roll per client; taken state is shared by roll index. Client
  take → `guardedTake` → `contq take` → `'pending'` (tile pulses) → replay on `cont taken {by: me}`, shake + toast on
  `cont denied`, expiry after `TAKE_REQUEST_TIMEOUT`. Nothing goes **into** a shared container and splits inside it
  are refused (`refusesIntoContainer`). The host validates against its copy (rolls unopened crates on demand; for
  containers it cannot roll, the first take of an idx wins) and stamps `rem` / `seq`; receivers drop stale `seq` and
  converge down to `rem`. `net:hostChanged` → drop pending, `contq sync` to the new host.
- `container:itemTaken {…, live}` has one emitter (`emitItemTaken`); catch-up is `live: false`. Another member's live
  take animates the tile out (`GridView.vanish`, `CONTAINER_TAKE_ANIM_S`).
- `stripForCorpse()` collects slots + bag + wheel + pouch + broken implant counterparts
  (`ctx.progression.stripImplantsForCorpse`), wears the bag first, empties the local inventory. `hookCorpseWire`
  pre-creates corpse containers so the host can judge takes on corpses it never opened.
- `peekContainerItems` mirrors the open path (seed, planet roll, fill order, pending takes) on copies only.

## Crafting, salvage, repair

- Station: `'field'` in a raid, `'ship'` otherwise (`currentStation`). Counting is `craftCountDef` (ship = bag +
  stash, field = bag) for chips, `canCraft`, `maxCraftCount`; consumption is `consumeFor` (ship: `consumeDefAll`).
- `getRecipes(station, bench?, level?)`: **no skill gate** (2026-09-16); field = `station: 'field'`; with bench = that bench up to its
  level; without = field recipes + ship recipes whose bench is placed at level. Cook-bench recipes are returned only
  when `'cook'` is asked explicitly and `canCraft` rejects them — cooking goes only through `cookBlock` /
  `consumeCookInputs` (2026-09-16: meals are not items — the output is a housing plate, so no output room check).
- Craft column: bench list limited to one facility (`benchFacility`, `data/furniture.csv` `room`; workshop adds
  `빠른제작`); `break_*` hidden; hold `CRAFT_HOLD_TIME`; craftable recipes sort first (stable); costs via `craftCost`
  (`HousingRef.getCraftCostMul`).
- Outputs (craft and salvage): ship → stash, then bag; field → bag (`roomForOutputs` / `addCraftOutputs` share the
  order). Research benches give research XP instead of craft XP.
- **Material refund** (`refundAfterCraft`, 2026-09-16 — every craft path: `craft()`, the lab benches and
  `consumeCookInputs`, never `break_*`): the recipe's own `skill` refunds each consumed **unit** with probability
  `craftRefundChance` (`shared/craftRefund.ts`), plus the older per-run research-bench roll (`researchRefundQty`).
  Durable gear is excluded (`items/Salvage.isCraftRefundable` — its repair / salvage tables are those same inputs).
  Both rolls land in **one** delivery — bag → (ship) stash → ground, the reverse of craft outputs because the
  materials are what you were about to use again — and **one** `재료 회수: <이름> ×n · …` toast.
- Salvage: `disassembleRecipeFor(uid)` = `ctx.loot.getSalvageFor(inst)` (durability-scaled); preview, room check and
  `updateCraft` all go through `resolveRecipe`. Not offered for container, stash or pouch stacks.
- Repair (ship only): materials only from `repairMaterials` (`LootRef.getRepairCost`, spray refill fallback); a worn
  crafted item with no cost is refused (`needsRepairCost`). `benchRepairRows` covers slots, bag, pouch, wheel — **not
  the stash**. The opener `.inv-repair-open-btn` sits in the bag header, hidden in raids.
- `getLaunchWarnings()`: `noPrimary`, `lowAmmo`, `noBag`, `noArmor`, `noImplant`, `noHeal`, `noEnvPrep`, `noMeal`,
  `noContract`, `plateDiscard` — never blocking. An uneaten dining plate (`HousingRef.getPlate` ≠ pending meal) is
  reported by `noMeal` when nothing is pending, else by `plateDiscard` at the end.
- Prep items (context menu, ship): `progression.usePrep` is asked **first**; the item is removed only on success.
  Meals are not items (2026-09-16) — no `먹기` entry; they are eaten from the housing dining table.

## Sockets, ammo, durability

- Attach: weapon at a `canSocketAt` location (bag, slot, stash); `canAttach` decides, including per-class sockets
  (`EffectiveWeaponStats.sockets`). Replaced attachment → bag → stash → ground; a smaller magazine spills rounds.
- Forbidden attachments are detached **at load** only (`Stash.load`; `returnForbiddenAttachments`: loadout → stash
  → bag, raid blob → bag). No room → stays socketed with no effect. Stash and loadout then save together.
- `unloadWeapon`: rounds → ammo stacks, overflow thrown out. Weapons and bags drop as whole instances (`PickupWire.ex`).
- A spray at 0 durability is a valid item (`?? max` applies only to `undefined`).

## Favourites, raid-found marks, meal quality

- **Favourites**: per def id, loadout document `fav`. Outside the ship a toggle sets `favoritesDirty` and rides the
  next loadout save; `applyLoadoutSave` never touches them. UI: ribbon `.is-favorite` (`--c-favorite`), sort first,
  filter entry, container glow, hold-confirm before disassembling.
- **Raid-found** (`ItemInstance.raidFound`, `src/shared/raidFound.ts`): crate rolls mark via
  `ContainerStore.raidMark`; corpse / supply callers mark their own. For active `extract_with_items` items the mark
  is in the stack key (never merges with brought stacks); merging differently marked stacks of other items yields
  **no mark**. Splits copy it. Carried in pickup / corpse wires and the raid blob only. Stripped at `game:complete`
  (after meta settles), `game:over`, `game:abort`, `hub:entered`. Ribbon `.is-recovery-item` in raids.
- **Meal quality** (`ItemInstance.quality`, `src/shared/cooking.ts`): always in the stack key; splits copy it
  (`copyMealQuality`); saved as `SavedExtras.q`; in pickup / corpse wires; never stripped; tile badge `★n`.
  2026-09-16: meals are no longer items, so these paths (and `getMealStacks` / `countDefQualityAll` /
  `consumeDefQualityAll`) see no meal stacks today; they stay harmless. `consumeCookInputs` consumes bag → pouch → wheel
  → stash and places nothing.
- Any new item copy / wire / save path must carry `raidFound` and `quality` (omitted = none / 0).

## UI conventions

- **Open / close**: blocker `inventory` + `ctx.escape` entry + in-game cursor (`setCursorMode`, pointer lock kept).
  Tab (`Keys.INVENTORY`) opens and closes; Tab and Escape first cancel the innermost popup (`closePopups`) or a held
  stack; `EmbeddedView.requestLeave` may intercept. Tab is ignored under the pause menu and does not open during
  `PlayerRef.introWaking`.
- **Launch-ready read-only**: `readOnlyReason()` (`ctx.hub.launchReady`) is the one gate; mutations start with
  `readOnlyBlocked()`, previews return `'bad'`; tooltips and menus still work.
- **Tab screen** (flex `order`, not DOM order): ship = `[.inv-panel-stash] [.inv-equip] [.inv-panel-grids › .inv-panel-bag]`,
  joined into one panel (each card cancels `--inv-panel-gap` with a negative right margin; the right neighbour's left
  border is the divider). Raid = `[equip][bag]`; container looting = `[container][equip][bag]`; catalog (ship) =
  `[catalog][stash|bag]`. The stash is a direct `.inv-layout` child placed **after** the container panel in the DOM so
  its neighbour is always the equipment column (or the bag card in catalog mode). Stash and bag each keep their own
  scroll, sort and filter dropdown. Other tabs host `EmbeddedView`s from `progression`, `meta`, `housing`; a missing
  owner falls back to the inventory tab with a note.
- **Stash header** (`.inv-panel-stash .inv-head.is-bare`): `함선 창고` (`.inv-stash-name`, `.inv-eyebrow` look) on the
  left, then `[사용칸 / 전체칸][정렬][filter][업그레이드]` on the right. The readout is cells only (no item-kind
  count); `.inv-stash-upgrade-btn` calls `HousingRef.openStorageUpgrade()` and is `hidden` without `ctx.housing`
  (raid / no ship) — housing owns the modal, level, cost and hold.
- **Bag tools** (bag header): `[모두 수리][모두 창고로 이동][정렬][filter]`. `.inv-stash-all-btn` (ship only, hidden in
  raids, disabled with an empty bag grid) → `moveBagToStash()`: bag **grid** only (not wheel, pouch or slots),
  favourites included, largest first, one `emitTransfer` per moved item and one `afterChange`; stash-hidden tutorial
  items stay; what does not fit stays with one toast `창고에 공간이 없습니다 (n개 남음)`.
- **Filter dropdown** (`buildFilterSelect` → `shared/dropdown.buildDropdown`, also used by `TradeGrids`): no native
  `<select>` anywhere — the list is drawn into a `position: fixed` layer under `document.body`, so it is never clipped
  by `.tg-gridwrap` / `.inv-stash-scroll` and its Escape is swallowed in capture (the window stays open). The wrapper
  keeps `.inv-filter-sel` (`.is-on` = a filter other than `전체`); `inventory.css` only sizes `.inv-filter-sel
  .dd-trigger` down to the tool row. `FilterControl` = `{el, set, close, dispose}` — the owning screen must
  `close()` on hide and `dispose()` on teardown, or the floating list outlives it.
- **Cell size**: `ui/labels.CELL` is the only source; `STEP` drives grid size, hit tests, highlight and ghost. It
  follows **window height** (`gridCellForHeight`, `INV_CELL_*` in `data/tuning.csv`). Renderers write `--inv-cell`
  inline (`applyGridCellVar`); CSS has no media query for it.
- **Gestures**: drag (Shift half, Ctrl one), R rotate, X drop (Shift one, Ctrl half), right-click = menu on **every**
  item (`빠른 이동 (…)`, favourite, item entries), double-click = auto-place, middle-click = request (weapons ask for
  their calibre). Released outside panels = world drop (ship: stash first).
- **Held remainder**: a partial merge keeps dragging the rest without it leaving the source (`DragState.held`);
  next release places; right-click / Escape / empty space / close releases.
- Filters dim tiles (`.is-filtered-out`) in place; a sort that cannot fit restores the grid (`'fail'`).
- **Tooltip pin** (`TipPin`): hold `UI_HOLD_CONFIRM_S` (ring from `RING_SHOW_AT`); unpin by outside press, diamond,
  Escape, close, or item gone. Pinned weapon sockets can be dragged out (container weapons: hover only).
- **Hover validation**: `InventoryUI.validateHover` hides the tooltip when the hovered tile was detached or is no
  longer under the pointer (detached nodes get no `pointerleave`).
- The craft detail embeds the tooltip card as `.inv-tt-card is-embedded`, never `.inv-tooltip`.
- **Craft layout** (`.inv-layout.is-craft`): `[.inv-panel-craft: bench list · 5-column recipe grid] [.inv-panel-craft-detail]`; the
  stash card and bag card (`.inv-panel-stash`, `.inv-panel-grids`) are hidden by CSS (materials are counted through `craftCountDef`, not the grids), so
  Tab / Escape / key-guide paths are unchanged. The detail card is `CraftPanel.detailEl`, appended by `InventoryUI` right after
  the craft panel; it is `hidden` with no selection and mirrors the detail body's state classes and `--rc`
  (`syncDetailCard`). Hovering a recipe cell shows the output's inventory tooltip through `CraftHoverHandlers` (the window's
  floating `Tooltip`); the panel drops it itself on rebuild / close (no `pointerleave` for detached cells).
- Hold buttons carry `shared/keycap.createHoldButtonCap`; disabled rows hide it.
- Key guide owners: `inventory`, `inventory.craft`, `inventory.split`, `inventory.disassemble`, `inventory.repair`.

## Rules

- `parts/*.ts` take the system as first argument `sys`; the class keeps one-line delegates. `parts/` import
  `InventorySystem` **as a type only**; shared values go in `model.ts`. Non-private members are still
  folder-internal. — `InventorySystem.ts`
- Never stack two grids vertically in one scroll container — one is always off-screen and cannot be scrolled while
  dragging. Each block scrolls in its own wrapper with `scrollbar-gutter: stable`. — `ui/TradeGrids.ts`
- Class names are global; check `rg "\.<name>"` first (`.inv-repair-all` is the popup's run button). — `inventory.css`
- `.inv-craft-row[data-recipe]` (detail panel) and `.inv-cat-search` are used by `src/tutorial/Steps.ts` and smokes;
  the detail auto-selects the first cell. Never move DOM under the pointer during a hold (reads as `pointerleave`
  and cancels). — `ui/CraftPanel.ts`
- Smokes compute cell centres from `--inv-cell` and count craft outputs with `countDefAll`.
- `countDefAll` / `consumeDefAll` / `tryAddItemAnywhere` do not check the phase; callers that must not touch the stash
  in a raid gate on `currentStation()` / `isRaidActive()`. — `parts/StashOps.ts`
- Gameplay paths never silently discard items: wheel swaps, pouch changes, sorting and socket rules refuse or fall
  back. Overflow is thrown into the world (ship: stash first); only save restore may discard (with `console.warn`)
  when bag and stash are full.

## Recent changes

Older: `git log -- src/inventory`.

- 2026-09-17 — `TradeGridsView.previewExternalAt` / `clearExternalPreview` (shared contract, add-only): the cell-footprint highlight for an item dragged in from a furniture screen, same hit test and rule as `placeExternalAt`.
- 2026-09-17 — 무한 상자 double-click puts the item into the stash first while the stash shows (ship), then the bag (`takeFromCatalog`; failure toast `창고와 가방에 공간이 없습니다`).
- 2026-09-17 — The Tab window's `기업` screen tab is hidden (and `setTab('corp')` / `openScreen('corp')` fall back to 인벤토리) until any corp reaches 신뢰도 Lv.1 (`CORP_ACCESS_REP_LEVEL`); re-evaluated live on `meta:repChanged` / `meta:loaded` (`Screens.corpTabLocked`, `onCorpAccessChanged`).
- 2026-09-16 — `CREDITS` pill removed; bag footer = small `가방 내 가치 n C` (left) + current credits `n C` (right); Tab / Escape popups / R / X ignored while the messenger is open over the window.
- 2026-09-16 — Craft cells no longer paint the bench-level requirement over the thumbnail (only the detail's hold button says it — `CraftPanel.build`, `.inv-craft-locktag` gone), an uncraftable cell is dimmed much harder (`.inv-craft-cell.is-locked` / `.is-bench-locked`), and `표본` is its own filter chip (`FILTER_GROUPS`, split out of `bio` = `재배`) and its own 무한 상자 tab (`CATALOG_TABS`).