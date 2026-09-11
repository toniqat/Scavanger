import type {
  AnalysisSlot, CraftIngredient, CultureSlot, GrowSlot, GrowTier, LoadoutPreset, PlacedBook, PlacedFurniture, ProfileRef, RoomState,
  ShipState, StoredFurniture,
} from '@/shared';
import {
  BOOKS_PER_SHELF, FURNITURE_DEF_MAP, GROW_SLOTS_PER_TIER, IMPLANT_IDS, SHIP_ROOM_COUNT, SHIP_STATE_VERSION, SHIP_STORAGE_KEY,
  analyzerSlotsForLevel, cultureSlotsForLevel, slotKey,
} from '@/shared';
import {
  NEEDS_GREENHOUSE,
  canPlaceAt, facilityMaxLevel, facilityPurposeOf, furnitureAllowedIn, furnitureMaxLevel, furnitureRefundCost, growTierOpen,
  isRoomPurpose, mergeCost, nextFreeLayer, stackLimitOf, stackMembers,
} from './Rules';

/* ────────────────────────────────────────────────────────────────────────────
 * ShipState persistence: fresh state, load + sanitise + migrate, debounced save with a pagehide flush. Same shape as
 * inventory/Stash.ts (try/catch around every localStorage touch, SAVE_DELAY_MS debounce). Uids of placed furniture
 * are `f-<n>`; `nextUid` continues after the highest one found in the save. Phase 7: every flush also mirrors the state
 * into the server profile document `ship` (`ctx.net.profile.set`) when a profile is available.
 * Phase 8: state **version 2** — `plots` (온실 재배), `nameLocked`, `PlacedFurniture.layer`, and the 정비 벤치 that
 * left the cockpit is granted once to every profile (fresh state + v1 → v2 migration).
 * Phase 9: state **version 3** — `books` (서재 책장 slots) + `bookDex` (every book ever shelved); absent → empty, no
 * data migration. `SHIP_STATE_VERSION` in the contract is 3 now, so `SHIP_STATE_VERSION_CURRENT` follows it.
 * 온실 개편 (2026-09-11): state **version 4** — `grows` (재배 스테이션 칸) replaces `plots`, and **every `retired`
 * furniture def is swept out of the save** (placed or stored) and handed back as materials. `sanitize` cannot reach
 * the inventory, so it only *computes* that refund into its optional `out` and `HousingSystem` pays it into the
 * 함선 창고 as soon as `ctx.inventory` exists (see `flushRetiredRefund`).
 * 연구실 (2026-09-11): state **version 5** — `analyses` (분석기 해석 칸) + `sampleDex` (해석 도감). 없던 필드가
 * 생기는 것뿐이라 **버릴 데이터도 환불 경로도 없다** — v4 세이브는 빈 값으로 열린다.
 * 배양조 (A-14, 2026-09-11): state **version 6** — `cultures` (배양 칸). v5 → v6 도 없던 필드가 생기는 것뿐이라
 * 마이그레이션 · 환불 경로가 없다.
 * ──────────────────────────────────────────────────────────────────────────── */

const SAVE_DELAY_MS = 350;
/** Current on-disk version (6 since the 배양조; never below the contract's `SHIP_STATE_VERSION`). */
export const SHIP_STATE_VERSION_CURRENT = Math.max(6, SHIP_STATE_VERSION);
/** The 정비 벤치 moved out of the cockpit in Phase 8 — every profile is handed one, once. */
export const REPAIR_BENCH_DEF_ID = 'furn_repair_bench';
export const GUN_BENCH_DEF_ID = 'furn_bench_gun';
export function storage(): Storage | null {
  try {
    const s = window.localStorage;
    const probe = '__scav_probe__';
    s.setItem(probe, '1'); s.removeItem(probe);
    return s;
  } catch { return null; }
}

export function freshRoom(): RoomState { return { purpose: 'empty', level: 0 }; }

