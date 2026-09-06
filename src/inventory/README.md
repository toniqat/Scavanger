# src/inventory — Diablo-2 grid inventory (`ctx.inventory`)

`InventorySystem` owns the player's bag grid (size = equipped bag), the four equipment slots (주무기 I / 주무기 II / 보조무기 / 가방), the eight **quick-use wheel slots** and the currently open loot container. It publishes `ctx.inventory` (itself) and `ctx.loot` (`LootService` from `@/items`). Weapon package (2026-09-05): 3 weapon slots, bag-sized grids, sockets, ammo v2, unload, repair, and a reset policy that lets worn weapons survive a completed mission. Phase 2 (2026-09-06): quick-use slots (`QuickSlots.ts`, rose panel, `consumeItem`) and the `player:respawn` starter reset.

| File | Purpose |
|---|---|
| `Grid.ts` | Pure occupancy grid: `canPlace/blockersAt/place/remove/moveTo/rotate/findFreeSlot/autoPlace/mergeIntoStacks/mergeInto/canAbsorb/totalValue`, plus **`resize(cols, rows, priority?)`** (in-bounds items keep their cells, the rest are `autoPlace`d largest-first, what does not fit is returned; `priority` entries are placed first, at their hint cell when possible), **`snapshot()` / `restore()`** for all-or-nothing attempts. `cols`/`rows` are getters (mutated only by resize/restore). Rotation swaps the footprint; `rotate()` tries in place, then nearby offsets. `version` counter drives UI diffing |
| `Sockets.ts` | Pure socket bookkeeping on `ItemInstance.sockets`: `socketOf(def)`, `socketContent`, `attachedItems`, `filledSocketCount`, `setSocket` (returns the previous attachment), `clearSocket`, `clearAllSockets`, `findSocketed(weapons, uid)`. No events, no compatibility checks (those live in the system via `LootRef.canAttach`) |
| `QuickSlots.ts` | Pure quick-use wheel bookkeeping on a `QuickSlotUids` array (length `QUICK_SLOTS`, index = wheel direction, values = bag item uids): `createQuickSlots`, `isQuickUsable(def)` (`QUICK_USABLE_CATEGORIES`), `isQuickIndex`, `quickSlotOf`, `firstFreeQuickSlot(slots, active)`, `assignQuickSlot` (one slot per uid — moves), `clearQuickSlotOf`, `relinkQuickSlot(from, to)` (slot follows a surviving stack), `pruneQuickSlots(has)` (item left the bag), `autoAssignQuickSlots` (starter policy), `quickSlotsSignature` (change detection). No events, no grid access |
| `Stash.ts` | **함선 창고** (2026-09-06): `STASH_COLS × STASH_ROWS` (10×24) `Grid` by default, persisted in localStorage `scav.stash` (positions + `durability` / `ammoInMag` / nested `sockets`; uids are re-minted on load, unknown defs dropped with a warning, overlapping cells auto-placed). **Phase 6**: the save (v2) also carries `cols` / `rows` (v1 files migrate to the default size; a corrupt size is ignored, cap 40×200) and `resize(cols, rows)` grows the grid in place / refuses a shrink while any item would fall outside. `markDirty()` debounces a save 350 ms after a change, `flush()` on pagehide / dispose. Survives missions, deaths and reloads — the bag / loadout keep their own reset policy. |
| `Container.ts` | `Container` (6×4 grid + world position + `tier` + optional `title`; `fill(items)` auto-places largest-first, overflow dropped with a `console.warn`) and `ContainerStore` cache keyed by container id: `getOrCreate(id, tier, …)` rolls `ctx.loot.rollCrate(tier, Random(seed ^ hash(id)))` on first open; `getOrCreateWithItems(id, items, position, title?)` places caller-supplied contents (corpses; `tier` 0, `title` default `CONTAINER_DEFAULT_TITLE` = `컨테이너`) on first open and ignores `items` for a known id. The container grid never resizes |
| `InventorySystem.ts` | `GameSystem` + `InventoryRef`. Event wiring, Tab/Escape/R/X handling, auto-close (> 6 m from crate, death, phase change), reset policy, and all mutations used by the UI: `drop`, `previewDrop`, `dropPartial`, `previewPartial`, `previewAttach`, `attachFrom`, `quickMove`, `activate` (double-click), `equipTargetFor`, `rotateItem`, `takeAll`, `registerQuick`, `quickIndexOf`, plus the contract methods (`dropItem`, `splitItem`, `getBagSize`, `findItem`, `updateItem`, `attachToWeapon`, `detachAllSockets`, `unloadWeapon`, `repairWeapon`, `equip`, `getQuickSlots`, `setQuickSlot`, `getQuickSlotCount`, `consumeItem`, `openContainerItems`) and the quick-chat `requestItem`. **Phase 6** (see the sections below): `openCatalog / closeCatalog / isCatalogOpen` + `catalogQty / previewCatalog / dropFromCatalog / takeFromCatalog`, `getStashSize / setStashSize`, `countDefAll / consumeDefAll`, `captureLoadout / applyLoadout`, `openBenchCraft / getBench / closeBench / getBenchRecipes / benchRepairRows / benchRepairAll`, `getRecipes(station, bench?, level?)`, `craftCostMul / craftCost`. `locate(uid)` finds an item in bag → container → slots. Exports the UI vocabulary (`GridId`, `SlotId` = `LoadoutSlot`, `LOADOUT_SLOTS`, `WEAPON_SLOT_IDS`, `slotAccepts`, `ItemLocation`, `DropTarget` incl. `{kind:'weapon'}` / `{kind:'quick', index}`, `OpResult`, `DropPreview`, `BagSize`, `ActiveBench`, `BenchRecipeRow`, `BenchRepairRow`) |
| `ui/InventoryUI.ts` | DOM layout under `ctx.uiRoot`: container panel (left), bag (center, width follows the grid columns; **quick-slot rose** under the grid), equipment column (right: 4 slots), hint bar, world-drop zone. Drag & drop with live ghost + valid/invalid/swap/merge highlight, **attachment → weapon tile drag** (socket target lit green/red via `previewAttach`), **stim/grenade → wheel cell drag**, cell → cell / cell → out drags, Shift/Ctrl partial drags, R to rotate, right-click quick action / context menu, middle-click request, X drop, double-click equip/move/register, "모두 가져가기", tooltip, shake on refusal, `audio:play` sfx. **Phase 6**: hosts the `CatalogView` (leftmost panel) and drives **catalog drags** (`DragState.catalog`: a fresh instance per press, targets = equipment slots + active grids only, `previewCatalog` / `dropFromCatalog`, no world drop, no wheel; double press within 400 ms = `takeFromCatalog`), `setCatalog(open)`, `setCraftOpen(open)` for bench mode |
| `ui/ContextMenu.ts` | Cursor-anchored right-click menu (`MenuEntry[]`), closes on selection / outside pointerdown / Escape / hide |
| `ui/SplitDialog.ts` | "수량 지정" modal: number input + slider over 1..qty-1, 확인/취소, Enter/Escape |
| `ui/GridView.ts` | Renders one `Grid`: cell layer (rebuilt by `syncDims` whenever the grid's cols/rows change — bag swap, stash resize), uid-diffed absolutely positioned tiles, highlight rect, `markSplitSource()` for partial drags, `setSocketTarget()`, `setQuickBadges(uid → glyph)` (forces a re-render when the set changes); `buildTileContent(el, item, def, w, h, stats?)` shared with slots, wheel cells, catalog tiles and the ghost — weapons get five socket pips + a durability bar; `addQuickBadge(el, glyph)` adds the wheel-direction badge |
| `ui/CatalogView.ts` | **무한 상자** panel (Phase 6): category tabs (`CATALOG_TABS`, derived from `ItemCategory`: 전체 / 무기 / 탄약 / 부착물 / 가방 / 방탄복 / 가젯 / 소모품 / 재료 / 약초 / 가구 — a tab without defs is dropped), search box (Korean substring on the name, plus the id; key events stop at the field so the game's `Input` never sees them), one uniform 2×2 tile per `ItemDef` from `ctx.loot.getAllItemDefs()` with a caption, a scrolling grid, `닫기`. Tiles are built once and re-appended on filter; `CatalogHandlers` hand press / hover / close to the window. `tileEl(defId)`, `shake`, `setTab`, `setQuery`, `visibleCount` for tests |
| `ui/CraftPanel.ts` | Hold-to-craft panel (`제작` button, or a 작업실 bench). **Bench mode** (Phase 6, `sys.getBench()`): eyebrow `WORKSHOP BENCH`, title `WORKBENCH_LABEL_KO[kind] Lv.n`, rows from `sys.getBenchRecipes()` (locked rows `is-bench-locked` with a `작업대 Lv.n 필요` tag and no button), material chips from `sys.craftCost` (workshop discount, `작업실 할인 −n %` chip), a `닫기` button (`sys.closeBench`) and the **repair list** (`sys.benchRepairRows`: slot / durability bar / cost text `폐금속 ×n · 합금 판 ×n` or `정비 완료` / `수리` button → `sys.repair`, `모두 수리` → `sys.benchRepairAll`, 3 s result line). Same cost readout as `hub/ui/WorkbenchMenu.ts` (copied, not imported) |
| `ui/Tooltip.ts` | Hover card (name, category · rarity, description; weapons: 종류 / 등급 / 대미지 / 탄창 / 장전 / 연사 / 반동 / 정조준 시간 / 재장전 / 발사 모드 / 탄종 / 유효 사거리 / 배율 / 내구도 from `ctx.loot.getEffectiveStats` + the five sockets; attachments: socket, 호환, effects; bags: grid + 퀵슬롯; qty, size, value) |
| `ui/labels.ts` | Cell metrics (`CELL=54`, `GAP=2`, `STEP`), `SLOT_LABEL` / `SLOT_KEY`, `QUICK_DIR_GLYPH` (▲ ◥ ► ◢ ▼ ◣ ◄ ◤), `QUICK_ROSE_ORDER` (3×3 DOM order), Korean UI strings (hints, menu, quick panel, split dialog, stat labels), formatters (`fmtDeg`, `fmtMul`, `gradeLabel`), `DURABILITY_LOW` (0.3) |
| `inventory.css` | Styles (imported by `InventoryUI.ts`); scoped under `.inv-*` (`.inv-quick*` for the wheel panel, `.inv-tile-quick` badge, `.inv-cat-*` catalog, `.inv-repair-*` bench repair list), no dependency on `src/ui/styles` |
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

## Reset policy

| Event | Effect |
|---|---|
| first `hub:entered` with a completely empty inventory | `STARTER_LOADOUT` (so the workbench has something to show) |
| `world:ready` | no weapon in any weapon slot **and** none in the bag → `STARTER_LOADOUT`; otherwise keep everything. Always re-emits `loadout:changed` (weapons clear their slots on `world:ready`), `grenade:countChanged`, `stim:countChanged`, `inventory:changed` |
| `game:complete` | keep everything (worn weapons return to the ship for the workbench); the `game:abort` the hub emits right after is ignored |
| `player:respawn` (Phase 2 death flow: hellpod re-drop after `PLAYER_RESPAWN_DELAY`) | `STARTER_LOADOUT` immediately; the mission continues, so rolled containers and `outcome` are kept |
| `game:over` (legacy mission failure; the Phase 2 flow no longer emits it) | `STARTER_LOADOUT` immediately |
| `game:abort` | after `game:complete` → keep; after `game:over` → already reset; otherwise (quit mid-mission, lobby lost, back to title) → `STARTER_LOADOUT` |
| `game:newMission` | close windows, forget rolled containers |

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

- `crate:open {crateId, tier, position}` → `openContainer()`; `crate:looted` emitted once when a container's grid first becomes empty.
- **Phase 4 — caller-supplied containers**: `openContainerItems(containerId, items, position, title?)` (contract) opens the same loot window for contents the caller rolled (corpses: `ctx.loot.rollCorpse`). First open for an id places `items` largest-first on the fixed 6×4 grid (overflow dropped silently with a `console.warn`); a later open of a known id shows what is left and ignores `items`. The loot window shows `title` (default `컨테이너`) instead of the tier label, eyebrow `REMAINS` for `corpse:*` ids / `CONTAINER` otherwise. Everything else is shared with crates: take-all, drag, `inventory:opened {containerId}`, auto-close > 6 m, and `crate:looted {crateId: containerId}` when emptied (enemies remove the corpse on `crate:looted {crateId: 'corpse:<id>'}`). Contents are per-client, like crates.
- Opening adds `'inventory'` to `ctx.uiBlockers` (before exiting pointer lock, so GameFlow's lock-loss pause does not fire); closing removes it. `inventory:opened/closed` emitted. `closeAll()` then re-requests pointer lock (deferred one microtask) if still in a gameplay phase with no blockers and the player is alive.
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
screen tabs **인벤토리 · 캐릭터 · 기업(비활성)** on top (`.scr-tabs` from `ui/styles/base.css`; 캐릭터 → `openCharacter()` = close without relock + `ui:statsToggled`),
then **함선 창고** (`GridId 'stash'`, `GridView('stash')` inside a scrolling `.inv-stash-scroll`) · **장비** (5 slots; two columns ≥ 1600 px wide) with the
**전술 임플란트 slot** under them (`ctx.implants.equipped`; click → inline picker of `getAllDefs()` cards, click = `setEquipped`, clicking the equipped card = unequip;
locked with a toast during a raid) · **가방** with the quick-use rose to its right (`.inv-bag-body` row).
- Moves: drag between stash / bag / slots, right-click quick action (stash ↔ bag; equipped item → 가방으로 이동 / 창고로 이동 via `moveToStash`), double-click equips.
  `locKind('stash')` is `'container'` (HUD counts treat the stash like a crate), so bag → stash emits `inventory:itemRemoved` and stash → bag `inventory:itemAdded`.
- **수리**: right-click on a worn weapon / armor the player owns shows `수리 (폐금속 n · 합금 판 n)` (`repairInfo(uid)` → `ctx.loot.getRepairCost`; armor is free) → `repair(uid)`.
  Slot meta shows the durability; `.is-worn` tints it. The terminal's 정비 tab is gone; the workbench menu remains for weapons.
- **No world drops in the ship**: `dropItem` returns false, the X key / drop zone / 버리기 entries are off; overflow from a bag swap or socket swap goes to the stash
  (`throwToWorld` → `stash.autoPlace`, toast `… → 함선 창고`) and only drops when the stash is full too.
- The hint bar hides in the hub; on a mission its R / X labels follow `Keys.ROTATE_ITEM` / `Keys.DROP_ITEM` (`input:bindingsChanged`), as do the slot keycaps (`slotKeyLabel`)
  and the quick-rose key (`Keys.QUICK`). The escape handler closes the implant picker / menu / dialog first.
- Events: `inventory:stashChanged {count}` after any change of the stash grid.
- Smoke: `npm run smoke:controls` covers the ship screen (layout, stash move + reload persistence, picker, repair menu, tabs).

## Phase 6 (2026-09-06): 무한 상자 · 창고 크기 · 프리셋 · 작업대 제작

### 무한 상자 (`/items` cheat catalog)
`openCatalog()` (console `/items`) shows the `CatalogView` as the leftmost panel of the inventory window — the ship screen in the hub, the bag window on a mission (refused with a toast in menus). It opens the window itself when needed (blocker `'inventory'`, `inventory:opened {containerId: null}`) and emits `ui:catalogToggled {open}`; `closeCatalog()` hides only the panel (the `닫기` button), Esc / Tab close the whole window through `closeAll()` (which also closes the catalog). `isCatalogOpen` is the state.
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
