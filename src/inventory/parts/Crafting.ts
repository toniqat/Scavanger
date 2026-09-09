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
  AUTO_CLOSE_DISTANCE, BLOCKER_TOKEN, CRAFT_HOLD_TIME, CRAFT_MIN_SPEED, DROP_EYE_LOWER, DROP_FORWARD_OFFSET, DROP_FORWARD_SPEED, DROP_UP_SPEED,
  LOADOUT_SLOTS, MOD_CTRL, MOD_SHIFT, SEARCH_EMIT_INTERVAL, SPRAY_REFILL_COST, TAKE_REQUEST_TIMEOUT, WEAPON_SLOT_IDS,
  isArmorDef, isAttachmentDef, isBagDef, isDisassembleRecipe, isWeaponDef, sameProfileDoc, slotAccepts,
  type ActiveBench, type BagSize, type BenchRecipeRow, type BenchRepairRow, type DropPreview, type DropTarget,
  type GridId, type ItemLocation, type OpResult, type PendingTake, type RaidInventoryState, type SlotId,
} from '../model';
import type { InventorySystem } from '../InventorySystem';

/** 산출물이 갈 데가 없을 때의 안내 — 함선에서는 창고까지 본 뒤라 두 곳을 다 말한다 (2026-09-09). */
const NO_ROOM_SHIP = '가방과 함선 창고에 공간이 없습니다';
const NO_ROOM_FIELD = '가방에 공간이 없습니다';

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

/**
 * Gear the active bench repairs: gun → weapons (slots + bag), gear → armor + bags, others none. Items without
 * durability are skipped. `wornOnly` (2026-09-08) also drops what is already at full durability — the 수리 팝업
 * lists **what there is to repair**, not the whole kit.
 */
export function benchRepairRows(sys: InventorySystem, wornOnly = false): BenchRepairRow[] {
  const b = sys.bench;
  if (!b || (b.kind !== 'gun' && b.kind !== 'gear')) return [];
  const wants = (def: ItemDef): boolean => b.kind === 'gun' ? isWeaponItemDef(def) : (def.category === 'armor' || def.category === 'bag');
  const rows: BenchRepairRow[] = [];
  const push = (item: ItemInstance, where: LoadoutSlot | null): void => {
    const def = ITEM_DEF_MAP.get(item.defId);
    if (!def || !wants(def)) return;
    const dur = sys.getDurability(item.uid);
    if (!dur || dur.max <= 0) return;
    if (wornOnly && dur.durability >= dur.max) return;
    const cost = (sys.loot.getEffectiveStats(item) ? sys.loot.getRepairCost(item) : []).map((c) => ({
      ...c, name: ITEM_DEF_MAP.get(c.defId)?.name ?? c.defId, have: sys.countDef(c.defId),
    }));
    rows.push({ uid: item.uid, item, def, where, dur, cost, short: cost.some((c) => c.have < c.qty) });
  };
  for (const slot of LOADOUT_SLOTS) { const it = sys.loadout[slot]; if (it) push(it, slot); }
  for (const p of sys.bag.items()) push(p.item, null);
  return rows;
  }

