import type { LoadoutSlot } from '@/shared';
import { LOADOUT_STORAGE_KEY, QUICK_SLOTS } from '@/shared';
import { readSaveFile, writeSaveFile, type SavedExtras, type SavedPlacement } from './Serialize';

/* ────────────────────────────────────────────────────────────────────────────
 * Loadout persistence (Phase 5, 2026-09-06): the equipment slots, the bag contents (positions / rotation /
 * durability / rounds / sockets) and the quick-use wheel live in localStorage `scav.loadout` so the bag the player
 * prepared in the ship survives a reload. Policy (docs/PHASE5-PLAN.md §5 / §8-2):
 *   - loaded ONCE at `InventorySystem.init` → from then on the session state is the truth;
 *   - saved (debounced) after every change in the hub phase, on `game:complete` and on pagehide;
 *   - every starter reset (`applyStarter`) saves the starter immediately so a reload cannot resurrect a bag that
 *     was lost to death / abort;
 *   - a missing or empty save keeps the old behaviour (starter kit on the first `hub:entered`).
 * The system captures the snapshot (`capture`) — this store only owns the timing and the file.
 * ──────────────────────────────────────────────────────────────────────────── */

export const LOADOUT_SAVE_VERSION = 1;
/** Debounce so a drag session writes once, not per cell. */
const SAVE_DELAY_MS = 350;

export interface LoadoutSave {
  v: number;
  /** Equipped items by slot (absent = empty). */
  slots: Partial<Record<LoadoutSlot, SavedExtras>>;
  /** Bag stacks with their grid placement. */
  bag: SavedPlacement[];
  /** Quick-use wheel: index into `bag` per wheel direction (null = empty). */
  quick: (number | null)[];
}

/** True when the save holds nothing (treated like no save → starter kit on the first hub entry). */
export function isEmptyLoadoutSave(save: LoadoutSave | null): boolean {
  if (!save) return true;
  return Object.values(save.slots).every((v) => !v) && save.bag.length === 0;
}

/** Read + sanitise the save file; null when missing / corrupt. */
export function loadLoadoutSave(): LoadoutSave | null {
  return sanitizeLoadoutSave(readSaveFile<Partial<LoadoutSave>>(LOADOUT_STORAGE_KEY));
}

/**
 * Sanitise a save-shaped object (the localStorage file, the server profile doc or a raid-state blob); null when it is
 * not a loadout save. Extra per-entry fields (e.g. `searched` in a raid state) pass through untouched.
 */
export function sanitizeLoadoutSave(file: unknown): LoadoutSave | null {
  if (!file || typeof file !== 'object') return null;
  const f = file as Partial<LoadoutSave>;
  if (typeof f.v !== 'number' || f.v < 1 || f.v > LOADOUT_SAVE_VERSION) return null;
  const slots: LoadoutSave['slots'] = {};
  if (f.slots && typeof f.slots === 'object') {
    for (const [k, v] of Object.entries(f.slots)) if (v && typeof v === 'object') slots[k as LoadoutSlot] = v as SavedExtras;
  }
  const bag = Array.isArray(f.bag) ? f.bag.filter((e): e is SavedPlacement => !!e && typeof e === 'object') : [];
  const quick: (number | null)[] = [];
  for (let i = 0; i < QUICK_SLOTS; i++) {
    const q = Array.isArray(f.quick) ? f.quick[i] : null;
    quick.push(typeof q === 'number' && Number.isInteger(q) && q >= 0 && q < bag.length ? q : null);
  }
  return { v: f.v, slots, bag, quick };
}

export class LoadoutStore {
  private timer: number | null = null;
  private pendingReason: string | null = null;
  private onPageHide = (): void => this.flush();

  /** `onSaved(reason, file)` runs after every successful write (event + Phase 7 profile upload). */
  constructor(private readonly capture: () => LoadoutSave, private readonly onSaved: (reason: string, file: LoadoutSave) => void) {
    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener('beforeunload', this.onPageHide);
  }

  /** Schedule a debounced write (a drag session writes once). The first reason of a burst wins. */
  markDirty(reason: string): void {
    if (this.pendingReason === null) this.pendingReason = reason;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { this.timer = null; this.flush(); }, SAVE_DELAY_MS);
  }

  /** Write now, unconditionally (starter resets, mission end). Cancels a pending debounce. */
  saveNow(reason: string): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.pendingReason = null;
    const file = this.capture();
    if (writeSaveFile(LOADOUT_STORAGE_KEY, file)) this.onSaved(reason, file);
  }

  /** Write the pending change, if any (page hide, dispose). */
  flush(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    const reason = this.pendingReason;
    if (reason === null) return;
    this.saveNow(reason);
  }

  dispose(): void {
    this.flush();
    window.removeEventListener('pagehide', this.onPageHide);
    window.removeEventListener('beforeunload', this.onPageHide);
  }
}
