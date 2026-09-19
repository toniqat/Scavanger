/**
 * src/inventory/parts/SocketRules.ts — **attachments that no longer fit are detached and given back at load** (2026-09-14
 * gun balance, user's decision "detach and give back at load").
 *
 * Once each weapon class fixed which sockets it accepts (`sockets` in `data/weapons.csv` → `LootRef.canAttach`), attachments
 * in old saves such as a shotgun stock · a DMR grip fell outside the rules. They are already left out of the stats
 * (`items/WeaponStats.computeWeaponStats` skips them), but instead of leaving them hanging on the weapon they are detached
 * where the save is read and returned to a grid. **No item disappears** — with no cell for it, it stays on the weapon (no effect) and is retried at the next load.
 *
 *   - The loadout (local file · server document) — `'stash'`: ship stash → bag → left on the weapon. If anything moved, **the
 *     caller marks the loadout dirty too** (saving only the stash sends the same attachment to the stash once more at the next load — both go up in one `scheduleSaves`).
 *   - The raid session blob — `'bag'`: bag → left on the weapon. Sending it to the ship stash mid-raid would be storage that
 *     survives death, so the stash is not used. The blob is rewritten by game/'s periodic save.
 *   - The stash document is handled inside the stash by `Stash.load`, through the same `Serialize.detachForbiddenSockets`.
 */
import type { ItemDef, ItemInstance } from '@/shared';
import { ITEM_DEF_MAP } from '@/items';
import { LOADOUT_SLOTS } from '../model';
import { detachForbiddenSockets } from '../Serialize';
import type { InventorySystem } from '../InventorySystem';

/**
 * Detach every attachment a weapon in the loadout slots / bag / pouch no longer accepts and find it a cell (see the file header).
 * Returns how many left their weapon (0 = nothing changed). Marks the stash dirty when it took one; the loadout save is the caller's.
 */
export function returnForbiddenAttachments(sys: InventorySystem, to: 'stash' | 'bag'): number {
  const getDef = (id: string): ItemDef | undefined => ITEM_DEF_MAP.get(id);
  const weapons: ItemInstance[] = [];
  for (const s of LOADOUT_SLOTS) { const it = sys.loadout[s]; if (it?.sockets) weapons.push(it); }
  for (const p of sys.bag.items()) if (p.item.sockets) weapons.push(p.item);
  for (const p of sys.pouch.items()) if (p.item.sockets) weapons.push(p.item);
  let moved = 0;
  let toStash = 0;
  for (const weapon of weapons) {
    for (const { socket, item } of detachForbiddenSockets(weapon, getDef, sys.loot)) {
      if (to === 'stash' && sys.stash.grid.autoPlace(item)) { moved++; toStash++; continue; }
      if (sys.bag.autoPlace(item)) { moved++; continue; }
      (weapon.sockets ??= {})[socket] = item;
      console.warn(`[Loadout] no room for '${item.defId}' taken off '${weapon.defId}' — left on the weapon (no effect)`);
    }
  }
  if (moved > 0) console.info(`[Loadout] ${moved} attachment(s) no longer fit their weapon — returned to the ${to === 'stash' ? '함선 창고 / 가방' : '가방'}`);
  if (toStash > 0) sys.stash.markDirty();
  return moved;
}
