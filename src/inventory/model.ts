/**
 * src/inventory/model.ts — the inventory folder's **shared vocabulary**.
 *
 * Only the types · constants · pure predicates lifted out of `InventorySystem`. There is no state and no DOM here;
 * the point is that the folder's other files (`parts/*`, `ui/*`) can use this vocabulary without importing the system
 * class (otherwise `InventorySystem` ↔ `parts/*` becomes a circular import).
 * `InventorySystem.ts` re-exports it verbatim with `export * from './model'`, so every existing import path still works.
 */
import type { CraftIngredient, CraftRecipe, DurabilityBucketInfo, DurabilityInfo, ItemCategory, ItemDef, ItemInstance, LoadoutSlot, PouchDef, WeaponSlot, WorkbenchKind } from '@/shared';
import { BAG_DEFAULT_ROWS, CATEGORY_ICON, CATEGORY_LABEL_KO } from '@/shared';
import { ITEM_DEF_MAP, isWeaponItemDef } from '@/items';
import type { LoadoutSave } from './Loadout';
/* ── UI ↔ system vocabulary ─────────────────────────────────────────────── */
/**
 * 'stash' = the ship stash (hub Tab screen only; persisted, see Stash.ts).
 *
 * **2026-09-11 (A-15) — `'pouch'` is 「주머니는 가방 격자가 아니다」.** It is the separate grid opened by the pouch
 * seated in the `pouch` equipment slot, and it draws **the same line** the 2026-09-09 quick slots did: weight ·
 * `countWhere` · `consumeWhere` · `stripForCorpse` · the raid blob see the pouch, `getAllItems()` (the trade · repair
 * lists) is still the bag grid only. No new kind in `ItemLocation` / `DropTarget` — just `{ kind: 'grid', grid: 'pouch' }`.
 */
export type GridId = 'bag' | 'container' | 'stash' | 'pouch';
/**
 * Equipment slots = the shared `LoadoutSlot` (`주무기 I` / `주무기 II` / `가방` / `방탄복`).
 *
 * 2026-09-10 — **the secondary weapon is gone** (user's decision). There are only the two primary weapon slots and
 * `Loadout.secondary` is always null. The `'secondary'` name itself was **not deleted** from `LoadoutSlot` ·
 * `Loadout.secondary` · `WeaponSlot` — `src/shared` is an add-only contract, and saved profiles · presets · crew cards
 * are written with that name (the same treatment `airstrike` got). What was deleted is the **lists · items · data**:
 * the two arrays below, `slotAccepts`, `weapons/WEAPON_SLOTS`, the weapon rows of `hub/ui/WorkbenchMenu`, the catalog ·
 * shop · service/preset menus, and the pistol rows of `data/weapons.csv`.
 * (2026-09-11, C-26: `ui/hud/SlotStrip`, listed here before, was a dead file nobody imported — it decided no slot, and
 * it was deleted in that batch.)
 */
export type SlotId = LoadoutSlot;
/**
 * 2026-09-11 (A-15): `'pouch'` was added (a fixed single cell, `POUCH_SLOTS`).
 *
 * **2026-09-12 (user's decision, option A) — the order is the on-screen layout.** The equipment grid is two columns
 * wide and this array is the **reading order** through it:
 * ```
 *   주무기 I   |  방탄복
 *   주무기 II  |  가방
 *   전술 임플란트 |  주머니
 * ```
 * — that is `primary · armor · primary2 · bag · pouch`. The tactical implant (`ui/ImplantPanel`) is not an equipment
 * slot but its own block, so `InventoryUI.mount` splices it in **before** `pouch` (the same order in the one-column
 * narrow layout). The column / row spots come from `grid-template-areas` in `inventory.css`; this array decides the
 * DOM order at narrow widths.
 *
 * ⚠ This is also the order `emptyEquipTargetFor` (find a free equipment slot) walks. Only the two primaries' relative
 * order (`primary` → `primary2`) matters; the rest never collide because their categories do not overlap.
 */
