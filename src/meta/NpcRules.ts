/**
 * src/meta/NpcRules.ts — the **pure rules** of NPC quests
 * (2026-09-14).
 *
 * Without ctx or DOM: the requirement check (`requirementMet`), kill target · item matching (`enemyMatches` ·
 * `itemMatches`), the Korean objective label (`objectiveLabel`) · the reward summary (`rewardSummary`), tidying the
 * save shape (`freshNpcSave` · `sanitizeNpcSave`), and the mapping onto the old `QuestState`.
 * The state is held by `parts/NpcQuests.ts` (offers · conversation · accept · delivery · the report) and
 * `parts/NpcObjectives.ts` (raid objectives).
 */
import type {
  CorpId, ItemDef, NpcEnemyGroup, NpcFlag, NpcInteractKind, NpcLogEntry, NpcLogEvent, NpcObjectiveDef, NpcQuestDef, NpcQuestSave,
  NpcQuestState, NpcRequirement, NpcSave, QuestState, WeaponClass,
} from '@/shared';
import {
  CORP_DEFS, NAMED_ROGUE_NAME_KO, NAMED_ROGUE_TYPES, NPC_DEF_MAP, NPC_FLAGS, NPC_ITEM_WEAPON_PREFIX, NPC_LOG_MAX, NPC_QUEST_MAP,
  STRUCTURE_LABEL_KO, csvRows, formatCompactSigned, formatCredits, planetLabel,
} from '@/shared';

/** Korean reason strings (the messenger button · the console print them as they are). */
export const NPC_REASON = {
  shipOnly: '함선에서만 가능',
  notActive: '진행 중인 퀘스트가 아닙니다',
  done: '완료됨',
  missing: '납품할 아이템이 없습니다',
  unfinished: '목표를 모두 채우지 못했습니다',
  space: '보상을 받을 공간이 없습니다',
} as const;

export const WEAPON_CLASS_KO: Readonly<Record<WeaponClass, string>> = {
  AR: '돌격소총', SMG: '기관단총', SR: '저격소총', DMR: '지정사수소총', SG: '산탄총', PISTOL: '권총',
};
const ENEMY_GROUP_KO: Readonly<Record<NpcEnemyGroup, string>> = {
  humanoid: '인간형 적', rogue: '로그', raider: '레이더', android: '안드로이드', bug: '터미니드', named: '네임드',
};
/** The name of an objective written with an enemy type id (when it is not a group). An unknown id stays the id. */
const ENEMY_TYPE_KO: Readonly<Record<string, string>> = {
  scavenger: '스캐빈저', hunter: '헌터', warrior: '워리어', spewer: '스퓨어', charger: '차저', artillery: '포격 버그',
  toxic: '독성 버그', behemoth: '베헤모스', sandworm: '땅굴벌레', sandworm_weak: '어린 땅굴벌레', rogue: '로그', rogue_boss: '로그 분대장',
  rogue_scan_drone: '스캔 드론', android: '안드로이드', raider: '레이더', ...NAMED_ROGUE_NAME_KO,
  scavenger_summon: '스캐빈저',   // 2026-09-17: artillery's summoned scavenger (0 % drops) — named as its base type
  bug_egg: '벌레 알',             // 2026-09-18: a nest's breakable egg (`Portrait.ENEMY_NAME_KO` in `enemies/models`)
};
const INTERACT_KO: Readonly<Record<NpcInteractKind, string>> = {
  scanner: '맵 스캐너 작동', basement_door: '지하실 문 열기', lab_door: '연구소 잠긴 방 열기', tram: '전차 호출', rover: '탐사 차량 탑승',
};

/* ── Enemy · item matching ──────────────────────────────────────────────── */

const SCAN_DRONE = 'rogue_scan_drone';
/** Enemy type → faction (`data/enemies.csv`). The same source `meta/Rules.killGoalOf` reads. */
const FACTION_OF: ReadonlyMap<string, string> = new Map(csvRows('enemies.csv').map((r) => [r.str('type'), r.str('faction')]));

