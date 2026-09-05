# src/inventory — Diablo-2 grid inventory, gear, weight, quick bar, crafting (`ctx.inventory`)

`InventorySystem` owns the player's bag grid, the **four** equipment slots (`primary` / `secondary` / `armor` / `backpack`), the quick-use bar, the weight budget, gear durability, field crafting and the currently open loot container. It publishes `ctx.inventory` (itself) and `ctx.loot` (`LootService` from `@/items`).

| File | Purpose |
|---|---|
| `Grid.ts` | Pure occupancy grid: `canPlace/blockersAt/place/remove/moveTo/rotate/findFreeSlot/autoPlace/mergeIntoStacks/mergeInto/canAbsorb/totalValue`. Rotation swaps the footprint; `rotate()` tries in place, then nearby offsets. `version` counter drives UI diffing |
| `Gear.ts` | Pure helpers shared by the system and the UI: `makeWeightInfo` / `weightStateFor` / `sumWeight` / `DEFAULT_CARRY_CAPACITY`, `armorOf` / `backpackOf` / `quickSlotCount`, `durabilityInfo` / `durabilityRatio`, `SEARCH_TIME_BY_RARITY` / `searchTimeFor`, and `gearMultipliers(derived)` which supplies safe defaults when `ctx.progression` is not published yet |
| `Container.ts` | `Container` (6×4 grid + world position + tier + **crate search state**) and `ContainerStore` cache keyed by crate id; first open rolls `ctx.loot.rollCrate(tier, Random(seed ^ hash(id)))`, auto-places largest-first and starts the per-item reveal timers |
| `InventorySystem.ts` | `GameSystem` + `InventoryRef`. Event wiring, Tab/Escape/R/X and quick-slot keys, auto-close, and all mutations used by the UI. Exports the UI vocabulary types (`GridId`, `SlotId` = `EquipSlot`, `ItemLocation`, `DropTarget`, `OpResult`, `DropPreview`) and `EQUIP_SLOTS` |
| `ui/InventoryUI.ts` | DOM layout under `ctx.uiRoot`: craft panel + container panel (left), bag grid + quick-use bar + weight bar (center), four equipment slots (right), hint bar, world-drop zone. Drag & drop with live ghost and ok/bad/swap/merge highlight, quick-slot drop targets, R rotate, right-click menu, X drop, double-click equip, tooltip, shake on refusal, `audio:play` sfx |
| `ui/QuickBarView.ts` | Quick-use strip: N cells with the number key, item icon and qty. Drag onto a cell to assign, left-click to fire, right-click to clear. `indexAt(x, y)` powers drag targeting |
| `ui/CraftPanel.ts` | 필드 제작 panel — station-filtered recipe rows with per-ingredient have/need chips, the computed hold time, and **hold-to-craft** buttons with a progress fill (releasing cancels) |
| `ui/ContextMenu.ts` | Cursor-anchored right-click menu (`MenuEntry[]`), closes on selection / outside pointerdown / Escape / hide |
| `ui/SplitDialog.ts` | "수량 지정" modal: number input + slider over 1..qty-1, 확인/취소, Enter/Escape |
| `ui/GridView.ts` | Renders one `Grid`: cell layer, uid-diffed tiles, highlight rect, `markSplitSource()`, and `setStateLookup()` for per-item extras (crate-search mask, durability bar). `buildTileContent(el, item, def, w, h, opts)` shared with slots and the ghost |
| `ui/Tooltip.ts` | Hover card: name, category · rarity, description, **durability bar**, weapon / armor / backpack stats, qty, size, **weight**, value |
| `ui/labels.ts` | Cell metrics (`CELL=54`, `GAP=2`, `STEP`), Korean UI strings, formatters (`fmtValue`, `fmtKg`, `fmtSeconds`, `weightLabel`) |
| `inventory.css` | Styles (imported by `InventoryUI.ts`); scoped under `.inv-*`, no dependency on `src/ui/styles` |
| `__selftest__.ts` | `runInventorySelfTest()` — console.assert checks for grid/rotation/stack/split-merge/loot determinism **plus** weights, armor/backpack tables, durability, recipes and crate search (dev use; run from the browser console) |
| `index.ts` | Barrel — import via `@/inventory` |

## Behaviour contract

- `world:ready` → `reset()` to `STARTER_LOADOUT` (now including `armor_2` + `bp_2`), emits `equip:changed` ×4, `loadout:changed`, `quickbar:changed`, `inventory:weightChanged`, `grenade:countChanged`, `stim:countChanged`, `inventory:changed`.
- `crate:open {crateId, tier, position}` → `openContainer()`; `crate:looted` once a container's grid first becomes empty.
- Equipped gear lives in the loadout, not in grid cells. **`loadout:changed` still carries only `primary`/`secondary`** (the shared payload was not widened); armor and backpack changes are announced with `equip:changed {slot, item}`, which fires for all four slots.
- Tab opens the bag during gameplay **and in the ship hub** (`isGameplayPhase() || isHubPhase()`) so gear, repairs and ship crafting are reachable. Opening adds `'inventory'` to `ctx.uiBlockers` before exiting pointer lock; closing removes it and re-requests the lock one microtask later.
- `countWhere/consumeWhere/consumeDef/getTotalValue/getAllItems` cover the bag only (not equipped gear).

