import type { CraftIngredient, CraftRecipe, DurabilityBucketInfo, ItemCategory, ItemDef, ItemInstance, WeaponClass } from '@/shared';
import { SKILL_LEVEL_MAX, WEAPON_DEFAULT_DURABILITY, craftCostFactor, csvRows, keyTable, numberList } from '@/shared';
import { ITEM_DEF_MAP, itemIdForWeapon } from './ItemDefs';
import { WEAPON_DEFS, WEAPON_DEF_MAP, gradeOf, isUniqueWeapon, weaponClassOf } from './WeaponDefs';
import { CRAFT_RECIPES, craftCostOf } from './Recipes';

/* ════════════════════════════════════════════════════════════════════════════
 * Salvage · repair (2026-09-10, the big craft rework)
 *
 * The baseline is **the materials it takes to craft that item anew** (`Recipes.craftCostOf`). The remaining
 * durability is cut into buckets of equal width and each bucket has its own fixed multiplier — repair rounds
 * **up**, salvage rounds **down**. The worse the bucket, the more a repair costs and the less a salvage yields.
 *
 * The multipliers **and the bucket count** are `REPAIR_COST_BY_DURABILITY` · `SALVAGE_YIELD_BY_DURABILITY` in
 * `data/tables.csv`, read into the two constants below — the table is never copied into this comment, because a
 * copy goes stale without anything failing.
 *
 * **Rounding rule** — repair rounds up (the side against the player), salvage rounds down. Salvage does **not
 * guarantee a minimum of 1 per material type**: guaranteeing it would hand a grade IV gun's 「강화합금 잉곳 2」
 * back whole and make 「craft → salvage → craft」 profitable. The one exception is **the single largest input**
 * (`SALVAGE_MAIN_MIN_YIELD`), and that place always holds 8 or more of a lower material such as 폐금속 · 천조각,
 * so even added to the repair bill (rounded up) it does not exceed the craft inputs.
 * `checkSalvageEconomy()` checks every item · every bucket with the real numbers; `npm run data:check` runs it.
 * ════════════════════════════════════════════════════════════════════════════ */

const T = /* data/tuning.csv */ keyTable('tuning.csv');

/** The repair material multiplier per bucket (index 0 = 0~20 % … 4 = 81~100 %). */
export const REPAIR_COST_BY_DURABILITY: readonly number[] = numberList('tables.csv', 'REPAIR_COST_BY_DURABILITY');
/** The salvage yield multiplier per bucket (same order). */
export const SALVAGE_YIELD_BY_DURABILITY: readonly number[] = numberList('tables.csv', 'SALVAGE_YIELD_BY_DURABILITY');

/** The bucket count — the length of the csv list. */
export const DURABILITY_BUCKETS = REPAIR_COST_BY_DURABILITY.length;
/** The salvage multiplier of the top (full-durability) bucket — the reference value the listing carries. */
const TOP_SALVAGE_MUL = SALVAGE_YIELD_BY_DURABILITY[DURABILITY_BUCKETS - 1] ?? 0;
/**
 * The bucket labels — `0~20 %` … `81~100 %` at five buckets. The width is **derived from the csv list**, never
 * written down: add or drop a multiplier in `tables.csv` and the labels follow (2026-09-20, `docs/TODO.md` B-67 —
 * the width used to be the literal `20`, so a six-entry list would have silently labelled the buckets wrong).
 * `bucketOfRatio` splits the ratio by the same count, so the two always describe the same buckets.
 */
const DURABILITY_BUCKET_WIDTH = 100 / DURABILITY_BUCKETS;
export const DURABILITY_BUCKET_LABELS: readonly string[] =
  REPAIR_COST_BY_DURABILITY.map((_, i) => {
    const hi = Math.round((i + 1) * DURABILITY_BUCKET_WIDTH);
    return i === 0 ? `0~${hi} %` : `${Math.round(i * DURABILITY_BUCKET_WIDTH) + 1}~${hi} %`;
  });

