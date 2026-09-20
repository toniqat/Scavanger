/**
 * src/meta/parts/NpcQuests.ts — **`ctx.meta.npc`**: NPC contact · conversation · quests
 * (2026-09-14, docs/DECISIONS.md 「2026-09-14 — 메신저 · NPC 퀘스트 · 단체방」).
 *
 * It replaces corp quests. An NPC makes contact **in the ship only** (`evaluate` — ship entry · profile load ·
 * level · trust · a completed quest · every `NPC_OFFER_CHECK_S`); once the requirements (`npcs.csv`'s req*) are met
 * it makes first contact (intro), and if that NPC has no offer waiting, the next quest in file row order is offered
 * (offer). The log saves **events only** (`NpcLogEntry`) and the text is resolved from the csv again.
 *
 *   offered ─[수락]→ active ─(every objective)─[완료 보고]→ complete
 *
 * 2026-09-14 3rd pass (user's decision, docs/DECISIONS.md 「2026-09-14 — NPC 첫 연락 3단」):
 *   • **First contact has three steps** — `intro` (the greeting) → the choices (`introChoices`) → `introAfter`
 *     (the main point). An NPC with `introAfter` **offers no quest before the choices are answered**
 *     (`evaluate`); once they are, `chooseIntro` calls the offer on the spot.
 *   • **There is no 「생각해보지」** — `defer()` is always false and writes no new `decline` entry. The `deferred`
 *     state and the `decline` · `brief` lines stay only so old saves and old logs can be read.
 *   • **The quest list holds only what was taken** — `getQuests()` filters `offered` · `deferred` out (an offer
 *     shows up as a card in the chat and nowhere else).
 *
 * There is no abandon (user's decision). A delivery may be split (`deliver` — bag + stash); the report places the
 * reward items first (on `공간 없음` nothing changes), then credits `quest:<id>` → trust (corp + **that NPC's own**)
 * → XP, in that order. Raid objectives are in `parts/NpcObjectives.ts`.
 */
import type {
  GameContext, ItemDef, ItemInstance, MissionStats, NpcContactInfo, NpcDef, NpcFlag, NpcLogEntry, NpcLogEvent, NpcMessage, NpcObjectiveDef,
  NpcObjectiveInfo, NpcQuestDef, NpcQuestInfo, NpcQuestRef, NpcQuestSave, NpcQuestState, NpcSave, QuestState, WeaponClass,
} from '@/shared';
import {
  NPC_DEFS, NPC_DEF_MAP, NPC_LOG_MAX, NPC_OFFER_CHECK_S, NPC_QUEST_DEFS, NPC_QUEST_MAP, NPC_RAID_OBJECTIVE_KINDS, NPC_REPLY_KO,
  formatCreditReason, isRaidFound, raidFoundSeed,
  /* 2026-09-14: per-NPC trust — it uses the same REP_TABLE as a corporation */
  repLevelOf,
} from '@/shared';
import {
  NPC_REASON, type NpcReqContext, freshNpcSave, itemMatches, legacyQuestState, npcTrustReason, objectiveLabel, requirementMet,
  rewardSummary, weaponSpecClass,
} from '../NpcRules';
import type { MetaSystem } from '../MetaSystem';
import { commitQuestTx } from './Contracts';
import * as Obj from './NpcObjectives';

const STATE_RANK: Readonly<Record<NpcQuestState, number>> = { active: 0, deferred: 1, offered: 2, complete: 3 };

export class NpcQuests implements NpcQuestRef {
  /**
   * This raid's progress before it is confirmed — quest id → a count per objective. Emptied when the raid ends
   * (`NpcObjectives.resetRaid`).
   */
  readonly raidProgress = new Map<string, number[]>();
  /** Container ids already counted this raid (the `search` objective). */
  readonly searched = new Set<string>();
  /** Structure ids already counted this raid (the `discover` objective). */
  readonly discovered = new Set<string>();
  /** Quests whose last [완료 보고] failed for lack of room → the reason. */
  readonly reportBlocked = new Map<string, string>();
  private lastStamp = 0;
  private checkT = 0;
  private lastUnreadSent = -1;
  private evaluating = false;

  constructor(readonly sys: MetaSystem) {}

  get ctx(): GameContext { return this.sys.ctx; }

