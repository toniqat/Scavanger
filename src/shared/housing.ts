import type { CraftIngredient } from './gear';
import type { ImplantId } from './implants';
import type { SkillId } from './progression';
import type { EmbeddedView } from './types';

/* ────────────────────────────────────────────────────────────────────────────
 * Ship housing (함선 꾸미기, 2026-09-06). Owner: housing/HousingSystem publishes `ctx.housing` and persists the
 * ShipState in localStorage (SHIP_STORAGE_KEY). The personal ship is cockpit → corridor → 10 rooms (5 per side) →
 * airlock (shared-ship entrance when docked). hub/ builds the geometry, converts room cells ↔ world positions,
 * renders placed furniture and runs the housing-mode camera / cursor; housing/ owns every rule and number.
 *
 * Framework scope (this session): room purposes, generator / storage facilities, housing mode (grid placement, 90°
 * yaw, recover → furniture storage), the 작업실 (4 upgradeable benches + repair) and the 사격장 (loadout presets,
 * gun-skill gain bonus). The other 7 purposes can be assigned and decorated but have no mechanics yet.
 * ──────────────────────────────────────────────────────────────────────────── */

export type RoomPurpose =
  | 'empty'       // 빈 방
  | 'workshop'    // 작업실
  | 'range'       // 사격장
  | 'gym'         // 헬스장
  | 'library'     // 서재
  | 'greenhouse'  // 온실
  | 'lab'         // 연구실 (requires greenhouse)
  | 'kitchen'     // 주방
  | 'mining'      // 채굴 시설
  | 'lounge';     // 휴식 공간

export const ROOM_PURPOSES: readonly RoomPurpose[] = [
  'empty', 'workshop', 'range', 'gym', 'library', 'greenhouse', 'lab', 'kitchen', 'mining', 'lounge',
];

export const ROOM_PURPOSE_LABEL_KO: Readonly<Record<RoomPurpose, string>> = {
  empty: '빈 방', workshop: '작업실', range: '사격장', gym: '헬스장', library: '서재', greenhouse: '온실',
  lab: '연구실', kitchen: '주방', mining: '채굴 시설', lounge: '휴식 공간',
};

export const ROOM_PURPOSE_DESC_KO: Readonly<Record<RoomPurpose, string>> = {
  empty: '아직 용도가 정해지지 않은 방입니다.',
  workshop: '총기 · 장비 · 가젯 · 의학 작업대를 설치해 제작과 수리를 합니다.',
  range: '로드아웃 프리셋을 관리하고 레이드 사격 숙련 상승량을 높입니다.',
  gym: '운동 기구로 근력 · 지구력을 단련합니다. (다음 업데이트)',
  library: '책장에 레이드에서 주운 책을 꽂으면 그 책이 가르치는 숙련의 상승량이 늘어납니다. 꽂아 본 책은 도감에 남습니다.',
  greenhouse: '재배층을 설치하고 씨앗을 심어 현실 시간에 맞춰 약초를 재배합니다.',
  lab: '배양기와 생체 프린터로 토양 · 씨앗 · 배양고기를 연구합니다. 온실이 먼저 필요합니다. (다음 업데이트)',
  kitchen: '요리로 다음 레이드 버프를 만듭니다. (다음 업데이트)',
  mining: '그래픽카드로 암호화폐를 채굴합니다. (다음 업데이트)',
  lounge: 'TV · 스피커로 비디오와 Vinyl 을 재생합니다. (다음 업데이트)',
};

/**
 * appended (Phase 9 UI pass): the **one** icon + accent colour per room purpose. Every place a facility is shown —
 * the 함선 tab 방 목록, the 시설 관리 room list, its 용도 지정 picker — draws this glyph on a `--pc`-tinted thumbnail,
 * so a facility looks the same everywhere. Procedural on purpose: no asset files (see CLAUDE.md).
 */
export const ROOM_PURPOSE_GLYPH: Readonly<Record<RoomPurpose, string>> = {
  empty: '·', workshop: '⚒', range: '◎', gym: '⚖', library: '▤', greenhouse: '❀',
  lab: '⚗', kitchen: '♨', mining: '⛏', lounge: '☕',
};
export const ROOM_PURPOSE_COLOR: Readonly<Record<RoomPurpose, string>> = {
  empty: '#7d858f', workshop: '#ffd27a', range: '#7fd2ff', gym: '#ff9f7a', library: '#c9a77a', greenhouse: '#7ee08a',
  lab: '#c79fff', kitchen: '#ffb0a0', mining: '#9fb4c8', lounge: '#e8a0d0',
};

