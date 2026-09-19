import type { CraftIngredient } from './gear';
import { costLevels, csvRows, keyTable, numberList } from './data/tables';

/* Source of the ship decoration numbers: furniture is `data/furniture.csv` + `data/furniture_upgrades.csv`,
 * the room purpose build cost is `data/room_purposes.csv`, and the required generator level is `data/tuning.csv`. */
const T = /* data/tuning.csv */ keyTable('tuning.csv');
import type { ImplantId } from './implants';
import type { SkillId } from './progression';
import type { EmbeddedView, SoilTag } from './types';

/* ────────────────────────────────────────────────────────────────────────────
 * Ship housing (ship decoration, 2026-09-06). Owner: housing/HousingSystem publishes `ctx.housing` and persists the
 * ShipState in localStorage (SHIP_STORAGE_KEY). The personal ship is cockpit → corridor → 10 rooms (5 per side) →
 * airlock (shared-ship entrance when docked). hub/ builds the geometry, converts room cells ↔ world positions,
 * renders placed furniture and runs the housing-mode camera / cursor; housing/ owns every rule and number.
 *
 * Framework scope (this session): room purposes, generator / storage facilities, housing mode (grid placement, 90°
 * yaw, recover → furniture storage), the 작업실 (4 upgradeable benches + repair) and the 시뮬레이션실 (formerly 사격장 — loadout presets,
 * gun-skill gain bonus). The other 7 purposes can be assigned and decorated but have no mechanics yet.
 * ──────────────────────────────────────────────────────────────────────────── */

export type RoomPurpose =
  | 'empty'       // 빈 방
  | 'workshop'    // 작업실
  | 'range'       // 시뮬레이션실 (2026-09-12: only the name changed from 사격장 — the id stays)
  | 'gym'         // 헬스장
  | 'library'     // 서재
  | 'greenhouse'  // 온실
  | 'lab'         // 연구실 (requires greenhouse)
  | 'kitchen'     // 주방
  | 'mining'      // 암호화폐 채굴 시설 (2026-09-12: only the name changed from 채굴 시설)
  | 'lounge'      // 휴식 공간 (2026-09-12: can no longer be built — merged into 서재)
  /* appended (2026-09-12): the cockpit. A **fixed space** that never enters `ShipState.rooms`, and its room number is
     `COCKPIT_ROOM_INDEX`. Its purpose cannot be changed and it cannot be removed; only `'any'` (shared) furniture is placed in it. */
  | 'cockpit';

export const ROOM_PURPOSES: readonly RoomPurpose[] = [
  'empty', 'workshop', 'range', 'gym', 'library', 'greenhouse', 'lab', 'kitchen', 'mining', 'lounge',
];

export const ROOM_PURPOSE_LABEL_KO: Readonly<Record<RoomPurpose, string>> = {
  empty: '빈 방', workshop: '작업실', range: '시뮬레이션실', gym: '헬스장', library: '서재', greenhouse: '온실',
  lab: '연구실', kitchen: '주방', mining: '암호화폐 채굴 시설', lounge: '휴식 공간',
  cockpit: '조종석',
};

export const ROOM_PURPOSE_DESC_KO: Readonly<Record<RoomPurpose, string>> = {
  empty: '아직 용도가 정해지지 않은 방입니다.',
  workshop: '총기 · 장비 · 가젯 · 의학 작업대를 설치해 제작과 수리를 합니다.',
  range: '관물대로 로드아웃 프리셋을 관리하고, 시뮬레이션 허브로 훈련장에 들어가 사격 숙련 상승량을 높입니다.',
  gym: '벤치 랙 · 스미스 머신으로 근력을, 트레드밀 · 사이클로 지구력을 단련합니다. 운동한 능력치는 한동안 근육통 · 심폐 피로로 더 오르지 않습니다.',
  /* 2026-09-12 (user's decision): 휴식 공간 was merged into 서재 — what belonged in 휴식 공간 (TV · speakers …) is now placed in 서재. */
  library: '책장 · 디스크 전시대 · 레코드랙에 책 · 디스크 · 레코드를 꽂으면 그 숙련의 상승량이 늘어납니다. 흔들의자 · TV · 턴테이블 같은 가구를 곁에 두면 더 늘어납니다. 꽂아 본 것은 도감에 남습니다.',
  greenhouse: '재배층을 설치하고 씨앗을 심어 현실 시간에 맞춰 약초를 재배합니다.',
  lab: '분석기로 미확인 표본을 해석하고, 추출기 · 조합대로 성분을 뽑아 준비물을 만듭니다. 온실이 먼저 필요합니다.',
  kitchen: '조리대로 작물과 배양 산물을 요리하고, 식탁에서 먹어 다음 레이드 버프를 얻습니다. 온실이 먼저 필요합니다.',
  /* 2026-09-13: mining arrived (docs/DECISIONS.md 「2026-09-13 — 가구 접근 면 · 발전기 · 암호화폐 채굴」) */
  mining: '연산 클러스터에 연산 코어를 꽂아 암호화폐를 채굴합니다. 메인 컴퓨터에서 클러스터 현황 · 지갑 · 거래소를 확인합니다.',
  lounge: 'TV · 스피커로 비디오와 Vinyl 을 재생합니다. (서재에 합쳐졌습니다)',
  cockpit: '함선의 조종석입니다. 공용 가구를 놓을 수 있고, 용도를 바꾸거나 제거할 수 없습니다.',
};

/**
 * appended (Phase 9 UI pass): the **one** icon + accent colour per room purpose. Every place a facility is shown —
 * the 함선 tab 방 목록, the 시설 관리 room list, its 용도 지정 picker — draws this glyph on a `--pc`-tinted thumbnail,
 * so a facility looks the same everywhere. Procedural on purpose: no asset files (see CLAUDE.md).
 */
export const ROOM_PURPOSE_GLYPH: Readonly<Record<RoomPurpose, string>> = {
  empty: '·', workshop: '⚒', range: '◎', gym: '⚖', library: '▤', greenhouse: '❀',
  lab: '⚗', kitchen: '♨', mining: '⛏', lounge: '☕',
  cockpit: '✈',
};
export const ROOM_PURPOSE_COLOR: Readonly<Record<RoomPurpose, string>> = {
  empty: '#7d858f', workshop: '#ffd27a', range: '#7fd2ff', gym: '#ff9f7a', library: '#c9a77a', greenhouse: '#7ee08a',
  lab: '#c79fff', kitchen: '#ffb0a0', mining: '#9fb4c8', lounge: '#e8a0d0',
  cockpit: '#8fd8ff',
};

/**
 * appended (Phase 9 UI pass): materials a **시설 증축** costs — giving an empty room a purpose is no longer free.
 * This is the price of the facility's level 1 (levels 2+ keep their own `*_UPGRADE_COST` tables); 빈 방 costs
 * nothing, and 시설 제거 refunds this table plus every upgrade (`Rules.facilityRefundCost`). Building anything also
 * needs 발전기 Lv.1, exactly like every other upgrade — see `Rules.purposeBuildBlockReason`.
 */
export const ROOM_PURPOSE_BUILD_COST: Readonly<Record<RoomPurpose, readonly { defId: string; qty: number }[]>> =
  Object.fromEntries(csvRows('room_purposes.csv').map((r) => [r.str('purpose'), r.costList('cost')])) as Record<RoomPurpose, { defId: string; qty: number }[]>;

/**
 * Generator level a 시설 증축 needs **by default**. 2026-09-13 (user's decision — power allocation dropped): each purpose names its own level in
 * `data/room_purposes.csv` (`generator`); this value is only the fallback for an empty cell. Read `purposeGeneratorLevel`.
 */
export const ROOM_PURPOSE_BUILD_GENERATOR_LEVEL = T.num('ROOM_PURPOSE_BUILD_GENERATOR_LEVEL');

/**
 * appended (2026-09-13, user's decision — the generator = the build condition of the higher facilities): the generator level a purpose needs to be built (`generator` in `data/room_purposes.csv`,
 * an empty cell = `ROOM_PURPOSE_BUILD_GENERATOR_LEVEL`). Lv.1 작업실 · Lv.2 온실 · 주방 · Lv.3 연구실 · Lv.4 헬스장 · 서재 · Lv.5 채굴 시설.
 * A facility already standing on a ship whose generator is below that level is removed on load by `housing/ShipState` and refunded in full.
 */
export const ROOM_PURPOSE_GENERATOR_LEVEL: Readonly<Partial<Record<RoomPurpose, number>>> = Object.fromEntries(
  csvRows('room_purposes.csv').map((r) => [r.str('purpose'), r.int('generator', { min: 1, fallback: ROOM_PURPOSE_BUILD_GENERATOR_LEVEL })]),
) as Partial<Record<RoomPurpose, number>>;

/** appended (2026-09-13): the generator level needed to build `purpose` (빈 방 = 0). */
export function purposeGeneratorLevel(purpose: RoomPurpose): number {
  if (purpose === 'empty') return 0;
  return ROOM_PURPOSE_GENERATOR_LEVEL[purpose] ?? ROOM_PURPOSE_BUILD_GENERATOR_LEVEL;
}

/** Purposes with mechanics in this build; the rest are decoration-only. (Phase 8 appended `greenhouse`.) */
export const ROOM_PURPOSES_ACTIVE: readonly RoomPurpose[] = ['empty', 'workshop', 'greenhouse', 'library', 'lab', 'kitchen', 'gym', 'mining'];   // 2026-09-13 appended `mining` (암호화폐 채굴)   // 2026-09-12 appended `gym` (A-3a);   // Phase 9 appended `library`; 2026-09-11 appended `lab` (A-12 · A-13) then `kitchen` (A-3c); 2026-09-12 dropped `range` (시뮬레이션실 removed)

/**
 * appended (2026-09-12, user's decision): **the purposes an empty room may become** — this is all the 시설 증축 list draws.
 * `ROOM_PURPOSES` still holds `range` (시뮬레이션실) · `lounge` (휴식 공간, merged into 서재) so that old saves can be read,
 * but neither is here. `empty` and `cockpit` are not either (a 빈 방 is what 「시설 제거」 leaves behind, and the cockpit is not a room).
 */
export const ROOM_PURPOSES_ASSIGNABLE: readonly RoomPurpose[] = ['workshop', 'gym', 'library', 'greenhouse', 'lab', 'kitchen', 'mining'];

/**
 * @deprecated 2026-09-07 — **no longer enforced**. The Phase 8 UI pass gave every ship a built-in 작업실 locked to
 * room 1; a new ship now starts with ten empty rooms and no furniture, and the 작업실 is an ordinary purpose that
 * may be built in any room (one per ship, like every purpose since 2026-09-12) for `ROOM_PURPOSE_BUILD_COST`. Kept only so the contract
 * stays append-only; nothing reads it any more.
 */
export const WORKSHOP_ROOM_INDEX = 0;

/**
 * Upgradeable facilities that are not furniture.
 * **2026-09-12 (user's decision — room facility levels removed):** only `generator` / `storage` still have levels. `workshop` /
 * `range` stay in the union (contract is append-only; `getFacility('range')` still answers "is there such a room")
 * but their `maxLevel` is 1 and `upgrade()` refuses them — upgrades live on the furniture inside the room now
 * (workbench · locker cabinet = preset slots · simulation hub = gun skill gain).
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
 * The workshop benches. **appended (2026-09-10): `'refine'` — the refining workbench.**
 *
 * The higher materials (alloy plate · reinforced alloy ingot · machine part · capacitor module · control module · reinforced weave · composite ballistic fibre)
 * are made only here — the one family with no field quick-craft, and since high-grade gear recipes ask for those materials
 * the refining workbench is the gateway to late-game crafting. Not one line of the other four's behaviour changes.
 */
export type WorkbenchKind = 'gun' | 'gear' | 'gadget' | 'medical' | 'refine' | 'extract' | 'mixer' | 'cook' | 'print';
export const WORKBENCH_KINDS: readonly WorkbenchKind[] = ['gun', 'gear', 'gadget', 'medical', 'refine', 'extract', 'mixer', 'cook', 'print'];
export const WORKBENCH_LABEL_KO: Readonly<Record<WorkbenchKind, string>> = {
  /* 2026-09-12 (user's decision): only `refine`'s name changed, '정제 작업대' → '가공 작업대'. The kind is a contract, so it stays. */
  gun: '총기 작업대', gear: '장비 작업대', gadget: '가젯 작업대', medical: '의학 작업대', refine: '가공 작업대',
  extract: '추출기', mixer: '조합대',
  /* appended (A-3c · A-15, 2026-09-11): the 조리대 belongs to the 주방, the printer to the 연구실 */
  cook: '조리대', print: '3D 프린터',
};
/**
 * appended (2026-09-10): workbench glyphs. The same characters were **copied into two folders** —
 * `inventory/ui/labels` (the craft tab) and `ui/hud/ShipManage` (the furniture card) — so fixing one side left the same
 * workbench drawn differently on the two screens. Exactly as CLAUDE.md's 「what two folders use moves to `shared`」 says, this is the original.
 * Following the no-external-assets rule the icon is one Unicode character.
 */
export const WORKBENCH_ICON: Readonly<Record<WorkbenchKind, string>> = {
  gun: '⚒', gear: '⛭', gadget: '⚙', medical: '✚', refine: '⌘',
  /* appended (lab A-13, 2026-09-11): the extractor · mixer are benches that stand in the lab room (`lab`) */
  extract: '⧗', mixer: '⚛',
  /* appended (A-3c · A-15, 2026-09-11): 조리대는 주방(`kitchen`), 프린터는 연구실(`lab`) */
  cook: '♨', print: '⎔',
};

/** Procedural furniture models hub/ knows how to build (no asset files). */
export type FurnitureModelKind =
  | 'bench_gun' | 'bench_gear' | 'bench_gadget' | 'bench_medical'
  | 'bench_refine'   // appended (2026-09-10): 정제 작업대 — higher materials only
  | 'range_console' | 'target_lane'
  | 'sim_hub'   // appended (Phase 7): 시뮬레이션 허브 — holo pedestal in the 시뮬레이션실
  /* appended (Phase 8): 온실 재배층 (stackable grow rack) and the 정비 벤치 moved out of the cockpit */
  | 'grow_rack' | 'repair_bench'
  | 'bookshelf'   // appended (Phase 9): 서재 책장 — the builder reads the shelved count and fills the shelves
  | 'grow_station' // appended (온실 개편, 2026-09-11): 재배 스테이션 — the builder reads `level` and shows 1 / 2 / 3 재배층
  /* appended (연구실, 2026-09-11): the 분석기 lights up as many analysis slots as its `level`; 추출기 · 조합대 are ordinary bench bodies */
  | 'analyzer' | 'bench_extract' | 'bench_mixer'
  /* appended (주방 · 배양조 · 프린터, 2026-09-11): the 배양조 lights up as many culture tubes as its `level` (the same way as the 분석기) */
  | 'bench_cook' | 'dining_table' | 'culture_tank' | 'bench_print'
  | 'locker' | 'table' | 'shelf' | 'crate' | 'lamp' | 'plant' | 'chair' | 'bunk'
  /* appended (2026-09-12): the 전술 임플란트 시술대 · 함선 컴퓨터, once fixed cockpit fittings, became shared facility furniture */
  | 'implant_bay' | 'corp_computer'
  /* appended (2026-09-12, A-3e): 2 library media holders + 5 aux pieces (축음기 · 주크박스 · 턴테이블 are one role with different looks) */
  | 'disc_stand' | 'record_rack' | 'rocking_chair' | 'tv' | 'gramophone' | 'jukebox' | 'turntable'
  /* appended (2026-09-12, A-3a): the 4 pieces of 헬스장 equipment */
  | 'bench_rack' | 'smith_machine' | 'treadmill' | 'exercise_bike'
  /* appended (2026-09-13): the 서랍장 (창고 캐비닛), once a fixed cockpit prop, became the decoration piece `furn_drawer` */
  | 'drawer'
  /* appended (2026-09-13, cooking minigames): the 주방's 4 auto-cook appliances — 푸드 프로세서 · 자동 그릴 · 자동 교반기 · 계량 디스펜서 (as many indicator lights as its `level`) */
  | 'food_processor' | 'auto_grill' | 'auto_stirrer' | 'pour_dispenser'
  /* appended (2026-09-13, crypto mining — docs/DECISIONS.md 「2026-09-13 — 가구 접근 면 · 발전기 · 암호화폐 채굴」): 연산 클러스터 (9 core slots, one lit per core inserted) · 메인 컴퓨터 */
  | 'compute_cluster' | 'mining_computer'
  /* appended (2026-09-13, library series · video games — docs/DECISIONS.md 「2026-09-13 — 서재 시리즈 · 비디오게임」): 게임 디스크 전시대 · 쇼파 · 좌식 테이블 · 러그 */
  | 'game_stand' | 'sofa' | 'low_table' | 'rug';

