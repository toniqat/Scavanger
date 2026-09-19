/**
 * src/inventory/parts/Pouch.ts — **a pouch is not the bag grid** (2026-09-11, A-15 user's decision).
 *
 * A pouch fitted into the one `pouch` equipment slot (`POUCH_SLOTS` = 1 — only one of the four pouches in
 * `data/items.csv`) opens **its own grid under the quick slots**. Exactly the pattern 2026-09-09's 「the quick slots are not the bag grid」 set:
 *
 *   - weight · `countWhere` · `consumeWhere` · `getTotalValue` · `stripForCorpse` · the raid blob **read** the pouch
 *   - `getAllItems()` (the trade · repair lists) is **still the bag grid alone**
 *   - taking the pouch off while its contents do not fit the bag **refuses the move itself** (the same contract as
 *     `setQuickSlot` — nothing inside a pouch is silently discarded)
 *
 * Not here: a new kind of `ItemLocation` / `DropTarget`. The pouch grid is simply `{ kind: 'grid', grid: 'pouch' }`.
 */
import type { ItemDef, ItemInstance, PouchDef } from '@/shared';
import { ITEM_DEF_MAP } from '@/items';
import type { Grid, Placement, GridSnapshot } from '../Grid';
import { pouchAcceptsDef, type GridId, type ItemLocation, type OpResult } from '../model';
import type { InventorySystem } from '../InventorySystem';

/** The grid size with no pouch — `Grid.resize` refuses 0, so it is left empty at 1×1 (nobody draws it). */
const EMPTY_POUCH_SIZE = { cols: 1, rows: 1 } as const;

/** The pouch item equipped right now, else null (`InventoryRef.getEquippedPouch`). */
export function getEquippedPouch(sys: InventorySystem): ItemInstance | null {
  return sys.loadout.pouch ?? null;
}

/** The equipped pouch's `PouchDef`, else null. */
export function pouchDefOf(sys: InventorySystem): PouchDef | null {
  const it = sys.loadout.pouch;
  if (!it) return null;
  return ITEM_DEF_MAP.get(it.defId)?.pouch ?? null;
}

/**
 * The equipped pouch's grid size (`InventoryRef.getPouchSize`). With no pouch, `{ cols: 0, rows: 0 }` — meaning
 * **that spot is not drawn at all** (the internal `Grid` sits empty at 1×1).
 */
export function getPouchSize(sys: InventorySystem): { cols: number; rows: number } {
  const p = pouchDefOf(sys);
  return p ? { cols: p.cols, rows: p.rows } : { cols: 0, rows: 0 };
}

/** Does the currently equipped pouch accept this item. With no pouch always false (there is no grid at all). */
export function pouchAccepts(sys: InventorySystem, def: ItemDef | undefined): boolean {
  return pouchAcceptsDef(pouchDefOf(sys), def);
}

/** The stacks in the pouch grid (an empty array when there is nothing). */
export function pouchItems(sys: InventorySystem): ItemInstance[] {
  return sys.pouch.items().map((p) => p.item);
}

/** The pouch grid's total value (`getTotalValue` adds it to the bag and the wheel). */
export function pouchTotalValue(sys: InventorySystem): number {
  return sys.pouch.totalValue();
}

/**
 * The signature that detects grid · stack changes — `emitPouchChanged` gates on it (`quickSlotsSignature` is the model).
 * It carries the size too, so swapping the pouch always raises the event.
 */
export function pouchSignature(sys: InventorySystem): string {
  const size = getPouchSize(sys);
  let s = `${sys.loadout.pouch?.uid ?? ''}|${size.cols}x${size.rows}`;
  for (const p of sys.pouch.items()) s += `|${p.item.uid}:${p.item.qty}@${p.x},${p.y}`;
  return s;
}

/** `inventory:pouchChanged` — only when something changed (`afterChange` calls it every time). */
export function emitPouchChanged(sys: InventorySystem): void {
  const sig = pouchSignature(sys);
  if (sig === sys.lastPouchSig) return;
  sys.lastPouchSig = sig;
  sys.ctx.bus.emit('inventory:pouchChanged', {});
}

/**
 * Clears the pouch grid and reopens it **to fit the equipped pouch** (kit reset · starter · corpse strip only — the
 * caller has already taken care of the contents).
 */
export function resetPouchGrid(sys: InventorySystem): void {
  const size = getPouchSize(sys);
  sys.pouch.clear();
  sys.pouch.resize(size.cols || EMPTY_POUCH_SIZE.cols, size.rows || EMPTY_POUCH_SIZE.rows);
}

/** Empties the pouch grid in place and returns its contents (`stripForCorpse`). */
export function drainPouch(sys: InventorySystem): ItemInstance[] {
  const out = pouchItems(sys);
  sys.pouch.clear();
  return out;
}