/**
 * appended (Phase 9 UI pass): materials a **시설 증축** costs — giving an empty room a purpose is no longer free.
 * This is the price of the facility's level 1 (levels 2+ keep their own `*_UPGRADE_COST` tables); 빈 방 costs
 * nothing, and 시설 제거 refunds this table plus every upgrade (`Rules.facilityRefundCost`). Building anything also
 * needs 발전기 Lv.1, exactly like every other upgrade — see `Rules.purposeBuildBlockReason`.
 */
export const ROOM_PURPOSE_BUILD_COST: Readonly<Record<RoomPurpose, readonly { defId: string; qty: number }[]>> = {
  empty: [],
  workshop: [{ defId: 'mat_scrap', qty: 8 }, { defId: 'mat_cable', qty: 2 }],
  range: [{ defId: 'mat_scrap', qty: 10 }, { defId: 'mat_cable', qty: 2 }],
  gym: [{ defId: 'mat_scrap', qty: 8 }],
  library: [{ defId: 'mat_scrap', qty: 10 }, { defId: 'mat_alloy', qty: 2 }],
  greenhouse: [{ defId: 'mat_scrap', qty: 12 }, { defId: 'mat_alloy', qty: 2 }],
  lab: [{ defId: 'mat_alloy', qty: 6 }, { defId: 'mat_circuit', qty: 2 }],
  kitchen: [{ defId: 'mat_scrap', qty: 8 }, { defId: 'mat_alloy', qty: 2 }],
  mining: [{ defId: 'mat_alloy', qty: 6 }, { defId: 'mat_circuit', qty: 3 }],
  lounge: [{ defId: 'mat_scrap', qty: 6 }, { defId: 'mat_cable', qty: 1 }],
};

/** Generator level a 시설 증축 needs (the same gate every facility upgrade sits behind). */
export const ROOM_PURPOSE_BUILD_GENERATOR_LEVEL = 1;

/** Purposes with mechanics in this build; the rest are decoration-only. (Phase 8 appended `greenhouse`.) */
export const ROOM_PURPOSES_ACTIVE: readonly RoomPurpose[] = ['empty', 'workshop', 'range', 'greenhouse', 'library'];   // Phase 9 appended `library`

/**
 * appended (Phase 8 UI pass): the ship always ships with a 작업실, and it is **always room 1** (index 0). The room
 * cannot be re-purposed and no other room may become a 작업실 — housing/Rules enforces both, housing/ShipState
 * migrates older saves onto it (furniture that no longer fits its room goes back to furniture storage), and the
 * 방 목록 pickers render the room as locked.
 */
export const WORKSHOP_ROOM_INDEX = 0;

/** Upgradeable facilities that are not furniture. `workshop` / `range` levels belong to the room of that purpose. */
export type FacilityId = 'generator' | 'storage' | 'workshop' | 'range';

export const FACILITY_LABEL_KO: Readonly<Record<FacilityId, string>> = {
  generator: '발전기', storage: '창고', workshop: '작업실', range: '사격장',
};

/** appended (Phase 9 UI pass): icon + accent per facility, the ship-wide counterpart of `ROOM_PURPOSE_GLYPH`. */
export const FACILITY_GLYPH: Readonly<Record<FacilityId, string>> = {
  generator: '⚡', storage: '▦', workshop: '⚒', range: '◎',
};
export const FACILITY_COLOR: Readonly<Record<FacilityId, string>> = {
  generator: '#ffd166', storage: '#9fb4ff', workshop: '#ffd27a', range: '#7fd2ff',
};

/** The four 작업실 benches. */
export type WorkbenchKind = 'gun' | 'gear' | 'gadget' | 'medical';
export const WORKBENCH_KINDS: readonly WorkbenchKind[] = ['gun', 'gear', 'gadget', 'medical'];
export const WORKBENCH_LABEL_KO: Readonly<Record<WorkbenchKind, string>> = {
  gun: '총기 작업대', gear: '장비 작업대', gadget: '가젯 작업대', medical: '의학 작업대',
};

/** Procedural furniture models hub/ knows how to build (no asset files). */
export type FurnitureModelKind =
  | 'bench_gun' | 'bench_gear' | 'bench_gadget' | 'bench_medical'
  | 'range_console' | 'target_lane'
  | 'sim_hub'   // appended (Phase 7): 시뮬레이션 허브 — holo pedestal in the 사격장
  /* appended (Phase 8): 온실 재배층 (stackable grow rack) and the 정비 벤치 moved out of the cockpit */
  | 'grow_rack' | 'repair_bench'
  | 'bookshelf'   // appended (Phase 9): 서재 책장 — the builder reads the shelved count and fills the shelves
  | 'locker' | 'table' | 'shelf' | 'crate' | 'lamp' | 'plant' | 'chair' | 'bunk';