export const LOADOUT_SLOTS: readonly LoadoutSlot[] = ['primary', 'armor', 'primary2', 'bag', 'pouch'];
export const WEAPON_SLOT_IDS: readonly WeaponSlot[] = ['primary', 'primary2'];
/**
 * Where an item lives. `quick` (2026-09-09): a stack sitting **in** wheel slot `index` — the wheel is its own container
 * since that date, so an item there is in no grid (`locKind` = 'player', like the equipment slots).
 */
export type ItemLocation = { kind: 'grid'; grid: GridId } | { kind: 'slot'; slot: SlotId } | { kind: 'quick'; index: number };
export type DropTarget =
  | { kind: 'grid'; grid: GridId; x: number; y: number; rotated: boolean }
  | { kind: 'slot'; slot: SlotId }
  /** An attachment released over a weapon tile (bag or equipment slot): socket it. */
  | { kind: 'weapon'; uid: string; loc: ItemLocation }
  /** A stim / grenade released over a quick-use wheel cell: assign it (`setQuickSlot`). */
  | { kind: 'quick'; index: number };
/**
 * 2026-09-14 (dragging an attachment out of the pinned tooltip): where an attachment taken out of a socket goes —
 * `detachSocket`. Either a grid cell (bag · stash · pouch — it must land in **exactly** the cell pointed at, never
 * nudged to a neighbouring one) or the ground (in a raid only).
 */
export type DetachTarget =
  | { kind: 'grid'; grid: Extract<GridId, 'bag' | 'stash' | 'pouch'>; x: number; y: number; rotated: boolean }
  | { kind: 'world' };
/**
 * `ok` mutated, `noop` nothing to do (drop in place), `fail` refused (UI shakes), `pending` (Phase 7, multiplayer client)
 * = the take was sent to the host; the move happens on `cont taken`, a `cont denied` shakes the tile.
 */
export type OpResult = 'ok' | 'noop' | 'fail' | 'pending';
export type DropPreview = 'ok' | 'swap' | 'merge' | 'noop' | 'bad';
export type UiSfx = 'ui_pickup' | 'ui_drop' | 'ui_rotate' | 'ui_error' | 'ui_equip';
export type BagSize = { cols: number; rows: number; quickSlots: number };
/** How the last mission ended; decides what `game:abort` does to the bag (see README "Reset policy"). */
export type MissionOutcome = 'none' | 'complete' | 'over';
/* ── Phase 6: bench crafting vocabulary (CraftPanel) ── */
/** The craft panel's active workshop bench (`openBenchCraft`); null = the plain `제작` panel. */
export type ActiveBench = { kind: WorkbenchKind; level: number };
/** A craft-panel row: `locked` = the recipe belongs to this bench but needs a higher bench level. */
export type BenchRecipeRow = { recipe: CraftRecipe; locked: boolean };
/** One material row plus how many are held right now (the repair list · the right-click repair readout). */
export type RepairCostRow = { defId: string; qty: number; name: string; have: number };
/**
 * A repair-list row of the bench panel (`where` = loadout slot, null = in the bag grid).
 *
 * 2026-09-10 — `bucket` was added. Repair materials are now **the craft materials × the multiplier of the remaining
 * durability bucket**, so the bucket is what explains "why it costs this much" (`ctx.loot.durabilityBucketInfo`).
 */
export type BenchRepairRow = {
  uid: string; item: ItemInstance; def: ItemDef; where: LoadoutSlot | null; dur: DurabilityInfo;
  bucket: DurabilityBucketInfo;
  cost: RepairCostRow[]; short: boolean;
};
/**
 * What `InventorySystem.repairInfo` returns (the `수리` entry of the right-click menu).
 * `bucket` is filled in **only when the cost came out of the craft-material rule** — the `회복 스프레이`'s `캔` ·
 * `소독약` are decided by the missing gauge fraction (`sprayRepairCost`), so explaining them by a bucket would lie.
 */
