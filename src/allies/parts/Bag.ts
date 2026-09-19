/**
 * src/allies/parts/Bag.ts — **gear · bag · weight**.
 *
 * The base kit (`ANDROID_KIT`) is a **bound thing** (contract `shared/allies.ts`): never dropped · never handed
 * over · never left in a corpse · never sent to the stash. Otherwise every raid would mint free gear, so `kitUids`
 * is the gate on every way out of the body.
 *
 * 2026-09-16 (user's decision): the kit is **not something the raid alone makes** — it is worn from the moment the
 * android enters the roster. The ship = `ensureKit` (idempotent), raid entry = `clearKit` → `equipKit` (a fresh kit).
 * The kit's uids go into `kitUids` on both paths.
 *
 * Swapping: gear it picked up (`raidFound`) that beats what it has equipped replaces that — the kit piece taken off
 * **vanishes on the spot** (a bound thing cannot be left on the ground either), and a picked-up piece taken off goes
 * to the bag, or to the ground when it does not fit.
 */
import * as THREE from 'three';
import {
  ANDROID_KIT, isRaidFound, markRaidFound, raidFoundSeed,
} from '@/shared';
import type { ItemDef, ItemInstance, WeightInfo } from '@/shared';
import { DEFAULT_ITEM_WEIGHT, getArmorDef, itemWeight } from '@/items';
import type { AllySystem } from '../AllySystem';
import type { Ally } from './Body';
import { _v1 } from '../model';

/** The stand-in when there is no weight — silently 「보통」 while `InventoryRef.weightInfoFor` is still missing. */
const CALM: WeightInfo = { weight: 0, capacity: 0, ratio: 0, state: 'normal', moveMul: 1, staminaRegenMul: 1 };

export function weightOf(sys: AllySystem, a: Ally): WeightInfo {
  const inv = sys.ctx.inventory;
  const carried = a.carried();
  if (typeof inv?.weightInfoFor === 'function') {
    try { return inv.weightInfoFor(carried, a.equip.bag); } catch { /* not implemented yet → silently normal */ }
  }
  let w = 0;
  for (const it of carried) w += kgOf(sys, it);
  return { ...CALM, weight: w };
}

export function defOf(sys: AllySystem, defId: string | null | undefined): ItemDef | undefined {
  if (!defId) return undefined;
  return sys.ctx.loot?.getItemDef(defId);
}

/* ── the base kit ────────────────────────────────────────────────────────── */

/** Is the base kit in place — all three slots filled and the bag grid there too (`ensureKit`'s idempotent test). */
function hasKit(a: Ally): boolean {
  return a.kitUids.size > 0 && !!a.equip.primary && !!a.equip.armor && !!a.equip.bag && !!a.bag;
}

/**
 * 2026-09-16 (user's decision 「호출되는 순간 기본 킷을 장착한 채로 선다」): **the kit is guaranteed in the
 * ship**. Called over and over — the moment it enters the roster (`parts/Roster.syncBodies`) and while it stands in
 * the ship (`parts/Hub.update`) — and does nothing once the kit is in place. A kit built in the ship is just as much
 * a **bound thing**, so `kitUids` keeps the gate on every way out (dropping · handing over · a corpse · the stash),
 * and in the ship those ways do not exist in the first place.
 * On raid entry `parts/Spawn` stands a **fresh kit** up with `clearKit` → `equipKit`, so no free gear is ever minted.
 */
export function ensureKit(sys: AllySystem, a: Ally): void {
  if (hasKit(a)) return;
  equipKit(sys, a);
}

/**
 * Strips the kit off the body whole — the raid-entry reset (`parts/Spawn.onWorldReady`) calls it on every body.
 * The authority stands a fresh kit up right behind it with `equipKit`; a replica reads only the `ally bag` wire from
 * here on. **No empty bag built in the ship may be left behind**: host migration would skip the `!a.bag` branch
 * (`parts/Sync.onHostChanged`), inherit that empty bag, and the loot of an android it knew only from the wire would
 * vanish whole.
 */
export function clearKit(a: Ally): void {
  a.kitUids.clear();
  a.equip.primary = null;
  a.equip.armor = null;
  a.equip.bag = null;
  a.bag = null;
  a.wireItems = [];
  a.bagDirty = false;
  a.weaponDefId = null;
  a.armorDefId = null;
  a.bagDefId = null;
}

