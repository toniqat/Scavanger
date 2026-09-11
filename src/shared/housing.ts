import type { CraftIngredient } from './gear';
import { costLevels, csvRows, keyTable } from './data/tables';

/* 함선 꾸미기 수치의 원본: 가구는 `data/furniture.csv` + `data/furniture_upgrades.csv`,
 * 방 용도 증축 비용은 `data/room_purposes.csv`, 발전기 요구 레벨은 `data/tuning.csv` 다. */
const T = /* data/tuning.csv */ keyTable('tuning.csv');
import type { ImplantId } from './implants';
import type { SkillId } from './progression';
import type { EmbeddedView, SoilTag } from './types';

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
export const ROOM_PURPOSE_BUILD_COST: Readonly<Record<RoomPurpose, readonly { defId: string; qty: number }[]>> =
  Object.fromEntries(csvRows('room_purposes.csv').map((r) => [r.str('purpose'), r.costList('cost')])) as Record<RoomPurpose, { defId: string; qty: number }[]>;

/** Generator level a 시설 증축 needs (the same gate every facility upgrade sits behind). */
export const ROOM_PURPOSE_BUILD_GENERATOR_LEVEL = T.num('ROOM_PURPOSE_BUILD_GENERATOR_LEVEL');

/** Purposes with mechanics in this build; the rest are decoration-only. (Phase 8 appended `greenhouse`.) */
export const ROOM_PURPOSES_ACTIVE: readonly RoomPurpose[] = ['empty', 'workshop', 'range', 'greenhouse', 'library'];   // Phase 9 appended `library`

/**
 * @deprecated 2026-09-07 — **no longer enforced**. The Phase 8 UI pass gave every ship a built-in 작업실 locked to
 * room 1; a new ship now starts with ten empty rooms and no furniture, and the 작업실 is an ordinary purpose that
 * may be built in any room (one per ship, like the 사격장) for `ROOM_PURPOSE_BUILD_COST`. Kept only so the contract
 * stays append-only; nothing reads it any more.
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

/**
 * The 작업실 benches. **appended (2026-09-10): `'refine'` — 정제 작업대.**
 *
 * 상위 재료(합금 판 · 강화합금 잉곳 · 기계 부품 · 축전 모듈 · 제어 모듈 · 강화 직조포 · 복합 방탄섬유)는
 * 여기서만 만든다 — 현장 빠른제작이 없는 유일한 계열이고, 고등급 장비 레시피가 그 재료를 요구하므로
 * 정제 작업대가 후반 제작의 관문이다. 나머지 넷의 동작은 한 줄도 바뀌지 않는다.
 */
export type WorkbenchKind = 'gun' | 'gear' | 'gadget' | 'medical' | 'refine';
export const WORKBENCH_KINDS: readonly WorkbenchKind[] = ['gun', 'gear', 'gadget', 'medical', 'refine'];
export const WORKBENCH_LABEL_KO: Readonly<Record<WorkbenchKind, string>> = {
  gun: '총기 작업대', gear: '장비 작업대', gadget: '가젯 작업대', medical: '의학 작업대', refine: '정제 작업대',
};
/**
 * appended (2026-09-10): 작업대 글리프. 같은 글자가 `inventory/ui/labels`(제작 탭)와
 * `ui/hud/ShipManage`(가구 카드) **두 폴더에 복사돼** 있었다 — 한쪽만 고치면 같은 작업대가 두 화면에서
 * 다른 그림이 된다. CLAUDE.md 의 「같은 것을 두 폴더가 쓰면 `shared` 로 뽑는다」 그대로 여기가 원본이다.
 * 외부 에셋 금지 규약대로 아이콘은 유니코드 한 글자다.
 */
export const WORKBENCH_ICON: Readonly<Record<WorkbenchKind, string>> = {
  gun: '⚒', gear: '⛭', gadget: '⚙', medical: '✚', refine: '⌘',
};

/** Procedural furniture models hub/ knows how to build (no asset files). */
export type FurnitureModelKind =
  | 'bench_gun' | 'bench_gear' | 'bench_gadget' | 'bench_medical'
  | 'bench_refine'   // appended (2026-09-10): 정제 작업대 — 상위 재료 전용
  | 'range_console' | 'target_lane'
  | 'sim_hub'   // appended (Phase 7): 시뮬레이션 허브 — holo pedestal in the 사격장
  /* appended (Phase 8): 온실 재배층 (stackable grow rack) and the 정비 벤치 moved out of the cockpit */
  | 'grow_rack' | 'repair_bench'
  | 'bookshelf'   // appended (Phase 9): 서재 책장 — the builder reads the shelved count and fills the shelves
  | 'grow_station' // appended (온실 개편, 2026-09-11): 재배 스테이션 — the builder reads `level` and shows 1 / 2 / 3 재배층
  | 'locker' | 'table' | 'shelf' | 'crate' | 'lamp' | 'plant' | 'chair' | 'bunk';

