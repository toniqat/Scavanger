/**
 * src/meta/parts/Credits.ts — **크레딧 · 신뢰도 · 서버 프로필**.
 *
 * 크레딧 잔액의 유일한 소유자. 릴레이가 있으면 서버가 진실이고(`serverTx`), 없으면 localStorage 다.
 * `net:profileLoaded` 에서 서버 값을 받아들이는 규칙(`adoptServerCredits`)도 여기 있다.
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

export function subscribeNet(sys: MetaSystem): void {
  const net = sys.ctx.net;
  if (!net || typeof net.onMessage !== 'function') return;
  const offMeta = net.onMessage('meta', (msg, from) => sys.onMetaMessage(msg, from));
  const offReq = net.onMessage('metaq', (msg, from) => sys.onMetaRequest(msg, from));
  sys.unsubNet = () => { offMeta(); offReq(); };
  }

/**
 * Relayed contract traffic (`meta contractHit` live, `meta sync` catch-up). Both are validated before they touch the
 * contract: corp / goal whitelists, a finite amount within `1..max` (`META_HIT_MAX` for a live hit — a real hit is 1 —
 * and the contract target for a sync entry); a message for another corp's contract is ignored.
 */
export function onMetaMessage(sys: MetaSystem, msg: GameMessageOf<'meta'>, from: PeerId): void {
  if (!sys.ctx.isGameplayPhase() || sys.inTraining()) return;
  // `contract` describes the *sender's* contract, so it is never filtered by ours
  if (msg.ev === 'contract') {
    if (typeof from === 'string' && from !== sys.ctx.net?.localId) sys.applySquadContract(from, msg.id, msg.progress);
    return;
  }
  const def = sys.activeDef();
  if (!def || !CORP_IDS.includes(msg.corp) || def.corp !== msg.corp) return;
  if (msg.ev === 'contractHit') {
    if (!isValidHit(msg.goal, msg.amount, META_HIT_MAX)) return;
    sys.reportContractHit(msg.goal, msg.amount, false);
  } else if (msg.ev === 'sync') {
    if (!Array.isArray(msg.hits)) return;
    for (const entry of msg.hits) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const [goal, n] = entry;
      if (!isValidHit(goal, n, def.target)) continue;
      sys.reportContractHit(goal, n, false);
    }
  }
  }

/** `metaq sync`: answer a rejoining peer once per mission with the hits broadcast so far (only with an active contract). */
export function onMetaRequest(sys: MetaSystem, msg: MetaRequest, from: PeerId): void {
  if (msg.ev !== 'sync' || typeof from !== 'string' || sys.syncAnswered.has(from)) return;
  sys.syncAnswered.add(from);
  if (!sys.ctx.isGameplayPhase() || sys.inTraining()) return;
  sys.broadcastContract(from);        // a late joiner also wants the contract row, not just the missed hits
  const def = sys.activeDef();
  const net = sys.ctx.net;
  if (!def || !net || typeof net.send !== 'function') return;
  const hits: [ContractGoalKind, number][] = [];
  for (const [goal, n] of sys.sentHits) {
    const v = Math.min(def.target, Math.floor(n));
    if (v >= 1) hits.push([goal, v]);
  }
  if (hits.length === 0) return;
  net.send({ t: 'meta', ev: 'sync', corp: def.corp, hits }, from);
  }

/** `ctx.net.profile` when net published one (always present since Phase 7, `available` false offline). */
export function profileRef(sys: MetaSystem): ProfileRef | null {
  const p = sys.ctx?.net?.profile;
  return p && typeof p === 'object' ? p : null;
  }

/** Overwrite the balance with the server's answer (no delta bookkeeping — the server is the truth). */
export function adoptServerCredits(sys: MetaSystem, credits: number, reason: string): void {
  const next = Math.max(0, Math.min(CREDITS_MAX, Math.round(Number(credits))));
  if (!Number.isFinite(next)) return;
  const cur = sys.store.data.credits;
  if (next === cur) return;
  sys.store.data.credits = next;
  sys.store.markDirty();
  sys.ctx.bus.emit('meta:creditsChanged', { credits: next, delta: next - cur, reason });
  }

/** Local, synchronous credit move (the offline path and the optimistic half of a server transaction). */
export function applyCreditsLocal(sys: MetaSystem, delta: number, reason: string): boolean {
  const d = Math.round(Number(delta) || 0);
  const cur = sys.store.data.credits;
  if (cur + d < 0) return false;
  const next = Math.min(CREDITS_MAX, cur + d);
  if (next === cur && d !== 0 && cur >= CREDITS_MAX) return true;
  if (next === cur) return true;
  sys.store.data.credits = next;
  sys.store.markDirty();
  sys.ctx.bus.emit('meta:creditsChanged', { credits: next, delta: next - cur, reason });
  return true;
  }

