import type {
  ConsoleCommand, ContractDef, ContractGoalKind, ContractInfo, ContractSettlement, CorpId, GameContext, GameSystem, ItemInstance,
  MetaRef, MissionStats, QuestInfo, QuestState, RepInfo, ShopItem,
} from '@/shared';
import {
  CONTRACT_DEFS, CONTRACT_GOAL_LABEL_KO, CORP_DEFS, CORP_IDS, CREDITS_MAX, QUEST_DEFS, repLevelOf, sellPriceOf,
} from '@/shared';
import { MetaStorage } from './Storage';
import {
  REASON, buildShop, contractBlockReason, contractHitDelta, corpSells, killGoalOf, questBlockReason, questStateOf, repInfoOf,
  settleContract,
} from './Rules';
import { CorpMenu } from './ui/CorpMenu';
import './meta.css';

/* ────────────────────────────────────────────────────────────────────────────
 * MetaSystem (Phase 5-c, 2026-09-06): corporations · reputation · credits · contracts · quests · corp shop.
 * Publishes `ctx.meta` (`MetaRef`), persists `MetaSave` v1 in localStorage (`Storage.ts`), applies the pure rules of
 * `Rules.ts`, owns the corp screen DOM (`ui/CorpMenu.ts`, blocker `'corp'`) and the `credits / rep / contract / quest`
 * console commands. Contract goals rise from bus events during a mission; local hits are shared with the squad over
 * the relay-opaque `meta contractHit` message. Toasts are the ui folder's job: this system only emits `meta:*`.
 * ──────────────────────────────────────────────────────────────────────────── */

const CORP_ALIASES: Readonly<Record<string, CorpId>> = { helix: 'helix', bastion: 'bastion', nomad: 'nomad', ceres: 'ceres' };
const GOAL_IDS: readonly ContractGoalKind[] = ['kill_bugs', 'kill_rogues', 'open_crates', 'loot_corpses', 'extract_with_value', 'use_stratagems'];

export class MetaSystem implements GameSystem, MetaRef {
  readonly name = 'meta';
  private ctx!: GameContext;
  private store!: MetaStorage;
  private menu: CorpMenu | null = null;
  private unsubs: Array<() => void> = [];
  private unsubNet: (() => void) | null = null;
  private consoleRegistered = false;
  /** Progress the active contract had when the current mission started (death rule). */
  private progressAtStart = 0;
  /** Corpse containers counted this mission (dedupes the `crate:looted` fallback against `inventory:containerOpened`). */
  private readonly corpsesCounted = new Set<string>();
  private containerOpenedSeen = false;
  /** Last `completeQuest` failure reason per quest id (shown as `QuestInfo.blocked`). */
  private readonly questBlocked = new Map<string, string>();

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.store = new MetaStorage();
    ctx.meta = this;
    this.menu = new CorpMenu(ctx, this);