  /** The current save (`MetaSave.npc`) — read every time: `MetaStorage.replace` swaps the data object out. */
  get save(): NpcSave {
    const d = this.sys.store.data;
    return d.npc ?? (d.npc = freshNpcSave());
  }

  /* ── Per-NPC trust (2026-09-14, docs/DECISIONS.md 「2026-09-14 — 정보상」) ──────
   * **Separate** from corp reputation and uses the same `REP_TABLE` (user's decision — no need for a second table).
   * It only accrues and displays today, so nothing is locked by it; the `NpcRequirement.npcRep` contract is
   * already there. */

  /** The accumulated trust score (0 when there is none). */
  trustOf(npcId: string): number {
    const t = this.save.trust;
    return Math.max(0, Math.round(t?.[npcId] ?? 0));
  }

  /** 0–5. The same `REP_TABLE` as a corporation. */
  trustLevelOf(npcId: string): number { return repLevelOf(this.trustOf(npcId)); }

  /* ── Progress flags (2026-09-14 3rd pass) — the only input of `NpcRequirement.flags` ────
   * Counted here and read here, nowhere else. When a value rises the contact requirements are looked at on the spot
   * (`evaluate` only attaches in the ship, so a flag raised mid-raid takes effect on entering the ship). */

  /** That flag's running count (0 when there is none). */
  flagOf(flag: NpcFlag): number {
    return Math.max(0, Math.round(this.save.flags?.[flag] ?? 0));
  }

  /** Adds to the running count (0 or less is ignored). */
  bumpFlag(flag: NpcFlag, delta = 1): void {
    const d = Math.round(delta);
    if (!Number.isFinite(d) || d <= 0) return;
    const save = this.save;
    const flags = save.flags ?? (save.flags = {});
    flags[flag] = this.flagOf(flag) + d;
    this.sys.store.markDirty();
    this.evaluate();
  }

  /** Adds (it never goes below 0). A level rise carries `levelUp` — the receiver decides about a toast. */
  addTrust(npcId: string, delta: number, _reason: string): void {
    const d = Math.round(delta);
    if (!npcId || !Number.isFinite(d) || d === 0) return;
    const save = this.save;
    const trust = save.trust ?? (save.trust = {});
    const before = Math.max(0, Math.round(trust[npcId] ?? 0));
    const beforeLv = repLevelOf(before);
    const after = Math.max(0, before + d);
    trust[npcId] = after;
    const level = repLevelOf(after);
    this.sys.store.markDirty();
    this.ctx.bus.emit('meta:npcTrustChanged', { npc: npcId, trust: after, level, delta: d, levelUp: level > beforeLv });
  }

  /** Called by `MetaSystem.init` — the returned unsubscribe functions go into the system's `unsubs`. */
  subscribe(): Array<() => void> {
    const b = this.ctx.bus;
    const evaluate = (): void => { this.evaluate(); };
    return [
      b.on('hub:entered', () => { Obj.resetRaid(this); this.evaluate(); }),
      b.on('net:profileLoaded', () => { this.reportBlocked.clear(); this.lastStamp = 0; this.evaluate(); this.emitUnread(true); }),
      b.on('progress:loaded', evaluate),
      b.on('progress:levelUp', evaluate),
      b.on('meta:repChanged', evaluate),
      b.on('game:newMission', () => { Obj.resetRaid(this); this.reportBlocked.clear(); }),
      /* 2026-09-14 3rd pass: a raid returned from alive · something gathered are NPC first-contact requirements
       * (`NpcRequirement.flags`). **Only a real raid counts** — if the tutorial or the training range raised
       * `raidReturned`, `차유나` would make contact the moment the tutorial ends and break the decision
       * 「튜토리얼 직후 연락 오는 NPC 는 레이븐 하나」. */
      b.on('game:complete', () => { Obj.resetRaid(this); if (this.ctx.missionMode === 'raid') this.bumpFlag('raidReturned'); }),
      b.on('gather:collected', () => this.bumpFlag('gathered')),
      b.on('game:over', () => Obj.resetRaid(this)),
      b.on('game:abort', () => Obj.resetRaid(this)),
      // My own last hit only (the contract's rule — a squadmate's kill arrives separately as `enemy:squadKill`)
      b.on('enemy:killed', ({ type, by, weaponClass }) => {
        if (by !== undefined && by !== 'local' && by !== (this.ctx.net?.localId ?? null)) return;
        Obj.onKill(this, type, weaponClass);
      }),
      b.on('fog:discovered', ({ kind, id }) => { if (kind === 'structure') Obj.onDiscover(this, id); }),
      b.on('crate:open', ({ crateId, zoneKind }) => Obj.onSearch(this, crateId, zoneKind)),
      b.on('world:interacted', ({ kind }) => Obj.onInteract(this, kind)),
      b.on('inventory:changed', () => Obj.trackRecover(this)),
      b.on('inventory:quickSlotsChanged', () => Obj.trackRecover(this)),
    ];
  }

