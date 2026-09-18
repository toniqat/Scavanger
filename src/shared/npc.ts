/*
 * src/shared/npc.ts — the messenger NPC · NPC quest contract (2026-09-14, docs/DECISIONS.md 「2026-09-14 — 메신저 · NPC 퀘스트 · 단체방」).
 *
 * Corp quests (`data/quests.csv`) are gone; a quest is now given **by an NPC through the messenger**. Corp contracts are unchanged.
 * The source of the numbers and the lines is `data/npcs.csv` · `data/npc_quests.csv` · `data/npc_objectives.csv`, and this file holds only
 * the loader that carries those tables over, the types and the `ctx.meta.npc` (`NpcQuestRef`) contract. The rules (offering · progress ·
 * committing · rewards) are implemented by meta/.
 *
 * Owner: shared/ (the loader and its checks); the rules that read them are owned by meta. Consumers: meta (the engine) · ui (the messenger · the map panel · toasts) · housing (the mining unlock gate — `MetaRef.getQuestState`).
 */
import type { CorpId } from './meta';
import type { StructureKind, WeaponClass } from './types';
import type { PlanetId } from './planets';
import { addDataIssue, csvRows, keyTable } from './data/tables';

type Row = ReturnType<typeof csvRows>[number];

const T = /* data/tuning.csv */ keyTable('tuning.csv');
/** How many events one NPC's conversation log keeps (the oldest go first when it overflows). */
export const NPC_LOG_MAX = T.num('NPC_LOG_MAX');
/** Interval (seconds) at which the first-contact and offer conditions are looked at again while in the ship. */
export const NPC_OFFER_CHECK_S = T.num('NPC_OFFER_CHECK_S');

/* ── Enumerations ───────────────────────────────────────────────────────── */

export const NPC_ROLES = ['executive', 'staff', 'independent'] as const;
/** executive = a corp executive · staff = corp staff · independent = unaffiliated. */
export type NpcRole = typeof NPC_ROLES[number];
export const NPC_ROLE_LABEL_KO: Readonly<Record<NpcRole, string>> = { executive: '임원', staff: '직원', independent: '무소속' };

export const NPC_OBJECTIVE_KINDS = ['deliver', 'recover', 'interact', 'kill', 'discover', 'search'] as const;
export type NpcObjectiveKind = typeof NPC_OBJECTIVE_KINDS[number];
/** Objectives filled inside a raid (the training range excluded). Only `deliver` is filled in the ship. */
export const NPC_RAID_OBJECTIVE_KINDS: ReadonlySet<NpcObjectiveKind> = new Set(['recover', 'interact', 'kill', 'discover', 'search']);

export const NPC_INTERACT_KINDS = ['scanner', 'basement_door', 'lab_door', 'tram', 'rover'] as const;
/** scanner = the map scanner on a structure's roof · basement_door = an outpost basement door (a key) · lab_door = the locked room on a lab's 2nd floor (a keycard) · tram = calling / starting the tram · rover = boarding the rover. */
export type NpcInteractKind = typeof NPC_INTERACT_KINDS[number];

export const NPC_ENEMY_GROUPS = ['humanoid', 'rogue', 'raider', 'android', 'bug', 'named'] as const;
/** The enemy group of a kill objective. Any other value is read as an enemy type id (`data/enemies.csv`) — checked by `npm run data:check`. */
export type NpcEnemyGroup = typeof NPC_ENEMY_GROUPS[number];

const WEAPON_CLASSES: readonly WeaponClass[] = ['AR', 'SMG', 'SR', 'DMR', 'SG', 'PISTOL'];
const STRUCTURE_KINDS: readonly StructureKind[] = ['outpost', 'lab', 'wreck'];
const CORPS: readonly string[] = ['helix', 'bastion', 'nomad', 'ceres'];
const PLANETS: readonly string[] = ['amber', 'tundra', 'mossy', 'ashen', 'crimson'];

/** The `item` column's 「그 계열 총기 아무거나」 (any weapon of that class) notation: `weapon:SG`. */
export const NPC_ITEM_WEAPON_PREFIX = 'weapon:';

/**
 * appended (2026-09-14 3rd pass): **progress flags** — the cumulative counts an NPC's first-contact condition looks at.
 *   `gathered`     how many times something was gathered (herbs · scrap · soil · samples …) — survival does not matter (`gather:collected`).
 *   `raidReturned` how many times a raid was returned from alive (`game:complete`).
 * Append only — an old save reads a flag it does not know as 0.
 */
export const NPC_FLAGS = ['gathered', 'raidReturned'] as const;
export type NpcFlag = typeof NPC_FLAGS[number];

