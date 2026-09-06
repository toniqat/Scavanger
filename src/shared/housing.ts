import type { CraftIngredient } from './gear';
import type { ImplantId } from './implants';
import type { SkillId } from './progression';

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
  library: '책장에 책을 꽂아 상시 효과를 받습니다. (다음 업데이트)',
  greenhouse: '스마트팜 층 스테이션에서 약초를 재배합니다. (다음 업데이트)',
  lab: '배양기와 생체 프린터로 토양 · 씨앗 · 배양고기를 연구합니다. 온실이 먼저 필요합니다. (다음 업데이트)',
  kitchen: '요리로 다음 레이드 버프를 만듭니다. (다음 업데이트)',
  mining: '그래픽카드로 암호화폐를 채굴합니다. (다음 업데이트)',
  lounge: 'TV · 스피커로 비디오와 Vinyl 을 재생합니다. (다음 업데이트)',
};

/** Purposes with mechanics in this build; the rest are decoration-only. */
export const ROOM_PURPOSES_ACTIVE: readonly RoomPurpose[] = ['empty', 'workshop', 'range'];

/** Upgradeable facilities that are not furniture. `workshop` / `range` levels belong to the room of that purpose. */
export type FacilityId = 'generator' | 'storage' | 'workshop' | 'range';

export const FACILITY_LABEL_KO: Readonly<Record<FacilityId, string>> = {
  generator: '발전기', storage: '창고', workshop: '작업실', range: '사격장',
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
  | 'locker' | 'table' | 'shelf' | 'crate' | 'lamp' | 'plant' | 'chair' | 'bunk';

/** What E does on a placed piece. */
export type FurnitureInteraction =
  | 'none'
  | 'workbench_gun' | 'workbench_gear' | 'workbench_gadget' | 'workbench_medical'  // → ctx.inventory.openBenchCraft(kind)
  | 'range_console'                                                               // → ctx.housing.openPresetMenu()
  | 'sim_hub';                                                                    // appended (Phase 7) → hub starts / joins the 시뮬레이션 훈련장

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
  openRoomMenu(room: number): void;
  openFacilityMenu(): void;
  openPresetMenu(): void;
  closeMenus(): void;
  readonly isMenuOpen: boolean;

  /** Persist now (also debounced after every change). */
  save(): void;
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
  { id: 'furn_range_console', name: '사격장 콘솔', description: '로드아웃 프리셋을 저장하고 즉시 무장합니다.', room: 'range', cols: 2, rows: 2, height: 1.3,
    model: 'range_console', interaction: 'range_console', craft: [c('mat_scrap', 6), c('mat_cable', 2), c('mat_circuit', 1)], maxLevel: 1, upgradeCost: [], color: '#7fd2ff' },
  { id: 'furn_target_lane', name: '표적 레인', description: '시뮬레이터 표적 레인 (장식).', room: 'range', cols: 2, rows: 6, height: 1.8,
    model: 'target_lane', interaction: 'none', craft: [c('mat_scrap', 6), c('mat_alloy', 1)], maxLevel: 1, upgradeCost: [], color: '#c8ccd2' },
  /* appended (Phase 7): 시뮬레이션 훈련장 entry */
  { id: 'furn_sim_hub', name: '시뮬레이션 허브', description: '시뮬레이션 훈련장에 입장합니다. 탄약과 내구도는 소모되지 않습니다.', room: 'range', cols: 2, rows: 2, height: 1.5,
    model: 'sim_hub', interaction: 'sim_hub', craft: [c('mat_scrap', 8), c('mat_cable', 2), c('mat_circuit', 2)], maxLevel: 1, upgradeCost: [], color: '#9fe8ff' },
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
