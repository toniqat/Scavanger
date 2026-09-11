import type { LoadoutSlot } from '@/shared';
import { LOADOUT_STORAGE_KEY, QUICK_SLOTS } from '@/shared';
import { readSaveFile, writeSaveFile, type SavedExtras, type SavedPlacement } from './Serialize';
/* 2026-09-11 (E-5 · E-6): 솔로 레이드 표식 · 창고와 합친 디바운스 — see `LoadoutStore` */

/* ────────────────────────────────────────────────────────────────────────────
 * Loadout persistence (Phase 5, 2026-09-06): the equipment slots, the bag contents (positions / rotation /
 * durability / rounds / sockets) and the quick-use wheel live in localStorage `scav.loadout` so the bag the player
 * prepared in the ship survives a reload. Policy (docs/DECISIONS.md Phase 5):
 *   - loaded ONCE at `InventorySystem.init` → from then on the session state is the truth;
 *   - saved (debounced) after every change in the hub phase, on `game:complete` and on pagehide;
 *   - every starter reset (`applyStarter`) saves the starter immediately so a reload cannot resurrect a bag that
 *     was lost to death / abort;
 *   - a missing or empty save keeps the old behaviour (starter kit on the first `hub:entered`).
 * The system captures the snapshot (`capture`) — this store only owns the timing and the file.
 *
 * **v2 (2026-09-09)**: the wheel is its own container, so `quick[i]` is the **stack itself** (`SavedExtras`, no grid
 * cell) instead of an index into `bag`. A v1 file is migrated on read (`sanitizeLoadoutSave`): every bag entry a
 * v1 `quick` index pointed at is **moved out of `bag` into `quick`** — its grid cells free up, exactly what the
 * live model does. Every write is v2.
 * ──────────────────────────────────────────────────────────────────────────── */

export const LOADOUT_SAVE_VERSION = 2;
/** Debounce so a drag session writes once, not per cell. */
const SAVE_DELAY_MS = 350;

export interface LoadoutSave {
  v: number;
  /** Equipped items by slot (absent = empty). */
  slots: Partial<Record<LoadoutSlot, SavedExtras>>;
  /** Bag stacks with their grid placement. */
  bag: SavedPlacement[];
  /** Quick-use wheel: the stack in each wheel direction (null = empty). v2 — a v1 file's bag indices are migrated on read. */
  quick: (SavedExtras | null)[];
}

/** True when the save holds nothing (treated like no save → starter kit on the first hub entry). */
export function isEmptyLoadoutSave(save: LoadoutSave | null): boolean {
  if (!save) return true;
  return Object.values(save.slots).every((v) => !v) && save.bag.length === 0 && save.quick.every((q) => !q);
}

/** Read + sanitise the save file; null when missing / corrupt. */
export function loadLoadoutSave(): LoadoutSave | null {
  return sanitizeLoadoutSave(readSaveFile<Partial<LoadoutSave>>(LOADOUT_STORAGE_KEY));
}

/**
 * Sanitise a save-shaped object (the localStorage file, the server profile doc, a raid-state blob or a crew card);
 * null when it is not a loadout save. Extra per-entry fields (e.g. `searched` in a raid state) pass through untouched.
 * Always returns the **v2 shape** — a v1 document (quick = bag indices) is migrated here, see the header.
 */
export function sanitizeLoadoutSave(file: unknown): LoadoutSave | null {
  if (!file || typeof file !== 'object') return null;
  const f = file as Partial<LoadoutSave> & { quick?: unknown[] };
  if (typeof f.v !== 'number' || f.v < 1 || f.v > LOADOUT_SAVE_VERSION) return null;
  const slots: LoadoutSave['slots'] = {};
  if (f.slots && typeof f.slots === 'object') {
    for (const [k, v] of Object.entries(f.slots)) if (v && typeof v === 'object') slots[k as LoadoutSlot] = v as SavedExtras;
  }
  let bag = Array.isArray(f.bag) ? f.bag.filter((e): e is SavedPlacement => !!e && typeof e === 'object') : [];
  const rawQuick = Array.isArray(f.quick) ? f.quick : [];
  const quick: (SavedExtras | null)[] = new Array<SavedExtras | null>(QUICK_SLOTS).fill(null);
  if (f.v === 1) {
    // v1: `quick[i]` = index into `bag`. Lift those stacks out of the grid into the wheel (one slot per stack).
    const lifted = new Set<number>();
    for (let i = 0; i < QUICK_SLOTS; i++) {
      const q = rawQuick[i];
      if (typeof q !== 'number' || !Number.isInteger(q) || q < 0 || q >= bag.length || lifted.has(q)) continue;
      const { rotated: _r, x: _x, y: _y, ...extras } = bag[q];
      quick[i] = extras as SavedExtras;
      lifted.add(q);
    }
    if (lifted.size > 0) bag = bag.filter((_, i) => !lifted.has(i));
  } else {
    for (let i = 0; i < QUICK_SLOTS; i++) {
      const q = rawQuick[i];
      quick[i] = q && typeof q === 'object' && typeof (q as SavedExtras).defId === 'string' ? (q as SavedExtras) : null;
    }
  }
  return { v: LOADOUT_SAVE_VERSION, slots, bag, quick };
}