/**
 * ⚠ `'deferred'` **has retired** (2026-09-14 3rd pass, user's decision — the 「생각해볼게」 choice was removed).
 * A new quest only goes `offered` → `accept()` → `active`, and this value stays only so that old saves can be read
 * (the same treatment as `airstrike` · `secondary` — a contract is append-only).
 */
export type NpcQuestState = 'offered' | 'deferred' | 'active' | 'complete';
export const NPC_QUEST_STATE_LABEL_KO: Readonly<Record<NpcQuestState, string>> = {
  offered: '제안 받음', deferred: '보류', active: '진행 중', complete: '완료',
};

/** The messenger's top tabs. */
export type MessengerTab = 'chat' | 'friends' | 'quests';

/** The player's fixed answer attached to a quest card's button (it stays in the conversation log as a 「나」 speech bubble). */
/** ⚠ `decline` · `brief` have retired (2026-09-14 3rd pass — 「생각해볼게」 removed). They are only used to resolve an old log. */
export const NPC_REPLY_KO = {
  accept: '맡겠습니다.',
  decline: '생각해보지.',
  brief: '그 일, 아직 유효합니까?',
  complete: '끝냈습니다. 확인해 주세요.',
} as const;

/* ── Definitions ────────────────────────────────────────────────────────── */

export interface NpcRequirement {
  /** At or above this character level. */
  level?: number;
  /** At or above this corp reputation level (all of them satisfied). */
  rep?: readonly { corp: CorpId; level: number }[];
  /** NPC quest ids that must have been **completed** first (all of them). */
  quests?: readonly string[];
  /**
   * appended (2026-09-14): at or above this **per-NPC** trust level (all of them satisfied). It is separate from corp
   * reputation (`rep`) and uses the same `REP_TABLE` (0–5). The csv column is `reqNpcRep` = "npcId:level" joined with
   * `|`. User's decision 2026-09-14 — **no row uses this condition today** (it only accumulates and displays). The
   * contract is put in place first and what it unlocks is decided later.
   */
  npcRep?: readonly { npc: string; level: number }[];
  /**
   * appended (2026-09-14 3rd pass, user's decision — the four corps' NPCs must not call the moment the tutorial ends):
   * a **progress flag** at or above that count (all of them satisfied). The csv column is `reqFlag` = "flag:count"
   * joined with `|`. The flags are counted in meta/ alone and stored in `NpcSave.flags` — a value that outlives a
   * raid, but nothing except the NPC contact conditions reads it, so it lives in the NPC contract, not the profile.
   */
  flags?: readonly { flag: NpcFlag; count: number }[];
}

export interface NpcDef {
  id: string;
  name: string;
  /** Job title (e.g. `헬릭스 조달실장`). */
  title: string;
  corp: CorpId | null;
  role: NpcRole;
  color: string;
  /** 1–2 characters for the portrait. */
  glyph: string;
  /** First-contact condition. */
  requires: NpcRequirement;
  /** The first-contact speech bubbles. */
  intro: readonly string[];
  bio: string;
  /** File row order. */
  order: number;

  /* ── appended (2026-09-14, the tutorial rework — `docs/DECISIONS.md` 「2026-09-14 — 튜토리얼 개편」) ── */
  /**
   * **Dialogue choices** — the answer buttons that come up after the first-contact bubbles are done (`introChoices`
   * in `data/npcs.csv`, `|` separated). Empty = no choices (every NPC until now). Picking one leaves a single
   * `NpcLogEntry {e:'choice', c}`.
   */
  introChoices?: readonly string[];
  /**
   * The NPC's answer for the number picked (`introChoiceReplies`, `|` separated — the same length as `introChoices`).
   * **The conversation after the pick is the same either way** — no branch state is saved (Raven lets any answer pass).
   */
  introChoiceReplies?: readonly string[];

  /* ── appended (2026-09-14 3rd pass, user's decision — first contact is 「짧은 인사 → 선택지 → 본론」) ── */
  /**
   * The NPC's speech bubbles that follow **after** the choice has been answered (`introAfter` in `data/npcs.csv`,
   * `|` separated). `intro` is now the 1–3 lines **before** the choices, and the main point (introducing themselves ·
   * the errand) comes here. An NPC with this row **does not offer a quest before the choice is answered**
   * (`NpcQuests.evaluate`). Empty = only `intro`, as until now, and the offer comes straight away.
   */
  introAfter?: readonly string[];
}

