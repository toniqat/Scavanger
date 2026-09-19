/**
 * src/inventory/parts/Favorites.ts — **item favourites** (2026-09-12, E1, user's decision).
 *
 * The question answered: *is this item def a favourite, and when is that table saved and where does it come from.*
 *
 *  - The unit is the **item def (def id)** — every copy is marked. A def that is not owned can be turned on too.
 *  - **Per character · server-synced**: carried by the loadout document's `Loadout.LoadoutSave.fav` list. No new profile key.
 *  - It has **a different lifetime** from the kit (gear · bag), so `applyLoadoutSave` (the raid blob · range restore ·
 *    crew cards) never touches favourites — the blob owns the kit, not this list. The table is replaced in two places
 *    only: the boot file (`Lifecycle.restoreLoadoutSave`) and the server document (`ProfileDocs.applyProfileDocs`, raids too).
 *  - **Saving**: in the ship a loadout save is scheduled at once (`markDirty('favorite')`). Outside it (raid · range) a
 *    loadout write on the spot would put the carried kit on disk (a breach of the reset policy), so only `favoritesDirty`
 *    is raised and the next save (extraction `complete` · death `corpse` · failure `starter` · `hub:entered`) carries it.
 *  - **A server document never overwrites a local edit** (CLAUDE.md 2026-09-11): with a toggle not yet uploaded
 *    (`favoritesDirty`, or a save debounce running) the incoming list is not applied — that edit goes up shortly.
 *  - Display is `ui/GridView`'s module copy (`setFavoriteDefs`) — tile ribbon · sort · filter · salvage confirm all read it.
 */
import { ITEM_DEF_MAP } from '@/items';
import { sanitizeFavoriteList } from '../Loadout';
import { setFavoriteDefs } from '../ui/GridView';
import type { InventorySystem } from '../InventorySystem';

export function isFavorite(sys: InventorySystem, defId: string): boolean {
  return sys.favorites.has(defId);
}

/** Sorted copy (cached until the set changes). */
export function favoriteDefIds(sys: InventorySystem): readonly string[] {
  if (!sys.favoriteIdsCache) sys.favoriteIdsCache = Object.freeze([...sys.favorites].sort()) as string[];
  return sys.favoriteIdsCache;
}

/** What the loadout document carries (`LoadoutSave.fav`); undefined when there is nothing. */
export function captureFavorites(sys: InventorySystem): string[] | undefined {
  return sys.favorites.size > 0 ? [...sys.favorites].sort() : undefined;
}

/**
 * Turn a favourite on / off (`on` omitted = flip). Unknown def → false, nothing changes. Returns the new state; emits
 * `inventory:favoritesChanged` and schedules the save only when the state really changed.
 */
export function toggleFavorite(sys: InventorySystem, defId: string, on?: boolean): boolean {
  if (typeof defId !== 'string' || !ITEM_DEF_MAP.has(defId)) return false;
  const was = sys.favorites.has(defId);
  const next = on === undefined ? !was : !!on;
  if (next === was) return was;
  if (next) sys.favorites.add(defId); else sys.favorites.delete(defId);
  commit(sys, [defId]);
  persist(sys);
  return next;
}

/**
 * Replace the whole table with a saved list (boot file · server document). No save — the list came from storage.
 * `force` = the boot path, which runs before anything could have been edited.
 */
export function applySavedFavorites(sys: InventorySystem, raw: unknown, force = false): void {
  // a toggle that has not gone up yet is newer than any document that arrives now
  if (!force && (sys.favoritesDirty || sys.saveTimer !== null)) return;
  const next = new Set(sanitizeFavoriteList(raw) ?? []);
  const changed: string[] = [];
  for (const id of sys.favorites) if (!next.has(id)) changed.push(id);
  for (const id of next) if (!sys.favorites.has(id)) changed.push(id);
  if (changed.length === 0) return;
  sys.favorites = next;
  commit(sys, changed);
}

/** The loadout save went out (any reason) — its `fav` is on disk / on its way to the server. */
export function onLoadoutSaved(sys: InventorySystem): void {
  sys.favoritesDirty = false;
}

/** `hub:entered`: a toggle made outside the ship is written with the first save back in it. */
export function flushDeferred(sys: InventorySystem): void {
  if (sys.favoritesDirty && sys.ctx.isHubPhase()) sys.loadoutStore.markDirty('favorite');
}

function commit(sys: InventorySystem, changed: readonly string[]): void {
  sys.favoriteIdsCache = null;
  setFavoriteDefs(sys.favorites);
  for (const defId of changed) sys.ctx.bus.emit('inventory:favoritesChanged', { defId, favorite: sys.favorites.has(defId) });
}

function persist(sys: InventorySystem): void {
  sys.favoritesDirty = true;
  // outside the ship a loadout write would put the carried kit on disk mid-raid — the next save takes the list along
  if (sys.ctx.isHubPhase()) sys.loadoutStore.markDirty('favorite');
}
