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
  | 'lounge'      // 휴식 공간 (2026-09-12: 더 이상 지을 수 없다 — 서재에 합쳐졌다)
  /* appended (2026-09-12): 조종석. `ShipState.rooms` 에 들어가지 않는 **고정 공간**이고 방 번호는
     `COCKPIT_ROOM_INDEX` 다. 용도를 바꾸거나 제거할 수 없으며 `'any'`(공용) 가구만 놓인다. */
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
  /* 2026-09-12 (사용자 결정): 휴식 공간이 서재에 합쳐졌다 — 휴식 공간에 들어갈 것(TV · 스피커 …)은 이제 서재에 놓인다. */
  library: '책장 · 디스크 전시대 · 레코드랙에 책 · 디스크 · 레코드를 꽂으면 그 숙련의 상승량이 늘어납니다. 흔들의자 · TV · 턴테이블 같은 가구를 곁에 두면 더 늘어납니다. 꽂아 본 것은 도감에 남습니다.',
  greenhouse: '재배층을 설치하고 씨앗을 심어 현실 시간에 맞춰 약초를 재배합니다.',
  lab: '분석기로 미확인 표본을 해석하고, 추출기 · 조합대로 성분을 뽑아 준비물을 만듭니다. 온실이 먼저 필요합니다.',
  kitchen: '조리대로 작물과 배양 산물을 요리하고, 식탁에서 먹어 다음 레이드 버프를 얻습니다. 온실이 먼저 필요합니다.',
  mining: '그래픽카드로 암호화폐를 채굴합니다. (다음 업데이트)',
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

/** Generator level a 시설 증축 needs (the same gate every facility upgrade sits behind). */
export const ROOM_PURPOSE_BUILD_GENERATOR_LEVEL = T.num('ROOM_PURPOSE_BUILD_GENERATOR_LEVEL');

/** Purposes with mechanics in this build; the rest are decoration-only. (Phase 8 appended `greenhouse`.) */
export const ROOM_PURPOSES_ACTIVE: readonly RoomPurpose[] = ['empty', 'workshop', 'greenhouse', 'library', 'lab', 'kitchen', 'gym'];   // 2026-09-12 appended `gym` (A-3a);   // Phase 9 appended `library`; 2026-09-11 appended `lab` (A-12 · A-13) then `kitchen` (A-3c); 2026-09-12 dropped `range` (시뮬레이션실 제거)

/**
 * appended (2026-09-12, 사용자 결정): **빈 방이 될 수 있는 용도** — 시설 증축 목록이 그리는 것은 이것뿐이다.
 * `ROOM_PURPOSES` 는 옛 세이브를 읽으려고 `range`(시뮬레이션실) · `lounge`(휴식 공간, 서재에 합쳐졌다)를 그대로 갖지만
 * 둘 다 여기에는 없다. `empty` 와 `cockpit` 도 없다 (빈 방은 「시설 제거」의 결과이고 조종석은 방이 아니다).
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
  /* 2026-09-12 (사용자 결정): `refine` 의 이름만 '정제 작업대' → '가공 작업대'. kind 는 계약이라 그대로다. */
  gun: '총기 작업대', gear: '장비 작업대', gadget: '가젯 작업대', medical: '의학 작업대', refine: '가공 작업대',
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
  | 'locker' | 'table' | 'shelf' | 'crate' | 'lamp' | 'plant' | 'chair' | 'bunk'
  /* appended (2026-09-12): 조종석의 고정 설비였던 전술 임플란트 시술대 · 함선 컴퓨터가 공용 시설 가구가 됐다 */
  | 'implant_bay' | 'corp_computer'
  /* appended (2026-09-12, A-3e): 서재 매체 보관함 2종 + 보조 가구 5종 (축음기 · 주크박스 · 턴테이블은 외형만 다른 한 역할) */
  | 'disc_stand' | 'record_rack' | 'rocking_chair' | 'tv' | 'gramophone' | 'jukebox' | 'turntable'
  /* appended (2026-09-12, A-3a): 헬스장 운동 기구 4종 */
  | 'bench_rack' | 'smith_machine' | 'treadmill' | 'exercise_bike'
  /* appended (2026-09-13): 조종석의 고정 소품이던 서랍장(창고 캐비닛)이 꾸밈 가구 `furn_drawer` 가 됐다 */
  | 'drawer'
  /* appended (2026-09-13, 요리 미니게임): 주방의 자동 조리 가구 4종 — 푸드 프로세서 · 자동 그릴 · 자동 교반기 · 계량 디스펜서 (`level` 만큼 표시등) */
  | 'food_processor' | 'auto_grill' | 'auto_stirrer' | 'pour_dispenser';

/** What E does on a placed piece. */
export type FurnitureInteraction =
  | 'none'
  | 'workbench_gun' | 'workbench_gear' | 'workbench_gadget' | 'workbench_medical'  // → ctx.inventory.openBenchCraft(kind)
  | 'workbench_refine'                                                            // appended (2026-09-10) → 같은 길, kind 'refine'
  | 'range_console'                                                               // 은퇴 (2026-09-12 — 관물대 · 프리셋 기능 제거). E 상호작용 없음
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
  | 'culture_tank'                                                                // → ctx.housing.openCultureTank(uid): 배지 붓기 / 세포주 넣기 / 수확
  /* appended (2026-09-12) — 공용 시설 가구 */
  | 'implant_bay'                                                                 // → Tab 화면 (임플란트 칸) — 옛 `hub_implant_bay` 와 같은 길
  | 'corp_computer'                                                               // → 기업 네트워크 (`ctx.meta.openCorpMenu()`) — 옛 `hub_computer` 와 같은 길
  /* appended (2026-09-12, A-3e) — 서재 매체 */
  | 'disc_stand' | 'record_rack'                                                  // → ctx.housing.openShelf(uid): 디스크 · 레코드 꽂기 / 빼기 / 도감 (책장과 같은 결의 화면)
  | 'rocking_chair'                                                               // → ctx.player.setFurniturePose({kind:'sit', releaseOnInteract:true}) — 앉기 토글. 배치만으로 책 몫 보너스
  | 'tv' | 'record_player'                                                        // → ctx.housing.toggleFurniture(uid): 화면 · 조명 켜기/끄기 (광원 없음). 배치만으로 디스크 · 레코드 몫 보너스
  /* appended (2026-09-12, A-3a) — 헬스장 (`GYM_EQUIPMENT`) */
  | 'gym_bench_press' | 'gym_smith' | 'gym_treadmill' | 'gym_cycle'             // → ctx.housing.startGymSession(uid): 미니게임
  /*
   * appended (2026-09-13, 요리 미니게임 — `shared/cooking`): 자동 조리 가구 4종 (`COOK_APPLIANCE_GAMES`). 배치만으로 조리 단계의 「자동」 을 연다.
   * E → `ctx.housing.openCookStation(<함선의 조리대 uid>)` (조리대가 없으면 토스트). ⚠ 같은 날부터 **`workbench_cook` 의 E 도 인벤토리 제작 창이 아니라
   * `ctx.housing.openCookStation(uid)`** 다 (`benchKindOf` 는 그대로 'cook' 을 돌려준다 — 레벨 · 레시피 게이트가 그 이름을 쓴다).
   */
  | 'cook_processor' | 'cook_grill' | 'cook_stirrer' | 'cook_dispenser';

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

