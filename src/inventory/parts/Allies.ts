/**
 * src/inventory/parts/Allies.ts — **the hooks android squadmates put into the inventory** (2026-09-15,
 * `docs/DECISIONS.md` 「2026-09-15 — 안드로이드 분대원 · 레이드 진입 로딩」).
 *
 * Everything here is only **what the contract named** (the 2026-09-15 android section of `shared/types.ts` · `shared/events.ts`),
 * and allies/ reads only this file's results. It invents no new looting and no new weight formula — it calls the ones people use:
 *  - `createAllyBag` = one DOM-less `Grid` (the **same** stack key · the same placement rules as the player's bag).
 *  - `weightInfoFor` = the `InventorySystem.getWeight` formula **minus the hauling relief (carryRelief)** alone. An android has
 *    no stats, so the base carry capacity is a level 1 character's value (`DEFAULT_CARRY_CAPACITY`), and the bag bonus is the same `bagCapacityBonus`.
 *  - `takeContainerItemFor` = the **same record · the same broadcast** as a person's crate take (`trackTake` → `announceTake` → `emitItemTaken`).
 *    The only difference is that `by` is an android id instead of a person's PeerId (the receiving side sees `msg.by !== localId`,
 *    so it rides the 「somebody else took it」 path unchanged).
 *  - `emitItemRequest` / `emitContainerViewed` = the events that let allies hear a middle-click request · a container window opening.
 *    A client that is not the host sends the same thing to the host as `allyq` too (androids are simulated by the host).
 *  - `onAllyDeposit` = puts an extracted android's loot into the **squad leader's stash** (overflow is lost — `ally:deposited.lost`).
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
/** The origin used on a tree with no `previewContainerItems` · the training range (when the container's spot is unknown). */
const _origin = new THREE.Vector3();

/* ── Bag ───────────────────────────────────────────────────────────────── */

/**
 * One android unit's bag grid. The **same `Grid`** as the player's bag, so the stack key (recovery contract · meal quality) ·
 * rotation · merging are all the same. There is no DOM — nobody draws it; the host just holds it and broadcasts the contents as `ally bag`.
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
 * The same weight formula as a person's (`InventorySystem.getWeight`): the summed weight of everything carried (bag + equipment) against the carry capacity.
 * There is no hauling relief (third argument 0) — an android has neither stats nor skills. The base capacity is a level 1 character's value,
 * and the equipped bag raises it by `bagCapacityBonus` (the **same function** as a person's, so a number fixed there moves both).
 */
export function weightInfoFor(sys: InventorySystem, carried: readonly ItemInstance[], bag: ItemInstance | null): WeightInfo {
  const w = sumWeight(carried, getDef);
  const capacity = DEFAULT_CARRY_CAPACITY + bagCapacityBonus(sys.bagSizeOf(bag));
  return makeWeightInfo(Math.round(w * 100) / 100, capacity, 0);
}

/* ── Container takes ───────────────────────────────────────────────────── */

/**
 * Settles a container this client has not rolled yet with **the same roll as opening it**.
 *
 * The roll's origin is `WorldRef.previewContainerItems` — a map crate is the same `crateLootRandom` formula as the crate code,
 * and structure · platform · tram containers are **the opening path exactly**, the key's bonus roll included (the same path
 * the drone scan uses). When world cannot answer (the training range · an unknown id) it falls back to the same tier roll as
 * the crate code. The raid-found mark (`raidFound`) is stamped at the same place as `ContainerStore.getOrCreate` — because the preview path carries no mark.
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
 * The authority (solo · lobby host): the android `by` takes one `defId` stack out of the container.
 *
 * `containerId` is the **inventory container id** — a map crate is `CrateDef.id` (`crate_<n>`), a structure · platform · tram
 * container its spec id (the interaction id **without** the `container:` prefix). The same id `WorldRef.getLootContainers()` returns.
 *
 * The flow is not one step different from a person's take: not rolled yet → settled with the same roll as opening → the stack
 * comes off the grid → the host records · broadcasts it as `cont taken` → `container:itemTaken` → on the first one world's opened look (`crate opened`) is matched.
 */
export function takeContainerItemFor(sys: InventorySystem, containerId: string, tier: number, defId: string, by: string): ItemInstance | null {
  const ctx = sys.ctx;
  if (typeof containerId !== 'string' || !containerId || typeof defId !== 'string' || !defId) return null;
  if (ctx.isMultiplayer && !ctx.isAuthority) return null;
  const c = sys.containers.get(containerId) ?? primeContainer(sys, containerId, tier);
  if (!c) return null;
  // The first stack in roll order (`order`) — whichever client rolled it, the same stack leaves
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
  // The opened look is world's — it opens the lid · door and sends `crate opened` to the squad (silently skipped when it is not of this map)
  try { ctx.world?.markContainerOpened?.(containerId); } catch { /* world lane still mid-flight */ }
  return item;
}

/* ── Requests · the container window ───────────────────────────────────── */

/** Does this client have to **send the android query to the host** right now (in a session · not the authority). */
function needsAllyQuery(sys: InventorySystem): boolean {
  const ctx = sys.ctx;
  return !!ctx.net && ctx.isMultiplayer && !ctx.isAuthority;
}

/**
 * Emits the item request of the middle-click · right-click menu so androids can hear it (`requestItem` calls it **together** with the chat line).
 *
 * `kind` is what the request means — `shield` for equipped armor whose shield is not full, `ammo` for a weapon that takes ammo
 * (`ammoType` = that calibre), `heal` for a pure healing item, `item` for the rest. `defId` is **the def of the item that was
 * clicked** (for an ammo request, that gun) — the side looking for ammo reads `ammoType`. `position` is the feet of the requester (= the local player).
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
 * A container window (crate · structure container · corpse) was opened — an android on its way to loot that crate stops
 * (user's decision: 「아이템 상자를 먹고 있을 때, PC 가 그 상자를 열면 먹는 것을 중단한다」).
 */
export function emitContainerViewed(sys: InventorySystem, containerId: string): void {
  const ctx = sys.ctx;
  ctx.bus.emit('inventory:containerViewed', { containerId });
  if (!needsAllyQuery(sys)) return;
  ctx.net!.send({ t: 'allyq', ev: 'viewing', containerId }, 'host');
}

/* ── Into the stash ────────────────────────────────────────────────────── */

/**
 * Puts an extracted android's loot into **my stash** (`inventory:allyDeposit` — it comes only from the squad leader's client).
 * What a full stash could not take is lost (`lost`) — an android disappears when the raid ends, so it cannot keep holding it.
 */
export function onAllyDeposit(sys: InventorySystem, id: string, name: string, items: readonly ItemInstance[]): void {
  let count = 0;
  let lost = 0;
  for (const it of items) {
    if (!it) continue;
    // on success `tryAddToStash` saves the stash inside itself with `afterChange()` and emits `inventory:stashChanged`
    if (sys.tryAddToStash(it)) count++;
    else lost++;
  }
  sys.ctx.bus.emit('ally:deposited', { id, name, count, lost });
}
