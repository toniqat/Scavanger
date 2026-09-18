/**
 * src/meta/NpcRules.ts — NPC 퀘스트의 **순수 규칙** (2026-09-14, docs/DECISIONS.md 「2026-09-14 — 메신저 · NPC 퀘스트 · 단체방」).
 *
 * ctx · DOM 없이: 조건 판정(`requirementMet`), 처치 대상 · 아이템 일치(`enemyMatches` · `itemMatches`), 한국어 목표 문구
 * (`objectiveLabel`) · 보상 요약(`rewardSummary`), 저장 모양 정리(`freshNpcSave` · `sanitizeNpcSave`), 옛 `QuestState` 로의 대응.
 * 상태를 가진 쪽은 `parts/NpcQuests.ts`(제안 · 대화 · 수락 · 납품 · 보고)와 `parts/NpcObjectives.ts`(레이드 목표)다.
 */
import type {
  CorpId, ItemDef, NpcEnemyGroup, NpcFlag, NpcInteractKind, NpcLogEntry, NpcLogEvent, NpcObjectiveDef, NpcQuestDef, NpcQuestSave,
  NpcQuestState, NpcRequirement, NpcSave, QuestState, WeaponClass,
} from '@/shared';
import {
  CORP_DEFS, NAMED_ROGUE_NAME_KO, NAMED_ROGUE_TYPES, NPC_DEF_MAP, NPC_FLAGS, NPC_ITEM_WEAPON_PREFIX, NPC_LOG_MAX, NPC_QUEST_MAP,
  STRUCTURE_LABEL_KO, csvRows, formatCompactSigned, formatCredits, planetLabel,
} from '@/shared';

/** 한국어 사유 (메신저 버튼 · 콘솔이 그대로 찍는다). */
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
/** 적 타입 id 로 적은 목표의 이름 (묶음이 아닐 때). 모르는 id 는 id 그대로. */
const ENEMY_TYPE_KO: Readonly<Record<string, string>> = {
  scavenger: '스캐빈저', hunter: '헌터', warrior: '워리어', spewer: '스퓨어', charger: '차저', artillery: '포격 버그',
  toxic: '독성 버그', behemoth: '베헤모스', sandworm: '땅굴벌레', sandworm_weak: '어린 땅굴벌레', rogue: '로그', rogue_boss: '로그 분대장',
  rogue_scan_drone: '스캔 드론', android: '안드로이드', raider: '레이더', ...NAMED_ROGUE_NAME_KO,
  scavenger_summon: '스캐빈저',   // 2026-09-17: 포병의 소환 스캐빈저 (드롭 0 %) — 이름은 바탕 종류와 같다
  bug_egg: '벌레 알',             // 2026-09-18: 둥지의 부술 수 있는 알 (`enemies/models/Portrait.ENEMY_NAME_KO` 와 같은 낱말)
};
const INTERACT_KO: Readonly<Record<NpcInteractKind, string>> = {
  scanner: '맵 스캐너 작동', basement_door: '지하실 문 열기', lab_door: '연구소 잠긴 방 열기', tram: '전차 호출', rover: '탐사 차량 탑승',
};

/* ── 적 · 아이템 일치 ─────────────────────────────────────────────────────── */

const SCAN_DRONE = 'rogue_scan_drone';
/** 적 타입 → 팩션 (`data/enemies.csv`). `meta/Rules.killGoalOf` 와 같은 원본. */
const FACTION_OF: ReadonlyMap<string, string> = new Map(csvRows('enemies.csv').map((r) => [r.str('type'), r.str('faction')]));

/** 처치 목표의 `enemy`(묶음 또는 타입 id)가 죽은 적 `type` 에 해당하나. */
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

/** `weapon:SG` → `'SG'`, 아이템 id 면 null. */
export function weaponSpecClass(spec: string | undefined): WeaponClass | null {
  if (!spec || !spec.startsWith(NPC_ITEM_WEAPON_PREFIX)) return null;
  return spec.slice(NPC_ITEM_WEAPON_PREFIX.length) as WeaponClass;
}