  update(dt: number): void {
    this.checkT -= dt;
    if (this.checkT > 0) return;
    this.checkT = NPC_OFFER_CHECK_S;
    this.evaluate();
    this.emitUnread();
  }

  /* ── Judgement helpers (`NpcObjectives` uses them too) ────────────────── */

  /** When raid objectives count — during a raid (the drop included) · not the training range. */
  counting(): boolean {
    const ctx = this.ctx;
    return !!ctx && ctx.isRaidActive() && !this.sys.inTraining();
  }

  planetOk(o: NpcObjectiveDef): boolean {
    return !o.planet || o.planet === this.ctx.missionPlanet;
  }

  private classOf = (def: ItemDef): WeaponClass | null => {
    if (!def.weaponId) return null;
    try { return this.ctx.loot?.getWeaponDef(def.weaponId)?.weaponClass ?? null; } catch { return null; }
  };

  /** How many `spec` carried on the body (bag · quick slots · pouch) were found in the raid `seed`. */
  carried(spec: string | undefined, seed: number | null): number {
    const inv = this.ctx.inventory;
    if (!spec || seed === null || !inv || typeof inv.countWhere !== 'function') return 0;
    try { return Math.max(0, Math.floor(inv.countWhere((d, inst) => itemMatches(spec, d, this.classOf) && isRaidFound(inst, seed)))); } catch { return 0; }
  }

  /** The item defs `spec` covers (just the one when it is an item id). */
  private defsFor(spec: string | undefined): ItemDef[] {
    if (!spec) return [];
    if (!weaponSpecClass(spec)) { const d = this.sys.itemDef(spec); return d ? [d] : []; }
    const all = this.ctx.loot?.getAllItemDefs?.() ?? [];
    return all.filter((d) => itemMatches(spec, d, this.classOf));
  }

  /** How many are held in bag + stash (delivery). */
  private haveCount(spec: string | undefined): number {
    const inv = this.ctx.inventory;
    if (!inv || typeof inv.countDefAll !== 'function') return 0;
    let n = 0;
    for (const d of this.defsFor(spec)) { try { n += Math.max(0, inv.countDefAll(d.id)); } catch { /* inventory not ready */ } }
    return n;
  }

  private itemName = (defId: string): string => this.sys.itemDef(defId)?.name ?? defId;

  private reqCtx(): NpcReqContext {
    const prog = this.ctx.progression;
    const level = prog && Number.isFinite(prog.level) ? prog.level : 1;
    return {
      level,
      repLevel: (c) => this.sys.level(c),
      questDone: (id) => this.save.quests[id]?.s === 'complete',
      npcTrustLevel: (id) => this.trustLevelOf(id),
      flagCount: (f) => this.flagOf(f),
    };
  }

  checkReady(def: NpcQuestDef, s: NpcQuestSave): void {
    if (s.s !== 'active' || !def.objectives.every((o, i) => (s.p[i] ?? 0) >= o.target)) return;
    this.ctx.bus.emit('npc:questReady', { id: def.id, npc: def.npc });
  }

  /* ── The log ──────────────────────────────────────────────────────────── */

  /** A timestamp that keeps the log in order (ascending even when several events land at once). */
  private stamp(): number {
    if (this.lastStamp === 0) for (const list of Object.values(this.save.log)) for (const e of list) if (e.at > this.lastStamp) this.lastStamp = e.at;
    this.lastStamp = Math.max(Date.now(), this.lastStamp + 1);
    return this.lastStamp;
  }

