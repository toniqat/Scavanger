import type { AmmoType, ArmorDef, AttachmentDef, BagDef, ItemCategory, ItemDef, Rarity, SeedDef, SkillId, WeaponDef, WeaponGrade } from '@/shared';
import {
  AMMO_STACK_ROUNDS, CATEGORY_COLOR, CATEGORY_ICON, HEAL_SPRAY_GAUGE, HEAL_SPRAY_RADIUS,
  QUICK_USABLE_CATEGORIES, RARITY_COLORS, SEED_GROW_HOURS_BY_RARITY, SKILL_IDS, rarityForGrade,
} from '@/shared';
import { WEAPON_DEFS, gradeOf, isUniqueWeapon, weaponFamilyOf } from './WeaponDefs';
import { ARMOR_DEFS, ARMOR_ICON, armorItemSize } from './ArmorDefs';
import { IMPLANT_ITEM_DEFS } from './ImplantDefs';

/* ── palette / labels ─────────────────────────────────────────────────────── */
/* Phase 7 (2026-09-06): the rarity / category labels, colours, icons and order live in `src/shared/labels.ts` now so
 * meta/ and ui/ can use them without importing items/. Re-exported here so every existing `@/items` import keeps working. */
export {
  RARITY_COLORS, RARITY_ORDER, rarityRank, rarityForGrade, gradeForRarity,
  RARITY_LABEL_KO, CATEGORY_LABEL_KO, CATEGORY_COLOR, CATEGORY_ICON,
} from '@/shared';

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
export const DEFAULT_ITEM_WEIGHT = 0.1;

/** Weight in kg of `qty` units of `def`. */
export function itemWeight(def: ItemDef, qty = 1): number {
  return (def.weight ?? DEFAULT_ITEM_WEIGHT) * Math.max(0, qty);
}

/* ── builder ──────────────────────────────────────────────────────────────── */
type DefInput = Omit<ItemDef, 'color' | 'stackMax'> & { stackMax?: number };
const def = (d: DefInput): ItemDef => ({ ...d, stackMax: d.stackMax ?? 1, color: RARITY_COLORS[d.rarity] });

/* ── weapons (one ItemDef per WeaponDef grade) ────────────────────────────── */
interface WeaponFamilyMeta {
  width: number; height: number; icon: string; value: number; description: string;
  /** kg (tactical kit weight budget). */
  weight: number;
}
const WEAPON_FAMILY_META: Readonly<Record<string, WeaponFamilyMeta>> = {
  ar: { width: 4, height: 2, icon: '⌐╦', value: 350, weight: 4.2, description: '균형 잡힌 연사와 안정적인 반동의 표준 돌격소총. 준중량탄.' },
  smg: { width: 3, height: 2, icon: '⌐╪', value: 480, weight: 3.1, description: '경량 기관단총. 근거리 연사에 특화되었으나 거리가 멀어질수록 위력이 급감. 경량탄.' },
  sg: { width: 3, height: 2, icon: '⌐═', value: 520, weight: 4.6, description: '펌프액션 산탄총. 근거리에서 압도적인 제압력. 산탄.' },
  dmr: { width: 4, height: 1, icon: '⌐──', value: 780, weight: 4.4, description: '반자동 지정사수소총. 원거리 정밀 사격에 최적화. 중량탄.' },
  sr: { width: 5, height: 1, icon: '⌐───', value: 950, weight: 6.8, description: '볼트액션 저격소총. 4배율 조준경. 한 발로 대부분의 벌레를 무력화하지만 장전이 느리다. 중량탄.' },
  hg: { width: 2, height: 1, icon: '⌐', value: 140, weight: 1.1, description: '신뢰할 수 있는 반자동 사이드암. 경량탄.' },
};
const FALLBACK_META: WeaponFamilyMeta = { width: 3, height: 2, icon: '⌐', value: 300, weight: 3.5, description: '무기.' };

/** Value multiplier per grade above I. */
export const WEAPON_GRADE_VALUE_STEP = 0.6;

/* ── unique weapons (Phase 6): fixed legendary items, description names the LMB / RMB behaviour ── */
interface UniqueWeaponMeta extends WeaponFamilyMeta { rarity: Rarity }
const UNIQUE_WEAPON_META: Readonly<Record<string, UniqueWeaponMeta>> = {
  u_flame: { width: 5, height: 2, icon: '⌐♨', value: 6800, weight: 9.5, rarity: 'legendary',
    description: '연료를 태워 불길을 뿜는 화염방사기. 좌클릭: 넓은 화염 분사 (지속 피해 + 잔불). 우클릭: 길고 가는 화염 제트. 열이 쌓인 적은 전소되어 몸부림친다. 정조준 없음.' },
  u_shock: { width: 4, height: 2, icon: '⌐⚡', value: 7200, weight: 6.2, rarity: 'legendary',
    description: '테슬라 코일 전격총. 좌클릭: 시야 안 최대 4마리에게 동시에 전격 (감전·둔화). 우클릭: 충전 후 놓으면 고위력 전격탄. 정조준 없음.' },
  u_shuriken: { width: 3, height: 2, icon: '⌐✧', value: 5400, weight: 2.4, rarity: 'legendary',
    description: '팔 보호구형 표창 발사기. 좌클릭: 표창 1개. 우클릭: 부채꼴로 3개. 근접(F) 홀드 후 놓으면 스태미나 절반을 써서 넓은 용검 베기. 정조준 없음.' },
  u_bow: { width: 5, height: 2, icon: '⌐)', value: 5900, weight: 3.6, rarity: 'legendary',
    description: '컴포짓 보우. 좌클릭: 직선으로 날아가는 화살 (낙차 없음). 우클릭: 정조준 (유니크 중 유일). 저격소총보다 짧지만 지정사수소총 연사.' },
  u_bazooka: { width: 5, height: 2, icon: '⌐═▶', value: 8400, weight: 11.8, rarity: 'legendary',
    description: '해머헤드 바주카. 좌클릭: 착탄 폭발 로켓 (구조물 파괴). 우클릭: 짧은 신관으로 공중 폭발. 폭발 반경 안에 있으면 자신도 피해와 넉백을 받는다 — 공중에서 발밑을 쏘면 로켓 점프. 정조준 없음.' },
  u_minigun: { width: 5, height: 2, icon: '⌐≣', value: 7600, weight: 14.5, rarity: 'legendary',
    description: '6총열 미니건. 좌클릭 홀드: 1.2초 예열 후 초당 24발 연사, 회전 중 이동 속도 55 %. 우클릭: 예열 유지. 정조준 없음.' },
};

