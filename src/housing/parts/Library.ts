/**
 * src/housing/parts/Library.ts — **the library bookshelf** (Phase 9) → **library media** (A-3e, 2026-09-12) → **library series** (2026-09-13).
 *
 * A book · disc · record is one volume of a **series** (`data/library_series.csv`), and the number of distinct volumes shelved in
 * holders decides that series' share (every volume = 100 %, else `SHELF_SERIES_VOLUME_SHARE` per volume). The effect lines (skill gain · derived ·
 * gym · cooking · raid XP · trust · recipe) are summed by `Rules.computeLibraryEffects`, and this file owns the cache and `housing:libraryChanged`.
 * A game disc (`'game'`) is shelved on the game disc stand and is an **effect-less storage medium** (played on the TV — `parts/VideoGame`).
 * Media belong to the **ship**, not the character, and the catalogue records only what **has been shelved at least once**. **The same def is shelved in one holder only** (user's decision).
 */
import type { BookSlotInfo, ItemDef, PlacedBook, PlacedFurniture, SkillId } from '@/shared';
import { BOOKS_PER_SHELF, FURNITURE_DEF_MAP, SKILL_IDS } from '@/shared';
import { bookWeightOf } from '../Rules';
import { isBookshelfDefId } from '../ShipState';
import { BOOKS_BLOCK_REASON, UNKNOWN_SHELF_ITEM_CELLS } from '../model';
import type { HousingSystem } from '../HousingSystem';
import { deliverItem, noRoomReason } from './Deliver';
/* A-3e (2026-09-12): library media */
import type { FurnitureDef, ShelfBonusInfo, ShelfMedium } from '@/shared';
import { SHELF_MEDIA, SHELF_MEDIUM_LABEL_KO, SHELF_SLOTS, isToggleInteraction, shelfItemOf, shelfMediumOfInteraction } from '@/shared';
import { SHELF_ID_PREFIX, shelfAuxPlaced, shelfItemWeightOf, shelfMediumOfDefId } from '../Rules';
import { SHELF_BLOCK_REASON, SHELF_OBJ_KO, shelfHolderName } from '../model';
/* 2026-09-13: library series */
import type { LibraryEffectKind, LibraryEffectsSummary, LibrarySourceInfo } from '@/shared';
import { EMPTY_LIBRARY_EFFECTS, LIBRARY_SERIES_DEFS, LIBRARY_SERIES_MAP, resolveItemAlias } from '@/shared';
import type { LibraryComputation, LibrarySeriesState } from '../Rules';
import {
  computeLibraryEffects, libraryEffectsSignature, librarySeriesOfItem, librarySourcesIn, shelfBonusFromLibrary, shelfHolderMediumOfItem,
} from '../Rules';

/* ── Shared: runtime sanitizing (old id → new id · unknown def · the same def twice) ─ */

/**
 * The save looks only at the id **shape** (`ShipState.sanitize` — the old-id swap and the duplicate refund happen there too); the first time `ctx.loot`
 * is around, this filters once more: an old id goes through `resolveItemAlias`, a def `ok` rejects is dropped, and a second copy of the same def is
 * pulled out and **returned to the ship stash** (normally none after sanitize — a console- or hand-edited state). The list is fixed in place.
 */
function pruneShelfList(sys: HousingSystem, list: PlacedBook[], ok: (def: ItemDef | undefined, entry: PlacedBook) => boolean, seen: Set<string>): void {
  const keep: PlacedBook[] = [];
  const extras: string[] = [];
  let changed = false;
  for (const e of list) {
    const id = resolveItemAlias(e.defId);
    if (id !== e.defId) { e.defId = id; changed = true; }
    if (!ok(sys.defOf(id), e)) { console.warn(`[housing] unknown shelf item '${id}' dropped from ${e.uid}`); changed = true; continue; }
    if (seen.has(id)) { extras.push(id); changed = true; continue; }
    seen.add(id);
    keep.push(e);
  }
  if (!changed) return;
  list.length = 0;
  list.push(...keep);
  if (!extras.length) return;
  const lost = sys.refundToStash(extras.map((defId) => ({ defId, qty: 1 })));
  if (lost > 0) console.warn(`[housing] ${lost} duplicate shelf items could not be returned to the stash`);
  sys.saveSoon();
}

/* ── The library bookshelf (Phase 9) ────────────────────────────────────── */
/**
 * The shelved books. The save only shape-checks def ids (`book_*`); the first time `ctx.loot` is around every id
 * that is not a real book any more is dropped here (a removed book def never breaks the shelf). 2026-09-13: old ids are
 * aliased and a second copy of the same def is returned to the stash (`pruneShelfList`).
 */
