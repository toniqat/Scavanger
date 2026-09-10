import type { EnemyType, ItemCategory, Rarity, WeaponGrade } from '@/shared';
import { UNIQUE_WEAPON_IDS, csvGroups, csvRows } from '@/shared';

/*
 * 루팅 수치의 원본은 `data/loot_*.csv` 다 — 티어 굴림 규칙(`loot_tiers.csv`), 카테고리 가중치,
 * 확정 픽, 아이템별 배수, 그리고 시체 드랍(`loot_corpses.csv` · `loot_corpse_rolls.csv`).
 * 이 파일에는 표가 없고 그 줄들을 타입 있는 표로 옮기는 코드만 있다.
 */
import { WEAPON_FAMILIES, WEAPON_GRADES } from './WeaponDefs';
import { UNIQUE_AMMO_TYPES, ammoItemIdFor, itemIdForWeapon } from './ItemDefs';
import { IMPLANT_BROKEN_DEFS, IMPLANT_WORKING_DEFS } from './ImplantDefs';

/* ── 묶음 토큰 ─────────────────────────────────────────────────────────────
 * `loot_item_weights.csv` 의 `target` 은 아이템 id 하나이거나 `@` 로 시작하는 묶음이다.
 * 묶음은 "이 티어에서는 유니크 전부 0" 같은 규칙을 한 줄로 적기 위한 것이다. */
const record = (ids: readonly string[], mul: number): Record<string, number> => Object.fromEntries(ids.map((id) => [id, mul]));

/** `@토큰` → 그 토큰이 가리키는 아이템 id 목록. */
const WEIGHT_GROUPS: Readonly<Record<string, () => readonly string[]>> = {
  /** `wpn_u_*` (유니크는 자기 자신이 계열이다). */
  '@unique_weapons': () => UNIQUE_WEAPON_IDS.map(itemIdForWeapon),
  /** `ammo_fuel` … `ammo_belt`. */
  '@unique_ammo': () => UNIQUE_AMMO_TYPES.map(ammoItemIdFor),
  /** 등급 무기 6계열 (`ar` … `hg`, 모든 등급). */
  '@graded_families': () => WEAPON_FAMILIES,
  /** 정상 임플란트 전부 — 상자에서는 절대 안 나오므로 대개 0 이다. */
  '@working_implants': () => IMPLANT_WORKING_DEFS.map((d) => d.id),
};
/** `@broken_implants.<rarity>` — 그 등급의 망가진 임플란트. */
const BROKEN_IMPLANT_PREFIX = '@broken_implants.';

function expandWeightTarget(target: string): readonly string[] {
  if (!target.startsWith('@')) return [target];
  const group = WEIGHT_GROUPS[target];
  if (group) return group();
  if (target.startsWith(BROKEN_IMPLANT_PREFIX)) {
    const rarity = target.slice(BROKEN_IMPLANT_PREFIX.length);
    return IMPLANT_BROKEN_DEFS.filter((d) => d.rarity === rarity).map((d) => d.id);
  }
  return [];
}

/**
 * Per-tier crate tables. Rolling picks a category by `categoryWeights`, then an
 * ItemDef of that category weighted by `rarityWeights[def.rarity]` (0 = never).
 * `guaranteed` entries are always added first and count toward `count`.
 * Weapon grades map 1:1 to rarity, so `rarityWeights` also shape the grade distribution.
 */
export interface GuaranteedRoll {
  /** Categories allowed for this guaranteed pick. */
  categories: readonly ItemCategory[];
  /** Minimum rarity (inclusive). */
  minRarity: Rarity;
}

export interface TierTable {
  tier: number;
  /** Korean container title shown in the loot window. */
  label: string;
  /** Total item count [min, max] (inclusive), guaranteed picks included. */
  count: readonly [number, number];
  rarityWeights: Readonly<Record<Rarity, number>>;
  categoryWeights: Readonly<Partial<Record<ItemCategory, number>>>;
  /** Chance that one of the random picks is replaced by a weapon (primary or secondary). */
  weaponChance: number;
  /** Cap on stackable qty per roll for non-ammo stackables (further limited by def.stackMax). */
  maxStackQty: number;
  /** Ammo rolls: rounds = stackMax × a fraction drawn from [min, max]. */
  ammoFraction: readonly [number, number];
  guaranteed: readonly GuaranteedRoll[];
  /**
   * Optional weight multiplier (0 = never at this tier). Keys are item def ids; for weapons a key
   * of the family (`wpn_sr` or `sr`) applies to every grade of that family.
   */
  itemWeightMul?: Readonly<Record<string, number>>;
}

