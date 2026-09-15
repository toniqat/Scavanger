import type { AmmoType, ArmorDef, AttachmentDef, AttachmentEffects, BagDef, BoostKind, ItemCategory, ItemDef, MealDef, MediumDef, PouchDef, PrepDef, Rarity, SampleDef, SeedDef, SkillId, SoilDef, SoilTag, StrainDef, WeaponClass, WeaponDef, WeaponGrade } from '@/shared';
/* appended (2026-09-13, 요리 재료 티어): 표본 계열 · 소켓 · 요리 능력치 줄 */
import type { GrowSocketDef, MealBuff, MealEffect } from '@/shared';
/* appended (2026-09-15, 가젯 개편): 수류탄 종류 */
import type { GrenadeKind } from '@/shared';
import {
  AMMO_STACK_ROUNDS, CATEGORY_COLOR, CATEGORY_ICON, CATEGORY_LABEL_KO, ENV_KINDS, MEAL_BUFFS,
  QUICK_SLOTS, QUICK_USABLE_CATEGORIES, RARITY_COLORS, RARITY_ORDER, SKILL_IDS, SOIL_TAGS, csvRows, keyTable, numberMap, rarityForGrade } from '@/shared';
import { GROW_SOCKET_EFFECTS, GROW_SOCKET_TARGETS, SAMPLE_FAMILIES } from '@/shared';
/* appended (2026-09-13, 서재 시리즈 · 비디오게임 — docs/DECISIONS.md 「2026-09-13 — 서재 시리즈 · 비디오게임」) */
import type { BookDef, GameStat, GymGameTuning, GymMinigame, LibraryMedium, PlanetId } from '@/shared';
import { GAME_STATS, GYM_MINIGAME_LABEL_KO, LIBRARY_SERIES_DEFS, PLANET_IDS, resolveItemAlias, stringMap } from '@/shared';

/*
 * 아이템 수치의 원본은 `data/` 의 csv 다 — `items.csv`(수류탄 · 회복 · 귀중품 · 재료 · 약초 · 가젯),
 * `ammo.csv` · `attachments.csv` · `bags.csv` · `seeds.csv` · `samples.csv` · `sockets.csv` · `meals.csv`,
 * 서재 매체는 `library_series.csv`(2026-09-13 — 옛 books · discs · records.csv 대신), 비디오게임은 `game_consoles.csv` · `game_discs.csv`,
 * 무기는 `weapons.csv` / `weapons_unique.csv`, 방탄복은 `armor.csv`.
 * 이 파일에는 표가 없고 그 줄들을 `ItemDef` 로 옮기는 코드만 있다.
 *
 * `T` 는 `data/tuning.csv` (기능 폴더 안에서만 쓰는 스칼라) 조회기다.
 */
const T = /* data/tuning.csv */ keyTable('tuning.csv');
import type { WeaponItemMeta } from './WeaponDefs';
import { UNIQUE_WEAPON_ITEM_META, WEAPON_CLASSES, WEAPON_DEFS, WEAPON_FAMILY_ITEM_META, gradeOf, isUniqueWeapon, weaponFamilyOf } from './WeaponDefs';
import { ARMOR_DEFS, ARMOR_ICON, armorItemSize } from './ArmorDefs';
import { IMPLANT_ITEM_DEFS } from './ImplantDefs';

/* ── palette / labels ─────────────────────────────────────────────────────── */
/* Phase 7 (2026-09-06): the rarity / category labels, colours, icons and order live in `src/shared/labels.ts` now so
 * meta/ and ui/ can use them without importing items/. Re-exported here so every existing `@/items` import keeps working. */
export {
  RARITY_COLORS, RARITY_ORDER, rarityRank, rarityForGrade, gradeForRarity,
  RARITY_LABEL_KO, CATEGORY_LABEL_KO, CATEGORY_COLOR, CATEGORY_ICON,
} from '@/shared';

/**
 * 모든 `ItemCategory` (계약에 적힌 순서). 손으로 적은 목록이 아니라 `CATEGORY_LABEL_KO` 의 키다 —
 * 그 표는 `Record<ItemCategory, string>` 이라 카테고리가 늘면 컴파일러가 표를 먼저 막고, 이 배열은 저절로 따라온다.
 * 쓰는 곳은 csv 의 카테고리 목록 칸 검증(`pouchAccepts` 의 `enumList`)이다.
 */
export const ITEM_CATEGORIES = Object.keys(CATEGORY_LABEL_KO) as readonly ItemCategory[];

export const AMMO_LABEL_KO: Readonly<Record<AmmoType, string>> = {
  light: '경량탄', medium: '준중량탄', heavy: '중량탄', shell: '산탄',
  /* legacy calibres (no def uses them) */
  rifle: '소총탄', pistol: '권총탄', shotgun: '산탄', energy: '에너지 셀',
  /* unique-weapon calibres (2026-09-06) */
  fuel: '연료통', cell: '전지', shuriken: '표창', arrow: '화살', rocket: '로켓', belt: '탄띠',
};

/** v2 calibres in display order: the four graded-weapon calibres, then the six unique-weapon calibres. */
export const AMMO_TYPES_V2: readonly AmmoType[] = ['light', 'medium', 'heavy', 'shell', 'fuel', 'cell', 'shuriken', 'arrow', 'rocket', 'belt'];
/** Calibres only a unique weapon fires (never rolled with the graded-weapon ammo). */
export const UNIQUE_AMMO_TYPES: readonly AmmoType[] = ['fuel', 'cell', 'shuriken', 'arrow', 'rocket', 'belt'];

/** Ammo item id for a calibre (`medium` → `ammo_medium`). */
export function ammoItemIdFor(ammoType: AmmoType): string {
  return `ammo_${ammoType}`;
}

/* ── weight ───────────────────────────────────────────────────────────────── */
/** kg for an ItemDef that does not declare `weight` (matches the shared contract comment). */
export const DEFAULT_ITEM_WEIGHT = T.num('DEFAULT_ITEM_WEIGHT');

/**
 * 가방 한 칸이 늘려 주는 소지 한계 (kg). 2026-09-12: `inventory/InventorySystem.getWeight` 안에 `* 0.5` 로
 * 박혀 있던 값 — 가방 툴팁의 「소지 한계 +N kg」 줄과 실제 한계가 **같은 수치를 읽어야** 하므로 표로 뺐다.
 * 식은 `inventory/Gear.bagCapacityBonus` 하나가 갖는다.
 */
export const BAG_CAPACITY_PER_CELL = T.num('BAG_CAPACITY_PER_CELL');

/** Weight in kg of `qty` units of `def`. */
export function itemWeight(def: ItemDef, qty = 1): number {
  return (def.weight ?? DEFAULT_ITEM_WEIGHT) * Math.max(0, qty);
}

/* ── builder ──────────────────────────────────────────────────────────────── */
type DefInput = Omit<ItemDef, 'color' | 'stackMax'> & { stackMax?: number };
const def = (d: DefInput): ItemDef => ({ ...d, stackMax: d.stackMax ?? 1, color: RARITY_COLORS[d.rarity] });

/* ── weapons (one ItemDef per WeaponDef grade) ─────────────────────────────── */
/* 무기의 격자 크기 · 아이콘 · 가격 · 무게 · 설명은 무기 수치와 같은 줄에 있다 —
 * `data/weapons.csv` / `data/weapons_unique.csv`. items/ 는 그 표를 ItemDef 로 옮기기만 한다. */
const FALLBACK_META: WeaponItemMeta = { width: 3, height: 2, icon: '⌐', value: 300, weight: 3.5, description: '무기.' };

/** Value multiplier per grade above I. */
export const WEAPON_GRADE_VALUE_STEP = T.num('WEAPON_GRADE_VALUE_STEP');


