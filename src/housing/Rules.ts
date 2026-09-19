import type {
  CraftIngredient, FacilityId, FacilityRequirement, FurnitureDef, GrowTier, ItemDef, PlacedBook, PlacedFurniture, RoomPurpose, ShipState, SkillId,
  SoilTag,
} from '@/shared';
import {
  COCKPIT_ROOM_INDEX, ROOM_PURPOSES_ASSIGNABLE, roomGridSize, roomRectBlocked,
  BENCH_MAX_LEVEL, BOOK_GAIN_MAX, BOOK_RARITY_MUL, BOOK_XP_PER_BOOK, FACILITY_LABEL_KO, FURNITURE_DEF_MAP, GENERATOR_MAX_LEVEL, GENERATOR_START_LEVEL, GENERATOR_UPGRADE_COST, PRESETS_BY_RANGE_LEVEL,
  GROW_SKILL_SPEEDUP, GROW_STATION_SPEED_PER_LEVEL, GROW_TIER_DRAW_ORDER, SKILL_LEVEL_MAX, SOIL_MATCH_SPEEDUP, SOIL_MISMATCH_PENALTY, growTiersForLevel,
  RANGE_SKILL_GAIN_PER_LEVEL, RANGE_UPGRADE_COST, ROOM_GRID_COLS, ROOM_GRID_ROWS, ROOM_PURPOSE_LABEL_KO,
  ROOM_PURPOSES, ROOM_PURPOSE_BUILD_COST, purposeGeneratorLevel,
  SHIP_ROOM_COUNT,
  STASH_COLS, STASH_ROWS_BY_STORAGE_LEVEL, STORAGE_MAX_LEVEL, STORAGE_UPGRADE_COST,
  WORKSHOP_UPGRADE_COST, benchKindOf, furnitureFootprint,
} from '@/shared';
/* 2026-09-13 (cooking material tiers) */
import type { AnalysisResultDef, SampleFamily } from '@/shared';
import { ANALYSIS_RESULTS, GROW_SOCKET_TIME_FLOOR, GROW_WEAR_MUL_FLOOR, analysisTimeMul } from '@/shared';
/* 2026-09-16 (sample rework — the rarity-floor draw · catalogue / level speedup) */
import type { Rarity } from '@/shared';
import {
  ANALYSIS_DEX_BONUS_PER_ENTRY, ANALYSIS_SAMPLE_LEVEL_FIRST, ANALYSIS_SAMPLE_LEVEL_MAX, ANALYSIS_SAMPLE_LEVEL_STEP,
  ANALYSIS_SPEEDUP_CAP, rarityRank,
} from '@/shared';

/* ────────────────────────────────────────────────────────────────────────────
 * Pure housing rules: placement, costs, prerequisites. No ctx, no DOM — every function takes the state (or the piece
 * of it that matters) plus callbacks for the two things that live elsewhere (material counts, item names) so the
 * system and the panels agree on one implementation and the smoke can reason about the numbers.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Units of `defId` the player owns (bag + stash). */
export type CountFn = (defId: string) => number;
/** Korean item name for a def id (falls back to the id). */
export type NameFn = (defId: string) => string;

/** Lowest craft-cost multiplier the workshop discount may reach. */
export const CRAFT_COST_MUL_MIN = 0.5;

/* ── facilities ───────────────────────────────────────────────────────────── */

/**
 * 2026-09-12 (user's decision — **room facility levels removed**): 작업실 and 시뮬레이션실 have no level (1 while
 * the room exists, 0 when it does not). Upgrading is the job of the furniture inside — 작업대 (recipes), 관물대
 * (preset slots), 시뮬레이션 허브 (gun skill gain). 발전기 and 창고 are ship-wide and keep their levels.
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
 * The **materials spent** on an old save's room facility levels (Lv.1 → `level`, merged per material). When room
 * facility levels went away on 2026-09-12, `ShipState.sanitize` began handing this back into the 함선 창고 for every
 * 작업실 · 사격장 above level 1 — the same philosophy as retired furniture (`furnitureRefundCost`). The table is the
 * retired block (`workshop` · `range`) of `data/facility_upgrades.csv`.
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

/**
 * The reason shown when missing materials block something (2026-09-15, user's decision).
 * **It never lists the missing materials in prose** — every screen's material chip already prints `보유/필요` and
 * says it itself in `.is-short` (red) when it falls short, so repeating that in a sentence only makes the line
 * longer. Four reason functions return this one string.
 */
export const MISSING_MATERIALS_REASON = '재료 부족';

export function formatCost(cost: readonly CraftIngredient[], nameOf: NameFn): string {
  return cost.map((c) => `${nameOf(c.defId)} ${c.qty}`).join(' · ');
}

/** Korean reason the generator gate blocks a target level, null when the generator is high enough. */
export function generatorGateReason(state: ShipState, targetLevel: number): string | null {
  return state.generatorLevel >= targetLevel ? null : `발전기 레벨 ${targetLevel} 필요 (현재 ${state.generatorLevel})`;
}

