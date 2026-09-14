import type {
  CraftIngredient, FacilityId, FacilityRequirement, FurnitureDef, GrowTier, ItemDef, PlacedBook, PlacedFurniture, RoomPurpose, ShipState, SkillId,
  SoilTag,
} from '@/shared';
import {
  COCKPIT_ROOM_INDEX, ROOM_PURPOSES_ASSIGNABLE, roomGridSize, roomRectBlocked,
  ANALYZE_DEX_SPEEDUP, ANALYZE_KNOWN_SPEEDUP,
  BENCH_MAX_LEVEL, BOOK_GAIN_MAX, BOOK_RARITY_MUL, BOOK_XP_PER_BOOK, FACILITY_LABEL_KO, FURNITURE_DEF_MAP, GENERATOR_MAX_LEVEL, GENERATOR_START_LEVEL, GENERATOR_UPGRADE_COST, PRESETS_BY_RANGE_LEVEL,
  GROW_SKILL_SPEEDUP, GROW_STATION_SPEED_PER_LEVEL, GROW_TIER_DRAW_ORDER, SKILL_LEVEL_MAX, SOIL_MATCH_SPEEDUP, SOIL_MISMATCH_PENALTY, growTiersForLevel,
  RANGE_SKILL_GAIN_PER_LEVEL, RANGE_UPGRADE_COST, ROOM_GRID_COLS, ROOM_GRID_ROWS, ROOM_PURPOSE_LABEL_KO,
  ROOM_PURPOSES, ROOM_PURPOSE_BUILD_COST, purposeGeneratorLevel,
  SHIP_ROOM_COUNT,
  STASH_COLS, STASH_ROWS_BY_STORAGE_LEVEL, STORAGE_MAX_LEVEL, STORAGE_UPGRADE_COST,
  WORKSHOP_UPGRADE_COST, benchKindOf, furnitureFootprint,
} from '@/shared';
/* 2026-09-13 (요리 재료 티어) */
import type { AnalysisResultDef, SampleFamily } from '@/shared';
import { ANALYSIS_RESULTS, GROW_SOCKET_TIME_FLOOR, GROW_WEAR_MUL_FLOOR, analysisTimeMul } from '@/shared';

/* ────────────────────────────────────────────────────────────────────────────
 * Pure housing rules: placement, costs, prerequisites. No ctx, no DOM — every function takes the state (or the piece
 * of it that matters) plus callbacks for the two things that live elsewhere (material counts, item names) so the
 * system and the panels agree on one implementation and the smoke can reason about the numbers.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Units of `defId` the player owns (bag + stash). */
export type CountFn = (defId: string) => number;
/** 한국어 item name for a def id (falls back to the id). */
export type NameFn = (defId: string) => string;

/** Lowest craft-cost multiplier the workshop discount may reach. */
export const CRAFT_COST_MUL_MIN = 0.5;

/* ── facilities ───────────────────────────────────────────────────────────── */

/**
 * 2026-09-12 (사용자 결정 — **방 시설 레벨 제거**): 작업실 · 시뮬레이션실은 레벨이 없다 (방이 있으면 1, 없으면 0).
 * 강화는 그 방 안의 가구가 한다 — 작업대(레시피), 관물대(프리셋 슬롯), 시뮬레이션 허브(사격 숙련 상승). 발전기 ·
 * 창고는 함선 전체 시설이라 그대로 레벨을 갖는다.
 */
export function facilityMaxLevel(id: FacilityId): number {
  switch (id) {
    case 'generator': return GENERATOR_MAX_LEVEL;
    case 'storage': return STORAGE_MAX_LEVEL;
    case 'workshop': return 1;
    case 'range': return 1;
  }
}

/** Purpose a room-bound facility needs, null for ship-wide facilities. */
export function facilityPurpose(id: FacilityId): RoomPurpose | null {
  return id === 'workshop' ? 'workshop' : id === 'range' ? 'range' : null;
}

/** Facility a room purpose carries (`workshop` / `range`), null for every other purpose. */
export function facilityPurposeOf(purpose: RoomPurpose): FacilityId | null {
  return purpose === 'workshop' ? 'workshop' : purpose === 'range' ? 'range' : null;
}

/** Current level of a facility. Room facilities read the (first) room of their purpose, 0 when there is none. */
export function facilityLevel(state: ShipState, id: FacilityId): number {
  if (id === 'generator') return state.generatorLevel;
  if (id === 'storage') return state.storageLevel;
  const purpose = facilityPurpose(id)!;
  const room = state.rooms.find((r) => r.purpose === purpose);
  return room ? Math.max(1, room.level) : 0;
}

/**
 * Cost to raise `id` from `level` to `level + 1`, null at max. Ship-wide tables start at level 1 (`cost[level]`).
 * Room facilities (작업실 · 시뮬레이션실) have no levels since 2026-09-12 → always null.
 */
export function nextFacilityCost(id: FacilityId, level: number): CraftIngredient[] | null {
  if (level >= facilityMaxLevel(id)) return null;
  switch (id) {
    case 'generator': return GENERATOR_UPGRADE_COST[level] ?? null;
    case 'storage': return STORAGE_UPGRADE_COST[level] ?? null;
    case 'workshop': return null;
    case 'range': return null;
  }
}

/**
 * 옛 세이브의 방 시설 레벨이 **쓴 재료** (Lv.1 → `level`, 재료별 합산). 2026-09-12 에 방 시설 레벨을 없애면서
 * `ShipState.sanitize` 가 레벨 2 이상인 작업실 · 사격장을 만나면 이 값을 함선 창고로 돌려준다 — 은퇴 가구
 * (`furnitureRefundCost`)와 같은 철학이다. 표는 `data/facility_upgrades.csv` 의 은퇴 묶음(`workshop` · `range`)이다.
 */
export function legacyRoomLevelCost(id: 'workshop' | 'range', level: number): CraftIngredient[] {
  const table = id === 'workshop' ? WORKSHOP_UPGRADE_COST : RANGE_UPGRADE_COST;
  const total = new Map<string, number>();
  for (let k = 1; k < Math.floor(level); k++) {
    for (const c of table[k - 1] ?? []) total.set(c.defId, (total.get(c.defId) ?? 0) + c.qty);
  }
  return [...total].map(([defId, qty]) => ({ defId, qty }));
}

/** Ingredients still missing for `cost` (qty = shortfall); empty when affordable. */
export function missingIngredients(cost: readonly CraftIngredient[], count: CountFn): CraftIngredient[] {
  const out: CraftIngredient[] = [];
  for (const c of cost) {
    const have = count(c.defId);
    if (have < c.qty) out.push({ defId: c.defId, qty: c.qty - have });
  }
  return out;
}

export function formatCost(cost: readonly CraftIngredient[], nameOf: NameFn): string {
  return cost.map((c) => `${nameOf(c.defId)} ${c.qty}`).join(' · ');
}

/** 한국어 reason the generator gate blocks a target level, null when the generator is high enough. */
export function generatorGateReason(state: ShipState, targetLevel: number): string | null {
  return state.generatorLevel >= targetLevel ? null : `발전기 레벨 ${targetLevel} 필요 (현재 ${state.generatorLevel})`;
}

/** Why `id` cannot be upgraded right now; null = go ahead. Order: max → room → generator → materials. */
export function facilityBlockReason(state: ShipState, id: FacilityId, count: CountFn, nameOf: NameFn): string | null {
  const level = facilityLevel(state, id);
  const purpose = facilityPurpose(id);
  // 2026-09-12: 방 시설에는 레벨이 없다 — 방이 없으면 그 사유, 있으면 「가구를 강화하세요」
  if (purpose) return level < 1 ? `${ROOM_PURPOSE_LABEL_KO[purpose]} 용도의 방이 필요합니다` : '시설 레벨은 없습니다 — 시설 안의 가구를 강화하세요';
  if (level >= facilityMaxLevel(id)) return '최대 레벨입니다';
  const target = level + 1;
  if (id !== 'generator') {
    const gate = generatorGateReason(state, target);
    if (gate) return gate;
  }
  const cost = nextFacilityCost(id, level);
  if (!cost) return '업그레이드할 수 없습니다';
  const missing = missingIngredients(cost, count);
  if (missing.length) return `재료 부족: ${formatCost(missing, nameOf)}`;
  return null;
}

export function facilityName(id: FacilityId): string { return FACILITY_LABEL_KO[id]; }

/**
 * Everything the player has **spent** raising `id` to `level`, merged per material (Phase 9 UI pass — the 시설 제거
 * button in the 방 목록 refunds it into the 함선 창고). Level 1 of a room facility comes free with the purpose, so
 * only the level → level + 1 tables from `nextFacilityCost` are summed; a ship-wide facility starts at level 0 and
 * therefore refunds its first step too. Empty array when nothing was ever paid.
 */
export function facilityRefundCost(id: FacilityId, level: number): CraftIngredient[] {
  const start = facilityPurpose(id) ? 1 : 0;       // room facilities: level 1 is paid by the 시설 증축 instead
  const total = new Map<string, number>();
  for (let k = start; k < level; k++) {
    for (const c of nextFacilityCost(id, k) ?? []) total.set(c.defId, (total.get(c.defId) ?? 0) + c.qty);
  }
  return [...total].map(([defId, qty]) => ({ defId, qty }));
}

/* ── 시설 증축 (Phase 9 UI pass) ───────────────────────────────────────────
 * Giving an empty room a purpose costs materials now (`ROOM_PURPOSE_BUILD_COST`) and sits behind the same 발전기
 * gate as every other upgrade. 빈 방 (tearing a room back down) stays free and always refunds.
 * ────────────────────────────────────────────────────────────────────────── */

/** Materials a 시설 증축 to `purpose` costs; empty for 빈 방 (and for anything the table does not know). */
export function purposeBuildCost(purpose: RoomPurpose): readonly CraftIngredient[] {
  return purpose === 'empty' ? [] : ROOM_PURPOSE_BUILD_COST[purpose] ?? [];
}

/**
 * Full 한국어 reason a 시설 증축 is refused; null = go ahead. Structure first (`purposeChangeReason` — locked room,
 * duplicate facility, blocking furniture, 연구실 prerequisite), then the 발전기 gate, then the materials. 빈 방 only
 * ever hits the structural rules.
 */
export function purposeBuildBlockReason(
  state: ShipState, index: number, purpose: RoomPurpose, count: CountFn, nameOf: NameFn,
): string | null {
  const structural = purposeChangeReason(state, index, purpose);
  if (structural) return structural;
  if (purpose === 'empty') return null;
  // 2026-09-13 (사용자 결정 — 전력 할당 폐지): 용도마다 필요한 발전기 레벨이 다르다 (`purposeGeneratorLevel`)
  const gate = generatorGateReason(state, purposeGeneratorLevel(purpose));
  if (gate) return gate;
  const missing = missingIngredients(purposeBuildCost(purpose), count);
  if (missing.length) return `재료 부족: ${formatCost(missing, nameOf)}`;
  return null;
}

/**
 * Everything a room got charged for: the 시설 증축 plus every facility upgrade above level 1. This is what 시설 제거
 * hands back into the 함선 창고.
 */
export function roomRefundCost(purpose: RoomPurpose, level: number): CraftIngredient[] {
  const total = new Map<string, number>();
  for (const c of purposeBuildCost(purpose)) total.set(c.defId, (total.get(c.defId) ?? 0) + c.qty);
  const fid = facilityPurposeOf(purpose);
  if (fid) {
    for (const c of facilityRefundCost(fid, Math.max(1, level))) total.set(c.defId, (total.get(c.defId) ?? 0) + c.qty);
  }
  return [...total].map(([defId, qty]) => ({ defId, qty }));
}

/* ── derived numbers ──────────────────────────────────────────────────────── */