function weaponItemDef(w: WeaponDef): ItemDef {
  if (isUniqueWeapon(w)) {
    const meta = UNIQUE_WEAPON_ITEM_META.get(w.id) ?? FALLBACK_META;
    return def({
      id: itemIdForWeapon(w.id), name: w.name, category: w.slot, rarity: 'legendary',
      width: meta.width, height: meta.height, value: meta.value,
      icon: meta.icon, weaponId: w.id, description: meta.description, weight: meta.weight,
    });
  }
  const meta = WEAPON_FAMILY_ITEM_META.get(weaponFamilyOf(w)) ?? FALLBACK_META;
  const grade = gradeOf(w);
  return def({
    id: itemIdForWeapon(w.id), name: w.name, category: w.slot, rarity: rarityForGrade(grade),
    width: meta.width, height: meta.height, value: Math.round(meta.value * (1 + WEAPON_GRADE_VALUE_STEP * (grade - 1))),
    icon: meta.icon, weaponId: w.id, description: meta.description, weight: meta.weight,
  });
}

export const WEAPON_ITEM_DEFS: readonly ItemDef[] = WEAPON_DEFS.map(weaponItemDef);

/* ── ammo v2 (qty = rounds) ───────────────────────────────────────────────── */
/** `data/ammo.csv` 의 줄 (탄종 하나 = 한 줄). */
const AMMO_ROWS = csvRows('ammo.csv');

/** kg per round (tactical kit weight budget). */
export const AMMO_ROUND_WEIGHT: Readonly<Partial<Record<AmmoType, number>>> =
  Object.fromEntries(AMMO_ROWS.map((r) => [r.str('type'), r.num('roundWeight', { min: 0 })]));

export const AMMO_ITEM_DEFS: readonly ItemDef[] = AMMO_ROWS.map((r) => {
  const type = r.str('type') as AmmoType;
  return def({
    id: ammoItemIdFor(type), name: r.str('name'), category: 'ammo', rarity: r.str('rarity') as Rarity,
    width: 1, height: 1, stackMax: AMMO_STACK_ROUNDS[type], value: r.int('value', { min: 0 }),
    icon: r.str('icon'), ammoType: type, description: r.str('description'),
    weight: r.num('roundWeight', { min: 0 }),
  });
});

/* ── attachments — data/attachments.csv ───────────────────────────────────── */
/* 2026-09-15: 무게는 `attachments.csv` 의 `weight` 열이다 — 예전에는 여기 `ATTACHMENT_WEIGHT = 0.3` 상수가 정하고 있어
 * 그 열이 헤더에만 있고 아무도 안 읽었다 (「수치는 코드에 적지 않는다」 규약 위반). */

export const ATTACHMENT_ITEM_DEFS: readonly ItemDef[] = csvRows('attachments.csv').map((r) => {
  const effects: AttachmentEffects = {};
  const mul = (key: 'recoilV' | 'recoilH' | 'spread' | 'hipSpread' | 'adsTime' | 'magSize' | 'adsZoom' | 'sway' | 'falloffRange' | 'falloffLoss' | 'bulletDrop'): void => {
    const v = r.optNum(key, { min: 0 });
    if (v !== undefined) effects[key] = v;
  };
  mul('recoilV'); mul('recoilH'); mul('spread'); mul('hipSpread'); mul('adsTime'); mul('magSize'); mul('adsZoom');
  // 2026-09-14 (총기 밸런스): 조준 흔들림 · 거리 감소 거리 / 손실 · 탄 낙차 배수
  mul('sway'); mul('falloffRange'); mul('falloffLoss'); mul('bulletDrop');
  if (r.has('scope')) effects.scope = r.bool('scope');
  if (r.has('laser')) effects.laser = r.bool('laser');
  const classes: WeaponClass[] = r.enumList('classes', WEAPON_CLASSES);
  const ammoTypes = r.list('ammoTypes') as AmmoType[];
  const attachment: AttachmentDef = {
    socket: r.enum('socket', ['muzzle', 'grip', 'mag', 'stock', 'sight'] as const),
    effects,
    ...(classes.length ? { classes } : {}),
    ...(ammoTypes.length ? { ammoTypes } : {}),
  };
  return def({
    id: r.str('id'), name: r.str('name'), category: 'attachment', rarity: r.str('rarity') as Rarity,
    width: 1, height: 1, value: r.int('value', { min: 0 }), icon: r.str('icon'),
    description: r.str('description'), attachment, weight: r.num('weight', { min: 0 }),
  });
});

/* ── bags — data/bags.csv ─────────────────────────────────────────────────── */
/* 2026-09-11 (C-5): `quickSlots` is capped at `QUICK_SLOTS` (the wheel has 8 directions) — a 9 used to load fine and
 * be clamped silently by `InventorySystem.getQuickSlotCount`, so the tooltip promised a slot that did not exist.
 * 2026-09-11 (C-36): `durabilityMax` — bags wear by `BAG_DURABILITY_PER_RAID` per raid (inventory/) and are repaired
 * like armor (`Salvage.REPAIRABLE`). At 0 a bag still works; only the repair gets expensive. */
export const BAG_ITEM_DEFS: readonly ItemDef[] = csvRows('bags.csv').map((r) => {
  const bag: BagDef = {
    cols: r.int('cols', { min: 1 }), rows: r.int('rows', { min: 1 }), quickSlots: r.int('quickSlots', { min: 0, max: QUICK_SLOTS }),
    ...(r.has('tactical') && r.bool('tactical') ? { tactical: true } : {}),
  };
  return def({
    id: r.str('id'), name: r.str('name'), category: 'bag', rarity: r.str('rarity') as Rarity,
    width: 2, height: 2, value: r.int('value', { min: 0 }), icon: bag.tactical ? '⛶' : '▣',
    description: r.str('description'), bag,
    durabilityMax: r.int('durabilityMax', { min: 1 }),
    weight: T.num('BAG_WEIGHT_BASE') + bag.cols * bag.rows * T.num('BAG_WEIGHT_PER_CELL'),
  });
});

/* ── 씨앗 (Phase 8) — data/seeds.csv ──────────────────────────────────────────
 * Planted in a 온실 재배 스테이션; `SeedDef.growHours` is **real** wall-clock time and keeps running while
 * the game is closed (housing/ owns the plots). Loot (tier 1–3 containers, 벌레 시체) + 기업 상점 only — never craftable.
 *
 * 2026-09-11 (온실 개편): 한 줄마다 **`soilTag`** 가 붙었다 — 그 칸에 부어 둔 토양의 태그와 같으면
 * `SOIL_MATCH_SPEEDUP` 만큼 빨리, 다르면 `SOIL_MISMATCH_PENALTY` 만큼 늦게 자란다 (판정은 `housing/`).
 * 필수 열이라 `r.enum` 의 fallback 을 주지 않는다 — 빠뜨린 줄은 `npm run data:check` 가 잡는다. */
/** Seeds share the category glyph and a leaf-green tint so a 씨앗 reads as one at a glance in the grid. */
const SEED_ICON = CATEGORY_ICON.seed;
const SEED_COLOR = CATEGORY_COLOR.seed;

export const SEED_ITEM_DEFS: readonly ItemDef[] = csvRows('seeds.csv').map((r) => {
  const seed: SeedDef = {
    growHours: r.num('growHours', { min: 0 }),
    yieldDefId: r.str('yieldDefId'),
    yieldQty: r.int('yieldQty', { min: 1 }),
    soilTag: r.enum('soilTag', SOIL_TAGS),
  };
  return {
    ...def({
      id: r.str('id'), name: r.str('name'), category: 'seed', rarity: r.str('rarity') as Rarity,
      width: 1, height: 1, stackMax: T.num('SEED_STACK_MAX'),
      value: r.int('value', { min: 0 }), icon: SEED_ICON, description: r.str('description'),
      /* 2026-09-15: 무게는 `seeds.csv` 의 새 `weight` 열이다 (옛 `tuning.csv` 의 `SEED_WEIGHT` 는 은퇴). */
      seed, weight: r.num('weight', { min: 0 }),
    }),
    color: SEED_COLOR,
  };
});

