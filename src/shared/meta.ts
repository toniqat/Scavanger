import type { AmmoType, EmbeddedView, ItemCategory, ItemDef, ItemInstance, MissionStats, Rarity, WeaponClass } from './types';
import { addDataIssue, csvGroups, csvRows, keyTable, numberList, stringList } from './data/tables';
import { buyPriceFrom, sellPriceFrom } from './credits';
import { formatCompactNumber } from './numberFormat';

/*
 * 메타 수치의 원본은 `data/` 의 csv 다 — 기업(`corps.csv` · `corp_stock.csv`), 계약(`contracts.csv`),
 * 퀘스트(`quests.csv`), 신뢰도 표와 등급 상한(`tables.csv`), 크레딧 · 가격 계수(`tuning.csv`).
 * 이 파일에는 표가 없고 계약 타입과 그 줄들을 옮기는 코드만 있다.
 */
const T = /* data/tuning.csv */ keyTable('tuning.csv');

/* ────────────────────────────────────────────────────────────────────────────
 * Phase 5-c — corporations, reputation, contracts, quests, credits and the corp shop.
 * Owner: meta/MetaSystem publishes `ctx.meta` and persists everything in localStorage `META_STORAGE_KEY`.
 * Character XP / level stay with progression/ (`ctx.progression.addXp`); the stash stays with inventory/.
 * Data (corp catalogue, contract and quest drafts) lives here like `FURNITURE_DEFS`, so hub / ui / inventory
 * can label things without importing meta/.
 * ──────────────────────────────────────────────────────────────────────────── */

export type CorpId = 'helix' | 'bastion' | 'nomad' | 'ceres';
export const CORP_IDS: readonly CorpId[] = ['helix', 'bastion', 'nomad', 'ceres'];

/**
 * One line of a corp's shop stock. An `ItemDef` is sold by a corp when any rule matches: same `category`; for
 * weapons the `WeaponDef.weaponClass` must be in `weaponClasses` (when given); for ammo `ItemDef.ammoType` in
 * `ammoTypes`; for bags `tactical` must match `BagDef.tactical` (when given). `minRepLevel` hides the whole rule
 * below that reputation level. Unique weapons are never sold. Rarity is capped by `SHOP_RARITY_CAP_BY_REP`.
 */
export interface ShopRule {
  category: ItemCategory;
  weaponClasses?: readonly WeaponClass[];
  ammoTypes?: readonly AmmoType[];
  tactical?: boolean;
  minRepLevel?: number;
  /* appended (Phase 12, 2026-09-08 — meta): 임플란트 stock */
  /**
   * Highest rarity this rule sells, on top of `SHOP_RARITY_CAP_BY_REP`. 세레스 바이오 stocks common / uncommon stat
   * implants only — rare and better come from quests and the 임플란트 수리 desk, never the shelf.
   */
  maxRarity?: Rarity;
  /**
   * `category: 'material'` only: sell every material that appears in some implant's `ItemDef.implant.repairCost`
   * (resolved from the live item defs, so the shelf follows items/ without listing ids here). Broken implants
   * themselves are never sold by any rule.
   */
  implantRepairMaterials?: boolean;
}

export interface CorpDef {
  id: CorpId;
  name: string;        // 한국어
  tagline: string;     // 한국어 slogan
  description: string; // 한국어, one sentence on what they buy / sell
  /** Accent colour (CSS). */
  color: string;
  stock: readonly ShopRule[];
}

const CORP_STOCK_BY_ID = csvGroups('corp_stock.csv', 'corp');