function weaponItemDef(w: WeaponDef): ItemDef {
  if (isUniqueWeapon(w)) {
    const meta = UNIQUE_WEAPON_META[w.id] ?? { ...FALLBACK_META, rarity: 'legendary' as const };
    return def({
      id: itemIdForWeapon(w.id), name: w.name, category: w.slot, rarity: meta.rarity,
      width: meta.width, height: meta.height, value: meta.value,
      icon: meta.icon, weaponId: w.id, description: meta.description, weight: meta.weight,
    });
  }
  const meta = WEAPON_FAMILY_META[weaponFamilyOf(w)] ?? FALLBACK_META;
  const grade = gradeOf(w);
  return def({
    id: itemIdForWeapon(w.id), name: w.name, category: w.slot, rarity: rarityForGrade(grade),
    width: meta.width, height: meta.height, value: Math.round(meta.value * (1 + WEAPON_GRADE_VALUE_STEP * (grade - 1))),
    icon: meta.icon, weaponId: w.id, description: meta.description, weight: meta.weight,
  });
}

export const WEAPON_ITEM_DEFS: readonly ItemDef[] = WEAPON_DEFS.map(weaponItemDef);

/* ── ammo v2 (qty = rounds) ───────────────────────────────────────────────── */
/** kg per round (tactical kit weight budget). */
export const AMMO_ROUND_WEIGHT: Readonly<Partial<Record<AmmoType, number>>> = {
  light: 0.012, medium: 0.02, heavy: 0.04, shell: 0.05,
  /* unique calibres: a full stack weighs 4–7 kg (fuel 200 → 4 kg, rockets 6 → 7.2 kg) */
  fuel: 0.02, cell: 0.06, shuriken: 0.07, arrow: 0.05, rocket: 1.2, belt: 0.015,
};
const ammoDef = (type: AmmoType, name: string, value: number, icon: string, description: string, rarity: Rarity = 'common'): ItemDef =>
  def({ id: ammoItemIdFor(type), name, category: 'ammo', rarity, width: 1, height: 1,
    stackMax: AMMO_STACK_ROUNDS[type], value, icon, ammoType: type, description, weight: AMMO_ROUND_WEIGHT[type] ?? 0.02 });

export const AMMO_ITEM_DEFS: readonly ItemDef[] = [
  ammoDef('light', '경량탄', 1, '▪', '기관단총·권총용 경량 탄약. 수량은 발수.'),
  ammoDef('medium', '준중량탄', 2, '▮', '돌격소총용 준중량 탄약. 수량은 발수.'),
  ammoDef('heavy', '중량탄', 3, '▬', '저격소총·지정사수소총용 중량 탄약. 수량은 발수.'),
  ammoDef('shell', '산탄', 3, '◘', '산탄총용 셸. 수량은 발수.'),
  /* unique-weapon calibres (rare: loot tables weight them by rarity, tiers 1–3 zero them out) */
  ammoDef('fuel', '연료통', 1, '⛽', '「인페르노」 화염방사기용 연료. 수량은 연료 단위 (초당 12 소모).', 'rare'),
  ammoDef('cell', '전지', 4, '▯', '「테슬라 코일」 전격총용 전지. 수량은 전지 단위.', 'rare'),
  ammoDef('shuriken', '표창', 5, '✧', '「카게」 표창 발사기용 강철 표창. 수량은 개수.', 'rare'),
  ammoDef('arrow', '화살', 4, '➶', '「롱혼」 컴포짓 보우용 카본 화살. 수량은 개수.', 'rare'),
  ammoDef('rocket', '로켓', 60, '▶', '「해머헤드」 바주카용 로켓. 수량은 발수. 한 발이 1.2 kg.', 'rare'),
  ammoDef('belt', '탄띠', 1, '≣', '「사이클론」 미니건용 연결 탄띠. 수량은 발수.', 'rare'),
];

/* ── attachments ──────────────────────────────────────────────────────────── */
const NOT_PISTOL = ['AR', 'SMG', 'SG', 'SR', 'DMR'] as const;
const attDef = (
  id: string, name: string, rarity: Rarity, value: number, icon: string, description: string, attachment: AttachmentDef,
): ItemDef => def({ id, name, category: 'attachment', rarity, width: 1, height: 1, value, icon, description, attachment, weight: 0.3 });

