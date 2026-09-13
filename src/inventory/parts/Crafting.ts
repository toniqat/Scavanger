/**
 * src/inventory/parts/Crafting.ts — **제작 · 분해 · 작업대**.
 *
 * 필드 제작(`제작` 열)과 함선 작업대(`openBenchCraft`)는 같은 규칙을 쓰고 재료 출처만 다르다:
 * 레이드에서는 가방만, 함선에서는 가방 + 함선 창고(`countDefAll` / `consumeDefAll`).
 * 분해(`break_*`)는 제작 목록이 아니라 아이템 우클릭에서 열리며 진행 게이지를 `inventory:disassembleProgress` 로 흘린다.
 *
 * **2026-09-10 (제작 대개편 2단계) — 분해 산출은 남은 내구도를 탄다.** `getAllRecipes()` 에 실려 있는 `break_*`
 * 레시피의 수량은 **구간 4(81~100 %) 기준**이다. 그것을 그대로 쓰면 5 % 남은 총도 새 총만큼 뱉는다 —
 * 실제로 방탄복 I 은 어느 내구도에서나 `폐금속 4 + 천조각 2` 를 돌려주고 있었다(구간 0 의 정답은 `폐금속 1`).
 * 그래서 **분해 대상이 지정된 순간 레시피를 다시 푼다** (`resolveRecipe` → `ctx.loot.getSalvageFor(inst)`):
 * 미리보기(`disassembleRecipeFor`) · 자리 검사(`craftHasRoom`) · 실제 산출(`updateCraft`) 셋이 같은 레시피를 본다.
 * id 는 그대로이므로 `craft(recipeId, uid)` 의 게이트(`availableRecipes` 동일성 · `canCraft`)는 한 줄도 바뀌지 않는다.
 */
import * as THREE from 'three';
import type {
  ContainerMessage, ContainerRequest, CraftIngredient, CraftRecipe, CraftStation, DurabilityInfo, GameContext, ItemCategory, ItemDef,
  ItemInstance, Loadout, LoadoutSlot, PeerId as NetPeerId, ProfileRecord, SocketSlot, WeaponSlot, WeightInfo, LoadoutPreset, WorkbenchKind, EmbeddedView,
} from '@/shared';
import { BAG_DEFAULT_COLS, BAG_DEFAULT_QUICK_SLOTS, BAG_DEFAULT_ROWS, Keys, QUICK_SLOTS, SEARCH_MAX_DISTANCE, SOCKET_SLOTS, isQuickSlotActive } from '@/shared';
import { AMMO_LABEL_KO, ITEM_DEF_MAP, STARTER_LOADOUT, STARTER_STASH, ammoItemIdFor, getRecipe, isWeaponItemDef, itemWeight, needsRepairCost } from '@/items';
import { durabilityInfo, gearMultipliers, makeWeightInfo, searchTimeFor, sumWeight } from '../Gear';
/* 2026-09-10: 수리 재료를 정하는 곳은 하나다 (`getRepairCost` → 없으면 회복 스프레이). */
import { repairMaterials } from './Durability';
import { Grid, OOB, stackKeyOf, type Placement, type PriorityPlacement, type StackItem } from '../Grid';
import { normalizeMealQuality } from '@/shared';
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

/** 2026-09-13 (요리 미니게임): 조리대 kind 와 그 한국어 사유들 (`cookBlock` · `completeCook` · `openBenchCraft`). */
const COOK_BENCH: WorkbenchKind = 'cook';
const COOK_USE_STATION = '조리대에서 요리하세요';
const COOK_REASON = {
  notCook: '조리대 레시피가 아닙니다',
  shipOnly: '조리대는 함선에서만 사용할 수 있습니다',
  level: (n: number): string => `조리대 Lv.${n} 이 필요합니다`,
  skill: (label: string, n: number): string => `${label} 숙련 ${n} 이 필요합니다`,
  missing: '재료가 부족합니다',
  noRoom: '넣을 자리가 없습니다',
} as const;
/** 숙련 이름 (조리대 레시피는 전부 `crafting` 이다 — 표에 없는 숙련은 id 그대로). */
const SKILL_WORD: Partial<Record<CraftRecipe['skill'], string>> = { crafting: '제작' };

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
  // 2026-09-13 (요리 미니게임): 조리대는 제작 창을 열지 않는다 — 품질 없이 요리를 만드는 뒷문이 된다 (조리대 화면은 housing)
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
  }
  sys.ui?.setCraftOpen(true);
  ctx.bus.emit('ui:craftToggled', { open: true });
  }

