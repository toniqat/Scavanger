# src/inventory — Diablo-2 grid inventory (`ctx.inventory`)

`InventorySystem` owns the player's 10×6 bag, the primary/secondary equipment slots and the currently open loot container. It publishes `ctx.inventory` (itself) and `ctx.loot` (`LootService` from `@/items`).

| File | Purpose |
|---|---|
| `Grid.ts` | Pure occupancy grid: `canPlace/blockersAt/place/remove/moveTo/rotate/findFreeSlot/autoPlace/mergeIntoStacks/mergeInto/canAbsorb/totalValue`. Rotation swaps the footprint; `rotate()` tries in place, then nearby offsets. `version` counter drives UI diffing |
| `Container.ts` | `Container` (6×4 grid + world position + tier) and `ContainerStore` cache keyed by crate id; first open rolls `ctx.loot.rollCrate(tier, Random(seed ^ hash(id)))` and auto-places largest-first |
| `InventorySystem.ts` | `GameSystem` + `InventoryRef`. Event wiring, Tab/Escape/R/X handling, auto-close (> 6 m from crate, death, phase change), and all mutations used by the UI: `drop`, `previewDrop`, `dropPartial`, `previewPartial`, `quickMove`, `activate` (double-click), `rotateItem`, `takeAll`, plus the contract methods `dropItem`, `splitItem` and the quick-chat `requestItem`. `locate(uid)` finds an item in bag → container → slots. Exports the UI vocabulary types (`GridId`, `SlotId`, `ItemLocation`, `DropTarget`, `OpResult`, `DropPreview`) |
| `ui/InventoryUI.ts` | DOM layout under `ctx.uiRoot`: container panel (left), bag (center), equipment column (right), hint bar, world-drop zone. Drag & drop with live ghost + valid/invalid/swap/merge highlight, Shift/Ctrl partial drags, R to rotate, right-click quick action / context menu, middle-click request, X drop, double-click equip/move, "모두 가져가기", tooltip, shake on refusal, `audio:play` sfx |
| `ui/ContextMenu.ts` | Cursor-anchored right-click menu (`MenuEntry[]`), closes on selection / outside pointerdown / Escape / hide |
| `ui/SplitDialog.ts` | "수량 지정" modal: number input + slider over 1..qty-1, 확인/취소, Enter/Escape |
| `ui/GridView.ts` | Renders one `Grid`: cell layer, uid-diffed absolutely positioned tiles, highlight rect, `markSplitSource()` for partial drags; `buildTileContent()` shared with slots and the ghost |
| `ui/Tooltip.ts` | Hover card (name, category · rarity, description, weapon stats from `WeaponDef`, qty, size, value) |
| `ui/labels.ts` | Cell metrics (`CELL=54`, `GAP=2`, `STEP`), Korean UI strings (hints, menu, split dialog), formatters |
| `inventory.css` | Styles (imported by `InventoryUI.ts`); scoped under `.inv-*`, no dependency on `src/ui/styles` |
| `__selftest__.ts` | `runInventorySelfTest()` — console.assert checks for grid/rotation/stack/split-merge/loot determinism (dev use; exported via `@/inventory`, run from the browser console) |
| `index.ts` | Barrel — import via `@/inventory` |

## Behaviour contract

