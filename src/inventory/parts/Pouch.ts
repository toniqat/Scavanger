/**
 * src/inventory/parts/Pouch.ts — **주머니는 가방 격자가 아니다** (2026-09-11, A-15 사용자 결정).
 *
 * 장비칸 `pouch` 한 칸(`POUCH_SLOTS` = 1, 넷 중 하나만)에 끼운 주머니가 **퀵슬롯 아래에 자기 격자**를 연다.
 * 2026-09-09 의 「퀵슬롯은 가방 격자가 아니다」가 세운 패턴 그대로다:
 *
 *   - 무게 · `countWhere` · `consumeWhere` · `getTotalValue` · `stripForCorpse` · 레이드 blob 은 주머니를 **본다**
 *   - `getAllItems()`(거래 · 수리 목록)는 **여전히 가방 격자만**이다
 *   - 주머니를 빼는데 내용물이 가방에 안 들어가면 **이동 자체를 거절한다** (`setQuickSlot` 과 같은 규약 —
 *     주머니 안의 물건을 조용히 버리지 않는다)
 *
 * 여기에 없는 것: `ItemLocation` / `DropTarget` 의 새 종류. 주머니 격자는 그냥 `{ kind: 'grid', grid: 'pouch' }` 다.
 */
import type { ItemDef, ItemInstance, PouchDef } from '@/shared';
import { ITEM_DEF_MAP } from '@/items';
import type { Grid, Placement, GridSnapshot } from '../Grid';
import { pouchAcceptsDef, type GridId, type ItemLocation, type OpResult } from '../model';
import type { InventorySystem } from '../InventorySystem';

/** 주머니가 없을 때의 격자 크기 — `Grid.resize` 는 0 을 받지 않으므로 1×1 로 비워 둔다 (아무도 그리지 않는다). */
const EMPTY_POUCH_SIZE = { cols: 1, rows: 1 } as const;

/** 지금 장착한 주머니 아이템, 없으면 null (`InventoryRef.getEquippedPouch`). */
export function getEquippedPouch(sys: InventorySystem): ItemInstance | null {
  return sys.loadout.pouch ?? null;
}

/** 장착한 주머니의 `PouchDef`, 없으면 null. */
export function pouchDefOf(sys: InventorySystem): PouchDef | null {
  const it = sys.loadout.pouch;
  if (!it) return null;
  return ITEM_DEF_MAP.get(it.defId)?.pouch ?? null;
}

/**
 * 장착한 주머니의 격자 크기 (`InventoryRef.getPouchSize`). 주머니가 없으면 `{ cols: 0, rows: 0 }` —
 * **그 자리를 통째로 안 그린다**는 뜻이다 (내부 `Grid` 는 1×1 로 비어 있다).
 */
export function getPouchSize(sys: InventorySystem): { cols: number; rows: number } {
  const p = pouchDefOf(sys);
  return p ? { cols: p.cols, rows: p.rows } : { cols: 0, rows: 0 };
}

/** 이 아이템을 지금 장착한 주머니가 받아 주는가. 주머니가 없으면 언제나 false (격자 자체가 없다). */
export function pouchAccepts(sys: InventorySystem, def: ItemDef | undefined): boolean {
  return pouchAcceptsDef(pouchDefOf(sys), def);
}

/** 주머니 격자의 스택들 (빈손이면 빈 배열). */
export function pouchItems(sys: InventorySystem): ItemInstance[] {
  return sys.pouch.items().map((p) => p.item);
}

/** 주머니 격자의 가치 합 (`getTotalValue` 가 가방 · 휠과 함께 더한다). */
export function pouchTotalValue(sys: InventorySystem): number {
  return sys.pouch.totalValue();
}

/**
 * 격자 · 스택 변화 감지용 서명 — `emitPouchChanged` 가 이것으로 게이트한다 (`quickSlotsSignature` 가 본보기).
 * 크기까지 담으므로 주머니를 바꾸면 반드시 이벤트가 난다.
 */
export function pouchSignature(sys: InventorySystem): string {
  const size = getPouchSize(sys);
  let s = `${sys.loadout.pouch?.uid ?? ''}|${size.cols}x${size.rows}`;
  for (const p of sys.pouch.items()) s += `|${p.item.uid}:${p.item.qty}@${p.x},${p.y}`;
  return s;
}

/** `inventory:pouchChanged` — 바뀐 것이 있을 때만 (`afterChange` 가 매번 부른다). */
export function emitPouchChanged(sys: InventorySystem): void {
  const sig = pouchSignature(sys);
  if (sig === sys.lastPouchSig) return;
  sys.lastPouchSig = sig;
  sys.ctx.bus.emit('inventory:pouchChanged', {});
}

/**
 * 주머니 격자를 **장착한 주머니에 맞춰** 비우고 다시 연다 (킷 리셋 · 스타터 · 시체 벗기기 전용 — 내용물은
 * 호출한 쪽이 이미 챙겼다).
 */
export function resetPouchGrid(sys: InventorySystem): void {
  const size = getPouchSize(sys);
  sys.pouch.clear();
  sys.pouch.resize(size.cols || EMPTY_POUCH_SIZE.cols, size.rows || EMPTY_POUCH_SIZE.rows);
}

