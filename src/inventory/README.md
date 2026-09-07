# src/inventory — Diablo-2 grid inventory (`ctx.inventory`)

`InventorySystem` owns the player's bag grid (size = equipped bag), the four equipment slots (주무기 I / 주무기 II / 보조무기 / 가방), the eight **quick-use wheel slots** and the currently open loot container. It publishes `ctx.inventory` (itself) and `ctx.loot` (`LootService` from `@/items`). Weapon package (2026-09-05): 3 weapon slots, bag-sized grids, sockets, ammo v2, unload, repair, and a reset policy that lets worn weapons survive a completed mission. Phase 2 (2026-09-06): quick-use slots (`QuickSlots.ts`, rose panel, `consumeItem`) and the `player:respawn` starter reset. **Phase 7** (2026-09-06): Tarkov-style **container search** (items hidden until 감정), **host-authoritative container takes** in multiplayer, `canFit`, `captureRaidState` / `applyRaidState`, and the **server profile** mirror of the stash / loadout saves — see the last section. **Phase 10** (2026-09-07): live container loot sync (`container:itemTaken`, tile vanish animation, `cont taken.rem / seq`), the read-only **분대원 장비 뷰**, credits as `n C` everywhere and the in-game software cursor instead of releasing the pointer lock — see the last section. **Phase 8** (2026-09-06): the hub Tab window **hosts** the 캐릭터 / 기업 / 함선 screens as embedded views, the 전술 임플란트 picker · 필드 제작 · 새 **아이템 분해** dialog became **modeless popups**, every material requirement is an `@/shared` item chip, and the credits pill reads `CREDITS 500` — see the last section.

