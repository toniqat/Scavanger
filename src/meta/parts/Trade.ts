/**
 * src/meta/parts/Trade.ts — **기업 상점: 구매 · 판매 · 가격**.
 *
 * 신뢰도가 무엇을 팔지 정하고(`getShop`), 크레딧은 릴레이가 있으면 **서버 트랜잭션**이다:
 * 낙관적으로 차감 → `credits:tx` → `ok` 에서 아이템 지급, 실패하면 전액 되돌림.
 * 오프라인이면 같은 검사를 로컬에서 미리 하고 끝낸다.
 */
import type {
  ConsoleCommand, ContractDef, ContractGoalKind, ContractInfo, ContractSettlement, CorpId, CreditsTxResult, EmbeddedView,
  GameContext, GameMessageOf, GameSystem, ItemDef, ItemInstance, MetaRef, MetaRequest, MissionStats, PeerId, ProfileRef, QuestInfo,
  QuestState, RepInfo, ShopItem, SquadContractInfo,
} from '@/shared';
import {
  CONTRACT_DEFS, CONTRACT_GOAL_LABEL_KO, CORP_DEFS, CORP_IDS, CREDITS_MAX, META_HIT_MAX, QUEST_DEFS, formatCredits,
  repLevelOf, sellPriceOf,
} from '@/shared';
import { MAX_PROGRESS, MetaStorage } from '../Storage';
import {
  REASON, buildShop, canRepairImplant, contractBlockReason, contractHitDelta, corpSells, implantRepairCost, implantRepairFee,
  implantRepairMaterialIds, isRepairableImplantDef, killGoalOf, questBlockReason, questStateOf, repInfoOf, settleContract,
} from '../Rules';
import { CorpView } from '../ui/CorpView';
import { CORP_ALIASES, GOAL_IDS, type ImplantRepairInfo, type ImplantRepairResult, type PurchaseFailure, isValidHit } from '../model';
import type { MetaSystem } from '../MetaSystem';
/* 2026-09-11 (E-4 ⑦): 크레딧 사유는 계약 문법으로만 만든다 — 릴레이가 해석하고 금액을 검사한다 (`shared/credits.ts`). */
import { formatCreditReason } from '@/shared';

/** Bag / stash pre-check (`InventoryRef.canFit`); a missing helper counts as "fits" (inventory/ built in parallel). */
export function fits(sys: MetaSystem, defId: string, qty = 1): boolean {
  const inv = sys.ctx.inventory;
  if (!inv || typeof inv.canFit !== 'function') return true;
  try { return inv.canFit(defId, qty) !== null; } catch { return true; }
  }

export function findAnywhere(sys: MetaSystem, uid: string): ItemInstance | null {
  const inv = sys.ctx.inventory;
  if (!inv) return null;
  if (typeof inv.findItemAnywhere === 'function') { const i = inv.findItemAnywhere(uid); if (i) return i; }
  return inv.findItem(uid) ?? null;
  }

/** Bag + stash units of a def (corp views render 보유/필요 chips from it). */
export function countAll(sys: MetaSystem, defId: string): number {
  const inv = sys.ctx.inventory;
  if (!inv) return 0;
  if (typeof inv.countDefAll === 'function') return inv.countDefAll(defId);
  return inv.countWhere((d) => d.id === defId);
  }

/** Bag first, then the stash; falls back to the bag-only `tryAddItem` while inventory's helper is a stub. */
export function addAnywhere(sys: MetaSystem, item: ItemInstance): 'bag' | 'stash' | null {
  const inv = sys.ctx.inventory;
  if (!inv) return null;
  if (typeof inv.tryAddItemAnywhere === 'function') {
    const where = inv.tryAddItemAnywhere(item);
    if (where) return where;
    return null;
  }
  return inv.tryAddItem(item) ? 'bag' : null;
  }

export function takeBack(sys: MetaSystem, uid: string, qty?: number): number {
  const inv = sys.ctx.inventory;
  if (!inv || typeof inv.takeItem !== 'function') return 0;
  try { return inv.takeItem(uid, qty); } catch { return 0; }
  }

/* ── MetaRef: shop ──────────────────────────────────────────────────────── */
export function getShop(sys: MetaSystem, corp: CorpId): ShopItem[] {
  const loot = sys.ctx.loot;
  const def = CORP_DEFS[corp];
  if (!loot || !def) return [];
  return buildShop(def, loot.getAllItemDefs(), sys.level(corp), sys.credits, sys.inShip, (id) => loot.getWeaponDef(id), (id) => sys.fits(id));
  }

