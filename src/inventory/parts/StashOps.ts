/**
 * src/inventory/parts/StashOps.ts — **the operations that read the ship stash as well**.
 *
 * Operations reading the bag alone (`countDef` and friends) stay on the class; everything here treats **bag + stash**
 * as one store: material counting · consuming, saving / applying a loadout preset, moving to the stash, placing
 * anywhere, checking for room. The stash exists only in the ship, so during a raid these read the bag only.
 * ⚠ These functions (`countDefAll` · `consumeDefAll` · `tryAddItemAnywhere` …) **do not check the phase** — a path
 * that must not run during a raid is blocked by its caller.
 */
import type {
  ItemDef, ItemInstance, LoadoutSlot, LoadoutPreset,
} from '@/shared';
import { ITEM_DEF_MAP, isWeaponItemDef } from '@/items';
import { Grid } from '../Grid';
import { findSocketed } from '../Sockets';
import {
  LOADOUT_SLOTS, slotAccepts, type GridId, type ItemLocation, type OpResult,
} from '../model';
import type { InventorySystem } from '../InventorySystem';

export function getStashSize(sys: InventorySystem): { cols: number; rows: number } { return { cols: sys.stash.cols, rows: sys.stash.rows }; }

/** Grow / shrink the stash grid (shrink refused while an item would fall outside). Persists; emits `inventory:stashChanged`. */
export function setStashSize(sys: InventorySystem, cols: number, rows: number): boolean {
  if (!sys.stash.resize(cols, rows)) return false;
  sys.afterChange(); // stash version changed → markDirty + inventory:stashChanged + UI re-render
  return true;
}

export function countDefAll(sys: InventorySystem, defId: string): number { return sys.countDef(defId) + sys.stashCountDef(defId); }

export function stashCountDef(sys: InventorySystem, defId: string): number {
  let n = 0;
  for (const p of sys.stash.grid.items()) if (p.item.defId === defId) n += p.item.qty;
  return n;
}

/** Bag first, then the stash; all-or-nothing. */
export function consumeDefAll(sys: InventorySystem, defId: string, qty: number): boolean {
  const want = Math.max(0, Math.floor(qty));
  if (want === 0) return true;
  if (sys.countDefAll(defId) < want) return false;
  let left = want;
  const fromBag = Math.min(left, sys.countDef(defId));
  if (fromBag > 0) left -= sys.consumeWhere((d) => d.id === defId, fromBag);
  if (left > 0) {
    const stash = sys.stash.grid;
    const matches = stash.items().filter((p) => p.item.defId === defId).sort((a, b) => a.item.qty - b.item.qty);
    for (const p of matches) {
      if (left <= 0) break;
      const take = Math.min(left, p.item.qty);
      p.item.qty -= take; left -= take;
      if (p.item.qty <= 0) stash.remove(p.item.uid);
      else stash.version++;
    }
    sys.afterChange();
  }
  return left === 0;
}

/* ══ A-13 (2026-09-11): preparations are used in the ship ═══════════════════════════════════════════════════
 * progression owns the rule (`ProgressionRef.usePrep` — the ship gate · one per environment · a Korean reason).
 * inventory only checks first **whether the item can be taken from where it is**, and removes 1 once progression took
 * it. Reversed (take first, ask after) a refusal has nowhere to roll back to — `prep` does not belong to this folder.
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════ */
export function usePrepItem(sys: InventorySystem, uid: string, from?: ItemLocation): string | null {
  const ctx = sys.ctx;
  const item = sys.findItem(uid, from);
  const def = item && ITEM_DEF_MAP.get(item.defId);
  if (!item || !def) return '아이템을 찾을 수 없습니다';
  if (!def.prep) return '준비물이 아닙니다';
  if (!ctx.isHubPhase() || ctx.isRaidActive()) return '함선에서만 사용할 수 있습니다';
  // `takeItem` refuses a stack in an open crate or an equipment slot — filtered out before asking.
  if (from?.kind === 'slot') return '가방이나 창고로 옮긴 뒤 사용하세요';
  if (from?.kind === 'grid' && from.grid === 'container') return '가방이나 창고로 옮긴 뒤 사용하세요';
  const prog = ctx.progression;
  if (!prog || typeof prog.usePrep !== 'function') return '준비물을 사용할 수 없습니다';
  const refusal = prog.usePrep(def.id);
  if (refusal) return refusal;
  if (sys.takeItem(uid, 1) !== 1) {
    // Reaching here means progression already armed it. The spot was filtered ahead, so in practice this never runs.
    console.error('[inventory] 준비물을 실었지만 아이템을 빼지 못했다', uid, def.id);
  }
  return null;
}

