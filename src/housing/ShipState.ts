import type { GrowPlot, LoadoutPreset, PlacedFurniture, ProfileRef, RoomState, ShipState, StoredFurniture } from '@/shared';
import {
  FURNITURE_DEF_MAP, GROW_PLOTS_PER_RACK, IMPLANT_IDS, SHIP_ROOM_COUNT, SHIP_STATE_VERSION, SHIP_STORAGE_KEY,
  WORKSHOP_ROOM_INDEX,
} from '@/shared';
import {
  canPlaceAt, facilityMaxLevel, furnitureAllowedIn, furnitureMaxLevel, isRoomPurpose, nextFreeLayer, stackLimitOf,
  stackMembers,
} from './Rules';

/* ────────────────────────────────────────────────────────────────────────────
 * ShipState persistence: fresh state, load + sanitise + migrate, debounced save with a pagehide flush. Same shape as
 * inventory/Stash.ts (try/catch around every localStorage touch, SAVE_DELAY_MS debounce). Uids of placed furniture
 * are `f-<n>`; `nextUid` continues after the highest one found in the save. Phase 7: every flush also mirrors the state
 * into the server profile document `ship` (`ctx.net.profile.set`) when a profile is available.
 * Phase 8: state **version 2** — `plots` (온실 재배), `nameLocked`, `PlacedFurniture.layer`, and the 정비 벤치 that
 * left the cockpit is granted once to every profile (fresh state + v1 → v2 migration).
 * ──────────────────────────────────────────────────────────────────────────── */

const SAVE_DELAY_MS = 350;
/**
 * Current on-disk version. Phase 8 writes v2; `SHIP_STATE_VERSION` in the contract is still 1 (it was not bumped in
 * the committed contract and `src/shared` is frozen for this phase), so housing/ owns the number.
 */
export const SHIP_STATE_VERSION_CURRENT = Math.max(2, SHIP_STATE_VERSION);
/** The 정비 벤치 moved out of the cockpit in Phase 8 — every profile is handed one, once. */
export const REPAIR_BENCH_DEF_ID = 'furn_repair_bench';
export const GUN_BENCH_DEF_ID = 'furn_bench_gun';
/**
 * Phase 8 UI pass: a first run no longer starts with the benches boxed up — room 1 is the built-in 작업실 and the two
 * benches are already **placed** in it. They behave like any other furniture (recover to storage, move, re-place).
 */
const STARTER_PLACED: ReadonlyArray<{ defId: string; x: number; y: number }> = [
  { defId: GUN_BENCH_DEF_ID, x: 0, y: 0 },
  { defId: REPAIR_BENCH_DEF_ID, x: 0, y: 3 },
];

export function storage(): Storage | null {
  try {
    const s = window.localStorage;
    const probe = '__scav_probe__';
    s.setItem(probe, '1'); s.removeItem(probe);
    return s;
  } catch { return null; }
}

export function freshRoom(): RoomState { return { purpose: 'empty', level: 0 }; }

/** The ten rooms of a new ship: room 1 is the built-in 작업실 (`WORKSHOP_ROOM_INDEX`), the rest are empty. */
function freshRooms(): RoomState[] {
  const rooms = Array.from({ length: SHIP_ROOM_COUNT }, freshRoom);
  rooms[WORKSHOP_ROOM_INDEX] = { purpose: 'workshop', level: 1 };
  return rooms;
}

export function freshState(): ShipState {
  return {
    version: SHIP_STATE_VERSION_CURRENT,
    rooms: freshRooms(),
    generatorLevel: 0,
    storageLevel: 0,
    furniture: STARTER_PLACED
      .filter((s) => FURNITURE_DEF_MAP.has(s.defId))
      .map((s, i) => ({ uid: `f-${i + 1}`, defId: s.defId, room: WORKSHOP_ROOM_INDEX, x: s.x, y: s.y, yaw: 0 as const, level: 1 })),
    furnitureStorage: [],
    presets: [],
    plots: [],
    nameLocked: false,
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
 * left alone, and a v2 save never runs the grant again). The **room-1 작업실 invariant** (Phase 8 UI pass) is applied
 * on every load, not once: room `WORKSHOP_ROOM_INDEX` is always the 작업실, every other 작업실 falls back to 빈 방,
 * and furniture whose room no longer accepts it moves into furniture storage instead of being dropped.
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
  // Phase 8 UI pass: the 작업실 is permanently room `WORKSHOP_ROOM_INDEX`. A save that put it somewhere else (or
  // nowhere) is migrated onto room 1 with its level; the old room falls back to 빈 방. Furniture that no longer fits
  // its room is moved into furniture storage below — nothing is destroyed by the migration.
  const oldWorkshop = rooms.findIndex((x, i) => i !== WORKSHOP_ROOM_INDEX && x.purpose === 'workshop');
  if (rooms[WORKSHOP_ROOM_INDEX].purpose !== 'workshop') {
    rooms[WORKSHOP_ROOM_INDEX] = { purpose: 'workshop', level: Math.max(1, oldWorkshop >= 0 ? rooms[oldWorkshop].level : 1) };
  }
  for (let i = 0; i < rooms.length; i++) if (i !== WORKSHOP_ROOM_INDEX && rooms[i].purpose === 'workshop') rooms[i] = freshRoom();
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

  return {
    version: SHIP_STATE_VERSION_CURRENT,
    rooms, generatorLevel, storageLevel, furniture, furnitureStorage, presets, plots,
    nameLocked: r.nameLocked === true,
  };
}

/** Load from localStorage; `fresh` = nothing valid was stored (first run). */
export function loadState(): { state: ShipState; fresh: boolean } {
  const s = storage();
  if (!s) return { state: freshState(), fresh: true };
  let raw: unknown = null;
  try {
    const text = s.getItem(SHIP_STORAGE_KEY);
    if (text) raw = JSON.parse(text);
  } catch { raw = null; }
  if (!raw || typeof raw !== 'object') return { state: freshState(), fresh: true };
  return { state: sanitize(raw), fresh: false };
}

export function writeState(state: ShipState): boolean {
  const s = storage();
  if (!s) return false;
  try { s.setItem(SHIP_STORAGE_KEY, JSON.stringify(state)); return true; } catch { return false; }
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

  /** Queue the state into the server profile (`profile:set ship`); no-op offline. */
  upload(): void {
    const p = this.profile();
    if (!p || !p.available || typeof p.set !== 'function') return;
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
