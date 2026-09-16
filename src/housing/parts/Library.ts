/**
 * src/housing/parts/Library.ts — **서재 책장** (Phase 9) → **서재 매체** (A-3e, 2026-09-12) → **서재 시리즈** (2026-09-13).
 *
 * 책 · 디스크 · 레코드는 **시리즈**(`data/library_series.csv`)의 한 권이고, 보관함에 꽂힌 서로 다른 권 수가 그 시리즈의
 * 몫을 정한다 (전권 = 100 %, 아니면 권당 `SHELF_SERIES_VOLUME_SHARE`). 효과 줄(숙련 상승량 · 파생 · 헬스 · 요리 · 레이드 경험치 ·
 * 신뢰도 · 레시피)은 `Rules.computeLibraryEffects` 가 합산하고, 이 파일이 캐시 · `housing:libraryChanged` 를 맡는다.
 * 게임 디스크(`'game'`)는 게임 디스크 전시대에 꽂는 **효과 없는 보관 매체**다 (TV 로 플레이 — `parts/VideoGame`).
 * 매체는 **함선 단위**이지 캐릭터 단위가 아니며, 도감은 **꽂아 본 적 있는** 것만 기록한다. **같은 def 는 한 보관함에만** 꽂힌다 (사용자 결정).
 */
import type { BookSlotInfo, ItemDef, PlacedBook, PlacedFurniture, SkillId } from '@/shared';
import { BOOKS_PER_SHELF, FURNITURE_DEF_MAP, SKILL_IDS } from '@/shared';
import { bookWeightOf } from '../Rules';
import { isBookshelfDefId } from '../ShipState';
import { BOOKS_BLOCK_REASON } from '../model';
import type { HousingSystem } from '../HousingSystem';
import { deliverItem, noRoomReason } from './Deliver';
/* A-3e (2026-09-12): 서재 매체 */
import type { FurnitureDef, ShelfBonusInfo, ShelfMedium } from '@/shared';
import { SHELF_MEDIA, SHELF_MEDIUM_LABEL_KO, SHELF_SLOTS, isToggleInteraction, shelfItemOf, shelfMediumOfInteraction } from '@/shared';
import { SHELF_ID_PREFIX, shelfAuxPlaced, shelfItemWeightOf, shelfMediumOfDefId } from '../Rules';
import { SHELF_BLOCK_REASON, SHELF_OBJ_KO, shelfHolderName } from '../model';
/* 2026-09-13: 서재 시리즈 */
import type { LibraryEffectKind, LibraryEffectsSummary, LibrarySourceInfo } from '@/shared';
import { EMPTY_LIBRARY_EFFECTS, LIBRARY_SERIES_DEFS, LIBRARY_SERIES_MAP, resolveItemAlias } from '@/shared';
import type { LibraryComputation, LibrarySeriesState } from '../Rules';
import {
  computeLibraryEffects, libraryEffectsSignature, librarySeriesOfItem, librarySourcesIn, shelfBonusFromLibrary, shelfHolderMediumOfItem,
} from '../Rules';

/* ── 공통: 런타임 정리 (옛 id → 새 id · 모르는 def · 같은 def 중복) ─────────────── */

/**
 * 세이브는 id **모양**만 보고(`ShipState.sanitize` — 옛 id 치환 · 중복 환불도 거기서 한다), `ctx.loot` 가 처음 있을 때 여기서 한 번 더 거른다:
 * 옛 id 는 `resolveItemAlias` 로 바꾸고, `ok` 가 거절하는 def 는 버리고, 같은 def 가 두 번째로 나오면 빼서 **함선 창고로 돌려준다**
 * (sanitize 뒤라 보통은 없다 — 콘솔 · 손으로 고친 상태). 목록은 제자리에서 고친다.
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

/* ── 서재 책장 (Phase 9) ────────────────────────────────────────────────── */
/**
 * The shelved books. The save only shape-checks def ids (`book_*`); the first time `ctx.loot` is around every id
 * that is not a real 서적 any more is dropped here (a removed book def never breaks the shelf). 2026-09-13: old ids are
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

/** 2026-09-13 (사용자 결정 — 같은 책은 한 권만 센다): 이 def 가 어느 보관함에든(전력 무관) 이미 꽂혀 있는가. */
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
  // 2026-09-16: 전달은 `parts/Deliver` 한 길이다 — 끌어서 놓았으면 **커서가 놓인 칸**으로 간다 (`withDropCell`).
  if (!deliverItem(sys, item, 'bag-first')) return `공간 없음 — ${noRoomReason('bag-first')}`;
  sys.books().splice(sys.books().indexOf(book), 1);
  sys.booksChanged(uid, 'bookTake');
  return null;
  }

