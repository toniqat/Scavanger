import type { GrowPlot, LoadoutPreset, PlacedBook, PlacedFurniture, ProfileRef, RoomState, ShipState, StoredFurniture } from '@/shared';
import {
  BOOKS_PER_SHELF, FURNITURE_DEF_MAP, GROW_PLOTS_PER_RACK, IMPLANT_IDS, SHIP_ROOM_COUNT, SHIP_STATE_VERSION, SHIP_STORAGE_KEY,
  slotKey,
} from '@/shared';
import {
  canPlaceAt, facilityMaxLevel, facilityPurposeOf, furnitureAllowedIn, furnitureMaxLevel, isRoomPurpose, nextFreeLayer,
  stackLimitOf, stackMembers,
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
 * ──────────────────────────────────────────────────────────────────────────── */

const SAVE_DELAY_MS = 350;
/** Current on-disk version (3 since Phase 9; never below the contract's `SHIP_STATE_VERSION`). */
export const SHIP_STATE_VERSION_CURRENT = Math.max(3, SHIP_STATE_VERSION);
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
    plots: [],
    nameLocked: false,
    books: [],
    bookDex: [],
  };
}

/** Does the ship already own a 정비 벤치 (placed or stored)? Keeps the v1 → v2 grant idempotent. */
function hasRepairBench(furniture: readonly PlacedFurniture[], storage: readonly StoredFurniture[]): boolean {
  return furniture.some((f) => f.defId === REPAIR_BENCH_DEF_ID) || storage.some((s) => s.defId === REPAIR_BENCH_DEF_ID && s.qty > 0);
}

/** A 재배층 (or any other stackable rack that grows things). */
export function isGrowRackDefId(defId: string): boolean {
  return FURNITURE_DEF_MAP.get(defId)?.interaction === 'grow_rack';
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
 */
export function sanitize(raw: unknown): ShipState {
  const fresh = freshState();
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
  // a lab without a greenhouse (edited save) falls back to empty
  if (!rooms.some((x) => x.purpose === 'greenhouse')) for (const x of rooms) if (x.purpose === 'lab') { x.purpose = 'empty'; x.level = 0; }

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
  for (const f of Array.isArray(r.furniture) ? (r.furniture as Partial<PlacedFurniture>[]) : []) {
    if (!f || typeof f.defId !== 'string') continue;
    const def = FURNITURE_DEF_MAP.get(f.defId);
    if (!def) { console.warn(`[housing] unknown furniture '${f.defId}' dropped`); continue; }
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

  // 온실 재배: a plot needs its 재배층 to still exist; one plot per (uid, slot), timestamps must be usable numbers
  const plots: GrowPlot[] = [];
  const rackUids = new Set(furniture.filter((f) => isGrowRackDefId(f.defId)).map((f) => f.uid));
  const takenSlots = new Set<string>();
  for (const p of Array.isArray(r.plots) ? (r.plots as Partial<GrowPlot>[]) : []) {
    if (!p || typeof p.uid !== 'string' || typeof p.seedDefId !== 'string' || !p.seedDefId) continue;
    if (!rackUids.has(p.uid)) continue;
    const slot = int(p.slot, -1, -1);
    if (slot < 0 || slot >= GROW_PLOTS_PER_RACK) continue;
    const key = `${p.uid}#${slot}`;
    if (takenSlots.has(key)) continue;
    const plantedAt = int(p.plantedAt, 0, 0);
    if (plantedAt <= 0) continue;
    const readyAt = int(p.readyAt, plantedAt, plantedAt);
    takenSlots.add(key);
    plots.push({ uid: p.uid, slot, seedDefId: p.seedDefId, plantedAt, readyAt });
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

  return {
    version: SHIP_STATE_VERSION_CURRENT,
    rooms, generatorLevel, storageLevel, furniture, furnitureStorage, presets, plots,
    nameLocked: r.nameLocked === true,
    books, bookDex,
  };
}

/** Load from localStorage; `fresh` = nothing valid was stored (first run). */
export function loadState(): { state: ShipState; fresh: boolean } {
  const s = storage();
  if (!s) return { state: freshState(), fresh: true };
  let raw: unknown = null;
  try {
    const text = s.getItem(slotKey(SHIP_STORAGE_KEY));
    if (text) raw = JSON.parse(text);
  } catch { raw = null; }
  if (!raw || typeof raw !== 'object') return { state: freshState(), fresh: true };
  return { state: sanitize(raw), fresh: false };
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