export const ATTACHMENT_ITEM_DEFS: readonly ItemDef[] = [
  /* muzzle */
  attDef('att_brake', '총구 제동기', 'uncommon', 180, '⊏', '총구 가스를 옆으로 분산해 수직·수평 반동을 25 % 줄인다.',
    { socket: 'muzzle', effects: { recoilV: 0.75, recoilH: 0.75 } }),
  attDef('att_comp', '보정기', 'uncommon', 180, '⊐', '탄 퍼짐을 15 % 줄이는 총구 보정기.',
    { socket: 'muzzle', effects: { spread: 0.85 } }),
  attDef('att_choke', '산탄총 초크', 'uncommon', 200, '⊓', '산탄 확산을 30 % 조여 유효 사거리를 늘린다. 산탄총 전용.',
    { socket: 'muzzle', classes: ['SG'], effects: { spread: 0.7 } }),
  /* grip */
  attDef('att_grip_angled', '앵글 그립', 'uncommon', 160, '⌊', '수평 반동을 30 % 줄이는 경사 손잡이. 권총에는 장착 불가.',
    { socket: 'grip', classes: NOT_PISTOL, effects: { recoilH: 0.7 } }),
  attDef('att_grip_vertical', '수직 그립', 'uncommon', 160, '⌋', '수직 반동을 30 % 줄이는 수직 손잡이. 권총에는 장착 불가.',
    { socket: 'grip', classes: NOT_PISTOL, effects: { recoilV: 0.7 } }),
  /* mag */
  attDef('att_mag_light', '확장형 경량 탄창', 'rare', 260, '▯', '경량탄 무기의 장탄수 40 % 증가.',
    { socket: 'mag', ammoTypes: ['light'], effects: { magSize: 1.4 } }),
  attDef('att_mag_medium', '확장형 준중량 탄창', 'rare', 280, '▯', '준중량탄 무기의 장탄수 40 % 증가.',
    { socket: 'mag', ammoTypes: ['medium'], effects: { magSize: 1.4 } }),
  attDef('att_mag_heavy', '확장형 중량 탄창', 'rare', 320, '▯', '중량탄 무기의 장탄수 40 % 증가.',
    { socket: 'mag', ammoTypes: ['heavy'], effects: { magSize: 1.4 } }),
  attDef('att_mag_shell', '확장형 산탄 탄창', 'rare', 300, '▯', '산탄총의 장탄수 40 % 증가.',
    { socket: 'mag', ammoTypes: ['shell'], effects: { magSize: 1.4 } }),
  /* stock */
  attDef('att_stock', '전술 개머리판', 'rare', 300, '⊂', '탄 퍼짐 10 % 감소, 조준 시간 25 % 단축. 권총에는 장착 불가.',
    { socket: 'stock', classes: NOT_PISTOL, effects: { spread: 0.9, adsTime: 0.75 } }),
  /* sight */
  attDef('att_laser', '레이저사이트', 'uncommon', 200, '⋅', '지향 사격 퍼짐 30 % 감소. 조준점에 레이저 도트 표시.',
    { socket: 'sight', effects: { laser: true, hipSpread: 0.7 } }),
  attDef('att_scope4', '4배 조준경', 'rare', 420, '⊙', '4배율 조준경. 조준 시 스코프 화면 전환. 권총·산탄총에는 장착 불가.',
    { socket: 'sight', classes: ['AR', 'SMG', 'SR', 'DMR'], effects: { adsZoom: 4, scope: true } }),
  attDef('att_scope6', '6배 조준경', 'epic', 700, '⊚', '6배율 조준경. 조준 시 스코프 화면 전환. 권총·산탄총에는 장착 불가.',
    { socket: 'sight', classes: ['AR', 'SMG', 'SR', 'DMR'], effects: { adsZoom: 6, scope: true } }),
  attDef('att_scope8', '8배 조준경', 'legendary', 1200, '◎', '8배율 장거리 조준경. 저격소총·지정사수소총 전용.',
    { socket: 'sight', classes: ['SR', 'DMR'], effects: { adsZoom: 8, scope: true } }),
];

/* ── bags ─────────────────────────────────────────────────────────────────── */
const bagDef = (id: string, name: string, rarity: Rarity, value: number, bag: BagDef, description: string): ItemDef =>
  def({ id, name, category: 'bag', rarity, width: 2, height: 2, value, icon: bag.tactical ? '⛶' : '▣', description, bag, weight: 1.2 + bag.cols * bag.rows * 0.02 });

export const BAG_ITEM_DEFS: readonly ItemDef[] = [
  bagDef('bag_common', '일반 가방', 'common', 120, { cols: 5, rows: 6, quickSlots: 2 }, '표준 지급 배낭. 5×6 칸, 퀵슬롯 2.'),
  bagDef('bag_uncommon', '고급 가방', 'uncommon', 260, { cols: 6, rows: 6, quickSlots: 3 }, '보강된 배낭. 6×6 칸, 퀵슬롯 3.'),
  bagDef('bag_rare', '희귀 가방', 'rare', 520, { cols: 8, rows: 6, quickSlots: 4 }, '군용 대형 배낭. 8×6 칸, 퀵슬롯 4.'),
  bagDef('bag_epic', '서사 가방', 'epic', 980, { cols: 9, rows: 6, quickSlots: 5 }, '특수부대용 배낭. 9×6 칸, 퀵슬롯 5.'),
  bagDef('bag_legendary', '전설 가방', 'legendary', 1800, { cols: 10, rows: 6, quickSlots: 6 }, '헬다이버 원정용 배낭. 10×6 칸, 퀵슬롯 6.'),
  bagDef('bag_rare_tac', '희귀 전술 가방', 'rare', 560, { cols: 7, rows: 6, quickSlots: 7, tactical: true }, '전술 조끼 일체형. 7×6 칸, 퀵슬롯 7.'),
  bagDef('bag_epic_tac', '서사 전술 가방', 'epic', 1050, { cols: 8, rows: 6, quickSlots: 8, tactical: true }, '전술 조끼 일체형. 8×6 칸, 퀵슬롯 8.'),
  bagDef('bag_legendary_tac', '전설 전술 가방', 'legendary', 1950, { cols: 9, rows: 6, quickSlots: 9, tactical: true }, '전술 조끼 일체형. 9×6 칸, 퀵슬롯 9.'),
];

