import type {
  AnalysisSlot, CraftIngredient, CultureSlot, GrowSlot, GrowTier, LoadoutPreset, PlacedBook, PlacedFurniture, ProfileRef, RoomPurpose,
  RoomState, ShipState, StoredFurniture,
} from '@/shared';
import {
  BOOKS_PER_SHELF, COCKPIT_DEFAULT_FURNITURE, COCKPIT_ROOM_INDEX, FURNITURE_DEF_MAP, GROW_SLOTS_PER_TIER, IMPLANT_IDS,
  ROOM_PURPOSES_ASSIGNABLE, SHIP_ROOM_COUNT, SHIP_STATE_VERSION, SHIP_STORAGE_KEY,
  analyzerSlotsForLevel, cultureSlotsForLevel, slotKey,
} from '@/shared';
/* A-3e (2026-09-12): 서재 매체 (v9) */
import type { ShelfMedium } from '@/shared';
import { SHELF_SLOTS, isToggleInteraction, shelfMediumOfInteraction } from '@/shared';
import { shelfMediumOfDefId } from './Rules';
import {
  NEEDS_GREENHOUSE,
  autoPlaceSpot, canPlaceAt, facilityMaxLevel, facilityPurposeOf, furnitureAllowedIn, furnitureMaxLevel, furnitureRefundCost, growTierOpen,
  isRoomPurpose, legacyRoomLevelCost, mergeCost, nextFreeLayer, roomRefundCost, stackLimitOf, stackMembers,
} from './Rules';

/* ────────────────────────────────────────────────────────────────────────────
 * ShipState persistence: fresh state, load + sanitise + migrate, debounced save with a pagehide flush. Same shape as
 * inventory/Stash.ts (try/catch around every localStorage touch, SAVE_DELAY_MS debounce). Uids of placed furniture
 * are `f-<n>`; `nextUid` continues after the highest one found in the save. Phase 7: every flush also mirrors the state
 * into the server profile document `ship` (`ctx.net.profile.set`) when a profile is available.
 * Phase 8: state **version 2** — `plots` (온실 재배), `nameLocked`, `PlacedFurniture.layer`, and the 정비 벤치 that
 * left the cockpit was granted once to every profile (v1 → v2). **그 지급은 2026-09-12 에 걷어냈다** — 정비 벤치가
 * 은퇴해서(사용자 결정) 지급해 봐야 곧바로 환불 대상이고, 지급 자리가 은퇴 가구 청소보다 아래라 걸러지지도 않았다.
 * Phase 9: state **version 3** — `books` (서재 책장 slots) + `bookDex` (every book ever shelved); absent → empty, no
 * data migration. `SHIP_STATE_VERSION` in the contract is 3 now, so `SHIP_STATE_VERSION_CURRENT` follows it.
 * 온실 개편 (2026-09-11): state **version 4** — `grows` (재배 스테이션 칸) replaces `plots`, and **every `retired`
 * furniture def is swept out of the save** (placed or stored) and handed back as materials. `sanitize` cannot reach
 * the inventory, so it only *computes* that refund into its optional `out` and `HousingSystem` pays it into the
 * 함선 창고 as soon as `ctx.inventory` exists (see `flushRetiredRefund`).
 * 연구실 (2026-09-11): state **version 5** — `analyses` (분석기 해석 칸) + `sampleDex` (해석 도감). 없던 필드가
 * 생기는 것뿐이라 **버릴 데이터도 환불 경로도 없다** — v4 세이브는 빈 값으로 열린다.
 * 배양조 (A-14, 2026-09-11): state **version 6** — `cultures` (배양 칸). v5 → v6 도 없던 필드가 생기는 것뿐이라
 * 마이그레이션 · 환불 경로가 없다.
 * 방 시설 레벨 제거 (2026-09-12): state **version 7** — 모양은 그대로이고 `RoomState.level` 이 언제나 1(빈 방 0)이 된다.
 * v6 이하의 사격장 Lv.n 은 관물대 · 시뮬레이션 허브 레벨로 옮겨지고, 둘 다 없으면 쓴 재료가, 작업실 Lv.n 은 늘 쓴
 * 재료가 함선 창고로 환불된다 (`sanitize` 의 v7 절). 버전을 올린 이유는 **한 번만** 옮기기 위해서다.
 * ──────────────────────────────────────────────────────────────────────────── */

