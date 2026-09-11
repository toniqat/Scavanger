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
 * yaw, recover → furniture storage), the 작업실 (4 upgradeable benches + repair) and the 시뮬레이션실 (옛 사격장 — loadout presets,
 * gun-skill gain bonus). The other 7 purposes can be assigned and decorated but have no mechanics yet.
 * ──────────────────────────────────────────────────────────────────────────── */

export type RoomPurpose =
  | 'empty'       // 빈 방
  | 'workshop'    // 작업실
  | 'range'       // 시뮬레이션실 (2026-09-12: 사격장에서 이름만 바뀌었다 — id 는 그대로)
  | 'gym'         // 헬스장
  | 'library'     // 서재
  | 'greenhouse'  // 온실
  | 'lab'         // 연구실 (requires greenhouse)
  | 'kitchen'     // 주방
  | 'mining'      // 암호화폐 채굴 시설 (2026-09-12: 채굴 시설에서 이름만 바뀌었다)
  | 'lounge';     // 휴식 공간

export const ROOM_PURPOSES: readonly RoomPurpose[] = [
  'empty', 'workshop', 'range', 'gym', 'library', 'greenhouse', 'lab', 'kitchen', 'mining', 'lounge',
];

export const ROOM_PURPOSE_LABEL_KO: Readonly<Record<RoomPurpose, string>> = {
  empty: '빈 방', workshop: '작업실', range: '시뮬레이션실', gym: '헬스장', library: '서재', greenhouse: '온실',
  lab: '연구실', kitchen: '주방', mining: '암호화폐 채굴 시설', lounge: '휴식 공간',
};

