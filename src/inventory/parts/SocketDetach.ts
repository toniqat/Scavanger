/**
 * src/inventory/parts/SocketDetach.ts — **소켓 하나 꺼내기** (2026-09-14, 고정 툴팁에서 부착물 끌어내기).
 *
 * `attachFromImpl`(`parts/DropResolver`)의 거울이다. 고정한 무기 툴팁(`ui/TipPin`)의 소켓 썸네일을 끌어 가방 · 함선 창고 ·
 * 주머니 칸이나 버리기 영역에 놓으면 여기로 온다. 규칙:
 *  - 무기는 **소켓을 만질 수 있는 자리**에 있어야 한다 — `canSocketAt`(가방 · 장비칸 · 함선 창고). 상자 · 시체 안의 무기는
 *    남의 물건이라 꺼낼 수 없다 (고정 툴팁은 호버 카드만 보여 준다).
 *  - 격자 칸은 **가리킨 칸에 그대로** 들어가야 한다. 막혀 있으면 거절하고 부착물은 소켓에 그대로 남는다 — 아이템을 잃지 않는다.
 *    함선 창고는 함선에서만, 주머니는 `PouchDef.accepts` 가 받을 때만이다.
 *  - 바닥(`world`)은 **레이드에서만** — 함선에는 바닥이 없다 (그곳의 버리기는 창고로 가는데, 끌어내기에서는 창고 칸을 직접 가리키면 된다).
 *  - 이벤트 순서는 부착과 같다: `inventory:socketChanged {attachment: null}` → `afterSocketChange`(탄창이 줄면 넘치는 탄을 가방으로,
 *    `inventory:itemUpdated`) → `afterChange`(`inventory:changed` · 저장). 창고 ↔ 가방처럼 소유가 바뀌는 이동은 `emitTransfer` 가
 *    획득 / 제거 이벤트를 낸다.
 */
import type { ItemDef, ItemInstance, SocketSlot } from '@/shared';
import { ITEM_DEF_MAP, isWeaponItemDef } from '@/items';
import { clearSocket, setSocket } from '../Sockets';
import { canSocketAt } from './DropResolver';
import type { DetachTarget, ItemLocation, OpResult } from '../model';
import type { InventorySystem } from '../InventorySystem';

interface ResolvedSocket {
  weapon: ItemInstance;
  from: ItemLocation;
  att: ItemInstance;
  def: ItemDef;
}

function resolveSocket(sys: InventorySystem, weaponUid: string, socket: SocketSlot): ResolvedSocket | null {
  const w = sys.locate(weaponUid);
  if (!w || !canSocketAt(sys, w.from) || !isWeaponItemDef(ITEM_DEF_MAP.get(w.item.defId))) return null;
  const att = w.item.sockets?.[socket];
  const def = att ? ITEM_DEF_MAP.get(att.defId) : undefined;
  if (!att || !def) return null;
  return { weapon: w.item, from: w.from, att, def };
}

/** 이 무기의 소켓을 끌어낼 수 있는 자리에 있나 (가방 · 장비칸 · 함선 창고). 고정 툴팁이 썸네일을 끌 수 있게 그릴지 정한다. */
export function canDetachSockets(sys: InventorySystem, weaponUid: string): boolean {
  const w = sys.locate(weaponUid);
  return !!w && canSocketAt(sys, w.from) && isWeaponItemDef(ITEM_DEF_MAP.get(w.item.defId));
}

/** 바닥에 버릴 수 있는 때인가 — 레이드(게임플레이 페이즈)에서만. 함선에는 바닥이 없다. */
export function worldDetachAllowed(sys: InventorySystem): boolean {
  return !sys.ctx.isHubPhase() && sys.ctx.isGameplayPhase();
}

/** `detachSocket` 이 지금 성공할까 — 끄는 동안 칸 강조 색(초록 / 빨강)이 이것을 읽는다. 아무것도 바꾸지 않는다. */
export function previewDetach(sys: InventorySystem, weaponUid: string, socket: SocketSlot, target: DetachTarget): 'ok' | 'bad' {
  const r = resolveSocket(sys, weaponUid, socket);
  if (!r) return 'bad';
  if (target.kind === 'world') return worldDetachAllowed(sys) ? 'ok' : 'bad';
  if (target.grid === 'stash' && !sys.ctx.isHubPhase()) return 'bad';
  if (target.grid === 'pouch' && !sys.pouchAccepts(r.def)) return 'bad';
  const grid = sys.getGrid(target.grid);
  if (!grid) return 'bad';
  return grid.canPlace(r.att, target.x, target.y, target.rotated) ? 'ok' : 'bad';
}

/**
 * 무기 `weaponUid` 의 `socket` 에 든 부착물을 `target` 으로 꺼낸다. 막히면 `'fail'` 이고 아무것도 바뀌지 않는다.
 */
export function detachSocket(sys: InventorySystem, weaponUid: string, socket: SocketSlot, target: DetachTarget): OpResult {
  if (previewDetach(sys, weaponUid, socket, target) !== 'ok') return 'fail';
  const r = resolveSocket(sys, weaponUid, socket);
  if (!r) return 'fail';
  const { weapon, from, att, def } = r;
  clearSocket(weapon, socket);
  if (target.kind === 'grid') {
    const grid = sys.getGrid(target.grid);
    if (!grid || !grid.place(att, target.x, target.y, target.rotated)) {
      setSocket(weapon, socket, att);   // 미리보기와 어긋났어도 부착물은 소켓으로 돌아간다 — 잃지 않는다
      return 'fail';
    }
    sys.emitTransfer(att, def, from, { kind: 'grid', grid: target.grid });
  } else {
    sys.throwToWorld(att, sys.locKind(from) === 'player');
  }
  // 무기가 든 격자의 버전을 올려야 그 타일의 소켓 핍이 다시 그려진다 (`GridView` 는 버전 게이트)
  const stash = sys.getGrid('stash');
  if (sys.bag.has(weapon.uid)) sys.bag.version++;
  else if (stash?.has(weapon.uid)) stash.version++;
  sys.ctx.bus.emit('inventory:socketChanged', { weapon, socket, attachment: null });
  sys.afterSocketChange(weapon);
  sys.afterChange();
  return 'ok';
}
