/*
 * src/shared/npc.ts — 메신저 NPC · NPC 퀘스트 계약 (2026-09-14, docs/DECISIONS.md 「2026-09-14 — 메신저 · NPC 퀘스트 · 단체방」).
 *
 * 기업 퀘스트(`data/quests.csv`)는 폐지됐고, 퀘스트는 이제 **NPC 가 메신저로** 준다. 기업 계약은 그대로다.
 * 수치 · 대사의 원본은 `data/npcs.csv` · `data/npc_quests.csv` · `data/npc_objectives.csv` 이고 이 파일은 그 표를 옮기는 로더와
 * 타입 · `ctx.meta.npc`(`NpcQuestRef`) 계약만 갖는다. 규칙(제안 · 진행 · 확정 · 보상)의 구현은 meta/ 가 갖는다.
 *
 * Owner: shared/ (로더 · 검사는 B 에이전트 — meta 소유). 소비: meta(엔진) · ui(메신저 · 지도 패널 · 토스트) · housing(채굴 해금 게이트 — `MetaRef.getQuestState`).
 */
import type { CorpId } from './meta';
import type { StructureKind, WeaponClass } from './types';
import type { PlanetId } from './planets';
import { addDataIssue, csvRows, keyTable } from './data/tables';

type Row = ReturnType<typeof csvRows>[number];

const T = /* data/tuning.csv */ keyTable('tuning.csv');
/** NPC 한 명의 대화 기록에 남기는 사건 수 (넘치면 오래된 것부터). */
export const NPC_LOG_MAX = T.num('NPC_LOG_MAX');
/** 함선에 있는 동안 첫 연락 · 제안 조건을 다시 보는 간격(초). */
export const NPC_OFFER_CHECK_S = T.num('NPC_OFFER_CHECK_S');

/* ── 열거 ───────────────────────────────────────────────────────────────── */

export const NPC_ROLES = ['executive', 'staff', 'independent'] as const;
/** executive = 기업 임원 · staff = 기업 직원 · independent = 무소속. */
export type NpcRole = typeof NPC_ROLES[number];
export const NPC_ROLE_LABEL_KO: Readonly<Record<NpcRole, string>> = { executive: '임원', staff: '직원', independent: '무소속' };

export const NPC_OBJECTIVE_KINDS = ['deliver', 'recover', 'interact', 'kill', 'discover', 'search'] as const;
export type NpcObjectiveKind = typeof NPC_OBJECTIVE_KINDS[number];
/** 레이드 안에서 채우는 목표 (훈련장 제외). `deliver` 만 함선에서 채운다. */
export const NPC_RAID_OBJECTIVE_KINDS: ReadonlySet<NpcObjectiveKind> = new Set(['recover', 'interact', 'kill', 'discover', 'search']);

export const NPC_INTERACT_KINDS = ['scanner', 'basement_door', 'lab_door', 'tram', 'rover'] as const;
/** scanner = 구조물 옥상 맵 스캐너 · basement_door = 전진기지 지하실 문(열쇠) · lab_door = 연구소 2층 잠긴 방(키카드) · tram = 전차 호출/시동 · rover = 탐사 차량 탑승. */
export type NpcInteractKind = typeof NPC_INTERACT_KINDS[number];

export const NPC_ENEMY_GROUPS = ['humanoid', 'rogue', 'raider', 'android', 'bug', 'named'] as const;
/** 처치 목표의 적 묶음. 이 밖의 값은 적 타입 id (`data/enemies.csv`) 로 읽는다 — 검사는 `npm run data:check`. */
export type NpcEnemyGroup = typeof NPC_ENEMY_GROUPS[number];

const WEAPON_CLASSES: readonly WeaponClass[] = ['AR', 'SMG', 'SR', 'DMR', 'SG', 'PISTOL'];
const STRUCTURE_KINDS: readonly StructureKind[] = ['outpost', 'lab', 'wreck'];
const CORPS: readonly string[] = ['helix', 'bastion', 'nomad', 'ceres'];
const PLANETS: readonly string[] = ['amber', 'tundra', 'mossy', 'ashen', 'crimson'];

/** `item` 열의 「그 계열 총기 아무거나」 표기: `weapon:SG`. */
export const NPC_ITEM_WEAPON_PREFIX = 'weapon:';

