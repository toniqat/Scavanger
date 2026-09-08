/**
 * src/meta/parts/Contracts.ts — **계약 · 퀘스트**.
 *
 * 계약은 하나만 활성이고 목표 카운터가 버스 이벤트(`enemy:killed` / `crate:open` / …)에서 오른다.
 * 분대원의 진척은 `meta contractHit` 로 공유되고, 레이드가 끝나면 `settleMission` 이 `outcome` 에
 * 따라 정산한다. 퀘스트는 가방 + 창고에서 납품받는 사슬이다. **훈련장에서는 아무것도 세지 않는다.**
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

/** `MetaRef.getSquadContracts` — other members only, in peer order. */
export function getSquadContracts(sys: MetaSystem): readonly SquadContractInfo[] {
  const out: SquadContractInfo[] = [];
  for (const [peer, v] of sys.squadContracts) out.push({ peer, id: v.id, progress: v.progress });
  return out;
  }

export function clearSquadContracts(sys: MetaSystem): void {
  if (sys.squadContracts.size === 0) return;
  const peers = [...sys.squadContracts.keys()];
  sys.squadContracts.clear();
  for (const peer of peers) sys.ctx.bus.emit('meta:squadContract', { peer, id: null, progress: 0 });
  }

/** Store a relayed `meta contract`; `id` null (or an unknown def) drops the member's row. */
export function applySquadContract(sys: MetaSystem, peer: PeerId, id: string | null, progress: number): void {
  const known = typeof id === 'string' && CONTRACT_DEFS.some((d) => d.id === id) ? id : null;
  if (!known) {
    if (!sys.squadContracts.delete(peer)) return;
    sys.ctx.bus.emit('meta:squadContract', { peer, id: null, progress: 0 });
    return;
  }
  const def = CONTRACT_DEFS.find((d) => d.id === known)!;
  const p = Math.min(def.target, Math.max(0, Number.isFinite(progress) ? progress : 0));
  const prev = sys.squadContracts.get(peer);
  if (prev && prev.id === known && prev.progress === p) return;
  sys.squadContracts.set(peer, { id: known, progress: p });
  sys.ctx.bus.emit('meta:squadContract', { peer, id: known, progress: p });
  }

/**
 * Tell the squad what we are working on. `to` defaults to every other member; a `metaq sync` answer targets one.
 * Silent outside a real multiplayer raid, and a no-op when nothing changed since the last broadcast.
 */
export function broadcastContract(sys: MetaSystem, to: PeerId | 'others' = 'others', force = false): void {
  const net = sys.ctx.net;
  if (!sys.ctx.isMultiplayer || !net || typeof net.send !== 'function' || sys.inTraining()) return;
  const ac = sys.activeDef() ? sys.store.data.activeContract : null;
  const id = ac?.id ?? null;
  const progress = ac ? Math.floor(ac.progress) : 0;
  const key = `${id ?? '-'}|${progress}`;
  if (to === 'others') {
    if (!force && key === sys.lastContractSent) return;
    sys.lastContractSent = key;
  }
  net.send({ t: 'meta', ev: 'contract', id, progress }, to);
  }

export function localHit(sys: MetaSystem, goal: ContractGoalKind, amount: number): void {
  sys.reportContractHit(goal, amount, true);
  }

export function trackLootValue(sys: MetaSystem, totalValue: number): void {
  if (!sys.ctx.isGameplayPhase() || sys.inTraining()) return;
  const def = sys.activeDef();
  const ac = sys.store.data.activeContract;
  if (!def || !ac || def.goal !== 'extract_with_value') return;
  const v = Math.min(MAX_PROGRESS, Math.max(0, Math.round(totalValue)));
  if (v === ac.progress) return;
  const delta = v - ac.progress;
  ac.progress = v;
  sys.ctx.bus.emit('meta:contractProgress', { id: def.id, corp: def.corp, goal: def.goal, progress: v, target: def.target, delta });
  sys.broadcastContract();
  }

