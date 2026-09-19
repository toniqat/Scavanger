/**
 * src/housing/model.ts — the ship housing folder's shared vocabulary.
 *
 * Only the constants and types (plus stateless helper classes) split out of `HousingSystem`. It references no class,
 * so a `parts/*` module can use it without importing `HousingSystem.ts` back (no import cycle).
 * `HousingSystem.ts` re-exports it with `export *`, so every existing import path still resolves.
 */
import type { FacilityId, FurnitureDef, ShelfMedium } from '@/shared';
import { FURNITURE_DEFS, SHELF_AUX_INTERACTION, SHELF_INTERACTION } from '@/shared';
import './housing.css';

export const FACILITY_IDS: readonly FacilityId[] = ['generator', 'storage', 'workshop', 'range'];
export const PRESET_NAME_MAX = 24;
/** Korean refusal when a `책장` cannot be recovered because its books have nowhere to go. */
export const BOOKS_BLOCK_REASON = '책을 먼저 빼세요';
/**
 * A-3e (2026-09-12): the reason a holder cannot be recovered — one per medium (`책장` keeps the old
 * `BOOKS_BLOCK_REASON`). `디스크` and `레코드` end in a vowel, so their particle is fixed at 「를 · 가」.
 */
export const SHELF_BLOCK_REASON: Readonly<Record<ShelfMedium, string>> = {
  book: BOOKS_BLOCK_REASON, disc: '디스크를 먼저 빼세요', record: '레코드를 먼저 빼세요', game: '게임 디스크를 먼저 빼세요',
};
/** Medium name + object particle (`책을` · `디스크를` · `레코드를`) — for the sentences on the holder screen. */
export const SHELF_OBJ_KO: Readonly<Record<ShelfMedium, string>> = { book: '책을', disc: '디스크를', record: '레코드를', game: '게임 디스크를' };
/** The counter word a medium is counted with (`6 / 6권` · `4 / 4장`). */
export const SHELF_UNIT_KO: Readonly<Record<ShelfMedium, string>> = { book: '권', disc: '장', record: '장', game: '장' };
/**
 * 2026-09-14 (library screen rework): the medium glyph a shelf cell · catalogue thumbnail · rail row uses when the
 * item def carries none. The holder screen and the catalogue must draw the same thing, so it sits here once.
 */
export const SHELF_GLYPH: Readonly<Record<ShelfMedium, string>> = { book: '▤', disc: '◎', record: '◉', game: '⊛' };
/** Glyph of the 「서재」 row at the top of the rail (the whole library facility, not one holder). */
export const LIBRARY_GLYPH = '❖';

/** Name of the holder furniture that takes that medium (`data/furniture.csv` — `책장` · `디스크 전시대` · `레코드랙`). */
export function shelfHolderName(medium: ShelfMedium): string {
  return ACTIVE_FURNITURE_DEFS.find((d) => d.interaction === SHELF_INTERACTION[medium])?.name ?? '보관함';
}

/**
 * Names of that medium's auxiliary furniture (`흔들의자` · `TV` · `축음기 · 주크박스 · 턴테이블`).
 * @deprecated 2026-09-14 — the holder screen's auxiliary furniture row is gone, so nothing calls this any more (the
 * multiplier itself is still `SHELF_AUX_BONUS`).
 */
export function shelfAuxNames(medium: ShelfMedium): string {
  return ACTIVE_FURNITURE_DEFS.filter((d) => d.interaction === SHELF_AUX_INTERACTION[medium]).map((d) => d.name).join(' · ');
}

/**
 * 2026-09-13 (user's decision): the refusal when a cockpit-only facility (`시술대` · `컴퓨터`) would be recovered or
 * removed — the string itself lives in `shared/housing` (hub uses it too).
 */
export { COCKPIT_ONLY_RECOVER_REASON } from '@/shared';

/** Korean answer of the retired `재배층` API (`plantSeed` · `harvestPlot`). Greenhouse rework, 2026-09-11. */
export const RETIRED_RACK_REASON = '재배층은 재배 스테이션으로 교체되었습니다';

/**
 * The furniture that appears in lists — the defs minus `FurnitureDef.retired` (greenhouse rework, 2026-09-11). The
 * furniture catalogue, furniture crafting and ship management all read this one. `getFurnitureDef(id)` still returns
 * a retired piece too — refunding an old save as materials needs its cost. A module constant, so no array per call.
 */
export const ACTIVE_FURNITURE_DEFS: readonly FurnitureDef[] = FURNITURE_DEFS.filter((d) => !d.retired);

/**
 * Ship housing: owns the ShipState (rooms / facilities / furniture / presets), every rule and number
 * (see Rules.ts), persistence (ShipState.ts) and the DOM panels (ui/). Publishes `ctx.housing`.
 * hub/ builds the geometry and the housing-mode camera / cursor on top of this API and its `housing:*` events.
 *
 * Materials come from `ctx.inventory.countDefAll / consumeDefAll` (bag + stash); both are guarded with `typeof`
 * because inventory/ is built in parallel — without them nothing can be bought.
 * Phase 7: the state is mirrored into the server profile document `ship` on every save; `net:profileLoaded` replaces
 * it with the server copy and re-emits `housing:loaded` so hub/ rebuilds the personal ship.
 * Phase 9: library bookshelves — `ShipState.books` (one `PlacedBook` per filled shelf slot) + `bookDex`; the library
 * multiplier (`getBookBonus`, Rules.bookGainMulFor) is folded into `getSkillGainMul`, so progression/ reads one number.
 * Greenhouse rework (2026-09-11): the grow station — `ShipState.grows` (cells holding soil · a seed) replaces the
 * retired `재배층`'s `plots`; the rules live in `Rules.ts` (tier unlock · soil match · growth time) and the screen
 * in `ui/GrowStation.ts`.
 */