export type RepairInfo = { cost: RepairCostRow[]; short: boolean; bucket: DurabilityBucketInfo | null };

export const AUTO_CLOSE_DISTANCE = 6;
/** `container:searchProgress` rate cap (s). */
export const SEARCH_EMIT_INTERVAL = 1 / 20;
/**
 * appended (2026-09-08): grace period after a container window opens before the search starts ticking (s, sim time).
 * Opening a crate used to start the first item's timer on the very frame the window appeared — the bar was already
 * moving before the panel had finished its open animation. The delay is per **open**, not per container, so a close /
 * reopen pays it again; `Container.searchProgress` still keeps the seconds already banked.
 */
export const SEARCH_START_DELAY = 0.1;
/** A take request the host never answered is dropped after this (s, sim time) so the tile stops pulsing. */
export const TAKE_REQUEST_TIMEOUT = 8;

/* ── Phase 7: host-authoritative container takes (multiplayer clients) ── */
/** A container → player move waiting for the host's `cont taken` / `cont denied`; `run` replays the move on confirmation. */
export interface PendingTake {
  containerId: string;
  idx: number;
  qty: number;
  uid: string;
  from: ItemLocation;
  run: () => OpResult;
  sentAt: number;
}
/** `captureRaidState()` shape: the loadout save plus `searched: false` flags on bag entries (never persisted to disk). */
export interface RaidInventoryState extends LoadoutSave {
  raid: 1;
  /**
   * 2026-09-11 (C-61): the equipped bag has already taken one raid's worth of wear this raid — the **mission seed**
   * of that raid (written only while `InventorySystem.bagWornThisRaid` stands). Omitted = unknown = not worn (old
   * blobs). The seed is carried so that another raid's blob (a training-range snapshot included) cannot bring the mark.
   */
  bagWorn?: number;
}
export const BLOCKER_TOKEN = 'inventory';
/** World-drop throw: eye position lowered / pushed forward, forward speed + upward pop. */
export const DROP_EYE_LOWER = 0.3;
export const DROP_FORWARD_OFFSET = 0.4;
export const DROP_FORWARD_SPEED = 3.5;
export const DROP_UP_SPEED = 2.0;
export const MOD_SHIFT = ['ShiftLeft', 'ShiftRight'] as const;
export const MOD_CTRL = ['ControlLeft', 'ControlRight'] as const;
/**
 * Phase 12: materials for one **full** `회복 스프레이` refill (repaired in the ship). Scaled down by the missing gauge
 * fraction in `sprayRepairCost` (ceil, min 1 each). Existing material defs — `캔` / `소독약` (craft-only, `items/Recipes`).
 */
export const SPRAY_REFILL_COST: readonly CraftIngredient[] = [{ defId: 'mat_can', qty: 1 }, { defId: 'mat_antiseptic', qty: 1 }];

/** Which item categories a loadout slot accepts. 2026-09-10: the secondary weapon slot no longer accepts anything. */
export function slotAccepts(def: ItemDef, slot: LoadoutSlot): boolean {
  if (slot === 'bag') return def.category === 'bag';
  if (slot === 'armor') return def.category === 'armor';
  if (slot === 'pouch') return def.category === 'pouch';
  if (slot === 'secondary') return false;
  return def.category === 'primary';
}

export const isWeaponDef = (def: ItemDef | undefined): boolean => isWeaponItemDef(def);
export const isAttachmentDef = (def: ItemDef | undefined): boolean => !!def?.attachment;
export const isBagDef = (def: ItemDef | undefined): boolean => !!def?.bag;
export const isArmorDef = (def: ItemDef | undefined): boolean => def?.category === 'armor' && !!def.armorId;
/** 2026-09-11 (A-15): what may go in the `pouch` equipment slot — it needs **both** the category and `ItemDef.pouch`. */
export const isPouchDef = (def: ItemDef | undefined): boolean => def?.category === 'pouch' && !!def.pouch;
/** Whether that pouch accepts this item (`PouchDef.accepts`). Always false when there is no pouch. */
export const pouchAcceptsDef = (pouch: PouchDef | null | undefined, def: ItemDef | undefined): boolean =>
  !!pouch && !!def && pouch.accepts.includes(def.category);