export function books(sys: HousingSystem): PlacedBook[] {
  if (!Array.isArray(sys.state.books)) sys.state.books = [];
  if (!sys.booksPruned && sys.ctx?.loot && typeof sys.ctx.loot.getItemDef === 'function') {
    sys.booksPruned = true;
    pruneShelfList(sys, sys.state.books, (def) => !!def?.book, new Set());
  }
  return sys.state.books;
}

export function bookDex(sys: HousingSystem): string[] {
  if (!Array.isArray(sys.state.bookDex)) sys.state.bookDex = [];
  return sys.state.bookDex;
}

/** The bookshelf behind `uid`, or null when it is not a bookshelf (or gone). */
export function shelfOf(sys: HousingSystem, uid: string): PlacedFurniture | null {
  const item = sys.getPlacedByUid(uid);
  return item && isBookshelfDefId(item.defId) ? item : null;
}

export function booksOf(sys: HousingSystem, uid: string): PlacedBook[] { return sys.books().filter((b) => b.uid === uid); }

export function bookAt(sys: HousingSystem, uid: string, slot: number): PlacedBook | null {
  return sys.books().find((b) => b.uid === uid && b.slot === slot) ?? null;
}

/** Drop every book of a shelf (used after they were moved to the stash, or by a recovered shelf). */
export function dropBooksOf(sys: HousingSystem, uid: string): void {
  const books = sys.books();
  for (let i = books.length - 1; i >= 0; i--) if (books[i].uid === uid) books.splice(i, 1);
}

export function booksChanged(sys: HousingSystem, uid: string, reason: string): void {
  sys.changed(reason);
  const count = sys.booksOf(uid).length;
  sys.ctx.bus.emit('housing:booksChanged', { uid, count });
  // A-3e: the shared media event fires for a bookshelf too (bookshelf consumers keep watching the old `housing:booksChanged`)
  sys.ctx.bus.emit('housing:shelfChanged', { uid, medium: 'book', count });
}

/** Book def with its `book` data, or null when `defId` is not a book. */
export function bookDef(sys: HousingSystem, defId: string): ItemDef | null {
  const def = sys.defOf(defId);
  return def && def.book ? def : null;
}

/** Free stash cells (cols × rows − occupied), −1 when inventory cannot tell. A cheap estimate for `recoverBlock`. */
export function freeStashCells(sys: HousingSystem): number {
  const inv = sys.ctx.inventory;
  if (!inv || typeof inv.getStashSize !== 'function' || typeof inv.getStashItems !== 'function') return -1;
  try {
    const size = inv.getStashSize();
    let used = 0;
    for (const it of inv.getStashItems()) {
      const def = sys.defOf(it.defId);
      used += def ? def.width * def.height : 1;
    }
    return size.cols * size.rows - used;
  } catch { return -1; }
}

/** `책을 먼저 빼세요` while the shelf holds books the stash cannot take (by free-cell estimate), else null. */
export function booksBlock(sys: HousingSystem, uid: string): string | null {
  const books = sys.booksOf(uid);
  if (!books.length) return null;
  const inv = sys.ctx.inventory;
  if (!inv || typeof inv.tryAddToStash !== 'function' || !sys.ctx.loot || typeof sys.ctx.loot.createItem !== 'function') return BOOKS_BLOCK_REASON;
  const free = sys.freeStashCells();
  if (free < 0) return null;                                   // unknown → let `recover` try for real
  let need = 0;
  for (const b of books) { const def = sys.defOf(b.defId); need += def ? def.width * def.height : UNKNOWN_SHELF_ITEM_CELLS; }
  return free >= need ? null : BOOKS_BLOCK_REASON;
}

/**
 * Move every book of `uid` into the stash (all or nothing: on the first refusal the ones already added are taken
 * back out with `takeItem`). True when the shelf is empty afterwards.
 */
export function stashBooksOf(sys: HousingSystem, uid: string): boolean {
  const books = sys.booksOf(uid);
  if (!books.length) return true;
  const inv = sys.ctx.inventory;
  const loot = sys.ctx.loot;
  if (!inv || typeof inv.tryAddToStash !== 'function' || !loot || typeof loot.createItem !== 'function') return false;
  const added: string[] = [];
  for (const b of books) {
    const item = loot.createItem(b.defId, 1);
    if (!inv.tryAddToStash(item)) {
      if (typeof inv.takeItem === 'function') for (const u of added) inv.takeItem(u);
      return false;
    }
    added.push(item.uid);
  }
  sys.dropBooksOf(uid);
  return true;
}

export function getBooks(sys: HousingSystem, uid: string): BookSlotInfo[] {
  if (!sys.shelfOf(uid)) return [];
  const out: BookSlotInfo[] = [];
  for (let slot = 0; slot < BOOKS_PER_SHELF; slot++) {
    const book = sys.bookAt(uid, slot);
    const def = book ? sys.bookDef(book.defId) : null;
    out.push({
      slot,
      defId: book?.defId ?? null,
      skill: def?.book?.skill ?? null,
      rarity: def?.rarity ?? null,
      weight: def ? bookWeightOf(def) : 0,
    });
  }
  return out;
}

