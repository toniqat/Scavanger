import type { EnemyType, ItemCategory, ItemDef, Rarity, WeaponGrade } from '@/shared';
/* appended (2026-09-13): 인간형 팩션 전리품 — 스폰 거점 보너스 · 행성 씨앗 표 */
import type { EnemySpawnSite, PlanetId } from '@/shared';
import { UNIQUE_WEAPON_IDS, csvGroups, csvRows } from '@/shared';

/*
 * 루팅 수치의 원본은 `data/loot_*.csv` 다 — 티어 굴림 규칙(`loot_tiers.csv`), 카테고리 가중치,
 * 확정 픽, 아이템별 배수, 그리고 시체 드랍(`loot_corpses.csv` · `loot_corpse_rolls.csv`).
 * 이 파일에는 표가 없고 그 줄들을 타입 있는 표로 옮기는 코드만 있다.
 */
import { WEAPON_FAMILIES, WEAPON_GRADES } from './WeaponDefs';
import { ITEM_DEF_MAP, UNIQUE_AMMO_TYPES, ammoItemIdFor, itemIdForWeapon } from './ItemDefs';
import { IMPLANT_BROKEN_DEFS, IMPLANT_WORKING_DEFS } from './ImplantDefs';
/* appended (2026-09-11): 네임드 확정 드롭의 방탄복 등급 → armor_n */
import { ARMOR_DEFS } from './ArmorDefs';

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

/* ── 은퇴한 아이템 (2026-09-13, 요리 재료 티어) ─────────────────────────────
 * `ItemDef.retired` — 옛 표본 11종 · 옛 세포주 5 · 배양 산물 5 · 특선 요리 4. 정의는 남지만 **상자 · 보급 추첨에 절대 안
 * 들어간다**: csv(`loot_item_weights.csv`)에 줄을 남기든 지우든, 누가 그 카테고리를 다른 티어에 더하든 상관없이 여기서 막는다.
 * 두 겹이다 — 티어 표의 `itemWeightMul` 을 0 으로 덮고(표를 읽는 도구도 같은 답을 본다), `Loot.pickDef` 가 후보에서 뺀다
 * (가중치가 전부 0 일 때 확정 픽이 균등 추첨으로 떨어지는 `relaxRarity` 경로까지). 표끼리의 참조(레시피 · 시체 표 · 행성 ·
 * 분석 결과)는 `npm run data:check` 가 잡는다. */
export const RETIRED_ITEM_IDS: ReadonlySet<string> = new Set([...ITEM_DEF_MAP.values()].filter((d) => d.retired).map((d) => d.id));