/**
 * 2026-09-11 (E-5): the solo-raid marker inside the **local** loadout file (`{...save, raidSeed}`). It lives in the same
 * document as the kit it protects, so deleting only the solo raid save (`scav.soloraid`) no longer brings the pre-raid
 * kit back: game/ sees a marker without a matching save at boot and fails the raid. Never uploaded, never part of
 * `LoadoutSave` (`sanitizeLoadoutSave` drops it), never in a raid blob or crew card.
 */
const RAID_SEED_FIELD = 'raidSeed';

export class LoadoutStore {
  private timer: number | null = null;
  private pendingReason: string | null = null;
  private onPageHide = (): void => this.flush();
  /** E-6: when set, `markDirty` hands the debounce to the owner (`InventorySystem` saves 창고 + 로드아웃 together). */
  schedule: (() => void) | null = null;
  /** E-5: seed of the solo raid the saved kit was carried into (null = none). Read from the file once, here. */
  private _raidSeed: number | null = null;

  /** `onSaved(reason, file)` runs after every successful write (event + Phase 7 profile upload). */
  constructor(private readonly capture: () => LoadoutSave, private readonly onSaved: (reason: string, file: LoadoutSave) => void) {
    const raw = readSaveFile<Record<string, unknown>>(LOADOUT_STORAGE_KEY);
    const seed = raw && typeof raw === 'object' ? raw[RAID_SEED_FIELD] : undefined;
    this._raidSeed = typeof seed === 'number' && Number.isFinite(seed) ? seed : null;
    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener('beforeunload', this.onPageHide);
  }

  /** E-5: the solo raid marker as stored (null = the kit is not out on a solo raid). */
  get raidSeed(): number | null { return this._raidSeed; }

  /** E-5: a solo raid with `seed` starts — the kit on disk is now "out on that raid" (local file only, no upload / event). */
  markRaid(seed: number): void {
    if (!Number.isFinite(seed)) return;
    this._raidSeed = seed;
    writeSaveFile(LOADOUT_STORAGE_KEY, this.withMarker(this.capture()));
  }

  /** E-5: the solo raid ended (extraction · 레이드 실패 · abort) — drop the marker (rewrites the local file if it had one). */
  clearRaid(): void {
    if (this._raidSeed === null) return;
    this._raidSeed = null;
    writeSaveFile(LOADOUT_STORAGE_KEY, this.capture());
  }

  private withMarker(file: LoadoutSave): LoadoutSave {
    return this._raidSeed === null ? file : ({ ...file, [RAID_SEED_FIELD]: this._raidSeed } as LoadoutSave);
  }

  /** Schedule a debounced write (a drag session writes once). The first reason of a burst wins. */
  markDirty(reason: string): void {
    if (this.pendingReason === null) this.pendingReason = reason;
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    if (this.schedule) { this.schedule(); return; }
    this.timer = window.setTimeout(() => { this.timer = null; this.flush(); }, SAVE_DELAY_MS);
  }

  /** Write now, unconditionally (starter resets, mission end). Cancels a pending debounce. */
  saveNow(reason: string): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.pendingReason = null;
    const file = this.capture();
    // the marker stays on disk while the raid runs; the uploaded / announced document never carries it
    if (writeSaveFile(LOADOUT_STORAGE_KEY, this.withMarker(file))) this.onSaved(reason, file);
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