/** Bench the craft panel is showing (null = plain 제작 panel). */
export function getBench(sys: InventorySystem): ActiveBench | null { return sys.bench; }

/**
 * **2026-09-12 (사용자 결정) — 제작 창 안에서 작업대를 갈아 끼운다.** 제작 열 맨 왼쪽의 세로 작업대 리스트
 * (`ui/CraftPanel`)가 부르는 유일한 지점이다.
 *
 * `openBenchCraft` 와 다르게 창을 **열지 않고**, `closeBench` 와 다르게 창을 **닫지 않는다** — 이미 열려 있는
 * 제작 열에서 목록만 갈아 끼우는 것이기 때문이다. `null` = 빠른제작(작업대 없는 목록). 진행 중인 홀드는
 * 취소한다: 목록이 통째로 바뀌므로 누르고 있던 줄이 사라질 수 있다.
 */
export function switchBench(sys: InventorySystem, bench: WorkbenchKind | null, level = 0): void {
  if (bench && !sys.ctx.isHubPhase()) return;   // 작업대는 함선에서만 (openBenchCraft 와 같은 규칙)
  if (bench === COOK_BENCH) return;              // 2026-09-13: 조리대는 제작 창의 작업대가 아니다 (openBenchCraft 와 같은 규칙)
  sys.cancelCraft();
  sys.bench = bench ? { kind: bench, level: Math.max(0, Math.floor(level)) } : null;
  }

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
 * 수리할 수 있는 장비 목록 (장비칸 + 가방 격자). 내구도가 없는 것은 건너뛰고, `wornOnly` (2026-09-08) 는 이미
 * 만피인 것까지 뺀다 — 수리 팝업은 **고칠 것**을 보여 주는 목록이지 장비 전체 목록이 아니다.
 *
 * **2026-09-12 (사용자 결정) — 함선에서는 재료만 갖다 바치면 수리된다.** 정비 벤치(`furn_repair_bench`)가
 * 은퇴하면서 "어느 작업대냐"가 수리의 조건이 아니게 됐다: 예전에는 `sys.bench` 가 총기 · 장비 작업대일 때만
 * 목록이 나왔고(그 외에는 빈 배열) 그래서 **작업대를 열지 않으면 `모두 수리` 자체가 없었다**. 이제 함선이면
 * 무기 · 방탄복 · 가방을 전부 본다. **레이드 중에는 그대로 불가** — `repair()` 와 같은 게이트다.
 */
export function benchRepairRows(sys: InventorySystem, wornOnly = false): BenchRepairRow[] {
  if (sys.ctx.isRaidActive()) return [];
  const wants = (def: ItemDef): boolean => isWeaponItemDef(def) || def.category === 'armor' || def.category === 'bag';
  const rows: BenchRepairRow[] = [];
  const push = (item: ItemInstance, where: LoadoutSlot | null): void => {
    const def = ITEM_DEF_MAP.get(item.defId);
    if (!def || !wants(def)) return;
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
    /* 2026-09-13 (요리 미니게임): 조리대 레시피는 일반 제작 목록(가방의 `제작` · 빠른제작 · 다른 작업대)에 뜨지 않는다.
       **조리대를 이름으로 물을 때만**(`getRecipes('ship', 'cook', lv)` — housing 조리대 화면의 요리 목록) 돌려준다.
       만드는 길은 `completeCook` 하나다 — `canCraft` · `craft` 는 조리대 레시피를 받지 않는다. */
    if (r.bench === COOK_BENCH && bench !== COOK_BENCH) return false;
    if (station === 'field') return r.station === 'field';
    const need = r.benchLevel ?? 1;
    /* 2026-09-10 (사용자 결정) — **작업대를 열면 그 작업대의 레시피만 보인다.** 예전에는 `bench` 가 없는
       레시피를 전부 실어서 정제 작업대 Lv.3 에도 붕대 · 탄약이 떴다. 레시피가 94줄로 늘면서 그 목록이
       읽을 수 없어졌다. 현장 레시피도 이제 `data/recipes.csv` 에서 자기 작업대를 밝히므로(탄약 → 총기 …)
       "같은 작업대 창에서 소총 다음 탄약" 같은 흐름은 그대로 산다 — 튜토리얼이 그것에 기대고 있다. */
    if (bench !== undefined) return r.bench === bench && need <= level;
    /* 가방 화면의 제작 목록: 현장 레시피는 작업대가 없어도 언제나(그래서 `bench` 태그를 안 본다),
       함선 전용 레시피는 그 작업대가 실제로 놓여 있고 레벨이 되어야 한다. */
    if (r.station === 'field') return true;
    if (r.bench === undefined) return true;
    return placedLevel(r.bench) >= need;
  });
  }