/** What E does on a placed piece. */
export type FurnitureInteraction =
  | 'none'
  | 'workbench_gun' | 'workbench_gear' | 'workbench_gadget' | 'workbench_medical'  // → ctx.inventory.openBenchCraft(kind)
  | 'workbench_refine'                                                            // appended (2026-09-10) → the same road, kind 'refine'
  | 'range_console'                                                               // retired (2026-09-12 — the locker cabinet · presets removed). No E interaction
  | 'sim_hub'                                                                     // appended (Phase 7) → hub starts / joins the simulation training range
  /* appended (Phase 8) */
  | 'grow_rack'                                                                   // → ctx.housing.openGrowMenu(uid): plant a seed / harvest
  | 'repair_bench'                                                                // → the repair bench menu (hub/WorkbenchMenu), no longer built into the cockpit
  /* appended (Phase 9) */
  | 'bookshelf'                                                                   // → ctx.housing.openBookshelfMenu(uid): shelve / take out a book / the catalogue
  /* appended (greenhouse rework, 2026-09-11) */
  | 'grow_station'                                                                // → ctx.housing.openGrowStation(uid): fill soil / plant a seed / harvest
  /* appended (lab, 2026-09-11) */
  | 'workbench_extract' | 'workbench_mixer'                                       // → the same road, kind 'extract' / 'mixer' (benchKindOf resolves it from the prefix)
  | 'analyzer'                                                                    // → ctx.housing.openAnalyzer(uid): insert a sample / collect an analysis / the analysis catalogue
  /* appended (kitchen · culture tank · printer, 2026-09-11) */
  | 'workbench_cook' | 'workbench_print'                                          // → the same road, kind 'cook' / 'print'
  | 'dining_table'                                                                // → ctx.housing.openDiningTable(uid): eat / (in the shared ship) serve the squad
  | 'culture_tank'                                                                // → ctx.housing.openCultureTank(uid): pour a medium / insert a strain / harvest
  /* appended (2026-09-12) — shared facility furniture */
  | 'implant_bay'                                                                 // → the Tab screen (implant slots) — the same road as the old `hub_implant_bay`
  | 'corp_computer'                                                               // → the corporate network (`ctx.meta.openCorpMenu()`) — the same road as the old `hub_computer`
  /* appended (2026-09-12, A-3e) — library media */
  | 'disc_stand' | 'record_rack'                                                  // → ctx.housing.openShelf(uid): shelve / take out a disc · record / the catalogue (a screen of the same grain as the bookshelf)
  | 'rocking_chair'                                                               // → ctx.player.setFurniturePose({kind:'sit', releaseOnInteract:true}) — a sit toggle. Placing it alone gives the book share bonus
  | 'tv' | 'record_player'                                                        // → ctx.housing.toggleFurniture(uid): screen · light on/off (no light source). Placing it alone gives the disc · record share bonus
  /* appended (2026-09-12, A-3a) — the gym (`GYM_EQUIPMENT`) */
  | 'gym_bench_press' | 'gym_smith' | 'gym_treadmill' | 'gym_cycle'             // → ctx.housing.startGymSession(uid): the minigame
  /*
   * appended (2026-09-13, cooking minigames — `shared/cooking`): the 4 auto-cook appliances (`COOK_APPLIANCE_GAMES`). Placing one alone opens 「자동」 for that cooking step.
   * E → `ctx.housing.openCookStation(<uid of the ship's cook bench>)` (a toast when there is no cook bench). ⚠ From the same day **`workbench_cook`'s E is also
   * `ctx.housing.openCookStation(uid)`**, not the inventory craft window (`benchKindOf` still answers 'cook' — the level · recipe gates use that name).
   */
  | 'cook_processor' | 'cook_grill' | 'cook_stirrer' | 'cook_dispenser'
  /* appended (2026-09-13, crypto mining): → ctx.housing.openComputeCluster(uid) (pick the coin · insert cores) / ctx.housing.openMiningComputer(uid) (status · wallet · exchange) */
  | 'compute_cluster' | 'mining_computer'
  /*
   * appended (2026-09-13, library series · video games): the game disc stand → `ctx.housing.openShelf(uid)` (holder medium 'game') ·
   * a seat (chair · sofa) → a sit toggle (the same road as the rocking chair). ⚠ From the same day **`tv`'s E is `ctx.housing.openTvMenu(uid)`**, not an
   * on/off toggle (on/off button · attach a console · the game list).
   */
  | 'game_stand' | 'seat';

export interface FurnitureDef {
  id: string;
  name: string;
  description: string;
  /** Room purpose it may be placed in; 'any' = every room. 2026-09-13: `'cockpit'` = 조종석 전용 시설 (`isCockpitOnlyFurniture`). */
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
 * one **재배 스테이션** (`furn_grow_station`) is an ordinary upgradeable piece. ~~Its level opens 재배층~~ —
 * **2026-09-13 (사용자 결정)**: all three 재배층 are open from Lv.1 and each level adds `GROW_STATION_SPEED_PER_LEVEL`
 * growth speed instead (Lv.2 +15 % · Lv.3 +30 %).
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

/** Slot count per grow tier. */
export const GROW_SLOTS_PER_TIER = T.num('GROW_SLOTS_PER_TIER');

/**
 * Tiers a 재배 스테이션 of `level` has opened. **2026-09-13 (사용자 결정): every tier is open from Lv.1** — an upgrade
 * no longer opens tiers, it raises the growth speed (`GROW_STATION_SPEED_PER_LEVEL`). The signature stays (hub draws
 * its shelves from it, `ShipState.sanitize` validates `grows` with it); `level` no longer changes the answer.
 */
export function growTiersForLevel(_level: number): readonly GrowTier[] {
  return [0, 1, 2];
}

/**
 * appended (2026-09-13): the growth speed one 재배 스테이션 level adds. Growth time = the base ÷ (1 + this value × (level − 1)),
 * multiplied with the soil-match and 원예 terms. The moment it is upgraded, the **remaining time** of a crop already growing
 * shrinks by that same speed ratio (`housing/parts/Garden.rescaleGrowsForUpgrade` — the one exception to 「readyAt is fixed at planting time」).
 */
export const GROW_STATION_SPEED_PER_LEVEL = T.num('GROW_STATION_SPEED_PER_LEVEL');

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
  /** Seed item def id (`ItemDef.seed` must be set); absent = only soil has been poured in. */
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
  /** null = there is no soil (drop soil here first). */
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
   * appended (2026-09-11, A-15): pouch def id. It is optional for the same reason as `implantItems` — a saved v3 preset
   * has no such field, and `undefined` means 「the pouch is left alone」 while `null` means 「empty it」.
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
  /**
   * SHIP_ROOM_COUNT entries; the first half = port side (−X) front→back, the second half = starboard (+X) front→back
   * (2026-09-12: 8 rooms → 0..3 / 4..7). The cockpit is **not** in here — see `COCKPIT_ROOM_INDEX`.
   */
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
  /*
   * appended (2026-09-16, user's decision): the **stash upgrade modal**. The 「업그레이드」 button in the inventory Tab
   * stash header and in the workbench window header calls it — neither screen touches the `storage` facility itself,
   * they call only this one line (「never import another folder's internals」 — facility level · cost · hold confirm belong to housing).
   * The modal has the same look and the same rules as `housing/ui/UpgradeModal` (material chips + a `UI_HOLD_CONFIRM_S` hold + `ctx.escape`),
   * and it draws **above** the inventory window. Outside the ship (no `ctx.housing` · in a raid) the caller hides the button itself.
   */
  openStorageUpgrade(): void;
  /*
   * appended (2026-09-16, user's report 「I pressed upgrade in the workbench UI and the stash upgrade window came up」):
   * the upgrade modal of **that one workbench**. The same modal and the same hold; only the target is the placed workbench
   * furniture (with several of them the **highest-level** one, the same one the recipe gate looks at). With no workbench placed it only shows a Korean notice.
   * `openStorageUpgrade()` hands over to this function while the craft column is in workbench mode — the workbench window's button may call it directly.
   */
  openBenchUpgrade?(bench: WorkbenchKind): void;

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
   * 2026-09-10 (add-only): the spot **auto placement** picks — rows are filled first, from the top left of the screen, and the
   * piece faces the bottom of the screen (world +X = yaw 1). The rule and the coordinate derivation live in one place, `housing/Rules.autoPlaceSpot`.
   * `null` = this room has no spot that piece fits in. The manual placement path does not use this query.
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

  /* ── greenhouse growing ──
   * @deprecated 2026-09-11 (the greenhouse rework) — the 재배층 furniture these belong to is retired. They stay in the contract
   * (the add-only rule) and now always report "없는 재배층": `getPlots` → `[]`, the mutators → a Korean reason,
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

  /* ── crew callsign ── */
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

  /* ══ appended: Phase 9 — the bookshelf (2026-09-06) ══════════════════════ */
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

  /* ══ appended: Phase 9 UI pass — facility removal (2026-09-07) ════════════ */
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

  /* ══ appended: greenhouse rework — grow station (2026-09-11) ════════════════ */

  /**
   * Every 칸 of one 재배 스테이션, **always `3 × GROW_SLOTS_PER_TIER` entries** in `GROW_TIER_DRAW_ORDER`, locked
   * tiers included (`locked: true` + `unlockLevel`) so the panel can draw the greyed-out rows the upgrade will open.
   * Empty array when `uid` is not a placed 재배 스테이션.
   */
  getGrowSlots(uid: string): GrowSlotInfo[];
  /**
   * Pour one soil item (bag → stash, `consumeDefAll`) into an empty 칸. `soilUsesLeft` starts at `ItemDef.soil.uses`.
   * Korean reason on failure (the tier is locked · there is already soil · it is not soil · the player does not own it), null on success.
   */
  fillSoil(uid: string, tier: GrowTier, slot: number, soilDefId: string): string | null;
  /**
   * Scrape a 칸 back to 흙 없음. **The soil is not returned** — it is thrown away even with uses left (soil once poured is
   * never scooped back). Refused with a Korean reason while something is planted in it; null on success.
   * 2026-09-12 (appended optional): `discardCrop` true throws the planted crop away too (right-click the soil hole, 「작물 버리고 흙 비우기」).
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
    /* appended (2026-09-13): placement access faces · required power · building several (docs/DECISIONS.md 「2026-09-13 — 가구 접근 면 · 발전기 · 암호화폐 채굴」) */
    ...(r.has('access') ? { access: accessCell(r.str('access'), (m) => r.report('access', m)) } : {}),
    ...(r.has('power') ? { power: r.num('power', { min: 0 }) } : {}),
    ...(r.bool('multi') ? { multi: true } : {}),
    /* appended (2026-09-13): low furniture that does not block the view (docs/DECISIONS.md 「2026-09-13 — 서재 시리즈 · 비디오게임」) */
    ...(r.has('low') && r.bool('low') ? { low: true } : {}),
  };
});

