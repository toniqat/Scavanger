/**
 * src/inventory/parts/Crafting.ts — **제작 · 분해 · 작업대**.
 *
 * 필드 제작(`제작` 열)과 함선 작업대(`openBenchCraft`)는 같은 규칙을 쓰고 재료 출처만 다르다:
 * 레이드에서는 가방만, 함선에서는 가방 + 함선 창고(`countDefAll` / `consumeDefAll`).
 * 분해(`break_*`)는 제작 목록이 아니라 아이템 우클릭에서 열리며 진행 게이지를 `inventory:disassembleProgress` 로 흘린다.
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
import {
  assignQuickSlot, autoAssignQuickSlots, createQuickSlots, firstFreeQuickSlot, isQuickIndex, isQuickUsable, pruneQuickSlots,
  quickSlotOf, quickSlotsSignature, relinkQuickSlot, type QuickSlotUids,
} from '../QuickSlots';
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

/** 'ship' while walking the hub / menus, 'field' on a mission. */
export function currentStation(sys: InventorySystem): CraftStation {
  return sys.ctx.isRaidActive() ? 'field' : 'ship';
  }

/**
 * Open the craft panel in bench mode (ship only): recipes of `getRecipes('ship', bench, level)` + locked rows for
 * the bench's higher-level recipes, workshop cost discount, and the repair list of the gear that bench services.
 */
export function openBenchCraft(sys: InventorySystem, bench: WorkbenchKind, level: number): void {
  const ctx = sys.ctx;
  if (!ctx.isHubPhase()) {
    ctx.bus.emit('ui:notify', { text: '작업대는 함선에서만 사용할 수 있습니다', kind: 'warning', duration: 2 });
    return;
  }
  sys.bench = { kind: bench, level: Math.max(0, Math.floor(level)) };
  if (!sys._open) {
    sys.activeContainer = null;
    sys.hubMode = true;
    sys.setOpen(true);
    sys.ui?.show(null, true);
    ctx.bus.emit('inventory:opened', { containerId: null });
  }
  sys.ui?.setCraftOpen(true);
  ctx.bus.emit('ui:craftToggled', { open: true });
  }

/** Bench the craft panel is showing (null = plain 제작 panel). */
export function getBench(sys: InventorySystem): ActiveBench | null { return sys.bench; }

/** Leave bench mode (panel 닫기 / window closed). The window itself stays open. */
export function closeBench(sys: InventorySystem): void {
  if (!sys.bench) return;
  sys.bench = null;
  sys.cancelCraft();
  sys.ui?.setCraftOpen(false);
  sys.ctx.bus.emit('ui:craftToggled', { open: false });
  }

/** Rows for the craft panel: available recipes, then (bench mode) the bench's recipes above its level as locked. */
export function getBenchRecipes(sys: InventorySystem): BenchRecipeRow[] {
  const b = sys.bench;
  if (!b) return sys.getRecipes(sys.currentStation()).filter((r) => !isDisassembleRecipe(r)).map((recipe) => ({ recipe, locked: false }));
  const open = sys.getRecipes('ship', b.kind, b.level).filter((r) => !isDisassembleRecipe(r));
  const skillOf = (id: CraftRecipe['skill']): number => sys.ctx.progression?.getSkill(id) ?? 0;
  const locked = sys.loot.getAllRecipes().filter((r) =>
    r.station === 'ship' && r.bench === b.kind && (r.benchLevel ?? 1) > b.level && skillOf(r.skill) >= r.skillRequired);
  return [...open.map((recipe) => ({ recipe, locked: false })), ...locked.map((recipe) => ({ recipe, locked: true }))];
  }

