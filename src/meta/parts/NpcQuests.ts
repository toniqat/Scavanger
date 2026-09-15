/**
 * src/meta/parts/NpcQuests.ts — **`ctx.meta.npc`**: NPC 연락 · 대화 · 퀘스트 (2026-09-14, docs/DECISIONS.md 「2026-09-14 — 메신저 · NPC 퀘스트 · 단체방」).
 *
 * 기업 퀘스트를 대신한다. NPC 는 **함선에서만** 연락하고(`evaluate` — 함선 진입 · 프로필 로드 · 레벨 · 신뢰도 · 퀘스트 완료 ·
 * `NPC_OFFER_CHECK_S` 주기), 조건(`npcs.csv` 의 req*)이 맞으면 첫 연락(intro), 그 NPC 에 대기 중인 제안이 없으면 파일 줄
 * 순서대로 다음 퀘스트 하나를 제안한다(offer). 대화 기록은 **사건만** 저장하고(`NpcLogEntry`) 글은 표에서 다시 푼다.
 *
 *   offered ─[수락]→ active ─(목표 전부)─[완료 보고]→ complete
 *
 * 2026-09-14 3차 (사용자 결정, docs/DECISIONS.md 「2026-09-14 — NPC 첫 연락 3단」):
 *   • **첫 연락은 3단이다** — `intro`(인사) → 선택지(`introChoices`) → `introAfter`(본론). `introAfter` 가 있는 NPC 는
 *     **선택지에 답하기 전에는 퀘스트를 제안하지 않는다**(`evaluate`); 답하면 `chooseIntro` 가 그 자리에서 제안을 부른다.
 *   • **「생각해보지」는 없다** — `defer()` 는 늘 false 이고 `decline` 로그를 새로 만들지 않는다. `deferred` 상태와
 *     `decline` · `brief` 대사는 옛 세이브 · 옛 기록을 읽기 위해서만 남는다.
 *   • **퀘스트 목록에는 받은 것만** — `getQuests()` 가 `offered` · `deferred` 를 걸러낸다 (제안은 대화창 카드로만 뜬다).
 *
 * 포기는 없다(사용자 결정). 납품은 나눠서(`deliver` — 가방 + 창고), 보고는 보상 아이템을 먼저 넣어 보고(`공간 없음` 이면 아무것도
 * 안 바뀐다) 크레딧 `quest:<id>` → 신뢰도(기업 + **그 NPC 개인**) → 경험치 순. 레이드 목표는 `parts/NpcObjectives.ts`.
 */
