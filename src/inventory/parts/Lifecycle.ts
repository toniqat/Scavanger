/**
 * src/inventory/parts/Lifecycle.ts — **saves · the starter grant · the mission reset**.
 *
 * Functions split out of `InventorySystem`. They take the instance as their first argument `sys`, and the class keeps a
 * one-line delegate of the same name, so **every call site is unchanged**.
 * The one question answered here — *what happens to the player's gear when a raid starts · ends · fails.*
 * The rules in full are in the folder README's `Reset policy` section.
 */
import * as THREE from 'three';
import type {
  ContainerMessage, ContainerRequest, CraftIngredient, CraftRecipe, CraftStation, DurabilityInfo, GameContext, ItemCategory, ItemDef,
  ItemInstance, Loadout, LoadoutSlot, PeerId as NetPeerId, ProfileRecord, SocketSlot, WeaponSlot, WeightInfo, LoadoutPreset, WorkbenchKind, EmbeddedView,
} from '@/shared';
import { BAG_DEFAULT_COLS, BAG_DEFAULT_QUICK_SLOTS, BAG_DEFAULT_ROWS, Keys, QUICK_SLOTS, SEARCH_MAX_DISTANCE, SOCKET_SLOTS, isQuickSlotActive } from '@/shared';
import { AMMO_LABEL_KO, ITEM_DEF_MAP, STARTER_LOADOUT, STARTER_STASH, ammoItemIdFor, getRecipe, isWeaponItemDef, itemWeight } from '@/items';
import { durabilityInfo, gearMultipliers, makeWeightInfo, searchTimeFor, sumWeight } from '../Gear';
import { Grid, OOB, type Placement, type PriorityPlacement } from '../Grid';
import { Container, ContainerStore } from '../Container';
import { attachedItems, clearSocket, findSocketed, setSocket } from '../Sockets';
import { createQuickSlots, isQuickUsable, pickStarterQuick } from '../QuickSlots';
import { setStarterGrantState, starterGrantState } from '../Stash';
import { LOADOUT_SAVE_VERSION, isEmptyLoadoutSave, loadLoadoutSave, sanitizeLoadoutSave, type LoadoutSave } from '../Loadout';
import { reviveItem, savedCell, serializeExtras, serializePlacement, type SavedPlacement } from '../Serialize';
import { resolveItemAlias } from '@/shared';   // 2026-09-13 (the library series): re-merges bag stacks saved under an old media id
import {
  AUTO_CLOSE_DISTANCE, BLOCKER_TOKEN, CRAFT_MIN_SPEED, DROP_EYE_LOWER, DROP_FORWARD_OFFSET, DROP_FORWARD_SPEED, DROP_UP_SPEED,
  LOADOUT_SLOTS, MOD_CTRL, MOD_SHIFT, SEARCH_EMIT_INTERVAL, SPRAY_REFILL_COST, TAKE_REQUEST_TIMEOUT, WEAPON_SLOT_IDS,
  isArmorDef, isAttachmentDef, isBagDef, isDisassembleRecipe, isWeaponDef, sameProfileDoc, slotAccepts,
  type ActiveBench, type BagSize, type BenchRecipeRow, type BenchRepairRow, type DropPreview, type DropTarget,
  type GridId, type ItemLocation, type OpResult, type PendingTake, type RaidInventoryState, type SlotId,
} from '../model';
import { pouchAcceptsDef } from '../model';
import * as Pouch from './Pouch';
import { returnForbiddenAttachments } from './SocketRules';   // 2026-09-14 (the gun socket rules)
import type { InventorySystem } from '../InventorySystem';

/**
 * `world:ready`: the kit the player equipped in the ship is what they raid with (2026-09-07 — no automatic starter
 * per mission any more). Only a player with nothing anywhere (loadout, bag **and** 함선 창고) gets the minimum kit
 * so a lost run can never soft-lock the game; otherwise everything is kept and only the events every consumer needs
 * (`loadout:changed`, counts, `inventory:changed`) are re-emitted.
 */