/** What E does on a placed piece. */
export type FurnitureInteraction =
  | 'none'
  | 'workbench_gun' | 'workbench_gear' | 'workbench_gadget' | 'workbench_medical'  // → ctx.inventory.openBenchCraft(kind)
  | 'range_console'                                                               // → ctx.housing.openPresetMenu()
  | 'sim_hub'                                                                     // appended (Phase 7) → hub starts / joins the 시뮬레이션 훈련장
  /* appended (Phase 8) */
  | 'grow_rack'                                                                   // → ctx.housing.openGrowMenu(uid): 씨앗 심기 / 수확
  | 'repair_bench'                                                                // → the 정비 벤치 repair menu (hub/WorkbenchMenu), no longer built into the cockpit
  /* appended (Phase 9) */
  | 'bookshelf';                                                                  // → ctx.housing.openBookshelfMenu(uid): 책 꽂기 / 빼기 / 도감

export interface FurnitureDef {
  id: string;
  name: string;
  description: string;
  /** Room purpose it may be placed in; 'any' = every room. */
  room: RoomPurpose | 'any';
  /** Footprint in grid cells before rotation (yaw 1 / 3 swap them). */
  cols: number;
  rows: number;
  /** Visual height (m) for the hub's placeholder model. */
  height: number;
  model: FurnitureModelKind;
  interaction: FurnitureInteraction;
  /** Materials to craft one (bag + stash, see `InventoryRef.consumeDefAll`). null = not craftable (buy-only later). */
  craft: CraftIngredient[] | null;
  /** 1 = not upgradeable. */
  maxLevel: number;
  /** `upgradeCost[level - 1]` = cost to go from `level` to `level + 1`. Length maxLevel − 1. */
  upgradeCost: CraftIngredient[][];
  /** CSS colour for icons / tint. */
  color: string;
  /* ── appended (Phase 8) ── */
  /**
   * Stackable furniture (재배층): how many copies may share one footprint, each on its own `PlacedFurniture.layer`
   * (0-based, rendered `layer × def.height` above the deck). Undefined / 1 = the normal "no overlap at all" rule.
   * A stack is homogeneous: only the same `defId` at the same `x`/`y`/`yaw` may share the footprint.
   */
  stackLimit?: number;
}

