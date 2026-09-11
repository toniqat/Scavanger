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

/** Put `item` where `dest` says. Returns the grid it landed in, or null when there was no room. */
export function deliverItem(sys: HousingSystem, item: ItemInstance, dest: HarvestDestination = 'bag-first'): 'bag' | 'stash' | null {
  const inv = sys.ctx.inventory;
  if (!inv) return null;
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
  if (dest === 'bag') return '가방에 자리가 없습니다';
  if (dest === 'stash') return '함선 창고에 자리가 없습니다';
  return '가방과 창고에 자리가 없습니다';
}