export function onWorldReady(sys: InventorySystem, seed: number): void {
  sys.missionSeed = seed;
  sys.outcome = 'none';
  sys.strippedForCorpse = false;
  /*
   * 2026-09-11 (C-61): a new raid starts unworn — but a **rejoin** of this very raid whose blob was already applied
   * (`applyRaidState` stamped `bagWornRestoreSeed`) keeps the restored mark. Today game/ applies the blob *after* this
   * handler (inventory registers first), so this only guards against that order changing; `applyRaidState` then sets
   * the flag itself.
   */
  sys.bagWornThisRaid = !!sys.ctx.rejoinPending && sys.bagWornRestoreSeed === seed;
  sys.bagWornRestoreSeed = null;
  sys.closeAll();
  sys.clearContainers();
  // 2026-09-11 (E-5): a **solo raid** marks the saved kit as "out on raid `seed`" (multiplayer · training never do) —
  // game/ fails the run at boot when that marker has no matching solo raid save. The starter below saves with it too.
  if (!sys.ctx.isMultiplayer && sys.ctx.missionMode === 'raid') sys.loadoutStore.markRaid(seed);
  if (sys.isDestitute()) { sys.applyStarter(); return; }
  sys.lastGrenades = -1; sys.lastStims = -1; sys.lastQuickSig = ''; sys.lastPouchSig = '';
  if (sys.announcePending) { sys.announcePending = false; sys.lastEquipUids = {}; sys.lastWeight = null; }
  sys.emitLoadout();
  sys.afterChange();
  }

/**
 * Snapshot for the save file: slots + bag placements + the wheel's own stacks + the pouch grid.
 *
 * v2 (2026-09-09): `quick[i]` is the **stack itself**, not an index into `bag` — the wheel is its own container, so
 * a stack on the wheel is not in `bag` at all. `Loadout.sanitizeLoadoutSave` migrates a v1 file on read.
 * v3 (2026-09-11, A-15): `pouch` is that same idea for the pouch — placements, not indices.
 */
export function captureLoadoutSave(sys: InventorySystem): LoadoutSave {
  const slots: LoadoutSave['slots'] = {};
  for (const s of LOADOUT_SLOTS) { const it = sys.loadout[s]; if (it) slots[s] = serializeExtras(it); }
  const placements = sys.bag.items();
  const quick = sys.quickSlots.map((it) => (it ? serializeExtras(it) : null));
  const save: LoadoutSave = {
    v: LOADOUT_SAVE_VERSION, slots, bag: placements.map(serializePlacement), quick,
    pouch: sys.pouch.items().map(serializePlacement),
  };
  // 2026-09-12 (E1): the favourite def-id list — with none the field is absent (`LoadoutSave.fav`, `parts/Favorites.ts`)
  const fav = sys.captureFavorites();
  if (fav) save.fav = fav;
  return save;
  }

/**
 * Fill the slots / bag / quick slots from the save (init only, no events). A missing / empty save leaves
 * everything empty so `hub:entered` hands out the starter kit as before. Unknown defs and items that no longer
 * fit are dropped with a warning; a wrong-category slot entry is ignored.
 */
export function restoreLoadoutSave(sys: InventorySystem): boolean {
  const save = loadLoadoutSave();
  // 2026-09-12 (E1): favourites are read even when the kit is empty — their lifetime differs from the kit's (`parts/Favorites.ts`)
  sys.applySavedFavorites(save?.fav, true);
  if (!save || isEmptyLoadoutSave(save)) return false;
  sys.applyLoadoutSave(save);
  // 2026-09-14 (the gun socket rules): attachments a weapon no longer accepts → the stash (→ the bag); the kit is saved with the stash
  if (returnForbiddenAttachments(sys, 'stash') > 0) sys.loadoutStore.markDirty('sockets');
  sys.announcePending = true;
  return true;
  }

/**
 * Replace the slots / bag / quick slots with `save` (no events — callers announce). Returns the revived bag
 * instances in `save.bag` order (null = dropped) so a raid state can restore per-entry flags.
 */
