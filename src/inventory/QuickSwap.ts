/**
 * src/inventory/QuickSwap.ts — **퀵슬롯 1:1 교체에서 밀려난 스택이 갈 자리**를 정하는 순수 규칙.
 *
 * 2026-09-10. `setQuickSlot` 은 *옮기기*라서 휠에 이미 있던 스택(= occupant)이 갈 자리를 먼저 찾아야 한다
 * (`InventorySystem.returnQuickToBag` 규약 — 휠 아이템을 조용히 버리거나 바닥에 떨어뜨리지 않는다).
 * 예전에는 그 자리를 **가방에서만** 찾았고, 그래서 **가방이 꽉 차면 교체 자체가 거절**됐다.
 * 하지만 1:1 교체는 가방 여유가 필요 없다 — 들어오는 스택이 격자에서 빠지면서 **그 칸이 비기 때문**이다.
 *
 * 순서(들어오는 스택을 격자에서 뺀 뒤). **출발지가 가방인가**로 갈린다:
 *
 *   가방 → 휠 : ① 들어오는 스택이 **비운 바로 그 칸** (회전 그대로 → 반대로) → ② 가방 아무 데나.
 *   상자·창고 → 휠 : ① **가방** → ② 들어오는 스택이 비운 그 칸(= 그 컨테이너의 빈 자리) → ③ 출발 격자 아무 데나.
 *
 * 어디에도 못 놓으면 null — 호출자는 **아무것도 바꾸지 않고** 거절한다.
 *
 * 컨테이너에서 올 때 가방을 **먼저** 보는 것은 의도한 것이다: 가방에 자리가 있는데 내 소모품을 상자 바닥에
 * 흘려 두고 오면 안 된다 (그 전까지 상자 → 휠 교체는 늘 가방으로 갔고, 자리가 **있을 때**의 그 동작은
 * 한 줄도 바꾸지 않는다 — 이 파일이 고치는 것은 자리가 **없을 때** 통째로 거절되던 쪽이다).
 * 가방에서 올 때 비운 칸이 먼저인 것은 순수한 모양 문제다 — 맞바꾼 스택이 제자리에 앉는 편이 읽기 쉽다
 * (기능상으로는 `bag.autoPlace` 가 어차피 그 칸을 찾는다).
 *
 * 멀티플레이의 **공유 상자**에는 내 물건을 넣을 수 없으므로(호스트 권한, `refusesIntoContainer`) 그때는
 * `allowSource: false` 로 ①③을 건너뛴다.
 *
 * 순수 모듈이다 — 이벤트도 DOM 도 `InventorySystem` 도 모른다 (`__selftest__` 가 격자 두 개로 직접 돌린다).
 */
import type { ItemInstance } from '@/shared';
import type { Grid } from './Grid';

/** 들어오는 스택이 출발 격자에서 차지하고 있던 칸. */
export interface QuickSwapCell { x: number; y: number; rotated: boolean }

/** 밀려난 스택이 실제로 간 곳. */
export type QuickSwapWhere = 'cell' | 'bag' | 'source';

export interface QuickSwapPlan {
  /** 휠에서 밀려나 자리를 찾아야 하는 스택. */
  occupant: ItemInstance;
  /** 가방 격자 (언제나 후보). */
  bag: Grid;
  /** 들어오는 스택이 있던 격자 (가방일 수도 있다). null = 휠 ↔ 휠 재배치라 격자가 없다. */
  source: Grid | null;
  /** 들어오는 스택이 비운 칸. `source` 가 null 이면 무시된다. */
  cell: QuickSwapCell | null;
  /** 들어오는 스택의 uid — 미리보기가 "이건 곧 빠진다" 고 볼 대상. */
  incomingUid: string;
  /** false = 출발 격자에 넣지 않는다 (멀티플레이 공유 상자). */
  allowSource: boolean;
}

/**
 * **아무것도 바꾸지 않고** 교체가 성립하는지 본다 (드래그 하이라이트 · `previewDrop`).
 *
 * 들어오는 스택은 **아직 격자에 있는 채로** 불린다 — 그래서 ①은 그 uid 를 `ignore` 로 넘겨 "곧 비는 칸"으로
 * 읽는다. ②③은 `canAbsorb` 라 그 칸을 세지 않지만(약간 보수적), ①이 이미 그 자리를 대표하므로 문제되지 않는다.
 * 이 함수가 true 인데 `applyQuickSwap` 이 실패하는 일은 없어야 한다 (반대 — 조금 더 보수적인 것 — 은 안전하다).
 */
export function canQuickSwap(plan: QuickSwapPlan): boolean {
  const { occupant, bag, source, cell, incomingUid, allowSource } = plan;
  const ignore = [occupant.uid, incomingUid];
  const intoCell = (): boolean => !!source && !!cell && allowSource
    && (source.canPlace(occupant, cell.x, cell.y, occupant.rotated, ignore)
      || source.canPlace(occupant, cell.x, cell.y, !occupant.rotated, ignore));
  const fromBag = source === bag;
  if (fromBag && intoCell()) return true;
  if (bag.canAbsorb(occupant)) return true;
  if (!fromBag && intoCell()) return true;
  if (source && allowSource && !fromBag && source.canAbsorb(occupant)) return true;
  return false;
}

/**
 * 밀려난 스택을 실제로 놓는다. **들어오는 스택이 이미 격자에서 빠진 뒤에** 부른다.
 * 어디에도 못 놓으면 `null` 이고 격자는 하나도 건드려지지 않는다 (`autoPlace` 는 전부-아니면-전무다).
 */
export function applyQuickSwap(plan: QuickSwapPlan): QuickSwapWhere | null {
  const { occupant, bag, source, cell, allowSource } = plan;
  const intoCell = (): boolean => !!source && !!cell && allowSource
    && (source.place(occupant, cell.x, cell.y, occupant.rotated)
      || source.place(occupant, cell.x, cell.y, !occupant.rotated));
  const fromBag = source === bag;
  if (fromBag && intoCell()) return 'cell';
  if (bag.autoPlace(occupant)) return 'bag';
  if (!fromBag && intoCell()) return 'cell';
  if (source && allowSource && !fromBag && source.autoPlace(occupant)) return 'source';
  return null;
}
