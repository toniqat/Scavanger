import type { AmmoType, EmbeddedView, ItemCategory, ItemDef, ItemInstance, MissionStats, Rarity, WeaponClass } from './types';
import { csvGroups, csvRows, keyTable, numberList, stringList } from './data/tables';
import { buyPriceFrom, sellPriceFrom } from './credits';

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
export type ContractGoalKind = 'kill_bugs' | 'kill_rogues' | 'open_crates' | 'loot_corpses' | 'extract_with_value' | 'use_stratagems';
export const CONTRACT_GOAL_LABEL_KO: Readonly<Record<ContractGoalKind, string>> = {
  kill_bugs: '터미니드 처치', kill_rogues: '로그 처치', open_crates: '상자 개봉', loot_corpses: '시체 수색',
  extract_with_value: '전리품 가치와 함께 탈출', use_stratagems: '함선 호출 사용',
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
}

/** Progress a squadmate's contract action is worth to us when we run a contract of the same corp. */
export const CONTRACT_SQUAD_SHARE = T.num('CONTRACT_SQUAD_SHARE');
/** Contracts active at once. */
export const CONTRACT_MAX_ACTIVE = T.num('CONTRACT_MAX_ACTIVE');

export const CONTRACT_DEFS: readonly ContractDef[] = csvRows('contracts.csv').map((r) => ({
  id: r.str('id'),
  corp: r.str('corp') as CorpId,
  minRepLevel: r.int('minRepLevel', { min: 0 }),
  goal: r.enum('goal', ['kill_bugs', 'kill_rogues', 'open_crates', 'loot_corpses', 'extract_with_value', 'use_stratagems'] as const),
  target: r.int('target', { min: 1 }),
  repReward: r.int('repReward', { min: 0 }),
  xpReward: r.int('xpReward', { min: 0 }),
  creditsReward: r.int('creditsReward', { min: 0 }),
  name: r.str('name'),
  desc: r.str('desc'),
}));

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

export const QUEST_DEFS: readonly QuestDef[] = csvRows('quests.csv').map((r) => ({
  id: r.str('id'),
  corp: r.str('corp') as CorpId,
  name: r.str('name'),
  desc: r.str('desc'),
  requires: {
    ...(r.has('reqRepLevel') ? { repLevel: r.int('reqRepLevel', { min: 0 }) } : {}),
    ...(r.has('reqQuests') ? { quests: r.list('reqQuests') } : {}),
  },
  deliver: r.costList('deliver'),
  rewards: {
    rep: r.int('rewardRep', { min: 0 }),
    xp: r.int('rewardXp', { min: 0 }),
    ...(r.has('rewardCredits') ? { credits: r.int('rewardCredits', { min: 0 }) } : {}),
    ...(r.has('rewardItems') ? { items: r.costList('rewardItems') } : {}),
  },
}));

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

/** `100` → `'100 C'`; `12345` → `'12,345 C'`. `sign` prefixes `+` / `−`; `suffix: false` drops the ` C`. */
export function formatCredits(n: number, opts?: { sign?: boolean; suffix?: boolean }): string {
  const v = Math.round(Number.isFinite(n) ? n : 0);
  const body = Math.abs(v).toLocaleString('ko-KR');
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