/**
 * The categories that can be repaired. A healing spray is still handled by `inventory`'s `sprayRepairCost`.
 * 2026-09-11 (C-36): `bag` joined — bags gained a `durabilityMax`, and without them here the repair cost is
 * `[]`, which means a **full repair for no materials**, while the salvage buckets still split so
 * "repair-then-salvage" tips the balance. So the csv column · this list · the
 * 「제작 레시피가 있는데 수리비가 비어 있다」 check in `checkSalvageEconomy` are one bundle.
 */
const REPAIRABLE: readonly ItemCategory[] = ['primary', 'secondary', 'armor', 'bag'];
/** The categories whose salvage recipe is generated from the craft recipe. */
const SALVAGEABLE: readonly ItemCategory[] = ['primary', 'secondary', 'armor', 'bag'];

/**
 * 2026-09-15 (the gadget rework, user's decision): **a gadget that carries durability** (dome shield ·
 * barricade) is repairable and salvageable too. The damage a deployable takes stays as the item's durability
 * (`GadgetDef.wearsItemDurability`), so it has to be fixable and strippable at the workbench.
 * Why `'gadget'` is not put into the category list wholesale: that would generate a salvage recipe for gadgets
 * with **no durability** — smoke grenades · grenades · drones — and put a bucket check on items that have no
 * durability bucket. So the split is 「does it have durability」 — the moment a new gadget gets a
 * `durabilityMax`, repair · salvage · the economy check follow on their own.
 *
 * **2026-09-16 (the mining rework, user's decision) — the category was taken out of the predicate.** The
 * processor (`mat_processor`) is a `material` yet carries a `durabilityMax` (`data/items.csv`), plugs into the
 * compute cluster and wears down each cycle (the ship workbench repairs it). The old formula, which split on
 * the category, missed this row and the repair cost became `[]` — which means a free repair — so
 * `checkSalvageEconomy` caught it in every bucket as 「제작 레시피가 있는데 수리비가 비어 있다」. This only widens
 * beyond gadgets the intent already written in the paragraph above (split on 「does it have durability」) —
 * whatever the category, writing a `durabilityMax` brings repair · salvage · the economy check with it.
 *
 * The one exception is the **healing spray**: its `durabilityMax` is not durability but a liquid gauge, so its
 * refill is taken separately by `inventory`'s `sprayRepairCost` (`needsRepairCost` filters it out on the same
 * line).
 */
const wearsDurability = (def: ItemDef): boolean => !def.heal?.spray && (def.durabilityMax ?? 0) > 0;

/**
 * 2026-09-16 (user's decision) — **unique weapons are salvageable. Mythic minerals just do not come out.**
 * The same day the 6 uniques gained craft recipes (`make_wpn_u_*`, one dedicated mythic mineral each), which
 * made `SALVAGE_SOURCES` generate a salvage recipe from them. Left alone, that opens the road
 * 「a mythic mineral → craft → salvage」 on which the mineral comes back — the user's decision is to close that
 * road only and allow the salvage itself.
 * The implementation is `salvageYieldOf` below, alone: **mythic-rarity materials drop out of the salvage yield
 * entirely.** The yield only shrinks, so the 「repair + salvage ≤ craft」 invariant (`checkSalvageEconomy`) only
 * gets more room; it does not break.
 * Repair still works — now from **its own craft inputs** rather than borrowed grade V materials (which is why
 * it costs a mythic mineral).
 */
/**
 * The 100 % baseline of the salvage yield — the craft inputs **minus mythic rarity**. It carries the rule
 * above in one single place. Why it does not ask whether the item is unique: what has to be stopped is not
 * 「a unique」 but 「a mythic material coming back out of salvage」, and cutting on rarity makes the rule follow
 * on its own for any future item that eats a mythic material. Today the only mythic materials are the minerals
 * dedicated to the unique weapons (the `mythic` rows of `data/items.csv`), so those are in fact the only thing
 * this line filters out.
 */
const salvageYieldOf = (inputs: readonly CraftIngredient[]): readonly CraftIngredient[] =>
  inputs.filter((i) => ITEM_DEF_MAP.get(i.defId)?.rarity !== 'mythic');