/** 칸 수 per 재배층. */
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
 * appended (2026-09-13): 재배 스테이션 레벨 1단계마다 오르는 성장 속도. 성장 시간 = 기본 ÷ (1 + 이 값 × (레벨 − 1)),
 * 토양 궁합 · 원예 항과 곱해진다. 강화하는 순간 자라던 작물의 **남은 시간**도 그 속도 비율로 줄어든다
 * (`housing/parts/Garden.rescaleGrowsForUpgrade` — 「readyAt 은 심는 순간 확정」의 유일한 예외).
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

/* ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
 * appended: 2026-09-12 — 조종석 · 시설 레벨 요구 (사용자 결정)
 *
 * 1. **조종석은 방 목록 맨 위에 늘 있는 공간이다.** `ShipState.rooms` 에는 들어가지 않고(용도 · 레벨이 없다) 방 번호로는
 *    `COCKPIT_ROOM_INDEX` 를 쓴다 — `getRoom(COCKPIT_ROOM_INDEX).purpose === 'cockpit'`, `getPlaced(COCKPIT_ROOM_INDEX)`,
 *    `canPlace / place / move / recover`, `setManageRoom(COCKPIT_ROOM_INDEX)` 가 모두 그 번호를 받는다.
 *    `setRoomPurpose` · `removeRoomFacility` 는 거절한다. 조종석에는 `room: 'any'`(공용) 가구만 놓인다.
 *    2026-09-13: 그리고 `room: 'cockpit'`(조종석 전용 시설 — 시술대 · 컴퓨터, `isCockpitOnlyFurniture`)도.
 *    번호가 `SHIP_ROOM_COUNT` 가 아니라 **고정값**인 이유: 방 수가 나중에 늘어도 저장된 조종석 가구가 다른 방으로 옮겨 가면 안 된다.
 *    `-1` 이 아닌 이유: hub 의 `HousingMode.room = -1` 이 「모드 꺼짐」이다.
 * 2. **조종석의 격자는 방보다 크고 구멍이 있다.** `roomGridSize(room)` 이 방마다 격자 크기를, `roomCellBlocked` 가 고정 소품
 *    (계기판 · 좌석 · 발사 포드 · 사물함 · 침상 · 창고 · 복도 통로) 자리를 답한다. 배치 규칙(`housing/Rules`)과 격자선 ·
 *    카메라(`hub/`)가 **이 표 하나**를 읽는다. 소품을 옮기면 이 표를 같이 고친다.
 * 3. **시설 레벨 요구**(발전기 Lv.n)는 재료 칩 옆에 `buildFacilityChip` 으로 그린다 — 질의는 아래 `HousingRef` 두 줄.
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════════════ */
import { ROOM_GRID_COLS, ROOM_GRID_ROWS } from './constants';

/** 조종석의 방 번호 (방이 아니므로 `0 … SHIP_ROOM_COUNT − 1` 밖의 고정값). */
export const COCKPIT_ROOM_INDEX = 100;

/**
 * 조종석 바닥 격자 (칸). `hub/interiors/RoomLayout.COCKPIT` = x −5 … 5, z −6 … 0 (10 × 6 m) 을 `HOUSING_CELL_SIZE`(0.5)로
 * 나눈 것이다. 칸 (0, 0) 은 방과 같은 규약으로 min-x / min-z 모서리(좌현 · 앞창 쪽)이고 `x` 는 월드 +X, `y` 는 월드 +Z 다.
 */
export const COCKPIT_GRID_COLS = 20;
export const COCKPIT_GRID_ROWS = 12;

/** 격자 위의 칸 사각형 (좌상단 칸 + 크기). */
export interface GridRect { x: number; y: number; cols: number; rows: number }

/**
 * 조종석에서 가구를 놓을 수 없는 칸 — 고정 소품과 반드시 비워야 하는 통로. `hub/interiors/PersonalShip` 의 조종석 소품
 * 좌표에서 잡았다 (칸 x = (월드 x + 5) / 0.5, 칸 y = (월드 z + 6) / 0.5).
 */
export const COCKPIT_BLOCKED_RECTS: readonly GridRect[] = [
  { x: 3, y: 0, cols: 14, rows: 3 },    // 계기판(x ±3.3, z −6 … −5.3) + 앞 0.8 m (x −3.5 … 3.5, z −6 … −4.5)
  { x: 7, y: 3, cols: 6, rows: 9 },     // 조종석 두 개 · 터미널 자리 · 복도 아치까지의 통로 (x −1.5 … 1.5, z −4.5 … 0)
  /* 2026-09-13 (사용자 결정): 사물함 두 칸 · 침상 · 창고 캐비닛은 꾸밈 가구가 됐다(`COCKPIT_DECOR_FURNITURE`) — 그 칸들은 풀렸다.
     발사 포드는 소켓과 문 앞 탑승 동선만 막는다. 옛 표: {18,1,2,3} 사물함 · {13,7,7,5} 포드 + 캐비닛 · {0,6,2,5} 침상. */
  { x: 13, y: 7, cols: 7, rows: 4 },    // 발사 포드 소켓(x 3 … 5, z −2.2 … −0.5) + 문(−X) 앞 탑승 동선 (x 1.5 … 5, z −2.5 … −0.5)
  { x: 16, y: 11, cols: 4, rows: 1 },   // 포드 소켓 뒤 끝 · 뒷벽 기둥 (x 3 … 5, z −0.5 … 0)
];

