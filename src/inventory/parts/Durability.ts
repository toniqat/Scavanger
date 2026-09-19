/**
 * src/inventory/parts/Durability.ts — **durability · repair · sockets**.
 *
 * The paths where weapons and armor wear down (`damageDurability`), are fixed with materials (`repair` /
 * `repairWeapon`) and take attachments on and off (`attachToWeapon` / `detachAllSockets`). Refilling the gauge of a
 * `회복 스프레이` lives here too (`sprayRepairCost` — it charges materials only for the missing part of the gauge).
 */
import * as THREE from 'three';
import type {
  ContainerMessage, ContainerRequest, CraftIngredient, CraftRecipe, CraftStation, DurabilityInfo, GameContext, ItemCategory, ItemDef,
  ItemInstance, Loadout, LoadoutSlot, PeerId as NetPeerId, ProfileRecord, SocketSlot, WeaponSlot, WeightInfo, LoadoutPreset, WorkbenchKind, EmbeddedView,
} from '@/shared';
import { BAG_DEFAULT_COLS, BAG_DEFAULT_QUICK_SLOTS, BAG_DEFAULT_ROWS, BAG_DURABILITY_PER_RAID, Keys, QUICK_SLOTS, SEARCH_MAX_DISTANCE, SOCKET_SLOTS, isQuickSlotActive } from '@/shared';
import { AMMO_LABEL_KO, ITEM_DEF_MAP, STARTER_LOADOUT, STARTER_STASH, ammoItemIdFor, getRecipe, isWeaponItemDef, itemWeight, needsRepairCost } from '@/items';
import { durabilityInfo, gearMultipliers, makeWeightInfo, searchTimeFor, sumWeight } from '../Gear';
import { Grid, OOB, type Placement, type PriorityPlacement } from '../Grid';
import { Container, ContainerStore } from '../Container';
import { attachedItems, clearSocket, findSocketed, setSocket } from '../Sockets';
/* 2026-09-12: the rule for where a socket may be touched is owned by `DropResolver` alone (bag · equipment slot · ship stash) */
import { canSocketAt } from './DropResolver';
import { setStarterGrantState, starterGrantState } from '../Stash';
import { LOADOUT_SAVE_VERSION, isEmptyLoadoutSave, loadLoadoutSave, sanitizeLoadoutSave, type LoadoutSave } from '../Loadout';
import { reviveItem, savedCell, serializeExtras, serializePlacement, type SavedPlacement } from '../Serialize';
import {
  AUTO_CLOSE_DISTANCE, BLOCKER_TOKEN, CRAFT_MIN_SPEED, DROP_EYE_LOWER, DROP_FORWARD_OFFSET, DROP_FORWARD_SPEED, DROP_UP_SPEED,
  LOADOUT_SLOTS, MOD_CTRL, MOD_SHIFT, SEARCH_EMIT_INTERVAL, SPRAY_REFILL_COST, TAKE_REQUEST_TIMEOUT, WEAPON_SLOT_IDS,
  isArmorDef, isAttachmentDef, isBagDef, isDisassembleRecipe, isWeaponDef, sameProfileDoc, slotAccepts,
  type ActiveBench, type BagSize, type BenchRecipeRow, type BenchRepairRow, type DropPreview, type DropTarget,
  type GridId, type ItemLocation, type OpResult, type PendingTake, type RaidInventoryState, type RepairInfo, type SlotId,
} from '../model';
import type { InventorySystem } from '../InventorySystem';

/** Durability of a weapon (effective max) or armor (`ItemDef.durabilityMax`), or null. */
export function getDurability(sys: InventorySystem, uid: string): DurabilityInfo | null {
  const item = sys.findItem(uid);
  const def = item && ITEM_DEF_MAP.get(item.defId);
  if (!item || !def) return null;
  const stats = sys.loot.getEffectiveStats(item);
  if (stats) {
    const cur = Math.max(0, Math.min(stats.maxDurability, item.durability ?? stats.maxDurability));
    return { uid, durability: cur, max: stats.maxDurability, broken: cur <= 0 };
  }
  return durabilityInfo(item, def);
  }