/**
 * appended (2026-09-14 3차): **진행 플래그** — NPC 첫 연락 조건이 보는 누적 횟수.
 *   `gathered`     채집물(약초 · 고철 · 토양 · 표본 …)을 캔 횟수 — 생존 여부와 무관하다 (`gather:collected`).
 *   `raidReturned` 레이드에서 살아 돌아온 횟수 (`game:complete`).
 * 추가만 한다 — 옛 세이브는 모르는 플래그를 0 으로 읽는다.
 */
export const NPC_FLAGS = ['gathered', 'raidReturned'] as const;
export type NpcFlag = typeof NPC_FLAGS[number];

/**
 * ⚠ `'deferred'` 는 **은퇴했다** (2026-09-14 3차, 사용자 결정 — 「생각해볼게」 선택지 제거).
 * 새 퀘스트는 `offered` → `accept()` → `active` 뿐이고, 이 값은 옛 세이브를 읽기 위해서만 남는다
 * (`airstrike` · `secondary` 와 같은 처리 — 계약은 추가만 한다).
 */
export type NpcQuestState = 'offered' | 'deferred' | 'active' | 'complete';
export const NPC_QUEST_STATE_LABEL_KO: Readonly<Record<NpcQuestState, string>> = {
  offered: '제안 받음', deferred: '보류', active: '진행 중', complete: '완료',
};

/** 메신저 상단 탭. */
export type MessengerTab = 'chat' | 'friends' | 'quests';

/** 퀘스트 카드 버튼에 붙는 플레이어의 정해진 답 (대화 기록에 「나」 말풍선으로 남는다). */
/** ⚠ `decline` · `brief` 는 은퇴했다 (2026-09-14 3차 — 「생각해볼게」 제거). 옛 기록을 푸는 데만 쓰인다. */
export const NPC_REPLY_KO = {
  accept: '맡겠습니다.',
  decline: '생각해보지.',
  brief: '그 일, 아직 유효합니까?',
  complete: '끝냈습니다. 확인해 주세요.',
} as const;

/* ── 정의 ───────────────────────────────────────────────────────────────── */

export interface NpcRequirement {
  /** 캐릭터 레벨 이상. */
  level?: number;
  /** 기업 신뢰도 레벨 이상 (전부 만족). */
  rep?: readonly { corp: CorpId; level: number }[];
  /** 먼저 **완료**한 NPC 퀘스트 id (전부). */
  quests?: readonly string[];
  /**
   * appended (2026-09-14): **NPC 개인** 신뢰도 레벨 이상 (전부 만족). 기업 신뢰도(`rep`)와 별개이고 같은
   * `REP_TABLE`(0–5) 을 쓴다. csv 열은 `reqNpcRep` = "npcId:레벨" 을 `|` 로. 사용자 결정 2026-09-14 — 지금은
   * **아무 줄도 이 조건을 쓰지 않는다**(적립 · 표시까지만). 계약만 먼저 두고 해금 요소는 나중에 정한다.
   */
  npcRep?: readonly { npc: string; level: number }[];
  /**
   * appended (2026-09-14 3차, 사용자 결정 — 4기업 NPC 는 튜토리얼이 끝나자마자 연락하지 않는다):
   * **진행 플래그**가 그 수 이상 (전부 만족). csv 열은 `reqFlag` = "플래그:횟수" 를 `|` 로.
   * 플래그를 세는 곳은 meta/ 하나이고 저장은 `NpcSave.flags` 다 — 레이드를 넘어 사는 값이지만
   * NPC 연락 조건 말고는 읽는 곳이 없어 프로필이 아니라 NPC 계약 안에 둔다.
   */
  flags?: readonly { flag: NpcFlag; count: number }[];
}

export interface NpcDef {
  id: string;
  name: string;
  /** 직함 (예: 헬릭스 조달실장). */
  title: string;
  corp: CorpId | null;
  role: NpcRole;
  color: string;
  /** 초상 글자 1–2개. */
  glyph: string;
  /** 첫 연락 조건. */
  requires: NpcRequirement;
  /** 첫 연락 말풍선들. */
  intro: readonly string[];
  bio: string;
  /** 파일 줄 순서. */
  order: number;