/** Fills a fresh base kit (raid entry · entering the ship) — whatever was there is thrown away and rebuilt. */
export function equipKit(sys: AllySystem, a: Ally): void {
  const loot = sys.ctx.loot;
  if (!loot) return;
  a.kitUids.clear();
  a.equip.primary = loot.createItem(ANDROID_KIT.primary);
  a.equip.armor = loot.createItem(ANDROID_KIT.armor);
  a.equip.bag = loot.createItem(ANDROID_KIT.bag);
  for (const it of [a.equip.primary, a.equip.armor, a.equip.bag]) if (it) a.kitUids.add(it.uid);

  const bagDef = defOf(sys, ANDROID_KIT.bag);
  const cols = bagDef?.bag?.cols ?? 0;
  const rows = bagDef?.bag?.rows ?? 0;
  a.bag = sys.ctx.inventory?.createAllyBag?.(cols, rows) ?? null;
  a.bagDirty = true;
  refreshLook(sys, a);
}

/** Re-reads the three drawn def ids (`AllyBodyView`) and the magazine from what is equipped right now. */
export function refreshLook(sys: AllySystem, a: Ally): void {
  a.weaponDefId = a.equip.primary?.defId ?? null;
  a.armorDefId = a.equip.armor?.defId ?? null;
  a.bagDefId = a.equip.bag?.defId ?? null;
  const st = a.equip.primary ? sys.ctx.loot?.getEffectiveStats(a.equip.primary) ?? null : null;
  a.magSize = Math.max(1, st?.magSize ?? 1);
  if (a.magLeft <= 0 || a.magLeft > a.magSize) a.magLeft = a.magSize;
  const armor = a.equip.armor ? getArmorDef(defOf(sys, a.equip.armor.defId)?.armorId ?? '') : undefined;
  a.maxShield = armor?.shield ?? 0;
  if (a.shield > a.maxShield) a.shield = a.maxShield;
}

export function isKit(a: Ally, item: ItemInstance | null | undefined): boolean {
  return !!item && a.kitUids.has(item.uid);
}

/* ── value · grade comparison ────────────────────────────────────────────── */

/** What one stack of this item is worth (picking the junk to drop · picking what to take from a crate). */
export function valueOf(sys: AllySystem, it: ItemInstance): number {
  const def = defOf(sys, it.defId);
  return (def?.value ?? 0) * Math.max(1, it.qty);
}
export function kgOf(sys: AllySystem, it: ItemInstance): number {
  const def = defOf(sys, it.defId);
  return Math.max(0.01, (def ? itemWeight(def) : DEFAULT_ITEM_WEIGHT) * Math.max(1, it.qty));
}
export function cellsOf(sys: AllySystem, it: ItemInstance): number {
  const def = defOf(sys, it.defId);
  return Math.max(1, (def?.width ?? 1) * (def?.height ?? 1));
}

/** How 「good」 a weapon is — grade first, then damage, then remaining durability. */
function weaponScore(sys: AllySystem, it: ItemInstance | null): number {
  if (!it) return -1;
  const st = sys.ctx.loot?.getEffectiveStats(it);
  if (!st) return -1;
  const dur = st.maxDurability > 0 ? (it.durability ?? st.maxDurability) / st.maxDurability : 1;
  return st.grade * 1e6 + st.damage * 1e2 + dur;
}
/** How 「good」 armor is — max shield first, then remaining durability. */
function armorScore(sys: AllySystem, it: ItemInstance | null): number {
  if (!it) return -1;
  const def = defOf(sys, it.defId);
  const armor = getArmorDef(def?.armorId ?? '');
  if (!armor) return -1;
  const max = def?.durabilityMax ?? 0;
  const dur = max > 0 ? (it.durability ?? max) / max : 1;
  return armor.shield * 1e2 + dur;
}
function bagScore(sys: AllySystem, it: ItemInstance | null): number {
  if (!it) return -1;
  const bag = defOf(sys, it.defId)?.bag;
  return bag ? bag.cols * bag.rows : -1;
}

/** The slot when `item` is gear of the same kind and better than what it has equipped, else null. */
export function upgradeSlotOf(sys: AllySystem, a: Ally, item: ItemInstance): 'primary' | 'armor' | 'bag' | null {
  const def = defOf(sys, item.defId);
  if (!def) return null;
  if (def.weaponId && weaponScore(sys, item) > weaponScore(sys, a.equip.primary)) return 'primary';
  if (def.armorId && armorScore(sys, item) > armorScore(sys, a.equip.armor)) return 'armor';
  if (def.bag && bagScore(sys, item) > bagScore(sys, a.equip.bag)) return 'bag';
  return null;
}

/** Better than **what the squad leader has equipped**, by the same measure (user's decision — it hands that over). */
export function beatsLeader(sys: AllySystem, item: ItemInstance): boolean {
  const def = defOf(sys, item.defId);
  if (!def) return false;
  const gear = leaderGear(sys);
  if (def.weaponId) return weaponScore(sys, item) > weaponScore(sys, gear.primary);
  if (def.armorId) return armorScore(sys, item) > armorScore(sys, gear.armor);
  if (def.bag) return bagScore(sys, item) > bagScore(sys, gear.bag);
  return false;
}