/** Gear the active bench repairs: gun → weapons (slots + bag), gear → armor + bags, others none. Items without durability are skipped. */
export function benchRepairRows(sys: InventorySystem): BenchRepairRow[] {
  const b = sys.bench;
  if (!b || (b.kind !== 'gun' && b.kind !== 'gear')) return [];
  const wants = (def: ItemDef): boolean => b.kind === 'gun' ? isWeaponItemDef(def) : (def.category === 'armor' || def.category === 'bag');
  const rows: BenchRepairRow[] = [];
  const push = (item: ItemInstance, where: LoadoutSlot | null): void => {
    const def = ITEM_DEF_MAP.get(item.defId);
    if (!def || !wants(def)) return;
    const dur = sys.getDurability(item.uid);
    if (!dur || dur.max <= 0) return;
    const cost = (sys.loot.getEffectiveStats(item) ? sys.loot.getRepairCost(item) : []).map((c) => ({
      ...c, name: ITEM_DEF_MAP.get(c.defId)?.name ?? c.defId, have: sys.countDef(c.defId),
    }));
    rows.push({ uid: item.uid, item, def, where, dur, cost, short: cost.some((c) => c.have < c.qty) });
  };
  for (const slot of LOADOUT_SLOTS) { const it = sys.loadout[slot]; if (it) push(it, slot); }
  for (const p of sys.bag.items()) push(p.item, null);
  return rows;
  }

/** `모두 수리`: every worn row in order while the materials last. */
export function benchRepairAll(sys: InventorySystem): { done: number; skipped: number } {
  let done = 0, skipped = 0;
  for (const row of sys.benchRepairRows()) {
    if (row.dur.durability >= row.dur.max) continue;
    if (row.short) { skipped++; continue; }
    if (sys.repair(row.uid)) done++; else skipped++;
  }
  return { done, skipped };
  }

/**
 * Recipes for a station given the current skills. Field: `station: 'field'` recipes only. Ship: field recipes
 * too; a recipe with `bench` needs that bench — at `bench` (given) with `benchLevel ≤ level`, otherwise a placed
 * bench of that kind at that level (`ctx.housing.getBenchLevel`, 0 without housing).
 */
export function getRecipes(sys: InventorySystem, station: CraftStation, bench?: WorkbenchKind, level = 0): readonly CraftRecipe[] {
  const skillOf = (id: CraftRecipe['skill']): number => sys.ctx.progression?.getSkill(id) ?? 0;
  const housing = sys.ctx.housing;
  const placedLevel = (kind: WorkbenchKind): number =>
    housing && typeof housing.getBenchLevel === 'function' ? Math.max(0, housing.getBenchLevel(kind) || 0) : 0;
  return sys.loot.getAllRecipes().filter((r) => {
    if (skillOf(r.skill) < r.skillRequired) return false;
    if (station === 'field') return r.station === 'field';
    if (r.bench === undefined) return true;
    const need = r.benchLevel ?? 1;
    if (bench !== undefined) return r.bench === bench && need <= level;
    return placedLevel(r.bench) >= need;
  });
  }

/**
 * Phase 8 — 분해 recipe of an item the player owns, or null. A `break_*` recipe whose **only** input is that
 * item's def id counts; the UI turns it into the `분해` context-menu entry and the modeless dialog. Crafting
 * itself is unchanged (`craft()` still accepts these recipes) — they are only hidden from the craft *list*.
 */
export function disassembleRecipeFor(sys: InventorySystem, uid: string): CraftRecipe | null {
  const item = sys.findItem(uid);
  if (!item) return null;
  for (const r of sys.loot.getAllRecipes()) {
    if (!isDisassembleRecipe(r)) continue;
    if (r.inputs.length === 1 && r.inputs[0].defId === item.defId) return r;
  }
  return null;
  }

/**
 * Open the modeless 분해 dialog over the open window (the item context menu's `분해` entry; also a handle for
 * the console / smoke tests). False when the window is closed or the item has no `break_*` recipe.
 */
export function openDisassemble(sys: InventorySystem, uid: string): boolean {
  if (!sys._open) return false;
  return sys.ui?.openDisassemble(uid) ?? false;
  }