/**
 * The ten rooms of a new ship: **all empty** (2026-09-07). The built-in 작업실 of the Phase 8 UI pass is gone — the
 * player assigns every purpose, 작업실 included, from 시설 관리 and pays `ROOM_PURPOSE_BUILD_COST` for it.
 */
function freshRooms(): RoomState[] {
  return Array.from({ length: SHIP_ROOM_COUNT }, freshRoom);
}

export function freshState(): ShipState {
  return {
    version: SHIP_STATE_VERSION_CURRENT,
    rooms: freshRooms(),
    generatorLevel: 0,
    storageLevel: 0,
    furniture: [],                            // 2026-09-07: no free 총기 작업대 / 정비 벤치 — both are crafted
    furnitureStorage: [],
    presets: [],
    plots: [],                                // 은퇴한 재배층의 잔재 — 언제나 빈 배열이다 (온실 개편, 2026-09-11)
    nameLocked: false,
    books: [],
    bookDex: [],
    grows: [],
    analyses: [],                             // 연구실 분석기 (v5, 2026-09-11)
    sampleDex: [],
    cultures: [],                             // 온실 배양조 (v6, A-14, 2026-09-11)
  };
}

/** Does the ship already own a 정비 벤치 (placed or stored)? Keeps the v1 → v2 grant idempotent. */
function hasRepairBench(furniture: readonly PlacedFurniture[], storage: readonly StoredFurniture[]): boolean {
  return furniture.some((f) => f.defId === REPAIR_BENCH_DEF_ID) || storage.some((s) => s.defId === REPAIR_BENCH_DEF_ID && s.qty > 0);
}

/**
 * A 재배층 (the retired stackable rack). Kept so an old save / an old caller can still ask; nothing is ever placed
 * with this def any more (`sanitize` sweeps it out as a `retired` def).
 * @deprecated 2026-09-11 (온실 개편) — use `isGrowStationDefId`.
 */
export function isGrowRackDefId(defId: string): boolean {
  return FURNITURE_DEF_MAP.get(defId)?.interaction === 'grow_rack';
}

/** A 재배 스테이션 (온실 개편, 2026-09-11): the furniture whose E opens the 재배 화면. */
export function isGrowStationDefId(defId: string): boolean {
  return FURNITURE_DEF_MAP.get(defId)?.interaction === 'grow_station';
}

/** 은퇴한 가구인가 (`data/furniture.csv` 의 `retired` 칸). 목록 · 제작 · 배치 · 세이브 어디에도 남지 않는다. */
export function isRetiredDefId(defId: string): boolean {
  return FURNITURE_DEF_MAP.get(defId)?.retired === true;
}

/** 분석기인가 (연구실, 2026-09-11): E 로 분석 화면을 여는 가구. */
export function isAnalyzerDefId(defId: string): boolean {
  return FURNITURE_DEF_MAP.get(defId)?.interaction === 'analyzer';
}

/** 배양조인가 (A-14, 2026-09-11): E 로 배양 화면을 여는 가구. */
export function isCultureTankDefId(defId: string): boolean {
  return FURNITURE_DEF_MAP.get(defId)?.interaction === 'culture_tank';
}

/** 식탁인가 (A-3c, 2026-09-11): E 로 식사 화면을 여는 가구. 공유 함선의 고정 식탁에는 uid 가 없다. */
export function isDiningTableDefId(defId: string): boolean {
  return FURNITURE_DEF_MAP.get(defId)?.interaction === 'dining_table';
}

/** Shape check of a 표본 def id in a save (`spec_*`); whether it is a real 표본 is a runtime check via `ctx.loot`. */
const isSampleDefIdShape = (v: unknown): v is string => typeof v === 'string' && /^spec_[A-Za-z0-9_]{1,40}$/.test(v);