export const CORP_DEFS: Readonly<Record<CorpId, CorpDef>> = Object.fromEntries(csvRows('corps.csv').map((r) => {
  const id = r.str('id') as CorpId;
  const stock: ShopRule[] = (CORP_STOCK_BY_ID.get(id) ?? []).map((k) => ({
    category: k.str('category') as ItemCategory,
    ...(k.has('weaponClasses') ? { weaponClasses: k.list('weaponClasses') as WeaponClass[] } : {}),
    ...(k.has('ammoTypes') ? { ammoTypes: k.list('ammoTypes') as AmmoType[] } : {}),
    ...(k.has('tactical') ? { tactical: k.bool('tactical') } : {}),
    ...(k.has('minRepLevel') ? { minRepLevel: k.int('minRepLevel', { min: 0 }) } : {}),
    ...(k.has('maxRarity') ? { maxRarity: k.str('maxRarity') as Rarity } : {}),
    ...(k.has('implantRepairMaterials') ? { implantRepairMaterials: k.bool('implantRepairMaterials') } : {}),
  }));
  return [id, {
    id, name: r.str('name'), tagline: r.str('tagline'), description: r.str('description'),
    color: r.str('color'), stock,
  }];
})) as unknown as Record<CorpId, CorpDef>;

/* ── reputation ── */
/** Cumulative reputation needed to reach level L (index = level). Level 0..REP_LEVEL_MAX. */
export const REP_TABLE: readonly number[] = numberList('tables.csv', 'REP_TABLE');
export const REP_LEVEL_MAX = REP_TABLE.length - 1;
/** Reputation level at which a corp's shop opens. */
export const SHOP_UNLOCK_REP_LEVEL = T.num('SHOP_UNLOCK_REP_LEVEL');
/** Highest rarity sold at each reputation level (index = level). Bags get one extra step (`SHOP_BAG_RARITY_BONUS`). */
export const SHOP_RARITY_CAP_BY_REP: readonly Rarity[] = stringList('tables.csv', 'SHOP_RARITY_CAP_BY_REP') as Rarity[];
export const SHOP_BAG_RARITY_BONUS = T.num('SHOP_BAG_RARITY_BONUS');
/**
 * appended (2026-09-17): reputation level at which a corp can be selected in the Tab window's 기업 tab. While **every**
 * corp is below it the 기업 screen tab itself is hidden (`inventory/ui/parts/Screens.markTab`) and `openCorpMenu` refuses.
 */
export const CORP_ACCESS_REP_LEVEL = T.num('CORP_ACCESS_REP_LEVEL');
/** appended (2026-09-17): true when at least one corp's level (`levelOf`) reaches `CORP_ACCESS_REP_LEVEL`. */
export function anyCorpAccessible(levelOf: (corp: CorpId) => number): boolean {
  return CORP_IDS.some((c) => levelOf(c) >= CORP_ACCESS_REP_LEVEL);
}
/** Reputation level from cumulative `rep`. */
export function repLevelOf(rep: number): number {
  let lv = 0;
  for (let i = 1; i < REP_TABLE.length; i++) if (rep >= REP_TABLE[i]) lv = i;
  return lv;
}

/* ── credits / prices ── */
export const CREDITS_INITIAL = T.num('CREDITS_INITIAL');
export const CREDITS_MAX = T.num('CREDITS_MAX');
/** Buy price = value × max(SHOP_PRICE_MIN_MUL, SHOP_PRICE_BASE_MUL − SHOP_PRICE_DISCOUNT_PER_REP × repLevel). */
export const SHOP_PRICE_BASE_MUL = T.num('SHOP_PRICE_BASE_MUL');
export const SHOP_PRICE_DISCOUNT_PER_REP = T.num('SHOP_PRICE_DISCOUNT_PER_REP');
export const SHOP_PRICE_MIN_MUL = T.num('SHOP_PRICE_MIN_MUL');
/** Sell price = value × SELL_PRICE_MUL (any corp, any item with a value). */
export const SELL_PRICE_MUL = T.num('SELL_PRICE_MUL');
/*
 * Both prices are the pure formulas of `shared/credits` (2026-09-11, E-9) — that file is the single original because
 * the relay imports it and cannot run the csv loader. Only the multipliers come from here. `sellPriceFrom` **floors**:
 * see its comment for why rounding let a split stack out-earn the bundle.
 */