/**
 * appended (2026-09-13, 사용자 결정): 조종석의 **꾸밈 가구** — 예전 고정 소품(침상 · 사물함 두 칸 · 창고 캐비닛)이 서 있던 자리.
 * 새 함선(`housing/ShipState.freshState`)과 v10 이전 세이브(`sanitize` 의 v10 절)에 **한 번만** 놓이고, 플레이어가 회수하면
 * 다시 채우지 않는다 (`COCKPIT_DEFAULT_FURNITURE` 와 다르다). 자리가 막혀 있으면 가구 창고로 간다.
 * 칸 좌표는 옛 소품 좌표에서 잡았다 (칸 x = (월드 x + 5) / 0.5, 칸 y = (월드 z + 6) / 0.5).
 */
export const COCKPIT_DECOR_FURNITURE: readonly { defId: string; x: number; y: number; yaw: 0 | 1 | 2 | 3 }[] = [
  /* 침상(2단): −X 벽에 붙어 z 로 길다 — 2 × 3 칸 = x −5 … −4, z −2.5 … −1.0 (옛 1인 침상의 중심 z −1.75) */
  { defId: 'furn_bunk', x: 0, y: 7, yaw: 0 },
  /* 사물함 두 칸: +X 벽 — 1 × 2 칸씩 = x 4.5 … 5, z −5.5 … −3.5 (옛 줄의 중심 z −4.7), 문이 ±X 면이라 한쪽 문이 조종석을 본다 */
  { defId: 'furn_locker', x: 19, y: 1, yaw: 0 },
  { defId: 'furn_locker', x: 19, y: 3, yaw: 0 },
  /* 서랍장(옛 창고 캐비닛): 뒷벽 우현 절반, 서랍이 −Z — 2 × 1 칸 = x 2 … 3, z −0.5 … 0 (옛 중심 x 2.4) */
  { defId: 'furn_drawer', x: 14, y: 11, yaw: 0 },
];

/**
 * appended (2026-09-13): 조종석 전용 시설인가 (`FurnitureDef.room === 'cockpit'` — 시술대 · 컴퓨터). 조종석에만 놓이고, 회수 · 제거할
 * 수 없고, 함선마다 정확히 하나다 (`housing/ShipState.ensureCockpitFurniture`).
 */
export function isCockpitOnlyFurniture(def: FurnitureDef | undefined | null): boolean {
  return !!def && def.room === 'cockpit';
}

/** appended (2026-09-13): 조종석 전용 시설의 회수 · 제거 거절 문장 — housing 의 규칙과 hub 의 시설 관리 토스트가 같은 글을 쓴다. */
export const COCKPIT_ONLY_RECOVER_REASON = '조종석 전용 시설은 회수할 수 없습니다';

/** appended: 공용 시설 가구 두 점의 def id. */
export const IMPLANT_BAY_DEF_ID = 'furn_implant_bay';
export const CORP_COMPUTER_DEF_ID = 'furn_corp_computer';

/**
 * 모든 함선이 조종석에 갖고 시작하는 공용 시설 가구와 그 자리. 새 함선(`freshState`)과 옛 세이브(두 점 중 배치도 보관도
 * 안 된 것이 있으면) 모두 이 자리에 채운다 — 자리가 막혀 있으면 `housing/Rules.autoPlaceSpot` 으로, 그래도 없으면 가구 창고로.
 * 좌표는 옛 고정 설비가 서 있던 곳(시술대 = 좌현 앞 모서리, 컴퓨터 = 좌현 뒤 벽)이다.
 */
export const COCKPIT_DEFAULT_FURNITURE: readonly { defId: string; x: number; y: number; yaw: 0 | 1 | 2 | 3 }[] = [
  /* 시술대: yaw 1 = 앞이 +X(조종석 안쪽) · 등받이가 −X 벽 — 발자국 4 × 3 칸 = x −5 … −3, z −4.5 … −3 (계기판 앞 띠 바로 뒤) */
  { defId: IMPLANT_BAY_DEF_ID, x: 0, y: 3, yaw: 1 },
  /* 컴퓨터: yaw 0 = 모니터가 −Z(조종석 안쪽) · 책상 등이 뒷벽 — 3 × 3 칸 = x −4 … −2.5, z −1.5 … 0 (침상 옆, 옛 책상 자리) */
  { defId: CORP_COMPUTER_DEF_ID, x: 2, y: 9, yaw: 0 },
];

export function isCockpitRoom(room: number): boolean { return room === COCKPIT_ROOM_INDEX; }

/** 방 `room` 의 바닥 격자 크기 (조종석이면 `COCKPIT_GRID_*`, 아니면 `ROOM_GRID_*`). */
export function roomGridSize(room: number): { cols: number; rows: number } {
  return room === COCKPIT_ROOM_INDEX
    ? { cols: COCKPIT_GRID_COLS, rows: COCKPIT_GRID_ROWS }
    : { cols: ROOM_GRID_COLS, rows: ROOM_GRID_ROWS };
}

/** 칸 (x, y) 이 고정 소품 자리인가 (방은 늘 false). 격자 밖인지는 보지 않는다 — `roomGridSize` 로 따로 본다. */
export function roomCellBlocked(room: number, x: number, y: number): boolean {
  if (room !== COCKPIT_ROOM_INDEX) return false;
  for (const r of COCKPIT_BLOCKED_RECTS) if (x >= r.x && x < r.x + r.cols && y >= r.y && y < r.y + r.rows) return true;
  return false;
}

/** 사각형 `(x, y, cols, rows)` 가 고정 소품 자리와 한 칸이라도 겹치는가. */
export function roomRectBlocked(room: number, x: number, y: number, cols: number, rows: number): boolean {
  if (room !== COCKPIT_ROOM_INDEX) return false;
  for (const r of COCKPIT_BLOCKED_RECTS) {
    if (x < r.x + r.cols && x + cols > r.x && y < r.y + r.rows && y + rows > r.y) return true;
  }
  return false;
}