/** 2026-09-13 (user's decision — the same book counts once): is this def already shelved in any holder (regardless of power). */
export function isShelvedAnywhere(sys: HousingSystem, defId: string): boolean {
  return sys.books().some((b) => b.defId === defId) || media(sys).some((e) => e.defId === defId);
}

export function placeBook(sys: HousingSystem, uid: string, slot: number, defId: string): string | null {
  if (!sys.shelfOf(uid)) return '책장이 아닙니다';
  if (sys.ctx.phase !== 'hub') return '함선에서만 책을 꽂을 수 있습니다';
  if (!Number.isInteger(slot) || slot < 0 || slot >= BOOKS_PER_SHELF) return '없는 책장 칸입니다';
  if (sys.bookAt(uid, slot)) return '이미 책이 꽂혀 있습니다';
  const def = sys.bookDef(defId);
  if (!def) return '서적이 아닙니다';
  if (isShelvedAnywhere(sys, defId)) return `이미 꽂혀 있는 ${SHELF_MEDIUM_LABEL_KO.book}입니다`;
  if (sys.countDef(defId) < 1) return `${def.name}이(가) 없습니다`;
  const inv = sys.ctx.inventory;
  // `consumeDefAll` takes from the bag first, then the stash
  if (!inv || typeof inv.consumeDefAll !== 'function' || !inv.consumeDefAll(defId, 1)) return '책을 꺼낼 수 없습니다';
  sys.books().push({ uid, slot, defId });
  const dex = sys.bookDex();
  if (!dex.includes(defId)) dex.push(defId);
  sys.booksChanged(uid, 'bookPlace');
  return null;
}

export function takeBook(sys: HousingSystem, uid: string, slot: number): string | null {
  if (!sys.shelfOf(uid)) return '책장이 아닙니다';
  const book = sys.bookAt(uid, slot);
  if (!book) return '꽂힌 책이 없습니다';
  const loot = sys.ctx.loot;
  if (!loot || typeof loot.createItem !== 'function') return '책을 만들 수 없습니다';
  const item = loot.createItem(book.defId, 1);
  // 2026-09-16: delivery has one path, `parts/Deliver` — a drag-and-drop goes to **the cell the cursor was dropped on** (`withDropCell`).
  if (!deliverItem(sys, item, 'bag-first')) return `공간 없음 — ${noRoomReason('bag-first')}`;
  sys.books().splice(sys.books().indexOf(book), 1);
  sys.booksChanged(uid, 'bookTake');
  return null;
}

export function getOwnedBooks(sys: HousingSystem): { defId: string; qty: number }[] { return ownedShelfItems(sys, 'book'); }

/**
 * 2026-09-13 (library series): `1 + library skillGain[skill]` — the sum of what the book · disc · record series in working holders give that skill.
 * `getSkillGainMul` reads this, so progression/'s path is unchanged.
 */
export function getBookBonus(sys: HousingSystem, skill: SkillId): number {
  return 1 + (ensureLibrary(sys).summary.skillGain[skill] ?? 0);
}

export function getBookDex(sys: HousingSystem): readonly string[] { return sys.bookDex(); }

export function openBookshelfMenu(sys: HousingSystem, uid: string): void {
  if (!sys.bookshelfMenu) return;
  if (!sys.shelfOf(uid)) { sys.notify('책장이 없습니다', 'warning'); return; }
  sys.exitHousingMode();
  sys.closeMenus(false);
  sys.bookshelfMenu.openShelf(uid);
}

/* ══ Library media — the disc stand · record rack · game disc stand · aux furniture (A-3e, 2026-09-12 · 2026-09-13) ═════
 * The bookshelf keeps its **old path** (`books` / `bookDex` · `placeBook` / `takeBook` · `housing:booksChanged`) — the shared media API hands a
 * bookshelf to those functions, while discs · records · game discs use `ShipState.media` / `mediaDex`. Both arrays have the `PlacedBook` shape.
 * Aux furniture counts **as soon as it is placed** (`Rules.shelfAuxPlaced`) — power allocation was dropped on 2026-09-13, so there is no 「running」 state left to
 * check and placed *is* working (`refreshLibrary` says the same). The TV's and record player's on-state (`ShipState.toggled`) is only a look, no part of the
 * multiplier. **Several** holders per medium may be built (`FurnitureDef.multi`).
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════ */

/** `media` arrays already checked against `ctx.loot` — keyed by the array, so a state replaced by the server copy is checked again. */
const prunedMedia = new WeakSet<PlacedBook[]>();

