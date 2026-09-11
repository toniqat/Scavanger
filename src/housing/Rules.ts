import type {
  CraftIngredient, FacilityId, FurnitureDef, GrowTier, ItemDef, PlacedBook, PlacedFurniture, RoomPurpose, ShipState, SkillId,
  SoilTag,
} from '@/shared';
import {
  ANALYZE_DEX_SPEEDUP, ANALYZE_KNOWN_SPEEDUP,
  BENCH_MAX_LEVEL, BOOK_GAIN_MAX, BOOK_RARITY_MUL, BOOK_XP_PER_BOOK, FACILITY_LABEL_KO, FURNITURE_DEF_MAP, GENERATOR_MAX_LEVEL, GENERATOR_UPGRADE_COST, PRESETS_BY_RANGE_LEVEL,
  GROW_SKILL_SPEEDUP, GROW_TIER_DRAW_ORDER, SKILL_LEVEL_MAX, SOIL_MATCH_SPEEDUP, SOIL_MISMATCH_PENALTY, growTiersForLevel,
  RANGE_MAX_LEVEL, RANGE_SKILL_GAIN_PER_LEVEL, RANGE_UPGRADE_COST, ROOM_GRID_COLS, ROOM_GRID_ROWS, ROOM_PURPOSE_LABEL_KO,
  ROOM_PURPOSES, ROOM_PURPOSE_BUILD_COST, ROOM_PURPOSE_BUILD_GENERATOR_LEVEL,
  SHIP_ROOM_COUNT,
  STASH_COLS, STASH_ROWS_BY_STORAGE_LEVEL, STORAGE_MAX_LEVEL, STORAGE_UPGRADE_COST, WORKSHOP_COST_DISCOUNT_PER_LEVEL,
  WORKSHOP_MAX_LEVEL, WORKSHOP_UPGRADE_COST, furnitureFootprint,
} from '@/shared';

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