export function buyPriceOf(value: number, repLevel: number): number {
  return buyPriceFrom(value, SHOP_PRICE_BASE_MUL, SHOP_PRICE_DISCOUNT_PER_REP, SHOP_PRICE_MIN_MUL, repLevel);
}
export function sellPriceOf(value: number, qty = 1): number {
  return sellPriceFrom(value, SELL_PRICE_MUL, qty);
}

/* ── contracts ── */
export type ContractGoalKind = 'kill_bugs' | 'kill_rogues' | 'open_crates' | 'loot_corpses' | 'extract_with_value' | 'use_stratagems'
  /* appended 2026-09-12 (E2): 특정 아이템 회수 — `ContractDef.itemDefId` 를 `target` 개 몸에 지니고 탈출한다 */
  | 'extract_with_items';
export const CONTRACT_GOAL_LABEL_KO: Readonly<Record<ContractGoalKind, string>> = {
  kill_bugs: '터미니드 처치', kill_rogues: '인간형 적 처치', open_crates: '상자 개봉', loot_corpses: '시체 수색',
  extract_with_value: '전리품 가치와 함께 탈출', use_stratagems: '함선 지원 사용',
  extract_with_items: '아이템 회수',
};

export interface ContractDef {
  id: string;
  corp: CorpId;
  /** Reputation level needed to accept. */
  minRepLevel: number;
  goal: ContractGoalKind;
  target: number;
  repReward: number;
  xpReward: number;
  creditsReward: number;
  name: string;   // 한국어
  desc: string;   // 한국어
  /* appended 2026-09-12 (E2): 특정 아이템 회수 */
  /**
   * `goal === 'extract_with_items'` 일 때만: 회수할 아이템 def id (`data/contracts.csv` 의 `itemDefId` 열), `target` = 개수.
   * **가방 격자 + 퀵슬롯 + 주머니**(`InventoryRef.countWhere` — 몸에 지닌 것 전부, 창고 제외)를 탈출 순간에 센다.
   * 다른 목표에는 없다. 알 수 없는 id 는 `npm run data:check` 가 잡는다 (`scripts/data-check.mjs`).
   */
  itemDefId?: string;
}

/** Progress a squadmate's contract action is worth to us when we run a contract of the same corp. */
export const CONTRACT_SQUAD_SHARE = T.num('CONTRACT_SQUAD_SHARE');
/** Contracts active at once. */
export const CONTRACT_MAX_ACTIVE = T.num('CONTRACT_MAX_ACTIVE');

export const CONTRACT_DEFS: readonly ContractDef[] = csvRows('contracts.csv').map((r) => {
  const goal = r.enum('goal', ['kill_bugs', 'kill_rogues', 'open_crates', 'loot_corpses', 'extract_with_value', 'use_stratagems', 'extract_with_items'] as const);
  /* 2026-09-12 (E2): `itemDefId` 는 아이템 회수 계약에만 있고, 그 계약에는 반드시 있다. */
  const itemDefId = r.optStr('itemDefId');
  if (goal === 'extract_with_items' && !itemDefId) r.str('itemDefId');          // 빈 칸 → 「값이 비었다」 문제
  else if (goal !== 'extract_with_items' && itemDefId) {
    addDataIssue({ file: r.file, line: r.line, column: 'itemDefId', message: `'${goal}' 계약에는 itemDefId 가 쓰이지 않는다` });
  }
  return {
    id: r.str('id'),
    corp: r.str('corp') as CorpId,
    minRepLevel: r.int('minRepLevel', { min: 0 }),
    goal,
    target: r.int('target', { min: 1 }),
    repReward: r.int('repReward', { min: 0 }),
    xpReward: r.int('xpReward', { min: 0 }),
    creditsReward: r.int('creditsReward', { min: 0 }),
    name: r.str('name'),
    desc: r.str('desc'),
    ...(goal === 'extract_with_items' && itemDefId ? { itemDefId } : {}),
  };
});

/* ── quests ── */
export type QuestState = 'locked' | 'available' | 'accepted' | 'complete';

