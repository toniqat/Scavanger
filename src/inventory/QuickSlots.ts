import type { ItemDef, ItemInstance } from '@/shared';
import { QUICK_SLOTS, QUICK_SLOT_UNLOCK_ORDER, QUICK_USABLE_CATEGORIES, isQuickSlotActive } from '@/shared';

/**
 * Pure bookkeeping for the quick-use wheel (Phase 2): eight slots indexed by wheel direction
 * (`QUICK_SLOT_DIRS`: 0 N … 4 S … 7 NW) holding bag item uids. No events, no grid access — the
 * system resolves uids to live `ItemInstance`s and decides when to emit.
 */
export type QuickSlotUids = (string | null)[];

/** Wheel slot auto-assigned to grenades / stims by the starter kit (`autoAssignQuickSlots`). */
export const QUICK_AUTO_GRENADE = 0; // N
export const QUICK_AUTO_STIM = 4;    // S

export const createQuickSlots = (): QuickSlotUids => new Array<string | null>(QUICK_SLOTS).fill(null);

export const isQuickUsable = (def: ItemDef | undefined): boolean => !!def && QUICK_USABLE_CATEGORIES.includes(def.category);

export const isQuickIndex = (index: number): boolean => Number.isInteger(index) && index >= 0 && index < QUICK_SLOTS;

/** Slot index holding `uid`, or -1. */
export function quickSlotOf(slots: QuickSlotUids, uid: string): number {
  return slots.indexOf(uid);
}

/**
 * First empty *usable* slot for a bag with `active` quick slots, in unlock order (`QUICK_SLOT_UNLOCK_ORDER`:
 * N, S, E, W, then the diagonals), or -1 when every usable slot is taken.
 */
export function firstFreeQuickSlot(slots: QuickSlotUids, active: number): number {
  for (const i of QUICK_SLOT_UNLOCK_ORDER) {
    if (!isQuickSlotActive(i, active)) break;
    if (slots[i] === null) return i;
  }
  return -1;
}

/**
 * Put `uid` into `index` (null clears it). A uid can occupy only one slot, so an existing assignment moves.
 * Returns true when anything changed. Index range is the caller's job (`isQuickIndex`).
 */
export function assignQuickSlot(slots: QuickSlotUids, index: number, uid: string | null): boolean {
  if (slots[index] === uid) return false;
  if (uid !== null) {
    const prev = slots.indexOf(uid);
    if (prev >= 0) slots[prev] = null;
  }
  slots[index] = uid;
  return true;
}

/** Clear whichever slot holds `uid`. Returns the cleared index or -1. */
export function clearQuickSlotOf(slots: QuickSlotUids, uid: string): number {
  const i = slots.indexOf(uid);
  if (i >= 0) slots[i] = null;
  return i;
}

/**
 * Hand the slot of `fromUid` (a stack that is disappearing: merged away / consumed to 0) to `toUid`, unless
 * `toUid` already has a slot of its own. Returns true when a slot moved.
 */
export function relinkQuickSlot(slots: QuickSlotUids, fromUid: string, toUid: string): boolean {
  const i = slots.indexOf(fromUid);
  if (i < 0 || fromUid === toUid || slots.includes(toUid)) return false;
  slots[i] = toUid;
  return true;
}

/** Null out every slot whose uid fails `has` (item left the bag). Returns true when anything changed. */
export function pruneQuickSlots(slots: QuickSlotUids, has: (uid: string) => boolean): boolean {
  let changed = false;
  for (let i = 0; i < slots.length; i++) {
    const uid = slots[i];
    if (uid !== null && !has(uid)) { slots[i] = null; changed = true; }
  }
  return changed;
}

/**
 * Starter-kit policy: the biggest grenade stack → slot 0 (N), the biggest stim stack → slot 4 (S) — the first two
 * entries of `QUICK_SLOT_UNLOCK_ORDER`, so both are usable with the common starter bag (2 slots). A preferred slot
 * that is locked falls back to the first free usable one. Existing assignments are wiped first.
 */
export function autoAssignQuickSlots(
  slots: QuickSlotUids,
  items: readonly ItemInstance[],
  getDef: (defId: string) => ItemDef | undefined,
  active: number,
): void {
  slots.fill(null);
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
    const index = isQuickSlotActive(preferred, active) && slots[preferred] === null ? preferred : firstFreeQuickSlot(slots, active);
    if (index >= 0) assignQuickSlot(slots, index, item.uid);
  };
  place(pick('grenade'), QUICK_AUTO_GRENADE);
  place(pick('stim'), QUICK_AUTO_STIM);
}

/** Cheap change-detection key: uids, quantities and the usable count (the HUD re-renders on any of them). */
export function quickSlotsSignature(slots: QuickSlotUids, resolve: (uid: string) => ItemInstance | null, active: number): string {
  let s = `${active}`;
  for (const uid of slots) {
    const it = uid === null ? null : resolve(uid);
    s += `|${it ? `${it.uid}:${it.qty}` : ''}`;
  }
  return s;
}