/** 주머니 격자를 그 자리에서 비우고 내용물을 돌려준다 (`stripForCorpse`). */
export function drainPouch(sys: InventorySystem): ItemInstance[] {
  const out = pouchItems(sys);
  sys.pouch.clear();
  return out;
}

/** 되돌리기용 스냅샷 묶음 — 같은 `Grid` 를 두 번 찍지 않는다. */
type Snaps = { grid: Grid; snap: GridSnapshot }[];

function snapshot(grids: (Grid | null | undefined)[]): Snaps {
  const out: Snaps = [];
  for (const g of grids) {
    if (!g || out.some((e) => e.grid === g)) continue;
    out.push({ grid: g, snap: g.snapshot() });
  }
  return out;
}

function rollback(snaps: Snaps): void {
  for (const e of snaps) e.grid.restore(e.snap);
}

/**
 * 주머니를 갈아 끼운다 (`next` null = 벗는다). `changeBag` 이 본보기이지만 **거절 규칙이 하나 더** 있다:
 *
 *   ① 새 주머니가 못 받는(또는 자리가 없는) 내용물은 **가방**으로 간다. 하나라도 못 들어가면 **전부 되돌리고
 *      이동 자체를 거절한다** — 주머니 안의 물건은 조용히 바닥에 떨어지지 않는다 (퀵슬롯 규약 그대로).
 *   ② 벗은 주머니 자신도 `oldTo === 'grid'` 면 `dest` 격자(기본 가방)에 들어가야 한다. 못 들어가면 역시 거절.
 *
 * `oldTo === 'world'` 는 예전 주머니를 바닥에 던진다 (함선에서는 `throwToWorld` 가 창고로 보낸다).
 * `from` null + `next` = 어느 격자에도 없는 인스턴스(무한 상자 드래그).
 */
export function changePouch(
  sys: InventorySystem,
  next: ItemInstance | null,
  from: ItemLocation | null,
  oldTo: 'grid' | 'world',
  hint?: { x: number; y: number },
  dest: GridId = 'bag',
): OpResult {
  const old = sys.loadout.pouch ?? null;
  if (!next && !old) return 'noop';
  if (next && old && next.uid === old.uid) return 'noop';
  const nextDef = next ? ITEM_DEF_MAP.get(next.defId) : undefined;
  if (next && !nextDef?.pouch) return 'fail';

  const srcGrid = from?.kind === 'grid' ? sys.getGrid(from.grid) : null;
  const destGrid = sys.getGrid(dest) ?? sys.bag;
  const snaps = snapshot([sys.pouch, sys.bag, srcGrid, destGrid]);

  let srcPos: Placement | undefined;
  if (next && from) {
    if (from.kind !== 'grid' || !srcGrid) return 'fail';
    srcPos = srcGrid.get(next.uid);
    if (!srcPos) return 'fail';
    srcGrid.remove(next.uid);
  }

  const refuse = (blocked: ItemInstance | null): OpResult => {
    rollback(snaps);
    if (next && srcGrid && srcPos) srcGrid.place(next, srcPos.x, srcPos.y, next.rotated);
    if (blocked) {
      const d = ITEM_DEF_MAP.get(blocked.defId);
      if (d) sys.ctx.bus.emit('inventory:full', { item: blocked, name: d.name });
    }
    return 'fail';
  };

  // ① 내용물 — 새 주머니가 받는 것만 남기고 나머지는 가방으로 (하나라도 못 가면 전부 되돌린다)
  const contents = pouchItems(sys);
  const accepts = nextDef?.pouch ?? null;
  sys.pouch.clear();
  sys.pouch.resize(accepts?.cols ?? EMPTY_POUCH_SIZE.cols, accepts?.rows ?? EMPTY_POUCH_SIZE.rows);
  const spilled: ItemInstance[] = [];
  for (const it of contents) {
    const d = ITEM_DEF_MAP.get(it.defId);
    if (pouchAcceptsDef(accepts, d) && sys.pouch.autoPlace(it)) continue;
    spilled.push(it);
  }
  for (const it of spilled) {
    if (!sys.bag.autoPlace(it)) return refuse(it);
  }

  // ② 벗은 주머니 자신
  if (old && oldTo === 'grid') {
    const placed = (hint !== undefined && destGrid.place(old, hint.x, hint.y, old.rotated))
      || destGrid.autoPlace(old) || sys.bag.autoPlace(old);
    if (!placed) return refuse(old);
  }

  sys.loadout.pouch = next;
  if (old && oldTo === 'world') sys.throwToWorld(old, true);
  if (next && nextDef && from) sys.emitTransfer(next, nextDef, from, { kind: 'slot', slot: 'pouch' });
  if (old && oldTo === 'grid') {
    const od = ITEM_DEF_MAP.get(old.defId);
    // the grid it really landed in (the `dest` fallback is the bag)
    const landed: GridId = destGrid.has(old.uid) ? dest : 'bag';
    if (od) sys.emitTransfer(old, od, { kind: 'slot', slot: 'pouch' }, { kind: 'grid', grid: landed });
  }
  if (spilled.length > 0) {
    sys.ctx.bus.emit('ui:notify', { text: `주머니에서 아이템 ${spilled.length}개를 가방으로 옮겼습니다`, kind: 'info', duration: 2.2 });
  }
  sys.emitLoadout();
  sys.afterChange();
  return 'ok';
}