/** What E does on a placed piece. */
export type FurnitureInteraction =
  | 'none'
  | 'workbench_gun' | 'workbench_gear' | 'workbench_gadget' | 'workbench_medical'  // → ctx.inventory.openBenchCraft(kind)
  | 'workbench_refine'                                                            // appended (2026-09-10) → 같은 길, kind 'refine'
  | 'range_console'                                                               // → ctx.housing.openPresetMenu()
  | 'sim_hub'                                                                     // appended (Phase 7) → hub starts / joins the 시뮬레이션 훈련장
  /* appended (Phase 8) */
  | 'grow_rack'                                                                   // → ctx.housing.openGrowMenu(uid): 씨앗 심기 / 수확
  | 'repair_bench'                                                                // → the 정비 벤치 repair menu (hub/WorkbenchMenu), no longer built into the cockpit
  /* appended (Phase 9) */
  | 'bookshelf'                                                                   // → ctx.housing.openBookshelfMenu(uid): 책 꽂기 / 빼기 / 도감
  /* appended (온실 개편, 2026-09-11) */
  | 'grow_station';                                                               // → ctx.housing.openGrowStation(uid): 토양 채우기 / 씨앗 심기 / 수확

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
  /* ── appended: 온실 개편 (2026-09-11) ── */
  /**
   * 은퇴한 가구. The def stays in `data/furniture.csv` (so an old save still knows what it cost) but it is gone from
   * every list: `getFurnitureFor` never returns it, 시설 관리 never offers it, and `ShipState.sanitize` hands any
   * placed / stored copy back as **materials in the 함선 창고**. Same treatment as `airstrike` / `secondary` — the
   * contract only ever grows. `furn_grow_rack` (옛 재배층) is the first one, retired by 재배 스테이션.
   */
  retired?: boolean;
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

/* ────────────────────────────────────────────────────────────────────────────
 * 온실 개편 — 재배 스테이션 (2026-09-11, 사용자 결정). The stackable 재배층 (`furn_grow_rack`, 4층 × 4칸) is retired;
 * one **재배 스테이션** (`furn_grow_station`) is an ordinary upgradeable piece whose level opens 재배층:
 *
 *   Lv.1 → 중앙 한 층      Lv.2 → 아래층이 열린다      Lv.3 → 윗층이 열린다
 *
 * A 층 has `GROW_SLOTS_PER_TIER` (3) 칸. **Tier ids are stable across upgrades** — 0 = 중앙, 1 = 아래, 2 = 위 — so
 * an upgrade never renumbers a growing crop. `GROW_TIER_DRAW_ORDER` is the order the panel draws them (위 → 중앙 → 아래).
 *
 * A 칸 has two steps, and the first is new: **토양을 먼저 채우고** (`fillSoil`) 그 위에 씨앗을 심는다 (`plantSeedAt`).
 * The soil carries a 속성 (`SoilTag`); matching the seed's `soilTag` shortens the grow time by `SOIL_MATCH_SPEEDUP`,
 * any other tag lengthens it by `SOIL_MISMATCH_PENALTY`. Soil is spent per harvest (`soilUsesLeft`, from
 * `ItemDef.soil.uses`); at 0 the 칸 empties back to 흙 없음.
 *
 * Growth is still wall-clock (`plantedAt` / `readyAt` epoch ms from `ctx.net.serverNow() ?? Date.now()`), so a crop
 * keeps growing offline, in a raid, or on another device — and a running timer never moves.
 * ──────────────────────────────────────────────────────────────────────────── */

/** 재배층 id. Stable across upgrades: 0 = 중앙 (Lv.1), 1 = 아래 (Lv.2), 2 = 위 (Lv.3). */
export type GrowTier = 0 | 1 | 2;

/** 칸 수 per 재배층. */
export const GROW_SLOTS_PER_TIER = T.num('GROW_SLOTS_PER_TIER');

/** Tiers a 재배 스테이션 of `level` has opened. Level is clamped to the def's `maxLevel` by the caller. */
export function growTiersForLevel(level: number): readonly GrowTier[] {
  if (level >= 3) return [0, 1, 2];
  if (level === 2) return [0, 1];
  return [0];
}

/** The order the 재배 화면 draws tiers, top row first: 위 · 중앙 · 아래. */
export const GROW_TIER_DRAW_ORDER: readonly GrowTier[] = [2, 0, 1];

