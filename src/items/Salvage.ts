import type { CraftIngredient, CraftRecipe, DurabilityBucketInfo, ItemCategory, ItemDef, ItemInstance, WeaponClass } from '@/shared';
import { WEAPON_DEFAULT_DURABILITY, csvRows, keyTable, numberList } from '@/shared';
import { ITEM_DEF_MAP, itemIdForWeapon } from './ItemDefs';
import { WEAPON_DEFS, WEAPON_DEF_MAP, gradeOf, isUniqueWeapon, weaponClassOf } from './WeaponDefs';
import { CRAFT_RECIPES, craftCostOf } from './Recipes';

/* ════════════════════════════════════════════════════════════════════════════
 * 분해 · 수리 (2026-09-10 제작 대개편)
 *
 * 기준은 **그 아이템을 새로 제작할 때 드는 재료**다 (`Recipes.craftCostOf`). 남은 내구도를 20 % 단위
 * 다섯 구간으로 나누고 구간마다 정해진 배수를 곱한다 — 수리는 **올림**, 분해는 **내림**.
 *
 * | 남은 내구도 | 수리 | 분해 |
 * |---|---|---|
 * | 81~100 % | ×0.10 | ×0.40 |
 * | 61~80 %  | ×0.20 | ×0.32 |
 * | 41~60 %  | ×0.30 | ×0.24 |
 * | 21~40 %  | ×0.40 | ×0.16 |
 * |  0~20 %  | ×0.50 | ×0.08 |
 *
 * 값은 `data/tables.csv` 의 `REPAIR_COST_BY_DURABILITY` · `SALVAGE_YIELD_BY_DURABILITY` 다.
 *
 * **반올림 규칙** — 수리는 올림(플레이어에게 불리한 쪽), 분해는 내림. 분해에는 **재료 종류마다 최소 1 을
 * 보장하지 않는다**: 보장하면 등급 IV 총의 「강화합금 잉곳 2」가 통째로 돌아와 「제작 → 분해 → 제작」이
 * 이득이 된다. 예외는 **제일 많이 든 재료 한 종류**뿐이고 (`SALVAGE_MAIN_MIN_YIELD`), 그 자리는 언제나
 * 폐금속 · 천조각 같은 하위 재료가 8 이상 들어가 있어 수리비(올림)와 더해도 제작 재료를 넘지 않는다.
 * `checkSalvageEconomy()` 가 모든 아이템 · 모든 구간을 실제 숫자로 검사하고 `npm run data:check` 가 돌린다.
 * ════════════════════════════════════════════════════════════════════════════ */

const T = /* data/tuning.csv */ keyTable('tuning.csv');

/** 구간별 수리 재료 배수 (index 0 = 0~20 % … 4 = 81~100 %). */
export const REPAIR_COST_BY_DURABILITY: readonly number[] = numberList('tables.csv', 'REPAIR_COST_BY_DURABILITY');
/** 구간별 분해 산출 배수 (같은 순서). */
export const SALVAGE_YIELD_BY_DURABILITY: readonly number[] = numberList('tables.csv', 'SALVAGE_YIELD_BY_DURABILITY');

/** 구간 수 (5). */
export const DURABILITY_BUCKETS = REPAIR_COST_BY_DURABILITY.length;
/** 마지막 구간(81~100 %)의 분해 배수 — 목록에 실리는 기준값이다. */
const TOP_SALVAGE_MUL = SALVAGE_YIELD_BY_DURABILITY[DURABILITY_BUCKETS - 1] ?? 0;
/** 구간 표기 — `0~20 %` … `81~100 %`. */
export const DURABILITY_BUCKET_LABELS: readonly string[] =
  REPAIR_COST_BY_DURABILITY.map((_, i) => (i === 0 ? '0~20 %' : `${i * 20 + 1}~${(i + 1) * 20} %`));

/** 수리가 되는 카테고리. 회복 스프레이는 예전대로 `inventory` 의 `sprayRepairCost` 가 맡는다. */
const REPAIRABLE: readonly ItemCategory[] = ['primary', 'secondary', 'armor'];
/** 제작 레시피에서 분해 레시피를 자동 생성하는 카테고리. */
const SALVAGEABLE: readonly ItemCategory[] = ['primary', 'secondary', 'armor', 'bag'];

/** 분해 홀드 시간(초) — 카테고리별 (`data/tuning.csv`). */
function salvageDuration(category: ItemCategory): number {
  if (category === 'armor') return T.num('ARMOR_SALVAGE_DURATION');
  if (category === 'bag') return T.num('BAG_SALVAGE_DURATION');
  return T.num('WEAPON_SALVAGE_DURATION');
}

