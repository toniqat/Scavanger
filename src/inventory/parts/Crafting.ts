/**
 * src/inventory/parts/Crafting.ts — **craft · salvage · the workbench**.
 *
 * Field crafting (the `제작` column) and the ship workbench (`openBenchCraft`) run the same rules and differ only in
 * where the materials come from: in a raid the bag only, in the ship bag + ship stash (`countDefAll` / `consumeDefAll`).
 * Salvage (`break_*`) opens from the item context menu, not the craft list, and streams `inventory:disassembleProgress`.
 *
 * **2026-09-10 (craft rework, 2nd stage) — salvage yield rides the remaining durability.** The quantities of the
 * `break_*` recipes carried in `getAllRecipes()` are **on bucket 4 (81~100 %)**. Used as they are, a gun with 5 % left
 * spits out as much as a new one — armor I really was returning `폐금속 4 + 천조각 2` at any durability (bucket 0's
 * answer is `폐금속 1`). So **the recipe is resolved again the moment a salvage target is named** (`resolveRecipe` →
 * `ctx.loot.getSalvageFor(inst)`): the preview (`disassembleRecipeFor`), the room check (`craftHasRoom`) and the real
 * yield (`updateCraft`) all read the same recipe. The id is unchanged, so not one line of `craft(recipeId, uid)`'s
 * gates (`availableRecipes` identity · `canCraft`) moves.
 */
import * as THREE from 'three';
import type {
  ContainerMessage, ContainerRequest, CraftIngredient, CraftRecipe, CraftStation, DurabilityInfo, GameContext, ItemCategory, ItemDef,
  ItemInstance, Loadout, LoadoutSlot, PeerId as NetPeerId, ProfileRecord, SocketSlot, WeaponSlot, WeightInfo, LoadoutPreset, WorkbenchKind, EmbeddedView,
} from '@/shared';
import { BAG_DEFAULT_COLS, BAG_DEFAULT_QUICK_SLOTS, BAG_DEFAULT_ROWS, Keys, QUICK_SLOTS, SEARCH_MAX_DISTANCE, SOCKET_SLOTS, isQuickSlotActive } from '@/shared';
/* 2026-09-16 (user's decision): the craft skill only decides the material refund — roll in shared, eligibility in items (beside salvage · the economy check) */
import { rollCraftRefund } from '@/shared';
import {
  AMMO_LABEL_KO, ITEM_DEF_MAP, STARTER_LOADOUT, STARTER_STASH, ammoItemIdFor, getRecipe, isCraftRefundable, isWeaponItemDef, itemWeight, needsRepairCost,
} from '@/items';
import { durabilityInfo, gearMultipliers, makeWeightInfo, searchTimeFor, sumWeight } from '../Gear';
/* 2026-09-10: repair materials are decided in exactly one place (`getRepairCost` → with none, the `회복 스프레이`). */
import { repairMaterials } from './Durability';
import { Grid, OOB, stackKeyOf, type Placement, type PriorityPlacement, type StackItem } from '../Grid';
import { getMealDef, normalizeMealQuality } from '@/shared';
/* 2026-09-13 (library series · the research skill): research XP · the material refund of a lab-bench craft */
import { RESEARCH_XP_CRAFT } from '@/shared';
import { Container, ContainerStore } from '../Container';
import { attachedItems, clearSocket, findSocketed, setSocket } from '../Sockets';
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

/** 2026-09-13 (cooking minigames): the cook bench kind and its Korean reasons (`cookBlock` · `completeCook` · `openBenchCraft`). */
const COOK_BENCH: WorkbenchKind = 'cook';
const COOK_USE_STATION = '조리대에서 요리하세요';
/*
 * 2026-09-16 (user's decision, 2nd pass): the skill reason (`skill`) is **back**. It was deleted that morning under
 * 「the skill is not involved in crafting at all」, but as `skillRequired` and its contract field are kept, **a reader
 * has to stay too** or raising the csv number later turns nothing on. Every value is 0 today, so this branch is never
 * taken — a machine the data has switched off.
 */
const COOK_REASON = {
  notCook: '조리대 레시피가 아닙니다',
  shipOnly: '조리대는 함선에서만 사용할 수 있습니다',
  level: (n: number): string => `조리대 Lv.${n} 이 필요합니다`,
  skill: (label: string, n: number): string => `${label} 숙련 ${n} 이 필요합니다`,
  missing: '재료가 부족합니다',
  noRoom: '넣을 자리가 없습니다',
} as const;
/** Skill name (every cook bench recipe is `crafting` — a skill not in the table keeps its id). */
const SKILL_WORD: Partial<Record<CraftRecipe['skill'], string>> = { crafting: '제작' };

/** The notice when the product has nowhere to go — in the ship the stash was looked at too, so both are named (2026-09-09). */
const NO_ROOM_SHIP = '가방과 함선 창고에 공간이 없습니다';
const NO_ROOM_FIELD = '가방에 공간이 없습니다';

/** 'ship' while walking the hub / menus, 'field' on a mission. */
export function currentStation(sys: InventorySystem): CraftStation {
  return sys.ctx.isRaidActive() ? 'field' : 'ship';
  }