/**
 * The disc · record · game disc slots (`ShipState.media`). The save looks only at the id **shape** (`disc_*` · `record_*` · `game_*`); the first time
 * `ctx.loot` is around, anything not really that medium or whose shape disagrees is filtered once (same contract as `books()` — old-id swap · duplicate refund).
 */
export function media(sys: HousingSystem): PlacedBook[] {
  if (!Array.isArray(sys.state.media)) sys.state.media = [];
  const list = sys.state.media;
  if (!prunedMedia.has(list) && sys.ctx?.loot && typeof sys.ctx.loot.getItemDef === 'function') {
    prunedMedia.add(list);
    pruneShelfList(sys, list, (def, e) => {
      const m = shelfHolderMediumOfItem(def);
      return !!m && m !== 'book' && m === shelfMediumOfDefId(e.defId);
    }, new Set());
  }
  return list;
}

/** The disc · record · game disc catalogue (append-only). */
export function mediaDex(sys: HousingSystem): string[] {
  if (!Array.isArray(sys.state.mediaDex)) sys.state.mediaDex = [];
  return sys.state.mediaDex;
}

/** The uids of the TVs · record players left on (`ShipState.toggled`). */
export function toggledUids(sys: HousingSystem): string[] {
  if (!Array.isArray(sys.state.toggled)) sys.state.toggled = [];
  return sys.state.toggled;
}

/** The medium when the placed piece is a holder (`HousingRef.getShelfMedium`) — 2026-09-13 the game disc stand = `'game'`. */
export function shelfMediumOf(sys: HousingSystem, uid: string): ShelfMedium | null {
  const item = sys.getPlacedByUid(uid);
  const def = item ? FURNITURE_DEF_MAP.get(item.defId) : undefined;
  return def ? shelfMediumOfInteraction(def.interaction) : null;
}

/** Everything shelved in holder `uid` (`booksOf` for a bookshelf). Empty array when it is not a holder. */
export function shelfItemsOf(sys: HousingSystem, uid: string): PlacedBook[] {
  const m = shelfMediumOf(sys, uid);
  if (!m) return [];
  return m === 'book' ? sys.booksOf(uid) : media(sys).filter((e) => e.uid === uid);
}

function mediaAt(sys: HousingSystem, uid: string, slot: number): PlacedBook | null {
  return media(sys).find((e) => e.uid === uid && e.slot === slot) ?? null;
}

/** That medium's item def (`ItemDef.book` / `disc` / `record` / 2026-09-13 `gameDisc`), else null. */
export function shelfItemDef(sys: HousingSystem, defId: string, medium: ShelfMedium): ItemDef | null {
  const def = sys.defOf(defId);
  return def && shelfHolderMediumOfItem(def) === medium ? def : null;
}

export function shelfChanged(sys: HousingSystem, uid: string, medium: ShelfMedium, reason: string): void {
  sys.changed(reason);
  sys.ctx.bus.emit('housing:shelfChanged', { uid, medium, count: shelfItemsOf(sys, uid).length });
}

/** The shared-media 「can it be moved to the stash before recovery」 (the general form of `booksBlock`). null when it is not a holder, or is empty. */
export function shelfBlock(sys: HousingSystem, uid: string): string | null {
  const m = shelfMediumOf(sys, uid);
  if (!m) return null;
  if (m === 'book') return sys.booksBlock(uid);
  const items = shelfItemsOf(sys, uid);
  if (!items.length) return null;
  const inv = sys.ctx.inventory;
  if (!inv || typeof inv.tryAddToStash !== 'function' || !sys.ctx.loot || typeof sys.ctx.loot.createItem !== 'function') return SHELF_BLOCK_REASON[m];
  const free = sys.freeStashCells();
  if (free < 0) return null;                                   // unknown → let `recover` try for real
  let need = 0;
  for (const e of items) { const def = sys.defOf(e.defId); need += def ? def.width * def.height : UNKNOWN_SHELF_ITEM_CELLS; }
  return free >= need ? null : SHELF_BLOCK_REASON[m];
}

/**
 * Move every medium of holder `uid` into the ship stash (all or nothing — on the first refusal the ones already added are taken back out
 * with `takeItem`). `stashBooksOf` for a bookshelf. True when the holder is empty afterwards.
 */
export function stashShelfItemsOf(sys: HousingSystem, uid: string): boolean {
  const m = shelfMediumOf(sys, uid);
  if (!m) return true;
  if (m === 'book') return sys.stashBooksOf(uid);
  const items = shelfItemsOf(sys, uid);
  if (!items.length) return true;
  const inv = sys.ctx.inventory;
  const loot = sys.ctx.loot;
  if (!inv || typeof inv.tryAddToStash !== 'function' || !loot || typeof loot.createItem !== 'function') return false;
  const added: string[] = [];
  for (const e of items) {
    const item = loot.createItem(e.defId, 1);
    if (!inv.tryAddToStash(item)) {
      if (typeof inv.takeItem === 'function') for (const u of added) inv.takeItem(u);
      return false;
    }
    added.push(item.uid);
  }
  const list = media(sys);
  for (let i = list.length - 1; i >= 0; i--) if (list[i].uid === uid) list.splice(i, 1);
  return true;
}

