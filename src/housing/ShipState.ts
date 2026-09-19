import type {
  AnalysisSlot, CraftIngredient, CultureSlot, GrowSlot, GrowTier, LoadoutPreset, PlacedBook, PlacedFurniture, ProfileRef, RoomPurpose,
  RoomState, ShipState, StoredFurniture,
} from '@/shared';
/* Cooking material tiers (v11, 2026-09-13) */
import type { SampleFamily } from '@/shared';
import { GROW_SOCKET_SLOTS_MAX, SAMPLE_FAMILIES } from '@/shared';
import {
  BOOKS_PER_SHELF, COCKPIT_DECOR_FURNITURE, COCKPIT_DEFAULT_FURNITURE, COCKPIT_ROOM_INDEX, FURNITURE_DEF_MAP, GROW_SLOTS_PER_TIER, IMPLANT_IDS,
  isCockpitOnlyFurniture,
  ROOM_PURPOSES_ASSIGNABLE, SHIP_ROOM_COUNT, SHIP_STATE_VERSION, SHIP_STORAGE_KEY,
  analyzerSlotsForLevel, cultureSlotsForLevel, slotKey,
} from '@/shared';
/* 2026-09-13 (power allocation dropped — v13): the generator start level · the build requirement of each purpose */
import { GENERATOR_START_LEVEL, ROOM_PURPOSE_LABEL_KO, purposeGeneratorLevel } from '@/shared';
/* A-3e (2026-09-12): library media (v9) */
import type { ShelfMedium } from '@/shared';
import { SHELF_SLOTS, isToggleInteraction, shelfMediumOfInteraction } from '@/shared';
import { shelfMediumOfDefId } from './Rules';
/* 2026-09-13 (library series · video games): the old item id swap · the TV console */
import type { TvConsoleSlot } from '@/shared';
import { resolveItemAlias } from '@/shared';
/* 2026-09-13 (crypto mining) · 2026-09-16 (processors mounted directly — an old 연산 코어 is refunded as a processor) */
import { COMPUTE_CLUSTER_DEF_ID, COMPUTE_CLUSTER_MAX_CORES, PROCESSOR_DEF_ID } from '@/shared';
/* 2026-09-16 (the sample rework): the cap on a sample's analysis level */
import { ANALYSIS_SAMPLE_LEVEL_MAX } from '@/shared';
import { sanitizeClusters, sanitizeUnitsMap } from './MiningRules';
import {
  NEEDS_GREENHOUSE,
  autoPlaceSpot, canPlaceAt, facilityMaxLevel, facilityPurposeOf, furnitureAllowedIn, furnitureMaxLevel, furnitureRefundCost, growTierOpen,
  isRoomPurpose, legacyRoomLevelCost, mergeCost, nextFreeLayer, roomRefundCost, stackLimitOf, stackMembers,
} from './Rules';
/* 2026-09-13 (placement rules — access faces): an old placement that breaks the rule goes to the 가구 창고, a 조종석-only facility always back to the 조종석 */
import { placementBlockOf } from './Rules';
import { furnitureFootprint } from '@/shared';
/* 2026-09-16 (the plate model): the dining table's plate — the meal id is checked against the meal table (`shared/meals`) */
import type { DiningPlate } from '@/shared';
import { getMealDef, normalizeMealQuality } from '@/shared';

/* ────────────────────────────────────────────────────────────────────────────
 * ShipState persistence: fresh state, load + sanitise + migrate, debounced save with a pagehide flush. Same shape as
 * inventory/Stash.ts (try/catch around every localStorage touch, SAVE_DELAY_MS debounce). Uids of placed furniture
 * are `f-<n>`; `nextUid` continues after the highest one found in the save. Phase 7: every flush also mirrors the state
 * into the server profile document `ship` (`ctx.net.profile.set`) when a profile is available.
 * Phase 8: state **version 2** — `plots` (greenhouse growing), `nameLocked`, `PlacedFurniture.layer`, and the 정비 벤치 that
 * left the cockpit was granted once to every profile (v1 → v2). **That grant was swept out on 2026-09-12** — the 정비 벤치 is
 * retired (user's decision), so a granted one was a refund case at once, and the grant sat below the retired sweep, unfiltered.
 * Phase 9: state **version 3** — `books` (서재 책장 slots) + `bookDex` (every book ever shelved); absent → empty, no
 * data migration. That was the version the contract's `SHIP_STATE_VERSION` named at the time — `SHIP_STATE_VERSION_CURRENT`
 * has always been the max of it and the number this file reached (14 today).
 * The greenhouse rework (2026-09-11): state **version 4** — `grows` (재배 스테이션 slots) replaces `plots`, and **every `retired`
 * furniture def is swept out of the save** (placed or stored) and handed back as materials. `sanitize` cannot reach
 * the inventory, so it only *computes* that refund into its optional `out` and `HousingSystem` pays it into the
 * 함선 창고 as soon as `ctx.inventory` exists (see `flushRetiredRefund`).
 * The lab (2026-09-11): state **version 5** — `analyses` (analyzer slots) + `sampleDex` (the analysis catalogue). Only new fields
 * appear, so **there is no data to drop and no refund path** — a v4 save opens with them empty.
 * The culture tank (A-14, 2026-09-11): state **version 6** — `cultures` (culture slots). v5 → v6 is only new fields again,
 * so it has no migration and no refund path.
 * Room facility levels removed (2026-09-12): state **version 7** — same shape, `RoomState.level` is always 1 (empty room 0).
 * A v6-or-older 사격장 Lv.n moves into the 관물대 · 시뮬레이션 허브 level, or refunds what it cost when it has neither;
 * a 작업실 Lv.n always refunds into the 함선 창고 (`sanitize`'s v7 block). The version was raised to migrate **once only**.
 * ──────────────────────────────────────────────────────────────────────────── */

/** `ShipStore` write debounce (ms) — one burst of edits is one localStorage write and one profile upload. */
const SAVE_DELAY_MS = 350;

/*
 * 조종석 · 8 rooms (2026-09-12, user's decision): state **version 8** — same shape. A ship has `SHIP_ROOM_COUNT` (8) rooms;
 * 방 9 · 10 of an old save and any room whose purpose can no longer be built (시뮬레이션실 · 휴식 공간) are **removed and
 * refunded in full** (furniture → 가구 창고, build materials → 함선 창고 = `out.refund`, books on that room's bookshelf too).
 * 관물대 · 표적 레인 · 시뮬레이션 허브 are retired, so the retired sweep hands their materials back. And **every load** checks
 * that the two shared facility pieces (전술 임플란트 시술대 · 기업 네트워크 컴퓨터) exist, filling the 조종석 if not (`ensureCockpitFurniture`).
 */
/*
 * Library media (A-3e, 2026-09-12): state **version 9** — `media` (디스크 전시대 · 레코드랙 slots, `PlacedBook` shape) · `mediaDex`
 * (the disc · record dex) · `toggled` (a TV · record player left on). Only new fields appear, so a v8 save opens with them empty
 * and has no migration. The v8 refund 「a holder in a removed room → 함선 창고」 applies to discs and records just the same.
 */
/*
 * 조종석-only facilities · 조종석 decor furniture (2026-09-13, user's decision): state **version 10** — same shape.
 *  · The 시술대 · 컴퓨터 became `room: 'cockpit'` (조종석-only). One placed in another room is pulled into the 가구 창고 by the
 *    furniture rules first, and `ensureCockpitFurniture` puts it back in the 조종석 (default spot → auto-placement spot) —
 *    exactly one per ship. The rule runs on **every load**, whatever the version (a hand-edited v10 save gets the same answer).
 *  · The fixed props of the 조종석 (침상 · two 사물함 · 창고 캐비닛) became decor (`furn_bunk` · `furn_locker` ×2 · `furn_drawer`).
 *    Only a `version < 10` save gets them, once, at the old prop spots (`placeCockpitDecor`; a blocked spot goes to the 가구 창고) —
 *    those cells were `COCKPIT_BLOCKED_RECTS` until v9, so an old save always has them free. Once saved as v10, nothing is put back.
 */
/*
 * Cooking material tiers (2026-09-13, docs/DECISIONS.md 「2026-09-13 — 요리 재료 티어」): state **version 11** — only new fields appear:
 * `grows[].soilDurability` · `sockets`, `cultures[].mediumDurability` · `sockets` · `scaffoldDefId`, `analyses[].family` · `resultDefId` ·
 * `resultQty`, `analysisXp` · `analysisFound`. There is no refund and no migration path — moving an old `soilUsesLeft` ·
 * `mediumUsesLeft` into a durability needs the item table, so the runtime sanitizing does it (`parts/Garden.grows()` ·
 * `parts/Culture.cultures()`). ⚠ The point here is **not to drop a new field** (a slot is rebuilt field by field, so a field
 * that is not written silently disappears). `soilUsesLeft` · `mediumUsesLeft` may now be 0 as well.
 */