export interface NpcObjectiveDef {
  quest: string;
  /** Its order within that quest (from 0, the file row order). */
  index: number;
  kind: NpcObjectiveKind;
  target: number;
  /** deliver · recover: an item id or `weapon:<class>`. */
  item?: string;
  /** kill: an `NpcEnemyGroup` or an enemy type id. */
  enemy?: string;
  /** kill: only a last hit from that weapon class. */
  weapon?: WeaponClass;
  /** discover · search. */
  site?: StructureKind;
  /** interact. */
  interact?: NpcInteractKind;
  /** Raid objectives only: counted on that planet alone. */
  planet?: PlanetId;
  /** Objectives of the same quest with the same chain must all be filled within one raid to commit together. */
  chain?: string;
  /** An objective line to use instead of the automatic wording. */
  label?: string;
}

export interface NpcQuestDef {
  id: string;
  npc: string;
  name: string;
  /** The quest card's description. */
  summary: string;
  /** Offer condition. */
  requires: NpcRequirement;
  objectives: readonly NpcObjectiveDef[];
  rewards: {
    credits: number;
    xp: number;
    rep: readonly { corp: CorpId; amount: number }[];
    items: readonly { defId: string; qty: number }[];
    /**
     * appended (2026-09-14, user's decision): per-NPC trust reward for **the NPC who gave** this quest (csv column
     * `npcTrust`). It is paid together with corp reputation (`rep`) and neither replaces the other — an unaffiliated
     * NPC (`레이븐` · `케인`) gives only this.
     */
    npcTrust: number;
  };
  /** Dialogue (one speech bubble per entry). */
  lines: { offer: readonly string[]; accept: readonly string[]; decline: readonly string[]; brief: readonly string[]; complete: readonly string[] };
  /** File row order (the offer order within the same NPC). */
  order: number;
}

/* ── Loader ─────────────────────────────────────────────────────────────── */

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

/** appended (2026-09-14): `reqNpcRep` = "npcId:level" joined with `|`. `pairList` is corp-only, so this is parsed separately. */
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

/** appended (2026-09-14 3rd pass): `reqFlag` = "flag:count" joined with `|`. */
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
  // 2026-09-14: dialogue choices — both must be empty, or hold the same number of entries (the answer is found by the number picked).
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
  /* Columns each kind must have · columns it does not use */
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
      /* appended (2026-09-14): per-NPC trust for the NPC who gave this quest */
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

/* ── Save · conversation log ────────────────────────────────────────────── */

/** An event in the conversation log. The text is not saved but resolved again from the tables (`NpcQuestRef.getMessages`). */
export type NpcLogEvent = 'intro' | 'offer' | 'accept' | 'decline' | 'brief' | 'complete'
  /** appended (2026-09-14): the answer I picked from first contact's **dialogue choices**. */
  | 'choice';
export interface NpcLogEntry {
  at: number; e: NpcLogEvent; q?: string;
  /** `choice` only: the number picked (from 0 — an index into `NpcDef.introChoices`). */
  c?: number;
}

/** One speech bubble resolved by `getMessages`. `quest` = a quest card (its state is read with `getQuest(questId)`). */
export type NpcMessage =
  | { at: number; from: 'npc' | 'me'; text: string }
  | { at: number; from: 'quest'; questId: string }
  | { at: number; from: 'system'; text: string };

export interface NpcQuestSave {
  s: NpcQuestState;
  /** The last state change (epoch ms). */
  at: number;
  /** **Committed** progress per objective (deliver = the quantity handed in, a raid objective = target once committed, else 0). */
  p: number[];
}

/** `MetaSave.npc`. */
export interface NpcSave {
  /** NPCs that made contact → the first-contact time · the last time it was read. */
  contacts: Record<string, { at: number; readAt: number }>;
  /** NPC → its event list (oldest → most recent). */
  log: Record<string, NpcLogEntry[]>;
  quests: Record<string, NpcQuestSave>;
  /**
   * appended (2026-09-14): NPC → cumulative **per-NPC trust score**. The level is converted with the same `REP_TABLE`
   * as a corp's (`shared/meta.repLevelOf`). Absent = 0 (an old save).
   */
  trust?: Record<string, number>;
  /**
   * appended (2026-09-14 3rd pass): the cumulative counts of the progress flags (`NpcFlag` → count). Absent = all 0 (an old save).
   * Both the counting and the reading happen in meta/ alone — the only input of `NpcRequirement.flags`.
   */
  flags?: Partial<Record<NpcFlag, number>>;
}

/* ── Query shapes · `ctx.meta.npc` ──────────────────────────────────────── */

export interface NpcContactInfo {
  npc: NpcDef;
  /** The time of the last message. */
  at: number;
  unread: number;
  /** The one-line preview in the list. */
  preview: string;
}