/**
 * Shape check of a 배지 · 세포주 def id in a save. Unlike 표본(`spec_*`) · 토양(`soil_*`) · 서적(`book_*`) these two
 * carry **no id prefix of their own** (`mat_medium_*` · `strain_*` are `material` ids like any other), so the shape
 * check only keeps out obvious junk — whether the id is a real `ItemDef.medium` / `ItemDef.strain` is the runtime
 * prune in `parts/Culture.cultures()` (same 규약 as the 서재 · 온실 · 연구실).
 */
const isItemDefIdShape = (v: unknown): v is string => typeof v === 'string' && /^[a-z][A-Za-z0-9_]{1,48}$/.test(v);

/** Shape check of a soil def id in a save (`soil_<tag>`); whether it is a real 토양 is a runtime check via `ctx.loot`. */
const isSoilDefIdShape = (v: unknown): v is string => typeof v === 'string' && /^soil_[A-Za-z0-9_]{1,40}$/.test(v);

/** What `sanitize` found that the caller has to settle outside the pure function. */
export interface SanitizeOutcome {
  /**
   * Materials owed for every `retired` furniture the save still carried (placed + stored, craft cost + the upgrade
   * levels it had reached). `HousingSystem` drops them into the 함선 창고 once `ctx.inventory` is around.
   */
  refund: CraftIngredient[];
}

/** A 책장 (Phase 9: any furniture whose E opens the bookshelf panel). */
export function isBookshelfDefId(defId: string): boolean {
  return FURNITURE_DEF_MAP.get(defId)?.interaction === 'bookshelf';
}

/** Shape check of a book def id in a save (`book_<skill>`); whether it is a real 서적 is decided at runtime via `ctx.loot`. */
const isBookDefIdShape = (v: unknown): v is string => typeof v === 'string' && /^book_[A-Za-z0-9_]{1,40}$/.test(v);