/**
 * Phase 8 — a **salvage** recipe (`break_*`). These no longer appear in the craft list: `분해` is a context-menu
 * entry on the item itself (`disassembleRecipeFor` → the modeless `DisassemblePanel`). `craft()` still accepts them.
 */
export const isDisassembleRecipe = (r: CraftRecipe): boolean => r.id.startsWith('break_');

/** Minimum craft speed multiplier so a pathological derived value cannot make a craft instant. */
export const CRAFT_MIN_SPEED = 0.2;

/**
 * **2026-09-08 — the hold time of every craft and salvage (s).**
 *
 * `CraftRecipe.duration`, 2–12 s per recipe, is no longer the hold time (user's decision).
 * What this hold measures is not "how long it takes to make" but **the grace before the materials are consumed** —
 * the safety catch that makes a mis-press do nothing at all as long as it is released. So every recipe uses the same
 * 1 second, and neither the craft skill nor dexterity shortens it (there is nothing to shorten — it is already shortest).
 */
export const CRAFT_HOLD_TIME = 1.0;

export interface CraftJob {
  recipe: CraftRecipe;
  remaining: number;
  duration: number;
  resolve(item: ItemInstance | null): void;
  /* appended (2026-09-08): the `폐금속` supply — naming the salvage target */
  /**
   * The exact bag stack the `분해` dialog was opened on. `updateCraft` consumes **this** instance first (and only then
   * falls back to `consumeDef`), so two identical weapons are never mixed up and the one that was clicked is the one
   * that goes. undefined for an ordinary craft.
   */
  targetUid?: string;
  /* appended (2026-09-09): the craft count */
  /** How many times the recipe runs in this one hold (≥ 1): inputs × count are consumed, output × count is made. */
  count: number;
}

/**
 * Owns the player's bag grid, the four equipment slots and the open loot container.
 * Publishes `ctx.inventory` (this) and `ctx.loot` (LootService).
 */

/**
 * Whether two profile documents hold the same contents — a serialised comparison. A document the server handed back
 * that is **what was just uploaded** need not be applied again (applying rebuilds the grids and fires events).
 * False on a circular reference.
 */
