import type { ItemInstance, LootRef, SocketSlot } from '@/shared';
import { SOCKET_SLOTS, STASH_COLS, STASH_ROWS, STASH_STORAGE_KEY } from '@/shared';
import { Grid, type DefLookup } from './Grid';

/* ────────────────────────────────────────────────────────────────────────────
 * 함선 창고 (ship stash, 2026-09-06): a fixed STASH_COLS × STASH_ROWS grid that persists in localStorage
 * (`scav.stash`) across reloads, missions and deaths. Only the hub Tab screen shows it; the bag / loadout keep
 * their own reset policy. Uids are session-local, so the save carries positions + instance extras and fresh
 * instances are minted on load (attachments inside sockets are serialised recursively).
 * ──────────────────────────────────────────────────────────────────────────── */

const SAVE_VERSION = 1;
/** Debounce so a drag session writes once, not per cell. */
const SAVE_DELAY_MS = 350;

interface SavedItem {
  defId: string;
  qty: number;
  rotated: boolean;
  x: number;
  y: number;
  durability?: number;
  ammoInMag?: number;
  sockets?: Partial<Record<SocketSlot, Omit<SavedItem, 'x' | 'y' | 'rotated'>>>;
}

interface SaveFile { v: number; items: SavedItem[] }

function storage(): Storage | null {
  try {
    const s = window.localStorage;
    const probe = '__scav_probe__';
    s.setItem(probe, '1'); s.removeItem(probe);
    return s;
  } catch { return null; }
}

function serializeExtras(item: ItemInstance): Pick<SavedItem, 'defId' | 'qty' | 'durability' | 'ammoInMag' | 'sockets'> {
  const out: Pick<SavedItem, 'defId' | 'qty' | 'durability' | 'ammoInMag' | 'sockets'> = { defId: item.defId, qty: item.qty };
  if (item.durability !== undefined) out.durability = item.durability;
  if (item.ammoInMag !== undefined) out.ammoInMag = item.ammoInMag;
  if (item.sockets) {
    const sockets: SavedItem['sockets'] = {};
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

export class Stash {
  readonly grid: Grid;
  private savedVersion = -1;
  private timer: number | null = null;
  private onPageHide = (): void => this.flush();

  constructor(private readonly getDef: DefLookup, private readonly loot: LootRef) {
    this.grid = new Grid(STASH_COLS, STASH_ROWS, getDef);
    this.load();
    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener('beforeunload', this.onPageHide);
  }

  get count(): number { return this.grid.count; }
  items(): ItemInstance[] { return this.grid.items().map((p) => p.item); }

  /** Call after any mutation that may have touched the stash grid (cheap: compares `grid.version`). */
  markDirty(): void {
    if (this.grid.version === this.savedVersion) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { this.timer = null; this.flush(); }, SAVE_DELAY_MS);
  }

  /** Write immediately (page hide, dispose). */
  flush(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    if (this.grid.version === this.savedVersion) return;
    this.savedVersion = this.grid.version;
    const s = storage();
    if (!s) return;
    const items: SavedItem[] = this.grid.items().map((p) => ({ ...serializeExtras(p.item), rotated: p.item.rotated, x: p.x, y: p.y }));
    const file: SaveFile = { v: SAVE_VERSION, items };
    try { s.setItem(STASH_STORAGE_KEY, JSON.stringify(file)); } catch { /* quota / private mode */ }
  }

  private load(): void {
    const s = storage();
    if (!s) return;
    let file: SaveFile | null = null;
    try {
      const raw = s.getItem(STASH_STORAGE_KEY);
      if (raw) file = JSON.parse(raw) as SaveFile;
    } catch { file = null; }
    if (!file || !Array.isArray(file.items)) { this.savedVersion = this.grid.version; return; }
    const pending: ItemInstance[] = [];
    for (const sv of file.items) {
      const item = this.revive(sv);
      if (!item) continue;
      const x = Number(sv.x), y = Number(sv.y);
      if (Number.isInteger(x) && Number.isInteger(y) && this.grid.place(item, x, y, !!sv.rotated)) continue;
      pending.push(item);
    }
    // anything whose cell was taken (corrupt / overlapping save) is auto-placed; what does not fit is dropped
    for (const item of pending) if (!this.grid.autoPlace(item)) console.warn(`[Stash] no room for '${item.defId}' on load — discarded`);
    this.savedVersion = this.grid.version;
  }

  private revive(sv: Omit<SavedItem, 'x' | 'y' | 'rotated'> & { rotated?: boolean }): ItemInstance | null {
    if (!sv || typeof sv.defId !== 'string' || !this.getDef(sv.defId)) { if (sv?.defId) console.warn(`[Stash] unknown item '${sv.defId}' dropped`); return null; }
    const qty = Math.max(1, Math.floor(Number(sv.qty) || 1));
    const item = this.loot.createItem(sv.defId, qty);
    if (typeof sv.durability === 'number') item.durability = Math.max(0, sv.durability);
    if (typeof sv.ammoInMag === 'number') item.ammoInMag = Math.max(0, Math.floor(sv.ammoInMag));
    if (sv.sockets && typeof sv.sockets === 'object') {
      for (const slot of SOCKET_SLOTS) {
        const att = sv.sockets[slot];
        if (!att) continue;
        const inst = this.revive(att);
        if (!inst) continue;
        if (!item.sockets) item.sockets = {};
        item.sockets[slot] = inst;
      }
    }
    return item;
  }

  dispose(): void {
    this.flush();
    window.removeEventListener('pagehide', this.onPageHide);
    window.removeEventListener('beforeunload', this.onPageHide);
  }
}