## Equipment slots

`getEquipped(slot)` / `equip(slot, item)` for `primary | secondary | armor | backpack`.

- `equip(slot, item)` accepts an item that is in the bag, in the open container, or held by nobody (starter grants). The displaced item goes back to the drag source cell → the source grid → the bag → the floor.
- `equip(slot, null)` unequips into the bag, or drops it when there is no room.
- Double-click / `활성화` equips any of the four categories; the context menu shows `장착` for gear.
- Dropping an equipped item (`dropItem`) clears the slot and emits `equip:changed {item: null}`.

## Backpack → bag grid

The equipped backpack defines the grid: `BackpackDef.cols × rows`, falling back to `BASE_BAG_COLS × BASE_BAG_ROWS` (6×4) with no backpack. Swapping backpacks **rebuilds the grid**:

1. the new backpack is lifted out of its grid, the old one is remembered,
2. a fresh `Grid` is built at the new size,
3. the old backpack gets the first placement attempt, then every carried item largest-first,
4. anything that no longer fits is thrown into the world exactly like a manual drop (`inventory:itemRemoved` + `inventory:itemDropped`) with a `ui:notify` warning.

`InventoryUI.markGridChanged()` re-binds the view to the new `Grid` instance on the next refresh.

## Weight

`getWeight(): WeightInfo` — bag contents + all four equipped items.

- capacity = `derived.carryCapacity` (default `WEIGHT_BASE_CAPACITY + WEIGHT_PER_STRENGTH × STAT_BASE` = 39 kg when `ctx.progression` is null) + the backpack's `capacityBonus`.
- states from the shared ratios: `normal` < 70 % · `light` 조금 무거움 ≥ 70 % · `heavy` 무거움 ≥ 90 % · `over` 과적 ≥ 100 %.
- `moveMul` / `staminaRegenMul` are filled in from the shared constants; the 운반 skill (`derived.carryReliefFactor`) cancels part of the `light` stamina penalty only.
- `inventory:weightChanged` fires whenever weight, capacity or state changes (0.005 kg epsilon); `inventory:overloaded` fires when the state first reaches `heavy` / `over`.
- **Applying** the multipliers to movement and stamina is `src/player`'s job — this folder only reports.

## Quick-use bar

`getQuickSlots()` / `setQuickSlot(index, item)` / `useQuickSlot(index)`; slot count = `BackpackDef.quickSlots` (4, 8 on the 전술 가방, 2 with no backpack), capped by `QUICK_SLOT_KEYS.length`.

- Slots hold a **reference** (uid) to a bag item — the item never leaves the grid, and a slot resolves to `null` once the item is gone.
- `pruneQuick()` drops stale uids and auto-fills empty slots with unassigned `quickUsable` items, so the bar works with zero setup. `quickbar:changed` fires when the resolved contents change.
- Keys `3`–`0` (`QUICK_SLOT_KEYS`) fire slots while `ctx.isGameplayActive()` and the window is closed.
- Assign by dragging a bag item onto a cell (`DropTarget {kind:'quick'}`), by the `빠른 사용에 등록` context entry, or clear with right-click / `빠른 사용에서 해제`.
- Use routing: **stim** → `consumeDef` + `player.heal(healAmount × derived.healPowerMul)` + `player:stimUsed`; **gadget** → `ctx.gadgets.use(gadgetId, underhand)` (which consumes the item itself), refused with a notify when `ctx.gadgets` is null; **grenade / ammo** → only `quickbar:used {index, item}` is emitted, since `src/weapons` owns throwing and resupply. The over/under-hand flag is mirrored from `gadget:throwModeChanged` (owned by `src/gadgets`).

## Durability

`getDurability(uid)` / `damageDurability(uid, amount)` / `repair(uid)`; `getRepairables()` lists every worn item (bag + equipped) for the ship repair bench.

- `LootService.createItem` seeds `ItemInstance.durability` from `ItemDef.durabilityMax`; crate loot arrives at 55–100 %.
- Wear emits `durability:changed {uid, defId, durability, max}`; hitting 0 emits `durability:broken` + a danger notify + `audio:play gear_broken`. A broken weapon / plate keeps its instance — `weapons` halves the fire rate and `player` reads 0 DR.
- `repair(uid)` refuses while `ctx.isRaidActive()` (ship only), restores to full and emits `repair:completed` (progression raises 장비 관리 from it).
- Tiles, equipment slots, the drag ghost and the tooltip all show a durability bar (green → amber under 25 % → red when broken).

