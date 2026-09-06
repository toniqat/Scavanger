import type { LoadoutPreset, PlacedFurniture, RoomState, ShipState, StoredFurniture } from '@/shared';
import { FURNITURE_DEF_MAP, IMPLANT_IDS, SHIP_ROOM_COUNT, SHIP_STATE_VERSION, SHIP_STORAGE_KEY } from '@/shared';
import { canPlaceAt, facilityMaxLevel, furnitureMaxLevel, isRoomPurpose } from './Rules';

/* ────────────────────────────────────────────────────────────────────────────
 * ShipState persistence: fresh state, load + sanitise + migrate, debounced save with a pagehide flush. Same shape as
 * inventory/Stash.ts (try/catch around every localStorage touch, SAVE_DELAY_MS debounce). Uids of placed furniture
 * are `f-<n>`; `nextUid` continues after the highest one found in the save.
 * ──────────────────────────────────────────────────────────────────────────── */

const SAVE_DELAY_MS = 350;
/** Convenience for a first run: one 총기 작업대 waiting in furniture storage. */
const STARTER_FURNITURE: StoredFurniture[] = [{ defId: 'furn_bench_gun', level: 1, qty: 1 }];

export function storage(): Storage | null {
  try {
    const s = window.localStorage;
    const probe = '__scav_probe__';
    s.setItem(probe, '1'); s.removeItem(probe);
    return s;
  } catch { return null; }
}

export function freshRoom(): RoomState { return { purpose: 'empty', level: 0 }; }

export function freshState(): ShipState {
  return {
    version: SHIP_STATE_VERSION,
    rooms: Array.from({ length: SHIP_ROOM_COUNT }, freshRoom),
    generatorLevel: 0,
    storageLevel: 0,
    furniture: [],
    furnitureStorage: STARTER_FURNITURE.map((s) => ({ ...s })),
    presets: [],
  };
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
 * are dropped or clamped, duplicated uids re-minted. Older versions migrate here (none yet — version 1).
 */
export function sanitize(raw: unknown): ShipState {
  const fresh = freshState();
  if (!raw || typeof raw !== 'object') return fresh;
  const r = raw as Partial<ShipState> & Record<string, unknown>;
  const version = int(r.version, 0);
  if (version > SHIP_STATE_VERSION) console.warn(`[housing] ship state v${version} is newer than v${SHIP_STATE_VERSION} — loading best-effort`);

  const rooms: RoomState[] = [];
  const srcRooms = Array.isArray(r.rooms) ? r.rooms : [];
  for (let i = 0; i < SHIP_ROOM_COUNT; i++) {
    const s = srcRooms[i] as Partial<RoomState> | undefined;
    const purpose = isRoomPurpose(s?.purpose) ? s!.purpose! : 'empty';
    const maxLv = purpose === 'workshop' ? facilityMaxLevel('workshop') : purpose === 'range' ? facilityMaxLevel('range') : 1;
    const level = purpose === 'empty' ? 0 : int(s?.level, 1, 1, maxLv);
    rooms.push({ purpose, level });
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
    if (room < 0 || room >= SHIP_ROOM_COUNT || !canPlaceAt(partial, room, def, item.x, item.y, item.yaw)) {
      console.warn(`[housing] '${def.id}' at room ${room} (${item.x}, ${item.y}) does not fit — dropped`);
      continue;
    }
    if (!/^f-\d+$/.test(item.uid) || seen.has(item.uid)) pending.push(item);
    else seen.add(item.uid);
    furniture.push(item);
  }
  let next = maxUidIndex(furniture.filter((f) => !pending.includes(f)));
  for (const item of pending) item.uid = `f-${++next}`;

  const furnitureStorage: StoredFurniture[] = [];
  for (const s of Array.isArray(r.furnitureStorage) ? (r.furnitureStorage as Partial<StoredFurniture>[]) : []) {
    if (!s || typeof s.defId !== 'string') continue;
    const def = FURNITURE_DEF_MAP.get(s.defId);
    if (!def) continue;
    const level = int(s.level, 1, 1, furnitureMaxLevel(def));
    const qty = int(s.qty, 0, 0);
    if (qty <= 0) continue;
    const existing = furnitureStorage.find((e) => e.defId === def.id && e.level === level);
    if (existing) existing.qty += qty; else furnitureStorage.push({ defId: def.id, level, qty });
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

  return { version: SHIP_STATE_VERSION, rooms, generatorLevel, storageLevel, furniture, furnitureStorage, presets };
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

/** Debounced writer with a pagehide / beforeunload flush. */
export class ShipStore {
  private timer: number | null = null;
  private dirty = false;
  private onPageHide = (): void => this.flush();

  constructor(private readonly getState: () => ShipState) {
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
  }

  dispose(): void {
    this.flush();
    window.removeEventListener('pagehide', this.onPageHide);
    window.removeEventListener('beforeunload', this.onPageHide);
  }
}