/* ── 미확인 표본 (A-12, 2026-09-11 · 요리 재료 티어 2026-09-13) — data/samples.csv ──────────
 * 연구실 **분석기**가 해석하는 재료. `SampleDef.analyzeHours` 는 분석 레벨 1 에서의 **실제 시간**이고
 * (씨앗의 `growHours` 와 같은 wall-clock 규약), 레벨 배수로 깎는 계산은 `housing/Rules` 가 한다.
 * 제작도 상점도 없다 — 벌레 시체 · 표본 채집지 · 티어 3+ 컨테이너 · 고철 더미 부가 광물뿐이다 (로그는 표본에 관심이 없다).
 *
 * 2026-09-13 (사용자 결정: 표본 3종 통합): `family`(cell | mineral | dna)가 필수다 — 분석기는 표본이 아니라 **계열**의
 * 결과표(`shared/housing` 의 `ANALYSIS_RESULTS`)를 굴린다. `rewardDefId` · `rewardQty` 는 그 표가 비었을 때의 대체 산출물이다.
 * 옛 11종은 `retired` 로 정의만 남는다 (분석기에 넣으면 자기 계열로 해석된다). **첫 해석 보너스(`first*`)는 없어졌다** —
 * 로더가 더 붙이지 않고, 칸이 채워져 있으면 조용히 무시하지 않고 신고한다. */
/** 표본은 카테고리 글리프 · 색을 공유한다 — 격자에서 「아직 해석 안 한 것」이 한눈에 읽힌다. */
const SAMPLE_ICON = CATEGORY_ICON.sample;
const SAMPLE_COLOR = CATEGORY_COLOR.sample;

export const SAMPLE_ITEM_DEFS: readonly ItemDef[] = csvRows('samples.csv').map((r) => {
  if (r.has('firstDefId') || r.has('firstQty')) r.report('firstDefId', '첫 해석 보너스(first*)는 2026-09-13 부터 없다 — 칸을 비운다');
  const sample: SampleDef = {
    analyzeHours: r.num('analyzeHours', { min: 0 }),
    rewardDefId: r.str('rewardDefId'),
    rewardQty: r.int('rewardQty', { min: 1 }),
    family: r.enum('family', SAMPLE_FAMILIES),
  };
  const retired = r.has('retired') && r.bool('retired');
  return {
    ...def({
      id: r.str('id'), name: r.str('name'), category: 'sample', rarity: r.enum('rarity', RARITY_ORDER),
      width: 1, height: 1, stackMax: T.num('SAMPLE_STACK_MAX'),
      value: r.int('value', { min: 0 }), icon: SAMPLE_ICON, description: r.str('description'),
      sample, weight: T.num('SAMPLE_WEIGHT'),
      ...(retired ? { retired: true } : {}),
    }),
    color: SAMPLE_COLOR,
  };
});

/* ── 소켓 (요리 재료 티어, 2026-09-13) — data/sockets.csv ─────────────────────────
 * 재배 칸에 부어 둔 흙(`target: 'soil'`) · 배양 칸에 부어 둔 배지(`'medium'`)에 끼우는 **영구 강화**. 분석기가 미확인 DNA 를
 * 해석해서만 나온다 (`data/analysis_results.csv`) — 제작 · 상점 · 루팅 어디에도 줄이 없다. 끼우기 · 효과 계산은 `housing/`
 * (`parts/Sockets`) 몫이고 items 는 표만 옮긴다.
 *
 * 1×1 · 스택 `SOCKET_STACK_MAX` · 무게 `SOCKET_WEIGHT` (tuning). 아이콘은 카테고리 글리프지만 **색은 등급색**이다 —
 * 같은 인자의 I · II · III 가 격자에서 색으로 갈려야 한다 (요리와 같은 이유). `amount` 는 speed · wear 면 비율, yield 면
 * +1 개 확률이라 셋 다 0 … 1 이다. */
const SOCKET_ICON = CATEGORY_ICON.socket;

export const SOCKET_ITEM_DEFS: readonly ItemDef[] = csvRows('sockets.csv').map((r) => {
  const growSocket: GrowSocketDef = {
    target: r.enum('target', GROW_SOCKET_TARGETS),
    effect: r.enum('effect', GROW_SOCKET_EFFECTS),
    amount: r.num('amount', { min: 0, max: 1 }),
  };
  if (growSocket.amount <= 0) r.report('amount', '수치가 0 인 소켓은 아무 효과가 없다');
  return def({
    id: r.str('id'), name: r.str('name'), category: 'socket', rarity: r.enum('rarity', RARITY_ORDER),
    width: 1, height: 1, stackMax: T.num('SOCKET_STACK_MAX'),
    value: r.int('value', { min: 0 }), icon: SOCKET_ICON, description: r.str('description'),
    growSocket, weight: T.num('SOCKET_WEIGHT'),
  });
});

/* ── 요리 — 2026-09-16 (접시 모델, 사용자 결정): **아이템이 아니다.** ─────────────────────────
 * 조리대에서 만든 요리는 식탁의 접시가 된다 (`ShipState.plate`). `data/meals.csv` 를 읽는 곳은 `shared/meals.ts`
 * (`MEAL_DEFS` · `getMealDef`) 하나이고, `ITEM_DEFS` 에는 요리가 없다 — `ctx.loot.getItemDef('meal_*')` 는 undefined 다.
 * 옛 세이브의 요리 아이템은 모르는 def 로 떨어진다 (게임 개발 중 — 이전 · 환불 없음, 사용자 결정). */

/* ── 서재 매체: 책 · 비디오 · 레코드 (2026-09-13 서재 시리즈 — docs/DECISIONS.md 「2026-09-13 — 서재 시리즈 · 비디오게임」) ─────────────
 * 아이템은 **시리즈**(`data/library_series.csv`, 효과 · 행성 로더는 `shared/library` 의 `LIBRARY_SERIES_DEFS`)에서 만든다 —
 * 시리즈 한 줄 = 권 수만큼의 아이템. 옛 숙련별 한 권(`book_<skill>` · `disc_<skill>` · `record_<skill>`)은 없어졌고
 * 세이브 · 와이어의 그 id 는 `data/item_aliases.csv` 가 새 시리즈 1권으로 옮긴다 (`resolveItemAlias`).
 *
 *  - id   = `book_<시리즈>_<권>` · `disc_<시리즈>_<권>` · `record_<시리즈>` (housing 세이브의 id 모양 `^(book|disc|record|game)_…`).
 *  - 이름 = 시리즈 이름 + 권 번호 로마 숫자 (단편은 번호 없음).
 *  - `ItemDef.book` / `disc` / `record` = `{ skill, series, volume }` — `skill` 은 **대표 숙련**(정렬 · 도감 묶음)일 뿐이고
 *    효과는 시리즈의 효과 줄만 정한다. csv 의 `skill` 칸이 비면 첫 skillGain 줄의 숙련이다.
 *  - 등급: 책은 등급이 없어 전부 `tables.csv` 의 `LIBRARY_ITEM_RARITY.book`, 비디오 · 레코드는 시리즈의 `rarity` 칸.
 *  - 가치: 책 `BOOK_VALUE_BY_VOLUME[권]` · 비디오 `DISC_VALUE_BY_RARITY × (1 + DISC_VALUE_VOLUME_STEP × (권 − 1))` · 레코드 `RECORD_VALUE_BY_RARITY`.
 *  - 칸 · 무게는 옛 매체 그대로 (책 1×2 · 비디오 2×2 · 레코드 3×3, `BOOK_WEIGHT` · `DISC_WEIGHT` · `RECORD_WEIGHT`), 스택 없음.
 * 드롭은 그 시리즈의 행성에서만 권 가중치로 (`LootTables.isLootableOnPlanet` · `libraryVolumeWeight`). 제작 · 상점 · 퀵슬롯 없음.
 * 시리즈 ↔ 아이템 1:1 · 숙련마다 책 시리즈 · 레시피 대상 · 행성 threat 같은 표끼리 검사는 `scripts/data-check.mjs` 가 한다. */