/** `모두 수리`: every worn row in order while the materials last. `skip` = uids the 팝업 crossed out with ×. */
export function benchRepairAll(sys: InventorySystem, skip?: ReadonlySet<string>): { done: number; skipped: number } {
  let done = 0, skipped = 0;
  for (const row of sys.benchRepairRows()) {
    if (row.dur.durability >= row.dur.max) continue;
    if (skip?.has(row.uid)) continue;
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

/** `count` (2026-09-09, 제작 수량): every ingredient × `count` must be owned. */
export function canCraft(sys: InventorySystem, recipeId: string, count = 1): boolean {
  const r = getRecipe(recipeId);
  if (!r) return false;
  const n = normCount(count);
  // 2026-09-08: 튜토리얼이 순서를 강제하는 동안에는 그 단계의 레시피만 (꺼져 있으면 언제나 null)
  if (sys.ctx.tutorial?.blockReason('craft', recipeId)) return false;
  return sys.craftCost(r).every((i) => sys.countDef(i.defId) >= i.qty * n);
  }

/** `count` as the job stores it: an integer ≥ 1 (NaN / 0 / negatives read as 1). */
function normCount(count: number | undefined): number {
  return Number.isFinite(count) ? Math.max(1, Math.floor(count as number)) : 1;
}

/**
 * 2026-09-09 (제작 수량) — the most runs of `recipeId` the owned materials pay for, **≥ 1** (the UI's `▶` limit:
 * when not even one run is affordable it still reads 1 and the hold button stays disabled through `canCraft`).
 * Materials only — bag space is checked when the hold ends, like a single run.
 */
export function maxCraftCount(sys: InventorySystem, recipeId: string): number {
  const r = getRecipe(recipeId);
  if (!r) return 1;
  let max = Infinity;
  for (const i of sys.craftCost(r)) max = Math.min(max, Math.floor(sys.countDef(i.defId) / Math.max(1, i.qty)));
  return Number.isFinite(max) ? Math.max(1, max) : 1;
  }

/**
 * 2026-09-08 — whether `recipeId`'s output (**and** its `extraOutputs`) has somewhere to land right now: 가방, and
 * 함선에서는 가방이 차면 **창고**까지 (see `roomForOutputs`). This is literally the test `updateCraft` runs when the
 * hold ends; the 분해 dialog runs it up front so a shred that can only fail is refused **before** the hold instead of
 * after it. Deliberately conservative in the same way: the input stack is still in the bag, so a 분해 that would free
 * its own cells can read as full. Unknown recipe / output def → false.
 *
 * 2026-09-09 — takes `count`, so 제작 패널 can ask about **the quantity its stepper is showing** rather than one run
 * (`CraftPanel.paint` → `is-nospace`). Omitted, it is the single run it always was.
 */
export function craftHasRoom(sys: InventorySystem, recipeId: string, count = 1): boolean {
  const r = getRecipe(recipeId);
  return !!r && roomForOutputs(sys, r, normCount(count));
  }

/**
 * A scratch occupancy map of one grid — the dry-run twin of `Grid.autoPlace`, so a `true` here means the real
 * placement succeeds and nothing is consumed when it would not.
 */
interface DryGrid {
  cols: number;
  rows: number;
  occ: Uint8Array;
  /** Merge capacity left per def, read from the real grid the first time it is asked for and then spent down. */
  merge: Map<string, number>;
  grid: Grid;
}

function dryGrid(grid: Grid): DryGrid {
  const cols = grid.cols, rows = grid.rows;
  const occ = new Uint8Array(cols * rows);
  for (const p of grid.items()) {
    const fp = grid.footprintOf(p.item);
    for (let yy = p.y; yy < p.y + fp.h; yy++) for (let xx = p.x; xx < p.x + fp.w; xx++) occ[yy * cols + xx] = 1;
  }
  return { cols, rows, occ, merge: new Map(), grid };
}

/** Units of `def` this grid still absorbs into stacks it already holds; the budget is spent once per def. */
function dryMerge(g: DryGrid, def: ItemDef, want: number): number {
  if (def.stackMax <= 1 || want <= 0) return 0;
  const cap = g.merge.get(def.id) ?? g.grid.mergeCapacity(def.id);
  const used = Math.min(cap, want);
  g.merge.set(def.id, cap - used);
  return used;
}

/**
 * One chunk into this grid's first free rectangle — rows top-down / left-right, both orientations of a non-square
 * footprint, marking as it goes so earlier chunks block later ones. That is `Grid.findFreeSlot`'s own scan order.
 */
function dryPlace(g: DryGrid, def: ItemDef): boolean {
  const shapes = def.width !== def.height ? [[def.width, def.height], [def.height, def.width]] : [[def.width, def.height]];
  for (const [w, h] of shapes) {
    for (let y = 0; y + h <= g.rows; y++) {
      for (let x = 0; x + w <= g.cols; x++) {
        let free = true;
        for (let yy = y; yy < y + h && free; yy++) {
          for (let xx = x; xx < x + w; xx++) if (g.occ[yy * g.cols + xx]) { free = false; break; }
        }
        if (!free) continue;
        for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) g.occ[yy * g.cols + xx] = 1;
        return true;
      }
    }
  }
  return false;
}

/**
 * 2026-09-09 (제작 수량) — is there room for **everything** `count` runs of `recipe` produce (output +
 * `extraOutputs`)?
 *
 * **2026-09-09 (사용자 결정): 가방 → 안 되면 함선 창고.** 함선 작업대에서 만든 것은 가방이 먼저 받고, 자리가
 * 없으면 창고가 받는다 — `updateCraft` 가 `addUnits` 의 넘침을 `tryAddToStash` 로 넘기는 것이 그 짝이다. 넘치는
 * 물건을 함선에서만 창고로 보내는 규칙 자체는 `InventorySystem.throwToWorld` 가 이미 쓰던 것이고, 여기서는 그것을
 * "누르기 전에" 보는 검사로 옮겼을 뿐이다. 레이드 중에는 창고가 없으므로 예전처럼 가방만 본다.
 *
 * (재료 쪽은 그대로 **가방만** 본다 — `canCraft` → `countDef` → `countWhere`. 가방 + 창고를 함께 쓰는 것은
 * 가구 제작 · 시설 업그레이드(`housing/`, `countDefAll`) 쪽이고, 아이템 레시피는 예전부터 가방이었다.)
 *
 * 한 덩어리(`stackMax` 이하)가 지나가는 길은 `addUnits` 와 글자 그대로 같다: 가방 스택에 합치기 → 가방 빈칸 →
 * (넘쳤으면) 창고 스택에 합치기 → 창고 빈칸.
 */
function roomForOutputs(sys: InventorySystem, recipe: CraftRecipe, count: number): boolean {
  const bag = dryGrid(sys.bag);
  const stash = sys.ctx.isHubPhase() ? dryGrid(sys.getStash()) : null;
  const outputs = [{ defId: recipe.outputDefId, qty: recipe.outputQty }, ...(recipe.extraOutputs ?? [])];
  for (const o of outputs) {
    const def = ITEM_DEF_MAP.get(o.defId);
    if (!def) return false;
    let left = Math.max(0, Math.floor(o.qty * count));
    while (left > 0) {
      let chunk = Math.min(def.stackMax, left);
      left -= chunk;
      chunk -= dryMerge(bag, def, chunk);
      if (chunk <= 0) continue;
      if (dryPlace(bag, def)) continue;
      if (!stash) return false;
      chunk -= dryMerge(stash, def, chunk);
      if (chunk <= 0) continue;
      if (!dryPlace(stash, def)) return false;
    }
  }
  return true;
}

/**
 * Seconds the 제작 / 분해 button must be held — **always `CRAFT_HOLD_TIME`** (2026-09-08).
 *
 * It used to be `recipe.duration` (2–12 s) scaled by 제작 skill and 재주, which read as a crafting *time* and made
 * the tutorial's 돌격소총 a 6-second press. The hold is a **safety grace before the materials are consumed**, not a
 * simulation of work, so every recipe now takes the same short press. `CraftRecipe.duration` stays in the data (it
 * still describes how involved a recipe is) but nothing reads it for timing any more.
 */
export function craftDuration(sys: InventorySystem, recipeId: string): number {
  return getRecipe(recipeId) ? CRAFT_HOLD_TIME : 0;
  }

/**
 * `targetUid` (2026-09-08): the exact stack the 분해 dialog was opened on — consumed first so clicking a specific
 * weapon shreds *that* one. Ordinary crafts pass nothing and keep the old `consumeDef` behaviour.
 */
export function craft(sys: InventorySystem, recipeId: string, targetUid?: string, count = 1): Promise<ItemInstance | null> {
  const r = getRecipe(recipeId);
  if (!r) return Promise.resolve(null);
  const n = normCount(count);
  sys.cancelCraft();
  if (sys.availableRecipes().indexOf(r) < 0 || !sys.canCraft(recipeId, n)) {
    sys.ctx.bus.emit('craft:failed', { recipeId, reason: 'missing' });
    return Promise.resolve(null);
  }
  const duration = sys.craftDuration(recipeId);
  // 2026-09-09: `count` (제작 수량) rides along — the hold is still one `CRAFT_HOLD_TIME`, however many runs it buys
  sys.ctx.bus.emit('craft:started', { recipeId, duration, count: n });
  return new Promise<ItemInstance | null>((resolve) => {
    sys.craftJob = { recipe: r, remaining: duration, duration, resolve, targetUid, count: n };
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
  const count = normCount(job.count);
  const outDef = ITEM_DEF_MAP.get(r.outputDefId);
  if (!sys.canCraft(r.id, count) || !outDef) {
    sys.ctx.bus.emit('craft:failed', { recipeId: r.id, reason: 'missing' });
    job.resolve(null);
    sys.ui?.refreshCraft();
    return;
  }
  // 2026-09-08: `extraOutputs` (기계 부품 분해) must fit too — checked before anything is consumed.
  // 2026-09-09: the check covers the **whole batch** (output × count + extras × count, `roomForOutputs`) — a 3-run
  //   준중량탄 hold that has room for one stack of 90 but not for 270 fails here, before a single 화약 is spent.
  if (!roomForOutputs(sys, r, count)) {
    sys.ctx.bus.emit('craft:failed', { recipeId: r.id, reason: 'space' });
    sys.ctx.bus.emit('ui:notify', { text: sys.ctx.isHubPhase() ? NO_ROOM_SHIP : NO_ROOM_FIELD, kind: 'warning' });
    job.resolve(null);
    sys.ui?.refreshCraft();
    return;
  }
  // 무기 분해 (2026-09-08): socketed attachments are worth more than the plate — they come back before the gun goes
  if (job.targetUid && isDisassembleRecipe(r)) sys.detachAllSockets(job.targetUid);
  for (const i of sys.craftCost(r)) consumeFor(sys, i.defId, i.qty * count, job.targetUid);
  // `addUnits` merges into existing stacks first and then chunks the rest by `stackMax`, so 270 rounds become
  // however many ≤ 50-round stacks the bag needs; its return value is the *overflow* (empty when everything landed)
  // 2026-09-09 (가방 → 안 되면 창고): `addUnits` 가 가방에 못 넣고 돌려준 덩어리는 함선 창고가 받는다.
  // `roomForOutputs` 가 방금 같은 순서로 자리를 확인했으므로 여기서 다시 떨어질 일은 없지만, 그래도 사라지게
  // 두지는 않는다 — 넘어간 것이 있으면 어디로 갔는지 한 줄 알려 준다.
  const spill = sys.addUnits(r.outputDefId, r.outputQty * count);
  for (const e of r.extraOutputs ?? []) spill.push(...sys.addUnits(e.defId, e.qty * count));
  for (const item of spill) {
    const name = ITEM_DEF_MAP.get(item.defId)?.name ?? item.defId;
    // 창고는 함선에서만 — 레이드 중에 `tryAddToStash` 는 손댈 수 없는 함선 격자를 건드린다. 밖에서는 예전처럼 떨군다.
    if (sys.ctx.isHubPhase() && sys.tryAddToStash(item)) sys.ctx.bus.emit('ui:notify', { text: `${name} → 함선 창고`, kind: 'info', duration: 2 });
    else sys.throwToWorld(item, false);
  }
  const first = sys.bag.items().find((p) => p.item.defId === r.outputDefId)?.item
    ?? sys.loot.createItem(r.outputDefId, Math.min(outDef.stackMax, r.outputQty));
  sys.ctx.bus.emit('inventory:itemAdded', { item: first, name: outDef.name, rarity: outDef.rarity });
  sys.ctx.bus.emit('craft:completed', { recipeId: r.id, item: first, count });
  sys.ctx.bus.emit('audio:play', { id: 'craft_done' });
  sys.afterChange();
  sys.ui?.refreshCraft();
  job.resolve(first);
  }