/*
 * Library series · video games (2026-09-13, docs/DECISIONS.md 「2026-09-13 — 서재 시리즈 · 비디오게임」): **the version was not raised** (still 12). The only new field
 * is `tvConsoles` (absent → an empty array); the rest are idempotent rules **every load** runs whatever the version — the same place as `ensureCockpitFurniture`:
 *  · The old item ids in `books` · `media` · `bookDex` · `mediaDex` · `tvConsoles` are swapped by `resolveItemAlias` (`data/item_aliases.csv`) (user's decision: an old
 *    per-skill book · disc · record → volume 1 of the new series). With nothing but swaps, `out.aliasedLibrary` (a save is scheduled — not treated as an edit).
 *  · One def takes **exactly one slot across all holder furniture** — in save order the first one stays and each extra goes to `out.refund` (함선 창고)
 *    (user's decision: the same book counts once).
 *  · `tvConsoles`: a placed TV · `console_*` shape · one per TV. Shape-valid with nowhere to stand → that console goes to `out.refund`.
 *  A refund sets `out.migratedLibrary` — written back at once like v7/v8, so the same extra is never handed back twice.
 * Several smokes (`smoke-housing` · `smoke-library`) read the version number as a literal — the reason a shape-preserving rule does not spend one.
 */
/*
 * Generator power (2026-09-13, docs/DECISIONS.md 「2026-09-13 — 가구 접근 면 · 발전기 · 암호화폐 채굴」): state **version 12** carried `powerAlloc` · `disabledFurniture` · `pausedAt`.
 */
/*
 * Generator = the build condition (2026-09-13, the same day, user's decision 「전력 할당 시스템 제거」): state **version 13**.
 *  · The power fields (`powerAlloc` · `disabledFurniture` · `pausedAt`) are **neither read nor written** — no clock is paused, so
 *    there is nothing to migrate (a paused slot runs on from its saved time the moment it is loaded).
 *  · The generator level is `GENERATOR_START_LEVEL` … `GENERATOR_MAX_LEVEL` (1 … 5) — Lv.0 → 1, an old Lv.6–10 → 5 **with no refund** (user's decision).
 *  · A room the generator is too low for (`purposeGeneratorLevel(purpose)`) is **removed and refunded in full** (user's decision):
 *    the same path as v8's 「removed room」 — build materials → 함선 창고 (`out.refund`), furniture → 가구 창고, its contents (books ·
 *    media · grow · analysis · culture slots · cores · consoles) → 함선 창고. It is a rule, so **every load** runs it (the generator
 *    never drops, so a v13 save never trips it again); `out.removedByGenerator` counts the removals.
 */
/**
 * Current on-disk version (14 since the sample level + the processor cell list, 2026-09-16; never below the contract's `SHIP_STATE_VERSION`).
 * v13 → v14 has no migration code (user's decision): without `sampleLevels` every sample is level 0, and an old
 * `clusters[].cores` is refunded into the 함선 창고 as the same number of **processors** (연산 코어 left the item table — `MiningRules.sanitizeClusters`).
 */
export const SHIP_STATE_VERSION_CURRENT = Math.max(14, SHIP_STATE_VERSION);
/** The most rooms read out of an old save (the room count was 10 back then, plus slack for a hand-edited file). */
const MAX_SAVED_ROOMS = 32;
/**
 * The 정비 벤치 moved out of the cockpit in Phase 8 and every profile was handed one, once (v1 → v2).
 * **2026-09-12 (user's decision): that piece is retired** — `retired=1` in `data/furniture.csv`, so `sanitize` sweeps out the
 * placed and the stored ones and refunds them as materials, and repairing a weapon in the ship is done from the inventory.
 * This id **keeps only its name** (this project only adds, like `airstrike` · `secondary`, and never deletes).
 */
export const REPAIR_BENCH_DEF_ID = 'furn_repair_bench';
export const GUN_BENCH_DEF_ID = 'furn_bench_gun';
export function storage(): Storage | null {
  try {
    const s = window.localStorage;
    const probe = '__scav_probe__';
    s.setItem(probe, '1'); s.removeItem(probe);
    return s;
  } catch { return null; }
}

export function freshRoom(): RoomState { return { purpose: 'empty', level: 0 }; }

/**
 * The rooms of a new ship (`SHIP_ROOM_COUNT` of them — 10 until v8, 2026-09-12): **all empty** (2026-09-07). The built-in
 * 작업실 of the Phase 8 UI pass is gone — the player assigns every purpose, 작업실 included, from 시설 관리 and pays
 * `ROOM_PURPOSE_BUILD_COST` for it.
 */
function freshRooms(): RoomState[] {
  return Array.from({ length: SHIP_ROOM_COUNT }, freshRoom);
}

export function freshState(): ShipState {
  const state: ShipState = {
    version: SHIP_STATE_VERSION_CURRENT,
    rooms: freshRooms(),
    generatorLevel: GENERATOR_START_LEVEL,     // 2026-09-13 (power allocation dropped): Lv.1 from the start, with nothing running
    storageLevel: 0,
    furniture: [],                            // 2026-09-07: no free 총기 작업대 / 정비 벤치 — both are crafted
    furnitureStorage: [],
    presets: [],
    plots: [],                                // what the retired 재배층 left behind — always an empty array (the greenhouse rework, 2026-09-11)
    nameLocked: false,
    books: [],
    bookDex: [],
    grows: [],
    analyses: [],                             // the lab's analyzer (v5, 2026-09-11)
    sampleDex: [],
    cultures: [],                             // the greenhouse culture tank (v6, A-14, 2026-09-11)
    media: [],                                // library media (v9, A-3e, 2026-09-12)
    mediaDex: [],
    toggled: [],
    analysisXp: {},                           // cooking material tiers (v11, 2026-09-13)
    analysisFound: [],
    sampleLevels: {},                         // the sample rework (v14, 2026-09-16 — 표본 def id → analysis level)
    tvConsoles: [],                           // video games (2026-09-13 — the console attached to each TV)
    plate: null,                              // the dining-table plate (2026-09-16 — a meal is not an item)
  };
  ensureCockpitFurniture(state);             // 2026-09-12: the two shared facility pieces of the 조종석 (f-1 시술대 · f-2 컴퓨터)
  placeCockpitDecor(state);                   // 2026-09-13: 조종석 decor furniture (f-3 침상 · f-4 / f-5 사물함 · f-6 서랍장)
  return state;
}

/**
 * 2026-09-13 (user's decision): places the 조종석 decor furniture (`COCKPIT_DECOR_FURNITURE` — 침상 · two 사물함 · 서랍장 at the old
 * prop spots) **once**. Only a new ship (`freshState`) and a pre-v10 save (the v10 block of `sanitize`) call it, so a recovered
 * piece is never put back. A blocked spot (a hand-edited save) is not dropped but goes to the 가구 창고. True if anything landed.
 */
export function placeCockpitDecor(state: ShipState): boolean {
  let changed = false;
  for (const spot of COCKPIT_DECOR_FURNITURE) {
    const def = FURNITURE_DEF_MAP.get(spot.defId);
    if (!def || def.retired) continue;
    if (canPlaceAt(state, COCKPIT_ROOM_INDEX, def, spot.x, spot.y, spot.yaw)) {
      state.furniture.push({ uid: `f-${maxUidIndex(state.furniture) + 1}`, defId: def.id, room: COCKPIT_ROOM_INDEX, x: spot.x, y: spot.y, yaw: spot.yaw, level: 1 });
    } else {
      console.warn(`[housing] cockpit decor '${def.id}' does not fit at (${spot.x}, ${spot.y}) — put into furniture storage`);
      const e = state.furnitureStorage.find((s) => s.defId === def.id && s.level === 1);
      if (e) e.qty += 1; else state.furnitureStorage.push({ defId: def.id, level: 1, qty: 1 });
    }
    // set **after** both branches ran: the contract is 「something landed」, and only a branch that placed or stored a piece may claim it
    changed = true;
  }
  return changed;
}

/**
 * 2026-09-13 (placement rules): moves the decor furniture of the 조종석 (everything that is not a 조종석-only facility) into the
 * 가구 창고 — with `rect` given, only the pieces whose body overlaps that rectangle. Called only when `ensureCockpitFurniture` makes
 * room for a facility. The 조종석 takes `any` furniture only, so nothing in it has contents (grow slots · books).
 */
function evictCockpitDecor(state: ShipState, rx?: number, ry?: number, rcols?: number, rrows?: number): void {
  for (let i = state.furniture.length - 1; i >= 0; i--) {
    const f = state.furniture[i];
    const def = FURNITURE_DEF_MAP.get(f.defId);
    if (f.room !== COCKPIT_ROOM_INDEX || !def || isCockpitOnlyFurniture(def)) continue;
    if (rx !== undefined && ry !== undefined && rcols !== undefined && rrows !== undefined) {
      const fp = furnitureFootprint(def, f.yaw);
      if (!(f.x < rx + rcols && rx < f.x + fp.cols && f.y < ry + rrows && ry < f.y + fp.rows)) continue;
    }
    state.furniture.splice(i, 1);
    const e = state.furnitureStorage.find((s) => s.defId === f.defId && s.level === f.level);
    if (e) e.qty += 1; else state.furnitureStorage.push({ defId: f.defId, level: f.level, qty: 1 });
  }
}

/**
 * 2026-09-12 (user's decision): the shared facility furniture (`COCKPIT_DEFAULT_FURNITURE` — 전술 임플란트 시술대 · 기업 네트워크
 * 컴퓨터) **cannot be lost.** Anything neither placed (in any room) nor in the 가구 창고 is filled in at its default spot in the
 * 조종석 → if that is blocked, at the auto-placement spot (`Rules.autoPlaceSpot`) → failing that, as one Lv.1 piece in the 가구 창고.
 * A new ship and **every load** run it; true when anything was filled in. The coordinates are only read from the contract's
 * table (hub may correct them against the 조종석 props).
 */
