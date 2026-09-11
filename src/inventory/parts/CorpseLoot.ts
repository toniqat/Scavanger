/**
 * src/inventory/parts/CorpseLoot.ts — **죽으면 들고 있던 것이 전부 시체로 간다** (2026-09-09).
 *
 * 이 파일이 답하는 질문 하나: *플레이어가 완전히 사망했을 때 인벤토리에 무슨 일이 일어나고,
 * 그 내용물이 어떻게 시체 컨테이너가 되는가.*
 *
 * - `stripForCorpse()` — 장비 슬롯 · 가방 격자 · 퀵슬롯을 통째로 뽑아 **빈손**으로 만든다 (사망 처리에서 한 번).
 *   무기의 내구도 · 장전 탄약 · 소켓은 `ItemInstance` 그대로 넘어가므로 보존된다. 2026-09-11 (C-12): 장착 임플란트의
 *   **망가진 짝**(`ctx.progression.stripImplantsForCorpse`)도 같이 시체로 간다. (C-36): 뽑기 전에 장착 가방이 레이드
 *   1회분 닳는다.
 * - `openContainerItemsSized()` — 시체는 상자(6×4)보다 큰 격자를 쓴다 (`PLAYER_CORPSE_COLS × ROWS`). 그래도 모자라면
 *   (전설 가방 가득 + 무기 둘 + 퀵슬롯 + 임플란트) **행을 늘려서라도** 전부 담는다 — `fitCorpseGrid`.
 * - `primeCorpseContainers()` — 멀티에서 **호스트가 열어 보지도 않은 시체**의 `contq take` 를 심판할 수 있도록
 *   `pcorpse` 와이어를 받는 즉시 컨테이너를 만들어 둔다. 가져가기 자체는 기존 `cont` / `contq` 경로 그대로다.
 */
import * as THREE from 'three';
import type { CorpseItemWire, GameContext, ItemInstance, PlayerCorpseWire } from '@/shared';
import { PLAYER_CORPSE_COLS, PLAYER_CORPSE_ROWS } from '@/shared';
import { ITEM_DEF_MAP } from '@/items';
import { Grid } from '../Grid';
import { LOADOUT_SLOTS } from '../model';
import type { InventorySystem } from '../InventorySystem';

/** `pcorpse:...` 컨테이너 격자 (상자보다 크다 — 사망 시점의 장비 + 가방이 전부 들어가야 한다). */
export function corpseGridSize(): { cols: number; rows: number } {
  return { cols: PLAYER_CORPSE_COLS, rows: PLAYER_CORPSE_ROWS };
}

/** `fitCorpseGrid` 가 행을 늘리는 상한 (기본 행 수에 더하는 값) — 그 너머는 격자가 아니라 버그다. */
const CORPSE_GRID_GROW_LIMIT = 64;

/**
 * 2026-09-11 (C-12) — `items` 가 **그 순서 그대로** (`Container.fill` 과 같은 `autoPlace`) 전부 들어가는 격자.
 * 기본 `cols × rows` 로 모자라면 열은 두고 행만 늘린다. 시뮬레이션은 얕은 복사본으로 하므로(`autoPlace` 가
 * 스택을 합치며 `qty` 를 바꾼다) 넘어온 인스턴스는 건드리지 않는다.
 *
 * 같은 목록이면 같은 크기가 나오므로 사망한 본인 · 호스트(`primeCorpseContainer`) · 늦게 연 사람이 모두 같은 격자를
 * 만든다 (가져가기는 격자 위치가 아니라 `idx` 로 오가므로 크기가 달라도 틀리지는 않지만, 같은 편이 낫다).
 * 임플란트의 망가진 짝이 시체에 들어오면서 전설 가방 가득 + 무기 둘 + 퀵슬롯 + 임플란트가 10×8 을 넘을 수 있게 됐다 —
 * 예전에는 넘치는 것이 경고 한 줄과 함께 **사라졌다** (`Container.fill`).
 */
export function fitCorpseGrid(items: readonly ItemInstance[], cols: number, rows: number): { cols: number; rows: number } {
  const getDef = (id: string) => ITEM_DEF_MAP.get(id);
  let c = Math.max(1, Math.floor(cols));
  const r0 = Math.max(1, Math.floor(rows));
  for (const it of items) {
    const d = getDef(it.defId);
    if (d) c = Math.max(c, Math.min(d.width, d.height));   // rotation is allowed, so the short side must fit
  }
  for (let r = r0; r <= r0 + CORPSE_GRID_GROW_LIMIT; r++) {
    const g = new Grid(c, r, getDef);
    if (items.every((it) => g.autoPlace({ ...it }))) return { cols: c, rows: r };
  }
  return { cols: c, rows: r0 + CORPSE_GRID_GROW_LIMIT };
}

/**
 * 사망 시점의 전부 — 장비 슬롯(주무기 I · II · 방탄복 · 가방. `secondary` 칸은 계약에만 남아 늘 비어 있다) ·
 * 가방 격자 · 퀵슬롯 · **장착 임플란트의 망가진 짝** — 을 하나의 목록으로 뽑고 로컬 인벤토리를 비운다.
 * **완전 빈손 부활**(사용자 결정): 구조선으로 돌아와도 아무것도 돌려받지 않는다.
 *
 * 2026-09-11 (C-12, 사용자 결정): 임플란트는 더 이상 몸에 남지 않는다. `ctx.progression.stripImplantsForCorpse()` 가
 * 함선 게이트를 건너뛰어 장착을 풀고 **망가진 짝** 인스턴스를 돌려주며 스스로 저장한다 — 여기서는 받아서 목록 끝에
 * 붙이기만 한다. 그 메서드가 없는(옵셔널 계약) 빌드에서는 빈 배열이고 예전과 똑같이 동작한다.
 * (C-36): 뽑기 **전에** 장착 가방이 레이드 1회분 닳는다 (`wearBagForRaid`, 탈출과 합쳐 레이드당 한 번).
 */
export function stripForCorpse(sys: InventorySystem): ItemInstance[] {
  sys.wearBagForRaid();
  const out: ItemInstance[] = [];
  for (const s of LOADOUT_SLOTS) {
    const it = sys.loadout[s];
    if (it) out.push(it);
  }
  for (const p of sys.bag.items()) out.push(p.item);
  // 2026-09-09: the wheel is its own container — its stacks are carried too, so they go on the corpse as well
  for (const it of sys.quickSlots) if (it) out.push(it);
  // 2026-09-11 (C-12): the equipped implants' broken twins (progression unequips + saves itself; optional contract)
  const implants = sys.ctx.progression?.stripImplantsForCorpse?.() ?? [];
  for (const it of implants) if (it) out.push(it);

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
  if (sys.isShowingContainer(containerId)) return;   // 2026-09-11 (C-16): already on screen — no re-show, no event
  const first = !sys.openedIds.has(containerId);
  sys.openedIds.add(containerId);
  const size = sys.containers.get(containerId) ? { cols, rows } : fitCorpseGrid(items, cols, rows);
  const c = sys.containers.getOrCreateWithItems(containerId, items, position, title, size);
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
  const items = corpseItemsFromWire(sys, wire.items ?? []);
  const base = corpseGridSize();
  sys.containers.getOrCreateWithItems(wire.id, items, pos,
    `${wire.name ?? '분대원'}의 유해`, fitCorpseGrid(items, base.cols, base.rows));
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