/** 납품 · 회수 목표의 `item` 이 이 아이템인가. `classOf` = 무기 아이템의 계열 (무기가 아니면 null). */
export function itemMatches(spec: string | undefined, def: ItemDef, classOf: (def: ItemDef) => WeaponClass | null): boolean {
  if (!spec) return false;
  const cls = weaponSpecClass(spec);
  return cls ? classOf(def) === cls : def.id === spec;
}

/* ── 조건 ─────────────────────────────────────────────────────────────────── */

export interface NpcReqContext {
  level: number;
  repLevel(corp: CorpId): number;
  questDone(id: string): boolean;
  /**
   * appended (2026-09-14, docs/DECISIONS.md 「2026-09-14 — 정보상」): **NPC 개인** 신뢰도 레벨 (0–5, 기업과 같은 `REP_TABLE`).
   * 모르는 NPC 는 0.
   */
  npcTrustLevel(npcId: string): number;
  /** appended (2026-09-14 3차): 진행 플래그의 누적 횟수 (모르는 플래그는 0). */
  flagCount(flag: NpcFlag): number;
}

export function requirementMet(req: NpcRequirement, c: NpcReqContext): boolean {
  if ((req.level ?? 0) > c.level) return false;
  for (const r of req.rep ?? []) if (c.repLevel(r.corp) < r.level) return false;
  /* 2026-09-14: 계약 · 판정만 있고 csv 의 어느 줄도 아직 `reqNpcRep` 를 쓰지 않는다 (사용자 결정 — 해금 요소는 나중에). */
  for (const r of req.npcRep ?? []) if (c.npcTrustLevel(r.npc) < r.level) return false;
  for (const q of req.quests ?? []) if (!c.questDone(q)) return false;
  /* 2026-09-14 3차: 진행 플래그 (채집 1회 · 레이드 복귀 1회 …) — 4기업 NPC 의 첫 연락 조건. */
  for (const f of req.flags ?? []) if (c.flagCount(f.flag) < f.count) return false;
  return true;
}

/** NPC 퀘스트 상태 → 옛 `QuestState` (housing 의 채굴 해금 게이트가 `MetaRef.getQuestState` 로 읽는다). */
export function legacyQuestState(s: NpcQuestState | undefined): QuestState {
  return s === 'complete' ? 'complete' : s === 'active' ? 'accepted' : s === 'offered' || s === 'deferred' ? 'available' : 'locked';
}

/* ── 문구 ─────────────────────────────────────────────────────────────────── */

/** 받침이 있으면 「으로」, 없거나 ㄹ 받침이면 「로」. */
function withRo(word: string): string {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  if (code < 0 || code > 11171) return `${word}(으)로`;
  const jong = code % 28;
  return `${word}${jong === 0 || jong === 8 ? '로' : '으로'}`;
}

function enemyName(spec: string): string {
  return (ENEMY_GROUP_KO as Record<string, string>)[spec] ?? ENEMY_TYPE_KO[spec] ?? spec;
}

/** 이 목표의 대상이 벌레인가 (단위 「마리」). */
function isBugSpec(spec: string): boolean {
  return spec === 'bug' || FACTION_OF.get(spec) === 'bug';
}

/**
 * 한국어 목표 문구. `label` 이 있으면 그것, 없으면 자동 — 행성 조건은 앞에 `행성 · `.
 * 예: `보레아스 IX · 산탄총으로 레이더 5명 처치` · `버려진 연구실 컨테이너 3개 조사` · `회로 기판 6개 납품` · `산탄총 1개 회수`.
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
 * 보상 한 줄 — `1,200 C · 경험치 +600 · 헬릭스 방산 신뢰도 +300 · 박도윤 신뢰도 +200 · 회로 기판 ×2`. 보상이 없으면 ''.
 * 2026-09-14: 기업 신뢰도 바로 뒤에 **그 NPC 의 개인 신뢰도**가 붙는다 (둘은 서로를 대신하지 않는다).
 * 2026-09-16 (사용자 결정): **경험치도 크레딧과 같은 축약형**이다 (`shared/numberFormat` — 10,000 이상 `10.0k`).
 * 신뢰도 · 아이템 개수는 그대로 정확한 수다 — 세 자리를 넘지 않고, 몇 점인지가 바로 읽혀야 하는 값이다.
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

/** `박도윤 신뢰도` — NPC 개인 신뢰도의 표시 이름 (모르는 id 는 id 그대로). 칩 · 토스트 · 요약이 같이 쓴다. */
export function npcTrustLabel(npcId: string): string {
  return `${NPC_DEF_MAP.get(npcId)?.name ?? npcId} 신뢰도`;
}

