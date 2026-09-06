import type { CraftIngredient, FacilityId, FurnitureDef, PlacedFurniture, RoomPurpose, ShipState, SkillId } from '@/shared';
import {
  BENCH_MAX_LEVEL, FACILITY_LABEL_KO, FURNITURE_DEF_MAP, GENERATOR_MAX_LEVEL, GENERATOR_UPGRADE_COST, PRESETS_BY_RANGE_LEVEL,
  RANGE_MAX_LEVEL, RANGE_SKILL_GAIN_PER_LEVEL, RANGE_UPGRADE_COST, ROOM_GRID_COLS, ROOM_GRID_ROWS, ROOM_PURPOSE_LABEL_KO,
  ROOM_PURPOSES, STASH_COLS, STASH_ROWS_BY_STORAGE_LEVEL, STORAGE_MAX_LEVEL, STORAGE_UPGRADE_COST, WORKSHOP_COST_DISCOUNT_PER_LEVEL,
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
 * Why room `index` cannot take `purpose`; null = allowed. `empty` is always allowed (it recovers every piece);
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