/** Wear on non-weapon gear (armor per absorbed hit). Weapons keep `updateItem` (weapons/ owns that path). */
export function damageDurability(sys: InventorySystem, uid: string, amount: number): void {
  const wear = Math.max(0, amount);
  if (wear === 0) return;
  const item = sys.findItem(uid);
  const def = item && ITEM_DEF_MAP.get(item.defId);
  const max = def?.durabilityMax;
  if (!item || !def || max === undefined || max <= 0) return;
  const before = Math.max(0, Math.min(max, item.durability ?? max));
  if (before <= 0) return;
  const after = Math.max(0, before - wear);
  if (after === before) return;
  item.durability = after;
  sys.ctx.bus.emit('durability:changed', { uid, defId: def.id, durability: after, max });
  sys.ctx.bus.emit('inventory:itemUpdated', { item });
  if (after <= 0) {
    sys.ctx.bus.emit('durability:broken', { uid, defId: def.id, name: def.name });
    sys.ctx.bus.emit('ui:notify', { text: `${def.name} 파손!`, kind: 'danger' });
    sys.ctx.bus.emit('audio:play', { id: 'gear_broken' });
  }
  if (sys._open) sys.ui?.refresh();
  }

/**
 * 2026-09-11 (C-36) — **the bag wears once per raid.** The equipped bag loses `BAG_DURABILITY_PER_RAID`.
 *
 * - Two callers: a successful extraction (`stats.extracted` in `game:complete`) and death (`CorpseLoot.stripForCorpse`,
 *   **before** it moves anything to the corpse). Only the first to arrive wears it — `bagWornThisRaid` stands for the
 *   whole raid, so death → rescue drop → recovering the bag and extracting never wears it twice, and swapping bags
 *   mid-raid is still once. Dying with no bag wears nothing, so no mark is raised (extracting on a bag picked up
 *   afterwards wears that bag).
 * - The training range is not a raid (`missionMode === 'training'`).
 * - **Reaching 0 has no effect** (user's decision) — the grid · quick slots are unchanged and only the repair cost is
 *   large. So unlike `damageDurability` it does not emit `durability:broken` (the 「파손 — 성능이 크게 떨어집니다」
 *   toast · the break sound). The low warning is raised by the HUD itself off `durability:changed`.
 *
 * True when it wore.
 */
export function wearBagForRaid(sys: InventorySystem): boolean {
  if (sys.bagWornThisRaid || sys.ctx.missionMode === 'training') return false;
  const bag = sys.loadout.bag;
  const def = bag && ITEM_DEF_MAP.get(bag.defId);
  const max = def?.durabilityMax;
  if (!bag || !def || max === undefined || max <= 0) return false;
  sys.bagWornThisRaid = true;
  const before = Math.max(0, Math.min(max, bag.durability ?? max));
  const after = Math.max(0, before - Math.max(0, BAG_DURABILITY_PER_RAID));
  if (after === before) return true;
  bag.durability = after;
  sys.ctx.bus.emit('durability:changed', { uid: bag.uid, defId: def.id, durability: after, max });
  sys.ctx.bus.emit('inventory:itemUpdated', { item: bag });
  if (sys._open) sys.ui?.refresh();
  return true;
}

/**
 * Phase 12: refill cost of a 회복 스프레이 (`ItemDef.heal.spray`, gauge = `durability` / `durabilityMax`) — one 캔 +
 * one 소독약 per **full** refill, scaled by the missing fraction (ceil, never below 1 each). null for anything else
 * or a full can. The materials come from the bag, exactly like a weapon repair.
 */
export function sprayRepairCost(sys: InventorySystem, item: ItemInstance, def: ItemDef): CraftIngredient[] | null {
  if (!def.heal?.spray) return null;
  const max = def.durabilityMax;
  if (max === undefined || max <= 0) return null;
  const cur = Math.max(0, Math.min(max, item.durability ?? max));
  if (cur >= max) return null;
  const missing = (max - cur) / max;
  return SPRAY_REFILL_COST.map((c) => ({ defId: c.defId, qty: Math.max(1, Math.ceil(c.qty * missing - 1e-9)) }));
  }

