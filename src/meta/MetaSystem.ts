import type {
  ConsoleCommand, ContractDef, ContractGoalKind, ContractInfo, ContractSettlement, CorpId, CreditsTxResult, EmbeddedView,
  GameContext, GameMessageOf, GameSystem, ItemInstance, MetaRef, MetaRequest, MissionStats, PeerId, ProfileRef, QuestInfo, QuestState,
  RepInfo, ShopItem, SquadContractInfo,
} from '@/shared';
import {
  CONTRACT_DEFS, CONTRACT_GOAL_LABEL_KO, CORP_DEFS, CORP_IDS, CREDITS_MAX, META_HIT_MAX, QUEST_DEFS, formatCredits,
  repLevelOf, sellPriceOf,
} from '@/shared';
import { MAX_PROGRESS, MetaStorage } from './Storage';
import {
  REASON, buildShop, contractBlockReason, contractHitDelta, corpSells, killGoalOf, questBlockReason, questStateOf, repInfoOf,
  settleContract,
} from './Rules';
import { CorpMenu } from './ui/CorpMenu';
import { CorpView } from './ui/CorpView';
import './meta.css';

/* ────────────────────────────────────────────────────────────────────────────
 * MetaSystem (Phase 5-c, 2026-09-06): corporations · reputation · credits · contracts · quests · corp shop.
 * Publishes `ctx.meta` (`MetaRef`), persists `MetaSave` v1 in localStorage (`Storage.ts`), applies the pure rules of
 * `Rules.ts`, owns the corp screen DOM (`ui/CorpMenu.ts`, blocker `'corp'`) and the `credits / rep / contract / quest`
 * console commands. Contract goals rise from bus events during a mission; local hits are shared with the squad over
 * the relay-opaque `meta contractHit` message. Toasts are the ui folder's job: this system only emits `meta:*`.
 *
 * Phase 7 (server profile): when `ctx.net.profile.available`, credits are **server-owned** — every `addCredits` is an
 * optimistic local apply followed by a `credits:tx` whose answer overwrites the balance (or reverts it when refused);
 * `buy` is `canFit` → server debit → item creation, `meta:purchase` announces the (possibly async) completion. The
 * save also mirrors into the `meta` profile document; `net:profileLoaded` replaces it with the server copy.
 *
 * Phase 9 (late-join catch-up + relay validation): a client that rejoins a running raid (`net:gameStarting {rejoin}`)
 * asks the squad for the contract hits it missed (`metaq sync` to others on `world:ready`); every peer answers ONCE per
 * requester per mission with the hits it broadcast so far (`sentHits` → `meta sync {corp, hits}` unicast), and the
 * requester feeds them through `reportContractHit(goal, n, false)` like live relayed hits. Relayed messages are
 * validated (`GOAL_IDS` / `CORP_IDS` whitelists, finite `1..META_HIT_MAX` — a sync entry is capped by the contract
 * target instead) and the progress is clamped to `MAX_PROGRESS`. The profile upload no longer needs the server
 * (`ProfileSync` queues + stamps an offline `set`).
 * ──────────────────────────────────────────────────────────────────────────── */

const CORP_ALIASES: Readonly<Record<string, CorpId>> = { helix: 'helix', bastion: 'bastion', nomad: 'nomad', ceres: 'ceres' };
const GOAL_IDS: readonly ContractGoalKind[] = ['kill_bugs', 'kill_rogues', 'open_crates', 'loot_corpses', 'extract_with_value', 'use_stratagems'];

/** Phase 9 relay validation: a whitelisted goal with a finite amount in `1..max`. */
function isValidHit(goal: unknown, amount: unknown, max: number): goal is ContractGoalKind {
  return typeof goal === 'string' && GOAL_IDS.includes(goal as ContractGoalKind)
    && typeof amount === 'number' && Number.isFinite(amount) && amount >= 1 && amount <= max;
}

/** Why the last `buy()` / async purchase did not go through (corp screen message; folder-internal, not in `MetaRef`). */
export interface PurchaseFailure { corp: CorpId; defId: string; price: number; reason: string; }

export class MetaSystem implements GameSystem, MetaRef {
  readonly name = 'meta';
  private ctx!: GameContext;
  private store!: MetaStorage;
  private menu: CorpMenu | null = null;
  /** Embedded 기업 tabs handed out by `createCorpView` (their message timers tick with the system). */
  private readonly views = new Set<CorpView>();
  private unsubs: Array<() => void> = [];
  private unsubNet: (() => void) | null = null;
  private consoleRegistered = false;
  /** Last refused purchase (sync or async) — the corp screen reads it for its message line. */
  lastPurchaseFailure: PurchaseFailure | null = null;
  /**
   * Called after an async purchase failed (server refusal / placement). Legacy single slot — every corp view now
   * subscribes through `onPurchaseFailure()` instead, so the standalone screen and an embedded 기업 tab can coexist.
   */
  onPurchaseFailed: ((f: PurchaseFailure) => void) | null = null;
  private readonly purchaseFailListeners = new Set<(f: PurchaseFailure) => void>();
  /** Server transactions still in flight (purchase buttons stay enabled; the optimistic balance already covers them). */
  private pendingTx = 0;
  /** Progress the active contract had when the current mission started (death rule). */
  private progressAtStart = 0;
  /** Corpse containers counted this mission (dedupes the `crate:looted` fallback against `inventory:containerOpened`). */
  private readonly corpsesCounted = new Set<string>();
  private containerOpenedSeen = false;
  /** Last `completeQuest` failure reason per quest id (shown as `QuestInfo.blocked`). */
  private readonly questBlocked = new Map<string, string>();
  /* Phase 9: late-join catch-up */
  /** Contract hits this client broadcast this mission, per goal (what a late joiner is handed on `metaq sync`). */
  private readonly sentHits = new Map<ContractGoalKind, number>();
  /** Requesters already answered this mission (one `meta sync` per peer per mission, answered or not). */
  private readonly syncAnswered = new Set<PeerId>();
  /** A rejoin is under way: ask the squad for its hits once the world is ready. */
  private syncRequestPending = false;
  /* Phase 9 UI pass: the squad's contracts, so the HUD can draw a row per member (`meta contract`). */
  /** Last `meta contract` broadcast per peer; an `id: null` broadcast removes the entry. Never holds the local peer. */
  private readonly squadContracts = new Map<PeerId, { id: string; progress: number }>();
  /** Last `{id}|{progress}` we broadcast, so an unchanged contract never re-sends. */
  private lastContractSent = '';

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.store = new MetaStorage(() => this.profileRef());
    ctx.meta = this;
    this.menu = new CorpMenu(ctx, this);

