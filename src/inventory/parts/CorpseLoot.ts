/**
 * src/inventory/parts/CorpseLoot.ts — **죽으면 들고 있던 것이 전부 시체로 간다** (2026-09-09).
 *
 * 이 파일이 답하는 질문 하나: *플레이어가 완전히 사망했을 때 인벤토리에 무슨 일이 일어나고,
 * 그 내용물이 어떻게 시체 컨테이너가 되는가.*
 *
 * - `stripForCorpse()` — 장비 슬롯 · 가방 격자 · 퀵슬롯을 통째로 뽑아 **빈손**으로 만든다 (사망 처리에서 한 번).
 *   무기의 내구도 · 장전 탄약 · 소켓은 `ItemInstance` 그대로 넘어가므로 보존된다.
 * - `openContainerItemsSized()` — 시체는 상자(6×4)보다 큰 격자를 쓴다 (`PLAYER_CORPSE_COLS × ROWS`).
 * - `primeCorpseContainers()` — 멀티에서 **호스트가 열어 보지도 않은 시체**의 `contq take` 를 심판할 수 있도록
 *   `pcorpse` 와이어를 받는 즉시 컨테이너를 만들어 둔다. 가져가기 자체는 기존 `cont` / `contq` 경로 그대로다.
 */
import * as THREE from 'three';
import type { CorpseItemWire, GameContext, ItemInstance, PlayerCorpseWire } from '@/shared';
import { PLAYER_CORPSE_COLS, PLAYER_CORPSE_ROWS } from '@/shared';
import { LOADOUT_SLOTS } from '../model';
import type { InventorySystem } from '../InventorySystem';

/** `pcorpse:...` 컨테이너 격자 (상자보다 크다 — 사망 시점의 장비 + 가방이 전부 들어가야 한다). */
export function corpseGridSize(): { cols: number; rows: number } {
  return { cols: PLAYER_CORPSE_COLS, rows: PLAYER_CORPSE_ROWS };
}

/**
 * 사망 시점의 전부 — 장비 슬롯(무기 3 · 방어구 · 가방) · 가방 격자 · 퀵슬롯 — 을 하나의 목록으로 뽑고
 * 로컬 인벤토리를 비운다. **완전 빈손 부활**(사용자 결정): 구조선으로 돌아와도 아무것도 돌려받지 않는다.
 *
 * 임플란트 아이템은 `ctx.progression` 이 들고 있고 `unequipImplant` 는 함선 전용이라 여기서 뺄 수 없다
 * (폴더 README 의 `알려진 한계` 참고).
 */
export function stripForCorpse(sys: InventorySystem): ItemInstance[] {
  const out: ItemInstance[] = [];
  for (const s of LOADOUT_SLOTS) {
    const it = sys.loadout[s];
    if (it) out.push(it);
  }
  for (const p of sys.bag.items()) out.push(p.item);
  // 2026-09-09: the wheel is its own container — its stacks are carried too, so they go on the corpse as well
  for (const it of sys.quickSlots) if (it) out.push(it);

  sys.closeAll();
  sys.loadout = { primary: null, primary2: null, secondary: null, bag: null, armor: null };
  sys.bag.clear();
  const size = sys.bagSizeOf(null);
  sys.bag.resize(size.cols, size.rows);
  sys.quickSlots.fill(null);
  sys.strippedForCorpse = true;
  sys.lastGrenades = -1; sys.lastStims = -1; sys.lastQuickSig = '';
  sys.ctx.bus.emit('inventory:bagChanged', { ...size, dropped: [] });
  sys.emitLoadout();
  sys.afterChange();
  // a reload after death must not resurrect the kit that is now lying on the ground
  sys.announcePending = false;
  sys.loadoutStore.saveNow('corpse');
  return out;
}

/**
 * `openContainerItems` 와 같지만 격자 크기를 지정한다. 이미 아는 id 면 `items` · 크기 모두 무시하고
 * 남은 내용물을 보여 준다 (컨테이너 캐시가 진실이다).
 */
export function openContainerItemsSized(sys: InventorySystem, containerId: string, items: ItemInstance[],
  position: THREE.Vector3, cols: number, rows: number, title?: string): void {
  const first = !sys.openedIds.has(containerId);
  sys.openedIds.add(containerId);
  const c = sys.containers.getOrCreateWithItems(containerId, items, position, title, { cols, rows });
  sys.showContainer(c);
  sys.ctx.bus.emit('inventory:containerOpened', { containerId, first });
}

/** `CorpseItemWire[]` → 실제 인스턴스 (내구도 · 장전 · 소켓은 `ex` 로 실려 온다). */
export function corpseItemsFromWire(sys: InventorySystem, wire: readonly CorpseItemWire[]): ItemInstance[] {
  const out: ItemInstance[] = [];
  for (const w of wire) {
    if (!w || typeof w.defId !== 'string') continue;
    const item = sys.loot.createItem(w.defId, Math.max(1, Math.floor(w.qty || 1)), w.ex);
    if (item) out.push(item);
  }
  return out;
}

/**
 * 시체 컨테이너를 **열지 않고** 만들어 둔다. 호스트는 자기가 한 번도 열어 본 적 없는 시체에 대한
 * `contq take` 도 심판해야 하고, 클라이언트는 늦게 합류해도 같은 `idx` 순서를 가져야 한다.
 * 이미 아는 id 는 그대로 둔다.
 */
export function primeCorpseContainer(sys: InventorySystem, wire: PlayerCorpseWire): void {
  if (!wire || typeof wire.id !== 'string' || sys.containers.get(wire.id)) return;
  const p = wire.p;
  const pos = new THREE.Vector3(p?.[0] ?? 0, p?.[1] ?? 0, p?.[2] ?? 0);
  sys.containers.getOrCreateWithItems(wire.id, corpseItemsFromWire(sys, wire.items ?? []), pos,
    `${wire.name ?? '분대원'}의 유해`, corpseGridSize());
}

/** `pcorpse` 구독 — 와이어가 도착하는 즉시 컨테이너를 만든다 (`init` 에서 한 번). */
export function hookCorpseWire(sys: InventorySystem, ctx: GameContext): (() => void) | null {
  const net = ctx.net;
  if (!net || typeof net.onMessage !== 'function') return null;
  return net.onMessage('pcorpse', (msg) => {
    if (msg.ev === 'spawn') primeCorpseContainer(sys, msg.corpse);
    else if (msg.ev === 'sync') for (const c of msg.corpses ?? []) primeCorpseContainer(sys, c);
  });
}