/** Clears the on-state of a recovered piece (`recover`). */
export function dropToggled(sys: HousingSystem, uid: string): void {
  const list = toggledUids(sys);
  const i = list.indexOf(uid);
  if (i >= 0) list.splice(i, 1);
}

export function getShelfSlots(sys: HousingSystem, uid: string): BookSlotInfo[] {
  const m = shelfMediumOf(sys, uid);
  if (!m) return [];
  if (m === 'book') return sys.getBooks(uid);
  const out: BookSlotInfo[] = [];
  for (let slot = 0; slot < SHELF_SLOTS[m]; slot++) {
    const e = mediaAt(sys, uid, slot);
    const def = e ? shelfItemDef(sys, e.defId, m) : null;
    out.push({
      slot,
      defId: e?.defId ?? null,
      skill: shelfItemOf(def)?.skill ?? null,
      rarity: def?.rarity ?? null,
      weight: def ? shelfItemWeightOf(def) : 0,
    });
  }
  return out;
}

export function placeShelfItem(sys: HousingSystem, uid: string, slot: number, defId: string): string | null {
  const m = shelfMediumOf(sys, uid);
  if (!m) return '보관함이 아닙니다';
  if (m === 'book') return sys.placeBook(uid, slot, defId);
  const label = SHELF_MEDIUM_LABEL_KO[m];
  if (sys.ctx.phase !== 'hub') return `함선에서만 ${SHELF_OBJ_KO[m]} 꽂을 수 있습니다`;
  if (!Number.isInteger(slot) || slot < 0 || slot >= SHELF_SLOTS[m]) return `없는 ${shelfHolderName(m)} 칸입니다`;
  if (mediaAt(sys, uid, slot)) return `이미 ${label}가 꽂혀 있습니다`;
  const def = shelfItemDef(sys, defId, m);
  if (!def) return `${label}가 아닙니다`;
  // 2026-09-13 (user's decision): one copy of a kind counts — refused when it is already shelved in any holder
  if (isShelvedAnywhere(sys, defId)) return `이미 꽂혀 있는 ${label}입니다`;
  if (sys.countDef(defId) < 1) return `${def.name}이(가) 없습니다`;
  const inv = sys.ctx.inventory;
  // `consumeDefAll` takes from the bag first, then the stash (the same as a book)
  if (!inv || typeof inv.consumeDefAll !== 'function' || !inv.consumeDefAll(defId, 1)) return `${SHELF_OBJ_KO[m]} 꺼낼 수 없습니다`;
  media(sys).push({ uid, slot, defId });
  const dex = mediaDex(sys);
  if (!dex.includes(defId)) dex.push(defId);
  shelfChanged(sys, uid, m, 'shelfPlace');
  return null;
}

export function takeShelfItem(sys: HousingSystem, uid: string, slot: number): string | null {
  const m = shelfMediumOf(sys, uid);
  if (!m) return '보관함이 아닙니다';
  if (m === 'book') return sys.takeBook(uid, slot);
  const e = mediaAt(sys, uid, slot);
  if (!e) return `꽂힌 ${SHELF_MEDIUM_LABEL_KO[m]}가 없습니다`;
  const loot = sys.ctx.loot;
  if (!loot || typeof loot.createItem !== 'function') return `${SHELF_OBJ_KO[m]} 만들 수 없습니다`;
  const item = loot.createItem(e.defId, 1);
  // 2026-09-16: delivery has one path, `parts/Deliver` — a drag-and-drop goes to **the cell the cursor was dropped on** (`withDropCell`).
  if (!deliverItem(sys, item, 'bag-first')) return `공간 없음 — ${noRoomReason('bag-first')}`;
  const list = media(sys);
  list.splice(list.indexOf(e), 1);
  shelfChanged(sys, uid, m, 'shelfTake');
  return null;
}

/** Sort order: library media = the series table's order → volume number (an old def with no series goes last, by skill), game discs = console → id. */
function ownedOrder(def: ItemDef): [number, number, string] {
  const s = librarySeriesOfItem(def);
  if (s) {
    const i = LIBRARY_SERIES_DEFS.findIndex((d) => d.id === s.seriesId);
    return [i < 0 ? LIBRARY_SERIES_DEFS.length : i, s.volume, def.id];
  }
  if (def.gameDisc) return [0, 0, `${def.gameDisc.console}#${def.id}`];
  const k = SKILL_IDS.indexOf(shelfItemOf(def)?.skill as SkillId);
  return [LIBRARY_SERIES_DEFS.length + 1 + (k < 0 ? SKILL_IDS.length : k), 0, def.id];
}