  /** `c` is for `choice` only — the number picked among the choices (2026-09-14). */
  private log(npc: string, e: NpcLogEvent, q?: string, c?: number): void {
    const at = this.stamp();
    const entry: NpcLogEntry = q ? { at, e, q } : c !== undefined ? { at, e, c } : { at, e };
    const list = this.save.log[npc] ?? (this.save.log[npc] = []);
    list.push(entry);
    if (list.length > NPC_LOG_MAX) list.splice(0, list.length - NPC_LOG_MAX);
    this.sys.store.markDirty();
    this.ctx.bus.emit('npc:message', { npc, entry: { ...entry } });
  }

  private emitUnread(force = false): void {
    const total = this.unreadTotal;
    if (!force && total === this.lastUnreadSent) return;
    this.lastUnreadSent = total;
    this.ctx.bus.emit('npc:unreadChanged', { total });
  }

  /* ── Contact · offers ─────────────────────────────────────────────────── */

  /**
   * Does the tutorial block contact and offers?
   *   ① Any track that is **running** blocks them (the build track hides the messenger button, so a contact that
   *      arrived then could not even be seen).
   *   ② **Before the ship track is done** they are blocked too (2026-09-15, user's decision — the ship track used
   *      to be the exception, so the `messenger` · `ravenQuest` steps waited for Raven's first contact, and those
   *      steps then dropped out of the order). 「done」 means completed or skipped alike.
   * So the first time Raven writes is the **first `evaluate` after the ship track with no track running** — on the
   * spot if the build track is skipped (every `NPC_OFFER_CHECK_S`), at the `hub:entered` back from the first raid
   * if it is completed. (Raven is the only NPC whose requirements are met by then — see `reqFlag` · `reqQuests` in
   * `data/npcs.csv`.)
   * A profile from before the tutorial existed, or one that already finished it, has `isTrackDone('ship')` true and
   * is contacted exactly as before (with no track record in the save the answer comes from 「is this an untouched
   * ship?」 — `tutorial/TutorialSystem.isTrackDone`).
   */
  private tutorialBlocks(): boolean {
    const t = this.ctx.tutorial;
    if (!t) return false;
    if (t.active) return true;
    return typeof t.isTrackDone === 'function' && !t.isTrackDone('ship');
  }

  /**
   * That NPC **has not answered the first contact's choices** yet (2026-09-14 3rd pass). On a row with `introAfter`
   * the main point comes after the choices, so offering a quest before the answer drops the card straight after
   * the greeting.
   *
   * ⚠ What it blocks is that NPC's **first offer alone** — once any quest exists (whatever its state) the moment of
   * first contact has passed, so it is let through. Otherwise it would block **forever** in two places:
   *   ① An old save contacted back when `introChoices` did not exist (`intro` only, no `choice`) — that NPC's whole
   *      chain would stop. The messenger puts the choices up now, so answering releases it, and not answering never
   *      blocks it either.
   *   ② A quest planted past first contact, as the console's · a smoke test's `forceOffer` does.
   */
  private introPending(npc: NpcDef): boolean {
    if (!npc.introAfter?.length) return false;
    const save = this.save;
    if (NPC_QUEST_DEFS.some((q) => q.npc === npc.id && save.quests[q.id])) return false;
    return !(save.log[npc.id] ?? []).some((e) => e.e === 'choice');
  }

  /**
   * First contact for every NPC whose requirements are met, plus one next offer per NPC. In the ship only (the
   * tutorial · the training range excluded). True when anything was added.
   */
  evaluate(): boolean {
    const ctx = this.ctx;
    if (!ctx || this.evaluating || !this.sys.inShip || this.sys.inTraining() || this.tutorialBlocks()) return false;
    this.evaluating = true;
    let changed = false;
    try {
      const rc = this.reqCtx();
      const save = this.save;
      for (const npc of NPC_DEFS) {
        if (!save.contacts[npc.id]) {
          if (!requirementMet(npc.requires, rc)) continue;
          save.contacts[npc.id] = { at: Date.now(), readAt: 0 };
          this.log(npc.id, 'intro');
          changed = true;
        }
        // 2026-09-14 3rd pass: neither the main point nor an offer arrives before the choices are answered
        if (this.introPending(npc)) continue;
        if (NPC_QUEST_DEFS.some((q) => q.npc === npc.id && save.quests[q.id]?.s === 'offered')) continue;
        const next = NPC_QUEST_DEFS.find((q) => q.npc === npc.id && !save.quests[q.id] && requirementMet(q.requires, rc));
        if (!next) continue;
        this.offer(next);
        changed = true;
      }
    } finally { this.evaluating = false; }
    if (changed) { this.sys.store.markDirty(); this.emitUnread(); }
    return changed;
  }