/**
 * Phase 8 — 분해 recipe of an item the player owns, or null. The UI turns it into the `분해` context-menu entry
 * and the modeless dialog. Crafting itself is unchanged (`craft()` still accepts these recipes) — they are only
 * hidden from the craft *list*.
 *
 * **2026-09-10 — 이것은 미리보기이고, 미리보기는 실제와 같아야 한다.** 예전에는 `getAllRecipes()` 를 훑어
 * 정적 `break_*` 줄을 그대로 돌려줬다. 그 줄의 수량은 구간 4(81~100 %) 기준이라 5 % 남은 방탄복 I 도
 * `폐금속 4 + 천조각 2` 라고 적혀 있었다 (실제 정답은 `폐금속 1`). 이제 `ctx.loot.getSalvageFor(inst)` 가
 * 그 인스턴스의 남은 내구도로 다시 푼 레시피를 준다 — `id` 는 같으므로 `craft(id, uid)` 는 그대로 동작한다.
 */
export function disassembleRecipeFor(sys: InventorySystem, uid: string): CraftRecipe | null {
  const item = sys.findItem(uid);
  return item ? sys.loot.getSalvageFor(item) : null;
  }

/**
 * 분해 대상이 지정된 `break_*` 를 **그 인스턴스의 남은 내구도**로 다시 푼다 (2026-09-10). 미리보기 ·
 * 자리 검사 · 실제 산출이 전부 이 함수를 지난다. 분해가 아니거나 대상이 없으면 받은 레시피 그대로다.
 */