export function priceOf(sys: MetaSystem, corp: CorpId, defId: string): number | null {
  const loot = sys.ctx.loot;
  const cdef = CORP_DEFS[corp];
  const def = loot?.getItemDef(defId);
  if (!loot || !cdef || !def) return null;
  const level = sys.level(corp);
  // Phase 12: an `implantRepairMaterials` rule needs the whole catalogue to know which materials it covers
  const all = loot.getAllItemDefs();
  if (!corpSells(cdef, def, level, (id) => loot.getWeaponDef(id), implantRepairMaterialIds(all))) return null;
  return buildShop(cdef, all.filter((d) => d.id === def.id || d.category === 'implant'), level, sys.credits, true, (id) => loot.getWeaponDef(id))
    .find((l) => l.def.id === def.id)?.price ?? null;
  }

/**
 * Purchase. Synchronous answer = was the request accepted (ship, on the shelf, `canFit`, credits). Offline the item
 * is created and placed right here (pre-checked, so no refund step is needed — a placement failure still refunds
 * defensively). With a server profile the credits are debited optimistically, the server transaction runs, and only
 * an `ok` answer creates + places the item (a placement failure refunds through the server); either way completion
 * is announced by `meta:purchase` and a failure by `onPurchaseFailed` / `lastPurchaseFailure`.
 */
export function buy(sys: MetaSystem, corp: CorpId, defId: string): boolean {
  const fail = (reason: string, price = 0): false => {
    sys.lastPurchaseFailure = { corp, defId, price, reason };
    return false;
  };
  if (!sys.inShip) return fail(REASON.shipOnly);
  const loot = sys.ctx.loot;
  const price = sys.priceOf(corp, defId);
  if (!loot || price === null) return fail('판매하지 않는 품목');
  if (!sys.fits(defId)) return fail(REASON.space, price);
  if (sys.credits < price) return fail(REASON.credits, price);
  sys.lastPurchaseFailure = null;
  const reason = formatCreditReason({ kind: 'buy', id: defId });
  const refund = formatCreditReason({ kind: 'refund', id: defId });

  if (!sys.serverCredits) {
    if (!sys.applyCreditsLocal(-price, reason)) return fail(REASON.credits, price);
    let placed: 'bag' | 'stash' | null = null;
    try { placed = sys.addAnywhere(loot.createItem(defId, 1)); } catch { placed = null; }
    if (!placed) { sys.applyCreditsLocal(price, refund); return fail(REASON.space, price); }
    sys.completePurchase(corp, defId, price, placed);
    return true;
  }

  // server-owned credits: optimistic debit → transaction → item only on `ok`
  if (!sys.applyCreditsLocal(-price, reason)) return fail(REASON.credits, price);
  void sys.serverTx(-price, reason).then((res) => {
    if (res && !res.ok) {                                   // refused (balance already reverted by serverTx)
      sys.failPurchase({ corp, defId, price, reason: res.reason || REASON.credits });
      return;
    }
    // `null` = socket gone mid-transaction: the local debit stands (offline fallback) and the item is delivered
    let placed: 'bag' | 'stash' | null = null;
    try { placed = sys.addAnywhere(loot.createItem(defId, 1)); } catch { placed = null; }
    if (!placed) {
      sys.applyCreditsLocal(price, refund);
      if (res) void sys.serverTx(price, refund, false);   // pairs with the `buy:` debit on the relay's ledger (60 s window)
      sys.failPurchase({ corp, defId, price, reason: REASON.space });
      return;
    }
    sys.completePurchase(corp, defId, price, placed);
  });
  return true;
  }

export function completePurchase(sys: MetaSystem, corp: CorpId, defId: string, price: number, placed: 'bag' | 'stash'): void {
  sys.store.data.stats.creditsSpent += price;
  sys.store.markDirty();
  sys.ctx.bus.emit('meta:purchase', { corp, defId, price, placed });
  }

export function failPurchase(sys: MetaSystem, f: PurchaseFailure): void {
  sys.lastPurchaseFailure = f;
  try { sys.onPurchaseFailed?.(f); } catch { /* ui */ }
  for (const fn of [...sys.purchaseFailListeners]) { try { fn(f); } catch { /* ui */ } }
  }

/** Subscribe to async purchase refusals (folder-internal; the standalone screen and every embedded 기업 tab use it). */
export function onPurchaseFailure(sys: MetaSystem, fn: (f: PurchaseFailure) => void): () => void {
  sys.purchaseFailListeners.add(fn);
  return () => { sys.purchaseFailListeners.delete(fn); };
  }