  /* ── appended (2026-09-14, 튜토리얼 개편 — `docs/DECISIONS.md` 「2026-09-14 — 튜토리얼 개편」) ── */
  /**
   * **대사 선택지** — 첫 연락 말풍선이 끝난 뒤 뜨는 내 대답 버튼들 (`data/npcs.csv` 의 `introChoices`, `|` 구분).
   * 비어 있으면 선택지가 없다 (지금까지의 NPC 전부). 고르면 `NpcLogEntry {e:'choice', c}` 하나가 남는다.
   */
  introChoices?: readonly string[];
  /**
   * 고른 번호에 대응하는 NPC 의 답 (`introChoiceReplies`, `|` 구분 — `introChoices` 와 같은 길이).
   * **고른 뒤의 대화는 어느 쪽이든 같다** — 분기 상태를 저장하지 않는다 (레이븐은 어느 대답이든 흘려 넘긴다).
   */
  introChoiceReplies?: readonly string[];

  /* ── appended (2026-09-14 3차, 사용자 결정 — 첫 연락은 「짧은 인사 → 선택지 → 본론」) ── */
  /**
   * 선택지에 **답한 뒤** 이어지는 NPC 의 말풍선들 (`data/npcs.csv` 의 `introAfter`, `|` 구분).
   * `intro` 는 이제 선택지 **앞의** 1–3 마디이고, 본론(자기소개 · 용건)은 여기 온다.
   * 이 줄이 있는 NPC 는 **선택지에 답하기 전에는 퀘스트를 제안하지 않는다** (`NpcQuests.evaluate`).
   * 비어 있으면 지금까지처럼 `intro` 만 있고 곧장 제안이 온다.
   */
  introAfter?: readonly string[];
}

export interface NpcObjectiveDef {
  quest: string;
  /** 그 퀘스트 안의 순서 (0부터, 파일 줄 순서). */
  index: number;
  kind: NpcObjectiveKind;
  target: number;
  /** deliver · recover: 아이템 id 또는 `weapon:<계열>`. */
  item?: string;
  /** kill: `NpcEnemyGroup` 또는 적 타입 id. */
  enemy?: string;
  /** kill: 그 계열 총기 막타만. */
  weapon?: WeaponClass;
  /** discover · search. */
  site?: StructureKind;
  /** interact. */
  interact?: NpcInteractKind;
  /** 레이드 목표만: 그 행성에서만 센다. */
  planet?: PlanetId;
  /** 같은 퀘스트의 같은 chain 목표는 한 레이드 안에서 모두 채워야 함께 확정된다. */
  chain?: string;
  /** 자동 문구 대신 쓸 목표 문구. */
  label?: string;
}

export interface NpcQuestDef {
  id: string;
  npc: string;
  name: string;
  /** 퀘스트 카드의 설명. */
  summary: string;
  /** 제안 조건. */
  requires: NpcRequirement;
  objectives: readonly NpcObjectiveDef[];
  rewards: {
    credits: number;
    xp: number;
    rep: readonly { corp: CorpId; amount: number }[];
    items: readonly { defId: string; qty: number }[];
    /**
     * appended (2026-09-14, 사용자 결정): 이 퀘스트를 낸 **그 NPC** 의 개인 신뢰도 보상 (csv 열 `npcTrust`).
     * 기업 신뢰도(`rep`)와 함께 주고 서로를 대신하지 않는다 — 무소속 NPC(레이븐 · 케인)는 이것만 준다.
     */
    npcTrust: number;
  };
  /** 대사 (말풍선 단위). */
  lines: { offer: readonly string[]; accept: readonly string[]; decline: readonly string[]; brief: readonly string[]; complete: readonly string[] };
  /** 파일 줄 순서 (같은 NPC 안의 제안 순서). */
  order: number;
}

/* ── 로더 ───────────────────────────────────────────────────────────────── */

function issue(r: Row, column: string, message: string): void {
  addDataIssue({ file: r.file, line: r.line, column, message });
}

function optEnum<T extends string>(r: Row, col: string, values: readonly T[]): T | undefined {
  const v = r.optStr(col);
  if (!v) return undefined;
  if (!(values as readonly string[]).includes(v)) { issue(r, col, `'${v}' — ${values.join(' | ')} 중 하나여야 한다`); return undefined; }
  return v as T;
}

