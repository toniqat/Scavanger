/**
 * src/inventory/parts/Allies.ts — **안드로이드 분대원이 인벤토리에 거는 갈고리** (2026-09-15,
 * `docs/DECISIONS.md` 「2026-09-15 — 안드로이드 분대원 · 레이드 진입 로딩」).
 *
 * 여기 있는 것은 전부 **계약(`shared/types.ts` 의 2026-09-15 안드로이드 절 · `shared/events.ts`)이 이름을 정한 것**뿐이고,
 * allies/ 는 이 파일의 결과만 본다. 새 루팅 · 새 무게 식을 만들지 않는다 — 사람이 쓰는 그 식을 그대로 부른다:
 *  - `createAllyBag` = DOM 없는 `Grid` 하나 (플레이어 가방과 **같은** 스택 열쇠 · 같은 배치 규칙).
 *  - `weightInfoFor` = `InventorySystem.getWeight` 의 식에서 **운반 숙련(carryRelief)만 뺀** 것. 안드로이드에는 능력치가
 *    없으므로 기준 소지 한계는 레벨 1 캐릭터의 값(`DEFAULT_CARRY_CAPACITY`)이고, 가방 보너스는 사람과 같은 `bagCapacityBonus`.
 *  - `takeContainerItemFor` = 사람의 상자 획득(`trackTake` → `announceTake` → `emitItemTaken`)과 **같은 기록 · 같은 방송**.
 *    다른 점은 `by` 가 사람의 PeerId 가 아니라 안드로이드 id 라는 것뿐이다 (받는 쪽은 `msg.by !== localId` 이므로
 *    「남이 가져갔다」 경로를 그대로 탄다).
 *  - `emitItemRequest` / `emitContainerViewed` = 가운데 클릭 요청 · 컨테이너 창 열기를 allies 가 들을 수 있게 내보내는 사건.
 *    호스트가 아닌 클라이언트는 같은 내용을 `allyq` 로 호스트에게도 보낸다 (안드로이드는 호스트가 굴린다).
 *  - `onAllyDeposit` = 탈출한 안드로이드의 전리품을 **분대장의 창고**에 넣는다 (넘치면 잃는다 — `ally:deposited.lost`).
 */
import * as THREE from 'three';
import {
  crateLootRandom, markRaidFound, raidFoundSeed,
  type AllyBagRef, type ItemDef, type ItemInstance, type ItemRequestKind, type WeightInfo,
} from '@/shared';
import { ITEM_DEF_MAP, shieldChargeOf } from '@/items';
import { DEFAULT_CARRY_CAPACITY, bagCapacityBonus, makeWeightInfo, sumWeight } from '../Gear';
import { Grid } from '../Grid';
import type { Container } from '../Container';
import type { ItemLocation } from '../model';
import type { InventorySystem } from '../InventorySystem';

const getDef = (defId: string): ItemDef | undefined => ITEM_DEF_MAP.get(defId);
/** `previewContainerItems` 가 없는 트리 · 훈련장에서 쓰는 원점 (컨테이너 자리를 모를 때). */
const _origin = new THREE.Vector3();

/* ── 가방 ──────────────────────────────────────────────────────────────── */

/**
 * 안드로이드 한 기의 가방 격자. 플레이어 가방과 **같은 `Grid`** 라 스택 열쇠(회수 계약 · 요리 품질) · 회전 · 병합이 전부 같다.
 * DOM 은 없다 — 그리는 쪽은 아무도 없고, 호스트만 들고 있다가 `ally bag` 으로 내용을 방송한다.
 */
export function createAllyBag(cols: number, rows: number): AllyBagRef {
  const grid = new Grid(Math.max(1, Math.floor(cols)), Math.max(1, Math.floor(rows)), getDef);
  return {
    get cols(): number { return grid.cols; },
    get rows(): number { return grid.rows; },
    items: () => grid.items().map((p) => p.item),
    autoPlace: (item) => grid.autoPlace(item),
    remove: (uid) => grid.remove(uid)?.item ?? null,
    resize: (c, r) => grid.resize(Math.max(1, Math.floor(c)), Math.max(1, Math.floor(r))),
    usedCells: () => grid.usedCells(),
    totalValue: () => grid.totalValue(),
    clear: () => grid.clear(),
  };
}