export function sell(sys: MetaSystem, uid: string, qty?: number): boolean {
  if (!sys.inShip) return false;
  const inv = sys.ctx.inventory;
  if (!inv || typeof inv.takeItem !== 'function') return false;
  const inst = sys.findAnywhere(uid);
  if (!inst || sys.equippedUids().has(uid)) return false;
  const def = sys.itemDef(inst.defId);
  if (!def || !(def.value > 0)) return false;
  const want = Math.max(1, Math.min(inst.qty, Math.floor(qty ?? inst.qty)));
  // E-4 (⑦): remember what leaves the inventory — a relay refusal puts it back (durability · sockets · loaded rounds intact)
  const snap = JSON.parse(JSON.stringify(inst)) as ItemInstance;
  const fromStash = typeof inv.getStashItems === 'function' && inv.getStashItems().some((i) => i.uid === uid);
  const removed = sys.takeBack(uid, want);
  if (removed <= 0) return false;
  /*
   * E-4 (⑦): one `sell:<id>:<qty>` transaction per stack — the relay accepts `qty ≤ stackMax` and at most
   * `sellPriceOf(value, qty)`. A normal stack never exceeds `stackMax`, so this is a single transaction with exactly the
   * old price; an oversized legacy stack is split so it is not refused.
   *
   * 2026-09-11 (E-9): `sellPriceOf` **floors**, so a chunk can legitimately be worth **0 C** (가치 1 아이템 한 개).
   * That sale still happens locally — 0 C is the price, not a refusal (사용자 결정) — but the `price <= 0` skip below is
   * now load-bearing: `server/Economy.ts` requires `0 < delta` on a `sell:` transaction, so sending it would come back
   * refused and `restoreSold` would put the item back with a 판매 취소 toast ("팔았는데 안 팔림"). A 0 C transaction has
   * nothing to tell the server anyway — the balance does not move.
   */
  const stack = Math.max(1, Math.floor(def.stackMax || 1));
  const chunks: number[] = [];
  for (let left = removed; left > 0; left -= Math.min(stack, left)) chunks.push(Math.min(stack, left));
  const credits = chunks.reduce((sum, n) => sum + sellPriceOf(def.value, n), 0);
  if (!sys.applyCreditsLocal(credits, formatCreditReason({ kind: 'sell', id: def.id, qty: removed }))) return false;
  if (sys.serverCredits) {
    let restoredUid = false;
    for (const n of chunks) {
      const price = sellPriceOf(def.value, n);
      if (price <= 0) continue;
      void sys.serverTx(price, formatCreditReason({ kind: 'sell', id: def.id, qty: n })).then((res) => {
        if (!res || res.ok) return;                         // null = socket gone: the local sale stands (offline fallback)
        // refused: serverTx already reverted the credits — put the units back where they came from
        const reuseUid = !restoredUid && removed === snap.qty && !sys.findAnywhere(snap.uid);
        restoredUid ||= reuseUid;
        restoreSold(sys, snap, n, reuseUid, fromStash);
        sys.store.data.stats.creditsEarned = Math.max(0, sys.store.data.stats.creditsEarned - price);
        sys.store.markDirty();
        sys.ctx.bus.emit('ui:notify', { text: `판매가 취소되었습니다 — ${def.name} (${res.reason || '서버 거절'})`, kind: 'warning' });
      });
    }
  }
  sys.store.data.stats.creditsEarned += credits;
  sys.store.markDirty();
  sys.ctx.bus.emit('meta:sale', { defId: def.id, qty: removed, credits });
  return true;
  }

/** Put `units` of a refused sale back (stash first when it came from there). `reuseUid` = the whole stack left under this uid. */
function restoreSold(sys: MetaSystem, snap: ItemInstance, units: number, reuseUid: boolean, fromStash: boolean): void {
  const loot = sys.ctx.loot;
  const inv = sys.ctx.inventory;
  if (!loot || !inv) return;
  let uid = snap.uid;
  if (!reuseUid) {
    try { uid = loot.createItem(snap.defId, units).uid; } catch { return; }
  }
  const item: ItemInstance = { ...(JSON.parse(JSON.stringify(snap)) as ItemInstance), uid, qty: units };
  const placed = (fromStash && typeof inv.tryAddToStash === 'function' && inv.tryAddToStash(item)) || !!sys.addAnywhere(item);
  if (!placed) console.warn(`[meta] refused sale: ${snap.defId} ×${units} found no home`);
  }

export function getSellable(sys: MetaSystem): readonly ItemInstance[] {
  const inv = sys.ctx.inventory;
  if (!inv) return [];
  const equipped = sys.equippedUids();
  const out: ItemInstance[] = [];
  const seen = new Set<string>();
  const consider = (inst: ItemInstance): void => {
    if (seen.has(inst.uid) || equipped.has(inst.uid)) return;
    const def = sys.itemDef(inst.defId);
    if (!def || !(def.value > 0)) return;
    seen.add(inst.uid);
    out.push(inst);
  };
  for (const inst of inv.getAllItems()) consider(inst);
  if (typeof inv.getStashItems === 'function') for (const inst of inv.getStashItems()) consider(inst);
  return out;
  }