export function getOwnedBooks(sys: HousingSystem): { defId: string; qty: number }[] { return ownedShelfItems(sys, 'book'); }

/**
 * 2026-09-13 (서재 시리즈): `1 + 서재 skillGain[skill]` — 작동 중인 보관함의 책 · 디스크 · 레코드 시리즈가 그 숙련에 주는 상승량의 합.
 * `getSkillGainMul` 이 이것을 읽으므로 progression/ 의 경로는 그대로다.
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

/* ══ 서재 매체 — 디스크 전시대 · 레코드랙 · 게임 디스크 전시대 · 보조 가구 (A-3e, 2026-09-12 · 2026-09-13) ══════════════
 * 책장은 **옛 경로 그대로**다 (`books` / `bookDex` · `placeBook` / `takeBook` · `housing:booksChanged`) — 매체 공통 API 는 책장이면
 * 그 함수들로 넘기고, 디스크 · 레코드 · 게임 디스크는 `ShipState.media` / `mediaDex` 를 쓴다. 두 배열 모두 `PlacedBook` 모양이다.
 * 보조 가구는 **배치만으로** 켜지고(`Rules.shelfAuxPlaced`, 2026-09-13 부터 작동 중이어야), TV · 레코드 플레이어의 켜짐
 * (`ShipState.toggled`)은 겉모습일 뿐 배율에 관여하지 않는다. 보관함은 매체마다 **여러 대** 둘 수 있다 (`FurnitureDef.multi`).
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════ */

/** `media` arrays already checked against `ctx.loot` — keyed by the array, so a state replaced by the server copy is checked again. */
const prunedMedia = new WeakSet<PlacedBook[]>();

/**
 * 디스크 · 레코드 · 게임 디스크 칸 (`ShipState.media`). 세이브는 id **모양**(`disc_*` · `record_*` · `game_*`)만 보고, `ctx.loot` 가 처음
 * 있을 때 진짜 그 매체가 아니거나 모양과 매체가 어긋나는 것을 한 번 걸러 낸다 (`books()` 와 같은 규약 — 옛 id 치환 · 중복 환불 포함).
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

/** 디스크 · 레코드 · 게임 디스크 도감 (append-only). */
export function mediaDex(sys: HousingSystem): string[] {
  if (!Array.isArray(sys.state.mediaDex)) sys.state.mediaDex = [];
  return sys.state.mediaDex;
  }

/** 켜 둔 TV · 레코드 플레이어 uid (`ShipState.toggled`). */
export function toggledUids(sys: HousingSystem): string[] {
  if (!Array.isArray(sys.state.toggled)) sys.state.toggled = [];
  return sys.state.toggled;
  }

/** 배치된 조각이 보관함이면 그 매체 (`HousingRef.getShelfMedium`) — 2026-09-13 게임 디스크 전시대 = `'game'`. */
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

/** 그 매체의 아이템 def (`ItemDef.book` / `disc` / `record` / 2026-09-13 `gameDisc`), 아니면 null. */
export function shelfItemDef(sys: HousingSystem, defId: string, medium: ShelfMedium): ItemDef | null {
  const def = sys.defOf(defId);
  return def && shelfHolderMediumOfItem(def) === medium ? def : null;
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
  // 2026-09-13 (사용자 결정): 같은 종류는 한 장만 센다 — 이미 어느 보관함에든 꽂혀 있으면 거절
  if (isShelvedAnywhere(sys, defId)) return `이미 꽂혀 있는 ${label}입니다`;
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
  // 2026-09-16: 전달은 `parts/Deliver` 한 길이다 — 끌어서 놓았으면 **커서가 놓인 칸**으로 간다 (`withDropCell`).
  if (!deliverItem(sys, item, 'bag-first')) return `공간 없음 — ${noRoomReason('bag-first')}`;
  const list = media(sys);
  list.splice(list.indexOf(e), 1);
  shelfChanged(sys, uid, m, 'shelfTake');
  return null;
  }