  private offer(def: NpcQuestDef): void {
    this.save.quests[def.id] = { s: 'offered', at: Date.now(), p: def.objectives.map(() => 0) };
    this.log(def.npc, 'offer', def.id);
    this.ctx.bus.emit('npc:questChanged', { id: def.id, npc: def.npc, state: 'offered', prev: null });
  }

  /* ── Console · smoke tests ────────────────────────────────────────────── */

  /** First contact, ignoring the requirements. False when contact has already been made. */
  forceContact(npcId: string): boolean {
    if (!NPC_DEF_MAP.has(npcId) || this.save.contacts[npcId]) return false;
    this.save.contacts[npcId] = { at: Date.now(), readAt: 0 };
    this.log(npcId, 'intro');
    this.emitUnread();
    return true;
  }

  /** An offer, ignoring the requirements (contact first when there is none). False when a state already exists. */
  forceOffer(questId: string): boolean {
    const def = NPC_QUEST_MAP.get(questId);
    if (!def || this.save.quests[questId]) return false;
    this.forceContact(def.npc);
    this.offer(def);
    this.sys.store.markDirty();
    this.emitUnread();
    return true;
  }

  /**
   * Dev only: sets an objective's progress to `n` — a delivery goes into the confirmed progress, a raid objective
   * into this raid's progress plus a confirm attempt (`recover` is read as extracted).
   */
  devProgress(questId: string, index: number, n: number): boolean {
    const def = NPC_QUEST_MAP.get(questId);
    const s = this.save.quests[questId];
    const o = def?.objectives[index];
    if (!def || !s || s.s !== 'active' || !o) return false;
    const v = Math.max(0, Math.min(o.target, Math.floor(n)));
    if (!NPC_RAID_OBJECTIVE_KINDS.has(o.kind)) {
      const before = s.p[index] ?? 0;
      s.p[index] = v;
      this.sys.store.markDirty();
      this.ctx.bus.emit('npc:objectiveProgress', { questId, index, progress: v, target: o.target, done: v >= o.target, delta: v - before, raid: false });
      this.checkReady(def, s);
      return true;
    }
    const rp = this.raidProgress.get(questId) ?? def.objectives.map(() => 0);
    this.raidProgress.set(questId, rp);
    rp[index] = v;
    Obj.tryConfirm(this, def, s, index, true);
    return true;
  }

  /** Clears everything (`resetMeta` · the console). The caller has already made the save data fresh. */
  reset(): void {
    this.raidProgress.clear();
    this.searched.clear();
    this.discovered.clear();
    this.reportBlocked.clear();
    this.lastStamp = 0;
    this.emitUnread(true);
  }

  /* ── NpcQuestRef: the conversation ────────────────────────────────────── */

  getContacts(): readonly NpcContactInfo[] {
    const out: NpcContactInfo[] = [];
    for (const [id, c] of Object.entries(this.save.contacts)) {
      const npc = NPC_DEF_MAP.get(id);
      if (!npc) continue;
      const list = this.save.log[id] ?? [];
      const last = list[list.length - 1];
      const msgs = last ? this.resolve(npc, [last]) : [];
      const lm = msgs[msgs.length - 1];
      out.push({ npc, at: last?.at ?? c.at, unread: list.filter((e) => e.at > c.readAt).length, preview: lm ? this.previewOf(lm) : npc.bio });
    }
    return out.sort((a, b) => b.at - a.at);
  }

  getMessages(npcId: string): readonly NpcMessage[] {
    const npc = NPC_DEF_MAP.get(npcId);
    return npc ? this.resolve(npc, this.save.log[npcId] ?? []) : [];
  }

  markRead(npcId: string): void {
    const c = this.save.contacts[npcId];
    if (!c) return;
    let last = 0;
    for (const e of this.save.log[npcId] ?? []) if (e.at > last) last = e.at;
    if (c.readAt >= last) return;
    c.readAt = last;
    this.sys.store.markDirty();
    this.emitUnread();
  }

