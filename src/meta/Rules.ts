import type {
  ContractDef, ContractSettlement, CorpDef, EnemyType, ItemDef, MissionStats, QuestDef, QuestState, Rarity, RepInfo, ShopItem,
  ShopRule, WeaponDef,
} from '@/shared';
import {
  CONTRACT_MAX_ACTIVE, CONTRACT_SQUAD_SHARE, RARITY_ORDER, REP_LEVEL_MAX, REP_TABLE, SHOP_BAG_RARITY_BONUS, SHOP_RARITY_CAP_BY_REP,
  SHOP_UNLOCK_REP_LEVEL, buyPriceOf, repLevelOf, rarityRank as sharedRarityRank,
} from '@/shared';
/* 2026-09-21: the survey camera is sold by the survey corp only (`corpSells`) */
import { SURVEY_CORP_ID, surveyCameraOf } from '@/shared';
/* The implant repair fee lives in `data/tuning.csv`. */
import { csvRows, keyTable } from '@/shared';

/* ────────────────────────────────────────────────────────────────────────────
 * Pure rules (no ctx, no DOM): shop filter + prices, reputation, contract acceptance / settlement, quest availability.
 * `MetaSystem` feeds them the live numbers; the smoke test and the corp screen never re-derive any of this.
 * ──────────────────────────────────────────────────────────────────────────── */

/** `@/shared` rarity rank clamped to 0 for an unknown rarity (Phase 7: the order itself lives in `shared/labels.ts`). */
export const rarityRank = (r: Rarity): number => Math.max(0, sharedRarityRank(r));
export { RARITY_ORDER };

/** Korean reason strings (also what the corp screen prints). */
export const REASON = {
  repLow: '신뢰도 부족',
  credits: '크레딧 부족',
  space: '공간 없음',
  shipOnly: '함선에서만 가능',
  active: '이미 진행 중인 계약',
  notAccepted: '수락 필요',
  missing: '납품 아이템 부족',
  locked: '잠김',
  done: '완료됨',
  /* Phase 12: the implant repair desk */
  notBroken: '수리할 수 없는 아이템',
  noTarget: '수리 결과를 알 수 없음',
  materials: '재료 부족',
} as const;

/* ── reputation ── */
export function repInfoOf(rep: number): RepInfo {
  const level = repLevelOf(rep);
  return { rep, level, next: level >= REP_LEVEL_MAX ? null : REP_TABLE[level + 1] };
}

/* ── shop ── */
export type WeaponDefLookup = (weaponId: string) => WeaponDef | undefined;

/** Highest rarity the shop shows for `def` at `level` (bags one step higher). */
export function shopRarityCap(level: number, def: ItemDef): number {
  const idx = Math.max(0, Math.min(SHOP_RARITY_CAP_BY_REP.length - 1, level));
  let cap = rarityRank(SHOP_RARITY_CAP_BY_REP[idx]);
  // The shop sells **up to legendary** only. When `Rarity` gained a step (mythic) on 2026-09-16, leaving the cap at
  // `RARITY_ORDER.length - 1` would let the bag bonus put a mythic bag on the shelf — mythic is not shop stock, so it
  // stops at legendary.
  if (def.category === 'bag') cap = Math.min(rarityRank('legendary'), cap + SHOP_BAG_RARITY_BONUS);
  return cap;
}

/**
 * Phase 12: the material ids some implant's `ItemDef.implant.repairCost` asks for — what a
 * `ShopRule.implantRepairMaterials` rule sells. Computed from the live item defs (items/ owns the implants).
 */
export function implantRepairMaterialIds(defs: readonly ItemDef[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const d of defs) for (const c of d.implant?.repairCost ?? []) out.add(c.defId);
  return out;
}

/**
 * Does `rule` (at `level`) cover `def`? Uniques never, weapons by class, ammo by calibre, bags by `tactical`.
 * Phase 12: broken implants never (only the repair desk wants them), `maxRarity` caps a rule on top of the rep cap,
 * and an `implantRepairMaterials` rule sells exactly the ids in `repairMats` (see `implantRepairMaterialIds`).
 */
