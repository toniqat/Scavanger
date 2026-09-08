import type { AmmoType, EmbeddedView, ItemCategory, ItemDef, ItemInstance, MissionStats, Rarity, WeaponClass } from './types';

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

export const CORP_DEFS: Readonly<Record<CorpId, CorpDef>> = {
  helix: {
    id: 'helix', name: '헬릭스 방산', tagline: '수량이 곧 화력.', color: '#ff8a5c',
    description: '돌격소총·기관단총·권총과 경량/준중량탄을 대량으로 취급하는 군수 기업.',
    stock: [
      { category: 'primary', weaponClasses: ['AR', 'SMG'] },
      { category: 'secondary', weaponClasses: ['PISTOL'] },
      { category: 'ammo', ammoTypes: ['light', 'medium'] },
    ],
  },
  bastion: {
    id: 'bastion', name: '바스티온 중공업', tagline: '한 발의 무게.', color: '#7fb4ff',
    description: '저격소총·지정사수소총·산탄총과 중량탄·산탄을 만드는 중공업 그룹.',
    stock: [
      { category: 'primary', weaponClasses: ['SR', 'DMR', 'SG'] },
      { category: 'ammo', ammoTypes: ['heavy', 'shell'] },
      { category: 'armor', minRepLevel: 2 },
    ],
  },
  nomad: {
    id: 'nomad', name: '노마드 장비', tagline: '짊어진 만큼 살아 돌아온다.', color: '#d9b96a',
    description: '가방과 방탄복을 파는 원정 장비 상사. 전술 가방은 신뢰도 3 부터.',
    stock: [
      { category: 'bag', tactical: false },
      { category: 'bag', tactical: true, minRepLevel: 3 },
      { category: 'armor' },
    ],
  },
  ceres: {
    id: 'ceres', name: '세레스 바이오', tagline: '몸이 먼저다.', color: '#6ee7a8',
    description: '회복 소모품·수류탄·가젯과 임플란트를 취급하는 생명공학 기업. 부착물은 신뢰도 2 부터, 망가진 임플란트 수리도 여기서.',
    stock: [
      { category: 'stim' },
      { category: 'grenade' },
      { category: 'gadget' },
      { category: 'attachment', minRepLevel: 2 },
      { category: 'book', minRepLevel: 2 },   // appended (Phase 9): 서적 — 서재 책장용
      // appended (Phase 12): 임플란트 — common / uncommon stat implants only; rare+ come from quests / the repair desk
      { category: 'implant', maxRarity: 'uncommon' },
      // appended (Phase 12): every material some implant's `repairCost` asks for (the rep rarity cap still applies)
      { category: 'material', implantRepairMaterials: true },
    ],
  },
};

/* ── reputation ── */
/** Cumulative reputation needed to reach level L (index = level). Level 0..REP_LEVEL_MAX. */
export const REP_TABLE: readonly number[] = [0, 100, 300, 700, 1500, 3000];
export const REP_LEVEL_MAX = REP_TABLE.length - 1;
/** Reputation level at which a corp's shop opens. */
export const SHOP_UNLOCK_REP_LEVEL = 1;
/** Highest rarity sold at each reputation level (index = level). Bags get one extra step (`SHOP_BAG_RARITY_BONUS`). */
export const SHOP_RARITY_CAP_BY_REP: readonly Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'legendary'];
export const SHOP_BAG_RARITY_BONUS = 1;
/** Reputation level from cumulative `rep`. */
export function repLevelOf(rep: number): number {
  let lv = 0;
  for (let i = 1; i < REP_TABLE.length; i++) if (rep >= REP_TABLE[i]) lv = i;
  return lv;
}

