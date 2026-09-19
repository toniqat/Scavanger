/**
 * src/inventory/parts/ShelfWanted.ts — **the 「not yet shelved in the library」 ribbon** (2026-09-13, the library series · user's decision, docs/DECISIONS.md 「2026-09-13 — 서재 시리즈 · 비디오게임」).
 *
 * The question it answers: *does this book · video · record tile get the same blue ribbon as a favourite.*
 *
 *  - housing owns the rule: `HousingRef.isShelfItemWanted(defId)` = a holder for that medium is **owned** (placed · in 가구 창고)
 *    and no item of the same def is **shelved in any holder**. Here is only where that query is hung on tile drawing (`ui/GridView`).
 *  - On a housing with no such query (mid parallel work · a skeleton) it is always false — the ribbon simply does not show and nothing breaks.
 *  - The answer is cached once per def (`GridView.isShelfWantedDef`). On events that may change the library · a holder the cache is
 *    cleared (`bumpShelfWanted`) and an open window is repainted exactly once. The event list is generous — clearing costs only one query per def at the next draw.
 *  - It is **entirely separate** from the favourite table: sort order · the 「즐겨찾기」 filter · the salvage / sell confirm · the container glow · saving all read real favourites only.
 */
import type { GameContext, GameEvents } from '@/shared';
import { bumpShelfWanted, setShelfWantedSource } from '../ui/GridView';
import type { InventorySystem } from '../InventorySystem';

/** Events that may have changed the ribbon's answer — `housing:libraryChanged` is the real one, the rest are a safety net for an old · parallel housing. */
const BUMP_EVENTS: readonly (keyof GameEvents)[] = [
  'housing:libraryChanged', 'housing:loaded', 'housing:shelfChanged', 'housing:booksChanged',
  'housing:furniturePlaced', 'housing:furnitureRecovered', 'net:profileLoaded',
];

/** Asks housing — false when there is no query. */
export function isShelfWanted(ctx: GameContext, defId: string): boolean {
  const h = ctx.housing;
  if (!h || typeof h.isShelfItemWanted !== 'function') return false;
  try { return h.isShelfItemWanted(defId) === true; } catch { return false; }
}

/** Hangs the source and subscribes to the events. The returned functions go into `offs`. */
export function installShelfWanted(sys: InventorySystem): Array<() => void> {
  const ctx = sys.ctx;
  setShelfWantedSource((defId) => isShelfWanted(ctx, defId));
  let queued = false;
  const onChange = (): void => {
    bumpShelfWanted();
    if (queued) return;
    queued = true;
    // even when several events arrive at once (furniture recovered → the library re-summed) the window is repainted exactly once
    queueMicrotask(() => { queued = false; if (sys._open) sys.ui?.onShelfWantedChanged(); });
  };
  const offs = BUMP_EVENTS.map((name) => ctx.bus.on(name, onChange as never));
  offs.push(() => setShelfWantedSource(null));
  return offs;
}