## Field crafting

`getRecipes(station)` / `canCraft(recipeId)` / `craft(recipeId)` / `cancelCraft()` / `craftProgress()` / `craftDuration(recipeId)` / `currentStation()`.

- Station: `field` during a raid, `ship` otherwise; `field` recipes are also craftable on the ship.
- Recipes are additionally gated by `ctx.progression?.getSkill(recipe.skill) ?? 0 >= recipe.skillRequired`.
- `craft()` returns a promise; the hold runs on the system's `update(dt)` (so it pauses with the game) for `recipe.duration / (craftSpeedMul × useSpeedMul)`, clamped to a ×0.2 minimum speed. `craft:started` → `craft:completed {recipeId, item}` or `craft:failed {reason: 'missing' | 'space' | 'cancelled'}`.
- Inputs are consumed only at completion; output beyond one stack becomes extra stacks (or drops when the bag is full).
- The `제작` button in the bag header toggles the panel and emits `ui:craftToggled`.

## Crate search (감정)

Crate contents are unreadable when the window opens and reveal one by one.

- `Container.beginSearch()` gives every item a timer from `searchTimeFor(def, derived.searchSpeedMul)` — `SEARCH_TIME_BY_RARITY` (0.35 s common → 3.0 s legendary) × a small bulk factor for multi-cell items, divided by the 감정 skill multiplier.
- While hidden a tile shows `?` / `???` with a scanning sweep, and `findItem` returns null for it, so it cannot be dragged, right-clicked, rotated, taken or included in `모두 가져가기`.
- The panel eyebrow reads `감정 중… n` until the crate is fully identified; a reopened crate stays revealed.

## Drop / split / request

**Gesture scheme** (hint bar: `R 회전 · 우클릭 빠른 이동/메뉴 · Shift+드래그 절반 · Ctrl+드래그 하나 · X 버리기 · 휠클릭 요청`):

| Gesture | Effect |
|---|---|
| Right-click on a stack, a quick-usable item, or repairable gear in the ship | Context menu |
| Right-click on anything else | Quick action directly (container ↔ bag, slot → bag) |
| **Shift + right-click** | Always the context menu |
| Shift / Ctrl + drag a stack | Drags **half** / **one** unit |
| Partial drag → free cell / same-def stack / elsewhere | New stack · merge capped by `stackMax` · cancel |
| Drag onto an equipment slot | Equip (backpack swaps rebuild the grid) |
| Drag onto a quick-use cell | Assign the slot (the item stays in the bag) |
| Drag released over the backdrop or the `버리기` zone | World drop of the dragged qty |
| X (hovered or dragged item) | Drop whole item; **Shift+X** one unit; **Ctrl+X** half |
| Middle-click on any item / slot | `chat:post` request |

Context menu order: quick action (`장착` / `가방으로 이동` / `상자로 이동`) → `빠른 사용에 등록` / `해제` → `수리 (함선)` → split entries → `탄약 요청` / `요청` → `버리기` (+ `하나 버리기`).

**System API / events**
- `dropItem(uid, qty?)` — searches bag, open container and all four slots; hidden container items are refused. Emits `inventory:itemRemoved`, `equip:changed` (slot items), `loadout:changed` (weapon slots) and `inventory:itemDropped {item, position, velocity}` with `position = eye − 0.3 m up + 0.4 m forward`, `velocity = forward × 3.5 + up 2.0`. `pickups/` spawns and syncs the world object; inventory does no networking.
- `splitItem(uid, qty)` — stackables only, `1 ≤ qty ≤ item.qty − 1`; emits `inventory:itemSplit`.
- `consumeDef(defId, qty)` — exact all-or-nothing removal (used by `ctx.gadgets.use`).
- `requestItem(uid, from)` — `chat:post {kind: 'request'}`.

## Verification

- `npx tsc --noEmit` → 0 errors in `src/items` and `src/inventory`.
- `runInventorySelfTest()` — all checks pass (grid/rotation/stacks/split/loot determinism, item weights, armor DR vs `ARMOR_DR_BY_TIER`, backpack grid monotonicity, quick-slot counts, weight states + 운반 relief, durability lifecycle, every recipe's ids, crate search timing).
- Headless system smoke (Node + a tiny DOM shim, 73 checks): starter gear, capacity 39 + 7, backpack swaps 9×5 → 12×6 → 10×6 (8 quick slots) → 8×4 with overflow dropped → 6×4 bare pockets, quick-slot assign/refuse/fire (stim heals, gadget delegates to `ctx.gadgets.use`, missing ref refuses), durability wear → break → repair refused in a raid → repaired in the ship, craft progress / completion / cancel / missing inputs, crate search blocking `findItem` and `takeAll` until revealed, armor equip swap.