function pairList(r: Row, col: string): { corp: CorpId; n: number }[] {
  if (!r.has(col)) return [];
  const out: { corp: CorpId; n: number }[] = [];
  for (const raw of r.list(col)) {
    const part = raw.trim();
    const i = part.lastIndexOf(':');
    const corp = i > 0 ? part.slice(0, i).trim() : '';
    const n = i > 0 ? Number(part.slice(i + 1)) : NaN;
    if (!CORPS.includes(corp) || !Number.isFinite(n) || n < 0) { issue(r, col, `'${part}' — "기업:수치" 형식이어야 한다 (기업 = ${CORPS.join(' | ')})`); continue; }
    out.push({ corp: corp as CorpId, n: Math.round(n) });
  }
  return out;
}

/** appended (2026-09-14): `reqNpcRep` = "npcId:레벨" 을 `|` 로. `pairList` 는 기업 전용이라 따로 판다. */
function npcPairList(r: Row, col: string): { npc: string; level: number }[] {
  if (!r.has(col)) return [];
  const out: { npc: string; level: number }[] = [];
  for (const part of r.list(col)) {
    const i = part.lastIndexOf(':');
    const npc = i > 0 ? part.slice(0, i).trim() : '';
    const n = i > 0 ? Number(part.slice(i + 1)) : NaN;
    if (!npc || !Number.isFinite(n) || n < 0) { issue(r, col, `'${part}' — "npcId:레벨" 형식이어야 한다`); continue; }
    out.push({ npc, level: Math.round(n) });
  }
  return out;
}

/** appended (2026-09-14 3차): `reqFlag` = "플래그:횟수" 를 `|` 로. */
function flagList(r: Row, col: string): { flag: NpcFlag; count: number }[] {
  if (!r.has(col)) return [];
  const out: { flag: NpcFlag; count: number }[] = [];
  for (const part of r.list(col)) {
    const i = part.lastIndexOf(':');
    const flag = i > 0 ? part.slice(0, i).trim() : part.trim();
    const n = i > 0 ? Number(part.slice(i + 1)) : 1;
    if (!(NPC_FLAGS as readonly string[]).includes(flag) || !Number.isFinite(n) || n < 1) {
      issue(r, col, `'${part}' — "플래그:횟수" 형식이어야 한다 (플래그 = ${NPC_FLAGS.join(' | ')})`); continue;
    }
    out.push({ flag: flag as NpcFlag, count: Math.round(n) });
  }
  return out;
}

function requirementOf(r: Row): NpcRequirement {
  const rep = pairList(r, 'reqRep').map((p) => ({ corp: p.corp, level: p.n }));
  const npcRep = npcPairList(r, 'reqNpcRep');
  const flags = flagList(r, 'reqFlag');
  return {
    ...(r.has('reqLevel') ? { level: r.int('reqLevel', { min: 1 }) } : {}),
    ...(rep.length ? { rep } : {}),
    ...(npcRep.length ? { npcRep } : {}),
    ...(flags.length ? { flags } : {}),
    ...(r.has('reqQuests') ? { quests: r.list('reqQuests').map((s) => s.trim()).filter(Boolean) } : {}),
  };
}

const lines = (r: Row, col: string): string[] => (r.has(col) ? r.list(col).map((s) => s.trim()).filter(Boolean) : []);

export const NPC_DEFS: readonly NpcDef[] = csvRows('npcs.csv').map((r, order) => {
  const corp = r.optStr('corp');
  if (corp && !CORPS.includes(corp)) issue(r, 'corp', `'${corp}' — ${CORPS.join(' | ')} 또는 비움(무소속)`);
  // 2026-09-14: 대사 선택지 — 둘 다 비었거나, 같은 개수여야 한다 (고른 번호로 답을 찾는다).
  const introChoices = lines(r, 'introChoices');
  const introChoiceReplies = lines(r, 'introChoiceReplies');
  const introAfter = lines(r, 'introAfter');
  if (introAfter.length && !introChoices.length) issue(r, 'introAfter', 'introAfter 는 introChoices 가 있는 줄에만 쓴다 (선택지에 답한 뒤의 말풍선)');
  if (introChoices.length !== introChoiceReplies.length) {
    issue(r, 'introChoices', `선택지 ${introChoices.length}개인데 답(introChoiceReplies)은 ${introChoiceReplies.length}개 — 개수가 같아야 한다`);
  }
  return {
    id: r.str('id'),
    name: r.str('name'),
    title: r.str('title'),
    corp: corp && CORPS.includes(corp) ? corp as CorpId : null,
    role: r.enum('role', NPC_ROLES),
    color: r.str('color'),
    glyph: r.str('glyph'),
    requires: requirementOf(r),
    intro: lines(r, 'intro'),
    bio: r.optStr('bio') ?? '',
    order,
    ...(introChoices.length ? { introChoices, introChoiceReplies } : {}),
    ...(introAfter.length ? { introAfter } : {}),
  };
});
export const NPC_DEF_MAP: ReadonlyMap<string, NpcDef> = new Map(NPC_DEFS.map((d) => [d.id, d]));

