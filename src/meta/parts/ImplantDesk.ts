/**
 * src/meta/parts/ImplantDesk.ts — **세레스 바이오 임플란트 수리 데스크** (Phase 12).
 *
 * 레이드에서는 **망가진 임플란트만** 나온다. 여기서 재료 + 수수료를 내고 고치면 쓸 수 있는 물건이 된다.
 * 크레딧 경로는 구매와 완전히 같고(서버 트랜잭션 / 오프라인 분기), 실패하면 재료까지 전액 되돌린다.
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
/* 2026-09-11 (E-4 ⑦): 사유는 계약 문법으로 — 릴레이가 `repair:` = −수리비, `refund:repair:` = 그 짝을 검사한다. */
import { formatCreditReason } from '@/shared';

/** Every broken implant in the bag + stash (equipped implants live in progression, so they never show up). */
export function getRepairableImplants(sys: MetaSystem): ImplantRepairInfo[] {
  const inv = sys.ctx.inventory;
  if (!inv) return [];
  const out: ImplantRepairInfo[] = [];
  const seen = new Set<string>();
  const consider = (inst: ItemInstance): void => {
    if (seen.has(inst.uid)) return;
    const def = sys.itemDef(inst.defId);
    if (!isRepairableImplantDef(def)) return;
    seen.add(inst.uid);
    out.push(sys.repairInfo(inst, def));
  };
  for (const inst of inv.getAllItems()) consider(inst);
  if (typeof inv.getStashItems === 'function') for (const inst of inv.getStashItems()) consider(inst);
  out.sort((a, b) => {
    const ra = a.target ? -implantRepairFee(a.target) : 0, rb = b.target ? -implantRepairFee(b.target) : 0;   // best first
    if (ra !== rb) return ra - rb;
    return a.broken.name.localeCompare(b.broken.name, 'ko');
  });
  return out;
  }

/** The desk's view of one broken implant, or null when `uid` is not a broken implant in the bag / stash. */
export function getImplantRepair(sys: MetaSystem, uid: string): ImplantRepairInfo | null {
  const inst = sys.findAnywhere(uid);
  const def = inst ? sys.itemDef(inst.defId) : undefined;
  if (!inst || !isRepairableImplantDef(def)) return null;
  return sys.repairInfo(inst, def);
  }

export function repairInfo(sys: MetaSystem, inst: ItemInstance, broken: ItemDef): ImplantRepairInfo {
  const targetId = broken.implant?.repairsTo;
  const target = targetId ? sys.itemDef(targetId) ?? null : null;
  const cost = implantRepairCost(broken).map((c) => ({ defId: c.defId, qty: c.qty, have: sys.countAll(c.defId) }));
  const fee = target ? implantRepairFee(target) : 0;
  let blocked = canRepairImplant({
    broken, target, credits: sys.credits, fee, inShip: sys.inShip,
    have: (id) => sys.countAll(id),
    // the broken one leaves before the repaired one arrives, so a same-footprint swap always fits
    fits: !target || target.width * target.height <= broken.width * broken.height || sys.fits(target.id),
  });
  if (!blocked && sys.repairPending.has(inst.uid)) blocked = '수리 진행 중';
  return { inst, broken, target, cost, fee, blocked };
  }

/** Subscribe to finished repairs (the server path completes after `repairImplant` returned). */
export function onImplantRepaired(sys: MetaSystem, fn: (r: ImplantRepairResult) => void): () => void {
  sys.repairListeners.add(fn);
  return () => { sys.repairListeners.delete(fn); };
  }

/** Is the fee transaction for `uid` still in flight? */
export function isRepairPending(sys: MetaSystem, uid: string): boolean { return sys.repairPending.has(uid); }

/**
 * Repair the broken implant `uid`. Synchronous answer = the request was accepted (offline: the swap already
 * happened; server: the fee is debited optimistically and the swap follows the `credits:tx` answer). Completion
 * (either way) is reported through `onImplantRepaired` + a `ui:notify` toast.
 */
