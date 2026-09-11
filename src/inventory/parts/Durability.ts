/**
 * src/inventory/parts/Durability.ts — **내구도 · 수리 · 소켓**.
 *
 * 무기와 방어구가 닳고(`damageDurability`), 재료로 고쳐지고(`repair` / `repairWeapon`), 부착물이
 * 붙고 떨어지는(`attachToWeapon` / `detachAllSockets`) 경로. 회복 스프레이의 게이지 충전도 여기 있다
 * (`sprayRepairCost` — 남은 게이지 비율만큼만 재료를 받는다).
 */
import * as THREE from 'three';
import type {
  ContainerMessage, ContainerRequest, CraftIngredient, CraftRecipe, CraftStation, DurabilityInfo, GameContext, ItemCategory, ItemDef,
  ItemInstance, Loadout, LoadoutSlot, PeerId as NetPeerId, ProfileRecord, SocketSlot, WeaponSlot, WeightInfo, LoadoutPreset, WorkbenchKind, EmbeddedView,
} from '@/shared';
import { BAG_DEFAULT_COLS, BAG_DEFAULT_QUICK_SLOTS, BAG_DEFAULT_ROWS, BAG_DURABILITY_PER_RAID, Keys, QUICK_SLOTS, SEARCH_MAX_DISTANCE, SOCKET_SLOTS, isQuickSlotActive } from '@/shared';
import { AMMO_LABEL_KO, ITEM_DEF_MAP, STARTER_LOADOUT, STARTER_STASH, ammoItemIdFor, getRecipe, isWeaponItemDef, itemWeight, needsRepairCost } from '@/items';
import { durabilityInfo, gearMultipliers, makeWeightInfo, searchTimeFor, sumWeight } from '../Gear';
import { Grid, OOB, type Placement, type PriorityPlacement } from '../Grid';
import { Container, ContainerStore } from '../Container';
import { attachedItems, clearSocket, findSocketed, setSocket } from '../Sockets';
import { setStarterGrantState, starterGrantState } from '../Stash';
import { LOADOUT_SAVE_VERSION, isEmptyLoadoutSave, loadLoadoutSave, sanitizeLoadoutSave, type LoadoutSave } from '../Loadout';
import { reviveItem, savedCell, serializeExtras, serializePlacement, type SavedPlacement } from '../Serialize';
import {
  AUTO_CLOSE_DISTANCE, BLOCKER_TOKEN, CRAFT_MIN_SPEED, DROP_EYE_LOWER, DROP_FORWARD_OFFSET, DROP_FORWARD_SPEED, DROP_UP_SPEED,
  LOADOUT_SLOTS, MOD_CTRL, MOD_SHIFT, SEARCH_EMIT_INTERVAL, SPRAY_REFILL_COST, TAKE_REQUEST_TIMEOUT, WEAPON_SLOT_IDS,
  isArmorDef, isAttachmentDef, isBagDef, isDisassembleRecipe, isWeaponDef, sameProfileDoc, slotAccepts,
  type ActiveBench, type BagSize, type BenchRecipeRow, type BenchRepairRow, type DropPreview, type DropTarget,
  type GridId, type ItemLocation, type OpResult, type PendingTake, type RaidInventoryState, type RepairInfo, type SlotId,
} from '../model';
import type { InventorySystem } from '../InventorySystem';

/** Durability of a weapon (effective max) or armor (`ItemDef.durabilityMax`), or null. */
export function getDurability(sys: InventorySystem, uid: string): DurabilityInfo | null {
  const item = sys.findItem(uid);
  const def = item && ITEM_DEF_MAP.get(item.defId);
  if (!item || !def) return null;
  const stats = sys.loot.getEffectiveStats(item);
  if (stats) {
    const cur = Math.max(0, Math.min(stats.maxDurability, item.durability ?? stats.maxDurability));
    return { uid, durability: cur, max: stats.maxDurability, broken: cur <= 0 };
  }
  return durabilityInfo(item, def);
  }