/** A piece placed in a room. `x`/`y` = top-left cell, `yaw` = quarter turns clockwise seen from above. */
export interface PlacedFurniture {
  uid: string;
  defId: string;
  room: number;
  x: number;
  y: number;
  yaw: 0 | 1 | 2 | 3;
  level: number;
  /* ── appended (Phase 8) ── */
  /** Stack index for `FurnitureDef.stackLimit` furniture (0 = on the deck). Absent / 0 for everything else. */
  layer?: number;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 온실 재배 (Phase 8). A 재배층 (`furn_grow_rack`) holds `GROW_PLOTS_PER_RACK` plots. A plot grows in **real world
 * time**: `plantedAt` is an epoch-ms stamp taken from the relay when one is connected (`ctx.net.serverNow()`), else
 * `Date.now()`, so a crop keeps growing while the player is offline, in a raid, or on another device.
 * ──────────────────────────────────────────────────────────────────────────── */

/** One planted (or ready) plot. Empty plots are simply absent from `ShipState.plots`. */
export interface GrowPlot {
  /** `PlacedFurniture.uid` of the 재배층 it belongs to. */
  uid: string;
  /** Plot index inside that rack, 0 … GROW_PLOTS_PER_RACK − 1. */
  slot: number;
  /** Seed item def id (`ItemDef.seed` must be set). */
  seedDefId: string;
  /** Epoch ms when it was planted. */
  plantedAt: number;
  /** Epoch ms when it may be harvested (`plantedAt + growHours × 3600e3 × 원예 speed`). Stored so a skill change mid-grow never moves a running timer. */
  readyAt: number;
}

/** A plot as the UI sees it — `seedDefId === null` means the slot is free. */
export interface GrowPlotInfo {
  slot: number;
  seedDefId: string | null;
  /** 0 … 1; −1 when empty. */
  progress: number;
  /** Seconds left, 0 when ready or empty. */
  remainingS: number;
  ready: boolean;
  /** What harvesting yields, for the panel. */
  yieldDefId: string | null;
  yieldQty: number;
}

/** Furniture storage entry (no grid, no cap): recovered / crafted pieces waiting to be placed. */
export interface StoredFurniture {
  defId: string;
  level: number;
  qty: number;
}

export interface RoomState {
  purpose: RoomPurpose;
  /** Facility level of the room (workshop / range); 1 when a purpose is assigned, 0 while empty. */
  level: number;
}

/** Loadout preset (사격장): def ids; null = leave the slot as it is. */
export interface LoadoutPreset {
  name: string;
  primary: string | null;
  primary2: string | null;
  secondary: string | null;
  bag: string | null;
  armor: string | null;
  implant: ImplantId | null;
}

/** Persisted in localStorage (SHIP_STORAGE_KEY). Bump `version` when the shape changes. */
export interface ShipState {
  version: number;
  /** SHIP_ROOM_COUNT entries; index 0..4 = port side (−X) front→back, 5..9 = starboard (+X) front→back. */
  rooms: RoomState[];
  generatorLevel: number;
  storageLevel: number;
  furniture: PlacedFurniture[];
  furnitureStorage: StoredFurniture[];
  /** Up to `getPresetCount()` entries; null = empty preset slot. */
  presets: (LoadoutPreset | null)[];
  /* ── appended (Phase 8) ── */
  /** 온실 재배층 plots. Absent in a v1 save; entries whose `uid` no longer exists are dropped on load. */
  plots?: GrowPlot[];
  /** true once the crew name has been chosen; the terminal never offers to change it again. */
  nameLocked?: boolean;
  /* ── appended (Phase 9, version 3) ── */
  /** Books on 책장 shelves. Absent before v3; entries whose `uid` is not a placed 책장 are dropped on load. */
  books?: PlacedBook[];
  /** 도감: every book def id ever shelved (never removed). */
  bookDex?: string[];
}

/** One shelved book (Phase 9). Empty slots are simply absent. Rarity / skill come from `ctx.loot.getItemDef(defId)`. */
export interface PlacedBook {
  /** PlacedFurniture.uid of the 책장. */
  uid: string;
  /** 0 … BOOKS_PER_SHELF − 1. */
  slot: number;
  /** ItemDef.book must be set. */
  defId: string;
}

/** UI-facing view of one shelf slot. */
export interface BookSlotInfo {
  slot: number;
  defId: string | null;
  skill: SkillId | null;
  rarity: import('./types').Rarity | null;
  /** This book's weight (`BOOK_RARITY_MUL[rarity]`), 0 when empty. */
  weight: number;
}

export interface FacilityInfo {
  id: FacilityId;
  name: string;
  level: number;
  maxLevel: number;
  /** Cost of the next level, null at max. */
  nextCost: CraftIngredient[] | null;
  /** 한국어 reason the upgrade is blocked right now (generator too low, room not assigned, missing materials…), null = can upgrade. */
  blocked: string | null;
}

export interface HousingRef {
  /** Live state (do not mutate; use the methods). */
  readonly state: Readonly<ShipState>;

  /* ── housing mode (grid placement inside one room) ── */
  readonly housingMode: boolean;
  /** Room index being edited, or null. */
  readonly housingRoom: number | null;
  /** Furniture def chosen for placement (from storage), or null = cursor only. */
  readonly selectedFurniture: string | null;
  readonly selectedYaw: 0 | 1 | 2 | 3;
  /** Enter / leave housing mode for a room; emits `housing:modeChanged` (hub reacts with camera + cursor). */
  enterHousingMode(room: number): boolean;
  exitHousingMode(): void;
  selectFurniture(defId: string | null): void;
  /** Rotate the selection (or, with a uid, a placed piece) by 90°. */
  rotateSelection(): void;

  /* ── rooms ── */
  getRoom(index: number): RoomState;
  /** Assign a purpose. Refused (false) while the room still holds furniture that does not fit the new purpose, or for `lab` without a greenhouse. */
  setRoomPurpose(index: number, purpose: RoomPurpose): boolean;
  /** Room index of the first room with `purpose`, or −1. */
  findRoom(purpose: RoomPurpose): number;

  /* ── facilities ── */
  getFacilities(): FacilityInfo[];
  getFacility(id: FacilityId): FacilityInfo;
  /** Consume materials (bag + stash) and raise the level. False when blocked. */
  upgrade(id: FacilityId): boolean;
  /** Bench level of a placed bench of `kind` (highest if several), 0 = none placed. */
  getBenchLevel(kind: WorkbenchKind): number;
  /** Craft material cost multiplier from the workshop level (1 at level ≤ 1). Consumers: inventory crafting. */
  getCraftCostMul(): number;
  /** Skill XP multiplier from ship facilities (range level → gun_* skills). 1 when nothing applies. */
  getSkillGainMul(skill: SkillId): number;
  /** Stash grid from the storage level. inventory/ resizes its stash on `housing:stashSizeChanged`. */
  getStashSize(): { cols: number; rows: number };