/* ── 씨앗 (Phase 8) ───────────────────────────────────────────────────────────
 * Planted in a 온실 재배층 (`furn_grow_rack`); `SeedDef.growHours` is **real** wall-clock time and keeps running while
 * the game is closed (housing/ owns the plots). Loot (tier 1–3 containers, 벌레 시체) + 기업 상점 only — never craftable.
 * Growth hours come from the shared `SEED_GROW_HOURS_BY_RARITY` table so the contract stays the single source. */
const SEED_STACK_MAX = 5;
const SEED_WEIGHT = 0.05;
/** Seeds share the category glyph and a leaf-green tint so a 씨앗 reads as one at a glance in the grid. */
const SEED_ICON = CATEGORY_ICON.seed;
const SEED_COLOR = CATEGORY_COLOR.seed;

const seedDef = (
  id: string, name: string, rarity: Rarity, value: number, seed: SeedDef, description: string,
): ItemDef => ({
  ...def({
    id, name, category: 'seed', rarity, width: 1, height: 1, stackMax: SEED_STACK_MAX,
    value, icon: SEED_ICON, description, seed, weight: SEED_WEIGHT,
  }),
  color: SEED_COLOR,
});

export const SEED_ITEM_DEFS: readonly ItemDef[] = [
  seedDef('seed_bloodroot', '혈근초 씨앗', 'common', 40,
    { growHours: SEED_GROW_HOURS_BY_RARITY.common, yieldDefId: 'herb_bloodroot', yieldQty: 3 },
    '혈근초의 붉은 씨앗. 온실 재배층에 심으면 약 1시간 뒤 혈근초 3개를 거둘 수 있다. 함선을 떠나 있어도 현실 시간에 맞춰 자란다.'),
  seedDef('seed_ashleaf', '잿빛잎 씨앗', 'uncommon', 90,
    { growHours: SEED_GROW_HOURS_BY_RARITY.uncommon, yieldDefId: 'herb_ashleaf', yieldQty: 3 },
    '화산재에 굳어 있던 잿빛잎 포자낭. 온실 재배층에서 약 2.5시간이면 잿빛잎 3개가 된다. 원예 숙련도가 높을수록 빨리 자란다.'),
  seedDef('seed_glowcap', '발광버섯 씨앗', 'rare', 220,
    { growHours: SEED_GROW_HOURS_BY_RARITY.rare, yieldDefId: 'herb_glowcap', yieldQty: 2 },
    '희미하게 빛나는 발광버섯 균사 덩어리. 온실 재배층에서 약 6시간을 들여야 발광버섯 2개를 거둔다. 구하기 어려운 만큼 값도 비싸다.'),
];

/* ── 서적 (Phase 9) ────────────────────────────────────────────────────────────
 * One book per skill (`book_<skillId>`), shelved in a 서재 책장 (`furn_bookshelf`, housing/ owns the shelves and the
 * bonus: `1 + BOOK_XP_PER_BOOK × Σ BOOK_RARITY_MUL[rarity]`, capped at `BOOK_GAIN_MAX`). Rarity is per book and decides
 * its weight — common 4 / uncommon 5 / rare 3 / epic 2 across the 14 skills. Loot (tier 2–4 containers, 로그 시체) +
 * 세레스 corp shop (신뢰도 2) only — never craftable, never quick-usable. 1×2, no stacking, 0.6 kg. */
const BOOK_WEIGHT = 0.6;
const BOOK_ICON = CATEGORY_ICON.book;
const BOOK_COLOR = CATEGORY_COLOR.book;
/** Sale value by rarity (the corp shop prices off `value`). */
const BOOK_VALUE_BY_RARITY: Readonly<Record<Rarity, number>> = { common: 150, uncommon: 320, rare: 700, epic: 1500, legendary: 3000 };

/** Item id of the book that teaches `skill` (`gun_AR` → `book_gun_AR`). */
export function bookItemIdFor(skill: SkillId): string {
  return `book_${skill}`;
}

const bookDef = (skill: SkillId, name: string, rarity: Rarity, description: string): ItemDef => ({
  ...def({
    id: bookItemIdFor(skill), name, category: 'book', rarity, width: 1, height: 2, stackMax: 1,
    value: BOOK_VALUE_BY_RARITY[rarity], icon: BOOK_ICON, description, book: { skill }, weight: BOOK_WEIGHT,
  }),
  color: BOOK_COLOR,
});