function ownedShelfItems(sys: HousingSystem, medium: ShelfMedium): { defId: string; qty: number }[] {
  const loot = sys.ctx.loot;
  if (!loot || typeof loot.getAllItemDefs !== 'function') return [];
  const out: { defId: string; qty: number; order: [number, number, string] }[] = [];
  for (const def of loot.getAllItemDefs()) {
    if (shelfHolderMediumOfItem(def) !== medium) continue;
    const qty = sys.countDef(def.id);
    if (qty > 0) out.push({ defId: def.id, qty, order: ownedOrder(def) });
  }
  out.sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1] || a.order[2].localeCompare(b.order[2]));
  return out.map(({ defId, qty }) => ({ defId, qty }));
}

export function getOwnedShelfItems(sys: HousingSystem, medium: ShelfMedium): { defId: string; qty: number }[] {
  return medium === 'book' ? sys.getOwnedBooks() : ownedShelfItems(sys, medium);
}

export function getShelfDex(sys: HousingSystem, medium: ShelfMedium): readonly string[] {
  if (medium === 'book') return sys.bookDex();
  const prefix = SHELF_ID_PREFIX[medium];
  return mediaDex(sys).filter((id) => id.startsWith(prefix));
}

/** Is that medium's aux furniture placed on the ship (regardless of power). A game disc has no aux furniture. */
export function hasShelfAux(sys: HousingSystem, medium: ShelfMedium): boolean {
  return medium !== 'game' && shelfAuxPlaced(sys.state.furniture, medium);
}

/**
 * One skill's library multiplier per medium — since 2026-09-13 the series formula's `skillGain` split per medium (`total === getBookBonus(skill)`).
 * `aux` = the aux furniture placed (power allocation was dropped the same day, 2026-09-13, so 「working」 and 「placed」 mean the same thing).
 */
export function getShelfBonus(sys: HousingSystem, skill: SkillId): ShelfBonusInfo {
  const c = ensureLibrary(sys);
  return shelfBonusFromLibrary(c.comp, skill, c.aux);
}

/** The holder screen — shared by the bookshelf · disc stand · record rack · game disc stand (one `BookshelfMenu` redraws for the medium). */
export function openShelf(sys: HousingSystem, uid: string): void {
  if (!sys.bookshelfMenu) return;
  if (!shelfMediumOf(sys, uid)) { sys.notify('보관함이 없습니다', 'warning'); return; }
  sys.exitHousingMode();
  sys.closeMenus(false);
  sys.bookshelfMenu.openShelf(uid);
}

/* ── On / off (TV · record player) ──────────────────────────────────────── */
function toggleDefOf(sys: HousingSystem, uid: string): FurnitureDef | null {
  const item = sys.getPlacedByUid(uid);
  const def = item ? FURNITURE_DEF_MAP.get(item.defId) : undefined;
  return def && isToggleInteraction(def.interaction) ? def : null;
}

export function isFurnitureOn(sys: HousingSystem, uid: string): boolean {
  return !!toggleDefOf(sys, uid) && toggledUids(sys).includes(uid);
}

/** Flips the on-state and returns the new one — null for a piece that cannot be toggled and for an unknown uid. It is saved (`changed('toggle')`) and sounds. */
export function toggleFurniture(sys: HousingSystem, uid: string): boolean | null {
  const def = toggleDefOf(sys, uid);
  if (!def) return null;
  const list = toggledUids(sys);
  const i = list.indexOf(uid);
  const on = i < 0;
  if (on) list.push(uid); else list.splice(i, 1);
  sys.changed('toggle');
  sys.ctx.bus.emit('housing:furnitureToggled', { uid, on });
  const sound = def.interaction === 'tv' ? (on ? 'tv_on' : 'tv_off') : (on ? 'record_on' : 'record_off');
  sys.ctx.bus.emit('audio:play', { id: sound });
  return on;
}

/* ══ Library series — the effect-sum cache · sources · the band · recipe unlocks (2026-09-13, docs/DECISIONS.md 「2026-09-13 — 서재 시리즈 · 비디오게임」) ═
 * The summing is `Rules.computeLibraryEffects` (pure); this file decides **what goes in** (working holders · aux furniture) and **when to count again**.
 *
 * - One cache per system (`WeakMap`) and every query passes through `ensureLibrary` — a dirty one is counted again on the spot.
 * - **Dirtying events**: `housing:changed` (shelving · taking out · placing · moving · recovery · crafting · toggling · the server copy …) · `housing:loaded` ·
 *   `housing:shelfChanged` · `housing:furniturePlaced/Moved/Recovered` ·
 *   `housing:roomPurposeChanged`. Several events in one call stack are folded into **one microtask**. `parts/Furniture` is not touched.
 * - **`housing:libraryChanged {revision}`** fires only when the signature changes: the summed content **or** the set of shelved defs (regardless of power — the band)
 *   **or** the set of owned holder media (placed + furniture storage — the band). The revision rises by 1 each time and equals `getLibraryEffects().revision`.
 * - A result counted without `ctx.loot` could not read the defs, so the first query · first `update` after loot appears counts again (`tickLibrary`).
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════════════ */