/** Wear on non-weapon gear (armor per absorbed hit). Weapons keep `updateItem` (weapons/ owns that path). */
export function damageDurability(sys: InventorySystem, uid: string, amount: number): void {
  const wear = Math.max(0, amount);
  if (wear === 0) return;
  const item = sys.findItem(uid);
  const def = item && ITEM_DEF_MAP.get(item.defId);
  const max = def?.durabilityMax;
  if (!item || !def || max === undefined || max <= 0) return;
  const before = Math.max(0, Math.min(max, item.durability ?? max));
  if (before <= 0) return;
  const after = Math.max(0, before - wear);
  if (after === before) return;
  item.durability = after;
  sys.ctx.bus.emit('durability:changed', { uid, defId: def.id, durability: after, max });
  sys.ctx.bus.emit('inventory:itemUpdated', { item });
  if (after <= 0) {
    sys.ctx.bus.emit('durability:broken', { uid, defId: def.id, name: def.name });
    sys.ctx.bus.emit('ui:notify', { text: `${def.name} 파손!`, kind: 'danger' });
    sys.ctx.bus.emit('audio:play', { id: 'gear_broken' });
  }
  if (sys._open) sys.ui?.refresh();
  }

/**
 * 2026-09-11 (C-36) — **가방은 레이드 한 번에 한 번 닳는다.** 장착 가방이 `BAG_DURABILITY_PER_RAID` 를 잃는다.
 *
 * - 부르는 곳은 둘: 탈출 성공(`game:complete` 에서 `stats.extracted`) 과 사망(`CorpseLoot.stripForCorpse` 가 시체로
 *   옮기기 **전**). 먼저 온 쪽만 깎는다 — `bagWornThisRaid` 가 레이드 동안 서 있어서 사망 → 구조선 → 자기 가방을
 *   되찾아 탈출해도 두 번 닳지 않고, 레이드 중에 가방을 갈아 끼워도 한 번이다. 가방 없이 죽었다면 아무것도 깎지
 *   않았으므로 표시도 세우지 않는다 (그 뒤 주운 가방으로 탈출하면 그 가방이 닳는다).
 * - 훈련장은 레이드가 아니다 (`missionMode === 'training'`).
 * - **0 이 되어도 효과가 없다** (사용자 결정) — 격자 · 퀵슬롯은 그대로이고 수리비만 크다. 그래서 `damageDurability`
 *   와 달리 `durability:broken` (「파손 — 성능이 크게 떨어집니다」 토스트 · 파손음)을 내지 않는다. 낮아진 경고는
 *   `durability:changed` 로 HUD 가 알아서 띄운다.
 *
 * 깎았으면 true.
 */
export function wearBagForRaid(sys: InventorySystem): boolean {
  if (sys.bagWornThisRaid || sys.ctx.missionMode === 'training') return false;
  const bag = sys.loadout.bag;
  const def = bag && ITEM_DEF_MAP.get(bag.defId);
  const max = def?.durabilityMax;
  if (!bag || !def || max === undefined || max <= 0) return false;
  sys.bagWornThisRaid = true;
  const before = Math.max(0, Math.min(max, bag.durability ?? max));
  const after = Math.max(0, before - Math.max(0, BAG_DURABILITY_PER_RAID));
  if (after === before) return true;
  bag.durability = after;
  sys.ctx.bus.emit('durability:changed', { uid: bag.uid, defId: def.id, durability: after, max });
  sys.ctx.bus.emit('inventory:itemUpdated', { item: bag });
  if (sys._open) sys.ui?.refresh();
  return true;
}

/**
 * Phase 12: refill cost of a 회복 스프레이 (`ItemDef.heal.spray`, gauge = `durability` / `durabilityMax`) — one 캔 +
 * one 소독약 per **full** refill, scaled by the missing fraction (ceil, never below 1 each). null for anything else
 * or a full can. The materials come from the bag, exactly like a weapon repair.
 */
export function sprayRepairCost(sys: InventorySystem, item: ItemInstance, def: ItemDef): CraftIngredient[] | null {
  if (!def.heal?.spray) return null;
  const max = def.durabilityMax;
  if (max === undefined || max <= 0) return null;
  const cur = Math.max(0, Math.min(max, item.durability ?? max));
  if (cur >= max) return null;
  const missing = (max - cur) / max;
  return SPRAY_REFILL_COST.map((c) => ({ defId: c.defId, qty: Math.max(1, Math.ceil(c.qty * missing - 1e-9)) }));
  }