    const b = ctx.bus;
    // contract goals only count in a real raid (never in the 시뮬레이션 훈련장)
    const counting = (): boolean => ctx.isGameplayPhase() && !this.inTraining();
    this.unsubs.push(
      b.on('game:newMission', () => this.onNewMission()),
      // Phase 9: a rejoining client asks the squad for the hits it missed once its world exists
      b.on('net:gameStarting', ({ rejoin }) => { this.syncRequestPending = rejoin === true; }),
      b.on('world:ready', () => this.onWorldReady()),
      b.on('hub:entered', () => { this.save(); this.clearSquadContracts(); }),
      b.on('game:abort', () => this.clearSquadContracts()),
      b.on('net:lobbyLeft', () => this.clearSquadContracts()),
      b.on('net:peerLeft', ({ id }) => this.applySquadContract(id, null, 0)),
      b.on('net:profileLoaded', ({ migrated }) => this.onProfileLoaded(migrated)),
      // Phase 9: `enemy:killed` now fires for a peer-credited kill too (`by`), and that peer sends its own
      // `meta contractHit` — count only our own kills here or a squad kill lands twice.
      b.on('enemy:killed', ({ type, by }) => {
        if (!counting()) return;
        if (by !== undefined && by !== 'local' && by !== (ctx.net?.localId ?? null)) return;
        this.localHit(killGoalOf(type), 1);
      }),
      b.on('crate:open', () => { if (counting()) this.localHit('open_crates', 1); }),
      b.on('inventory:containerOpened', ({ containerId, first }) => {
        this.containerOpenedSeen = true;
        if (!counting() || !first || !containerId.startsWith('corpse:')) return;
        if (this.corpsesCounted.has(containerId)) return;
        this.corpsesCounted.add(containerId);
        this.localHit('loot_corpses', 1);
      }),
      // fallback while inventory has not shipped `inventory:containerOpened` yet: an emptied corpse counts once
      b.on('crate:looted', ({ crateId }) => {
        if (this.containerOpenedSeen || !counting() || !crateId.startsWith('corpse:')) return;
        if (this.corpsesCounted.has(crateId)) return;
        this.corpsesCounted.add(crateId);
        this.localHit('loot_corpses', 1);
      }),
      b.on('stratagem:called', ({ caller }) => {
        if (!counting()) return;
        if (caller === null || caller === (ctx.net?.localId ?? null)) this.localHit('use_stratagems', 1);
      }),
      // live `extract_with_value` readout for the HUD (the settlement still reads `stats.lootValue`)
      b.on('inventory:changed', ({ totalValue }) => this.trackLootValue(totalValue)),
    );
    this.subscribeNet();
    b.emit('meta:loaded', { credits: this.store.data.credits });
  }

  update(_dt: number, ctx: GameContext): void {
    if (!this.consoleRegistered && ctx.console?.enabled) { this.consoleRegistered = true; this.registerConsole(); }
    if (!this.unsubNet) this.subscribeNet();
    this.menu?.update();
    for (const v of this.views) v.update();
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.unsubNet?.(); this.unsubNet = null;
    this.menu?.dispose(); this.menu = null;
    for (const v of [...this.views]) v.dispose();
    this.views.clear();
    this.purchaseFailListeners.clear();
    this.store.dispose();
    if (this.ctx?.meta === this) this.ctx.meta = null;
  }

  private subscribeNet(): void {
    const net = this.ctx.net;
    if (!net || typeof net.onMessage !== 'function') return;
    const offMeta = net.onMessage('meta', (msg, from) => this.onMetaMessage(msg, from));
    const offReq = net.onMessage('metaq', (msg, from) => this.onMetaRequest(msg, from));
    this.unsubNet = () => { offMeta(); offReq(); };
  }

  /**
   * Relayed contract traffic (`meta contractHit` live, `meta sync` catch-up). Both are validated before they touch the
   * contract: corp / goal whitelists, a finite amount within `1..max` (`META_HIT_MAX` for a live hit — a real hit is 1 —
   * and the contract target for a sync entry); a message for another corp's contract is ignored.
   */
  private onMetaMessage(msg: GameMessageOf<'meta'>, from: PeerId): void {
    if (!this.ctx.isGameplayPhase() || this.inTraining()) return;
    // `contract` describes the *sender's* contract, so it is never filtered by ours
    if (msg.ev === 'contract') {
      if (typeof from === 'string' && from !== this.ctx.net?.localId) this.applySquadContract(from, msg.id, msg.progress);
      return;
    }
    const def = this.activeDef();
    if (!def || !CORP_IDS.includes(msg.corp) || def.corp !== msg.corp) return;
    if (msg.ev === 'contractHit') {
      if (!isValidHit(msg.goal, msg.amount, META_HIT_MAX)) return;
      this.reportContractHit(msg.goal, msg.amount, false);
    } else if (msg.ev === 'sync') {
      if (!Array.isArray(msg.hits)) return;
      for (const entry of msg.hits) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        const [goal, n] = entry;
        if (!isValidHit(goal, n, def.target)) continue;
        this.reportContractHit(goal, n, false);
      }
    }
  }

  /** `metaq sync`: answer a rejoining peer once per mission with the hits broadcast so far (only with an active contract). */
  private onMetaRequest(msg: MetaRequest, from: PeerId): void {
    if (msg.ev !== 'sync' || typeof from !== 'string' || this.syncAnswered.has(from)) return;
    this.syncAnswered.add(from);
    if (!this.ctx.isGameplayPhase() || this.inTraining()) return;
    this.broadcastContract(from);        // a late joiner also wants the contract row, not just the missed hits
    const def = this.activeDef();
    const net = this.ctx.net;
    if (!def || !net || typeof net.send !== 'function') return;
    const hits: [ContractGoalKind, number][] = [];
    for (const [goal, n] of this.sentHits) {
      const v = Math.min(def.target, Math.floor(n));
      if (v >= 1) hits.push([goal, v]);
    }
    if (hits.length === 0) return;
    net.send({ t: 'meta', ev: 'sync', corp: def.corp, hits }, from);
  }

  /** `world:ready` after a rejoin: ask every other member for the hits this client missed. */
  private onWorldReady(): void {
    // Everyone announces its contract at mission start — a rejoin additionally asks for what it missed.
    this.broadcastContract('others', true);
    if (!this.syncRequestPending) return;
    this.syncRequestPending = false;
    const net = this.ctx.net;
    if (!this.ctx.isMultiplayer || !net || typeof net.send !== 'function' || this.inTraining()) return;
    net.send({ t: 'metaq', ev: 'sync' }, 'others');
  }

  /* ── helpers ─────────────────────────────────────────────────────────────── */
  private get inShip(): boolean { return this.ctx.isHubPhase() && !this.ctx.isRaidActive(); }
  /** `ctx.net.profile` when net published one (always present since Phase 7, `available` false offline). */
  private profileRef(): ProfileRef | null {
    const p = this.ctx?.net?.profile;
    return p && typeof p === 'object' ? p : null;
  }
  /** Server-owned credits in effect (relay answered with a profile). */
  private get serverCredits(): boolean {
    const p = this.profileRef();
    return !!p && p.available === true && typeof p.addCredits === 'function';
  }
  private inTraining(): boolean {
    const ctx = this.ctx;
    return typeof ctx.isTraining === 'function' ? ctx.isTraining() : ctx.missionMode === 'training';
  }
  /** Bag / stash pre-check (`InventoryRef.canFit`); a missing helper counts as "fits" (inventory/ built in parallel). */
  private fits(defId: string, qty = 1): boolean {
    const inv = this.ctx.inventory;
    if (!inv || typeof inv.canFit !== 'function') return true;
    try { return inv.canFit(defId, qty) !== null; } catch { return true; }
  }
  /** Overwrite the balance with the server's answer (no delta bookkeeping — the server is the truth). */
  private adoptServerCredits(credits: number, reason: string): void {
    const next = Math.max(0, Math.min(CREDITS_MAX, Math.round(Number(credits))));
    if (!Number.isFinite(next)) return;
    const cur = this.store.data.credits;
    if (next === cur) return;
    this.store.data.credits = next;
    this.store.markDirty();
    this.ctx.bus.emit('meta:creditsChanged', { credits: next, delta: next - cur, reason });
  }
  /** Local, synchronous credit move (the offline path and the optimistic half of a server transaction). */
  private applyCreditsLocal(delta: number, reason: string): boolean {
    const d = Math.round(Number(delta) || 0);
    const cur = this.store.data.credits;
    if (cur + d < 0) return false;
    const next = Math.min(CREDITS_MAX, cur + d);
    if (next === cur && d !== 0 && cur >= CREDITS_MAX) return true;
    if (next === cur) return true;
    this.store.data.credits = next;
    this.store.markDirty();
    this.ctx.bus.emit('meta:creditsChanged', { credits: next, delta: next - cur, reason });
    return true;
  }
  /**
   * Server transaction after the optimistic local apply: the answer overwrites the balance; a refusal reverts the
   * local delta; a dead socket keeps the local value (offline fallback — resynced on the next `net:profileLoaded`).
   */
  private serverTx(delta: number, reason: string, revertOnRefuse = true): Promise<CreditsTxResult | null> {
    const p = this.profileRef();
    if (!p || !this.serverCredits) return Promise.resolve(null);
    this.pendingTx++;
    let promise: Promise<CreditsTxResult>;
    try { promise = p.addCredits(delta, reason); } catch { this.pendingTx--; return Promise.resolve(null); }
    return promise.then((res) => {
      this.pendingTx--;
      if (!res || typeof res !== 'object') return null;
      if (res.ok) this.adoptServerCredits(res.credits, `server:${reason}`);
      else {
        if (revertOnRefuse) this.applyCreditsLocal(-delta, `revert:${reason}`);
        if (Number.isFinite(res.credits)) this.adoptServerCredits(res.credits, `server:${reason}`);
      }
      return res;
    }, () => { this.pendingTx--; return null; });
  }
  get hasPendingTx(): boolean { return this.pendingTx > 0; }

  /**
   * `net:profileLoaded`: the server `meta` document replaces the local save (server wins); the balance is the server's.
   * `migrated` = the server had no balance yet → the local one is uploaded as the initial balance (`reason 'migrate'`).
   * No document on the server → our local save is uploaded so the next client sees it.
   */
  private onProfileLoaded(migrated: boolean): void {
    const p = this.profileRef();
    if (!p || !p.available) return;
    const localCredits = this.store.data.credits;
    const before = { credits: localCredits, rep: CORP_IDS.map((c) => this.store.corp(c).rep) };
    let doc: unknown;
    try { doc = p.get('meta'); } catch { doc = undefined; }
    if (doc && typeof doc === 'object') this.store.replace(doc);
    else this.store.upload();
    const b = this.ctx.bus;
    if (typeof p.credits === 'number' && Number.isFinite(p.credits)) {
      this.store.data.credits = Math.max(0, Math.min(CREDITS_MAX, Math.round(p.credits)));
    } else if (migrated || p.credits === null) {
      // first contact: the local balance becomes the server balance
      this.store.data.credits = localCredits;
      void this.serverTx(localCredits, 'migrate', false);
    }
    this.store.writeCache();                     // the cache carries the server balance, not the document's stale one
    this.progressAtStart = this.store.data.activeContract?.progress ?? 0;
    this.questBlocked.clear();
    b.emit('meta:loaded', { credits: this.store.data.credits });
    if (this.store.data.credits !== before.credits) {
      b.emit('meta:creditsChanged', { credits: this.store.data.credits, delta: this.store.data.credits - before.credits, reason: 'profile' });
    }
    CORP_IDS.forEach((c, i) => {
      const rep = this.store.corp(c).rep;
      if (rep !== before.rep[i]) b.emit('meta:repChanged', { corp: c, rep, level: repLevelOf(rep), delta: rep - before.rep[i], levelUp: repLevelOf(rep) > repLevelOf(before.rep[i]) });
    });
  }
  private activeDef(): ContractDef | null {
    const ac = this.store.data.activeContract;
    if (!ac) return null;
    const def = CONTRACT_DEFS.find((d) => d.id === ac.id);
    if (!def) { this.store.data.activeContract = null; this.store.markDirty(); return null; }
    return def;
  }
  private level(corp: CorpId): number { return repLevelOf(this.store.corp(corp).rep); }
  private itemDef(defId: string) { return this.ctx.loot?.getItemDef(defId) ?? this.ctx.inventory?.getDef(defId); }
  private equippedUids(): Set<string> {
    const out = new Set<string>();
    const lo = this.ctx.inventory?.getLoadout();
    if (!lo) return out;
    for (const inst of [lo.primary, lo.primary2, lo.secondary, lo.bag, lo.armor ?? null]) if (inst) out.add(inst.uid);
    return out;
  }
  private findAnywhere(uid: string): ItemInstance | null {
    const inv = this.ctx.inventory;
    if (!inv) return null;
    if (typeof inv.findItemAnywhere === 'function') { const i = inv.findItemAnywhere(uid); if (i) return i; }
    return inv.findItem(uid) ?? null;
  }
  /** Bag + stash units of a def (corp views render 보유/필요 chips from it). */
  countAll(defId: string): number {
    const inv = this.ctx.inventory;
    if (!inv) return 0;
    if (typeof inv.countDefAll === 'function') return inv.countDefAll(defId);
    return inv.countWhere((d) => d.id === defId);
  }
  /** Bag first, then the stash; falls back to the bag-only `tryAddItem` while inventory's helper is a stub. */
  private addAnywhere(item: ItemInstance): 'bag' | 'stash' | null {
    const inv = this.ctx.inventory;
    if (!inv) return null;
    if (typeof inv.tryAddItemAnywhere === 'function') {
      const where = inv.tryAddItemAnywhere(item);
      if (where) return where;
      return null;
    }
    return inv.tryAddItem(item) ? 'bag' : null;
  }
  private takeBack(uid: string, qty?: number): number {
    const inv = this.ctx.inventory;
    if (!inv || typeof inv.takeItem !== 'function') return 0;
    try { return inv.takeItem(uid, qty); } catch { return 0; }
  }

  private onNewMission(): void {
    this.progressAtStart = this.store.data.activeContract?.progress ?? 0;
    this.corpsesCounted.clear();
    this.questBlocked.clear();
    this.sentHits.clear();
    this.syncAnswered.clear();
    this.clearSquadContracts();
    this.lastContractSent = '';
  }

  /* ── squad contracts (Phase 9 UI pass) ───────────────────────────────────
   * Every member broadcasts its own `{id, progress}`; nobody aggregates. The list is per-mission: it is emptied at
   * `game:newMission`, on `game:abort` and when the lobby goes away, so the HUD never shows a stale raid's contracts.
   * ──────────────────────────────────────────────────────────────────────── */

  /** `MetaRef.getSquadContracts` — other members only, in peer order. */
  getSquadContracts(): readonly SquadContractInfo[] {
    const out: SquadContractInfo[] = [];
    for (const [peer, v] of this.squadContracts) out.push({ peer, id: v.id, progress: v.progress });
    return out;
  }

  private clearSquadContracts(): void {
    if (this.squadContracts.size === 0) return;
    const peers = [...this.squadContracts.keys()];
    this.squadContracts.clear();
    for (const peer of peers) this.ctx.bus.emit('meta:squadContract', { peer, id: null, progress: 0 });
  }

  /** Store a relayed `meta contract`; `id` null (or an unknown def) drops the member's row. */
  private applySquadContract(peer: PeerId, id: string | null, progress: number): void {
    const known = typeof id === 'string' && CONTRACT_DEFS.some((d) => d.id === id) ? id : null;
    if (!known) {
      if (!this.squadContracts.delete(peer)) return;
      this.ctx.bus.emit('meta:squadContract', { peer, id: null, progress: 0 });
      return;
    }
    const def = CONTRACT_DEFS.find((d) => d.id === known)!;
    const p = Math.min(def.target, Math.max(0, Number.isFinite(progress) ? progress : 0));
    const prev = this.squadContracts.get(peer);
    if (prev && prev.id === known && prev.progress === p) return;
    this.squadContracts.set(peer, { id: known, progress: p });
    this.ctx.bus.emit('meta:squadContract', { peer, id: known, progress: p });
  }

  /**
   * Tell the squad what we are working on. `to` defaults to every other member; a `metaq sync` answer targets one.
   * Silent outside a real multiplayer raid, and a no-op when nothing changed since the last broadcast.
   */
  private broadcastContract(to: PeerId | 'others' = 'others', force = false): void {
    const net = this.ctx.net;
    if (!this.ctx.isMultiplayer || !net || typeof net.send !== 'function' || this.inTraining()) return;
    const ac = this.activeDef() ? this.store.data.activeContract : null;
    const id = ac?.id ?? null;
    const progress = ac ? Math.floor(ac.progress) : 0;
    const key = `${id ?? '-'}|${progress}`;
    if (to === 'others') {
      if (!force && key === this.lastContractSent) return;
      this.lastContractSent = key;
    }
    net.send({ t: 'meta', ev: 'contract', id, progress }, to);
  }

  private localHit(goal: ContractGoalKind, amount: number): void {
    this.reportContractHit(goal, amount, true);
  }

  private trackLootValue(totalValue: number): void {
    if (!this.ctx.isGameplayPhase() || this.inTraining()) return;
    const def = this.activeDef();
    const ac = this.store.data.activeContract;
    if (!def || !ac || def.goal !== 'extract_with_value') return;
    const v = Math.min(MAX_PROGRESS, Math.max(0, Math.round(totalValue)));
    if (v === ac.progress) return;
    const delta = v - ac.progress;
    ac.progress = v;
    this.ctx.bus.emit('meta:contractProgress', { id: def.id, corp: def.corp, goal: def.goal, progress: v, target: def.target, delta });
    this.broadcastContract();
  }

  /* ── MetaRef: credits / rep ─────────────────────────────────────────────── */
  get credits(): number { return this.store.data.credits; }

  getRep(corp: CorpId): RepInfo { return repInfoOf(this.store.corp(corp).rep); }

  /**
   * Credits move: refused synchronously below 0 (local pre-check). Offline that is the whole story; with a server
   * profile the local apply is optimistic and a `credits:tx` follows — its answer overwrites the balance, a refusal
   * reverts the delta (`meta:creditsChanged` with `revert:<reason>`).
   */
  addCredits(delta: number, reason: string): boolean {
    const d = Math.round(Number(delta) || 0);
    if (!this.applyCreditsLocal(d, reason)) return false;
    if (d !== 0 && this.serverCredits) void this.serverTx(d, reason);
    return true;
  }

  addRep(corp: CorpId, delta: number, reason: string): void {
    const c = this.store.corp(corp);
    const before = c.rep;
    const after = Math.max(0, Math.round(before + (Number(delta) || 0)));
    if (after === before) return;
    c.rep = after;
    const level = repLevelOf(after);
    const levelUp = level > repLevelOf(before);
    this.store.markDirty();
    void reason;
    this.ctx.bus.emit('meta:repChanged', { corp, rep: after, level, delta: after - before, levelUp });
  }

  /* ── MetaRef: shop ──────────────────────────────────────────────────────── */
  getShop(corp: CorpId): ShopItem[] {
    const loot = this.ctx.loot;
    const def = CORP_DEFS[corp];
    if (!loot || !def) return [];
    return buildShop(def, loot.getAllItemDefs(), this.level(corp), this.credits, this.inShip, (id) => loot.getWeaponDef(id), (id) => this.fits(id));
  }

  priceOf(corp: CorpId, defId: string): number | null {
    const loot = this.ctx.loot;
    const cdef = CORP_DEFS[corp];
    const def = loot?.getItemDef(defId);
    if (!loot || !cdef || !def) return null;
    const level = this.level(corp);
    if (!corpSells(cdef, def, level, (id) => loot.getWeaponDef(id))) return null;
    return buildShop(cdef, [def], level, this.credits, true, (id) => loot.getWeaponDef(id))[0]?.price ?? null;
  }

  /**
   * Purchase. Synchronous answer = was the request accepted (ship, on the shelf, `canFit`, credits). Offline the item
   * is created and placed right here (pre-checked, so no refund step is needed — a placement failure still refunds
   * defensively). With a server profile the credits are debited optimistically, the server transaction runs, and only
   * an `ok` answer creates + places the item (a placement failure refunds through the server); either way completion
   * is announced by `meta:purchase` and a failure by `onPurchaseFailed` / `lastPurchaseFailure`.
   */
  buy(corp: CorpId, defId: string): boolean {
    const fail = (reason: string, price = 0): false => {
      this.lastPurchaseFailure = { corp, defId, price, reason };
      return false;
    };
    if (!this.inShip) return fail(REASON.shipOnly);
    const loot = this.ctx.loot;
    const price = this.priceOf(corp, defId);
    if (!loot || price === null) return fail('판매하지 않는 품목');
    if (!this.fits(defId)) return fail(REASON.space, price);
    if (this.credits < price) return fail(REASON.credits, price);
    this.lastPurchaseFailure = null;
    const reason = `buy:${defId}`;

    if (!this.serverCredits) {
      if (!this.applyCreditsLocal(-price, reason)) return fail(REASON.credits, price);
      let placed: 'bag' | 'stash' | null = null;
      try { placed = this.addAnywhere(loot.createItem(defId, 1)); } catch { placed = null; }
      if (!placed) { this.applyCreditsLocal(price, `refund:${defId}`); return fail(REASON.space, price); }
      this.completePurchase(corp, defId, price, placed);
      return true;
    }

    // server-owned credits: optimistic debit → transaction → item only on `ok`
    if (!this.applyCreditsLocal(-price, reason)) return fail(REASON.credits, price);
    void this.serverTx(-price, reason).then((res) => {
      if (res && !res.ok) {                                   // refused (balance already reverted by serverTx)
        this.failPurchase({ corp, defId, price, reason: res.reason || REASON.credits });
        return;
      }
      // `null` = socket gone mid-transaction: the local debit stands (offline fallback) and the item is delivered
      let placed: 'bag' | 'stash' | null = null;
      try { placed = this.addAnywhere(loot.createItem(defId, 1)); } catch { placed = null; }
      if (!placed) {
        this.applyCreditsLocal(price, `refund:${defId}`);
        if (res) void this.serverTx(price, `refund:${defId}`, false);
        this.failPurchase({ corp, defId, price, reason: REASON.space });
        return;
      }
      this.completePurchase(corp, defId, price, placed);
    });
    return true;
  }

  private completePurchase(corp: CorpId, defId: string, price: number, placed: 'bag' | 'stash'): void {
    this.store.data.stats.creditsSpent += price;
    this.store.markDirty();
    this.ctx.bus.emit('meta:purchase', { corp, defId, price, placed });
  }

  private failPurchase(f: PurchaseFailure): void {
    this.lastPurchaseFailure = f;
    try { this.onPurchaseFailed?.(f); } catch { /* ui */ }
    for (const fn of [...this.purchaseFailListeners]) { try { fn(f); } catch { /* ui */ } }
  }

  /** Subscribe to async purchase refusals (folder-internal; the standalone screen and every embedded 기업 tab use it). */
  onPurchaseFailure(fn: (f: PurchaseFailure) => void): () => void {
    this.purchaseFailListeners.add(fn);
    return () => { this.purchaseFailListeners.delete(fn); };
  }

  sellPriceOf(uid: string, qty?: number): number | null {
    const inst = this.findAnywhere(uid);
    if (!inst || this.equippedUids().has(uid)) return null;
    const def = this.itemDef(inst.defId);
    if (!def || !(def.value > 0)) return null;
    const n = Math.max(1, Math.min(inst.qty, Math.floor(qty ?? inst.qty)));
    return sellPriceOf(def.value, n);
  }

  sell(uid: string, qty?: number): boolean {
    if (!this.inShip) return false;
    const inv = this.ctx.inventory;
    if (!inv || typeof inv.takeItem !== 'function') return false;
    const inst = this.findAnywhere(uid);
    if (!inst || this.equippedUids().has(uid)) return false;
    const def = this.itemDef(inst.defId);
    if (!def || !(def.value > 0)) return false;
    const want = Math.max(1, Math.min(inst.qty, Math.floor(qty ?? inst.qty)));
    const removed = this.takeBack(uid, want);
    if (removed <= 0) return false;
    const credits = sellPriceOf(def.value, removed);
    this.addCredits(credits, `sell:${def.id}`);
    this.store.data.stats.creditsEarned += credits;
    this.store.markDirty();
    this.ctx.bus.emit('meta:sale', { defId: def.id, qty: removed, credits });
    return true;
  }

  getSellable(): readonly ItemInstance[] {
    const inv = this.ctx.inventory;
    if (!inv) return [];
    const equipped = this.equippedUids();
    const out: ItemInstance[] = [];
    const seen = new Set<string>();
    const consider = (inst: ItemInstance): void => {
      if (seen.has(inst.uid) || equipped.has(inst.uid)) return;
      const def = this.itemDef(inst.defId);
      if (!def || !(def.value > 0)) return;
      seen.add(inst.uid);
      out.push(inst);
    };
    for (const inst of inv.getAllItems()) consider(inst);
    if (typeof inv.getStashItems === 'function') for (const inst of inv.getStashItems()) consider(inst);
    return out;
  }

  /* ── MetaRef: contracts ─────────────────────────────────────────────────── */
  getContracts(corp: CorpId): ContractInfo[] {
    const ac = this.store.data.activeContract;
    const activeCount = ac ? 1 : 0;
    const level = this.level(corp);
    return CONTRACT_DEFS.filter((d) => d.corp === corp).map((def) => {
      const active = ac?.id === def.id;
      return {
        def,
        progress: active ? ac!.progress : 0,
        active,
        blocked: active ? REASON.active : contractBlockReason(def, level, activeCount, this.inShip),
      };
    });
  }

  get activeContract(): ContractInfo | null {
    const def = this.activeDef();
    const ac = this.store.data.activeContract;
    if (!def || !ac) return null;
    return { def, progress: ac.progress, active: true, blocked: REASON.active };
  }

  acceptContract(id: string): boolean {
    const def = CONTRACT_DEFS.find((d) => d.id === id);
    if (!def) return false;
    if (contractBlockReason(def, this.level(def.corp), this.store.data.activeContract ? 1 : 0, this.inShip)) return false;
    this.store.data.activeContract = { id: def.id, progress: 0 };
    this.progressAtStart = 0;
    this.store.markDirty();
    this.ctx.bus.emit('meta:contractAccepted', { id: def.id, corp: def.corp });
    this.broadcastContract();
    return true;
  }

  abandonContract(): boolean {
    const def = this.activeDef();
    if (!def) return false;
    this.store.data.activeContract = null;
    this.progressAtStart = 0;
    this.store.markDirty();
    this.ctx.bus.emit('meta:contractAbandoned', { id: def.id, corp: def.corp });
    this.broadcastContract();
    return true;
  }

  reportContractHit(goal: ContractGoalKind, amount: number, local: boolean): void {
    const def = this.activeDef();
    const ac = this.store.data.activeContract;
    if (!def || !ac || def.goal !== goal || !Number.isFinite(amount)) return;
    const delta = contractHitDelta(amount, local);
    if (delta <= 0) return;
    const before = ac.progress;
    ac.progress = Math.min(MAX_PROGRESS, before + delta);
    this.store.markDirty();
    this.ctx.bus.emit('meta:contractProgress', { id: def.id, corp: def.corp, goal, progress: ac.progress, target: def.target, delta: ac.progress - before });
    if (local && this.ctx.isMultiplayer && this.ctx.net && typeof this.ctx.net.send === 'function') {
      // a receiver drops anything above META_HIT_MAX (a real hit is 1) — send the capped figure and remember it for `metaq sync`
      const sent = Math.min(META_HIT_MAX, Math.max(0, amount));
      if (sent >= 1) {
        this.sentHits.set(goal, (this.sentHits.get(goal) ?? 0) + sent);
        this.ctx.net.send({ t: 'meta', ev: 'contractHit', corp: def.corp, goal, amount: sent }, 'others');
      }
    }
    // the squad's HUD rows follow our own progress (deduped on `{id}|{floor(progress)}`)
    if (local) this.broadcastContract();
  }

  settleMission(stats: MissionStats): ContractSettlement | null {
    if (!stats || stats.mode === 'training') return null;   // the 시뮬레이션 훈련장 settles nothing
    const def = this.activeDef();
    const ac = this.store.data.activeContract;
    if (!def || !ac) return null;
    const { settlement, keepProgress } = settleContract(def, ac.progress, this.progressAtStart, stats);
    if (settlement.success) {
      this.store.data.activeContract = null;
      this.store.data.stats.contractsDone += 1;
      if (settlement.rep > 0) this.addRep(def.corp, settlement.rep, `contract:${def.id}`);
      if (settlement.credits > 0) {
        this.addCredits(settlement.credits, `contract:${def.id}`);
        this.store.data.stats.creditsEarned += settlement.credits;
      }
    } else {
      ac.progress = keepProgress ?? 0;
    }
    this.progressAtStart = this.store.data.activeContract?.progress ?? 0;
    this.store.markDirty();
    this.ctx.bus.emit('meta:contractSettled', settlement);
    return settlement;
  }

  /* ── MetaRef: quests ────────────────────────────────────────────────────── */
  getQuestState(id: string): QuestState {
    const def = QUEST_DEFS.find((d) => d.id === id);
    if (!def) return 'locked';
    return questStateOf(def, this.store.corp(def.corp).quests[id], this.level(def.corp), (q) => this.getQuestState(q));
  }

  private questInfo(def: typeof QUEST_DEFS[number]): QuestInfo {
    const state = this.getQuestState(def.id);
    const deliver = def.deliver.map((d) => ({ defId: d.defId, qty: d.qty, have: this.countAll(d.defId) }));
    const blocked = questBlockReason(state, deliver, this.inShip) ?? this.questBlocked.get(def.id) ?? null;
    return { def, state, deliver, blocked };
  }

  getQuests(corp: CorpId): QuestInfo[] {
    return QUEST_DEFS.filter((d) => d.corp === corp).map((d) => this.questInfo(d));
  }

  acceptQuest(id: string): boolean {
    const def = QUEST_DEFS.find((d) => d.id === id);
    if (!def || !this.inShip) return false;
    if (this.getQuestState(id) !== 'available') return false;
    this.store.corp(def.corp).quests[id] = 'accepted';
    this.store.markDirty();
    this.ctx.bus.emit('meta:questChanged', { id, corp: def.corp, state: 'accepted' });
    return true;
  }

  completeQuest(id: string): boolean {
    const def = QUEST_DEFS.find((d) => d.id === id);
    if (!def || !this.inShip) return false;
    if (this.getQuestState(id) !== 'accepted') return false;
    const inv = this.ctx.inventory;
    const loot = this.ctx.loot;
    if (!inv || !loot) return false;
    for (const d of def.deliver) if (this.countAll(d.defId) < d.qty) { this.questBlocked.set(id, REASON.missing); return false; }

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
        if (!this.addAnywhere(item)) {
          for (const p of placed) this.takeBack(p.uid);
          this.questBlocked.set(id, REASON.space);
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
    this.questBlocked.delete(id);
    this.store.corp(def.corp).quests[id] = 'complete';
    this.store.data.stats.questsDone += 1;
    if (def.rewards.credits) {
      this.addCredits(def.rewards.credits, `quest:${id}`);
      this.store.data.stats.creditsEarned += def.rewards.credits;
    }
    if (def.rewards.rep) this.addRep(def.corp, def.rewards.rep, `quest:${id}`);
    const prog = this.ctx.progression;
    if (def.rewards.xp > 0 && prog && typeof prog.addXp === 'function') { try { prog.addXp(def.rewards.xp); } catch { /* progression not ready */ } }
    this.store.markDirty();
    this.ctx.bus.emit('meta:questChanged', { id, corp: def.corp, state: 'complete' });
    return true;
  }

  /* ── MetaRef: corp screen ───────────────────────────────────────────────── */
  openCorpMenu(corp?: CorpId): void {
    if (!this.menu || this.ctx.isRaidActive()) return;
    this.menu.open(corp);
  }
  closeCorpMenu(): void { this.menu?.close(); }
  get isMenuOpen(): boolean { return this.menu?.isOpen ?? false; }

  /**
   * Phase 8: the 기업 tab of the inventory Tab screen. Builds the same body as the standalone screen (`ui/CorpView.ts`)
   * inside the caller's host — **no `'corp'` blocker, no cursor-mode / pointer-lock call, no window Escape listener**; the inventory
   * window already owns all three. `dispose()` removes only what the view added.
   */
  createCorpView(host: HTMLElement): EmbeddedView {
    const view = new CorpView(this.ctx, this, host, { embedded: true });
    this.views.add(view);
    view.refresh();
    return {
      refresh: () => view.refresh(),
      dispose: () => { this.views.delete(view); view.dispose(); },
    };
  }

  /* ── MetaRef: persistence ───────────────────────────────────────────────── */
  save(): void { this.store.flush(); }

  resetMeta(): void {
    const before = this.store.data.credits;
    const repBefore = CORP_IDS.map((c) => this.store.corp(c).rep);
    this.store.reset();
    this.progressAtStart = 0;
    this.questBlocked.clear();
    const b = this.ctx.bus;
    b.emit('meta:loaded', { credits: this.store.data.credits });
    if (this.store.data.credits !== before) b.emit('meta:creditsChanged', { credits: this.store.data.credits, delta: this.store.data.credits - before, reason: 'reset' });
    CORP_IDS.forEach((c, i) => { if (repBefore[i] !== 0) b.emit('meta:repChanged', { corp: c, rep: 0, level: 0, delta: -repBefore[i], levelUp: false }); });
  }

  /** Lifetime counters (terminal / corp screen). */
  get lifetime(): Readonly<MetaStorage['data']['stats']> { return this.store.data.stats; }

  /* ── console commands ───────────────────────────────────────────────────── */
  private resolveCorp(raw: string | undefined): CorpId | null {
    if (!raw) return null;
    const s = raw.trim();
    const lower = s.toLowerCase();
    if (CORP_ALIASES[lower]) return CORP_ALIASES[lower];
    for (const id of CORP_IDS) { const d = CORP_DEFS[id]; if (d.name === s || d.name.startsWith(s)) return id; }
    return null;
  }

  private registerConsole(): void {
    const con = this.ctx.console;
    if (!con) return;
    const num = (raw: string | undefined): number => {
      if (raw === undefined) return NaN;
      const s = raw.trim().replace(/^\+/, '');
      return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
    };
    const corpNames = (): string[] => [...CORP_IDS, ...CORP_IDS.map((c) => CORP_DEFS[c].name)];
    const cmds: ConsoleCommand[] = [
      {
        name: 'credits', usage: 'credits <±n>', description: '크레딧을 더하거나 뺍니다',
        run: (args) => {
          const n = num(args[0]);
          if (Number.isNaN(n)) return { error: '사용법: /credits <±n>' };
          if (!this.addCredits(n, 'console')) return { error: `크레딧 부족 (보유 ${formatCredits(this.credits)})` };
          return `크레딧 ${formatCredits(this.credits)}`;
        },
      },
      {
        name: 'rep', usage: 'rep <helix|bastion|nomad|ceres|한국어> <±n>', description: '기업 신뢰도를 더하거나 뺍니다',
        run: (args) => {
          if (args.length < 2) return { error: '사용법: /rep <기업> <±n>' };
          const corp = this.resolveCorp(args.slice(0, -1).join(' '));
          const n = num(args[args.length - 1]);
          if (!corp) return { error: `알 수 없는 기업: ${args.slice(0, -1).join(' ')} (${CORP_IDS.join('/')})` };
          if (Number.isNaN(n)) return { error: '신뢰도가 숫자가 아닙니다' };
          this.addRep(corp, n, 'console');
          const r = this.getRep(corp);
          return `${CORP_DEFS[corp].name} 신뢰도 ${r.rep} (Lv.${r.level}${r.next !== null ? ` · 다음 ${r.next}` : ''})`;
        },
        complete: (args) => (args.length > 1 ? [] : corpNames().filter((n) => n.toLowerCase().startsWith((args[0] ?? '').toLowerCase()))),
      },
      {
        name: 'contract', usage: 'contract list|accept <id>|abandon|hit <goal> <n>', description: '계약 목록 / 수락 / 포기 / 진척 치트',
        run: (args, _ctx, print) => {
          const sub = (args[0] ?? 'list').toLowerCase();
          if (sub === 'list') {
            const ac = this.store.data.activeContract;
            for (const d of CONTRACT_DEFS) {
              const active = ac?.id === d.id;
              print(`${active ? '▶ ' : '  '}${d.id}  ${CORP_DEFS[d.corp].name} · ${d.name} · ${CONTRACT_GOAL_LABEL_KO[d.goal]} ${active ? `${ac!.progress}/` : ''}${d.target} · 신뢰도 Lv.${d.minRepLevel}`, active ? 'success' : 'info');
            }
            return ac ? `진행 중: ${ac.id}` : '진행 중인 계약 없음';
          }
          if (sub === 'accept') {
            const id = args[1];
            if (!id) return { error: '사용법: /contract accept <id>' };
            const def = CONTRACT_DEFS.find((d) => d.id === id);
            if (!def) return { error: `알 수 없는 계약: ${id}` };
            if (!this.acceptContract(id)) return { error: `수락 실패: ${contractBlockReason(def, this.level(def.corp), this.store.data.activeContract ? 1 : 0, this.inShip) ?? '알 수 없음'}` };
            return `계약 수락: ${def.name}`;
          }
          if (sub === 'abandon') return this.abandonContract() ? '계약 포기' : { error: '진행 중인 계약 없음' };
          if (sub === 'hit') {
            const goal = args[1] as ContractGoalKind | undefined;
            const n = num(args[2] ?? '1');
            if (!goal || !GOAL_IDS.includes(goal)) return { error: `사용법: /contract hit <${GOAL_IDS.join('|')}> <n>` };
            if (Number.isNaN(n)) return { error: '수량이 숫자가 아닙니다' };
            const before = this.store.data.activeContract?.progress ?? 0;
            this.reportContractHit(goal, n, true);
            const ac = this.activeContract;
            if (!ac) return { error: '진행 중인 계약 없음' };
            if (ac.progress === before) return { error: `목표 불일치 (${CONTRACT_GOAL_LABEL_KO[ac.def.goal]})` };
            return `${ac.def.name} ${ac.progress} / ${ac.def.target}`;
          }
          return { error: '사용법: /contract list|accept <id>|abandon|hit <goal> <n>' };
        },
        complete: (args) => {
          if (args.length <= 1) return ['list', 'accept', 'abandon', 'hit'].filter((s) => s.startsWith((args[0] ?? '').toLowerCase()));
          if (args[0] === 'accept' && args.length === 2) return CONTRACT_DEFS.map((d) => d.id).filter((s) => s.startsWith(args[1] ?? ''));
          if (args[0] === 'hit' && args.length === 2) return GOAL_IDS.filter((s) => s.startsWith(args[1] ?? ''));
          return [];
        },
      },
      {
        name: 'quest', usage: 'quest list|accept <id>|complete <id>', description: '퀘스트 목록 / 수락 / 납품',
        run: (args, _ctx, print) => {
          const sub = (args[0] ?? 'list').toLowerCase();
          if (sub === 'list') {
            for (const d of QUEST_DEFS) {
              const st = this.getQuestState(d.id);
              print(`  ${d.id}  ${CORP_DEFS[d.corp].name} · ${d.name} · ${st} · ${d.deliver.map((x) => `${x.defId}×${x.qty}`).join(', ')}`, st === 'complete' ? 'success' : 'info');
            }
            return `${QUEST_DEFS.length}개`;
          }
          const id = args[1];
          if (!id) return { error: `사용법: /quest ${sub} <id>` };
          const def = QUEST_DEFS.find((d) => d.id === id);
          if (!def) return { error: `알 수 없는 퀘스트: ${id}` };
          if (sub === 'accept') return this.acceptQuest(id) ? `퀘스트 수락: ${def.name}` : { error: `수락 실패 (${this.getQuestState(id)})` };
          if (sub === 'complete') {
            if (this.completeQuest(id)) return `퀘스트 완료: ${def.name}`;
            return { error: `납품 실패: ${this.questInfo(def).blocked ?? '알 수 없음'}` };
          }
          return { error: '사용법: /quest list|accept <id>|complete <id>' };
        },
        complete: (args) => {
          if (args.length <= 1) return ['list', 'accept', 'complete'].filter((s) => s.startsWith((args[0] ?? '').toLowerCase()));
          if (args.length === 2) return QUEST_DEFS.map((d) => d.id).filter((s) => s.startsWith(args[1] ?? ''));
          return [];
        },
      },
    ];
    for (const c of cmds) this.unsubs.push(con.register(c));
  }
}