interface LibraryCache {
  dirty: boolean;
  queued: boolean;
  /** Was `ctx.loot` around at the last computation. */
  hadLoot: boolean;
  comp: LibraryComputation;
  /** Whether each medium's aux furniture is **working** (at the last computation). */
  aux: Record<ShelfMedium, boolean>;
  summary: LibraryEffectsSummary;
  sig: string;
  /** The def ids shelved in any holder (regardless of power). */
  shelved: Set<string>;
  /** The media of the holders owned (placed + furniture storage, regardless of power). */
  holderMedia: Set<ShelfMedium>;
  revision: number;
  /** Recipe id → the series id that unlocks it (the series table · `CraftRecipe.unlockSeries`). Rebuilt when `recipeLocksKey` differs. */
  recipeLocks: Map<string, string> | null;
  recipeLocksKey: string;
}

const LIB_CACHE = new WeakMap<HousingSystem, LibraryCache>();
const EMPTY_COMP: LibraryComputation = { effects: EMPTY_LIBRARY_EFFECTS, series: new Map() };

function libCacheOf(sys: HousingSystem): LibraryCache {
  let c = LIB_CACHE.get(sys);
  if (!c) {
    c = {
      dirty: true, queued: false, hadLoot: false, comp: EMPTY_COMP, aux: { book: false, disc: false, record: false, game: false },
      summary: EMPTY_LIBRARY_EFFECTS, sig: '', shelved: new Set(), holderMedia: new Set(), revision: 0, recipeLocks: null, recipeLocksKey: '',
    };
    LIB_CACHE.set(sys, c);
  }
  return c;
}

/** Counts again from the current state — when the signature changed the revision rises and `housing:libraryChanged` fires. */
function refreshLibrary(sys: HousingSystem): void {
  const c = libCacheOf(sys);
  c.dirty = false;
  const state = sys.state;
  // 2026-09-13 (power allocation dropped the same day): a placed holder · aux furniture always works — the filter that dropped stopped holders is gone
  const aux: Record<ShelfMedium, boolean> = { book: false, disc: false, record: false, game: false };
  for (const m of SHELF_MEDIA) aux[m] = shelfAuxPlaced(state.furniture, m);
  const all = [...books(sys), ...media(sys)];
  const comp = computeLibraryEffects(all, sys.defOf, aux);
  const shelved = new Set(all.map((e) => e.defId));
  const holderMedia = new Set<ShelfMedium>();
  for (const f of state.furniture) {
    const m = shelfMediumOfInteraction(FURNITURE_DEF_MAP.get(f.defId)?.interaction ?? 'none');
    if (m) holderMedia.add(m);
  }
  for (const s of state.furnitureStorage) {
    if (!(s.qty > 0)) continue;
    const m = shelfMediumOfInteraction(FURNITURE_DEF_MAP.get(s.defId)?.interaction ?? 'none');
    if (m) holderMedia.add(m);
  }
  c.comp = comp;
  c.aux = aux;
  c.shelved = shelved;
  c.holderMedia = holderMedia;
  c.hadLoot = !!sys.ctx?.loot;
  const sig = `${libraryEffectsSignature(comp.effects)}#${[...shelved].sort().join(',')}#${[...holderMedia].sort().join(',')}`;
  if (sig === c.sig) return;
  c.sig = sig;
  c.revision++;
  c.summary = Object.freeze({ ...comp.effects, revision: c.revision });
  sys.ctx?.bus.emit('housing:libraryChanged', { revision: c.revision });
}

/** Brings the cache up to date (counts again when it is dirty or was counted without loot). */
export function ensureLibrary(sys: HousingSystem): LibraryCache {
  const c = libCacheOf(sys);
  if (c.dirty || (!c.hadLoot && sys.ctx?.loot)) refreshLibrary(sys);
  return c;
}

/** Marks it dirty and counts again once at the end of this call stack (a microtask). */
export function markLibraryDirty(sys: HousingSystem): void {
  const c = libCacheOf(sys);
  c.dirty = true;
  if (c.queued) return;
  c.queued = true;
  queueMicrotask(() => {
    c.queued = false;
    if (c.dirty) refreshLibrary(sys);
  });
}