export const GROW_TIER_LABEL_KO: Readonly<Record<GrowTier, string>> = { 0: '중앙 재배층', 1: '아래 재배층', 2: '윗 재배층' };

/**
 * One 재배층 칸 that has soil in it. A 칸 with no soil is simply absent from `ShipState.grows`, exactly like an
 * empty plot used to be. Planting fields (`seedDefId` / `plantedAt` / `readyAt`) come and go together — soil without
 * a seed is the normal "심을 준비가 된" state.
 */
export interface GrowSlot {
  /** `PlacedFurniture.uid` of the 재배 스테이션. */
  uid: string;
  tier: GrowTier;
  /** 0 … GROW_SLOTS_PER_TIER − 1. */
  slot: number;
  /** Soil item def id (`ItemDef.soil` must be set). */
  soilDefId: string;
  /** Harvests this soil still survives; the 칸 empties when it reaches 0. */
  soilUsesLeft: number;
  /** Seed item def id (`ItemDef.seed` must be set); absent = 흙만 채워져 있다. */
  seedDefId?: string;
  /** Epoch ms when it was planted. */
  plantedAt?: number;
  /** Epoch ms it may be harvested — fixed at planting time (soil 궁합 · 원예 숙련 포함). */
  readyAt?: number;
}

/** A 칸 as the 재배 화면 sees it. Every tier of the station reports `GROW_SLOTS_PER_TIER` of these, locked ones included. */
export interface GrowSlotInfo {
  tier: GrowTier;
  slot: number;
  /** true when this tier is not open at the station's current level (drawn dimmed with the required level). */
  locked: boolean;
  /** Station level that opens this tier (2 for 아래, 3 for 위). */
  unlockLevel: number;
  /** null = 흙이 없다 (drop soil here first). */
  soilDefId: string | null;
  soilTag: SoilTag | null;
  soilUsesLeft: number;
  /** null = 심을 준비가 된 흙 (or no soil at all). */
  seedDefId: string | null;
  /** Seed's wanted tag, for the "맞는 토양" line; null when nothing is planted. */
  seedTag: SoilTag | null;
  /** true when a seed is planted **and** its tag equals the soil's. false with a seed = 궁합 패널티 중. */
  matched: boolean;
  /** 0 … 1; −1 when nothing is planted. */
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
  /**
   * appended (2026-09-08): 임플란트 **아이템** def ids, in the order they should be equipped. Optional so a v3 save
   * and an older client keep working — `undefined` leaves the equipped implants exactly as they are, `[]` clears
   * them. The tactical implant above (`implant`) is the Q one and is unrelated.
   */
  implantItems?: readonly string[];
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
  /* ── appended (온실 개편, 2026-09-11, version 4) ── */
  /**
   * 재배 스테이션 칸. Replaces `plots` — a v3 save's `plots` are dropped on load together with the 재배층 furniture
   * they belonged to (사용자 결정: 옛 것 폐기, 재료는 함선 창고로 환불). Entries whose `uid` is not a placed
   * 재배 스테이션, or whose tier is above the station's level, are dropped by `sanitize`.
   */
  grows?: GrowSlot[];
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
  /**
   * 2026-09-10 (추가만): **자동 배치**가 고를 자리 — 화면 좌측 상단부터 가로줄을 먼저 채우고, 가구는 화면
   * 아래(월드 +X = yaw 1)를 향한다. 규칙과 좌표 유도는 `housing/Rules.autoPlaceSpot` 한 곳에 있다.
   * `null` = 이 방에 그 가구가 들어갈 자리가 없다. 손으로 놓는 경로는 이 질의를 쓰지 않는다.
   */
  findFreeSpot(room: number, defId: string): { x: number; y: number; yaw: 0 | 1 | 2 | 3 } | null;
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
  /** @deprecated 2026-09-11 (C-7) — call `openShipManage(room)`. Kept only because smokes assert the redirect. */
  openRoomMenu(room: number): void;
  /** @deprecated 2026-09-11 (C-7) — call `openShipManage()`. Kept only because smokes assert the redirect. */
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

  /* ── 온실 재배 ──
   * @deprecated 2026-09-11 (온실 개편) — the 재배층 furniture these belong to is retired. They stay in the contract
   * (추가만 하는 규약) and now always report "없는 재배층": `getPlots` → `[]`, the mutators → a 한국어 사유,
   * `harvestAll` → 0, `openGrowMenu` → nothing. New code calls the 재배 스테이션 API further down.
   */
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

  /* ══ appended: 온실 개편 — 재배 스테이션 (2026-09-11) ═══════════════════════ */