/** NPC 퀘스트 보상의 개인 신뢰도 사유 (`addNpcTrust`) — 기업 신뢰도(`addRep`)와 같은 문법이다. */
export function npcTrustReason(questId: string): string { return `quest:${questId}`; }

/* ── 저장 ─────────────────────────────────────────────────────────────────── */

/** 2026-09-14 3차: `choice`(첫 연락 선택지의 내 대답)도 저장된다 — 빠지면 새로고침 한 번에 선택지가 되살아난다. */
const LOG_EVENTS: readonly NpcLogEvent[] = ['intro', 'offer', 'accept', 'decline', 'brief', 'complete', 'choice'];
/** `q` 를 들고 있어야 하는 사건 (`intro` · `choice` 는 퀘스트가 없다). */
const QUEST_LOG_EVENTS: ReadonlySet<NpcLogEvent> = new Set<NpcLogEvent>(['offer', 'accept', 'decline', 'brief', 'complete']);
const QUEST_STATES: readonly NpcQuestState[] = ['offered', 'deferred', 'active', 'complete'];

export function freshNpcSave(): NpcSave {
  /* `trust` · `flags` 는 옛 세이브에 없는 선택 필드지만 **새 세이브는 언제나 들고 있는다** — `MetaStorage.snapshot()` 이
   * 이 객체를 그대로 JSON 으로 굽고 `sanitizeNpcSave` 가 되읽으므로, 여기서 빠지면 새로고침 한 번에 사라진다. */
  return { contacts: {}, log: {}, quests: {}, trust: {}, flags: {} };
}

const whole = (v: unknown): number => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * 저장소 · 서버 문서에서 온 것을 `NpcSave` 로 — 모르는 NPC · 퀘스트 id 는 버리고, 진행은 [0, target] 으로 자르고, 기록은
 * `NPC_LOG_MAX` 로 자른다. 퀘스트는 있는데 연락이 없으면 연락을 채운다(대화 목록에서 사라지지 않게).
 * 2026-09-14: **개인 신뢰도(`trust`)도 여기서 실려 들어온다** — 옛 문서에는 없으므로 없으면 빈 표다. 연락 · 퀘스트와 달리
 * 「연락이 온 NPC」로 거르지 않는다 (콘솔 · 미래의 다른 적립 경로가 연락보다 먼저 줄 수 있다); 거르는 것은 모르는 id 뿐이다.
 * 2026-09-14 3차: **`choice` 기록과 진행 플래그(`flags`)도 실려 들어온다** — 둘 다 빠지면 새로고침 한 번에
 * 답한 선택지가 되살아나고(본론 · 제안이 다시 막힌다) 첫 연락 조건이 0 부터 다시 센다.
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
      /* 2026-09-14 3차: `choice` 는 퀘스트가 아니라 고른 번호(`c`)를 들고 온다 — 지금 표의 선택지 수 밖이면 버린다
       * (표를 줄이면 풀 라벨이 없어 빈 말풍선이 된다). `intro` 는 예전 그대로 맨몸이다. */
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
  /* 2026-09-14 3차: 진행 플래그 — 첫 연락 조건의 유일한 입력이라 여기서 빠지면 채집 · 레이드 복귀가 매 새로고침마다 0 이 된다.
   * 모르는 플래그 이름만 버린다 (옛 문서에는 아예 없으므로 빈 표). */
  const flags = out.flags ?? (out.flags = {});
  for (const [id, v] of Object.entries(obj(r.flags))) {
    if (!(NPC_FLAGS as readonly string[]).includes(id)) continue;
    const n = whole(v);
    if (n > 0) flags[id as NpcFlag] = n;
  }
  return out;
}