- `world:ready` → `reset()` to `STARTER_LOADOUT`, emits `loadout:changed`, `grenade:countChanged`, `stim:countChanged`, `inventory:changed`.
- `crate:open {crateId, tier, position}` → `openContainer()`; `crate:looted` emitted once when a container's grid first becomes empty.
- Equipped weapons live in `Loadout`, not in grid cells. `loadout:changed` fires on every equip/unequip/swap (and when an equipped weapon is dropped).
- Opening adds `'inventory'` to `ctx.uiBlockers` (before exiting pointer lock, so GameFlow's lock-loss pause does not fire); closing removes it. `inventory:opened/closed` emitted. `closeAll()` then re-requests pointer lock (deferred one microtask) if still in a gameplay phase with no blockers and the player is alive — the Tab/Esc/click that closed the window supplies the user activation.
- Tab (`Keys.INVENTORY`) toggles the bag during gameplay phases (ignored while another blocker is active). Escape closes via a capture-phase keydown listener so the menu system does not also see the key; when the context menu or split dialog is open, the first Escape only closes that overlay.
- `inventory:itemAdded` when an item enters player possession (bag or slot) from a container or `tryAddItem`; `inventory:itemRemoved` when it leaves (to container / consumed to 0 / dropped into the world). `inventory:full` when a bag add is refused.
- `countWhere/consumeWhere/getTotalValue/getAllItems` cover the bag only (not equipped weapons).

## Drop / split / request (2026-09-05)

**Gesture scheme** (hint bar: `R 회전 · 우클릭 빠른 이동/메뉴 · Shift+드래그 절반 · Ctrl+드래그 하나 · X 버리기 · 휠클릭 요청`):

| Gesture | Effect |
|---|---|
| Right-click on a stack with qty ≥ 2 | Context menu |
| Right-click on anything else (single item, weapon, slot) | Quick action directly (container ↔ bag, slot → bag) — unchanged |
| **Shift + right-click** | Always the context menu |
| Shift + drag a stack | Drags **half** (`floor(qty/2)`, min 1); ghost shows the carried qty, source badge shows the remainder |
| Ctrl + drag a stack | Drags **one** unit |
| Partial drag → free cell | New stack there (`inventory:itemSplit`) |
| Partial drag → same-def stack | Merge, capped by `stackMax` (leftover stays on the source) |
| Partial drag → source / invalid cell / slot | Cancel (no change) |
| Drag released over the dark backdrop or the `버리기` zone | World drop of the dragged qty (`dropItem`) |
| Drag released on a panel but not on a valid cell | Snap back + shake (unchanged) |
| X (hovered or dragged item) | Drop whole item; **Shift+X** one unit; **Ctrl+X** half |
| Middle-click on any item / slot | `chat:post` request (see below) |

Context menu entries, in order: quick action (`장착` / `가방으로 이동` / `상자로 이동`), then for stacks `절반 나누기` · `하나 나누기` (qty > 2) · `수량 지정…` (dialog), then `탄약 요청` (weapons) / `요청` (others), then `버리기` (+ `하나 버리기` for stacks).

**System API / events**
- `dropItem(uid, qty?)` — searches bag, open container and equipment slots. Partial qty creates a new `ItemInstance` via `ctx.loot.createItem` and decrements the source. Emits `inventory:itemRemoved` (player-owned items only, so HUD grenade/stim counts update), `loadout:changed` (slot items) and `inventory:itemDropped { item, position, velocity }` with `position = eye − 0.3 m up + 0.4 m forward`, `velocity = forward × 3.5 + up 2.0`. The `pickups/` folder spawns and syncs the world object; inventory does no networking. UI plays `ui_drop`.
- `splitItem(uid, qty)` — stackables only, `1 ≤ qty ≤ item.qty − 1`; the new stack is `place()`d at the first free slot of the same grid (never merged back). False + shake + `ui_error` when there is no room. Emits `inventory:itemSplit { source, created }`.
- `dropPartial / previewPartial(uid, from, qty, target)` — the partial-drag path (UI only); cross-grid partial moves emit `inventory:itemAdded/itemRemoved` for the moved qty.
- `requestItem(uid, from)` — `chat:post { kind: 'request' }` with `탄약 요청: <weapon.name> (<AMMO_LABEL_KO[ammoType]>)` for weapons (`getWeaponDef` from `@/items`; 소총탄 / 권총탄 / 산탄 / 에너지 셀) or `<def.name> 필요` otherwise. The `ui/` ChatLog displays/sends it.
