/**
 * src/inventory/parts/AutoQuick.ts — **consumables auto-seated on a quick slot** (2026-09-14, user's decision).
 *
 * One question answered: *does this stack that just reached my hands sit on a free wheel slot.*
 *
 * **A game-wide rule, not a tutorial-only one.** A picked-up consumable (a heal · a grenade · a gadget the wheel takes)
 * of a type the quick slots accept goes onto a slot **when one is free**. With the same def already on the wheel it
 * eats no new slot and **merges into that one** (merging has always been `QuickSlots.mergeIntoQuick`'s job inside
 * `tryAddItem`, so it is not repeated here — this file reads 「what is left over」 only). No free slot = the bag, as usual.
 *
 * **It keeps 「the quick slots are not the bag grid」 (2026-09-09) intact** — putting something on the wheel is a **move**,
 * not a copy. So this file holds no code that creates a stack and none that copies a quantity: a stack that is in a grid
 * is moved by `InventorySystem.setQuickSlot` (which already holds the container source's `searched` · `emitTransfer` ·
 * the displaced-stack rule), and only a stack that is in no grid yet (`tryAddItem`) is seated on a slot by the caller.
 * Weight · `countWhere` · `consumeWhere` · `stripForCorpse` · the raid blob reading the wheel too is unchanged.
 *
 * **It hooks in at exactly three 「came into my hands from outside」 points** (one set of rules here, never copied per path):
 *
 *   ① `InventorySystem.tryAddItem` — the single door for every item entering from **outside** the inventory. World pickups
 *      (E · the remote confirm `pickups/PickupSystem.addToBag`) · gathering (`world/Gather`) · supply ammo
 *      (`weapons/parts/Slots`) · deployable recovery (`gadgets/parts/Deploy`) · console grants all pass through it. Shop ·
 *      craft · harvest · tutorial grants use `tryAddItemAnywhere` (bag → ship stash) instead — 「picked it up」, not 「given」.
 *   ② `DropResolver.takeOne` — a container's (crate · corpse) **「모두 가져가기」**. Nobody chooses the destination.
 *   ③ the container branch of `DropResolver.activateImpl` — a **double-click** on a crate · corpse tile. Again nobody picks
 *      the destination, and it is the same gesture a bag tile's double-click already is (`ui/InventoryUI.tileHandlers`).
 *
 * **Deliberately not caught**: a drag (a person picked the slot) and the right-click menu's 「빠른 이동 (가방)」 (the label
 * promises a destination). Intercepting those two would make the screen lie — the menu has its own 「빠른 슬롯에 등록」 entry.
 *
 * It does not collide with 2026-09-10's **「what is found in a crate always goes to the bag first」**: what that decision
 * blocks is *the gun · armor in hand silently changing* (equipment slots), and a wheel slot fills only while it is empty.
 */
import type { ItemDef, ItemInstance } from '@/shared';
import { firstFreeQuickSlot, isQuickUsable } from '../QuickSlots';
import type { InventorySystem } from '../InventorySystem';

/**
 * The **free wheel slot** this stack would be seated on automatically, or -1.
 *
 *  - is it a type the wheel takes (`QUICK_USABLE_CATEGORIES`)
 *  - an unsearched container stack can go nowhere (`searched === false` — the same rule in a grid and on the wheel)
 *  - a stack already on the wheel does not move its own slot
 *  - **with the same def already on the wheel no new slot is eaten** — that holds even when this stack is what was
 *    left over because the other one sits at `stackMax`. One def taking two wheel slots breaks what the wheel means
 *    (one slot = one def), and the leftover units become a bag stack as before (2026-09-09's merge-overflow contract).
 *  - lock · bag grade are known in exactly one place, `firstFreeQuickSlot(slots, active)`
 */
export function autoQuickIndexFor(sys: InventorySystem, item: ItemInstance, def: ItemDef): number {
  if (!isQuickUsable(def)) return -1;
  if (item.searched === false) return -1;
  if (sys.quickIndexOf(item.uid) >= 0) return -1;
  for (const slot of sys.quickSlots) if (slot && slot.defId === item.defId) return -1;
  return firstFreeQuickSlot(sys.quickSlots, sys.getQuickSlotCount());
}

/**
 * ②③ **Moves** a stack in a container grid onto a free wheel slot. True when it moved.
 *
 * The move itself is `setQuickSlot` — the container source's `searched` mark · `emitTransfer` (= `inventory:itemAdded`) ·
 * the displaced-stack rule (none here, the slot is free) · `afterQuickChange` are all already in that function. The
 * caller sits inside multiplayer's `guardedTake` (= after the host confirmed), so the authority check is unchanged.
 */
export function takeIntoQuick(sys: InventorySystem, item: ItemInstance, def: ItemDef): boolean {
  const index = autoQuickIndexFor(sys, item, def);
  return index >= 0 && sys.setQuickSlot(index, item.uid);
}