export function stashSizeFor(storageLevel: number): { cols: number; rows: number } {
  const i = Math.max(0, Math.min(STASH_ROWS_BY_STORAGE_LEVEL.length - 1, Math.floor(storageLevel)));
  return { cols: STASH_COLS, rows: STASH_ROWS_BY_STORAGE_LEVEL[i] };
}

/**
 * Preset slots for the highest placed **관물대** level (0 = none placed). 2026-09-12: was the 사격장 room level.
 * @deprecated 2026-09-12 (사용자 결정 — 프리셋 기능 제거 · 관물대 은퇴): no caller; `getPresetCount()` is always 0.
 */
export function presetCountFor(consoleLevel: number): number {
  const i = Math.max(0, Math.min(PRESETS_BY_RANGE_LEVEL.length - 1, Math.floor(consoleLevel)));
  return PRESETS_BY_RANGE_LEVEL[i];
}

/**
 * Craft material multiplier. **Always 1 since 2026-09-12** — the 작업실 discount went away with the room levels
 * (사용자 결정). Kept so `HousingRef.getCraftCostMul` (contract) has one place to answer from.
 */
export function craftCostMulFor(_workshopLevel: number): number {
  return 1;
}

/**
 * Gun skills gain `1 + RANGE_SKILL_GAIN_PER_LEVEL × level` of the highest placed **시뮬레이션 허브** (0 = none);
 * everything else 1. 2026-09-12: was the 사격장 room level.
 * @deprecated 2026-09-12 (사용자 결정 — 시뮬레이션실 · 시뮬레이션 허브 제거): no caller; `getSkillGainMul` is the 서재 alone.
 */
export function skillGainMulFor(skill: SkillId, simHubLevel: number): number {
  return skill.startsWith('gun_') && simHubLevel > 0 ? 1 + RANGE_SKILL_GAIN_PER_LEVEL * simHubLevel : 1;
}

/* ── 서재 책장 (Phase 9) ──────────────────────────────────────────────────── */

/** Weight one shelved book contributes (`BOOK_RARITY_MUL[rarity]`); 0 for anything that is not a 서적. */
export function bookWeightOf(def: ItemDef | undefined): number {
  if (!def || !def.book) return 0;
  const w = BOOK_RARITY_MUL[def.rarity];
  return Number.isFinite(w) && w > 0 ? w : 0;
}

/**
 * 서재 multiplier for `skill`: `min(BOOK_GAIN_MAX, 1 + BOOK_XP_PER_BOOK × Σ BOOK_RARITY_MUL[rarity])` over every shelved
 * book of that skill on the ship (any shelf, any room); exactly 1 when none. `defOf` resolves a book's def (unknown or
 * non-book ids weigh 0). Multiplied into `HousingRef.getSkillGainMul` next to the 시뮬레이션 허브 factor.
 */
export function bookGainMulFor(skill: SkillId, books: readonly PlacedBook[], defOf: (defId: string) => ItemDef | undefined): number {
  let sum = 0;
  for (const b of books) {
    const def = defOf(b.defId);
    if (def?.book?.skill === skill) sum += bookWeightOf(def);
  }
  if (sum <= 0) return 1;
  return Math.min(BOOK_GAIN_MAX, 1 + BOOK_XP_PER_BOOK * sum);
}

/* ── 서재 매체 (A-3e, 2026-09-12) ─────────────────────────────────────────────
 * 책장 · 디스크 전시대 · 레코드랙은 같은 규칙이다 — 매체마다 몫을 **따로 상한으로 자르고**, 그 매체의 보조 가구가 함선
 * 어딘가에 배치돼 있으면 자른 뒤에 `1 + SHELF_AUX_BONUS[m]` 을 곱하고, 셋을 더한다 (docs/plans/a3a-a3e.md §4):
 *
 *     몫[m]     = min(SHELF_GAIN_MAX[m] − 1, SHELF_XP_PER_ITEM[m] × Σ BOOK_RARITY_MUL[등급]) × (보조 가구 ? 1 + SHELF_AUX_BONUS[m] : 1)
 *     서재 배율 = 1 + 몫[책] + 몫[디스크] + 몫[레코드]
 *
 * 책만 있고 보조 가구가 없으면 `1 + min(BOOK_GAIN_MAX − 1, x)` = `min(BOOK_GAIN_MAX, 1 + x)` 라 `bookGainMulFor` 와 **같은 값**이다
 * (`smoke-library` 의 Phase 9 검사가 그대로 통과해야 한다). 수치는 전부 계약의 `SHELF_*` 표(= `data/constants.csv`)에서 온다.
 * ────────────────────────────────────────────────────────────────────────── */
import type { ShelfBonusInfo, ShelfMedium } from '@/shared';
import { SHELF_AUX_BONUS, SHELF_AUX_INTERACTION, SHELF_GAIN_MAX, SHELF_MEDIA, SHELF_XP_PER_ITEM, shelfItemOf } from '@/shared';

/** 세이브의 매체 id 접두사 — `ctx.loot` 가 없을 때(`sanitize`) 모양만 보는 규칙. 진짜 매체인지는 런타임에 걸러 낸다. */
export const SHELF_ID_PREFIX: Readonly<Record<ShelfMedium, string>> = { book: 'book_', disc: 'disc_', record: 'record_', game: 'game_' };
const SHELF_ID_SHAPE = /^(book|disc|record|game)_[A-Za-z0-9_]{1,40}$/;

/** 매체 id **모양**(`book_*` · `disc_*` · `record_*` · 2026-09-13 `game_*`)에서 읽은 매체, 모양이 아니면 null. */
export function shelfMediumOfDefId(defId: unknown): ShelfMedium | null {
  if (typeof defId !== 'string') return null;
  const m = SHELF_ID_SHAPE.exec(defId);
  return m ? (m[1] as ShelfMedium) : null;
}

/** 꽂힌 한 장(권)의 가중치 `BOOK_RARITY_MUL[rarity]` — 서재 매체가 아니면 0. `bookWeightOf` 의 매체 공통판. */
export function shelfItemWeightOf(def: ItemDef | undefined): number {
  if (!def || !shelfItemOf(def)) return 0;
  const w = BOOK_RARITY_MUL[def.rarity];
  return Number.isFinite(w) && w > 0 ? w : 0;
}

/**
 * 매체 `medium` 의 몫: `items` 중 그 매체이면서 `skill` 을 가르치는 것의 가중치 합 × `SHELF_XP_PER_ITEM[medium]`, 상한
 * `SHELF_GAIN_MAX[medium] − 1` 로 자른 뒤 보조 가구 배율. 없으면 정확히 0.
 */
export function shelfPartFor(
  medium: ShelfMedium, skill: SkillId, items: readonly PlacedBook[], defOf: (defId: string) => ItemDef | undefined, aux: boolean,
): number {
  let sum = 0;
  for (const it of items) {
    const def = defOf(it.defId);
    const s = shelfItemOf(def);
    if (s && s.medium === medium && s.skill === skill) sum += shelfItemWeightOf(def);
  }
  if (sum <= 0) return 0;
  const part = Math.min(SHELF_GAIN_MAX[medium] - 1, SHELF_XP_PER_ITEM[medium] * sum);
  return aux ? part * (1 + SHELF_AUX_BONUS[medium]) : part;
}

/**
 * 그 매체의 보조 가구(`SHELF_AUX_INTERACTION[medium]`)가 함선 어딘가에 배치돼 있는가. 여러 대여도 **한 번**이다 —
 * 축음기 · 주크박스 · 턴테이블은 모두 `record_player` 라 이 질의 하나가 「셋은 외형만 다른 한 역할」(사용자 결정)을 성립시킨다.
 */
export function shelfAuxPlaced(furniture: readonly PlacedFurniture[], medium: ShelfMedium): boolean {
  const want = SHELF_AUX_INTERACTION[medium];
  return furniture.some((f) => FURNITURE_DEF_MAP.get(f.defId)?.interaction === want);
}

/** 한 숙련의 서재 배율을 매체별로 (`HousingRef.getShelfBonus`). `books` = `ShipState.books`, `media` = `ShipState.media`. */
export function shelfGainFor(
  skill: SkillId, books: readonly PlacedBook[], media: readonly PlacedBook[],
  defOf: (defId: string) => ItemDef | undefined, aux: Readonly<Record<ShelfMedium, boolean>>,
): ShelfBonusInfo {
  const parts: Record<ShelfMedium, number> = { book: 0, disc: 0, record: 0, game: 0 };
  for (const m of SHELF_MEDIA) parts[m] = shelfPartFor(m, skill, m === 'book' ? books : media, defOf, aux[m]);
  return { total: 1 + parts.book + parts.disc + parts.record, parts, aux: { book: aux.book, disc: aux.disc, record: aux.record, game: false } };
}

/* ── 서재 시리즈 (2026-09-13, docs/plans/library-series-games.md — 사용자 결정) ─────────────────────────────────────
 * **옛 공식은 은퇴했다** — 위의 `bookWeightOf` · `bookGainMulFor` · `shelfItemWeightOf` · `shelfPartFor` · `shelfGainFor` 와 계약의
 * `BOOK_RARITY_MUL` · `SHELF_XP_PER_ITEM` · `SHELF_GAIN_MAX` 는 이름만 남는다 (호출자 없음 — 추가만 하는 규약). 새 공식:
 *
 *     가진 권수 = 작동 중인 보관함에 꽂힌 그 시리즈의 **서로 다른 권** 수 (같은 def 여러 장 = 1, 같은 권 번호 = 1)
 *     시리즈 몫 = librarySeriesFraction(가진 권수, 전체 권수)   ← 전권이면 1, 아니면 권당 SHELF_SERIES_VOLUME_SHARE
 *     줄 값     = 전권 값 × 시리즈 몫 × (그 매체의 보조 가구가 작동 중 ? 1 + SHELF_AUX_BONUS[매체] : 1)
 *     합산      = 같은 (종류, 대상)끼리 더한다 → `LibraryEffectsSummary`. `recipe` 는 몫 1 인 시리즈의 대상만 연다.
 *
 * 입력 `items` 는 **이미 작동 중인 보관함으로 거른** 칸 목록이다 — 전력 판정 · 캐시 · 이벤트는 `parts/Library` 가 하고, 이 절은 ctx 를 모른다.
 * 게임 디스크(`'game'`)는 효과가 없는 보관 매체라 여기에 오지 않는다 (시리즈가 없다).
 * ────────────────────────────────────────────────────────────────────────── */
import type { LibraryEffect, LibraryEffectKind, LibraryEffectsSummary, LibraryMedium, LibrarySeriesDef, LibrarySourceInfo } from '@/shared';
import { LIBRARY_SERIES_MAP, librarySeriesFraction } from '@/shared';

/** 보관함에 꽂을 수 있는 아이템이면 그 매체 — 책 · 디스크 · 레코드(`shelfItemOf`) + 게임 디스크(`ItemDef.gameDisc`), 아니면 null. */
export function shelfHolderMediumOfItem(def: ItemDef | null | undefined): ShelfMedium | null {
  if (!def) return null;
  if (def.gameDisc) return 'game';
  return shelfItemOf(def)?.medium ?? null;
}

/** 서재 효과 매체 아이템의 시리즈 · 권 번호 (`ItemDef.book` / `disc` / `record` 의 `series` · `volume`). 시리즈가 없으면 null. 권 번호가 없으면 1. */
export function librarySeriesOfItem(def: ItemDef | null | undefined): { medium: LibraryMedium; seriesId: string; volume: number } | null {
  if (!def) return null;
  const medium: LibraryMedium | null = def.book ? 'book' : def.disc ? 'disc' : def.record ? 'record' : null;
  const data = def.book ?? def.disc ?? def.record;
  if (!medium || !data || typeof data.series !== 'string' || !data.series) return null;
  const v = Math.floor(Number(data.volume ?? 1));
  return { medium, seriesId: data.series, volume: Number.isFinite(v) && v >= 1 ? v : 1 };
}

