import * as THREE from 'three';
import { Random } from '@/shared';
import type { ContainerTakenWire, ItemInstance, LootRef } from '@/shared';
import { Grid, type DefLookup, type Placement } from './Grid';

export const CONTAINER_COLS = 6;
export const CONTAINER_ROWS = 4;

/** Default loot-window title for caller-supplied containers (`openContainerItems`) without a `title`. */
export const CONTAINER_DEFAULT_TITLE = '컨테이너';

/**
 * A container's contents laid out on its own grid: a loot crate (`tier` ≥ 1, contents rolled
 * from the tier table) or a caller-supplied container such as a corpse (`tier` 0, `title` set).
 *
 * Phase 7 (2026-09-06):
 *   - **search** (Tarkov style): every item placed by `fill()` starts `searched: false`; the system reveals them one at
 *     a time in grid order while the window is open (`nextToSearch`, `searchProgress` keeps the seconds already spent
 *     on an item across a close / reopen).
 *   - **host authority**: `order` = uids in roll order (`idx` on the wire), `taken` = units removed from THIS copy through
 *     the authoritative channel (idx → qty; on the host also its own takes). `applyTaken(idx, qty)` removes units from the
 *     local copy when another peer's take is confirmed.
 */
export class Container {
  readonly grid: Grid;
  readonly position = new THREE.Vector3();
  /** `crate:looted` emitted once when the grid first becomes empty. */
  lootedEmitted = false;
  /** Uids in roll order (`fill` order) — the wire's `idx`. Never shrinks (a taken item keeps its index). */
  readonly order: string[] = [];
  /** idx → units removed from this copy by confirmed takes (mirror of the host's map). */
  readonly taken = new Map<number, number>();
  /** uid → seconds already spent searching it (the item currently / previously being revealed). */
  readonly searchProgress = new Map<string, number>();
  /** `container:searchDone` emitted once per container. */
  searchDoneEmitted = false;

  constructor(readonly id: string, readonly tier: number, position: THREE.Vector3, getDef: DefLookup,
    /** Loot-window title; undefined → the tier label. */
    public title?: string,
    /**
     * appended (2026-09-09): per-container grid. Crates keep the 6×4 default; a 플레이어 유해 asks for
     * `PLAYER_CORPSE_COLS × PLAYER_CORPSE_ROWS` because a whole loadout + bag has to fit in it.
     */
    cols: number = CONTAINER_COLS, rows: number = CONTAINER_ROWS) {
    this.grid = new Grid(Math.max(1, Math.floor(cols)), Math.max(1, Math.floor(rows)), getDef);
    this.position.copy(position);
  }

  /**
   * Auto-place `items` largest-first (callers pre-sort); overflow is dropped with a warning. Every item starts
   * unsearched and is appended to `order` (even when it did not fit, so `idx` stays identical on every client).
   */
  fill(items: readonly ItemInstance[]): void {
    for (const item of items) {
      item.searched = false;
      this.order.push(item.uid);
      if (!this.grid.autoPlace(item)) {
        console.warn(`[Inventory] container ${this.id}: dropped '${item.defId}' (no room)`);
      }
    }
  }

  /** Roll index of a container item (−1 for a uid that was never rolled into it, e.g. a local split). */
  indexOf(uid: string): number { return this.order.indexOf(uid); }
  uidAt(idx: number): string | undefined { return this.order[idx]; }

  /** Units of roll item `idx` still in this copy. */
  remainingAt(idx: number): number {
    const uid = this.order[idx];
    return uid ? this.grid.get(uid)?.item.qty ?? 0 : 0;
  }

  /**
   * A confirmed take by someone else (or a sync catch-up): remove `qty` units of roll item `idx` from this copy and
   * record it. Returns the units actually removed (0 when the item is already gone).
   */
  applyTaken(idx: number, qty: number): number {
    const n = Math.max(0, Math.floor(qty));
    this.recordTaken(idx, n);
    const uid = this.order[idx];
    const p = uid ? this.grid.get(uid) : undefined;
    if (!p || n <= 0) return 0;
    const removed = Math.min(n, p.item.qty);
    p.item.qty -= removed;
    if (p.item.qty <= 0) this.grid.remove(uid!);
    else this.grid.version++;
    this.searchProgress.delete(uid!);
    return removed;
  }