export interface QuestDef {
  id: string;
  corp: CorpId;
  name: string;   // 한국어
  desc: string;   // 한국어
  requires: { repLevel?: number; quests?: readonly string[] };
  deliver: readonly { defId: string; qty: number }[];
  rewards: { rep: number; xp: number; credits?: number; items?: readonly { defId: string; qty: number }[] };
}

/*
 * 2026-09-14: 기업 퀘스트 폐지 (docs/DECISIONS.md 「2026-09-14 — 메신저 · NPC 퀘스트 · 단체방」, 사용자 결정 「전부 삭제」) — 퀘스트는 NPC 가 메신저로 준다
 * (`shared/npc.ts` 의 `NPC_QUEST_DEFS`). `data/quests.csv` 는 지웠고, 타입 · 이름은 계약이라 남기고 표만 비운다.
 */
export const QUEST_DEFS: readonly QuestDef[] = [];

/* ── runtime shapes ── */
export interface RepInfo {
  rep: number;
  level: number;
  /** Cumulative rep needed for the next level, null at REP_LEVEL_MAX. */
  next: number | null;
}

export interface ShopItem {
  def: ItemDef;
  price: number;
  /** 한국어 reason the line cannot be bought right now (신뢰도 부족 / 크레딧 부족 / 공간 없음), null = buyable. */
  blocked: string | null;
}

export interface ContractInfo {
  def: ContractDef;
  progress: number;
  /** true when this is the accepted contract. */
  active: boolean;
  /** 한국어 reason it cannot be accepted (신뢰도 부족 / 이미 진행 중인 계약), null = acceptable. */
  blocked: string | null;
}

export interface QuestInfo {
  def: QuestDef;
  state: QuestState;
  /** Delivery lines with what the player holds (bag + stash). */
  deliver: readonly { defId: string; qty: number; have: number }[];
  /** 한국어 reason `completeQuest` would fail, null = deliverable. */
  blocked: string | null;
}

/** Result of settling the active contract at the end of a mission (`MissionStats.contract`). */
export interface ContractSettlement {
  id: string;
  corp: CorpId;
  name: string;
  success: boolean;
  progress: number;
  target: number;
  rep: number;
  xp: number;
  credits: number;
  /* appended (Phase 7) */
  /**
   * `'success'` = extracted with the goal met (rewards paid) · `'incomplete'` = extracted short of the goal (progress
   * kept) · `'failed'` = the raid failed (death / squad wipe: no rep even when the goal was met, progress rolled back
   * to the mission start). Optional so older producers keep compiling; ui derives 미완 / 실패 from it, never from
   * `ctx.stats.extracted`.
   */
  outcome?: 'success' | 'incomplete' | 'failed';
}

/** localStorage `META_STORAGE_KEY`. Bump `v` when the shape changes. */
export interface MetaSave {
  v: number;
  credits: number;
  corps: Record<CorpId, { rep: number; quests: Record<string, QuestState> }>;
  activeContract: { id: string; progress: number } | null;
  /** Lifetime counters for the terminal / corp screen. */
  stats: { contractsDone: number; questsDone: number; creditsEarned: number; creditsSpent: number };
}

export interface MetaRef {
  readonly credits: number;
  /** Ship / result screens: current numbers. */
  getRep(corp: CorpId): RepInfo;
  /**
   * Add (or remove, negative) credits. Returns false — and changes nothing — when the balance would go below 0.
   * Emits `meta:creditsChanged`.
   */
  addCredits(delta: number, reason: string): boolean;
  /** Add reputation (never below 0). Emits `meta:repChanged`; a level gain also toasts. */
  addRep(corp: CorpId, delta: number, reason: string): void;