/* ── 내구도 구간 ──────────────────────────────────────────────────────────── */

/** 이 아이템의 최대 내구도 (없으면 0). 무기는 def 의 값, 나머지는 `ItemDef.durabilityMax`. */
export function maxDurabilityOf(def: ItemDef | undefined): number {
  if (!def) return 0;
  if (def.weaponId) {
    const w = WEAPON_DEF_MAP.get(def.weaponId);
    return w ? (w.maxDurability ?? WEAPON_DEFAULT_DURABILITY) : 0;
  }
  return def.durabilityMax ?? 0;
}

/** 남은 비율 0..1 → 구간 0..4. 정확히 20 % 는 아래 구간(0~20 %)에 붙는다. */
export function bucketOfRatio(ratio: number): number {
  const clamped = Math.max(0, Math.min(1, ratio));
  const b = Math.ceil(clamped * DURABILITY_BUCKETS - 1e-9) - 1;
  return Math.max(0, Math.min(DURABILITY_BUCKETS - 1, b));
}

/** 남은 내구도 비율. 내구도를 안 쓰는 아이템은 언제나 1 (= 구간 4). */
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

/* ── 유니크 대체 기준 ─────────────────────────────────────────────────────────
 * 유니크 무기 · 유니크 방탄복에는 제작 레시피가 없다 (되돌릴 수 없는 유일품이라 **분해도 금지**).
 * 그래도 수리는 되어야 하므로 기준을 하나 빌려 온다 — **같은 총기 종류의 등급 V** (유니크 방탄복은
 * 방탄복 V) 의 제작 재료에 `UNIQUE_REPAIR_MUL` 을 곱한다. 옛 공식(빠진 내구도 ÷ REPAIR_SCRAP_PER)을
 * 남기지 않은 이유: 유니크 내구도는 320~3000 이라 같은 전설끼리도 수리비가 10배 갈렸고, 등급 무기와
 * 완전히 다른 축으로 움직여 "이게 얼마나 비싼 수리인가" 를 읽을 수가 없었다. */
const UNIQUE_REPAIR_MUL = T.num('UNIQUE_REPAIR_MUL');

const GRADE_V_ITEM_BY_CLASS: ReadonlyMap<WeaponClass, string> = new Map(
  WEAPON_DEFS.filter((w) => !isUniqueWeapon(w) && gradeOf(w) === 5).map((w) => [weaponClassOf(w), itemIdForWeapon(w.id)]),
);

/** 제작 레시피가 없는 장비의 기준 재료 (없으면 빈 배열). */
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

/* ── 수리 ─────────────────────────────────────────────────────────────────── */

/**
 * `LootRef.getRepairCost` 의 구현. 완전 수리에 드는 재료 = **제작 재료 × 구간 배수(올림)**.
 * 내구도가 가득이거나 수리 대상이 아니면 `[]`.
 */