  /** Bookkeeping only (the host's own takes already left the grid through the normal move). */
  recordTaken(idx: number, qty: number): void {
    if (idx < 0 || qty <= 0) return;
    this.taken.set(idx, (this.taken.get(idx) ?? 0) + qty);
  }

  takenWire(): ContainerTakenWire { return { id: this.id, t: [...this.taken.entries()].map(([i, q]) => [i, q] as [number, number]) }; }

  /* ── search ── */

  /** Placements in search order: top-left → bottom-right (row-major by cell). */
  placementsInSearchOrder(): Placement[] {
    return this.grid.items().sort((a, b) => a.y - b.y || a.x - b.x);
  }

  /** The next unsearched item in grid order, or null when everything is revealed. */
  nextToSearch(): Placement | null {
    return this.placementsInSearchOrder().find((p) => p.item.searched === false) ?? null;
  }

  get unsearchedCount(): number {
    let n = 0;
    for (const p of this.grid.items()) if (p.item.searched === false) n++;
    return n;
  }
}

/**
 * A take applied to a **local** copy from the shared state (`applyPending` / `applySync`) — the catch-up path, so it is
 * always reported with `live: false`. `uid` is captured before the placement is removed.
 */
export interface StoreTakenInfo {
  containerId: string;
  idx: number;
  uid: string | null;
  qty: number;
  /** Units of `idx` left in this copy afterwards. */
  remaining: number;
}

/**
 * Cache of containers by id. First open of a crate rolls contents with a deterministic RNG
 * (`missionSeed ^ hash(containerId)`); first open of a caller-supplied container places the
 * given items. Both auto-place largest-first; later opens show what is left.
 * Phase 7: `pendingTaken` keeps confirmed takes for containers this client has not opened yet — they are applied on
 * the first open (host: also used to validate requests for containers it never rolled).
 * Phase 10: `takeSeq` / `lastSeq` carry the per-container take counter of `cont taken` (host stamps, receiver drops a
 * duplicate / out-of-order take) and `onTaken` reports a catch-up removal so the system can emit `container:itemTaken`.
 */
export class ContainerStore {
  private containers = new Map<string, Container>();
  private pendingTaken = new Map<string, Map<number, number>>();
  /** Host: next `cont taken.seq` per container id (works for a container it cannot roll, too). */
  private takeSeq = new Map<string, number>();
  /** Receiver: highest `seq` already applied per container id. */
  private lastSeq = new Map<string, number>();
  /** Set by `InventorySystem`: a take applied from the shared state (never a live one). */
  onTaken: ((info: StoreTakenInfo) => void) | null = null;

  constructor(private readonly getDef: DefLookup) {}

  get(id: string): Container | undefined { return this.containers.get(id); }
  all(): Container[] { return [...this.containers.values()]; }

  getOrCreate(id: string, tier: number, position: THREE.Vector3, loot: LootRef, missionSeed: number): Container {
    let c = this.containers.get(id);
    if (c) {
      c.position.copy(position);
      return c;
    }
    c = new Container(id, tier, position, this.getDef);
    const rng = new Random(((missionSeed >>> 0) ^ Random.hash(id)) >>> 0);
    c.fill(loot.rollCrate(tier, rng));
    this.containers.set(id, c);
    this.applyPending(c);
    return c;
  }

  /**
   * Container with caller-supplied contents (corpses). `items` are only used on the first open
   * for this id; a known id ignores them and shows its remaining contents. `title` updates the cached one.
   * `size` (appended 2026-09-09) picks the grid on creation only — a known id keeps the grid it was built with.
   */
  getOrCreateWithItems(id: string, items: readonly ItemInstance[], position: THREE.Vector3, title?: string,
    size?: { cols: number; rows: number }): Container {
    let c = this.containers.get(id);
    if (c) {
      c.position.copy(position);
      if (title) c.title = title;
      return c;
    }
    c = new Container(id, 0, position, this.getDef, title ?? CONTAINER_DEFAULT_TITLE, size?.cols, size?.rows);
    c.fill(items);
    this.containers.set(id, c);
    this.applyPending(c);
    return c;
  }