  /* shop (ship only: `buy` / `sell` refuse during a raid) */
  /** Every line the corp sells at the current reputation level, with prices and blocking reasons. Empty below `SHOP_UNLOCK_REP_LEVEL`. */
  getShop(corp: CorpId): ShopItem[];
  /** Buy price for `defId` at `corp`, or null when the corp does not sell it at the current level. */
  priceOf(corp: CorpId, defId: string): number | null;
  /** Consume credits, create a fresh instance (`ctx.loot.createItem`) into the bag, else the stash. False when blocked. */
  buy(corp: CorpId, defId: string): boolean;
  /** Credits `sell(uid, qty)` would pay (bag or stash item), null when unknown / equipped. */
  sellPriceOf(uid: string, qty?: number): number | null;
  /** Remove `qty` units (default: the whole stack) from the bag / stash and pay `sellPriceOf`. Emits `meta:sale`. */
  sell(uid: string, qty?: number): boolean;
  /** Bag + stash items that can be sold (anything with a value that is not equipped). */
  getSellable(): readonly ItemInstance[];

  /* contracts */
  getContracts(corp: CorpId): ContractInfo[];
  readonly activeContract: ContractInfo | null;
  /** Ship only, one at a time, rep level gated. Emits `meta:contractAccepted`. */
  acceptContract(id: string): boolean;
  /** Drops the active contract (progress lost). Emits `meta:contractAbandoned`. */
  abandonContract(): boolean;
  /**
   * Progress the active contract when its goal matches. `local` false = a squadmate's action relayed over `meta contractHit`
   * (worth `amount × CONTRACT_SQUAD_SHARE`). Emits `meta:contractProgress`.
   */
  reportContractHit(goal: ContractGoalKind, amount: number, local: boolean): void;
  /**
   * End-of-mission settlement, called by game/GameFlowSystem before `game:complete` / `game:over` (also usable by a smoke
   * test with fake stats). `extract_with_value` reads `stats.lootValue`. Success (extracted + progress ≥ target) pays rep / xp /
   * credits and clears the contract; extraction without completion keeps the progress; death keeps only the progress the
   * mission started with. Returns the settlement (null without an active contract) and emits `meta:contractSettled`.
   */
  settleMission(stats: MissionStats): ContractSettlement | null;

  /* quests */
  getQuests(corp: CorpId): QuestInfo[];
  getQuestState(id: string): QuestState;
  /** available → accepted (ship only). Emits `meta:questChanged`. */
  acceptQuest(id: string): boolean;
  /** accepted → complete: consumes the delivery from bag + stash (`inventory.consumeDefAll`), pays the rewards (items to bag, else stash). */
  completeQuest(id: string): boolean;

  /* corp screen (owner: meta/ui, blocker token 'corp', emits `ui:corpToggled`) */
  openCorpMenu(corp?: CorpId): void;
  closeCorpMenu(): void;
  readonly isMenuOpen: boolean;

  /* persistence */
  save(): void;
  /** Wipe back to a fresh save (credits `CREDITS_INITIAL`, rep 0, no contract, quests locked/available). */
  resetMeta(): void;

  /* ══ appended: Phase 8 (2026-09-06) ══════════════════════════════════════ */
  /**
   * Render the 기업 네트워크 screen inside `host` (the 기업 tab of the inventory Tab screen) instead of as its own
   * full-screen overlay. The embedded view reuses the standalone screen's renderers so both stay in sync; it must not
   * add the `'corp'` blocker or exit the pointer lock — the inventory window already owns both.
   */
  createCorpView(host: HTMLElement): EmbeddedView;

  /* ══ appended: Phase 9 UI pass (2026-09-07) ════════════════════════ */
  /**
   * Every squad member's active contract as last broadcast over `meta contract` (the local player is **not** in the
   * list — the HUD reads `activeContract` for that). Cleared at `game:newMission` and when the lobby goes away, so it
   * only ever describes the running mission. Read by `ui/hud/ContractPanel`.
   */
  getSquadContracts(): readonly SquadContractInfo[];
}

/** One squad member's contract as seen from here (`meta contract` broadcast; `ui/hud/ContractPanel` renders it). */
export interface SquadContractInfo {
  /** PeerId of the member (a plain string — meta/ never needs the branded net type). */
  peer: string;
  /** Contract def id; the def itself is resolved from `CONTRACT_DEFS` by the reader. */
  id: string;
  progress: number;
}

