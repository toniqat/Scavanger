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
}

export const PLANET_GRADE_CURVES: readonly PlanetGradeCurve[] = csvRows('planet_loot.csv').map((r) => {
  const weightOf: Partial<Record<WeaponGrade, number>> = {};
  for (const g of WEAPON_GRADES) {
    const w = r.num(`g${g}`, { min: 0 });
    if (w > 0) weightOf[g] = w;
  }
  const grades = WEAPON_GRADES.filter((g) => (weightOf[g] ?? 0) > 0);
  if (grades.length === 0) r.report('g1', '등급 가중치가 전부 0 이다 — 이 행성에서는 무기가 아예 안 나온다');
  return {
    rank: r.int('rank', { min: 1 }),
    name: r.str('name'),
    grades,
    weightOf,
    maxGrade: (grades[grades.length - 1] ?? 1) as WeaponGrade,
    uniqueMul: r.num('uniqueMul', { min: 0 }),
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