/** 채워지지 않은 **시설 레벨 요구** 하나 — 「발전기 Lv.`need` 가 필요한데 지금 Lv.`have`」. */
export interface FacilityRequirement {
  facility: FacilityId;
  have: number;
  need: number;
}

export interface HousingRef {
  /**
   * appended (2026-09-12): 놓인 가구 `uid` 의 **다음 강화**를 막는 시설 레벨 요구 — 채워지지 않은 것만 (보통 발전기 하나).
   * 빈 배열 = 시설 레벨은 문제가 없다 (재료 · 최대 레벨은 `furnitureUpgradeBlock` 이 따로 답한다).
   * ui 는 이것을 재료 칩 옆의 `buildFacilityChip` 으로 그린다 — 가구 인스펙터 · 스테이션 업그레이드 모달.
   */
  furnitureUpgradeRequirements(uid: string): readonly FacilityRequirement[];
  /** appended (2026-09-12): 빈 방에 `purpose` 를 **증축**하는 데 채워지지 않은 시설 레벨 요구 (발전기 Lv.1 게이트). */
  purposeRequirements(purpose: RoomPurpose): readonly FacilityRequirement[];
}

/* ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
 * appended: 2026-09-12 — 서재 매체 (A-3e) · 헬스장 (A-3a). 설계 · 사용자 결정: docs/plans/a3a-a3e.md
 *
 * 1. **서재 매체.** 책장(`bookshelf`) 옆에 디스크 전시대(`disc_stand`) · 레코드랙(`record_rack`)이 선다. 셋은 같은 규칙이다 —
 *    칸에 매체를 꽂으면 그 매체가 가르치는 숙련의 상승량 배율이 오르고, 꽂아 본 것은 도감에 남는다. 매체마다 몫을 따로 잘라 더한다:
 *
 *        몫[m] = min(SHELF_GAIN_MAX[m] − 1, SHELF_XP_PER_ITEM[m] × Σ BOOK_RARITY_MUL[등급])  ×  (보조 가구[m] 배치 ? 1 + SHELF_AUX_BONUS[m] : 1)
 *        서재 배율 = 1 + 몫[책] + 몫[디스크] + 몫[레코드]     ← `getBookBonus(skill)` 이 이제 이 값이다 (`getSkillGainMul` 에 접힌다)
 *
 *    보조 가구는 **배치만으로** 켜진다 (사용자 명세 「배치 시」): 흔들의자 → 책, TV → 디스크, 축음기 · 주크박스 · 턴테이블 → 레코드.
 *    레코드 셋은 외형만 다른 한 역할이라 몇 대를 놓아도 한 번만 곱한다 (사용자 결정). 전부 서재에만 놓인다 (사용자 결정 — 2026-09-12 에
 *    휴식 공간이 서재에 합쳐졌다). 흔들의자는 E 로 앉기 토글, TV · 레코드 플레이어는 E 로 켜고 끈다 (광원 없음 — emissive 만).
 * 2. **헬스장.** 운동 기구 4종(`GYM_EQUIPMENT`)이 미니게임을 연다. 끝낸 세션의 점수가 `ProgressionRef.applyGymSession` 으로 가서
 *    스탯 포인트와 **따로 세는 단련 보너스**(`PlayerProfile.trained`)가 된다 (사용자 결정). 세션을 끝내면 그 능력치에 현실 시간
 *    `GYM_FATIGUE_HOURS` 디버프(근력 = 근육통 · 지구력 = 심폐 피로)가 걸리고 그동안 같은 능력치 운동은 상승량 −100 % 다
 *    (사용 자체는 막지 않는다). 운동 중에는 캐릭터가 기구 위에서 자세를 취하고 카메라가 고정된다 (사용자 결정 —
 *    `PlayerRef.setFurniturePose`, 부르는 쪽은 hub).
 *
 * 새 `HousingRef` 메서드는 전부 optional 이다 — 병렬로 짓는 동안에도 트리가 타입체크를 통과하고, 소비자는 늘 하던 대로
 * `typeof h.x === 'function'` 로 방어한다.
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════════════ */
import {
  BOOKS_PER_SHELF, BOOK_GAIN_MAX, BOOK_XP_PER_BOOK, DISC_GAIN_MAX, DISC_SLOTS_PER_STAND, DISC_XP_PER_ITEM, RECORD_GAIN_MAX,
  RECORD_SLOTS_PER_RACK, RECORD_XP_PER_ITEM, SHELF_AUX_BONUS_BOOK, SHELF_AUX_BONUS_DISC, SHELF_AUX_BONUS_RECORD,
} from './constants';
import type { FurniturePoseKind, ItemDef } from './types';
import type { GymStat } from './progression';

/** 서재 보관함에 꽂는 매체. */
export type ShelfMedium = 'book' | 'disc' | 'record';
export const SHELF_MEDIA: readonly ShelfMedium[] = ['book', 'disc', 'record'];
export const SHELF_MEDIUM_LABEL_KO: Readonly<Record<ShelfMedium, string>> = { book: '책', disc: '디스크', record: '레코드' };

/** 매체 하나를 받는 보관함 가구의 interaction. */
export const SHELF_INTERACTION: Readonly<Record<ShelfMedium, FurnitureInteraction>> = {
  book: 'bookshelf', disc: 'disc_stand', record: 'record_rack',
};
/** 그 매체의 몫을 올리는 보조 가구의 interaction (레코드는 축음기 · 주크박스 · 턴테이블이 모두 `record_player`). */
export const SHELF_AUX_INTERACTION: Readonly<Record<ShelfMedium, FurnitureInteraction>> = {
  book: 'rocking_chair', disc: 'tv', record: 'record_player',
};
/** 보관함 한 대의 칸 수. */
export const SHELF_SLOTS: Readonly<Record<ShelfMedium, number>> = {
  book: BOOKS_PER_SHELF, disc: DISC_SLOTS_PER_STAND, record: RECORD_SLOTS_PER_RACK,
};
/** 한 장(권)이 몫에 더하는 값 (× `BOOK_RARITY_MUL[rarity]`). */
export const SHELF_XP_PER_ITEM: Readonly<Record<ShelfMedium, number>> = {
  book: BOOK_XP_PER_BOOK, disc: DISC_XP_PER_ITEM, record: RECORD_XP_PER_ITEM,
};
/** 매체별 `1 + 몫` 의 상한 (보조 가구 배율은 자른 뒤에 곱한다). */
export const SHELF_GAIN_MAX: Readonly<Record<ShelfMedium, number>> = {
  book: BOOK_GAIN_MAX, disc: DISC_GAIN_MAX, record: RECORD_GAIN_MAX,
};
/** 보조 가구가 있을 때 그 매체의 몫에 곱하는 추가분 (`× (1 + 값)`). */
export const SHELF_AUX_BONUS: Readonly<Record<ShelfMedium, number>> = {
  book: SHELF_AUX_BONUS_BOOK, disc: SHELF_AUX_BONUS_DISC, record: SHELF_AUX_BONUS_RECORD,
};