function resolveRecipe(sys: InventorySystem, r: CraftRecipe | undefined, targetUid?: string): CraftRecipe | null {
  if (!r) return null;
  if (!targetUid || !isDisassembleRecipe(r)) return r;
  const item = sys.findItem(targetUid);
  if (!item || item.defId !== r.inputs[0]?.defId) return r;
  return sys.loot.getSalvageFor(item) ?? r;
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
  if (r.bench === COOK_BENCH) return false;   // 2026-09-13: 조리대 레시피는 `completeCook` 으로만 (품질 없는 뒷문 금지)
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
 *
 * 2026-09-10 — takes `targetUid`, so the 분해 팝업 asks about **what this exact item will actually produce**.
 * 정적 줄로 재면 구간 4 기준의 산출물 자리를 잡으므로, 다 망가진 총을 뜯을 때 자리 계산이 어긋난다.
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
  // 2026-09-10: `job.recipe` 는 정적 줄(구간 4 기준)이다 — 분해라면 **지금 그 아이템**의 내구도로 다시 푼다.
  // 재료(`inputs`)는 어느 쪽이든 같으므로 `canCraft` · `craftCost` 는 그대로 두 레시피 어느 것으로 물어도 된다.
  const r = resolveRecipe(sys, job.recipe, job.targetUid) ?? job.recipe;
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

/* ══ 2026-09-13 — 요리 미니게임: 조리 1회 (`InventoryRef.cookBlock` · `completeCook`, docs/plans/cooking-minigames.md §6-2) ══════
 * housing 의 조리대 화면이 미니게임을 끝낸 뒤 **품질**을 들고 부른다. 규칙은 함선 작업대 제작과 같다:
 *   게이트 — 조리대 레시피 · 함선 · 작업대 레벨 · 숙련 · 튜토리얼 · 재료(`craftCost`, 작업실 할인 포함) · 산출물 자리.
 *   재료   — **가방 먼저**(작은 스택부터 → 주머니 → 휠 = `consumeWhere` 순서) → **함선 창고** (`consumeDefAll`). 이 파일 머리의
 *            「함선에서는 가방 + 함선 창고」 그대로다 — 조리대 화면은 창고 · 가방 카드를 나란히 보여 주고 수확물은 창고로 들어온다.
 *   산출   — 1회분(`outputQty`, 품질 `quality`) + `extraOutputs`(품질 없음), **창고 먼저 → 가방** (재배 · 배양 수확과 같은 쪽).
 *   실패   — 아무것도 빼지 않는다 (`cookBlock` 을 다시 보고, 자리는 소모 전에 dry-run 으로 확인한다).
 * ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════ */

/** 조리대 레시피를 **지금** 1회 만들 수 없는 한국어 사유, null = 가능. */
export function cookBlock(sys: InventorySystem, recipeId: string, benchLevel: number): string | null {
  const r = getRecipe(recipeId);
  if (!r || r.bench !== COOK_BENCH || isDisassembleRecipe(r) || !ITEM_DEF_MAP.has(r.outputDefId)) return COOK_REASON.notCook;
  const ctx = sys.ctx;
  if (!ctx.isHubPhase() || ctx.isRaidActive()) return COOK_REASON.shipOnly;
  const need = r.benchLevel ?? 1;
  const lv = Number.isFinite(benchLevel) ? Math.floor(benchLevel) : 0;
  if (lv < need) return COOK_REASON.level(need);
  const skill = ctx.progression?.getSkill(r.skill) ?? 0;
  if (skill < r.skillRequired) return COOK_REASON.skill(SKILL_WORD[r.skill] ?? r.skill, r.skillRequired);
  const tut = ctx.tutorial?.blockReason('craft', recipeId);
  if (tut) return tut;
  if (!sys.craftCost(r).every((i) => sys.countDefAll(i.defId) >= i.qty)) return COOK_REASON.missing;
  // 시작 전에는 품질을 모른다 → 어느 스택과도 합쳐지지 않는다고 보고(새 칸이 필요) 잰다. `completeCook` 은 실제 품질로 다시 잰다.
  if (!roomForCook(sys, r, null)) return COOK_REASON.noRoom;
  return null;
  }

/** 같은 분류 열쇠(요리 품질 포함)의 스택만 합치는 dry-run 합치기 예산 — `dryMerge` 의 품질판. */
function dryMergeKeyed(g: DryGrid, def: ItemDef, probe: StackItem, want: number): number {
  if (def.stackMax <= 1 || want <= 0) return 0;
  const key = `${def.id}|${stackKeyOf(probe)}`;
  const cap = g.merge.get(key) ?? g.grid.mergeCapacity(def.id, probe);
  const used = Math.min(cap, want);
  g.merge.set(key, cap - used);
  return used;
}

/**
 * 조리 1회의 산출물(품질 `quality` 인 본 산출물 + 품질 없는 `extraOutputs`)이 **창고 → 가방** 순서로 전부 들어가는가.
 * 덩어리(`stackMax` 이하)마다 `Grid.autoPlace` 와 같은 판정 — 그 격자의 같은 열쇠 스택이 다 받으면 합치기, 아니면 빈칸이 있을 때
 * 합칠 만큼 합치고 나머지를 한 칸에. 그 격자에서 안 되면(아무것도 쓰지 않고) 다음 격자.
 */
function roomForCook(sys: InventorySystem, recipe: CraftRecipe, quality: number | null): boolean {
  const order: DryGrid[] = [];
  if (sys.ctx.isHubPhase()) order.push(dryGrid(sys.getStash()));
  order.push(dryGrid(sys.bag));
  /** `quality === null` = 품질을 아직 모른다: 본 산출물은 기존 스택에 합치지 않는다고 본다 (보수적). */
  const unknown = quality === null;
  const q = normalizeMealQuality(quality ?? 0);
  const outputs = [{ defId: recipe.outputDefId, qty: recipe.outputQty, quality: q, noMerge: unknown },
    ...(recipe.extraOutputs ?? []).map((e) => ({ defId: e.defId, qty: e.qty, quality: 0, noMerge: false }))];
  for (const o of outputs) {
    const def = ITEM_DEF_MAP.get(o.defId);
    if (!def) return false;
    const probe: StackItem = o.quality > 0 ? { defId: o.defId, quality: o.quality } : { defId: o.defId };
    let left = Math.max(0, Math.floor(o.qty));
    while (left > 0) {
      const chunk = Math.min(def.stackMax, left);
      left -= chunk;
      let placed = false;
      for (const g of order) {
        const key = `${def.id}|${stackKeyOf(probe)}`;
        const cap = def.stackMax > 1 && !o.noMerge ? (g.merge.get(key) ?? g.grid.mergeCapacity(def.id, probe)) : 0;
        if (chunk <= cap) { dryMergeKeyed(g, def, probe, chunk); placed = true; break; }
        if (dryPlace(g, def)) { dryMergeKeyed(g, def, probe, cap); placed = true; break; }
      }
      if (!placed) return false;
    }
  }
  return true;
}

/** 조리 1회를 마무리한다 — 게이트를 다시 보고, 재료를 빼고, 품질 붙은 산출물을 창고 먼저 → 가방에. */
export function completeCook(sys: InventorySystem, recipeId: string, benchLevel: number, quality: number):
  { item: ItemInstance | null; landed: 'bag' | 'stash' | null; reason: string | null } {
  const blocked = cookBlock(sys, recipeId, benchLevel);
  const q = normalizeMealQuality(quality);
  const r = getRecipe(recipeId);
  const outDef = r ? ITEM_DEF_MAP.get(r.outputDefId) : undefined;
  if (blocked || !r || !outDef) return { item: null, landed: null, reason: blocked ?? COOK_REASON.notCook };
  // `cookBlock` 은 품질 없는 자리를 봤다 — 품질이 붙으면 합칠 수 있는 스택이 달라지므로 그 품질로 한 번 더 본다
  if (!roomForCook(sys, r, q)) return { item: null, landed: null, reason: COOK_REASON.noRoom };
  for (const i of sys.craftCost(r)) {
    if (!sys.consumeDefAll(i.defId, i.qty)) {
      // `cookBlock` 이 방금 확인했으므로 오지 않는 가지다 (같은 def 가 재료에 두 번 적힌 레시피가 아닌 한)
      console.error('[inventory] 조리 재료를 빼지 못했다', recipeId, i.defId, i.qty);
      sys.afterChange();
      return { item: null, landed: null, reason: COOK_REASON.missing };
    }
  }
  const stash = sys.ctx.isHubPhase() ? sys.getStash() : null;
  const place = (defId: string, qty: number, withQuality: number): { item: ItemInstance; landed: 'bag' | 'stash' | null }[] => {
    const def = ITEM_DEF_MAP.get(defId);
    const out: { item: ItemInstance; landed: 'bag' | 'stash' | null }[] = [];
    if (!def) return out;
    let left = Math.max(0, Math.floor(qty));
    while (left > 0) {
      const chunk = Math.min(def.stackMax, left);
      left -= chunk;
      const item = sys.loot.createItem(defId, chunk);
      if (withQuality > 0) item.quality = withQuality; else delete item.quality;
      const probe: StackItem = { defId, quality: item.quality };
      if (stash && stash.autoPlace(item)) out.push({ item: heldStack(stash, item, probe), landed: 'stash' });
      else if (sys.bag.autoPlace(item)) out.push({ item: heldStack(sys.bag, item, probe), landed: 'bag' });
      else { sys.throwToWorld(item, false); out.push({ item, landed: null }); }   // dry-run 이 막았으므로 사실상 오지 않는다
    }
    return out;
  };
  const main = place(r.outputDefId, r.outputQty, q);
  for (const e of r.extraOutputs ?? []) place(e.defId, e.qty, 0);
  const first = main[0] ?? { item: sys.loot.createItem(r.outputDefId, Math.max(1, r.outputQty)), landed: null };
  if (q > 0 && first.landed === null) first.item.quality = q;
  sys.ctx.bus.emit('inventory:itemAdded', { item: first.item, name: outDef.name, rarity: outDef.rarity });
  sys.ctx.bus.emit('craft:completed', { recipeId: r.id, item: first.item, count: 1 });
  sys.afterChange();
  return { item: first.item, landed: first.landed, reason: null };
  }

/** `autoPlace` 뒤에 그 덩어리를 실제로 들고 있는 스택 — 합쳐져 사라졌으면 같은 열쇠의 스택. */
function heldStack(grid: Grid, item: ItemInstance, probe: StackItem): ItemInstance {
  if (grid.has(item.uid)) return item;
  const key = stackKeyOf(probe);
  return grid.items().find((p) => p.item.defId === probe.defId && stackKeyOf(p.item) === key)?.item ?? item;
}