/*
 * 조종석 · 방 8개 (2026-09-12, 사용자 결정): state **version 8** — 모양은 그대로다. 방은 `SHIP_ROOM_COUNT`(8)개이고,
 * 옛 세이브의 방 9 · 10 과 더 이상 지을 수 없는 용도(시뮬레이션실 · 휴식 공간)의 방은 **전부 제거 + 환불**된다
 * (가구 → 가구 창고, 증축 재료 → 함선 창고 = `out.refund`, 그 방의 책장에 꽂혀 있던 책도 함선 창고로). 관물대 · 표적 레인 ·
 * 시뮬레이션 허브는 은퇴 가구라 은퇴 청소가 재료로 돌려준다. 그리고 **모든 로드**가 공용 시설 가구 두 점(전술 임플란트
 * 시술대 · 기업 네트워크 컴퓨터)이 어딘가에 있는지 보고 없으면 조종석에 채운다 (`ensureCockpitFurniture`).
 */
/*
 * 서재 매체 (A-3e, 2026-09-12): state **version 9** — `media` (디스크 전시대 · 레코드랙 칸, `PlacedBook` 모양) · `mediaDex`
 * (디스크 · 레코드 도감) · `toggled` (켜 둔 TV · 레코드 플레이어). 없던 필드가 생기는 것뿐이라 v8 세이브는 빈 값으로 열리고
 * 마이그레이션이 없다. v8 의 「사라진 방의 보관함 → 함선 창고」 환불은 디스크 · 레코드에도 똑같이 적용된다.
 */
const SAVE_DELAY_MS = 350;
/** Current on-disk version (9 since the 서재 매체; never below the contract's `SHIP_STATE_VERSION`). */
export const SHIP_STATE_VERSION_CURRENT = Math.max(9, SHIP_STATE_VERSION);
/** 옛 세이브에서 읽어 볼 방의 최대 개수 (방 수가 10 이던 세이브 + 손으로 고친 파일에 대한 여유). */
const MAX_SAVED_ROOMS = 32;
/**
 * The 정비 벤치 moved out of the cockpit in Phase 8 and every profile was handed one, once (v1 → v2).
 * **2026-09-12 (사용자 결정): 그 가구는 은퇴했다** — `data/furniture.csv` 의 `retired=1` 이라 `sanitize` 가
 * 놓인 것 · 보관된 것을 걷어내 재료로 환불하고, 함선에서의 무기 수리는 인벤토리에서 재료로 한다.
 * 이 id 는 **이름만 남긴다** (이 프로젝트는 `airstrike` · `secondary` 처럼 추가만 하고 지우지 않는다).
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
 * The ten rooms of a new ship: **all empty** (2026-09-07). The built-in 작업실 of the Phase 8 UI pass is gone — the
 * player assigns every purpose, 작업실 included, from 시설 관리 and pays `ROOM_PURPOSE_BUILD_COST` for it.
 */
function freshRooms(): RoomState[] {
  return Array.from({ length: SHIP_ROOM_COUNT }, freshRoom);
}

export function freshState(): ShipState {
  const state: ShipState = {
    version: SHIP_STATE_VERSION_CURRENT,
    rooms: freshRooms(),
    generatorLevel: 0,
    storageLevel: 0,
    furniture: [],                            // 2026-09-07: no free 총기 작업대 / 정비 벤치 — both are crafted
    furnitureStorage: [],
    presets: [],
    plots: [],                                // 은퇴한 재배층의 잔재 — 언제나 빈 배열이다 (온실 개편, 2026-09-11)
    nameLocked: false,
    books: [],
    bookDex: [],
    grows: [],
    analyses: [],                             // 연구실 분석기 (v5, 2026-09-11)
    sampleDex: [],
    cultures: [],                             // 온실 배양조 (v6, A-14, 2026-09-11)
    media: [],                                // 서재 매체 (v9, A-3e, 2026-09-12)
    mediaDex: [],
    toggled: [],
  };
  ensureCockpitFurniture(state);              // 2026-09-12: 조종석의 공용 시설 가구 두 점 (f-1 시술대 · f-2 컴퓨터)
  return state;
}

