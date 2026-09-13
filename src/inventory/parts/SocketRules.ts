/**
 * src/inventory/parts/SocketRules.ts — **로드할 때 더는 맞지 않는 부착물을 떼어 돌려준다** (2026-09-14 총기 밸런스, 사용자 결정
 * "로드할 때 떼어서 돌려주기").
 *
 * 무기 계열마다 받는 소켓이 정해지면서(`data/weapons.csv` 의 `sockets` → `LootRef.canAttach`) 옛 세이브의 산탄총 개머리판 ·
 * 지정사수소총 손잡이 같은 부착물이 규칙 밖이 됐다. 그런 부착물은 스탯에 이미 반영되지 않지만(`items/WeaponStats.computeWeaponStats`
 * 가 건너뛴다) 무기에 매달린 채로 두지 않고 세이브를 읽는 자리에서 떼어 격자로 돌려준다. **아이템은 사라지지 않는다** — 넣을 자리가
 * 없으면 무기에 그대로 남기고(효과 없음) 다음 로드에서 다시 시도한다.
 *
 *   - 로드아웃(로컬 파일 · 서버 문서) — `'stash'`: 함선 창고 → 가방 → 무기에 남김. 옮겼으면 **호출부가 로드아웃도 저장 표시**를
 *     한다 (창고만 저장되면 다음 로드에서 같은 부착물이 한 번 더 창고로 간다 — 둘은 `scheduleSaves` 한 번에 같이 올라간다).
 *   - 레이드 세션 blob — `'bag'`: 가방 → 무기에 남김. 레이드 도중 함선 창고로 보내면 죽어도 잃지 않는 보관이 되므로 창고는 쓰지 않는다.
 *     blob 은 game/ 의 주기 저장이 다시 찍는다.
 *   - 창고 문서는 `Stash.load` 가 같은 `Serialize.detachForbiddenSockets` 로 창고 안에서 처리한다.
 */
import type { ItemDef, ItemInstance } from '@/shared';
import { ITEM_DEF_MAP } from '@/items';
import { LOADOUT_SLOTS } from '../model';
import { detachForbiddenSockets } from '../Serialize';
import type { InventorySystem } from '../InventorySystem';

/**
 * Detach every attachment a weapon in the loadout slots / bag / 주머니 no longer accepts and find it a cell (see the file header).
 * Returns how many left their weapon (0 = nothing changed). Marks the 창고 dirty when it took one; the loadout save is the caller's.
 */
export function returnForbiddenAttachments(sys: InventorySystem, to: 'stash' | 'bag'): number {
  const getDef = (id: string): ItemDef | undefined => ITEM_DEF_MAP.get(id);
  const weapons: ItemInstance[] = [];
  for (const s of LOADOUT_SLOTS) { const it = sys.loadout[s]; if (it?.sockets) weapons.push(it); }
  for (const p of sys.bag.items()) if (p.item.sockets) weapons.push(p.item);
  for (const p of sys.pouch.items()) if (p.item.sockets) weapons.push(p.item);
  let moved = 0;
  let toStash = 0;
  for (const weapon of weapons) {
    for (const { socket, item } of detachForbiddenSockets(weapon, getDef, sys.loot)) {
      if (to === 'stash' && sys.stash.grid.autoPlace(item)) { moved++; toStash++; continue; }
      if (sys.bag.autoPlace(item)) { moved++; continue; }
      (weapon.sockets ??= {})[socket] = item;
      console.warn(`[Loadout] no room for '${item.defId}' taken off '${weapon.defId}' — left on the weapon (no effect)`);
    }
  }
  if (moved > 0) console.info(`[Loadout] ${moved} attachment(s) no longer fit their weapon — returned to the ${to === 'stash' ? '함선 창고 / 가방' : '가방'}`);
  if (toStash > 0) sys.stash.markDirty();
  return moved;
}