export function applyLoadoutSave(sys: InventorySystem, save: LoadoutSave): (ItemInstance | null)[] {
  const getDef = (id: string): ItemDef | undefined => ITEM_DEF_MAP.get(id);
  const loadout: Loadout = { primary: null, primary2: null, secondary: null, bag: null, armor: null, pouch: null };
  for (const slot of LOADOUT_SLOTS) {
    const item = reviveItem(save.slots[slot], getDef, sys.loot, 'Loadout');
    if (!item) continue;
    const def = ITEM_DEF_MAP.get(item.defId);
    if (!def || !slotAccepts(def, slot)) { console.warn(`[Loadout] '${item.defId}' cannot sit in slot ${slot} — dropped`); continue; }
    loadout[slot] = item;
  }
  sys.loadout = loadout;
  const size = sys.bagSizeOf(loadout.bag);
  sys.bag.clear();
  sys.bag.resize(size.cols, size.rows);
  const revived: (ItemInstance | null)[] = [];
  const pending: ItemInstance[] = [];
  /** 2026-09-13: bag stacks whose id went through the alias table — placed last so they can re-merge. */
  const converted: Array<{ item: ItemInstance; sv: SavedPlacement }> = [];
  for (const sv of save.bag) {
    const item = reviveItem(sv, getDef, sys.loot, 'Loadout');
    revived.push(item);
    if (!item) continue;
    if (typeof sv.defId === 'string' && resolveItemAlias(sv.defId) !== sv.defId) { converted.push({ item, sv }); continue; }
    const cell = savedCell(sv);
    if (cell && sys.bag.place(item, cell.x, cell.y, !!sv.rotated)) continue;
    pending.push(item);
  }
  // 2026-09-13 (the library series): same order as `Stash.load` — merge into a stack of the new id, own saved cell, then the refill below
  for (const { item, sv } of converted) {
    if ((getDef(item.defId)?.stackMax ?? 1) > 1 && sys.bag.mergeIntoStacks(item) <= 0) continue;
    const cell = savedCell(sv);
    if (cell && sys.bag.place(item, cell.x, cell.y, !!sv.rotated)) continue;
    pending.push(item);
  }
  /*
   * 2026-09-12 — the bag shape changed (all of them 5 cells wide, `data/bags.csv`). An old save's `x ≥ 5` cells are not in
   * the new grid, so some items miss their saved cell. Fitting only those into free spots as before fragments the grid and
   * **throws away items that would have fitted** — so if even one missed, the whole bag is refilled **largest first** (no
   * merging: the raid blob's per-entry marks sit on the instances). What still does not fit goes to the stash, and only when the stash is full too is it discarded as before.
   */
  if (pending.length > 0) {
    const all = [...sys.bag.items().map((p) => p.item), ...pending].sort((a, b) => sys.area(b) - sys.area(a));
    sys.bag.clear();
    for (const item of all) {
      const slot = sys.bag.findFreeSlot(item, false);
      if (slot && sys.bag.place(item, slot.x, slot.y, slot.rotated)) continue;
      if (sys.stash.grid.autoPlace(item)) {
        sys.stash.markDirty();
        console.info(`[Loadout] '${item.defId}' did not fit the reshaped bag — moved to the 함선 창고`);
        continue;
      }
      console.warn(`[Loadout] no room for '${item.defId}' on load — discarded`);
      const at = revived.indexOf(item);
      if (at >= 0) revived[at] = null;
    }
  }
  // 2026-09-09: the wheel holds its own stacks — revive them straight into the slots, never into the bag grid.
  // (A v1 file arrives here already migrated: `sanitizeLoadoutSave` lifted those stacks out of `bag` into `quick`.)
  sys.quickSlots = createQuickSlots();
  save.quick.forEach((sv, i) => {
    const item = reviveItem(sv, getDef, sys.loot, 'Loadout');
    if (!item) return;
    if (!isQuickUsable(getDef(item.defId))) {
      // no longer a quick-usable category (a data change): keep the item, put it in the bag
      if (!sys.bag.autoPlace(item)) console.warn(`[Loadout] no room for '${item.defId}' off the wheel — discarded`);
      return;
    }
    sys.quickSlots[i] = item;
  });
  // 2026-09-11 (A-15): the pouch is its own container too — opened at the equipped pouch's size, revived only inside it.
  // With no pouch (an old save · saved with the pouch off), or an item that pouch does not accept, it goes to the bag.
  const pouchDef = Pouch.pouchDefOf(sys);
  Pouch.resetPouchGrid(sys);
  for (const sv of save.pouch) {
    const item = reviveItem(sv, getDef, sys.loot, 'Loadout');
    if (!item) continue;
    const d = getDef(item.defId);
    const cell = savedCell(sv);
    if (pouchAcceptsDef(pouchDef, d)) {
      if (cell && sys.pouch.place(item, cell.x, cell.y, !!sv.rotated)) continue;
      if (sys.pouch.autoPlace(item)) continue;
    }
    if (!sys.bag.autoPlace(item)) console.warn(`[Loadout] no room for '${item.defId}' off the pouch — discarded`);
  }
  return revived;
  }

