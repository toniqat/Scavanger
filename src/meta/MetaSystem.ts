import type {
  ConsoleCommand, ContractDef, ContractGoalKind, ContractInfo, ContractSettlement, CorpId, CreditsTxResult, EmbeddedView,
  GameContext, GameMessageOf, GameSystem, ItemDef, ItemInstance, MetaRef, MetaRequest, MissionStats, PeerId, ProfileRef, QuestInfo,
  QuestState, RepInfo, ShopItem, SquadContractInfo,
} from '@/shared';
import {
  CONTRACT_DEFS, CONTRACT_GOAL_LABEL_KO, CORP_DEFS, CORP_IDS, CREDITS_MAX, META_HIT_MAX, QUEST_DEFS, formatCredits,
  repLevelOf, sellPriceOf,
} from '@/shared';
import { MAX_PROGRESS, MetaStorage } from './Storage';
import {
  REASON, buildShop, canRepairImplant, contractBlockReason, contractHitDelta, corpSells, implantRepairCost, implantRepairFee,
  implantRepairMaterialIds, isRepairableImplantDef, killGoalOf, questBlockReason, questStateOf, repInfoOf, settleContract,
} from './Rules';
import { CorpView } from './ui/CorpView';
import './meta.css';

import { CORP_ALIASES, GOAL_IDS, type ImplantRepairInfo, type ImplantRepairResult, type PurchaseFailure, isValidHit } from './model';
/** 폴더 공용 어휘(상수 · 타입 · 스크래치)는 `model.ts` 가 갖는다 — 기존 import 경로를 위해 재수출한다. */
export * from './model';
import * as Trade from './parts/Trade';
import * as Contract from './parts/Contracts';
import * as Credits from './parts/Credits';
import * as Desk from './parts/ImplantDesk';
import * as Cmd from './parts/Console';

