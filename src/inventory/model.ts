/**
 * src/inventory/model.ts — 인벤토리 폴더의 **공용 어휘**.
 *
 * `InventorySystem` 에서 떼어낸 타입 · 상수 · 순수 술어만 있다. 여기에는 상태도 DOM 도 없고,
 * 다른 인벤토리 파일(`parts/*`, `ui/*`)이 시스템 클래스를 import 하지 않고도 이 어휘를 쓸 수 있게 하는 것이 목적이다
 * (그러지 않으면 `InventorySystem` ↔ `parts/*` 순환 import 가 된다).
 * `InventorySystem.ts` 가 `export * from './model'` 로 그대로 재수출하므로 기존 import 경로는 전부 그대로 동작한다.
 */
import type { CraftIngredient, CraftRecipe, DurabilityInfo, ItemDef, ItemInstance, LoadoutSlot, WeaponSlot, WorkbenchKind } from '@/shared';
import { isWeaponItemDef } from '@/items';
import type { LoadoutSave } from './Loadout';
/* ── UI ↔ system vocabulary ─────────────────────────────────────────────── */
/** 'stash' = the ship stash (hub Tab screen only; persisted, see Stash.ts). */
export type GridId = 'bag' | 'container' | 'stash';
/** Equipment slots = the shared `LoadoutSlot` (주무기 I / 주무기 II / 보조무기 / 가방 / 방탄복). */
export type SlotId = LoadoutSlot;
export const LOADOUT_SLOTS: readonly LoadoutSlot[] = ['primary', 'primary2', 'secondary', 'bag', 'armor'];
export const WEAPON_SLOT_IDS: readonly WeaponSlot[] = ['primary', 'primary2', 'secondary'];
export type ItemLocation = { kind: 'grid'; grid: GridId } | { kind: 'slot'; slot: SlotId };
export type DropTarget =
  | { kind: 'grid'; grid: GridId; x: number; y: number; rotated: boolean }
  | { kind: 'slot'; slot: SlotId }
  /** An attachment released over a weapon tile (bag or equipment slot): socket it. */
  | { kind: 'weapon'; uid: string; loc: ItemLocation }
  /** A stim / grenade released over a quick-use wheel cell: assign it (`setQuickSlot`). */
  | { kind: 'quick'; index: number };
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
/** Active 작업실 bench of the craft panel (`openBenchCraft`); null = the plain 제작 panel. */
export type ActiveBench = { kind: WorkbenchKind; level: number };
/** A craft-panel row: `locked` = the recipe belongs to this bench but needs a higher bench level. */
export type BenchRecipeRow = { recipe: CraftRecipe; locked: boolean };
/** A repair-list row of the bench panel (`where` = loadout slot, null = in the bag grid). */
export type BenchRepairRow = {
  uid: string; item: ItemInstance; def: ItemDef; where: LoadoutSlot | null; dur: DurabilityInfo;
  cost: { defId: string; qty: number; name: string; have: number }[]; short: boolean;
};

export const AUTO_CLOSE_DISTANCE = 6;
/** `container:searchProgress` rate cap (s). */
export const SEARCH_EMIT_INTERVAL = 1 / 20;
/**
 * appended (2026-09-08): grace period after a container window opens before 감정 starts ticking (s, sim time).
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
export interface RaidInventoryState extends LoadoutSave { raid: 1 }
export const BLOCKER_TOKEN = 'inventory';
/** World-drop throw: eye position lowered / pushed forward, forward speed + upward pop. */
export const DROP_EYE_LOWER = 0.3;
export const DROP_FORWARD_OFFSET = 0.4;
export const DROP_FORWARD_SPEED = 3.5;
export const DROP_UP_SPEED = 2.0;
export const MOD_SHIFT = ['ShiftLeft', 'ShiftRight'] as const;
export const MOD_CTRL = ['ControlLeft', 'ControlRight'] as const;
/**
 * Phase 12: materials for one **full** 회복 스프레이 refill (ship 수리). Scaled down by the missing gauge fraction in
 * `sprayRepairCost` (ceil, min 1 each). Existing material defs — 캔 / 소독약 (소독약 is craft-only, `items/Recipes`).
 */
export const SPRAY_REFILL_COST: readonly CraftIngredient[] = [{ defId: 'mat_can', qty: 1 }, { defId: 'mat_antiseptic', qty: 1 }];

/** Which item categories a loadout slot accepts. */
export function slotAccepts(def: ItemDef, slot: LoadoutSlot): boolean {
  if (slot === 'bag') return def.category === 'bag';
  if (slot === 'armor') return def.category === 'armor';
  if (slot === 'secondary') return def.category === 'secondary';
  return def.category === 'primary';
}

export const isWeaponDef = (def: ItemDef | undefined): boolean => isWeaponItemDef(def);
export const isAttachmentDef = (def: ItemDef | undefined): boolean => !!def?.attachment;
export const isBagDef = (def: ItemDef | undefined): boolean => !!def?.bag;
export const isArmorDef = (def: ItemDef | undefined): boolean => def?.category === 'armor' && !!def.armorId;

/**
 * Phase 8 — a **분해** recipe (`break_*`). These no longer appear in the craft list: 분해 is a context-menu entry
 * on the item itself (`disassembleRecipeFor` → the modeless `DisassemblePanel`). `craft()` still accepts them.
 */
export const isDisassembleRecipe = (r: CraftRecipe): boolean => r.id.startsWith('break_');

/** Minimum craft speed multiplier so a pathological derived value cannot make a craft instant. */
export const CRAFT_MIN_SPEED = 0.2;

export interface CraftJob {
  recipe: CraftRecipe;
  remaining: number;
  duration: number;
  resolve(item: ItemInstance | null): void;
}

/**
 * Owns the player's bag grid, the four equipment slots and the open loot container.
 * Publishes `ctx.inventory` (this) and `ctx.loot` (LootService).
 */

/**
 * 두 프로필 문서가 같은 내용인가 — 직렬화 비교. 서버가 돌려준 문서가 **방금 우리가 올린 것**이면
 * 다시 적용할 필요가 없다(적용은 그리드를 재구성하고 이벤트를 뿌린다). 순환 참조가 있으면 false.
 */
export function sameProfileDoc(a: unknown, b: unknown): boolean {
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}