/**
 * **The materials a full repair costs** — decided in one place only (2026-09-10, craft rework 2nd stage).
 *
 * It used to be `getEffectiveStats(item) ? getRepairCost(item) : sprayRepairCost(...)`, so `getRepairCost` was asked
 * **only for a weapon**; armor fell into that ternary's else branch where `sprayRepairCost` is null too, and so was
 * **restored to full with no materials** (measured: `repair()` on an armor I at 5 / 200 durability spent 0 `폐금속`
 * and came back at 200). `getRepairCost` now returns a value for armor too, so **it is read first and only when it
 * is empty** does this drop to the gauge refill of a `회복 스프레이` (`sprayRepairCost`).
 *
 * 2026-09-11 (C-36): both of them empty is **not a free repair** — for an item that has a craft recipe
 * (`needsRepairCost`) that is a hole in the repair table, so `repair` · `repairInfo` and the bench repair list all
 * refuse it. The bag joined `Salvage.REPAIRABLE` when it gained durability, and `npm run data:check` checks the same rule over the whole table.
 */
export function repairMaterials(sys: InventorySystem, item: ItemInstance, def: ItemDef): CraftIngredient[] {
  const cost = sys.loot.getRepairCost(item);
  if (cost.length) return cost;
  return sys.sprayRepairCost(item, def) ?? [];
}

/**
 * Ship workbench: weapons go through `repairWeapon` (materials), everything else pays `repairMaterials` — armor is
 * **craft materials × the durability bucket multiplier**, a `회복 스프레이` is a `캔` + `소독약` (Phase 12), the rest free.
 */
export function repair(sys: InventorySystem, uid: string): boolean {
  if (sys.ctx.isRaidActive()) return false;
  const item = sys.findItem(uid);
  const def = item && ITEM_DEF_MAP.get(item.defId);
  if (!item || !def) return false;
  if (sys.loot.getEffectiveStats(item)) {
    const ok = sys.repairWeapon(uid);
    if (ok) sys.ctx.bus.emit('repair:completed', { uid, name: def.name, durability: item.durability ?? 0 });
    return ok;
  }
  const max = def.durabilityMax;
  if (max === undefined || max <= 0) return false;
  if ((item.durability ?? max) >= max) return false;
  // all materials or nothing — a half-worn armor / an empty can stays a valid (n / max) item until then
  const cost = repairMaterials(sys, item, def);
  if (!cost.length && needsRepairCost(def)) return false;   // a hole in the repair table is not a free repair
  for (const c of cost) if (sys.countDef(c.defId) < c.qty) return false;
  for (const c of cost) sys.consumeWhere((d) => d.id === c.defId, c.qty);
  item.durability = max;
  sys.ctx.bus.emit('inventory:itemUpdated', { item });
  sys.ctx.bus.emit('durability:changed', { uid, defId: def.id, durability: max, max });
  sys.ctx.bus.emit('repair:completed', { uid, name: def.name, durability: max });
  sys.ctx.bus.emit('audio:play', { id: 'gear_repair' });
  sys.afterChange();
  return true;
  }

/**
 * Context-menu repair readout (hub only): materials still needed (`[]` = free), `short` = which of them the bag
 * lacks, `bucket` = the remaining-durability bucket (that bucket's multiplier is the material quantity — 2026-09-10).
 * null when the item is not worn / not repairable.
 */