const int = (v: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};
const yaw = (v: unknown): 0 | 1 | 2 | 3 => (int(v, 0, 0, 3) as 0 | 1 | 2 | 3);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** Highest `f-<n>` index in a furniture list (0 when none). */
export function maxUidIndex(furniture: readonly PlacedFurniture[]): number {
  let max = 0;
  for (const f of furniture) {
    const m = /^f-(\d+)$/.exec(f.uid);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/**
 * Turn whatever was in localStorage into a valid ShipState: unknown furniture defs / purposes / out-of-range numbers
 * are dropped or clamped, duplicated uids re-minted, stack layers re-assigned, plots without a rack dropped.
 * Migrations: **v1 → v2** grants the 정비 벤치 that moved out of the cockpit (once — a save that already owns one is
 * left alone, and a v2 save never runs the grant again). **v3** adds `books` / `bookDex` (Phase 9): a book needs a
 * placed 책장 uid, a slot below `BOOKS_PER_SHELF`, one book per (uid, slot) and a `book_*`-shaped def id; the 도감 is
 * a unique list of such ids. Whether an id still resolves to a 서적 is checked by `HousingSystem` once `ctx.loot`
 * exists. 2026-09-07: the room-1 작업실 invariant is gone — the only room rule left is "at most one facility room of
 * each kind"; furniture whose room no longer accepts it moves into furniture storage instead of being dropped.
 * **v4 (온실 개편, 2026-09-11)**: every `retired` def (지금은 옛 재배층 `furn_grow_rack`) is swept out — placed and
 * stored alike — and what it cost is accumulated into `out.refund` for the caller to pay into the 함선 창고. The old
 * `plots` are dropped wholesale (사용자 결정: 옛 것 폐기) and the new `grows` are validated against the 재배
 * 스테이션 that owns them (placed uid · tier its current level opens · slot in range · soil id shape).
 * **v5 (연구실, 2026-09-11)**: `analyses` (분석기 해석 칸 — placed 분석기 uid · slot inside `analyzerSlotsForLevel`
 * of its **current** level · one per (uid, slot) · `spec_*` id shape · a real `startedAt`) and `sampleDex` (unique
 * `spec_*` ids). A v4 save simply opens with both empty — nothing is dropped, so there is no refund path.
 * **v6 (배양조 A-14, 2026-09-11)**: `cultures` (배양 칸 — placed 배양조 uid · slot inside `cultureSlotsForLevel` of
 * its **current** level · one per (uid, slot) · an item-id-shaped 배지 · the 세포주 fields only together with a real
 * `startedAt`). Again 없던 필드가 생기는 것뿐이라 마이그레이션 · 환불 경로가 없다.
 */
export function sanitize(raw: unknown, out?: SanitizeOutcome): ShipState {
  const fresh = freshState();
  if (out) out.refund = [];
  if (!raw || typeof raw !== 'object') return fresh;
  const r = raw as Partial<ShipState> & Record<string, unknown>;
  const version = int(r.version, 0);
  if (version > SHIP_STATE_VERSION_CURRENT) console.warn(`[housing] ship state v${version} is newer than v${SHIP_STATE_VERSION_CURRENT} — loading best-effort`);

  const rooms: RoomState[] = [];
  const srcRooms = Array.isArray(r.rooms) ? r.rooms : [];
  for (let i = 0; i < SHIP_ROOM_COUNT; i++) {
    const s = srcRooms[i] as Partial<RoomState> | undefined;
    const purpose = isRoomPurpose(s?.purpose) ? s!.purpose! : 'empty';
    const maxLv = purpose === 'workshop' ? facilityMaxLevel('workshop') : purpose === 'range' ? facilityMaxLevel('range') : 1;
    const level = purpose === 'empty' ? 0 : int(s?.level, 1, 1, maxLv);
    rooms.push({ purpose, level });
  }
  // 2026-09-07: the 작업실 is an ordinary purpose again — any room may hold it (one per ship, `purposeChangeReason`),
  // and a ship may hold none at all. A save made under the room-1 rule keeps its 작업실 exactly where it is.
  // The ship still holds at most one of each facility room: an edited save with two keeps the first.
  const seenFacility = new Set<string>();
  for (let i = 0; i < rooms.length; i++) {
    const fid = facilityPurposeOf(rooms[i].purpose);
    if (!fid) continue;
    if (seenFacility.has(fid)) rooms[i] = freshRoom(); else seenFacility.add(fid);
  }
  // a 연구실 · 주방 without a greenhouse (edited save) falls back to empty (`Rules.NEEDS_GREENHOUSE` 가 원본)
  if (!rooms.some((x) => x.purpose === 'greenhouse')) {
    for (const x of rooms) if (NEEDS_GREENHOUSE.includes(x.purpose)) { x.purpose = 'empty'; x.level = 0; }
  }

  const generatorLevel = int(r.generatorLevel, 0, 0, facilityMaxLevel('generator'));
  const storageLevel = int(r.storageLevel, 0, 0, facilityMaxLevel('storage'));

  // placed furniture: every piece must pass the real placement rule against what was accepted before it
  // (known def, existing room, inside the grid, purpose match, no overlap) — anything else is dropped, not clamped
  const furniture: PlacedFurniture[] = [];
  const partial: ShipState = { ...fresh, rooms, furniture };
  const seen = new Set<string>();
  const pending: PlacedFurniture[] = [];
  /** Pieces whose room lost the purpose they need (room-1 migration, edited save): recovered, never destroyed. */
  const displaced: StoredFurniture[] = [];
  /** 은퇴 가구가 돌려줄 재료 (v4): 배치된 것 · 보관된 것을 한 자루에 모아 caller 가 함선 창고로 넣는다. */
  const refund: CraftIngredient[] = [];
  for (const f of Array.isArray(r.furniture) ? (r.furniture as Partial<PlacedFurniture>[]) : []) {
    if (!f || typeof f.defId !== 'string') continue;
    const def = FURNITURE_DEF_MAP.get(f.defId);
    if (!def) { console.warn(`[housing] unknown furniture '${f.defId}' dropped`); continue; }
    if (def.retired) {
      // 온실 개편 (2026-09-11): 은퇴한 가구는 함선에서 걷어내고 값을 재료로 돌려준다 (사용자 결정: 옛 것 폐기)
      mergeCost(refund, furnitureRefundCost(def, int(f.level, 1, 1, furnitureMaxLevel(def))));
      console.warn(`[housing] retired furniture '${def.id}' removed from the ship — refunded as materials`);
      continue;
    }
    const room = int(f.room, -1, -1);
    const item: PlacedFurniture = {
      uid: typeof f.uid === 'string' ? f.uid : '',
      defId: def.id, room,
      x: int(f.x, -1, -1), y: int(f.y, -1, -1),
      yaw: yaw(f.yaw), level: int(f.level, 1, 1, furnitureMaxLevel(def)),
    };
    if (room >= 0 && room < SHIP_ROOM_COUNT && !furnitureAllowedIn(def, rooms[room].purpose)) {
      displaced.push({ defId: def.id, level: item.level, qty: 1 });
      continue;
    }
    if (room < 0 || room >= SHIP_ROOM_COUNT || !canPlaceAt(partial, room, def, item.x, item.y, item.yaw)) {
      console.warn(`[housing] '${def.id}' at room ${room} (${item.x}, ${item.y}) does not fit — dropped`);
      continue;
    }
    // stacked furniture: keep the persisted layer when it is free, otherwise drop the piece onto the lowest free one
    const limit = stackLimitOf(def);
    if (limit > 1) {
      const members = stackMembers(partial, room, def, item.x, item.y, item.yaw);
      const want = int(f.layer, 0, 0, limit - 1);
      item.layer = members.some((m) => (m.layer ?? 0) === want) ? nextFreeLayer(members, limit) : want;
      if (item.layer < 0) { console.warn(`[housing] '${def.id}' stack at room ${room} (${item.x}, ${item.y}) is full — dropped`); continue; }
    }
    if (!/^f-\d+$/.test(item.uid) || seen.has(item.uid)) pending.push(item);
    else seen.add(item.uid);
    furniture.push(item);
  }
  let next = maxUidIndex(furniture.filter((f) => !pending.includes(f)));
  for (const item of pending) item.uid = `f-${++next}`;

  const furnitureStorage: StoredFurniture[] = [];
  for (const s of [...(Array.isArray(r.furnitureStorage) ? (r.furnitureStorage as Partial<StoredFurniture>[]) : []), ...displaced]) {
    if (!s || typeof s.defId !== 'string') continue;
    const def = FURNITURE_DEF_MAP.get(s.defId);
    if (!def) continue;
    const level = int(s.level, 1, 1, furnitureMaxLevel(def));
    const qty = int(s.qty, 0, 0);
    if (qty <= 0) continue;
    if (def.retired) { mergeCost(refund, furnitureRefundCost(def, level), qty); continue; }
    const existing = furnitureStorage.find((e) => e.defId === def.id && e.level === level);
    if (existing) existing.qty += qty; else furnitureStorage.push({ defId: def.id, level, qty });
  }
  // v1 → v2: the 정비 벤치 left the cockpit, so every existing profile is handed one (never twice)
  if (version < 2 && !hasRepairBench(furniture, furnitureStorage) && FURNITURE_DEF_MAP.has(REPAIR_BENCH_DEF_ID)) {
    furnitureStorage.push({ defId: REPAIR_BENCH_DEF_ID, level: 1, qty: 1 });
  }

  const presets: (LoadoutPreset | null)[] = [];
  for (const p of Array.isArray(r.presets) ? (r.presets as (Partial<LoadoutPreset> | null)[]) : []) {
    if (!p || typeof p !== 'object') { presets.push(null); continue; }
    const implant = strOrNull(p.implant);
    presets.push({
      name: typeof p.name === 'string' ? p.name.slice(0, 24) : '프리셋',
      primary: strOrNull(p.primary), primary2: strOrNull(p.primary2), secondary: strOrNull(p.secondary),
      bag: strOrNull(p.bag), armor: strOrNull(p.armor),
      implant: implant && (IMPLANT_IDS as readonly string[]).includes(implant) ? (implant as LoadoutPreset['implant']) : null,
      // appended (2026-09-08): 임플란트 아이템 def ids. Absent in an older save → left undefined, which `applyLoadout`
      // reads as "leave the equipped implants alone" (an empty array means "take everything off").
      ...(Array.isArray(p.implantItems)
        ? { implantItems: (p.implantItems as unknown[]).filter((d): d is string => typeof d === 'string' && !!d).slice(0, 16) }
        : {}),
    });
  }

  /* 온실 개편 (2026-09-11): the 재배층 `plots` are gone with the furniture they belonged to — 사용자 결정 「옛 것
     폐기」. The field stays in the contract (추가만 하는 규약) and is written back empty. */

  // 재배 스테이션 칸: the station must still be placed, its level must open the tier, the slot must be in range,
  // one entry per (uid, tier, slot), and the soil id must at least *look* like a 토양 (the real def check is a
  // runtime prune in `parts/Garden.grows()`, exactly like the 서재 does with its books).
  const grows: GrowSlot[] = [];
  const stationLevel = new Map<string, number>();
  for (const f of furniture) if (isGrowStationDefId(f.defId)) stationLevel.set(f.uid, f.level);
  const takenGrowSlots = new Set<string>();
  for (const g of Array.isArray(r.grows) ? (r.grows as Partial<GrowSlot>[]) : []) {
    if (!g || typeof g.uid !== 'string' || !isSoilDefIdShape(g.soilDefId)) continue;
    const level = stationLevel.get(g.uid);
    if (level === undefined) continue;
    const tier = int(g.tier, -1, -1) as GrowTier;
    if (tier !== 0 && tier !== 1 && tier !== 2) continue;
    if (!growTierOpen(level, tier)) continue;
    const slot = int(g.slot, -1, -1);
    if (slot < 0 || slot >= GROW_SLOTS_PER_TIER) continue;
    const key = `${g.uid}#${tier}#${slot}`;
    if (takenGrowSlots.has(key)) continue;
    takenGrowSlots.add(key);
    const entry: GrowSlot = {
      uid: g.uid, tier, slot, soilDefId: g.soilDefId,
      soilUsesLeft: Math.max(1, int(g.soilUsesLeft, 1, 1)),
    };
    // planting fields come and go together: a half-written seed leaves plain soil behind
    const plantedAt = int(g.plantedAt, 0, 0);
    if (typeof g.seedDefId === 'string' && g.seedDefId && plantedAt > 0) {
      entry.seedDefId = g.seedDefId;
      entry.plantedAt = plantedAt;
      entry.readyAt = int(g.readyAt, plantedAt, plantedAt);
    }
    grows.push(entry);
  }

  // Phase 9 서재: a shelved book needs its 책장 to still be placed; one book per (uid, slot); slot < BOOKS_PER_SHELF
  const books: PlacedBook[] = [];
  const shelfUids = new Set(furniture.filter((f) => isBookshelfDefId(f.defId)).map((f) => f.uid));
  const takenBookSlots = new Set<string>();
  for (const b of Array.isArray(r.books) ? (r.books as Partial<PlacedBook>[]) : []) {
    if (!b || typeof b.uid !== 'string' || !isBookDefIdShape(b.defId)) continue;
    if (!shelfUids.has(b.uid)) continue;
    const slot = int(b.slot, -1, -1);
    if (slot < 0 || slot >= BOOKS_PER_SHELF) continue;
    const key = `${b.uid}#${slot}`;
    if (takenBookSlots.has(key)) continue;
    takenBookSlots.add(key);
    books.push({ uid: b.uid, slot, defId: b.defId });
  }
  // 도감: unique book ids, every shelved book included (a save edited by hand cannot forget what is on its shelves)
  const bookDex: string[] = [];
  for (const id of [...(Array.isArray(r.bookDex) ? r.bookDex : []), ...books.map((b) => b.defId)]) {
    if (isBookDefIdShape(id) && !bookDex.includes(id)) bookDex.push(id);
  }

  /* 연구실 분석기 (v5, 2026-09-11): 해석 칸은 배치된 분석기의 것이어야 하고, 칸 번호가 그 분석기의 **지금 레벨**이
     연 범위 안이어야 하며, (uid, slot) 하나에 하나뿐이고, 표본 id 는 최소한 `spec_*` **모양**이어야 한다 (진짜
     표본인지는 `parts/Lab.analyses()` 가 `ctx.loot` 로 한 번 걸러 낸다 — 서재 · 온실과 같은 규약). 걸러진 칸의
     표본은 돌아오지 않는다 (부은 흙과 같은 취급, 계약에 적힌 그대로). */
  const analyses: AnalysisSlot[] = [];
  const analyzerSlots = new Map<string, number>();
  for (const f of furniture) if (isAnalyzerDefId(f.defId)) analyzerSlots.set(f.uid, analyzerSlotsForLevel(f.level));
  const takenAnalysisSlots = new Set<string>();
  for (const a of Array.isArray(r.analyses) ? (r.analyses as Partial<AnalysisSlot>[]) : []) {
    if (!a || typeof a.uid !== 'string' || !isSampleDefIdShape(a.sampleDefId)) continue;
    const open = analyzerSlots.get(a.uid);
    if (open === undefined) continue;
    const slot = int(a.slot, -1, -1);
    if (slot < 0 || slot >= open) continue;
    const key = `${a.uid}#${slot}`;
    if (takenAnalysisSlots.has(key)) continue;
    const startedAt = int(a.startedAt, 0, 0);
    if (startedAt <= 0) continue;                       // 시작 시각이 없는 칸은 타이머를 되살릴 수 없다
    takenAnalysisSlots.add(key);
    analyses.push({ uid: a.uid, slot, sampleDefId: a.sampleDefId, startedAt, readyAt: int(a.readyAt, startedAt, startedAt) });
  }
  // 해석 도감: `spec_*` 모양의 유일한 id 목록 (append-only — 한 번 회수한 표본은 지워지지 않는다)
  const sampleDex: string[] = [];
  for (const id of Array.isArray(r.sampleDex) ? r.sampleDex : []) {
    if (isSampleDefIdShape(id) && !sampleDex.includes(id)) sampleDex.push(id);
  }

  /* 온실 배양조 (v6, A-14, 2026-09-11): 배양 칸은 배치된 배양조의 것이어야 하고, 칸 번호가 그 배양조의 **지금
     레벨**이 연 범위 안이어야 하며, (uid, slot) 하나에 하나뿐이고, 배지 id 는 최소한 아이템 id **모양**이어야
     한다. 세포주 필드는 `grows` 의 씨앗과 같은 규약으로 **함께 오고 함께 간다** — 반쯤 쓰인 칸은 「넣을 준비가
     된 배지」로 남는다. 걸러진 칸의 배지 · 세포주는 돌아오지 않는다 (부은 흙과 같은 취급). */
  const cultures: CultureSlot[] = [];
  const tankSlots = new Map<string, number>();
  for (const f of furniture) if (isCultureTankDefId(f.defId)) tankSlots.set(f.uid, cultureSlotsForLevel(f.level));
  const takenCultureSlots = new Set<string>();
  for (const c of Array.isArray(r.cultures) ? (r.cultures as Partial<CultureSlot>[]) : []) {
    if (!c || typeof c.uid !== 'string' || !isItemDefIdShape(c.mediumDefId)) continue;
    const open = tankSlots.get(c.uid);
    if (open === undefined) continue;
    const slot = int(c.slot, -1, -1);
    if (slot < 0 || slot >= open) continue;
    const key = `${c.uid}#${slot}`;
    if (takenCultureSlots.has(key)) continue;
    takenCultureSlots.add(key);
    const entry: CultureSlot = {
      uid: c.uid, slot, mediumDefId: c.mediumDefId,
      mediumUsesLeft: Math.max(1, int(c.mediumUsesLeft, 1, 1)),
    };
    const startedAt = int(c.startedAt, 0, 0);
    if (isItemDefIdShape(c.strainDefId) && startedAt > 0) {
      entry.strainDefId = c.strainDefId;
      entry.startedAt = startedAt;
      entry.readyAt = int(c.readyAt, startedAt, startedAt);
    }
    cultures.push(entry);
  }

  if (out) out.refund = refund;
  return {
    version: SHIP_STATE_VERSION_CURRENT,
    rooms, generatorLevel, storageLevel, furniture, furnitureStorage, presets, plots: [],
    nameLocked: r.nameLocked === true,
    books, bookDex, grows, analyses, sampleDex, cultures,
  };
}

/**
 * Load from localStorage; `fresh` = nothing valid was stored (first run). `refund` (v4) is what the sweep of
 * 은퇴 가구 owes the player — `HousingSystem` pays it into the 함선 창고 once the inventory exists.
 */
export function loadState(): { state: ShipState; fresh: boolean; refund: CraftIngredient[] } {
  const s = storage();
  if (!s) return { state: freshState(), fresh: true, refund: [] };
  let raw: unknown = null;
  try {
    const text = s.getItem(slotKey(SHIP_STORAGE_KEY));
    if (text) raw = JSON.parse(text);
  } catch { raw = null; }
  if (!raw || typeof raw !== 'object') return { state: freshState(), fresh: true, refund: [] };
  const out: SanitizeOutcome = { refund: [] };
  return { state: sanitize(raw, out), fresh: false, refund: out.refund };
}

export function writeState(state: ShipState): boolean {
  const s = storage();
  if (!s) return false;
  try { s.setItem(slotKey(SHIP_STORAGE_KEY), JSON.stringify(state)); return true; } catch { return false; }
}

/** Debounced writer with a pagehide / beforeunload flush; `profile` = the server mirror (read lazily, may be offline). */
export class ShipStore {
  private timer: number | null = null;
  private dirty = false;
  private onPageHide = (): void => this.flush();

  constructor(private readonly getState: () => ShipState, private readonly profile: () => ProfileRef | null = () => null) {
    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener('beforeunload', this.onPageHide);
  }

  markDirty(): void {
    this.dirty = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { this.timer = null; this.flush(); }, SAVE_DELAY_MS);
  }

  flush(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    if (!this.dirty) return;
    this.dirty = false;
    writeState(this.getState());
    this.upload();
  }

  /**
   * Queue the state into the server profile (`profile:set ship`). Phase 9: called **offline too** — `ProfileSync`
   * keeps an unsent document in its pending map (stamped with the save time) and pushes it on the next connection,
   * where the newer side wins. Only a missing profile ref (net/ not registered) skips the call.
   */
  upload(): void {
    const p = this.profile();
    if (!p || typeof p.set !== 'function') return;
    try { p.set('ship', JSON.parse(JSON.stringify(this.getState()))); } catch { /* net not ready */ }
  }

  /** A change is waiting for the debounced write (`markDirty` called, `flush` not yet run). */
  get isDirty(): boolean { return this.dirty; }

  /** Drop a pending write (the state was just replaced by the server copy, which is already written locally). */
  cancel(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.dirty = false;
  }

  dispose(): void {
    this.flush();
    window.removeEventListener('pagehide', this.onPageHide);
    window.removeEventListener('beforeunload', this.onPageHide);
  }
}