/** 한 시리즈의 지금 상태 (`computeLibraryEffects` 가 꽂힌 권이 있는 시리즈마다 하나). */
export interface LibrarySeriesState {
  def: LibrarySeriesDef;
  /** 작동 중인 보관함에 꽂힌 서로 다른 권 수. */
  have: number;
  total: number;
  /** `librarySeriesFraction(have, total)`. */
  fraction: number;
  /** 그 매체의 보조 가구가 작동 중인가 (몫이 0 이어도 적는다). */
  auxApplied: boolean;
  /** 꽂힌 권 번호 (서로 다른, 오름차순). */
  volumes: readonly number[];
  /** 꽂힌 권의 item def id (파일 순서). */
  defIds: readonly string[];
}

export interface LibraryComputation {
  /** 합산 (리비전 없이 — 리비전은 캐시가 붙인다). */
  effects: Omit<LibraryEffectsSummary, 'revision'>;
  /** 꽂힌 권이 하나라도 있는 시리즈. */
  series: ReadonlyMap<string, LibrarySeriesState>;
}

/** 부동소수 찌꺼기 자르기 (1e-9) — 서명 비교 · 화면 숫자가 `0.30000000000000004` 를 보지 않게. */
function libRound(v: number): number {
  return Math.round(v * 1e9) / 1e9;
}

/** 효과 줄 하나가 지금 실제로 더하는 값: `recipe` = 몫 1 이면 1, 나머지 = 전권 값 × 몫 × 보조 가구 배율. */
export function libraryLineValue(effect: LibraryEffect, s: Pick<LibrarySeriesState, 'def' | 'fraction' | 'auxApplied'>): number {
  if (effect.kind === 'recipe') return s.fraction >= 1 ? 1 : 0;
  const aux = s.auxApplied ? 1 + (SHELF_AUX_BONUS[s.def.medium] ?? 0) : 1;
  return libRound(effect.value * s.fraction * aux);
}

/**
 * 서재 효과 합산 (순수). `items` = 작동 중인 보관함에 꽂힌 칸들 (책 + 디스크 · 레코드 — 게임 디스크가 섞여도 시리즈가 없어 무시된다),
 * `aux` = 매체별 보조 가구 작동 여부, `seriesMap` = 시리즈 표 (스모크가 주입할 수 있게 인자다). def 는 **한 번만** 센다.
 * 시리즈의 매체와 아이템의 매체가 다르면(데이터 오류) 세지 않는다.
 */
export function computeLibraryEffects(
  items: readonly PlacedBook[], defOf: (defId: string) => ItemDef | undefined,
  aux: Readonly<Partial<Record<ShelfMedium, boolean>>>, seriesMap: ReadonlyMap<string, LibrarySeriesDef> = LIBRARY_SERIES_MAP,
): LibraryComputation {
  const groups = new Map<string, { vols: Set<number>; defIds: string[] }>();
  const counted = new Set<string>();
  for (const it of items) {
    if (counted.has(it.defId)) continue;
    counted.add(it.defId);
    const s = librarySeriesOfItem(defOf(it.defId));
    if (!s) continue;
    const def = seriesMap.get(s.seriesId);
    if (!def || def.medium !== s.medium) continue;
    let g = groups.get(def.id);
    if (!g) { g = { vols: new Set(), defIds: [] }; groups.set(def.id, g); }
    g.vols.add(Math.min(Math.max(1, def.volumes), s.volume));
    g.defIds.push(it.defId);
  }
  const skillGain: Partial<Record<SkillId, number>> = {};
  const derived: Partial<Record<string, number>> = {};
  const gymScore: Partial<Record<string, number>> = {};
  const cookScore: Partial<Record<string, number>> = {};
  const trustXp: Partial<Record<string, number>> = {};
  const recipes: string[] = [];
  let raidXp = 0;
  const add = (rec: Partial<Record<string, number>>, k: string, v: number): void => { rec[k] = libRound((rec[k] ?? 0) + v); };
  const series = new Map<string, LibrarySeriesState>();
  for (const [id, g] of groups) {
    const def = seriesMap.get(id)!;
    const total = Math.max(1, def.volumes);
    const have = g.vols.size;
    const st: LibrarySeriesState = {
      def, have, total, fraction: librarySeriesFraction(have, total), auxApplied: aux[def.medium] === true,
      volumes: [...g.vols].sort((a, b) => a - b), defIds: g.defIds,
    };
    series.set(id, st);
    for (const e of def.effects) {
      const v = libraryLineValue(e, st);
      if (!v) continue;
      switch (e.kind) {
        case 'skillGain': add(skillGain, e.target, v); break;
        case 'derived': add(derived, e.target, v); break;
        case 'gymScore': add(gymScore, e.target, v); break;
        case 'cookScore': add(cookScore, e.target, v); break;
        case 'raidXp': raidXp = libRound(raidXp + v); break;
        case 'trustXp': add(trustXp, e.target, v); break;
        case 'recipe': if (!recipes.includes(e.target)) recipes.push(e.target); break;
      }
    }
  }
  return {
    effects: {
      skillGain, derived: derived as LibraryEffectsSummary['derived'], gymScore: gymScore as LibraryEffectsSummary['gymScore'],
      cookScore: cookScore as LibraryEffectsSummary['cookScore'], raidXp, trustXp: trustXp as LibraryEffectsSummary['trustXp'], recipes,
    },
    series,
  };
}

/** 한 효과 대상에 값을 주는 시리즈들 (`HousingRef.getLibrarySources`) — 값 큰 순. 값이 0 인 시리즈는 뺀다. */
export function librarySourcesIn(comp: LibraryComputation, kind: LibraryEffectKind, target: string): LibrarySourceInfo[] {
  const out: LibrarySourceInfo[] = [];
  for (const st of comp.series.values()) {
    for (const e of st.def.effects) {
      if (e.kind !== kind || e.target !== target) continue;
      const value = libraryLineValue(e, st);
      if (!value) continue;
      out.push({
        seriesId: st.def.id, name: st.def.name, medium: st.def.medium, have: st.have, total: st.total, fraction: st.fraction,
        value, fullValue: e.kind === 'recipe' ? 1 : e.value, auxApplied: st.auxApplied && e.kind !== 'recipe', defIds: st.defIds,
      });
    }
  }
  out.sort((a, b) => b.value - a.value || a.seriesId.localeCompare(b.seriesId));
  return out;
}

/** 한 숙련의 서재 배율을 매체별로 (`HousingRef.getShelfBonus` — 옛 모양 그대로, 값은 시리즈 공식). 게임 디스크 몫은 늘 0. */
export function shelfBonusFromLibrary(comp: LibraryComputation, skill: SkillId, aux: Readonly<Partial<Record<ShelfMedium, boolean>>>): ShelfBonusInfo {
  const parts: Record<ShelfMedium, number> = { book: 0, disc: 0, record: 0, game: 0 };
  for (const st of comp.series.values()) {
    for (const e of st.def.effects) if (e.kind === 'skillGain' && e.target === skill) parts[st.def.medium] = libRound(parts[st.def.medium] + libraryLineValue(e, st));
  }
  return {
    total: libRound(1 + parts.book + parts.disc + parts.record), parts,
    aux: { book: aux.book === true, disc: aux.disc === true, record: aux.record === true, game: false },
  };
}

/** 합산의 내용 서명 (리비전 제외, 키 정렬 · 소수 6자리) — 캐시가 「실제로 바뀌었나」를 이것으로 본다. */
export function libraryEffectsSignature(e: Omit<LibraryEffectsSummary, 'revision'>): string {
  const rec = (r: Readonly<Partial<Record<string, number>>>): string =>
    Object.keys(r).filter((k) => r[k]).sort().map((k) => `${k}=${(r[k] as number).toFixed(6)}`).join(',');
  return [rec(e.skillGain), rec(e.derived), rec(e.gymScore), rec(e.cookScore), e.raidXp.toFixed(6), rec(e.trustXp), [...e.recipes].sort().join(',')].join('|');
}

/* ── 온실 재배 스테이션 (2026-09-11) ──────────────────────────────────────────
 * 순수 판정만 여기 있다 — 층이 열렸는가 · 토양 궁합 · 성장에 걸리는 시간 · 진행도. 상태를 건드리는 것은
 * `parts/Garden.ts` 이고, 수치는 전부 `@/shared`(= `data/*.csv`) 에서 온다.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * 재배 스테이션 레벨이 `tier` 를 여는 최소 레벨 (아래 2 · 위 3). 숫자를 다시 적지 않고 계약
 * (`growTiersForLevel`) 에서 **유도한다** — 층을 여는 레벨이 바뀌면 이 함수가 저절로 따라간다.
 */
export function growTierUnlockLevel(tier: GrowTier): number {
  const max = GROW_TIER_DRAW_ORDER.length;
  for (let level = 1; level <= max; level++) if (growTiersForLevel(level).includes(tier)) return level;
  return max;
}

/** Is `tier` open at a station of `level`? */
export function growTierOpen(level: number, tier: GrowTier): boolean {
  return growTiersForLevel(Math.max(0, Math.floor(level))).includes(tier);
}

/** 씨앗이 원하는 토양과 부어 둔 토양이 같은가 (둘 중 하나라도 모르면 false = 궁합 패널티). */
export function soilMatches(soilTag: SoilTag | null | undefined, seedTag: SoilTag | null | undefined): boolean {
  return !!soilTag && !!seedTag && soilTag === seedTag;
}

/**
 * 재배 스테이션 레벨의 **성장 속도 배율** (2026-09-13, 사용자 결정): `1 + GROW_STATION_SPEED_PER_LEVEL × (레벨 − 1)` —
 * Lv.1 = 1 · Lv.2 = 1.15 · Lv.3 = 1.3. 성장 시간은 이 값으로 **나눈다**. 레벨 1 미만은 1 로 본다.
 */
export function growStationSpeedMul(level: number): number {
  const lv = Math.max(1, Math.floor(Number.isFinite(level) ? level : 1));
  return 1 + Math.max(0, GROW_STATION_SPEED_PER_LEVEL) * (lv - 1);
}

/** 화면용 「+15%」 — 레벨이 올려 준 성장 속도(%), 반올림. Lv.1 = 0. */
export function growStationSpeedPct(level: number): number {
  return Math.round((growStationSpeedMul(level) - 1) * 100);
}

/**
 * 심는 순간 확정되는 성장 시간(ms): `growHours × 3600e3 × 원예 단축 × 토양 궁합 ÷ 스테이션 속도`.
 * 궁합이 맞으면 `1 − SOIL_MATCH_SPEEDUP`, 아니면 `1 + SOIL_MISMATCH_PENALTY` 다 (토양 없이 심는 경우는 없다).
 * 스테이션 속도는 `growStationSpeedMul(stationLevel)` (2026-09-13 — 생략하면 Lv.1 = 1). 1초 미만으로는 내려가지 않는다.
 */
export function growDurationMs(
  growHours: number, matched: boolean, gardening: number, stationLevel = 1, bonusRatio = 1, socketSpeed = 0,
): number {
  const skill = Math.max(0, Math.min(SKILL_LEVEL_MAX, gardening));
  const speed = 1 - GROW_SKILL_SPEEDUP * (skill / SKILL_LEVEL_MAX);
  /* 2026-09-13 (요리 재료 티어): 궁합 **보너스**만 흙 내구도 비율로 준다 — 패널티는 그대로다. 비율 1 이면 옛 식과 같은 값. */
  const ratio = clamp01(bonusRatio);
  const soil = matched ? (ratio >= 1 ? 1 - SOIL_MATCH_SPEEDUP : 1 - SOIL_MATCH_SPEEDUP * ratio) : 1 + SOIL_MISMATCH_PENALTY;
  const station = growStationSpeedMul(stationLevel);
  return Math.max(1000, Math.round((Math.max(0, growHours) * 3600e3 * speed * soil * socketTimeMul(socketSpeed, ratio)) / station));
}