export function repairInfo(sys: InventorySystem, uid: string): RepairInfo | null {
  const item = sys.findItem(uid);
  const def = item && ITEM_DEF_MAP.get(item.defId);
  if (!item || !def) return null;
  const dur = sys.getDurability(uid);
  if (!dur || dur.max <= 0 || dur.durability >= dur.max) return null;
  // 2026-09-10: `getRepairCost` is read **first** (weapons · armor). Only when it is empty, the `회복 스프레이` gauge refill.
  const byCraft = sys.loot.getRepairCost(item);
  const raw = byCraft.length ? byCraft : sys.sprayRepairCost(item, def) ?? [];
  if (!raw.length && needsRepairCost(def)) return null;   // 2026-09-11: never offer a free repair for a crafted item
  const cost = raw.map((c) => ({
    ...c, name: ITEM_DEF_MAP.get(c.defId)?.name ?? c.defId, have: sys.countDef(c.defId),
  }));
  // The bucket means something **only when the value came out of the craft-material rule**. A `회복 스프레이`'s `캔` ·
  // `소독약` are set by the gauge fraction (`sprayRepairCost`), so saying `n % of the craft materials` here would lie.
  return { cost, short: cost.some((c) => c.have < c.qty), bucket: byCraft.length ? sys.loot.durabilityBucketInfo(item) : null };
  }

/** Socket a bag (or open-container) attachment into a player-owned weapon; see `attachFrom`. */
export function attachToWeapon(sys: InventorySystem, weaponUid: string, attachmentUid: string): boolean {
  const w = sys.locate(weaponUid);
  const a = sys.locate(attachmentUid);
  if (!w || !a || a.from.kind !== 'grid') return false;
  return sys.attachFrom(attachmentUid, a.from, weaponUid, w.from) === 'ok';
  }

/**
 * Every attachment of weapon `uid` back into the bag (overflow: the stash in the ship, the ground when even that is
 * full). False when there are none / it is not found.
 *
 * 2026-09-12 (user's decision): the targets are `canSocketAt` — bag · equipment slot · **ship stash**, and not a
 * container or a corpse (the reason for that rule is in the comment on `parts/DropResolver.canSocketAt`).
 */
export function detachAllSockets(sys: InventorySystem, uid: string): boolean {
  const w = sys.locate(uid);
  if (!w || !canSocketAt(sys, w.from) || !isWeaponItemDef(ITEM_DEF_MAP.get(w.item.defId))) return false;
  const weapon = w.item;
  let n = 0;
  for (const socket of SOCKET_SLOTS) {
    const att = clearSocket(weapon, socket);
    if (!att) continue;
    n++;
    if (!sys.bag.autoPlace(att) && !(sys.hubMode && sys.tryAddToStash(att))) sys.throwToWorld(att, true);
    sys.ctx.bus.emit('inventory:socketChanged', { weapon, socket, attachment: null });
  }
  if (n === 0) return false;
  sys.afterSocketChange(weapon);
  sys.afterChange();
  return true;
  }

/** Magazine → bag as ammo of the weapon's calibre (merge into stacks, new stacks, overflow drops). */
export function unloadWeapon(sys: InventorySystem, uid: string): boolean {
  const w = sys.locate(uid);
  if (!w || sys.locKind(w.from) !== 'player') return false;
  const weapon = w.item;
  const stats = sys.loot.getEffectiveStats(weapon);
  const rounds = Math.floor(weapon.ammoInMag ?? 0);
  if (!stats || rounds <= 0) return false;
  weapon.ammoInMag = 0;
  sys.returnRounds(stats.ammoType, rounds);
  if (sys.bag.has(weapon.uid)) sys.bag.version++;
  sys.ctx.bus.emit('inventory:itemUpdated', { item: weapon });
  sys.afterChange();
  return true;
  }

/** Workbench repair: all materials from `LootRef.getRepairCost` or nothing. */
export function repairWeapon(sys: InventorySystem, uid: string): boolean {
  const w = sys.locate(uid);
  if (!w || sys.locKind(w.from) !== 'player') return false;
  const weapon = w.item;
  const stats = sys.loot.getEffectiveStats(weapon);
  const cost = sys.loot.getRepairCost(weapon);
  if (!stats || cost.length === 0) return false;
  for (const c of cost) if (sys.countWhere((d) => d.id === c.defId) < c.qty) return false;
  for (const c of cost) sys.consumeWhere((d) => d.id === c.defId, c.qty);
  weapon.durability = stats.maxDurability;
  if (sys.bag.has(weapon.uid)) sys.bag.version++;
  sys.ctx.bus.emit('inventory:itemUpdated', { item: weapon });
  sys.afterChange();
  return true;
  }
