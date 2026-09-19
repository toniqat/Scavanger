/**
 * src/inventory/parts/SocketDetach.ts — **pulling one socket out** (2026-09-14, dragging an attachment out of the pinned tooltip).
 *
 * The mirror of `attachFromImpl` (`parts/DropResolver`). Dragging a socket thumbnail of a pinned weapon tooltip
 * (`ui/TipPin`) onto a bag · ship stash · pouch cell or the drop area arrives here. The rules:
 *  - The weapon must be **somewhere its sockets may be touched** — `canSocketAt` (bag · equipment slot · ship stash). A
 *    weapon inside a container · a corpse belongs to somebody else (the pinned tooltip only shows a hover card).
 *  - A grid cell has to take it **exactly at the cell that was pointed at**. Blocked, it is refused and the attachment stays
 *    in its socket — no item is lost. The ship stash only in the ship, a pouch only while `PouchDef.accepts` takes it.
 *  - The ground (`world`) **only in a raid** — the ship has no ground (dropping there goes to the stash, and a drag-out can point at a stash cell instead).
 *  - The event order is the same as attaching: `inventory:socketChanged {attachment: null}` → `afterSocketChange` (a smaller
 *    magazine spills its rounds into the bag, `inventory:itemUpdated`) → `afterChange` (`inventory:changed` · saving). A move
 *    that changes ownership, stash ↔ bag for instance, has `emitTransfer` raise the acquired / removed events.
 */
import type { ItemDef, ItemInstance, SocketSlot } from '@/shared';
import { ITEM_DEF_MAP, isWeaponItemDef } from '@/items';
import { clearSocket, setSocket } from '../Sockets';
import { canSocketAt } from './DropResolver';
import type { DetachTarget, ItemLocation, OpResult } from '../model';
import type { InventorySystem } from '../InventorySystem';

interface ResolvedSocket {
  weapon: ItemInstance;
  from: ItemLocation;
  att: ItemInstance;
  def: ItemDef;
}

function resolveSocket(sys: InventorySystem, weaponUid: string, socket: SocketSlot): ResolvedSocket | null {
  const w = sys.locate(weaponUid);
  if (!w || !canSocketAt(sys, w.from) || !isWeaponItemDef(ITEM_DEF_MAP.get(w.item.defId))) return null;
  const att = w.item.sockets?.[socket];
  const def = att ? ITEM_DEF_MAP.get(att.defId) : undefined;
  if (!att || !def) return null;
  return { weapon: w.item, from: w.from, att, def };
}

/** Is this weapon somewhere its sockets can be dragged out (bag · equipment slot · ship stash)? Decides whether the pinned tooltip draws its thumbnails as draggable. */
export function canDetachSockets(sys: InventorySystem, weaponUid: string): boolean {
  const w = sys.locate(weaponUid);
  return !!w && canSocketAt(sys, w.from) && isWeaponItemDef(ITEM_DEF_MAP.get(w.item.defId));
}

/** Is dropping on the ground allowed right now — only in a raid (a gameplay phase). The ship has no ground. */
export function worldDetachAllowed(sys: InventorySystem): boolean {
  return !sys.ctx.isHubPhase() && sys.ctx.isGameplayPhase();
}

/** Would `detachSocket` succeed right now — the cell highlight colour (green / red) during the drag reads this. Changes nothing. */
export function previewDetach(sys: InventorySystem, weaponUid: string, socket: SocketSlot, target: DetachTarget): 'ok' | 'bad' {
  const r = resolveSocket(sys, weaponUid, socket);
  if (!r) return 'bad';
  if (target.kind === 'world') return worldDetachAllowed(sys) ? 'ok' : 'bad';
  if (target.grid === 'stash' && !sys.ctx.isHubPhase()) return 'bad';
  if (target.grid === 'pouch' && !sys.pouchAccepts(r.def)) return 'bad';
  const grid = sys.getGrid(target.grid);
  if (!grid) return 'bad';
  return grid.canPlace(r.att, target.x, target.y, target.rotated) ? 'ok' : 'bad';
}

/**
 * Pulls the attachment in weapon `weaponUid`'s `socket` out to `target`. Blocked, it is `'fail'` and nothing changes.
 */
export function detachSocket(sys: InventorySystem, weaponUid: string, socket: SocketSlot, target: DetachTarget): OpResult {
  if (previewDetach(sys, weaponUid, socket, target) !== 'ok') return 'fail';
  const r = resolveSocket(sys, weaponUid, socket);
  if (!r) return 'fail';
  const { weapon, from, att, def } = r;
  clearSocket(weapon, socket);
  if (target.kind === 'grid') {
    const grid = sys.getGrid(target.grid);
    if (!grid || !grid.place(att, target.x, target.y, target.rotated)) {
      setSocket(weapon, socket, att);   // out of step with the preview or not, the attachment goes back into the socket — never lost
      return 'fail';
    }
    sys.emitTransfer(att, def, from, { kind: 'grid', grid: target.grid });
  } else {
    sys.throwToWorld(att, sys.locKind(from) === 'player');
  }
  // the grid holding the weapon has to bump its version for that tile's socket pips to be redrawn (`GridView` gates on version)
  const stash = sys.getGrid('stash');
  if (sys.bag.has(weapon.uid)) sys.bag.version++;
  else if (stash?.has(weapon.uid)) stash.version++;
  sys.ctx.bus.emit('inventory:socketChanged', { weapon, socket, attachment: null });
  sys.afterSocketChange(weapon);
  sys.afterChange();
  return 'ok';
}