export function sameProfileDoc(a: unknown, b: unknown): boolean {
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

/* ── 2026-09-12: the bag frame · auto sort · filters (user's decision) ──────────────────────────────────── */

/**
 * Rows a bag **box** is drawn at when it has to stand next to a taller grid: the longest bag in `data/bags.csv`
 * (or the no-bag default) — read from the data, so adding a longer bag grows the frame with it.
 *
 * **2026-09-18 (user's decision)**: the Tab window (raid · ship · container looting) no longer uses it — its bag grid
 * is exactly the equipped bag and the **card** is what stretches to the equipment column (`inventory.css`
 * `.inv-panel-grids { align-self: stretch }`). Only `ui/TradeGrids.ts` still frames the bag, where the stash pane
 * beside it is 24 rows tall and an unframed bag would look like a stub.
 */
export const BAG_FRAME_ROWS: number = (() => {
  let rows = BAG_DEFAULT_ROWS;
  for (const def of ITEM_DEF_MAP.values()) if (def.bag && def.bag.rows > rows) rows = def.bag.rows;
  return rows;
})();

/**
 * The auto sort's category order (`parts/Sort.ts`): what is worn → what shoots → what is used → what is sold →
 * what is crafted from → what is grown. A category missing from the list goes last.
 */
export const SORT_CATEGORY_ORDER: readonly ItemCategory[] = [
  'primary', 'secondary', 'attachment', 'armor', 'bag', 'pouch', 'ammo',
  'stim', 'meal', 'prep', 'gadget', 'implant', 'key', 'valuable',
  'material', 'herb', 'seed', 'soil', 'crop', 'sample', 'book', 'disc', 'record', 'game_disc', 'console', 'furniture',
];

export type FilterGroupId = 'all' | 'favorite' | 'weapon' | 'gear' | 'ammo' | 'consumable' | 'gadget' | 'material' | 'valuable' | 'bio' | 'sample' | 'other';

/**
 * The bag · stash filter chips. `categories` null = everything (`all`) · favourites (`favorite` — it reads the def-id
 * table, not a category) · all the rest (`other` — every category no other chip names).
 * A filtered-out tile **only dims, keeping its spot** (`GridView.setFilter`).
 */
export const FILTER_GROUPS: readonly { id: FilterGroupId; label: string; icon: string; categories: readonly ItemCategory[] | null }[] = [
  { id: 'all', label: '전체', icon: '✱', categories: null },
  // 2026-09-12 (E1, user's decision): only favourited defs stay lit
  { id: 'favorite', label: '즐겨찾기', icon: '★', categories: null },
  { id: 'weapon', label: '무기 · 부착물', icon: CATEGORY_ICON.primary, categories: ['primary', 'secondary', 'attachment'] },
  { id: 'gear', label: '방어구 · 가방', icon: CATEGORY_ICON.armor, categories: ['armor', 'bag', 'pouch'] },
  { id: 'ammo', label: '탄약', icon: CATEGORY_ICON.ammo, categories: ['ammo'] },
  { id: 'consumable', label: '소모품', icon: CATEGORY_ICON.stim, categories: ['stim', 'meal', 'prep'] },
  { id: 'gadget', label: '가젯 · 수류탄', icon: CATEGORY_ICON.gadget, categories: ['gadget'] },
  { id: 'material', label: '재료', icon: CATEGORY_ICON.material, categories: ['material'] },
  { id: 'valuable', label: '귀중품 · 열쇠', icon: CATEGORY_ICON.valuable, categories: ['valuable', 'key'] },
  { id: 'bio', label: '재배', icon: CATEGORY_ICON.herb, categories: ['herb', 'seed', 'soil', 'crop'] },
  /* 2026-09-16 (user's report 「필터에 표본이 없다」): `sample` used to sit inside `bio` (growing · research). That was
     fine while samples were a handful, but the collectible super category brought in far more of them, and lighting
     them up together with seeds · soil · crops buries the sample that was being looked for. So it gets its own chip —
     and because two chips lighting the same category could not say which one is selected, `sample` is **taken out** of
     `bio` (whose label is `재배` now), placed right after what is grown. */
  { id: 'sample', label: CATEGORY_LABEL_KO.sample, icon: CATEGORY_ICON.sample, categories: ['sample'] },
  { id: 'other', label: '기타', icon: '…', categories: null },
];

/**
 * Predicate for a filter chip; null for `all` (nothing is dimmed).
 * 2026-09-12 (E1): `favorite` reads the live favourites through `isFavorite` (the caller passes `InventoryRef.isFavorite`),
 * so toggling a favourite while that chip is lit only needs a repaint, not a new predicate.
 */
export function filterPredicate(id: FilterGroupId, isFavorite?: (defId: string) => boolean): ((item: ItemInstance, def: ItemDef) => boolean) | null {
  if (id === 'all') return null;
  if (id === 'favorite') return (_item, def) => !!isFavorite?.(def.id);
  if (id === 'other') {
    const named = new Set<ItemCategory>();
    for (const g of FILTER_GROUPS) for (const c of g.categories ?? []) named.add(c);
    return (_item, def) => !named.has(def.category);
  }
  const cats = new Set(FILTER_GROUPS.find((g) => g.id === id)?.categories ?? []);
  return (_item, def) => cats.has(def.category);
}