  /* ── furniture ── */
  getFurnitureDef(id: string): FurnitureDef | undefined;
  getAllFurnitureDefs(): readonly FurnitureDef[];
  /** Defs allowed in a room of `purpose` ('any' included). */
  getFurnitureFor(purpose: RoomPurpose): readonly FurnitureDef[];
  getPlaced(room?: number): readonly PlacedFurniture[];
  getPlacedByUid(uid: string): PlacedFurniture | null;
  getStored(): readonly StoredFurniture[];
  canPlace(room: number, defId: string, x: number, y: number, yaw: 0 | 1 | 2 | 3, ignoreUid?: string): boolean;
  /** Place one stored piece (consumes a storage entry). Emits `housing:furniturePlaced`. */
  place(room: number, defId: string, x: number, y: number, yaw: 0 | 1 | 2 | 3): PlacedFurniture | null;
  move(uid: string, x: number, y: number, yaw: 0 | 1 | 2 | 3): boolean;
  /** Back to furniture storage (keeps its level). Emits `housing:furnitureRecovered`. */
  recover(uid: string): boolean;
  canCraftFurniture(defId: string): { ok: boolean; missing: CraftIngredient[] };
  /** Consume materials → one piece in furniture storage. */
  craftFurniture(defId: string): boolean;
  /** Upgrade a placed piece (benches). False when at max / materials missing / generator too low. */
  upgradeFurniture(uid: string): boolean;

  /* ── loadout presets (사격장) ── */
  getPresetCount(): number;
  getPresets(): readonly (LoadoutPreset | null)[];
  savePreset(index: number, preset: LoadoutPreset): boolean;
  deletePreset(index: number): boolean;
  /** Equip from bag + stash via `ctx.inventory.applyLoadout`; missing gear leaves the slot empty. Ship only. */
  applyPreset(index: number): { equipped: number; missing: string[] } | null;

  /* ── UI (DOM panels owned by housing/) ── */
  /**
   * Phase 8 UI pass: the standalone 방 메뉴 / 함선 시설 메뉴 are gone (rooms and facilities live in the Tab 함선 tab
   * and in 시설 관리). Both entry points are kept for the contract and now **redirect to 시설 관리** at that room.
   */
  openRoomMenu(room: number): void;
  openFacilityMenu(): void;
  openPresetMenu(): void;
  closeMenus(): void;
  readonly isMenuOpen: boolean;

  /** Persist now (also debounced after every change). */
  save(): void;

  /* ══ appended: Phase 8 (2026-09-06) ══════════════════════════════════════ */

  /* ── 함선 관리 mode (M in the ship) ── */
  /**
   * True while the player is managing the ship from the M screen: the same housing-mode camera / cursor, but entered
   * from anywhere in the personal ship (no "stand inside the room" gate) with the room list and the furniture bar
   * shown by ui/. `enterHousingMode` keeps its old room-local gate for the room console.
   */
  readonly shipManageMode: boolean;
  /** Enter 함선 관리 at `room` (default: the room the player is in, else the first non-empty room, else 0). */
  openShipManage(room?: number): boolean;
  /** Move the manage camera / edit target to another room. False while not in manage mode. */
  setManageRoom(room: number): boolean;
  /** Leave 함선 관리 (also leaves housing mode). */
  closeShipManage(): void;

  /* ── 온실 재배 ── */
  /** Plot states of one 재배층, always `GROW_PLOTS_PER_RACK` long. Empty array when `uid` is not a 재배층. */
  getPlots(uid: string): GrowPlotInfo[];
  /** Plant one seed from the bag or the stash (consumes 1). Returns a 한국어 reason on failure, null on success. */
  plantSeed(uid: string, slot: number, seedDefId: string): string | null;
  /** Harvest one ready plot into the bag (falls back to the stash in the ship). 한국어 reason on failure. */
  harvestPlot(uid: string, slot: number): string | null;
  /** Harvest every ready plot of the rack; returns how many were taken. */
  harvestAll(uid: string): number;
  /** Seed item defs the player currently owns (bag + stash), for the 재배 panel. */
  getOwnedSeeds(): { defId: string; qty: number }[];
  /** Open the 재배층 panel (`furn_grow_rack` interaction). */
  openGrowMenu(uid: string): void;

