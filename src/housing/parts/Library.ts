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
import { BookshelfMenu } from '../ui/BookshelfMenu';
import { createShipView } from '../ui/ShipView';
import { formatRemaining } from '../ui/dom';
import type { HousingPanel } from '../ui/Panel';
import { BOOKS_BLOCK_REASON, FACILITY_IDS, PRESET_NAME_MAX } from '../model';
import type { HousingSystem } from '../HousingSystem';
/* A-3e (2026-09-12): 서재 매체 */
import type { ShelfBonusInfo, ShelfMedium } from '@/shared';
import { SHELF_MEDIUM_LABEL_KO, SHELF_SLOTS, isToggleInteraction, shelfItemOf, shelfMediumOfInteraction } from '@/shared';
import { SHELF_ID_PREFIX, shelfAuxPlaced, shelfGainFor, shelfItemWeightOf, shelfMediumOfDefId } from '../Rules';
import { SHELF_BLOCK_REASON, SHELF_OBJ_KO, shelfHolderName } from '../model';

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
  const count = sys.booksOf(uid).length;
  sys.ctx.bus.emit('housing:booksChanged', { uid, count });
  // A-3e: the 매체 공통 event fires for a 책장 too (책장 소비자는 옛 `housing:booksChanged` 를 계속 본다)
  sys.ctx.bus.emit('housing:shelfChanged', { uid, medium: 'book', count });
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

/**
 * A-3e (2026-09-12): **서재 배율 전체**다 — 책 · 디스크 · 레코드 몫의 합 (`getShelfBonus(skill).total`). 디스크 · 레코드 ·
 * 보조 가구가 없으면 옛 `bookGainMulFor` 와 같은 값이다 (`Rules.shelfGainFor` 주석). `getSkillGainMul` 이 이것을 읽으므로
 * progression/ 은 한 줄도 안 바뀐다.
 */
export function getBookBonus(sys: HousingSystem, skill: SkillId): number { return getShelfBonus(sys, skill).total; }

export function getBookDex(sys: HousingSystem): readonly string[] { return sys.bookDex(); }

export function openBookshelfMenu(sys: HousingSystem, uid: string): void {
  if (!sys.bookshelfMenu) return;
  if (!sys.shelfOf(uid)) { sys.notify('책장이 없습니다', 'warning'); return; }
  sys.exitHousingMode();
  sys.closeMenus(false);
  sys.bookshelfMenu.openShelf(uid);
  }

/* ══ 서재 매체 — 디스크 전시대 · 레코드랙 · 보조 가구 (A-3e, 2026-09-12) ══════════════════════════════════════
 * 책장은 **옛 경로 그대로**다 (`books` / `bookDex` · `placeBook` / `takeBook` · `housing:booksChanged`) — 매체 공통 API 는 책장이면
 * 그 함수들로 넘기고, 디스크 · 레코드만 `ShipState.media` / `mediaDex` 를 쓴다. 두 배열 모두 `PlacedBook` 모양이다.
 * 보조 가구는 **배치만으로** 켜지고(`Rules.shelfAuxPlaced`), TV · 레코드 플레이어의 켜짐(`ShipState.toggled`)은 겉모습일 뿐
 * 배율에 관여하지 않는다.
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════ */

/** `media` arrays already checked against `ctx.loot` — keyed by the array, so a state replaced by the server copy is checked again. */
const prunedMedia = new WeakSet<PlacedBook[]>();

/**
 * 디스크 · 레코드 칸 (`ShipState.media`). 세이브는 id **모양**(`disc_*` · `record_*`)만 보고, `ctx.loot` 가 처음 있을 때 진짜
 * 디스크 · 레코드가 아니거나 모양과 매체가 어긋나는 것을 한 번 걸러 낸다 (`books()` 와 같은 규약).
 */
export function media(sys: HousingSystem): PlacedBook[] {
  if (!Array.isArray(sys.state.media)) sys.state.media = [];
  const list = sys.state.media;
  if (!prunedMedia.has(list) && sys.ctx?.loot && typeof sys.ctx.loot.getItemDef === 'function') {
    prunedMedia.add(list);
    for (let i = list.length - 1; i >= 0; i--) {
      const s = shelfItemOf(sys.defOf(list[i].defId));
      if (!s || s.medium === 'book' || s.medium !== shelfMediumOfDefId(list[i].defId)) {
        console.warn(`[housing] unknown shelf item '${list[i].defId}' dropped from ${list[i].uid}`);
        list.splice(i, 1);
      }
    }
  }
  return list;
  }

/** 디스크 · 레코드 도감 (append-only). */
export function mediaDex(sys: HousingSystem): string[] {
  if (!Array.isArray(sys.state.mediaDex)) sys.state.mediaDex = [];
  return sys.state.mediaDex;
  }

/** 켜 둔 TV · 레코드 플레이어 uid (`ShipState.toggled`). */
export function toggledUids(sys: HousingSystem): string[] {
  if (!Array.isArray(sys.state.toggled)) sys.state.toggled = [];
  return sys.state.toggled;
  }

/** 배치된 조각이 보관함이면 그 매체 (`HousingRef.getShelfMedium`). */
export function shelfMediumOf(sys: HousingSystem, uid: string): ShelfMedium | null {
  const item = sys.getPlacedByUid(uid);
  const def = item ? FURNITURE_DEF_MAP.get(item.defId) : undefined;
  return def ? shelfMediumOfInteraction(def.interaction) : null;
  }