export function ruleMatches(
  rule: ShopRule, def: ItemDef, level: number, getWeaponDef: WeaponDefLookup, repairMats?: ReadonlySet<string>,
): boolean {
  if (rule.category !== def.category) return false;
  if ((rule.minRepLevel ?? 0) > level) return false;
  if (rule.maxRarity !== undefined && rarityRank(def.rarity) > rarityRank(rule.maxRarity)) return false;
  if (def.category === 'implant' && def.implant?.broken) return false;
  if (rule.implantRepairMaterials && !(repairMats?.has(def.id) ?? false)) return false;
  if (def.category === 'primary' || def.category === 'secondary') {
    const w = def.weaponId ? getWeaponDef(def.weaponId) : undefined;
    if (!w || w.unique) return false;
    if (rule.weaponClasses && (!w.weaponClass || !rule.weaponClasses.includes(w.weaponClass))) return false;
  }
  if (def.category === 'ammo' && rule.ammoTypes && (!def.ammoType || !rule.ammoTypes.includes(def.ammoType))) return false;
  if (def.category === 'bag' && rule.tactical !== undefined && !!def.bag?.tactical !== rule.tactical) return false;
  return true;
}

/** Is `def` on `corp`'s shelf at reputation `level`? (`repairMats`: Phase 12, see `ruleMatches`.) */
export function corpSells(
  corp: CorpDef, def: ItemDef, level: number, getWeaponDef: WeaponDefLookup, repairMats?: ReadonlySet<string>,
): boolean {
  if (level < SHOP_UNLOCK_REP_LEVEL) return false;
  if (!(def.value > 0)) return false;
  /* 2026-09-21 (user's decision): survey cameras are the survey corp's alone — its `gadget` rule holds cameras only,
   * and no other corp's `gadget` rule (노마드 장비) takes one. Their grades open by the usual rep rarity cap. */
  if (!!surveyCameraOf(def.id) !== (corp.id === SURVEY_CORP_ID)) return false;
  if (rarityRank(def.rarity) > shopRarityCap(level, def)) return false;
  for (const rule of corp.stock) if (ruleMatches(rule, def, level, getWeaponDef, repairMats)) return true;
  return false;
}

const CATEGORY_SORT: readonly ItemDef['category'][] = [
  'primary', 'ammo', 'attachment', 'bag', 'armor', 'implant', 'stim', 'gadget', 'material', 'herb', 'seed', 'book', 'disc', 'record', 'game_disc', 'console',
  'valuable', 'furniture',
];

/** Would `qty` units of `defId` fit in the bag / stash right now? (`InventoryRef.canFit`, Phase 7). */
export type FitLookup = (defId: string, qty: number) => boolean;

/**
 * 2026-09-16 (user's decision): **ammo is sold a whole stack at a time.** A shelf that sold single rounds meant
 * pressing the same slot dozens of times to fill one magazine, and its price tag read `1 C`, which said nothing. So
 * one shelf slot = `stackMax` rounds and the price is for that many (one purchase = one full stack). Every other
 * category is still 1 — guns, armor and implants do not stack.
 *
 * The relay's reason check (`shared/credits.ts` `buy:<defId>`) is a **lower** bound (`|delta| ≥ the best-discount
 * price`), so the bigger amount passes as it is. `qty ≤ stackMax` holds by construction.
 */
export function shopQtyOf(def: Pick<ItemDef, 'category' | 'stackMax'>): number {
  if (def.category !== 'ammo') return 1;
  return Math.max(1, Math.floor(def.stackMax || 1));
}

/**
 * Sorted shop lines with prices and a blocking reason (`credits` = current balance; `inShip` = buying allowed now;
 * `fits` = grid pre-check → `공간 없음`, checked last so the reason order is 함선 → 크레딧 → 공간).
 *
 * `price` is what **one purchase** costs, i.e. `buyPriceOf × shopQtyOf` — for ammo that is the whole stack
 * (2026-09-16). Every caller that stages / settles a line multiplies by the number of purchases, never by the units.
 */