export const ROOM_PURPOSE_DESC_KO: Readonly<Record<RoomPurpose, string>> = {
  empty: '아직 용도가 정해지지 않은 방입니다.',
  workshop: '총기 · 장비 · 가젯 · 의학 작업대를 설치해 제작과 수리를 합니다.',
  range: '관물대로 로드아웃 프리셋을 관리하고, 시뮬레이션 허브로 훈련장에 들어가 사격 숙련 상승량을 높입니다.',
  gym: '운동 기구로 근력 · 지구력을 단련합니다. (다음 업데이트)',
  library: '책장에 레이드에서 주운 책을 꽂으면 그 책이 가르치는 숙련의 상승량이 늘어납니다. 꽂아 본 책은 도감에 남습니다.',
  greenhouse: '재배층을 설치하고 씨앗을 심어 현실 시간에 맞춰 약초를 재배합니다.',
  lab: '분석기로 미확인 표본을 해석하고, 추출기 · 조합대로 성분을 뽑아 준비물을 만듭니다. 온실이 먼저 필요합니다.',
  kitchen: '조리대로 작물과 배양 산물을 요리하고, 식탁에서 먹어 다음 레이드 버프를 얻습니다. 온실이 먼저 필요합니다.',
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
export const ROOM_PURPOSES_ACTIVE: readonly RoomPurpose[] = ['empty', 'workshop', 'range', 'greenhouse', 'library', 'lab', 'kitchen'];   // Phase 9 appended `library`; 2026-09-11 appended `lab` (A-12 · A-13) then `kitchen` (A-3c)

/**
 * @deprecated 2026-09-07 — **no longer enforced**. The Phase 8 UI pass gave every ship a built-in 작업실 locked to
 * room 1; a new ship now starts with ten empty rooms and no furniture, and the 작업실 is an ordinary purpose that
 * may be built in any room (one per ship, like every purpose since 2026-09-12) for `ROOM_PURPOSE_BUILD_COST`. Kept only so the contract
 * stays append-only; nothing reads it any more.
 */
export const WORKSHOP_ROOM_INDEX = 0;

/**
 * Upgradeable facilities that are not furniture.
 * **2026-09-12 (사용자 결정 — 방 시설 레벨 제거):** only `generator` / `storage` still have levels. `workshop` /
 * `range` stay in the union (contract is append-only; `getFacility('range')` still answers "is there such a room")
 * but their `maxLevel` is 1 and `upgrade()` refuses them — upgrades live on the furniture inside the room now
 * (작업대 · 관물대 = 프리셋 슬롯 · 시뮬레이션 허브 = 사격 숙련 상승).
 */
export type FacilityId = 'generator' | 'storage' | 'workshop' | 'range';

export const FACILITY_LABEL_KO: Readonly<Record<FacilityId, string>> = {
  generator: '발전기', storage: '창고', workshop: '작업실', range: '시뮬레이션실',
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
export type WorkbenchKind = 'gun' | 'gear' | 'gadget' | 'medical' | 'refine' | 'extract' | 'mixer' | 'cook' | 'print';
export const WORKBENCH_KINDS: readonly WorkbenchKind[] = ['gun', 'gear', 'gadget', 'medical', 'refine', 'extract', 'mixer', 'cook', 'print'];
export const WORKBENCH_LABEL_KO: Readonly<Record<WorkbenchKind, string>> = {
  gun: '총기 작업대', gear: '장비 작업대', gadget: '가젯 작업대', medical: '의학 작업대', refine: '정제 작업대',
  extract: '추출기', mixer: '조합대',
  /* appended (A-3c · A-15, 2026-09-11): 조리대는 주방, 프린터는 연구실 */
  cook: '조리대', print: '3D 프린터',
};
/**
 * appended (2026-09-10): 작업대 글리프. 같은 글자가 `inventory/ui/labels`(제작 탭)와
 * `ui/hud/ShipManage`(가구 카드) **두 폴더에 복사돼** 있었다 — 한쪽만 고치면 같은 작업대가 두 화면에서
 * 다른 그림이 된다. CLAUDE.md 의 「같은 것을 두 폴더가 쓰면 `shared` 로 뽑는다」 그대로 여기가 원본이다.
 * 외부 에셋 금지 규약대로 아이콘은 유니코드 한 글자다.
 */
export const WORKBENCH_ICON: Readonly<Record<WorkbenchKind, string>> = {
  gun: '⚒', gear: '⛭', gadget: '⚙', medical: '✚', refine: '⌘',
  /* appended (연구실 A-13, 2026-09-11): 추출기 · 조합대는 연구실 방(`lab`)에 놓이는 작업대다 */
  extract: '⧗', mixer: '⚛',
  /* appended (A-3c · A-15, 2026-09-11): 조리대는 주방(`kitchen`), 프린터는 연구실(`lab`) */
  cook: '♨', print: '⎔',
};

/** Procedural furniture models hub/ knows how to build (no asset files). */
export type FurnitureModelKind =
  | 'bench_gun' | 'bench_gear' | 'bench_gadget' | 'bench_medical'
  | 'bench_refine'   // appended (2026-09-10): 정제 작업대 — 상위 재료 전용
  | 'range_console' | 'target_lane'
  | 'sim_hub'   // appended (Phase 7): 시뮬레이션 허브 — holo pedestal in the 시뮬레이션실
  /* appended (Phase 8): 온실 재배층 (stackable grow rack) and the 정비 벤치 moved out of the cockpit */
  | 'grow_rack' | 'repair_bench'
  | 'bookshelf'   // appended (Phase 9): 서재 책장 — the builder reads the shelved count and fills the shelves
  | 'grow_station' // appended (온실 개편, 2026-09-11): 재배 스테이션 — the builder reads `level` and shows 1 / 2 / 3 재배층
  /* appended (연구실, 2026-09-11): 분석기는 `level` 만큼 해석 칸의 불이 켜진다; 추출기 · 조합대는 평범한 작업대 몸체 */
  | 'analyzer' | 'bench_extract' | 'bench_mixer'
  /* appended (주방 · 배양조 · 프린터, 2026-09-11): 배양조는 `level` 만큼 배양관이 켜진다 (분석기와 같은 방식) */
  | 'bench_cook' | 'dining_table' | 'culture_tank' | 'bench_print'
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
  | 'grow_station'                                                                // → ctx.housing.openGrowStation(uid): 토양 채우기 / 씨앗 심기 / 수확
  /* appended (연구실, 2026-09-11) */
  | 'workbench_extract' | 'workbench_mixer'                                       // → 같은 길, kind 'extract' / 'mixer' (benchKindOf 가 접두사로 푼다)
  | 'analyzer'                                                                    // → ctx.housing.openAnalyzer(uid): 표본 넣기 / 해석 회수 / 해석 도감
  /* appended (주방 · 배양조 · 프린터, 2026-09-11) */
  | 'workbench_cook' | 'workbench_print'                                          // → 같은 길, kind 'cook' / 'print'
  | 'dining_table'                                                                // → ctx.housing.openDiningTable(uid): 먹기 / (공유 함선이면) 분대에 차리기
  | 'culture_tank';                                                               // → ctx.housing.openCultureTank(uid): 배지 붓기 / 세포주 넣기 / 수확

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

/**
 * 2026-09-12 (appended): where a 수확물 · 해석 산출물 · 배양 산물 goes. `'bag-first'` is the old behaviour and the
 * default of every harvest method (가방 → 함선 창고). The station screens pass `'stash-first'` on a double-click and
 * `'bag'` / `'stash'` when the product was dragged onto that grid — a named grid never falls back to the other one.
 */
export type HarvestDestination = 'bag-first' | 'stash-first' | 'bag' | 'stash';

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

/** Loadout preset (시뮬레이션실의 관물대): def ids; null = leave the slot as it is. */
export interface LoadoutPreset {
  name: string;
  primary: string | null;
  primary2: string | null;
  secondary: string | null;
  bag: string | null;
  armor: string | null;
  /**
   * appended (2026-09-11, A-15): 주머니 def id. optional 인 이유는 `implantItems` 와 같다 — 저장된 v3 프리셋에는
   * 이 칸이 없고, `undefined` 는 「주머니는 건드리지 않는다」, `null` 은 「비운다」 이다.
   */
  pouch?: string | null;
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

  /* ── loadout presets (관물대 — slot count = the placed 관물대's level since 2026-09-12) ── */
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
   * 2026-09-12 (appended optional): `discardCrop` true throws the planted crop away too (흙구멍 우클릭 「작물 버리고 흙 비우기」).
   */
  clearSoil(uid: string, tier: GrowTier, slot: number, discardCrop?: boolean): string | null;
  /**
   * Plant one seed (bag → stash, consumes 1) into a 칸 that already has soil. `readyAt` is fixed here from
   * `growHours × 궁합(SOIL_MATCH_SPEEDUP | SOIL_MISMATCH_PENALTY) × 원예(GROW_SKILL_SPEEDUP)`, so a later skill or
   * soil change never moves a running timer. 한국어 reason on failure, null on success.
   */
  plantSeedAt(uid: string, tier: GrowTier, slot: number, seedDefId: string): string | null;
  /**
   * Harvest one ripe 칸 into the bag (stash fallback). Spends one `soilUsesLeft`; the 칸 empties completely when
   * that hits 0, otherwise it goes back to 심을 준비가 된 흙. 한국어 reason on failure, null on success.
   * 2026-09-12 (appended optional): `dest` picks the grid (`HarvestDestination`, default `'bag-first'`).
   */
  harvestAt(uid: string, tier: GrowTier, slot: number, dest?: HarvestDestination): string | null;
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

/* ────────────────────────────────────────────────────────────────────────────
 * 연구실 — 분석기 (A-12, 2026-09-11, 사용자 결정: 현실 시간 대기)
 *
 * 분석기(`furn_analyzer`)는 재배 스테이션과 **같은 모양의 스테이션**이다: 레벨이 자리를 연다.
 * 레벨 n 이면 `ANALYZER_SLOTS_PER_LEVEL × n` 칸이 열리고, 화면은 언제나 `ANALYZER_MAX_SLOTS` 칸을 그린다
 * (잠긴 칸은 `locked: true` + `unlockLevel`). 칸 번호는 강화해도 밀리지 않는다 — 돌아가던 해석이 옮겨 가면 안 된다.
 *
 * 해석 시간은 **시작하는 순간** `readyAt` 에 확정된다 (온실의 `plantedAt`/`readyAt` 와 같은 규약):
 *
 *     analyzeHours × (1 − ANALYZE_DEX_SPEEDUP × 도감진척) × (도감에 이미 있으면 1 − ANALYZE_KNOWN_SPEEDUP)
 *
 * 「도감을 채울수록 해석이 빨라진다」가 첫 항, 「아는 것을 다시 보는 건 빠르다」가 둘째 항이다.
 * 도감(`ShipState.sampleDex`)은 `bookDex` 와 같은 append-only 기록이고, 해석을 **회수**할 때 채워진다.
 * ──────────────────────────────────────────────────────────────────────────── */

/** 분석기 레벨 한 단계가 여는 해석 칸 수 (`data/tuning.csv`). */
export const ANALYZER_SLOTS_PER_LEVEL = T.num('ANALYZER_SLOTS_PER_LEVEL');
/** 최대 레벨(3)에서의 칸 수 — 패널은 잠긴 칸을 포함해 언제나 이만큼 그린다. */
export const ANALYZER_MAX_SLOTS = 3 * ANALYZER_SLOTS_PER_LEVEL;

/** `level` 의 분석기가 연 칸 수. 레벨은 부르는 쪽이 def 의 `maxLevel` 로 이미 잘라 둔다. */
export function analyzerSlotsForLevel(level: number): number {
  return Math.max(0, Math.min(3, Math.floor(level))) * ANALYZER_SLOTS_PER_LEVEL;
}

/** `slot` 을 여는 분석기 레벨 (1 … 3). `analyzerSlotsForLevel` 에서 유도한다 — 2 · 3 을 코드에 적지 않는다. */
export function analyzerSlotUnlockLevel(slot: number): number {
  for (let lv = 1; lv <= 3; lv++) if (slot < analyzerSlotsForLevel(lv)) return lv;
  return 3;
}

/** 해석 중인 칸 하나. 비어 있는 칸은 `ShipState.analyses` 에 아예 없다 (온실의 `grows` 와 같은 규약). */
export interface AnalysisSlot {
  /** 분석기 `PlacedFurniture.uid`. */
  uid: string;
  /** 0 … ANALYZER_MAX_SLOTS − 1. */
  slot: number;
  /** 표본 item def id (`ItemDef.sample` 이 있어야 한다). */
  sampleDefId: string;
  /** 넣은 시각 (epoch ms). */
  startedAt: number;
  /** 회수할 수 있게 되는 시각 (epoch ms) — 시작할 때 확정된다. */
  readyAt: number;
}

/** 분석 화면이 보는 칸 하나. 분석기는 언제나 `ANALYZER_MAX_SLOTS` 개를 보고하며 잠긴 칸도 들어 있다. */
export interface AnalysisSlotInfo {
  slot: number;
  /** 지금 레벨이 열지 않은 칸 (딤드 + 필요 레벨 표시). */
  locked: boolean;
  /** 이 칸을 여는 분석기 레벨. */
  unlockLevel: number;
  /** null = 빈 칸. */
  sampleDefId: string | null;
  /** 0 … 1; 비어 있으면 −1. */
  progress: number;
  /** 남은 초. 다 됐거나 비었으면 0. */
  remainingS: number;
  ready: boolean;
  /** 회수했을 때 받을 것 (패널의 산출물 칩). */
  rewardDefId: string | null;
  rewardQty: number;
  /** 아직 도감에 없는 표본 — 회수하면 도감이 한 칸 차고 `SampleDef.firstDefId` 보너스가 붙는다. */
  firstTime: boolean;
}

/**
 * 실용 가구인가 — E 로 뭔가를 하는 가구(작업대 · 스테이션 · 책장 · 관물대 · 시뮬 허브). B-13 의 기준이다:
 * 같은 실용 가구를 **이미 가지고 있으면 제작이 잠기고**(`HousingRef.furnitureCraftBlock`) 제작 목록의 맨 아래로
 * 내려간다 (사용자 결정 2026-09-11 — 벤치 레벨은 가장 높은 하나만 세므로 두 번째를 만들 이유가 없다).
 * 장식 가구(`interaction: 'none'`)는 얼마든지 만든다.
 */
export function isUtilityFurniture(def: FurnitureDef): boolean {
  return def.interaction !== 'none';
}

export interface ShipState {
  /* ── appended (연구실, 2026-09-11, version 5) ── */
  /**
   * 분석기 해석 칸. `uid` 가 배치된 분석기가 아니거나 칸이 그 분석기의 레벨 밖이면 `sanitize` 가 버린다
   * (표본은 돌아오지 않는다 — 온실의 흙과 같은 취급).
   */
  analyses?: AnalysisSlot[];
  /** 해석 도감: 한 번이라도 **회수**한 표본 def id 전부 (지워지지 않는다). `bookDex` 와 같은 모양이다. */
  sampleDex?: string[];
}

export interface HousingRef {
  /* ══ appended: 연구실 — 분석기 (A-12, 2026-09-11) ═══════════════════════════ */

  /**
   * 분석기 한 대의 칸 전부, **언제나 `ANALYZER_MAX_SLOTS` 개**를 칸 번호 순으로. 잠긴 칸도 `locked: true` +
   * `unlockLevel` 로 들어 있어 패널이 「강화하면 열린다」를 그릴 수 있다. `uid` 가 배치된 분석기가 아니면 빈 배열.
   */
  getAnalyses(uid: string): AnalysisSlotInfo[];
  /**
   * 표본 하나를 (가방 → 함선 창고 순으로) 넣고 해석을 시작한다. `readyAt` 이 여기서 확정되므로 이후 도감이
   * 더 차도 **돌아가던 해석은 빨라지지 않는다**. 한국어 사유 / 성공하면 null.
   */
  startAnalysis(uid: string, slot: number, sampleDefId: string): string | null;
  /**
   * 해석을 중단한다. **표본은 돌아오지 않는다** (부은 흙과 같다). 한국어 사유 / null.
   */
  cancelAnalysis(uid: string, slot: number): string | null;
  /**
   * 끝난 해석을 회수한다 — 산출물을 가방(없으면 함선 창고)에 넣고, 처음 보는 표본이면 도감에 적고
   * `SampleDef.firstDefId` 보너스를 얹는다. 한국어 사유 / null.
   * 2026-09-12 (추가 인자): `dest` 로 넣을 격자를 고른다 (`HarvestDestination`, 기본 `'bag-first'`).
   */
  collectAnalysis(uid: string, slot: number, dest?: HarvestDestination): string | null;
  /** 끝난 해석을 전부 회수하고 몇 개를 받았는지 돌려준다. */
  collectAllAnalyses(uid: string): number;
  /** 지금 갖고 있는 표본 (가방 + 함선 창고) — 분석 화면의 목록. */
  getOwnedSamples(): { defId: string; qty: number }[];
  /** 해석 도감: 한 번이라도 회수한 표본 def id. */
  getSampleDex(): readonly string[];
  /**
   * 도감 진척 0 … 1 (아는 표본 수 ÷ 전체 표본 종류 수). 해석 시간이 `ANALYZE_DEX_SPEEDUP × 이 값`만큼 줄어든다 —
   * 패널이 「해석 속도 +n %」 한 줄로 보여 준다.
   */
  getSampleDexRatio(): number;
  /** 분석 화면을 연다 (`analyzer` interaction): 좌 해석 칸 · 우 가방 + 함선 창고 + 도감. */
  openAnalyzer(uid: string): void;

  /* ══ appended: B-13 — 배치된 가구 강화 (2026-09-11) ══════════════════════════
   * `upgradeFurniture` 는 Phase 8 부터 있었지만 **부르는 곳이 없었다** — 작업대 Lv.2–3 이 플레이로 도달 불가였다.
   * 시설 관리의 클릭 인스펙터(사용자 결정)가 이 셋을 읽어 레벨 · 다음 비용 · 거절 사유를 그린다. */

  /** 지금 `upgradeFurniture(uid)` 가 거절할 한국어 사유, null = 강화할 수 있다. (시스템에만 있던 것을 계약으로) */
  furnitureUpgradeBlock(uid: string): string | null;
  /** 이 조각의 **다음 레벨** 비용. 최대 레벨이거나 배치된 조각이 아니면 null. */
  furnitureUpgradeCost(uid: string): CraftIngredient[] | null;
  /**
   * 지금 이 가구를 **제작**할 수 없는 한국어 사유, null = 만들 수 있다. 재료 부족과 별개로, 이미 가지고 있는
   * 실용 가구(`isUtilityFurniture`, 배치 + 가구 창고 합산)는 여기서 잠긴다 — 시설 관리가 그 카드를 딤드로
   * 그리고 목록 맨 아래로 내린다 (사용자 결정 2026-09-11).
   */
  furnitureCraftBlock(defId: string): string | null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 온실 — 배양조 (A-14, 2026-09-11, 사용자 결정: 온실 배치 · 현실 시간 대기)
 *
 * 배양조(`furn_culture_tank`)는 재배 스테이션 · 분석기와 **같은 모양의 스테이션**이다: 레벨이 칸을 연다.
 * 레벨 n 이면 `CULTURE_SLOTS_PER_LEVEL × n` 칸이 열리고 화면은 언제나 `CULTURE_MAX_SLOTS` 칸을 그린다
 * (잠긴 칸은 `locked: true` + `unlockLevel`). 칸 번호는 강화해도 밀리지 않는다.
 *
 * 칸은 **두 단계**다 — 온실의 「흙 먼저, 씨앗 나중」 그대로:
 *   ① `fillMedium` 으로 영양 배지(`ItemDef.medium`, 추출기 산물)를 붓는다.
 *   ② `insertStrain` 으로 세포주 · 균주(`ItemDef.strain`, 분석기 해석 산물)를 넣는다.
 * 배지는 **수확마다 1회** 닳고(`mediumUsesLeft`) 0 이면 칸이 완전히 빈다. 토양의 태그 매칭과 달리 배지는
 * **등급 하나**이고(`MediumDef.speedMul`), 배양 시간은 넣는 순간 `readyAt` 에 확정된다.
 * ──────────────────────────────────────────────────────────────────────────── */

/** 배양조 레벨 한 단계가 여는 배양 칸 수 (`data/tuning.csv`). */
export const CULTURE_SLOTS_PER_LEVEL = T.num('CULTURE_SLOTS_PER_LEVEL');
/** 최대 레벨(3)에서의 칸 수 — 패널은 잠긴 칸을 포함해 언제나 이만큼 그린다. */
export const CULTURE_MAX_SLOTS = 3 * CULTURE_SLOTS_PER_LEVEL;

/** `level` 의 배양조가 연 칸 수. 레벨은 부르는 쪽이 def 의 `maxLevel` 로 이미 잘라 둔다. */
export function cultureSlotsForLevel(level: number): number {
  return Math.max(0, Math.min(3, Math.floor(level))) * CULTURE_SLOTS_PER_LEVEL;
}

/** `slot` 을 여는 배양조 레벨 (1 … 3). `cultureSlotsForLevel` 에서 유도한다 — 2 · 3 을 코드에 적지 않는다. */
export function cultureSlotUnlockLevel(slot: number): number {
  for (let lv = 1; lv <= 3; lv++) if (slot < cultureSlotsForLevel(lv)) return lv;
  return 3;
}

/** 배지가 들어 있는 배양 칸 하나. 배지가 없는 칸은 `ShipState.cultures` 에 아예 없다 (온실의 `grows` 와 같은 규약). */
export interface CultureSlot {
  /** 배양조 `PlacedFurniture.uid`. */
  uid: string;
  /** 0 … CULTURE_MAX_SLOTS − 1. */
  slot: number;
  /** 영양 배지 item def id (`ItemDef.medium` 이 있어야 한다). */
  mediumDefId: string;
  /** 이 배지가 아직 버티는 수확 횟수; 0 이 되면 칸이 빈다. */
  mediumUsesLeft: number;
  /** 세포주 item def id (`ItemDef.strain` 이 있어야 한다); 없으면 = 배지만 채워져 있다. */
  strainDefId?: string;
  startedAt?: number;
  /** 수확할 수 있게 되는 시각 (epoch ms) — 넣을 때 확정된다. */
  readyAt?: number;
}

/** 배양 화면이 보는 칸 하나. 배양조는 언제나 `CULTURE_MAX_SLOTS` 개를 보고하며 잠긴 칸도 들어 있다. */
export interface CultureSlotInfo {
  slot: number;
  locked: boolean;
  unlockLevel: number;
  /** null = 배지가 없다 (여기 배지를 먼저 부어야 한다). */
  mediumDefId: string | null;
  mediumUsesLeft: number;
  /** 배지 등급이 깎아 주는 비율을 패널이 「배양 속도 +n %」로 보여 준다. */
  mediumSpeedMul: number;
  /** null = 넣을 준비가 된 배지 (또는 배지 자체가 없다). */
  strainDefId: string | null;
  /** 0 … 1; 비어 있으면 −1. */
  progress: number;
  remainingS: number;
  ready: boolean;
  yieldDefId: string | null;
  yieldQty: number;
}

export interface ShipState {
  /* ── appended (배양조 A-14, 2026-09-11, version 6) ── */
  /**
   * 배양조 칸. `uid` 가 배치된 배양조가 아니거나 칸이 그 배양조의 레벨 밖이면 `sanitize` 가 버린다
   * (배지 · 세포주는 돌아오지 않는다 — 온실의 흙과 같은 취급). v5 → v6 은 없던 필드가 생기는 것뿐이라
   * 마이그레이션 · 환불 경로가 없다.
   */
  cultures?: CultureSlot[];
}

export interface HousingRef {
  /* ══ appended: 온실 — 배양조 (A-14, 2026-09-11) ═════════════════════════════ */

  /**
   * 배양조 한 대의 칸 전부, **언제나 `CULTURE_MAX_SLOTS` 개**를 칸 번호 순으로. 잠긴 칸도 들어 있다.
   * `uid` 가 배치된 배양조가 아니면 빈 배열.
   */
  getCultureSlots(uid: string): CultureSlotInfo[];
  /** 영양 배지 하나를 (가방 → 함선 창고) 빈 칸에 붓는다. 한국어 사유 / null. */
  fillMedium(uid: string, slot: number, mediumDefId: string): string | null;
  /**
   * 칸을 배지 없음으로 되돌린다. **배지는 돌아오지 않는다** (부은 흙과 같다). 배양 중이면 거절.
   * 2026-09-12 (추가 인자): `discardStrain` true 면 배양 중인 세포주도 함께 버린다 (우클릭 메뉴).
   */
  clearMedium(uid: string, slot: number, discardStrain?: boolean): string | null;
  /** 세포주 하나를 배지가 있는 칸에 넣는다. `readyAt` 이 여기서 확정된다. 한국어 사유 / null. */
  insertStrain(uid: string, slot: number, strainDefId: string): string | null;
  /**
   * 다 된 칸 하나를 수확한다 (가방, 없으면 함선 창고). 배지를 1회 쓰고, 0 이 되면 칸이 완전히 빈다.
   * 아니면 「넣을 준비가 된 배지」로 돌아간다. 한국어 사유 / null.
   * 2026-09-12 (추가 인자): `dest` 로 넣을 격자를 고른다 (`HarvestDestination`, 기본 `'bag-first'`).
   */
  harvestCulture(uid: string, slot: number, dest?: HarvestDestination): string | null;
  /** 다 된 칸 전부를 수확하고 몇 개를 받았는지 돌려준다. */
  harvestAllCultures(uid: string): number;
  /** 지금 갖고 있는 영양 배지 (가방 + 함선 창고) — 배양 화면의 목록. */
  getOwnedMediums(): { defId: string; qty: number }[];
  /** 지금 갖고 있는 세포주 · 균주 (가방 + 함선 창고). */
  getOwnedStrains(): { defId: string; qty: number }[];
  /** 배양 화면을 연다 (`culture_tank` interaction): 좌 배양 칸 · 우 가방 + 함선 창고. */
  openCultureTank(uid: string): void;

  /* ══ appended: 주방 — 식탁 (A-3c, 2026-09-11) ═══════════════════════════════ */

  /**
   * 식사 화면을 연다 — 좌 = 지금 실린 식사 + 그 버프 한 줄, 우 = 가진 요리 + 가방/창고.
   *
   * `uid` 가 배치된 식탁 가구면 개인 함선의 식탁이고, **`null` 이면 공유 함선의 고정 식탁**이다 (가구가 아니라
   * hub 가 심어 둔 상호작용 지점이라 uid 가 없다). 공유 함선에서만 `분대에 차리기` 버튼이 보인다 —
   * 요리 **1개**를 소모하고 분대 전원이 같은 식사를 받는다 (사용자 결정).
   */
  openDiningTable(uid: string | null): void;
}
