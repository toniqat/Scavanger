/**
 * src/inventory/parts/Lifecycle.ts — **세이브 · 기본 지급품 · 미션 리셋**.
 *
 * `InventorySystem` 에서 떼어낸 함수들이다. 인스턴스를 첫 인자 `sys` 로 받고, 클래스에는 같은 이름의
 * 한 줄 위임 메서드가 남아 있으므로 **호출부는 전부 그대로**다.
 * 여기가 답하는 질문은 하나다 — *레이드가 시작 · 종료 · 실패할 때 플레이어의 장비에 무슨 일이 일어나는가.*
 * 규칙 전문은 폴더 README 의 `Reset policy` 절에 있다.
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
import {
  AUTO_CLOSE_DISTANCE, BLOCKER_TOKEN, CRAFT_MIN_SPEED, DROP_EYE_LOWER, DROP_FORWARD_OFFSET, DROP_FORWARD_SPEED, DROP_UP_SPEED,
  LOADOUT_SLOTS, MOD_CTRL, MOD_SHIFT, SEARCH_EMIT_INTERVAL, SPRAY_REFILL_COST, TAKE_REQUEST_TIMEOUT, WEAPON_SLOT_IDS,
  isArmorDef, isAttachmentDef, isBagDef, isDisassembleRecipe, isWeaponDef, sameProfileDoc, slotAccepts,
  type ActiveBench, type BagSize, type BenchRecipeRow, type BenchRepairRow, type DropPreview, type DropTarget,
  type GridId, type ItemLocation, type OpResult, type PendingTake, type RaidInventoryState, type SlotId,
} from '../model';
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
  sys.closeAll();
  sys.clearContainers();
  if (sys.isDestitute()) { sys.applyStarter(); return; }
  sys.lastGrenades = -1; sys.lastStims = -1; sys.lastQuickSig = '';
  if (sys.announcePending) { sys.announcePending = false; sys.lastEquipUids = {}; sys.lastWeight = null; }
  sys.emitLoadout();
  sys.afterChange();
  }

/**
 * Snapshot for the save file: slots + bag placements + the wheel's own stacks.
 *
 * v2 (2026-09-09): `quick[i]` is the **stack itself**, not an index into `bag` — the wheel is its own container, so
 * a stack on the wheel is not in `bag` at all. `Loadout.sanitizeLoadoutSave` migrates a v1 file on read.
 */
export function captureLoadoutSave(sys: InventorySystem): LoadoutSave {
  const slots: LoadoutSave['slots'] = {};
  for (const s of LOADOUT_SLOTS) { const it = sys.loadout[s]; if (it) slots[s] = serializeExtras(it); }
  const placements = sys.bag.items();
  const quick = sys.quickSlots.map((it) => (it ? serializeExtras(it) : null));
  return { v: LOADOUT_SAVE_VERSION, slots, bag: placements.map(serializePlacement), quick };
  }

/**
 * Fill the slots / bag / quick slots from the save (init only, no events). A missing / empty save leaves
 * everything empty so `hub:entered` hands out the starter kit as before. Unknown defs and items that no longer
 * fit are dropped with a warning; a wrong-category slot entry is ignored.
 */
export function restoreLoadoutSave(sys: InventorySystem): boolean {
  const save = loadLoadoutSave();
  if (!save || isEmptyLoadoutSave(save)) return false;
  sys.applyLoadoutSave(save);
  sys.announcePending = true;
  return true;
  }

/**
 * Replace the slots / bag / quick slots with `save` (no events — callers announce). Returns the revived bag
 * instances in `save.bag` order (null = dropped) so a raid state can restore per-entry flags.
 */
