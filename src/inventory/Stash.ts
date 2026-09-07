import type { ItemInstance, LootRef } from '@/shared';
import { STASH_COLS, STASH_ROWS, STASH_STORAGE_KEY } from '@/shared';
import { Grid, type DefLookup } from './Grid';
import { readSaveFile, reviveItem, savedCell, serializePlacement, writeSaveFile, type SavedPlacement } from './Serialize';

/* ────────────────────────────────────────────────────────────────────────────
 * 함선 창고 (ship stash, 2026-09-06): a STASH_COLS × STASH_ROWS grid (default) that persists in localStorage
 * (`scav.stash`) across reloads, missions and deaths. Only the hub Tab screen shows it; the bag / loadout keep
 * their own reset policy (and, since Phase 5, their own save — `Loadout.ts`). Uids are session-local, so the
 * save carries positions + instance extras and fresh instances are minted on load (`Serialize.ts`, shared with
 * the loadout save; attachments inside sockets are serialised recursively).
 * Phase 6 (ship housing): the grid size is persisted too (`cols` / `rows`, save v2 — v1 files migrate to the
 * default size) and `resize()` grows it for the 창고 facility; shrinking is refused while an item would fall outside.
 * Phase 7 (server profile): every write also hands the file to `onSaved` (→ `ctx.net.profile.set('stash', file)`), and
 * `loadFrom(doc)` replaces the contents with a server document (same shape as the file; the local file is rewritten
 * without echoing the document back).
 * ──────────────────────────────────────────────────────────────────────────── */

const SAVE_VERSION = 2;
/**
 * 기본 지급품 flag (2026-09-07 fix). The grant used to key off `Stash.firstRun` (no `scav.stash` file), which missed
 * every profile made before 기본 지급품 existed and every profile whose local file was written before the server
 * document arrived. This key records the grant per **browser profile** instead, deliberately outside the stash file
 * so that a server document replacing the stash cannot make the grant repeat every session:
 *   `none`    — never handed out
 *   `pending` — handed out locally, not yet reconciled with a server profile (the upload went up as a `fresh` doc,
 *               so an empty server 창고 may still overwrite it — `net:profileLoaded` re-checks exactly once)
 *   `done`    — settled; never granted again
 */
export const STARTER_GRANT_KEY = 'scav.grant';
export type StarterGrantState = 'none' | 'pending' | 'done';

export function starterGrantState(): StarterGrantState {
  try {
    const v = window.localStorage.getItem(STARTER_GRANT_KEY);
    return v === 'done' ? 'done' : v === 'pending' ? 'pending' : 'none';
  } catch { return 'none'; }
}

export function setStarterGrantState(state: StarterGrantState): void {
  try { window.localStorage.setItem(STARTER_GRANT_KEY, state); } catch { /* storage unavailable */ }
}
/** Guard against a corrupt / hostile save inflating the DOM. */
const MAX_COLS = 40;
const MAX_ROWS = 200;
/** Debounce so a drag session writes once, not per cell. */
const SAVE_DELAY_MS = 350;

export interface StashSaveFile { v: number; items: SavedPlacement[]; cols?: number; rows?: number }

export class Stash {
  readonly grid: Grid;
  private savedVersion = -1;
  private timer: number | null = null;
  private onPageHide = (): void => this.flush();
  /** Called after every successful write with the file just written (Phase 7 profile upload). */
  onSaved: ((file: StashSaveFile) => void) | null = null;

  /**
   * True when no `scav.stash` file existed at startup — a profile that has never had a stash. `InventorySystem`
   * uses it to decide whether the 기본 지급품 grant goes up as a `fresh` document (a server profile still wins over
   * it); **whether** to grant is decided by `starterGrantState()`, not by this flag (2026-09-07 fix).
   */
  readonly firstRun: boolean;

  constructor(private readonly getDef: DefLookup, private readonly loot: LootRef) {
    this.grid = new Grid(STASH_COLS, STASH_ROWS, getDef);
    const file = readSaveFile<StashSaveFile>(STASH_STORAGE_KEY);
    this.firstRun = file === null;
    this.load(file);
    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener('beforeunload', this.onPageHide);
  }