export function ensureCockpitFurniture(state: ShipState): boolean {
  let changed = false;
  for (const spot of COCKPIT_DEFAULT_FURNITURE) {
    const def = FURNITURE_DEF_MAP.get(spot.defId);
    if (!def || def.retired) continue;
    let level = 1;
    if (isCockpitOnlyFurniture(def)) {
      /* 2026-09-13 (user's decision): a 조종석-only facility is **exactly one piece in the 조종석**. The first one placed in the 조종석
         is kept; every other placement (another room · a second piece) and the copies in the 가구 창고 are swept out — the furniture
         cannot be crafted, so there is nothing to hand back. With none in the 조종석 one is taken out of the 가구 창고 and placed in
         the 조종석 below (at the highest level found). */
      const keep = state.furniture.find((f) => f.defId === def.id && f.room === COCKPIT_ROOM_INDEX) ?? null;
      for (let i = state.furniture.length - 1; i >= 0; i--) {
        const f = state.furniture[i];
        if (f.defId !== def.id || f === keep) continue;
        level = Math.max(level, f.level);
        state.furniture.splice(i, 1);
        changed = true;
      }
      for (let i = state.furnitureStorage.length - 1; i >= 0; i--) {
        const s = state.furnitureStorage[i];
        if (s.defId !== def.id) continue;
        if (s.qty > 0) level = Math.max(level, s.level);
        state.furnitureStorage.splice(i, 1);
        changed = true;
      }
      if (keep) continue;
    } else {
      // (a shared piece put back by csv follows the old rule: it only has to exist somewhere — the 가구 창고 counts)
      const owned = state.furniture.some((f) => f.defId === def.id) || state.furnitureStorage.some((s) => s.defId === def.id && s.qty > 0);
      if (owned) continue;
    }
    changed = true;
    level = Math.min(level, Math.max(1, def.maxLevel));
    const fits = (): { x: number; y: number; yaw: 0 | 1 | 2 | 3 } | null =>
      canPlaceAt(state, COCKPIT_ROOM_INDEX, def, spot.x, spot.y, spot.yaw) ? { x: spot.x, y: spot.y, yaw: spot.yaw } : null;
    let at = fits() ?? autoPlaceSpot(state, COCKPIT_ROOM_INDEX, def);
    /* 2026-09-13 (placement rules): a 조종석-only facility must not end up in the 가구 창고 (it cannot be recovered, so there is no way
       to place it again). With the default spot and the auto-placement spot both blocked, the decor around the default spot (body
       + 1 cell) moves to the 가구 창고 first, and failing that all decor of the 조종석 does, then it looks again. */
    if (!at) {
      const fp = furnitureFootprint(def, spot.yaw);
      evictCockpitDecor(state, spot.x - 1, spot.y - 1, fp.cols + 2, fp.rows + 2);
      at = fits();
      if (!at) { evictCockpitDecor(state); at = fits() ?? autoPlaceSpot(state, COCKPIT_ROOM_INDEX, def); }
      if (at) console.warn(`[housing] cockpit decor moved to furniture storage to make room for '${def.id}'`);
    }
    if (at) {
      state.furniture.push({ uid: `f-${maxUidIndex(state.furniture) + 1}`, defId: def.id, room: COCKPIT_ROOM_INDEX, x: at.x, y: at.y, yaw: at.yaw, level });
    } else {
      console.warn(`[housing] no cockpit spot for '${def.id}' — put into furniture storage`);
      state.furnitureStorage.push({ defId: def.id, level, qty: 1 });
    }
  }
  return changed;
}

/**
 * A 재배층 (the retired stackable rack). Kept so an old save / an old caller can still ask; nothing is ever placed
 * with this def any more (`sanitize` sweeps it out as a `retired` def).
 * @deprecated 2026-09-11 (온실 개편) — use `isGrowStationDefId`.
 */
export function isGrowRackDefId(defId: string): boolean {
  return FURNITURE_DEF_MAP.get(defId)?.interaction === 'grow_rack';
}

/** A 재배 스테이션 (the greenhouse rework, 2026-09-11): the furniture whose E opens the grow-station screen. */
export function isGrowStationDefId(defId: string): boolean {
  return FURNITURE_DEF_MAP.get(defId)?.interaction === 'grow_station';
}

/** Retired furniture? (the `retired` column of `data/furniture.csv`) — it is left in no list, no craft, no placement, no save. */
export function isRetiredDefId(defId: string): boolean {
  return FURNITURE_DEF_MAP.get(defId)?.retired === true;
}

/** An analyzer (the lab, 2026-09-11): the furniture whose E opens the analysis screen. */
export function isAnalyzerDefId(defId: string): boolean {
  return FURNITURE_DEF_MAP.get(defId)?.interaction === 'analyzer';
}

/** A culture tank (A-14, 2026-09-11): the furniture whose E opens the culture screen. */
export function isCultureTankDefId(defId: string): boolean {
  return FURNITURE_DEF_MAP.get(defId)?.interaction === 'culture_tank';
}

/**
 * 2026-09-16 (the plate model): the saved dining-table plate — an id the meal table knows · a quality integer 0 … `MEAL_QUALITY_MAX` ·
 * the time it was served (finite ≥ 0, else 0). A wrong shape reads as no plate (the meal items of an old save are not migrated — user's decision).
 */
export function sanitizePlate(raw: unknown): DiningPlate | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = raw as Partial<DiningPlate>;
  if (typeof p.mealDefId !== 'string' || !getMealDef(p.mealDefId)) return null;
  const at = typeof p.cookedAt === 'number' && Number.isFinite(p.cookedAt) && p.cookedAt > 0 ? p.cookedAt : 0;
  return { mealDefId: p.mealDefId, quality: normalizeMealQuality(p.quality), cookedAt: at };
}

/** A dining table (A-3c, 2026-09-11): the furniture whose E opens the dining screen. The shared ship's fixed table has no uid. */
export function isDiningTableDefId(defId: string): boolean {
  return FURNITURE_DEF_MAP.get(defId)?.interaction === 'dining_table';
}

/** Shape check of a 표본 def id in a save (`spec_*`); whether it is a real 표본 is a runtime check via `ctx.loot`. */
const isSampleDefIdShape = (v: unknown): v is string => typeof v === 'string' && /^spec_[A-Za-z0-9_]{1,40}$/.test(v);

/**
 * Shape check of a 배지 · 세포주 def id in a save. Unlike 표본(`spec_*`) · 토양(`soil_*`) · 서적(`book_*`) these two
 * carry **no id prefix of their own** (`mat_medium_*` · `strain_*` are `material` ids like any other), so the shape
 * check only keeps out obvious junk — whether the id is a real `ItemDef.medium` / `ItemDef.strain` is the runtime
 * prune in `parts/Culture.cultures()` (the same contract as the library · greenhouse · lab).
 */
const isItemDefIdShape = (v: unknown): v is string => typeof v === 'string' && /^[a-z][A-Za-z0-9_]{1,48}$/.test(v);

/** v11: a finite, non-negative number from a save (else null — `null` / strings are not numbers here). */
const nonNegNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * v11: the socket id list — item-id shapes only, at most `GROW_SOCKET_SLOTS_MAX` of them (two of the same socket are fine).
 * Whether a socket is real, whether it fits its target and whether it stays inside the slot count of the soil · medium grade is
 * left to the runtime sanitizing (`parts/Sockets.sanitizeSocketIds`). Not an array → undefined (no field).
 */
function socketIdsOf(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter(isItemDefIdShape).slice(0, GROW_SOCKET_SLOTS_MAX);
}

/** Shape check of a soil def id in a save (`soil_<tag>`); whether it is a real 토양 is a runtime check via `ctx.loot`. */
const isSoilDefIdShape = (v: unknown): v is string => typeof v === 'string' && /^soil_[A-Za-z0-9_]{1,40}$/.test(v);

/** What `sanitize` found that the caller has to settle outside the pure function. */
export interface SanitizeOutcome {
  /**
   * Materials owed for every `retired` furniture the save still carried (placed + stored, craft cost + the upgrade
   * levels it had reached). `HousingSystem` drops them into the 함선 창고 once `ctx.inventory` is around.
   */
  refund: CraftIngredient[];
  /**
   * 2026-09-12 (v7): the save carried a 작업실 / 사격장 above level 1 and `sanitize` moved or refunded it. The caller
   * writes the migrated state back soon, so a stale copy elsewhere never re-runs it.
   */
  migratedRoomLevels?: boolean;
  /**
   * 2026-09-12 (v8): the save carried a room `sanitize` removed and refunded — index ≥ `SHIP_ROOM_COUNT` (방 9 · 10) or a
   * purpose that can no longer be built (시뮬레이션실 · 휴식 공간). Written back soon, like `migratedRoomLevels`.
   */
  migratedRooms?: boolean;
  /**
   * 2026-09-12: `ensureCockpitFurniture` had to put back a 공용 시설 가구 the save did not have anywhere. The caller saves
   * the result but does not treat it as an edit newer than the server copy (the server copy gets the same grant).
   */
  grantedCockpit?: boolean;
  /**
   * 2026-09-13 (v10): a pre-v10 save got the 조종석 꾸밈 가구 (`placeCockpitDecor`). Written back soon, like `migratedRooms` —
   * once stored as v10 the decor is never placed again, so a piece the player recovers stays recovered.
   */
  migratedCockpit?: boolean;
  /**
   * 2026-09-13 (v13 — power allocation dropped, user's decision): how many facilities were removed because the generator level
   * fell short of `purposeGeneratorLevel(purpose)`. Those rooms count as `migratedRooms` too and are written back soon (build
   * materials and contents into `refund`, furniture into the 가구 창고); this number is only there for the caller's one notice.
   */
  removedByGenerator?: number;
  /**
   * 2026-09-13 (placement rules, user's decision): how many pieces were moved **into the 가구 창고** for breaking the access-face
   * rule (조종석-only facilities excluded). Their contents are in `refund`.
   * The caller notifies once and writes the result back.
   */
  evictedByAccess?: number;
  /**
   * 2026-09-13 (library series · video games): `sanitize` **handed something back to the 함선 창고** — an extra copy of a def that
   * was shelved in two or more holders (including one created by an id swap, user's decision 「같은 책은 한 권만 센다」), or the console
   * of an unplaced TV / a second console on one TV. It is in `refund`. Written back at once like `migratedRooms` (without that,
   * the next load hands the same extra back again).
   */
  migratedLibrary?: boolean;
  /**
   * 2026-09-13: old library item ids (`data/item_aliases.csv`) were swapped for new ones and nothing was handed back — the swap
   * is idempotent, so it does not count as an edit and only schedules a save (like `grantedCockpit`).
   */
  aliasedLibrary?: boolean;
}