/** Recipes the running station / bench may craft right now. */
export function availableRecipes(sys: InventorySystem): readonly CraftRecipe[] {
  const b = sys.bench;
  return b ? sys.getRecipes('ship', b.kind, b.level) : sys.getRecipes(sys.currentStation());
  }

/** Workshop material discount (`ctx.housing.getCraftCostMul`, ship only); 1 when nothing applies. */
export function craftCostMul(sys: InventorySystem): number {
  if (sys.currentStation() !== 'ship') return 1;
  const h = sys.ctx.housing;
  const m = h && typeof h.getCraftCostMul === 'function' ? h.getCraftCostMul() : 1;
  return Number.isFinite(m) && m > 0 && m < 1 ? m : 1;
  }

/** Inputs of a recipe after the workshop discount (ceil, never below 1). */
export function craftCost(sys: InventorySystem, recipe: CraftRecipe): CraftIngredient[] {
  const mul = sys.craftCostMul();
  return recipe.inputs.map((i) => ({ defId: i.defId, qty: Math.max(1, Math.ceil(i.qty * mul - 1e-9)) }));
  }

export function canCraft(sys: InventorySystem, recipeId: string): boolean {
  const r = getRecipe(recipeId);
  if (!r) return false;
  // 2026-09-08: 튜토리얼이 순서를 강제하는 동안에는 그 단계의 레시피만 (꺼져 있으면 언제나 null)
  if (sys.ctx.tutorial?.blockReason('craft', recipeId)) return false;
  return sys.craftCost(r).every((i) => sys.countDef(i.defId) >= i.qty);
  }

/**
 * 2026-09-08 — whether the bag could take `recipeId`'s output (**and** its `extraOutputs`) right now. This is
 * literally the test `updateCraft` runs when the hold ends; the 분해 dialog runs it up front so a shred that can
 * only fail is refused **before** the 2 s hold instead of after it. Deliberately conservative in the same way:
 * the input stack is still in the bag, so a 분해 that would free its own cells can read as full. Unknown recipe /
 * output def → false.
 */
export function craftHasRoom(sys: InventorySystem, recipeId: string): boolean {
  const r = getRecipe(recipeId);
  const outDef = r ? ITEM_DEF_MAP.get(r.outputDefId) : undefined;
  if (!r || !outDef) return false;
  if (!sys.bag.canAbsorb(sys.loot.createItem(r.outputDefId, Math.min(outDef.stackMax, r.outputQty)))) return false;
  for (const e of r.extraOutputs ?? []) {
    const def = ITEM_DEF_MAP.get(e.defId);
    if (!def || !sys.bag.canAbsorb(sys.loot.createItem(e.defId, Math.min(def.stackMax, e.qty)))) return false;
  }
  return true;
  }

/** Seconds one craft takes right now (recipe duration scaled by 제작 skill and 재주). */
export function craftDuration(sys: InventorySystem, recipeId: string): number {
  const r = getRecipe(recipeId);
  if (!r) return 0;
  const mult = gearMultipliers(sys.ctx.progression?.derived);
  const speed = Math.max(CRAFT_MIN_SPEED, mult.craftSpeedMul * mult.useSpeedMul);
  return r.duration / speed;
  }

/**
 * `targetUid` (2026-09-08): the exact stack the 분해 dialog was opened on — consumed first so clicking a specific
 * weapon shreds *that* one. Ordinary crafts pass nothing and keep the old `consumeDef` behaviour.
 */
export function craft(sys: InventorySystem, recipeId: string, targetUid?: string): Promise<ItemInstance | null> {
  const r = getRecipe(recipeId);
  if (!r) return Promise.resolve(null);
  sys.cancelCraft();
  if (sys.availableRecipes().indexOf(r) < 0 || !sys.canCraft(recipeId)) {
    sys.ctx.bus.emit('craft:failed', { recipeId, reason: 'missing' });
    return Promise.resolve(null);
  }
  const duration = sys.craftDuration(recipeId);
  sys.ctx.bus.emit('craft:started', { recipeId, duration });
  return new Promise<ItemInstance | null>((resolve) => {
    sys.craftJob = { recipe: r, remaining: duration, duration, resolve, targetUid };
  });
  }