import type {
  GameContext, ItemDef, ItemInstance, MissionStats, NpcContactInfo, NpcDef, NpcFlag, NpcLogEntry, NpcLogEvent, NpcMessage, NpcObjectiveDef,
  NpcObjectiveInfo, NpcQuestDef, NpcQuestInfo, NpcQuestRef, NpcQuestSave, NpcQuestState, NpcSave, QuestState, WeaponClass,
} from '@/shared';
import {
  NPC_DEFS, NPC_DEF_MAP, NPC_LOG_MAX, NPC_OFFER_CHECK_S, NPC_QUEST_DEFS, NPC_QUEST_MAP, NPC_RAID_OBJECTIVE_KINDS, NPC_REPLY_KO,
  formatCreditReason, isRaidFound, raidFoundSeed,
  /* 2026-09-14: NPC 개인 신뢰도 — 기업과 같은 REP_TABLE 을 쓴다 */
  repLevelOf,
  /* 2026-09-14 3차: 튜토리얼 ship 트랙(`messenger` · `ravenQuest`)은 레이븐의 첫 연락을 기다린다 */
  tutorialTrackOf,
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
  /** 이번 레이드의 확정 전 진행 — 퀘스트 id → 목표별 수. 레이드가 끝나면 비운다 (`NpcObjectives.resetRaid`). */
  readonly raidProgress = new Map<string, number[]>();
  /** 이번 레이드에 이미 센 컨테이너 id (조사 목표). */
  readonly searched = new Set<string>();
  /** 이번 레이드에 이미 센 구조물 id (발견 목표). */
  readonly discovered = new Set<string>();
  /** 마지막 [완료 보고] 가 공간 부족으로 실패한 퀘스트 → 사유. */
  readonly reportBlocked = new Map<string, string>();
  private lastStamp = 0;
  private checkT = 0;
  private lastUnreadSent = -1;
  private evaluating = false;

  constructor(readonly sys: MetaSystem) {}

  get ctx(): GameContext { return this.sys.ctx; }

  /** 지금 저장 (`MetaSave.npc`) — `MetaStorage.replace` 가 데이터 객체를 갈아 끼우므로 매번 읽는다. */
  get save(): NpcSave {
    const d = this.sys.store.data;
    return d.npc ?? (d.npc = freshNpcSave());
  }

  /* ── NPC 개인 신뢰도 (2026-09-14, docs/DECISIONS.md 「2026-09-14 — 정보상」) ──────────
   * 기업 신뢰도와 **별개**이고 같은 `REP_TABLE` 을 쓴다 (사용자 결정 — 표를 하나 더 만들 이유가 없다).
   * 지금은 적립 · 표시까지만이라 이 값으로 잠기는 것은 없다; `NpcRequirement.npcRep` 계약은 이미 있다. */

  /** 누적 신뢰도 점수 (없으면 0). */
  trustOf(npcId: string): number {
    const t = this.save.trust;
    return Math.max(0, Math.round(t?.[npcId] ?? 0));
  }

  /** 0–5. 기업과 같은 `REP_TABLE`. */
  trustLevelOf(npcId: string): number { return repLevelOf(this.trustOf(npcId)); }

  /* ── 진행 플래그 (2026-09-14 3차) — `NpcRequirement.flags` 의 유일한 입력 ──────
   * 세는 곳도 읽는 곳도 여기 하나다. 값이 오르면 그 자리에서 연락 조건을 다시 본다
   * (`evaluate` 는 함선에서만 붙이므로 레이드 중에 올라간 플래그는 함선에 들어설 때 반영된다). */

  /** 그 플래그의 누적 횟수 (없으면 0). */
  flagOf(flag: NpcFlag): number {
    return Math.max(0, Math.round(this.save.flags?.[flag] ?? 0));
  }

  /** 누적 횟수를 더한다 (0 이하는 무시). */
  bumpFlag(flag: NpcFlag, delta = 1): void {
    const d = Math.round(delta);
    if (!Number.isFinite(d) || d <= 0) return;
    const save = this.save;
    const flags = save.flags ?? (save.flags = {});
    flags[flag] = this.flagOf(flag) + d;
    this.sys.store.markDirty();
    this.evaluate();
  }

  /** 더한다 (0 밑으로는 안 내려간다). 레벨이 오르면 `levelUp` 이 실린다 — 토스트는 받는 쪽이 정한다. */
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

  /** `MetaSystem.init` 이 부른다 — 반환된 해제 함수들은 시스템의 `unsubs` 에 들어간다. */
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
      /* 2026-09-14 3차: 살아 돌아온 레이드 · 캔 채집물이 NPC 첫 연락 조건이다 (`NpcRequirement.flags`).
       * **진짜 레이드만 센다** — 튜토리얼 · 훈련장이 `raidReturned` 를 올리면 튜토리얼을 끝내자마자 차유나가 연락해
       * 「튜토리얼 직후 연락 오는 NPC 는 레이븐 하나」라는 결정이 깨진다. */
      b.on('game:complete', () => { Obj.resetRaid(this); if (this.ctx.missionMode === 'raid') this.bumpFlag('raidReturned'); }),
      b.on('gather:collected', () => this.bumpFlag('gathered')),
      b.on('game:over', () => Obj.resetRaid(this)),
      b.on('game:abort', () => Obj.resetRaid(this)),
      // 내 막타만 (계약과 같은 규칙 — 분대원의 킬은 `enemy:squadKill` 로 따로 온다)
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

  /* ── 판정 도우미 (NpcObjectives 도 쓴다) ─────────────────────────────────── */

  /** 레이드 목표를 세는 때 — 레이드 중(강하 포함) · 훈련장 아님. */
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

  /** 몸(가방 · 퀵슬롯 · 주머니)에 지닌, 레이드 `seed` 에서 얻은 `spec` 수. */
  carried(spec: string | undefined, seed: number | null): number {
    const inv = this.ctx.inventory;
    if (!spec || seed === null || !inv || typeof inv.countWhere !== 'function') return 0;
    try { return Math.max(0, Math.floor(inv.countWhere((d, inst) => itemMatches(spec, d, this.classOf) && isRaidFound(inst, seed)))); } catch { return 0; }
  }

  /** `spec` 에 해당하는 아이템 def 들 (아이템 id 면 그 하나). */
  private defsFor(spec: string | undefined): ItemDef[] {
    if (!spec) return [];
    if (!weaponSpecClass(spec)) { const d = this.sys.itemDef(spec); return d ? [d] : []; }
    const all = this.ctx.loot?.getAllItemDefs?.() ?? [];
    return all.filter((d) => itemMatches(spec, d, this.classOf));
  }

  /** 가방 + 창고 보유 수 (납품). */
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

  /* ── 기록 ─────────────────────────────────────────────────────────────── */

  /** 기록 순서가 흐트러지지 않는 시각 (한 번에 여러 사건이 붙어도 오름차순). */
  private stamp(): number {
    if (this.lastStamp === 0) for (const list of Object.values(this.save.log)) for (const e of list) if (e.at > this.lastStamp) this.lastStamp = e.at;
    this.lastStamp = Math.max(Date.now(), this.lastStamp + 1);
    return this.lastStamp;
  }

  /** `c` 는 `choice` 전용 — 고른 선택지 번호 (2026-09-14). */
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

  /* ── 연락 · 제안 ──────────────────────────────────────────────────────── */

  /**
   * 튜토리얼이 연락 · 제안을 막는가. 막는 것이 기본이지만 **ship 트랙만 예외**다 (2026-09-14 3차) —
   * 그 트랙의 `messenger` · `ravenQuest` 단계가 바로 레이븐의 첫 연락과 그 퀘스트 수락을 기다린다.
   * (그 시점에 조건이 맞는 NPC 는 레이븐 하나다 — `data/npcs.csv` 의 `reqFlag` · `reqQuests` 참고.)
   */
  private tutorialBlocks(): boolean {
    const t = this.ctx.tutorial;
    if (!t?.active) return false;
    return !(t.step && tutorialTrackOf(t.step) === 'ship');
  }

  /**
   * 그 NPC 가 아직 첫 연락의 **선택지에 답하지 않았다** (2026-09-14 3차). `introAfter` 가 있는 줄은 본론이 선택지 뒤에
   * 오므로, 답하기 전에 퀘스트를 제안하면 인사 다음에 곧장 카드가 떨어진다.
   *
   * ⚠ 막는 것은 그 NPC 의 **첫 제안 하나**뿐이다 — 이미 퀘스트가 하나라도 있으면(상태 무관) 첫 연락의 순간은
   * 지나간 것이므로 통과시킨다. 그러지 않으면 두 자리에서 **영영 막힌다**:
   *   ① `introChoices` 가 없던 시절에 연락이 온 옛 세이브 (`intro` 만 있고 `choice` 가 없다) — 그 NPC 의 체인이
   *      통째로 멈춘다. 지금은 메신저가 선택지를 띄워 주므로 답하면 풀리지만, 답하지 않아도 막히지는 않는다.
   *   ② 콘솔 · 스모크의 `forceOffer` 처럼 첫 연락을 건너뛰고 심은 퀘스트.
   */
  private introPending(npc: NpcDef): boolean {
    if (!npc.introAfter?.length) return false;
    const save = this.save;
    if (NPC_QUEST_DEFS.some((q) => q.npc === npc.id && save.quests[q.id])) return false;
    return !(save.log[npc.id] ?? []).some((e) => e.e === 'choice');
  }

  /** 조건이 맞은 NPC 의 첫 연락 + NPC 마다 다음 제안 하나. 함선에서만(튜토리얼 · 훈련장 제외). 무언가 붙었으면 true. */
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
        // 2026-09-14 3차: 선택지에 답하기 전에는 본론도 제안도 오지 않는다
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

  /* ── 콘솔 · 스모크 ────────────────────────────────────────────────────── */

  /** 조건을 무시하고 첫 연락. 이미 연락했으면 false. */
  forceContact(npcId: string): boolean {
    if (!NPC_DEF_MAP.has(npcId) || this.save.contacts[npcId]) return false;
    this.save.contacts[npcId] = { at: Date.now(), readAt: 0 };
    this.log(npcId, 'intro');
    this.emitUnread();
    return true;
  }

  /** 조건을 무시하고 제안 (연락이 없으면 연락부터). 이미 상태가 있으면 false. */
  forceOffer(questId: string): boolean {
    const def = NPC_QUEST_MAP.get(questId);
    if (!def || this.save.quests[questId]) return false;
    this.forceContact(def.npc);
    this.offer(def);
    this.sys.store.markDirty();
    this.emitUnread();
    return true;
  }

  /** 개발용: 목표 진행을 `n` 으로 — 납품은 확정 진행, 레이드 목표는 이번 레이드 진행 + 확정 시도(회수는 탈출로 본다). */
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

  /** 전부 지운다 (`resetMeta` · 콘솔). 저장 데이터는 호출자가 이미 새로 만들었다. */
  reset(): void {
    this.raidProgress.clear();
    this.searched.clear();
    this.discovered.clear();
    this.reportBlocked.clear();
    this.lastStamp = 0;
    this.emitUnread(true);
  }

  /* ── NpcQuestRef: 대화 ────────────────────────────────────────────────── */

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
   * 2026-09-15 (사용자 결정 — 「확인해야 다음 메시지가 온다」): 마지막으로 읽은 시각. 저장된 사실(`contacts[id].readAt`)을
   * 그대로 돌려주는 **질의**일 뿐이라 기록 · 저장 · `npc:unreadChanged` 는 한 줄도 바뀌지 않는다 —
   * 메신저가 「어디까지가 이미 읽은 말풍선인가」를 알아야 그 뒤부터 `...` 로 풀 수 있다.
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

  /* ── 대사 선택지 (2026-09-14, `docs/DECISIONS.md` 「2026-09-14 — 튜토리얼 개편」) ──────────────
   * 2026-09-14 3차부터 **NPC 10명 전부**가 선택지를 갖는다. 고르기 전까지 대화가 그 자리에서 기다리고
   * (본론 `introAfter` 도 퀘스트 제안도 오지 않는다), 고르면 사건 하나(`choice`)가 남아 내 대답 · NPC 의 답 ·
   * 본론이 한꺼번에 붙는다. **분기는 남지 않는다.** */

  getPendingChoices(npcId: string): readonly string[] {
    const npc = NPC_DEF_MAP.get(npcId);
    if (!npc?.introChoices?.length) return [];
    const list = this.save.log[npcId] ?? [];
    if (!list.some((e) => e.e === 'intro')) return [];          // 아직 첫 연락이 오지 않았다
    if (list.some((e) => e.e === 'choice')) return [];          // 이미 골랐다
    return npc.introChoices;
  }

  chooseIntro(npcId: string, index: number): boolean {
    const choices = this.getPendingChoices(npcId);
    if (index < 0 || index >= choices.length) return false;
    this.log(npcId, 'choice', undefined, index);
    // 2026-09-14 3차: 본론(`introAfter`)까지 말한 NPC 는 이제 제안할 수 있다 — 답한 자리에서 바로 카드가 온다
    this.evaluate();
    this.emitUnread();
    return true;
  }

  private resolve(npc: NpcDef, entries: readonly NpcLogEntry[]): NpcMessage[] {
    const out: NpcMessage[] = [];
    const say = (at: number, lines: readonly string[]): void => { for (const text of lines) out.push({ at, from: 'npc', text }); };
    for (const en of entries) {
      if (en.e === 'intro') { say(en.at, npc.intro); continue; }
      /* 2026-09-14 (대사 선택지): 퀘스트가 없는 사건이라 `q` 검사 앞에서 푼다. 고른 라벨 한 줄 + NPC 의 답 +
       * 2026-09-14 3차부터 그 뒤의 **본론**(`introAfter`) — 첫 연락은 인사 → 선택지 → 본론 3단이다. */
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

  /* ── NpcQuestRef: 퀘스트 ──────────────────────────────────────────────── */

  /**
   * 2026-09-14 3차 (사용자 결정): **받은 퀘스트만** — `offered` · `deferred` 는 빠진다. 제안은 대화창의 퀘스트
   * 카드로만 뜨고 목록에는 진행 중 · 완료만 남는다. 카드가 읽는 `getQuest(id)` 는 상태와 무관하게 그대로 답한다.
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

  /** `MetaRef.getQuestState` — 정의가 없어도 저장된 상태로 답한다 (스모크 · 옛 문서). */
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
   * ⚠ **은퇴** (2026-09-14 3차, 사용자 결정 — 「생각해보지」 제거). 아무것도 하지 않고 늘 false 다:
   * `deferred` 상태로 가는 길도, 새 `decline` 로그도 더는 만들지 않는다. 옛 세이브의 `deferred` 는 그대로 읽히고
   * (`accept` 가 `brief` 로 받아 준다) 옛 `decline` · `brief` 기록도 그대로 풀린다 — 새로 생기지 않을 뿐이다.
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
    // 보상 아이템부터 — 하나라도 안 들어가면 넣은 것을 되돌리고 아무것도 바꾸지 않는다
    const placed: ItemInstance[] = [];
    for (const r of def.rewards.items) {
      const rdef = loot?.getItemDef(r.defId);
      if (!loot || !rdef) continue;   // 모르는 보상 id 는 건너뛴다 (사슬을 막지 않는다 — data:check 가 잡는다)
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
      this.sys.addCredits(def.rewards.credits, formatCreditReason({ kind: 'quest', id }));   // 서버 원장: 퀘스트 id 당 한 번
      data.stats.creditsEarned += def.rewards.credits;
    }
    for (const r of def.rewards.rep) if (r.amount > 0) this.sys.addRep(r.corp, r.amount, `quest:${id}`);
    /* 2026-09-14: 기업 신뢰도와 **같은 자리**에서 그 NPC 의 개인 신뢰도도 준다 — 서로를 대신하지 않는다.
     * 크레딧이 아니라 서버 검증과 무관하고 (`credits:tx` 를 타지 않는다), 무소속 NPC 는 이것만 받는다. */
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

  /** 레이드 정산 — `MetaSystem.settleMission` 이 계약 정산 전에 부른다. */
  settleRaid(stats: MissionStats | null | undefined): void { Obj.settleRaid(this, stats); }
}
