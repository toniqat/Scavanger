/**
 * src/housing/parts/Deliver.ts — **수확물을 어느 격자에 넣는가** (2026-09-12).
 *
 * 재배 스테이션 · 분석기 · 배양조가 산출물 하나를 플레이어에게 건네는 단 하나의 길이다. 예전에는 셋이 각자
 * `tryAddItemAnywhere`(가방 → 함선 창고)를 불렀는데, 화면이 「더블클릭 = 함선 창고 먼저」 · 「가방 격자에 끌어다
 * 놓기 = 가방에만」을 고를 수 있어야 해서 여기로 모았다 (`HarvestDestination`, 계약).
 *
 * 이름이 붙은 격자(`'bag'` · `'stash'`)는 **다른 격자로 넘치지 않는다** — 끌어다 놓은 곳이 가득이면 거절이다.
 */
import type { HarvestDestination, ItemInstance } from '@/shared';
import type { HousingSystem } from '../HousingSystem';

/**
 * **커서가 놓인 칸** (2026-09-16, 사용자 보고 「장착된 것을 끌어서 뺄 때 커서가 놓인 그리드 칸으로 가야 한다」).
 *
 * 예전에는 어느 화면에서 끌어내든 `tryAddItem*` 이 **첫 빈 칸**을 골랐다 — 놓은 자리와 들어간 자리가 달랐다.
 * 이제 끌어서 놓는 경로(`ui/ProductDrag`)가 「이 좌표에 놓았다」를 여기 한 번 적어 두고, 그 사이에 일어나는
 * **한 번의 전달**만 그 칸으로 간다. 함수 서명을 바꾸지 않는 이유는 전달이 규칙 함수 깊은 곳에서 일어나기
 * 때문이다 (`takeShelfItem` · `removeClusterCores` · `harvestAt` … — 전부 `deliverItem` 하나로 모인다).
 * ⚠ 동기 호출 한 벌 동안만 산다: `withDropCell` 이 `finally` 로 반드시 지운다.
 */
interface DropCell {
  view: { placeExternalAt(item: ItemInstance, x: number, y: number): 'bag' | 'stash' | 'blocked' | null };
  x: number;
  y: number;
}
let dropCell: DropCell | null = null;

/** Run `fn` with "the player dropped it here" set (null = the plain rule). Always cleared, even when `fn` throws. */
export function withDropCell<T>(cell: DropCell | null, fn: () => T): T {
  const prev = dropCell;
  dropCell = cell;
  try { return fn(); } finally { dropCell = prev; }
}

/**
 * 방금 전달이 **놓은 칸** 때문에 막혔는가 (2026-09-16). 사유 문구를 고르는 `noRoomReason` 이 바로 뒤에
 * 물어보고 지운다 — 가방이 텅 비었는데 「가방에 자리가 없습니다」라고 말하지 않기 위한 한 칸짜리 기억이다.
 */
let blockedCell = false;

/** Put `item` where `dest` says. Returns the grid it landed in, or null when there was no room. */
export function deliverItem(sys: HousingSystem, item: ItemInstance, dest: HarvestDestination = 'bag-first'): 'bag' | 'stash' | null {
  const inv = sys.ctx.inventory;
  if (!inv) return null;
  const cell = dropCell;
  if (cell) {
    dropCell = null;                 // **한 번만** 쓴다 (여러 번 전달하는 규칙의 두 번째부터는 평소 규칙이다)
    const at = cell.view.placeExternalAt(item, cell.x, cell.y);
    // 칸 위에 놓았으면 그 칸이 답이다 — 막힌 칸이면 **다른 칸으로 밀어넣지 않고** 거절한다 (놓은 자리가 곧 결과다).
    if (at) { blockedCell = at === 'blocked'; return at === 'blocked' ? null : at; }
    // null = 격자 밖(머리줄 · 여백)에 놓았다 → 아래의 평소 규칙으로 간다
  }
  const bag = (): 'bag' | null => (typeof inv.tryAddItem === 'function' && inv.tryAddItem(item) ? 'bag' : null);
  const stash = (): 'stash' | null => (typeof inv.tryAddToStash === 'function' && inv.tryAddToStash(item) ? 'stash' : null);
  switch (dest) {
    case 'bag': return bag();
    case 'stash': return stash();
    case 'stash-first': return stash() ?? bag();
    default:
      return typeof inv.tryAddItemAnywhere === 'function' ? inv.tryAddItemAnywhere(item) : bag();
  }
}

/** 한국어 「자리가 없다」 사유 — 고른 격자를 그대로 말한다. */
export function noRoomReason(dest: HarvestDestination = 'bag-first'): string {
  if (blockedCell) { blockedCell = false; return '그 칸에는 놓을 수 없습니다'; }
  if (dest === 'bag') return '가방에 자리가 없습니다';
  if (dest === 'stash') return '함선 창고에 자리가 없습니다';
  return '가방과 창고에 자리가 없습니다';
}
