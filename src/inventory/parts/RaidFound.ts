/**
 * src/inventory/parts/RaidFound.ts — **item recovery contracts: 「found in this raid」** (2026-09-12, user's decision).
 *
 * The rule itself (seed · mark · stack key) lives in `shared/raidFound.ts` alone; this file only holds **where the inventory hangs it**:
 *  - `installRaidFoundRules` — the stack key every grid · wheel · sort reads (`Grid.setStackKeyRule`) and the mark seed of the
 *    crate roll (`ContainerStore.raidMark`). Both read **the ctx at query time** — abandoning the contract releases it from the next query on.
 *  - `raidFoundScope` — the active recovery contract's scope (only in a real raid + `extract_with_items`).
 *  - `stripRaidMarks` — when the raid ends (`game:complete` · `game:over` · `game:abort` · `hub:entered`) every mark on the body
 *    and in the stash is wiped. They never ride in the profile document (`Serialize.serializeExtras` does not write them), so there is nothing to save.
 *  - `annotateRaidState` — puts `rf` in the raid session blob only (so a rejoin · a solo resume does not lose the marks).
 */
import type { ItemInstance, RaidFoundScope } from '@/shared';
import { raidFoundScopeOf, raidFoundSeed, raidFoundStackKey, stripRaidFound } from '@/shared';
import { setStackKeyRule } from '../Grid';
import { LOADOUT_SLOTS, type RaidInventoryState } from '../model';
import type { SavedExtras } from '../Serialize';
import type { InventorySystem } from '../InventorySystem';

/** The active recovery contract's scope (a real raid · `extract_with_items`), else null. */
export function raidFoundScope(sys: InventorySystem): RaidFoundScope | null {
  return raidFoundScopeOf(sys.ctx);
}

/** Once, in `init`: the stack key + the crate roll's mark seed. */
export function installRaidFoundRules(sys: InventorySystem): void {
  setStackKeyRule((item) => raidFoundStackKey(item, raidFoundScopeOf(sys.ctx)));
  sys.containers.raidMark = () => raidFoundSeed(sys.ctx);
}

/** Wipes the mark off one instance and its socketed attachments. True when something was wiped. */
function stripDeep(item: ItemInstance | null | undefined): boolean {
  if (!item) return false;
  let changed = stripRaidFound(item);
  if (item.sockets) for (const att of Object.values(item.sockets)) if (att && stripRaidFound(att)) changed = true;
  return changed;
}

/**
 * The raid ended: every mark on the equipment slots · bag · wheel · pouch · stash is wiped. A changed grid bumps its version and is redrawn.
 * The marks are not in the document, so nothing has to be saved. True when something changed.
 */
export function stripRaidMarks(sys: InventorySystem): boolean {
  let changed = false;
  for (const s of LOADOUT_SLOTS) if (stripDeep(sys.loadout[s])) changed = true;
  for (const grid of [sys.bag, sys.pouch, sys.stash.grid]) {
    let touched = false;
    for (const p of grid.items()) if (stripDeep(p.item)) touched = true;
    if (touched) { grid.version++; changed = true; }
  }
  for (const it of sys.quickSlots) if (stripDeep(it)) changed = true;
  return changed;
}

/** Puts the marks on `captureRaidState`'s document — the document's entry order is exactly the order `captureLoadoutSave` read. */
export function annotateRaidState(sys: InventorySystem, state: RaidInventoryState): void {
  const tag = (sv: SavedExtras | null | undefined, item: ItemInstance | null | undefined): void => {
    if (sv && item && typeof item.raidFound === 'number') sv.rf = item.raidFound;
  };
  for (const s of LOADOUT_SLOTS) tag(state.slots[s], sys.loadout[s]);
  const bag = sys.bag.items();
  state.bag.forEach((sv, i) => tag(sv, bag[i]?.item));
  state.quick.forEach((sv, i) => tag(sv, sys.quickSlots[i]));
  const pouch = sys.pouch.items();
  state.pouch.forEach((sv, i) => tag(sv, pouch[i]?.item));
}
