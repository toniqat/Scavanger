import type { ItemInstance, LootRef, SocketSlot } from '@/shared';
import { SOCKET_SLOTS, normalizeMealQuality, slotKey } from '@/shared';
/* 2026-09-13 (library series, user's decision): the old per-skill book · disc · record ids → the new series' vol. 1 (`data/item_aliases.csv`) */
import { resolveItemAlias } from '@/shared';
import type { DefLookup, Placement } from './Grid';

/* ────────────────────────────────────────────────────────────────────────────
 * Item (de)serialisation shared by the ship stash (`Stash.ts`) and the loadout save (`Loadout.ts`), Phase 5.
 * Uids are session-local, so a save carries def id + qty + per-instance extras (`durability` / `ammoInMag` /
 * nested `sockets`) and fresh instances are minted on load through `LootRef.createItem`.
 * ──────────────────────────────────────────────────────────────────────────── */

/** One item without a grid position (equipment slots, socket contents). */
export interface SavedExtras {
  defId: string;
  qty: number;
  durability?: number;
  ammoInMag?: number;
  sockets?: Partial<Record<SocketSlot, SavedExtras>>;
  /**
   * 2026-09-12 (item recovery contracts): `ItemInstance.raidFound`, written **only into the raid session blob**
   * (`parts/ProfileDocs.captureRaidState` adds it; `serializeExtras` does not, so stash · loadout have none). Omitted = no mark.
   */
  rf?: number;
  /**
   * 2026-09-13 (meal quality): `ItemInstance.quality` (★1 … `MEAL_QUALITY_MAX`). Unlike `rf`, `serializeExtras` writes it
   * itself — **into the stash · loadout documents and the raid blob alike**. Omitted = quality 0; `reviveItem` clamps it with `normalizeMealQuality`.
   */
  q?: number;
}

/** One item placed on a grid. */
export interface SavedPlacement extends SavedExtras {
  rotated: boolean;
  x: number;
  y: number;
}

/** localStorage, or null when it is unavailable / blocked (private mode, quota, sandbox). */
export function safeStorage(): Storage | null {
  try {
    const s = window.localStorage;
    const probe = '__scav_probe__';
    s.setItem(probe, '1'); s.removeItem(probe);
    return s;
  } catch { return null; }
}

/** Parse the JSON under `key`; null when missing / corrupt / storage blocked. */
export function readSaveFile<T>(key: string): T | null {
  const s = safeStorage();
  if (!s) return null;
  try {
    const raw = s.getItem(slotKey(key));
    return raw ? (JSON.parse(raw) as T) : null;
  } catch { return null; }
}

/**
 * Write `file` as JSON under `key`; false when storage is blocked / full.
 * 2026-09-09: the key goes through `slotKey` — every save here belongs to the **active character slot**.
 */
export function writeSaveFile(key: string, file: unknown): boolean {
  const s = safeStorage();
  if (!s) return false;
  try { s.setItem(slotKey(key), JSON.stringify(file)); return true; } catch { return false; }
}

export function serializeExtras(item: ItemInstance): SavedExtras {
  const out: SavedExtras = { defId: item.defId, qty: item.qty };
  if (item.durability !== undefined) out.durability = item.durability;
  if (item.ammoInMag !== undefined) out.ammoInMag = item.ammoInMag;
  const q = normalizeMealQuality(item.quality);   // 2026-09-13: meal quality (0 = no field)
  if (q > 0) out.q = q;
  if (item.sockets) {
    const sockets: SavedExtras['sockets'] = {};
    let any = false;
    for (const s of SOCKET_SLOTS) {
      const att = item.sockets[s];
      if (!att) continue;
      sockets[s] = serializeExtras(att);
      any = true;
    }
    if (any) out.sockets = sockets;
  }
  return out;
}

export function serializePlacement(p: Placement): SavedPlacement {
  return { ...serializeExtras(p.item), rotated: p.item.rotated, x: p.x, y: p.y };
}

/**
 * Mint a fresh instance from a saved entry (recursively for socket contents). Null — with a console warning —
 * when the def no longer exists; qty / durability / rounds are clamped to sane values. `tag` prefixes warnings.
 */
export function reviveItem(sv: SavedExtras | undefined | null, getDef: DefLookup, loot: LootRef, tag: string): ItemInstance | null {
  // 2026-09-13: every saved item id passes the alias table first — an old book · disc · record comes back as its series vol. 1
  const defId = sv && typeof sv.defId === 'string' ? resolveItemAlias(sv.defId) : null;
  if (!sv || !defId || !getDef(defId)) {
    if (sv?.defId) console.warn(`[${tag}] unknown item '${sv.defId}' dropped`);
    return null;
  }
  const qty = Math.max(1, Math.floor(Number(sv.qty) || 1));
  const item = loot.createItem(defId, qty);
  if (typeof sv.durability === 'number' && Number.isFinite(sv.durability)) item.durability = Math.max(0, sv.durability);
  if (typeof sv.ammoInMag === 'number' && Number.isFinite(sv.ammoInMag)) item.ammoInMag = Math.max(0, Math.floor(sv.ammoInMag));
  if (typeof sv.rf === 'number' && Number.isFinite(sv.rf)) item.raidFound = sv.rf >>> 0;   // 2026-09-12: raid blob only
  const q = normalizeMealQuality(sv.q);   // 2026-09-13: meal quality — stash · loadout · raid blob
  if (q > 0) item.quality = q;
  if (sv.sockets && typeof sv.sockets === 'object') {
    for (const slot of SOCKET_SLOTS) {
      const att = sv.sockets[slot];
      if (!att) continue;
      const inst = reviveItem(att, getDef, loot, tag);
      if (!inst) continue;
      if (!item.sockets) item.sockets = {};
      item.sockets[slot] = inst;
    }
  }
  return item;
}

/**
 * 2026-09-14 (gun balance — per-class sockets, user's decision "detach and hand back at load"): take every socketed attachment off `weapon`
 * that `loot.canAttach` refuses today (its class lost that socket, the attachment's `classes` narrowed) or that sits in a socket
 * other than its own. Returns them in `SOCKET_SLOTS` order with the socket they came from. The caller finds each a grid cell and,
 * when there is none, puts it back (`weapon.sockets[socket] = item` — it has no effect there, `computeWeaponStats` skips it):
 * an item is never dropped. An emptied `sockets` is deleted. Used by `Stash.load` and `parts/SocketRules`.
 */
export function detachForbiddenSockets(weapon: ItemInstance, getDef: DefLookup, loot: LootRef): Array<{ socket: SocketSlot; item: ItemInstance }> {
  const out: Array<{ socket: SocketSlot; item: ItemInstance }> = [];
  const sockets = weapon.sockets;
  if (!sockets) return out;
  for (const slot of SOCKET_SLOTS) {
    const att = sockets[slot];
    if (!att) continue;
    if (getDef(att.defId)?.attachment?.socket === slot && loot.canAttach(weapon, att)) continue;
    delete sockets[slot];
    out.push({ socket: slot, item: att });
  }
  if (Object.keys(sockets).length === 0) delete weapon.sockets;
  return out;
}

/** Integer grid coordinates of a saved placement, or null when corrupt. */
export function savedCell(sv: SavedPlacement): { x: number; y: number } | null {
  const x = Number(sv.x), y = Number(sv.y);
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 ? { x, y } : null;
}