  /* ── 승무원 호출명 ── */
  /**
   * Mark the crew name as chosen for good (`ShipState.nameLocked`). hub/ calls it the first time the player sets a
   * name in the terminal; afterwards the terminal shows a read-only line instead of the input. Idempotent.
   */
  lockCrewName(): void;

  /* ── embedded 함선 view (the 함선 tab of the Tab screen) ── */
  /**
   * Render the ship-management screen (시설 업그레이드 + 방 목록) inside `host`, which the caller owns and empties.
   * The returned handle is the only way to refresh / tear it down; the folder keeps no other reference.
   */
  createShipView(host: HTMLElement): EmbeddedView;

  /* ══ appended: Phase 8 UI pass (2026-09-06) ══════════════════════════════ */

  /**
   * 한국어 reason `setRoomPurpose(index, purpose)` would refuse right now; null = allowed. ui/ renders the 시설 관리
   * purpose picker off this (a blocked purpose is shown disabled with the reason as its title), so the panel and the
   * system can never disagree about what is assignable.
   */
  purposeBlock(index: number, purpose: RoomPurpose): string | null;
  /**
   * appended (Phase 9 UI pass): materials a **시설 증축** to `purpose` consumes from bag + stash
   * (`ROOM_PURPOSE_BUILD_COST`; empty for 빈 방). `setRoomPurpose` spends them and 시설 제거 refunds them into the
   * 함선 창고, so the pickers render this as their cost chips.
   */
  purposeCost(purpose: RoomPurpose): readonly { defId: string; qty: number }[];

  /* ══ appended: Phase 9 — 서재 책장 (2026-09-06) ══════════════════════════ */
  /** Slots of one 책장, always BOOKS_PER_SHELF long; empty array when `uid` is not a placed 책장. */
  getBooks(uid: string): BookSlotInfo[];
  /** Shelve one book from the bag (then the stash) into `slot` (consumes 1). 한국어 reason on failure, null on success. Ship only. */
  placeBook(uid: string, slot: number, defId: string): string | null;
  /** Take the book in `slot` back into the bag (stash fallback). 한국어 reason on failure (e.g. 공간 없음), null on success. */
  takeBook(uid: string, slot: number): string | null;
  /** Book defs the player owns right now (bag + stash), for the 책장 panel picker. */
  getOwnedBooks(): { defId: string; qty: number }[];
  /** Skill-XP multiplier from every shelved book of `skill` on the ship (1 when none). Folded into `getSkillGainMul`. */
  getBookBonus(skill: SkillId): number;
  /** 도감: book def ids ever shelved. */
  getBookDex(): readonly string[];
  /** Open the 책장 panel (blocker `housing`, `ui:bookshelfToggled`). */
  openBookshelfMenu(uid: string): void;