/* ══ appended: Phase 10 — 크레딧 표기 (2026-09-07) ══════════════════════════════════════════════════════════════
 * Every credit readout in the game renders `100 C`. The old `₩ 100` prefix (`inventory/ui/labels.ts fmtValue`) and the
 * bare `100 cr` suffix (`ui/hud/ItemTip`, `meta/ui/CorpView`) are both replaced by these helpers, so there is exactly
 * one formatter. `크레딧` stays as a *word* in sentences (toasts, quest rewards); the unit suffix is `C`.
 * ────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** Credit unit suffix. Never a prefix, never `₩` / `\`. */
export const CREDIT_SUFFIX = 'C';

/**
 * `100` → `'100 C'`; `9999` → `'9,999 C'`; `12345` → `'12.3k C'`. `sign` prefixes `+` / `−`; `suffix: false` drops the ` C`.
 *
 * 2026-09-16 (사용자 결정): 10,000 부터는 `shared/numberFormat.ts` 의 축약 표기(`10.0k` · `1.00m` · `1.00b`)를 쓴다 —
 * 크레딧은 자릿수가 얼마든 커지는 값이라 쉼표만으로는 한눈에 안 읽힌다. 규칙과 이유는 그 파일에 있다.
 */
export function formatCredits(n: number, opts?: { sign?: boolean; suffix?: boolean }): string {
  const v = Math.round(Number.isFinite(n) ? n : 0);
  const body = formatCompactNumber(v);
  const sign = opts?.sign ? (v < 0 ? '−' : '+') : (v < 0 ? '−' : '');
  const tail = opts?.suffix === false ? '' : ` ${CREDIT_SUFFIX}`;
  return `${sign}${body}${tail}`;
}

/** Grouped number without the unit, for a pill that carries its own `CREDITS` eyebrow. */
export function formatCreditAmount(n: number): string {
  return formatCredits(n, { suffix: false });
}

/** The credit value of an item: `ItemDef.value × qty`. 0 for a missing def. */
export function itemCreditValue(def: Pick<ItemDef, 'value'> | null | undefined, qty = 1): number {
  if (!def || !Number.isFinite(def.value)) return 0;
  return Math.max(0, Math.round(def.value * Math.max(1, Math.floor(qty))));
}

/* ══ appended: 2026-09-13 — 암호화폐 매매 (docs/DECISIONS.md 「2026-09-13 — 가구 접근 면 · 발전기 · 암호화폐 채굴」) ══ */
export interface MetaRef {
  /**
   * 크레딧 트랜잭션을 **끝까지 기다린다** (meta 밖 폴더용 — housing 의 거래소). 릴레이가 있으면 `addCredits` 처럼 낙관적으로 적용하고
   * `credits:tx` 의 답을 기다려 `{ok: true}`, 거절이면 잔액을 되돌린 뒤 `{ok: false, reason}` (한국어). 오프라인이면 `addCredits` 와 같은
   * 검사만 하고 곧바로 끝난다. `reason` 은 `formatCreditReason` 문법이어야 한다 (릴레이가 해석한다).
   */
  creditsTx?(delta: number, reason: string): Promise<{ ok: boolean; reason?: string }>;
}

/* ══ appended: 2026-09-14 — 메신저 · NPC 퀘스트 (docs/DECISIONS.md 「2026-09-14 — 메신저 · NPC 퀘스트 · 단체방」 · 계약 본문은 `shared/npc.ts`) ══
 * 기업 퀘스트는 없어졌다. `getQuests(corp)` 는 빈 목록, `acceptQuest` · `completeQuest` 는 false 이고,
 * `getQuestState(id)` 는 **NPC 퀘스트**로 답한다 — complete → 'complete', active → 'accepted', offered/deferred → 'available', 그 밖 → 'locked'
 * (housing 채굴 해금 게이트가 이 한 줄에 기댄다). */
import type { NpcQuestRef, NpcSave } from './npc';