/** Is this item repairable at the workbench? */
const isRepairable = (def: ItemDef): boolean => REPAIRABLE.includes(def.category) || wearsDurability(def);
/** Is this an item whose salvage recipe is generated from its craft inputs? */
const isSalvageable = (def: ItemDef): boolean => SALVAGEABLE.includes(def.category) || wearsDurability(def);

/* ══ 2026-09-16 (user's decision) — the **eligibility test** of the craft material refund ════════════════════
 * The craft skill now gives part of the materials back (`shared/craftRefund.ts`). But **durable gear (weapons ·
 * armor · bags · durable gadgets) has to be left out** — as the head of this file says, the repair cost and
 * the salvage yield of that gear come straight out of 「the craft inputs」. If only crafting got cheaper the
 * balance would tip towards 「craft → salvage」 · 「salvage → re-craft」, and three of the four checks in
 * `checkSalvageEconomy` below use 「the craft inputs」 as their baseline, so that whole baseline would shake.
 * Materials · consumables · ammo · attachments · cooking cannot be turned back by salvage (or have only a
 * fixed salvage written by hand, which the economy check catches), so they take the refund as they are.
 * → docs/DECISIONS.md 「2026-09-16 — 제작과 숙련」
 * ══════════════════════════════════════════════════════════════════════════════════════════════════════ */

/** Are this recipe's inputs eligible for the **craft skill refund**? Salvage (`break_*`) and durable gear are not. */
export function isCraftRefundable(recipe: CraftRecipe): boolean {
  if (recipe.id.startsWith('break_')) return false;              // salvage is not crafting
  const def = ITEM_DEF_MAP.get(recipe.outputDefId);
  if (!def) return true;                                          // not an item, like a cooked plate — never salvaged
  return !isSalvageable(def) && !isRepairable(def);
}

/**
 * The material multiplier this recipe **actually eats** at max skill (1 when it is not refundable). The economy
 * check and the explanation read the same value.
 */
export function maxSkillCraftFactor(recipe: CraftRecipe): number {
  return isCraftRefundable(recipe) ? craftCostFactor(SKILL_LEVEL_MAX) : 1;
}

/** The salvage hold time in seconds — per category (`data/tuning.csv`). */
function salvageDuration(category: ItemCategory): number {
  if (category === 'armor') return T.num('ARMOR_SALVAGE_DURATION');
  if (category === 'bag') return T.num('BAG_SALVAGE_DURATION');
  return T.num('WEAPON_SALVAGE_DURATION');
}

/* ── durability buckets ───────────────────────────────────────────────────── */

/**
 * This item's max durability (0 when there is none). Weapons take it from the weapon def, everything else from
 * `ItemDef.durabilityMax`.
 */
export function maxDurabilityOf(def: ItemDef | undefined): number {
  if (!def) return 0;
  if (def.weaponId) {
    const w = WEAPON_DEF_MAP.get(def.weaponId);
    return w ? (w.maxDurability ?? WEAPON_DEFAULT_DURABILITY) : 0;
  }
  return def.durabilityMax ?? 0;
}

/** Remaining ratio 0..1 → bucket 0..4. Exactly 20 % belongs to the lower bucket (0~20 %). */
export function bucketOfRatio(ratio: number): number {
  const clamped = Math.max(0, Math.min(1, ratio));
  const b = Math.ceil(clamped * DURABILITY_BUCKETS - 1e-9) - 1;
  return Math.max(0, Math.min(DURABILITY_BUCKETS - 1, b));
}

/** The remaining durability ratio. An item that uses no durability is always 1 (= bucket 4). */
function ratioOf(inst: ItemInstance): number {
  const max = maxDurabilityOf(ITEM_DEF_MAP.get(inst.defId));
  if (max <= 0) return 1;
  return Math.max(0, Math.min(1, (inst.durability ?? max) / max));
}

/** `LootRef.durabilityBucketOf`. */
export function durabilityBucketOf(inst: ItemInstance): number {
  return bucketOfRatio(ratioOf(inst));
}