/**
 * 2026-09-12 (사용자 결정): 공용 시설 가구(`COCKPIT_DEFAULT_FURNITURE` — 전술 임플란트 시술대 · 기업 네트워크 컴퓨터)는
 * **잃을 수 없다.** 배치된 곳(어느 방이든)에도 가구 창고에도 없는 것이 있으면 조종석의 기본 자리 → 거기가 막혀 있으면 조종석의
 * 자동 배치 자리(`Rules.autoPlaceSpot`) → 그래도 없으면 가구 창고에 Lv.1 한 점을 채운다. 새 함선과 **모든 로드**가 지난다.
 * 채운 것이 하나라도 있으면 true. 좌표는 계약의 표를 읽기만 한다 (hub 가 조종석 소품에 맞춰 고칠 수 있다).
 */
export function ensureCockpitFurniture(state: ShipState): boolean {
  let changed = false;
  for (const spot of COCKPIT_DEFAULT_FURNITURE) {
    const def = FURNITURE_DEF_MAP.get(spot.defId);
    if (!def || def.retired) continue;
    const owned = state.furniture.some((f) => f.defId === def.id) || state.furnitureStorage.some((s) => s.defId === def.id && s.qty > 0);
    if (owned) continue;
    changed = true;
    const at = canPlaceAt(state, COCKPIT_ROOM_INDEX, def, spot.x, spot.y, spot.yaw)
      ? { x: spot.x, y: spot.y, yaw: spot.yaw }
      : autoPlaceSpot(state, COCKPIT_ROOM_INDEX, def);
    if (at) {
      state.furniture.push({ uid: `f-${maxUidIndex(state.furniture) + 1}`, defId: def.id, room: COCKPIT_ROOM_INDEX, x: at.x, y: at.y, yaw: at.yaw, level: 1 });
    } else {
      console.warn(`[housing] no cockpit spot for '${def.id}' — put into furniture storage`);
      state.furnitureStorage.push({ defId: def.id, level: 1, qty: 1 });
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

/** A 재배 스테이션 (온실 개편, 2026-09-11): the furniture whose E opens the 재배 화면. */
export function isGrowStationDefId(defId: string): boolean {
  return FURNITURE_DEF_MAP.get(defId)?.interaction === 'grow_station';
}

/** 은퇴한 가구인가 (`data/furniture.csv` 의 `retired` 칸). 목록 · 제작 · 배치 · 세이브 어디에도 남지 않는다. */
export function isRetiredDefId(defId: string): boolean {
  return FURNITURE_DEF_MAP.get(defId)?.retired === true;
}

/** 분석기인가 (연구실, 2026-09-11): E 로 분석 화면을 여는 가구. */
export function isAnalyzerDefId(defId: string): boolean {
  return FURNITURE_DEF_MAP.get(defId)?.interaction === 'analyzer';
}

/** 배양조인가 (A-14, 2026-09-11): E 로 배양 화면을 여는 가구. */
export function isCultureTankDefId(defId: string): boolean {
  return FURNITURE_DEF_MAP.get(defId)?.interaction === 'culture_tank';
}

/** 식탁인가 (A-3c, 2026-09-11): E 로 식사 화면을 여는 가구. 공유 함선의 고정 식탁에는 uid 가 없다. */
export function isDiningTableDefId(defId: string): boolean {
  return FURNITURE_DEF_MAP.get(defId)?.interaction === 'dining_table';
}

/** Shape check of a 표본 def id in a save (`spec_*`); whether it is a real 표본 is a runtime check via `ctx.loot`. */
const isSampleDefIdShape = (v: unknown): v is string => typeof v === 'string' && /^spec_[A-Za-z0-9_]{1,40}$/.test(v);

/**
 * Shape check of a 배지 · 세포주 def id in a save. Unlike 표본(`spec_*`) · 토양(`soil_*`) · 서적(`book_*`) these two
 * carry **no id prefix of their own** (`mat_medium_*` · `strain_*` are `material` ids like any other), so the shape
 * check only keeps out obvious junk — whether the id is a real `ItemDef.medium` / `ItemDef.strain` is the runtime
 * prune in `parts/Culture.cultures()` (same 규약 as the 서재 · 온실 · 연구실).
 */
const isItemDefIdShape = (v: unknown): v is string => typeof v === 'string' && /^[a-z][A-Za-z0-9_]{1,48}$/.test(v);

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
 * Migrations: **v1 → v2** granted the 정비 벤치 that moved out of the cockpit; **2026-09-12 부터 아무것도 주지 않는다**
 * (그 가구는 은퇴했다 — 아래 그 자리의 주석). **v3** adds `books` / `bookDex` (Phase 9): a book needs a
 * placed 책장 uid, a slot below `BOOKS_PER_SHELF`, one book per (uid, slot) and a `book_*`-shaped def id; the 도감 is
 * a unique list of such ids. Whether an id still resolves to a 서적 is checked by `HousingSystem` once `ctx.loot`
 * exists. 2026-09-07: the room-1 작업실 invariant is gone — the only room rule left is "at most one facility room of
 * each kind"; furniture whose room no longer accepts it moves into furniture storage instead of being dropped.
 * **v4 (온실 개편, 2026-09-11)**: every `retired` def (지금은 옛 재배층 `furn_grow_rack`) is swept out — placed and
 * stored alike — and what it cost is accumulated into `out.refund` for the caller to pay into the 함선 창고. The old
 * `plots` are dropped wholesale (사용자 결정: 옛 것 폐기) and the new `grows` are validated against the 재배
 * 스테이션 that owns them (placed uid · tier its current level opens · slot in range · soil id shape).
 * **v5 (연구실, 2026-09-11)**: `analyses` (분석기 해석 칸 — placed 분석기 uid · slot inside `analyzerSlotsForLevel`
 * of its **current** level · one per (uid, slot) · `spec_*` id shape · a real `startedAt`) and `sampleDex` (unique
 * `spec_*` ids). A v4 save simply opens with both empty — nothing is dropped, so there is no refund path.
 * **v6 (배양조 A-14, 2026-09-11)**: `cultures` (배양 칸 — placed 배양조 uid · slot inside `cultureSlotsForLevel` of
 * its **current** level · one per (uid, slot) · an item-id-shaped 배지 · the 세포주 fields only together with a real
 * `startedAt`). Again 없던 필드가 생기는 것뿐이라 마이그레이션 · 환불 경로가 없다.
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
   * v8 (2026-09-12, 사용자 결정 「전부 제거 + 환불」): source rooms `sanitize` removes — index ≥ `SHIP_ROOM_COUNT` (방 9 · 10)
   * with a facility, and any room whose purpose can no longer be built (시뮬레이션실 · 휴식 공간 — `ROOM_PURPOSES_ASSIGNABLE`).
   * The build cost goes into `refund`, the room's pieces into furniture storage (below).
   */
  const removedRooms = new Set<number>();
  /** 은퇴 가구 · 사라진 방이 돌려줄 재료: 한 자루에 모아 caller 가 함선 창고로 넣는다. */
  const refund: CraftIngredient[] = [];
  const srcRooms = Array.isArray(r.rooms) ? r.rooms.slice(0, MAX_SAVED_ROOMS) : [];
  /** Source room slots the furniture pass still recognises (a 10-room save keeps pieces of 방 9 · 10). */
  const roomSlots = Math.max(SHIP_ROOM_COUNT, srcRooms.length);
  for (let i = 0; i < roomSlots; i++) {
    const s = srcRooms[i] as Partial<RoomState> | undefined;
    const purpose = isRoomPurpose(s?.purpose) ? s!.purpose! : 'empty';
    rawPurposes.push(purpose);
    rawRoomLevels.push(purpose === 'empty' ? 0 : int(s?.level, 1, 1, 99));
    const gone = purpose !== 'empty' && (i >= SHIP_ROOM_COUNT || !ROOM_PURPOSES_ASSIGNABLE.includes(purpose));
    if (gone) {
      removedRooms.add(i);
      mergeCost(refund, roomRefundCost(purpose, 1));   // the 시설 증축 price (legacy room levels: the v7 block below)
      console.warn(`[housing] room ${i + 1} (${purpose}) removed — build cost refunded, furniture to storage`);
    }
    if (i >= SHIP_ROOM_COUNT) continue;
    // 2026-09-12: 방 시설에는 레벨이 없다 — 용도가 있으면 1, 빈 방이면 0 (`Rules.facilityMaxLevel` 이 1 이다)
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
  // a 연구실 · 주방 without a greenhouse (edited save) falls back to empty (`Rules.NEEDS_GREENHOUSE` 가 원본)
  if (!rooms.some((x) => x.purpose === 'greenhouse')) {
    for (const x of rooms) if (NEEDS_GREENHOUSE.includes(x.purpose)) { x.purpose = 'empty'; x.level = 0; }
  }

  const generatorLevel = int(r.generatorLevel, 0, 0, facilityMaxLevel('generator'));
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
  for (const f of Array.isArray(r.furniture) ? (r.furniture as Partial<PlacedFurniture>[]) : []) {
    if (!f || typeof f.defId !== 'string') continue;
    const def = FURNITURE_DEF_MAP.get(f.defId);
    if (!def) { console.warn(`[housing] unknown furniture '${f.defId}' dropped`); continue; }
    if (def.retired) {
      // 온실 개편 (2026-09-11): 은퇴한 가구는 함선에서 걷어내고 값을 재료로 돌려준다 (사용자 결정: 옛 것 폐기)
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
     * ⚠ 이 검사는 **클램프가 아니라 드롭**이다 — 안 맞는 가구는 창고로도 안 가고 사라진다. 그래서 격자 치수를
     * 건드릴 때는 「옛 좌표가 전부 여전히 유효한가」를 먼저 본다.
     *
     * 2026-09-12 (`ROOM_GRID_COLS/ROWS` 8 → 16, 방 4 × 4 → 8 × 8 m): **버전을 올리지 않았다.** `PlacedFurniture.x/y`
     * 는 좌상단(방의 min-x / min-z 모서리)이 원점인 정수라 격자가 **커지기만** 하면 옛 좌표의 뜻이 한 자도 안
     * 바뀐다. `canPlaceAt` 이 거는 조건 셋 중 용도 · 겹침은 격자 크기와 무관하고, 남은 하나 `insideGrid`
     * (`x + cols ≤ COLS`, `y + rows ≤ ROWS`)는 **느슨해지기만** 한다 — 8 칸에서 통과한 배치는 16 칸에서 전부
     * 통과한다. 가구는 기존 자리(화면 좌측 상단 구석)에 그대로 서고 방의 나머지가 빈 공간으로 열린다.
     * 격자를 **줄이는** 변경을 한다면 그때는 v 마이그레이션이 필요하다 (여기서 조용히 증발한다).
     */
    // `canPlaceAt` answers "is this a place at all" too (a room index or `COCKPIT_ROOM_INDEX` — 2026-09-12)
    if (!canPlaceAt(partial, room, def, item.x, item.y, item.yaw)) {
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
   * v1 → v2 은 여기서 **정비 벤치 한 개를 지급**했다 (`furn_repair_bench`, 콕핏에서 나온 몫). 2026-09-12
   * (사용자 결정)에 그 가구가 은퇴하면서 그 지급은 **낭비를 넘어 버그**가 됐다: 은퇴 가구를 걷어내는 두 자리
   * (배치 · 보관)는 둘 다 이 줄보다 **위**라, 여기서 밀어 넣으면 걸러지지 않고 가구 창고에 은퇴 가구가
   * 남는다(`getStored()` 에 뜨고 배치하려 하면 def 가 목록에 없다). 그래서 지급을 걷어냈다 —
   * v1 세이브도 이제 아무것도 못 받고, 대신 이미 벤치를 갖고 있던 세이브는 `sanitize` 의 환불을 받는다.
   * `REPAIR_BENCH_DEF_ID` 는 이름만 남는다 (위 주석).
   */

  /* v6 → v7 (2026-09-12, 사용자 결정 — 방 시설 레벨 제거): 손해 없이 옮긴다.
     · 사격장 Lv.n (n ≥ 2) → 그 레벨을 **관물대 · 시뮬레이션 허브**에 준다 (배치된 것은 레벨을 max 로, 창고에만 있으면
       가장 높은 한 점을 그 레벨로). 둘 다 함선에 없으면 옛 강화에 쓴 재료를 환불한다.
     · 작업실 Lv.n (n ≥ 2) → 제작 할인이 폐지됐으므로 옮길 곳이 없다 — 옛 강화에 쓴 재료를 환불한다.
     환불은 은퇴 가구와 같은 `refund` 자루로 가서 `HousingSystem` 이 함선 창고에 넣는다. 레벨은 위에서 이미 1 로
     내려갔으므로 v7 로 저장된 뒤에는 다시 돌지 않는다. */
  /* v8 (2026-09-12, 같은 날): 관물대 · 시뮬레이션 허브가 **은퇴**했다. 위의 옮기기는 이제 옮길 곳이 없다 — 은퇴 가구는 이미
     청소에서 걸러져 `furniture` · `furnitureStorage` 어디에도 없으므로 사격장 Lv.n 은 늘 쓴 재료를 환불한다. v7 로 저장된
     세이브가 관물대 · 허브에 옮겨 둔 레벨은 은퇴 청소가 그 레벨까지의 강화비와 함께 환불한다 (`furnitureRefundCost`). */
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
      // appended (2026-09-08): 임플란트 아이템 def ids. Absent in an older save → left undefined, which `applyLoadout`
      // reads as "leave the equipped implants alone" (an empty array means "take everything off").
      ...(Array.isArray(p.implantItems)
        ? { implantItems: (p.implantItems as unknown[]).filter((d): d is string => typeof d === 'string' && !!d).slice(0, 16) }
        : {}),
    });
  }

  /* 온실 개편 (2026-09-11): the 재배층 `plots` are gone with the furniture they belonged to — 사용자 결정 「옛 것
     폐기」. The field stays in the contract (추가만 하는 규약) and is written back empty. */

  // 재배 스테이션 칸: the station must still be placed, its level must open the tier, the slot must be in range,
  // one entry per (uid, tier, slot), and the soil id must at least *look* like a 토양 (the real def check is a
  // runtime prune in `parts/Garden.grows()`, exactly like the 서재 does with its books).
  const grows: GrowSlot[] = [];
  const stationLevel = new Map<string, number>();
  for (const f of furniture) if (isGrowStationDefId(f.defId)) stationLevel.set(f.uid, f.level);
  const takenGrowSlots = new Set<string>();
  for (const g of Array.isArray(r.grows) ? (r.grows as Partial<GrowSlot>[]) : []) {
    if (!g || typeof g.uid !== 'string' || !isSoilDefIdShape(g.soilDefId)) continue;
    const level = stationLevel.get(g.uid);
    if (level === undefined) continue;
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
      soilUsesLeft: Math.max(1, int(g.soilUsesLeft, 1, 1)),
    };
    // planting fields come and go together: a half-written seed leaves plain soil behind
    const plantedAt = int(g.plantedAt, 0, 0);
    if (typeof g.seedDefId === 'string' && g.seedDefId && plantedAt > 0) {
      entry.seedDefId = g.seedDefId;
      entry.plantedAt = plantedAt;
      entry.readyAt = int(g.readyAt, plantedAt, plantedAt);
    }
    grows.push(entry);
  }

  // Phase 9 서재: a shelved book needs its 책장 to still be placed; one book per (uid, slot); slot < BOOKS_PER_SHELF
  const books: PlacedBook[] = [];
  const shelfUids = new Set(furniture.filter((f) => isBookshelfDefId(f.defId)).map((f) => f.uid));
  const takenBookSlots = new Set<string>();
  for (const b of Array.isArray(r.books) ? (r.books as Partial<PlacedBook>[]) : []) {
    if (!b || typeof b.uid !== 'string' || !isBookDefIdShape(b.defId)) continue;
    if (!shelfUids.has(b.uid)) {
      // v8: a 책장 that went to furniture storage with its removed room hands its books to the 함선 창고 (like `recover`)
      if (displacedUids.has(b.uid)) mergeCost(refund, [{ defId: b.defId, qty: 1 }]);
      continue;
    }
    const slot = int(b.slot, -1, -1);
    if (slot < 0 || slot >= BOOKS_PER_SHELF) continue;
    const key = `${b.uid}#${slot}`;
    if (takenBookSlots.has(key)) continue;
    takenBookSlots.add(key);
    books.push({ uid: b.uid, slot, defId: b.defId });
  }
  // 도감: unique book ids, every shelved book included (a save edited by hand cannot forget what is on its shelves)
  const bookDex: string[] = [];
  for (const id of [...(Array.isArray(r.bookDex) ? r.bookDex : []), ...books.map((b) => b.defId)]) {
    if (isBookDefIdShape(id) && !bookDex.includes(id)) bookDex.push(id);
  }

  /* 연구실 분석기 (v5, 2026-09-11): 해석 칸은 배치된 분석기의 것이어야 하고, 칸 번호가 그 분석기의 **지금 레벨**이
     연 범위 안이어야 하며, (uid, slot) 하나에 하나뿐이고, 표본 id 는 최소한 `spec_*` **모양**이어야 한다 (진짜
     표본인지는 `parts/Lab.analyses()` 가 `ctx.loot` 로 한 번 걸러 낸다 — 서재 · 온실과 같은 규약). 걸러진 칸의
     표본은 돌아오지 않는다 (부은 흙과 같은 취급, 계약에 적힌 그대로). */
  const analyses: AnalysisSlot[] = [];
  const analyzerSlots = new Map<string, number>();
  for (const f of furniture) if (isAnalyzerDefId(f.defId)) analyzerSlots.set(f.uid, analyzerSlotsForLevel(f.level));
  const takenAnalysisSlots = new Set<string>();
  for (const a of Array.isArray(r.analyses) ? (r.analyses as Partial<AnalysisSlot>[]) : []) {
    if (!a || typeof a.uid !== 'string' || !isSampleDefIdShape(a.sampleDefId)) continue;
    const open = analyzerSlots.get(a.uid);
    if (open === undefined) continue;
    const slot = int(a.slot, -1, -1);
    if (slot < 0 || slot >= open) continue;
    const key = `${a.uid}#${slot}`;
    if (takenAnalysisSlots.has(key)) continue;
    const startedAt = int(a.startedAt, 0, 0);
    if (startedAt <= 0) continue;                       // 시작 시각이 없는 칸은 타이머를 되살릴 수 없다
    takenAnalysisSlots.add(key);
    analyses.push({ uid: a.uid, slot, sampleDefId: a.sampleDefId, startedAt, readyAt: int(a.readyAt, startedAt, startedAt) });
  }
  // 해석 도감: `spec_*` 모양의 유일한 id 목록 (append-only — 한 번 회수한 표본은 지워지지 않는다)
  const sampleDex: string[] = [];
  for (const id of Array.isArray(r.sampleDex) ? r.sampleDex : []) {
    if (isSampleDefIdShape(id) && !sampleDex.includes(id)) sampleDex.push(id);
  }

  /* 온실 배양조 (v6, A-14, 2026-09-11): 배양 칸은 배치된 배양조의 것이어야 하고, 칸 번호가 그 배양조의 **지금
     레벨**이 연 범위 안이어야 하며, (uid, slot) 하나에 하나뿐이고, 배지 id 는 최소한 아이템 id **모양**이어야
     한다. 세포주 필드는 `grows` 의 씨앗과 같은 규약으로 **함께 오고 함께 간다** — 반쯤 쓰인 칸은 「넣을 준비가
     된 배지」로 남는다. 걸러진 칸의 배지 · 세포주는 돌아오지 않는다 (부은 흙과 같은 취급). */
  const cultures: CultureSlot[] = [];
  const tankSlots = new Map<string, number>();
  for (const f of furniture) if (isCultureTankDefId(f.defId)) tankSlots.set(f.uid, cultureSlotsForLevel(f.level));
  const takenCultureSlots = new Set<string>();
  for (const c of Array.isArray(r.cultures) ? (r.cultures as Partial<CultureSlot>[]) : []) {
    if (!c || typeof c.uid !== 'string' || !isItemDefIdShape(c.mediumDefId)) continue;
    const open = tankSlots.get(c.uid);
    if (open === undefined) continue;
    const slot = int(c.slot, -1, -1);
    if (slot < 0 || slot >= open) continue;
    const key = `${c.uid}#${slot}`;
    if (takenCultureSlots.has(key)) continue;
    takenCultureSlots.add(key);
    const entry: CultureSlot = {
      uid: c.uid, slot, mediumDefId: c.mediumDefId,
      mediumUsesLeft: Math.max(1, int(c.mediumUsesLeft, 1, 1)),
    };
    const startedAt = int(c.startedAt, 0, 0);
    if (isItemDefIdShape(c.strainDefId) && startedAt > 0) {
      entry.strainDefId = c.strainDefId;
      entry.startedAt = startedAt;
      entry.readyAt = int(c.readyAt, startedAt, startedAt);
    }
    cultures.push(entry);
  }

  /* 서재 매체 (v9, A-3e, 2026-09-12): 디스크 · 레코드 칸은 `books` 와 같은 규칙이다 — 배치된 보관함 uid 이고 **그 보관함의 매체가
     id 모양의 매체와 같아야 하며**(`disc_*` 는 디스크 전시대에만), 칸 < `SHELF_SLOTS[매체]`, (uid, slot) 하나에 하나. 진짜
     디스크 · 레코드인지는 `parts/Library.media()` 가 `ctx.loot` 로 한 번 걸러 낸다. 사라진 방에서 가구 창고로 간 보관함의 것은
     책처럼 `out.refund`(함선 창고)로 돌려준다. */
  const media: PlacedBook[] = [];
  const shelfMediumByUid = new Map<string, ShelfMedium>();
  for (const f of furniture) {
    const m = shelfMediumOfInteraction(FURNITURE_DEF_MAP.get(f.defId)?.interaction ?? 'none');
    if (m && m !== 'book') shelfMediumByUid.set(f.uid, m);
  }
  const takenMediaSlots = new Set<string>();
  for (const e of Array.isArray(r.media) ? (r.media as Partial<PlacedBook>[]) : []) {
    if (!e || typeof e.uid !== 'string') continue;
    const m = shelfMediumOfDefId(e.defId);
    if (!m || m === 'book') continue;
    const holder = shelfMediumByUid.get(e.uid);
    if (holder === undefined) {
      if (displacedShelf.get(e.uid) === m) mergeCost(refund, [{ defId: e.defId as string, qty: 1 }]);
      continue;
    }
    if (holder !== m) continue;
    const slot = int(e.slot, -1, -1);
    if (slot < 0 || slot >= SHELF_SLOTS[m]) continue;
    const key = `${e.uid}#${slot}`;
    if (takenMediaSlots.has(key)) continue;
    takenMediaSlots.add(key);
    media.push({ uid: e.uid, slot, defId: e.defId as string });
  }
  // 도감: `disc_*` / `record_*` 모양의 유일한 id, 꽂혀 있는 것은 전부 포함 (`bookDex` 와 같다)
  const mediaDex: string[] = [];
  for (const id of [...(Array.isArray(r.mediaDex) ? r.mediaDex : []), ...media.map((e) => e.defId)]) {
    const m = shelfMediumOfDefId(id);
    if (m && m !== 'book' && !mediaDex.includes(id as string)) mediaDex.push(id as string);
  }
  // 켜짐: 배치된 TV · 레코드 플레이어 uid 만, 중복 없이
  const toggleUids = new Set(furniture.filter((f) => isToggleInteraction(FURNITURE_DEF_MAP.get(f.defId)?.interaction ?? 'none')).map((f) => f.uid));
  const toggled: string[] = [];
  for (const uid of Array.isArray(r.toggled) ? r.toggled : []) {
    if (typeof uid === 'string' && toggleUids.has(uid) && !toggled.includes(uid)) toggled.push(uid);
  }

  const state: ShipState = {
    version: SHIP_STATE_VERSION_CURRENT,
    rooms, generatorLevel, storageLevel, furniture, furnitureStorage, presets, plots: [],
    nameLocked: r.nameLocked === true,
    books, bookDex, grows, analyses, sampleDex, cultures,
    media, mediaDex, toggled,
  };
  // 2026-09-12: 공용 시설 가구 두 점은 잃을 수 없다 — uid 를 다 매긴 뒤라야 새 uid 가 겹치지 않는다
  const grantedCockpit = ensureCockpitFurniture(state);
  if (out) {
    out.refund = refund;
    out.migratedRoomLevels = migratedRoomLevels;
    out.migratedRooms = removedRooms.size > 0;
    out.grantedCockpit = grantedCockpit;
  }
  return state;
}

/**
 * Load from localStorage; `fresh` = nothing valid was stored (first run). `refund` (v4) is what the sweep of
 * 은퇴 가구 owes the player — `HousingSystem` pays it into the 함선 창고 once the inventory exists.
 * `migrated` (v7 · v8) = room levels / removed rooms were migrated; `granted` = a 공용 시설 가구 was put back.
 */
export function loadState(): { state: ShipState; fresh: boolean; refund: CraftIngredient[]; migrated: boolean; granted: boolean } {
  const s = storage();
  if (!s) return { state: freshState(), fresh: true, refund: [], migrated: false, granted: false };
  let raw: unknown = null;
  try {
    const text = s.getItem(slotKey(SHIP_STORAGE_KEY));
    if (text) raw = JSON.parse(text);
  } catch { raw = null; }
  if (!raw || typeof raw !== 'object') return { state: freshState(), fresh: true, refund: [], migrated: false, granted: false };
  const out: SanitizeOutcome = { refund: [] };
  const state = sanitize(raw, out);
  return {
    state, fresh: false, refund: out.refund,
    migrated: out.migratedRoomLevels === true || out.migratedRooms === true,
    granted: out.grantedCockpit === true,
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