/** The 14 books, in `SKILL_IDS` order (one per skill — `BOOK_ITEM_DEFS[i].book.skill === SKILL_IDS[i]`). */
export const BOOK_ITEM_DEFS: readonly ItemDef[] = [
  bookDef('carry', '『짐꾼의 요령』', 'common',
    '무거운 짐을 오래 지는 요령을 정리한 수기. 서재 책장에 꽂으면 운반 숙련의 상승량이 늘어난다.'),
  bookDef('appraisal', '『감정사의 눈』', 'uncommon',
    '전리품 감정사의 현장 노트. 서재 책장에 꽂으면 감정 숙련의 상승량이 늘어난다.'),
  bookDef('grit', '『버티는 법』', 'uncommon',
    '치명상을 견디고 살아 돌아온 헬다이버들의 증언집. 서재 책장에 꽂으면 인내 숙련의 상승량이 늘어난다.'),
  bookDef('gardening', '『함선 원예 입문』', 'common',
    '무중력 재배층 관리 입문서. 서재 책장에 꽂으면 원예 숙련의 상승량이 늘어난다.'),
  bookDef('crafting', '『야전 제작 편람』', 'uncommon',
    '폐자재로 장비를 만드는 야전 편람. 서재 책장에 꽂으면 제작 숙련의 상승량이 늘어난다.'),
  bookDef('medicine', '『전장 의학』', 'rare',
    '스팀 조제와 응급 처치를 다룬 군의관 교재. 서재 책장에 꽂으면 의학 숙련의 상승량이 늘어난다.'),
  bookDef('cryptography', '『암호 해독 원론』', 'epic',
    '군 등급 암호 체계의 원리를 파헤친 금서. 서재 책장에 꽂으면 암호학 숙련의 상승량이 늘어난다.'),
  bookDef('implant', '『전술 임플란트 운용 지침』', 'epic',
    '임플란트 에너지 관리와 냉각 주기를 다룬 기밀 지침서. 서재 책장에 꽂으면 전술 임플란트 숙련의 상승량이 늘어난다.'),
  bookDef('gun_AR', '『사격 교본: 돌격소총』', 'common',
    '슈퍼 지구 표준 돌격소총 사격 교본. 서재 책장에 꽂으면 돌격소총 사격 숙련의 상승량이 늘어난다.'),
  bookDef('gun_SMG', '『사격 교본: 기관단총』', 'common',
    '근접 연사 교본. 서재 책장에 꽂으면 기관단총 사격 숙련의 상승량이 늘어난다.'),
  bookDef('gun_SR', '『사격 교본: 저격소총』', 'rare',
    '장거리 볼트액션 저격 교본. 서재 책장에 꽂으면 저격소총 사격 숙련의 상승량이 늘어난다.'),
  bookDef('gun_DMR', '『사격 교본: 지정사수소총』', 'rare',
    '중거리 정밀 사격 교본. 서재 책장에 꽂으면 지정사수소총 사격 숙련의 상승량이 늘어난다.'),
  bookDef('gun_SG', '『사격 교본: 산탄총』', 'uncommon',
    '근거리 제압 사격 교본. 서재 책장에 꽂으면 산탄총 사격 숙련의 상승량이 늘어난다.'),
  bookDef('equipment', '『장비 정비 매뉴얼』', 'uncommon',
    '방어구와 가방을 오래 쓰는 정비 매뉴얼. 서재 책장에 꽂으면 장비 관리 숙련의 상승량이 늘어난다.'),
];
/** Book def for a skill (undefined only if a skill was added without a book — every `SKILL_IDS` entry has one). */
export const BOOK_DEF_BY_SKILL: ReadonlyMap<SkillId, ItemDef> = new Map(BOOK_ITEM_DEFS.map((d) => [d.book!.skill, d]));
for (const s of SKILL_IDS) if (!BOOK_DEF_BY_SKILL.has(s)) console.warn(`[items] skill '${s}' has no book`);

/* ── armor generated from the ArmorDef table (tactical kit) ───────────────── */
const armorItem = (a: ArmorDef): ItemDef => {
  const { width, height } = armorItemSize(a);
  return def({
    id: a.id, name: a.name, description: a.description, category: 'armor', rarity: a.rarity,
    width, height, value: Math.round(300 + a.damageReduction * 4200 + a.durabilityMax * 1.4),
    icon: ARMOR_ICON[a.id] ?? '⛊', armorId: a.id, weight: a.weight, durabilityMax: a.durabilityMax,
  });
};