/** `LootRef.durabilityBucketInfo`. */
export function durabilityBucketInfo(inst: ItemInstance): DurabilityBucketInfo {
  const ratio = ratioOf(inst);
  const bucket = bucketOfRatio(ratio);
  return {
    bucket,
    ratio,
    repairMul: REPAIR_COST_BY_DURABILITY[bucket] ?? 0,
    salvageMul: SALVAGE_YIELD_BY_DURABILITY[bucket] ?? 0,
    label: DURABILITY_BUCKET_LABELS[bucket] ?? '',
  };
}

/* ── the fallback baseline of gear with no craft recipe ──────────────────────────
 * Repair has to work even without a craft recipe, so one baseline is borrowed — the craft inputs of
 * **grade V of the same gun class** (perk armor borrows armor V) × `UNIQUE_REPAIR_MUL`. Why the old formula
 * (missing durability ÷ REPAIR_SCRAP_PER) was not kept: unique durability spans an order of magnitude
 * (`data/weapons_unique.csv` `maxDurability`), so the repair bill split by the same factor even within one
 * grade, and it moved on a completely different axis from graded weapons — "how expensive a repair is this"
 * could not be read off it.
 *
 * **2026-09-16**: the 6 unique weapons now have their own craft recipe (`make_wpn_u_*`) and no longer come
 * down this road — `repairCostFor` looks at `craftCostOf(def.id)` first (which is why a unique repair costs a
 * mythic mineral). The only guests left are the **3 perk armors** (`regen` · `ultralight` · `optical`, they
 * have no row in `data/recipes.csv`).
 * A unique is salvageable, but its mythic mineral drops out of the yield (`salvageYieldOf` above). */
const UNIQUE_REPAIR_MUL = T.num('UNIQUE_REPAIR_MUL');

const GRADE_V_ITEM_BY_CLASS: ReadonlyMap<WeaponClass, string> = new Map(
  WEAPON_DEFS.filter((w) => !isUniqueWeapon(w) && gradeOf(w) === 5).map((w) => [weaponClassOf(w), itemIdForWeapon(w.id)]),
);

/** The baseline materials of gear with no craft recipe (empty array when there is none). */
function fallbackCraftCost(def: ItemDef): readonly CraftIngredient[] {
  if (def.weaponId) {
    const w = WEAPON_DEF_MAP.get(def.weaponId);
    if (!w) return [];
    const twin = GRADE_V_ITEM_BY_CLASS.get(weaponClassOf(w));
    return twin ? craftCostOf(twin) : [];
  }
  if (def.category === 'armor') return craftCostOf('armor_5');
  return [];
}

/* ── repair ───────────────────────────────────────────────────────────────── */

/**
 * The implementation of `LootRef.getRepairCost`. The materials a full repair takes = **the craft inputs × the
 * bucket multiplier, rounded up**. `[]` when durability is full or the item is not repairable.
 */
export function repairCostFor(inst: ItemInstance): { defId: string; qty: number }[] {
  const def = ITEM_DEF_MAP.get(inst.defId);
  if (!def || !isRepairable(def)) return [];
  const max = maxDurabilityOf(def);
  if (max <= 0) return [];
  const cur = inst.durability ?? max;
  if (cur >= max) return [];
  const mul = REPAIR_COST_BY_DURABILITY[bucketOfRatio(cur / max)] ?? 0;
  const own = craftCostOf(def.id);
  if (own.length) return own.map((i) => ({ defId: i.defId, qty: Math.max(1, Math.ceil(i.qty * mul - 1e-9)) }));
  const uniqueMul = mul * UNIQUE_REPAIR_MUL;
  return fallbackCraftCost(def).map((i) => ({ defId: i.defId, qty: Math.max(1, Math.ceil(i.qty * uniqueMul - 1e-9)) }));
}

/**
 * 2026-09-11 (C-36) — must this item **charge materials** once it is worn: it has durability, it has a craft
 * recipe, and it is not a healing spray (whose gauge refill is separate). When `repairCostFor` returns `[]`
 * for such an item, that is not a free repair but **a hole in the table**, so the repair side has to refuse.
 */
