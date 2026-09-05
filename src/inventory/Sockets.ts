import type { ItemDef, ItemInstance, SocketSlot } from '@/shared';
import { SOCKET_SLOTS } from '@/shared';

/**
 * Pure socket bookkeeping on `ItemInstance.sockets` (no events, no grids). `InventorySystem` wraps these with
 * compatibility checks (`LootRef.canAttach`), bag placement of displaced attachments and the bus events.
 */

export type DefLookup = (defId: string) => ItemDef | undefined;

/** Socket an attachment def wants, or null when `def` is not an attachment. */
export function socketOf(def: ItemDef | undefined): SocketSlot | null {
  return def?.attachment?.socket ?? null;
}

/** Attachment currently in `socket` of `weapon` (undefined when empty). */
export function socketContent(weapon: ItemInstance, socket: SocketSlot): ItemInstance | undefined {
  return weapon.sockets?.[socket];
}

/** Attached items in `SOCKET_SLOTS` order. */
export function attachedItems(weapon: ItemInstance): ItemInstance[] {
  const out: ItemInstance[] = [];
  if (!weapon.sockets) return out;
  for (const s of SOCKET_SLOTS) {
    const a = weapon.sockets[s];
    if (a) out.push(a);
  }
  return out;
}

export function filledSocketCount(weapon: ItemInstance): number {
  return attachedItems(weapon).length;
}

/**
 * Put `attachment` into `socket`, returning whatever was there before (undefined when the socket was empty).
 * Does not validate compatibility — callers check `LootRef.canAttach` first.
 */
export function setSocket(weapon: ItemInstance, socket: SocketSlot, attachment: ItemInstance): ItemInstance | undefined {
  const prev = weapon.sockets?.[socket];
  if (!weapon.sockets) weapon.sockets = {};
  weapon.sockets[socket] = attachment;
  return prev;
}

/** Empty one socket; returns the removed attachment (undefined when it was already empty). */
export function clearSocket(weapon: ItemInstance, socket: SocketSlot): ItemInstance | undefined {
  const prev = weapon.sockets?.[socket];
  if (!prev || !weapon.sockets) return undefined;
  delete weapon.sockets[socket];
  if (Object.keys(weapon.sockets).length === 0) delete weapon.sockets;
  return prev;
}

/** Empty every socket; returns the removed attachments in socket order. */
export function clearAllSockets(weapon: ItemInstance): ItemInstance[] {
  const removed = attachedItems(weapon);
  delete weapon.sockets;
  return removed;
}

/** Find the weapon (and socket) holding attachment `uid` among `weapons`, or null. */
export function findSocketed(weapons: Iterable<ItemInstance>, uid: string): { weapon: ItemInstance; socket: SocketSlot; item: ItemInstance } | null {
  for (const weapon of weapons) {
    if (!weapon.sockets) continue;
    for (const s of SOCKET_SLOTS) {
      const a = weapon.sockets[s];
      if (a?.uid === uid) return { weapon, socket: s, item: a };
    }
  }
  return null;
}