/** First `hub:entered` after a restored save: tell every consumer (they subscribed after our init). */
export function announceLoaded(sys: InventorySystem): void {
  sys.announcePending = false;
  sys.lastEquipUids = {}; sys.lastWeight = null;
  sys.lastGrenades = -1; sys.lastStims = -1; sys.lastQuickSig = ''; sys.lastPouchSig = '';
  sys.ctx.bus.emit('inventory:bagChanged', { ...sys.getBagSize(), dropped: [] });
  sys.emitLoadout();
  sys.afterChange();
  }

/** Legacy mission failure (Phase 2 death flow no longer emits it): everything carried is lost (2026-09-07). */
export function onGameOver(sys: InventorySystem): void {
  sys.outcome = 'over';
  sys.loadoutStore.clearRaid();   // 2026-09-11 (E-5): a failed raid ends the solo raid marker
  sys.closeAll();
  sys.clearContainers();
  sys.loseKit();
  }

/**
 * The inventory on revival.
 *
 * 2026-09-09: **auto-revive is gone** and the only way back is a squadmate's rescue drop. At the moment of a full death
 * `stripForCorpse()` moved everything carried onto the corpse, so the player **steps out of the rescue pod empty-handed** —
 * while `strippedForCorpse` stands, nothing is handed out and only that flag is lowered.
 *
 * Every other re-drop (a training range restart, the fallback when a reconnect return failed) gets the starter kit as before.
 * The kit reset on returning to the ship after a failed raid stays with `onAbort` / `onGameOver` → `loseKit`.
 */
export function onRespawn(sys: InventorySystem): void {
  sys.closeAll();
  if (sys.strippedForCorpse) { sys.strippedForCorpse = false; return; }
  sys.applyStarter();
  }

/**
 * `game:abort` after a completed mission is just the hub's mechanical transition (result screen → ship): keep
 * the worn weapons for the workbench. After death the kit was already reset. Any other abort (quit mid-mission,
 * lobby lost, back to title) resets to the starter kit.
 */
export function onAbort(sys: InventorySystem): void {
  sys.closeAll();
  sys.clearContainers();
  sys.strippedForCorpse = false;
  sys.loadoutStore.clearRaid();   // 2026-09-11 (E-5): quit / lost lobby / a stale solo raid at boot — the marker goes too
  const outcome = sys.outcome;
  sys.outcome = 'none';
  if (outcome === 'complete' || outcome === 'over') return;
  sys.loseKit();
  }

export function hasAnyWeapon(sys: InventorySystem): boolean {
  for (const s of WEAPON_SLOT_IDS) if (sys.loadout[s]) return true;
  return sys.bag.items().some((p) => isWeaponItemDef(ITEM_DEF_MAP.get(p.item.defId)));
  }

export function isCompletelyEmpty(sys: InventorySystem): boolean {
  return LOADOUT_SLOTS.every((s) => !sys.loadout[s]) && sys.bag.isEmpty && sys.pouch.isEmpty;
  }

/** Nothing to raid with anywhere: no loadout, empty bag **and** an empty 함선 창고 (2026-09-07 safety net). */
export function isDestitute(sys: InventorySystem): boolean {
  return sys.isCompletelyEmpty() && sys.stash.count === 0;
  }

/**
 * A failed / abandoned raid: everything the player carried is gone and they re-equip from the 함선 창고
 * (2026-09-07). Only a player whose stash is empty too falls back to the minimum kit.
 */
export function loseKit(sys: InventorySystem): void {
  if (sys.stash.count === 0) { sys.applyStarter(); return; }
  sys.bag.clear();
  sys.loadout = { primary: null, primary2: null, secondary: null, bag: null, armor: null, pouch: null };
  const size = sys.bagSizeOf(null);
  sys.bag.resize(size.cols, size.rows);
  sys.quickSlots.fill(null);
  Pouch.resetPouchGrid(sys);   // A-15: losing the pouch loses what is inside it too (the same as the bag)
  sys.lastGrenades = -1; sys.lastStims = -1; sys.lastQuickSig = ''; sys.lastPouchSig = '';
  sys.ctx.bus.emit('inventory:bagChanged', { ...size, dropped: [] });
  sys.emitLoadout();
  sys.afterChange();
  sys.announcePending = false;
  sys.loadoutStore.saveNow('starter');
  }

