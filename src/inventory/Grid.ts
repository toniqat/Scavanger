import type { ItemDef, ItemInstance } from '@/shared';

export type DefLookup = (defId: string) => ItemDef | undefined;

export interface Placement {
  item: ItemInstance;
  x: number;
  y: number;
}

export interface Footprint { w: number; h: number }
export interface SlotHint { x: number; y: number; rotated: boolean }
export type Ignore = string | readonly string[];
/** Sentinel returned by `blockersAt` when the footprint leaves the grid. */
export const OOB = '__oob__';
/** `resize()` priority entry: place `item` first, preferably at (x, y). */
export interface PriorityPlacement { item: ItemInstance; x?: number; y?: number }
export interface GridSnapshot {
  cols: number;
  rows: number;
  placements: { item: ItemInstance; x: number; y: number; rotated: boolean; qty: number }[];
}

/**
 * Diablo-2 style occupancy grid. Pure logic, no DOM.
 * Cells store the uid of the item covering them. Items may span w×h cells and
 * be rotated (footprint becomes h×w). `place()` writes `item.rotated`.
 */
export class Grid {
  private _cols: number;
  private _rows: number;
  private cells: (string | null)[];
  private placements = new Map<string, Placement>();
  /** Bumped on every mutation; UI uses it to skip redundant re-renders. */
  version = 0;

  constructor(cols: number, rows: number, private readonly getDef: DefLookup) {
    this._cols = cols;
    this._rows = rows;
    this.cells = new Array(cols * rows).fill(null);
  }

  /** Dimensions change only through `resize()` / `restore()`. */
  get cols(): number { return this._cols; }
  get rows(): number { return this._rows; }

  /* ── queries ───────────────────────────────────────────────────────────── */

  footprintOf(item: ItemInstance, rotated: boolean = item.rotated): Footprint {
    const def = this.getDef(item.defId);
    if (!def) return { w: 1, h: 1 };
    return rotated ? { w: def.height, h: def.width } : { w: def.width, h: def.height };
  }

  inBounds(x: number, y: number, w: number, h: number): boolean {
    return x >= 0 && y >= 0 && x + w <= this.cols && y + h <= this.rows;
  }

  cellUid(x: number, y: number): string | null {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return null;
    return this.cells[y * this.cols + x];
  }

  /** Placement covering cell (x,y), if any. */
  at(x: number, y: number): Placement | undefined {
    const uid = this.cellUid(x, y);
    return uid ? this.placements.get(uid) : undefined;
  }

  get(uid: string): Placement | undefined { return this.placements.get(uid); }
  has(uid: string): boolean { return this.placements.has(uid); }
  items(): Placement[] { return Array.from(this.placements.values()); }
  get count(): number { return this.placements.size; }
  get isEmpty(): boolean { return this.placements.size === 0; }

  /** Number of occupied cells. */
  usedCells(): number {
    let n = 0;
    for (const c of this.cells) if (c) n++;
    return n;
  }