const OBJECTIVES_BY_QUEST = new Map<string, NpcObjectiveDef[]>();
for (const r of csvRows('npc_objectives.csv')) {
  const quest = r.str('quest');
  const kind = r.enum('kind', NPC_OBJECTIVE_KINDS);
  const list = OBJECTIVES_BY_QUEST.get(quest) ?? [];
  const item = r.optStr('item') || undefined;
  const enemy = r.optStr('enemy') || undefined;
  const weapon = optEnum(r, 'weapon', WEAPON_CLASSES);
  const site = optEnum(r, 'site', STRUCTURE_KINDS);
  const interact = optEnum(r, 'interact', NPC_INTERACT_KINDS);
  const planet = optEnum(r, 'planet', PLANETS) as PlanetId | undefined;
  const chain = r.optStr('chain') || undefined;
  const label = r.optStr('label') || undefined;
  const raid = NPC_RAID_OBJECTIVE_KINDS.has(kind);
  /* 종류마다 반드시 있어야 하는 열 · 쓰이지 않는 열 */
  const need = (col: string, v: unknown): void => { if (v === undefined) issue(r, col, `'${kind}' 목표에는 ${col} 이 필요하다`); };
  const unused = (col: string, v: unknown): void => { if (v !== undefined) issue(r, col, `'${kind}' 목표에는 ${col} 이 쓰이지 않는다`); };
  if (kind === 'deliver' || kind === 'recover') need('item', item); else unused('item', item);
  if (kind === 'kill') need('enemy', enemy); else { unused('enemy', enemy); unused('weapon', weapon); }
  if (kind === 'discover' || kind === 'search') need('site', site); else unused('site', site);
  if (kind === 'interact') need('interact', interact); else unused('interact', interact);
  if (!raid) { unused('planet', planet); unused('chain', chain); }
  if (item?.startsWith(NPC_ITEM_WEAPON_PREFIX) && !(WEAPON_CLASSES as readonly string[]).includes(item.slice(NPC_ITEM_WEAPON_PREFIX.length))) {
    issue(r, 'item', `'${item}' — weapon:<${WEAPON_CLASSES.join(' | ')}> 형식이어야 한다`);
  }
  list.push({
    quest, index: list.length, kind, target: r.int('target', { min: 1 }),
    ...(item ? { item } : {}), ...(enemy ? { enemy } : {}), ...(weapon ? { weapon } : {}), ...(site ? { site } : {}),
    ...(interact ? { interact } : {}), ...(planet ? { planet } : {}), ...(chain ? { chain } : {}), ...(label ? { label } : {}),
  });
  OBJECTIVES_BY_QUEST.set(quest, list);
}