type LibraryItemRow = ReturnType<typeof csvRows>[number];
const LIBRARY_ITEM_ROWS: ReadonlyMap<string, LibraryItemRow> = new Map(csvRows('library_series.csv').map((r) => [r.raw('id'), r] as const));
const BOOK_VALUE_BY_VOLUME = numberMap<string>('tables.csv', 'BOOK_VALUE_BY_VOLUME');
const DISC_VALUE_BY_RARITY = numberMap<Rarity>('tables.csv', 'DISC_VALUE_BY_RARITY');
const RECORD_VALUE_BY_RARITY = numberMap<Rarity>('tables.csv', 'RECORD_VALUE_BY_RARITY');
const DISC_VALUE_VOLUME_STEP = T.num('DISC_VALUE_VOLUME_STEP');
const LIBRARY_ITEM_RARITY = stringMap<'book'>('tables.csv', 'LIBRARY_ITEM_RARITY');

/** 책의 등급 — 책은 등급이 없어 전부 이 값이다 (`tables.csv` 의 `LIBRARY_ITEM_RARITY.book`, 틀리면 data:check 가 잡고 여기서는 uncommon). */
export const LIBRARY_BOOK_RARITY: Rarity = (RARITY_ORDER as readonly string[]).includes(LIBRARY_ITEM_RARITY.book)
  ? LIBRARY_ITEM_RARITY.book as Rarity : 'uncommon';

interface LibraryMediumSpec {
  width: number;
  height: number;
  weight: number;
  value: (rarity: Rarity, volume: number) => number;
}

const LIBRARY_MEDIUM_SPEC: Readonly<Record<LibraryMedium, LibraryMediumSpec>> = {
  book: { width: 1, height: 2, weight: T.num('BOOK_WEIGHT'), value: (_rarity, volume) => BOOK_VALUE_BY_VOLUME[String(volume)] ?? 0 },
  disc: {
    width: 2, height: 2, weight: T.num('DISC_WEIGHT'),
    value: (rarity, volume) => Math.round((DISC_VALUE_BY_RARITY[rarity] ?? 0) * (1 + DISC_VALUE_VOLUME_STEP * (volume - 1))),
  },
  record: { width: 3, height: 3, weight: T.num('RECORD_WEIGHT'), value: (rarity) => RECORD_VALUE_BY_RARITY[rarity] ?? 0 },
};

const VOLUME_ROMAN: readonly string[] = ['', 'I', 'II', 'III', 'IV', 'V'];

/** 시리즈 한 권의 아이템 id (`book_carry_manual_2` · `disc_rifle_range_1` · `record_porters_song`). */
export function libraryItemIdFor(medium: LibraryMedium, seriesId: string, volume: number): string {
  return medium === 'record' ? `record_${seriesId}` : `${medium}_${seriesId}_${volume}`;
}

/** 시리즈 한 권의 아이템 이름 — 시리즈 이름 + 로마 숫자 (단편은 이름만). */
export function libraryItemName(seriesName: string, volumes: number, volume: number): string {
  return volumes > 1 ? `${seriesName} ${VOLUME_ROMAN[volume] ?? String(volume)}` : seriesName;
}

function libraryItemDefs(medium: LibraryMedium): ItemDef[] {
  const spec = LIBRARY_MEDIUM_SPEC[medium];
  const out: ItemDef[] = [];
  for (const s of LIBRARY_SERIES_DEFS) {
    if (s.medium !== medium) continue;
    const row = LIBRARY_ITEM_ROWS.get(s.id);
    let rarity: Rarity = LIBRARY_BOOK_RARITY;
    if (medium === 'book') {
      if (row?.has('rarity')) row.report('rarity', '책은 등급이 없다 — 칸을 비운다 (tables.csv 의 LIBRARY_ITEM_RARITY.book)');
    } else if (row) {
      rarity = row.enum('rarity', RARITY_ORDER);
    }
    const firstSkill = s.effects.find((e) => e.kind === 'skillGain')?.target as SkillId | undefined;
    const skill = row?.optEnum('skill', SKILL_IDS) ?? firstSkill;
    if (!skill) row?.report('skill', 'skillGain 효과가 없는 시리즈는 대표 숙련(skill)을 적는다');
    for (let volume = 1; volume <= s.volumes; volume++) {
      const shelf: BookDef = { skill: skill ?? SKILL_IDS[0], series: s.id, volume };
      out.push({
        ...def({
          id: libraryItemIdFor(medium, s.id, volume), name: libraryItemName(s.name, s.volumes, volume), category: medium, rarity,
          width: spec.width, height: spec.height, stackMax: 1, value: spec.value(rarity, volume),
          icon: CATEGORY_ICON[medium], description: s.description, weight: spec.weight,
          ...(medium === 'book' ? { book: shelf } : medium === 'disc' ? { disc: shelf } : { record: shelf }),
        }),
        color: CATEGORY_COLOR[medium],
      });
    }
  }
  return out;
}

/** 책 전부 — 시리즈 순서 × 권 순서. */
export const BOOK_ITEM_DEFS: readonly ItemDef[] = libraryItemDefs('book');
/** 비디오(디스크) 전부 — 시리즈 순서 × 권 순서. */
export const DISC_ITEM_DEFS: readonly ItemDef[] = libraryItemDefs('disc');
/** 레코드 전부 (시리즈 = 한 장). */
export const RECORD_ITEM_DEFS: readonly ItemDef[] = libraryItemDefs('record');
/** 서재 효과 매체 아이템 전부 (책 · 비디오 · 레코드). */
export const LIBRARY_ITEM_DEFS: readonly ItemDef[] = [...BOOK_ITEM_DEFS, ...DISC_ITEM_DEFS, ...RECORD_ITEM_DEFS];

/** 서재 매체 아이템의 `{ skill, series, volume }` (책 · 비디오 · 레코드가 아니면 undefined). */
export function libraryShelfOf(d: ItemDef | undefined): BookDef | undefined {
  return d ? (d.book ?? d.disc ?? d.record) : undefined;
}

/** 시리즈 id → 권 순서의 아이템 (인덱스 = 권 − 1). */
export const LIBRARY_ITEMS_BY_SERIES: ReadonlyMap<string, readonly ItemDef[]> = (() => {
  const out = new Map<string, ItemDef[]>();
  for (const d of LIBRARY_ITEM_DEFS) {
    const shelf = libraryShelfOf(d);
    if (!shelf?.series) continue;
    const list = out.get(shelf.series);
    if (list) list.push(d); else out.set(shelf.series, [d]);
  }
  return out;
})();

/** 시리즈의 `volume` 권 아이템 (없으면 undefined). */
export function libraryItemDefOf(seriesId: string, volume: number): ItemDef | undefined {
  return LIBRARY_ITEMS_BY_SERIES.get(seriesId)?.find((d) => libraryShelfOf(d)?.volume === volume);
}

/* ── 비디오게임: 게임기 · 게임 디스크 (2026-09-13) — data/game_consoles.csv · data/game_discs.csv ───────────────────
 * 게임기(`category: 'console'`, `ItemDef.gameConsole {console}`)는 서재 TV 에 장착하고, 게임 디스크(`category: 'game_disc'`,
 * `ItemDef.gameDisc {console, stat, minigame, tuning, color}`)는 게임 디스크 전시대에 꽂아 두면 그 TV 로 플레이한다 (housing/).
 * 게임기는 3D 프린터 제작(recipes.csv) + 드문 드롭, 게임 디스크는 드롭 전용. 둘 다 threat 2 이상 행성에서만 나온다 —
 * 행성 목록은 `ItemDef` 에 칸이 없어 `GAME_ITEM_PLANETS` 로 내주고(드롭 필터 `LootTables.lootPlanetsOf`), threat 검사는 data:check 가 한다.
 * 색은 카테고리 색이다 (서재 매체와 같다 — 등급 테두리가 등급을 가른다). `gameDisc.color` 는 게임 화면 테마 색. */