  /**
   * 2026-09-15 (user's decision — 「확인해야 다음 메시지가 온다」): when it was last read. It is only a **query** that
   * hands back a saved fact (`contacts[id].readAt`), so not one line of the log, the save or `npc:unreadChanged`
   * changes — the messenger has to know 「how far the bubbles have already been read」 to type out the rest with `...`.
   */
  readAtOf(npcId: string): number {
    const at = this.save.contacts[npcId]?.readAt ?? 0;
    return Number.isFinite(at) ? Math.max(0, at) : 0;
  }

  get unreadTotal(): number {
    let n = 0;
    for (const [id, c] of Object.entries(this.save.contacts)) for (const e of this.save.log[id] ?? []) if (e.at > c.readAt) n++;
    return n;
  }

  /* ── Dialogue choices (2026-09-14, `docs/DECISIONS.md` 「2026-09-14 — 튜토리얼 개편」) ────
   * Since the 2026-09-14 3rd pass **all 10 NPCs** have choices. The conversation waits where it is until one is
   * picked (neither the main point `introAfter` nor a quest offer arrives), and picking leaves a single event
   * (`choice`) from which my answer · the NPC's reply · the main point are all resolved at once.
   * **No branch is kept.** */

  getPendingChoices(npcId: string): readonly string[] {
    const npc = NPC_DEF_MAP.get(npcId);
    if (!npc?.introChoices?.length) return [];
    const list = this.save.log[npcId] ?? [];
    if (!list.some((e) => e.e === 'intro')) return [];          // first contact has not arrived yet
    if (list.some((e) => e.e === 'choice')) return [];          // already picked
    return npc.introChoices;
  }

  chooseIntro(npcId: string, index: number): boolean {
    const choices = this.getPendingChoices(npcId);
    if (index < 0 || index >= choices.length) return false;
    this.log(npcId, 'choice', undefined, index);
    // 2026-09-14 3rd pass: an NPC that has spoken the main point (`introAfter`) may now offer —
    // the card arrives right where the answer was given
    this.evaluate();
    this.emitUnread();
    return true;
  }

  private resolve(npc: NpcDef, entries: readonly NpcLogEntry[]): NpcMessage[] {
    const out: NpcMessage[] = [];
    const say = (at: number, lines: readonly string[]): void => { for (const text of lines) out.push({ at, from: 'npc', text }); };
    for (const en of entries) {
      if (en.e === 'intro') { say(en.at, npc.intro); continue; }
      /* 2026-09-14 (dialogue choices): an event with no quest, so it is resolved ahead of the `q` check. One line
       * for the label picked + the NPC's reply +, since the 2026-09-14 3rd pass, the **main point**
       * (`introAfter`) after it — first contact has three steps: the greeting → the choices → the main point. */
      if (en.e === 'choice') {
        const i = en.c ?? -1;
        const label = npc.introChoices?.[i];
        if (label) {
          out.push({ at: en.at, from: 'me', text: label });
          const reply = npc.introChoiceReplies?.[i];
          if (reply) say(en.at, [reply]);
          say(en.at, npc.introAfter ?? []);
        }
        continue;
      }
      const q = en.q ? NPC_QUEST_MAP.get(en.q) : undefined;
      if (!q) continue;
      switch (en.e) {
        case 'offer': say(en.at, q.lines.offer); out.push({ at: en.at, from: 'quest', questId: q.id }); break;
        case 'accept': out.push({ at: en.at, from: 'me', text: NPC_REPLY_KO.accept }); say(en.at, q.lines.accept); break;
        case 'decline': out.push({ at: en.at, from: 'me', text: NPC_REPLY_KO.decline }); say(en.at, q.lines.decline); break;
        case 'brief': out.push({ at: en.at, from: 'me', text: NPC_REPLY_KO.brief }); say(en.at, q.lines.brief); break;
        case 'complete': {
          out.push({ at: en.at, from: 'me', text: NPC_REPLY_KO.complete });
          say(en.at, q.lines.complete);
          const summary = rewardSummary(q, this.itemName);
          if (summary) out.push({ at: en.at, from: 'system', text: `보상 — ${summary}` });
          break;
        }
      }
    }
    return out;
  }

  private previewOf(m: NpcMessage): string {
    if (m.from === 'quest') return `[퀘스트] ${NPC_QUEST_MAP.get(m.questId)?.name ?? m.questId}`;
    return m.from === 'me' ? `나: ${m.text}` : m.text;
  }

  /* ── NpcQuestRef: quests ──────────────────────────────────────────────── */