/** Does a kill objective's `enemy` (a group or a type id) cover the dead enemy's `type`? */
export function enemyMatches(spec: string | undefined, type: string): boolean {
  if (!spec) return false;
  const f = FACTION_OF.get(type);
  switch (spec) {
    case 'humanoid': return !!f && f !== 'bug' && type !== SCAN_DRONE;
    case 'bug': return f === 'bug';
    case 'rogue': return f === 'rogue';
    case 'raider': return f === 'raider' && type !== SCAN_DRONE;
    case 'android': return f === 'android';
    case 'named': return (NAMED_ROGUE_TYPES as readonly string[]).includes(type);
    default: return spec === type;
  }
}

/** `weapon:SG` → `'SG'`, null when it is an item id. */
export function weaponSpecClass(spec: string | undefined): WeaponClass | null {
  if (!spec || !spec.startsWith(NPC_ITEM_WEAPON_PREFIX)) return null;
  return spec.slice(NPC_ITEM_WEAPON_PREFIX.length) as WeaponClass;
}

/**
 * Is a `deliver` · `recover` objective's `item` this item? `classOf` = a weapon item's class (null when it is not
 * a weapon).
 */
export function itemMatches(spec: string | undefined, def: ItemDef, classOf: (def: ItemDef) => WeaponClass | null): boolean {
  if (!spec) return false;
  const cls = weaponSpecClass(spec);
  return cls ? classOf(def) === cls : def.id === spec;
}

/* ── Requirements ───────────────────────────────────────────────────────── */

export interface NpcReqContext {
  level: number;
  repLevel(corp: CorpId): number;
  questDone(id: string): boolean;
  /**
   * appended (2026-09-14): the **per-NPC** trust level (0–5, the same
   * `REP_TABLE` as a corporation). An unknown NPC is 0.
   */
  npcTrustLevel(npcId: string): number;
  /** appended (2026-09-14 3rd pass): a progress flag's running count (an unknown flag is 0). */
  flagCount(flag: NpcFlag): number;
}

export function requirementMet(req: NpcRequirement, c: NpcReqContext): boolean {
  if ((req.level ?? 0) > c.level) return false;
  for (const r of req.rep ?? []) if (c.repLevel(r.corp) < r.level) return false;
  /* 2026-09-14: the contract and the check exist, but no csv row uses `reqNpcRep` yet
   * (user's decision — what it unlocks comes later). */
  for (const r of req.npcRep ?? []) if (c.npcTrustLevel(r.npc) < r.level) return false;
  for (const q of req.quests ?? []) if (!c.questDone(q)) return false;
  /* 2026-09-14 3rd pass: progress flags (gathered once · returned from a raid once …) — the four corp NPCs'
   * first-contact requirement. */
  for (const f of req.flags ?? []) if (c.flagCount(f.flag) < f.count) return false;
  return true;
}

/** NPC quest state → old `QuestState` (housing's mining unlock gate reads it through `MetaRef.getQuestState`). */
export function legacyQuestState(s: NpcQuestState | undefined): QuestState {
  return s === 'complete' ? 'complete' : s === 'active' ? 'accepted' : s === 'offered' || s === 'deferred' ? 'available' : 'locked';
}

/* ── Wording ────────────────────────────────────────────────────────────── */

/** 「으로」 when there is a final consonant, 「로」 when there is none or it is a ㄹ. */
function withRo(word: string): string {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  if (code < 0 || code > 11171) return `${word}(으)로`;
  const jong = code % 28;
  return `${word}${jong === 0 || jong === 8 ? '로' : '으로'}`;
}

function enemyName(spec: string): string {
  return (ENEMY_GROUP_KO as Record<string, string>)[spec] ?? ENEMY_TYPE_KO[spec] ?? spec;
}

/** Is this objective's target a bug (the counter word 「마리」)? */
function isBugSpec(spec: string): boolean {
  return spec === 'bug' || FACTION_OF.get(spec) === 'bug';
}

/**
 * The Korean objective label. `label` when there is one, otherwise automatic — a planet requirement goes in front
 * as `행성 · `.
 * e.g. `보레아스 IX · 산탄총으로 레이더 5명 처치` · `버려진 연구실 컨테이너 3개 조사` · `회로 기판 6개 납품` · `산탄총 1개 회수`.
 */