/** 정렬 순서: 서재 매체 = 시리즈 표 순서 → 권 번호 (시리즈 없는 옛 def 는 숙련 순서로 뒤에), 게임 디스크 = 게임기 → id. */
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

/** 그 매체의 보조 가구가 함선에 배치돼 있는가 (전력 무관). 게임 디스크는 보조 가구가 없다. */
export function hasShelfAux(sys: HousingSystem, medium: ShelfMedium): boolean {
  return medium !== 'game' && shelfAuxPlaced(sys.state.furniture, medium);
  }

/**
 * 한 숙련의 서재 배율을 매체별로 — 2026-09-13 부터 시리즈 공식의 `skillGain` 을 매체별로 나눈 것 (`total === getBookBonus(skill)`).
 * `aux` = 배치된 보조 가구 (2026-09-13 같은 날 전력 할당이 폐지되어 「작동 중」 과 「배치됨」 이 같다).
 */
export function getShelfBonus(sys: HousingSystem, skill: SkillId): ShelfBonusInfo {
  const c = ensureLibrary(sys);
  return shelfBonusFromLibrary(c.comp, skill, c.aux);
  }

/** 보관함 화면 — 책장 · 디스크 전시대 · 레코드랙 · 게임 디스크 전시대 공통 (`BookshelfMenu` 한 장이 매체를 바꿔 그린다). */
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

/* ══ 서재 시리즈 — 효과 합산 캐시 · 소스 · 띠 · 레시피 해금 (2026-09-13, docs/DECISIONS.md 「2026-09-13 — 서재 시리즈 · 비디오게임」) ══════════════════
 * 합산은 `Rules.computeLibraryEffects` (순수) 이고 여기서는 **무엇을 넣을지**(작동 중인 보관함 · 보조 가구)와 **언제 다시 셀지**를 정한다.
 *
 * - 캐시는 시스템마다 하나(`WeakMap`)이고 질의는 전부 `ensureLibrary` 를 지난다 — 더러우면 그 자리에서 다시 센다.
 * - **더럽히는 사건**: `housing:changed`(꽂기 · 빼기 · 배치 · 이동 · 회수 · 제작 · 켜기 · 서버 사본 …) · `housing:loaded` ·
 *   `housing:shelfChanged` · `housing:furniturePlaced/Moved/Recovered` ·
 *   `housing:roomPurposeChanged`. 한 호출 스택의 여러 사건은 **마이크로태스크 한 번**으로 합친다. `parts/Furniture` 는 고치지 않는다.
 * - **`housing:libraryChanged {revision}`** 는 서명이 바뀔 때만 난다: 합산 내용 **또는** 꽂힌 def 집합(전력 무관 — 띠) **또는**
 *   보유한 보관함 매체 집합(배치 + 가구 창고 — 띠). 리비전은 그때마다 1 오르고 `getLibraryEffects().revision` 과 같다.
 * - `ctx.loot` 없이 센 결과는 def 를 못 읽은 결과라, loot 가 생긴 뒤 첫 질의 · 첫 `update` 가 다시 센다 (`tickLibrary`).
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════════════ */