| File | Purpose |
|---|---|
| `Grid.ts` | Pure occupancy grid: `canPlace/blockersAt/place/remove/moveTo/rotate/findFreeSlot/autoPlace/mergeIntoStacks/mergeInto/canAbsorb/totalValue`, plus **`resize(cols, rows, priority?)`** (in-bounds items keep their cells, the rest are `autoPlace`d largest-first, what does not fit is returned; `priority` entries are placed first, at their hint cell when possible), **`snapshot()` / `restore()`** for all-or-nothing attempts. `cols`/`rows` are getters (mutated only by resize/restore). Rotation swaps the footprint; `rotate()` tries in place, then nearby offsets. `version` counter drives UI diffing |
| `Sockets.ts` | Pure socket bookkeeping on `ItemInstance.sockets`: `socketOf(def)`, `socketContent`, `attachedItems`, `filledSocketCount`, `setSocket` (returns the previous attachment), `clearSocket`, `clearAllSockets`, `findSocketed(weapons, uid)`. No events, no compatibility checks (those live in the system via `LootRef.canAttach`) |
| `QuickSlots.ts` | Pure quick-use wheel bookkeeping on a `QuickSlotUids` array (length `QUICK_SLOTS`, index = wheel direction, values = bag item uids): `createQuickSlots`, `isQuickUsable(def)` (`QUICK_USABLE_CATEGORIES`), `isQuickIndex`, `quickSlotOf`, `firstFreeQuickSlot(slots, active)`, `assignQuickSlot` (one slot per uid — moves), `clearQuickSlotOf`, `relinkQuickSlot(from, to)` (slot follows a surviving stack), `pruneQuickSlots(has)` (item left the bag), `autoAssignQuickSlots` (starter policy), `quickSlotsSignature` (change detection). No events, no grid access |
| `Serialize.ts` | **Phase 5**: item (de)serialisation shared by the stash and the loadout save — `SavedExtras` (`defId / qty / durability / ammoInMag / sockets` recursive) + `SavedPlacement` (`+ rotated / x / y`), `serializeExtras` / `serializePlacement`, `reviveItem(sv, getDef, loot, tag)` (fresh instance via `LootRef.createItem`, clamps, unknown def → null + warning), `savedCell`, `safeStorage` / `readSaveFile` / `writeSaveFile` (every localStorage access in try/catch). **Never carries `searched`** (Phase 7): a saved / dropped item is always searched |
| `Stash.ts` | **함선 창고** (2026-09-06): `STASH_COLS × STASH_ROWS` (10×24) `Grid` by default, persisted in localStorage `scav.stash` (positions + `durability` / `ammoInMag` / nested `sockets` through `Serialize.ts`; uids are re-minted on load, unknown defs dropped with a warning, overlapping cells auto-placed). **Phase 6**: the save (v2) also carries `cols` / `rows` (v1 files migrate to the default size; a corrupt size is ignored, cap 40×200) and `resize(cols, rows)` grows the grid in place / refuses a shrink while any item would fall outside. `markDirty()` debounces a save 350 ms after a change, `flush()` on pagehide / dispose. Survives missions, deaths and reloads — the bag / loadout have their own save + reset policy (`Loadout.ts`). **Phase 7**: `onSaved(file)` hook after every write (→ `ctx.net.profile.set('stash', …)`), `saveFile()`, `Stash.isSaveFile(doc)`, `loadFrom(doc)` replaces the contents with a server document (`StashSaveFile`) and rewrites the local file without echoing it back |
| `Loadout.ts` | **Phase 5 loadout persistence**: `LoadoutSave` v1 (`slots` by `LoadoutSlot` as `SavedExtras`, `bag` as `SavedPlacement[]`, `quick` = bag index per wheel direction), `loadLoadoutSave()` (sanitised, null when missing / corrupt), **`sanitizeLoadoutSave(obj)`** (Phase 7: the same sanitiser for a server document / raid state; extra per-entry fields such as `searched` pass through), `isEmptyLoadoutSave`, and `LoadoutStore` — the system hands it a `capture()` callback; `markDirty(reason)` debounces 350 ms (first reason of a burst wins), `saveNow(reason)` writes unconditionally, `flush()` on pagehide / beforeunload / dispose; every write calls `onSaved(reason, file)` (the system emits `inventory:loadoutSaved {reason}` and mirrors the file to the server profile). Key `LOADOUT_STORAGE_KEY` (`scav.loadout`) |
| `Container.ts` | `Container` (6×4 grid + world position + `tier` + optional `title`; `fill(items)` auto-places largest-first, overflow dropped with a `console.warn`) and `ContainerStore` cache keyed by container id: `getOrCreate(id, tier, …)` rolls `ctx.loot.rollCrate(tier, Random(seed ^ hash(id)))` on first open; `getOrCreateWithItems(id, items, position, title?)` places caller-supplied contents (corpses; `tier` 0, `title` default `CONTAINER_DEFAULT_TITLE` = `컨테이너`) on first open and ignores `items` for a known id. The container grid never resizes. **Phase 7**: `fill` marks every item `searched: false` and appends it to **`order`** (uids in roll order = the wire `idx`, never shrinks); `indexOf / uidAt / remainingAt`; **`taken`** (idx → units removed from this copy through the authoritative channel), `applyTaken(idx, qty)` / `recordTaken`, `takenWire()`; search state `searchProgress` (uid → seconds), `nextToSearch()` (first unsearched in grid order), `placementsInSearchOrder`, `unsearchedCount`, `searchDoneEmitted`. `ContainerStore`: `pendingTaken` for takes confirmed before a container was opened here (applied on its first open), `recordPending / pendingTakenOf`, `takenWire()` (opened + pending) and `applySync(items)` for `cont sync`, `all()`. **Phase 10**: `nextTakeSeq / acceptTakeSeq / resetTakeSeq` (the `cont taken.seq` counter + duplicate filter) and the `onTaken` hook that reports a catch-up removal (`applyPending` / `applySync`) as `container:itemTaken {live: false}` |
| `InventorySystem.ts` | `GameSystem` + `InventoryRef`. **Phase 7** (see the last section): `updateSearch` (per-frame reveal loop), `isItemLocked`, `unsearchedCount`, `guardedTake / requestTake / trackTake / announceTake`, `pendingTakeUids`, `onContainerMessage / onContainerRequest / requestContainerSync / materializeCrate`, `canFit`, `captureRaidState / applyRaidState` (`RaidInventoryState`), `uploadProfileDoc / onProfileLoaded` (Phase 9: `withFreshSave` instead of the removed `offlineDocs` queue), `takeOne`, `checkLootedFor`; `OpResult` gained `'pending'`. Event wiring, Tab/Escape/R/X handling, auto-close (> 6 m from crate, death, phase change), reset policy, and all mutations used by the UI: `drop`, `previewDrop`, `dropPartial`, `previewPartial`, `previewAttach`, `attachFrom`, `quickMove`, `activate` (double-click), `equipTargetFor`, `rotateItem`, `takeAll`, `registerQuick`, `quickIndexOf`, plus the contract methods (`dropItem`, `splitItem`, `getBagSize`, `findItem`, `updateItem`, `attachToWeapon`, `detachAllSockets`, `unloadWeapon`, `repairWeapon`, `equip`, `getQuickSlots`, `setQuickSlot`, `getQuickSlotCount`, `consumeItem`, `openContainerItems`) and the quick-chat `requestItem`. **Phase 6** (see the sections below): `openCatalog / closeCatalog / isCatalogOpen` + `catalogQty / previewCatalog / dropFromCatalog / takeFromCatalog`, `getStashSize / setStashSize`, `countDefAll / consumeDefAll`, `captureLoadout / applyLoadout`, `openBenchCraft / getBench / closeBench / getBenchRecipes / benchRepairRows / benchRepairAll`, `getRecipes(station, bench?, level?)`, `craftCostMul / craftCost`. **2026-09-07**: `nearestFreeSpot(uid, from, gridId, x, y, rotated)` — the free footprint closest to a cell, used by the drag UI for equipment-slot drops that land on an occupied cell. **Phase 5**: loadout persistence (`captureLoadoutSave / restoreLoadoutSave / announceLoaded`, see below), `findItemAnywhere / tryAddToStash / tryAddItemAnywhere / takeItem` (contract, corp shop), `inventory:containerOpened` from `openContainer / openContainerItems`, `relockLater()`. **Phase 8**: `disassembleRecipeFor(uid)` + `openDisassemble(uid)` and the module-level `isDisassembleRecipe(r)` (`break_*` rows are filtered out of `getBenchRecipes()` but still craftable); `openCharacter()` / `openCorp()` are **gone** — the tabs build embedded views inside the window instead. **Phase 10**: `emitItemTaken` (the single `container:itemTaken` emitter, live vs. catch-up), `rem` / `seq` on `cont taken`, `captureCrewLoadout / createCrewLoadoutView`, and `setOpen` running the software cursor instead of releasing the pointer lock (`relockLater` removed). `locate(uid)` finds an item in bag → container → slots. Exports the UI vocabulary (`GridId`, `SlotId` = `LoadoutSlot`, `LOADOUT_SLOTS`, `WEAPON_SLOT_IDS`, `slotAccepts`, `ItemLocation`, `DropTarget` incl. `{kind:'weapon'}` / `{kind:'quick', index}`, `OpResult`, `DropPreview`, `BagSize`, `ActiveBench`, `BenchRecipeRow`, `BenchRepairRow`) |
| `ui/InventoryUI.ts` | DOM layout under `ctx.uiRoot` (**Phase 7**: `.inv-search-status` readout in the container header, `setSearchProgress(uid, p, active)` / `refreshSearchStatus()` / `shakeItem(uid, loc)`; an unsearched tile (`sys.isItemLocked`) gets no tooltip, press / drag, context menu, double-click or middle-click request; `result()` treats `'pending'` as silent): container panel (left), bag (center, width follows the grid columns; **quick-slot rose** under the grid), equipment column (right: 4 slots), hint bar, world-drop zone. Drag & drop with live ghost + valid/invalid/swap/merge highlight, **attachment → weapon tile drag** (socket target lit green/red via `previewAttach`), **stim/grenade → wheel cell drag**, cell → cell / cell → out drags, Shift/Ctrl partial drags, R to rotate, right-click quick action / context menu, middle-click request, X drop, double-click equip/move/register, "모두 가져가기", tooltip, shake on refusal, `audio:play` sfx. **Phase 6**: hosts the `CatalogView` (leftmost panel) and drives **catalog drags** (`DragState.catalog`: a fresh instance per press, targets = equipment slots + active grids only, `previewCatalog` / `dropFromCatalog`, no world drop, no wheel; double press within 400 ms = `takeFromCatalog`), `setCatalog(open)`, `setCraftOpen(open)` for bench mode. **Phase 8**: screen tabs 인벤토리 / 캐릭터 / 기업 / 함선 (`setTab` / `screenTab`, `.scr-tabs` hidden outside hub mode) swap `.inv-layout` for the `.inv-screen` host and build `ctx.progression.createSheetView` / `ctx.meta.createCorpView` / `ctx.housing.createShipView` into it (`refresh()` on show, `dispose()` on leave); the `.inv-modeless-layer` holds the modeless popups, `closeCraft()`, `openDisassemble(uid)`, `canDisassemble`, `disassemblePanel`; the 수리 context entry renders `renderItemCost` chips. **2026-09-07**: 제작 left the modeless layer and is a column of `.inv-layout` again (`.is-craft`, `.inv-col-right`), and `showScreenTab(tab)` backs `InventorySystem.openScreen`. **2026-09-07 (안정화)**: the hint bar and the world-drop zone share one fixed-height `.inv-footer` (the swap at drag start used to re-centre the whole window), and `resolveGridTarget()` resolves a drag's grid **strictly first** — a grid that actually contains the pointer beats one that only sits inside its half-cell tolerance, so 가방 and 함선 창고 (stacked with a gap) stop stealing each other's edge rows. An **equipment slot → grid** drop whose exact cell is blocked now retargets to `sys.nearestFreeSpot` (highlight included) instead of snapping the weapon back into its slot with a shake; grid → grid keeps the strict Diablo rule |
| `ui/ContextMenu.ts` | Cursor-anchored right-click menu (`MenuEntry[]`), closes on selection / outside pointerdown / Escape / hide |
| `ui/SplitDialog.ts` | "수량 지정" modal: number input + slider over 1..qty-1, 확인/취소, Enter/Escape |
| `ui/GridView.ts` | Renders one `Grid`: cell layer (rebuilt by `syncDims` whenever the grid's cols/rows change — bag swap, stash resize), uid-diffed absolutely positioned tiles, highlight rect, `markSplitSource()` for partial drags, `setSocketTarget()`, `setQuickBadges(uid → glyph)` (forces a re-render when the set changes); `buildTileContent(el, item, def, w, h, stats?)` shared with slots, wheel cells, catalog tiles and the ghost — weapons get five socket pips + a durability bar; `addQuickBadge(el, glyph)` adds the wheel-direction badge. **Phase 7**: `isHiddenItem(item)` (`searched === false`) → `buildTileContent` renders the **footprint mask** (`.inv-tile.rarity-hidden.is-hidden-item`, `?` icon, `???` name, no rarity class / colour / qty / pips / bar / badge); `setScan(uid | null, progress)` keeps the `.inv-tile-scan` gauge (`--p` 0..100 %) on the item being searched across re-renders; `setPending(uids)` pulses tiles whose take awaits the host. **Phase 10**: `vanish(uid)` — the next `refresh()` that no longer finds the item animates the tile out (`.is-vanishing`, `translate:` / `scale:` / `opacity` only) instead of removing it on the spot, and a removed tile's `scan` state is cleared right away. **2026-09-07**: `hitTest(px, py, pad)` + `hitPad`, and `cellForGhost(..., pad)` takes the tolerance as an argument so `InventoryUI` can run a strict pass before the padded one |
| `ui/CatalogView.ts` | **무한 상자** panel (Phase 6): category tabs (`CATALOG_TABS`, derived from `ItemCategory`: 전체 / 무기 / 탄약 / 부착물 / 가방 / 방탄복 / 가젯 / 소모품 / 재료 / 약초 / **씨앗** (Phase 8) / **서적** (Phase 9) / 가구 — a tab without defs is dropped), search box (Korean substring on the name, plus the id; key events stop at the field so the game's `Input` never sees them), one uniform 2×2 tile per `ItemDef` from `ctx.loot.getAllItemDefs()` with a caption, a scrolling grid, `닫기`. Tiles are built once and re-appended on filter; `CatalogHandlers` hand press / hover / close to the window. `tileEl(defId)`, `shake`, `setTab`, **`setTabForCategory(cat)`** (Phase 9: picks the built tab whose `categories` include `cat`, false when there is none), `setQuery`, `visibleCount` for tests |
| `ui/CraftPanel.ts` | Hold-to-craft panel (`제작` button, or a 작업실 bench). **Bench mode** (Phase 6, `sys.getBench()`): eyebrow `WORKSHOP BENCH`, title `WORKBENCH_LABEL_KO[kind] Lv.n`, rows from `sys.getBenchRecipes()` (locked rows `is-bench-locked` with a `작업대 Lv.n 필요` tag and no button), material chips from `sys.craftCost` (workshop discount, `작업실 할인 −n %` chip), a `닫기` button (`sys.closeBench`) and the **repair list** (`sys.benchRepairRows`: slot / durability bar / cost text `폐금속 ×n · 합금 판 ×n` or `정비 완료` / `수리` button → `sys.repair`, `모두 수리` → `sys.benchRepairAll`, 3 s result line). Same cost readout as `hub/ui/WorkbenchMenu.ts` (copied, not imported). **Phase 8**: adopted into a `Modeless` frame (no longer a `.inv-layout` column), material costs are `renderItemCost` item chips from `@/shared` (recipe rows **and** the repair list), the `닫기` button is always shown (bench → `closeBench`, otherwise the window's `onClose`), and the `break_*` 분해 rows are gone from the list |
| `ui/Modeless.ts` | **Phase 8** — shell of the **모달리스 팝업** (`.inv-modeless`, variant class `-implant` / `-craft` / `-disassemble`) shared by the implant picker, the craft panel and the 분해 dialog. `withHeader(eyebrow, title)` / `adopt(panel)` / `open(anchor?, centred?)` / `place()` / `close()` / `dispose()`. Adds **no** `ctx.uiBlockers` token and never touches the pointer lock — the window owns both; dismissed by the window's Escape chain (`closeOverlays`) or by a capture-phase `pointerdown` outside the panel *and* its anchor (so a click on the opener toggles). Anchored popups sit to the left of the anchor (clamped into the viewport), anchorless ones get `is-centred` (the craft popup is parked at the right edge by CSS). **Phase 8 UI pass**: `centred` keeps the anchor purely as the "this press is not outside" element while the frame stays in the middle of the screen — that is how the 전술 임플란트 panel is both centred *and* still toggled by a second click on its slot |
| `ui/DisassemblePanel.ts` | **Phase 8** — the **아이템 분해** dialog: a `Modeless` showing the **expected result** (`재료` input chip with 보유/필요 → `결과물` output chip ×n, both `buildItemChip` from `@/shared`), the craft duration and a `분해` button that runs the item's `break_*` recipe through `InventorySystem.craft` (progress fill in the button, a second click cancels). `open(uid)` / `close()` / `refresh()` / `isOpen` / `itemUid`; emits `ui:disassembleToggled {open, uid}` on both edges and closes itself when the source stack is gone |
| `ui/CrewLoadoutView.ts` | **Phase 10** — `createCrewLoadoutView(host, loadout, opts)`: a **read-only** 장비 / 가방 / 빠른 사용 view of another member's `captureCrewLoadout()` document (발사 준비 패널 → 우클릭). `sanitizeLoadoutSave` validates, `reviveItem` mints the items onto a throwaway `Grid`, `GridView` + `buildTileContent` draw them with no-op handlers. Blocks `['equip','bag','quick']` (no 함선 창고, no 크레딧), unknown def ids skipped, `EmbeddedView` (no blocker / pointer lock / Escape listener) — see the last section |
| `ui/Tooltip.ts` | Hover card (name, category · rarity, description; weapons: 종류 / 등급 / 대미지 / 탄창 / 장전 / 연사 / 반동 / 정조준 시간 / 재장전 / 발사 모드 / 탄종 / 유효 사거리 / 배율 / 내구도 from `ctx.loot.getEffectiveStats` + the five sockets; attachments: socket, 호환, effects; bags: grid + 퀵슬롯; **서적 (Phase 9)**: 스킬 (한국어 name via the new `TooltipLookups.getSkillName` → `ctx.progression.getSkillDef`, the raw id as fallback) + 용도 `서재 책장에 꽂으면 해당 스킬 XP 증가`; qty, size, value) |
| `ui/labels.ts` | Cell metrics (`CELL=54`, `GAP=2`, `STEP`), `SLOT_LABEL` / `SLOT_KEY`, `QUICK_DIR_GLYPH` (▲ ◥ ► ◢ ▼ ◣ ◄ ◤), `QUICK_ROSE_ORDER` (3×3 DOM order), Korean UI strings (hints, menu, quick panel, split dialog, stat labels, **`search`**: `?` / `???` / `감정 중 · n개 남음` / `감정 완료` / denied toast), formatters (`fmtDeg`, `fmtMul`, `gradeLabel`), `DURABILITY_LOW` (0.3). **Phase 8**: `TEXT.tabs` gained `ship` / the per-tab hints / `unavailable`, `TEXT.disassemble` (분해 dialog), `TEXT.modelessClose`, `TEXT.catalog.tabs.seed`, and **`TEXT.credits.value` returns the bare number** so the pill reads `CREDITS 500`. **Phase 9**: `TEXT.bookStats` (스킬 / 용도 / the 서재 책장 line) and `TEXT.catalog.tabs.book` (`서적`). **Phase 10**: `fmtValue` = `formatCredits` from `@/shared` (`1,200 C`, no `₩`) and `TEXT.credits.value` = `formatCreditAmount` |
| `inventory.css` | Styles (imported by `InventoryUI.ts`); scoped under `.inv-*` (`.inv-quick*` for the wheel panel, `.inv-tile-quick` badge, `.inv-cat-*` catalog, `.inv-repair-*` bench repair list, **Phase 7** `.is-hidden-item` footprint mask, `.inv-tile-scan` bottom-to-top gauge (`::before` height = `--p`) under the moving sheen, `.is-scanning`, `.inv-search-status` (`is-done` / `is-paused`; **2026-09-07** a fixed `min-width` so 감정 중 ↔ 감정 완료 cannot resize the container panel), `.inv-footer` (fixed-height slot shared by the hints and the drop zone; collapsed in `.is-hub`), `.is-pending` pulse; **Phase 8** `.inv-screen` / `.inv-screen-note` embedded-screen host, `.inv-modeless-layer` / `.inv-modeless[-implant|-craft|-disassemble]` / `.inv-modeless-head` / `.inv-modeless-body` / `.inv-modeless-close` / `.is-centred`, `.inv-dis-*` dialog, `.inv-craft-costs`, `.inv-menu-line` / `.inv-menu-item.has-costs` / `.inv-menu-costs`), no dependency on `src/ui/styles` — **except** the `.item-chip*` rules of `buildItemChip` / `renderItemCost`, which `src/ui/styles/base.css` owns (Phase 8 contract) |
| `__selftest__.ts` | `runInventorySelfTest()` — console.assert checks for grid/rotation/stack/split-merge, `resize` (grow/shrink/overflow/priority/snapshot-restore), sockets (`Sockets.ts` + `canAttach` + effective stats), quick slots (auto-assign under 2 / 6 usable slots, move, clear, prune, consume-to-0 relink, signature), loot determinism, starter ids (dev use; exported via `@/inventory`, run from the browser console or `scripts/smoke-quickslots.mjs`) |
| `index.ts` | Barrel — import via `@/inventory` |

## Equipment slots

| Slot | Key | Accepts | Notes |
|---|---|---|---|
| `primary` 주무기 I | 1 | category `primary` | |
| `primary2` 주무기 II | 2 | category `primary` | drag a slot weapon onto the other primary slot to swap them |
| `secondary` 보조무기 | 3 | category `secondary` | |
| `bag` 가방 | — | category `bag` | sets the bag grid size (see below) |

`slotAccepts(def, slot)` is the single rule. Double-click / `장착` on a primary uses `equipTargetFor`: first empty primary slot, else swap with 주무기 I (the displaced weapon lands in the source cells / auto-place / the bag when the source was a container; refused + shake when nothing fits). `InventoryRef.equip(uid | null, slot)` = the same `dropOnSlot` path (`null` unequips via `quickMove`). Equipped items live in `Loadout`, not in grid cells. Every change emits `loadout:changed {primary, secondary, primary2, bag}`.

## Bag grid

`getBagSize()` = equipped bag's `def.bag` (`cols × rows`, `quickSlots`), else `BAG_DEFAULT_COLS × BAG_DEFAULT_ROWS` (5×3, 1 quick slot). Starter `bag_common` → 5×6.

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
| first `hub:entered` | completely empty inventory (no save / empty save) → `STARTER_LOADOUT` as before; otherwise, when `announcePending`, **announce** the restored loadout: gates reset (`lastEquipUids`, weight, counts, quick signature) + `inventory:bagChanged` + `loadout:changed` / `equip:changed` + `afterChange()` (which saves once more, reason `hub`) |
| every `afterChange()` while `ctx.isHubPhase()` | `markDirty('hub')` → one debounced write per burst (drag session, preset, bench craft, stash move…) |
| `world:ready` | no weapon in any weapon slot **and** none in the bag → `STARTER_LOADOUT`; otherwise keep everything. Always re-emits `loadout:changed` (weapons clear their slots on `world:ready`), `grenade:countChanged`, `stim:countChanged`, `inventory:changed` (a pending announce is folded in here when a mission starts without a hub entry) |
| mission changes (loot, consumption, drops) | **not saved** until the mission ends: a reload mid-mission restores the last ship state |
| `game:complete` | keep everything (worn weapons return to the ship for the workbench) and `saveNow('complete')`; the `game:abort` the hub emits right after is ignored |
| `player:respawn` (Phase 2 death flow: hellpod re-drop after `PLAYER_RESPAWN_DELAY`) | `STARTER_LOADOUT` immediately; the mission continues, so rolled containers and `outcome` are kept |
| `game:over` (legacy mission failure; the Phase 2 flow no longer emits it) | `STARTER_LOADOUT` immediately |
| `game:abort` | after `game:complete` → keep; after `game:over` → already reset; otherwise (quit mid-mission, lobby lost, back to title) → `STARTER_LOADOUT` |
| every `applyStarter()` (the three rows above, `reset()`, the empty first hub entry) | **`saveNow('starter')`** right after the reset, so a reload can never resurrect a bag that was lost to death / abort |
| `pagehide` / `beforeunload` / `dispose` | `flush()` the pending debounced write |
| `game:newMission` | close windows, forget rolled containers |

Every write emits `inventory:loadoutSaved {reason}` (`starter` / `hub` / `complete`). The stash (`scav.stash`) is independent and never reset.

`STARTER_LOADOUT` = `{primary, primary2, secondary, bag, items: [{id, qty}]}`; ammo `qty` are rounds, added through `addUnits` (merge into stacks, then new stacks chunked by `stackMax`). A reset always emits `inventory:bagChanged` (dropped `[]`), `loadout:changed`, both count events, `inventory:quickSlotsChanged` (after `autoAssignQuickSlots`, see below) and `inventory:changed`.

## Quick-use wheel slots (Phase 2)

`quickSlots: (string | null)[]` of length `QUICK_SLOTS` (8) holds **bag item uids** by wheel direction (`QUICK_SLOT_DIRS`: 0 N, 1 NE, 2 E, 3 SE, 4 S, 5 SW, 6 W, 7 NW). Stacks stay in the grid; a slot only references them.

- `getQuickSlots()` resolves uids to the live `ItemInstance`s (null = empty). `getQuickSlotCount()` = equipped bag `def.bag.quickSlots`, else `BAG_DEFAULT_QUICK_SLOTS` (1), clamped to 8 (`bag_legendary_tac` defines 9). A bag with n quick slots unlocks the first n entries of **`QUICK_SLOT_UNLOCK_ORDER` = [0 N, 4 S, 2 E, 6 W, 1 NE, 3 SE, 5 SW, 7 NW]** (`isQuickSlotActive(index, count)` from `@/shared`) — not indices 0..n-1. Slots not unlocked are **locked**: they keep their assignment (visible, dimmed) but cannot be filled until a better bag is equipped. `inventory:quickSlotsChanged.active` stays the count.
- `setQuickSlot(index, uid | null)`: index in range; `uid` must be a bag item whose def category is in `QUICK_USABLE_CATEGORIES` (`grenade`, `stim`) and `isQuickSlotActive(index, getQuickSlotCount())`. A uid occupies one slot only — assigning it elsewhere moves it (the previous occupant of the target slot is simply unassigned). Clearing a locked slot is allowed. Returns true for a valid call even when nothing changed; emits `inventory:quickSlotsChanged {slots, active}` only on a change.
- `consumeItem(uid, qty = 1)` (weapons: stim injected / grenade thrown): removes up to `qty` from that exact bag stack, returns the count. At 0 → `inventory:itemRemoved`; then `stim:countChanged` / `grenade:countChanged` / `inventory:changed` as `consumeWhere` does. `consumeWhere` shares the 0-stack path.
- **Consistency**: `afterChange()` runs `syncQuickSlots()` — prune uids that are no longer in the bag (drop, move to a container, bag-shrink overflow, consumed) and emit when the signature (uids + quantities + active count) changed. So the HUD also gets an event when a slot's stack count changes or the bag swap changes `active`. When a stack **merges away** entirely (drag onto a same-def stack in the bag) or is **consumed to 0**, its slot is handed to the surviving / a sibling stack of the same def that has no slot of its own (`relinkQuickSlot`); otherwise the slot clears. Splits keep the slot on the source stack.
- **Starter policy** (`autoAssignQuickSlots`, on every starter reset incl. `player:respawn`): biggest grenade stack → slot 0 (N); biggest stim stack → slot 4 (S) — the first two unlocks, so both are usable with the common starter bag (2 slots). A locked / taken preferred slot falls back to `firstFreeQuickSlot` (first empty slot in unlock order; with no bag = 1 slot only the grenade is assigned). `world:ready` re-emits `inventory:quickSlotsChanged` even without a reset.
- **UI**: the bag panel shows a 3×3 compass rose under the grid (DOM order NW N NE / W centre E / SW S SE; the centre shows `F` + `active/8`). Cells carry their glyph (`QUICK_DIR_GLYPH`) hugging the edge of their direction; locked cells are dimmed with a padlock and `title="가방 등급이 낮아 잠김"`. Assigned bag tiles get a top-left direction badge (`.inv-tile-quick`).
  - Drag a stim / grenade from the bag onto a cell → `setQuickSlot` (usable cells glow amber during such a drag; hovering one lights green / blue = replaces / red = refused — locked cell, non-usable item, container item).
  - Drag a cell tile onto another cell → move; release it anywhere else (bag grid, backdrop, panel) → the slot clears and the item stays in the bag (never a world drop; the 버리기 zone stays hidden for cell drags).
  - Right-click a cell → `빠른 슬롯 해제` (+ `요청`); double-click a cell tile also clears. Right-click a stim / grenade in the bag now always opens the menu: `빠른 슬롯에 등록` (first free usable slot, `registerQuick`) or `빠른 슬롯 해제 (glyph)` when assigned. Double-click a bag stim / grenade with no crate open = 등록.
  - The panel refreshes with every `InventoryUI.refresh()` (system `afterChange` / `setQuickSlot`), covering `inventory:quickSlotsChanged` and `inventory:bagChanged`.

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
- `requestItem(uid, from)` — `chat:post { kind: 'request' }` with `탄약 요청: <name> (<AMMO_LABEL_KO[getEffectiveStats(inst).ammoType]>)` for weapons or `<def.name> 필요` otherwise.

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
`openCatalog(opts?)` (console `/items`; Phase 9 `opts.category` preselects the tab that holds that category — the 훈련장 무기 거치대 passes `'primary'`, and on an already-open catalog it just switches the tab) shows the `CatalogView` as the leftmost panel of the inventory window — the ship screen in the hub, the bag window on a mission (refused with a toast in menus). It opens the window itself when needed (blocker `'inventory'`, `inventory:opened {containerId: null}`) and emits `ui:catalogToggled {open}`; `closeCatalog()` hides only the panel (the `닫기` button), Esc / Tab close the whole window through `closeAll()` (which also closes the catalog). `isCatalogOpen` is the state.
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
`node scripts/smoke-inventory-p6.mjs` 63/63, 0 console errors: catalog open/blocker/event, 124 tiles = defs, tabs + 무기 filter, search `스팀`, real-mouse drags (tile → free bag cell = full 폐금속 stack, tile → stash, AR III → 주무기 II loaded), double press → bag, Esc closes all; `setStashSize(10, 30)` + event, shrink refused with an item in row 29 / accepted at 26, Tab screen 300 cells + scroll, save v2 `cols/rows`, size kept after reload; `countDefAll` 4+7, `consumeDefAll` short refusal / 9 = bag 0 + stash 2 / 0 no-op; `captureLoadout`, `applyLoadout` (stash SMG → 주무기 I, missing def empties 주무기 II + reported, null untouched, armor from stash, implant `dash`, displaced gear stowed, no-op outside the hub); `openBenchCraft('gun', 2)` title / blocker / event, craftable rows = `getRecipes`, 6 locked level-3 rows, repair list with the worn 주무기 I cost, ×0.8 ceil costs + discount chip, `수리` restores durability, gear bench without weapons, gadget bench without a repair list, `닫기` leaves bench mode, refused on a mission; catalog on a mission (no stash) + `closeCatalog` keeps the window. Regression: `smoke-quickslots` 45/45, `smoke-controls-hub` 60/60.

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
  "slots": { "primary": { "defId": "wpn_ar23", "qty": 1, "durability": 480, "ammoInMag": 30, "sockets": { "muzzle": { "defId": "att_suppressor", "qty": 1 } } }, "bag": { … }, "armor": { … } },
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
- `captureRaidState()` → `RaidInventoryState` = the loadout save (`captureLoadoutSave`: 5 slots + bag placements with durability / rounds / sockets + quick slots as bag indices) `+ raid: 1` and a `searched` flag on every bag entry whose instance has one. Opaque to game/ (raid session blob, training freeze).
- `applyRaidState(state)` → `sanitizeLoadoutSave` (false for null / wrong shape / version), cancels a running craft, `applyLoadoutSave` (slots, bag resize + placements, quick slots), restores the `searched` flags and announces like a restored save (`inventory:bagChanged`, `loadout:changed` / `equip:changed`, counts, `inventory:quickSlotsChanged`, `inventory:changed`, weight). Not saved to disk on a mission (the hub save policy is unchanged).

### Server profile documents
- After every stash write (`Stash.onSaved`) and every loadout write (`LoadoutStore.onSaved(reason, file)`, except reason `profile`) the file goes to `ctx.net.profile.set('stash' | 'loadout', file)` (net debounces the upload).
- `net:profileLoaded {profile}`: the **stash** document replaces the local stash (`Stash.loadFrom` → grid rebuilt, local file rewritten without echo, `inventory:stashChanged`); the **loadout** document replaces slots / bag / quick slots (`applyLoadoutSave` + announce, local file rewritten with reason `profile`) — only outside a raid (`!ctx.isRaidActive()`, mid-mission the raid blob is the truth); an empty loadout doc in the hub applies the starter. A key the server has never seen gets the current local state uploaded.
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
| 필드 제작 / 작업대 (`.inv-panel-craft`) | the bag's `제작` button, or `openBenchCraft(kind, level)` | **2026-09-07**: back to a **column of the window** (it was a modeless popup in Phase 8). `.inv-layout.is-craft` puts the recipe list leftmost — where 함선 창고 sits otherwise — and `.inv-col-right` stacks 가방 over 함선 창고 on the right; in a raid the row is 제작 · 장비 · 가방 + 퀵슬롯. `CraftPanel` keeps every renderer. `닫기` leaves the bench in bench mode, otherwise closes the column. Closing the window closes it too |
| 아이템 분해 (`.inv-modeless-disassemble`) | the item context menu's `분해` entry, or `InventoryRef`-level `openDisassemble(uid)` | centred; see below |

### 아이템 분해
The four `break_ammo_*` recipes are gone from the craft list (`getBenchRecipes()` filters `isDisassembleRecipe`, i.e.
any `break_*` id) — `getRecipes()` and `craft()` still know them, so nothing else changed about crafting.

- `disassembleRecipeFor(uid)` returns the `break_*` recipe whose **only** input is that item's def id (the ammo packs
  today), or null. The context menu adds a `분해` entry for any **bag** item with one (a crate / 창고 stack has to be
  taken into the bag first, because the recipe consumes from the bag) and `hasMenu` counts it, so even a 1-round stack
  opens the menu instead of quick-moving.
- The entry opens `DisassemblePanel`: `재료` (input chip, 보유/필요, dimmed + red when short) `→` `결과물` (output chip
  `×n`), the craft duration, and a `분해` button. The button runs `sys.craft(recipe.id)` (progress fill, a second click
  cancels, `분해 완료` / `분해할 수 없습니다` for 2.5 s) and the dialog closes itself when the source stack is gone.
- `ui:disassembleToggled {open, uid}` is emitted on both edges (`uid` is the item on close as well).

### 요구 아이템 칩 (`buildItemChip` / `renderItemCost` from `@/shared`)
Every material requirement this folder renders is now a **thumbnail with 보유/필요 at the bottom right**, dimmed with a
red 보유 number when short (`.is-short`) — text chips are gone:

- `ui/CraftPanel.ts` recipe rows (`.inv-craft-costs` inside `.inv-craft-inputs`; the duration stays a plain
  `.inv-craft-chip.is-time` sibling) and the bench **repair list** (`.inv-repair-cost`, `정비 완료` still text).
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
  `body:not(.soft-cursor-on)` 로 한정했다 (`inventory.css`).
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