/** 박자형 미니게임의 패턴 토큰 (`GymGameTuning.pattern`) — press 는 패턴이 없다. */
export const GAME_PATTERN_TOKENS: Readonly<Record<GymMinigame, readonly string[]>> = { press: [], breath: ['t', 'h', 'r'], cycle: ['L', 'R', 'r'] };
const GAME_MINIGAMES = Object.keys(GYM_MINIGAME_LABEL_KO) as GymMinigame[];
const GAME_PLANETS = new Map<string, readonly PlanetId[]>();

function gamePlanetsCell(r: LibraryItemRow, id: string): void {
  const planets: PlanetId[] = [];
  for (const p of r.list('planets')) {
    if ((PLANET_IDS as readonly string[]).includes(p)) planets.push(p as PlanetId);
    else r.report('planets', `행성 '${p}' 를 모른다 (${PLANET_IDS.join(' · ')})`);
  }
  if (planets.length === 0) r.report('planets', '등장 행성이 하나 이상 있어야 한다');
  GAME_PLANETS.set(id, planets);
}

export const GAME_CONSOLE_ITEM_DEFS: readonly ItemDef[] = csvRows('game_consoles.csv').map((r) => {
  const id = r.str('id');
  if (!/^console_[a-z0-9_]{1,40}$/.test(id)) r.report('id', `게임기 id '${id}' 는 console_<소문자 이름> 이어야 한다`);
  gamePlanetsCell(r, id);
  return {
    ...def({
      id, name: r.str('name'), category: 'console', rarity: r.enum('rarity', RARITY_ORDER),
      width: r.int('width', { min: 1 }), height: r.int('height', { min: 1 }), stackMax: 1,
      value: r.int('value', { min: 0 }), weight: r.num('weight', { min: 0 }),
      icon: CATEGORY_ICON.console, description: r.str('description'), gameConsole: { console: r.str('console') },
    }),
    color: CATEGORY_COLOR.console,
  };
});

const GAME_CONSOLE_KINDS: ReadonlySet<string> = new Set(GAME_CONSOLE_ITEM_DEFS.map((d) => d.gameConsole!.console));

export const GAME_DISC_ITEM_DEFS: readonly ItemDef[] = csvRows('game_discs.csv').map((r) => {
  const id = r.str('id');
  if (!/^game_[a-z0-9_]{1,40}$/.test(id)) r.report('id', `게임 디스크 id '${id}' 는 game_<소문자 이름> 이어야 한다 (서재 보관함 세이브의 id 모양)`);
  gamePlanetsCell(r, id);
  const consoleKind = r.str('console');
  if (!GAME_CONSOLE_KINDS.has(consoleKind)) r.report('console', `게임기 규격 '${consoleKind}' 가 game_consoles.csv 에 없다`);
  const minigame = r.enum('minigame', GAME_MINIGAMES);
  const tuning: GymGameTuning = {};
  for (const key of ['speedMul', 'windowMul', 'countMul'] as const) {
    const v = r.optNum(key, { min: 0 });
    if (v === undefined) continue;
    if (v <= 0) { r.report(key, '0 보다 커야 한다 (비우면 헬스와 같다)'); continue; }
    tuning[key] = v;
  }
  const pattern = r.optStr('pattern');
  if (pattern) {
    const allowed = GAME_PATTERN_TOKENS[minigame];
    if (allowed.length === 0) r.report('pattern', `${minigame} 는 박자 패턴이 없다 — 칸을 비운다`);
    else {
      const bad = pattern.split('-').filter((t) => !allowed.includes(t));
      if (bad.length) r.report('pattern', `'${bad.join(', ')}' 는 ${minigame} 패턴 토큰(${allowed.join(' · ')})이 아니다 — 토큰을 - 로 잇는다`);
      else tuning.pattern = pattern;
    }
  }
  const color = r.str('color');
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) r.report('color', `'${color}' 는 #rrggbb 색이 아니다`);
  const stat: GameStat = r.enum('stat', GAME_STATS);
  return {
    ...def({
      id, name: r.str('name'), category: 'game_disc', rarity: r.enum('rarity', RARITY_ORDER),
      width: r.int('width', { min: 1 }), height: r.int('height', { min: 1 }), stackMax: 1,
      value: r.int('value', { min: 0 }), weight: r.num('weight', { min: 0 }),
      icon: CATEGORY_ICON.game_disc, description: r.str('description'),
      gameDisc: { console: consoleKind, stat, minigame, tuning, color },
    }),
    color: CATEGORY_COLOR.game_disc,
  };
});

/** 게임기 · 게임 디스크 id → 상자에서 나오는 행성 (`game_*.csv` 의 planets). */
export const GAME_ITEM_PLANETS: ReadonlyMap<string, readonly PlanetId[]> = GAME_PLANETS;

/* ── armor generated from the ArmorDef table (tactical kit) ───────────────── */
const armorItem = (a: ArmorDef): ItemDef => {
  const { width, height } = armorItemSize(a);
  return def({
    id: a.id, name: a.name, description: a.description, category: 'armor', rarity: a.rarity,
    width, height,
    /* 2026-09-10: 가격은 뎀감률이 아니라 실드에서 나온다 (`ARMOR_VALUE_SHIELD_MUL` 12.6 = 옛 4200 × 0.3 ÷ 100 이라 값은 그대로). */
    value: Math.round(T.num('ARMOR_VALUE_BASE') + a.shield * T.num('ARMOR_VALUE_SHIELD_MUL') + a.durabilityMax * T.num('ARMOR_VALUE_DUR_MUL')),
    icon: ARMOR_ICON[a.id] ?? '⛊', armorId: a.id, weight: a.weight, durabilityMax: a.durabilityMax,
  });
};

/* ── 일반 아이템 (수류탄 · 회복 · 귀중품 · 재료 · 약초 · 가젯) — data/items.csv ── */
/**
 * `items.csv` 한 줄 → `ItemDef`. 카테고리별로 나눠 담아 두므로 `ITEM_DEFS` 는
 * 예전과 똑같은 순서로 조립된다 (UI 목록 순서가 이 순서다).
 */