/**
 * **강화 순간의 재배 시간 재조정** (2026-09-13, 사용자 결정 — 「readyAt 은 심는 순간 확정」의 **유일한 예외**).
 * 스테이션 속도가 `oldMul` → `newMul` 로 오르면 자라던 작물의 타임라인을 **지금(`now`)을 축으로** `oldMul / newMul`
 * 만큼 압축한다: 남은 시간이 그 비율로 줄고, 이미 지난 구간도 같은 비율로 줄여 **진행도(%)가 그대로** 이어진다
 * (`plantedAt` 만 두면 막대가 한 번에 튄다). 이미 여문 작물(`now ≥ readyAt`)과 속도가 오르지 않은 경우는 그대로 돌려준다.
 * `readyAt` 은 `now` 보다 앞당겨지지 않고, `plantedAt` 은 늘 `readyAt` 보다 이르다.
 */
export function rescaleGrowTimes(
  now: number, plantedAt: number, readyAt: number, oldMul: number, newMul: number,
): { plantedAt: number; readyAt: number } {
  if (!(oldMul > 0) || !(newMul > 0) || newMul <= oldMul || now >= readyAt) return { plantedAt, readyAt };
  const ratio = oldMul / newMul;
  const remaining = Math.max(0, readyAt - now);
  const elapsed = Math.max(0, now - plantedAt);
  const nextReady = now + Math.max(0, Math.round(remaining * ratio));
  const nextPlanted = Math.min(nextReady - 1, now - Math.round(elapsed * ratio));
  return { plantedAt: nextPlanted, readyAt: nextReady };
}

/** 0…1 진행도 (심은 적이 없으면 −1). 미래 시각으로 심힌 저장(시계가 틀린 클라이언트)도 클램프된다. */
export function growProgress(now: number, plantedAt: number | undefined, readyAt: number | undefined): number {
  if (!plantedAt || !readyAt) return -1;
  const total = Math.max(1, readyAt - plantedAt);
  return Math.max(0, Math.min(1, (now - plantedAt) / total));
}

/** 남은 초 (여물었거나 비었으면 0). */
export function growRemainingS(now: number, readyAt: number | undefined): number {
  if (!readyAt) return 0;
  return Math.max(0, Math.ceil((readyAt - now) / 1000));
}

/* ── 연구실 분석기 (A-12, 2026-09-11) ────────────────────────────────────────
 * 온실과 같은 자리 · 같은 철학이다 — 걸리는 시간은 **넣는 순간** 확정되고, 그 뒤로 도감이 더 차도 돌아가던
 * 해석은 빨라지지 않는다. 진행도 · 남은 초는 `growProgress` / `growRemainingS` 를 그대로 쓴다 (순수한 시각
 * 계산이라 작물이냐 표본이냐를 모른다 — 같은 폴더 안이므로 한 번 더 베끼지 않는다).
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * 해석에 걸리는 시간(ms), **시작하는 순간** 확정된다:
 * `analyzeHours × (1 − ANALYZE_DEX_SPEEDUP × 도감진척) × (아는 표본이면 1 − ANALYZE_KNOWN_SPEEDUP)`.
 * 「도감을 채울수록 빨라진다」가 첫 항, 「아는 것을 다시 보는 건 빠르다」가 둘째 항이다. 1초 미만은 없다.
 */
/** @deprecated 2026-09-13 (요리 재료 티어) — 도감 진척 · 기지식 단축은 분석 레벨로 대체됐다. `analysisDurationMs` 를 쓴다. */
export function analyzeDurationMs(analyzeHours: number, dexRatio: number, known: boolean): number {
  const ratio = Math.max(0, Math.min(1, Number.isFinite(dexRatio) ? dexRatio : 0));
  const dex = 1 - ANALYZE_DEX_SPEEDUP * ratio;
  const repeat = known ? 1 - ANALYZE_KNOWN_SPEEDUP : 1;
  return Math.max(1000, Math.round(Math.max(0, analyzeHours) * 3600e3 * dex * repeat));
}

/* ── 온실 배양조 (A-14, 2026-09-11) ──────────────────────────────────────────
 * 분석기 · 재배 스테이션과 같은 자리 · 같은 철학이다 — 걸리는 시간은 **넣는 순간** 확정되고, 그 뒤로 배지를
 * 바꾸거나 원예 숙련이 올라도 돌아가던 배양은 빨라지지 않는다. 진행도 · 남은 초는 `growProgress` /
 * `growRemainingS` 를 그대로 쓴다 (작물이냐 표본이냐 세포주냐를 모르는 순수한 시각 계산이다).
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * 배양에 걸리는 시간(ms), **넣는 순간** 확정된다:
 * `cultureHours × 배지 등급(`MediumDef.speedMul`) × 원예 단축`.
 * 원예 항은 `growDurationMs` 가 쓰는 것과 **같은 항**이다 (온실 가구이므로 같은 숙련이 일한다 — 수치를 새로
 * 적지 않는다). 토양의 태그 매칭에 해당하는 축은 없다: 배지는 등급 하나다. 1초 미만은 없다.
 */
export function cultureDurationMs(cultureHours: number, mediumSpeedMul: number, gardening: number, bonusRatio = 1, socketSpeed = 0): number {
  const skill = Math.max(0, Math.min(SKILL_LEVEL_MAX, gardening));
  const speed = 1 - GROW_SKILL_SPEEDUP * (skill / SKILL_LEVEL_MAX);
  const m = Number.isFinite(mediumSpeedMul) && mediumSpeedMul > 0 ? mediumSpeedMul : 1;
  /* 2026-09-13 (요리 재료 티어): 배지 속도 보너스(`1 − speedMul`)를 배지 내구도 비율로 준다. 비율 1 이면 옛 식과 같은 값. */
  const ratio = clamp01(bonusRatio);
  const medium = ratio >= 1 ? m : 1 - (1 - m) * ratio;
  return Math.max(1000, Math.round(Math.max(0, cultureHours) * 3600e3 * medium * speed * socketTimeMul(socketSpeed, ratio)));
}

/* ── 요리 재료 티어 (2026-09-13, docs/plans/food-tiers.md §4.1) ─────────────────────────────────────────────
 * 흙 · 배지 내구도와 소켓, 분석기 결과표. 전부 순수 함수이고 수치는 계약(`@/shared` = `data/*.csv`)에서 온다.
 * 난수는 **주입한다**(`rng01`) — 부르는 쪽은 `Math.random` 을, 스모크는 고정 수열을 넘긴다.
 * ────────────────────────────────────────────────────────────────────────────────────────────────────────── */

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

/** 소켓 `speed` 합이 주는 시간 배수: `max(GROW_SOCKET_TIME_FLOOR, 1 − speed × 비율)`. 소켓이 없으면 정확히 1. */
function socketTimeMul(socketSpeed: number, ratio: number): number {
  const s = Number.isFinite(socketSpeed) ? Math.max(0, socketSpeed) : 0;
  if (s <= 0) return 1;
  return Math.max(GROW_SOCKET_TIME_FLOOR, 1 - s * ratio);
}

/** 흙 · 배지의 보너스 비율 = 내구도 / 최대 (0 … 1). 최대가 0 이하이면 0. */
export function durabilityRatio(cur: number, max: number): number {
  if (!(max > 0)) return 0;
  return clamp01(cur / max);
}

/**
 * 수확 한 번 뒤의 내구도: `max(0, cur − wear × max(GROW_WEAR_MUL_FLOOR, 1 − wearSum))`. `wearSum` = 끼운 `wear` 소켓 합
 * (내구도 비율을 타지 않는다 — 내구도 자체를 지키는 소켓이다). 부동소수 찌꺼기는 소수 둘째 자리에서 자른다.
 */
export function wearAfterHarvest(cur: number, wearPerHarvest: number, wearSum: number): number {
  const c = Number.isFinite(cur) ? Math.max(0, cur) : 0;
  return Math.max(0, Math.round((c - effectiveWear(wearPerHarvest, wearSum)) * 100) / 100);
}

/** 수확 한 번에 실제로 닳는 양 (`wearAfterHarvest` 와 같은 항). */
export function effectiveWear(wearPerHarvest: number, wearSum: number): number {
  const w = Number.isFinite(wearPerHarvest) ? Math.max(0, wearPerHarvest) : 0;
  const s = Number.isFinite(wearSum) ? Math.max(0, wearSum) : 0;
  return w * Math.max(GROW_WEAR_MUL_FLOOR, 1 - s);
}

/**
 * 내구도가 0 이 될 때까지 남은 수확 횟수 `ceil(cur / 실제 마모)` — 옛 `soilUsesLeft` · `mediumUsesLeft` 칸이 이제 이 뜻이다
 * (칸은 0 이 돼도 비지 않는다). 마모가 0 이면 내구도가 남아 있는 한 1 로 본다(무한을 적지 않는다).
 */
export function harvestsUntilWorn(cur: number, wearPerHarvest: number, wearSum: number): number {
  const c = Number.isFinite(cur) ? Math.max(0, cur) : 0;
  if (c <= 0) return 0;
  const w = effectiveWear(wearPerHarvest, wearSum);
  return w > 0 ? Math.ceil(c / w - 1e-9) : 1;
}

/**
 * 옛 세이브의 「남은 수확 횟수」를 내구도로 옮긴다: `round(최대 × clamp(usesLeft / uses))`. `uses` 가 없으면 최대 그대로.
 */
export function durabilityFromUses(max: number, usesLeft: number, uses: number): number {
  const m = Number.isFinite(max) ? Math.max(0, max) : 0;
  if (!(uses > 0)) return m;
  return Math.round(m * clamp01(usesLeft / uses));
}

/** 결과표에서 `family` · `minLevel ≤ level` · `weight > 0` · `defOk(defId)` 인 줄 (추첨 대상). */
function analysisPool(family: SampleFamily, level: number, defOk: (defId: string) => boolean): AnalysisResultDef[] {
  const lv = Math.floor(Number.isFinite(level) ? level : 1);
  return ANALYSIS_RESULTS.filter((r) => r.family === family && r.minLevel <= lv && r.weight > 0 && defOk(r.defId));
}

/**
 * 분석 결과 한 번 굴리기 — 해금된 줄끼리 가중 추첨하고 개수는 `qtyMin … qtyMax` 정수 균등. `rng01` 은 **두 번** 부른다
 * (줄 · 개수). 추첨할 줄이 없으면 null (부르는 쪽이 표본의 대체 산출물 `rewardDefId` 로 떨어진다).
 */
export function rollAnalysisResult(
  family: SampleFamily, level: number, rng01: () => number, defOk: (defId: string) => boolean,
): { defId: string; qty: number } | null {
  const pool = analysisPool(family, level, defOk);
  if (!pool.length) return null;
  const total = pool.reduce((a, r) => a + r.weight, 0);
  let pick = clamp01(rng01()) * total;
  let row = pool[pool.length - 1];
  for (const r of pool) {
    if (pick < r.weight) { row = r; break; }
    pick -= r.weight;
  }
  const span = Math.max(0, row.qtyMax - row.qtyMin);
  const qty = row.qtyMin + Math.min(span, Math.floor(clamp01(rng01()) * (span + 1)));
  return { defId: row.defId, qty: Math.max(1, qty) };
}

/** 지금 레벨에서 해석 한 번이 각 산출물을 낼 확률 (`rollAnalysisResult` 와 같은 식 — 같은 defId 의 줄은 합친다). */
export function analysisChances(family: SampleFamily, level: number, defOk: (defId: string) => boolean): Record<string, number> {
  const pool = analysisPool(family, level, defOk);
  const total = pool.reduce((a, r) => a + r.weight, 0);
  const out: Record<string, number> = {};
  if (total <= 0) return out;
  for (const r of pool) out[r.defId] = (out[r.defId] ?? 0) + r.weight / total;
  return out;
}