/**
 * The starter grant, once per profile (2026-09-07 fix). The old condition was `Stash.firstRun` — no `scav.stash` file —
 * which silently skipped every profile that existed before the grant did, and every profile whose stash was emptied
 * by an incoming (empty) server document. The state now lives in its own localStorage key:
 *   `none` → grant here (as a `fresh` document on a true first run, so a real server profile still wins) and mark
 *            `pending`; `pending` → re-checked once at `net:profileLoaded`, where the server's stash is known, and
 *            settled to `done` either way. A player who already owns something is settled without a grant.
 */
export function tryStarterGrant(sys: InventorySystem): void {
  const state = starterGrantState();
  // already owns a stash → nothing to hand out, and never ask again
  if (sys.stash.count > 0) { setStarterGrantState('done'); return; }
  // a grant made at init can still be replaced by an (empty) server stash document, so it stays `pending` until
  // the `net:profileLoaded` re-check has seen the result once — that call is the one that settles it.
  setStarterGrantState(state === 'none' ? 'pending' : 'done');
  if (sys.stash.firstRun && state === 'none') sys.withFreshSave(() => sys.grantStarterStash());
  else sys.grantStarterStash();
  // the minimum kit is equipped from `hub:entered`; a grant that lands after the player is already aboard equips now
  if (sys.ctx.isHubPhase() && sys.isCompletelyEmpty()) sys.applyStarter();
  else sys.firstRunGrant = true;
  }

/**
 * `STARTER_STASH` into the stash (2026-09-07); the "once per profile" decision is `tryStarterGrant`. `stacks`
 * splits an entry into that many full stacks — one set per grid cell.
 */
export function grantStarterStash(sys: InventorySystem): void {
  for (const e of STARTER_STASH) {
    const def = ITEM_DEF_MAP.get(e.id);
    if (!def) { console.warn(`[Inventory] 기본 지급품 '${e.id}' has no def`); continue; }
    for (let n = 0; n < Math.max(1, e.stacks ?? 1); n++) {
      const qty = Math.max(1, Math.min(e.qty, def.stackMax));
      if (!sys.stash.grid.autoPlace(sys.loot.createItem(e.id, qty))) {
        console.warn(`[Inventory] 함선 창고가 가득 차 기본 지급품 '${e.id}'를 넣지 못했습니다`);
        break;
      }
    }
  }
  sys.stash.markDirty();
  sys.stash.flush();
  sys.ctx.bus.emit('inventory:stashChanged', { count: sys.stash.count });
  }

/** Wipe the bag + slots and apply `STARTER_LOADOUT` (`items[].qty` are units / rounds). */
export function applyStarter(sys: InventorySystem): void {
  sys.bag.clear();
  const mk = (id: string | null): ItemInstance | null => (id && ITEM_DEF_MAP.has(id) ? sys.loot.createItem(id) : null);
  const bagItem = mk(STARTER_LOADOUT.bag);
  sys.loadout = {
    primary: mk(STARTER_LOADOUT.primary),
    primary2: mk(STARTER_LOADOUT.primary2),
    secondary: mk(STARTER_LOADOUT.secondary),
    bag: bagItem,
    armor: mk(STARTER_LOADOUT.armor),
    // A-15: the pouch is not in the starter grant (it is made at the printer)
    pouch: null,
  };
  const size = sys.bagSizeOf(bagItem);
  sys.bag.resize(size.cols, size.rows);
  Pouch.resetPouchGrid(sys);
  for (const e of STARTER_LOADOUT.items) sys.addUnits(e.id, e.qty);
  // 2026-09-09: the picks are **moved** out of the bag onto the wheel (it is its own container now).
  sys.quickSlots = createQuickSlots();
  for (const { index, item } of pickStarterQuick(sys.quickSlots, sys.getAllItems(), (id: string) => ITEM_DEF_MAP.get(id), sys.getQuickSlotCount())) {
    sys.bag.remove(item.uid);
    sys.quickSlots[index] = item;
  }
  sys.lastGrenades = -1; sys.lastStims = -1; sys.lastQuickSig = ''; sys.lastPouchSig = ''; // force count / quick-slot / pouch events
  sys.ctx.bus.emit('inventory:bagChanged', { ...size, dropped: [] });
  sys.emitLoadout();
  sys.afterChange();
  // Phase 5: persist the starter right away so a reload cannot bring back a bag lost to death / abort
  sys.announcePending = false;
  sys.loadoutStore.saveNow('starter');
  }