export function buildShop(
  corp: CorpDef, defs: readonly ItemDef[], level: number, credits: number, inShip: boolean, getWeaponDef: WeaponDefLookup,
  fits: FitLookup = () => true,
): ShopItem[] {
  const out: ShopItem[] = [];
  const repairMats = implantRepairMaterialIds(defs);
  for (const def of defs) {
    if (!corpSells(corp, def, level, getWeaponDef, repairMats)) continue;
    const qty = shopQtyOf(def);
    const price = buyPriceOf(def.value, level) * qty;
    let blocked: string | null = null;
    if (!inShip) blocked = REASON.shipOnly;
    else if (credits < price) blocked = REASON.credits;
    else if (!fits(def.id, qty)) blocked = REASON.space;
    out.push({ def, price, blocked });
  }
  out.sort((a, b) => {
    const ca = CATEGORY_SORT.indexOf(a.def.category), cb = CATEGORY_SORT.indexOf(b.def.category);
    if (ca !== cb) return ca - cb;
    const ra = rarityRank(a.def.rarity), rb = rarityRank(b.def.rarity);
    if (ra !== rb) return ra - rb;
    if (a.price !== b.price) return a.price - b.price;
    return a.def.name.localeCompare(b.def.name, 'ko');
  });
  return out;
}

/* ── implant repair (Phase 12, 2026-09-08) ───────────────────────────────────
 * 세레스 바이오 turns a broken implant (`ItemDef.implant.broken`) into `repairsTo` for `repairCost` materials plus a
 * credit fee of `IMPLANT_REPAIR_FEE × grade` (grade = rarity of the **repaired** implant, 1 common … 5 legendary).
 * Everything below is pure; `MetaSystem.repairImplant` feeds it the live numbers and the desk prints `canRepairImplant`.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Credit fee per implant grade (× grade). A feature-folder scalar (`data/tuning.csv`) — only meta/ reads it. */
export const IMPLANT_REPAIR_FEE = keyTable('tuning.csv').num('IMPLANT_REPAIR_FEE');

/** 1 common … 5 legendary (an implant's grade *is* its rarity — `imp_<stat>_3` is rare). */
export function implantGrade(def: Pick<ItemDef, 'rarity'>): number {
  return Math.max(1, rarityRank(def.rarity) + 1);
}

/** Fee for repairing into `target` (the working implant). */
export function implantRepairFee(target: Pick<ItemDef, 'rarity'>): number {
  return IMPLANT_REPAIR_FEE * implantGrade(target);
}

/** Is `def` a broken implant the desk can take? (broken, with a `repairsTo`). */
export function isRepairableImplantDef(def: ItemDef | undefined | null): def is ItemDef & { implant: NonNullable<ItemDef['implant']> } {
  return !!def && def.category === 'implant' && !!def.implant && def.implant.broken === true && typeof def.implant.repairsTo === 'string';
}

/** Repaired-side materials, `[]` when the def declares none (the fee is still charged). */
export function implantRepairCost(broken: ItemDef): readonly { defId: string; qty: number }[] {
  return (broken.implant?.repairCost ?? []).filter((c) => c && typeof c.defId === 'string' && c.qty > 0);
}

export interface ImplantRepairCheck {
  /** The broken implant's def (null = the uid did not resolve to one). */
  broken: ItemDef | null;
  /** `repairsTo` resolved (null = unknown id). */
  target: ItemDef | null;
  credits: number;
  fee: number;
  inShip: boolean;
  /** Bag + stash units per material id. */
  have: (defId: string) => number;
  /** Would one `target` fit in the bag / stash after the broken one leaves? */
  fits: boolean;
}

/** Korean reason the repair cannot run now; null = go ahead. Order: 아이템 → 함선 → 크레딧 → 재료 → 공간. */
export function canRepairImplant(c: ImplantRepairCheck): string | null {
  if (!isRepairableImplantDef(c.broken)) return REASON.notBroken;
  if (!c.target) return REASON.noTarget;
  if (!c.inShip) return REASON.shipOnly;
  if (c.credits < c.fee) return REASON.credits;
  for (const line of implantRepairCost(c.broken)) if (c.have(line.defId) < line.qty) return REASON.materials;
  if (!c.fits) return REASON.space;
  return null;
}

/* ── contracts ── */
/**
 * 2026-09-13: `kill_rogues` counts **every humanoid enemy** — rogue · rogue boss · android · raider · the named ones
 * (로든 · 타길라 · 헤비). It used to count `rogue` · `rogue_boss` alone and the named ones fell into the bugs
 * (`kill_bugs`) by mistake. The source of a faction is `data/enemies.csv`'s `faction` column (not a bug = humanoid);
 * the scan drone is left out although its faction is raider, because it is not a person. The type check is the
 * loader's job in enemies/.
 */