export function repairCostFor(inst: ItemInstance): { defId: string; qty: number }[] {
  const def = ITEM_DEF_MAP.get(inst.defId);
  if (!def || !REPAIRABLE.includes(def.category)) return [];
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

/* ── 분해 ─────────────────────────────────────────────────────────────────── */

const MAIN_MIN_YIELD = T.num('SALVAGE_MAIN_MIN_YIELD');

/** 재료 중 **제일 많이 든** 한 줄의 인덱스 (동률이면 먼저 적힌 쪽). */
function mainInputIndex(inputs: readonly CraftIngredient[]): number {
  let best = 0;
  for (let i = 1; i < inputs.length; i++) if (inputs[i].qty > inputs[best].qty) best = i;
  return best;
}

/**
 * 기준 재료 × 배수(내림). 0 이 된 줄은 빠지고 **주재료 한 줄만** `SALVAGE_MAIN_MIN_YIELD` 아래로
 * 떨어지지 않는다. 주재료가 맨 앞으로 오므로 대표 산출물 = 제일 많이 나오는 것이 된다.
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

/** 산출물 목록을 `outputDefId` + `extraOutputs` 로 접어 넣는다. 산출이 없으면 null. */
function withOutputs(base: CraftRecipe, outputs: CraftIngredient[]): CraftRecipe | null {
  if (!outputs.length) return null;
  const [head, ...rest] = outputs;
  const out: CraftRecipe = { ...base, outputDefId: head.defId, outputQty: head.qty };
  if (rest.length) out.extraOutputs = rest;
  else delete out.extraOutputs;
  return out;
}

/* ── data/salvage.csv — 손으로 적은 분해 ─────────────────────────────────────── */

interface HandSalvage {
  /** 목록에 실리는 레시피 (`scaleByDurability` 면 구간 4 기준으로 이미 줄여 둔 것). */
  listed: CraftRecipe;
  /** 100 % 기준 산출물. `scaled` 가 false 면 그대로 나온다. */
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

/* ── 제작 레시피에서 생성한 분해 ───────────────────────────────────────────────
 * 무기 25종 · 방탄복 5벌 · 가방 8종. 산출이 **그 아이템의 제작 재료 구성을 그대로 따라가므로**
 * 총을 뜯으면 폐금속만이 아니라 그 등급이 요구한 합금 판 · 기계 부품 · 강화합금 잉곳도 나온다.
 * 유니크 무기 · 유니크 방탄복은 제작 레시피가 없어 **자동으로 빠진다** (분해 금지 규칙 그대로). */

interface SalvageSource {
  /** 100 % 기준 = 제작 재료. */
  craft: readonly CraftIngredient[];
  /** 구간 4 기준으로 조립해 둔 레시피 (`getAllRecipes()` 에 실리는 것). */
  listed: CraftRecipe;
}

const SALVAGE_SOURCES: ReadonlyMap<string, SalvageSource> = (() => {
  const out = new Map<string, SalvageSource>();
  for (const r of CRAFT_RECIPES) {
    if (r.outputQty !== 1) continue;
    const def = ITEM_DEF_MAP.get(r.outputDefId);
    if (!def || !SALVAGEABLE.includes(def.category) || out.has(def.id)) continue;
    const gun = def.category === 'primary' || def.category === 'secondary';
    const shell: CraftRecipe = {
      id: `break_${def.id}`, name: `${def.name} 분해`, station: 'field',
      inputs: [{ defId: def.id, qty: 1 }], outputDefId: 'mat_scrap', outputQty: 1,
      duration: salvageDuration(def.category), skill: 'crafting', skillRequired: 0,
      description: `${def.name} 을(를) 뜯어 제작 재료 일부를 되찾는다. 남은 내구도가 높을수록 많이 나온다.`
        + (gun ? ' 부착물은 먼저 가방으로 돌아온다.' : ''),
    };
    const listed = withOutputs(shell, scaleSalvage(r.inputs, TOP_SALVAGE_MUL));
    if (listed) out.set(def.id, { craft: r.inputs, listed });
  }
  return out;
})();

/**
 * 분해 레시피 전부 (`break_*`). ⚠ **생성 분해가 여기 실릴 때의 수량은 구간 4(81~100 %) 기준**이므로
 * 실제 소비 · 산출에는 `salvageFor(inst)` 가 돌려준 레시피를 쓴다.
 */
export const SALVAGE_RECIPES: readonly CraftRecipe[] = [
  ...HAND_SALVAGE.map((h) => h.listed),
  ...[...SALVAGE_SOURCES.values()].map((s) => s.listed),
];

/** 제작 + 분해. `ctx.loot.getAllRecipes()` 가 내주는 목록. */
export const ALL_CRAFT_RECIPES: readonly CraftRecipe[] = [...CRAFT_RECIPES, ...SALVAGE_RECIPES];

export const CRAFT_RECIPE_MAP: ReadonlyMap<string, CraftRecipe> = new Map(ALL_CRAFT_RECIPES.map((r) => [r.id, r]));

export function getRecipe(id: string): CraftRecipe | undefined {
  return CRAFT_RECIPE_MAP.get(id);
}

/**
 * `LootRef.getSalvageFor` 의 구현 — 이 인스턴스를 **지금** 분해하면 나오는 것.
 * 손으로 적은 고정 분해(탄약 · 기계 부품 · 충전기)는 내구도와 무관하게 표에 적힌 그대로다.
 */
export function salvageFor(inst: ItemInstance): CraftRecipe | null {
  const src = SALVAGE_SOURCES.get(inst.defId);
  if (src) return withOutputs(src.listed, scaleSalvage(src.craft, SALVAGE_YIELD_BY_DURABILITY[durabilityBucketOf(inst)] ?? 0));
  const hand = HAND_BY_INPUT.get(inst.defId);
  if (!hand) return null;
  if (!hand.scaled) return hand.listed;
  return withOutputs(hand.listed, scaleSalvage(hand.base, SALVAGE_YIELD_BY_DURABILITY[durabilityBucketOf(inst)] ?? 0));
}

/* ── 검산 ─────────────────────────────────────────────────────────────────────
 * 「제작 → (수리) → 분해 → 제작」 이 이득이 되지 않는다는 것을 **실제 숫자로** 확인한다.
 * `npm run data:check` 가 돌린다 (scripts/data-check.mjs). 네 가지를 본다:
 *
 *  (1) 분해 산출 ≤ 제작 재료 (한 종류라도 넘으면 재료가 스스로 늘어난다)
 *  (2) 수리 재료 + 분해 산출 ≤ 제작 재료, 그리고 적어도 한 종류는 **엄격히 작다**
 *  (3) 분해(구간 4) − 수리(구간 b) ≤ 분해(구간 b) — "고쳐서 뜯는" 편이 "지금 뜯는" 것보다 이득이면 안 된다
 *  (4) 제작에 안 쓰는 재료가 분해에서 나오지 않는다
 */
export interface EconomyViolation {
  defId: string;
  /** 내구도 구간 0..4, 고정 분해는 −1. */
  bucket: number;
  message: string;
}

const asMap = (list: readonly CraftIngredient[]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const c of list) m.set(c.defId, (m.get(c.defId) ?? 0) + c.qty);
  return m;
};

/** 무한 이득 루프가 없는지 실제 숫자로 검사한다. 비어 있으면 통과. */
export function checkSalvageEconomy(): EconomyViolation[] {
  const bad: EconomyViolation[] = [];

  /* 무기 계열이 늘었는데 레시피를 안 적으면 여기서 잡힌다 (제작이 없으면 분해 · 수리 기준도 사라진다). */
  for (const w of WEAPON_DEFS) {
    if (isUniqueWeapon(w)) continue;
    const itemId = itemIdForWeapon(w.id);
    if (!craftCostOf(itemId).length) {
      bad.push({ defId: itemId, bucket: -1, message: `${w.name}: data/recipes.csv 에 제작 레시피가 없다` });
    }
  }

  for (const [defId, src] of SALVAGE_SOURCES) {
    const craft = asMap(src.craft);
    const def = ITEM_DEF_MAP.get(defId);
    const repairable = !!def && REPAIRABLE.includes(def.category) && maxDurabilityOf(def) > 0;
    const top = asMap(scaleSalvage(src.craft, TOP_SALVAGE_MUL));
    /* 내구도가 없는 장비(가방)는 **언제나 구간 4** 다 — 있지도 않은 구간을 검사하면 거짓 위반이 나온다. */
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
        if (s > c) bad.push({ defId, bucket: b, message: `분해 산출 ${m} ${s} > 제작 ${c}` });
        if (r + s > c) bad.push({ defId, bucket: b, message: `수리 ${r} + 분해 ${s} > 제작 ${c} (${m})` });
        if (r + s < c) strictlyLess = true;
        if ((top.get(m) ?? 0) - r > s) bad.push({ defId, bucket: b, message: `수리하고 뜯는 편이 이득 (${m}: ${top.get(m) ?? 0} − ${r} > ${s})` });
      }
      for (const [m, s] of salvage) if (!craft.has(m)) bad.push({ defId, bucket: b, message: `제작에 안 쓰는 ${m} 이 ${s} 나온다` });
      if (!strictlyLess) bad.push({ defId, bucket: b, message: '수리 + 분해가 제작과 완전히 같다 (한 종류라도 더 싸야 한다)' });
    }
  }

  /* 손으로 적은 분해: 그 아이템에 제작 레시피가 있으면 산출이 재료를 넘지 않아야 한다. */
  for (const h of HAND_SALVAGE) {
    const input = h.listed.inputs[0];
    const recipe = CRAFT_RECIPES.find((c) => c.outputDefId === input.defId);
    if (!recipe) continue;
    /* 탄약처럼 한 번에 여러 개를 만드는 레시피는 "분해에 들어가는 개수" 에 맞춰 환산한다. */
    const runs = input.qty / recipe.outputQty;
    const craft = asMap(recipe.inputs.map((i) => ({ defId: i.defId, qty: i.qty * runs })));
    const outs = asMap([{ defId: h.listed.outputDefId, qty: h.listed.outputQty }, ...(h.listed.extraOutputs ?? [])]);
    let strictlyLess = false;
    for (const [m, c] of craft) {
      const s = outs.get(m) ?? 0;
      if (s > c) bad.push({ defId: input.defId, bucket: -1, message: `${h.listed.id}: ${m} ${s} > 제작 ${c}` });
      if (s < c) strictlyLess = true;
    }
    for (const [m, s] of outs) if (!craft.has(m)) bad.push({ defId: input.defId, bucket: -1, message: `${h.listed.id}: 제작에 안 쓰는 ${m} 이 ${s} 나온다` });
    if (!strictlyLess) bad.push({ defId: input.defId, bucket: -1, message: `${h.listed.id}: 분해 산출이 제작 재료와 완전히 같다` });
  }

  return bad;
}