export interface NpcObjectiveInfo {
  def: NpcObjectiveDef;
  /** Korean objective wording (`def.label`, or automatic — item name · planet name · weapon class included). */
  label: string;
  /** Displayed progress: the committed progress, or, for a raid objective before it commits, this raid's progress (recover = how many are carried right now). */
  progress: number;
  target: number;
  done: boolean;
  raid: boolean;
  /** It can be counted in this raid right now (in a raid · the planet condition met). false in the ship. */
  countsHere: boolean;
  /** deliver: how many are held in the bag + stash. */
  have?: number;
  /** deliver: why `납품` cannot be pressed (in the ship only · none held · already done), null = it can be pressed. */
  blocked: string | null;
}

export interface NpcQuestInfo {
  def: NpcQuestDef;
  npc: NpcDef;
  state: NpcQuestState;
  at: number;
  objectives: readonly NpcObjectiveInfo[];
  /** Every objective is done — `완료 보고` is possible (while state is active). */
  ready: boolean;
  /** Why `완료 보고` cannot be pressed (in the ship only · objectives unfinished · no room), null = it can be pressed. */
  blocked: string | null;
  /** 0 … 1 overall progress (the average of min(progress/target, 1) per objective) — the map panel's gauge. */
  progress: number;
}

/**
 * `ctx.meta.npc` — NPC contacts · conversations · quests (owner: meta/). It is an optional property, so it is read as `ctx.meta?.npc?`.
 * Every change emits an `npc:*` event. Contacts and offers only arrive in the ship.
 */
export interface NpcQuestRef {
  /** The NPCs that made contact, most recent last message first. */
  getContacts(): readonly NpcContactInfo[];
  /** The speech bubbles with one NPC (oldest → most recent). */
  getMessages(npcId: string): readonly NpcMessage[];
  /** Marks that NPC's messages as read. `npc:unreadChanged`. */
  markRead(npcId: string): void;
  /**
   * appended (2026-09-15, user's decision — 「확인해야 다음 메시지가 온다」): the time that NPC's conversation was
   * **last read** (epoch ms, 0 with no contact or if it was never read). A speech bubble whose `at` is greater than
   * this value is 「not read yet」, and the messenger resolves them one at a time from that line with the `...` typing
   * animation (`ui/menus/messenger/ChatTab`).
   *
   * ⚠ **One event resolves into several speech bubbles** (`getMessages` — a single `intro` spreads into the whole of
   * `NpcDef.intro`), so `NpcContactInfo.unread` (an event count) cannot count bubbles. Bubbles from the same event
   * share an `at`, so this one time draws the boundary exactly. It is optional, so an implementation without it (a
   * debug ref) is taken to have **read everything**.
   */
  readAtOf?(npcId: string): number;
  readonly unreadTotal: number;
  /** Every quest that is not hidden (active → deferred → offered → complete; within one state, most recent first). */
  getQuests(): readonly NpcQuestInfo[];
  getQuest(id: string): NpcQuestInfo | null;
  /** offered | deferred → active (ship). Coming from deferred attaches a brief to the conversation. */
  accept(id: string): boolean;
  /**
   * ⚠ **Retired** (2026-09-14 3rd pass, user's decision — the 「생각해볼게」 choice was removed). The implementation
   * always returns false and nothing calls it. A contract is append-only, so only the name stays (the same treatment as `airstrike`).
   */
  defer(id: string): boolean;
  /** Puts in as many as are held (up to the quantity left) toward a deliver objective (ship). Returns how many went in, 0 = none could. */
  deliver(questId: string, index: number): number;
  /** active ∧ ready → complete + rewards (ship). */
  report(id: string): boolean;
  /** Quests that are active and have at least one objective countable in this raid (the map panel). An empty array outside a raid. */
  getRaidTracks(): readonly NpcQuestInfo[];

  /* ── appended (2026-09-14): dialogue choices ── */
  /**
   * The labels of that NPC's first-contact choices while they are **not answered yet**, else an empty array.
   * (= `NpcDef.introChoices` exists and there is no `choice` event yet.)
   */
  getPendingChoices(npcId: string): readonly string[];
  /**
   * Picks one choice — my answer and the NPC's reply are attached to the conversation as two lines
   * (`NpcLogEntry {e:'choice', c}`). false when there is nothing to pick or the index is out of range. **No branch
   * is left behind** — the conversation afterwards is the same either way.
   */
  chooseIntro(npcId: string, index: number): boolean;

  /* ── appended (2026-09-14 3rd pass): progress flags (owner: meta) ── */
  /** The cumulative count of that flag (0 when there is none). */
  flagOf(flag: NpcFlag): number;
  /** Adds to the cumulative count (no negatives). A change makes the contact conditions be looked at again. */
  bumpFlag(flag: NpcFlag, delta?: number): void;
}
