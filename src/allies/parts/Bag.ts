/**
 * src/allies/parts/Bag.ts — **장비 · 가방 · 무게**.
 *
 * 기본 킷(`ANDROID_KIT`)은 **묶인 물건**이다 (계약 `shared/allies.ts`): 떨구지도 · 건네지도 · 시체에 남기지도 ·
 * 창고로 보내지도 않는다. 그러지 않으면 매 레이드 공짜 장비가 생긴다. 그래서 `kitUids` 가 바깥으로 나가는 모든 길의 문이다.
 *
 * 갈아끼우기: 주운 장비(`raidFound`)가 지금 낀 것보다 좋으면 바꾼다 — 벗겨진 킷 장비는 **그 자리에서 사라지고**
 * (묶인 물건이라 바닥에도 못 둔다), 벗겨진 주운 장비는 가방으로, 안 들어가면 바닥으로 간다.
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

/** 무게 없는 대체값 — `InventoryRef.weightInfoFor` 가 아직 없는 동안 조용히 「보통」으로 둔다. */
const CALM: WeightInfo = { weight: 0, capacity: 0, ratio: 0, state: 'normal', moveMul: 1, staminaRegenMul: 1 };

export function weightOf(sys: AllySystem, a: Ally): WeightInfo {
  const inv = sys.ctx.inventory;
  const carried = a.carried();
  if (typeof inv?.weightInfoFor === 'function') {
    try { return inv.weightInfoFor(carried, a.equip.bag); } catch { /* 계약 구현이 아직이면 조용히 보통 */ }
  }
  let w = 0;
  for (const it of carried) w += kgOf(sys, it);
  return { ...CALM, weight: w };
}

export function defOf(sys: AllySystem, defId: string | null | undefined): ItemDef | undefined {
  if (!defId) return undefined;
  return sys.ctx.loot?.getItemDef(defId);
}

/* ── 기본 킷 ──────────────────────────────────────────────────────────────── */

/** 매 레이드의 기본 킷을 채운다 — 이미 있으면 갈아 끼우지 않는다. */
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

/** 몸에 그려지는 def id 세 개 (`AllyBodyView`) 와 탄창을 지금 장비에서 다시 읽는다. */
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

/* ── 가치 · 등급 비교 ─────────────────────────────────────────────────────── */

/** 이 아이템 한 스택의 값어치 (버릴 것을 고를 때 · 상자에서 무엇을 집을지). */
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

/** 무기의 「좋음」 — 등급 우선, 같으면 피해, 같으면 남은 내구도. */
function weaponScore(sys: AllySystem, it: ItemInstance | null): number {
  if (!it) return -1;
  const st = sys.ctx.loot?.getEffectiveStats(it);
  if (!st) return -1;
  const dur = st.maxDurability > 0 ? (it.durability ?? st.maxDurability) / st.maxDurability : 1;
  return st.grade * 1e6 + st.damage * 1e2 + dur;
}
/** 방탄복의 「좋음」 — 실드 최대치 우선, 같으면 남은 내구도. */
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

/** `item` 이 지금 낀 것보다 나은 같은 종류의 장비면 그 슬롯, 아니면 null. */
export function upgradeSlotOf(sys: AllySystem, a: Ally, item: ItemInstance): 'primary' | 'armor' | 'bag' | null {
  const def = defOf(sys, item.defId);
  if (!def) return null;
  if (def.weaponId && weaponScore(sys, item) > weaponScore(sys, a.equip.primary)) return 'primary';
  if (def.armorId && armorScore(sys, item) > armorScore(sys, a.equip.armor)) return 'armor';
  if (def.bag && bagScore(sys, item) > bagScore(sys, a.equip.bag)) return 'bag';
  return null;
}

/** 같은 잣대로 **분대장이 낀 것**보다 나은가 (사용자 결정 — 더 좋은 장비를 찾으면 건네준다). */
export function beatsLeader(sys: AllySystem, item: ItemInstance): boolean {
  const def = defOf(sys, item.defId);
  if (!def) return false;
  const gear = leaderGear(sys);
  if (def.weaponId) return weaponScore(sys, item) > weaponScore(sys, gear.primary);
  if (def.armorId) return armorScore(sys, item) > armorScore(sys, gear.armor);
  if (def.bag) return bagScore(sys, item) > bagScore(sys, gear.bag);
  return false;
}

/** 분대장의 장착 장비 — 로컬이면 인벤토리, 원격이면 마지막 크루 카드. */
function leaderGear(sys: AllySystem): { primary: ItemInstance | null; armor: ItemInstance | null; bag: ItemInstance | null } {
  const ctx = sys.ctx;
  const localId = ctx.net?.localId ?? null;
  if (!ctx.net?.inSession || sys.leaderId === localId) {
    const l = ctx.inventory?.getLoadout();
    return { primary: l?.primary ?? null, armor: l?.armor ?? null, bag: l?.bag ?? null };
  }
  // 원격 분대장의 장비는 크루 카드가 아는 만큼만이다 (무기 · 방탄복 def id, 가방은 카드에 없다).
  const card = ctx.net?.getCrewCard(sys.leaderId) ?? null;
  const asInst = (defId: string | null | undefined): ItemInstance | null =>
    defId ? ctx.loot?.createItem(defId) ?? null : null;
  return { primary: asInst(card?.primary), armor: asInst(card?.armor), bag: null };
}

/* ── 장비 갈아끼우기 ─────────────────────────────────────────────────────── */

/** 가방에 있는 주운 장비 중 지금 낀 것보다 나은 것이 있으면 갈아 낀다. 바꿨으면 true. */
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
      // 벗은 **주운** 장비는 가방으로, 안 들어가면 바닥에 둔다. 킷은 묶인 물건이라 그냥 사라진다.
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

/** 발밑에 떨군다 (묶인 물건은 절대 여기 오지 않는다). */
export function dropAt(sys: AllySystem, a: Ally, item: ItemInstance): void {
  if (isKit(a, item)) return;
  _v1.copy(a.position);
  sys.ctx.pickups?.spawn(item, _v1);
}

/* ── 짐 버리기 ───────────────────────────────────────────────────────────── */

/**
 * 「무거움」을 벗어나려고 **한 번에 하나씩** 버린다 (사용자 결정 — 가치가 제일 낮은 것 → 무게 가성비가 나쁜 것 →
 * 칸 가성비가 나쁜 것 순). 버렸으면 true.
 */
export function dropWorst(sys: AllySystem, a: Ally): boolean {
  if (!a.bag) return false;
  const seed = raidFoundSeed(sys.ctx);
  let worst: ItemInstance | null = null;
  let worstKey: [number, number, number] | null = null;
  for (const it of a.bag.items()) {
    if (!isRaidFound(it, seed)) continue;   // 킷 · 표식 없는 것은 버릴 대상이 아니다
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

/** 가방에 넣는다 (안 들어가면 바닥으로). 주운 것으로 표시한다. */
export function take(sys: AllySystem, a: Ally, item: ItemInstance): void {
  markRaidFound(item, raidFoundSeed(sys.ctx));
  if (!a.bag || !a.bag.autoPlace(item)) dropAt(sys, a, item);
  a.bagDirty = true;
}

/** 가방에서 조건에 맞는 첫 아이템 (주운 것만 — 킷은 건네지 않는다). */
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

/** 스크래치를 쓰지 않는 위치 복사 (요청 · 목적지 보관용). */
export function clone(v: THREE.Vector3): THREE.Vector3 { return v.clone(); }