/**
 * **2026-09-14 (user's decision) — in the ship, craft materials come out of the ship stash too.**
 *
 * The rule at the head of this file from the start (「in a raid the bag only, in the ship bag + ship stash」) **was
 * missing from item crafting alone**: `canCraft` · `maxCraftCount` · consumption and the UI chips all read `countDef`
 * (= bag + pouch + quick slots), so a bench said 「not enough materials」 while harvests and salvage products sat in the
 * stash. Furniture crafting (`housing`) and cooking (`completeCook`) were already `countDefAll` / `consumeDefAll`.
 *
 * The gate is **the one 「is this the ship」 test that repair uses** (`currentStation` — the `isRaidActive` that
 * `benchRepairRows` reads). Quick craft in the field (`station: 'field'`) cannot touch the stash, so it counts the bag only.
 *
 * Counting and consuming that disagree fail only at the end of the hold — so **counting is only here**, and consuming only in `consumeFor`.
 */
export function craftCountDef(sys: InventorySystem, defId: string): number {
  return sys.currentStation() === 'ship' ? sys.countDefAll(defId) : sys.countDef(defId);
  }

/**
 * **The Tab window a bench opened itself** (2026-09-16, user's report 「pressing 닫기 on the bench window opens the bag」).
 *
 * `openBenchCraft` opens the Tab window **along with** the craft column, as the place to draw it. But `닫기` was
 * `closeBench` alone, and that only folds the craft column, so E → `닫기` at a bench revealed the bag window lying
 * underneath (= the one this function had just opened) — which is why closing looked like opening the bag. So
 * 「did a bench open this window」 is recorded here, and only `닫기` (`closeCraftWindow`) closes the whole window.
 *
 * ⚠ `closeBench` itself does **not** close the window, exactly as the contract says — `InventorySystem.closeAll`
 * passes through that function, and closing the window there runs the close path twice (`inventory:closed` twice).
 */
const BENCH_WINDOW = new WeakSet<InventorySystem>();

/**
 * Open the craft panel in bench mode (ship only): recipes of `getRecipes('ship', bench, level)` + locked rows for
 * the bench's higher-level recipes, workshop cost discount, and the repair list of the gear that bench services.
 */
export function openBenchCraft(sys: InventorySystem, bench: WorkbenchKind, level: number): void {
  const ctx = sys.ctx;
  // 2026-09-13 (cooking minigames): the cook bench opens no craft window — a back door to meals with no quality (its screen is housing's)
  if (bench === COOK_BENCH) {
    ctx.bus.emit('ui:notify', { text: COOK_USE_STATION, kind: 'warning', duration: 2 });
    return;
  }
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
    BENCH_WINDOW.add(sys);           // this window belongs to the bench — 닫기 closes it whole
  } else {
    BENCH_WINDOW.delete(sys);        // a window already open via Tab — 닫기 only folds the craft column
  }
  sys.ui?.setCraftOpen(true);
  ctx.bus.emit('ui:craftToggled', { open: true });
  }

/** Bench the craft panel is showing (null = plain 제작 panel). */
export function getBench(sys: InventorySystem): ActiveBench | null { return sys.bench; }

/**
 * **2026-09-12 (user's decision) — the bench is swapped inside the craft window.** The only caller is the vertical
 * bench list down the left edge of the craft column (`ui/CraftPanel`).
 *
 * Unlike `openBenchCraft` it does **not open** the window, and unlike `closeBench` it does **not close** it — all it
 * does is swap the list inside a craft column that is already open. `null` = quick craft (the list with no bench). A
 * running hold is cancelled: the whole list changes, so the row being pressed can disappear.
 */
export function switchBench(sys: InventorySystem, bench: WorkbenchKind | null, level = 0): void {
  if (bench && !sys.ctx.isHubPhase()) return;   // benches are ship-only (the same rule as openBenchCraft)
  if (bench === COOK_BENCH) return;              // 2026-09-13: the cook bench is not one of the craft window's benches (same rule as openBenchCraft)
  sys.cancelCraft();
  sys.bench = bench ? { kind: bench, level: Math.max(0, Math.floor(level)) } : null;
  }

/** Leave bench mode (panel 닫기 / window closed). The window itself stays open. */
export function closeBench(sys: InventorySystem): void {
  BENCH_WINDOW.delete(sys);   // leaving the bench gives up ownership of that window too (`closeAll` passes here as well)
  if (!sys.bench) return;
  sys.bench = null;
  sys.cancelCraft();
  sys.ui?.setCraftOpen(false);
  sys.ctx.bus.emit('ui:craftToggled', { open: false });
  }

/**
 * The craft window's `닫기` (2026-09-16). **A window a bench opened closes whole** (`BENCH_WINDOW`); a bench picked
 * inside a Tab-opened window only folds the craft column. `false` = there was no bench to close (the bag's `제작` column — the caller folds its own).
 */
export function closeCraftWindow(sys: InventorySystem): boolean {
  // `closeAll` calls `closeBench` inside it, so the mark is cleared along with it (no recursion)
  if (BENCH_WINDOW.has(sys)) { sys.closeAll(); return true; }
  if (sys.bench) { sys.closeBench(); return true; }
  return false;
  }