/** What the squad leader has equipped — the inventory when local, the last crew card when remote. */
function leaderGear(sys: AllySystem): { primary: ItemInstance | null; armor: ItemInstance | null; bag: ItemInstance | null } {
  const ctx = sys.ctx;
  const localId = ctx.net?.localId ?? null;
  if (!ctx.net?.inSession || sys.leaderId === localId) {
    const l = ctx.inventory?.getLoadout();
    return { primary: l?.primary ?? null, armor: l?.armor ?? null, bag: l?.bag ?? null };
  }
  // A remote squad leader's gear is only what the crew card knows (weapon · armor def id — no bag on the card).
  const card = ctx.net?.getCrewCard(sys.leaderId) ?? null;
  const asInst = (defId: string | null | undefined): ItemInstance | null =>
    defId ? ctx.loot?.createItem(defId) ?? null : null;
  return { primary: asInst(card?.primary), armor: asInst(card?.armor), bag: null };
}

/* ── gear swapping ───────────────────────────────────────────────────────── */

/** Swaps in picked-up gear from the bag when it beats what is equipped. True when something changed. */
export function tryUpgrade(sys: AllySystem, a: Ally): boolean {
  if (!a.bag) return false;
  const seed = raidFoundSeed(sys.ctx);
  for (const it of a.bag.items().slice()) {
    if (!isRaidFound(it, seed)) continue;
    const slot = upgradeSlotOf(sys, a, it);
    if (!slot) continue;
    const old = a.equip[slot];
    a.bag.remove(it.uid);
    a.equip[slot] = it;
    if (slot === 'bag') resizeBag(sys, a);
    if (old && !isKit(a, old)) {
      // A **picked-up** piece taken off goes to the bag, or the ground when it does not fit. A kit piece is a
      // bound thing, so it just vanishes.
      if (!a.bag.autoPlace(old)) dropAt(sys, a, old);
    } else if (old) a.kitUids.delete(old.uid);
    a.bagDirty = true;
    refreshLook(sys, a);
    return true;
  }
  return false;
}

function resizeBag(sys: AllySystem, a: Ally): void {
  const bagDef = defOf(sys, a.equip.bag?.defId)?.bag;
  if (!a.bag || !bagDef) return;
  const spill = a.bag.resize(bagDef.cols, bagDef.rows);
  for (const it of spill) dropAt(sys, a, it);
}

/** Drops it at its feet (a bound thing never reaches here). */
export function dropAt(sys: AllySystem, a: Ally, item: ItemInstance): void {
  if (isKit(a, item)) return;
  _v1.copy(a.position);
  sys.ctx.pickups?.spawn(item, _v1);
}

/* ── junk dropping ───────────────────────────────────────────────────────── */

/**
 * Drops **one at a time** to get out of 「무거움」 (user's decision — the lowest value first → the worst value per kg
 * → the worst value per cell). True when something was dropped.
 */
export function dropWorst(sys: AllySystem, a: Ally): boolean {
  if (!a.bag) return false;
  const seed = raidFoundSeed(sys.ctx);
  let worst: ItemInstance | null = null;
  let worstKey: [number, number, number] | null = null;
  for (const it of a.bag.items()) {
    if (!isRaidFound(it, seed)) continue;   // the kit · anything without the mark is not junk to drop
    const v = valueOf(sys, it);
    const key: [number, number, number] = [v, v / kgOf(sys, it), v / cellsOf(sys, it)];
    if (!worstKey || key[0] < worstKey[0] || (key[0] === worstKey[0] && key[1] < worstKey[1])
      || (key[0] === worstKey[0] && key[1] === worstKey[1] && key[2] < worstKey[2])) {
      worst = it; worstKey = key;
    }
  }
  if (!worst) return false;
  a.bag.remove(worst.uid);
  dropAt(sys, a, worst);
  a.bagDirty = true;
  return true;
}

/** Puts it in the bag (to the ground when it does not fit). Marks it as found in the raid. */
export function take(sys: AllySystem, a: Ally, item: ItemInstance): void {
  markRaidFound(item, raidFoundSeed(sys.ctx));
  if (!a.bag || !a.bag.autoPlace(item)) dropAt(sys, a, item);
  a.bagDirty = true;
}

/** The first item in the bag that matches the test (picked-up only — the kit is never handed over). */
export function findInBag(sys: AllySystem, a: Ally, pred: (def: ItemDef, it: ItemInstance) => boolean): ItemInstance | null {
  if (!a.bag) return null;
  const seed = raidFoundSeed(sys.ctx);
  for (const it of a.bag.items()) {
    if (!isRaidFound(it, seed)) continue;
    const def = defOf(sys, it.defId);
    if (def && pred(def, it)) return it;
  }
  return null;
}

/** A position copy that uses no scratch (for keeping a request · a destination). */
export function clone(v: THREE.Vector3): THREE.Vector3 { return v.clone(); }