/**
 * **완전 수리에 드는 재료** — 한 곳에서만 정한다 (2026-09-10, 제작 대개편 2단계).
 *
 * 예전에는 `getEffectiveStats(item) ? getRepairCost(item) : sprayRepairCost(...)` 였다. 즉 **무기일 때만**
 * `getRepairCost` 를 물었고, 방탄복은 그 삼항의 else 가지로 흘러 `sprayRepairCost` 도 null 이라 **재료 없이
 * 만피 복구**됐다 (실측: 내구도 5 / 200 짜리 방탄복 I 을 `repair()` 하면 폐금속 0 을 쓰고 200 이 됐다).
 * 이제 `getRepairCost` 가 방탄복에도 값을 돌려주므로 **그것을 먼저 보고, 비었을 때만** 회복 스프레이의
 * 게이지 충전(`sprayRepairCost`)으로 내려간다.
 *
 * 2026-09-11 (C-36): 둘 다 비었을 때 **무료 수리가 아니다** — 제작 레시피가 있는 아이템(`needsRepairCost`)이면
 * 그것은 수리 표의 구멍이므로 `repair` · `repairInfo` · 작업대 수리 목록이 모두 거절한다. 가방이 내구도를 얻으며
 * `Salvage.REPAIRABLE` 에 함께 들어갔고, `npm run data:check` 가 같은 규칙을 표 전체에 대해 검산한다.
 */
export function repairMaterials(sys: InventorySystem, item: ItemInstance, def: ItemDef): CraftIngredient[] {
  const cost = sys.loot.getRepairCost(item);
  if (cost.length) return cost;
  return sys.sprayRepairCost(item, def) ?? [];
}

/**
 * Ship workbench: weapons go through `repairWeapon` (materials), everything else pays `repairMaterials` —
 * 방탄복은 **제작 재료 × 내구도 구간 배수**, 회복 스프레이는 캔 + 소독약 (Phase 12), 그 밖에는 무료.
 */
export function repair(sys: InventorySystem, uid: string): boolean {
  if (sys.ctx.isRaidActive()) return false;
  const item = sys.findItem(uid);
  const def = item && ITEM_DEF_MAP.get(item.defId);
  if (!item || !def) return false;
  if (sys.loot.getEffectiveStats(item)) {
    const ok = sys.repairWeapon(uid);
    if (ok) sys.ctx.bus.emit('repair:completed', { uid, name: def.name, durability: item.durability ?? 0 });
    return ok;
  }
  const max = def.durabilityMax;
  if (max === undefined || max <= 0) return false;
  if ((item.durability ?? max) >= max) return false;
  // all materials or nothing — a half-worn 방탄복 / an empty can stays a valid (n / max) item until then
  const cost = repairMaterials(sys, item, def);
  if (!cost.length && needsRepairCost(def)) return false;   // a hole in the repair table is not a free repair
  for (const c of cost) if (sys.countDef(c.defId) < c.qty) return false;
  for (const c of cost) sys.consumeWhere((d) => d.id === c.defId, c.qty);
  item.durability = max;
  sys.ctx.bus.emit('inventory:itemUpdated', { item });
  sys.ctx.bus.emit('durability:changed', { uid, defId: def.id, durability: max, max });
  sys.ctx.bus.emit('repair:completed', { uid, name: def.name, durability: max });
  sys.ctx.bus.emit('audio:play', { id: 'gear_repair' });
  sys.afterChange();
  return true;
  }

/**
 * Context-menu repair readout (hub only): materials still needed (`[]` = free), `short` = which of them the bag
 * lacks, `bucket` = 남은 내구도 구간 (그 구간의 배수가 곧 재료 수량이다 — 2026-09-10). null when the item is
 * not worn / not repairable.
 */
