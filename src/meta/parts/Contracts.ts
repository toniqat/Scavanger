/**
 * src/meta/parts/Contracts.ts — **contracts · quests**.
 *
 * One contract is active at a time and its goal counter rises from bus events (`enemy:killed` / `crate:open` / …).
 * A squadmate's progress is shared as `meta contractHit`, and when the raid ends `settleMission` settles it by
 * `outcome`. A quest is a chain delivered from the bag + stash. **The training range counts nothing.**
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
import { CORP_ALIASES, GOAL_IDS, INVENTORY_GOALS, type ImplantRepairInfo, type ImplantRepairResult, type PurchaseFailure, isValidHit } from '../model';
import type { MetaSystem } from '../MetaSystem';
/* 2026-09-11 (E-4 ⑦): credit reasons are built with the contract grammar (`shared/credits.ts`). */
import { formatCreditReason } from '@/shared';
/* 2026-09-12 (§5-2): an item recovery contract counts only what was found in this raid (`shared/raidFound.ts`). */
import { isRaidFound, raidFoundSeed } from '@/shared';
/* 2026-09-13 (library series): the reputation books — a finished contract's rep × `1 + trustXp.all + trustXp[corp]` */
import { libraryTrustMul } from '@/shared';

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

/**
 * 2026-09-12 (E2): units of `defId` **on the body** — bag grid + quick slots + pouch (`InventoryRef.countWhere`), never the
 * 함선 창고. That is what an `extract_with_items` contract checks at extraction. 0 without an inventory.
 *
 * 2026-09-12 (§5-2, user's decision): **only units found in this raid** count — `ItemInstance.raidFound` equal to `seed`
 * (`shared/raidFound.isRaidFound`). `seed` defaults to the running raid's (`raidFoundSeed`, null outside a real raid → 0).
 * Brought units (from the ship, crafted, bought) never count, so the whole target has to come out of one raid.
 */
export function carriedCount(sys: MetaSystem, defId: string | undefined, seed?: number | null): number {
  const inv = sys.ctx.inventory;
  if (!defId || !inv || typeof inv.countWhere !== 'function') return 0;
  const s = seed === undefined ? raidFoundSeed(sys.ctx) : seed;
  if (s === null) return 0;
  try { return Math.max(0, Math.floor(inv.countWhere((d, inst) => d.id === defId && isRaidFound(inst, s)))); } catch { return 0; }
}

/**
 * 2026-09-12 (E2): live `extract_with_items` readout for the HUD (the settlement recounts the body itself). Mirrors
 * `trackLootValue`: raid only, never in the 훈련장, and the squad row follows through `broadcastContract`.
 */