function accessCell(v: string, report: (message: string) => void): FurnitureAccess {
  // Why the list is spelled out here: `FURNITURE_DEFS` is computed while the module loads, but `FURNITURE_ACCESS_VALUES` sits at the end of the file (an appended section) and is not initialised yet
  if (v === 'none' || v === 'front' || v === 'sides' || v === 'all') return v;
  report(`'${v}' — none · front · sides · all 중 하나`);
  return 'none';
}

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
 * The lab — the analyzer (A-12, 2026-09-11, user's decision: waiting in real time)
 *
 * The analyzer (`furn_analyzer`) is **a station of the same shape** as the grow station: its level opens slots.
 * At level n, `ANALYZER_SLOTS_BASE + ANALYZER_SLOTS_PER_LEVEL × n` slots are open and the screen always draws `ANALYZER_MAX_SLOTS` slots
 * (a locked slot is `locked: true` + `unlockLevel`). Slot numbers never shift on an upgrade — a running analysis must not move.
 *
 * The analysis time is fixed into `readyAt` **the moment it starts** (the same rule as the greenhouse's `plantedAt` / `readyAt`). Since 2026-09-16 the formula
 * lives in the 「표본 개편」 block below — `analyzeHours × analysisTimeMul(the family's analysis level) × (1 − the speedup)`, and the speedup is made of
 * **the catalogue entries of the same rarity** and **that sample's level**. The old two terms (`ANALYZE_DEX_SPEEDUP` · `ANALYZE_KNOWN_SPEEDUP`)
 * are read by nobody. The old catalogue (`ShipState.sampleDex`) is an append-only record like `bookDex`, filled quietly on collection.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 2026-09-15 2nd pass (user's decision 「the analyzer in the lab starts with 2 slots (expanding to at most 4 with upgrades)」):
 * the slots an analyzer has regardless of its level. Slots = `BASE + level × PER_LEVEL`, so Lv.1 = 2 · Lv.2 = 3 · Lv.3 = 4 —
 * the old formula (`level × PER_LEVEL`) could not produce 2/3/4 (the max level is still 3).
 */
export const ANALYZER_SLOTS_BASE = T.num('ANALYZER_SLOTS_BASE');
/** How many **more** analysis slots one analyzer level opens (`data/tuning.csv`). */
export const ANALYZER_SLOTS_PER_LEVEL = T.num('ANALYZER_SLOTS_PER_LEVEL');
/** Slots at the max level (3) — the panel always draws this many, locked slots included. */
export const ANALYZER_MAX_SLOTS = ANALYZER_SLOTS_BASE + 3 * ANALYZER_SLOTS_PER_LEVEL;

/**
 * How many slots an analyzer of `level` has open. The caller has already clamped the level with the def's `maxLevel`.
 * Level 0 (not built yet) is 0 slots — the base slots exist **only while one stands**.
 */
export function analyzerSlotsForLevel(level: number): number {
  const lv = Math.max(0, Math.min(3, Math.floor(level)));
  return lv <= 0 ? 0 : ANALYZER_SLOTS_BASE + lv * ANALYZER_SLOTS_PER_LEVEL;
}

/** The analyzer level that opens `slot` (1 … 3). Derived from `analyzerSlotsForLevel` — 2 · 3 are never written into the code. */
export function analyzerSlotUnlockLevel(slot: number): number {
  for (let lv = 1; lv <= 3; lv++) if (slot < analyzerSlotsForLevel(lv)) return lv;
  return 3;
}

/** One slot with an analysis in it. An empty slot is simply absent from `ShipState.analyses` (the same rule as the greenhouse's `grows`). */
export interface AnalysisSlot {
  /** The analyzer's `PlacedFurniture.uid`. */
  uid: string;
  /** 0 … ANALYZER_MAX_SLOTS − 1. */
  slot: number;
  /** Sample item def id (`ItemDef.sample` must be set). */
  sampleDefId: string;
  /** Epoch ms when it was put in. */
  startedAt: number;
  /** Epoch ms when it may be collected — fixed when it starts. */
  readyAt: number;
}

/** One slot as the analysis screen sees it. An analyzer always reports `ANALYZER_MAX_SLOTS` of them, locked slots included. */
export interface AnalysisSlotInfo {
  slot: number;
  /** A slot the current level does not open (drawn dimmed with the required level). */
  locked: boolean;
  /** The analyzer level that opens this slot. */
  unlockLevel: number;
  /** null = an empty slot. */
  sampleDefId: string | null;
  /** 0 … 1; −1 when empty. */
  progress: number;
  /** Seconds left. 0 when ready or empty. */
  remainingS: number;
  ready: boolean;
  /** What collecting it yields (the panel's product chip). */
  rewardDefId: string | null;
  rewardQty: number;
  /** A sample not in the catalogue yet — collecting it fills one catalogue entry and adds the `SampleDef.firstDefId` bonus. */
  firstTime: boolean;
}

/**
 * Is this utility furniture — a piece that does something on E (workbench · station · bookshelf · locker cabinet · sim hub). It is the B-13 rule:
 * **already owning the same utility piece locks crafting it** (`HousingRef.furnitureCraftBlock`) and drops it to the bottom
 * of the craft list (user's decision 2026-09-11 — bench level counts only the highest one, so there is no reason to build a second).
 * Decorative furniture (`interaction: 'none'`) may be built without limit.
 * 2026-09-17 (user's decision): a seat that is only sat on (`seat` — chair · sofa) is **decorative furniture** too. It is still sat on with E and still
 * becomes a game seat in front of a TV, but in 시설 관리's 「시설 가구 / 꾸밈용 가구」 sub-tabs it stands under decorative (the rocking chair keeps a library bonus, so it stays utility furniture).
 */
export function isUtilityFurniture(def: FurnitureDef): boolean {
  return def.interaction !== 'none' && def.interaction !== 'seat';
}

export interface ShipState {
  /* ── appended (the lab, 2026-09-11, version 5) ── */
  /**
   * Analyzer analysis slots. `sanitize` drops an entry whose `uid` is not a placed analyzer, or whose slot is beyond
   * that analyzer's level (the sample does not come back — treated like the greenhouse's soil).
   */
  analyses?: AnalysisSlot[];
  /** The analysis catalogue: every sample def id ever **collected** (never removed). The same shape as `bookDex`. */
  sampleDex?: string[];
}

export interface HousingRef {
  /* ══ appended: the lab — the analyzer (A-12, 2026-09-11) ════════════════════ */

  /**
   * Every slot of one analyzer, **always `ANALYZER_MAX_SLOTS` of them** in slot order. Locked slots are in there too, as
   * `locked: true` + `unlockLevel`, so the panel can draw 「an upgrade opens this」. Empty array when `uid` is not a placed analyzer.
   */
  getAnalyses(uid: string): AnalysisSlotInfo[];
  /**
   * Put one sample in (bag → ship stash, in that order) and start the analysis. `readyAt` is fixed here, so **a running
   * analysis never speeds up** however much the catalogue fills afterwards. Korean reason / null on success.
   */
  startAnalysis(uid: string, slot: number, sampleDefId: string): string | null;
  /**
   * Stop an analysis. **The sample does not come back** (the same as poured soil). Korean reason / null.
   */
  cancelAnalysis(uid: string, slot: number): string | null;
  /**
   * Collect a finished analysis — the product goes into the bag (the ship stash when there is no space), and a sample
   * seen for the first time is written into the catalogue with the `SampleDef.firstDefId` bonus on top. Korean reason / null.
   * 2026-09-12 (appended argument): `dest` picks the grid to put it in (`HarvestDestination`, default `'bag-first'`).
   */
  collectAnalysis(uid: string, slot: number, dest?: HarvestDestination): string | null;
  /** Collect every finished analysis and return how many were taken. */
  collectAllAnalyses(uid: string): number;
  /** Samples the player owns right now (bag + ship stash) — the analysis screen's list. */
  getOwnedSamples(): { defId: string; qty: number }[];
  /** The analysis catalogue: sample def ids ever collected. */
  getSampleDex(): readonly string[];
  /**
   * @deprecated 2026-09-13 · 2026-09-16 — catalogue progress 0 … 1. The analysis time does not look at this value (the catalogue entries per rarity + the sample level decide it).
   */
  getSampleDexRatio(): number;
  /** Open the analysis screen (`analyzer` interaction): analysis slots on the left · bag + ship stash + catalogue on the right. */
  openAnalyzer(uid: string): void;

  /* ══ appended: B-13 — upgrading placed furniture (2026-09-11) ════════════════
   * `upgradeFurniture` has existed since Phase 8 but **nothing called it** — workbench Lv.2–3 was unreachable in play.
   * 시설 관리's click inspector (user's decision) reads these three to draw the level · the next cost · the refusal reason. */

  /** Korean reason `upgradeFurniture(uid)` would refuse right now, null = it can be upgraded. (What only the system had, now in the contract.) */
  furnitureUpgradeBlock(uid: string): string | null;
  /** This piece's **next level** cost. null at max level or when it is not a placed piece. */
  furnitureUpgradeCost(uid: string): CraftIngredient[] | null;
  /**
   * Korean reason this piece cannot be **crafted** right now, null = it can be built. Apart from missing materials, a
   * utility piece already owned (`isUtilityFurniture`, placed + furniture storage together) is locked here — 시설 관리 draws
   * that card dimmed and drops it to the bottom of the list (user's decision 2026-09-11).
   */
  furnitureCraftBlock(defId: string): string | null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The greenhouse — the culture tank (A-14, 2026-09-11, user's decision: placed in the greenhouse · waiting in real time)
 *
 * The culture tank (`furn_culture_tank`) is **a station of the same shape** as the grow station · the analyzer: its level opens slots.
 * At level n, `CULTURE_SLOTS_PER_LEVEL × n` slots are open and the screen always draws `CULTURE_MAX_SLOTS` slots
 * (a locked slot is `locked: true` + `unlockLevel`). Slot numbers never shift on an upgrade.
 *
 * A slot has **two steps** — exactly the greenhouse's 「soil first, seed second」:
 *   ① `fillMedium` pours in a nutrient medium (`ItemDef.medium`, an extractor product).
 *   ② `insertStrain` inserts a cell line · strain (`ItemDef.strain`, an analyzer product).
 * The medium wears **once per harvest** (`mediumUsesLeft`) and **at 0 the slot is left as it is** — 2026-09-13
 * (the cooking material tiers, user's decision) gave the medium soil's durability rule, so the tank stops producing
 * until a fresh medium goes in instead of emptying (the 2026-09-11 rule that emptied it is gone). Unlike soil's tag matching a medium
 * is **one grade** (`MediumDef.speedMul`), and the culture time is fixed into `readyAt` the moment the strain goes in.
 * ──────────────────────────────────────────────────────────────────────────── */

/** How many culture slots one culture tank level opens (`data/tuning.csv`). */
export const CULTURE_SLOTS_PER_LEVEL = T.num('CULTURE_SLOTS_PER_LEVEL');
/** Slots at the max level (3) — the panel always draws this many, locked slots included. */
export const CULTURE_MAX_SLOTS = 3 * CULTURE_SLOTS_PER_LEVEL;

/** How many slots a culture tank of `level` has open. The caller has already clamped the level with the def's `maxLevel`. */
export function cultureSlotsForLevel(level: number): number {
  return Math.max(0, Math.min(3, Math.floor(level))) * CULTURE_SLOTS_PER_LEVEL;
}

/** The culture tank level that opens `slot` (1 … 3). Derived from `cultureSlotsForLevel` — 2 · 3 are never written into the code. */
export function cultureSlotUnlockLevel(slot: number): number {
  for (let lv = 1; lv <= 3; lv++) if (slot < cultureSlotsForLevel(lv)) return lv;
  return 3;
}

/** One culture slot with a medium in it. A slot with no medium is simply absent from `ShipState.cultures` (the same rule as the greenhouse's `grows`). */
export interface CultureSlot {
  /** The culture tank's `PlacedFurniture.uid`. */
  uid: string;
  /** 0 … CULTURE_MAX_SLOTS − 1. */
  slot: number;
  /** Nutrient medium item def id (`ItemDef.medium` must be set). */
  mediumDefId: string;
  /** Harvests this medium still survives; the slot empties when it reaches 0. */
  mediumUsesLeft: number;
  /** Cell line item def id (`ItemDef.strain` must be set); absent = only the medium is in it. */
  strainDefId?: string;
  startedAt?: number;
  /** Epoch ms when it may be harvested — fixed when the strain goes in. */
  readyAt?: number;
}

/** One slot as the culture screen sees it. A culture tank always reports `CULTURE_MAX_SLOTS` of them, locked slots included. */
export interface CultureSlotInfo {
  slot: number;
  locked: boolean;
  unlockLevel: number;
  /** null = there is no medium (a medium has to be poured in here first). */
  mediumDefId: string | null;
  mediumUsesLeft: number;
  /** The panel shows the fraction the medium's grade shaves off as 「배양 속도 +n %」. */
  mediumSpeedMul: number;
  /** null = a medium ready for a strain (or no medium at all). */
  strainDefId: string | null;
  /** 0 … 1; −1 when empty. */
  progress: number;
  remainingS: number;
  ready: boolean;
  yieldDefId: string | null;
  yieldQty: number;
}

export interface ShipState {
  /* ── appended (the culture tank A-14, 2026-09-11, version 6) ── */
  /**
   * Culture tank slots. `sanitize` drops an entry whose `uid` is not a placed culture tank, or whose slot is beyond that
   * tank's level (the medium · strain do not come back — treated like the greenhouse's soil). v5 → v6 only adds a field
   * that was not there, so there is no migration and no refund path.
   */
  cultures?: CultureSlot[];
}

export interface HousingRef {
  /* ══ appended: the greenhouse — the culture tank (A-14, 2026-09-11) ═════════ */

  /**
   * Every slot of one culture tank, **always `CULTURE_MAX_SLOTS` of them** in slot order. Locked slots are in there too.
   * Empty array when `uid` is not a placed culture tank.
   */
  getCultureSlots(uid: string): CultureSlotInfo[];
  /** Pour one nutrient medium (bag → ship stash) into an empty slot. Korean reason / null. */
  fillMedium(uid: string, slot: number, mediumDefId: string): string | null;
  /**
   * Put a slot back to having no medium. **The medium does not come back** (the same as poured soil). Refused while a culture runs.
   * 2026-09-12 (appended argument): `discardStrain` true throws the culturing strain away with it (the right-click menu).
   */
  clearMedium(uid: string, slot: number, discardStrain?: boolean): string | null;
  /** Insert one strain into a slot that has a medium. `readyAt` is fixed here. Korean reason / null. */
  insertStrain(uid: string, slot: number, strainDefId: string): string | null;
  /**
   * Harvest one finished slot (the bag, the ship stash when there is no space). One medium use is spent, and **at 0 the slot is left as it is**
   * (2026-09-13 — it stops producing, it does not empty).
   * Otherwise it goes back to 「a medium ready for a strain」. Korean reason / null.
   * 2026-09-12 (appended argument): `dest` picks the grid to put it in (`HarvestDestination`, default `'bag-first'`).
   */
  harvestCulture(uid: string, slot: number, dest?: HarvestDestination): string | null;
  /** Harvest every finished slot and return how many were taken. */
  harvestAllCultures(uid: string): number;
  /** Nutrient media the player owns right now (bag + ship stash) — the culture screen's list. */
  getOwnedMediums(): { defId: string; qty: number }[];
  /** Cell lines · strains the player owns right now (bag + ship stash). */
  getOwnedStrains(): { defId: string; qty: number }[];
  /** Open the culture screen (`culture_tank` interaction): culture slots on the left · bag + ship stash on the right. */
  openCultureTank(uid: string): void;

  /* ══ appended: the kitchen — the dining table (A-3c, 2026-09-11) ════════════ */

  /**
   * Open the meal screen — left = the meal loaded right now + its one buff line, right = the meals owned + bag/stash.
   *
   * When `uid` is a placed dining table piece it is the personal ship's dining table; **`null` is the shared ship's fixed dining table**
   * (it has no uid because it is not furniture but an interaction point hub planted). Only in the shared ship is the `분대에 차리기`
   * button shown — it consumes **1** meal and every squadmate receives the same meal (user's decision).
   */
  openDiningTable(uid: string | null): void;
}

/* ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
 * appended: 2026-09-12 — the cockpit · facility level requirements (user's decision)
 *
 * 1. **The cockpit is a space that always sits at the top of the room list.** It never enters `ShipState.rooms` (it has no purpose and no
 *    level); its room number is `COCKPIT_ROOM_INDEX` — `getRoom(COCKPIT_ROOM_INDEX).purpose === 'cockpit'`, `getPlaced(COCKPIT_ROOM_INDEX)`,
 *    `canPlace / place / move / recover` and `setManageRoom(COCKPIT_ROOM_INDEX)` all take that number.
 *    `setRoomPurpose` · `removeRoomFacility` refuse it. Only `room: 'any'` (shared) furniture is placed in the cockpit.
 *    2026-09-13: and `room: 'cockpit'` as well (cockpit-only fittings — the implant bay · the computer, `isCockpitOnlyFurniture`).
 *    Why the number is a **fixed value** and not `SHIP_ROOM_COUNT`: saved cockpit furniture must not move into another room when the room count grows later.
 *    Why it is not `-1`: hub's `HousingMode.room = -1` means 「mode off」.
 * 2. **The cockpit's grid is bigger than a room's and has holes in it.** `roomGridSize(room)` answers the grid size per room, and `roomCellBlocked`
 *    answers where the fixed props stand (instrument panel · seats · launch pod · lockers · bunk · storage · the corridor passage). The placement
 *    rules (`housing/Rules`) and the grid lines · camera (`hub/`) read **this one table**. Move a prop and this table is fixed with it.
 * 3. **A facility level requirement** (generator Lv.n) is drawn beside the material chips with `buildFacilityChip` — the queries are the two `HousingRef` lines below.
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════════════ */
import { ROOM_GRID_COLS, ROOM_GRID_ROWS } from './constants';

/** The cockpit's room number (a fixed value outside `0 … SHIP_ROOM_COUNT − 1`, since it is not a room). */
export const COCKPIT_ROOM_INDEX = 100;

/**
 * The cockpit floor grid (in cells). `hub/interiors/RoomLayout.COCKPIT` = x −5 … 5, z −6 … 0 (10 × 6 m) divided by `HOUSING_CELL_SIZE` (0.5).
 * By the same rule as a room, cell (0, 0) is the min-x / min-z corner (port side · toward the front window); `x` is world +X and `y` is world +Z.
 */
export const COCKPIT_GRID_COLS = 20;
export const COCKPIT_GRID_ROWS = 12;

/** A rectangle of cells on the grid (top-left cell + size). */
export interface GridRect { x: number; y: number; cols: number; rows: number }

/**
 * Cells of the cockpit where furniture cannot be placed — the fixed props and the passage that has to stay clear. Taken from the
 * cockpit prop coordinates in `hub/interiors/PersonalShip` (cell x = (world x + 5) / 0.5, cell y = (world z + 6) / 0.5).
 */
export const COCKPIT_BLOCKED_RECTS: readonly GridRect[] = [
  { x: 3, y: 0, cols: 14, rows: 3 },    // the instrument panel (x ±3.3, z −6 … −5.3) + 0.8 m in front of it (x −3.5 … 3.5, z −6 … −4.5)
  { x: 7, y: 3, cols: 6, rows: 9 },     // the two pilot seats · the terminal spot · the passage up to the corridor arch (x −1.5 … 1.5, z −4.5 … 0)
  /* 2026-09-13 (user's decision): the two lockers · the bunk · the storage cabinet became decoration furniture (`COCKPIT_DECOR_FURNITURE`) — those cells were freed.
     The launch pod blocks only its socket and the boarding path in front of the door. Old table: {18,1,2,3} lockers · {13,7,7,5} pod + cabinet · {0,6,2,5} bunk. */
  { x: 13, y: 7, cols: 7, rows: 4 },    // the launch pod socket (x 3 … 5, z −2.2 … −0.5) + the boarding path in front of the door (−X) (x 1.5 … 5, z −2.5 … −0.5)
  { x: 16, y: 11, cols: 4, rows: 1 },   // the far end behind the pod socket · the back wall pillar (x 3 … 5, z −0.5 … 0)
];

/**
 * appended (2026-09-13, user's decision): the cockpit's **decoration furniture** — where the old fixed props (the bunk · the two lockers · the storage cabinet) stood.
 * It is placed **exactly once**, on a new ship (`housing/ShipState.freshState`) and on a pre-v10 save (the v10 section of `sanitize`), and once the player
 * recovers it, it is never filled in again (unlike `COCKPIT_DEFAULT_FURNITURE`). It goes to furniture storage when the spot is blocked.
 * The cell coordinates were taken from the old prop coordinates (cell x = (world x + 5) / 0.5, cell y = (world z + 6) / 0.5).
 */
export const COCKPIT_DECOR_FURNITURE: readonly { defId: string; x: number; y: number; yaw: 0 | 1 | 2 | 3 }[] = [
  /* The bunk (2 tiers): against the −X wall, long along z — 2 × 3 cells = x −5 … −4, z −2.5 … −1.0 (the old single bunk's centre was z −1.75) */
  { defId: 'furn_bunk', x: 0, y: 7, yaw: 0 },
  /* The two lockers: the +X wall — 1 × 2 cells each = x 4.5 … 5, z −5.5 … −3.5 (the old row's centre was z −4.7); their doors face ±X, so one door looks into the cockpit */
  { defId: 'furn_locker', x: 19, y: 1, yaw: 0 },
  { defId: 'furn_locker', x: 19, y: 3, yaw: 0 },
  /* The drawer (the old storage cabinet): the starboard half of the back wall, drawers facing −Z — 2 × 1 cells = x 2 … 3, z −0.5 … 0 (old centre x 2.4) */
  { defId: 'furn_drawer', x: 14, y: 11, yaw: 0 },
];

/**
 * appended (2026-09-13): is this a cockpit-only fitting (`FurnitureDef.room === 'cockpit'` — the implant bay · the computer). It is placed only in the
 * cockpit, cannot be recovered or removed, and there is exactly one per ship (`housing/ShipState.ensureCockpitFurniture`).
 */
export function isCockpitOnlyFurniture(def: FurnitureDef | undefined | null): boolean {
  return !!def && def.room === 'cockpit';
}

/** appended (2026-09-13): the refusal sentence for recovering · removing a cockpit-only fitting — housing's rule and hub's 시설 관리 toast use the same text. */
export const COCKPIT_ONLY_RECOVER_REASON = '조종석 전용 시설은 회수할 수 없습니다';

/** appended: the def ids of the two shared facility pieces. */
export const IMPLANT_BAY_DEF_ID = 'furn_implant_bay';
export const CORP_COMPUTER_DEF_ID = 'furn_corp_computer';

/**
 * The shared facility furniture every ship starts with in its cockpit, and where it stands. A new ship (`freshState`) and an old save (whenever one
 * of the two is neither placed nor stored) both get it filled in here — through `housing/Rules.autoPlaceSpot` when the spot is blocked, and into
 * furniture storage when even that fails. The coordinates are where the old fixed fittings stood (the implant bay = the front port corner, the computer = the rear port wall).
 */
export const COCKPIT_DEFAULT_FURNITURE: readonly { defId: string; x: number; y: number; yaw: 0 | 1 | 2 | 3 }[] = [
  /* The implant bay: yaw 1 = its front faces +X (into the cockpit) · its back rests on the −X wall — a 4 × 3 cell footprint = x −5 … −3, z −4.5 … −3 (just behind the band in front of the instrument panel) */
  { defId: IMPLANT_BAY_DEF_ID, x: 0, y: 3, yaw: 1 },
  /* The computer: yaw 0 = the monitor faces −Z (into the cockpit) · the desk's back is the rear wall — 3 × 3 cells = x −4 … −2.5, z −1.5 … 0 (beside the bunk, the old desk's spot) */
  { defId: CORP_COMPUTER_DEF_ID, x: 2, y: 9, yaw: 0 },
];

export function isCockpitRoom(room: number): boolean { return room === COCKPIT_ROOM_INDEX; }

/** The floor grid size of room `room` (`COCKPIT_GRID_*` for the cockpit, else `ROOM_GRID_*`). */
export function roomGridSize(room: number): { cols: number; rows: number } {
  return room === COCKPIT_ROOM_INDEX
    ? { cols: COCKPIT_GRID_COLS, rows: COCKPIT_GRID_ROWS }
    : { cols: ROOM_GRID_COLS, rows: ROOM_GRID_ROWS };
}

/** Is cell (x, y) a fixed prop spot (always false for a room). It does not check whether the cell is outside the grid — that is asked separately through `roomGridSize`. */
export function roomCellBlocked(room: number, x: number, y: number): boolean {
  if (room !== COCKPIT_ROOM_INDEX) return false;
  for (const r of COCKPIT_BLOCKED_RECTS) if (x >= r.x && x < r.x + r.cols && y >= r.y && y < r.y + r.rows) return true;
  return false;
}

/** Does the rectangle `(x, y, cols, rows)` overlap a fixed prop spot by even one cell. */
export function roomRectBlocked(room: number, x: number, y: number, cols: number, rows: number): boolean {
  if (room !== COCKPIT_ROOM_INDEX) return false;
  for (const r of COCKPIT_BLOCKED_RECTS) {
    if (x < r.x + r.cols && x + cols > r.x && y < r.y + r.rows && y + rows > r.y) return true;
  }
  return false;
}

/** One unmet **facility level requirement** — 「generator Lv.`need` is required but it is Lv.`have` right now」. */
export interface FacilityRequirement {
  facility: FacilityId;
  have: number;
  need: number;
}

export interface HousingRef {
  /**
   * appended (2026-09-12): the facility level requirements that block the **next upgrade** of placed piece `uid` — only the unmet ones (usually one generator).
   * An empty array = the facility levels are no problem (materials · max level are answered separately by `furnitureUpgradeBlock`).
   * ui draws this as a `buildFacilityChip` beside the material chips — the furniture inspector · the station upgrade modal.
   */
  furnitureUpgradeRequirements(uid: string): readonly FacilityRequirement[];
  /** appended (2026-09-12): the unmet facility level requirements for **building** `purpose` in an empty room (the generator Lv.1 gate). */
  purposeRequirements(purpose: RoomPurpose): readonly FacilityRequirement[];
}

/* ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
 * appended: 2026-09-12 — library media (A-3e) · the gym (A-3a). Design · user's decision: docs/DECISIONS.md 「2026-09-12 — 헬스장 · 서재 매체」
 *
 * 1. **Library media.** A disc stand (`disc_stand`) · a record rack (`record_rack`) stand beside the bookshelf (`bookshelf`). The three follow one rule —
 *    shelving a medium in a slot raises the gain multiplier of the skill that medium teaches, and what has been shelved stays in the catalogue. Each medium's share is clamped on its own and added:
 *
 *        share[m] = min(SHELF_GAIN_MAX[m] − 1, SHELF_XP_PER_ITEM[m] × Σ BOOK_RARITY_MUL[rarity])  ×  (aux furniture[m] placed ? 1 + SHELF_AUX_BONUS[m] : 1)
 *        library multiplier = 1 + share[books] + share[discs] + share[records]     ← `getBookBonus(skill)` is now this value (folded into `getSkillGainMul`)
 *
 *    Aux furniture switches on **by being placed alone** (user's spec 「when placed」): the rocking chair → books, the TV → discs, the gramophone · jukebox · turntable → records.
 *    Those three record pieces are one role with different looks, so however many stand there it is multiplied once (user's decision). They all go only in the library (user's decision — on 2026-09-12
 *    the lounge was merged into the library). The rocking chair is a sit toggle on E; the TV · record player are switched on and off with E (no light source — emissive only).
 * 2. **The gym.** The 4 pieces of equipment (`GYM_EQUIPMENT`) open a minigame. A finished session's score goes to `ProgressionRef.applyGymSession` and
 *    becomes the **training bonus counted separately** from stat points (`PlayerProfile.trained`) (user's decision). Finishing a session puts a real-time
 *    `GYM_FATIGUE_HOURS` debuff on that stat (strength = muscle ache · endurance = cardio fatigue), and while it lasts, training the same stat gains −100 %
 *    (using it at all is not blocked). While training, the character takes a pose on the machine and the camera is locked (user's decision —
 *    `PlayerRef.setFurniturePose`, called by hub).
 *
 * Every new `HousingRef` method is optional — the tree type-checks while these are built in parallel, and consumers guard with
 * `typeof h.x === 'function'` as always.
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════════════ */
import {
  BOOKS_PER_SHELF, BOOK_GAIN_MAX, BOOK_XP_PER_BOOK, DISC_GAIN_MAX, DISC_SLOTS_PER_STAND, DISC_XP_PER_ITEM, RECORD_GAIN_MAX,
  RECORD_SLOTS_PER_RACK, RECORD_XP_PER_ITEM, SHELF_AUX_BONUS_BOOK, SHELF_AUX_BONUS_DISC, SHELF_AUX_BONUS_RECORD,
  GAME_DISC_SLOTS_PER_STAND,   // appended (2026-09-13): the game disc stand
} from './constants';
import type { FurniturePoseKind, ItemDef } from './types';
import type { GymStat } from './progression';

/**
 * A medium shelved in a library holder. appended (2026-09-13): `'game'` = a game disc (the game disc stand) — **a holder medium with no effect**,
 * so it is not in `SHELF_MEDIA` (the list the library effects · aux furniture are computed over) but only in `SHELF_HOLDER_MEDIA`.
 */
export type ShelfMedium = 'book' | 'disc' | 'record' | 'game';
/** Media that produce a library effect — the share · aux furniture computation walks **only this list** (no game discs). */
export const SHELF_MEDIA: readonly ShelfMedium[] = ['book', 'disc', 'record'];
/** appended (2026-09-13): every medium a holder takes (`SHELF_MEDIA` + game discs). Shelving · taking out · recovering · slot counts · the holder test walk this list. */
export const SHELF_HOLDER_MEDIA: readonly ShelfMedium[] = ['book', 'disc', 'record', 'game'];
export const SHELF_MEDIUM_LABEL_KO: Readonly<Record<ShelfMedium, string>> = { book: '책', disc: '디스크', record: '레코드', game: '게임 디스크' };

/** Interaction of the holder furniture that takes one medium. */
export const SHELF_INTERACTION: Readonly<Record<ShelfMedium, FurnitureInteraction>> = {
  book: 'bookshelf', disc: 'disc_stand', record: 'record_rack', game: 'game_stand',
};
/**
 * Interaction of the aux furniture that raises that medium's share (for records the gramophone · jukebox · turntable are all `record_player`).
 * A game disc has no aux furniture (`'none'`) — it is not in `SHELF_MEDIA`, so the aux furniture loop never reads this value. This table is never walked with `SHELF_HOLDER_MEDIA`.
 */
export const SHELF_AUX_INTERACTION: Readonly<Record<ShelfMedium, FurnitureInteraction>> = {
  book: 'rocking_chair', disc: 'tv', record: 'record_player', game: 'none',
};
/** Slots in one holder. */
export const SHELF_SLOTS: Readonly<Record<ShelfMedium, number>> = {
  book: BOOKS_PER_SHELF, disc: DISC_SLOTS_PER_STAND, record: RECORD_SLOTS_PER_RACK, game: GAME_DISC_SLOTS_PER_STAND,
};
/** What one copy (volume) adds to the share (× `BOOK_RARITY_MUL[rarity]`). @deprecated 2026-09-13 — replaced by the library series (`shared/library`). */
export const SHELF_XP_PER_ITEM: Readonly<Record<ShelfMedium, number>> = {
  book: BOOK_XP_PER_BOOK, disc: DISC_XP_PER_ITEM, record: RECORD_XP_PER_ITEM, game: 0,
};
/** Cap on `1 + share` per medium (the aux furniture multiplier is applied after the clamp). @deprecated 2026-09-13 — one per kind + the series formula play the cap's part. */
export const SHELF_GAIN_MAX: Readonly<Record<ShelfMedium, number>> = {
  book: BOOK_GAIN_MAX, disc: DISC_GAIN_MAX, record: RECORD_GAIN_MAX, game: 1,
};
/** The extra multiplied into that medium's share when aux furniture is present (`× (1 + value)`). The 2026-09-13 library series still uses it as it is (multiplied into every effect line of the medium). */
export const SHELF_AUX_BONUS: Readonly<Record<ShelfMedium, number>> = {
  book: SHELF_AUX_BONUS_BOOK, disc: SHELF_AUX_BONUS_DISC, record: SHELF_AUX_BONUS_RECORD, game: 0,
};

/** The medium when the piece is a holder, else null. 2026-09-13: the game disc stand (`'game'`) is a holder too. */
export function shelfMediumOfInteraction(interaction: FurnitureInteraction): ShelfMedium | null {
  for (const m of SHELF_HOLDER_MEDIA) if (SHELF_INTERACTION[m] === interaction) return m;
  return null;
}
/** The medium it raises when the piece is aux furniture, else null. */
export function shelfAuxMediumOf(interaction: FurnitureInteraction): ShelfMedium | null {
  for (const m of SHELF_MEDIA) if (SHELF_AUX_INTERACTION[m] === interaction) return m;
  return null;
}
/** The medium and the skill when the item is library media (`ItemDef.book` · `disc` · `record`), else null. */
export function shelfItemOf(def: ItemDef | null | undefined): { medium: ShelfMedium; skill: SkillId } | null {
  if (!def) return null;
  if (def.book) return { medium: 'book', skill: def.book.skill };
  if (def.disc) return { medium: 'disc', skill: def.disc.skill };
  if (def.record) return { medium: 'record', skill: def.record.skill };
  return null;
}

/** Furniture switched on and off with E (`ShipState.toggled`). */
export const TOGGLE_INTERACTIONS: readonly FurnitureInteraction[] = ['tv', 'record_player'];
export function isToggleInteraction(interaction: FurnitureInteraction): boolean {
  return TOGGLE_INTERACTIONS.includes(interaction);
}

/** One skill's library multiplier split per medium (the holder screen · the catalogue · the character sheet's explanation line). */
export interface ShelfBonusInfo {
  /** `1 + Σ parts` — the same value as `getBookBonus(skill)`. */
  total: number;
  /** The share per medium (after the cap clamp and the aux furniture multiplier). */
  parts: Readonly<Record<ShelfMedium, number>>;
  /** Whether that medium's aux furniture is placed on the ship. */
  aux: Readonly<Record<ShelfMedium, boolean>>;
}

export interface ShipState {
  /* ── appended (A-3e, 2026-09-12, version 9) ── */
  /**
   * What is shelved on the disc stand · record rack — the same shape as `PlacedBook`, and `defId` must match that holder's
   * medium (`disc_*` / `record_*`). Books are still `books` (old saves · the visit wire stay compatible).
   */
  media?: PlacedBook[];
  /** The disc · record catalogue: def ids ever shelved (an append-only record like `bookDex`). */
  mediaDex?: string[];
  /** Uids of TVs · record players left switched on. `sanitize` drops a uid that is no longer placed. */
  toggled?: string[];
}

/** The 3 gym minigames — bench press (bar timing) · breath running (후-후-하) · cycling (alternating A/D). */
export type GymMinigame = 'press' | 'breath' | 'cycle';
export const GYM_MINIGAME_LABEL_KO: Readonly<Record<GymMinigame, string>> = {
  press: '벤치프레스', breath: '호흡 달리기', cycle: '사이클링',
};
/**
 * appended (2026-09-19, B-32): the **game disc**'s name for the same three minigames (user's decision
 * 「벤치프레스형 · 호흡형 · 사이클형」) — a disc is named from here, a piece of gym equipment from
 * `GYM_MINIGAME_LABEL_KO` above. It is contract because **two folders print it**: housing's TV and library screens
 * and ui's item tooltip, and a folder may not read another folder's internals (CLAUDE.md §4.1). Until today the
 * tooltip printed the gym name and the library catalogue a third spelling of its own.
 */
export const GAME_MINIGAME_LABEL_KO: Readonly<Record<GymMinigame, string>> = {
  press: '벤치프레스형', breath: '호흡형', cycle: '사이클형',
};
/** A game disc's minigame name — the one spelling every screen prints. `?? kind` only covers an id outside `GymMinigame`. */
export function gameMinigameLabel(kind: GymMinigame): string {
  return GAME_MINIGAME_LABEL_KO[kind] ?? kind;
}

/** What one piece of gym equipment raises, and which minigame · pose it uses. */
export interface GymEquipmentDef {
  stat: GymStat;
  minigame: GymMinigame;
  pose: FurniturePoseKind;
}
export const GYM_EQUIPMENT: Readonly<Partial<Record<FurnitureInteraction, GymEquipmentDef>>> = {
  gym_bench_press: { stat: 'strength', minigame: 'press', pose: 'bench' },
  gym_smith: { stat: 'strength', minigame: 'press', pose: 'bench' },
  gym_treadmill: { stat: 'endurance', minigame: 'breath', pose: 'run' },
  gym_cycle: { stat: 'endurance', minigame: 'cycle', pose: 'cycle' },
};
export function gymEquipmentOf(interaction: FurnitureInteraction): GymEquipmentDef | null {
  return GYM_EQUIPMENT[interaction] ?? null;
}

/** A gym session in progress. */
export interface GymSessionInfo {
  uid: string;
  defId: string;
  stat: GymStat;
  minigame: GymMinigame;
}

export interface HousingRef {
  /* ══ appended (A-3e, 2026-09-12): library media ══ */
  /** The medium when the placed piece is a holder (bookshelf · disc stand · record rack), else null. */
  getShelfMedium?(uid: string): ShelfMedium | null;
  /** Every slot of one holder, always `SHELF_SLOTS[medium]` of them (the same as `getBooks` for a bookshelf). Empty array when it is not a holder. */
  getShelfSlots?(uid: string): BookSlotInfo[];
  /** Take one medium (bag → stash) and shelve it in `slot`. The medium must match that holder. Ship only. Korean reason / null. */
  placeShelfItem?(uid: string, slot: number, defId: string): string | null;
  /** Take the medium in `slot` back into the bag (the stash when there is no space). Korean reason / null. */
  takeShelfItem?(uid: string, slot: number): string | null;
  /** That medium as owned right now (bag + stash), in skill order. */
  getOwnedShelfItems?(medium: ShelfMedium): { defId: string; qty: number }[];
  /** That medium's catalogue (books = `bookDex`, discs · records = that prefix out of `mediaDex`). */
  getShelfDex?(medium: ShelfMedium): readonly string[];
  /** One skill's library multiplier per medium. `total === getBookBonus(skill)`. */
  getShelfBonus?(skill: SkillId): ShelfBonusInfo;
  /** Whether that medium's aux furniture is placed on the ship. */
  hasShelfAux?(medium: ShelfMedium): boolean;
  /** Open the holder screen — shared by the bookshelf · disc stand · record rack (for the bookshelf it may be the same screen as `openBookshelfMenu`). */
  openShelf?(uid: string): void;
  /** Is the TV · record player switched on (`ShipState.toggled`). False for furniture that cannot be switched. */
  isFurnitureOn?(uid: string): boolean;
  /** Flip on / off and return the new state (`housing:furnitureToggled` + a save). null for furniture that cannot be switched. */
  toggleFurniture?(uid: string): boolean | null;

  /* ══ appended (A-3a, 2026-09-12): the gym ══ */
  /** The gym session in progress, null when there is none. */
  readonly gymSession?: GymSessionInfo | null;
  /** Korean reason `startGymSession(uid)` would refuse right now, null = it can start. */
  gymBlock?(uid: string): string | null;
  /**
   * Start a session on gym machine `uid` — opens the minigame screen and emits `housing:gymSession {active:true}` (hub applies the pose · camera).
   * Playing it out sends the score to `ctx.progression.applyGymSession` and raises `housing:gymResult`. Korean reason / null.
   */
  startGymSession?(uid: string): string | null;
  /** End the session in progress with no reward and no debuff (`housing:gymSession {active:false, completed:false}`). A no-op when there is none. */
  cancelGymSession?(): void;
}

/* ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
 * appended: 2026-09-13 — cooking ingredient tiers (docs/DECISIONS.md 「2026-09-13 — 요리 재료 티어」, user's decision)
 *
 * 1. **The analyzer rolls a result table.** A sample is analysed by family (`SampleFamily`), and **the moment it goes in** the result is drawn
 *    from `data/analysis_results.csv`, weighted by that family's analysis level, and written into the slot (`AnalysisSlot.resultDefId` — a failed collection never re-rolls it).
 *    Collecting it raises that family's XP (`ANALYSIS_XP_BY_RARITY`) and a product received for the first time is written into the analysis catalogue (`analysisFound`).
 *    The analysis level shortens the analysis time (`ANALYSIS_TIME_MUL_BY_LEVEL`) and unlocks results (`AnalysisResultDef.minLevel`).
 *    The old 「catalogue progress · prior knowledge → a shorter time」 (`ANALYZE_DEX_SPEEDUP` · `ANALYZE_KNOWN_SPEEDUP`) and the first-analysis bonus were replaced by this.
 * 2. **Soil · media have durability and sockets.** Pouring one consumes the item (as before) and the durability · sockets are held by **the slot**.
 *    It wears with every harvest and is still used at 0, and **the slot never empties by itself** — instead the bonuses (soil match · medium speed · socket speed/yield)
 *    shrink with the durability ratio. Sockets are fitted permanently, as many as the rarity's slot count (`GROW_SOCKETS_BY_RARITY`), and fitting one into a full
 *    slot means destroying the old one with `replaceIndex` (the screen asks first with a 1 s hold). Emptying the slot makes the soil · medium and its sockets go together.
 * 3. **A culture scaffold goes into a culture slot** — medium → (scaffold) → strain. With a scaffold in it the strain's
 *    `StrainDef.scaffoldOutputDefId` (meat of that species) is made and the scaffold is consumed on harvest. It can be taken back out before the strain goes in.
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════════════ */
import { numberMap } from './data/tables';
import { RARITY_ORDER } from './labels';   // 2026-09-16: the result table's `sampleRarity` column · the rarity floor rule
import type { GrowSocketTarget, Rarity, SampleFamily } from './types';
import { SAMPLE_FAMILIES } from './types';

const ANALYSIS_LEVEL_XP_TABLE = numberMap<string>('tables.csv', 'ANALYSIS_LEVEL_XP');
const ANALYSIS_TIME_MUL_TABLE = numberMap<string>('tables.csv', 'ANALYSIS_TIME_MUL_BY_LEVEL');
/** XP added to that family when one analysis is collected, by sample rarity (`data/tables.csv`). */
export const ANALYSIS_XP_BY_RARITY: Readonly<Record<Rarity, number>> = numberMap<Rarity>('tables.csv', 'ANALYSIS_XP_BY_RARITY');
/** Socket slots per soil · medium rarity (`data/tables.csv`). Read it through `growSocketSlotsFor`. */
export const GROW_SOCKETS_BY_RARITY: Readonly<Record<Rarity, number>> = numberMap<Rarity>('tables.csv', 'GROW_SOCKETS_BY_RARITY');

/** The analysis level cap — the row count of the `ANALYSIS_LEVEL_XP` table (5 is never written into the code). */
export const ANALYSIS_LEVEL_MAX: number = Math.max(1, Object.keys(ANALYSIS_LEVEL_XP_TABLE).length);

/** Cumulative XP that reaches `level` (Lv.1 = 0). Out of range it is read clamped. */
export function analysisXpForLevel(level: number): number {
  const lv = Math.max(1, Math.min(ANALYSIS_LEVEL_MAX, Math.floor(level)));
  const v = ANALYSIS_LEVEL_XP_TABLE[String(lv)];
  return Number.isFinite(v) ? v : 0;
}

/** Cumulative XP → the analysis level (1 … `ANALYSIS_LEVEL_MAX`). */
export function analysisLevelForXp(xp: number): number {
  const x = Number.isFinite(xp) ? xp : 0;
  let lv = 1;
  for (let l = 2; l <= ANALYSIS_LEVEL_MAX; l++) if (x >= analysisXpForLevel(l)) lv = l;
  return lv;
}

/** An analysis level's analysis time multiplier (Lv.1 = 1). Multiplied into the sample's `analyzeHours` — fixed the moment it goes in. */
export function analysisTimeMul(level: number): number {
  const lv = Math.max(1, Math.min(ANALYSIS_LEVEL_MAX, Math.floor(level)));
  const v = ANALYSIS_TIME_MUL_TABLE[String(lv)];
  return Number.isFinite(v) && v > 0 ? v : 1;
}

/** One row of the analysis result table (`data/analysis_results.csv`). */
export interface AnalysisResultDef {
  family: SampleFamily;
  /** The lowest analysis level at which this row enters the draw. */
  minLevel: number;
  defId: string;
  qtyMin: number;
  qtyMax: number;
  /** Weight among the unlocked rows of the same family. */
  weight: number;
  /**
   * appended (2026-09-16, user's decision 「the sample's rarity is the floor of the product's rarity」 — that rule in the csv header):
   * left empty, the row goes through the **rarity floor check** (`rarityRank(the rarity of defId) ≥ rarityRank(the sample's rarity)`).
   * Filled in, the row attaches **only to samples of that rarity** and is **exempt** from the floor check — it is the cell for writing 「an
   * unidentified mineral yields quartz whatever its rarity, just more of it the higher the rarity」, and at the same time a guard rail against an empty candidate list at any rarity.
   */
  sampleRarity?: Rarity;
}

export const ANALYSIS_RESULTS: readonly AnalysisResultDef[] = csvRows('analysis_results.csv').map((r) => {
  const qtyMin = r.int('qtyMin', { min: 1 });
  const sampleRarity = r.optEnum('sampleRarity', RARITY_ORDER);
  return {
    family: r.enum('family', SAMPLE_FAMILIES),
    minLevel: r.int('minLevel', { min: 1 }),
    defId: r.str('defId'),
    qtyMin,
    qtyMax: Math.max(qtyMin, r.int('qtyMax', { min: 1 })),
    weight: r.num('weight', { min: 0 }),
    ...(sampleRarity ? { sampleRarity } : {}),
  };
});

/** One family's analysis level (the analysis catalogue header · the analysis screen). */
export interface AnalysisLevelInfo {
  family: SampleFamily;
  level: number;
  /** Cumulative XP. */
  xp: number;
  /** Cumulative XP that reached the current level. */
  levelXp: number;
  /** Cumulative XP of the next level; null at max level. */
  nextLevelXp: number | null;
  /** The current level's analysis time multiplier (`analysisTimeMul`). */
  timeMul: number;
}

/** One result row of the analysis catalogue. */
export interface AnalysisResultInfo {
  defId: string;
  qtyMin: number;
  qtyMax: number;
  minLevel: number;
  /** Is it unlocked at the current level. */
  unlocked: boolean;
  /** Chance one analysis yields this at the current level (0 … 1); 0 while locked. */
  chance: number;
  /** Is this a product that has ever been collected (`ShipState.analysisFound`). */
  found: boolean;
}

export interface AnalysisSlot {
  /* ── appended (2026-09-13) ── */
  /** Family of the sample put in (written the moment it goes in). Absent = an old save — read it off the sample def. */
  family?: SampleFamily;
  /** The result rolled the moment it went in. Absent = an old save — rolled **on collection**, at the level of that moment. */
  resultDefId?: string;
  resultQty?: number;
}

export interface AnalysisSlotInfo {
  /* ── appended (2026-09-13) ── */
  /** Family of the sample in the slot; null for an empty slot. */
  family: SampleFamily | null;
  /**
   * The analysis result — filled in **only on a finished slot** (null while it runs, the screen shows 「?」). On a finished slot `rewardDefId` · `rewardQty` hold the same value and
   * `firstTime` reads as 「this result is not in the analysis catalogue」. An old save's slot (one with no rolled result) is null even when finished and is rolled the moment it is collected.
   */
  resultDefId: string | null;
  resultQty: number;
}

export interface GrowSlot {
  /* ── appended (2026-09-13) ── */
  /** Durability left in the poured soil (0 … `SoilDef.durability`). Absent = an old save — carried over on the first read as `soilUsesLeft / uses × durability`. */
  soilDurability?: number;
  /** Def ids of the fitted sockets (in the order they were fitted). Permanent — they go with the soil when it is emptied. */
  sockets?: string[];
}

export interface GrowSlotInfo {
  /* ── appended (2026-09-13) ── */
  soilDurability: number;
  soilDurabilityMax: number;
  /** The fraction the bonuses apply at = durability / max (0 … 1). 0 with no soil. */
  soilBonusRatio: number;
  /** Def ids of the fitted sockets. */
  sockets: readonly string[];
  /** This soil's socket slots (`growSocketSlotsFor(the soil's rarity)`); 0 with no soil. */
  socketSlots: number;
}

export interface CultureSlot {
  /* ── appended (2026-09-13) ── */
  /** Durability left in the poured medium. Absent = an old save — carried over on the first read as `mediumUsesLeft / uses × durability`. */
  mediumDurability?: number;
  /** Def ids of the fitted sockets (in the order they were fitted). Permanent — they go with the medium when it is emptied. */
  sockets?: string[];
  /** Def id of the culture scaffold in it (`ItemDef.scaffold`). Consumed on harvest. */
  scaffoldDefId?: string;
}

export interface CultureSlotInfo {
  /* ── appended (2026-09-13) ── */
  mediumDurability: number;
  mediumDurabilityMax: number;
  /** The fraction the bonuses apply at = durability / max (0 … 1). 0 with no medium. */
  mediumBonusRatio: number;
  sockets: readonly string[];
  socketSlots: number;
  /** null = no scaffold. With one in it and a strain inserted, `yieldDefId` is the meat of that species. */
  scaffoldDefId: string | null;
}

export interface ShipState {
  /* ── appended (2026-09-13, version 11) ── */
  /** Cumulative analysis XP per family (absent = 0). */
  analysisXp?: Partial<Record<SampleFamily, number>>;
  /** The analysis catalogue: def ids of products ever collected from an analyzer (append-only). */
  analysisFound?: string[];
}

export interface HousingRef {
  /* ══ appended: 2026-09-13 — cooking ingredient tiers ══ */
  /** One family's analysis level · XP · time multiplier. */
  getAnalysisLevel(family: SampleFamily): AnalysisLevelInfo;
  /** A family's whole result table (in minimum-level order), with the chance · unlock · catalogue state at the current level. */
  getAnalysisResults(family: SampleFamily): AnalysisResultInfo[];
  /** The analysis catalogue (`ShipState.analysisFound`). */
  getAnalysisFound(): readonly string[];
  /**
   * Fit one socket (bag → stash) into poured soil. The socket's `target` must be `'soil'`. With no empty socket slot left,
   * `replaceIndex` has to be given and the old socket in that place is **destroyed** (the screen asks first with a 1 s hold). It does not
   * apply retroactively to a crop already growing — it takes effect from the next crop planted. Korean reason / null.
   */
  insertGrowSocket(uid: string, tier: GrowTier, slot: number, socketDefId: string, replaceIndex?: number): string | null;
  /** Fit a socket into a culture slot that holds a medium (`target: 'medium'`). The rules are the same as `insertGrowSocket`. */
  insertCultureSocket(uid: string, slot: number, socketDefId: string, replaceIndex?: number): string | null;
  /** Put one culture scaffold (bag → stash) into a slot that has a medium and no strain · scaffold. Korean reason / null. */
  insertScaffold(uid: string, slot: number, scaffoldDefId: string): string | null;
  /** Take back a scaffold from before the strain went in (`dest` defaults to `'bag-first'`). Korean reason / null. */
  takeScaffold(uid: string, slot: number, dest?: HarvestDestination): string | null;
  /** Sockets owned right now (bag + stash). Given a `target`, only that side. */
  getOwnedSockets(target?: GrowSocketTarget): { defId: string; qty: number }[];
}

/** Durability the poured soil · medium loses per harvest (`data/tuning.csv`). */
export const SOIL_WEAR_PER_HARVEST = T.num('SOIL_WEAR_PER_HARVEST');
export const MEDIUM_WEAR_PER_HARVEST = T.num('MEDIUM_WEAR_PER_HARVEST');
/** Floor of the growth · culture time multiplier summed from the sockets' `speed`. */
export const GROW_SOCKET_TIME_FLOOR = T.num('GROW_SOCKET_TIME_FLOOR');
/** Floor of the wear multiplier summed from the sockets' `wear`. */
export const GROW_WEAR_MUL_FLOOR = T.num('GROW_WEAR_MUL_FLOOR');

/** Socket slots of a soil · medium rarity. 0 for a rarity that is not in the table. */
export function growSocketSlotsFor(rarity: Rarity): number {
  const v = GROW_SOCKETS_BY_RARITY[rarity];
  return Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
}
/** The most socket slots any rarity can have (the cap for save validation). */
export const GROW_SOCKET_SLOTS_MAX: number = Math.max(0, ...Object.values(GROW_SOCKETS_BY_RARITY).map((v) => (Number.isFinite(v) ? Math.floor(v) : 0)));
/* ══ end 2026-09-13 cooking ingredient tiers ══ */

/* ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
 * appended: 2026-09-16 — the sample rework (user's decision, the numbers are the five `ANALYSIS_*` rows of `data/constants.csv`)
 *
 * 1. **The sample's rarity is the floor of the product's rarity** (the comment above `AnalysisResultDef.sampleRarity` · the `data/analysis_results.csv` header).
 * 2. **The analysis time speedup became two terms** — the old `ANALYZE_DEX_SPEEDUP` · `ANALYZE_KNOWN_SPEEDUP` are read by nobody:
 *      speedup = min(ANALYSIS_SPEEDUP_CAP, catalogue entries of the same rarity × ANALYSIS_DEX_BONUS_PER_ENTRY + the sample level bonus)
 *      the sample level bonus = level 0 → 0 · level n≥1 → ANALYSIS_SAMPLE_LEVEL_FIRST + (n − 1) × ANALYSIS_SAMPLE_LEVEL_STEP
 *    The family's analysis level time multiplier (`analysisTimeMul`) is multiplied in **separately** from this speedup.
 * 3. **The sample level is kept per sample** (`ShipState.sampleLevels`) — it is how many times that sample has been collected.
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════════════ */

export interface ShipState {
  /* ── appended (2026-09-16, version 14) ── */
  /**
   * Sample def id → its **analysis level** (= how many times that sample was collected, 1 … `ANALYSIS_SAMPLE_LEVEL_MAX`). A missing key = level 0.
   * There is no migration (user's decision) — every old save starts stacking again from level 0.
   */
  sampleLevels?: Record<string, number>;
}

/** One sample's analysis speedup state (the analysis screen reads it as `Lv.n · −x %`). */
export interface SampleAnalysisInfo {
  defId: string;
  /** The sample's rarity — the axis the catalogue bonus is grouped on, and the floor of the product's rarity. */
  rarity: Rarity;
  /** 0 … `ANALYSIS_SAMPLE_LEVEL_MAX`. 0 = never collected yet. */
  level: number;
  maxLevel: number;
  /** Analysis catalogue entries of this rarity (the products of that rarity among `analysisFound`). */
  dexEntries: number;
  /** The speedup the catalogue entries give (before the cap). */
  dexBonus: number;
  /** The speedup the sample level gives (before the cap). */
  levelBonus: number;
  /** The speedup actually multiplied in, 0 … `ANALYSIS_SPEEDUP_CAP` — the analysis time is `× (1 − speedup)`. */
  speedup: number;
}

export interface HousingRef {
  /* ══ appended: 2026-09-16 — the sample rework ══ */
  /** This sample's level · catalogue entries · the analysis speedup on it right now. null when it is not a sample. */
  getSampleAnalysis?(defId: string): SampleAnalysisInfo | null;
  /** The analysis catalogue (`analysisFound`) entry count per product **rarity** — exactly the axis the catalogue bonus is grouped on. */
  getAnalysisDexByRarity?(): Readonly<Record<Rarity, number>>;
}

/* ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
 * appended: 2026-09-13 — cooking minigames (docs/DECISIONS.md 「2026-09-13 — 요리 미니게임」, user's decision — the rules · tables are in `shared/cooking.ts`)
 *
 * E on the cook bench → the **cook bench screen** (`openCookStation`) — the meal list · ingredients · minigame order · auto appliances · the ship stash / bag cards.
 * 「조리 시작」 (`startCook`) → the pose at the cook bench + a locked camera (hub, `housing:cookSession`) + the minigame overlay → per step
 * 「직접 하기 / 자동」 → at the end the ingredients are taken and one meal with a quality on it is made (`InventoryRef.completeCook`) → the result → `housing:cookResult`.
 * Closing it midway (`cancelCook` · Esc · Tab · a phase change) consumes nothing. Ship only · own ship only · one at a time.
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════════════ */
import type { CookAutoInfo, CookGame, CookSessionInfo } from './cooking';

export interface HousingRef {
  /** Open the cook bench screen (`uid` = the cook bench furniture). Only a toast when it is not a cook bench, or in a raid · on someone else's ship. */
  openCookStation?(uid: string): void;
  /** The cook in progress (while the minigame overlay is open), null when there is none. */
  readonly cookSession?: CookSessionInfo | null;
  /**
   * Korean reason `recipeId` cannot be started on cook bench `uid` right now, null = it can start.
   * In order: not a cook bench → not the ship · not my ship → already cooking → not a meal recipe / it has no steps → `InventoryRef.cookBlock` (bench level · skill · ingredients · space).
   */
  cookBlock?(uid: string, recipeId: string): string | null;
  /** Start the cook — opens the overlay and emits `housing:cookSession {active:true}`. Korean reason / null. The ingredients are taken **at the end**. */
  startCook?(uid: string, recipeId: string): string | null;
  /** End the cook in progress with nothing consumed (`housing:cookSession {active:false, completed:false}`). A no-op when there is none. */
  cancelCook?(): void;
  /** The highest-level auto-cook appliance placed on the ship that stands in for that game, null when there is none. */
  getCookAuto?(game: CookGame): CookAutoInfo | null;
}
/* ══ end 2026-09-13 cooking minigames ══ */

/* ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
 * appended: 2026-09-13 — furniture placement rules · generator power · crypto mining (docs/DECISIONS.md 「2026-09-13 — 가구 접근 면 · 발전기 · 암호화폐 채굴」, user's decision)
 *
 * 1. **Placement rules** (`FurnitureDef.access`). A piece's front is local −Z — on the grid, yaw 0 = y decreasing · 1 = x increasing · 2 = y increasing · 3 = x decreasing.
 *    - `front` — the row in front (as wide as the piece, 1 cell deep) must hold no other furniture, and must not be outside the grid (a wall) either. Interaction only from the front.
 *    - `sides` — one row on each of the two wide faces (local ±Z — the csv is written with cols ≥ rows) must hold no other furniture. A wall is allowed. From either face.
 *    - `all`   — one row on each of the four faces (corner cells excluded) must hold no other furniture. A wall is allowed. From any face (gym machines).
 *    - `none`  — as before (only the bodies must not overlap).
 *    Cells that must stay clear may overlap each other (two workbenches facing each other share a 1-cell passage). A fixed cockpit prop spot (`COCKPIT_BLOCKED_RECTS`) blocks like furniture.
 *    The rule works both ways — my body must not enter someone else's cells that have to stay clear either. A piece in an old save that breaks the rule goes **into furniture storage** on load
 *    (user's decision — `ShipState.sanitize` checks them in the order it accepted them).
 * 2. **Power — retired (the same day, user's decision 「the power allocation system is too harsh」).** Manual allocation · disabling · stopped clocks were all torn out. The generator
 *    starts at Lv.1 and rises to Lv.5 (`GENERATOR_START_LEVEL` · `GENERATOR_MAX_LEVEL`) and does only two things — ① it is the **build condition** of the higher facilities
 *    (`purposeGeneratorLevel` — Lv.2 greenhouse · kitchen / Lv.3 lab / Lv.4 gym · library / Lv.5 mining facility), ② as before it gates furniture · stash upgrades
 *    (raising something to Lv.n needs generator Lv.n). The power names below are kept only because they are contract. `furnitureOperationalBlock` answers only 「a compute cluster with no main computer」.
 * 3. **Crypto mining.** The mining facility (`mining`) holds compute clusters (`compute_cluster` — 1×2 cells, several of them) and the main computer (`mining_computer` — one per ship).
 *    Each cluster is given a coin, and up to `COMPUTE_CLUSTER_MAX_CORES` **processors** (2026-09-16 user's decision — the old compute cores) are inserted into it.
 *    A cluster mines only **while the main computer is placed** (user's decision — before power was dropped this was 「running」).
 *    The clock is one per cluster (it does not run per processor the way a grow slot does) — the cycle comes out of the **sum of the performance** of the inserted processors (`processorPerf`).
 *    Every time a cycle ends `yieldUnits` goes into the **wallet** (`cryptoWallet`) by itself, and on the spot every inserted processor wears by
 *    `PROCESSOR_WEAR_PER_CYCLE` (the more worn the slower, down to half at durability 0 — repair is at a ship workbench). When the processors change,
 *    the progress is folded and carried on at the new cycle length; when the coin changes, the progress goes to 0.
 *    The main computer = cluster status · the wallet · the exchange (the server price chart · buy · sell — a locked coin still shows its chart).
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════════════ */
import type { CryptoCoinDef } from './crypto';
import type { CryptoTradeSide } from './cryptoMarket';

/* ── 1. Placement rules ── */

export type FurnitureAccess = 'none' | 'front' | 'sides' | 'all';
export const FURNITURE_ACCESS_VALUES: readonly FurnitureAccess[] = ['none', 'front', 'sides', 'all'];
/** The four faces of a piece. `front` = local −Z, `back` = +Z, `right` = local +X, `left` = local −X (names for the grid maths). */
export type FurnitureFace = 'front' | 'back' | 'right' | 'left';

export interface FurnitureDef {
  /** appended (2026-09-13): the access face rule (`access` in `data/furniture.csv`). Absent = `'none'`. */
  access?: FurnitureAccess;
  /** appended (2026-09-13): what it adds to its facility's required power while active (`power`). Absent = 0. */
  power?: number;
  /** appended (2026-09-13): utility furniture that may still be built several times (`multi` — the compute cluster). Absent = the 「already owned」 rule. */
  multi?: boolean;
}

export function furnitureAccessOf(def: FurnitureDef | null | undefined): FurnitureAccess {
  return def?.access ?? 'none';
}

/** The faces the rule says to keep clear (= the faces it can be interacted from). */
export function furnitureAccessFaces(access: FurnitureAccess): readonly FurnitureFace[] {
  switch (access) {
    case 'front': return ['front'];
    case 'sides': return ['front', 'back'];
    case 'all': return ['front', 'back', 'right', 'left'];
    default: return [];
  }
}

/** May a cell that must stay clear be outside the grid (a wall) — only `front` may not. */
export function accessAllowsWall(access: FurnitureAccess): boolean {
  return access !== 'front';
}

const FACE_LOCAL: Readonly<Record<FurnitureFace, readonly [number, number]>> = {
  front: [0, -1], back: [0, 1], right: [1, 0], left: [-1, 0],
};

/**
 * The grid direction a face turned by `yaw` points in (`dx` = grid x, `dy` = grid y, exactly one of them ±1).
 * Why: grid x = world +X, y = world +Z, world rotation = −yaw·π/2 (`hub/interiors/RoomLayout`) — one yaw step takes (x, z) → (−z, x).
 */
export function furnitureFaceDir(yaw: 0 | 1 | 2 | 3, face: FurnitureFace): { dx: number; dy: number } {
  let [x, z] = FACE_LOCAL[face];
  for (let i = 0; i < yaw; i++) { const nx = -z; z = x; x = nx; }
  return { dx: x, dy: z };
}

/** One cell a piece asks to be kept clear. It may be a coordinate outside the grid (a wall). */
export interface ClearanceCell { x: number; y: number; face: FurnitureFace }

/**
 * Every cell `def` placed at (x, y, yaw) asks to be kept clear — per access face, one row 1 cell deep against the body, with no corner cells. Empty array for `none`.
 * Cells outside the grid are returned as they are (whether a wall is allowed is asked separately with `accessAllowsWall`).
 */
export function furnitureClearanceCells(def: FurnitureDef, x: number, y: number, yaw: 0 | 1 | 2 | 3): ClearanceCell[] {
  const fp = furnitureFootprint(def, yaw);
  const out: ClearanceCell[] = [];
  for (const face of furnitureAccessFaces(furnitureAccessOf(def))) {
    const { dx, dy } = furnitureFaceDir(yaw, face);
    if (dy !== 0) {
      const cy = dy < 0 ? y - 1 : y + fp.rows;
      for (let cx = x; cx < x + fp.cols; cx++) out.push({ x: cx, y: cy, face });
    } else {
      const cx = dx < 0 ? x - 1 : x + fp.cols;
      for (let cy = y; cy < y + fp.rows; cy++) out.push({ x: cx, y: cy, face });
    }
  }
  return out;
}

/* ── 2. Power — **retired** (2026-09-13, the same day, user's decision 「remove the power allocation system」) ──
 * The generator is now only the **build condition of the higher facilities** (`ROOM_PURPOSE_GENERATOR_LEVEL`) and the furniture · stash upgrade gate. There is no allocation,
 * no disabling and no stopped clock, and the names below are kept only because the contract is 「add-only」 (the same treatment as `airstrike` · `damageReduction`) — housing
 * implements no power API and raises neither `housing:powerChanged` nor `housing:operationalChanged`. The tables (`GENERATOR_POWER_BY_LEVEL` · a purpose's `power` · a piece's `power` ·
 * `COMPUTE_CLUSTER_POWER_PER_CORE` · `POWER_AUTO_TOPUP`) were deleted from the csv. */

/** Retired — always an empty table. */
export const GENERATOR_POWER_BY_LEVEL: readonly number[] = Object.freeze([]);

/** Retired — always 0. */
export function generatorPowerSupply(_level: number): number {
  return 0;
}

/** Retired — an empty table (a read gives undefined). */
export const ROOM_PURPOSE_POWER: Readonly<Record<RoomPurpose, number>> = Object.freeze({}) as Record<RoomPurpose, number>;

/** Retired — always 0. */
export const COMPUTE_CLUSTER_POWER_PER_CORE = 0;

/** Retired — nobody returns it. */
export const POWER_SHORT_REASON_KO = '전력이 부족합니다';
/** Retired — nobody returns it. */
export const FURNITURE_DISABLED_REASON_KO = '비활성화된 가구입니다';
/** Reason a compute cluster cannot mine — the ship has no main computer (still used after power was dropped on 2026-09-13: `HousingRef.furnitureOperationalBlock`). */
export const MINING_COMPUTER_REQUIRED_REASON_KO = '채굴 시설에 메인 컴퓨터가 있어야 합니다';
/** Retired — always false. */
export const POWER_AUTO_TOPUP = false;

/** One piece's power state. */
export interface FurniturePowerInfo {
  uid: string;
  defId: string;
  /** Required power while active (cores included). It is shown even while inactive — it just does not enter the required sum. */
  demand: number;
  disabled: boolean;
  /** Is it working right now (active · the facility has enough power · the piece's own extra condition — the main computer for a cluster). */
  operational: boolean;
  /** Korean reason it is not working, null while it is. */
  block: string | null;
}

/** One facility's (room's) power state. The cockpit · an empty room are not in it. */
export interface FacilityPowerInfo {
  room: number;
  purpose: RoomPurpose;
  /** `ROOM_PURPOSE_POWER[purpose]`. */
  base: number;
  /** base + the sum of the active pieces' demand. */
  required: number;
  /** The power the player allocated. */
  allocated: number;
  /** allocated ≥ required. */
  powered: boolean;
  /** The pieces placed in this room that use power (demand > 0) — inactive ones included. */
  furniture: FurniturePowerInfo[];
}

export interface PowerOverview {
  /** `generatorPowerSupply(state.generatorLevel)`. */
  supply: number;
  /** The sum of the allocations. */
  allocated: number;
  /** supply − allocated (≥ 0). */
  free: number;
  /** The sum of every facility's required (compared against the supply to warn that the generator needs an upgrade). */
  required: number;
  facilities: FacilityPowerInfo[];
}

/* ── 3. Crypto mining ── */

export const COMPUTE_CLUSTER_DEF_ID = 'furn_compute_cluster';
export const MINING_COMPUTER_DEF_ID = 'furn_mining_computer';
/**
 * The **processor** inserted into a compute cluster (items/ defines it — made at the mixer from 1 crystal core + 4 circuit boards).
 * 2026-09-16 (user's decision): the compute core, the step in between, is gone and this goes straight into the cluster. It is gear with a
 * `durabilityMax`, so it wears every cycle (`PROCESSOR_WEAR_PER_CYCLE`), slows down as it wears (`PROCESSOR_PERF_MIN`) and is repaired at a ship workbench.
 */
export const PROCESSOR_DEF_ID = 'mat_processor';
/**
 * @deprecated 2026-09-16 — the compute core (`mat_compute_core`) **is gone** from the item table (the processor goes in directly).
 * The contract is add-only, so the name stays; looking an item up by this id gives `undefined`. New code uses `PROCESSOR_DEF_ID`.
 */
export const COMPUTE_CORE_DEF_ID = 'mat_compute_core';

/** Performance of a processor at durability 0 (1 = brand new). Even worn out it still does half the work — `data/tuning.csv`. */
export const PROCESSOR_PERF_MIN = T.num('PROCESSOR_PERF_MIN');
/** Durability **each inserted processor** loses when one mining cycle ends — `data/tuning.csv`. */
export const PROCESSOR_WEAR_PER_CYCLE = T.num('PROCESSOR_WEAR_PER_CYCLE');

/**
 * One processor's performance (0.5 … 1) — **linear** (user's decision): `PROCESSOR_PERF_MIN + (1 − PROCESSOR_PERF_MIN) × (left ÷ max)`.
 * A cluster's speed is the **sum** of this value over its inserted processors, so **a worn-out processor is worth half a new one**.
 * A `max` of 0 or below (an item with no durability) is taken as brand new.
 */
export function processorPerf(durability: number, max: number): number {
  if (!(max > 0)) return 1;
  const ratio = Math.max(0, Math.min(1, (Number.isFinite(durability) ? durability : max) / max));
  return PROCESSOR_PERF_MIN + (1 - PROCESSOR_PERF_MIN) * ratio;
}

/** One compute cluster's mining state. A cluster with neither a processor nor a coin need not be in `ShipState.clusters` at all. */
export interface ComputeClusterSlot {
  /** The compute cluster's `PlacedFurniture.uid`. */
  uid: string;
  /** Id of the coin to mine (`data/crypto.csv`). With none it does not mine. */
  coinId?: string;
  /**
   * 2026-09-16 (user's decision 「processors go in directly · a processor has durability」):
   * **the durability left in the processor of each slot. An empty slot is null.** Its length is ≤ `COMPUTE_CLUSTER_MAX_CORES` and
   * **the index is the cell of the UI grid** — which is what lets the worn-out processor in slot 3 be taken out on its own.
   * (The old `cores` was a single count: the cores were identical, so counting them was enough.)
   */
  processors: (number | null)[];
  /** @deprecated 2026-09-16 — the old 「number of compute cores inserted」. The only reader is the save cleanup (`sanitizeClusters`); a new save has none. */
  cores?: number;
  /** Progress accumulated up to the `segmentAt` moment (in cycles, 0 ≤ p < 1 — an overflowing cycle goes into the wallet and is subtracted). */
  progress: number;
  /** Epoch ms the current segment started (on `stationNow`). A change of processors · coin · running state folds the progress and opens a new one. */
  segmentAt: number;
}

export interface ShipState {
  /* ── appended (2026-09-13, power — version 12) · **retired** (the same day, v13 — power allocation dropped): housing neither reads nor writes them ── */
  /** Retired — it was the facility's power allocation. */
  powerAlloc?: Record<string, number>;
  /** Retired — it was the uids of disabled furniture. */
  disabledFurniture?: string[];
  /** Retired — it was the stop time of a stopped clock piece. */
  pausedAt?: Record<string, number>;
  /* ── appended (2026-09-13, crypto mining) ── */
  clusters?: ComputeClusterSlot[];
  /** The wallet: coin id → unit count (`CRYPTO_UNITS_PER_COIN` units = 1 coin). */
  cryptoWallet?: Record<string, number>;
  /** Cumulative units mined so far (for the status screen). */
  cryptoMined?: Record<string, number>;
}

/** One cluster as the screen sees it. */
export interface ComputeClusterInfo {
  uid: string;
  room: number;
  coinId: string | null;
  /** The **number** of processors inserted (for the rail dots · the 「n/m」 readout — the speed is `perf`, not the count). */
  cores: number;
  maxCores: number;
  /* ── appended (2026-09-16, processors fitted directly) ── */
  /** The durability left per slot, null for an empty slot. Length = `maxCores` — the index is the cell of the screen's grid. */
  processors: readonly (number | null)[];
  /** Max durability of one processor (`ItemDef.durabilityMax`) — the denominator of the durability bar. 0 when the table cannot be read. */
  processorMax: number;
  /** The sum of `processorPerf` over the inserted processors — the cycle comes out of this value (a worn-out one is worth half a new one). */
  perf: number;
  /** The cycle of the current setup (ms). 0 with 0 cores · no coin. */
  cycleMs: number;
  /** Progress of this cycle, 0 … 1 (0 while it is not mining — where it stopped when it stopped). */
  progress: number;
  /** Seconds left in this cycle (0 while it is not mining). */
  remainingS: number;
  /** Is the clock running right now (coin · cores · running · main computer all satisfied). */
  mining: boolean;
  /** Korean reason it is not running (no coin picked · no cores · power · inactive · the main computer · a locked coin), null while it runs. */
  block: string | null;
  /**
   * This cluster's required power (cores included). **Dead since 2026-09-13** (power allocation removed, user's
   * decision): the implementation always reports 0 and nothing in `src/` reads it. It stays because `src/shared`
   * is add-only (CLAUDE.md §4.1) and a required field cannot be dropped without a decision — do not start
   * feeding it, and do not read it (`src/housing/README.md` records the same limit).
   */
  power: number;
}

/** One coin as the screen sees it. */
export interface CryptoCoinInfo {
  def: CryptoCoinDef;
  unlocked: boolean;
  /** Why it is locked (`<기업> 퀘스트 「…」 완료 필요`), null once it is open. */
  lockReason: string | null;
  walletUnits: number;
  /** The server price (credits per coin), null while not connected to the server. */
  price: number | null;
  /** The 24-hour change (as a ratio), null when unknown. */
  change24h: number | null;
}

export type MiningComputerTab = 'clusters' | 'wallet' | 'exchange';

/** An exchange quote. `credits` = the credits received on a sell · paid on a buy (fee included, `cryptoCreditsFor`). */
export interface CryptoQuote {
  coinId: string;
  side: CryptoTradeSide;
  units: number;
  price: number;
  credits: number;
  /** Korean reason the trade is blocked (no server · locked · not enough in the wallet · not enough credits · the unit range), null when it can go through. */
  block: string | null;
}

export interface HousingRef {
  /* ══ appended: 2026-09-13 — placement rules ══ */
  /**
   * Korean reason placing (room, defId, x, y, yaw) is blocked, null = it can be placed. It is the **same judgement** as `canPlace`, only with the reason
   * (overlap · outside the grid · a wall in front · the front · a wide face · all four cells blocked · it blocks another piece's access cell …). The housing mode ghost · refusal toast use it.
   */
  placementBlock?(room: number, defId: string, x: number, y: number, yaw: 0 | 1 | 2 | 3, ignoreUid?: string): string | null;

  /* ══ appended: 2026-09-13 — power · **retired** (the same day, user's decision 「remove the power allocation system」) ══
     housing **does not implement** the power queries · commands below (the names stay because the contract is add-only). Callers already ask with `typeof … === 'function'`. */
  /** Retired — not implemented. */
  getPowerOverview?(): PowerOverview;
  /** Retired — not implemented. */
  getFacilityPower?(room: number): FacilityPowerInfo | null;
  /** Retired — not implemented. */
  setPowerAllocation?(room: number, amount: number): string | null;
  /** Retired — not implemented. */
  isFurnitureDisabled?(uid: string): boolean;
  /** Retired — not implemented. */
  setFurnitureDisabled?(uid: string, disabled: boolean): string | null;
  /**
   * Korean reason this piece cannot be used right now, null when it can. Since power was dropped on 2026-09-13 it is only **a compute cluster with no
   * main computer** (`MINING_COMPUTER_REQUIRED_REASON_KO`); for every other piece it is always null.
   */
  furnitureOperationalBlock?(uid: string): string | null;
  /** The 「now」 of a clock piece — since power was dropped on 2026-09-13 nothing stops, so it is always `serverNow`. */
  stationNow?(uid: string): number;
  /** Retired — not implemented (a workbench does not stop — use `getBenchLevel`). */
  getOperationalBenchLevel?(kind: WorkbenchKind): number;
  /** Retired — not implemented. */
  benchOperationalBlock?(kind: WorkbenchKind): string | null;

  /* ══ appended: 2026-09-13 — crypto mining ══ */
  getCryptoCoins?(): CryptoCoinInfo[];
  getCryptoWallet?(): Readonly<Record<string, number>>;
  /** Uid of the main computer placed on the ship (null when there is none). */
  getMiningComputerUid?(): string | null;
  getComputeClusters?(): ComputeClusterInfo[];
  getComputeCluster?(uid: string): ComputeClusterInfo | null;
  /** Pick the coin to mine (null = clear it). A locked coin is refused. A coin change puts the progress at 0. Korean reason / null. `housing:clusterChanged`. */
  setClusterCoin?(uid: string, coinId: string | null): string | null;
  /**
   * Insert `qty` processors (from the bag → the stash) — only as many as there are empty slots, **the highest durability first**. The progress is folded and carried into the new cycle.
   * 2026-09-16: the name stays because it is contract, but what goes in is `PROCESSOR_DEF_ID`, not a compute core. Korean reason / null.
   */
  insertClusterCores?(uid: string, qty: number): string | null;
  /** Take out `qty` processors — **from the back slots**, carrying their durability with them (`dest` defaults to `'bag-first'`; refused when there is no space). Korean reason / null. */
  removeClusterCores?(uid: string, qty: number, dest?: HarvestDestination): string | null;
  /* ── appended (2026-09-16, processors fitted directly): the pair that names a slot — the screen's grid uses these ── */
  /**
   * Insert one processor into **slot `slot`**. Given an `itemUid` it inserts **that exact instance** from the bag · stash (the one dragged onto it),
   * and without one it inserts the highest-durability one. An already-full slot · a slot that does not exist · having no processor give a Korean reason. null on success.
   */
  insertClusterProcessor?(uid: string, slot: number, itemUid?: string): string | null;
  /** Take the processor out of **slot `slot`** with its durability intact and hand it to `dest` (default `'bag-first'`). Korean reason / null. */
  removeClusterProcessor?(uid: string, slot: number, dest?: HarvestDestination): string | null;
  /** A quote at the current server price. null when the coin is unknown. */
  cryptoQuote?(coinId: string, side: CryptoTradeSide, units: number): CryptoQuote | null;
  /** Trade — the credits are validated by the server (`cbuy` · `csell`) and the wallet changes only on success. Korean reason / null. `housing:walletChanged`. */
  tradeCrypto?(coinId: string, side: CryptoTradeSide, units: number): Promise<string | null>;
  /** The compute cluster screen (pick the coin · the 9 core slots · the ship stash / bag). */
  openComputeCluster?(uid: string): void;
  /** The main computer screen. `uid` null = the ship's main computer (a toast when there is none). */
  openMiningComputer?(uid: string | null, tab?: MiningComputerTab): void;
}
export interface HousingRef {
  /* ══ appended: 2026-09-13 — crypto mining, for development (the console `crypto`, smokes) ══ */
  /** Dev only: set the wallet balance to `units` (whole units) — `housing:walletChanged {reason: 'cheat'}`. A Korean reason for an unknown coin. */
  devSetCryptoWallet?(coinId: string, units: number): string | null;
  /** Dev only: set a compute cluster's cores to `cores` with no items (banking the finished cycles and folding the progress). Korean reason / null. */
  devSetClusterCores?(uid: string, cores: number): string | null;
  /** Dev only: wind the clock of every cluster that can mine (an open coin + cores) forward by `hours` and bank the finished cycles. Returns the units banked. */
  devAdvanceMining?(hours: number): number;
  /* ── appended: 2026-09-15 2nd pass (the analyzer analysis-time cheat) ── */
  /**
   * Dev only: wind the analysis clock of the placed analyzers (`uid` omitted = all of them) forward by `hours` and return **how many slots finished this time**.
   * It does not collect them (the same grain as `devAdvanceMining`). The console `analyze ff <hours>` · `analyze done [uid|all]` are its only consumers.
   */
  devAdvanceAnalysis?(hours: number, uid?: string): number;
}
/* ══ end 2026-09-13 placement rules · power · crypto mining ══ */

/* ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
 * appended: 2026-09-13 — library series · video games (docs/DECISIONS.md 「2026-09-13 — 서재 시리즈 · 비디오게임」 — the source of the effect · series rules is `shared/library.ts`)
 *
 * 1. **Library series.** The bookshelf · disc stand · record rack · game disc stand may be built **several times** (`FurnitureDef.multi`). A shelved medium is
 *    counted **once per kind (def)**, and the sum is the series share (`librarySeriesFraction`) × the effect line (the full-series value) × the aux furniture multiplier → `getLibraryEffects()`.
 *    `getSkillGainMul(skill)` = `getBookBonus(skill)` = 1 + `skillGain[skill]` (the progression path unchanged). The old rarity weights · per-medium caps are retired.
 * 2. **The band.** `isShelfItemWanted` is true while a holder for that medium is owned (placed · in furniture storage) and that kind is shelved in no holder.
 * 3. **Recipe books.** A `recipe` effect opens its recipe **only while that book is shelved** (`isRecipeUnlocked`).
 * 4. **Video games.** A console is attached to the TV (`tvConsoles`), and the discs shelved on a game disc stand whose console matches are played.
 *    When a seat in front of the TV (`SEAT_INTERACTIONS`) faces the TV and no non-`low` furniture stands in the passage between them, it is played sitting there (`getTvSeat`).
 *    2026-09-17 (user's decision): a seat is **not a condition** — with none it is played standing (`tvSeatBlock` is only why a seat cannot be used; it does not block the game).
 *    The result is the same `ProgressionRef.applyGymSession(stat, score)` as the gym (a 24 h debuff per stat — user's decision).
 *
 * Every new `HousingRef` method is optional — the tree type-checks while these are built in parallel, and consumers guard with `typeof h.x === 'function'`.
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════════════ */
import type { GameSessionInfo, LibraryEffectKind, LibraryEffectsSummary, LibrarySourceInfo, PlayableGameInfo } from './library';

export interface FurnitureDef {
  /** appended (2026-09-13): **low furniture** that does not block the view (`low` in `data/furniture.csv` — the low table · the rug). The TV ↔ seat passage test skips it. */
  low?: boolean;
}

/** The console attached to one TV. */
export interface TvConsoleSlot {
  /** Uid of the placed TV. */
  uid: string;
  /** Def id of an item that has `ItemDef.gameConsole`. */
  defId: string;
}

export interface ShipState {
  /** appended (2026-09-13): the console attached per TV (one per TV). `sanitize` hands the console of a TV that is no longer placed back to the ship stash. Game discs live in `media`. */
  tvConsoles?: TvConsoleSlot[];
}

export interface HousingRef {
  /* ══ appended (2026-09-13): library series ══ */
  /** Every library effect summed over the working holders · aux furniture (on the ship's state — unchanged during a raid too). `housing:libraryChanged` when it changes. */
  getLibraryEffects?(): LibraryEffectsSummary;
  /**
   * The series that give a value to one effect target — the character sheet's `시설 ×n` tooltip · the item tooltip. `target` is the effect line's target string
   * (`('skillGain', 'carry')` · `('derived', 'maxStamina')` · `('raidXp', '')` · `('trustXp', 'all')` …). Series whose value is 0 are left out.
   */
  getLibrarySources?(kind: LibraryEffectKind, target: string): readonly LibrarySourceInfo[];
  /** One series' progress (distinct volumes shelved in a working holder / the total). null for an unknown series. */
  getSeriesProgress?(seriesId: string): { have: number; total: number; fraction: number } | null;
  /** Should this item tile carry the 「not shelved yet」 band (a holder for that medium is owned + no holder has the same kind). False when it is not library-effect media (book · video · record). */
  isShelfItemWanted?(defId: string): boolean;
  /** Is a cook recipe open — with a `CraftRecipe.unlockSeries`, true only while that recipe book **is shelved right now**. A recipe that needs no book is always true. */
  isRecipeUnlocked?(recipeId: string): boolean;

  /* ══ appended (2026-09-13): video games ══ */
  /** Def id of the console attached to the TV, null when there is none. */
  getTvConsole?(tvUid: string): string | null;
  /** Take a console (bag → stash) and attach it to the TV. With one already there it is swapped (the old one goes bag → stash). Ship only. Korean reason / null. */
  attachTvConsole?(tvUid: string, defId: string): string | null;
  /** Detach the console into the bag (the stash when there is no space). Korean reason / null. */
  detachTvConsole?(tvUid: string): string | null;
  /** Uid of a valid seat facing the TV (the nearest one), null when there is none. */
  getTvSeat?(tvUid: string): string | null;
  /**
   * Korean reason the seat rule could not pick a seat (`TV 정면에 의자나 쇼파가 없습니다` · `TV 와 좌석 사이를 가구가 막고 있습니다` …), null when it could.
   * 2026-09-17: it is a diagnostic — it does not block the game (`gameBlock` never looks at it) and never shows on the TV screen either.
   */
  tvSeatBlock?(tvUid: string): string | null;
  /** Every game disc this TV can pick (those shelved on the ship's game disc stands) + each one's refusal reason. */
  getPlayableGames?(tvUid: string): readonly PlayableGameInfo[];
  /** Open the TV screen (on/off · attach a console · the seat state · the game list). Called by hub's E on the TV. */
  openTvMenu?(tvUid: string): void;
  /** The game session in progress, null when there is none. */
  readonly gameSession?: GameSessionInfo | null;
  /** Korean reason `startGameSession` would refuse right now, null = it can start. */
  gameBlock?(tvUid: string, discDefId: string): string | null;
  /**
   * Start a game session — opens the gym screen (with the disc's tuning on the judgement) and emits `housing:gameSession {active:true}` (hub applies the seated pose · locked camera).
   * Playing it out sends the score to `ctx.progression.applyGymSession(stat, score)` and raises `housing:gameResult`. Korean reason / null.
   */
  startGameSession?(tvUid: string, discDefId: string): string | null;
  /** End the game session in progress with no reward and no debuff (`housing:gameSession {active:false, completed:false}`). A no-op when there is none. */
  cancelGameSession?(): void;
}
/* ══ end 2026-09-13 library series · video games ══ */

/* ══ [2026-09-14] music playback controls (an appended HousingRef contract) ════════════════════════════
 * Display alone (`housing:musicChanged`) leaves no road to `MusicMode 'repeat'`, so this opens the control window.
 * They are all optional, so not one line of an old consumer changes. Success is true and `housing:musicChanged` follows immediately.
 */
export interface HousingRef {
  /** The playback state right now — so a screen attaching late need not wait for the first event. `MUSIC_PLAYER_OFF` while it is off. */
  getMusicState?(): MusicPlayerState;
  /** Next track / previous track (a person pressing it moves on even under `'repeat'`). False while nothing plays or the list is empty. */
  musicNext?(): boolean;
  musicPrev?(): boolean;
  /** Switch the playback mode. False for the same value. */
  setMusicMode?(mode: MusicMode): boolean;
  /** Stop playback. ⚠ It **also drops** that piece's `toggled` — turning off only the state would leave the piece looking switched on (it has to match turning it off with E). */
  musicStop?(): boolean;
}
/* ══ end 2026-09-14 music playback controls ══ */

/* ══ [2026-09-14] library · mining · music playback (2nd UI pass) ═══════════════════════════════════════
 * All three are **the shape of a screen, not a new rule** — the slot counts merely grew while shelving · the effect formula stayed,
 * the mining tabs join two screens into one window, and the music is a display-only state that holds a playlist.
 */

/**
 * How many tiers one holder has (`SHELF_SLOTS[m] / SHELF_TIERS[m]` is the slot count of one tier).
 * 2026-09-14 user's decision — the bookshelf is **4 tiers × 10 slots per tier (2 rows of 5)** = 40 volumes. The tier count stayed and a tier grew wider.
 * ⚠ The tier number is only a way of splitting up slot numbers — what is saved is the one `slot` index, so changing the tiers never moves what is shelved.
 */
/* 2026-09-15 2nd pass (user's decision): the bookshelf is **3 tiers** and one tier is a single row of 6 (3 left · 3 right of the middle divider) —
   it moves together with `BOOKS_PER_SHELF` 18 · `SHELF_TIER_COLS.book` 6, all three at once. */
export const SHELF_TIERS: Readonly<Record<ShelfMedium, number>> = { book: 3, disc: 3, record: 2, game: 3 };
/** How many slots one row inside a tier draws (the bookshelf is 5 × 2 rows = 10 per tier, the rest are 4 × 1 row). */
export const SHELF_TIER_COLS: Readonly<Record<ShelfMedium, number>> = { book: 6, disc: 4, record: 4, game: 4 };
/** Slots one tier of a holder takes. */
export function shelfSlotsPerTier(medium: ShelfMedium): number {
  return Math.max(1, Math.ceil(SHELF_SLOTS[medium] / SHELF_TIERS[medium]));
}

/**
 * Tabs of the unified mining screen (2026-09-14 user's decision — the compute cluster screen and the main computer screen were joined into one window).
 * `'cluster'` is the **new tab** and the other three are the old `MiningComputerTab` unchanged — which is why the argument type of
 * `openMiningComputer(uid, tab)` does not change (`MiningComputerTab ⊂ MiningTab`). The default tab E on a piece opens is **that piece's tab**:
 * the compute cluster → `'cluster'`, the main computer → `'clusters'`.
 */
export type MiningTab = 'cluster' | MiningComputerTab;
export const MINING_TABS: readonly MiningTab[] = ['cluster', 'clusters', 'wallet', 'exchange'];
export const MINING_TAB_LABEL_KO: Readonly<Record<MiningTab, string>> = {
  cluster: '채굴', clusters: '클러스터 현황', wallet: '지갑', exchange: '거래소',
};

/**
 * Music playback (2026-09-14 user's decision) — **no sound comes out**. Switching on a gramophone · jukebox · turntable makes the records
 * shelved in that ship's record racks the playlist, and the player window in the screen corner shows the title · artist · volume (`AudioChannel 'bgm'`).
 * A track's 「end」 time is nothing but `startedAt + lengthS`, and since there is no audio node the state is pure data.
 */
export interface MusicTrack {
  /** Record item id (`record_<series>`) — the key of the playlist. */
  defId: string;
  /** Track title (the series name, `《…》`). */
  title: string;
  /** Artist — `library_series.csv` has no column for it, so it is built deterministically from the series id (`musicArtistOf`). */
  artist: string;
  /** Track length (s). Drawn deterministically from the series id — the same record is always the same length. */
  lengthS: number;
}
/** Playback mode. `'playlist'` = round the order they are shelved in and back to the start at the end, `'repeat'` = this one track over and over. */
export type MusicMode = 'playlist' | 'repeat';
export const MUSIC_MODES: readonly MusicMode[] = ['playlist', 'repeat'];
export const MUSIC_MODE_LABEL_KO: Readonly<Record<MusicMode, string>> = { playlist: '재생 목록', repeat: '한 곡 반복' };

export interface MusicPlayerState {
  /** Uid of the piece making the sound (gramophone · jukebox · turntable), null while it is off. */
  furnitureUid: string | null;
  /** The current track. null when the playlist is empty (the window then shows 「꽂힌 레코드가 없습니다」). */
  track: MusicTrack | null;
  /** Every record shelved in this ship's record racks — the playlist. */
  playlist: readonly MusicTrack[];
  /** The current track's place in `playlist`, -1 when there is none. */
  index: number;
  mode: MusicMode;
  /** When the current track started (`nowMs()`). The progress bar is `(now - startedAt) / (lengthS * 1000)`. */
  startedAt: number;
}
/** The off state (the window is hidden). */
export const MUSIC_PLAYER_OFF: MusicPlayerState = Object.freeze({ furnitureUid: null, track: null, playlist: [], index: -1, mode: 'playlist', startedAt: 0 });

/** The range of track lengths (s) — a value in between is picked from the series id hash. */
export const MUSIC_TRACK_MIN_S = 96;
export const MUSIC_TRACK_MAX_S = 214;
/** The pieces an artist name is built from (for the same reason as the no-external-assets rule, even the name plate is made in code). */
const MUSIC_ARTIST_FIRST: readonly string[] = ['카민', '피로스', '툰드라', '세레스', '노마드', '아셴', '베르단', '헬리오스'];
const MUSIC_ARTIST_SECOND: readonly string[] = ['사중주단', '관현악단', '무명 악사', '군악대', '합창단', '야전 밴드', '기록 보관소', '순회 악단'];
function musicHash(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
/** Record series id → artist name (deterministic). */
export function musicArtistOf(seriesId: string): string {
  const h = musicHash(seriesId);
  return `${MUSIC_ARTIST_FIRST[h % MUSIC_ARTIST_FIRST.length]} ${MUSIC_ARTIST_SECOND[(h >>> 8) % MUSIC_ARTIST_SECOND.length]}`;
}
/** Record series id → track length (s, deterministic). */
export function musicLengthOf(seriesId: string): number {
  const h = musicHash(seriesId) >>> 16;
  return MUSIC_TRACK_MIN_S + (h % (MUSIC_TRACK_MAX_S - MUSIC_TRACK_MIN_S + 1));
}

/* ══ [2026-09-16] the dining plate — a meal is not an item (user's decision) ══════════════════════════════════════
 * 1. When a cook finishes at the cook bench no item appears; **one plate is set on my ship's dining table** (`ShipState.plate`). One per ship —
 *    cooking again **replaces** the old plate (a 1 s hold warning before the cook starts). With no dining table (`dining_table` furniture) placed, the cook bench cannot be used.
 * 2. The plate can be eaten from any time on the ship and **eating never uses it up**. Eating = `ProgressionRef.useMeal(the meal, the quality)` (a pending meal → loaded at launch →
 *    one raid's worth; the same meal at the same quality is refused, anything else replaces it) — the rules are progression's, unchanged.
 * 3. When the next raid starts (`game:newMission`, training excluded — the same place as `armPreps`) the plate is cleared away and saved.
 * 4. The shared ship: my plate is set on the shared ship's fixed dining table too. That table carries **every squadmate's plate** (with who cooked it shown) and anyone may eat
 *    from any plate (it is not used up · it becomes the eater's pending meal). The old 「분대에 차리기」 (`serveMealToSquad` · `housing:mealServed` ·
 *    `MealMessage`) was replaced by this — the names stay because they are contract and nobody uses them. The wire is `PlateMessage` (`shared/net.ts`).
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════════════ */

/** One plate set on the dining table — the meal id (`getMealDef`) · the quality (0 … `MEAL_QUALITY_MAX` stars) · when it was set (`nowMs()`, 0 when unknown). */
export interface DiningPlate {
  mealDefId: string;
  quality: number;
  cookedAt: number;
}

export interface ShipState {
  /** appended (2026-09-16): the plate on my ship's dining table, null · omitted when there is none. Cleared when the next raid starts. */
  plate?: DiningPlate | null;
}

/** One plate the dining table screen · the 3D dining table draws (mine or a squadmate's). */
export interface TablePlateInfo extends DiningPlate {
  /** PeerId of the squadmate who cooked it, **null for my own plate**. Passed to `eatPlate` as it is. */
  ownerId: string | null;
  /** Display name of whoever cooked it (my own name for my plate · `나` when there is none). */
  ownerName: string;
  mine: boolean;
}

/** The reason given when the cook bench · an auto-cook appliance is pressed with no dining table (the screen · prompt · toast all use the same text). */
export const DINING_TABLE_MISSING_REASON = '식탁이 없습니다';

export interface HousingRef {
  /** The plate on my ship's dining table, null when there is none. */
  getPlate?(): DiningPlate | null;
  /**
   * The plates set on that dining table. `uid` = the personal ship's dining table piece → only my plate; `null` = the shared ship's fixed dining
   * table → my plate + the squadmates' (theirs arrive only while standing in the shared ship). My plate first, the rest in name order.
   */
  getTablePlates?(uid: string | null): readonly TablePlateInfo[];
  /** Is a dining table piece placed on my ship (the cook bench gate). */
  hasDiningTable?(): boolean;
  /** Korean reason `eatPlate(uid, ownerId)` would refuse right now, null = it can be eaten (that reason when the same meal has already been eaten). */
  plateEatBlock?(uid: string | null, ownerId?: string | null): string | null;
  /** Eat a plate from that dining table — the plate is not used up and `progression.useMeal` loads the pending meal. `ownerId` omitted · null = my plate. Korean reason / null. */
  eatPlate?(uid: string | null, ownerId?: string | null): string | null;
  /** Dev · smokes: set a plate on my dining table (with no cooking). A Korean reason when it is not a meal. */
  devSetPlate?(mealDefId: string, quality?: number): string | null;
  /** Dev · smokes: clear my plate away. True when something was cleared. */
  clearPlate?(): boolean;
}
/* ══ end 2026-09-16 the dining plate ══ */

/* ══ 2026-09-17 culture start confirmation (owner: housing/parts/Culture) ══════════════════════════════════════
 * Inserting a strain does not start the culture on its own — the 「배양 시작」 button under the slot → a 1 s hold confirm (`startCulture`) starts the timer.
 * Before the start (`CultureSlot.strainDefId` is set while `startedAt` · `readyAt` are not) the strain · the scaffold · an unused medium can be taken back.
 * An old save's strain always carries a `startedAt`, so it is already culturing (there is no separate migration). */
export interface CultureSlotInfo {
  /** The culture has started (the timer is running). A strain present with this false = waiting to start. */
  started: boolean;
  /** The medium can be taken back (`takeMedium`) — no strain · scaffold · socket and full durability. */
  mediumReturnable: boolean;
}

export interface HousingRef {
  /** Start the culture of a not-yet-started slot that holds a medium + a strain — `readyAt` is fixed **here**, and after it nothing put in comes back. Korean reason / null. */
  startCulture?(uid: string, slot: number): string | null;
  /** Take the strain back out of a not-yet-started slot (`dest` defaults to `'bag-first'`). Korean reason / null. */
  takeStrain?(uid: string, slot: number, dest?: HarvestDestination): string | null;
  /** Take back a never-used medium (full durability · no socket · scaffold · strain) with its slot. Korean reason / null. */
  takeMedium?(uid: string, slot: number, dest?: HarvestDestination): string | null;
}
/* ══ end 2026-09-17 culture start confirmation ══ */
