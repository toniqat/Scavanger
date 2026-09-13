/**
 * src/inventory/parts/ShelfWanted.ts — **「아직 서재에 꽂지 않은」 띠** (2026-09-13, 서재 시리즈 · 사용자 결정, docs/plans/library-series-games.md §5).
 *
 * 답하는 질문: *이 책 · 비디오 · 레코드 타일에 즐겨찾기와 같은 파란 띠를 그릴까.*
 *
 *  - 규칙의 주인은 housing 이다: `HousingRef.isShelfItemWanted(defId)` = 그 매체의 보관함을 **보유**(배치 · 가구 창고)하고 있고
 *    같은 종류가 **어느 보관함에도 꽂혀 있지 않다**. 여기는 그 질의를 타일 그리기(`ui/GridView`)에 거는 자리일 뿐이다.
 *  - 질의가 없는 housing(병렬 작업 중 · 스켈레톤)에서는 언제나 false — 띠가 안 뜰 뿐 아무것도 깨지지 않는다.
 *  - 답은 def 당 한 번 캐시된다 (`GridView.isShelfWantedDef`). 서재 · 보관함이 바뀔 수 있는 사건에서 캐시를 비우고(`bumpShelfWanted`)
 *    열린 창을 한 번만 다시 칠한다. 사건 목록은 넉넉하다 — 비우는 비용은 다음 그리기 때 def 수만큼의 질의뿐이다.
 *  - 즐겨찾기 표와는 **완전히 따로**다: 정렬 앞 · 「즐겨찾기」 필터 · 분해/판매 확인 · 컨테이너 글로우 · 저장은 전부 진짜 즐겨찾기만 본다.
 */
import type { GameContext, GameEvents } from '@/shared';
import { bumpShelfWanted, setShelfWantedSource } from '../ui/GridView';
import type { InventorySystem } from '../InventorySystem';

/** 띠의 답이 바뀌었을 수 있는 사건 — `housing:libraryChanged` 가 원본이고 나머지는 옛 · 병렬 housing 을 위한 안전망이다. */
const BUMP_EVENTS: readonly (keyof GameEvents)[] = [
  'housing:libraryChanged', 'housing:loaded', 'housing:shelfChanged', 'housing:booksChanged',
  'housing:furniturePlaced', 'housing:furnitureRecovered', 'net:profileLoaded',
];

/** housing 에 묻는다 — 질의가 없으면 false. */
export function isShelfWanted(ctx: GameContext, defId: string): boolean {
  const h = ctx.housing;
  if (!h || typeof h.isShelfItemWanted !== 'function') return false;
  try { return h.isShelfItemWanted(defId) === true; } catch { return false; }
}

/** 공급자를 걸고 사건을 구독한다. 돌려준 함수들을 `offs` 에 넣는다. */
export function installShelfWanted(sys: InventorySystem): Array<() => void> {
  const ctx = sys.ctx;
  setShelfWantedSource((defId) => isShelfWanted(ctx, defId));
  let queued = false;
  const onChange = (): void => {
    bumpShelfWanted();
    if (queued) return;
    queued = true;
    // 한 번에 여러 사건(가구 회수 → 서재 합산)이 와도 창은 한 번만 다시 칠한다
    queueMicrotask(() => { queued = false; if (sys._open) sys.ui?.onShelfWantedChanged(); });
  };
  const offs = BUMP_EVENTS.map((name) => ctx.bus.on(name, onChange as never));
  offs.push(() => setShelfWantedSource(null));
  return offs;
}
