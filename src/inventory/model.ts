/**
 * src/inventory/model.ts — 인벤토리 폴더의 **공용 어휘**.
 *
 * `InventorySystem` 에서 떼어낸 타입 · 상수 · 순수 술어만 있다. 여기에는 상태도 DOM 도 없고,
 * 다른 인벤토리 파일(`parts/*`, `ui/*`)이 시스템 클래스를 import 하지 않고도 이 어휘를 쓸 수 있게 하는 것이 목적이다
 * (그러지 않으면 `InventorySystem` ↔ `parts/*` 순환 import 가 된다).
 * `InventorySystem.ts` 가 `export * from './model'` 로 그대로 재수출하므로 기존 import 경로는 전부 그대로 동작한다.
 */
import type { CraftIngredient, CraftRecipe, DurabilityBucketInfo, DurabilityInfo, ItemCategory, ItemDef, ItemInstance, LoadoutSlot, PouchDef, WeaponSlot, WorkbenchKind } from '@/shared';
import { BAG_DEFAULT_ROWS, CATEGORY_ICON } from '@/shared';
import { ITEM_DEF_MAP, isWeaponItemDef } from '@/items';
import type { LoadoutSave } from './Loadout';
/* ── UI ↔ system vocabulary ─────────────────────────────────────────────── */
/**
 * 'stash' = the ship stash (hub Tab screen only; persisted, see Stash.ts).
 *
 * **2026-09-11 (A-15) — `'pouch'` 는 「주머니는 가방 격자가 아니다」다.** 장비칸 `pouch` 에 끼운 주머니가 여는
 * 별도 격자이고, 2026-09-09 의 퀵슬롯과 **같은 선**을 긋는다: 무게 · `countWhere` · `consumeWhere` ·
 * `stripForCorpse` · 레이드 blob 은 주머니를 보고, `getAllItems()`(거래 · 수리 목록)는 여전히 가방 격자만이다.
 * `ItemLocation` / `DropTarget` 에는 새 종류를 만들지 않았다 — 그냥 `{ kind: 'grid', grid: 'pouch' }` 다.
 */
export type GridId = 'bag' | 'container' | 'stash' | 'pouch';
/**
 * Equipment slots = the shared `LoadoutSlot` (주무기 I / 주무기 II / 가방 / 방탄복).
 *
 * 2026-09-10 — **보조무기가 사라졌다** (사용자 결정). 무기 칸은 주무기 둘뿐이고 `Loadout.secondary` 는 항상 null 이다.
 * `LoadoutSlot` · `Loadout.secondary` · `WeaponSlot` 의 `'secondary'` 자체는 **지우지 않았다** — `src/shared` 는
 * 추가만 하는 계약이고, 저장된 프로필 · 프리셋 · 크루 카드가 그 이름으로 적혀 있기 때문이다 (`airstrike` 와 같은 처리).
 * 지운 것은 **목록 · 아이템 · 데이터**다: 아래 두 배열, `slotAccepts`, `weapons/WEAPON_SLOTS`,
 * `hub/ui/WorkbenchMenu` 의 무기 행 목록, 카탈로그 · 상점 · 정비/프리셋 메뉴, 그리고 `data/weapons.csv` 의 권총 줄.
 * (2026-09-11, C-26: 예전에 여기 적혀 있던 `ui/hud/SlotStrip` 은 아무도 import 하지 않는 죽은 파일이었다 — 칸을 정하지
 * 않았고, 그 배치에서 삭제됐다.)
 */
export type SlotId = LoadoutSlot;
/**
 * 2026-09-11 (A-15): `'pouch'` 가 붙었다 (고정 1칸, `POUCH_SLOTS`).
 *
 * **2026-09-12 (사용자 결정 A안) — 순서가 곧 화면 배치다.** 장비칸 그리드는 두 열이고 이 배열이 그 **읽는 순서**다:
 * ```
 *   주무기 I   |  방탄복
 *   주무기 II  |  가방
 *   전술 임플란트 |  주머니
 * ```
 * 즉 `primary · armor · primary2 · bag · pouch` 이고, 전술 임플란트(`ui/ImplantPanel`)는 장비칸이 아니라
 * 별도 블록이라 `InventoryUI.mount` 가 `pouch` **앞에** 끼워 넣는다 (좁은 폭의 한 줄 세로 배치에서도 같은 순서).
 * 열/행 자리는 `inventory.css` 의 `grid-template-areas` 가 정하고 이 배열은 좁은 폭의 DOM 순서를 정한다.
 *
 * ⚠ 이 순서는 `emptyEquipTargetFor`(빈 장비칸 찾기)가 훑는 순서이기도 하다. 주무기 둘의 상대 순서
 * (`primary` → `primary2`)만 지키면 나머지는 카테고리가 겹치지 않으므로 영향이 없다.
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
/** 재료 한 줄 + 지금 가진 수량 (수리 목록 · 우클릭 수리 readout). */
export type RepairCostRow = { defId: string; qty: number; name: string; have: number };
/**
 * A repair-list row of the bench panel (`where` = loadout slot, null = in the bag grid).
 *
 * 2026-09-10 — `bucket` 이 붙었다. 수리 재료는 이제 **제작 재료 × 남은 내구도 구간의 배수**라서
 * "왜 이만큼 드는가" 를 말해 주는 것이 구간이다 (`ctx.loot.durabilityBucketInfo`).
 */