export function repairImplant(sys: MetaSystem, uid: string): boolean {
  const info = sys.getImplantRepair(uid);
  if (!info) return false;
  if (info.blocked) { sys.finishRepair({ uid, brokenId: info.broken.id, targetId: info.target?.id ?? null, fee: info.fee, ok: false, reason: info.blocked }); return false; }
  const target = info.target!;
  const reason = formatCreditReason({ kind: 'repair', id: info.broken.id });
  const refund = formatCreditReason({ kind: 'refund-repair', id: info.broken.id });
  if (!sys.applyCreditsLocal(-info.fee, reason)) {
    sys.finishRepair({ uid, brokenId: info.broken.id, targetId: target.id, fee: info.fee, ok: false, reason: REASON.credits });
    return false;
  }
  if (!sys.serverCredits) {
    const res = sys.performRepair(uid, info.broken, target);
    if (!res.ok) sys.applyCreditsLocal(info.fee, refund);
    else { sys.store.data.stats.creditsSpent += info.fee; sys.store.markDirty(); }
    sys.finishRepair({ uid, brokenId: info.broken.id, targetId: target.id, fee: info.fee, ...res });
    return res.ok;
  }
  // server-owned credits: optimistic debit → transaction → swap only on `ok` (mirrors `buy`)
  sys.repairPending.add(uid);
  void sys.serverTx(-info.fee, reason).then((tx) => {
    sys.repairPending.delete(uid);
    if (tx && !tx.ok) {                                  // refused: serverTx already reverted the local debit
      sys.finishRepair({ uid, brokenId: info.broken.id, targetId: target.id, fee: info.fee, ok: false, reason: tx.reason || REASON.credits });
      return;
    }
    // `null` = socket gone mid-transaction: the local debit stands (offline fallback) and the repair is delivered
    const res = sys.performRepair(uid, info.broken, target);
    if (!res.ok) {
      sys.applyCreditsLocal(info.fee, refund);
      if (tx) void sys.serverTx(info.fee, refund, false);
    } else { sys.store.data.stats.creditsSpent += info.fee; sys.store.markDirty(); }
    sys.finishRepair({ uid, brokenId: info.broken.id, targetId: target.id, fee: info.fee, ...res });
  });
  return true;
  }

/**
 * The item half of a repair: re-validate (the broken implant / materials may have moved since the click), take the
 * broken implant, consume the materials, create the repaired one (stash first, then anywhere). Any failure puts
 * everything taken so far back — the caller refunds the fee.
 */
export function performRepair(sys: MetaSystem, uid: string, broken: ItemDef, target: ItemDef): { ok: boolean; reason: string | null } {
  const inv = sys.ctx.inventory;
  const loot = sys.ctx.loot;
  if (!inv || !loot || typeof inv.takeItem !== 'function') return { ok: false, reason: REASON.notBroken };
  const inst = sys.findAnywhere(uid);
  if (!inst || inst.defId !== broken.id) return { ok: false, reason: REASON.notBroken };
  const cost = implantRepairCost(broken);
  for (const c of cost) if (sys.countAll(c.defId) < c.qty) return { ok: false, reason: REASON.materials };
  if (sys.takeBack(uid, 1) <= 0) return { ok: false, reason: REASON.notBroken };
  const consumed: { defId: string; qty: number }[] = [];
  const undo = (): void => {
    for (const c of consumed) sys.giveBack(c.defId, c.qty);
    sys.giveBack(broken.id, 1);
  };
  for (const c of cost) {
    const ok = typeof inv.consumeDefAll === 'function' ? inv.consumeDefAll(c.defId, c.qty) : inv.consumeWhere((x) => x.id === c.defId, c.qty) >= c.qty;
    if (!ok) { undo(); return { ok: false, reason: REASON.materials }; }
    consumed.push({ defId: c.defId, qty: c.qty });
  }
  let item: ItemInstance;
  try { item = loot.createItem(target.id, 1); } catch { undo(); return { ok: false, reason: REASON.noTarget }; }
  const placed = (typeof inv.tryAddToStash === 'function' && inv.tryAddToStash(item)) || !!sys.addAnywhere(item);
  if (!placed) { undo(); return { ok: false, reason: REASON.space }; }
  return { ok: true, reason: null };
  }

/** Re-create `qty` of `defId` into the bag / stash (undo of a consumed material or a taken broken implant). */
export function giveBack(sys: MetaSystem, defId: string, qty: number): void {
  const loot = sys.ctx.loot;
  const def = sys.itemDef(defId);
  if (!loot || !def) return;
  const per = Math.max(1, def.stackMax);
  let left = Math.max(0, Math.floor(qty));
  while (left > 0) {
    const n = Math.min(per, left);
    try { if (!sys.addAnywhere(loot.createItem(defId, n))) console.warn(`[meta] repair undo: ${defId} ×${n} found no home`); } catch { /* def gone */ }
    left -= n;
  }
  }

export function finishRepair(sys: MetaSystem, r: ImplantRepairResult): void {
  if (r.ok) {
    const name = r.targetId ? sys.itemDef(r.targetId)?.name ?? r.targetId : r.brokenId;
    sys.ctx.bus.emit('ui:notify', { text: `임플란트 수리 완료 — ${name}`, kind: 'success' });
  }
  for (const fn of [...sys.repairListeners]) { try { fn(r); } catch { /* ui */ } }
  }
