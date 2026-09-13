/**
 * src/housing/model.ts — 함선 꾸미기 폴더의 공용 어휘.
 *
 * `HousingSystem` 에서 떼어낸 상수 · 타입(그리고 상태 없는 보조 클래스)만 있다. 클래스를 참조하지 않으므로
 * `parts/*` 모듈이 `HousingSystem.ts` 를 되돌아 import 하지 않고 쓸 수 있다(순환 import 방지).
 * `HousingSystem.ts` 가 `export *` 로 재수출하므로 기존 import 경로는 전부 유지된다.
 */
import type { FacilityId, FurnitureDef, ShelfMedium } from '@/shared';
import { FURNITURE_DEFS, SHELF_AUX_INTERACTION, SHELF_INTERACTION } from '@/shared';
import './housing.css';

export const FACILITY_IDS: readonly FacilityId[] = ['generator', 'storage', 'workshop', 'range'];
export const PRESET_NAME_MAX = 24;
/** 한국어 refusal when a 책장 cannot be recovered because its books have nowhere to go. */
export const BOOKS_BLOCK_REASON = '책을 먼저 빼세요';
/**
 * A-3e (2026-09-12): 보관함을 회수할 수 없는 사유 — 매체별 (책장은 옛 `BOOKS_BLOCK_REASON` 그대로).
 * 디스크 · 레코드는 모음으로 끝나므로 조사는 「를 · 가」로 고정이다.
 */
export const SHELF_BLOCK_REASON: Readonly<Record<ShelfMedium, string>> = {
  book: BOOKS_BLOCK_REASON, disc: '디스크를 먼저 빼세요', record: '레코드를 먼저 빼세요',
};
/** 매체 이름 + 목적격 조사 (`책을` · `디스크를` · `레코드를`) — 보관함 화면의 문장용. */
export const SHELF_OBJ_KO: Readonly<Record<ShelfMedium, string>> = { book: '책을', disc: '디스크를', record: '레코드를' };
/** 매체를 세는 단위 (`6 / 6권` · `4 / 4장`). */
export const SHELF_UNIT_KO: Readonly<Record<ShelfMedium, string>> = { book: '권', disc: '장', record: '장' };

/** 그 매체를 받는 보관함 가구의 이름 (`data/furniture.csv` 에서 — 책장 · 디스크 전시대 · 레코드랙). */
export function shelfHolderName(medium: ShelfMedium): string {
  return ACTIVE_FURNITURE_DEFS.find((d) => d.interaction === SHELF_INTERACTION[medium])?.name ?? '보관함';
}

/** 그 매체의 보조 가구 이름들 (`흔들의자` · `TV` · `축음기 · 주크박스 · 턴테이블`). */
export function shelfAuxNames(medium: ShelfMedium): string {
  return ACTIVE_FURNITURE_DEFS.filter((d) => d.interaction === SHELF_AUX_INTERACTION[medium]).map((d) => d.name).join(' · ');
}

/** 2026-09-13 (사용자 결정): 조종석 전용 시설(시술대 · 컴퓨터)을 회수 · 제거하려 할 때의 거절 — 문장의 원본은 `shared/housing` (hub 도 쓴다). */
export { COCKPIT_ONLY_RECOVER_REASON } from '@/shared';

/** 한국어 answer of the retired 재배층 API (`plantSeed` · `harvestPlot`). 온실 개편, 2026-09-11. */
export const RETIRED_RACK_REASON = '재배층은 재배 스테이션으로 교체되었습니다';

/**
 * 목록에 실리는 가구 — `FurnitureDef.retired` 를 뺀 것 (온실 개편, 2026-09-11). 가구 카탈로그 · 가구 제작 ·
 * 시설 관리가 전부 이것을 본다. `getFurnitureDef(id)` 는 여전히 은퇴 가구도 돌려준다 — 옛 세이브를 재료로
 * 환불하려면 그 값을 알아야 하기 때문이다. 모듈 상수라 매 호출마다 배열을 새로 만들지 않는다.
 */
export const ACTIVE_FURNITURE_DEFS: readonly FurnitureDef[] = FURNITURE_DEFS.filter((d) => !d.retired);

/**
 * Ship housing (함선 꾸미기): owns the ShipState (rooms / facilities / furniture / presets), every rule and number
 * (see Rules.ts), persistence (ShipState.ts) and the DOM panels (ui/). Publishes `ctx.housing`.
 * hub/ builds the geometry and the housing-mode camera / cursor on top of this API and its `housing:*` events.
 *
 * Materials come from `ctx.inventory.countDefAll / consumeDefAll` (bag + stash); both are guarded with `typeof`
 * because inventory/ is built in parallel — without them nothing can be bought.
 * Phase 7: the state is mirrored into the server profile document `ship` on every save; `net:profileLoaded` replaces
 * it with the server copy and re-emits `housing:loaded` so hub/ rebuilds the personal ship.
 * Phase 9: 서재 책장 — `ShipState.books` (one `PlacedBook` per filled shelf slot) + `bookDex`; the 서재 multiplier
 * (`getBookBonus`, Rules.bookGainMulFor) is folded into `getSkillGainMul`, so progression/ reads one number.
 * 온실 개편 (2026-09-11): 재배 스테이션 — `ShipState.grows` (토양 · 씨앗이 든 칸) replaces the retired 재배층's
 * `plots`; the rules live in `Rules.ts` (층 개방 · 궁합 · 성장 시간) and the screen in `ui/GrowStation.ts`.
 */