/** Why `id` cannot be upgraded right now; null = go ahead. Order: max → room → generator → materials. */
export function facilityBlockReason(state: ShipState, id: FacilityId, count: CountFn, nameOf: NameFn): string | null {
  const level = facilityLevel(state, id);
  const purpose = facilityPurpose(id);
  // 2026-09-12: a room facility has no level — the reason is "no such room" when there is none, else "upgrade the furniture"
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
  if (missing.length) return MISSING_MATERIALS_REASON;
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

/* ── facility build-out (Phase 9 UI pass) ─────────────────────────────────────
 * Giving an empty room a purpose costs materials now (`ROOM_PURPOSE_BUILD_COST`) and sits behind the same 발전기
 * gate as every other upgrade. 빈 방 (tearing a room back down) stays free and always refunds.
 * ────────────────────────────────────────────────────────────────────────── */

/** Materials a 시설 증축 to `purpose` costs; empty for 빈 방 (and for anything the table does not know). */
export function purposeBuildCost(purpose: RoomPurpose): readonly CraftIngredient[] {
  return purpose === 'empty' ? [] : ROOM_PURPOSE_BUILD_COST[purpose] ?? [];
}

/**
 * Full Korean reason a 시설 증축 is refused; null = go ahead. Structure first (`purposeChangeReason` — locked room,
 * duplicate facility, blocking furniture, 연구실 prerequisite), then the 발전기 gate, then the materials. 빈 방 only
 * ever hits the structural rules.
 */
export function purposeBuildBlockReason(
  state: ShipState, index: number, purpose: RoomPurpose, count: CountFn, nameOf: NameFn,
): string | null {
  const structural = purposeChangeReason(state, index, purpose);
  if (structural) return structural;
  if (purpose === 'empty') return null;
  // 2026-09-13 (user's decision — power allocation dropped): every purpose needs its own generator level (`purposeGeneratorLevel`)
  const gate = generatorGateReason(state, purposeGeneratorLevel(purpose));
  if (gate) return gate;
  const missing = missingIngredients(purposeBuildCost(purpose), count);
  if (missing.length) return MISSING_MATERIALS_REASON;
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
 * @deprecated 2026-09-12 (user's decision — 프리셋 기능 제거 · 관물대 retired): no caller; `getPresetCount()` is always 0.
 */
export function presetCountFor(consoleLevel: number): number {
  const i = Math.max(0, Math.min(PRESETS_BY_RANGE_LEVEL.length - 1, Math.floor(consoleLevel)));
  return PRESETS_BY_RANGE_LEVEL[i];
}

/**
 * Craft material multiplier. **Always 1 since 2026-09-12** — the 작업실 discount went away with the room levels
 * (user's decision). Kept so `HousingRef.getCraftCostMul` (contract) has one place to answer from.
 */
export function craftCostMulFor(_workshopLevel: number): number {
  return 1;
}

/**
 * Gun skills gain `1 + RANGE_SKILL_GAIN_PER_LEVEL × level` of the highest placed **시뮬레이션 허브** (0 = none);
 * everything else 1. 2026-09-12: was the 사격장 room level.
 * @deprecated 2026-09-12 (user's decision — 시뮬레이션실 · 시뮬레이션 허브 removed): no caller; `getSkillGainMul` is the 서재 alone.
 */
export function skillGainMulFor(skill: SkillId, simHubLevel: number): number {
  return skill.startsWith('gun_') && simHubLevel > 0 ? 1 + RANGE_SKILL_GAIN_PER_LEVEL * simHubLevel : 1;
}

/* ── library bookshelves (Phase 9) ───────────────────────────────────────── */

/** Weight one shelved book contributes (`BOOK_RARITY_MUL[rarity]`); 0 for anything that is not a book. */
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

/* ── library media (A-3e, 2026-09-12) ─────────────────────────────────────────
 * 책장 · 디스크 전시대 · 레코드랙 follow one rule — each medium's share is **capped on its own**, then multiplied by
 * `1 + SHELF_AUX_BONUS[m]` when that medium's auxiliary furniture stands anywhere on the ship, and the three are
 * added (docs/DECISIONS.md 「2026-09-12 — 헬스장 · 서재 매체」):
 *
 *     share[m]  = min(SHELF_GAIN_MAX[m] − 1, SHELF_XP_PER_ITEM[m] × Σ BOOK_RARITY_MUL[rarity]) × (aux ? 1 + SHELF_AUX_BONUS[m] : 1)
 *     library multiplier = 1 + share[book] + share[disc] + share[record]
 *
 * With books alone and no auxiliary furniture, `1 + min(BOOK_GAIN_MAX − 1, x)` = `min(BOOK_GAIN_MAX, 1 + x)`, i.e. **the
 * same value** as `bookGainMulFor` (`smoke-library`'s Phase 9 check has to keep passing). Every number comes from the
 * contract's `SHELF_*` tables (= `data/constants.csv`).
 * ────────────────────────────────────────────────────────────────────────── */
import type { ShelfBonusInfo, ShelfMedium } from '@/shared';
import { SHELF_AUX_BONUS, SHELF_AUX_INTERACTION, SHELF_GAIN_MAX, SHELF_MEDIA, SHELF_XP_PER_ITEM, shelfItemOf } from '@/shared';

/** Medium id prefixes in the save — the shape-only rule for when there is no `ctx.loot` (`sanitize`). Whether it really is that medium is filtered at runtime. */
export const SHELF_ID_PREFIX: Readonly<Record<ShelfMedium, string>> = { book: 'book_', disc: 'disc_', record: 'record_', game: 'game_' };
const SHELF_ID_SHAPE = /^(book|disc|record|game)_[A-Za-z0-9_]{1,40}$/;

/** The medium read from a media id's **shape** (`book_*` · `disc_*` · `record_*` · 2026-09-13 `game_*`), null when the shape does not match. */
export function shelfMediumOfDefId(defId: unknown): ShelfMedium | null {
  if (typeof defId !== 'string') return null;
  const m = SHELF_ID_SHAPE.exec(defId);
  return m ? (m[1] as ShelfMedium) : null;
}

/** Weight of one shelved item, `BOOK_RARITY_MUL[rarity]` — 0 when it is not library media. The all-media form of `bookWeightOf`. */
export function shelfItemWeightOf(def: ItemDef | undefined): number {
  if (!def || !shelfItemOf(def)) return 0;
  const w = BOOK_RARITY_MUL[def.rarity];
  return Number.isFinite(w) && w > 0 ? w : 0;
}

/**
 * Medium `medium`'s share: the summed weight of the `items` of that medium which teach `skill`, ×
 * `SHELF_XP_PER_ITEM[medium]`, capped at `SHELF_GAIN_MAX[medium] − 1` and then multiplied by the auxiliary furniture
 * factor. Exactly 0 when there are none.
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
 * Does that medium's auxiliary furniture (`SHELF_AUX_INTERACTION[medium]`) stand anywhere on the ship? Several of
 * them still count **once** — 축음기 · 주크박스 · 턴테이블 are all `record_player`, so this one query is what makes
 * 「the three are one role in three shapes」 (user's decision) true.
 */
export function shelfAuxPlaced(furniture: readonly PlacedFurniture[], medium: ShelfMedium): boolean {
  const want = SHELF_AUX_INTERACTION[medium];
  return furniture.some((f) => FURNITURE_DEF_MAP.get(f.defId)?.interaction === want);
}

/** One skill's library multiplier, per medium (`HousingRef.getShelfBonus`). `books` = `ShipState.books`, `media` = `ShipState.media`. */
export function shelfGainFor(
  skill: SkillId, books: readonly PlacedBook[], media: readonly PlacedBook[],
  defOf: (defId: string) => ItemDef | undefined, aux: Readonly<Record<ShelfMedium, boolean>>,
): ShelfBonusInfo {
  const parts: Record<ShelfMedium, number> = { book: 0, disc: 0, record: 0, game: 0 };
  for (const m of SHELF_MEDIA) parts[m] = shelfPartFor(m, skill, m === 'book' ? books : media, defOf, aux[m]);
  return { total: 1 + parts.book + parts.disc + parts.record, parts, aux: { book: aux.book, disc: aux.disc, record: aux.record, game: false } };
}

/* ── library series (2026-09-13, docs/DECISIONS.md 「2026-09-13 — 서재 시리즈 · 비디오게임」 — user's decision) ─────
 * **The old formula is retired** — `bookWeightOf` · `bookGainMulFor` · `shelfItemWeightOf` · `shelfPartFor` ·
 * `shelfGainFor` above and the contract's `BOOK_RARITY_MUL` · `SHELF_XP_PER_ITEM` · `SHELF_GAIN_MAX` keep their names
 * only (no caller — the add-only convention). The new formula:
 *
 *     volumes held = the number of **distinct volumes** of that series shelved in a working holder (several copies of one def = 1, the same volume number = 1)
 *     series share = librarySeriesFraction(volumes held, total volumes)   ← 1 for the full set, else SHELF_SERIES_VOLUME_SHARE per volume
 *     line value   = full-set value × series share × (that medium's auxiliary furniture working ? 1 + SHELF_AUX_BONUS[medium] : 1)
 *     the sum      = added per (kind, target) → `LibraryEffectsSummary`. `recipe` only opens the targets of a series at share 1.
 *
 * The `items` input is a slot list **already filtered down to working holders** — the power judgement, the cache and
 * the events are `parts/Library`'s job, and this section knows nothing about ctx.
 * A game disc (`'game'`) is a storage medium with no effect and never reaches here (it has no series).
 * ────────────────────────────────────────────────────────────────────────── */
import type { LibraryEffect, LibraryEffectKind, LibraryEffectsSummary, LibraryMedium, LibrarySeriesDef, LibrarySourceInfo } from '@/shared';
import { LIBRARY_SERIES_MAP, librarySeriesFraction } from '@/shared';

/** The medium of an item that can go into a holder — 책 · 디스크 · 레코드 (`shelfItemOf`) + a game disc (`ItemDef.gameDisc`), else null. */
export function shelfHolderMediumOfItem(def: ItemDef | null | undefined): ShelfMedium | null {
  if (!def) return null;
  if (def.gameDisc) return 'game';
  return shelfItemOf(def)?.medium ?? null;
}

/** Series and volume number of an effect-carrying library item (`series` · `volume` of `ItemDef.book` / `disc` / `record`). null without a series; 1 without a volume number. */
export function librarySeriesOfItem(def: ItemDef | null | undefined): { medium: LibraryMedium; seriesId: string; volume: number } | null {
  if (!def) return null;
  const medium: LibraryMedium | null = def.book ? 'book' : def.disc ? 'disc' : def.record ? 'record' : null;
  const data = def.book ?? def.disc ?? def.record;
  if (!medium || !data || typeof data.series !== 'string' || !data.series) return null;
  const v = Math.floor(Number(data.volume ?? 1));
  return { medium, seriesId: data.series, volume: Number.isFinite(v) && v >= 1 ? v : 1 };
}

/** One series' current state (`computeLibraryEffects` builds one per series with a shelved volume). */
export interface LibrarySeriesState {
  def: LibrarySeriesDef;
  /** How many distinct volumes are shelved in a working holder. */
  have: number;
  total: number;
  /** `librarySeriesFraction(have, total)`. */
  fraction: number;
  /** Is that medium's auxiliary furniture working (recorded even when the share is 0). */
  auxApplied: boolean;
  /** The shelved volume numbers (distinct, ascending). */
  volumes: readonly number[];
  /** Item def ids of the shelved volumes (file order). */
  defIds: readonly string[];
}

export interface LibraryComputation {
  /** The sum (without a revision — the cache adds that). */
  effects: Omit<LibraryEffectsSummary, 'revision'>;
  /** Every series with at least one shelved volume. */
  series: ReadonlyMap<string, LibrarySeriesState>;
}

/** Cuts floating-point dust (1e-9) — so neither the signature comparison nor a number on screen ever sees `0.30000000000000004`. */
function libRound(v: number): number {
  return Math.round(v * 1e9) / 1e9;
}

/** What one effect line actually adds right now: `recipe` = 1 at share 1, everything else = full-set value × share × the auxiliary furniture factor. */
export function libraryLineValue(effect: LibraryEffect, s: Pick<LibrarySeriesState, 'def' | 'fraction' | 'auxApplied'>): number {
  if (effect.kind === 'recipe') return s.fraction >= 1 ? 1 : 0;
  const aux = s.auxApplied ? 1 + (SHELF_AUX_BONUS[s.def.medium] ?? 0) : 1;
  return libRound(effect.value * s.fraction * aux);
}

/**
 * The library effect sum (pure). `items` = the slots shelved in working holders (books + discs · records — a game
 * disc mixed in is ignored, it has no series), `aux` = whether each medium's auxiliary furniture is working,
 * `seriesMap` = the series table (an argument so a smoke can inject one). A def is counted **exactly once**.
 * An item whose medium differs from its series' medium (a data error) is not counted.
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

/** The series that give one effect target a value (`HousingRef.getLibrarySources`) — largest first. A series worth 0 is left out. */
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

/** One skill's library multiplier, per medium (`HousingRef.getShelfBonus` — the old shape, the series formula's values). The game disc share is always 0. */
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

/** Content signature of the sum (revision excluded, keys sorted, 6 decimal places) — this is how the cache answers 「did it really change」. */
export function libraryEffectsSignature(e: Omit<LibraryEffectsSummary, 'revision'>): string {
  const rec = (r: Readonly<Partial<Record<string, number>>>): string =>
    Object.keys(r).filter((k) => r[k]).sort().map((k) => `${k}=${(r[k] as number).toFixed(6)}`).join(',');
  return [rec(e.skillGain), rec(e.derived), rec(e.gymScore), rec(e.cookScore), e.raidXp.toFixed(6), rec(e.trustXp), [...e.recipes].sort().join(',')].join('|');
}

/* ── greenhouse grow station (2026-09-11) ─────────────────────────────────────
 * Only the pure judgements live here — is the tier open · does the soil match · how long growing takes · progress.
 * Touching the state is `parts/Garden.ts`'s job, and every number comes from `@/shared` (= `data/*.csv`).
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The lowest grow station level that opens `tier` (2 for the middle, 3 for the top). The numbers are not written
 * again — they are **derived** from the contract (`growTiersForLevel`), so this function follows on its own when
 * the unlock levels change.
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

/** Is the soil poured in the one the seed wants (false, i.e. the mismatch penalty, when either is unknown). */
export function soilMatches(soilTag: SoilTag | null | undefined, seedTag: SoilTag | null | undefined): boolean {
  return !!soilTag && !!seedTag && soilTag === seedTag;
}

/**
 * A grow station level's **growth speed multiplier** (2026-09-13, user's decision): `1 + GROW_STATION_SPEED_PER_LEVEL
 * × (level − 1)` — Lv.1 = 1 · Lv.2 = 1.15 · Lv.3 = 1.3. Growth time is **divided** by it. Below level 1 it reads as 1.
 */
export function growStationSpeedMul(level: number): number {
  const lv = Math.max(1, Math.floor(Number.isFinite(level) ? level : 1));
  return 1 + Math.max(0, GROW_STATION_SPEED_PER_LEVEL) * (lv - 1);
}

/** The 「+15%」 the screens show — the growth speed the level added, in per cent, rounded. Lv.1 = 0. */
export function growStationSpeedPct(level: number): number {
  return Math.round((growStationSpeedMul(level) - 1) * 100);
}

/**
 * Growth time (ms), fixed the moment the seed goes in: `growHours × 3600e3 × the gardening speedup × the soil match
 * ÷ the station speed`. A match is `1 − SOIL_MATCH_SPEEDUP`, otherwise `1 + SOIL_MISMATCH_PENALTY` (nothing is ever
 * planted without soil). The station speed is `growStationSpeedMul(stationLevel)` (2026-09-13 — Lv.1 = 1 when
 * omitted). It never drops below one second.
 */
export function growDurationMs(
  growHours: number, matched: boolean, gardening: number, stationLevel = 1, bonusRatio = 1, socketSpeed = 0,
): number {
  const skill = Math.max(0, Math.min(SKILL_LEVEL_MAX, gardening));
  const speed = 1 - GROW_SKILL_SPEEDUP * (skill / SKILL_LEVEL_MAX);
  /* 2026-09-13 (cooking material tiers): only the match **bonus** scales with the soil's durability ratio — the penalty does not. At ratio 1 this is the old formula. */
  const ratio = clamp01(bonusRatio);
  const soil = matched ? (ratio >= 1 ? 1 - SOIL_MATCH_SPEEDUP : 1 - SOIL_MATCH_SPEEDUP * ratio) : 1 + SOIL_MISMATCH_PENALTY;
  const station = growStationSpeedMul(stationLevel);
  return Math.max(1000, Math.round((Math.max(0, growHours) * 3600e3 * speed * soil * socketTimeMul(socketSpeed, ratio)) / station));
}

/**
 * **Rescaling growth times at the moment of an upgrade** (2026-09-13, user's decision — the **only exception** to
 * 「readyAt is fixed when the seed goes in」). When the station speed rises `oldMul` → `newMul`, a growing crop's
 * timeline is compressed by `oldMul / newMul` **around now (`now`)**: the remaining time shrinks by that ratio and
 * the elapsed stretch shrinks by the same ratio, so the **progress (%) carries straight over** (leaving `plantedAt`
 * alone makes the bar jump). A ripe crop (`now ≥ readyAt`) and a speed that did not rise come back unchanged.
 * `readyAt` is never pulled earlier than `now`, and `plantedAt` always stays earlier than `readyAt`.
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

/** Progress 0…1 (−1 when nothing was ever planted). A save planted in the future (a client with a wrong clock) is clamped too. */
export function growProgress(now: number, plantedAt: number | undefined, readyAt: number | undefined): number {
  if (!plantedAt || !readyAt) return -1;
  const total = Math.max(1, readyAt - plantedAt);
  return Math.max(0, Math.min(1, (now - plantedAt) / total));
}

/** Seconds left (0 when ripe or empty). */
export function growRemainingS(now: number, readyAt: number | undefined): number {
  if (!readyAt) return 0;
  return Math.max(0, Math.ceil((readyAt - now) / 1000));
}

/* ── lab analyzer (A-12, 2026-09-11) ──────────────────────────────────────────
 * Same place, same philosophy as the greenhouse — the duration is fixed **the moment the sample goes in**, and an
 * analysis already running never speeds up as the catalogue fills. Progress and seconds left reuse `growProgress` /
 * `growRemainingS` as they are (pure clock arithmetic that knows nothing about crops or samples — one folder, so it
 * is not copied a second time).
 * ────────────────────────────────────────────────────────────────────────── */

/* The old `analyzeDurationMs` (a catalogue-ratio term and a known-sample term) was deleted on 2026-09-16 — nothing
   called it, and nobody reads those two constants (`ANALYZE_DEX_SPEEDUP` · `ANALYZE_KNOWN_SPEEDUP`) any more. There
   is one duration formula, `analysisDurationMs`. */

/* ── greenhouse culture tank (A-14, 2026-09-11) ───────────────────────────────
 * Same place, same philosophy as the analyzer and the grow station — the duration is fixed **the moment the strain
 * goes in**, and a culture already running never speeds up when the medium is swapped or the gardening skill rises.
 * Progress and seconds left reuse `growProgress` / `growRemainingS` as they are (pure clock arithmetic that knows
 * nothing about crops, samples or strains).
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Culture time (ms), fixed **the moment the strain goes in**:
 * `cultureHours × the medium's grade (`MediumDef.speedMul`) × the gardening speedup`.
 * The gardening term is **the same term** `growDurationMs` uses (greenhouse furniture, so the same skill does the
 * work — the number is not written again). There is no axis matching soil tags: a medium has only its grade.
 * Never below one second.
 */
export function cultureDurationMs(cultureHours: number, mediumSpeedMul: number, gardening: number, bonusRatio = 1, socketSpeed = 0): number {
  const skill = Math.max(0, Math.min(SKILL_LEVEL_MAX, gardening));
  const speed = 1 - GROW_SKILL_SPEEDUP * (skill / SKILL_LEVEL_MAX);
  const m = Number.isFinite(mediumSpeedMul) && mediumSpeedMul > 0 ? mediumSpeedMul : 1;
  /* 2026-09-13 (cooking material tiers): the medium's speed bonus (`1 − speedMul`) scales with the medium's durability ratio. At ratio 1 this is the old formula. */
  const ratio = clamp01(bonusRatio);
  const medium = ratio >= 1 ? m : 1 - (1 - m) * ratio;
  return Math.max(1000, Math.round(Math.max(0, cultureHours) * 3600e3 * medium * speed * socketTimeMul(socketSpeed, ratio)));
}

/* ── cooking material tiers (2026-09-13, docs/DECISIONS.md 「2026-09-13 — 요리 재료 티어」) ─────
 * Soil and medium durability with their sockets, plus the analyzer result table. All pure functions, every number
 * from the contract (`@/shared` = `data/*.csv`).
 * Randomness is **injected** (`rng01`) — callers pass `Math.random`, a smoke passes a fixed sequence.
 * ────────────────────────────────────────────────────────────────────────────────────────────────────────── */

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

/** The time multiplier the summed socket `speed` gives: `max(GROW_SOCKET_TIME_FLOOR, 1 − speed × ratio)`. Exactly 1 with no socket. */
function socketTimeMul(socketSpeed: number, ratio: number): number {
  const s = Number.isFinite(socketSpeed) ? Math.max(0, socketSpeed) : 0;
  if (s <= 0) return 1;
  return Math.max(GROW_SOCKET_TIME_FLOOR, 1 - s * ratio);
}

/** A soil's or medium's bonus ratio = durability / max (0 … 1). 0 when the max is 0 or less. */
export function durabilityRatio(cur: number, max: number): number {
  if (!(max > 0)) return 0;
  return clamp01(cur / max);
}

/**
 * Durability after one harvest: `max(0, cur − wear × max(GROW_WEAR_MUL_FLOOR, 1 − wearSum))`. `wearSum` = the summed
 * `wear` of the fitted sockets (it does **not** scale with the durability ratio — this is the socket that protects
 * durability itself). Floating-point dust is cut at the second decimal place.
 */
export function wearAfterHarvest(cur: number, wearPerHarvest: number, wearSum: number): number {
  const c = Number.isFinite(cur) ? Math.max(0, cur) : 0;
  return Math.max(0, Math.round((c - effectiveWear(wearPerHarvest, wearSum)) * 100) / 100);
}

/** How much one harvest actually wears off (the same term `wearAfterHarvest` uses). */
export function effectiveWear(wearPerHarvest: number, wearSum: number): number {
  const w = Number.isFinite(wearPerHarvest) ? Math.max(0, wearPerHarvest) : 0;
  const s = Number.isFinite(wearSum) ? Math.max(0, wearSum) : 0;
  return w * Math.max(GROW_WEAR_MUL_FLOOR, 1 - s);
}

/**
 * Harvests left until durability reaches 0, `ceil(cur / the effective wear)` — this is what the old `soilUsesLeft` ·
 * `mediumUsesLeft` slots mean now (a slot does not empty when it hits 0). With zero wear it reads as 1 for as long as
 * any durability is left (infinity is never written down).
 */
export function harvestsUntilWorn(cur: number, wearPerHarvest: number, wearSum: number): number {
  const c = Number.isFinite(cur) ? Math.max(0, cur) : 0;
  if (c <= 0) return 0;
  const w = effectiveWear(wearPerHarvest, wearSum);
  return w > 0 ? Math.ceil(c / w - 1e-9) : 1;
}

/**
 * Migrates an old save's 「harvests left」 to durability: `round(max × clamp(usesLeft / uses))`. Without `uses`, the max as it is.
 */
export function durabilityFromUses(max: number, usesLeft: number, uses: number): number {
  const m = Number.isFinite(max) ? Math.max(0, max) : 0;
  if (!(uses > 0)) return m;
  return Math.round(m * clamp01(usesLeft / uses));
}

/**
 * 2026-09-16 (user's decision — the `data/analysis_results.csv` header): **the sample's rarity is the floor for the
 * result's rarity**. The caller passes the two things the filter cannot know — the sample's rarity, and the result
 * def's rarity (the item table lives on ctx). Without them (the catalogue screen's 「기준」 list) the floor is not checked.
 */
export interface AnalysisRollOpts {
  /** Rarity of the sample that went in. Without it the floor check is skipped. */
  sampleRarity?: Rarity;
  /** Rarity of the result def (null when the item table does not know it → that row counts as passing the floor check). */
  rarityOf?: (defId: string) => Rarity | null;
}

/**
 * The rows of the result table that stay in the draw: `family` · `minLevel ≤ level` · `weight > 0` · `defOk(defId)`,
 * and on top of that,
 *  - a row carrying `sampleRarity` attaches **only to samples of that rarity** and is **exempt** from the floor check
 *    (the six quartz rows — the guard against an empty pool),
 *  - a row without it needs `rarityRank(result rarity) ≥ rarityRank(sample rarity)` (user's decision: a rare sample
 *    yields nothing below rare).
 */
function analysisPool(
  family: SampleFamily, level: number, defOk: (defId: string) => boolean, opts: AnalysisRollOpts = {},
): AnalysisResultDef[] {
  const lv = Math.floor(Number.isFinite(level) ? level : 1);
  const want = opts.sampleRarity;
  const floor = want ? rarityRank(want) : -1;
  return ANALYSIS_RESULTS.filter((r) => {
    if (r.family !== family || r.minLevel > lv || !(r.weight > 0) || !defOk(r.defId)) return false;
    if (r.sampleRarity) return want === undefined || r.sampleRarity === want;
    if (floor < 0) return true;
    const got = opts.rarityOf?.(r.defId) ?? null;
    return got === null || rarityRank(got) >= floor;
  });
}

/**
 * One roll of an analysis result — a weighted draw among the surviving rows, with the quantity uniform over the
 * integers `qtyMin … qtyMax`. `rng01` is called **twice** (row, then quantity). null when there is no row to draw
 * from (the caller then falls back to the sample's own `rewardDefId`).
 */
export function rollAnalysisResult(
  family: SampleFamily, level: number, rng01: () => number, defOk: (defId: string) => boolean, opts: AnalysisRollOpts = {},
): { defId: string; qty: number } | null {
  const pool = analysisPool(family, level, defOk, opts);
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

/** The chance one analysis at this level yields each result (the same formula as `rollAnalysisResult` — rows with the same defId are merged). */
export function analysisChances(
  family: SampleFamily, level: number, defOk: (defId: string) => boolean, opts: AnalysisRollOpts = {},
): Record<string, number> {
  const pool = analysisPool(family, level, defOk, opts);
  const total = pool.reduce((a, r) => a + r.weight, 0);
  const out: Record<string, number> = {};
  if (total <= 0) return out;
  for (const r of pool) out[r.defId] = (out[r.defId] ?? 0) + r.weight / total;
  return out;
}

/* ── 2026-09-16 (user's decision): the analysis speedup ──────────────────────
 * This is where the old 「catalogue ratio × ANALYZE_DEX_SPEEDUP」 and 「ANALYZE_KNOWN_SPEEDUP for a known sample」
 * terms were taken out. Two things changed, and both are about **what it scales with** rather than a number, so they
 * are written down here:
 *  ① The catalogue bonus scales with the **number of entries**, not a ratio, and it applies to **every sample of the
 *     same rarity**, not to 「that kind of sample」.
 *  ② The sample level bonus is **largest the first time** — level 1 gives the whole of `FIRST` and every level after
 *     that only adds `STEP`. The user's ask, 「give a big bonus the first time it is registered」, **is** the gap
 *     between `FIRST` (3 %) and `STEP` (0.5 %).
 * ──────────────────────────────────────────────────────────────────────────── */

/** The speedup a sample level gives (before the cap). Level 0 = 0, 1 = `FIRST`, n = `FIRST + (n − 1) × STEP`. */
export function analysisLevelBonus(sampleLevel: number): number {
  const lv = Math.max(0, Math.min(ANALYSIS_SAMPLE_LEVEL_MAX, Math.floor(Number.isFinite(sampleLevel) ? sampleLevel : 0)));
  return lv <= 0 ? 0 : ANALYSIS_SAMPLE_LEVEL_FIRST + (lv - 1) * ANALYSIS_SAMPLE_LEVEL_STEP;
}

/** The speedup `dexEntries` analysis catalogue entries of the same rarity give (before the cap). */
export function analysisDexBonus(dexEntries: number): number {
  const n = Math.max(0, Math.floor(Number.isFinite(dexEntries) ? dexEntries : 0));
  return n * ANALYSIS_DEX_BONUS_PER_ENTRY;
}

/** The final speedup: the two bonuses **added** and then cut at `ANALYSIS_SPEEDUP_CAP` (0 … CAP). Analysis time is `× (1 − this)`. */
export function analysisSpeedup(dexEntries: number, sampleLevel: number): number {
  return Math.max(0, Math.min(ANALYSIS_SPEEDUP_CAP, analysisDexBonus(dexEntries) + analysisLevelBonus(sampleLevel)));
}

/**
 * Analysis time (ms), fixed the moment the sample goes in:
 * `analyzeHours × 3600e3 × analysisTimeMul(the family's analysis level) × (1 − speedup)`, at least 1000 ms.
 * The family analysis level's multiplier and the sample speedup are **different axes**, so they multiply (the
 * speedup's cap does not cover the multiplier).
 */
export function analysisDurationMs(analyzeHours: number, level: number, speedup = 0): number {
  const h = Number.isFinite(analyzeHours) ? Math.max(0, analyzeHours) : 0;
  const cut = Math.max(0, Math.min(ANALYSIS_SPEEDUP_CAP, Number.isFinite(speedup) ? speedup : 0));
  return Math.max(1000, Math.round(h * 3600e3 * analysisTimeMul(level) * (1 - cut)));
}

/* ── retired furniture refund (greenhouse rework, 2026-09-11) ────────────── */

/**
 * The materials one retired piece (`FurnitureDef.retired`) gives back — its craft cost plus every upgrade cost up to
 * its level, merged per material. The same philosophy as the facility refund (`facilityRefundCost`): it hands back
 * **today's table**, as it stands.
 */
export function furnitureRefundCost(def: FurnitureDef, level: number): CraftIngredient[] {
  const total = new Map<string, number>();
  for (const c of def.craft ?? []) total.set(c.defId, (total.get(c.defId) ?? 0) + c.qty);
  for (let k = 1; k < Math.max(1, Math.floor(level)); k++) {
    for (const c of nextFurnitureCost(def, k) ?? []) total.set(c.defId, (total.get(c.defId) ?? 0) + c.qty);
  }
  return [...total].map(([defId, qty]) => ({ defId, qty }));
}

/** Merges two material lists per material (used to collect the refunds of several retired pieces). */
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
 * 2026-09-12 (user's decision — the cockpit): a spot furniture **may be placed in** = a room (`isRoomIndex`) or the
 * cockpit (`COCKPIT_ROOM_INDEX`). The purpose and facility rules (`setRoomPurpose` · `removeRoomFacility` · 시설 증축)
 * still look at `isRoomIndex` alone — the cockpit has no purpose.
 */
export function isPlaceRoom(state: ShipState, room: number): boolean {
  return room === COCKPIT_ROOM_INDEX || isRoomIndex(state, room);
}

/** The purpose the furniture rules see for that spot — the cockpit is `'cockpit'` (it takes `'any'` furniture only), a room that does not exist is null. */
export function placeRoomPurpose(state: ShipState, room: number): RoomPurpose | null {
  if (room === COCKPIT_ROOM_INDEX) return 'cockpit';
  return isRoomIndex(state, room) ? state.rooms[room].purpose : null;
}

/** Can an empty room be given this purpose (`ROOM_PURPOSES_ASSIGNABLE` — since 2026-09-12 시뮬레이션실 · 휴식 공간 · 조종석 cannot). */
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
 * The purposes that need a greenhouse first. One line is the source for three places: `purposeChangeReason`,
 * `ShipState.sanitize`'s orphan handling, and `Rooms.setRoomPurpose`'s 「when the last greenhouse goes, the rooms
 * that depend on it are emptied too」.
 *
 * **2026-09-14 (user's decision) — there is no prerequisite facility.** The old value was `['lab', 'kitchen']` (the
 * 연구실 because its samples and media come from the greenhouse, the 주방 because crops were the only cooking
 * ingredient back at A-3c). The only gate on a build-out now is **the generator level** (`purposeGeneratorLevel` ·
 * `generatorGateReason` — that is unchanged), and the ordering between room purposes is gone. The contract name stays
 * under the **add only, never delete** convention with just its value emptied — an empty array turns all three
 * consumers into no-ops by themselves, so not one of those lines was touched (`includes` is always false).
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
  // 2026-09-12 (user's decision): 시뮬레이션실 · 휴식 공간 (merged into 서재) · 조종석 can no longer be assigned to an empty room
  if (!isAssignablePurpose(purpose)) return `${ROOM_PURPOSE_LABEL_KO[purpose]}은(는) 더 이상 지을 수 없습니다`;
  // The greenhouse prerequisite — **`NEEDS_GREENHOUSE` has been empty since the 2026-09-14 user's decision**: this branch never fires.
  // Putting a purpose back into that array revives the rule, so the branch stays (the same grain as add only, never delete).
  if (NEEDS_GREENHOUSE.includes(purpose) && !state.rooms.some((r, i) => i !== index && r.purpose === 'greenhouse')) {
    return `${ROOM_PURPOSE_LABEL_KO[purpose]}은(는) 온실이 먼저 필요합니다`;
  }
  // 2026-09-12 (user's decision): **every purpose is once per ship** — 시설 관리's purpose list does not show a
  // purpose that already exists at all. A save that built two back when only 작업실 · 사격장 were unique is left alone (`sanitize` does not touch it).
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

/* ── stacking (Phase 8: the grow rack) ────────────────────────────────────────
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

/* ── placement rules: access faces (2026-09-13, user's decision — docs/DECISIONS.md 「2026-09-13 — 가구 접근 면 · 발전기 · 암호화폐 채굴」 · the contract's closing section in `shared/housing.ts`) ──────────
 * A piece's front is local −Z. A `front` piece needs its front row (body width × one cell deep) free of other bodies,
 * and that row must not be outside the grid (a wall) either.
 * `sides` is the two long faces (local ±Z); `all` needs one row on each of the four faces free of bodies, though a
 * wall is allowed there. Corner cells need not be free.
 * The rule is **two-way** — a new body may not enter the cells an already placed piece needs free either. Cells that
 * must be free may overlap each other (two workbenches facing each other share a one-cell corridor). A cockpit fixture
 * cell (`roomCellBlocked`) counts as a body.
 * The cell arithmetic comes from the contract's `furnitureFaceDir` · `furnitureClearanceCells`; here each face is read
 * as a one-row **rectangle** (so no cell list is built — housing mode asks every frame). The direction table is filled
 * once at module load from that contract function.
 * ────────────────────────────────────────────────────────────────────────── */
import type { FurnitureAccess, FurnitureFace } from '@/shared';
import { accessAllowsWall, furnitureAccessFaces, furnitureAccessOf, furnitureFaceDir, isCockpitOnlyFurniture } from '@/shared';

/** The kind of rule that blocks a placement. `access` = the access-face rule (2026-09-13) — `ShipState.sanitize` moves only these into 가구 창고 and drops the rest as before. */
export type PlacementBlockKind = 'place' | 'purpose' | 'grid' | 'fixture' | 'stack' | 'overlap' | 'access';
export interface PlacementBlock { kind: PlacementBlockKind; reason: string }

/** The placement refusal strings (시설 관리's toast and the smokes read the same text). */
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
/** `FACE_DIR[yaw][face]` = the contract's `furnitureFaceDir(yaw, face)` (built once at module load). */
const FACE_DIR: ReadonlyArray<Readonly<Record<FurnitureFace, { dx: number; dy: number }>>> = ([0, 1, 2, 3] as const).map(
  (yaw) => Object.fromEntries(ACCESS_FACES.map((f) => [f, furnitureFaceDir(yaw, f)])) as Record<FurnitureFace, { dx: number; dy: number }>,
);
/** The one-row rectangle of a face (a reused scratch — read it right where it is handed back). */
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
 * Why `def` cannot go at (x, y, yaw) of `room` — null means it can. Order: spot → purpose → grid → fixture → stack
 * limit → body overlap → my own access faces (wall · body) → someone else's access face. `ignoreUid` = the piece being
 * moved (it is never compared against itself).
 */
export function placementBlockOf(
  state: ShipState, room: number, def: FurnitureDef, x: number, y: number, yaw: 0 | 1 | 2 | 3, ignoreUid?: string,
): PlacementBlock | null {
  // 2026-09-12: the cockpit is a placement spot too (purpose 'cockpit' = 'any' furniture + cockpit-only facilities) — the contract's tables answer the grid size and the fixture cells
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
  // 2026-09-13: my own access faces — the front may not be a wall, and no face's row may hold a fixture or another piece's body
  const access = furnitureAccessOf(def);
  if (access !== 'none') {
    const grid = roomGridSize(room);
    for (const face of furnitureAccessFaces(access)) {
      const r = faceRect(x, y, fp.cols, fp.rows, yaw, face);
      const inside = r.x >= 0 && r.y >= 0 && r.x + r.cols <= grid.cols && r.y + r.rows <= grid.rows;
      if (!inside) {
        if (!accessAllowsWall(access)) return { kind: 'access', reason: PLACEMENT_REASON_KO.frontWall };
        continue;                                   // one row only, so outside the grid means the whole row is wall (the body is already inside)
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
  // 2026-09-13: someone else's access face — my body may not enter the row an already placed piece needs free (the rows themselves may overlap)
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

/** Only `placementBlockOf`'s string — this is what `HousingRef.placementBlock` returns. null = it can be placed. */
export function placementBlockReason(
  state: ShipState, room: number, def: FurnitureDef, x: number, y: number, yaw: 0 | 1 | 2 | 3, ignoreUid?: string,
): string | null {
  return placementBlockOf(state, room, def, x, y, yaw, ignoreUid)?.reason ?? null;
}

/**
 * Purpose match (or 'any') + inside the grid + no overlap with other pieces in the room (`ignoreUid` = the piece being
 * moved). Stackable defs (`stackLimit > 1`) may share their footprint with the same def at the same cell / yaw while
 * the stack is below its limit. **2026-09-13**: + the access-face rules (`placementBlockOf`) — this is exactly
 * `placementBlockOf(...) === null`, so every caller (hand placement · `move` · auto placement · `sanitize`) sees one rule.
 */
export function canPlaceAt(state: ShipState, room: number, def: FurnitureDef, x: number, y: number, yaw: 0 | 1 | 2 | 3, ignoreUid?: string): boolean {
  return placementBlockOf(state, room, def, x, y, yaw, ignoreUid) === null;
}

/* ── auto placement (2026-09-10) ──────────────────────────────────────────────
 * 「fill a row from the top left first, and the piece faces down」 — the **only** rule 시설 관리 (the `배치` button in
 * 가구 창고) uses when it has to pick a spot the player did not. A rotation the player set by hand in housing mode
 * never passes through this function and is left alone.
 *
 * The screen ↔ grid correspondence is grounded in two places (copied here rather than measured again):
 *   · `hub/interiors/RoomLayout` — grid `x` is world +X, `y` is world +Z (cell (0,0) = the room's min-x / min-z
 *     corner). A piece's world rotation is `rotation.y = −yaw·π/2`, and a procedural model's **front is local −Z**.
 *   · `hub/HousingMode` — since Phase 10 the 시설 관리 camera looks down −X from the +X side of the room centre
 *     (`CAM_TOWARD_DOOR`) in **every room**. So **screen right = world −Z and screen down = world +X** (the same
 *     sentence as that file's cursor-movement comment: "screen right = world −Z and screen down = world +X for every room").
 *
 * Putting the two together gives the coordinates this folder uses:
 *   screen down = grid `x` rising            screen right = grid `y` falling
 *   screen top left = (x 0, y max)           a row on screen = `x` fixed while `y` counts down
 * So the scan order is **x ascending (outer) × y descending (inner)** — on screen it fills one row from top left to
 * the right, then drops to the next. The anchor (`x`,`y`) is the grid's minimum corner, so reaching the screen's top
 * left means starting `y` at `ROOM_GRID_ROWS − fp.rows` and counting down to 0.
 *
 * The facing comes from the front vector: `R_y(−yaw·π/2)·(0,0,−1) = (−sin θ, −cos θ)`, so
 *   yaw 0 → −Z (screen right) · **yaw 1 → +X (screen down)** · yaw 2 → +Z (screen left) · yaw 3 → −X (screen up).
 * The order used to be `[0, 1]`, which left every workbench at yaw 0 facing the **right-hand wall on screen**, so
 * using it meant squeezing in between the wall and the bench. yaw 1 comes first now. The fallback rotation is `0`
 * because the footprints of yaw 1/3 and 0/2 are transposes of each other: a piece that does not fit at yaw 1 does not
 * fit at yaw 3 either — only turning it on its side means anything.
 */
export const AUTO_PLACE_YAWS: readonly (0 | 1 | 2 | 3)[] = [1, 0];
/**
 * 2026-09-13 (placement rules): the rotations tried next when the preferred ones (`AUTO_PLACE_YAWS`) find no spot.
 * Since the access-face rule, yaw 3 is no longer a copy of yaw 1 — the footprint is the same but the **front is
 * reversed**, so a `front` piece whose front is against a wall (the grid's last row) stands once it turns around.
 * The order and the preferred rotations are unchanged, and a piece with no access face gains no new spot (same footprint).
 */
export const AUTO_PLACE_FALLBACK_YAWS: readonly (0 | 1 | 2 | 3)[] = [3, 2];
const AUTO_PLACE_YAW_ORDER: readonly (0 | 1 | 2 | 3)[] = [...AUTO_PLACE_YAWS, ...AUTO_PLACE_FALLBACK_YAWS];

/* ── door clearance (auto placement only) ─────────────────────────────────────
 * Change nothing but the order and **the door is blocked.** A room door sits in the middle of the room's ±X wall
 * (`hub/interiors/RoomLayout`: `doorZ` = the room's z centre, `DOOR_WIDTH` 1.6 m), and the room number decides which
 * wall — the forward half (0…4) is to port, so its door is on the **+X** wall; the aft half (5…9) is to starboard,
 * so its door is on the **−X** wall. The new rule's first spot (grid x 0, the screen's top left) is right in front of
 * that door in a starboard room, and a 4×2 workbench at yaw 1 covers half of the 1.6 m gap (0.8 m), so a player of
 * `PLAYER_RADIUS` 0.45 ×2 = 0.9 m **cannot get through** (the real colliders are built by `hub/interiors/Furniture`).
 *
 * So auto placement alone steps around a box in front of the door — `DOOR_CLEAR_DEPTH` cells deep from the door's
 * wall × `DOOR_CLEAR_SPAN` cells across its middle. The by-hand paths (the housing-mode ghost · `move`) and
 * `canPlaceAt` itself are **left alone**: `ShipState.sanitize` re-checks every saved placement with `canPlaceAt`, so
 * putting this clearance into the placement rules would have thrown the furniture of any ship that already had a
 * piece in front of its door into 가구 창고 on load (= changing saves retroactively). In a port room the reserved
 * cells are at the bottom end of the screen, so 「from the top left」 still holds.
 *
 * The two numbers are **dimensions**, not balance, which is why they are here and not in csv (`data/README.md`, "what
 * was not moved into csv" — the same reason `world/structures/model.ts` keeps wall thickness and door width in TS).
 */
/*
 * 2026-09-12 (`ROOM_GRID_COLS/ROWS` 8 → 16, rooms 4 × 4 → 8 × 8 m): **both numbers stay.** Neither is a fraction of
 * the grid; both come from **the door's dimensions**, and the door is still 1.6 m wide and the player still 0.9 m
 * across — growing the clearance because the room grew would take the new space straight back again.
 *
 * Only whether the zone still lands in front of the door was measured again. The door is at the room's z centre
 * (`doorZ`) and grid `y` is world +Z, so the zone's centring is decided by the one `(ROWS − SPAN)/2` line in
 * `doorClearanceCell`:
 *   · at 8 cells   y 2…5 → 1.0 … 3.0 m from the room's forward corner, the door at 2.0 ± 0.8 = 1.2 … 2.8 m  ✔
 *   · at 16 cells  y 6…9 → 3.0 … 5.0 m,                                the door at 4.0 ± 0.8 = 3.2 … 4.8 m  ✔
 * As long as `ROWS` and `SPAN` are both even the zone bites exactly on the room's centre, and it is wider than the
 * door (3.2 cells).
 */
/** Depth kept free from the door's wall, in cells. 2 cells = 1.0 m ≥ the player's 0.9 m width. */
export const DOOR_CLEAR_DEPTH = 2;
/** Width kept free across the middle of that wall, in cells. 4 cells = 2.0 m ≥ the door's 1.6 m. */
export const DOOR_CLEAR_SPAN = 4;

/** Min corner of the `DOOR_CLEAR_DEPTH × DOOR_CLEAR_SPAN` block auto-placement keeps free in front of `room`'s door. */
export function doorClearanceCell(room: number): { x: number; y: number } {
  // To port (the forward half) the door is on the +X wall = the grid's high-x side; to starboard (the aft half) on the −X wall = grid x 0.
  const port = room < Math.floor(SHIP_ROOM_COUNT / 2);
  return {
    x: port ? ROOM_GRID_COLS - DOOR_CLEAR_DEPTH : 0,
    y: Math.floor((ROOM_GRID_ROWS - DOOR_CLEAR_SPAN) / 2),
  };
}

/**
 * 2026-09-11 (C-27) — are **two adjacent free lanes** left inside the door clearance zone? When two neighbouring
 * cells of the door-width direction (`DOOR_CLEAR_SPAN` cells) are free all the way to `DOOR_CLEAR_DEPTH` from the
 * door's wall, the passage is open — 2 cells = 1.0 m ≥ the player's 0.9 m width (`PLAYER_RADIUS` × 2). `extra` = the
 * footprint of the piece about to be placed (it is counted in).
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
  /** Is lane k of the door-width direction (grid y = door.y + k) free all the way through the depth? */
  const laneFree = (k: number): boolean =>
    !rects.some((r) => overlaps(door.x, door.y + k, DOOR_CLEAR_DEPTH, 1, r.x, r.y, r.cols, r.rows));
  for (let k = 0; k + 1 < DOOR_CLEAR_SPAN; k++) if (laneFree(k) && laneFree(k + 1)) return true;
  return false;
}

/** A free cell + yaw the `배치` button drops a stored piece on. */
export interface FurniturePlacement { x: number; y: number; yaw: 0 | 1 | 2 | 3 }

/**
 * First spot `def` fits in `room` under the rule above — rows first from the screen's top left, facing down, and
 * keeping the space in front of the door clear. `null` when nothing fits (the caller keeps its existing "no spot"
 * handling); every candidate still goes through `canPlaceAt`, so not one of the purpose · grid bound · overlap ·
 * stack limit rules is bypassed.
 *
 * 2026-09-11 (C-27) **second pass**: when avoiding the clearance zone entirely leaves no spot (the room is nearly
 * full), the same order is walked again and spots that reach into the zone are accepted too — but only while
 * `doorPassageOpen` still holds afterwards (two adjacent of the four door-width cells free through the whole depth).
 * Spots already seen in the first pass (outside the zone) need not be looked at again. `canPlaceAt` is unchanged.
 */
export function autoPlaceSpot(state: ShipState, room: number, def: FurnitureDef): FurniturePlacement | null {
  /* 2026-09-12 (the cockpit): the grid size is answered by `roomGridSize` and the blocked cells by `roomRectBlocked`
     inside `canPlaceAt`. The cockpit has no door clearance zone — the fixture table (`COCKPIT_BLOCKED_RECTS`) already
     keeps the corridor arch and the pod approach clear, so there is only one pass. */
  const grid = roomGridSize(room);
  const door = room === COCKPIT_ROOM_INDEX ? null : doorClearanceCell(room);
  for (const pass of door ? [1, 2] : [1]) {
    for (const yaw of AUTO_PLACE_YAW_ORDER) {        // 2026-09-13: the preferred rotations first, then the reversed ones (the access-face rule)
      const fp = furnitureFootprint(def, yaw);
      for (let x = 0; x + fp.cols <= grid.cols; x++) {               // vertically on screen: top → bottom
        for (let y = grid.rows - fp.rows; y >= 0; y--) {             // horizontally on screen: left → right
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
 * Korean reason a placed piece may not be recovered right now; null = go ahead. Only stacks block: taking a piece out
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
  if (missing.length) return MISSING_MATERIALS_REASON;
  return null;
}

/* ── facility level requirements (2026-09-12, user's decision) ────────────────
 * The query that lets 「발전기 Lv.n is needed」 be drawn as a **chip** rather than a sentence
 * (`HousingRef.furnitureUpgradeRequirements` · `purposeRequirements` → ui's `buildFacilityChip`). The gate's formula
 * is **the same single line** as `generatorGateReason`.
 *
 * ⚠ 2026-09-14 (user's decision — 「show the generator level thumbnail next to the material thumbnails」): it now
 * **returns satisfied requirements too.** A material chip always shows what is held next to what is needed, so the
 * generator has to show `현재/필요` always as well, and when it falls short the chip says so itself in `.is-short`
 * (red). So **an empty array no longer means 「nothing is wrong」** — whether something is blocked is answered, as it
 * always was, by the reason functions (`generatorGateReason` · `furnitureUpgradeReason` · `purposeBuildBlockReason`).
 * The generator starts at Lv.1, so a requirement of 1 or less (작업실 · the first upgrade) is always satisfied and
 * gets no chip — that would be noise.
 * ────────────────────────────────────────────────────────────────────────── */

/** One generator level requirement (an empty array at or below `GENERATOR_START_LEVEL`, where it is always satisfied). */
export function generatorRequirement(state: ShipState, targetLevel: number): FacilityRequirement[] {
  if (targetLevel <= GENERATOR_START_LEVEL) return [];
  return [{ facility: 'generator', have: state.generatorLevel, need: targetLevel }];
}

/** The facility level requirements that block a placed piece's **next upgrade** (an empty array at max level, or for an unknown piece). */
export function furnitureUpgradeRequirementsFor(state: ShipState, item: PlacedFurniture): FacilityRequirement[] {
  const def = FURNITURE_DEF_MAP.get(item.defId);
  if (!def || item.level >= furnitureMaxLevel(def)) return [];
  return generatorRequirement(state, item.level + 1);
}

/** The facility level requirements still unmet for **building** `purpose` into an empty room (an empty array for 빈 방 and for a purpose that can no longer be built). */
export function purposeRequirementsFor(state: ShipState, purpose: RoomPurpose): FacilityRequirement[] {
  if (purpose === 'empty' || !isAssignablePurpose(purpose)) return [];
  return generatorRequirement(state, purposeGeneratorLevel(purpose));
}

/* ── video games: the TV seat (2026-09-13, H2 — docs/DECISIONS.md 「2026-09-13 — 서재 시리즈 · 비디오게임」) ─────
 * The grid convention is **the same one** as the 「placement rules: access faces」 section above — a piece's front is
 * local −Z, and its grid direction is the contract's `furnitureFaceDir(yaw, 'front')` (yaw 0 → grid y falling · 1 → x
 * rising · 2 → y rising · 3 → x falling). A TV's access face is `front`, so its front row is always clear.
 *
 *   ① A seat = a piece in the **same room** as the TV whose interaction ∈ `SEAT_INTERACTIONS` (의자 · 쇼파 `seat`, 흔들의자).
 *   ② **In front of the TV**: the whole seat body lies beyond the TV's front edge (along the depth axis, the seat's
 *      near end does not cross the TV's front edge), and on the **width axis** perpendicular to it the seat's and the
 *      TV's cell ranges overlap by at least one cell.
 *   ③ **Facing the TV**: seat yaw = (TV yaw + 2) % 4 — the seat's front (local −Z) points at the TV.
 *   ④ The **corridor** = ②'s overlapping width × the cells **between** the TV's front edge and the seat's near end. A
 *      single cell of any body that is not the TV or that seat blocks it — except `FurnitureDef.low` (a low table, a
 *      rug), which is skipped. Distance does not matter.
 * With several valid seats: shortest corridor → widest overlap → placement order. With none, the reason comes from
 * **the candidate that got furthest**: corridor blocked > not facing the TV > not in front (a seat in another room is
 * not a candidate at all).
 * hub seats the player on the seat this rule picked and turns them to the seat's front direction (= towards the TV).
 * ────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
import { SEAT_INTERACTIONS } from '@/shared';

export const TV_SEAT_REASON_KO = {
  notTv: 'TV 가 아닙니다',
  none: 'TV 정면에 의자나 쇼파가 없습니다',
  facing: '좌석이 TV 를 보고 있지 않습니다',
  blocked: 'TV 와 좌석 사이를 가구가 막고 있습니다',
} as const;

/** `tvSeatFor`'s answer — `seatUid` with a null `reason` when there is a seat, otherwise a Korean `reason` with a null `seatUid`. */
export interface TvSeatResult {
  seatUid: string | null;
  reason: string | null;
  /** The chosen seat's corridor rectangle (grid cells; depth 0 means the seat sits just beyond the TV's front row). null with no seat. */
  corridor: { x: number; y: number; cols: number; rows: number } | null;
}

/** Is this a seat a TV can be watched from (`SEAT_INTERACTIONS`)? */
export function isSeatDef(def: FurnitureDef | null | undefined): boolean {
  return !!def && SEAT_INTERACTIONS.includes(def.interaction);
}

/** The valid seat facing TV `tvUid` (the rules are in the section comment above). A pure function — it looks at neither power nor the on-state. */
export function tvSeatFor(state: ShipState, tvUid: string): TvSeatResult {
  const tv = state.furniture.find((f) => f.uid === tvUid);
  const tvDef = tv ? FURNITURE_DEF_MAP.get(tv.defId) : undefined;
  if (!tv || !tvDef || tvDef.interaction !== 'tv') return { seatUid: null, reason: TV_SEAT_REASON_KO.notTv, corridor: null };
  const tfp = furnitureFootprint(tvDef, tv.yaw);
  const { dx, dy } = furnitureFaceDir(tv.yaw, 'front');
  const wantYaw = (tv.yaw + 2) % 4;
  /** 0 = not in front · 1 = not facing · 2 = blocked — the reason is the highest stage reached. */
  let stage = 0;
  let best: { uid: string; depth: number; width: number; corridor: { x: number; y: number; cols: number; rows: number } } | null = null;
  for (const seat of state.furniture) {
    if (seat.uid === tv.uid || seat.room !== tv.room) continue;
    const sdef = FURNITURE_DEF_MAP.get(seat.defId);
    if (!sdef || !isSeatDef(sdef)) continue;
    const sfp = furnitureFootprint(sdef, seat.yaw);
    let corridor: { x: number; y: number; cols: number; rows: number };
    if (dy !== 0) {
      // depth axis = grid y, width axis = grid x
      let a: number, b: number;
      if (dy < 0) { if (seat.y + sfp.rows > tv.y) continue; a = seat.y + sfp.rows; b = tv.y; }
      else { if (seat.y < tv.y + tfp.rows) continue; a = tv.y + tfp.rows; b = seat.y; }
      const wa = Math.max(tv.x, seat.x), wb = Math.min(tv.x + tfp.cols, seat.x + sfp.cols);
      if (wb <= wa) continue;
      corridor = { x: wa, y: a, cols: wb - wa, rows: b - a };
    } else {
      // depth axis = grid x, width axis = grid y
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