export function needsRepairCost(def: ItemDef | undefined): boolean {
  if (!def || def.heal?.spray) return false;
  return maxDurabilityOf(def) > 0 && craftCostOf(def.id).length > 0;
}

/* ── salvage ──────────────────────────────────────────────────────────────── */

const MAIN_MIN_YIELD = T.num('SALVAGE_MAIN_MIN_YIELD');

/** The index of the **largest** input row (on a tie, the one written first). */
function mainInputIndex(inputs: readonly CraftIngredient[]): number {
  let best = 0;
  for (let i = 1; i < inputs.length; i++) if (inputs[i].qty > inputs[best].qty) best = i;
  return best;
}

/**
 * The baseline materials × the multiplier, rounded down. Rows that hit 0 drop out and **only the main input
 * row** never falls below `SALVAGE_MAIN_MIN_YIELD`. The main input comes first, so the headline output = the
 * one that comes out most.
 */
export function scaleSalvage(base: readonly CraftIngredient[], mul: number): CraftIngredient[] {
  if (!base.length) return [];
  const main = mainInputIndex(base);
  const scaled = base.map((i, idx) => {
    const q = Math.floor(i.qty * mul + 1e-9);
    return { defId: i.defId, qty: idx === main ? Math.max(MAIN_MIN_YIELD, q) : q };
  });
  return [scaled[main], ...scaled.filter((_, idx) => idx !== main)].filter((c) => c.qty > 0);
}

/** Folds an output list into `outputDefId` + `extraOutputs`. null when there is no output. */
function withOutputs(base: CraftRecipe, outputs: CraftIngredient[]): CraftRecipe | null {
  if (!outputs.length) return null;
  const [head, ...rest] = outputs;
  const out: CraftRecipe = { ...base, outputDefId: head.defId, outputQty: head.qty };
  if (rest.length) out.extraOutputs = rest;
  else delete out.extraOutputs;
  return out;
}

/* ── data/salvage.csv — salvage written by hand ────────────────────────────── */

interface HandSalvage {
  /** The recipe that goes in the listing (with `scaleByDurability`, already scaled to bucket 4). */
  listed: CraftRecipe;
  /** The outputs at the 100 % baseline. With `scaled` false they come out unchanged. */
  base: CraftIngredient[];
  scaled: boolean;
}

const HAND_SALVAGE: readonly HandSalvage[] = csvRows('salvage.csv').map((r) => {
  const inputDefId = r.str('inputDefId');
  const base = r.costList('outputs');
  const scaled = r.has('scaleByDurability') ? r.bool('scaleByDurability') : false;
  const shell: CraftRecipe = {
    id: r.str('id'),
    name: `${ITEM_DEF_MAP.get(inputDefId)?.name ?? inputDefId} 분해`,
    station: 'field',
    inputs: [{ defId: inputDefId, qty: r.int('qty', { min: 1 }) }],
    outputDefId: base[0]?.defId ?? 'mat_scrap', outputQty: Math.max(1, base[0]?.qty ?? 1),
    duration: r.num('duration', { min: 0 }),
    skill: r.enum('skill', ['crafting', 'medicine', 'gardening'] as const),
    skillRequired: r.int('skillRequired', { min: 0 }),
    description: r.str('description'),
  };
  const listed = withOutputs(shell, scaled ? scaleSalvage(base, TOP_SALVAGE_MUL) : base) ?? shell;
  return { listed, base, scaled };
});

const HAND_BY_INPUT: ReadonlyMap<string, HandSalvage> = new Map(HAND_SALVAGE.map((h) => [h.listed.inputs[0].defId, h]));

/* ── salvage generated from craft recipes ──────────────────────────────────────
 * Every weapon · armor · bag that has a craft recipe in `data/recipes.csv`. The yield **follows that item's
 * craft input list exactly**, so stripping a gun gives back not only 폐금속 but the 합금 판 · 기계 부품 ·
 * 강화합금 잉곳 its grade demanded.
 * 2026-09-16: the unique weapons gained recipes and joined this list too, but `salvageYieldOf` hands out the
 * yield with the mythic mineral removed (comment above). Perk armor still has no recipe and drops out on its
 * own. The processor (`material` + durability) newly joins. */