const RARITY_ORDER_5: readonly Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

/** 티어별 카테고리 가중치 / 확정 픽 / 아이템 배수를 티어 번호로 모아 둔다. */
const CATEGORY_WEIGHTS_BY_TIER = csvGroups('loot_category_weights.csv', 'tier');
const GUARANTEED_BY_TIER = csvGroups('loot_guaranteed.csv', 'tier');
const ITEM_WEIGHTS_BY_TIER = csvGroups('loot_item_weights.csv', 'tier');

export const LOOT_TABLES: readonly TierTable[] = csvRows('loot_tiers.csv').map((r) => {
  const tier = r.int('tier', { min: 1 });
  const key = String(tier);

  const categoryWeights: Partial<Record<ItemCategory, number>> = {};
  for (const c of CATEGORY_WEIGHTS_BY_TIER.get(key) ?? []) {
    categoryWeights[c.str('category') as ItemCategory] = c.num('weight', { min: 0 });
  }

  const itemWeightMul: Record<string, number> = {};
  for (const w of ITEM_WEIGHTS_BY_TIER.get(key) ?? []) {
    const target = w.str('target');
    const mul = w.num('mul', { min: 0 });
    const ids = expandWeightTarget(target);
    if (!ids.length) w.report('target', `'${target}' 이 가리키는 아이템이 없다`);
    Object.assign(itemWeightMul, record(ids, mul));
  }

  return {
    tier,
    label: r.str('label'),
    count: [r.int('countMin', { min: 0 }), r.int('countMax', { min: 0 })] as const,
    rarityWeights: Object.fromEntries(RARITY_ORDER_5.map((q) => [q, r.num(q, { min: 0 })])) as Record<Rarity, number>,
    categoryWeights,
    weaponChance: r.num('weaponChance', { min: 0, max: 1 }),
    maxStackQty: r.int('maxStackQty', { min: 1 }),
    ammoFraction: [r.num('ammoFracMin', { min: 0 }), r.num('ammoFracMax', { min: 0 })] as const,
    guaranteed: (GUARANTEED_BY_TIER.get(key) ?? []).map((g) => ({
      categories: g.list('categories') as ItemCategory[],
      minRarity: g.str('minRarity') as Rarity,
    })),
    itemWeightMul,
  };
});

export const LOOT_TABLE_MAP: ReadonlyMap<number, TierTable> = new Map(LOOT_TABLES.map((t) => [t.tier, t]));

export function getTierTable(tier: number): TierTable {
  const clamped = Math.max(1, Math.min(LOOT_TABLES.length, Math.round(tier)));
  return LOOT_TABLE_MAP.get(clamped) ?? LOOT_TABLES[0];
}