/* 2026-09-16 (the plate model, user's decision): the old `useMealItem` (right-click `먹기` on a meal item) is gone — a
 * meal is not an item but the dining table's plate, eaten only there (housing `parts/Dining.eatPlate`). */

export function captureLoadout(sys: InventorySystem): LoadoutPreset {
  const l = sys.loadout;
  return {
    name: '프리셋', primary: l.primary?.defId ?? null, primary2: l.primary2?.defId ?? null, secondary: l.secondary?.defId ?? null,
    bag: l.bag?.defId ?? null, armor: l.armor?.defId ?? null,
    // A-15: `undefined` = the pouch is left alone / `null` = emptied (the same contract as `implantItems`)
    pouch: l.pouch?.defId ?? null,
    implant: sys.ctx.progression?.profile.implant ?? sys.ctx.implants?.equipped ?? null,
    // 2026-09-08: implant items are part of the loadout too (once moved into the inventory's equipment slots)
    implantItems: (sys.ctx.progression?.getEquippedImplants() ?? []).map((e) => e.defId),
  };
}

/**
 * Equip a preset from the bag (first) and the stash: a slot whose def is found gets the first matching instance
 * (displaced gear → bag, else stash), a def that is nowhere empties the slot and lands in `missing`; `null`
 * entries leave the slot as it is. The implant goes through `ctx.implants.setEquipped` (the Tab screen's path).
 * Ship only — on a mission nothing changes and the result is empty.
 */
export function applyLoadout(sys: InventorySystem, preset: LoadoutPreset): { equipped: number; missing: string[] } {
  if (!sys.ctx.isHubPhase()) return { equipped: 0, missing: [] };
  let equipped = 0;
  const missing: string[] = [];
  for (const slot of LOADOUT_SLOTS) {
    const want = preset[slot];
    if (want === null || want === undefined) continue;
    const cur = sys.loadout[slot];
    if (cur?.defId === want) { equipped++; continue; }
    const found = sys.findStoredByDef(want);
    if (!found) {
      missing.push(want);
      if (cur) sys.unequipToStorage(slot);
      continue;
    }
    if (sys.equipFromStorage(found.item, found.grid, slot)) equipped++;
    else missing.push(want);
  }
  if (preset.implant !== null && preset.implant !== undefined) {
    const imp = sys.ctx.implants;
    if (imp?.equipped === preset.implant) equipped++;
    else if (imp && typeof imp.setEquipped === 'function' && imp.setEquipped(preset.implant)) equipped++;
    else missing.push(preset.implant);
  }
  if (preset.implantItems) {
    const r = applyImplantItems(sys, preset.implantItems);
    equipped += r.equipped;
    for (const m of r.missing) missing.push(m);
  }
  sys.emitLoadout();
  sys.afterChange();
  return { equipped, missing };
}

/**
 * The implant-item part of a preset (2026-09-08). Everything currently slotted comes **off** first (an implant the
 * preset also wants is re-equipped below — the round trip costs nothing and keeps the slot budget honest), then each
 * wanted def is equipped from the bag / the ship stash in the preset's order. A def that is nowhere, broken, or no
 * longer fits the slot budget lands in `missing`. `[]` therefore means "take everything off".
 */
function applyImplantItems(sys: InventorySystem, want: readonly string[]): { equipped: number; missing: string[] } {
  const prog = sys.ctx.progression;
  if (!prog || typeof prog.equipImplant !== 'function') return { equipped: 0, missing: want.slice() };
  for (const e of [...prog.getEquippedImplants()]) prog.unequipImplant(e.uid);
  let equipped = 0;
  const missing: string[] = [];
  for (const defId of want) {
    const found = sys.findStoredByDef(defId);
    if (found && prog.equipImplant(found.item.uid)) equipped++;
    else missing.push(defId);
  }
  return { equipped, missing };
}

/** First instance of `defId` in the bag, then the stash. */
export function findStoredByDef(sys: InventorySystem, defId: string): { item: ItemInstance; grid: GridId } | null {
  for (const gridId of ['bag', 'stash'] as const) {
    const p = sys.getGrid(gridId)?.items().find((q) => q.item.defId === defId);
    if (p) return { item: p.item, grid: gridId };
  }
  return null;
}