  get count(): number { return this.grid.count; }
  items(): ItemInstance[] { return this.grid.items().map((p) => p.item); }
  get cols(): number { return this.grid.cols; }
  get rows(): number { return this.grid.rows; }

  /**
   * Change the grid size. Growing keeps every item where it is; shrinking is refused (false, nothing changes) when
   * any placement would leave the new bounds. Bumps `grid.version`, so the next `markDirty()` persists it.
   */
  resize(cols: number, rows: number): boolean {
    const c = Math.floor(cols), r = Math.floor(rows);
    if (!Number.isFinite(c) || !Number.isFinite(r) || c < 1 || r < 1 || c > MAX_COLS || r > MAX_ROWS) return false;
    if (c === this.grid.cols && r === this.grid.rows) return true;
    for (const p of this.grid.items()) {
      const { w, h } = this.grid.footprintOf(p.item);
      if (p.x + w > c || p.y + h > r) return false;
    }
    // every item is in bounds, so resize keeps all of them (nothing overflows)
    const overflow = this.grid.resize(c, r);
    if (overflow.length > 0) console.warn(`[Stash] resize dropped ${overflow.length} item(s) unexpectedly`);
    return true;
  }

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
    const file = this.saveFile();
    if (writeSaveFile(STASH_STORAGE_KEY, file)) this.onSaved?.(file);
  }

  /** The current contents in file form (what `flush` writes / uploads). */
  saveFile(): StashSaveFile {
    return { v: SAVE_VERSION, cols: this.grid.cols, rows: this.grid.rows, items: this.grid.items().map(serializePlacement) };
  }

  /** True when `doc` looks like a stash file (server profile document). */
  static isSaveFile(doc: unknown): doc is StashSaveFile {
    return !!doc && typeof doc === 'object' && Array.isArray((doc as StashSaveFile).items);
  }

  /**
   * Phase 7: replace the contents with a server document (same shape as the file). The grid is cleared first; the
   * local file is rewritten right away without `onSaved` (no echo back to the server). False when `doc` is not a save.
   */
  loadFrom(doc: unknown): boolean {
    if (!Stash.isSaveFile(doc)) return false;
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.grid.clear();
    this.load(doc);
    this.grid.version++;
    this.savedVersion = this.grid.version;
    writeSaveFile(STASH_STORAGE_KEY, this.saveFile());
    return true;
  }

  private load(file: StashSaveFile | null): void {
    if (!file || !Array.isArray(file.items)) { this.savedVersion = this.grid.version; return; }
    // v1 saves carry no size → the default STASH_COLS × STASH_ROWS; v2 restores the persisted grid
    const cols = Math.floor(Number(file.cols)), rows = Math.floor(Number(file.rows));
    if (Number.isFinite(cols) && Number.isFinite(rows) && cols >= 1 && rows >= 1 && cols <= MAX_COLS && rows <= MAX_ROWS
      && (cols !== this.grid.cols || rows !== this.grid.rows)) {
      this.grid.resize(cols, rows);
    }
    const pending: ItemInstance[] = [];
    for (const sv of file.items) {
      const item = reviveItem(sv, this.getDef, this.loot, 'Stash');
      if (!item) continue;
      const cell = savedCell(sv);
      if (cell && this.grid.place(item, cell.x, cell.y, !!sv.rotated)) continue;
      pending.push(item);
    }
    // anything whose cell was taken (corrupt / overlapping save) is auto-placed; what does not fit is dropped
    for (const item of pending) if (!this.grid.autoPlace(item)) console.warn(`[Stash] no room for '${item.defId}' on load — discarded`);
    this.savedVersion = this.grid.version;
  }

  dispose(): void {
    this.flush();
    window.removeEventListener('pagehide', this.onPageHide);
    window.removeEventListener('beforeunload', this.onPageHide);
  }
}