  /* ══ appended: Phase 9 UI pass — 시설 제거 (2026-09-07) ═══════════════════ */
  /**
   * Materials that would be refunded by `removeRoomFacility(index)`: everything spent upgrading that room's facility
   * (level 1 comes free with the purpose, so a Lv.1 room refunds nothing). Empty for a room with no facility.
   * ui/ renders it as the cost chips of the 제거 confirmation.
   */
  facilityRefund(index: number): CraftIngredient[];
  /**
   * 시설 제거: hand room `index` back — every placed piece into furniture storage, every upgrade material into the
   * **함선 창고**, purpose → 빈 방. All-or-nothing: a 한국어 reason is returned (and nothing changes) when the stash
   * has no space or the rules refuse the room (the built-in 작업실, a 책장 whose books do not fit). null = removed.
   */
  removeRoomFacility(index: number): string | null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Furniture catalogue. Lives in the contract (like STRATAGEM_DEFS) because hub/ renders it, housing/ places it and
 * items/ prices it — all three must agree from the first commit. Costs are bag + stash materials (`mat_*` item ids;
 * `mat_cable` 전력 케이블 and `mat_circuit` 회로 기판 are new items owned by items/).
 * ──────────────────────────────────────────────────────────────────────────── */
const c = (defId: string, qty: number): CraftIngredient => ({ defId, qty });

export const FURNITURE_DEFS: readonly FurnitureDef[] = [
  /* 작업실 benches — upgradeable, each unlocks recipes (`CraftRecipe.bench` / `benchLevel`) and repairs its gear class */
  { id: 'furn_bench_gun', name: '총기 작업대', description: '총기 · 부착물 · 탄약을 제작하고 총기를 수리합니다.', room: 'workshop', cols: 4, rows: 2, height: 1.0,
    model: 'bench_gun', interaction: 'workbench_gun', craft: [c('mat_scrap', 8), c('mat_alloy', 2), c('mat_cable', 1)], maxLevel: 3,
    upgradeCost: [[c('mat_alloy', 6), c('mat_circuit', 1)], [c('mat_alloy', 10), c('mat_circuit', 3), c('mat_power_cell', 1)]], color: '#ffd27a' },
  { id: 'furn_bench_gear', name: '장비 작업대', description: '방탄복과 가방을 제작하고 수리합니다.', room: 'workshop', cols: 4, rows: 2, height: 1.0,
    model: 'bench_gear', interaction: 'workbench_gear', craft: [c('mat_scrap', 8), c('mat_alloy', 2), c('mat_cable', 1)], maxLevel: 3,
    upgradeCost: [[c('mat_alloy', 6), c('mat_circuit', 1)], [c('mat_alloy', 10), c('mat_circuit', 3), c('mat_power_cell', 1)]], color: '#9fb4ff' },
  { id: 'furn_bench_gadget', name: '가젯 작업대', description: '수류탄과 가젯을 제작합니다.', room: 'workshop', cols: 4, rows: 2, height: 1.0,
    model: 'bench_gadget', interaction: 'workbench_gadget', craft: [c('mat_scrap', 8), c('mat_alloy', 2), c('mat_cable', 1)], maxLevel: 3,
    upgradeCost: [[c('mat_alloy', 6), c('mat_circuit', 1)], [c('mat_alloy', 10), c('mat_circuit', 3), c('mat_power_cell', 1)]], color: '#8fe8ff' },
  { id: 'furn_bench_medical', name: '의학 작업대', description: '스팀과 회복 아이템을 조제합니다.', room: 'workshop', cols: 4, rows: 2, height: 1.0,
    model: 'bench_medical', interaction: 'workbench_medical', craft: [c('mat_scrap', 6), c('mat_alloy', 2), c('mat_bio_sample', 3)], maxLevel: 3,
    upgradeCost: [[c('mat_alloy', 4), c('mat_bio_sample', 6), c('mat_circuit', 1)], [c('mat_alloy', 8), c('mat_bio_sample', 10), c('mat_circuit', 3)]], color: '#6ee7a8' },
  /* 사격장 */
  /* Phase 8 UI pass: renamed 사격장 콘솔 → 관물대 — the only way to reach the loadout presets now that the
     시설 메뉴 (and its 프리셋 button) is gone. Build the 사격장, place a 관물대, set your loadouts on it. */
  { id: 'furn_range_console', name: '관물대', description: '로드아웃 프리셋을 저장하고 즉시 무장합니다. 사격장에 설치하세요.', room: 'range', cols: 2, rows: 1, height: 2.0,
    model: 'locker', interaction: 'range_console', craft: [c('mat_scrap', 6), c('mat_cable', 2), c('mat_circuit', 1)], maxLevel: 1, upgradeCost: [], color: '#7fd2ff' },
  { id: 'furn_target_lane', name: '표적 레인', description: '시뮬레이터 표적 레인 (장식).', room: 'range', cols: 2, rows: 6, height: 1.8,
    model: 'target_lane', interaction: 'none', craft: [c('mat_scrap', 6), c('mat_alloy', 1)], maxLevel: 1, upgradeCost: [], color: '#c8ccd2' },
  /* appended (Phase 7): 시뮬레이션 훈련장 entry */
  { id: 'furn_sim_hub', name: '시뮬레이션 허브', description: '시뮬레이션 훈련장에 입장합니다. 탄약과 내구도는 소모되지 않습니다.', room: 'range', cols: 2, rows: 2, height: 1.5,
    model: 'sim_hub', interaction: 'sim_hub', craft: [c('mat_scrap', 8), c('mat_cable', 2), c('mat_circuit', 2)], maxLevel: 1, upgradeCost: [], color: '#9fe8ff' },
  /* appended (Phase 8): the 정비 벤치 is no longer built into the cockpit — place it in the 작업실 */
  { id: 'furn_repair_bench', name: '정비 벤치', description: '무기 내구도를 재료로 수리합니다. 조종석에서 작업실로 옮겨졌습니다.', room: 'workshop', cols: 4, rows: 2, height: 1.0,
    model: 'repair_bench', interaction: 'repair_bench', craft: [c('mat_scrap', 6), c('mat_alloy', 1)], maxLevel: 1, upgradeCost: [], color: '#d7c39a' },
  /* appended (Phase 8): 온실 — up to GROW_RACK_STACK_LIMIT racks share one footprint, each its own 층 */
  { id: 'furn_grow_rack', name: '재배층', description: '씨앗을 심어 현실 시간에 맞춰 약초를 키웁니다. 같은 자리에 4층까지 쌓을 수 있습니다.', room: 'greenhouse', cols: 4, rows: 2, height: 0.8,
    model: 'grow_rack', interaction: 'grow_rack', craft: [c('mat_scrap', 5), c('mat_cable', 1), c('mat_bio_sample', 2)], maxLevel: 1, upgradeCost: [], color: '#7ee08a',
    stackLimit: 4 },
  /* appended (Phase 9): 서재 — books from raids go on the shelves, each raising its skill's XP gain */
  { id: 'furn_bookshelf', name: '책장', description: '레이드에서 주운 책을 꽂습니다. 꽂힌 책은 그 숙련의 상승량을 올리고 도감에 기록됩니다 (6권).', room: 'library', cols: 2, rows: 1, height: 2.0,
    model: 'bookshelf', interaction: 'bookshelf', craft: [c('mat_scrap', 6), c('mat_alloy', 1)], maxLevel: 1, upgradeCost: [], color: '#c9a77a' },
  /* 공용 장식 */
  { id: 'furn_locker', name: '사물함', description: '강철 사물함.', room: 'any', cols: 1, rows: 2, height: 2.0,
    model: 'locker', interaction: 'none', craft: [c('mat_scrap', 4)], maxLevel: 1, upgradeCost: [], color: '#b0b8c4' },
  { id: 'furn_table', name: '작업 테이블', description: '넓은 강철 테이블.', room: 'any', cols: 3, rows: 2, height: 0.85,
    model: 'table', interaction: 'none', craft: [c('mat_scrap', 5)], maxLevel: 1, upgradeCost: [], color: '#b0a58c' },
  { id: 'furn_shelf', name: '선반', description: '벽 선반.', room: 'any', cols: 2, rows: 1, height: 1.6,
    model: 'shelf', interaction: 'none', craft: [c('mat_scrap', 3)], maxLevel: 1, upgradeCost: [], color: '#b0a58c' },
  { id: 'furn_crate', name: '보급 상자', description: '장식용 보급 상자.', room: 'any', cols: 1, rows: 1, height: 0.7,
    model: 'crate', interaction: 'none', craft: [c('mat_scrap', 2)], maxLevel: 1, upgradeCost: [], color: '#d9b98a' },
  { id: 'furn_lamp', name: '스탠드 조명', description: '따뜻한 빛의 스탠드 (발광 재질, 조명 아님).', room: 'any', cols: 1, rows: 1, height: 1.7,
    model: 'lamp', interaction: 'none', craft: [c('mat_scrap', 2), c('mat_cable', 1)], maxLevel: 1, upgradeCost: [], color: '#ffe3a0' },
  { id: 'furn_plant', name: '화분', description: '작은 관엽 식물.', room: 'any', cols: 1, rows: 1, height: 1.1,
    model: 'plant', interaction: 'none', craft: [c('mat_scrap', 1), c('herb_bloodroot', 1)], maxLevel: 1, upgradeCost: [], color: '#7ee08a' },
  { id: 'furn_chair', name: '의자', description: '강철 의자.', room: 'any', cols: 1, rows: 1, height: 0.9,
    model: 'chair', interaction: 'none', craft: [c('mat_scrap', 2)], maxLevel: 1, upgradeCost: [], color: '#b0b8c4' },
  { id: 'furn_bunk', name: '침상', description: '2단 침상.', room: 'any', cols: 2, rows: 3, height: 1.6,
    model: 'bunk', interaction: 'none', craft: [c('mat_scrap', 6), c('mat_alloy', 1)], maxLevel: 1, upgradeCost: [], color: '#9fb4ff' },
];

export const FURNITURE_DEF_MAP: ReadonlyMap<string, FurnitureDef> = new Map(FURNITURE_DEFS.map((d) => [d.id, d]));

/** Bench kind of a furniture interaction (`workbench_gun` → 'gun'), else null. */
export function benchKindOf(interaction: FurnitureInteraction): WorkbenchKind | null {
  return interaction.startsWith('workbench_') ? (interaction.slice('workbench_'.length) as WorkbenchKind) : null;
}

/** Footprint after rotation: odd yaw swaps cols / rows. */
export function furnitureFootprint(def: FurnitureDef, yaw: 0 | 1 | 2 | 3): { cols: number; rows: number } {
  return yaw % 2 === 1 ? { cols: def.rows, rows: def.cols } : { cols: def.cols, rows: def.rows };
}