export function applyLoadoutSave(sys: InventorySystem, save: LoadoutSave): (ItemInstance | null)[] {
  const getDef = (id: string): ItemDef | undefined => ITEM_DEF_MAP.get(id);
  const loadout: Loadout = { primary: null, primary2: null, secondary: null, bag: null, armor: null };
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
  for (const sv of save.bag) {
    const item = reviveItem(sv, getDef, sys.loot, 'Loadout');
    revived.push(item);
    if (!item) continue;
    const cell = savedCell(sv);
    if (cell && sys.bag.place(item, cell.x, cell.y, !!sv.rotated)) continue;
    pending.push(item);
  }
  for (const item of pending) {
    if (!sys.bag.autoPlace(item)) { console.warn(`[Loadout] no room for '${item.defId}' on load — discarded`); revived[revived.indexOf(item)] = null; }
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
  return revived;
  }

/** First `hub:entered` after a restored save: tell every consumer (they subscribed after our init). */
export function announceLoaded(sys: InventorySystem): void {
  sys.announcePending = false;
  sys.lastEquipUids = {}; sys.lastWeight = null;
  sys.lastGrenades = -1; sys.lastStims = -1; sys.lastQuickSig = '';
  sys.ctx.bus.emit('inventory:bagChanged', { ...sys.getBagSize(), dropped: [] });
  sys.emitLoadout();
  sys.afterChange();
  }

/** Legacy mission failure (Phase 2 death flow no longer emits it): everything carried is lost (2026-09-07). */
export function onGameOver(sys: InventorySystem): void {
  sys.outcome = 'over';
  sys.closeAll();
  sys.clearContainers();
  sys.loseKit();
  }

/**
 * 부활 시 인벤토리.
 *
 * 2026-09-09: **자동 부활이 사라지고** 되살아나는 길은 분대원의 구조선뿐이다. 완전히 사망한 순간
 * `stripForCorpse()` 가 들고 있던 것을 전부 시체로 옮겼으므로 **구조 포드에서는 빈손으로 내린다** —
 * `strippedForCorpse` 가 서 있으면 아무것도 지급하지 않고 그 표시만 내린다.
 *
 * 그 밖의 재드롭(훈련장 재시작, 재접속 복귀 실패 fallback)은 예전처럼 스타터 킷을 받는다.
 * 레이드 실패 후 함선 복귀의 킷 리셋은 `onAbort` / `onGameOver` → `loseKit` 이 그대로 맡는다.
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
  return LOADOUT_SLOTS.every((s) => !sys.loadout[s]) && sys.bag.isEmpty;
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
  sys.loadout = { primary: null, primary2: null, secondary: null, bag: null, armor: null };
  const size = sys.bagSizeOf(null);
  sys.bag.resize(size.cols, size.rows);
  sys.quickSlots.fill(null);
  sys.lastGrenades = -1; sys.lastStims = -1; sys.lastQuickSig = '';
  sys.ctx.bus.emit('inventory:bagChanged', { ...size, dropped: [] });
  sys.emitLoadout();
  sys.afterChange();
  sys.announcePending = false;
  sys.loadoutStore.saveNow('starter');
  }

/**
 * 기본 지급품, once per profile (2026-09-07 fix). The old condition was `Stash.firstRun` — no `scav.stash` file —
 * which silently skipped every profile that existed before the grant did, and every profile whose 창고 was emptied
 * by an incoming (empty) server document. The state now lives in its own localStorage key:
 *   `none` → grant here (as a `fresh` document on a true first run, so a real server profile still wins) and mark
 *            `pending`; `pending` → re-checked once at `net:profileLoaded`, where the server's 창고 is known, and
 *            settled to `done` either way. A player who already owns something is settled without a grant.
 */
export function tryStarterGrant(sys: InventorySystem): void {
  const state = starterGrantState();
  // already owns a 창고 → nothing to hand out, and never ask again
  if (sys.stash.count > 0) { setStarterGrantState('done'); return; }
  // a grant made at init can still be replaced by an (empty) server 창고 document, so it stays `pending` until
  // the `net:profileLoaded` re-check has seen the result once — that call is the one that settles it.
  setStarterGrantState(state === 'none' ? 'pending' : 'done');
  if (sys.stash.firstRun && state === 'none') sys.withFreshSave(() => sys.grantStarterStash());
  else sys.grantStarterStash();
  // the minimum kit is equipped from `hub:entered`; a grant that lands after the player is already aboard equips now
  if (sys.ctx.isHubPhase() && sys.isCompletelyEmpty()) sys.applyStarter();
  else sys.firstRunGrant = true;
  }

/**
 * `STARTER_STASH` into the 함선 창고 (2026-09-07); the "once per profile" decision is `tryStarterGrant`. `stacks`
 * splits an entry into that many full stacks — one 세트 per grid cell.
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
  };
  const size = sys.bagSizeOf(bagItem);
  sys.bag.resize(size.cols, size.rows);
  for (const e of STARTER_LOADOUT.items) sys.addUnits(e.id, e.qty);
  // 2026-09-09: the picks are **moved** out of the bag onto the wheel (it is its own container now).
  sys.quickSlots = createQuickSlots();
  for (const { index, item } of pickStarterQuick(sys.quickSlots, sys.getAllItems(), (id: string) => ITEM_DEF_MAP.get(id), sys.getQuickSlotCount())) {
    sys.bag.remove(item.uid);
    sys.quickSlots[index] = item;
  }
  sys.lastGrenades = -1; sys.lastStims = -1; sys.lastQuickSig = ''; // force count / quick-slot events
  sys.ctx.bus.emit('inventory:bagChanged', { ...size, dropped: [] });
  sys.emitLoadout();
  sys.afterChange();
  // Phase 5: persist the starter right away so a reload cannot bring back a bag lost to death / abort
  sys.announcePending = false;
  sys.loadoutStore.saveNow('starter');
  }