export function facilityMaxLevel(id: FacilityId): number {
  switch (id) {
    case 'generator': return GENERATOR_MAX_LEVEL;
    case 'storage': return STORAGE_MAX_LEVEL;
    case 'workshop': return WORKSHOP_MAX_LEVEL;
    case 'range': return RANGE_MAX_LEVEL;
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
 * Cost to raise `id` from `level` to `level + 1`, null at max (or for a room facility that has no room yet).
 * Ship-wide tables start at level 1 (`cost[level]`), room tables at level 2 (level 1 comes with the purpose).
 */
export function nextFacilityCost(id: FacilityId, level: number): CraftIngredient[] | null {
  if (level >= facilityMaxLevel(id)) return null;
  switch (id) {
    case 'generator': return GENERATOR_UPGRADE_COST[level] ?? null;
    case 'storage': return STORAGE_UPGRADE_COST[level] ?? null;
    case 'workshop': return level < 1 ? null : WORKSHOP_UPGRADE_COST[level - 1] ?? null;
    case 'range': return level < 1 ? null : RANGE_UPGRADE_COST[level - 1] ?? null;
  }
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
  if (level >= facilityMaxLevel(id)) return '최대 레벨입니다';
  const purpose = facilityPurpose(id);
  if (purpose && level < 1) return `${ROOM_PURPOSE_LABEL_KO[purpose]} 용도의 방이 필요합니다`;
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
  const gate = generatorGateReason(state, ROOM_PURPOSE_BUILD_GENERATOR_LEVEL);
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

export function presetCountFor(rangeLevel: number): number {
  const i = Math.max(0, Math.min(PRESETS_BY_RANGE_LEVEL.length - 1, Math.floor(rangeLevel)));
  return PRESETS_BY_RANGE_LEVEL[i];
}

/** `1 − WORKSHOP_COST_DISCOUNT_PER_LEVEL × (level − 1)`, 1 at level ≤ 1, never below CRAFT_COST_MUL_MIN. */
export function craftCostMulFor(workshopLevel: number): number {
  if (workshopLevel <= 1) return 1;
  return Math.max(CRAFT_COST_MUL_MIN, 1 - WORKSHOP_COST_DISCOUNT_PER_LEVEL * (workshopLevel - 1));
}

/** Gun skills gain `1 + RANGE_SKILL_GAIN_PER_LEVEL × rangeLevel`; everything else 1. */
export function skillGainMulFor(skill: SkillId, rangeLevel: number): number {
  return skill.startsWith('gun_') && rangeLevel > 0 ? 1 + RANGE_SKILL_GAIN_PER_LEVEL * rangeLevel : 1;
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
 * non-book ids weigh 0). Multiplied into `HousingRef.getSkillGainMul` next to the 사격장 factor.
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
 * 심는 순간 확정되는 성장 시간(ms): `growHours × 3600e3 × 원예 단축 × 토양 궁합`.
 * 궁합이 맞으면 `1 − SOIL_MATCH_SPEEDUP`, 아니면 `1 + SOIL_MISMATCH_PENALTY` 다 (토양 없이 심는 경우는 없다).
 * 1초 미만으로는 내려가지 않는다.
 */
export function growDurationMs(growHours: number, matched: boolean, gardening: number): number {
  const skill = Math.max(0, Math.min(SKILL_LEVEL_MAX, gardening));
  const speed = 1 - GROW_SKILL_SPEEDUP * (skill / SKILL_LEVEL_MAX);
  const soil = matched ? 1 - SOIL_MATCH_SPEEDUP : 1 + SOIL_MISMATCH_PENALTY;
  return Math.max(1000, Math.round(Math.max(0, growHours) * 3600e3 * speed * soil));
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
export function analyzeDurationMs(analyzeHours: number, dexRatio: number, known: boolean): number {
  const ratio = Math.max(0, Math.min(1, Number.isFinite(dexRatio) ? dexRatio : 0));
  const dex = 1 - ANALYZE_DEX_SPEEDUP * ratio;
  const repeat = known ? 1 - ANALYZE_KNOWN_SPEEDUP : 1;
  return Math.max(1000, Math.round(Math.max(0, analyzeHours) * 3600e3 * dex * repeat));
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

export function isRoomPurpose(p: unknown): p is RoomPurpose {
  return typeof p === 'string' && (ROOM_PURPOSES as readonly string[]).includes(p);
}

/** Furniture allowed in a room of `purpose`: its own purpose or 'any'. */
export function furnitureAllowedIn(def: FurnitureDef, purpose: RoomPurpose): boolean {
  return def.room === 'any' || def.room === purpose;
}

/**
 * Why room `index` cannot take `purpose`; null = allowed. 2026-09-07: the 작업실 is an ordinary purpose — any room
 * may take it and a ship may have none (it was locked to room 1 from the Phase 8 UI pass until then).
 * `empty` is always allowed (it recovers every piece);
 * any other purpose is refused while purpose-bound furniture of a different purpose is still placed, and `lab`
 * needs a greenhouse somewhere on the ship.
 */
export function purposeChangeReason(state: ShipState, index: number, purpose: RoomPurpose): string | null {
  if (!isRoomIndex(state, index)) return '없는 방입니다';
  if (purpose === 'empty') return null;
  if (purpose === 'lab' && !state.rooms.some((r, i) => i !== index && r.purpose === 'greenhouse')) return '연구실은 온실이 먼저 필요합니다';
  // facility rooms (작업실 / 사격장) carry the facility level, so the ship holds at most one of each
  if (facilityPurposeOf(purpose)) {
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

/** Inside the room grid after rotation? */
export function insideGrid(def: FurnitureDef, x: number, y: number, yaw: 0 | 1 | 2 | 3): boolean {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) return false;
  const fp = furnitureFootprint(def, yaw);
  return x + fp.cols <= ROOM_GRID_COLS && y + fp.rows <= ROOM_GRID_ROWS;
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

/**
 * Purpose match (or 'any') + inside the grid + no overlap with other pieces in the room (`ignoreUid` = the piece being
 * moved). Stackable defs (`stackLimit > 1`) may share their footprint with the same def at the same cell / yaw while
 * the stack is below its limit.
 */
export function canPlaceAt(state: ShipState, room: number, def: FurnitureDef, x: number, y: number, yaw: 0 | 1 | 2 | 3, ignoreUid?: string): boolean {
  if (!isRoomIndex(state, room)) return false;
  if (!furnitureAllowedIn(def, state.rooms[room].purpose)) return false;
  if (!insideGrid(def, x, y, yaw)) return false;
  const limit = stackLimitOf(def);
  if (limit > 1 && nextFreeLayer(stackMembers(state, room, def, x, y, yaw, ignoreUid), limit) < 0) return false;
  const fp = furnitureFootprint(def, yaw);
  for (const other of state.furniture) {
    if (other.room !== room || other.uid === ignoreUid) continue;
    const odef = FURNITURE_DEF_MAP.get(other.defId);
    if (!odef) continue;
    const ofp = furnitureFootprint(odef, other.yaw);
    if (!overlaps(x, y, fp.cols, fp.rows, other.x, other.y, ofp.cols, ofp.rows)) continue;
    // a stack may only be shared by the identical def in the identical spot
    if (limit > 1 && other.defId === def.id && other.x === x && other.y === y && other.yaw === yaw) continue;
    return false;
  }
  return true;
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
  const door = doorClearanceCell(room);
  for (const pass of [1, 2] as const) {
    for (const yaw of AUTO_PLACE_YAWS) {
      const fp = furnitureFootprint(def, yaw);
      for (let x = 0; x + fp.cols <= ROOM_GRID_COLS; x++) {          // 화면 세로: 위 → 아래
        for (let y = ROOM_GRID_ROWS - fp.rows; y >= 0; y--) {        // 화면 가로: 왼쪽 → 오른쪽
          const inDoorZone = overlaps(x, y, fp.cols, fp.rows, door.x, door.y, DOOR_CLEAR_DEPTH, DOOR_CLEAR_SPAN);
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

export function furnitureMaxLevel(def: FurnitureDef): number {
  return Math.min(def.maxLevel, BENCH_MAX_LEVEL);
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