export function objectiveLabel(o: NpcObjectiveDef, itemName: (defId: string) => string): string {
  const where = o.planet ? `${planetLabel(o.planet)} · ` : '';
  if (o.label) return `${where}${o.label}`;
  const n = o.target;
  const item = (): string => {
    const cls = weaponSpecClass(o.item);
    return cls ? WEAPON_CLASS_KO[cls] : itemName(o.item ?? '');
  };
  switch (o.kind) {
    case 'deliver': return `${item()} ${n}개 납품`;
    case 'recover': return `${where}${item()} ${n}개 회수`;
    case 'kill': {
      const who = enemyName(o.enemy ?? '');
      const unit = isBugSpec(o.enemy ?? '') ? '마리' : '명';
      return `${where}${o.weapon ? `${withRo(WEAPON_CLASS_KO[o.weapon])} ` : ''}${who} ${n}${unit} 처치`;
    }
    case 'discover': return `${where}${STRUCTURE_LABEL_KO[o.site ?? 'outpost']} 발견`;
    case 'search': return `${where}${STRUCTURE_LABEL_KO[o.site ?? 'outpost']} 컨테이너 ${n}개 조사`;
    case 'interact': return `${where}${INTERACT_KO[o.interact ?? 'scanner']}${n > 1 ? ` ${n}회` : ''}`;
  }
}

/**
 * The reward in one line — `1,200 C · 경험치 +600 · 헬릭스 방산 신뢰도 +300 · 박도윤 신뢰도 +200 · 회로 기판 ×2`.
 * '' when there is no reward.
 * 2026-09-14: **that NPC's per-NPC trust** follows right behind the corp reputation (neither replaces the other).
 * 2026-09-16 (user's decision): **XP uses the same compact notation as credits** (`shared/numberFormat` — `10.0k`
 * from 10,000 up).
 * Trust · item counts stay exact numbers — they never pass three digits, and how many points it is has to read at
 * once.
 */
export function rewardSummary(def: NpcQuestDef, itemName: (defId: string) => string): string {
  const r = def.rewards;
  const parts: string[] = [];
  if (r.credits > 0) parts.push(formatCredits(r.credits, { sign: true }));
  if (r.xp > 0) parts.push(`경험치 ${formatCompactSigned(r.xp, true)}`);
  for (const x of r.rep) if (x.amount > 0) parts.push(`${CORP_DEFS[x.corp]?.name ?? x.corp} 신뢰도 +${x.amount}`);
  if (r.npcTrust > 0) parts.push(`${npcTrustLabel(def.npc)} +${r.npcTrust}`);
  for (const it of r.items) parts.push(`${itemName(it.defId)} ×${it.qty}`);
  return parts.join(' · ');
}

/**
 * `박도윤 신뢰도` — the display name of per-NPC trust (an unknown id stays the id). The chip · the toast · the
 * summary all use it.
 */
export function npcTrustLabel(npcId: string): string {
  return `${NPC_DEF_MAP.get(npcId)?.name ?? npcId} 신뢰도`;
}

/** The per-NPC trust reason of an NPC quest reward (`addNpcTrust`) — the same grammar as corp rep (`addRep`). */
export function npcTrustReason(questId: string): string { return `quest:${questId}`; }

/* ── The save ───────────────────────────────────────────────────────────── */

/**
 * 2026-09-14 3rd pass: `choice` (my answer to the first contact's choices) is saved too — without it one reload
 * brings the choices back.
 */
const LOG_EVENTS: readonly NpcLogEvent[] = ['intro', 'offer', 'accept', 'decline', 'brief', 'complete', 'choice'];
/** The events that must carry a `q` (`intro` · `choice` have no quest). */
const QUEST_LOG_EVENTS: ReadonlySet<NpcLogEvent> = new Set<NpcLogEvent>(['offer', 'accept', 'decline', 'brief', 'complete']);
const QUEST_STATES: readonly NpcQuestState[] = ['offered', 'deferred', 'active', 'complete'];

export function freshNpcSave(): NpcSave {
  /* `trust` · `flags` are optional fields an old save does not have, but **a fresh save always carries them** —
   * `MetaStorage.snapshot()` bakes this object into JSON as it is and `sanitizeNpcSave` reads it back, so leaving
   * them out here makes them vanish on one reload. */
  return { contacts: {}, log: {}, quests: {}, trust: {}, flags: {} };
}