interface SalvageSource {
  /** The 100 % baseline = the craft inputs. */
  craft: readonly CraftIngredient[];
  /** The recipe assembled at bucket 4 (the one that goes into `getAllRecipes()`). */
  listed: CraftRecipe;
  /**
   * 2026-09-16: the material multiplier this recipe **actually eats** at max skill (`maxSkillCraftFactor`).
   * Durable gear is not refundable so it is always 1, but the value is carried so that the economy check below
   * catches it the moment that rule breaks.
   */
  factor: number;
}

const SALVAGE_SOURCES: ReadonlyMap<string, SalvageSource> = (() => {
  const out = new Map<string, SalvageSource>();
  for (const r of CRAFT_RECIPES) {
    if (r.outputQty !== 1) continue;
    const def = ITEM_DEF_MAP.get(r.outputDefId);
    if (!def || !isSalvageable(def) || out.has(def.id)) continue;
    const gun = def.category === 'primary' || def.category === 'secondary';
    const shell: CraftRecipe = {
      id: `break_${def.id}`, name: `${def.name} 분해`, station: 'field',
      inputs: [{ defId: def.id, qty: 1 }], outputDefId: 'mat_scrap', outputQty: 1,
      duration: salvageDuration(def.category), skill: 'crafting', skillRequired: 0,
      description: `${def.name} 을(를) 뜯어 제작 재료 일부를 되찾는다. 남은 내구도가 높을수록 많이 나온다.`
        + (gun ? ' 부착물은 먼저 가방으로 돌아온다.' : ''),
    };
    // The salvage yield is the craft inputs minus mythic rarity (the `salvageYieldOf` comment above — a
    // unique's mythic mineral does not come back).
    const yield_ = salvageYieldOf(r.inputs);
    const listed = withOutputs(shell, scaleSalvage(yield_, TOP_SALVAGE_MUL));
    if (listed) out.set(def.id, { craft: yield_, listed, factor: maxSkillCraftFactor(r) });
  }
  return out;
})();

/**
 * Every salvage recipe (`break_*`). ⚠ **the quantities a generated salvage carries here are at bucket 4
 * (81~100 %)**, so the actual consumption · yield uses the recipe `salvageFor(inst)` returns.
 */
export const SALVAGE_RECIPES: readonly CraftRecipe[] = [
  ...HAND_SALVAGE.map((h) => h.listed),
  ...[...SALVAGE_SOURCES.values()].map((s) => s.listed),
];

/** Craft + salvage. The list `ctx.loot.getAllRecipes()` hands out. */
export const ALL_CRAFT_RECIPES: readonly CraftRecipe[] = [...CRAFT_RECIPES, ...SALVAGE_RECIPES];

export const CRAFT_RECIPE_MAP: ReadonlyMap<string, CraftRecipe> = new Map(ALL_CRAFT_RECIPES.map((r) => [r.id, r]));

export function getRecipe(id: string): CraftRecipe | undefined {
  return CRAFT_RECIPE_MAP.get(id);
}

/**
 * The implementation of `LootRef.getSalvageFor` — what comes out if this instance is salvaged **now**.
 * A hand-written fixed salvage (ammo · 기계 부품 · chargers) is exactly what the table says, whatever the
 * durability.
 */
export function salvageFor(inst: ItemInstance): CraftRecipe | null {
  const src = SALVAGE_SOURCES.get(inst.defId);
  if (src) return withOutputs(src.listed, scaleSalvage(src.craft, SALVAGE_YIELD_BY_DURABILITY[durabilityBucketOf(inst)] ?? 0));
  const hand = HAND_BY_INPUT.get(inst.defId);
  if (!hand) return null;
  if (!hand.scaled) return hand.listed;
  return withOutputs(hand.listed, scaleSalvage(hand.base, SALVAGE_YIELD_BY_DURABILITY[durabilityBucketOf(inst)] ?? 0));
}