/** Once from `HousingSystem.init` — binds the dirtying events and schedules the first computation. */
export function bindLibrary(sys: HousingSystem): Array<() => void> {
  const b = sys.ctx.bus;
  const dirty = (): void => markLibraryDirty(sys);
  const unsubs = [
    b.on('housing:changed', dirty),
    b.on('housing:loaded', dirty),
    b.on('housing:shelfChanged', dirty),
    b.on('housing:furniturePlaced', dirty),
    b.on('housing:furnitureMoved', dirty),
    b.on('housing:furnitureRecovered', dirty),
    b.on('housing:roomPurposeChanged', dirty),
  ];
  markLibraryDirty(sys);
  return unsubs;
}

/** `HousingSystem.update` — a result counted without loot is counted again on the first frame loot exists (it does nothing else). */
export function tickLibrary(sys: HousingSystem): void {
  const c = LIB_CACHE.get(sys);
  if (c && !c.hadLoot && !c.dirty && sys.ctx?.loot) markLibraryDirty(sys);
}

/** `HousingRef.getLibraryEffects`. */
export function getLibraryEffects(sys: HousingSystem): LibraryEffectsSummary {
  return ensureLibrary(sys).summary;
}

/** `HousingRef.getLibrarySources`. */
export function getLibrarySources(sys: HousingSystem, kind: LibraryEffectKind, target: string): readonly LibrarySourceInfo[] {
  return librarySourcesIn(ensureLibrary(sys).comp, kind, typeof target === 'string' ? target : '');
}

/** `HousingRef.getSeriesProgress` — null for an unknown series, 0 / total when no volume is shelved. */
export function getSeriesProgress(sys: HousingSystem, seriesId: string): { have: number; total: number; fraction: number } | null {
  const def = LIBRARY_SERIES_MAP.get(seriesId);
  if (!def) return null;
  const st = ensureLibrary(sys).comp.series.get(seriesId);
  return st ? { have: st.have, total: st.total, fraction: st.fraction } : { have: 0, total: Math.max(1, def.volumes), fraction: 0 };
}

/** For the screen — the state of every series with a shelved volume (measured over the working holders). */
export function librarySeriesStates(sys: HousingSystem): ReadonlyMap<string, LibrarySeriesState> {
  return ensureLibrary(sys).comp.series;
}

/** For the screen — whether each medium's aux furniture is **working** (at the last computation). */
export function libraryAuxActive(sys: HousingSystem, medium: ShelfMedium): boolean {
  return ensureLibrary(sys).aux[medium] === true;
}

/**
 * `HousingRef.isShelfItemWanted` — true when it is library-effect media (book · disc · record), a holder for that medium is owned (placed or in furniture
 * storage), and no holder has the same def shelved. Two cached sets and one def lookup, so it is O(1).
 */
export function isShelfItemWanted(sys: HousingSystem, defId: string): boolean {
  if (typeof defId !== 'string' || !defId) return false;
  const id = resolveItemAlias(defId);
  const s = shelfItemOf(sys.defOf(id));
  if (!s) return false;
  const c = ensureLibrary(sys);
  return c.holderMedia.has(s.medium) && !c.shelved.has(id);
}

/** Recipe id → the series id that unlocks it (null with none). The series table's `recipe:` effect is the default; `CraftRecipe.unlockSeries` wins when present. */
function recipeLockOf(sys: HousingSystem, recipeId: string): string | null {
  const c = libCacheOf(sys);
  const loot = sys.ctx?.loot;
  const recipes = loot && typeof loot.getAllRecipes === 'function' ? loot.getAllRecipes() : null;
  const key = `${LIBRARY_SERIES_DEFS.length}#${recipes ? recipes.length : -1}`;
  if (!c.recipeLocks || c.recipeLocksKey !== key) {
    const map = new Map<string, string>();
    for (const s of LIBRARY_SERIES_DEFS) for (const e of s.effects) if (e.kind === 'recipe' && !map.has(e.target)) map.set(e.target, s.id);
    for (const r of recipes ?? []) if (typeof r.unlockSeries === 'string' && r.unlockSeries) map.set(r.id, r.unlockSeries);
    c.recipeLocks = map;
    c.recipeLocksKey = key;
  }
  return c.recipeLocks.get(recipeId) ?? null;
}

/** `HousingRef.isRecipeUnlocked` — true with no locking series; with one, true only while that series **currently** gives this recipe effect (every volume in working holders). */
export function isRecipeUnlocked(sys: HousingSystem, recipeId: string): boolean {
  if (typeof recipeId !== 'string') return true;
  const seriesId = recipeLockOf(sys, recipeId);
  if (!seriesId) return true;
  const st = ensureLibrary(sys).comp.series.get(seriesId);
  return !!st && st.fraction >= 1 && st.def.effects.some((e) => e.kind === 'recipe' && e.target === recipeId);
}
