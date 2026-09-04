# src/inventory — Diablo-2 grid inventory (`ctx.inventory`)

`InventorySystem` owns the player's 10×6 bag, the primary/secondary equipment slots and the currently open loot container. It publishes `ctx.inventory` (itself) and `ctx.loot` (`LootService` from `@/items`).

| File | Purpose |
|---|---|
| `Grid.ts` | Pure occupancy grid: `canPlace/blockersAt/place/remove/moveTo/rotate/findFreeSlot/autoPlace/mergeIntoStacks/mergeInto/canAbsorb/totalValue`. Rotation swaps the footprint; `rotate()` tries in place, then nearby offsets. `version` counter drives UI diffing |
| `Container.ts` | `Container` (6×4 grid + world position + tier) and `ContainerStore` cache keyed by crate id; first open rolls `ctx.loot.rollCrate(tier, Random(seed ^ hash(id)))` and auto-places largest-first |
| `InventorySystem.ts` | `GameSystem` + `InventoryRef`. Event wiring, Tab/Escape/R handling, auto-close (> 6 m from crate, death, phase change), and all mutations used by the UI: `drop`, `previewDrop`, `quickMove`, `activate` (double-click), `rotateItem`, `takeAll`. Exports the UI vocabulary types (`GridId`, `SlotId`, `ItemLocation`, `DropTarget`, `OpResult`, `DropPreview`) |
| `ui/InventoryUI.ts` | DOM layout under `ctx.uiRoot`: container panel (left), bag (center), equipment column (right), hint bar. Drag & drop with live ghost + valid/invalid/swap/merge highlight, R to rotate (dragging or hovered), right-click quick move, double-click equip/move, "모두 가져가기", tooltip, shake on refusal, `audio:play` sfx |
| `ui/GridView.ts` | Renders one `Grid`: cell layer, uid-diffed absolutely positioned tiles, highlight rect; `buildTileContent()` shared with slots and the ghost |
| `ui/Tooltip.ts` | Hover card (name, category · rarity, description, weapon stats from `WeaponDef`, qty, size, value) |
| `ui/labels.ts` | Cell metrics (`CELL=54`, `GAP=2`, `STEP`), Korean UI strings, formatters |
| `inventory.css` | Styles (imported by `InventoryUI.ts`); scoped under `.inv-*`, no dependency on `src/ui/styles` |
| `__selftest__.ts` | `runInventorySelfTest()` — console.assert checks for grid/rotation/stack/loot determinism (dev use) |
| `index.ts` | Barrel — import via `@/inventory` |

## Behaviour contract

- `world:ready` → `reset()` to `STARTER_LOADOUT`, emits `loadout:changed`, `grenade:countChanged`, `stim:countChanged`, `inventory:changed`.
- `crate:open {crateId, tier, position}` → `openContainer()`; `crate:looted` emitted once when a container's grid first becomes empty.
- Equipped weapons live in `Loadout`, not in grid cells. `loadout:changed` fires on every equip/unequip/swap.
- Opening adds `'inventory'` to `ctx.uiBlockers` (before exiting pointer lock, so GameFlow's lock-loss pause does not fire); closing removes it. `inventory:opened/closed` emitted. `closeAll()` then re-requests pointer lock (deferred one microtask) if still in a gameplay phase with no blockers and the player is alive — the Tab/Esc/click that closed the window supplies the user activation.
- Tab (`Keys.INVENTORY`) toggles the bag during gameplay phases (ignored while another blocker is active). Escape closes via a capture-phase keydown listener so the menu system does not also see the key.
- `inventory:itemAdded` when an item enters player possession (bag or slot) from a container or `tryAddItem`; `inventory:itemRemoved` when it leaves (to container / consumed to 0). `inventory:full` when a bag add is refused.
- `countWhere/consumeWhere/getTotalValue/getAllItems` cover the bag only (not equipped weapons).