/** 보관함 `uid` 에 꽂힌 것 전부 (책장이면 `booksOf`). 보관함이 아니면 빈 배열. */
export function shelfItemsOf(sys: HousingSystem, uid: string): PlacedBook[] {
  const m = shelfMediumOf(sys, uid);
  if (!m) return [];
  return m === 'book' ? sys.booksOf(uid) : media(sys).filter((e) => e.uid === uid);
  }

function mediaAt(sys: HousingSystem, uid: string, slot: number): PlacedBook | null {
  return media(sys).find((e) => e.uid === uid && e.slot === slot) ?? null;
  }

/** 그 매체의 아이템 def (`ItemDef.disc` / `record` / `book`), 아니면 null. */
export function shelfItemDef(sys: HousingSystem, defId: string, medium: ShelfMedium): ItemDef | null {
  const def = sys.defOf(defId);
  return def && shelfItemOf(def)?.medium === medium ? def : null;
  }

export function shelfChanged(sys: HousingSystem, uid: string, medium: ShelfMedium, reason: string): void {
  sys.changed(reason);
  sys.ctx.bus.emit('housing:shelfChanged', { uid, medium, count: shelfItemsOf(sys, uid).length });
  }

/** 매체 공통의 「회수 전에 창고로 옮길 수 있는가」 (`booksBlock` 의 일반판). 보관함이 아니거나 비었으면 null. */
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
  for (const e of items) { const def = sys.defOf(e.defId); need += def ? def.width * def.height : 4; }
  return free >= need ? null : SHELF_BLOCK_REASON[m];
  }

/**
 * 보관함 `uid` 의 매체를 전부 함선 창고로 (all or nothing — 첫 거절에서 이미 넣은 것을 `takeItem` 으로 되돌린다). 책장이면
 * `stashBooksOf`. 옮긴 뒤 보관함이 비었으면 true.
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

/** 회수된 조각의 켜짐을 지운다 (`recover`). */
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
  if (sys.countDef(defId) < 1) return `${def.name}이(가) 없습니다`;
  const inv = sys.ctx.inventory;
  // `consumeDefAll` takes from the bag first, then the stash (책과 같다)
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
  const inv = sys.ctx.inventory;
  const where = inv && typeof inv.tryAddItemAnywhere === 'function'
    ? inv.tryAddItemAnywhere(item)
    : inv && typeof inv.tryAddItem === 'function' && inv.tryAddItem(item) ? 'bag' : null;
  if (!where) return '공간 없음 — 가방과 창고에 자리가 없습니다';
  const list = media(sys);
  list.splice(list.indexOf(e), 1);
  shelfChanged(sys, uid, m, 'shelfTake');
  return null;
  }

export function getOwnedShelfItems(sys: HousingSystem, medium: ShelfMedium): { defId: string; qty: number }[] {
  if (medium === 'book') return sys.getOwnedBooks();
  const loot = sys.ctx.loot;
  if (!loot || typeof loot.getAllItemDefs !== 'function') return [];
  const out: { defId: string; qty: number; order: number }[] = [];
  for (const def of loot.getAllItemDefs()) {
    const s = shelfItemOf(def);
    if (!s || s.medium !== medium) continue;
    const qty = sys.countDef(def.id);
    if (qty <= 0) continue;
    const i = SKILL_IDS.indexOf(s.skill);
    out.push({ defId: def.id, qty, order: i < 0 ? SKILL_IDS.length : i });
  }
  out.sort((a, b) => a.order - b.order);
  return out.map(({ defId, qty }) => ({ defId, qty }));
  }

export function getShelfDex(sys: HousingSystem, medium: ShelfMedium): readonly string[] {
  if (medium === 'book') return sys.bookDex();
  const prefix = SHELF_ID_PREFIX[medium];
  return mediaDex(sys).filter((id) => id.startsWith(prefix));
  }

export function hasShelfAux(sys: HousingSystem, medium: ShelfMedium): boolean { return shelfAuxPlaced(sys.state.furniture, medium); }

export function getShelfBonus(sys: HousingSystem, skill: SkillId): ShelfBonusInfo {
  const aux = { book: hasShelfAux(sys, 'book'), disc: hasShelfAux(sys, 'disc'), record: hasShelfAux(sys, 'record') };
  return shelfGainFor(skill, sys.books(), media(sys), sys.defOf, aux);
  }

/** 보관함 화면 — 책장 · 디스크 전시대 · 레코드랙 공통 (`BookshelfMenu` 한 장이 매체를 바꿔 그린다). */
export function openShelf(sys: HousingSystem, uid: string): void {
  if (!sys.bookshelfMenu) return;
  if (!shelfMediumOf(sys, uid)) { sys.notify('보관함이 없습니다', 'warning'); return; }
  sys.exitHousingMode();
  sys.closeMenus(false);
  sys.bookshelfMenu.openShelf(uid);
  }

/* ── 켜기 / 끄기 (TV · 레코드 플레이어) ─────────────────────────────────── */
function toggleDefOf(sys: HousingSystem, uid: string): FurnitureDef | null {
  const item = sys.getPlacedByUid(uid);
  const def = item ? FURNITURE_DEF_MAP.get(item.defId) : undefined;
  return def && isToggleInteraction(def.interaction) ? def : null;
  }

export function isFurnitureOn(sys: HousingSystem, uid: string): boolean {
  return !!toggleDefOf(sys, uid) && toggledUids(sys).includes(uid);
  }

/** 켜짐을 뒤집고 새 상태를 돌려준다 — 켤 수 없는 가구 · 없는 uid 는 null. 저장되고(`changed('toggle')`) 소리가 난다. */
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