/* ── the economy check ────────────────────────────────────────────────────────
 * Confirms **with the real numbers** that 「craft → (repair) → salvage → craft」 is never profitable.
 * `npm run data:check` runs it (scripts/data-check.mjs). It looks at four things:
 *
 *  (1) salvage yield ≤ craft inputs (one type over it and the material grows by itself)
 *  (2) repair materials + salvage yield ≤ craft inputs, and at least one type is **strictly less**
 *  (3) salvage(bucket 4) − repair(bucket b) ≤ salvage(bucket b) — "repair-then-salvage" must not beat
 *      "salvage now"
 *  (4) no material that crafting does not use comes out of salvage
 *
 * **2026-09-16 (the craft material refund) — the baseline is 「the materials a max-skill player actually
 * paid」.** The invariant has to hold for the best player too, so 「the craft inputs」 in the four checks above
 * are all read as `craft inputs × maxSkillCraftFactor(recipe)` (`shared/craftRefund.craftCostFactor`, the
 * expected value — infinite profit is the expectation of repetition, not one lucky roll).
 * Durable gear is not refundable, so its multiplier is 1 and the numbers of this section are what they were;
 * only hand-written salvage (ammo · 기계 부품 · 실드 충전기) competes with a cut baseline. The multiplier is
 * carried as a value, so a change to the refund rule blows up right here.
 */
export interface EconomyViolation {
  defId: string;
  /** The durability bucket 0..4; a fixed salvage is −1. */
  bucket: number;
  message: string;
}

const asMap = (list: readonly CraftIngredient[], factor = 1): Map<string, number> => {
  const m = new Map<string, number>();
  for (const c of list) m.set(c.defId, (m.get(c.defId) ?? 0) + c.qty * factor);
  return m;
};

/** A quantity in an economy-check message — the refund multiplier can make it fractional (`5.2` · `8`). */
const q = (n: number): string => (Number.isInteger(n) ? `${n}` : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''));