export type BenchRepairRow = {
  uid: string; item: ItemInstance; def: ItemDef; where: LoadoutSlot | null; dur: DurabilityInfo;
  bucket: DurabilityBucketInfo;
  cost: RepairCostRow[]; short: boolean;
};
/**
 * `InventorySystem.repairInfo` 의 반환값 (우클릭 메뉴의 `수리` 항목).
 * `bucket` 은 **제작 재료 규칙으로 값이 나왔을 때만** 채워진다 — 회복 스프레이의 캔 · 소독약은 게이지
 * 비율로 정해지므로(`sprayRepairCost`) 구간 배수로 설명하면 거짓말이 된다.
 */
export type RepairInfo = { cost: RepairCostRow[]; short: boolean; bucket: DurabilityBucketInfo | null };

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
export interface RaidInventoryState extends LoadoutSave {
  raid: 1;
  /**
   * 2026-09-11 (C-61): 이번 레이드에서 장착 가방이 이미 레이드 1회분 닳았다 — 그 레이드의 **미션 시드**
   * (`InventorySystem.bagWornThisRaid` 가 서 있을 때만 실린다). 생략 = 모른다 = 안 닳았다 (옛 blob 호환).
   * 시드를 싣는 것은 다른 레이드의 blob(훈련장 스냅샷 포함)이 표시를 옮겨 오지 못하게 하려는 것이다.
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
 * Phase 12: materials for one **full** 회복 스프레이 refill (ship 수리). Scaled down by the missing gauge fraction in
 * `sprayRepairCost` (ceil, min 1 each). Existing material defs — 캔 / 소독약 (소독약 is craft-only, `items/Recipes`).
 */
export const SPRAY_REFILL_COST: readonly CraftIngredient[] = [{ defId: 'mat_can', qty: 1 }, { defId: 'mat_antiseptic', qty: 1 }];

/** Which item categories a loadout slot accepts. 2026-09-10: 보조무기 칸은 더 이상 아무것도 받지 않는다. */
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
/** 2026-09-11 (A-15): 장비칸 `pouch` 에 끼울 수 있는 것 — 카테고리와 `ItemDef.pouch` 가 **둘 다** 있어야 한다. */
export const isPouchDef = (def: ItemDef | undefined): boolean => def?.category === 'pouch' && !!def.pouch;
/** 그 주머니가 이 아이템을 받아 주는가 (`PouchDef.accepts`). 주머니가 없으면 언제나 false. */
export const pouchAcceptsDef = (pouch: PouchDef | null | undefined, def: ItemDef | undefined): boolean =>
  !!pouch && !!def && pouch.accepts.includes(def.category);

/**
 * Phase 8 — a **분해** recipe (`break_*`). These no longer appear in the craft list: 분해 is a context-menu entry
 * on the item itself (`disassembleRecipeFor` → the modeless `DisassemblePanel`). `craft()` still accepts them.
 */
export const isDisassembleRecipe = (r: CraftRecipe): boolean => r.id.startsWith('break_');

/** Minimum craft speed multiplier so a pathological derived value cannot make a craft instant. */
export const CRAFT_MIN_SPEED = 0.2;

/**
 * **2026-09-08 — 모든 제작·분해의 누르고 있는 시간 (s).**
 *
 * 레시피마다 2–12 초였던 `CraftRecipe.duration` 은 더 이상 홀드 시간이 아니다 (사용자 결정).
 * 이 홀드가 재는 것은 "만드는 데 걸리는 시간"이 아니라 **재료를 소모하기 전의 유예** — 잘못 누른 것을
 * 떼기만 하면 아무 일도 일어나지 않게 하는 안전장치다. 그래서 모든 레시피가 같은 1 초를 쓰고,
 * 제작 숙련도·재주로 줄이지도 않는다 (줄일 것이 없다 — 이미 제일 짧다).
 */
export const CRAFT_HOLD_TIME = 1.0;

export interface CraftJob {
  recipe: CraftRecipe;
  remaining: number;
  duration: number;
  resolve(item: ItemInstance | null): void;
  /* appended (2026-09-08): 폐금속 공급 — 분해 대상 지정 */
  /**
   * The exact bag stack the 분해 dialog was opened on. `updateCraft` consumes **this** instance first (and only then
   * falls back to `consumeDef`), so two identical weapons never get mixed up and the one you clicked is the one that
   * goes. undefined for an ordinary craft.
   */
  targetUid?: string;
  /* appended (2026-09-09): 제작 수량 */
  /** How many times the recipe runs in this one hold (≥ 1): inputs × count are consumed, output × count is made. */
  count: number;
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

/* ── 2026-09-12: 가방 틀 · 자동 정렬 · 필터 (사용자 결정) ─────────────────────────────────────────────── */

/**
 * Rows the 가방 **box** is always drawn at: the longest bag in `data/bags.csv` (or the no-bag default). The bag panel
 * keeps this size whatever is equipped and a bigger bag fills more of it with cells — read from the data, so adding
 * a longer bag grows the frame with it.
 */
export const BAG_FRAME_ROWS: number = (() => {
  let rows = BAG_DEFAULT_ROWS;
  for (const def of ITEM_DEF_MAP.values()) if (def.bag && def.bag.rows > rows) rows = def.bag.rows;
  return rows;
})();

/**
 * 자동 정렬의 카테고리 순서 (`parts/Sort.ts`). 몸에 걸치는 것 → 쏘는 것 → 쓰는 것 → 파는 것 → 만드는 것 → 기르는 것.
 * 목록에 없는 카테고리는 맨 뒤다.
 */
export const SORT_CATEGORY_ORDER: readonly ItemCategory[] = [
  'primary', 'secondary', 'attachment', 'armor', 'bag', 'pouch', 'ammo',
  'stim', 'meal', 'prep', 'grenade', 'gadget', 'implant', 'key', 'valuable',
  'material', 'herb', 'seed', 'soil', 'crop', 'sample', 'book', 'disc', 'record', 'furniture',
];

export type FilterGroupId = 'all' | 'favorite' | 'weapon' | 'gear' | 'ammo' | 'consumable' | 'gadget' | 'material' | 'valuable' | 'bio' | 'other';

/**
 * 가방 · 창고 필터 칩. `categories` null = 전체(`all`) · 즐겨찾기(`favorite` — 카테고리가 아니라 종류 표를 본다) ·
 * 나머지 전부(`other` — 다른 칩 어디에도 없는 카테고리).
 * 걸러진 타일은 **자리를 지킨 채 어두워질 뿐**이다 (`GridView.setFilter`).
 */
export const FILTER_GROUPS: readonly { id: FilterGroupId; label: string; icon: string; categories: readonly ItemCategory[] | null }[] = [
  { id: 'all', label: '전체', icon: '✱', categories: null },
  // 2026-09-12 (E1, 사용자 결정): 즐겨찾기한 종류만 밝게
  { id: 'favorite', label: '즐겨찾기', icon: '★', categories: null },
  { id: 'weapon', label: '무기 · 부착물', icon: CATEGORY_ICON.primary, categories: ['primary', 'secondary', 'attachment'] },
  { id: 'gear', label: '방어구 · 가방', icon: CATEGORY_ICON.armor, categories: ['armor', 'bag', 'pouch'] },
  { id: 'ammo', label: '탄약', icon: CATEGORY_ICON.ammo, categories: ['ammo'] },
  { id: 'consumable', label: '소모품', icon: CATEGORY_ICON.stim, categories: ['stim', 'meal', 'prep'] },
  { id: 'gadget', label: '가젯 · 수류탄', icon: CATEGORY_ICON.gadget, categories: ['grenade', 'gadget'] },
  { id: 'material', label: '재료', icon: CATEGORY_ICON.material, categories: ['material'] },
  { id: 'valuable', label: '귀중품 · 열쇠', icon: CATEGORY_ICON.valuable, categories: ['valuable', 'key'] },
  { id: 'bio', label: '재배 · 연구', icon: CATEGORY_ICON.herb, categories: ['herb', 'seed', 'soil', 'crop', 'sample'] },
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