interface LibraryCache {
  dirty: boolean;
  queued: boolean;
  /** 마지막 계산 때 `ctx.loot` 가 있었나. */
  hadLoot: boolean;
  comp: LibraryComputation;
  /** 매체별 보조 가구 **작동** 여부 (마지막 계산). */
  aux: Record<ShelfMedium, boolean>;
  summary: LibraryEffectsSummary;
  sig: string;
  /** 어느 보관함에든 꽂힌 def id (전력 무관). */
  shelved: Set<string>;
  /** 보유한 보관함의 매체 (배치 + 가구 창고, 전력 무관). */
  holderMedia: Set<ShelfMedium>;
  revision: number;
  /** 레시피 id → 그것을 여는 시리즈 id (시리즈 표 · `CraftRecipe.unlockSeries`). `recipeLocksKey` 가 다르면 다시 만든다. */
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

/** 지금 상태로 다시 센다 — 서명이 바뀌었으면 리비전을 올리고 `housing:libraryChanged` 를 낸다. */
function refreshLibrary(sys: HousingSystem): void {
  const c = libCacheOf(sys);
  c.dirty = false;
  const state = sys.state;
  // 2026-09-13 (같은 날 전력 할당 폐지): 배치된 보관함 · 보조 가구는 늘 작동한다 — 멈춘 보관함을 거르던 필터를 걷어냈다
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

/** 캐시를 최신으로 (더럽거나 loot 없이 셌으면 다시 센다). */
export function ensureLibrary(sys: HousingSystem): LibraryCache {
  const c = libCacheOf(sys);
  if (c.dirty || (!c.hadLoot && sys.ctx?.loot)) refreshLibrary(sys);
  return c;
}

/** 더럽히고 이 호출 스택 끝(마이크로태스크)에 한 번 다시 센다. */
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

/** `HousingSystem.init` 에서 한 번 — 더럽히는 사건을 묶고 첫 계산을 예약한다. */
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

/** `HousingSystem.update` — loot 없이 센 결과를 loot 가 생긴 첫 프레임에 다시 센다 (그 밖에는 아무 일도 하지 않는다). */
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

/** `HousingRef.getSeriesProgress` — 모르는 시리즈면 null, 꽂힌 권이 없으면 0 / 전체. */
export function getSeriesProgress(sys: HousingSystem, seriesId: string): { have: number; total: number; fraction: number } | null {
  const def = LIBRARY_SERIES_MAP.get(seriesId);
  if (!def) return null;
  const st = ensureLibrary(sys).comp.series.get(seriesId);
  return st ? { have: st.have, total: st.total, fraction: st.fraction } : { have: 0, total: Math.max(1, def.volumes), fraction: 0 };
}

/** 화면용 — 꽂힌 권이 있는 시리즈 전부의 상태 (작동 중인 보관함 기준). */
export function librarySeriesStates(sys: HousingSystem): ReadonlyMap<string, LibrarySeriesState> {
  return ensureLibrary(sys).comp.series;
}

/** 화면용 — 매체별 보조 가구 **작동** 여부 (마지막 계산). */
export function libraryAuxActive(sys: HousingSystem, medium: ShelfMedium): boolean {
  return ensureLibrary(sys).aux[medium] === true;
}

/**
 * `HousingRef.isShelfItemWanted` — 서재 효과 매체(책 · 디스크 · 레코드)이고, 그 매체의 보관함을 보유(배치 또는 가구 창고)했고, 어느 보관함에도
 * 같은 def 가 꽂혀 있지 않으면 true. 캐시된 집합 두 개와 def 조회 하나라 O(1) 이다.
 */
export function isShelfItemWanted(sys: HousingSystem, defId: string): boolean {
  if (typeof defId !== 'string' || !defId) return false;
  const id = resolveItemAlias(defId);
  const s = shelfItemOf(sys.defOf(id));
  if (!s) return false;
  const c = ensureLibrary(sys);
  return c.holderMedia.has(s.medium) && !c.shelved.has(id);
}

/** 레시피 id → 그것을 여는 시리즈 id (없으면 null). 시리즈 표의 `recipe:` 효과가 기본, `CraftRecipe.unlockSeries` 가 있으면 그것이 이긴다. */
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

/** `HousingRef.isRecipeUnlocked` — 잠그는 시리즈가 없으면 true, 있으면 그 시리즈가 **지금** 이 레시피 효과를 주고 있어야(작동 중인 보관함에 전권) true. */
export function isRecipeUnlocked(sys: HousingSystem, recipeId: string): boolean {
  if (typeof recipeId !== 'string') return true;
  const seriesId = recipeLockOf(sys, recipeId);
  if (!seriesId) return true;
  const st = ensureLibrary(sys).comp.series.get(seriesId);
  return !!st && st.fraction >= 1 && st.def.effects.some((e) => e.kind === 'recipe' && e.target === recipeId);
}