    const b = ctx.bus;
    this.unsubs.push(
      b.on('game:newMission', () => this.onNewMission()),
      b.on('hub:entered', () => this.save()),
      b.on('enemy:killed', ({ type }) => { if (ctx.isGameplayPhase()) this.localHit(killGoalOf(type), 1); }),
      b.on('crate:open', () => { if (ctx.isGameplayPhase()) this.localHit('open_crates', 1); }),
      b.on('inventory:containerOpened', ({ containerId, first }) => {
        this.containerOpenedSeen = true;
        if (!ctx.isGameplayPhase() || !first || !containerId.startsWith('corpse:')) return;
        if (this.corpsesCounted.has(containerId)) return;
        this.corpsesCounted.add(containerId);
        this.localHit('loot_corpses', 1);
      }),
      // fallback while inventory has not shipped `inventory:containerOpened` yet: an emptied corpse counts once
      b.on('crate:looted', ({ crateId }) => {
        if (this.containerOpenedSeen || !ctx.isGameplayPhase() || !crateId.startsWith('corpse:')) return;
        if (this.corpsesCounted.has(crateId)) return;
        this.corpsesCounted.add(crateId);
        this.localHit('loot_corpses', 1);
      }),
      b.on('stratagem:called', ({ caller }) => {
        if (!ctx.isGameplayPhase()) return;
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
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.unsubNet?.(); this.unsubNet = null;
    this.menu?.dispose(); this.menu = null;
    this.store.dispose();
    if (this.ctx?.meta === this) this.ctx.meta = null;
  }

  private subscribeNet(): void {
    const net = this.ctx.net;
    if (!net || typeof net.onMessage !== 'function') return;
    this.unsubNet = net.onMessage('meta', (msg) => {
      if (msg.ev !== 'contractHit' || !this.ctx.isGameplayPhase()) return;
      const ac = this.activeDef();
      if (!ac || ac.corp !== msg.corp) return;
      this.reportContractHit(msg.goal, msg.amount, false);
    });
  }

  /* ── helpers ─────────────────────────────────────────────────────────────── */
  private get inShip(): boolean { return this.ctx.isHubPhase() && !this.ctx.isRaidActive(); }
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
  private countAll(defId: string): number {
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
  }

  private localHit(goal: ContractGoalKind, amount: number): void {
    this.reportContractHit(goal, amount, true);
  }

  private trackLootValue(totalValue: number): void {
    if (!this.ctx.isGameplayPhase()) return;
    const def = this.activeDef();
    const ac = this.store.data.activeContract;
    if (!def || !ac || def.goal !== 'extract_with_value') return;
    const v = Math.max(0, Math.round(totalValue));
    if (v === ac.progress) return;
    const delta = v - ac.progress;
    ac.progress = v;
    this.ctx.bus.emit('meta:contractProgress', { id: def.id, corp: def.corp, goal: def.goal, progress: v, target: def.target, delta });
  }

  /* ── MetaRef: credits / rep ─────────────────────────────────────────────── */
  get credits(): number { return this.store.data.credits; }

  getRep(corp: CorpId): RepInfo { return repInfoOf(this.store.corp(corp).rep); }

  addCredits(delta: number, reason: string): boolean {
    const d = Math.round(Number(delta) || 0);
    const cur = this.store.data.credits;
    if (cur + d < 0) return false;
    const next = Math.min(CREDITS_MAX, cur + d);
    if (next === cur && d !== 0 && cur >= CREDITS_MAX) return true;
    this.store.data.credits = next;
    this.store.markDirty();
    this.ctx.bus.emit('meta:creditsChanged', { credits: next, delta: next - cur, reason });
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
    return buildShop(def, loot.getAllItemDefs(), this.level(corp), this.credits, this.inShip, (id) => loot.getWeaponDef(id));
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

  buy(corp: CorpId, defId: string): boolean {
    if (!this.inShip) return false;
    const loot = this.ctx.loot;
    const price = this.priceOf(corp, defId);
    if (!loot || price === null) return false;
    if (!this.addCredits(-price, `buy:${defId}`)) return false;
    let placed: 'bag' | 'stash' | null = null;
    try { placed = this.addAnywhere(loot.createItem(defId, 1)); } catch { placed = null; }
    if (!placed) { this.addCredits(price, `refund:${defId}`); return false; }
    this.store.data.stats.creditsSpent += price;
    this.store.markDirty();
    this.ctx.bus.emit('meta:purchase', { corp, defId, price, placed });
    return true;
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
    return true;
  }

  abandonContract(): boolean {
    const def = this.activeDef();
    if (!def) return false;
    this.store.data.activeContract = null;
    this.progressAtStart = 0;
    this.store.markDirty();
    this.ctx.bus.emit('meta:contractAbandoned', { id: def.id, corp: def.corp });
    return true;
  }

  reportContractHit(goal: ContractGoalKind, amount: number, local: boolean): void {
    const def = this.activeDef();
    const ac = this.store.data.activeContract;
    if (!def || !ac || def.goal !== goal) return;
    const delta = contractHitDelta(amount, local);
    if (delta <= 0) return;
    ac.progress += delta;
    this.store.markDirty();
    this.ctx.bus.emit('meta:contractProgress', { id: def.id, corp: def.corp, goal, progress: ac.progress, target: def.target, delta });
    if (local && this.ctx.isMultiplayer && this.ctx.net && typeof this.ctx.net.send === 'function') {
      this.ctx.net.send({ t: 'meta', ev: 'contractHit', corp: def.corp, goal, amount: Math.max(0, amount) }, 'others');
    }
  }

  settleMission(stats: MissionStats): ContractSettlement | null {
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
          if (!this.addCredits(n, 'console')) return { error: `크레딧 부족 (보유 ${this.credits})` };
          return `크레딧 ${this.credits}`;
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