/** Unequip `slot` into the bag, else the stash (ship). The bag slot shrinks the grid first. */
export function unequipToStorage(sys: InventorySystem, slot: LoadoutSlot): boolean {
  const cur = sys.loadout[slot];
  if (!cur) return true;
  if (slot === 'bag') {
    // the old bag lands in the shrunk grid (priority), else the ship stash through `throwToWorld`
    if (sys.changeBag(null, null, 'grid') === 'ok') return true;
    return sys.changeBag(null, null, 'world') === 'ok';
  }
  // A-15: a pouch moves its contents into the bag first — if they do not fit, taking it off is refused
  if (slot === 'pouch') {
    if (sys.changePouch(null, null, 'grid') === 'ok') return true;
    return sys.changePouch(null, null, 'grid', undefined, 'stash') === 'ok';
  }
  sys.loadout[slot] = null;
  const dest = sys.stow(cur);
  if (!dest) { sys.loadout[slot] = cur; return false; }
  const def = ITEM_DEF_MAP.get(cur.defId);
  if (def) sys.emitTransfer(cur, def, { kind: 'slot', slot }, { kind: 'grid', grid: dest });
  return true;
}

/** Move a bag / stash item into `slot`; the displaced item goes to the bag, else the stash, else the vacated cells. */
export function equipFromStorage(sys: InventorySystem, item: ItemInstance, gridId: GridId, slot: LoadoutSlot): boolean {
  const def = ITEM_DEF_MAP.get(item.defId);
  const grid = sys.getGrid(gridId);
  if (!def || !grid || !slotAccepts(def, slot)) return false;
  const from: ItemLocation = { kind: 'grid', grid: gridId };
  if (slot === 'bag') {
    let r = sys.changeBag(item, from, 'grid');
    if (r === 'fail' && sys.loadout.bag) {
      // the displaced bag does not fit the new grid: park it in the stash first, then retry
      if (sys.moveToStash(sys.loadout.bag.uid, { kind: 'slot', slot: 'bag' }) !== 'ok') return false;
      const again = sys.locate(item.uid);
      if (!again || again.from.kind !== 'grid') return false;
      r = sys.changeBag(item, again.from, 'grid');
    }
    return r === 'ok';
  }
  // A-15: the pouch slot has its own function too (the contents move and the refusal rule live there)
  if (slot === 'pouch') {
    const back: GridId = gridId === 'stash' ? 'stash' : 'bag';
    return sys.changePouch(item, from, 'grid', undefined, back) === 'ok';
  }
  const cur = sys.loadout[slot];
  const src = grid.get(item.uid);
  if (!src) return false;
  const sx = src.x, sy = src.y, srot = item.rotated;
  grid.remove(item.uid);
  if (cur) {
    sys.loadout[slot] = null;
    let dest: GridId | null = sys.stow(cur);
    if (!dest && grid.autoPlace(cur)) dest = gridId;
    if (!dest) { sys.loadout[slot] = cur; grid.place(item, sx, sy, srot); return false; }
    const cd = ITEM_DEF_MAP.get(cur.defId);
    if (cd) sys.emitTransfer(cur, cd, { kind: 'slot', slot }, { kind: 'grid', grid: dest });
  }
  sys.loadout[slot] = item;
  sys.emitTransfer(item, def, from, { kind: 'slot', slot });
  return true;
}

/** Context menu `창고로 이동` on an equipped item (hub only): unequip straight into the stash. The bag slot shrinks the grid first. */
export function moveToStash(sys: InventorySystem, uid: string, from: ItemLocation): OpResult {
  if (!sys.hubMode) return 'fail';
  const item = sys.findItem(uid, from);
  const def = item && ITEM_DEF_MAP.get(item.defId);
  if (!item || !def) return 'fail';
  if (from.kind === 'grid' && from.grid === 'stash') return 'noop';
  if (from.kind === 'slot' && from.slot === 'bag') {
    // bag → grid first (its contents must survive the shrink), then the bag itself → stash
    const r = sys.changeBag(null, null, 'grid');
    if (r !== 'ok') return r;
    const found = sys.locate(uid);
    if (!found || found.from.kind !== 'grid') return 'ok';
    from = found.from;
  }
  // A-15: a pouch goes straight to the stash (`changePouch` moves the contents into the bag — refused if it cannot)
  if (from.kind === 'slot' && from.slot === 'pouch') return sys.changePouch(null, null, 'grid', undefined, 'stash');
  const stash = sys.stash.grid;
  if (!stash.canAbsorb(item)) { sys.ctx.bus.emit('ui:notify', { text: '창고에 공간이 없습니다', kind: 'warning' }); return 'fail'; }
  sys.detach(item, from);
  stash.autoPlace(item);
  sys.afterMove(item, from, { kind: 'grid', grid: 'stash' });
  return 'ok';
}

