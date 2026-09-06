import type {
  ContractDef, ContractSettlement, CorpDef, EnemyType, ItemDef, MissionStats, QuestDef, QuestState, Rarity, RepInfo, ShopItem,
  ShopRule, WeaponDef,
} from '@/shared';
import {
  CONTRACT_MAX_ACTIVE, CONTRACT_SQUAD_SHARE, REP_LEVEL_MAX, REP_TABLE, SHOP_BAG_RARITY_BONUS, SHOP_RARITY_CAP_BY_REP,
  SHOP_UNLOCK_REP_LEVEL, buyPriceOf, repLevelOf,
} from '@/shared';

/* ────────────────────────────────────────────────────────────────────────────
 * Pure rules (no ctx, no DOM): shop filter + prices, reputation, contract acceptance / settlement, quest availability.
 * `MetaSystem` feeds them the live numbers; the smoke test and the corp screen never re-derive any of this.
 * ──────────────────────────────────────────────────────────────────────────── */

export const RARITY_ORDER: readonly Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
export const rarityRank = (r: Rarity): number => Math.max(0, RARITY_ORDER.indexOf(r));

/** 한국어 reason strings (also what the corp screen prints). */
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
  if (def.category === 'bag') cap = Math.min(RARITY_ORDER.length - 1, cap + SHOP_BAG_RARITY_BONUS);
  return cap;
}

/** Does `rule` (at `level`) cover `def`? Uniques never, weapons by class, ammo by calibre, bags by `tactical`. */
export function ruleMatches(rule: ShopRule, def: ItemDef, level: number, getWeaponDef: WeaponDefLookup): boolean {
  if (rule.category !== def.category) return false;
  if ((rule.minRepLevel ?? 0) > level) return false;
  if (def.category === 'primary' || def.category === 'secondary') {
    const w = def.weaponId ? getWeaponDef(def.weaponId) : undefined;
    if (!w || w.unique) return false;
    if (rule.weaponClasses && (!w.weaponClass || !rule.weaponClasses.includes(w.weaponClass))) return false;
  }
  if (def.category === 'ammo' && rule.ammoTypes && (!def.ammoType || !rule.ammoTypes.includes(def.ammoType))) return false;
  if (def.category === 'bag' && rule.tactical !== undefined && !!def.bag?.tactical !== rule.tactical) return false;
  return true;
}

/** Is `def` on `corp`'s shelf at reputation `level`? */
export function corpSells(corp: CorpDef, def: ItemDef, level: number, getWeaponDef: WeaponDefLookup): boolean {
  if (level < SHOP_UNLOCK_REP_LEVEL) return false;
  if (!(def.value > 0)) return false;
  if (rarityRank(def.rarity) > shopRarityCap(level, def)) return false;
  for (const rule of corp.stock) if (ruleMatches(rule, def, level, getWeaponDef)) return true;
  return false;
}

const CATEGORY_SORT: readonly ItemDef['category'][] = [
  'primary', 'secondary', 'ammo', 'attachment', 'bag', 'armor', 'stim', 'grenade', 'gadget', 'material', 'herb', 'valuable', 'furniture',
];

/** Sorted shop lines with prices and a blocking reason (`credits` = current balance; `inShip` = buying allowed now). */
export function buildShop(
  corp: CorpDef, defs: readonly ItemDef[], level: number, credits: number, inShip: boolean, getWeaponDef: WeaponDefLookup,
): ShopItem[] {
  const out: ShopItem[] = [];
  for (const def of defs) {
    if (!corpSells(corp, def, level, getWeaponDef)) continue;
    const price = buyPriceOf(def.value, level);
    let blocked: string | null = null;
    if (!inShip) blocked = REASON.shipOnly;
    else if (credits < price) blocked = REASON.credits;
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

/* ── contracts ── */
export function killGoalOf(type: EnemyType): 'kill_bugs' | 'kill_rogues' {
  return type === 'rogue' || type === 'rogue_boss' ? 'kill_rogues' : 'kill_bugs';
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
  const a = Math.max(0, Number(amount) || 0);
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
 */
export function settleContract(def: ContractDef, progress: number, progressAtStart: number, stats: MissionStats): SettleResult {
  const p = def.goal === 'extract_with_value' ? Math.max(0, stats.lootValue) : progress;
  const success = !!stats.extracted && p >= def.target;
  const settlement: ContractSettlement = {
    id: def.id, corp: def.corp, name: def.name, success, progress: p, target: def.target,
    rep: success ? def.repReward : 0, xp: success ? def.xpReward : 0, credits: success ? def.creditsReward : 0,
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