/** The snapshot bundle for a rollback — the same `Grid` is never captured twice. */
type Snaps = { grid: Grid; snap: GridSnapshot }[];

function snapshot(grids: (Grid | null | undefined)[]): Snaps {
  const out: Snaps = [];
  for (const g of grids) {
    if (!g || out.some((e) => e.grid === g)) continue;
    out.push({ grid: g, snap: g.snapshot() });
  }
  return out;
}

function rollback(snaps: Snaps): void {
  for (const e of snaps) e.grid.restore(e.snap);
}

/**
 * Swaps the pouch (`next` null = take it off). `changeBag` is the model, but there is **one more refusal rule**:
 *
 *   ① contents the new pouch cannot take (or has no room for) go to the **bag**. If even one does not fit, **everything
 *      is rolled back and the move itself refused** — nothing in a pouch silently hits the ground (quick-slot contract).
 *   ② the removed pouch itself must fit the `dest` grid (the bag by default) when `oldTo === 'grid'`. If not, refused too.
 *
 * `oldTo === 'world'` throws the old pouch on the ground (in the ship `throwToWorld` sends it to the stash).
 * `from` null + `next` = an instance that is in no grid at all (an infinite-box drag).
 */
export function changePouch(
  sys: InventorySystem,
  next: ItemInstance | null,
  from: ItemLocation | null,
  oldTo: 'grid' | 'world',
  hint?: { x: number; y: number },
  dest: GridId = 'bag',
): OpResult {
  const old = sys.loadout.pouch ?? null;
  if (!next && !old) return 'noop';
  if (next && old && next.uid === old.uid) return 'noop';
  const nextDef = next ? ITEM_DEF_MAP.get(next.defId) : undefined;
  if (next && !nextDef?.pouch) return 'fail';

  const srcGrid = from?.kind === 'grid' ? sys.getGrid(from.grid) : null;
  const destGrid = sys.getGrid(dest) ?? sys.bag;
  const snaps = snapshot([sys.pouch, sys.bag, srcGrid, destGrid]);

  let srcPos: Placement | undefined;
  if (next && from) {
    if (from.kind !== 'grid' || !srcGrid) return 'fail';
    srcPos = srcGrid.get(next.uid);
    if (!srcPos) return 'fail';
    srcGrid.remove(next.uid);
  }

  const refuse = (blocked: ItemInstance | null): OpResult => {
    rollback(snaps);
    if (next && srcGrid && srcPos) srcGrid.place(next, srcPos.x, srcPos.y, next.rotated);
    if (blocked) {
      const d = ITEM_DEF_MAP.get(blocked.defId);
      if (d) sys.ctx.bus.emit('inventory:full', { item: blocked, name: d.name });
    }
    return 'fail';
  };

  // ① contents — only what the new pouch takes stays, the rest go to the bag (one failure rolls everything back)
  const contents = pouchItems(sys);
  const accepts = nextDef?.pouch ?? null;
  sys.pouch.clear();
  sys.pouch.resize(accepts?.cols ?? EMPTY_POUCH_SIZE.cols, accepts?.rows ?? EMPTY_POUCH_SIZE.rows);
  const spilled: ItemInstance[] = [];
  for (const it of contents) {
    const d = ITEM_DEF_MAP.get(it.defId);
    if (pouchAcceptsDef(accepts, d) && sys.pouch.autoPlace(it)) continue;
    spilled.push(it);
  }
  for (const it of spilled) {
    if (!sys.bag.autoPlace(it)) return refuse(it);
  }

  // ② the removed pouch itself
  if (old && oldTo === 'grid') {
    const placed = (hint !== undefined && destGrid.place(old, hint.x, hint.y, old.rotated))
      || destGrid.autoPlace(old) || sys.bag.autoPlace(old);
    if (!placed) return refuse(old);
  }

  sys.loadout.pouch = next;
  if (old && oldTo === 'world') sys.throwToWorld(old, true);
  if (next && nextDef && from) sys.emitTransfer(next, nextDef, from, { kind: 'slot', slot: 'pouch' });
  if (old && oldTo === 'grid') {
    const od = ITEM_DEF_MAP.get(old.defId);
    // the grid it really landed in (the `dest` fallback is the bag)
    const landed: GridId = destGrid.has(old.uid) ? dest : 'bag';
    if (od) sys.emitTransfer(old, od, { kind: 'slot', slot: 'pouch' }, { kind: 'grid', grid: landed });
  }
  if (spilled.length > 0) {
    sys.ctx.bus.emit('ui:notify', { text: `주머니에서 아이템 ${spilled.length}개를 가방으로 옮겼습니다`, kind: 'info', duration: 2.2 });
  }
  sys.emitLoadout();
  sys.afterChange();
  return 'ok';
}