export const NPC_QUEST_DEFS: readonly NpcQuestDef[] = csvRows('npc_quests.csv').map((r, order) => {
  const id = r.str('id');
  const npc = r.str('npc');
  if (!NPC_DEF_MAP.has(npc)) issue(r, 'npc', `모르는 NPC '${npc}' (data/npcs.csv)`);
  const objectives = OBJECTIVES_BY_QUEST.get(id) ?? [];
  if (objectives.length === 0) issue(r, 'id', `퀘스트 '${id}' 에 목표가 없다 (data/npc_objectives.csv)`);
  return {
    id, npc, name: r.str('name'), summary: r.str('summary'),
    requires: requirementOf(r),
    objectives,
    rewards: {
      credits: r.has('rewardCredits') ? r.int('rewardCredits', { min: 0 }) : 0,
      xp: r.has('rewardXp') ? r.int('rewardXp', { min: 0 }) : 0,
      rep: pairList(r, 'rewardRep').map((p) => ({ corp: p.corp, amount: p.n })),
      items: r.has('rewardItems') ? r.costList('rewardItems') : [],
      /* appended (2026-09-14): 이 퀘스트를 낸 NPC 의 개인 신뢰도 */
      npcTrust: r.has('npcTrust') ? r.int('npcTrust', { min: 0 }) : 0,
    },
    lines: {
      offer: lines(r, 'offer'), accept: lines(r, 'accept'), decline: lines(r, 'decline'),
      brief: lines(r, 'brief'), complete: lines(r, 'complete'),
    },
    order,
  };
});
export const NPC_QUEST_MAP: ReadonlyMap<string, NpcQuestDef> = new Map(NPC_QUEST_DEFS.map((d) => [d.id, d]));
{
  const known = new Set(NPC_QUEST_DEFS.map((q) => q.id));
  for (const [quest] of OBJECTIVES_BY_QUEST) {
    if (!known.has(quest)) addDataIssue({ file: 'npc_objectives.csv', line: 0, column: 'quest', message: `모르는 퀘스트 '${quest}' (data/npc_quests.csv)` });
  }
}

/* ── 저장 · 대화 기록 ───────────────────────────────────────────────────── */

/** 대화 기록의 사건. 글은 저장하지 않고 표에서 다시 푼다 (`NpcQuestRef.getMessages`). */
export type NpcLogEvent = 'intro' | 'offer' | 'accept' | 'decline' | 'brief' | 'complete'
  /** appended (2026-09-14): 첫 연락의 **대사 선택지**에서 내가 고른 대답. */
  | 'choice';
export interface NpcLogEntry {
  at: number; e: NpcLogEvent; q?: string;
  /** `choice` 전용: 고른 번호 (0부터 — `NpcDef.introChoices` 의 색인). */
  c?: number;
}

/** `getMessages` 가 푼 말풍선 한 줄. `quest` = 퀘스트 카드 (상태는 `getQuest(questId)` 로 읽는다). */
export type NpcMessage =
  | { at: number; from: 'npc' | 'me'; text: string }
  | { at: number; from: 'quest'; questId: string }
  | { at: number; from: 'system'; text: string };

export interface NpcQuestSave {
  s: NpcQuestState;
  /** 마지막 상태 변화 (epoch ms). */
  at: number;
  /** 목표별 **확정** 진행 (납품 = 넣은 수량, 레이드 목표 = 확정되면 target 아니면 0). */
  p: number[];
}

/** `MetaSave.npc`. */
export interface NpcSave {
  /** 연락이 온 NPC → 첫 연락 시각 · 마지막으로 읽은 시각. */
  contacts: Record<string, { at: number; readAt: number }>;
  /** NPC → 사건 목록 (오래된 것 → 최근). */
  log: Record<string, NpcLogEntry[]>;
  quests: Record<string, NpcQuestSave>;
  /**
   * appended (2026-09-14): NPC → 누적 **개인 신뢰도 점수**. 레벨은 기업과 같은 `REP_TABLE` 로 환산한다
   * (`shared/meta.repLevelOf`). 없으면 0 (옛 세이브).
   */
  trust?: Record<string, number>;
  /**
   * appended (2026-09-14 3차): 진행 플래그 누적 횟수 (`NpcFlag` → 횟수). 없으면 전부 0 (옛 세이브).
   * 세는 곳도 읽는 곳도 meta/ 하나다 — `NpcRequirement.flags` 의 유일한 입력.
   */
  flags?: Partial<Record<NpcFlag, number>>;
}

/* ── 조회 모양 · `ctx.meta.npc` ─────────────────────────────────────────── */

export interface NpcContactInfo {
  npc: NpcDef;
  /** 마지막 메시지 시각. */
  at: number;
  unread: number;
  /** 목록 한 줄 미리보기. */
  preview: string;
}

export interface NpcObjectiveInfo {
  def: NpcObjectiveDef;
  /** 한국어 목표 문구 (`def.label` 또는 자동 — 아이템 이름 · 행성 이름 · 무기 계열 포함). */
  label: string;
  /** 표시 진행: 확정 진행, 확정 전 레이드 목표는 이번 레이드 진행 (회수 = 지금 몸에 지닌 수). */
  progress: number;
  target: number;
  done: boolean;
  raid: boolean;
  /** 지금 이 레이드에서 셀 수 있다 (레이드 중 · 행성 조건 충족). 함선에서는 false. */
  countsHere: boolean;
  /** deliver: 가방 + 창고 보유 수. */
  have?: number;
  /** deliver: [납품] 을 못 누르는 이유 (함선에서만 · 보유 없음 · 이미 완료), null = 누를 수 있다. */
  blocked: string | null;
}

