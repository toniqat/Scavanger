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
 * ──────────────────────────────────────────────────────────────────────────── */

const SAVE_VERSION = 2;
/** Guard against a corrupt / hostile save inflating the DOM. */
const MAX_COLS = 40;
const MAX_ROWS = 200;
/** Debounce so a drag session writes once, not per cell. */
const SAVE_DELAY_MS = 350;

interface SaveFile { v: number; items: SavedPlacement[]; cols?: number; rows?: number }

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
    const file: SaveFile = { v: SAVE_VERSION, cols: this.grid.cols, rows: this.grid.rows, items: this.grid.items().map(serializePlacement) };
    writeSaveFile(STASH_STORAGE_KEY, file);
  }

  private load(): void {
    const file = readSaveFile<SaveFile>(STASH_STORAGE_KEY);
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