  /**
   * Every 칸 of one 재배 스테이션, **always `3 × GROW_SLOTS_PER_TIER` entries** in `GROW_TIER_DRAW_ORDER`, locked
   * tiers included (`locked: true` + `unlockLevel`) so the panel can draw the greyed-out rows the upgrade will open.
   * Empty array when `uid` is not a placed 재배 스테이션.
   */
  getGrowSlots(uid: string): GrowSlotInfo[];
  /**
   * Pour one soil item (bag → stash, `consumeDefAll`) into an empty 칸. `soilUsesLeft` starts at `ItemDef.soil.uses`.
   * 한국어 reason on failure (잠긴 층 · 이미 흙이 있다 · 토양이 아니다 · 갖고 있지 않다), null on success.
   */
  fillSoil(uid: string, tier: GrowTier, slot: number, soilDefId: string): string | null;
  /**
   * Scrape a 칸 back to 흙 없음. **The soil is not returned** — 남은 횟수가 있어도 버려진다 (한 번 부은 흙은 다시
   * 담지 않는다). Refused with a 한국어 사유 while something is planted in it; null on success.
   */
  clearSoil(uid: string, tier: GrowTier, slot: number): string | null;
  /**
   * Plant one seed (bag → stash, consumes 1) into a 칸 that already has soil. `readyAt` is fixed here from
   * `growHours × 궁합(SOIL_MATCH_SPEEDUP | SOIL_MISMATCH_PENALTY) × 원예(GROW_SKILL_SPEEDUP)`, so a later skill or
   * soil change never moves a running timer. 한국어 reason on failure, null on success.
   */
  plantSeedAt(uid: string, tier: GrowTier, slot: number, seedDefId: string): string | null;
  /**
   * Harvest one ripe 칸 into the bag (stash fallback). Spends one `soilUsesLeft`; the 칸 empties completely when
   * that hits 0, otherwise it goes back to 심을 준비가 된 흙. 한국어 reason on failure, null on success.
   */
  harvestAt(uid: string, tier: GrowTier, slot: number): string | null;
  /** Harvest every ripe 칸 of the station; returns how many were taken. */
  harvestAllStation(uid: string): number;
  /** Soil item defs the player owns right now (bag + stash), for the 재배 화면 picker. */
  getOwnedSoils(): { defId: string; qty: number }[];
  /** Open the 재배 화면 (`furn_grow_station` interaction): 좌 재배층 · 우 가방 + 함선 창고. */
  openGrowStation(uid: string): void;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Furniture catalogue. Lives in the contract (like STRATAGEM_DEFS) because hub/ renders it, housing/ places it and
 * items/ prices it — all three must agree from the first commit. Costs are bag + stash materials (`mat_*` item ids;
 * `mat_cable` 전력 케이블 and `mat_circuit` 회로 기판 are new items owned by items/).
 * ──────────────────────────────────────────────────────────────────────────── */
const c = (defId: string, qty: number): CraftIngredient => ({ defId, qty });

export const FURNITURE_DEFS: readonly FurnitureDef[] = csvRows('furniture.csv').map((r) => {
  const craft = r.costList('craft');
  const maxLevel = r.int('maxLevel', { min: 1 });
  return {
    id: r.str('id'),
    name: r.str('name'),
    description: r.str('description'),
    room: r.str('room') as FurnitureDef['room'],
    cols: r.int('cols', { min: 1 }),
    rows: r.int('rows', { min: 1 }),
    height: r.num('height', { min: 0 }),
    model: r.str('model') as FurnitureModelKind,
    interaction: r.str('interaction') as FurnitureInteraction,
    craft: craft.length ? craft : null,
    maxLevel,
    upgradeCost: maxLevel > 1 ? costLevels('furniture_upgrades.csv', 'id', r.str('id')) : [],
    color: r.str('color'),
    ...(r.has('stackLimit') ? { stackLimit: r.int('stackLimit', { min: 1 }) } : {}),
    ...(r.bool('retired') ? { retired: true } : {}),
  };
});

export const FURNITURE_DEF_MAP: ReadonlyMap<string, FurnitureDef> = new Map(FURNITURE_DEFS.map((d) => [d.id, d]));

/** Bench kind of a furniture interaction (`workbench_gun` → 'gun'), else null. */
export function benchKindOf(interaction: FurnitureInteraction): WorkbenchKind | null {
  return interaction.startsWith('workbench_') ? (interaction.slice('workbench_'.length) as WorkbenchKind) : null;
}

/** Footprint after rotation: odd yaw swaps cols / rows. */
export function furnitureFootprint(def: FurnitureDef, yaw: 0 | 1 | 2 | 3): { cols: number; rows: number } {
  return yaw % 2 === 1 ? { cols: def.rows, rows: def.cols } : { cols: def.cols, rows: def.rows };
}