  /**
   * 2026-09-14 3rd pass (user's decision): **quests taken only** — `offered` · `deferred` drop out. An offer shows
   * up only as a quest card in the chat, and the list keeps the active and the complete ones alone. `getQuest(id)`,
   * which the card reads, answers regardless of the state.
   */
  getQuests(): readonly NpcQuestInfo[] {
    const out: NpcQuestInfo[] = [];
    for (const [id, s] of Object.entries(this.save.quests)) {
      if (s.s === 'offered' || s.s === 'deferred') continue;
      const def = NPC_QUEST_MAP.get(id);
      if (def) out.push(this.info(def, s));
    }
    return out.sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || b.at - a.at);
  }

  getQuest(id: string): NpcQuestInfo | null {
    const def = NPC_QUEST_MAP.get(id);
    const s = this.save.quests[id];
    return def && s ? this.info(def, s) : null;
  }

  /** `MetaRef.getQuestState` — answers from the saved state even with no def (a smoke test · an old document). */
  questState(id: string): QuestState {
    return legacyQuestState(this.save.quests[id]?.s);
  }

  getRaidTracks(): readonly NpcQuestInfo[] {
    if (!this.counting()) return [];
    return this.getQuests().filter((q) => q.state === 'active' && q.objectives.some((o) => o.countsHere));
  }

  private info(def: NpcQuestDef, s: NpcQuestSave): NpcQuestInfo {
    const npc: NpcDef = NPC_DEF_MAP.get(def.npc) ?? {
      id: def.npc, name: def.npc, title: '', corp: null, role: 'independent', color: '#9aa4b2', glyph: '?', requires: {}, intro: [], bio: '', order: 0,
    };
    const counting = this.counting();
    const rp = this.raidProgress.get(def.id);
    const seed = counting ? raidFoundSeed(this.ctx) : null;
    const inShip = this.sys.inShip;
    const objectives: NpcObjectiveInfo[] = def.objectives.map((o, i) => {
      const target = o.target;
      const done = (s.p[i] ?? 0) >= target;
      const raid = NPC_RAID_OBJECTIVE_KINDS.has(o.kind);
      const countsHere = raid && s.s === 'active' && !done && counting && this.planetOk(o);
      const label = objectiveLabel(o, this.itemName);
      if (raid) {
        const progress = done ? target : !countsHere ? 0
          : o.kind === 'recover' ? Math.min(target, this.carried(o.item, seed)) : Math.min(target, rp?.[i] ?? 0);
        return { def: o, label, progress, target, done, raid, countsHere, blocked: null };
      }
      const have = this.haveCount(o.item);
      const blocked = done ? NPC_REASON.done : s.s !== 'active' ? NPC_REASON.notActive : !inShip ? NPC_REASON.shipOnly : have <= 0 ? NPC_REASON.missing : null;
      return { def: o, label, progress: Math.min(target, s.p[i] ?? 0), target, done, raid, countsHere: false, have, blocked };
    });
    const ready = s.s === 'active' && objectives.every((o) => o.done);
    const blocked = s.s === 'complete' ? NPC_REASON.done : s.s !== 'active' ? NPC_REASON.notActive : !ready ? NPC_REASON.unfinished
      : !inShip ? NPC_REASON.shipOnly : this.reportBlocked.get(def.id) ?? null;
    const progress = objectives.length ? objectives.reduce((a, o) => a + Math.min(1, o.progress / Math.max(1, o.target)), 0) / objectives.length : 0;
    return { def, npc, state: s.s, at: s.at, objectives, ready, blocked, progress };
  }

  accept(id: string): boolean {
    const def = NPC_QUEST_MAP.get(id);
    const s = this.save.quests[id];
    if (!def || !s || !this.sys.inShip || (s.s !== 'offered' && s.s !== 'deferred')) return false;
    const prev = s.s;
    s.s = 'active';
    s.at = Date.now();
    if (s.p.length !== def.objectives.length) s.p = def.objectives.map((_, i) => s.p[i] ?? 0);
    this.log(def.npc, prev === 'deferred' ? 'brief' : 'accept', id);
    this.sys.store.markDirty();
    this.ctx.bus.emit('npc:questChanged', { id, npc: def.npc, state: 'active', prev });
    this.checkReady(def, s);
    this.evaluate();
    this.emitUnread();
    return true;
  }

  /**
   * ⚠ **Retired** (2026-09-14 3rd pass, user's decision — 「생각해보지」 removed). It does nothing and is always
   * false: no path into the `deferred` state and no new `decline` entry is written any more. An old save's
   * `deferred` still reads (`accept` takes it as `brief`) and old `decline` · `brief` entries still resolve — they
   * simply never appear again.
   */
  defer(_id: string): boolean { return false; }

  deliver(questId: string, index: number): number {
    const def = NPC_QUEST_MAP.get(questId);
    const s = this.save.quests[questId];
    const o = def?.objectives[index];
    const inv = this.ctx.inventory;
    if (!def || !s || !o || o.kind !== 'deliver' || s.s !== 'active' || !this.sys.inShip || !inv || typeof inv.consumeDefAll !== 'function') return 0;
    const before = Math.min(o.target, s.p[index] ?? 0);
    let left = o.target - before;
    if (left <= 0) return 0;
    let taken = 0;
    for (const d of this.defsFor(o.item)) {
      if (left <= 0) break;
      const have = Math.max(0, inv.countDefAll(d.id));
      const n = Math.min(have, left);
      if (n > 0 && inv.consumeDefAll(d.id, n)) { taken += n; left -= n; }
    }
    if (taken <= 0) return 0;
    s.p[index] = before + taken;
    this.sys.store.markDirty();
    commitQuestTx(this.sys);
    const done = s.p[index] >= o.target;
    this.ctx.bus.emit('npc:objectiveProgress', { questId, index, progress: s.p[index], target: o.target, done, delta: taken, raid: false });
    if (done) this.checkReady(def, s);
    return taken;
  }

  report(id: string): boolean {
    const def = NPC_QUEST_MAP.get(id);
    const s = this.save.quests[id];
    if (!def || !s || s.s !== 'active' || !this.sys.inShip) return false;
    if (!def.objectives.every((o, i) => (s.p[i] ?? 0) >= o.target)) return false;
    const loot = this.ctx.loot;
    // The reward items first — if any does not fit, the placed ones are taken back and nothing changes
    const placed: ItemInstance[] = [];
    for (const r of def.rewards.items) {
      const rdef = loot?.getItemDef(r.defId);
      if (!loot || !rdef) continue;   // unknown reward id → skip (must not block the chain — data:check catches it)
      let left = Math.max(1, Math.floor(r.qty));
      while (left > 0) {
        const n = Math.min(Math.max(1, rdef.stackMax), left);
        const item = loot.createItem(r.defId, n);
        if (!this.sys.addAnywhere(item)) {
          for (const p of placed) this.sys.takeBack(p.uid);
          this.reportBlocked.set(id, NPC_REASON.space);
          return false;
        }
        placed.push(item);
        left -= n;
      }
    }
    this.reportBlocked.delete(id);
    s.s = 'complete';
    s.at = Date.now();
    const data = this.sys.store.data;
    data.stats.questsDone += 1;
    if (def.rewards.credits > 0) {
      // server ledger: once per quest id
      this.sys.addCredits(def.rewards.credits, formatCreditReason({ kind: 'quest', id }));
      data.stats.creditsEarned += def.rewards.credits;
    }
    for (const r of def.rewards.rep) if (r.amount > 0) this.sys.addRep(r.corp, r.amount, `quest:${id}`);
    /* 2026-09-14: per-NPC trust is granted **in the same place** as corp reputation — neither replaces the other.
     * It is not credits, so no server validation applies (it never goes through `credits:tx`), and an unaffiliated
     * NPC gives only this. */
    if (def.rewards.npcTrust > 0) this.addTrust(def.npc, def.rewards.npcTrust, npcTrustReason(id));
    const prog = this.ctx.progression;
    if (def.rewards.xp > 0 && prog && typeof prog.addXp === 'function') { try { prog.addXp(def.rewards.xp); } catch { /* progression not ready */ } }
    this.log(def.npc, 'complete', id);
    this.sys.store.markDirty();
    commitQuestTx(this.sys);
    this.ctx.bus.emit('npc:questChanged', { id, npc: def.npc, state: 'complete', prev: 'active' });
    this.evaluate();
    this.emitUnread();
    return true;
  }

  /** Raid settlement — `MetaSystem.settleMission` calls it before the contract settles. */
  settleRaid(stats: MissionStats | null | undefined): void { Obj.settleRaid(this, stats); }
}