/** 상자 · 보급 추첨의 후보가 될 수 있는 아이템인가 (은퇴한 것은 아니다). */
export function isLootableDef(d: ItemDef): boolean {
  return !d.retired;
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
  /* 2026-09-13 안전핀: 은퇴한 아이템은 csv 에 어떤 줄이 있든 **모든 티어에서 배수 0** 이다. */
  for (const id of RETIRED_ITEM_IDS) itemWeightMul[id] = 0;

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

/* 2026-09-13: 표의 종류 = 아이템 드롭 줄 ∪ 따로 굴리는 줄 — 들고 있던 총만 있는 적도 시체 표를 갖는다.
   먼저 나온 순서 그대로라 기존 적의 표 · 굴림은 한 톨도 안 바뀐다. */
export const CORPSE_TABLES: readonly CorpseTable[] = [...new Set([...CORPSE_DROPS_BY_TYPE.keys(), ...CORPSE_ROLLS.keys()])]
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

/* ────────────────────────────────────────────────────────────────────────────
 * 2026-09-11: 네임드 로그의 **확정 드롭** (`data/loot_named.csv`)
 *
 * 로든 = 저격소총 III~V · 타길라 = 방탄복 III~V · 헤비 = 유니크 미니건. 셋 다 내구도 1–5 %
 * (`NAMED_LOOT_DURABILITY_MIN/MAX`, constants). 일반 시체 표와 별개로 `rollCorpse` 의 **맨 마지막**에 굴리므로
 * 네임드가 아닌 적의 rng 벡터는 한 톨도 안 움직인다. 행성 곡선은 걸지 않는다 (사용자 명세 "최소 희귀부터").
 * ──────────────────────────────────────────────────────────────────────────── */

export type NamedDropKind = 'weapon' | 'armor' | 'item';

export interface NamedDrop {
  type: EnemyType;
  kind: NamedDropKind;
  /** weapon = 등급 무기 계열 id (`sr`) · item = 아이템 id (`wpn_u_minigun`) · armor = '' */
  target: string;
  chance: number;
  /** 가중치가 양수인 등급 (weapon · armor). item 이면 빈 배열. */
  grades: readonly WeaponGrade[];
  weightOf: Readonly<Partial<Record<WeaponGrade, number>>>;
  /** 장전 탄약 = 탄창 × [min, max]. 없으면 0..탄창 균등. */
  magFraction?: readonly [number, number];
  /** 그 무기 탄종 한 스택 × [min, max]. 없으면 탄약 없음. */
  ammoFraction?: readonly [number, number];
}

export const NAMED_DROPS: readonly NamedDrop[] = csvRows('loot_named.csv').map((r) => {
  const kind = r.enum('kind', ['weapon', 'armor', 'item'] as const);
  const target = r.has('target') ? r.str('target') : '';
  const weightOf: Partial<Record<WeaponGrade, number>> = {};
  for (const c of r.costList('grades')) {
    const g = Number(c.defId);
    if (!(WEAPON_GRADES as readonly number[]).includes(g)) { r.report('grades', `'${c.defId}' 는 등급(1..5)이 아니다`); continue; }
    if (c.qty > 0) weightOf[g as WeaponGrade] = c.qty;
  }
  const grades = WEAPON_GRADES.filter((g) => (weightOf[g] ?? 0) > 0);

  if (kind === 'weapon') {
    if (!(WEAPON_FAMILIES as readonly string[]).includes(target)) r.report('target', `'${target}' 는 등급 무기 계열이 아니다`);
    if (!grades.length) r.report('grades', 'weapon 드롭에 등급 가중치가 없다');
  } else if (kind === 'armor') {
    if (!grades.length) r.report('grades', 'armor 드롭에 등급 가중치가 없다');
    for (const g of grades) if (!ARMOR_DEFS.some((a) => a.tier === g)) r.report('grades', `방탄복 등급 ${g} 이 armor.csv 에 없다`);
  } else if (!ITEM_DEF_MAP.has(target)) {
    r.report('target', `'${target}' 아이템이 없다`);
  }

  return {
    type: r.str('type') as EnemyType,
    kind,
    target,
    chance: r.num('chance', { min: 0, max: 1 }),
    grades,
    weightOf,
    ...(r.has('magFracMin') ? { magFraction: [r.num('magFracMin', { min: 0, max: 1 }), r.num('magFracMax', { min: 0, max: 1 })] as const } : {}),
    ...(r.has('ammoFracMin') ? { ammoFraction: [r.num('ammoFracMin', { min: 0, max: 1 }), r.num('ammoFracMax', { min: 0, max: 1 })] as const } : {}),
  };
});

export const NAMED_DROP_MAP: ReadonlyMap<EnemyType, NamedDrop> = new Map(NAMED_DROPS.map((d) => [d.type, d]));

/** 등급 n 의 번호 방탄복 아이템 id (`armor_n`, 유니크 tier 0 은 제외). 없으면 null. */
export function numberedArmorIdForTier(tier: number): string | null {
  return tier > 0 ? (ARMOR_DEFS.find((a) => a.tier === tier)?.id ?? null) : null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2026-09-13: 인간형 팩션(안드로이드 · 로그 · 레이더)의 시체 — docs/plans/enemy-factions.md 1절 「전리품」
 *   `data/loot_factions.csv`       총 등급 분포 · 방탄복 · 가방 · 회복 (희귀도 굴림)
 *   `data/loot_faction_sites.csv`  스폰 거점 보너스 (연구소 = 씨앗 · 미확인 표본, 전진기지 = 총 등급 분포 교체)
 *
 * 두 표에 줄이 없는 적(벌레 · rogue_boss · 네임드)은 `Loot.rollCorpseWithMax` 의 새 분기에 들어오지 않으므로 rng 벡터가
 * 한 톨도 안 움직인다. 남은 수류탄은 표가 아니라 `CorpseLootOpts.grenades` 그대로 들어간다 (굴림 없음).
 * ──────────────────────────────────────────────────────────────────────────── */

type LootRow = ReturnType<typeof csvRows>[number];

/** 등급 가중치 한 벌 ("등급:가중치" | …). 가중치가 양수인 등급만 `grades` 에 있다. */
export interface GradeWeights {
  grades: readonly WeaponGrade[];
  weightOf: Readonly<Partial<Record<WeaponGrade, number>>>;
}

function parseGradeWeights(r: LootRow, column: string): GradeWeights {
  const weightOf: Partial<Record<WeaponGrade, number>> = {};
  for (const c of r.costList(column)) {
    const g = Number(c.defId);
    if (!(WEAPON_GRADES as readonly number[]).includes(g)) { r.report(column, `'${c.defId}' 는 등급(1..5)이 아니다`); continue; }
    if (c.qty < 0) { r.report(column, `등급 ${g} 의 가중치 ${c.qty} 가 음수다`); continue; }
    if (c.qty > 0) weightOf[g as WeaponGrade] = c.qty;
  }
  const grades = WEAPON_GRADES.filter((g) => (weightOf[g] ?? 0) > 0);
  if (!grades.length) r.report(column, '등급 가중치가 없다');
  return { grades, weightOf };
}

/**
 * 시체의 희귀도 굴림 하나 (방탄복 · 가방 · 회복): `chance` → 희귀도(`weights` — 행성의 희귀도 배수는 굴릴 때
 * `planetRarityWeights` 로 건다) → 그 희귀도인 후보(`byRarity`) 중 **균등**.
 */
export interface CorpseRarityPick {
  chance: number;
  weights: Readonly<Partial<Record<Rarity, number>>>;
  /** 가중치가 있고 후보도 있는 희귀도 (common → legendary 순 — 이 순서가 `rng.weighted` 의 순서다). */
  rarities: readonly Rarity[];
  /** 희귀도 → 후보 아이템 id (csv 순서). 은퇴한 아이템은 빠져 있다. */
  byRarity: ReadonlyMap<Rarity, readonly string[]>;
  /** csv 에 적힌 후보 id 그대로 — `data:check` 의 은퇴 아이템 참조 검사용. 굴림은 `byRarity` 만 본다. */
  poolIds: readonly string[];
}

function parseRarityPick(
  r: LootRow, prefix: 'armor' | 'bag' | 'heal', accepts: (d: ItemDef) => boolean, notLabel: string,
): CorpseRarityPick | undefined {
  const cChance = `${prefix}Chance`, cPool = `${prefix}Pool`, cRarity = `${prefix}Rarity`;
  if (!r.has(cChance)) {
    if (r.has(cPool) || r.has(cRarity)) r.report(cChance, `${cPool} · ${cRarity} 가 있는데 확률이 비었다`);
    return undefined;
  }
  const chance = r.num(cChance, { min: 0, max: 1 });
  const poolIds = r.list(cPool);
  if (!poolIds.length) r.report(cPool, '후보 아이템이 없다');
  const byRarity = new Map<Rarity, string[]>();
  for (const id of poolIds) {
    const d = ITEM_DEF_MAP.get(id);
    if (!d) { r.report(cPool, `'${id}' 아이템이 없다`); continue; }
    if (!accepts(d)) { r.report(cPool, `'${id}' 는 ${notLabel} 아니다`); continue; }
    if (d.retired) continue;   // 안전핀 — 보고는 data:check 의 참조 검사(poolIds)가 한다
    const list = byRarity.get(d.rarity);
    if (list) list.push(id); else byRarity.set(d.rarity, [id]);
  }
  const weights: Partial<Record<Rarity, number>> = {};
  for (const c of r.costList(cRarity)) {
    const rarity = c.defId as Rarity;
    if (!RARITY_ORDER_5.includes(rarity)) { r.report(cRarity, `'${c.defId}' 는 희귀도가 아니다`); continue; }
    if (c.qty < 0) { r.report(cRarity, `'${rarity}' 의 가중치 ${c.qty} 가 음수다`); continue; }
    if (c.qty === 0) continue;
    weights[rarity] = c.qty;
    if (!byRarity.has(rarity)) r.report(cRarity, `'${rarity}' 인 아이템이 ${cPool} 에 없다`);
  }
  const rarities = RARITY_ORDER_5.filter((q) => (weights[q] ?? 0) > 0 && byRarity.has(q));
  if (!rarities.length) r.report(cRarity, '뽑을 수 있는 희귀도가 없다');
  return { chance, weights, rarities, byRarity, poolIds };
}

/** 한 팩션 적 종류의 팩션 굴림 (`data/loot_factions.csv` 한 줄). */
export interface FactionLoot {
  type: EnemyType;
  /** 들고 있던 총의 등급 분포. 없으면 `loot_corpse_rolls.csv` 의 규칙 그대로. */
  weaponGrades?: GradeWeights;
  armor?: CorpseRarityPick;
  bag?: CorpseRarityPick;
  heal?: CorpseRarityPick;
  /** 방탄복 · 가방 내구도 = 최대치 × [min, max] (총처럼 낡았다). 둘 다 없으면 [0, 0]. */
  gearDurability: readonly [number, number];
}

export const FACTION_LOOT: readonly FactionLoot[] = csvRows('loot_factions.csv').map((r) => {
  const type = r.str('type') as EnemyType;
  const corpse = CORPSE_TABLE_MAP.get(type);
  if (!corpse) r.report('type', `'${type}' 의 시체 표가 없다 (loot_corpses.csv 또는 loot_corpse_rolls.csv 에 줄이 있어야 한다)`);
  let weaponGrades: GradeWeights | undefined;
  if (r.has('weaponGrades')) {
    weaponGrades = parseGradeWeights(r, 'weaponGrades');
    if (corpse && !corpse.weapon) r.report('weaponGrades', `'${type}' 는 들고 있던 총 굴림이 없다 (loot_corpse_rolls.csv 의 weaponDurMin/Max)`);
    if (corpse?.weapon?.grades?.length) r.report('weaponGrades', 'loot_corpse_rolls.csv 의 weaponGrades(균등 목록)와 같이 쓰지 않는다');
  }
  const armor = parseRarityPick(r, 'armor', (d) => d.category === 'armor', '방탄복이');
  const bag = parseRarityPick(r, 'bag', (d) => d.category === 'bag', '가방이');
  const heal = parseRarityPick(r, 'heal', (d) => d.category === 'stim', '회복 소모품(stim)이');
  const gearDurability: readonly [number, number] = armor || bag
    ? [r.num('gearDurMin', { min: 0, max: 1 }), r.num('gearDurMax', { min: 0, max: 1 })]
    : [0, 0];
  if (gearDurability[0] > gearDurability[1]) r.report('gearDurMax', `gearDurMin ${gearDurability[0]} 이 gearDurMax ${gearDurability[1]} 보다 크다`);
  return {
    type, gearDurability,
    ...(weaponGrades ? { weaponGrades } : {}), ...(armor ? { armor } : {}), ...(bag ? { bag } : {}), ...(heal ? { heal } : {}),
  };
});

export const FACTION_LOOT_MAP: ReadonlyMap<EnemyType, FactionLoot> = new Map(FACTION_LOOT.map((f) => [f.type, f]));
if (FACTION_LOOT_MAP.size !== FACTION_LOOT.length) {
  const seen = new Set<string>();
  for (const [i, r] of csvRows('loot_factions.csv').entries()) {
    if (seen.has(r.raw('type'))) r.report('type', `'${r.raw('type')}' 줄이 둘이다 (${i + 1}번째 줄은 무시된다)`);
    seen.add(r.raw('type'));
  }
}

/** 거점 보너스 줄이 알아듣는 거점 — `EnemySpawnSite` 전부. */
const SPAWN_SITES: readonly EnemySpawnSite[] = ['lab', 'outpost', 'wreck', 'platform', 'ruin', 'drop'];

/** 거점 보너스의 아이템 한 줄. */
export interface FactionSiteItem {
  /** item = `defId` 하나 · seed = 그 레이드 행성의 야생 씨앗 표(`planetSeedPool`)에서 하나. */
  kind: 'item' | 'seed';
  /** item 의 아이템 id (seed 면 ''). */
  defId: string;
  qty: readonly [number, number];
  chance: number;
}

/** 한 적 종류 × 스폰 거점의 보너스 (`data/loot_faction_sites.csv` 의 같은 type · site 줄 전부). */
export interface FactionSiteBonus {
  type: EnemyType;
  site: EnemySpawnSite;
  /** 있으면 그 거점에서 스폰한 적의 총 등급 분포를 **통째로** 바꾼다. */
  weaponGrades?: GradeWeights;
  /** csv 순서 = 굴림 순서. */
  items: readonly FactionSiteItem[];
}

const siteKey = (type: string, site: string): string => `${type}@${site}`;

const FACTION_SITE_MAP: ReadonlyMap<string, FactionSiteBonus> = (() => {
  const map = new Map<string, { type: EnemyType; site: EnemySpawnSite; weaponGrades?: GradeWeights; items: FactionSiteItem[] }>();
  for (const r of csvRows('loot_faction_sites.csv')) {
    const type = r.str('type') as EnemyType;
    const site = r.enum('site', SPAWN_SITES);
    const kind = r.enum('kind', ['grades', 'item', 'seed'] as const);
    const corpse = CORPSE_TABLE_MAP.get(type);
    if (!corpse) r.report('type', `'${type}' 의 시체 표가 없다`);
    const key = siteKey(type, site);
    let bonus = map.get(key);
    if (!bonus) { bonus = { type, site, items: [] }; map.set(key, bonus); }
    if (kind === 'grades') {
      if (bonus.weaponGrades) r.report('kind', `'${type}' @ ${site} 에 grades 줄이 둘이다`);
      bonus.weaponGrades = parseGradeWeights(r, 'grades');
      if (corpse && !corpse.weapon) r.report('grades', `'${type}' 는 들고 있던 총 굴림이 없다 (loot_corpse_rolls.csv 의 weaponDurMin/Max)`);
      continue;
    }
    let defId = '';
    if (kind === 'item') {
      defId = r.str('target');
      if (defId && !ITEM_DEF_MAP.has(defId)) r.report('target', `'${defId}' 아이템이 없다`);
    } else if (r.has('target')) {
      r.report('target', 'seed 줄은 target 을 비운다 (그 행성의 씨앗 표에서 고른다)');
    }
    const qty: readonly [number, number] = [r.int('qtyMin', { min: 1 }), r.int('qtyMax', { min: 1 })];
    if (qty[0] > qty[1]) r.report('qtyMax', `qtyMin ${qty[0]} 이 qtyMax ${qty[1]} 보다 크다`);
    bonus.items.push({ kind, defId, qty, chance: r.num('chance', { min: 0, max: 1 }) });
  }
  return map;
})();

export const FACTION_SITE_BONUSES: readonly FactionSiteBonus[] = [...FACTION_SITE_MAP.values()];

/** 그 적 종류가 그 거점에서 스폰했을 때의 보너스. 거점이 없거나 줄이 없으면 undefined. */
export function getFactionSiteBonus(type: EnemyType, site: EnemySpawnSite | null | undefined): FactionSiteBonus | undefined {
  return site ? FACTION_SITE_MAP.get(siteKey(type, site)) : undefined;
}

/** 가중치가 붙은 아이템 id. */
export interface WeightedItemId {
  defId: string;
  weight: number;
}

/*
 * 행성 id → 그 행성의 **야생 씨앗 군락 표** (`data/planets.csv` 의 `seeds` 열, 가중치 그대로). 모르는 id · 씨앗이 아닌 것 ·
 * 은퇴한 것은 뺀다. 칸의 문법 검사는 그 열의 주인(world)이 하므로 여기서는 조용히 읽는다 — 같은 오류를 두 번 보고하지 않게.
 */
const PLANET_SEED_POOLS: ReadonlyMap<string, readonly WeightedItemId[]> = new Map(csvRows('planets.csv').map((row) => {
  const pool: WeightedItemId[] = [];
  for (const part of row.list('seeds')) {
    const at = part.lastIndexOf(':');
    const defId = (at > 0 ? part.slice(0, at) : part).trim();
    const weight = at > 0 ? Number(part.slice(at + 1)) : 1;
    const d = ITEM_DEF_MAP.get(defId);
    if (d?.seed && !d.retired && Number.isFinite(weight) && weight > 0) pool.push({ defId, weight });
  }
  return [row.raw('id'), pool] as const;
}));

/** 다섯 행성의 씨앗 표를 합친 것 (같은 씨앗은 가중치를 더한다, 처음 나온 순서). */
const ALL_PLANET_SEED_POOL: readonly WeightedItemId[] = (() => {
  const sum = new Map<string, number>();
  for (const pool of PLANET_SEED_POOLS.values()) for (const s of pool) sum.set(s.defId, (sum.get(s.defId) ?? 0) + s.weight);
  return [...sum].map(([defId, weight]) => ({ defId, weight }));
})();

/** 거점 보너스의 `seed` 줄이 고르는 씨앗 표 — 그 행성의 것, 행성이 없거나 표가 비었으면 다섯 행성을 합친 것. */
export function planetSeedPool(planet: PlanetId | null | undefined): readonly WeightedItemId[] {
  const own = planet == null ? undefined : PLANET_SEED_POOLS.get(planet);
  return own && own.length > 0 ? own : ALL_PLANET_SEED_POOL;
}