/* ── credits / prices ── */
export const CREDITS_INITIAL = 500;
export const CREDITS_MAX = 9_999_999;
/** Buy price = value × max(SHOP_PRICE_MIN_MUL, SHOP_PRICE_BASE_MUL − SHOP_PRICE_DISCOUNT_PER_REP × repLevel). */
export const SHOP_PRICE_BASE_MUL = 1.6;
export const SHOP_PRICE_DISCOUNT_PER_REP = 0.15;
export const SHOP_PRICE_MIN_MUL = 0.9;
/** Sell price = value × SELL_PRICE_MUL (any corp, any item with a value). */
export const SELL_PRICE_MUL = 0.5;
export function buyPriceOf(value: number, repLevel: number): number {
  const mul = Math.max(SHOP_PRICE_MIN_MUL, SHOP_PRICE_BASE_MUL - SHOP_PRICE_DISCOUNT_PER_REP * Math.max(0, repLevel));
  return Math.max(1, Math.round(value * mul));
}
export function sellPriceOf(value: number, qty = 1): number {
  return Math.max(0, Math.round(value * SELL_PRICE_MUL * Math.max(0, qty)));
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
export const CONTRACT_SQUAD_SHARE = 0.25;
/** Contracts active at once. */
export const CONTRACT_MAX_ACTIVE = 1;

const contract = (
  id: string, corp: CorpId, minRepLevel: number, goal: ContractGoalKind, target: number,
  repReward: number, xpReward: number, creditsReward: number, name: string, desc: string,
): ContractDef => ({ id, corp, minRepLevel, goal, target, repReward, xpReward, creditsReward, name, desc });

export const CONTRACT_DEFS: readonly ContractDef[] = [
  /* helix — bugs */
  contract('helix_1', 'helix', 0, 'kill_bugs', 25, 60, 150, 120, '소탕 작전 I', '터미니드 25마리를 처치한다.'),
  contract('helix_2', 'helix', 1, 'kill_bugs', 60, 120, 320, 260, '소탕 작전 II', '터미니드 60마리를 처치한다.'),
  contract('helix_3', 'helix', 2, 'kill_bugs', 120, 220, 600, 500, '소탕 작전 III', '터미니드 120마리를 처치한다.'),
  contract('helix_4', 'helix', 3, 'kill_bugs', 200, 380, 1000, 900, '소탕 작전 IV', '터미니드 200마리를 처치한다.'),
  contract('helix_calls', 'helix', 1, 'use_stratagems', 4, 90, 200, 180, '화력 시연', '함선 호출을 4회 사용한다.'),
  /* bastion — rogues */
  contract('bastion_1', 'bastion', 0, 'kill_rogues', 5, 70, 180, 150, '용병 제거 I', '로그 5명을 처치한다.'),
  contract('bastion_2', 'bastion', 1, 'kill_rogues', 12, 140, 380, 320, '용병 제거 II', '로그 12명을 처치한다.'),
  contract('bastion_3', 'bastion', 2, 'kill_rogues', 25, 260, 700, 600, '용병 제거 III', '로그 25명을 처치한다.'),
  contract('bastion_4', 'bastion', 3, 'kill_rogues', 40, 420, 1100, 1000, '용병 제거 IV', '로그 40명을 처치한다.'),
  /* nomad — value */
  contract('nomad_1', 'nomad', 0, 'extract_with_value', 1500, 60, 150, 100, '회수 임무 I', '가방에 1,500 이상의 전리품을 담고 탈출한다.'),
  contract('nomad_2', 'nomad', 1, 'extract_with_value', 4000, 130, 340, 240, '회수 임무 II', '가방에 4,000 이상의 전리품을 담고 탈출한다.'),
  contract('nomad_3', 'nomad', 2, 'extract_with_value', 9000, 240, 640, 480, '회수 임무 III', '가방에 9,000 이상의 전리품을 담고 탈출한다.'),
  contract('nomad_4', 'nomad', 3, 'extract_with_value', 20000, 400, 1050, 900, '회수 임무 IV', '가방에 20,000 이상의 전리품을 담고 탈출한다.'),
  contract('nomad_crates', 'nomad', 0, 'open_crates', 8, 70, 160, 120, '보급 조사', '상자 8개를 연다.'),
  /* ceres — corpses */
  contract('ceres_1', 'ceres', 0, 'loot_corpses', 6, 60, 150, 110, '검체 채취 I', '시체 6구를 수색한다.'),
  contract('ceres_2', 'ceres', 1, 'loot_corpses', 15, 130, 330, 250, '검체 채취 II', '시체 15구를 수색한다.'),
  contract('ceres_3', 'ceres', 2, 'loot_corpses', 30, 240, 620, 480, '검체 채취 III', '시체 30구를 수색한다.'),
  contract('ceres_4', 'ceres', 3, 'loot_corpses', 50, 400, 1000, 850, '검체 채취 IV', '시체 50구를 수색한다.'),
];

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

const quest = (
  id: string, corp: CorpId, name: string, desc: string, requires: QuestDef['requires'],
  deliver: QuestDef['deliver'], rewards: QuestDef['rewards'],
): QuestDef => ({ id, corp, name, desc, requires, deliver, rewards });

export const QUEST_DEFS: readonly QuestDef[] = [
  /* helix chain */
  quest('h1', 'helix', '고철 납품', '폐금속 10개를 납품한다.', {}, [{ defId: 'mat_scrap', qty: 10 }],
    { rep: 150, xp: 200, credits: 150 }),
  quest('h2', 'helix', '합금 납품', '합금 판 6개를 납품한다.', { quests: ['h1'] }, [{ defId: 'mat_alloy', qty: 6 }],
    { rep: 220, xp: 350, credits: 250, items: [{ defId: 'att_brake', qty: 1 }] }),
  quest('h3', 'helix', '전력 조달', '파워 셀 4개를 납품한다.', { quests: ['h2'], repLevel: 2 }, [{ defId: 'mat_power_cell', qty: 4 }],
    { rep: 320, xp: 600, credits: 400, items: [{ defId: 'wpn_smg_g3', qty: 1 }] }),
  quest('h4', 'helix', '기밀 회수', '데이터 코어 1개를 납품한다.', { quests: ['h3'], repLevel: 3 }, [{ defId: 'data_core', qty: 1 }],
    { rep: 600, xp: 1500, credits: 900, items: [{ defId: 'wpn_ar_g4', qty: 1 }] }),
  /* bastion chain */
  quest('b1', 'bastion', '분비선 샘플', '터미니드 분비선 3개를 납품한다.', {}, [{ defId: 'terminid_gland', qty: 3 }],
    { rep: 180, xp: 250, credits: 200 }),
  quest('b2', 'bastion', '정제 샘플', '정제 샘플 캐니스터 1개를 납품한다.', { quests: ['b1'] }, [{ defId: 'sample_canister_pure', qty: 1 }],
    { rep: 300, xp: 550, credits: 400, items: [{ defId: 'att_scope4', qty: 1 }] }),
  quest('b3', 'bastion', '외계 유물', '외계 유물 1개를 납품한다.', { quests: ['b2'], repLevel: 3 }, [{ defId: 'alien_artifact', qty: 1 }],
    { rep: 600, xp: 1500, credits: 1200, items: [{ defId: 'wpn_sr_g4', qty: 1 }] }),
  /* nomad chain */
  quest('n1', 'nomad', '크레딧 칩 수거', '크레딧 칩 5개를 납품한다.', {}, [{ defId: 'cred_chip', qty: 5 }],
    { rep: 150, xp: 200, credits: 300 }),
  quest('n2', 'nomad', '전자장비 회수', '회수 전자장비 3개를 납품한다.', { quests: ['n1'] }, [{ defId: 'salvage_electronics', qty: 3 }],
    { rep: 280, xp: 500, credits: 350, items: [{ defId: 'bag_rare', qty: 1 }] }),
  /* ceres chain */
  quest('c1', 'ceres', '생체 조직', '생체 조직 12개를 납품한다.', {}, [{ defId: 'mat_bio_sample', qty: 12 }],
    { rep: 150, xp: 200, credits: 150, items: [{ defId: 'heal_syringe', qty: 2 }] }),
  quest('c2', 'ceres', '분비선 연구', '터미니드 분비선 5개를 납품한다.', { quests: ['c1'] }, [{ defId: 'terminid_gland', qty: 5 }],
    { rep: 260, xp: 450, credits: 300, items: [{ defId: 'gad_defib', qty: 1 }] }),
  quest('c3', 'ceres', '고대 성유물', '고대 성유물 1개를 납품한다.', { quests: ['c2'], repLevel: 2 }, [{ defId: 'alien_relic', qty: 1 }],
    { rep: 600, xp: 1500, credits: 1500, items: [{ defId: 'bag_epic_tac', qty: 1 }] }),
  /* ceres 임플란트 chain (appended Phase 12, 2026-09-08): three steps, each rewarding an implant the shop never sells */
  quest('ci1', 'ceres', '신경 접합제', '혈근초 6개, 잿빛잎 4개, 소독약 3개를 납품한다. 보상: 인지력 임플란트 III.',
    { repLevel: 1 }, [{ defId: 'herb_bloodroot', qty: 6 }, { defId: 'herb_ashleaf', qty: 4 }, { defId: 'mat_antiseptic', qty: 3 }],
    { rep: 200, xp: 300, credits: 200, items: [{ defId: 'imp_perception_3', qty: 1 }] }),
  quest('ci2', 'ceres', '망가진 회로 분석', '망가진 지능 임플란트 1개, 회로 기판 2개, 생체 조직 6개를 납품한다. 보상: 지능 임플란트 III.',
    { quests: ['ci1'] }, [{ defId: 'imp_broken_intelligence_1', qty: 1 }, { defId: 'mat_circuit', qty: 2 }, { defId: 'mat_bio_sample', qty: 6 }],
    { rep: 260, xp: 450, credits: 300, items: [{ defId: 'imp_intelligence_3', qty: 1 }] }),
  quest('ci3', 'ceres', '가속 대사 임상', '발광버섯 6개, 소독약 6개, 주사기 6개, 터미니드 분비선 4개, 회로 기판 4개를 납품한다. 보상: 가속 대사 (전설 임플란트).',
    { quests: ['ci2'], repLevel: 3 },
    [{ defId: 'herb_glowcap', qty: 6 }, { defId: 'mat_antiseptic', qty: 6 }, { defId: 'mat_syringe', qty: 6 }, { defId: 'terminid_gland', qty: 4 }, { defId: 'mat_circuit', qty: 4 }],
    { rep: 600, xp: 1500, credits: 800, items: [{ defId: 'imp_perk_quick_heal', qty: 1 }] }),
];

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