export interface NpcQuestInfo {
  def: NpcQuestDef;
  npc: NpcDef;
  state: NpcQuestState;
  at: number;
  objectives: readonly NpcObjectiveInfo[];
  /** 목표가 전부 done — [완료 보고] 가능 (state active 일 때). */
  ready: boolean;
  /** [완료 보고] 를 못 누르는 이유 (함선에서만 · 목표 미완 · 공간 없음), null = 누를 수 있다. */
  blocked: string | null;
  /** 0 … 1 전체 진척 (목표별 min(progress/target, 1) 의 평균) — 지도 패널 게이지. */
  progress: number;
}

/**
 * `ctx.meta.npc` — NPC 연락 · 대화 · 퀘스트 (owner: meta/). 선택 속성이라 `ctx.meta?.npc?` 로 읽는다.
 * 모든 변경은 `npc:*` 이벤트를 낸다. 연락 · 제안은 함선에서만 도착한다.
 */
export interface NpcQuestRef {
  /** 연락이 온 NPC, 마지막 메시지가 최근인 순. */
  getContacts(): readonly NpcContactInfo[];
  /** 한 NPC 와의 말풍선들 (오래된 것 → 최근). */
  getMessages(npcId: string): readonly NpcMessage[];
  /** 그 NPC 의 메시지를 읽음으로. `npc:unreadChanged`. */
  markRead(npcId: string): void;
  readonly unreadTotal: number;
  /** hidden 이 아닌 퀘스트 전부 (진행 중 → 보류 → 제안 받음 → 완료, 같은 상태는 최근 순). */
  getQuests(): readonly NpcQuestInfo[];
  getQuest(id: string): NpcQuestInfo | null;
  /** offered | deferred → active (함선). deferred 에서 오면 대화에 brief 가 붙는다. */
  accept(id: string): boolean;
  /**
   * ⚠ **은퇴** (2026-09-14 3차, 사용자 결정 — 「생각해볼게」 선택지 제거). 구현은 늘 false 를 돌려주고
   * 부르는 곳이 없다. 계약은 추가만 하므로 이름만 남긴다 (`airstrike` 와 같은 처리).
   */
  defer(id: string): boolean;
  /** deliver 목표에 가진 만큼(남은 수량까지) 넣는다 (함선). 넣은 수량, 0 = 못 넣음. */
  deliver(questId: string, index: number): number;
  /** active ∧ ready → complete + 보상 (함선). */
  report(id: string): boolean;
  /** 진행 중이고 지금 레이드에서 셀 수 있는 목표가 하나라도 있는 퀘스트 (지도 패널). 레이드 밖이면 빈 배열. */
  getRaidTracks(): readonly NpcQuestInfo[];

  /* ── appended (2026-09-14): 대사 선택지 ── */
  /**
   * 그 NPC 의 첫 연락에 **아직 대답하지 않은** 선택지가 있으면 그 라벨들, 없으면 빈 배열.
   * (= `NpcDef.introChoices` 가 있고 `choice` 사건이 아직 없다.)
   */
  getPendingChoices(npcId: string): readonly string[];
  /**
   * 선택지 하나를 고른다 — 대화에 내 대답과 NPC 의 답 두 줄이 붙는다 (`NpcLogEntry {e:'choice', c}`).
   * 고를 것이 없거나 범위 밖이면 false. **분기는 남지 않는다** — 그 뒤의 대화는 어느 쪽이든 같다.
   */
  chooseIntro(npcId: string, index: number): boolean;

  /* ── appended (2026-09-14 3차): 진행 플래그 (owner: meta) ── */
  /** 그 플래그의 누적 횟수 (없으면 0). */
  flagOf(flag: NpcFlag): number;
  /** 누적 횟수를 더한다 (음수 불가). 바뀌면 연락 조건을 다시 본다. */
  bumpFlag(flag: NpcFlag, delta?: number): void;
}