/** 보관함 가구면 그 매체, 아니면 null. */
export function shelfMediumOfInteraction(interaction: FurnitureInteraction): ShelfMedium | null {
  for (const m of SHELF_MEDIA) if (SHELF_INTERACTION[m] === interaction) return m;
  return null;
}
/** 보조 가구면 그것이 올리는 매체, 아니면 null. */
export function shelfAuxMediumOf(interaction: FurnitureInteraction): ShelfMedium | null {
  for (const m of SHELF_MEDIA) if (SHELF_AUX_INTERACTION[m] === interaction) return m;
  return null;
}
/** 아이템이 서재 매체면 매체와 숙련 (`ItemDef.book` · `disc` · `record`), 아니면 null. */
export function shelfItemOf(def: ItemDef | null | undefined): { medium: ShelfMedium; skill: SkillId } | null {
  if (!def) return null;
  if (def.book) return { medium: 'book', skill: def.book.skill };
  if (def.disc) return { medium: 'disc', skill: def.disc.skill };
  if (def.record) return { medium: 'record', skill: def.record.skill };
  return null;
}

/** E 로 켜고 끄는 가구 (`ShipState.toggled`). */
export const TOGGLE_INTERACTIONS: readonly FurnitureInteraction[] = ['tv', 'record_player'];
export function isToggleInteraction(interaction: FurnitureInteraction): boolean {
  return TOGGLE_INTERACTIONS.includes(interaction);
}

/** 한 숙련의 서재 배율을 매체별로 나눈 것 (보관함 화면 · 도감 · 캐릭터 시트의 설명 줄). */
export interface ShelfBonusInfo {
  /** `1 + Σ parts` — `getBookBonus(skill)` 과 같은 값. */
  total: number;
  /** 매체별 몫 (상한으로 자르고 보조 가구 배율까지 곱한 뒤). */
  parts: Readonly<Record<ShelfMedium, number>>;
  /** 그 매체의 보조 가구가 함선에 배치돼 있는가. */
  aux: Readonly<Record<ShelfMedium, boolean>>;
}

export interface ShipState {
  /* ── appended (A-3e, 2026-09-12, version 9) ── */
  /**
   * 디스크 전시대 · 레코드랙에 꽂힌 것 — `PlacedBook` 과 같은 모양이고 `defId` 는 그 보관함의 매체와 맞아야 한다
   * (`disc_*` / `record_*`). 책은 여전히 `books` 다 (옛 세이브 · 방문 와이어 호환).
   */
  media?: PlacedBook[];
  /** 디스크 · 레코드 도감: 한 번이라도 꽂아 본 def id (`bookDex` 와 같은 append-only 기록). */
  mediaDex?: string[];
  /** 켜 둔 TV · 레코드 플레이어의 uid. 배치에서 사라진 uid 는 `sanitize` 가 버린다. */
  toggled?: string[];
}

/** 운동 미니게임 3종 — 벤치프레스(바 타이밍) · 호흡 달리기(후-후-하) · 사이클링(A/D 번갈아). */
export type GymMinigame = 'press' | 'breath' | 'cycle';
export const GYM_MINIGAME_LABEL_KO: Readonly<Record<GymMinigame, string>> = {
  press: '벤치프레스', breath: '호흡 달리기', cycle: '사이클링',
};

/** 운동 기구 하나가 무엇을 올리고 어떤 미니게임 · 자세를 쓰는가. */
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

/** 진행 중인 운동 세션. */
export interface GymSessionInfo {
  uid: string;
  defId: string;
  stat: GymStat;
  minigame: GymMinigame;
}

export interface HousingRef {
  /* ══ appended (A-3e, 2026-09-12): 서재 매체 ══ */
  /** 배치된 조각이 보관함(책장 · 디스크 전시대 · 레코드랙)이면 그 매체, 아니면 null. */
  getShelfMedium?(uid: string): ShelfMedium | null;
  /** 보관함 한 대의 칸 전부, 늘 `SHELF_SLOTS[medium]` 개 (책장이면 `getBooks` 와 같다). 보관함이 아니면 빈 배열. */
  getShelfSlots?(uid: string): BookSlotInfo[];
  /** 매체 하나를 (가방 → 창고) 꺼내 `slot` 에 꽂는다. 매체가 그 보관함과 맞아야 한다. 함선 전용. 한국어 사유 / null. */
  placeShelfItem?(uid: string, slot: number, defId: string): string | null;
  /** `slot` 의 매체를 가방(없으면 창고)으로 뺀다. 한국어 사유 / null. */
  takeShelfItem?(uid: string, slot: number): string | null;
  /** 지금 가진 그 매체 (가방 + 창고), 숙련 순. */
  getOwnedShelfItems?(medium: ShelfMedium): { defId: string; qty: number }[];
  /** 그 매체의 도감 (책 = `bookDex`, 디스크 · 레코드 = `mediaDex` 에서 그 접두사). */
  getShelfDex?(medium: ShelfMedium): readonly string[];
  /** 한 숙련의 서재 배율을 매체별로. `total === getBookBonus(skill)`. */
  getShelfBonus?(skill: SkillId): ShelfBonusInfo;
  /** 그 매체의 보조 가구가 함선에 배치돼 있는가. */
  hasShelfAux?(medium: ShelfMedium): boolean;
  /** 보관함 화면을 연다 — 책장 · 디스크 전시대 · 레코드랙 공통 (책장은 `openBookshelfMenu` 와 같은 화면이어도 된다). */
  openShelf?(uid: string): void;
  /** TV · 레코드 플레이어가 켜져 있는가 (`ShipState.toggled`). 켤 수 없는 가구는 false. */
  isFurnitureOn?(uid: string): boolean;
  /** 켜기 / 끄기를 뒤집고 새 상태를 돌려준다 (`housing:furnitureToggled` + 저장). 켤 수 없는 가구면 null. */
  toggleFurniture?(uid: string): boolean | null;