/**
 * 사람과 같은 무게 식 (`InventorySystem.getWeight`): 들고 있는 전부(가방 + 장착 장비)의 무게 합 대 소지 한계.
 * 운반 숙련은 없다(세 번째 인자 0) — 안드로이드에는 능력치도 스킬도 없기 때문이다. 기준 한계는 레벨 1 캐릭터 값이고,
 * 장착 가방이 `bagCapacityBonus` 만큼 늘려 준다 (사람과 **같은 함수**라 수치를 고치면 함께 움직인다).
 */
export function weightInfoFor(sys: InventorySystem, carried: readonly ItemInstance[], bag: ItemInstance | null): WeightInfo {
  const w = sumWeight(carried, getDef);
  const capacity = DEFAULT_CARRY_CAPACITY + bagCapacityBonus(sys.bagSizeOf(bag));
  return makeWeightInfo(Math.round(w * 100) / 100, capacity, 0);
}

/* ── 컨테이너 획득 ─────────────────────────────────────────────────────── */

/**
 * 아직 이 클라이언트가 굴리지 않은 컨테이너를 **여는 것과 같은 굴림**으로 확정한다.
 *
 * 굴림의 원본은 `WorldRef.previewContainerItems` 다 — 맵 상자는 상자 코드와 같은 `crateLootRandom` 식이고, 구조물 ·
 * 플랫폼 · 전차 컨테이너는 열쇠 부가 굴림까지 포함한 **여는 경로 그대로**다 (드론 스캔이 쓰는 그 경로와 같다).
 * world 가 답하지 못하면(훈련장 · 모르는 id) 상자 코드와 같은 티어 굴림으로 떨어진다. 레이드 표식(`raidFound`)은
 * `ContainerStore.getOrCreate` 와 같은 자리에서 찍는다 — 미리보기 경로는 표식이 없기 때문이다.
 */
function primeContainer(sys: InventorySystem, containerId: string, tier: number): Container | null {
  const ctx = sys.ctx;
  const world = ctx.world;
  const info = world?.getLootContainers?.().find((c) => c.id === containerId) ?? null;
  const t = info ? info.tier : Math.floor(tier);
  const position = info ? info.position : _origin;
  let items: ItemInstance[] | null = null;
  try { items = world?.previewContainerItems?.(containerId) ?? null; } catch { items = null; }
  if (!items) {
    if (!Number.isFinite(t) || t < 1) return null;
    items = sys.loot.rollCrateOn(t, crateLootRandom(sys.missionSeed, containerId), ctx.missionPlanet, world?.crateLootOpts?.(containerId));
  }
  markRaidFound(items, raidFoundSeed(ctx));
  return sys.containers.prime(containerId, t, position, items);
}

/**
 * 권위(솔로 · 로비 호스트): 안드로이드 `by` 가 컨테이너에서 `defId` 스택 하나를 가져간다.
 *
 * `containerId` 는 **인벤토리 컨테이너 id** 다 — 맵 상자는 `CrateDef.id`(`crate_<n>`), 구조물 · 플랫폼 · 전차 컨테이너는
 * 그 명세 id (상호작용 id 의 `container:` 접두어를 **뗀** 것). `WorldRef.getLootContainers()` 가 돌려주는 id 와 같다.
 *
 * 흐름은 사람의 획득과 하나도 다르지 않다: 굴리지 않았으면 여는 것과 같은 굴림으로 확정 → 격자에서 스택을 빼고 →
 * 호스트가 `cont taken` 으로 기록 · 방송 → `container:itemTaken` → 처음이면 world 에 열린 모습(`crate opened`)을 맞춘다.
 */
export function takeContainerItemFor(sys: InventorySystem, containerId: string, tier: number, defId: string, by: string): ItemInstance | null {
  const ctx = sys.ctx;
  if (typeof containerId !== 'string' || !containerId || typeof defId !== 'string' || !defId) return null;
  if (ctx.isMultiplayer && !ctx.isAuthority) return null;
  const c = sys.containers.get(containerId) ?? primeContainer(sys, containerId, tier);
  if (!c) return null;
  // 굴림 순서(`order`)대로 첫 스택 — 어느 클라이언트에서 굴려도 같은 스택이 나간다
  let idx = -1;
  let uid: string | null = null;
  for (let i = 0; i < c.order.length; i++) {
    const p = c.grid.get(c.order[i]);
    if (p && p.item.defId === defId && p.item.qty > 0) { idx = i; uid = c.order[i]; break; }
  }
  if (idx < 0 || !uid) return null;
  const placement = c.grid.get(uid);
  if (!placement) return null;
  const item = placement.item;
  const qty = item.qty;
  c.grid.remove(uid);
  if (sys.isNetAuthority()) sys.announceTake(c, idx, qty, by);
  else c.recordTaken(idx, qty);
  sys.emitItemTaken(containerId, idx, uid, qty, c.remainingAt(idx), by, true);
  sys.checkLootedFor(c);
  if (sys._open) sys.ui?.refresh();
  // 열린 모습은 world 소유다 — 뚜껑 · 문을 열고 분대에 `crate opened` 를 보낸다 (이 맵의 것이 아니면 조용히 넘어간다)
  try { ctx.world?.markContainerOpened?.(containerId); } catch { /* world lane still mid-flight */ }
  return item;
}