/* ── MetaRef: contracts ─────────────────────────────────────────────────── */
export function getContracts(sys: MetaSystem, corp: CorpId): ContractInfo[] {
  const ac = sys.store.data.activeContract;
  const activeCount = ac ? 1 : 0;
  const level = sys.level(corp);
  return CONTRACT_DEFS.filter((d) => d.corp === corp).map((def) => {
    const active = ac?.id === def.id;
    return {
      def,
      progress: active ? ac!.progress : 0,
      active,
      blocked: active ? REASON.active : contractBlockReason(def, level, activeCount, sys.inShip),
    };
  });
  }

export function acceptContract(sys: MetaSystem, id: string): boolean {
  const def = CONTRACT_DEFS.find((d) => d.id === id);
  if (!def) return false;
  if (contractBlockReason(def, sys.level(def.corp), sys.store.data.activeContract ? 1 : 0, sys.inShip)) return false;
  sys.store.data.activeContract = { id: def.id, progress: 0 };
  sys.progressAtStart = 0;
  sys.store.markDirty();
  sys.ctx.bus.emit('meta:contractAccepted', { id: def.id, corp: def.corp });
  sys.broadcastContract();
  return true;
  }

export function abandonContract(sys: MetaSystem): boolean {
  const def = sys.activeDef();
  if (!def) return false;
  sys.store.data.activeContract = null;
  sys.progressAtStart = 0;
  sys.store.markDirty();
  sys.ctx.bus.emit('meta:contractAbandoned', { id: def.id, corp: def.corp });
  sys.broadcastContract();
  return true;
  }

export function reportContractHit(sys: MetaSystem, goal: ContractGoalKind, amount: number, local: boolean): void {
  const def = sys.activeDef();
  const ac = sys.store.data.activeContract;
  if (!def || !ac || def.goal !== goal || !Number.isFinite(amount)) return;
  const delta = contractHitDelta(amount, local);
  if (delta <= 0) return;
  const before = ac.progress;
  ac.progress = Math.min(MAX_PROGRESS, before + delta);
  sys.store.markDirty();
  sys.ctx.bus.emit('meta:contractProgress', { id: def.id, corp: def.corp, goal, progress: ac.progress, target: def.target, delta: ac.progress - before });
  if (local && sys.ctx.isMultiplayer && sys.ctx.net && typeof sys.ctx.net.send === 'function') {
    // a receiver drops anything above META_HIT_MAX (a real hit is 1) — send the capped figure and remember it for `metaq sync`
    const sent = Math.min(META_HIT_MAX, Math.max(0, amount));
    if (sent >= 1) {
      sys.sentHits.set(goal, (sys.sentHits.get(goal) ?? 0) + sent);
      sys.ctx.net.send({ t: 'meta', ev: 'contractHit', corp: def.corp, goal, amount: sent }, 'others');
    }
  }
  // the squad's HUD rows follow our own progress (deduped on `{id}|{floor(progress)}`)
  if (local) sys.broadcastContract();
  }

export function settleMission(sys: MetaSystem, stats: MissionStats): ContractSettlement | null {
  if (!stats || stats.mode === 'training') return null;   // the 시뮬레이션 훈련장 settles nothing
  const def = sys.activeDef();
  const ac = sys.store.data.activeContract;
  if (!def || !ac) return null;
  const { settlement, keepProgress } = settleContract(def, ac.progress, sys.progressAtStart, stats);
  if (settlement.success) {
    sys.store.data.activeContract = null;
    sys.store.data.stats.contractsDone += 1;
    if (settlement.rep > 0) sys.addRep(def.corp, settlement.rep, `contract:${def.id}`);
    if (settlement.credits > 0) {
      sys.addCredits(settlement.credits, `contract:${def.id}`);
      sys.store.data.stats.creditsEarned += settlement.credits;
    }
  } else {
    ac.progress = keepProgress ?? 0;
  }
  sys.progressAtStart = sys.store.data.activeContract?.progress ?? 0;
  sys.store.markDirty();
  sys.ctx.bus.emit('meta:contractSettled', settlement);
  return settlement;
  }