  /* ══ appended (A-3a, 2026-09-12): 헬스장 ══ */
  /** 진행 중인 운동 세션, 없으면 null. */
  readonly gymSession?: GymSessionInfo | null;
  /** 지금 `startGymSession(uid)` 가 거절할 한국어 사유, null = 시작할 수 있다. */
  gymBlock?(uid: string): string | null;
  /**
   * 운동 기구 `uid` 로 세션을 시작한다 — 미니게임 화면을 열고 `housing:gymSession {active:true}` 를 낸다 (hub 가 자세 · 카메라를 건다).
   * 끝까지 하면 점수가 `ctx.progression.applyGymSession` 으로 가고 `housing:gymResult` 가 난다. 한국어 사유 / null.
   */
  startGymSession?(uid: string): string | null;
  /** 진행 중인 세션을 보상 · 디버프 없이 끝낸다 (`housing:gymSession {active:false, completed:false}`). 없으면 no-op. */
  cancelGymSession?(): void;
}

/* ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
 * appended: 2026-09-13 — 요리 재료 티어 (docs/plans/food-tiers.md, 사용자 결정)
 *
 * 1. **분석기는 결과표를 굴린다.** 표본은 계열(`SampleFamily`)로 해석되고, 결과는 `data/analysis_results.csv` 에서
 *    **넣는 순간** 그 계열의 분석 레벨로 가중 추첨해 칸에 적는다 (`AnalysisSlot.resultDefId` — 회수에 실패해도 다시 굴리지 않는다).
 *    회수하면 그 계열 경험치가 오르고(`ANALYSIS_XP_BY_RARITY`) 처음 받은 산출물은 분석 도감(`analysisFound`)에 적힌다.
 *    분석 레벨은 해석 시간을 줄이고(`ANALYSIS_TIME_MUL_BY_LEVEL`) 결과를 해금한다(`AnalysisResultDef.minLevel`).
 *    옛 「도감 진척률 · 기지식 → 시간 단축」(`ANALYZE_DEX_SPEEDUP` · `ANALYZE_KNOWN_SPEEDUP`)과 첫 해석 보너스는 이것으로 대체됐다.
 * 2. **흙 · 배지에는 내구도와 소켓이 있다.** 부으면 아이템은 소모되고(그대로) 내구도 · 소켓은 **칸이** 들고 있다.
 *    수확마다 닳고 0 이어도 계속 쓰며 **칸이 저절로 비지 않는다** — 대신 보너스(흙 궁합 · 배지 속도 · 소켓 speed/yield)가
 *    내구도 비율로 줄어든다. 소켓은 등급별 칸 수(`GROW_SOCKETS_BY_RARITY`)만큼 영구 장착이고, 가득 찬 칸에 끼우려면
 *    `replaceIndex` 로 옛 것을 파괴해야 한다 (화면이 1초 홀드 경고로 묻는다). 칸을 비우면 흙 · 배지와 소켓이 함께 사라진다.
 * 3. **배양 칸에는 배양 스캐폴드가 들어간다** — 배지 → (스캐폴드) → 세포주. 스캐폴드가 있으면 세포주의
 *    `StrainDef.scaffoldOutputDefId`(종별 고기)를 만들고 수확할 때 스캐폴드가 소모된다. 세포주가 들어가기 전이면 뺄 수 있다.
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════════════ */
import { numberMap } from './data/tables';
import type { GrowSocketTarget, Rarity, SampleFamily } from './types';
import { SAMPLE_FAMILIES } from './types';

const ANALYSIS_LEVEL_XP_TABLE = numberMap<string>('tables.csv', 'ANALYSIS_LEVEL_XP');
const ANALYSIS_TIME_MUL_TABLE = numberMap<string>('tables.csv', 'ANALYSIS_TIME_MUL_BY_LEVEL');
/** 표본 등급별로 해석 하나를 회수할 때 그 계열에 쌓이는 경험치 (`data/tables.csv`). */
export const ANALYSIS_XP_BY_RARITY: Readonly<Record<Rarity, number>> = numberMap<Rarity>('tables.csv', 'ANALYSIS_XP_BY_RARITY');
/** 흙 · 배지 등급별 소켓 칸 수 (`data/tables.csv`). 읽을 때는 `growSocketSlotsFor`. */
export const GROW_SOCKETS_BY_RARITY: Readonly<Record<Rarity, number>> = numberMap<Rarity>('tables.csv', 'GROW_SOCKETS_BY_RARITY');

/** 분석 레벨 상한 — `ANALYSIS_LEVEL_XP` 표의 줄 수 (코드에 5 를 적지 않는다). */
export const ANALYSIS_LEVEL_MAX: number = Math.max(1, Object.keys(ANALYSIS_LEVEL_XP_TABLE).length);

/** `level` 에 도달하는 누적 경험치 (Lv.1 = 0). 범위 밖이면 잘라 읽는다. */
export function analysisXpForLevel(level: number): number {
  const lv = Math.max(1, Math.min(ANALYSIS_LEVEL_MAX, Math.floor(level)));
  const v = ANALYSIS_LEVEL_XP_TABLE[String(lv)];
  return Number.isFinite(v) ? v : 0;
}

/** 누적 경험치 → 분석 레벨 (1 … `ANALYSIS_LEVEL_MAX`). */
export function analysisLevelForXp(xp: number): number {
  const x = Number.isFinite(xp) ? xp : 0;
  let lv = 1;
  for (let l = 2; l <= ANALYSIS_LEVEL_MAX; l++) if (x >= analysisXpForLevel(l)) lv = l;
  return lv;
}