const GENERIC_ITEM_DEFS: readonly ItemDef[] = csvRows('items.csv').map((r) => {
  const heal = r.has('healUseTime') ? {
    useTime: r.num('healUseTime', { min: 0 }),
    amount: r.num('healHp', { min: 0 }),
    overTime: r.num('healOverTime', { min: 0 }),
    ...(r.has('sprayTick') ? {
      spray: {
        tick: r.num('sprayTick', { min: 0 }),
        gaugePerTick: r.num('sprayGauge', { min: 0 }),
        healPerTick: r.num('sprayHeal', { min: 0 }),
        radius: r.num('sprayRadius', { min: 0 }),
      },
    } : {}),
  } : undefined;
  /* 2026-09-11 (온실 개편): `category: 'soil'` 줄만 `soilTag` · `soilUses` 를 채운다 — `heal*` · `gadgetId` 와 같은
   * 선택 열 규약이다 (칸이 비어 있으면 필드 자체가 안 붙는다). `uses` 는 한 번 부은 토양이 견디는 수확 횟수이고
   * 그 등급 곡선은 `SOIL_USES_BY_RARITY`(data/tables.csv) 다 — csv 의 값이 실제로 쓰이는 숫자다. */
  /* 2026-09-13 (요리 재료 티어): 토양은 **최대 내구도**(`soilDurability`)가 필수다 — 부어 둔 흙은 수확마다 닳고 0 이어도 쓰지만
   * 보너스가 내구도 비율로 준다 (`housing/`). `uses` 는 옛 세이브의 남은 횟수를 내구도로 옮기는 데만 남았다. */
  const soil: SoilDef | undefined = r.has('soilTag')
    ? { tag: r.enum('soilTag', SOIL_TAGS) as SoilTag, uses: r.int('soilUses', { min: 1 }), durability: r.int('soilDurability', { min: 1 }) }
    : undefined;
  if (!soil && r.has('soilDurability')) r.report('soilDurability', '토양(soilTag)이 아닌 줄에 토양 내구도가 있다');
  /* 2026-09-11 (A-13): `category: 'prep'` 줄만 `prepEnv` · `prepShort` 를 채운다 — `soil` 과 같은 선택 열 규약이다.
   * `env` 는 이 준비물이 **완전히** 막아 주는 행성 환경이고, `short` 는 HUD 배지에 찍는 짧은 이름(「방독」 · 「내열」)이다.
   * 쓰는 곳은 `progression`(다음 레이드 1회분) · `player`(피해 면제) · `ui`(배지 · 툴팁) 이고 items 는 표만 옮긴다. */
  const prepEnv = r.optEnum('prepEnv', ENV_KINDS);
  const prep: PrepDef | undefined = prepEnv ? { env: prepEnv, short: r.str('prepShort') } : undefined;
  /* 2026-09-11 (A-15 프린터): `category: 'pouch'` 줄만 `pouchCols` · `pouchRows` · `pouchAccepts` 를 채운다.
   * `accepts` 는 `|` 로 이은 `ItemCategory` 목록이라 `enumList` 가 **모르는 이름을 스스로 신고한다**
   * (`npm run data:check` 가 그 신고를 집는다) — 카테고리 이름을 items/ 에 또 적지 않으려고
   * 허용 목록은 `CATEGORY_LABEL_KO` 의 키에서 뽑는다 (`ItemCategory` 를 키로 하는 Record 라 늘 빠짐없다). */
  const pouch: PouchDef | undefined = r.has('pouchCols')
    ? { cols: r.int('pouchCols', { min: 1 }), rows: r.int('pouchRows', { min: 1 }), accepts: r.enumList('pouchAccepts', ITEM_CATEGORIES) }
    : undefined;
  /* 받는 카테고리가 하나도 없는 주머니는 아무것도 못 넣는 빈 격자다 — 오타를 조용히 넘기지 않는다. */
  if (pouch && pouch.accepts.length === 0) r.report('pouchAccepts', '주머니가 받아 주는 카테고리가 하나도 없다');
  /* 2026-09-11 (A-14 배양조): 세포주(`strainOut`·`strainQty`·`strainHours`) · 영양 배지(`mediumUses`·`mediumSpeed`).
   * 둘 다 `category: 'material'` 줄에 붙는 선택 열이고, 그 산출물 · 시간을 쓰는 곳은 `housing/` 의 배양조다.
   * `outputDefId` 가 가리키는 아이템이 있는지는 여기서 보지 않는다 — `SampleDef.rewardDefId` 와 같은 규약이다
   * (`ITEM_DEF_MAP` 이 아직 없다; 이름 검사는 `npm run data:check` 의 몫). */
  /* 2026-09-13 (요리 재료 티어 T3): 배양 칸에 **배양 스캐폴드**가 있으면 세포주는 `strainScaffold*` 3칸의 산출(종별 고기)을 만든다.
   * 셋은 함께 채우거나 함께 비운다 — 반만 채운 줄은 조용히 버리지 않고 신고한다. 산출 id 가 실제 아이템인지는 `data:check` 몫이다. */
  const strainOut = r.optStr('strainOut');
  const SCAFFOLD_COLS = ['strainScaffoldOut', 'strainScaffoldQty', 'strainScaffoldHours'] as const;
  const scaffoldCols = SCAFFOLD_COLS.filter((c) => r.has(c)).length;
  if (scaffoldCols > 0 && scaffoldCols < SCAFFOLD_COLS.length) {
    r.report('strainScaffoldOut', '스캐폴드 산출 3칸(strainScaffoldOut · strainScaffoldQty · strainScaffoldHours)은 함께 채우거나 함께 비운다');
  }
  if (!strainOut && scaffoldCols > 0) r.report('strainScaffoldOut', '세포주(strainOut)가 아닌 줄에 스캐폴드 산출이 있다');
  const strain: StrainDef | undefined = strainOut
    ? {
      outputDefId: strainOut, outputQty: r.int('strainQty', { min: 1 }), cultureHours: r.num('strainHours', { min: 0 }),
      ...(scaffoldCols === SCAFFOLD_COLS.length ? {
        scaffoldOutputDefId: r.str('strainScaffoldOut'),
        scaffoldOutputQty: r.int('strainScaffoldQty', { min: 1 }),
        scaffoldHours: r.num('strainScaffoldHours', { min: 0 }),
      } : {}),
    }
    : undefined;
  /* 2026-09-13: 배지도 토양과 같은 내구도 규칙이다 (사용자 결정) — `mediumDurability` 가 필수, `uses` 는 옛 세이브 이관용. */
  const medium: MediumDef | undefined = r.has('mediumUses')
    ? { uses: r.int('mediumUses', { min: 1 }), speedMul: r.num('mediumSpeed', { min: 0 }), durability: r.int('mediumDurability', { min: 1 }) }
    : undefined;
  if (!medium && r.has('mediumDurability')) r.report('mediumDurability', '영양 배지(mediumUses)가 아닌 줄에 배지 내구도가 있다');
  /* 2026-09-13: 배양 스캐폴드 · 은퇴. 은퇴한 세포주는 strain 칸을 비워야 배양조가 받지 않는다 — 남아 있으면 신고한다. */
  const scaffold = r.has('scaffold') && r.bool('scaffold');
  const retired = r.has('retired') && r.bool('retired');
  if (retired && strain) r.report('strainOut', '은퇴한 세포주는 strain* 칸을 비운다 (배양조가 받지 않게)');
  /* 2026-09-15 (B-16 · 사용자 버그 「소이 수류탄에 불 지대가 안 만들어진다」): `grenadeFire` = 이 수류탄은 고폭 대신 작은 폭발 +
   * 터진 자리에 화염 지대 (weapons `Grenade` → `ctx.gadgets.igniteGrenadeFire`). 수류탄이 아닌 줄에 있으면 아무도 안 읽으므로 신고한다. */
  /* 2026-09-15 (가젯 개편, 사용자 결정): `ItemCategory` 의 `'grenade'` 가 폐지돼 수류탄도 `category: 'gadget'` 이다 —
   * 수류탄인지를 가르는 값은 `grenade` 열 하나(`ItemDef.grenade`)이고 `grenadeFire` 는 `grenade === 'fire'` 와 같은 뜻으로 남는다. */
  const grenadeKind = r.has('grenade') ? (r.str('grenade') as GrenadeKind) : undefined;
  if (grenadeKind && grenadeKind !== 'frag' && grenadeKind !== 'fire') r.report('grenade', "수류탄 종류는 frag · fire 둘뿐이다");
  const grenadeFire = grenadeKind ? grenadeKind === 'fire' : (r.has('grenadeFire') && r.bool('grenadeFire'));
  if (grenadeFire && !grenadeKind) r.report('grenadeFire', '수류탄(grenade 열)이 아닌 줄에 grenadeFire 가 있다');
  /* 가젯을 쓰거나 설치하기까지의 홀드 시간 — `weapons/model.useTimeOf` 가 회복약과 같은 틀로 읽는다. */
  const gadgetUseTime = r.has('gadgetUseTime') ? r.num('gadgetUseTime', { min: 0 }) : undefined;
  if (gadgetUseTime !== undefined && !r.has('gadgetId') && !grenadeKind) r.report('gadgetUseTime', '가젯 · 수류탄이 아닌 줄에 gadgetUseTime 이 있다');
  return def({
    id: r.str('id'), name: r.str('name'), category: r.str('category') as ItemCategory,
    rarity: r.str('rarity') as Rarity,
    width: r.int('width', { min: 1 }), height: r.int('height', { min: 1 }),
    stackMax: r.int('stackMax', { min: 1 }), value: r.int('value', { min: 0 }),
    weight: r.num('weight', { min: 0 }), icon: r.str('icon'),
    description: r.str('description'),
    ...(r.has('quickUsable') ? { quickUsable: r.bool('quickUsable') } : {}),
    ...(r.has('gadgetId') ? { gadgetId: r.str('gadgetId') as ItemDef['gadgetId'] } : {}),
    ...(grenadeKind ? { grenade: grenadeKind } : {}),
    ...(gadgetUseTime !== undefined ? { gadgetUseTime } : {}),
    ...(r.has('durabilityMax') ? { durabilityMax: r.num('durabilityMax', { min: 0 }) } : {}),
    ...(r.has('healAmount') ? { healAmount: r.num('healAmount', { min: 0 }) } : {}),
    ...(heal ? { heal } : {}),
    ...(soil ? { soil } : {}),
    ...(prep ? { prep } : {}),
    ...(pouch ? { pouch } : {}),
    ...(strain ? { strain } : {}),
    ...(medium ? { medium } : {}),
    ...(scaffold ? { scaffold: true } : {}),
    ...(retired ? { retired: true } : {}),
    ...(grenadeFire ? { grenadeFire: true } : {}),
  });
});

