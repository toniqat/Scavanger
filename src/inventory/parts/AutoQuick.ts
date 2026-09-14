/**
 * src/inventory/parts/AutoQuick.ts — **소모품 퀵슬롯 자동 장착** (2026-09-14, 사용자 결정 · `docs/DECISIONS.md` 「2026-09-14 — 튜토리얼 개편」).
 *
 * 답하는 질문 하나: *지금 손에 들어온 이 스택을 빈 휠 칸에 앉힐까.*
 *
 * **튜토리얼 전용이 아니라 게임 전역 규칙이다.** 주운 소모품(회복제 · 수류탄 · 휠에 올라가는 가젯)이 퀵슬롯에 올릴 수 있는
 * 종류이고 **빈 칸이 있으면** 그 칸에 올라간다. 이미 같은 종류가 휠에 있으면 빈 칸을 새로 먹지 않고 **그쪽에 합쳐진다**
 * (합치기는 예전부터 `QuickSlots.mergeIntoQuick` 이 `tryAddItem` 안에서 하던 일이라 여기서 다시 하지 않는다 — 이 파일은
 * 「합치고 남은 것」만 본다). 빈 칸이 없으면 평소대로 가방이다.
 *
 * **「퀵슬롯은 가방 격자가 아니다」(2026-09-09) 를 그대로 지킨다** — 휠에 올리는 것은 **옮기기**이지 복사가 아니다.
 * 그래서 이 파일에는 스택을 만드는 코드도, 수량을 베끼는 코드도 없다: 격자에 있는 스택은 `InventorySystem.setQuickSlot`
 * (컨테이너 출처의 `searched` · `emitTransfer` · 밀려난 스택 규칙을 전부 갖고 있다)이 옮기고, 아직 어느 격자에도 없는
 * 스택(`tryAddItem`)만 부르는 쪽이 칸에 바로 앉힌다. 무게 · `countWhere` · `consumeWhere` · `stripForCorpse` · 레이드 blob
 * 이 휠을 함께 보는 기존 동작은 한 줄도 바뀌지 않는다.
 *
 * **거는 자리는 「밖에서 내 손에 들어왔다」 세 지점뿐이다** (규칙은 여기 한 벌, 경로마다 베끼지 않는다):
 *
 *   ① `InventorySystem.tryAddItem` — 인벤토리 **밖에서** 들어오는 모든 아이템의 유일한 관문이다. 월드 픽업(E · 원격 확정
 *      `pickups/PickupSystem.addToBag`) · 채집(`world/Gather`) · 보급 탄약(`weapons/parts/Slots`) · 설치물 회수
 *      (`gadgets/parts/Deploy`) · 콘솔 지급이 전부 이 함수를 지난다. 상점 · 제작 · 수확 · 튜토리얼 지급은
 *      `tryAddItemAnywhere`(가방 → 함선 창고)라 여기를 지나지 않는다 — 「주웠다」의 규칙이지 「받았다」의 규칙이 아니다.
 *   ② `DropResolver.takeOne` — 컨테이너(상자 · 시체)의 **「모두 가져가기」**. 사람이 목적지를 고르지 않는다.
 *   ③ `DropResolver.activateImpl` 의 컨테이너 갈래 — 상자 · 시체 타일 **더블클릭**. 역시 목적지를 고르지 않고,
 *      가방 타일의 더블클릭이 이미 「휠에 등록」인 것(`ui/InventoryUI.tileHandlers`)과 같은 몸짓이다.
 *
 * **일부러 거르지 않은 곳**: 드래그(사람이 칸을 찍었다)와 우클릭 메뉴의 「빠른 이동 (가방)」(라벨이 목적지를 약속한다).
 * 그 둘까지 가로채면 화면이 거짓말을 한다 — 메뉴에는 「빠른 슬롯에 등록」 항목이 따로 있다.
 *
 * 2026-09-10 의 **「상자에서 찾은 것은 무조건 가방이 먼저다」** 와 부딪히지 않는다: 그 결정이 막으려던 것은 *주우면서 지금
 * 든 총 · 방탄복이 조용히 바뀌는 것*(장비 칸)이고, 휠 칸은 비어 있을 때만 채워지므로 손에 든 것을 밀어내지 않는다.
 */
import type { ItemDef, ItemInstance } from '@/shared';
import { firstFreeQuickSlot, isQuickUsable } from '../QuickSlots';
import type { InventorySystem } from '../InventorySystem';

/**
 * 이 스택이 자동으로 올라갈 **빈 휠 칸**, 없으면 -1.
 *
 *  - 휠에 올릴 수 있는 종류인가 (`QUICK_USABLE_CATEGORIES`)
 *  - 아직 감정하지 않은 컨테이너 스택은 어디로도 못 간다 (`searched === false` — 격자 · 휠 어디서나 같은 규칙)
 *  - 이미 휠에 있는 스택은 자기 칸을 옮기지 않는다
 *  - **같은 종류가 이미 휠에 있으면 빈 칸을 새로 먹지 않는다** — 그 스택이 `stackMax` 라 합쳐지지 못하고 남은
 *    것이라도 마찬가지다. 한 종류가 휠 칸 둘을 차지하면 휠의 뜻(한 칸 = 한 종류)이 무너지고, 남은 단위는
 *    예전처럼 가방 스택이 된다 (2026-09-09 의 「합치고 넘친 것」 규약 그대로).
 *  - 잠금 · 가방 등급을 아는 곳은 `firstFreeQuickSlot(slots, active)` 하나다
 */
export function autoQuickIndexFor(sys: InventorySystem, item: ItemInstance, def: ItemDef): number {
  if (!isQuickUsable(def)) return -1;
  if (item.searched === false) return -1;
  if (sys.quickIndexOf(item.uid) >= 0) return -1;
  for (const slot of sys.quickSlots) if (slot && slot.defId === item.defId) return -1;
  return firstFreeQuickSlot(sys.quickSlots, sys.getQuickSlotCount());
}

/**
 * ②③ 컨테이너 격자의 스택을 빈 휠 칸으로 **옮긴다**. 옮겼으면 true.
 *
 * 실제 이동은 `setQuickSlot` 이다 — 컨테이너 출처의 `searched` 표시 · `emitTransfer`(= `inventory:itemAdded`) ·
 * 밀려난 스택 규칙(여기서는 빈 칸이라 없다) · `afterQuickChange` 를 그 함수가 이미 전부 갖고 있다. 부르는 쪽은
 * 멀티플레이의 `guardedTake` 안(= 호스트가 확인한 뒤)이라 권한 검사도 그대로다.
 */
export function takeIntoQuick(sys: InventorySystem, item: ItemInstance, def: ItemDef): boolean {
  const index = autoQuickIndexFor(sys, item, def);
  return index >= 0 && sys.setQuickSlot(index, item.uid);
}
