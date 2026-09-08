/**
 * src/housing/parts/Library.ts — **서재 책장** (Phase 9).
 *
 * 숙련도마다 책이 하나씩 있고, 책장에 꽂으면 그 숙련도의 XP 배율이 오른다(상한 있음).
 * 책은 **함선 단위**이지 캐릭터 단위가 아니며, 도감은 **꽂아 본 적 있는** 책만 기록한다.
 */
import type {
  BookSlotInfo, CraftIngredient, EmbeddedView, FacilityId, FacilityInfo, FurnitureDef, GameContext, GameSystem, GrowPlot, GrowPlotInfo,
  HousingRef, ItemDef, LoadoutPreset, PlacedBook, PlacedFurniture, ProfileRef, RoomPurpose, RoomState, ShipState, SkillId,
  StoredFurniture, WorkbenchKind,
} from '@/shared';
import {
  BOOKS_PER_SHELF, FURNITURE_DEFS, FURNITURE_DEF_MAP, GROW_PLOTS_PER_RACK, GROW_SKILL_SPEEDUP, IMPLANT_IDS, SKILL_IDS, SKILL_LEVEL_MAX,
  benchKindOf,
} from '@/shared';
import {
  bookGainMulFor, bookWeightOf, canPlaceAt, craftCostMulFor, facilityBlockReason, facilityLevel, facilityMaxLevel, facilityName,
  facilityPurposeOf, purposeBuildBlockReason, purposeBuildCost, roomRefundCost,
  furnitureAllowedIn, furnitureUpgradeReason, isRoomIndex, isRoomPurpose, layerOf, missingIngredients, nextFacilityCost, nextFreeLayer,
  nextFurnitureCost, presetCountFor, recoverBlockReason, skillGainMulFor, stackLimitOf, stackMembers,
  stashSizeFor,
} from '../Rules';
import { ShipStore, freshRoom, isBookshelfDefId, isGrowRackDefId, loadState, maxUidIndex, sanitize, writeState } from '../ShipState';
import { PresetMenu } from '../ui/PresetMenu';
import { GrowMenu } from '../ui/GrowMenu';
import { BookshelfMenu } from '../ui/BookshelfMenu';
import { createShipView } from '../ui/ShipView';
import { formatRemaining } from '../ui/dom';
import type { HousingPanel } from '../ui/Panel';
import { BOOKS_BLOCK_REASON, FACILITY_IDS, PRESET_NAME_MAX } from '../model';
import type { HousingSystem } from '../HousingSystem';

/* ── 서재 책장 (Phase 9) ────────────────────────────────────────────────── */
/**
 * The shelved books. The save only shape-checks def ids (`book_*`); the first time `ctx.loot` is around every id
 * that is not a real 서적 any more is dropped here (a removed book def never breaks the shelf).
 */
export function books(sys: HousingSystem): PlacedBook[] {
  if (!Array.isArray(sys.state.books)) sys.state.books = [];
  if (!sys.booksPruned && sys.ctx?.loot && typeof sys.ctx.loot.getItemDef === 'function') {
    sys.booksPruned = true;
    const books = sys.state.books;
    for (let i = books.length - 1; i >= 0; i--) {
      if (!sys.defOf(books[i].defId)?.book) { console.warn(`[housing] unknown book '${books[i].defId}' dropped from shelf ${books[i].uid}`); books.splice(i, 1); }
    }
  }
  return sys.state.books;
  }

export function bookDex(sys: HousingSystem): string[] {
  if (!Array.isArray(sys.state.bookDex)) sys.state.bookDex = [];
  return sys.state.bookDex;
  }

/** The 책장 behind `uid`, or null when it is not a bookshelf (or gone). */
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
  sys.ctx.bus.emit('housing:booksChanged', { uid, count: sys.booksOf(uid).length });
  }

/** Book def with its `book` data, or null when `defId` is not a 서적. */
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
  for (const b of books) { const def = sys.defOf(b.defId); need += def ? def.width * def.height : 2; }
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

export function placeBook(sys: HousingSystem, uid: string, slot: number, defId: string): string | null {
  if (!sys.shelfOf(uid)) return '책장이 아닙니다';
  if (sys.ctx.phase !== 'hub') return '함선에서만 책을 꽂을 수 있습니다';
  if (!Number.isInteger(slot) || slot < 0 || slot >= BOOKS_PER_SHELF) return '없는 책장 칸입니다';
  if (sys.bookAt(uid, slot)) return '이미 책이 꽂혀 있습니다';
  const def = sys.bookDef(defId);
  if (!def) return '서적이 아닙니다';
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
  const inv = sys.ctx.inventory;
  const where = inv && typeof inv.tryAddItemAnywhere === 'function'
    ? inv.tryAddItemAnywhere(item)
    : inv && typeof inv.tryAddItem === 'function' && inv.tryAddItem(item) ? 'bag' : null;
  if (!where) return '공간 없음 — 가방과 창고에 자리가 없습니다';
  sys.books().splice(sys.books().indexOf(book), 1);
  sys.booksChanged(uid, 'bookTake');
  return null;
  }

export function getOwnedBooks(sys: HousingSystem): { defId: string; qty: number }[] {
  const loot = sys.ctx.loot;
  if (!loot || typeof loot.getAllItemDefs !== 'function') return [];
  const out: { defId: string; qty: number }[] = [];
  for (const def of loot.getAllItemDefs()) {
    if (!def.book) continue;
    const qty = sys.countDef(def.id);
    if (qty > 0) out.push({ defId: def.id, qty });
  }
  const order = (defId: string): number => { const i = SKILL_IDS.indexOf(sys.bookDef(defId)?.book?.skill as SkillId); return i < 0 ? SKILL_IDS.length : i; };
  out.sort((a, b) => order(a.defId) - order(b.defId));
  return out;
  }

export function getBookBonus(sys: HousingSystem, skill: SkillId): number { return bookGainMulFor(skill, sys.books(), sys.defOf); }

export function getBookDex(sys: HousingSystem): readonly string[] { return sys.bookDex(); }

export function openBookshelfMenu(sys: HousingSystem, uid: string): void {
  if (!sys.bookshelfMenu) return;
  if (!sys.shelfOf(uid)) { sys.notify('책장이 없습니다', 'warning'); return; }
  sys.exitHousingMode();
  sys.closeMenus(false);
  sys.bookshelfMenu.openShelf(uid);
  }