/** Checks with the real numbers that no infinite-profit loop exists. Empty = pass. */
export function checkSalvageEconomy(): EconomyViolation[] {
  const bad: EconomyViolation[] = [];

  /* A new weapon family with no recipe written is caught here (no craft means no salvage · repair baseline). */
  for (const w of WEAPON_DEFS) {
    if (isUniqueWeapon(w)) continue;
    const itemId = itemIdForWeapon(w.id);
    if (!craftCostOf(itemId).length) {
      bad.push({ defId: itemId, bucket: -1, message: `${w.name}: data/recipes.csv 에 제작 레시피가 없다` });
    }
  }

  for (const [defId, src] of SALVAGE_SOURCES) {
    // 2026-09-16: the baseline is **the materials max skill actually paid** (durable gear is not refundable, so
    // the multiplier is 1 → the same numbers as before)
    const craft = asMap(src.craft, src.factor);
    const def = ITEM_DEF_MAP.get(defId);
    const repairable = !!def && isRepairable(def) && maxDurabilityOf(def) > 0;
    const top = asMap(scaleSalvage(src.craft, TOP_SALVAGE_MUL));
    /* Gear without durability is **always bucket 4** — checking a bucket that does not exist yields a false
       violation. (2026-09-11: bags now have durability too, so all of buckets 0–4 are looked at.) */
    const first = repairable ? 0 : DURABILITY_BUCKETS - 1;
    for (let b = first; b < DURABILITY_BUCKETS; b++) {
      const salvage = asMap(scaleSalvage(src.craft, SALVAGE_YIELD_BY_DURABILITY[b] ?? 0));
      const repair = asMap(repairable
        ? src.craft.map((i) => ({ defId: i.defId, qty: Math.max(1, Math.ceil(i.qty * (REPAIR_COST_BY_DURABILITY[b] ?? 0) - 1e-9)) }))
        : []);
      let strictlyLess = false;
      for (const [m, c] of craft) {
        const s = salvage.get(m) ?? 0;
        const r = repair.get(m) ?? 0;
        if (s > c) bad.push({ defId, bucket: b, message: `분해 산출 ${m} ${s} > 제작 ${q(c)}` });
        if (r + s > c) bad.push({ defId, bucket: b, message: `수리 ${r} + 분해 ${s} > 제작 ${q(c)} (${m})` });
        if (r + s < c) strictlyLess = true;
        if ((top.get(m) ?? 0) - r > s) bad.push({ defId, bucket: b, message: `수리하고 뜯는 편이 이득 (${m}: ${top.get(m) ?? 0} − ${r} > ${s})` });
      }
      for (const [m, s] of salvage) if (!craft.has(m)) bad.push({ defId, bucket: b, message: `제작에 안 쓰는 ${m} 이 ${s} 나온다` });
      if (!strictlyLess) bad.push({ defId, bucket: b, message: '수리 + 분해가 제작과 완전히 같다 (한 종류라도 더 싸야 한다)' });
    }
  }

  /* 2026-09-11 (C-36) guard: an item with durability and a craft recipe **must not have an empty repair cost
     once it is worn.** If it is empty, `inventory`'s repair restores it to full for no materials (armor did
     exactly that until 2026-09-10, and bags nearly did in C-36). A healing spray's gauge refill
     (`sprayRepairCost`) is taken separately. The runtime refuses on the same rule
     (`needsRepairCost` → `inventory/parts/Durability.repair`). */
  for (const def of ITEM_DEF_MAP.values()) {
    if (!needsRepairCost(def)) continue;
    const max = maxDurabilityOf(def);
    for (let b = 0; b < DURABILITY_BUCKETS; b++) {
      const cur = Math.max(0, Math.min(max - 1, Math.floor(max * b / DURABILITY_BUCKETS)));
      const worn: ItemInstance = { uid: 'economy-check', defId: def.id, qty: 1, rotated: false, durability: cur };
      if (!repairCostFor(worn).length) {
        bad.push({ defId: def.id, bucket: b, message: '제작 레시피가 있는데 수리비가 비어 있다 (REPAIRABLE 에 카테고리가 빠졌다)' });
      }
    }
  }

  /* Hand-written salvage: when that item has a craft recipe, the yield must not exceed the inputs. */
  for (const h of HAND_SALVAGE) {
    const input = h.listed.inputs[0];
    const recipe = CRAFT_RECIPES.find((c) => c.outputDefId === input.defId);
    if (!recipe) continue;
    /* A recipe that makes several at once, like ammo, is converted to "the number that goes into the salvage".
       2026-09-16: and the **max-skill material refund** is applied — ammo · 기계 부품 · 실드 충전기 are not
       durable gear and so are refundable, which makes this the only place the refund actually competes (the
       baseline comes down by `maxSkillCraftFactor`, i.e. `CRAFT_REFUND_CHANCE_AT_MAX`). */
    const factor = maxSkillCraftFactor(recipe);
    const runs = input.qty / recipe.outputQty;
    const craft = asMap(recipe.inputs.map((i) => ({ defId: i.defId, qty: i.qty * runs })), factor);
    const outs = asMap([{ defId: h.listed.outputDefId, qty: h.listed.outputQty }, ...(h.listed.extraOutputs ?? [])]);
    let strictlyLess = false;
    for (const [m, c] of craft) {
      const s = outs.get(m) ?? 0;
      if (s > c + 1e-9) {
        bad.push({ defId: input.defId, bucket: -1, message: `${h.listed.id}: ${m} ${s} > 제작 ${q(c)}`
          + (factor < 1 ? ` (최대 숙련 재료 환급 ×${q(factor)} 뒤)` : '') });
      }
      if (s < c - 1e-9) strictlyLess = true;
    }
    for (const [m, s] of outs) if (!craft.has(m)) bad.push({ defId: input.defId, bucket: -1, message: `${h.listed.id}: 제작에 안 쓰는 ${m} 이 ${s} 나온다` });
    if (!strictlyLess) bad.push({ defId: input.defId, bucket: -1, message: `${h.listed.id}: 분해 산출이 제작 재료와 완전히 같다` });
  }

  return bad;
}