/** `items.csv` 안에서 한 카테고리만 뽑는다 (파일에 적힌 순서 그대로). */
const itemGroup = (category: ItemCategory): ItemDef[] => GENERIC_ITEM_DEFS.filter((d) => d.category === category);

/* 2026-09-11 (A-14 · A-15): 배양조 · 프린터 재료(배지 · 세포주 · 배양 산물 · 필라멘트)는 `items.csv` 에서
 * 준비물(`prep`) **뒤에** 적혀 있고, 목록에서도 거기 붙어야 한다 (「밭 → 연구실 → 프린터」 한 덩어리).
 * 그래서 재료 그룹을 **그 경계에서** 가른다 — 파일 순서가 곧 표시 순서라는 `items.csv` 머리 주석 그대로이고,
 * 아이템 id 를 코드에 적지 않으므로 csv 에 줄을 더하기만 하면 제자리에 붙는다. */
const PREP_ROW_AT = GENERIC_ITEM_DEFS.map((d) => d.category).lastIndexOf('prep');
/** `prep` 줄보다 앞에 있는 그 카테고리의 줄 (준비물이 한 줄도 없으면 전부). */
const itemGroupBeforePrep = (category: ItemCategory): ItemDef[] =>
  GENERIC_ITEM_DEFS.filter((d, i) => d.category === category && (PREP_ROW_AT < 0 || i < PREP_ROW_AT));
/** `prep` 줄보다 뒤에 있는 그 카테고리의 줄. */
const itemGroupAfterPrep = (category: ItemCategory): ItemDef[] =>
  GENERIC_ITEM_DEFS.filter((d, i) => d.category === category && PREP_ROW_AT >= 0 && i > PREP_ROW_AT);

/* ── 실드 충전기 (2026-09-10) ─────────────────────────────────────────────────
 * 방탄복이 주는 **실드**(추가 체력)를 채우는 소모품 3종. 회복 소모품과 나란히 `category: 'stim'` 이라
 * 퀵슬롯 · 루팅 카테고리 · 손에 든 모습이 전부 공짜로 따라온다. 다른 점은 좌클릭 홀드가 끝났을 때
 * `PlayerRef.applyHeal` 이 아니라 **`PlayerRef.chargeShield`** 로 간다는 것뿐이다.
 *
 * `ItemDef` 에 칸을 새로 열지 않은 이유: `src/shared` 는 조율 없이 고치지 않는 계약이다. 대신
 * 여기 표 하나를 두고 `weapons/` 와 `inventory/` 가 `shieldChargeOf(defId)` 로 묻는다
 * (두 폴더 모두 이미 `@/items` 를 import 한다 — `WeaponDefaults.ts` · `inventory/Gear.ts` 참고).
 */
export interface ShieldChargeDef {
  /** 좌클릭을 눌러야 하는 시간(초) — 회복 소모품의 `heal.useTime` 과 같은 뜻. */
  useTime: number;
  /** 채워 줄 실드량. `Infinity` = 완전 회복 (csv 의 `shieldHp` 가 음수일 때). */
  amount: number;
}

/** `items.csv` 의 `shieldUseTime` / `shieldHp` 칸이 채워진 줄 = 실드 충전기. */
export const SHIELD_CHARGE_MAP: ReadonlyMap<string, ShieldChargeDef> = new Map(
  csvRows('items.csv')
    .filter((r) => r.has('shieldUseTime'))
    .map((r) => {
      const hp = r.num('shieldHp');
      return [r.str('id'), { useTime: r.num('shieldUseTime', { min: 0 }), amount: hp < 0 ? Infinity : hp }] as const;
    }),
);

/** 이 아이템이 실드 충전기면 그 수치, 아니면 undefined. */
export function shieldChargeOf(defId: string | undefined): ShieldChargeDef | undefined {
  return defId ? SHIELD_CHARGE_MAP.get(defId) : undefined;
}

/* ── 전투 소모품 3종 (2026-09-12 — 아드레날린 주사 · 각성제 · 안정제) ───────────────
 * 실드 충전기와 같은 옆 표 규약이다: `category: 'stim'` 이라 퀵슬롯 · 루팅 카테고리 · 손에 든 모습 · 좌클릭 홀드가 공짜로
 * 따라오고, 다른 점은 홀드가 끝났을 때 **어디로 가는가**뿐이다 — `adrenaline` · `stimulant` 는 `PlayerRef.applyBoost`,
 * `implant_refill` 은 `ImplantsRef.refillAll`. 체력이 가득해도 쓸 수 있다 (회복약의 "가득이면 거절" 을 타지 않는다).
 * 효과 수치는 `data/constants.csv` 의 `BOOST_*` 이고 여기에는 **효과 종류와 홀드 시간**만 있다.
 */
export type BoostEffect = BoostKind | 'implant_refill';
export const BOOST_EFFECTS: readonly BoostEffect[] = ['adrenaline', 'stimulant', 'implant_refill'];

export interface BoostItemDef {
  effect: BoostEffect;
  /** 좌클릭을 눌러야 하는 시간(초) — 회복 소모품의 `heal.useTime` 과 같은 뜻. */
  useTime: number;
}

/** `items.csv` 의 `boostEffect` / `boostUseTime` 칸이 채워진 줄 = 전투 소모품. */
export const BOOST_ITEM_MAP: ReadonlyMap<string, BoostItemDef> = new Map(
  csvRows('items.csv')
    .filter((r) => r.has('boostEffect'))
    .map((r) => [r.str('id'), {
      effect: r.enum('boostEffect', BOOST_EFFECTS) as BoostEffect,
      useTime: r.num('boostUseTime', { min: 0 }),
    }] as const),
);

/** 이 아이템이 전투 소모품이면 그 효과 · 홀드 시간, 아니면 undefined. */
export function boostItemOf(defId: string | undefined): BoostItemDef | undefined {
  return defId ? BOOST_ITEM_MAP.get(defId) : undefined;
}