/**
 * Server transaction after the optimistic local apply: the answer overwrites the balance; a refusal reverts the
 * local delta; a dead socket keeps the local value (offline fallback — resynced on the next `net:profileLoaded`).
 */
export function serverTx(sys: MetaSystem, delta: number, reason: string, revertOnRefuse = true): Promise<CreditsTxResult | null> {
  const p = sys.profileRef();
  if (!p || !sys.serverCredits) return Promise.resolve(null);
  sys.pendingTx++;
  let promise: Promise<CreditsTxResult>;
  try { promise = p.addCredits(delta, reason); } catch { sys.pendingTx--; return Promise.resolve(null); }
  return promise.then((res) => {
    sys.pendingTx--;
    if (!res || typeof res !== 'object') return null;
    if (res.ok) sys.adoptServerCredits(res.credits, `server:${reason}`);
    else {
      if (revertOnRefuse) sys.applyCreditsLocal(-delta, `revert:${reason}`);
      if (Number.isFinite(res.credits)) sys.adoptServerCredits(res.credits, `server:${reason}`);
    }
    return res;
  }, () => { sys.pendingTx--; return null; });
  }

/**
 * `net:profileLoaded`: the server `meta` document replaces the local save (server wins); the balance is the server's.
 * `migrated` = the server had no balance yet → the local one is uploaded as the initial balance (`reason 'migrate'`).
 * No document on the server → our local save is uploaded so the next client sees it.
 */
export function onProfileLoaded(sys: MetaSystem, migrated: boolean): void {
  const p = sys.profileRef();
  if (!p || !p.available) return;
  const localCredits = sys.store.data.credits;
  const before = { credits: localCredits, rep: CORP_IDS.map((c) => sys.store.corp(c).rep) };
  let doc: unknown;
  try { doc = p.get('meta'); } catch { doc = undefined; }
  if (doc && typeof doc === 'object') sys.store.replace(doc);
  else sys.store.upload();
  const b = sys.ctx.bus;
  if (typeof p.credits === 'number' && Number.isFinite(p.credits)) {
    sys.store.data.credits = Math.max(0, Math.min(CREDITS_MAX, Math.round(p.credits)));
  } else if (migrated || p.credits === null) {
    // first contact: the local balance becomes the server balance
    sys.store.data.credits = localCredits;
    void sys.serverTx(localCredits, 'migrate', false);
  }
  sys.store.writeCache();                     // the cache carries the server balance, not the document's stale one
  sys.progressAtStart = sys.store.data.activeContract?.progress ?? 0;
  sys.questBlocked.clear();
  b.emit('meta:loaded', { credits: sys.store.data.credits });
  if (sys.store.data.credits !== before.credits) {
    b.emit('meta:creditsChanged', { credits: sys.store.data.credits, delta: sys.store.data.credits - before.credits, reason: 'profile' });
  }
  CORP_IDS.forEach((c, i) => {
    const rep = sys.store.corp(c).rep;
    if (rep !== before.rep[i]) b.emit('meta:repChanged', { corp: c, rep, level: repLevelOf(rep), delta: rep - before.rep[i], levelUp: repLevelOf(rep) > repLevelOf(before.rep[i]) });
  });
  }

export function getRep(sys: MetaSystem, corp: CorpId): RepInfo { return repInfoOf(sys.store.corp(corp).rep); }

/**
 * Credits move: refused synchronously below 0 (local pre-check). Offline that is the whole story; with a server
 * profile the local apply is optimistic and a `credits:tx` follows — its answer overwrites the balance, a refusal
 * reverts the delta (`meta:creditsChanged` with `revert:<reason>`).
 */
export function addCredits(sys: MetaSystem, delta: number, reason: string): boolean {
  const d = Math.round(Number(delta) || 0);
  if (!sys.applyCreditsLocal(d, reason)) return false;
  if (d !== 0 && sys.serverCredits) void sys.serverTx(d, reason);
  return true;
  }

export function addRep(sys: MetaSystem, corp: CorpId, delta: number, reason: string): void {
  const c = sys.store.corp(corp);
  const before = c.rep;
  const after = Math.max(0, Math.round(before + (Number(delta) || 0)));
  if (after === before) return;
  c.rep = after;
  const level = repLevelOf(after);
  const levelUp = level > repLevelOf(before);
  sys.store.markDirty();
  void reason;
  sys.ctx.bus.emit('meta:repChanged', { corp, rep: after, level, delta: after - before, levelUp });
  }