/**
 * 2026-09-16 (user's decision) — the bag header's **`모두 창고로 이동`** (ship only). **Only bag-grid items** move to the
 * stash — quick slots (the wheel) · the pouch · equipped gear stay. Favourites move too (undoable, so no confirm card).
 *
 * - Largest first (`area` descending) packs the grid well — the same order as `takeAll` and a bag relayout.
 * - One at a time `canAbsorb` → `detach` → `autoPlace`, each landing sending **the same event** as a single-cell move
 *   (`emitTransfer` — contracts · the tutorial listen for `inventory:itemRemoved`), and `afterChange` **once** at the end.
 * - The copy carried on the event is taken **before** placing: `autoPlace` merging into a stash stack drops `qty` to 0.
 * - An item the tutorial hides in the stash (`hides('stashItem', defId)`) is not moved — moving it looks like it vanished.
 * - What does not fit stays in the bag and the number left is returned (the caller = the UI raises one toast).
 */
export function moveBagToStash(sys: InventorySystem): { moved: number; left: number } {
  if (!sys.hubMode) return { moved: 0, left: 0 };
  const stash = sys.stash.grid;
  const from: ItemLocation = { kind: 'grid', grid: 'bag' };
  const to: ItemLocation = { kind: 'grid', grid: 'stash' };
  const tut = sys.ctx.tutorial;
  const items = sys.bag.items().map((p) => p.item)
    .filter((it) => !(tut?.hides('stashItem', it.defId) ?? false))
    .sort((a, b) => sys.area(b) - sys.area(a));
  let moved = 0, left = 0;
  for (const item of items) {
    const def = ITEM_DEF_MAP.get(item.defId);
    if (!def || !stash.canAbsorb(item)) { left++; continue; }
    const sent: ItemInstance = { ...item };
    sys.detach(item, from);
    if (!stash.autoPlace(item)) {
      // `canAbsorb` was just true, so this never runs — the item still goes back to the bag so it cannot be lost
      if (!sys.bag.autoPlace(item)) console.error('[inventory] 모두 창고로: 되돌릴 자리가 없다', item.defId);
      left++;
      continue;
    }
    sys.emitTransfer(sent, def, from, to);
    moved++;
  }
  if (moved > 0) sys.afterChange();
  return { moved, left };
}

/** Bag → slots → sockets of owned weapons → stash (incl. sockets of stashed weapons). */
export function findItemAnywhere(sys: InventorySystem, uid: string): ItemInstance | null {
  const owned = sys.findItem(uid);
  if (owned) return owned;
  const stashed = sys.stash.grid.get(uid)?.item;
  if (stashed) return stashed;
  const stashWeapons = sys.stash.items().filter((it) => isWeaponItemDef(ITEM_DEF_MAP.get(it.defId)));
  return findSocketed(stashWeapons, uid)?.item ?? null;
}

/** Auto-place a fresh instance in the stash (merging into stacks first). Persists + `inventory:stashChanged`. */
export function tryAddToStash(sys: InventorySystem, item: ItemInstance): boolean {
  if (!ITEM_DEF_MAP.has(item.defId)) return false;
  if (!sys.stash.grid.autoPlace(item)) return false;
  sys.afterChange();
  return true;
}

/** Bag first (`inventory:itemAdded`), then the stash. No `inventory:full` — the caller (corp shop) reports. */
export function tryAddItemAnywhere(sys: InventorySystem, item: ItemInstance): 'bag' | 'stash' | null {
  const def = ITEM_DEF_MAP.get(item.defId);
  if (!def) return null;
  if (sys.bag.autoPlace(item)) {
    sys.ctx.bus.emit('inventory:itemAdded', { item, name: def.name, rarity: def.rarity });
    sys.afterChange();
    return 'bag';
  }
  if (sys.stash.grid.autoPlace(item)) { sys.afterChange(); return 'stash'; }
  return null;
}

/** Would `qty` units of `defId` fit now? Bag first, then (hub phase) the stash. Non-mutating. */
export function canFit(sys: InventorySystem, defId: string, qty = 1): 'bag' | 'stash' | null {
  const def = ITEM_DEF_MAP.get(defId);
  const n = Math.floor(qty);
  if (!def || !Number.isFinite(n) || n < 1) return null;
  if (sys.gridFits(sys.bag, def, n)) return 'bag';
  if (sys.ctx.isHubPhase() && sys.gridFits(sys.stash.grid, def, n)) return 'stash';
  return null;
}

/** Trial placement of `qty` units (merge into stacks, then new stacks chunked by `stackMax`), rolled back afterwards. */
export function gridFits(sys: InventorySystem, grid: Grid, def: ItemDef, qty: number): boolean {
  const snap = grid.snapshot();
  const version = grid.version;
  let left = qty;
  let ok = true;
  while (left > 0) {
    const chunk = Math.min(def.stackMax, left);
    left -= chunk;
    const probe = sys.loot.createItem(def.id, chunk);
    if (grid.mergeIntoStacks(probe) <= 0) continue;
    if (!grid.autoPlace(probe)) { ok = false; break; }
  }
  grid.restore(snap);
  grid.version = version;
  return ok;
}