/** 해석에 걸리는 시간(ms), 넣는 순간 확정: `analyzeHours × 3600e3 × analysisTimeMul(분석 레벨)`, 최소 1000 ms. */
export function analysisDurationMs(analyzeHours: number, level: number): number {
  const h = Number.isFinite(analyzeHours) ? Math.max(0, analyzeHours) : 0;
  return Math.max(1000, Math.round(h * 3600e3 * analysisTimeMul(level)));
}

/* ── 은퇴 가구 환불 (온실 개편, 2026-09-11) ───────────────────────────────── */

/**
 * 은퇴한(`FurnitureDef.retired`) 가구 한 점이 돌려주는 재료 — 제작비 + 그 레벨까지의 강화비 전부, 재료별로 합산.
 * 시설 환불(`facilityRefundCost`)과 같은 철학이다: **지금의 표**를 그대로 되돌려 준다.
 */
export function furnitureRefundCost(def: FurnitureDef, level: number): CraftIngredient[] {
  const total = new Map<string, number>();
  for (const c of def.craft ?? []) total.set(c.defId, (total.get(c.defId) ?? 0) + c.qty);
  for (let k = 1; k < Math.max(1, Math.floor(level)); k++) {
    for (const c of nextFurnitureCost(def, k) ?? []) total.set(c.defId, (total.get(c.defId) ?? 0) + c.qty);
  }
  return [...total].map(([defId, qty]) => ({ defId, qty }));
}

/** 재료 목록 두 개를 재료별로 합친다 (은퇴 가구 여러 점의 환불을 모을 때). */
export function mergeCost(into: CraftIngredient[], add: readonly CraftIngredient[], times = 1): CraftIngredient[] {
  for (const c of add) {
    const hit = into.find((e) => e.defId === c.defId);
    if (hit) hit.qty += c.qty * times; else into.push({ defId: c.defId, qty: c.qty * times });
  }
  return into;
}

/* ── rooms ────────────────────────────────────────────────────────────────── */

export function isRoomIndex(state: ShipState, index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < state.rooms.length;
}

/**
 * 2026-09-12 (사용자 결정 — 조종석): 가구를 **놓을 수 있는** 자리 = 방(`isRoomIndex`) 또는 조종석(`COCKPIT_ROOM_INDEX`).
 * 용도 · 시설 규칙(`setRoomPurpose` · `removeRoomFacility` · 시설 증축)은 여전히 `isRoomIndex` 만 본다 — 조종석에는 용도가 없다.
 */
export function isPlaceRoom(state: ShipState, room: number): boolean {
  return room === COCKPIT_ROOM_INDEX || isRoomIndex(state, room);
}

/** 가구 규칙이 보는 그 자리의 용도 — 조종석은 `'cockpit'`(= `'any'` 가구만 받는다), 없는 방은 null. */
export function placeRoomPurpose(state: ShipState, room: number): RoomPurpose | null {
  if (room === COCKPIT_ROOM_INDEX) return 'cockpit';
  return isRoomIndex(state, room) ? state.rooms[room].purpose : null;
}

/** 빈 방이 될 수 있는 용도인가 (`ROOM_PURPOSES_ASSIGNABLE` — 2026-09-12 부터 시뮬레이션실 · 휴식 공간 · 조종석은 아니다). */
export function isAssignablePurpose(purpose: RoomPurpose): boolean {
  return ROOM_PURPOSES_ASSIGNABLE.includes(purpose);
}

export function isRoomPurpose(p: unknown): p is RoomPurpose {
  return typeof p === 'string' && (ROOM_PURPOSES as readonly string[]).includes(p);
}

/** Furniture allowed in a room of `purpose`: its own purpose or 'any'. */
export function furnitureAllowedIn(def: FurnitureDef, purpose: RoomPurpose): boolean {
  return def.room === 'any' || def.room === purpose;
}

/**
 * 온실이 먼저 있어야 지을 수 있는 용도. 한 줄이 세 곳의 원본이다: `purposeChangeReason` ·
 * `ShipState.sanitize` 의 낙오 처리 · `Rooms.setRoomPurpose` 의 「마지막 온실이 사라지면 딸린 방도 비운다」.
 *
 * **2026-09-14 (사용자 결정) — 선행 시설 조건은 없다.** 옛 값은 `['lab', 'kitchen']`(연구실은 표본 · 배지가
 * 온실에서 오고, 주방은 A-3c 당시 작물이 유일한 요리 재료였다)였다. 증축의 게이트는 이제 **발전기 레벨
 * 하나**뿐이고(`purposeGeneratorLevel` · `generatorGateReason` — 그것은 그대로다), 방 용도끼리의 선후 관계는
 * 없앴다. 계약 이름은 **추가만 하고 지우지 않는다**는 규약 그대로 남기고 값만 비웠다 — 빈 배열이면 세 소비처가
 * 전부 저절로 no-op 이 되므로 그 자리들은 한 줄도 고치지 않았다 (`includes` 가 늘 false).
 */
export const NEEDS_GREENHOUSE: readonly RoomPurpose[] = [];

/**
 * Why room `index` cannot take `purpose`; null = allowed. 2026-09-07: the 작업실 is an ordinary purpose — any room
 * may take it and a ship may have none (it was locked to room 1 from the Phase 8 UI pass until then).
 * `empty` is always allowed (it recovers every piece);
 * any other purpose is refused while purpose-bound furniture of a different purpose is still placed, and `lab`
 * needs a greenhouse somewhere on the ship.
 */
export function purposeChangeReason(state: ShipState, index: number, purpose: RoomPurpose): string | null {
  if (index === COCKPIT_ROOM_INDEX) return '조종석은 용도를 바꾸거나 제거할 수 없습니다';
  if (!isRoomIndex(state, index)) return '없는 방입니다';
  if (purpose === 'empty') return null;
  // 2026-09-12 (사용자 결정): 시뮬레이션실 · 휴식 공간(서재에 합쳐졌다) · 조종석은 빈 방이 될 수 없다
  if (!isAssignablePurpose(purpose)) return `${ROOM_PURPOSE_LABEL_KO[purpose]}은(는) 더 이상 지을 수 없습니다`;
  // 온실 선행 — **2026-09-14 사용자 결정으로 `NEEDS_GREENHOUSE` 가 비었다**: 이 가지는 더 이상 서지 않는다.
  // 규칙을 되살리려면 그 배열에 용도를 넣으면 되므로 갈래는 그대로 둔다 (계약은 추가만, 삭제 금지와 같은 결).
  if (NEEDS_GREENHOUSE.includes(purpose) && !state.rooms.some((r, i) => i !== index && r.purpose === 'greenhouse')) {
    return `${ROOM_PURPOSE_LABEL_KO[purpose]}은(는) 온실이 먼저 필요합니다`;
  }
  // 2026-09-12 (사용자 결정): **모든 용도가 함선당 하나다** — 시설 관리의 용도 목록은 이미 지은 용도를 아예
  // 보여 주지 않는다. 예전(작업실 · 사격장만 하나)에 두 개를 지어 둔 세이브는 그대로 둔다 (`sanitize` 는 건드리지 않는다).
  {
    const other = state.rooms.findIndex((r, i) => i !== index && r.purpose === purpose);
    if (other >= 0) return `${ROOM_PURPOSE_LABEL_KO[purpose]}은(는) 함선에 하나만 둘 수 있습니다 (방 ${other + 1})`;
  }
  const blocking = state.furniture.filter((f) => {
    if (f.room !== index) return false;
    const def = FURNITURE_DEF_MAP.get(f.defId);
    return !!def && !furnitureAllowedIn(def, purpose);
  });
  if (blocking.length) {
    const names = [...new Set(blocking.map((f) => FURNITURE_DEF_MAP.get(f.defId)!.name))].join(', ');
    return `${names} 을(를) 먼저 회수하세요`;
  }
  return null;
}

/* ── placement ────────────────────────────────────────────────────────────── */

function overlaps(ax: number, ay: number, aw: number, ah: number, bx: number, by: number, bw: number, bh: number): boolean {
  return ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;
}

/**
 * Inside the grid of `room` after rotation? 2026-09-12: the grid size is per room (`roomGridSize` — 조종석
 * `COCKPIT_GRID_*`, 방 `ROOM_GRID_*`); `room` defaults to an ordinary room.
 */
export function insideGrid(def: FurnitureDef, x: number, y: number, yaw: 0 | 1 | 2 | 3, room = 0): boolean {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) return false;
  const fp = furnitureFootprint(def, yaw);
  const grid = roomGridSize(room);
  return x + fp.cols <= grid.cols && y + fp.rows <= grid.rows;
}

/** Placed piece under cell (x, y) of `room`, or null. In a stack the **top** layer wins (that is what E / X reach). */
export function furnitureAtCell(furniture: readonly PlacedFurniture[], room: number, x: number, y: number): PlacedFurniture | null {
  let best: PlacedFurniture | null = null;
  for (const f of furniture) {
    if (f.room !== room) continue;
    const def = FURNITURE_DEF_MAP.get(f.defId);
    if (!def) continue;
    const fp = furnitureFootprint(def, f.yaw);
    if (x < f.x || x >= f.x + fp.cols || y < f.y || y >= f.y + fp.rows) continue;
    if (!best || layerOf(f) > layerOf(best)) best = f;
  }
  return best;
}

/* ── stacking (Phase 8: 재배층) ─────────────────────────────────────────────
 * `FurnitureDef.stackLimit > 1` lets several copies of the **same** def share one footprint, each on its own
 * `PlacedFurniture.layer` (0 = deck). Everything else keeps the strict "nothing may overlap" rule, and a stack is
 * homogeneous: same defId, same `x`/`y`, same `yaw`. hub/ lifts layer n by `n × GROW_RACK_LAYER_HEIGHT`.
 * ────────────────────────────────────────────────────────────────────────── */

/** How many copies may share one footprint (1 = no stacking). */
export function stackLimitOf(def: FurnitureDef): number {
  const n = Math.floor(Number(def.stackLimit ?? 1));
  return Number.isFinite(n) && n > 1 ? n : 1;
}

