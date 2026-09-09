import type { ItemDef, ItemInstance } from '@/shared';
import { QUICK_SLOTS, QUICK_SLOT_UNLOCK_ORDER, QUICK_USABLE_CATEGORIES, isQuickSlotActive } from '@/shared';

/**
 * Pure bookkeeping for the quick-use wheel: eight slots indexed by wheel direction (`QUICK_SLOT_DIRS`: 0 N … 4 S …
 * 7 NW), each holding the **`ItemInstance` itself** (2026-09-09, 사용자 결정 — the wheel is its own container, "another
 * bag space": a stack on the wheel is *not* in the bag grid any more). No events, no grid access — the system moves
 * stacks between the bag grid and this array and decides when to emit.
 *
 * Before 2026-09-09 the array held bag item **uids** (`QuickSlotUids`) and the stacks stayed in the grid; the
 * relink / prune helpers of that model are gone with it.
 */
export type QuickSlotItems = (ItemInstance | null)[];

/** Wheel slot auto-assigned to grenades / stims by the starter kit (`pickStarterQuick`). */
export const QUICK_AUTO_GRENADE = 0; // N
export const QUICK_AUTO_STIM = 4;    // S

export const createQuickSlots = (): QuickSlotItems => new Array<ItemInstance | null>(QUICK_SLOTS).fill(null);

export const isQuickUsable = (def: ItemDef | undefined): boolean => !!def && QUICK_USABLE_CATEGORIES.includes(def.category);

export const isQuickIndex = (index: number): boolean => Number.isInteger(index) && index >= 0 && index < QUICK_SLOTS;

/** Slot index holding the stack with `uid`, or -1. */
export function quickSlotOf(slots: QuickSlotItems, uid: string): number {
  return slots.findIndex((it) => it !== null && it.uid === uid);
}

/**
 * First empty *usable* slot for a bag with `active` quick slots, in unlock order (`QUICK_SLOT_UNLOCK_ORDER`:
 * N, S, E, W, then the diagonals), or -1 when every usable slot is taken.
 */
export function firstFreeQuickSlot(slots: QuickSlotItems, active: number): number {
  for (const i of QUICK_SLOT_UNLOCK_ORDER) {
    if (!isQuickSlotActive(i, active)) break;
    if (slots[i] === null) return i;
  }
  return -1;
}

/**
 * Stacks sitting in slots the bag has **not** unlocked (`index` outside the first `active` of the unlock order).
 * The system returns them to the bag on a bag swap / load — a locked slot never keeps an item (2026-09-09).
 */
export function lockedQuickItems(slots: QuickSlotItems, active: number): { index: number; item: ItemInstance }[] {
  const out: { index: number; item: ItemInstance }[] = [];
  slots.forEach((item, index) => { if (item && !isQuickSlotActive(index, active)) out.push({ index, item }); });
  return out;
}

/**
 * Merge `item.qty` into wheel stacks of the same def (like `Grid.mergeIntoStacks`). Mutates `item.qty` and the wheel
 * stacks; returns the leftover qty (0 → fully absorbed). A pickup / craft tops the wheel up before it lands in the bag.
 */
export function mergeIntoQuick(slots: QuickSlotItems, item: ItemInstance, getDef: (defId: string) => ItemDef | undefined): number {
  const def = getDef(item.defId);
  if (!def || def.stackMax <= 1) return item.qty;
  for (const q of slots) {
    if (item.qty <= 0) break;
    if (!q || q.defId !== item.defId || q.uid === item.uid) continue;
    const room = def.stackMax - q.qty;
    if (room <= 0) continue;
    const moved = Math.min(room, item.qty);
    q.qty += moved;
    item.qty -= moved;
  }
  return item.qty;
}

/**
 * Starter-kit policy: the biggest grenade stack → slot 0 (N), the biggest stim stack → slot 4 (S) — the first two
 * entries of `QUICK_SLOT_UNLOCK_ORDER`, so both are usable with the common starter bag (2 slots). A preferred slot
 * that is locked falls back to the first free usable one. Returns the picks (the caller moves them out of the bag);
 * `slots` is only read for occupancy.
 */
export function pickStarterQuick(
  slots: QuickSlotItems,
  items: readonly ItemInstance[],
  getDef: (defId: string) => ItemDef | undefined,
  active: number,
): { index: number; item: ItemInstance }[] {
  const taken = slots.map((s) => s !== null);
  const out: { index: number; item: ItemInstance }[] = [];
  const pick = (category: string): ItemInstance | null => {
    let best: ItemInstance | null = null;
    for (const it of items) {
      if (getDef(it.defId)?.category !== category) continue;
      if (!best || it.qty > best.qty) best = it;
    }
    return best;
  };
  const place = (item: ItemInstance | null, preferred: number): void => {
    if (!item) return;
    let index = isQuickSlotActive(preferred, active) && !taken[preferred] ? preferred : -1;
    if (index < 0) {
      for (const i of QUICK_SLOT_UNLOCK_ORDER) {
        if (!isQuickSlotActive(i, active)) break;
        if (!taken[i]) { index = i; break; }
      }
    }
    if (index < 0) return;
    taken[index] = true;
    out.push({ index, item });
  };
  place(pick('grenade'), QUICK_AUTO_GRENADE);
  place(pick('stim'), QUICK_AUTO_STIM);
  return out;
}

/** Cheap change-detection key: uids, quantities and the usable count (the HUD re-renders on any of them). */
export function quickSlotsSignature(slots: QuickSlotItems, active: number): string {
  let s = `${active}`;
  for (const it of slots) s += `|${it ? `${it.uid}:${it.qty}` : ''}`;
  return s;
}