/* ── 요청 · 컨테이너 창 ────────────────────────────────────────────────── */

/** 지금 이 클라이언트가 안드로이드 질의를 **호스트에게 보내야 하나** (세션 안 · 내가 권위가 아님). */
function needsAllyQuery(sys: InventorySystem): boolean {
  const ctx = sys.ctx;
  return !!ctx.net && ctx.isMultiplayer && !ctx.isAuthority;
}

/**
 * 가운데 클릭 · 우클릭 메뉴의 아이템 요청을 안드로이드가 들을 수 있게 내보낸다 (`requestItem` 이 채팅 줄과 **함께** 부른다).
 *
 * `kind` 는 요청의 뜻이다 — 장착 방탄복인데 실드가 덜 찼으면 `shield`, 탄약이 있는 무기면 `ammo`(`ammoType` = 그 구경),
 * 순수 회복약이면 `heal`, 나머지는 `item`. `defId` 는 **누른 그 아이템의 def** 다 (탄약 요청이면 그 총) — 탄약을 찾는
 * 쪽은 `ammoType` 을 본다. `position` 은 요청한 사람(= 로컬 플레이어)의 발이다.
 */
export function emitItemRequest(sys: InventorySystem, item: ItemInstance, from: ItemLocation, ammoType: string | null): void {
  const ctx = sys.ctx;
  const def = ITEM_DEF_MAP.get(item.defId);
  const kind: ItemRequestKind = ammoType ? 'ammo'
    : sys.wantsShieldRecharge(from) ? 'shield'
    : def?.heal && !shieldChargeOf(def.id) ? 'heal'
    : 'item';
  const position = ctx.player?.position ?? _origin;
  ctx.bus.emit('inventory:itemRequested', { kind, defId: item.defId, ammoType, position });
  if (!needsAllyQuery(sys)) return;
  ctx.net!.send({
    t: 'allyq', ev: 'item', kind, defId: item.defId,
    ...(ammoType ? { ammoType } : {}),
    p: [position.x, position.y, position.z],
  }, 'host');
}

/**
 * 컨테이너 창(상자 · 구조물 컨테이너 · 시체)을 열었다 — 그 상자를 먹으러 가던 안드로이드는 멈춘다
 * (사용자 결정: 「아이템 상자를 먹고 있을 때, PC 가 그 상자를 열면 먹는 것을 중단한다」).
 */
export function emitContainerViewed(sys: InventorySystem, containerId: string): void {
  const ctx = sys.ctx;
  ctx.bus.emit('inventory:containerViewed', { containerId });
  if (!needsAllyQuery(sys)) return;
  ctx.net!.send({ t: 'allyq', ev: 'viewing', containerId }, 'host');
}

/* ── 창고 입고 ─────────────────────────────────────────────────────────── */

/**
 * 탈출한 안드로이드의 전리품을 **내 창고**에 넣는다 (`inventory:allyDeposit` — 분대장 클라이언트에서만 온다).
 * 창고가 가득 차 넣지 못한 것은 잃는다 (`lost`) — 안드로이드는 레이드가 끝나면 사라지므로 들고 있을 수 없다.
 */
export function onAllyDeposit(sys: InventorySystem, id: string, name: string, items: readonly ItemInstance[]): void {
  let count = 0;
  let lost = 0;
  for (const it of items) {
    if (!it) continue;
    // `tryAddToStash` 가 성공하면 그 안에서 `afterChange()` 로 창고를 저장하고 `inventory:stashChanged` 를 낸다
    if (sys.tryAddToStash(it)) count++;
    else lost++;
  }
  sys.ctx.bus.emit('ally:deposited', { id, name, count, lost });
}