export function layerOf(item: PlacedFurniture): number {
  const n = Math.floor(Number(item.layer ?? 0));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Pieces already sitting in the same stack slot (same def / cell / yaw) of `room`, `ignoreUid` excluded. */
export function stackMembers(
  state: ShipState, room: number, def: FurnitureDef, x: number, y: number, yaw: 0 | 1 | 2 | 3, ignoreUid?: string,
): PlacedFurniture[] {
  return state.furniture.filter((f) => f.room === room && f.uid !== ignoreUid && f.defId === def.id && f.x === x && f.y === y && f.yaw === yaw);
}

/** Lowest unused layer of a stack, or −1 when it is full. */
export function nextFreeLayer(members: readonly PlacedFurniture[], limit: number): number {
  const used = new Set(members.map(layerOf));
  for (let i = 0; i < limit; i++) if (!used.has(i)) return i;
  return -1;
}

/** Highest occupied layer of a stack (−1 when empty). */
export function topLayer(members: readonly PlacedFurniture[]): number {
  let top = -1;
  for (const m of members) top = Math.max(top, layerOf(m));
  return top;
}

/* ── 배치 규칙: 접근 면 (2026-09-13, 사용자 결정 — docs/plans/power-crypto.md · 계약 `shared/housing.ts` 끝 절) ──────────
 * 가구의 앞은 로컬 −Z 다. `front` 가구는 앞 한 줄(몸체 폭 × 깊이 1칸)에 다른 가구 몸체가 없어야 하고 그 줄이 격자 밖(벽)이어도 안 된다.
 * `sides` 는 넓은 두 면(로컬 ±Z), `all` 은 네 면의 한 줄씩에 몸체가 없어야 하되 벽은 된다. 모서리 칸은 비울 필요가 없다.
 * 규칙은 **양방향**이다 — 새 몸체가 이미 놓인 가구의 비워야 하는 칸에 들어가도 안 된다. 비워야 하는 칸끼리는 겹쳐도 된다
 * (마주보는 작업대 둘이 1칸 통로를 나눠 쓴다). 조종석 고정 소품 자리(`roomCellBlocked`)는 몸체로 센다.
 * 칸 계산의 원본은 계약의 `furnitureFaceDir` · `furnitureClearanceCells` 이고, 여기서는 면마다 한 줄짜리 **사각형**으로 본다
 * (칸 목록을 만들지 않으려고 — 하우징 모드가 매 프레임 묻는다). 방향표는 모듈 로드 때 계약 함수로 한 번 채운다.
 * ────────────────────────────────────────────────────────────────────────── */
import type { FurnitureAccess, FurnitureFace } from '@/shared';
import { accessAllowsWall, furnitureAccessFaces, furnitureAccessOf, furnitureFaceDir, isCockpitOnlyFurniture } from '@/shared';

/** 배치를 막는 규칙의 종류. `access` = 접근 면 규칙(2026-09-13) — `ShipState.sanitize` 는 이것만 가구 창고로 옮기고 나머지는 예전처럼 버린다. */
export type PlacementBlockKind = 'place' | 'purpose' | 'grid' | 'fixture' | 'stack' | 'overlap' | 'access';
export interface PlacementBlock { kind: PlacementBlockKind; reason: string }

/** 배치 거절 문장 (시설 관리 토스트 · 스모크가 같은 글을 본다). */
export const PLACEMENT_REASON_KO = {
  place: '가구를 놓을 수 없는 곳입니다',
  grid: '방 격자 밖으로 나갑니다',
  fixture: '고정 설비와 겹칩니다',
  stack: '더 쌓을 수 없습니다',
  overlap: '다른 가구와 겹칩니다',
  frontWall: '앞쪽이 벽에 막힙니다',
  front: '앞쪽 1칸을 비워야 합니다',
  sides: '넓은 면 1칸을 비워야 합니다',
  all: '사방 1칸을 비워야 합니다',
  blocksOther: '다른 가구의 접근 공간을 막습니다',
} as const;

const ACCESS_FACES: readonly FurnitureFace[] = ['front', 'back', 'right', 'left'];
/** `FACE_DIR[yaw][face]` = 계약의 `furnitureFaceDir(yaw, face)` (모듈 로드 때 한 번). */
const FACE_DIR: ReadonlyArray<Readonly<Record<FurnitureFace, { dx: number; dy: number }>>> = ([0, 1, 2, 3] as const).map(
  (yaw) => Object.fromEntries(ACCESS_FACES.map((f) => [f, furnitureFaceDir(yaw, f)])) as Record<FurnitureFace, { dx: number; dy: number }>,
);
/** 면 한 줄의 사각형 (재사용 스크래치 — 받은 자리에서 바로 읽는다). */
const _face = { x: 0, y: 0, cols: 0, rows: 0 };
function faceRect(x: number, y: number, cols: number, rows: number, yaw: 0 | 1 | 2 | 3, face: FurnitureFace): typeof _face {
  const { dx, dy } = FACE_DIR[yaw][face];
  if (dy !== 0) { _face.x = x; _face.cols = cols; _face.rows = 1; _face.y = dy < 0 ? y - 1 : y + rows; }
  else { _face.y = y; _face.rows = rows; _face.cols = 1; _face.x = dx < 0 ? x - 1 : x + cols; }
  return _face;
}

function accessReason(access: FurnitureAccess): string {
  return access === 'front' ? PLACEMENT_REASON_KO.front : access === 'sides' ? PLACEMENT_REASON_KO.sides : PLACEMENT_REASON_KO.all;
}

/**
 * `def` 를 `room` 의 (x, y, yaw) 에 놓을 수 없는 이유 — null 이면 놓을 수 있다. 순서: 자리 → 용도 → 격자 → 고정 소품 → 쌓기 한도 →
 * 몸체 겹침 → 내 접근 면(벽 · 몸체) → 남의 접근 면. `ignoreUid` = 옮기는 중인 조각 (자기 자신과는 비교하지 않는다).
 */
export function placementBlockOf(
  state: ShipState, room: number, def: FurnitureDef, x: number, y: number, yaw: 0 | 1 | 2 | 3, ignoreUid?: string,
): PlacementBlock | null {
  // 2026-09-12: 조종석도 놓을 자리다 (용도 'cockpit' = 'any' 가구 + 조종석 전용 시설) — 격자 크기와 고정 소품 자리는 계약의 표가 답한다
  const purpose = placeRoomPurpose(state, room);
  if (purpose === null) return { kind: 'place', reason: PLACEMENT_REASON_KO.place };
  if (!furnitureAllowedIn(def, purpose)) {
    const reason = isCockpitOnlyFurniture(def) ? '조종석 전용 시설입니다'
      : def.room !== 'any' ? `${ROOM_PURPOSE_LABEL_KO[def.room as RoomPurpose] ?? def.room} 전용 가구입니다` : PLACEMENT_REASON_KO.place;
    return { kind: 'purpose', reason };
  }
  if (!insideGrid(def, x, y, yaw, room)) return { kind: 'grid', reason: PLACEMENT_REASON_KO.grid };
  const fp = furnitureFootprint(def, yaw);
  if (roomRectBlocked(room, x, y, fp.cols, fp.rows)) return { kind: 'fixture', reason: PLACEMENT_REASON_KO.fixture };
  const limit = stackLimitOf(def);
  if (limit > 1 && nextFreeLayer(stackMembers(state, room, def, x, y, yaw, ignoreUid), limit) < 0) return { kind: 'stack', reason: PLACEMENT_REASON_KO.stack };
  for (const other of state.furniture) {
    if (other.room !== room || other.uid === ignoreUid) continue;
    const odef = FURNITURE_DEF_MAP.get(other.defId);
    if (!odef) continue;
    const ofp = furnitureFootprint(odef, other.yaw);
    if (!overlaps(x, y, fp.cols, fp.rows, other.x, other.y, ofp.cols, ofp.rows)) continue;
    // a stack may only be shared by the identical def in the identical spot
    if (limit > 1 && other.defId === def.id && other.x === x && other.y === y && other.yaw === yaw) continue;
    return { kind: 'overlap', reason: PLACEMENT_REASON_KO.overlap };
  }
  // 2026-09-13: 내 접근 면 — 앞(front)은 벽이 안 되고, 어느 면이든 그 줄에 고정 소품 · 다른 가구 몸체가 없어야 한다
  const access = furnitureAccessOf(def);
  if (access !== 'none') {
    const grid = roomGridSize(room);
    for (const face of furnitureAccessFaces(access)) {
      const r = faceRect(x, y, fp.cols, fp.rows, yaw, face);
      const inside = r.x >= 0 && r.y >= 0 && r.x + r.cols <= grid.cols && r.y + r.rows <= grid.rows;
      if (!inside) {
        if (!accessAllowsWall(access)) return { kind: 'access', reason: PLACEMENT_REASON_KO.frontWall };
        continue;                                   // 한 줄짜리라 격자 밖이면 줄 전체가 벽이다 (몸체는 이미 격자 안)
      }
      const rx = r.x, ry = r.y, rc = r.cols, rr = r.rows;
      if (roomRectBlocked(room, rx, ry, rc, rr)) return { kind: 'access', reason: accessReason(access) };
      for (const other of state.furniture) {
        if (other.room !== room || other.uid === ignoreUid) continue;
        const odef = FURNITURE_DEF_MAP.get(other.defId);
        if (!odef) continue;
        const ofp = furnitureFootprint(odef, other.yaw);
        if (overlaps(rx, ry, rc, rr, other.x, other.y, ofp.cols, ofp.rows)) return { kind: 'access', reason: accessReason(access) };
      }
    }
  }
  // 2026-09-13: 남의 접근 면 — 내 몸체가 이미 놓인 가구의 비워야 하는 줄에 들어가면 안 된다 (줄끼리는 겹쳐도 된다)
  for (const other of state.furniture) {
    if (other.room !== room || other.uid === ignoreUid) continue;
    const odef = FURNITURE_DEF_MAP.get(other.defId);
    if (!odef) continue;
    const oaccess = furnitureAccessOf(odef);
    if (oaccess === 'none') continue;
    const ofp = furnitureFootprint(odef, other.yaw);
    for (const face of furnitureAccessFaces(oaccess)) {
      const r = faceRect(other.x, other.y, ofp.cols, ofp.rows, other.yaw, face);
      if (overlaps(x, y, fp.cols, fp.rows, r.x, r.y, r.cols, r.rows)) return { kind: 'access', reason: PLACEMENT_REASON_KO.blocksOther };
    }
  }
  return null;
}

/** `placementBlockOf` 의 문장만 — `HousingRef.placementBlock` 이 이것을 돌려준다. null = 놓을 수 있다. */
export function placementBlockReason(
  state: ShipState, room: number, def: FurnitureDef, x: number, y: number, yaw: 0 | 1 | 2 | 3, ignoreUid?: string,
): string | null {
  return placementBlockOf(state, room, def, x, y, yaw, ignoreUid)?.reason ?? null;
}

/**
 * Purpose match (or 'any') + inside the grid + no overlap with other pieces in the room (`ignoreUid` = the piece being
 * moved). Stackable defs (`stackLimit > 1`) may share their footprint with the same def at the same cell / yaw while
 * the stack is below its limit. **2026-09-13**: + the access-face rules (`placementBlockOf`) — this is exactly
 * `placementBlockOf(...) === null`, so every caller (hand placement · `move` · 자동 배치 · `sanitize`) sees one rule.
 */
export function canPlaceAt(state: ShipState, room: number, def: FurnitureDef, x: number, y: number, yaw: 0 | 1 | 2 | 3, ignoreUid?: string): boolean {
  return placementBlockOf(state, room, def, x, y, yaw, ignoreUid) === null;
}

/* ── 자동 배치 (2026-09-10) ────────────────────────────────────────────────
 * 「좌측 상단부터 가로줄을 먼저 채우고, 가구는 아래를 가리킨다」 — 시설 관리 화면(가구 창고의 `배치` 버튼)이
 * 손으로 고르지 않은 자리를 정할 때의 **유일한** 규칙이다. 사용자가 하우징 모드에서 직접 돌려 놓은 회전은
 * 이 함수를 지나지 않으므로 그대로다.
 *
 * 화면 ↔ 격자 대응의 근거는 두 곳이다 (여기서 다시 재지 않고 그대로 옮겨 적는다):
 *   · `hub/interiors/RoomLayout` — 격자 `x` 는 월드 +X, `y` 는 월드 +Z (셀 (0,0) = 방의 min-x / min-z 모서리).
 *     가구의 월드 회전은 `rotation.y = −yaw·π/2` 이고 절차 모델의 **정면은 로컬 −Z** 다.
 *   · `hub/HousingMode` — 시설 관리 카메라는 Phase 10 부터 **모든 방**에서 방 중심의 +X 쪽(`CAM_TOWARD_DOOR`)
 *     에서 −X 를 내려다본다. 그래서 **화면 오른쪽 = 월드 −Z, 화면 아래 = 월드 +X** 다 (그 파일의 커서
 *     이동 주석과 같은 문장이다: "screen right = world −Z and screen down = world +X for every room").
 *
 * 두 줄을 합치면 이 폴더가 쓸 좌표가 나온다:
 *   화면 아래   = 격자 `x` 증가          화면 오른쪽 = 격자 `y` 감소
 *   화면 좌측 상단 = (x 0, y 최대)        화면의 가로줄 = `x` 를 고정한 채 `y` 를 줄여 가는 줄
 * 그래서 훑는 순서는 **x 오름차순(바깥) × y 내림차순(안쪽)** — 화면으로 보면 왼쪽 위에서 오른쪽으로 한 줄을
 * 채우고 다음 줄로 내려간다. 앵커(`x`,`y`)는 격자 최소 모서리라, 화면 좌측 상단에 딱 붙이려면 `y` 를
 * `ROOM_GRID_ROWS − fp.rows` 에서 시작해 0 까지 내린다.
 *
 * 방향은 정면 벡터로 정한다: `R_y(−yaw·π/2)·(0,0,−1) = (−sin θ, −cos θ)` 이므로
 *   yaw 0 → −Z (화면 오른쪽) · **yaw 1 → +X (화면 아래)** · yaw 2 → +Z (화면 왼쪽) · yaw 3 → −X (화면 위).
 * 예전에는 `[0, 1]` 순서라 작업대가 언제나 yaw 0 = **화면 오른쪽 벽**을 보고 서서, 쓰려면 벽과 작업대 사이로
 * 끼어 들어가야 했다. 이제 yaw 1 이 먼저다. 대체 회전이 `0` 인 이유는 yaw 1/3 과 0/2 의 발자국이 서로 전치라
 * "yaw 1 로 안 들어가는 가구"는 yaw 3 으로도 안 들어가기 때문이다 — 눕혀 봐야 의미가 있다.
 */
export const AUTO_PLACE_YAWS: readonly (0 | 1 | 2 | 3)[] = [1, 0];
/**
 * 2026-09-13 (배치 규칙): 선호 회전(`AUTO_PLACE_YAWS`)으로 자리가 없을 때 이어서 보는 회전. 접근 면 규칙이 생기면서 yaw 3 은 더 이상
 * yaw 1 의 사본이 아니다 — 발자국은 같아도 **앞이 반대**라, 앞이 벽에 막히는 `front` 가구(격자 끝 줄)가 돌아서면 선다.
 * 순서 · 선호 회전은 그대로이고, 접근 면이 없는 가구에게는 새 자리가 생기지 않는다(발자국이 같다).
 */
export const AUTO_PLACE_FALLBACK_YAWS: readonly (0 | 1 | 2 | 3)[] = [3, 2];
const AUTO_PLACE_YAW_ORDER: readonly (0 | 1 | 2 | 3)[] = [...AUTO_PLACE_YAWS, ...AUTO_PLACE_FALLBACK_YAWS];

/* ── 출입구 앞 여유 (자동 배치에만 적용) ───────────────────────────────────
 * 순서만 바꾸면 **문이 막힌다.** 방문은 방의 ±X 벽 한가운데(`hub/interiors/RoomLayout`: `doorZ` = 방의 z 중앙,
 * `DOOR_WIDTH` 1.6 m)에 있고, 어느 벽인지는 방 번호가 정한다 — 앞쪽 절반(0…4)은 좌현이라 문이 **+X** 벽에,
 * 뒤쪽 절반(5…9)은 우현이라 문이 **−X** 벽에 붙는다. 새 규칙의 첫 자리(격자 x 0, 화면 좌측 상단)는 우현 방에서
 * 바로 그 문 앞이고, 4×2 작업대를 yaw 1 로 놓으면 1.6 m 문틈의 절반(0.8 m)을 막아 `PLAYER_RADIUS` 0.45 ×2 =
 * 0.9 m 인 플레이어가 **드나들지 못한다**(가구는 `hub/interiors/Furniture` 가 실제 콜라이더를 세운다).
 *
 * 그래서 자동 배치만 문 앞 상자를 비켜 간다 — 문 쪽 벽에서 `DOOR_CLEAR_DEPTH` 칸 깊이 ×
 * 벽 한가운데 `DOOR_CLEAR_SPAN` 칸. 손으로 놓는 경로(하우징 모드 고스트 · `move`)와 `canPlaceAt` 자체는
 * **건드리지 않는다**: `ShipState.sanitize` 가 저장된 배치를 `canPlaceAt` 으로 다시 검사하므로, 이 여유를
 * 배치 규칙에 넣었다면 이미 문 앞에 가구를 둔 함선의 가구가 로드할 때 가구 창고로 쫓겨났을 것이다
 * (= 세이브 소급 변경). 좌현 방에서는 예약 칸이 화면 아래쪽 끝이라 「좌측 상단부터」가 그대로 성립한다.
 *
 * 두 수치는 밸런스가 아니라 **치수**라 csv 가 아니라 여기 있다 (`data/README.md` 의 "csv 로 옮기지 않은 것" —
 * `world/structures/model.ts` 가 벽 두께 · 문 폭을 TS 에 두는 것과 같은 이유).
 */
/*
 * 2026-09-12 (`ROOM_GRID_COLS/ROWS` 8 → 16, 방 4 × 4 → 8 × 8 m): **두 수치는 그대로다.** 둘 다 격자 칸수의
 * 비율이 아니라 **문의 치수**에서 나오고, 문은 여전히 1.6 m 폭 · 플레이어는 여전히 지름 0.9 m 이기 때문이다 —
 * 방이 커졌다고 문 앞 여유를 같이 키우면 새로 생긴 공간을 그만큼 도로 뺏는다.
 *
 * 구역이 여전히 문 앞에 오는지만 다시 쟀다. 문은 방의 z 중앙(`doorZ`)에 있고 격자 `y` 는 월드 +Z 이므로
 * 구역의 중앙 정렬은 `doorClearanceCell` 의 `(ROWS − SPAN)/2` 한 줄이 정한다:
 *   · 8 칸일 때  y 2…5 → 방 앞쪽 모서리에서 1.0 … 3.0 m, 문은 2.0 ± 0.8 = 1.2 … 2.8 m  ✔
 *   · 16 칸일 때 y 6…9 → 3.0 … 5.0 m,                     문은 4.0 ± 0.8 = 3.2 … 4.8 m  ✔
 * `ROWS` 가 짝수이고 `SPAN` 이 짝수인 한 구역은 정확히 방 중앙에 물리고, 문(3.2 칸)보다 넓다.
 */
/** 문 쪽 벽에서 비워 두는 깊이(칸). 2 칸 = 1.0 m ≥ 플레이어 지름 0.9 m. */
export const DOOR_CLEAR_DEPTH = 2;
/** 벽 한가운데에서 비워 두는 폭(칸). 4 칸 = 2.0 m ≥ 문 폭 1.6 m. */
export const DOOR_CLEAR_SPAN = 4;

/** Min corner of the `DOOR_CLEAR_DEPTH × DOOR_CLEAR_SPAN` block auto-placement keeps free in front of `room`'s door. */
export function doorClearanceCell(room: number): { x: number; y: number } {
  // 좌현(앞 절반)은 문이 +X 벽 = 격자 x 최대 쪽, 우현(뒤 절반)은 −X 벽 = 격자 x 0 쪽.
  const port = room < Math.floor(SHIP_ROOM_COUNT / 2);
  return {
    x: port ? ROOM_GRID_COLS - DOOR_CLEAR_DEPTH : 0,
    y: Math.floor((ROOM_GRID_ROWS - DOOR_CLEAR_SPAN) / 2),
  };
}

/**
 * 2026-09-11 (C-27) — 문 앞 여유 구역 안에 **나란히 비어 있는 두 줄**이 남는가. 문 폭 방향(`DOOR_CLEAR_SPAN` 칸)
 * 중 인접한 2칸이 문 쪽 벽에서 `DOOR_CLEAR_DEPTH` 칸 깊이까지 전부 비어 있으면 통로가 열려 있다 — 2칸 = 1.0 m ≥
 * 플레이어 지름 0.9 m (`PLAYER_RADIUS` × 2). `extra` = 이제 놓으려는 가구의 발자국 (그것까지 포함해서 본다).
 */
export function doorPassageOpen(
  state: ShipState, room: number, extra?: { x: number; y: number; cols: number; rows: number } | null,
): boolean {
  const door = doorClearanceCell(room);
  const rects: Array<{ x: number; y: number; cols: number; rows: number }> = [];
  for (const f of state.furniture) {
    if (f.room !== room) continue;
    const d = FURNITURE_DEF_MAP.get(f.defId);
    if (!d) continue;
    const fp = furnitureFootprint(d, f.yaw);
    rects.push({ x: f.x, y: f.y, cols: fp.cols, rows: fp.rows });
  }
  if (extra) rects.push(extra);
  /** 문 폭 방향 k 번째 줄(격자 y = door.y + k)이 깊이 전부 비었는가. */
  const laneFree = (k: number): boolean =>
    !rects.some((r) => overlaps(door.x, door.y + k, DOOR_CLEAR_DEPTH, 1, r.x, r.y, r.cols, r.rows));
  for (let k = 0; k + 1 < DOOR_CLEAR_SPAN; k++) if (laneFree(k) && laneFree(k + 1)) return true;
  return false;
}

/** A free cell + yaw the 배치 버튼 drops a stored piece on. */
export interface FurniturePlacement { x: number; y: number; yaw: 0 | 1 | 2 | 3 }

/**
 * First spot `def` fits in `room` under the rule above — 화면 좌측 상단부터 가로줄 먼저, 아래를 향한 채,
 * 출입구 앞은 비워 두고. `null` when nothing fits (the caller keeps its existing 자리 없음 handling); every
 * candidate still goes through `canPlaceAt`, so 용도 · 격자 경계 · 겹침 · 쌓기 한도 규칙은 하나도 우회하지 않는다.
 *
 * 2026-09-11 (C-27) **2차 패스**: 여유 구역을 통째로 피해서는 자리가 없으면(방이 거의 찼다) 같은 순서로 다시 훑되
 * 여유 구역에 걸치는 자리도 받는다 — 단 놓은 뒤에도 `doorPassageOpen` (문 폭 4칸 중 인접 2칸이 깊이 전부 비었다)
 * 이어야 한다. 1차에서 이미 본 자리(구역 밖)는 2차에서 다시 볼 필요가 없다. `canPlaceAt` 은 그대로다.
 */
export function autoPlaceSpot(state: ShipState, room: number, def: FurnitureDef): FurniturePlacement | null {
  /* 2026-09-12 (조종석): 격자 크기는 `roomGridSize` 가, 막힌 칸은 `canPlaceAt` 안의 `roomRectBlocked` 가 답한다. 조종석에는
     문 앞 여유 구역이 없다 — 고정 소품 표(`COCKPIT_BLOCKED_RECTS`)가 이미 복도 아치 · 포드 동선을 비워 두므로 한 패스뿐이다. */
  const grid = roomGridSize(room);
  const door = room === COCKPIT_ROOM_INDEX ? null : doorClearanceCell(room);
  for (const pass of door ? [1, 2] : [1]) {
    for (const yaw of AUTO_PLACE_YAW_ORDER) {        // 2026-09-13: 선호 회전 다음에 뒤집은 회전 (접근 면 규칙)
      const fp = furnitureFootprint(def, yaw);
      for (let x = 0; x + fp.cols <= grid.cols; x++) {               // 화면 세로: 위 → 아래
        for (let y = grid.rows - fp.rows; y >= 0; y--) {             // 화면 가로: 왼쪽 → 오른쪽
          const inDoorZone = !!door && overlaps(x, y, fp.cols, fp.rows, door.x, door.y, DOOR_CLEAR_DEPTH, DOOR_CLEAR_SPAN);
          if (inDoorZone !== (pass === 2)) continue;
          if (!canPlaceAt(state, room, def, x, y, yaw)) continue;
          if (pass === 2 && !doorPassageOpen(state, room, { x, y, cols: fp.cols, rows: fp.rows })) continue;
          return { x, y, yaw };
        }
      }
    }
  }
  return null;
}

/**
 * 한국어 reason a placed piece may not be recovered right now; null = go ahead. Only stacks block: taking a piece out
 * from under another one would leave the upper layers floating, so only the top layer may leave.
 */
export function recoverBlockReason(state: ShipState, item: PlacedFurniture): string | null {
  const def = FURNITURE_DEF_MAP.get(item.defId);
  if (!def) return null;                                   // unknown def: let the player clean it up
  if (stackLimitOf(def) <= 1) return null;
  const above = topLayer(stackMembers(state, item.room, def, item.x, item.y, item.yaw, item.uid));
  if (above > layerOf(item)) return `위층 ${def.name}을(를) 먼저 회수하세요`;
  return null;
}

/* ── furniture upgrades ───────────────────────────────────────────────────── */

/**
 * `BENCH_MAX_LEVEL` caps **작업대** only (2026-09-12): 관물대 · 시뮬레이션 허브 took over the old 사격장 Lv.1–5 and
 * read their `maxLevel` straight from `data/furniture.csv`.
 */
export function furnitureMaxLevel(def: FurnitureDef): number {
  return benchKindOf(def.interaction) ? Math.min(def.maxLevel, BENCH_MAX_LEVEL) : def.maxLevel;
}

/** Cost from `level` to `level + 1` for a placed piece, null at max. */
export function nextFurnitureCost(def: FurnitureDef, level: number): CraftIngredient[] | null {
  if (level >= furnitureMaxLevel(def)) return null;
  return def.upgradeCost[level - 1] ?? null;
}

/** Why a placed piece cannot be upgraded; null = go ahead. Order: max → generator → materials. */
export function furnitureUpgradeReason(state: ShipState, item: PlacedFurniture, count: CountFn, nameOf: NameFn): string | null {
  const def = FURNITURE_DEF_MAP.get(item.defId);
  if (!def) return '알 수 없는 가구입니다';
  if (item.level >= furnitureMaxLevel(def)) return def.maxLevel <= 1 ? '업그레이드할 수 없는 가구입니다' : '최대 레벨입니다';
  const gate = generatorGateReason(state, item.level + 1);
  if (gate) return gate;
  const cost = nextFurnitureCost(def, item.level);
  if (!cost) return '업그레이드할 수 없습니다';
  const missing = missingIngredients(cost, count);
  if (missing.length) return `재료 부족: ${formatCost(missing, nameOf)}`;
  return null;
}

/* ── 시설 레벨 요구 (2026-09-12, 사용자 결정) ────────────────────────────────
 * 「발전기 Lv.n 이 필요하다」를 문장이 아니라 **칩**으로 그리기 위한 질의다 (`HousingRef.furnitureUpgradeRequirements` ·
 * `purposeRequirements` → ui 의 `buildFacilityChip`). 게이트의 식은 `generatorGateReason` 과 **같은 한 줄**이다.
 *
 * ⚠ 2026-09-14 (사용자 결정 — 「재료 썸네일에 발전기 레벨 썸네일을 표시」): 이제 **채워진 요구도 돌려준다.**
 * 재료 칩이 가진 것과 필요한 것을 늘 같이 보여 주듯 발전기도 `현재/필요` 를 늘 보여 줘야 하기 때문이고, 모자랄 때는
 * 칩이 스스로 `.is-short`(빨강)로 말한다. 그래서 **빈 배열이 더 이상 「문제 없음」을 뜻하지 않는다** — 막는지 여부는
 * 예전부터 그랬듯 사유 함수(`generatorGateReason` · `furnitureUpgradeReason` · `purposeBuildBlockReason`)가 답한다.
 * 발전기는 Lv.1 로 시작하므로 요구가 1 이하인 것(작업실 · 첫 강화)은 늘 채워져 있어 칩을 만들지 않는다 — 잡음이다.
 * ────────────────────────────────────────────────────────────────────────── */

/** 발전기 레벨 요구 하나 (요구가 `GENERATOR_START_LEVEL` 이하면 늘 채워져 있으므로 빈 배열). */
export function generatorRequirement(state: ShipState, targetLevel: number): FacilityRequirement[] {
  if (targetLevel <= GENERATOR_START_LEVEL) return [];
  return [{ facility: 'generator', have: state.generatorLevel, need: targetLevel }];
}

/** 놓인 가구의 **다음 강화**를 막는 시설 레벨 요구 (최대 레벨이거나 모르는 가구면 빈 배열). */
export function furnitureUpgradeRequirementsFor(state: ShipState, item: PlacedFurniture): FacilityRequirement[] {
  const def = FURNITURE_DEF_MAP.get(item.defId);
  if (!def || item.level >= furnitureMaxLevel(def)) return [];
  return generatorRequirement(state, item.level + 1);
}

/** 빈 방에 `purpose` 를 **증축**하는 데 채워지지 않은 시설 레벨 요구 (빈 방 · 지을 수 없는 용도는 빈 배열). */
export function purposeRequirementsFor(state: ShipState, purpose: RoomPurpose): FacilityRequirement[] {
  if (purpose === 'empty' || !isAssignablePurpose(purpose)) return [];
  return generatorRequirement(state, purposeGeneratorLevel(purpose));
}

/* ── 비디오게임: TV 좌석 (2026-09-13, H2 — docs/plans/library-series-games.md §3) ───────────────────────────────────
 * 격자 규약은 위 「배치 규칙: 접근 면」 절과 **같은 것**이다 — 가구의 앞 = 로컬 −Z, 그 격자 방향 = 계약의 `furnitureFaceDir(yaw, 'front')`
 * (yaw 0 → 격자 y 감소 · 1 → x 증가 · 2 → y 증가 · 3 → x 감소). TV 의 접근 면은 `front` 라 앞 한 줄은 늘 비어 있다.
 *
 *   ① 좌석 = TV 와 **같은 방**에 놓인 가구 중 interaction ∈ `SEAT_INTERACTIONS` (의자 · 쇼파 `seat`, 흔들의자).
 *   ② **TV 정면**: 좌석 몸체 전체가 TV 의 앞 끝 바깥에 있다 (앞 방향 = 깊이 축에서 좌석의 가까운 끝이 TV 앞 끝을 넘지 않는다),
 *      그리고 깊이 축에 수직인 **폭 축**에서 좌석과 TV 의 칸 범위가 한 칸 이상 겹친다.
 *   ③ **TV 를 본다**: 좌석 yaw = (TV yaw + 2) % 4 — 좌석의 앞(로컬 −Z)이 TV 쪽을 가리킨다.
 *   ④ **통로** = ② 의 겹친 폭 × TV 앞 끝과 좌석 가까운 끝 **사이** 칸. TV · 그 좌석이 아닌 가구 몸체가 한 칸이라도 걸리면 막힌다 —
 *      단 `FurnitureDef.low`(좌식 테이블 · 러그)는 건너뛴다. 거리는 무관하다.
 * 유효한 좌석이 여럿이면 통로가 가장 짧은 것 → 겹친 폭이 넓은 것 → 배치 순서. 없으면 **가장 멀리 간 후보의 사유**를 준다:
 * 통로가 막힘 > TV 를 보고 있지 않음 > 정면에 없음 (다른 방의 좌석은 후보가 아니다).
 * hub 는 이 규칙이 고른 좌석에 앉히고 좌석의 앞 방향(= TV 쪽)을 보게 한다.
 * ────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
import { SEAT_INTERACTIONS } from '@/shared';

export const TV_SEAT_REASON_KO = {
  notTv: 'TV 가 아닙니다',
  none: 'TV 정면에 의자나 쇼파가 없습니다',
  facing: '좌석이 TV 를 보고 있지 않습니다',
  blocked: 'TV 와 좌석 사이를 가구가 막고 있습니다',
} as const;

/** `tvSeatFor` 의 답 — 좌석이 있으면 `seatUid`(reason null), 없으면 한국어 `reason`(seatUid null). */
export interface TvSeatResult {
  seatUid: string | null;
  reason: string | null;
  /** 고른 좌석의 통로 사각형 (격자 칸, 깊이 0 이면 좌석이 TV 앞 줄 바로 너머다). 좌석이 없으면 null. */
  corridor: { x: number; y: number; cols: number; rows: number } | null;
}

/** TV 를 볼 수 있는 좌석 가구인가 (`SEAT_INTERACTIONS`). */
export function isSeatDef(def: FurnitureDef | null | undefined): boolean {
  return !!def && SEAT_INTERACTIONS.includes(def.interaction);
}

/** TV `tvUid` 를 보는 유효한 좌석 (규칙은 위 절 주석). 순수 함수 — 전력 · 켜짐은 보지 않는다. */
export function tvSeatFor(state: ShipState, tvUid: string): TvSeatResult {
  const tv = state.furniture.find((f) => f.uid === tvUid);
  const tvDef = tv ? FURNITURE_DEF_MAP.get(tv.defId) : undefined;
  if (!tv || !tvDef || tvDef.interaction !== 'tv') return { seatUid: null, reason: TV_SEAT_REASON_KO.notTv, corridor: null };
  const tfp = furnitureFootprint(tvDef, tv.yaw);
  const { dx, dy } = furnitureFaceDir(tv.yaw, 'front');
  const wantYaw = (tv.yaw + 2) % 4;
  /** 0 = 정면에 없음 · 1 = 보고 있지 않음 · 2 = 막힘 — 사유는 가장 큰 단계. */
  let stage = 0;
  let best: { uid: string; depth: number; width: number; corridor: { x: number; y: number; cols: number; rows: number } } | null = null;
  for (const seat of state.furniture) {
    if (seat.uid === tv.uid || seat.room !== tv.room) continue;
    const sdef = FURNITURE_DEF_MAP.get(seat.defId);
    if (!sdef || !isSeatDef(sdef)) continue;
    const sfp = furnitureFootprint(sdef, seat.yaw);
    let corridor: { x: number; y: number; cols: number; rows: number };
    if (dy !== 0) {
      // 깊이 축 = 격자 y, 폭 축 = 격자 x
      let a: number, b: number;
      if (dy < 0) { if (seat.y + sfp.rows > tv.y) continue; a = seat.y + sfp.rows; b = tv.y; }
      else { if (seat.y < tv.y + tfp.rows) continue; a = tv.y + tfp.rows; b = seat.y; }
      const wa = Math.max(tv.x, seat.x), wb = Math.min(tv.x + tfp.cols, seat.x + sfp.cols);
      if (wb <= wa) continue;
      corridor = { x: wa, y: a, cols: wb - wa, rows: b - a };
    } else {
      // 깊이 축 = 격자 x, 폭 축 = 격자 y
      let a: number, b: number;
      if (dx < 0) { if (seat.x + sfp.cols > tv.x) continue; a = seat.x + sfp.cols; b = tv.x; }
      else { if (seat.x < tv.x + tfp.cols) continue; a = tv.x + tfp.cols; b = seat.x; }
      const wa = Math.max(tv.y, seat.y), wb = Math.min(tv.y + tfp.rows, seat.y + sfp.rows);
      if (wb <= wa) continue;
      corridor = { x: a, y: wa, cols: b - a, rows: wb - wa };
    }
    if (seat.yaw !== wantYaw) { stage = Math.max(stage, 1); continue; }
    const depth = dy !== 0 ? corridor.rows : corridor.cols;
    const width = dy !== 0 ? corridor.cols : corridor.rows;
    let blocked = false;
    if (corridor.cols > 0 && corridor.rows > 0) {
      for (const other of state.furniture) {
        if (other.room !== tv.room || other.uid === tv.uid || other.uid === seat.uid) continue;
        const odef = FURNITURE_DEF_MAP.get(other.defId);
        if (!odef || odef.low) continue;
        const ofp = furnitureFootprint(odef, other.yaw);
        if (overlaps(corridor.x, corridor.y, corridor.cols, corridor.rows, other.x, other.y, ofp.cols, ofp.rows)) { blocked = true; break; }
      }
    }
    if (blocked) { stage = 2; continue; }
    if (!best || depth < best.depth || (depth === best.depth && width > best.width)) best = { uid: seat.uid, depth, width, corridor };
  }
  if (best) return { seatUid: best.uid, reason: null, corridor: best.corridor };
  const reason = stage === 2 ? TV_SEAT_REASON_KO.blocked : stage === 1 ? TV_SEAT_REASON_KO.facing : TV_SEAT_REASON_KO.none;
  return { seatUid: null, reason, corridor: null };
}