export function repairInfo(sys: InventorySystem, uid: string): RepairInfo | null {
  const item = sys.findItem(uid);
  const def = item && ITEM_DEF_MAP.get(item.defId);
  if (!item || !def) return null;
  const dur = sys.getDurability(uid);
  if (!dur || dur.max <= 0 || dur.durability >= dur.max) return null;
  // 2026-09-10: `getRepairCost` 를 **먼저** 본다 (무기 · 방탄복). 비었을 때만 회복 스프레이의 게이지 충전.
  const byCraft = sys.loot.getRepairCost(item);
  const raw = byCraft.length ? byCraft : sys.sprayRepairCost(item, def) ?? [];
  if (!raw.length && needsRepairCost(def)) return null;   // 2026-09-11: never offer a free repair for a crafted item
  const cost = raw.map((c) => ({
    ...c, name: ITEM_DEF_MAP.get(c.defId)?.name ?? c.defId, have: sys.countDef(c.defId),
  }));
  // 구간은 **제작 재료 규칙으로 값이 나온 경우에만** 뜻이 있다. 회복 스프레이의 캔 · 소독약은 게이지 비율로
  // 정해지므로 (`sprayRepairCost`) 여기서 `제작 재료의 n %` 라고 말하면 거짓말이 된다.
  return { cost, short: cost.some((c) => c.have < c.qty), bucket: byCraft.length ? sys.loot.durabilityBucketInfo(item) : null };
  }

/** Socket a bag (or open-container) attachment into a player-owned weapon; see `attachFrom`. */
export function attachToWeapon(sys: InventorySystem, weaponUid: string, attachmentUid: string): boolean {
  const w = sys.locate(weaponUid);
  const a = sys.locate(attachmentUid);
  if (!w || !a || a.from.kind !== 'grid') return false;
  return sys.attachFrom(attachmentUid, a.from, weaponUid, w.from) === 'ok';
  }

/** Every attachment of weapon `uid` back into the bag (overflow drops to the ground). False when none / not found. */
export function detachAllSockets(sys: InventorySystem, uid: string): boolean {
  const w = sys.locate(uid);
  if (!w || sys.locKind(w.from) !== 'player' || !isWeaponItemDef(ITEM_DEF_MAP.get(w.item.defId))) return false;
  const weapon = w.item;
  let n = 0;
  for (const socket of SOCKET_SLOTS) {
    const att = clearSocket(weapon, socket);
    if (!att) continue;
    n++;
    if (!sys.bag.autoPlace(att)) sys.throwToWorld(att, true);
    sys.ctx.bus.emit('inventory:socketChanged', { weapon, socket, attachment: null });
  }
  if (n === 0) return false;
  sys.afterSocketChange(weapon);
  sys.afterChange();
  return true;
  }

/** Magazine → bag as ammo of the weapon's calibre (merge into stacks, new stacks, overflow drops). */
export function unloadWeapon(sys: InventorySystem, uid: string): boolean {
  const w = sys.locate(uid);
  if (!w || sys.locKind(w.from) !== 'player') return false;
  const weapon = w.item;
  const stats = sys.loot.getEffectiveStats(weapon);
  const rounds = Math.floor(weapon.ammoInMag ?? 0);
  if (!stats || rounds <= 0) return false;
  weapon.ammoInMag = 0;
  sys.returnRounds(stats.ammoType, rounds);
  if (sys.bag.has(weapon.uid)) sys.bag.version++;
  sys.ctx.bus.emit('inventory:itemUpdated', { item: weapon });
  sys.afterChange();
  return true;
  }

/** Workbench repair: all materials from `LootRef.getRepairCost` or nothing. */
export function repairWeapon(sys: InventorySystem, uid: string): boolean {
  const w = sys.locate(uid);
  if (!w || sys.locKind(w.from) !== 'player') return false;
  const weapon = w.item;
  const stats = sys.loot.getEffectiveStats(weapon);
  const cost = sys.loot.getRepairCost(weapon);
  if (!stats || cost.length === 0) return false;
  for (const c of cost) if (sys.countWhere((d) => d.id === c.defId) < c.qty) return false;
  for (const c of cost) sys.consumeWhere((d) => d.id === c.defId, c.qty);
  weapon.durability = stats.maxDurability;
  if (sys.bag.has(weapon.uid)) sys.bag.version++;
  sys.ctx.bus.emit('inventory:itemUpdated', { item: weapon });
  sys.afterChange();
  return true;
  }