  /**
   * Distinct uids that would overlap the footprint, excluding `ignore` (the item
   * itself by default; pass extra uids when previewing swaps). Empty → free.
   * Out-of-bounds yields the sentinel `OOB`.
   */
  blockersAt(item: ItemInstance, x: number, y: number, rotated: boolean = item.rotated, ignore: Ignore = item.uid): string[] {
    const { w, h } = this.footprintOf(item, rotated);
    if (!this.inBounds(x, y, w, h)) return [OOB];
    const ign = typeof ignore === 'string' ? [ignore] : ignore;
    const found: string[] = [];
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        const uid = this.cells[yy * this.cols + xx];
        if (uid && !ign.includes(uid) && !found.includes(uid)) found.push(uid);
      }
    }
    return found;
  }

  canPlace(item: ItemInstance, x: number, y: number, rotated: boolean = item.rotated, ignore: Ignore = item.uid): boolean {
    return this.blockersAt(item, x, y, rotated, ignore).length === 0;
  }

  /** First free slot scanning row-major; tries `preferRotated` orientation first, then the other. */
  findFreeSlot(item: ItemInstance, preferRotated: boolean = item.rotated, ignore: Ignore = item.uid): SlotHint | null {
    const def = this.getDef(item.defId);
    const orientations = def && def.width !== def.height ? [preferRotated, !preferRotated] : [preferRotated];
    for (const rotated of orientations) {
      const { w, h } = this.footprintOf(item, rotated);
      for (let y = 0; y + h <= this.rows; y++) {
        for (let x = 0; x + w <= this.cols; x++) {
          if (this.canPlace(item, x, y, rotated, ignore)) return { x, y, rotated };
        }
      }
    }
    return null;
  }

  /** How many more units of `defId` existing stacks can absorb. */
  mergeCapacity(defId: string): number {
    const def = this.getDef(defId);
    if (!def || def.stackMax <= 1) return 0;
    let cap = 0;
    for (const p of this.placements.values()) if (p.item.defId === defId) cap += def.stackMax - p.item.qty;
    return cap;
  }

  /** Whether `autoPlace` would fully absorb the item (merge + free slot). Non-mutating. */
  canAbsorb(item: ItemInstance): boolean {
    if (this.placements.has(item.uid)) return false;
    if (item.qty <= this.mergeCapacity(item.defId)) return true;
    return this.findFreeSlot(item) !== null;
  }

  totalValue(): number {
    let v = 0;
    for (const p of this.placements.values()) {
      const def = this.getDef(p.item.defId);
      if (def) v += def.value * p.item.qty;
    }
    return v;
  }

  /* ── mutations ─────────────────────────────────────────────────────────── */

  place(item: ItemInstance, x: number, y: number, rotated: boolean = item.rotated): boolean {
    if (this.placements.has(item.uid)) return false;
    if (!this.canPlace(item, x, y, rotated, item.uid)) return false;
    item.rotated = rotated;
    const { w, h } = this.footprintOf(item, rotated);
    this.fill(item.uid, x, y, w, h);
    this.placements.set(item.uid, { item, x, y });
    this.version++;
    return true;
  }

  remove(uid: string): Placement | undefined {
    const p = this.placements.get(uid);
    if (!p) return undefined;
    const { w, h } = this.footprintOf(p.item);
    this.fill(null, p.x, p.y, w, h);
    this.placements.delete(uid);
    this.version++;
    return p;
  }

  clear(): void {
    this.cells.fill(null);
    this.placements.clear();
    this.version++;
  }

  /**
   * Merge `item.qty` into existing same-def stacks. Mutates `item.qty` and the
   * target stacks. Returns leftover qty (0 → item fully absorbed).
   */
  mergeIntoStacks(item: ItemInstance): number {
    const def = this.getDef(item.defId);
    if (!def || def.stackMax <= 1) return item.qty;
    for (const p of this.placements.values()) {
      if (item.qty <= 0) break;
      if (p.item.defId !== item.defId || p.item.uid === item.uid) continue;
      const room = def.stackMax - p.item.qty;
      if (room <= 0) continue;
      const moved = Math.min(room, item.qty);
      p.item.qty += moved;
      item.qty -= moved;
      this.version++;
    }
    return item.qty;
  }

  /** Move qty from `source` into the stack `targetUid`. Returns units moved. */
  mergeInto(source: ItemInstance, targetUid: string): number {
    const target = this.placements.get(targetUid);
    if (!target || target.item.defId !== source.defId || target.item.uid === source.uid) return 0;
    const def = this.getDef(source.defId);
    if (!def || def.stackMax <= 1) return 0;
    const moved = Math.min(def.stackMax - target.item.qty, source.qty);
    if (moved <= 0) return 0;
    target.item.qty += moved;
    source.qty -= moved;
    this.version++;
    return moved;
  }

  /**
   * All-or-nothing add: merge into stacks first, then place the remainder at the
   * first free slot. Returns false (and leaves everything untouched) if it can't fit.
   */
  autoPlace(item: ItemInstance): boolean {
    if (!this.canAbsorb(item)) return false;
    const left = this.mergeIntoStacks(item);
    if (left <= 0) return true;
    const slot = this.findFreeSlot(item);
    if (!slot) return false; // unreachable given canAbsorb, kept for safety
    return this.place(item, slot.x, slot.y, slot.rotated);
  }

  /** Re-position an item already in this grid. Restores the original placement on failure. */
  moveTo(uid: string, x: number, y: number, rotated?: boolean): boolean {
    const p = this.placements.get(uid);
    if (!p) return false;
    const rot = rotated ?? p.item.rotated;
    if (!this.canPlace(p.item, x, y, rot, uid)) return false;
    const prevRot = p.item.rotated;
    const { w, h } = this.footprintOf(p.item, prevRot);
    this.fill(null, p.x, p.y, w, h);
    p.item.rotated = rot;
    const fp = this.footprintOf(p.item, rot);
    this.fill(uid, x, y, fp.w, fp.h);
    p.x = x; p.y = y;
    this.version++;
    return true;
  }

  /**
   * Rotate in place around the anchor; if that doesn't fit, try nearby offsets
   * (nearest first). Returns false if no fit — caller should shake the tile.
   */
  rotate(uid: string): boolean {
    const p = this.placements.get(uid);
    if (!p) return false;
    const def = this.getDef(p.item.defId);
    if (!def) return false;
    if (def.width === def.height) return true; // square → no-op, still "succeeds"
    const rot = !p.item.rotated;
    if (this.moveTo(uid, p.x, p.y, rot)) return true;
    const reach = Math.max(def.width, def.height);
    const offsets: Array<[number, number]> = [];
    for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) if (dx || dy) offsets.push([dx, dy]);
    offsets.sort((a, b) => (a[0] * a[0] + a[1] * a[1]) - (b[0] * b[0] + b[1] * b[1]));
    for (const [dx, dy] of offsets) {
      if (this.moveTo(uid, p.x + dx, p.y + dy, rot)) return true;
    }
    return false;
  }

  /**
   * Change the grid size (bag equipped / removed). Items whose footprint still lies inside the new bounds keep
   * their cells; the rest are re-placed with `autoPlace` (largest first, so stacks may merge). Returns the items
   * that could not be kept — they are no longer in the grid and the caller must drop them or refuse the resize
   * (use `snapshot()` / `restore()` around the call for an all-or-nothing attempt).
   * `priority` items (e.g. the bag being unequipped) are placed first, before anything else: at their hint cell
   * when that is free and in bounds, else at the first free slot. A priority item that does not fit at all is
   * returned in the overflow list as well.
   */
  resize(cols: number, rows: number, priority: readonly PriorityPlacement[] = []): ItemInstance[] {
    const old = this.items();
    this._cols = Math.max(1, Math.floor(cols));
    this._rows = Math.max(1, Math.floor(rows));
    this.cells = new Array(this._cols * this._rows).fill(null);
    this.placements.clear();
    const overflow: ItemInstance[] = [];
    const prioritised = new Set<string>();
    for (const pr of priority) {
      prioritised.add(pr.item.uid);
      let placed = false;
      if (pr.x !== undefined && pr.y !== undefined) {
        placed = this.place(pr.item, pr.x, pr.y, pr.item.rotated) || this.place(pr.item, pr.x, pr.y, !pr.item.rotated);
      }
      if (!placed) placed = this.autoPlace(pr.item);
      if (!placed) overflow.push(pr.item);
    }
    const pending: ItemInstance[] = [];
    for (const p of old) {
      if (prioritised.has(p.item.uid)) continue;
      const { w, h } = this.footprintOf(p.item);
      if (this.inBounds(p.x, p.y, w, h) && this.canPlace(p.item, p.x, p.y, p.item.rotated, p.item.uid)) {
        this.fill(p.item.uid, p.x, p.y, w, h);
        this.placements.set(p.item.uid, { item: p.item, x: p.x, y: p.y });
      } else {
        pending.push(p.item);
      }
    }
    pending.sort((a, b) => this.areaOf(b) - this.areaOf(a));
    for (const item of pending) {
      if (!this.autoPlace(item)) overflow.push(item);
    }
    this.version++;
    return overflow;
  }

  /** Copy of the current layout (positions, rotation and stack sizes) for `restore()`. */
  snapshot(): GridSnapshot {
    return {
      cols: this._cols,
      rows: this._rows,
      placements: this.items().map((p) => ({ item: p.item, x: p.x, y: p.y, rotated: p.item.rotated, qty: p.item.qty })),
    };
  }

  /** Put the grid back exactly as `snapshot()` saw it (undo a failed resize / swap). */
  restore(s: GridSnapshot): void {
    this._cols = s.cols;
    this._rows = s.rows;
    this.cells = new Array(s.cols * s.rows).fill(null);
    this.placements.clear();
    for (const p of s.placements) {
      p.item.rotated = p.rotated;
      p.item.qty = p.qty;
      const { w, h } = this.footprintOf(p.item);
      this.fill(p.item.uid, p.x, p.y, w, h);
      this.placements.set(p.item.uid, { item: p.item, x: p.x, y: p.y });
    }
    this.version++;
  }

  private areaOf(item: ItemInstance): number {
    const { w, h } = this.footprintOf(item);
    return w * h;
  }

  private fill(uid: string | null, x: number, y: number, w: number, h: number): void {
    for (let yy = y; yy < y + h; yy++) {
      const row = yy * this.cols;
      for (let xx = x; xx < x + w; xx++) this.cells[row + xx] = uid;
    }
  }
}
