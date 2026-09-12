/**
 * src/inventory/parts/Peek.ts — **이 컨테이너를 지금 열면 무엇이 보이나** (2026-09-12, 드론 스캔).
 *
 * 연 적 없는 컨테이너를 **열지 않고** 들여다본다 (`InventoryRef.peekContainerItems` · `peekSuppliedItems`, 호출자는
 * `gadgets/drones/parts/Scan`). 규칙은 하나다 — **여는 경로와 똑같이 굴리고 똑같이 채운다**. 스캔이 「서사」 라고 했는데
 * 열어 보니 없으면 안 되기 때문이다:
 *  - 굴림: `ContainerStore.getOrCreate` 와 같은 `shared/lootRolls.crateLootRandom(missionSeed, id)` → `loot.rollCrateOn(tier, rng, 행성)`.
 *  - 채우기: `Container.fill` 과 같은 순서 · 같은 크기 격자에 `autoPlace` — 넘쳐서 탈락하는 것 · 스택 병합까지 같다.
 *    시체(`cols` 지정)는 `openContainerItemsSized` 처럼 `fitCorpseGrid` 로 행을 늘린 격자다.
 *  - 남의 가져가기: 이 클라이언트가 아직 열지 않았는데 확정된 `pendingTaken` 을 롤 순서(`idx`)대로 뺀다 (`applyPending`).
 * 이미 굴린 컨테이너는 지금 들어 있는 것을 그대로 돌려준다.
 *
 * 캐시 · `openedIds` · 감정 상태 · 이벤트 어느 것도 건드리지 않는다. 흉내 격자에는 **사본 인스턴스**를 놓으므로 병합으로
 * 줄어드는 `qty` 가 호출자의 목록에 새지 않는다.
 */
import { crateLootRandom, type ItemInstance } from '@/shared';
import { ITEM_DEF_MAP } from '@/items';
import { Grid } from '../Grid';
import { CONTAINER_COLS, CONTAINER_ROWS } from '../Container';
import { fitCorpseGrid } from './CorpseLoot';
import type { InventorySystem } from '../InventorySystem';

const getDef = (defId: string) => ITEM_DEF_MAP.get(defId);

/** 이미 이 클라이언트에 굴려진 컨테이너의 지금 내용물, 없으면 null. */
function current(sys: InventorySystem, id: string): readonly ItemInstance[] | null {
  const c = sys.containers.get(id);
  return c ? c.grid.items().map((p) => p.item) : null;
}

/** `Container.fill` + `ContainerStore.applyPending` 을 사본 격자에서. */
function simulateFill(sys: InventorySystem, id: string, items: readonly ItemInstance[], cols: number, rows: number): ItemInstance[] {
  const grid = new Grid(Math.max(1, Math.floor(cols)), Math.max(1, Math.floor(rows)), getDef);
  const order: string[] = [];
  for (const it of items) {
    if (!it) continue;
    const copy: ItemInstance = { ...it };
    order.push(copy.uid);
    grid.autoPlace(copy);
  }
  for (let idx = 0; idx < order.length; idx++) {
    const n = sys.containers.pendingTakenOf(id, idx);
    if (n <= 0) continue;
    const p = grid.get(order[idx]);
    if (!p) continue;
    const removed = Math.min(n, p.item.qty);
    p.item.qty -= removed;
    if (p.item.qty <= 0) grid.remove(order[idx]);
  }
  return grid.items().map((p) => p.item);
}

/** 상자 · 보급 상자 · 이미 굴린 컨테이너. `tier` 없이 모르는 id 면 null. */
export function peekContainerItems(sys: InventorySystem, containerId: string, tier?: number): readonly ItemInstance[] | null {
  if (typeof containerId !== 'string' || !containerId) return null;
  const cur = current(sys, containerId);
  if (cur) return cur;
  if (typeof tier !== 'number' || !Number.isFinite(tier) || tier < 1) return null;
  const rng = crateLootRandom(sys.missionSeed, containerId);   // `ContainerStore.getOrCreate` 와 같은 `shared/lootRolls` 식
  return simulateFill(sys, containerId, sys.loot.rollCrateOn(tier, rng, sys.ctx.missionPlanet), CONTAINER_COLS, CONTAINER_ROWS);
}

/** 내용물을 호출자가 대는 컨테이너 (시체 · 열쇠가 든 구조물 컨테이너). */
export function peekSuppliedItems(sys: InventorySystem, containerId: string, items: readonly ItemInstance[],
  cols?: number, rows?: number): readonly ItemInstance[] {
  const cur = typeof containerId === 'string' && containerId ? current(sys, containerId) : null;
  if (cur) return cur;
  const list = Array.isArray(items) ? items : [];
  if (typeof cols !== 'number' || !Number.isFinite(cols)) return simulateFill(sys, containerId, list, CONTAINER_COLS, CONTAINER_ROWS);
  const size = fitCorpseGrid(list, cols, typeof rows === 'number' && Number.isFinite(rows) ? rows : cols);
  return simulateFill(sys, containerId, list, size.cols, size.rows);
}