/** 분석 레벨의 해석 시간 배수 (Lv.1 = 1). 표본의 `analyzeHours` 에 곱해진다 — 넣는 순간 확정. */
export function analysisTimeMul(level: number): number {
  const lv = Math.max(1, Math.min(ANALYSIS_LEVEL_MAX, Math.floor(level)));
  const v = ANALYSIS_TIME_MUL_TABLE[String(lv)];
  return Number.isFinite(v) && v > 0 ? v : 1;
}

/** 분석 결과표 한 줄 (`data/analysis_results.csv`). */
export interface AnalysisResultDef {
  family: SampleFamily;
  /** 이 줄이 추첨에 들어가는 최소 분석 레벨. */
  minLevel: number;
  defId: string;
  qtyMin: number;
  qtyMax: number;
  /** 같은 계열 · 해금된 줄끼리의 가중치. */
  weight: number;
}

export const ANALYSIS_RESULTS: readonly AnalysisResultDef[] = csvRows('analysis_results.csv').map((r) => {
  const qtyMin = r.int('qtyMin', { min: 1 });
  return {
    family: r.enum('family', SAMPLE_FAMILIES),
    minLevel: r.int('minLevel', { min: 1 }),
    defId: r.str('defId'),
    qtyMin,
    qtyMax: Math.max(qtyMin, r.int('qtyMax', { min: 1 })),
    weight: r.num('weight', { min: 0 }),
  };
});

/** 한 계열의 분석 레벨 (분석 도감 머리줄 · 분석 화면). */
export interface AnalysisLevelInfo {
  family: SampleFamily;
  level: number;
  /** 누적 경험치. */
  xp: number;
  /** 지금 레벨에 도달한 누적 경험치. */
  levelXp: number;
  /** 다음 레벨의 누적 경험치; 최대 레벨이면 null. */
  nextLevelXp: number | null;
  /** 지금 레벨의 해석 시간 배수 (`analysisTimeMul`). */
  timeMul: number;
}

/** 분석 도감의 결과 한 줄. */
export interface AnalysisResultInfo {
  defId: string;
  qtyMin: number;
  qtyMax: number;
  minLevel: number;
  /** 지금 레벨에서 해금됐는가. */
  unlocked: boolean;
  /** 지금 레벨에서 해석 한 번이 이것을 낼 확률 (0 … 1); 잠겼으면 0. */
  chance: number;
  /** 한 번이라도 회수해 본 산출물인가 (`ShipState.analysisFound`). */
  found: boolean;
}

export interface AnalysisSlot {
  /* ── appended (2026-09-13) ── */
  /** 넣은 표본의 계열 (넣는 순간 적는다). 없으면 옛 세이브 — 표본 def 에서 읽는다. */
  family?: SampleFamily;
  /** 넣는 순간 굴린 결과. 없으면 옛 세이브 — **회수할 때** 그때 레벨로 굴린다. */
  resultDefId?: string;
  resultQty?: number;
}

export interface AnalysisSlotInfo {
  /* ── appended (2026-09-13) ── */
  /** 칸에 든 표본의 계열; 빈 칸이면 null. */
  family: SampleFamily | null;
  /**
   * 해석 결과 — **끝난 칸에서만** 채워진다 (해석 중에는 null, 화면은 「?」). 끝난 칸에서는 `rewardDefId` · `rewardQty` 도 같은 값이고
   * `firstTime` 은 「이 결과가 분석 도감에 없다」로 읽는다. 옛 세이브의 칸(결과를 안 굴린 칸)은 끝나도 null 이고 회수하는 순간 굴린다.
   */
  resultDefId: string | null;
  resultQty: number;
}

export interface GrowSlot {
  /* ── appended (2026-09-13) ── */
  /** 부어 둔 흙의 남은 내구도 (0 … `SoilDef.durability`). 없으면 옛 세이브 — 처음 읽을 때 `soilUsesLeft / uses × durability` 로 옮긴다. */
  soilDurability?: number;
  /** 끼운 소켓 def id (끼운 순서). 영구 — 흙을 비우면 함께 사라진다. */
  sockets?: string[];
}

export interface GrowSlotInfo {
  /* ── appended (2026-09-13) ── */
  soilDurability: number;
  soilDurabilityMax: number;
  /** 보너스가 듣는 비율 = 내구도 / 최대 (0 … 1). 흙이 없으면 0. */
  soilBonusRatio: number;
  /** 끼운 소켓 def id. */
  sockets: readonly string[];
  /** 이 흙의 소켓 칸 수 (`growSocketSlotsFor(흙 등급)`); 흙이 없으면 0. */
  socketSlots: number;
}

export interface CultureSlot {
  /* ── appended (2026-09-13) ── */
  /** 부어 둔 배지의 남은 내구도. 없으면 옛 세이브 — 처음 읽을 때 `mediumUsesLeft / uses × durability` 로 옮긴다. */
  mediumDurability?: number;
  /** 끼운 소켓 def id (끼운 순서). 영구 — 배지를 비우면 함께 사라진다. */
  sockets?: string[];
  /** 들어 있는 배양 스캐폴드 def id (`ItemDef.scaffold`). 수확할 때 소모된다. */
  scaffoldDefId?: string;
}

export interface CultureSlotInfo {
  /* ── appended (2026-09-13) ── */
  mediumDurability: number;
  mediumDurabilityMax: number;
  /** 보너스가 듣는 비율 = 내구도 / 최대 (0 … 1). 배지가 없으면 0. */
  mediumBonusRatio: number;
  sockets: readonly string[];
  socketSlots: number;
  /** null = 스캐폴드 없음. 있고 세포주가 들어 있으면 `yieldDefId` 는 종별 고기다. */
  scaffoldDefId: string | null;
}

export interface ShipState {
  /* ── appended (2026-09-13, version 11) ── */
  /** 계열별 분석 누적 경험치 (없으면 0). */
  analysisXp?: Partial<Record<SampleFamily, number>>;
  /** 분석 도감: 분석기에서 한 번이라도 회수한 산출물 def id (append-only). */
  analysisFound?: string[];
}