export class MetaSystem implements GameSystem, MetaRef {
  readonly name = 'meta';
  ctx!: GameContext;
  store!: MetaStorage;
  /** Embedded 기업 tabs handed out by `createCorpView` (their message timers tick with the system). */
  private readonly views = new Set<CorpView>();
  /** Corp the next 기업 tab opens on (`openCorpMenu(corp)`); the tab builds a fresh `CorpView` every time. */
  private preferredCorp: CorpId | null = null;
  unsubs: Array<() => void> = [];
  unsubNet: (() => void) | null = null;
  private consoleRegistered = false;
  /** Last refused purchase (sync or async) — the corp screen reads it for its message line. */
  lastPurchaseFailure: PurchaseFailure | null = null;
  /**
   * Called after an async purchase failed (server refusal / placement). Legacy single slot — every corp view now
   * subscribes through `onPurchaseFailure()` instead, so the standalone screen and an embedded 기업 tab can coexist.
   */
  onPurchaseFailed: ((f: PurchaseFailure) => void) | null = null;
  readonly purchaseFailListeners = new Set<(f: PurchaseFailure) => void>();
  /** Phase 12: repair desk listeners (`onImplantRepaired`) — the async server path finishes after the click returns. */
  readonly repairListeners = new Set<(r: ImplantRepairResult) => void>();
  /** Broken implants whose server fee transaction is still in flight (the desk greys them out). */
  readonly repairPending = new Set<string>();
  /** Server transactions still in flight (purchase buttons stay enabled; the optimistic balance already covers them). */
  pendingTx = 0;
  /** Progress the active contract had when the current mission started (death rule). */
  progressAtStart = 0;
  /** Corpse containers counted this mission (dedupes the `crate:looted` fallback against `inventory:containerOpened`). */
  private readonly corpsesCounted = new Set<string>();
  private containerOpenedSeen = false;
  /** Last `completeQuest` failure reason per quest id (shown as `QuestInfo.blocked`). */
  readonly questBlocked = new Map<string, string>();
  /* Phase 9: late-join catch-up */
  /** Contract hits this client broadcast this mission, per goal (what a late joiner is handed on `metaq sync`). */
  readonly sentHits = new Map<ContractGoalKind, number>();
  /** Requesters already answered this mission (one `meta sync` per peer per mission, answered or not). */
  readonly syncAnswered = new Set<PeerId>();
  /** A rejoin is under way: ask the squad for its hits once the world is ready. */
  private syncRequestPending = false;
  /* Phase 9 UI pass: the squad's contracts, so the HUD can draw a row per member (`meta contract`). */
  /** Last `meta contract` broadcast per peer; an `id: null` broadcast removes the entry. Never holds the local peer. */
  readonly squadContracts = new Map<PeerId, { id: string; progress: number }>();
  /** Last `{id}|{progress}` we broadcast, so an unchanged contract never re-sends. */
  lastContractSent = '';

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.store = new MetaStorage(() => this.profileRef());
    ctx.meta = this;

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
    for (const v of this.views) v.update();
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.unsubNet?.(); this.unsubNet = null;
    for (const v of [...this.views]) v.dispose();
    this.views.clear();
    this.purchaseFailListeners.clear();
    this.repairListeners.clear();
    this.store.dispose();
    if (this.ctx?.meta === this) this.ctx.meta = null;
  }

  private subscribeNet(): void { return Credits.subscribeNet(this); }

  /**
   * Relayed contract traffic (`meta contractHit` live, `meta sync` catch-up). Both are validated before they touch the
   * contract: corp / goal whitelists, a finite amount within `1..max` (`META_HIT_MAX` for a live hit — a real hit is 1 —
   * and the contract target for a sync entry); a message for another corp's contract is ignored.
   */
  onMetaMessage(msg: GameMessageOf<'meta'>, from: PeerId): void { return Credits.onMetaMessage(this, msg, from); }

  /** `metaq sync`: answer a rejoining peer once per mission with the hits broadcast so far (only with an active contract). */
  onMetaRequest(msg: MetaRequest, from: PeerId): void { return Credits.onMetaRequest(this, msg, from); }

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
  get inShip(): boolean { return this.ctx.isHubPhase() && !this.ctx.isRaidActive(); }
  /** `ctx.net.profile` when net published one (always present since Phase 7, `available` false offline). */
  profileRef(): ProfileRef | null { return Credits.profileRef(this); }
  /** Server-owned credits in effect (relay answered with a profile). */
  get serverCredits(): boolean {
    const p = this.profileRef();
    return !!p && p.available === true && typeof p.addCredits === 'function';
  }
  inTraining(): boolean {
    const ctx = this.ctx;
    return typeof ctx.isTraining === 'function' ? ctx.isTraining() : ctx.missionMode === 'training';
  }
  /** Bag / stash pre-check (`InventoryRef.canFit`); a missing helper counts as "fits" (inventory/ built in parallel). */
  fits(defId: string, qty = 1): boolean { return Trade.fits(this, defId, qty); }
  /** Overwrite the balance with the server's answer (no delta bookkeeping — the server is the truth). */
  adoptServerCredits(credits: number, reason: string): void { return Credits.adoptServerCredits(this, credits, reason); }
  /** Local, synchronous credit move (the offline path and the optimistic half of a server transaction). */
  applyCreditsLocal(delta: number, reason: string): boolean { return Credits.applyCreditsLocal(this, delta, reason); }
  /**
   * Server transaction after the optimistic local apply: the answer overwrites the balance; a refusal reverts the
   * local delta; a dead socket keeps the local value (offline fallback — resynced on the next `net:profileLoaded`).
   */
  serverTx(delta: number, reason: string, revertOnRefuse = true): Promise<CreditsTxResult | null> { return Credits.serverTx(this, delta, reason, revertOnRefuse); }
  get hasPendingTx(): boolean { return this.pendingTx > 0; }

  /**
   * `net:profileLoaded`: the server `meta` document replaces the local save (server wins); the balance is the server's.
   * `migrated` = the server had no balance yet → the local one is uploaded as the initial balance (`reason 'migrate'`).
   * No document on the server → our local save is uploaded so the next client sees it.
   */
  private onProfileLoaded(migrated: boolean): void { return Credits.onProfileLoaded(this, migrated); }
  activeDef(): ContractDef | null {
    const ac = this.store.data.activeContract;
    if (!ac) return null;
    const def = CONTRACT_DEFS.find((d) => d.id === ac.id);
    if (!def) { this.store.data.activeContract = null; this.store.markDirty(); return null; }
    return def;
  }
  level(corp: CorpId): number { return repLevelOf(this.store.corp(corp).rep); }
  itemDef(defId: string) { return this.ctx.loot?.getItemDef(defId) ?? this.ctx.inventory?.getDef(defId); }
  equippedUids(): Set<string> {
    const out = new Set<string>();
    const lo = this.ctx.inventory?.getLoadout();
    if (!lo) return out;
    for (const inst of [lo.primary, lo.primary2, lo.secondary, lo.bag, lo.armor ?? null]) if (inst) out.add(inst.uid);
    return out;
  }
  findAnywhere(uid: string): ItemInstance | null { return Trade.findAnywhere(this, uid); }
  /** Bag + stash units of a def (corp views render 보유/필요 chips from it). */
  countAll(defId: string): number { return Trade.countAll(this, defId); }
  /** Bag first, then the stash; falls back to the bag-only `tryAddItem` while inventory's helper is a stub. */
  addAnywhere(item: ItemInstance): 'bag' | 'stash' | null { return Trade.addAnywhere(this, item); }
  takeBack(uid: string, qty?: number): number { return Trade.takeBack(this, uid, qty); }

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
  getSquadContracts(): readonly SquadContractInfo[] { return Contract.getSquadContracts(this); }

  private clearSquadContracts(): void { return Contract.clearSquadContracts(this); }

  /** Store a relayed `meta contract`; `id` null (or an unknown def) drops the member's row. */
  applySquadContract(peer: PeerId, id: string | null, progress: number): void { return Contract.applySquadContract(this, peer, id, progress); }

  /**
   * Tell the squad what we are working on. `to` defaults to every other member; a `metaq sync` answer targets one.
   * Silent outside a real multiplayer raid, and a no-op when nothing changed since the last broadcast.
   */
  broadcastContract(to: PeerId | 'others' = 'others', force = false): void { return Contract.broadcastContract(this, to, force); }

  private localHit(goal: ContractGoalKind, amount: number): void { return Contract.localHit(this, goal, amount); }

  private trackLootValue(totalValue: number): void { return Contract.trackLootValue(this, totalValue); }

  /* ── MetaRef: credits / rep ─────────────────────────────────────────────── */
  get credits(): number { return this.store.data.credits; }

  getRep(corp: CorpId): RepInfo { return Credits.getRep(this, corp); }

  /**
   * Credits move: refused synchronously below 0 (local pre-check). Offline that is the whole story; with a server
   * profile the local apply is optimistic and a `credits:tx` follows — its answer overwrites the balance, a refusal
   * reverts the delta (`meta:creditsChanged` with `revert:<reason>`).
   */
  addCredits(delta: number, reason: string): boolean { return Credits.addCredits(this, delta, reason); }

  addRep(corp: CorpId, delta: number, reason: string): void { return Credits.addRep(this, corp, delta, reason); }

  /* ── MetaRef: shop ──────────────────────────────────────────────────────── */
  getShop(corp: CorpId): ShopItem[] { return Trade.getShop(this, corp); }

  priceOf(corp: CorpId, defId: string): number | null { return Trade.priceOf(this, corp, defId); }

  /**
   * Purchase. Synchronous answer = was the request accepted (ship, on the shelf, `canFit`, credits). Offline the item
   * is created and placed right here (pre-checked, so no refund step is needed — a placement failure still refunds
   * defensively). With a server profile the credits are debited optimistically, the server transaction runs, and only
   * an `ok` answer creates + places the item (a placement failure refunds through the server); either way completion
   * is announced by `meta:purchase` and a failure by `onPurchaseFailed` / `lastPurchaseFailure`.
   */
  buy(corp: CorpId, defId: string): boolean { return Trade.buy(this, corp, defId); }

  completePurchase(corp: CorpId, defId: string, price: number, placed: 'bag' | 'stash'): void { return Trade.completePurchase(this, corp, defId, price, placed); }

  failPurchase(f: PurchaseFailure): void { return Trade.failPurchase(this, f); }

  /** Subscribe to async purchase refusals (folder-internal; the standalone screen and every embedded 기업 tab use it). */
  onPurchaseFailure(fn: (f: PurchaseFailure) => void): () => void { return Trade.onPurchaseFailure(this, fn); }

  sellPriceOf(uid: string, qty?: number): number | null {
    const inst = this.findAnywhere(uid);
    if (!inst || this.equippedUids().has(uid)) return null;
    const def = this.itemDef(inst.defId);
    if (!def || !(def.value > 0)) return null;
    const n = Math.max(1, Math.min(inst.qty, Math.floor(qty ?? inst.qty)));
    return sellPriceOf(def.value, n);
  }

  sell(uid: string, qty?: number): boolean { return Trade.sell(this, uid, qty); }

  getSellable(): readonly ItemInstance[] { return Trade.getSellable(this); }

  /* ── 임플란트 수리 desk (Phase 12, 2026-09-08; folder-internal, 세레스 바이오 only) ─────────────────────────
   * A broken implant (`ItemDef.implant.broken`, raid loot) in the bag or the stash becomes its `repairsTo` for the
   * def's `repairCost` materials (bag + stash, `consumeDefAll`) plus a credit fee (`Rules.implantRepairFee`). The fee
   * goes through the **purchase path**: offline it is a local debit; with a server profile it is an optimistic debit
   * + `credits:tx`, and the item swap runs only on `ok` (a refusal reverts the credits and leaves the broken implant
   * where it was). The repaired implant lands in the 함선 창고 first, then anywhere; when nothing can hold it the
   * broken implant and every material are put back and the fee refunded. `ui:notify` toasts the completion.
   * ──────────────────────────────────────────────────────────────────────── */

  /** Every broken implant in the bag + stash (equipped implants live in progression, so they never show up). */
  getRepairableImplants(): ImplantRepairInfo[] { return Desk.getRepairableImplants(this); }

  /** The desk's view of one broken implant, or null when `uid` is not a broken implant in the bag / stash. */
  getImplantRepair(uid: string): ImplantRepairInfo | null { return Desk.getImplantRepair(this, uid); }

  repairInfo(inst: ItemInstance, broken: ItemDef): ImplantRepairInfo { return Desk.repairInfo(this, inst, broken); }

  /** Subscribe to finished repairs (the server path completes after `repairImplant` returned). */
  onImplantRepaired(fn: (r: ImplantRepairResult) => void): () => void { return Desk.onImplantRepaired(this, fn); }

  /** Is the fee transaction for `uid` still in flight? */
  isRepairPending(uid: string): boolean { return Desk.isRepairPending(this, uid); }

  /**
   * Repair the broken implant `uid`. Synchronous answer = the request was accepted (offline: the swap already
   * happened; server: the fee is debited optimistically and the swap follows the `credits:tx` answer). Completion
   * (either way) is reported through `onImplantRepaired` + a `ui:notify` toast.
   */
  repairImplant(uid: string): boolean { return Desk.repairImplant(this, uid); }

  /**
   * The item half of a repair: re-validate (the broken implant / materials may have moved since the click), take the
   * broken implant, consume the materials, create the repaired one (stash first, then anywhere). Any failure puts
   * everything taken so far back — the caller refunds the fee.
   */
  performRepair(uid: string, broken: ItemDef, target: ItemDef): { ok: boolean; reason: string | null } { return Desk.performRepair(this, uid, broken, target); }

  /** Re-create `qty` of `defId` into the bag / stash (undo of a consumed material or a taken broken implant). */
  giveBack(defId: string, qty: number): void { return Desk.giveBack(this, defId, qty); }

  finishRepair(r: ImplantRepairResult): void { return Desk.finishRepair(this, r); }

  /* ── MetaRef: contracts ─────────────────────────────────────────────────── */
  getContracts(corp: CorpId): ContractInfo[] { return Contract.getContracts(this, corp); }

  get activeContract(): ContractInfo | null {
    const def = this.activeDef();
    const ac = this.store.data.activeContract;
    if (!def || !ac) return null;
    return { def, progress: ac.progress, active: true, blocked: REASON.active };
  }

  acceptContract(id: string): boolean { return Contract.acceptContract(this, id); }

  abandonContract(): boolean { return Contract.abandonContract(this); }

  reportContractHit(goal: ContractGoalKind, amount: number, local: boolean): void { return Contract.reportContractHit(this, goal, amount, local); }

  settleMission(stats: MissionStats): ContractSettlement | null { return Contract.settleMission(this, stats); }

  /* ── MetaRef: quests ────────────────────────────────────────────────────── */
  getQuestState(id: string): QuestState { return Contract.getQuestState(this, id); }

  questInfo(def: typeof QUEST_DEFS[number]): QuestInfo { return Contract.questInfo(this, def); }

  getQuests(corp: CorpId): QuestInfo[] { return Contract.getQuests(this, corp); }

  acceptQuest(id: string): boolean { return Contract.acceptQuest(this, id); }

  completeQuest(id: string): boolean { return Contract.completeQuest(this, id); }

  /* ── MetaRef: corp screen ───────────────────────────────────────────────── */
  /**
   * 기업 네트워크. **2026-09-07**: there is no separate overlay any more — the screen *is* the Tab window's 기업 tab
   * (`InventoryRef.openScreen('corp')`), so the ship computer's `E` and Tab → 기업 land on exactly the same DOM,
   * blocker and cursor. `corp` preselects which corporation the tab opens on.
   */
  openCorpMenu(corp?: CorpId): void {
    if (this.ctx.isRaidActive()) return;
    if (corp && CORP_DEFS[corp]) this.preferredCorp = corp;
    const inv = this.ctx.inventory;
    if (!inv || typeof inv.openScreen !== 'function') return;
    if (!inv.openScreen('corp')) return;
    for (const v of this.views) v.refresh();
  }

  /** Close the 기업 screen = close the Tab window it lives in (nothing else owns it). */
  closeCorpMenu(): void {
    if (!this.isMenuOpen) return;
    this.ctx.inventory?.closeAll();
  }

  /** true while the Tab window is showing the 기업 tab. */
  get isMenuOpen(): boolean {
    const inv = this.ctx?.inventory;
    return !!inv && inv.isOpen === true && inv.screenTab === 'corp';
  }

  /**
   * The 기업 tab of the inventory Tab screen (Phase 8; the only shell since 2026-09-07). **No `'corp'` blocker, no
   * cursor-mode / pointer-lock call, no window Escape listener** — the inventory window owns all three. `dispose()`
   * removes only what the view added, and both ends emit `ui:corpToggled` so listeners still see the screen open /
   * close exactly once.
   */
  createCorpView(host: HTMLElement): EmbeddedView {
    const view = new CorpView(this.ctx, this, host, { embedded: true });
    if (this.preferredCorp) { view.setCorpSilent(this.preferredCorp); this.preferredCorp = null; }
    this.views.add(view);
    view.refresh();
    this.ctx.bus.emit('ui:corpToggled', { open: true, corp: view.currentCorp });
    return {
      refresh: () => view.refresh(),
      dispose: () => {
        this.views.delete(view);
        const corp = view.currentCorp;
        view.dispose();
        this.ctx.bus.emit('ui:corpToggled', { open: false, corp });
      },
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
  resolveCorp(raw: string | undefined): CorpId | null {
    if (!raw) return null;
    const s = raw.trim();
    const lower = s.toLowerCase();
    if (CORP_ALIASES[lower]) return CORP_ALIASES[lower];
    for (const id of CORP_IDS) { const d = CORP_DEFS[id]; if (d.name === s || d.name.startsWith(s)) return id; }
    return null;
  }

  private registerConsole(): void { return Cmd.registerConsole(this); }
}