/* ── MetaRef: quests ────────────────────────────────────────────────────── */
export function getQuestState(sys: MetaSystem, id: string): QuestState {
  const def = QUEST_DEFS.find((d) => d.id === id);
  if (!def) return 'locked';
  return questStateOf(def, sys.store.corp(def.corp).quests[id], sys.level(def.corp), (q) => sys.getQuestState(q));
  }

export function questInfo(sys: MetaSystem, def: typeof QUEST_DEFS[number]): QuestInfo {
  const state = sys.getQuestState(def.id);
  const deliver = def.deliver.map((d) => ({ defId: d.defId, qty: d.qty, have: sys.countAll(d.defId) }));
  const blocked = questBlockReason(state, deliver, sys.inShip) ?? sys.questBlocked.get(def.id) ?? null;
  return { def, state, deliver, blocked };
  }

export function getQuests(sys: MetaSystem, corp: CorpId): QuestInfo[] {
  return QUEST_DEFS.filter((d) => d.corp === corp).map((d) => sys.questInfo(d));
  }

export function acceptQuest(sys: MetaSystem, id: string): boolean {
  const def = QUEST_DEFS.find((d) => d.id === id);
  if (!def || !sys.inShip) return false;
  if (sys.getQuestState(id) !== 'available') return false;
  sys.store.corp(def.corp).quests[id] = 'accepted';
  sys.store.markDirty();
  sys.ctx.bus.emit('meta:questChanged', { id, corp: def.corp, state: 'accepted' });
  return true;
  }

export function completeQuest(sys: MetaSystem, id: string): boolean {
  const def = QUEST_DEFS.find((d) => d.id === id);
  if (!def || !sys.inShip) return false;
  if (sys.getQuestState(id) !== 'accepted') return false;
  const inv = sys.ctx.inventory;
  const loot = sys.ctx.loot;
  if (!inv || !loot) return false;
  for (const d of def.deliver) if (sys.countAll(d.defId) < d.qty) { sys.questBlocked.set(id, REASON.missing); return false; }

  // rewards first: nothing is consumed unless every reward item found a home (bag, else stash)
  const placed: ItemInstance[] = [];
  for (const r of def.rewards.items ?? []) {
    const remaining = Math.max(1, Math.floor(r.qty));
    const rdef = loot.getItemDef(r.defId);
    if (!rdef) continue;   // unknown reward id: skip rather than block the chain
    const per = Math.max(1, rdef.stackMax);
    let left = remaining;
    while (left > 0) {
      const n = Math.min(per, left);
      const item = loot.createItem(r.defId, n);
      if (!sys.addAnywhere(item)) {
        for (const p of placed) sys.takeBack(p.uid);
        sys.questBlocked.set(id, REASON.space);
        return false;
      }
      placed.push(item);
      left -= n;
    }
  }
  for (const d of def.deliver) {
    const ok = typeof inv.consumeDefAll === 'function' ? inv.consumeDefAll(d.defId, d.qty) : inv.consumeWhere((x) => x.id === d.defId, d.qty) >= d.qty;
    if (!ok) console.warn(`[meta] quest ${id}: delivery of ${d.defId} ×${d.qty} could not be consumed fully`);
  }
  sys.questBlocked.delete(id);
  sys.store.corp(def.corp).quests[id] = 'complete';
  sys.store.data.stats.questsDone += 1;
  if (def.rewards.credits) {
    sys.addCredits(def.rewards.credits, `quest:${id}`);
    sys.store.data.stats.creditsEarned += def.rewards.credits;
  }
  if (def.rewards.rep) sys.addRep(def.corp, def.rewards.rep, `quest:${id}`);
  const prog = sys.ctx.progression;
  if (def.rewards.xp > 0 && prog && typeof prog.addXp === 'function') { try { prog.addXp(def.rewards.xp); } catch { /* progression not ready */ } }
  sys.store.markDirty();
  sys.ctx.bus.emit('meta:questChanged', { id, corp: def.corp, state: 'complete' });
  return true;
  }