/**
 * Rows for the craft panel: the recipes this bench can craft now, then the rest of the bench's recipes as locked.
 *
 * **2026-09-16 (user's report 「raising the bench level does not add craftable recipes」) — every recipe of this bench shows.**
 * Locked rows used to be only those with `station === 'ship'` **whose skill was already met**. But the higher rows of
 * `data/recipes.csv` raise level and skill together (all 15 gun Lv.2 rows need craft skill 15 or more). So for anyone
 * with a low craft skill, raising the bench to Lv.2 changed **not one row** on screen, and that it was the skill and
 * not the level doing the blocking was not even visible. The cook bench screen made the same choice for the same
 * reason on 2026-09-15 (B-15, user's decision 「all dimmed + a skill badge」) — the list has to say what to raise.
 *
 * A locked row is **drawing only**: `craft()` refuses any recipe outside `availableRecipes()` (= `getRecipes`, which still
 * filters level · skill), and the detail panel's hold button is disabled while `locked`. The locked reason (level / skill) is `ui/CraftPanel.lockedReason`.
 */
export function getBenchRecipes(sys: InventorySystem): BenchRecipeRow[] {
  const b = sys.bench;
  if (!b) return sys.getRecipes(sys.currentStation()).filter((r) => !isDisassembleRecipe(r)).map((recipe) => ({ recipe, locked: false }));
  const open = sys.getRecipes('ship', b.kind, b.level).filter((r) => !isDisassembleRecipe(r));
  const openIds = new Set(open.map((r) => r.id));
  const locked = sys.loot.getAllRecipes().filter((r) => r.bench === b.kind && !isDisassembleRecipe(r) && !openIds.has(r.id));
  return [...open.map((recipe) => ({ recipe, locked: false })), ...locked.map((recipe) => ({ recipe, locked: true }))];
  }

/**
 * The gear that can be repaired (equipment slots + bag grid). Anything without durability is skipped, and `wornOnly`
 * (2026-09-08) drops what is already full — the repair popup lists **what needs fixing**, not all the gear there is.
 *
 * **2026-09-12 (user's decision) — in the ship, bringing the materials is all a repair takes.** Retiring the repair
 * bench (`furn_repair_bench`) stopped "which bench" being a condition of repair: the list used to appear only while
 * `sys.bench` was the gun or the gear bench (an empty array otherwise), so **`모두 수리` did not exist unless a bench
 * was open**. In the ship it now looks at every weapon · armor · bag. **Still impossible in a raid** — `repair()`'s gate.
 */
export function benchRepairRows(sys: InventorySystem, wornOnly = false): BenchRepairRow[] {
  if (sys.ctx.isRaidActive()) return [];
  const wants = (def: ItemDef): boolean => isWeaponItemDef(def) || def.category === 'armor' || def.category === 'bag';
  const rows: BenchRepairRow[] = [];
  /** Stacks already listed (so one item never arrives twice from two sources — equipment slot · bag · quick slot · pouch). */
  const seen = new Set<string>();
  const push = (item: ItemInstance, where: LoadoutSlot | null): void => {
    if (seen.has(item.uid)) return;
    const def = ITEM_DEF_MAP.get(item.defId);
    if (!def || !wants(def)) return;
    seen.add(item.uid);
    const dur = sys.getDurability(item.uid);
    if (!dur || dur.max <= 0) return;
    if (wornOnly && dur.durability >= dur.max) return;
    const mats = repairMaterials(sys, item, def);
    // 2026-09-11 (C-36): a **worn** crafted item with no repair cost is a hole in the table — `repair` refuses it, so do
    // not list it. A full one has no cost by definition and stays in the (non-`wornOnly`) list as before.
    if (dur.durability < dur.max && !mats.length && needsRepairCost(def)) return;
    const cost = mats.map((c) => ({
      ...c, name: ITEM_DEF_MAP.get(c.defId)?.name ?? c.defId, have: sys.countDef(c.defId),
    }));
    rows.push({ uid: item.uid, item, def, where, dur, bucket: sys.loot.durabilityBucketInfo(item), cost, short: cost.some((c) => c.have < c.qty) });
  };
  for (const slot of LOADOUT_SLOTS) { const it = sys.loadout[slot]; if (it) push(it, slot); }
  for (const p of sys.bag.items()) push(p.item, null);
  /*
   * 2026-09-14 (user's decision): repair covers **everything carried on the body** — equipment slots + bag grid +
   * **quick slots + pouch**. That is the same set `countWhere` looks at when counting materials, and since 「a quick
   * slot is not the bag grid」 (2026-09-09) · 「a pouch is not the bag grid」 (2026-09-11 A-15) this list alone had
   * been missing those two. **The ship stash is excluded** — repair services the gear that goes out on the raid.
   */
  for (const it of sys.pouchItems()) push(it, null);
  for (const it of sys.quickItems()) push(it, null);
  return rows;
  }