/* ── definitions ──────────────────────────────────────────────────────────── */
export const ITEM_DEFS: readonly ItemDef[] = [
  /* weapons — primary / secondary (do not occupy grid cells while equipped) */
  ...WEAPON_ITEM_DEFS,

  /* grenades */
  def({ id: 'grenade_frag', name: 'G-12 고폭 수류탄', category: 'grenade', rarity: 'common', width: 1, height: 1, stackMax: 3, value: 40, icon: '●',
    weight: 0.45, quickUsable: true,
    description: '파편 수류탄. 반경 6 m 광역 피해.' }),
  def({ id: 'grenade_incendiary', name: 'G-10 소이 수류탄', category: 'grenade', rarity: 'uncommon', width: 1, height: 1, stackMax: 3, value: 70, icon: '◉',
    weight: 0.5, quickUsable: true,
    description: '소이 수류탄. 넓은 반경에 화염 피해.' }),

  /* 회복 소모품 (2026-09-07: 스팀 / 고급 스팀을 대체한다 — 사용 중에는 이동 속도가 절반)
   * `heal.useTime` = LMB 홀드 시간, `amount` / `overTime` = 회복량과 그 회복이 퍼지는 시간. */
  def({ id: 'heal_bandage', name: '붕대', category: 'stim', rarity: 'common', width: 1, height: 1, stackMax: 5, value: 45, icon: '▭', healAmount: 20,
    weight: 0.15, quickUsable: true, heal: { useTime: 5, amount: 20, overTime: 5 },
    description: '천을 감아 지혈한다. 사용 5초, 5초에 걸쳐 체력 20 회복. 사용 중 이동 속도 50 %.' }),
  def({ id: 'heal_bandage_herb', name: '약초 붕대', category: 'stim', rarity: 'uncommon', width: 1, height: 1, stackMax: 5, value: 130, icon: '▤', healAmount: 50,
    weight: 0.18, quickUsable: true, heal: { useTime: 5, amount: 50, overTime: 5 },
    description: '혈근초를 덧댄 붕대. 사용 5초, 5초에 걸쳐 체력 50 회복. 사용 중 이동 속도 50 %.' }),
  def({ id: 'heal_syringe', name: '회복주사', category: 'stim', rarity: 'rare', width: 1, height: 1, stackMax: 3, value: 260, icon: '✚', healAmount: 50,
    weight: 0.2, quickUsable: true, heal: { useTime: 2, amount: 50, overTime: 1 },
    description: '가압 주사기. 사용 2초, 1초 만에 체력 50 회복. 사용 중 이동 속도 50 %.' }),
  def({ id: 'heal_spray', name: '회복 스프레이', category: 'stim', rarity: 'epic', width: 1, height: 2, stackMax: 1, value: 780, icon: '⌁',
    weight: 0.9, quickUsable: true, durabilityMax: HEAL_SPRAY_GAUGE,
    heal: { useTime: 0, amount: 0, overTime: 0, spray: { tick: 0.1, gaugePerTick: 1, healPerTick: 1, radius: HEAL_SPRAY_RADIUS } },
    description: `재생 촉진제 분무기. 좌클릭을 누르고 있으면 0.1초마다 게이지 1을 써서 반경 ${HEAL_SPRAY_RADIUS} m 안의 자신과 아군을 체력 1씩 회복. 게이지 ${HEAL_SPRAY_GAUGE}. 사용 중 이동 속도 50 %.` }),

  /* ammo v2 */
  ...AMMO_ITEM_DEFS,

  /* attachments */
  ...ATTACHMENT_ITEM_DEFS,

  /* bags */
  ...BAG_ITEM_DEFS,

  /* valuables — value and weight are deliberately uncorrelated */
  def({ id: 'gem_quartz', name: '석영 결정', category: 'valuable', rarity: 'common', width: 1, height: 1, value: 120, icon: '◇', weight: 0.6,
    description: '흔한 광물 결정. 소량의 가치.' }),
  def({ id: 'gem_amber', name: '호박석', category: 'valuable', rarity: 'uncommon', width: 1, height: 1, value: 260, icon: '◆', weight: 0.35,
    description: '외계 수액이 굳어 생긴 호박. 수집가들이 찾는 물건.' }),
  def({ id: 'gem_sapphire', name: '청옥', category: 'valuable', rarity: 'rare', width: 1, height: 1, value: 620, icon: '◆', weight: 0.4,
    description: '순도 높은 청색 보석.' }),
  def({ id: 'gem_void', name: '공허석', category: 'valuable', rarity: 'epic', width: 1, height: 1, value: 1400, icon: '✦', weight: 1.9,
    description: '빛을 흡수하는 검은 결정. 손바닥만 한데 벽돌처럼 무겁다.' }),
  def({ id: 'cred_chip', name: '크레딧 칩', category: 'valuable', rarity: 'common', width: 1, height: 1, stackMax: 5, value: 90, icon: '▣', weight: 0.02,
    description: '슈퍼 크레딧이 저장된 데이터 칩.' }),
  def({ id: 'salvage_electronics', name: '회수 전자장비', category: 'valuable', rarity: 'common', width: 2, height: 1, value: 180, icon: '▤▥', weight: 3.2,
    description: '추락한 장비에서 뜯어낸 회로 기판. 방열판째로 뜯어와서 꽤 무겁다.' }),
  def({ id: 'data_core', name: '데이터 코어', category: 'valuable', rarity: 'rare', width: 2, height: 1, value: 900, icon: '▦▦', weight: 1.2,
    description: '전초기지 기록이 담긴 저장 코어.' }),
  def({ id: 'data_core_encrypted', name: '암호화 데이터 코어', category: 'valuable', rarity: 'epic', width: 2, height: 1, value: 2100, icon: '▩▩', weight: 1.4,
    description: '군 등급 암호화가 걸린 코어. 정보부가 고가에 매입.' }),
  def({ id: 'sample_canister', name: '샘플 캐니스터', category: 'valuable', rarity: 'uncommon', width: 3, height: 1, value: 480, icon: '▭▭▭', weight: 2.6,
    description: '터미니드 조직 샘플이 봉인된 용기.' }),
  def({ id: 'sample_canister_pure', name: '정제 샘플 캐니스터', category: 'valuable', rarity: 'rare', width: 3, height: 1, value: 1100, icon: '▭▭▭', weight: 2.8,
    description: '고순도 외계 생체 샘플. 연구부의 최우선 회수 대상.' }),
  def({ id: 'terminid_gland', name: '터미니드 분비선', category: 'valuable', rarity: 'uncommon', width: 1, height: 1, value: 300, icon: '❂', weight: 0.9,
    description: '페로몬을 분비하는 기관. 생화학 연구용.' }),
  def({ id: 'alien_artifact', name: '외계 유물', category: 'valuable', rarity: 'epic', width: 2, height: 2, value: 3200, icon: '⬡', weight: 6.5,
    description: '알 수 없는 문자가 새겨진 금속 조각. 미약하게 진동한다.' }),
  def({ id: 'alien_relic', name: '고대 성유물', category: 'valuable', rarity: 'legendary', width: 2, height: 2, value: 7500, icon: '✧', weight: 9.0,
    description: '선행 문명의 유물. 측정 불가한 에너지를 방출한다. 들고 뛰기엔 너무 무겁다.' }),
  def({ id: 'super_earth_medal', name: '슈퍼 지구 훈장', category: 'valuable', rarity: 'legendary', width: 1, height: 1, value: 4800, icon: '★', weight: 0.15,
    description: '전사한 헬다이버의 훈장. 깃털처럼 가볍고 값은 어마어마하다.' }),

  /* materials */
  def({ id: 'mat_scrap', name: '폐금속', category: 'material', rarity: 'common', width: 1, height: 1, stackMax: 10, value: 15, icon: '▫', weight: 0.5,
    description: '재활용 가능한 금속 조각. 무기 수리에 사용.' }),
  def({ id: 'mat_bio_sample', name: '생체 조직', category: 'material', rarity: 'common', width: 1, height: 1, stackMax: 10, value: 20, icon: '⁂', weight: 0.2,
    description: '터미니드 사체에서 채취한 조직.' }),
  def({ id: 'mat_alloy', name: '합금 판', category: 'material', rarity: 'uncommon', width: 1, height: 1, stackMax: 10, value: 40, icon: '▪', weight: 0.8,
    description: '경량 고강도 합금. 고등급 무기 수리에 사용.' }),
  def({ id: 'mat_power_cell', name: '파워 셀', category: 'material', rarity: 'rare', width: 1, height: 1, stackMax: 10, value: 85, icon: '⚡', weight: 1.1,
    description: '충전된 소형 전력 셀.' }),
  def({ id: 'mat_gunpowder', name: '화약', category: 'material', rarity: 'common', width: 1, height: 1, stackMax: 20, value: 12, icon: '⋆', weight: 0.05,
    description: '탄약을 분해해 얻는 추진제. 원하는 탄종으로 다시 만들 수 있다.' }),
  /* 회복 소모품 재료 (2026-09-07) */
  def({ id: 'mat_cloth', name: '천조각', category: 'material', rarity: 'common', width: 1, height: 1, stackMax: 20, value: 8, icon: '▬', weight: 0.05,
    description: '찢어낸 천 조각. 붕대의 기본 재료.' }),
  def({ id: 'mat_can', name: '캔', category: 'material', rarity: 'common', width: 1, height: 1, stackMax: 10, value: 12, icon: '⌸', weight: 0.1,
    description: '빈 압력 캔. 소독약과 스프레이 용기로 쓴다.' }),
  def({ id: 'mat_syringe', name: '주사기', category: 'material', rarity: 'uncommon', width: 1, height: 1, stackMax: 10, value: 50, icon: '⚲', weight: 0.05,
    description: '멸균 포장된 일회용 주사기.' }),
  def({ id: 'mat_antiseptic', name: '소독약', category: 'material', rarity: 'uncommon', width: 1, height: 1, stackMax: 10, value: 80, icon: '⚗', weight: 0.15,
    description: '약초를 졸여 만든 소독약. 회복주사와 회복 스프레이의 재료.' }),
  /* ship housing (Phase 6): facility / furniture costs */
  def({ id: 'mat_cable', name: '전력 케이블', category: 'material', rarity: 'common', width: 1, height: 1, stackMax: 10, value: 25, icon: '∿', weight: 0.3,
    description: '피복이 벗겨진 전력 케이블 뭉치. 함선 시설과 작업대 설치에 쓰인다.' }),
  def({ id: 'mat_circuit', name: '회로 기판', category: 'material', rarity: 'rare', width: 1, height: 1, stackMax: 10, value: 120, icon: '▦', weight: 0.15,
    description: '멀쩡히 남은 제어 회로 기판. 함선 시설·작업대 업그레이드에 필수.' }),
  /* 폐금속 공급 (2026-09-08): 로그가 떨구는 상위 재료 — 분해하면 폐금속 3 + 전력 케이블 1 */
  def({ id: 'mat_machine_parts', name: '기계 부품', category: 'material', rarity: 'uncommon', width: 1, height: 1, stackMax: 10, value: 90, icon: '⚙', weight: 1.2,
    description: '로그의 장비에서 뜯어낸 기계 부품 뭉치. 분해하면 폐금속과 전력 케이블이 나온다.' }),

  /* herbs (gathered from world plants) */
  def({ id: 'herb_bloodroot', name: '혈근초', category: 'herb', rarity: 'common', width: 1, height: 1, stackMax: 8, value: 25, icon: '❦', weight: 0.08,
    description: '붉은 뿌리를 가진 지혈 식물. 스팀 조제의 기본 재료.' }),
  def({ id: 'herb_ashleaf', name: '잿빛잎', category: 'herb', rarity: 'uncommon', width: 1, height: 1, stackMax: 8, value: 55, icon: '❧', weight: 0.06,
    description: '화산재 지대에서 자라는 잎. 인화성이 강해 소이 제조에도 쓰인다.' }),
  def({ id: 'herb_glowcap', name: '발광버섯', category: 'herb', rarity: 'rare', width: 1, height: 1, stackMax: 6, value: 140, icon: '✿', weight: 0.12,
    description: '스스로 빛나는 균류. 강력한 재생 촉진제.' }),

  /* seeds (Phase 8: 온실 재배층에 심는다) */
  ...SEED_ITEM_DEFS,

  /* books (Phase 9: 서재 책장에 꽂는다) */
  ...BOOK_ITEM_DEFS,

  /* 임플란트 (Phase 12: 캐릭터 탭에 장착; 망가진 것만 루팅, 세레스 바이오가 수리 · 판매 — `ImplantDefs.ts`) */
  ...IMPLANT_ITEM_DEFS,

  /* gadgets (behaviour lives in src/gadgets; here they are just consumables) */
  def({ id: 'gad_cloak_veil', name: '은폐 장막', category: 'gadget', rarity: 'rare', width: 1, height: 2, stackMax: 2, value: 620, icon: '◌',
    gadgetId: 'cloakVeil', weight: 1.1, quickUsable: true,
    description: '주변 아군까지 함께 은폐시키는 광학 장막. 12초.' }),
  def({ id: 'gad_dome_shield', name: '돔 실드', category: 'gadget', rarity: 'epic', width: 2, height: 2, stackMax: 1, value: 1350, icon: '⌓',
    gadgetId: 'domeShield', weight: 5.8, quickUsable: true,
    description: '던진 자리에 돔형 방어막을 전개한다. 내구도 1000.' }),
  def({ id: 'gad_barricade', name: '바리케이드', category: 'gadget', rarity: 'rare', width: 2, height: 2, stackMax: 1, value: 700, icon: '▥',
    gadgetId: 'barricade', weight: 7.2, quickUsable: true,
    description: '정면에 거대한 차폐물을 세운다. 누구나 3초 만에 회수할 수 있다.' }),
  def({ id: 'gad_lure', name: '유인 수류탄', category: 'gadget', rarity: 'uncommon', width: 1, height: 1, stackMax: 3, value: 180, icon: '☄',
    gadgetId: 'lureGrenade', weight: 0.5, quickUsable: true,
    description: '요란한 소음으로 벌레 떼의 시선을 끈다.' }),
  def({ id: 'gad_smoke', name: '연막탄', category: 'gadget', rarity: 'common', width: 1, height: 1, stackMax: 3, value: 110, icon: '☁',
    gadgetId: 'smokeGrenade', weight: 0.55, quickUsable: true,
    description: '시야를 가리는 연막. 안에서 쏘면 대충 그 방향으로 응사당한다.' }),
  def({ id: 'gad_mine', name: '지뢰', category: 'gadget', rarity: 'uncommon', width: 1, height: 1, stackMax: 4, value: 240, icon: '◎',
    gadgetId: 'mine', weight: 1.1, quickUsable: true,
    description: '3초 후 활성화. 피아를 가리지 않는다. 작지만 묵직하다.' }),
  def({ id: 'gad_turret', name: '포탑 설치', category: 'gadget', rarity: 'epic', width: 2, height: 2, stackMax: 1, value: 1600, icon: '⚙',
    gadgetId: 'turret', weight: 9.5, quickUsable: true,
    description: '자동 조준 포탑. 사이에 낀 아군도 맞는다. 회수 가능.' }),
  def({ id: 'gad_incendiary', name: '화염수류탄', category: 'gadget', rarity: 'uncommon', width: 1, height: 1, stackMax: 3, value: 210, icon: '♨',
    gadgetId: 'incendiary', weight: 0.6, quickUsable: true,
    description: '착탄점에 10초간 화염지대를 만든다. 피아 구분 없음.' }),
  def({ id: 'gad_defib', name: '제세동기', category: 'gadget', rarity: 'rare', width: 2, height: 1, stackMax: 2, value: 780, icon: '⚡',
    gadgetId: 'defib', weight: 2.4, quickUsable: true,
    description: '사용 1초. 쓰러진 아군을 즉시 만피로 일으켜 세운다.' }),
  def({ id: 'gad_jumppad', name: '점프대', category: 'gadget', rarity: 'rare', width: 2, height: 2, stackMax: 1, value: 640, icon: '⌃',
    gadgetId: 'jumpPad', weight: 6.4, quickUsable: true,
    description: '밟으면 튀어오른다. 달리면서 밟으면 전방으로 크게 도약. 회수 가능.' }),

  /* armor generated from the ArmorDef table */
  ...ARMOR_DEFS.map(armorItem),
];

export const ITEM_DEF_MAP: ReadonlyMap<string, ItemDef> = new Map(ITEM_DEFS.map((d) => [d.id, d]));

export function getItemDef(defId: string): ItemDef | undefined {
  return ITEM_DEF_MAP.get(defId);
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
  primary: null,
  primary2: null,
  secondary: 'wpn_hg',
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
  /* 첫 시설 체인 전부: 발전기 Lv.1 (`GENERATOR_UPGRADE_COST[0]` 폐금속 4) + 작업실 증축
     (`ROOM_PURPOSE_BUILD_COST.workshop` 폐금속 8 · 케이블 2) + 총기 작업대 제작 (`furn_bench_gun.craft`
     폐금속 8 · 합금 2 · 케이블 1) = 폐금속 20 · 케이블 3 · 합금 2. 2026-09-08: 폐금속이 16 이라 마지막
     작업대를 만들 수 없었다 — 여유를 두고 24 · 4 · 3 으로 올린다. */
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