const NON_HUMANOID_KILL_TYPES: ReadonlySet<string> = new Set(['rogue_scan_drone']);
const HUMANOID_KILL_TYPES: ReadonlySet<string> = new Set(
  csvRows('enemies.csv').filter((r) => r.str('faction') !== 'bug' && !NON_HUMANOID_KILL_TYPES.has(r.str('type'))).map((r) => r.str('type')),
);
export function killGoalOf(type: EnemyType): 'kill_bugs' | 'kill_rogues' {
  return HUMANOID_KILL_TYPES.has(type) ? 'kill_rogues' : 'kill_bugs';
}

/** Why `def` cannot be accepted now (null = acceptable). */
export function contractBlockReason(def: ContractDef, level: number, activeCount: number, inShip: boolean): string | null {
  if (!inShip) return REASON.shipOnly;
  if (activeCount >= CONTRACT_MAX_ACTIVE) return REASON.active;
  if (level < def.minRepLevel) return REASON.repLow;
  return null;
}

/** Progress delta a hit is worth: local hits count fully, a squadmate's relayed hit `CONTRACT_SQUAD_SHARE`. */
export function contractHitDelta(amount: number, local: boolean): number {
  const n = Number(amount);
  const a = Number.isFinite(n) ? Math.max(0, n) : 0;
  return local ? a : a * CONTRACT_SQUAD_SHARE;
}

export interface SettleResult {
  settlement: ContractSettlement;
  /** Progress the save keeps afterwards; null = the contract is cleared (success). */
  keepProgress: number | null;
}

/**
 * End-of-mission rule: `extract_with_value` reads `stats.lootValue`; success = extracted ∧ progress ≥ target (rewards paid,
 * contract cleared); extracted but short = progress kept; death = back to `progressAtStart`.
 * `outcome` (Phase 7) names the branch: `success` / `incomplete` (extracted, short) / `failed` (raid failed — no rep even
 * when the goal was met). ui words 미완 / 실패 from it, never from `stats.extracted`.
 */
export function settleContract(
  def: ContractDef, progress: number, progressAtStart: number, stats: MissionStats, carried?: number,
): SettleResult {
  /* 2026-09-12 (E2): `extract_with_items` reads `carried` — units of `def.itemDefId` on the body (bag grid + quick slots +
     pouch) at the moment of settlement, counted by the caller before anything moves the bag. Omitted = the live progress. */
  const p = def.goal === 'extract_with_value' ? Math.max(0, stats.lootValue)
    : def.goal === 'extract_with_items' ? Math.max(0, Math.floor(carried ?? progress))
      : progress;
  const success = !!stats.extracted && p >= def.target;
  const outcome: NonNullable<ContractSettlement['outcome']> = success ? 'success' : stats.extracted ? 'incomplete' : 'failed';
  const settlement: ContractSettlement = {
    id: def.id, corp: def.corp, name: def.name, success, progress: p, target: def.target,
    rep: success ? def.repReward : 0, xp: success ? def.xpReward : 0, credits: success ? def.creditsReward : 0,
    outcome,
  };
  const keepProgress = success ? null : stats.extracted ? p : Math.max(0, progressAtStart);
  return { settlement, keepProgress };
}

/* ── quests ── */
/** `locked` / `available` are derived every time from `requires`; `accepted` / `complete` come from the save. */
export function questStateOf(def: QuestDef, saved: QuestState | undefined, level: number, stateOf: (id: string) => QuestState): QuestState {
  if (saved === 'complete' || saved === 'accepted') return saved;
  const req = def.requires;
  if ((req.repLevel ?? 0) > level) return 'locked';
  if (req.quests) for (const q of req.quests) if (stateOf(q) !== 'complete') return 'locked';
  return 'available';
}

export function questBlockReason(state: QuestState, haves: readonly { qty: number; have: number }[], inShip: boolean): string | null {
  if (state === 'complete') return REASON.done;
  if (state === 'locked') return REASON.locked;
  if (state === 'available') return REASON.notAccepted;
  if (!inShip) return REASON.shipOnly;
  for (const h of haves) if (h.have < h.qty) return REASON.missing;
  return null;
}