/** `모두 수리`: every worn row in order while the materials last. `skip` = uids the popup crossed out with ×. */
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
 * Recipes a station may craft. Field: `station: 'field'` recipes only. Ship: field recipes too; a recipe with
 * `bench` needs that bench — at `bench` (given) with `benchLevel ≤ level`, otherwise a placed bench of that kind
 * at that level (`ctx.housing.getBenchLevel`, 0 without housing).
 *
 * **2026-09-16 (user's decision) — the skill does not block crafting.** The first line used to filter on
 * `skillOf(r.skill) < r.skillRequired`. What can be made is now decided by **the bench and its level** alone, and the
 * skill's one job is the material refund (`shared/craftRefund.ts`). The `CraftRecipe.skillRequired` column is still in
 * `data/recipes.csv` but every value is 0 and nobody reads it — the contract and loader are left alone so it can be raised later.
 */
export function getRecipes(sys: InventorySystem, station: CraftStation, bench?: WorkbenchKind, level = 0): readonly CraftRecipe[] {
  const housing = sys.ctx.housing;
  const placedLevel = (kind: WorkbenchKind): number => {
    if (!housing) return 0;
    return typeof housing.getBenchLevel === 'function' ? Math.max(0, housing.getBenchLevel(kind) || 0) : 0;
  };
  const skillOf = (id: CraftRecipe['skill']): number => sys.ctx.progression?.getSkill(id) ?? 0;
  return sys.loot.getAllRecipes().filter((r) => {
    /* 2026-09-16 (user's decision, 2nd pass): **a recipe whose skill is short cannot be made.** This revives the line
       deleted that morning under 「the skill is not involved in crafting at all」 — the `skillRequired` column is kept, and
       with no reader, raising the csv number later would do nothing. Every value is 0 today, so this line filters nothing.
       A filtered recipe does not vanish — it shows as a **locked row** (`getBenchRecipes` locks everything outside
       `getRecipes`) and `ui/CraftPanel.lockedReason` says why. The skill's standing role is the material refund (`refundAfterCraft`). */
    if (skillOf(r.skill) < r.skillRequired) return false;
    /* 2026-09-13 (cooking minigames): cook bench recipes never show in the ordinary craft lists (the bag's `제작` · quick
       craft · another bench). They come back **only when the cook bench is asked for by name** (`getRecipes('ship', 'cook', lv)`
       — the meal list of housing's cook bench screen). The one way to make them is `completeCook` — `canCraft` · `craft` refuse them. */
    if (r.bench === COOK_BENCH && bench !== COOK_BENCH) return false;
    if (station === 'field') return r.station === 'field';
    const need = r.benchLevel ?? 1;
    /* 2026-09-10 (user's decision) — **opening a bench shows that bench's recipes only.** It used to carry every
       recipe with no `bench`, so bandages · ammo turned up at the refining bench Lv.3 too. Once the recipes grew to
       94 rows that list became unreadable. Field recipes now name their own bench in `data/recipes.csv` (ammo → guns …),
       so a flow like "ammo right after the rifle in one bench window" still lives — the tutorial leans on it. */
    if (bench !== undefined) return r.bench === bench && need <= level;
    /* The craft list on the bag screen: field recipes always, bench or not (so the `bench` tag is not read), while a
       ship-only recipe needs that bench actually placed and at level. */
    if (r.station === 'field') return true;
    if (r.bench === undefined) return true;
    return placedLevel(r.bench) >= need;
  });
  }

/**
 * Phase 8 — the salvage recipe of an item the player owns, or null. The UI turns it into the `분해` context-menu entry
 * and the modeless dialog. Crafting itself is unchanged (`craft()` still accepts these recipes) — they are only
 * hidden from the craft *list*.
 *
 * **2026-09-10 — this is a preview, and a preview has to equal the real thing.** It used to walk `getAllRecipes()` and
 * hand back the static `break_*` row as it stood. That row's quantities are on bucket 4 (81~100 %), so an armor I with
 * 5 % left also read `폐금속 4 + 천조각 2` (the real answer is `폐금속 1`). Now `ctx.loot.getSalvageFor(inst)` gives
 * a recipe resolved again against that instance's remaining durability — the `id` is the same, so `craft(id, uid)` still works.
 */
export function disassembleRecipeFor(sys: InventorySystem, uid: string): CraftRecipe | null {
  const item = sys.findItem(uid);
  return item ? sys.loot.getSalvageFor(item) : null;
  }

/**
 * Resolves a `break_*` whose salvage target is named again against **that instance's remaining durability** (2026-09-10).
 * The preview · the room check · the real yield all pass through here. Not a salvage, or no target → the recipe as given.
 */
function resolveRecipe(sys: InventorySystem, r: CraftRecipe | undefined, targetUid?: string): CraftRecipe | null {
  if (!r) return null;
  if (!targetUid || !isDisassembleRecipe(r)) return r;
  const item = sys.findItem(targetUid);
  if (!item || item.defId !== r.inputs[0]?.defId) return r;
  return sys.loot.getSalvageFor(item) ?? r;
}

/**
 * Open the modeless salvage dialog over the open window (the item context menu's `분해` entry; also a handle for
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

/** `count` (2026-09-09, craft quantity): every ingredient × `count` must be owned. */
export function canCraft(sys: InventorySystem, recipeId: string, count = 1): boolean {
  const r = getRecipe(recipeId);
  if (!r) return false;
  if (r.bench === COOK_BENCH) return false;   // 2026-09-13: cook bench recipes go only through `completeCook` (no back door without quality)
  const n = normCount(count);
  // 2026-09-08: while the tutorial forces an order, only that step's recipe (always null when it is off)
  if (sys.ctx.tutorial?.blockReason('craft', recipeId)) return false;
  // 2026-09-14: in the ship bag + ship stash (`craftCountDef`) — quick craft in the field is still the bag alone
  return sys.craftCost(r).every((i) => sys.craftCountDef(i.defId) >= i.qty * n);
  }

/** `count` as the job stores it: an integer ≥ 1 (NaN / 0 / negatives read as 1). */
function normCount(count: number | undefined): number {
  return Number.isFinite(count) ? Math.max(1, Math.floor(count as number)) : 1;
}

/**
 * 2026-09-09 (craft quantity) — the most runs of `recipeId` the owned materials pay for, **≥ 1** (the UI's `▶` limit:
 * when not even one run is affordable it still reads 1 and the hold button stays disabled through `canCraft`).
 * Materials only — bag space is checked when the hold ends, like a single run.
 */
export function maxCraftCount(sys: InventorySystem, recipeId: string): number {
  const r = getRecipe(recipeId);
  if (!r) return 1;
  let max = Infinity;
  // 2026-09-14: counts **the same range** as `canCraft` (ship = bag + ship stash) — out of step, ▶ climbs and the hold fails
  for (const i of sys.craftCost(r)) max = Math.min(max, Math.floor(sys.craftCountDef(i.defId) / Math.max(1, i.qty)));
  return Number.isFinite(max) ? Math.max(1, max) : 1;
  }

/**
 * 2026-09-08 — whether `recipeId`'s output (**and** its `extraOutputs`) has somewhere to land right now: the bag, and
 * in the ship the **stash** once the bag is full (see `roomForOutputs`). This is literally the test `updateCraft` runs
 * when the hold ends; the salvage dialog runs it up front so a shred that can only fail is refused **before** the hold
 * instead of after it. Deliberately conservative in the same way: the input stack is still in the bag, so a salvage
 * that would free its own cells can read as full. Unknown recipe / output def → false.
 *
 * 2026-09-09 — takes `count`, so the craft panel can ask about **the quantity its stepper is showing** rather than one
 * run (`CraftPanel.paint` → `is-nospace`). Omitted, it is the single run it always was.
 *
 * 2026-09-10 — takes `targetUid`, so the salvage popup asks about **what this exact item will actually produce**.
 * Measured on the static row it would reserve bucket-4 output space, so the room maths goes wrong on a wrecked gun.
 */
export function craftHasRoom(sys: InventorySystem, recipeId: string, count = 1, targetUid?: string): boolean {
  const r = resolveRecipe(sys, getRecipe(recipeId), targetUid);
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
 * 2026-09-09 (craft quantity) — is there room for **everything** `count` runs of `recipe` produce (output +
 * `extraOutputs`)?
 *
 * **2026-09-15 2nd pass (user's decision): the ship stash → the bag when it does not fit.** This reversed 2026-09-09's
 * 「bag → the stash when it does not fit」 — things made in the ship filled the bag, so it had to be emptied before every
 * launch. Quick craft in the field has no stash, so it reads **the bag alone** as before and a full bag blocks the craft
 * itself. The real delivery runs the same order (`addCraftOutputs`).
 *
 * (Materials have been **the same range as the outputs since 2026-09-14** — in the ship bag + ship stash (`craftCountDef` ·
 * `consumeFor`), quick craft in the field the bag only. Before that materials were bag-only, so a bench said 「not enough
 * materials」 with them piled in the stash. Furniture crafting · facility upgrades (`housing/`) and cooking were `countDefAll` from the start.)
 *
 * The path one chunk (`stackMax` or less) takes is literally the same as `addCraftOutputs`: (in the ship) merge into stash
 * stacks → a free stash cell → merge into bag stacks → a free bag cell.
 */
function roomForOutputs(sys: InventorySystem, recipe: CraftRecipe, count: number): boolean {
  const bag = dryGrid(sys.bag);
  const stash = sys.ctx.isHubPhase() ? dryGrid(sys.getStash()) : null;
  // 2026-09-15 2nd pass (user's decision): in the ship the stash takes it first — a raid has no stash, so the bag alone
  const order = stash ? [stash, bag] : [bag];
  const outputs = [{ defId: recipe.outputDefId, qty: recipe.outputQty }, ...(recipe.extraOutputs ?? [])];
  for (const o of outputs) {
    const def = ITEM_DEF_MAP.get(o.defId);
    if (!def) return false;
    let left = Math.max(0, Math.floor(o.qty * count));
    while (left > 0) {
      let chunk = Math.min(def.stackMax, left);
      left -= chunk;
      let landed = false;
      for (const g of order) {
        chunk -= dryMerge(g, def, chunk);
        if (chunk <= 0) { landed = true; break; }
        if (dryPlace(g, def)) { landed = true; break; }
      }
      if (!landed) return false;
    }
  }
  return true;
}

/**
 * **Delivering the craft product** (2026-09-15 2nd pass, user's decision) — in the ship **the ship stash first, the bag
 * once the stash is full**, in the field **the bag only**. What comes back is the chunks that landed nowhere (the caller
 * drops them); the room check (`roomForOutputs`) just walked the same order, so on a normal path it is always empty.
 *
 * The raid path is `InventorySystem.addUnits` unchanged — filling a quick slot's partial stack first (2026-09-09) is
 * the whole reason ammo gets crafted in the field, so that path was left alone.
 */
function addCraftOutputs(sys: InventorySystem, defId: string, qty: number): ItemInstance[] {
  const def = ITEM_DEF_MAP.get(defId);
  if (!def) return [];
  if (!sys.ctx.isHubPhase()) return sys.addUnits(defId, qty);
  const stash = sys.getStash();
  const spilled: ItemInstance[] = [];
  let left = Math.max(0, Math.floor(qty));
  while (left > 0) {
    const chunk = Math.min(def.stackMax, left);
    left -= chunk;
    const item = sys.loot.createItem(defId, chunk);
    if (stash.mergeIntoStacks(item) <= 0) continue;
    if (stash.autoPlace(item)) continue;
    spilled.push(item);
  }
  // only what the stash could not take goes to the bag (and what the bag cannot take goes back to the caller)
  const overflow: ItemInstance[] = [];
  for (const item of spilled) {
    if (sys.bag.mergeIntoStacks(item) <= 0) continue;
    if (sys.bag.autoPlace(item)) continue;
    overflow.push(item);
  }
  return overflow;
}

/**
 * Seconds the 제작 / 분해 button must be held — **always `CRAFT_HOLD_TIME`** (2026-09-08).
 *
 * It used to be `recipe.duration` (2–12 s) scaled by the craft skill and dexterity, which read as a crafting *time*
 * and made the tutorial's 돌격소총 a 6-second press. The hold is a **safety grace before the materials are consumed**,
 * not a simulation of work, so every recipe now takes the same short press. `CraftRecipe.duration` stays in the data
 * (it still describes how involved a recipe is) but nothing reads it for timing any more.
 */
export function craftDuration(sys: InventorySystem, recipeId: string): number {
  return getRecipe(recipeId) ? CRAFT_HOLD_TIME : 0;
  }

/**
 * `targetUid` (2026-09-08): the exact stack the salvage dialog was opened on — consumed first so clicking a specific
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
  // 2026-09-09: `count` (craft quantity) rides along — the hold is still one `CRAFT_HOLD_TIME`, however many runs it buys
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
 * Consume `qty` of `defId`, taking the salvage target stack first when it matches (2026-09-08). Returns false when the
 * bag could not cover the rest — the caller has already checked `canCraft`, so this is a safety net only.
 *
 * **2026-09-14 (user's decision)**: in the ship the remainder comes out of **the bag first → the ship stash**
 * (`consumeDefAll`) — it has to be the range `craftCountDef` counts, and the order is the very helper cooking
 * (`completeCook`) was already using. Quick craft in the field is `consumeDef` (bag · pouch · quick slots) as before.
 */
function consumeFor(sys: InventorySystem, defId: string, qty: number, targetUid?: string): boolean {
  let left = Math.max(0, Math.floor(qty));
  if (targetUid) {
    const target = sys.findItem(targetUid);
    if (target?.defId === defId) left -= sys.consumeItem(targetUid, left);
  }
  if (left <= 0) return true;
  return sys.currentStation() === 'ship' ? sys.consumeDefAll(defId, left) : sys.consumeDef(defId, left);
}

export function updateCraft(sys: InventorySystem, dt: number): void {
  const job = sys.craftJob;
  if (!job || dt <= 0) return;
  job.remaining -= dt;
  if (job.remaining > 0) { sys.ui?.refreshCraft(); return; }
  sys.craftJob = null;
  // 2026-09-10: `job.recipe` is the static row (on bucket 4) — for a salvage it is resolved again against **this item's**
  // durability now. The inputs are the same either way, so `canCraft` · `craftCost` may still be asked with either recipe.
  const r = resolveRecipe(sys, job.recipe, job.targetUid) ?? job.recipe;
  const count = normCount(job.count);
  const outDef = ITEM_DEF_MAP.get(r.outputDefId);
  if (!sys.canCraft(r.id, count) || !outDef) {
    sys.ctx.bus.emit('craft:failed', { recipeId: r.id, reason: 'missing' });
    job.resolve(null);
    sys.ui?.refreshCraft();
    return;
  }
  // 2026-09-08: `extraOutputs` (salvaging `기계 부품`) must fit too — checked before anything is consumed.
  // 2026-09-09: the check covers the **whole batch** (output × count + extras × count, `roomForOutputs`) — a 3-run
  //   준중량탄 hold that has room for one stack of 90 but not for 270 fails here, before a single 화약 is spent.
  if (!roomForOutputs(sys, r, count)) {
    sys.ctx.bus.emit('craft:failed', { recipeId: r.id, reason: 'space' });
    sys.ctx.bus.emit('ui:notify', { text: sys.ctx.isHubPhase() ? NO_ROOM_SHIP : NO_ROOM_FIELD, kind: 'warning' });
    job.resolve(null);
    sys.ui?.refreshCraft();
    return;
  }
  // Weapon salvage (2026-09-08): socketed attachments are worth more than the plate — they come back before the gun goes
  if (job.targetUid && isDisassembleRecipe(r)) sys.detachAllSockets(job.targetUid);
  const costs = sys.craftCost(r);
  for (const i of costs) consumeFor(sys, i.defId, i.qty * count, job.targetUid);
  // `addUnits` merges into existing stacks first and then chunks the rest by `stackMax`, so 270 rounds become
  // however many ≤ 50-round stacks the bag needs; its return value is the *overflow* (empty when everything landed)
  // 2026-09-09 (bag → the stash when it does not fit): the chunks `addUnits` could not put in the bag and handed back
  // are taken by the ship stash. `roomForOutputs` just walked the same order, so nothing should fall out here, but it
  // is still not left to vanish — anything that spills is reported in one line of where it went.
  // 2026-09-15 2nd pass (user's decision): in the ship **the stash first · the bag when full**, in the field the bag only (`addCraftOutputs`).
  const spill = addCraftOutputs(sys, r.outputDefId, r.outputQty * count);
  for (const e of r.extraOutputs ?? []) spill.push(...addCraftOutputs(sys, e.defId, e.qty * count));
  // `roomForOutputs` just walked the same order, so nothing falls out here — it is still not left to vanish
  for (const item of spill) sys.throwToWorld(item, false);
  // the one item the item-gained ticker · `craft:completed` will show — looked for first where the product actually landed
  const first = (sys.ctx.isHubPhase() ? sys.getStash().items().find((p) => p.item.defId === r.outputDefId)?.item : undefined)
    ?? sys.bag.items().find((p) => p.item.defId === r.outputDefId)?.item
    ?? sys.loot.createItem(r.outputDefId, Math.min(outDef.stackMax, r.outputQty));
  sys.ctx.bus.emit('inventory:itemAdded', { item: first, name: outDef.name, rarity: outDef.rarity });
  sys.ctx.bus.emit('craft:completed', { recipeId: r.id, item: first, count });
  sys.ctx.bus.emit('audio:play', { id: 'craft_done' });
  // 2026-09-16: the material refund in one place — the craft skill (every craft) + the research skill (lab benches) + research XP. Salvage does not pass here.
  if (!isDisassembleRecipe(r)) refundAfterCraft(sys, r, costs, count);
  sys.afterChange();
  sys.ui?.refreshCraft();
  job.resolve(first);
  }

/* ══ The material refund — what comes back once a craft is done (one place) ══════════════════════════════════════════════
 *
 * **2026-09-16 (user's decision) — 「all the skill is involved in is the chance of getting some material items back when crafting, and how much」.**
 * So there are two branches now, and **the delivery and the toast happen once** (two toast lines for two rolls would make what happened unreadable):
 *
 *   ① **The craft skill refund** (2026-09-16, every craft) — rolled separately for **each unit of material consumed**, in
 *      proportion to that recipe's skill level (`CraftRecipe.skill`) (`shared/craftRefund.rollCraftRefund`). ⚠ Durable gear
 *      (weapons · armor · bags · durable gadgets) is excluded — its repair cost and salvage yield come out of those same
 *      craft materials, so a cheaper craft alone makes 「craft → salvage」 a profit (`items/Salvage.isCraftRefundable` · `checkSalvageEconomy`).
 *   ② **The research skill refund** (2026-09-13, extractor · mixer · 3D printer) — `derived.researchRefundChance` · `researchRefundFrac`.
 *      **The roll unit is one run**: pressing the stepper for 5 at once still rolls 5 times — the expected value has to match
 *      five single presses, or the stepper would be a loss. Per row the refund is `min(one run's qty, max(1, round(one run's qty × frac)))`.
 *
 * **Delivery order = bag → (in the ship) the stash → the ground** (`giveRefund`). It is **the bag first, the reverse of the craft
 * product** (the stash first), because what comes back is 「the material just about to be used」 and has to be within reach for the
 * next craft. Nothing actually reaches the ground in the ship (the stash comes first): **a game path never silently discards an item** (`inventory/README`).
 *
 * `costs` is always **one run's real consumption** (`craftCost` — after the workshop discount). Salvage (`break_*`) does not pass here.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════ */

/** The benches the research skill applies to. */
const RESEARCH_BENCHES: ReadonlySet<WorkbenchKind> = new Set<WorkbenchKind>(['extract', 'mixer', 'print']);

/** A finite number clamped to 0 … 1 (a missing derived field = 0). */
function unit01(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/** How many one material row gives back in one **research** refund. */
export function researchRefundQty(qty: number, frac: number): number {
  const q = Math.max(0, Math.floor(qty));
  if (q <= 0) return 0;
  return Math.min(q, Math.max(1, Math.round(q * unit01(frac))));
}

/** This recipe's skill (`crafting` / `medicine` / `gardening`) level. With no progression, 0 = no refund. */
export function craftSkillLevel(sys: InventorySystem, recipe: CraftRecipe): number {
  const prog = sys.ctx.progression;
  return prog && typeof prog.getSkill === 'function' ? (prog.getSkill(recipe.skill) ?? 0) : 0;
}

/** Actually hands the refunded materials over — bag → (in the ship) the stash → the ground, plus the one toast line. Nothing listed, nothing happens. */
function giveRefund(sys: InventorySystem, back: ReadonlyMap<string, number>): CraftIngredient[] {
  const ctx = sys.ctx;
  const out: CraftIngredient[] = [];
  for (const [defId, qty] of back) {
    if (!ITEM_DEF_MAP.has(defId) || qty <= 0) continue;
    for (const item of sys.addUnits(defId, qty)) {
      if (ctx.isHubPhase() && sys.tryAddToStash(item)) continue;
      sys.throwToWorld(item, false);
    }
    out.push({ defId, qty });
  }
  if (out.length > 0) {
    const text = out.map((o) => `${ITEM_DEF_MAP.get(o.defId)?.name ?? o.defId} ×${o.qty}`).join(' · ');
    ctx.bus.emit('ui:notify', { text: `재료 회수: ${text}`, kind: 'success', duration: 2.5 });
  }
  return out;
}

/**
 * The whole refund after one craft batch (`count` runs) — ① + ② of the section above are collected and delivered once, and
 * a lab bench gives research XP too. `rng` is for smokes · tests (omitted = `Math.random`). Returns the materials given back (empty when none).
 */
export function refundAfterCraft(
  sys: InventorySystem, recipe: CraftRecipe, costs: readonly CraftIngredient[], count: number, rng: () => number = Math.random,
): CraftIngredient[] {
  const ctx = sys.ctx;
  const prog = ctx.progression;
  const runs = normCount(count);
  const back = new Map<string, number>();

  // ① the craft skill — one roll per material unit (durable gear is not eligible)
  if (isCraftRefundable(recipe)) {
    for (const c of rollCraftRefund(costs, runs, craftSkillLevel(sys, recipe), rng)) {
      back.set(c.defId, (back.get(c.defId) ?? 0) + c.qty);
    }
  }

  // ② the research skill — once per run (extractor · mixer · 3D printer)
  const research = !!recipe.bench && RESEARCH_BENCHES.has(recipe.bench);
  if (research) {
    const derived = (prog?.derived ?? null) as { researchRefundChance?: number; researchRefundFrac?: number } | null;
    const chance = unit01(derived?.researchRefundChance);
    const frac = unit01(derived?.researchRefundFrac);
    if (chance > 0) {
      for (let i = 0; i < runs; i++) {
        if (rng() >= chance) continue;
        for (const c of costs) {
          const n = researchRefundQty(c.qty, frac);
          if (n > 0) back.set(c.defId, (back.get(c.defId) ?? 0) + n);
        }
      }
    }
  }

  const out = giveRefund(sys, back);
  // XP is given after the rolls — this craft's chance is decided by the skill held before the craft
  if (research && prog && typeof prog.addSkillXp === 'function' && RESEARCH_XP_CRAFT > 0) {
    try { prog.addSkillXp('research', RESEARCH_XP_CRAFT * runs); } catch (e) { console.warn('[inventory] research XP failed', e); }
  }
  return out;
}

/* ══ 2026-09-13 — cooking minigames: one cook (`InventoryRef.cookBlock` · `consumeCookInputs`, docs/DECISIONS.md 「2026-09-13 — 요리 미니게임」) ══
 * Called by housing's cook bench screen once the minigame ends. The rules are the ship workbench's craft rules:
 *   Gate      — a cook bench recipe (its product is in the meal table `getMealDef`) · the ship · bench level · tutorial · materials (`craftCost`, workshop discount included).
 *               2026-09-16 (user's decision): **there is no skill gate** — the cooking skill only takes part in the material refund.
 *   Materials — **the bag first** (smallest stack up → pouch → the wheel = `consumeWhere` order) → **the ship stash** (`consumeDefAll`). Exactly the
 *               「in the ship bag + ship stash」 at the head of this file.
 *   Product   — **none.** 2026-09-16 (the plate model, user's decision): a meal is not an item but the dining table's plate — housing puts it in `ShipState.plate`.
 *               So the product room check (the old `roomForCook`) and placing the product (the old `completeCook`) are gone.
 *   Failure   — nothing is taken (`cookBlock` is read again).
 * ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════ */

/** The Korean reason this cook bench recipe cannot be made once **right now**, null = it can. */
export function cookBlock(sys: InventorySystem, recipeId: string, benchLevel: number): string | null {
  const r = getRecipe(recipeId);
  // 2026-09-16 (the plate model): a cook bench product is not an item but an id in the meal table (`getMealDef`)
  if (!r || r.bench !== COOK_BENCH || isDisassembleRecipe(r) || !getMealDef(r.outputDefId)) return COOK_REASON.notCook;
  const ctx = sys.ctx;
  if (!ctx.isHubPhase() || ctx.isRaidActive()) return COOK_REASON.shipOnly;
  const need = r.benchLevel ?? 1;
  const lv = Number.isFinite(benchLevel) ? Math.floor(benchLevel) : 0;
  if (lv < need) return COOK_REASON.level(need);
  /* 2026-09-16 (user's decision, 2nd pass): the skill gate comes back to life **if the data turns it on** — with every
     `skillRequired` at 0 it never blocks today. The skill's standing job (the material refund) is in `consumeCookInputs`, separate from this. */
  const skill = ctx.progression?.getSkill(r.skill) ?? 0;
  if (skill < r.skillRequired) return COOK_REASON.skill(SKILL_WORD[r.skill] ?? r.skill, r.skillRequired);
  const tut = ctx.tutorial?.blockReason('craft', recipeId);
  if (tut) return tut;
  if (!sys.craftCost(r).every((i) => sys.countDefAll(i.defId) >= i.qty)) return COOK_REASON.missing;
  // 2026-09-16 (the plate model): a meal never enters the grid — no product room check (the old `roomForCook` is gone)
  return null;
  }

/**
 * Takes one cook's materials — the gate (`cookBlock`) is read again, the bag first → the stash. There is no product (2026-09-16,
 * the plate model — housing puts it on the dining table). `craft:completed` is not emitted: that event's contract carries the item
 * that was made, and the cooking skill XP · the result toast are already housing's `housing:cookResult`. A Korean reason / null.
 */
export function consumeCookInputs(sys: InventorySystem, recipeId: string, benchLevel: number): string | null {
  const blocked = cookBlock(sys, recipeId, benchLevel);
  const r = getRecipe(recipeId);
  if (blocked || !r) return blocked ?? COOK_REASON.notCook;
  const costs = sys.craftCost(r);
  for (const i of costs) {
    if (!sys.consumeDefAll(i.defId, i.qty)) {
      // `cookBlock` just checked, so this branch is unreachable (unless a recipe lists the same def twice as a material)
      console.error('[inventory] 조리 재료를 빼지 못했다', recipeId, i.defId, i.qty);
      sys.afterChange();
      return COOK_REASON.missing;
    }
  }
  // 2026-09-16 (user's decision): cooking is crafting too — the material refund passes **the same one place** as craft · lab (one cook's run)
  refundAfterCraft(sys, r, costs, 1);
  sys.afterChange();
  return null;
  }