export interface MetaRef {
  /** NPC 연락 · 대화 · 퀘스트 (owner: meta/parts). 선택 속성 — `ctx.meta?.npc?`. */
  readonly npc?: NpcQuestRef;
}

export interface MetaSave {
  /** 2026-09-14: NPC 연락 · 대화 기록 · 퀘스트 상태. 없으면 빈 것 (옛 세이브). `corps[corp].quests` 는 더 이상 쓰지 않는다. */
  npc?: NpcSave;
}
/* ══ end 2026-09-14 메신저 · NPC 퀘스트 ══ */

/* ══ appended: 2026-09-14 — 정보상 · NPC 개인 신뢰도 (docs/DECISIONS.md 「2026-09-14 — 정보상」, 계약 본문은 `shared/intel.ts`) ══ */
import type { IntelEffects, IntelGimmick, IntelPick, IntelSpec } from './intel';
import type { PlanetId } from './planets';

/**
 * 정보상(레이븐)에서 산 「행성 정보」 = 그 레이드의 기믹 고정. 한 번에 **하나만** 갖고 프로필에 저장되며
 * 그 행성으로 출격해 레이드가 끝나면 소모된다. 멀티에서 사는 사람은 **분대장뿐**이다 (탐사 차량 요금의
 * 「결제자 한 명」 규약과 같다) — 비호스트의 `buy` · `discard` 는 조용히 false / no-op 다.
 */
export interface IntelRef {
  /** 지금 보유한 정보 (없으면 null). */
  get(): IntelSpec | null;
  /** 보유 정보의 해석본 (`ctx.missionIntel` 에 실릴 값). 없으면 null. */
  effects(): IntelEffects | null;
  /** 이 행성에서 이 선택의 총 크레딧 비용 (`shared/intel.intelCost`). */
  costOf(planet: PlanetId, picks: readonly IntelPick[]): number;
  /** 이 행성에서 이 기믹의 최대 단계. **0 = 그 행성에서는 잠김** (네임드는 threat 2 이상에서만). */
  maxTierOf(g: IntelGimmick, planet: PlanetId): number;
  /**
   * 구매. 크레딧을 `intel:<planet>:<code>` 사유로 내고 보유 정보를 갈아 끼운다 (이미 있으면 덮어쓴다 — 환불 없음).
   * 크레딧 부족 · 비호스트 · 빈 선택이면 null. 성공하면 `intel:purchased` + `intel:changed`.
   */
  buy(planet: PlanetId, seed: number, picks: readonly IntelPick[]): IntelSpec | null;
  /** 「지역 재배치」 — 보유 정보를 버린다. **환불 없음** (사용자 결정). `intel:changed {spec:null}`. */
  discard(): void;
  /** 레이드가 이 정보를 썼다 (`game:complete` · `game:over` · `game:abort` 정산 뒤). */
  consume(): void;
}

export interface MetaRef {
  /** 정보상 (owner: meta/parts/Intel). 선택 속성 — `ctx.meta?.intel?`. */
  readonly intel?: IntelRef;
  /**
   * NPC 개인 신뢰도 — 기업 신뢰도(`getRep`)와 **별개**이고 같은 `REP_TABLE`(0–5)을 쓴다. 2026-09-14 사용자 결정:
   * 지금은 **적립 · 표시까지만** 하고 이것으로 잠기는 것은 아직 없다.
   */
  npcTrust(npcId: string): number;
  npcTrustLevel(npcId: string): number;
  /** NPC 신뢰도를 더한다 (음수 가능, 0 밑으로는 안 내려간다). `meta:npcTrustChanged`. */
  addNpcTrust(npcId: string, delta: number, reason: string): void;
}

export interface MetaSave {
  /** 2026-09-14: 보유 중인 정보상 정보 (없으면 안 샀다). 읽을 때 `sanitizeIntelSpec` 를 지난다. */
  intel?: IntelSpec | null;
}
/* ══ end 2026-09-14 정보상 · NPC 신뢰도 ══ */