export interface HousingRef {
  /* ══ appended: 2026-09-13 — 요리 재료 티어 ══ */
  /** 한 계열의 분석 레벨 · 경험치 · 시간 배수. */
  getAnalysisLevel(family: SampleFamily): AnalysisLevelInfo;
  /** 한 계열의 결과표 전부 (최소 레벨 순), 지금 레벨의 확률 · 해금 · 도감 여부와 함께. */
  getAnalysisResults(family: SampleFamily): AnalysisResultInfo[];
  /** 분석 도감 (`ShipState.analysisFound`). */
  getAnalysisFound(): readonly string[];
  /**
   * 부어 둔 흙에 소켓 하나를 (가방 → 창고) 끼운다. 소켓의 `target` 이 `'soil'` 이어야 한다. 빈 소켓 칸이 없으면
   * `replaceIndex` 를 줘야 하고 그 자리의 옛 소켓은 **파괴된다** (화면이 먼저 1초 홀드로 묻는다). 이미 자라는 작물에는
   * 소급하지 않는다 — 다음에 심는 작물부터 듣는다. 한국어 사유 / null.
   */
  insertGrowSocket(uid: string, tier: GrowTier, slot: number, socketDefId: string, replaceIndex?: number): string | null;
  /** 배지가 든 배양 칸에 소켓을 끼운다 (`target: 'medium'`). 규칙은 `insertGrowSocket` 과 같다. */
  insertCultureSocket(uid: string, slot: number, socketDefId: string, replaceIndex?: number): string | null;
  /** 배지가 있고 세포주 · 스캐폴드가 없는 칸에 배양 스캐폴드 하나를 (가방 → 창고) 넣는다. 한국어 사유 / null. */
  insertScaffold(uid: string, slot: number, scaffoldDefId: string): string | null;
  /** 세포주가 들어가기 전의 스캐폴드를 되돌려받는다 (`dest` 기본 `'bag-first'`). 한국어 사유 / null. */
  takeScaffold(uid: string, slot: number, dest?: HarvestDestination): string | null;
  /** 지금 가진 소켓 (가방 + 창고). `target` 을 주면 그쪽만. */
  getOwnedSockets(target?: GrowSocketTarget): { defId: string; qty: number }[];
}

/** 수확 한 번에 부어 둔 흙 · 배지가 잃는 내구도 (`data/tuning.csv`). */
export const SOIL_WEAR_PER_HARVEST = T.num('SOIL_WEAR_PER_HARVEST');
export const MEDIUM_WEAR_PER_HARVEST = T.num('MEDIUM_WEAR_PER_HARVEST');
/** 소켓 `speed` 를 합산한 성장 · 배양 시간 배수의 바닥. */
export const GROW_SOCKET_TIME_FLOOR = T.num('GROW_SOCKET_TIME_FLOOR');
/** 소켓 `wear` 를 합산한 마모 배수의 바닥. */
export const GROW_WEAR_MUL_FLOOR = T.num('GROW_WEAR_MUL_FLOOR');

/** 흙 · 배지 등급의 소켓 칸 수. 표에 없는 등급이면 0. */
export function growSocketSlotsFor(rarity: Rarity): number {
  const v = GROW_SOCKETS_BY_RARITY[rarity];
  return Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
}
/** 어떤 등급이든 가질 수 있는 소켓 칸의 최대 (세이브 검증의 상한). */
export const GROW_SOCKET_SLOTS_MAX: number = Math.max(0, ...Object.values(GROW_SOCKETS_BY_RARITY).map((v) => (Number.isFinite(v) ? Math.floor(v) : 0)));
/* ══ end 2026-09-13 요리 재료 티어 ══ */

/* ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
 * appended: 2026-09-13 — 요리 미니게임 (docs/plans/cooking-minigames.md, 사용자 결정 — 규칙 · 표는 `shared/cooking.ts`)
 *
 * 조리대 E → **조리대 화면**(`openCookStation`) — 요리 목록 · 재료 · 미니게임 순서 · 자동 가구 · 함선 창고 / 가방 카드.
 * 「조리 시작」(`startCook`) → 조리대 앞 자세 + 고정 카메라(hub, `housing:cookSession`) + 미니게임 오버레이 → 단계마다
 * 「직접 하기 / 자동」 → 끝나면 재료를 빼고 품질 붙은 요리 1개(`InventoryRef.completeCook`) → 결과 → `housing:cookResult`.
 * 중간에 닫으면(`cancelCook` · Esc · Tab · 페이즈 변경) 아무것도 소모되지 않는다. 함선 전용 · 내 함선 전용 · 한 번에 한 개.
 * ════════════════════════════════════════════════════════════════════════════════════════════════════════════════ */
import type { CookAutoInfo, CookGame, CookSessionInfo } from './cooking';

export interface HousingRef {
  /** 조리대 화면을 연다 (`uid` = 조리대 가구). 조리대가 아니거나 레이드 · 남의 함선이면 토스트만. */
  openCookStation?(uid: string): void;
  /** 진행 중인 조리 (미니게임 오버레이가 열려 있는 동안), 없으면 null. */
  readonly cookSession?: CookSessionInfo | null;
  /**
   * 지금 조리대 `uid` 에서 `recipeId` 를 시작할 수 없는 한국어 사유, null = 시작할 수 있다.
   * 순서: 조리대가 아니다 → 함선 · 내 함선이 아니다 → 이미 조리 중 → 요리 레시피가 아니다 / 단계가 없다 → `InventoryRef.cookBlock`(작업대 레벨 · 숙련 · 재료 · 자리).
   */
  cookBlock?(uid: string, recipeId: string): string | null;
  /** 조리를 시작한다 — 오버레이를 열고 `housing:cookSession {active:true}`. 한국어 사유 / null. 재료는 **끝날 때** 뺀다. */
  startCook?(uid: string, recipeId: string): string | null;
  /** 진행 중인 조리를 소모 없이 끝낸다 (`housing:cookSession {active:false, completed:false}`). 없으면 no-op. */
  cancelCook?(): void;
  /** 그 게임을 대신하는 자동 조리 가구 중 함선에 배치된 가장 높은 레벨의 것, 없으면 null. */
  getCookAuto?(game: CookGame): CookAutoInfo | null;
}
/* ══ end 2026-09-13 요리 미니게임 ══ */