export function getTierLabel(tier: number): string {
  return getTierTable(tier).label;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2026-09-09: 행성 진행도별 **무기 등급** 곡선 (`data/planet_loot.csv`)
 *
 * 상자 티어의 `rarityWeights` 는 계속 다른 카테고리(부착물 · 방어구 · 임플란트 …)의 희귀도를 정하고,
 * **무기 등급만** 이 표가 다시 정한다 — 앞쪽 행성에서 III 이상이 거의 안 나오게 하려면 티어 표를
 * 건드릴 수밖에 없는데 그러면 총이 아닌 물건까지 같이 짜지기 때문이다.
 * ──────────────────────────────────────────────────────────────────────────── */

/** 행성 하나의 무기 등급 곡선. `rank` 는 `planetTier()` 가 주는 난이도 순번 1..5 다. */
export interface PlanetGradeCurve {
  rank: number;
  /** 사람이 읽으라고 둔 이름 (csv 의 `name` 칸). 코드는 비교에 쓰지 않는다. */
  name: string;
  /** 가중치가 양수인 등급만 — 이 배열이 곧 그 행성에서 나올 수 있는 등급 전부다. */
  grades: readonly WeaponGrade[];
  /** 등급 → 가중치 (0 인 등급은 `grades` 에 없다). */
  weightOf: Readonly<Partial<Record<WeaponGrade, number>>>;
  /** 그 행성의 **최대 등급** = `grades` 의 마지막. 시체 무기는 이 값으로 상한만 받는다. */
  maxGrade: WeaponGrade;
  /**
   * 전설 **유니크 무기** 등장 확률에 곱하는 배수 (0 = 그 행성에서 유니크 없음).
   * 유니크는 등급이 없어 `grades` 곡선을 안 타므로 따로 막는다 — 등급 V 가 봉인된 행성에서
   * 그보다 윗급이 나오면 앞뒤가 안 맞기 때문이다. 상자 픽 가중치와 보스 시체 유니크 굴림 양쪽에 걸린다.
   */
  uniqueMul: number;
  /**
   * 2026-09-10: **총기가 아닌 것들**(방탄복 · 가방 · 부착물 · 임플란트 · 소모품 · 재료 · 귀중품 …)의
   * 희귀도 가중치에 곱하는 배수 — `data/planet_loot.csv` 의 `rareMul` · `epicMul` · `legMul`.
   * common · uncommon 은 언제나 1 이다: 그 둘은 **깎인 몫을 되받는 쪽**이라 곱하는 대상이 아니다
   * (`planetRarityWeights` 참고).
   *
   * 총기 등급은 이 배수를 안 탄다 — `grades` 곡선이 뽑은 등급이 그 위를 덮어쓰기 때문이다
   * (`Loot.regrade`). 두 축은 일부러 갈라 놨다.
   */
  rarityMul: Readonly<Record<Rarity, number>>;
  /** 세 배수가 전부 1 인가 = 이 행성은 희귀도를 손대지 않는다. `planetRarityWeights` 의 우회 조건. */
  rarityMulIdentity: boolean;
}

/**
 * 배수가 곱해지는 등급과 그 값이 든 csv 열 이름. 이 셋 말고는 곱하지 않는다.
 * 열을 늘리려면 여기와 `planet_loot.csv` 의 헤더를 같이 늘린다.
 */
const RARITY_MUL_COLUMNS: readonly (readonly [Rarity, string])[] = [
  ['rare', 'rareMul'],
  ['epic', 'epicMul'],
  ['legendary', 'legMul'],
];

/**
 * 깎인 총량을 **원래 비율 그대로** 되돌려 받는 등급. 이 둘이 있어서 배수를 걸어도 가중치 합이 안 변한다 —
 * 희귀 이상이 줄어든 만큼 정확히 그만큼 일반 · 고급이 늘고, "상자에서 물건이 덜 나온다" 가 되지 않는다.
 */
const RARITY_REFUND: readonly Rarity[] = ['common', 'uncommon'];

export const PLANET_GRADE_CURVES: readonly PlanetGradeCurve[] = csvRows('planet_loot.csv').map((r) => {
  const weightOf: Partial<Record<WeaponGrade, number>> = {};
  for (const g of WEAPON_GRADES) {
    const w = r.num(`g${g}`, { min: 0 });
    if (w > 0) weightOf[g] = w;
  }
  const grades = WEAPON_GRADES.filter((g) => (weightOf[g] ?? 0) > 0);
  if (grades.length === 0) r.report('g1', '등급 가중치가 전부 0 이다 — 이 행성에서는 무기가 아예 안 나온다');
  /* 빈 칸 · 없는 열은 1 (= 손대지 않음) — 열을 못 찾아 행성 전체가 조용히 짜지는 것보다 낫다. */
  const rarityMul = Object.fromEntries(RARITY_ORDER_5.map((q) => [q, 1])) as Record<Rarity, number>;
  for (const [rarity, column] of RARITY_MUL_COLUMNS) rarityMul[rarity] = r.num(column, { min: 0, fallback: 1 });
  return {
    rank: r.int('rank', { min: 1 }),
    name: r.str('name'),
    grades,
    weightOf,
    maxGrade: (grades[grades.length - 1] ?? 1) as WeaponGrade,
    uniqueMul: r.num('uniqueMul', { min: 0 }),
    rarityMul,
    rarityMulIdentity: RARITY_MUL_COLUMNS.every(([rarity]) => rarityMul[rarity] === 1),
  };
});

const PLANET_GRADE_CURVE_MAP: ReadonlyMap<number, PlanetGradeCurve> = new Map(PLANET_GRADE_CURVES.map((c) => [c.rank, c]));

/**
 * 난이도 순번(`planetTier()`, 1..5)의 곡선. 표에 없는 순번이면 `null` — 그때는 예전처럼
 * 상자 티어의 희귀도 가중치가 무기 등급을 정한다 (행성을 안 고른 훈련장 · 구형 세이브).
 */
export function getPlanetGradeCurve(rank: number): PlanetGradeCurve | null {
  return PLANET_GRADE_CURVE_MAP.get(Math.round(rank)) ?? null;
}

/** `base` 객체 하나당 rank → 조정된 가중치. 굴림마다 새 객체를 만들지 않으려고 들고 있는다. */
const RARITY_WEIGHT_CACHE = new WeakMap<object, Map<number, Readonly<Partial<Record<Rarity, number>>>>>();

/**
 * 2026-09-10: 희귀도 가중치 한 벌에 그 행성의 `rareMul` · `epicMul` · `legMul` 을 걸어 돌려준다.
 *
 * 1. rare · epic · legendary 에 각각 배수를 곱한다.
 * 2. 그렇게 **깎인 총량**(`shaved`)을 common · uncommon 이 **원래 가지고 있던 비율 그대로** 나눠 받는다.
 *
 * 그래서 가중치 **합은 그대로**다 — 희귀 이상이 준 만큼 정확히 일반 · 고급이 는다. 상자에서 나오는
 * 물건의 개수(`count`)는 어차피 이 표와 무관하지만, 합이 흔들리면 `itemWeightMul` 같은 다른 배수의
 * 세기가 행성마다 달라져 표를 읽을 수 없게 된다.
 *
 * **배수가 셋 다 1 이면 `base` 를 그대로(같은 객체로) 돌려준다** — 부동소수 곱셈조차 하지 않으므로
 * rank 2~5 의 결과는 이 기능이 없던 때와 비트 단위로 같다. `curve` 가 null 인 경로(훈련장 · 구형 세이브)도 같다.
 *
 * ⚠ 표에 **되돌려 받을 자리(common · uncommon)가 하나도 없으면** 재분배를 건너뛴다 — 합은 줄지만
 *   세 배수가 같은 값이면 서로 상쇄돼 비율이 그대로다 (확정 픽처럼 후보가 이미 희귀 이상뿐인 굴림에서
 *   배수가 상쇄되는 것과 같은 이야기다). 깎을 자리가 없는 표는 `shaved` 가 0 이라 그냥 지나간다.
 */
export function planetRarityWeights<T extends Readonly<Partial<Record<Rarity, number>>>>(
  base: T, curve: PlanetGradeCurve | null,
): T {
  if (!curve || curve.rarityMulIdentity) return base;
  let byRank = RARITY_WEIGHT_CACHE.get(base);
  if (!byRank) { byRank = new Map(); RARITY_WEIGHT_CACHE.set(base, byRank); }
  const hit = byRank.get(curve.rank);
  if (hit) return hit as T;

  const out: Partial<Record<Rarity, number>> = { ...base };
  let shaved = 0;
  for (const [rarity] of RARITY_MUL_COLUMNS) {
    const w = base[rarity];
    if (w === undefined) continue;
    const scaled = w * curve.rarityMul[rarity];
    shaved += w - scaled;
    out[rarity] = scaled;
  }
  let refundBase = 0;
  for (const rarity of RARITY_REFUND) refundBase += base[rarity] ?? 0;
  if (shaved !== 0 && refundBase > 0) {
    for (const rarity of RARITY_REFUND) {
      const w = base[rarity];
      if (w !== undefined) out[rarity] = w + shaved * (w / refundBase);
    }
  }
  byRank.set(curve.rank, out);
  return out as T;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Phase 4: corpse tables (`LootRef.rollCorpse`)
 * ──────────────────────────────────────────────────────────────────────────── */
/** One possible corpse drop: `chance` (1 = always) then `qty` drawn from [min, max] inclusive. */
export interface CorpseDrop {
  defId: string;
  qty: readonly [number, number];
  chance: number;
}

/** Rogue corpses carry the weapon the rogue fought with (item `wpn_<weaponId>`). */
export interface CorpseWeapon {
  /** Durability as a fraction of the def's max, drawn from [min, max]. `ammoInMag` is rng 0..magSize. */
  durability: readonly [number, number];
  /** When set, the weapon is re-graded to one of these grades of the same family (bosses). */
  grades?: readonly WeaponGrade[];
  /** When set, one random `att_*` attachment (rarity ≤ `maxRarity`, fitting the weapon when possible) is added. */
  attachment?: { maxRarity: Rarity };
}

/** Phase 6: chance of one extra legendary unique (`UNIQUE_WEAPON_IDS`, uniform) plus a stack of its calibre. */
export interface CorpseUnique {
  chance: number;
  /** Durability as a fraction of the def's max, drawn from [min, max]. */
  durability: readonly [number, number];
}

/** Phase 9: chance of one 서적 (uniform over `BOOK_ITEM_DEFS`) on a rogue corpse — the reading kind of raider. */
export interface CorpseBook {
  chance: number;
}

/**
 * Phase 12: chance of one **망가진 임플란트** (`IMPLANT_BROKEN_DEFS`, picked by `weights[rarity]`; 0 / missing = never) on a
 * rogue corpse — raiders wear implants and a kill shot fries them. Rolled last in `rollCorpse` so earlier draws never move.
 */
export interface CorpseImplant {
  chance: number;
  weights: Readonly<Partial<Record<Rarity, number>>>;
}

const CORPSE_ROLLS = new Map(csvRows('loot_corpse_rolls.csv').map((r) => [r.str('type'), r]));

export interface CorpseTable {
  type: EnemyType;
  drops: readonly CorpseDrop[];
  /** Phase 9: 서적 roll (rogues only; bugs never carry books). */
  book?: CorpseBook;
  /** Phase 12: 망가진 임플란트 roll (rogues only; legendaries from the boss). */
  implant?: CorpseImplant;
  /** Rounds of the weapon's calibre as a fraction of `AMMO_STACK_ROUNDS`, one stack (rogues only). */
  ammoFraction?: readonly [number, number];
  weapon?: CorpseWeapon;
  unique?: CorpseUnique;
}

/**
 * 시체 드랍 — `data/loot_corpses.csv` (아이템) + `data/loot_corpse_rolls.csv` (총 · 서적 · 임플란트 · 유니크).
 * Phase 8: bugs graze on the local flora, so an undigested 씨앗 turns up in a bug corpse now and then.
 * Phase 9: 서적 go the other way — rogues only (`CorpseTable.book`), never on a bug.
 */
const CORPSE_DROPS_BY_TYPE = csvGroups('loot_corpses.csv', 'type');

export const CORPSE_TABLES: readonly CorpseTable[] = [...CORPSE_DROPS_BY_TYPE.keys()]
  .filter((type) => !!type)
  .map((type) => {
    const drops: CorpseDrop[] = (CORPSE_DROPS_BY_TYPE.get(type) ?? []).map((d) => ({
      defId: d.str('defId'),
      qty: [d.int('qtyMin', { min: 0 }), d.int('qtyMax', { min: 0 })] as const,
      chance: d.num('chance', { min: 0, max: 1 }),
    }));
    const roll = CORPSE_ROLLS.get(type);
    return {
      type: type as EnemyType,
      drops,
      ...(roll?.has('ammoFracMin') ? {
        ammoFraction: [roll.num('ammoFracMin', { min: 0 }), roll.num('ammoFracMax', { min: 0 })] as const,
      } : {}),
      ...(roll?.has('weaponDurMin') ? {
        weapon: {
          durability: [roll.num('weaponDurMin', { min: 0, max: 1 }), roll.num('weaponDurMax', { min: 0, max: 1 })] as const,
          ...(roll.has('weaponGrades') ? { grades: roll.list('weaponGrades').map(Number) as WeaponGrade[] } : {}),
          ...(roll.has('weaponAttachMaxRarity') ? { attachment: { maxRarity: roll.str('weaponAttachMaxRarity') as Rarity } } : {}),
        },
      } : {}),
      ...(roll?.has('uniqueChance') ? {
        unique: {
          chance: roll.num('uniqueChance', { min: 0, max: 1 }),
          durability: [roll.num('uniqueDurMin', { min: 0, max: 1 }), roll.num('uniqueDurMax', { min: 0, max: 1 })] as const,
        },
      } : {}),
      ...(roll?.has('bookChance') ? { book: { chance: roll.num('bookChance', { min: 0, max: 1 }) } } : {}),
      ...(roll?.has('implantChance') ? {
        implant: {
          chance: roll.num('implantChance', { min: 0, max: 1 }),
          weights: Object.fromEntries(roll.costList('implantWeights').map((c) => [c.defId, c.qty])) as Partial<Record<Rarity, number>>,
        },
      } : {}),
    };
  });

export const CORPSE_TABLE_MAP: ReadonlyMap<EnemyType, CorpseTable> = new Map(CORPSE_TABLES.map((t) => [t.type, t]));

/** Weapon a rogue carries when the caller passes no `rogueWeaponId`. */
export const DEFAULT_ROGUE_WEAPON_ID = 'ar';