  /** Takes confirmed before this client opened the container (applied on the first open). */
  private applyPending(c: Container): void {
    const pend = this.pendingTaken.get(c.id);
    if (!pend) return;
    this.pendingTaken.delete(c.id);
    for (const [idx, qty] of pend) this.applyTakenReported(c, idx, qty);
  }

  /** `Container.applyTaken` + the `onTaken` report (uid captured before the placement goes away). */
  private applyTakenReported(c: Container, idx: number, qty: number): number {
    const uid = c.uidAt(idx) ?? null;
    const removed = c.applyTaken(idx, qty);
    if (removed > 0) this.onTaken?.({ containerId: c.id, idx, uid, qty: removed, remaining: c.remainingAt(idx) });
    return removed;
  }

  /** Record a confirmed take for a container that is not open / rolled here yet. */
  recordPending(id: string, idx: number, qty: number): void {
    if (qty <= 0) return;
    let m = this.pendingTaken.get(id);
    if (!m) { m = new Map(); this.pendingTaken.set(id, m); }
    m.set(idx, (m.get(idx) ?? 0) + qty);
  }

  /** Units already recorded as taken for a container that was never opened here (host validation fallback). */
  pendingTakenOf(id: string, idx: number): number { return this.pendingTaken.get(id)?.get(idx) ?? 0; }

  /** Every taken map (opened + pending) for `cont sync`. */
  takenWire(): ContainerTakenWire[] {
    const out: ContainerTakenWire[] = [];
    for (const c of this.containers.values()) if (c.taken.size > 0) out.push(c.takenWire());
    for (const [id, m] of this.pendingTaken) if (m.size > 0) out.push({ id, t: [...m.entries()].map(([i, q]) => [i, q] as [number, number]) });
    return out;
  }

  /**
   * Replace the taken state with the host's (`cont sync`): opened containers remove what they have not applied yet,
   * unknown ids go to `pendingTaken`. Returns the ids whose grid changed.
   */
  applySync(items: readonly ContainerTakenWire[]): string[] {
    const changed: string[] = [];
    for (const w of items) {
      const c = this.containers.get(w.id);
      if (!c) {
        const m = new Map<number, number>();
        for (const [idx, qty] of w.t) if (qty > 0) m.set(idx, qty);
        this.pendingTaken.set(w.id, m);
        continue;
      }
      let touched = false;
      for (const [idx, qty] of w.t) {
        const delta = qty - (c.taken.get(idx) ?? 0);
        if (delta <= 0) continue;
        if (this.applyTakenReported(c, idx, delta) > 0) touched = true;
      }
      if (touched) changed.push(c.id);
    }
    return changed;
  }

  /* ── Phase 10: `cont taken.seq` ── */

  /** Host: the `seq` to stamp on the next `cont taken` for `id` (1-based, monotonic per container). */
  nextTakeSeq(id: string): number {
    const next = (this.takeSeq.get(id) ?? 0) + 1;
    this.takeSeq.set(id, next);
    return next;
  }

  /**
   * Receiver: is this `cont taken` the next one to apply? A missing `seq` (older host) is always accepted; a `seq`
   * that is not higher than the last one applied is a duplicate / out-of-order message and is dropped.
   */
  acceptTakeSeq(id: string, seq: number | undefined): boolean {
    if (typeof seq !== 'number' || !Number.isFinite(seq)) return true;
    const last = this.lastSeq.get(id) ?? 0;
    if (seq <= last) return false;
    this.lastSeq.set(id, seq);
    return true;
  }

  /** Forget the received sequence numbers (host migration: the new host counts from 1 again). */
  resetTakeSeq(): void { this.lastSeq.clear(); }

  clear(): void { this.containers.clear(); this.pendingTaken.clear(); this.takeSeq.clear(); this.lastSeq.clear(); }
}