export function trackItemCount(sys: MetaSystem): void {
  const def = sys.activeDef();
  const ac = sys.store.data.activeContract;
  if (!def || !ac || def.goal !== 'extract_with_items') return;
  if (!sys.ctx.isGameplayPhase() || sys.inTraining()) {
    // 2026-09-12 (§5-2): outside a raid nothing counts (the marks are gone) — never carry a raid's count into the ship UI
    if (ac.progress !== 0) { ac.progress = 0; sys.progressAtStart = 0; sys.store.markDirty(); }
    return;
  }
  const v = Math.min(MAX_PROGRESS, carriedCount(sys, def.itemDefId));
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
  if (INVENTORY_GOALS.has(goal)) return;   // 2026-09-12 (E2): the body decides `extract_with_items`, not hits
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

/** 2026-09-13: `libraryTrustMul` over housing's summary — 1 while housing cannot answer (parallel work · a
 *  skeleton). */
export function libraryTrustMulOf(sys: MetaSystem, corp: CorpId): number {
  const h = sys.ctx.housing;
  if (!h || typeof h.getLibraryEffects !== 'function') return 1;
  try {
    const mul = libraryTrustMul(h.getLibraryEffects(), corp);
    return Number.isFinite(mul) && mul > 0 ? mul : 1;
  } catch { return 1; }
}

export function settleMission(sys: MetaSystem, stats: MissionStats): ContractSettlement | null {
  if (!stats || stats.mode === 'training') return null;   // the 시뮬레이션 훈련장 settles nothing
  const def = sys.activeDef();
  const ac = sys.store.data.activeContract;
  if (!def || !ac) return null;
  // 2026-09-12 (E2): `extract_with_items` counts the body **now** — `game/` settles before `game:complete`, while the bag
  // still holds what came out of the raid (nothing moves it to the 창고 until the player does so in the ship)
  // 2026-09-12 (§5-2): only units found in **this** raid — the running raid's seed, else the settled mission's own seed
  const carried = def.goal === 'extract_with_items' ? carriedCount(sys, def.itemDefId, raidFoundSeed(sys.ctx) ?? stats.seed) : undefined;
  const { settlement, keepProgress } = settleContract(def, ac.progress, sys.progressAtStart, stats, carried);
  if (settlement.success) {
    sys.store.data.activeContract = null;
    sys.store.data.stats.contractsDone += 1;
    /* 2026-09-13 (library series): the library's reputation books raise the rep a finished contract pays (never a
       quest reward). The settlement object itself is edited, so the results screen and `meta:contractSettled` say
       what was really received. Reputation is not credits — `addRep` only writes the local store and emits
       `meta:repChanged`, it never passes the server's credit check (`credits:tx`), so a multiplier cannot be
       refused. */
    if (settlement.rep > 0) settlement.rep = Math.max(0, Math.round(settlement.rep * libraryTrustMulOf(sys, def.corp)));
    if (settlement.rep > 0) sys.addRep(def.corp, settlement.rep, `contract:${def.id}`);
    if (settlement.credits > 0) {
      sys.addCredits(settlement.credits, formatCreditReason({ kind: 'contract', id: def.id }));   // E-4: = contracts.csv reward, ≤ 12/h
      sys.store.data.stats.creditsEarned += settlement.credits;
    }
  } else {
    // 2026-09-12 (§5-2): an item contract starts every raid from 0 — what was found this time does not count next time
    ac.progress = def.goal === 'extract_with_items' ? 0 : keepProgress ?? 0;
  }
  sys.progressAtStart = sys.store.data.activeContract?.progress ?? 0;
  sys.store.markDirty();
  sys.ctx.bus.emit('meta:contractSettled', settlement);
  return settlement;
  }

/* ── MetaRef: quests ────────────────────────────────────────────────────────
 * 2026-09-14: corp quests dropped (docs/DECISIONS.md 「2026-09-14 — 메신저 · NPC 퀘스트 · 단체방」) — quests come
 * from an NPC through the messenger (`parts/NpcQuests.ts`, `ctx.meta.npc`). The old API stays because it is a
 * contract, but the corp quest table (`QUEST_DEFS`) is empty, so it answers with an empty list · false.
 * `getQuestState` is answered by `MetaSystem` out of the NPC quests. */
export function questInfo(sys: MetaSystem, def: typeof QUEST_DEFS[number]): QuestInfo {
  const deliver = def.deliver.map((d) => ({ defId: d.defId, qty: d.qty, have: sys.countAll(d.defId) }));
  return { def, state: 'locked', deliver, blocked: REASON.locked };
  }

export function getQuests(_sys: MetaSystem, _corp: CorpId): QuestInfo[] {
  return [];
  }

export function acceptQuest(_sys: MetaSystem, _id: string): boolean {
  return false;
  }

/**
 * 2026-09-11 (E-6): a completed quest took items out of the 창고 / 가방 and wrote `complete` into the meta save — one edit,
 * so it goes to the server as **one** transaction (all or nothing): a crash or a refused write in between can no longer
 * leave the reward handed out with the delivery still in the 창고, or the reverse. The inventory writes its debounced
 * saves now (`InventoryRef.flushSaves`), meta flushes its own, and the queued documents are joined with
 * `ProfileRef.setMany` (it skips a key whose document did not change). Offline the same transaction waits in the queue.
 */
export function commitQuestTx(sys: MetaSystem): void {
  const p = sys.profileRef();
  try { sys.ctx.inventory?.flushSaves?.(); } catch { /* inventory not ready */ }
  sys.save();
  if (!p || typeof p.setMany !== 'function' || typeof p.get !== 'function') return;
  try {
    const docs: Partial<Record<'meta' | 'stash' | 'loadout', unknown>> = {};
    for (const k of ['meta', 'stash', 'loadout'] as const) { const d = p.get(k); if (d !== undefined) docs[k] = d; }
    if (Object.keys(docs).length > 1) p.setMany(docs);
  } catch { /* net not ready */ }
  }

/** 2026-09-14: corp quests dropped — always false. An NPC quest is reported with `ctx.meta.npc.report(id)`. */
export function completeQuest(_sys: MetaSystem, _id: string): boolean {
  return false;
  }