/** Abort the running craft (releasing the hold button, closing the panel, dying). */
export function cancelCraft(sys: InventorySystem): boolean {
  const job = sys.craftJob;
  if (!job) return false;
  sys.craftJob = null;
  sys.ctx.bus.emit('craft:failed', { recipeId: job.recipe.id, reason: 'cancelled' });
  job.resolve(null);
  sys.ui?.refreshCraft();
  return true;
  }

/** 0..1 progress of the running craft (null when idle). */
export function craftProgress(sys: InventorySystem): { recipeId: string; progress: number } | null {
  const job = sys.craftJob;
  if (!job) return null;
  return { recipeId: job.recipe.id, progress: 1 - Math.max(0, job.remaining) / Math.max(0.001, job.duration) };
  }

/**
 * Consume `qty` of `defId`, taking the 분해 target stack first when it matches (2026-09-08). Returns false when the
 * bag could not cover the rest — the caller has already checked `canCraft`, so this is a safety net only.
 */
function consumeFor(sys: InventorySystem, defId: string, qty: number, targetUid?: string): boolean {
  let left = Math.max(0, Math.floor(qty));
  if (targetUid) {
    const target = sys.findItem(targetUid);
    if (target?.defId === defId) left -= sys.consumeItem(targetUid, left);
  }
  return left <= 0 || sys.consumeDef(defId, left);
}

export function updateCraft(sys: InventorySystem, dt: number): void {
  const job = sys.craftJob;
  if (!job || dt <= 0) return;
  job.remaining -= dt;
  if (job.remaining > 0) { sys.ui?.refreshCraft(); return; }
  sys.craftJob = null;
  const r = job.recipe;
  const outDef = ITEM_DEF_MAP.get(r.outputDefId);
  if (!sys.canCraft(r.id) || !outDef) {
    sys.ctx.bus.emit('craft:failed', { recipeId: r.id, reason: 'missing' });
    job.resolve(null);
    sys.ui?.refreshCraft();
    return;
  }
  const product = sys.loot.createItem(r.outputDefId, Math.min(outDef.stackMax, r.outputQty));
  // 2026-09-08: `extraOutputs` (기계 부품 분해) must fit too — checked before anything is consumed
  const extras = (r.extraOutputs ?? []).map((e) => ({ ...e, def: ITEM_DEF_MAP.get(e.defId) }));
  const roomForExtras = extras.every((e) =>
    !!e.def && sys.bag.canAbsorb(sys.loot.createItem(e.defId, Math.min(e.def.stackMax, e.qty))));
  if (!sys.bag.canAbsorb(product) || !roomForExtras) {
    sys.ctx.bus.emit('craft:failed', { recipeId: r.id, reason: 'space' });
    sys.ctx.bus.emit('ui:notify', { text: '가방에 공간이 없습니다', kind: 'warning' });
    job.resolve(null);
    sys.ui?.refreshCraft();
    return;
  }
  // 무기 분해 (2026-09-08): socketed attachments are worth more than the plate — they come back before the gun goes
  if (job.targetUid && isDisassembleRecipe(r)) sys.detachAllSockets(job.targetUid);
  for (const i of sys.craftCost(r)) consumeFor(sys, i.defId, i.qty, job.targetUid);
  const made = sys.addUnits(r.outputDefId, r.outputQty);
  for (const e of extras) sys.addUnits(e.defId, e.qty);
  const first = made[0] ?? product;
  sys.ctx.bus.emit('inventory:itemAdded', { item: first, name: outDef.name, rarity: outDef.rarity });
  sys.ctx.bus.emit('craft:completed', { recipeId: r.id, item: first });
  sys.ctx.bus.emit('audio:play', { id: 'craft_done' });
  sys.afterChange();
  sys.ui?.refreshCraft();
  job.resolve(first);
  }