/** 2026-09-13: the **shape** of a console def id mounted on a TV (`console_*`). Whether it is a real console is a runtime check (`parts/VideoGame`). */
const isConsoleDefIdShape = (v: unknown): v is string => typeof v === 'string' && /^console_[A-Za-z0-9_]{1,40}$/.test(v);

/** 2026-09-13: runs a save's item id through the old-id alias table — a non-string is left alone (the shape check drops it). `changed` is called only when it changed. */
function aliasOf(v: unknown, changed: () => void): unknown {
  if (typeof v !== 'string') return v;
  const id = resolveItemAlias(v);
  if (id !== v) changed();
  return id;
}

/** A 책장 (Phase 9: any furniture whose E opens the bookshelf panel). */
export function isBookshelfDefId(defId: string): boolean {
  return FURNITURE_DEF_MAP.get(defId)?.interaction === 'bookshelf';
}

/** Shape check of a book def id in a save (`book_<skill>`); whether it is a real 서적 is decided at runtime via `ctx.loot`. */
const isBookDefIdShape = (v: unknown): v is string => typeof v === 'string' && /^book_[A-Za-z0-9_]{1,40}$/.test(v);

const int = (v: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};
const yaw = (v: unknown): 0 | 1 | 2 | 3 => (int(v, 0, 0, 3) as 0 | 1 | 2 | 3);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** Highest `f-<n>` index in a furniture list (0 when none). */
export function maxUidIndex(furniture: readonly PlacedFurniture[]): number {
  let max = 0;
  for (const f of furniture) {
    const m = /^f-(\d+)$/.exec(f.uid);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/**
 * Turn whatever was in localStorage into a valid ShipState: unknown furniture defs / purposes / out-of-range numbers
 * are dropped or clamped, duplicated uids re-minted, stack layers re-assigned, plots without a rack dropped.
 * Migrations: **v1 → v2** granted the 정비 벤치 that moved out of the cockpit; **nothing has been granted since 2026-09-12**
 * (that piece is retired — see the comment at that spot below). **v3** adds `books` / `bookDex` (Phase 9): a book needs a
 * placed 책장 uid, a slot below `BOOKS_PER_SHELF`, one book per (uid, slot) and a `book_*`-shaped def id; the 도감 is
 * a unique list of such ids. Whether an id still resolves to a 서적 is checked by `HousingSystem` once `ctx.loot`
 * exists. 2026-09-07: the room-1 작업실 invariant is gone — the only room rule left is "at most one facility room of
 * each kind"; furniture whose room no longer accepts it moves into furniture storage instead of being dropped.
 * **v4 (the greenhouse rework, 2026-09-11)**: every `retired` def (today the old 재배층 `furn_grow_rack`) is swept out — placed
 * and stored alike — and what it cost is accumulated into `out.refund` for the caller to pay into the 함선 창고. The old
 * `plots` are dropped wholesale (user's decision: the old ones are scrapped) and the new `grows` are validated against the grow
 * station that owns them (placed uid · tier its current level opens · slot in range · soil id shape).
 * **v5 (the lab, 2026-09-11)**: `analyses` (analyzer slots — a placed analyzer uid · slot inside `analyzerSlotsForLevel`
 * of its **current** level · one per (uid, slot) · `spec_*` id shape · a real `startedAt`) and `sampleDex` (unique
 * `spec_*` ids). A v4 save simply opens with both empty — nothing is dropped, so there is no refund path.
 * **v6 (the culture tank, A-14, 2026-09-11)**: `cultures` (culture slots — a placed culture-tank uid · slot inside
 * `cultureSlotsForLevel` of its **current** level · one per (uid, slot) · an item-id-shaped medium · the strain fields only
 * together with a real `startedAt`). Again only new fields appear, so there is no migration and no refund path.
 */
export function sanitize(raw: unknown, out?: SanitizeOutcome): ShipState {
  const fresh = freshState();
  if (out) out.refund = [];
  if (!raw || typeof raw !== 'object') return fresh;
  const r = raw as Partial<ShipState> & Record<string, unknown>;
  const version = int(r.version, 0);
  if (version > SHIP_STATE_VERSION_CURRENT) console.warn(`[housing] ship state v${version} is newer than v${SHIP_STATE_VERSION_CURRENT} — loading best-effort`);

  const rooms: RoomState[] = [];
  /** v7: what each **source** room's level said before the room levels went away (dropped rooms included). */
  const rawRoomLevels: number[] = [];
  /** v7: each source room's purpose as the save had it (the v8 removal below empties some of them). */
  const rawPurposes: RoomPurpose[] = [];
  /**
   * v8 (2026-09-12, user's decision 「전부 제거 + 환불」): source rooms `sanitize` removes — index ≥ `SHIP_ROOM_COUNT` (방 9 · 10)
   * with a facility, and any room whose purpose can no longer be built (시뮬레이션실 · 휴식 공간 — `ROOM_PURPOSES_ASSIGNABLE`).
   * The build cost goes into `refund`, the room's pieces into furniture storage (below).
   */
  const removedRooms = new Set<number>();
  /** The materials retired furniture · a removed room owes back: collected in one bag for the caller to put into the 함선 창고. */
  const refund: CraftIngredient[] = [];
  /* v13 (2026-09-13, user's decision — power allocation dropped): the generator level is read **before** the rooms — a facility
     the level falls short of has to be swept out down the same path as v8's 「removed room」 (build materials → `refund`, furniture
     → 가구 창고, contents → `refund`). Lv.0 (an old new ship) → the start level, an old Lv.6–10 → the max (no refund). */
  const generatorLevel = int(r.generatorLevel, GENERATOR_START_LEVEL, GENERATOR_START_LEVEL, facilityMaxLevel('generator'));
  /** v13: how many facilities were removed for a generator level that fell short (`out.removedByGenerator`). */
  let removedByGenerator = 0;
  const srcRooms = Array.isArray(r.rooms) ? r.rooms.slice(0, MAX_SAVED_ROOMS) : [];
  /** Source room slots the furniture pass still recognises (a 10-room save keeps pieces of 방 9 · 10). */
  const roomSlots = Math.max(SHIP_ROOM_COUNT, srcRooms.length);
  for (let i = 0; i < roomSlots; i++) {
    const s = srcRooms[i] as Partial<RoomState> | undefined;
    const purpose = isRoomPurpose(s?.purpose) ? s!.purpose! : 'empty';
    rawPurposes.push(purpose);
    rawRoomLevels.push(purpose === 'empty' ? 0 : int(s?.level, 1, 1, 99));
    const buildable = i < SHIP_ROOM_COUNT && ROOM_PURPOSES_ASSIGNABLE.includes(purpose);
    const underGenerator = purpose !== 'empty' && buildable && generatorLevel < purposeGeneratorLevel(purpose);
    const gone = purpose !== 'empty' && (!buildable || underGenerator);
    if (gone) {
      removedRooms.add(i);
      mergeCost(refund, roomRefundCost(purpose, 1));   // the facility build price (legacy room levels: the v7 block below)
      if (underGenerator) {
        removedByGenerator++;
        console.warn(`[housing] room ${i + 1} (${ROOM_PURPOSE_LABEL_KO[purpose]}) needs 발전기 Lv.${purposeGeneratorLevel(purpose)} (ship Lv.${generatorLevel}) — removed, build cost refunded, furniture to storage`);
      } else {
        console.warn(`[housing] room ${i + 1} (${purpose}) removed — build cost refunded, furniture to storage`);
      }
    }
    if (i >= SHIP_ROOM_COUNT) continue;
    // 2026-09-12: a room facility has no level — 1 with a purpose, 0 for an empty room (`Rules.facilityMaxLevel` is 1)
    rooms.push(gone || purpose === 'empty' ? freshRoom() : { purpose, level: 1 });
  }
  // 2026-09-07: the 작업실 is an ordinary purpose again — any room may hold it (one per ship, `purposeChangeReason`),
  // and a ship may hold none at all. A save made under the room-1 rule keeps its 작업실 exactly where it is.
  // The ship still holds at most one of each facility room: an edited save with two keeps the first.
  const seenFacility = new Set<string>();
  for (let i = 0; i < rooms.length; i++) {
    const fid = facilityPurposeOf(rooms[i].purpose);
    if (!fid) continue;
    if (seenFacility.has(fid)) rooms[i] = freshRoom(); else seenFacility.add(fid);
  }
  // a room without its prerequisite greenhouse (edited save) falls back to empty (`Rules.NEEDS_GREENHOUSE` is the source)
  // 2026-09-14 (user's decision): that list is empty, so this fallback touches no room at all — purpose prerequisites dropped.
  // This was the path that made a lab · kitchen built without a greenhouse disappear on load.
  if (!rooms.some((x) => x.purpose === 'greenhouse')) {
    for (const x of rooms) if (NEEDS_GREENHOUSE.includes(x.purpose)) { x.purpose = 'empty'; x.level = 0; }
  }

  const storageLevel = int(r.storageLevel, 0, 0, facilityMaxLevel('storage'));

  // placed furniture: every piece must pass the real placement rule against what was accepted before it
  // (known def, existing room, inside the grid, purpose match, no overlap) — anything else is dropped, not clamped
  const furniture: PlacedFurniture[] = [];
  const partial: ShipState = { ...fresh, rooms, furniture };
  const seen = new Set<string>();
  const pending: PlacedFurniture[] = [];
  /** Pieces whose room lost the purpose they need (room-1 migration, edited save): recovered, never destroyed. */
  const displaced: StoredFurniture[] = [];
  /** v8: uids of the displaced pieces — a displaced 책장's books go back to the 함선 창고 (below), like `recover` does. */
  const displacedUids = new Set<string>();
  /** v9 (A-3e): displaced uid → the shelf medium it held (a displaced 디스크 전시대 · 레코드랙 refunds its media the same way). */
  const displacedShelf = new Map<string, ShelfMedium>();
  /** 2026-09-13 (placement rules): how many pieces moved to the 가구 창고 for breaking the access-face rule (a 조종석-only facility is not counted — it stands in the 조종석 again right away). */
  let evictedByAccess = 0;
  for (const f of Array.isArray(r.furniture) ? (r.furniture as Partial<PlacedFurniture>[]) : []) {
    if (!f || typeof f.defId !== 'string') continue;
    const def = FURNITURE_DEF_MAP.get(f.defId);
    if (!def) { console.warn(`[housing] unknown furniture '${f.defId}' dropped`); continue; }
    if (def.retired) {
      // the greenhouse rework (2026-09-11): retired furniture is swept off the ship and its price handed back as materials (user's decision: the old ones are scrapped)
      mergeCost(refund, furnitureRefundCost(def, int(f.level, 1, 1, furnitureMaxLevel(def))));
      console.warn(`[housing] retired furniture '${def.id}' removed from the ship — refunded as materials`);
      continue;
    }
    const room = int(f.room, -1, -1);
    const item: PlacedFurniture = {
      uid: typeof f.uid === 'string' ? f.uid : '',
      defId: def.id, room,
      x: int(f.x, -1, -1), y: int(f.y, -1, -1),
      yaw: yaw(f.yaw), level: int(f.level, 1, 1, furnitureMaxLevel(def)),
    };
    /* v8 (2026-09-12): a piece of a room that no longer exists (방 9 · 10) or was removed (시뮬레이션실 · 휴식 공간) goes to
       furniture storage — never the bin — and so does one whose room / the cockpit no longer accepts it. */
    const lostRoom = removedRooms.has(room) || (room >= SHIP_ROOM_COUNT && room < roomSlots && room !== COCKPIT_ROOM_INDEX);
    const hereRoom: RoomPurpose | null = room === COCKPIT_ROOM_INDEX ? 'cockpit' : room >= 0 && room < SHIP_ROOM_COUNT ? rooms[room].purpose : null;
    if (lostRoom || (hereRoom !== null && !furnitureAllowedIn(def, hereRoom))) {
      displaced.push({ defId: def.id, level: item.level, qty: 1 });
      if (item.uid) displacedUids.add(item.uid);
      const shelfM = shelfMediumOfInteraction(def.interaction);
      if (item.uid && shelfM) displacedShelf.set(item.uid, shelfM);
      continue;
    }
    /*
     * ⚠ This check is a **drop, not a clamp** — a piece that does not fit vanishes instead of going to storage. So before
     * touching the grid dimensions, ask 「are all the old coordinates still valid」 first.
     *
     * 2026-09-12 (`ROOM_GRID_COLS/ROWS` 8 → 16, a room 4 × 4 → 8 × 8 m): **the version was not raised.** `PlacedFurniture.x/y`
     * are integers whose origin is the top-left (the room's min-x / min-z corner), so as long as the grid **only grows** an old
     * coordinate does not change meaning by one digit. Of the three conditions `canPlaceAt` applies, purpose and overlap do not
     * depend on the grid size, and the last one `insideGrid` (`x + cols ≤ COLS`, `y + rows ≤ ROWS`) **only loosens** — every
     * placement that passed at 8 cells passes at 16. Furniture stands where it stood (the top-left corner of the screen) and the
     * rest of the room opens up as free space. A change that **shrinks** the grid does need a v migration (things evaporate here).
     */
    // `canPlaceAt` answers "is this a place at all" too (a room index or `COCKPIT_ROOM_INDEX` — 2026-09-12)
    const block = placementBlockOf(partial, room, def, item.x, item.y, item.yaw);
    if (block?.kind === 'access') {
      /* 2026-09-13 (user's decision — placement rules): an old placement that breaks only the access-face rule is not dropped but
         moved **into the 가구 창고**. Pieces are checked in save order, so the one accepted first wins. Its contents (grow · analysis ·
         culture slots · books · media) are handed back to the 함선 창고 by each block below, which reads `displacedUids` — a mining
         cluster's cores may read the same set. A 조종석-only facility is stood up in the 조종석 again by `ensureCockpitFurniture` below. */
      console.warn(`[housing] '${def.id}' at room ${room} (${item.x}, ${item.y}) breaks the access rule (${block.reason}) — moved to furniture storage`);
      displaced.push({ defId: def.id, level: item.level, qty: 1 });
      if (item.uid) displacedUids.add(item.uid);
      const shelfM = shelfMediumOfInteraction(def.interaction);
      if (item.uid && shelfM) displacedShelf.set(item.uid, shelfM);
      if (!isCockpitOnlyFurniture(def)) evictedByAccess++;
      continue;
    }
    if (block) {
      console.warn(`[housing] '${def.id}' at room ${room} (${item.x}, ${item.y}) does not fit — dropped`);
      continue;
    }
    // stacked furniture: keep the persisted layer when it is free, otherwise drop the piece onto the lowest free one
    const limit = stackLimitOf(def);
    if (limit > 1) {
      const members = stackMembers(partial, room, def, item.x, item.y, item.yaw);
      const want = int(f.layer, 0, 0, limit - 1);
      item.layer = members.some((m) => (m.layer ?? 0) === want) ? nextFreeLayer(members, limit) : want;
      if (item.layer < 0) { console.warn(`[housing] '${def.id}' stack at room ${room} (${item.x}, ${item.y}) is full — dropped`); continue; }
    }
    if (!/^f-\d+$/.test(item.uid) || seen.has(item.uid)) pending.push(item);
    else seen.add(item.uid);
    furniture.push(item);
  }
  let next = maxUidIndex(furniture.filter((f) => !pending.includes(f)));
  for (const item of pending) item.uid = `f-${++next}`;

  const furnitureStorage: StoredFurniture[] = [];
  for (const s of [...(Array.isArray(r.furnitureStorage) ? (r.furnitureStorage as Partial<StoredFurniture>[]) : []), ...displaced]) {
    if (!s || typeof s.defId !== 'string') continue;
    const def = FURNITURE_DEF_MAP.get(s.defId);
    if (!def) continue;
    const level = int(s.level, 1, 1, furnitureMaxLevel(def));
    const qty = int(s.qty, 0, 0);
    if (qty <= 0) continue;
    if (def.retired) { mergeCost(refund, furnitureRefundCost(def, level), qty); continue; }
    const existing = furnitureStorage.find((e) => e.defId === def.id && e.level === level);
    if (existing) existing.qty += qty; else furnitureStorage.push({ defId: def.id, level, qty });
  }
  /*
   * v1 → v2 used to **grant one 정비 벤치** here (`furn_repair_bench`, the piece that came out of the cockpit). When that
   * furniture retired on 2026-09-12 (user's decision) the grant became **worse than waste — a bug**: both places that sweep
   * retired furniture out (placed · stored) sit **above** this line, so a piece pushed in here is not filtered and stays in the
   * 가구 창고 as retired furniture (it shows in `getStored()`, and its def is not in the list when placing it). So the grant was
   * swept out — a v1 save now gets nothing, and a save that already held the bench gets `sanitize`'s refund instead.
   * `REPAIR_BENCH_DEF_ID` keeps only its name (the comment above).
   */

  /* v6 → v7 (2026-09-12, user's decision — room facility levels removed): migrated at no loss.
     · 사격장 Lv.n (n ≥ 2) → the level is given to the **관물대 · 시뮬레이션 허브** (a placed piece takes it as its max, a piece only
       in storage raises its highest copy to it). With neither on the ship, the materials the old upgrade cost are refunded.
     · 작업실 Lv.n (n ≥ 2) → the craft discount is gone, so there is nowhere to move it — the old upgrade materials are refunded.
     A refund goes into the same `refund` bag as retired furniture and `HousingSystem` puts it into the 함선 창고. The levels are
     already down to 1 above, so nothing runs again once the save is stored as v7. */
  /* v8 (2026-09-12, the same day): the 관물대 · 시뮬레이션 허브 **retired**. The migration above has nowhere left to go — retired
     furniture is already filtered out by the sweep and is in neither `furniture` nor `furnitureStorage`, so a 사격장 Lv.n always
     refunds the materials spent. A level a v7-stored save moved onto the 관물대 · 허브 is refunded by the retired sweep together
     with the upgrade cost up to that level (`furnitureRefundCost`). */
  let migratedRoomLevels = false;
  if (version < 7) {
    // the first source room of that purpose — v8 may already have emptied it, so read the raw list, not `rooms`
    const legacyLevel = (p: 'workshop' | 'range'): number => {
      const i = rawPurposes.indexOf(p);
      return i < 0 ? 0 : rawRoomLevels[i] ?? 0;
    };
    const rangeLv = legacyLevel('range');
    if (rangeLv > 1) {
      migratedRoomLevels = true;
      mergeCost(refund, legacyRoomLevelCost('range', rangeLv));
    }
    const workshopLv = legacyLevel('workshop');
    if (workshopLv > 1) {
      migratedRoomLevels = true;
      mergeCost(refund, legacyRoomLevelCost('workshop', workshopLv));
    }
    if (migratedRoomLevels) console.warn(`[housing] v${version} room levels (작업실 ${workshopLv} · 사격장 ${rangeLv}) moved to furniture / refunded`);
  }

  const presets: (LoadoutPreset | null)[] = [];
  for (const p of Array.isArray(r.presets) ? (r.presets as (Partial<LoadoutPreset> | null)[]) : []) {
    if (!p || typeof p !== 'object') { presets.push(null); continue; }
    const implant = strOrNull(p.implant);
    presets.push({
      name: typeof p.name === 'string' ? p.name.slice(0, 24) : '프리셋',
      primary: strOrNull(p.primary), primary2: strOrNull(p.primary2), secondary: strOrNull(p.secondary),
      bag: strOrNull(p.bag), armor: strOrNull(p.armor),
      implant: implant && (IMPLANT_IDS as readonly string[]).includes(implant) ? (implant as LoadoutPreset['implant']) : null,
      // appended (2026-09-08): implant item def ids. Absent in an older save → left undefined, which `applyLoadout`
      // reads as "leave the equipped implants alone" (an empty array means "take everything off").
      ...(Array.isArray(p.implantItems)
        ? { implantItems: (p.implantItems as unknown[]).filter((d): d is string => typeof d === 'string' && !!d).slice(0, 16) }
        : {}),
    });
  }

  /* The greenhouse rework (2026-09-11): the 재배층 `plots` are gone with the furniture they belonged to — user's decision
     「옛 것 폐기」. The field stays in the contract (an add-only contract) and is written back empty. */

  // 재배 스테이션 칸: the station must still be placed, its level must open the tier, the slot must be in range,
  // one entry per (uid, tier, slot), and the soil id must at least *look* like a 토양 (the real def check is a
  // runtime prune in `parts/Garden.grows()`, exactly like the 서재 does with its books).
  /**
   * 2026-09-13 (placement rules): the items one slot of a piece moved to the 가구 창고 (`displacedUids`) was holding → `refund`
   * (함선 창고). Once per slot key, and only for item-id shapes. Soil · medium come back new, a planted seed · an inserted strain ·
   * a sample come back as they were before they went in (not a grown crop, not an analysis result).
   */
  const refundedSlots = new Set<string>();
  const refundSlotOnce = (key: string, ids: readonly unknown[]): void => {
    if (refundedSlots.has(key)) return;
    refundedSlots.add(key);
    for (const id of ids) if (isItemDefIdShape(id)) mergeCost(refund, [{ defId: id, qty: 1 }]);
  };
  const grows: GrowSlot[] = [];
  const stationLevel = new Map<string, number>();
  for (const f of furniture) if (isGrowStationDefId(f.defId)) stationLevel.set(f.uid, f.level);
  const takenGrowSlots = new Set<string>();
  for (const g of Array.isArray(r.grows) ? (r.grows as Partial<GrowSlot>[]) : []) {
    if (!g || typeof g.uid !== 'string' || !isSoilDefIdShape(g.soilDefId)) continue;
    const level = stationLevel.get(g.uid);
    if (level === undefined) {
      if (displacedUids.has(g.uid)) {
        refundSlotOnce(`g#${g.uid}#${g.tier}#${g.slot}`, [g.soilDefId, int(g.plantedAt, 0, 0) > 0 ? g.seedDefId : null, ...(socketIdsOf(g.sockets) ?? [])]);
      }
      continue;
    }
    const tier = int(g.tier, -1, -1) as GrowTier;
    if (tier !== 0 && tier !== 1 && tier !== 2) continue;
    if (!growTierOpen(level, tier)) continue;
    const slot = int(g.slot, -1, -1);
    if (slot < 0 || slot >= GROW_SLOTS_PER_TIER) continue;
    const key = `${g.uid}#${tier}#${slot}`;
    if (takenGrowSlots.has(key)) continue;
    takenGrowSlots.add(key);
    const entry: GrowSlot = {
      uid: g.uid, tier, slot, soilDefId: g.soilDefId,
      // v11: it counts 「harvests left until 0」, so 0 is allowed too (an old save was ≥ 1)
      soilUsesLeft: int(g.soilUsesLeft, 1, 0),
    };
    // v11 (2026-09-13): soil durability · sockets — not dropped (the runtime sanitizing trims the max and the slot count)
    const soilDur = nonNegNum(g.soilDurability);
    if (soilDur !== null) entry.soilDurability = soilDur;
    const soilSockets = socketIdsOf(g.sockets);
    if (soilSockets) entry.sockets = soilSockets;
    // planting fields come and go together: a half-written seed leaves plain soil behind
    const plantedAt = int(g.plantedAt, 0, 0);
    if (typeof g.seedDefId === 'string' && g.seedDefId && plantedAt > 0) {
      entry.seedDefId = g.seedDefId;
      entry.plantedAt = plantedAt;
      entry.readyAt = int(g.readyAt, plantedAt, plantedAt);
    }
    grows.push(entry);
  }

  /* 2026-09-13 (library series — user's decision): ① an old per-skill book · disc · record id becomes the id of volume 1 of the
     new series (`resolveItemAlias`, on every load — the swap is idempotent). ② one def is shelved **only once across all holder
     furniture** — in save order the first one stays and every later copy of the same def (duplicates created by the swap included)
     is taken out of its slot and handed back to the 함선 창고 (`refund`). A slot-number clash · a wrong shape is dropped silently, as before. */
  let aliasedLibrary = false;
  let migratedLibrary = false;
  const markAliased = (): void => { aliasedLibrary = true; };
  /** Defs already shelved (books + media — different media never collide, but they are kept as one set). */
  const shelvedDefs = new Set<string>();

  // Phase 9 서재: a shelved book needs its 책장 to still be placed; one book per (uid, slot); slot < BOOKS_PER_SHELF
  const books: PlacedBook[] = [];
  const shelfUids = new Set(furniture.filter((f) => isBookshelfDefId(f.defId)).map((f) => f.uid));
  const takenBookSlots = new Set<string>();
  for (const b of Array.isArray(r.books) ? (r.books as Partial<PlacedBook>[]) : []) {
    if (!b) continue;
    const defId = aliasOf(b.defId, markAliased);
    if (typeof b.uid !== 'string' || !isBookDefIdShape(defId)) continue;
    if (!shelfUids.has(b.uid)) {
      // v8: a 책장 that went to furniture storage with its removed room hands its books to the 함선 창고 (like `recover`)
      if (displacedUids.has(b.uid)) mergeCost(refund, [{ defId, qty: 1 }]);
      continue;
    }
    const slot = int(b.slot, -1, -1);
    if (slot < 0 || slot >= BOOKS_PER_SHELF) continue;
    const key = `${b.uid}#${slot}`;
    if (takenBookSlots.has(key)) continue;
    if (shelvedDefs.has(defId)) {
      mergeCost(refund, [{ defId, qty: 1 }]);
      migratedLibrary = true;
      console.warn(`[housing] book '${defId}' was shelved twice — the extra copy goes back to the ship stash`);
      continue;
    }
    takenBookSlots.add(key);
    shelvedDefs.add(defId);
    books.push({ uid: b.uid, slot, defId });
  }
  // the catalogue: unique book ids, every shelved book included (a save edited by hand cannot forget what is on its shelves)
  const bookDex: string[] = [];
  for (const raw of [...(Array.isArray(r.bookDex) ? r.bookDex : []), ...books.map((b) => b.defId)]) {
    const id = aliasOf(raw, markAliased);
    if (isBookDefIdShape(id) && !bookDex.includes(id)) bookDex.push(id);
  }

  /* The lab's analyzer (v5, 2026-09-11): an analysis slot must belong to a placed analyzer, its slot number must be inside the
     range the analyzer's **current level** opens, there is one per (uid, slot), and a sample id must at least have the `spec_*`
     **shape** (whether it is a real sample is pruned once by `parts/Lab.analyses()` through `ctx.loot` — the same contract as the
     library · greenhouse). The sample of a pruned slot does not come back (treated like poured soil, exactly as the contract says). */
  const analyses: AnalysisSlot[] = [];
  const analyzerSlots = new Map<string, number>();
  for (const f of furniture) if (isAnalyzerDefId(f.defId)) analyzerSlots.set(f.uid, analyzerSlotsForLevel(f.level));
  const takenAnalysisSlots = new Set<string>();
  for (const a of Array.isArray(r.analyses) ? (r.analyses as Partial<AnalysisSlot>[]) : []) {
    if (!a || typeof a.uid !== 'string' || !isSampleDefIdShape(a.sampleDefId)) continue;
    const open = analyzerSlots.get(a.uid);
    if (open === undefined) {
      if (displacedUids.has(a.uid)) refundSlotOnce(`a#${a.uid}#${a.slot}`, [a.sampleDefId]);   // 2026-09-13: the sample of a moved analyzer
      continue;
    }
    const slot = int(a.slot, -1, -1);
    if (slot < 0 || slot >= open) continue;
    const key = `${a.uid}#${slot}`;
    if (takenAnalysisSlots.has(key)) continue;
    const startedAt = int(a.startedAt, 0, 0);
    if (startedAt <= 0) continue;                       // a slot with no start time cannot have its timer revived
    takenAnalysisSlots.add(key);
    const entry: AnalysisSlot = { uid: a.uid, slot, sampleDefId: a.sampleDefId, startedAt, readyAt: int(a.readyAt, startedAt, startedAt) };
    // v11 (2026-09-13): the result · family rolled on insert — not dropped (absent, it is rolled when the slot is collected)
    if (typeof a.family === 'string' && (SAMPLE_FAMILIES as readonly string[]).includes(a.family)) entry.family = a.family as SampleFamily;
    if (isItemDefIdShape(a.resultDefId)) {
      entry.resultDefId = a.resultDefId;
      entry.resultQty = int(a.resultQty, 1, 1);
    }
    analyses.push(entry);
  }
  // the analysis catalogue: the unique list of `spec_*`-shaped ids (append-only — a sample collected once is never erased)
  const sampleDex: string[] = [];
  for (const id of Array.isArray(r.sampleDex) ? r.sampleDex : []) {
    if (isSampleDefIdShape(id) && !sampleDex.includes(id)) sampleDex.push(id);
  }

  /* The greenhouse culture tank (v6, A-14, 2026-09-11): a culture slot must belong to a placed culture tank, its slot number must
     be inside the range the tank's **current level** opens, there is one per (uid, slot), and a medium id must at least have an
     item-id **shape**. The strain fields **come and go together**, the same contract as the seed in `grows` — a half-written slot
     is left as 「a medium ready to take one」. The medium · strain of a pruned slot do not come back (treated like poured soil). */
  const cultures: CultureSlot[] = [];
  const tankSlots = new Map<string, number>();
  for (const f of furniture) if (isCultureTankDefId(f.defId)) tankSlots.set(f.uid, cultureSlotsForLevel(f.level));
  const takenCultureSlots = new Set<string>();
  for (const c of Array.isArray(r.cultures) ? (r.cultures as Partial<CultureSlot>[]) : []) {
    if (!c || typeof c.uid !== 'string' || !isItemDefIdShape(c.mediumDefId)) continue;
    const open = tankSlots.get(c.uid);
    if (open === undefined) {
      if (displacedUids.has(c.uid)) {
        // 2026-09-13: the medium · scaffold · inserted strain · sockets of a moved culture tank
        refundSlotOnce(`c#${c.uid}#${c.slot}`, [c.mediumDefId, c.scaffoldDefId, c.strainDefId, ...(socketIdsOf(c.sockets) ?? [])]);
      }
      continue;
    }
    const slot = int(c.slot, -1, -1);
    if (slot < 0 || slot >= open) continue;
    const key = `${c.uid}#${slot}`;
    if (takenCultureSlots.has(key)) continue;
    takenCultureSlots.add(key);
    const entry: CultureSlot = {
      uid: c.uid, slot, mediumDefId: c.mediumDefId,
      // v11: it counts 「harvests left until 0」, so 0 is allowed too
      mediumUsesLeft: int(c.mediumUsesLeft, 1, 0),
    };
    // v11 (2026-09-13): medium durability · sockets · scaffold — not dropped (whether a scaffold is real is left to the runtime sanitizing)
    const mediumDur = nonNegNum(c.mediumDurability);
    if (mediumDur !== null) entry.mediumDurability = mediumDur;
    const mediumSockets = socketIdsOf(c.sockets);
    if (mediumSockets) entry.sockets = mediumSockets;
    if (isItemDefIdShape(c.scaffoldDefId)) entry.scaffoldDefId = c.scaffoldDefId;
    const startedAt = int(c.startedAt, 0, 0);
    if (isItemDefIdShape(c.strainDefId) && startedAt > 0) {
      entry.strainDefId = c.strainDefId;
      entry.startedAt = startedAt;
      entry.readyAt = int(c.readyAt, startedAt, startedAt);
    } else if (isItemDefIdShape(c.strainDefId)) {
      // 2026-09-17 (the culture-start confirm): a slot with a strain inserted but not started yet — the strain is kept with no
      // timer. An old save has no such slot (inserting started it, and without `startedAt` it was dropped above) → a culture that was running stays running.
      entry.strainDefId = c.strainDefId;
    }
    cultures.push(entry);
  }

  /* Library media (v9, A-3e, 2026-09-12): a disc · record slot follows the same rules as `books` — a placed holder uid, **the
     holder's medium must equal the medium of the id shape** (`disc_*` only on a 디스크 전시대), slot < `SHELF_SLOTS[medium]`, one per
     (uid, slot). Whether a disc · record is real is pruned once by `parts/Library.media()` through `ctx.loot`. What sat in a holder
     that went from a removed room to the 가구 창고 is handed back to `out.refund` (함선 창고), like the books. */
  const media: PlacedBook[] = [];
  const shelfMediumByUid = new Map<string, ShelfMedium>();
  for (const f of furniture) {
    const m = shelfMediumOfInteraction(FURNITURE_DEF_MAP.get(f.defId)?.interaction ?? 'none');
    if (m && m !== 'book') shelfMediumByUid.set(f.uid, m);
  }
  const takenMediaSlots = new Set<string>();
  for (const e of Array.isArray(r.media) ? (r.media as Partial<PlacedBook>[]) : []) {
    if (!e || typeof e.uid !== 'string') continue;
    const defIdRaw = aliasOf(e.defId, markAliased);        // 2026-09-13: old id → new id (a game disc `game_*` lives in this list too)
    const m = shelfMediumOfDefId(defIdRaw);
    if (!m || m === 'book') continue;
    const defId = defIdRaw as string;
    const holder = shelfMediumByUid.get(e.uid);
    if (holder === undefined) {
      if (displacedShelf.get(e.uid) === m) mergeCost(refund, [{ defId, qty: 1 }]);
      continue;
    }
    if (holder !== m) continue;
    const slot = int(e.slot, -1, -1);
    if (slot < 0 || slot >= SHELF_SLOTS[m]) continue;
    const key = `${e.uid}#${slot}`;
    if (takenMediaSlots.has(key)) continue;
    if (shelvedDefs.has(defId)) {
      // 2026-09-13: the same def is already in another slot — the extra goes back to the 함선 창고
      mergeCost(refund, [{ defId, qty: 1 }]);
      migratedLibrary = true;
      console.warn(`[housing] shelf item '${defId}' was shelved twice — the extra copy goes back to the ship stash`);
      continue;
    }
    takenMediaSlots.add(key);
    shelvedDefs.add(defId);
    media.push({ uid: e.uid, slot, defId });
  }
  // the catalogue: unique ids shaped `disc_*` / `record_*` / `game_*`, everything shelved included (the same as `bookDex`)
  const mediaDex: string[] = [];
  for (const raw of [...(Array.isArray(r.mediaDex) ? r.mediaDex : []), ...media.map((e) => e.defId)]) {
    const id = aliasOf(raw, markAliased);
    const m = shelfMediumOfDefId(id);
    if (m && m !== 'book' && !mediaDex.includes(id as string)) mediaDex.push(id as string);
  }
  /* 2026-09-13 (video games): the console attached to each TV — a placed TV (`interaction 'tv'`) uid · `console_*` shape · one per TV.
     Shape-valid but with no TV (recovered · moved to the 가구 창고 · a removed room), or a second console on the same TV, and the
     console is handed back to the 함선 창고. A row of the wrong shape is dropped. */
  const tvUids = new Set(furniture.filter((f) => FURNITURE_DEF_MAP.get(f.defId)?.interaction === 'tv').map((f) => f.uid));
  const tvConsoles: TvConsoleSlot[] = [];
  for (const t of Array.isArray(r.tvConsoles) ? (r.tvConsoles as Partial<TvConsoleSlot>[]) : []) {
    if (!t) continue;
    const defId = aliasOf(t.defId, markAliased);
    if (!isConsoleDefIdShape(defId)) continue;
    if (typeof t.uid === 'string' && tvUids.has(t.uid) && !tvConsoles.some((c) => c.uid === t.uid)) {
      tvConsoles.push({ uid: t.uid, defId });
      continue;
    }
    mergeCost(refund, [{ defId, qty: 1 }]);
    migratedLibrary = true;
    console.warn(`[housing] console '${defId}' of TV '${String(t.uid)}' has no placed TV slot — returned to the ship stash`);
  }
  // on: placed TV · record player uids only, without duplicates
  const toggleUids = new Set(furniture.filter((f) => isToggleInteraction(FURNITURE_DEF_MAP.get(f.defId)?.interaction ?? 'none')).map((f) => f.uid));
  const toggled: string[] = [];
  for (const uid of Array.isArray(r.toggled) ? r.toggled : []) {
    if (typeof uid === 'string' && toggleUids.has(uid) && !toggled.includes(uid)) toggled.push(uid);
  }

  /* Cooking material tiers (v11, 2026-09-13): analysis XP per family (only a family with a finite ≥ 0) · the analysis catalogue (item id shapes, no duplicates). */
  const analysisXp: Partial<Record<SampleFamily, number>> = {};
  const rawXp = r.analysisXp && typeof r.analysisXp === 'object' && !Array.isArray(r.analysisXp) ? (r.analysisXp as Record<string, unknown>) : {};
  for (const fam of SAMPLE_FAMILIES) {
    const v = nonNegNum(rawXp[fam]);
    if (v !== null) analysisXp[fam] = v;
  }
  const analysisFound: string[] = [];
  for (const id of Array.isArray(r.analysisFound) ? r.analysisFound : []) {
    if (isItemDefIdShape(id) && !analysisFound.includes(id)) analysisFound.push(id);
  }
  /* The sample rework (v14, 2026-09-16): the analysis level per sample — a `spec_*`-shaped key carrying an integer
     1 … `ANALYSIS_SAMPLE_LEVEL_MAX` only. There is no migration (user's decision) — a missing key is level 0 and builds up again. */
  const sampleLevels: Record<string, number> = {};
  const rawLv = r.sampleLevels && typeof r.sampleLevels === 'object' && !Array.isArray(r.sampleLevels) ? (r.sampleLevels as Record<string, unknown>) : {};
  for (const [id, v] of Object.entries(rawLv)) {
    if (!isSampleDefIdShape(id)) continue;
    const n = int(v, 0, 0, ANALYSIS_SAMPLE_LEVEL_MAX);
    if (n >= 1) sampleLevels[id] = n;
  }

  const state: ShipState = {
    version: SHIP_STATE_VERSION_CURRENT,
    rooms, generatorLevel, storageLevel, furniture, furnitureStorage, presets, plots: [],
    nameLocked: r.nameLocked === true,
    books, bookDex, grows, analyses, sampleDex, cultures,
    media, mediaDex, toggled,
    analysisXp, analysisFound, sampleLevels,
    tvConsoles,
    plate: sanitizePlate(r.plate),            // 2026-09-16 (the plate model): the version is unchanged — a missing field = no plate
  };
  /* v9 → v10 (2026-09-13, user's decision — the fixed props of the 조종석 → decor furniture): 침상 · two 사물함 · 서랍장 are placed at
     the old prop spots **once**. Those cells were `COCKPIT_BLOCKED_RECTS` until v9, so an old save always has them free — which is
     why they go down **before** the 조종석-only facilities (below), so auto placement cannot take an old prop spot first when a
     facility has lost its default spot. It runs after every uid is minted, so a new uid cannot collide. */
  let migratedCockpit = false;
  if (version < 10) {
    migratedCockpit = placeCockpitDecor(state);
    if (migratedCockpit) console.warn(`[housing] v${version} cockpit props → decor furniture (침상 · 사물함 ×2 · 서랍장)`);
  }
  // 2026-09-12: the two shared facility pieces cannot be lost — only after every uid is minted can a new uid avoid colliding
  // 2026-09-13: they are 조종석-only facilities — one in another room · in the 가구 창고 comes back to the 조종석, copies are swept (every load)
  const grantedCockpit = ensureCockpitFurniture(state);
  /* v13 (2026-09-13): v12's power fields (`powerAlloc` · `disabledFurniture` · `pausedAt`) are not migrated — power allocation was dropped (they are not in `state` above). */
  /* Crypto mining (2026-09-13 · processors mounted directly 2026-09-16): only the cluster cells of a 연산 클러스터 in the **final**
     placement survive (once the pieces the access-face rule sent to the 가구 창고 and the dropped ones are gone) — per cell either
     empty (null) or a remaining durability · progress [0, 1) · a finite segment start · a coin id shape (`MiningRules.sanitizeClusters`).
     A processor mounted in a cluster that is not placed, and **an old save's 연산 코어**, do not vanish: they come back as processors
     in the same bag as retired furniture (`refund` → 함선 창고). The wallet · mined totals are id-shaped keys · integers ≥ 1. */
  const placedClusters = new Set(state.furniture.filter((f) => f.defId === COMPUTE_CLUSTER_DEF_ID).map((f) => f.uid));
  const miningSlots = sanitizeClusters(r.clusters, placedClusters, COMPUTE_CLUSTER_MAX_CORES);
  if (miningSlots.orphanCores > 0) {
    mergeCost(refund, [{ defId: PROCESSOR_DEF_ID, qty: miningSlots.orphanCores }]);
    console.warn(`[housing] ${miningSlots.orphanCores} cluster processors (or legacy compute cores) refunded to the ship stash`);
  }
  state.clusters = miningSlots.clusters;
  state.cryptoWallet = sanitizeUnitsMap(r.cryptoWallet);
  state.cryptoMined = sanitizeUnitsMap(r.cryptoMined);
  if (out) {
    out.refund = refund;
    out.migratedRoomLevels = migratedRoomLevels;
    out.migratedRooms = removedRooms.size > 0;
    out.grantedCockpit = grantedCockpit;
    out.migratedCockpit = migratedCockpit;
    out.removedByGenerator = removedByGenerator;
    out.evictedByAccess = evictedByAccess;
    out.migratedLibrary = migratedLibrary;
    out.aliasedLibrary = aliasedLibrary;
  }
  return state;
}

/**
 * Load from localStorage; `fresh` = nothing valid was stored (first run). The rest of the fields fold `SanitizeOutcome`
 * down to what `HousingSystem` acts on:
 *  · `refund` (v4) — what the sweep of 은퇴 가구 and every other load-time refund owes the player; `HousingSystem` pays it
 *    into the 함선 창고 once the inventory exists.
 *  · `migrated` (v7 · v8 · v13 · the library dedupe) = the save must be **written back at once**, so the same refund is
 *    never handed out twice.
 *  · `granted` = a 공용 시설 가구 was put back, or old library ids were swapped (both idempotent — they only schedule a save).
 *  · `evicted` (2026-09-13, access faces) = how many placed pieces broke the placement rule and went to the 가구 창고.
 *  · `removedByGenerator` (v13) = how many facilities the generator level was too low for were removed and refunded.
 * The last two are **counts for the toast**, not flags — `migrated` already carries whether a write-back is owed.
 */
export function loadState(): {
  state: ShipState; fresh: boolean; refund: CraftIngredient[]; migrated: boolean; granted: boolean; evicted: number; removedByGenerator: number;
} {
  const s = storage();
  if (!s) return { state: freshState(), fresh: true, refund: [], migrated: false, granted: false, evicted: 0, removedByGenerator: 0 };
  let raw: unknown = null;
  try {
    const text = s.getItem(slotKey(SHIP_STORAGE_KEY));
    if (text) raw = JSON.parse(text);
  } catch { raw = null; }
  if (!raw || typeof raw !== 'object') return { state: freshState(), fresh: true, refund: [], migrated: false, granted: false, evicted: 0, removedByGenerator: 0 };
  const out: SanitizeOutcome = { refund: [] };
  const state = sanitize(raw, out);
  return {
    state, fresh: false, refund: out.refund,
    // 2026-09-13 (v13): a facility removed for the generator level is inside `migratedRooms`
    migrated: out.migratedRoomLevels === true || out.migratedRooms === true || out.migratedCockpit === true
      || out.migratedLibrary === true,                        // 2026-09-13: a library duplicate · console refund only runs once when it is written back
    granted: out.grantedCockpit === true || out.aliasedLibrary === true,   // 2026-09-13: the old library id swap (idempotent — it only schedules a save)
    evicted: out.evictedByAccess ?? 0,
    removedByGenerator: out.removedByGenerator ?? 0,
  };
}

export function writeState(state: ShipState): boolean {
  const s = storage();
  if (!s) return false;
  try { s.setItem(slotKey(SHIP_STORAGE_KEY), JSON.stringify(state)); return true; } catch { return false; }
}

/** Debounced writer with a pagehide / beforeunload flush; `profile` = the server mirror (read lazily, may be offline). */
export class ShipStore {
  private timer: number | null = null;
  private dirty = false;
  private onPageHide = (): void => this.flush();

  constructor(private readonly getState: () => ShipState, private readonly profile: () => ProfileRef | null = () => null) {
    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener('beforeunload', this.onPageHide);
  }

  markDirty(): void {
    this.dirty = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { this.timer = null; this.flush(); }, SAVE_DELAY_MS);
  }

  flush(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    if (!this.dirty) return;
    this.dirty = false;
    writeState(this.getState());
    this.upload();
  }

  /**
   * Queue the state into the server profile (`profile:set ship`). Phase 9: called **offline too** — `ProfileSync`
   * keeps an unsent document in its pending map (stamped with the save time) and pushes it on the next connection,
   * where the newer side wins. Only a missing profile ref (net/ not registered) skips the call.
   */
  upload(): void {
    const p = this.profile();
    if (!p || typeof p.set !== 'function') return;
    try { p.set('ship', JSON.parse(JSON.stringify(this.getState()))); } catch { /* net not ready */ }
  }

  /** A change is waiting for the debounced write (`markDirty` called, `flush` not yet run). */
  get isDirty(): boolean { return this.dirty; }

  /** Drop a pending write (the state was just replaced by the server copy, which is already written locally). */
  cancel(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.dirty = false;
  }

  dispose(): void {
    this.flush();
    window.removeEventListener('pagehide', this.onPageHide);
    window.removeEventListener('beforeunload', this.onPageHide);
  }
}