const whole = (v: unknown): number => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * What came from storage · a server document, turned into an `NpcSave` — an unknown NPC · quest id is dropped,
 * progress is cut to [0, target] and the log to `NPC_LOG_MAX`. A quest with no contact gets its contact filled in
 * (so it does not vanish from the conversation list).
 * 2026-09-14: **per-NPC trust (`trust`) is carried in here too** — an old document has none, so missing means an
 * empty table. Unlike contacts · quests it is not filtered by 「an NPC that has made contact」 (the console, and a
 * future accrual path, may grant it before contact); only an unknown id is dropped.
 * 2026-09-14 3rd pass: **the `choice` entries and the progress flags (`flags`) are carried in too** — without
 * either, one reload revives an answered choice (blocking the main point · the offer again) and the first-contact
 * requirements count from 0 again.
 */
export function sanitizeNpcSave(raw: unknown): NpcSave {
  const out = freshNpcSave();
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {});

  for (const [id, v] of Object.entries(obj(r.contacts))) {
    if (!NPC_DEF_MAP.has(id)) continue;
    const c = obj(v);
    out.contacts[id] = { at: whole(c.at), readAt: whole(c.readAt) };
  }
  for (const [id, v] of Object.entries(obj(r.quests))) {
    const def = NPC_QUEST_MAP.get(id);
    if (!def) continue;
    const q = obj(v);
    if (!QUEST_STATES.includes(q.s as NpcQuestState)) continue;
    const p = Array.isArray(q.p) ? q.p : [];
    const save: NpcQuestSave = { s: q.s as NpcQuestState, at: whole(q.at), p: def.objectives.map((o, i) => Math.min(o.target, whole(p[i]))) };
    out.quests[id] = save;
    if (!out.contacts[def.npc] && NPC_DEF_MAP.has(def.npc)) out.contacts[def.npc] = { at: save.at, readAt: save.at };
  }
  for (const [npc, v] of Object.entries(obj(r.log))) {
    if (!out.contacts[npc] || !Array.isArray(v)) continue;
    const choiceCount = NPC_DEF_MAP.get(npc)?.introChoices?.length ?? 0;
    const list: NpcLogEntry[] = [];
    for (const e of v) {
      const en = obj(e);
      if (!LOG_EVENTS.includes(en.e as NpcLogEvent)) continue;
      const ev = en.e as NpcLogEvent;
      const at = whole(en.at);
      /* 2026-09-14 3rd pass: `choice` carries the number picked (`c`), not a quest — it is dropped when it falls
       * outside the csv's current choice count (shrinking the table leaves no label to resolve, so the bubble would
       * be empty). `intro` is bare, as it always was. */
      if (ev === 'choice') {
        const c = Math.floor(Number(en.c));
        if (!Number.isFinite(c) || c < 0 || c >= choiceCount) continue;
        list.push({ at, e: ev, c });
        continue;
      }
      if (ev === 'intro') { list.push({ at, e: ev }); continue; }
      if (!QUEST_LOG_EVENTS.has(ev)) continue;
      if (!(typeof en.q === 'string' && NPC_QUEST_MAP.get(en.q)?.npc === npc)) continue;
      list.push({ at, e: ev, q: en.q });
    }
    out.log[npc] = list.slice(-Math.max(1, NPC_LOG_MAX));
  }
  const trust = out.trust ?? (out.trust = {});
  for (const [id, v] of Object.entries(obj(r.trust))) {
    if (!NPC_DEF_MAP.has(id)) continue;
    const n = whole(v);
    if (n > 0) trust[id] = n;
  }
  /* 2026-09-14 3rd pass: progress flags — the only input of the first-contact requirements, so leaving them out
   * here makes gathering · returning from a raid 0 on every reload. Only an unknown flag name is dropped (an old
   * document has none at all, hence an empty table). */
  const flags = out.flags ?? (out.flags = {});
  for (const [id, v] of Object.entries(obj(r.flags))) {
    if (!(NPC_FLAGS as readonly string[]).includes(id)) continue;
    const n = whole(v);
    if (n > 0) flags[id as NpcFlag] = n;
  }
  return out;
}