/* ── definitions ──────────────────────────────────────────────────────────── */
export const ITEM_DEFS: readonly ItemDef[] = [
  /* weapons — primary / secondary (do not occupy grid cells while equipped) */
  ...WEAPON_ITEM_DEFS,
  /* 회복 소모품 (2026-09-15: 수류탄 2종은 `category: 'gadget'` 이 되어 아래 가젯 묶음 맨 앞으로 옮겨 갔다 — csv 순서 그대로다) */
  ...itemGroup('stim'),
  /* ammo v2 · attachments · bags */
  ...AMMO_ITEM_DEFS,
  ...ATTACHMENT_ITEM_DEFS,
  ...BAG_ITEM_DEFS,
  /* valuables — value and weight are deliberately uncorrelated */
  ...itemGroup('valuable'),
  /* materials · herbs (gathered from world plants) — 배양조 · 프린터 재료는 아래 연구실 묶음에 있다 */
  ...itemGroupBeforePrep('material'),
  ...itemGroup('herb'),
  /* 2026-09-11 온실 개편: 작물(재배층 수확물 — 판매 · 세레스 납품) · 토양(채집 노드 전용, 재배층에 붓는다).
     약초 바로 뒤에 두어 "밭에서 나온 것" 이 목록에서 한 덩어리로 읽힌다. */
  ...itemGroup('crop'),
  ...itemGroup('soil'),
  /* 2026-09-16 (접시 모델, 사용자 결정): 요리는 더 이상 아이템이 아니다 — 식탁의 접시다. 표는 `shared/meals.ts` (`getMealDef`). */
  /* 2026-09-11 연구실(A-12 · A-13): 표본(분석기가 해석한다 — `samples.csv`) · 준비물(함선에서 써서 다음 레이드
     1회분으로 싣는다). 밭에서 나온 것 바로 뒤가 연구실에서 쓰는 것이다. */
  ...SAMPLE_ITEM_DEFS,
  /* 2026-09-13 요리 재료 티어: 소켓(분석기가 미확인 DNA 에서 뽑는다 — 흙 · 배지에 끼운다)은 표본 바로 뒤. */
  ...SOCKET_ITEM_DEFS,
  ...itemGroup('prep'),
  /* 2026-09-11 배양조 · 프린터(A-14 · A-15): 영양 배지 · 세포주 · 배양 산물 · 필라멘트(전부 `material`) →
     그 필라멘트로 찍는 주머니 → 주머니가 나르는 열쇠. 사슬 순서 그대로 읽힌다. */
  ...itemGroupAfterPrep('material'),
  ...itemGroup('pouch'),
  ...itemGroup('key'),
  /* seeds (Phase 8: 온실 재배층에 심는다) · books (Phase 9: 서재 책장에 꽂는다) */
  ...SEED_ITEM_DEFS,
  ...BOOK_ITEM_DEFS,
  /* 2026-09-12 (A-3e): 서재 매체 — 책과 같은 역할이라 책 바로 뒤 (디스크 전시대 · 레코드랙) */
  ...DISC_ITEM_DEFS,
  ...RECORD_ITEM_DEFS,
  /* 2026-09-13 (비디오게임): 게임기(TV 에 장착) · 게임 디스크(게임 디스크 전시대) — 서재 매체 바로 뒤 */
  ...GAME_CONSOLE_ITEM_DEFS,
  ...GAME_DISC_ITEM_DEFS,
  /* 임플란트 (Phase 12: 캐릭터 탭에 장착; 망가진 것만 루팅, 세레스 바이오가 수리 · 판매 — `ImplantDefs.ts`) */
  ...IMPLANT_ITEM_DEFS,
  /* gadgets — 수류탄 2종이 맨 앞이다 (behaviour lives in src/gadgets; here they are just consumables) */
  ...itemGroup('gadget'),
  /* armor generated from the ArmorDef table */
  ...ARMOR_DEFS.map(armorItem),
];

export const ITEM_DEF_MAP: ReadonlyMap<string, ItemDef> = new Map(ITEM_DEFS.map((d) => [d.id, d]));

/** 2026-09-13: 옛 id(`data/item_aliases.csv`)는 새 id 로 풀어서 찾는다 — 세이브를 옮기는 폴더가 놓친 id 의 안전망. `ITEM_DEF_MAP` 은 정확한 id 만 안다. */
export function getItemDef(defId: string): ItemDef | undefined {
  return ITEM_DEF_MAP.get(defId) ?? ITEM_DEF_MAP.get(resolveItemAlias(defId));
}

export function itemDefsByCategory(category: ItemCategory): ItemDef[] {
  return ITEM_DEFS.filter((d) => d.category === category);
}

/** Item id for a weapon def id (`ar` → `wpn_ar`, `ar_g3` → `wpn_ar_g3`). */
export function itemIdForWeapon(weaponId: string): string {
  return `wpn_${weaponId}`;
}

/** True when the def is an equippable weapon (primary or secondary with a `weaponId`). */
export function isWeaponItemDef(d: ItemDef | undefined): d is ItemDef & { weaponId: string } {
  return !!d && (d.category === 'primary' || d.category === 'secondary') && !!d.weaponId;
}

/** True when the item may be dropped into a quick-use slot. */
export function isQuickUsable(def: ItemDef): boolean {
  return def.quickUsable === true || QUICK_USABLE_CATEGORIES.includes(def.category);
}

/**
 * Minimum kit (2026-09-07). No longer handed out at every `world:ready` — the player equips out of the 함선 창고
 * (`STARTER_STASH`, granted once on a fresh profile). `inventory` only falls back to this when the loadout **and**
 * the stash are empty, so a player who lost everything is never stuck with no way to raid.
 */
export const STARTER_LOADOUT = {
  // 2026-09-10: 보조무기가 사라져 최소 지급품도 주무기 한 정이다 (예전에는 `secondary: 'wpn_hg'` 권총이었다).
  primary: 'wpn_smg',
  primary2: null,
  secondary: null,
  bag: 'bag_common',
  /* appended: tactical kit */
  armor: 'armor_1',
  items: [
    { id: 'ammo_light', qty: AMMO_STACK_ROUNDS.light },
    { id: 'heal_bandage', qty: 2 },
    { id: 'grenade_frag', qty: 3 },
  ],
} as const;

/**
 * 기본 지급품 (2026-09-07): written into the 함선 창고 **once**, on a profile that has never had a stash.
 * `qty` is units **per stack** (ammo: rounds, clamped to the def's `stackMax`) and `stacks` how many of them —
 * one 세트 per stack, so `{ ammo_light, qty: 80, stacks: 10 }` is the 경탄 10세트 of the 기본 지급품 list.
 */
export const STARTER_STASH: readonly { id: string; qty: number; stacks?: number }[] = [
  /* 탄약 10세트씩 (한 세트 = 한 칸 가득) */
  { id: 'ammo_light', qty: AMMO_STACK_ROUNDS.light, stacks: 10 },
  { id: 'ammo_medium', qty: AMMO_STACK_ROUNDS.medium, stacks: 10 },
  { id: 'ammo_heavy', qty: AMMO_STACK_ROUNDS.heavy, stacks: 10 },
  { id: 'ammo_shell', qty: AMMO_STACK_ROUNDS.shell, stacks: 10 },
  /* 일반 등급 총기 한 자루씩 (권총은 기본 장착분과 별개로 지급하지 않는다) */
  { id: 'wpn_smg', qty: 1 },
  { id: 'wpn_sg', qty: 1 },
  { id: 'wpn_ar', qty: 1 },
  { id: 'wpn_dmr', qty: 1 },
  { id: 'wpn_sr', qty: 1 },
  /* 여분 가방 · 방탄복 (장착분은 STARTER_LOADOUT) */
  { id: 'bag_common', qty: 1, stacks: 3 },
  { id: 'armor_1', qty: 1, stacks: 3 },
  /* 첫 시설 체인 전부: 작업실 증축 (`ROOM_PURPOSE_BUILD_COST.workshop` 폐금속 8 · 케이블 2) + 총기 작업대 제작
     (`furn_bench_gun.craft` 폐금속 8 · 합금 2 · 케이블 1) = 폐금속 16 · 케이블 3 · 합금 2. 2026-09-08: 발전기 Lv.1 (폐금속 4)까지
     쓰면 폐금속이 모자라 24 · 4 · 3 으로 올렸다. 2026-09-13: 발전기가 처음부터 Lv.1 이라 폐금속 8 이 남는다 (그대로 둔다). */
  { id: 'mat_scrap', qty: 8, stacks: 3 },
  { id: 'mat_cable', qty: 4 },
  { id: 'mat_alloy', qty: 3 },
  /* 소모품 */
  { id: 'gad_defib', qty: 2, stacks: 2 },
  { id: 'grenade_frag', qty: 3, stacks: 3 },
];

export type StarterLoadout = {
  primary: string | null;
  primary2: string | null;
  secondary: string | null;
  bag: string | null;
  armor: string | null;
  items: readonly { id: string; qty: number }[];
};
